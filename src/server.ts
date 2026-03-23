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
  ensureDirectories,
  registerInstance,
  heartbeat,
  cleanupDeadInstances,
  coordinatorFailover,
  updateSelf,
} from "./registry.js";
import {
  pollInbox,
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
} from "./tools.js";
import type {
  SendParams,
  BroadcastParams,
  ReplyParams,
  KillParams,
  UpdateSelfParams,
} from "./tools.js";
import type { SpawnOptions } from "./types.js";

const POLL_INTERVAL_MS = 2500;

let instanceId: string | null = null;
let instanceDepth = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

export function getInstanceId(): string | null {
  return instanceId;
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "cc-mess", version: "0.1.0" },
    { capabilities: { tools: {} } },
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    sent: true,
                    message_id: result.message.id,
                    to: result.message.to,
                  }),
                },
              ],
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    broadcast: true,
                    recipients: result.sent,
                  }),
                },
              ],
            };
          }

          case "reply": {
            const params =
              args as unknown as ReplyParams;
            const result = handleReply(
              instanceId,
              params,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    replied: true,
                    message_id: result.message.id,
                    to: result.message.to,
                  }),
                },
              ],
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    spawned: true,
                    instance_id: result.fullId,
                    name: result.name,
                    pid: result.pid,
                  }),
                },
              ],
            };
          }

          case "kill": {
            const params =
              args as unknown as KillParams;
            const result = handleKill(
              instanceId,
              params,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    kill_sent: result.sent,
                    target: params.target,
                  }),
                },
              ],
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

  pollTimer = setInterval(() => {
    if (shuttingDown || !instanceId) return;

    try {
      heartbeat(instanceId);
      cleanupDeadInstances(instanceId);

      const control = readMeshControl();
      const meshPaused = control.state === "paused";

      const rawMessages = pollInbox(instanceId);
      const { deliver } = filterPausedMessages(
        rawMessages,
        meshPaused,
      );

      for (const msg of deliver) {
        if (msg.type === "control") {
          const ctrl = msg as ControlMessage;
          handleControlAction(ctrl);
        }

        const notification =
          formatChannelNotification(msg);
        server.notification({
          method: "notifications/message",
          params: { content: notification },
        }).catch(() => {
          // Notification delivery failure — non-fatal
        });
      }
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

  const envId = process.env.CC_MESS_INSTANCE_ID;
  const envParent =
    process.env.CC_MESS_PARENT_ID ?? null;
  const envDepth = process.env.CC_MESS_DEPTH
    ? parseInt(process.env.CC_MESS_DEPTH, 10)
    : 0;

  if (envId) {
    instanceId = envId;
    instanceDepth = envDepth;
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

  if (role === "coordinator") {
    const oldId = coordinatorFailover(instanceId);
    if (oldId) {
      drainOldCoordinatorInbox(oldId);
    }
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
  _oldId: string,
): void {
  // Drain pending messages from old coordinator inbox.
  // Messages are processed normally via pollInbox on the
  // new coordinator's next poll cycle after being moved.
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
