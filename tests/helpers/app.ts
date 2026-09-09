import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { FakeBreakdownModel } from "../../src/agent/fake-model.js";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type Db } from "../../src/db/client.js";
import { processBreakdownJob } from "../../src/jobs/processors/breakdown.js";
import { createLogger } from "../../src/lib/logger.js";
import { createRedis } from "../../src/lib/redis.js";
import { FakeQueue } from "./fake-queue.js";

export interface TestContext {
  app: Express;
  config: Config;
  db: Db;
  sql: Sql;
  redis: Redis;
  queue: FakeQueue;
  model: FakeBreakdownModel;
  runQueue(): Promise<number>;
  close(): Promise<void>;
}

type ExtraDeps = Partial<Omit<AppDeps, "config" | "db" | "redis" | "queue" | "model" | "logger">>;

/** A full app over the real test database and Redis, with a fake queue and a fake model. */
export async function createTestApp(
  overrides: Partial<Config> = {},
  extra: ExtraDeps = {},
): Promise<TestContext> {
  const config: Config = { ...loadConfig(process.env), ...overrides };
  const { db, sql } = createDb(config.DATABASE_URL, { max: 2 });
  const redis = createRedis(config.REDIS_URL);
  const queue = new FakeQueue();
  const model = new FakeBreakdownModel();
  const logger = createLogger("silent");
  const app = createApp({
    config,
    db,
    redis,
    queue,
    model,
    logger,
    ...extra,
  });
  return {
    app,
    config,
    db,
    sql,
    redis,
    queue,
    model,
    runQueue: () => queue.drain((data) => processBreakdownJob(data, { db, model, logger })),
    close: async () => {
      await redis.quit();
      await sql.end();
    },
  };
}
