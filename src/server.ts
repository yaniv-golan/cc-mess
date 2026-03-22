import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  InstanceRole,
  ControlMessage,
} from "./types.js";
import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureDirectories,
  registerInstance,
  registerCoordinator,
  removeOldCoordinator,
  heartbeat,
  cleanupDeadInstances,
  updateSelf,
  getInboxesDir,
  getAuditDir,
  readRegistry,
  isDead,
} from "./registry.js";
import {
  scanInbox,
  commitMessages,
  filterPausedMessages,
  readMeshControl,
  formatChannelNotification,
} from "./transport.js";
import {
  handleSend,
  handleBroadcast,
  handleReply,
  handleListInstances,
  handleSpawn,
  handleKill,
  handleUpdateSelf,
  handleGracefulShutdown,
  handleMeshControl,
  handleKillEscalation,
  handleSendAsHuman,
} from "./tools.js";
import type {
  SendParams,
  BroadcastParams,
  ReplyParams,
  KillParams,
  UpdateSelfParams,
} from "./tools.js";
import type { SpawnOptions } from "./types.js";
import { loadRelayConfig } from "./relay-config.js";
import {
  setVerbosity,
  formatInstanceCrashed,
  formatRelayMessage,
  shouldRelay,
} from "./telegram-relay.js";

const POLL_INTERVAL_MS = 2500;
const KILL_ESCALATION_TIMEOUT_MS = 30_000;

let instanceId: string | null = null;
let instanceDepth = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let relayChatId: string | null = null;

const pendingKills = new Map<string, { sentAt: number; targetId: string }>();
const relayedDeadInstances = new Set<string>();

function appendRelayHint(
  content: Array<{ type: string; [key: string]: unknown }>,
  relayEvent?: string,
): Array<{ type: string; [key: string]: unknown }> {
  if (relayEvent) {
    content.push({
      type: "resource" as const,
      resource: {
        uri: "cc-mess://relay",
        mimeType: "text/plain",
        text: relayEvent,
      },
    });
  }
  return content;
}

export function getInstanceId(): string | null {
  return instanceId;
}

export function getRelayChatId(): string | null {
  return relayChatId;
}

function createMcpServer(): Server {
  const registry = readRegistry();
  const self = instanceId ? registry.instances[instanceId] : null;
  const role = self?.role ?? "unknown";
  const instructions = instanceId
    ? `You are mesh instance "${instanceId}" (role: ${role}). Use this identity when communicating with other instances via send/broadcast/reply tools. Other instances know you by this name.`
    : undefined;

  const server = new Server(
    { name: "cc-mess", version: "0.1.0", ...(instructions ? { instructions } : {}) },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "send",
          description:
            "Send a message to a specific instance by name",
          inputSchema: {
            type: "object" as const,
            properties: {
              to: {
                type: "string",
                description: "Target instance name or full ID",
              },
              type: {
                type: "string",
                enum: [
                  "task",
                  "review",
                  "chat",
                  "result",
                  "insight",
                ],
                description: "Message type",
              },
              subject: {
                type: "string",
                description: "Message subject",
              },
              body: {
                type: "string",
                description: "Message body",
              },
              priority: {
                type: "string",
                enum: ["normal", "high", "low"],
                description: "Message priority",
              },
            },
            required: ["to", "type", "subject", "body"],
          },
        },
        {
          name: "broadcast",
          description:
            "Send a message to all instances (or filtered subset)",
          inputSchema: {
            type: "object" as const,
            properties: {
              type: {
                type: "string",
                enum: ["insight", "announcement"],
                description: "Broadcast type",
              },
              subject: {
                type: "string",
                description: "Broadcast subject",
              },
              body: {
                type: "string",
                description: "Broadcast body",
              },
              filter: {
                type: "object",
                properties: {
                  capabilities: {
                    type: "array",
                    items: { type: "string" },
                  },
                  role: { type: "string" },
                  exclude: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                description: "Optional filter criteria",
              },
            },
            required: ["type", "subject", "body"],
          },
        },
        {
          name: "reply",
          description:
            "Reply to a received message (threads via in_reply_to)",
          inputSchema: {
            type: "object" as const,
            properties: {
              message_id: {
                type: "string",
                description:
                  "ID of the message to reply to",
              },
              body: {
                type: "string",
                description: "Reply body",
              },
            },
            required: ["message_id", "body"],
          },
        },
        {
          name: "list_instances",
          description:
            "Show the current registry — who's alive, what they're doing",
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        },
        {
          name: "spawn",
          description:
            "Launch a new Claude Code instance with a task",
          inputSchema: {
            type: "object" as const,
            properties: {
              cwd: {
                type: "string",
                description:
                  "Working directory for the new instance",
              },
              task: {
                type: "string",
                description:
                  "Task description for the new instance",
              },
              claude_md: {
                type: "string",
                description:
                  "Additional instructions for the spawned instance",
              },
              capabilities: {
                type: "array",
                items: { type: "string" },
                description: "Capabilities for the new instance",
              },
              hooks: {
                type: "string",
                enum: ["strict", "permissive", "custom"],
                description: "Guardrail profile",
              },
            },
            required: ["cwd", "task"],
          },
        },
        {
          name: "kill",
          description:
            "Ask an instance to gracefully shut down",
          inputSchema: {
            type: "object" as const,
            properties: {
              target: {
                type: "string",
                description: "Target instance name or ID",
              },
              reason: {
                type: "string",
                description: "Reason for shutdown",
              },
            },
            required: ["target", "reason"],
          },
        },
        {
          name: "update_self",
          description:
            "Update own registry entry (task, capabilities)",
          inputSchema: {
            type: "object" as const,
            properties: {
              task: {
                type: "string",
                description: "Updated task description",
              },
              capabilities: {
                type: "array",
                items: { type: "string" },
                description: "Updated capabilities list",
              },
            },
          },
        },
        {
          name: "mesh_control",
          description: "Pause, resume, or shut down the entire mesh (coordinator only)",
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: ["pause", "resume", "shutdown_all"] },
            },
            required: ["action"],
          },
        },
        {
          name: "send_as_human",
          description: "Send a message as the human to an instance (coordinator only)",
          inputSchema: {
            type: "object" as const,
            properties: {
              to: { type: "string", description: "Target instance name or ID" },
              body: { type: "string", description: "Message body" },
            },
            required: ["to", "body"],
          },
        },
      ],
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      if (!instanceId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Instance not registered",
            },
          ],
        };
      }

      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "send": {
            const params = args as unknown as SendParams;
            const result = handleSend(
              instanceId,
              params,
            );
            return {
              content: appendRelayHint([
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    sent: true,
                    message_id: result.message.id,
                    to: result.message.to,
                  }),
                },
              ], result.relayEvent),
            };
          }

          case "broadcast": {
            const params =
              args as unknown as BroadcastParams;
            const result = handleBroadcast(
              instanceId,
              params,
            );
            return {
              content: appendRelayHint([
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    broadcast: true,
                    recipients: result.sent,
                  }),
                },
              ], result.relayEvent),
            };
          }

          case "reply": {
            const params = args as unknown as ReplyParams;
            const result = handleReply(instanceId, params);
            const responseData: Record<string, unknown> = {
              replied: true,
              message_id: result.message.id,
              to: result.message.to,
            };
            if ((result.message as any).relay_to) {
              responseData.relay_to = (result.message as any).relay_to;
              responseData.reply_body = params.body;
            }
            return {
              content: appendRelayHint([
                { type: "text" as const, text: JSON.stringify(responseData) },
              ], result.relayEvent),
            };
          }

          case "list_instances": {
            const result = handleListInstances();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    result.instances,
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "spawn": {
            const params =
              args as unknown as SpawnOptions;
            const result = await handleSpawn(
              instanceId,
              instanceDepth,
              params,
            );
            return {
              content: appendRelayHint([
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    spawned: true,
                    instance_id: result.fullId,
                    name: result.name,
                    pid: result.pid,
                  }),
                },
              ], result.relayEvent),
            };
          }

          case "kill": {
            const params =
              args as unknown as KillParams;
            const result = handleKill(
              instanceId,
              params,
            );
            pendingKills.set(result.targetId, { sentAt: Date.now(), targetId: result.targetId });
            return {
              content: appendRelayHint([
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    kill_sent: result.sent,
                    target: params.target,
                  }),
                },
              ], result.relayEvent),
            };
          }

          case "update_self": {
            const params =
              args as unknown as UpdateSelfParams;
            handleUpdateSelf(instanceId, params);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    updated: true,
                  }),
                },
              ],
            };
          }

          case "mesh_control": {
            const params = args as unknown as { action: "pause" | "resume" | "shutdown_all" };
            const result = handleMeshControl(instanceId, params);
            if (params.action === "shutdown_all") {
              setTimeout(() => gracefulShutdown("Mesh-wide shutdown"), 1000);
            }
            return {
              content: appendRelayHint([
                { type: "text" as const, text: JSON.stringify(result) },
              ], result.message),
            };
          }

          case "send_as_human": {
            const params = args as unknown as { to: string; body: string };
            const result = handleSendAsHuman(instanceId, params);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ sent: true, to: result.message.to }) },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown tool: ${name}`,
                },
              ],
            };
        }
      } catch (error) {
        const errMsg =
          error instanceof Error
            ? error.message
            : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

function startPolling(
  server: Server,
): void {
  if (!instanceId) return;

  pollTimer = setInterval(async () => {
    if (shuttingDown || !instanceId) return;

    try {
      heartbeat(instanceId);

      // Kill escalation: if a kill hasn't taken effect within the timeout, escalate to SIGTERM
      for (const [key, kill] of pendingKills) {
        if (Date.now() - kill.sentAt > KILL_ESCALATION_TIMEOUT_MS) {
          const reg = readRegistry();
          if (reg.instances[kill.targetId]) {
            const escResult = handleKillEscalation(kill.targetId);
            server.notification({
              method: "notifications/claude/channel",
              params: {
                content: `Kill escalation for ${key}: ${escResult.message}`,
                meta: { source: "mesh", type: "kill_escalation", target: key, ts: new Date().toISOString() },
              },
            }).catch(() => {});
          }
          pendingKills.delete(key);
        }
      }

      // Relay crash events BEFORE cleanup removes dead entries
      const preCleanupRegistry = readRegistry();
      for (const [id, entry] of Object.entries(preCleanupRegistry.instances)) {
        if (id === instanceId) continue;
        if (entry.role === "coordinator") continue;
        if (isDead(entry) && !relayedDeadInstances.has(id)) {
          relayedDeadInstances.add(id);
          const event = formatInstanceCrashed(id);
          if (shouldRelay(event.verbosity)) {
            server.notification({
              method: "notifications/claude/channel",
              params: {
                content: formatRelayMessage(event),
                meta: { source: "mesh", type: "instance_crashed", instance: id, ts: new Date().toISOString() },
              },
            }).catch(() => {});
          }
        }
      }
      cleanupDeadInstances(instanceId);

      const control = readMeshControl();
      const meshPaused = control.state === "paused";

      const pending = scanInbox(instanceId);
      const { deliver } = filterPausedMessages(
        pending.map((p) => p.message),
        meshPaused,
      );

      // Deliver notifications FIRST, then commit only
      // successfully delivered messages. Failed notifications
      // stay in inbox for retry (at-least-once).
      const successfulIds = new Set<string>();
      const notificationPromises: Promise<void>[] = [];
      for (const msg of deliver) {
        if (msg.type === "control") {
          const ctrl = msg as ControlMessage;
          handleControlAction(ctrl);
        }

        const { content: notifContent, meta: notifMeta } =
          formatChannelNotification(msg);
        const msgId = msg.id;
        notificationPromises.push(
          server.notification({
            method: "notifications/claude/channel",
            params: { content: notifContent, meta: notifMeta },
          }).then(() => {
            successfulIds.add(msgId);
          }).catch(() => {
            // Notification failed — don't commit, retry next cycle
          }),
        );
      }

      await Promise.all(notificationPromises);

      // Only commit messages whose notifications succeeded —
      // failed and deferred messages stay in inbox.
      const toCommit = pending.filter((p) =>
        successfulIds.has(p.message.id),
      );
      commitMessages(instanceId, toCommit);
    } catch {
      // Poll cycle failure — will retry next cycle
    }
  }, POLL_INTERVAL_MS);
}

function handleControlAction(
  msg: ControlMessage,
): void {
  switch (msg.action) {
    case "shutdown":
      gracefulShutdown("Shutdown requested by " + msg.from);
      break;
    case "pause":
      if (instanceId) {
        updateSelfPaused(true);
      }
      break;
    case "resume":
      if (instanceId) {
        updateSelfPaused(false);
      }
      break;
    case "shutdown_all":
      gracefulShutdown("Mesh-wide shutdown");
      break;
  }
}

function updateSelfPaused(paused: boolean): void {
  if (!instanceId) return;
  try {
    updateSelf(instanceId, { paused });
  } catch {
    // best-effort
  }
}

function gracefulShutdown(reason: string): void {
  if (shuttingDown || !instanceId) return;
  shuttingDown = true;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  handleGracefulShutdown(instanceId, reason);
  process.exit(0);
}

export async function startServer(
  role: InstanceRole = "worker",
  cwd?: string,
  task?: string,
  capabilities?: string[],
  spawnedBy?: string | null,
  depth?: number,
): Promise<void> {
  ensureDirectories();

  const relayConfig = loadRelayConfig();
  if (relayConfig) {
    setVerbosity(relayConfig.verbosity);
    relayChatId = relayConfig.chat_id;
  }

  const envId = process.env.CC_MESS_INSTANCE_ID;
  const envParent =
    process.env.CC_MESS_PARENT_ID ?? null;
  const envDepth = process.env.CC_MESS_DEPTH
    ? parseInt(process.env.CC_MESS_DEPTH, 10)
    : 0;

  if (envId) {
    instanceId = envId;
    instanceDepth = envDepth;
  } else if (role === "coordinator") {
    // Atomic role transfer: remove old coordinator + register new
    // in a single lock-held operation — no ambiguity window.
    const defaultCoordCaps = [
      "spawn", "broadcast", "review", "telegram-relay",
    ];
    const result = registerCoordinator(
      cwd ?? process.cwd(),
      task ?? "Starting up",
      capabilities ?? defaultCoordCaps,
      spawnedBy ?? envParent,
      depth ?? envDepth,
    );
    instanceId = result.newId;
    instanceDepth = depth ?? envDepth;
    if (result.oldId) {
      drainOldCoordinatorInbox(result.oldId);
    }
  } else {
    instanceId = registerInstance(
      role,
      cwd ?? process.cwd(),
      task ?? "Starting up",
      capabilities ?? ["implement", "review"],
      spawnedBy ?? envParent,
      depth ?? envDepth,
    );
    instanceDepth = depth ?? envDepth;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  startPolling(server);

  process.on("SIGINT", () =>
    gracefulShutdown("SIGINT received"),
  );
  process.on("SIGTERM", () =>
    gracefulShutdown("SIGTERM received"),
  );

  await server.connect(transport);
}

function drainOldCoordinatorInbox(
  oldId: string,
): void {
  if (!instanceId) return;

  const oldInbox = join(getInboxesDir(), oldId);
  if (!existsSync(oldInbox)) return;

  const newInbox = join(getInboxesDir(), instanceId);

  // Move pending messages from old inbox to new coordinator's inbox
  const files = readdirSync(oldInbox).filter(
    (f) =>
      f.endsWith(".json") && f !== "delivered.json",
  );
  for (const file of files) {
    try {
      renameSync(
        join(oldInbox, file),
        join(newInbox, file),
      );
    } catch {
      // best-effort
    }
  }

  // Move old processed/ to audit/
  const oldProcessed = join(oldInbox, "processed");
  const auditDest = join(getAuditDir(), oldId);
  if (existsSync(oldProcessed)) {
    try {
      renameSync(oldProcessed, auditDest);
    } catch {
      // best-effort
    }
  }

  // Remove old inbox directory
  try {
    rmSync(oldInbox, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  // Now that drain is complete, remove the demoted entry from registry.
  // If we crash before this, the "draining" entry stays — the next
  // coordinator restart will find and re-drain it.
  removeOldCoordinator(oldId);
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1])
) {
  const role = (process.env.CC_MESS_ROLE ??
    "worker") as InstanceRole;
  startServer(role).catch((err) => {
    console.error("Failed to start cc-mess:", err);
    process.exit(1);
  });
}
