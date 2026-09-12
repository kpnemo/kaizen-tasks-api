import type { BreakdownResult } from "../schemas/breakdown.js";
import { AnthropicBreakdownModel } from "./anthropic-model.js";
import { FakeBreakdownModel } from "./fake-model.js";
import { loadSystemPrompt } from "./prompt.js";

export interface BreakdownInput {
  title: string;
  description: string;
  existingSteps: string[];
  tags: string[];
  openTasks: string[];
  /** Set on the one re-ask: the model must return at most this many steps. */
  maxSteps?: number;
}

export type BreakdownOutcome =
  | { kind: "ok"; result: BreakdownResult }
  | { kind: "refused"; reason: string }
  | { kind: "invalid"; reason: string };

/** The seam between the pipeline and any model provider. */
export interface BreakdownModel {
  complete(input: BreakdownInput): Promise<BreakdownOutcome>;
}

export interface ModelSelection {
  provider: "anthropic" | "fake";
  model: string;
  apiKey?: string;
}

/** Picks the adapter from config once at startup. */
export function createBreakdownModel(selection: ModelSelection): BreakdownModel {
  if (selection.provider === "fake") return new FakeBreakdownModel();
  if (!selection.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when AI_MODEL_PROVIDER=anthropic");
  }
  return new AnthropicBreakdownModel({
    apiKey: selection.apiKey,
    model: selection.model,
    systemPrompt: loadSystemPrompt(),
  });
}
