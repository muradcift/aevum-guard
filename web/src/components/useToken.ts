"use client";

import { aevumGuardAbi, erc20Abi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/**
 * Payment token used by AevumGuardVault: reads `vault.token()` when configured
 * (supports MockUSD8 on local anvil too), otherwise falls back to Aevum tUSD8.
 */
export function useToken() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const vaultAddress = net.vault;

  const fromVault = useReadContract({
    address: vaultAddress,
    abi: aevumGuardAbi,
    functionName: "token",
    chainId: appChain.id,
    query: { enabled: Boolean(vaultAddress) },
  });

  const address: Address | undefined = fromVault.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);

  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId: appChain.id },
          { address, abi: erc20Abi, functionName: "symbol", chainId: appChain.id },
        ]
      : [],
    query: { enabled: Boolean(address) },
  });

  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromVault.isLoading || meta.isLoading };
}
