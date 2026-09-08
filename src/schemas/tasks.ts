import { z } from "zod";
import { envelope, errorResponses, IdParams, jsonResponse, listEnvelope } from "./common.js";
import { API_PREFIX, bearerAuth, registry } from "./registry.js";
import { TagSchema } from "./tags.js";

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]).openapi("TaskStatus");
export const AiStatusSchema = z
  .enum(["pending", "running", "done", "failed", "skipped"])
  .openapi("AiStatus");
export const AiSkipReasonSchema = z
  .enum(["too_short", "rate_limited", "ai_disabled"])
  .openapi("AiSkipReason");
export const TaskOriginSchema = z.enum(["user", "ai"]).openapi("TaskOrigin");
export const SuggestionStateSchema = z
  .enum(["suggested", "accepted", "dismissed"])
  .openapi("SuggestionState");

export const ProgressSchema = z
  .object({ done: z.number().int(), total: z.number().int() })
  .openapi("Progress");

export const TaskSummarySchema = z
  .object({
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: TaskStatusSchema,
    aiStatus: AiStatusSchema,
    aiSkipReason: AiSkipReasonSchema.nullable(),
    aiError: z.string().nullable(),
    position: z.number().int(),
    origin: TaskOriginSchema,
    suggestionState: SuggestionStateSchema.nullable(),
    rationale: z.string().nullable(),
    tags: z.array(TagSchema),
    progress: ProgressSchema,
    // Direct children with origin ai still in state suggested; 0 for children and for tasks
    // without suggestions. With aiError above, the list needs no per-row detail query.
    suggestionCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("TaskSummary");

export const TaskDetailSchema = TaskSummarySchema.extend({
  children: z.array(TaskSummarySchema),
  aiTagSuggestions: z.array(z.string()),
}).openapi("TaskDetail");

export const TitleSchema = z.string().trim().min(1).max(200);
export const DescriptionSchema = z.string().max(4000);

export const ListTasksQuery = z.object({
  status: TaskStatusSchema.optional(),
  tagId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const CreateTaskBody = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    parentId: z.uuid().optional(),
    tagIds: z.array(z.uuid()).max(50).optional(),
  })
  .openapi("CreateTaskBody");

export const UpdateTaskBody = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    status: TaskStatusSchema.optional(),
    position: z.number().int().min(0).optional(),
    suggestionState: SuggestionStateSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "At least one field is required",
  })
  .openapi("UpdateTaskBody");

export const ReplaceTagsBody = z
  .object({ tagIds: z.array(z.uuid()).max(50) })
  .openapi("ReplaceTagsBody");

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type AiStatus = z.infer<typeof AiStatusSchema>;
export type AiSkipReason = z.infer<typeof AiSkipReasonSchema>;
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;
export type SuggestionState = z.infer<typeof SuggestionStateSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type ListTasksInput = z.infer<typeof ListTasksQuery>;
export type CreateTaskInput = z.infer<typeof CreateTaskBody>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskBody>;
export type ReplaceTagsInput = z.infer<typeof ReplaceTagsBody>;

const detail = (description: string) => jsonResponse(description, envelope(TaskDetailSchema));

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/tasks`,
  tags: ["tasks"],
  summary: "List tasks",
  description:
    "Top-level tasks unless `parentId` is given. Keyset pagination on (createdAt desc, id desc); pass `meta.nextCursor` back as `cursor`.",
  security: bearerAuth,
  request: { query: ListTasksQuery },
  responses: {
    200: jsonResponse("A page of tasks", listEnvelope(TaskSummarySchema)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks`,
  tags: ["tasks"],
  summary: "Create a task or a step",
  description:
    "Root creates enqueue an AI breakdown (aiStatus pending) unless AI is disabled or rate limited, in which case aiStatus is skipped with a reason. Child creates (parentId set) get aiStatus skipped. Only two levels are allowed.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateTaskBody } } } },
  responses: {
    201: detail("Created"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "get",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Get a task with its children, tags, progress and AI fields",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("The task"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "patch",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Update a task",
  description:
    "`position` is a target index among siblings; affected siblings shift in the same transaction. `suggestionState` is valid only on AI-origin rows: suggested to accepted or dismissed, dismissed to accepted, accepted to dismissed.",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: UpdateTaskBody } } },
  },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "delete",
  path: `${API_PREFIX}/tasks/{id}`,
  tags: ["tasks"],
  summary: "Delete a task and its children",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/breakdown`,
  tags: ["tasks"],
  summary: "Request an AI breakdown",
  description:
    "Root tasks only. CONFLICT when a generation is already pending or running. RATE_LIMITED past the user or global hourly limit (details carry scope, limit, resetAt). UNAVAILABLE when AI is paused by the operator.",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    202: detail("Accepted; aiStatus is pending"),
    ...errorResponses(
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
      "UNAVAILABLE",
    ),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/suggestions/accept-all`,
  tags: ["tasks"],
  summary: "Accept every suggested step",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "post",
  path: `${API_PREFIX}/tasks/{id}/suggestions/dismiss-all`,
  tags: ["tasks"],
  summary: "Dismiss every suggested step",
  security: bearerAuth,
  request: { params: IdParams },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});

registry.registerPath({
  method: "put",
  path: `${API_PREFIX}/tasks/{id}/tags`,
  tags: ["tasks"],
  summary: "Replace the task's tag set",
  description: "Unknown or foreign tag ids give VALIDATION_ERROR.",
  security: bearerAuth,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: ReplaceTagsBody } } },
  },
  responses: {
    200: detail("Updated"),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "NOT_FOUND"),
  },
});
