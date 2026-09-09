import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { resetDemoSeed } from "../db/seed.js";

export interface AdminService {
  resetDemo(): Promise<{ demoUserId: string }>;
}

export function createAdminService(deps: {
  db: Db;
  config: Pick<Config, "SEED_DEMO_PASSWORD">;
}): AdminService {
  return {
    async resetDemo() {
      const result = await resetDemoSeed(deps.db, deps.config.SEED_DEMO_PASSWORD);
      return { demoUserId: result.demoUserId };
    },
  };
}
