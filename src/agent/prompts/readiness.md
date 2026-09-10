---
version: 1
owner: kpnemo/kaizen-tasks-assembly-line
---

# Readiness rubric

This document is written for a model to follow. It scores one feature request on three scales, decides whether the request implies an architecture change, computes a readiness score, and, when the request is unclear, produces two or three clarifying questions. The `triage-requests` skill in the assembly-line repository and the `refine-request` skill in the product-skills repository both follow it, so a product manager's local score and the engineering triage score agree for the same text. The `version:` line above changes whenever an anchor, the formula, or the output shape changes.

## 1. Scales

Score each scale as an integer from 1 to 5. Pick the highest anchor whose every condition is met by the text as written, not by what the reader can infer.

### Clarity

| Score | Anchor                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | A wish with no user and no outcome. The reader cannot say who benefits or what would be different.                                     |
| 2     | A goal with no observable behavior. The reader knows what the requester wants to be true, but not what a user would see or do.         |
| 3     | Behavior is described, but acceptance criteria are missing or untestable. A tester could not write a pass-or-fail check from the text. |
| 4     | Testable acceptance criteria and a stated scope. Every criterion can be checked by a tester with a yes or a no.                        |
| 5     | Everything in 4, and the request also names what is out of scope and at least one edge case.                                           |

### Complexity

| Score | Anchor                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | One file in one repo.                                                                                                                              |
| 2     | One repo, a few files, no schema change.                                                                                                           |
| 3     | Both repos, or a schema-additive change (a new column with a default, a new table, a new index).                                                   |
| 4     | A new subsystem or an external integration (a new queue, a new third-party API, a new background process, a new page that talks to a new service). |
| 5     | Restructures existing flows: changes how existing screens, endpoints, or jobs relate to each other.                                                |

### Risk

| Score | Anchor                                                                                     |
| ----- | ------------------------------------------------------------------------------------------ |
| 1     | Cosmetic: copy, layout, color, ordering.                                                   |
| 2     | Isolated behavior: a new control or rule that cannot affect other features or stored data. |
| 3     | Touches authentication, stored data, or the AI prompt or its inputs.                       |
| 4     | Could lose or expose data.                                                                 |
| 5     | Changes security or multi-user boundaries.                                                 |

## 2. Architecture change test

`archChange` is true when the request implies touching any of the following. Otherwise it is false.

- The database schema beyond additive columns: dropping, renaming, or retyping a column, or changing a constraint.
- Authentication or session handling.
- The queue: job shape, worker topology, retry policy.
- The agent's system prompt or the agent's output schema.
- The proxy between the web service and the API.
- The API contract in a breaking way: removing or renaming a field, changing a status code, changing an envelope.
- Multi-user data sharing of any kind.

When the request is too vague to know what would change (clarity 1 or 2), set `archChange` to false and let the clarifying questions surface it. Do not infer an architecture change from a wish.

## 3. Readiness

```
readiness = clarity * 2 + (6 - complexity) + (6 - risk)
```

Range 4 to 20. Sort descending. Every request with `archChange` true sorts after every request with `archChange` false, regardless of score. Ties break by creation date ascending, oldest first.

## 4. Procedure

1. Read the whole request: problem, proposed behavior, acceptance criteria, out of scope, and the requester's role when given.
2. Score clarity first, from the acceptance criteria alone. A well-written problem statement does not raise clarity; only checkable criteria do. Bullets that a tester can answer yes or no are criteria; adjectives ("faster", "better", "intuitive") are not.
3. Score complexity and risk by naming the files or areas that would change, using the repo layouts below. Write those names into the reasons.
4. Apply the architecture change test.
5. Compute readiness with the formula.
6. If clarity is below 3, write clarifying questions following section 5. Otherwise `questions` is an empty array.
7. Output exactly this shape. When asked for the score alone, output the JSON and nothing else.

```json
{
  "clarity": 4,
  "complexity": 2,
  "risk": 1,
  "archChange": false,
  "readiness": 17,
  "reasons": {
    "clarity": "one sentence on the acceptance criteria",
    "complexity": "one sentence naming the files or areas that change",
    "risk": "one sentence naming what the change can affect"
  },
  "questions": []
}
```

### Repo layouts used for scoring

API, `kaizen-tasks-api` (`backend/`): `src/routes/` (Express routers, one per resource), `src/schemas/` (zod request and response schemas, OpenAPI registry), `src/services/` (business rules, ownership checks), `src/repositories/` (Drizzle queries), `src/db/schema.ts` and `drizzle/` (schema and migrations), `src/agent/` (breakdown module, `prompts/breakdown.system.md`), `src/jobs/` (BullMQ queue, worker, reconciler), `src/lib/auth.ts` (JWT and refresh cookie), `openapi.json` (generated contract). Architectural files: `src/db/schema.ts`, `drizzle/**`, `src/jobs/**`, `src/lib/auth.ts`, `src/agent/prompts/**`, `.railway/**`.

Web, `kaizen-tasks-web` (`frontend/`): `src/features/<domain>/` (tasks, tags, auth, feature-request: pages, components, hooks, tests), `src/components/ui/` (shadcn primitives), `src/api/` (committed contract copy, generated types, client with auth middleware), `src/app/router.tsx` (routes), `Caddyfile` (static serving and the `/api/*` proxy). Architectural files: `src/api/**`, `Caddyfile`, `.railway/**`, `src/app/router.tsx`, `src/main.tsx`.

A change confined to one feature folder in the web is complexity 2. A change that adds an endpoint and a screen is complexity 3. A change that adds a column with a default is complexity 3. A change to the prompt file is risk 3 and, when the prompt's instructions change, `archChange` true.

## 5. Clarifying questions

Only when clarity is below 3. Write two or three questions, each answerable in one sentence, drawn from these patterns and phrased for the requester's role when given:

- Who is the user and when does this happen?
- What does the user see when it works?
- What would make you say it is done?
- What should explicitly not change?

Do not ask about implementation. Do not ask more than three questions.
