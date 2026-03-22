# /mess:status

Show all live instances in the mesh, their tasks, uptime, and capabilities.

## Usage

Run the `list_instances` MCP tool to retrieve the current registry. Format the output as a status report showing:

- Instance ID and role (coordinator/worker)
- Current task
- Working directory
- Uptime since `started_at`
- Capabilities
- Whether the instance is paused

## Example Output

```
**Mesh Status**

• **apollo-3f2a** (coordinator) — ✅ alive
  Task: Coordinating mesh, monitoring project health
  CWD: /Users/yaniv/projects/api-server
  Uptime: 1h 30m
  Capabilities: spawn, broadcast, review, telegram-relay

• **hermes-c1b7** (worker) — ✅ alive
  Task: Refactoring auth components
  CWD: /Users/yaniv/projects/frontend
  Uptime: 5m 12s
  Capabilities: review, implement
```
