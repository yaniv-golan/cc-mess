import type {
  Message,
  MessageType,
  Priority,
  BroadcastFilter,
  SpawnOptions,
  InstanceEntry,
  MeshControl,
} from "./types.js";
import {
  readRegistry,
  writeRegistry,
  acquireLock,
  releaseLock,
  updateSelf,
  deregisterInstance,
} from "./registry.js";
import {
  createMessage,
  createControlMessage,
  deliverMessage,
  lookupMessage,
  readMeshControl,
  writeMeshControl,
} from "./transport.js";

function assertNotPaused(): void {
  const control = readMeshControl();
  if (control.state === "paused") {
    throw new Error(
      "Mesh is paused — outbound messages are blocked",
    );
  }
}
import { resolveShortName } from "./names.js";
import {
  spawnInstance,
  verifyProcessAlive,
  sendSignalToProcess,
} from "./spawn.js";
import {
  formatInstanceSpawned,
  formatTaskDelegated,
  formatTaskCompleted,
  formatBroadcastSent,
  formatInstanceExited,
  formatSpawnLimitHit,
  shouldRelay,
  formatRelayMessage,
} from "./telegram-relay.js";

export type SendParams = {
  to: string;
  type: Exclude<
    MessageType,
    "control" | "announcement" | "broadcast"
  >;
  subject: string;
  body: string;
  priority?: Priority;
};

export type BroadcastParams = {
  type: "insight" | "announcement";
  subject: string;
  body: string;
  filter?: BroadcastFilter;
};

export type ReplyParams = {
  message_id: string;
  body: string;
};

export type KillParams = {
  target: string;
  reason: string;
};

export type UpdateSelfParams = {
  task?: string;
  capabilities?: string[];
};

export function handleSend(
  selfId: string,
  params: SendParams,
): { message: Message; relayEvent?: string } {
  assertNotPaused();
  const registry = readRegistry();
  const toId = resolveShortName(registry, params.to);

  const msg = createMessage(
    selfId,
    toId,
    params.type,
    params.subject,
    params.body,
    params.priority,
  );

  deliverMessage(msg);

  let relayEvent: string | undefined;
  if (params.type === "task") {
    const event = formatTaskDelegated(
      selfId,
      toId,
      params.subject,
    );
    if (shouldRelay(event.verbosity)) {
      relayEvent = formatRelayMessage(event);
    }
  } else if (params.type === "result") {
    const event = formatTaskCompleted(
      selfId,
      toId,
      params.subject,
    );
    if (shouldRelay(event.verbosity)) {
      relayEvent = formatRelayMessage(event);
    }
  }

  return { message: msg, relayEvent };
}

export function handleBroadcast(
  selfId: string,
  params: BroadcastParams,
): { sent: number; relayEvent?: string } {
  assertNotPaused();
  const registry = readRegistry();
  let targets = Object.entries(registry.instances);

  targets = targets.filter(([id]) => id !== selfId);

  if (params.filter) {
    const f = params.filter;
    if (f.capabilities && f.capabilities.length > 0) {
      targets = targets.filter(([_, entry]) =>
        f.capabilities!.some((cap) =>
          entry.capabilities.includes(cap),
        ),
      );
    }
    if (f.role) {
      targets = targets.filter(
        ([_, entry]) => entry.role === f.role,
      );
    }
    if (f.exclude && f.exclude.length > 0) {
      targets = targets.filter(
        ([id]) => !f.exclude!.includes(id),
      );
    }
  }

  let sent = 0;
  for (const [targetId] of targets) {
    const msg = createMessage(
      selfId,
      targetId,
      params.type,
      params.subject,
      params.body,
      "normal",
    );
    deliverMessage(msg);
    sent++;
  }

  let relayEvent: string | undefined;
  const event = formatBroadcastSent(
    selfId,
    params.subject,
  );
  if (shouldRelay(event.verbosity)) {
    relayEvent = formatRelayMessage(event);
  }

  return { sent, relayEvent };
}

export function handleReply(
  selfId: string,
  params: ReplyParams,
): { message: Message; relayEvent?: string } {
  assertNotPaused();
  const original = lookupMessage(selfId, params.message_id);
  if (!original) {
    throw new Error(
      `Original message ${params.message_id} not found`,
    );
  }

  let toId = original.from;
  const replyType: MessageType =
    original.type === "task" ? "result" : original.type;
  const extraFields: Partial<Message> = {};

  if (original.from === "human") {
    const registry = readRegistry();
    const coordinator = Object.entries(
      registry.instances,
    ).find(([_, e]) => e.role === "coordinator");
    if (!coordinator) {
      throw new Error(
        "Cannot reply to human — no coordinator instance is active",
      );
    }
    toId = coordinator[0];
    extraFields.relay_to = "telegram" as never;
  }

  const msg = createMessage(
    selfId,
    toId,
    replyType,
    "",
    params.body,
    "normal",
    params.message_id,
  );

  Object.assign(msg, extraFields);
  deliverMessage(msg);

  let relayEvent: string | undefined;
  if (replyType === "result") {
    const event = formatTaskCompleted(
      selfId,
      toId,
      params.body.slice(0, 60),
    );
    if (shouldRelay(event.verbosity)) {
      relayEvent = formatRelayMessage(event);
    }
  }

  return { message: msg, relayEvent };
}

export function handleListInstances(): {
  instances: Record<string, InstanceEntry>;
} {
  const registry = readRegistry();
  return { instances: registry.instances };
}

export async function handleSpawn(
  selfId: string,
  selfDepth: number,
  params: SpawnOptions,
): Promise<{
  fullId: string;
  name: string;
  pid: number;
  relayEvent?: string;
}> {
  try {
    const result = await spawnInstance(
      selfId,
      selfDepth,
      params,
    );

    const event = formatInstanceSpawned(
      selfId,
      result.fullId,
      params.cwd,
      params.task,
    );

    let relayEvent: string | undefined;
    if (shouldRelay(event.verbosity)) {
      relayEvent = formatRelayMessage(event);
    }

    return {
      fullId: result.fullId,
      name: result.name,
      pid: result.pid,
      relayEvent,
    };
  } catch (error) {
    const errMsg =
      error instanceof Error
        ? error.message
        : String(error);

    if (
      errMsg.includes("Max instances") ||
      errMsg.includes("Max spawn depth")
    ) {
      const event = formatSpawnLimitHit(selfId, errMsg);
      if (shouldRelay(event.verbosity)) {
        throw new Error(
          `${errMsg} [relay: ${formatRelayMessage(event)}]`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export function handleKill(
  selfId: string,
  params: KillParams,
): {
  sent: boolean;
  targetId: string;
  relayEvent?: string;
} {
  const registry = readRegistry();
  const targetId = resolveShortName(
    registry,
    params.target,
  );

  const ctrlMsg = createControlMessage(
    selfId,
    targetId,
    "shutdown",
    params.reason,
  );
  deliverMessage(ctrlMsg);

  let relayEvent: string | undefined;
  const event = formatTaskDelegated(selfId, targetId, `kill: ${params.reason}`);
  if (shouldRelay(event.verbosity)) {
    relayEvent = formatRelayMessage(event);
  }
  return { sent: true, targetId, relayEvent };
}

export function handleUpdateSelf(
  selfId: string,
  params: UpdateSelfParams,
): void {
  updateSelf(selfId, params);
}

export function handleGracefulShutdown(
  selfId: string,
  reason: string,
): { relayEvent?: string } {
  deregisterInstance(selfId);

  const event = formatInstanceExited(selfId, reason);
  let relayEvent: string | undefined;
  if (shouldRelay(event.verbosity)) {
    relayEvent = formatRelayMessage(event);
  }

  return { relayEvent };
}

export function handleMeshControl(
  selfId: string,
  params: { action: "pause" | "resume" | "shutdown_all" },
): { success: boolean; state: string; message: string } {
  const registry = readRegistry();
  const self = registry.instances[selfId];
  if (!self || self.role !== "coordinator") {
    throw new Error("mesh_control is restricted to the coordinator");
  }

  if (params.action === "shutdown_all") {
    for (const [id] of Object.entries(registry.instances)) {
      if (id === selfId) continue;
      const ctrlMsg = createControlMessage(selfId, id, "shutdown_all", "Mesh-wide shutdown");
      deliverMessage(ctrlMsg);
    }
    return { success: true, state: "shutting_down", message: "Shutdown sent to all instances" };
  }

  const control: MeshControl = {
    state: params.action === "pause" ? "paused" : "running",
    since: new Date().toISOString(),
    by: "human",
  };
  writeMeshControl(control);
  updateSelf(selfId, { paused: params.action === "pause" });

  return { success: true, state: control.state, message: `Mesh ${control.state}` };
}

export function handleSendAsHuman(
  selfId: string,
  params: { to: string; body: string },
): { message: Message } {
  const registry = readRegistry();
  const self = registry.instances[selfId];
  if (!self || self.role !== "coordinator") {
    throw new Error("send_as_human is restricted to the coordinator");
  }
  const toId = resolveShortName(registry, params.to);
  const msg = createMessage("human", toId, "chat", "", params.body);
  deliverMessage(msg);
  return { message: msg };
}

export function handleKillEscalation(
  targetId: string,
): {
  success: boolean;
  message: string;
} {
  const registry = readRegistry();
  const entry = registry.instances[targetId];
  if (!entry) {
    return {
      success: false,
      message: `${targetId} not in registry`,
    };
  }

  if (!verifyProcessAlive(entry.pid, entry.started_at)) {
    // Persist orphaned status so the human can investigate
    try {
      if (acquireLock()) {
        try {
          const reg = readRegistry();
          if (reg.instances[targetId]) {
            reg.instances[targetId].status = "orphaned";
            writeRegistry(reg);
          }
        } finally {
          releaseLock();
        }
      }
    } catch {
      // best-effort
    }
    return {
      success: false,
      message:
        `PID ${entry.pid} is not a matching claude ` +
        `process — marked as orphaned`,
    };
  }

  const killed = sendSignalToProcess(
    entry.pid,
    "SIGTERM",
  );
  return {
    success: killed,
    message: killed
      ? `SIGTERM sent to PID ${entry.pid}`
      : `Failed to send SIGTERM to PID ${entry.pid}`,
  };
}
