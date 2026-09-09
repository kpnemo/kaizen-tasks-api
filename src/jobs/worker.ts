import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { BreakdownModel } from "../agent/model.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import { updateAiState } from "../repositories/tasks.js";
import { AI_ERROR_MESSAGES, processBreakdownJob } from "./processors/breakdown.js";
import {
  BREAKDOWN_QUEUE_NAME,
  QUEUE_PREFIX,
  WORKER_CONCURRENCY,
  type BreakdownJobData,
} from "./queue.js";

export interface WorkerDeps {
  connection: Redis;
  db: Db;
  model: BreakdownModel;
  logger: Logger;
}

export type BreakdownWorker = Worker<BreakdownJobData>;

/** Starts processing immediately. BullMQ retries thrown (retryable) failures; the last one marks the task failed. */
export function startBreakdownWorker(deps: WorkerDeps): BreakdownWorker {
  const { connection, db, model, logger } = deps;
  const worker = new Worker<BreakdownJobData>(
    BREAKDOWN_QUEUE_NAME,
    async (job) => {
      await processBreakdownJob(job.data, { db, model, logger });
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    if (!job) {
      logger.error({ err }, "breakdown job failed without a job reference");
      return;
    }
    const log = logger.child({ jobId: job.id, taskId: job.data.taskId });
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      log.error({ err, attempts: job.attemptsMade }, "breakdown attempts exhausted");
      void updateAiState(db, job.data.taskId, job.data.generationId, {
        aiStatus: "failed",
        aiError: AI_ERROR_MESSAGES.unavailable,
      }).catch((markErr: unknown) => log.error({ err: markErr }, "could not mark task failed"));
    } else {
      log.warn({ err, attempt: job.attemptsMade }, "breakdown attempt failed, will retry");
    }
  });

  worker.on("error", (err) => {
    logger.error({ name: err.name, message: err.message }, "breakdown worker error");
  });

  return worker;
}
