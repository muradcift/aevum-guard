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
        ? `Gasless AI agent relayer is off on ${net.label}. Set RELAYER_PRIVATE_KEY (non-anvil key on testnet) and NEXT_PUBLIC_VAULT_${net.key.toUpperCase()} in web/.env.local.`
        : "Gasless spend relay is not available right now. Use Direct mode.",
      503,
    );
  }

  const rawIntent = body.intent as Record<string, unknown> | undefined;
  const signature = body.signature;
  if (
    !rawIntent ||
    !isUintString(rawIntent.vaultId) ||
    !(typeof rawIntent.agent === "string" && isAddress(rawIntent.agent)) ||
    !(typeof rawIntent.recipient === "string" && isAddress(rawIntent.recipient)) ||
    !isUintString(rawIntent.amount) ||
    !(typeof rawIntent.invoiceRef === "string" && isHex(rawIntent.invoiceRef) && rawIntent.invoiceRef.length === 66) ||
    typeof rawIntent.memo !== "string" ||
    rawIntent.memo.length > 280 ||
    !isUintString(rawIntent.nonce) ||
    !isUintString(rawIntent.deadline) ||
    !(typeof signature === "string" && isHex(signature))
  ) {
    return failJson("Malformed agent spend intent.");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(rawIntent.deadline) > now + MAX_WINDOW_SECONDS) {
    return failJson("Spend intent deadline is too long (max 1 hour).");
  }

  const limitErr = checkIpOrSignerLimit(clientIp(req), rawIntent.agent);
  if (limitErr) return failJson(limitErr, 429);

  let v: bigint | undefined, r: Hex, s: Hex, yParity: number | undefined;
  try {
    ({ v, r, s, yParity } = parseSignature(signature));
  } catch {
    return failJson("Invalid EIP-712 signature.");
  }
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);

  const flightKey = `${net.chain.id}:spend:${rawIntent.agent.toLowerCase()}:${rawIntent.nonce}`;
  if (!claimInFlight(flightKey)) return failJson("This agent nonce is already being submitted.", 409);

  const transport = http();
  const client = createPublicClient({ chain: net.chain, transport });
  const wallet = createWalletClient({ account, chain: net.chain, transport });

  try {
    if (overDailyRelayerLimit()) {
      releaseInFlight(flightKey);
      return failJson("The relayer reached its daily transaction cap. Use Direct mode.", 503);
    }

    const call = {
      account,
      address: vaultAddress,
      abi: aevumGuardAbi,
      functionName: "executeSpendWithSignature",
      args: [
        {
          vaultId: BigInt(rawIntent.vaultId),
          agent: rawIntent.agent,
          recipient: rawIntent.recipient,
          amount: BigInt(rawIntent.amount),
          invoiceRef: rawIntent.invoiceRef,
          memo: rawIntent.memo,
          nonce: BigInt(rawIntent.nonce),
          deadline: BigInt(rawIntent.deadline),
        },
        vNum,
        r,
        s,
      ],
    } as const;

    await client.simulateContract(call);
    const hash = await wallet.writeContract({ ...call, type: "legacy" });
    recordRelayedTx();
    return NextResponse.json({ hash });
  } catch (e) {
    releaseInFlight(flightKey);
    if (e instanceof BaseError && /insufficient funds/i.test(e.message)) {
      console.error("[relay-spend] relayer out of gas", account.address);
      return failJson("The relayer wallet is out of tQDAY gas. Use Direct mode.", 503);
    }
    return failJson(explain(e));
  }
}
