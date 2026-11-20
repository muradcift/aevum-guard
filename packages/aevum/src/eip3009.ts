import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { aevumGuardDomain, tusd8Domain } from "./contracts";

/** EIP-712 types for the message a buyer signs to pay `Checkout.payWithAuthorization`. */
export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface CheckoutAuthorization {
  from: Address;
  /** Must be the Checkout contract. */
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** Must be `Checkout.authorizationNonce(orderId)`. */
  nonce: Hex;
}

/**
 * Typed data for `signTypedData` (viem / wagmi). Pass the result straight to the wallet.
 *
 *   const sig = await walletClient.signTypedData({ account, ...checkoutTypedData(...) })
 */
export function checkoutTypedData(chainId: number, token: Address, message: CheckoutAuthorization) {
  return {
    domain: tusd8Domain(chainId, token),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization" as const,
    message,
  };
}

/** A signature window that is valid at once (validAfter = 0, so clock drift can't reject it) and lasts `seconds`. */
export function authorizationWindow(seconds = 600, nowMs = Date.now()) {
  const now = BigInt(Math.floor(nowMs / 1000));
  return { validAfter: 0n, validBefore: now + BigInt(seconds) };
}

/** Matches AevumGuardVault.depositNonce(vaultId, depositRef) so EIP-3009 auth is bound to a specific vault. */
export function computeDepositNonce(vaultAddress: Address, vaultId: bigint, depositRef: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "uint256" }, { type: "bytes32" }],
      [vaultAddress, "AEVUM_GUARD_DEPOSIT", vaultId, depositRef],
    ),
  );
}

/** EIP-3009 typed data for gasless AevumGuardVault deposits via `depositWithAuthorization`. */
export function depositAuthTypedData(chainId: number, token: Address, message: CheckoutAuthorization) {
  return checkoutTypedData(chainId, token, message);
}

export const spendIntentTypes = {
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

export interface SpendIntentMessage {
  vaultId: bigint;
  agent: Address;
  recipient: Address;
  amount: bigint;
  invoiceRef: Hex;
  memo: string;
  nonce: bigint;
  deadline: bigint;
}

/** EIP-712 typed data for gasless AI agent spends via `AevumGuardVault.executeSpendWithSignature`. */
export function spendIntentTypedData(chainId: number, vaultAddress: Address, message: SpendIntentMessage) {
  return {
    domain: aevumGuardDomain(chainId, vaultAddress),
    types: spendIntentTypes,
    primaryType: "SpendIntent" as const,
    message,
  };
}
