import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT } from "../../lib/interview-constants.js";
import type { ConversationMessage } from "../../schemas/feature-request-conversations.js";
import { ModelNonRetryableError, ModelRetryableError } from "../errors.js";
import {
  AnthropicInterviewModel,
  CAP_REPLY,
  INTERVIEW_MAX_OUTPUT_TOKENS,
  READY_REPLY,
  REPORT_TURN_TOOL_NAME,
  reportTurnJsonSchema,
  reportTurnTool,
  type AnthropicStreamingClient,
  type InterviewMessageStream,
} from "./anthropic-interview-model.js";
import type { InterviewInput } from "./model.js";

function sdkError<T extends object>(proto: T, props: Record<string, unknown>): T {
  return Object.assign(Object.create(proto) as T, { message: "sdk error", ...props });
}

const message = (role: "assistant" | "user", content: string): ConversationMessage => ({
  id: randomUUID(),
  role,
  content,
  at: "2026-09-10T09:00:00.000Z",
});

const input: InterviewInput = {
  messages: [
    message("assistant", "Tell me the idea in a sentence or two."),
    message("user", "Supervisors cannot see which contact reasons drag a team's score down."),
  ],
  draft: EMPTY_DRAFT,
  score: null,
  questionCount: 0,
  skippedLast: false,
};

const turnPayload = {
  question: {
    text: "Who is the user, and at what moment does this happen?",
    options: ["A team supervisor before a coaching session", "An agent during a call"],
  },
  draft: { ...EMPTY_DRAFT, problem: "Supervisors cannot see the drag." },
  score: {
    clarity: 2,
    complexity: 3,
    risk: 2,
    archChange: false,
    readiness: 11,
    reasons: { clarity: "c", complexity: "x", risk: "r" },
  },
  done: false,
  stillMissing: [],
};

const textDelta = (text: string): Anthropic.MessageStreamEvent => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
});

/**
 * A Message double: the adapter reads `stop_reason` and `content`, so the rest is not worth
 * constructing.
 */
function assistantMessage(content: unknown[], stopReason: string = "tool_use"): Anthropic.Message {
  return { stop_reason: stopReason, content } as unknown as Anthropic.Message;
}

function toolUse(name: string, toolInput: unknown, id = "toolu_1"): unknown {
  return { type: "tool_use", id, name, input: toolInput, caller: { type: "direct" } };
}

class FakeStream implements InterviewMessageStream {
  aborts = 0;
  signal: AbortSignal | undefined;
  constructor(
    private readonly events: Anthropic.MessageStreamEvent[],
    private readonly final: () => Promise<Anthropic.Message>,
  ) {}
  async *[Symbol.asyncIterator](): AsyncGenerator<Anthropic.MessageStreamEvent> {
    for (const event of this.events) {
      // The real SDK rejects the iteration when the request's signal fires; so does this.
      if (this.signal?.aborted === true) throw new Error("Request was aborted.");
      yield event;
    }
  }
  finalMessage(): Promise<Anthropic.Message> {
    if (this.signal?.aborted === true) return Promise.reject(new Error("Request was aborted."));
    return this.final();
  }
  abort(): void {
    this.aborts += 1;
  }
}

interface Call {
  params: Parameters<AnthropicStreamingClient["messages"]["stream"]>[0];
  options: Parameters<AnthropicStreamingClient["messages"]["stream"]>[1];
}

function clientWith(makeStream: () => InterviewMessageStream): {
  client: AnthropicStreamingClient;
  calls: Call[];
  streams: InterviewMessageStream[];
} {
  const calls: Call[] = [];
  const streams: InterviewMessageStream[] = [];
  return {
    calls,
    streams,
    client: {
      messages: {
        stream(params, options) {
          calls.push({ params, options });
          const stream = makeStream();
          // The adapter passes the caller's signal through; the fake honours it like the SDK does.
          if (stream instanceof FakeStream) stream.signal = options?.signal ?? undefined;
          streams.push(stream);
          return stream;
        },
      },
    },
  };
}

function modelWith(client: AnthropicStreamingClient) {
  return new AnthropicInterviewModel({
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    client,
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    tool: reportTurnTool(),
  });
}

describe("reportTurnJsonSchema", () => {
  it("is an object schema of InterviewTurn minus reply, with no $schema key", () => {
    const schema = reportTurnJsonSchema();
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "done",
      "draft",
      "question",
      "score",
      "stillMissing",
    ]);
    expect(properties.reply).toBeUndefined();
    expect(schema.required).toEqual(
      expect.arrayContaining(["question", "draft", "score", "done", "stillMissing"]),
    );
  });

  it("becomes a tool named report_turn with a description", () => {
    const tool = reportTurnTool();
    expect(tool.name).toBe(REPORT_TURN_TOOL_NAME);
    expect(tool.description?.length ?? 0).toBeGreaterThan(20);
    expect(tool.input_schema.type).toBe("object");
  });
});

describe("AnthropicInterviewModel.respond via an injected fake client", () => {
  it("forwards text deltas in order and returns the parsed tool call", async () => {
    const { client, calls } = clientWith(
      () =>
        new FakeStream([textDelta("Noted. "), textDelta("Who is the user?")], async () =>
          assistantMessage([
            { type: "text", text: "Noted. Who is the user?" },
            toolUse(REPORT_TURN_TOOL_NAME, turnPayload),
          ]),
        ),
    );
    const chunks: string[] = [];
    const outcome = await modelWith(client).respond(
      input,
      (text) => chunks.push(text),
      new AbortController().signal,
    );

    expect(chunks).toEqual(["Noted. ", "Who is the user?"]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.turn.reply).toBe("Noted. Who is the user?");
    expect(outcome.turn.question?.options).toHaveLength(2);
    expect(outcome.turn.done).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("sends the model, token cap, cached system blocks, transcript and auto tool choice", async () => {
    const { client, calls } = clientWith(
      () =>
        new FakeStream([], async () =>
          assistantMessage([toolUse(REPORT_TURN_TOOL_NAME, turnPayload)]),
        ),
    );
    const controller = new AbortController();
    await modelWith(client).respond(input, vi.fn(), controller.signal);

    const call = calls[0];
    expect(call?.params.model).toBe("claude-sonnet-5");
    expect(call?.params.max_tokens).toBe(INTERVIEW_MAX_OUTPUT_TOKENS);
    expect(call?.params.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(call?.params.tools[0]?.name).toBe(REPORT_TURN_TOOL_NAME);
    expect(call?.params.tool_choice).toEqual({ type: "auto" });
    expect(call?.params.messages[0]?.role).toBe("user");
    // `transcriptMessages` closes with the bookkeeping question-count turn (decision 13), so the
    // PM's answer is the message before it.
    expect(call?.params.messages.at(-2)?.content).toBe(
      "Supervisors cannot see which contact reasons drag a team's score down.",
    );
    expect(call?.params.messages.at(-1)?.content).toBe("Questions asked so far: 0 of 8.");
    expect(call?.options?.signal).toBe(controller.signal);
  });

  it("returns invalid when the assistant turn carries no report_turn call", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([textDelta("hi")], async () =>
          assistantMessage([{ type: "text", text: "hi" }], "end_turn"),
        ),
    );
    const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("invalid");
  });

  it("returns invalid when the answer was truncated (stop_reason max_tokens)", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([textDelta("Noted. Who is the user?")], async () =>
          assistantMessage(
            [
              { type: "text", text: "Noted. Who is the user?" },
              // A half-written tool input: the SDK still surfaces the block it received.
              toolUse(REPORT_TURN_TOOL_NAME, { question: { text: "Who is the user?" } }),
            ],
            "max_tokens",
          ),
        ),
    );
    const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.reason).toContain("max_tokens");
  });

  it("returns invalid when the turn carries two report_turn calls", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([textDelta("Noted. Who is the user?")], async () =>
          assistantMessage([
            { type: "text", text: "Noted. Who is the user?" },
            toolUse(REPORT_TURN_TOOL_NAME, turnPayload, "toolu_1"),
            toolUse(REPORT_TURN_TOOL_NAME, turnPayload, "toolu_2"),
          ]),
        ),
    );
    const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.reason).toContain("exactly one");
  });

  // The real provider often answers a turn with the tool call alone. The state is complete, so the
  // turn is kept and the reply is synthesized from it and streamed once, exactly like a real one.
  it("accepts a tool-only turn that asks a question and streams the question text as the reply", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([], async () =>
          assistantMessage([toolUse(REPORT_TURN_TOOL_NAME, turnPayload)]),
        ),
    );
    const chunks: string[] = [];
    const outcome = await modelWith(client).respond(
      input,
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(chunks).toEqual(["Who is the user, and at what moment does this happen?"]);
    expect(outcome.turn.reply).toBe("Who is the user, and at what moment does this happen?");
    expect(outcome.turn.question?.text).toBe(outcome.turn.reply);
  });

  it("accepts a tool-only turn that is done with nothing missing, and says the request is ready", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([], async () =>
          assistantMessage([
            toolUse(REPORT_TURN_TOOL_NAME, {
              ...turnPayload,
              question: null,
              done: true,
              stillMissing: [],
            }),
          ]),
        ),
    );
    const chunks: string[] = [];
    const outcome = await modelWith(client).respond(
      input,
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(chunks).toEqual(["The request is ready to review and file."]);
    expect(outcome.turn.reply).toBe(READY_REPLY);
    expect(READY_REPLY).toBe("The request is ready to review and file.");
  });

  it("accepts a tool-only turn that is done at the cap, and says what is still missing", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([], async () =>
          assistantMessage([
            toolUse(REPORT_TURN_TOOL_NAME, {
              ...turnPayload,
              question: null,
              done: true,
              stillMissing: ["a third checkable criterion"],
            }),
          ]),
        ),
    );
    const chunks: string[] = [];
    const outcome = await modelWith(client).respond(
      input,
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(chunks).toEqual([
      "We have reached the question limit. Review and file what we have; the missing points are listed below.",
    ]);
    expect(outcome.turn.reply).toBe(CAP_REPLY);
    expect(CAP_REPLY).toBe(
      "We have reached the question limit. Review and file what we have; the missing points are listed below.",
    );
  });

  it("still returns invalid when a tool-only turn leaves nothing to synthesize a reply from", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([], async () =>
          assistantMessage([
            toolUse(REPORT_TURN_TOOL_NAME, {
              ...turnPayload,
              question: { ...turnPayload.question, text: "   " },
            }),
          ]),
        ),
    );
    const chunks: string[] = [];
    const outcome = await modelWith(client).respond(
      input,
      (text) => chunks.push(text),
      new AbortController().signal,
    );
    expect(chunks).toEqual([]);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.reason).toContain("reply text");
  });

  it("returns invalid when done and question disagree in either direction", async () => {
    const cases = [
      { ...turnPayload, done: true },
      { ...turnPayload, question: null, done: false },
    ];
    for (const payload of cases) {
      const { client } = clientWith(
        () =>
          new FakeStream([textDelta("A sentence.")], async () =>
            assistantMessage([
              { type: "text", text: "A sentence." },
              toolUse(REPORT_TURN_TOOL_NAME, payload),
            ]),
          ),
      );
      const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
      expect(outcome.kind).toBe("invalid");
      if (outcome.kind !== "invalid") return;
      expect(outcome.reason).toContain("done");
    }
  });

  it("rejects when the caller's signal aborts, and reports nothing usable", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([textDelta("half "), textDelta("a sentence")], async () =>
          assistantMessage([toolUse(REPORT_TURN_TOOL_NAME, turnPayload)]),
        ),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(modelWith(client).respond(input, vi.fn(), controller.signal)).rejects.toThrow(
      /abort/i,
    );
  });

  it("returns invalid when the tool input fails the zod schema", async () => {
    const { client } = clientWith(
      () =>
        new FakeStream([textDelta("Noted. Who is the user?")], async () =>
          assistantMessage([
            { type: "text", text: "Noted. Who is the user?" },
            toolUse(REPORT_TURN_TOOL_NAME, {
              ...turnPayload,
              score: { ...turnPayload.score, clarity: 9 },
            }),
          ]),
        ),
    );
    const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") return;
    expect(outcome.reason).toContain("score.clarity");
  });

  it("classifies a bare AnthropicError as invalid, not as a transport failure", async () => {
    const { client } = clientWith(() => {
      throw new Anthropic.AnthropicError("stream could not start: boom");
    });
    const outcome = await modelWith(client).respond(input, vi.fn(), new AbortController().signal);
    expect(outcome).toEqual({ kind: "invalid", reason: expect.stringContaining("boom") });
  });

  it("maps a 429 to a retryable error and a 400 to a non-retryable one", async () => {
    for (const [proto, status, expected] of [
      [Anthropic.RateLimitError.prototype, 429, ModelRetryableError],
      [Anthropic.BadRequestError.prototype, 400, ModelNonRetryableError],
    ] as const) {
      const rejection = sdkError(proto, { status });
      const { client } = clientWith(() => new FakeStream([], () => Promise.reject(rejection)));
      const err = await modelWith(client)
        .respond(input, vi.fn(), new AbortController().signal)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(expected);
      expect((err as { cause?: unknown }).cause).toBe(rejection);
    }
  });
});
