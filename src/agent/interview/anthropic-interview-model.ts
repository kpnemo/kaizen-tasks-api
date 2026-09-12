import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ReportTurnSchema } from "../../schemas/feature-request-conversations.js";
import { toModelError } from "../anthropic-model.js";
import type { InterviewEffort } from "../../config.js";
import type {
  InterviewDelta,
  InterviewInput,
  InterviewModel,
  InterviewOutcome,
  InterviewTurn,
} from "./model.js";
import { systemBlocks, transcriptMessages, type CachedSystemBlock } from "./prompt.js";
import type { ProductContext } from "./product-context.js";

/** What `report_turn` carries: an `InterviewTurn` minus the prose the adapter streams. */
type ReportTurnState = Omit<InterviewTurn, "reply">;

/** Thinking tokens count toward max_tokens, and Fable always thinks (spec 3.4). */
export const INTERVIEW_MAX_OUTPUT_TOKENS = 16_000;

/** Fable turns run longer than Sonnet's; the 15 s `: ping` covers the wait (spec 3.4). */
export const INTERVIEW_TIMEOUT_MS = 90_000;

/** Server-side fallback: a busy primary is served by the next model in the default chain. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const REPORT_TURN_TOOL_NAME = "report_turn";

export const REPORT_TURN_DESCRIPTION =
  "Report the structured state of this interview turn: the next question and its three or four options (null when the interview is done), all five draft fields as they now stand, the readiness score with its three reasons, whether the interview is done, and anything the stop condition still lacks. Call this exactly once per turn, after the plain-text reply.";

/** InterviewTurn minus `reply`, straight from the zod schema (spec 3.4). */
export function reportTurnJsonSchema(): Record<string, unknown> {
  // `$schema` is a document-level keyword the Messages API has no use for; the rest is the shape.
  const { $schema: _dropped, ...schema } = z.toJSONSchema(ReportTurnSchema, {
    target: "draft-2020-12",
  }) as unknown as Record<string, unknown>;
  return schema;
}

export function reportTurnTool(): Anthropic.Beta.BetaTool {
  return {
    name: REPORT_TURN_TOOL_NAME,
    description: REPORT_TURN_DESCRIPTION,
    input_schema: reportTurnJsonSchema() as Anthropic.Beta.BetaTool.InputSchema,
  };
}

export interface InterviewStreamParams {
  model: string;
  max_tokens: number;
  system: CachedSystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: Anthropic.Beta.BetaTool[];
  tool_choice: { type: "auto" };
  output_config: { effort: InterviewEffort };
  betas: string[];
  fallbacks: "default";
}

export interface InterviewMessageStream extends AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
  abort(): void;
}

/**
 * The narrowest shape `respond()` needs from a client: the one `messages.stream` call it makes, the
 * events it iterates and the final message it reads. A real `Anthropic` client satisfies it
 * structurally; a fake stands in for it in tests without a socket, exactly as
 * `AnthropicMessagesClient` does for the breakdown adapter.
 */
export interface AnthropicStreamingClient {
  beta: {
    messages: {
      stream(
        params: InterviewStreamParams,
        options?: { signal?: AbortSignal },
      ): InterviewMessageStream;
    };
  };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * `done` and `question` must agree, so a finished interview never leaves chips on screen and an
 * unfinished one always has something to answer. `options` are already bounded to one to four by
 * `ReportTurnSchema`.
 */
function disagreementIn(state: ReportTurnState): string | undefined {
  if (state.done && state.question !== null) {
    return "done was true but the turn still asked a question";
  }
  if (!state.done && state.question === null) {
    return "done was false but the turn asked no question";
  }
  if (state.question && !state.question.options.includes(state.question.recommended)) {
    return `recommended "${state.question.recommended}" is not one of the options`;
  }
  return undefined;
}

/**
 * The reply for a tool-only turn whose `report_turn` state says the interview is over with nothing
 * left to gather. Fixed wording: it is what the product manager reads, so it cannot vary per turn.
 */
export const READY_REPLY = "The request is ready to review and file.";

/** The same, for a turn that stops at the eight-question cap with points still missing. */
export const CAP_REPLY = "We have reached the question limit. Review and file what we have.";

/**
 * A model sometimes answers a turn with the `report_turn` call and no prose, which used to
 * cost the product manager a perfectly good turn. The state already carries everything the reply
 * would have said, so the reply is rebuilt from it: the question it just asked, or the sentence the
 * prompt's stop rules prescribe for the two ways an interview ends.
 */
function synthesizedReply(state: ReportTurnState): string {
  if (state.question !== null) return state.question.text.trim();
  return state.stillMissing.length === 0 ? READY_REPLY : CAP_REPLY;
}

export class AnthropicInterviewModel implements InterviewModel {
  private readonly client: AnthropicStreamingClient;
  private readonly tool: Anthropic.Beta.BetaTool;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      effort: InterviewEffort;
      /** A getter, so a refreshed product context reaches the next turn without a restart. */
      context: () => ProductContext;
      /** Test seam: an injected fake stands in for the real SDK client. Production omits it. */
      client?: AnthropicStreamingClient;
      tool?: Anthropic.Beta.BetaTool;
    },
  ) {
    // One bounded attempt per turn: the route, not the SDK, decides what a failure means.
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey, timeout: INTERVIEW_TIMEOUT_MS, maxRetries: 0 });
    this.tool = options.tool ?? reportTurnTool();
  }

  async respond(
    input: InterviewInput,
    onDelta: InterviewDelta,
    signal: AbortSignal,
  ): Promise<InterviewOutcome> {
    let reply = "";
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.options.model,
          max_tokens: INTERVIEW_MAX_OUTPUT_TOKENS,
          system: systemBlocks(this.options.context()),
          messages: transcriptMessages(input),
          tools: [this.tool],
          tool_choice: { type: "auto" },
          output_config: { effort: this.options.effort },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
        reply += event.delta.text;
        onDelta(event.delta.text);
      }
      const message = await stream.finalMessage();
      // A turn that did not end on the tool call is truncated or off-contract; either way the
      // structured state cannot be trusted, and anything returned as `ok` gets persisted.
      if (message.stop_reason !== "tool_use") {
        return {
          kind: "invalid",
          reason: `stop_reason was ${message.stop_reason ?? "null"}, not tool_use`,
        };
      }
      const calls = message.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock =>
          block.type === "tool_use" && block.name === REPORT_TURN_TOOL_NAME,
      );
      if (calls.length !== 1) {
        return {
          kind: "invalid",
          reason: `expected exactly one report_turn call, got ${calls.length}`,
        };
      }
      const parsed = ReportTurnSchema.safeParse(calls[0]!.input);
      if (!parsed.success) {
        return { kind: "invalid", reason: `report_turn input rejected: ${issuesOf(parsed.error)}` };
      }
      const state = parsed.data;
      const disagreement = disagreementIn(state);
      if (disagreement) return { kind: "invalid", reason: disagreement };
      let text = reply.trim();
      if (text.length === 0) {
        // The tool call is present, valid and consistent: the turn is good, only its prose is
        // missing. Synthesize it and stream it once, so the client shows a reply like any other.
        text = synthesizedReply(state);
        if (text.length === 0) {
          return { kind: "invalid", reason: "the assistant turn carried no reply text" };
        }
        onDelta(text);
      }
      return { kind: "ok", turn: { reply: text, ...state } };
    } catch (err) {
      // A bare AnthropicError that is not an APIError is a bad answer, not a transport failure —
      // the same classification guard the breakdown adapter makes, for the same reason: retrying
      // an answer that will never parse costs a turn and helps nobody.
      if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
        return { kind: "invalid", reason: err.message };
      }
      throw toModelError(err);
    }
  }
}
