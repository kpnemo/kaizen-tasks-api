import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done"]);
export const aiStatusEnum = pgEnum("ai_status", [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export const aiSkipReasonEnum = pgEnum("ai_skip_reason", [
  "too_short",
  "rate_limited",
  "ai_disabled",
]);
export const taskOriginEnum = pgEnum("task_origin", ["user", "ai"]);
export const suggestionStateEnum = pgEnum("suggestion_state", [
  "suggested",
  "accepted",
  "dismissed",
]);

// Millisecond precision keeps keyset cursors (ISO strings) exact.
const stamp = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: stamp("created_at"),
  updatedAt: stamp("updated_at"),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("todo"),
    position: integer("position").notNull().default(0),
    origin: taskOriginEnum("origin").notNull().default("user"),
    suggestionState: suggestionStateEnum("suggestion_state"),
    rationale: text("rationale"),
    aiStatus: aiStatusEnum("ai_status").notNull().default("pending"),
    aiSkipReason: aiSkipReasonEnum("ai_skip_reason"),
    aiError: text("ai_error"),
    generationId: uuid("generation_id"),
    aiTagSuggestions: text("ai_tag_suggestions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    index("tasks_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
    index("tasks_parent_position_idx").on(t.parentId, t.position, t.createdAt, t.id),
    index("tasks_ai_status_updated_idx").on(t.aiStatus, t.updatedAt),
    check(
      "tasks_suggestion_state_origin_check",
      sql`(${t.origin} = 'ai') = (${t.suggestionState} is not null)`,
    ),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [uniqueIndex("tags_user_lower_name_idx").on(t.userId, sql`lower(${t.name})`)],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
