import { Router } from "express";
import type { Config } from "../config.js";
import { sendData } from "../lib/envelope.js";
import { unavailable } from "../lib/errors.js";
import { APP_VERSION } from "../lib/version.js";

export interface HealthProbes {
  db(): Promise<void>;
  redis(): Promise<void>;
}

/** Optional routes the web app can switch on. Reported so the client needs no probing. */
export interface HealthFeatures {
  featureRequests: boolean;
  pipeline: boolean;
}

async function probe(fn: () => Promise<void>): Promise<"ok" | "failed"> {
  try {
    await fn();
    return "ok";
  } catch {
    return "failed";
  }
}

export function healthRouter(
  config: Config,
  probes: HealthProbes,
  features: HealthFeatures,
): Router {
  const router = Router();
  router.get("/health", async (_req, res) => {
    const checks = { db: await probe(probes.db), redis: await probe(probes.redis) };
    const failing = Object.entries(checks)
      .filter(([, state]) => state !== "ok")
      .map(([name]) => name);
    if (failing.length > 0) {
      throw unavailable(`Health check failed: ${failing.join(", ")}`);
    }
    sendData(res, {
      status: "ok",
      commit: config.RAILWAY_GIT_COMMIT_SHA,
      version: APP_VERSION,
      env: config.APP_ENV,
      checks,
      features,
    });
  });
  return router;
}
