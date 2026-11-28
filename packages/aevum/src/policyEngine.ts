import {
  encodePacked,
  keccak256,
  recoverTypedDataAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

/**
 * Deterministic, browser- and Node-compatible off-chain mirror of
 * `contracts/src/AevumGuardVault.sol` (`_processSpend` + `executeSpendWithSignature`).
 *
 * The engine is pure: it never reads the chain, never signs and never mutates its inputs.
 * `evaluatePolicyStep` returns both the verdict and the state a caller would observe after the
 * transaction (stateful sequences such as split-transaction salami draining rely on that).
 */

export type PolicyVerdict = "PASS_INSTANT" | "ESCALATE_24H_ESCROW" | "BLOCKED_REVERT";

/** Error names exactly as declared by `AevumGuardVault.sol` (plus the two success codes). */
export type AevumGuardErrorCode =
  | "VaultNotFound"
  | "VaultPaused"
  | "ZeroAddress"
  | "ZeroAmount"
  | "IntentExpired"
  | "InvalidNonce"
  | "InvalidAgentSignature"
  | "AgentNotActive"
  | "PolicyExpired"
  | "PayeeNotAllowlisted"
  | "ConfirmationOfPayeeMismatch"
  | "InsufficientVaultBalance"
  | "TotalBudgetExceeded"
  | "SpendLimitExceeded"
  | "SpendExecuted"
  | "SpendQueued";

/** Mirror of `AevumGuardVault.Vault`. `exists` is an off-chain convenience (a real vault always has a non-zero owner). */
export interface VaultSnapshot {
  exists?: boolean;
  owner: Address;
  name?: string;
  balance: bigint;
  reserved: bigint;
  paused: boolean;
  enforceAllowlist: boolean;
}

/** Mirror of `AevumGuardVault.Policy`. */
export interface PolicySnapshot {
  active: boolean;
  label?: string;
  perTxLimit: bigint;
  dailyLimit: bigint;
  totalBudget: bigint;
  spentTotal: bigint;
  spentToday: bigint;
  lastSpendDay: bigint;
  expiresAt: bigint;
  allowQueueOverflow: boolean;
}

/** Mirror of `AevumGuardVault.PayeeInfo`. */
export interface PayeeRecord {
  approved: boolean;
  label?: string;
  confirmationHash: Hex;
}

/** The EIP-712 `SpendIntent` payload exactly as `AevumGuardVault.SpendIntent`. */
export interface SpendIntentPayload {
  vaultId: bigint;
  agent: Address;
  recipient: Address;
  amount: bigint;
  invoiceRef: Hex;
  memo: string;
  nonce: bigint;
  deadline: bigint;
}

/** A `SpendIntent` payload together with its EIP-712 secp256k1 signature. */
export type SignedSpendIntent = SpendIntentPayload & { signature: Hex };

/** One evaluated check, kept for human-readable audit trails. */
export interface PolicyCheckStep {
  /** 1-based evaluation order. */
  step: number;
  name: string;
  outcome: "PASS" | "BLOCKED" | "ESCALATE" | "SKIP";
  detail: string;
}

export interface PolicyEvalResult {
  verdict: PolicyVerdict;
  errorCode: AevumGuardErrorCode;
  /** Contract-style bitmask: bit 0 = per-tx cap, bit 1 = daily cap. */
  reasonBitmask: number;
  humanActionRequired: boolean;
  checks: PolicyCheckStep[];
  /** Name of the check that produced a non-PASS verdict. */
  failedCheck?: string;
  explanation: string;
}

/** State after a step. Feed it back in for stateful (multi-transaction) sequences. */
export interface VaultEngineState {
  vaultId: bigint;
  vault: VaultSnapshot;
  policy: PolicySnapshot;
  agentNonce: bigint;
  /** Id of the pending 24h escrow request created by this step, if any. */
  requestId?: bigint;
}

export interface PolicyEvalInput {
  vaultId: bigint;
  chainId: number;
  verifyingContract: Address;
  agent: Address;
  recipient: Address;
  amount: bigint;
  invoiceRef?: Hex;
  memo?: string;
  /** Block timestamp in seconds. */
  currentTime: bigint;
  vault: VaultSnapshot;
  policy: PolicySnapshot;
  /** Payee allowlist record for `recipient` (if any). */
  payee?: PayeeRecord;
  /** On-chain `agentNonces[agent]` / `VaultEngineState.agentNonce`. */
  expectedNonce?: bigint;
  /** Present when the spend arrives through `executeSpendWithSignature`. */
  signedIntent?: SignedSpendIntent;
  /** Off-chain CoP label to verify against the payee's on-chain confirmation hash. */
  expectedPayeeLabel?: string;
  /**
   * When `true` (default) the returned `nextState` reflects the mutations the contract would
   * commit. When `false` the state is returned untouched (pure dry-run).
   */
  stateful?: boolean;
  /** Optional escrow request id assigned to a queued spend. */
  requestId?: bigint;
}

export interface PolicyEvaluation {
  result: PolicyEvalResult;
  nextState: VaultEngineState;
}

export const ZERO_ADDRESS: Address = zeroAddress;
export const ZERO_HASH: Hex = zeroHash;
export const SECONDS_PER_DAY = 86_400n;

/** EIP-712 types of `AevumGuardVault.SpendIntent` (1:1 with `SPEND_INTENT_TYPEHASH`). */
export const SPEND_INTENT_TYPES = {
  SpendIntent: [
    { name: "vaultId", type: "uint256" },
    { name: "agent", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "invoiceRef", type: "bytes32" },
    { name: "memo", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const SPEND_INTENT_PRIMARY_TYPE = "SpendIntent" as const;

/** EIP-712 domain of `AevumGuardVault` (`AevumGuardVault`, version `1`). */
export function buildSpendIntentDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "AevumGuardVault",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

/**
 * Confirmation of Payee hash. Must equal Solidity
 * `keccak256(abi.encodePacked(label, payee))`.
 */
export function computePayeeConfirmationHash(label: string, payee: Address): Hex {
  return keccak256(encodePacked(["string", "address"], [label, payee]));
}

/** Build the exact request payload the contract hashes during signature recovery. */
export function buildSpendIntentMessage(
  input: Pick<PolicyEvalInput, "vaultId" | "agent" | "recipient" | "amount" | "invoiceRef" | "memo"> &
    Pick<SignedSpendIntent, "nonce" | "deadline">,
): SpendIntentPayload {
  return {
    vaultId: input.vaultId,
    agent: input.agent,
    recipient: input.recipient,
    amount: input.amount,
    invoiceRef: input.invoiceRef ?? ZERO_HASH,
    memo: input.memo ?? "",
    nonce: input.nonce,
    deadline: input.deadline,
  };
}

function cloneVault(vault: VaultSnapshot): VaultSnapshot {
  return { ...vault };
}

function clonePolicy(policy: PolicySnapshot): PolicySnapshot {
  return { ...policy };
}

function snapshotState(input: PolicyEvalInput): VaultEngineState {
  return {
    vaultId: input.vaultId,
    vault: cloneVault(input.vault),
    policy: clonePolicy(input.policy),
    agentNonce: input.expectedNonce ?? 0n,
    requestId: input.requestId,
  };
}

/**
 * Evaluate exactly one spend against the contract's rule set.
 *
 * Order is identical to `executeSpendWithSignature` + `_processSpend`:
 * vault -> pause -> zero address -> zero amount -> signed-intent checks -> mandate -> expiry ->
 * allowlist/CoP -> liquidity -> lifetime budget -> UTC day rollover -> per-tx/daily caps.
 *
 * Async because `viem`'s `recoverTypedDataAddress` is async.
 */
export async function evaluatePolicyStep(input: PolicyEvalInput): Promise<PolicyEvaluation> {
  const checks: PolicyCheckStep[] = [];
  const vaultId = input.vaultId;
  const agent = input.agent;
  const recipient = input.recipient;
  const amount = input.amount;
  const currentTime = input.currentTime;
  const stateful = input.stateful !== false;
  const currentDay = currentTime / SECONDS_PER_DAY;

  const unchangedState = (): VaultEngineState => snapshotState(input);

  const record = (name: string, outcome: PolicyCheckStep["outcome"], detail: string): void => {
    checks.push({ step: checks.length + 1, name, outcome, detail });
  };

  const pass = (name: string, detail: string): void => record(name, "PASS", detail);

  const blocked = (
    name: string,
    errorCode: AevumGuardErrorCode,
    detail: string,
    reasonBitmask = 0,
  ): PolicyEvaluation => {
    record(name, "BLOCKED", detail);
    return {
      result: {
        verdict: "BLOCKED_REVERT",
        errorCode,
        reasonBitmask,
        humanActionRequired: false,
        checks,
        failedCheck: name,
        explanation: detail,
      },
      nextState: unchangedState(),
    };
  };

  const succeeded = (
    verdict: PolicyVerdict,
    errorCode: AevumGuardErrorCode,
    detail: string,
    reasonBitmask: number,
    state: VaultEngineState,
  ): PolicyEvaluation => {
    record(
      verdict === "PASS_INSTANT" ? "Spend limits" : "Spend limits (queued)",
      verdict === "PASS_INSTANT" ? "PASS" : "ESCALATE",
      detail,
    );
    return {
      result: {
        verdict,
        errorCode,
        reasonBitmask,
        humanActionRequired: verdict === "ESCALATE_24H_ESCROW",
        checks,
        explanation: detail,
      },
      nextState: stateful ? state : unchangedState(),
    };
  };

  // 1. Vault exists.
  if (input.vault.exists === false || input.vault.owner.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return blocked("Vault exists", "VaultNotFound", `Vault #${vaultId.toString()} does not exist.`);
  }
  pass("Vault exists", `Vault #${vaultId.toString()} (owner ${input.vault.owner})`);

  // 2. Emergency kill-switch.
  if (input.vault.paused) {
    return blocked("Kill-switch", "VaultPaused", `Vault #${vaultId.toString()} is paused.`);
  }
  pass("Kill-switch", "Vault is not paused");

  // 3. Recipient must not be the zero address.
  if (recipient.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return blocked("Recipient", "ZeroAddress", "Recipient cannot be the zero address.");
  }
  pass("Recipient", recipient);

  // 4. Amount must be positive.
  if (amount <= 0n) {
    return blocked("Amount", "ZeroAmount", "Amount must be greater than zero.");
  }
  pass("Amount", amount.toString());

  // 5. Signed intent: deadline -> nonce -> EIP-712 signature over the ACTUAL request payload.
  if (input.signedIntent) {
    const signed = input.signedIntent;

    if (currentTime > signed.deadline) {
      return blocked(
        "Intent deadline",
        "IntentExpired",
        `Intent deadline ${signed.deadline.toString()} is before current time ${currentTime.toString()}.`,
      );
    }
    pass("Intent deadline", `Valid until ${signed.deadline.toString()}`);

    const expectedNonce = input.expectedNonce ?? 0n;
    if (signed.nonce !== expectedNonce) {
      return blocked(
        "Intent nonce",
        "InvalidNonce",
        `Expected nonce ${expectedNonce.toString()}, got ${signed.nonce.toString()}.`,
      );
    }
    pass("Intent nonce", signed.nonce.toString());

    const message = buildSpendIntentMessage({
      vaultId,
      agent,
      recipient,
      amount,
      invoiceRef: input.invoiceRef,
      memo: input.memo,
      nonce: signed.nonce,
      deadline: signed.deadline,
    });

    let recovered: Address | null = null;
    try {
      recovered = await recoverTypedDataAddress({
        domain: buildSpendIntentDomain(input.chainId, input.verifyingContract),
        types: SPEND_INTENT_TYPES,
        primaryType: SPEND_INTENT_PRIMARY_TYPE,
        message,
        signature: signed.signature,
      });
    } catch {
      recovered = null;
    }

    if (!recovered || recovered.toLowerCase() !== agent.toLowerCase()) {
      return blocked(
        "Agent signature",
        "InvalidAgentSignature",
        `Recovered signer ${recovered ?? "invalid signature"} does not match agent ${agent}.`,
      );
    }
    pass("Agent signature", `Recovered ${recovered}`);
  }

  // 6. Agent mandate is active.
  if (!input.policy.active) {
    return blocked(
      "Agent mandate",
      "AgentNotActive",
      `Agent ${agent} has no active mandate on vault #${vaultId.toString()}.`,
    );
  }
  pass("Agent mandate", input.policy.label ?? "active");

  // 7. Mandate expiry (0 = no expiry).
  if (input.policy.expiresAt !== 0n && currentTime > input.policy.expiresAt) {
    return blocked(
      "Mandate expiry",
      "PolicyExpired",
      `Mandate expired at ${input.policy.expiresAt.toString()} (now ${currentTime.toString()}).`,
    );
  }
  pass(
    "Mandate expiry",
    input.policy.expiresAt === 0n ? "No expiry" : `Valid until ${input.policy.expiresAt.toString()}`,
  );

  // 8. Confirmation of Payee (allowlist + optional off-chain label).
  if (input.vault.enforceAllowlist) {
    if (!input.payee || !input.payee.approved) {
      return blocked(
        "Confirmation of Payee",
        "PayeeNotAllowlisted",
        `Recipient ${recipient} is not on the verified payee allowlist.`,
      );
    }

    if (input.expectedPayeeLabel !== undefined) {
      const expectedHash = computePayeeConfirmationHash(input.expectedPayeeLabel, recipient);
      if (expectedHash.toLowerCase() !== input.payee.confirmationHash.toLowerCase()) {
        return blocked(
          "Confirmation of Payee label",
          "ConfirmationOfPayeeMismatch",
          `Label hash ${expectedHash} does not match on-chain confirmation hash ${input.payee.confirmationHash}.`,
        );
      }
      pass("Confirmation of Payee label", `Matched ${expectedHash}`);
    } else {
      pass("Confirmation of Payee", `Verified payee ${recipient}`);
    }
  } else {
    record("Confirmation of Payee", "SKIP", "Allowlist enforcement is disabled for this vault.");
  }

  // 9. Vault liquidity.
  if (input.vault.balance < amount) {
    return blocked(
      "Vault liquidity",
      "InsufficientVaultBalance",
      `Available ${input.vault.balance.toString()} is below requested ${amount.toString()}.`,
    );
  }
  pass("Vault liquidity", `${input.vault.balance.toString()} available`);

  // 10. Lifetime budget. Overflow NEVER queues: it always reverts.
  if (
    input.policy.totalBudget !== 0n &&
    input.policy.spentTotal + amount > input.policy.totalBudget
  ) {
    return blocked(
      "Lifetime budget",
      "TotalBudgetExceeded",
      `Requested ${amount.toString()} would exceed lifetime budget ${input.policy.totalBudget.toString()} (spent ${input.policy.spentTotal.toString()}).`,
    );
  }
  pass(
    "Lifetime budget",
    input.policy.totalBudget === 0n ? "Unlimited" : `${input.policy.spentTotal.toString()} / ${input.policy.totalBudget.toString()}`,
  );

  // 11. UTC day rollover and per-tx / daily caps.
  const effectiveSpentToday = currentDay > input.policy.lastSpendDay ? 0n : input.policy.spentToday;
  const exceedsPerTx = input.policy.perTxLimit > 0n && amount > input.policy.perTxLimit;
  const exceedsDaily = input.policy.dailyLimit > 0n && effectiveSpentToday + amount > input.policy.dailyLimit;
  const reasonBitmask = (exceedsPerTx ? 1 : 0) | (exceedsDaily ? 2 : 0);

  pass(
    "UTC daily rollover",
    currentDay > input.policy.lastSpendDay
      ? `New UTC day ${currentDay.toString()}; daily usage reset to 0`
      : `Same UTC day ${currentDay.toString()}; ${effectiveSpentToday.toString()} already spent`,
  );

  if (reasonBitmask > 0) {
    if (!input.policy.allowQueueOverflow) {
      return blocked(
        "Spend limits",
        "SpendLimitExceeded",
        `Spend exceeds ${exceedsDaily ? (exceedsPerTx ? "per-transaction and daily" : "daily") : "per-transaction"} limit and overflow queueing is disabled.`,
        reasonBitmask,
      );
    }

    const requestId = input.requestId ?? 0n;
    return succeeded(
      "ESCALATE_24H_ESCROW",
      "SpendQueued",
      `Spend of ${amount.toString()} exceeds ${exceedsDaily ? (exceedsPerTx ? "per-transaction and daily caps" : "daily cap") : "per-transaction cap"}; reserved for 24h human approval.`,
      reasonBitmask,
      {
        vaultId,
        vault: {
          ...cloneVault(input.vault),
          balance: input.vault.balance - amount,
          reserved: input.vault.reserved + amount,
        },
        policy: {
          ...clonePolicy(input.policy),
          spentToday: effectiveSpentToday,
          lastSpendDay: currentDay,
        },
        agentNonce: input.expectedNonce ?? 0n,
        requestId: requestId > 0n ? requestId : undefined,
      },
    );
  }

  const nextState: VaultEngineState = {
    vaultId,
    vault: {
      ...cloneVault(input.vault),
      balance: input.vault.balance - amount,
    },
    policy: {
      ...clonePolicy(input.policy),
      spentTotal: input.policy.spentTotal + amount,
      spentToday: effectiveSpentToday + amount,
      lastSpendDay: currentDay,
    },
    agentNonce: (input.expectedNonce ?? 0n) + 1n,
    requestId: input.requestId,
  };

  return succeeded(
    "PASS_INSTANT",
    "SpendExecuted",
    `Spend of ${amount.toString()} is within all limits and executes immediately.`,
    0,
    nextState,
  );
}
