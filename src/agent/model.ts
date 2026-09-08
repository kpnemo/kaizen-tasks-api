import type { BreakdownResult } from "../schemas/breakdown.js";

export interface BreakdownInput {
  title: string;
  description: string;
  existingSteps: string[];
  tags: string[];
  openTasks: string[];
}

export type BreakdownOutcome =
  | { kind: "ok"; result: BreakdownResult }
  | { kind: "refused"; reason: string }
  | { kind: "invalid"; reason: string };

/** The seam between the pipeline and any model provider. */
export interface BreakdownModel {
  complete(input: BreakdownInput): Promise<BreakdownOutcome>;
}
