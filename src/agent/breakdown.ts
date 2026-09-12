import { MAX_TAG_SUGGESTIONS, type BreakdownResult } from "../schemas/breakdown.js";
import { BreakdownInvalid, BreakdownRefused } from "./errors.js";
import type { BreakdownInput, BreakdownModel } from "./model.js";

export const MIN_TITLE_WORDS = 3;

/** Skip rule from spec 5.2: fewer than three words in the title and no description. */
export function shouldSkipBreakdown(
  title: string,
  description: string | null | undefined,
): boolean {
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  return words < MIN_TITLE_WORDS && (description ?? "").trim().length === 0;
}

/** Trim, drop empties, deduplicate case-insensitively, keep every distinct step, cap tag suggestions at three. */
export function postValidate(raw: BreakdownResult): BreakdownResult {
  const seenTitles = new Set<string>();
  const steps: BreakdownResult["steps"] = [];
  for (const step of raw.steps) {
    const title = step.title.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    steps.push({ title, rationale: step.rationale.trim() });
  }

  const seenTags = new Set<string>();
  const tagSuggestions: string[] = [];
  for (const suggestion of raw.tagSuggestions) {
    const name = suggestion.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tagSuggestions.push(name);
    if (tagSuggestions.length === MAX_TAG_SUGGESTIONS) break;
  }
  return { steps, tagSuggestions };
}

/** Pure orchestration: call the model, translate outcomes into errors, post-validate. */
export async function breakdownTask(
  input: BreakdownInput,
  model: BreakdownModel,
): Promise<BreakdownResult> {
  const outcome = await model.complete(input);
  if (outcome.kind === "refused") throw new BreakdownRefused(outcome.reason);
  if (outcome.kind === "invalid") throw new BreakdownInvalid(outcome.reason);
  return postValidate(outcome.result);
}
