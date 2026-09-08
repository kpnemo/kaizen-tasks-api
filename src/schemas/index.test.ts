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
      const op = (
        paths[path] as Record<string, { summary?: string; responses?: Record<string, unknown> }>
      )[method];
      expect(op?.summary, `${method} ${path}`).toBeTruthy();
      expect(Object.keys(op?.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it("registers the shared components and bearer security", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      "User",
      "Tag",
      "TaskSummary",
      "TaskDetail",
      "ErrorEnvelope",
      "ValidationDetail",
      "RateLimitDetails",
      "Health",
    ]) {
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
    const list = (
      paths["/api/v1/tasks"] as { get: { parameters?: Array<{ name: string; in: string }> } }
    ).get;
    expect(list.parameters?.map((p) => p.name).sort()).toEqual([
      "cursor",
      "limit",
      "parentId",
      "status",
      "tagId",
    ]);
  });
});
