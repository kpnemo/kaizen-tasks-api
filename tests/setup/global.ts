import { loadTestEnv } from "./env.js";

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
}
