import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey
} from "@solana/web3.js";
import bs58 from "bs58";
import { withRetry } from "./retry.js";

export const NATIVE_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000
  });
}

export function loadKeypair(privateKeyBase58: string): Keypair {
  const decoded = bs58.decode(privateKeyBase58);

  if (decoded.length === 64) {
    return Keypair.fromSecretKey(decoded);
  }

  if (decoded.length === 32) {
    return Keypair.fromSeed(decoded);
  }

  throw new Error(
    `WORKER_PRIVATE_KEY_BASE58 decoded to ${decoded.length} bytes; expected 32-byte seed or 64-byte secret key`
  );
}

export async function getSolBalance(connection: Connection, wallet: PublicKey): Promise<number> {
  const lamports = await withRetry("get SOL balance", () =>
    connection.getBalance(wallet, "confirmed")
  );
  return lamports / LAMPORTS_PER_SOL;
}
