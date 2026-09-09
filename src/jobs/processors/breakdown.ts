import { breakdownTask, shouldSkipBreakdown } from "../../agent/breakdown.js";
import { BreakdownInvalid, BreakdownRefused, ModelNonRetryableError } from "../../agent/errors.js";
import type { BreakdownInput, BreakdownModel } from "../../agent/model.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../lib/logger.js";
import { listTags, tagsForTasks } from "../../repositories/tags.js";
import {
  findOwnedTask,
  listChildren,
  openRootTitles,
  replaceSuggestedChildren,
  updateAiState,
} from "../../repositories/tasks.js";
import type { BreakdownResult } from "../../schemas/breakdown.js";
import { breakdownJobId, type BreakdownJobData } from "../queue.js";

export const OPEN_TASKS_LIMIT = 30;

export const AI_ERROR_MESSAGES = {
  refused: "The assistant declined to break this task down",
  invalid: "The assistant returned an unusable answer, try again",
  rejected: "The assistant rejected the request",
  unavailable: "The assistant is unavailable, try again",
} as const;

export interface ProcessorDeps {
  db: Db;
  model: BreakdownModel;
  logger: Logger;
}

/** A message means the failure is final; undefined means the queue should retry. */
export function failureMessage(err: unknown): string | undefined {
  if (err instanceof BreakdownRefused) return AI_ERROR_MESSAGES.refused;
  if (err instanceof BreakdownInvalid) return AI_ERROR_MESSAGES.invalid;
  if (err instanceof ModelNonRetryableError) return AI_ERROR_MESSAGES.rejected;
  return undefined;
}

/**
 * Spec 5.2. Every write carries WHERE generation_id = <job's>, so a superseded job can never
 * overwrite a newer generation's state. Throws only for retryable failures.
 */
export async function processBreakdownJob(
  data: BreakdownJobData,
  deps: ProcessorDeps,
): Promise<void> {
  const { db, model } = deps;
  const log = deps.logger.child({
    jobId: breakdownJobId(data.taskId, data.generationId),
    taskId: data.taskId,
  });

  // 1. Load. A missing task or a different generation means a newer generation owns it.
  const task = await findOwnedTask(db, data.taskId, data.userId);
  if (!task || task.generationId !== data.generationId) {
    log.info("generation superseded or task gone; nothing to do");
    return;
  }

  // 2. Skip rule.
  if (shouldSkipBreakdown(task.title, task.description)) {
    await updateAiState(db, task.id, data.generationId, {
      aiStatus: "skipped",
      aiSkipReason: "too_short",
    });
    log.info("skipped: title too short");
    return;
  }

  // 3. Running, guarded.
  const running = await updateAiState(db, task.id, data.generationId, { aiStatus: "running" });
  if (running === 0) {
    log.info("superseded before running");
    return;
  }

  const [children, userTags, openTasks, taskTagMap] = await Promise.all([
    listChildren(db, task.id),
    listTags(db, data.userId),
    openRootTitles(db, data.userId, task.id, OPEN_TASKS_LIMIT),
    tagsForTasks(db, [task.id]),
  ]);
  const input: BreakdownInput = {
    title: task.title,
    description: task.description ?? "",
    existingSteps: children.map((c) => c.title),
    tags: userTags.map((t) => t.name),
    openTasks,
  };

  // 4. Call the model. 6 and 7: final failures are recorded; retryable ones propagate to BullMQ.
  let result: BreakdownResult;
  try {
    result = await breakdownTask(input, model);
  } catch (err) {
    const message = failureMessage(err);
    if (message === undefined) {
      log.warn({ err }, "retryable breakdown failure");
      throw err;
    }
    await updateAiState(db, task.id, data.generationId, { aiStatus: "failed", aiError: message });
    log.warn({ err }, "breakdown failed");
    return;
  }

  // 5. Persist in one guarded transaction. Tag names already on the task are not suggested again.
  const onTask = new Set((taskTagMap.get(task.id) ?? []).map((t) => t.name.toLowerCase()));
  const tagSuggestions = result.tagSuggestions.filter((name) => !onTask.has(name.toLowerCase()));
  const written = await db.transaction((tx) =>
    replaceSuggestedChildren(tx, {
      taskId: task.id,
      userId: data.userId,
      generationId: data.generationId,
      steps: result.steps,
      tagSuggestions,
    }),
  );
  if (written) {
    log.info(
      { steps: result.steps.length, tagSuggestions: tagSuggestions.length },
      "breakdown done",
    );
  } else {
    log.info("superseded during persist; result discarded");
  }
}
