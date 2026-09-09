import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { BreakdownResult } from "../schemas/breakdown.js";
import {
  AnthropicBreakdownModel,
  MAX_OUTPUT_TOKENS,
  MODEL_TIMEOUT_MS,
  toModelError,
  type AnthropicMessagesClient,
} from "./anthropic-model.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";

function sdkError<T extends object>(proto: T, props: Record<string, unknown>): T {
  return Object.assign(Object.create(proto) as T, { message: "sdk error", ...props });
}

const fixture = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/breakdown.ok.json", import.meta.url), "utf8"),
) as BreakdownResult;

const input = {
  title: "Plan the Q4 team offsite",
  description: "Two days, twelve people",
  existingSteps: [],
  tags: ["work"],
  openTasks: ["Renew lease"],
};

const systemPromptText = "system prompt text";

type FakeParse = AnthropicMessagesClient["messages"]["parse"];

/** A `vi.fn()` typed as `messages.parse`, so `mockResolvedValue`/`mockRejectedValue` typecheck. */
function fakeParse() {
  return vi.fn<FakeParse>();
}

/** Builds a model wired to a fake client whose `messages.parse` is the given mock. */
function modelWithFakeClient(parse: ReturnType<typeof fakeParse>) {
  return new AnthropicBreakdownModel({
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    systemPrompt: systemPromptText,
    client: { messages: { parse } },
  });
}

describe("toModelError", () => {
  it("marks 429, 5xx, connection and timeout errors retryable", () => {
    for (const proto of [
      Anthropic.RateLimitError.prototype,
      Anthropic.InternalServerError.prototype,
      Anthropic.APIConnectionError.prototype,
      Anthropic.APIConnectionTimeoutError.prototype,
    ]) {
      expect(toModelError(sdkError(proto, {}))).toBeInstanceOf(ModelRetryableError);
    }
  });

  it("marks other API errors non-retryable and passes unknown errors through", () => {
    expect(
      toModelError(sdkError(Anthropic.BadRequestError.prototype, { status: 400 })),
    ).toBeInstanceOf(ModelNonRetryableError);
    expect(
      toModelError(sdkError(Anthropic.AuthenticationError.prototype, { status: 401 })),
    ).toBeInstanceOf(ModelNonRetryableError);
    const plain = new Error("boom");
    expect(toModelError(plain)).toBe(plain);
  });
});

describe("AnthropicBreakdownModel", () => {
  it("constructs with the spec's timeout and no SDK retries", () => {
    const model = new AnthropicBreakdownModel({
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      systemPrompt: "x",
    });
    expect(model).toBeInstanceOf(AnthropicBreakdownModel);
    expect(MODEL_TIMEOUT_MS).toBe(45_000);
    expect(MAX_OUTPUT_TOKENS).toBe(16_000);
  });
});

describe("AnthropicBreakdownModel.complete via a fake client", () => {
  it("returns ok with the parsed output on a normal turn", async () => {
    const parse = fakeParse().mockResolvedValue({
      stop_reason: "end_turn",
      stop_details: null,
      parsed_output: fixture,
    });
    const model = modelWithFakeClient(parse);

    await expect(model.complete(input)).resolves.toEqual({ kind: "ok", result: fixture });
  });

  it("returns refused with the explanation when the model refuses", async () => {
    const parse = fakeParse().mockResolvedValue({
      stop_reason: "refusal",
      stop_details: { explanation: "cannot help with that" },
      parsed_output: null,
    });
    const model = modelWithFakeClient(parse);

    await expect(model.complete(input)).resolves.toEqual({
      kind: "refused",
      reason: "cannot help with that",
    });
  });

  it("returns invalid when the response carries no parsed output", async () => {
    // Simulates the SDK's own schema validation failing (e.g. two steps when MIN_STEPS is
    // three): by the time `complete()` sees the response, that shows up as a null parsed_output.
    const parse = fakeParse().mockResolvedValue({
      stop_reason: "end_turn",
      stop_details: null,
      parsed_output: null,
    });
    const model = modelWithFakeClient(parse);

    await expect(model.complete(input)).resolves.toEqual({
      kind: "invalid",
      reason: "unparseable",
    });
  });

  it("rejects with a retryable error carrying the cause on a 429", async () => {
    const rejection = sdkError(Anthropic.RateLimitError.prototype, { status: 429 });
    const parse = fakeParse().mockRejectedValue(rejection);
    const model = modelWithFakeClient(parse);

    const err = await model.complete(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRetryableError);
    expect((err as { cause?: unknown }).cause).toBe(rejection);
  });

  it("rejects with a non-retryable error carrying the cause on a 400", async () => {
    const rejection = sdkError(Anthropic.BadRequestError.prototype, { status: 400 });
    const parse = fakeParse().mockRejectedValue(rejection);
    const model = modelWithFakeClient(parse);

    const err = await model.complete(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelNonRetryableError);
    expect((err as { cause?: unknown }).cause).toBe(rejection);
  });

  it("returns invalid when the SDK's own structured-output parser throws a bare AnthropicError", async () => {
    // `messages.parse` throws this (not an `APIError`) when zodOutputFormat's own JSON/zod
    // parsing fails on the model's answer — a bad answer, not a transport failure, so it must
    // not fall through to `toModelError` and come out unclassified.
    const parse = fakeParse().mockRejectedValue(
      new Anthropic.AnthropicError("Failed to parse structured output: boom"),
    );
    const model = modelWithFakeClient(parse);

    await expect(model.complete(input)).resolves.toEqual({
      kind: "invalid",
      reason: expect.stringContaining("Failed to parse"),
    });
  });

  it("still lets a plain error propagate through toModelError unchanged", async () => {
    const rejection = new Error("x");
    const parse = fakeParse().mockRejectedValue(rejection);
    const model = modelWithFakeClient(parse);

    const err = await model.complete(input).catch((e: unknown) => e);
    expect(err).toBe(rejection);
  });

  it("calls the SDK with the model, token cap, prompt and structured-output effort", async () => {
    const parse = fakeParse().mockResolvedValue({
      stop_reason: "end_turn",
      stop_details: null,
      parsed_output: fixture,
    });
    const model = modelWithFakeClient(parse);

    await model.complete(input);

    expect(parse).toHaveBeenCalledTimes(1);
    const call = parse.mock.calls[0]?.[0] as {
      model: string;
      max_tokens: number;
      system: Array<{ text: string }>;
      messages: Array<{ content: string }>;
      output_config: { format: unknown; effort: string };
    };
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(call.system[0]?.text).toBe(systemPromptText);
    expect(call.messages[0]?.content).toBe(JSON.stringify(input));
    expect(call.output_config.format).toBeTruthy();
    expect(call.output_config.effort).toBe("medium");
  });
});
