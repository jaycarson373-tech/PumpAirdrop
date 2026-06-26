import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction
} from "@solana/web3.js";
import { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { withRetry } from "./retry.js";
import { NATIVE_SOL_MINT } from "./solana.js";

export type JupiterQuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
  error?: string;
};

export type JupiterSwapResponse = {
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
  error?: string;
};

function buildQuoteUrl(config: AppConfig, params: Record<string, string>): URL {
  const url = new URL(`${config.jupiterApiUrl}/quote`);
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

export async function getPumpQuote(params: {
  config: AppConfig;
  amountSol: number;
}): Promise<JupiterQuoteResponse> {
  const { config, amountSol } = params;
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL).toString();
  const url = buildQuoteUrl(config, {
    inputMint: NATIVE_SOL_MINT.toBase58(),
    outputMint: config.pumpTokenMint.toBase58(),
    amount: amountLamports,
    swapMode: "ExactIn",
    slippageBps: String(config.slippageBps)
  });

  return withRetry("Jupiter quote", async () => {
    const response = await fetch(url, { method: "GET" });
    const quote = await parseJsonResponse<JupiterQuoteResponse>(response, "Jupiter quote");

    if (quote.error) {
      throw new Error(`Jupiter quote error: ${quote.error}`);
    }

    return quote;
  });
}

export async function swapSolToPump(params: {
  config: AppConfig;
  connection: Connection;
  wallet: Keypair;
  amountSol: number;
}): Promise<string | null> {
  const { config, connection, wallet, amountSol } = params;
  const quote = await getPumpQuote({
    config,
    amountSol
  });

  log("info", "Jupiter swap quote received", {
    amountSol,
    inputLamports: quote.inAmount,
    estimatedPumpOut: quote.outAmount,
    priceImpactPct: quote.priceImpactPct ?? null,
    dryRun: config.dryRun
  });

  if (config.dryRun) {
    log("info", "dry run: would request Jupiter transaction, sign it, and send via RPC", { amountSol });
    return null;
  }

  const swapResponse = await withRetry("Jupiter swap transaction", async () => {
    const response = await fetch(`${config.jupiterApiUrl}/swap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: "high",
            maxLamports: 1_000_000
          }
        }
      })
    });

    return parseJsonResponse<JupiterSwapResponse>(response, "Jupiter swap transaction");
  });

  if (swapResponse.error || !swapResponse.swapTransaction) {
    throw new Error(`Jupiter swap failed: ${swapResponse.error ?? "missing swapTransaction"}`);
  }

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction, "base64"));
  transaction.sign([wallet]);

  const signature = await withRetry("send Jupiter swap", () =>
    connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    })
  );

  const lastValidBlockHeight = swapResponse.lastValidBlockHeight;
  const blockhash = transaction.message.recentBlockhash;

  if (typeof lastValidBlockHeight === "number") {
    await withRetry("confirm Jupiter swap", () =>
      connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight
        },
        "confirmed"
      )
    );
  } else {
    await withRetry("confirm Jupiter swap", () => connection.confirmTransaction(signature, "confirmed"));
  }

  log("info", "Jupiter SOL to PUMP swap executed", {
    signature,
    inputLamports: quote.inAmount,
    estimatedPumpOut: quote.outAmount,
    prioritizationFeeLamports: swapResponse.prioritizationFeeLamports ?? null
  });

  return signature;
}
