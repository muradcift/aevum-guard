import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import {
  checkPayeeVerified,
  getVaultStatus,
  prepareGaslessSpendIntent,
  simulateAgentSpend,
} from "./guardrail";

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type ToolArguments = Record<string, unknown>;

const tools = [
  {
    name: "get_vault_status",
    description: "Read live QDay Aevum Testnet vault liquidity, guardrails, daily quota, agent mandate, nonce, and pause/allowlist state. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: { type: "string", description: "Vault ID as a decimal integer; defaults to configured Vault #1." },
        agent: { type: "string", description: "Agent address; defaults to AEVUM_AGENT_ADDRESS or the bundled demo agent." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_payee_verified",
    description: "Check live Confirmation of Payee approval, label, confirmation hash, and strict-allowlist mode.",
    inputSchema: {
      type: "object",
      required: ["recipient"],
      properties: {
        recipient: { type: "string", description: "EVM recipient address." },
        vaultId: { type: "string", description: "Vault ID as a decimal integer." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simulate_agent_spend",
    description: "Simulate a proposed agent transfer against live vault guardrails. amountTusd8 is the integer token base-unit amount (6 decimals: 0.40 tUSD8 = 400000). Never signs or submits a transaction.",
    inputSchema: {
      type: "object",
      required: ["recipient", "amountTusd8"],
      properties: {
        recipient: { type: "string", description: "EVM recipient address." },
        amountTusd8: { type: "string", pattern: "^[0-9]+$", description: "Integer tUSD8 base units; token has 6 decimals." },
        invoiceRef: { type: "string" },
        memo: { type: "string" },
        vaultId: { type: "string" },
        agent: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prepare_gasless_spend_intent",
    description: "Evaluate a proposed spend first, then produce unsigned EIP-712 SpendIntent data for an external wallet to review and sign. Blocked spends (including unallowlisted payees) never receive a signable payload. This server never holds keys or submits transactions.",
    inputSchema: {
      type: "object",
      required: ["recipient", "amountTusd8", "invoiceRef", "memo"],
      properties: {
        recipient: { type: "string", description: "EVM recipient address." },
        amountTusd8: { type: "string", pattern: "^[0-9]+$", description: "Integer tUSD8 base units; 0.25 tUSD8 = 250000." },
        invoiceRef: { type: "string", description: "Invoice/reference text or 0x-prefixed bytes32." },
        memo: { type: "string" },
        deadlineSeconds: { type: "integer", minimum: 1, maximum: 86400 },
        vaultId: { type: "string" },
        agent: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function objectArgs(value: unknown): ToolArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("arguments must be a JSON object.");
  return value as ToolArguments;
}
function stringArg(args: ToolArguments, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.trim() === "")) throw new Error(`${key} must be a${required ? " non-empty" : ""} string.`);
  return value;
}
function amountArg(args: ToolArguments): string {
  const value = stringArg(args, "amountTusd8", true)!;
  if (!/^\d+$/.test(value)) throw new Error("amountTusd8 must be an integer string in tUSD8 base units.");
  return value;
}

async function callTool(name: string, rawArgs: unknown): Promise<unknown> {
  const args = objectArgs(rawArgs);
  switch (name) {
    case "get_vault_status":
      return getVaultStatus(stringArg(args, "vaultId"), stringArg(args, "agent"));
    case "check_payee_verified":
      return checkPayeeVerified(stringArg(args, "recipient", true)!, stringArg(args, "vaultId"));
    case "simulate_agent_spend":
      return simulateAgentSpend({
        recipient: stringArg(args, "recipient", true)!, amountTusd8: amountArg(args),
        invoiceRef: stringArg(args, "invoiceRef"), memo: stringArg(args, "memo"),
        vaultId: stringArg(args, "vaultId"), agent: stringArg(args, "agent"),
      });
    case "prepare_gasless_spend_intent": {
      const deadlineSeconds = args.deadlineSeconds;
      if (deadlineSeconds !== undefined && (!Number.isInteger(deadlineSeconds) || (deadlineSeconds as number) < 1 || (deadlineSeconds as number) > 86400)) {
        throw new Error("deadlineSeconds must be an integer from 1 to 86400.");
      }
      return prepareGaslessSpendIntent({
        recipient: stringArg(args, "recipient", true)!, amountTusd8: amountArg(args),
        invoiceRef: stringArg(args, "invoiceRef", true)!, memo: stringArg(args, "memo", true)!,
        deadlineSeconds: deadlineSeconds as number | undefined,
        vaultId: stringArg(args, "vaultId"), agent: stringArg(args, "agent"),
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message: unknown) {
  stdout.write(`${JSON.stringify(message)}\n`);
}
function errorResponse(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handle(request: JsonRpcRequest) {
  const hasId = Object.hasOwn(request, "id");
  const id = request.id;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    if (hasId) errorResponse(id, -32600, "Invalid JSON-RPC request");
    return;
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (!hasId) return;
  try {
    switch (request.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aevumguard-mcp", version: "0.1.0" } } });
        return;
      case "ping":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools } });
        return;
      case "tools/call": {
        if (typeof request.params !== "object" || request.params === null) throw new Error("params must be an object.");
        const params = request.params as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") throw new Error("Tool name is required.");
        try {
          const result = await callTool(params.name, params.arguments ?? {});
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true } });
        }
        return;
      }
      default:
        errorResponse(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorResponse(id, -32602, message);
  }
}

const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", (line) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    void handle(request).catch((error: unknown) => stderr.write(`MCP request failed: ${String(error)}\n`));
  } catch {
    errorResponse(null, -32700, "Parse error");
  }
});
