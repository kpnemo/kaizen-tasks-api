import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSse, SSE_PING_INTERVAL_MS, type SseResponse } from "./sse.js";

class MockResponse implements SseResponse {
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];
  flushedAfter = -1;
  ends = 0;
  private listeners: Array<() => void> = [];

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  flushHeaders(): void {
    this.flushedAfter = this.chunks.length;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ends += 1;
  }
  on(_event: "close", listener: () => void): void {
    this.listeners.push(listener);
  }
  /** Simulates the client going away. */
  disconnect(): void {
    for (const listener of this.listeners) listener();
  }
  get body(): string {
    return this.chunks.join("");
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("openSse", () => {
  it("sets the four stream headers and flushes them before any body byte", () => {
    const res = new MockResponse();
    const sink = openSse(res);
    expect(Object.fromEntries(res.headers)).toEqual({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushedAfter).toBe(0);
    sink.close();
  });

  it("frames an event as `event: name` then one `data:` JSON line then a blank line", () => {
    const res = new MockResponse();
    const sink = openSse(res);
    sink.event("delta", { text: "hello" });
    sink.event("done", {});
    expect(res.body).toBe('event: delta\ndata: {"text":"hello"}\n\nevent: done\ndata: {}\n\n');
    sink.close();
  });

  it("writes a ping comment on every interval while the stream is open", () => {
    const res = new MockResponse();
    const sink = openSse(res);
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS * 2);
    expect(res.body).toBe(": ping\n\n: ping\n\n");
    sink.close();
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS * 3);
    expect(res.body).toBe(": ping\n\n: ping\n\n");
  });

  it("honours a custom ping interval", () => {
    const res = new MockResponse();
    const sink = openSse(res, { pingIntervalMs: 50 });
    vi.advanceTimersByTime(120);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(2);
    sink.close();
  });

  it("close() ends the response once and marks the sink closed", () => {
    const res = new MockResponse();
    const sink = openSse(res);
    expect(sink.closed).toBe(false);
    sink.close();
    sink.close();
    expect(sink.closed).toBe(true);
    expect(res.ends).toBe(1);
  });

  it("a client disconnect closes the sink, fires onAbort once and stops every write", () => {
    const res = new MockResponse();
    const onAbort = vi.fn();
    const sink = openSse(res, { onAbort });
    res.disconnect();
    res.disconnect();
    expect(sink.closed).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    sink.event("state", { conversation: null });
    sink.comment("ping");
    vi.advanceTimersByTime(SSE_PING_INTERVAL_MS * 2);
    expect(res.body).toBe("");
    sink.close();
    expect(res.ends).toBe(0);
  });

  it("does not call onAbort for the normal end of a stream", () => {
    const res = new MockResponse();
    const onAbort = vi.fn();
    const sink = openSse(res, { onAbort });
    sink.close();
    res.disconnect();
    expect(onAbort).not.toHaveBeenCalled();
  });
});
