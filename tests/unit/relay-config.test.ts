import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const TEST_DIR = join(import.meta.dirname, "../../.test-relay-config");

describe("relay-config", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("loads config with chat_id and verbosity", async () => {
    const { loadRelayConfig } = await import("../../src/relay-config.js");
    const configPath = join(TEST_DIR, "relay.json");
    writeFileSync(configPath, JSON.stringify({ chat_id: "123456", verbosity: "normal" }));
    const config = loadRelayConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.chat_id).toBe("123456");
    expect(config!.verbosity).toBe("normal");
  });

  it("returns null when config file missing", async () => {
    const { loadRelayConfig } = await import("../../src/relay-config.js");
    expect(loadRelayConfig(join(TEST_DIR, "nope.json"))).toBeNull();
  });

  it("saves config atomically", async () => {
    const { saveRelayConfig, loadRelayConfig } = await import("../../src/relay-config.js");
    const p = join(TEST_DIR, "relay.json");
    saveRelayConfig({ chat_id: "789", verbosity: "quiet" }, p);
    expect(loadRelayConfig(p)!.chat_id).toBe("789");
  });
});
