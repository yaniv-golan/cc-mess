import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import {
  ensureDirectories,
  registerInstance,
  reserveSpawnSlot,
  finalizeSpawnRegistration,
  removeSpawnPlaceholder,
  readRegistry,
  writeRegistry,
  heartbeat,
  getMessDir,
  getConfigPath,
  releaseLock,
  atomicWriteJson,
} from "../../src/registry.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("concurrent spawn (integration)", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("two spawns with only 1 slot: one succeeds, one fails", () => {
    atomicWriteJson(getConfigPath(), {
      allowed_directories: [],
      max_instances: 2,
      max_spawn_depth: 3,
      require_telegram_relay: false,
      default_guardrail: "permissive",
    });

    const parentId = registerInstance(
      "coordinator",
      "/tmp",
      "parent",
      ["spawn"],
      null,
      0,
    );

    const child1 = reserveSpawnSlot(
      parentId,
      0,
      "/tmp/c1",
      "task 1",
      ["implement"],
    );
    finalizeSpawnRegistration(child1, 1001);

    expect(() =>
      reserveSpawnSlot(
        parentId,
        0,
        "/tmp/c2",
        "task 2",
        ["implement"],
      ),
    ).toThrow("Max instances");

    const reg = readRegistry();
    expect(Object.keys(reg.instances)).toHaveLength(2);
  });

  it("spawn depth enforcement across chain", () => {
    atomicWriteJson(getConfigPath(), {
      allowed_directories: [],
      max_instances: 10,
      max_spawn_depth: 2,
      require_telegram_relay: false,
      default_guardrail: "permissive",
    });

    const coord = registerInstance(
      "coordinator",
      "/tmp",
      "coord",
      [],
      null,
      0,
    );

    const child1 = reserveSpawnSlot(
      coord,
      0,
      "/tmp",
      "depth 1",
      [],
    );
    finalizeSpawnRegistration(child1, 2001);

    const child2 = reserveSpawnSlot(
      child1,
      1,
      "/tmp",
      "depth 2",
      [],
    );
    finalizeSpawnRegistration(child2, 2002);

    expect(() =>
      reserveSpawnSlot(
        child2,
        2,
        "/tmp",
        "depth 3",
        [],
      ),
    ).toThrow("Max spawn depth");
  });

  it("placeholder reaping during heartbeat", () => {
    atomicWriteJson(getConfigPath(), {
      allowed_directories: [],
      max_instances: 10,
      max_spawn_depth: 3,
      require_telegram_relay: false,
      default_guardrail: "permissive",
    });

    const coord = registerInstance(
      "coordinator",
      "/tmp",
      "coord",
      [],
      null,
      0,
    );

    const reg = readRegistry();
    reg.instances["stale-spawn-0001"] = {
      pid: 0,
      cwd: "/tmp",
      name: "stale",
      role: "worker",
      capabilities: [],
      spawned_by: coord,
      depth: 1,
      task: "stale spawn",
      alive_at: new Date(
        Date.now() - 120_000,
      ).toISOString(),
      started_at: new Date(
        Date.now() - 120_000,
      ).toISOString(),
      paused: false,
      status: "spawning",
    };
    writeRegistry(reg);

    heartbeat(coord);

    const after = readRegistry();
    expect(
      after.instances["stale-spawn-0001"],
    ).toBeUndefined();
    expect(after.instances[coord]).toBeDefined();
  });

  it("removeSpawnPlaceholder only removes spawning entries", () => {
    const coord = registerInstance(
      "coordinator",
      "/tmp",
      "coord",
      [],
      null,
      0,
    );

    removeSpawnPlaceholder(coord);

    const reg = readRegistry();
    expect(reg.instances[coord]).toBeDefined();
  });

  it("sequential spawn reservations work correctly", () => {
    atomicWriteJson(getConfigPath(), {
      allowed_directories: [],
      max_instances: 5,
      max_spawn_depth: 3,
      require_telegram_relay: false,
      default_guardrail: "permissive",
    });

    const coord = registerInstance(
      "coordinator",
      "/tmp",
      "coord",
      [],
      null,
      0,
    );

    const children: string[] = [];
    for (let i = 0; i < 4; i++) {
      const cid = reserveSpawnSlot(
        coord,
        0,
        "/tmp",
        `task ${i}`,
        [],
      );
      finalizeSpawnRegistration(cid, 3000 + i);
      children.push(cid);
    }

    const reg = readRegistry();
    expect(Object.keys(reg.instances)).toHaveLength(5);

    expect(() =>
      reserveSpawnSlot(coord, 0, "/tmp", "overflow", []),
    ).toThrow("Max instances");
  });

  it("concurrent heartbeats from multiple instances", () => {
    const instances: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = registerInstance(
        "worker",
        `/tmp/w${i}`,
        `task ${i}`,
        [],
        null,
        1,
      );
      instances.push(id);
    }

    for (const id of instances) {
      heartbeat(id);
    }

    const reg = readRegistry();
    for (const id of instances) {
      expect(reg.instances[id]).toBeDefined();
    }
  });
});
