"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi, getLogsChunked, txUrl } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatTimeRemaining, formatToken, short } from "@/lib/format";
import { dedupeSortLogs, launchRecentPlan, type RawLog } from "@/lib/launchWindow";
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
  // Window mode: bigint = "last N blocks", "launch+recent" = deployBlock launch window + latest 3k.
  const [windowMode, setWindowMode] = useState<string>("launch+recent");
  const [progress, setProgress] = useState(0);

  const windowBlocks = windowMode === "launch+recent" ? null : BigInt(windowMode);
  const isLaunchRecent = windowMode === "launch+recent";

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
    queryKey: [
      "vault-audit",
      net.chain.id,
      vaultAddress,
      vaultId.toString(),
      windowMode,
      net.deployBlock?.toString() ?? "0",
      refreshTick,
    ],
    enabled: Boolean(client),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const isLaunch = isLaunchRecent && net.deployBlock !== undefined && net.deployBlock > 0n;
      const plan = isLaunch ? launchRecentPlan(net.deployBlock, head) : null;
      const ranges = plan
        ? plan.ranges
        : [
            {
              from: windowBlocks !== null && head > windowBlocks ? head - windowBlocks + 1n : 0n,
              to: head,
            },
          ];
      const fromBlock = ranges[0]?.from ?? 0n;
      const caption = plan ? plan.label : `${fromBlock.toString()}–${head.toString()}`;
      setProgress(0);

      const events = [
        { name: "SpendExecuted", kind: "Executed" },
        { name: "SpendQueued", kind: "Queued" },
        { name: "RequestApproved", kind: "Approved" },
        { name: "RequestRejected", kind: "Rejected" },
        { name: "Deposited", kind: "Deposited" },
      ] as const;

      const entries: AuditEntry[] = [];
      const totalChunks = ranges.length;
      let chunkIdx = 0;

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        for (const range of ranges) {
          const logs = await getLogsChunked(client!, {
            address: vaultAddress,
            event: getAbiItem({ abi: aevumGuardAbi, name: ev.name }) as AbiEvent,
            args: { vaultId },
            fromBlock: range.from,
            toBlock: range.to,
            onProgress: (done, total) => {
              const pct = total ? Number((done * 100n) / total) : 100;
              const withinEvent = (chunkIdx + pct / 100) / totalChunks;
              setProgress(Math.round(((i + withinEvent / 1) / events.length) * 100));
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
          chunkIdx += 1;
        }
      }

      const merged = dedupeSortLogs(
        entries.map((e) => ({
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          transactionHash: e.txHash,
          entry: e,
        })),
      ).map((x) => x.entry);

      setProgress(100);
      return { fromBlock, head, caption, entries: merged.slice(0, 30) };
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
                    {r.status === 1 && expired ? (
                      <span className="status-pill warn" title="24h approval TTL elapsed — cancel to refund escrow">
                        Expired (24h TTL elapsed — refundable via cancelExpiredRequest)
                      </span>
                    ) : (
                      <span className={`status-pill ${st.cls}`}>{st.label}</span>
                    )}
                  </div>
                  <div className="fine">
                    Agent <code className="mono">{short(r.agent)}</code> → Payee{" "}
                    <code className="mono">{short(r.recipient)}</code> · {reasonLabel(r.reasonCode)}
                  </div>
                  <div className="fine">
                    Memo: &ldquo;{r.memo}&rdquo; · Ref <code className="mono">{short(r.invoiceRef)}</code> ·{" "}
                    {r.status === 1 ? (
                      expired ? (
                        <span style={{ color: "var(--warn)" }}>Expired — refund via “Cancel Expired”</span>
                      ) : (
                        formatTimeRemaining(r.expiresAt)
                      )
                    ) : (
                      ""
                    )}
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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {net.deployBlock !== undefined && net.deployBlock > 0n && (
              <button
                type="button"
                className={`btn small ${windowMode === "launch+recent" ? "" : "secondary"}`}
                onClick={() => setWindowMode("launch+recent")}
                title={`Scan the launch window (${net.deployBlock.toString()}) plus the latest 3,000 blocks`}
              >
                Launch + Recent
              </button>
            )}
            {([1_000, 3_000, 10_000] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`btn small ${windowMode === w.toString() ? "" : "secondary"}`}
                onClick={() => setWindowMode(w.toString())}
              >
                {w / 1000}k blocks
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
              Scanning{" "}
              {windowMode === "launch+recent" && auditQuery.data
                ? auditQuery.data.caption
                : isLaunchRecent
                  ? "launch + recent windows"
                  : `${Number(windowMode).toLocaleString("en-US")} blocks`}{" "}
              in 1,000-block chunks… {progress}%
            </p>
          </div>
        )}

        {auditQuery.error && <p className="fine">Could not load logs: {(auditQuery.error as Error).message}</p>}

        {auditQuery.data && auditQuery.data.entries.length === 0 && !auditQuery.isFetching && (
          <p className="fine">
            No vault events in {auditQuery.data.caption} (blocks {auditQuery.data.fromBlock.toString()}–
            {auditQuery.data.head.toString()}).
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
