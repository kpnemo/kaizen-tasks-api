import { randomUUID } from "node:crypto";
import { MODEL_TIMEOUT_MS } from "../agent/anthropic-model.js";
import { ModelNonRetryableError, ModelRetryableError } from "../agent/errors.js";
import { MAX_INTERVIEW_QUESTIONS, type InterviewModel } from "../agent/interview/model.js";
import { rubricVersion } from "../agent/interview/prompt.js";
import type { Db } from "../db/client.js";
import type { FeatureRequestConversationRow } from "../db/schema.js";
import {
  AppError,
  conflict,
  notFound,
  rateLimited,
  unavailable,
  type ErrorCode,
} from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import type { SseSink } from "../lib/sse.js";
import { EMPTY_DRAFT, SKIPPED_CONTENT } from "../lib/interview-constants.js";
import {
  abandonLiveConversations,
  findLiveConversation,
  findOwnedConversation,
  isLiveStatus,
  markConversationFiled,
  replaceLiveConversation,
  updateConversationTurn,
} from "../repositories/feature-request-conversations.js";
import type {
  Conversation,
  ConversationMessage,
  ConversationTurnInput,
  RubricScore,
} from "../schemas/feature-request-conversations.js";

/** The first assistant message of every conversation. Fixed text: no model call (spec 2). */
export const GREETING =
  "Tell me the idea in a sentence or two: who has the problem and what would be different.";

const RESEND = "Send your answer again.";
const WHITESPACE = /\s+/g;

/** A stored row as the API shape: a partial draft becomes the five fields, empty where unknown. */
export function toConversation(row: FeatureRequestConversationRow): Conversation {
  return {
    id: row.id,
    status: row.status,
    messages: row.messages,
    draft: { ...EMPTY_DRAFT, ...row.draft },
    score: row.score ?? null,
    questionCount: row.questionCount,
    stillMissing: row.stillMissing,
    issueNumber: row.issueNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Appended to the GitHub issue body so triage can see how the request got ready (spec 3.5). */
export function renderRefinementSection(conversation: Conversation, version: string): string {
  const score = conversation.score;
  const scoreBlock = score
    ? [
        "| | Clarity | Complexity | Risk | Architecture change | Readiness |",
        "|---|---|---|---|---|---|",
        `| Self-score | ${score.clarity} | ${score.complexity} | ${score.risk} | ${score.archChange ? "yes" : "no"} | ${score.readiness} |`,
      ]
    : ["_The assistant did not score this request._"];
  const asked = conversation.questionCount;
  return [
    "",
    "---",
    "",
    "<details>",
    "<summary>How this request was refined (assistant interview)</summary>",
    "",
    `Rubric version: ${version}`,
    "",
    ...scoreBlock,
    "",
    `**Interview** (${asked} question${asked === 1 ? "" : "s"})`,
    "",
    ...conversation.messages.map(
      (m) =>
        `- **${m.role === "assistant" ? "Assistant" : "PM"}:** ${m.content.replace(WHITESPACE, " ").trim()}`,
    ),
    "",
    "</details>",
    "",
  ].join("\n");
}

/**
 * The rubric's own arithmetic (`src/agent/prompts/readiness.md`, "## 3. Readiness"). The three
 * sub-scores are the model's judgement and are kept as they came; the number derived from them is
 * recomputed here, because triage sorts on it and the filed issue carries it forever. The result is
 * always within the contract's 4..20, since each sub-score is 1..5.
 */
export function withRubricReadiness(score: RubricScore): RubricScore {
  return { ...score, readiness: score.clarity * 2 + (6 - score.complexity) + (6 - score.risk) };
}

function toStreamFailure(err: unknown, timedOut: boolean): { code: ErrorCode; message: string } {
  if (timedOut) {
    return { code: "UPSTREAM_ERROR", message: `The assistant took too long. ${RESEND}` };
  }
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof ModelRetryableError || err instanceof ModelNonRetryableError) {
    return { code: "UPSTREAM_ERROR", message: `The assistant is unavailable. ${RESEND}` };
  }
  return { code: "INTERNAL", message: `Something went wrong. ${RESEND}` };
}

/** What `submit` needs to attach an interview to an issue and close the conversation after. */
export interface InterviewAttachment {
  conversationId: string;
  section: string;
  markFiled(issueNumber: number): Promise<void>;
}

export interface FeatureRequestConversationsService {
  get(userId: string): Promise<Conversation>;
  create(userId: string): Promise<Conversation>;
  abandon(userId: string): Promise<void>;
  /**
   * One turn. Ownership, status and rate limit are checked first and throw, so the caller can still
   * send a JSON error envelope; `openSink` is called only once those pass, and everything after is
   * reported as stream events.
   */
  turn(
    userId: string,
    id: string,
    input: ConversationTurnInput,
    openSink: () => SseSink,
    clientSignal: AbortSignal,
  ): Promise<void>;
  attachToIssue(userId: string, conversationId: string): Promise<InterviewAttachment>;
}

export function createFeatureRequestConversationsService(deps: {
  db: Db;
  model: InterviewModel;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** Per-turn deadline. Defaults to the breakdown's 45 s; a test passes milliseconds. */
  turnTimeoutMs?: number;
  now?: () => Date;
}): FeatureRequestConversationsService {
  const now = deps.now ?? ((): Date => new Date());
  const turnTimeoutMs = deps.turnTimeoutMs ?? MODEL_TIMEOUT_MS;
  const message = (
    role: "assistant" | "user",
    content: string,
    extra: Partial<ConversationMessage> = {},
  ): ConversationMessage => ({
    id: randomUUID(),
    role,
    content,
    at: now().toISOString(),
    ...extra,
  });

  return {
    async get(userId) {
      const row = await findLiveConversation(deps.db, userId);
      if (!row) throw notFound("No open conversation");
      return toConversation(row);
    },

    async create(userId) {
      // Abandon-then-insert in one transaction: a concurrent second "start over" loses on the
      // partial unique index, rolls back whole, and is told CONFLICT with its old conversation
      // still live rather than being left with none.
      const row = await replaceLiveConversation(deps.db, {
        userId,
        messages: [message("assistant", GREETING)],
      });
      if (!row) throw conflict("Another interview was started at the same moment. Try again.");
      return toConversation(row);
    },

    async abandon(userId) {
      await abandonLiveConversations(deps.db, userId);
    },

    async turn(userId, id, input, openSink, clientSignal) {
      const row = await findOwnedConversation(deps.db, id, userId);
      if (!row) throw notFound("Conversation not found");
      if (row.status !== "open") throw conflict("This conversation is no longer taking answers");
      const limit = await deps.rateLimiter.consume(userId);
      if (!limit.allowed) {
        if (limit.reason === "ai_disabled") throw unavailable("The assistant is paused");
        throw rateLimited({ scope: limit.scope, limit: limit.limit, resetAt: limit.resetAt });
      }

      const skipped = input.skip === true;
      const userMessage = message(
        "user",
        skipped ? SKIPPED_CONTENT : input.content,
        skipped ? { skipped: true } : {},
      );
      const messages = [...row.messages, userMessage];
      const before = toConversation(row);
      // The optimistic token, read before the model call and required by the update after it.
      const expectedVersion = row.version;

      // The PM closed the tab while ownership, status and the rate limit were being checked. The
      // route has been listening since before those round trips, so this is where that shows up:
      // no headers, no model call, nothing persisted, and no writes to a destroyed response.
      if (clientSignal.aborted) return;
      // Headers out before the model call, so the browser has a 200 while it waits (spec 3.3).
      const sink = openSink();
      const timeout = AbortSignal.timeout(turnTimeoutMs);
      const signal = AbortSignal.any([clientSignal, timeout]);
      const modelInput = {
        messages,
        draft: before.draft,
        score: before.score,
        questionCount: row.questionCount,
        skippedLast: skipped,
      };
      let streamed = false;
      const onDelta = (text: string): void => {
        streamed = true;
        sink.event("delta", { text });
      };
      try {
        let outcome = await deps.model.respond(modelInput, onDelta, signal);
        // The PM went away mid-turn: the model stream is aborted and nothing is persisted.
        if (sink.closed) return;
        // One automatic retry. A bad answer is usually a one-off — the model dropped the tool call
        // or contradicted itself — and asking again costs one call, where failing costs the PM the
        // answer they just typed. Transport failures are not retried: they throw, and the catch
        // below reports them, exactly as before.
        if (outcome.kind === "invalid") {
          deps.logger.info(
            { conversationId: row.id, reason: outcome.reason },
            "interview turn invalid, retrying once",
          );
          // The first attempt may have streamed prose that this turn will not use. One newline
          // keeps the browser from gluing the retry's reply onto the abandoned one.
          if (streamed) sink.event("delta", { text: "\n" });
          outcome = await deps.model.respond(modelInput, onDelta, signal);
          if (sink.closed) return;
        }
        if (outcome.kind === "invalid") {
          deps.logger.warn(
            { conversationId: row.id, reason: outcome.reason },
            "interview turn invalid",
          );
          sink.event("error", {
            code: "UPSTREAM_ERROR",
            message: `The assistant could not finish that turn. ${RESEND}`,
          });
          return;
        }
        const { turn } = outcome;
        const questionCount = row.questionCount + (turn.question ? 1 : 0);
        // The prompt is told to finish at the cap. If it asks anyway, the turn is unusable: the PM
        // would be shown chips on a question that can never be answered. Persist nothing.
        if (questionCount > MAX_INTERVIEW_QUESTIONS) {
          deps.logger.warn(
            { conversationId: row.id, questionCount },
            "interview asked past the question cap",
          );
          sink.event("error", {
            code: "UPSTREAM_ERROR",
            message: `The assistant could not finish that turn. ${RESEND}`,
          });
          return;
        }
        const assistantMessage = message(
          "assistant",
          turn.reply,
          turn.question ? { options: turn.question.options } : {},
        );
        // Last guard before the only write: if the PM has gone or the deadline passed while the
        // reply was being assembled, this turn must leave no trace.
        if (sink.closed || signal.aborted) return;
        const updated = await updateConversationTurn(
          deps.db,
          { id: row.id, userId, expectedVersion },
          {
            messages: [...messages, assistantMessage],
            draft: turn.draft,
            score: withRubricReadiness(turn.score),
            questionCount,
            stillMissing: turn.stillMissing,
            status: turn.done ? "ready" : "open",
          },
        );
        // Zero rows: another turn or a filing changed the conversation while the model was
        // thinking. The atomic conditional update is what makes that safe — nothing was written,
        // and the newer state stands.
        if (!updated) {
          deps.logger.warn(
            { conversationId: row.id, expectedVersion },
            "interview turn lost the optimistic check",
          );
          sink.event("error", {
            code: "CONFLICT",
            message: "This interview moved on while the assistant was thinking. Reload it.",
          });
          return;
        }
        sink.event("state", { conversation: toConversation(updated) });
      } catch (err) {
        if (sink.closed) return;
        deps.logger.error({ conversationId: row.id, err }, "interview turn failed");
        sink.event("error", toStreamFailure(err, timeout.aborted));
      } finally {
        sink.event("done", {});
      }
    },

    async attachToIssue(userId, conversationId) {
      const row = await findOwnedConversation(deps.db, conversationId, userId);
      if (!row) throw notFound("Conversation not found");
      if (!isLiveStatus(row.status)) {
        throw conflict("This conversation has already been filed or abandoned");
      }
      const section = renderRefinementSection(toConversation(row), rubricVersion());
      return {
        conversationId: row.id,
        section,
        markFiled: async (issueNumber: number) => {
          // Conditional on a live status, so a turn that landed in the meantime does not block the
          // filing. Zero rows means the conversation went terminal between the render and here;
          // the issue exists either way, so this is a logged warning, never a failed request.
          const filed = await markConversationFiled(deps.db, row.id, userId, issueNumber);
          if (!filed) {
            deps.logger.warn(
              { conversationId: row.id, issueNumber },
              "conversation was no longer live when the issue was filed",
            );
          }
        },
      };
    },
  };
}
