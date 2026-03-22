import type {
  RelayEvent,
  RelayEventType,
  VerbosityLevel,
  Message,
  ControlMessage,
  InstanceEntry,
} from "./types.js";

let currentVerbosity: VerbosityLevel = "normal";

export function setVerbosity(level: VerbosityLevel): void {
  currentVerbosity = level;
}

export function getVerbosity(): VerbosityLevel {
  return currentVerbosity;
}

const EVENT_VERBOSITY: Record<
  RelayEventType,
  VerbosityLevel
> = {
  instance_spawned: "normal",
  instance_exited: "normal",
  instance_crashed: "quiet",
  broadcast_sent: "normal",
  task_delegated: "normal",
  task_completed: "normal",
  guardrail_blocked: "quiet",
  spawn_limit_hit: "quiet",
};

const VERBOSITY_ORDER: Record<VerbosityLevel, number> = {
  quiet: 0,
  normal: 1,
  verbose: 2,
};

export function shouldRelay(
  eventVerbosity: VerbosityLevel,
): boolean {
  return (
    VERBOSITY_ORDER[currentVerbosity] >=
    VERBOSITY_ORDER[eventVerbosity]
  );
}

export function createRelayEvent(
  type: RelayEventType,
  message: string,
): RelayEvent {
  return {
    type,
    message,
    timestamp: new Date().toISOString(),
    verbosity: EVENT_VERBOSITY[type],
  };
}

export function formatInstanceSpawned(
  spawner: string,
  spawned: string,
  cwd: string,
  task: string,
): RelayEvent {
  return createRelayEvent(
    "instance_spawned",
    `${spawner} spawned ${spawned} in ${cwd} — "${task}"`,
  );
}

export function formatInstanceExited(
  instanceName: string,
  reason: string,
): RelayEvent {
  return createRelayEvent(
    "instance_exited",
    `${instanceName} exited — ${reason}`,
  );
}

export function formatInstanceCrashed(
  instanceName: string,
): RelayEvent {
  return createRelayEvent(
    "instance_crashed",
    `${instanceName} crashed (no heartbeat)`,
  );
}

export function formatBroadcastSent(
  from: string,
  subject: string,
): RelayEvent {
  return createRelayEvent(
    "broadcast_sent",
    `${from} → all: "${subject}"`,
  );
}

export function formatTaskDelegated(
  from: string,
  to: string,
  subject: string,
): RelayEvent {
  return createRelayEvent(
    "task_delegated",
    `${from} → ${to}: task "${subject}"`,
  );
}

export function formatTaskCompleted(
  from: string,
  to: string,
  subject: string,
): RelayEvent {
  return createRelayEvent(
    "task_completed",
    `${from} → ${to}: result "${subject}"`,
  );
}

export function formatGuardrailBlocked(
  instanceName: string,
  detail: string,
): RelayEvent {
  return createRelayEvent(
    "guardrail_blocked",
    `${instanceName} ${detail} — blocked`,
  );
}

export function formatSpawnLimitHit(
  instanceName: string,
  limit: string,
): RelayEvent {
  return createRelayEvent(
    "spawn_limit_hit",
    `${instanceName} tried to spawn (${limit}) — denied`,
  );
}

export function formatRelayMessage(
  event: RelayEvent,
): string {
  return event.message;
}

export function formatStatusReport(
  instances: Record<string, InstanceEntry>,
): string {
  const entries = Object.entries(instances);
  if (entries.length === 0) {
    return "No active instances.";
  }

  const lines: string[] = ["**Mesh Status**", ""];

  for (const [id, entry] of entries) {
    const uptime = getUptime(entry.started_at);
    const status = entry.paused
      ? "⏸ paused"
      : entry.status === "spawning"
        ? "🔄 spawning"
        : "✅ alive";
    lines.push(
      `• **${id}** (${entry.role}) — ${status}`,
    );
    lines.push(`  Task: ${entry.task}`);
    lines.push(`  CWD: ${entry.cwd}`);
    lines.push(`  Uptime: ${uptime}`);
    lines.push(
      `  Capabilities: ${entry.capabilities.join(", ")}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function getUptime(startedAt: string): string {
  const ms =
    Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function parseHumanMessage(
  text: string,
): { target: string; body: string } | null {
  const match = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (!match) return null;
  return { target: match[1], body: match[2].trim() };
}

export function formatLogsForInstance(
  instanceId: string,
  messages: (Message | ControlMessage)[],
): string {
  if (messages.length === 0) {
    return `No recent messages for ${instanceId}.`;
  }

  const lines: string[] = [
    `**Recent messages for ${instanceId}:**`,
    "",
  ];

  for (const msg of messages) {
    const ts = new Date(msg.timestamp).toLocaleTimeString();
    const direction =
      msg.from === instanceId ? "→" : "←";
    const other =
      msg.from === instanceId ? msg.to : msg.from;

    if (msg.type === "control") {
      const ctrl = msg as ControlMessage;
      lines.push(
        `[${ts}] ${direction} ${other} ` +
          `(control:${ctrl.action})`,
      );
    } else {
      const m = msg as Message;
      const preview = m.subject ?? m.body ?? "";
      const short =
        preview.length > 60
          ? preview.slice(0, 57) + "..."
          : preview;
      lines.push(
        `[${ts}] ${direction} ${other} ` +
          `(${m.type}): ${short}`,
      );
    }
  }

  return lines.join("\n");
}
