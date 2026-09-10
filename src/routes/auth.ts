import { Router } from "express";
import type { Config } from "../config.js";
import {
  clearRefreshCookie,
  cookieValue,
  currentUser,
  REFRESH_COOKIE,
  requireAuth,
  setRefreshCookie,
} from "../lib/auth.js";
import { sendData, sendNoContent } from "../lib/envelope.js";
import { LoginBody, RegisterBody, UpdateMeBody } from "../schemas/auth.js";
import type { AuthService } from "../services/auth.js";
import { validate, validated } from "./validate.js";

const registerSchemas = { body: RegisterBody };
const loginSchemas = { body: LoginBody };
const updateMeSchemas = { body: UpdateMeBody };

export function authRouter(service: AuthService, config: Config): Router {
  const router = Router();

  router.post("/register", validate(registerSchemas), async (_req, res) => {
    const { body } = validated<typeof registerSchemas>(res);
    const session = await service.register(body);
    setRefreshCookie(res, config, session.refreshToken);
    sendData(res, { user: session.user, accessToken: session.accessToken }, { status: 201 });
  });

  router.post("/login", validate(loginSchemas), async (_req, res) => {
    const { body } = validated<typeof loginSchemas>(res);
    const session = await service.login(body);
    setRefreshCookie(res, config, session.refreshToken);
    sendData(res, { user: session.user, accessToken: session.accessToken });
  });

  router.post("/refresh", async (req, res) => {
    const result = await service.refresh(cookieValue(req, REFRESH_COOKIE));
    setRefreshCookie(res, config, result.refreshToken);
    sendData(res, { accessToken: result.accessToken });
  });

  router.post("/logout", async (req, res) => {
    await service.logout(cookieValue(req, REFRESH_COOKIE));
    clearRefreshCookie(res, config);
    sendNoContent(res);
  });

  router.get("/me", requireAuth(config), async (req, res) => {
    sendData(res, { user: await service.me(currentUser(req).id) });
  });

  router.patch("/me", requireAuth(config), validate(updateMeSchemas), async (req, res) => {
    const { body } = validated<typeof updateMeSchemas>(res);
    sendData(res, { user: await service.updateMe(currentUser(req).id, body) });
  });

  return router;
}
