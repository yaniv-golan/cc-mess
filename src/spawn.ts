import {
  spawn as cpSpawn,
  type ChildProcess,
} from "node:child_process";
import {
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import type {
  SpawnOptions,
  MeshConfig,
  GuardrailProfile,
} from "./types.js";
import {
  readRegistry,
  readConfig,
  reserveSpawnSlot,
  finalizeSpawnRegistration,
  removeSpawnPlaceholder,
  getSpawnedDir,
  ensureDirectories,
} from "./registry.js";
import {
  getProfile,
  generateGuardrailScript,
} from "./guardrails.js";

const ARGV_MAX_LENGTH = 256_000;

export interface SpawnResult {
  fullId: string;
  name: string;
  pid: number;
  process: ChildProcess;
}

export function validateSpawnCwd(
  cwd: string,
  config: MeshConfig,
): boolean {
  if (config.allowed_directories.length === 0) {
    return true;
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(resolve(cwd));
  } catch {
    canonicalCwd = resolve(cwd);
  }

  for (const pattern of config.allowed_directories) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      let canonicalBase: string;
      try {
        canonicalBase = realpathSync(resolve(base));
      } catch {
        canonicalBase = resolve(base);
      }
      if (
        canonicalCwd === canonicalBase ||
        canonicalCwd.startsWith(canonicalBase + "/")
      ) {
        return true;
      }
    } else {
      let canonicalPattern: string;
      try {
        canonicalPattern = realpathSync(resolve(pattern));
      } catch {
        canonicalPattern = resolve(pattern);
      }
      if (canonicalCwd === canonicalPattern) {
        return true;
      }
    }
  }

  return false;
}

export function checkTelegramRelay(
  config: MeshConfig,
): boolean {
  if (!config.require_telegram_relay) {
    return true;
  }
  const registry = readRegistry();
  for (const entry of Object.values(
    registry.instances,
  )) {
    if (
      entry.capabilities.includes("telegram-relay") &&
      entry.status !== "spawning"
    ) {
      return true;
    }
  }
  return false;
}

export function buildSpawnArgs(
  task: string,
  cwd: string,
  claudeMd?: string,
): string[] {
  let prompt = task;
  if (claudeMd) {
    prompt += `\n\n${claudeMd}`;
  }

  if (prompt.length > ARGV_MAX_LENGTH) {
    ensureDirectories();
    const tmpFile = join(
      getSpawnedDir(),
      `prompt-${Date.now()}-${process.pid}.txt`,
    );
    writeFileSync(tmpFile, prompt, "utf8");
    return [
      "--dangerously-skip-permissions",
      "--prompt-file",
      tmpFile,
      "--cwd",
      cwd,
    ];
  }

  return [
    "--dangerously-skip-permissions",
    "-p",
    prompt,
    "--cwd",
    cwd,
  ];
}

export function setupGuardrailHook(
  profile: GuardrailProfile,
  cwd: string,
): string | null {
  const profileConfig = getProfile(profile, cwd);
  const script = generateGuardrailScript(
    profileConfig,
    cwd,
  );

  ensureDirectories();
  const hookPath = join(
    getSpawnedDir(),
    `guardrail-${Date.now()}-${process.pid}.sh`,
  );
  writeFileSync(hookPath, script, { mode: 0o755 });
  return hookPath;
}

export async function spawnInstance(
  parentId: string,
  parentDepth: number,
  options: SpawnOptions,
): Promise<SpawnResult> {
  const config = readConfig();

  if (!validateSpawnCwd(options.cwd, config)) {
    throw new Error(
      `Directory not allowed: ${options.cwd}`,
    );
  }

  if (!checkTelegramRelay(config)) {
    throw new Error(
      "No Telegram relay active — spawning blocked " +
        "by require_telegram_relay policy",
    );
  }

  const profile =
    options.hooks ?? config.default_guardrail;
  const capabilities = options.capabilities ?? [
    "implement",
    "review",
  ];

  const fullId = reserveSpawnSlot(
    parentId,
    parentDepth,
    options.cwd,
    options.task,
    capabilities,
  );

  try {
    const args = buildSpawnArgs(
      options.task,
      options.cwd,
      options.claude_md,
    );

    const hookPath = setupGuardrailHook(
      profile,
      options.cwd,
    );

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CC_MESS_INSTANCE_ID: fullId,
      CC_MESS_PARENT_ID: parentId,
      CC_MESS_DEPTH: String(parentDepth + 1),
    };
    if (hookPath) {
      env.CC_MESS_GUARDRAIL_HOOK = hookPath;
    }

    const child = cpSpawn("claude", args, {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd: options.cwd,
      env,
    });

    child.unref();

    if (!child.pid) {
      throw new Error("Failed to spawn claude process");
    }

    finalizeSpawnRegistration(fullId, child.pid);

    const registry = readRegistry();
    const entry = registry.instances[fullId];

    return {
      fullId,
      name: entry?.name ?? fullId,
      pid: child.pid,
      process: child,
    };
  } catch (error) {
    removeSpawnPlaceholder(fullId);
    throw error;
  }
}

export function verifyProcessAlive(
  pid: number,
  _startedAt: string,
): boolean {
  try {
    const result = execSync(
      `ps -p ${pid} -o command=`,
      { encoding: "utf8" },
    ).trim();
    return result.includes("claude");
  } catch {
    return false;
  }
}

export function sendSignalToProcess(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
