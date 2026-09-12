import type { BreakdownResult } from "../schemas/breakdown.js";
import { ModelRetryableError } from "./errors.js";
import type { BreakdownInput, BreakdownModel, BreakdownOutcome } from "./model.js";

export type FakeMode = "ok" | "refuse" | "invalid" | "retryable-error";

export const FAKE_BREAKDOWN_RESULT: BreakdownResult = {
  steps: [
    {
      title: "Write the outcome in one line",
      rationale: "Everything else depends on knowing what done looks like",
    },
    {
      title: "List what you already have",
      rationale: "Reusing existing material comes before creating anything new",
    },
    {
      title: "Draft the first rough version",
      rationale: "A draft exists before anyone can review it",
    },
    {
      title: "Ask one person for feedback",
      rationale: "Outside eyes catch what the draft misses, so it follows the draft",
    },
  ],
  tagSuggestions: ["planning", "writing"],
};

/** Returns fixtures; can be told to refuse, return invalid output, or fail retryably. */
export class FakeBreakdownModel implements BreakdownModel {
  mode: FakeMode;
  result: BreakdownResult;
  /** Outcomes consumed one per call, in order, before `mode` applies. */
  readonly script: BreakdownOutcome[];
  readonly calls: BreakdownInput[] = [];

  constructor(
    options: { mode?: FakeMode; result?: BreakdownResult; script?: BreakdownOutcome[] } = {},
  ) {
    this.mode = options.mode ?? "ok";
    this.result = options.result ?? FAKE_BREAKDOWN_RESULT;
    this.script = [...(options.script ?? [])];
  }

  async complete(input: BreakdownInput): Promise<BreakdownOutcome> {
    this.calls.push(input);
    const scripted = this.script.shift();
    if (scripted) return structuredClone(scripted);
    switch (this.mode) {
      case "refuse":
        return { kind: "refused", reason: "Fake refusal" };
      case "invalid":
        return { kind: "invalid", reason: "Fake unparseable output" };
      case "retryable-error":
        throw new ModelRetryableError(new Error("fake upstream outage"));
      default:
        return { kind: "ok", result: structuredClone(this.result) };
    }
  }
}
