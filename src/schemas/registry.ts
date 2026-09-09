import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Must run before any schema file calls .openapi(). Every schema file imports this module,
// so ESM evaluation order guarantees it.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export const bearerAuth = [{ bearerAuth: [] }];

export const API_PREFIX = "/api/v1";
