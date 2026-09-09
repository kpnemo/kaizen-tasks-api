import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LoginBody, RegisterBody } from "./auth.js";
import { ErrorEnvelopeSchema } from "./common.js";
import { HealthSchema } from "./health.js";
import {
  AiSkipReasonSchema,
  AiStatusSchema,
  ListTasksQuery,
  SuggestionStateSchema,
  TaskOriginSchema,
  TaskStatusSchema,
  TaskSummarySchema,
} from "./tasks.js";

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

const ENUM_CASES = [
  ["task_status", TaskStatusSchema, ["todo", "in_progress", "done"]],
  ["ai_status", AiStatusSchema, ["pending", "running", "done", "failed", "skipped"]],
  ["ai_skip_reason", AiSkipReasonSchema, ["too_short", "rate_limited", "ai_disabled"]],
  ["task_origin", TaskOriginSchema, ["user", "ai"]],
  ["suggestion_state", SuggestionStateSchema, ["suggested", "accepted", "dismissed"]],
] as const;

describe("enum schemas", () => {
  it.each(ENUM_CASES)("%s accepts every spec value and rejects bogus", (_name, schema, values) => {
    for (const value of values) {
      expect(schema.safeParse(value).success, value).toBe(true);
    }
    expect(schema.safeParse("bogus").success).toBe(false);
  });
});

describe("ListTasksQuery", () => {
  it('coerces "50" to 50', () => {
    const result = ListTasksQuery.parse({ limit: "50" });
    expect(result.limit).toBe(50);
  });

  it("defaults limit to 50 when absent", () => {
    const result = ListTasksQuery.parse({});
    expect(result.limit).toBe(50);
  });

  it.each([
    [1, true],
    [100, true],
    [0, false],
    [101, false],
    [1.5, false],
  ])("limit %p is valid: %p", (limit, expected) => {
    expect(ListTasksQuery.safeParse({ limit }).success).toBe(expected);
  });

  it("treats cursor as optional", () => {
    expect(ListTasksQuery.safeParse({}).success).toBe(true);
  });

  it("rejects an empty cursor", () => {
    expect(ListTasksQuery.safeParse({ cursor: "" }).success).toBe(false);
  });
});

describe("TaskSummarySchema", () => {
  const validTaskSummary = {
    id: randomUUID(),
    parentId: null,
    title: "Title",
    description: null,
    status: "todo",
    aiStatus: "pending",
    aiSkipReason: null,
    aiError: null,
    position: 0,
    origin: "user",
    suggestionState: null,
    rationale: null,
    tags: [],
    progress: { done: 0, total: 0 },
    suggestionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a complete valid summary with aiError: null", () => {
    expect(TaskSummarySchema.safeParse(validTaskSummary).success).toBe(true);
  });

  it.each(["suggestionCount", "aiError"])("rejects an object missing %s", (key) => {
    expect(TaskSummarySchema.safeParse(omit(validTaskSummary, key)).success).toBe(false);
  });
});

describe("ErrorEnvelopeSchema", () => {
  it("accepts the validation-details array shape", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: [{ path: "body.title", message: "Required" }],
          requestId: "req-1",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts the rate-limit object shape", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: {
          code: "RATE_LIMITED",
          message: "Rate limit exceeded",
          details: { scope: "user", limit: 10, resetAt: "2026-01-01T00:00:00.000Z" },
          requestId: "req-2",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects details: 42", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: {
          code: "INTERNAL",
          message: "boom",
          details: 42,
          requestId: "req-3",
        },
      }).success,
    ).toBe(false);
  });
});

describe("HealthSchema", () => {
  const validHealth = {
    status: "ok",
    commit: "abc123",
    version: "1.0.0",
    env: "test",
    checks: { db: "ok", redis: "ok" },
    features: { featureRequests: true },
  };

  it("accepts a valid health payload", () => {
    expect(HealthSchema.safeParse(validHealth).success).toBe(true);
  });

  it("requires features.featureRequests as a boolean", () => {
    expect(HealthSchema.safeParse({ ...validHealth, features: {} }).success).toBe(false);
    expect(
      HealthSchema.safeParse({ ...validHealth, features: { featureRequests: "yes" } }).success,
    ).toBe(false);
  });
});

describe("RegisterBody", () => {
  it("rejects an invalid email", () => {
    expect(
      RegisterBody.safeParse({ email: "not-an-email", password: "longenough", displayName: "A" })
        .success,
    ).toBe(false);
  });

  it("rejects a password shorter than the minimum", () => {
    expect(
      RegisterBody.safeParse({ email: "a@example.com", password: "short1", displayName: "A" })
        .success,
    ).toBe(false);
  });

  it("accepts a valid registration", () => {
    expect(
      RegisterBody.safeParse({ email: "a@example.com", password: "longenough", displayName: "A" })
        .success,
    ).toBe(true);
  });
});

describe("LoginBody", () => {
  it("rejects an invalid email", () => {
    expect(LoginBody.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("rejects a password shorter than the minimum", () => {
    expect(LoginBody.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
  });
});
