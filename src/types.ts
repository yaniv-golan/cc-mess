export type MessageType =
  | "task"
  | "review"
  | "chat"
  | "result"
  | "insight"
  | "announcement"
  | "broadcast"
  | "control";

export type Priority = "normal" | "high" | "low";

export type ControlAction =
  | "shutdown"
  | "pause"
  | "resume"
  | "shutdown_all";

export type MeshState = "running" | "paused";

export type InstanceRole = "coordinator" | "worker";

export type GuardrailProfile = "strict" | "permissive" | "custom";

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  timestamp: string;
  subject?: string;
  body?: string;
  in_reply_to?: string | null;
  priority: Priority;
  relay_to?: string;
}

export interface ControlMessage {
  id: string;
  from: string;
  to: string;
  type: "control";
  timestamp: string;
  action: ControlAction;
  reason?: string;
  in_reply_to?: string | null;
  priority: "high";
}

export interface InstanceEntry {
  pid: number;
  cwd: string;
  name: string;
  role: InstanceRole;
  capabilities: string[];
  spawned_by: string | null;
  depth: number;
  task: string;
  alive_at: string;
  started_at: string;
  paused: boolean;
  status?: "spawning" | "orphaned";
  relay_to?: string;
}

export interface Registry {
  instances: Record<string, InstanceEntry>;
}

export interface MeshControl {
  state: MeshState;
  since: string;
  by: string;
}

export interface MeshConfig {
  allowed_directories: string[];
  max_instances: number;
  max_spawn_depth: number;
  require_telegram_relay: boolean;
  default_guardrail: GuardrailProfile;
}

export interface BroadcastFilter {
  capabilities?: string[];
  role?: InstanceRole;
  exclude?: string[];
}

export interface SpawnOptions {
  cwd: string;
  task: string;
  claude_md?: string;
  capabilities?: string[];
  hooks?: GuardrailProfile;
}

export interface DeliveredSet {
  delivered: string[];
}

export type RelayEventType =
  | "instance_spawned"
  | "instance_exited"
  | "instance_crashed"
  | "broadcast_sent"
  | "task_delegated"
  | "task_completed"
  | "guardrail_blocked"
  | "spawn_limit_hit";

export type VerbosityLevel = "quiet" | "normal" | "verbose";

export interface RelayEvent {
  type: RelayEventType;
  message: string;
  timestamp: string;
  verbosity: VerbosityLevel;
}
