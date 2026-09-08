import { and, asc, desc, eq, exists, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tasks, taskTags, type NewTaskRow, type TaskRow } from "../db/schema.js";
import type { Cursor } from "../lib/cursor.js";
import type { AiSkipReason, AiStatus, TaskStatus } from "../schemas/tasks.js";

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
