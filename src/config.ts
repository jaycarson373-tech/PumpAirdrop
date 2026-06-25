import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

export type AppConfig = {
  rpcUrl: string;
  workerPrivateKeyBase58: string;
  pumpTokenMint: PublicKey;
  snapshotTokenMint: PublicKey;
  airdropTokenMint: PublicKey;
  jupiterApiKey: string;
  jupiterApiUrl: string;
  solReserve: number;
  minSwapSol: number;
  maxSwapSolPerRun: number;
  slippageBps: number;
  intervalMinutes: number;
  dryRun: boolean;
  stateFilePath: string;
  minHolderTokenUi: number;
  airdropEnabled: boolean;
  airdropAmountUi: number;
  maxAirdropsPerRun: number;
  excludedWallets: Set<string>;
  publicApiEnabled: boolean;
  port: number;
  corsOrigin: string;
};

const DEFAULT_JUPITER_API_URL = "https://api.jup.ag/swap/v2";
const DEFAULT_SOL_RESERVE = 0.2;
const DEFAULT_MIN_SWAP_SOL = 0.01;
const DEFAULT_MAX_SWAP_SOL_PER_RUN = 10;
const DEFAULT_SLIPPAGE_BPS = 300;
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_STATE_FILE_PATH = "./data/state.json";
const DEFAULT_MIN_HOLDER_TOKEN_UI = 0;
const DEFAULT_MAX_AIRDROPS_PER_RUN = 50;
const DEFAULT_PORT = 3000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parsePositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

function parseNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or a positive number`);
  }

  return value;
}

function parseInteger(name: string, fallback: number): number {
  const value = parsePositiveNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y"].includes(raw)) return true;
  if (["0", "false", "no", "n"].includes(raw)) return false;

  throw new Error(`${name} must be true or false`);
}

function parsePublicKey(name: string, raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${name} must be a valid Solana public key`);
  }
}

function parseWalletSet(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((wallet) => wallet.trim())
      .filter(Boolean)
  );
}

export function loadConfig(): AppConfig {
  const pumpTokenMintRaw = requireEnv("PUMP_TOKEN_MINT");
  const snapshotTokenMintRaw = optionalEnv("SNAPSHOT_TOKEN_MINT", pumpTokenMintRaw);
  const airdropTokenMintRaw = optionalEnv("AIRDROP_TOKEN_MINT", pumpTokenMintRaw);

  const solReserve = parsePositiveNumber("SOL_RESERVE", DEFAULT_SOL_RESERVE);
  const minSwapSol = parsePositiveNumber("MIN_SWAP_SOL", DEFAULT_MIN_SWAP_SOL);
  const maxSwapSolPerRun = parsePositiveNumber("MAX_SWAP_SOL_PER_RUN", DEFAULT_MAX_SWAP_SOL_PER_RUN);

  if (maxSwapSolPerRun < minSwapSol) {
    throw new Error("MAX_SWAP_SOL_PER_RUN must be greater than or equal to MIN_SWAP_SOL");
  }

  return {
    rpcUrl: requireEnv("RPC_URL"),
    workerPrivateKeyBase58: requireEnv("WORKER_PRIVATE_KEY_BASE58"),
    pumpTokenMint: parsePublicKey("PUMP_TOKEN_MINT", pumpTokenMintRaw),
    snapshotTokenMint: parsePublicKey("SNAPSHOT_TOKEN_MINT", snapshotTokenMintRaw),
    airdropTokenMint: parsePublicKey("AIRDROP_TOKEN_MINT", airdropTokenMintRaw),
    jupiterApiKey: requireEnv("JUPITER_API_KEY"),
    jupiterApiUrl: optionalEnv("JUPITER_API_URL", DEFAULT_JUPITER_API_URL).replace(/\/$/, ""),
    solReserve,
    minSwapSol,
    maxSwapSolPerRun,
    slippageBps: parseInteger("SLIPPAGE_BPS", DEFAULT_SLIPPAGE_BPS),
    intervalMinutes: parsePositiveNumber("INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES),
    dryRun: parseBoolean("DRY_RUN", true),
    stateFilePath: optionalEnv("STATE_FILE_PATH", DEFAULT_STATE_FILE_PATH),
    minHolderTokenUi: parseNonNegativeNumber("MIN_HOLDER_TOKEN_UI", DEFAULT_MIN_HOLDER_TOKEN_UI),
    airdropEnabled: parseBoolean("AIRDROP_ENABLED", false),
    airdropAmountUi: parseNonNegativeNumber("AIRDROP_AMOUNT_UI", 0),
    maxAirdropsPerRun: parseInteger("MAX_AIRDROPS_PER_RUN", DEFAULT_MAX_AIRDROPS_PER_RUN),
    excludedWallets: parseWalletSet(process.env.EXCLUDED_WALLETS),
    publicApiEnabled: parseBoolean("PUBLIC_API_ENABLED", true),
    port: parseInteger("PORT", DEFAULT_PORT),
    corsOrigin: optionalEnv("CORS_ORIGIN", "*")
  };
}
