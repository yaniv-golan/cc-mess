import {
  spawn as cpSpawn,
  type ChildProcess,
} from "node:child_process";
import {
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
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
  isStale,
} from "./registry.js";
import { readMeshControl } from "./transport.js";
import {
  getProfile,
  generateGuardrailScript,
} from "./guardrails.js";

const ARGV_MAX_LENGTH = 256_000;

/**
 * Resolve the cc-mess plugin root directory.
 * This is the directory containing .claude-plugin/plugin.json.
 */
export function getPluginRoot(): string {
  // import.meta.url points to dist/spawn.js; plugin root is one level up
  const distDir = new URL(".", import.meta.url).pathname;
  return resolve(distDir, "..");
}

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
      entry.status !== "spawning" &&
      !isStale(entry)
    ) {
      return true;
    }
  }
  return false;
}

export function buildSpawnArgs(
  task: string,
  _cwd: string,
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
    ];
  }

  // Use positional prompt (interactive mode), not -p (print mode which exits after response)
  return [
    "--dangerously-skip-permissions",
    prompt,
  ];
}

export function setupGuardrailHook(
  profile: GuardrailProfile,
  cwd: string,
  customPolicies?: SpawnOptions["custom_policies"],
): string | null {
  const profileConfig = getProfile(profile, cwd, customPolicies as import("./guardrails.js").ToolPolicy[]);
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

  // Check mesh pause state — no new spawns when paused
  const control = readMeshControl();
  if (control.state === "paused") {
    throw new Error(
      "Mesh is paused — spawning blocked",
    );
  }

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
      options.custom_policies,
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

    // The spawned child picks up cc-mess MCP server from .mcp.json
    // in its cwd — no extra flags needed.

    const tmuxSession = process.env.CC_MESS_TMUX_SESSION;

    let child: ChildProcess;
    let pid: number;

    if (tmuxSession) {
      // Dashboard mode: spawn inside a tmux pane so the instance gets a real TTY.
      // Write a startup script to avoid shell quoting issues.
      ensureDirectories();
      const scriptPath = join(
        getSpawnedDir(),
        `tmux-spawn-${Date.now()}-${process.pid}.sh`,
      );
      const scriptLines = [
        "#!/usr/bin/env bash",
        `cd '${options.cwd.replace(/'/g, "'\\''")}'`,
        `export CC_MESS_INSTANCE_ID='${fullId}'`,
        `export CC_MESS_PARENT_ID='${parentId}'`,
        `export CC_MESS_DEPTH='${parentDepth + 1}'`,
        `export CC_MESS_TMUX_SESSION='${tmuxSession}'`,
        ...(hookPath ? [`export CC_MESS_GUARDRAIL_HOOK='${hookPath}'`] : []),
        `exec claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} --dangerously-load-development-channels server:cc-mess`,
      ];
      writeFileSync(scriptPath, scriptLines.join("\n"), { mode: 0o755 });

      // Count existing panes in window 0 to decide split direction.
      // Panes: coordinator (top-left), viewer (right), plus any workers.
      // First worker splits vertically below coordinator; subsequent workers
      // split horizontally from existing workers to share the bottom row.
      const paneCountResult = spawnSync("tmux", [
        "list-panes", "-t", `${tmuxSession}:0`, "-F", "#{pane_id}",
      ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const existingPanes = (paneCountResult.stdout ?? "").trim().split("\n").filter(Boolean);
      // 2 panes = coordinator + viewer (no workers yet) → split vertical
      // 3+ panes = workers exist → split horizontal from last worker pane
      const workerCount = existingPanes.length - 2; // subtract coordinator + viewer
      const direction = workerCount <= 0 ? "-v" : "-h";

      const tmuxResult = spawnSync("tmux", [
        "split-window",
        "-t", `${tmuxSession}:0`,
        direction,
        "-P", "-F", "#{pane_id}",
        scriptPath,
      ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

      if (tmuxResult.status !== 0) {
        throw new Error(`tmux split-window failed: ${tmuxResult.stderr?.trim()}`);
      }
      const paneId = tmuxResult.stdout.trim();

      // Get the PID of the process in the new pane
      const pidResult = spawnSync("tmux", [
        "display-message", "-t", paneId, "-p", "#{pane_pid}",
      ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

      pid = parseInt(pidResult.stdout?.trim() ?? "", 10);
      if (isNaN(pid)) {
        throw new Error("Failed to get PID from tmux pane");
      }

      // Wait 2 seconds to confirm it's alive
      await new Promise<void>((resolveP) => setTimeout(resolveP, 2000));

      // Check pane still exists
      const checkResult = spawnSync("tmux", [
        "display-message", "-t", paneId, "-p", "",
      ], { stdio: "pipe" });
      if (checkResult.status !== 0) {
        throw new Error("Spawned process exited immediately (tmux pane died)");
      }
    } else {
      // Headless mode: spawn detached (original behavior)
      child = cpSpawn("claude", args, {
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

      pid = child.pid;

      // Don't finalize immediately — wait briefly to confirm the
      // process actually started (didn't exit with error on launch).
      await new Promise<void>((resolveP, rejectP) => {
        let settled = false;
        const onExit = (code: number | null) => {
          if (!settled) {
            settled = true;
            rejectP(
              new Error(
                `Spawned process exited immediately with code ${code}`,
              ),
            );
          }
        };
        child.once("exit", onExit);

        // Give it 2 seconds to prove it's alive
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.removeListener("exit", onExit);
            resolveP();
          }
        }, 2000);
      });
    }

    finalizeSpawnRegistration(fullId, pid);

    // Set up background cleanup for headless mode: if the child dies later,
    // remove its registry entry after 30s grace period.
    // In tmux mode, the pane manages the process lifecycle.
    if (!tmuxSession && child!) {
      child!.once("exit", () => {
        setTimeout(() => {
          removeSpawnPlaceholder(fullId);
        }, 30_000);
      });
    }

    const registry = readRegistry();
    const entry = registry.instances[fullId];

    return {
      fullId,
      name: entry?.name ?? fullId,
      pid,
      process: child!,
    };
  } catch (error) {
    removeSpawnPlaceholder(fullId);
    throw error;
  }
}

export function verifyProcessAlive(
  pid: number,
  startedAt: string,
): boolean {
  try {
    // Check 1: command name contains "claude"
    const command = execSync(
      `ps -p ${pid} -o command=`,
      { encoding: "utf8" },
    ).trim();
    if (!command.includes("claude")) {
      return false;
    }

    // Check 2: process start time matches registry's started_at
    const lstart = execSync(
      `ps -p ${pid} -o lstart=`,
      { encoding: "utf8" },
    ).trim();
    if (!lstart) {
      return false;
    }
    const psStartTime = new Date(lstart).getTime();
    const registryStartTime = new Date(startedAt).getTime();
    // Allow 2 second tolerance for clock skew between
    // Date.now() and ps lstart reporting
    return Math.abs(psStartTime - registryStartTime) < 2000;
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
