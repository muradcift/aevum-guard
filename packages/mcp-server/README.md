# @aevum-kit/mcp-server

A non-custodial MCP stdio server for live `AevumGuardVault` guardrails on QDay Aevum Testnet (chain ID `44005`). It reads on-chain state, verifies Confirmation of Payee, simulates spends, creates unsigned EIP-712 `SpendIntent` data only when policy allows, runs the 32-scenario adversarial benchmark, and verifies signed audit receipts. It never holds vault or agent spend keys, never signs spend intents, and never submits transactions.

## Requirements and usage

Node.js 22+ and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @aevum-kit/mcp-server start
```

Configure with optional environment variables: `AEVUM_RPC_URL`, `AEVUM_VAULT_ADDRESS`, `AEVUM_VAULT_ID`, `AEVUM_AGENT_ADDRESS`. Spend amounts use integer tUSD8 base units (6 decimals; `0.40 tUSD8` is `400000`).

## Tools (6)

| Tool | Required args | Optional args | Purpose |
|---|---|---|---|
| `get_vault_status` | — | `vaultId`, `agent` | Read live vault balance, guardrails, daily quota, mandate, nonce, and pause/allowlist state |
| `check_payee_verified` | `recipient` | `vaultId` | Check Confirmation of Payee approval, label, confirmation hash, and strict-allowlist mode |
| `simulate_agent_spend` | `recipient`, `amountTusd8` | `invoiceRef`, `memo`, `vaultId`, `agent` | Simulate a spend against live vault limits without signing or submitting |
| `prepare_gasless_spend_intent` | `recipient`, `amountTusd8`, `invoiceRef`, `memo` | `deadlineSeconds`, `vaultId`, `agent` | Return unsigned EIP-712 `SpendIntent` data only when policy permits |
| `run_security_benchmark` | — | `includeReceipt` | Run the 32-scenario deterministic adversarial suite (`aevum-adversarial-benchmark/v1`) and return a signed `aevum-audit-receipt/v1` receipt (`includeReceipt` defaults to `true`) |
| `verify_audit_receipt` | `receipt` | — | Verify an `AevumAuditReceipt` JSON object (entry hash chain, `chainRoot`, `payloadHash`, `receiptId`, and `EIP-712-secp256k1` signer) |

## MCP client configuration

Claude Desktop (use absolute paths appropriate for your machine):

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

Cursor's `mcp.json` uses the same `mcpServers` entry. Keep the server's stdout reserved for MCP protocol messages; diagnostics are sent to stderr.

## Live adversarial demo

```sh
pnpm --filter @aevum-kit/mcp-server demo
```

The demo launches the MCP server as a child over stdio, then tests live vault status, a blocked prompt-injection transfer, a verified vendor intent, and an over-limit escrow escalation. It exits non-zero if any live assertion fails. It is read-only and does not create signatures or transactions.

## Adversarial benchmark & receipt verification CLI

From the repository root (or with `pnpm --filter @aevum-kit/mcp-server <script>`):

```sh
# Run the deterministic 32-scenario benchmark suite offline
pnpm benchmark

# Export signed aevum-audit-receipt/v1 JSON and verify on-disk round-trip
pnpm benchmark -- --out receipt.json

# Emit machine-readable JSON report to stdout (diagnostics on stderr)
pnpm benchmark -- --json

# Add read-only live cross-check against QDay Testnet Vault #1
pnpm benchmark -- --live

# Independently verify any exported receipt (exits non-zero on tamper)
pnpm verify:receipt receipt.json
```

`pnpm verify:receipt <path-to-receipt.json>` recomputes each entry hash, `chainRoot`, `payloadHash`, and `receiptId`, and recovers the `EIP-712-secp256k1` signer address, catching any 1-byte modification to the payload or signature.
