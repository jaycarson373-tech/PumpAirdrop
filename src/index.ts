import { AppConfig, loadConfig } from "./config.js";
import { airdropToEligibleWallets } from "./airdrop.js";
import { swapSolToPump } from "./jupiter.js";
import { log } from "./logger.js";
import { startApiServer } from "./server.js";
import { claimRentIfNeeded, createConnection, getSolBalance, loadKeypair } from "./solana.js";
import { snapshotHolders } from "./snapshot.js";
import { loadState, saveState } from "./state.js";

type RunState = {
  inFlight: boolean;
  startedAt: string | null;
};

const runState: RunState = {
  inFlight: false,
  startedAt: null
};

function formatSol(value: number): number {
  return Number(value.toFixed(9));
}

export async function runOnce(config: AppConfig): Promise<void> {
  if (runState.inFlight) {
    log("warn", "run skipped because previous run is still in flight", {
      previousStartedAt: runState.startedAt
    });
    return;
  }

  runState.inFlight = true;
  runState.startedAt = new Date().toISOString();

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const actions = {
    claimAttempted: false,
    swapAttempted: false,
    snapshotAttempted: false,
    airdropAttempted: false
  };

  try {
    const connection = createConnection(config.rpcUrl);
    const wallet = loadKeypair(config.workerPrivateKeyBase58);
    const state = await loadState(config.stateFilePath);

    log("info", "run started", {
      runId,
      dryRun: config.dryRun,
      wallet: wallet.publicKey.toBase58(),
      pumpTokenMint: config.pumpTokenMint.toBase58(),
      solReserve: config.solReserve,
      minSwapSol: config.minSwapSol,
      intervalMinutes: config.intervalMinutes
    });

    actions.claimAttempted = true;
    const claimSignature = await claimRentIfNeeded();
    log("info", "rent claim step completed", {
      runId,
      claimed: Boolean(claimSignature),
      claimSignature
    });

    const balanceSol = await getSolBalance(connection, wallet.publicKey);
    const availableToSwapSol = Math.max(balanceSol - config.solReserve, 0);
    const amountSolToSwap = Math.min(availableToSwapSol, config.maxSwapSolPerRun);

    log("info", "SOL balance checked", {
      runId,
      balanceSol: formatSol(balanceSol),
      solReserve: config.solReserve,
      availableToSwapSol: formatSol(availableToSwapSol),
      amountSolToSwap: formatSol(amountSolToSwap),
      minSwapSol: config.minSwapSol
    });

    if (amountSolToSwap >= config.minSwapSol) {
      actions.swapAttempted = true;
      const swapSignature = await swapSolToPump({
        config,
        wallet,
        amountSol: amountSolToSwap
      });
      log("info", "swap step completed", {
        runId,
        dryRun: config.dryRun,
        swapped: Boolean(swapSignature),
        swapSignature
      });
    } else {
      log("info", "below threshold; swap skipped", {
        runId,
        amountSolToSwap: formatSol(amountSolToSwap),
        minSwapSol: config.minSwapSol
      });
    }

    actions.snapshotAttempted = true;
    const snapshot = await snapshotHolders({
      connection,
      config,
      state
    });

    actions.airdropAttempted = true;
    await airdropToEligibleWallets({
      connection,
      config,
      authority: wallet,
      state,
      snapshot
    });

    state.lastRunAt = new Date().toISOString();
    await saveState(config.stateFilePath, state);

    log("info", "run completed", { runId, actions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "run failed", { runId, error: message, actions });
  } finally {
    runState.inFlight = false;
    runState.startedAt = null;
  }
}

export function mainLoop(config = loadConfig()): NodeJS.Timeout {
  const intervalMs = config.intervalMinutes * 60_000;
  const apiServer = config.publicApiEnabled ? startApiServer(config) : null;

  log("info", "worker starting", {
    intervalMinutes: config.intervalMinutes,
    dryRun: config.dryRun,
    pumpTokenMint: config.pumpTokenMint.toBase58(),
    snapshotTokenMint: config.snapshotTokenMint.toBase58(),
    airdropTokenMint: config.airdropTokenMint.toBase58(),
    solReserve: config.solReserve,
    minSwapSol: config.minSwapSol,
    maxSwapSolPerRun: config.maxSwapSolPerRun,
    airdropEnabled: config.airdropEnabled,
    publicApiEnabled: config.publicApiEnabled,
    port: config.publicApiEnabled ? config.port : null
  });

  void runOnce(config);

  const interval = setInterval(() => {
    void runOnce(config);
  }, intervalMs);

  const shutdown = (signal: NodeJS.Signals): void => {
    log("info", "shutdown signal received", { signal });
    clearInterval(interval);
    apiServer?.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return interval;
}

mainLoop();
