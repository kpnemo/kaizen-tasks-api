import { readFileSync } from "node:fs";
import { Router } from "express";

/** Serves the committed openapi.json verbatim. Read once, on first request. */
export function openapiRouter(openapiPath: string): Router {
  const router = Router();
  let cached: string | undefined;
  router.get("/openapi.json", (_req, res) => {
    cached ??= readFileSync(openapiPath, "utf8");
    res.type("application/json").send(cached);
  });
  return router;
}
