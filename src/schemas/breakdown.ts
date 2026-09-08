import { z } from "zod";

export const MIN_STEPS = 3;
export const MAX_STEPS = 7;
export const MAX_TAG_SUGGESTIONS = 3;

export const BreakdownSchema = z.object({
  steps: z
    .array(z.object({ title: z.string(), rationale: z.string() }))
    .min(MIN_STEPS)
    .max(MAX_STEPS),
  tagSuggestions: z.array(z.string()).max(MAX_TAG_SUGGESTIONS),
});

export type BreakdownResult = z.infer<typeof BreakdownSchema>;
