import type { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { createOctokitPipeline, octokitOptionsFor } from "./pipeline-github.js";

/** Records what each REST method was called with; the port under test never sees the network. */
function fakeOctokit(calls: Record<string, unknown>[]): Octokit {
  const record = (result: unknown) => async (params: Record<string, unknown>) => {
    calls.push(params);
    return result;
  };
  return {
    rest: {
      actions: {
        createWorkflowDispatch: record({}),
        listWorkflowRuns: record({ data: { workflow_runs: [] } }),
      },
      pulls: { merge: record({ data: { sha: "merged" } }) },
      issues: { createComment: record({}) },
    },
  } as unknown as Octokit;
}

describe("the pipeline GitHub port", () => {
  it("sends mutations with retries: 0 and a deadline, so a 5xx can never POST twice", async () => {
    const calls: Record<string, unknown>[] = [];
    const port = createOctokitPipeline("token", fakeOctokit(calls));
    await port.dispatchWorkflow({
      repo: "kpnemo/kaizen-tasks-assembly-line",
      workflow: "ship.yml",
      ref: "develop",
      inputs: { request_id: "r", version: "1.4.0", issues: "22" },
    });
    await port.mergePull({
      repo: "kpnemo/kaizen-tasks-api",
      number: 1,
      sha: "s",
      method: "squash",
    });
    await port.commentIssue({ repo: "kpnemo/kaizen-tasks-assembly-line", number: 22, body: "b" });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const request = call.request as { retries?: number; signal?: unknown };
      expect(request.retries).toBe(0);
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("keeps the deadline on reads and leaves their retries to the client", async () => {
    const calls: Record<string, unknown>[] = [];
    const port = createOctokitPipeline("token", fakeOctokit(calls));
    await port.listRuns({
      repo: "kpnemo/kaizen-tasks-assembly-line",
      workflow: "ship.yml",
      perPage: 10,
    });
    const request = calls[0]!.request as { retries?: number; signal?: unknown };
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.retries).toBeUndefined();
  });

  it("never waits for a rate limit to reset: the call fails and the cooldown takes over", () => {
    const options = octokitOptionsFor("token");
    expect(options.auth).toBe("token");
    expect(options.throttle.onRateLimit(3600, {}, {} as Octokit, 0)).toBe(false);
    expect(options.throttle.onSecondaryRateLimit(60, {}, {} as Octokit, 0)).toBe(false);
  });
});
