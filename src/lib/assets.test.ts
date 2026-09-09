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
    expect(
      missingAssets([
        { name: "present", path: present },
        { name: "prompt", path: absent },
      ]),
    ).toEqual([{ name: "prompt", path: absent }]);
    expect(() => assertRuntimeAssets([{ name: "present", path: present }])).not.toThrow();
  });

  it("fails fast naming every missing path", () => {
    expect(() =>
      assertRuntimeAssets([
        { name: "prompt", path: absent },
        { name: "openapi.json", path: join(dir, "openapi.json") },
      ]),
    ).toThrow(
      `Missing runtime assets:\n  - prompt: ${absent}\n  - openapi.json: ${join(dir, "openapi.json")}`,
    );
  });
});
