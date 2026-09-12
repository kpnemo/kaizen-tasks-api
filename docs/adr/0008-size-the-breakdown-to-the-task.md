# 0008: Size the breakdown to the task, with one in-band re-ask above fifty steps

- Status: Accepted
- Date: 2026-09-12

## Context

Every breakdown returns three to seven steps whatever the task. The bound is enforced three
times: the system prompt (`src/agent/prompts/breakdown.system.md`, "Stop at seven ... Never
return fewer than three"), the zod output schema (`src/schemas/breakdown.ts`, `.min(3).max(7)`,
which is also the structured-output format handed to the Anthropic SDK), and `postValidate` in
`src/agent/breakdown.ts` (truncate at seven, `BreakdownInvalid` below three). A tiny task is padded
and a large one is squeezed, and the model has no way to say "this task needs no steps".

Issue kpnemo/kaizen-tasks-assembly-line#34 asks the assistant to judge the size first and propose
only the steps the task needs, from none up to fifty, re-asking once when the answer is over fifty
and showing everything that comes back after that. ADR 0003 made BullMQ the only retry layer, one
bounded model call per job attempt; a second call inside one attempt is a change to that rule, and
the prompt's instructions and the output contract change, so this is recorded here.

## Decision

1. **The prompt sizes the breakdown.** `breakdown.system.md`'s "How to reason" section leads with
   the size judgement as its first step and gates the rest on it: judge how much work the task is
   before anything else; return no steps, and stop, when the task is small enough to do as it is;
   otherwise work through the remaining reasoning steps, which end by returning only the steps the
   task needs, never more than fifty. The output contract says "zero to fifty". The reasoning steps
   keep their content and order relative to each other, only re-numbered to make room for the
   judgement at the front.
2. **The output schema no longer bounds the count.** `src/schemas/breakdown.ts` drops `MIN_STEPS`,
   keeps `MAX_STEPS = 50` as the _soft_ ceiling, and the zod `steps` array carries `.min(0)` and a
   loose parse bound (`.max(200)`) so an oversize answer parses and can be counted instead of
   failing schema validation. An empty `steps` array is a valid answer meaning "no steps needed".
3. **One in-band re-ask, then take what comes.** `breakdownTask` in `src/agent/breakdown.ts`
   counts the distinct steps after cleaning. Above `MAX_STEPS` it calls the model once more with
   `maxSteps: 50` on the input (`BreakdownInput` gains an optional `maxSteps`; the user message
   carries it and the prompt tells the model to respect it). The second answer is final: no
   truncation, every distinct step is kept, unless it holds no steps, in which case the first
   answer is kept: a task the assistant just proposed sixty steps for is not small enough to do as
   is. `postValidate` no longer truncates and no longer throws below a minimum. This is the one
   exception to ADR 0003's single call per attempt; BullMQ still owns retries for failures.
4. **No steps is a skip, not a failure.** `aiSkipReasonEnum` in `src/db/schema.ts` gains the
   additive value `no_steps_needed` (`ALTER TYPE ... ADD VALUE`, ADR 0004). When the final answer
   has zero steps, `processBreakdownJob` in `src/jobs/processors/breakdown.ts` writes
   `aiStatus = 'skipped'`, `aiSkipReason = 'no_steps_needed'`, keeps any tag suggestions, and
   creates no suggested steps. `AiSkipReasonSchema` in `src/schemas/tasks.ts` and the contract
   follow; the web labels it "Small enough to do as is".
5. **The pre-model title rule stays.** `shouldSkipBreakdown` (under three words, no description →
   `too_short`) is unchanged: it saves a model call for titles that cannot be broken down.
6. **Limits are unchanged.** The hourly limit and the session budget count breakdown requests, not
   model calls; the re-ask costs tokens only. `AI_ENABLED` is unchanged.

## Consequences

- Task detail may show up to fifty (or, after a stubborn second answer, more) suggested steps; the
  web renders every step and does not cap. Accept-all and dismiss-all work on the whole list.
- A breakdown can take two model calls; the worst case is roughly twice the 45-second timeout per
  call inside one job attempt. Worker concurrency (5) is unchanged.
- The fake model gains scripted answers per call so tests can drive "sixty then fifty", "sixty then
  sixty" and "no steps". `prompt.test.ts`, `breakdown.test.ts` and `schemas.test.ts` change with the
  bounds and the enum.
- Rollback is a code rollback; the enum value stays in the database, unused, which is harmless.
- `docs/PRD.md` in the assembly-line repo still says three to seven and needs its own docs change.
