# CLAUDE.md

Kaizen Tasks API: a personal task manager's backend where an AI assistant proposes small steps and
the human decides. Express 5 on Node 24, Postgres through Drizzle, Redis and BullMQ, Anthropic SDK.
Spec: `docs/superpowers/specs/2026-09-08-kaizen-tasks-api-design.md`. Architecture: `docs/ARCHITECTURE.md`.

## Layering

| Layer                              | May import                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes`                       | `schemas`, `services`, `lib`                                                                                                       |
| `src/services`                     | `repositories`, `agent`, `jobs/queue`, `lib`, `db/seed`                                                                            |
| `src/repositories`                 | `db`, `lib`                                                                                                                        |
| `src/jobs`                         | `services`, `repositories`, `agent`, `lib`                                                                                         |
| `src/agent`                        | `lib`, `schemas`                                                                                                                   |
| `src/lib`, `src/db`, `src/schemas` | nothing app-level above them (`schemas` may import `lib/errors` for the code list; `db/seed.ts` may import `lib/auth` for hashing) |

`src/db/seed.ts` holds the demo fixture and its reset routine; it is db-layer code like the
migrations, importable by services and by the server startup.

`import type` from `src/schemas` is allowed anywhere. Handlers never touch Drizzle. Services never
import Express types.

## Envelopes and errors

- Success: `{ data, meta: { requestId, nextCursor? } }` via `sendData(res, data, { status?, nextCursor? })`; 204 via `sendNoContent(res)`.
- Error: `{ error: { code, message, details?, requestId } }`. Throw `AppError` or a constructor from `src/lib/errors.ts`; never build an error body by hand. Status comes from `statusFor(code)`. `details` exists only for `VALIDATION_ERROR` and `RATE_LIMITED`.
- Ownership failures are `NOT_FOUND`, never `FORBIDDEN`. Every service method loads the row by id and user id first.
- Every route validates with `validate({ params?, query?, body? })` and reads through `validated<typeof schemas>(res)`. Never assign to `req.query`.

## Rules

- Every endpoint change follows the `add-api-endpoint` skill (`.claude/skills/add-api-endpoint/SKILL.md`): test first, schema and OpenAPI registration, service with ownership check, repository, route, `npm run openapi`, changelog, ADR if architectural, `npm run docs:check`.
- Migrations are additive only: add tables, add columns with defaults, add indexes; never drop, rename, or change types in the same release. See `docs/adr/0004-additive-migrations-only.md`. Generate with `npm run db:generate -- --name <what>` and commit `drizzle/`.
- Docs are part of every change and the Stop hook enforces them (`scripts/docs-check.sh --hook`, same script as CI): a bullet under `[Unreleased]` in `CHANGELOG.md` when code changes; `npm run openapi` when `src/routes/` or `src/schemas/` change; an ADR under `docs/adr/` (use the `write-adr` skill) when a file matching `docs/architectural-files.txt` changes.
- Architectural files: `src/db/schema.ts`, `drizzle/**`, `src/jobs/**`, `src/lib/auth.ts`, `src/agent/prompts/**`, `.railway/**`.
- Tests: unit tests live next to the code as `src/**/*.test.ts`; integration tests under `tests/` run against real Postgres (`kaizen_test`) and Redis db 1, truncated before each test. `tests/helpers/app.ts` builds the app with a fake queue and a fake model. Use `superpowers:test-driven-development`.
- The `reviewer` agent checks a diff against these rules; the `test-writer` agent drafts failing tests from acceptance criteria.
- Node 24 via `nvm use` before any npm command. Work on `develop`; commits end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Scripts

| Script                                                        | Does                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run dev` / `npm start`                                   | tsx watch / node dist                                      |
| `npm test` / `npm run test:live`                              | vitest unit and integration / opt-in live model test       |
| `npm run lint` / `npm run typecheck`                          | eslint and prettier / tsc                                  |
| `npm run db:generate` / `db:migrate` / `db:seed [-- --reset]` | drizzle-kit generate / apply migrations / demo fixtures    |
| `npm run openapi [-- --check]`                                | regenerate `openapi.json` and `docs/API.md` / detect drift |
| `npm run docs:check`                                          | the Stop hook check, by hand                               |

Local setup: `README.md`, "Run locally".
