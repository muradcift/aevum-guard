"use client";

import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatToken, safeParseUnits, short } from "@/lib/format";
import type { Network } from "@/lib/env";
import type { ActionFeedback, PolicyView } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";

interface AgentMandatePanelProps {
  net: Network;
  vaultAddress: Address;
  vaultId: bigint;
  isOwner: boolean;
  onChain: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  demoAgent: PrivateKeyAccount | null;
  onRotateDemoAgent: () => void;
  agentAddress: string;
  onAgentAddressChange: (addr: string) => void;
  /** Fired when the user explicitly picks/types an agent, so auto-discovery stops overriding it. */
  onAgentTouched?: () => void;
  onMutated: () => void;
}

export function AgentMandatePanel({
  net,
  vaultAddress,
  vaultId,
  isOwner,
  onChain,
  tokenDecimals,
  tokenSymbol,
  demoAgent,
  onRotateDemoAgent,
  agentAddress,
  onAgentAddressChange,
  onAgentTouched,
  onMutated,
}: AgentMandatePanelProps) {
  const config = useConfig();
  const { address } = useAccount();

  const [label, setLabel] = useState("Autonomous Procurement Agent");
  const [perTxLimit, setPerTxLimit] = useState("1.00");
  const [dailyLimit, setDailyLimit] = useState("3.00");
  const [totalBudget, setTotalBudget] = useState("10.00");
  const [expiresHours, setExpiresHours] = useState("0");
  const [allowQueueOverflow, setAllowQueueOverflow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  useEffect(() => {
    if (!agentAddress && demoAgent) {
      onAgentAddressChange(demoAgent.address);
    }
  }, [agentAddress, demoAgent, onAgentAddressChange]);

  const validAgent = isAddress(agentAddress.trim()) ? (agentAddress.trim() as Address) : undefined;

  const policyQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "getPolicy",
    args: validAgent ? [vaultId, validAgent] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(validAgent) },
  });

  const remainingDailyQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "remainingDailyLimit",
    args: validAgent ? [vaultId, validAgent] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(validAgent) },
  });

  const nonceQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "agentNonces",
    args: validAgent ? [validAgent] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(validAgent) },
  });

  const policy = policyQuery.data as PolicyView | undefined;
  const remainingDaily = remainingDailyQuery.data as bigint | undefined;

  const dailyUsedPct =
    policy && policy.dailyLimit > 0n && remainingDaily !== undefined
      ? Math.min(100, Number(((policy.dailyLimit - remainingDaily) * 100n) / policy.dailyLimit))
      : 0;
  const totalUsedPct =
    policy && policy.totalBudget > 0n
      ? Math.min(100, Number((policy.spentTotal * 100n) / policy.totalBudget))
      : 0;

  async function savePolicy() {
    if (!address || !onChain || !validAgent) return;
    const perTx = safeParseUnits(perTxLimit, tokenDecimals);
    const daily = safeParseUnits(dailyLimit, tokenDecimals);
    const total = safeParseUnits(totalBudget, tokenDecimals);
    const hrs = Number(expiresHours.trim() || "0");

    if (perTx === null || daily === null || total === null || Number.isNaN(hrs) || hrs < 0) {
      setFeedback({ tone: "bad", title: "Invalid mandate values", detail: "Check token limits and expiry hours." });
      return;
    }

    const expiresAt = hrs > 0 ? BigInt(Math.floor(Date.now() / 1000) + Math.round(hrs * 3600)) : 0n;

    setBusy(true);
    setFeedback(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "setPolicy",
        args: [
          vaultId,
          validAgent,
          {
            label: label.trim() || "AI Agent",
            perTxLimit: perTx,
            dailyLimit: daily,
            totalBudget: total,
            expiresAt,
            allowQueueOverflow,
          },
        ],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      await Promise.all([policyQuery.refetch(), remainingDailyQuery.refetch()]);
      setFeedback({
        tone: "good",
        title: `Mandate saved for ${short(validAgent)}`,
        detail: `Per-tx ${perTxLimit}, Daily ${dailyLimit}, Total cap ${totalBudget} ${tokenSymbol}.`,
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Failed to save mandate", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (!address || !onChain || !validAgent) return;
    setBusy(true);
    setFeedback(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "revokeAgent",
        args: [vaultId, validAgent],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      await policyQuery.refetch();
      setFeedback({
        tone: "warn",
        title: `Agent Revoked: ${short(validAgent)}`,
        detail: "This agent can no longer execute spends on this vault.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Revoke failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="card-head">
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Panel 2 · AI Agent Mandate
          </p>
          <h2>On-Chain Spend Guardrails</h2>
        </div>
        {policy && (
          <span className={`status-pill ${policy.active ? "good" : "bad"}`}>
            {policy.active ? "MANDATE ACTIVE" : "NOT AUTHORIZED"}
          </span>
        )}
      </div>

      {/* 1-Click Ephemeral Demo Agent Card */}
      <div className="notice info" style={{ borderColor: "var(--line-info)", background: "var(--surface-info)" }}>
        <div className="row-between">
          <strong>1-Click Demo AI Agent Signer (Testnet/Fork Only)</strong>
          <div style={{ display: "flex", gap: 6 }}>
            {demoAgent && (
              <button
                type="button"
                className="btn small secondary"
                onClick={() => {
                  onAgentTouched?.();
                  onAgentAddressChange(demoAgent.address);
                }}
              >
                Use Demo Agent
              </button>
            )}
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                onAgentTouched?.();
                onRotateDemoAgent();
              }}
            >
              Rotate Key
            </button>
          </div>
        </div>
        <span className="fine" style={{ color: "var(--text-2)" }}>
          Browser-local ephemeral key <code className="mono">{demoAgent ? short(demoAgent.address) : "loading…"}</code> — needs{" "}
          <strong>0 tQDAY</strong> because spends use EIP-712 gasless intents via <code>/api/relay-spend</code>.
        </span>
      </div>

      <div className="field-grid">
        <label className="field-label" style={{ gridColumn: "1 / -1" }}>
          Agent Address
          <input
            className="field"
            type="text"
            value={agentAddress}
            onChange={(e) => {
              onAgentTouched?.();
              onAgentAddressChange(e.target.value);
            }}
            placeholder="0x..."
          />
        </label>
        <label className="field-label">
          Agent Label
          <input className="field" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field-label">
          Per-Tx Limit ({tokenSymbol})
          <input className="field" type="text" value={perTxLimit} onChange={(e) => setPerTxLimit(e.target.value)} />
        </label>
        <label className="field-label">
          Daily Limit ({tokenSymbol})
          <input className="field" type="text" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
        </label>
        <label className="field-label">
          Lifetime Cap ({tokenSymbol}, 0 = ∞)
          <input className="field" type="text" value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} />
        </label>
        <label className="field-label">
          Expiry (Hours, 0 = none)
          <input className="field" type="text" value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} />
        </label>
      </div>

      <label className="check-inline">
        <input
          type="checkbox"
          checked={allowQueueOverflow}
          onChange={(e) => setAllowQueueOverflow(e.target.checked)}
        />
        Escalate over-limit spends to Human Approval Queue (instead of hard reverting)
      </label>

      {policy && policy.active && (
        <div className="stack" style={{ gap: 10, padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line)" }}>
          <div className="check-top">
            <span className="fine">
              Daily Quota Left: <strong>{formatToken(remainingDaily, tokenDecimals)}</strong> /{" "}
              {formatToken(policy.dailyLimit, tokenDecimals)} {tokenSymbol}
            </span>
            <span className="fine mono">Nonce: {nonceQuery.data?.toString() ?? "0"}</span>
          </div>
          <div className="progress">
            <span style={{ width: `${dailyUsedPct}%` }} />
          </div>
          {policy.totalBudget > 0n && (
            <>
              <div className="check-top">
                <span className="fine">
                  Lifetime Budget Used: <strong>{formatToken(policy.spentTotal, tokenDecimals)}</strong> /{" "}
                  {formatToken(policy.totalBudget, tokenDecimals)} {tokenSymbol}
                </span>
                <span className="fine">{totalUsedPct}%</span>
              </div>
              <div className="progress">
                <span style={{ width: `${totalUsedPct}%`, background: "var(--warn)" }} />
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          style={{ flex: "1 1 180px" }}
          disabled={!onChain || !isOwner || !validAgent || busy}
          onClick={() => void savePolicy()}
        >
          {policy?.active ? "Update Agent Mandate" : "Authorize AI Agent"}
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!onChain || !isOwner || !validAgent || !policy?.active || busy}
          onClick={() => void handleRevoke()}
        >
          Revoke Agent
        </button>
      </div>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />
    </section>
  );
}
