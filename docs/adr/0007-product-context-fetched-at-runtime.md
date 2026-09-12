# 0007: Fetch the product context for the interview at runtime

- Status: Accepted
- Date: 2026-09-12

## Context

The interview prompt (`src/agent/prompts/interview.system.md`) carried no knowledge of the product,
so it asked what the product maps already answer (harness issue #31, spec
`docs/superpowers/specs/2026-09-12-context-aware-interview-design.md` section 3.2). The web repo's
`docs/product-map.md` and `docs/ui-conventions.md` are regenerated and gated in that repo; a
vendored copy here would go stale on every web change, and a client-supplied block would let a
browser write system-prompt text. The same change rewrote that prompt (spec section 3.3): it gained
the opening turn that confirms what the assistant understood, the rules for choosing the next
question from the product context, the `recommended` answer every question now carries, and the
finishing rules — a prompt change, and so part of this record.

## Decision

`src/agent/interview/product-context.ts` reads this repo's `docs/product-map.md` from disk (three
levels above the module, so `src/` and `dist/` resolve alike) and fetches the two web documents from
`https://raw.githubusercontent.com/kpnemo/kaizen-tasks-web/<PRODUCT_CONTEXT_REF>/docs/...` at
startup and every `PRODUCT_CONTEXT_REFRESH_MINUTES`, without a token (public repo). History
sections (`## Recent releases`, `## Unreleased changes`) are dropped. The three documents form the
third cached system block; a failed fetch keeps the previous pair, logs one warning, and the block
says `unavailable (fetch failed)` for the missing document. Staging reads `develop`, production
reads `main`. The ref is declared in `.railway/railway.ts` as `production ? "main" : "develop"`, so a `railway config apply` carries it and a dashboard-only value cannot be dropped by the next apply.

## Consequences

Startup waits at most one 10 s fetch. The prompt's cache prefix changes when a map changes, so the
first turn after a web deploy pays the cache write. The interview never fails for lack of context;
it degrades to the API map. Rollback is a redeploy: no schema, no data.
