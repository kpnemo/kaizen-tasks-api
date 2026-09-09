import postgres from "postgres";
import { createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadTestEnv } from "./env.js";

/** Creates kaizen_test if missing and applies migrations, once per vitest run. */
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const url = new URL(process.env.DATABASE_URL ?? "");
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against "${dbName}": the database name must end with _test`,
    );
  }
  const maintenance = new URL(url.toString());
  maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  const existing = await admin`select 1 from pg_database where datname = ${dbName}`;
  if (existing.length === 0) {
    await admin.unsafe(`create database "${dbName}"`);
  }
  await admin.end();

  const { db, sql } = createDb(url.toString(), { max: 1 });
  await runMigrations(db);
  await sql.end();
}
