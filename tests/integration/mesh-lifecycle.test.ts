import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureDirectories,
  registerInstance,
  heartbeat,
  updateSelf,
  deregisterInstance,
  readRegistry,
  writeRegistry,
  cleanupDeadInstances,
  getMessDir,
  getInboxesDir,
  getAuditDir,
  releaseLock,
} from "../../src/registry.js";
import {
  createMessage,
  deliverMessage,
  pollInbox,
  filterPausedMessages,
  writeMeshControl,
  readMeshControl,
  formatChannelNotification,
} from "../../src/transport.js";
import { resolveShortName } from "../../src/names.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("mesh lifecycle (integration)", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  it("full lifecycle: register → communicate → deregister", () => {
    const coordId = registerInstance(
      "coordinator",
      "/tmp/coord",
      "Coordinating",
      ["spawn", "broadcast", "telegram-relay"],
      null,
      0,
    );

    const workerId = registerInstance(
      "worker",
      "/tmp/worker",
      "Implementing auth",
      ["implement", "review"],
      coordId,
      1,
    );

    let reg = readRegistry();
    expect(Object.keys(reg.instances)).toHaveLength(2);
    expect(reg.instances[coordId].role).toBe("coordinator");
    expect(reg.instances[workerId].spawned_by).toBe(
      coordId,
    );

    const taskMsg = createMessage(
      coordId,
      workerId,
      "task",
      "Refactor auth",
      "Split auth.ts into modules",
    );
    deliverMessage(taskMsg);

    const workerMessages = pollInbox(workerId);
    expect(workerMessages).toHaveLength(1);
    expect(workerMessages[0].type).toBe("task");

    const resultMsg = createMessage(
      workerId,
      coordId,
      "result",
      "Auth refactored",
      "Done. Created 3 new modules.",
      "normal",
      taskMsg.id,
    );
    deliverMessage(resultMsg);

    const coordMessages = pollInbox(coordId);
    expect(coordMessages).toHaveLength(1);
    expect(coordMessages[0].in_reply_to).toBe(taskMsg.id);

    deregisterInstance(workerId);
    reg = readRegistry();
    expect(reg.instances[workerId]).toBeUndefined();
    expect(reg.instances[coordId]).toBeDefined();

    const auditDir = join(getAuditDir(), workerId);
    expect(existsSync(auditDir)).toBe(true);
  });

  it("heartbeat keeps instance alive", () => {
    const id = registerInstance(
      "worker",
      "/tmp",
      "task",
      [],
      null,
      0,
    );

    const before = readRegistry().instances[id].alive_at;
    const start = Date.now();
    while (Date.now() - start < 15) { /* wait */ }

    heartbeat(id);
    const after = readRegistry().instances[id].alive_at;
    expect(
      new Date(after).getTime(),
    ).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("updateSelf modifies registry entry", () => {
    const id = registerInstance(
      "worker",
      "/tmp",
      "old task",
      ["review"],
      null,
      0,
    );

    updateSelf(id, {
      task: "new task",
      capabilities: ["implement"],
    });

    const entry = readRegistry().instances[id];
    expect(entry.task).toBe("new task");
    expect(entry.capabilities).toEqual(["implement"]);
  });

  it("resolveShortName works across registered instances", () => {
    const id = registerInstance(
      "worker",
      "/tmp",
      "task",
      [],
      null,
      0,
    );
    const reg = readRegistry();
    const entry = reg.instances[id];

    const resolved = resolveShortName(reg, entry.name);
    expect(resolved).toBe(id);
  });

  it("dead instance cleanup preserves audit trail", () => {
    const selfId = registerInstance(
      "worker",
      "/tmp",
      "self",
      [],
      null,
      0,
    );

    const deadId = "dead-test-0001";
    const reg = readRegistry();
    reg.instances[deadId] = {
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
    writeRegistry(reg);

    const deadInbox = join(getInboxesDir(), deadId);
    mkdirSync(deadInbox, { recursive: true });
    mkdirSync(join(deadInbox, "processed"), {
      recursive: true,
    });

    const msg = createMessage(
      selfId,
      deadId,
      "task",
      "test",
      "body",
    );
    deliverMessage(msg);
    pollInbox(deadId);

    cleanupDeadInstances(selfId);

    const afterReg = readRegistry();
    expect(afterReg.instances[deadId]).toBeUndefined();

    const auditDir = join(getAuditDir(), deadId);
    expect(existsSync(auditDir)).toBe(true);
  });

  it("mesh pause: only control messages delivered", () => {
    writeMeshControl({
      state: "paused",
      since: new Date().toISOString(),
      by: "human",
    });

    const control = readMeshControl();
    expect(control.state).toBe("paused");

    const regular = createMessage(
      "a-0001",
      "b-0001",
      "task",
      "s",
      "b",
    );
    const ctrl = {
      id: "msg-ctrl",
      from: "a-0001",
      to: "b-0001",
      type: "control" as const,
      timestamp: new Date().toISOString(),
      action: "shutdown" as const,
      priority: "high" as const,
      in_reply_to: null,
    };

    const { deliver, defer } = filterPausedMessages(
      [regular, ctrl],
      true,
    );
    expect(deliver).toHaveLength(1);
    expect(deliver[0].type).toBe("control");
    expect(defer).toHaveLength(1);
    expect(defer[0].type).toBe("task");
  });

  it("channel notification formatting", () => {
    const msg = createMessage(
      "apollo-3f2a",
      "hermes-c1b7",
      "review",
      "Check plan",
      "Review the architecture",
    );
    const notif = formatChannelNotification(msg);
    expect(notif.meta.source).toBe("mesh");
    expect(notif.meta.from).toBe("apollo-3f2a");
    expect(notif.meta.type).toBe("review");
    expect(notif.content).toContain("Review the architecture");
  });

  it("multiple instances communicate peer-to-peer", () => {
    const a = registerInstance(
      "worker",
      "/tmp/a",
      "task A",
      [],
      null,
      1,
    );
    const b = registerInstance(
      "worker",
      "/tmp/b",
      "task B",
      [],
      null,
      1,
    );

    const msgAtoB = createMessage(
      a,
      b,
      "chat",
      "Hey",
      "How's it going?",
    );
    deliverMessage(msgAtoB);

    const bMessages = pollInbox(b);
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0].from).toBe(a);

    const msgBtoA = createMessage(
      b,
      a,
      "chat",
      "Hey back",
      "Going well!",
    );
    deliverMessage(msgBtoA);

    const aMessages = pollInbox(a);
    expect(aMessages).toHaveLength(1);
    expect(aMessages[0].from).toBe(b);
  });
});
