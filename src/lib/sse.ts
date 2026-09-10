/** Spec 3.3: a comment line every 15 seconds keeps proxies from closing an idle stream. */
export const SSE_PING_INTERVAL_MS = 15_000;

/**
 * The narrowest shape the writer needs from a response. Express's `Response` satisfies it
 * structurally, and a plain mock can stand in for it in a unit test without a socket.
 */
export interface SseResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: "close", listener: () => void): void;
}

export interface SseSink {
  /** True once the client disconnected or `close()` ran. Every write is then a no-op. */
  readonly closed: boolean;
  event(name: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

export interface SseOptions {
  pingIntervalMs?: number;
  /** Runs once if the client disconnects before `close()`. Never runs for a normal end. */
  onAbort?: () => void;
}

/**
 * Starts a Server-Sent Events response: headers out and flushed immediately, so the browser sees
 * a 200 before the model is called, then `event: <name>\ndata: <json>\n\n` frames.
 */
export function openSse(res: SseResponse, options: SseOptions = {}): SseSink {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Tells nginx-style proxies not to buffer. Caddy needs no setting: its reverse_proxy flushes
  // text/event-stream immediately, and `flush_interval -1` must not be set because it would also
  // stop Caddy cancelling this request when the client disconnects (amended spec 4.3).
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  const timer = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, options.pingIntervalMs ?? SSE_PING_INTERVAL_MS);
  // A ping timer must never hold the process open on shutdown.
  timer.unref();

  res.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.onAbort?.();
  });

  return {
    get closed() {
      return closed;
    },
    event(name, data) {
      if (closed) return;
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      res.end();
    },
  };
}
