import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayConfig } from "./types.js";
import { atomicWriteJson, getMessDir } from "./registry.js";

const RELAY_CONFIG_FILENAME = "relay.json";

export function getRelayConfigPath(): string {
  return join(getMessDir(), RELAY_CONFIG_FILENAME);
}

export function loadRelayConfig(path?: string): RelayConfig | null {
  const p = path ?? getRelayConfigPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RelayConfig;
  } catch { return null; }
}

export function saveRelayConfig(config: RelayConfig, path?: string): void {
  atomicWriteJson(path ?? getRelayConfigPath(), config);
}
