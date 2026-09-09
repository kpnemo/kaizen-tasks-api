import { existsSync } from "node:fs";

export interface RuntimeAsset {
  name: string;
  path: string;
}

export function missingAssets(assets: RuntimeAsset[]): RuntimeAsset[] {
  return assets.filter((asset) => !existsSync(asset.path));
}

/** Startup step 2: fail fast with the resolved paths before the port opens. */
export function assertRuntimeAssets(assets: RuntimeAsset[]): void {
  const missing = missingAssets(assets);
  if (missing.length === 0) return;
  throw new Error(
    `Missing runtime assets:\n${missing.map((m) => `  - ${m.name}: ${m.path}`).join("\n")}`,
  );
}
