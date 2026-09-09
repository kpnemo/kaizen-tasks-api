# 0003: BullMQ worker inside the API process

- Status: Accepted
- Date: 2026-09-08

## Context

AI breakdowns run as queue jobs (PRD R10, R17). A separate worker service would double the
Railway services per environment, need its own deploy gating, and add a second place to keep
config in sync, for a workshop whose whole load is one room of people. PRD decision D32 chose an
in-process worker.

## Decision

`src/server.ts` starts the BullMQ worker and the stale-generation reconciler in the same process
as the HTTP API when `WORKER_ENABLED=true` (the default). Worker concurrency is 3. The Anthropic
client is created with `maxRetries: 0` and a 45-second timeout so BullMQ is the only retry layer
(3 attempts, exponential backoff from 3 seconds).

The queue and the worker each use their own ioredis connection (`maxRetriesPerRequest: null`),
separate from the connection the API uses for sessions and rate limits.

Graceful shutdown on SIGTERM: stop accepting connections, stop the reconciler, close the worker
(finishing active jobs), close the queue, quit Redis connections, end the Postgres pool.

## Consequences

- One deployable per environment; `WORKER_ENABLED=false` turns a replica into an API-only node
  if the worker ever needs to move out.
- A slow model call occupies one of three worker slots but never blocks the event loop.
- Redis flushes lose queued jobs; the reconciler turns the affected tasks into retryable failures
  within `AI_STALE_MINUTES`.
- Tests run with `WORKER_ENABLED=false` and drive the processor directly, plus one real-worker
  suite under `tests/jobs/`.

## Amendment 2026-09-09

The reconciler now ticks every 60 seconds (`RECONCILE_INTERVAL_MS`), down from 5 minutes; the
query it runs is indexed (`tasks_ai_status_updated_idx`) and costs nothing at workshop scale.
Workshop environments (staging, and production if the session runs there) set
`AI_STALE_MINUTES=3`. Together this bounds a stuck spinner — worker crash, Redis flush, or a lost
job — to roughly 4 minutes instead of the previous worst case of 15 minutes, well inside a 3-hour
session.
