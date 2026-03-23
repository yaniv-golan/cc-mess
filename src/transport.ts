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

export function pollInbox(
  instanceId: string,
): (Message | ControlMessage)[] {
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

  const messages: (Message | ControlMessage)[] = [];

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

      messages.push(msg);
      deliveredIds.add(msg.id);
    } catch {
      // Skip malformed messages
    }
  }

  if (messages.length > 0) {
    delivered.delivered = Array.from(deliveredIds);
    if (
      delivered.delivered.length > DELIVERED_TRIM_THRESHOLD
    ) {
      delivered.delivered = delivered.delivered.slice(
        -DELIVERED_TRIM_THRESHOLD,
      );
    }
    atomicWriteJson(deliveredPath, delivered);

    for (const msg of messages) {
      const timestampMs = new Date(
        msg.timestamp,
      ).getTime();
      const filename = buildMessageFilename(
        timestampMs,
        msg.from,
        msg.type,
        msg.id,
      );
      moveToProcessed(inboxDir, filename);
    }
  }

  return messages;
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

export function formatChannelNotification(
  msg: Message | ControlMessage,
): string {
  if (msg.type === "control") {
    const ctrl = msg as ControlMessage;
    const reason = ctrl.reason
      ? ` — ${ctrl.reason}`
      : "";
    return (
      `<channel source="mesh" from="${ctrl.from}" ` +
      `type="control" action="${ctrl.action}" ` +
      `message_id="${ctrl.id}" ` +
      `ts="${ctrl.timestamp}">${reason}</channel>`
    );
  }

  const m = msg as Message;
  const content = m.body ?? m.subject ?? "";
  return (
    `<channel source="mesh" from="${m.from}" ` +
    `type="${m.type}" message_id="${m.id}" ` +
    `ts="${m.timestamp}">${content}</channel>`
  );
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
