import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import { sql } from "drizzle-orm";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { BreakdownModel } from "./agent/model.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { BreakdownQueue } from "./jobs/queue.js";
import { requireAuth } from "./lib/auth.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { createHttpLogger, type Logger } from "./lib/logger.js";
import { requestId } from "./lib/request-id.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter, type HealthFeatures, type HealthProbes } from "./routes/health.js";
import { adminRouter } from "./routes/admin.js";
import { featureRequestsRouter } from "./routes/feature-requests.js";
import { openapiRouter } from "./routes/openapi.js";
import { tagsRouter } from "./routes/tags.js";
import { tasksRouter } from "./routes/tasks.js";
import { createAdminService } from "./services/admin.js";
import { createAuthService } from "./services/auth.js";
import {
  createFeatureRequestsService,
  createOctokitIssues,
  type GitHubIssues,
} from "./services/feature-requests.js";
import { createTagsService } from "./services/tags.js";
import { createTasksService } from "./services/tasks.js";

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  queue: BreakdownQueue;
  model: BreakdownModel;
  logger: Logger;
  /** Test override for the health probes. Defaults to `select 1` and `PING`. */
  probes?: Partial<HealthProbes>;
  /** Test injection for the GitHub port. Production builds one from GITHUB_TOKEN. */
  github?: GitHubIssues;
}

export const JSON_BODY_LIMIT = "64kb";

/**
 * Defined exactly when GITHUB_TOKEN and GITHUB_REPO are both set. The feature-requests route is
 * mounted on this same value, so health's `features.featureRequests` and the mount never disagree.
 */
export function featureRequestsConfigOf(
  config: Config,
): { token: string; repo: string } | undefined {
  return config.GITHUB_TOKEN && config.GITHUB_REPO
    ? { token: config.GITHUB_TOKEN, repo: config.GITHUB_REPO }
    : undefined;
}

export function createApp(deps: AppDeps): Express {
  const { config, db, redis, queue, logger } = deps;
  const probes: HealthProbes = {
    db: async () => {
      await db.execute(sql`select 1`);
    },
    redis: async () => {
      await redis.ping();
    },
    ...deps.probes,
  };
  const featureRequestsConfig = featureRequestsConfigOf(config);
  const features: HealthFeatures = { featureRequests: featureRequestsConfig !== undefined };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(requestId());
  app.use(createHttpLogger(logger));

  const api = Router();
  api.use(healthRouter(config, probes, features));
  api.use(openapiRouter(resolve(process.cwd(), "openapi.json")));
  api.use("/auth", authRouter(createAuthService({ db, redis, config }), config));
  api.use("/tags", requireAuth(config), tagsRouter(createTagsService({ db })));
  const rateLimiter = createRateLimiter(redis, config);
  const tasksService = createTasksService({ db, queue, rateLimiter, logger });
  api.use("/tasks", requireAuth(config), tasksRouter(tasksService));
  if (featureRequestsConfig) {
    const issues = deps.github ?? createOctokitIssues(featureRequestsConfig.token);
    const featureRequests = createFeatureRequestsService({
      db,
      issues,
      repo: featureRequestsConfig.repo,
      logger,
    });
    api.use("/feature-requests", requireAuth(config), featureRequestsRouter(featureRequests));
  }
  if (config.ADMIN_TOKEN) {
    api.use(
      "/admin",
      adminRouter({ adminToken: config.ADMIN_TOKEN, service: createAdminService({ db, config }) }),
    );
  }
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal: config.APP_ENV === "development", logger }));
  return app;
}
