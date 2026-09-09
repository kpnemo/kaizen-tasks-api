import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tags, taskTags, type TagRow } from "../db/schema.js";

const byName = [asc(sql`lower(${tags.name})`), asc(tags.id)];

export async function listTags(db: DbOrTx, userId: string): Promise<TagRow[]> {
  return db
    .select()
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(...byName);
}

export async function findTag(db: DbOrTx, id: string, userId: string): Promise<TagRow | undefined> {
  const [row] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .limit(1);
  return row;
}

export async function insertTag(
  db: DbOrTx,
  values: { userId: string; name: string; color: string },
): Promise<TagRow> {
  const [row] = await db.insert(tags).values(values).returning();
  if (!row) throw new Error("insert tags returned no row");
  return row;
}

export async function updateTag(
  db: DbOrTx,
  id: string,
  userId: string,
  patch: { name?: string; color?: string },
): Promise<TagRow | undefined> {
  const [row] = await db
    .update(tags)
    .set(patch)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning();
  return row;
}

export async function deleteTag(db: DbOrTx, id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

export async function findOwnedTags(db: DbOrTx, userId: string, ids: string[]): Promise<TagRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, ids)));
}

/** Tags per task id for a set of tasks, each list ordered by name. */
export async function tagsForTasks(db: DbOrTx, taskIds: string[]): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select({ taskId: taskTags.taskId, tag: tags })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(...byName);
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push(row.tag);
    map.set(row.taskId, list);
  }
  return map;
}

export async function replaceTaskTags(db: DbOrTx, taskId: string, tagIds: string[]): Promise<void> {
  await db.delete(taskTags).where(eq(taskTags.taskId, taskId));
  if (tagIds.length > 0) {
    await db.insert(taskTags).values(tagIds.map((tagId) => ({ taskId, tagId })));
  }
}
