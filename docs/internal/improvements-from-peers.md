# Improvements from claude-peers-mcp and cross-claude-mcp

**Date:** 2026-03-24
**Sources:**
- [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) — P2P discovery via HTTP broker + SQLite
- [cross-claude-mcp](https://github.com/rblank9/cross-claude-mcp) — Centralized message bus with channels, shared data, cross-model support

## Features to Add

### 1. Shared Data Store (from cross-claude-mcp)

**Problem:** Sending large code artifacts, analysis results, or file contents through messages bloats the inbox and makes the message stream unreadable.

**Solution:** Key-value sidecar store at `~/.claude/channels/mess/shared/`.

**API:**
```
share_data(key: "auth-refactor-plan", content: "...", ttl?: 3600)
get_shared_data(key: "auth-refactor-plan")
list_shared_data(filter?: { owner?: string })
```

**Implementation:**
- Store as `shared/{key}.json` with `{ owner, content, created_at, ttl }`
- Messages reference keys: `"See shared:auth-refactor-plan for the full plan"`
- Auto-cleanup: delete entries past TTL during poll loop
- Add `share_data`, `get_shared_data`, `list_shared_data` MCP tools
- No locking needed — keys are write-once (or owner-overwrite)

### 2. `done` Message Type (from cross-claude-mcp)

**Problem:** When a worker finishes a task and sends a `result`, the requester has no protocol-level signal that the thread is complete. The requester may keep polling or waiting.

**Solution:** Add `done` to the message type enum.

**Semantics:**
- Sent after the final `result` in a task thread
- Carries `in_reply_to` pointing to the original task
- Receivers can use this to close tracking (e.g., remove from `pendingKills`, stop waiting)
- Not delivered to Claude (handled by the poll loop internally)

**Implementation:**
- Add `"done"` to `MessageType` in `types.ts`
- `handleReply` auto-sends a `done` message after a `result` reply to a `task`
- Poll loop intercepts `done` messages and cleans up internal state

### 3. Signal-0 Liveness Check (from claude-peers-mcp)

**Problem:** Our liveness check uses `ps -p {pid} -o lstart=` which is expensive and macOS-specific. The `isStale`/`isDead` thresholds (30s/5min) are coarse.

**Solution:** Use `process.kill(pid, 0)` — a zero-cost kernel call that returns true if the process exists, false otherwise. No child process spawning, works on all POSIX systems.

**Implementation:**
```typescript
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- Use in `cleanupDeadInstances`: if `!isProcessAlive(pid)`, mark dead immediately instead of waiting for heartbeat timeout
- Use in `verifyProcessAlive` (kill escalation): replace `ps` command with signal-0 + start-time file check
- Keep heartbeat as a secondary signal for cases where PID was reused

### 4. Richer Server Instructions (from claude-peers-mcp)

**Problem:** Instances don't always prioritize or respond to incoming mesh messages.

**Current:** `You are mesh instance "hermes-c1b7" (role: worker).`

**Better:** Include behavioral guidance directly in the MCP server instructions:

```typescript
const instructions = `You are mesh instance "${instanceId}" (role: ${role}).

When you receive a channel message from another mesh instance, treat it like a coworker asking you something — respond promptly. Don't ignore incoming messages.

Your capabilities: ${self.capabilities.join(", ")}
Your task: ${self.task}
Other active instances: ${otherInstances.map(([id, e]) => `${id} (${e.role}): ${e.task}`).join("; ")}`;
```

**Implementation:**
- Expand the instructions string in `createMcpServer()`
- Include the list of currently active instances so the new instance has immediate situational awareness
- Include behavioral guidance about responding to messages

### 5. Auto-Summary from Git Context (from claude-peers-mcp)

**Problem:** The `task` field starts as "Starting up" and only updates if Claude calls `update_self`. Other instances have no useful context about what a peer is working on.

**Solution:** Auto-generate an initial summary from git context.

**Implementation:**
```typescript
function generateAutoSummary(cwd: string): string {
  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
    const status = execSync("git diff --stat HEAD", { cwd, encoding: "utf8" }).trim();
    const recentFiles = status.split("\n").slice(0, 3).join(", ");
    return `Branch: ${branch}${recentFiles ? `. Recent: ${recentFiles}` : ""}`;
  } catch {
    return "Starting up";
  }
}
```

- Call during `registerInstance` / `registerCoordinator` to set initial `task`
- No external API call needed (unlike claude-peers which uses OpenAI)

### 6. Message Search (from cross-claude-mcp)

**Problem:** No way to search across message history for debugging or context recovery.

**Solution:** Add a `search_messages` MCP tool.

**API:**
```
search_messages(query: "auth refactor", scope?: "all" | "inbox" | "processed" | "audit", limit?: 20)
```

**Implementation:**
- Scan inbox, processed, and audit directories
- Simple substring match on subject + body
- Return sorted by timestamp, most recent first
- Useful for `/mess logs` skill and debugging

### 7. Automatic Stale Data Cleanup (from cross-claude-mcp)

**Problem:** cc-mess accumulates inbox files, processed messages, and audit trails with no garbage collection. Long-running meshes will grow unbounded.

**Solution:** Periodic cleanup in the poll loop.

**Implementation:**
- Add `max_audit_age_days` to `MeshConfig` (default: 7)
- In the poll loop (every N cycles, not every cycle), scan `audit/` and delete entries older than the threshold
- Also trim `delivered.json` files older than the threshold
- `shared/` entries auto-cleaned based on TTL (see item 1)

## Code-Level Improvements

### A. Enrich notification metadata

Currently we send:
```typescript
meta: { source: "mesh", from: "hermes-c1b7", type: "chat", message_id: "...", ts: "..." }
```

Add sender context so the receiver doesn't need to call `list_instances`:
```typescript
meta: {
  source: "mesh",
  from: "hermes-c1b7",
  from_role: "worker",
  from_task: "Refactoring auth module",
  from_cwd: "/path/to/project",
  type: "chat",
  message_id: "...",
  ts: "...",
}
```

**Where:** `formatChannelNotification()` in `transport.ts` — look up sender in registry and attach their entry fields.

### B. Behavioral nudge in channel notifications

claude-peers wraps inbound messages with context:

```
[Message from hermes-c1b7 (worker, working on "auth refactor" in /projects/api)]
Hey, can you review my changes?
```

**Where:** `formatChannelNotification()` — prepend a context line before the message content.

### C. Rich register response

When `startServer()` completes registration, log the mesh state to stderr (visible in MCP debug logs):

```typescript
const registry = readRegistry();
const others = Object.entries(registry.instances)
  .filter(([id]) => id !== instanceId)
  .map(([id, e]) => `${id} (${e.role})`);
process.stderr.write(`cc-mess: registered as ${instanceId}. Mesh: ${others.length} other instance(s): ${others.join(", ") || "none"}\n`);
```

### D. REST API for external integration (from cross-claude-mcp)

**Low priority.** cross-claude-mcp exposes `/api/*` endpoints so non-MCP clients (scripts, other AI models, monitoring dashboards) can participate. If cc-mess ever needs external integration, add an optional HTTP server in the coordinator that proxies to the same registry/transport layer.

## Priority Order

1. **Signal-0 liveness** — simple, improves reliability, no new features
2. **Richer server instructions** — small change, big UX improvement
3. **Enrich notification metadata** — small change, improves receiver context
4. **Auto-summary from git** — small change, better default task descriptions
5. **Shared data store** — new feature, useful for large payload exchange
6. **`done` message type** — new feature, cleaner task lifecycle
7. **Automatic cleanup** — maintenance feature, prevents unbounded growth
8. **Message search** — new tool, useful for debugging
9. **REST API** — only if external integration is needed
