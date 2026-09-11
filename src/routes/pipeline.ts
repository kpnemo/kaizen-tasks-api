import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData } from "../lib/envelope.js";
import type { PipelineService } from "../services/pipeline.js";

export function pipelineRouter(service: PipelineService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    sendData(res, await service.snapshot(currentUser(req).email));
  });

  return router;
}
