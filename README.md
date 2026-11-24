# AevumGuard

**Programmable `tUSD8` Treasury & Spend Policy Firewall for Autonomous AI Agents on QDay Aevum Testnet**

Built for **Aevum Builder Challenge #1 (QDay)** (`Native AI Assistants` · `Confirmation of Payee` · `Decentralized Payments`).

**Key capability:** Any MCP-compatible AI agent can query and simulate policy-guarded spends through the strictly non-custodial [`@aevum-kit/mcp-server`](#ai-agent-mcp-server-aevum-kitmcp-server)—no private keys enter the MCP server.

## Live Demo & Submission Links

- **Live Web App (Vercel):** https://aevum-guard.vercel.app/
- **Interactive Docs & Execution Flow:** https://aevum-guard.vercel.app/docs
- **Public Repository (MIT):** https://github.com/muradcift/aevum-guard
- **Deployed Contract (QDay Aevum Testnet 44005):** [`0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e`](https://explorer-test.qday.info/address/0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e)
- **Initial Testnet Deployment Commit:** [`f234195`](https://github.com/muradcift/aevum-guard/commit/f2341959c54ac632bf8bcdf415943c8502817b29)

---

## Problem Statement

Giving an autonomous AI assistant direct access to a stablecoin wallet creates an unbounded blast radius: a hallucinated tool call, prompt injection, or misconfigured vendor address can drain an entire treasury in a single transaction.

**AevumGuard** introduces an on-chain policy firewall (`AevumGuardVault.sol`) between the treasury owner and any AI agent:

- **Per-Transaction & Rolling Daily Limits:** Agents spend autonomously without friction *only* within owner-configured limits (`perTxLimit` and UTC-day `dailyLimit`).
- **Hard Lifetime Cap & Mandate Expiry:** Enforces cumulative `totalBudget` across both autonomous spends and human-approved overrides, plus optional `expiresAt` timestamps.
- **Confirmation of Payee (Allowlist):** Cryptographically binds human-readable vendor names to verified recipient addresses (`keccak256(abi.encodePacked(label, payee))`). Transfers to unverified recipients revert deterministically when `enforceAllowlist` is active.
- **Human-in-the-Loop Escalation Queue:** When `allowQueueOverflow` is enabled, over-limit spends move into an escrowed 24-hour `Pending` request instead of failing silently — owners approve (`approveRequest`) or reject/refund (`rejectRequest`) in one click.
- **Gasless Funding & Gasless Agent Execution:** Owners fund vaults gaslessly via `tUSD8` **EIP-3009** `receiveWithAuthorization` (vault-bound nonce prevents cross-vault redirection); AI agents sign off-chain **EIP-712** `SpendIntent` messages (`executeSpendWithSignature`) without holding native `tQDAY` gas.
- **Non-Custodial Kill-Switch:** `setVaultPaused` halts all agent spending and approvals immediately while intentionally keeping owner `withdraw` and `rejectRequest` active so treasury funds can never be trapped.

---

## Architecture Overview

```text
  Owner Wallet                                         AI Agent Signer (0 tQDAY)
       │                                                         │
       ├─ EIP-3009 / Approve ─▶ /api/relay-deposit               ├─ EIP-712 SpendIntent ─▶ /api/relay-spend
       │                                │                        │                                │
       ▼                                ▼                        │                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              AevumGuardVault (QDay Aevum · Chain 44005)                             │
│                                                                                                     │
│  1. Vault Pause / Kill-Switch Check (!paused)                                                       │
│  2. Agent Mandate Check (active && block.timestamp <= expiresAt)                                    │
│  3. Confirmation of Payee Check (enforceAllowlist => payees[vaultId][recipient].approved)           │
│  4. Hard Lifetime Cap Check (spentTotal + amount <= totalBudget)                                    │
│                                                                                                     │
│     ┌── Within perTxLimit & dailyLimit ──────────────────────▶ Instant tUSD8 Transfer (SpendExecuted)│
│     └── Exceeds limits (allowQueueOverflow = true) ──────────▶ Escrow 24h Queue (SpendQueued)        │
│                                                                      │                              │
│                                       Owner: approveRequest() ───────┼──▶ Payee                     │
│                                       Owner: rejectRequest() ────────┴──▶ Refund to Vault Balance   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Security Controls & Verified Invariants

`contracts/test/AevumGuardVault.t.sol` and `contracts/test/fork/AevumGuardFork.t.sol` verify:

- **Solvency Invariant (256 Fuzz Runs):** `tUSD8.balanceOf(vault) == sum(vault.balance + vault.reserved)` across concurrent vaults, deposits, instant spends, queued approvals/rejections, and withdrawals.
- **Vault-Bound EIP-3009 Nonces:** `depositNonce(vaultId, depositRef)` binds every EIP-3009 signature to a specific `vaultId` and contract address, blocking replay and cross-vault redirection.
- **EIP-712 Agent Intent Protection:** Enforces domain separation (`"AevumGuardVault"`, version `"1"`, dynamic `chainId`), sequential `agentNonces`, strict `deadline` expiry, and signer recovery via OpenZeppelin `ECDSA`.
- **Policy Integrity:** Updating `setPolicy` preserves `spentTotal`, `spentToday`, and `lastSpendDay` so reconfiguring limits cannot silently reset daily or lifetime caps.
- **Post-Queue Allowlist Recheck:** `approveRequest` re-checks `!paused`, `expiresAt`, `totalBudget`, and `Confirmation of Payee` allowlist before releasing escrowed funds.
- **Non-Trappable Funds:** `withdraw` and `rejectRequest` remain callable by the vault owner even while the kill-switch is engaged.

---

## API & Smart Contract Reference

Two Next.js Route Handlers expose gasless relaying for the deployed vault. Both run on the Node.js runtime, pre-validate every field, pre-flight with `simulateContract`, and submit a `type: "legacy"` transaction from the relayer account. They never custody funds — they only submit signatures the user already produced.

### `GET /api/relay-deposit` · `GET /api/relay-spend`

Liveness probe used by the UI to decide whether to show "Gasless" or "Standard/Direct" mode.

| Query | Type | Meaning |
|---|---|---|
| `chainId` | number (optional) | Defaults to the app's first configured network |

**Response `200`**

```json
{ "enabled": true, "relayer": "0xRelayerAddress" }
```

`enabled` is `false` when no relayer key is configured, the key is a public Anvil key outside local chains, or no vault address is set for that network.

### `POST /api/relay-deposit`

Submits a `tUSD8` **EIP-3009 v2** `receiveWithAuthorization` to `depositWithAuthorization`.

**Request body**

| Field | Type | Validation |
|---|---|---|
| `chainId` | number | Optional; must map to a configured network |
| `vaultId` | decimal string | `/^\d{1,78}$/` |
| `from` | address | `isAddress` |
| `amount` | decimal string | `/^\d{1,78}$/` and `> 0` (6-decimal `tUSD8` units) |
| `validAfter` | decimal string | Unix seconds |
| `validBefore` | decimal string | Unix seconds; must be `<= now + 3600` |
| `depositRef` | `0x` hex | 32 bytes (66 chars) |
| `signature` | `0x` hex | EIP-3009 `(v, r, s)`; normalized to `27`/`28` |

```json
{
  "chainId": 44005,
  "vaultId": "1",
  "from": "0xOwner",
  "amount": "3000000",
  "validAfter": "1770000000",
  "validBefore": "1770003600",
  "depositRef": "0x9f1c…32bytes",
  "signature": "0x1b…65bytes"
}
```

**Success `200`**

```json
{ "hash": "0xSubmittedTxHash" }
```

### `POST /api/relay-spend`

Submits an agent-signed **EIP-712** `SpendIntent` to `executeSpendWithSignature`.

**Request body**

| Field | Type | Validation |
|---|---|---|
| `chainId` | number | Optional; must map to a configured network |
| `intent.vaultId` | decimal string | `/^\d{1,78}$/` |
| `intent.agent` | address | `isAddress` |
| `intent.recipient` | address | `isAddress` |
| `intent.amount` | decimal string | `/^\d{1,78}$/` (6-decimal units) |
| `intent.invoiceRef` | `0x` hex | 32 bytes (66 chars) |
| `intent.memo` | string | `length <= 280` |
| `intent.nonce` | decimal string | Must equal the on-chain `agentNonces[agent]` |
| `intent.deadline` | decimal string | Unix seconds; must be `<= now + 3600` |
| `signature` | `0x` hex | EIP-712 signature over `spendIntentDigest(intent)` |

```json
{
  "chainId": 44005,
  "intent": {
    "vaultId": "1",
    "agent": "0xAgent",
    "recipient": "0xVendor",
    "amount": "500000",
    "invoiceRef": "0x4a7e…32bytes",
    "memo": "Cloud compute invoice #1042",
    "nonce": "0",
    "deadline": "1770003600"
  },
  "signature": "0x…65bytes"
}
```

**Success `200`** — identical `{ "hash": "0x…" }` envelope.

### Shared validation, rate limits & error codes

| Status | Condition |
|---|---|
| `400` | Invalid JSON · network not enabled · malformed field · `amount <= 0` · auth window / deadline `> 1 hour` · undecodable signature |
| `409` | Duplicate submission already in flight for 120 s (`chainId:dep:vaultId:depositRef` or `chainId:spend:agent:nonce`) |
| `429` | Rate limit: **15 req/min per IP**, **10 req/min per signer address** |
| `503` | Relayer not configured · relayer hit its **daily transaction cap** (`RELAYER_DAILY_TX_LIMIT`, default `500`) · relayer out of `tQDAY` gas |
| `200` | `{ "hash": "0x…" }` after successful on-chain execution |

Rate-limit and daily-cap counters are in-memory per server instance (no external store), and the trusted client IP header is configurable via `TRUSTED_IP_HEADER`.

### `AevumGuardVault` core functions

| Function | Caller | Behavior |
|---|---|---|
| `createVault(string name, bool enforceAllowlist)` | any | Creates a vault owned by `msg.sender`, returns `vaultId` |
| `deposit(uint256 vaultId, uint256 amount)` | any | Standard ERC-20 pull after `approve` |
| `depositWithAuthorization(DepositAuth auth)` | relayer / any | Gasless EIP-3009; nonce is `depositNonce(vaultId, depositRef)` |
| `withdraw(uint256 vaultId, address to, uint256 amount)` | owner | Moves available balance; **works while paused** |
| `setVaultPaused(uint256 vaultId, bool paused)` | owner | Kill-switch for agent spends and approvals |
| `setEnforceAllowlist(uint256 vaultId, bool enforce)` | owner | Toggles Confirmation of Payee enforcement |
| `setPayee(vaultId, address payee, bool approved, string label)` | owner | Curates allowlist; stores `keccak256(abi.encodePacked(label, payee))` |
| `setPolicy(vaultId, address agent, PolicyInput input)` | owner | Sets `perTxLimit`, `dailyLimit`, `totalBudget`, `expiresAt`, `allowQueueOverflow` |
| `revokeAgent(uint256 vaultId, address agent)` | owner | Deactivates an agent mandate |
| `executeSpend(vaultId, recipient, amount, invoiceRef, memo)` | agent (`msg.sender`) | Instant transfer or queue |
| `executeSpendWithSignature(SpendIntent intent, uint8 v, bytes32 r, bytes32 s)` | relayer submits | Verifies agent EIP-712 signature, nonce, deadline |
| `approveRequest(uint256 requestId)` | owner | Re-checks pause, expiry, allowlist, lifetime cap, then settles |
| `rejectRequest(uint256 requestId)` | owner | Refunds `reserved` to vault balance; **works while paused** |
| `cancelExpiredRequest(uint256 requestId)` | any | Releases expired (> 24 h) escrow |
| `getVault` / `getPolicy` / `getPayee` / `getRequest` | view | Full struct reads |
| `remainingDailyLimit(vaultId, agent)` | view | Remaining UTC-day allowance |
| `depositNonce(vaultId, depositRef)` | view | Vault-bound EIP-3009 nonce |
| `domainSeparator()` / `spendIntentDigest(intent)` | view | EIP-712 helpers |
| `agentNonces(address)` | view | Sequential per-agent nonce |

**Constants:** `REQUEST_TTL = 24 hours` · `SPEND_INTENT_TYPEHASH` covers `(vaultId, agent, recipient, amount, invoiceRef, memo, nonce, deadline)`.

### Key events

| Event | Emitted when |
|---|---|
| `VaultCreated(vaultId, owner, name, enforceAllowlist)` | Vault created |
| `Deposited(vaultId, from, amount, gasless, depositRef)` | Any deposit; `gasless` distinguishes EIP-3009 |
| `Withdrawn(vaultId, to, amount)` | Owner withdrawal |
| `VaultPauseChanged(vaultId, paused)` | Kill-switch toggled |
| `AllowlistModeChanged(vaultId, enforceAllowlist)` | Enforcement toggled |
| `PayeeUpdated(vaultId, payee, approved, label, confirmationHash)` | Allowlist mutation |
| `PolicyUpdated(vaultId, agent, label, perTxLimit, dailyLimit, totalBudget, expiresAt, allowQueueOverflow)` | Mandate set |
| `AgentRevoked(vaultId, agent)` | Mandate deactivated |
| `SpendExecuted(vaultId, agent, recipient, amount, invoiceRef, memo, requestId)` | Instant spend or approved request |
| `SpendQueued(requestId, vaultId, agent, recipient, amount, invoiceRef, memo, reasonCode)` | Escrowed for approval |
| `RequestApproved(requestId, vaultId, approver)` / `RequestRejected(...)` / `RequestCancelled(requestId, vaultId)` | Queue lifecycle |

`reasonCode` is a bitmask: `1` = per-tx limit exceeded, `2` = daily limit exceeded (both = `3`).

### Custom errors

`ZeroAddress` · `ZeroAmount` · `VaultNotFound` · `NotVaultOwner` · `VaultPaused` · `AgentNotActive` · `PolicyExpired` · `PayeeNotAllowlisted` · `InsufficientVaultBalance` · `TotalBudgetExceeded` · `SpendLimitExceeded` · `RequestNotFound` · `RequestNotPending` · `RequestExpired` · `RequestNotExpired` · `IntentExpired` · `InvalidNonce` · `InvalidAgentSignature`

All are decoded into plain-language messages by `web/src/lib/errors.ts`, including EIP-3009 `AuthorizationUsedAlready`, `AuthorizationExpired`, and `InvalidSignature` failures from `tUSD8`.

---

## Platform Integrations & Technology Stack

Every layer is wired to one target: QDay Aevum testnet (`chainId 44005`), Shanghai EVM, HTTPS RPC at `https://rpc-test.qday.info`.

### QDay Aevum integration map

| Layer | Integration |
|---|---|
| **Stablecoin** | `tUSD8` (`0x456569838f1d43009A91ebA4263147Afd7233483`, **6 decimals**, EIP-3009 v2). Gasless deposits call `receiveWithAuthorization` with a vault-bound nonce, so a signature cannot be replayed against another vault or contract. |
| **Bytecode gate** | `contracts/foundry.toml` pins `solc_version = "0.8.24"` and `evm_version = "shanghai"`. `tools/check-shanghai.mjs` scans both `deployedBytecode` and `bytecode` artifacts for `BLOBHASH`, `BLOBBASEFEE`, `TLOAD`, `TSTORE`, and `MCOPY`, skipping PUSH immediates and CBOR metadata, and exits non-zero on any hit (`pnpm check:shanghai`). |
| **Log sync** | `web/src/components/ApprovalAuditPanel.tsx` paginates `eth_getLogs` through `getLogsChunked` from `@aevum-kit/aevum` in **1,000-block chunks**, starting at `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` (deployment block `3685765`). |
| **Shared ABI** | Web and scripts import `aevumGuardAbi` from `@aevum-kit/aevum`, so the TypeScript client and Solidity contract cannot drift. |
| **Relayer transport** | `viem` `createWalletClient` + `createPublicClient` over HTTPS, `simulateContract` pre-flight, then `writeContract({ type: "legacy" })`. Key supplied via non-public `RELAYER_PRIVATE_KEY`; Anvil default keys are refused off-local. |
| **Client identity** | Client IP resolved from `TRUSTED_IP_HEADER` (Vercel sets `x-vercel-forwarded-for`) with `x-forwarded-for` / `x-real-ip` fallback. |

### Smart contract stack

- **Foundry** (`forge`, `anvil`, `cast`) with `forge-std` tests: unit, 256-run fuzz, and a live Aevum `tUSD8` fork test.
- **OpenZeppelin Contracts v5.1.0** — `IERC20`, `SafeERC20`, `ReentrancyGuard`, `ECDSA`.
- **EIP-712** domain: name `"AevumGuardVault"`, version `"1"`, dynamic `chainId`, verifying contract address; cached with a chain-id fallback.
- **EIP-3009** interface adapted from the Aevum Starter Kit `Checkout.sol` conventions.
- **No upgradeability, no proxy, no admin key beyond the per-vault owner.**

### Web stack

| Component | Version / role |
|---|---|
| **Next.js** | `16.4.3` (App Router, Route Handlers, Node.js runtime) |
| **React** | `19.2.0` |
| **viem** | `2.57.12` — encoding, simulation, signature parsing, log decoding |
| **wagmi** | `2.19.5` + `@tanstack/react-query` `5.90.2` |
| **RainbowKit** | `2.2.11` wallet connection |
| **TypeScript** | `5.9.3` strict typecheck (`pnpm typecheck`) |
| **Toolchain** | Node `>= 22`, `pnpm@10.8.1` workspace (`packages/*` + `web`) |

### Extension seams (used by the roadmap)

`web/src/lib/relayer.ts` centralizes limits and network resolution; `web/src/lib/errors.ts` maps every custom error to UI copy; `web/src/lib/env.ts` defines the `aevum` / `fork` / `local` network matrix. New chains, alerting channels, and SDK wrappers attach at these seams without touching contract logic.

---

## Aevum Testnet Engineering Compliance

- **Shanghai EVM Only:** `contracts/foundry.toml` pins `solc_version = "0.8.24"` and `evm_version = "shanghai"` (no `MCOPY`, `TSTORE`, `TLOAD`, or blob opcodes). Verified via `node tools/check-shanghai.mjs contracts/out`.
- **1,000-Block `eth_getLogs` Limit:** The audit feed in `web/src/components/ApprovalAuditPanel.tsx` uses `getLogsChunked` from `@aevum-kit/aevum` to paginate block ranges cleanly.
- **HTTPS-Only Polling & Legacy Relayer Tx:** Configured for `https://rpc-test.qday.info` with `type: "legacy"` relayer transactions.

---

## Known Assumptions, Security Boundaries & Limitations

Written as an honest engineering boundary, not a disclaimer. Each item states what is true today and what would change it.

### 1. Single-owner custody

- **Today:** Each vault has exactly one `owner` address (`createVault` sets `owner = msg.sender`). Only that address can set policy, curate the allowlist, pause, withdraw, approve, or reject.
- **Boundary:** There is no timelock, no role separation, and no quorum. A compromised owner key can drain the vault via `withdraw`, by design — `withdraw` intentionally remains callable while paused so funds are never trapped.
- **Not yet:** No multisig. **Next:** deploy the owner as a Safe on QDay Aevum; the contract needs no change because ownership is a plain address.

### 2. Relayer rate limits & gas sponsorship boundary

- **Today:** The relayer is an off-chain submitter. It pays `tQDAY` gas so agents need zero native balance. Limits are **15 requests/min per IP**, **10/min per signer**, and **500 transactions/day** per relayer instance (`RELAYER_DAILY_TX_LIMIT`), plus a **1-hour** maximum authorization window and 120-second in-flight deduplication.
- **Boundary:** Rate-limit and daily-cap counters live in per-instance memory. They are not a distributed quota and reset on cold start. The relayer is a liveness/censorship-resistance aid, not a security control — the contract, not the relayer, enforces every economic limit.
- **Blast radius of relayer key loss:** An attacker with the relayer key can waste relayer gas and submit already-signed intents. They **cannot** move funds without a valid owner-signed EIP-3009 authorization or a valid agent-signed EIP-712 `SpendIntent`, and cannot exceed `perTxLimit`, `dailyLimit`, or `totalBudget`.
- **Not yet:** Multi-instance quota state, per-agent gas budgets, and paymaster abstraction. **Next:** shared rate-limit store and a dedicated gas top-up alert.

### 3. Owner-curated Confirmation of Payee vs. a live registry

- **Today:** Confirmation of Payee is an **owner-curated allowlist**. `setPayee` binds `keccak256(abi.encodePacked(label, payee))` and `enforceAllowlist` gates spends and `approveRequest`. This is deterministic and auditable on-chain.
- **Boundary:** It proves *the owner approved this address*, not *this address belongs to a legally verified vendor*. There is no KYB, no domain binding, and no third-party attestation. Trust is only as current as the owner's curation; labels are free-text strings, not canonical identifiers.
- **Not yet:** ERC-8004 registry integration. **Next:** resolve `payee` against an ERC-8004 trustless registry when it is live on Aevum, keeping the local allowlist as an additional (not replacement) gate.

### 4. Shanghai EVM constraint

- **Today:** Aevum runs the Shanghai EVM. Contracts compile with `solc 0.8.24` / `evm_version = "shanghai"` and are verified opcode-by-opcode by `tools/check-shanghai.mjs`.
- **Boundary:** No `MCOPY`, `TSTORE`, `TLOAD`, `BLOBHASH`, or `BLOBBASEFEE`. Any dependency or future compiler upgrade that emits Cancun opcodes will fail the check and the deployment. Raising `evm_version` is explicitly rejected in `foundry.toml`.
- **Not yet:** Cancun-only gas optimizations. **Next:** re-evaluate only if and when Aevum upgrades its EVM.

### 5. HTTPS-only stateless log polling

- **Today:** The audit feed polls `eth_getLogs` over **HTTPS only** (`https://rpc-test.qday.info`, no WebSocket), chunked at 1,000 blocks. The app is stateless; all state is on-chain or in the browser.
- **Boundary:** Polling latency means a newly queued or settled request can take one poll cycle to appear. Chunked scans grow with vault age, and per-instance memory limits do not persist across serverless cold starts. There is no push notification and no guaranteed indexing freshness.
- **Not yet:** Websocket subscriptions, event indexer, webhook/Slack/Telegram alerts. **Next:** alerting layer plus an indexer for large vault histories.

### Cross-cutting assumptions

- `tUSD8` is assumed to be a faithful EIP-3009 v2 token with 6 decimals; a non-standard implementation would break `depositWithAuthorization`.
- The relayer trusts `TRUSTED_IP_HEADER`; behind a misconfigured proxy, IP-based limits can be spoofed or over-shared. Signer-based limits remain the stronger signal.
- `memo` and `label` are unbounded on-chain within gas limits; the API caps `memo` at 280 chars but on-chain callers are unrestricted.

---

## Real-World Utility, Market Fit & Mainnet Roadmap

### Target audiences

| Audience | Why AevumGuard fits |
|---|---|
| **AI-native teams giving autonomous agents bounded budgets** | Engineering teams that let agents call paid APIs, spin up cloud resources, or pay contractors need a hard, non-custodial ceiling. `perTxLimit` / `dailyLimit` / `totalBudget` plus Confirmation of Payee turn "trust the prompt" into "trust the policy". |
| **DAO operational sub-treasuries** | A DAO can hold a working-capital sub-treasury where a signer/agent executes routine payables instantly, while anything over a threshold escalates to a 24-hour on-chain approval queue. Non-trappable `withdraw` and `rejectRequest` satisfy the "funds can always be recovered" requirement. |
| **Agent infrastructure & wallet vendors** | A drop-in policy module for agent wallets that must not custody user funds but must guarantee spending bounds. |
| **Crypto-native freelancer / contractor payments** | Payee allowlist plus invoice references gives a clean, auditable payment trail per vendor. |

### Monetization & distribution path

- **Open core, hosted convenience:** the vault and SDK stay MIT-licensed on-chain; monetization comes from hosted relayer reliability, alerting, and team dashboards — not from rent on user funds.
- **Usage tiers:** free self-relay; paid hosted relayer with higher daily caps, multi-region submit, and guaranteed uptime.
- **Distribution channels:** Aevum ecosystem directory and Builder Challenge showcase; agent frameworks (MCP, LangChain, AgentKit) as integration surfaces; DAO treasury templates; design-partner pilots with AI-native startups.
- **Why now:** agent spend is growing faster than agent authorization tooling. The wallet layer proves *who* is spending; AevumGuard proves *how much, to whom, and until when*.

### Phased Q1–Q2 2027 QDay mainnet roadmap

| Phase | Scope |
|---|---|
| **Q1 2027 — Custody & trust hardening** | Safe/multisig as vault owner; owner-migration path; ERC-8004 registry resolution for `payee` when live on Aevum; mainnet deployment and independent audit of `AevumGuardVault`. |
| **Q1 2027 — Operational visibility** | Webhook + Slack + Telegram approval alerts for `SpendQueued` / `RequestApproved` / `RequestRejected` / `VaultPauseChanged`; hosted indexer for long histories; relayer uptime and gas-balance monitoring. |
| **Q2 2027 — Agent-native distribution** | MCP server so any MCP client can request a budgeted spend; LangChain tool binding; Coinbase AgentKit / agent-wallet integration; TypeScript SDK with typed `SpendIntent` builders and policy helpers. |
| **Q2 2027 — Scale** | Multi-instance rate-limit state, per-agent gas budgets, paymaster abstraction, and additional Aevum-ecosystem stablecoins behind the same policy engine. |

Each phase preserves the two load-bearing invariants: **the contract enforces every limit**, and **the owner can always recover funds**.

---

## AI Agent MCP Server (`@aevum-kit/mcp-server`)

Any MCP-compatible AI agent—including Claude Desktop, Cursor, or Antigravity—can connect to `AevumGuardVault` over stdio using JSON-RPC 2.0. The server reads live on-chain state and prepares unsigned EIP-712 intents only when policy allows; it contains **zero private keys**, never signs, and never submits transactions. This is strictly non-custodial: the vault contract enforces the spend policy.

The four live on-chain tools are:

- `get_vault_status` — read vault state and agent policy.
- `check_payee_verified` — check a recipient against the Confirmation of Payee allowlist.
- `simulate_agent_spend` — simulate a proposed spend against live policy.
- `prepare_gasless_spend_intent` — prepare an unsigned EIP-712 intent when allowed.

Run the one-command live adversarial prompt-injection demo:

```sh
pnpm mcp:demo
```

It verifies four assertions against QDay Testnet: reads live Vault #1; blocks a prompt-injected rogue `0x...dEaD` recipient with `PayeeNotAllowlisted` and does **not** issue an EIP-712 intent; returns `PASS_INSTANT` for a verified vendor spend of `0.40 tUSD8` with the live nonce; and routes an oversized `0.85 tUSD8` spend to `ESCALATE_24H_ESCROW`. The demo is read-only and does not create signatures or transactions.

Configure Claude Desktop or Cursor with the repository path set to your local checkout:

```json
{
  "mcpServers": {
    "aevumguard": {
      "command": "pnpm",
      "args": ["--filter", "@aevum-kit/mcp-server", "start"],
      "cwd": "D:/path/to/aevum-guard"
    }
  }
}
```

---

## Quickstart & Verification

### Prerequisites

- Node.js `>= 22` and `pnpm`
- Foundry (`forge`, `anvil`, `cast`)

### 1. Install Dependencies

```bash
git submodule update --init --recursive
pnpm install
```

### 2. Compile & Verify Shanghai Bytecode

```bash
cd contracts && forge build && cd ..
node tools/check-shanghai.mjs contracts/out
```

### 3. Run Unit, Fuzz, and Live Aevum Fork Tests

```bash
cd contracts
forge test --no-match-path "test/fork/*" -vv
forge test --match-contract AevumGuardForkTest --fork-url https://rpc-test.qday.info -vv
```

### 4. Local End-to-End Run (Shanghai Anvil)

```bash
# Terminal 1: start Shanghai-pinned local node
anvil --hardfork shanghai --port 8545

# Terminal 2: deploy MockUSD8 + AevumGuardVault locally
cd contracts
forge script script/DeployAevumGuard.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

Copy `web/.env.example` to `web/.env.local`, populate `NEXT_PUBLIC_VAULT_LOCAL` (or `NEXT_PUBLIC_VAULT_AEVUM` / `NEXT_PUBLIC_VAULT_FORK`) and `RELAYER_PRIVATE_KEY`, then launch the Control Center:

```bash
pnpm typecheck
pnpm dev
```

### Hosting (Vercel)

The Control Center is deployed to **Vercel** with these project settings:

- **Root Directory:** `web`
- **Install Command:** `pnpm install --frozen-lockfile`

Configure the following **public** environment variables (all `NEXT_PUBLIC_*` values are safe to expose in the browser bundle):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_NETWORKS=aevum` | Active network selection |
| `NEXT_PUBLIC_VAULT_AEVUM` | Deployed `AevumGuardVault` address |
| `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` | Vault deploy block for log chunking |
| `NEXT_PUBLIC_REPO_URL` | Public repository link |
| `TRUSTED_IP_HEADER=x-vercel-forwarded-for` | Client IP header trusted behind Vercel |

Optional server-side variable: `RELAYER_PRIVATE_KEY` (enables gasless relay endpoints; keep it out of any `NEXT_PUBLIC_*` name).

---

## Aevum Testnet Deployment & Evidence

| Field | Value |
|---|---|
| Network | QDay Aevum Testnet (`chainId: 44005`) |
| `tUSD8` Address | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) |
| `AevumGuardVault` Address | [`0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e`](https://explorer-test.qday.info/address/0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e) |
| Deploy Block | `3685765` |
| Deployer / Owner | [`0xa7E93BA94DB2F631A92aCa5186d43bC2A0E646A3`](https://explorer-test.qday.info/address/0xa7E93BA94DB2F631A92aCa5186d43bC2A0E646A3) |
| Demo AI Agent (0 tQDAY) | [`0xCE45f546D53746acabB6FB34c87AFE6433A83b3a`](https://explorer-test.qday.info/address/0xCE45f546D53746acabB6FB34c87AFE6433A83b3a) |
| Verified Vendor | [`0x5b0C9bE853C8cafDC9CA914744eEC5e486aB1260`](https://explorer-test.qday.info/address/0x5b0C9bE853C8cafDC9CA914744eEC5e486aB1260) |

### Verifiable Live Aevum Testnet Transactions (10)

| Step | Action | Block | Explorer Tx |
|---|---|---|---|
| 0 | Deploy `AevumGuardVault` (Shanghai EVM) | `3685765` | [`0x78b5…2ea8`](https://explorer-test.qday.info/tx/0x78b50784a62fa61ae9447c3618a6c7882787a1167548b95d9066f0b221a82ea8) |
| 1 | `createVault("AevumGuard Live AI Ops Vault", enforceAllowlist=true)` | `3685823` | [`0x8682…f34b`](https://explorer-test.qday.info/tx/0x86824f6093cd388ccb452bd128d1348ea3580b11f1644f7b1ec1b5d35141f34b) |
| 2 | `depositWithAuthorization` — **Gasless EIP-3009** (`3.00 tUSD8`) | `3685829` | [`0x2328…2d9d`](https://explorer-test.qday.info/tx/0x232867219d433e75b4a67da256c30d1c643169c056dcf8ee53c12e3d0faa2d9d) |
| 3 | `setPayee` — **Confirmation of Payee** (`Cloud Compute Vendor`) | `3685835` | [`0x1640…5bf4`](https://explorer-test.qday.info/tx/0x1640b06e1dd88f7754829a083ab7ef764e5dfca8a216bd4f306a8af997965bf4) |
| 4 | `setPolicy` — AI Agent Mandate (`0.75` per-tx / `2.50` daily / `3.00` cap) | `3685838` | [`0x1bdf…2182`](https://explorer-test.qday.info/tx/0x1bdfb3219b298808f782e9a1a13399a7749fdb58071ef40e6c3c0aff1f5d2182) |
| 5 | `executeSpendWithSignature` — **Gasless EIP-712 Auto-Approved** (`0.50 tUSD8`) | `3685844` | [`0xc334…83c3`](https://explorer-test.qday.info/tx/0xc3348f77a546ef24b98a51237403c3aee7de03b52b95e77792cad823129483c3) |
| 6 | `executeSpendWithSignature` — **Over-Limit Queued** Req #1 (`1.10 tUSD8`) | `3685851` | [`0x316b…41ef`](https://explorer-test.qday.info/tx/0x316b0dcbf8626c87ef7f9d7a7652a247819e3bfea6cbc5b6657ddc51768f41ef) |
| 7 | `approveRequest(1)` — **Human-in-the-Loop Approved & Settled** (`1.10 tUSD8`) | `3685857` | [`0x9ee6…66b1`](https://explorer-test.qday.info/tx/0x9ee6700cabd1ef3772f7d4e6101ef0efb6f22a48d088d0cf12d2da82271d66b1) |
| 8 | `executeSpendWithSignature` — **Over-Limit Queued** Req #2 (24h TTL expired — escrowed 0.90 tUSD8 refundable via `cancelExpiredRequest`) | `3685863` | [`0x3937…503f`](https://explorer-test.qday.info/tx/0x39372b3fb5fd3f2679ab946b05b24512b7e3d49141f107ecca5fa82d84a3503f) |
| 9 | Standard `deposit(1, 1.00 tUSD8)` — Vault #1 liquidity: `1.50 tUSD8` available + `0.90 tUSD8` reserved = `2.40 tUSD8` | `3758104` | [`0x40a6…691e`](https://explorer-test.qday.info/tx/0x40a65fa4f6c47bce788125e4b717cc817988501f8aaa2b3176bbc4256397c691) |

---

## License & Attribution

Licensed under the **MIT License** (see [LICENSE](LICENSE)).

- **Based on Aevum Starter Kit (MIT, PQA Labs)** — reuses chain config (`@aevum-kit/aevum`), `MockUSD8.sol`, `tools/check-shanghai.mjs`, `getLogsChunked`, and EIP-3009 interface conventions.
- Third-party libraries and licenses are documented in [NOTICE.md](NOTICE.md).
