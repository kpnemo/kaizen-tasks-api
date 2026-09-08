import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("User");

export const RegisterBody = z
  .object({
    email: z.email().max(254),
    password: z.string().min(8).max(200),
    displayName: z.string().trim().min(1).max(80),
  })
  .openapi("RegisterBody");

export const LoginBody = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(200),
  })
  .openapi("LoginBody");

export const AuthResponse = z
  .object({ user: UserSchema, accessToken: z.string() })
  .openapi("AuthResponse");

export const RefreshResponse = z.object({ accessToken: z.string() }).openapi("RefreshResponse");

export const MeResponse = z.object({ user: UserSchema }).openapi("MeResponse");

export type User = z.infer<typeof UserSchema>;
export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;

const COOKIE_NOTE = "Also sets the httpOnly `kaizen_refresh` cookie scoped to `/api/v1/auth`.";

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/register`,
  tags: ["auth"],
  summary: "Register a new user",
  description: `Open self-registration. ${COOKIE_NOTE}`,
  request: { body: { content: { "application/json": { schema: RegisterBody } } } },
  responses: {
    201: jsonResponse("Registered", envelope(AuthResponse)),
    ...errorResponses("VALIDATION_ERROR", "CONFLICT"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/login`,
  tags: ["auth"],
  summary: "Log in with email and password",
  description: `Returns a 15-minute access token. ${COOKIE_NOTE}`,
  request: { body: { content: { "application/json": { schema: LoginBody } } } },
  responses: {
    200: jsonResponse("Logged in", envelope(AuthResponse)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/refresh`,
  tags: ["auth"],
  summary: "Rotate the refresh cookie and issue a new access token",
  description: "Reads the `kaizen_refresh` cookie. The old refresh token is invalidated.",
  responses: {
    200: jsonResponse("New access token", envelope(RefreshResponse)),
    ...errorResponses("UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/auth/logout`,
  tags: ["auth"],
  summary: "Revoke the refresh token and clear the cookie",
  responses: { 204: { description: "Logged out" } },
});

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/auth/me`,
  tags: ["auth"],
  summary: "Current user",
  security: bearerAuth,
  responses: {
    200: jsonResponse("The authenticated user", envelope(MeResponse)),
    ...errorResponses("UNAUTHORIZED"),
  },
});
