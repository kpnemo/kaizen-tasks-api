import { isUniqueViolation, type Db } from "../db/client.js";
import type { TagRow } from "../db/schema.js";
import { conflict, notFound } from "../lib/errors.js";
import { deleteTag, findTag, insertTag, listTags, updateTag } from "../repositories/tags.js";
import type { CreateTagInput, Tag, UpdateTagInput } from "../schemas/tags.js";

export interface TagsService {
  list(userId: string): Promise<Tag[]>;
  create(userId: string, input: CreateTagInput): Promise<Tag>;
  update(userId: string, id: string, input: UpdateTagInput): Promise<Tag>;
  remove(userId: string, id: string): Promise<void>;
}

export function toTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt.toISOString() };
}

const duplicate = (name: string) => conflict(`A tag named "${name}" already exists`);

export function createTagsService(deps: { db: Db }): TagsService {
  const { db } = deps;
  return {
    async list(userId) {
      return (await listTags(db, userId)).map(toTag);
    },

    async create(userId, input) {
      try {
        const row = await insertTag(db, {
          userId,
          name: input.name,
          color: input.color.toLowerCase(),
        });
        return toTag(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate(input.name);
        throw err;
      }
    },

    async update(userId, id, input) {
      const existing = await findTag(db, id, userId);
      if (!existing) throw notFound("Tag not found");
      const patch: { name?: string; color?: string } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color.toLowerCase();
      try {
        const row = await updateTag(db, id, userId, patch);
        if (!row) throw notFound("Tag not found");
        return toTag(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate(input.name ?? existing.name);
        throw err;
      }
    },

    async remove(userId, id) {
      const deleted = await deleteTag(db, id, userId);
      if (!deleted) throw notFound("Tag not found");
    },
  };
}
