---
name: mess
description: Control the cc-mess instance mesh. Use when user says /mess or wants to check mesh status, kill/spawn instances, pause/resume the mesh, view logs, or change relay verbosity.
user_invocable: true
arguments: "<subcommand> [args]"
---

Parse `$ARGUMENTS` and execute the matching subcommand:

**`status`** — Call `list_instances` tool. Format as a status report showing each instance's role, task, uptime, capabilities, and paused state.

**`kill <name>`** — Call `kill` tool with target and reason "Requested via /mess".

**`spawn <path> "<task>"`** — Call `spawn` tool with cwd and task.

**`pause`** — Call `mesh_control` tool with action "pause".

**`resume`** — Call `mesh_control` tool with action "resume".

**`shutdown_all`** — Call `mesh_control` tool with action "shutdown_all". This sends shutdown to all workers and returns a confirmation. The coordinator then exits gracefully.

**`logs <name>`** — Read recent messages from the named instance's inbox `processed/` directory. If the instance is dead/exited, also check `audit/<instance-id>/` under `~/.claude/channels/mess/`. Format as timestamped log entries.

**`verbosity <quiet|normal|verbose>`** — Update verbosity in `~/.claude/channels/mess/relay.json` config. Announce the new level.

**No subcommand or unrecognized** — Show usage:
```
/mess status            — Show all live instances
/mess kill <name>       — Shut down an instance
/mess spawn <path> "task" — Spawn a new instance
/mess pause             — Freeze the mesh
/mess resume            — Resume the mesh
/mess shutdown_all      — Shut down all instances
/mess logs <name>       — Show recent messages
/mess verbosity <level> — Set relay verbosity (quiet|normal|verbose)
```
