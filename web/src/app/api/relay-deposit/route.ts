import { NextResponse } from "next/server";
import { BaseError, createPublicClient, createWalletClient, http, isAddress, isHex, parseSignature, type Hex } from "viem";
import { aevumGuardAbi } from "@aevum-kit/aevum";
import { explain } from "@/lib/errors";
import {
  MAX_WINDOW_SECONDS,
  checkIpOrSignerLimit,
  claimInFlight,
  clientIp,
  failJson,
  getRelayerAccount,
  isUintString,
  networkFor,
  overDailyRelayerLimit,
  recordRelayedTx,
  releaseInFlight,
  usableRelayer,
} from "@/lib/relayer";

export const runtime = "nodejs";
const isDev = process.env.NODE_ENV !== "production";

export async function GET(req: Request) {
  const net = networkFor(new URL(req.url).searchParams.get("chainId"));
  const account = net ? usableRelayer(getRelayerAccount(), net) : undefined;
  return NextResponse.json({ enabled: Boolean(account && net?.vault), relayer: account?.address ?? null });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return failJson("Invalid JSON.");
  }

  const net = networkFor(body.chainId);
  if (!net) return failJson("This network isn't enabled in the app.");

  const account = usableRelayer(getRelayerAccount(), net);
  const vaultAddress = net.vault;
  if (!account || !vaultAddress) {
    return failJson(
      isDev
        ? `Gasless deposit relayer is off on ${net.label}. Set RELAYER_PRIVATE_KEY (non-anvil key on testnet) and NEXT_PUBLIC_VAULT_${net.key.toUpperCase()} in web/.env.local.`
        : "Gasless mode is not configured right now. Use Standard mode.",
      503,
    );
  }

  const { vaultId, from, amount, validAfter, validBefore, depositRef, signature } = body;
  if (
    !isUintString(vaultId) ||
    !(typeof from === "string" && isAddress(from)) ||
    !isUintString(amount) ||
    !isUintString(validAfter) ||
    !isUintString(validBefore) ||
    !(typeof depositRef === "string" && isHex(depositRef) && depositRef.length === 66) ||
    !(typeof signature === "string" && isHex(signature))
  ) {
    return failJson("Malformed deposit authorization request.");
  }

  if (BigInt(amount) <= 0n) return failJson("Deposit amount must be greater than zero.");

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(validBefore) > now + MAX_WINDOW_SECONDS) {
    return failJson("Authorization window is too long (max 1 hour).");
  }

  const limitErr = checkIpOrSignerLimit(clientIp(req), from);
  if (limitErr) return failJson(limitErr, 429);

  let v: bigint | undefined, r: Hex, s: Hex, yParity: number | undefined;
  try {
    ({ v, r, s, yParity } = parseSignature(signature));
  } catch {
    return failJson("Invalid signature.");
  }
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);

  const flightKey = `${net.chain.id}:dep:${vaultId}:${depositRef.toLowerCase()}`;
  if (!claimInFlight(flightKey)) return failJson("This deposit authorization is already being submitted.", 409);

  const transport = http();
  const client = createPublicClient({ chain: net.chain, transport });
  const wallet = createWalletClient({ account, chain: net.chain, transport });

  try {
    if (overDailyRelayerLimit()) {
      releaseInFlight(flightKey);
      return failJson("The relayer reached its daily transaction cap. Use Standard mode.", 503);
    }

    const call = {
      account,
      address: vaultAddress,
      abi: aevumGuardAbi,
      functionName: "depositWithAuthorization",
      args: [
        {
          vaultId: BigInt(vaultId),
          from,
          amount: BigInt(amount),
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
          depositRef,
          v: vNum,
          r,
          s,
        },
      ],
    } as const;

    await client.simulateContract(call);
    const hash = await wallet.writeContract({ ...call, type: "legacy" });
    recordRelayedTx();
    return NextResponse.json({ hash });
  } catch (e) {
    releaseInFlight(flightKey);
    if (e instanceof BaseError && /insufficient funds/i.test(e.message)) {
      console.error("[relay-deposit] relayer out of gas", account.address);
      return failJson("The relayer wallet is out of tQDAY gas. Use Standard mode.", 503);
    }
    return failJson(explain(e));
  }
}
