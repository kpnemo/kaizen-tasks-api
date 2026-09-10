import type {
  ConversationMessage,
  FeatureRequestDraft,
  InterviewQuestion,
  RubricScore,
} from "../../schemas/feature-request-conversations.js";

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
