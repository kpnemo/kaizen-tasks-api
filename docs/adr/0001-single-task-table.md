# 0001: One task table with a nullable parent

- Status: Accepted
- Date: 2026-09-08

## Context

The product needs tasks with ordered subtasks (PRD R6). Subtasks carry the same fields as tasks
plus an origin (user or AI) and, for AI-suggested rows, a suggestion state. Two designs were
possible: a separate `subtasks` table with its own routes, or one `tasks` table where a subtask
is a task with a parent. PRD decision D30 settles on the latter; this record explains the shape.

## Decision

One `tasks` table with a nullable `parent_id` (foreign key to `tasks`, cascade delete). A row is
a root when `parent_id` is null. Children share every column with roots; `origin`,
`suggestion_state` and `rationale` are only meaningful on AI-created children, and a check
constraint keeps `suggestion_state` non-null exactly when `origin = 'ai'`.

Depth is not stored. The service constant `MAX_TASK_DEPTH = 2` in `src/services/tasks.ts`
means a child may only be created under a root and breakdown may only run on a root.

Ordering among siblings is `position`, then `created_at`, then `id`, backed by the
`tasks_parent_position_idx` index. `PATCH /tasks/:id` with `position` is a target index; the
service renumbers siblings densely in one transaction.

Progress (`{ done, total }`) counts children with origin `user` or suggestion state `accepted`,
computed in SQL as an aggregate over children.

## Consequences

- Fewer endpoints: every subtask operation is a task operation with `parentId`.
- "Break a step down further" becomes a one-line change (raise the constant, add a recursive
  load in the repository).
- Listing roots must always filter `parent_id is null`; the repository's `siblingScope` does this
  so no caller forgets.
- The check constraint means the seed and the processor must always set `suggestion_state` when
  inserting AI rows.
