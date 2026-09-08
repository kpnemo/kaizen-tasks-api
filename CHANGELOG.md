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
