import { z } from "zod";
import { ERROR_CODES } from "../lib/errors.js";
import { EMPTY_DRAFT, FINISHED_CONTENT, SKIPPED_CONTENT } from "../lib/interview-constants.js";
import { envelope, errorResponses, IdParams, jsonResponse } from "./common.js";
import { bearerAuth, registry } from "./registry.js";

// Re-exported so contract consumers and tests reach them through the schema module, while the one
// definition stays in lib and no service ever imports a runtime value from schemas.
export { EMPTY_DRAFT, FINISHED_CONTENT, SKIPPED_CONTENT };

export const MAX_TURN_CONTENT = 2000;

export const ConversationStatusSchema = z
  .enum(["open", "ready", "filed", "abandoned"])
  .openapi("ConversationStatus");

export const ConversationMessageSchema = z
  .object({
    id: z.uuid(),
    role: z.enum(["assistant", "user"]),
    content: z.string(),
    at: z.iso.datetime(),
    /** Present on an assistant message that asked a question: the chips the web renders. */
    options: z.array(z.string()).optional(),
    /** Present on an assistant message that asked a question: the option the assistant recommends. */
    recommended: z.string().optional(),
    /** Present on the user message that ended the interview early (spec 3.5). */
    finished: z.boolean().optional(),
    /** Present on a user message the PM skipped. */
    skipped: z.boolean().optional(),
  })
  .openapi("ConversationMessage");

export const FeatureRequestDraftSchema = z
  .object({
    title: z.string(),
    problem: z.string(),
    proposedBehavior: z.string(),
    acceptanceCriteria: z.string(),
    outOfScope: z.string(),
  })
  .openapi("FeatureRequestDraft");

export type FeatureRequestDraft = z.infer<typeof FeatureRequestDraftSchema>;

/**
 * The readiness rubric's output shape minus its `questions` array, which is not stored (spec 3.1).
 * `reasons` is required here: spec 3.1 defines it, and the interview shows it in the issue body.
 */
export const RubricScoreSchema = z
  .object({
    clarity: z.number().int().min(1).max(5),
    complexity: z.number().int().min(1).max(5),
    risk: z.number().int().min(1).max(5),
    archChange: z.boolean(),
    readiness: z.number().int().min(4).max(20),
    reasons: z.object({ clarity: z.string(), complexity: z.string(), risk: z.string() }),
  })
  .openapi("RubricScore");

export const ConversationSchema = z
  .object({
    id: z.uuid(),
    status: ConversationStatusSchema,
    messages: z.array(ConversationMessageSchema),
    draft: FeatureRequestDraftSchema,
    score: RubricScoreSchema.nullable(),
    questionCount: z.number().int(),
    stillMissing: z.array(z.string()),
    issueNumber: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Conversation");

export const ConversationTurnBody = z
  .object({
    content: z.string().trim().min(1).max(MAX_TURN_CONTENT),
    skip: z.boolean().optional(),
    /** Ends the interview with the draft as it stands; content is ignored (spec 3.5). */
    finish: z.boolean().optional(),
  })
  .refine((body) => !(body.skip === true && body.finish === true), {
    message: "skip and finish cannot both be true",
    path: ["finish"],
  })
  .openapi("ConversationTurnBody");

export const ConversationDeltaSchema = z.object({ text: z.string() }).openapi("ConversationDelta");
export const ConversationStateSchema = z
  .object({ conversation: ConversationSchema })
  .openapi("ConversationState");
export const ConversationErrorSchema = z
  .object({ code: z.enum(ERROR_CODES), message: z.string() })
  .openapi("ConversationError");
export const ConversationDoneSchema = z.object({}).openapi("ConversationDone");

/**
 * The SSE protocol as one discriminated union so the contract carries both the event name and its
 * payload. The client parses the stream itself; this is documentation with a machine-readable shape.
 */
export const ConversationEventSchema = z
  .discriminatedUnion("event", [
    z
      .object({ event: z.literal("delta"), data: ConversationDeltaSchema })
      .openapi("ConversationDeltaEvent"),
    z
      .object({ event: z.literal("state"), data: ConversationStateSchema })
      .openapi("ConversationStateEvent"),
    z
      .object({ event: z.literal("error"), data: ConversationErrorSchema })
      .openapi("ConversationErrorEvent"),
    z
      .object({ event: z.literal("done"), data: ConversationDoneSchema })
      .openapi("ConversationDoneEvent"),
  ])
  .openapi("ConversationEvent");

export const InterviewQuestionSchema = z.object({
  text: z.string(),
  /** Three or four in practice; at least one so a question can never arrive with no chips, at
   * most four so a long list cannot overflow the chips row. */
  options: z.array(z.string()).min(1).max(4),
  /** The answer the assistant would give; must be one of `options` word for word (checked by the adapter). */
  recommended: z.string(),
});

/**
 * `InterviewTurn` minus `reply`: the argument shape of the `report_turn` tool. Not registered in
 * OpenAPI — it is the model's contract, not the HTTP contract.
 */
export const ReportTurnSchema = z.object({
  question: InterviewQuestionSchema.nullable(),
  draft: FeatureRequestDraftSchema,
  score: RubricScoreSchema,
  done: z.boolean(),
  stillMissing: z.array(z.string()),
});

export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type RubricScore = z.infer<typeof RubricScoreSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationTurnInput = z.infer<typeof ConversationTurnBody>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;
export type ReportTurnPayload = z.infer<typeof ReportTurnSchema>;

registry.registerPath({
  method: "get",
  path: `/feature-requests/conversation`,
  tags: ["feature-requests"],
  summary: "Get the caller's open interview conversation",
  description:
    "Returns the caller's conversation whose status is `open` or `ready`. `NOT_FOUND` when there is none, which is how the web knows to start one.",
  security: bearerAuth,
  responses: {
    200: jsonResponse("The caller's conversation", envelope(ConversationSchema)),
    ...errorResponses("UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "post",
  path: `/feature-requests/conversation`,
  tags: ["feature-requests"],
  summary: "Start a new interview conversation",
  description:
    "Abandons any `open` or `ready` conversation the caller has, then creates one whose first assistant message is the fixed greeting. No body, no model call.",
  security: bearerAuth,
  responses: {
    201: jsonResponse("The new conversation", envelope(ConversationSchema)),
    ...errorResponses("UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `/feature-requests/conversation/{id}/messages`,
  tags: ["feature-requests"],
  summary: "Send one answer and stream the assistant's reply",
  description:
    "`skip: true` records `(skipped)` as the user message and tells the model the PM skipped; the submitted `content` is ignored, and the turn still counts. Ownership, status and rate-limit failures happen before the stream starts and are ordinary JSON error envelopes. Once the stream has started a failed turn is an `error` event and nothing is persisted, so a resend is a clean retry.",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: ConversationTurnBody } } },
  },
  responses: {
    200: {
      description:
        "The turn as Server-Sent Events: `delta` chunks in order, then one `state` or one `error`, then `done`. A `: ping` comment line is written every 15 seconds while waiting on the model.",
      content: { "text/event-stream": { schema: ConversationEventSchema } },
    },
    ...errorResponses(
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
      "UNAVAILABLE",
    ),
  },
});
