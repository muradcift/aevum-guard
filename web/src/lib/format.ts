import { formatUnits, keccak256, parseUnits, stringToHex, toHex, type Hex } from "viem";
import { TUSD8_DECIMALS } from "@aevum-kit/aevum";

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function formatToken(amount: bigint | undefined, decimals = TUSD8_DECIMALS): string {
  if (amount === undefined) return "—";
  const num = Number(formatUnits(amount, decimals));
  return Number.isFinite(num)
    ? num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : formatUnits(amount, decimals);
}

export function safeParseUnits(value: string, decimals = TUSD8_DECIMALS): bigint | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

export function randomBytes32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return keccak256(toHex(bytes));
}

export function refToBytes32(input: string): Hex {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as Hex;
  if (!trimmed) return randomBytes32();
  return keccak256(stringToHex(trimmed));
}

export function formatTimeRemaining(unixSeconds: bigint): string {
  const diff = Number(unixSeconds) - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Expired";
  const hrs = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (hrs > 24) return `${Math.floor(hrs / 24)}d ${hrs % 24}h left`;
  if (hrs > 0) return `${hrs}h ${mins}m left`;
  return `${mins}m left`;
}
