"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BENCHMARK_SCENARIO_COUNT,
  runAdversarialBenchmark,
  verifyAuditReceipt,
  type AevumAuditReceipt,
  type BenchmarkCategory,
  type BenchmarkRunReport,
  type ReceiptVerificationResult,
} from "@aevum-kit/aevum";
import { loadOrCreateDemoAgent } from "@/lib/demoAgent";
import { useNetwork } from "@/lib/network";

const CATEGORIES: BenchmarkCategory[] = [
  "Prompt Injection & Rogue Payee",
  "Cap Overflow & 24h Escrow",
  "Split-Tx Salami Draining",
  "UTC Rollover & Mandate Lifecycle",
  "Emergency Controls & Solvency",
  "EIP-712 Signature & Replay Attacks",
  "Confirmation of Payee & Receipt Integrity",
];

type CategoryFilter = BenchmarkCategory | "all";

/** Human labels for the verifier checks emitted by `verifyAuditReceipt`. */
function checkLabel(name: string): string {
  if (name.startsWith("chain entry")) return "Entry Hash Chain";
  switch (name) {
    case "hash chain":
      return "Entry Hash Chain";
    case "chain root":
      return "Chain Root";
    case "payload hash":
      return "Payload Hash";
    case "receipt id":
      return "Receipt ID";
    case "attestation signature":
      return "EIP-712 Signer Recovery";
    case "attestation domain":
      return "EIP-712 Domain";
    case "receipt shape":
      return "Receipt Shape";
    default:
      return name;
  }
}

function verdictClass(verdict: string): string {
  if (verdict === "BLOCKED_REVERT" || verdict === "ERROR") return "bad";
  if (verdict === "ESCALATE_24H_ESCROW") return "warn";
  if (verdict === "PASS_INSTANT") return "good";
  return "info";
}

function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function BenchmarkSuitePanel() {
  const { net } = useNetwork();

  const [report, setReport] = useState<BenchmarkRunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  const [verifyInput, setVerifyInput] = useState("");
  const [verifyResult, setVerifyResult] = useState<ReceiptVerificationResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [simulatedTamper, setSimulatedTamper] = useState(false);

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const runSeqRef = useRef(0);
  const autoRunKeyRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const run = useCallback(async () => {
    const seq = runSeqRef.current + 1;
    runSeqRef.current = seq;
    setRunning(true);
    setRunError(null);
    try {
      const demoAccount = loadOrCreateDemoAgent();
      const next = await runAdversarialBenchmark({
        chainId: net.chain.id,
        verifyingContract: net.vault,
        auditorAccount: demoAccount ?? undefined,
      });
      if (runSeqRef.current !== seq) return;
      setReport(next);
      setActiveCategory("all");
      setSimulatedTamper(false);
      setVerifyInput(JSON.stringify(next.receipt, null, 2));
      setVerifyResult(next.receiptVerification);
      setVerifyError(null);
    } catch (error) {
      if (runSeqRef.current !== seq) return;
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (runSeqRef.current === seq) setRunning(false);
    }
  }, [net.chain.id, net.vault]);

  // Auto-run once per network so judges land on a live 32/32 result without
  // connecting a wallet. The ref also absorbs React Strict Mode's double effect.
  useEffect(() => {
    const key = `${net.chain.id}:${net.vault ?? ""}`;
    if (autoRunKeyRef.current === key) return;
    autoRunKeyRef.current = key;
    void run();
  }, [run, net.chain.id, net.vault]);

  async function copyReceipt() {
    if (!report) return;
    const text = JSON.stringify(report.receipt, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        // Clipboard access can be denied; the download button still works.
      }
      area.remove();
    }
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_800);
  }

  async function simulateTamper() {
    if (!report) return;
    const tampered = JSON.parse(JSON.stringify(report.receipt)) as AevumAuditReceipt;
    const target = tampered.entries.find((entry) => entry.id === "SC-01") ?? tampered.entries[0];
    if (target) target.outcome = "PASS_INSTANT";

    setVerifyInput(JSON.stringify(tampered, null, 2));
    setSimulatedTamper(true);
    setVerifyError(null);
    setVerifying(true);
    try {
      setVerifyResult(await verifyAuditReceipt(tampered));
    } finally {
      setVerifying(false);
    }
  }

  async function resetVerifier() {
    if (!report) return;
    setVerifyInput(JSON.stringify(report.receipt, null, 2));
    setSimulatedTamper(false);
    setVerifyError(null);
    setVerifying(true);
    try {
      setVerifyResult(await verifyAuditReceipt(report.receipt));
    } finally {
      setVerifying(false);
    }
  }

  async function verifyPastedReceipt() {
    setVerifyError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(verifyInput);
    } catch {
      setVerifyResult(null);
      setVerifyError("That is not valid JSON. Paste a complete AevumAuditReceipt object or upload a .json file.");
      return;
    }
    setSimulatedTamper(false);
    setVerifying(true);
    try {
      setVerifyResult(await verifyAuditReceipt(parsed));
    } finally {
      setVerifying(false);
    }
  }

  async function verifyUploadedFile(file: File | undefined) {
    if (!file) return;
    setVerifyError(null);
    try {
      const text = await file.text();
      setVerifyInput(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setVerifyResult(null);
        setVerifyError(`${file.name} is not valid JSON.`);
        return;
      }
      setSimulatedTamper(false);
      setVerifying(true);
      try {
        setVerifyResult(await verifyAuditReceipt(parsed));
      } finally {
        setVerifying(false);
      }
    } catch (error) {
      setVerifyResult(null);
      setVerifyError(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const results = report?.results ?? [];
  const filtered = results.filter((result) => activeCategory === "all" || result.category === activeCategory);
  const categoryCount = (category: BenchmarkCategory) => results.filter((result) => result.category === category).length;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Suite runner */}
      <section className="card">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div>
            <p className="eyebrow" style={{ marginBottom: 4 }}>
              In-Browser Adversarial Suite
            </p>
            <h2>Live Policy Enforcement Run</h2>
            <p className="fine" style={{ marginTop: 4 }}>
              No wallet or RPC required — the suite evaluates the vault&apos;s exact spend, CoP and EIP-712 rules locally.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => void run()} disabled={running}>
            {running ? "Running 32 Scenarios…" : "Re-run 32 Scenarios"}
          </button>
        </div>
        {runError && (
          <p className="fine" role="alert" style={{ marginTop: 12, color: "var(--bad)" }}>
            Benchmark failed: {runError}
          </p>
        )}
      </section>

      {/* Top metric strip */}
      <div className="summary-grid">
        <div className="metric-card">
          <span className="metric-label">Pass Rate</span>
          <span className="metric-value">{report ? `${report.passed} / ${report.total}` : "— / —"}</span>
          <span className="metric-sub">
            {report ? `${report.passRatePct}% · ${report.durationMs.toFixed(1)} ms` : "Auto-running on load…"}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Attacks Blocked</span>
          <span className="metric-value">{report ? report.countsByOutcome.blocked : "—"}</span>
          <span className="metric-sub">Hard on-chain / guardrail reverts</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">24h Escrow Escalations</span>
          <span className="metric-value">{report ? report.countsByOutcome.escalated : "—"}</span>
          <span className="metric-sub">Human approval gate triggered</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Signed Receipt</span>
          <span className="metric-value">
            {report ? (
              <span className={`status-pill ${report.receiptVerification.valid ? "good" : "bad"}`}>
                {report.receiptVerification.valid ? "VERIFIED" : "INVALID"}
              </span>
            ) : (
              <span className="status-pill info">PENDING</span>
            )}
          </span>
          <span className="metric-sub">EIP-712 + Hash Chain</span>
        </div>
      </div>

      {/* Signed receipt */}
      <section className="card stack" style={{ gap: 16 }}>
        <div>
          <h2>Signed Verifiable Audit Receipt</h2>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Every result is linked into a keccak256 hash chain and attested with EIP-712 secp256k1 by the auditor key.
          </p>
          {report && (
            <p className="fine" style={{ marginTop: 6 }}>
              Chain {report.chainId} · <code>{report.verifyingContract}</code> · {report.receipt.entries.length} chained entries ·{" "}
              {report.suiteVersion}
            </p>
          )}
        </div>

        {report ? (
          <>
            <dl className="kv">
              <dt>Receipt ID</dt>
              <dd>{report.receipt.receiptId}</dd>
              <dt>Chain Root</dt>
              <dd>{report.receipt.chainRoot}</dd>
              <dt>Payload Hash</dt>
              <dd>{report.receipt.payloadHash}</dd>
              <dt>Auditor Signer</dt>
              <dd>{report.receipt.attestation.signer}</dd>
              <dt>Scheme</dt>
              <dd>EIP-712-secp256k1</dd>
            </dl>

            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn small" onClick={() => downloadJsonFile("aevumguard-benchmark-receipt.json", report.receipt)}>
                Download Signed Receipt (.json)
              </button>
              <button type="button" className="btn small secondary" onClick={() => void copyReceipt()}>
                {copied ? "Copied" : "Copy Receipt JSON"}
              </button>
              <button type="button" className="btn small warn" onClick={() => void simulateTamper()} disabled={verifying}>
                Simulate 1-Byte Tamper
              </button>
              <button type="button" className="btn small secondary" onClick={() => void resetVerifier()} disabled={verifying}>
                Reset to Authentic Receipt
              </button>
            </div>
          </>
        ) : (
          <p className="fine">The signed receipt appears here as soon as the suite finishes…</p>
        )}
      </section>

      {/* Independent verifier */}
      <section className="card stack" style={{ gap: 14 }}>
        <div>
          <h2>Independent Receipt Verifier</h2>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Paste any <code>AevumAuditReceipt</code> JSON — from this benchmark, the on-chain audit export, or{" "}
            <code>pnpm benchmark --out receipt.json</code> — or upload a <code>.json</code> file.
          </p>
        </div>

        {simulatedTamper && (
          <div className="notice warn" role="status">
            <strong>Simulated 1-byte tamper loaded</strong>
            <span>
              SC-01 outcome was flipped from <code>BLOCKED_REVERT</code> to <code>PASS_INSTANT</code>. The entry hash and signature no
              longer match — the verifier below shows exactly where the chain breaks.
            </span>
          </div>
        )}

        <label className="field-label">
          <span>Receipt JSON</span>
          <textarea
            className="receipt-textarea"
            value={verifyInput}
            onChange={(event) => setVerifyInput(event.target.value)}
            spellCheck={false}
            aria-label="Audit receipt JSON"
            placeholder={'{ "schemaVersion": "aevum-audit-receipt/v1", ... }'}
          />
        </label>

        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <button
            type="button"
            className="btn small"
            onClick={() => void verifyPastedReceipt()}
            disabled={verifying || verifyInput.trim().length === 0}
          >
            {verifying ? "Verifying…" : "Verify Signature & Hash Chain"}
          </button>
          <label className="btn small secondary" style={{ cursor: "pointer" }}>
            Upload .json
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                void verifyUploadedFile(file);
                event.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              setVerifyInput("");
              setVerifyResult(null);
              setVerifyError(null);
              setSimulatedTamper(false);
            }}
          >
            Clear
          </button>
        </div>

        {verifyError && (
          <p className="fine" role="alert" style={{ color: "var(--bad)" }}>
            {verifyError}
          </p>
        )}

        {verifyResult && (
          <div className={`notice ${verifyResult.valid ? "good" : "bad"}`} role="status">
            <div className="row-between">
              <strong>
                {verifyResult.valid
                  ? "VERIFIED — signature and hash chain are authentic"
                  : "INVALID — receipt failed cryptographic verification"}
              </strong>
              <span className={`status-pill ${verifyResult.valid ? "good" : "bad"}`}>
                {verifyResult.valid ? "VERIFIED" : "INVALID"}
              </span>
            </div>
            {!verifyResult.valid && verifyResult.tamperReason && (
              <span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                {verifyResult.tamperReason}
              </span>
            )}
            {verifyResult.recoveredSigner && (
              <span className="fine" style={{ color: "inherit", overflowWrap: "anywhere" }}>
                Recovered signer: <code>{verifyResult.recoveredSigner}</code>
              </span>
            )}
          </div>
        )}

        {verifyResult && verifyResult.checks.length > 0 && (
          <ul className="verify-checks" aria-label="Cryptographic verification checks">
            {verifyResult.checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <span className={`status-pill ${check.passed ? "good" : "bad"}`}>{check.passed ? "PASS" : "FAIL"}</span>
                <strong>{checkLabel(check.name)}</strong>
                <span className="detail">{check.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Scenario breakdown */}
      <section className="card stack" style={{ gap: 14 }}>
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div>
            <h2>32-Scenario Breakdown</h2>
            <p className="sub" style={{ margin: "4px 0 0" }}>
              Each verdict maps to the exact contract revert or guardrail branch that stopped the attack.
            </p>
          </div>
          <span className="pill">
            {filtered.length} shown
          </span>
        </div>

        <div className="bench-filters" role="group" aria-label="Filter by benchmark category">
          <button
            type="button"
            className="bench-filter"
            aria-pressed={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
          >
            All <span className="count">({report ? results.length : BENCHMARK_SCENARIO_COUNT})</span>
          </button>
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className="bench-filter"
              aria-pressed={activeCategory === category}
              onClick={() => setActiveCategory(category)}
            >
              {category} <span className="count">({categoryCount(category)})</span>
            </button>
          ))}
        </div>

        {report ? (
          <div className="table-wrap bench-table-wrap" role="region" aria-label="Benchmark scenario results" tabIndex={0}>
            <table className="data bench-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Category</th>
                  <th>Scenario &amp; Attack Vector</th>
                  <th>Verdict</th>
                  <th>Contract / Guardrail Code</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((result) => (
                  <tr key={result.id}>
                    <td className="mono">{result.id}</td>
                    <td className="bench-category">{result.category}</td>
                    <td className="bench-scenario">
                      <strong>{result.title}</strong>
                      <span className="fine">{result.attackVector}</span>
                    </td>
                    <td>
                      <span className={`status-pill ${verdictClass(result.actualVerdict)}`}>{result.actualVerdict}</span>
                    </td>
                    <td className="bench-code">
                      <code>{result.actualError}</code>
                    </td>
                    <td>
                      <span className={`status-pill ${result.passed ? "good" : "bad"}`}>{result.passed ? "PASS" : "FAIL"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="fine">Running all 32 scenarios…</p>
        )}
      </section>
    </div>
  );
}
