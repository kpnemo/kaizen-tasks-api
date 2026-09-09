# CLAUDE.md

Kaizen Tasks API: Express 5 on Node 24, Postgres through Drizzle, Redis and BullMQ, Anthropic SDK.
Spec: `docs/superpowers/specs/2026-09-08-kaizen-tasks-api-design.md`. Plan: `docs/superpowers/plans/2026-09-08-kaizen-tasks-api.md`.

## Layering

| Layer                              | May import                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `src/routes`                       | `schemas`, `services`, `lib`                                                       |
| `src/services`                     | `repositories`, `agent`, `jobs/queue`, `lib`, `db/seed`                            |
| `src/repositories`                 | `db`, `lib`                                                                        |
| `src/jobs`                         | `services`, `repositories`, `agent`, `lib`                                         |
| `src/agent`                        | `lib`, `schemas`                                                                   |
| `src/lib`, `src/db`, `src/schemas` | nothing app-level above them (`schemas` may import `lib/errors` for the code list) |

`src/db/seed.ts` holds the demo fixture and its reset routine; it is db-layer code like the migrations, importable by services and by the server startup.

`import type` from `src/schemas` is allowed anywhere. Handlers never touch Drizzle. Services never import Express types.

## Envelopes and errors

- Success: `{ data, meta: { requestId, nextCursor? } }` through `sendData(res, data, { status?, nextCursor? })`.
- Error: `{ error: { code, message, details?, requestId } }`. Throw `AppError` (or a constructor from `src/lib/errors.ts`); never build an error body by hand. Status comes from `statusFor(code)`.
- Ownership failures are `NOT_FOUND`, never `FORBIDDEN`.
- Every route validates with `validate({ params?, query?, body? })` and reads through `validated<typeof schemas>(res)`.

## Rules

- Every endpoint change follows the `add-api-endpoint` skill (`.claude/skills/add-api-endpoint/SKILL.md`).
- Migrations are additive only: add columns with defaults, add tables, add indexes; never drop or rename in the same release. See ADR 0004.
- Docs are part of every change: a bullet under `[Unreleased]` in `CHANGELOG.md`, `npm run openapi` when routes or schemas change, an ADR when an architectural file changes. The Stop hook (`scripts/docs-check.sh --hook`) blocks until they are there; CI runs the same script.
- Architectural files are listed in `docs/architectural-files.txt`.
- Node 24 via `nvm use` before any npm command. Commits end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Scripts

See the table in `README.md`. Local setup is in `README.md`, "Run locally".
