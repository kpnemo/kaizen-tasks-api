import { describe, expect, it } from "vitest";
import { loadSystemPrompt, promptPath } from "./prompt.js";

describe("system prompt", () => {
  it("resolves next to the agent module and has the four sections", () => {
    expect(promptPath().endsWith("/src/agent/prompts/breakdown.system.md")).toBe(true);
    const prompt = loadSystemPrompt();
    for (const heading of ["## Role", "## How to reason", "## Constraints", "## Output contract"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("Stop at seven");
    expect(loadSystemPrompt()).toBe(prompt);
  });
});
