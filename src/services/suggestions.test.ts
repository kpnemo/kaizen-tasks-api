import { describe, expect, it } from "vitest";
import type { SuggestionState } from "../schemas/tasks.js";
import { ALLOWED_SUGGESTION_TRANSITIONS, canTransitionSuggestion } from "./suggestions.js";

const STATES: SuggestionState[] = ["suggested", "accepted", "dismissed"];

describe("suggestion transitions", () => {
  it("allows exactly the four documented transitions", () => {
    const allowed = new Set(ALLOWED_SUGGESTION_TRANSITIONS.map(([f, t]) => `${f}->${t}`));
    expect([...allowed].sort()).toEqual(
      [
        "accepted->dismissed",
        "dismissed->accepted",
        "suggested->accepted",
        "suggested->dismissed",
      ].sort(),
    );
    for (const from of STATES) {
      for (const to of STATES) {
        expect(canTransitionSuggestion(from, to), `${from}->${to}`).toBe(
          allowed.has(`${from}->${to}`),
        );
      }
    }
  });

  it("never allows a transition from a row without a suggestion state", () => {
    for (const to of STATES) expect(canTransitionSuggestion(null, to)).toBe(false);
  });
});
