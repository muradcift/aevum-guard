"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress, parseEventLogs, type Address, type Hash } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { useAccount, useConfig } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi, spendIntentTypedData } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatToken, refToBytes32, safeParseUnits, short } from "@/lib/format";
import type { Network } from "@/lib/env";
import type { ActionFeedback } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";

const UNVERIFIED_DEMO_PAYEE: Address = "0x000000000000000000000000000000000000dEaD";

interface SpendSimulatorPanelProps {
  net: Network;
  vaultAddress: Address;
  vaultId: bigint;
  onChain: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  demoAgent: PrivateKeyAccount | null;
  preferredPayee?: Address;
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

  useEffect(() => {
    if (preferredPayee && !recipient) {
      setRecipient(preferredPayee);
    }
  }, [preferredPayee, recipient]);

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
    if (kind === "auto") {
      setRecipient(safeTarget);
      setAmountStr("0.50");
      setInvoiceText(`INV-AUTO-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Routine API inference call (within limit)");
    } else if (kind === "blocked") {
      setRecipient(UNVERIFIED_DEMO_PAYEE);
      setAmountStr("0.25");
      setInvoiceText(`INV-ROGUE-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Transfer to unverified external address");
    } else {
      setRecipient(safeTarget);
      setAmountStr("2.00");
      setInvoiceText(`INV-ESC-${Math.floor(Math.random() * 900 + 100)}`);
      setMemo("Dedicated GPU cluster lease (over per-tx limit)");
    }
    setFeedback(null);
  }

  async function runSpend() {
    const cleanRecipient = recipient.trim();
    if (!isAddress(cleanRecipient)) {
      setFeedback({ tone: "bad", title: "Invalid recipient", detail: "Enter a valid 0x payee address." });
      return;
    }
    const amount = safeParseUnits(amountStr, tokenDecimals);
    if (!amount || amount <= 0n) {
      setFeedback({ tone: "bad", title: "Invalid amount", detail: "Enter a positive spend amount." });
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
          <span>Verified payee · 0.50 {tokenSymbol} → Auto-Approve</span>
        </button>
        <button type="button" className="scenario-btn" onClick={() => applyScenario("blocked")}>
          <strong>2. Unverified Payee</strong>
          <span>0x…dEaD · 0.25 {tokenSymbol} → Blocked</span>
        </button>
        <button type="button" className="scenario-btn" onClick={() => applyScenario("queue")}>
          <strong>3. Over Per-Tx Cap</strong>
          <span>Verified payee · 2.00 {tokenSymbol} → Queue</span>
        </button>
      </div>

      <div className="field-grid">
        <label className="field-label" style={{ gridColumn: "1 / -1" }}>
          Recipient Address
          <input
            className="field"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
          />
        </label>
        <label className="field-label">
          Amount ({tokenSymbol})
          <input className="field" type="text" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
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
            ? `Sign as Demo Agent (${short(demoAgent?.address ?? "")}) & Submit Gasless`
            : "Execute Spend via Connected Wallet"}
      </button>

      <p className="fine">
        {activeMode === "gasless-agent"
          ? "Demo Agent signs an EIP-712 SpendIntent locally; /api/relay-spend simulates and relays it."
          : "Direct mode calls AevumGuardVault.executeSpend from your connected wallet (must be authorized in Panel 2)."}
      </p>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />
    </section>
  );
}
