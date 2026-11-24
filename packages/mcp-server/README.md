# @aevum-kit/mcp-server

A non-custodial MCP stdio server for live AevumGuardVault guardrails on QDay Aevum Testnet (chain ID `44005`). It reads on-chain state, verifies Confirmation of Payee, simulates spends, and creates unsigned EIP-712 `SpendIntent` data only when policy allows. It never holds keys, signs, or submits transactions.

## Requirements and usage

Node.js 22+ and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @aevum-kit/mcp-server start
```

Configure with optional environment variables: `AEVUM_RPC_URL`, `AEVUM_VAULT_ADDRESS`, `AEVUM_VAULT_ID`, `AEVUM_AGENT_ADDRESS`. Spend amounts use integer tUSD8 base units (6 decimals; `0.40 tUSD8` is `400000`).

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
