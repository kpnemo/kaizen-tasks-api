import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BreakdownSchema } from "../schemas/breakdown.js";
import { ModelNonRetryableError, ModelRetryableError } from "./errors.js";
import type { BreakdownInput, BreakdownModel, BreakdownOutcome } from "./model.js";

export const MODEL_TIMEOUT_MS = 45_000;
export const MAX_OUTPUT_TOKENS = 4096;

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
  private readonly client: Anthropic;

  constructor(private readonly options: { apiKey: string; model: string; systemPrompt: string }) {
    // BullMQ owns retries (spec 5.1): one bounded attempt per job attempt.
    this.client = new Anthropic({
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
      throw toModelError(err);
    }
  }
}
