# AevumGuard

**Programmable `tUSD8` Treasury & Spend Policy Firewall for Autonomous AI Agents on QDay Aevum Testnet**

Built for **Aevum Builder Challenge #1 (QDay)** (`Native AI Assistants` · `Confirmation of Payee` · `Decentralized Payments`).

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

## Aevum Testnet Engineering Compliance

- **Shanghai EVM Only:** `contracts/foundry.toml` pins `solc_version = "0.8.24"` and `evm_version = "shanghai"` (no `MCOPY`, `TSTORE`, `TLOAD`, or blob opcodes). Verified via `node tools/check-shanghai.mjs contracts/out`.
- **1,000-Block `eth_getLogs` Limit:** The audit feed in `web/src/components/ApprovalAuditPanel.tsx` uses `getLogsChunked` from `@aevum-kit/aevum` to paginate block ranges cleanly.
- **HTTPS-Only Polling & Legacy Relayer Tx:** Configured for `https://rpc-test.qday.info` with `type: "legacy"` relayer transactions.

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

### Verifiable Live Aevum Testnet Transactions

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
| 8 | `executeSpendWithSignature` — **Over-Limit Queued** Req #2 (`0.90 tUSD8`, Pending) | `3685863` | [`0x3937…503f`](https://explorer-test.qday.info/tx/0x39372b3fb5fd3f2679ab946b05b24512b7e3d49141f107ecca5fa82d84a3503f) |

---

## License & Attribution

Licensed under the **MIT License** (see [LICENSE](LICENSE)).

- **Based on Aevum Starter Kit (MIT, PQA Labs)** — reuses chain config (`@aevum-kit/aevum`), `MockUSD8.sol`, `tools/check-shanghai.mjs`, `getLogsChunked`, and EIP-3009 interface conventions.
- Third-party libraries and licenses are documented in [NOTICE.md](NOTICE.md).
