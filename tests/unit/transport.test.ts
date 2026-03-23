import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  generateMessageId,
  buildMessageFilename,
  createMessage,
  createControlMessage,
  deliverMessage,
  pollInbox,
  filterPausedMessages,
  readMeshControl,
  writeMeshControl,
  formatChannelNotification,
  lookupMessage,
} from "../../src/transport.js";
import {
  ensureDirectories,
  getMessDir,
  getInboxesDir,
  releaseLock,
} from "../../src/registry.js";
import type { Message } from "../../src/types.js";

const MESS_DIR = getMessDir();

function cleanupMessDir(): void {
  if (existsSync(MESS_DIR)) {
    rmSync(MESS_DIR, { recursive: true, force: true });
  }
}

describe("transport", () => {
  beforeEach(() => {
    cleanupMessDir();
    ensureDirectories();
    releaseLock();
  });

  afterEach(() => {
    releaseLock();
    cleanupMessDir();
  });

  describe("generateMessageId", () => {
    it("returns a msg- prefixed UUID", () => {
      const id = generateMessageId();
      expect(id).toMatch(/^msg-[0-9a-f-]{36}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateMessageId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("buildMessageFilename", () => {
    it("builds correct filename format", () => {
      const fn = buildMessageFilename(
        1711100000000,
        "hermes-c1b7",
        "task",
        "msg-a3b2c1d4-1234-5678-9abc-def012345678",
      );
      expect(fn).toBe(
        "1711100000000-hermes-c1b7-task-a3b2c1d4.json",
      );
    });
  });

  describe("createMessage", () => {
    it("creates a well-formed message", () => {
      const msg = createMessage(
        "apollo-3f2a",
        "hermes-c1b7",
        "task",
        "Do this",
        "Please implement X",
        "high",
      );
      expect(msg.from).toBe("apollo-3f2a");
      expect(msg.to).toBe("hermes-c1b7");
      expect(msg.type).toBe("task");
      expect(msg.subject).toBe("Do this");
      expect(msg.body).toBe("Please implement X");
      expect(msg.priority).toBe("high");
      expect(msg.id).toMatch(/^msg-/);
      expect(msg.timestamp).toBeTruthy();
    });

    it("defaults to normal priority", () => {
      const msg = createMessage(
        "a",
        "b",
        "chat",
        "hi",
        "hello",
      );
      expect(msg.priority).toBe("normal");
    });
  });

  describe("createControlMessage", () => {
    it("creates a control message with high priority", () => {
      const msg = createControlMessage(
        "apollo-3f2a",
        "hermes-c1b7",
        "shutdown",
        "Task complete",
      );
      expect(msg.type).toBe("control");
      expect(msg.action).toBe("shutdown");
      expect(msg.priority).toBe("high");
      expect(msg.reason).toBe("Task complete");
    });
  });

  describe("deliverMessage + pollInbox", () => {
    it("delivers and polls a message", () => {
      const inboxDir = join(
        getInboxesDir(),
        "test-inbox-0001",
      );
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(inboxDir, "processed"), {
        recursive: true,
      });

      const msg = createMessage(
        "sender-0001",
        "test-inbox-0001",
        "task",
        "Test",
        "Test body",
      );
      deliverMessage(msg);

      const messages = pollInbox("test-inbox-0001");
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(msg.id);
      expect((messages[0] as Message).subject).toBe("Test");
    });

    it("moves delivered messages to processed/", () => {
      const inboxDir = join(
        getInboxesDir(),
        "test-proc-0001",
      );
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(inboxDir, "processed"), {
        recursive: true,
      });

      const msg = createMessage(
        "sender-0001",
        "test-proc-0001",
        "chat",
        "Hi",
        "Hello",
      );
      deliverMessage(msg);
      pollInbox("test-proc-0001");

      const remaining = readdirSync(inboxDir).filter(
        (f) =>
          f.endsWith(".json") && f !== "delivered.json",
      );
      expect(remaining).toHaveLength(0);

      const processed = readdirSync(
        join(inboxDir, "processed"),
      );
      expect(processed.length).toBeGreaterThanOrEqual(1);
    });

    it("deduplicates messages on re-poll", () => {
      const inboxDir = join(
        getInboxesDir(),
        "test-dedup-0001",
      );
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(inboxDir, "processed"), {
        recursive: true,
      });

      const msg = createMessage(
        "sender-0001",
        "test-dedup-0001",
        "chat",
        "Hi",
        "Hello",
      );
      deliverMessage(msg);

      const first = pollInbox("test-dedup-0001");
      expect(first).toHaveLength(1);

      deliverMessage(msg);
      const second = pollInbox("test-dedup-0001");
      expect(second).toHaveLength(0);
    });

    it("returns empty array for non-existent inbox", () => {
      const messages = pollInbox("nonexistent-0000");
      expect(messages).toEqual([]);
    });
  });

  describe("filterPausedMessages", () => {
    it("delivers all messages when not paused", () => {
      const msg = createMessage(
        "a",
        "b",
        "task",
        "s",
        "b",
      );
      const { deliver, defer } = filterPausedMessages(
        [msg],
        false,
      );
      expect(deliver).toHaveLength(1);
      expect(defer).toHaveLength(0);
    });

    it("only delivers control messages when paused", () => {
      const regular = createMessage(
        "a",
        "b",
        "task",
        "s",
        "b",
      );
      const ctrl = createControlMessage(
        "a",
        "b",
        "shutdown",
      );
      const { deliver, defer } = filterPausedMessages(
        [regular, ctrl],
        true,
      );
      expect(deliver).toHaveLength(1);
      expect(deliver[0].type).toBe("control");
      expect(defer).toHaveLength(1);
    });
  });

  describe("mesh control", () => {
    it("returns running state when no control file", () => {
      const control = readMeshControl();
      expect(control.state).toBe("running");
    });

    it("reads and writes mesh control", () => {
      writeMeshControl({
        state: "paused",
        since: "2026-01-01T00:00:00Z",
        by: "human",
      });
      const control = readMeshControl();
      expect(control.state).toBe("paused");
      expect(control.by).toBe("human");
    });
  });

  describe("formatChannelNotification", () => {
    it("formats a regular message", () => {
      const msg = createMessage(
        "apollo-3f2a",
        "hermes-c1b7",
        "task",
        "Review plan",
        "Check the auth module",
      );
      const xml = formatChannelNotification(msg);
      expect(xml).toContain('source="mesh"');
      expect(xml).toContain('from="apollo-3f2a"');
      expect(xml).toContain('type="task"');
      expect(xml).toContain("Check the auth module");
    });

    it("formats a control message", () => {
      const msg = createControlMessage(
        "apollo-3f2a",
        "hermes-c1b7",
        "shutdown",
        "Done",
      );
      const xml = formatChannelNotification(msg);
      expect(xml).toContain('type="control"');
      expect(xml).toContain('action="shutdown"');
    });
  });

  describe("lookupMessage", () => {
    it("finds a message in inbox", () => {
      const instanceId = "lookup-test-0001";
      const inboxDir = join(
        getInboxesDir(),
        instanceId,
      );
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(inboxDir, "processed"), {
        recursive: true,
      });

      const msg = createMessage(
        "sender-0001",
        instanceId,
        "task",
        "Find me",
        "Body",
      );
      deliverMessage(msg);

      const found = lookupMessage(instanceId, msg.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(msg.id);
    });

    it("finds a message in processed/", () => {
      const instanceId = "lookup-proc-0001";
      const inboxDir = join(
        getInboxesDir(),
        instanceId,
      );
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(inboxDir, "processed"), {
        recursive: true,
      });

      const msg = createMessage(
        "sender-0001",
        instanceId,
        "task",
        "Find me",
        "Body",
      );
      deliverMessage(msg);
      pollInbox(instanceId);

      const found = lookupMessage(instanceId, msg.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(msg.id);
    });

    it("returns null for unknown message", () => {
      const instanceId = "lookup-null-0001";
      mkdirSync(
        join(getInboxesDir(), instanceId),
        { recursive: true },
      );
      const found = lookupMessage(
        instanceId,
        "msg-nonexistent",
      );
      expect(found).toBeNull();
    });
  });
});
