import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT } from "../../lib/interview-constants.js";
import type { ConversationMessage } from "../../schemas/feature-request-conversations.js";
import {
  FAKE_INTERVIEW_SCORE,
  FakeInterviewModel,
  splitIntoThree,
} from "./fake-interview-model.js";
import type { InterviewInput } from "./model.js";

const message = (
  role: "assistant" | "user",
  content: string,
  skipped?: boolean,
): ConversationMessage => ({
  id: randomUUID(),
  role,
  content,
  at: "2026-09-10T09:00:00.000Z",
  ...(skipped === undefined ? {} : { skipped }),
});

const transcript: ConversationMessage[] = [
  message("assistant", "Tell me the idea in a sentence or two."),
  message("user", "Supervisors cannot see which contact reasons drag a team's score down."),
  message("assistant", "Who is the user, and at what moment does this happen?"),
  message("user", "A team supervisor before a coaching session."),
  message("assistant", "What does the user see on the screen when this works?"),
  message("user", "A list of agents with the contact reasons where they score below the team."),
  message("assistant", "What would a tester check to say this is done?"),
  message("user", "Opening the page for a team of 12 shows all 12 agents within 2 seconds."),
];

function inputAt(questionCount: number, upTo: number, skippedLast = false): InterviewInput {
  return {
    messages: transcript.slice(0, upTo),
    draft: EMPTY_DRAFT,
    score: null,
    questionCount,
    skippedLast,
  };
}

describe("splitIntoThree", () => {
  it("splits on word boundaries and concatenates back to the original", () => {
    const text = "one two three four five six seven";
    const chunks = splitIntoThree(text);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
});

describe("FakeInterviewModel", () => {
  it("asks the user-and-moment question with the spec's three options on turn 0", async () => {
    const model = new FakeInterviewModel();
    const outcome = await model.respond(inputAt(0, 2), vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.turn.done).toBe(false);
    // One sentence of context is not a ready request: the chip must not read 16 of 20 yet.
    expect(outcome.turn.score).toMatchObject({ clarity: 2, readiness: 12 });
    expect(outcome.turn.question?.text).toBe(
      "Who is the user, and at what moment does this happen?",
    );
    expect(outcome.turn.question?.options).toEqual([
      "A team supervisor before a coaching session",
      "An agent during a call",
      "A workforce planner on Monday",
    ]);
  });

  it("asks observable behavior on turn 1 and a done criterion on turn 2, three options each", async () => {
    const model = new FakeInterviewModel();
    for (const [questionCount, upTo, readiness] of [
      [1, 4, 14],
      [2, 6, 16],
    ] as const) {
      const outcome = await model.respond(
        inputAt(questionCount, upTo),
        vi.fn(),
        new AbortController().signal,
      );
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      expect(outcome.turn.done).toBe(false);
      expect(outcome.turn.question?.options).toHaveLength(3);
      expect(outcome.turn.score.readiness).toBe(readiness);
    }
  });

  it("raises the score turn by turn, keeps the rubric's arithmetic and rewrites its reasons", async () => {
    const model = new FakeInterviewModel();
    const scores = [];
    for (const [questionCount, upTo] of [
      [0, 2],
      [1, 4],
      [2, 6],
      [3, 8],
    ] as const) {
      const outcome = await model.respond(
        inputAt(questionCount, upTo),
        vi.fn(),
        new AbortController().signal,
      );
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      scores.push(outcome.turn.score);
    }

    expect(scores.map((s) => s.readiness)).toEqual([12, 14, 16, 16]);
    expect(scores.map((s) => s.clarity)).toEqual([2, 3, 4, 4]);
    for (const score of scores) {
      // The rubric's own formula: a fake that broke it would hide a real bug in the service.
      expect(score.readiness).toBe(score.clarity * 2 + (6 - score.complexity) + (6 - score.risk));
    }
    // The reasons follow the numbers instead of claiming three criteria from the first answer on.
    expect(new Set(scores.map((s) => s.reasons.clarity)).size).toBe(scores.length);
    expect(scores[0]?.reasons.clarity).not.toMatch(/three/i);
    expect(scores.at(-1)?.reasons.clarity).toMatch(/three/i);
  });

  it("finishes on turn 3 with the spec's score and a draft mapped by scripted turn", async () => {
    const model = new FakeInterviewModel();
    const outcome = await model.respond(inputAt(3, 8), vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.turn.done).toBe(true);
    expect(outcome.turn.question).toBeNull();
    expect(outcome.turn.stillMissing).toEqual([]);
    expect(outcome.turn.score).toEqual(FAKE_INTERVIEW_SCORE);
    expect(outcome.turn.score.readiness).toBe(16);
    expect(outcome.turn.draft).toEqual({
      title: "Supervisors cannot see which contact reasons drag a team's score down.",
      problem:
        "Supervisors cannot see which contact reasons drag a team's score down. A team supervisor before a coaching session.",
      proposedBehavior:
        "A list of agents with the contact reasons where they score below the team.",
      // Three bullets, as the closing reply says: the PM's own criterion, then two checks derived
      // from their earlier answers and labelled as derived.
      acceptanceCriteria: [
        "- Opening the page for a team of 12 shows all 12 agents within 2 seconds.",
        "- (derived from the answers) A tester can do it as: A team supervisor before a coaching session.",
        "- (derived from the answers) A tester can see: A list of agents with the contact reasons where they score below the team.",
      ].join("\n"),
      outOfScope: "",
    });
    expect(outcome.turn.draft.acceptanceCriteria.split("\n")).toHaveLength(3);
  });

  it("leaves the field a skipped answer would have filled empty, and invents nothing", async () => {
    const model = new FakeInterviewModel();
    const withSkip: ConversationMessage[] = [
      transcript[0]!,
      transcript[1]!,
      transcript[2]!,
      transcript[3]!,
      transcript[4]!,
      message("user", "(skipped)", true),
      transcript[6]!,
      transcript[7]!,
    ];
    const outcome = await model.respond(
      {
        messages: withSkip,
        draft: EMPTY_DRAFT,
        score: null,
        questionCount: 3,
        skippedLast: false,
      },
      vi.fn(),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.turn.draft.proposedBehavior).toBe("");
    // The skipped answer takes its derived bullet with it; nothing is made up to replace it.
    expect(outcome.turn.draft.acceptanceCriteria).toBe(
      [
        "- Opening the page for a team of 12 shows all 12 agents within 2 seconds.",
        "- (derived from the answers) A tester can do it as: A team supervisor before a coaching session.",
      ].join("\n"),
    );
    expect(outcome.turn.draft.outOfScope).toBe("");
    for (const value of Object.values(outcome.turn.draft)) {
      expect(value).not.toMatch(/not stated|refined feature request/i);
    }
  });

  it("returns the empty draft when the PM has said nothing yet", async () => {
    const model = new FakeInterviewModel();
    const outcome = await model.respond(inputAt(0, 1), vi.fn(), new AbortController().signal);
    expect(outcome.kind === "ok" && outcome.turn.draft).toEqual(EMPTY_DRAFT);
  });

  it("stays done for every later turn, skipped or not", async () => {
    const model = new FakeInterviewModel();
    const outcome = await model.respond(inputAt(4, 8, true), vi.fn(), new AbortController().signal);
    expect(outcome.kind === "ok" && outcome.turn.done).toBe(true);
  });

  it("streams the reply in three chunks whose concatenation is the reply", async () => {
    const model = new FakeInterviewModel();
    const chunks: string[] = [];
    const outcome = await model.respond(
      inputAt(0, 2),
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(chunks).toHaveLength(3);
    expect(outcome.kind === "ok" && chunks.join("")).toBe(
      outcome.kind === "ok" ? outcome.turn.reply : "",
    );
  });

  it("records every call and streams before returning invalid in invalid mode", async () => {
    const model = new FakeInterviewModel({ mode: "invalid" });
    const chunks: string[] = [];
    const outcome = await model.respond(
      inputAt(0, 2),
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(chunks).toHaveLength(3);
    expect(outcome).toEqual({ kind: "invalid", reason: "Fake invalid turn" });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.questionCount).toBe(0);
  });

  it("rejects when the signal aborts during the inter-chunk delay", async () => {
    const model = new FakeInterviewModel({ delayMs: 50 });
    const controller = new AbortController();
    const promise = model.respond(inputAt(0, 2), vi.fn(), controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });
});
