import type { RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import { ERROR_CODES, statusFor, type ErrorCode } from "../lib/errors.js";
import "./registry.js";

export const UuidSchema = z.uuid();

export const IdParams = z.object({
  id: UuidSchema.openapi({ param: { name: "id", in: "path" } }),
});

export const MetaSchema = z.object({ requestId: z.string() }).openapi("Meta");

export const ListMetaSchema = z
  .object({ requestId: z.string(), nextCursor: z.string().nullable() })
  .openapi("ListMeta");

export const ValidationDetailSchema = z
  .object({ path: z.string(), message: z.string() })
  .openapi("ValidationDetail");

export const RateLimitDetailsSchema = z
  .object({
    scope: z.enum(["user", "global"]),
    limit: z.number().int(),
    resetAt: z.iso.datetime(),
  })
  .openapi("RateLimitDetails");

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.union([z.array(ValidationDetailSchema), RateLimitDetailsSchema]).optional(),
      requestId: z.string(),
    }),
  })
  .openapi("ErrorEnvelope");

export function envelope<T extends ZodType>(data: T) {
  return z.object({ data, meta: MetaSchema });
}

export function listEnvelope<T extends ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: ListMetaSchema });
}

export function jsonResponse(description: string, schema: ZodType) {
  return { description, content: { "application/json": { schema } } };
}

export function errorResponses(...codes: ErrorCode[]): RouteConfig["responses"] {
  const responses: RouteConfig["responses"] = {};
  for (const code of codes) {
    responses[statusFor(code)] = {
      description: code,
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    };
  }
  return responses;
}
