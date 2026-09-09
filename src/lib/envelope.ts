import type { Response } from "express";
import type { ErrorCode } from "./errors.js";
import { requestIdOf } from "./request-id.js";

export interface SuccessMeta {
  requestId: string;
  nextCursor?: string | null;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: SuccessMeta;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function successEnvelope<T>(
  data: T,
  requestId: string,
  nextCursor?: string | null,
): SuccessEnvelope<T> {
  const meta: SuccessMeta = { requestId };
  if (nextCursor !== undefined) meta.nextCursor = nextCursor;
  return { data, meta };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  const error: ErrorEnvelope["error"] = { code, message, requestId };
  if (details !== undefined) {
    return { error: { code, message, details, requestId } };
  }
  return { error };
}

export function sendData<T>(
  res: Response,
  data: T,
  options: { status?: number; nextCursor?: string | null } = {},
): void {
  res
    .status(options.status ?? 200)
    .json(successEnvelope(data, requestIdOf(res), options.nextCursor));
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
