import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string, options: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** Postgres SQLSTATE of an error, looking through Drizzle's wrapper (`cause`). */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return pgErrorCode((err as { cause?: unknown }).cause);
}

export const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === "23505";
export const isCheckViolation = (err: unknown): boolean => pgErrorCode(err) === "23514";
