import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicBreakdownModel } from "../../src/agent/anthropic-model.js";
import { postValidate } from "../../src/agent/breakdown.js";
import { loadSystemPrompt } from "../../src/agent/prompt.js";
import { BreakdownSchema, MAX_STEPS, MAX_TAG_SUGGESTIONS } from "../../src/schemas/breakdown.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.ANTHROPIC_API_KEY;
const modelName = process.env.AI_MODEL ?? "claude-sonnet-5";

// Opt-in: runs only when ANTHROPIC_API_KEY is present. Excluded from `npm test` and from CI.
describe.skipIf(!apiKey)("live: Anthropic breakdown (verification V5)", () => {
  it("returns a sized list of steps with rationales and at most three tags for a realistic task", async () => {
    const model = new AnthropicBreakdownModel({
      apiKey: apiKey ?? "",
      model: modelName,
      systemPrompt: loadSystemPrompt(),
    });
    const outcome = await model.complete({
      title: "Plan the Q4 team offsite",
      description: "Two days, twelve people, within two hours of the office, budget around 6k.",
      existingSteps: [],
      tags: ["work", "personal"],
      openTasks: ["Renew lease", "Write the onboarding guide for new PMs"],
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // V5: the schema with the loose array bound (no minimum, max 200) was accepted by
    // messages.parse and satisfied.
    expect(BreakdownSchema.safeParse(outcome.result).success).toBe(true);
    const result = postValidate(outcome.result);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(result.tagSuggestions.length).toBeLessThanOrEqual(MAX_TAG_SUGGESTIONS);
    for (const step of result.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.rationale.length).toBeGreaterThan(0);
    }
    for (const tag of result.tagSuggestions) {
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  it("returns no steps for a task small enough to do as it is", async () => {
    const model = new AnthropicBreakdownModel({
      apiKey: apiKey ?? "",
      model: modelName,
      systemPrompt: loadSystemPrompt(),
    });
    const outcome = await model.complete({
      title: "Water the office plants",
      description: "The two pots by the window.",
      existingSteps: [],
      tags: [],
      openTasks: [],
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const result = postValidate(outcome.result);
    expect(result.steps.length).toBe(0);
  });

  it("respects maxSteps on the re-ask input", async () => {
    const model = new AnthropicBreakdownModel({
      apiKey: apiKey ?? "",
      model: modelName,
      systemPrompt: loadSystemPrompt(),
    });
    const outcome = await model.complete({
      title: "Plan and run a two-day offsite for forty people",
      description:
        "Venue, travel, agenda, catering, and budget all need to come together for forty attendees.",
      existingSteps: [],
      tags: [],
      openTasks: [],
      maxSteps: 5,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    const result = postValidate(outcome.result);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps.length).toBeLessThanOrEqual(5);
  });
});
