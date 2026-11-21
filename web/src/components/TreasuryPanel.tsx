"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address, type Hash } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import {
  aevumGuardAbi,
  authorizationWindow,
  computeDepositNonce,
  depositAuthTypedData,
  erc20Abi,
} from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatToken, randomBytes32, safeParseUnits, short } from "@/lib/format";
import type { Network } from "@/lib/env";
import type { ActionFeedback, PayeeView, VaultView } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";

interface TreasuryPanelProps {
  net: Network;
  vaultAddress: Address;
  vaultId: bigint;
  vault: VaultView;
  isOwner: boolean;
  onChain: boolean;
  tokenAddress?: Address;
  tokenDecimals: number;
  tokenSymbol: string;
  onMutated: () => void;
  onPayeeSelected?: (payee: Address) => void;
  /** Live on-chain verified payees auto-discovered from PayeeUpdated logs. */
  discoveredPayees?: { payee: Address; label: string }[];
}

export function TreasuryPanel({
  net,
  vaultAddress,
  vaultId,
  vault,
  isOwner,
  onChain,
  tokenAddress,
  tokenDecimals,
  tokenSymbol,
  onMutated,
  onPayeeSelected,
  discoveredPayees,
}: TreasuryPanelProps) {
  const config = useConfig();
  const { address } = useAccount();

  const [depositMode, setDepositMode] = useState<"gasless" | "standard">("gasless");
  const [depositAmount, setDepositAmount] = useState("2");
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [payeeInput, setPayeeInput] = useState("");
  const [payeeLabel, setPayeeLabel] = useState("Cloud API Vendor");
  const [knownPayees, setKnownPayees] = useState<Address[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const relayStatus = useQuery({
    queryKey: ["relay-deposit-status", net.chain.id],
    queryFn: async () =>
      (await fetch(`/api/relay-deposit?chainId=${net.chain.id}`)).json() as Promise<{
        enabled: boolean;
        relayer: string | null;
      }>,
  });

  const gaslessAvailable = relayStatus.data?.enabled ?? false;
  const activeDepositMode = gaslessAvailable ? depositMode : "standard";

  const inspectedPayee = isAddress(payeeInput.trim()) ? (payeeInput.trim() as Address) : undefined;
  const payeeCheck = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "getPayee",
    args: inspectedPayee ? [vaultId, inspectedPayee] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(inspectedPayee) },
  });
  const payeeData = payeeCheck.data as PayeeView | undefined;

  async function runDeposit() {
    if (!address || !tokenAddress || !onChain) return;
    const amount = safeParseUnits(depositAmount, tokenDecimals);
    if (!amount || amount <= 0n) {
      setFeedback({ tone: "bad", title: "Invalid amount", detail: "Enter a positive deposit amount." });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      let hash: Hash;
      if (activeDepositMode === "gasless") {
        const depositRef = randomBytes32();
        const nonce = computeDepositNonce(vaultAddress, vaultId, depositRef);
        const { validAfter, validBefore } = authorizationWindow(600);
        const signature = await signTypedData(config, {
          account: address,
          ...depositAuthTypedData(net.chain.id, tokenAddress, {
            from: address,
            to: vaultAddress,
            value: amount,
            validAfter,
            validBefore,
            nonce,
          }),
        });
        const res = await fetch("/api/relay-deposit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chainId: net.chain.id,
            vaultId: vaultId.toString(),
            from: address,
            amount: amount.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            depositRef,
            signature,
          }),
        });
        const data = (await res.json()) as { hash?: Hash; error?: string };
        if (!res.ok || !data.hash) throw new Error(data.error ?? "Relayer rejected deposit.");
        hash = data.hash;
      } else {
        const allowance = await readContract(config, {
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, vaultAddress],
          chainId: net.chain.id,
        });
        if (allowance < amount) {
          const approveHash = await writeContract(config, {
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "approve",
            args: [vaultAddress, amount],
            chainId: net.chain.id,
          });
          await waitForTransactionReceipt(config, { hash: approveHash, chainId: net.chain.id });
        }
        const { request } = await simulateContract(config, {
          account: address,
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "deposit",
          args: [vaultId, amount],
          chainId: net.chain.id,
        });
        hash = await writeContract(config, request);
      }

      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("Deposit transaction reverted.");
      setFeedback({
        tone: "good",
        title: `Deposited ${depositAmount} ${tokenSymbol}`,
        detail:
          activeDepositMode === "gasless"
            ? "Settled gaslessly via EIP-3009 ReceiveWithAuthorization."
            : "Settled via standard approve + deposit.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Deposit failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runWithdraw() {
    if (!address || !onChain) return;
    const amount = safeParseUnits(withdrawAmount, tokenDecimals);
    const target = withdrawTo.trim() ? withdrawTo.trim() : address;
    if (!amount || amount <= 0n || !isAddress(target)) {
      setFeedback({ tone: "bad", title: "Invalid withdrawal", detail: "Check destination address and amount." });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "withdraw",
        args: [vaultId, target as Address, amount],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("Withdrawal reverted.");
      setFeedback({
        tone: "good",
        title: `Withdrew ${withdrawAmount} ${tokenSymbol}`,
        detail: `Sent safely to ${short(target)}. Available even when vault is paused.`,
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Withdrawal failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!address || !onChain) return;
    setBusy(true);
    setFeedback(null);
    try {
      const nextPaused = !vault.paused;
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "setVaultPaused",
        args: [vaultId, nextPaused],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      setFeedback({
        tone: nextPaused ? "warn" : "good",
        title: nextPaused ? "Kill-Switch Activated" : "Vault Unfrozen",
        detail: nextPaused
          ? "All AI spends and approvals are halted. Owner withdraw and request rejection remain enabled."
          : "Vault is active again for policy-checked agent spends.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Kill-Switch update failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleAllowlistMode() {
    if (!address || !onChain) return;
    setBusy(true);
    setFeedback(null);
    try {
      const nextEnforce = !vault.enforceAllowlist;
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "setEnforceAllowlist",
        args: [vaultId, nextEnforce],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      setFeedback({
        tone: "good",
        title: nextEnforce ? "Confirmation of Payee Enforced" : "Open Recipient Mode",
        detail: nextEnforce
          ? "Agents can only pay explicitly verified payees."
          : "Agents may pay any recipient within spend limits.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Allowlist toggle failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  async function updatePayee(approved: boolean) {
    if (!address || !onChain || !inspectedPayee) return;
    setBusy(true);
    setFeedback(null);
    try {
      const label = payeeLabel.trim() || "Verified Vendor";
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: "setPayee",
        args: [vaultId, inspectedPayee, approved, label],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (approved) {
        setKnownPayees((prev) =>
          prev.some((p) => p.toLowerCase() === inspectedPayee.toLowerCase()) ? prev : [inspectedPayee, ...prev],
        );
        onPayeeSelected?.(inspectedPayee);
      }
      payeeCheck.refetch();
      setFeedback({
        tone: approved ? "good" : "warn",
        title: approved ? `Payee Verified: ${label}` : `Payee Revoked: ${short(inspectedPayee)}`,
        detail: approved
          ? `On-chain Confirmation of Payee binding created for ${short(inspectedPayee)}.`
          : "Transfers to this address are now blocked when allowlist is enforced.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Payee update failed", detail: explain(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="card-head">
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Panel 1 · Treasury &amp; Safety Controls
          </p>
          <h2>{vault.name || `Vault #${vaultId.toString()}`}</h2>
        </div>
        <span className={`status-pill ${vault.paused ? "bad" : "good"}`}>
          <span className={`dot ${vault.paused ? "bad" : ""}`} />
          {vault.paused ? "FROZEN (KILL-SWITCH)" : "ACTIVE"}
        </span>
      </div>

      <div className="summary-grid">
        <div className="metric-card">
          <span className="metric-label">Available Balance</span>
          <span className="metric-value">
            {formatToken(vault.balance, tokenDecimals)} <small style={{ fontSize: 14 }}>{tokenSymbol}</small>
          </span>
          <span className="metric-sub">Immediately spendable under limits</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Reserved (Pending)</span>
          <span className="metric-value" style={{ color: vault.reserved > 0n ? "var(--warn)" : undefined }}>
            {formatToken(vault.reserved, tokenDecimals)} <small style={{ fontSize: 14 }}>{tokenSymbol}</small>
          </span>
          <span className="metric-sub">Escrowed awaiting human approval</span>
        </div>
      </div>

      <div className="rule" />

      {/* Deposit */}
      <div className="stack" style={{ gap: 10 }}>
        <div className="check-top">
          <strong>Fund Vault ({tokenSymbol})</strong>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className={`btn small ${activeDepositMode === "gasless" ? "" : "secondary"}`}
              disabled={!gaslessAvailable || busy}
              onClick={() => setDepositMode("gasless")}
              title={gaslessAvailable ? "Sign EIP-3009 off-chain; relayer pays tQDAY" : "Configure RELAYER_PRIVATE_KEY to enable"}
            >
              Gasless EIP-3009
            </button>
            <button
              type="button"
              className={`btn small ${activeDepositMode === "standard" ? "" : "secondary"}`}
              disabled={busy}
              onClick={() => setDepositMode("standard")}
            >
              Standard
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            className="field"
            style={{ flex: "1 1 140px" }}
            type="text"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="Amount e.g. 2.0"
            aria-label="Deposit amount"
          />
          <button
            type="button"
            className="btn"
            disabled={!onChain || !tokenAddress || busy}
            onClick={() => void runDeposit()}
          >
            {activeDepositMode === "gasless" ? "Sign & Deposit Gasless" : "Approve & Deposit"}
          </button>
        </div>
        {!gaslessAvailable && (
          <p className="fine">Gasless EIP-3009 relayer inactive (set RELAYER_PRIVATE_KEY in web/.env.local). Standard deposit is ready.</p>
        )}
      </div>

      {/* Owner Withdraw & Kill-Switch */}
      <div className="rule" />
      <div className="stack" style={{ gap: 10 }}>
        <div className="check-top">
          <strong>Owner Withdraw &amp; Emergency Kill-Switch</strong>
          <button
            type="button"
            className={`btn small ${vault.paused ? "good" : "danger"}`}
            disabled={!onChain || !isOwner || busy}
            onClick={() => void togglePause()}
          >
            {vault.paused ? "Unfreeze Vault" : "Emergency Freeze"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            className="field"
            style={{ flex: "0.7 1 110px" }}
            type="text"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="Amount"
            aria-label="Withdraw amount"
          />
          <input
            className="field"
            style={{ flex: "1.5 1 200px" }}
            type="text"
            value={withdrawTo}
            onChange={(e) => setWithdrawTo(e.target.value)}
            placeholder={address ? `To owner (${short(address)})` : "Destination 0x..."}
            aria-label="Withdraw destination"
          />
          <button
            type="button"
            className="btn secondary"
            disabled={!onChain || !isOwner || busy}
            onClick={() => void runWithdraw()}
          >
            Withdraw
          </button>
        </div>
        <p className="fine">Withdraw works even while frozen — owner funds can never be trapped inside the contract.</p>
      </div>

      {/* Confirmation of Payee */}
      <div className="rule" />
      <div className="stack" style={{ gap: 10 }}>
        <div className="check-top" style={{ alignItems: "center" }}>
          <div>
            <strong>Confirmation of Payee (Allowlist)</strong>
            <p className="fine">
              Status:{" "}
              <strong style={{ color: vault.enforceAllowlist ? "var(--good)" : "var(--warn)" }}>
                {vault.enforceAllowlist ? "ENFORCED (verified payees only)" : "OFF (open recipients)"}
              </strong>
            </p>
          </div>
          <button
            type="button"
            className="btn small secondary"
            disabled={!onChain || !isOwner || busy}
            onClick={() => void toggleAllowlistMode()}
          >
            {vault.enforceAllowlist ? "Disable Strict Mode" : "Enable Strict Mode"}
          </button>
        </div>

        {discoveredPayees && discoveredPayees.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="fine" style={{ color: "var(--text-2)" }}>
              <strong>Verified Payees (live on-chain)</strong>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {discoveredPayees.map((p) => (
                <button
                  key={p.payee}
                  type="button"
                  className="pill"
                  style={{
                    background: "var(--good-chip)",
                    borderColor: "var(--good-line)",
                    color: "var(--good)",
                    cursor: "pointer",
                  }}
                  title={p.label ? `${p.label} — ${p.payee}` : p.payee}
                  onClick={() => {
                    setPayeeInput(p.payee);
                    onPayeeSelected?.(p.payee);
                  }}
                >
                  <span className="dot" />
                  <span className="mono">{p.label ? p.label : short(p.payee)}</span>
                  <span className="mono" style={{ opacity: 0.7 }}>
                    {short(p.payee)}
                  </span>
                  <span className="status-pill good" style={{ padding: "2px 8px", fontSize: 11 }}>
                    Verified
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field-grid">
          <label className="field-label">
            Payee Address
            <input
              className="field"
              type="text"
              value={payeeInput}
              onChange={(e) => setPayeeInput(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <label className="field-label">
            Verified Legal / Service Label
            <input
              className="field"
              type="text"
              value={payeeLabel}
              onChange={(e) => setPayeeLabel(e.target.value)}
              placeholder="e.g. Acme GPU Cloud"
            />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="btn small"
            disabled={!onChain || !isOwner || !inspectedPayee || busy}
            onClick={() => void updatePayee(true)}
          >
            Verify &amp; Allow Payee
          </button>
          <button
            type="button"
            className="btn small ghost"
            disabled={!onChain || !isOwner || !inspectedPayee || busy}
            onClick={() => void updatePayee(false)}
          >
            Revoke Payee
          </button>
          {inspectedPayee && payeeData && (
            <span className="fine mono">
              On-chain: {payeeData.approved ? `VERIFIED ("${payeeData.label}")` : "Not approved"} ·{" "}
              {short(payeeData.confirmationHash)}
            </span>
          )}
        </div>

        {knownPayees.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {knownPayees.map((p) => (
              <button
                key={p}
                type="button"
                className="pill"
                style={{ background: "var(--surface-2)", cursor: "pointer" }}
                onClick={() => {
                  setPayeeInput(p);
                  onPayeeSelected?.(p);
                }}
              >
                Use {short(p)}
              </button>
            ))}
          </div>
        )}
      </div>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />
    </section>
  );
}
