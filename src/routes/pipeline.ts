import { Router } from "express";
import type { PipelineService } from "../services/pipeline.js";

export function pipelineRouter(_service: PipelineService): Router {
  const router = Router();
  return router;
}
