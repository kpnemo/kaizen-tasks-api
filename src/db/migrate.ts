import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "./client.js";

/** Migrations are resolved from the repository root, which is the working directory on Railway. */
export const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 1 });
  await runMigrations(db);
  await sql.end();
  console.log(`migrations applied from ${MIGRATIONS_FOLDER}`);
}
