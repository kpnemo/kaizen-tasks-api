import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";
import { FakePipelineGitHub, PIPELINE_ENV, seedEnvironments } from "../helpers/pipeline.js";

const URL = "/api/v1/pipeline";

let plain: TestContext;
let configured: TestContext;
const gh = new FakePipelineGitHub();

beforeAll(async () => {
  plain = await createTestApp();
  configured = await createTestApp(PIPELINE_ENV, {
    pipelineGithub: gh,
    fetchImpl: seedEnvironments(),
  });
});
afterAll(async () => {
  await plain.close();
  await configured.close();
});

describe("the pipeline routes are mounted only with the five settings", () => {
  it("is NOT_FOUND on the plain app", async () => {
    const user = await registerUser(plain.server);
    const res = await request(plain.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires a session on the configured app", async () => {
    const res = await request(configured.server).get(URL);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});
