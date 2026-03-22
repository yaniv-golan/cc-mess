#!/usr/bin/env node

/**
 * cc-mess tmux dashboard
 *
 * Creates a tmux session with:
 *   - Right pane (40%): conversation viewer in follow mode
 *   - Top-left pane: interactive claude coordinator session
 *   - Worker panes: created by spawn.ts via CC_MESS_TMUX_SESSION env var
 *
 * Usage:
 *   npx tsx src/dashboard.ts [--no-telegram] [--clean]
 *   npm run dashboard -- --no-telegram --clean
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MeshConfig } from "./types.js";

// ── Constants ────────────────────────────────────────────────

const SESSION_NAME = "cc-mess-dashboard";
const POLL_INTERVAL_MS = 2000;

const MESS_DIR = join(
  process.env.HOME ?? "~",
  ".claude",
  "channels",
  "mess",
);
const REGISTRY_PATH = join(MESS_DIR, "registry.json");
const CONFIG_PATH = join(MESS_DIR, "config.json");

// Resolve the viewer script path relative to this file
const VIEWER_SCRIPT = resolve(
  new URL(".", import.meta.url).pathname,
  "viewer.ts",
);

// ── Tmux helper ──────────────────────────────────────────────

function tmux(...args: string[]): string {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(
      `tmux command failed: tmux ${args.join(" ")}\n${stderr}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function tmuxSafe(...args: string[]): string | null {
  try {
    return tmux(...args);
  } catch {
    return null;
  }
}

function sessionExists(): boolean {
  return tmuxSafe("has-session", "-t", SESSION_NAME) !== null;
}

// ── Watcher ──────────────────────────────────────────────────
// Spawn.ts creates worker panes directly via CC_MESS_TMUX_SESSION.
// The watcher just monitors the session and exits when it dies.

function startWatcher(): void {
  setInterval(() => {
    if (!sessionExists()) {
      process.exit(0);
    }
  }, POLL_INTERVAL_MS);

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

// ── Session creation ─────────────────────────────────────────

function createSession(): void {
  tmux("new-session", "-d", "-s", SESSION_NAME, "-x", "200", "-y", "50");

  const coordinatorPaneId = tmux(
    "display-message", "-t", `${SESSION_NAME}:0`, "-p", "#{pane_id}",
  );

  // Split right for the viewer (40%)
  const viewerPaneId = tmux(
    "split-window",
    "-h",
    "-t", coordinatorPaneId,
    "-l", "40%",
    "-P", "-F", "#{pane_id}",
    `npx tsx ${VIEWER_SCRIPT} --follow`,
  );

  // Set pane titles
  tmuxSafe("select-pane", "-t", coordinatorPaneId, "-T", "coordinator");
  tmuxSafe("select-pane", "-t", viewerPaneId, "-T", "conversation");

  // Set the tmux session env var so spawned workers get real TTYs in tmux panes
  tmux(
    "send-keys",
    "-t", coordinatorPaneId,
    `export CC_MESS_TMUX_SESSION=${SESSION_NAME}`,
    "Enter",
  );

  // Start claude in the coordinator pane with channel notifications enabled
  tmux(
    "send-keys",
    "-t", coordinatorPaneId,
    "claude --dangerously-load-development-channels server:cc-mess",
    "Enter",
  );

  // Focus on the coordinator pane
  tmuxSafe("select-pane", "-t", coordinatorPaneId);
}

// ── Config helpers ───────────────────────────────────────────

const DEFAULT_CONFIG: MeshConfig = {
  allowed_directories: [],
  max_instances: 10,
  max_spawn_depth: 3,
  require_telegram_relay: false,
  default_guardrail: "permissive",
};

function disableTelegramRelay(): void {
  mkdirSync(MESS_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log("Created config with require_telegram_relay=false");
    return;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as MeshConfig;
    if (!config.require_telegram_relay) {
      console.log("Telegram relay requirement already disabled.");
      return;
    }
    config.require_telegram_relay = false;
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log("Disabled require_telegram_relay in mesh config.");
  } catch {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log("Reset config with require_telegram_relay=false");
  }
}

function checkTmux(): void {
  try {
    execSync("which tmux", { stdio: "pipe" });
  } catch {
    console.error("Error: tmux is not installed or not in PATH.");
    console.error("Install it with: brew install tmux");
    process.exit(1);
  }
}

function cleanMeshState(): void {
  if (existsSync(REGISTRY_PATH)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify({ instances: {} }, null, 2));
  }

  const inboxesDir = join(MESS_DIR, "inboxes");
  if (existsSync(inboxesDir)) {
    for (const entry of readdirSync(inboxesDir)) {
      rmSync(join(inboxesDir, entry), { recursive: true, force: true });
    }
  }

  const auditDir = join(MESS_DIR, "audit");
  if (existsSync(auditDir)) {
    for (const entry of readdirSync(auditDir)) {
      rmSync(join(auditDir, entry), { recursive: true, force: true });
    }
  }

  const controlPath = join(MESS_DIR, "control.json");
  if (existsSync(controlPath)) {
    rmSync(controlPath);
  }

  console.log("Cleared mesh state (registry, inboxes, audit, control).");
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes("--watcher")) {
    startWatcher();
    return;
  }

  checkTmux();

  if (process.argv.includes("--no-telegram")) {
    disableTelegramRelay();
  }

  if (process.argv.includes("--clean")) {
    if (sessionExists()) {
      tmuxSafe("kill-session", "-t", SESSION_NAME);
      console.log("Killed existing dashboard session.");
    }
    cleanMeshState();
  }

  if (sessionExists()) {
    console.log(`Session "${SESSION_NAME}" already exists. Attaching...`);
    try {
      execSync(`tmux attach-session -t ${SESSION_NAME}`, { stdio: "inherit" });
    } catch {
      // User detached
    }
    process.exit(0);
  }

  console.log("Creating cc-mess dashboard...");
  createSession();

  // Run the watcher in a hidden tmux window
  const thisScript = new URL(import.meta.url).pathname;
  tmux(
    "new-window", "-t", `${SESSION_NAME}`, "-d",
    "-n", "watcher",
    `npx tsx ${thisScript} --watcher`,
  );
  tmuxSafe("select-window", "-t", `${SESSION_NAME}:0`);

  try {
    execSync(`tmux attach-session -t ${SESSION_NAME}`, { stdio: "inherit" });
  } catch {
    // User detached or session died
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
