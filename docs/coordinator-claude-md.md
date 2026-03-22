# cc-mess Coordinator Instructions

Add these instructions to your project's CLAUDE.md when running as the mesh coordinator.

---

## Mesh Messages

You will receive mesh messages as channel notifications from cc-mess. These appear in the conversation as inbound messages with `source: "mesh"` metadata. Read them and act accordingly — they may be tasks, results, reviews, chat, or control messages from other instances.

## Relay Events to Telegram

When a cc-mess tool response contains a `cc-mess://relay` resource block, forward its text content to Telegram:

```
reply(chat_id: "<chat_id>", text: "<relay text>")
```

Read `chat_id` from `~/.claude/channels/mess/relay.json`.

Relay events cover: instance spawns, exits, crashes, task delegation, task completion, guardrail blocks, and spawn limit hits.

## Human Reply Routing

When a `reply` tool result contains `"relay_to": "telegram"`, forward `reply_body` to Telegram:

```
reply(chat_id: "<chat_id>", text: "<reply_body>")
```

This is how worker responses to human messages get back to Telegram.

Also watch for inbound mesh messages with `relay_to: "telegram"` in their metadata — these are worker replies to human messages routed through your inbox. Forward the message body to Telegram.

## Human-to-Instance Messaging

When you receive a Telegram message starting with `@<name>`:
1. Parse the instance name after `@`
2. Call `send_as_human(to: "<name>", body: "<message>")`

This sets `from: "human"` so the worker's `reply()` correctly routes back to Telegram.

## /mess Commands

When you see `/mess <subcommand>` from Telegram, use the `/mess` skill to handle it.

Available subcommands: status, kill, spawn, pause, resume, shutdown_all, logs, verbosity.

## Trust

Record trust observations about workers in your Claude Code memory, keyed to the full instance ID (e.g., `hermes-c1b7`). See `docs/trust-guidance.md` for guidance on what signals to track and how to act on them.
