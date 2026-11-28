import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyAuditReceipt, type ReceiptVerificationResult } from "@aevum-kit/aevum";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "n/a";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key]);
}

function printResult(receipt: Record<string, unknown>, result: ReceiptVerificationResult, file: string): void {
  const attestation = asRecordField(receipt, "attestation");
  const out = (line: string) => process.stdout.write(`${line}\n`);

  out("AevumGuard Signed Audit Receipt Verification");
  out(`  File: ${file}`);
  out("");
  out("Verification checks:");
  for (const check of result.checks) {
    out(`  [${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  out("");
  out("Receipt details:");
  out(`  Receipt ID:         ${field(receipt, "receiptId")}`);
  out(`  Kind:               ${field(receipt, "kind")}`);
  out(`  Chain ID:           ${field(receipt, "chainId")}`);
  out(`  Verifying Contract: ${field(receipt, "verifyingContract")}`);
  out(`  Recovered Signer:   ${result.recoveredSigner ?? field(attestation, "signer")}`);
  out(`  Chain Root:         ${result.computedChainRoot ?? field(receipt, "chainRoot")}`);
  out(`  Payload Hash:       ${result.computedPayloadHash ?? field(receipt, "payloadHash")}`);
  out("");
  out(result.valid ? "Verdict: VERIFIED" : `Verdict: INVALID / TAMPERED: ${result.tamperReason ?? "verification failed"}`);
}

async function main(): Promise<void> {
  // pnpm may forward the `--` separator; strip it regardless of where it appears.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const input = args[0];
  if (!input) {
    process.stderr.write("Usage: pnpm verify:receipt <path-to-receipt.json>\n");
    process.exitCode = 1;
    return;
  }

  const file = resolve(input);
  const text = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${describeError(error)}`);
  }

  const result = await verifyAuditReceipt(parsed);
  printResult(asRecord(parsed), result, file);
  process.exitCode = result.valid ? 0 : 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nFAIL · ${describeError(error)}\n`);
  process.exitCode = 1;
}
