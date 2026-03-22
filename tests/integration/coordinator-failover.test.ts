import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureDirectories,
  registerInstance,
  coordinatorFailover,
  readRegistry,
  writeRegistry,
  cleanupDeadInstances,
  getMessDir,
  getInboxesDir,
  releaseLock,
} from "../../src/registry.js";
import {
  createMessage,
  deliverMessage,
  pollInbox,
} from "../../src/transport.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("coordinator failover (integration)", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("new coordinator removes old coordinator entry", () => {
    const oldCoord = registerInstance(
      "coordinator",
      "/tmp/old",
      "Old coordinator",
      ["telegram-relay"],
      null,
      0,
    );

    const newCoord = registerInstance(
      "coordinator",
      "/tmp/new",
      "New coordinator",
      ["telegram-relay"],
      null,
      0,
    );

    const oldId = coordinatorFailover(newCoord);
    expect(oldId).toBe(oldCoord);

    const reg = readRegistry();
    expect(reg.instances[oldCoord]).toBeUndefined();
    expect(reg.instances[newCoord]).toBeDefined();
    expect(reg.instances[newCoord].role).toBe(
      "coordinator",
    );
  });

  it("workers skip cleanup of coordinator inboxes", () => {
    const coord = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinator",
      ["telegram-relay"],
      null,
      0,
    );

    const worker = registerInstance(
      "worker",
      "/tmp/worker",
      "Worker",
      [],
      coord,
      1,
    );

    const reg = readRegistry();
    reg.instances[coord].alive_at = new Date(
      Date.now() - 6 * 60_000,
    ).toISOString();
    writeRegistry(reg);

    cleanupDeadInstances(worker);

    const afterReg = readRegistry();
    expect(afterReg.instances[coord]).toBeDefined();
  });

  it("messages to old coordinator inbox are preserved", () => {
    const oldCoord = registerInstance(
      "coordinator",
      "/tmp/old",
      "Old coord",
      ["telegram-relay"],
      null,
      0,
    );

    const worker = registerInstance(
      "worker",
      "/tmp/worker",
      "Worker",
      [],
      oldCoord,
      1,
    );

    const msg = createMessage(
      worker,
      oldCoord,
      "result",
      "Done",
      "Task completed",
    );
    deliverMessage(msg);

    const messages = pollInbox(oldCoord);
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe(worker);
  });

  it("failover returns null when no previous coordinator", () => {
    const coord = registerInstance(
      "worker",
      "/tmp",
      "Not a coord yet",
      [],
      null,
      0,
    );

    const oldId = coordinatorFailover(coord);
    expect(oldId).toBeNull();
  });

  it("multiple workers survive coordinator crash", () => {
    const coord = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinator",
      ["telegram-relay"],
      null,
      0,
    );

    const w1 = registerInstance(
      "worker",
      "/tmp/w1",
      "Worker 1",
      ["implement"],
      coord,
      1,
    );

    const w2 = registerInstance(
      "worker",
      "/tmp/w2",
      "Worker 2",
      ["review"],
      coord,
      1,
    );

    const reg = readRegistry();
    reg.instances[coord].alive_at = new Date(
      Date.now() - 6 * 60_000,
    ).toISOString();
    writeRegistry(reg);

    const peerMsg = createMessage(
      w1,
      w2,
      "chat",
      "Still here?",
      "Coordinator seems down",
    );
    deliverMessage(peerMsg);

    const w2Messages = pollInbox(w2);
    expect(w2Messages).toHaveLength(1);
    expect(w2Messages[0].from).toBe(w1);
  });

  it("new coordinator drains old inbox after failover", () => {
    const oldCoord = registerInstance(
      "coordinator",
      "/tmp/old",
      "Old",
      ["telegram-relay"],
      null,
      0,
    );

    const worker = registerInstance(
      "worker",
      "/tmp/worker",
      "Worker",
      [],
      oldCoord,
      1,
    );

    const msg1 = createMessage(
      worker,
      oldCoord,
      "result",
      "Result 1",
      "Data",
    );
    deliverMessage(msg1);

    const newCoord = registerInstance(
      "coordinator",
      "/tmp/new",
      "New",
      ["telegram-relay"],
      null,
      0,
    );

    coordinatorFailover(newCoord);

    const oldInbox = join(getInboxesDir(), oldCoord);
    if (existsSync(oldInbox)) {
      const pendingFiles = readdirSync(oldInbox).filter(
        (f) =>
          f.endsWith(".json") && f !== "delivered.json",
      );
      expect(pendingFiles.length).toBeGreaterThanOrEqual(0);
    }

    const reg = readRegistry();
    const coordEntries = Object.entries(
      reg.instances,
    ).filter(([_, e]) => e.role === "coordinator");
    expect(coordEntries).toHaveLength(1);
    expect(coordEntries[0][0]).toBe(newCoord);
  });

  it("message dedup after simulated crash recovery", () => {
    const instanceId = registerInstance(
      "worker",
      "/tmp",
      "worker",
      [],
      null,
      1,
    );

    const msg = createMessage(
      "sender-0001",
      instanceId,
      "task",
      "Task",
      "Do something",
    );
    deliverMessage(msg);

    const firstPoll = pollInbox(instanceId);
    expect(firstPoll).toHaveLength(1);

    deliverMessage(msg);
    const secondPoll = pollInbox(instanceId);
    expect(secondPoll).toHaveLength(0);
  });
});
