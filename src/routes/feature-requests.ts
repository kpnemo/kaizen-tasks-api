import { Router } from "express";
import { currentUser } from "../lib/auth.js";
import { sendData } from "../lib/envelope.js";
import { openSse, type SseSink } from "../lib/sse.js";
import { IdParams } from "../schemas/common.js";
import { ConversationTurnBody } from "../schemas/feature-request-conversations.js";
import { FeatureRequestBody } from "../schemas/feature-requests.js";
import type { FeatureRequestConversationsService } from "../services/feature-request-conversations.js";
import type { FeatureRequestsService } from "../services/feature-requests.js";
import { validate, validated } from "./validate.js";

const submitSchemas = { body: FeatureRequestBody };
const turnSchemas = { params: IdParams, body: ConversationTurnBody };

export function featureRequestsRouter(
  service: FeatureRequestsService,
  conversations: FeatureRequestConversationsService,
): Router {
  const router = Router();

  router.get("/conversation", async (req, res) => {
    sendData(res, await conversations.get(currentUser(req).id));
  });

  router.post("/conversation", async (req, res) => {
    sendData(res, await conversations.create(currentUser(req).id), { status: 201 });
  });

  router.post("/conversation/:id/messages", validate(turnSchemas), async (req, res) => {
    const { params, body } = validated<typeof turnSchemas>(res);
    // The response object is the disconnect signal: aborting stops the model stream, and the
    // service writes nothing once its sink reports closed.
    const controller = new AbortController();
    let sink: SseSink | undefined;
    try {
      await conversations.turn(
        currentUser(req).id,
        params.id,
        body,
        () => {
          sink = openSse(res, { onAbort: () => controller.abort() });
          return sink;
        },
        controller.signal,
      );
    } finally {
      sink?.close();
    }
  });

  router.post("/", validate(submitSchemas), async (req, res) => {
    const { body } = validated<typeof submitSchemas>(res);
    sendData(res, await service.submit(currentUser(req).id, body), { status: 201 });
  });

  return router;
}
