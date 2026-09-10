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
    const res = await request(ctx.server)
      .post(REGISTER)
      .send({ email: "Ada@Example.com", password: "password123", displayName: "Ada" });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({
      id: expect.any(String),
      email: "ada@example.com",
      displayName: "Ada",
      theme: "system",
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
    await registerUser(ctx.server, { email: "dup@example.com" });
    const res = await request(ctx.server)
      .post(REGISTER)
      .send({ email: "DUP@example.com", password: "password123", displayName: "Again" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates the body", async () => {
    const res = await request(ctx.server)
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
    const user = await registerUser(ctx.server, {
      email: "login@example.com",
      password: "password123",
    });
    const res = await request(ctx.server)
      .post(LOGIN)
      .send({ email: "LOGIN@example.com", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.userId);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookieFrom(res)).toMatch(/^kaizen_refresh=/);
  });

  it("uses one message for wrong password and unknown email", async () => {
    await registerUser(ctx.server, { email: "wp@example.com", password: "password123" });
    const wrong = await request(ctx.server)
      .post(LOGIN)
      .send({ email: "wp@example.com", password: "nope-nope" });
    const unknown = await request(ctx.server)
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
    const user = await registerUser(ctx.server);
    const first = await request(ctx.server).post(REFRESH).set("Cookie", user.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toEqual(expect.any(String));
    const rotated = refreshCookieFrom(first);
    expect(rotated).not.toBe(user.cookie);

    const me = await request(ctx.server)
      .get(ME)
      .set(auth(first.body.data.accessToken as string));
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(user.userId);

    const replay = await request(ctx.server).post(REFRESH).set("Cookie", user.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHORIZED");

    const second = await request(ctx.server).post(REFRESH).set("Cookie", rotated);
    expect(second.status).toBe(200);
  });

  it("returns UNAUTHORIZED without a cookie", async () => {
    const res = await request(ctx.server).post(REFRESH);
    expect(res.status).toBe(401);
  });

  it("lets only one of two concurrent requests with the same cookie succeed", async () => {
    const user = await registerUser(ctx.server);
    const [a, b] = await Promise.all([
      request(ctx.server).post(REFRESH).set("Cookie", user.cookie),
      request(ctx.server).post(REFRESH).set("Cookie", user.cookie),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});

describe("logout", () => {
  it("revokes the refresh token and clears the cookie", async () => {
    const user = await registerUser(ctx.server);
    const res = await request(ctx.server).post(LOGOUT).set("Cookie", user.cookie);
    expect(res.status).toBe(204);
    const cleared = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
    expect(cleared).toMatch(/kaizen_refresh=;/);
    expect(cleared).toContain("Path=/api/v1/auth");
    const after = await request(ctx.server).post(REFRESH).set("Cookie", user.cookie);
    expect(after.status).toBe(401);
  });
});

describe("me", () => {
  it("returns the current user with a valid token and UNAUTHORIZED otherwise", async () => {
    const user = await registerUser(ctx.server, { email: "me@example.com" });
    const ok = await request(ctx.server).get(ME).set(auth(user.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe("me@example.com");
    expect((await request(ctx.server).get(ME)).status).toBe(401);
    expect((await request(ctx.server).get(ME).set(auth("garbage.token.here"))).status).toBe(401);
  });
});

describe("theme preference", () => {
  it("defaults the theme to system", async () => {
    const user = await registerUser(ctx.server);
    const res = await request(ctx.server).get(ME).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.theme).toBe("system");
  });

  it("saves the theme preference and returns it to a new session", async () => {
    const email = "theme@example.com";
    const user = await registerUser(ctx.server, { email, password: "password123" });
    const saved = await request(ctx.server).patch(ME).set(auth(user.token)).send({ theme: "dark" });
    expect(saved.status).toBe(200);
    expect(saved.body.data.user.theme).toBe("dark");

    // A second device: a fresh login gets its own token, and the preference is already there.
    const other = await request(ctx.server).post(LOGIN).send({ email, password: "password123" });
    expect(other.status).toBe(200);
    expect(other.body.data.user.theme).toBe("dark");
    const me = await request(ctx.server)
      .get(ME)
      .set(auth(other.body.data.accessToken as string));
    expect(me.body.data.user.theme).toBe("dark");
  });

  it("rejects an unknown theme", async () => {
    const user = await registerUser(ctx.server);
    const res = await request(ctx.server)
      .patch(ME)
      .set(auth(user.token))
      .send({ theme: "midnight" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("body.theme");
  });

  it("rejects an unauthenticated theme update", async () => {
    const res = await request(ctx.server).patch(ME).send({ theme: "light" });
    expect(res.status).toBe(401);
  });
});
