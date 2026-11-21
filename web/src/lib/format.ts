import { formatUnits, isAddress, keccak256, parseUnits, stringToHex, toHex, type Hex } from "viem";
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

/** Plain machine-parseable amount for prefilling an <input> (no thousands separators). */
export function formatAmountInput(amount: bigint, decimals = TUSD8_DECIMALS): string {
  const text = formatUnits(amount, decimals);
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

const MAX_UINT256 = (1n << 256n) - 1n;

export type AmountError =
  | { code: "empty"; message: string }
  | { code: "negative"; message: string }
  | { code: "invalid"; message: string }
  | { code: "zero"; message: string }
  | { code: "too-large"; message: string };

export type AmountParse = { ok: true; value: bigint } | ({ ok: false } & AmountError);

/**
 * Strict user-amount parser. Never throws and never returns NaN/Infinity, so
 * "0", "-1", "abc", "1e9", "0.1.2", "" and 100-digit values all produce a
 * clean, specific message instead of a raw viem/revert stack trace.
 */
export function parseAmountInput(value: string, decimals = TUSD8_DECIMALS): AmountParse {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, code: "empty", message: "Enter an amount first." };
  if (trimmed.startsWith("-")) return { ok: false, code: "negative", message: "Amount cannot be negative." };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, code: "invalid", message: "Enter a valid number, e.g. 1.50." };
  }
  let parsed: bigint;
  try {
    parsed = parseUnits(trimmed, decimals);
  } catch {
    return {
      ok: false,
      code: "invalid",
      message: `Use at most ${decimals} decimal places.`,
    };
  }
  if (parsed <= 0n) return { ok: false, code: "zero", message: "Amount must be greater than zero." };
  if (parsed > MAX_UINT256) return { ok: false, code: "too-large", message: "That amount is too large." };
  return { ok: true, value: parsed };
}

export function safeParseUnits(value: string, decimals = TUSD8_DECIMALS): bigint | null {
  const parsed = parseAmountInput(value, decimals);
  return parsed.ok ? parsed.value : null;
}

const ZERO_ADDRESS_RE = /^0x0{40}$/i;

/** Clean recipient-address validation shared by every spend/withdraw form. */
export function recipientError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a recipient address (0x…).";
  if (!isAddress(trimmed)) return "Enter a valid recipient address (0x + 40 hex characters).";
  if (ZERO_ADDRESS_RE.test(trimmed)) return "Recipient cannot be the zero address.";
  return null;
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

/**
 * Human countdown. Never renders "0m left" or negative values: sub-minute
 * remainders read "<1m left" and anything past its deadline reads "Expired".
 */
export function formatTimeRemaining(unixSeconds: bigint, nowMs = Date.now()): string {
  const diff = Number(unixSeconds) - Math.floor(nowMs / 1000);
  if (!Number.isFinite(diff) || diff <= 0) return "Expired";
  if (diff < 60) return "<1m left";
  const totalMins = Math.floor(diff / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 24) {
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days}d ${remHrs}h left` : `${days}d left`;
  }
  if (hrs > 0) return `${hrs}h ${mins}m left`;
  return `${mins}m left`;
}

/** "Expired 12m ago" / "expires in 3h 5m" for TTL badges. */
export function formatExpiry(expiresAt: bigint, nowMs = Date.now()): { expired: boolean; text: string } {
  const diff = Number(expiresAt) - Math.floor(nowMs / 1000);
  if (!Number.isFinite(diff)) return { expired: false, text: "No expiry" };
  if (diff <= 0) {
    const ago = Math.abs(diff);
    if (ago < 60) return { expired: true, text: "Expired just now" };
    const mins = Math.floor(ago / 60);
    if (mins < 60) return { expired: true, text: `Expired ${mins}m ago` };
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return { expired: true, text: `Expired ${hrs}h ago` };
    return { expired: true, text: `Expired ${Math.floor(hrs / 24)}d ago` };
  }
  return { expired: false, text: formatTimeRemaining(expiresAt, nowMs) };
}
