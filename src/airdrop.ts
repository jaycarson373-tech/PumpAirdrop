import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint
} from "@solana/spl-token";
import { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { withRetry } from "./retry.js";
import { HolderSnapshot } from "./snapshot.js";
import { WorkerState } from "./state.js";

function amountToBaseUnits(amountUi: number, decimals: number): bigint {
  const [wholeRaw, fractionRaw = ""] = amountUi.toString().split(".");
  const whole = BigInt(wholeRaw || "0") * 10n ** BigInt(decimals);
  const fractionPadded = fractionRaw.padEnd(decimals, "0").slice(0, decimals);
  const fraction = BigInt(fractionPadded || "0");
  return whole + fraction;
}

export async function airdropToEligibleWallets(params: {
  connection: Connection;
  config: AppConfig;
  authority: Keypair;
  state: WorkerState;
  snapshot: HolderSnapshot;
}): Promise<void> {
  const { connection, config, authority, state, snapshot } = params;

  if (!config.airdropEnabled) {
    log("info", "airdrop skipped because AIRDROP_ENABLED=false");
    return;
  }

  if (config.airdropAmountUi <= 0) {
    log("info", "airdrop skipped because AIRDROP_AMOUNT_UI is zero");
    return;
  }

  const mint = config.airdropTokenMint;
  const mintInfo = await withRetry("get airdrop mint info", () => getMint(connection, mint));
  const amount = amountToBaseUnits(config.airdropAmountUi, mintInfo.decimals);

  if (amount <= 0n) {
    log("info", "airdrop skipped because computed base-unit amount is zero", {
      airdropAmountUi: config.airdropAmountUi,
      decimals: mintInfo.decimals
    });
    return;
  }

  const sourceAta = getAssociatedTokenAddressSync(mint, authority.publicKey);
  const pendingRecipients = snapshot.eligibleWallets
    .filter((wallet) => !state.airdrops[wallet])
    .slice(0, config.maxAirdropsPerRun);

  log("info", "airdrop batch planned", {
    mint: mint.toBase58(),
    sourceAta: sourceAta.toBase58(),
    amountUi: config.airdropAmountUi,
    amountBaseUnits: amount.toString(),
    pendingRecipients: pendingRecipients.length,
    maxAirdropsPerRun: config.maxAirdropsPerRun,
    dryRun: config.dryRun
  });

  for (const recipient of pendingRecipients) {
    const recipientOwner = new PublicKey(recipient);
    const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner);

    if (config.dryRun) {
      log("info", "dry run: would airdrop tokens", {
        recipient,
        destinationAta: destinationAta.toBase58(),
        amountUi: config.airdropAmountUi,
        snapshotId: snapshot.snapshotId
      });
      continue;
    }

    const transaction = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        destinationAta,
        recipientOwner,
        mint
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        authority.publicKey,
        amount,
        mintInfo.decimals
      )
    );

    const signature = await withRetry("send airdrop", () =>
      sendAndConfirmTransaction(connection, transaction, [authority], {
        commitment: "confirmed"
      })
    );

    state.airdrops[recipient] = {
      amountUi: String(config.airdropAmountUi),
      signature,
      sentAt: new Date().toISOString(),
      snapshotId: snapshot.snapshotId
    };

    log("info", "airdrop sent", {
      recipient,
      amountUi: config.airdropAmountUi,
      signature,
      snapshotId: snapshot.snapshotId
    });
  }
}
