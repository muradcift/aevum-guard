"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseEventLogs, type Address, type Hash } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { useAccount, useConfig } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi, spendIntentTypedData } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import {
  formatToken,
  parseAmountInput,
  recipientError,
  refToBytes32,
  short,
} from "@/lib/format";
import type { Network } from "@/lib/env";
import type { ActionFeedback, PayeeView, PolicyView, VaultView } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";

const UNVERIFIED_DEMO_PAYEE: Address = "0x000000000000000000000000000000000000dEaD";

type VerdictStatus = "pass" | "escalate" | "revert";

interface CheckResult {
  name: string;
  outcome: VerdictStatus;
  detail: string;
}

interface DryRunVerdict {
  overall: VerdictStatus;
  headline: string;
  subline: string;
  checks: CheckResult[];
}

interface SpendSimulatorPanelProps {
  net: Network;
  vaultAddress: Address;
  vaultId: bigint;
  onChain: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  demoAgent: PrivateKeyAccount | null;
  preferredPayee?: Address;
  /** The agent whose live policy the dry-run evaluates (discovered active on-chain agent). */
  inspectedAgent?: Address;
  onMutated: () => void;
}

export function SpendSimulatorPanel({
  net,
  vaultAddress,
  vaultId,
  onChain,
  tokenDecimals,
  tokenSymbol,
  demoAgent,
  preferredPayee,
  inspectedAgent,
  onMutated,
}: SpendSimulatorPanelProps) {
  const config = useConfig();
  const { address } = useAccount();

  const [mode, setMode] = useState<"gasless-agent" | "direct-wallet">("gasless-agent");
  const [recipient, setRecipient] = useState<string>("");
  const [amountStr, setAmountStr] = useState("0.50");
  const [invoiceText, setInvoiceText] = useState("INV-2026-101");
  const [memo, setMemo] = useState("Cloud inference API settlement");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [verdict, setVerdict] = useState<DryRunVerdict | null>(null);

  // Auto-fill the recipient from the discovered verified payee exactly ONCE, on
  // initial discovery. Manual edits — including clearing the field back to "" —
  // are never overwritten, so the empty-recipient validation path stays usable.
  const initialRecipientFilledRef = useRef(false);
  const recipientTouchedRef = useRef(false);
  useEffect(() => {
    if (initialRecipientFilledRef.current || !preferredPayee) return;
    initialRecipientFilledRef.current = true;
    if (recipientTouchedRef.current) return;
    setRecipient(preferredPayee);
  }, [preferredPayee]);

  const amountCheck = parseAmountInput(amountStr, tokenDecimals);
  const recipientProblem = recipientError(recipient);
  const amountProblem = amountCheck.ok ? null : amountCheck.message;

  const relayStatus = useQuery({
    queryKey: ["relay-spend-status", net.chain.id],
    queryFn: async () =>
      (await fetch(`/api/relay-spend?chainId=${net.chain.id}`)).json() as Promise<{
        enabled: boolean;
        relayer: string | null;
      }>,
  });

  const gaslessAvailable = Boolean((relayStatus.data?.enabled ?? false) && demoAgent);
  const activeMode = gaslessAvailable ? mode : "direct-wallet";

  function applyScenario(kind: "auto" | "blocked" | "queue") {
    const safeTarget = preferredPayee ?? address ?? UNVERIFIED_DEMO_PAYEE;
    recipientTouchedRef.current = true;
    if (kind === "auto") {
      setRecipient(safeTarget);
      setAmountStr("0.40");
      setInvoiceText(`INV-AUTO-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Routine API inference call (within limit)");
    } else if (kind === "blocked") {
      setRecipient(UNVERIFIED_DEMO_PAYEE);
      setAmountStr("0.25");
      setInvoiceText(`INV-ROGUE-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Transfer to unverified external address");
    } else {
      setRecipient(safeTarget);
      setAmountStr("0.85");
      setInvoiceText(`INV-ESC-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Dedicated GPU cluster lease (over per-tx limit)");
    }
    setFeedback(null);
    setVerdict(null);
  }

  /**
   * Deterministic "dry-run" of AevumGuardVault._processSpend, reading live
   * on-chain state so zero-wallet judges can see exactly what would happen.
   * Mirrors the contract's exact check order.
   */
  async function runDryRun() {
    const cleanRecipient = recipient.trim();
    if (recipientProblem) {
      const isZero = /^0x0{40}$/i.test(cleanRecipient);
      setVerdict({
        overall: "revert",
        headline: isZero ? "Revert · ZeroAddress" : "Revert · Invalid Recipient",
        subline: recipientProblem,
        checks: [{ name: "Recipient", outcome: "revert", detail: isZero ? "ZeroAddress()" : recipientProblem }],
      });
      return;
    }
    if (!amountCheck.ok) {
      setVerdict({
        overall: "revert",
        headline: amountCheck.code === "zero" ? "Revert · ZeroAmount" : "Revert · Invalid Amount",
        subline: amountCheck.message,
        checks: [{ name: "Amount", outcome: "revert", detail: amountCheck.message }],
      });
      return;
    }
    const amount = amountCheck.value;
    if (!inspectedAgent) {
      setVerdict({
        overall: "revert",
        headline: "Revert · AgentNotActive",
        subline: "No active on-chain agent mandate to evaluate.",
        checks: [{ name: "Agent Mandate", outcome: "revert", detail: "AgentNotActive()" }],
      });
      return;
    }

    setDryRunning(true);
    try {
      const [vaultRaw, policyRaw, payeeRaw] = await Promise.all([
        readContract(config, {
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "getVault",
          args: [vaultId],
          chainId: net.chain.id,
        }),
        readContract(config, {
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "getPolicy",
          args: [vaultId, inspectedAgent],
          chainId: net.chain.id,
        }),
        readContract(config, {
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "getPayee",
          args: [vaultId, cleanRecipient as Address],
          chainId: net.chain.id,
        }),
      ]);
      const vault = vaultRaw as VaultView;
      const policy = policyRaw as PolicyView;
      const payee = payeeRaw as PayeeView;

      const checks: CheckResult[] = [];

      // 1. Vault exists + not paused
      if (!vault || vault.owner === "0x0000000000000000000000000000000000000000") {
        checks.push({ name: "Vault exists", outcome: "revert", detail: "VaultNotFound()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · VaultNotFound",
          subline: `Vault #${vaultId.toString()} does not exist.`,
          checks,
        });
        return;
      }
      checks.push({
        name: "Vault active",
        outcome: "pass",
        detail: "Vault found",
      });
      if (vault.paused) {
        checks.push({ name: "Kill-switch", outcome: "revert", detail: "VaultPaused()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · VaultPaused",
          subline: "Vault is frozen by its emergency kill-switch.",
          checks,
        });
        return;
      }
      checks.push({ name: "Kill-switch", outcome: "pass", detail: "Not paused" });

      // 2. Agent active + not expired
      if (!policy || !policy.active) {
        checks.push({ name: "Agent Mandate", outcome: "revert", detail: "AgentNotActive()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · AgentNotActive",
          subline: `${short(inspectedAgent)} has no active mandate on this vault.`,
          checks,
        });
        return;
      }
      checks.push({ name: "Agent Mandate", outcome: "pass", detail: "Active" });
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const currentDay = nowSec / 86400n;
      const effectiveSpentToday = currentDay > policy.lastSpendDay ? 0n : policy.spentToday;
      if (policy.expiresAt !== 0n && nowSec > policy.expiresAt) {
        checks.push({ name: "Mandate expiry", outcome: "revert", detail: "PolicyExpired()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · PolicyExpired",
          subline: "This agent's mandate has expired.",
          checks,
        });
        return;
      }
      checks.push({ name: "Mandate expiry", outcome: "pass", detail: "Not expired" });

      // 3. Allowlist / payee verification
      const payeeAllowed = Boolean(payee?.approved);
      if (vault.enforceAllowlist && !payeeAllowed) {
        checks.push({ name: "Confirmation of Payee", outcome: "revert", detail: "PayeeNotAllowlisted()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · PayeeNotAllowlisted",
          subline: "Recipient is not on the verified payee allowlist.",
          checks,
        });
        return;
      }
      checks.push({
        name: "Confirmation of Payee",
        outcome: "pass",
        detail: vault.enforceAllowlist
          ? `Verified${payee?.label ? ` (${payee.label})` : ""}`
          : "Allowlist off",
      });

      // 4. Available balance
      if (vault.balance < amount) {
        checks.push({ name: "Vault balance", outcome: "revert", detail: "InsufficientVaultBalance()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · InsufficientVaultBalance",
          subline: `${formatToken(vault.balance, tokenDecimals)} available, ${formatToken(amount, tokenDecimals)} required.`,
          checks,
        });
        return;
      }
      checks.push({
        name: "Vault balance",
        outcome: "pass",
        detail: `${formatToken(vault.balance, tokenDecimals)} available ≥ ${formatToken(amount, tokenDecimals)}`,
      });

      // 5. Lifetime budget
      if (policy.totalBudget !== 0n && policy.spentTotal + amount > policy.totalBudget) {
        const remaining =
          policy.totalBudget > policy.spentTotal ? policy.totalBudget - policy.spentTotal : 0n;
        checks.push({ name: "Lifetime budget", outcome: "revert", detail: "TotalBudgetExceeded()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · TotalBudgetExceeded",
          subline: `Only ${formatToken(remaining, tokenDecimals)} left of lifetime cap (requested ${formatToken(amount, tokenDecimals)}).`,
          checks,
        });
        return;
      }
      checks.push({
        name: "Lifetime budget",
        outcome: "pass",
        detail:
          policy.totalBudget === 0n
            ? "No cap"
            : `${formatToken(policy.spentTotal, tokenDecimals)} / ${formatToken(policy.totalBudget, tokenDecimals)} used`,
      });

      // 6. Per-tx + daily limit → instant vs escalate
      const exceedsPerTx = amount > policy.perTxLimit;
      const projectedDaily = effectiveSpentToday + amount;
      const exceedsDaily = projectedDaily > policy.dailyLimit;
      checks.push({
        name: "Per-tx limit",
        outcome: exceedsPerTx ? "escalate" : "pass",
        detail: `${formatToken(amount, tokenDecimals)} vs ${formatToken(policy.perTxLimit, tokenDecimals)} cap`,
      });
      checks.push({
        name: "Daily limit",
        outcome: exceedsDaily ? "escalate" : "pass",
        detail: `${formatToken(projectedDaily, tokenDecimals)} vs ${formatToken(policy.dailyLimit, tokenDecimals)} daily cap`,
      });

      if (!exceedsPerTx && !exceedsDaily) {
        setVerdict({
          overall: "pass",
          headline: "SpendExecuted · Instant Settlement",
          subline: "Within per-tx and daily limits — transfers immediately.",
          checks,
        });
        return;
      }

      // 7. Over-limit: queue or revert
      if (!policy.allowQueueOverflow) {
        checks.push({ name: "Queue overflow", outcome: "revert", detail: "SpendLimitExceeded()" });
        setVerdict({
          overall: "revert",
          headline: "Revert · SpendLimitExceeded",
          subline: "Over limit and queue overflow is disabled for this agent.",
          checks,
        });
        return;
      }
      checks.push({
        name: "Queue overflow",
        outcome: "escalate",
        detail: "allowQueueOverflow = true",
      });
      const overLimitNote = exceedsPerTx && exceedsDaily
        ? "Amount exceeds both the per-tx and daily limits, so it is escrowed in the 24h human approval queue instead of being paid out."
        : exceedsPerTx
          ? "Amount exceeds the per-tx limit, so it is escrowed in the 24h human approval queue instead of being paid out."
          : "Amount exceeds the remaining daily limit, so it is escrowed in the 24h human approval queue instead of being paid out.";
      setVerdict({
        overall: "escalate",
        headline: "SpendQueued · 24h Escrow Queue",
        subline: overLimitNote,
        checks,
      });
    } catch (e) {
      setVerdict({
        overall: "revert",
        headline: "Dry-run failed",
        subline: explain(e),
        checks: [],
      });
    } finally {
      setDryRunning(false);
    }
  }

  async function runSpend() {
    const cleanRecipient = recipient.trim();
    if (recipientProblem) {
      setFeedback({ tone: "bad", title: "Invalid recipient", detail: recipientProblem });
      return;
    }
    if (!amountCheck.ok) {
      setFeedback({
        tone: "bad",
        title: amountCheck.code === "empty" ? "Amount required" : "Invalid amount",
        detail: amountCheck.message,
      });
      return;
    }
    const amount = amountCheck.value;
    if (activeMode === "gasless-agent" && !demoAgent) {
      setFeedback({
        tone: "bad",
        title: "Demo agent unavailable",
        detail: "The browser-local demo key is still loading. Retry in a moment or use Direct Wallet mode.",
      });
      return;
    }

    const invoiceRef = refToBytes32(invoiceText);
    const cleanMemo = memo.trim() || "Agent invoice settlement";

    setBusy(true);
    setFeedback(null);
    try {
      let hash: Hash;
      if (activeMode === "gasless-agent") {
        if (!demoAgent) throw new Error("Demo agent key is not initialized.");
        const nonce = await readContract(config, {
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "agentNonces",
          args: [demoAgent.address],
          chainId: net.chain.id,
        });
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        const intent = {
          vaultId,
          agent: demoAgent.address,
          recipient: cleanRecipient as Address,
          amount,
          invoiceRef,
          memo: cleanMemo,
          nonce,
          deadline,
        };
        const signature = await demoAgent.signTypedData(spendIntentTypedData(net.chain.id, vaultAddress, intent));
        const res = await fetch("/api/relay-spend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chainId: net.chain.id,
            intent: {
              vaultId: intent.vaultId.toString(),
              agent: intent.agent,
              recipient: intent.recipient,
              amount: intent.amount.toString(),
              invoiceRef: intent.invoiceRef,
              memo: intent.memo,
              nonce: intent.nonce.toString(),
              deadline: intent.deadline.toString(),
            },
            signature,
          }),
        });
        const data = (await res.json()) as { hash?: Hash; error?: string };
        if (!res.ok || !data.hash) throw new Error(data.error ?? "Relayer rejected agent intent.");
        hash = data.hash;
      } else {
        if (!address || !onChain) throw new Error("Connect your wallet on the active network first.");
        const { request } = await simulateContract(config, {
          account: address,
          address: vaultAddress,
          abi: aevumGuardAbi,
          functionName: "executeSpend",
          args: [vaultId, cleanRecipient as Address, amount, invoiceRef, cleanMemo],
          chainId: net.chain.id,
        });
        hash = await writeContract(config, request);
      }

      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("Transaction reverted on chain.");

      const executedLogs = parseEventLogs({
        abi: aevumGuardAbi,
        logs: receipt.logs,
        eventName: "SpendExecuted",
      });
      const queuedLogs = parseEventLogs({
        abi: aevumGuardAbi,
        logs: receipt.logs,
        eventName: "SpendQueued",
      });

      if (executedLogs.length > 0) {
        setFeedback({
          tone: "good",
          title: `AUTO-APPROVED · Paid ${formatToken(amount, tokenDecimals)} ${tokenSymbol}`,
          detail: `Settled immediately on-chain to ${short(cleanRecipient)} ("${cleanMemo}").`,
          txHash: hash,
        });
      } else if (queuedLogs.length > 0) {
        const q = queuedLogs[0].args;
        const reason =
          q.reasonCode === 1
            ? "exceeded per-transaction limit"
            : q.reasonCode === 2
              ? "exceeded remaining daily limit"
              : "exceeded both per-tx and daily limits";
        setFeedback({
          tone: "warn",
          title: `QUEUED FOR HUMAN APPROVAL · Request #${q.requestId.toString()}`,
          detail: `Funds reserved in escrow because payment ${reason}. Approve or reject in Panel 4.`,
          txHash: hash,
        });
      } else {
        setFeedback({
          tone: "good",
          title: "Spend Transaction Confirmed",
          detail: `Confirmed in block ${receipt.blockNumber.toString()}.`,
          txHash: hash,
        });
      }
      onMutated();
    } catch (e) {
      setFeedback({
        tone: "bad",
        title: "BLOCKED BY ON-CHAIN POLICY",
        detail: explain(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="card-head">
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Panel 3 · Live AI Agent Spend Simulator
          </p>
          <h2>Invoice &amp; Policy Runner</h2>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={`btn small ${activeMode === "gasless-agent" ? "" : "secondary"}`}
            disabled={!gaslessAvailable || busy}
            title={
              gaslessAvailable
                ? "Sign an EIP-712 SpendIntent as the demo agent; the relayer pays gas."
                : "Hosted gasless relayer is paused on this public demo; use Direct Mode or Dry-Run."
            }
            onClick={() => setMode("gasless-agent")}
          >
            Gasless EIP-712
          </button>
          <button
            type="button"
            className={`btn small ${activeMode === "direct-wallet" ? "" : "secondary"}`}
            disabled={busy}
            onClick={() => setMode("direct-wallet")}
          >
            Direct Wallet
          </button>
        </div>
      </div>

      {/* 3 One-Click Demo Scenarios */}
      <div className="scenario-row">
        <button type="button" className="scenario-btn" onClick={() => applyScenario("auto")}>
          <strong>1. Within Limit</strong>
          <span>Verified payee · 0.40 {tokenSymbol} → Auto-Approve</span>
        </button>
        <button type="button" className="scenario-btn" onClick={() => applyScenario("blocked")}>
          <strong>2. Unverified Payee</strong>
          <span>0x…dEaD · 0.25 {tokenSymbol} → Blocked</span>
        </button>
        <button type="button" className="scenario-btn" onClick={() => applyScenario("queue")}>
          <strong>3. Over Per-Tx Cap</strong>
          <span>Verified payee · 0.85 {tokenSymbol} → Escrowed in 24h queue</span>
        </button>
      </div>

      <div className="field-grid">
        <label className="field-label" style={{ gridColumn: "1 / -1" }}>
          Recipient Address
          <input
            className="field"
            type="text"
            value={recipient}
            onChange={(e) => {
              recipientTouchedRef.current = true;
              setRecipient(e.target.value);
              setVerdict(null);
            }}
            placeholder="0x..."
            aria-invalid={recipient.length > 0 && Boolean(recipientProblem)}
            aria-describedby={recipientProblem ? "recipient-error" : undefined}
          />
          {recipient.length > 0 && recipientProblem && (
            <span id="recipient-error" className="fine" style={{ color: "var(--bad)" }}>
              {recipientProblem}
            </span>
          )}
        </label>
        <label className="field-label">
          Amount ({tokenSymbol})
          <input
            className="field"
            type="text"
            value={amountStr}
            onChange={(e) => {
              setAmountStr(e.target.value);
              setVerdict(null);
            }}
            aria-invalid={Boolean(amountProblem) && amountStr.length > 0}
            aria-describedby={amountProblem ? "amount-error" : undefined}
          />
          {amountStr.length > 0 && amountProblem && (
            <span id="amount-error" className="fine" style={{ color: "var(--bad)" }}>
              {amountProblem}
            </span>
          )}
        </label>
        <label className="field-label">
          Invoice / Reference
          <input className="field" type="text" value={invoiceText} onChange={(e) => setInvoiceText(e.target.value)} />
        </label>
        <label className="field-label" style={{ gridColumn: "1 / -1" }}>
          Memo
          <input className="field" type="text" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>

      <button
        type="button"
        className="btn big block"
        disabled={busy || (activeMode === "direct-wallet" && !onChain)}
        onClick={() => void runSpend()}
      >
        {busy
          ? "Evaluating Policy & Submitting…"
          : activeMode === "gasless-agent"
            ? `Sign as Demo Agent (${demoAgent ? short(demoAgent.address) : "loading…"}) & Submit Gasless`
            : "Execute Spend via Connected Wallet"}
      </button>

      <button
        type="button"
        className="btn block"
        style={{ background: "var(--surface-2)", borderColor: "var(--line-strong)", color: "var(--text)" }}
        disabled={dryRunning || busy}
        onClick={() => void runDryRun()}
      >
        {dryRunning ? "Reading live on-chain policy…" : "Dry-Run Guardrail Check (No Wallet Needed)"}
      </button>

      {verdict && (
        <div
          className="stack"
          style={{
            gap: 10,
            padding: "14px 16px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid",
            borderColor:
              verdict.overall === "pass"
                ? "var(--good-line)"
                : verdict.overall === "escalate"
                  ? "var(--warn-line)"
                  : "var(--bad-line)",
            background:
              verdict.overall === "pass"
                ? "var(--good-bg)"
                : verdict.overall === "escalate"
                  ? "var(--warn-bg)"
                  : "var(--bad-bg)",
          }}
        >
          <div className="check-top" style={{ alignItems: "center" }}>
            <strong
              style={{
                color:
                  verdict.overall === "pass"
                    ? "var(--good)"
                    : verdict.overall === "escalate"
                      ? "var(--warn)"
                      : "var(--bad)",
              }}
            >
              {verdict.headline}
            </strong>
            <span
              className={`status-pill ${
                verdict.overall === "pass" ? "good" : verdict.overall === "escalate" ? "warn" : "bad"
              }`}
            >
              {verdict.overall === "pass" ? "PASS" : verdict.overall === "escalate" ? "ESCALATE" : "REVERT"}
            </span>
          </div>
          <p className="fine" style={{ color: "var(--text-2)" }}>
            {verdict.subline}
          </p>
          {verdict.checks.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {verdict.checks.map((c, idx) => (
                <div
                  key={`${c.name}-${idx}`}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}
                >
                  <span className="fine" style={{ color: "var(--text-2)", fontFamily: "var(--font-mono)" }}>
                    {c.name}
                  </span>
                  <span
                    className="fine"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color:
                        c.outcome === "pass"
                          ? "var(--good)"
                          : c.outcome === "escalate"
                            ? "var(--warn)"
                            : "var(--bad)",
                    }}
                  >
                    {c.outcome === "pass" ? "PASS" : c.outcome === "escalate" ? "ESCALATE" : "REVERT"} · {c.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="fine">
        {activeMode === "gasless-agent"
          ? "Demo Agent signs an EIP-712 SpendIntent locally; /api/relay-spend simulates and relays it."
          : "Direct mode calls AevumGuardVault.executeSpend from your connected wallet (must be authorized in Panel 2)."}
      </p>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />
    </section>
  );
}
