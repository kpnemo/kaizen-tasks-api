import { describe, expect, it } from "vitest";
import { ModelRetryableError } from "./errors.js";
import { FAKE_BREAKDOWN_RESULT, FakeBreakdownModel } from "./fake-model.js";

const input = {
  title: "Plan the offsite",
  description: "",
  existingSteps: [],
  tags: [],
  openTasks: [],
};

describe("FakeBreakdownModel", () => {
  it("returns the fixture by default and records calls", async () => {
    const model = new FakeBreakdownModel();
    const outcome = await model.complete(input);
    expect(outcome).toEqual({ kind: "ok", result: FAKE_BREAKDOWN_RESULT });
    expect(model.calls).toEqual([input]);
  });

  it("can refuse, return invalid output, or throw a retryable error", async () => {
    const model = new FakeBreakdownModel({ mode: "refuse" });
    expect((await model.complete(input)).kind).toBe("refused");
    model.mode = "invalid";
    expect((await model.complete(input)).kind).toBe("invalid");
    model.mode = "retryable-error";
    await expect(model.complete(input)).rejects.toBeInstanceOf(ModelRetryableError);
  });

  it("returns a copy so callers cannot mutate the fixture", async () => {
    const model = new FakeBreakdownModel();
    const outcome = await model.complete(input);
    if (outcome.kind === "ok") outcome.result.steps.pop();
    expect(FAKE_BREAKDOWN_RESULT.steps).toHaveLength(4);
  });
});
