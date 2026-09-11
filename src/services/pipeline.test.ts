import { describe, expect, it } from "vitest";
import type { CheckRun, PullItem } from "./pipeline-github.js";
import {
  checksOf,
  isGreen,
  matchPullsToIssue,
  newestMarker,
  nextVersionOf,
  parseRunName,
  parseUnreleased,
} from "./pipeline.js";

function pull(over: Partial<PullItem> & { number: number; headRef: string }): PullItem {
  return {
    title: "t",
    url: "u",
    state: "open",
    merged: false,
    draft: false,
    headSha: `sha-${over.number}`,
    baseRef: "develop",
    body: "",
    mergeSha: null,
    mergeableState: null,
    ...over,
  };
}

const done = (name: string, conclusion: string): CheckRun => ({
  name,
  status: "completed",
  conclusion,
});

const changelog = (unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.3.0] - 2026-09-11\n\n### Added\n\n- Old.\n`;

describe("nextVersionOf", () => {
  it("bumps minor when either repo has Added or Changed bullets", () => {
    expect(
      nextVersionOf({
        apiVersion: "1.3.0",
        webVersion: "1.3.0",
        apiUnreleased: changelog("### Fixed\n\n- A fix.\n"),
        webUnreleased: changelog("### Changed\n\n- A change.\n"),
      }),
    ).toEqual({ version: "1.4.0", error: null });
    expect(
      nextVersionOf({
        apiVersion: "1.3.0",
        webVersion: "1.3.0",
        apiUnreleased: changelog("### Added\n\n- New.\n"),
        webUnreleased: changelog(""),
      }),
    ).toEqual({ version: "1.4.0", error: null });
  });

  it("bumps patch when only Fixed bullets exist", () => {
    expect(
      nextVersionOf({
        apiVersion: "1.3.0",
        webVersion: "1.3.0",
        apiUnreleased: changelog("### Fixed\n\n- A fix.\n"),
        webUnreleased: changelog(""),
      }),
    ).toEqual({ version: "1.3.1", error: null });
  });

  it("errors when both Unreleased sections are empty or the versions differ", () => {
    expect(
      nextVersionOf({
        apiVersion: "1.3.0",
        webVersion: "1.3.0",
        apiUnreleased: changelog(""),
        webUnreleased: changelog("### Added\n\n"),
      }),
    ).toEqual({ version: null, error: "nothing to release" });
    expect(
      nextVersionOf({
        apiVersion: "1.3.0",
        webVersion: "1.3.1",
        apiUnreleased: changelog("### Added\n\n- New.\n"),
        webUnreleased: changelog(""),
      }),
    ).toEqual({ version: null, error: "versions differ, fix by hand" });
  });

  it("reads only the Unreleased section", () => {
    expect(parseUnreleased(changelog(""))).toEqual({ minor: 0, patch: 0 });
    expect(parseUnreleased(changelog("### Added\n\n- A.\n- B.\n\n### Fixed\n\n- C.\n"))).toEqual({
      minor: 2,
      patch: 1,
    });
  });
});

describe("matchPullsToIssue", () => {
  it("matches feat/<n>- and fix/<n>- heads and docs/ heads that name the issue", () => {
    const pulls = [
      pull({ number: 1, headRef: "feat/22-request-list" }),
      pull({ number: 2, headRef: "fix/22-typo" }),
      pull({ number: 3, headRef: "feat/220-other" }),
      pull({ number: 4, headRef: "docs/pipeline", body: "Part of kaizen-tasks-assembly-line#22" }),
      pull({ number: 5, headRef: "docs/other", body: "Part of kaizen-tasks-assembly-line#220" }),
      pull({ number: 6, headRef: "release/1.4.0" }),
    ];
    expect(matchPullsToIssue(pulls, 22).map((p) => p.number)).toEqual([1, 2, 4]);
  });
});

describe("checksOf and isGreen", () => {
  it("is green only when every required check completed successfully", () => {
    expect(checksOf(["ci"], [done("ci", "success")])).toBe("green");
    expect(checksOf(["ci", "promote"], [done("ci", "success")])).toBe("pending");
    expect(checksOf(["ci"], [{ name: "ci", status: "in_progress", conclusion: null }])).toBe(
      "pending",
    );
    expect(checksOf(["ci"], [])).toBe("pending");
    expect(checksOf(["ci"], [done("ci", "failure")])).toBe("red");
    expect(checksOf(["ci"], [done("ci", "success"), done("lint", "cancelled")])).toBe("red");
    // Order-independent and conservative: GitHub's default filter=latest already collapses reruns,
    // so a failed run that is still listed counts, whatever else is there.
    expect(checksOf(["ci"], [done("ci", "failure"), done("ci", "success")])).toBe("red");
    expect(
      checksOf(["ci"], [done("ci", "success"), { name: "ci", status: "queued", conclusion: null }]),
    ).toBe("green");
  });

  it("names the first reason a pull request is not green", () => {
    const ok = pull({ number: 1, headRef: "feat/1-x" });
    expect(isGreen(ok, [done("ci", "success")], "develop")).toEqual({ green: true });
    expect(isGreen({ ...ok, draft: true }, [done("ci", "success")], "develop")).toEqual({
      green: false,
      reason: "is a draft",
    });
    expect(isGreen({ ...ok, baseRef: "main" }, [done("ci", "success")], "develop")).toEqual({
      green: false,
      reason: "targets main, not develop",
    });
    expect(isGreen({ ...ok, mergeableState: "dirty" }, [done("ci", "success")], "develop")).toEqual(
      { green: false, reason: "has conflicts" },
    );
    expect(isGreen(ok, [done("ci", "failure")], "develop")).toEqual({
      green: false,
      reason: "a check is red",
    });
    expect(isGreen(ok, [], "develop")).toEqual({ green: false, reason: "checks are running" });
    expect(isGreen({ ...ok, state: "closed" }, [done("ci", "success")], "develop")).toEqual({
      green: false,
      reason: "is not open",
    });
  });
});

describe("ship markers and run names", () => {
  it("reads the newest kaizen-ship marker from the comments", () => {
    const body = (json: string) => `<!-- kaizen-ship ${json} -->\nShip started.`;
    expect(
      newestMarker([
        {
          id: 1,
          createdAt: "a",
          body: body('{"version":"1.3.1","requestId":"r1","issues":[22]}'),
        },
        { id: 2, createdAt: "b", body: "just a comment" },
        {
          id: 3,
          createdAt: "c",
          body: body('{"version":"1.3.1","requestId":"r1","done":true}'),
        },
      ]),
    ).toEqual({ version: "1.3.1", requestId: "r1", issues: [], runUrl: null, done: true });
    expect(newestMarker([{ id: 1, createdAt: "a", body: "<!-- kaizen-ship {broken -->" }])).toBe(
      null,
    );
  });

  it("parses `ship <requestId> <version>`", () => {
    expect(parseRunName("ship 7f2a-1 1.4.0")).toEqual({ requestId: "7f2a-1", version: "1.4.0" });
    expect(parseRunName("ship")).toBeNull();
    expect(parseRunName("Update README.md")).toBeNull();
  });
});
