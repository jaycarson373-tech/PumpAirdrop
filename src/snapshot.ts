import {
  Connection,
  ParsedAccountData,
  PublicKey
} from "@solana/web3.js";
import { getMint, Mint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { withRetry } from "./retry.js";
import { WorkerState } from "./state.js";

export type HolderSnapshot = {
  snapshotId: string;
  slot: number;
  holders: Record<string, string>;
  eligibleWallets: string[];
  newlyIneligibleWallets: string[];
  excludedLargeHolderWallets: string[];
};

type SnapshotMintInfo = {
  mintInfo: Mint;
  tokenProgramId: PublicKey;
};

function toUiNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getSnapshotMintInfo(
  connection: Connection,
  mint: PublicKey
): Promise<SnapshotMintInfo> {
  let splTokenError: unknown;

  try {
    return {
      mintInfo: await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID),
      tokenProgramId: TOKEN_PROGRAM_ID
    };
  } catch (error) {
    splTokenError = error;
  }

  try {
    return {
      mintInfo: await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID),
      tokenProgramId: TOKEN_2022_PROGRAM_ID
    };
  } catch (token2022Error) {
    throw new Error(
      `Could not load snapshot mint ${mint.toBase58()} as SPL Token or Token-2022. ` +
        `SPL error: ${errorMessage(splTokenError)}; Token-2022 error: ${errorMessage(token2022Error)}`
    );
  }
}

export async function snapshotHolders(params: {
  connection: Connection;
  config: AppConfig;
  state: WorkerState;
}): Promise<HolderSnapshot> {
  const { connection, config, state } = params;
  const mint = config.snapshotTokenMint;

  const [slot, mintDetails] = await Promise.all([
    withRetry("get snapshot slot", () => connection.getSlot("confirmed")),
    withRetry("get snapshot mint info", () => getSnapshotMintInfo(connection, mint))
  ]);

  const accounts = await withRetry("get token holder accounts", () =>
    connection.getParsedProgramAccounts(mintDetails.tokenProgramId, {
      commitment: "confirmed",
      filters: [
        { dataSize: 165 },
        {
          memcmp: {
            offset: 0,
            bytes: mint.toBase58()
          }
        }
      ]
    })
  );

  const holders: Record<string, string> = {};
  const maxHolderUi =
    (Number(mintDetails.mintInfo.supply) / 10 ** mintDetails.mintInfo.decimals) *
    (config.maxHolderPercent / 100);

  for (const account of accounts) {
    const data = account.account.data as ParsedAccountData;
    const parsed = data.parsed as {
      info?: {
        owner?: string;
        tokenAmount?: {
          uiAmountString?: string;
        };
      };
    };
    const owner = parsed.info?.owner;
    const amountUi = parsed.info?.tokenAmount?.uiAmountString;

    if (!owner || !amountUi) continue;
    if (config.excludedWallets.has(owner)) continue;

    const current = toUiNumber(amountUi);
    if (current < config.minHolderTokenUi) continue;

    holders[owner] = String((toUiNumber(holders[owner] ?? "0") + current).toFixed(9));
  }

  const newlyIneligibleWallets: string[] = [];

  for (const [wallet, previousAmount] of Object.entries(state.holderBalancesUi)) {
    const previous = toUiNumber(previousAmount);
    const current = toUiNumber(holders[wallet] ?? "0");

    if (previous > 0 && current < previous && !state.ineligibleWallets[wallet]) {
      state.ineligibleWallets[wallet] = {
        reason: "snapshot balance decreased; treated as sold/transferred",
        firstSeenAt: new Date().toISOString(),
        previousBalanceUi: previousAmount,
        currentBalanceUi: holders[wallet] ?? "0"
      };
      newlyIneligibleWallets.push(wallet);
    }
  }

  state.holderBalancesUi = holders;

  const excludedLargeHolderWallets = Object.entries(holders)
    .filter(([, amountUi]) => toUiNumber(amountUi) >= maxHolderUi)
    .map(([wallet]) => wallet);
  const excludedLargeHolderSet = new Set(excludedLargeHolderWallets);
  state.largeHolderBalancesUi = Object.fromEntries(
    excludedLargeHolderWallets.map((wallet) => [wallet, holders[wallet] ?? "0"])
  );

  const eligibleWallets = Object.keys(holders).filter((wallet) => {
    return (
      !state.ineligibleWallets[wallet] &&
      !config.excludedWallets.has(wallet) &&
      !excludedLargeHolderSet.has(wallet)
    );
  });

  const snapshotId = `${slot}-${Date.now()}`;
  state.lastSnapshotId = snapshotId;

  log("info", "holder snapshot completed", {
    mint: mint.toBase58(),
    tokenProgramId: mintDetails.tokenProgramId.toBase58(),
    snapshotId,
    slot,
    holderCount: Object.keys(holders).length,
    eligibleCount: eligibleWallets.length,
    minHolderTokenUi: config.minHolderTokenUi,
    maxHolderPercent: config.maxHolderPercent,
    maxHolderUi: maxHolderUi.toFixed(9),
    excludedLargeHolderCount: excludedLargeHolderWallets.length,
    newlyIneligibleCount: newlyIneligibleWallets.length
  });

  return {
    snapshotId,
    slot,
    holders,
    eligibleWallets,
    newlyIneligibleWallets,
    excludedLargeHolderWallets
  };
}
