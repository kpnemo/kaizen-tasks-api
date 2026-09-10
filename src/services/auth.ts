import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import { isUniqueViolation, type Db } from "../db/client.js";
import type { UserRow } from "../db/schema.js";
import {
  hashPassword,
  newRefreshToken,
  refreshKey,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import { conflict, unauthorized } from "../lib/errors.js";
import {
  findUserByEmail,
  findUserById,
  insertUser,
  updateUserTheme,
} from "../repositories/users.js";
import type { LoginInput, RegisterInput, UpdateMeInput, User } from "../schemas/auth.js";

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<AuthSession>;
  login(input: LoginInput): Promise<AuthSession>;
  refresh(token: string | undefined): Promise<{ accessToken: string; refreshToken: string }>;
  logout(token: string | undefined): Promise<void>;
  me(userId: string): Promise<User>;
  updateMe(userId: string, input: UpdateMeInput): Promise<User>;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    theme: row.theme,
    createdAt: row.createdAt.toISOString(),
  };
}

const INVALID_CREDENTIALS = "Invalid email or password";
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function createAuthService(deps: { db: Db; redis: Redis; config: Config }): AuthService {
  const { db, redis, config } = deps;
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= hashPassword("not-a-real-password"));

  async function issueSession(row: UserRow): Promise<AuthSession> {
    const refreshToken = newRefreshToken();
    await redis.set(refreshKey(refreshToken), row.id, "EX", REFRESH_TTL_SECONDS);
    const accessToken = await signAccessToken({ id: row.id, email: row.email }, config.JWT_SECRET);
    return { user: toUser(row), accessToken, refreshToken };
  }

  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      let row: UserRow;
      try {
        row = await insertUser(db, {
          email: normalizeEmail(input.email),
          passwordHash,
          displayName: input.displayName,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("An account with this email already exists");
        throw err;
      }
      return issueSession(row);
    },

    async login(input) {
      const row = await findUserByEmail(db, normalizeEmail(input.email));
      // Always run bcrypt so a missing user costs the same time as a wrong password.
      const ok = await verifyPassword(input.password, row?.passwordHash ?? (await getDummyHash()));
      if (!row || !ok) throw unauthorized(INVALID_CREDENTIALS);
      return issueSession(row);
    },

    async refresh(token) {
      if (!token) throw unauthorized("Missing refresh token");
      // Atomic consume: concurrent requests presenting the same token must not both succeed.
      const userId = await redis.getdel(refreshKey(token));
      if (!userId) throw unauthorized("Unknown refresh token");
      const row = await findUserById(db, userId);
      if (!row) throw unauthorized("Unknown user");
      const session = await issueSession(row);
      return { accessToken: session.accessToken, refreshToken: session.refreshToken };
    },

    async logout(token) {
      if (token) await redis.del(refreshKey(token));
    },

    async me(userId) {
      const row = await findUserById(db, userId);
      if (!row) throw unauthorized("Unknown user");
      return toUser(row);
    },

    // The token is the ownership rule: only the row behind the presented access token is ever read
    // or written, so there is no id to check and no way to reach another account's preferences.
    async updateMe(userId, input) {
      const row = await updateUserTheme(db, userId, input.theme);
      if (!row) throw unauthorized("Unknown user");
      return toUser(row);
    },
  };
}
