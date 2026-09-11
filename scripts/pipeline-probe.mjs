#!/usr/bin/env node
// Probes PIPELINE_GITHUB_TOKEN against every read the pipeline snapshot makes and reports, per
// call, `ok`, `denied` (401/403/404 from a token that cannot see the resource) or `error`. Reads
// only, plus the repository permission summary GitHub reports for the token, which is how a
// fine-grained token's Contents: write shows without merging anything. With --dispatch it also
// dispatches ship.yml once with dry_run=true (a real, visible, write-nothing run in the Actions
// tab) to prove Actions: write.
//
//   PIPELINE_GITHUB_TOKEN=... node scripts/pipeline-probe.mjs [--dispatch]
import { Octokit } from "octokit";

const REPOS = {
  harness: "kpnemo/kaizen-tasks-assembly-line",
  api: "kpnemo/kaizen-tasks-api",
  web: "kpnemo/kaizen-tasks-web",
};
const WORKFLOW = "ship.yml";

const token = process.env.PIPELINE_GITHUB_TOKEN;
if (!token) {
  console.error("PIPELINE_GITHUB_TOKEN is not set; nothing to probe.");
  process.exit(2);
}
const dispatch = process.argv.includes("--dispatch");
const octokit = new Octokit({ auth: token });
const split = (full) => {
  const [owner, repo] = full.split("/");
  return { owner, repo };
};
const deadline = () => ({ request: { signal: AbortSignal.timeout(10_000) } });

let denied = 0;
async function probe(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok      ${name}${detail ? `  (${detail})` : ""}`);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
    const kind = status === 401 || status === 403 || status === 404 ? "denied" : "error";
    if (kind === "denied") denied += 1;
    console.log(`${kind.padEnd(7)} ${name}  (${status ?? (err?.name || "unknown")})`);
  }
}

await probe("GET /user", async () => {
  const { data } = await octokit.rest.users.getAuthenticated(deadline());
  return `login ${data.login}`;
});

for (const [key, full] of Object.entries(REPOS)) {
  await probe(`GET /repos/${full} (permissions)`, async () => {
    const { data } = await octokit.rest.repos.get({ ...split(full), ...deadline() });
    const p = data.permissions ?? {};
    return `${key}: pull=${p.pull} push=${p.push} admin=${p.admin}`;
  });
}

await probe("list issues (harness, feature-request)", async () => {
  const { data } = await octokit.rest.issues.listForRepo({
    ...split(REPOS.harness),
    labels: "feature-request",
    state: "all",
    per_page: 5,
    ...deadline(),
  });
  return `${data.length} returned`;
});

let firstIssue = 22;
await probe("list issues (harness, bug)", async () => {
  const { data } = await octokit.rest.issues.listForRepo({
    ...split(REPOS.harness),
    labels: "bug",
    state: "all",
    per_page: 5,
    ...deadline(),
  });
  return `${data.length} returned`;
});

for (const [key, full] of Object.entries(REPOS)) {
  await probe(`list pulls (${key})`, async () => {
    const { data } = await octokit.rest.pulls.list({
      ...split(full),
      state: "all",
      per_page: 5,
      ...deadline(),
    });
    return `${data.length} returned`;
  });
}

let apiDevelop = null;
await probe("branch head (api develop)", async () => {
  const { data } = await octokit.rest.repos.getBranch({
    ...split(REPOS.api),
    branch: "develop",
    ...deadline(),
  });
  apiDevelop = data.commit.sha;
  return apiDevelop.slice(0, 7);
});

for (const path of ["package.json", "CHANGELOG.md"]) {
  await probe(`file contents (api develop ${path})`, async () => {
    const { data } = await octokit.rest.repos.getContent({
      ...split(REPOS.api),
      path,
      ref: "develop",
      ...deadline(),
    });
    return Array.isArray(data) ? "directory?" : `${data.size} bytes`;
  });
}

await probe("compare (api develop...main)", async () => {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    ...split(REPOS.api),
    basehead: "develop...main",
    per_page: 1,
    ...deadline(),
  });
  return data.status;
});

await probe("check runs (api develop head)", async () => {
  const { data } = await octokit.rest.checks.listForRef({
    ...split(REPOS.api),
    ref: apiDevelop ?? "develop",
    per_page: 20,
    ...deadline(),
  });
  return `${data.total_count} runs`;
});

let newestRun = null;
await probe(`list workflow runs (harness ${WORKFLOW})`, async () => {
  const { data } = await octokit.rest.actions.listWorkflowRuns({
    ...split(REPOS.harness),
    workflow_id: WORKFLOW,
    event: "workflow_dispatch",
    per_page: 10,
    ...deadline(),
  });
  newestRun = data.workflow_runs[0] ?? null;
  return `${data.total_count} total${newestRun ? `, newest "${newestRun.display_title}"` : ""}`;
});

if (newestRun) {
  await probe(`list jobs (run ${newestRun.id})`, async () => {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      ...split(REPOS.harness),
      run_id: newestRun.id,
      ...deadline(),
    });
    return `${data.jobs.length} jobs`;
  });
}

await probe(`list issue comments (harness #${firstIssue})`, async () => {
  const { data } = await octokit.rest.issues.listComments({
    ...split(REPOS.harness),
    issue_number: firstIssue,
    per_page: 100,
    ...deadline(),
  });
  const markers = data.filter((c) => (c.body ?? "").includes("<!-- kaizen-ship")).length;
  return `${data.length} comments, ${markers} ship markers`;
});

if (dispatch) {
  await probe(`dispatch ${WORKFLOW} (dry_run=true)`, async () => {
    const requestId = `probe-${Date.now()}`;
    await octokit.rest.actions.createWorkflowDispatch({
      ...split(REPOS.harness),
      workflow_id: WORKFLOW,
      ref: "develop",
      inputs: {
        request_id: requestId,
        version: "9.9.9",
        issues: String(firstIssue),
        dry_run: true,
      },
      ...deadline(),
    });
    return `request_id ${requestId}; expect the run to stop at Preflight, that is fine`;
  });
} else {
  console.log("skipped dispatch ship.yml (pass --dispatch to dispatch one dry run)");
}
console.log(
  "skipped merge pull request and create issue comment (writes; Contents and Issues write show as push=true above)",
);

if (denied > 0) {
  console.log(
    `\n${denied} call(s) denied. Token permissions the spec lists: Contents read/write, Pull requests read, Issues read/write, Checks read, Actions read/write, Metadata read, on all three repositories.`,
  );
  process.exit(1);
}
console.log("\nall probed calls ok");
