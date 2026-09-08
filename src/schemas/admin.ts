import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { API_PREFIX, registry } from "./registry.js";

export const AdminTokenHeaders = z.object({
  "x-admin-token": z.string().min(1).openapi({ description: "Facilitator token" }),
});

export const SeedResetResponse = z.object({ demoUserId: z.uuid() }).openapi("SeedResetResponse");

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/admin/seed-reset`,
  tags: ["admin"],
  summary: "Delete and recreate the demo user's fixtures",
  description:
    "Mounted only when ADMIN_TOKEN is configured. A wrong or missing token returns NOT_FOUND so the route is invisible to guessing.",
  request: { headers: AdminTokenHeaders },
  responses: {
    200: jsonResponse("Fixtures recreated", envelope(SeedResetResponse)),
    ...errorResponses("NOT_FOUND"),
  },
});
