import { EMPTY_DRAFT } from "../../lib/interview-constants.js";
import type {
  ConversationMessage,
  FeatureRequestDraft,
  InterviewQuestion,
  RubricScore,
} from "../../schemas/feature-request-conversations.js";
import type { InterviewDelta, InterviewInput, InterviewModel, InterviewOutcome } from "./model.js";

export type FakeInterviewMode = "ok" | "invalid";

/** Pacing for `AI_MODEL_PROVIDER=fake` in development and the demo; tests use the default 0. */
export const FAKE_INTERVIEW_DELAY_MS = 150;

export const FAKE_INTERVIEW_SCORE: RubricScore = {
  clarity: 4,
  complexity: 2,
  risk: 2,
  archChange: false,
  readiness: 16,
  reasons: {
    clarity: "Three checkable criteria and a stated scope.",
    complexity: "One feature folder in the web app and one endpoint.",
    risk: "A new control that cannot affect other features or stored data.",
  },
};

interface ScriptedTurn {
  reply: string;
  question: InterviewQuestion;
}

/** Spec 3.4: keyed on questionCount, 0 through 2 ask; 3 and later finish. */
const SCRIPT: ScriptedTurn[] = [
  {
    reply: "That gives me the shape of it. Who is the user, and at what moment does this happen?",
    question: {
      text: "Who is the user, and at what moment does this happen?",
      options: [
        "A team supervisor before a coaching session",
        "An agent during a call",
        "A workforce planner on Monday",
      ],
    },
  },
  {
    reply: "Noted. What does the user see on the screen when this works?",
    question: {
      text: "What does the user see on the screen when this works?",
      options: [
        "A list of agents with the contact reasons where they score below the team",
        "A banner at the top of the team page",
        "A short summary above the existing table",
      ],
    },
  },
  {
    reply: "Good. What would a tester check to say this is done?",
    question: {
      text: "What would a tester check to say this is done?",
      options: [
        "Opening the page for a team of 12 shows all 12 agents within 2 seconds",
        "An agent with no data reads Not enough data instead of being blank",
        "Changing the date range refreshes the numbers without a reload",
      ],
    },
  },
];

const DONE_REPLY =
  "That is enough to file it: the request now names the user, the behavior and three checkable criteria.";

/** Three pieces whose concatenation is exactly the input, split on word boundaries. */
export function splitIntoThree(text: string): [string, string, string] {
  const words = text.split(" ");
  const per = Math.ceil(words.length / 3);
  const piece = (n: number): string => {
    const part = words.slice(n * per, (n + 1) * per);
    if (part.length === 0) return "";
    return (n === 0 ? "" : " ") + part.join(" ");
  };
  return [piece(0), piece(1), piece(2)];
}

/**
 * The PM's answers in order, positionally: index 0 is the opening idea, index 1 answers the turn-0
 * question, index 2 answers turn 1, index 3 answers turn 2. A skipped answer keeps its position and
 * becomes an empty string, so a skip leaves exactly the field it would have filled empty.
 */
function answersByTurn(messages: ConversationMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (m.skipped === true ? "" : m.content.trim()));
}

/**
 * The draft the scripted interview would have built from what the PM actually said, mapped by
 * scripted turn index. Unknown fields are empty strings; the fake never invents placeholder prose.
 */
function draftFrom(input: InterviewInput): FeatureRequestDraft {
  const answers = answersByTurn(input.messages);
  const idea = answers[0] ?? "";
  const userAndMoment = answers[1] ?? "";
  const behavior = answers[2] ?? "";
  const criterion = answers[3] ?? "";
  return {
    ...EMPTY_DRAFT,
    title: idea,
    problem: [idea, userAndMoment].filter((part) => part.length > 0).join(" "),
    proposedBehavior: behavior,
    acceptanceCriteria: criterion.length > 0 ? `- ${criterion}` : "",
    // The fake never reaches the out-of-scope rung of the ladder.
    outOfScope: "",
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("interview aborted");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const onAbort = (): void => {
      clearTimeout(timer.id);
      reject(abortError(signal));
    };
    timer.id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A scripted four-turn interview. Used for AI_MODEL_PROVIDER=fake and in every test. */
export class FakeInterviewModel implements InterviewModel {
  mode: FakeInterviewMode;
  /** Mutable: an integration test raises it to overlap two requests or to outlive a timeout. */
  delayMs: number;
  readonly calls: InterviewInput[] = [];

  constructor(options: { mode?: FakeInterviewMode; delayMs?: number } = {}) {
    this.mode = options.mode ?? "ok";
    this.delayMs = options.delayMs ?? 0;
  }

  async respond(
    input: InterviewInput,
    onDelta: InterviewDelta,
    signal: AbortSignal,
  ): Promise<InterviewOutcome> {
    this.calls.push(input);
    const scripted = SCRIPT[input.questionCount];
    const reply = scripted?.reply ?? DONE_REPLY;
    for (const chunk of splitIntoThree(reply)) {
      if (this.delayMs > 0) await sleep(this.delayMs, signal);
      if (signal.aborted) throw abortError(signal);
      onDelta(chunk);
    }
    if (this.mode === "invalid") return { kind: "invalid", reason: "Fake invalid turn" };
    return {
      kind: "ok",
      turn: {
        reply,
        question: scripted?.question ?? null,
        draft: draftFrom(input),
        score: structuredClone(FAKE_INTERVIEW_SCORE),
        done: scripted === undefined,
        stillMissing: [],
      },
    };
  }
}
