import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { loadTestEnv } from "./env.js";

loadTestEnv();

let sql: Sql;
let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL ?? "";
  if (new URL(redisUrl).pathname !== "/1") {
    throw new Error(`Tests must use Redis database index 1, got ${redisUrl}`);
  }
  sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  redis = new Redis(redisUrl);
});

beforeEach(async () => {
  await sql`truncate table users, tasks, tags, task_tags, feature_request_conversations cascade`;
  await redis.flushdb();
});

afterAll(async () => {
  await sql.end();
  await redis.quit();
});
