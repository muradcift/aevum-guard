import { getAbiItem, type AbiEvent, type Address, type PublicClient } from "viem";
import { aevumGuardAbi, getLogsChunked } from "@aevum-kit/aevum";

export interface BlockRange {
  from: bigint;
  to: bigint;
}

export interface LaunchRecentPlan {
  ranges: BlockRange[];
  /** Human caption like "Launch window (3685765–3686765) + latest 3k blocks". */
  label: string;
}

/**
 * Builds the scan ranges for the "Launch + Recent" window mode.
 *
 * Aevum's public RPC caps eth_getLogs at 1,000 blocks per call, so the launch
 * window is clamped to at most 1,000 blocks starting at deployBlock. The recent
 * window is the latest `recentWindow` blocks from head. When deployBlock is 0 or
 * unknown, only the recent window is returned.
 */
export function launchRecentPlan(
  deployBlock: bigint | undefined,
  head: bigint,
  deployWindow = 1000n,
  recentWindow = 3000n,
  pinnedBlocks: readonly bigint[] = [3758104n],
): LaunchRecentPlan {
  const ranges: BlockRange[] = [];
  const parts: string[] = [];

  if (deployBlock !== undefined && deployBlock > 0n && deployBlock <= head) {
    const launchTo = head < deployBlock + deployWindow - 1n ? head : deployBlock + deployWindow - 1n;
    ranges.push({ from: deployBlock, to: launchTo });
    parts.push(`Launch window (${deployBlock.toString()}–${launchTo.toString()})`);
  }

  const recentFrom = head >= recentWindow ? head - recentWindow + 1n : 0n;
  ranges.push({ from: recentFrom, to: head });
  parts.push(`latest ${recentWindow / 1000n}k blocks`);

  // This verified top-up belongs to the public live deployment only, not fork
  // or local networks that may use unrelated deployment histories.
  if (deployBlock === 3685765n && head >= 3758104n) {
    for (const block of pinnedBlocks) {
      if (block <= head) ranges.push({ from: block, to: block });
    }
  }

  ranges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const mergedRanges: BlockRange[] = [];
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.from <= previous.to) {
      if (range.to > previous.to) previous.to = range.to;
    } else {
      mergedRanges.push({ ...range });
    }
  }

  return { ranges: mergedRanges, label: parts.join(" + ") };
}

export interface RawLog {
  blockNumber?: bigint;
  logIndex?: number;
  transactionHash?: string;
  args?: Record<string, unknown>;
}

/**
 * Deduplicates logs by (transactionHash + logIndex) and sorts newest-first
 * (blockNumber desc, then logIndex desc).
 */
export function dedupeSortLogs<T extends RawLog>(logs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of logs) {
    const key = `${l.transactionHash ?? ""}:${l.logIndex ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  out.sort((a, b) => {
    const ab = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    if (ab === bb) return (b.logIndex ?? 0) - (a.logIndex ?? 0);
    return ab > bb ? -1 : 1;
  });
  return out;
}

export interface DiscoveredMandate {
  agent: string;
  label: string;
}

export interface DiscoveredPayee {
  payee: string;
  approved: boolean;
  label: string;
}

export interface DiscoveryResult {
  agents: DiscoveredMandate[];
  payees: DiscoveredPayee[];
  label: string;
}

/**
 * Discovers live on-chain agent mandates (PolicyUpdated) and payees
 * (PayeeUpdated) for a vault by scanning the launch window + recent window.
 * Returns addresses in event order (newest first); callers should verify live
 * status via getPolicy / getPayee before trusting them.
 */
export async function discoverVaultActors(
  client: PublicClient,
  vaultAddress: Address,
  vaultId: bigint,
  deployBlock: bigint | undefined,
): Promise<DiscoveryResult> {
  const head = await client.getBlockNumber();
  const plan = launchRecentPlan(deployBlock, head);

  const agents: DiscoveredMandate[] = [];
  const payees: DiscoveredPayee[] = [];

  const events = [
    { name: "PolicyUpdated", kind: "agent" },
    { name: "PayeeUpdated", kind: "payee" },
  ] as const;

  for (const ev of events) {
    const all: RawLog[] = [];
    for (const range of plan.ranges) {
      const logs = await getLogsChunked(client, {
        address: vaultAddress,
        event: getAbiItem({ abi: aevumGuardAbi, name: ev.name }) as AbiEvent,
        args: { vaultId },
        fromBlock: range.from,
        toBlock: range.to,
      });
      for (const l of logs) {
        all.push(l as RawLog);
      }
    }
    for (const l of dedupeSortLogs(all)) {
      const args = l.args ?? {};
      if (ev.kind === "agent") {
        const agent = String(args.agent ?? "");
        if (!agent || agent === "0x0000000000000000000000000000000000000000") continue;
        agents.push({ agent, label: String(args.label ?? "") });
      } else {
        const payee = String(args.payee ?? "");
        if (!payee || payee === "0x0000000000000000000000000000000000000000") continue;
        payees.push({
          payee,
          approved: Boolean(args.approved),
          label: String(args.label ?? ""),
        });
      }
    }
  }

  return { agents, payees, label: plan.label };
}