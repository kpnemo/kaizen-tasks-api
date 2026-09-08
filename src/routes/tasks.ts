import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { IdParams } from "../schemas/common.js";
import {
  CreateTaskBody,
  ListTasksQuery,
  ReplaceTagsBody,
  UpdateTaskBody,
} from "../schemas/tasks.js";
import type { TasksService } from "../services/tasks.js";
import { validate, validated } from "./validate.js";

const listSchemas = { query: ListTasksQuery };
const createSchemas = { body: CreateTaskBody };
const idSchemas = { params: IdParams };
const updateSchemas = { params: IdParams, body: UpdateTaskBody };
const tagsSchemas = { params: IdParams, body: ReplaceTagsBody };

export function tasksRouter(service: TasksService): Router {
  const router = Router();

  router.get("/", validate(listSchemas), async (req, res) => {
    const { query } = validated<typeof listSchemas>(res);
    const page = await service.list(currentUser(req).id, query);
    sendData(res, page.items, { nextCursor: page.nextCursor });
  });

  router.post("/", validate(createSchemas), async (req, res) => {
    const { body } = validated<typeof createSchemas>(res);
    sendData(res, await service.create(currentUser(req).id, body), { status: 201 });
  });

  router.get("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.get(currentUser(req).id, params.id));
  });

  router.delete("/:id", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    await service.remove(currentUser(req).id, params.id);
    sendNoContent(res);
  });

  router.patch("/:id", validate(updateSchemas), async (req, res) => {
    const { params, body } = validated<typeof updateSchemas>(res);
    sendData(res, await service.update(currentUser(req).id, params.id, body));
  });

  router.post("/:id/suggestions/accept-all", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.acceptAll(currentUser(req).id, params.id));
  });

  router.post("/:id/suggestions/dismiss-all", validate(idSchemas), async (req, res) => {
    const { params } = validated<typeof idSchemas>(res);
    sendData(res, await service.dismissAll(currentUser(req).id, params.id));
  });

  router.put("/:id/tags", validate(tagsSchemas), async (req, res) => {
    const { params, body } = validated<typeof tagsSchemas>(res);
    sendData(res, await service.replaceTags(currentUser(req).id, params.id, body.tagIds));
  });

  return router;
}
