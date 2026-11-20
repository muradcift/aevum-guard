import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { isHex, type Hex } from "viem";

const STORAGE_KEY = "aevum-guard:demo-agent-pk";

/**
 * Ephemeral browser-local test key used ONLY so judges/operators can authorize an AI agent
 * and execute real EIP-712 gasless `executeSpendWithSignature` transactions on testnet/fork
 * without switching MetaMask accounts or funding the agent with tQDAY gas.
 */
export function loadOrCreateDemoAgent(): PrivateKeyAccount | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing && isHex(existing) && existing.length === 66) {
      return privateKeyToAccount(existing as Hex);
    }
    const fresh = generatePrivateKey();
    window.localStorage.setItem(STORAGE_KEY, fresh);
    return privateKeyToAccount(fresh);
  } catch {
    return privateKeyToAccount(generatePrivateKey());
  }
}

export function rotateDemoAgent(): PrivateKeyAccount | null {
  if (typeof window === "undefined") return null;
  const fresh = generatePrivateKey();
  try {
    window.localStorage.setItem(STORAGE_KEY, fresh);
  } catch {
    // Ignore storage restriction; ephemeral in-memory account still works for this session.
  }
  return privateKeyToAccount(fresh);
}
