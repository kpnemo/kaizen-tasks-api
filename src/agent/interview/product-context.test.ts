import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../lib/logger.js";
import { ProductContextLoader, trimHistory, type ProductContextSource } from "./product-context.js";

const API_MAP = `# Product map: Kaizen Tasks API

Prose header.

## Endpoints (\`openapi.json\`)

| Tag | Method | Path | Summary |
| --- | --- | --- | --- |
| tasks | GET | \`/tasks\` | List tasks |

## Unreleased changes (\`CHANGELOG.md\`)

- something pending

## Recent releases (history, not current behavior)

- 1.5.0
`;

const WEB_MAP =
  "# Product map: kaizen-tasks-web\n\n## Screens\n\n| Path | Renders |\n| --- | --- |\n| `/tasks` | `TaskListPage` |\n\n## Recent releases (history, not current behavior)\n\n- 1.5.0\n";
const CONVENTIONS = "# UI conventions\n\n## shadcn first\n\nUse the primitives.\n";

function log(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function source(overrides: Partial<ProductContextSource> = {}): ProductContextSource {
  return {
    readApiMap: () => API_MAP,
    fetchWebDoc: async (path) => (path === "docs/product-map.md" ? WEB_MAP : CONVENTIONS),
    ...overrides,
  };
}

describe("trimHistory", () => {
  it("drops the Recent releases and Unreleased changes sections and keeps everything else", () => {
    const trimmed = trimHistory(API_MAP);
    expect(trimmed).toContain("## Endpoints");
    expect(trimmed).toContain("| tasks | GET |");
    expect(trimmed).toContain("Prose header.");
    expect(trimmed).not.toContain("Recent releases");
    expect(trimmed).not.toContain("Unreleased changes");
    expect(trimmed).not.toContain("1.5.0");
  });
});

describe("ProductContextLoader", () => {
  it("reads the API map from disk and the web documents from the source", async () => {
    const loader = new ProductContextLoader(source(), { refreshMs: 60_000, log: log() });
    await loader.start();
    const context = loader.current();
    expect(context.api).toContain("## Endpoints");
    expect(context.web).toContain("## Screens");
    expect(context.web).not.toContain("Recent releases");
    expect(context.conventions).toBe(CONVENTIONS);
    expect(context.fetchedAt).not.toBeNull();
    loader.stop();
  });

  it("keeps null web fields and logs once when the first fetch fails, and never throws", async () => {
    const logger = log();
    const loader = new ProductContextLoader(
      source({
        fetchWebDoc: async () => {
          throw new Error("boom");
        },
      }),
      { refreshMs: 60_000, log: logger },
    );
    await expect(loader.start()).resolves.toBeUndefined();
    expect(loader.current()).toMatchObject({ web: null, conventions: null, fetchedAt: null });
    expect(loader.current().api).toContain("## Endpoints");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    loader.stop();
  });

  it("keeps the previous good pair when a refresh fails", async () => {
    let fail = false;
    const loader = new ProductContextLoader(
      source({
        fetchWebDoc: async (path) => {
          if (fail) throw new Error("boom");
          return path === "docs/product-map.md" ? WEB_MAP : CONVENTIONS;
        },
      }),
      { refreshMs: 60_000, log: log() },
    );
    await loader.start();
    fail = true;
    await loader.refresh();
    expect(loader.current().web).toContain("## Screens");
    loader.stop();
  });

  it("refreshes on the timer and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const fetchWebDoc = vi.fn(async (path: string) =>
        path === "docs/product-map.md" ? WEB_MAP : CONVENTIONS,
      );
      const loader = new ProductContextLoader(source({ fetchWebDoc }), {
        refreshMs: 1_000,
        log: log(),
      });
      await loader.start();
      expect(fetchWebDoc).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchWebDoc).toHaveBeenCalledTimes(4);
      loader.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchWebDoc).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the real API map on disk", () => {
  it("is found three levels above the interview module", async () => {
    const { diskApiMapPath } = await import("./product-context.js");
    expect(diskApiMapPath()).toMatch(/docs[/\\]product-map\.md$/);
  });
});
