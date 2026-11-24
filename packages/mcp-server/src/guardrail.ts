import {
  aevumGuardAbi,
  aevumGuardDomain,
  aevumTestnet,
  spendIntentTypes,
} from "@aevum-kit/aevum";
import {
  createPublicClient,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const TOKEN_DECIMALS = 6;
const DEFAULT_VAULT = "0x4E5Ed4Dc7E5e525f4D77c2cC2749870De9f6851e" as Address;
const DEFAULT_AGENT = "0xCE45f546D53746acabB6FB34c87AFE6433A83b3a" as Address;
const EXPLORER_CONTRACT_URL = `https://explorer-test.qday.info/address/${process.env.AEVUM_VAULT_ADDRESS ?? DEFAULT_VAULT}`;

const configuredChain = {
  ...aevumTestnet,
  rpcUrls: { default: { http: [process.env.AEVUM_RPC_URL ?? "https://rpc-test.qday.info"] } },
};

export const publicClient = createPublicClient({
  chain: configuredChain,
  transport: http(process.env.AEVUM_RPC_URL ?? "https://rpc-test.qday.info"),
});

export const vaultAddress = (process.env.AEVUM_VAULT_ADDRESS ?? DEFAULT_VAULT) as Address;
export const defaultVaultId = BigInt(process.env.AEVUM_VAULT_ID ?? "1");
export const defaultAgent = (process.env.AEVUM_AGENT_ADDRESS ?? DEFAULT_AGENT) as Address;

interface VaultView {
  owner: Address;
  name: string;
  balance: bigint;
  reserved: bigint;
  paused: boolean;
  enforceAllowlist: boolean;
}
interface PolicyView {
  active: boolean;
  label: string;
  perTxLimit: bigint;
  dailyLimit: bigint;
  totalBudget: bigint;
  spentTotal: bigint;
  spentToday: bigint;
  lastSpendDay: bigint;
  expiresAt: bigint;
  allowQueueOverflow: boolean;
}
interface PayeeView { approved: boolean; label: string; confirmationHash: Hex }

const readVault = (vaultId: bigint) => publicClient.readContract({
  address: vaultAddress, abi: aevumGuardAbi, functionName: "getVault", args: [vaultId],
}) as Promise<VaultView>;
const readPolicy = (vaultId: bigint, agent: Address) => publicClient.readContract({
  address: vaultAddress, abi: aevumGuardAbi, functionName: "getPolicy", args: [vaultId, agent],
}) as Promise<PolicyView>;
const readPayee = (vaultId: bigint, recipient: Address) => publicClient.readContract({
  address: vaultAddress, abi: aevumGuardAbi, functionName: "getPayee", args: [vaultId, recipient],
}) as Promise<PayeeView>;
const remainingDaily = (vaultId: bigint, agent: Address) => publicClient.readContract({
  address: vaultAddress, abi: aevumGuardAbi, functionName: "remainingDailyLimit", args: [vaultId, agent],
});
const display = (value: bigint) => formatUnits(value, TOKEN_DECIMALS);

function requireAddress(value: string, name: string): Address {
  if (!isAddress(value)) throw new Error(`${name} must be a valid EVM address.`);
  return value as Address;
}
function parseVaultId(value?: bigint | string): bigint {
  const id = value === undefined ? defaultVaultId : BigInt(value);
  if (id < 0n) throw new Error("vaultId must be non-negative.");
  return id;
}
function invoiceReference(ref: string): Hex {
  const clean = ref.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(clean)) return clean as Hex;
  return keccak256(stringToHex(clean));
}

export async function getVaultStatus(vaultId?: bigint | string, agentInput?: string) {
  const id = parseVaultId(vaultId);
  const agent = agentInput ? requireAddress(agentInput, "agent") : defaultAgent;
  const [vault, policy, dailyQuotaLeft] = await Promise.all([
    readVault(id), readPolicy(id, agent), remainingDaily(id, agent),
  ]);
  const available = vault.balance;
  const reserved = vault.reserved;
  return {
    chainId: 44005,
    vaultId: id.toString(),
    vaultAddress,
    vaultName: vault.name,
    owner: vault.owner,
    agent,
    available: display(available),
    reserved: display(reserved),
    totalLiquidity: display(available + reserved),
    availableRaw: available.toString(),
    reservedRaw: reserved.toString(),
    totalLiquidityRaw: (available + reserved).toString(),
    caps: {
      perTransaction: display(policy.perTxLimit),
      daily: display(policy.dailyLimit),
      lifetime: policy.totalBudget === 0n ? null : display(policy.totalBudget),
    },
    dailyQuotaLeft: display(dailyQuotaLeft),
    lifetimeUsed: display(policy.spentTotal),
    nonce: (await publicClient.readContract({
      address: vaultAddress, abi: aevumGuardAbi, functionName: "agentNonces", args: [agent],
    })).toString(),
    paused: vault.paused,
    strictPayees: vault.enforceAllowlist,
    mandateActive: policy.active,
    mandateLabel: policy.label,
    mandateExpiresAt: policy.expiresAt.toString(),
    allowQueueOverflow: policy.allowQueueOverflow,
  };
}

export async function checkPayeeVerified(recipientInput: string, vaultId?: bigint | string) {
  const recipient = requireAddress(recipientInput, "recipient");
  const id = parseVaultId(vaultId);
  const [payee, vault] = await Promise.all([readPayee(id, recipient), readVault(id)]);
  return {
    recipient,
    verified: payee.approved,
    label: payee.label,
    labelHash: payee.confirmationHash,
    strictPayees: vault.enforceAllowlist,
  };
}

export type SpendVerdict = "PASS_INSTANT" | "ESCALATE_24H_ESCROW" | "BLOCKED_REVERT";
export interface SpendSimulation {
  verdict: SpendVerdict;
  reasonCode: string;
  explanation: string;
  checks: Array<{ name: string; outcome: "PASS" | "ESCALATE" | "BLOCKED"; detail: string }>;
  humanActionRequired: boolean;
  explorerContractUrl: string;
}

export async function simulateAgentSpend(input: {
  recipient: string;
  amountTusd8: bigint | string;
  invoiceRef?: string;
  memo?: string;
  vaultId?: bigint | string;
  agent?: string;
}): Promise<SpendSimulation> {
  const recipient = requireAddress(input.recipient, "recipient");
  const amount = BigInt(input.amountTusd8);
  const id = parseVaultId(input.vaultId);
  const agent = input.agent ? requireAddress(input.agent, "agent") : defaultAgent;
  const checks: SpendSimulation["checks"] = [];
  const result = (verdict: SpendVerdict, reasonCode: string, explanation: string, humanActionRequired = false): SpendSimulation => ({
    verdict, reasonCode, explanation, checks, humanActionRequired, explorerContractUrl: EXPLORER_CONTRACT_URL,
  });
  const [vault, policy, payee, dailyLeft, block] = await Promise.all([
    readVault(id), readPolicy(id, agent), readPayee(id, recipient), remainingDaily(id, agent), publicClient.getBlock({ blockTag: "latest" }),
  ]);
  const now = block.timestamp;
  const fail = (name: string, code: string, explanation: string) => {
    checks.push({ name, outcome: "BLOCKED", detail: code });
    return result("BLOCKED_REVERT", code, explanation);
  };

  if (vault.owner.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return fail("Vault exists", "VaultNotFound", `Vault #${id} does not exist.`);
  checks.push({ name: "Vault exists", outcome: "PASS", detail: vault.name || `Vault #${id}` });
  if (vault.paused) return fail("Kill-switch", "VaultPaused", "Vault is paused by its emergency kill-switch.");
  checks.push({ name: "Kill-switch", outcome: "PASS", detail: "Vault is not paused" });
  if (recipient.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return fail("Recipient", "ZeroAddress", "Recipient cannot be the zero address.");
  if (amount <= 0n) return fail("Amount", "ZeroAmount", "Amount must be greater than zero.");
  if (!policy.active) return fail("Agent mandate", "AgentNotActive", "This agent has no active mandate for the vault.");
  checks.push({ name: "Agent mandate", outcome: "PASS", detail: policy.label || "Active" });
  if (policy.expiresAt !== 0n && now > policy.expiresAt) return fail("Mandate expiry", "PolicyExpired", "The agent mandate has expired.");
  checks.push({ name: "Mandate expiry", outcome: "PASS", detail: policy.expiresAt === 0n ? "No expiry" : "Not expired" });
  if (vault.enforceAllowlist && !payee.approved) return fail("Confirmation of Payee", "PayeeNotAllowlisted", "Recipient is not on the verified payee allowlist; no signable intent is produced.");
  checks.push({ name: "Confirmation of Payee", outcome: "PASS", detail: vault.enforceAllowlist ? `Verified: ${payee.label || recipient}` : "Allowlist enforcement is off" });
  if (vault.balance < amount) return fail("Vault liquidity", "InsufficientVaultBalance", `Available ${display(vault.balance)} tUSD8 is below requested ${display(amount)} tUSD8.`);
  checks.push({ name: "Vault liquidity", outcome: "PASS", detail: `${display(vault.balance)} tUSD8 available` });
  if (policy.totalBudget !== 0n && policy.spentTotal + amount > policy.totalBudget) return fail("Lifetime cap", "TotalBudgetExceeded", "Spend would exceed the agent's lifetime budget.");
  checks.push({ name: "Lifetime cap", outcome: "PASS", detail: policy.totalBudget === 0n ? "No lifetime cap" : `${display(policy.spentTotal)} / ${display(policy.totalBudget)} tUSD8 used` });

  // Uses the contract's own helper, which applies the exact UTC day-number rollover rule.
  const currentDay = now / 86400n;
  const effectiveSpentToday = currentDay > policy.lastSpendDay ? 0n : policy.spentToday;
  const dailyQuota = dailyLeft as bigint;
  const exceedsPerTx = amount > policy.perTxLimit;
  const exceedsDaily = amount > dailyQuota;
  checks.push({ name: "UTC daily rollover", outcome: "PASS", detail: `${display(effectiveSpentToday)} tUSD8 counted today; ${display(dailyQuota)} tUSD8 quota remains` });
  checks.push({ name: "Per-transaction cap", outcome: exceedsPerTx ? "ESCALATE" : "PASS", detail: `${display(amount)} / ${display(policy.perTxLimit)} tUSD8` });
  checks.push({ name: "Daily cap", outcome: exceedsDaily ? "ESCALATE" : "PASS", detail: `${display(amount)} requested; ${display(dailyQuota)} tUSD8 remains` });
  if (!exceedsPerTx && !exceedsDaily) return result("PASS_INSTANT", "WithinLimits", "Spend passes all live guardrails and would settle immediately.");
  if (!policy.allowQueueOverflow) return fail("Queue overflow", "SpendLimitExceeded", "The spend exceeds a limit and this mandate does not permit escrow queueing.");
  checks.push({ name: "Queue overflow", outcome: "ESCALATE", detail: "Mandate permits 24-hour human-approval escrow" });
  const reason = exceedsPerTx && exceedsDaily ? "per-transaction and remaining daily caps" : exceedsPerTx ? "per-transaction cap" : "remaining daily cap";
  return result("ESCALATE_24H_ESCROW", exceedsPerTx && exceedsDaily ? "PerTxAndDailyLimit" : exceedsPerTx ? "PerTxLimit" : "DailyLimit", `Spend exceeds the ${reason}; funds would be reserved in the 24-hour approval escrow.`, true);
}

export async function prepareGaslessSpendIntent(input: {
  recipient: string;
  amountTusd8: bigint | string;
  invoiceRef: string;
  memo: string;
  deadlineSeconds?: number;
  vaultId?: bigint | string;
  agent?: string;
}) {
  const simulation = await simulateAgentSpend(input);
  if (simulation.verdict === "BLOCKED_REVERT") return { allowed: false as const, blocked: true as const, verdict: simulation.verdict, reasonCode: simulation.reasonCode, simulation };
  const vaultId = parseVaultId(input.vaultId);
  const agent = input.agent ? requireAddress(input.agent, "agent") : defaultAgent;
  const recipient = requireAddress(input.recipient, "recipient");
  const nonce = await publicClient.readContract({ address: vaultAddress, abi: aevumGuardAbi, functionName: "agentNonces", args: [agent] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (input.deadlineSeconds ?? 600));
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("deadlineSeconds must produce a future deadline.");
  const ref = invoiceReference(input.invoiceRef);
  const message = {
    vaultId,
    agent,
    recipient,
    amount: BigInt(input.amountTusd8),
    invoiceRef: ref,
    memo: input.memo,
    nonce,
    deadline,
  };
  return {
    allowed: true as const,
    verdict: simulation.verdict,
    simulation,
    eip712: {
      domain: aevumGuardDomain(44005, vaultAddress),
      types: spendIntentTypes,
      primaryType: "SpendIntent" as const,
      message: Object.fromEntries(Object.entries(message).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
    },
  };
}

export const parseTusd8 = (value: string) => parseUnits(value, TOKEN_DECIMALS);
