import { randomUUID } from "node:crypto";
import type { Db, DbOrTx } from "../db/client.js";
import type { NewTaskRow, TaskRow } from "../db/schema.js";
import type { BreakdownQueue } from "../jobs/queue.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { notFound, validationError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import { findOwnedTags, replaceTaskTags, tagsForTasks } from "../repositories/tags.js";
import {
  childAggregates,
  deleteTask,
  findOwnedTask,
  insertTask,
  listChildren,
  listTasks,
  maxSiblingPosition,
  updateAiState,
  type ChildAggregate,
} from "../repositories/tasks.js";
import type { Tag } from "../schemas/tags.js";
import type { CreateTaskInput, ListTasksInput, TaskDetail, TaskSummary } from "../schemas/tasks.js";
import { toTag } from "./tags.js";

/**
 * The two-level task/step shape is structural: a child may only be created under a root
 * (`parent.parentId !== null` is rejected outright), and breakdown only runs on a root. This
 * constant isn't consulted by that check; it only feeds DEPTH_MESSAGE's wording.
 */
export const MAX_TASK_DEPTH = 2;
export const DEPTH_MESSAGE = `Tasks can be nested at most ${MAX_TASK_DEPTH} levels deep`;
export const ENQUEUE_FAILED_MESSAGE = "Could not queue the assistant, try again";

export interface TasksServiceDeps {
  db: Db;
  queue: BreakdownQueue;
  rateLimiter: RateLimiter;
  logger: Logger;
}

export interface TaskPage {
  items: TaskSummary[];
  nextCursor: string | null;
}

export interface TasksService {
  list(userId: string, query: ListTasksInput): Promise<TaskPage>;
  create(userId: string, input: CreateTaskInput): Promise<TaskDetail>;
  get(userId: string, id: string): Promise<TaskDetail>;
  remove(userId: string, id: string): Promise<void>;
}

const NO_CHILDREN: ChildAggregate = { done: 0, total: 0, suggestionCount: 0 };

/** The API shape of one row. suggestionCount and aiError ride on every summary (master plan section 4). */
export function toTaskSummary(row: TaskRow, tags: Tag[], children: ChildAggregate): TaskSummary {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    status: row.status,
    aiStatus: row.aiStatus,
    aiSkipReason: row.aiSkipReason,
    aiError: row.aiError,
    position: row.position,
    origin: row.origin,
    suggestionState: row.suggestionState,
    rationale: row.rationale,
    tags,
    progress: { done: children.done, total: children.total },
    suggestionCount: children.suggestionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function summarize(db: DbOrTx, rows: TaskRow[]): Promise<TaskSummary[]> {
  const ids = rows.map((r) => r.id);
  const [tagMap, aggregates] = await Promise.all([tagsForTasks(db, ids), childAggregates(db, ids)]);
  return rows.map((row) =>
    toTaskSummary(
      row,
      (tagMap.get(row.id) ?? []).map(toTag),
      aggregates.get(row.id) ?? NO_CHILDREN,
    ),
  );
}

/** Loads the owned row plus children (ordered), tags, progress and AI fields. A miss is NOT_FOUND. */
export async function loadTaskDetail(db: DbOrTx, id: string, userId: string): Promise<TaskDetail> {
  const task = await findOwnedTask(db, id, userId);
  if (!task) throw notFound("Task not found");
  const children = await listChildren(db, task.id);
  const [summary, ...childSummaries] = await summarize(db, [task, ...children]);
  return {
    ...(summary as TaskSummary),
    children: childSummaries,
    aiTagSuggestions: task.aiTagSuggestions,
  };
}

/** Every id must be one of the user's tags; otherwise VALIDATION_ERROR on body.tagIds. */
export async function assertOwnedTagIds(
  db: DbOrTx,
  userId: string,
  tagIds: string[],
): Promise<void> {
  if (tagIds.length === 0) return;
  const owned = new Set((await findOwnedTags(db, userId, tagIds)).map((t) => t.id));
  const missing = tagIds.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw validationError(
      missing.map((id) => ({ path: "body.tagIds", message: `Unknown tag id ${id}` })),
    );
  }
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const { db, queue, rateLimiter, logger } = deps;

  return {
    async list(userId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await listTasks(db, {
        userId,
        parentId: query.parentId ?? null,
        status: query.status,
        tagId: query.tagId,
        limit: query.limit,
        cursor,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return { items: await summarize(db, page), nextCursor };
    },

    async create(userId, input) {
      let parent: TaskRow | undefined;
      if (input.parentId) {
        parent = await findOwnedTask(db, input.parentId, userId);
        if (!parent) throw notFound("Parent task not found");
        if (parent.parentId !== null) {
          throw validationError([{ path: "body.parentId", message: DEPTH_MESSAGE }]);
        }
      }
      const tagIds = [...new Set(input.tagIds ?? [])];
      await assertOwnedTagIds(db, userId, tagIds);
      const position = (await maxSiblingPosition(db, userId, parent?.id ?? null)) + 1;

      let aiFields: Pick<NewTaskRow, "aiStatus" | "aiSkipReason" | "generationId">;
      let generationId: string | undefined;
      if (parent) {
        aiFields = { aiStatus: "skipped" };
      } else {
        const consumed = await rateLimiter.consume(userId);
        if (consumed.allowed) {
          generationId = randomUUID();
          aiFields = { aiStatus: "pending", generationId };
        } else {
          aiFields = {
            aiStatus: "skipped",
            aiSkipReason: consumed.reason === "ai_disabled" ? "ai_disabled" : "rate_limited",
          };
        }
      }

      const row = await db.transaction(async (tx) => {
        const created = await insertTask(tx, {
          userId,
          parentId: parent?.id ?? null,
          title: input.title,
          description: input.description ?? null,
          position,
          ...aiFields,
        });
        if (tagIds.length > 0) await replaceTaskTags(tx, created.id, tagIds);
        return created;
      });

      // Enqueue after the transaction commits. Task creation never fails because of AI.
      if (generationId) {
        try {
          await queue.enqueueBreakdown({ taskId: row.id, userId, generationId, reason: "create" });
        } catch (err) {
          logger.error({ err, taskId: row.id }, "could not enqueue breakdown");
          await updateAiState(db, row.id, generationId, {
            aiStatus: "failed",
            aiError: ENQUEUE_FAILED_MESSAGE,
          });
        }
      }
      return loadTaskDetail(db, row.id, userId);
    },

    async get(userId, id) {
      return loadTaskDetail(db, id, userId);
    },

    async remove(userId, id) {
      const deleted = await deleteTask(db, id, userId);
      if (!deleted) throw notFound("Task not found");
    },
  };
}
