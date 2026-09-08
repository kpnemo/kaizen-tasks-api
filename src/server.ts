import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import postgres from "postgres";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

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
  const sql = postgres(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect();
  await redis.ping();

  const app = createApp({
    config,
    logger,
    probes: {
      db: async () => {
        await sql`select 1`;
      },
      redis: async () => {
        await redis.ping();
      },
    },
  });

  const server = app.listen(config.PORT, "::", () => {
    logger.info({ port: config.PORT, env: config.APP_ENV }, "api listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.all([redis.quit(), sql.end()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
