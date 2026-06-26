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

function baseUnitsToUiString(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;

  if (fraction === 0n) return whole.toString();

  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

function airdropRecordKey(snapshotId: string, wallet: string): string {
  return `${snapshotId}:${wallet}`;
}

async function getSourceTokenBalanceBaseUnits(
  connection: Connection,
  sourceAta: PublicKey
): Promise<bigint> {
  try {
    const balance = await withRetry("get airdrop source token balance", () =>
      connection.getTokenAccountBalance(sourceAta, "confirmed")
    );
    return BigInt(balance.value.amount);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "airdrop source token balance unavailable", {
      sourceAta: sourceAta.toBase58(),
      error: message
    });
    return 0n;
  }
}

function buildProportionalAirdrops(params: {
  snapshot: HolderSnapshot;
  recipients: string[];
  totalAmountBaseUnits: bigint;
  decimals: number;
}): Array<{ recipient: string; amountBaseUnits: bigint; amountUi: string }> {
  const { snapshot, recipients, totalAmountBaseUnits, decimals } = params;
  const weights = recipients.map((recipient) => ({
    recipient,
    weight: amountToBaseUnits(Number(snapshot.holders[recipient] ?? "0"), 9)
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0n);

  if (totalWeight <= 0n || totalAmountBaseUnits <= 0n) return [];

  let allocated = 0n;

  return weights
    .map((item, index) => {
      const isLast = index === weights.length - 1;
      const amountBaseUnits = isLast
        ? totalAmountBaseUnits - allocated
        : (totalAmountBaseUnits * item.weight) / totalWeight;
      allocated += amountBaseUnits;

      return {
        recipient: item.recipient,
        amountBaseUnits,
        amountUi: baseUnitsToUiString(amountBaseUnits, decimals)
      };
    })
    .filter((item) => item.amountBaseUnits > 0n);
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

  const mint = config.airdropTokenMint;
  const mintInfo = await withRetry("get airdrop mint info", () => getMint(connection, mint));
  const sourceAta = getAssociatedTokenAddressSync(mint, authority.publicKey);
  const pendingRecipients = snapshot.eligibleWallets
    .filter((wallet) => !state.airdrops[airdropRecordKey(snapshot.snapshotId, wallet)])
    .slice(0, config.maxAirdropsPerRun);

  if (pendingRecipients.length === 0) {
    log("info", "airdrop skipped because no eligible recipients are pending for this snapshot", {
      snapshotId: snapshot.snapshotId
    });
    return;
  }

  const sourceBalanceBaseUnits = await getSourceTokenBalanceBaseUnits(connection, sourceAta);
  const fixedAmountBaseUnits =
    config.airdropAmountUi > 0 ? amountToBaseUnits(config.airdropAmountUi, mintInfo.decimals) : 0n;

  const plannedAirdrops =
    fixedAmountBaseUnits > 0n
      ? pendingRecipients.map((recipient) => ({
          recipient,
          amountBaseUnits: fixedAmountBaseUnits,
          amountUi: baseUnitsToUiString(fixedAmountBaseUnits, mintInfo.decimals)
        }))
      : buildProportionalAirdrops({
          snapshot,
          recipients: pendingRecipients,
          totalAmountBaseUnits: sourceBalanceBaseUnits,
          decimals: mintInfo.decimals
        });

  if (plannedAirdrops.length === 0) {
    log("info", "airdrop skipped because no transferable token amount is available", {
      sourceAta: sourceAta.toBase58(),
      sourceBalanceBaseUnits: sourceBalanceBaseUnits.toString(),
      airdropAmountUi: config.airdropAmountUi
    });
    return;
  }

  const totalPlannedBaseUnits = plannedAirdrops.reduce((sum, item) => sum + item.amountBaseUnits, 0n);

  if (sourceBalanceBaseUnits < totalPlannedBaseUnits && !config.dryRun) {
    throw new Error(
      `Airdrop source balance ${sourceBalanceBaseUnits} is below planned amount ${totalPlannedBaseUnits}`
    );
  }

  log("info", "airdrop batch planned", {
    mint: mint.toBase58(),
    sourceAta: sourceAta.toBase58(),
    mode: fixedAmountBaseUnits > 0n ? "fixed" : "proportional",
    sourceBalanceBaseUnits: sourceBalanceBaseUnits.toString(),
    totalPlannedBaseUnits: totalPlannedBaseUnits.toString(),
    pendingRecipients: plannedAirdrops.length,
    eligibleWallets: snapshot.eligibleWallets.length,
    maxAirdropsPerRun: config.maxAirdropsPerRun,
    dryRun: config.dryRun
  });

  for (const planned of plannedAirdrops) {
    const recipientOwner = new PublicKey(planned.recipient);
    const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner);
    const recordKey = airdropRecordKey(snapshot.snapshotId, planned.recipient);

    if (config.dryRun) {
      log("info", "dry run: would airdrop tokens", {
        recipient: planned.recipient,
        destinationAta: destinationAta.toBase58(),
        amountUi: planned.amountUi,
        amountBaseUnits: planned.amountBaseUnits.toString(),
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
        planned.amountBaseUnits,
        mintInfo.decimals
      )
    );

    const signature = await withRetry("send airdrop", () =>
      sendAndConfirmTransaction(connection, transaction, [authority], {
        commitment: "confirmed"
      })
    );

    state.airdrops[recordKey] = {
      wallet: planned.recipient,
      amountUi: planned.amountUi,
      amountBaseUnits: planned.amountBaseUnits.toString(),
      signature,
      sentAt: new Date().toISOString(),
      snapshotId: snapshot.snapshotId
    };

    log("info", "airdrop sent", {
      recipient: planned.recipient,
      amountUi: planned.amountUi,
      amountBaseUnits: planned.amountBaseUnits.toString(),
      signature,
      snapshotId: snapshot.snapshotId
    });
  }
}
