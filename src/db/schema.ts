import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  ConversationMessage,
  FeatureRequestDraft,
  RubricScore,
} from "../schemas/feature-request-conversations.js";

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
  "no_steps_needed",
]);
export const taskOriginEnum = pgEnum("task_origin", ["user", "ai"]);
export const suggestionStateEnum = pgEnum("suggestion_state", [
  "suggested",
  "accepted",
  "dismissed",
]);
/** The account-level theme choice. `system` means "follow the browser's prefers-color-scheme". */
export const themePreferenceEnum = pgEnum("theme_preference", ["light", "dark", "system"]);

// Millisecond precision keeps keyset cursors (ISO strings) exact.
const stamp = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  theme: themePreferenceEnum("theme").notNull().default("system"),
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

export const featureRequestConversationStatusEnum = pgEnum("feature_request_conversation_status", [
  "open",
  "ready",
  "filed",
  "abandoned",
]);

/**
 * One assistant-led interview. `draft` is stored partial (the model fills fields as it learns
 * them) and the service fills the missing keys from EMPTY_DRAFT before it leaves the service.
 * The partial unique index is the invariant the service relies on: at most one open or ready
 * conversation per user, so "resume mine" and "start over" need no id, and a concurrent second
 * "start over" is a 23505 the repository maps to a conflict rather than a second live row.
 */
export const featureRequestConversations = pgTable(
  "feature_request_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: featureRequestConversationStatusEnum("status").notNull().default("open"),
    messages: jsonb("messages")
      .$type<ConversationMessage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    draft: jsonb("draft")
      .$type<Partial<FeatureRequestDraft>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    score: jsonb("score").$type<RubricScore>(),
    questionCount: integer("question_count").notNull().default(0),
    stillMissing: jsonb("still_missing")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    issueNumber: integer("issue_number"),
    // Optimistic-concurrency token. Every turn reads it, then persists with a conditional UPDATE
    // that matches on it and increments it, so a slower overlapping turn updates zero rows
    // instead of overwriting newer state (ADR 0005).
    version: integer("version").notNull().default(0),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    uniqueIndex("feature_request_conversations_open_user_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('open', 'ready')`),
  ],
);

export type FeatureRequestConversationRow = typeof featureRequestConversations.$inferSelect;
export type NewFeatureRequestConversationRow = typeof featureRequestConversations.$inferInsert;

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
