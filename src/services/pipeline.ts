import type { Redis } from "ioredis";
import type { Logger } from "../lib/logger.js";
import type { PipelineGitHub } from "./pipeline-github.js";

/** The three repositories the pipeline reads and writes; constants, not settings. */
export const PIPELINE_REPOS = {
  harness: "kpnemo/kaizen-tasks-assembly-line",
  api: "kpnemo/kaizen-tasks-api",
  web: "kpnemo/kaizen-tasks-web",
} as const;

export interface PipelineConfig {
  token: string;
  facilitatorEmails: Set<string>;
  passphrase: string;
  stagingUrl: string;
  productionUrl: string;
}

export interface PipelineService {
  canDeploy(email: string): boolean;
}

export function createPipelineService(deps: {
  github: PipelineGitHub;
  redis: Redis;
  fetchImpl: typeof fetch;
  config: PipelineConfig;
  logger: Logger;
}): PipelineService {
  return {
    canDeploy(email) {
      return deps.config.facilitatorEmails.has(email.toLowerCase());
    },
  };
}
