import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BreakdownSchema, type BreakdownResult } from "../schemas/breakdown.js";
import { breakdownTask, postValidate, shouldSkipBreakdown } from "./breakdown.js";
import { BreakdownInvalid, BreakdownRefused, ModelRetryableError } from "./errors.js";
import { FakeBreakdownModel } from "./fake-model.js";

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

const step = (title: string, rationale = "because") => ({ title, rationale });

describe("recorded contract fixture", () => {
  it("satisfies the structured-output schema and passes through breakdownTask unchanged", async () => {
    expect(BreakdownSchema.safeParse(fixture).success).toBe(true);
    const model = new FakeBreakdownModel({ result: fixture });
    expect(await breakdownTask(input, model)).toEqual(fixture);
    expect(model.calls).toEqual([input]);
  });
});

describe("postValidate", () => {
  it("trims titles and rationales and removes case-insensitive duplicates", () => {
    const result = postValidate({
      steps: [
        step("  Call the venue ", " first "),
        step("call the VENUE"),
        step("Send invites"),
        step("Book flights"),
      ],
      tagSuggestions: [" Travel ", "travel", "work"],
    });
    expect(result.steps.map((s) => s.title)).toEqual([
      "Call the venue",
      "Send invites",
      "Book flights",
    ]);
    expect(result.steps[0]?.rationale).toBe("first");
    expect(result.tagSuggestions).toEqual(["Travel", "work"]);
  });

  it("drops empty titles and rejects fewer than three distinct steps", () => {
    expect(() =>
      postValidate({
        steps: [step("   "), step("One"), step("one"), step("Two")],
        tagSuggestions: [],
      }),
    ).toThrow(BreakdownInvalid);
  });

  it("caps steps at seven and tag suggestions at three", () => {
    const many = Array.from({ length: 9 }, (_, i) => step(`Step ${i + 1}`));
    const result = postValidate({ steps: many, tagSuggestions: ["a", "b", "c", "d"] });
    expect(result.steps).toHaveLength(7);
    expect(result.steps[6]?.title).toBe("Step 7");
    expect(result.tagSuggestions).toEqual(["a", "b", "c"]);
  });
});

describe("breakdownTask outcomes", () => {
  it("maps refused and invalid outcomes to non-retryable errors and lets retryable errors propagate", async () => {
    await expect(
      breakdownTask(input, new FakeBreakdownModel({ mode: "refuse" })),
    ).rejects.toBeInstanceOf(BreakdownRefused);
    await expect(
      breakdownTask(input, new FakeBreakdownModel({ mode: "invalid" })),
    ).rejects.toBeInstanceOf(BreakdownInvalid);
    await expect(
      breakdownTask(input, new FakeBreakdownModel({ mode: "retryable-error" })),
    ).rejects.toBeInstanceOf(ModelRetryableError);
  });
});

describe("shouldSkipBreakdown", () => {
  it("skips when the title has fewer than three words and the description is empty", () => {
    expect(shouldSkipBreakdown("Buy milk", "")).toBe(true);
    expect(shouldSkipBreakdown("  Buy   milk  ", null)).toBe(true);
    expect(shouldSkipBreakdown("Buy milk", "   ")).toBe(true);
    expect(shouldSkipBreakdown("Buy milk", "at the corner shop")).toBe(false);
    expect(shouldSkipBreakdown("Buy some milk", "")).toBe(false);
    expect(shouldSkipBreakdown("Plan the Q4 team offsite", undefined)).toBe(false);
  });
});
