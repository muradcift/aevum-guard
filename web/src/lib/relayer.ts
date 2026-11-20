import { NextResponse } from "next/server";
import { isHex, type Hex } from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { aevumFork, isAnvilAccount, localAnvil } from "@aevum-kit/aevum";
import { defaultNetwork, networkByChainId, type Network } from "@/lib/env";

export const MAX_WINDOW_SECONDS = 3600n;
const PER_IP_PER_MINUTE = 15;
const PER_SIGNER_PER_MINUTE = 10;
const DAILY_TX_LIMIT = Number(process.env.RELAYER_DAILY_TX_LIMIT ?? 500);
const IN_FLIGHT_MS = 120_000;
const LOCAL_CHAINS = new Set<number>([localAnvil.id, aevumFork.id]);

let cachedAccount: PrivateKeyAccount | null | undefined;

export function getRelayerAccount(): PrivateKeyAccount | undefined {
  if (cachedAccount !== undefined) return cachedAccount ?? undefined;
  const raw = process.env.RELAYER_PRIVATE_KEY?.trim();
  const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
  cachedAccount = raw && isHex(key) && key.length === 66 ? privateKeyToAccount(key, { nonceManager }) : null;
  return cachedAccount ?? undefined;
}

/** Anvil's default keys are public and refused outside local chains. */
export function usableRelayer(account: PrivateKeyAccount | undefined, net: Network): PrivateKeyAccount | undefined {
  if (!account) return undefined;
  if (isAnvilAccount(account.address) && !LOCAL_CHAINS.has(net.chain.id)) return undefined;
  return account;
}

export function networkFor(chainId: unknown): Network | undefined {
  if (chainId === undefined || chainId === null || chainId === "") return defaultNetwork;
  return networkByChainId(Number(chainId));
}

const hits = new Map<string, number[]>();

export function isRateLimited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= 60_000)) hits.delete(k);
  }
  return recent.length > max;
}

export function checkIpOrSignerLimit(ip: string, signer: string): string | null {
  if (isRateLimited(`ip:${ip}`, PER_IP_PER_MINUTE)) return "Too many requests from this IP. Wait a minute.";
  if (isRateLimited(`signer:${signer.toLowerCase()}`, PER_SIGNER_PER_MINUTE)) {
    return "Too many relayed transactions for this address. Wait a minute.";
  }
  return null;
}

let day = "";
let sentToday = 0;

export function overDailyRelayerLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  return sentToday >= DAILY_TX_LIMIT;
}

export function recordRelayedTx(): void {
  sentToday++;
}

const inFlight = new Map<string, number>();

export function claimInFlight(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_MS) inFlight.delete(k);
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

export function releaseInFlight(key: string): void {
  inFlight.delete(key);
}

export function clientIp(req: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return req.headers.get(trusted)?.split(",")[0]?.trim() || "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export const isUintString = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);

export const failJson = (error: string, status = 400) => NextResponse.json({ error }, { status });
