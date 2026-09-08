import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, refreshCookieFrom, registerUser } from "../helpers/auth.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const REGISTER = "/api/v1/auth/register";
const LOGIN = "/api/v1/auth/login";
const REFRESH = "/api/v1/auth/refresh";
const LOGOUT = "/api/v1/auth/logout";
const ME = "/api/v1/auth/me";

describe("register", () => {
  it("creates the user, returns an access token and sets the refresh cookie", async () => {
    const res = await request(ctx.app)
      .post(REGISTER)
      .send({ email: "Ada@Example.com", password: "password123", displayName: "Ada" });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({
      id: expect.any(String),
      email: "ada@example.com",
      displayName: "Ada",
      createdAt: expect.any(String),
    });
    expect(res.body.data.accessToken.split(".")).toHaveLength(3);
    const cookie = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Secure");
  });

  it("rejects a duplicate email regardless of case with CONFLICT", async () => {
    await registerUser(ctx.app, { email: "dup@example.com" });
    const res = await request(ctx.app)
      .post(REGISTER)
      .send({ email: "DUP@example.com", password: "password123", displayName: "Again" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates the body", async () => {
    const res = await request(ctx.app)
      .post(REGISTER)
      .send({ email: "bad", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      "body.displayName",
      "body.email",
      "body.password",
    ]);
  });
});

describe("login", () => {
  it("returns a session for correct credentials", async () => {
    const user = await registerUser(ctx.app, {
      email: "login@example.com",
      password: "password123",
    });
    const res = await request(ctx.app)
      .post(LOGIN)
      .send({ email: "LOGIN@example.com", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.userId);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookieFrom(res)).toMatch(/^kaizen_refresh=/);
  });

  it("uses one message for wrong password and unknown email", async () => {
    await registerUser(ctx.app, { email: "wp@example.com", password: "password123" });
    const wrong = await request(ctx.app)
      .post(LOGIN)
      .send({ email: "wp@example.com", password: "nope-nope" });
    const unknown = await request(ctx.app)
      .post(LOGIN)
      .send({ email: "ghost@example.com", password: "password123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe("Invalid email or password");
    expect(unknown.body.error.message).toBe("Invalid email or password");
  });
});

describe("refresh", () => {
  it("rotates the cookie and invalidates the old one", async () => {
    const user = await registerUser(ctx.app);
    const first = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toEqual(expect.any(String));
    const rotated = refreshCookieFrom(first);
    expect(rotated).not.toBe(user.cookie);

    const replay = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHORIZED");

    const second = await request(ctx.app).post(REFRESH).set("Cookie", rotated);
    expect(second.status).toBe(200);
  });

  it("returns UNAUTHORIZED without a cookie", async () => {
    const res = await request(ctx.app).post(REFRESH);
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the refresh token and clears the cookie", async () => {
    const user = await registerUser(ctx.app);
    const res = await request(ctx.app).post(LOGOUT).set("Cookie", user.cookie);
    expect(res.status).toBe(204);
    const cleared = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
    expect(cleared).toMatch(/kaizen_refresh=;/);
    expect(cleared).toContain("Path=/api/v1/auth");
    const after = await request(ctx.app).post(REFRESH).set("Cookie", user.cookie);
    expect(after.status).toBe(401);
  });
});

describe("me", () => {
  it("returns the current user with a valid token and UNAUTHORIZED otherwise", async () => {
    const user = await registerUser(ctx.app, { email: "me@example.com" });
    const ok = await request(ctx.app).get(ME).set(auth(user.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe("me@example.com");
    expect((await request(ctx.app).get(ME)).status).toBe(401);
    expect((await request(ctx.app).get(ME).set(auth("garbage.token.here"))).status).toBe(401);
  });
});
