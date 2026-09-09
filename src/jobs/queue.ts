import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

export const BREAKDOWN_QUEUE_NAME = "breakdown";
export const QUEUE_PREFIX = "kaizen";
export const WORKER_CONCURRENCY = 5;

export type BreakdownReason = "create" | "retry" | "regenerate";

export interface BreakdownJobData {
  taskId: string;
  userId: string;
  generationId: string;
  reason: BreakdownReason;
}

/** BullMQ rejects colons in custom job ids; the generation id makes every attempt unique. */
export function breakdownJobId(taskId: string, generationId: string): string {
  return `${taskId}-${generationId}`;
}

export const BREAKDOWN_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: true,
  removeOnFail: { count: 100 },
};

export interface BreakdownQueue {
  enqueueBreakdown(data: BreakdownJobData): Promise<void>;
  close(): Promise<void>;
}

export type BreakdownBullQueue = Queue<BreakdownJobData>;

export async function enqueueBreakdown(
  queue: BreakdownBullQueue,
  data: BreakdownJobData,
): Promise<void> {
  await queue.add("breakdown", data, {
    ...BREAKDOWN_JOB_OPTIONS,
    jobId: breakdownJobId(data.taskId, data.generationId),
  });
}

export function createBreakdownQueue(
  connection: Redis,
): BreakdownQueue & { queue: BreakdownBullQueue } {
  const queue = new Queue<BreakdownJobData>(BREAKDOWN_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: BREAKDOWN_JOB_OPTIONS,
  });
  return {
    queue,
    enqueueBreakdown: (data) => enqueueBreakdown(queue, data),
    close: () => queue.close(),
  };
}
