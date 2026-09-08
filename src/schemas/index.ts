import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import "./health.js";
import "./auth.js";
import "./tasks.js";
import "./tags.js";
import "./feature-requests.js";
import "./admin.js";
import { registry } from "./registry.js";

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

export function generateOpenApiDocument(): OpenApiDocument {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Kaizen Tasks API",
      version: "1",
      description:
        "Personal task manager where every big task is broken into small steps by an AI assistant. Every response uses the `{ data, meta }` envelope; every error uses `{ error }`.",
    },
    tags: [
      { name: "auth" },
      { name: "tasks" },
      { name: "tags" },
      { name: "feature-requests" },
      { name: "admin" },
      { name: "system" },
    ],
  });
}
