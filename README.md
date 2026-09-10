# Kaizen Tasks API

The API behind Kaizen Tasks: a personal task manager where every big task is broken into small,
doable steps by an AI assistant, and the human decides what to keep. Express 5 on Node 24, Postgres
through Drizzle, Redis for sessions, rate limits and the BullMQ breakdown queue, and the Anthropic
SDK behind a small model seam.

This is one of four repositories built for the Product Assembly Line workshop. The web app lives in
`kaizen-tasks-web`; the cross-repo harness, smoke test and runbook live in `kaizen-tasks-assembly-line`.

## Run locally

Prerequisites: nvm with Node 24, Homebrew `postgresql@17` and `redis` running as services.

```bash
nvm install 24 && nvm use
brew services start postgresql@17
brew services start redis
createdb kaizen_dev
createdb kaizen_test
cp .env.example .env    # fill JWT_SECRET (32+ chars) and ANTHROPIC_API_KEY, or set AI_MODEL_PROVIDER=fake
npm install
npm run dev             # http://localhost:3000/api/v1/health
```

The web app's Vite dev server proxies `/api/*` to this port, so the API is normally reached through
the web app's origin. There is no CORS configuration by design (ADR 0002).

## Scripts

| Script                | Does                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `npm run dev`         | `tsx watch src/server.ts`                                                   |
| `npm run build`       | `tsc -p tsconfig.build.json && scripts/copy-assets.sh`                      |
| `npm start`           | `node dist/server.js`                                                       |
| `npm test`            | vitest, `unit` and `integration` projects (needs local Postgres and Redis)  |
| `npm run test:live`   | the opt-in live model test; runs only with `ANTHROPIC_API_KEY` set          |
| `npm run lint`        | eslint and prettier check                                                   |
| `npm run typecheck`   | `tsc --noEmit`                                                              |
| `npm run db:generate` | drizzle-kit generate                                                        |
| `npm run db:migrate`  | run migrations                                                              |
| `npm run db:seed`     | create the demo fixtures if absent; `-- --reset` deletes and recreates them |
| `npm run openapi`     | regenerate `openapi.json` and `docs/API.md`; `-- --check` for drift         |
| `npm run docs:check`  | `scripts/docs-check.sh --hook`                                              |

## URLs

| Environment | How to reach the API                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Local       | `http://localhost:3000/api/v1/health`                                                                        |
| Staging     | through the staging web domain, `https://<web-domain>/api/v1/health` (recorded in the assembly-line runbook) |
| Production  | through the production web domain, same path                                                                 |

The API service has no public domain of its own; the web service proxies `/api/*` to
`http://api.railway.internal:3000`.

## Documentation

- `docs/API.md`: generated reference (do not edit by hand; run `npm run openapi`).
- `docs/ARCHITECTURE.md`: service shape, AI pipeline, deploy topology.
- `docs/adr/`: architecture decision records.
- `CHANGELOG.md`: Keep a Changelog format; every change adds a bullet under `[Unreleased]`.
- `CLAUDE.md`: conventions for agentic work in this repo.

## Testing

`npm test` runs two Vitest projects: `unit` (`src/**/*.test.ts`, parallel) and `integration`
(`tests/**`, sequential, real Postgres `kaizen_test` and Redis db 1; tables are truncated and Redis
flushed before every test). `tests/jobs/breakdown.test.ts` runs a real BullMQ worker. The global
setup creates `kaizen_test` if it is missing and applies migrations.

`npm run test:live` runs one test against Anthropic with the committed prompt; it needs
`ANTHROPIC_API_KEY` in `.env` and is excluded from CI.

## Demo user and facilitator reset

With `SEED_DEMO_USER=true` the API creates `demo@kaizen.local` (password `SEED_DEMO_PASSWORD`) and
its fixtures at startup if absent. `POST /api/v1/admin/seed-reset` with header `x-admin-token`
(mounted only when `ADMIN_TOKEN` is set) deletes and recreates them with the same ids; locally,
`npm run db:seed -- --reset` does the same.

## Feature requests

When `GITHUB_TOKEN` and `GITHUB_REPO` (`owner/name`) are set, `POST /api/v1/feature-requests`
files a `feature-request` issue in that repository with the submitter's display name in the body.

## The readiness rubric

`src/agent/prompts/readiness.md` is a byte-identical copy of `rubric/readiness.md` in
`kaizen-tasks-assembly-line`, sent as the second system block of the interview prompt so the in-app
assistant, the product manager's local `refine-request` skill and engineering's triage all score
from the same text. Refresh it with `npm run rubric:sync` (add `-- --local ../rubric/readiness.md`
to copy from a local checkout); `npm run rubric:check` compares the two `version:` lines and warns.
CI runs the check as a warning step. Never edit the copy by hand: it lives under
`src/agent/prompts/**`, so a change to it is a prompt change and needs an ADR.

## Operator switches

`AI_ENABLED=false` pauses the assistant everywhere: task creates still succeed, skipped with reason
`ai_disabled`; the breakdown action returns 503 `UNAVAILABLE`; and an interview turn returns 503
`UNAVAILABLE` before the stream starts. `AI_RATE_LIMIT_PER_HOUR` and `AI_GLOBAL_LIMIT_PER_HOUR`
bound breakdowns per user and per environment per hour. `INTERVIEW_HOURLY_LIMIT` (default 60) bounds
interview turns per user per hour on its own Redis counter, so an interview never spends the
breakdown budget. All four are Railway variables and take effect on restart without a deploy.
