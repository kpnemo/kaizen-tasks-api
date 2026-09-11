import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./index.js";
import { renderApiDocs } from "../../scripts/render-api-docs.js";

const EXPECTED_ENDPOINTS: Array<[string, string]> = [
  ["post", "/auth/register"],
  ["post", "/auth/login"],
  ["post", "/auth/refresh"],
  ["post", "/auth/logout"],
  ["get", "/auth/me"],
  ["patch", "/auth/me"],
  ["get", "/tasks"],
  ["post", "/tasks"],
  ["get", "/tasks/{id}"],
  ["patch", "/tasks/{id}"],
  ["delete", "/tasks/{id}"],
  ["post", "/tasks/{id}/breakdown"],
  ["post", "/tasks/{id}/suggestions/accept-all"],
  ["post", "/tasks/{id}/suggestions/dismiss-all"],
  ["put", "/tasks/{id}/tags"],
  ["get", "/tags"],
  ["post", "/tags"],
  ["patch", "/tags/{id}"],
  ["delete", "/tags/{id}"],
  ["get", "/feature-requests"],
  ["post", "/feature-requests"],
  ["get", "/feature-requests/conversation"],
  ["post", "/feature-requests/conversation"],
  ["post", "/feature-requests/conversation/{id}/messages"],
  ["get", "/pipeline"],
  ["post", "/admin/seed-reset"],
  ["get", "/health"],
  ["get", "/openapi.json"],
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

  it("declares the /api/v1 base path in servers", () => {
    expect(doc.servers?.[0]?.url).toBe("/api/v1");
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
    const tasksGet = (paths["/tasks"] as { get: { security?: unknown } }).get;
    expect(tasksGet.security).toEqual([{ bearerAuth: [] }]);
    const registerPost = (paths["/auth/register"] as { post: { security?: unknown } }).post;
    expect(registerPost.security).toBeUndefined();
  });

  it("documents request bodies and query parameters", () => {
    const create = (paths["/tasks"] as { post: { requestBody?: unknown } }).post;
    expect(create.requestBody).toBeDefined();
    const list = (paths["/tasks"] as { get: { parameters?: Array<{ name: string; in: string }> } })
      .get;
    expect(list.parameters?.map((p) => p.name).sort()).toEqual([
      "cursor",
      "limit",
      "parentId",
      "status",
      "tagId",
    ]);
  });
});

describe("renderApiDocs", () => {
  const md = renderApiDocs(generateOpenApiDocument());

  it("has one section per path and method with summary, parameters, body and responses", () => {
    for (const [method, path] of EXPECTED_ENDPOINTS) {
      expect(md).toContain(`## ${method.toUpperCase()} ${path}`);
    }
    const patchTask = md.slice(md.indexOf("## PATCH /tasks/{id}"));
    const section = patchTask.slice(0, patchTask.indexOf("\n## ", 1));
    expect(section).toContain("Update a task");
    expect(section).toContain("| id | path | string (uuid) | yes |");
    expect(section).toContain("| suggestionState | SuggestionState |");
    expect(section).toContain("| 200 |");
    expect(section).toContain("| 404 |");
  });

  it("starts with the generated-file banner", () => {
    expect(md.startsWith("# Kaizen Tasks API reference\n\nGenerated from `openapi.json`")).toBe(
      true,
    );
  });
});

describe("the README route table", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  it("lists every path the contract declares", () => {
    for (const [method, path] of EXPECTED_ENDPOINTS) {
      expect(readme, `${method} ${path}`).toContain(`\`${method.toUpperCase()} ${path}\``);
    }
  });
});
