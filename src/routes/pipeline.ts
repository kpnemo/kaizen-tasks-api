import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData } from "../lib/envelope.js";
import { DeployBody, IssueNumberParams, ShipBody, ShipRetryBody } from "../schemas/pipeline.js";
import type { PipelineService } from "../services/pipeline.js";
import { validate, validated } from "./validate.js";

const deploySchemas = { params: IssueNumberParams, body: DeployBody };
const shipSchemas = { body: ShipBody };
const retrySchemas = { body: ShipRetryBody };

export function pipelineRouter(service: PipelineService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    sendData(res, await service.snapshot(currentUser(req).email));
  });

  router.post("/issues/:number/deploy-staging", validate(deploySchemas), async (req, res) => {
    const { params, body } = validated<typeof deploySchemas>(res);
    sendData(res, await service.deployStaging(currentUser(req), params.number, body.passphrase));
  });

  router.post("/ship", validate(shipSchemas), async (req, res) => {
    const { body } = validated<typeof shipSchemas>(res);
    sendData(res, await service.ship(currentUser(req), body));
  });

  router.post("/ship/retry", validate(retrySchemas), async (req, res) => {
    const { body } = validated<typeof retrySchemas>(res);
    sendData(res, await service.retryShip(currentUser(req), body));
  });

  return router;
}
