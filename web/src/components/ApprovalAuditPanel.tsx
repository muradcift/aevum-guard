"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { aevumGuardAbi, getLogsChunked, MAX_LOG_RANGE, txUrl } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import { formatExpiry, formatToken, short } from "@/lib/format";
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
  // Window mode: bigint string = "last N blocks", "launch+recent" = deployBlock launch window + latest 3k.
  const [windowMode, setWindowMode] = useState<string>("launch+recent");
  const [progress, setProgress] = useState(0);
  const [scanning, setScanning] = useState(false);
  // Wall clock for TTL badges; re-renders every 30s so a request flips to
  // "Expired" while the panel stays open instead of showing a stale countdown.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Bumped by the Refresh button so an explicit rescan is a *new* visible scan
  // instead of a silent refetch of the current key.
  const [manualScan, setManualScan] = useState(0);
  // Every queryFn run gets a unique id. Progress callbacks from a superseded run
  // (tab switch, window switch, refetch) are dropped so the bar can never move
  // backwards, and only a user-visible scan is allowed to reset it to zero.
  const scanRunRef = useRef(0);
  const scanKeyRef = useRef("");

  const canLaunchRecent = net.deployBlock !== undefined && net.deployBlock > 0n;
  // "launch+recent" is the default, but it is meaningless (and would silently
  // scan the whole chain) on networks where the deploy block is unknown.
  const activeWindowMode = windowMode === "launch+recent" && !canLaunchRecent ? "3000" : windowMode;
  const windowBlocks = activeWindowMode === "launch+recent" ? null : BigInt(activeWindowMode);
  const isLaunchRecent = activeWindowMode === "launch+recent";
  const scanSignature = [
    net.chain.id,
    vaultAddress,
    vaultId.toString(),
    activeWindowMode,
    net.deployBlock?.toString() ?? "0",
    refreshTick,
    manualScan,
  ].join("|");

  const nextReqQuery = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "nextRequestId",
    chainId: net.chain.id,
    // Keep the approval queue fresh without ever re-running the log scan.
    query: { refetchInterval: 30_000, refetchIntervalInBackground: false },
  });

  const nextReqId = nextReqQuery.data ?? 1n;

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
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
    query: { enabled: reqIds.length > 0, refetchInterval: 30_000, refetchIntervalInBackground: false },
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

  const activePendingCount = requests.filter(
    (r) => r.status === 1 && !formatExpiry(r.expiresAt, nowMs).expired,
  ).length;
  const expiredCount = requests.filter((r) => r.status === 1 && formatExpiry(r.expiresAt, nowMs).expired).length;
  const queueCountLabel =
    activePendingCount > 0 && expiredCount > 0
      ? `${activePendingCount} pending · ${expiredCount} expired`
      : activePendingCount > 0
        ? `${activePendingCount} pending`
        : expiredCount > 0
          ? `${expiredCount} expired · 0 active`
          : "0 pending";

  const auditQuery = useQuery({
    queryKey: [
      "vault-audit",
      net.chain.id,
      vaultAddress,
      vaultId.toString(),
      activeWindowMode,
      net.deployBlock?.toString() ?? "0",
      refreshTick,
      manualScan,
    ],
    enabled: Boolean(client),
    // Log scans are expensive and read-only: only explicit user actions
    // (window switch, Refresh, or a mutation) start a new one. Never on focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const runId = scanRunRef.current + 1;
      scanRunRef.current = runId;
      const isUserInitiatedScan = scanKeyRef.current !== scanSignature;
      if (isUserInitiatedScan) {
        scanKeyRef.current = scanSignature;
        setProgress(0);
        setScanning(true);
      }
      // Monotonic + stale-run-guarded progress: a newer scan owns the bar, and
      // progress within one scan can only ever increase (0..100).
      const publish = (pct: number) => {
        if (runId !== scanRunRef.current) return;
        const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? Math.round(pct) : 0));
        setProgress((prev) => (clamped > prev ? clamped : prev));
      };

      try {
        const head = await client!.getBlockNumber();
        const isLaunch = isLaunchRecent && canLaunchRecent;
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

        const events = [
          { name: "SpendExecuted", kind: "Executed" },
          { name: "SpendQueued", kind: "Queued" },
          { name: "RequestApproved", kind: "Approved" },
          { name: "RequestRejected", kind: "Rejected" },
          { name: "Deposited", kind: "Deposited" },
        ] as const;

        const entries: AuditEntry[] = [];
        // Exact number of ≤1,000-block requests getLogsChunked will issue per
        // range: floor((to - from) / MAX_LOG_RANGE) + 1 (0 for empty ranges).
        // This must match the chunking loop in getLogsChunked so the progress
        // denominator equals the real work across all ranges and event types.
        const chunksPerRange = ranges.map((r) =>
          r.to >= r.from ? Number((r.to - r.from) / MAX_LOG_RANGE) + 1 : 0,
        );
        const totalChunks = chunksPerRange.reduce((a, b) => a + b, 0);
        const totalChunkUnits = Math.max(totalChunks * events.length, 1);

        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          let chunksBeforeRange = 0;
          for (let j = 0; j < ranges.length; j++) {
            const range = ranges[j];
            const rangeChunks = chunksPerRange[j];
            const baseUnits = i * totalChunks + chunksBeforeRange;
            const logs = await getLogsChunked(client!, {
              address: vaultAddress,
              event: getAbiItem({ abi: aevumGuardAbi, name: ev.name }) as AbiEvent,
              args: { vaultId },
              fromBlock: range.from,
              toBlock: range.to,
              onProgress: (done, total) => {
                const completedChunks =
                  total > 0n ? Number((done + MAX_LOG_RANGE - 1n) / MAX_LOG_RANGE) : rangeChunks;
                publish(((baseUnits + Math.min(rangeChunks, completedChunks)) / totalChunkUnits) * 100);
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
            chunksBeforeRange += rangeChunks;
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

        publish(100);
        return {
          fromBlock,
          head,
          caption,
          isLaunch,
          windowMode: activeWindowMode,
          entries: merged.slice(0, 30),
        };
      } finally {
        if (scanRunRef.current === runId) setScanning(false);
      }
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
            setManualScan((n) => n + 1);
            void nextReqQuery.refetch().catch(() => undefined);
            void reqBatch.refetch().catch(() => undefined);
          }}
        >
          Refresh
        </button>
      </div>

      <ActionFeedbackBox feedback={feedback} hasExplorer={net.hasExplorer} />

      {/* Approval Queue */}
      <div className="stack" style={{ gap: 10 }}>
        <strong>Approval Queue ({queueCountLabel})</strong>
        {requests.length === 0 ? (
          <p className="fine">No spend requests queued for Vault #{vaultId.toString()} yet.</p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {requests.map((r) => {
              const st = STATUS_LABEL[r.status] ?? { label: "Unknown", cls: "info" };
              const exp = formatExpiry(r.expiresAt, nowMs);
              const expired = r.status === 1 && exp.expired;
              const expiresTitle = `Approval TTL ends ${new Date(Number(r.expiresAt) * 1000).toLocaleString("en-US")}`;
              return (
                <div className="req-card" key={r.requestId.toString()}>
                  <div className="check-top" style={{ alignItems: "center" }}>
                    <span className="mono">
                      <strong>#{r.requestId.toString()}</strong> · {formatToken(r.amount, tokenDecimals)} {tokenSymbol}
                    </span>
                    {expired ? (
                      <span
                        className="status-pill warn"
                        title="24h approval TTL elapsed — cancel to refund the escrowed amount"
                      >
                        Expired
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
                    Memo: &ldquo;{r.memo}&rdquo; · Ref <code className="mono">{short(r.invoiceRef)}</code>
                    {r.status === 1 ? (
                      <span style={{ color: expired ? "var(--warn)" : undefined }} title={expiresTitle}>
                        {" "}
                        · {exp.text}
                      </span>
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
            {canLaunchRecent && (
              <button
                type="button"
                className={`btn small ${activeWindowMode === "launch+recent" ? "" : "secondary"}`}
                onClick={() => setWindowMode("launch+recent")}
                title={`Scan the launch window (${net.deployBlock!.toString()}) plus the latest 3,000 blocks`}
              >
                Launch + Recent
              </button>
            )}
            {([1_000, 3_000, 10_000] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`btn small ${activeWindowMode === w.toString() ? "" : "secondary"}`}
                onClick={() => setWindowMode(w.toString())}
              >
                {`${w / 1000}k blocks`}
              </button>
            ))}
          </div>
        </div>

        {scanning && auditQuery.isFetching && (
          <div>
            <div
              className="progress"
              role="progressbar"
              aria-label="Scanning audit log"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span key={scanSignature} style={{ width: `${progress}%` }} />
            </div>
            <p className="fine" style={{ marginTop: 6 }}>
              Scanning{" "}
              {isLaunchRecent
                ? canLaunchRecent
                  ? `launch window (${net.deployBlock!.toString()}) + latest 3k blocks`
                  : "latest 3k blocks"
                : `${Number(activeWindowMode).toLocaleString("en-US")} blocks`}{" "}
              in 1,000-block chunks… {progress}%
            </p>
          </div>
        )}

        {auditQuery.error && (
          <p className="fine" role="alert">
            Could not load logs: {explain(auditQuery.error)}
          </p>
        )}

        {auditQuery.data &&
          auditQuery.data.windowMode === activeWindowMode &&
          auditQuery.data.entries.length === 0 &&
          !auditQuery.isFetching && (
            <p className="fine">
              {auditQuery.data.isLaunch
                ? `No vault events in ${auditQuery.data.caption}.`
                : `No vault events in blocks ${auditQuery.data.fromBlock.toString()}–${auditQuery.data.head.toString()}.`}
            </p>
          )}

        {auditQuery.data && auditQuery.data.windowMode === activeWindowMode && auditQuery.data.entries.length > 0 && (
          <>
            <div
              className="table-wrap audit-table-wrap"
              role="region"
              aria-label="On-chain audit log"
              tabIndex={0}
            >
              <table className="data audit-table">
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
                      <td className="audit-event">
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
                      <td className="audit-detail">{item.detail}</td>
                      <td className="right num audit-amount">
                        {item.amount !== undefined ? `${formatToken(item.amount, tokenDecimals)} ${tokenSymbol}` : "—"}
                      </td>
                      <td className="right mono audit-tx">
                        {net.hasExplorer ? (
                          <a href={txUrl(item.txHash)} target="_blank" rel="noreferrer">
                            {short(item.txHash, 5, 4)} ↗
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
            <p className="fine audit-scroll-hint">Scroll horizontally for the full detail and Tx links →</p>
          </>
        )}
      </div>
    </section>
  );
}
