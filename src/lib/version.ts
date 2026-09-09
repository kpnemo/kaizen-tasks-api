import { createRequire } from "node:module";

/** The version from package.json, read once at startup. Works from src/ (tsx) and from the compiled output alike, since both sit two levels below the repo root. */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export const APP_VERSION: string = version;
