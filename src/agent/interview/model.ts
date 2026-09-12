import type {
  ConversationMessage,
  FeatureRequestDraft,
  InterviewQuestion,
  RubricScore,
} from "../../schemas/feature-request-conversations.js";
import { AnthropicInterviewModel } from "./anthropic-interview-model.js";
import { FAKE_INTERVIEW_DELAY_MS, FakeInterviewModel } from "./fake-interview-model.js";

/** Eight questions, then the assistant stops asking (spec 2, refine-request Step 4). */
export const MAX_INTERVIEW_QUESTIONS = 8;

export interface InterviewInput {
  /** The whole transcript, greeting included, ending with the PM's new answer. */
  messages: ConversationMessage[];
  draft: FeatureRequestDraft;
  score: RubricScore | null;
  /** How many questions the assistant has already asked in this conversation. */
  questionCount: number;
  /** True when the PM pressed "Skip this question" instead of answering. */
  skippedLast: boolean;
  /** True when the PM pressed "Finish with what we have". */
  finishedLast: boolean;
}

export interface InterviewTurn {
  /** The full text that was streamed, trimmed. */
  reply: string;
  /** null when the interview is done. */
  question: InterviewQuestion | null;
  draft: FeatureRequestDraft;
  score: RubricScore;
  done: boolean;
  stillMissing: string[];
}

export type InterviewOutcome =
  { kind: "ok"; turn: InterviewTurn } | { kind: "invalid"; reason: string };

/** Called with each piece of the assistant's reply, in order. */
export type InterviewDelta = (text: string) => void;

/** The seam between the conversation service and any model provider. */
export interface InterviewModel {
  respond(
    input: InterviewInput,
    onDelta: InterviewDelta,
    signal: AbortSignal,
  ): Promise<InterviewOutcome>;
}

export interface InterviewModelSelection {
  provider: "anthropic" | "fake";
  model: string;
  apiKey?: string;
}

/** Picks the adapter from config once at startup, like `createBreakdownModel`. */
export function createInterviewModel(selection: InterviewModelSelection): InterviewModel {
  if (selection.provider === "fake") {
    return new FakeInterviewModel({ delayMs: FAKE_INTERVIEW_DELAY_MS });
  }
  if (!selection.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when AI_MODEL_PROVIDER=anthropic");
  }
  return new AnthropicInterviewModel({ apiKey: selection.apiKey, model: selection.model });
}
