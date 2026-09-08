import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { pino, type Logger } from "pino";
import { pinoHttp } from "pino-http";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({ level });
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
