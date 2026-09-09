import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BreakdownSchema, type BreakdownResult } from "../schemas/breakdown.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";
import type { BreakdownInput, BreakdownModel, BreakdownOutcome } from "./model.js";

export const MODEL_TIMEOUT_MS = 45_000;
// Adaptive thinking on Sonnet 5 shares this budget with the structured payload; 16000 is cheap
// insurance and the 45s client timeout still bounds the call.
export const MAX_OUTPUT_TOKENS = 16_000;

/**
 * The narrowest shape `complete()` needs from a client: just the one `messages.parse` call it
 * makes, and the three response fields it reads. `Messages["parse"]` is generic over the whole
 * `MessageCreateParamsNonStreaming` union, which a plain mock function cannot satisfy — this
 * concrete shape lets a fake stand in for the real `Anthropic` client in tests without touching
 * the network, while a real client still satisfies it structurally (its `parse` handles every
 * shape this one accepts, including this narrower one).
 */
export interface AnthropicMessagesClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      system: Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }>;
      messages: Array<{ role: "user"; content: string }>;
      output_config: { format: Anthropic.JSONOutputFormat; effort: "medium" };
    }): Promise<{
      stop_reason: string | null;
      stop_details: { explanation?: string | null } | null;
      parsed_output: BreakdownResult | null;
    }>;
  };
}

/** 429, 5xx, connection and timeout failures retry through BullMQ; other API errors do not. */
export function toModelError(err: unknown): Error {
  if (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return new ModelRetryableError(err);
  }
  if (err instanceof Anthropic.APIError) return new ModelNonRetryableError(err);
  return err instanceof Error ? err : new Error(String(err));
}

export class AnthropicBreakdownModel implements BreakdownModel {
  private readonly client: AnthropicMessagesClient;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      systemPrompt: string;
      /** Test seam: an injected fake stands in for the real SDK client. Production omits it. */
      client?: AnthropicMessagesClient;
    },
  ) {
    // BullMQ owns retries (spec 5.1): one bounded attempt per job attempt.
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: MODEL_TIMEOUT_MS,
        maxRetries: 0,
      });
  }

  async complete(input: BreakdownInput): Promise<BreakdownOutcome> {
    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: "text", text: this.options.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: JSON.stringify(input) }],
        output_config: { format: zodOutputFormat(BreakdownSchema), effort: "medium" },
      });
      if (response.stop_reason === "refusal") {
        return { kind: "refused", reason: response.stop_details?.explanation ?? "refused" };
      }
      if (!response.parsed_output) return { kind: "invalid", reason: "unparseable" };
      return { kind: "ok", result: response.parsed_output };
    } catch (err) {
      // `messages.parse` throws a bare `AnthropicError` (not an `APIError`) when its own
      // zodOutputFormat parser fails on the model's JSON — that's a bad answer, not a transport
      // failure, so it maps to "invalid" here rather than falling through to `toModelError` and
      // being retried three times by BullMQ for an answer that will never parse.
      if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
        return { kind: "invalid", reason: err.message };
      }
      throw toModelError(err);
    }
  }
}
