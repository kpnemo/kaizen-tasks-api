import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT } from "../../lib/interview-constants.js";
import type { ConversationMessage } from "../../schemas/feature-request-conversations.js";
import type { InterviewInput } from "./model.js";
import type { ProductContext } from "./product-context.js";
import {
  FINISH_TURN_CONTENT,
  interviewPromptPath,
  loadInterviewSystemPrompt,
  loadRubric,
  questionCountLine,
  renderProductContext,
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
  return {
    messages,
    draft: EMPTY_DRAFT,
    score: null,
    questionCount: 1,
    skippedLast,
    finishedLast: false,
  };
}

const context: ProductContext = {
  api: "## Endpoints\n\n| tasks | GET | `/tasks` | List tasks |\n",
  web: "## Screens\n\n| `/tasks` | `TaskListPage` |\n\n## App shell\n\n| `ThemeToggle` | header |\n",
  conventions: "## shadcn first\n\nUse the primitives.\n",
  fetchedAt: "2026-09-12T00:00:00.000Z",
};

describe("the interview system prompt", () => {
  const prompt = loadInterviewSystemPrompt();

  it("resolves next to the module and is not empty", () => {
    expect(interviewPromptPath()).toMatch(/src[/\\]agent[/\\]prompts[/\\]interview\.system\.md$/);
    expect(prompt.trim().length).toBeGreaterThan(0);
  });

  it("states the turn contract, the opening turn, question choice, finishing and the draft rules", () => {
    for (const phrase of [
      "report_turn",
      "exactly one question",
      "The cap is eight",
      "Questions asked so far: N of 8.",
      "you must not ask a ninth question",
      "`stillMissing` is EMPTY when the request is ready",
      "Whenever `done` is true, `question` must be null",
      "product context",
      "Never ask what it answers",
      "## The opening turn",
      "## Choosing the question",
      "`recommended`",
      "## Finishing",
      "The PM asked to finish the interview with what you have.",
      "clarity is 4 or higher",
      "release-note line",
    ]) {
      expect(prompt).toContain(phrase);
    }
    for (const gone of ["User and moment", "Complexity and risk probes", "Work down this list"]) {
      expect(prompt).not.toContain(gone);
    }
  });

  it("says the reply text comes first and that a tool-only turn is a mistake", () => {
    // The provider frequently answers with the tool call alone; the adapter now rescues that turn,
    // and this sentence is the other half of the fix.
    // Normalized, because the prompt is hand-wrapped at 100 columns and the sentence spans lines.
    expect(prompt.replace(/\s+/g, " ")).toContain(
      "Write the reply text first, as plain text, then call `report_turn` once; a turn that only calls the tool is a mistake.",
    );
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
  it("returns three cached blocks: instructions, rubric, product context", () => {
    const blocks = systemBlocks(context);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) expect(block.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0]!.text).toBe(loadInterviewSystemPrompt());
    expect(blocks[1]!.text).toBe(loadRubric());
    expect(blocks[2]!.text).toContain("# Product context (what exists today)");
    expect(blocks[2]!.text).toContain("## API: kpnemo/kaizen-tasks-api");
    expect(blocks[2]!.text).toContain("| tasks | GET |");
    expect(blocks[2]!.text).toContain("## Web app: kpnemo/kaizen-tasks-web");
    expect(blocks[2]!.text).toContain("`TaskListPage`");
    expect(blocks[2]!.text).toContain("## UI conventions");
    expect(blocks[2]!.text).toContain("Use the primitives.");
  });

  it("says when the web documents are unavailable", () => {
    const text = renderProductContext({
      ...context,
      web: null,
      conventions: null,
      fetchedAt: null,
    });
    expect(text).toContain("Web product map: unavailable (fetch failed)");
    expect(text).toContain("UI conventions: unavailable (fetch failed)");
    expect(text).toContain("| tasks | GET |");
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

  it("maps a finished turn to the finish marker the prompt names", () => {
    const messages = transcriptMessages({
      ...input([message("assistant", "Who?"), message("user", "Finish with what we have")]),
      finishedLast: true,
    });
    expect(messages.at(-2)).toEqual({ role: "user", content: FINISH_TURN_CONTENT });
  });
});
