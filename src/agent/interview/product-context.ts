import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../lib/logger.js";

/** Spec 3.2: what the interviewer knows about the product, as three markdown documents. */
export interface ProductContext {
  /** This repo's docs/product-map.md, history sections removed. */
  api: string;
  /** kpnemo/kaizen-tasks-web docs/product-map.md, history sections removed; null until a fetch succeeds. */
  web: string | null;
  /** kpnemo/kaizen-tasks-web docs/ui-conventions.md, whole; null until a fetch succeeds. */
  conventions: string | null;
  fetchedAt: string | null;
}

export type WebDocPath = "docs/product-map.md" | "docs/ui-conventions.md";

export interface ProductContextSource {
  readApiMap(): string;
  fetchWebDoc(path: WebDocPath): Promise<string>;
}

/** Three levels above src/agent/interview/ (and dist/agent/interview/) is the package root. */
export const API_MAP_URL = new URL("../../../docs/product-map.md", import.meta.url);

export function diskApiMapPath(): string {
  return fileURLToPath(API_MAP_URL);
}

const HISTORY_HEADINGS = ["## Recent releases", "## Unreleased changes"];

/** Drops the history sections: from a matching `## ` heading to the next `## ` heading or the end. */
export function trimHistory(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      dropping = HISTORY_HEADINGS.some((heading) => line.startsWith(heading));
    }
    if (!dropping) kept.push(line);
  }
  return (
    kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

const FETCH_TIMEOUT_MS = 10_000;

/** GitHub raw, no token: both repos are public (spec 3.2). */
export function githubRawSource(
  ref: string,
  fetchImpl: typeof fetch = fetch,
): ProductContextSource {
  return {
    readApiMap: () => readFileSync(API_MAP_URL, "utf8"),
    async fetchWebDoc(path) {
      const url = `https://raw.githubusercontent.com/kpnemo/kaizen-tasks-web/${ref}/${path}`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.text();
    },
  };
}

export class ProductContextLoader {
  private context: ProductContext;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly source: ProductContextSource,
    private readonly options: { refreshMs: number; log: Logger },
  ) {
    this.context = {
      api: trimHistory(source.readApiMap()),
      web: null,
      conventions: null,
      fetchedAt: null,
    };
  }

  /** First load, then the timer. Resolves after the first fetch attempt, success or not. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs);
    // vitest fake timers may not implement unref; production Node timers do.
    this.timer.unref?.();
  }

  /** Fetches both web documents together; a failure of either keeps the previous pair. */
  async refresh(): Promise<void> {
    try {
      const [web, conventions] = await Promise.all([
        this.source.fetchWebDoc("docs/product-map.md"),
        this.source.fetchWebDoc("docs/ui-conventions.md"),
      ]);
      this.context = {
        ...this.context,
        web: trimHistory(web),
        conventions,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.options.log.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        "product context: web documents not fetched, keeping the previous ones",
      );
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  current(): ProductContext {
    return this.context;
  }
}
