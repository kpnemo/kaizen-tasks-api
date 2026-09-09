import { describe, expect, it } from "vitest";
import { createLogger, redactError } from "../../src/lib/logger.js";

/** An error shaped like ioredis's ReplyError: the failed command and its arguments ride along. */
function redisStyleError(): Error {
  const err = new Error("NOAUTH Authentication required.") as Error & {
    command: { name: string; args: string[] };
  };
  err.command = { name: "AUTH", args: ["hunter2-secret"] };
  return err;
}

describe("redactError", () => {
  it("keeps type, message and stack but drops command arguments", () => {
    const out = redactError(redisStyleError()) as Record<string, unknown>;
    expect(out.type).toBe("Error");
    expect(out.message).toBe("NOAUTH Authentication required.");
    expect(typeof out.stack).toBe("string");
    expect(out).not.toHaveProperty("command");
    expect(out).not.toHaveProperty("args");
  });

  it("passes non-errors through untouched", () => {
    expect(redactError("plain string")).toBe("plain string");
  });
});

describe("createLogger", () => {
  it("never writes an error's command arguments to the destination", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line: string) => lines.push(line) });
    logger.error({ err: redisStyleError(), taskId: "t1" }, "could not enqueue breakdown");
    const line = lines.join("");
    expect(line).toContain("could not enqueue breakdown");
    expect(line).toContain("NOAUTH Authentication required.");
    expect(line).not.toContain("hunter2-secret");
    expect(line).not.toContain('"command"');
  });
});
