import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { IdParams } from "../schemas/common.js";
import { CreateTagBody, UpdateTagBody } from "../schemas/tags.js";
import type { TagsService } from "../services/tags.js";
import { validate, validated } from "./validate.js";

const createSchemas = { body: CreateTagBody };
const updateSchemas = { params: IdParams, body: UpdateTagBody };
const idSchemas = { params: IdParams };

export function tagsRouter(service: TagsService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    sendData(res, await service.list(currentUser(req).id));
  });

  router.post("/", validate(createSchemas), async (req, res) => {
    const { body } = validated<typeof createSchemas>(res);
    sendData(res, await service.create(currentUser(req).id, body), { status: 201 });
  });

  router.patch("/:id", validate(updateSchemas), async (req, res) => {
    const { params, body } = validated<typeof updateSchemas>(res);
    sendData(res, await service.update(currentUser(req).id, params.id, body));
  });

  router.delete("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    await service.remove(currentUser(req).id, params.id);
    sendNoContent(res);
  });

  return router;
}
