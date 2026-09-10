# 0005: Interview agent for feature requests

- Status: Proposed
- Date: 2026-09-10

## Context

The in-app "Request a feature" form collects five fields that a product manager fills in one pass,
so engineering's triage receives requests that score 8 to 11 on the readiness rubric. The agentic
feature-request design (`../superpowers/specs/2026-09-10-agentic-feature-request-design.md`, spec
sections 1 and 3) turns that form into an interview: an assistant asks one rubric-driven question
per turn, fills the five fields as it learns them, and hands the PM a prefilled form once the
request would score as ready. The interview transcript and the PM's self-score travel with the
GitHub issue.

Interview state has to survive a page reload and a redeploy, so it lives in Postgres, not Redis.
The state is a small, whole-object document — a transcript, a draft, a score — that is always read
and written as one unit, so `jsonb` columns fit it better than four related tables.

## Decision

One additive table, `feature_request_conversations` (`src/db/schema.ts`, migration
`drizzle/0001_feature_request_conversations.sql`):

- `status` is the enum `feature_request_conversation_status`: `open`, `ready`, `filed`,
  `abandoned`. `open` accepts turns; `ready` means the assistant said the request is ready or the
  eight-question cap was reached; `filed` and `abandoned` are terminal.
- `messages`, `draft`, `still_missing` are `jsonb not null` with `'[]'` / `'{}'` defaults, typed in
  Drizzle with `$type<...>()` from the contract types in
  `src/schemas/feature-request-conversations.ts`. `score` is nullable `jsonb`.
- A partial unique index, `feature_request_conversations_open_user_idx` on `(user_id) where status
in ('open','ready')`, enforces at most one live conversation per user. The service relies on it:
  `get(userId)` and `abandon(userId)` need no conversation id, and "start over" is abandon-then-
  insert with the database, not the service, guaranteeing there is never a second live row.
- `version integer not null default 0` is the optimistic-concurrency token. A turn reads the row,
  calls the model, then persists with a single conditional
  `UPDATE ... WHERE id = ? AND user_id = ? AND status = 'open' AND version = <read version>` that
  sets `version = version + 1`. Zero rows updated means another turn, or a filing, changed the
  conversation while the model was thinking: the turn streams `error` with code `CONFLICT` and
  persists nothing. `markConversationFiled` is conditional on `status in ('open','ready')` only, so
  filing wins a race against an in-flight turn and the turn is the side that is told `CONFLICT`.
- `create` is one transaction: abandon the live rows, then insert. Two concurrent creates collide on
  the partial unique index; the loser's `23505` rolls its whole transaction back, so the prior
  conversation is still live, and the repository maps it to `undefined`, which the service turns
  into `CONFLICT`.
- `user_id` cascades on user delete, like every other user-owned table.

The migration is additive only (ADR 0004): one new enum type, one new table, one new index. Nothing
existing is dropped, renamed or retyped, so a rollback to the previous deployment still starts.

## Decision: the prompt and the rubric copy

The interview's instructions are `src/agent/prompts/interview.system.md`, which ports the
`refine-request` skill's Step 4 (the one-question-per-turn rules, the five-item question ladder, the
eight-question cap and the stop condition) so a product manager gets the same interview in the app
and in their local skill. It carries the turn contract — plain-text reply, then exactly one
`report_turn` call, never JSON in the text — and the five draft-field rules.

The readiness rubric is not restated in that prompt. `src/agent/prompts/readiness.md` is a
byte-identical copy of `rubric/readiness.md` in `kaizen-tasks-assembly-line`, sent as a second
system block. Copying rather than restating is what keeps the three consumers — the assembly line's
`triage-requests`, the product-skills `refine-request` skill and this API — scoring from one text.
`scripts/sync-rubric.sh` (ported from the product-skills repo) downloads or copies it and, with
`--check`, compares the two `version:` lines; CI runs `--check` as a warning step, never a gate,
because a rubric version bump is the assembly line's release, not this repo's.

Both files are system blocks with `cache_control: { type: "ephemeral" }` and are frozen for the life
of a deploy, so every turn of every conversation reads the same cached prefix.

## Consequences

- Rolling back to the release before this one leaves the table in place and unread; no data loss,
  no failed startup.
- A conversation is never partially written: the service persists messages, draft, score, question
  count, still-missing and status in one conditional update, only after a valid model turn, and only
  when the row is still the one it read.
- The partial index makes a concurrent double "start over" a unique violation rather than two live
  conversations; `create` abandons first, inside the same request, so the window is small and the
  failure is a plain 409-shaped conflict rather than corrupt state.
- Reviewers check any later migration touching this table against ADR 0004's allowed list.
- A rubric change in the assembly line does not reach the API until someone runs `npm run rubric:sync`; CI warns, and the version line in every issue's refinement section says which text produced the score.
- Editing either prompt file needs an ADR update (`docs/architectural-files.txt` matches `src/agent/prompts/**`), and the build copies both into `dist/`, where `scripts/check-dist-assets.sh` and the startup asset assertion both check for them.
