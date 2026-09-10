import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT } from "../../lib/interview-constants.js";
import type { ConversationMessage } from "../../schemas/feature-request-conversations.js";
import type { InterviewInput } from "./model.js";
import {
  interviewPromptPath,
  loadInterviewSystemPrompt,
  loadRubric,
  questionCountLine,
  rubricPath,
  rubricVersion,
  SKIPPED_TURN_CONTENT,
  systemBlocks,
  TRANSCRIPT_OPENER,
  transcriptMessages,
} from "./prompt.js";

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

function input(messages: ConversationMessage[], skippedLast = false): InterviewInput {
  return { messages, draft: EMPTY_DRAFT, score: null, questionCount: 1, skippedLast };
}

describe("the interview system prompt", () => {
  const prompt = loadInterviewSystemPrompt();

  it("resolves next to the module and is not empty", () => {
    expect(interviewPromptPath()).toMatch(/src[/\\]agent[/\\]prompts[/\\]interview\.system\.md$/);
    expect(prompt.trim().length).toBeGreaterThan(0);
  });

  it("states the turn contract, the ladder, the cap and the draft rules", () => {
    for (const phrase of [
      "report_turn",
      "exactly one question",
      "The cap is eight",
      "Questions asked so far: N of 8.",
      "you must not ask a ninth question",
      "`stillMissing` is EMPTY when the request is ready",
      "Whenever `done` is true, `question` must be null",
      "User and moment",
      "Observable behavior",
      "Done criteria",
      "Out of scope",
      "Complexity and risk probes",
      "clarity is 4 or higher",
      "stillMissing",
      "release-note line",
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
  });

  it("lets the cap finish ready: done, no question, and stillMissing empty when nothing is short", () => {
    // The eighth answer can be the one that finishes the request, so the cap rule must not demand
    // a non-empty `stillMissing` there. The service takes both shapes.
    expect(prompt).toContain("must set `done` to true and set `question` to null");
    expect(prompt).toContain("`stillMissing` is EMPTY when the request is ready");
    expect(prompt).not.toContain("`stillMissing` must not be empty");
  });

  it("never puts JSON in the text and never carries its own copy of the rubric", () => {
    expect(prompt).toContain("Never put JSON");
    expect(prompt).not.toContain("readiness = clarity * 2");
  });
});

describe("the vendored rubric", () => {
  const rubric = loadRubric();

  it("resolves next to the module and carries the rubric's own sections", () => {
    expect(rubricPath()).toMatch(/src[/\\]agent[/\\]prompts[/\\]readiness\.md$/);
    for (const phrase of [
      "# Readiness rubric",
      "### Clarity",
      "### Complexity",
      "### Risk",
      "## 2. Architecture change test",
      "readiness = clarity * 2 + (6 - complexity) + (6 - risk)",
      "## 4. Procedure",
    ]) {
      expect(rubric, phrase).toContain(phrase);
    }
  });

  it("reports the version from its front matter", () => {
    const version = rubricVersion();
    expect(version).toMatch(/^\S+$/);
    expect(rubric).toContain(`version: ${version}`);
  });
});

describe("systemBlocks", () => {
  it("is the prompt then the rubric, both cached", () => {
    const blocks = systemBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "text",
      text: loadInterviewSystemPrompt(),
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({
      type: "text",
      text: loadRubric(),
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("transcriptMessages", () => {
  it("opens with a fixed user message so the greeting can stay the first assistant turn", () => {
    const messages = transcriptMessages(
      input([message("assistant", "Tell me the idea."), message("user", "An idea.")]),
    );
    expect(messages[0]).toEqual({ role: "user", content: TRANSCRIPT_OPENER });
    expect(messages[1]).toEqual({ role: "assistant", content: "Tell me the idea." });
    expect(messages[2]).toEqual({ role: "user", content: "An idea." });
  });

  it("ends with the question count, so the cap is told and not inferred", () => {
    const messages = transcriptMessages(
      input([message("assistant", "Tell me the idea."), message("user", "An idea.")]),
    );
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: questionCountLine(1),
    });
    expect(questionCountLine(8)).toBe("Questions asked so far: 8 of 8.");
    expect(messages.at(-1)?.role).toBe("user");
  });

  it("replaces a skipped last answer with the skip marker", () => {
    const messages = transcriptMessages(
      input(
        [
          message("assistant", "Tell me the idea."),
          message("user", "An idea."),
          message("assistant", "Who is the user?"),
          message("user", "(skipped)"),
        ],
        true,
      ),
    );
    expect(messages.at(-2)).toEqual({ role: "user", content: SKIPPED_TURN_CONTENT });
  });

  it("also marks earlier skipped answers", () => {
    const messages = transcriptMessages(
      input([
        message("assistant", "Tell me the idea."),
        message("user", "(skipped)", true),
        message("assistant", "Who is the user?"),
        message("user", "A supervisor."),
      ]),
    );
    expect(messages[2]).toEqual({ role: "user", content: SKIPPED_TURN_CONTENT });
    expect(messages.at(-2)).toEqual({ role: "user", content: "A supervisor." });
  });
});
