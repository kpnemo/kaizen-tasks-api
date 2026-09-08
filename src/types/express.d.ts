declare module "express-serve-static-core" {
  interface Locals {
    requestId: string;
    validated?: unknown;
  }
}

export {};
