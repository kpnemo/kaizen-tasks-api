import { createHash, randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { isSecureCookieEnv, type Config } from "../config.js";
import { unauthorized } from "./errors.js";

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_COOKIE = "kaizen_refresh";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
export const BCRYPT_COST = 10;

export interface AuthUser {
  id: string;
  email: string;
}

const secretBytes = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(user: AuthUser, secret: string): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secretBytes(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, secretBytes(secret), { algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw unauthorized("Invalid token");
  }
  return { id: payload.sub, email: payload.email };
}

/** 32 random bytes, base64url. The token itself is the Redis key suffix. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Keys on a hash of the token, not the raw token, so `KEYS refresh:*` yields nothing usable. */
export const refreshKey = (token: string): string =>
  `refresh:${createHash("sha256").update(token).digest("hex")}`;

function cookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    secure: isSecureCookieEnv(config),
  };
}

export function setRefreshCookie(res: Response, config: Config, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieOptions(config),
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

export function clearRefreshCookie(res: Response, config: Config): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(config));
}

export function cookieValue(req: Request, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, unknown> }).cookies;
  const value = cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const hashPassword = (password: string): Promise<string> => hash(password, BCRYPT_COST);
export const verifyPassword = (password: string, passwordHash: string): Promise<boolean> =>
  compare(password, passwordHash);

/** Verifies the bearer token and sets req.user. */
export function requireAuth(config: Config): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header("authorization");
    const match = header?.match(/^bearer\s+(.+)$/i);
    if (!match) {
      next(unauthorized("Missing bearer token"));
      return;
    }
    try {
      req.user = await verifyAccessToken(match[1]?.trim() ?? "", config.JWT_SECRET);
      next();
    } catch {
      next(unauthorized("Invalid or expired token"));
    }
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
