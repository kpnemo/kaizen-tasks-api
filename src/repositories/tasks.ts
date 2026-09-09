import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tasks, taskTags, type NewTaskRow, type TaskRow } from "../db/schema.js";
import type { Cursor } from "../lib/cursor.js";
import type { AiSkipReason, AiStatus, SuggestionState, TaskStatus } from "../schemas/tasks.js";

const owned = (id: string, userId: string) => and(eq(tasks.id, id), eq(tasks.userId, userId));

export async function findOwnedTask(
  db: DbOrTx,
  id: string,
  userId: string,
): Promise<TaskRow | undefined> {
  const [row] = await db.select().from(tasks).where(owned(id, userId)).limit(1);
  return row;
}

export async function insertTask(db: DbOrTx, values: NewTaskRow): Promise<TaskRow> {
  const [row] = await db.insert(tasks).values(values).returning();
  if (!row) throw new Error("insert tasks returned no row");
  return row;
}

export async function deleteTask(db: DbOrTx, id: string, userId: string): Promise<boolean> {
  const rows = await db.delete(tasks).where(owned(id, userId)).returning({ id: tasks.id });
  return rows.length > 0;
}

/** Deterministic order among siblings: position, then createdAt, then id. */
export const siblingOrder = [asc(tasks.position), asc(tasks.createdAt), asc(tasks.id)];

export const siblingScope = (userId: string, parentId: string | null): SQL | undefined =>
  and(
    eq(tasks.userId, userId),
    parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId),
  );

export async function maxSiblingPosition(
  db: DbOrTx,
  userId: string,
  parentId: string | null,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | string | null>`max(${tasks.position})` })
    .from(tasks)
    .where(siblingScope(userId, parentId));
  const max = row?.max;
  return max === null || max === undefined ? -1 : Number(max);
}

export interface ListTasksOptions {
  userId: string;
  parentId: string | null;
  status?: TaskStatus;
  tagId?: string;
  limit: number;
  cursor?: Cursor;
}

/** Keyset list on (created_at desc, id desc). Returns up to limit + 1 rows so the caller knows if a next page exists. */
export async function listTasks(db: DbOrTx, opts: ListTasksOptions): Promise<TaskRow[]> {
  const conditions: (SQL | undefined)[] = [siblingScope(opts.userId, opts.parentId)];
  if (opts.status) conditions.push(eq(tasks.status, opts.status));
  if (opts.tagId) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(taskTags)
          .where(and(eq(taskTags.taskId, tasks.id), eq(taskTags.tagId, opts.tagId))),
      ),
    );
  }
  if (opts.cursor) {
    conditions.push(
      sql`(${tasks.createdAt}, ${tasks.id}) < (${opts.cursor.createdAt.toISOString()}::timestamptz, ${opts.cursor.id}::uuid)`,
    );
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(opts.limit + 1);
}

export async function listChildren(db: DbOrTx, parentId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentId, parentId))
    .orderBy(...siblingOrder);
}

export interface ChildAggregate {
  done: number;
  total: number;
  suggestionCount: number;
}

export type ChildAggregateMap = Map<string, ChildAggregate>;

/**
 * One SQL aggregate over direct children per parent. Progress counts children with origin user or
 * an accepted suggestion (done is the done subset); suggestionCount counts AI children still in
 * state suggested. Parents with no children are absent from the map.
 */
export async function childAggregates(db: DbOrTx, taskIds: string[]): Promise<ChildAggregateMap> {
  const map: ChildAggregateMap = new Map();
  if (taskIds.length === 0) return map;
  const counted = sql`(${tasks.origin} = 'user' or ${tasks.suggestionState} = 'accepted')`;
  const suggested = sql`(${tasks.origin} = 'ai' and ${tasks.suggestionState} = 'suggested')`;
  const rows = await db
    .select({
      parentId: tasks.parentId,
      total: sql<string>`count(*) filter (where ${counted})`,
      done: sql<string>`count(*) filter (where ${counted} and ${tasks.status} = 'done')`,
      suggestionCount: sql<string>`count(*) filter (where ${suggested})`,
    })
    .from(tasks)
    .where(inArray(tasks.parentId, taskIds))
    .groupBy(tasks.parentId);
  for (const row of rows) {
    if (row.parentId) {
      map.set(row.parentId, {
        done: Number(row.done),
        total: Number(row.total),
        suggestionCount: Number(row.suggestionCount),
      });
    }
  }
  return map;
}

export interface AiStatePatch {
  aiStatus: AiStatus;
  aiError?: string | null;
  aiSkipReason?: AiSkipReason | null;
  aiTagSuggestions?: string[];
}

/** Every AI-state write is guarded by generation_id so a superseded job can never overwrite a newer generation. */
export async function updateAiState(
  db: DbOrTx,
  id: string,
  generationId: string,
  patch: AiStatePatch,
): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.generationId, generationId)))
    .returning({ id: tasks.id });
  return rows.length;
}

export type TaskFieldPatch = Partial<
  Pick<TaskRow, "title" | "description" | "status" | "suggestionState">
>;

export async function updateTaskFields(
  db: DbOrTx,
  id: string,
  userId: string,
  patch: TaskFieldPatch,
): Promise<TaskRow | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(owned(id, userId))
    .returning();
  return row;
}

/** Siblings in order, locked for the duration of the transaction so concurrent reorders serialize. */
export async function listSiblings(
  db: DbOrTx,
  userId: string,
  parentId: string | null,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(siblingScope(userId, parentId))
    .orderBy(...siblingOrder)
    .for("update");
}

export async function setPositions(
  db: DbOrTx,
  updates: { id: string; position: number }[],
): Promise<void> {
  for (const update of updates) {
    await db
      .update(tasks)
      .set({ position: update.position, updatedAt: new Date() })
      .where(eq(tasks.id, update.id));
  }
}

export async function setSuggestionStateForAll(
  db: DbOrTx,
  parentId: string,
  userId: string,
  from: SuggestionState,
  to: SuggestionState,
): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ suggestionState: to, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.parentId, parentId),
        eq(tasks.userId, userId),
        eq(tasks.origin, "ai"),
        eq(tasks.suggestionState, from),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length;
}

/**
 * The concurrency guard lives in data: one conditional update reserves the generation.
 * No row means a generation is already pending or running (CONFLICT).
 */
export async function reserveGeneration(
  db: DbOrTx,
  id: string,
  userId: string,
  generationId: string,
): Promise<TaskRow | undefined> {
  const [row] = await db
    .update(tasks)
    .set({
      aiStatus: "pending",
      generationId,
      aiError: null,
      aiSkipReason: null,
      updatedAt: new Date(),
    })
    .where(and(owned(id, userId), notInArray(tasks.aiStatus, ["pending", "running"])))
    .returning();
  return row;
}

/** Titles of the user's other open root tasks, newest first. */
export async function openRootTitles(
  db: DbOrTx,
  userId: string,
  excludeId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        isNull(tasks.parentId),
        ne(tasks.id, excludeId),
        ne(tasks.status, "done"),
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit);
  return rows.map((r) => r.title);
}

export interface ReplaceSuggestedChildrenOptions {
  taskId: string;
  userId: string;
  generationId: string;
  steps: { title: string; rationale: string }[];
  tagSuggestions: string[];
}

/**
 * Persists a breakdown result inside the caller's transaction, guarded by generation_id:
 * locks the task row, deletes still-suggested AI children, inserts the new steps after the
 * current maximum position, sets tag suggestions and ai_status done. Returns false when the
 * generation was superseded, in which case nothing is written.
 */
export async function replaceSuggestedChildren(
  tx: DbOrTx,
  opts: ReplaceSuggestedChildrenOptions,
): Promise<boolean> {
  const [locked] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, opts.taskId), eq(tasks.generationId, opts.generationId)))
    .for("update");
  if (!locked) return false;

  await tx
    .delete(tasks)
    .where(
      and(
        eq(tasks.parentId, opts.taskId),
        eq(tasks.origin, "ai"),
        eq(tasks.suggestionState, "suggested"),
      ),
    );

  const start = (await maxSiblingPosition(tx, opts.userId, opts.taskId)) + 1;
  if (opts.steps.length > 0) {
    await tx.insert(tasks).values(
      opts.steps.map((step, index) => ({
        userId: opts.userId,
        parentId: opts.taskId,
        title: step.title,
        rationale: step.rationale,
        position: start + index,
        origin: "ai" as const,
        suggestionState: "suggested" as const,
        aiStatus: "skipped" as const,
      })),
    );
  }

  const updated = await tx
    .update(tasks)
    .set({
      aiStatus: "done",
      aiTagSuggestions: opts.tagSuggestions,
      aiError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, opts.taskId), eq(tasks.generationId, opts.generationId)))
    .returning({ id: tasks.id });
  return updated.length > 0;
}
