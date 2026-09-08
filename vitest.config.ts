import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/live/**"],
          fileParallelism: false,
          pool: "forks",
          globalSetup: ["tests/setup/global.ts"],
          setupFiles: ["tests/setup/each.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
