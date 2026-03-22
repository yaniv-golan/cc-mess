# cc-mess: Inter-Claude-Code Communication Plugin

**Date:** 2026-03-22
**Status:** Design approved, pending implementation

## Overview

cc-mess is a Claude Code plugin that enables multiple Claude Code instances to discover each other, communicate, delegate tasks, share insights, and develop emergent trust relationships. It uses a file-based transport layer and a symmetric peer architecture with a soft coordinator role.

The human observes and controls the mesh via the existing cc-telegram-plus plugin.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Symmetric peers with soft coordinator role | Enables emergent behavior, peer trust, direct communication. Coordinator is first-among-equals, not a gatekeeper. |
| Transport | File-based message queues | Crash-resilient, debuggable (`ls` the queue), consistent with cc-telegram-plus patterns |
| Coordinator | Live Claude Code session | Can reason about routing, make intelligent broadcast decisions, understand context |
| Worker permissions | `--dangerously-skip-permissions` with hook guardrails | Fast autonomous operation with policy enforcement at the hook layer |
| Plugin relationship | Separate plugin from cc-telegram-plus | Clean separation. Coordinator runs both; workers run only cc-mess. |
| Human visibility | Visibility via Telegram when coordinator is alive; degraded (but recoverable) if coordinator crashes | Human sees everything important while relay is up. Workers continue autonomously during coordinator downtime; visibility resumes on restart. |
| Instance identity | Humanoid names + unique hex suffix | Memorable, readable in logs, unambiguous |
| Trust model | Per-instance, emergent, private (stored in Claude memory) | No central authority on trust. Instances learn from experience. |

## 1. File-Based Transport Layer

All state lives under `~/.claude/channels/mess/`.

### Directory Structure

```
~/.claude/channels/mess/
├── registry.json              # All known instances
├── control.json               # Mesh-wide state (paused/running)
├── config.json                # Mesh-wide config (guardrails, limits)
├── inboxes/
│   ├── apollo-3f2a/           # Instance inbox
│   │   ├── 1711100000000-hermes-c1b7-task-a3b2c1d4.json
│   │   ├── 1711100000001-athena-9d4e-broadcast-e5f6a7b8.json
│   │   └── processed/        # Delivered messages (audit trail)
│   └── hermes-c1b7/
│       └── ...
├── spawned/                   # Spawn requests and results
│   └── ...
└── audit/                     # Preserved message trails from dead/exited instances
    └── hermes-c1b7/           # Moved from inboxes/hermes-c1b7/processed/ on cleanup
        └── ...
```

### Message Format

Each file in an inbox:

```json
{
  "id": "msg-uuid",
  "from": "hermes-c1b7",
  "to": "apollo-3f2a",
  "type": "task|review|chat|result|insight|announcement|broadcast|control",
  "timestamp": "2026-03-22T14:30:00Z",
  "subject": "Review my auth refactor plan",
  "body": "I'm planning to split auth.ts into...",
  "in_reply_to": "msg-uuid-of-original",
  "priority": "normal|high|low"
}
```

### Control Message Format

Messages with `type: "control"` use a structured payload instead of free-form `subject`/`body`:

```json
{
  "id": "msg-uuid",
  "from": "apollo-3f2a",
  "to": "hermes-c1b7",
  "type": "control",
  "timestamp": "2026-03-22T14:30:00Z",
  "action": "shutdown|pause|resume|shutdown_all",
  "reason": "Task complete",
  "in_reply_to": null,
  "priority": "high"
}
```

Valid `action` values:
- **`shutdown`** — Graceful exit request for a specific instance (used by `kill` tool)
- **`pause`** — Freeze the target (or all instances if broadcast). Equivalent to `control.json` state change but delivered per-instance.
- **`resume`** — Resume after pause
- **`shutdown_all`** — Graceful exit for every instance in the mesh

Control messages always have `priority: "high"` and are always delivered immediately, even when the mesh is paused (see Mesh-Wide Control). The `action` field is required and validated — unknown actions are logged and ignored.

### Message Authentication

Identity is enforced **server-side** — there is no shared secret or token exchange.

- The `from` field is set by the transport layer, not trusted from the JSON body. For MCP tool calls (`send`, `broadcast`, `reply`), the MCP server already knows the calling instance's identity — `from` is set server-side, not by the caller.
- The filename convention (`{timestamp}-{from_id}-{type}.json`) also encodes the sender, but the authoritative `from` is the one set by the server at write time.
- `control.json` writes are restricted: only the coordinator instance can write `control.json`. Workers read it but never write it. This is enforced by the coordinator's plugin at the file-write level.

This doesn't defend against a compromised local process with filesystem access (nothing can, given the file-based transport), but it prevents bugs where one instance accidentally sends messages as another.

### Filename Convention

`{timestamp_ms}-{from_id}-{type}-{msg_id_short}.json` — sortable by time, scannable by sender/type, collision-free. `{msg_id_short}` is the first 8 characters of the message UUID, which prevents overwrites when the same sender emits two same-type messages in the same millisecond.

### Atomic Writes

All shared files (`registry.json`, `control.json`) and inbox messages use **atomic write via temp-file-then-rename**:

1. Write to a temporary file in the same directory (e.g., `registry.json.tmp.{pid}`)
2. `fs.renameSync()` (POSIX `rename(2)`) the temp file to the target path

This guarantees readers never see a partial write. On macOS/Linux, `rename` within the same filesystem is atomic.

**Registry concurrency:** Despite each instance only touching its own key, the whole-file read/modify/write cycle means two concurrent writers can clobber each other's changes. All `registry.json` writes therefore use a lockfile:

1. Acquire `registry.lock` (created atomically via `O_CREAT|O_EXCL`)
2. Read current `registry.json`
3. Update your key (or remove a dead instance's key)
4. Atomic-write the full file back (temp + rename)
5. Release the lock (delete `registry.lock`)

Lock hygiene:
- Lock is held for <100ms (read + JSON parse + write + rename)
- If `registry.lock` exists and is older than 5 seconds, it's stale (owner crashed) — any instance may delete it and retry
- If lock acquisition fails after 3 retries (50ms backoff), skip this heartbeat cycle — the next one is 3 seconds away

**Name allocation** uses the same lockfile to prevent double-assignment: lock → read registry → pick a name not currently in use → write registry → unlock. Names are allocated from the pool based solely on current registry occupancy — when an instance dies and its entry is removed, its name returns to the pool for reuse.

### Polling

- Each instance's MCP plugin polls its inbox directory every 2-3 seconds
- Delivery is **at-least-once** with persistent deduplication:
  1. Poll: list files in inbox (excluding `processed/`)
  2. For each message file, check if its `id` is in the `delivered.json` set (kept in the instance's inbox directory)
  3. If not seen: deliver as `notifications/claude/channel`, append `id` to `delivered.json` (atomic write)
  4. Move file to `processed/` subfolder
- If the instance crashes between step 3 (deliver) and step 4 (move), the message remains in the inbox but `delivered.json` already records the `id`, so it won't be re-delivered on restart
- `delivered.json` is a simple JSON array of message IDs. It's instance-local (no concurrency concerns) and can be periodically trimmed to the last 1000 entries
- Messages are NOT deleted — they form an audit trail in `processed/`

### Liveness

- Each instance updates `alive_at` in `registry.json` on every poll cycle (~3s)
- Stale after 30 seconds of no heartbeat
- Dead after 5 minutes — any instance can remove the registry entry and delete the inbox's pending messages. The `processed/` subfolder is **moved** to a shared audit directory (`~/.claude/channels/mess/audit/{instance-id}/`) before the inbox is removed, preserving the message trail for `/mess logs` and late reply lookups.
- **Exception: coordinator inboxes are never cleaned up by workers.** Only a new coordinator can claim and drain a dead coordinator's inbox (see Coordinator Failover). Workers skip cleanup for any entry with `role: "coordinator"`. This prevents message loss during the window between coordinator crash and restart.
- On graceful shutdown: instance moves its own `processed/` to the audit directory and removes its registry entry

### Mesh-Wide Control

`control.json` governs mesh-wide state:

```json
{
  "state": "running|paused",
  "since": "2026-03-22T15:00:00Z",
  "by": "human"
}
```

When paused:
- Inbox polling continues (so instances see the resume signal)
- **Control-type messages** (`type: "control"`) are always delivered, even when paused — this includes `shutdown`, `resume`, and other control actions. Without this, a `kill` sent during pause would be silently deferred.
- All other message types are queued but not delivered to Claude until resume
- No new spawns allowed
- Each instance writes `"paused": true` to its registry entry
- Instances finish their current tool call, then idle

Control actions: `pause`, `resume`, `shutdown_all`.

Every instance checks `control.json` on each poll cycle. All instances see state changes within ~3 seconds.

## 2. Registry & Identity

### Instance Identity

Each instance gets a human-friendly name from a pool of ~200 mythological/historical names, plus a 4-character hex suffix for uniqueness:

```
apollo-3f2a
hermes-c1b7
athena-9d4e
prometheus-7a21
```

The full ID (name + suffix) is the canonical identifier. The short name is used in casual communication and resolves via registry lookup.

### Registry File

`registry.json`:

```json
{
  "instances": {
    "apollo-3f2a": {
      "pid": 12345,
      "cwd": "/Users/yaniv/projects/api-server",
      "name": "apollo",
      "role": "coordinator",
      "capabilities": ["spawn", "broadcast", "review", "telegram-relay"],
      "spawned_by": null,
      "depth": 0,
      "task": "Coordinating mesh, monitoring project health",
      "alive_at": "2026-03-22T14:30:02Z",
      "started_at": "2026-03-22T14:00:00Z",
      "paused": false
    },
    "hermes-c1b7": {
      "pid": 12350,
      "cwd": "/Users/yaniv/projects/frontend",
      "name": "hermes",
      "role": "worker",
      "capabilities": ["review", "implement"],
      "spawned_by": "apollo-3f2a",
      "depth": 1,
      "task": "Refactoring auth components",
      "alive_at": "2026-03-22T14:30:01Z",
      "started_at": "2026-03-22T14:25:00Z",
      "paused": false
    }
  }
}
```

### Key Fields

- **`task`** — Free-text description of current work. Updated by the instance itself. Others read this for context before messaging.
- **`capabilities`** — Self-declared. Instances add/remove as they learn what they're good at. Used for routing decisions.
- **`spawned_by`** — Lineage tracking. Useful for trust (parent-child default trust) and cleanup (orphan detection).
- **`depth`** — Immutable spawn depth, set at creation time: coordinator is 0, its direct children are 1, etc. Computed as `parent.depth + 1` at spawn time and never changes. This avoids needing to walk the `spawned_by` chain (which breaks when ancestors are cleaned up after death). Spawn requests are rejected if `depth + 1 > max_spawn_depth` (i.e., with `max_spawn_depth: 3`, the chain coordinator(0) → A(1) → B(2) → C(3) is allowed, but C cannot spawn further).
- **`role`** — `"coordinator"` or `"worker"`. The coordinator is whichever instance was started by the human and has the Telegram plugin. Not a hard architectural distinction — just a tag.

### Name Generation

Ship a list of ~200 names (Greek/Roman gods, titans, muses, heroes). Pick randomly from names not currently in the registry. If a name collision occurs (same random pick), regenerate. If all 200 are taken, the mesh is too large anyway (max_instances config should prevent this).

## 3. MCP Tools & Message Types

### Tool Surface

| Tool | Purpose |
|------|---------|
| `send` | Send a message to a specific instance by name |
| `broadcast` | Send a message to all instances (or filtered subset) |
| `reply` | Reply to a received message (threads via `in_reply_to`) |
| `list_instances` | Show the current registry — who's alive, what they're doing |
| `spawn` | Launch a new Claude Code instance with a task |
| `kill` | Ask an instance to gracefully shut down |
| `update_self` | Update own registry entry (task, capabilities) |

### `send`

```
send(to: "hermes", type: "task|review|chat|result|insight",
     subject: "...", body: "...")
```

- `to` can be the short name ("hermes") — resolves to full ID via registry
- Errors if ambiguous (multiple instances with same base name)
- Message types and their semantics:
  - **`task`** — "Do this thing and report back"
  - **`review`** — "Look at this and give me feedback"
  - **`chat`** — Open-ended, no specific expectation
  - **`result`** — Response to a task (includes success/failure)
  - **`insight`** — "I learned something you might care about"

### `broadcast`

```
broadcast(type: "insight|announcement", subject: "...", body: "...",
          filter?: { capabilities?: [...], role?: "...", exclude?: [...] })
```

- Drops a message in every matching instance's inbox
- Filter allows targeting (e.g., only instances with "review" capability)
- Always excludes self

### `spawn`

```
spawn(cwd: "/path/to/project", task: "Refactor the auth module",
      claude_md?: "Additional instructions...",
      capabilities?: ["implement", "review"],
      hooks?: "strict|permissive|custom")
```

- Launches via `child_process.spawn()` with an argv array — never shell interpolation:
  ```ts
  spawn("claude", ["--dangerously-skip-permissions", "-p", task, "--cwd", cwd], { shell: false })
  ```
  This eliminates quoting/injection risk from arbitrary `task` or `cwd` strings.
- For long prompts that exceed argv limits (~256KB on macOS), write the task to a temp file and pass `--prompt-file` instead
- Injects cc-mess plugin so the new instance joins the mesh automatically
- `claude_md` gets appended as additional context for the spawned instance
- `hooks` selects a guardrail profile (see Section 4)
- Returns the new instance's name and ID once it registers
- Validates `cwd` against `config.json` `allowed_directories`
- **Atomic admission:** Spawn capacity is checked and reserved under the registry lockfile in a single operation:
  1. Acquire `registry.lock`
  2. Read `registry.json`, count live instances, check `depth + 1 <= max_spawn_depth`
  3. If within limits: allocate name, write a placeholder entry with `"status": "spawning"` to the registry
  4. Release lock
  5. Launch the process
  6. On successful registration, the spawned instance replaces the placeholder with its full entry
  7. If the process fails to register within 30s, the spawner removes the placeholder under lock

  **Orphaned placeholder reaping:** If the spawner itself dies before cleaning up, `"status": "spawning"` entries become orphaned. Any instance performing a registry write (e.g., during heartbeat) can reap spawning placeholders older than 60 seconds (based on `started_at` in the placeholder entry). This uses the same lockfile as all registry writes.

  This prevents two concurrent spawners from both observing free capacity and over-committing.

### `kill`

```
kill(target: "hermes", reason: "Task complete")
```

- Sends a `control` type message with `action: "shutdown"` to the target's inbox
- Target's plugin triggers graceful exit on receipt
- If target doesn't exit within 30s, caller can escalate via SIGTERM, but only after verifying the PID still belongs to the expected process. Check both conditions:
  1. `ps -p {pid} -o command=` contains `claude`
  2. Process start time matches `started_at` from the registry (use `ps -p {pid} -o lstart=` on macOS)

  PID + start time is a unique process identifier — PID alone is not, since the OS can reuse PIDs even for other `claude` sessions. If either check fails, skip the signal but **do not remove the registry entry** — the original process may still be running under a different PID (e.g., it re-execed). Instead, mark the entry as `"status": "orphaned"` and relay the situation to the human via Telegram. The human can then investigate and either manually kill the process or clear the entry via `/mess kill --force`.

### `reply`

```
reply(message_id: "msg-uuid", body: "...")
```

- `message_id` is required — the original message is looked up to auto-fill `to` (original sender) and `in_reply_to`
- **Human reply routing:** If the original message has `from: "human"`, `reply()` routes the response to the current coordinator's inbox (looked up via `role: "coordinator"` in the registry) with a `"relay_to": "telegram"` flag. The coordinator then forwards it to Telegram. This means replies to human messages always work regardless of coordinator restarts — they target the role, not a specific instance ID.
- `type` is automatically set: `result` when replying to a `task`, otherwise inherits the original message's type
- If the original sender is dead (not in registry), the reply is still written to their inbox directory — no error. If the inbox directory has been cleaned up (dead >5 min), returns an error.
- No deep threading — `in_reply_to` always points to the message being replied to, not a thread root

### Inbound Message Delivery

When the plugin polls and finds a new message, it delivers to Claude Code as a channel notification:

```xml
<channel source="mesh" from="apollo-3f2a" type="task"
  message_id="msg-uuid" ts="2026-03-22T14:30:00Z">
Review my plan for splitting the auth module. I'm thinking
of extracting token validation into its own service...
</channel>
```

Claude Code then decides what to do — respond, ignore, act on it, save to memory, etc.

## 4. Trust, Reputation & Guardrails

### Trust Model

Trust is **per-instance, emergent, and private**. Each instance maintains its own trust map in Claude Code's memory system. No central trust authority.

Trust is informed by observable signals:

| Signal | Positive | Negative |
|--------|----------|----------|
| Task completion | Delivered a result that worked | Result caused test failures, needed rework |
| Review quality | Caught real issues, actionable suggestions | Nitpicky noise, missed real bugs, wrong advice |
| Responsiveness | Quick replies, stays alive | Goes silent, crashes frequently |
| Self-awareness | Accurate capabilities, declines tasks outside expertise | Claims capabilities it doesn't have |
| Broadcast value | Insights that led to useful action | Spam, irrelevant noise |

Trust drives behavior organically:
- "Hermes has given me bad review feedback twice. I'll ask Athena next time."
- "Prometheus always delivers clean code. I'll give it the harder tasks."
- "This broadcast is from a new instance I don't know yet — I'll verify before acting."

No instance can see how others rate it.

**Trust scope:** Trust is keyed to the **full instance ID** (e.g., `hermes-c1b7`), not the short name. Since names are recycled from the pool, a future `hermes-a4f9` is a completely different instance and inherits no trust from a previous `hermes-c1b7`. The coordinator should store trust observations against the full ID in its memory. Workers are ephemeral — spawned for a task and killed when done — so they don't accumulate long-term trust. The coordinator is the long-lived instance that builds trust over time via Claude Code's memory system (which persists across restarts even though the coordinator's own instance ID changes).

### Guardrail Hook Profiles

Spawned instances run with `--dangerously-skip-permissions` but hooks enforce policy at the **tool level**, not just Bash commands. Every Claude Code tool call passes through the guardrail hook.

**Three built-in profiles:**

**`strict`** — Read-only operations:

| Tool | Policy |
|------|--------|
| `Read`, `Glob`, `Grep` | Allow within cwd (canonicalized via `realpath`, symlinks resolved) |
| `Bash` | Allow only: `ls`, `cat`, `head`, `tail`, `git log`, `git diff`, `git status`, `git show`, `git blame` |
| `Write`, `Edit` | Block |
| `WebFetch`, `WebSearch` | Block |
| `send`, `broadcast`, `reply` (mesh tools) | Allow — but `broadcast` limited to `type: "insight"` only |
| `spawn` | Block |

Use case: review tasks, code analysis.

**`permissive`** — Full development within sandbox:

| Tool | Policy |
|------|--------|
| `Read`, `Glob`, `Grep` | Allow within cwd |
| `Write`, `Edit` | Allow within cwd (canonicalized path must start with cwd after `realpath`) |
| `Bash` | Allow within cwd; block commands that leave cwd (`cd /other`, absolute paths outside cwd). `git commit` allowed, `git push` blocked. |
| `WebFetch`, `WebSearch` | Block except package registries (`registry.npmjs.org`, `pypi.org`) |
| `send`, `broadcast`, `reply` (mesh tools) | Allow |
| `spawn` | Allow (subject to depth/count limits) |

Use case: implementation tasks.

**`custom`** — Inline rules:
- Coordinator specifies exact tool-level policies at spawn time
- Maximum flexibility for specialized tasks

**Path canonicalization:** All path-based checks resolve symlinks and relative components via `realpath` before comparison. A write to `../../etc/passwd` or a symlink pointing outside cwd is blocked.

**Mesh tools as exfiltration surface:** In `strict` mode, an instance can still send data to other instances via `send`/`reply`. This is by design (review instances need to report results), but `broadcast` is restricted to prevent a strict instance from spraying data across the mesh.

The `guardrail.sh` script reads tool input JSON from stdin (tool name + parameters), checks against the active profile's tool-level policy, and exits 0 (allow) or 2 (block with message).

### Mesh-Wide Config

`config.json`:

```json
{
  "allowed_directories": [
    "/Users/yaniv/projects/*",
    "/Users/yaniv/Documents/code/*"
  ],
  "max_instances": 10,
  "max_spawn_depth": 3,
  "require_telegram_relay": true,
  "default_guardrail": "permissive"
}
```

- **`allowed_directories`** — Glob patterns for valid spawn locations. Prevents spawning in sensitive directories.
- **`max_instances`** — Hard cap on total mesh size. Prevents runaway spawning.
- **`max_spawn_depth`** — Maximum spawn chain depth (coordinator → A → B → C = depth 3). Prevents infinite recursion.
- **`require_telegram_relay`** — At least one instance must have the Telegram plugin active. If the relay dies, no new spawns until a relay is back.

### Coordinator Failover

The coordinator is a single point of failure for Telegram relay, human-to-instance routing, and `/mess` commands. This is **intentionally accepted** — there is no automatic role transfer.

Recovery path:
- If the coordinator crashes, workers continue operating independently (they have their own inboxes and can communicate peer-to-peer)
- The human restarts the coordinator manually, or uses a watchdog process (e.g., a shell loop, `launchd` service, or `systemd` unit) to auto-restart it
- On restart, the new coordinator performs an **atomic role transfer** under the registry lock:
  1. Acquire `registry.lock`
  2. Scan for any previous coordinator entries (dead or orphaned)
  3. **Remove the old coordinator's registry entry** (so there is never more than one `role: "coordinator"` at a time)
  4. Register itself with a fresh ID and `role: "coordinator"`
  5. Release lock
  6. **Drain the old coordinator's inbox** — process any pending messages (results, replies, relay-tagged messages) that were addressed to the old ID. The inbox is preserved (not cleaned up by workers — see Liveness exception) specifically to enable this.
  7. Move the old coordinator's `processed/` to `audit/` and delete the old inbox
  8. Discover existing workers via the registry and resume relay duties
- This guarantees that role lookup for `"coordinator"` always returns exactly one entry — no ambiguity window.
- Workers that used `reply()` with `relay_to: "telegram"` target the coordinator role, not a specific ID, so replies to human messages are not stranded (see `reply` tool)
- `config.json`'s `require_telegram_relay` prevents new spawns while no relay is active, ensuring the human isn't locked out of visibility into new work

Automatic coordinator election is out of scope. The complexity isn't justified for a single-user, single-machine system.

## 5. Telegram Integration & Human Visibility

Only the coordinator runs the Telegram plugin (see Design Decisions: "Coordinator runs both; workers run only cc-mess"). The coordinator is the sole relay for mesh activity to the human.

### Auto-Relayed Events

| Event | Telegram message |
|-------|-----------------|
| Instance spawned | `apollo spawned hermes in /projects/frontend — "Refactor auth components"` |
| Instance exited | `hermes exited — task complete` |
| Instance crashed | `hermes crashed (no heartbeat)` |
| Broadcast sent | `athena → all: "Found a shared config bug affecting API keys"` |
| Task delegated | `apollo → hermes: task "Review auth plan"` |
| Task completed | `hermes → apollo: result "Auth plan looks good, 2 suggestions"` |
| Guardrail blocked | `hermes tried to write outside cwd — blocked` |
| Spawn limit hit | `prometheus tried to spawn (depth 3/3) — denied` |

### Not Relayed (Too Noisy)

- Individual chat messages between instances
- Heartbeat updates
- Routine inbox polling
- Trust assessments

### Human-to-Instance Messaging

From Telegram, the human addresses a specific instance:

```
@hermes how's the auth refactor going?
```

The coordinator parses the `@name` prefix, routes to that instance's inbox as type `chat` with `from: "human"`. Response flows back through the coordinator to Telegram.

**Human identity:** `from: "human"` is not a forgeable identity — only the coordinator can write messages with this sender, and the coordinator is the sole Telegram relay. Workers cannot set `from: "human"` because `from` is set server-side by the MCP transport layer (see Message Authentication). Human messages are coordinator-mediated operations, not a separate authentication path.

### Telegram Commands

| Command | Effect |
|---------|--------|
| `/mess status` | Show all live instances, tasks, uptime |
| `/mess kill hermes` | Send shutdown to hermes |
| `/mess spawn /path "task"` | Spawn a new instance |
| `/mess pause` | Freeze entire mesh |
| `/mess resume` | Resume mesh |
| `/mess shutdown_all` | Graceful shutdown of all instances |
| `/mess logs hermes` | Show recent messages to/from hermes |
| `/mess verbosity quiet\|normal\|verbose` | Control relay noise level |

### Verbosity Levels

- **`quiet`** — Only errors, crashes, guardrail blocks
- **`normal`** (default) — Spawns, exits, tasks, results, broadcasts
- **`verbose`** — Everything including inter-instance chat

## 6. Repository & Project Structure

### Full Directory Layout

```
cc-mess/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                # Lint, typecheck, test on every push/PR
│   │   ├── release.yml           # Publish to npm on version tag
│   │   └── codeql.yml            # Security scanning (weekly + on PR)
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml        # Structured bug report form
│   │   └── feature_request.yml   # Feature request form
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── CODEOWNERS
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── src/
│   ├── server.ts              # MCP server entry point
│   ├── types.ts               # Shared types
│   ├── registry.ts            # Register, heartbeat, discover, cleanup dead
│   ├── transport.ts           # Inbox polling, message delivery, control.json
│   ├── tools.ts               # MCP tool handlers (send, broadcast, spawn, etc.)
│   ├── spawn.ts               # Launch claude processes, inject plugin, apply hooks
│   ├── guardrails.ts          # Generate hook configs from profiles
│   ├── names.ts               # Name generation (pool of ~200 humanoid names)
│   └── telegram-relay.ts      # Format mesh events for Telegram channel
├── tests/
│   ├── unit/                  # Fast, isolated tests per module
│   │   ├── registry.test.ts
│   │   ├── transport.test.ts
│   │   ├── names.test.ts
│   │   └── guardrails.test.ts
│   └── integration/           # Multi-instance, file-system-level tests
│       ├── mesh-lifecycle.test.ts
│       ├── concurrent-spawn.test.ts
│       └── coordinator-failover.test.ts
├── hooks/
│   ├── hooks.json             # Mesh activity tracking hooks
│   ├── guardrail.sh           # Policy enforcement for spawned instances
│   └── profiles/
│       ├── strict.json
│       ├── permissive.json
│       └── custom-template.json
├── skills/
│   ├── status/SKILL.md        # /mess:status
│   └── configure/SKILL.md     # /mess:configure
├── LICENSE                    # MIT
├── README.md                  # Overview, install, quick start, architecture diagram
├── CONTRIBUTING.md            # Dev setup, coding standards, PR process
├── CHANGELOG.md               # Keep-a-changelog format
├── SECURITY.md                # Vulnerability reporting process
├── CODE_OF_CONDUCT.md         # Contributor Covenant
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .gitignore
├── .nvmrc                     # Pin Node.js version (>=20)
└── .editorconfig
```

### Package Configuration

`package.json` key fields:

```json
{
  "name": "cc-mess",
  "version": "0.1.0",
  "description": "Inter-Claude-Code communication plugin — mesh networking for multiple Claude Code instances",
  "license": "MIT",
  "author": "Yaniv Golan",
  "repository": "yaniv-golan/cc-mess",
  "keywords": ["claude-code", "plugin", "mesh", "mcp", "multi-agent"],
  "engines": { "node": ">=20" },
  "type": "module",
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "files": ["dist/", "hooks/", "skills/", ".claude-plugin/", ".mcp.json"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ tests/",
    "lint:fix": "eslint src/ tests/ --fix",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "prepublishOnly": "npm run build"
  }
}
```

### TypeScript Configuration

Strict mode, ESM output:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### CI/CD

#### `ci.yml` — Runs on every push and PR

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v4
        if: matrix.node-version == 22
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
```

#### `release.yml` — Publishes to npm on version tags

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run test
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

#### `codeql.yml` — Security scanning

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am UTC

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: typescript
      - uses: github/codeql-action/analyze@v3
```

### GitHub Configuration

**Branch protection on `main`:**
- Require PR reviews (1 reviewer)
- Require CI status checks to pass
- Require up-to-date branches before merge
- No force pushes

**`CODEOWNERS`:**
```
* @yaniv-golan
```

**PR template** (`PULL_REQUEST_TEMPLATE.md`):
```markdown
## What

<!-- One sentence describing the change -->

## Why

<!-- Motivation / issue link -->

## How

<!-- Implementation approach, if non-obvious -->

## Test plan

- [ ] Unit tests pass
- [ ] Integration tests pass (if applicable)
- [ ] Manual testing done (describe)
```

### Versioning & Changelog

- Follows [Semantic Versioning](https://semver.org/)
- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) format
- Pre-1.0: breaking changes bump minor, fixes bump patch
- Releases are cut by tagging `vX.Y.Z` on `main` — CI handles the rest

### Testing Strategy

| Layer | Tool | What it covers |
|-------|------|----------------|
| Unit | Vitest | Individual modules in isolation — registry logic, name generation, message validation, guardrail matching, path canonicalization |
| Integration | Vitest | Multi-instance scenarios using real filesystem — concurrent registry writes, inbox polling, spawn lifecycle, coordinator failover, lock contention |
| Linting | ESLint | Code quality, consistent style, no-unused-vars, import ordering |
| Type checking | `tsc --noEmit` | Full strict TypeScript validation |
| Security | CodeQL | Automated vulnerability scanning on PRs and weekly |
| Coverage | Vitest + Codecov | Track coverage per PR, enforce no regression |

Key integration test scenarios (derived from review findings):
- Two instances spawning concurrently with only 1 slot remaining
- Kill escalation when PID verification fails
- Coordinator crash → restart → inbox drain
- Lock contention under 10 concurrent heartbeat writers
- Message delivery dedup after simulated crash

### Documentation

- **README.md** — Overview, installation (`npm install cc-mess`), quick start (3-step setup), architecture diagram (mermaid), configuration reference, link to design doc
- **CONTRIBUTING.md** — Prerequisites (Node 20+, Claude Code), dev setup (`npm install && npm run dev`), coding standards (strict TS, no `any`, prefer named exports), PR process, commit message format
- **SECURITY.md** — Report vulnerabilities via GitHub Security Advisories, not public issues. Response SLA: acknowledge within 48 hours.
- **CHANGELOG.md** — Maintained per release, auto-linked from GitHub Releases
- **CODE_OF_CONDUCT.md** — Contributor Covenant v2.1

## 7. Sub-Project Build Order

| # | Sub-project | Delivers | Depends on |
|---|-------------|----------|------------|
| 1 | Transport & Registry | File-based messaging, inbox polling, registry, heartbeat, control.json, name generation | Nothing |
| 2 | MCP Server & Tools | Plugin shell, `send`, `reply`, `broadcast`, `list_instances`, `update_self` tools, channel notifications | SP-1 |
| 3 | Spawn & Guardrails | `spawn`, `kill` tools, guardrail hook profiles, spawn depth enforcement, allowed directories | SP-2 |
| 4 | Telegram Relay | Mesh event formatting, `/mess` commands, verbosity control, human-to-instance messaging | SP-3 + cc-telegram-plus |
| 5 | Trust & Reputation | Documentation and CLAUDE.md patterns for how instances should use memory for trust signals | SP-2 |

Each sub-project follows its own spec → plan → implement → test cycle.
