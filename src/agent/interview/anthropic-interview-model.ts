import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ReportTurnSchema } from "../../schemas/feature-request-conversations.js";
import { MODEL_TIMEOUT_MS, toModelError } from "../anthropic-model.js";
import type {
  InterviewDelta,
  InterviewInput,
  InterviewModel,
  InterviewOutcome,
  InterviewTurn,
} from "./model.js";
import { systemBlocks, transcriptMessages, type CachedSystemBlock } from "./prompt.js";

/** What `report_turn` carries: an `InterviewTurn` minus the prose the adapter streams. */
type ReportTurnState = Omit<InterviewTurn, "reply">;

/** One short reply plus one tool call. The 45s client timeout still bounds the turn (spec 3.3). */
export const INTERVIEW_MAX_OUTPUT_TOKENS = 4000;

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

export function reportTurnTool(): Anthropic.Tool {
  return {
    name: REPORT_TURN_TOOL_NAME,
    description: REPORT_TURN_DESCRIPTION,
    input_schema: reportTurnJsonSchema() as Anthropic.Tool.InputSchema,
  };
}

/**
 * The narrowest shape `respond()` needs from a client: the one `messages.stream` call it makes, the
 * events it iterates and the final message it reads. A real `Anthropic` client satisfies it
 * structurally; a fake stands in for it in tests without a socket, exactly as
 * `AnthropicMessagesClient` does for the breakdown adapter.
 */
export interface InterviewMessageStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
  abort(): void;
}

export interface AnthropicStreamingClient {
  messages: {
    stream(
      params: {
        model: string;
        max_tokens: number;
        system: CachedSystemBlock[];
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        tools: Anthropic.Tool[];
        tool_choice: { type: "auto" };
      },
      options?: { signal?: AbortSignal },
    ): InterviewMessageStream;
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
  return undefined;
}

/**
 * The reply for a tool-only turn whose `report_turn` state says the interview is over with nothing
 * left to gather. Fixed wording: it is what the product manager reads, so it cannot vary per turn.
 */
export const READY_REPLY = "The request is ready to review and file.";

/** The same, for a turn that stops at the eight-question cap with points still missing. */
export const CAP_REPLY =
  "We have reached the question limit. Review and file what we have; the missing points are listed below.";

/**
 * claude-sonnet-5 frequently answers a turn with the `report_turn` call and no prose, which used to
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
  private readonly system: CachedSystemBlock[];
  private readonly tool: Anthropic.Tool;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      /** Test seam: an injected fake stands in for the real SDK client. Production omits it. */
      client?: AnthropicStreamingClient;
      system?: CachedSystemBlock[];
      tool?: Anthropic.Tool;
    },
  ) {
    // One bounded attempt per turn: the route, not the SDK, decides what a failure means.
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    this.system = options.system ?? systemBlocks();
    this.tool = options.tool ?? reportTurnTool();
  }

  async respond(
    input: InterviewInput,
    onDelta: InterviewDelta,
    signal: AbortSignal,
  ): Promise<InterviewOutcome> {
    let reply = "";
    try {
      const stream = this.client.messages.stream(
        {
          model: this.options.model,
          max_tokens: INTERVIEW_MAX_OUTPUT_TOKENS,
          system: this.system,
          messages: transcriptMessages(input),
          tools: [this.tool],
          tool_choice: { type: "auto" },
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
        (block): block is Anthropic.ToolUseBlock =>
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
