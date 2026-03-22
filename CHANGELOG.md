# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- File-based transport layer with atomic writes and inbox polling
- Registry with heartbeat, liveness detection, and dead instance cleanup
- Name generation from pool of ~200 mythological names
- MCP tools: `send`, `broadcast`, `reply`, `list_instances`, `spawn`, `kill`, `update_self`
- Guardrail hook profiles: strict (read-only), permissive (sandbox), custom
- Spawn management with depth limits, capacity checks, and placeholder reaping
- Coordinator failover with atomic role transfer
- Telegram relay event formatting and verbosity control
- Relay config (`relay.json`) for chat_id and verbosity persistence
- Relay events surfaced in MCP tool responses via `cc-mess://relay` resource blocks
- Relay notifications from poll loop via `<cc-mess-relay>` tags (crashes, kill escalations)
- Human reply routing via `relay_to: "telegram"` in reply tool results
- `mesh_control` MCP tool for pause/resume/shutdown_all (coordinator-only)
- `send_as_human` MCP tool for routing Telegram messages to instances (coordinator-only)
- `/mess` command skill for mesh control from Telegram
- Kill escalation timer (30s timeout → SIGTERM with PID verification)
- Dead-instance crash relay (fires once per dead instance, before cleanup)
- Coordinator CLAUDE.md template (`docs/coordinator-claude-md.md`)
- Trust & reputation guidance documentation (`docs/trust-guidance.md`)
- Mesh-wide control (pause/resume/shutdown_all)
- CI/CD workflows for lint, typecheck, test, release, and CodeQL
- Unit and integration test suites
