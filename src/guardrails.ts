import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GuardrailProfile } from "./types.js";

export interface ToolPolicy {
  tool: string;
  action: "allow" | "block";
  conditions?: Record<string, unknown>;
  message?: string;
}

export interface GuardrailProfileConfig {
  name: GuardrailProfile;
  description: string;
  policies: ToolPolicy[];
}

const STRICT_READ_COMMANDS = new Set([
  "ls", "cat", "head", "tail",
  "git log", "git diff", "git status",
  "git show", "git blame",
]);

export function createStrictProfile(
  cwd: string,
): GuardrailProfileConfig {
  return {
    name: "strict",
    description: "Read-only operations",
    policies: [
      {
        tool: "Read",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Glob",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Grep",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Bash",
        action: "allow",
        conditions: {
          allowed_commands: Array.from(STRICT_READ_COMMANDS),
        },
      },
      {
        tool: "Write",
        action: "block",
        message: "Write blocked in strict mode",
      },
      {
        tool: "Edit",
        action: "block",
        message: "Edit blocked in strict mode",
      },
      {
        tool: "WebFetch",
        action: "block",
        message: "WebFetch blocked in strict mode",
      },
      {
        tool: "WebSearch",
        action: "block",
        message: "WebSearch blocked in strict mode",
      },
      {
        tool: "send",
        action: "allow",
      },
      {
        tool: "reply",
        action: "allow",
      },
      {
        tool: "broadcast",
        action: "allow",
        conditions: {
          allowed_types: ["insight"],
        },
      },
      {
        tool: "spawn",
        action: "block",
        message: "Spawn blocked in strict mode",
      },
    ],
  };
}

const PACKAGE_REGISTRIES = [
  "registry.npmjs.org",
  "pypi.org",
];

export function createPermissiveProfile(
  cwd: string,
): GuardrailProfileConfig {
  return {
    name: "permissive",
    description: "Full development within sandbox",
    policies: [
      {
        tool: "Read",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Glob",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Grep",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Write",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Edit",
        action: "allow",
        conditions: { within_cwd: cwd },
      },
      {
        tool: "Bash",
        action: "allow",
        conditions: {
          within_cwd: cwd,
          blocked_commands: ["git push"],
        },
      },
      {
        tool: "WebFetch",
        action: "allow",
        conditions: {
          allowed_hosts: PACKAGE_REGISTRIES,
        },
      },
      {
        tool: "WebSearch",
        action: "block",
        message: "WebSearch blocked in permissive mode — use WebFetch for package registries",
      },
      {
        tool: "send",
        action: "allow",
      },
      {
        tool: "reply",
        action: "allow",
      },
      {
        tool: "broadcast",
        action: "allow",
      },
      {
        tool: "spawn",
        action: "allow",
      },
    ],
  };
}

export function createCustomProfile(
  policies: ToolPolicy[],
): GuardrailProfileConfig {
  return {
    name: "custom",
    description: "Custom inline rules",
    policies,
  };
}

export function getProfile(
  profile: GuardrailProfile,
  cwd: string,
  customPolicies?: ToolPolicy[],
): GuardrailProfileConfig {
  switch (profile) {
    case "strict":
      return createStrictProfile(cwd);
    case "permissive":
      return createPermissiveProfile(cwd);
    case "custom":
      return createCustomProfile(customPolicies ?? []);
  }
}

export function isPathWithinCwd(
  targetPath: string,
  cwd: string,
): boolean {
  try {
    const resolved = resolve(cwd, targetPath);
    let canonical: string;
    try {
      canonical = realpathSync(resolved);
    } catch {
      canonical = resolved;
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
    } catch {
      canonicalCwd = cwd;
    }

    return (
      canonical === canonicalCwd ||
      canonical.startsWith(canonicalCwd + "/")
    );
  } catch {
    return false;
  }
}

export function checkBashCommand(
  command: string,
  profile: GuardrailProfileConfig,
  cwd: string,
): { allowed: boolean; message?: string } {
  const bashPolicy = profile.policies.find(
    (p) => p.tool === "Bash",
  );
  if (!bashPolicy) {
    return {
      allowed: false,
      message: "No Bash policy defined",
    };
  }
  if (bashPolicy.action === "block") {
    return {
      allowed: false,
      message: bashPolicy.message ?? "Bash blocked",
    };
  }

  const conditions = bashPolicy.conditions ?? {};

  if (conditions.allowed_commands) {
    const allowed = conditions.allowed_commands as string[];
    const trimmed = command.trim();
    const isAllowed = allowed.some(
      (cmd) =>
        trimmed === cmd || trimmed.startsWith(cmd + " "),
    );
    if (!isAllowed) {
      return {
        allowed: false,
        message: `Command not in allowlist: ${trimmed.split(" ")[0]}`,
      };
    }
  }

  if (conditions.blocked_commands) {
    const blocked = conditions.blocked_commands as string[];
    const trimmed = command.trim();
    const isBlocked = blocked.some(
      (cmd) =>
        trimmed === cmd || trimmed.startsWith(cmd + " "),
    );
    if (isBlocked) {
      return {
        allowed: false,
        message: `Command blocked: ${trimmed.split(" ")[0]}`,
      };
    }
  }

  // Enforce within_cwd for permissive profile: block commands
  // that reference absolute paths outside cwd or use cd to escape.
  if (conditions.within_cwd) {
    const trimmed = command.trim();

    // Block "cd /absolute/path" that leaves cwd
    const cdMatch = trimmed.match(/\bcd\s+(\S+)/);
    if (cdMatch) {
      const cdTarget = cdMatch[1];
      if (
        cdTarget.startsWith("/") &&
        !isPathWithinCwd(cdTarget, cwd)
      ) {
        return {
          allowed: false,
          message: `cd target outside cwd: ${cdTarget}`,
        };
      }
    }

    // Block absolute paths outside cwd in the command
    const absPathMatches = trimmed.match(
      /(?:^|\s)(\/\S+)/g,
    );
    if (absPathMatches) {
      for (const match of absPathMatches) {
        const absPath = match.trim();
        if (!isPathWithinCwd(absPath, cwd)) {
          return {
            allowed: false,
            message: `Absolute path outside cwd: ${absPath}`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

export function checkToolAccess(
  toolName: string,
  params: Record<string, unknown>,
  profile: GuardrailProfileConfig,
  cwd: string,
): { allowed: boolean; message?: string } {
  const policy = profile.policies.find(
    (p) => p.tool === toolName,
  );

  if (!policy) {
    return {
      allowed: false,
      message: `No policy for tool: ${toolName}`,
    };
  }

  if (policy.action === "block") {
    return {
      allowed: false,
      message: policy.message ?? `${toolName} blocked`,
    };
  }

  const conditions = policy.conditions ?? {};

  if (conditions.within_cwd && toolName === "Bash") {
    const command = (params.command as string) ?? "";
    return checkBashCommand(command, profile, cwd);
  }

  if (conditions.within_cwd) {
    const pathParam =
      (params.path as string) ??
      (params.file_path as string) ??
      "";
    if (pathParam && !isPathWithinCwd(pathParam, cwd)) {
      return {
        allowed: false,
        message: `Path outside cwd: ${pathParam}`,
      };
    }
  }

  if (conditions.allowed_types) {
    const allowed = conditions.allowed_types as string[];
    const msgType = params.type as string | undefined;
    if (msgType && !allowed.includes(msgType)) {
      return {
        allowed: false,
        message: `Type "${msgType}" not allowed`,
      };
    }
  }

  if (conditions.allowed_hosts) {
    const allowed = conditions.allowed_hosts as string[];
    const url = (params.url as string) ?? "";
    const isAllowed = allowed.some((host) =>
      url.includes(host),
    );
    if (url && !isAllowed) {
      return {
        allowed: false,
        message: `Host not in allowlist: ${url}`,
      };
    }
  }

  return { allowed: true };
}

export function generateGuardrailScript(
  profile: GuardrailProfileConfig,
  cwd: string,
): string {
  const profileJson = JSON.stringify(profile);
  const cwdEscaped = cwd.replace(/'/g, "'\\''");

  return `#!/usr/bin/env bash
set -euo pipefail

PROFILE='${profileJson.replace(/'/g, "'\\''")}'
CWD='${cwdEscaped}'

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .name // ""')
PARAMS=$(echo "$INPUT" | jq -c '.tool_input // .parameters // {}')

check_path_within_cwd() {
  local target="$1"
  local resolved
  resolved=$(cd "$CWD" && python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$target" 2>/dev/null || cd "$CWD" && echo "$(pwd)/$target")
  local real_cwd
  real_cwd=$(realpath "$CWD")
  case "$resolved" in
    "$real_cwd"|"$real_cwd/"*) return 0 ;;
    *) return 1 ;;
  esac
}

POLICY=$(echo "$PROFILE" | jq -r --arg tool "$TOOL_NAME" \\
  '.policies[] | select(.tool == $tool)')

if [ -z "$POLICY" ]; then
  echo "No policy for tool: $TOOL_NAME" >&2
  exit 2
fi

ACTION=$(echo "$POLICY" | jq -r '.action')
if [ "$ACTION" = "block" ]; then
  MSG=$(echo "$POLICY" | jq -r '.message // "Blocked"')
  echo "$MSG" >&2
  exit 2
fi

# Enforce conditions for allowed policies
CONDITIONS=$(echo "$POLICY" | jq -c '.conditions // {}')

# Check within_cwd for path-based tools
WITHIN_CWD=$(echo "$CONDITIONS" | jq -r '.within_cwd // empty')
if [ -n "$WITHIN_CWD" ]; then
  if [ "$TOOL_NAME" = "Bash" ]; then
    # Bash: check allowed_commands / blocked_commands
    COMMAND=$(echo "$PARAMS" | jq -r '.command // ""')

    ALLOWED_COUNT=$(echo "$CONDITIONS" | jq -r '.allowed_commands | length // 0')
    if [ "$ALLOWED_COUNT" -gt 0 ] 2>/dev/null; then
      TRIMMED=$(echo "$COMMAND" | sed 's/^[[:space:]]*//')
      MATCH=false
      while IFS= read -r cmd; do
        case "$TRIMMED" in
          "$cmd"|"$cmd "*) MATCH=true; break ;;
        esac
      done < <(echo "$CONDITIONS" | jq -r '.allowed_commands[]')
      if [ "$MATCH" = "false" ]; then
        echo "Command not in allowlist: $TRIMMED" >&2
        exit 2
      fi
    fi

    BLOCKED_COUNT=$(echo "$CONDITIONS" | jq -r '.blocked_commands | length // 0')
    if [ "$BLOCKED_COUNT" -gt 0 ] 2>/dev/null; then
      TRIMMED=$(echo "$COMMAND" | sed 's/^[[:space:]]*//')
      while IFS= read -r cmd; do
        case "$TRIMMED" in
          "$cmd"|"$cmd "*) echo "Command blocked: $cmd" >&2; exit 2 ;;
        esac
      done < <(echo "$CONDITIONS" | jq -r '.blocked_commands[]')
    fi

    # Block cd to absolute paths outside cwd
    CD_TARGET=$(echo "$COMMAND" | grep -oP '\\bcd\\s+\\K/\\S+' || true)
    if [ -n "$CD_TARGET" ]; then
      if ! check_path_within_cwd "$CD_TARGET"; then
        echo "cd target outside cwd: $CD_TARGET" >&2
        exit 2
      fi
    fi

    # Block absolute paths outside cwd anywhere in the command
    for abs_path in $(echo "$COMMAND" | grep -oP '(?:^|\\s)\\K/\\S+' || true); do
      if ! check_path_within_cwd "$abs_path"; then
        echo "Absolute path outside cwd: $abs_path" >&2
        exit 2
      fi
    done
  else
    # Path-based tools: check file_path/path is within cwd
    TARGET=$(echo "$PARAMS" | jq -r '.file_path // .path // ""')
    if [ -n "$TARGET" ]; then
      if ! check_path_within_cwd "$TARGET"; then
        echo "Path outside cwd: $TARGET" >&2
        exit 2
      fi
    fi
  fi
fi

# Check allowed_types (e.g., broadcast type restrictions)
ALLOWED_TYPES=$(echo "$CONDITIONS" | jq -r '.allowed_types // empty')
if [ -n "$ALLOWED_TYPES" ]; then
  MSG_TYPE=$(echo "$PARAMS" | jq -r '.type // ""')
  if [ -n "$MSG_TYPE" ]; then
    TYPE_OK=false
    for t in $(echo "$CONDITIONS" | jq -r '.allowed_types[]'); do
      if [ "$MSG_TYPE" = "$t" ]; then TYPE_OK=true; break; fi
    done
    if [ "$TYPE_OK" = "false" ]; then
      echo "Type \\"$MSG_TYPE\\" not allowed" >&2
      exit 2
    fi
  fi
fi

# Check allowed_hosts (e.g., WebFetch URL restrictions)
ALLOWED_HOSTS=$(echo "$CONDITIONS" | jq -r '.allowed_hosts // empty')
if [ -n "$ALLOWED_HOSTS" ]; then
  URL=$(echo "$PARAMS" | jq -r '.url // ""')
  if [ -n "$URL" ]; then
    HOST_OK=false
    for h in $(echo "$CONDITIONS" | jq -r '.allowed_hosts[]'); do
      case "$URL" in
        *"$h"*) HOST_OK=true; break ;;
      esac
    done
    if [ "$HOST_OK" = "false" ]; then
      echo "Host not in allowlist: $URL" >&2
      exit 2
    fi
  fi
fi

exit 0
`;
}
