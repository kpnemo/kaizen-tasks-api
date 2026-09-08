import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request, { type Response } from "supertest";

export interface TestUser {
  token: string;
  userId: string;
  email: string;
  cookie: string;
}

export function refreshCookieFrom(res: Response): string {
  const found = (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("kaizen_refresh="));
  if (!found) throw new Error("no kaizen_refresh cookie in response");
  return found.split(";")[0] ?? "";
}

export async function registerUser(
  app: Express,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<TestUser> {
  const email = overrides.email ?? `user-${randomUUID()}@test.local`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({
      email,
      password: overrides.password ?? "password123",
      displayName: overrides.displayName ?? "Test User",
    });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.data.accessToken as string,
    userId: res.body.data.user.id as string,
    email: (res.body.data.user.email as string) ?? email,
    cookie: refreshCookieFrom(res),
  };
}

export const auth = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});
