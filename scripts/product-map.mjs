#!/usr/bin/env node
// Regenerates the generated half of docs/product-map.md: the map an agent reads before it
// interviews a product owner about a request. Everything above the marker line is hand-written
// prose and is kept as it is; everything below is replaced from this checkout's own files.
//
//   node scripts/product-map.mjs             write docs/product-map.md
//   node scripts/product-map.mjs --out FILE  write the regenerated map to FILE instead
//   node scripts/product-map.mjs --sources   print the files the generated half is built from
//
// Deterministic by construction: sorted output, no timestamps, no absolute paths, so a run on an
// unchanged tree is byte-identical to the committed file. The docs gate (scripts/docs-check.sh,
// Rule D) relies on that.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import ts from "typescript";

export const MAP_FILE = "docs/product-map.md";
export const MARKER = "<!-- product-map:generated -->";

const OPENAPI_FILE = "openapi.json";
const SCHEMA_FILE = "src/db/schema.ts";
const CHANGELOG_FILE = "CHANGELOG.md";
const ADR_DIR = "docs/adr";

const RELEASES_KEPT = 3;
const BULLETS_PER_RELEASE = 2;
const BULLET_LIMIT = 120;

/** Locale-independent so the order never depends on the machine's ICU data. */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files the generated half is built from. The header comes from `MAP_FILE` itself. */
export function listSources(root) {
  const adrs = readdirSync(path.join(root, ADR_DIR))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `${ADR_DIR}/${name}`);
  return [CHANGELOG_FILE, OPENAPI_FILE, SCHEMA_FILE, ...adrs].sort(byText);
}

// ---------------------------------------------------------------- src/db/schema.ts

/**
 * Every `pgTable("<name>", { ... })` call with the TypeScript property keys of its column object.
 * Parsed with the TypeScript compiler API, not a regex: anything this does not understand throws
 * with the file and line rather than silently dropping a table or a column.
 */
export function parseSchemaTables(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
  const fail = (node, message) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    throw new Error(`${file}:${line + 1}: ${message}`);
  };

  const tables = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "pgTable"
    ) {
      const [nameArg, columnsArg] = node.arguments;
      if (!nameArg || !ts.isStringLiteral(nameArg)) {
        fail(node, "pgTable() without a string-literal table name");
      }
      if (!columnsArg || !ts.isObjectLiteralExpression(columnsArg)) {
        fail(node, `pgTable("${nameArg.text}") without an object literal of columns`);
      }
      const columns = columnsArg.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) {
          fail(
            property,
            `pgTable("${nameArg.text}") has a column entry that is not a property assignment`,
          );
        }
        if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
          fail(property, `pgTable("${nameArg.text}") has a column key that is not a plain name`);
        }
        return property.name.text;
      });
      tables.push({ name: nameArg.text, columns });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return tables.sort((a, b) => byText(a.name, b.name));
}

// ---------------------------------------------------------------- openapi.json

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const PATH_ITEM_KEYS = new Set(["$ref", "summary", "description", "servers", "parameters"]);

/** One row per operation: tag, method, path and the summary (or the operationId when there is none). */
export function parseEndpoints(document, file) {
  if (!document || typeof document.paths !== "object" || document.paths === null) {
    throw new Error(`${file}: no "paths" object`);
  }
  const rows = [];
  for (const [route, item] of Object.entries(document.paths)) {
    for (const [key, operation] of Object.entries(item)) {
      if (PATH_ITEM_KEYS.has(key)) continue;
      if (!HTTP_METHODS.has(key)) {
        throw new Error(`${file}: unknown key "${key}" under paths["${route}"]`);
      }
      rows.push({
        tag: operation.tags?.[0] ?? "",
        method: key.toUpperCase(),
        path: route,
        summary: operation.summary ?? operation.operationId ?? "",
      });
    }
  }
  return rows.sort(
    (a, b) => byText(a.tag, b.tag) || byText(a.path, b.path) || byText(a.method, b.method),
  );
}

// ---------------------------------------------------------------- docs/adr/*.md

/** ADR number from the file name and title from the first heading, sorted by number. */
export function parseAdrs(files) {
  return files
    .map(({ file, text }) => {
      const number = path.basename(file).match(/^(\d{4})-/)?.[1];
      if (!number) throw new Error(`${file}: file name does not start with a four-digit number`);
      const heading = text.match(/^#\s+(.+)$/m)?.[1];
      if (!heading) throw new Error(`${file}: no "# " heading`);
      return { number, title: heading.replace(/^\d{4}:\s*/, "").trim() };
    })
    .sort((a, b) => byText(a.number, b.number));
}

// ---------------------------------------------------------------- CHANGELOG.md

const truncate = (text) => {
  if (text.length <= BULLET_LIMIT) return text;
  let cut = text.slice(0, BULLET_LIMIT - 1).trimEnd();
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut += "`";
  return `${cut}…`;
};

/** Bullets of one `## [...]` section, with wrapped continuation lines folded back into one line. */
function sectionBullets(lines) {
  const bullets = [];
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, "").trim());
    else if (line.trim() && !line.startsWith("#") && bullets.length) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
  }
  return bullets;
}

/** The `[Unreleased]` bullets in full, and the last three released sections, trimmed for size. */
export function parseChangelog(text, file) {
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) starts.push(index);
  });
  if (starts.length === 0) throw new Error(`${file}: no "## " version headings`);

  let unreleased = null;
  const releases = [];
  starts.forEach((start, index) => {
    const heading = lines[start].slice(3).trim();
    const body = lines.slice(start + 1, starts[index + 1] ?? lines.length);
    if (heading === "[Unreleased]") {
      unreleased = sectionBullets(body);
      return;
    }
    const released = heading.match(/^\[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})$/);
    if (!released)
      throw new Error(`${file}: heading "## ${heading}" is not [Unreleased] or a dated version`);
    if (releases.length < RELEASES_KEPT) {
      releases.push({
        version: released[1],
        date: released[2],
        bullets: sectionBullets(body).slice(0, BULLETS_PER_RELEASE).map(truncate),
      });
    }
  });

  if (unreleased === null) throw new Error(`${file}: no "## [Unreleased]" section`);
  return { unreleased, releases };
}

// ---------------------------------------------------------------- rendering

const code = (text) => `\`${text}\``;

function renderGenerated({ endpoints, tables, adrs, changelog }) {
  const out = [];
  out.push(
    "<!-- Generated by scripts/product-map.mjs. Do not edit below the marker: run `npm run product-map`. -->",
    "",
    `## Endpoints (${code(OPENAPI_FILE)})`,
    "",
    "Paths are relative to the `/api/v1` server prefix that the contract declares.",
    "",
    "| Tag | Method | Path | Summary |",
    "| --- | --- | --- | --- |",
  );
  for (const row of endpoints) {
    out.push(`| ${row.tag} | ${row.method} | ${code(row.path)} | ${row.summary} |`);
  }

  out.push("", `## Tables (${code(SCHEMA_FILE)})`, "");
  out.push(
    "Column entries are the TypeScript property keys of each `pgTable`, not the SQL column names.",
    "",
  );
  for (const table of tables) {
    out.push(`- ${code(table.name)}: ${table.columns.join(", ")}`);
  }

  out.push("", `## Decisions (${code(`${ADR_DIR}/`)})`, "");
  for (const adr of adrs) out.push(`- ${adr.number}: ${adr.title}`);

  out.push("", `## Unreleased changes (${code(CHANGELOG_FILE)})`, "");
  if (changelog.unreleased.length === 0) out.push("_Nothing unreleased._");
  else for (const bullet of changelog.unreleased) out.push(`- ${bullet}`);

  out.push("", "## Recent releases (history, not current behavior)", "");
  for (const release of changelog.releases) {
    out.push(`### ${release.version} - ${release.date}`, "");
    for (const bullet of release.bullets) out.push(`- ${bullet}`);
    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------- assembly

function readSources(root) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  return {
    endpoints: parseEndpoints(JSON.parse(read(OPENAPI_FILE)), OPENAPI_FILE),
    tables: parseSchemaTables(read(SCHEMA_FILE), SCHEMA_FILE),
    adrs: parseAdrs(
      listSources(root)
        .filter((file) => file.startsWith(`${ADR_DIR}/`))
        .map((file) => ({ file, text: read(file) })),
    ),
    changelog: parseChangelog(read(CHANGELOG_FILE), CHANGELOG_FILE),
  };
}

/**
 * The hand-written header, up to and including the marker line. The marker is matched as a whole
 * line: a changelog bullet that quotes it lands in the generated half and must not move the
 * boundary.
 */
export function splitHeader(text, file) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === MARKER);
  if (at === -1) throw new Error(`${file} has no line reading ${MARKER}`);
  return `${lines.slice(0, at).join("\n").trimEnd()}\n\n${MARKER}\n`;
}

function readHeader(root) {
  const mapPath = path.join(root, MAP_FILE);
  let text;
  try {
    text = readFileSync(mapPath, "utf8");
  } catch {
    throw new Error(`${MAP_FILE} is missing; its hand-written header cannot be regenerated`);
  }
  return splitHeader(text, MAP_FILE);
}

export async function buildMap(root) {
  const text = `${readHeader(root)}\n${renderGenerated(readSources(root))}`;
  const filepath = path.join(root, MAP_FILE);
  const options = await prettier.resolveConfig(filepath);
  return prettier.format(text, { ...options, filepath, parser: "markdown" });
}

async function main(argv) {
  const root = repoRoot();
  if (argv.includes("--sources")) {
    process.stdout.write(`${listSources(root).join("\n")}\n`);
    return;
  }
  const outIndex = argv.indexOf("--out");
  if (outIndex !== -1 && !argv[outIndex + 1]) throw new Error("--out needs a file path");
  const out = outIndex === -1 ? path.join(root, MAP_FILE) : path.resolve(argv[outIndex + 1]);
  writeFileSync(out, await buildMap(root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`product-map: ${error.message}\n`);
    process.exit(1);
  });
}
