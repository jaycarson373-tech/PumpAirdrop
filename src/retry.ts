import { log } from "./logger.js";

export type RetryOptions = {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 750;
  const maxDelayMs = options.maxDelayMs ?? 8_000;

  let attempt = 0;
  let delayMs = initialDelayMs;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (attempt > retries) {
        log("error", `${label} failed after retries`, { attempts: attempt, error: message });
        throw error;
      }

      log("warn", `${label} failed, retrying`, { attempt, retries, delayMs, error: message });
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
