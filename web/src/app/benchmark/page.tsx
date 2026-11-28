import type { Metadata } from "next";
import { BenchmarkSuitePanel } from "@/components/BenchmarkSuitePanel";

export const metadata: Metadata = { title: "Security Benchmark" };

export default function BenchmarkPage() {
  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">ADVERSARIAL VERIFICATION &amp; CRYPTOGRAPHIC RECEIPTS</p>
          <h1>32-Scenario Policy Benchmark &amp; Audit Verifier</h1>
          <p className="lede">
            Every scenario executes AevumGuardVault&apos;s exact spend, Confirmation of Payee and EIP-712 rules in-browser — no wallet,
            no RPC, no mocks. Results are sealed into a hash-chained, EIP-712 signed receipt you can verify locally, right here, or
            with <code>pnpm verify:receipt</code>.
          </p>
        </div>
      </div>

      <BenchmarkSuitePanel />
    </main>
  );
}
