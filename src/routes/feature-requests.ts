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
    // service writes nothing once its sink reports closed. The listener goes on here, before the
    // service's ownership, status and rate-limit round trips, because `openSse` starts listening
    // only after them: a tab closed during that window fires `close` while no sink exists yet.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    // Already gone: `close` has fired and will not fire again, so read the state instead. Only
    // the response answers this — `req.destroyed` is true on every normal request too, because the
    // body parser destroys the request stream once it has read the body.
    if (res.destroyed) abort();
    res.on("close", abort);
    let sink: SseSink | undefined;
    try {
      await conversations.turn(
        currentUser(req).id,
        params.id,
        body,
        () => {
          sink = openSse(res, { onAbort: abort });
          return sink;
        },
        controller.signal,
      );
    } finally {
      res.removeListener("close", abort);
      sink?.close();
    }
  });

  router.post("/", validate(submitSchemas), async (req, res) => {
    const { body } = validated<typeof submitSchemas>(res);
    sendData(res, await service.submit(currentUser(req).id, body), { status: 201 });
  });

  return router;
}
