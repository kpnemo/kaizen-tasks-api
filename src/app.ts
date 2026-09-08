import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import express, { Router, type Express } from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { createHttpLogger, type Logger } from "./lib/logger.js";
import { requestId } from "./lib/request-id.js";
import { healthRouter, type HealthFeatures, type HealthProbes } from "./routes/health.js";
import { openapiRouter } from "./routes/openapi.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  probes: HealthProbes;
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
  const { config, logger, probes } = deps;
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
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal: config.APP_ENV === "development", logger }));
  return app;
}
