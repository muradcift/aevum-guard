import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatUnits } from "viem";
import { TUSD8_DECIMALS } from "@aevum-kit/aevum";

function fmt(v: unknown): string {
  if (typeof v === "bigint") return formatUnits(v, TUSD8_DECIMALS);
  return String(v ?? "");
}

/** Decodes AevumGuardVault custom errors, EIP-3009 errors, and wallet/RPC errors into clear actionable text. */
export function explain(error: unknown): string {
  if (!(error instanceof Error)) return "Something went wrong. Try again.";

  const dup = /same RPC endpoint as existing network for chain \w+ \('([^']*)'\)/.exec(fullMessage(error));
  if (dup) {
    return `Your wallet already has a network ("${dup[1]}") using the same RPC URL. Edit or remove it in your wallet, then try again.`;
  }

  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return "Request cancelled in wallet. Nothing was submitted.";
    }
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const args = (revert.data?.args ?? []) as readonly unknown[];
      switch (name) {
        case "VaultPaused":
          return `Blocked: Vault #${args[0] ?? ""} is frozen by its emergency Kill-Switch.`;
        case "PayeeNotAllowlisted":
          return `Blocked by Confirmation of Payee: ${args[0] ?? "recipient"} is not on the verified allowlist.`;
        case "SpendLimitExceeded":
          return `Blocked by Spend Policy: requested ${fmt(args[0])} tUSD8 exceeds per-tx limit (${fmt(args[1])}) or remaining daily limit (${fmt(args[2])}).`;
        case "TotalBudgetExceeded":
          return `Blocked by Total Budget Cap: only ${fmt(args[0])} tUSD8 remains in agent's lifetime budget (requested ${fmt(args[1])}).`;
        case "PolicyExpired":
          return "Blocked: this AI agent mandate has expired.";
        case "AgentNotActive":
          return "Blocked: this address does not have an active AI agent mandate on this vault.";
        case "InsufficientVaultBalance":
          return `Insufficient vault available balance (${fmt(args[0])} tUSD8 available, ${fmt(args[1])} required).`;
        case "NotVaultOwner":
          return "Only the vault owner can perform this action.";
        case "VaultNotFound":
          return `Vault #${args[0] ?? ""} does not exist.`;
        case "InvalidAgentSignature":
          return "Invalid EIP-712 agent signature for this spend intent.";
        case "InvalidNonce":
          return `Agent nonce mismatch (expected ${args[0]}, got ${args[1]}). Refresh and sign again.`;
        case "IntentExpired":
          return "Signed SpendIntent deadline has expired. Sign a fresh intent.";
        case "RequestExpired":
          return "This approval request expired (24h TTL). Cancel it to unlock funds back into the vault.";
        case "RequestNotPending":
          return "This request was already approved, rejected, or cancelled.";
        case "RequestNotFound":
          return `Spend request #${args[0] ?? ""} was not found.`;
        case "ZeroAmount":
          return "Amount must be greater than zero.";
        case "ZeroAddress":
          return "Address cannot be the zero address.";
        case "AuthorizationUsedAlready":
          return "This EIP-3009 deposit authorization was already used.";
        case "AuthorizationExpired":
          return "EIP-3009 deposit authorization expired. Sign again.";
        case "InvalidSignature":
          return "Invalid EIP-3009 token signature.";
      }
      const reason = revert.reason ?? "";
      if (/invalid signature/i.test(reason)) return "Invalid signature. Check network and sign again.";
      if (/expired/i.test(reason)) return "Signature expired before submission. Sign again.";
      if (/exceeds balance|insufficient/i.test(reason)) return "Insufficient tUSD8 balance in wallet.";
      if (/allowance/i.test(reason)) return "Token allowance is lower than the requested deposit.";
      if (reason) return reason;
    }
    if (/insufficient funds/i.test(error.message)) {
      return "Not enough tQDAY for gas. Claim free tokens in QDay Discord (/faucet) or use Gasless mode.";
    }
    return error.shortMessage || error.message || "The request failed. Check the network and try again.";
  }

  return error.message || "Something went wrong. Try again.";
}

function fullMessage(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 5) return "";
  const e = error as { message?: unknown; details?: unknown; cause?: unknown; data?: { cause?: unknown; message?: unknown } };
  return [e.message, e.details, e.data?.message, fullMessage(e.cause, depth + 1), fullMessage(e.data?.cause, depth + 1)]
    .filter((m) => typeof m === "string" && m)
    .join(" | ");
}
