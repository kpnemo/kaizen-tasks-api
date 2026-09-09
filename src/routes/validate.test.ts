import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "../lib/error-handler.js";
import { createLogger } from "../lib/logger.js";
import { requestId } from "../lib/request-id.js";
import { validate, validated } from "./validate.js";

const schemas = {
  params: z.object({ id: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
  body: z.object({ title: z.string().min(1).max(200) }),
};

function app() {
  const app = express();
  app.use(express.json());
  app.use(requestId());
  app.post("/items/:id", validate(schemas), (req, res) => {
    const { params, query, body } = validated<typeof schemas>(res);
    res.json({ params, query, body, rawQuery: req.query });
  });
  app.use(errorHandler({ exposeInternal: true, logger: createLogger("silent") }));
  return app;
}

describe("validate", () => {
  it("stores parsed values in res.locals.validated without touching req.query", async () => {
    const res = await request(app())
      .post("/items/6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7?limit=10")
      .send({ title: "Write the plan" });
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7" });
    expect(res.body.query).toEqual({ limit: 10 });
    expect(res.body.rawQuery).toEqual({ limit: "10" });
    expect(res.body.body).toEqual({ title: "Write the plan" });
  });

  it("applies defaults", async () => {
    const res = await request(app())
      .post("/items/6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7")
      .send({ title: "x" });
    expect(res.body.query).toEqual({ limit: 50 });
  });

  it("reports every failing part with prefixed paths", async () => {
    const res = await request(app()).post("/items/not-a-uuid?limit=0").send({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(["body.title", "params.id", "query.limit"]);
  });
});
