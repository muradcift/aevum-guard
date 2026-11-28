import {
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Tamper-evident, EIP-712-signed audit receipts.
 *
 * Every entry is linked into a keccak256 hash chain (`prevHash` -> `entryHash`) and the whole
 * chain (plus the receipt metadata) is committed to with a `payloadHash`, a `receiptId` and an
 * EIP-712 `secp256k1` attestation. Only `viem` is used, so the same code runs in the browser,
 * in Next.js server components and in Node CLI tooling.
 */

export const AUDIT_RECEIPT_SCHEMA = "aevum-audit-receipt/v1" as const;

export type AuditReceiptKind = "BENCHMARK_REPORT" | "SPEND_DECISION" | "ONCHAIN_AUDIT_SNAPSHOT";

export const AUDIT_RECEIPT_KINDS: readonly AuditReceiptKind[] = [
  "BENCHMARK_REPORT",
  "SPEND_DECISION",
  "ONCHAIN_AUDIT_SNAPSHOT",
];

/** Genesis `prevHash` of every audit chain. */
export const AUDIT_RECEIPT_GENESIS_HASH: Hex = `0x${"0".repeat(64)}`;

/** EIP-712 domain name/version used to attest audit receipts. */
export const AUDIT_RECEIPT_DOMAIN_NAME = "AevumGuardAudit" as const;
export const AUDIT_RECEIPT_DOMAIN_VERSION = "1" as const;
export const AUDIT_RECEIPT_PRIMARY_TYPE = "AuditReceiptAttestation" as const;

export const AUDIT_RECEIPT_TYPES = {
  AuditReceiptAttestation: [
    { name: "schemaVersion", type: "string" },
    { name: "receiptId", type: "bytes32" },
    { name: "kind", type: "string" },
    { name: "vaultId", type: "string" },
    { name: "issuedAt", type: "string" },
    { name: "entryCount", type: "uint256" },
    { name: "chainRoot", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
  ],
} as const;

export function buildAuditReceiptDomain(chainId: number, verifyingContract: Address) {
  return {
    name: AUDIT_RECEIPT_DOMAIN_NAME,
    version: AUDIT_RECEIPT_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

export interface AuditChainEntryInput {
  seq: number;
  id: string;
  category: string;
  action: string;
  outcome: string;
  detail: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AuditChainEntry extends AuditChainEntryInput {
  prevHash: Hex;
  entryHash: Hex;
}

export interface AevumAuditReceipt {
  schemaVersion: "aevum-audit-receipt/v1";
  receiptId: Hex;
  kind: AuditReceiptKind;
  issuedAt: string;
  chainId: number;
  verifyingContract: Address;
  vaultId: string;
  summary: Record<string, string | number | boolean>;
  entries: AuditChainEntry[];
  chainRoot: Hex;
  payloadHash: Hex;
  attestation: {
    scheme: "EIP-712-secp256k1";
    signer: Address;
    signature: Hex;
    domain: {
      name: "AevumGuardAudit";
      version: "1";
      chainId: number;
      verifyingContract: Address;
    };
  };
}

export interface ReceiptVerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  checks: ReceiptVerificationCheck[];
  recoveredSigner: Address | null;
  computedChainRoot: Hex | null;
  computedPayloadHash: Hex | null;
  tamperReason?: string;
}

export interface CreateAuditReceiptParams {
  kind: AuditReceiptKind;
  chainId: number;
  verifyingContract: Address;
  vaultId: string;
  summary: Record<string, string | number | boolean>;
  entries: AuditChainEntryInput[];
  signerAccount: PrivateKeyAccount;
  /** ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  issuedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      sorted[key] = normalizeForCanonicalJson(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON: object keys are sorted recursively and `bigint` values become decimal
 * strings, so two logically identical payloads always hash to the same digest.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value)) ?? "null";
}

function hashCanonical(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

function pickEntryInput(entry: AuditChainEntryInput): AuditChainEntryInput {
  return {
    seq: entry.seq,
    id: entry.id,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    detail: entry.detail,
    metadata: entry.metadata,
  };
}

function pickStoredEntry(entry: unknown): AuditChainEntryInput | null {
  if (!isRecord(entry)) return null;
  const { seq, id, category, action, outcome, detail, metadata } = entry;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof id !== "string") return null;
  if (typeof category !== "string") return null;
  if (typeof action !== "string") return null;
  if (typeof outcome !== "string") return null;
  if (typeof detail !== "string") return null;

  let normalizedMetadata: Record<string, string | number | boolean> | undefined;
  if (metadata !== undefined) {
    if (!isRecord(metadata)) return null;
    normalizedMetadata = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return null;
      }
      normalizedMetadata[key] = value;
    }
  }

  return {
    seq,
    id,
    category,
    action,
    outcome,
    detail,
    metadata: normalizedMetadata,
  };
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHexSignature(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{2,}$/.test(value);
}

function isSummary(value: unknown): value is Record<string, string | number | boolean> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)),
  );
}

function payloadHashInput(receipt: {
  schemaVersion: string;
  kind: string;
  issuedAt: string;
  chainId: number;
  verifyingContract: string;
  vaultId: string;
  summary: unknown;
  entries: unknown;
  chainRoot: string;
}): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    issuedAt: receipt.issuedAt,
    chainId: receipt.chainId,
    verifyingContract: receipt.verifyingContract,
    vaultId: receipt.vaultId,
    summary: receipt.summary,
    entries: receipt.entries,
    chainRoot: receipt.chainRoot,
  };
}

function receiptIdInput(receipt: {
  schemaVersion: string;
  kind: string;
  chainId: number;
  verifyingContract: string;
  vaultId: string;
  issuedAt: string;
  payloadHash: string;
}): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    chainId: receipt.chainId,
    verifyingContract: receipt.verifyingContract,
    vaultId: receipt.vaultId,
    issuedAt: receipt.issuedAt,
    payloadHash: receipt.payloadHash,
  };
}

/**
 * Build and sign a tamper-evident audit receipt.
 *
 * The signer is normally a deterministic benchmark auditor or an operator key; the private key
 * never leaves `signerAccount` and is never embedded in the receipt.
 */
export async function createAuditReceipt(params: CreateAuditReceiptParams): Promise<AevumAuditReceipt> {
  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const { kind, chainId, verifyingContract, vaultId, summary } = params;

  const entries: AuditChainEntry[] = [];
  let prevHash: Hex = AUDIT_RECEIPT_GENESIS_HASH;

  for (const rawEntry of params.entries) {
    const entryInput = pickEntryInput(rawEntry);
    const entryHash = hashCanonical({ ...entryInput, prevHash });
    entries.push({ ...entryInput, prevHash, entryHash });
    prevHash = entryHash;
  }

  const chainRoot: Hex = entries.length > 0 ? entries[entries.length - 1]!.entryHash : AUDIT_RECEIPT_GENESIS_HASH;

  const payloadHash = hashCanonical(
    payloadHashInput({
      schemaVersion: AUDIT_RECEIPT_SCHEMA,
      kind,
      issuedAt,
      chainId,
      verifyingContract,
      vaultId,
      summary,
      entries,
      chainRoot,
    }),
  );

  const receiptId = hashCanonical(
    receiptIdInput({
      schemaVersion: AUDIT_RECEIPT_SCHEMA,
      kind,
      chainId,
      verifyingContract,
      vaultId,
      issuedAt,
      payloadHash,
    }),
  );

  const domain = buildAuditReceiptDomain(chainId, verifyingContract);

  const signature = await params.signerAccount.signTypedData({
    domain,
    types: AUDIT_RECEIPT_TYPES,
    primaryType: AUDIT_RECEIPT_PRIMARY_TYPE,
    message: {
      schemaVersion: AUDIT_RECEIPT_SCHEMA,
      receiptId,
      kind,
      vaultId,
      issuedAt,
      entryCount: BigInt(entries.length),
      chainRoot,
      payloadHash,
    },
  });

  return {
    schemaVersion: AUDIT_RECEIPT_SCHEMA,
    receiptId,
    kind,
    issuedAt,
    chainId,
    verifyingContract,
    vaultId,
    summary,
    entries,
    chainRoot,
    payloadHash,
    attestation: {
      scheme: "EIP-712-secp256k1",
      signer: params.signerAccount.address,
      signature,
      domain: {
        name: AUDIT_RECEIPT_DOMAIN_NAME,
        version: AUDIT_RECEIPT_DOMAIN_VERSION,
        chainId,
        verifyingContract,
      },
    },
  };
}

/**
 * Independently verify an audit receipt. Never throws: malformed JSON, junk values and truncated
 * chains all come back as `{ valid: false }` with a human-readable `tamperReason`.
 */
export async function verifyAuditReceipt(receipt: unknown): Promise<ReceiptVerificationResult> {
  const checks: ReceiptVerificationCheck[] = [];
  let recoveredSigner: Address | null = null;
  let computedChainRoot: Hex | null = null;
  let computedPayloadHash: Hex | null = null;

  const fail = (name: string, detail: string): ReceiptVerificationResult => {
    checks.push({ name, passed: false, detail });
    return {
      valid: false,
      checks,
      recoveredSigner,
      computedChainRoot,
      computedPayloadHash,
      tamperReason: `${name}: ${detail}`,
    };
  };

  const ok = (name: string, detail: string): void => {
    checks.push({ name, passed: true, detail });
  };

  try {
    if (!isRecord(receipt)) return fail("receipt shape", "Receipt must be a JSON object.");

    const {
      schemaVersion,
      receiptId,
      kind,
      issuedAt,
      chainId,
      verifyingContract,
      vaultId,
      summary,
      entries,
      chainRoot,
      payloadHash,
      attestation,
    } = receipt;

    if (schemaVersion !== AUDIT_RECEIPT_SCHEMA) {
      return fail("schema version", `Expected ${AUDIT_RECEIPT_SCHEMA}, got ${String(schemaVersion)}.`);
    }
    if (typeof kind !== "string" || !AUDIT_RECEIPT_KINDS.includes(kind as AuditReceiptKind)) {
      return fail("receipt kind", `Unknown receipt kind ${String(kind)}.`);
    }
    if (typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))) {
      return fail("issuedAt", "issuedAt must be an ISO-8601 timestamp.");
    }
    if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
      return fail("chainId", "chainId must be a positive integer.");
    }
    if (typeof verifyingContract !== "string" || !isAddress(verifyingContract)) {
      return fail("verifyingContract", "verifyingContract must be a valid EVM address.");
    }
    if (typeof vaultId !== "string" || vaultId.length === 0) {
      return fail("vaultId", "vaultId must be a non-empty string.");
    }
    if (!isSummary(summary)) {
      return fail("summary", "summary must map keys to string, number or boolean values.");
    }
    if (!isHex32(receiptId)) return fail("receiptId", "receiptId must be a 32-byte hex digest.");
    if (!isHex32(chainRoot)) return fail("chainRoot", "chainRoot must be a 32-byte hex digest.");
    if (!isHex32(payloadHash)) return fail("payloadHash", "payloadHash must be a 32-byte hex digest.");
    if (!Array.isArray(entries)) return fail("entries", "entries must be an array.");

    ok("receipt shape", `${kind} receipt for vault ${vaultId}`);

    // 1. Walk and recompute the hash chain entry by entry.
    let expectedPrevHash: Hex = AUDIT_RECEIPT_GENESIS_HASH;
    let lastEntryHash: Hex = AUDIT_RECEIPT_GENESIS_HASH;

    for (let index = 0; index < entries.length; index += 1) {
      const name = `chain entry ${String(index + 1).padStart(2, "0")}`;
      const stored = entries[index];
      if (!isRecord(stored)) return fail(name, "Entry is not an object.");

      const entryInput = pickStoredEntry(stored);
      if (!entryInput) return fail(name, "Entry is missing required fields or has invalid types.");

      if (typeof stored.prevHash !== "string" || stored.prevHash.toLowerCase() !== expectedPrevHash.toLowerCase()) {
        return fail(
          name,
          `prevHash ${String(stored.prevHash)} does not link to expected ${expectedPrevHash}.`,
        );
      }

      const recomputed = hashCanonical({ ...entryInput, prevHash: expectedPrevHash });
      if (typeof stored.entryHash !== "string" || stored.entryHash.toLowerCase() !== recomputed.toLowerCase()) {
        return fail(name, `entryHash ${String(stored.entryHash)} does not match recomputed ${recomputed}.`);
      }

      lastEntryHash = recomputed;
      expectedPrevHash = recomputed;
    }

    computedChainRoot = lastEntryHash;
    ok("hash chain", `${entries.length} entries linked from the genesis hash`);

    if (chainRoot.toLowerCase() !== computedChainRoot.toLowerCase()) {
      return fail(
        "chain root",
        `Stored chainRoot ${chainRoot} does not match recomputed ${computedChainRoot}.`,
      );
    }
    ok("chain root", computedChainRoot);

    // 2. Recompute the payload commitment over the exact stored metadata and entries.
    computedPayloadHash = hashCanonical(
      payloadHashInput({
        schemaVersion,
        kind,
        issuedAt,
        chainId,
        verifyingContract,
        vaultId,
        summary,
        entries,
        chainRoot,
      }),
    );
    if (payloadHash.toLowerCase() !== computedPayloadHash.toLowerCase()) {
      return fail(
        "payload hash",
        `Stored payloadHash ${payloadHash} does not match recomputed ${computedPayloadHash}.`,
      );
    }
    ok("payload hash", computedPayloadHash);

    // 3. Recompute the receipt id from the verified payload commitment.
    const computedReceiptId = hashCanonical(
      receiptIdInput({
        schemaVersion,
        kind,
        chainId,
        verifyingContract,
        vaultId,
        issuedAt,
        payloadHash: computedPayloadHash,
      }),
    );
    if (receiptId.toLowerCase() !== computedReceiptId.toLowerCase()) {
      return fail("receipt id", `Stored receiptId ${receiptId} does not match recomputed ${computedReceiptId}.`);
    }
    ok("receipt id", computedReceiptId);

    // 4. Validate the attestation envelope.
    if (!isRecord(attestation)) return fail("attestation", "attestation must be an object.");
    if (attestation.scheme !== "EIP-712-secp256k1") {
      return fail("attestation scheme", `Unsupported scheme ${String(attestation.scheme)}.`);
    }
    if (typeof attestation.signer !== "string" || !isAddress(attestation.signer)) {
      return fail("attestation signer", "signer must be a valid EVM address.");
    }
    if (!isHexSignature(attestation.signature)) {
      return fail("attestation signature", "signature must be 0x-prefixed hex.");
    }
    if (!isRecord(attestation.domain)) return fail("attestation domain", "domain must be an object.");
    if (
      attestation.domain.name !== AUDIT_RECEIPT_DOMAIN_NAME ||
      attestation.domain.version !== AUDIT_RECEIPT_DOMAIN_VERSION ||
      attestation.domain.chainId !== chainId ||
      typeof attestation.domain.verifyingContract !== "string" ||
      attestation.domain.verifyingContract.toLowerCase() !== verifyingContract.toLowerCase()
    ) {
      return fail("attestation domain", "Attestation domain does not match the receipt domain.");
    }
    ok("attestation domain", `${AUDIT_RECEIPT_DOMAIN_NAME} v${AUDIT_RECEIPT_DOMAIN_VERSION} on chain ${chainId}`);

    // 5. Recover the signer from the EIP-712 attestation.
    try {
      recoveredSigner = await recoverTypedDataAddress({
        domain: buildAuditReceiptDomain(chainId, verifyingContract as Address),
        types: AUDIT_RECEIPT_TYPES,
        primaryType: AUDIT_RECEIPT_PRIMARY_TYPE,
        message: {
          schemaVersion: AUDIT_RECEIPT_SCHEMA,
          receiptId: receiptId as Hex,
          kind,
          vaultId,
          issuedAt,
          entryCount: BigInt(entries.length),
          chainRoot: chainRoot as Hex,
          payloadHash: payloadHash as Hex,
        },
        signature: attestation.signature,
      });
    } catch (error) {
      return fail("attestation signature", `EIP-712 recovery failed: ${describeError(error)}.`);
    }

    if (recoveredSigner.toLowerCase() !== attestation.signer.toLowerCase()) {
      return fail(
        "attestation signature",
        `Recovered signer ${recoveredSigner} does not match declared signer ${attestation.signer}.`,
      );
    }
    ok("attestation signature", `Recovered ${recoveredSigner}`);

    return {
      valid: checks.every((check) => check.passed),
      checks,
      recoveredSigner,
      computedChainRoot,
      computedPayloadHash,
    };
  } catch (error) {
    return {
      valid: false,
      checks,
      recoveredSigner,
      computedChainRoot,
      computedPayloadHash,
      tamperReason: `Malformed receipt: ${describeError(error)}.`,
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
