"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi, getLogsChunked, txUrl } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatTimeRemaining, formatToken, short } from "@/lib/format";
import type { Network } from "@/lib/env";
import type { ActionFeedback, SpendRequestView } from "@/lib/vaultTypes";
import { ActionFeedbackBox } from "./ActionFeedbackBox";

const STATUS_LABEL: Record<number, { label: string; cls: string }> = {
  1: { label: "Pending", cls: "warn" },
  2: { label: "Approved", cls: "good" },
  3: { label: "Rejected", cls: "bad" },
  4: { label: "Cancelled", cls: "info" },
};

function reasonLabel(code: number): string {
  if (code === 3) return "Over per-tx & daily limit";
  if (code === 2) return "Over daily limit";
  return "Over per-tx limit";
}

interface AuditEntry {
  kind: "Executed" | "Queued" | "Approved" | "Rejected" | "Deposited" | "Paused";
  detail: string;
  amount?: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}

interface ApprovalAuditPanelProps {
  net: Network;
  vaultAddress: Address;
  vaultId: bigint;
  isOwner: boolean;
  onChain: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  refreshTick: number;
  onMutated: () => void;
}

export function ApprovalAuditPanel({
  net,
  vaultAddress,
  vaultId,
  isOwner,
  onChain,
  tokenDecimals,
  tokenSymbol,
  refreshTick,
  onMutated,
}: ApprovalAuditPanelProps) {
  const config = useConfig();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const [busyReq, setBusyReq] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [windowBlocks, setWindowBlocks] = useState<bigint>(3_000n);
  const [progress, setProgress] = useState(0);

  const nextReqQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "nextRequestId",
    chainId: net.chain.id,
  });

  const nextReqId = nextReqQuery.data ?? 1n;
  const reqIds: bigint[] = [];
  for (let id = nextReqId - 1n; id >= 1n && reqIds.length < 20; id--) {
    reqIds.push(id);
  }

  const reqBatch = useReadContracts({
    contracts: reqIds.map((id) => ({
      address: vaultAddress,
      abi: aevumGuardAbi,
      functionName: "getRequest" as const,
      args: [id] as const,
      chainId: net.chain.id,
    })),
    query: { enabled: reqIds.length > 0 },
  });

  const requests: SpendRequestView[] = (reqBatch.data ?? [])
    .map((entry, idx) => {
      const r = entry.result as
        | {
            vaultId: bigint;
            agent: Address;
            recipient: Address;
            amount: bigint;
            invoiceRef: Hex;
            memo: string;
            createdAt: bigint;
            expiresAt: bigint;
            reasonCode: number;
            status: number;
          }
        | undefined;
      if (!r || r.status === 0 || r.vaultId !== vaultId) return null;
      return { requestId: reqIds[idx], ...r };
    })
    .filter((x): x is SpendRequestView => x !== null)
    .sort((a, b) => {
      if (a.status === 1 && b.status !== 1) return -1;
      if (a.status !== 1 && b.status === 1) return 1;
      return Number(b.requestId - a.requestId);
    });

  const auditQuery = useQuery({
    queryKey: ["vault-audit", net.chain.id, vaultAddress, vaultId.toString(), windowBlocks.toString(), refreshTick],
    enabled: Boolean(client),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      let fromBlock = head > windowBlocks ? head - windowBlocks + 1n : 0n;
      if (net.deployBlock !== undefined && net.deployBlock > fromBlock) {
        fromBlock = net.deployBlock;
      }
      setProgress(0);

      const events = [
        { name: "SpendExecuted", kind: "Executed" },
        { name: "SpendQueued", kind: "Queued" },
        { name: "RequestApproved", kind: "Approved" },
        { name: "RequestRejected", kind: "Rejected" },
        { name: "Deposited", kind: "Deposited" },
      ] as const;

      const entries: AuditEntry[] = [];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const logs = await getLogsChunked(client!, {
          address: vaultAddress,
          event: getAbiItem({ abi: aevumGuardAbi, name: ev.name }) as AbiEvent,
          args: { vaultId },
          fromBlock,
          toBlock: head,
          onProgress: (done, total) => {
            const pct = total ? Number((done * 100n) / total) : 100;
            setProgress(Math.round(((i + pct / 100) / events.length) * 100));
          },
        });
        for (const l of logs) {
          const args = (l as { args?: Record<string, unknown> }).args ?? {};
          let detail = "";
          let amount: bigint | undefined;
          if (ev.kind === "Executed") {
            amount = args.amount as bigint;
            detail = `${short(String(args.agent ?? ""))} → ${short(String(args.recipient ?? ""))} · "${String(args.memo ?? "")}"`;
          } else if (ev.kind === "Queued") {
            amount = args.amount as bigint;
            detail = `Req #${String(args.requestId ?? "")} → ${short(String(args.recipient ?? ""))} (${reasonLabel(Number(args.reasonCode ?? 1))})`;
          } else if (ev.kind === "Approved" || ev.kind === "Rejected") {
            detail = `Req #${String(args.requestId ?? "")} by ${short(String(args.approver ?? ""))}`;
          } else if (ev.kind === "Deposited") {
            amount = args.amount as bigint;
            detail = `From ${short(String(args.from ?? ""))} (${args.gasless ? "Gasless EIP-3009" : "Standard"})`;
          }
          entries.push({
            kind: ev.kind,
            detail,
            amount,
            blockNumber: l.blockNumber ?? 0n,
            logIndex: l.logIndex ?? 0,
            txHash: l.transactionHash as Hex,
          });
        }
      }

      entries.sort((a, b) =>
        a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
      );
      setProgress(100);
      return { fromBlock, head, entries: entries.slice(0, 30) };
    },
  });

  async function actOnRequest(action: "approveRequest" | "rejectRequest" | "cancelExpiredRequest", requestId: bigint) {
    if (!address || !onChain) return;
    setBusyReq(`${action}:${requestId.toString()}`);
    setFeedback(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: vaultAddress,
        abi: aevumGuardAbi,
        functionName: action,
        args: [requestId],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      await Promise.all([nextReqQuery.refetch(), reqBatch.refetch()]);
      setFeedback({
        tone: action === "approveRequest" ? "good" : "warn",
        title:
          action === "approveRequest"
            ? `Approved Request #${requestId.toString()}`
            : action === "rejectRequest"
              ? `Rejected Request #${requestId.toString()}`
              : `Cancelled Expired Request #${requestId.toString()}`,
        detail:
          action === "approveRequest"
            ? "Reserved tUSD8 released directly to the verified payee."
            : "Reserved tUSD8 unlocked back into vault available balance.",
        txHash: hash,
      });
      onMutated();
    } catch (e) {
      setFeedback({ tone: "bad", title: "Action failed", detail: explain(e) });
    } finally {
      setBusyReq(null);
    }
  }

  return (
    <section className="card stack">
      <div className="card-head">
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Panel 4 · Human Approval Queue &amp; Audit Feed
          </p>
          <h2>Human-in-the-Loop Governance</h2>
        </div>
        <button
          type="button"
          className="btn small secondary"
          onClick={() => {
            void nextReqQuery.refetch();
            void reqBatch.refetch();
            void auditQuery.refetch();
          }}
        >
          Refresh
        </button>
      </div>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />

      {/* Approval Queue */}
      <div className="stack" style={{ gap: 10 }}>
        <strong>Approval Queue ({requests.filter((r) => r.status === 1).length} pending)</strong>
        {requests.length === 0 ? (
          <p className="fine">No spend requests queued for Vault #{vaultId.toString()} yet.</p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {requests.map((r) => {
              const st = STATUS_LABEL[r.status] ?? { label: "Unknown", cls: "info" };
              const expired = r.status === 1 && Number(r.expiresAt) <= Math.floor(Date.now() / 1000);
              return (
                <div className="req-card" key={r.requestId.toString()}>
                  <div className="check-top" style={{ alignItems: "center" }}>
                    <span className="mono">
                      <strong>#{r.requestId.toString()}</strong> · {formatToken(r.amount, tokenDecimals)} {tokenSymbol}
                    </span>
                    <span className={`status-pill ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="fine">
                    Agent <code className="mono">{short(r.agent)}</code> → Payee{" "}
                    <code className="mono">{short(r.recipient)}</code> · {reasonLabel(r.reasonCode)}
                  </div>
                  <div className="fine">
                    Memo: &ldquo;{r.memo}&rdquo; · Ref <code className="mono">{short(r.invoiceRef)}</code> ·{" "}
                    {r.status === 1 ? formatTimeRemaining(r.expiresAt) : ""}
                  </div>
                  {r.status === 1 && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                      {!expired && (
                        <button
                          type="button"
                          className="btn small good"
                          disabled={!onChain || !isOwner || Boolean(busyReq)}
                          onClick={() => void actOnRequest("approveRequest", r.requestId)}
                        >
                          Approve &amp; Pay
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn small danger"
                        disabled={!onChain || !isOwner || Boolean(busyReq)}
                        onClick={() => void actOnRequest("rejectRequest", r.requestId)}
                      >
                        Reject &amp; Refund
                      </button>
                      {expired && (
                        <button
                          type="button"
                          className="btn small secondary"
                          disabled={!onChain || Boolean(busyReq)}
                          onClick={() => void actOnRequest("cancelExpiredRequest", r.requestId)}
                        >
                          Cancel Expired
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chunked On-Chain Audit Feed */}
      <div className="rule" />
      <div className="stack" style={{ gap: 10 }}>
        <div className="check-top" style={{ alignItems: "center" }}>
          <strong>On-Chain Audit Log (1,000-block chunked)</strong>
          <div style={{ display: "flex", gap: 6 }}>
            {([1_000n, 3_000n, 10_000n] as const).map((w) => (
              <button
                key={w.toString()}
                type="button"
                className={`btn small ${windowBlocks === w ? "" : "secondary"}`}
                onClick={() => setWindowBlocks(w)}
              >
                {Number(w) / 1000}k blocks
              </button>
            ))}
          </div>
        </div>

        {auditQuery.isFetching && (
          <div>
            <div className="progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="fine" style={{ marginTop: 6 }}>
              Scanning {windowBlocks.toLocaleString("en-US")} blocks in 1,000-block chunks… {progress}%
            </p>
          </div>
        )}

        {auditQuery.error && <p className="fine">Could not load logs: {(auditQuery.error as Error).message}</p>}

        {auditQuery.data && auditQuery.data.entries.length === 0 && !auditQuery.isFetching && (
          <p className="fine">
            No vault events in blocks {auditQuery.data.fromBlock.toString()}–{auditQuery.data.head.toString()}.
          </p>
        )}

        {auditQuery.data && auditQuery.data.entries.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Detail</th>
                  <th className="right">Amount</th>
                  <th className="right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.data.entries.map((item) => (
                  <tr key={`${item.txHash}-${item.logIndex}`}>
                    <td>
                      <span
                        className={`status-pill ${
                          item.kind === "Executed" || item.kind === "Approved" || item.kind === "Deposited"
                            ? "good"
                            : item.kind === "Queued"
                              ? "warn"
                              : "bad"
                        }`}
                      >
                        {item.kind}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "normal", minWidth: 180 }}>{item.detail}</td>
                    <td className="right num">
                      {item.amount !== undefined ? `${formatToken(item.amount, tokenDecimals)} ${tokenSymbol}` : "—"}
                    </td>
                    <td className="right mono">
                      {net.hasExplorer ? (
                        <a href={txUrl(item.txHash)} target="_blank" rel="noreferrer">
                          {short(item.txHash)} ↗
                        </a>
                      ) : (
                        short(item.txHash)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
