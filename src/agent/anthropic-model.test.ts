import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  AnthropicBreakdownModel,
  MAX_OUTPUT_TOKENS,
  MODEL_TIMEOUT_MS,
  toModelError,
} from "./anthropic-model.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";

function sdkError<T extends object>(proto: T, props: Record<string, unknown>): T {
  return Object.assign(Object.create(proto) as T, { message: "sdk error", ...props });
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
    expect(MAX_OUTPUT_TOKENS).toBe(4096);
  });
});
