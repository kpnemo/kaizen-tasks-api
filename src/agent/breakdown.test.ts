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

  it("drops empty titles and keeps a result with no steps", () => {
    const result = postValidate({
      steps: [step("   "), step("One"), step("one")],
      tagSuggestions: [],
    });
    expect(result.steps.map((s) => s.title)).toEqual(["One"]);
    expect(postValidate({ steps: [], tagSuggestions: ["a"] })).toEqual({
      steps: [],
      tagSuggestions: ["a"],
    });
  });

  it("keeps twenty distinct steps and caps tag suggestions at three", () => {
    const many = Array.from({ length: 20 }, (_, i) => step(`Step ${i + 1}`));
    const result = postValidate({ steps: many, tagSuggestions: ["a", "b", "c", "d"] });
    expect(result.steps).toHaveLength(20);
    expect(result.steps[19]?.title).toBe("Step 20");
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

const manySteps = (n: number) => Array.from({ length: n }, (_, i) => step(`Step ${i + 1}`));
const ok = (n: number) => ({
  kind: "ok" as const,
  result: { steps: manySteps(n), tagSuggestions: [] },
});

describe("breakdownTask re-ask", () => {
  it("re-asks once with maxSteps fifty when the first answer has more than fifty steps", async () => {
    const model = new FakeBreakdownModel({ script: [ok(60), ok(45)] });
    const result = await breakdownTask(input, model);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]).toEqual(input);
    expect(model.calls[1]).toEqual({ ...input, maxSteps: 50 });
    expect(result.steps).toHaveLength(45);
  });

  it("does not re-ask when the first answer has fifty steps", async () => {
    const model = new FakeBreakdownModel({ script: [ok(50)] });
    expect((await breakdownTask(input, model)).steps).toHaveLength(50);
    expect(model.calls).toHaveLength(1);
  });

  it("keeps every step when the second answer is still over fifty", async () => {
    const model = new FakeBreakdownModel({ script: [ok(60), ok(60)] });
    expect((await breakdownTask(input, model)).steps).toHaveLength(60);
    expect(model.calls).toHaveLength(2);
  });

  it("keeps the first answer when the re-ask fails", async () => {
    const invalid = { kind: "invalid" as const, reason: "garbage" };
    const model = new FakeBreakdownModel({ script: [ok(60), invalid] });
    expect((await breakdownTask(input, model)).steps).toHaveLength(60);
    const outage = new FakeBreakdownModel({ script: [ok(60)], mode: "retryable-error" });
    expect((await breakdownTask(input, outage)).steps).toHaveLength(60);
  });

  it("returns no steps when the model returns none", async () => {
    const model = new FakeBreakdownModel({ script: [ok(0)] });
    expect(await breakdownTask(input, model)).toEqual({ steps: [], tagSuggestions: [] });
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
