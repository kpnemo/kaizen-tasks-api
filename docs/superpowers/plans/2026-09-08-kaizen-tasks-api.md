# Kaizen Tasks API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kaizen Tasks API: an Express 5 service on Node 24 with Postgres, Redis and BullMQ, an Anthropic-backed task breakdown pipeline, a committed OpenAPI contract, a full test suite, the docs-enforcement harness, CI, and the Railway IaC file.

**Architecture:** One Node process runs the HTTP API and, behind `WORKER_ENABLED`, the BullMQ worker and the stale-generation reconciler. Routes validate with zod, call services that own business rules, and services call Drizzle repositories. The AI breakdown is a queue job: the service reserves a generation id with one conditional update, the worker calls the model through a `BreakdownModel` seam, and every write is guarded by that generation id.

**Tech Stack:** TypeScript 5.9 (strict, ESM, NodeNext), Express 5.2, zod 4.5, drizzle-orm 0.45 with postgres.js and drizzle-kit 0.31, bullmq 6.3, ioredis 5.11, jose 6, bcryptjs 3, pino 10 and pino-http 11, helmet 8, cookie-parser, @asteasolutions/zod-to-openapi 9.1, @anthropic-ai/sdk 0.124, octokit 5, vitest 5, supertest 7, tsx, eslint 10 with typescript-eslint 8, prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-08-kaizen-tasks-api-design.md` (this repo). Master plan with cross-lane interfaces: `../docs/superpowers/plans/2026-09-08-master-plan.md` (assembly-line repo, `webapp/docs/superpowers/plans/`). PRD: `webapp/docs/PRD.md` sections 5, 6, 7, 8.1.

## Global Constraints

Copied verbatim from the master plan. Every task's requirements implicitly include this section.

- Node 24 LTS everywhere, pinned by `.nvmrc` containing `24`; `engines.node` is `>=24 <25`. Run `nvm use` before any npm command.
- Branching: work on `develop`. Feature branches come off `develop` and merge by pull request. `main` receives only `develop` by pull request after staging verification. Nothing is ever pushed to `main` directly. `develop` is the default branch on GitHub.
- Commit messages end with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (the orchestrator dropped the former `Claude-Session` trailer on 2026-09-08; the master plan's wording predates that ruling).
- Secrets never enter a repository. `ANTHROPIC_API_KEY`, `JWT_SECRET`, `ADMIN_TOKEN`, `SEED_DEMO_PASSWORD`, and any GitHub token live only in Railway variables and in git-ignored local `.env` files. Mike pastes them.
- Railway: only the new project `kaizen-tasks`. Never link to, modify, or redeploy any other project in the account. Railway operations follow the official `use-railway` skill.
- GitHub: repos `kpnemo/kaizen-tasks-api`, `kpnemo/kaizen-tasks-web`, `kpnemo/kaizen-tasks-assembly-line`, `kpnemo/kaizen-tasks-product-skills`, all public.
- TypeScript strict in every repo. ESM. Prettier formatting. ESLint flat config.
- Test first: every task shows a failing test before implementation. Tests that hit external services are opt-in and excluded from CI.
- Docs are part of every change: `CHANGELOG.md` `[Unreleased]` bullet, regenerated OpenAPI or types where applicable, ADR when an architectural file changes. The docs-check script enforces it locally and in CI.
- Migrations are additive only (ADR 0004 in the API repo).
- The API service pins `PORT=3000`; the web service proxies `/api/*` to `http://api.railway.internal:3000`.
- The workshop root folder is not a repository. `webapp/` is `kaizen-tasks-assembly-line`; `webapp/backend/` and `webapp/frontend/` are nested, git-ignored repositories; `product-skills/` is at the root.

From the API spec itself:

- Runtime: Node 24, ESM, TypeScript strict. Development runs `tsx watch src/server.ts`; production runs `node dist/server.js`. `npm run build` is `tsc -p tsconfig.build.json && scripts/copy-assets.sh`.
- Layering (spec 2.2): `routes` import `schemas`, `services`, `lib`; `services` import `repositories`, `agent`, `jobs/queue`, `lib`; `repositories` import `db`, `lib`; `jobs` import `services`, `repositories`, `agent`, `lib`; `agent` imports `lib`, `schemas`; `lib`, `db`, `schemas` import nothing app-level above them. Type-only imports (`import type`) from `schemas` are allowed in any layer. Handlers never touch Drizzle. Services never import Express types.
- Envelopes (spec 4.1): success `{ "data": ..., "meta": { "requestId", "nextCursor"? } }`; error `{ "error": { "code", "message", "details"?, "requestId" } }`. `details` exists only for `VALIDATION_ERROR` (`[{ path, message }]`) and `RATE_LIMITED` (`{ scope, limit, resetAt }`). Status comes from `statusFor(code)`. Ownership failures are `NOT_FOUND`, never `FORBIDDEN`.
- Validation (spec 4.2): `validate({ params?, query?, body? })` stores parsed values in `res.locals.validated`; it never assigns to `req.query` (a read-only getter in Express 5).
- Auth (spec 4.3): JWT HS256 via jose, 15 minutes, claims `sub` and `email`. Refresh token 32 random bytes base64url in Redis key `refresh:<token>`, cookie `kaizen_refresh`, httpOnly, `SameSite=Lax`, `Path=/api/v1/auth`, 7 days, `Secure` outside development and test. bcryptjs cost 10, password minimum 8 characters.
- Data (spec 3): one `tasks` table with nullable `parent_id`; `MAX_TASK_DEPTH = 2` in `services/tasks.ts`; migrations are additive only; the seed uses stable UUIDs and runs in one transaction. Tests use Redis database index 1 and Postgres database `kaizen_test`.
- Queue (spec 5.1): queue name `breakdown`, prefix `kaizen`, job id `${taskId}-${generationId}`, 3 attempts, exponential backoff from 3 seconds, `removeOnComplete: true`, `removeOnFail: { count: 100 }`, worker concurrency 3. BullMQ is the only retry layer: the Anthropic client uses `maxRetries: 0` and a 45-second timeout.
- Every write the processor makes carries `WHERE generation_id = <job's>`.
- Anthropic SDK usage is limited to the shapes in this plan: `client.messages.parse` with `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`, `output_config: { format, effort }`, `stop_reason === "refusal"`, `stop_details?.explanation`, `parsed_output`, and the typed error classes `RateLimitError`, `APIConnectionError`, `APIConnectionTimeoutError`, `InternalServerError`, `APIError`.
- Version pins chosen on 2026-09-08 after checking the registry: `typescript` stays on `~5.9.3` because `typescript-eslint` 8.70 declares `typescript <6.1.0` and the registry's `latest` is the 7.x line; `ioredis` stays on `^5.11.1` because 6.0.0 switched the default wire protocol to RESP3, which BullMQ 6 has not certified; `@types/node` is `^24` to match the runtime.

## Scope check

This plan covers one subsystem: the API repository. The web app, the assembly-line harness, and the product skills have their own specs and plans. Milestone **L1-M1** (backend skeleton: scaffold, config, envelope, health, all schemas, `openapi.json`, `ci.yml`, `railway.ts`) is Tasks 1 through 7 and is stated explicitly where it ends. Milestone **L1-M2** (everything else) is Tasks 8 through 24.

## File structure

Every file the plan creates, with its one responsibility. Paths are relative to `webapp/backend/`.

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `.nvmrc`, `.env.example`, `.env.test`, `drizzle.config.ts` | Toolchain |
| `src/config.ts` | zod env schema, `loadConfig`, `Config`, `ConfigError` |
| `src/lib/errors.ts` | `ERROR_CODES`, `statusFor`, `AppError`, constructors |
| `src/lib/envelope.ts` | `successEnvelope`, `errorEnvelope`, `sendData`, `sendNoContent` |
| `src/lib/error-handler.ts` | Express `notFoundHandler`, `errorHandler` |
| `src/lib/logger.ts` | pino logger and pino-http middleware |
| `src/lib/request-id.ts` | `requestId` middleware |
| `src/lib/cursor.ts` | keyset cursor encode and decode |
| `src/lib/auth.ts` | JWT sign and verify, refresh tokens, cookies, bcrypt, `requireAuth`, `currentUser` |
| `src/lib/redis.ts` | `createRedis` |
| `src/lib/rate-limit.ts` | `createRateLimiter`, `consume` |
| `src/lib/assets.ts` | `assertRuntimeAssets` |
| `src/types/express.d.ts` | Express type augmentation (`req.user`, `res.locals.requestId`) |
| `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/seed.ts` | Drizzle schema, connection factory, migrator, demo seed |
| `src/schemas/registry.ts`, `common.ts`, `auth.ts`, `tasks.ts`, `tags.ts`, `feature-requests.ts`, `admin.ts`, `health.ts`, `breakdown.ts`, `index.ts` | zod request and response schemas, OpenAPI registration, `generateOpenApiDocument` |
| `src/repositories/users.ts`, `tags.ts`, `tasks.ts` | Drizzle queries per aggregate |
| `src/services/auth.ts`, `tags.ts`, `tasks.ts`, `suggestions.ts`, `feature-requests.ts` | Business rules |
| `src/routes/validate.ts`, `health.ts`, `openapi.ts`, `auth.ts`, `tasks.ts`, `tags.ts`, `feature-requests.ts`, `admin.ts` | Express routers |
| `src/agent/model.ts`, `fake-model.ts`, `anthropic-model.ts`, `errors.ts`, `prompt.ts`, `breakdown.ts`, `prompts/breakdown.system.md` | Model seam, adapters, prompt, pure breakdown logic |
| `src/jobs/queue.ts`, `worker.ts`, `reconcile.ts`, `processors/breakdown.ts` | BullMQ queue, worker, reconciler, job processor |
| `src/app.ts`, `src/server.ts` | App factory and startup sequence |
| `scripts/generate-openapi.ts`, `render-api-docs.ts`, `copy-assets.sh`, `check-dist-assets.sh`, `docs-check.sh`, `format-file.sh` | Generators and harness scripts |
| `tests/setup/env.ts`, `global.ts`, `each.ts`; `tests/helpers/app.ts`, `auth.ts`, `fake-queue.ts`; `tests/fixtures/breakdown.ok.json`; `tests/api/*.test.ts`; `tests/jobs/breakdown.test.ts`; `tests/live/breakdown.live.test.ts` | Integration, jobs, and live tests |
| `.github/workflows/ci.yml`, `promote.yml` | CI and promotion gate |
| `.railway/railway.ts` | Railway IaC for the `api` service |
| `.claude/settings.json`, `.claude/skills/*/SKILL.md`, `.claude/agents/*.md` | Harness |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/adr/000{1,2,3,4}-*.md`, `docs/architectural-files.txt`, `openapi.json` | Docs and contract |

## Conventions used by every task

- All commands run from `webapp/backend/` after `nvm use`. Local Postgres and Redis run as Homebrew services (`brew services start postgresql@17 redis`). Before Task 8 run `createdb kaizen_dev` and `createdb kaizen_test` once.
- Relative imports inside `src/`, `tests/`, and `scripts/` use the `.js` extension (`import { x } from "./errors.js"`), which is what `module: "nodenext"` requires. tsx and vitest resolve them to the `.ts` sources.
- Test output shown as "Expected" is the shape of the vitest summary, not a byte-exact transcript; test names and pass/fail counts must match.
- Every commit ends with this exact trailer line (the last line of the message):

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

- Commit commands in the plan are written as `git commit -F -` with a heredoc so the trailer is exact. Example:

```bash
git commit -F - <<'MSG'
feat: subject line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

# Milestone L1-M1: backend skeleton

### Task 1: Repository scaffold and config module

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `.nvmrc`, `.env.example`, `.env.test`
- Create: `tests/setup/env.ts`, `tests/setup/global.ts`, `tests/setup/each.ts` (env loading only; Task 8 adds the database and Redis work)
- Modify: `.gitignore`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`, `type Config`, `class ConfigError extends Error { problems: string[] }`, `isSecureCookieEnv(config: Config): boolean`. npm scripts `dev`, `build`, `start`, `test`, `test:live`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `db:seed`, `openapi`, `docs:check`. Vitest projects `unit` (`src/**/*.test.ts`), `integration` (`tests/**/*.test.ts` minus `tests/live`), `live` (`tests/live/**`).

- [ ] **Step 1: Write the toolchain files**

`.nvmrc`:

```
24
```

`package.json` (the script names and bodies are the spec's section 9 table; `db:migrate`, `db:seed`, `openapi`, `test:live` are implemented by files created in later tasks, which is fine because nothing runs them yet):

```json
{
  "name": "kaizen-tasks-api",
  "version": "0.1.0",
  "private": true,
  "description": "Kaizen Tasks API: tasks broken into small steps by an AI assistant, with the human in control",
  "type": "module",
  "engines": {
    "node": ">=24 <25"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json && scripts/copy-assets.sh",
    "start": "node dist/server.js",
    "test": "vitest run --project unit --project integration",
    "test:live": "vitest run --project live",
    "lint": "eslint . && prettier --check .",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:seed": "tsx src/db/seed.ts",
    "openapi": "tsx scripts/generate-openapi.ts",
    "docs:check": "bash scripts/docs-check.sh --hook"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.124.0",
    "@asteasolutions/zod-to-openapi": "^9.1.0",
    "bcryptjs": "^3.0.3",
    "bullmq": "^6.3.4",
    "cookie-parser": "^1.4.7",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "helmet": "^8.3.0",
    "ioredis": "^5.11.1",
    "jose": "^6.2.12",
    "octokit": "^5.0.5",
    "pino": "^10.3.1",
    "pino-http": "^11.0.0",
    "postgres": "^3.4.9",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/cookie-parser": "^1.4.10",
    "@types/express": "^5.0.6",
    "@types/node": "^24.13.3",
    "@types/supertest": "^7.2.1",
    "drizzle-kit": "^0.31.10",
    "eslint": "^10.10.0",
    "prettier": "^3.9.6",
    "railway": "^3.11.0",
    "supertest": "^7.2.2",
    "tsx": "^4.23.13",
    "typescript": "~5.9.3",
    "typescript-eslint": "^8.70.0",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "outDir": "dist",
    "noEmit": true
  },
  "include": [
    "src",
    "tests",
    "scripts",
    ".railway",
    "vitest.config.ts",
    "drizzle.config.ts"
  ]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`eslint.config.js`:

```js
// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "node_modules/**", "drizzle/**", "coverage/**"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
```

`.prettierrc`:

```json
{
  "printWidth": 100,
  "singleQuote": false,
  "trailingComma": "all"
}
```

`.prettierignore`:

```
dist
node_modules
drizzle
coverage
package-lock.json
openapi.json
docs/API.md
```

`vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/live/**"],
          fileParallelism: false,
          pool: "forks",
          globalSetup: ["tests/setup/global.ts"],
          setupFiles: ["tests/setup/each.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
```

`.env.example` (every variable from spec 2.4, with the defaults; secrets are blank):

```
# Required
DATABASE_URL=postgres://localhost:5432/kaizen_dev
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=change-me-to-any-string-of-at-least-32-characters

# AI (set AI_MODEL_PROVIDER=fake to run without a key)
ANTHROPIC_API_KEY=
AI_MODEL_PROVIDER=anthropic
AI_MODEL=claude-sonnet-5
AI_RATE_LIMIT_PER_HOUR=20
AI_GLOBAL_LIMIT_PER_HOUR=300
AI_ENABLED=true
AI_STALE_MINUTES=10

# Optional
ADMIN_TOKEN=
APP_ENV=development
PORT=3000
WORKER_ENABLED=true
SEED_DEMO_USER=false
SEED_DEMO_PASSWORD=kaizen-demo-2026
LOG_LEVEL=info
GITHUB_TOKEN=
GITHUB_REPO=
RAILWAY_GIT_COMMIT_SHA=local
```

`.env.test` (committed; contains no secrets; values already set in the environment win, which is how CI points at its service containers):

```
DATABASE_URL=postgres://localhost:5432/kaizen_test
REDIS_URL=redis://localhost:6379/1
JWT_SECRET=test-only-jwt-secret-with-at-least-32-characters
AI_MODEL_PROVIDER=fake
APP_ENV=test
WORKER_ENABLED=false
SEED_DEMO_USER=false
LOG_LEVEL=silent
RAILWAY_GIT_COMMIT_SHA=test-sha
```

Append to `.gitignore` (the existing lines stay):

```
!.env.test
.claude/DOCS-CHECK-FAILED
```

The integration project's setup files must exist for `vitest` to load the project. Write the env-only versions now; Task 8 extends them.

`tests/setup/env.ts`:

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Loads .env.test without overriding variables already set (CI sets its own URLs). */
export function loadTestEnv(): void {
  const file = resolve(process.cwd(), ".env.test");
  if (existsSync(file)) process.loadEnvFile(file);
}
```

`tests/setup/global.ts`:

```ts
import { loadTestEnv } from "./env.js";

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
}
```

`tests/setup/each.ts`:

```ts
import { loadTestEnv } from "./env.js";

loadTestEnv();
```

- [ ] **Step 2: Install dependencies**

Run: `nvm use && npm install`
Expected: `package-lock.json` is created, no `ERESOLVE` errors, and `node --version` prints `v24.x.x`.

- [ ] **Step 3: Write the failing config test**

`src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, isSecureCookieEnv, loadConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://localhost:5432/kaizen_test",
  REDIS_URL: "redis://localhost:6379/1",
  JWT_SECRET: "x".repeat(32),
  AI_MODEL_PROVIDER: "fake",
};

describe("loadConfig", () => {
  it("lists every missing required variable in one error", () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems.some((p) => p.startsWith("DATABASE_URL:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("REDIS_URL:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("JWT_SECRET:"))).toBe(true);
    expect((caught as ConfigError).message).toContain("DATABASE_URL");
  });

  it("requires ANTHROPIC_API_KEY unless the provider is fake", () => {
    expect(() => loadConfig({ ...valid, AI_MODEL_PROVIDER: "anthropic" })).toThrow(ConfigError);
    expect(
      loadConfig({ ...valid, AI_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" })
        .ANTHROPIC_API_KEY,
    ).toBe("sk-test");
    expect(loadConfig(valid).AI_MODEL_PROVIDER).toBe("fake");
  });

  it("applies defaults and coerces numbers and booleans", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.AI_RATE_LIMIT_PER_HOUR).toBe(20);
    expect(config.AI_GLOBAL_LIMIT_PER_HOUR).toBe(300);
    expect(config.AI_ENABLED).toBe(true);
    expect(config.AI_STALE_MINUTES).toBe(10);
    expect(config.AI_MODEL).toBe("claude-sonnet-5");
    expect(config.APP_ENV).toBe("development");
    expect(config.WORKER_ENABLED).toBe(true);
    expect(config.SEED_DEMO_USER).toBe(false);
    expect(config.SEED_DEMO_PASSWORD).toBe("kaizen-demo-2026");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.RAILWAY_GIT_COMMIT_SHA).toBe("local");
    const overridden = loadConfig({ ...valid, PORT: "4010", AI_ENABLED: "false", WORKER_ENABLED: "0" });
    expect(overridden.PORT).toBe(4010);
    expect(overridden.AI_ENABLED).toBe(false);
    expect(overridden.WORKER_ENABLED).toBe(false);
  });

  it("treats empty strings as unset and rejects short secrets", () => {
    expect(loadConfig({ ...valid, ADMIN_TOKEN: "" }).ADMIN_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...valid, ADMIN_TOKEN: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, JWT_SECRET: "short" })).toThrow(ConfigError);
  });

  it("marks cookies secure outside development and test", () => {
    expect(isSecureCookieEnv(loadConfig(valid))).toBe(false);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "test" }))).toBe(false);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "staging" }))).toBe(true);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "production" }))).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run --project unit src/config.test.ts`
Expected: FAIL with `Failed to resolve import "./config.js"` (the module does not exist yet).

- [ ] **Step 5: Write `src/config.ts`**

```ts
import { z } from "zod";

const bool = z.stringbool();
const int = z.coerce.number().int();

export const configSchema = z
  .object({
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    JWT_SECRET: z.string().min(32),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_MODEL_PROVIDER: z.enum(["anthropic", "fake"]).default("anthropic"),
    AI_MODEL: z.string().min(1).default("claude-sonnet-5"),
    AI_RATE_LIMIT_PER_HOUR: int.positive().default(20),
    AI_GLOBAL_LIMIT_PER_HOUR: int.positive().default(300),
    AI_ENABLED: bool.default(true),
    AI_STALE_MINUTES: int.positive().default(10),
    ADMIN_TOKEN: z.string().min(32).optional(),
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    PORT: int.min(1).max(65535).default(3000),
    WORKER_ENABLED: bool.default(true),
    SEED_DEMO_USER: bool.default(false),
    SEED_DEMO_PASSWORD: z.string().min(8).default("kaizen-demo-2026"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "must look like owner/name")
      .optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().min(1).default("local"),
  })
  .refine((c) => c.AI_MODEL_PROVIDER === "fake" || Boolean(c.ANTHROPIC_API_KEY), {
    path: ["ANTHROPIC_API_KEY"],
    message: "Required unless AI_MODEL_PROVIDER=fake",
  });

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Parse and validate the environment once. Empty strings count as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }
  return result.data;
}

export function isSecureCookieEnv(config: Config): boolean {
  return config.APP_ENV !== "development" && config.APP_ENV !== "test";
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit src/config.test.ts`
Expected:

```
 ✓ src/config.test.ts (5 tests)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 7: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0 with no output from tsc and `All matched files use Prettier code style!` from prettier. If prettier complains about a file you wrote, run `npx prettier --write <file>` and re-run.

- [ ] **Step 8: Commit**

```bash
git add .nvmrc package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js .prettierrc .prettierignore vitest.config.ts .env.example .env.test .gitignore tests/setup src/config.ts src/config.test.ts
git commit -F - <<'MSG'
chore: scaffold toolchain and config module

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: Errors, envelope, logger, request id

**Files:**
- Create: `src/lib/errors.ts`, `src/lib/envelope.ts`, `src/lib/error-handler.ts`, `src/lib/logger.ts`, `src/lib/request-id.ts`, `src/types/express.d.ts`
- Test: `src/lib/errors.test.ts`, `src/lib/envelope.test.ts`, `src/lib/error-handler.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ERROR_CODES` (readonly tuple), `type ErrorCode`, `statusFor(code): number`, `class AppError extends Error { code: ErrorCode; details?: unknown; status: number }`, constructors `validationError(details, message?)`, `unauthorized(message?)`, `notFound(message?)`, `conflict(message)`, `rateLimited(details)`, `upstreamError(message)`, `unavailable(message)`, `internal(message?)`; `interface ValidationDetail { path: string; message: string }`; `interface RateLimitDetails { scope: "user" | "global"; limit: number; resetAt: string }`.
  - `successEnvelope(data, requestId, nextCursor?)`, `errorEnvelope(code, message, requestId, details?)`, `sendData(res, data, { status?, nextCursor? })`, `sendNoContent(res)`.
  - `notFoundHandler` (RequestHandler), `errorHandler({ exposeInternal, logger }): ErrorRequestHandler`.
  - `createLogger(level): Logger`, `createHttpLogger(logger): RequestHandler`, `type Logger`.
  - `requestId(): RequestHandler`, `requestIdOf(res): string`. Express `res.locals.requestId: string` is declared globally.

- [ ] **Step 1: Write the failing tests**

`src/lib/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, notFound, rateLimited, statusFor, validationError } from "./errors.js";

describe("statusFor", () => {
  it("maps every code to the spec status", () => {
    expect(statusFor("VALIDATION_ERROR")).toBe(400);
    expect(statusFor("UNAUTHORIZED")).toBe(401);
    expect(statusFor("FORBIDDEN")).toBe(403);
    expect(statusFor("NOT_FOUND")).toBe(404);
    expect(statusFor("CONFLICT")).toBe(409);
    expect(statusFor("RATE_LIMITED")).toBe(429);
    expect(statusFor("UPSTREAM_ERROR")).toBe(502);
    expect(statusFor("UNAVAILABLE")).toBe(503);
    expect(statusFor("INTERNAL")).toBe(500);
  });

  it("covers exactly the closed set of codes", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "CONFLICT",
        "FORBIDDEN",
        "INTERNAL",
        "NOT_FOUND",
        "RATE_LIMITED",
        "UNAUTHORIZED",
        "UNAVAILABLE",
        "UPSTREAM_ERROR",
        "VALIDATION_ERROR",
      ].sort(),
    );
  });
});

describe("AppError", () => {
  it("carries code, message, details and derived status", () => {
    const err = new AppError("CONFLICT", "Duplicate");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Duplicate");
    expect(err.status).toBe(409);
    expect(err.details).toBeUndefined();
  });

  it("constructors set the documented shapes", () => {
    expect(notFound().code).toBe("NOT_FOUND");
    const v = validationError([{ path: "body.title", message: "Required" }]);
    expect(v.code).toBe("VALIDATION_ERROR");
    expect(v.details).toEqual([{ path: "body.title", message: "Required" }]);
    const r = rateLimited({ scope: "user", limit: 20, resetAt: "2026-09-08T10:00:00.000Z" });
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.details).toEqual({ scope: "user", limit: 20, resetAt: "2026-09-08T10:00:00.000Z" });
  });
});
```

`src/lib/envelope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { errorEnvelope, successEnvelope } from "./envelope.js";

describe("envelopes", () => {
  it("wraps data with meta.requestId and no nextCursor for single items", () => {
    expect(successEnvelope({ id: "1" }, "req-1")).toEqual({
      data: { id: "1" },
      meta: { requestId: "req-1" },
    });
  });

  it("adds nextCursor to list envelopes, null on the last page", () => {
    expect(successEnvelope([1], "req-1", "abc")).toEqual({
      data: [1],
      meta: { requestId: "req-1", nextCursor: "abc" },
    });
    expect(successEnvelope([1], "req-1", null)).toEqual({
      data: [1],
      meta: { requestId: "req-1", nextCursor: null },
    });
  });

  it("builds the error envelope with optional details", () => {
    expect(errorEnvelope("NOT_FOUND", "Task not found", "req-2")).toEqual({
      error: { code: "NOT_FOUND", message: "Task not found", requestId: "req-2" },
    });
    expect(
      errorEnvelope("VALIDATION_ERROR", "Bad", "req-3", [{ path: "body.x", message: "m" }]),
    ).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Bad",
        details: [{ path: "body.x", message: "m" }],
        requestId: "req-3",
      },
    });
  });
});
```

`src/lib/error-handler.test.ts` (drives the middleware through a tiny Express app so the output per code is asserted end to end):

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler, notFoundHandler } from "./error-handler.js";
import { AppError, ERROR_CODES, statusFor } from "./errors.js";
import { createLogger } from "./logger.js";
import { requestId } from "./request-id.js";

function appWith(exposeInternal: boolean) {
  const app = express();
  app.use(requestId());
  for (const code of ERROR_CODES) {
    app.get(`/throw/${code}`, () => {
      throw new AppError(code, `message for ${code}`, code === "VALIDATION_ERROR" ? [] : undefined);
    });
  }
  app.get("/zod", () => {
    z.object({ title: z.string() }).parse({});
  });
  app.get("/boom", () => {
    throw new Error("secret stack details");
  });
  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal, logger: createLogger("silent") }));
  return app;
}

describe("errorHandler", () => {
  it("maps every AppError code to its status and envelope", async () => {
    const app = appWith(false);
    for (const code of ERROR_CODES) {
      const res = await request(app).get(`/throw/${code}`).set("x-request-id", `rid-${code}`);
      expect(res.status).toBe(statusFor(code));
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.message).toBe(`message for ${code}`);
      expect(res.body.error.requestId).toBe(`rid-${code}`);
      expect(res.headers["x-request-id"]).toBe(`rid-${code}`);
      if (code === "VALIDATION_ERROR") {
        expect(res.body.error.details).toEqual([]);
      } else {
        expect(res.body.error).not.toHaveProperty("details");
      }
    }
  });

  it("maps zod errors to VALIDATION_ERROR with per-field details", async () => {
    const res = await request(appWith(false)).get("/zod");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toEqual([{ path: "title", message: expect.any(String) }]);
  });

  it("hides internal messages unless exposeInternal", async () => {
    const hidden = await request(appWith(false)).get("/boom");
    expect(hidden.status).toBe(500);
    expect(hidden.body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
      requestId: expect.any(String),
    });
    const shown = await request(appWith(true)).get("/boom");
    expect(shown.body.error.message).toBe("secret stack details");
  });

  it("returns NOT_FOUND for unknown routes with a generated request id", async () => {
    const res = await request(appWith(false)).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib`
Expected: FAIL, three files fail to resolve `./errors.js`, `./envelope.js`, `./error-handler.js`.

- [ ] **Step 3: Write the type augmentation**

`src/types/express.d.ts` (Task 9 adds `user` here):

```ts
declare module "express-serve-static-core" {
  interface Locals {
    requestId: string;
    validated?: unknown;
  }
}

export {};
```

- [ ] **Step 4: Write `src/lib/errors.ts`**

```ts
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** The one place an error code becomes an HTTP status. */
export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface ValidationDetail {
  path: string;
  message: string;
}

export interface RateLimitDetails {
  scope: "user" | "global";
  limit: number;
  resetAt: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return statusFor(this.code);
  }
}

export const validationError = (
  details: ValidationDetail[],
  message = "Request validation failed",
): AppError => new AppError("VALIDATION_ERROR", message, details);

export const unauthorized = (message = "Unauthorized"): AppError =>
  new AppError("UNAUTHORIZED", message);

export const notFound = (message = "Not found"): AppError => new AppError("NOT_FOUND", message);

export const conflict = (message: string): AppError => new AppError("CONFLICT", message);

export const rateLimited = (details: RateLimitDetails): AppError =>
  new AppError("RATE_LIMITED", "Rate limit exceeded", details);

export const upstreamError = (message: string): AppError =>
  new AppError("UPSTREAM_ERROR", message);

export const unavailable = (message: string): AppError => new AppError("UNAVAILABLE", message);

export const internal = (message = "Internal server error"): AppError =>
  new AppError("INTERNAL", message);
```

- [ ] **Step 5: Write `src/lib/envelope.ts`**

```ts
import type { Response } from "express";
import type { ErrorCode } from "./errors.js";
import { requestIdOf } from "./request-id.js";

export interface SuccessMeta {
  requestId: string;
  nextCursor?: string | null;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: SuccessMeta;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function successEnvelope<T>(
  data: T,
  requestId: string,
  nextCursor?: string | null,
): SuccessEnvelope<T> {
  const meta: SuccessMeta = { requestId };
  if (nextCursor !== undefined) meta.nextCursor = nextCursor;
  return { data, meta };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  const error: ErrorEnvelope["error"] = { code, message, requestId };
  if (details !== undefined) {
    return { error: { code, message, details, requestId } };
  }
  return { error };
}

export function sendData<T>(
  res: Response,
  data: T,
  options: { status?: number; nextCursor?: string | null } = {},
): void {
  res.status(options.status ?? 200).json(successEnvelope(data, requestIdOf(res), options.nextCursor));
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
```

- [ ] **Step 6: Write `src/lib/request-id.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";

const HEADER = "x-request-id";
const MAX_LENGTH = 128;

/** Reads x-request-id from the inbound request or generates one, and exposes it everywhere. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header(HEADER);
    const id = inbound && inbound.length <= MAX_LENGTH ? inbound : randomUUID();
    req.headers[HEADER] = id;
    res.locals.requestId = id;
    res.setHeader(HEADER, id);
    next();
  };
}

export function requestIdOf(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}
```

- [ ] **Step 7: Write `src/lib/logger.ts`**

```ts
import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { pino, type Logger } from "pino";
import { pinoHttp } from "pino-http";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({ level });
}

interface RequestWithUser extends IncomingMessage {
  user?: { id: string };
}

/** One line per request: method, url, status, responseTime, requestId, userId. */
export function createHttpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req) => String(req.headers["x-request-id"] ?? "unknown"),
    customProps: (req) => ({ userId: (req as RequestWithUser).user?.id }),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  }) as unknown as RequestHandler;
}
```

- [ ] **Step 8: Write `src/lib/error-handler.ts`**

```ts
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { errorEnvelope } from "./envelope.js";
import { AppError, notFound, statusFor, type ValidationDetail } from "./errors.js";
import type { Logger } from "./logger.js";
import { requestIdOf } from "./request-id.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`Route ${req.method} ${req.path} not found`));
};

export function zodDetails(error: ZodError, prefix = ""): ValidationDetail[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return { path: prefix && path ? `${prefix}.${path}` : prefix || path, message: issue.message };
  });
}

export function errorHandler(options: { exposeInternal: boolean; logger: Logger }): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = requestIdOf(res);
    if (err instanceof AppError) {
      res.status(statusFor(err.code)).json(errorEnvelope(err.code, err.message, requestId, err.details));
      return;
    }
    if (err instanceof ZodError) {
      res
        .status(statusFor("VALIDATION_ERROR"))
        .json(errorEnvelope("VALIDATION_ERROR", "Request validation failed", requestId, zodDetails(err)));
      return;
    }
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 500) {
      // body-parser and similar throw HTTP errors with a status; treat them as validation problems
      const message = (err as { message?: string }).message ?? "Bad request";
      res.status(400).json(errorEnvelope("VALIDATION_ERROR", message, requestId, []));
      return;
    }
    options.logger.error({ err, requestId }, "unhandled error");
    const message =
      options.exposeInternal && err instanceof Error ? err.message : "Internal server error";
    res.status(statusFor("INTERNAL")).json(errorEnvelope("INTERNAL", message, requestId));
  };
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib`
Expected:

```
 ✓ src/lib/errors.test.ts (4 tests)
 ✓ src/lib/envelope.test.ts (3 tests)
 ✓ src/lib/error-handler.test.ts (4 tests)
 Test Files  3 passed (3)
      Tests  11 passed (11)
```

- [ ] **Step 10: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/lib src/types
git commit -F - <<'MSG'
feat: error codes, envelopes, logger and request id middleware

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Cursor, validate middleware, app factory, health and OpenAPI routes

**Files:**
- Create: `src/lib/cursor.ts`, `src/routes/validate.ts`, `src/routes/health.ts`, `src/routes/openapi.ts`, `src/app.ts`
- Test: `src/lib/cursor.test.ts`, `src/routes/validate.test.ts`, `src/app.test.ts`

**Interfaces:**
- Consumes: Task 1 `Config`; Task 2 `sendData`, `validationError`, `unavailable`, `requestId`, `createHttpLogger`, `notFoundHandler`, `errorHandler`, `Logger`.
- Produces:
  - `encodeCursor({ createdAt: Date, id: string }): string`, `decodeCursor(raw: string): { createdAt: Date; id: string }`.
  - `validate(schemas: ValidateSchemas): RequestHandler`, `validated<S extends ValidateSchemas>(res): Validated<S>`, `interface ValidateSchemas { params?: ZodType; query?: ZodType; body?: ZodType }`.
  - `interface HealthProbes { db(): Promise<void>; redis(): Promise<void> }`, `interface HealthFeatures { featureRequests: boolean }`, `healthRouter(config, probes, features): Router`, `openapiRouter(openapiPath: string): Router`. `features.featureRequests` is the master plan's health interface: true exactly when the feature-requests route is mounted, which `createApp` decides from `GITHUB_TOKEN` and `GITHUB_REPO` (Task 19 mounts the route on the same value).
  - `interface AppDeps { config: Config; logger: Logger; probes: HealthProbes }` and `createApp(deps): Express` (Task 9 widens `AppDeps` to the spec's `{ config, db, redis, queue, model, logger }`; `probes` becomes an optional override).
  - `GET /api/v1/health` and `GET /api/v1/openapi.json` are live.

- [ ] **Step 1: Write the failing tests**

`src/lib/cursor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { AppError } from "./errors.js";

describe("cursor", () => {
  it("round-trips createdAt and id", () => {
    const createdAt = new Date("2026-09-08T10:15:30.123Z");
    const id = "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7";
    const encoded = encodeCursor({ createdAt, id });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ createdAt, id });
  });

  it("encodes the documented JSON shape", () => {
    const encoded = encodeCursor({
      createdAt: new Date("2026-09-08T10:15:30.123Z"),
      id: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7",
    });
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      c: "2026-09-08T10:15:30.123Z",
      i: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7",
    });
  });

  it("rejects garbage with VALIDATION_ERROR on query.cursor", () => {
    for (const garbage of ["", "not-base64!", Buffer.from("{}").toString("base64url"), Buffer.from('{"c":"nope","i":"x"}').toString("base64url")]) {
      let caught: unknown;
      try {
        decodeCursor(garbage);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe("VALIDATION_ERROR");
      expect((caught as AppError).details).toEqual([{ path: "query.cursor", message: "Invalid cursor" }]);
    }
  });
});
```

`src/routes/validate.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "../lib/error-handler.js";
import { createLogger } from "../lib/logger.js";
import { requestId } from "../lib/request-id.js";
import { validate, validated } from "./validate.js";

const schemas = {
  params: z.object({ id: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
  body: z.object({ title: z.string().min(1).max(200) }),
};

function app() {
  const app = express();
  app.use(express.json());
  app.use(requestId());
  app.post("/items/:id", validate(schemas), (req, res) => {
    const { params, query, body } = validated<typeof schemas>(res);
    res.json({ params, query, body, rawQuery: req.query });
  });
  app.use(errorHandler({ exposeInternal: true, logger: createLogger("silent") }));
  return app;
}

describe("validate", () => {
  it("stores parsed values in res.locals.validated without touching req.query", async () => {
    const res = await request(app())
      .post("/items/6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7?limit=10")
      .send({ title: "Write the plan" });
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7" });
    expect(res.body.query).toEqual({ limit: 10 });
    expect(res.body.rawQuery).toEqual({ limit: "10" });
    expect(res.body.body).toEqual({ title: "Write the plan" });
  });

  it("applies defaults", async () => {
    const res = await request(app())
      .post("/items/6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7")
      .send({ title: "x" });
    expect(res.body.query).toEqual({ limit: 50 });
  });

  it("reports every failing part with prefixed paths", async () => {
    const res = await request(app()).post("/items/not-a-uuid?limit=0").send({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(["body.title", "params.id", "query.limit"]);
  });
});
```

`src/app.test.ts` (uses stub probes; Task 9 replaces this file with integration tests against the real database and Redis):

```ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

const env = {
  DATABASE_URL: "postgres://localhost:5432/kaizen_test",
  REDIS_URL: "redis://localhost:6379/1",
  JWT_SECRET: "x".repeat(32),
  AI_MODEL_PROVIDER: "fake",
  APP_ENV: "test",
  RAILWAY_GIT_COMMIT_SHA: "abc123",
};
const config = loadConfig(env);

const okProbes = { db: async () => {}, redis: async () => {} };

describe("createApp", () => {
  it("serves health with the commit SHA, env, checks and feature flags", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        status: "ok",
        commit: "abc123",
        env: "test",
        checks: { db: "ok", redis: "ok" },
        features: { featureRequests: false },
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("reports features.featureRequests true when GITHUB_TOKEN and GITHUB_REPO are set", async () => {
    const configured = loadConfig({
      ...env,
      GITHUB_TOKEN: "ghp_test_token",
      GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line",
    });
    const app = createApp({ config: configured, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual({ featureRequests: true });
  });

  it("returns 503 UNAVAILABLE naming the failing check", async () => {
    const app = createApp({
      config,
      logger: createLogger("silent"),
      probes: { ...okProbes, redis: async () => { throw new Error("down"); } },
    });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("UNAVAILABLE");
    expect(res.body.error.message).toBe("Health check failed: redis");
  });

  it("serves the committed openapi.json", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
  });

  it("echoes x-request-id in the error envelope of unknown routes", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/nothing").set("x-request-id", "trace-me");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Route GET /api/v1/nothing not found",
      requestId: "trace-me",
    });
  });
});
```

The `openapi.json` test will keep failing until Task 5 commits the generated file; that is expected and noted in Step 7.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/cursor.test.ts src/routes src/app.test.ts`
Expected: FAIL, unresolved imports `./cursor.js`, `./validate.js`, `./app.js`.

- [ ] **Step 3: Write `src/lib/cursor.ts`**

```ts
import { validationError } from "./errors.js";

export interface Cursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function invalid(): never {
  throw validationError([{ path: "query.cursor", message: "Invalid cursor" }]);
}

export function decodeCursor(raw: string): Cursor {
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  if (typeof parsed !== "object" || parsed === null) invalid();
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string" || !UUID.test(i)) invalid();
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) invalid();
  return { createdAt, id: i };
}
```

- [ ] **Step 4: Write `src/routes/validate.ts`**

```ts
import type { RequestHandler, Response } from "express";
import type { ZodType, z } from "zod";
import { zodDetails } from "../lib/error-handler.js";
import { validationError, type ValidationDetail } from "../lib/errors.js";

export interface ValidateSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

type Infer<T> = T extends ZodType ? z.output<T> : undefined;

export type Validated<S extends ValidateSchemas> = {
  params: Infer<S["params"]>;
  query: Infer<S["query"]>;
  body: Infer<S["body"]>;
};

/**
 * Parses params, query and body with the given zod schemas and stores the parsed
 * values in res.locals.validated. Never assigns to req.query (read-only in Express 5).
 */
export function validate(schemas: ValidateSchemas): RequestHandler {
  return (req, res, next) => {
    const details: ValidationDetail[] = [];
    const out: Record<string, unknown> = {};
    const parts = [
      ["params", schemas.params, req.params],
      ["query", schemas.query, req.query],
      ["body", schemas.body, req.body],
    ] as const;
    for (const [name, schema, value] of parts) {
      if (!schema) continue;
      const result = schema.safeParse(value ?? {});
      if (result.success) {
        out[name] = result.data;
      } else {
        details.push(...zodDetails(result.error, name));
      }
    }
    if (details.length > 0) {
      next(validationError(details));
      return;
    }
    res.locals.validated = out;
    next();
  };
}

export function validated<S extends ValidateSchemas>(res: Response): Validated<S> {
  return res.locals.validated as Validated<S>;
}
```

- [ ] **Step 5: Write `src/routes/health.ts` and `src/routes/openapi.ts`**

`src/routes/health.ts`:

```ts
import { Router } from "express";
import type { Config } from "../config.js";
import { sendData } from "../lib/envelope.js";
import { unavailable } from "../lib/errors.js";

export interface HealthProbes {
  db(): Promise<void>;
  redis(): Promise<void>;
}

/** Optional routes the web app can switch on. Reported so the client needs no probing. */
export interface HealthFeatures {
  featureRequests: boolean;
}

async function probe(fn: () => Promise<void>): Promise<"ok" | "failed"> {
  try {
    await fn();
    return "ok";
  } catch {
    return "failed";
  }
}

export function healthRouter(config: Config, probes: HealthProbes, features: HealthFeatures): Router {
  const router = Router();
  router.get("/health", async (_req, res) => {
    const checks = { db: await probe(probes.db), redis: await probe(probes.redis) };
    const failing = Object.entries(checks)
      .filter(([, state]) => state !== "ok")
      .map(([name]) => name);
    if (failing.length > 0) {
      throw unavailable(`Health check failed: ${failing.join(", ")}`);
    }
    sendData(res, {
      status: "ok",
      commit: config.RAILWAY_GIT_COMMIT_SHA,
      env: config.APP_ENV,
      checks,
      features,
    });
  });
  return router;
}
```

`src/routes/openapi.ts`:

```ts
import { readFileSync } from "node:fs";
import { Router } from "express";

/** Serves the committed openapi.json verbatim. Read once, on first request. */
export function openapiRouter(openapiPath: string): Router {
  const router = Router();
  let cached: string | undefined;
  router.get("/openapi.json", (_req, res) => {
    cached ??= readFileSync(openapiPath, "utf8");
    res.type("application/json").send(cached);
  });
  return router;
}
```

- [ ] **Step 6: Write `src/app.ts`**

```ts
import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { createHttpLogger, type Logger } from "./lib/logger.js";
import { requestId } from "./lib/request-id.js";
import { healthRouter, type HealthFeatures, type HealthProbes } from "./routes/health.js";
import { openapiRouter } from "./routes/openapi.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  probes: HealthProbes;
}

export const JSON_BODY_LIMIT = "64kb";

/**
 * Defined exactly when GITHUB_TOKEN and GITHUB_REPO are both set. The feature-requests route is
 * mounted on this same value, so health's `features.featureRequests` and the mount never disagree.
 */
export function featureRequestsConfigOf(config: Config): { token: string; repo: string } | undefined {
  return config.GITHUB_TOKEN && config.GITHUB_REPO
    ? { token: config.GITHUB_TOKEN, repo: config.GITHUB_REPO }
    : undefined;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger, probes } = deps;
  const featureRequestsConfig = featureRequestsConfigOf(config);
  const features: HealthFeatures = { featureRequests: featureRequestsConfig !== undefined };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(requestId());
  app.use(createHttpLogger(logger));

  const api = Router();
  api.use(healthRouter(config, probes, features));
  api.use(openapiRouter(resolve(process.cwd(), "openapi.json")));
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal: config.APP_ENV === "development", logger }));
  return app;
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project unit`
Expected: every test passes except `createApp > serves the committed openapi.json`, which fails with `ENOENT ... openapi.json` until Task 5 commits the file:

```
 ✓ src/config.test.ts (5 tests)
 ✓ src/lib/errors.test.ts (4 tests)
 ✓ src/lib/envelope.test.ts (3 tests)
 ✓ src/lib/error-handler.test.ts (4 tests)
 ✓ src/lib/cursor.test.ts (3 tests)
 ✓ src/routes/validate.test.ts (3 tests)
 ❯ src/app.test.ts (5 tests | 1 failed)
```

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/lib/cursor.ts src/lib/cursor.test.ts src/routes src/app.ts src/app.test.ts
git commit -F - <<'MSG'
feat: cursor, validate middleware, app factory with health and openapi routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 4: All zod schemas and the OpenAPI registry

**Files:**
- Create: `src/schemas/registry.ts`, `src/schemas/common.ts`, `src/schemas/auth.ts`, `src/schemas/tags.ts`, `src/schemas/tasks.ts`, `src/schemas/feature-requests.ts`, `src/schemas/admin.ts`, `src/schemas/health.ts`, `src/schemas/breakdown.ts`, `src/schemas/index.ts`
- Test: `src/schemas/index.test.ts`

**Interfaces:**
- Consumes: Task 2 `ERROR_CODES`, `statusFor`, `ErrorCode`.
- Produces (exact export names later tasks import):
  - `registry` (OpenAPIRegistry), `bearerAuth`, `API_PREFIX = "/api/v1"`.
  - common: `UuidSchema`, `IdParams`, `MetaSchema`, `ListMetaSchema`, `ErrorEnvelopeSchema`, `envelope(schema)`, `listEnvelope(item)`, `jsonResponse(description, schema)`, `errorResponses(...codes)`.
  - auth: `UserSchema`, `RegisterBody`, `LoginBody`, `AuthResponse`, `RefreshResponse`, `MeResponse`; types `User`, `RegisterInput`, `LoginInput`.
  - tags: `TagSchema`, `CreateTagBody`, `UpdateTagBody`; types `Tag`, `CreateTagInput`, `UpdateTagInput`.
  - tasks: `TaskStatusSchema`, `AiStatusSchema`, `AiSkipReasonSchema`, `TaskOriginSchema`, `SuggestionStateSchema`, `ProgressSchema`, `TaskSummarySchema`, `TaskDetailSchema`, `ListTasksQuery`, `CreateTaskBody`, `UpdateTaskBody`, `ReplaceTagsBody`; types `TaskStatus`, `AiStatus`, `AiSkipReason`, `TaskOrigin`, `SuggestionState`, `Progress`, `TaskSummary`, `TaskDetail`, `ListTasksInput`, `CreateTaskInput`, `UpdateTaskInput`, `ReplaceTagsInput`.
  - feature-requests: `FeatureRequestBody`, `FeatureRequestResponse`; type `FeatureRequestInput`.
  - admin: `AdminTokenHeaders`, `SeedResetResponse`. health: `HealthSchema`.
  - breakdown: `BreakdownSchema`, type `BreakdownResult` (not registered in OpenAPI; used by the agent).
  - index: `generateOpenApiDocument(): OpenApiDocument`, type `OpenApiDocument`.

- [ ] **Step 1: Write the failing test**

`src/schemas/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./index.js";

const EXPECTED_ENDPOINTS: Array<[string, string]> = [
  ["post", "/api/v1/auth/register"],
  ["post", "/api/v1/auth/login"],
  ["post", "/api/v1/auth/refresh"],
  ["post", "/api/v1/auth/logout"],
  ["get", "/api/v1/auth/me"],
  ["get", "/api/v1/tasks"],
  ["post", "/api/v1/tasks"],
  ["get", "/api/v1/tasks/{id}"],
  ["patch", "/api/v1/tasks/{id}"],
  ["delete", "/api/v1/tasks/{id}"],
  ["post", "/api/v1/tasks/{id}/breakdown"],
  ["post", "/api/v1/tasks/{id}/suggestions/accept-all"],
  ["post", "/api/v1/tasks/{id}/suggestions/dismiss-all"],
  ["put", "/api/v1/tasks/{id}/tags"],
  ["get", "/api/v1/tags"],
  ["post", "/api/v1/tags"],
  ["patch", "/api/v1/tags/{id}"],
  ["delete", "/api/v1/tags/{id}"],
  ["post", "/api/v1/feature-requests"],
  ["post", "/api/v1/admin/seed-reset"],
  ["get", "/api/v1/health"],
  ["get", "/api/v1/openapi.json"],
];

describe("generateOpenApiDocument", () => {
  const doc = generateOpenApiDocument();
  const paths = doc.paths ?? {};

  it("describes every endpoint in spec section 4.4 and nothing else", () => {
    const actual = Object.entries(paths)
      .flatMap(([path, item]) => Object.keys(item ?? {}).map((method) => `${method} ${path}`))
      .sort();
    expect(actual).toEqual(EXPECTED_ENDPOINTS.map(([m, p]) => `${m} ${p}`).sort());
  });

  it("gives every operation a summary and at least one response with a schema", () => {
    for (const [method, path] of EXPECTED_ENDPOINTS) {
      const op = (paths[path] as Record<string, { summary?: string; responses?: Record<string, unknown> }>)[method];
      expect(op?.summary, `${method} ${path}`).toBeTruthy();
      expect(Object.keys(op?.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it("registers the shared components and bearer security", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of ["User", "Tag", "TaskSummary", "TaskDetail", "ErrorEnvelope", "ValidationDetail", "RateLimitDetails", "Health"]) {
      expect(schemas[name], name).toBeDefined();
    }
    expect(doc.components?.securitySchemes?.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    const tasksGet = (paths["/api/v1/tasks"] as { get: { security?: unknown } }).get;
    expect(tasksGet.security).toEqual([{ bearerAuth: [] }]);
    const registerPost = (paths["/api/v1/auth/register"] as { post: { security?: unknown } }).post;
    expect(registerPost.security).toBeUndefined();
  });

  it("documents request bodies and query parameters", () => {
    const create = (paths["/api/v1/tasks"] as { post: { requestBody?: unknown } }).post;
    expect(create.requestBody).toBeDefined();
    const list = (paths["/api/v1/tasks"] as { get: { parameters?: Array<{ name: string; in: string }> } }).get;
    expect(list.parameters?.map((p) => p.name).sort()).toEqual(["cursor", "limit", "parentId", "status", "tagId"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/schemas`
Expected: FAIL, `Failed to resolve import "./index.js"`.

- [ ] **Step 3: Write `src/schemas/registry.ts` and `src/schemas/common.ts`**

`src/schemas/registry.ts`:

```ts
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Must run before any schema file calls .openapi(). Every schema file imports this module,
// so ESM evaluation order guarantees it.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export const bearerAuth = [{ bearerAuth: [] }];

export const API_PREFIX = "/api/v1";
```

`src/schemas/common.ts`:

```ts
import type { RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import { ERROR_CODES, statusFor, type ErrorCode } from "../lib/errors.js";
import "./registry.js";

export const UuidSchema = z.uuid();

export const IdParams = z.object({
  id: UuidSchema.openapi({ param: { name: "id", in: "path" } }),
});

export const MetaSchema = z.object({ requestId: z.string() }).openapi("Meta");

export const ListMetaSchema = z
  .object({ requestId: z.string(), nextCursor: z.string().nullable() })
  .openapi("ListMeta");

export const ValidationDetailSchema = z
  .object({ path: z.string(), message: z.string() })
  .openapi("ValidationDetail");

export const RateLimitDetailsSchema = z
  .object({
    scope: z.enum(["user", "global"]),
    limit: z.number().int(),
    resetAt: z.iso.datetime(),
  })
  .openapi("RateLimitDetails");

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.union([z.array(ValidationDetailSchema), RateLimitDetailsSchema]).optional(),
      requestId: z.string(),
    }),
  })
  .openapi("ErrorEnvelope");

export function envelope<T extends ZodType>(data: T) {
  return z.object({ data, meta: MetaSchema });
}

export function listEnvelope<T extends ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: ListMetaSchema });
}

export function jsonResponse(description: string, schema: ZodType) {
  return { description, content: { "application/json": { schema } } };
}

export function errorResponses(...codes: ErrorCode[]): RouteConfig["responses"] {
  const responses: RouteConfig["responses"] = {};
  for (const code of codes) {
    responses[statusFor(code)] = {
      description: code,
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    };
  }
  return responses;
}
```

- [ ] **Step 4: Write `src/schemas/auth.ts`**

```ts
import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("User");

export const RegisterBody = z
  .object({
    email: z.email().max(254),
    password: z.string().min(8).max(200),
    displayName: z.string().trim().min(1).max(80),
  })
  .openapi("RegisterBody");

export const LoginBody = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(200),
  })
  .openapi("LoginBody");

export const AuthResponse = z
  .object({ user: UserSchema, accessToken: z.string() })
  .openapi("AuthResponse");

export const RefreshResponse = z.object({ accessToken: z.string() }).openapi("RefreshResponse");

export const MeResponse = z.object({ user: UserSchema }).openapi("MeResponse");

export type User = z.infer<typeof UserSchema>;
export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;

const COOKIE_NOTE = "Also sets the httpOnly `kaizen_refresh` cookie scoped to `/api/v1/auth`.";

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/register`,
  tags: ["auth"],
  summary: "Register a new user",
  description: `Open self-registration. ${COOKIE_NOTE}`,
  request: { body: { content: { "application/json": { schema: RegisterBody } } } },
  responses: {
    201: jsonResponse("Registered", envelope(AuthResponse)),
    ...errorResponses("VALIDATION_ERROR", "CONFLICT"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/login`,
  tags: ["auth"],
  summary: "Log in with email and password",
  description: `Returns a 15-minute access token. ${COOKIE_NOTE}`,
  request: { body: { content: { "application/json": { schema: LoginBody } } } },
  responses: {
    200: jsonResponse("Logged in", envelope(AuthResponse)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/refresh`,
  tags: ["auth"],
  summary: "Rotate the refresh cookie and issue a new access token",
  description: "Reads the `kaizen_refresh` cookie. The old refresh token is invalidated.",
  responses: {
    200: jsonResponse("New access token", envelope(RefreshResponse)),
    ...errorResponses("UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/logout`,
  tags: ["auth"],
  summary: "Revoke the refresh token and clear the cookie",
  responses: { 204: { description: "Logged out" } },
});

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/auth/me`,
  tags: ["auth"],
  summary: "Current user",
  security: bearerAuth,
  responses: {
    200: jsonResponse("The authenticated user", envelope(MeResponse)),
    ...errorResponses("UNAUTHORIZED"),
  },
});
```

- [ ] **Step 5: Write `src/schemas/tags.ts`**

```ts
import { z } from "zod";
import { envelope, errorResponses, IdParams, jsonResponse } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";

export const TagNameSchema = z.string().trim().min(1).max(40);
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #2563eb");

export const TagSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    color: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Tag");

export const CreateTagBody = z
  .object({ name: TagNameSchema, color: HexColorSchema })
  .openapi("CreateTagBody");

export const UpdateTagBody = z
  .object({ name: TagNameSchema.optional(), color: HexColorSchema.optional() })
  .refine((b) => b.name !== undefined || b.color !== undefined, {
    message: "At least one field is required",
  })
  .openapi("UpdateTagBody");

export type Tag = z.infer<typeof TagSchema>;
export type CreateTagInput = z.infer<typeof CreateTagBody>;
export type UpdateTagInput = z.infer<typeof UpdateTagBody>;

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/tags`,
  tags: ["tags"],
  summary: "List the user's tags",
  security: bearerAuth,
  responses: {
    200: jsonResponse("Tags ordered by name", envelope(z.array(TagSchema))),
    ...errorResponses("UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tags`,
  tags: ["tags"],
  summary: "Create a tag",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateTagBody } } } },
  responses: {
    201: jsonResponse("Created", envelope(TagSchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "CONFLICT"),
  },
});

registry.registerPath({
  method: "patch",
  path: `${API_PREFIX}/tags/{id}`,
  tags: ["tags"],
  summary: "Rename or recolor a tag",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateTagBody } } },
  },
  responses: {
    200: jsonResponse("Updated", envelope(TagSchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND", "CONFLICT"),
  },
});

registry.registerPath({
  method: "delete",
  path: `${API_PREFIX}/tags/{id}`,
  tags: ["tags"],
  summary: "Delete a tag and its links",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});
```

- [ ] **Step 6: Write `src/schemas/tasks.ts`**

```ts
import { z } from "zod";
import { envelope, errorResponses, IdParams, jsonResponse, listEnvelope } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";
import { TagSchema } from "./tags.js";

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]).openapi("TaskStatus");
export const AiStatusSchema = z
  .enum(["pending", "running", "done", "failed", "skipped"])
  .openapi("AiStatus");
export const AiSkipReasonSchema = z
  .enum(["too_short", "rate_limited", "ai_disabled"])
  .openapi("AiSkipReason");
export const TaskOriginSchema = z.enum(["user", "ai"]).openapi("TaskOrigin");
export const SuggestionStateSchema = z
  .enum(["suggested", "accepted", "dismissed"])
  .openapi("SuggestionState");

export const ProgressSchema = z
  .object({ done: z.number().int(), total: z.number().int() })
  .openapi("Progress");

export const TaskSummarySchema = z
  .object({
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: TaskStatusSchema,
    aiStatus: AiStatusSchema,
    aiSkipReason: AiSkipReasonSchema.nullable(),
    aiError: z.string().nullable(),
    position: z.number().int(),
    origin: TaskOriginSchema,
    suggestionState: SuggestionStateSchema.nullable(),
    rationale: z.string().nullable(),
    tags: z.array(TagSchema),
    progress: ProgressSchema,
    // Direct children with origin ai still in state suggested; 0 for children and for tasks
    // without suggestions. With aiError above, the list needs no per-row detail query.
    suggestionCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("TaskSummary");

export const TaskDetailSchema = TaskSummarySchema.extend({
  children: z.array(TaskSummarySchema),
  aiTagSuggestions: z.array(z.string()),
}).openapi("TaskDetail");

export const TitleSchema = z.string().trim().min(1).max(200);
export const DescriptionSchema = z.string().max(4000);

export const ListTasksQuery = z.object({
  status: TaskStatusSchema.optional(),
  tagId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const CreateTaskBody = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    parentId: z.uuid().optional(),
    tagIds: z.array(z.uuid()).max(50).optional(),
  })
  .openapi("CreateTaskBody");

export const UpdateTaskBody = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    status: TaskStatusSchema.optional(),
    position: z.number().int().min(0).optional(),
    suggestionState: SuggestionStateSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "At least one field is required",
  })
  .openapi("UpdateTaskBody");

export const ReplaceTagsBody = z
  .object({ tagIds: z.array(z.uuid()).max(50) })
  .openapi("ReplaceTagsBody");

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type AiStatus = z.infer<typeof AiStatusSchema>;
export type AiSkipReason = z.infer<typeof AiSkipReasonSchema>;
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;
export type SuggestionState = z.infer<typeof SuggestionStateSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type ListTasksInput = z.infer<typeof ListTasksQuery>;
export type CreateTaskInput = z.infer<typeof CreateTaskBody>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskBody>;
export type ReplaceTagsInput = z.infer<typeof ReplaceTagsBody>;

const detail = (description: string) => jsonResponse(description, envelope(TaskDetailSchema));

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/tasks`,
  tags: ["tasks"],
  summary: "List tasks",
  description:
    "Top-level tasks unless `parentId` is given. Keyset pagination on (createdAt desc, id desc); pass `meta.nextCursor` back as `cursor`.",
  security: bearerAuth,
  request: { query: ListTasksQuery },
  responses: {
    200: jsonResponse("A page of tasks", listEnvelope(TaskSummarySchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks`,
  tags: ["tasks"],
  summary: "Create a task or a step",
  description:
    "Root creates enqueue an AI breakdown (aiStatus pending) unless AI is disabled or rate limited, in which case aiStatus is skipped with a reason. Child creates (parentId set) get aiStatus skipped. Only two levels are allowed.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateTaskBody } } } },
  responses: {
    201: detail("Created"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Get a task with its children, tags, progress and AI fields",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("The task"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "patch",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Update a task",
  description:
    "`position` is a target index among siblings; affected siblings shift in the same transaction. `suggestionState` is valid only on AI-origin rows: suggested to accepted or dismissed, dismissed to accepted, accepted to dismissed.",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateTaskBody } } },
  },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "delete",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Delete a task and its children",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/breakdown`,
  tags: ["tasks"],
  summary: "Request an AI breakdown",
  description:
    "Root tasks only. CONFLICT when a generation is already pending or running. RATE_LIMITED past the user or global hourly limit (details carry scope, limit, resetAt). UNAVAILABLE when AI is paused by the operator.",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    202: detail("Accepted; aiStatus is pending"),
    ...errorResponses(
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
      "UNAVAILABLE",
    ),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/suggestions/accept-all`,
  tags: ["tasks"],
  summary: "Accept every suggested step",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/suggestions/dismiss-all`,
  tags: ["tasks"],
  summary: "Dismiss every suggested step",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "put",
  path: `${API_PREFIX}/tasks/{id}/tags`,
  tags: ["tasks"],
  summary: "Replace the task's tag set",
  description: "Unknown or foreign tag ids give VALIDATION_ERROR.",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: ReplaceTagsBody } } },
  },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});
```

- [ ] **Step 7: Write `src/schemas/feature-requests.ts`, `src/schemas/admin.ts`, `src/schemas/health.ts`, `src/schemas/breakdown.ts`**

`src/schemas/feature-requests.ts`:

```ts
import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";

export const FeatureRequestBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    problem: z.string().trim().min(10).max(4000),
    proposedBehavior: z.string().trim().min(10).max(4000),
    acceptanceCriteria: z.string().trim().min(10).max(4000),
    outOfScope: z.string().trim().max(4000).optional(),
  })
  .openapi("FeatureRequestBody");

export const FeatureRequestResponse = z
  .object({ issueNumber: z.number().int(), issueUrl: z.url() })
  .openapi("FeatureRequestResponse");

export type FeatureRequestInput = z.infer<typeof FeatureRequestBody>;

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/feature-requests`,
  tags: ["feature-requests"],
  summary: "File a feature request as a GitHub issue",
  description:
    "Mounted only when GITHUB_TOKEN and GITHUB_REPO are configured. The issue is labeled `feature-request` and carries the submitter's display name.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: FeatureRequestBody } } } },
  responses: {
    201: jsonResponse("Issue created", envelope(FeatureRequestResponse)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "UPSTREAM_ERROR"),
  },
});
```

`src/schemas/admin.ts`:

```ts
import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, registry } from "./registry.js";

export const AdminTokenHeaders = z.object({
  "x-admin-token": z.string().min(1).openapi({ description: "Facilitator token" }),
});

export const SeedResetResponse = z.object({ demoUserId: z.uuid() }).openapi("SeedResetResponse");

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/admin/seed-reset`,
  tags: ["admin"],
  summary: "Delete and recreate the demo user's fixtures",
  description:
    "Mounted only when ADMIN_TOKEN is configured. A wrong or missing token returns NOT_FOUND so the route is invisible to guessing.",
  request: { headers: AdminTokenHeaders },
  responses: {
    200: jsonResponse("Fixtures recreated", envelope(SeedResetResponse)),
    ...errorResponses("NOT_FOUND"),
  },
});
```

`src/schemas/health.ts`:

```ts
import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, registry } from "./registry.js";

const CheckState = z.enum(["ok", "failed"]);

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    commit: z.string(),
    env: z.enum(["development", "test", "staging", "production"]),
    checks: z.object({ db: CheckState, redis: CheckState }),
    // Master plan section 4: true exactly when POST /feature-requests is mounted.
    features: z.object({ featureRequests: z.boolean() }),
  })
  .openapi("Health");

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/health`,
  tags: ["system"],
  summary: "Health check with the running commit SHA",
  responses: {
    200: jsonResponse("Healthy", envelope(HealthSchema)),
    ...errorResponses("UNAVAILABLE"),
  },
});

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/openapi.json`,
  tags: ["system"],
  summary: "This OpenAPI document",
  responses: {
    200: {
      description: "The committed openapi.json",
      content: { "application/json": { schema: z.looseObject({}) } },
    },
  },
});
```

`src/schemas/breakdown.ts` (the model's structured-output schema; not part of the HTTP contract):

```ts
import { z } from "zod";

export const MIN_STEPS = 3;
export const MAX_STEPS = 7;
export const MAX_TAG_SUGGESTIONS = 3;

export const BreakdownSchema = z.object({
  steps: z
    .array(z.object({ title: z.string(), rationale: z.string() }))
    .min(MIN_STEPS)
    .max(MAX_STEPS),
  tagSuggestions: z.array(z.string()).max(MAX_TAG_SUGGESTIONS),
});

export type BreakdownResult = z.infer<typeof BreakdownSchema>;
```

- [ ] **Step 8: Write `src/schemas/index.ts`**

```ts
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import "./health.js";
import "./auth.js";
import "./tasks.js";
import "./tags.js";
import "./feature-requests.js";
import "./admin.js";
import { registry } from "./registry.js";

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

export function generateOpenApiDocument(): OpenApiDocument {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Kaizen Tasks API",
      version: "1",
      description:
        "Personal task manager where every big task is broken into small steps by an AI assistant. Every response uses the `{ data, meta }` envelope; every error uses `{ error }`.",
    },
    tags: [
      { name: "auth" },
      { name: "tasks" },
      { name: "tags" },
      { name: "feature-requests" },
      { name: "admin" },
      { name: "system" },
    ],
  });
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run --project unit src/schemas`
Expected:

```
 ✓ src/schemas/index.test.ts (4 tests)
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- [ ] **Step 10: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/schemas
git commit -F - <<'MSG'
feat: zod schemas for every endpoint with OpenAPI registration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 5: OpenAPI generator, API docs renderer, committed contract

**Files:**
- Create: `scripts/render-api-docs.ts`, `scripts/generate-openapi.ts`, `openapi.json` (generated), `docs/API.md` (generated)
- Modify: `src/schemas/index.test.ts` (adds renderer assertions)

**Interfaces:**
- Consumes: Task 4 `generateOpenApiDocument`, `OpenApiDocument`.
- Produces: `renderApiDocs(doc: OpenApiDocument): string`; `npm run openapi` writes `openapi.json` and `docs/API.md`; `npm run openapi -- --check` exits 1 on drift. `openapi.json` is the cross-lane contract consumed by the web repo (master plan section 4).

- [ ] **Step 1: Extend the failing test**

Append to `src/schemas/index.test.ts` (inside the file, after the existing `describe`):

```ts
import { renderApiDocs } from "../../scripts/render-api-docs.js";

describe("renderApiDocs", () => {
  const md = renderApiDocs(generateOpenApiDocument());

  it("has one section per path and method with summary, parameters, body and responses", () => {
    for (const [method, path] of EXPECTED_ENDPOINTS) {
      expect(md).toContain(`## ${method.toUpperCase()} ${path}`);
    }
    const patchTask = md.slice(md.indexOf("## PATCH /api/v1/tasks/{id}"));
    const section = patchTask.slice(0, patchTask.indexOf("\n## ", 1));
    expect(section).toContain("Update a task");
    expect(section).toContain("| id | path | string (uuid) | yes |");
    expect(section).toContain("| suggestionState | SuggestionState |");
    expect(section).toContain("| 200 |");
    expect(section).toContain("| 404 |");
  });

  it("starts with the generated-file banner", () => {
    expect(md.startsWith("# Kaizen Tasks API reference\n\nGenerated from `openapi.json`")).toBe(true);
  });
});
```

Move the `import` line to the top of the file with the other imports (ESM imports must be top-level).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/schemas`
Expected: FAIL, `Failed to resolve import "../../scripts/render-api-docs.js"`.

- [ ] **Step 3: Write `scripts/render-api-docs.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenApiDocument } from "../src/schemas/index.js";

type Json = Record<string, unknown>;

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null;
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** Human-readable type for a schema object or $ref. */
export function typeName(schema: unknown, components: Json): string {
  if (!isObject(schema)) return "unknown";
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.map(String).join(" | ")})`;
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) return variants.map((v) => typeName(v, components)).join(" | ");
  if (Array.isArray(schema.allOf)) return (schema.allOf as unknown[]).map((v) => typeName(v, components)).join(" & ");
  const type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    const base = nonNull.length === 1 ? typeName({ ...schema, type: nonNull[0] }, components) : nonNull.join(" | ");
    return type.includes("null") ? `${base} | null` : base;
  }
  if (type === "array") return `${typeName(schema.items, components)}[]`;
  if (type === "object" || (type === undefined && isObject(schema.properties))) return "object";
  if (typeof type === "string") return schema.format ? `${type} (${String(schema.format)})` : type;
  return "unknown";
}

function resolveSchema(schema: unknown, components: Json): Json | undefined {
  if (!isObject(schema)) return undefined;
  if (typeof schema.$ref === "string") {
    const schemas = components.schemas;
    return isObject(schemas) ? (schemas[refName(schema.$ref)] as Json | undefined) : undefined;
  }
  return schema;
}

function bodyRows(schema: unknown, components: Json): string[] {
  const resolved = resolveSchema(schema, components);
  if (!resolved || !isObject(resolved.properties)) return [];
  const required = new Set(Array.isArray(resolved.required) ? resolved.required.map(String) : []);
  return Object.entries(resolved.properties).map(
    ([name, prop]) => `| ${name} | ${typeName(prop, components)} | ${required.has(name) ? "yes" : "no"} |`,
  );
}

function renderOperation(method: string, path: string, op: Json, components: Json): string {
  const lines: string[] = [`## ${method.toUpperCase()} ${path}`, ""];
  if (typeof op.summary === "string") lines.push(op.summary, "");
  if (typeof op.description === "string") lines.push(op.description, "");
  lines.push(`Auth: ${Array.isArray(op.security) && op.security.length > 0 ? "bearer access token" : "none"}`, "");

  const params = Array.isArray(op.parameters) ? (op.parameters as Json[]) : [];
  if (params.length > 0) {
    lines.push("**Parameters**", "", "| Name | In | Type | Required | Description |", "|---|---|---|---|---|");
    for (const p of params) {
      lines.push(
        `| ${String(p.name)} | ${String(p.in)} | ${typeName(p.schema, components)} | ${p.required ? "yes" : "no"} | ${typeof p.description === "string" ? p.description : ""} |`,
      );
    }
    lines.push("");
  }

  const body = isObject(op.requestBody) ? op.requestBody : undefined;
  const content = body && isObject(body.content) ? body.content : undefined;
  const json = content && isObject(content["application/json"]) ? content["application/json"] : undefined;
  if (json) {
    lines.push("**Request body** (`application/json`)", "", "| Field | Type | Required |", "|---|---|---|");
    lines.push(...bodyRows(json.schema, components));
    lines.push("");
  }

  const responses = isObject(op.responses) ? op.responses : {};
  lines.push("**Responses**", "", "| Status | Description | Body |", "|---|---|---|");
  for (const [status, response] of Object.entries(responses)) {
    const r = isObject(response) ? response : {};
    const rc = isObject(r.content) && isObject(r.content["application/json"]) ? r.content["application/json"] : undefined;
    const bodyType = rc ? typeName(rc.schema, components) : "";
    lines.push(`| ${status} | ${typeof r.description === "string" ? r.description : ""} | ${bodyType} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderApiDocs(doc: OpenApiDocument): string {
  const d = doc as unknown as Json;
  const components = isObject(d.components) ? d.components : {};
  const paths = isObject(d.paths) ? d.paths : {};
  const out: string[] = [
    "# Kaizen Tasks API reference",
    "",
    "Generated from `openapi.json` by `npm run openapi`. Do not edit by hand.",
    "",
    "All paths are absolute and already include `/api/v1`. Success responses are `{ data, meta }`; errors are `{ error: { code, message, details?, requestId } }`.",
    "",
  ];
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isObject(item)) continue;
    for (const method of METHOD_ORDER) {
      const op = item[method];
      if (isObject(op)) out.push(renderOperation(method, path, op, components));
    }
  }
  return out.join("\n");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.cwd();
  const doc = JSON.parse(readFileSync(resolve(root, "openapi.json"), "utf8")) as OpenApiDocument;
  writeFileSync(resolve(root, "docs/API.md"), renderApiDocs(doc));
  console.log("wrote docs/API.md from openapi.json");
}
```

- [ ] **Step 4: Write `scripts/generate-openapi.ts`**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { generateOpenApiDocument } from "../src/schemas/index.js";
import { renderApiDocs } from "./render-api-docs.js";

const check = process.argv.includes("--check");
const root = process.cwd();

const doc = generateOpenApiDocument();
const targets = [
  { rel: "openapi.json", content: `${JSON.stringify(doc, null, 2)}\n` },
  { rel: "docs/API.md", content: renderApiDocs(doc) },
];

if (check) {
  const dir = mkdtempSync(join(tmpdir(), "kaizen-openapi-"));
  let drift = false;
  for (const target of targets) {
    const fresh = join(dir, basename(target.rel));
    writeFileSync(fresh, target.content);
    const committedPath = resolve(root, target.rel);
    const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : "";
    if (committed !== target.content) {
      drift = true;
      console.error(`openapi --check: ${target.rel} is out of date (fresh copy: ${fresh})`);
    }
  }
  if (drift) {
    console.error("Fix: run `npm run openapi` and commit openapi.json and docs/API.md");
    process.exit(1);
  }
  console.log("openapi --check: openapi.json and docs/API.md are current");
} else {
  mkdirSync(resolve(root, "docs"), { recursive: true });
  for (const target of targets) {
    writeFileSync(resolve(root, target.rel), target.content);
  }
  console.log("wrote openapi.json and docs/API.md");
}
```

- [ ] **Step 5: Generate the contract**

Run: `npm run openapi`
Expected: `wrote openapi.json and docs/API.md`. Then `node -e 'const d=require("./openapi.json");console.log(d.openapi, Object.keys(d.paths).length)'` prints `3.1.0 17` (17 distinct paths covering the 22 operations).

- [ ] **Step 6: Run the drift check and the unit tests**

Run: `npm run openapi -- --check`
Expected: `openapi --check: openapi.json and docs/API.md are current`, exit 0.

Run: `npx vitest run --project unit`
Expected: all green now that `openapi.json` exists, including `createApp > serves the committed openapi.json`:

```
 Test Files  8 passed (8)
      Tests  33 passed (33)
```

Run: `sed -i '' 's/version: "1"/version: "1-drift"/' src/schemas/index.ts && npm run openapi -- --check; echo "exit=$?"; git checkout src/schemas/index.ts`
Expected: the check prints `openapi --check: openapi.json is out of date` and `exit=1`; the checkout restores the file.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add scripts/render-api-docs.ts scripts/generate-openapi.ts openapi.json docs/API.md src/schemas/index.test.ts
git commit -F - <<'MSG'
feat: generate openapi.json and docs/API.md from the schema registry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 6: Build pipeline, prompt asset, provisional server

**Files:**
- Create: `scripts/copy-assets.sh`, `scripts/check-dist-assets.sh`, `src/agent/prompts/breakdown.system.md`, `src/server.ts` (provisional; Task 20 replaces it with the full startup sequence)

**Interfaces:**
- Consumes: Task 3 `createApp`, `HealthProbes`; Task 1 `loadConfig`, `ConfigError`; Task 2 `createLogger`.
- Produces: `npm run build` emits `dist/` with `dist/server.js` and `dist/agent/prompts/breakdown.system.md`; `bash scripts/check-dist-assets.sh` exits 0 only when both exist; `npm start` serves `GET /api/v1/health`. The prompt file is the versioned system prompt the agent loads in Task 15.

The prompt ships in L1-M1 because the spec's `build` script copies `src/agent/prompts/`, and L1-M1's done condition includes `npm run build` passing.

- [ ] **Step 1: Write the asset scripts and make them executable**

`scripts/copy-assets.sh`:

```bash
#!/usr/bin/env bash
# Copies runtime assets that tsc does not emit. Run by `npm run build`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC="src/agent/prompts"
DEST="dist/agent/prompts"

if [[ ! -d "$SRC" ]]; then
  echo "copy-assets: missing $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
echo "copy-assets: copied $SRC -> $DEST"
```

`scripts/check-dist-assets.sh`:

```bash
#!/usr/bin/env bash
# CI gate: fails if the build output is missing the compiled entry point or the prompt asset.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

missing=0
for f in dist/server.js dist/agent/prompts/breakdown.system.md; do
  if [[ ! -f "$f" ]]; then
    echo "check-dist-assets: missing $f" >&2
    missing=1
  fi
done

if (( missing != 0 )); then
  exit 1
fi
echo "check-dist-assets: OK"
```

Run: `chmod +x scripts/copy-assets.sh scripts/check-dist-assets.sh`

- [ ] **Step 2: Write the system prompt**

`src/agent/prompts/breakdown.system.md`:

```markdown
# Breakdown coach

## Role

You are a coach helping one person move on a task by turning it into a short list of small, doable steps. The person stays in control: everything you return is a proposal they will accept, edit, or dismiss. You never act on their behalf and you never invent facts about their situation; when the task is ambiguous, choose the most ordinary reading and keep the steps generic enough to fit it.

## How to reason

Work through these in order before you write anything.

1. State the outcome in one line: what is true when this task is done.
2. Identify the first physical action, the smallest thing the person can do in the next ten minutes that starts the work (open a document, send one message, list three names). That is step one.
3. Keep every step under about an hour of focused work. If a step would take longer, split it.
4. Order the steps by dependency: a step comes after the steps it needs. Steps that do not depend on each other keep a natural working order.
5. Stop at seven steps. If the task needs more, keep the first six and make the seventh a step that plans the remainder. Never return fewer than three.
6. Prefer concrete verbs at the start of each title: draft, call, list, book, compare, send, review. Avoid vague titles such as "research" or "think about".

## Constraints

- Never repeat a step that already exists. `existingSteps` lists the current steps; propose only steps that add something. If the existing steps already cover the work, propose the missing pieces around them.
- Reuse an existing tag name exactly, character for character, when one in `tags` fits the task. Propose a new tag only when none fits, and keep new tag names short and lowercase. Propose at most three tags in total and none when nothing fits.
- `openTasks` lists the person's other open tasks for context only. Use them to avoid suggesting work that belongs to another task. Do not mention them in the steps.
- The rationale is one sentence that explains why the step comes where it does in the order, not what the step is.
- Titles are short, at most about twelve words, without trailing punctuation.
- Do not add steps about using this app, about "reviewing these suggestions", or about celebrating.

## Output contract

Return only the structured object with two fields: `steps`, an ordered list of three to seven objects with `title` and `rationale`, and `tagSuggestions`, a list of zero to three tag names. No prose outside those fields.

## Input

The user message is a JSON object with `title`, `description`, `existingSteps`, `tags`, and `openTasks`. `description` may be empty.
```

- [ ] **Step 3: Write the provisional `src/server.ts`**

This version has only what L1-M1 needs: config, a Postgres probe, a Redis probe, the app, graceful shutdown. Task 20 replaces the file with the seven-step startup sequence.

```ts
import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import postgres from "postgres";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const sql = postgres(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect();
  await redis.ping();

  const app = createApp({
    config,
    logger,
    probes: {
      db: async () => {
        await sql`select 1`;
      },
      redis: async () => {
        await redis.ping();
      },
    },
  });

  const server = app.listen(config.PORT, "::", () => {
    logger.info({ port: config.PORT, env: config.APP_ENV }, "api listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.all([redis.quit(), sql.end()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Build and check the assets**

Run: `npm run build && bash scripts/check-dist-assets.sh`
Expected:

```
copy-assets: copied src/agent/prompts -> dist/agent/prompts
check-dist-assets: OK
```

Run: `rm -rf dist/agent && bash scripts/check-dist-assets.sh; echo "exit=$?"`
Expected: `check-dist-assets: missing dist/agent/prompts/breakdown.system.md` and `exit=1`. Re-run `npm run build` afterwards.

- [ ] **Step 5: Serve health locally**

Create `.env` from the example with a fake provider (`.env` is git-ignored):

Run: `cp .env.example .env && sed -i '' 's/^AI_MODEL_PROVIDER=.*/AI_MODEL_PROVIDER=fake/' .env && sed -i '' 's/^JWT_SECRET=.*/JWT_SECRET=local-dev-secret-that-is-at-least-32-chars/' .env && createdb kaizen_dev 2>/dev/null || true`

Run: `npm start & sleep 2; curl -s -i http://localhost:3000/api/v1/health; kill %1`
Expected: `HTTP/1.1 200 OK`, header `x-request-id: <uuid>`, body `{"data":{"status":"ok","commit":"local","env":"development","checks":{"db":"ok","redis":"ok"},"features":{"featureRequests":false}},"meta":{"requestId":"<same uuid>"}}`.

Run: `DATABASE_URL= npm start; echo "exit=$?"` (with `.env` moved aside: `mv .env .env.bak && DATABASE_URL= npm start; echo "exit=$?"; mv .env.bak .env`)
Expected: `Invalid configuration:` followed by `  - DATABASE_URL: ...` and `exit=1`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add scripts/copy-assets.sh scripts/check-dist-assets.sh src/agent/prompts/breakdown.system.md src/server.ts
git commit -F - <<'MSG'
feat: build pipeline with prompt asset and a provisional server

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 7: CI workflow, Railway IaC, README, CLAUDE.md and CHANGELOG skeletons

**Files:**
- Create: `.github/workflows/ci.yml`, `.railway/railway.ts`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: every script from Task 1 and the asset check from Task 6.
- Produces: workflow name `ci`, job id `ci` (the required status check named in the master plan); the `api` service declaration the L3 lane applies with `railway config apply`; the docs skeleton Task 21 completes.
- Verification V4 (wait-for-CI holds a push-triggered deploy) is proven with this task's artifacts: `ci.yml` runs on `push` to `develop`, and `railway.ts` tracks `develop` in staging with `checkSuites: true` on the GitHub source (the master plan's section 4 interface; spec 10.3's "dashboard-only" note predates the field, which `railway` 3.11 exposes on `ServiceSource`). The L3 lane observes at L3-M1 that a push to `develop` shows a Railway deployment waiting on the `ci` check before building. If it does not wait, the fallback from spec 11 applies: GitHub Actions deploys through the Railway CLI, added to `ci.yml` as a final step by L3.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

The docs-check step is added by Task 22, which creates the script.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [develop, main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    name: ci
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/kaizen_test
      REDIS_URL: redis://localhost:6379/1
      JWT_SECRET: ci-only-jwt-secret-that-is-at-least-32-chars
      AI_MODEL_PROVIDER: fake
      APP_ENV: test
      WORKER_ENABLED: "false"
      LOG_LEVEL: silent
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
      - run: bash scripts/check-dist-assets.sh
```

- [ ] **Step 2: Write `.railway/railway.ts`**

```ts
import { defineRailway, github, preserve, project, service } from "railway/iac";

// This repository owns only the `api` service. `web` lives in kaizen-tasks-web, and Postgres and
// Redis are provisioned by the L3 lane. The named partial scopes "omit means delete" to the
// resources this file declares, so `railway config apply` from this repo can never remove them
// (Railway IaC docs, "One file per project"). Never rename the partial once it has been applied.
export const partial = "api";

export default defineRailway((ctx) => {
  const production = ctx.environment === "production";

  const api = service("api", {
    // Branch per environment: develop deploys to staging, main to production. checkSuites is
    // wait-for-CI (master plan section 4, `source.checkSuites: true`): Railway holds the deploy
    // until the GitHub check suite for the commit passes. Declared here so an apply never resets it.
    source: github("kpnemo/kaizen-tasks-api", {
      branch: production ? "main" : "develop",
      checkSuites: true,
    }),
    build: "npm run build",
    start: "node dist/server.js",
    healthcheck: "/api/v1/health",
    healthcheckTimeout: 120,
    env: {
      PORT: "3000",
      APP_ENV: production ? "production" : "staging",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      REDIS_URL: "${{Redis.REDIS_URL}}",
      WORKER_ENABLED: "true",
      AI_MODEL: "claude-sonnet-5",
      AI_RATE_LIMIT_PER_HOUR: "20",
      AI_GLOBAL_LIMIT_PER_HOUR: "300",
      AI_ENABLED: "true",
      AI_STALE_MINUTES: "10",
      SEED_DEMO_USER: "true",
      LOG_LEVEL: "info",
      // Secrets are pasted by Mike in the dashboard and never written here.
      JWT_SECRET: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ADMIN_TOKEN: preserve(),
      SEED_DEMO_PASSWORD: preserve(),
      GITHUB_TOKEN: preserve(),
      GITHUB_REPO: preserve(),
    },
  });

  return project("kaizen-tasks", { resources: [api] });
});
```

Run: `npm run typecheck`
Expected: exit 0. If tsc reports `Cannot find module 'railway/iac'`, the installed `railway` package does not ship resolvable types under NodeNext; remove `".railway"` from the `include` array in `tsconfig.json`, re-run, and note in the commit message that the file is validated by `railway config plan` instead.

- [ ] **Step 3: Write `CHANGELOG.md`**

```markdown
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
```

- [ ] **Step 4: Write `README.md`**

```markdown
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

| Script | Does |
|---|---|
| `npm run dev` | `tsx watch src/server.ts` |
| `npm run build` | `tsc -p tsconfig.build.json && scripts/copy-assets.sh` |
| `npm start` | `node dist/server.js` |
| `npm test` | vitest, `unit` and `integration` projects (needs local Postgres and Redis) |
| `npm run test:live` | the opt-in live model test; runs only with `ANTHROPIC_API_KEY` set |
| `npm run lint` | eslint and prettier check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | drizzle-kit generate |
| `npm run db:migrate` | run migrations |
| `npm run db:seed` | create the demo fixtures if absent; `-- --reset` deletes and recreates them |
| `npm run openapi` | regenerate `openapi.json` and `docs/API.md`; `-- --check` for drift |
| `npm run docs:check` | `scripts/docs-check.sh --hook` |

## URLs

| Environment | How to reach the API |
|---|---|
| Local | `http://localhost:3000/api/v1/health` |
| Staging | through the staging web domain, `https://<web-domain>/api/v1/health` (recorded in the assembly-line runbook) |
| Production | through the production web domain, same path |

The API service has no public domain of its own; the web service proxies `/api/*` to
`http://api.railway.internal:3000`.

## Documentation

- `docs/API.md`: generated reference (do not edit by hand; run `npm run openapi`).
- `docs/ARCHITECTURE.md`: service shape, AI pipeline, deploy topology.
- `docs/adr/`: architecture decision records.
- `CHANGELOG.md`: Keep a Changelog format; every change adds a bullet under `[Unreleased]`.
- `CLAUDE.md`: conventions for agentic work in this repo.
```

- [ ] **Step 5: Write the `CLAUDE.md` skeleton**

Task 21 completes this file. The skeleton already states the rules that apply from now on.

```markdown
# CLAUDE.md

Kaizen Tasks API: Express 5 on Node 24, Postgres through Drizzle, Redis and BullMQ, Anthropic SDK.
Spec: `docs/superpowers/specs/2026-09-08-kaizen-tasks-api-design.md`. Plan: `docs/superpowers/plans/2026-09-08-kaizen-tasks-api.md`.

## Layering

| Layer | May import |
|---|---|
| `src/routes` | `schemas`, `services`, `lib` |
| `src/services` | `repositories`, `agent`, `jobs/queue`, `lib` |
| `src/repositories` | `db`, `lib` |
| `src/jobs` | `services`, `repositories`, `agent`, `lib` |
| `src/agent` | `lib`, `schemas` |
| `src/lib`, `src/db`, `src/schemas` | nothing app-level above them (`schemas` may import `lib/errors` for the code list) |

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
```

- [ ] **Step 6: Run the full CI sequence locally**

Run: `npm run typecheck && npm run lint && npm test && npm run build && bash scripts/check-dist-assets.sh`
Expected: each step exits 0; the vitest summary shows all unit tests passing and the integration project with no files:

```
 Test Files  8 passed (8)
      Tests  33 passed (33)
```

- [ ] **Step 7: Commit, and push once the GitHub repo exists**

```bash
git add .github/workflows/ci.yml .railway/railway.ts README.md CLAUDE.md CHANGELOG.md tsconfig.json
git commit -F - <<'MSG'
chore: ci workflow, railway iac, readme, claude.md and changelog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

When the L3 lane has created `kpnemo/kaizen-tasks-api` (master plan section 6, item 1), push and watch:

Run: `git push origin develop && gh run watch --repo kpnemo/kaizen-tasks-api --exit-status`
Expected: the `ci` workflow completes with `✓ ci` and exit 0.

---

## End of milestone L1-M1

L1-M1 is complete after Task 7: `npm test` and `npm run build` pass, `GET /api/v1/health` serves locally, `openapi.json` is committed and describes every endpoint in spec section 4.4 with request and response schemas, and `ci.yml` is green on `develop` once the repo exists. The L2 lane may now pull the contract and the L3 lane may connect the `api` service. Everything from Task 8 on is L1-M2.

---

# Milestone L1-M2: auth, tasks, tags, AI pipeline, tests, docs, harness

### Task 8: Database schema, first migration, client, and real test setup

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle/0000_init.sql` and `drizzle/meta/*` (generated)
- Modify: `tests/setup/global.ts`, `tests/setup/each.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadConfig`, `loadTestEnv`.
- Produces: Drizzle tables `users`, `tasks`, `tags`, `taskTags` and enums `taskStatusEnum`, `aiStatusEnum`, `aiSkipReasonEnum`, `taskOriginEnum`, `suggestionStateEnum` from `src/db/schema.ts`; `createDb(url, { max? }): { db: Db; sql: Sql }`, types `Db`, `Tx`, `DbOrTx`, `isUniqueViolation(err)`, `isCheckViolation(err)` from `src/db/client.ts`; `runMigrations(db: Db): Promise<void>`, `MIGRATIONS_FOLDER` from `src/db/migrate.ts`; `npm run db:generate`, `npm run db:migrate`. Integration tests now run against a migrated `kaizen_test` with tables truncated and Redis db 1 flushed before every test.
- Row types later tasks use: `typeof users.$inferSelect` (`UserRow`), `typeof tasks.$inferSelect` (`TaskRow`), `typeof tags.$inferSelect` (`TagRow`).

- [ ] **Step 1: Write the failing integration test**

`tests/db/schema.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, isCheckViolation, isUniqueViolation, type Db } from "../../src/db/client.js";
import { tags, tasks, users } from "../../src/db/schema.js";

let db: Db;
let end: () => Promise<void>;

beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

async function user(email = `${randomUUID()}@test.local`) {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", displayName: "T" })
    .returning();
  return row!;
}

describe("schema", () => {
  it("has the four tables and five enums", async () => {
    const tables = await db.execute<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = tables.map((r) => r.table_name);
    for (const t of ["users", "tasks", "tags", "task_tags"]) expect(names).toContain(t);
    const enums = await db.execute<{ typname: string }>(
      `select typname from pg_type where typtype = 'e' order by typname`,
    );
    expect(enums.map((r) => r.typname).sort()).toEqual(
      ["ai_skip_reason", "ai_status", "suggestion_state", "task_origin", "task_status"].sort(),
    );
  });

  it("applies the documented defaults on tasks", async () => {
    const u = await user();
    const [t] = await db.insert(tasks).values({ userId: u.id, title: "Defaults" }).returning();
    expect(t!.status).toBe("todo");
    expect(t!.position).toBe(0);
    expect(t!.origin).toBe("user");
    expect(t!.suggestionState).toBeNull();
    expect(t!.aiStatus).toBe("pending");
    expect(t!.aiTagSuggestions).toEqual([]);
    expect(t!.generationId).toBeNull();
    expect(t!.createdAt).toBeInstanceOf(Date);
  });

  it("enforces suggestion_state non-null exactly when origin is ai", async () => {
    const u = await user();
    let caught: unknown;
    try {
      await db.insert(tasks).values({ userId: u.id, title: "bad", origin: "user", suggestionState: "suggested" });
    } catch (err) {
      caught = err;
    }
    expect(isCheckViolation(caught)).toBe(true);
    caught = undefined;
    try {
      await db.insert(tasks).values({ userId: u.id, title: "bad", origin: "ai" });
    } catch (err) {
      caught = err;
    }
    expect(isCheckViolation(caught)).toBe(true);
    const [ok] = await db
      .insert(tasks)
      .values({ userId: u.id, title: "ok", origin: "ai", suggestionState: "suggested" })
      .returning();
    expect(ok!.suggestionState).toBe("suggested");
  });

  it("rejects duplicate tag names per user case-insensitively but allows them across users", async () => {
    const a = await user();
    const b = await user();
    await db.insert(tags).values({ userId: a.id, name: "Work", color: "#2563eb" });
    let caught: unknown;
    try {
      await db.insert(tags).values({ userId: a.id, name: "work", color: "#000000" });
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    const [other] = await db.insert(tags).values({ userId: b.id, name: "work", color: "#000000" }).returning();
    expect(other!.name).toBe("work");
  });

  it("cascades user deletion to tasks and children", async () => {
    const u = await user();
    const [root] = await db.insert(tasks).values({ userId: u.id, title: "root" }).returning();
    await db.insert(tasks).values({ userId: u.id, title: "child", parentId: root!.id, aiStatus: "skipped" });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(tasks)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/db`
Expected: FAIL, `Failed to resolve import "../../src/db/client.js"`.

- [ ] **Step 3: Write `src/db/schema.ts`**

```ts
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done"]);
export const aiStatusEnum = pgEnum("ai_status", ["pending", "running", "done", "failed", "skipped"]);
export const aiSkipReasonEnum = pgEnum("ai_skip_reason", ["too_short", "rate_limited", "ai_disabled"]);
export const taskOriginEnum = pgEnum("task_origin", ["user", "ai"]);
export const suggestionStateEnum = pgEnum("suggestion_state", ["suggested", "accepted", "dismissed"]);

// Millisecond precision keeps keyset cursors (ISO strings) exact.
const stamp = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: stamp("created_at"),
  updatedAt: stamp("updated_at"),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("todo"),
    position: integer("position").notNull().default(0),
    origin: taskOriginEnum("origin").notNull().default("user"),
    suggestionState: suggestionStateEnum("suggestion_state"),
    rationale: text("rationale"),
    aiStatus: aiStatusEnum("ai_status").notNull().default("pending"),
    aiSkipReason: aiSkipReasonEnum("ai_skip_reason"),
    aiError: text("ai_error"),
    generationId: uuid("generation_id"),
    aiTagSuggestions: text("ai_tag_suggestions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    index("tasks_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
    index("tasks_parent_position_idx").on(t.parentId, t.position, t.createdAt, t.id),
    index("tasks_ai_status_updated_idx").on(t.aiStatus, t.updatedAt),
    check(
      "tasks_suggestion_state_origin_check",
      sql`(${t.origin} = 'ai') = (${t.suggestionState} is not null)`,
    ),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [uniqueIndex("tags_user_lower_name_idx").on(t.userId, sql`lower(${t.name})`)],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
```

- [ ] **Step 4: Write `src/db/client.ts` and `drizzle.config.ts`**

`src/db/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string, options: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** Postgres SQLSTATE of an error, looking through Drizzle's wrapper (`cause`). */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return pgErrorCode((err as { cause?: unknown }).cause);
}

export const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === "23505";
export const isCheckViolation = (err: unknown): boolean => pgErrorCode(err) === "23514";
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/kaizen_dev",
  },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 5: Write `src/db/migrate.ts`**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "./client.js";

/** Migrations are resolved from the repository root, which is the working directory on Railway. */
export const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 1 });
  await runMigrations(db);
  await sql.end();
  console.log(`migrations applied from ${MIGRATIONS_FOLDER}`);
}
```

- [ ] **Step 6: Generate and inspect the first migration**

Run: `npm run db:generate -- --name init`
Expected: `[✓] Your SQL migration file ➜ drizzle/0000_init.sql 🚀` and a `drizzle/meta/` folder with `_journal.json` and `0000_snapshot.json`.

Run: `grep -c 'CREATE TYPE "public"' drizzle/0000_init.sql; grep -E 'CREATE TABLE "(users|tasks|tags|task_tags)"' drizzle/0000_init.sql | wc -l; grep -c 'tasks_suggestion_state_origin_check' drizzle/0000_init.sql; grep -c 'CREATE UNIQUE INDEX "tags_user_lower_name_idx"' drizzle/0000_init.sql; grep -c 'CREATE INDEX "tasks_' drizzle/0000_init.sql`
Expected: `5`, `4`, `1`, `1`, `3`.

Run: `npm run db:migrate`
Expected: `migrations applied from /.../webapp/backend/drizzle` (against `kaizen_dev` from `.env`).

- [ ] **Step 7: Complete the test setup files**

`tests/setup/global.ts` (replace the Task 1 version):

```ts
import postgres from "postgres";
import { createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadTestEnv } from "./env.js";

/** Creates kaizen_test if missing and applies migrations, once per vitest run. */
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const url = new URL(process.env.DATABASE_URL ?? "");
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against "${dbName}": the database name must end with _test`);
  }
  const maintenance = new URL(url.toString());
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  const existing = await admin`select 1 from pg_database where datname = ${dbName}`;
  if (existing.length === 0) {
    await admin.unsafe(`create database "${dbName}"`);
  }
  await admin.end();

  const { db, sql } = createDb(url.toString(), { max: 1 });
  await runMigrations(db);
  await sql.end();
}
```

`tests/setup/each.ts` (replace the Task 1 version):

```ts
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { loadTestEnv } from "./env.js";

loadTestEnv();

let sql: Sql;
let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL ?? "";
  if (new URL(redisUrl).pathname !== "/1") {
    throw new Error(`Tests must use Redis database index 1, got ${redisUrl}`);
  }
  sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  redis = new Redis(redisUrl);
});

beforeEach(async () => {
  await sql`truncate table users, tasks, tags, task_tags cascade`;
  await redis.flushdb();
});

afterAll(async () => {
  await sql.end();
  await redis.quit();
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/db`
Expected:

```
 ✓ tests/db/schema.test.ts (5 tests)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 9: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add drizzle.config.ts src/db drizzle tests/setup tests/db
git commit -F - <<'MSG'
feat: drizzle schema, initial migration, db client and real test setup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 9: Queue module, model seam, fakes

**Files:**
- Create: `src/lib/redis.ts`, `src/jobs/queue.ts`, `src/agent/model.ts`, `src/agent/errors.ts`, `src/agent/fake-model.ts`, `tests/helpers/fake-queue.ts`
- Test: `tests/jobs/queue.test.ts`, `src/agent/fake-model.test.ts`

**Interfaces:**
- Consumes: Task 4 `BreakdownResult`.
- Produces:
  - `createRedis(url, { lazyConnect? }): Redis` (ioredis, `maxRetriesPerRequest: null`).
  - queue: `BREAKDOWN_QUEUE_NAME = "breakdown"`, `QUEUE_PREFIX = "kaizen"`, `WORKER_CONCURRENCY = 3`, `type BreakdownReason = "create" | "retry" | "regenerate"`, `interface BreakdownJobData { taskId; userId; generationId; reason }`, `breakdownJobId(taskId, generationId): string`, `BREAKDOWN_JOB_OPTIONS: JobsOptions`, `interface BreakdownQueue { enqueueBreakdown(data): Promise<void>; close(): Promise<void> }`, `type BreakdownBullQueue = Queue<BreakdownJobData>`, `enqueueBreakdown(queue: BreakdownBullQueue, data)`, `createBreakdownQueue(connection: Redis): BreakdownQueue & { queue: BreakdownBullQueue }`.
  - model: `interface BreakdownInput { title; description; existingSteps: string[]; tags: string[]; openTasks: string[] }`, `type BreakdownOutcome = { kind: "ok"; result } | { kind: "refused"; reason } | { kind: "invalid"; reason }`, `interface BreakdownModel { complete(input): Promise<BreakdownOutcome> }`.
  - errors: `BreakdownRefused`, `BreakdownInvalid`, `ModelRetryableError`, `ModelNonRetryableError` (all `extends Error`, the model errors carry `cause`).
  - `FakeBreakdownModel` with `mode: "ok" | "refuse" | "invalid" | "retryable-error"`, `result`, `calls`; `FAKE_BREAKDOWN_RESULT`.
  - `FakeQueue implements BreakdownQueue` with `jobs: BreakdownJobData[]`, `failNext: boolean`, `drain(run: (data) => Promise<void>): Promise<number>`.
- Verification V6 (BullMQ 6 accepts the `${taskId}-${generationId}` job id): the first half is proven here by adding a job through the real `enqueueBreakdown` and reading it back by that id; Task 17 completes it by processing such a job with a real worker.

- [ ] **Step 1: Write the failing tests**

`tests/jobs/queue.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  breakdownJobId,
  createBreakdownQueue,
  type BreakdownBullQueue,
  type BreakdownQueue,
} from "../../src/jobs/queue.js";
import { createRedis } from "../../src/lib/redis.js";

let connection: Redis;
let queue: BreakdownQueue & { queue: BreakdownBullQueue };

beforeEach(() => {
  connection = createRedis(process.env.REDIS_URL ?? "");
  queue = createBreakdownQueue(connection);
});

afterEach(async () => {
  await queue.close();
  await connection.quit();
});

describe("breakdown queue", () => {
  it("adds a job whose id is <taskId>-<generationId> with the spec options (V6, part 1)", async () => {
    const taskId = randomUUID();
    const generationId = randomUUID();
    await queue.enqueueBreakdown({ taskId, userId: randomUUID(), generationId, reason: "create" });

    const job = await queue.queue.getJob(breakdownJobId(taskId, generationId));
    expect(job).toBeDefined();
    expect(job?.id).toBe(`${taskId}-${generationId}`);
    expect(job?.data.reason).toBe("create");
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 3000 });
    expect(job?.opts.removeOnComplete).toBe(true);
    expect(job?.opts.removeOnFail).toEqual({ count: 100 });
    expect(await queue.queue.getWaitingCount()).toBe(1);
  });

  it("keeps its keys under the kaizen prefix", async () => {
    await queue.enqueueBreakdown({
      taskId: randomUUID(),
      userId: randomUUID(),
      generationId: randomUUID(),
      reason: "regenerate",
    });
    const keys = await connection.keys("kaizen:breakdown:*");
    expect(keys.length).toBeGreaterThan(0);
  });
});
```

`src/agent/fake-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ModelRetryableError } from "./errors.js";
import { FAKE_BREAKDOWN_RESULT, FakeBreakdownModel } from "./fake-model.js";

const input = { title: "Plan the offsite", description: "", existingSteps: [], tags: [], openTasks: [] };

describe("FakeBreakdownModel", () => {
  it("returns the fixture by default and records calls", async () => {
    const model = new FakeBreakdownModel();
    const outcome = await model.complete(input);
    expect(outcome).toEqual({ kind: "ok", result: FAKE_BREAKDOWN_RESULT });
    expect(model.calls).toEqual([input]);
  });

  it("can refuse, return invalid output, or throw a retryable error", async () => {
    const model = new FakeBreakdownModel({ mode: "refuse" });
    expect((await model.complete(input)).kind).toBe("refused");
    model.mode = "invalid";
    expect((await model.complete(input)).kind).toBe("invalid");
    model.mode = "retryable-error";
    await expect(model.complete(input)).rejects.toBeInstanceOf(ModelRetryableError);
  });

  it("returns a copy so callers cannot mutate the fixture", async () => {
    const model = new FakeBreakdownModel();
    const outcome = await model.complete(input);
    if (outcome.kind === "ok") outcome.result.steps.pop();
    expect(FAKE_BREAKDOWN_RESULT.steps).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/agent && npx vitest run --project integration tests/jobs`
Expected: FAIL, unresolved imports `./errors.js`, `./fake-model.js`, `../../src/jobs/queue.js`.

- [ ] **Step 3: Write `src/lib/redis.ts`**

```ts
import { Redis } from "ioredis";

/** ioredis client suited to BullMQ (maxRetriesPerRequest must be null for workers). */
export function createRedis(url: string, options: { lazyConnect?: boolean } = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: options.lazyConnect ?? false,
  });
}
```

- [ ] **Step 4: Write `src/jobs/queue.ts`**

```ts
import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

export const BREAKDOWN_QUEUE_NAME = "breakdown";
export const QUEUE_PREFIX = "kaizen";
export const WORKER_CONCURRENCY = 3;

export type BreakdownReason = "create" | "retry" | "regenerate";

export interface BreakdownJobData {
  taskId: string;
  userId: string;
  generationId: string;
  reason: BreakdownReason;
}

/** BullMQ rejects colons in custom job ids; the generation id makes every attempt unique. */
export function breakdownJobId(taskId: string, generationId: string): string {
  return `${taskId}-${generationId}`;
}

export const BREAKDOWN_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: true,
  removeOnFail: { count: 100 },
};

export interface BreakdownQueue {
  enqueueBreakdown(data: BreakdownJobData): Promise<void>;
  close(): Promise<void>;
}

export type BreakdownBullQueue = Queue<BreakdownJobData>;

export async function enqueueBreakdown(
  queue: BreakdownBullQueue,
  data: BreakdownJobData,
): Promise<void> {
  await queue.add("breakdown", data, {
    ...BREAKDOWN_JOB_OPTIONS,
    jobId: breakdownJobId(data.taskId, data.generationId),
  });
}

export function createBreakdownQueue(
  connection: Redis,
): BreakdownQueue & { queue: BreakdownBullQueue } {
  const queue = new Queue<BreakdownJobData>(BREAKDOWN_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: BREAKDOWN_JOB_OPTIONS,
  });
  return {
    queue,
    enqueueBreakdown: (data) => enqueueBreakdown(queue, data),
    close: () => queue.close(),
  };
}
```

- [ ] **Step 5: Write `src/agent/model.ts`, `src/agent/errors.ts`, `src/agent/fake-model.ts`**

`src/agent/model.ts` (Task 15 adds `createBreakdownModel` to this file):

```ts
import type { BreakdownResult } from "../schemas/breakdown.js";

export interface BreakdownInput {
  title: string;
  description: string;
  existingSteps: string[];
  tags: string[];
  openTasks: string[];
}

export type BreakdownOutcome =
  | { kind: "ok"; result: BreakdownResult }
  | { kind: "refused"; reason: string }
  | { kind: "invalid"; reason: string };

/** The seam between the pipeline and any model provider. */
export interface BreakdownModel {
  complete(input: BreakdownInput): Promise<BreakdownOutcome>;
}
```

`src/agent/errors.ts`:

```ts
/** The model declined the task. Not retryable. */
export class BreakdownRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BreakdownRefused";
  }
}

/** The model output could not be parsed or failed post-validation. Not retryable. */
export class BreakdownInvalid extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BreakdownInvalid";
  }
}

/** 429, 5xx, connection or timeout failures. The queue retries these. */
export class ModelRetryableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "model request failed", { cause });
    this.name = "ModelRetryableError";
  }
}

/** Other 4xx API failures. Not retryable. */
export class ModelNonRetryableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "model request rejected", { cause });
    this.name = "ModelNonRetryableError";
  }
}
```

`src/agent/fake-model.ts`:

```ts
import type { BreakdownResult } from "../schemas/breakdown.js";
import { ModelRetryableError } from "./errors.js";
import type { BreakdownInput, BreakdownModel, BreakdownOutcome } from "./model.js";

export type FakeMode = "ok" | "refuse" | "invalid" | "retryable-error";

export const FAKE_BREAKDOWN_RESULT: BreakdownResult = {
  steps: [
    {
      title: "Write the outcome in one line",
      rationale: "Everything else depends on knowing what done looks like",
    },
    {
      title: "List what you already have",
      rationale: "Reusing existing material comes before creating anything new",
    },
    {
      title: "Draft the first rough version",
      rationale: "A draft exists before anyone can review it",
    },
    {
      title: "Ask one person for feedback",
      rationale: "Outside eyes catch what the draft misses, so it follows the draft",
    },
  ],
  tagSuggestions: ["planning", "writing"],
};

/** Returns fixtures; can be told to refuse, return invalid output, or fail retryably. */
export class FakeBreakdownModel implements BreakdownModel {
  mode: FakeMode;
  result: BreakdownResult;
  readonly calls: BreakdownInput[] = [];

  constructor(options: { mode?: FakeMode; result?: BreakdownResult } = {}) {
    this.mode = options.mode ?? "ok";
    this.result = options.result ?? FAKE_BREAKDOWN_RESULT;
  }

  async complete(input: BreakdownInput): Promise<BreakdownOutcome> {
    this.calls.push(input);
    switch (this.mode) {
      case "refuse":
        return { kind: "refused", reason: "Fake refusal" };
      case "invalid":
        return { kind: "invalid", reason: "Fake unparseable output" };
      case "retryable-error":
        throw new ModelRetryableError(new Error("fake upstream outage"));
      default:
        return { kind: "ok", result: structuredClone(this.result) };
    }
  }
}
```

- [ ] **Step 6: Write `tests/helpers/fake-queue.ts`**

```ts
import type { BreakdownJobData, BreakdownQueue } from "../../src/jobs/queue.js";

/** Records enqueued jobs; `drain` runs them inline through whatever processor the test passes. */
export class FakeQueue implements BreakdownQueue {
  readonly jobs: BreakdownJobData[] = [];
  failNext = false;

  async enqueueBreakdown(data: BreakdownJobData): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake queue: redis unavailable");
    }
    this.jobs.push(data);
  }

  async close(): Promise<void> {}

  /** Runs and removes every recorded job in order. Returns how many ran. */
  async drain(run: (data: BreakdownJobData) => Promise<void>): Promise<number> {
    let ran = 0;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) break;
      await run(job);
      ran += 1;
    }
    return ran;
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/agent && npx vitest run --project integration tests/jobs`
Expected:

```
 ✓ src/agent/fake-model.test.ts (3 tests)
 ✓ tests/jobs/queue.test.ts (2 tests)
```

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/lib/redis.ts src/jobs/queue.ts src/agent tests/helpers/fake-queue.ts tests/jobs/queue.test.ts
git commit -F - <<'MSG'
feat: bullmq breakdown queue, model seam, fake model and fake queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 10: Authentication, the real app dependencies, and the test harness

**Files:**
- Create: `src/lib/auth.ts`, `src/repositories/users.ts`, `src/services/auth.ts`, `src/routes/auth.ts`, `tests/helpers/app.ts`, `tests/helpers/auth.ts`
- Modify: `src/app.ts`, `src/types/express.d.ts`
- Delete: `src/app.test.ts` (its cases move to `tests/api/health.test.ts`)
- Test: `tests/api/auth.test.ts`, `tests/api/health.test.ts`

**Interfaces:**
- Consumes: Task 8 `createDb`, `Db`, `isUniqueViolation`, `users`, `UserRow`; Task 9 `BreakdownQueue`, `BreakdownModel`, `FakeQueue`, `FakeBreakdownModel`, `createRedis`; Task 4 `RegisterBody`, `LoginBody`, `User`; Task 3 `validate`, `validated`, `HealthProbes`; Task 2 envelope and errors.
- Produces:
  - `src/lib/auth.ts`: `ACCESS_TOKEN_TTL = "15m"`, `REFRESH_TTL_SECONDS`, `REFRESH_COOKIE = "kaizen_refresh"`, `REFRESH_COOKIE_PATH = "/api/v1/auth"`, `BCRYPT_COST = 10`, `interface AuthUser { id: string; email: string }`, `signAccessToken(user, secret)`, `verifyAccessToken(token, secret)`, `newRefreshToken()`, `refreshKey(token)`, `setRefreshCookie(res, config, token)`, `clearRefreshCookie(res, config)`, `cookieValue(req, name)`, `hashPassword(pw)`, `verifyPassword(pw, hash)`, `requireAuth(config): RequestHandler` (sets `req.user`), `currentUser(req): AuthUser`.
  - `src/repositories/users.ts`: `insertUser(db, { email, passwordHash, displayName })`, `findUserByEmail(db, email)`, `findUserById(db, id)`.
  - `src/services/auth.ts`: `createAuthService({ db, redis, config }): AuthService` with `register`, `login`, `refresh`, `logout`, `me`; `toUser(row): User`.
  - `src/routes/auth.ts`: `authRouter(service, config): Router` mounted at `/api/v1/auth`.
  - `src/app.ts`: `interface AppDeps { config; db: Db; redis: Redis; queue: BreakdownQueue; model: BreakdownModel; logger: Logger; probes?: Partial<HealthProbes> }` (spec 7.1 shape; `probes` is a test override).
  - `tests/helpers/app.ts`: `createTestApp(overrides?: Partial<Config>, extra?): Promise<TestContext>` where `TestContext = { app, config, db, sql, redis, queue: FakeQueue, model: FakeBreakdownModel, close() }`.
  - `tests/helpers/auth.ts`: `registerUser(app, overrides?): Promise<TestUser>` with `{ token, userId, email, cookie }`, `refreshCookieFrom(res)`, `auth(token)` header object.

- [ ] **Step 1: Write the failing tests**

`tests/api/health.test.ts`:

```ts
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp({ RAILWAY_GIT_COMMIT_SHA: "abc123" });
});
afterAll(() => ctx.close());

describe("GET /api/v1/health", () => {
  it("reports the commit SHA, env, passing checks against real Postgres and Redis, and features", async () => {
    const res = await request(ctx.app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        status: "ok",
        commit: "abc123",
        env: "test",
        checks: { db: "ok", redis: "ok" },
        features: { featureRequests: false },
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("reports features.featureRequests true when GITHUB_TOKEN and GITHUB_REPO are set", async () => {
    const configured = await createTestApp({
      GITHUB_TOKEN: "ghp_test_token",
      GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line",
    });
    try {
      const res = await request(configured.app).get("/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.data.features).toEqual({ featureRequests: true });
    } finally {
      await configured.close();
    }
  });

  it("returns 503 UNAVAILABLE naming the failing check", async () => {
    const broken = await createTestApp({}, {
      probes: {
        redis: async () => {
          throw new Error("down");
        },
      },
    });
    try {
      const res = await request(broken.app).get("/api/v1/health");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("UNAVAILABLE");
      expect(res.body.error.message).toBe("Health check failed: redis");
    } finally {
      await broken.close();
    }
  });

  it("serves the committed openapi.json", async () => {
    const res = await request(ctx.app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/api/v1/tasks"]).toBeDefined();
  });

  it("carries the inbound request id in the error envelope", async () => {
    const res = await request(ctx.app).get("/api/v1/nothing").set("x-request-id", "trace-me");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Route GET /api/v1/nothing not found",
      requestId: "trace-me",
    });
    expect(res.headers["x-request-id"]).toBe("trace-me");
  });
});
```

`tests/api/auth.test.ts`:

```ts
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, refreshCookieFrom, registerUser } from "../helpers/auth.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const REGISTER = "/api/v1/auth/register";
const LOGIN = "/api/v1/auth/login";
const REFRESH = "/api/v1/auth/refresh";
const LOGOUT = "/api/v1/auth/logout";
const ME = "/api/v1/auth/me";

describe("register", () => {
  it("creates the user, returns an access token and sets the refresh cookie", async () => {
    const res = await request(ctx.app)
      .post(REGISTER)
      .send({ email: "Ada@Example.com", password: "password123", displayName: "Ada" });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({
      id: expect.any(String),
      email: "ada@example.com",
      displayName: "Ada",
      createdAt: expect.any(String),
    });
    expect(res.body.data.accessToken.split(".")).toHaveLength(3);
    const cookie = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Secure");
  });

  it("rejects a duplicate email regardless of case with CONFLICT", async () => {
    await registerUser(ctx.app, { email: "dup@example.com" });
    const res = await request(ctx.app)
      .post(REGISTER)
      .send({ email: "DUP@example.com", password: "password123", displayName: "Again" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates the body", async () => {
    const res = await request(ctx.app).post(REGISTER).send({ email: "bad", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      "body.displayName",
      "body.email",
      "body.password",
    ]);
  });
});

describe("login", () => {
  it("returns a session for correct credentials", async () => {
    const user = await registerUser(ctx.app, { email: "login@example.com", password: "password123" });
    const res = await request(ctx.app).post(LOGIN).send({ email: "LOGIN@example.com", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.userId);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookieFrom(res)).toMatch(/^kaizen_refresh=/);
  });

  it("uses one message for wrong password and unknown email", async () => {
    await registerUser(ctx.app, { email: "wp@example.com", password: "password123" });
    const wrong = await request(ctx.app).post(LOGIN).send({ email: "wp@example.com", password: "nope-nope" });
    const unknown = await request(ctx.app).post(LOGIN).send({ email: "ghost@example.com", password: "password123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe("Invalid email or password");
    expect(unknown.body.error.message).toBe("Invalid email or password");
  });
});

describe("refresh", () => {
  it("rotates the cookie and invalidates the old one", async () => {
    const user = await registerUser(ctx.app);
    const first = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toEqual(expect.any(String));
    const rotated = refreshCookieFrom(first);
    expect(rotated).not.toBe(user.cookie);

    const replay = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHORIZED");

    const second = await request(ctx.app).post(REFRESH).set("Cookie", rotated);
    expect(second.status).toBe(200);
  });

  it("returns UNAUTHORIZED without a cookie", async () => {
    const res = await request(ctx.app).post(REFRESH);
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the refresh token and clears the cookie", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app).post(LOGOUT).set("Cookie", user.cookie);
    expect(res.status).toBe(204);
    const cleared = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
    expect(cleared).toMatch(/kaizen_refresh=;/);
    expect(cleared).toContain("Path=/api/v1/auth");
    const after = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(after.status).toBe(401);
  });
});

describe("me", () => {
  it("returns the current user with a valid token and UNAUTHORIZED otherwise", async () => {
    const user = await registerUser(ctx.app, { email: "me@example.com" });
    const ok = await request(ctx.app).get(ME).set(auth(user.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe("me@example.com");
    expect((await request(ctx.app).get(ME)).status).toBe(401);
    expect((await request(ctx.app).get(ME).set(auth("garbage.token.here"))).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project integration tests/api`
Expected: FAIL, `Failed to resolve import "../helpers/app.js"`.

- [ ] **Step 3: Write `src/lib/auth.ts` and extend the Express types**

`src/lib/auth.ts`:

```ts
import { randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { isSecureCookieEnv, type Config } from "../config.js";
import { unauthorized } from "./errors.js";

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_COOKIE = "kaizen_refresh";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
export const BCRYPT_COST = 10;

export interface AuthUser {
  id: string;
  email: string;
}

const secretBytes = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(user: AuthUser, secret: string): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secretBytes(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, secretBytes(secret), { algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw unauthorized("Invalid token");
  }
  return { id: payload.sub, email: payload.email };
}

/** 32 random bytes, base64url. The token itself is the Redis key suffix. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export const refreshKey = (token: string): string => `refresh:${token}`;

function cookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    secure: isSecureCookieEnv(config),
  };
}

export function setRefreshCookie(res: Response, config: Config, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(config), maxAge: REFRESH_TTL_SECONDS * 1000 });
}

export function clearRefreshCookie(res: Response, config: Config): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(config));
}

export function cookieValue(req: Request, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, unknown> }).cookies;
  const value = cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const hashPassword = (password: string): Promise<string> => hash(password, BCRYPT_COST);
export const verifyPassword = (password: string, passwordHash: string): Promise<boolean> =>
  compare(password, passwordHash);

/** Verifies the bearer token and sets req.user. */
export function requireAuth(config: Config): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      next(unauthorized("Missing bearer token"));
      return;
    }
    try {
      req.user = await verifyAccessToken(header.slice("Bearer ".length).trim(), config.JWT_SECRET);
      next();
    } catch {
      next(unauthorized("Invalid or expired token"));
    }
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
```

`src/types/express.d.ts` (replace):

```ts
import type { AuthUser } from "../lib/auth.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
  interface Locals {
    requestId: string;
    validated?: unknown;
  }
}

export {};
```

- [ ] **Step 4: Write `src/repositories/users.ts`**

```ts
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { users, type UserRow } from "../db/schema.js";

export async function insertUser(
  db: DbOrTx,
  values: { email: string; passwordHash: string; displayName: string },
): Promise<UserRow> {
  const [row] = await db.insert(users).values(values).returning();
  if (!row) throw new Error("insert users returned no row");
  return row;
}

export async function findUserByEmail(db: DbOrTx, email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
}

export async function findUserById(db: DbOrTx, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}
```

- [ ] **Step 5: Write `src/services/auth.ts`**

```ts
import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import { isUniqueViolation, type Db } from "../db/client.js";
import type { UserRow } from "../db/schema.js";
import {
  hashPassword,
  newRefreshToken,
  refreshKey,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import { conflict, unauthorized } from "../lib/errors.js";
import { findUserByEmail, findUserById, insertUser } from "../repositories/users.js";
import type { LoginInput, RegisterInput, User } from "../schemas/auth.js";

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<AuthSession>;
  login(input: LoginInput): Promise<AuthSession>;
  refresh(token: string | undefined): Promise<{ accessToken: string; refreshToken: string }>;
  logout(token: string | undefined): Promise<void>;
  me(userId: string): Promise<User>;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}

const INVALID_CREDENTIALS = "Invalid email or password";
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function createAuthService(deps: { db: Db; redis: Redis; config: Config }): AuthService {
  const { db, redis, config } = deps;
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= hashPassword("not-a-real-password"));

  async function issueSession(row: UserRow): Promise<AuthSession> {
    const refreshToken = newRefreshToken();
    await redis.set(refreshKey(refreshToken), row.id, "EX", REFRESH_TTL_SECONDS);
    const accessToken = await signAccessToken({ id: row.id, email: row.email }, config.JWT_SECRET);
    return { user: toUser(row), accessToken, refreshToken };
  }

  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      let row: UserRow;
      try {
        row = await insertUser(db, {
          email: normalizeEmail(input.email),
          passwordHash,
          displayName: input.displayName,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("An account with this email already exists");
        throw err;
      }
      return issueSession(row);
    },

    async login(input) {
      const row = await findUserByEmail(db, normalizeEmail(input.email));
      // Always run bcrypt so a missing user costs the same time as a wrong password.
      const ok = await verifyPassword(input.password, row?.passwordHash ?? (await getDummyHash()));
      if (!row || !ok) throw unauthorized(INVALID_CREDENTIALS);
      return issueSession(row);
    },

    async refresh(token) {
      if (!token) throw unauthorized("Missing refresh token");
      const userId = await redis.get(refreshKey(token));
      if (!userId) throw unauthorized("Unknown refresh token");
      await redis.del(refreshKey(token));
      const row = await findUserById(db, userId);
      if (!row) throw unauthorized("Unknown user");
      const session = await issueSession(row);
      return { accessToken: session.accessToken, refreshToken: session.refreshToken };
    },

    async logout(token) {
      if (token) await redis.del(refreshKey(token));
    },

    async me(userId) {
      const row = await findUserById(db, userId);
      if (!row) throw unauthorized("Unknown user");
      return toUser(row);
    },
  };
}
```

- [ ] **Step 6: Write `src/routes/auth.ts`**

```ts
import { Router } from "express";
import type { Config } from "../config.js";
import {
  clearRefreshCookie,
  cookieValue,
  currentUser,
  REFRESH_COOKIE,
  requireAuth,
  setRefreshCookie,
} from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { LoginBody, RegisterBody } from "../schemas/auth.js";
import type { AuthService } from "../services/auth.js";
import { validate, validated } from "./validate.js";

const registerSchemas = { body: RegisterBody };
const loginSchemas = { body: LoginBody };

export function authRouter(service: AuthService, config: Config): Router {
  const router = Router();

  router.post("/register", validate(registerSchemas), async (_req, res) => {
    const { body } = validated<typeof registerSchemas>(res);
    const session = await service.register(body);
    setRefreshCookie(res, config, session.refreshToken);
    sendData(res, { user: session.user, accessToken: session.accessToken }, { status: 201 });
  });

  router.post("/login", validate(loginSchemas), async (_req, res) => {
    const { body } = validated<typeof loginSchemas>(res);
    const session = await service.login(body);
    setRefreshCookie(res, config, session.refreshToken);
    sendData(res, { user: session.user, accessToken: session.accessToken });
  });

  router.post("/refresh", async (req, res) => {
    const result = await service.refresh(cookieValue(req, REFRESH_COOKIE));
    setRefreshCookie(res, config, result.refreshToken);
    sendData(res, { accessToken: result.accessToken });
  });

  router.post("/logout", async (req, res) => {
    await service.logout(cookieValue(req, REFRESH_COOKIE));
    clearRefreshCookie(res, config);
    sendNoContent(res);
  });

  router.get("/me", requireAuth(config), async (req, res) => {
    sendData(res, { user: await service.me(currentUser(req).id) });
  });

  return router;
}
```

- [ ] **Step 7: Widen `src/app.ts` to the spec's dependencies**

Replace the file:

```ts
import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import { sql } from "drizzle-orm";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { BreakdownModel } from "./agent/model.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { BreakdownQueue } from "./jobs/queue.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { createHttpLogger, type Logger } from "./lib/logger.js";
import { requestId } from "./lib/request-id.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter, type HealthFeatures, type HealthProbes } from "./routes/health.js";
import { openapiRouter } from "./routes/openapi.js";
import { createAuthService } from "./services/auth.js";

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  queue: BreakdownQueue;
  model: BreakdownModel;
  logger: Logger;
  /** Test override for the health probes. Defaults to `select 1` and `PING`. */
  probes?: Partial<HealthProbes>;
}

export const JSON_BODY_LIMIT = "64kb";

/**
 * Defined exactly when GITHUB_TOKEN and GITHUB_REPO are both set. The feature-requests route is
 * mounted on this same value, so health's `features.featureRequests` and the mount never disagree.
 */
export function featureRequestsConfigOf(config: Config): { token: string; repo: string } | undefined {
  return config.GITHUB_TOKEN && config.GITHUB_REPO
    ? { token: config.GITHUB_TOKEN, repo: config.GITHUB_REPO }
    : undefined;
}

export function createApp(deps: AppDeps): Express {
  const { config, db, redis, logger } = deps;
  const probes: HealthProbes = {
    db: async () => {
      await db.execute(sql`select 1`);
    },
    redis: async () => {
      await redis.ping();
    },
    ...deps.probes,
  };
  const featureRequestsConfig = featureRequestsConfigOf(config);
  const features: HealthFeatures = { featureRequests: featureRequestsConfig !== undefined };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(requestId());
  app.use(createHttpLogger(logger));

  const api = Router();
  api.use(healthRouter(config, probes, features));
  api.use(openapiRouter(resolve(process.cwd(), "openapi.json")));
  api.use("/auth", authRouter(createAuthService({ db, redis, config }), config));
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal: config.APP_ENV === "development", logger }));
  return app;
}
```

Update the provisional `src/server.ts` from Task 6 so it compiles against the new `AppDeps`: replace the `postgres(...)` client with `createDb`, and pass `queue` and `model`:

```ts
import { existsSync } from "node:fs";
import { FakeBreakdownModel } from "./agent/fake-model.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createBreakdownQueue } from "./jobs/queue.js";
import { createLogger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.ping();
  const queue = createBreakdownQueue(createRedis(config.REDIS_URL));

  const app = createApp({ config, db, redis, queue, model: new FakeBreakdownModel(), logger });

  const server = app.listen(config.PORT, "::", () => {
    logger.info({ port: config.PORT, env: config.APP_ENV }, "api listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.all([queue.close(), redis.quit(), sql.end()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

Delete `src/app.test.ts`: `git rm src/app.test.ts`.

- [ ] **Step 8: Write the test helpers**

`tests/helpers/app.ts`:

```ts
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { FakeBreakdownModel } from "../../src/agent/fake-model.js";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type Db } from "../../src/db/client.js";
import { createLogger } from "../../src/lib/logger.js";
import { createRedis } from "../../src/lib/redis.js";
import { FakeQueue } from "./fake-queue.js";

export interface TestContext {
  app: Express;
  config: Config;
  db: Db;
  sql: Sql;
  redis: Redis;
  queue: FakeQueue;
  model: FakeBreakdownModel;
  close(): Promise<void>;
}

type ExtraDeps = Partial<Omit<AppDeps, "config" | "db" | "redis" | "queue" | "model" | "logger">>;

/** A full app over the real test database and Redis, with a fake queue and a fake model. */
export async function createTestApp(
  overrides: Partial<Config> = {},
  extra: ExtraDeps = {},
): Promise<TestContext> {
  const config: Config = { ...loadConfig(process.env), ...overrides };
  const { db, sql } = createDb(config.DATABASE_URL, { max: 2 });
  const redis = createRedis(config.REDIS_URL);
  const queue = new FakeQueue();
  const model = new FakeBreakdownModel();
  const app = createApp({ config, db, redis, queue, model, logger: createLogger("silent"), ...extra });
  return {
    app,
    config,
    db,
    sql,
    redis,
    queue,
    model,
    close: async () => {
      await redis.quit();
      await sql.end();
    },
  };
}
```

`tests/helpers/auth.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request, { type Response } from "supertest";

export interface TestUser {
  token: string;
  userId: string;
  email: string;
  cookie: string;
}

export function refreshCookieFrom(res: Response): string {
  const found = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
  if (!found) throw new Error("no kaizen_refresh cookie in response");
  return found.split(";")[0] ?? "";
}

export async function registerUser(
  app: Express,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<TestUser> {
  const email = overrides.email ?? `user-${randomUUID()}@test.local`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({
      email,
      password: overrides.password ?? "password123",
      displayName: overrides.displayName ?? "Test User",
    });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.data.accessToken as string,
    userId: res.body.data.user.id as string,
    email: (res.body.data.user.email as string) ?? email,
    cookie: refreshCookieFrom(res),
  };
}

export const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/api`
Expected:

```
 ✓ tests/api/health.test.ts (5 tests)
 ✓ tests/api/auth.test.ts (9 tests)
 Test Files  2 passed (2)
      Tests  14 passed (14)
```

- [ ] **Step 10: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all unit and integration tests pass; tsc and eslint exit 0.

```bash
git add src/lib/auth.ts src/types/express.d.ts src/repositories/users.ts src/services/auth.ts src/routes/auth.ts src/app.ts src/server.ts tests/helpers tests/api
git rm --quiet src/app.test.ts
git commit -F - <<'MSG'
feat: registration, login, refresh rotation, logout and me

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 11: AI rate limiter

**Files:**
- Create: `src/lib/rate-limit.ts`
- Test: `tests/lib/rate-limit.test.ts`

**Interfaces:**
- Consumes: Task 1 `Config`; Task 9 `createRedis`.
- Produces: `hourBucket(now: Date): string` (`YYYYMMDDHH` UTC), `nextHourIso(now: Date): string`, `interface ConsumeResult { allowed: boolean; reason: "ok" | "ai_disabled" | "rate_limited"; scope: "user" | "global"; limit: number; remaining: number; resetAt: string }`, `interface RateLimiter { consume(userId: string): Promise<ConsumeResult> }`, `createRateLimiter(redis, config, now?): RateLimiter`. Redis keys `ratelimit:breakdown:<userId>:<bucket>` and `ratelimit:breakdown:global:<bucket>` with a one-hour TTL.

- [ ] **Step 1: Write the failing test**

`tests/lib/rate-limit.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRateLimiter, hourBucket, nextHourIso } from "../../src/lib/rate-limit.js";
import { createRedis } from "../../src/lib/redis.js";

let redis: Redis;
beforeAll(() => {
  redis = createRedis(process.env.REDIS_URL ?? "");
});
afterAll(() => redis.quit());

const NOW = new Date("2026-09-08T10:17:00.000Z");
const limiter = (user: number, global: number, enabled = true) =>
  createRateLimiter(
    redis,
    { AI_ENABLED: enabled, AI_RATE_LIMIT_PER_HOUR: user, AI_GLOBAL_LIMIT_PER_HOUR: global },
    () => NOW,
  );

describe("hour helpers", () => {
  it("buckets by UTC hour and resets at the next hour", () => {
    expect(hourBucket(NOW)).toBe("2026090810");
    expect(nextHourIso(NOW)).toBe("2026-09-08T11:00:00.000Z");
  });
});

describe("consume", () => {
  it("allows up to the user limit, then denies with scope user and the reset time", async () => {
    const userId = randomUUID();
    const rl = limiter(2, 100);
    const first = await rl.consume(userId);
    expect(first).toEqual({ allowed: true, reason: "ok", scope: "user", limit: 2, remaining: 1, resetAt: "2026-09-08T11:00:00.000Z" });
    expect((await rl.consume(userId)).remaining).toBe(0);
    const denied = await rl.consume(userId);
    expect(denied).toEqual({ allowed: false, reason: "rate_limited", scope: "user", limit: 2, remaining: 0, resetAt: "2026-09-08T11:00:00.000Z" });
    // a denial does not count: the key stays at the limit
    expect(await redis.get(`ratelimit:breakdown:${userId}:2026090810`)).toBe("2");
    expect(await redis.get("ratelimit:breakdown:global:2026090810")).toBe("2");
  });

  it("denies with scope global past the environment budget and undoes both increments", async () => {
    const rl = limiter(10, 3);
    const a = randomUUID();
    const b = randomUUID();
    await rl.consume(a);
    await rl.consume(a);
    await rl.consume(b);
    const denied = await rl.consume(b);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("rate_limited");
    expect(denied.scope).toBe("global");
    expect(denied.limit).toBe(3);
    expect(await redis.get("ratelimit:breakdown:global:2026090810")).toBe("3");
    expect(await redis.get(`ratelimit:breakdown:${b}:2026090810`)).toBe("1");
  });

  it("reports ai_disabled without touching Redis when AI_ENABLED is false", async () => {
    const userId = randomUUID();
    const result = await limiter(10, 10, false).consume(userId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ai_disabled");
    expect(await redis.keys("ratelimit:*")).toEqual([]);
  });

  it("sets a one-hour TTL on new keys", async () => {
    const userId = randomUUID();
    await limiter(5, 5).consume(userId);
    const ttl = await redis.ttl(`ratelimit:breakdown:${userId}:2026090810`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/lib`
Expected: FAIL, `Failed to resolve import "../../src/lib/rate-limit.js"`.

- [ ] **Step 3: Write `src/lib/rate-limit.ts`**

```ts
import type { Redis } from "ioredis";
import type { Config } from "../config.js";

export type RateLimitConfig = Pick<
  Config,
  "AI_ENABLED" | "AI_RATE_LIMIT_PER_HOUR" | "AI_GLOBAL_LIMIT_PER_HOUR"
>;

export interface ConsumeResult {
  allowed: boolean;
  reason: "ok" | "ai_disabled" | "rate_limited";
  scope: "user" | "global";
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface RateLimiter {
  consume(userId: string): Promise<ConsumeResult>;
}

const WINDOW_SECONDS = 3600;

export function hourBucket(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}

export function nextHourIso(now: Date): string {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

async function incrWithTtl(redis: Redis, key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  return count;
}

/**
 * Checks AI_ENABLED, then the per-user hourly counter, then the global hourly counter.
 * A denial on either scope decrements what it incremented.
 */
export function createRateLimiter(
  redis: Redis,
  config: RateLimitConfig,
  now: () => Date = () => new Date(),
): RateLimiter {
  return {
    async consume(userId) {
      const at = now();
      const resetAt = nextHourIso(at);
      if (!config.AI_ENABLED) {
        return { allowed: false, reason: "ai_disabled", scope: "global", limit: 0, remaining: 0, resetAt };
      }
      const bucket = hourBucket(at);
      const userKey = `ratelimit:breakdown:${userId}:${bucket}`;
      const globalKey = `ratelimit:breakdown:global:${bucket}`;

      const userCount = await incrWithTtl(redis, userKey);
      if (userCount > config.AI_RATE_LIMIT_PER_HOUR) {
        await redis.decr(userKey);
        return {
          allowed: false,
          reason: "rate_limited",
          scope: "user",
          limit: config.AI_RATE_LIMIT_PER_HOUR,
          remaining: 0,
          resetAt,
        };
      }

      const globalCount = await incrWithTtl(redis, globalKey);
      if (globalCount > config.AI_GLOBAL_LIMIT_PER_HOUR) {
        await redis.decr(globalKey);
        await redis.decr(userKey);
        return {
          allowed: false,
          reason: "rate_limited",
          scope: "global",
          limit: config.AI_GLOBAL_LIMIT_PER_HOUR,
          remaining: 0,
          resetAt,
        };
      }

      return {
        allowed: true,
        reason: "ok",
        scope: "user",
        limit: config.AI_RATE_LIMIT_PER_HOUR,
        remaining: config.AI_RATE_LIMIT_PER_HOUR - userCount,
        resetAt,
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/lib`
Expected:

```
 ✓ tests/lib/rate-limit.test.ts (5 tests)
```

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/lib/rate-limit.ts tests/lib/rate-limit.test.ts
git commit -F - <<'MSG'
feat: hourly AI rate limiter with user and global scopes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 12: Tags

**Files:**
- Create: `src/repositories/tags.ts`, `src/services/tags.ts`, `src/routes/tags.ts`
- Modify: `src/app.ts`
- Test: `tests/api/tags.test.ts`

**Interfaces:**
- Consumes: Task 8 `tags`, `taskTags`, `TagRow`, `DbOrTx`, `isUniqueViolation`; Task 4 `TagSchema` types, `CreateTagBody`, `UpdateTagBody`, `IdParams`; Task 10 `requireAuth`, `currentUser`.
- Produces:
  - repository: `listTags(db, userId)`, `findTag(db, id, userId)`, `insertTag(db, { userId, name, color })`, `updateTag(db, id, userId, patch)`, `deleteTag(db, id, userId): Promise<boolean>`, `findOwnedTags(db, userId, ids)`, `tagsForTasks(db, taskIds): Promise<Map<string, TagRow[]>>`, `replaceTaskTags(db, taskId, tagIds)`.
  - service: `createTagsService({ db }): TagsService` with `list`, `create`, `update`, `remove`; `toTag(row): Tag`.
  - route: `tagsRouter(service): Router` mounted at `/api/v1/tags` behind `requireAuth`.

- [ ] **Step 1: Write the failing test**

`tests/api/tags.test.ts`:

```ts
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskTags, tasks } from "../../src/db/schema.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TAGS = "/api/v1/tags";

async function createTag(user: TestUser, name: string, color = "#2563EB") {
  const res = await request(ctx.app).post(TAGS).set(auth(user.token)).send({ name, color });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string; color: string; createdAt: string };
}

describe("tags", () => {
  it("requires authentication", async () => {
    expect((await request(ctx.app).get(TAGS)).status).toBe(401);
  });

  it("creates a tag with a lowercased color and lists tags ordered by name", async () => {
    const user = await registerUser(ctx.app);
    const work = await createTag(user, "Work");
    expect(work).toEqual({ id: expect.any(String), name: "Work", color: "#2563eb", createdAt: expect.any(String) });
    await createTag(user, "alpha");
    await createTag(user, "Zed");
    const res = await request(ctx.app).get(TAGS).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(["alpha", "Work", "Zed"]);
    expect(res.body.meta).toEqual({ requestId: expect.any(String) });
  });

  it("rejects duplicate names case-insensitively with CONFLICT", async () => {
    const user = await registerUser(ctx.app);
    await createTag(user, "Work");
    const res = await request(ctx.app).post(TAGS).set(auth(user.token)).send({ name: "work", color: "#000000" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates name and color", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app).post(TAGS).set(auth(user.token)).send({ name: "", color: "blue" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["body.color", "body.name"]);
  });

  it("updates name and color, rejects an empty patch, and hides other users' tags", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const tag = await createTag(owner, "Draft");
    const ok = await request(ctx.app).patch(`${TAGS}/${tag.id}`).set(auth(owner.token)).send({ name: "Final", color: "#16A34A" });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: tag.id, name: "Final", color: "#16a34a" });
    const empty = await request(ctx.app).patch(`${TAGS}/${tag.id}`).set(auth(owner.token)).send({});
    expect(empty.status).toBe(400);
    const foreign = await request(ctx.app).patch(`${TAGS}/${tag.id}`).set(auth(other.token)).send({ name: "Mine" });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes a tag, its links, and returns NOT_FOUND for foreign or missing ids", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const tag = await createTag(owner, "Linked");
    const [task] = await ctx.db.insert(tasks).values({ userId: owner.userId, title: "Has a tag" }).returning();
    await ctx.db.insert(taskTags).values({ taskId: task!.id, tagId: tag.id });

    expect((await request(ctx.app).delete(`${TAGS}/${tag.id}`).set(auth(other.token))).status).toBe(404);
    const res = await request(ctx.app).delete(`${TAGS}/${tag.id}`).set(auth(owner.token));
    expect(res.status).toBe(204);
    expect(await ctx.db.select().from(taskTags)).toEqual([]);
    expect((await request(ctx.app).delete(`${TAGS}/${tag.id}`).set(auth(owner.token))).status).toBe(404);
    const list = await request(ctx.app).get(TAGS).set(auth(owner.token));
    expect(list.body.data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/api/tags.test.ts`
Expected: FAIL; the first assertion that runs against a real route gets `404` (no `/tags` router yet) instead of `401`/`201`.

- [ ] **Step 3: Write `src/repositories/tags.ts`**

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tags, taskTags, type TagRow } from "../db/schema.js";

const byName = [asc(sql`lower(${tags.name})`), asc(tags.id)];

export async function listTags(db: DbOrTx, userId: string): Promise<TagRow[]> {
  return db.select().from(tags).where(eq(tags.userId, userId)).orderBy(...byName);
}

export async function findTag(db: DbOrTx, id: string, userId: string): Promise<TagRow | undefined> {
  const [row] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .limit(1);
  return row;
}

export async function insertTag(
  db: DbOrTx,
  values: { userId: string; name: string; color: string },
): Promise<TagRow> {
  const [row] = await db.insert(tags).values(values).returning();
  if (!row) throw new Error("insert tags returned no row");
  return row;
}

export async function updateTag(
  db: DbOrTx,
  id: string,
  userId: string,
  patch: { name?: string; color?: string },
): Promise<TagRow | undefined> {
  const [row] = await db
    .update(tags)
    .set(patch)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning();
  return row;
}

export async function deleteTag(db: DbOrTx, id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

export async function findOwnedTags(db: DbOrTx, userId: string, ids: string[]): Promise<TagRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, ids)));
}

/** Tags per task id for a set of tasks, each list ordered by name. */
export async function tagsForTasks(db: DbOrTx, taskIds: string[]): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select({ taskId: taskTags.taskId, tag: tags })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(...byName);
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push(row.tag);
    map.set(row.taskId, list);
  }
  return map;
}

export async function replaceTaskTags(db: DbOrTx, taskId: string, tagIds: string[]): Promise<void> {
  await db.delete(taskTags).where(eq(taskTags.taskId, taskId));
  if (tagIds.length > 0) {
    await db.insert(taskTags).values(tagIds.map((tagId) => ({ taskId, tagId })));
  }
}
```

- [ ] **Step 4: Write `src/services/tags.ts`**

```ts
import { isUniqueViolation, type Db } from "../db/client.js";
import type { TagRow } from "../db/schema.js";
import { conflict, notFound } from "../lib/errors.js";
import { deleteTag, findTag, insertTag, listTags, updateTag } from "../repositories/tags.js";
import type { CreateTagInput, Tag, UpdateTagInput } from "../schemas/tags.js";

export interface TagsService {
  list(userId: string): Promise<Tag[]>;
  create(userId: string, input: CreateTagInput): Promise<Tag>;
  update(userId: string, id: string, input: UpdateTagInput): Promise<Tag>;
  remove(userId: string, id: string): Promise<void>;
}

export function toTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt.toISOString() };
}

const duplicate = (name: string) => conflict(`A tag named "${name}" already exists`);

export function createTagsService(deps: { db: Db }): TagsService {
  const { db } = deps;
  return {
    async list(userId) {
      return (await listTags(db, userId)).map(toTag);
    },

    async create(userId, input) {
      try {
        const row = await insertTag(db, { userId, name: input.name, color: input.color.toLowerCase() });
        return toTag(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate(input.name);
        throw err;
      }
    },

    async update(userId, id, input) {
      const existing = await findTag(db, id, userId);
      if (!existing) throw notFound("Tag not found");
      const patch: { name?: string; color?: string } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color.toLowerCase();
      try {
        const row = await updateTag(db, id, userId, patch);
        if (!row) throw notFound("Tag not found");
        return toTag(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicate(input.name ?? existing.name);
        throw err;
      }
    },

    async remove(userId, id) {
      const deleted = await deleteTag(db, id, userId);
      if (!deleted) throw notFound("Tag not found");
    },
  };
}
```

- [ ] **Step 5: Write `src/routes/tags.ts` and mount it**

`src/routes/tags.ts`:

```ts
import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { IdParams } from "../schemas/common.js";
import { CreateTagBody, UpdateTagBody } from "../schemas/tags.js";
import type { TagsService } from "../services/tags.js";
import { validate, validated } from "./validate.js";

const createSchemas = { body: CreateTagBody };
const updateSchemas = { params: IdParams, body: UpdateTagBody };
const idSchemas = { params: IdParams };

export function tagsRouter(service: TagsService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    sendData(res, await service.list(currentUser(req).id));
  });

  router.post("/", validate(createSchemas), async (req, res) => {
    const { body } = validated<typeof createSchemas>(res);
    sendData(res, await service.create(currentUser(req).id, body), { status: 201 });
  });

  router.patch("/:id", validate(updateSchemas), async (req, res) => {
    const { params, body } = validated<typeof updateSchemas>(res);
    sendData(res, await service.update(currentUser(req).id, params.id, body));
  });

  router.delete("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    await service.remove(currentUser(req).id, params.id);
    sendNoContent(res);
  });

  return router;
}
```

In `src/app.ts` add the imports and mount the router after `/auth`:

```ts
import { requireAuth } from "./lib/auth.js";
import { tagsRouter } from "./routes/tags.js";
import { createTagsService } from "./services/tags.js";
```

```ts
  api.use("/tags", requireAuth(config), tagsRouter(createTagsService({ db })));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/api/tags.test.ts`
Expected:

```
 ✓ tests/api/tags.test.ts (6 tests)
```

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/repositories/tags.ts src/services/tags.ts src/routes/tags.ts src/app.ts tests/api/tags.test.ts
git commit -F - <<'MSG'
feat: tag CRUD with case-insensitive uniqueness per user

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 13: Tasks: create, get, list, delete

**Files:**
- Create: `src/repositories/tasks.ts`, `src/services/tasks.ts`, `src/routes/tasks.ts`
- Modify: `src/app.ts`
- Test: `tests/api/tasks.test.ts`, `tests/db/progress.test.ts`, `tests/helpers/tasks.ts` (helper)

**Interfaces:**
- Consumes: Task 8 `tasks`, `taskTags`, `TaskRow`, `NewTaskRow`; Task 12 `tagsForTasks`, `findOwnedTags`, `replaceTaskTags`, `toTag`; Task 11 `RateLimiter`, `createRateLimiter`; Task 9 `BreakdownQueue`; Task 3 `encodeCursor`, `decodeCursor`; Task 4 task schemas and types.
- Produces:
  - repository (`src/repositories/tasks.ts`): `findOwnedTask(db, id, userId)`, `insertTask(db, values: NewTaskRow)`, `deleteTask(db, id, userId): Promise<boolean>`, `maxSiblingPosition(db, userId, parentId: string | null): Promise<number>` (-1 when none), `siblingScope(userId, parentId)`, `siblingOrder`, `listTasks(db, opts: ListTasksOptions): Promise<TaskRow[]>` (fetches `limit + 1`), `listChildren(db, parentId)`, `childAggregates(db, taskIds): Promise<ChildAggregateMap>` (one SQL aggregate per parent: progress `done`/`total` and `suggestionCount`), `updateAiState(db, id, generationId, patch: AiStatePatch): Promise<number>` (guarded by `generation_id`), types `ListTasksOptions`, `ChildAggregate`, `ChildAggregateMap`, `AiStatePatch`.
  - service (`src/services/tasks.ts`): `MAX_TASK_DEPTH = 2`, `DEPTH_MESSAGE`, `ENQUEUE_FAILED_MESSAGE = "Could not queue the assistant, try again"`, `toTaskSummary(row, tags, children: ChildAggregate): TaskSummary` (sets `progress`, `suggestionCount` and `aiError`, the master plan's section 4 summary fields), `loadTaskDetail(db, id, userId): Promise<TaskDetail>`, `assertOwnedTagIds(db, userId, tagIds)`, `createTasksService({ db, queue, rateLimiter, logger }): TasksService` with `list`, `create`, `get`, `remove` (Task 14 adds `update`, `acceptAll`, `dismissAll`, `replaceTags`; Task 16 adds `breakdown`).
  - route: `tasksRouter(service): Router` at `/api/v1/tasks` behind `requireAuth`.
  - test helper: `createTask(app, token, body): Promise<TaskDetail>`.
- The spec's unit item "progress aggregation" is implemented as a repository test (`tests/db/progress.test.ts`) because spec section 6 requires the aggregate in SQL, not JavaScript. The same aggregate computes `suggestionCount` (master plan section 4) as a filtered count alongside progress.

- [ ] **Step 1: Write the test helper and the failing tests**

`tests/helpers/tasks.ts`:

```ts
import type { Express } from "express";
import request from "supertest";
import type { TaskDetail } from "../../src/schemas/tasks.js";
import { auth } from "./auth.js";

export async function createTask(
  app: Express,
  token: string,
  body: { title: string; description?: string; parentId?: string; tagIds?: string[] },
): Promise<TaskDetail> {
  const res = await request(app).post("/api/v1/tasks").set(auth(token)).send(body);
  if (res.status !== 201) {
    throw new Error(`create task failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as TaskDetail;
}
```

`tests/db/progress.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { tasks, users } from "../../src/db/schema.js";
import { childAggregates } from "../../src/repositories/tasks.js";

let db: Db;
let end: () => Promise<void>;
beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

describe("childAggregates", () => {
  it("counts user children and accepted AI children (done is the done subset) and suggested AI children", async () => {
    const [u] = await db.insert(users).values({ email: `${randomUUID()}@t.local`, passwordHash: "x", displayName: "P" }).returning();
    const [root] = await db.insert(tasks).values({ userId: u!.id, title: "root" }).returning();
    const [empty] = await db.insert(tasks).values({ userId: u!.id, title: "empty" }).returning();
    const child = (extra: Partial<typeof tasks.$inferInsert>) => ({
      userId: u!.id,
      parentId: root!.id,
      title: "c",
      aiStatus: "skipped" as const,
      ...extra,
    });
    await db.insert(tasks).values([
      child({ origin: "user", status: "done" }),
      child({ origin: "user", status: "todo" }),
      child({ origin: "ai", suggestionState: "accepted", status: "done" }),
      child({ origin: "ai", suggestionState: "accepted", status: "in_progress" }),
      child({ origin: "ai", suggestionState: "suggested", status: "done" }),
      child({ origin: "ai", suggestionState: "dismissed", status: "done" }),
    ]);
    const aggregates = await childAggregates(db, [root!.id, empty!.id]);
    expect(aggregates.get(root!.id)).toEqual({ done: 2, total: 4, suggestionCount: 1 });
    expect(aggregates.get(empty!.id)).toBeUndefined();
    expect(await childAggregates(db, [])).toEqual(new Map());
  });
});
```

`tests/api/tasks.test.ts`:

```ts
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskTags, tasks } from "../../src/db/schema.js";
import { DEPTH_MESSAGE, ENQUEUE_FAILED_MESSAGE } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";
const UUID = /^[0-9a-f-]{36}$/;

describe("POST /tasks", () => {
  it("root create enqueues a breakdown with reason create and returns pending with a generation id", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Plan the team offsite", description: "Three days" });
    expect(task).toMatchObject({
      parentId: null,
      title: "Plan the team offsite",
      description: "Three days",
      status: "todo",
      aiStatus: "pending",
      aiSkipReason: null,
      position: 0,
      origin: "user",
      suggestionState: null,
      rationale: null,
      tags: [],
      progress: { done: 0, total: 0 },
      suggestionCount: 0,
      children: [],
      aiTagSuggestions: [],
      aiError: null,
    });
    expect(ctx.queue.jobs).toHaveLength(1);
    const job = ctx.queue.jobs[0]!;
    expect(job).toEqual({ taskId: task.id, userId: user.userId, generationId: expect.stringMatching(UUID), reason: "create" });
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.generationId).toBe(job.generationId);
  });

  it("returns 201 with aiStatus failed when the queue is unavailable", async () => {
    const user = await registerUser(ctx.app);
    ctx.queue.failNext = true;
    const task = await createTask(ctx.app, user.token, { title: "Queue is down today" });
    expect(task.aiStatus).toBe("failed");
    expect(task.aiError).toBe(ENQUEUE_FAILED_MESSAGE);
    expect(ctx.queue.jobs).toHaveLength(0);
  });

  it("creates a child under a root with aiStatus skipped and no job; a grandchild fails with the depth message", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root task here" });
    ctx.queue.jobs.length = 0;
    const child = await createTask(ctx.app, user.token, { title: "First step", parentId: root.id });
    expect(child.parentId).toBe(root.id);
    expect(child.aiStatus).toBe("skipped");
    expect(child.aiSkipReason).toBeNull();
    expect(child.position).toBe(0);
    expect(ctx.queue.jobs).toHaveLength(0);

    const grandchild = await request(ctx.app).post(TASKS).set(auth(user.token)).send({ title: "Too deep", parentId: child.id });
    expect(grandchild.status).toBe(400);
    expect(grandchild.body.error.code).toBe("VALIDATION_ERROR");
    expect(grandchild.body.error.details).toEqual([{ path: "body.parentId", message: DEPTH_MESSAGE }]);
  });

  it("assigns child positions after the current maximum", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Ordered steps" });
    const a = await createTask(ctx.app, user.token, { title: "A", parentId: root.id });
    const b = await createTask(ctx.app, user.token, { title: "B", parentId: root.id });
    expect([a.position, b.position]).toEqual([0, 1]);
  });

  it("rejects a foreign parent with NOT_FOUND and foreign tag ids with VALIDATION_ERROR", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Owner root" });
    const foreignParent = await request(ctx.app).post(TASKS).set(auth(other.token)).send({ title: "Sneaky", parentId: root.id });
    expect(foreignParent.status).toBe(404);

    const tag = await request(ctx.app).post("/api/v1/tags").set(auth(owner.token)).send({ name: "work", color: "#111111" });
    const foreignTag = await request(ctx.app).post(TASKS).set(auth(other.token)).send({ title: "Sneaky tag", tagIds: [tag.body.data.id] });
    expect(foreignTag.status).toBe(400);
    expect(foreignTag.body.error.details).toEqual([{ path: "body.tagIds", message: `Unknown tag id ${tag.body.data.id}` }]);
  });

  it("attaches owned tags on create", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app).post("/api/v1/tags").set(auth(user.token)).send({ name: "home", color: "#222222" });
    const task = await createTask(ctx.app, user.token, { title: "Tagged task", tagIds: [tag.body.data.id, tag.body.data.id] });
    expect(task.tags).toEqual([{ id: tag.body.data.id, name: "home", color: "#222222", createdAt: expect.any(String) }]);
  });

  it("with AI_ENABLED=false creates the task skipped with reason ai_disabled", async () => {
    const paused = await createTestApp({ AI_ENABLED: false });
    try {
      const user = await registerUser(paused.app);
      const task = await createTask(paused.app, user.token, { title: "Paused assistant" });
      expect(task.aiStatus).toBe("skipped");
      expect(task.aiSkipReason).toBe("ai_disabled");
      expect(paused.queue.jobs).toHaveLength(0);
    } finally {
      await paused.close();
    }
  });

  it("past the user limit still creates the task, skipped with reason rate_limited", async () => {
    const limited = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 1 });
    try {
      const user = await registerUser(limited.app);
      const first = await createTask(limited.app, user.token, { title: "First one counts" });
      const second = await createTask(limited.app, user.token, { title: "Second is limited" });
      expect(first.aiStatus).toBe("pending");
      expect(second.aiStatus).toBe("skipped");
      expect(second.aiSkipReason).toBe("rate_limited");
      expect(limited.queue.jobs).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});

describe("GET /tasks/:id", () => {
  it("returns children, tags and progress computed over user and accepted children", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root with children" });
    const c1 = await createTask(ctx.app, user.token, { title: "Child one", parentId: root.id });
    await createTask(ctx.app, user.token, { title: "Child two", parentId: root.id });
    await ctx.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, c1.id));
    const res = await request(ctx.app).get(`${TASKS}/${root.id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.children.map((c: { title: string }) => c.title)).toEqual(["Child one", "Child two"]);
    expect(res.body.data.progress).toEqual({ done: 1, total: 2 });
  });

  it("returns NOT_FOUND for another user's task and for an unknown id", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Private task" });
    expect((await request(ctx.app).get(`${TASKS}/${root.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(ctx.app).get(`${TASKS}/00000000-0000-4000-8000-000000000000`).set(auth(owner.token))).status).toBe(404);
    expect((await request(ctx.app).get(`${TASKS}/not-a-uuid`).set(auth(owner.token))).status).toBe(400);
  });
});

describe("GET /tasks", () => {
  it("walks three pages without duplicates, newest first, nextCursor null on the last page", async () => {
    const user = await registerUser(ctx.app);
    const created: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      created.push((await createTask(ctx.app, user.token, { title: `Task number ${i}` })).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = cursor ? `${TASKS}?limit=3&cursor=${encodeURIComponent(cursor)}` : `${TASKS}?limit=3`;
      const res = await request(ctx.app).get(url).set(auth(user.token));
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((t: { id: string }) => t.id));
      cursor = res.body.meta.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...created].reverse());
  });

  it("filters by status and by tag, and lists top-level only unless parentId is given", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app).post("/api/v1/tags").set(auth(user.token)).send({ name: "focus", color: "#333333" });
    const tagged = await createTask(ctx.app, user.token, { title: "Tagged root", tagIds: [tag.body.data.id] });
    const plain = await createTask(ctx.app, user.token, { title: "Plain root" });
    const child = await createTask(ctx.app, user.token, { title: "A child", parentId: plain.id });
    await ctx.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, plain.id));

    const all = await request(ctx.app).get(TASKS).set(auth(user.token));
    expect(all.body.data.map((t: { id: string }) => t.id).sort()).toEqual([tagged.id, plain.id].sort());

    const done = await request(ctx.app).get(`${TASKS}?status=done`).set(auth(user.token));
    expect(done.body.data.map((t: { id: string }) => t.id)).toEqual([plain.id]);

    const byTag = await request(ctx.app).get(`${TASKS}?tagId=${tag.body.data.id}`).set(auth(user.token));
    expect(byTag.body.data.map((t: { id: string }) => t.id)).toEqual([tagged.id]);

    const children = await request(ctx.app).get(`${TASKS}?parentId=${plain.id}`).set(auth(user.token));
    expect(children.body.data.map((t: { id: string }) => t.id)).toEqual([child.id]);
  });

  it("rejects a garbage cursor and an out-of-range limit", async () => {
    const user = await registerUser(ctx.app);
    const bad = await request(ctx.app).get(`${TASKS}?cursor=%%%`).set(auth(user.token));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: "query.cursor", message: "Invalid cursor" }]);
    const big = await request(ctx.app).get(`${TASKS}?limit=500`).set(auth(user.token));
    expect(big.status).toBe(400);
    expect(big.body.error.details[0].path).toBe("query.limit");
  });
});

describe("DELETE /tasks/:id", () => {
  it("cascades to children and tag links, and hides other users' tasks", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const tag = await request(ctx.app).post("/api/v1/tags").set(auth(owner.token)).send({ name: "gone", color: "#444444" });
    const root = await createTask(ctx.app, owner.token, { title: "Doomed root", tagIds: [tag.body.data.id] });
    const child = await createTask(ctx.app, owner.token, { title: "Doomed child", parentId: root.id });

    expect((await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(owner.token))).status).toBe(204);
    expect((await request(ctx.app).get(`${TASKS}/${child.id}`).set(auth(owner.token))).status).toBe(404);
    expect(await ctx.db.select().from(taskTags)).toEqual([]);
    expect((await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(owner.token))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project integration tests/api/tasks.test.ts tests/db/progress.test.ts`
Expected: FAIL, unresolved imports `../../src/services/tasks.js` and `../../src/repositories/tasks.js`.

- [ ] **Step 3: Write `src/repositories/tasks.ts`**

```ts
import { and, asc, desc, eq, exists, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tasks, taskTags, type NewTaskRow, type TaskRow } from "../db/schema.js";
import type { Cursor } from "../lib/cursor.js";
import type { AiSkipReason, AiStatus, TaskStatus } from "../schemas/tasks.js";

const owned = (id: string, userId: string) => and(eq(tasks.id, id), eq(tasks.userId, userId));

export async function findOwnedTask(db: DbOrTx, id: string, userId: string): Promise<TaskRow | undefined> {
  const [row] = await db.select().from(tasks).where(owned(id, userId)).limit(1);
  return row;
}

export async function insertTask(db: DbOrTx, values: NewTaskRow): Promise<TaskRow> {
  const [row] = await db.insert(tasks).values(values).returning();
  if (!row) throw new Error("insert tasks returned no row");
  return row;
}

export async function deleteTask(db: DbOrTx, id: string, userId: string): Promise<boolean> {
  const rows = await db.delete(tasks).where(owned(id, userId)).returning({ id: tasks.id });
  return rows.length > 0;
}

/** Deterministic order among siblings: position, then createdAt, then id. */
export const siblingOrder = [asc(tasks.position), asc(tasks.createdAt), asc(tasks.id)];

export const siblingScope = (userId: string, parentId: string | null): SQL | undefined =>
  and(eq(tasks.userId, userId), parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId));

export async function maxSiblingPosition(db: DbOrTx, userId: string, parentId: string | null): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | string | null>`max(${tasks.position})` })
    .from(tasks)
    .where(siblingScope(userId, parentId));
  const max = row?.max;
  return max === null || max === undefined ? -1 : Number(max);
}

export interface ListTasksOptions {
  userId: string;
  parentId: string | null;
  status?: TaskStatus;
  tagId?: string;
  limit: number;
  cursor?: Cursor;
}

/** Keyset list on (created_at desc, id desc). Returns up to limit + 1 rows so the caller knows if a next page exists. */
export async function listTasks(db: DbOrTx, opts: ListTasksOptions): Promise<TaskRow[]> {
  const conditions: (SQL | undefined)[] = [siblingScope(opts.userId, opts.parentId)];
  if (opts.status) conditions.push(eq(tasks.status, opts.status));
  if (opts.tagId) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(taskTags)
          .where(and(eq(taskTags.taskId, tasks.id), eq(taskTags.tagId, opts.tagId))),
      ),
    );
  }
  if (opts.cursor) {
    conditions.push(
      sql`(${tasks.createdAt}, ${tasks.id}) < (${opts.cursor.createdAt.toISOString()}::timestamptz, ${opts.cursor.id}::uuid)`,
    );
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(opts.limit + 1);
}

export async function listChildren(db: DbOrTx, parentId: string): Promise<TaskRow[]> {
  return db.select().from(tasks).where(eq(tasks.parentId, parentId)).orderBy(...siblingOrder);
}

export interface ChildAggregate {
  done: number;
  total: number;
  suggestionCount: number;
}

export type ChildAggregateMap = Map<string, ChildAggregate>;

/**
 * One SQL aggregate over direct children per parent. Progress counts children with origin user or
 * an accepted suggestion (done is the done subset); suggestionCount counts AI children still in
 * state suggested. Parents with no children are absent from the map.
 */
export async function childAggregates(db: DbOrTx, taskIds: string[]): Promise<ChildAggregateMap> {
  const map: ChildAggregateMap = new Map();
  if (taskIds.length === 0) return map;
  const counted = sql`(${tasks.origin} = 'user' or ${tasks.suggestionState} = 'accepted')`;
  const suggested = sql`(${tasks.origin} = 'ai' and ${tasks.suggestionState} = 'suggested')`;
  const rows = await db
    .select({
      parentId: tasks.parentId,
      total: sql<string>`count(*) filter (where ${counted})`,
      done: sql<string>`count(*) filter (where ${counted} and ${tasks.status} = 'done')`,
      suggestionCount: sql<string>`count(*) filter (where ${suggested})`,
    })
    .from(tasks)
    .where(inArray(tasks.parentId, taskIds))
    .groupBy(tasks.parentId);
  for (const row of rows) {
    if (row.parentId) {
      map.set(row.parentId, {
        done: Number(row.done),
        total: Number(row.total),
        suggestionCount: Number(row.suggestionCount),
      });
    }
  }
  return map;
}

export interface AiStatePatch {
  aiStatus: AiStatus;
  aiError?: string | null;
  aiSkipReason?: AiSkipReason | null;
  aiTagSuggestions?: string[];
}

/** Every AI-state write is guarded by generation_id so a superseded job can never overwrite a newer generation. */
export async function updateAiState(
  db: DbOrTx,
  id: string,
  generationId: string,
  patch: AiStatePatch,
): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), eq(tasks.generationId, generationId)))
    .returning({ id: tasks.id });
  return rows.length;
}
```

- [ ] **Step 4: Write `src/services/tasks.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx } from "../db/client.js";
import type { NewTaskRow, TaskRow } from "../db/schema.js";
import type { BreakdownQueue } from "../jobs/queue.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { notFound, validationError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import { findOwnedTags, replaceTaskTags, tagsForTasks } from "../repositories/tags.js";
import {
  childAggregates,
  deleteTask,
  findOwnedTask,
  insertTask,
  listChildren,
  listTasks,
  maxSiblingPosition,
  updateAiState,
  type ChildAggregate,
} from "../repositories/tasks.js";
import type { Tag } from "../schemas/tags.js";
import type { CreateTaskInput, ListTasksInput, TaskDetail, TaskSummary } from "../schemas/tasks.js";
import { toTag } from "./tags.js";

/** A child may only be created under a root, and breakdown only runs on a root. Raise to allow deeper nesting. */
export const MAX_TASK_DEPTH = 2;
export const DEPTH_MESSAGE = `Tasks can be nested at most ${MAX_TASK_DEPTH} levels deep`;
export const ENQUEUE_FAILED_MESSAGE = "Could not queue the assistant, try again";

export interface TasksServiceDeps {
  db: Db;
  queue: BreakdownQueue;
  rateLimiter: RateLimiter;
  logger: Logger;
}

export interface TaskPage {
  items: TaskSummary[];
  nextCursor: string | null;
}

export interface TasksService {
  list(userId: string, query: ListTasksInput): Promise<TaskPage>;
  create(userId: string, input: CreateTaskInput): Promise<TaskDetail>;
  get(userId: string, id: string): Promise<TaskDetail>;
  remove(userId: string, id: string): Promise<void>;
}

const NO_CHILDREN: ChildAggregate = { done: 0, total: 0, suggestionCount: 0 };

/** The API shape of one row. suggestionCount and aiError ride on every summary (master plan section 4). */
export function toTaskSummary(row: TaskRow, tags: Tag[], children: ChildAggregate): TaskSummary {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    status: row.status,
    aiStatus: row.aiStatus,
    aiSkipReason: row.aiSkipReason,
    aiError: row.aiError,
    position: row.position,
    origin: row.origin,
    suggestionState: row.suggestionState,
    rationale: row.rationale,
    tags,
    progress: { done: children.done, total: children.total },
    suggestionCount: children.suggestionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function summarize(db: DbOrTx, rows: TaskRow[]): Promise<TaskSummary[]> {
  const ids = rows.map((r) => r.id);
  const [tagMap, aggregates] = await Promise.all([tagsForTasks(db, ids), childAggregates(db, ids)]);
  return rows.map((row) =>
    toTaskSummary(row, (tagMap.get(row.id) ?? []).map(toTag), aggregates.get(row.id) ?? NO_CHILDREN),
  );
}

/** Loads the owned row plus children (ordered), tags, progress and AI fields. A miss is NOT_FOUND. */
export async function loadTaskDetail(db: DbOrTx, id: string, userId: string): Promise<TaskDetail> {
  const task = await findOwnedTask(db, id, userId);
  if (!task) throw notFound("Task not found");
  const children = await listChildren(db, task.id);
  const [summary, ...childSummaries] = await summarize(db, [task, ...children]);
  return {
    ...(summary as TaskSummary),
    children: childSummaries,
    aiTagSuggestions: task.aiTagSuggestions,
  };
}

/** Every id must be one of the user's tags; otherwise VALIDATION_ERROR on body.tagIds. */
export async function assertOwnedTagIds(db: DbOrTx, userId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const owned = new Set((await findOwnedTags(db, userId, tagIds)).map((t) => t.id));
  const missing = tagIds.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw validationError(missing.map((id) => ({ path: "body.tagIds", message: `Unknown tag id ${id}` })));
  }
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const { db, queue, rateLimiter, logger } = deps;

  return {
    async list(userId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await listTasks(db, {
        userId,
        parentId: query.parentId ?? null,
        status: query.status,
        tagId: query.tagId,
        limit: query.limit,
        cursor,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
      return { items: await summarize(db, page), nextCursor };
    },

    async create(userId, input) {
      let parent: TaskRow | undefined;
      if (input.parentId) {
        parent = await findOwnedTask(db, input.parentId, userId);
        if (!parent) throw notFound("Parent task not found");
        if (parent.parentId !== null) {
          throw validationError([{ path: "body.parentId", message: DEPTH_MESSAGE }]);
        }
      }
      const tagIds = [...new Set(input.tagIds ?? [])];
      await assertOwnedTagIds(db, userId, tagIds);
      const position = (await maxSiblingPosition(db, userId, parent?.id ?? null)) + 1;

      let aiFields: Pick<NewTaskRow, "aiStatus" | "aiSkipReason" | "generationId">;
      let generationId: string | undefined;
      if (parent) {
        aiFields = { aiStatus: "skipped" };
      } else {
        const consumed = await rateLimiter.consume(userId);
        if (consumed.allowed) {
          generationId = randomUUID();
          aiFields = { aiStatus: "pending", generationId };
        } else {
          aiFields = {
            aiStatus: "skipped",
            aiSkipReason: consumed.reason === "ai_disabled" ? "ai_disabled" : "rate_limited",
          };
        }
      }

      const row = await db.transaction(async (tx) => {
        const created = await insertTask(tx, {
          userId,
          parentId: parent?.id ?? null,
          title: input.title,
          description: input.description ?? null,
          position,
          ...aiFields,
        });
        if (tagIds.length > 0) await replaceTaskTags(tx, created.id, tagIds);
        return created;
      });

      // Enqueue after the transaction commits. Task creation never fails because of AI.
      if (generationId) {
        try {
          await queue.enqueueBreakdown({ taskId: row.id, userId, generationId, reason: "create" });
        } catch (err) {
          logger.error({ err, taskId: row.id }, "could not enqueue breakdown");
          await updateAiState(db, row.id, generationId, { aiStatus: "failed", aiError: ENQUEUE_FAILED_MESSAGE });
        }
      }
      return loadTaskDetail(db, row.id, userId);
    },

    async get(userId, id) {
      return loadTaskDetail(db, id, userId);
    },

    async remove(userId, id) {
      const deleted = await deleteTask(db, id, userId);
      if (!deleted) throw notFound("Task not found");
    },
  };
}
```

- [ ] **Step 5: Write `src/routes/tasks.ts` and mount it**

`src/routes/tasks.ts`:

```ts
import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { IdParams } from "../schemas/common.js";
import { CreateTaskBody, ListTasksQuery } from "../schemas/tasks.js";
import type { TasksService } from "../services/tasks.js";
import { validate, validated } from "./validate.js";

const listSchemas = { query: ListTasksQuery };
const createSchemas = { body: CreateTaskBody };
const idSchemas = { params: IdParams };

export function tasksRouter(service: TasksService): Router {
  const router = Router();

  router.get("/", validate(listSchemas), async (req, res) => {
    const { query } = validated<typeof listSchemas>(res);
    const page = await service.list(currentUser(req).id, query);
    sendData(res, page.items, { nextCursor: page.nextCursor });
  });

  router.post("/", validate(createSchemas), async (req, res) => {
    const { body } = validated<typeof createSchemas>(res);
    sendData(res, await service.create(currentUser(req).id, body), { status: 201 });
  });

  router.get("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.get(currentUser(req).id, params.id));
  });

  router.delete("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    await service.remove(currentUser(req).id, params.id);
    sendNoContent(res);
  });

  return router;
}
```

In `src/app.ts`: add imports

```ts
import { createRateLimiter } from "./lib/rate-limit.js";
import { tasksRouter } from "./routes/tasks.js";
import { createTasksService } from "./services/tasks.js";
```

destructure `queue` from `deps` alongside `config, db, redis, logger`, and mount after `/tags`:

```ts
  const rateLimiter = createRateLimiter(redis, config);
  const tasksService = createTasksService({ db, queue, rateLimiter, logger });
  api.use("/tasks", requireAuth(config), tasksRouter(tasksService));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/api/tasks.test.ts tests/db/progress.test.ts`
Expected:

```
 ✓ tests/db/progress.test.ts (1 test)
 ✓ tests/api/tasks.test.ts (14 tests)
```

- [ ] **Step 7: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/repositories/tasks.ts src/services/tasks.ts src/routes/tasks.ts src/app.ts tests/api/tasks.test.ts tests/db/progress.test.ts tests/helpers/tasks.ts
git commit -F - <<'MSG'
feat: task create, get, keyset list and delete with AI enqueue on create

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 14: Task update, position reorder, suggestion states, accept-all, dismiss-all, replace tags

**Files:**
- Create: `src/services/suggestions.ts`
- Modify: `src/repositories/tasks.ts`, `src/services/tasks.ts`, `src/routes/tasks.ts`
- Test: `src/services/suggestions.test.ts`, `tests/api/tasks-update.test.ts`

**Interfaces:**
- Consumes: Task 13 repository, service and router; Task 12 `replaceTaskTags`; Task 4 `UpdateTaskBody`, `ReplaceTagsBody`, `SuggestionState`.
- Produces:
  - `src/services/suggestions.ts`: `ALLOWED_SUGGESTION_TRANSITIONS`, `canTransitionSuggestion(from: SuggestionState | null, to: SuggestionState): boolean`.
  - repository additions: `updateTaskFields(db, id, userId, patch)`, `listSiblings(db, userId, parentId)` (locks rows `FOR UPDATE`), `setPositions(db, updates: { id; position }[])`, `setSuggestionStateForAll(db, parentId, userId, from, to): Promise<number>`.
  - service additions on `TasksService`: `update(userId, id, input: UpdateTaskInput)`, `acceptAll(userId, id)`, `dismissAll(userId, id)`, `replaceTags(userId, id, tagIds: string[])`, all returning `TaskDetail`.
  - routes: `PATCH /tasks/:id`, `POST /tasks/:id/suggestions/accept-all`, `POST /tasks/:id/suggestions/dismiss-all`, `PUT /tasks/:id/tags`.

- [ ] **Step 1: Write the failing tests**

`src/services/suggestions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SuggestionState } from "../schemas/tasks.js";
import { ALLOWED_SUGGESTION_TRANSITIONS, canTransitionSuggestion } from "./suggestions.js";

const STATES: SuggestionState[] = ["suggested", "accepted", "dismissed"];

describe("suggestion transitions", () => {
  it("allows exactly the four documented transitions", () => {
    const allowed = new Set(ALLOWED_SUGGESTION_TRANSITIONS.map(([f, t]) => `${f}->${t}`));
    expect([...allowed].sort()).toEqual(
      ["accepted->dismissed", "dismissed->accepted", "suggested->accepted", "suggested->dismissed"].sort(),
    );
    for (const from of STATES) {
      for (const to of STATES) {
        expect(canTransitionSuggestion(from, to), `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it("never allows a transition from a row without a suggestion state", () => {
    for (const to of STATES) expect(canTransitionSuggestion(null, to)).toBe(false);
  });
});
```

`tests/api/tasks-update.test.ts`:

```ts
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "../../src/db/schema.js";
import type { SuggestionState, TaskDetail } from "../../src/schemas/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";

async function aiChild(user: TestUser, parentId: string, title: string, position: number, state: SuggestionState = "suggested") {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      userId: user.userId,
      parentId,
      title,
      position,
      origin: "ai",
      suggestionState: state,
      rationale: `Because ${title.toLowerCase()} comes here`,
      aiStatus: "skipped",
    })
    .returning();
  return row!;
}

async function detail(user: TestUser, id: string): Promise<TaskDetail> {
  const res = await request(ctx.app).get(`${TASKS}/${id}`).set(auth(user.token));
  expect(res.status).toBe(200);
  return res.body.data as TaskDetail;
}

const patch = (user: TestUser, id: string, body: object) =>
  request(ctx.app).patch(`${TASKS}/${id}`).set(auth(user.token)).send(body);

describe("children ordering", () => {
  it("returns children ordered by position with rationale on AI-created ones", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root for ordering" });
    await createTask(ctx.app, user.token, { title: "User step A", parentId: root.id });
    await aiChild(user, root.id, "AI step B", 1);
    await createTask(ctx.app, user.token, { title: "User step C", parentId: root.id });
    const d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["User step A", "AI step B", "User step C"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2]);
    expect(d.suggestionCount).toBe(1);
    expect(d.children.map((c) => c.suggestionCount)).toEqual([0, 0, 0]);
    const ai = d.children[1]!;
    expect(ai.origin).toBe("ai");
    expect(ai.suggestionState).toBe("suggested");
    expect(ai.rationale).toBe("Because ai step b comes here");
    expect(d.children[0]!.rationale).toBeNull();
  });
});

describe("PATCH /tasks/:id", () => {
  it("moves a child to a target index, shifts siblings, and keeps positions dense", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root for reorder" });
    const names = ["A", "B", "C", "D"];
    const ids: Record<string, string> = {};
    for (const n of names) ids[n] = (await createTask(ctx.app, user.token, { title: n, parentId: root.id })).id;

    const moved = await patch(user, ids.D!, { position: 1 });
    expect(moved.status).toBe(200);
    let d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["A", "D", "B", "C"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);

    await patch(user, ids.A!, { position: 99 });
    d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["D", "B", "C", "A"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);

    await patch(user, ids.C!, { position: 0 });
    d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["C", "D", "B", "A"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("updates title, description and status; null clears the description", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Before edit", description: "old" });
    const res = await patch(user, task.id, { title: "After edit", description: null, status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: "After edit", description: null, status: "in_progress" });
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(task.updatedAt).getTime());
  });

  it("walks every allowed suggestion transition and rejects a disallowed one", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root for transitions" });
    const child = await aiChild(user, root.id, "Suggested step", 0);

    for (const to of ["accepted", "dismissed", "accepted"] as const) {
      const res = await patch(user, child.id, { suggestionState: to });
      expect(res.status, `-> ${to}`).toBe(200);
      expect(res.body.data.suggestionState).toBe(to);
    }
    const other = await aiChild(user, root.id, "Another suggested", 1);
    expect((await patch(user, other.id, { suggestionState: "dismissed" })).body.data.suggestionState).toBe("dismissed");

    const back = await patch(user, child.id, { suggestionState: "suggested" });
    expect(back.status).toBe(400);
    expect(back.body.error.code).toBe("VALIDATION_ERROR");
    expect(back.body.error.details[0].path).toBe("body.suggestionState");

    const userStep = await createTask(ctx.app, user.token, { title: "User step", parentId: root.id });
    const onUser = await patch(user, userStep.id, { suggestionState: "accepted" });
    expect(onUser.status).toBe(400);
    expect(onUser.body.error.details[0].path).toBe("body.suggestionState");
  });

  it("rejects an empty patch and hides other users' tasks", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const task = await createTask(ctx.app, owner.token, { title: "Mine" });
    expect((await patch(owner, task.id, {})).status).toBe(400);
    expect((await patch(other, task.id, { title: "Taken" })).status).toBe(404);
  });
});

describe("accept-all and dismiss-all", () => {
  it("only touch suggested children and progress follows", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root for bulk" });
    await createTask(ctx.app, user.token, { title: "User step", parentId: root.id });
    await aiChild(user, root.id, "S1", 1);
    await aiChild(user, root.id, "S2", 2);
    const dismissed = await aiChild(user, root.id, "Already dismissed", 3, "dismissed");

    // suggestionCount counts the two suggested children, on the detail and on the list row alike.
    expect((await detail(user, root.id)).suggestionCount).toBe(2);
    const listed = await request(ctx.app).get(TASKS).set(auth(user.token));
    expect(listed.body.data.find((t: { id: string }) => t.id === root.id).suggestionCount).toBe(2);

    const accepted = await request(ctx.app).post(`${TASKS}/${root.id}/suggestions/accept-all`).set(auth(user.token));
    expect(accepted.status).toBe(200);
    const states = Object.fromEntries(accepted.body.data.children.map((c: { title: string; suggestionState: string | null }) => [c.title, c.suggestionState]));
    expect(states).toEqual({ "User step": null, S1: "accepted", S2: "accepted", "Already dismissed": "dismissed" });
    expect(accepted.body.data.progress).toEqual({ done: 0, total: 3 });
    expect(accepted.body.data.suggestionCount).toBe(0);

    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, dismissed.id));
    expect(row?.suggestionState).toBe("dismissed");

    const root2 = await createTask(ctx.app, user.token, { title: "Root for dismiss" });
    await aiChild(user, root2.id, "S3", 0);
    await aiChild(user, root2.id, "S4", 1);
    expect((await detail(user, root2.id)).suggestionCount).toBe(2);
    const res = await request(ctx.app).post(`${TASKS}/${root2.id}/suggestions/dismiss-all`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.children.map((c: { suggestionState: string }) => c.suggestionState)).toEqual(["dismissed", "dismissed"]);
    expect(res.body.data.progress).toEqual({ done: 0, total: 0 });
    expect(res.body.data.suggestionCount).toBe(0);
  });
});

describe("PUT /tasks/:id/tags", () => {
  it("replaces the set with owned ids and rejects a foreign id", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const mk = async (u: TestUser, name: string) =>
      (await request(ctx.app).post("/api/v1/tags").set(auth(u.token)).send({ name, color: "#555555" })).body.data.id as string;
    const t1 = await mk(owner, "t1");
    const t2 = await mk(owner, "t2");
    const t3 = await mk(other, "t3");
    const task = await createTask(ctx.app, owner.token, { title: "Tag me", tagIds: [t1] });

    const put = (ids: string[]) => request(ctx.app).put(`${TASKS}/${task.id}/tags`).set(auth(owner.token)).send({ tagIds: ids });
    expect((await put([t1, t2])).body.data.tags.map((t: { id: string }) => t.id).sort()).toEqual([t1, t2].sort());
    const foreign = await put([t3]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details).toEqual([{ path: "body.tagIds", message: `Unknown tag id ${t3}` }]);
    expect((await put([])).body.data.tags).toEqual([]);
    expect((await request(ctx.app).put(`${TASKS}/${task.id}/tags`).set(auth(other.token)).send({ tagIds: [] })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services && npx vitest run --project integration tests/api/tasks-update.test.ts`
Expected: FAIL; `./suggestions.js` unresolved, and the PATCH requests return 404 (no route).

- [ ] **Step 3: Write `src/services/suggestions.ts`**

```ts
import type { SuggestionState } from "../schemas/tasks.js";

/** From spec 4.4: suggested to accepted or dismissed, dismissed to accepted, accepted to dismissed. */
export const ALLOWED_SUGGESTION_TRANSITIONS: ReadonlyArray<readonly [SuggestionState, SuggestionState]> = [
  ["suggested", "accepted"],
  ["suggested", "dismissed"],
  ["dismissed", "accepted"],
  ["accepted", "dismissed"],
];

export function canTransitionSuggestion(from: SuggestionState | null, to: SuggestionState): boolean {
  if (from === null) return false;
  return ALLOWED_SUGGESTION_TRANSITIONS.some(([f, t]) => f === from && t === to);
}
```

- [ ] **Step 4: Add the repository functions**

Append to `src/repositories/tasks.ts` (add `SuggestionState` to the existing type import from `../schemas/tasks.js`):

```ts
export type TaskFieldPatch = Partial<Pick<TaskRow, "title" | "description" | "status" | "suggestionState">>;

export async function updateTaskFields(
  db: DbOrTx,
  id: string,
  userId: string,
  patch: TaskFieldPatch,
): Promise<TaskRow | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(owned(id, userId))
    .returning();
  return row;
}

/** Siblings in order, locked for the duration of the transaction so concurrent reorders serialize. */
export async function listSiblings(db: DbOrTx, userId: string, parentId: string | null): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(siblingScope(userId, parentId))
    .orderBy(...siblingOrder)
    .for("update");
}

export async function setPositions(db: DbOrTx, updates: { id: string; position: number }[]): Promise<void> {
  for (const update of updates) {
    await db.update(tasks).set({ position: update.position, updatedAt: new Date() }).where(eq(tasks.id, update.id));
  }
}

export async function setSuggestionStateForAll(
  db: DbOrTx,
  parentId: string,
  userId: string,
  from: SuggestionState,
  to: SuggestionState,
): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ suggestionState: to, updatedAt: new Date() })
    .where(and(eq(tasks.parentId, parentId), eq(tasks.userId, userId), eq(tasks.origin, "ai"), eq(tasks.suggestionState, from)))
    .returning({ id: tasks.id });
  return rows.length;
}
```

- [ ] **Step 5: Extend the service**

In `src/services/tasks.ts`: extend the imports from `../repositories/tasks.js` with `listSiblings`, `setPositions`, `setSuggestionStateForAll`, `updateTaskFields`, `type TaskFieldPatch`; import `canTransitionSuggestion` from `./suggestions.js`; add `UpdateTaskInput` to the type import from `../schemas/tasks.js`. Add to the `TasksService` interface:

```ts
  update(userId: string, id: string, input: UpdateTaskInput): Promise<TaskDetail>;
  acceptAll(userId: string, id: string): Promise<TaskDetail>;
  dismissAll(userId: string, id: string): Promise<TaskDetail>;
  replaceTags(userId: string, id: string, tagIds: string[]): Promise<TaskDetail>;
```

Add this module-level function above `createTasksService`:

```ts
/**
 * Moves the row to the target index among its siblings and renumbers the siblings densely
 * from 0, so the rows between the old and new index shift by one. Runs inside the caller's transaction.
 */
async function moveToIndex(tx: DbOrTx, task: TaskRow, target: number): Promise<void> {
  const siblings = await listSiblings(tx, task.userId, task.parentId);
  const from = siblings.findIndex((s) => s.id === task.id);
  if (from === -1) return;
  const to = Math.min(Math.max(target, 0), siblings.length - 1);
  const reordered = [...siblings];
  const [moved] = reordered.splice(from, 1);
  if (!moved) return;
  reordered.splice(to, 0, moved);
  const before = new Map(siblings.map((s) => [s.id, s.position]));
  const updates = reordered
    .map((row, index) => ({ id: row.id, position: index }))
    .filter((u) => before.get(u.id) !== u.position);
  await setPositions(tx, updates);
}
```

Add these methods to the object returned by `createTasksService` (after `remove`):

```ts
    async update(userId, id, input) {
      const task = await findOwnedTask(db, id, userId);
      if (!task) throw notFound("Task not found");

      const patch: TaskFieldPatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.status !== undefined) patch.status = input.status;
      if (input.suggestionState !== undefined) {
        if (task.origin !== "ai") {
          throw validationError([
            { path: "body.suggestionState", message: "Only AI-suggested steps have a suggestion state" },
          ]);
        }
        if (!canTransitionSuggestion(task.suggestionState, input.suggestionState)) {
          throw validationError([
            {
              path: "body.suggestionState",
              message: `Cannot change suggestion state from ${task.suggestionState} to ${input.suggestionState}`,
            },
          ]);
        }
        patch.suggestionState = input.suggestionState;
      }

      await db.transaction(async (tx) => {
        if (Object.keys(patch).length > 0) await updateTaskFields(tx, id, userId, patch);
        if (input.position !== undefined) await moveToIndex(tx, task, input.position);
      });
      return loadTaskDetail(db, id, userId);
    },

    async acceptAll(userId, id) {
      const task = await findOwnedTask(db, id, userId);
      if (!task) throw notFound("Task not found");
      await setSuggestionStateForAll(db, task.id, userId, "suggested", "accepted");
      return loadTaskDetail(db, id, userId);
    },

    async dismissAll(userId, id) {
      const task = await findOwnedTask(db, id, userId);
      if (!task) throw notFound("Task not found");
      await setSuggestionStateForAll(db, task.id, userId, "suggested", "dismissed");
      return loadTaskDetail(db, id, userId);
    },

    async replaceTags(userId, id, tagIds) {
      const task = await findOwnedTask(db, id, userId);
      if (!task) throw notFound("Task not found");
      const unique = [...new Set(tagIds)];
      await assertOwnedTagIds(db, userId, unique);
      await db.transaction(async (tx) => {
        await replaceTaskTags(tx, task.id, unique);
      });
      return loadTaskDetail(db, id, userId);
    },
```

- [ ] **Step 6: Add the routes**

In `src/routes/tasks.ts`: add `ReplaceTagsBody`, `UpdateTaskBody` to the import from `../schemas/tasks.js`, define

```ts
const updateSchemas = { params: IdParams, body: UpdateTaskBody };
const tagsSchemas = { params: IdParams, body: ReplaceTagsBody };
```

and add these routes before `return router;`:

```ts
  router.patch("/:id", validate(updateSchemas), async (req, res) => {
    const { params, body } = validated<typeof updateSchemas>(res);
    sendData(res, await service.update(currentUser(req).id, params.id, body));
  });

  router.post("/:id/suggestions/accept-all", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.acceptAll(currentUser(req).id, params.id));
  });

  router.post("/:id/suggestions/dismiss-all", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.dismissAll(currentUser(req).id, params.id));
  });

  router.put("/:id/tags", validate(tagsSchemas), async (req, res) => {
    const { params, body } = validated<typeof tagsSchemas>(res);
    sendData(res, await service.replaceTags(currentUser(req).id, params.id, body.tagIds));
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services && npx vitest run --project integration tests/api/tasks-update.test.ts`
Expected:

```
 ✓ src/services/suggestions.test.ts (2 tests)
 ✓ tests/api/tasks-update.test.ts (7 tests)
```

- [ ] **Step 8: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/services/suggestions.ts src/services/suggestions.test.ts src/repositories/tasks.ts src/services/tasks.ts src/routes/tasks.ts tests/api/tasks-update.test.ts
git commit -F - <<'MSG'
feat: task update with reorder and suggestion states, bulk accept and dismiss, tag replacement

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 15: Agent module: prompt loader, breakdown logic, Anthropic adapter

**Files:**
- Create: `src/agent/prompt.ts`, `src/agent/breakdown.ts`, `src/agent/anthropic-model.ts`, `tests/fixtures/breakdown.ok.json`
- Modify: `src/agent/model.ts`
- Test: `src/agent/breakdown.test.ts`, `src/agent/prompt.test.ts`, `src/agent/anthropic-model.test.ts`

**Interfaces:**
- Consumes: Task 9 `BreakdownModel`, `BreakdownInput`, `BreakdownOutcome`, errors, `FakeBreakdownModel`; Task 4 `BreakdownSchema`, `MIN_STEPS`, `MAX_STEPS`, `MAX_TAG_SUGGESTIONS`; Task 6 prompt file.
- Produces:
  - `src/agent/prompt.ts`: `PROMPT_URL`, `promptPath(): string`, `loadSystemPrompt(): string`.
  - `src/agent/breakdown.ts`: `MIN_TITLE_WORDS = 3`, `shouldSkipBreakdown(title, description): boolean`, `postValidate(raw: BreakdownResult): BreakdownResult`, `breakdownTask(input, model): Promise<BreakdownResult>` (throws `BreakdownRefused` / `BreakdownInvalid`; retryable model errors propagate).
  - `src/agent/anthropic-model.ts`: `MODEL_TIMEOUT_MS = 45_000`, `MAX_OUTPUT_TOKENS = 4096`, `toModelError(err): Error`, `class AnthropicBreakdownModel implements BreakdownModel` with `constructor({ apiKey, model, systemPrompt })`.
  - `src/agent/model.ts` addition: `createBreakdownModel({ provider, model, apiKey? }): BreakdownModel`.
  - `tests/fixtures/breakdown.ok.json`: a recorded model output that satisfies `BreakdownSchema`.

- [ ] **Step 1: Write the fixture and the failing tests**

`tests/fixtures/breakdown.ok.json`:

```json
{
  "steps": [
    {
      "title": "Write the offsite goal in one sentence",
      "rationale": "Every other choice, from venue to agenda, follows from what the offsite must achieve"
    },
    {
      "title": "List the attendees and confirm the dates with them",
      "rationale": "Headcount and dates constrain the venue search, so they come before it"
    },
    {
      "title": "Shortlist three venues that fit the headcount and budget",
      "rationale": "A short list makes the booking decision quick once dates are confirmed"
    },
    {
      "title": "Book the venue and send calendar invites",
      "rationale": "Booking locks the plan so agenda work can start against a fixed place and time"
    },
    {
      "title": "Draft the agenda and share it for comments",
      "rationale": "The agenda is only useful once the logistics are settled"
    }
  ],
  "tagSuggestions": ["work", "planning"]
}
```

`src/agent/breakdown.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BreakdownSchema, type BreakdownResult } from "../schemas/breakdown.js";
import { breakdownTask, postValidate, shouldSkipBreakdown } from "./breakdown.js";
import { BreakdownInvalid, BreakdownRefused, ModelRetryableError } from "./errors.js";
import { FakeBreakdownModel } from "./fake-model.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/breakdown.ok.json", import.meta.url), "utf8"),
) as BreakdownResult;

const input = {
  title: "Plan the Q4 team offsite",
  description: "Two days, twelve people",
  existingSteps: [],
  tags: ["work"],
  openTasks: ["Renew lease"],
};

const step = (title: string, rationale = "because") => ({ title, rationale });

describe("recorded contract fixture", () => {
  it("satisfies the structured-output schema and passes through breakdownTask unchanged", async () => {
    expect(BreakdownSchema.safeParse(fixture).success).toBe(true);
    const model = new FakeBreakdownModel({ result: fixture });
    expect(await breakdownTask(input, model)).toEqual(fixture);
    expect(model.calls).toEqual([input]);
  });
});

describe("postValidate", () => {
  it("trims titles and rationales and removes case-insensitive duplicates", () => {
    const result = postValidate({
      steps: [step("  Call the venue ", " first "), step("call the VENUE"), step("Send invites"), step("Book flights")],
      tagSuggestions: [" Travel ", "travel", "work"],
    });
    expect(result.steps.map((s) => s.title)).toEqual(["Call the venue", "Send invites", "Book flights"]);
    expect(result.steps[0]?.rationale).toBe("first");
    expect(result.tagSuggestions).toEqual(["Travel", "work"]);
  });

  it("drops empty titles and rejects fewer than three distinct steps", () => {
    expect(() =>
      postValidate({ steps: [step("   "), step("One"), step("one"), step("Two")], tagSuggestions: [] }),
    ).toThrow(BreakdownInvalid);
  });

  it("caps steps at seven and tag suggestions at three", () => {
    const many = Array.from({ length: 9 }, (_, i) => step(`Step ${i + 1}`));
    const result = postValidate({ steps: many, tagSuggestions: ["a", "b", "c", "d"] });
    expect(result.steps).toHaveLength(7);
    expect(result.steps[6]?.title).toBe("Step 7");
    expect(result.tagSuggestions).toEqual(["a", "b", "c"]);
  });
});

describe("breakdownTask outcomes", () => {
  it("maps refused and invalid outcomes to non-retryable errors and lets retryable errors propagate", async () => {
    await expect(breakdownTask(input, new FakeBreakdownModel({ mode: "refuse" }))).rejects.toBeInstanceOf(BreakdownRefused);
    await expect(breakdownTask(input, new FakeBreakdownModel({ mode: "invalid" }))).rejects.toBeInstanceOf(BreakdownInvalid);
    await expect(breakdownTask(input, new FakeBreakdownModel({ mode: "retryable-error" }))).rejects.toBeInstanceOf(ModelRetryableError);
  });
});

describe("shouldSkipBreakdown", () => {
  it("skips when the title has fewer than three words and the description is empty", () => {
    expect(shouldSkipBreakdown("Buy milk", "")).toBe(true);
    expect(shouldSkipBreakdown("  Buy   milk  ", null)).toBe(true);
    expect(shouldSkipBreakdown("Buy milk", "   ")).toBe(true);
    expect(shouldSkipBreakdown("Buy milk", "at the corner shop")).toBe(false);
    expect(shouldSkipBreakdown("Buy some milk", "")).toBe(false);
    expect(shouldSkipBreakdown("Plan the Q4 team offsite", undefined)).toBe(false);
  });
});
```

`src/agent/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadSystemPrompt, promptPath } from "./prompt.js";

describe("system prompt", () => {
  it("resolves next to the agent module and has the four sections", () => {
    expect(promptPath().endsWith("/src/agent/prompts/breakdown.system.md")).toBe(true);
    const prompt = loadSystemPrompt();
    for (const heading of ["## Role", "## How to reason", "## Constraints", "## Output contract"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("Stop at seven");
    expect(loadSystemPrompt()).toBe(prompt);
  });
});
```

`src/agent/anthropic-model.test.ts` (instances are created from the SDK prototypes so the test does not depend on error constructor signatures):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicBreakdownModel, MAX_OUTPUT_TOKENS, MODEL_TIMEOUT_MS, toModelError } from "./anthropic-model.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";

function sdkError<T extends object>(proto: T, props: Record<string, unknown>): T {
  return Object.assign(Object.create(proto) as T, { message: "sdk error", ...props });
}

describe("toModelError", () => {
  it("marks 429, 5xx, connection and timeout errors retryable", () => {
    for (const proto of [
      Anthropic.RateLimitError.prototype,
      Anthropic.InternalServerError.prototype,
      Anthropic.APIConnectionError.prototype,
      Anthropic.APIConnectionTimeoutError.prototype,
    ]) {
      expect(toModelError(sdkError(proto, {}))).toBeInstanceOf(ModelRetryableError);
    }
  });

  it("marks other API errors non-retryable and passes unknown errors through", () => {
    expect(toModelError(sdkError(Anthropic.BadRequestError.prototype, { status: 400 }))).toBeInstanceOf(ModelNonRetryableError);
    expect(toModelError(sdkError(Anthropic.AuthenticationError.prototype, { status: 401 }))).toBeInstanceOf(ModelNonRetryableError);
    const plain = new Error("boom");
    expect(toModelError(plain)).toBe(plain);
  });
});

describe("AnthropicBreakdownModel", () => {
  it("constructs with the spec's timeout and no SDK retries", () => {
    const model = new AnthropicBreakdownModel({ apiKey: "sk-test", model: "claude-sonnet-5", systemPrompt: "x" });
    expect(model).toBeInstanceOf(AnthropicBreakdownModel);
    expect(MODEL_TIMEOUT_MS).toBe(45_000);
    expect(MAX_OUTPUT_TOKENS).toBe(4096);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/agent`
Expected: FAIL, unresolved `./breakdown.js`, `./prompt.js`, `./anthropic-model.js`.

- [ ] **Step 3: Write `src/agent/prompt.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolved relative to this module, so the same code finds src/agent/prompts/ under tsx and
 * dist/agent/prompts/ after `scripts/copy-assets.sh`.
 */
export const PROMPT_URL = new URL("./prompts/breakdown.system.md", import.meta.url);

export function promptPath(): string {
  return fileURLToPath(PROMPT_URL);
}

let cached: string | undefined;

/** Reads the versioned system prompt once. Throws if it is missing or empty. */
export function loadSystemPrompt(): string {
  if (cached === undefined) {
    const text = readFileSync(PROMPT_URL, "utf8");
    if (text.trim().length === 0) throw new Error(`System prompt is empty: ${promptPath()}`);
    cached = text;
  }
  return cached;
}
```

- [ ] **Step 4: Write `src/agent/breakdown.ts`**

```ts
import { MAX_STEPS, MAX_TAG_SUGGESTIONS, MIN_STEPS, type BreakdownResult } from "../schemas/breakdown.js";
import { BreakdownInvalid, BreakdownRefused } from "./errors.js";
import type { BreakdownInput, BreakdownModel } from "./model.js";

export const MIN_TITLE_WORDS = 3;

/** Skip rule from spec 5.2: fewer than three words in the title and no description. */
export function shouldSkipBreakdown(title: string, description: string | null | undefined): boolean {
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  return words < MIN_TITLE_WORDS && (description ?? "").trim().length === 0;
}

/** Trim, drop empties, deduplicate case-insensitively, cap at seven steps and three tags, require three steps. */
export function postValidate(raw: BreakdownResult): BreakdownResult {
  const seenTitles = new Set<string>();
  const steps: BreakdownResult["steps"] = [];
  for (const step of raw.steps) {
    const title = step.title.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    steps.push({ title, rationale: step.rationale.trim() });
    if (steps.length === MAX_STEPS) break;
  }
  if (steps.length < MIN_STEPS) {
    throw new BreakdownInvalid(`expected at least ${MIN_STEPS} distinct steps, got ${steps.length}`);
  }

  const seenTags = new Set<string>();
  const tagSuggestions: string[] = [];
  for (const suggestion of raw.tagSuggestions) {
    const name = suggestion.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tagSuggestions.push(name);
    if (tagSuggestions.length === MAX_TAG_SUGGESTIONS) break;
  }
  return { steps, tagSuggestions };
}

/** Pure orchestration: call the model, translate outcomes into errors, post-validate. */
export async function breakdownTask(input: BreakdownInput, model: BreakdownModel): Promise<BreakdownResult> {
  const outcome = await model.complete(input);
  if (outcome.kind === "refused") throw new BreakdownRefused(outcome.reason);
  if (outcome.kind === "invalid") throw new BreakdownInvalid(outcome.reason);
  return postValidate(outcome.result);
}
```

- [ ] **Step 5: Write `src/agent/anthropic-model.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BreakdownSchema } from "../schemas/breakdown.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";
import type { BreakdownInput, BreakdownModel, BreakdownOutcome } from "./model.js";

export const MODEL_TIMEOUT_MS = 45_000;
export const MAX_OUTPUT_TOKENS = 4096;

/** 429, 5xx, connection and timeout failures retry through BullMQ; other API errors do not. */
export function toModelError(err: unknown): Error {
  if (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return new ModelRetryableError(err);
  }
  if (err instanceof Anthropic.APIError) return new ModelNonRetryableError(err);
  return err instanceof Error ? err : new Error(String(err));
}

export class AnthropicBreakdownModel implements BreakdownModel {
  private readonly client: Anthropic;

  constructor(private readonly options: { apiKey: string; model: string; systemPrompt: string }) {
    // BullMQ owns retries (spec 5.1): one bounded attempt per job attempt.
    this.client = new Anthropic({ apiKey: options.apiKey, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  }

  async complete(input: BreakdownInput): Promise<BreakdownOutcome> {
    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: "text", text: this.options.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: JSON.stringify(input) }],
        output_config: { format: zodOutputFormat(BreakdownSchema), effort: "medium" },
      });
      if (response.stop_reason === "refusal") {
        return { kind: "refused", reason: response.stop_details?.explanation ?? "refused" };
      }
      if (!response.parsed_output) return { kind: "invalid", reason: "unparseable" };
      return { kind: "ok", result: response.parsed_output };
    } catch (err) {
      throw toModelError(err);
    }
  }
}
```

- [ ] **Step 6: Add the provider selector to `src/agent/model.ts`**

Append to `src/agent/model.ts` (the adapters import only types from this file, so there is no runtime cycle):

```ts
import { AnthropicBreakdownModel } from "./anthropic-model.js";
import { FakeBreakdownModel } from "./fake-model.js";
import { loadSystemPrompt } from "./prompt.js";

export interface ModelSelection {
  provider: "anthropic" | "fake";
  model: string;
  apiKey?: string;
}

/** Picks the adapter from config once at startup. */
export function createBreakdownModel(selection: ModelSelection): BreakdownModel {
  if (selection.provider === "fake") return new FakeBreakdownModel();
  if (!selection.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when AI_MODEL_PROVIDER=anthropic");
  }
  return new AnthropicBreakdownModel({
    apiKey: selection.apiKey,
    model: selection.model,
    systemPrompt: loadSystemPrompt(),
  });
}
```

Move these three `import` lines to the top of `model.ts` with the existing type import (ESM imports are hoisted, but keep the file tidy).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/agent`
Expected:

```
 ✓ src/agent/fake-model.test.ts (3 tests)
 ✓ src/agent/breakdown.test.ts (6 tests)
 ✓ src/agent/prompt.test.ts (1 test)
 ✓ src/agent/anthropic-model.test.ts (3 tests)
```

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/agent tests/fixtures/breakdown.ok.json
git commit -F - <<'MSG'
feat: breakdown agent with prompt loader, post-validation and anthropic adapter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 16: Breakdown processor and the breakdown action

**Files:**
- Create: `src/jobs/processors/breakdown.ts`
- Modify: `src/repositories/tasks.ts`, `src/services/tasks.ts`, `src/routes/tasks.ts`, `tests/helpers/app.ts`
- Test: `tests/api/breakdown.test.ts`

**Interfaces:**
- Consumes: Task 15 `breakdownTask`, `shouldSkipBreakdown`, errors; Task 13 and 14 repository and service; Task 12 `listTags`, `tagsForTasks`; Task 11 `RateLimiter`; Task 9 `BreakdownJobData`, `breakdownJobId`, `FakeQueue.drain`.
- Produces:
  - repository additions: `reserveGeneration(db, id, userId, generationId): Promise<TaskRow | undefined>` (the atomic conditional update), `openRootTitles(db, userId, excludeId, limit): Promise<string[]>`, `replaceSuggestedChildren(tx, { taskId, userId, generationId, steps, tagSuggestions }): Promise<boolean>`.
  - processor: `OPEN_TASKS_LIMIT = 30`, `AI_ERROR_MESSAGES { refused, invalid, rejected, unavailable }`, `interface ProcessorDeps { db; model; logger }`, `failureMessage(err): string | undefined`, `processBreakdownJob(data: BreakdownJobData, deps: ProcessorDeps): Promise<void>` (throws only for retryable failures).
  - service addition: `breakdown(userId, id): Promise<TaskDetail>` on `TasksService`; route `POST /tasks/:id/breakdown` returning 202.
  - harness addition: `TestContext.runQueue(): Promise<number>` runs every recorded fake-queue job through the real processor.

- [ ] **Step 1: Write the failing test**

`tests/api/breakdown.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelRetryableError } from "../../src/agent/errors.js";
import { tasks } from "../../src/db/schema.js";
import { AI_ERROR_MESSAGES } from "../../src/jobs/processors/breakdown.js";
import { nextHourIso } from "../../src/lib/rate-limit.js";
import { ENQUEUE_FAILED_MESSAGE } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";
const breakdown = (c: TestContext, user: TestUser, id: string) =>
  request(c.app).post(`${TASKS}/${id}/breakdown`).set(auth(user.token));
const get = (c: TestContext, user: TestUser, id: string) => request(c.app).get(`${TASKS}/${id}`).set(auth(user.token));

describe("processor through the fake queue", () => {
  it("writes suggested children with rationale, tag suggestions not already on the task, and aiStatus done", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app).post("/api/v1/tags").set(auth(user.token)).send({ name: "Planning", color: "#666666" });
    const task = await createTask(ctx.app, user.token, { title: "Plan the Q4 team offsite", tagIds: [tag.body.data.id] });
    expect(await ctx.runQueue()).toBe(1);
    const res = await get(ctx, user, task.id);
    expect(res.body.data.aiStatus).toBe("done");
    expect(res.body.data.aiError).toBeNull();
    expect(res.body.data.children).toHaveLength(4);
    expect(res.body.data.suggestionCount).toBe(4);
    for (const child of res.body.data.children) {
      expect(child).toMatchObject({ origin: "ai", suggestionState: "suggested", aiStatus: "skipped" });
      expect(child.rationale).toEqual(expect.any(String));
    }
    expect(res.body.data.children.map((c: { position: number }) => c.position)).toEqual([0, 1, 2, 3]);
    expect(res.body.data.aiTagSuggestions).toEqual(["writing"]);
    expect(ctx.model.calls[0]).toMatchObject({ title: "Plan the Q4 team offsite", tags: ["Planning"], existingSteps: [] });
  });

  it("passes existing steps and up to 30 open root titles to the model", async () => {
    const user = await registerUser(ctx.app);
    // Inserted directly: 32 root creates through the API would exhaust the per-user AI limit (20 per hour)
    // and the 33rd create would be skipped with reason rate_limited instead of enqueuing a job.
    await ctx.db.insert(tasks).values(
      Array.from({ length: 32 }, (_, i) => ({
        userId: user.userId,
        title: `Open task number ${i}`,
        aiStatus: "skipped" as const,
      })),
    );
    const task = await createTask(ctx.app, user.token, { title: "The one being broken down" });
    await createTask(ctx.app, user.token, { title: "Existing manual step", parentId: task.id });
    await ctx.runQueue();
    const call = ctx.model.calls.at(-1)!;
    expect(call.existingSteps).toEqual(["Existing manual step"]);
    expect(call.openTasks).toHaveLength(30);
    expect(call.openTasks).not.toContain("The one being broken down");
  });

  it("skips titles under three words with an empty description", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Buy milk" });
    await ctx.runQueue();
    const res = await get(ctx, user, task.id);
    expect(res.body.data).toMatchObject({ aiStatus: "skipped", aiSkipReason: "too_short", children: [] });
  });

  it("marks refusals and invalid answers failed with a human-readable message", async () => {
    const user = await registerUser(ctx.app);
    ctx.model.mode = "refuse";
    const refused = await createTask(ctx.app, user.token, { title: "Something the model declines" });
    await ctx.runQueue();
    expect((await get(ctx, user, refused.id)).body.data).toMatchObject({ aiStatus: "failed", aiError: AI_ERROR_MESSAGES.refused });

    ctx.model.mode = "invalid";
    const invalid = await createTask(ctx.app, user.token, { title: "Something the model garbles" });
    await ctx.runQueue();
    expect((await get(ctx, user, invalid.id)).body.data).toMatchObject({ aiStatus: "failed", aiError: AI_ERROR_MESSAGES.invalid });
    ctx.model.mode = "ok";
  });

  it("rethrows retryable failures and leaves the task running for the queue to retry", async () => {
    const user = await registerUser(ctx.app);
    ctx.model.mode = "retryable-error";
    const task = await createTask(ctx.app, user.token, { title: "Upstream is flaky today" });
    await expect(ctx.runQueue()).rejects.toBeInstanceOf(ModelRetryableError);
    expect((await get(ctx, user, task.id)).body.data.aiStatus).toBe("running");
    ctx.model.mode = "ok";
  });

  it("writes nothing when the job's generation no longer owns the task", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Superseded before it ran" });
    const newer = randomUUID();
    await ctx.db.update(tasks).set({ generationId: newer }).where(eq(tasks.id, task.id));
    await ctx.runQueue();
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ aiStatus: "pending", generationId: newer });
    expect((await get(ctx, user, task.id)).body.data.children).toEqual([]);
    expect(ctx.model.calls.some((c) => c.title === "Superseded before it ran")).toBe(false);
  });
});

describe("POST /tasks/:id/breakdown", () => {
  it("two calls in quick succession yield one 202 and one CONFLICT", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Regenerate this task please" });
    await ctx.runQueue();
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const oldGeneration = row?.generationId;

    const [a, b] = await Promise.all([breakdown(ctx, user, task.id), breakdown(ctx, user, task.id)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const accepted = a.status === 202 ? a : b;
    const rejected = a.status === 409 ? a : b;
    expect(accepted.body.data).toMatchObject({ aiStatus: "pending", aiError: null, aiSkipReason: null });
    expect(rejected.body.error.code).toBe("CONFLICT");
    expect(ctx.queue.jobs).toHaveLength(1);
    expect(ctx.queue.jobs[0]).toMatchObject({ taskId: task.id, userId: user.userId, reason: "regenerate" });
    expect(ctx.queue.jobs[0]?.generationId).not.toBe(oldGeneration);
  });

  it("returns RATE_LIMITED past the user limit with the documented details", async () => {
    const limited = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 1 });
    try {
      const user = await registerUser(limited.app);
      const task = await createTask(limited.app, user.token, { title: "Consumes the only slot" });
      await limited.runQueue();
      const res = await breakdown(limited, user, task.id);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");
      expect(res.body.error.details).toEqual({ scope: "user", limit: 1, resetAt: expect.any(String) });
      expect(new Date(res.body.error.details.resetAt).getUTCMinutes()).toBe(0);
      expect(res.body.error.details.resetAt).toBe(nextHourIso(new Date()));
    } finally {
      await limited.close();
    }
  });

  it("returns RATE_LIMITED with scope global past the environment budget", async () => {
    const budget = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 20, AI_GLOBAL_LIMIT_PER_HOUR: 1 });
    try {
      const a = await registerUser(budget.app);
      const b = await registerUser(budget.app);
      await createTask(budget.app, a.token, { title: "Spends the whole budget" });
      const task = await createTask(budget.app, b.token, { title: "Arrives after the budget" });
      expect(task.aiStatus).toBe("skipped");
      expect(task.aiSkipReason).toBe("rate_limited");
      const res = await breakdown(budget, b, task.id);
      expect(res.status).toBe(429);
      expect(res.body.error.details).toEqual({ scope: "global", limit: 1, resetAt: expect.any(String) });
    } finally {
      await budget.close();
    }
  });

  it("returns UNAVAILABLE 'AI is paused' when AI_ENABLED is false", async () => {
    const paused = await createTestApp({ AI_ENABLED: false });
    try {
      const user = await registerUser(paused.app);
      const task = await createTask(paused.app, user.token, { title: "Nothing happens here" });
      const res = await breakdown(paused, user, task.id);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: "UNAVAILABLE", message: "AI is paused" });
    } finally {
      await paused.close();
    }
  });

  it("rejects children, hides foreign tasks, and records enqueue failures", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Root for breakdown rules" });
    const child = await createTask(ctx.app, owner.token, { title: "A child", parentId: root.id });
    await ctx.runQueue();
    const onChild = await breakdown(ctx, owner, child.id);
    expect(onChild.status).toBe(400);
    expect(onChild.body.error.details[0].message).toBe("Only top-level tasks can be broken down");
    expect((await breakdown(ctx, other, root.id)).status).toBe(404);

    ctx.queue.failNext = true;
    const failed = await breakdown(ctx, owner, root.id);
    expect(failed.status).toBe(202);
    expect(failed.body.data).toMatchObject({ aiStatus: "failed", aiError: ENQUEUE_FAILED_MESSAGE });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/api/breakdown.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/jobs/processors/breakdown.js"`.

- [ ] **Step 3: Add the repository functions**

Append to `src/repositories/tasks.ts` (add `ne` and `notInArray` to the `drizzle-orm` import):

```ts
/**
 * The concurrency guard lives in data: one conditional update reserves the generation.
 * No row means a generation is already pending or running (CONFLICT).
 */
export async function reserveGeneration(
  db: DbOrTx,
  id: string,
  userId: string,
  generationId: string,
): Promise<TaskRow | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ aiStatus: "pending", generationId, aiError: null, aiSkipReason: null, updatedAt: new Date() })
    .where(and(owned(id, userId), notInArray(tasks.aiStatus, ["pending", "running"])))
    .returning();
  return row;
}

/** Titles of the user's other open root tasks, newest first. */
export async function openRootTitles(db: DbOrTx, userId: string, excludeId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.parentId), ne(tasks.id, excludeId), ne(tasks.status, "done")))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit);
  return rows.map((r) => r.title);
}

export interface ReplaceSuggestedChildrenOptions {
  taskId: string;
  userId: string;
  generationId: string;
  steps: { title: string; rationale: string }[];
  tagSuggestions: string[];
}

/**
 * Persists a breakdown result inside the caller's transaction, guarded by generation_id:
 * locks the task row, deletes still-suggested AI children, inserts the new steps after the
 * current maximum position, sets tag suggestions and ai_status done. Returns false when the
 * generation was superseded, in which case nothing is written.
 */
export async function replaceSuggestedChildren(tx: DbOrTx, opts: ReplaceSuggestedChildrenOptions): Promise<boolean> {
  const [locked] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, opts.taskId), eq(tasks.generationId, opts.generationId)))
    .for("update");
  if (!locked) return false;

  await tx
    .delete(tasks)
    .where(and(eq(tasks.parentId, opts.taskId), eq(tasks.origin, "ai"), eq(tasks.suggestionState, "suggested")));

  const start = (await maxSiblingPosition(tx, opts.userId, opts.taskId)) + 1;
  if (opts.steps.length > 0) {
    await tx.insert(tasks).values(
      opts.steps.map((step, index) => ({
        userId: opts.userId,
        parentId: opts.taskId,
        title: step.title,
        rationale: step.rationale,
        position: start + index,
        origin: "ai" as const,
        suggestionState: "suggested" as const,
        aiStatus: "skipped" as const,
      })),
    );
  }

  const updated = await tx
    .update(tasks)
    .set({ aiStatus: "done", aiTagSuggestions: opts.tagSuggestions, aiError: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, opts.taskId), eq(tasks.generationId, opts.generationId)))
    .returning({ id: tasks.id });
  return updated.length > 0;
}
```

- [ ] **Step 4: Write `src/jobs/processors/breakdown.ts`**

```ts
import { breakdownTask, shouldSkipBreakdown } from "../../agent/breakdown.js";
import { BreakdownInvalid, BreakdownRefused, ModelNonRetryableError } from "../../agent/errors.js";
import type { BreakdownInput, BreakdownModel } from "../../agent/model.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../lib/logger.js";
import { listTags, tagsForTasks } from "../../repositories/tags.js";
import {
  findOwnedTask,
  listChildren,
  openRootTitles,
  replaceSuggestedChildren,
  updateAiState,
} from "../../repositories/tasks.js";
import type { BreakdownResult } from "../../schemas/breakdown.js";
import { breakdownJobId, type BreakdownJobData } from "../queue.js";

export const OPEN_TASKS_LIMIT = 30;

export const AI_ERROR_MESSAGES = {
  refused: "The assistant declined to break this task down",
  invalid: "The assistant returned an unusable answer, try again",
  rejected: "The assistant rejected the request",
  unavailable: "The assistant is unavailable, try again",
} as const;

export interface ProcessorDeps {
  db: Db;
  model: BreakdownModel;
  logger: Logger;
}

/** A message means the failure is final; undefined means the queue should retry. */
export function failureMessage(err: unknown): string | undefined {
  if (err instanceof BreakdownRefused) return AI_ERROR_MESSAGES.refused;
  if (err instanceof BreakdownInvalid) return AI_ERROR_MESSAGES.invalid;
  if (err instanceof ModelNonRetryableError) return AI_ERROR_MESSAGES.rejected;
  return undefined;
}

/**
 * Spec 5.2. Every write carries WHERE generation_id = <job's>, so a superseded job can never
 * overwrite a newer generation's state. Throws only for retryable failures.
 */
export async function processBreakdownJob(data: BreakdownJobData, deps: ProcessorDeps): Promise<void> {
  const { db, model } = deps;
  const log = deps.logger.child({ jobId: breakdownJobId(data.taskId, data.generationId), taskId: data.taskId });

  // 1. Load. A missing task or a different generation means a newer generation owns it.
  const task = await findOwnedTask(db, data.taskId, data.userId);
  if (!task || task.generationId !== data.generationId) {
    log.info("generation superseded or task gone; nothing to do");
    return;
  }

  // 2. Skip rule.
  if (shouldSkipBreakdown(task.title, task.description)) {
    await updateAiState(db, task.id, data.generationId, { aiStatus: "skipped", aiSkipReason: "too_short" });
    log.info("skipped: title too short");
    return;
  }

  // 3. Running, guarded.
  const running = await updateAiState(db, task.id, data.generationId, { aiStatus: "running" });
  if (running === 0) {
    log.info("superseded before running");
    return;
  }

  const [children, userTags, openTasks, taskTagMap] = await Promise.all([
    listChildren(db, task.id),
    listTags(db, data.userId),
    openRootTitles(db, data.userId, task.id, OPEN_TASKS_LIMIT),
    tagsForTasks(db, [task.id]),
  ]);
  const input: BreakdownInput = {
    title: task.title,
    description: task.description ?? "",
    existingSteps: children.map((c) => c.title),
    tags: userTags.map((t) => t.name),
    openTasks,
  };

  // 4. Call the model. 6 and 7: final failures are recorded; retryable ones propagate to BullMQ.
  let result: BreakdownResult;
  try {
    result = await breakdownTask(input, model);
  } catch (err) {
    const message = failureMessage(err);
    if (message === undefined) {
      log.warn({ err }, "retryable breakdown failure");
      throw err;
    }
    await updateAiState(db, task.id, data.generationId, { aiStatus: "failed", aiError: message });
    log.warn({ err }, "breakdown failed");
    return;
  }

  // 5. Persist in one guarded transaction. Tag names already on the task are not suggested again.
  const onTask = new Set((taskTagMap.get(task.id) ?? []).map((t) => t.name.toLowerCase()));
  const tagSuggestions = result.tagSuggestions.filter((name) => !onTask.has(name.toLowerCase()));
  const written = await db.transaction((tx) =>
    replaceSuggestedChildren(tx, {
      taskId: task.id,
      userId: data.userId,
      generationId: data.generationId,
      steps: result.steps,
      tagSuggestions,
    }),
  );
  if (written) {
    log.info({ steps: result.steps.length, tagSuggestions: tagSuggestions.length }, "breakdown done");
  } else {
    log.info("superseded during persist; result discarded");
  }
}
```

- [ ] **Step 5: Add the `breakdown` service method and route**

In `src/services/tasks.ts`: add `reserveGeneration` to the repository import; add `conflict`, `rateLimited`, `unavailable` to the `../lib/errors.js` import; add to the `TasksService` interface:

```ts
  breakdown(userId: string, id: string): Promise<TaskDetail>;
```

and add the method to the returned object:

```ts
    async breakdown(userId, id) {
      const task = await findOwnedTask(db, id, userId);
      if (!task) throw notFound("Task not found");
      if (task.parentId !== null) {
        throw validationError([{ path: "params.id", message: "Only top-level tasks can be broken down" }]);
      }
      const consumed = await rateLimiter.consume(userId);
      if (consumed.reason === "ai_disabled") throw unavailable("AI is paused");
      if (!consumed.allowed) {
        throw rateLimited({ scope: consumed.scope, limit: consumed.limit, resetAt: consumed.resetAt });
      }
      const generationId = randomUUID();
      const reserved = await reserveGeneration(db, id, userId, generationId);
      if (!reserved) throw conflict("A breakdown is already pending or running for this task");
      try {
        await queue.enqueueBreakdown({ taskId: id, userId, generationId, reason: "regenerate" });
      } catch (err) {
        logger.error({ err, taskId: id }, "could not enqueue breakdown");
        await updateAiState(db, id, generationId, { aiStatus: "failed", aiError: ENQUEUE_FAILED_MESSAGE });
      }
      return loadTaskDetail(db, id, userId);
    },
```

In `src/routes/tasks.ts` add before `return router;`:

```ts
  router.post("/:id/breakdown", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.breakdown(currentUser(req).id, params.id), { status: 202 });
  });
```

- [ ] **Step 6: Add `runQueue` to the harness**

In `tests/helpers/app.ts`: import `processBreakdownJob` from `../../src/jobs/processors/breakdown.js`; add `runQueue(): Promise<number>;` to `TestContext`; keep the silent logger in a variable and add to the returned object:

```ts
    runQueue: () => queue.drain((data) => processBreakdownJob(data, { db, model, logger })),
```

(where `const logger = createLogger("silent");` replaces the inline `createLogger("silent")` passed to `createApp`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/api/breakdown.test.ts`
Expected:

```
 ✓ tests/api/breakdown.test.ts (11 tests)
```

- [ ] **Step 8: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/jobs/processors/breakdown.ts src/repositories/tasks.ts src/services/tasks.ts src/routes/tasks.ts tests/helpers/app.ts tests/api/breakdown.test.ts
git commit -F - <<'MSG'
feat: breakdown processor with generation guards and the breakdown action

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 17: Worker, reconciler, and the real-queue jobs tests

**Files:**
- Create: `src/jobs/worker.ts`, `src/jobs/reconcile.ts`
- Modify: `src/repositories/tasks.ts`
- Test: `tests/jobs/breakdown.test.ts`

**Interfaces:**
- Consumes: Task 16 `processBreakdownJob`, `AI_ERROR_MESSAGES`, `updateAiState`; Task 9 queue constants, `createBreakdownQueue`, `createRedis`; Task 13 `createTasksService`; Task 11 `createRateLimiter`.
- Produces:
  - `src/jobs/worker.ts`: `interface WorkerDeps { connection: Redis; db: Db; model: BreakdownModel; logger: Logger }`, `type BreakdownWorker = Worker<BreakdownJobData>`, `startBreakdownWorker(deps): BreakdownWorker` (concurrency 3; on the final failed attempt sets `ai_status = failed` with `AI_ERROR_MESSAGES.unavailable`, guarded by the generation id).
  - `src/jobs/reconcile.ts`: `STALE_ERROR_MESSAGE = "Timed out, try again"`, `RECONCILE_INTERVAL_MS`, `reconcileStaleGenerations(db, staleMinutes, logger, now?): Promise<number>`, `startReconciler({ db, staleMinutes, logger }): { stop(): void }`.
  - repository addition: `failStaleGenerations(db, olderThan: Date, message): Promise<number>`.
- Verification V6 is completed here: a job added with the `${taskId}-${generationId}` id is picked up and completed by a real BullMQ 6 worker.

- [ ] **Step 1: Write the failing test**

`tests/jobs/breakdown.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBreakdownModel } from "../../src/agent/fake-model.js";
import { tasks } from "../../src/db/schema.js";
import { AI_ERROR_MESSAGES } from "../../src/jobs/processors/breakdown.js";
import { breakdownJobId, createBreakdownQueue, type BreakdownBullQueue, type BreakdownQueue } from "../../src/jobs/queue.js";
import { reconcileStaleGenerations, STALE_ERROR_MESSAGE } from "../../src/jobs/reconcile.js";
import { startBreakdownWorker, type BreakdownWorker } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/lib/logger.js";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import { createRedis } from "../../src/lib/redis.js";
import { findOwnedTask, listChildren } from "../../src/repositories/tasks.js";
import { createTasksService, type TasksService } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { registerUser } from "../helpers/auth.js";

let ctx: TestContext;
let queueConnection: Redis;
let workerConnection: Redis;
let queue: BreakdownQueue & { queue: BreakdownBullQueue };
let worker: BreakdownWorker | undefined;
let model: FakeBreakdownModel;
let service: TasksService;
let completed: string[];
const logger = createLogger("silent");

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

beforeEach(() => {
  queueConnection = createRedis(process.env.REDIS_URL ?? "");
  workerConnection = createRedis(process.env.REDIS_URL ?? "");
  queue = createBreakdownQueue(queueConnection);
  model = new FakeBreakdownModel();
  completed = [];
  service = createTasksService({ db: ctx.db, queue, rateLimiter: createRateLimiter(ctx.redis, ctx.config), logger });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
});

function startWorker() {
  worker = startBreakdownWorker({ connection: workerConnection, db: ctx.db, model, logger });
  worker.on("completed", (job) => completed.push(String(job.id)));
  return worker;
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const row = (id: string, userId: string) => () => findOwnedTask(ctx.db, id, userId);

describe("real BullMQ worker", () => {
  it("processes a create job added through enqueueBreakdown to done with suggested children and tags (V6)", async () => {
    const user = await registerUser(ctx.app);
    startWorker();
    const task = await service.create(user.userId, { title: "Plan the Q4 team offsite" });
    expect(task.aiStatus).toBe("pending");
    const [pending] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const expectedJobId = breakdownJobId(task.id, pending!.generationId!);
    expect(expectedJobId).toMatch(/^[0-9a-f-]{36}-[0-9a-f-]{36}$/);

    const done = await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    expect(done?.aiTagSuggestions).toEqual(["planning", "writing"]);
    const children = await listChildren(ctx.db, task.id);
    expect(children).toHaveLength(4);
    expect(children.every((c) => c.origin === "ai" && c.suggestionState === "suggested" && c.rationale)).toBe(true);
    expect(completed).toContain(expectedJobId);
  });

  it("marks a refused breakdown failed with a message", async () => {
    const user = await registerUser(ctx.app);
    model.mode = "refuse";
    startWorker();
    const task = await service.create(user.userId, { title: "Something it will refuse" });
    const failed = await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "failed");
    expect(failed?.aiError).toBe(AI_ERROR_MESSAGES.refused);
  });

  it("regenerate replaces suggested children and keeps an accepted one", async () => {
    const user = await registerUser(ctx.app);
    startWorker();
    const task = await service.create(user.userId, { title: "Regenerate keeps accepted steps" });
    await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    const first = await listChildren(ctx.db, task.id);
    const kept = first[0]!;
    await service.update(user.userId, kept.id, { suggestionState: "accepted" });

    const again = await service.breakdown(user.userId, task.id);
    expect(again.aiStatus).toBe("pending");
    await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    await waitFor(() => listChildren(ctx.db, task.id), (c) => c.length === 5);
    const after = await listChildren(ctx.db, task.id);
    expect(after.filter((c) => c.suggestionState === "accepted").map((c) => c.id)).toEqual([kept.id]);
    expect(after.filter((c) => c.suggestionState === "suggested")).toHaveLength(4);
    expect(after.filter((c) => first.some((f) => f.id === c.id && f.id !== kept.id))).toHaveLength(0);
    expect(Math.max(...after.map((c) => c.position))).toBeGreaterThan(Math.max(...first.map((c) => c.position)));
  });

  it("completes a job whose generation no longer matches without writing", async () => {
    const user = await registerUser(ctx.app);
    const task = await service.create(user.userId, { title: "Superseded before the worker starts" });
    const [pending] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const staleJobId = breakdownJobId(task.id, pending!.generationId!);
    const newer = randomUUID();
    await ctx.db.update(tasks).set({ generationId: newer }).where(eq(tasks.id, task.id));

    startWorker();
    await waitFor(async () => completed, (c) => c.includes(staleJobId));
    const [after] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({ aiStatus: "pending", generationId: newer });
    expect(await listChildren(ctx.db, task.id)).toEqual([]);
    expect(model.calls).toEqual([]);
  });
});

describe("reconciler", () => {
  it("fails generations stuck in pending or running past AI_STALE_MINUTES, keeping the generation id", async () => {
    const user = await registerUser(ctx.app);
    const old = new Date(Date.now() - 20 * 60_000);
    const stuckGeneration = randomUUID();
    const [stuck] = await ctx.db
      .insert(tasks)
      .values({ userId: user.userId, title: "Stuck in running", aiStatus: "running", generationId: stuckGeneration, updatedAt: old })
      .returning();
    const [fresh] = await ctx.db
      .insert(tasks)
      .values({ userId: user.userId, title: "Fresh and running", aiStatus: "running", generationId: randomUUID() })
      .returning();
    const [oldDone] = await ctx.db
      .insert(tasks)
      .values({ userId: user.userId, title: "Old but done", aiStatus: "done", updatedAt: old })
      .returning();

    expect(await reconcileStaleGenerations(ctx.db, 10, logger)).toBe(1);

    const [stuckAfter] = await ctx.db.select().from(tasks).where(eq(tasks.id, stuck!.id));
    expect(stuckAfter).toMatchObject({ aiStatus: "failed", aiError: STALE_ERROR_MESSAGE, generationId: stuckGeneration });
    expect(stuckAfter!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect((await ctx.db.select().from(tasks).where(eq(tasks.id, fresh!.id)))[0]?.aiStatus).toBe("running");
    expect((await ctx.db.select().from(tasks).where(eq(tasks.id, oldDone!.id)))[0]?.aiStatus).toBe("done");
    expect(await reconcileStaleGenerations(ctx.db, 10, logger)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/jobs/breakdown.test.ts`
Expected: FAIL, unresolved `../../src/jobs/reconcile.js` and `../../src/jobs/worker.js`.

- [ ] **Step 3: Add `failStaleGenerations` to the repository**

Append to `src/repositories/tasks.ts` (add `inArray` is already imported; add `lt` to the `drizzle-orm` import):

```ts
/** Reconciler write: stuck generations become retryable failures; generation_id is kept so a late job still cannot write. */
export async function failStaleGenerations(db: DbOrTx, olderThan: Date, message: string): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ aiStatus: "failed", aiError: message, updatedAt: new Date() })
    .where(and(inArray(tasks.aiStatus, ["pending", "running"]), lt(tasks.updatedAt, olderThan)))
    .returning({ id: tasks.id });
  return rows.length;
}
```

- [ ] **Step 4: Write `src/jobs/worker.ts`**

```ts
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { BreakdownModel } from "../agent/model.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import { updateAiState } from "../repositories/tasks.js";
import { AI_ERROR_MESSAGES, processBreakdownJob } from "./processors/breakdown.js";
import { BREAKDOWN_QUEUE_NAME, QUEUE_PREFIX, WORKER_CONCURRENCY, type BreakdownJobData } from "./queue.js";

export interface WorkerDeps {
  connection: Redis;
  db: Db;
  model: BreakdownModel;
  logger: Logger;
}

export type BreakdownWorker = Worker<BreakdownJobData>;

/** Starts processing immediately. BullMQ retries thrown (retryable) failures; the last one marks the task failed. */
export function startBreakdownWorker(deps: WorkerDeps): BreakdownWorker {
  const { connection, db, model, logger } = deps;
  const worker = new Worker<BreakdownJobData>(
    BREAKDOWN_QUEUE_NAME,
    async (job) => {
      await processBreakdownJob(job.data, { db, model, logger });
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    if (!job) {
      logger.error({ err }, "breakdown job failed without a job reference");
      return;
    }
    const log = logger.child({ jobId: job.id, taskId: job.data.taskId });
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      log.error({ err, attempts: job.attemptsMade }, "breakdown attempts exhausted");
      void updateAiState(db, job.data.taskId, job.data.generationId, {
        aiStatus: "failed",
        aiError: AI_ERROR_MESSAGES.unavailable,
      }).catch((markErr: unknown) => log.error({ err: markErr }, "could not mark task failed"));
    } else {
      log.warn({ err, attempt: job.attemptsMade }, "breakdown attempt failed, will retry");
    }
  });

  worker.on("error", (err) => {
    logger.error({ err }, "breakdown worker error");
  });

  return worker;
}
```

- [ ] **Step 5: Write `src/jobs/reconcile.ts`**

```ts
import type { Db } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import { failStaleGenerations } from "../repositories/tasks.js";

export const STALE_ERROR_MESSAGE = "Timed out, try again";
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Tasks pending or running with updated_at older than staleMinutes become retryable failures. */
export async function reconcileStaleGenerations(
  db: Db,
  staleMinutes: number,
  logger: Logger,
  now: Date = new Date(),
): Promise<number> {
  const olderThan = new Date(now.getTime() - staleMinutes * 60_000);
  const count = await failStaleGenerations(db, olderThan, STALE_ERROR_MESSAGE);
  if (count > 0) logger.warn({ count, staleMinutes }, "reconciled stale generations");
  return count;
}

/** Runs once now and every five minutes. The timer is unref'd so it never keeps the process alive. */
export function startReconciler(deps: { db: Db; staleMinutes: number; logger: Logger }): { stop(): void } {
  const run = () =>
    reconcileStaleGenerations(deps.db, deps.staleMinutes, deps.logger).catch((err: unknown) => {
      deps.logger.error({ err }, "reconciler run failed");
    });
  void run();
  const timer = setInterval(run, RECONCILE_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/jobs/breakdown.test.ts`
Expected (the worker cases take a few seconds each because of Redis round trips):

```
 ✓ tests/jobs/breakdown.test.ts (5 tests)
```

- [ ] **Step 7: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/jobs/worker.ts src/jobs/reconcile.ts src/repositories/tasks.ts tests/jobs/breakdown.test.ts
git commit -F - <<'MSG'
feat: bullmq worker with exhausted-attempt handling and stale-generation reconciler

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 18: Demo seed with stable ids and the admin seed-reset route

**Files:**
- Create: `src/db/seed.ts`, `src/services/admin.ts`, `src/routes/admin.ts`
- Modify: `src/app.ts`
- Test: `tests/api/admin.test.ts`

**Interfaces:**
- Consumes: Task 8 schema tables and `Db`; Task 10 `hashPassword`; Task 1 `Config`.
- Produces:
  - `src/db/seed.ts`: `DEMO_EMAIL = "demo@kaizen.local"`, `SEED_IDS` (stable UUIDs for the user, four tags, five root tasks, ten children), `ensureDemoSeed(db, password): Promise<SeedResult>` (creates only if the demo user is absent), `resetDemoSeed(db, password): Promise<SeedResult>` (deletes the demo user, cascading everything, and recreates), `interface SeedResult { demoUserId: string; created: boolean }`; `npm run db:seed` and `npm run db:seed -- --reset`.
  - `src/services/admin.ts`: `createAdminService({ db, config }): AdminService` with `resetDemo(): Promise<{ demoUserId }>`.
  - `src/routes/admin.ts`: `adminRouter({ adminToken, service }): Router` mounted at `/api/v1/admin` only when `ADMIN_TOKEN` is set; header `x-admin-token`; wrong or missing token gives the same `NOT_FOUND` as an unmounted route.
  - Cross-lane interface (master plan section 4): `POST /api/v1/admin/seed-reset` with header `x-admin-token`; demo user `demo@kaizen.local`.

- [ ] **Step 1: Write the failing test**

`tests/api/admin.test.ts`:

```ts
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "../../src/db/schema.js";
import { DEMO_EMAIL, ensureDemoSeed, SEED_IDS } from "../../src/db/seed.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth } from "../helpers/auth.js";

const ADMIN_TOKEN = "facilitator-token-with-at-least-32-characters";
const RESET = "/api/v1/admin/seed-reset";

let plain: TestContext;
let admin: TestContext;
beforeAll(async () => {
  plain = await createTestApp();
  admin = await createTestApp({ ADMIN_TOKEN, SEED_DEMO_PASSWORD: "demo-password-1" });
});
afterAll(async () => {
  await plain.close();
  await admin.close();
});

describe("POST /admin/seed-reset", () => {
  it("is absent without ADMIN_TOKEN", async () => {
    const res = await request(plain.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND", message: "Route POST /api/v1/admin/seed-reset not found" });
  });

  it("returns the same NOT_FOUND for a wrong or missing token", async () => {
    const wrong = await request(admin.app).post(RESET).set("x-admin-token", "nope");
    const missing = await request(admin.app).post(RESET);
    for (const res of [wrong, missing]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: "NOT_FOUND", message: "Route POST /api/v1/admin/seed-reset not found" });
    }
  });

  it("recreates the fixtures with their stable ids on a correct token, undoing changes", async () => {
    const first = await request(admin.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ demoUserId: SEED_IDS.demoUser });

    const login = await request(admin.app).post("/api/v1/auth/login").send({ email: DEMO_EMAIL, password: "demo-password-1" });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken as string;

    const offsite = await request(admin.app).get(`/api/v1/tasks/${SEED_IDS.tasks.offsite}`).set(auth(token));
    expect(offsite.status).toBe(200);
    expect(offsite.body.data).toMatchObject({ title: "Plan the Q4 team offsite", status: "in_progress", aiStatus: "done", progress: { done: 2, total: 4 }, suggestionCount: 0, aiError: null });
    expect(offsite.body.data.children.map((c: { id: string }) => c.id)).toEqual([
      SEED_IDS.children.offsite1,
      SEED_IDS.children.offsite2,
      SEED_IDS.children.offsite3,
      SEED_IDS.children.offsite4,
    ]);
    expect(offsite.body.data.children.every((c: { rationale: string | null; suggestionState: string }) => c.rationale && c.suggestionState === "accepted")).toBe(true);

    const onboarding = await request(admin.app).get(`/api/v1/tasks/${SEED_IDS.tasks.onboarding}`).set(auth(token));
    expect(onboarding.body.data.children.map((c: { suggestionState: string }) => c.suggestionState)).toEqual(["suggested", "suggested", "suggested"]);
    expect(onboarding.body.data.suggestionCount).toBe(3);
    const flaky = await request(admin.app).get(`/api/v1/tasks/${SEED_IDS.tasks.flakyTest}`).set(auth(token));
    expect(flaky.body.data).toMatchObject({ aiStatus: "failed", aiError: expect.any(String) });
    const tagsRes = await request(admin.app).get("/api/v1/tags").set(auth(token));
    expect(tagsRes.body.data.map((t: { id: string }) => t.id).sort()).toEqual(Object.values(SEED_IDS.tags).sort());

    // mutate, then reset again: everything is pristine
    await request(admin.app).delete(`/api/v1/tasks/${SEED_IDS.children.offsite1}`).set(auth(token));
    await request(admin.app).patch(`/api/v1/tasks/${SEED_IDS.tasks.offsite}`).set(auth(token)).send({ title: "Changed" });
    const second = await request(admin.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(second.status).toBe(200);
    const [restored] = await admin.db.select().from(tasks).where(eq(tasks.id, SEED_IDS.tasks.offsite));
    expect(restored?.title).toBe("Plan the Q4 team offsite");
    const [child] = await admin.db.select().from(tasks).where(eq(tasks.id, SEED_IDS.children.offsite1));
    expect(child).toBeDefined();
  });
});

describe("ensureDemoSeed", () => {
  it("creates once and is a no-op afterwards", async () => {
    expect(await ensureDemoSeed(plain.db, "demo-password-1")).toEqual({ demoUserId: SEED_IDS.demoUser, created: true });
    expect(await ensureDemoSeed(plain.db, "demo-password-1")).toEqual({ demoUserId: SEED_IDS.demoUser, created: false });
    expect(await plain.db.select().from(tasks)).toHaveLength(15);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/api/admin.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/db/seed.js"`.

- [ ] **Step 3: Write `src/db/seed.ts`**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { hashPassword } from "../lib/auth.js";
import { createDb, type Db, type DbOrTx } from "./client.js";
import { tags, tasks, taskTags, users } from "./schema.js";

export const DEMO_EMAIL = "demo@kaizen.local";

/** Stable, valid v4-shaped UUIDs so the runbook and the smoke test can refer to fixtures by id. */
const stableId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SEED_IDS = {
  demoUser: stableId(1),
  tags: {
    work: stableId(301),
    personal: stableId(302),
    urgent: stableId(303),
    writing: stableId(304),
  },
  tasks: {
    offsite: stableId(101),
    onboarding: stableId(102),
    flakyTest: stableId(103),
    lease: stableId(104),
    interviews: stableId(105),
  },
  children: {
    offsite1: stableId(201),
    offsite2: stableId(202),
    offsite3: stableId(203),
    offsite4: stableId(204),
    onboarding1: stableId(211),
    onboarding2: stableId(212),
    onboarding3: stableId(213),
    interviews1: stableId(221),
    interviews2: stableId(222),
    interviews3: stableId(223),
  },
  generations: {
    offsite: stableId(901),
    onboarding: stableId(902),
    flakyTest: stableId(903),
    lease: stableId(904),
    interviews: stableId(905),
  },
} as const;

export interface SeedResult {
  demoUserId: string;
  created: boolean;
}

const UNAVAILABLE_MESSAGE = "The assistant is unavailable, try again";

async function insertFixtures(tx: DbOrTx, passwordHash: string): Promise<void> {
  const u = SEED_IDS.demoUser;
  const T = SEED_IDS.tags;
  const K = SEED_IDS.tasks;
  const C = SEED_IDS.children;
  const G = SEED_IDS.generations;

  await tx.insert(users).values({ id: u, email: DEMO_EMAIL, passwordHash, displayName: "Demo User" });

  await tx.insert(tags).values([
    { id: T.work, userId: u, name: "work", color: "#2563eb" },
    { id: T.personal, userId: u, name: "personal", color: "#16a34a" },
    { id: T.urgent, userId: u, name: "urgent", color: "#dc2626" },
    { id: T.writing, userId: u, name: "writing", color: "#9333ea" },
  ]);

  await tx.insert(tasks).values([
    {
      id: K.offsite,
      userId: u,
      title: "Plan the Q4 team offsite",
      description: "Two days, twelve people, somewhere within two hours of the office.",
      status: "in_progress",
      position: 0,
      aiStatus: "done",
      generationId: G.offsite,
    },
    {
      id: K.onboarding,
      userId: u,
      title: "Write the onboarding guide for new PMs",
      description: "What a new PM needs in the first two weeks.",
      status: "todo",
      position: 1,
      aiStatus: "done",
      generationId: G.onboarding,
      aiTagSuggestions: ["documentation"],
    },
    {
      id: K.flakyTest,
      userId: u,
      title: "Fix the flaky login test in CI",
      description: "Fails about one run in five on the login redirect assertion.",
      status: "todo",
      position: 2,
      aiStatus: "failed",
      aiError: UNAVAILABLE_MESSAGE,
      generationId: G.flakyTest,
    },
    {
      id: K.lease,
      userId: u,
      title: "Renew lease",
      status: "done",
      position: 3,
      aiStatus: "skipped",
      aiSkipReason: "too_short",
      generationId: G.lease,
    },
    {
      id: K.interviews,
      userId: u,
      title: "Prepare the customer interview script for the pilot",
      description: "Five interviews next week with contact-center supervisors.",
      status: "todo",
      position: 4,
      aiStatus: "done",
      generationId: G.interviews,
      aiTagSuggestions: ["research"],
    },
  ]);

  const ai = (state: "suggested" | "accepted" | "dismissed") => ({
    origin: "ai" as const,
    suggestionState: state,
    aiStatus: "skipped" as const,
  });

  await tx.insert(tasks).values([
    // Offsite: accepted AI steps with rationales, two already done.
    { id: C.offsite1, userId: u, parentId: K.offsite, position: 0, status: "done", title: "Write the offsite goal in one sentence", rationale: "Every other choice follows from what the offsite must achieve", ...ai("accepted") },
    { id: C.offsite2, userId: u, parentId: K.offsite, position: 1, status: "done", title: "Confirm the dates with all twelve attendees", rationale: "Headcount and dates constrain the venue search, so they come first", ...ai("accepted") },
    { id: C.offsite3, userId: u, parentId: K.offsite, position: 2, status: "in_progress", title: "Shortlist three venues within budget", rationale: "A short list makes the booking decision quick once dates are fixed", ...ai("accepted") },
    { id: C.offsite4, userId: u, parentId: K.offsite, position: 3, status: "todo", title: "Book the venue and send invites", rationale: "Booking locks the plan so agenda work can start", ...ai("accepted") },
    // Onboarding: suggestions still pending review.
    { id: C.onboarding1, userId: u, parentId: K.onboarding, position: 0, title: "List the ten questions every new PM asks in week one", rationale: "The guide answers real questions, so collecting them comes first", ...ai("suggested") },
    { id: C.onboarding2, userId: u, parentId: K.onboarding, position: 1, title: "Draft the first-week checklist", rationale: "A checklist is the smallest useful version of the guide", ...ai("suggested") },
    { id: C.onboarding3, userId: u, parentId: K.onboarding, position: 2, title: "Ask two recent hires to review the draft", rationale: "Recent hires remember what was missing", ...ai("suggested") },
    // Interviews: a user step, an accepted AI step, a dismissed AI step.
    { id: C.interviews1, userId: u, parentId: K.interviews, position: 0, status: "done", title: "Write the three questions the pilot must answer", origin: "user", aiStatus: "skipped" },
    { id: C.interviews2, userId: u, parentId: K.interviews, position: 1, title: "Draft the interview script around those questions", rationale: "The script follows from the questions it must answer", ...ai("accepted") },
    { id: C.interviews3, userId: u, parentId: K.interviews, position: 2, title: "Schedule a dry run with a colleague", rationale: "A rehearsal catches awkward questions before the real interviews", ...ai("dismissed") },
  ]);

  await tx.insert(taskTags).values([
    { taskId: K.offsite, tagId: T.work },
    { taskId: K.onboarding, tagId: T.work },
    { taskId: K.onboarding, tagId: T.writing },
    { taskId: K.flakyTest, tagId: T.urgent },
    { taskId: K.lease, tagId: T.personal },
    { taskId: K.interviews, tagId: T.work },
  ]);
}

/** Startup entry point: creates the fixtures only if the demo user is absent. */
export async function ensureDemoSeed(db: Db, password: string): Promise<SeedResult> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing) return { demoUserId: existing.id, created: false };
  const passwordHash = await hashPassword(password);
  await db.transaction((tx) => insertFixtures(tx, passwordHash));
  return { demoUserId: SEED_IDS.demoUser, created: true };
}

/** Facilitator entry point: deletes the demo user (cascading everything) and recreates the fixtures, in one transaction. */
export async function resetDemoSeed(db: Db, password: string): Promise<SeedResult> {
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.delete(users).where(eq(users.email, DEMO_EMAIL));
    await insertFixtures(tx, passwordHash);
  });
  return { demoUserId: SEED_IDS.demoUser, created: true };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 1 });
  const reset = process.argv.includes("--reset");
  const result = reset
    ? await resetDemoSeed(db, config.SEED_DEMO_PASSWORD)
    : await ensureDemoSeed(db, config.SEED_DEMO_PASSWORD);
  await sql.end();
  console.log(
    `${reset ? "reset" : result.created ? "created" : "already present"}: ${DEMO_EMAIL} (${result.demoUserId})`,
  );
}
```

- [ ] **Step 4: Write `src/services/admin.ts` and `src/routes/admin.ts`, and mount**

`src/services/admin.ts`:

```ts
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { resetDemoSeed } from "../db/seed.js";

export interface AdminService {
  resetDemo(): Promise<{ demoUserId: string }>;
}

export function createAdminService(deps: { db: Db; config: Pick<Config, "SEED_DEMO_PASSWORD"> }): AdminService {
  return {
    async resetDemo() {
      const result = await resetDemoSeed(deps.db, deps.config.SEED_DEMO_PASSWORD);
      return { demoUserId: result.demoUserId };
    },
  };
}
```

`src/routes/admin.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { sendData } from "../lib/envelope.js";
import { notFound } from "../lib/errors.js";
import type { AdminService } from "../services/admin.js";

export const ADMIN_TOKEN_HEADER = "x-admin-token";

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mounted only when ADMIN_TOKEN is set. A bad token looks exactly like an unmounted route. */
export function adminRouter(options: { adminToken: string; service: AdminService }): Router {
  const router = Router();
  router.post("/seed-reset", async (req, res) => {
    if (!tokenMatches(req.header(ADMIN_TOKEN_HEADER), options.adminToken)) {
      throw notFound(`Route ${req.method} ${req.originalUrl.split("?")[0]} not found`);
    }
    sendData(res, await options.service.resetDemo());
  });
  return router;
}
```

In `src/app.ts` add imports

```ts
import { adminRouter } from "./routes/admin.js";
import { createAdminService } from "./services/admin.js";
```

and after the `/tasks` mount:

```ts
  if (config.ADMIN_TOKEN) {
    api.use("/admin", adminRouter({ adminToken: config.ADMIN_TOKEN, service: createAdminService({ db, config }) }));
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/api/admin.test.ts`
Expected:

```
 ✓ tests/api/admin.test.ts (4 tests)
```

- [ ] **Step 6: Exercise the CLI entry points against the dev database**

Run: `npm run db:seed`
Expected: `created: demo@kaizen.local (00000000-0000-4000-8000-000000000001)`; a second run prints `already present: demo@kaizen.local (...)`.

Run: `npm run db:seed -- --reset`
Expected: `reset: demo@kaizen.local (00000000-0000-4000-8000-000000000001)`.

- [ ] **Step 7: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/db/seed.ts src/services/admin.ts src/routes/admin.ts src/app.ts tests/api/admin.test.ts
git commit -F - <<'MSG'
feat: demo seed with stable ids and the facilitator seed-reset endpoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 19: Feature requests through GitHub

**Files:**
- Create: `src/services/feature-requests.ts`, `src/routes/feature-requests.ts`
- Modify: `src/app.ts`
- Test: `tests/api/feature-requests.test.ts`

**Interfaces:**
- Consumes: Task 4 `FeatureRequestBody`, `FeatureRequestInput`; Task 10 `findUserById`, `requireAuth`, `currentUser`; Task 2 `upstreamError`.
- Produces:
  - `src/services/feature-requests.ts`: `FEATURE_REQUEST_LABEL = "feature-request"`, `interface GitHubIssues { create(params: { owner; repo; title; body; labels }): Promise<{ number: number; html_url: string }> }`, `createOctokitIssues(token): GitHubIssues`, `renderIssueBody(input, submitterName): string`, `createFeatureRequestsService({ db, issues, repo, logger }): FeatureRequestsService` with `submit(userId, input): Promise<{ issueNumber; issueUrl }>`.
  - `src/routes/feature-requests.ts`: `featureRequestsRouter(service): Router`.
  - `AppDeps.github?: GitHubIssues` (test injection; production builds the Octokit port from `GITHUB_TOKEN`). The route is mounted only when `GITHUB_TOKEN` and `GITHUB_REPO` are both set, decided by the `featureRequestsConfig` value `createApp` already computes (Task 3), which is also what health reports as `features.featureRequests`.

- [ ] **Step 1: Write the failing test**

`tests/api/feature-requests.test.ts`:

```ts
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitHubIssues } from "../../src/services/feature-requests.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";

const URL = "/api/v1/feature-requests";
const body = {
  title: "Bulk accept from the task list",
  problem: "Accepting suggestions one task at a time is slow when many tasks finish together.",
  proposedBehavior: "A checkbox per task on the list and an Accept all suggestions button.",
  acceptanceCriteria: "Given three tasks with suggestions, selecting them and pressing the button accepts every suggestion.",
  outOfScope: "Dismissing in bulk.",
};

class FakeIssues implements GitHubIssues {
  calls: Parameters<GitHubIssues["create"]>[0][] = [];
  fail = false;
  async create(params: Parameters<GitHubIssues["create"]>[0]) {
    this.calls.push(params);
    if (this.fail) throw new Error("GitHub is down");
    return { number: 42, html_url: "https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/42" };
  }
}

let plain: TestContext;
let configured: TestContext;
const issues = new FakeIssues();
beforeAll(async () => {
  plain = await createTestApp();
  configured = await createTestApp(
    { GITHUB_TOKEN: "ghp_test_token", GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line" },
    { github: issues },
  );
});
afterAll(async () => {
  await plain.close();
  await configured.close();
});

describe("POST /feature-requests", () => {
  it("is absent when GITHUB_TOKEN and GITHUB_REPO are not set", async () => {
    const user = await registerUser(plain.app);
    const res = await request(plain.app).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication and validates the body", async () => {
    expect((await request(configured.app).post(URL).send(body)).status).toBe(401);
    const user = await registerUser(configured.app);
    const res = await request(configured.app).post(URL).set(auth(user.token)).send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain("body.problem");
  });

  it("creates a labeled issue carrying the submitter's display name", async () => {
    const user = await registerUser(configured.app, { displayName: "Ada Lovelace" });
    const res = await request(configured.app).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ issueNumber: 42, issueUrl: "https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/42" });
    const call = issues.calls.at(-1)!;
    expect(call).toMatchObject({ owner: "kpnemo", repo: "kaizen-tasks-assembly-line", title: body.title, labels: ["feature-request"] });
    expect(call.body).toContain("Ada Lovelace");
    for (const heading of ["## Problem statement", "## Proposed behavior", "## Acceptance criteria", "## Out of scope"]) {
      expect(call.body).toContain(heading);
    }
    expect(call.body).toContain(body.acceptanceCriteria);
    expect(call.body).not.toContain(user.email);
  });

  it("maps GitHub failures to UPSTREAM_ERROR", async () => {
    const user = await registerUser(configured.app);
    issues.fail = true;
    try {
      const res = await request(configured.app).post(URL).set(auth(user.token)).send(body);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatchObject({ code: "UPSTREAM_ERROR", message: "Could not create the GitHub issue" });
    } finally {
      issues.fail = false;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/api/feature-requests.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/services/feature-requests.js"`.

- [ ] **Step 3: Write `src/services/feature-requests.ts`**

```ts
import { Octokit } from "octokit";
import type { Db } from "../db/client.js";
import { notFound, upstreamError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { findUserById } from "../repositories/users.js";
import type { FeatureRequestInput } from "../schemas/feature-requests.js";

export const FEATURE_REQUEST_LABEL = "feature-request";

export interface GitHubIssues {
  create(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
}

export function createOctokitIssues(token: string): GitHubIssues {
  const octokit = new Octokit({ auth: token });
  return {
    async create(params) {
      const { data } = await octokit.rest.issues.create(params);
      return { number: data.number, html_url: data.html_url };
    },
  };
}

/** Mirrors the assembly-line issue form's sections. Only the display name identifies the submitter. */
export function renderIssueBody(input: FeatureRequestInput, submitterName: string): string {
  return [
    "## Problem statement",
    "",
    input.problem,
    "",
    "## Proposed behavior",
    "",
    input.proposedBehavior,
    "",
    "## Acceptance criteria",
    "",
    input.acceptanceCriteria,
    "",
    "## Out of scope",
    "",
    input.outOfScope?.trim() ? input.outOfScope : "_Not specified._",
    "",
    "---",
    `Submitted from Kaizen Tasks by **${submitterName}**.`,
    "",
  ].join("\n");
}

export interface FeatureRequestsService {
  submit(userId: string, input: FeatureRequestInput): Promise<{ issueNumber: number; issueUrl: string }>;
}

export function createFeatureRequestsService(deps: {
  db: Db;
  issues: GitHubIssues;
  repo: string;
  logger: Logger;
}): FeatureRequestsService {
  const [owner, repo] = deps.repo.split("/") as [string, string];
  return {
    async submit(userId, input) {
      const user = await findUserById(deps.db, userId);
      if (!user) throw notFound("User not found");
      try {
        const issue = await deps.issues.create({
          owner,
          repo,
          title: input.title,
          body: renderIssueBody(input, user.displayName),
          labels: [FEATURE_REQUEST_LABEL],
        });
        return { issueNumber: issue.number, issueUrl: issue.html_url };
      } catch (err) {
        deps.logger.error({ err, repo: deps.repo }, "github issue creation failed");
        throw upstreamError("Could not create the GitHub issue");
      }
    },
  };
}
```

- [ ] **Step 4: Write `src/routes/feature-requests.ts` and mount**

`src/routes/feature-requests.ts`:

```ts
import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData } from "../lib/envelope.js";
import { FeatureRequestBody } from "../schemas/feature-requests.js";
import type { FeatureRequestsService } from "../services/feature-requests.js";
import { validate, validated } from "./validate.js";

const submitSchemas = { body: FeatureRequestBody };

export function featureRequestsRouter(service: FeatureRequestsService): Router {
  const router = Router();
  router.post("/", validate(submitSchemas), async (req, res) => {
    const { body } = validated<typeof submitSchemas>(res);
    sendData(res, await service.submit(currentUser(req).id, body), { status: 201 });
  });
  return router;
}
```

In `src/app.ts`: add to `AppDeps`

```ts
  /** Test injection for the GitHub port. Production builds one from GITHUB_TOKEN. */
  github?: GitHubIssues;
```

with imports

```ts
import { featureRequestsRouter } from "./routes/feature-requests.js";
import { createFeatureRequestsService, createOctokitIssues, type GitHubIssues } from "./services/feature-requests.js";
```

and mount after `/tasks`, on the `featureRequestsConfig` value that `createApp` computed for the health flag (so `features.featureRequests` is true exactly when this block runs):

```ts
  if (featureRequestsConfig) {
    const issues = deps.github ?? createOctokitIssues(featureRequestsConfig.token);
    const featureRequests = createFeatureRequestsService({
      db,
      issues,
      repo: featureRequestsConfig.repo,
      logger,
    });
    api.use("/feature-requests", requireAuth(config), featureRequestsRouter(featureRequests));
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/api/feature-requests.test.ts`
Expected:

```
 ✓ tests/api/feature-requests.test.ts (4 tests)
```

- [ ] **Step 6: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/services/feature-requests.ts src/routes/feature-requests.ts src/app.ts tests/api/feature-requests.test.ts
git commit -F - <<'MSG'
feat: file feature requests as labeled GitHub issues

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 20: Server startup sequence and graceful shutdown

**Files:**
- Create: `src/lib/assets.ts`
- Modify: `src/server.ts` (replaces the provisional version)
- Test: `src/lib/assets.test.ts`

**Interfaces:**
- Consumes: Task 15 `createBreakdownModel`, `promptPath`; Task 8 `runMigrations`, `MIGRATIONS_FOLDER`, `createDb`; Task 18 `ensureDemoSeed`; Task 17 `startBreakdownWorker`, `startReconciler`; Task 9 `createBreakdownQueue`, `createRedis`; Task 10 `createApp`.
- Produces: `src/lib/assets.ts`: `interface RuntimeAsset { name: string; path: string }`, `missingAssets(assets)`, `assertRuntimeAssets(assets)` (throws with every missing path listed). `src/server.ts` runs the seven startup steps from spec 2.1 in order, listens on `PORT` host `::`, and shuts down cleanly on SIGTERM and SIGINT.

- [ ] **Step 1: Write the failing test**

`src/lib/assets.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRuntimeAssets, missingAssets } from "./assets.js";

describe("runtime assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaizen-assets-"));
  const present = join(dir, "present.txt");
  writeFileSync(present, "x");
  const absent = join(dir, "absent", "file.md");

  it("lists missing assets and passes when everything exists", () => {
    expect(missingAssets([{ name: "present", path: present }])).toEqual([]);
    expect(missingAssets([{ name: "present", path: present }, { name: "prompt", path: absent }])).toEqual([
      { name: "prompt", path: absent },
    ]);
    expect(() => assertRuntimeAssets([{ name: "present", path: present }])).not.toThrow();
  });

  it("fails fast naming every missing path", () => {
    expect(() =>
      assertRuntimeAssets([
        { name: "prompt", path: absent },
        { name: "openapi.json", path: join(dir, "openapi.json") },
      ]),
    ).toThrow(`Missing runtime assets:\n  - prompt: ${absent}\n  - openapi.json: ${join(dir, "openapi.json")}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/assets.test.ts`
Expected: FAIL, `Failed to resolve import "./assets.js"`.

- [ ] **Step 3: Write `src/lib/assets.ts`**

```ts
import { existsSync } from "node:fs";

export interface RuntimeAsset {
  name: string;
  path: string;
}

export function missingAssets(assets: RuntimeAsset[]): RuntimeAsset[] {
  return assets.filter((asset) => !existsSync(asset.path));
}

/** Startup step 2: fail fast with the resolved paths before the port opens. */
export function assertRuntimeAssets(assets: RuntimeAsset[]): void {
  const missing = missingAssets(assets);
  if (missing.length === 0) return;
  throw new Error(
    `Missing runtime assets:\n${missing.map((m) => `  - ${m.name}: ${m.path}`).join("\n")}`,
  );
}
```

- [ ] **Step 4: Replace `src/server.ts` with the full startup sequence**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBreakdownModel } from "./agent/model.js";
import { promptPath } from "./agent/prompt.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { MIGRATIONS_FOLDER, runMigrations } from "./db/migrate.js";
import { ensureDemoSeed } from "./db/seed.js";
import { createBreakdownQueue } from "./jobs/queue.js";
import { startReconciler } from "./jobs/reconcile.js";
import { startBreakdownWorker, type BreakdownWorker } from "./jobs/worker.js";
import { assertRuntimeAssets } from "./lib/assets.js";
import { createLogger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";

export const OPENAPI_PATH = resolve(process.cwd(), "openapi.json");
const SHUTDOWN_TIMEOUT_MS = 15_000;

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  // 1. Config: print every missing or invalid variable and exit non-zero.
  const config = readConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // 2. Runtime assets, with resolved paths in the failure message.
  assertRuntimeAssets([
    { name: "system prompt", path: promptPath() },
    { name: "migrations folder", path: MIGRATIONS_FOLDER },
    { name: "openapi.json", path: OPENAPI_PATH },
  ]);

  // 3. Migrations.
  const { db, sql } = createDb(config.DATABASE_URL);
  await runMigrations(db);
  logger.info({ folder: MIGRATIONS_FOLDER }, "migrations applied");

  // 4. Redis.
  const redis = createRedis(config.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.ping();
  logger.info("redis connected");

  // 5. Demo seed.
  if (config.SEED_DEMO_USER) {
    const seeded = await ensureDemoSeed(db, config.SEED_DEMO_PASSWORD);
    logger.info({ demoUserId: seeded.demoUserId, created: seeded.created }, "demo seed checked");
  }

  // 6. Worker and reconciler.
  const model = createBreakdownModel({
    provider: config.AI_MODEL_PROVIDER,
    model: config.AI_MODEL,
    apiKey: config.ANTHROPIC_API_KEY,
  });
  const queueConnection = createRedis(config.REDIS_URL);
  const queue = createBreakdownQueue(queueConnection);
  let worker: BreakdownWorker | undefined;
  let workerConnection: ReturnType<typeof createRedis> | undefined;
  let reconciler: { stop(): void } | undefined;
  if (config.WORKER_ENABLED) {
    workerConnection = createRedis(config.REDIS_URL);
    worker = startBreakdownWorker({ connection: workerConnection, db, model, logger });
    reconciler = startReconciler({ db, staleMinutes: config.AI_STALE_MINUTES, logger });
    logger.info({ provider: config.AI_MODEL_PROVIDER, model: config.AI_MODEL }, "worker and reconciler started");
  }

  // 7. App. Host :: is dual-stack; some Railway environments resolve private hostnames to IPv6 only.
  const app = createApp({ config, db, redis, queue, model, logger });
  const server = app.listen(config.PORT, "::", () => {
    logger.info(
      { port: config.PORT, env: config.APP_ENV, commit: config.RAILWAY_GIT_COMMIT_SHA },
      "api listening",
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const forceExit = setTimeout(() => {
      logger.error("shutdown timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    server.close(() => {
      void (async () => {
        reconciler?.stop();
        await worker?.close();
        await queue.close();
        await Promise.all([workerConnection?.quit(), queueConnection.quit(), redis.quit()]);
        await sql.end();
        logger.info("shutdown complete");
        process.exit(0);
      })().catch((err: unknown) => {
        logger.error({ err }, "shutdown failed");
        process.exit(1);
      });
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the unit test, then exercise the real startup**

Run: `npx vitest run --project unit src/lib/assets.test.ts`
Expected: `✓ src/lib/assets.test.ts (2 tests)`.

Set the local `.env` to `AI_MODEL_PROVIDER=fake`, `WORKER_ENABLED=true`, `SEED_DEMO_USER=true`, then:

Run: `npm run build && (npm start & echo $! > /tmp/kaizen-api.pid; sleep 3; curl -s http://localhost:3000/api/v1/health; echo; kill -TERM $(cat /tmp/kaizen-api.pid); sleep 2)`
Expected: log lines in this order: `migrations applied`, `redis connected`, `demo seed checked`, `worker and reconciler started`, `api listening`; the curl prints `{"data":{"status":"ok","commit":"local","env":"development","checks":{"db":"ok","redis":"ok"},"features":{"featureRequests":false}},...}`; after the signal: `shutting down` then `shutdown complete`.

Run: `mv openapi.json openapi.json.bak; npm start; echo "exit=$?"; mv openapi.json.bak openapi.json`
Expected: `Missing runtime assets:` with `  - openapi.json: /.../webapp/backend/openapi.json`, and `exit=1`, before any `migrations applied` line.

End-to-end with the fake model (the worker in-process): register, create a task, read it back after a moment:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' -d '{"email":"e2e@kaizen.local","password":"password123","displayName":"E2E"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).data.accessToken))')
ID=$(curl -s -X POST localhost:3000/api/v1/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"Plan the Q4 team offsite"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).data.id))')
sleep 2; curl -s localhost:3000/api/v1/tasks/$ID -H "authorization: Bearer $TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).data;console.log(t.aiStatus,t.children.length,t.aiTagSuggestions)})'
```

Expected: `done 4 [ 'planning', 'writing' ]` (run with the server started as above).

- [ ] **Step 6: Full suite, typecheck, lint, commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build && bash scripts/check-dist-assets.sh`
Expected: all green, `check-dist-assets: OK`.

```bash
git add src/lib/assets.ts src/lib/assets.test.ts src/server.ts
git commit -F - <<'MSG'
feat: startup sequence with asset checks, migrations, seed, worker and graceful shutdown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 21: Documentation set

**Files:**
- Create: `docs/ARCHITECTURE.md`, `docs/adr/0001-single-task-table.md`, `docs/adr/0002-same-origin-through-web-proxy.md`, `docs/adr/0003-in-process-worker.md`, `docs/adr/0004-additive-migrations-only.md`, `docs/architectural-files.txt`
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything built so far; the file names here are referenced by `scripts/docs-check.sh` (Task 22) and by the skills (Task 23).
- Produces: the docs set from spec 8.1 and 8.6; `docs/architectural-files.txt` is the manifest Rule C reads.

- [ ] **Step 1: Write `docs/architectural-files.txt`**

```
# One glob per line. ** matches any number of path segments.
# A change to any matching file requires adding or updating an ADR under docs/adr/.
src/db/schema.ts
drizzle/**
src/jobs/**
src/lib/auth.ts
src/agent/prompts/**
.railway/**
```

- [ ] **Step 2: Write the four ADRs**

`docs/adr/0001-single-task-table.md`:

```markdown
# 0001: One task table with a nullable parent

- Status: Accepted
- Date: 2026-09-08

## Context

The product needs tasks with ordered subtasks (PRD R6). Subtasks carry the same fields as tasks
plus an origin (user or AI) and, for AI-suggested rows, a suggestion state. Two designs were
possible: a separate `subtasks` table with its own routes, or one `tasks` table where a subtask
is a task with a parent. PRD decision D30 settles on the latter; this record explains the shape.

## Decision

One `tasks` table with a nullable `parent_id` (foreign key to `tasks`, cascade delete). A row is
a root when `parent_id` is null. Children share every column with roots; `origin`,
`suggestion_state` and `rationale` are only meaningful on AI-created children, and a check
constraint keeps `suggestion_state` non-null exactly when `origin = 'ai'`.

Depth is not stored. The service constant `MAX_TASK_DEPTH = 2` in `src/services/tasks.ts`
means a child may only be created under a root and breakdown may only run on a root.

Ordering among siblings is `position`, then `created_at`, then `id`, backed by the
`tasks_parent_position_idx` index. `PATCH /tasks/:id` with `position` is a target index; the
service renumbers siblings densely in one transaction.

Progress (`{ done, total }`) counts children with origin `user` or suggestion state `accepted`,
computed in SQL as an aggregate over children.

## Consequences

- Fewer endpoints: every subtask operation is a task operation with `parentId`.
- "Break a step down further" becomes a one-line change (raise the constant, add a recursive
  load in the repository).
- Listing roots must always filter `parent_id is null`; the repository's `siblingScope` does this
  so no caller forgets.
- The check constraint means the seed and the processor must always set `suggestion_state` when
  inserting AI rows.
```

`docs/adr/0002-same-origin-through-web-proxy.md`:

```markdown
# 0002: Same-origin API through the web service's proxy

- Status: Accepted
- Date: 2026-09-08

## Context

The web app needs to call the API with a refresh token that browsers protect (httpOnly cookie)
and an access token in memory. Serving the API on its own public domain would require CORS with
credentials, a cookie domain shared across two hosts, and one more public surface to harden.
PRD decision D31 chose same-origin; this record covers the API side.

## Decision

The API has no public domain. On Railway the `web` service (a static site behind Caddy) proxies
`/api/*` to `http://api.railway.internal:3000` over private networking; locally, Vite's dev proxy
does the same to `http://localhost:3000`. The API pins `PORT=3000` and listens on host `::` so
IPv6-only private DNS resolution works.

The refresh token is a first-party cookie: `kaizen_refresh`, httpOnly, `SameSite=Lax`,
`Path=/api/v1/auth`, seven days, `Secure` outside development and test. Access tokens are
15-minute HS256 JWTs sent as `Authorization: Bearer`. There is no CORS middleware.

## Consequences

- No CORS configuration anywhere; a request from a foreign origin cannot carry the cookie.
- The API's health endpoint is reached through the web domain (`https://<web>/api/v1/health`),
  which is what the promote workflow and the smoke test use.
- `app.set("trust proxy", 1)` is required so `Secure` cookies and request logging see the
  original scheme and client behind Caddy.
- If the web service is down, the API is unreachable from outside; that is acceptable because
  the API has no consumers other than the web app.
```

`docs/adr/0003-in-process-worker.md`:

```markdown
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
```

`docs/adr/0004-additive-migrations-only.md`:

```markdown
# 0004: Migrations are additive only

- Status: Accepted
- Date: 2026-09-08

## Context

Migrations run at API startup, before the port opens (PRD P6). Rollback on Railway is "redeploy
the previous deployment": the previous application version starts against a database that the
newer version has already migrated. If a migration dropped or renamed something the previous
version reads, rollback would fail at startup or at the first query, which is the moment rollback
is needed most.

## Decision

Every migration must be backward compatible with the previous application version:

- Allowed: add a table; add a column with a default or nullable; add an index; add an enum value;
  add a check constraint that existing rows already satisfy.
- Not allowed in the same release: drop a column or table, rename a column or table, change a
  column type, tighten a constraint existing rows violate, remove an enum value.

Removing something takes two releases: release N stops reading and writing it; release N+1, after
N has been in production, drops it.

Migrations are generated by `drizzle-kit generate` from `src/db/schema.ts` into `drizzle/`, are
committed, and are applied by `src/db/migrate.ts` at startup and by the test global setup.
`src/db/schema.ts` and `drizzle/**` are architectural files: changing them requires an ADR, which
is where the compatibility argument for a non-trivial migration is written down.

## Consequences

- Rollback is always safe from the database's point of view.
- Schema cleanup is slower and deliberate.
- Reviewers check migrations against the allowed list; the `reviewer` agent checks for `DROP`,
  `RENAME`, and `ALTER COLUMN ... TYPE` in new migration files.
```

- [ ] **Step 3: Write `docs/ARCHITECTURE.md`**

```markdown
# Architecture

Kaizen Tasks API is one Node 24 process: an Express 5 HTTP API plus, behind `WORKER_ENABLED`, a
BullMQ worker and a reconciler. Postgres holds all durable state; Redis holds refresh tokens,
hourly rate-limit counters, and the queue. Nothing that must survive a Redis flush lives in Redis.

## Shape

| Concern | Where | Notes |
|---|---|---|
| Startup | `src/server.ts` | Config, asset checks, migrations, Redis, seed, worker, listen; in that order, exit non-zero on any failure |
| HTTP app | `src/app.ts` | `createApp(deps)` so tests build the same app over the test database with a fake queue and a fake model |
| Validation | `src/routes/validate.ts` | zod schemas from `src/schemas/`, parsed values in `res.locals.validated`; `req.query` is never assigned (Express 5) |
| Envelopes and errors | `src/lib/envelope.ts`, `src/lib/errors.ts`, `src/lib/error-handler.ts` | One success shape, one error shape, one `statusFor(code)` |
| Auth | `src/lib/auth.ts`, `src/services/auth.ts` | HS256 access token (15 min), Redis-backed refresh token in an httpOnly cookie (ADR 0002) |
| Data | `src/db/schema.ts`, `src/repositories/*` | Drizzle over postgres.js; one `tasks` table with `parent_id` (ADR 0001); additive migrations (ADR 0004) |
| Business rules | `src/services/*` | Ownership checks (misses are `NOT_FOUND`), depth rule, position reorder, suggestion transitions, rate limit |
| AI pipeline | `src/jobs/*`, `src/agent/*` | Queue, processor, worker (ADR 0003), reconciler, model seam, prompt |
| Contract | `src/schemas/*`, `openapi.json`, `docs/API.md` | Generated by `npm run openapi`; the web app builds its client from `openapi.json` |

Layering: routes call services, services call repositories and the queue, repositories call
Drizzle. Handlers never touch Drizzle; services never import Express types. The full table is in
`CLAUDE.md`.

## Request path

`helmet` → JSON body (64 kB limit) → cookie parser → request id (`x-request-id` in, header and
envelope out) → pino-http (one line per request with method, url, status, response time,
request id, user id) → `/api/v1` routers → 404 handler → error handler.

## AI breakdown pipeline

```mermaid
flowchart LR
  A[POST /tasks or /tasks/:id/breakdown] --> B{consume rate limit}
  B -- ai_disabled or denied on create --> S[ai_status = skipped + reason]
  B -- denied on breakdown --> E429[429 RATE_LIMITED / 503 UNAVAILABLE]
  B -- allowed --> R[reserve generation_id\nUPDATE ... WHERE ai_status NOT IN pending, running]
  R -- no row --> E409[409 CONFLICT]
  R -- row --> Q[enqueue job id taskId-generationId]
  Q -- enqueue throws --> F1[ai_status = failed: could not queue]
  Q --> W[worker: load task, match generation_id]
  W -- mismatch --> X[complete silently]
  W -- too short --> SK[skipped: too_short]
  W --> RUN[ai_status = running]
  RUN --> M[breakdownTask: model.complete + post-validate]
  M -- refused / invalid / 4xx --> F2[ai_status = failed + message]
  M -- 429 / 5xx / timeout --> RETRY[throw: BullMQ retries x3]
  RETRY -- exhausted --> F3[failed: assistant unavailable]
  M -- ok --> P[one transaction guarded by generation_id:\nreplace suggested children, set tag suggestions, done]
  REC[reconciler every 5 min] -. pending/running older than AI_STALE_MINUTES .-> F4[failed: timed out]
```

Every write on the worker side carries `WHERE generation_id = <job's>`, so a superseded job can
never overwrite a newer generation. The concurrency guard is the conditional update, not the
queue.

Rate limits: `ratelimit:breakdown:<userId>:<YYYYMMDDHH>` (default 20 per hour) and
`ratelimit:breakdown:global:<YYYYMMDDHH>` (default 300 per hour, the session budget). A denied
consume decrements what it incremented. `AI_ENABLED=false` is the operator kill switch: creates
still succeed with `ai_skip_reason = ai_disabled`; the explicit breakdown action returns
`UNAVAILABLE`.

The model seam is `BreakdownModel.complete(input) -> { kind: ok | refused | invalid }`. The
Anthropic adapter uses `messages.parse` with a zod output format, `maxRetries: 0`, and a 45-second
timeout. The fake adapter returns fixtures and can refuse, garble, or fail retryably. The system
prompt is `src/agent/prompts/breakdown.system.md`, copied into `dist/` by the build and asserted
at startup.

## Deploy topology

Railway project `kaizen-tasks`, environments `staging` (tracks `develop`) and `production`
(tracks `main`). Each environment has services `api` (this repo, private hostname
`api.railway.internal`, `PORT=3000`, no public domain), `web` (static site behind Caddy, proxies
`/api/*` to the API), `Postgres`, and `Redis`. The `api` service is declared in
`.railway/railway.ts` (including `source.checkSuites: true`, which is wait-for-CI) and applied with
`railway config apply` per environment.

Flow: merge to `develop` → GitHub Actions `ci` (typecheck, lint, tests against service
containers, docs check, build, dist-asset check) → Railway deploys staging after `ci` passes →
health check `/api/v1/health` → traffic switches. A pull request `develop` → `main` runs `promote`,
which waits until staging serves the candidate SHA and runs the shared smoke package. Rollback is
Railway's redeploy of the previous deployment, safe because migrations are additive (ADR 0004).

## Operations

- Health: `GET /api/v1/health` returns `{ status, commit, env, checks: { db, redis }, features: { featureRequests } }`,
  503 with `UNAVAILABLE` when a check fails. `featureRequests` is true exactly when
  `POST /api/v1/feature-requests` is mounted (`GITHUB_TOKEN` and `GITHUB_REPO` both set).
- Demo reset: `POST /api/v1/admin/seed-reset` with `x-admin-token` recreates `demo@kaizen.local`
  and its fixtures with stable ids; `npm run db:seed -- --reset` does the same locally.
- Kill switch and budget: `AI_ENABLED`, `AI_RATE_LIMIT_PER_HOUR`, `AI_GLOBAL_LIMIT_PER_HOUR` are
  Railway variables; changing them restarts the service without a deploy.
- Stuck generations: the reconciler fails anything pending or running for longer than
  `AI_STALE_MINUTES` with "Timed out, try again"; the user sees a retry control, never an
  indefinite spinner.
```

- [ ] **Step 4: Complete `CLAUDE.md`**

Replace the file with this version (under one page):

```markdown
# CLAUDE.md

Kaizen Tasks API: a personal task manager's backend where an AI assistant proposes small steps and
the human decides. Express 5 on Node 24, Postgres through Drizzle, Redis and BullMQ, Anthropic SDK.
Spec: `docs/superpowers/specs/2026-09-08-kaizen-tasks-api-design.md`. Architecture: `docs/ARCHITECTURE.md`.

## Layering

| Layer | May import |
|---|---|
| `src/routes` | `schemas`, `services`, `lib` |
| `src/services` | `repositories`, `agent`, `jobs/queue`, `lib` |
| `src/repositories` | `db`, `lib` |
| `src/jobs` | `services`, `repositories`, `agent`, `lib` |
| `src/agent` | `lib`, `schemas` |
| `src/lib`, `src/db`, `src/schemas` | nothing app-level above them (`schemas` may import `lib/errors` for the code list; `db/seed.ts` may import `lib/auth` for hashing) |

`import type` from `src/schemas` is allowed anywhere. Handlers never touch Drizzle. Services never import Express types.

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

| Script | Does |
|---|---|
| `npm run dev` / `npm start` | tsx watch / node dist |
| `npm test` / `npm run test:live` | vitest unit and integration / opt-in live model test |
| `npm run lint` / `npm run typecheck` | eslint and prettier / tsc |
| `npm run db:generate` / `db:migrate` / `db:seed [-- --reset]` | drizzle-kit generate / apply migrations / demo fixtures |
| `npm run openapi [-- --check]` | regenerate `openapi.json` and `docs/API.md` / detect drift |
| `npm run docs:check` | the Stop hook check, by hand |

Local setup: `README.md`, "Run locally".
```

- [ ] **Step 5: Complete `README.md` and `CHANGELOG.md`**

Append these sections to `README.md` after "Documentation":

```markdown
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

## Operator switches

`AI_ENABLED=false` pauses the assistant (creates still succeed, skipped with reason
`ai_disabled`; the breakdown action returns 503 `UNAVAILABLE`). `AI_RATE_LIMIT_PER_HOUR` and
`AI_GLOBAL_LIMIT_PER_HOUR` bound breakdowns per user and per environment per hour. All three are
Railway variables and take effect on restart without a deploy.
```

Replace the `[Unreleased]` section of `CHANGELOG.md` with:

```markdown
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
- Drizzle schema (`users`, `tasks` with `parent_id`, `tags`, `task_tags`) and the initial additive migration.
- Registration, login, refresh-token rotation, logout and `GET /auth/me`.
- Tags CRUD with case-insensitive uniqueness per user.
- Tasks: create (root creates enqueue a breakdown), get with children and SQL progress, keyset list with status and tag filters, update with dense position reorder and suggestion-state transitions, delete with cascade, accept-all, dismiss-all, replace tags. Every task summary carries `suggestionCount` and `aiError` so the list needs no per-row detail query.
- AI breakdown pipeline: BullMQ queue and in-process worker, generation-id guarded processor, Anthropic adapter with structured output, fake adapter for tests, hourly user and global rate limits, `AI_ENABLED` kill switch, stale-generation reconciler.
- Demo seed with stable ids, `npm run db:seed`, and `POST /api/v1/admin/seed-reset` behind `ADMIN_TOKEN`.
- `POST /api/v1/feature-requests` filing labeled GitHub issues when `GITHUB_TOKEN` and `GITHUB_REPO` are set.
- Startup sequence with runtime asset checks, migrations, Redis ping, seed, worker and graceful shutdown.
- Documentation set: architecture, four ADRs, generated API reference, this changelog, `CLAUDE.md`.
```

- [ ] **Step 6: Check formatting and links, commit**

Run: `npm run lint && ls docs/adr && grep -c "" docs/architectural-files.txt`
Expected: prettier passes (run `npx prettier --write docs README.md CLAUDE.md CHANGELOG.md` first if it complains); `ls` shows the four ADR files; the manifest has 8 lines.

```bash
git add docs/ARCHITECTURE.md docs/adr docs/architectural-files.txt README.md CLAUDE.md CHANGELOG.md
git commit -F - <<'MSG'
docs: architecture, four ADRs, architectural-files manifest, full README and CLAUDE.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 22: docs-check, format-file, hooks, and the CI docs step

**Files:**
- Create: `scripts/docs-check.sh`, `scripts/format-file.sh`, `.claude/settings.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 21 `docs/architectural-files.txt`, `CHANGELOG.md`; Task 5 `npm run openapi -- --check`.
- Produces: `scripts/docs-check.sh --hook|--ci` implementing spec 8.2 exactly (changed set, code set, Rules A, B, C, fix messages, exit 2 in hook mode, the three-strikes escape hatch that exits 1 and writes `.claude/DOCS-CHECK-FAILED`, counter in `.claude/.docs-check-blocks`; in hook mode it reads Claude Code's stdin JSON and uses `stop_hook_active` to count blocks per continuation chain); `scripts/format-file.sh` reading the PostToolUse JSON from stdin; `.claude/settings.json` wiring both hooks; the `docs check` step in `ci.yml` with `BASE_SHA`. Cross-lane interface: `scripts/docs-check.sh --hook` exits 2 on failure with the fix list on stdout and never exits 0 while printing FAILED.

- [ ] **Step 1: Write `scripts/docs-check.sh`**

```bash
#!/usr/bin/env bash
# Docs-drift check. Same script for the Claude Code Stop hook (--hook) and CI (--ci).
# Rules (spec 8.2):
#   A: code changed  -> CHANGELOG.md changed and [Unreleased] has a bullet
#   B: routes/schemas changed -> npm run openapi -- --check passes
#   C: architectural file changed -> an ADR under docs/adr/ changed
set -uo pipefail

MODE="${1:-}"
if [[ "$MODE" != "--hook" && "$MODE" != "--ci" ]]; then
  echo "usage: scripts/docs-check.sh --hook | --ci" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COUNTER_FILE=".claude/.docs-check-blocks"
MARKER_FILE=".claude/DOCS-CHECK-FAILED"
MAX_BLOCKS=3

# Claude Code feeds the Stop hook a JSON object on stdin. `stop_hook_active` is true when this stop
# is itself the continuation forced by an earlier block, so "consecutive" blocks are counted within
# one continuation chain: an explicit false (a fresh stop) restarts the count. A missing or
# unparseable payload (manual runs, other callers) leaves the counter's legacy behaviour alone.
STOP_HOOK_ACTIVE=""
if [[ "$MODE" == "--hook" && ! -t 0 ]]; then
  HOOK_INPUT="$(cat || true)"
  if [[ -n "$HOOK_INPUT" ]]; then
    STOP_HOOK_ACTIVE="$(printf '%s' "$HOOK_INPUT" | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const v = JSON.parse(d).stop_hook_active;
          process.stdout.write(v === true ? "true" : v === false ? "false" : "");
        } catch {
          process.stdout.write("");
        }
      });
    ')"
  fi
fi

root_commit() { git rev-list --max-parents=0 HEAD | tail -n 1; }

# 1. Changed set.
if [[ "$MODE" == "--hook" ]]; then
  if git rev-parse --verify -q origin/develop >/dev/null; then
    BASE="$(git merge-base HEAD origin/develop)"
  elif git rev-parse --verify -q develop >/dev/null; then
    BASE="$(git merge-base HEAD develop)"
  else
    BASE="$(root_commit)"
  fi
  CHANGED="$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } | sort -u )"
else
  : "${BASE_SHA:?BASE_SHA is required in --ci mode}"
  if [[ "$BASE_SHA" =~ ^0+$ ]] || ! git cat-file -e "$BASE_SHA" 2>/dev/null; then
    BASE_SHA="$(root_commit)"
  fi
  CHANGED="$( { git diff --name-only "$BASE_SHA...HEAD" 2>/dev/null || git diff --name-only "$BASE_SHA" HEAD; } | sort -u )"
fi

if [[ -z "$CHANGED" ]]; then
  echo "docs-check: no changes"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

# 2. Code set and architectural matches.
CODE_SET="$(grep -E '^(src/|drizzle/|\.railway/|scripts/|package\.json$)' <<<"$CHANGED" || true)"

match_glob() {
  local pattern="${1//\*\*/*}"
  [[ "$2" == $pattern ]]
}

ARCH_MATCHES=""
if [[ -f docs/architectural-files.txt ]]; then
  while IFS= read -r glob; do
    [[ -z "$glob" || "$glob" == \#* ]] && continue
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      if match_glob "$glob" "$file"; then
        ARCH_MATCHES+="$file"$'\n'
      fi
    done <<<"$CHANGED"
  done < docs/architectural-files.txt
fi

if [[ -z "$CODE_SET" && -z "$ARCH_MATCHES" ]]; then
  echo "docs-check: no code or architectural changes"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

unreleased_has_bullet() {
  awk '
    /^## \[Unreleased\]/ { inside = 1; next }
    /^## / { if (inside) exit }
    inside && /^[[:space:]]*[-*] / { found = 1; exit }
    END { exit found ? 0 : 1 }
  ' CHANGELOG.md
}

FAILURES=()

# 3. Rule A.
if [[ -n "$CODE_SET" ]]; then
  if ! grep -qx 'CHANGELOG.md' <<<"$CHANGED"; then
    FAILURES+=("Rule A: code changed but CHANGELOG.md did not. Fix: add a bullet under [Unreleased] in CHANGELOG.md")
  elif ! unreleased_has_bullet; then
    FAILURES+=("Rule A: CHANGELOG.md [Unreleased] has no bullet. Fix: add a bullet under [Unreleased] in CHANGELOG.md")
  fi
fi

# 4. Rule B.
if grep -qE '^src/(routes|schemas)/' <<<"$CHANGED"; then
  if ! npm run --silent openapi -- --check >/dev/null 2>&1; then
    FAILURES+=("Rule B: routes or schemas changed and openapi.json or docs/API.md is stale. Fix: run npm run openapi and commit")
  fi
fi

# 5. Rule C, independent of Rule A.
if [[ -n "$ARCH_MATCHES" ]]; then
  if ! grep -qE '^docs/adr/[^/]+\.md$' <<<"$CHANGED"; then
    LIST="$(printf '%s' "$ARCH_MATCHES" | sort -u | tr '\n' ' ')"
    FAILURES+=("Rule C: architectural files changed (${LIST}) without an ADR. Fix: add or update an ADR under docs/adr/")
  fi
fi

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "docs-check: OK"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

# 6. Failure output with the exact fix per rule.
MESSAGE="DOCS CHECK FAILED"$'\n'
for failure in "${FAILURES[@]}"; do
  MESSAGE+="  - ${failure}"$'\n'
done

if [[ "$MODE" == "--ci" ]]; then
  printf '%s' "$MESSAGE"
  exit 1
fi

# 7. Hook mode: block (exit 2) up to MAX_BLOCKS consecutive times, then stop blocking but never report success.
mkdir -p .claude
if [[ "$STOP_HOOK_ACTIVE" == "false" ]]; then
  rm -f "$COUNTER_FILE" # a fresh stop, not a continuation of an earlier block: the count starts over
fi
COUNT=$(( $(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$COUNTER_FILE"

printf '%s' "$MESSAGE"
printf '%s' "$MESSAGE" >&2

if (( COUNT > MAX_BLOCKS )); then
  printf '%s' "$MESSAGE" > "$MARKER_FILE"
  BANNER="DOCS CHECK FAILED, human intervention required (blocked ${MAX_BLOCKS} times; no longer blocking; see ${MARKER_FILE}; CI will still fail)"
  echo "$BANNER"
  echo "$BANNER" >&2
  exit 1
fi

echo "(block ${COUNT} of ${MAX_BLOCKS})" >&2
exit 2
```

Run: `chmod +x scripts/docs-check.sh`

- [ ] **Step 2: Write `scripts/format-file.sh`**

```bash
#!/usr/bin/env bash
# PostToolUse hook for Edit|Write: reads the tool input JSON from stdin and runs prettier on the
# edited file when it is inside this repository and has a formattable extension. Never fails the tool.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    try {
      const j = JSON.parse(d);
      process.stdout.write(String(j.tool_input?.file_path ?? ""));
    } catch {
      process.stdout.write("");
    }
  });
')"
[[ -z "$FILE" ]] && exit 0

case "$FILE" in
  /*) ABS="$FILE" ;;
  *) ABS="$ROOT/$FILE" ;;
esac
DIR="$(cd "$(dirname "$ABS")" 2>/dev/null && pwd)" || exit 0
ABS="$DIR/$(basename "$ABS")"

[[ "$ABS" == "$ROOT/"* ]] || exit 0
[[ -f "$ABS" ]] || exit 0

case "$ABS" in
  *.ts|*.js|*.mjs|*.cjs|*.json|*.md|*.yml|*.yaml) ;;
  *) exit 0 ;;
esac

cd "$ROOT" && npx prettier --write --log-level warn "$ABS" >/dev/null 2>&1 || true
exit 0
```

Run: `chmod +x scripts/format-file.sh`

- [ ] **Step 3: Write `.claude/settings.json`**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/docs-check.sh --hook"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/format-file.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Add the CI step**

In `.github/workflows/ci.yml`, insert between `- run: npm test` and `- run: npm run build`:

```yaml
      - name: docs check
        run: bash scripts/docs-check.sh --ci
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}
```

- [ ] **Step 5: Verify every rule by hand**

Clean tree (the new files are untracked, so the changed set is non-empty but contains no code paths other than `scripts/`; commit first to get a clean baseline):

```bash
git add scripts/docs-check.sh scripts/format-file.sh .claude/settings.json .github/workflows/ci.yml
git commit -F - <<'MSG'
feat: docs-check and format hooks, docs check in CI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

Note: this commit itself changes `scripts/` and `.github/`, which is code per Rule A; the `[Unreleased]` section already has bullets and `CHANGELOG.md` is amended below, so the CI run for this push passes once the changelog bullet lands in the next commit. To keep the push green, add the bullet before pushing (Step 6).

Rule A and the escape hatch:

Run: `bash scripts/docs-check.sh --hook; echo "exit=$?"`
Expected: `docs-check: no changes` and `exit=0` (when HEAD equals `origin/develop` or `develop`).

Feed the hook the JSON Claude Code sends on stdin: the first stop of a chain carries `stop_hook_active: false`, every stop forced by a block carries `true`.

Run: `echo "// touched" >> src/lib/errors.ts; for i in 1 2 3 4; do active=$([[ $i -eq 1 ]] && echo false || echo true); printf '{"stop_hook_active":%s}' "$active" | bash scripts/docs-check.sh --hook >/dev/null 2>/tmp/dc.err; echo "run $i exit=$? counter=$(cat .claude/.docs-check-blocks)"; done; tail -n 2 /tmp/dc.err; ls .claude/DOCS-CHECK-FAILED`
Expected:

```
run 1 exit=2 counter=1
run 2 exit=2 counter=2
run 3 exit=2 counter=3
run 4 exit=1 counter=4
DOCS CHECK FAILED, human intervention required (blocked 3 times; no longer blocking; see .claude/DOCS-CHECK-FAILED; CI will still fail)
.claude/DOCS-CHECK-FAILED
```

Run: `printf '{"stop_hook_active":false}' | bash scripts/docs-check.sh --hook >/dev/null 2>&1; echo "fresh stop exit=$? counter=$(cat .claude/.docs-check-blocks)"; ls .claude/DOCS-CHECK-FAILED`
Expected: `fresh stop exit=2 counter=1` (a stop that is not a continuation restarts the consecutive count and blocks again) and the marker file still listed (it is cleared only by a success).

Run: `bash scripts/docs-check.sh --hook >/dev/null 2>&1; echo "tty exit=$? counter=$(cat .claude/.docs-check-blocks)"`
Expected: `tty exit=2 counter=2` (no stdin payload from a terminal: the counter keeps counting, nothing resets).

Run: `sed -i '' 's/^### Added$/### Added\n\n- Touched errors for the docs-check rehearsal./' CHANGELOG.md; bash scripts/docs-check.sh --hook; echo "exit=$?"; ls .claude/.docs-check-blocks .claude/DOCS-CHECK-FAILED 2>&1 | head -n 2`
Expected: `docs-check: OK`, `exit=0`, and both files reported as `No such file or directory`.

Run: `git checkout src/lib/errors.ts CHANGELOG.md`

Rule B:

Run: `sed -i '' 's/summary: "List the user.s tags"/summary: "List tags"/' src/schemas/tags.ts; echo "- Rule B rehearsal." >> CHANGELOG.md; bash scripts/docs-check.sh --hook; echo "exit=$?"`
Expected: `DOCS CHECK FAILED` with `Rule B: ... Fix: run npm run openapi and commit`, `exit=2`.

Run: `npm run openapi >/dev/null && bash scripts/docs-check.sh --hook; echo "exit=$?"; git checkout src/schemas/tags.ts CHANGELOG.md openapi.json docs/API.md; rm -f .claude/.docs-check-blocks`
Expected: `docs-check: OK`, `exit=0`.

Rule C:

Run: `echo "" >> src/agent/prompts/breakdown.system.md; echo "- Rule C rehearsal." >> CHANGELOG.md; bash scripts/docs-check.sh --hook; echo "exit=$?"`
Expected: `Rule C: architectural files changed (src/agent/prompts/breakdown.system.md ) without an ADR. Fix: add or update an ADR under docs/adr/`, `exit=2`.

Run: `echo "" >> docs/adr/0003-in-process-worker.md; bash scripts/docs-check.sh --hook; echo "exit=$?"; git checkout src/agent/prompts/breakdown.system.md CHANGELOG.md docs/adr/0003-in-process-worker.md; rm -f .claude/.docs-check-blocks`
Expected: `docs-check: OK`, `exit=0`.

CI mode:

Run: `BASE_SHA=$(git rev-parse HEAD~1) bash scripts/docs-check.sh --ci; echo "exit=$?"`
Expected: `DOCS CHECK FAILED` with Rule A (the hooks commit changed `scripts/` without a changelog change) and `exit=1`. This is the failure Step 6 fixes.

format-file:

Run: `printf 'const   x = {a:1}\n' > /tmp/kaizen-fmt.ts; cp /tmp/kaizen-fmt.ts src/fmt-probe.ts; echo '{"tool_input":{"file_path":"src/fmt-probe.ts"}}' | bash scripts/format-file.sh; cat src/fmt-probe.ts; rm src/fmt-probe.ts`
Expected: `const x = { a: 1 };`

Run: `echo '{"tool_input":{"file_path":"/etc/hosts"}}' | bash scripts/format-file.sh; echo "exit=$?"`
Expected: `exit=0` and `/etc/hosts` untouched (outside the repo).

- [ ] **Step 6: Add the changelog bullet and commit**

Add under `### Added` in `[Unreleased]`:

```markdown
- Docs-drift harness: `scripts/docs-check.sh` (Stop hook and CI, rules A, B, C with fix messages and the three-block escape hatch), `scripts/format-file.sh` (PostToolUse prettier), `.claude/settings.json`.
```

```bash
git add CHANGELOG.md
git commit -F - <<'MSG'
docs: changelog bullet for the docs-check harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

Run: `BASE_SHA=$(git rev-parse HEAD~2) bash scripts/docs-check.sh --ci; echo "exit=$?"`
Expected: `docs-check: OK`, `exit=0`.

---

### Task 23: Skills and agents

**Files:**
- Create: `.claude/skills/add-api-endpoint/SKILL.md`, `.claude/skills/write-adr/SKILL.md`, `.claude/skills/release-notes/SKILL.md`, `.claude/agents/reviewer.md`, `.claude/agents/test-writer.md`

**Interfaces:**
- Consumes: the conventions from Tasks 2 through 22 (the templates below are the shapes those tasks produced).
- Produces: the per-repo skills the assembly-line `implement-issue` skill invokes (master plan section 4: `backend/.claude/skills/add-api-endpoint/SKILL.md`, `write-adr`, `release-notes`) and the two agents from spec 8.5.

- [ ] **Step 1: Write `.claude/skills/add-api-endpoint/SKILL.md`**

```markdown
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
   responses through `jsonResponse` and `errorResponses`). Full paths include `/api/v1`.
4. Add the service method in `src/services/<resource>.ts`. It loads the row by id and user id
   first (`NOT_FOUND` on a miss), applies the rule, and returns the API shape. No Express types.
5. Add the repository query in `src/repositories/<resource>.ts` taking `DbOrTx`.
6. Add the route in `src/routes/<resource>.ts`: `validate(schemas)`, `validated<typeof schemas>(res)`,
   `currentUser(req)`, `sendData` / `sendNoContent`. Mount it in `src/app.ts` if the router is new.
7. Run the tests to green: `npm test`. Then `npm run typecheck && npm run lint`.
8. Regenerate the contract: `npm run openapi`. Commit `openapi.json` and `docs/API.md`.
9. Add a bullet under `[Unreleased]` in `CHANGELOG.md`.
10. If a file matching `docs/architectural-files.txt` changed, add or update an ADR with the
    `write-adr` skill.
11. Run `npm run docs:check`. Fix anything it reports. Commit with the `Co-Authored-By` trailer line.

## Templates

Schema (`src/schemas/<resource>.ts`):

```ts
import { z } from "zod";
import { envelope, errorResponses, IdParams, jsonResponse } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";

export const WidgetSchema = z
  .object({ id: z.uuid(), name: z.string(), createdAt: z.iso.datetime() })
  .openapi("Widget");
export const CreateWidgetBody = z.object({ name: z.string().trim().min(1).max(80) }).openapi("CreateWidgetBody");
export type Widget = z.infer<typeof WidgetSchema>;
export type CreateWidgetInput = z.infer<typeof CreateWidgetBody>;

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/widgets`,
  tags: ["widgets"],
  summary: "Create a widget",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateWidgetBody } } } },
  responses: { 201: jsonResponse("Created", envelope(WidgetSchema)), ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED") },
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
  const [row] = await db.select().from(widgets).where(and(eq(widgets.id, id), eq(widgets.userId, userId))).limit(1);
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
    const res = await request(ctx.app).post("/api/v1/widgets").set(auth(user.token)).send({ name: "First" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "First" });
  });

  it("validates the body", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app).post("/api/v1/widgets").set(auth(user.token)).send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("body.name");
  });
});
```
```

- [ ] **Step 2: Write `.claude/skills/write-adr/SKILL.md`**

```markdown
---
name: write-adr
description: Use when a change touches an architectural file (see docs/architectural-files.txt) or a design decision needs recording. Produces a numbered ADR in docs/adr/ in the repo's format.
---

# Write an ADR

## Numbering

Files are `docs/adr/NNNN-kebab-case-title.md`. `NNNN` is four digits, the highest existing number
plus one (`ls docs/adr | sort | tail -n 1`). Never renumber or reuse a number. To change a
decision, write a new ADR that supersedes the old one and set the old one's status to
`Superseded by NNNN`.

## Template

```markdown
# NNNN: Short imperative title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What situation forces a decision. Facts, constraints, the options that were realistic. Cite the
PRD or spec section when one applies.

## Decision

What was decided, stated so an engineer can check code against it. Name the files, constants,
and rules involved.

## Consequences

What becomes easier, what becomes harder, what must now be remembered. Include the operational
consequence (deploy, rollback, tests) when there is one.
```

## Procedure

1. Pick the number and file name.
2. Fill the template. Keep it under a page. Prefer concrete rules ("every write carries
   `WHERE generation_id = ...`") over intentions.
3. If the ADR changes a rule stated in `CLAUDE.md` or `docs/ARCHITECTURE.md`, update those in the
   same change.
4. Add a `CHANGELOG.md` bullet if code changed alongside.
5. Run `npm run docs:check`.
```

- [ ] **Step 3: Write `.claude/skills/release-notes/SKILL.md`**

```markdown
---
name: release-notes
description: Use when cutting a version. Moves the CHANGELOG [Unreleased] section into a dated version section and bumps package.json.
---

# Release notes

## Procedure

1. Read `CHANGELOG.md` `[Unreleased]`. If it is empty, stop: there is nothing to release.
2. Choose the version from the content, following semver against the current `package.json`
   version: a breaking change to the API contract or config is a major; new endpoints, fields, or
   variables are a minor; everything else is a patch. Additive-only rules (ADR 0004) mean most
   releases are minor.
3. Edit `CHANGELOG.md`: insert `## [X.Y.Z] - YYYY-MM-DD` (today's date, UTC) directly under the
   `[Unreleased]` heading and move every subsection (`### Added`, `### Changed`, `### Fixed`,
   `### Removed`) under it. Leave `## [Unreleased]` in place with no bullets.
4. Bump the version without tagging: `npm version --no-git-tag-version X.Y.Z`.
5. Run `npm run lint` (prettier checks the changelog) and `npm run docs:check`.
6. Commit: `chore: release X.Y.Z` with the `Co-Authored-By` trailer line. Tagging and publishing happen through
   the `develop` to `main` pull request, not here.

## Example

Before:

```markdown
## [Unreleased]

### Added

- `PUT /api/v1/tasks/{id}/tags` replaces a task's tag set.
```

After (version was 0.1.0, one additive endpoint, so 0.2.0):

```markdown
## [Unreleased]

## [0.2.0] - 2026-09-15

### Added

- `PUT /api/v1/tasks/{id}/tags` replaces a task's tag set.
```
```

- [ ] **Step 4: Write `.claude/agents/reviewer.md`**

```markdown
---
name: reviewer
description: Read-only reviewer for this API. Give it a diff, a branch, or a commit range and it checks the layering, envelope and validation rules, ownership handling, test presence, changelog and OpenAPI freshness, and migration safety, then returns PASS or a list of violations with file and line.
tools: Read, Grep, Glob, Bash
---

You review changes to the Kaizen Tasks API against `CLAUDE.md`, `docs/ARCHITECTURE.md`, and the
ADRs in `docs/adr/`. You never edit files. You read the diff (`git diff <range>` or the paths you
were given) and the surrounding code, and you report.

## What you check

1. Layering. `src/routes` imports only `schemas`, `services`, `lib`; `src/services` only
   `repositories`, `agent`, `jobs/queue`, `lib` (and `import type` from `schemas`);
   `src/repositories` only `db`, `lib`; `src/jobs` only `services`, `repositories`, `agent`,
   `lib`; `src/agent` only `lib`, `schemas`; `src/lib`, `src/db`, `src/schemas` import nothing
   above them. Handlers never import Drizzle; services never import `express`.
2. Envelopes. Every response goes through `sendData` or `sendNoContent`. No `res.json({ error`
   or hand-built error bodies. Errors are thrown as `AppError` or its constructors.
3. Validation. Every route has `validate({...})` for the parts it reads and reads through
   `validated<typeof schemas>(res)`. Nothing assigns to `req.query`. Every new or changed route
   is registered in `src/schemas/*` with `registry.registerPath`.
4. Ownership. Every service method that takes an id loads by id and user id first and throws
   `notFound` on a miss. No `FORBIDDEN` for ownership.
5. Tests. A new route has an integration test under `tests/api/`; a pure rule has a unit test
   next to it. Tests assert status codes, error codes, and detail shapes.
6. Docs freshness. `CHANGELOG.md` `[Unreleased]` has a bullet for this change; if
   `src/routes/` or `src/schemas/` changed, run `npm run openapi -- --check`; if a file matching
   `docs/architectural-files.txt` changed, a `docs/adr/*.md` file changed too.
7. Migrations. New files under `drizzle/` contain no `DROP`, `RENAME`, or `ALTER COLUMN ... TYPE`
   (ADR 0004). Run `grep -nE 'DROP|RENAME|ALTER COLUMN .* TYPE' drizzle/*.sql` on new files.
8. AI pipeline writes. Any new write to `ai_status`, `ai_error`, `ai_skip_reason`,
   `ai_tag_suggestions` or to AI children from `src/jobs/` carries a `generation_id` guard.

## Output

Either the single line `PASS` or a list, one violation per line:

```
<file>:<line> <rule number> <what is wrong> -> <what to do>
```

Order violations by file. Do not pad the list with style remarks; prettier and eslint own style.
```

- [ ] **Step 5: Write `.claude/agents/test-writer.md`**

```markdown
---
name: test-writer
description: Drafts failing tests from acceptance criteria in this repo's conventions, without touching src/. Use before implementing an endpoint or rule so the implementer starts from red.
tools: Read, Grep, Glob, Write, Edit, Bash
---

You turn acceptance criteria into failing tests for the Kaizen Tasks API. You write only under
`tests/` and `src/**/*.test.ts`; you never create or modify non-test files under `src/`.

## Conventions you follow

- Integration tests live in `tests/api/<resource>.test.ts` and use `createTestApp` from
  `tests/helpers/app.ts`, `registerUser` and `auth` from `tests/helpers/auth.ts`, and `createTask`
  from `tests/helpers/tasks.ts`. One `TestContext` per file in `beforeAll`, closed in `afterAll`.
  The database and Redis are truncated before every test, so tests create their own users.
- Unit tests live next to the module as `src/<path>/<name>.test.ts` and import nothing that needs
  a database.
- Assert the envelope: `res.body.data` for success, `res.body.error.code` and, when relevant,
  `res.body.error.details` for errors. Assert status codes from `statusFor`.
- Cover: the happy path, each validation failure named in the criteria (with the `body.x` /
  `query.x` / `params.x` detail path), the ownership miss (`404`), and any state transition the
  criteria describe.
- Name tests as sentences that describe behavior, not implementation.

## Procedure

1. Restate the acceptance criteria as a numbered list.
2. Map each criterion to one test. Say which file each goes in.
3. Write the tests. Import the schemas, services, or helpers that the implementation will
   provide, using the names in the acceptance criteria or the plan.
4. Run them: `npx vitest run --project integration <file>` or `--project unit`. Confirm they fail
   because the behavior is missing (unresolved import or wrong status), not because of a typo.
5. Report the list of tests and the failure reason for each.
```

- [ ] **Step 6: Verify the frontmatter and commit**

Run: `for f in .claude/skills/*/SKILL.md .claude/agents/*.md; do printf '%s: ' "$f"; awk 'NR==1 && $0!="---" {print "missing frontmatter"; exit} /^name:/ {n=1} /^description:/ {d=1} NR>1 && $0=="---" {print (n&&d) ? "ok" : "missing name or description"; exit}' "$f"; done`
Expected: five lines ending in `ok`.

Run: `npm run lint`
Expected: exit 0 (run `npx prettier --write .claude` first if prettier reports the markdown).

Add under `### Added` in `CHANGELOG.md` `[Unreleased]`:

```markdown
- Harness: `add-api-endpoint`, `write-adr`, `release-notes` skills and `reviewer`, `test-writer` agents under `.claude/`.
```

```bash
git add .claude/skills .claude/agents CHANGELOG.md
git commit -F - <<'MSG'
feat: add-api-endpoint, write-adr and release-notes skills; reviewer and test-writer agents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 24: Promote workflow and the opt-in live model test

**Files:**
- Create: `.github/workflows/promote.yml`, `tests/live/breakdown.live.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 15 `AnthropicBreakdownModel`, `postValidate`, `loadSystemPrompt`; Task 4 `BreakdownSchema`; Task 1 `test:live` script and the `live` vitest project; Task 3 health endpoint (the promote poll reads `data.commit`).
- Produces: workflow name `promote`, job id `promote` (the required check on `main` named in the master plan); `npm run test:live` proving verification V5 (`messages.parse` with `zodOutputFormat` accepts array `min` and `max` bounds).
- Repository variable `STAGING_WEB_URL` (the staging web domain, set by the L3 lane) is the only external input.

- [ ] **Step 1: Write `.github/workflows/promote.yml`**

```yaml
name: promote

on:
  pull_request:
    branches: [main]

concurrency:
  group: promote-${{ github.ref }}
  cancel-in-progress: true

jobs:
  promote:
    name: promote
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      STAGING_URL: ${{ vars.STAGING_WEB_URL }}
      CANDIDATE_SHA: ${{ github.event.pull_request.head.sha }}
    steps:
      - name: Require the staging URL
        run: |
          if [[ -z "$STAGING_URL" ]]; then
            echo "Repository variable STAGING_WEB_URL is not set" >&2
            exit 1
          fi

      - name: Wait until staging serves the candidate SHA (15 minute timeout)
        run: |
          deadline=$(( $(date +%s) + 900 ))
          while :; do
            served="$(curl -fsS --max-time 10 "$STAGING_URL/api/v1/health" | jq -r '.data.commit // empty' 2>/dev/null || true)"
            if [[ "$served" == "$CANDIDATE_SHA" ]]; then
              echo "staging serves $served"
              break
            fi
            if (( $(date +%s) > deadline )); then
              echo "timeout: staging serves '${served:-nothing}', wanted $CANDIDATE_SHA (deploy skipped or still failing?)" >&2
              exit 1
            fi
            echo "staging serves '${served:-nothing}', waiting for $CANDIDATE_SHA"
            sleep 15
          done

      - name: Check out the smoke package
        uses: actions/checkout@v4
        with:
          repository: kpnemo/kaizen-tasks-assembly-line
          ref: main
          path: assembly-line

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install the smoke package
        working-directory: assembly-line/smoke
        run: |
          npm ci
          npx playwright install --with-deps chromium

      - name: Run the smoke test against staging
        working-directory: assembly-line/smoke
        env:
          SMOKE_BASE_URL: ${{ env.STAGING_URL }}
          SMOKE_AI_TIMEOUT_MS: "180000"
        run: npm test

      - name: Upload Playwright traces on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-traces
          path: assembly-line/smoke/test-results
          if-no-files-found: ignore
```

- [ ] **Step 2: Write `tests/live/breakdown.live.test.ts`**

```ts
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicBreakdownModel } from "../../src/agent/anthropic-model.js";
import { postValidate } from "../../src/agent/breakdown.js";
import { loadSystemPrompt } from "../../src/agent/prompt.js";
import { BreakdownSchema, MAX_STEPS, MAX_TAG_SUGGESTIONS, MIN_STEPS } from "../../src/schemas/breakdown.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.ANTHROPIC_API_KEY;
const modelName = process.env.AI_MODEL ?? "claude-sonnet-5";

// Opt-in: runs only when ANTHROPIC_API_KEY is present. Excluded from `npm test` and from CI.
describe.skipIf(!apiKey)("live: Anthropic breakdown (verification V5)", () => {
  it("returns three to seven steps with rationales and at most three tags for a realistic task", async () => {
    const model = new AnthropicBreakdownModel({
      apiKey: apiKey ?? "",
      model: modelName,
      systemPrompt: loadSystemPrompt(),
    });
    const outcome = await model.complete({
      title: "Plan the Q4 team offsite",
      description: "Two days, twelve people, within two hours of the office, budget around 6k.",
      existingSteps: [],
      tags: ["work", "personal"],
      openTasks: ["Renew lease", "Write the onboarding guide for new PMs"],
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // V5: the schema with array min/max bounds was accepted by messages.parse and satisfied.
    expect(BreakdownSchema.safeParse(outcome.result).success).toBe(true);
    const result = postValidate(outcome.result);
    expect(result.steps.length).toBeGreaterThanOrEqual(MIN_STEPS);
    expect(result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(result.tagSuggestions.length).toBeLessThanOrEqual(MAX_TAG_SUGGESTIONS);
    for (const step of result.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.rationale.length).toBeGreaterThan(0);
    }
    for (const tag of result.tagSuggestions) {
      expect(tag.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run the live test once with Mike's key (L1-M2 done condition)**

Run: `npm run test:live`
Expected without a key: `✓ tests/live/breakdown.live.test.ts (1 test | 1 skipped)`.
Expected with `ANTHROPIC_API_KEY` in `.env`: `✓ tests/live/breakdown.live.test.ts (1 test)` within about 30 seconds.

If the API rejects the output format with a 400 that names `minItems` or `maxItems`, apply the V5 fallback from spec section 11: in `src/schemas/breakdown.ts` change `steps` to `z.array(z.object({ title: z.string(), rationale: z.string() }))` and `tagSuggestions` to `z.array(z.string())` (no bounds; `postValidate` already enforces them), keep the `MIN_STEPS`, `MAX_STEPS`, `MAX_TAG_SUGGESTIONS` exports, re-run `npm test` (the fixture and post-validation tests still pass) and the live test, and record the fallback in `CHANGELOG.md` and in a new ADR `0005-structured-output-bounds.md` via the `write-adr` skill.

Confirm CI never runs it: `grep -n "test:live" .github/workflows/ci.yml; echo "matches=$?"`
Expected: `matches=1` (no match).

- [ ] **Step 4: Changelog, lint, commit**

Add under `### Added` in `CHANGELOG.md` `[Unreleased]`:

```markdown
- `promote` workflow: waits for staging to serve the pull request's SHA, then runs the shared smoke package; `npm run test:live` opt-in live model test.
```

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

```bash
git add .github/workflows/promote.yml tests/live/breakdown.live.test.ts CHANGELOG.md
git commit -F - <<'MSG'
feat: promote workflow gated on staging SHA and the opt-in live model test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

Push `develop` and confirm `ci` is green: `git push origin develop && gh run watch --repo kpnemo/kaizen-tasks-api --exit-status`.

## End of milestone L1-M2

L1-M2 is complete when every task above is done and the live test has passed once with Mike's key. The web lane may then switch from the Prism mock to the real API (L2-M3).

---

# Self-review

## 1. Spec coverage

| Spec section | Where it lands |
|---|---|
| 2.1 Runtime, startup sequence, shutdown | Task 1 (Node pin, scripts), Task 6 (build, copy-assets), Task 20 (seven-step startup, `::` host, SIGTERM) |
| 2.2 Layout and import rules | Layout follows the file structure table; rules in `CLAUDE.md` (Task 21) and the `reviewer` agent (Task 23) |
| 2.3 Dependencies | Task 1 `package.json` with the versions checked on 2026-09-08 |
| 2.4 Config | Task 1 `src/config.ts` (every variable, defaults, `ANTHROPIC_API_KEY` conditional, secure-cookie rule) |
| 2.5 Observability | Task 2 (request id, pino-http line with user id), Task 16 and 17 (worker logs carry `jobId` and `taskId`) |
| 3.1 Schema, indexes, check constraint, additive rule | Task 8; rule in Task 21 (`CLAUDE.md`, ADR 0004) |
| 3.2 Redis keys | Task 10 (`refresh:<token>`), Task 11 (`ratelimit:breakdown:*`), Task 9 (prefix `kaizen`), Task 8 (tests on db 1) |
| 3.3 Migrations and seed | Task 8 (`drizzle/`, migrator at startup and in global setup), Task 18 (seed, stable ids, one transaction, two entry points) |
| 4.1 Envelopes and errors | Task 2 |
| 4.2 Validation | Task 3 (`validate`, `validated`, `res.locals.validated`) |
| 4.3 Authentication | Task 10 |
| 4.4 Endpoints | auth Task 10; tasks list/create/get/delete Task 13; patch, accept-all, dismiss-all, tags Task 14; breakdown Task 16; tags Task 12; feature-requests Task 19; admin Task 18; health and openapi.json Task 3. The two contract additions ruled on 2026-09-08 (master plan section 4): `TaskSummary.suggestionCount` and `aiError` in Tasks 4 and 13 (schema, SQL aggregate, service) with assertions in Tasks 13, 14, 16, 18; health `features.featureRequests` in Tasks 3, 4, 10, 19 |
| 4.5 Pagination | Task 3 (`cursor.ts`), Task 13 (`limit + 1`, keyset predicate) |
| 4.6 OpenAPI | Task 4 (registry), Task 5 (generator, renderer, `--check`) |
| 5.1 Queue and job, reservation | Task 9 (queue, job id, options), Task 16 (`reserveGeneration`), Task 17 (worker concurrency 3) |
| 5.2 Processor | Task 16 |
| 5.3 Agent module | Task 9 (seam, fake), Task 15 (`breakdownTask`, Anthropic adapter with the exact SDK shapes) |
| 5.4 Prompt | Task 6 (content, `copy-assets`, `check-dist-assets`), Task 15 (`import.meta.url` loader) |
| 5.5 Rate limit | Task 11; create behavior Task 13; breakdown behavior Task 16 |
| 5.6 Reconciler | Task 17; started at worker start in Task 20 |
| 6 Service rules | Tasks 10, 12, 13, 14, 16, 19 |
| 7.1 Test setup | Task 1 (projects, `.env.test`), Task 8 (global and each), Task 10 (`createApp(deps)` harness with fake queue and model) |
| 7.2 Test list | See table 2 |
| 8.1 Docs set | Task 7 (skeletons), Task 5 (`docs/API.md`), Task 21 |
| 8.2 docs-check | Task 22 |
| 8.3 Hooks | Task 22 |
| 8.4 Skills | Task 23 |
| 8.5 Agents | Task 23 |
| 8.6 CLAUDE.md | Task 7 (skeleton), Task 21 |
| 9 Local development | Task 1 (scripts), Task 7 and 21 (README) |
| 10.1 GitHub Actions | Task 7 (`ci`), Task 22 (docs step), Task 24 (`promote`) |
| 10.2 Branch protection | Not in this repo: the master plan assigns it to the L3 lane (section 6, item 6) with a script in the assembly-line repo |
| 10.3 Railway | Task 7 (`.railway/railway.ts`); project, environments and variables are the L3 lane's (master plan section 6, items 3 to 5) |
| 10.4 Deploy flow | Documented in Task 21 `ARCHITECTURE.md`; executed by the L3 lane |
| 11 Verification | V1 to V3 closed in the spec; V4 Task 7; V5 Task 24; V6 Tasks 9 and 17 |
| 12 Out of scope | Nothing from this list is built |

## 2. Test list (spec 7.2) to concrete tests

| Spec item | Test |
|---|---|
| envelope shape | `src/lib/envelope.test.ts` (Task 2) |
| `statusFor` mapping | `src/lib/errors.test.ts` (Task 2) |
| `AppError` middleware output for each code | `src/lib/error-handler.test.ts` "maps every AppError code" (Task 2) |
| cursor round trip and garbage rejection | `src/lib/cursor.test.ts` (Task 3) |
| config validation errors listing every missing variable | `src/config.test.ts` (Task 1) |
| `breakdownTask` post-validation (dedup, trim, bounds) | `src/agent/breakdown.test.ts` "postValidate" (Task 15) |
| skip rule | `src/agent/breakdown.test.ts` "shouldSkipBreakdown" (Task 15) |
| suggestion-state transition table | `src/services/suggestions.test.ts` (Task 14) |
| progress aggregation | `tests/db/progress.test.ts` (Task 13; repository level because the aggregate is SQL per spec 6) |
| register and login flows incl. duplicate email and wrong password | `tests/api/auth.test.ts` "register", "login" (Task 10) |
| refresh rotation invalidates the old cookie | `tests/api/auth.test.ts` "rotates the cookie" (Task 10) |
| logout | `tests/api/auth.test.ts` "logout" (Task 10) |
| create enqueues a job with reason create, pending with a generation id | `tests/api/tasks.test.ts` "root create enqueues" (Task 13) |
| create with a failing queue fake returns 201 with ai_status failed | `tests/api/tasks.test.ts` "queue is unavailable" (Task 13) |
| child under a root succeeds, under a child fails with the depth message | `tests/api/tasks.test.ts` "creates a child under a root" (Task 13) |
| list pagination walks three pages without duplicates | `tests/api/tasks.test.ts` "walks three pages" (Task 13) |
| filters by status and tag | `tests/api/tasks.test.ts` "filters by status and by tag" (Task 13) |
| children ordered by position with rationale on an AI child | `tests/api/tasks-update.test.ts` "children ordering" (Task 14) |
| patch position shifts siblings and keeps positions dense | `tests/api/tasks-update.test.ts` "moves a child to a target index" (Task 14) |
| patch suggestion states through every allowed and one disallowed transition | `tests/api/tasks-update.test.ts` "walks every allowed suggestion transition" (Task 14) |
| accept-all and dismiss-all | `tests/api/tasks-update.test.ts` "accept-all and dismiss-all" (Task 14) |
| two breakdown calls yield one 202 and one CONFLICT | `tests/api/breakdown.test.ts` "two calls in quick succession" (Task 16) |
| RATE_LIMITED past the user limit and past the global limit with details | `tests/api/breakdown.test.ts` "past the user limit", "scope global" (Task 16) |
| `AI_ENABLED=false` creates skipped ai_disabled; breakdown returns UNAVAILABLE | `tests/api/tasks.test.ts` "with AI_ENABLED=false" (Task 13); `tests/api/breakdown.test.ts` "UNAVAILABLE 'AI is paused'" (Task 16) |
| replace tags with a foreign tag id fails | `tests/api/tasks-update.test.ts` "PUT /tasks/:id/tags" (Task 14) |
| delete cascades | `tests/api/tasks.test.ts` "DELETE cascades" (Task 13) |
| health reports the commit SHA | `tests/api/health.test.ts` (Task 10; the stub version in Task 3 is replaced) |
| feature-requests route absent when unconfigured | `tests/api/feature-requests.test.ts` "is absent" (Task 19) |
| admin seed-reset absent, NOT_FOUND on wrong token, recreates fixtures with stable ids | `tests/api/admin.test.ts` (Task 18) |
| error envelope carries the request id | `tests/api/health.test.ts` "carries the inbound request id" (Task 10); `src/lib/error-handler.test.ts` (Task 2) |
| `TaskSummary.suggestionCount` and `aiError` (master plan section 4) | `tests/db/progress.test.ts` (Task 13); `tests/api/tasks-update.test.ts` "children ordering" and "accept-all and dismiss-all" (Task 14: 2 with suggested children, 0 after accept-all and after dismiss-all, also on the list row); `tests/api/breakdown.test.ts` (Task 16); `tests/api/admin.test.ts` (Task 18) |
| health `features.featureRequests` (master plan section 4) | `src/app.test.ts` (Task 3) and `tests/api/health.test.ts` (Task 10): false in the default test config, true with `GITHUB_TOKEN` and `GITHUB_REPO` set |
| jobs: real worker to done with 3 to 7 suggested children and tags, via real `enqueueBreakdown` | `tests/jobs/breakdown.test.ts` "processes a create job" (Task 17) |
| jobs: refuse mode fails with a message | `tests/jobs/breakdown.test.ts` "marks a refused breakdown failed" (Task 17) |
| jobs: regenerate replaces suggested, accepted survives | `tests/jobs/breakdown.test.ts` "regenerate replaces" (Task 17) |
| jobs: mismatched generation writes nothing | `tests/jobs/breakdown.test.ts` "generation no longer matches" (Task 17); also `tests/api/breakdown.test.ts` inline (Task 16) |
| jobs: reconciler fails a stuck running task with the timeout message | `tests/jobs/breakdown.test.ts` "reconciler" (Task 17) |
| live, opt-in | `tests/live/breakdown.live.test.ts` (Task 24) |

Additional tests beyond the list: `tests/db/schema.test.ts` (constraints), `tests/jobs/queue.test.ts` (job id and options), `tests/lib/rate-limit.test.ts`, `src/schemas/index.test.ts` (every endpoint documented), `src/routes/validate.test.ts`, `src/agent/anthropic-model.test.ts`, `src/lib/assets.test.ts`, `tests/api/tags.test.ts`.

## 3. Verification items

- V4 (wait-for-CI holds a push-triggered deploy): Task 7 provides `ci.yml` on `push: develop` and `railway.ts` tracking `develop` in staging with `source.checkSuites: true`; the L3 lane observes the held deployment at L3-M1. Fallback (CLI deploy from Actions) is named in Task 7.
- V5 (`messages.parse` with `zodOutputFormat` accepts array `min`/`max`): Task 24 live test; fallback (drop the bounds, keep `postValidate`) is spelled out with the exact edit.
- V6 (BullMQ 6 accepts `${taskId}-${generationId}`): Task 9 adds and reads back a job by that id; Task 17 processes one with a real worker and asserts the completed job id.

## 4. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in`, `Similar to Task`, `add appropriate`, `handle edge cases`, `write tests for`. None present. Every code step has full code; every command has its expected output; every type or function used by a later task is defined in an earlier task's Interfaces block.

## 5. Type and name consistency

Names used across tasks and where they are defined:

- `loadConfig`, `Config`, `ConfigError`, `isSecureCookieEnv` (Task 1) used in Tasks 3, 6, 10, 11, 20.
- `AppError`, `statusFor`, `notFound`, `conflict`, `validationError`, `rateLimited`, `unavailable`, `upstreamError`, `unauthorized` (Task 2) used in Tasks 3, 10, 12, 13, 14, 16, 18, 19.
- `sendData`, `sendNoContent` (Task 2); `requestIdOf` (Task 2, `src/lib/request-id.ts`) used by `envelope.ts` and `error-handler.ts`.
- `validate`, `validated`, `HealthProbes`, `HealthFeatures`, `featureRequestsConfigOf`, `createApp`, `AppDeps` (Task 3; `AppDeps` widened in Task 10 and 19; Task 19 mounts the feature-requests route on the `featureRequestsConfig` value Task 3 introduced).
- `registry`, `bearerAuth`, `API_PREFIX`, `IdParams`, `envelope`, `listEnvelope`, `jsonResponse`, `errorResponses`, every resource schema and its inferred types (Task 4) used in Tasks 5, 10, 12, 13, 14, 16, 19, 23.
- `createDb`, `Db`, `DbOrTx`, `isUniqueViolation`, `isCheckViolation`, tables and row types (Task 8) used everywhere below.
- `BreakdownQueue`, `BreakdownJobData`, `breakdownJobId`, `createBreakdownQueue`, `enqueueBreakdown`, `BreakdownModel`, `BreakdownInput`, `FakeBreakdownModel`, `FakeQueue.drain`, `ModelRetryableError`, `ModelNonRetryableError`, `BreakdownRefused`, `BreakdownInvalid` (Task 9) used in Tasks 10, 13, 15, 16, 17, 20.
- `requireAuth`, `currentUser`, `hashPassword`, `createTestApp`, `TestContext`, `registerUser`, `auth`, `refreshCookieFrom` (Task 10) used in Tasks 12 to 19.
- `createRateLimiter`, `RateLimiter`, `ConsumeResult.reason` (Task 11) used in Tasks 13, 16, 17.
- `toTag`, `tagsForTasks`, `findOwnedTags`, `replaceTaskTags`, `listTags` (Task 12) used in Tasks 13, 14, 16.
- `createTasksService`, `TasksService`, `loadTaskDetail`, `toTaskSummary`, `assertOwnedTagIds`, `MAX_TASK_DEPTH`, `DEPTH_MESSAGE`, `ENQUEUE_FAILED_MESSAGE`, `findOwnedTask`, `listChildren`, `maxSiblingPosition`, `updateAiState`, `childAggregates`, `ChildAggregate` (Task 13) used in Tasks 14, 16, 17.
- `processBreakdownJob`, `ProcessorDeps`, `AI_ERROR_MESSAGES`, `reserveGeneration`, `replaceSuggestedChildren`, `openRootTitles` (Task 16) used in Tasks 17, 20.
- `startBreakdownWorker`, `BreakdownWorker`, `startReconciler`, `reconcileStaleGenerations`, `STALE_ERROR_MESSAGE`, `failStaleGenerations` (Task 17) used in Task 20.
- `ensureDemoSeed`, `resetDemoSeed`, `SEED_IDS`, `DEMO_EMAIL` (Task 18) used in Task 20 and the admin service.
- `GitHubIssues`, `createOctokitIssues`, `createFeatureRequestsService` (Task 19) used in `app.ts`.
- `assertRuntimeAssets`, `promptPath`, `MIGRATIONS_FOLDER`, `createBreakdownModel` (Tasks 8, 15, 20) used in `server.ts`.
