---
name: add-api-endpoint
description: Use when adding or changing an HTTP endpoint in this API. Walks the checklist from failing test to docs so two endpoints written in two sessions are indistinguishable in shape.
---

# Add an API endpoint

Every endpoint ships with a schema, a route, a service change if needed, a repository query if
needed, an integration test against the real test database, an OpenAPI registration, and a
CHANGELOG entry. The Stop hook checks the docs; this checklist gets you there in order.

## Checklist, in order

1. Restate the endpoint and its acceptance criteria in one paragraph: method, path, request
   shape, response shape, status codes, error codes, ownership rule. Say it back before writing code.
2. Write the failing integration test in `tests/api/<resource>.test.ts` using
   `createTestApp` and `registerUser` from `tests/helpers/`. Cover the happy path, validation,
   and the ownership miss (`404 NOT_FOUND`). Run it: `npx vitest run --project integration tests/api/<resource>.test.ts`. It must fail for the right reason.
3. Add or extend the zod schemas in `src/schemas/<resource>.ts` and register the path with
   `registry.registerPath` (summary, `security: bearerAuth` unless public, request schemas,
   responses through `jsonResponse` and `errorResponses`). Use the bare resource path (`/widgets`,
   not `/api/v1/widgets`): the OpenAPI document's `servers` entry already adds the `/api/v1`
   prefix, and `src/app.ts` mounts every router under it, so tests and clients hit the full
   `/api/v1/widgets` path while `registerPath` itself stays prefix-free. Import the new schema
   file into `src/schemas/index.ts` (a bare `import "./widgets.js";`) so its `registerPath` calls
   actually run, and add the resource to the `tags` array there.
4. Add the service method in `src/services/<resource>.ts`. It loads the row by id and user id
   first (`NOT_FOUND` on a miss), applies the rule, and returns the API shape. No Express types.
5. Add the repository query in `src/repositories/<resource>.ts` taking `DbOrTx`.
6. Add the route in `src/routes/<resource>.ts`: `validate(schemas)`, `validated<typeof schemas>(res)`,
   `currentUser(req)`, `sendData` / `sendNoContent`. Mount it in `src/app.ts` if the router is new
   (`api.use("/widgets", requireAuth(config), widgetsRouter(...))`, following the `tags` and
   `tasks` mounts — omit `requireAuth` only for a genuinely public endpoint).
7. Regenerate the contract: `npm run openapi`. `openapi.json` and `docs/API.md` are part of this
   change, not a follow-up.
8. Add a bullet under `[Unreleased]` in `CHANGELOG.md`.
9. If a file matching `docs/architectural-files.txt` changed, add or update an ADR with the
   `write-adr` skill.
10. Regenerate the product map: `npm run product-map`. Steps 7, 8 and 9 each touched one of its
    sources, and a test asserts the committed map is fresh, so this comes before the test run and
    not after it.
11. Run the tests to green: `npm test`. Then `npm run typecheck && npm run lint`.
12. Run `npm run docs:check`. Fix anything it reports. Commit with the `Co-Authored-By` trailer line.

## Templates

Schema (`src/schemas/<resource>.ts`):

```ts
import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { bearerAuth, registry } from "./registry.js";

export const WidgetSchema = z
  .object({ id: z.uuid(), name: z.string(), createdAt: z.iso.datetime() })
  .openapi("Widget");
export const CreateWidgetBody = z
  .object({ name: z.string().trim().min(1).max(80) })
  .openapi("CreateWidgetBody");
export type Widget = z.infer<typeof WidgetSchema>;
export type CreateWidgetInput = z.infer<typeof CreateWidgetBody>;

registry.registerPath({
  method: "post",
  path: `/widgets`,
  tags: ["widgets"],
  summary: "Create a widget",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateWidgetBody } } } },
  responses: {
    201: jsonResponse("Created", envelope(WidgetSchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED"),
  },
});
```

Route (`src/routes/<resource>.ts`):

```ts
import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData } from "../lib/envelope.js";
import { CreateWidgetBody } from "../schemas/widgets.js";
import type { WidgetsService } from "../services/widgets.js";
import { validate, validated } from "./validate.js";

const createSchemas = { body: CreateWidgetBody };

export function widgetsRouter(service: WidgetsService): Router {
  const router = Router();
  router.post("/", validate(createSchemas), async (req, res) => {
    const { body } = validated<typeof createSchemas>(res);
    sendData(res, await service.create(currentUser(req).id, body), { status: 201 });
  });
  return router;
}
```

Service (`src/services/<resource>.ts`):

```ts
import type { Db } from "../db/client.js";
import { notFound } from "../lib/errors.js";
import { findWidget, insertWidget } from "../repositories/widgets.js";
import type { CreateWidgetInput, Widget } from "../schemas/widgets.js";

export interface WidgetsService {
  create(userId: string, input: CreateWidgetInput): Promise<Widget>;
  get(userId: string, id: string): Promise<Widget>;
}

export function createWidgetsService(deps: { db: Db }): WidgetsService {
  return {
    async create(userId, input) {
      const row = await insertWidget(deps.db, { userId, name: input.name });
      return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
    },
    async get(userId, id) {
      const row = await findWidget(deps.db, id, userId);
      if (!row) throw notFound("Widget not found");
      return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
    },
  };
}
```

Repository (`src/repositories/<resource>.ts`):

```ts
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { widgets } from "../db/schema.js";

export async function findWidget(db: DbOrTx, id: string, userId: string) {
  const [row] = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
    .limit(1);
  return row;
}

export async function insertWidget(db: DbOrTx, values: { userId: string; name: string }) {
  const [row] = await db.insert(widgets).values(values).returning();
  if (!row) throw new Error("insert widgets returned no row");
  return row;
}
```

Test (`tests/api/<resource>.test.ts`):

```ts
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe("POST /api/v1/widgets", () => {
  it("creates a widget", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app)
      .post("/api/v1/widgets")
      .set(auth(user.token))
      .send({ name: "First" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "First" });
  });

  it("validates the body", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app)
      .post("/api/v1/widgets")
      .set(auth(user.token))
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("body.name");
  });
});
```
