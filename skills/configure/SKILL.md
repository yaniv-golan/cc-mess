# /mess:configure

Configure mesh-wide settings by editing `~/.claude/channels/mess/config.json`.

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allowed_directories` | `string[]` | `[]` | Glob patterns for valid spawn locations |
| `max_instances` | `number` | `10` | Hard cap on total mesh size |
| `max_spawn_depth` | `number` | `3` | Maximum spawn chain depth |
| `require_telegram_relay` | `boolean` | `true` | Require Telegram relay for spawning |
| `default_guardrail` | `string` | `"permissive"` | Default guardrail profile for spawned instances |

## Example

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

## Notes

- Changes take effect on the next poll cycle (~3 seconds)
- Only the coordinator should modify config.json
- `allowed_directories` supports trailing `/*` for recursive matching
