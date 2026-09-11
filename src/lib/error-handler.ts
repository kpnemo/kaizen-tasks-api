import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { errorEnvelope } from "./envelope.js";
import { AppError, notFound, statusFor, type ValidationDetail } from "./errors.js";
import type { Logger } from "./logger.js";
import { requestIdOf } from "./request-id.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`Route ${req.method} ${req.path} not found`));
};

export function zodDetails(error: ZodError, prefix = ""): ValidationDetail[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return { path: prefix && path ? `${prefix}.${path}` : prefix || path, message: issue.message };
  });
}

export function errorHandler(options: {
  exposeInternal: boolean;
  logger: Logger;
}): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = requestIdOf(res);
    if (err instanceof AppError) {
      res
        .status(statusFor(err.code))
        .json(errorEnvelope(err.code, err.message, requestId, err.details));
      return;
    }
    if (err instanceof ZodError) {
      res
        .status(statusFor("VALIDATION_ERROR"))
        .json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Request validation failed",
            requestId,
            zodDetails(err),
          ),
        );
      return;
    }
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 500) {
      // A JSON parse failure's message quotes the offending input, which may be a secret typed
      // into the wrong place (a passphrase, a token): a fixed message, no details, nothing logged.
      const type = (err as { type?: unknown }).type;
      if (type === "entity.parse.failed" || err instanceof SyntaxError) {
        res.status(400).json(errorEnvelope("VALIDATION_ERROR", "Malformed JSON body", requestId));
        return;
      }
      // Other body-parser errors (too large, wrong charset) carry fixed messages of their own.
      const message = (err as { message?: string }).message ?? "Bad request";
      res.status(400).json(errorEnvelope("VALIDATION_ERROR", message, requestId, []));
      return;
    }
    options.logger.error({ err, requestId }, "unhandled error");
    const message =
      options.exposeInternal && err instanceof Error ? err.message : "Internal server error";
    res.status(statusFor("INTERNAL")).json(errorEnvelope("INTERNAL", message, requestId));
  };
}
