import { describe, expect, it } from "vitest";
import { loadSystemPrompt, promptPath } from "./prompt.js";

describe("system prompt", () => {
  it("resolves next to the agent module and has the four sections", () => {
    expect(promptPath().endsWith("/src/agent/prompts/breakdown.system.md")).toBe(true);
    const prompt = loadSystemPrompt();
    for (const heading of ["## Role", "## How to reason", "## Constraints", "## Output contract"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).not.toContain("Stop at seven");
    expect(prompt).toContain("small enough to do as it is");
    expect(prompt).toContain("never more than fifty");
    expect(prompt).toContain("maxSteps");
    expect(prompt.indexOf("Judge first")).toBeLessThan(prompt.indexOf("first physical action"));
    expect(loadSystemPrompt()).toBe(prompt);
  });
});
