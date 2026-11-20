import type { Address, Hex } from "viem";

export interface VaultView {
  owner: Address;
  name: string;
  balance: bigint;
  reserved: bigint;
  paused: boolean;
  enforceAllowlist: boolean;
}

export interface PolicyView {
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

export interface PayeeView {
  approved: boolean;
  label: string;
  confirmationHash: Hex;
}

export interface SpendRequestView {
  requestId: bigint;
  vaultId: bigint;
  agent: Address;
  recipient: Address;
  amount: bigint;
  invoiceRef: Hex;
  memo: string;
  createdAt: bigint;
  expiresAt: bigint;
  reasonCode: number;
  status: number;
}

export interface ActionFeedback {
  tone: "good" | "warn" | "bad";
  title: string;
  detail: string;
  txHash?: Hex;
}
