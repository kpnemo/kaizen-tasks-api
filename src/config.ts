import { z } from "zod";

const bool = z.stringbool();
const int = z.coerce.number().int();

export const configSchema = z
  .object({
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    JWT_SECRET: z.string().min(32),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_MODEL_PROVIDER: z.enum(["anthropic", "fake"]).default("anthropic"),
    AI_MODEL: z.string().min(1).default("claude-sonnet-5"),
    AI_RATE_LIMIT_PER_HOUR: int.positive().default(20),
    AI_GLOBAL_LIMIT_PER_HOUR: int.positive().default(300),
    AI_ENABLED: bool.default(true),
    AI_STALE_MINUTES: int.positive().default(10),
    /** Interview turns per user per hour (spec 3.6). Its own budget, separate from breakdowns. */
    INTERVIEW_HOURLY_LIMIT: int.positive().default(60),
    ADMIN_TOKEN: z.string().min(32).optional(),
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    PORT: int.min(1).max(65535).default(3000),
    WORKER_ENABLED: bool.default(true),
    SEED_DEMO_USER: bool.default(false),
    SEED_DEMO_PASSWORD: z.string().min(8).default("kaizen-demo-2026"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "must look like owner/name")
      .optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().min(1).default("local"),
  })
  .refine((c) => c.AI_MODEL_PROVIDER === "fake" || Boolean(c.ANTHROPIC_API_KEY), {
    path: ["ANTHROPIC_API_KEY"],
    message: "Required unless AI_MODEL_PROVIDER=fake",
  });

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Parse and validate the environment once. Empty strings count as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }
  return result.data;
}

export function isSecureCookieEnv(config: Config): boolean {
  return config.APP_ENV !== "development" && config.APP_ENV !== "test";
}
