import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type IneligibleWallet = {
  reason: string;
  firstSeenAt: string;
  previousBalanceUi: string;
  currentBalanceUi: string;
};

export type AirdropRecord = {
  wallet?: string;
  amountUi: string;
  amountBaseUnits?: string;
  signature: string | null;
  sentAt: string;
  snapshotId: string;
};

export type WorkerState = {
  version: 1;
  holderBalancesUi: Record<string, string>;
  largeHolderBalancesUi: Record<string, string>;
  ineligibleWallets: Record<string, IneligibleWallet>;
  airdrops: Record<string, AirdropRecord>;
  lastSnapshotId: string | null;
  lastRunAt: string | null;
};

export function emptyState(): WorkerState {
  return {
    version: 1,
    holderBalancesUi: {},
    largeHolderBalancesUi: {},
    ineligibleWallets: {},
    airdrops: {},
    lastSnapshotId: null,
    lastRunAt: null
  };
}

export async function loadState(path: string): Promise<WorkerState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as WorkerState;
    return {
      ...emptyState(),
      ...parsed,
      holderBalancesUi: parsed.holderBalancesUi ?? {},
      largeHolderBalancesUi: parsed.largeHolderBalancesUi ?? {},
      ineligibleWallets: parsed.ineligibleWallets ?? {},
      airdrops: parsed.airdrops ?? {}
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : null;
    if (code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(path: string, state: WorkerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
