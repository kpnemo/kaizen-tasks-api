import type { RequestHandler, Response } from "express";
import type { ZodType, z } from "zod";
import { zodDetails } from "../lib/error-handler.js";
import { validationError, type ValidationDetail } from "../lib/errors.js";

export interface ValidateSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

type Infer<T> = T extends ZodType ? z.output<T> : undefined;

export type Validated<S extends ValidateSchemas> = {
  params: Infer<S["params"]>;
  query: Infer<S["query"]>;
  body: Infer<S["body"]>;
};

/**
 * Parses params, query and body with the given zod schemas and stores the parsed
 * values in res.locals.validated. Never assigns to req.query (read-only in Express 5).
 */
export function validate(schemas: ValidateSchemas): RequestHandler {
  return (req, res, next) => {
    const details: ValidationDetail[] = [];
    const out: Record<string, unknown> = {};
    const parts = [
      ["params", schemas.params, req.params],
      ["query", schemas.query, req.query],
      ["body", schemas.body, req.body],
    ] as const;
    for (const [name, schema, value] of parts) {
      if (!schema) continue;
      const result = schema.safeParse(value ?? {});
      if (result.success) {
        out[name] = result.data;
      } else {
        details.push(...zodDetails(result.error, name));
      }
    }
    if (details.length > 0) {
      next(validationError(details));
      return;
    }
    res.locals.validated = out;
    next();
  };
}

export function validated<S extends ValidateSchemas>(res: Response): Validated<S> {
  return res.locals.validated as Validated<S>;
}
