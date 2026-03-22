import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import { join, dirname } from "node:path";
import type {
  Registry,
  InstanceEntry,
  InstanceRole,
  MeshConfig,
} from "./types.js";
import { allocateName } from "./names.js";

const MESS_DIR = join(
  process.env.HOME ?? "~",
  ".claude",
  "channels",
  "mess",
);
const REGISTRY_PATH = join(MESS_DIR, "registry.json");
const LOCK_PATH = join(MESS_DIR, "registry.lock");
const INBOXES_DIR = join(MESS_DIR, "inboxes");
const AUDIT_DIR = join(MESS_DIR, "audit");
const SPAWNED_DIR = join(MESS_DIR, "spawned");
const CONTROL_PATH = join(MESS_DIR, "control.json");
const CONFIG_PATH = join(MESS_DIR, "config.json");

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_COUNT = 3;
const LOCK_RETRY_DELAY_MS = 50;
const STALE_THRESHOLD_MS = 30_000;
const DEAD_THRESHOLD_MS = 5 * 60_000;
const SPAWNING_PLACEHOLDER_MAX_AGE_MS = 60_000;

export function getMessDir(): string {
  return MESS_DIR;
}

export function getRegistryPath(): string {
  return REGISTRY_PATH;
}

export function getInboxesDir(): string {
  return INBOXES_DIR;
}

export function getAuditDir(): string {
  return AUDIT_DIR;
}

export function getSpawnedDir(): string {
  return SPAWNED_DIR;
}

export function getControlPath(): string {
  return CONTROL_PATH;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function ensureDirectories(): void {
  for (const dir of [
    MESS_DIR,
    INBOXES_DIR,
    AUDIT_DIR,
    SPAWNED_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function atomicWriteJson(
  filePath: string,
  data: unknown,
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

export function acquireLock(): boolean {
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      // Single atomic gate — no existsSync() check first
      const fd = openSync(
        LOCK_PATH,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      writeFileSync(fd, String(process.pid), "utf8");
      closeSync(fd);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Lock exists — check if stale
        try {
          const stat = statSync(LOCK_PATH);
          const age = Date.now() - stat.mtimeMs;
          if (age > LOCK_STALE_MS) {
            // Stale lock — remove and retry immediately
            try {
              unlinkSync(LOCK_PATH);
            } catch {
              // Another process beat us to the unlink — fine
            }
            continue;
          }
        } catch {
          // Lock was removed between our open and stat — retry
          continue;
        }
      }
      sleepSync(LOCK_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return false;
}

export function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Lock already removed — harmless
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait */
  }
}

export function readRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) {
    return { instances: {} };
  }
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return { instances: {} };
  }
}

export function writeRegistry(registry: Registry): void {
  atomicWriteJson(REGISTRY_PATH, registry);
}

export function readConfig(): MeshConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {
      allowed_directories: [],
      max_instances: 10,
      max_spawn_depth: 3,
      require_telegram_relay: true,
      default_guardrail: "permissive",
    };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as MeshConfig;
  } catch {
    return {
      allowed_directories: [],
      max_instances: 10,
      max_spawn_depth: 3,
      require_telegram_relay: true,
      default_guardrail: "permissive",
    };
  }
}

export function registerInstance(
  role: InstanceRole,
  cwd: string,
  task: string,
  capabilities: string[],
  spawnedBy: string | null,
  depth: number,
): string {
  ensureDirectories();
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire registry lock for registration",
    );
  }

  try {
    const registry = readRegistry();
    reapStalePlaceholders(registry);

    const { name, fullId } = allocateName(registry);

    const entry: InstanceEntry = {
      pid: process.pid,
      cwd,
      name,
      role,
      capabilities,
      spawned_by: spawnedBy,
      depth,
      task,
      alive_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      paused: false,
    };

    registry.instances[fullId] = entry;
    writeRegistry(registry);

    const inboxDir = join(INBOXES_DIR, fullId);
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(join(inboxDir, "processed"), { recursive: true });

    return fullId;
  } finally {
    releaseLock();
  }
}

/**
 * Atomic coordinator registration: removes any existing coordinator
 * and registers the new one in a single lock-held operation.
 * Returns the old coordinator ID (if any) so the caller can drain its inbox.
 */
export function registerCoordinator(
  cwd: string,
  task: string,
  capabilities: string[],
  spawnedBy: string | null,
  depth: number,
): { newId: string; oldId: string | null } {
  ensureDirectories();
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire registry lock for coordinator registration",
    );
  }

  try {
    const registry = readRegistry();
    reapStalePlaceholders(registry);

    // Find old coordinator (if any) and demote it — don't delete yet.
    // The old entry stays in the registry so the inbox is preserved
    // for draining. Caller removes it after drain via removeOldCoordinator().
    let oldId: string | null = null;
    for (const [id, entry] of Object.entries(
      registry.instances,
    )) {
      if (entry.role === "coordinator") {
        oldId = id;
        entry.role = "worker";
        entry.status = "draining";
        break;
      }
    }

    // Register new coordinator
    const { name, fullId } = allocateName(registry);

    const entry: InstanceEntry = {
      pid: process.pid,
      cwd,
      name,
      role: "coordinator",
      capabilities,
      spawned_by: spawnedBy,
      depth,
      task,
      alive_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      paused: false,
    };

    registry.instances[fullId] = entry;
    writeRegistry(registry);

    const inboxDir = join(INBOXES_DIR, fullId);
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(join(inboxDir, "processed"), { recursive: true });

    return { newId: fullId, oldId };
  } finally {
    releaseLock();
  }
}

/**
 * Remove a demoted old coordinator entry after its inbox has been drained.
 */
export function removeOldCoordinator(oldId: string): void {
  if (!acquireLock()) {
    return;
  }
  try {
    const registry = readRegistry();
    if (
      registry.instances[oldId]?.status === "draining"
    ) {
      delete registry.instances[oldId];
      writeRegistry(registry);
    }
  } finally {
    releaseLock();
  }
}

export function reserveSpawnSlot(
  parentId: string,
  parentDepth: number,
  cwd: string,
  task: string,
  capabilities: string[],
): string {
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire registry lock for spawn reservation",
    );
  }

  try {
    const registry = readRegistry();
    const config = readConfig();

    reapStalePlaceholders(registry);

    // Count ALL entries including "spawning" placeholders —
    // otherwise two concurrent spawners can both see free capacity
    // and overcommit past the hard cap.
    const totalCount = Object.keys(registry.instances).length;
    if (totalCount >= config.max_instances) {
      throw new Error(
        `Max instances (${config.max_instances}) reached`,
      );
    }

    if (parentDepth + 1 > config.max_spawn_depth) {
      throw new Error(
        `Max spawn depth (${config.max_spawn_depth}) exceeded`,
      );
    }

    const { name, fullId } = allocateName(registry);

    const placeholder: InstanceEntry = {
      pid: 0,
      cwd,
      name,
      role: "worker",
      capabilities,
      spawned_by: parentId,
      depth: parentDepth + 1,
      task,
      alive_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      paused: false,
      status: "spawning",
    };

    registry.instances[fullId] = placeholder;
    writeRegistry(registry);

    const inboxDir = join(INBOXES_DIR, fullId);
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(join(inboxDir, "processed"), { recursive: true });

    return fullId;
  } finally {
    releaseLock();
  }
}

export function finalizeSpawnRegistration(
  fullId: string,
  pid: number,
): void {
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire registry lock for finalization",
    );
  }
  try {
    const registry = readRegistry();
    const entry = registry.instances[fullId];
    if (!entry) {
      throw new Error(
        `No registry entry for ${fullId}`,
      );
    }
    entry.pid = pid;
    entry.alive_at = new Date().toISOString();
    delete entry.status;
    writeRegistry(registry);
  } finally {
    releaseLock();
  }
}

export function removeSpawnPlaceholder(fullId: string): void {
  if (!acquireLock()) {
    return;
  }
  try {
    const registry = readRegistry();
    if (
      registry.instances[fullId]?.status === "spawning"
    ) {
      delete registry.instances[fullId];
      writeRegistry(registry);
    }
  } finally {
    releaseLock();
  }
}

export function heartbeat(fullId: string): void {
  if (!acquireLock()) {
    return;
  }
  try {
    const registry = readRegistry();
    reapStalePlaceholders(registry);
    const entry = registry.instances[fullId];
    if (entry) {
      entry.alive_at = new Date().toISOString();
      writeRegistry(registry);
    }
  } finally {
    releaseLock();
  }
}

export function updateSelf(
  fullId: string,
  updates: Partial<Pick<InstanceEntry, "task" | "capabilities" | "paused">>,
): void {
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire registry lock for self-update",
    );
  }
  try {
    const registry = readRegistry();
    const entry = registry.instances[fullId];
    if (!entry) {
      throw new Error(
        `Instance ${fullId} not in registry`,
      );
    }
    if (updates.task !== undefined) entry.task = updates.task;
    if (updates.capabilities !== undefined) {
      entry.capabilities = updates.capabilities;
    }
    if (updates.paused !== undefined) {
      entry.paused = updates.paused;
    }
    writeRegistry(registry);
  } finally {
    releaseLock();
  }
}

export function deregisterInstance(fullId: string): void {
  const inboxDir = join(INBOXES_DIR, fullId);
  const processedDir = join(inboxDir, "processed");
  const auditDest = join(AUDIT_DIR, fullId);

  if (
    existsSync(processedDir) &&
    existsSync(inboxDir)
  ) {
    // Ensure parent audit dir exists, but NOT auditDest itself —
    // renameSync needs the destination to not exist.
    mkdirSync(AUDIT_DIR, { recursive: true });
    try {
      renameSync(processedDir, auditDest);
    } catch {
      // best-effort audit preservation
    }
  }

  if (!acquireLock()) {
    return;
  }
  try {
    const registry = readRegistry();
    delete registry.instances[fullId];
    writeRegistry(registry);
  } finally {
    releaseLock();
  }
}

export function isStale(entry: InstanceEntry): boolean {
  const age = Date.now() - new Date(entry.alive_at).getTime();
  return age > STALE_THRESHOLD_MS;
}

export function isDead(entry: InstanceEntry): boolean {
  const age = Date.now() - new Date(entry.alive_at).getTime();
  return age > DEAD_THRESHOLD_MS;
}

export function cleanupDeadInstances(
  selfId: string,
): void {
  if (!acquireLock()) {
    return;
  }
  try {
    const registry = readRegistry();
    const toRemove: string[] = [];

    for (const [id, entry] of Object.entries(
      registry.instances,
    )) {
      if (id === selfId) continue;
      if (entry.role === "coordinator") continue;
      if (!isDead(entry)) continue;
      toRemove.push(id);
    }

    for (const id of toRemove) {
      const inboxDir = join(INBOXES_DIR, id);
      const processedDir = join(inboxDir, "processed");
      const auditDest = join(AUDIT_DIR, id);

      if (existsSync(processedDir)) {
        mkdirSync(AUDIT_DIR, { recursive: true });
        try {
          renameSync(processedDir, auditDest);
        } catch {
          // best-effort
        }
      }

      // Remove inbox directory so deliverMessage() can't write
      // to a dead instance's inbox
      try {
        rmSync(inboxDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }

      delete registry.instances[id];
    }

    if (toRemove.length > 0) {
      writeRegistry(registry);
    }
  } finally {
    releaseLock();
  }
}

export function coordinatorFailover(
  newCoordinatorId: string,
): string | null {
  if (!acquireLock()) {
    throw new Error(
      "Failed to acquire lock for coordinator failover",
    );
  }
  try {
    const registry = readRegistry();
    let oldCoordinatorId: string | null = null;

    for (const [id, entry] of Object.entries(
      registry.instances,
    )) {
      if (
        id !== newCoordinatorId &&
        entry.role === "coordinator"
      ) {
        oldCoordinatorId = id;
        delete registry.instances[id];
        break;
      }
    }

    writeRegistry(registry);
    return oldCoordinatorId;
  } finally {
    releaseLock();
  }
}

function reapStalePlaceholders(
  registry: Registry,
): void {
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [id, entry] of Object.entries(
    registry.instances,
  )) {
    if (entry.status !== "spawning") continue;
    const age = now - new Date(entry.started_at).getTime();
    if (age > SPAWNING_PLACEHOLDER_MAX_AGE_MS) {
      toRemove.push(id);
    }
  }

  for (const id of toRemove) {
    delete registry.instances[id];
  }
}
