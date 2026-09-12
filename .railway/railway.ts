import { defineRailway, github, preserve, project, service } from "railway/iac";

// This repository owns only the `api` service. `web` lives in kaizen-tasks-web, and Postgres and
// Redis are provisioned by the L3 lane. The named partial scopes "omit means delete" to the
// resources this file declares, so `railway config apply` from this repo can never remove them
// (Railway IaC docs, "One file per project"). Never rename the partial once it has been applied.
export const partial = "api";

export default defineRailway((ctx) => {
  const production = ctx.environment === "production";

  const api = service("api", {
    // Branch per environment: develop deploys to staging, main to production. checkSuites is
    // wait-for-CI (master plan section 4, `source.checkSuites: true`): Railway holds the deploy
    // until the GitHub check suite for the commit passes. Declared here so an apply never resets it.
    source: github("kpnemo/kaizen-tasks-api", {
      branch: production ? "main" : "develop",
      checkSuites: true,
    }),
    build: "npm run build",
    start: "node dist/server.js",
    healthcheck: "/api/v1/health",
    healthcheckTimeout: 120,
    env: {
      PORT: "3000",
      APP_ENV: production ? "production" : "staging",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      REDIS_URL: "${{Redis.REDIS_URL}}",
      WORKER_ENABLED: "true",
      AI_MODEL_PROVIDER: "anthropic",
      AI_MODEL: "claude-sonnet-5",
      AI_RATE_LIMIT_PER_HOUR: "20",
      AI_GLOBAL_LIMIT_PER_HOUR: "300",
      AI_ENABLED: "true",
      AI_STALE_MINUTES: "3",
      INTERVIEW_HOURLY_LIMIT: "60",
      PRODUCT_CONTEXT_REF: production ? "main" : "develop",
      SEED_DEMO_USER: "true",
      LOG_LEVEL: "info",
      // Secrets are pasted by Mike in the dashboard and never written here.
      JWT_SECRET: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ADMIN_TOKEN: preserve(),
      SEED_DEMO_PASSWORD: preserve(),
      GITHUB_TOKEN: preserve(),
      GITHUB_REPO: preserve(),
    },
  });

  return project("kaizen-tasks", { resources: [api] });
});
