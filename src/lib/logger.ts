import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { pino, stdSerializers, type DestinationStream, type Logger } from "pino";
import { pinoHttp } from "pino-http";

export type { Logger };

/**
 * Serializes an error like pino's default, then drops the properties ioredis and BullMQ attach to
 * failed commands (`command`, `args`), which can carry the arguments of an AUTH or a job payload.
 * Every `logger.error({ err })` in the service goes through this, so no call site can leak them.
 */
export function redactError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const serialized = stdSerializers.err(err) as Record<string, unknown>;
  delete serialized.command;
  delete serialized.args;
  return serialized;
}

/** `destination` lets tests capture log output (e.g. to assert nothing sensitive is logged). */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = { level, serializers: { err: redactError } };
  return destination ? pino(options, destination) : pino(options);
}

interface RequestWithUser extends IncomingMessage {
  user?: { id: string };
}

/** One line per request: method, url, status, responseTime, requestId, userId. */
export function createHttpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req) => String(req.headers["x-request-id"] ?? "unknown"),
    customProps: (req) => ({ userId: (req as RequestWithUser).user?.id }),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  }) as unknown as RequestHandler;
}
