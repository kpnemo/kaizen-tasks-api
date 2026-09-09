import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { sendData } from "../lib/envelope.js";
import { notFound } from "../lib/errors.js";
import type { AdminService } from "../services/admin.js";

export const ADMIN_TOKEN_HEADER = "x-admin-token";

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mounted only when ADMIN_TOKEN is set. A bad token looks exactly like an unmounted route. */
export function adminRouter(options: { adminToken: string; service: AdminService }): Router {
  const router = Router();
  router.post("/seed-reset", async (req, res) => {
    if (!tokenMatches(req.header(ADMIN_TOKEN_HEADER), options.adminToken)) {
      throw notFound(`Route ${req.method} ${req.originalUrl.split("?")[0]} not found`);
    }
    sendData(res, await options.service.resetDemo());
  });
  return router;
}
