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
                <strong>Human-in-the-Loop Escalation Queue:</strong> Over-limit requests reserve funds in escrow for 24h (`Pending`) so the
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
            <Code>{`
Owner Wallet ──(EIP-3009 / Approve)──▶ AevumGuardVault (tUSD8 Treasury)
                                             │
AI Agent ──(EIP-712 SpendIntent)──▶ /api/relay-spend ──▶ executeSpendWithSignature()
                                             │
        ┌────────────── Checks ──────────────┴──────────────┐
        │ 1. !paused & mandate active & !expired            │
        │ 2. Confirmation of Payee allowlist check          │
        │ 3. Total lifetime budget hard cap                 │
        └──────────────────────┬────────────────────────────┘
                               │
           ┌───────────────────┴───────────────────┐
  Within Per-Tx & Daily                    Over Per-Tx or Daily
           │                                       │
           ▼                                       ▼
   Instant tUSD8 Transfer                 Escrowed SpendRequest (24h TTL)
   (SpendExecuted event)                  Owner: Approve or Reject/Refund
            `}</Code>
          </section>

          <section id="aevum">
            <h2>3. QDay Aevum Testnet Compliance</h2>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row">Chain ID</th><td><code>44005</code> (QDay Aevum Testnet)</td></tr>
                  <tr><th scope="row">HTTPS RPC</th><td><code>https://rpc-test.qday.info</code> (no WebSocket)</td></tr>
                  <tr><th scope="row">tUSD8 Token</th><td><code>{TUSD8_ADDRESS}</code> (6 decimals, EIP-3009 v2)</td></tr>
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
