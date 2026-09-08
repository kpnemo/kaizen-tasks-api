import { validationError } from "./errors.js";

export interface Cursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function invalid(): never {
  throw validationError([{ path: "query.cursor", message: "Invalid cursor" }]);
}

export function decodeCursor(raw: string): Cursor {
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  if (typeof parsed !== "object" || parsed === null) invalid();
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string" || !UUID.test(i)) invalid();
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) invalid();
  return { createdAt, id: i };
}
