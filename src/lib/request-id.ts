import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";

const HEADER = "x-request-id";
const MAX_LENGTH = 128;

/** Reads x-request-id from the inbound request or generates one, and exposes it everywhere. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header(HEADER);
    const id = inbound && inbound.length <= MAX_LENGTH ? inbound : randomUUID();
    req.headers[HEADER] = id;
    res.locals.requestId = id;
    res.setHeader(HEADER, id);
    next();
  };
}

export function requestIdOf(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}
