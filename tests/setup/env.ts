import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Loads .env.test without overriding variables already set (CI sets its own URLs). */
export function loadTestEnv(): void {
  const file = resolve(process.cwd(), ".env.test");
  if (existsSync(file)) process.loadEnvFile(file);
}
