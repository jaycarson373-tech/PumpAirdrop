import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { withRetry } from "./retry.js";
import { NATIVE_SOL_MINT } from "./solana.js";

export type JupiterOrderResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  outUsdValue?: number;
  priceImpact?: number;
  transaction?: string;
  requestId?: string;
  lastValidBlockHeight?: string;
  error?: string;
  errorMessage?: string;
};

export type JupiterExecuteResponse = {
  status?: "Success" | "Failed";
  signature?: string;
  slot?: string;
  error?: string;
  code?: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
};

function buildOrderUrl(config: AppConfig, params: Record<string, string>): URL {
  const url = new URL(`${config.jupiterApiUrl}/order`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  let data: unknown;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} failed ${response.status}: ${JSON.stringify(data)}`);
  }

  return data as T;
}

export async function getPumpOrder(params: {
  config: AppConfig;
  taker: PublicKey;
  amountSol: number;
}): Promise<JupiterOrderResponse> {
  const { config, taker, amountSol } = params;
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL).toString();
  const url = buildOrderUrl(config, {
    inputMint: NATIVE_SOL_MINT.toBase58(),
    outputMint: config.pumpTokenMint.toBase58(),
    amount: amountLamports,
    taker: taker.toBase58(),
    swapMode: "ExactIn",
    slippageBps: String(config.slippageBps)
  });

  return withRetry("Jupiter order", async () => {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": config.jupiterApiKey
      }
    });
    const order = await parseJsonResponse<JupiterOrderResponse>(response, "Jupiter order");

    if (order.error || order.errorMessage) {
      throw new Error(`Jupiter order error: ${order.error ?? order.errorMessage}`);
    }

    return order;
  });
}

export async function swapSolToPump(params: {
  config: AppConfig;
  wallet: Keypair;
  amountSol: number;
}): Promise<string | null> {
  const { config, wallet, amountSol } = params;
  const order = await getPumpOrder({
    config,
    taker: wallet.publicKey,
    amountSol
  });

  log("info", "Jupiter swap order received", {
    amountSol,
    inputLamports: order.inAmount,
    estimatedPumpOut: order.outAmount,
    outUsdValue: order.outUsdValue ?? null,
    priceImpact: order.priceImpact ?? null,
    requestId: order.requestId ?? null,
    dryRun: config.dryRun
  });

  if (config.dryRun) {
    log("info", "dry run: would sign and execute Jupiter SOL to PUMP swap", {
      amountSol,
      requestId: order.requestId ?? null
    });
    return null;
  }

  if (!order.transaction || !order.requestId) {
    throw new Error("Jupiter order did not include transaction/requestId");
  }

  const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  transaction.sign([wallet]);
  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");

  const executeResponse = await withRetry("Jupiter execute", async () => {
    const response = await fetch(`${config.jupiterApiUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.jupiterApiKey
      },
      body: JSON.stringify({
        signedTransaction,
        requestId: order.requestId,
        lastValidBlockHeight: order.lastValidBlockHeight
      })
    });

    return parseJsonResponse<JupiterExecuteResponse>(response, "Jupiter execute");
  });

  if (executeResponse.status === "Failed" || executeResponse.error) {
    throw new Error(`Jupiter execute failed: ${executeResponse.error ?? executeResponse.code}`);
  }

  log("info", "Jupiter SOL to PUMP swap executed", {
    signature: executeResponse.signature,
    slot: executeResponse.slot,
    totalInputAmount: executeResponse.totalInputAmount,
    totalOutputAmount: executeResponse.totalOutputAmount
  });

  return executeResponse.signature ?? null;
}
