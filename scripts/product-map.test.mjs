import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import {
  MAP_FILE,
  listSources,
  parseAdrs,
  parseChangelog,
  parseEndpoints,
  parseSchemaTables,
} from "./product-map.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "product-map.mjs");

const run = (...args) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

const generateTo = (name) => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "product-map-")), name);
  run("--out", out);
  return out;
};

const committedMap = () => readFileSync(path.join(root, MAP_FILE), "utf8");

// ---------------------------------------------------------------- fixtures

const SCHEMA_FIXTURE = `
import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const colourEnum = pgEnum("colour", ["red", "blue"]);

export const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
});

export const crates = pgTable(
  "crates",
  {
    id: uuid("id").primaryKey(),
    widgetId: uuid("widget_id").references(() => widgets.id),
  },
  (t) => [index("crates_widget_idx").on(t.widgetId)],
);
`;

const OPENAPI_FIXTURE = {
  paths: {
    "/widgets": {
      get: { tags: ["widgets"], summary: "List widgets" },
      post: { tags: ["widgets"], summary: "Create a widget" },
    },
    "/crates/{id}": {
      parameters: [{ name: "id", in: "path" }],
      delete: { tags: ["crates"], operationId: "deleteCrate" },
    },
  },
};

const CHANGELOG_FIXTURE = `# Changelog

## [Unreleased]

### Added

- An unreleased bullet that is kept in full even when it runs well past one hundred and twenty characters, because unreleased work is current behaviour.

## [1.2.0] - 2026-09-10

### Added

- ${"a".repeat(200)}
- Second bullet.
- Third bullet, dropped.

## [1.1.0] - 2026-09-09

### Fixed

- Only bullet.

## [1.0.0] - 2026-09-08

### Added

- Oldest kept release.

## [0.9.0] - 2026-09-07

### Added

- Dropped: only three releases are kept.
`;

// ---------------------------------------------------------------- helpers on fixtures

describe("parseSchemaTables", () => {
  it("returns every pgTable with its TypeScript property keys, sorted by table name", () => {
    expect(parseSchemaTables(SCHEMA_FIXTURE, "fixture.ts")).toEqual([
      { name: "crates", columns: ["id", "widgetId"] },
      { name: "widgets", columns: ["id", "displayName"] },
    ]);
  });

  it("fails with the file and line when the table name is not a string literal", () => {
    const source = `const t = pgTable(NAME, { id: uuid("id") });\n`;
    expect(() => parseSchemaTables(source, "fixture.ts")).toThrow(/fixture\.ts:1:/);
  });

  it("fails with the file and line on a column property it does not understand", () => {
    const source = `const a = 1;\nconst t = pgTable("t", { ...base, id: uuid("id") });\n`;
    expect(() => parseSchemaTables(source, "fixture.ts")).toThrow(/fixture\.ts:2:/);
  });
});

describe("parseEndpoints", () => {
  it("returns one row per operation, sorted by tag then path then method", () => {
    expect(parseEndpoints(OPENAPI_FIXTURE, "fixture.json")).toEqual([
      { tag: "crates", method: "DELETE", path: "/crates/{id}", summary: "deleteCrate" },
      { tag: "widgets", method: "GET", path: "/widgets", summary: "List widgets" },
      { tag: "widgets", method: "POST", path: "/widgets", summary: "Create a widget" },
    ]);
  });

  it("fails on a key under a path item it does not understand", () => {
    const doc = { paths: { "/widgets": { wibble: {} } } };
    expect(() => parseEndpoints(doc, "fixture.json")).toThrow(/wibble/);
  });
});

describe("parseAdrs", () => {
  it("returns number and title, sorted, with the number prefix stripped from the title", () => {
    const files = [
      { file: "docs/adr/0002-second.md", text: "# 0002: Second decision\n\n- Status: Accepted\n" },
      { file: "docs/adr/0001-first.md", text: "# 0001: First decision\n" },
    ];
    expect(parseAdrs(files)).toEqual([
      { number: "0001", title: "First decision" },
      { number: "0002", title: "Second decision" },
    ]);
  });

  it("fails with the file when an ADR has no heading", () => {
    expect(() => parseAdrs([{ file: "docs/adr/0003-x.md", text: "no heading\n" }])).toThrow(
      /0003-x\.md/,
    );
  });
});

describe("parseChangelog", () => {
  const parsed = parseChangelog(CHANGELOG_FIXTURE, "CHANGELOG.md");

  it("keeps every [Unreleased] bullet in full", () => {
    expect(parsed.unreleased).toEqual([
      "An unreleased bullet that is kept in full even when it runs well past one hundred and twenty characters, because unreleased work is current behaviour.",
    ]);
  });

  it("keeps the last three releases with at most two bullets each, cut at 120 characters", () => {
    expect(parsed.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(parsed.releases[0].date).toBe("2026-09-10");
    expect(parsed.releases[0].bullets).toHaveLength(2);
    expect(parsed.releases[0].bullets[0]).toHaveLength(120);
    expect(parsed.releases[0].bullets[0].endsWith("…")).toBe(true);
    expect(parsed.releases[0].bullets[1]).toBe("Second bullet.");
  });
});

// ---------------------------------------------------------------- the real files

describe("the real sources", () => {
  it("lists the files it reads, one relative path per line, all of which exist", () => {
    const lines = run("--sources").trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(path.isAbsolute(line)).toBe(false);
      expect(statSync(path.join(root, line)).isFile()).toBe(true);
    }
    expect(lines).toEqual(listSources(root));
    expect(lines).toEqual([...lines].sort());
  });

  it("carries every table in src/db/schema.ts with its keys", () => {
    const source = readFileSync(path.join(root, "src/db/schema.ts"), "utf8");
    const declared = [...source.matchAll(/pgTable\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThan(0);

    const parsed = parseSchemaTables(source, "src/db/schema.ts");
    expect(parsed.map((t) => t.name)).toEqual(declared);
    expect(parsed.find((t) => t.name === "users").columns).toEqual([
      "id",
      "email",
      "passwordHash",
      "displayName",
      "theme",
      "createdAt",
      "updatedAt",
    ]);

    const map = committedMap();
    for (const table of parsed) {
      expect(map).toContain(`\`${table.name}\``);
      for (const column of table.columns) expect(map).toContain(column);
    }
  });

  it("carries every endpoint in openapi.json", () => {
    const doc = JSON.parse(readFileSync(path.join(root, "openapi.json"), "utf8"));
    const rows = parseEndpoints(doc, "openapi.json");
    expect(rows.length).toBeGreaterThan(20);

    const map = committedMap();
    for (const row of rows) {
      expect(map).toContain(`\`${row.path}\``);
      expect(map).toMatch(new RegExp(`${row.method}[^\\n]*\`${escapeForRegExp(row.path)}\``));
    }
  });
});

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- the generated file

describe("npm run product-map", () => {
  it("is idempotent: two runs produce byte-identical output", () => {
    const first = readFileSync(generateTo("first.md"));
    const second = readFileSync(generateTo("second.md"));
    expect(first.equals(second)).toBe(true);
  });

  it("writes markdown that passes the repo's prettier --check", async () => {
    const filepath = path.join(root, MAP_FILE);
    const options = await prettier.resolveConfig(filepath);
    const text = readFileSync(generateTo("formatted.md"), "utf8");
    expect(await prettier.check(text, { ...options, filepath })).toBe(true);
  });

  it("leaves docs/product-map.md fresh: regenerating produces no diff", () => {
    expect(readFileSync(generateTo("fresh.md"), "utf8")).toBe(committedMap());
  });

  it("keeps the hand-written header above the marker and generates below it", () => {
    const map = committedMap();
    const marker = "<!-- product-map:generated -->";
    const header = map.slice(0, map.indexOf(marker)).trimEnd().split("\n");
    expect(header.length).toBeGreaterThanOrEqual(8);
    expect(header.length).toBeLessThanOrEqual(15);
    expect(header.at(-1)).toMatch(/^Reviewed: \d{4}-\d{2}-\d{2} /);
  });

  it("stays inside the interview context budget: under 12 KB and 250 lines", () => {
    const map = committedMap();
    expect(Buffer.byteLength(map, "utf8")).toBeLessThan(12 * 1024);
    expect(map.split("\n").length).toBeLessThan(250);
  });
});
