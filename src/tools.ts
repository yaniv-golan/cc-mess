import type {
  Message,
  MessageType,
  Priority,
  BroadcastFilter,
  SpawnOptions,
  InstanceEntry,
} from "./types.js";
import {
  readRegistry,
  updateSelf,
  deregisterInstance,
} from "./registry.js";
import {
  createMessage,
  createControlMessage,
  deliverMessage,
  lookupMessage,
} from "./transport.js";
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
    if (coordinator) {
      toId = coordinator[0];
    }
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

  return { sent: true };
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
    return {
      success: false,
      message:
        `PID ${entry.pid} is not a matching claude ` +
        `process — marking as orphaned`,
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
