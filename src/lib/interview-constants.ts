import type { FeatureRequestDraft } from "../schemas/feature-request-conversations.js";

/** Every field empty: what a conversation starts with, and the fill for a partial stored draft. */
export const EMPTY_DRAFT: FeatureRequestDraft = {
  title: "",
  problem: "",
  proposedBehavior: "",
  acceptanceCriteria: "",
  outOfScope: "",
};

/** Recorded as the user message's content when the PM skips a question (spec 3.2). */
export const SKIPPED_CONTENT = "(skipped)";

/** Recorded as the user message's content when the PM presses "Finish with what we have" (spec 3.5). */
export const FINISHED_CONTENT = "Finish with what we have";

/**
 * The Messages API requires the first message to be a user turn, but the interview's first message
 * is the assistant's greeting. This fixed opener carries that, and never varies, so it stays inside
 * the cached prefix.
 */
export const TRANSCRIPT_OPENER = "Start the interview.";
