import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolved relative to this module, so the same code finds src/agent/prompts/ under tsx and
 * dist/agent/prompts/ after `scripts/copy-assets.sh`.
 */
export const PROMPT_URL = new URL("./prompts/breakdown.system.md", import.meta.url);

export function promptPath(): string {
  return fileURLToPath(PROMPT_URL);
}

let cached: string | undefined;

/** Reads the versioned system prompt once. Throws if it is missing or empty. */
export function loadSystemPrompt(): string {
  if (cached === undefined) {
    const text = readFileSync(PROMPT_URL, "utf8");
    if (text.trim().length === 0) throw new Error(`System prompt is empty: ${promptPath()}`);
    cached = text;
  }
  return cached;
}
