import type { Metadata } from "next";
import { links, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { GitHubIcon } from "@/components/Icons";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = { title: "Architecture & Docs" };

const HACKATHON_URL = "https://dorahacks.io/hackathon/qday/detail";
const DISCORD_URL = "https://discord.gg/bYPhjmrSfK";

function Code({ children }: { children: string }) {
  return (
    <pre className="code">
      <code>{children.trim()}</code>
    </pre>
  );
}

export default function DocsPage() {
  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Documentation</p>
          <h1>AevumGuard Architecture</h1>
          <p className="lede">
            Bounded on-chain stablecoin treasury for AI agents and teams on QDay Aevum Testnet (Chain 44005, Shanghai EVM).
          </p>
        </div>
        <a className="btn secondary" href={repoUrl} target="_blank" rel="noreferrer">
          <GitHubIcon />
          Source on GitHub
        </a>
      </div>

      <div className="docs">
        <nav className="docs-toc" aria-label="On this page">
          <p className="docs-toc-title">On this page</p>
          <a href="#problem">Problem &amp; Controls</a>
          <a href="#architecture">Execution Flow</a>
          <a href="#aevum">Aevum Compliance</a>
          <a href="#quickstart">Local &amp; Fork Setup</a>
          <a href="#tokens">Get Testnet Tokens</a>
          <a href="#credits">Credits &amp; License</a>
        </nav>

        <article className="docs-body">
          <section id="problem">
            <h2>1. Why AevumGuard?</h2>
            <p>
              Giving an AI assistant raw wallet access creates unacceptable blast radius: prompt injections, looping tool calls, or a single
              typo in a recipient address can drain the entire balance. <strong>AevumGuardVault</strong> solves this on-chain with six
              enforced controls:
            </p>
            <ul>
              <li>
                <strong>Per-Transaction &amp; Daily Rolling Limits:</strong> Spends within limits settle instantly; daily usage automatically
                resets at UTC day boundaries.
              </li>
              <li>
                <strong>Hard Lifetime Total Budget:</strong> Caps total cumulative outflow across autonomous spends and human-approved
                overrides.
              </li>
              <li>
                <strong>Confirmation of Payee (Allowlist):</strong> Cryptographically binds human-readable vendor labels to verified
                addresses (<code>keccak256(abi.encodePacked(label, payee))</code>). Unverified destinations revert deterministically.
              </li>
              <li>
                <strong>Human-in-the-Loop Escalation Queue:</strong> Over-limit requests reserve funds in escrow for 24h (<code>Pending</code>) so the
                owner can <code>approveRequest</code> or <code>rejectRequest</code> with 1 click.
              </li>
              <li>
                <strong>Gasless EIP-3009 &amp; EIP-712 Relays:</strong> Owners fund vaults gaslessly via <code>tUSD8</code>{" "}
                <code>receiveWithAuthorization</code>; AI agents sign off-chain <code>SpendIntent</code> messages without holding{" "}
                <code>tQDAY</code> gas.
              </li>
              <li>
                <strong>Non-Custodial Kill-Switch:</strong> <code>setVaultPaused</code> freezes all agent spending and approvals immediately
                while explicitly keeping owner <code>withdraw</code> and <code>rejectRequest</code> active so funds are never trapped.
              </li>
            </ul>
          </section>

          <section id="architecture">
            <h2>2. On-Chain Execution Flow</h2>
            <div className="flow-diagram">
              <svg
                viewBox="0 0 760 510"
                role="img"
                aria-label="Execution flow: Owner Wallet funds and governs AevumGuardVault via EIP-3009 or Approve. In parallel, AI Agent signs an EIP-712 SpendIntent sent to /api/relay-spend, which invokes executeSpendWithSignature() on AevumGuardVault. Inside the vault, three on-chain guardrail checks run: not paused and mandate active and not expired, Confirmation of Payee allowlist verification, and total lifetime hard cap and vault liquidity. Spends within per-transaction and daily limits execute an instant tUSD8 transfer emitting SpendExecuted; over-limit spends create an escrowed SpendRequest with a 24 hour TTL for the owner to approve or reject and refund."
              >
                <defs>
                  <marker
                    id="flow-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="8"
                    markerHeight="8"
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path d="M 0.5 1 L 7.5 4 L 0.5 7 z" fill="var(--text-faint)" />
                  </marker>
                  <clipPath id="vault-clip">
                    <rect x="100" y="152" width="560" height="168" rx="12" />
                  </clipPath>
                </defs>

                {/* Top Layer — Left Lane: Funding Path */}
                <rect x="58" y="20" width="168" height="56" rx="10" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.25" />
                <text x="142" y="42" textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontSize="13" fontWeight="600">
                  Owner Wallet
                </text>
                <text x="142" y="60" textAnchor="middle" fill="var(--text-muted)" fontFamily="var(--font-body)" fontSize="11">
                  Funds &amp; governs vault
                </text>

                {/* Top Layer — Right Lane: Gasless Agent Execution Path */}
                <rect x="254" y="20" width="180" height="56" rx="10" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.25" />
                <text x="344" y="42" textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontSize="13" fontWeight="600">
                  AI Agent
                </text>
                <text x="344" y="60" textAnchor="middle" fill="var(--text-muted)" fontFamily="var(--font-body)" fontSize="11">
                  Signs EIP-712 SpendIntent
                </text>

                <line x1="434" y1="48" x2="526" y2="48" stroke="var(--text-faint)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />
                <text x="481" y="37" textAnchor="middle" fill="var(--text-muted)" fontFamily="var(--font-mono)" fontSize="11">
                  SpendIntent
                </text>

                <rect x="528" y="20" width="180" height="56" rx="10" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.25" />
                <text x="618" y="42" textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontSize="13" fontWeight="600">
                  /api/relay-spend
                </text>
                <text x="618" y="60" textAnchor="middle" fill="var(--text-muted)" fontFamily="var(--font-body)" fontSize="11">
                  Stateless gas relayer
                </text>

                {/* Vertical Connectors into AevumGuardVault */}
                <line x1="142" y1="76" x2="142" y2="150" stroke="var(--text-faint)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />
                <rect x="65" y="102" width="154" height="24" rx="12" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1" />
                <text x="142" y="114" dy="0.35em" textAnchor="middle" fill="var(--text-2)" fontFamily="var(--font-mono)" fontSize="11">
                  EIP-3009 / Approve
                </text>

                <line x1="618" y1="76" x2="618" y2="150" stroke="var(--text-faint)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />
                <rect x="510" y="102" width="216" height="24" rx="12" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1" />
                <text x="618" y="114" dy="0.35em" textAnchor="middle" fill="var(--text-2)" fontFamily="var(--font-mono)" fontSize="11">
                  executeSpendWithSignature()
                </text>

                {/* Middle Layer — AevumGuardVault Container */}
                <rect x="100" y="152" width="560" height="168" rx="12" fill="var(--accent-soft)" />
                <g clipPath="url(#vault-clip)">
                  <rect x="100" y="152" width="560" height="38" fill="var(--surface-info)" />
                  <line x1="100" y1="190" x2="660" y2="190" stroke="var(--line-info)" strokeWidth="1" />
                </g>
                <rect x="100" y="152" width="560" height="168" rx="12" fill="none" stroke="var(--accent)" strokeWidth="1.5" />

                <text x="380" y="171" dy="0.35em" textAnchor="middle">
                  <tspan fill="var(--accent-text)" fontFamily="var(--font-mono)" fontSize="12.5" fontWeight="700">
                    AevumGuardVault
                  </tspan>
                  <tspan fill="var(--text-muted)" fontFamily="var(--font-body)" fontSize="12" fontWeight="500">
                    {"  ·  tUSD8 Treasury  ·  On-Chain Guardrail Checks"}
                  </tspan>
                </text>

                {/* Guardrail Check Rows */}
                <rect x="120" y="202" width="520" height="30" rx="7" fill="var(--bg)" stroke="var(--line-info)" strokeWidth="1" />
                <circle cx="139" cy="217" r="9" fill="var(--accent-soft)" stroke="var(--line-info)" strokeWidth="1" />
                <text x="139" y="217" dy="0.35em" textAnchor="middle" fill="var(--accent-text)" fontFamily="var(--font-mono)" fontSize="10.5" fontWeight="600">
                  1
                </text>
                <text x="158" y="217" dy="0.35em" fill="var(--text)" fontFamily="var(--font-mono)" fontSize="12">
                  !paused &amp; mandate active &amp; !expired
                </text>

                <rect x="120" y="240" width="520" height="30" rx="7" fill="var(--bg)" stroke="var(--line-info)" strokeWidth="1" />
                <circle cx="139" cy="255" r="9" fill="var(--accent-soft)" stroke="var(--line-info)" strokeWidth="1" />
                <text x="139" y="255" dy="0.35em" textAnchor="middle" fill="var(--accent-text)" fontFamily="var(--font-mono)" fontSize="10.5" fontWeight="600">
                  2
                </text>
                <text x="158" y="255" dy="0.35em" fill="var(--text-2)" fontFamily="var(--font-body)" fontSize="12.5">
                  Confirmation of Payee allowlist verification
                </text>

                <rect x="120" y="278" width="520" height="30" rx="7" fill="var(--bg)" stroke="var(--line-info)" strokeWidth="1" />
                <circle cx="139" cy="293" r="9" fill="var(--accent-soft)" stroke="var(--line-info)" strokeWidth="1" />
                <text x="139" y="293" dy="0.35em" textAnchor="middle" fill="var(--accent-text)" fontFamily="var(--font-mono)" fontSize="10.5" fontWeight="600">
                  3
                </text>
                <text x="158" y="293" dy="0.35em" fill="var(--text-2)" fontFamily="var(--font-body)" fontSize="12.5">
                  Total lifetime hard cap &amp; vault liquidity
                </text>

                {/* Bottom Layer — Orthogonal T-Branch */}
                <path
                  d="M 380 320 V 344 H 195 V 368"
                  fill="none"
                  stroke="var(--text-faint)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  markerEnd="url(#flow-arrow)"
                />
                <path
                  d="M 380 344 H 565 V 368"
                  fill="none"
                  stroke="var(--text-faint)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  markerEnd="url(#flow-arrow)"
                />

                {/* Left Branch: Within Per-Tx & Daily */}
                <rect x="107" y="370" width="176" height="26" rx="13" fill="var(--good-chip)" stroke="var(--good-line)" strokeWidth="1" />
                <text x="195" y="383" dy="0.35em" textAnchor="middle" fill="var(--good)" fontFamily="var(--font-body)" fontSize="11.5" fontWeight="600">
                  Within Per-Tx &amp; Daily
                </text>

                <line x1="195" y1="396" x2="195" y2="420" stroke="var(--text-faint)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />

                <rect x="60" y="422" width="270" height="66" rx="10" fill="var(--good-bg)" stroke="var(--good-line)" strokeWidth="1.25" />
                <text x="195" y="447" textAnchor="middle" fill="var(--text)" fontFamily="var(--font-body)" fontSize="13.5" fontWeight="600">
                  Instant tUSD8 Transfer
                </text>
                <text x="195" y="468" textAnchor="middle" fill="var(--good)" fontFamily="var(--font-mono)" fontSize="11.5">
                  SpendExecuted event
                </text>

                {/* Right Branch: Over Per-Tx or Daily */}
                <rect x="479" y="370" width="172" height="26" rx="13" fill="var(--warn-chip)" stroke="var(--warn-line)" strokeWidth="1" />
                <text x="565" y="383" dy="0.35em" textAnchor="middle" fill="var(--warn)" fontFamily="var(--font-body)" fontSize="11.5" fontWeight="600">
                  Over Per-Tx or Daily
                </text>

                <line x1="565" y1="396" x2="565" y2="420" stroke="var(--text-faint)" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />

                <rect x="430" y="422" width="270" height="66" rx="10" fill="var(--warn-bg)" stroke="var(--warn-line)" strokeWidth="1.25" />
                <text x="565" y="447" textAnchor="middle" fill="var(--text)" fontFamily="var(--font-body)" fontSize="13.5" fontWeight="600">
                  Escrowed SpendRequest (24h TTL)
                </text>
                <text x="565" y="468" textAnchor="middle" fill="var(--warn)" fontFamily="var(--font-body)" fontSize="11.5">
                  Owner: Approve or Reject / Refund
                </text>
              </svg>
            </div>
            <p className="fine flow-hint">Swipe horizontally to pan the full execution flow →</p>
          </section>

          <section id="aevum">
            <h2>3. QDay Aevum Testnet Compliance</h2>
            <div className="table-wrap docs-table-wrap" role="region" aria-label="QDay Aevum Testnet compliance" tabIndex={0}>
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row">Chain ID</th><td><code>44005</code> (QDay Aevum Testnet)</td></tr>
                  <tr><th scope="row">HTTPS RPC</th><td><code>https://rpc-test.qday.info</code> (no WebSocket)</td></tr>
                  <tr><th scope="row">tUSD8 Token</th><td><code>{TUSD8_ADDRESS}</code> (6 decimals, EIP-3009 v2)</td></tr>
                  <tr><th scope="row">AevumGuardVault</th><td><code>0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e</code> (deploy block <code>3685765</code>)</td></tr>
                  <tr><th scope="row">EVM Version</th><td>Pinned to <code>shanghai</code> (verified with <code>tools/check-shanghai.mjs</code>)</td></tr>
                  <tr><th scope="row">Audit Log Sync</th><td>Uses <code>getLogsChunked</code> (1,000-block chunks) matching Aevum RPC cap</td></tr>
                  <tr><th scope="row">Challenge Page</th><td><a href={HACKATHON_URL} target="_blank" rel="noreferrer">Aevum Builder Challenge #1 on DoraHacks</a></td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="quickstart">
            <h2>4. Local &amp; Fork Quickstart</h2>
            <Code>{`
# 1. Build contracts & verify zero Cancun opcodes
cd contracts && forge build && cd ..
node tools/check-shanghai.mjs contracts/out

# 2. Run unit/fuzz tests and live Aevum tUSD8 fork tests
cd contracts
forge test --no-match-path "test/fork/*" -vv
forge test --match-contract AevumGuardForkTest --fork-url https://rpc-test.qday.info -vv

# 3. Start local Shanghai anvil + deploy MockUSD8 + AevumGuardVault
anvil --hardfork shanghai
forge script script/DeployAevumGuard.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# 4. Run dashboard
pnpm dev
            `}</Code>
          </section>

          <section id="tokens">
            <h2>5. Get Free Aevum Test Tokens</h2>
            <p>
              Join the <a href={DISCORD_URL} target="_blank" rel="noreferrer">QDay Discord</a>, verify in <code>#verify</code>, and run{" "}
              <code>/faucet &lt;your-address&gt;</code> in <code>#faucet</code> to receive <strong>1 tQDAY + 5 tUSD8</strong> with zero
              Ethereum mainnet requirement. (Note: the web faucet at{" "}
              <a href={links.faucetWeb} target="_blank" rel="noreferrer">faucet.qday.info</a> requires a tiny mainnet balance.)
            </p>
          </section>

          <section id="credits">
            <h2>6. License &amp; Attribution</h2>
            <p>
              MIT Licensed. Built during the Aevum Builder Challenge #1 window (Nov 16 – Dec 11, 2026). Based on{" "}
              <strong>Aevum Starter Kit (MIT, PQA Labs)</strong> for chain configuration, chunked log scanning, and EIP-3009 helpers.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
