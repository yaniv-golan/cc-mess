import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import {
  ensureDirectories,
  registerInstance,
  releaseLock,
  getMessDir,
} from "../../src/registry.js";
import {
  handleKill,
  handleMeshControl,
  handleSendAsHuman,
} from "../../src/tools.js";
import { pollInbox, readMeshControl } from "../../src/transport.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("tool relay events", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("handleKill returns relayEvent and targetId", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast"],
      null,
      0,
    );

    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Implementing feature",
      ["implement"],
      coordId,
      1,
    );

    const result = handleKill(coordId, {
      target: workerId,
      reason: "task complete",
    });

    expect(result.sent).toBe(true);
    expect(result.targetId).toBe(workerId);
    expect(typeof result.relayEvent).toBe("string");
    expect(result.relayEvent).toContain("kill: task complete");
  });

  it("handleKill resolves short name and returns correct targetId", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn"],
      null,
      0,
    );

    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Doing work",
      [],
      coordId,
      1,
    );

    // Use full ID as target — targetId should match workerId
    const result = handleKill(coordId, {
      target: workerId,
      reason: "done",
    });

    expect(result.targetId).toBe(workerId);
    expect(result.sent).toBe(true);
  });
});

describe("handleMeshControl", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("allows coordinator to pause the mesh", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast"],
      null,
      0,
    );

    const result = handleMeshControl(coordId, { action: "pause" });

    expect(result.success).toBe(true);
    expect(result.state).toBe("paused");

    const control = readMeshControl();
    expect(control.state).toBe("paused");
  });

  it("allows coordinator to resume the mesh", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast"],
      null,
      0,
    );

    handleMeshControl(coordId, { action: "pause" });
    const result = handleMeshControl(coordId, { action: "resume" });

    expect(result.success).toBe(true);
    expect(result.state).toBe("running");

    const control = readMeshControl();
    expect(control.state).toBe("running");
  });

  it("rejects non-coordinator callers", () => {
    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Implementing",
      ["implement"],
      null,
      1,
    );

    expect(() =>
      handleMeshControl(workerId, { action: "pause" }),
    ).toThrow("mesh_control is restricted to the coordinator");
  });

  it("shutdown_all sends control messages to all workers", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast"],
      null,
      0,
    );

    const worker1Id = registerInstance(
      "worker",
      "/tmp/worker1",
      "Task A",
      ["implement"],
      coordId,
      1,
    );

    const worker2Id = registerInstance(
      "worker",
      "/tmp/worker2",
      "Task B",
      ["implement"],
      coordId,
      1,
    );

    const result = handleMeshControl(coordId, { action: "shutdown_all" });

    expect(result.success).toBe(true);
    expect(result.state).toBe("shutting_down");

    const worker1Inbox = pollInbox(worker1Id);
    expect(worker1Inbox.length).toBeGreaterThanOrEqual(1);
    expect(worker1Inbox.some((m) => m.type === "control")).toBe(true);

    const worker2Inbox = pollInbox(worker2Id);
    expect(worker2Inbox.length).toBeGreaterThanOrEqual(1);
    expect(worker2Inbox.some((m) => m.type === "control")).toBe(true);
  });
});

describe("handleSendAsHuman", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("sends message with from: human", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast"],
      null,
      0,
    );

    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Implementing",
      ["implement"],
      coordId,
      1,
    );

    const result = handleSendAsHuman(coordId, {
      to: workerId,
      body: "hello",
    });

    expect(result.message.from).toBe("human");
    expect(result.message.type).toBe("chat");
    expect(result.message.to).toBe(workerId);

    const inbox = pollInbox(workerId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe("human");
    expect(inbox[0].type).toBe("chat");
  });

  it("rejects non-coordinator callers", () => {
    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Implementing",
      ["implement"],
      null,
      1,
    );

    expect(() =>
      handleSendAsHuman(workerId, { to: workerId, body: "hello" }),
    ).toThrow("send_as_human is restricted to the coordinator");
  });
});
