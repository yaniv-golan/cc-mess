#!/usr/bin/env bash
set -euo pipefail

# cc-mess guardrail hook — reads tool input JSON from stdin,
# checks against the active profile's tool-level policy,
# exits 0 (allow) or 2 (block with message).

PROFILE_PATH="${CC_MESS_GUARDRAIL_PROFILE:-}"
CWD="${CC_MESS_CWD:-$(pwd)}"

if [ -z "$PROFILE_PATH" ] || [ ! -f "$PROFILE_PATH" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .name // ""')

if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

POLICY=$(jq -r --arg tool "$TOOL_NAME" \
  '.policies[] | select(.tool == $tool)' "$PROFILE_PATH")

if [ -z "$POLICY" ]; then
  echo "No policy for tool: $TOOL_NAME" >&2
  exit 2
fi

ACTION=$(echo "$POLICY" | jq -r '.action')

if [ "$ACTION" = "block" ]; then
  MSG=$(echo "$POLICY" | jq -r '.message // "Blocked by guardrail policy"')
  echo "$MSG" >&2
  exit 2
fi

if [ "$ACTION" = "allow" ]; then
  WITHIN_CWD=$(echo "$POLICY" | jq -r '.conditions.within_cwd // empty')
  if [ -n "$WITHIN_CWD" ] && [ "$WITHIN_CWD" != "null" ]; then
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.path // .parameters.path // .tool_input.file_path // ""')
    if [ -n "$FILE_PATH" ]; then
      RESOLVED=$(cd "$CWD" && realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
      REAL_CWD=$(realpath "$CWD")
      case "$RESOLVED" in
        "$REAL_CWD"|"$REAL_CWD/"*)
          ;;
        *)
          echo "Path outside allowed directory: $FILE_PATH" >&2
          exit 2
          ;;
      esac
    fi
  fi

  ALLOWED_CMDS=$(echo "$POLICY" | jq -r '.conditions.allowed_commands // empty')
  if [ -n "$ALLOWED_CMDS" ] && [ "$ALLOWED_CMDS" != "null" ]; then
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // .parameters.command // ""')
    if [ -n "$CMD" ]; then
      MATCH=false
      while IFS= read -r allowed; do
        case "$CMD" in
          "$allowed"|"$allowed "*)
            MATCH=true
            break
            ;;
        esac
      done < <(echo "$ALLOWED_CMDS" | jq -r '.[]')
      if [ "$MATCH" = "false" ]; then
        echo "Command not allowed: $CMD" >&2
        exit 2
      fi
    fi
  fi

  BLOCKED_CMDS=$(echo "$POLICY" | jq -r '.conditions.blocked_commands // empty')
  if [ -n "$BLOCKED_CMDS" ] && [ "$BLOCKED_CMDS" != "null" ]; then
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // .parameters.command // ""')
    if [ -n "$CMD" ]; then
      while IFS= read -r blocked; do
        case "$CMD" in
          "$blocked"|"$blocked "*)
            echo "Command blocked: $CMD" >&2
            exit 2
            ;;
        esac
      done < <(echo "$BLOCKED_CMDS" | jq -r '.[]')
    fi
  fi
fi

exit 0
