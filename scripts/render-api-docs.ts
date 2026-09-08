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
  if (Array.isArray(schema.allOf))
    return (schema.allOf as unknown[]).map((v) => typeName(v, components)).join(" & ");
  const type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    const base =
      nonNull.length === 1
        ? typeName({ ...schema, type: nonNull[0] }, components)
        : nonNull.join(" | ");
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
    ([name, prop]) =>
      `| ${name} | ${typeName(prop, components)} | ${required.has(name) ? "yes" : "no"} |`,
  );
}

function renderOperation(method: string, path: string, op: Json, components: Json): string {
  const lines: string[] = [`## ${method.toUpperCase()} ${path}`, ""];
  if (typeof op.summary === "string") lines.push(op.summary, "");
  if (typeof op.description === "string") lines.push(op.description, "");
  lines.push(
    `Auth: ${Array.isArray(op.security) && op.security.length > 0 ? "bearer access token" : "none"}`,
    "",
  );

  const params = Array.isArray(op.parameters) ? (op.parameters as Json[]) : [];
  if (params.length > 0) {
    lines.push(
      "**Parameters**",
      "",
      "| Name | In | Type | Required | Description |",
      "|---|---|---|---|---|",
    );
    for (const p of params) {
      lines.push(
        `| ${String(p.name)} | ${String(p.in)} | ${typeName(p.schema, components)} | ${p.required ? "yes" : "no"} | ${typeof p.description === "string" ? p.description : ""} |`,
      );
    }
    lines.push("");
  }

  const body = isObject(op.requestBody) ? op.requestBody : undefined;
  const content = body && isObject(body.content) ? body.content : undefined;
  const json =
    content && isObject(content["application/json"]) ? content["application/json"] : undefined;
  if (json) {
    lines.push(
      "**Request body** (`application/json`)",
      "",
      "| Field | Type | Required |",
      "|---|---|---|",
    );
    lines.push(...bodyRows(json.schema, components));
    lines.push("");
  }

  const responses = isObject(op.responses) ? op.responses : {};
  lines.push("**Responses**", "", "| Status | Description | Body |", "|---|---|---|");
  for (const [status, response] of Object.entries(responses)) {
    const r = isObject(response) ? response : {};
    const rc =
      isObject(r.content) && isObject(r.content["application/json"])
        ? r.content["application/json"]
        : undefined;
    const bodyType = rc ? typeName(rc.schema, components) : "";
    lines.push(
      `| ${status} | ${typeof r.description === "string" ? r.description : ""} | ${bodyType} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderApiDocs(doc: OpenApiDocument): string {
  const d = doc as unknown as Json;
  const components = isObject(d.components) ? d.components : {};
  const paths = isObject(d.paths) ? d.paths : {};
  const servers = Array.isArray(d.servers) ? (d.servers as Json[]) : [];
  const basePath = isObject(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : "";
  const out: string[] = [
    "# Kaizen Tasks API reference",
    "",
    "Generated from `openapi.json` by `npm run openapi`. Do not edit by hand.",
    "",
    `Base path: \`${basePath}\``,
    "",
    "Paths below are relative to the base path. Success responses are `{ data, meta }`; errors are `{ error: { code, message, details?, requestId } }`.",
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

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.cwd();
  const doc = JSON.parse(readFileSync(resolve(root, "openapi.json"), "utf8")) as OpenApiDocument;
  writeFileSync(resolve(root, "docs/API.md"), renderApiDocs(doc));
  console.log("wrote docs/API.md from openapi.json");
}
