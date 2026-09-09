# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Toolchain: TypeScript strict ESM, ESLint flat config, Prettier, Vitest projects, Node 24 pin.
- Config module that validates every environment variable at startup and lists all problems.
- Error codes with a single status mapping, success and error envelopes, request ids, pino logging.
- `GET /api/v1/health` with commit SHA, environment, database and Redis checks, and `features.featureRequests`.
- `GET /api/v1/openapi.json` serving the committed contract.
- zod schemas for every endpoint, registered into an OpenAPI 3.1 document; `npm run openapi` generates `openapi.json` and `docs/API.md`, `-- --check` detects drift.
- Build pipeline that copies the versioned system prompt into `dist/` and a CI gate that checks it.
- `ci` GitHub Actions workflow and the Railway IaC declaration for the `api` service.
- OpenAPI document declares `servers: /api/v1` and bare path keys.
- Drizzle schema for users, tasks (self-referencing `parent_id`, depth cap 2 via services), tags and task_tags; initial migration `0000_init`; database client and migration runner; integration test setup against `kaizen_test` and Redis index 1.
- BullMQ breakdown queue (`kaizen:breakdown`) with fixed job ids, retry/backoff options, an ioredis factory, the `BreakdownModel` seam and its error types, and fakes (`FakeBreakdownModel`, `FakeQueue`) for the services and worker tasks that follow.
- Authentication: register, login, refresh rotation, logout and `GET /api/v1/auth/me`, with `requireAuth` bearer middleware, bcrypt password hashing, JWT access tokens and a Redis-backed rotating refresh cookie; `AppDeps` widened to the real app dependencies (db, redis, queue, model), and a test harness (`createTestApp`, `registerUser`) running the full app against real Postgres and Redis.
- Hourly per-user and global AI rate limiter with kill switch (AI_ENABLED) and configurable request budgets (AI_RATE_LIMIT_PER_HOUR, AI_GLOBAL_LIMIT_PER_HOUR); tracks counters on Redis with one-hour TTL, denies with reason codes (`ai_disabled` or `rate_limited`) and scope (`user` or `global`).
- Tag CRUD (`GET/POST /api/v1/tags`, `PATCH/DELETE /api/v1/tags/:id`) behind `requireAuth`, with case-insensitive per-user uniqueness enforced by the database index, ownership checks mapped to `NOT_FOUND`, and repository helpers (`findOwnedTags`, `tagsForTasks`, `replaceTaskTags`) for tasks to consume later.
- Task create, get, keyset list and delete (`GET/POST /api/v1/tasks`, `GET/DELETE /api/v1/tasks/:id`) behind `requireAuth`, with a depth cap of two levels, owned-tag assignment on create inside a transaction, a `generation_id`-guarded AI state write, best-effort breakdown enqueue on root create (skipped when AI is disabled or rate limited, failed without blocking creation when the queue is unavailable), and a single SQL aggregate per batch for child progress and suggestion counts.
- Task update (`PATCH /api/v1/tasks/:id`) with field edits, race-safe sibling reorder via a `FOR UPDATE` lock and dense renumbering, and the AI-suggestion state machine (`suggested` to `accepted`/`dismissed`, `dismissed` to `accepted`, `accepted` to `dismissed`); bulk `POST /api/v1/tasks/:id/suggestions/accept-all` and `dismiss-all`; and `PUT /api/v1/tasks/:id/tags` to replace a task's tag set atomically with ownership-checked ids.
- Agent module: `loadSystemPrompt`/`promptPath` resolving the versioned prompt from `src/` or `dist/`, `shouldSkipBreakdown` and `postValidate` breakdown logic, `breakdownTask` orchestration, an `AnthropicBreakdownModel` adapter using `messages.parse` with a zod output format and mapping retryable/non-retryable/refused/invalid outcomes, and `createBreakdownModel` selecting the adapter from `AI_MODEL_PROVIDER`.
- Breakdown processor (`processBreakdownJob`) running a job end to end with every write guarded by `generation_id` (skip rule, superseded-generation discard, refused/invalid/non-retryable failures recorded, retryable failures rethrown for the queue to retry) and the `POST /api/v1/tasks/:id/breakdown` action that reserves a generation with one conditional update, enqueues the job, and never fails the request when the queue is unavailable.
- Real BullMQ breakdown worker (`startBreakdownWorker`, concurrency 3) that marks a task failed with the "unavailable" message only on its final attempt and only when the generation still matches, and a stale-generation reconciler (`reconcileStaleGenerations`, `startReconciler`) that fails tasks stuck in `pending`/`running` past `AI_STALE_MINUTES` on a five-minute unref'd interval.
- Deterministic demo seed (`src/db/seed.ts`, `DEMO_EMAIL`, `SEED_IDS`, `ensureDemoSeed`, `resetDemoSeed`, `npm run db:seed [-- --reset]`) with five root tasks, ten AI-generated children and four tags at stable ids, and `POST /api/v1/admin/seed-reset` mounted only when `ADMIN_TOKEN` is set, authenticated by a constant-time `x-admin-token` check that returns the same `NOT_FOUND` as an unmounted route on a wrong or missing token.

### Changed

- Layering: services may import `db/seed` (demo fixture and reset are db-layer code).
