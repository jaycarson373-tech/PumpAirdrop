import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { loadState, WorkerState } from "./state.js";

type PublicHolder = {
  wallet: string;
  balanceUi: string;
  eligible: boolean;
  airdropped: boolean;
  airdropSignature: string | null;
};

function sendJson(
  response: ServerResponse,
  statusCode: number,
  corsOrigin: string,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(body));
}

function latestAirdropForWallet(state: WorkerState, wallet: string): {
  signature: string | null;
  sentAt: string;
} | null {
  const records = Object.entries(state.airdrops)
    .filter(([key, record]) => record.wallet === wallet || key === wallet || key.endsWith(`:${wallet}`))
    .map(([, record]) => record)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const latest = records[0];

  if (!latest) return null;

  return {
    signature: latest.signature,
    sentAt: latest.sentAt
  };
}

function toPublicState(config: AppConfig, state: WorkerState): Record<string, unknown> {
  const holders: PublicHolder[] = Object.entries(state.holderBalancesUi)
    .map(([wallet, balanceUi]) => {
      const airdrop = latestAirdropForWallet(state, wallet);
      return {
        wallet,
        balanceUi,
        eligible:
          !state.ineligibleWallets[wallet] &&
          !config.excludedWallets.has(wallet) &&
          !state.largeHolderBalancesUi[wallet],
        airdropped: Boolean(airdrop),
        airdropSignature: airdrop?.signature ?? null
      };
    })
    .sort((a, b) => Number(b.balanceUi) - Number(a.balanceUi));

  const ineligible = Object.entries(state.ineligibleWallets).map(([wallet, details]) => ({
    wallet,
    ...details
  }));

  const largeHolders = Object.entries(state.largeHolderBalancesUi).map(([wallet, balanceUi]) => ({
    wallet,
    balanceUi
  }));

  const airdrops = Object.entries(state.airdrops).map(([id, details]) => ({
    id,
    ...details
  }));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    lastRunAt: state.lastRunAt,
    lastSnapshotId: state.lastSnapshotId,
    dryRun: config.dryRun,
    tokenMints: {
      pump: config.pumpTokenMint.toBase58(),
      snapshot: config.snapshotTokenMint.toBase58(),
      airdrop: config.airdropTokenMint.toBase58()
    },
    rules: {
      minHolderTokenUi: config.minHolderTokenUi,
      maxHolderPercent: config.maxHolderPercent,
      excludedWallets: config.excludedWallets.size
    },
    counts: {
      holders: holders.length,
      eligible: holders.filter((holder) => holder.eligible).length,
      ineligible: ineligible.length,
      largeHolders: largeHolders.length,
      airdrops: airdrops.length
    },
    holders,
    ineligible,
    largeHolders,
    airdrops
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, config.corsOrigin, null);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, config.corsOrigin, { ok: false, error: "method not allowed" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, config.corsOrigin, {
      ok: true,
      ts: new Date().toISOString(),
      dryRun: config.dryRun
    });
    return;
  }

  if (url.pathname === "/state" || url.pathname === "/airdrop-data") {
    const state = await loadState(config.stateFilePath);
    sendJson(response, 200, config.corsOrigin, toPublicState(config, state));
    return;
  }

  sendJson(response, 404, config.corsOrigin, {
    ok: false,
    error: "not found",
    routes: ["/health", "/state", "/airdrop-data"]
  });
}

export function startApiServer(config: AppConfig): Server {
  const server = createServer((request, response) => {
    void handleRequest(request, response, config).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "public API request failed", { error: message });
      sendJson(response, 500, config.corsOrigin, { ok: false, error: message });
    });
  });

  server.listen(config.port, () => {
    log("info", "public API server listening", {
      port: config.port,
      routes: ["/health", "/state", "/airdrop-data"],
      corsOrigin: config.corsOrigin
    });
  });

  return server;
}
