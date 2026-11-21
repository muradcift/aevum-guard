import { isAddress, type Address, type Chain } from "viem";
import { aevumFork, aevumTestnet, localAnvil } from "@aevum-kit/aevum";

export type NetworkKey = "aevum" | "fork" | "local";

export interface Network {
  key: NetworkKey;
  /** Short name for the network switcher. */
  label: string;
  chain: Chain;
  /** Deployed AevumGuardVault on this network, if configured. */
  vault?: Address;
  /** Only scan audit logs from this block onward. */
  deployBlock?: bigint;
  /** Explorer links only apply on the live testnet. */
  hasExplorer: boolean;
}

const address = (v: string | undefined): Address | undefined =>
  v && isAddress(v.trim()) ? (v.trim() as Address) : undefined;
const block = (v: string | undefined): bigint | undefined =>
  v && /^\d+$/.test(v.trim()) ? BigInt(v.trim()) : undefined;

const all: Record<NetworkKey, Network> = {
  aevum: {
    key: "aevum",
    label: "Aevum testnet",
    chain: aevumTestnet,
    vault: address(process.env.NEXT_PUBLIC_VAULT_AEVUM),
    deployBlock: block(process.env.NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM),
    hasExplorer: true,
  },
  fork: {
    key: "fork",
    label: "Local fork",
    chain: aevumFork,
    vault: address(process.env.NEXT_PUBLIC_VAULT_FORK),
    deployBlock: block(process.env.NEXT_PUBLIC_DEPLOY_BLOCK_FORK),
    hasExplorer: false,
  },
  local: {
    key: "local",
    label: "Local anvil",
    chain: localAnvil,
    vault: address(process.env.NEXT_PUBLIC_VAULT_LOCAL),
    deployBlock: undefined,
    hasExplorer: false,
  },
};

const requested = (process.env.NEXT_PUBLIC_NETWORKS ?? "aevum,fork")
  .split(",")
  .map((k) => k.trim())
  // Object.hasOwn, not `in`: values like "toString" would otherwise resolve to
  // Object.prototype members and produce a broken Network object.
  .filter((k) => Object.hasOwn(all, k)) as NetworkKey[];

export const networks: [Network, ...Network[]] = (() => {
  const keys = [...new Set(requested)];
  const list = (keys.length ? keys : (["aevum", "fork"] as NetworkKey[])).map((k) => all[k]);
  return list as [Network, ...Network[]];
})();

export const defaultNetwork = networks[0];

export function networkByChainId(chainId: number | undefined): Network | undefined {
  return networks.find((n) => n.chain.id === chainId);
}

export function networkByKey(key: string | null | undefined): Network | undefined {
  return networks.find((n) => n.key === key);
}

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

export const repoUrl = (
  process.env.NEXT_PUBLIC_REPO_URL?.trim() || "https://github.com/muradcift/aevum-guard"
).replace(/\.git$|\/+$/g, "");
