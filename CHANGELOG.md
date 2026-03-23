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
- Mesh-wide control (pause/resume/shutdown_all)
- CI/CD workflows for lint, typecheck, test, release, and CodeQL
- Unit and integration test suites
