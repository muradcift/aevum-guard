"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatEther, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useConfig, usePublicClient, useReadContract, useWatchAsset } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { addressUrl, aevumGuardAbi, erc20Abi, links } from "@aevum-kit/aevum";
import { loadOrCreateDemoAgent, rotateDemoAgent } from "@/lib/demoAgent";
import { explain } from "@/lib/errors";
import { formatToken, short } from "@/lib/format";
import { discoverVaultActors, launchRecentPlan, type DiscoveredPayee } from "@/lib/launchWindow";
import { useNetwork } from "@/lib/network";
import type { ActionFeedback, PayeeView, PolicyView, VaultView } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";
import { AgentMandatePanel } from "./AgentMandatePanel";
import { ApprovalAuditPanel } from "./ApprovalAuditPanel";
import { SpendSimulatorPanel } from "./SpendSimulatorPanel";
import { TreasuryPanel } from "./TreasuryPanel";
import { useToken } from "./useToken";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function VaultDashboard() {
  const { net, select } = useNetwork();
  const appChain = net.chain;
  const vaultAddress = net.vault;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const { watchAsset } = useWatchAsset();

  const [selectedVaultId, setSelectedVaultId] = useState<bigint>(1n);
  const [newVaultName, setNewVaultName] = useState("AI Ops Treasury");
  const [newAllowlist, setNewAllowlist] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<ActionFeedback | null>(null);
  const [demoAgent, setDemoAgent] = useState<PrivateKeyAccount | null>(null);
  const [agentAddress, setAgentAddress] = useState("");
  const [preferredPayee, setPreferredPayee] = useState<Address | undefined>(undefined);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    setDemoAgent(loadOrCreateDemoAgent());
  }, []);

  const gasBalance = useBalance({ address, chainId: appChain.id, query: { enabled: onChain } });
  const tokenBalance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  const nextVaultIdQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "nextVaultId",
    chainId: appChain.id,
    query: { enabled: Boolean(vaultAddress) },
  });

  const nextVaultId = nextVaultIdQuery.data ?? 1n;
  const vaultCount = nextVaultId > 1n ? Number(nextVaultId - 1n) : 0;

  useEffect(() => {
    if (vaultCount > 0 && selectedVaultId > BigInt(vaultCount)) {
      setSelectedVaultId(BigInt(vaultCount));
    }
  }, [vaultCount, selectedVaultId]);

  const vaultQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "getVault",
    args: [selectedVaultId],
    chainId: appChain.id,
    query: { enabled: Boolean(vaultAddress && vaultCount > 0) },
  });

  const vault = vaultQuery.data as VaultView | undefined;
  const vaultExists = Boolean(vault && vault.owner !== ZERO_ADDRESS);
  const isOwner = Boolean(address && vault && vault.owner.toLowerCase() === address.toLowerCase());

  const client = usePublicClient({ chainId: appChain.id });

  // Auto-discover live on-chain agent mandates & verified payees so first-time
  // logged-out judges immediately see the REAL mandate instead of "NOT AUTHORIZED".
  const discoveryQuery = useQuery({
    queryKey: [
      "vault-discovery",
      net.chain.id,
      vaultAddress,
      selectedVaultId.toString(),
      net.deployBlock?.toString() ?? "0",
      refreshTick,
    ],
    enabled: Boolean(client && vaultAddress && vaultExists),
    queryFn: async () => {
      const raw = await discoverVaultActors(client!, vaultAddress!, selectedVaultId, net.deployBlock);
      // Verify each discovered payee's live status via getPayee.
      const verifiedPayees: { payee: Address; label: string }[] = [];
      const seenPayee = new Set<string>();
      for (const p of raw.payees) {
        const addr = p.payee as Address;
        const key = addr.toLowerCase();
        if (seenPayee.has(key)) continue;
        try {
          const info = (await client!.readContract({
            address: vaultAddress!,
            abi: aevumGuardAbi,
            functionName: "getPayee",
            args: [selectedVaultId, addr],
          })) as PayeeView;
          if (info?.approved) {
            seenPayee.add(key);
            verifiedPayees.push({ payee: addr, label: info.label || p.label });
          }
        } catch {
          // skip payees that fail live read
        }
      }
      // Verify each discovered agent's live status via getPolicy, keep active ones.
      const activeAgents: { agent: Address; label: string }[] = [];
      const seenAgent = new Set<string>();
      for (const a of raw.agents) {
        const addr = a.agent as Address;
        const key = addr.toLowerCase();
        if (seenAgent.has(key)) continue;
        try {
          const pol = (await client!.readContract({
            address: vaultAddress!,
            abi: aevumGuardAbi,
            functionName: "getPolicy",
            args: [selectedVaultId, addr],
          })) as PolicyView;
          if (pol?.active) {
            seenAgent.add(key);
            activeAgents.push({ agent: addr, label: pol.label || a.label });
          }
        } catch {
          // skip agents that fail live read
        }
      }
      return {
        payees: verifiedPayees,
        agents: activeAgents,
        caption: raw.label,
        firstPayee: verifiedPayees[0]?.payee,
        firstAgent: activeAgents[0]?.agent,
      };
    },
  });

  const discoveredPayees = discoveryQuery.data?.payees ?? [];
  const discoveredActiveAgent = discoveryQuery.data?.firstAgent;
  const firstVerifiedPayee = discoveryQuery.data?.firstPayee;

  // Tracks whether the user has explicitly chosen an agent (demo key, rotate, or
  // manual entry). While untouched, we auto-switch a brand-new random browser key
  // to the first real on-chain agent so first-time judges see the live mandate.
  const [agentTouched, setAgentTouched] = useState(false);

  // Auto-switch the inspected agent to the first active on-chain agent when the
  // current selection isn't authorized (e.g. a brand-new random browser key).
  useEffect(() => {
    if (agentTouched) return;
    if (!discoveredActiveAgent) return;
    const trimmed = agentAddress.trim();
    const currentIsActive =
      discoveryQuery.data?.agents.some((a) => a.agent.toLowerCase() === trimmed.toLowerCase()) ?? false;
    if (!isAddress(trimmed) || !currentIsActive) {
      setAgentAddress(discoveredActiveAgent);
    }
  }, [discoveredActiveAgent, discoveryQuery.data?.agents, agentAddress, agentTouched]);

  function refreshAll() {
    void gasBalance.refetch().catch(() => undefined);
    void tokenBalance.refetch().catch(() => undefined);
    void nextVaultIdQuery.refetch().catch(() => undefined);
    void vaultQuery.refetch().catch(() => undefined);
    // refreshTick is part of the discovery query key, so bumping it refetches
    // discovery once — no separate discoveryQuery.refetch() needed.
    setRefreshTick((t) => t + 1);
  }

  async function handleCreateVault() {
    if (!address || !vaultAddress || !onChain) return;
    setCreating(true);
    setCreateFeedback(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "createVault",
        args: [newVaultName.trim() || "AI Ops Treasury", newAllowlist],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("Create vault transaction reverted.");
      const createdLogs = parseEventLogs({
        abi: aevumGuardAbi,
        logs: receipt.logs,
        eventName: "VaultCreated",
      });
      const newId = createdLogs[0]?.args.vaultId ?? nextVaultId;
      setSelectedVaultId(newId);
      setCreateFeedback({
        tone: "good",
        title: `Created Vault #${newId.toString()}`,
        detail: `Owner: ${short(address)} · Confirmation of Payee ${newAllowlist ? "ENFORCED" : "OFF"}.`,
        txHash: hash,
      });
      refreshAll();
    } catch (e) {
      setCreateFeedback({ tone: "bad", title: "Failed to create vault", detail: explain(e) });
    } finally {
      setCreating(false);
    }
  }

  function handleRotateAgent() {
    const next = rotateDemoAgent();
    setDemoAgent(next);
    if (next) setAgentAddress(next.address);
  }

  return (
    <main className="shell">
      <section className="page-head">
        <div>
          <p className="eyebrow">QDay Aevum · Programmable AI Treasury</p>
          <h1>AevumGuard Control Center</h1>
          <p className="lede">
            Give AI agents bounded autonomous <code>{token.symbol}</code> spending power with on-chain per-tx &amp; daily caps,
            Confirmation of Payee allowlists, human approval queues, and an instant kill-switch.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {onChain && token.address && (
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                // watchAsset can reject if the wallet prompt is dismissed; keep it handled.
                void (async () => {
                  try {
                    await watchAsset({
                      type: "ERC20",
                      options: { address: token.address!, symbol: token.symbol, decimals: token.decimals },
                    });
                  } catch {
                    // Wallet rejected or does not support watchAsset — nothing to surface.
                  }
                })();
              }}
            >
              + Add {token.symbol} to Wallet
            </button>
          )}
          <Link className="btn ghost small" href="/docs">
            Architecture &amp; Setup →
          </Link>
        </div>
      </section>

      {/* Top Metrics Bar */}
      <section className="summary-grid" aria-label="Wallet and contract summary">
        <div className="metric-card">
          <span className="metric-label">Network</span>
          <span className="metric-value" style={{ fontSize: 20 }}>
            {appChain.name}
          </span>
          <span className="metric-sub">
            Chain {appChain.id} · Shanghai EVM
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Wallet Gas ({appChain.nativeCurrency.symbol})</span>
          <span className="metric-value">
            {onChain && gasBalance.data ? Number(formatEther(gasBalance.data.value)).toFixed(4) : "—"}
          </span>
          <span className="metric-sub">
            {net.key === "aevum" ? (
              <a href={links.faucetWeb} target="_blank" rel="noreferrer">
                Need gas? Discord /faucet ↗
              </a>
            ) : (
              "Local test gas"
            )}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Wallet {token.symbol}</span>
          <span className="metric-value">
            {onChain ? formatToken(tokenBalance.data, token.decimals) : "—"}
          </span>
          <span className="metric-sub">
            {token.address ? short(token.address) : "Token unavailable"}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">AevumGuardVault</span>
          <span className="metric-value" style={{ fontSize: 18 }}>
            {vaultAddress ? short(vaultAddress) : "Not configured"}
          </span>
          <span className="metric-sub">
            {vaultAddress && net.hasExplorer ? (
              <a href={addressUrl(vaultAddress)} target="_blank" rel="noreferrer">
                Explorer Contract ↗
              </a>
            ) : (
              `${vaultCount} vault${vaultCount === 1 ? "" : "s"} created`
            )}
          </span>
        </div>
      </section>

      {!isConnected ? (
        <div className="card info">
          <h2>Connect your wallet to manage vaults</h2>
          <p className="sub">
            Use MetaMask, Rabby, or any browser wallet via the button at the top right. Once connected, you can create a vault, fund
            it with <code>{token.symbol}</code> (gasless EIP-3009 or standard), and run the live AI agent policy simulator.
          </p>
        </div>
      ) : !onChain ? (
        <div className="card info">
          <div className="check-top" style={{ alignItems: "center" }}>
            <div>
              <h2>Switch wallet to {appChain.name}</h2>
              <p className="sub" style={{ marginBottom: 0 }}>
                Your wallet is currently on chain {chainId}. Switch to chain {appChain.id} to interact with AevumGuard.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => select(net.key)}>
              Switch to {net.label}
            </button>
          </div>
        </div>
      ) : null}

      {!vaultAddress ? (
        <section className="card stack">
          <h2>Configure Contract Address for {net.label}</h2>
          <p className="sub">
            Set <code>NEXT_PUBLIC_VAULT_{net.key.toUpperCase()}</code> in <code>web/.env.local</code> after running{" "}
            <code>forge script script/DeployAevumGuard.s.sol</code>. See <Link href="/docs">Architecture &amp; Docs</Link> for exact
            commands.
          </p>
        </section>
      ) : (
        <>
          {/* Vault Selector & Create Bar */}
          <section className="card stack">
            <div className="check-top" style={{ alignItems: "center" }}>
              <div>
                <h2 style={{ fontSize: 17 }}>Select or Create Guarded Vault</h2>
                <p className="fine" style={{ marginTop: 2 }}>
                  Each vault isolates funds, verified payees, AI agent mandates, and human approvals.
                </p>
              </div>
              {vaultCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <label className="fine" htmlFor="vault-select">
                    Active Vault:
                  </label>
                  <select
                    id="vault-select"
                    className="field"
                    style={{ width: "auto", minWidth: 160, minHeight: 38, padding: "6px 12px" }}
                    value={selectedVaultId.toString()}
                    onChange={(e) => setSelectedVaultId(BigInt(e.target.value))}
                  >
                    {Array.from({ length: vaultCount }, (_, idx) => BigInt(idx + 1)).map((id) => (
                      <option key={id.toString()} value={id.toString()}>
                        Vault #{id.toString()}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <input
                className="field"
                style={{ flex: "1 1 220px" }}
                type="text"
                value={newVaultName}
                onChange={(e) => setNewVaultName(e.target.value)}
                placeholder="New vault name (e.g. Research Agent Treasury)"
                aria-label="New vault name"
              />
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={newAllowlist}
                  onChange={(e) => setNewAllowlist(e.target.checked)}
                />
                Enforce Confirmation of Payee allowlist
              </label>
              <button
                type="button"
                className="btn"
                disabled={!onChain || creating}
                onClick={() => void handleCreateVault()}
              >
                {creating ? "Creating Vault…" : "+ Create Vault"}
              </button>
            </div>

            {vaultExists && vault && !isOwner && onChain && (
              <p className="fine" style={{ color: "var(--warn)" }}>
                Note: Vault #{selectedVaultId.toString()} is owned by {short(vault.owner)}. Owner controls (withdraw, freeze, payee
                verification, mandates, approvals) require the owner wallet, or create your own vault above.
              </p>
            )}

            {(nextVaultIdQuery.error || vaultQuery.error) && (
              <p className="fine" style={{ color: "var(--bad)" }} role="alert">
                Could not read vault state from {net.label}:{" "}
                {explain((nextVaultIdQuery.error ?? vaultQuery.error) as Error)}
              </p>
            )}

            <ActionFeedbackBox feedback={createFeedback} hasExplorer={net.hasExplorer} />
          </section>

          {vaultExists && vault && (
            <section className="dashboard-grid" aria-label="Vault operations">
              <TreasuryPanel
                net={net}
                vaultAddress={vaultAddress}
                vaultId={selectedVaultId}
                vault={vault}
                isOwner={isOwner}
                onChain={onChain}
                tokenAddress={token.address}
                tokenDecimals={token.decimals}
                tokenSymbol={token.symbol}
                onMutated={refreshAll}
                onPayeeSelected={setPreferredPayee}
                discoveredPayees={discoveredPayees}
              />

              <AgentMandatePanel
                net={net}
                vaultAddress={vaultAddress}
                vaultId={selectedVaultId}
                isOwner={isOwner}
                onChain={onChain}
                tokenDecimals={token.decimals}
                tokenSymbol={token.symbol}
                demoAgent={demoAgent}
                onRotateDemoAgent={handleRotateAgent}
                agentAddress={agentAddress}
                onAgentAddressChange={setAgentAddress}
                onAgentTouched={() => setAgentTouched(true)}
                onMutated={refreshAll}
              />

              <SpendSimulatorPanel
                net={net}
                vaultAddress={vaultAddress}
                vaultId={selectedVaultId}
                onChain={onChain}
                tokenDecimals={token.decimals}
                tokenSymbol={token.symbol}
                demoAgent={demoAgent}
                preferredPayee={preferredPayee ?? firstVerifiedPayee}
                inspectedAgent={
                  isAddress(agentAddress.trim()) && !/^0x0{40}$/i.test(agentAddress.trim())
                    ? (agentAddress.trim() as Address)
                    : discoveredActiveAgent
                }
                onMutated={refreshAll}
              />

              <ApprovalAuditPanel
                net={net}
                vaultAddress={vaultAddress}
                vaultId={selectedVaultId}
                isOwner={isOwner}
                onChain={onChain}
                tokenDecimals={token.decimals}
                tokenSymbol={token.symbol}
                refreshTick={refreshTick}
                onMutated={refreshAll}
              />
            </section>
          )}
        </>
      )}
    </main>
  );
}
