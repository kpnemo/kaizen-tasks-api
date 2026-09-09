import type { SuggestionState } from "../schemas/tasks.js";

/** From spec 4.4: suggested to accepted or dismissed, dismissed to accepted, accepted to dismissed. */
export const ALLOWED_SUGGESTION_TRANSITIONS: ReadonlyArray<
  readonly [SuggestionState, SuggestionState]
> = [
  ["suggested", "accepted"],
  ["suggested", "dismissed"],
  ["dismissed", "accepted"],
  ["accepted", "dismissed"],
];

export function canTransitionSuggestion(
  from: SuggestionState | null,
  to: SuggestionState,
): boolean {
  if (from === null) return false;
  return ALLOWED_SUGGESTION_TRANSITIONS.some(([f, t]) => f === from && t === to);
}
