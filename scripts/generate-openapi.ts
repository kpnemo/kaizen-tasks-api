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
