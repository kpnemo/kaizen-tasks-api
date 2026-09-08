import type { BreakdownJobData, BreakdownQueue } from "../../src/jobs/queue.js";

/** Records enqueued jobs; `drain` runs them inline through whatever processor the test passes. */
export class FakeQueue implements BreakdownQueue {
  readonly jobs: BreakdownJobData[] = [];
  failNext = false;

  async enqueueBreakdown(data: BreakdownJobData): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake queue: redis unavailable");
    }
    this.jobs.push(data);
  }

  async close(): Promise<void> {}

  /** Runs and removes every recorded job in order. Returns how many ran. */
  async drain(run: (data: BreakdownJobData) => Promise<void>): Promise<number> {
    let ran = 0;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) break;
      await run(job);
      ran += 1;
    }
    return ran;
  }
}
