import type { AuthUser } from "../lib/auth.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
  interface Locals {
    requestId: string;
    validated?: unknown;
  }
}

export {};
