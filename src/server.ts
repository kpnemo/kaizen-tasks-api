import { existsSync } from "node:fs";
import { FakeBreakdownModel } from "./agent/fake-model.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createBreakdownQueue } from "./jobs/queue.js";
import { createLogger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.ping();
  const queue = createBreakdownQueue(createRedis(config.REDIS_URL));

  const app = createApp({ config, db, redis, queue, model: new FakeBreakdownModel(), logger });

  const server = app.listen(config.PORT, "::", () => {
    logger.info({ port: config.PORT, env: config.APP_ENV }, "api listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.all([queue.close(), redis.quit(), sql.end()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
