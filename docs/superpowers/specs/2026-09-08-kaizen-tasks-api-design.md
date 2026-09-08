# Kaizen Tasks API: Design Spec

| Field | Value |
|---|---|
| Repo | `kaizen-tasks-api`, folder `webapp/backend/` |
| Status | Approved design, awaiting owner review of this document |
| Date | 2026-09-08 |
| Upstream | `webapp/docs/PRD.md` in the assembly-line repo (sections 5, 6, 7, 8.1) |
| Downstream | `superpowers:writing-plans` produces `docs/superpowers/plans/` from this spec |

## 1. Purpose and scope

This spec designs the first of four sub-projects: the Kaizen Tasks API. It covers the service, its data, its AI breakdown pipeline, its tests, its docs-enforcement harness, its CI, and its Railway deployment. It does not cover the web app, the cross-repo assembly-line harness, or the product skills; those get their own specs and reference this one for the API contract and the shared conventions.

Everything in the PRD's decision log is settled. The approach decisions taken during design are:

| # | Decision | Choice and reason |
|---|---|---|
| A1 | Task hierarchy | One `tasks` table with a nullable `parent_id`. Fewer endpoints, steps carry the same fields as tasks, and "break a step down further" becomes a later one-line feature. Depth capped at two by a named constant |
| A2 | Auth transport | Same-origin. The web service proxies `/api/*` to the API over Railway private networking, and Vite's dev proxy does the same locally. Refresh token in a first-party httpOnly cookie. No CORS. The API has no public domain |
| A3 | Worker topology | The BullMQ worker runs inside the API process, toggled by `WORKER_ENABLED`. One deployable per environment |
| A4 | Test database | A real local Postgres, tables truncated before every test. CI uses service containers |
| A5 | Layout | `webapp/` is the assembly-line repo; `webapp/backend/` and `webapp/frontend/` are independent nested repos, git-ignored by the parent |

## 2. System shape

### 2.1 Runtime

- Node 26 locally, `engines.node` set to `>=24 <27` so Railpack accepts the current LTS if 26 is unavailable there. ESM modules. TypeScript strict.
- Development runs `tsx watch src/server.ts`. Production runs `node dist/server.js` after `tsc` build.
- One process. `src/server.ts` executes the startup sequence in this order and exits non-zero on any failure before the port opens:
  1. Load and validate config from environment (zod). Print the list of missing or invalid variables.
  2. Run Drizzle migrations from `drizzle/`.
  3. Connect Redis (ioredis) and ping.
  4. If `SEED_DEMO_USER` is true, run the idempotent seed.
  5. If `WORKER_ENABLED` is true, start the BullMQ worker.
  6. Build the Express app through `createApp(deps)` and listen on `PORT`, host `::` (dual-stack, required because older Railway environments resolve private hostnames to IPv6 only).
- Graceful shutdown on SIGTERM: stop accepting connections, close the worker, close Redis and Postgres, exit.

### 2.2 Folder layout and import rules

```
webapp/backend/
  .claude/                 settings.json (hooks), skills/, agents/
  .github/workflows/ci.yml
  .railway/railway.ts
  docs/                    ARCHITECTURE.md, API.md (generated), adr/, architectural-files.txt, superpowers/
  drizzle/                 generated SQL migrations + meta
  scripts/                 docs-check.sh, format-file.sh, render-api-docs.ts, generate-openapi.ts
  src/
    server.ts              startup sequence
    app.ts                 createApp(deps): Express app factory
    config.ts              zod env schema -> Config
    lib/                   errors.ts, envelope.ts, logger.ts, request-id.ts, cursor.ts, auth.ts, redis.ts, rate-limit.ts
    db/                    client.ts, schema.ts, migrate.ts, seed.ts
    schemas/               zod request/response schemas per resource + openapi registry
    repositories/          Drizzle queries per aggregate
    services/              business rules per aggregate
    routes/                Express routers per resource + validate middleware
    agent/                 breakdown.ts (pure), model.ts (interface + adapters), prompts/breakdown.system.md
    jobs/                  queue.ts, worker.ts, processors/breakdown.ts
  tests/
    setup/                 global.ts (create db, migrate), each.ts (truncate, flush redis)
    api/                   supertest integration tests per resource
    jobs/                  queue integration test with a real worker
    fixtures/              recorded model outputs
  CHANGELOG.md  CLAUDE.md  README.md  openapi.json  package.json  tsconfig.json  vitest.config.ts  .env.example
```

Import rules, enforced by review and by the `reviewer` agent, not by tooling:

| Layer | May import |
|---|---|
| `routes` | `schemas`, `services`, `lib` |
| `services` | `repositories`, `agent`, `jobs/queue`, `lib` |
| `repositories` | `db`, `lib` |
| `jobs` | `services`, `repositories`, `agent`, `lib` |
| `agent` | `lib`, `schemas` |
| `lib`, `db`, `schemas` | nothing app-level above them |

Handlers never touch Drizzle. Services never import Express types.

### 2.3 Dependencies

Runtime: `express` 5, `zod` 4, `drizzle-orm`, `postgres` (postgres.js driver), `bullmq`, `ioredis`, `@anthropic-ai/sdk`, `jose` (JWT), `bcryptjs` (pure JS, no native build risk on Railpack), `helmet`, `cookie-parser`, `pino`, `pino-http`, `@asteasolutions/zod-to-openapi`, `octokit` (feature-request endpoint only).

Development: `typescript`, `tsx`, `drizzle-kit`, `vitest`, `supertest`, `eslint` (flat config, typescript-eslint), `prettier`, `@types/*`.

Verification item V1: `@asteasolutions/zod-to-openapi` must support zod 4 at the installed version. Fallback is `zod-openapi`, which has the same registry idea.

### 2.4 Config

`src/config.ts` exports a `Config` parsed once at startup:

| Variable | Type | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | url | required | |
| `REDIS_URL` | url | required | |
| `JWT_SECRET` | string, min 32 chars | required | |
| `ANTHROPIC_API_KEY` | string | required unless `AI_MODEL_PROVIDER=fake` | |
| `AI_MODEL_PROVIDER` | `anthropic` or `fake` | `anthropic` | `fake` used by tests and by local dev without a key |
| `AI_MODEL` | string | `claude-sonnet-5` | |
| `AI_RATE_LIMIT_PER_HOUR` | int | `20` | |
| `APP_ENV` | `development`, `test`, `staging`, `production` | `development` | Reported by health |
| `PORT` | int | `3000` | Railway injects it |
| `WORKER_ENABLED` | bool | `true` | |
| `SEED_DEMO_USER` | bool | `false` | |
| `SEED_DEMO_PASSWORD` | string | `kaizen-demo-2026` | |
| `LOG_LEVEL` | pino level | `info` | |
| `GITHUB_TOKEN` | string | optional | Feature-request endpoint |
| `GITHUB_REPO` | `owner/name` | optional | Feature-request endpoint |
| `RAILWAY_GIT_COMMIT_SHA` | string | `local` | Provided by Railway |

Cookies are `secure` unless `APP_ENV` is `development` or `test`.

### 2.5 Observability

`pino-http` logs one line per request with method, path, status, duration, user id when authenticated, and `requestId`. `request-id.ts` takes `x-request-id` from the inbound request or generates a UUID, sets it on the response, and exposes it to the envelope. Worker logs carry `jobId` and `taskId`.

## 3. Data model

### 3.1 Postgres schema (Drizzle)

Enums: `task_status` (todo, in_progress, done), `ai_status` (pending, running, done, failed, skipped), `task_origin` (user, ai), `suggestion_state` (suggested, accepted, dismissed).

| Table | Column | Type | Constraints |
|---|---|---|---|
| `users` | id | uuid pk | default gen_random_uuid() |
| | email | text | unique, stored lowercase |
| | password_hash | text | |
| | display_name | text | |
| | created_at, updated_at | timestamptz | default now() |
| `tasks` | id | uuid pk | |
| | user_id | uuid | fk users on delete cascade |
| | parent_id | uuid null | fk tasks on delete cascade |
| | title | text | 1 to 200 chars, enforced by zod |
| | description | text null | up to 4000 chars |
| | status | task_status | default todo |
| | position | integer | default 0, order among siblings |
| | origin | task_origin | default user |
| | suggestion_state | suggestion_state null | non-null only when origin = ai, enforced by a check constraint |
| | rationale | text null | |
| | ai_status | ai_status | default pending on root creates, skipped on child creates |
| | ai_error | text null | |
| | ai_tag_suggestions | text[] | default empty |
| | created_at, updated_at | timestamptz | |
| `tags` | id | uuid pk | |
| | user_id | uuid | fk users cascade |
| | name | text | 1 to 40 chars |
| | color | text | hex, validated by zod |
| | created_at | timestamptz | |
| `task_tags` | task_id, tag_id | uuid | composite pk, both fk cascade |

Indexes: `tasks (user_id, created_at desc, id desc)` for keyset listing; `tasks (parent_id, position)`; unique `tags (user_id, lower(name))`.

Depth is not stored. A row is root when `parent_id` is null. The service rule `MAX_TASK_DEPTH = 2` (in `services/tasks.ts`) means a child may only be created under a root, and breakdown may only run on a root. Raising the constant is the whole change needed to allow deeper nesting, plus the recursive load in the repository.

### 3.2 Redis keys

| Key | Value | TTL |
|---|---|---|
| `refresh:<tokenId>` | user id | 7 days |
| `ratelimit:breakdown:<userId>:<YYYYMMDDHH>` | counter | 1 hour |
| BullMQ keys under prefix `kaizen` | queue state | managed by BullMQ |

Nothing that must survive a Redis flush lives in Redis. Tests use Redis database index 1.

### 3.3 Migrations and seed

`drizzle-kit generate` produces SQL under `drizzle/`, committed. `src/db/migrate.ts` applies them with Drizzle's migrator at startup and in the test global setup. The seed upserts the demo user `demo@kaizen.local` with `SEED_DEMO_PASSWORD`, five root tasks in mixed states, one with accepted AI children and rationales, one with suggested children still pending review, one with a failed breakdown, and four tags linking tasks. The seed is idempotent: it exits early if the demo user exists.

## 4. API contract

### 4.1 Envelopes and errors

Success: `{ "data": <payload>, "meta": { "requestId": "...", "nextCursor": "..."? } }`. `nextCursor` appears only on list responses and is null on the last page.

Error: `{ "error": { "code": "...", "message": "...", "details": [ { "path": "body.title", "message": "..." } ], "requestId": "..." } }`. `details` is present only for validation errors.

Codes and status, from one function `statusFor(code)` in `lib/errors.ts`:

| Code | Status |
|---|---|
| `VALIDATION_ERROR` | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `RATE_LIMITED` | 429 |
| `UPSTREAM_ERROR` | 502 |
| `UNAVAILABLE` | 503 |
| `INTERNAL` | 500 |

`UNAVAILABLE` is used only by the health endpoint. `AppError extends Error` carries `code`, `message`, optional `details`. The single error middleware maps `AppError` to its envelope, zod errors to `VALIDATION_ERROR`, and anything else to `INTERNAL` with the message hidden outside development. Ownership failures are returned as `NOT_FOUND`, never `FORBIDDEN`.

### 4.2 Validation

`routes/validate.ts` exports `validate({ params?, query?, body? })`, an Express middleware that parses each part with its zod schema, replaces the request part with the parsed value, and throws `VALIDATION_ERROR` with per-field details on failure. Every route declares its schemas from `src/schemas/<resource>.ts`; the same schema objects are registered in the OpenAPI registry with a route summary and response schemas.

### 4.3 Authentication

- Access token: JWT HS256 via `jose`, 15 minutes, claims `sub` (user id), `email`. Sent as `Authorization: Bearer`. `requireAuth` middleware verifies it and sets `req.user`.
- Refresh token: 32 random bytes, base64url. Stored as `refresh:<id>` in Redis. Delivered as cookie `kaizen_refresh`: httpOnly, `SameSite=Lax`, `Path=/api/v1/auth`, `Max-Age` 7 days, `Secure` outside development and test. Refresh rotates: old key deleted, new key written, new cookie set. Logout deletes the key and clears the cookie.
- Passwords hashed with bcryptjs, cost 10. Minimum 8 characters.

### 4.4 Endpoints

All under `/api/v1`. Auth required everywhere except register, login, refresh, health, and the OpenAPI document.

| Method and path | Request | Response | Notes |
|---|---|---|---|
| POST `/auth/register` | email, password, displayName | 201 `{ user, accessToken }` + cookie | `CONFLICT` on duplicate email |
| POST `/auth/login` | email, password | 200 `{ user, accessToken }` + cookie | `UNAUTHORIZED` on bad credentials, same message for both cases |
| POST `/auth/refresh` | cookie | 200 `{ accessToken }` + rotated cookie | `UNAUTHORIZED` if missing or unknown |
| POST `/auth/logout` | cookie | 204 | |
| GET `/auth/me` | | 200 `{ user }` | |
| GET `/tasks` | query: status?, tagId?, parentId?, limit? (1 to 100, default 50), cursor? | 200 `TaskSummary[]` + nextCursor | Top-level only unless parentId given |
| POST `/tasks` | title, description?, parentId?, tagIds? | 201 `TaskDetail` | Root creates enqueue a breakdown; child creates set ai_status skipped |
| GET `/tasks/:id` | | 200 `TaskDetail` | Includes children, tags, progress, aiTagSuggestions, aiError |
| PATCH `/tasks/:id` | title?, description?, status?, position?, suggestionState? | 200 `TaskDetail` | suggestionState only valid on ai-origin rows |
| DELETE `/tasks/:id` | | 204 | Cascades to children |
| POST `/tasks/:id/breakdown` | | 202 `TaskDetail` | Root only. `CONFLICT` if ai_status is running. `RATE_LIMITED` when over limit |
| POST `/tasks/:id/suggestions/accept-all` | | 200 `TaskDetail` | All suggested children become accepted |
| POST `/tasks/:id/suggestions/dismiss-all` | | 200 `TaskDetail` | All suggested children become dismissed |
| PUT `/tasks/:id/tags` | tagIds[] | 200 `TaskDetail` | Replaces the set. Unknown or foreign tag ids give `VALIDATION_ERROR` |
| GET `/tags` | | 200 `Tag[]` | |
| POST `/tags` | name, color | 201 `Tag` | `CONFLICT` on duplicate name |
| PATCH `/tags/:id` | name?, color? | 200 `Tag` | |
| DELETE `/tags/:id` | | 204 | Removes links |
| POST `/feature-requests` | title, problem, proposedBehavior, acceptanceCriteria, outOfScope? | 201 `{ issueNumber, issueUrl }` | Mounted only when `GITHUB_TOKEN` and `GITHUB_REPO` are set. Body includes the submitter's display name. Labeled `feature-request`. GitHub failures give `UPSTREAM_ERROR` |
| GET `/health` | | 200 `{ status, commit, env, checks: { db, redis } }` | 503 `UNAVAILABLE` if a check fails |
| GET `/openapi.json` | | 200 document | Served from the committed file |

Shapes:

- `TaskSummary`: id, parentId, title, description, status, aiStatus, position, origin, suggestionState, tags (Tag[]), progress `{ done, total }`, createdAt, updatedAt.
- `TaskDetail`: `TaskSummary` plus children (`TaskSummary[]` ordered by position), aiTagSuggestions (string[]), aiError.
- `Tag`: id, name, color, createdAt.
- `User`: id, email, displayName, createdAt.

Progress counts children with origin user or suggestion state accepted; done is those with status done. Dismissed children are returned with their state so the web app can show a count and offer undo.

Suggestion state transitions allowed through PATCH: suggested to accepted, suggested to dismissed, dismissed to accepted, accepted to dismissed. Any other value on a user-origin row is `VALIDATION_ERROR`.

### 4.5 Pagination

Keyset on `(created_at desc, id desc)`. The cursor is base64url of `{ "c": "<iso timestamp>", "i": "<uuid>" }`. `lib/cursor.ts` encodes and decodes and throws `VALIDATION_ERROR` on garbage. The repository fetches `limit + 1` rows to know whether a next page exists.

### 4.6 OpenAPI

`src/schemas/registry.ts` holds one `OpenAPIRegistry`. Each resource schema file registers its schemas and paths. `scripts/generate-openapi.ts` writes `openapi.json`; `scripts/render-api-docs.ts` renders `docs/API.md` from it: one section per path and method with summary, parameters, request body fields, and response codes. Both run through `npm run openapi`; `npm run openapi -- --check` regenerates to a temp directory and exits non-zero on any difference. The committed `openapi.json` is what the web repo's client generator consumes.

## 5. AI breakdown pipeline

### 5.1 Queue and job

`jobs/queue.ts` exports `breakdownQueue` (BullMQ `Queue`, name `breakdown`, prefix `kaizen`) and `enqueueBreakdown({ taskId, userId, reason })` with reason `create`, `retry`, or `regenerate`. Job id is `${taskId}:${Date.now()}` so a task can be re-queued after a failure. Job options: 3 attempts, exponential backoff starting at 2 seconds, `removeOnComplete: true`, `removeOnFail: { count: 100 }`. Worker concurrency 3.

Concurrency guard lives in data, not in the queue: the breakdown action returns `CONFLICT` when `ai_status` is running.

### 5.2 Processor

`jobs/processors/breakdown.ts`, in order:

1. Load the task with children, the user's tags, and up to 30 of the user's open root task titles (excluding this task). If the task is gone, complete the job silently.
2. Skip rule: title has fewer than three words and description is empty. Set `ai_status = skipped`, `ai_error = "Too short to break down"`, complete.
3. Set `ai_status = running`, `ai_error = null`.
4. Call `breakdownTask(input, model)`.
5. On success, persist in one transaction: delete children with origin ai and state suggested; insert the new steps as children with origin ai, state suggested, rationale, positions continuing after the current maximum; set `ai_tag_suggestions` to the returned names not already on the task; set `ai_status = done`.
6. On a non-retryable failure (`BreakdownRefused`, `BreakdownInvalid`, 4xx API errors other than 429): set `ai_status = failed` with a short human-readable `ai_error`, complete the job without throwing.
7. On a retryable failure (429, 5xx, connection errors): throw, so BullMQ retries. If attempts are exhausted, the worker's `failed` handler sets `ai_status = failed` with "The assistant is unavailable, try again".

### 5.3 Agent module

`agent/model.ts` defines the seam:

```ts
export interface BreakdownModel {
  complete(input: BreakdownInput): Promise<BreakdownOutcome>;
}
// BreakdownOutcome = { kind: "ok", result: BreakdownResult } | { kind: "refused", reason: string } | { kind: "invalid", reason: string }
```

Two implementations: `AnthropicBreakdownModel` and `FakeBreakdownModel` (returns fixtures, can be told to refuse or fail). `config.AI_MODEL_PROVIDER` selects one at startup.

`agent/breakdown.ts` exports `breakdownTask(input, model)`: builds the user message, calls the model, post-validates (three to seven steps, titles trimmed and non-empty, deduplicated case-insensitively, at most three tag suggestions), and returns `BreakdownResult`.

`BreakdownInput`: `{ title, description, existingSteps: string[], tags: string[], openTasks: string[] }`.

`BreakdownResult` (zod, also the structured-output schema):

```ts
const BreakdownSchema = z.object({
  steps: z.array(z.object({ title: z.string(), rationale: z.string() })).min(3).max(7),
  tagSuggestions: z.array(z.string()).max(3),
});
```

The Anthropic adapter, per the current SDK surface:

```ts
const response = await client.messages.parse({
  model: config.AI_MODEL,                       // claude-sonnet-5
  max_tokens: 4096,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: JSON.stringify(input) }],
  output_config: { format: zodOutputFormat(BreakdownSchema), effort: "medium" },
});
if (response.stop_reason === "refusal") return { kind: "refused", reason: response.stop_details?.explanation ?? "refused" };
if (!response.parsed_output) return { kind: "invalid", reason: "unparseable" };
return { kind: "ok", result: response.parsed_output };
```

Thinking is left at the model default (adaptive on Sonnet 5). Client timeout 60 seconds, SDK retries left at the default of 2. `RateLimitError`, `APIConnectionError`, and `InternalServerError` propagate as retryable; other `APIError`s are wrapped as non-retryable.

### 5.4 Prompt

`agent/prompts/breakdown.system.md`, loaded once at startup and reviewed like code. Content, in prose sections: role (a coach helping someone move on a task in small steps); the reasoning procedure (state the outcome in one line, identify the first physical action, keep each step under about an hour, order by dependency, stop at seven, prefer concrete verbs); constraints (never repeat an existing step, reuse an existing tag name exactly when it fits, propose a new tag only when none fits, rationale is one sentence explaining why the step comes where it does); and the output contract (steps and tag suggestions, nothing else). The user message is the JSON of `BreakdownInput`.

### 5.5 Rate limit

`lib/rate-limit.ts` exports `consume(userId)` returning `{ allowed, remaining, resetAt }` using INCR and EXPIRE on the hourly key. Called by the tasks service on root create and on the breakdown action. On create, a denied consume creates the task with `ai_status = skipped` and `ai_error = "Hourly AI limit reached"`. On the breakdown action, it throws `RATE_LIMITED` with details `{ limit, resetAt }`.

## 6. Service rules

`services/tasks.ts`:

- Every read and write first loads the row by id and user id; a miss is `NOT_FOUND`.
- `create`: if `parentId` is given, the parent must belong to the user and be a root (depth rule). Position is max sibling position plus one. Root creates run `consume` and then enqueue. Tag ids are validated against the user's tags.
- `update`: `suggestionState` is accepted only when origin is ai and the transition is in the allowed set. `position` reorders among siblings by simple assignment; no renumbering.
- `breakdown`: root only, `CONFLICT` if running, `consume`, set `ai_status = pending`, enqueue with reason regenerate.
- `acceptAll` and `dismissAll`: one update statement over suggested children.
- `replaceTags`: validates ownership of every tag id, then deletes and inserts links in one transaction.
- Progress is computed in SQL as an aggregate over children, not in JavaScript.

`services/auth.ts` owns register, login, refresh, logout. `services/tags.ts` owns tag CRUD with the unique-name conflict. `services/feature-requests.ts` calls Octokit and maps failures to `UPSTREAM_ERROR`.

## 7. Testing

### 7.1 Setup

- Vitest with two projects: `unit` (files matching `src/**/*.test.ts`, parallel) and `integration` (files under `tests/`, `fileParallelism: false`, pool forks).
- `tests/setup/global.ts`: connect to the maintenance database, create `kaizen_test` if missing, run migrations.
- `tests/setup/each.ts`: `TRUNCATE users, tasks, tags, task_tags CASCADE` and `FLUSHDB` on Redis index 1 before each test.
- `createApp(deps)` receives `{ config, db, redis, queue, model, logger }`. Integration tests pass an in-memory queue fake that records enqueued jobs and can run them inline against the real processor, plus `FakeBreakdownModel`.
- `.env.test` sets `AI_MODEL_PROVIDER=fake`, `DATABASE_URL` to `kaizen_test`, `REDIS_URL` to index 1, `WORKER_ENABLED=false`.

### 7.2 Test list the plan must produce

Unit: envelope shape, `statusFor` mapping, `AppError` middleware output for each code, cursor round trip and garbage rejection, config validation errors listing every missing variable, `breakdownTask` post-validation (dedup, trim, bounds), skip rule, suggestion-state transition table, progress aggregation.

Integration (Supertest): register and login flows including duplicate email and wrong password; refresh rotation invalidates the old cookie; logout; task create enqueues a job with reason create and returns pending; child create under a root succeeds, under a child fails with the depth message; list pagination walks three pages without duplicates; filters by status and tag; patch suggestion states through every allowed and one disallowed transition; accept-all and dismiss-all; breakdown action returns `CONFLICT` when running and `RATE_LIMITED` past the limit; replace tags with a foreign tag id fails; delete cascades; health reports the commit SHA; feature-requests route is absent when unconfigured; the error envelope carries the request id.

Jobs: one test starts a real BullMQ worker against Redis index 1 with `FakeBreakdownModel`, creates a task, and waits for `ai_status = done` with three to seven suggested children and tag suggestions. A second case uses the fake's refuse mode and asserts failed with a message. A third runs regenerate and asserts previously suggested children are replaced while an accepted one survives.

Live, opt-in: `npm run test:live` runs one test against Anthropic when `ANTHROPIC_API_KEY` is present, asserting the schema is satisfied for a realistic task. Excluded from CI.

## 8. Docs and harness

### 8.1 Docs set

`README.md` (what it is, run locally, scripts, URLs), `docs/ARCHITECTURE.md` (the shape in section 2, the pipeline in section 5, the deploy topology in section 10, with one diagram in mermaid), `docs/API.md` (generated), `docs/adr/0001-single-task-table.md`, `0002-same-origin-through-web-proxy.md`, `0003-in-process-worker.md`, `CHANGELOG.md` in Keep a Changelog format with an `[Unreleased]` section, `CLAUDE.md`.

`docs/architectural-files.txt` lists globs: `src/db/schema.ts`, `drizzle/**`, `src/jobs/**`, `src/lib/auth.ts`, `src/agent/prompts/**`, `.railway/**`.

### 8.2 docs-check

`scripts/docs-check.sh` with modes `--hook` and `--ci`:

1. Changed set. Hook mode: `git diff --name-only HEAD` plus untracked files. CI mode: `git diff --name-only $BASE_SHA...HEAD`, where the workflow passes the PR base or the push's before-SHA.
2. If no file under `src/` changed, exit 0.
3. Rule A: `CHANGELOG.md` must be in the changed set and its `[Unreleased]` section must contain at least one bullet.
4. Rule B: if any file under `src/routes/` or `src/schemas/` changed, run `npm run openapi -- --check`; drift fails.
5. Rule C: if any changed file matches a glob in `docs/architectural-files.txt`, at least one `docs/adr/*.md` must be in the changed set.
6. Failure output lists each failed rule with the exact fix ("add a bullet under [Unreleased] in CHANGELOG.md", "run npm run openapi and commit", "add or update an ADR under docs/adr/").
7. Hook mode exits 2 on failure so Claude Code blocks the stop and feeds the message back. A counter in `.claude/.docs-check-blocks` stops blocking after three consecutive failures and prints a warning instead, so a stuck agent cannot loop forever; the counter resets on success.

### 8.3 Hooks

`.claude/settings.json`:

- `Stop`: `bash scripts/docs-check.sh --hook`.
- `PostToolUse` matching `Edit|Write`: `bash scripts/format-file.sh`, which reads the tool input JSON from stdin, and runs prettier on the file if it is inside the repo and has a formattable extension.

### 8.4 Skills

- `add-api-endpoint`: the checklist in order: restate the endpoint and its acceptance criteria; write the failing integration test; add or extend the zod schemas and register them; add the service method with the ownership check; add the repository query; add the route with `validate` and the envelope; run the tests to green; run `npm run openapi`; add the changelog bullet; add an ADR if an architectural file changed; run `npm run docs:check`. Includes file templates for schema, route, service, repository, and test.
- `write-adr`: template with context, decision, consequences, and status; numbering rule.
- `release-notes`: moves `[Unreleased]` into a dated version section and bumps `package.json`.

### 8.5 Agents

- `reviewer`: read-only. Takes a diff or branch, checks the import rules, envelope usage, validation on every route, ownership via `NOT_FOUND`, test presence, changelog and OpenAPI freshness, and returns PASS or a list of violations with file and line.
- `test-writer`: takes acceptance criteria and writes failing tests in the repo's conventions, without touching `src/`.

### 8.6 CLAUDE.md

Under one page: what the service is; the layering table; the envelope and error rules; "every endpoint change follows the add-api-endpoint skill"; where docs live and that the Stop hook enforces them; the architectural-files manifest; the scripts table; local setup pointer.

## 9. Local development

Prerequisites: Node 26, Homebrew `postgresql@17` and `redis` running as services. `createdb kaizen_dev && createdb kaizen_test`. Copy `.env.example` to `.env`, fill `JWT_SECRET` (any 32+ chars) and `ANTHROPIC_API_KEY`, or set `AI_MODEL_PROVIDER=fake` to run without a key.

Scripts, identical names in the web repo where applicable:

| Script | Does |
|---|---|
| `dev` | `tsx watch src/server.ts` |
| `build` | `tsc -p tsconfig.build.json` |
| `start` | `node dist/server.js` |
| `test` | vitest run, both projects |
| `test:live` | the opt-in live model test |
| `lint` | eslint and prettier check |
| `typecheck` | `tsc --noEmit` |
| `db:generate` | drizzle-kit generate |
| `db:migrate` | run migrations |
| `db:seed` | run the seed against `DATABASE_URL` |
| `openapi` | regenerate `openapi.json` and `docs/API.md`; `-- --check` for drift |
| `docs:check` | `scripts/docs-check.sh --hook` |

## 10. CI/CD and Railway

### 10.1 GitHub Actions

`.github/workflows/ci.yml`, workflow name `ci`, job id `ci`. Triggers: `pull_request` on all branches, `push` on `develop` and `main`. Concurrency group by ref with cancel-in-progress. Services: `postgres:17` and `redis:7` with health options. Steps: checkout with full history (needed for the docs-check diff), setup-node 26 with npm cache, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` with `DATABASE_URL` and `REDIS_URL` pointing at the services and `AI_MODEL_PROVIDER=fake`, `scripts/docs-check.sh --ci` with `BASE_SHA` from the PR base or the push before-SHA, `npm run build`.

### 10.2 Branch protection

For `develop` and `main`: require a pull request, require the `ci` status check, block force pushes and deletions. Applied with `gh api` in the plan and recorded as a script in the assembly-line repo so it can be replayed.

### 10.3 Railway

Project `kaizen-tasks`, environments `staging` and `production`. In each: service `api` from GitHub `kaizen-tasks-api`, service `web` (web spec), `Postgres`, `Redis`. `api` tracks `develop` in staging and `main` in production, wait-for-CI on, no public domain, private hostname `api.railway.internal`.

`.railway/railway.ts` declares the `api` service: Railpack build, start `node dist/server.js`, healthcheck `/api/v1/health`, healthcheck timeout 120 seconds. Verification item V2: confirm the IaC schema supports the per-environment branch. If not, branch and wait-for-CI are set per environment with the CLI or dashboard and the runbook records the steps.

Variables per environment: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`, `JWT_SECRET` generated per environment, `ANTHROPIC_API_KEY` pasted by the owner, `APP_ENV`, `WORKER_ENABLED=true`, `AI_MODEL=claude-sonnet-5`, `AI_RATE_LIMIT_PER_HOUR=20`, `LOG_LEVEL=info`, `SEED_DEMO_USER=true`, `SEED_DEMO_PASSWORD` set by the owner, and `GITHUB_TOKEN` and `GITHUB_REPO` once the feature-request page exists.

Verification item V3: Railpack accepts Node 26 from `engines`; otherwise the range falls back to 24 and CI pins 24 too.

### 10.4 Deploy flow

Merge to `develop`, Actions runs on the push, Railway holds the deployment while CI runs, CI passes, Railway builds and deploys staging, the healthcheck passes, traffic switches. A pull request from `develop` to `main` repeats it for production, gated additionally by the web repo's smoke check. Rollback is Railway's redeploy of the previous deployment, documented in the runbook.

## 11. Verification items

Not open design questions, but facts to confirm during the build, each with a fallback already chosen:

| # | Check | Fallback |
|---|---|---|
| V1 | `@asteasolutions/zod-to-openapi` supports zod 4 | `zod-openapi` |
| V2 | `.railway/railway.ts` supports per-environment branch | Set branch and wait-for-CI per environment with the CLI |
| V3 | Railpack builds Node 26 from `engines` | Pin 24 in engines and CI |
| V4 | Wait-for-CI holds the deploy on a push-triggered workflow | GitHub Actions deploys through the Railway CLI |
| V5 | `messages.parse` with `zodOutputFormat` accepts the schema with `min` and `max` array bounds | Drop the bounds from the schema and enforce them in post-validation only |

## 12. Out of scope for this spec

The web app, the Caddy proxy config, the smoke test, the assembly-line skills (`triage-requests`, `implement-issue`), the issue form, the seeded requests, the product skills, and the runbook. Password reset, email verification, real-time push, multi-user sharing, and nesting deeper than two levels.
