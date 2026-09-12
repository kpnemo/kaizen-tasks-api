import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, FINISHED_CONTENT } from "../lib/interview-constants.js";
import type {
  Conversation,
  ConversationMessage,
} from "../schemas/feature-request-conversations.js";
import { GREETING, renderRefinementSection } from "./feature-request-conversations.js";

const message = (role: "assistant" | "user", content: string): ConversationMessage => ({
  id: "11111111-1111-4111-8111-111111111111",
  role,
  content,
  at: "2026-09-10T09:00:00.000Z",
});

const base: Conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "ready",
  messages: [
    message("assistant", GREETING),
    message("user", "Supervisors cannot see which contact reasons drag a team's score down."),
    message("assistant", "Who is the user,\nand at what moment?"),
    message("user", "A team supervisor before a coaching session."),
  ],
  draft: { ...EMPTY_DRAFT, title: "Show the drag on a team's score" },
  score: {
    clarity: 4,
    complexity: 2,
    risk: 2,
    archChange: false,
    readiness: 16,
    reasons: { clarity: "c", complexity: "x", risk: "r" },
  },
  questionCount: 3,
  stillMissing: [],
  issueNumber: null,
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:05:00.000Z",
};

describe("GREETING", () => {
  it("is the fixed opening line from the spec", () => {
    expect(GREETING).toBe(
      "Tell me the idea in a sentence or two: who has the problem and what would be different.",
    );
  });
});

describe("renderRefinementSection", () => {
  it("renders the collapsed section with the rubric version, the score row and the transcript", () => {
    const section = renderRefinementSection(base, "1");
    expect(section).toContain("---");
    expect(section).toContain("<details>");
    expect(section).toContain(
      "<summary>How this request was refined (assistant interview)</summary>",
    );
    expect(section).toContain("Rubric version: 1");
    expect(section).toContain(
      "| | Clarity | Complexity | Risk | Architecture change | Readiness |",
    );
    expect(section).toContain("| Self-score | 4 | 2 | 2 | no | 16 |");
    expect(section).toContain("**Interview** (3 questions)");
    expect(section).toContain(`- **Assistant:** ${GREETING}`);
    expect(section).toContain("- **PM:** A team supervisor before a coaching session.");
    expect(section.trimEnd().endsWith("</details>")).toBe(true);
  });

  it("puts each message on one line", () => {
    expect(renderRefinementSection(base, "1")).toContain(
      "- **Assistant:** Who is the user, and at what moment?",
    );
  });

  it("says yes for an architecture change and uses the singular for one question", () => {
    const section = renderRefinementSection(
      { ...base, questionCount: 1, score: { ...base.score!, archChange: true } },
      "2",
    );
    expect(section).toContain("| Self-score | 4 | 2 | 2 | yes | 16 |");
    expect(section).toContain("**Interview** (1 question)");
  });

  it("replaces the table with a sentence when the conversation was never scored", () => {
    const section = renderRefinementSection({ ...base, score: null }, "1");
    expect(section).toContain("_The assistant did not score this request._");
    expect(section).not.toContain("| Self-score |");
  });

  it("says the draft was proposed by the assistant and prints the finish turn", () => {
    const finished = {
      ...base,
      messages: [
        ...base.messages,
        {
          id: "u-fin",
          role: "user" as const,
          content: FINISHED_CONTENT,
          at: base.createdAt,
          finished: true,
        },
      ],
    };
    const section = renderRefinementSection(finished, "1");
    expect(section).toContain(
      "Draft proposed by the assistant from the product context and corrected by the PM.",
    );
    expect(section).toContain("- **PM:** Finish with what we have");
  });
});
