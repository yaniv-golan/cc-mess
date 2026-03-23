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
        action: "allow",
        conditions: {
          allowed_hosts: PACKAGE_REGISTRIES,
        },
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
  _cwd: string,
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
  const cwdEscaped = JSON.stringify(cwd);

  return `#!/usr/bin/env bash
set -euo pipefail

PROFILE='${profileJson.replace(/'/g, "'\\''")}'
CWD=${cwdEscaped}

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .name // ""')
PARAMS=$(echo "$INPUT" | jq -c '.tool_input // .parameters // {}')

check_path_within_cwd() {
  local target="$1"
  local resolved
  resolved=$(cd "$CWD" && realpath -m "$target" 2>/dev/null || echo "$target")
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

exit 0
`;
}
