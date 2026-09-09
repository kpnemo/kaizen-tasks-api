import type { Db } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import { failStaleGenerations } from "../repositories/tasks.js";

export const STALE_ERROR_MESSAGE = "Timed out, try again";
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Tasks pending or running with updated_at older than staleMinutes become retryable failures. */
export async function reconcileStaleGenerations(
  db: Db,
  staleMinutes: number,
  logger: Logger,
  now: Date = new Date(),
): Promise<number> {
  const olderThan = new Date(now.getTime() - staleMinutes * 60_000);
  const count = await failStaleGenerations(db, olderThan, STALE_ERROR_MESSAGE);
  if (count > 0) logger.warn({ count, staleMinutes }, "reconciled stale generations");
  return count;
}

/** Runs once now and every five minutes. The timer is unref'd so it never keeps the process alive. */
export function startReconciler(deps: { db: Db; staleMinutes: number; logger: Logger }): {
  stop(): void;
} {
  const run = () =>
    reconcileStaleGenerations(deps.db, deps.staleMinutes, deps.logger).catch((err: unknown) => {
      deps.logger.error({ err }, "reconciler run failed");
    });
  void run();
  const timer = setInterval(run, RECONCILE_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
