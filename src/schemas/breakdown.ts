import { z } from "zod";

/** Soft ceiling: above it the model is asked once more with this limit, then the answer is kept as is. */
export const MAX_STEPS = 50;
/** Loose parse bound so an oversize answer is counted by the code instead of failing schema validation. */
export const PARSE_MAX_STEPS = 200;
export const MAX_TAG_SUGGESTIONS = 3;

export const BreakdownSchema = z.object({
  steps: z.array(z.object({ title: z.string(), rationale: z.string() })).max(PARSE_MAX_STEPS),
  tagSuggestions: z.array(z.string()).max(MAX_TAG_SUGGESTIONS),
});

export type BreakdownResult = z.infer<typeof BreakdownSchema>;
