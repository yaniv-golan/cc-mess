import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
  Message,
  ControlMessage,
  MeshControl,
  MessageType,
  Priority,
  ControlAction,
  DeliveredSet,
} from "./types.js";
import {
  atomicWriteJson,
  getInboxesDir,
  getControlPath,
  readRegistry,
} from "./registry.js";

const DELIVERED_TRIM_THRESHOLD = 1000;

export function generateMessageId(): string {
  return `msg-${uuidv4()}`;
}

export function buildMessageFilename(
  timestampMs: number,
  fromId: string,
  type: MessageType,
  msgId: string,
): string {
  const shortId = msgId.replace("msg-", "").slice(0, 8);
  return `${timestampMs}-${fromId}-${type}-${shortId}.json`;
}

export function createMessage(
  fromId: string,
  toId: string,
  type: MessageType,
  subject: string,
  body: string,
  priority: Priority = "normal",
  inReplyTo?: string | null,
): Message {
  return {
    id: generateMessageId(),
    from: fromId,
    to: toId,
    type,
    timestamp: new Date().toISOString(),
    subject,
    body,
    in_reply_to: inReplyTo ?? null,
    priority,
  };
}

export function createControlMessage(
  fromId: string,
  toId: string,
  action: ControlAction,
  reason?: string,
  inReplyTo?: string | null,
): ControlMessage {
  return {
    id: generateMessageId(),
    from: fromId,
    to: toId,
    type: "control",
    timestamp: new Date().toISOString(),
    action,
    reason,
    in_reply_to: inReplyTo ?? null,
    priority: "high",
  };
}

export function deliverMessage(
  message: Message | ControlMessage,
): void {
  const inboxDir = join(getInboxesDir(), message.to);
  if (!existsSync(inboxDir)) {
    // Check if this is a known instance — don't silently
    // create orphan inboxes for dead/unknown recipients
    const registry = readRegistry();
    if (!registry.instances[message.to]) {
      throw new Error(
        `Cannot deliver message — inbox for "${message.to}" ` +
        `does not exist (instance may be dead or cleaned up)`,
      );
    }
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(join(inboxDir, "processed"), {
      recursive: true,
    });
  }

  const timestampMs = Date.now();
  const filename = buildMessageFilename(
    timestampMs,
    message.from,
    message.type,
    message.id,
  );

  atomicWriteJson(join(inboxDir, filename), message);
}

export interface PendingMessage {
  message: Message | ControlMessage;
  file: string;
}

/**
 * Scan inbox for new messages without committing them.
 * Call commitMessages() on the ones you actually deliver.
 */
export function scanInbox(
  instanceId: string,
): PendingMessage[] {
  const inboxDir = join(getInboxesDir(), instanceId);
  if (!existsSync(inboxDir)) {
    return [];
  }

  const deliveredPath = join(inboxDir, "delivered.json");
  const delivered = readDeliveredSet(deliveredPath);
  const deliveredIds = new Set(delivered.delivered);

  const files = readdirSync(inboxDir).filter(
    (f) => f.endsWith(".json") && f !== "delivered.json",
  );
  files.sort();

  const pending: PendingMessage[] = [];

  for (const file of files) {
    const filePath = join(inboxDir, file);
    try {
      const raw = readFileSync(filePath, "utf8");
      const msg = JSON.parse(raw) as
        | Message
        | ControlMessage;

      if (deliveredIds.has(msg.id)) {
        moveToProcessed(inboxDir, file);
        continue;
      }

      pending.push({ message: msg, file });
    } catch {
      // Skip malformed messages
    }
  }

  return pending;
}

/**
 * Commit delivered messages: mark as delivered and move to processed/.
 * Only call this for messages you have actually delivered to Claude.
 */
export function commitMessages(
  instanceId: string,
  delivered: PendingMessage[],
): void {
  if (delivered.length === 0) return;

  const inboxDir = join(getInboxesDir(), instanceId);
  const deliveredPath = join(inboxDir, "delivered.json");
  const deliveredSet = readDeliveredSet(deliveredPath);
  const ids = new Set(deliveredSet.delivered);

  for (const { message, file } of delivered) {
    ids.add(message.id);
    moveToProcessed(inboxDir, file);
  }

  deliveredSet.delivered = Array.from(ids);
  if (
    deliveredSet.delivered.length > DELIVERED_TRIM_THRESHOLD
  ) {
    deliveredSet.delivered = deliveredSet.delivered.slice(
      -DELIVERED_TRIM_THRESHOLD,
    );
  }
  atomicWriteJson(deliveredPath, deliveredSet);
}

/**
 * Legacy convenience wrapper: scan + commit all in one call.
 * Only use when pause filtering is not needed.
 */
export function pollInbox(
  instanceId: string,
): (Message | ControlMessage)[] {
  const pending = scanInbox(instanceId);
  commitMessages(instanceId, pending);
  return pending.map((p) => p.message);
}

export function filterPausedMessages(
  messages: (Message | ControlMessage)[],
  meshPaused: boolean,
): {
  deliver: (Message | ControlMessage)[];
  defer: (Message | ControlMessage)[];
} {
  if (!meshPaused) {
    return { deliver: messages, defer: [] };
  }

  const deliver: (Message | ControlMessage)[] = [];
  const defer: (Message | ControlMessage)[] = [];

  for (const msg of messages) {
    if (msg.type === "control") {
      deliver.push(msg);
    } else {
      defer.push(msg);
    }
  }

  return { deliver, defer };
}

export function readMeshControl(): MeshControl {
  const controlPath = getControlPath();
  if (!existsSync(controlPath)) {
    return {
      state: "running",
      since: new Date().toISOString(),
      by: "system",
    };
  }
  try {
    const raw = readFileSync(controlPath, "utf8");
    return JSON.parse(raw) as MeshControl;
  } catch {
    return {
      state: "running",
      since: new Date().toISOString(),
      by: "system",
    };
  }
}

export function writeMeshControl(
  control: MeshControl,
): void {
  atomicWriteJson(getControlPath(), control);
}

export interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

export function formatChannelNotification(
  msg: Message | ControlMessage,
): ChannelNotification {
  if (msg.type === "control") {
    const ctrl = msg as ControlMessage;
    const reason = ctrl.reason ?? "";
    return {
      content: `[mesh control:${ctrl.action}] ${reason}`,
      meta: {
        source: "mesh",
        from: ctrl.from,
        type: "control",
        action: ctrl.action,
        message_id: ctrl.id,
        ts: ctrl.timestamp,
      },
    };
  }

  const m = msg as Message;
  const body = m.body ?? m.subject ?? "";
  const prefix = m.subject ? `[${m.type}] ${m.subject}: ` : `[${m.type}] `;
  return {
    content: `${prefix}${body}`,
    meta: {
      source: "mesh",
      from: m.from,
      type: m.type,
      message_id: m.id,
      ts: m.timestamp,
      ...(m.subject ? { subject: m.subject } : {}),
      ...((m as any).relay_to ? { relay_to: (m as any).relay_to } : {}),
    },
  };
}

export function lookupMessage(
  instanceId: string,
  messageId: string,
): (Message | ControlMessage) | null {
  const inboxDir = join(getInboxesDir(), instanceId);

  for (const subdir of ["", "processed"]) {
    const dir = subdir
      ? join(inboxDir, subdir)
      : inboxDir;
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter((f) =>
      f.endsWith(".json"),
    );
    for (const file of files) {
      if (file === "delivered.json") continue;
      try {
        const raw = readFileSync(
          join(dir, file),
          "utf8",
        );
        const msg = JSON.parse(raw) as
          | Message
          | ControlMessage;
        if (msg.id === messageId) {
          return msg;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

function readDeliveredSet(path: string): DeliveredSet {
  if (!existsSync(path)) {
    return { delivered: [] };
  }
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as DeliveredSet;
  } catch {
    return { delivered: [] };
  }
}

function moveToProcessed(
  inboxDir: string,
  filename: string,
): void {
  const src = join(inboxDir, filename);
  const dest = join(inboxDir, "processed", filename);
  try {
    if (existsSync(src)) {
      renameSync(src, dest);
    }
  } catch {
    // best-effort move
  }
}
