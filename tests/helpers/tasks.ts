import type { Server } from "node:http";
import request from "supertest";
import type { TaskDetail } from "../../src/schemas/tasks.js";
import { auth } from "./auth.js";

export async function createTask(
  server: Server,
  token: string,
  body: { title: string; description?: string; parentId?: string; tagIds?: string[] },
): Promise<TaskDetail> {
  const res = await request(server).post("/api/v1/tasks").set(auth(token)).send(body);
  if (res.status !== 201) {
    throw new Error(`create task failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as TaskDetail;
}
