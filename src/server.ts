import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBreakdownModel } from "./agent/model.js";
import { promptPath } from "./agent/prompt.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { MIGRATIONS_FOLDER, runMigrations } from "./db/migrate.js";
import { ensureDemoSeed } from "./db/seed.js";
import { createBreakdownQueue } from "./jobs/queue.js";
import { startReconciler } from "./jobs/reconcile.js";
import { startBreakdownWorker, type BreakdownWorker } from "./jobs/worker.js";
import { assertRuntimeAssets } from "./lib/assets.js";
import { createLogger } from "./lib/logger.js";
import { createRedis } from "./lib/redis.js";

export const OPENAPI_PATH = resolve(process.cwd(), "openapi.json");
const SHUTDOWN_TIMEOUT_MS = 15_000;

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  // 1. Config: print every missing or invalid variable and exit non-zero.
  const config = readConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // 2. Runtime assets, with resolved paths in the failure message.
  assertRuntimeAssets([
    { name: "system prompt", path: promptPath() },
    { name: "migrations folder", path: MIGRATIONS_FOLDER },
    { name: "openapi.json", path: OPENAPI_PATH },
  ]);

  // 3. Migrations.
  const { db, sql } = createDb(config.DATABASE_URL);
  await runMigrations(db);
  logger.info({ folder: MIGRATIONS_FOLDER }, "migrations applied");

  // 4. Redis.
  const redis = createRedis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    commandTimeout: 5_000,
  });
  redis.on("error", (err) => logger.error({ err }, "redis error"));
  await redis.connect();
  await redis.ping();
  logger.info("redis connected");

  // 5. Demo seed.
  if (config.SEED_DEMO_USER) {
    const seeded = await ensureDemoSeed(db, config.SEED_DEMO_PASSWORD);
    logger.info({ demoUserId: seeded.demoUserId, created: seeded.created }, "demo seed checked");
  }

  // 6. Worker and reconciler.
  const model = createBreakdownModel({
    provider: config.AI_MODEL_PROVIDER,
    model: config.AI_MODEL,
    apiKey: config.ANTHROPIC_API_KEY,
  });
  const queueConnection = createRedis(config.REDIS_URL);
  queueConnection.on("error", (err) => logger.error({ err }, "redis error"));
  const queue = createBreakdownQueue(queueConnection);
  let worker: BreakdownWorker | undefined;
  let workerConnection: ReturnType<typeof createRedis> | undefined;
  let reconciler: { stop(): void } | undefined;
  if (config.WORKER_ENABLED) {
    workerConnection = createRedis(config.REDIS_URL);
    workerConnection.on("error", (err) => logger.error({ err }, "redis error"));
    worker = startBreakdownWorker({ connection: workerConnection, db, model, logger });
    reconciler = startReconciler({ db, staleMinutes: config.AI_STALE_MINUTES, logger });
    logger.info(
      { provider: config.AI_MODEL_PROVIDER, model: config.AI_MODEL },
      "worker and reconciler started",
    );
  }

  // 7. App. Host :: is dual-stack; some Railway environments resolve private hostnames to IPv6 only.
  const app = createApp({ config, db, redis, queue, model, logger });
  const server = app.listen(config.PORT, "::", () => {
    logger.info(
      { port: config.PORT, env: config.APP_ENV, commit: config.RAILWAY_GIT_COMMIT_SHA },
      "api listening",
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const forceExit = setTimeout(() => {
      logger.error("shutdown timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    server.close(() => {
      void (async () => {
        reconciler?.stop();
        await worker?.close();
        await queue.close();
        await Promise.all([workerConnection?.quit(), queueConnection.quit(), redis.quit()]);
        await sql.end();
        logger.info("shutdown complete");
        process.exit(0);
      })().catch((err: unknown) => {
        logger.error({ err }, "shutdown failed");
        process.exit(1);
      });
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
