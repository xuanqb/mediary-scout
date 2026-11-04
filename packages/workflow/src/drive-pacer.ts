/**
 * Retry wrapper for one drive's API calls, shared by the staging janitor and the
 * recovery runs it queues. Drives may answer a burst with "请勿频繁操作: a refused
 * call waits 30s, then 60s, then 120s and is retried; the fourth refusal, or any
 * other error, propagates. Calls are not otherwise spaced.
 */

export interface DriveClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Run one drive call through the rate-limit retry. */
export type DrivePace = <T>(run: () => Promise<T>) => Promise<T>;

/** Three waits, then give up. */
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000];

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /code=100011|请勿频繁操作/.test(message);
}

export const realtimeDriveClock: DriveClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function drivePacer(_provider: string | undefined, clock: DriveClock = realtimeDriveClock): DrivePace {
  return async function pace<T>(run: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        const backoff = RATE_LIMIT_BACKOFF_MS[attempt];
        if (backoff === undefined || !isRateLimited(error)) {
          throw error;
        }
        attempt += 1;
        await clock.sleep(backoff);
      }
    }
  };
}
