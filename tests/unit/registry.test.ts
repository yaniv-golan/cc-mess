import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureDirectories,
  atomicWriteJson,
  acquireLock,
  releaseLock,
  readRegistry,
  writeRegistry,
  readConfig,
  registerInstance,
  heartbeat,
  updateSelf,
  deregisterInstance,
  isStale,
  isDead,
  cleanupDeadInstances,
  coordinatorFailover,
  reserveSpawnSlot,
  finalizeSpawnRegistration,
  removeSpawnPlaceholder,
  getMessDir,
  getInboxesDir,
  getAuditDir,
  getConfigPath,
} from "../../src/registry.js";
import type { Registry, InstanceEntry } from "../../src/types.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("registry", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  describe("ensureDirectories", () => {
    it("creates the mess directory structure", () => {
      cleanupMessDir();
      ensureDirectories();
      expect(existsSync(MESS_DIR)).toBe(true);
      expect(existsSync(getInboxesDir())).toBe(true);
      expect(existsSync(getAuditDir())).toBe(true);
    });
  });

  describe("atomicWriteJson", () => {
    it("writes valid JSON atomically", () => {
      const path = join(MESS_DIR, "test.json");
      atomicWriteJson(path, { foo: "bar" });
      const data = JSON.parse(readFileSync(path, "utf8"));
      expect(data).toEqual({ foo: "bar" });
    });

    it("does not leave temp files on success", () => {
      const path = join(MESS_DIR, "test2.json");
      atomicWriteJson(path, { x: 1 });
      expect(existsSync(path)).toBe(true);
      const tmpPath = `${path}.tmp.${process.pid}`;
      expect(existsSync(tmpPath)).toBe(false);
    });
  });

  describe("lockfile", () => {
    it("acquires and releases lock", () => {
      expect(acquireLock()).toBe(true);
      releaseLock();
    });

    it("acquireLock returns false when lock held", () => {
      expect(acquireLock()).toBe(true);
      expect(acquireLock()).toBe(false);
      releaseLock();
    });
  });

  describe("readRegistry / writeRegistry", () => {
    it("returns empty registry when file missing", () => {
      const reg = readRegistry();
      expect(reg).toEqual({ instances: {} });
    });

    it("round-trips registry data", () => {
      const reg: Registry = {
        instances: {
          "test-0001": {
            pid: 1,
            cwd: "/tmp",
            name: "test",
            role: "worker",
            capabilities: ["review"],
            spawned_by: null,
            depth: 0,
            task: "testing",
            alive_at: "2026-01-01T00:00:00Z",
            started_at: "2026-01-01T00:00:00Z",
            paused: false,
          },
        },
      };
      writeRegistry(reg);
      const loaded = readRegistry();
      expect(loaded.instances["test-0001"].name).toBe(
        "test",
      );
      expect(loaded.instances["test-0001"].task).toBe(
        "testing",
      );
    });
  });

  describe("readConfig", () => {
    it("returns defaults when no config file", () => {
      const config = readConfig();
      expect(config.max_instances).toBe(10);
      expect(config.max_spawn_depth).toBe(3);
      expect(config.default_guardrail).toBe("permissive");
    });

    it("reads config from file", () => {
      atomicWriteJson(getConfigPath(), {
        allowed_directories: ["/tmp/*"],
        max_instances: 5,
        max_spawn_depth: 2,
        require_telegram_relay: false,
        default_guardrail: "strict",
      });
      const config = readConfig();
      expect(config.max_instances).toBe(5);
      expect(config.default_guardrail).toBe("strict");
    });
  });

  describe("registerInstance", () => {
    it("registers and creates inbox directories", () => {
      const fullId = registerInstance(
        "worker",
        "/tmp",
        "test task",
        ["review"],
        null,
        0,
      );

      expect(fullId).toMatch(/-[0-9a-f]{4}$/);

      const reg = readRegistry();
      expect(reg.instances[fullId]).toBeDefined();
      expect(reg.instances[fullId].task).toBe("test task");
      expect(reg.instances[fullId].role).toBe("worker");

      const inboxDir = join(getInboxesDir(), fullId);
      expect(existsSync(inboxDir)).toBe(true);
      expect(
        existsSync(join(inboxDir, "processed")),
      ).toBe(true);
    });
  });

  describe("heartbeat", () => {
    it("updates alive_at timestamp", () => {
      const fullId = registerInstance(
        "worker",
        "/tmp",
        "task",
        [],
        null,
        0,
      );
      const before = readRegistry().instances[fullId].alive_at;

      // Small delay to ensure different timestamp
      const start = Date.now();
      while (Date.now() - start < 10) { /* wait */ }

      heartbeat(fullId);
      const after = readRegistry().instances[fullId].alive_at;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });
  });

  describe("updateSelf", () => {
    it("updates task and capabilities", () => {
      const fullId = registerInstance(
        "worker",
        "/tmp",
        "old task",
        ["review"],
        null,
        0,
      );

      updateSelf(fullId, {
        task: "new task",
        capabilities: ["implement", "review"],
      });

      const entry = readRegistry().instances[fullId];
      expect(entry.task).toBe("new task");
      expect(entry.capabilities).toEqual([
        "implement",
        "review",
      ]);
    });

    it("updates paused state", () => {
      const fullId = registerInstance(
        "worker",
        "/tmp",
        "task",
        [],
        null,
        0,
      );

      updateSelf(fullId, { paused: true });
      expect(
        readRegistry().instances[fullId].paused,
      ).toBe(true);
    });

    it("throws for unknown instance", () => {
      expect(() =>
        updateSelf("nonexistent-0000", { task: "x" }),
      ).toThrow("not in registry");
    });
  });

  describe("deregisterInstance", () => {
    it("removes from registry", () => {
      const fullId = registerInstance(
        "worker",
        "/tmp",
        "task",
        [],
        null,
        0,
      );
      deregisterInstance(fullId);
      const reg = readRegistry();
      expect(reg.instances[fullId]).toBeUndefined();
    });
  });

  describe("isStale / isDead", () => {
    it("detects stale entries (>30s)", () => {
      const entry: InstanceEntry = {
        pid: 1,
        cwd: "/tmp",
        name: "test",
        role: "worker",
        capabilities: [],
        spawned_by: null,
        depth: 0,
        task: "t",
        alive_at: new Date(
          Date.now() - 31_000,
        ).toISOString(),
        started_at: new Date().toISOString(),
        paused: false,
      };
      expect(isStale(entry)).toBe(true);
    });

    it("fresh entries are not stale", () => {
      const entry: InstanceEntry = {
        pid: 1,
        cwd: "/tmp",
        name: "test",
        role: "worker",
        capabilities: [],
        spawned_by: null,
        depth: 0,
        task: "t",
        alive_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        paused: false,
      };
      expect(isStale(entry)).toBe(false);
    });

    it("detects dead entries (>5min)", () => {
      const entry: InstanceEntry = {
        pid: 1,
        cwd: "/tmp",
        name: "test",
        role: "worker",
        capabilities: [],
        spawned_by: null,
        depth: 0,
        task: "t",
        alive_at: new Date(
          Date.now() - 6 * 60_000,
        ).toISOString(),
        started_at: new Date().toISOString(),
        paused: false,
      };
      expect(isDead(entry)).toBe(true);
    });
  });

  describe("cleanupDeadInstances", () => {
    it("removes dead workers but not coordinators", () => {
      const selfId = registerInstance(
        "worker",
        "/tmp",
        "self",
        [],
        null,
        0,
      );

      const reg = readRegistry();
      reg.instances["dead-worker-0001"] = {
        pid: 99999,
        cwd: "/tmp",
        name: "dead",
        role: "worker",
        capabilities: [],
        spawned_by: null,
        depth: 0,
        task: "dead",
        alive_at: new Date(
          Date.now() - 6 * 60_000,
        ).toISOString(),
        started_at: new Date().toISOString(),
        paused: false,
      };
      reg.instances["dead-coord-0001"] = {
        pid: 99998,
        cwd: "/tmp",
        name: "coord",
        role: "coordinator",
        capabilities: [],
        spawned_by: null,
        depth: 0,
        task: "coord",
        alive_at: new Date(
          Date.now() - 6 * 60_000,
        ).toISOString(),
        started_at: new Date().toISOString(),
        paused: false,
      };
      writeRegistry(reg);

      cleanupDeadInstances(selfId);

      const after = readRegistry();
      expect(
        after.instances["dead-worker-0001"],
      ).toBeUndefined();
      expect(
        after.instances["dead-coord-0001"],
      ).toBeDefined();
    });
  });

  describe("coordinatorFailover", () => {
    it("removes old coordinator entry", () => {
      const reg: Registry = {
        instances: {
          "old-coord-0001": {
            pid: 1,
            cwd: "/tmp",
            name: "old",
            role: "coordinator",
            capabilities: [],
            spawned_by: null,
            depth: 0,
            task: "coord",
            alive_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            paused: false,
          },
          "new-coord-0002": {
            pid: 2,
            cwd: "/tmp",
            name: "new",
            role: "coordinator",
            capabilities: [],
            spawned_by: null,
            depth: 0,
            task: "coord",
            alive_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            paused: false,
          },
        },
      };
      writeRegistry(reg);

      const oldId = coordinatorFailover(
        "new-coord-0002",
      );
      expect(oldId).toBe("old-coord-0001");

      const after = readRegistry();
      expect(
        after.instances["old-coord-0001"],
      ).toBeUndefined();
      expect(
        after.instances["new-coord-0002"],
      ).toBeDefined();
    });

    it("returns null when no old coordinator", () => {
      writeRegistry({ instances: {} });
      const oldId = coordinatorFailover(
        "new-coord-0001",
      );
      expect(oldId).toBeNull();
    });
  });

  describe("spawn slot reservation", () => {
    it("reserves and finalizes a spawn slot", () => {
      const parentId = registerInstance(
        "coordinator",
        "/tmp",
        "parent",
        [],
        null,
        0,
      );

      const childId = reserveSpawnSlot(
        parentId,
        0,
        "/tmp/child",
        "child task",
        ["implement"],
      );

      let reg = readRegistry();
      expect(
        reg.instances[childId].status,
      ).toBe("spawning");
      expect(reg.instances[childId].depth).toBe(1);

      finalizeSpawnRegistration(childId, 12345);
      reg = readRegistry();
      expect(reg.instances[childId].pid).toBe(12345);
      expect(
        reg.instances[childId].status,
      ).toBeUndefined();
    });

    it("enforces max_instances", () => {
      atomicWriteJson(getConfigPath(), {
        allowed_directories: [],
        max_instances: 1,
        max_spawn_depth: 3,
        require_telegram_relay: false,
        default_guardrail: "permissive",
      });

      const parentId = registerInstance(
        "coordinator",
        "/tmp",
        "parent",
        [],
        null,
        0,
      );

      expect(() =>
        reserveSpawnSlot(
          parentId,
          0,
          "/tmp",
          "task",
          [],
        ),
      ).toThrow("Max instances");
    });

    it("enforces max_spawn_depth", () => {
      atomicWriteJson(getConfigPath(), {
        allowed_directories: [],
        max_instances: 10,
        max_spawn_depth: 1,
        require_telegram_relay: false,
        default_guardrail: "permissive",
      });

      const parentId = registerInstance(
        "coordinator",
        "/tmp",
        "parent",
        [],
        null,
        0,
      );

      const childId = reserveSpawnSlot(
        parentId,
        0,
        "/tmp",
        "task",
        [],
      );
      finalizeSpawnRegistration(childId, 100);

      expect(() =>
        reserveSpawnSlot(
          childId,
          1,
          "/tmp",
          "grandchild",
          [],
        ),
      ).toThrow("Max spawn depth");
    });

    it("removeSpawnPlaceholder cleans up", () => {
      const parentId = registerInstance(
        "coordinator",
        "/tmp",
        "parent",
        [],
        null,
        0,
      );
      const childId = reserveSpawnSlot(
        parentId,
        0,
        "/tmp",
        "task",
        [],
      );

      removeSpawnPlaceholder(childId);
      const reg = readRegistry();
      expect(
        reg.instances[childId],
      ).toBeUndefined();
    });
  });
});
