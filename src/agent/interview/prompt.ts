import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSCRIPT_OPENER } from "../../lib/interview-constants.js";
import { MAX_INTERVIEW_QUESTIONS, type InterviewInput } from "./model.js";
import type { ProductContext } from "./product-context.js";

export { TRANSCRIPT_OPENER };

/**
 * Resolved relative to this module, so the same code finds src/agent/prompts/ under tsx and
 * dist/agent/prompts/ after `scripts/copy-assets.sh`, exactly like the breakdown prompt.
 */
export const INTERVIEW_PROMPT_URL = new URL("../prompts/interview.system.md", import.meta.url);
export const RUBRIC_URL = new URL("../prompts/readiness.md", import.meta.url);

/** What the model sees instead of "(skipped)" so it moves on instead of re-asking. */
export const SKIPPED_TURN_CONTENT = "The PM skipped this question.";

/** What the model sees for the finish turn (spec 3.3, "Finishing"). */
export const FINISH_TURN_CONTENT = "The PM asked to finish the interview with what you have.";

export const WEB_MAP_UNAVAILABLE = "Web product map: unavailable (fetch failed)";
export const CONVENTIONS_UNAVAILABLE = "UI conventions: unavailable (fetch failed)";

/** The cap is a fact the model is told, not one it has to count off the transcript. */
export function questionCountLine(questionCount: number): string {
  return `Questions asked so far: ${questionCount} of ${MAX_INTERVIEW_QUESTIONS}.`;
}

export interface CachedSystemBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export function interviewPromptPath(): string {
  return fileURLToPath(INTERVIEW_PROMPT_URL);
}

export function rubricPath(): string {
  return fileURLToPath(RUBRIC_URL);
}

function readOnce(url: URL, what: string, cache: { value?: string }): string {
  if (cache.value === undefined) {
    const text = readFileSync(url, "utf8");
    if (text.trim().length === 0) throw new Error(`${what} is empty: ${fileURLToPath(url)}`);
    cache.value = text;
  }
  return cache.value;
}

const promptCache: { value?: string } = {};
const rubricCache: { value?: string } = {};

export function loadInterviewSystemPrompt(): string {
  return readOnce(INTERVIEW_PROMPT_URL, "Interview system prompt", promptCache);
}

/** The vendored copy of the assembly line's rubric. Kept in sync by scripts/sync-rubric.sh. */
export function loadRubric(): string {
  return readOnce(RUBRIC_URL, "Readiness rubric", rubricCache);
}

const VERSION_LINE = /^version:[ \t]*["']?(.+?)["']?[ \t]*$/m;

/** The `version:` front-matter value, printed in the issue's refinement section. */
export function rubricVersion(): string {
  const match = VERSION_LINE.exec(loadRubric());
  const version = match?.[1];
  if (!version) throw new Error(`No version: line in ${rubricPath()}`);
  return version;
}

/** The third system block (spec 3.3): the product as the maps describe it today. */
export function renderProductContext(context: ProductContext): string {
  return [
    "# Product context (what exists today)",
    "",
    "## API: kpnemo/kaizen-tasks-api",
    "",
    context.api.trim(),
    "",
    "## Web app: kpnemo/kaizen-tasks-web",
    "",
    context.web?.trim() ?? WEB_MAP_UNAVAILABLE,
    "",
    "## UI conventions",
    "",
    context.conventions?.trim() ?? CONVENTIONS_UNAVAILABLE,
    "",
  ].join("\n");
}

/**
 * Three cached system blocks: the instructions, the rubric they refer to, and the product context.
 * The first two are frozen for the life of a deploy; the third changes only when a map changes.
 */
export function systemBlocks(context: ProductContext): CachedSystemBlock[] {
  return [
    { type: "text", text: loadInterviewSystemPrompt(), cache_control: { type: "ephemeral" } },
    { type: "text", text: loadRubric(), cache_control: { type: "ephemeral" } },
    { type: "text", text: renderProductContext(context), cache_control: { type: "ephemeral" } },
  ];
}

/**
 * The stored transcript as alternating turns: the fixed opener, then the conversation, then one
 * bookkeeping user turn carrying the question count. Consecutive user turns are legal (the API
 * merges them), the bookkeeping line is the only volatile part and it sits last, after the cached
 * prefix, and the model never has to infer how close it is to the cap.
 */
export function transcriptMessages(input: InterviewInput): TranscriptMessage[] {
  const lastIndex = input.messages.length - 1;
  const mapped = input.messages.map((message, index): TranscriptMessage => {
    const isLastUser = index === lastIndex && message.role === "user";
    const skipped = message.skipped === true || (input.skippedLast && isLastUser);
    const finished = message.finished === true || (input.finishedLast && isLastUser);
    const content = finished
      ? FINISH_TURN_CONTENT
      : skipped
        ? SKIPPED_TURN_CONTENT
        : message.content;
    return { role: message.role, content };
  });
  return [
    { role: "user", content: TRANSCRIPT_OPENER },
    ...mapped,
    { role: "user", content: questionCountLine(input.questionCount) },
  ];
}
