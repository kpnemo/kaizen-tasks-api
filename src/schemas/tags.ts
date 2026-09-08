import { z } from "zod";
import { envelope, errorResponses, IdParams, jsonResponse } from "./common.js";
import { bearerAuth, registry } from "./registry.js";

export const TagNameSchema = z.string().trim().min(1).max(40);
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #2563eb");

export const TagSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    color: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Tag");

export const CreateTagBody = z
  .object({ name: TagNameSchema, color: HexColorSchema })
  .openapi("CreateTagBody");

export const UpdateTagBody = z
  .object({ name: TagNameSchema.optional(), color: HexColorSchema.optional() })
  .refine((b) => b.name !== undefined || b.color !== undefined, {
    message: "At least one field is required",
  })
  .openapi("UpdateTagBody");

export type Tag = z.infer<typeof TagSchema>;
export type CreateTagInput = z.infer<typeof CreateTagBody>;
export type UpdateTagInput = z.infer<typeof UpdateTagBody>;

registry.registerPath({
  method: "get",
  path: `/tags`,
  tags: ["tags"],
  summary: "List the user's tags",
  security: bearerAuth,
  responses: {
    200: jsonResponse("Tags ordered by name", envelope(z.array(TagSchema))),
    ...errorResponses("UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `/tags`,
  tags: ["tags"],
  summary: "Create a tag",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateTagBody } } } },
  responses: {
    201: jsonResponse("Created", envelope(TagSchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "CONFLICT"),
  },
});

registry.registerPath({
  method: "patch",
  path: `/tags/{id}`,
  tags: ["tags"],
  summary: "Rename or recolor a tag",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateTagBody } } },
  },
  responses: {
    200: jsonResponse("Updated", envelope(TagSchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND", "CONFLICT"),
  },
});

registry.registerPath({
  method: "delete",
  path: `/tags/{id}`,
  tags: ["tags"],
  summary: "Delete a tag and its links",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});
