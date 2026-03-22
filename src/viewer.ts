#!/usr/bin/env node

/**
 * cc-mess conversation viewer
 *
 * Reads all messages from inboxes (pending + processed) and audit directories,
 * resolves instance names, and renders a colored scrolling chat timeline.
 *
 * Usage:
 *   npx tsx src/viewer.ts              # show all messages
 *   npx tsx src/viewer.ts --follow     # live-tail new messages
 *   npx tsx src/viewer.ts --last 20    # show last 20 messages
 *   npx tsx src/viewer.ts --type task  # filter by message type
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Message,
  ControlMessage,
  Registry,
} from "./types.js";

// ── ANSI colors ──────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const INSTANCE_COLORS = [
  "\x1b[38;5;204m", // pink
  "\x1b[38;5;114m", // green
  "\x1b[38;5;75m",  // blue
  "\x1b[38;5;220m", // yellow
  "\x1b[38;5;183m", // lavender
  "\x1b[38;5;209m", // orange
  "\x1b[38;5;80m",  // cyan
  "\x1b[38;5;168m", // magenta
  "\x1b[38;5;149m", // lime
  "\x1b[38;5;111m", // sky
  "\x1b[38;5;217m", // salmon
  "\x1b[38;5;156m", // mint
  "\x1b[38;5;141m", // purple
  "\x1b[38;5;216m", // peach
  "\x1b[38;5;122m", // teal
  "\x1b[38;5;176m", // orchid
];

const TYPE_BADGES: Record<string, string> = {
  task:         "\x1b[48;5;24m\x1b[38;5;15m TASK \x1b[0m",
  result:       "\x1b[48;5;22m\x1b[38;5;15m RESULT \x1b[0m",
  review:       "\x1b[48;5;130m\x1b[38;5;15m REVIEW \x1b[0m",
  chat:         "\x1b[48;5;240m\x1b[38;5;15m CHAT \x1b[0m",
  broadcast:    "\x1b[48;5;91m\x1b[38;5;15m BROADCAST \x1b[0m",
  announcement: "\x1b[48;5;55m\x1b[38;5;15m ANNOUNCE \x1b[0m",
  insight:      "\x1b[48;5;58m\x1b[38;5;15m INSIGHT \x1b[0m",
  control:      "\x1b[48;5;124m\x1b[38;5;15m CONTROL \x1b[0m",
};

// ── Paths ────────────────────────────────────────────────────

const MESS_DIR = join(
  process.env.HOME ?? "~",
  ".claude",
  "channels",
  "mess",
);
const INBOXES_DIR = join(MESS_DIR, "inboxes");
const AUDIT_DIR = join(MESS_DIR, "audit");
const REGISTRY_PATH = join(MESS_DIR, "registry.json");

// ── Name resolution ──────────────────────────────────────────

interface NameMap {
  idToName: Map<string, string>;
  colorMap: Map<string, string>;
}

function buildNameMap(): NameMap {
  const idToName = new Map<string, string>();
  const colorMap = new Map<string, string>();
  let colorIdx = 0;

  // Read current registry
  if (existsSync(REGISTRY_PATH)) {
    try {
      const raw = readFileSync(REGISTRY_PATH, "utf8");
      const registry = JSON.parse(raw) as Registry;
      for (const [id, entry] of Object.entries(registry.instances)) {
        idToName.set(id, entry.name);
        if (!colorMap.has(entry.name)) {
          colorMap.set(entry.name, INSTANCE_COLORS[colorIdx % INSTANCE_COLORS.length]);
          colorIdx++;
        }
      }
    } catch {
      // ignore
    }
  }

  // Special names
  idToName.set("human", "human");
  colorMap.set("human", "\x1b[38;5;255m"); // bright white

  return { idToName, colorMap };
}

function resolveName(nameMap: NameMap, id: string): string {
  if (nameMap.idToName.has(id)) {
    return nameMap.idToName.get(id)!;
  }
  // Instance IDs follow the pattern "{name}-{4hex}" (e.g. "alcmene-30a1")
  // Extract the name by stripping the hex suffix
  const match = id.match(/^(.+)-[0-9a-f]{4}$/);
  const name = match ? match[1] : id;
  nameMap.idToName.set(id, name);
  return name;
}

function getColor(nameMap: NameMap, name: string): string {
  if (nameMap.colorMap.has(name)) {
    return nameMap.colorMap.get(name)!;
  }
  // Deterministic color from name hash
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const color = INSTANCE_COLORS[Math.abs(hash) % INSTANCE_COLORS.length];
  nameMap.colorMap.set(name, color);
  return color;
}

// ── Message collection ───────────────────────────────────────

interface CollectedMessage {
  msg: Message | ControlMessage;
  source: string; // "inbox" | "processed" | "audit"
}

function collectFromDir(dir: string, source: string): CollectedMessage[] {
  const results: CollectedMessage[] = [];
  if (!existsSync(dir)) return results;

  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".json") && f !== "delivered.json",
  );

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const msg = JSON.parse(raw) as Message | ControlMessage;
      if (msg.id && msg.timestamp && msg.from) {
        results.push({ msg, source });
      }
    } catch {
      // skip malformed
    }
  }

  return results;
}

function collectAllMessages(): CollectedMessage[] {
  const all: CollectedMessage[] = [];
  const seen = new Set<string>();

  function addUnique(msgs: CollectedMessage[]): void {
    for (const m of msgs) {
      if (!seen.has(m.msg.id)) {
        seen.add(m.msg.id);
        all.push(m);
      }
    }
  }

  // Scan inboxes (pending + processed)
  if (existsSync(INBOXES_DIR)) {
    for (const instanceDir of readdirSync(INBOXES_DIR)) {
      const inboxPath = join(INBOXES_DIR, instanceDir);
      if (!statSync(inboxPath).isDirectory()) continue;

      addUnique(collectFromDir(inboxPath, "inbox"));
      addUnique(collectFromDir(join(inboxPath, "processed"), "processed"));
    }
  }

  // Scan audit
  if (existsSync(AUDIT_DIR)) {
    for (const instanceDir of readdirSync(AUDIT_DIR)) {
      const auditPath = join(AUDIT_DIR, instanceDir);
      if (!statSync(auditPath).isDirectory()) continue;

      addUnique(collectFromDir(auditPath, "audit"));
    }
  }

  // Sort by timestamp
  all.sort((a, b) => a.msg.timestamp.localeCompare(b.msg.timestamp));

  return all;
}

// ── Rendering ────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function wrapText(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines.join("\n" + indent);
}

function renderMessage(
  collected: CollectedMessage,
  nameMap: NameMap,
  termWidth: number,
): string {
  const { msg } = collected;
  const fromName = resolveName(nameMap, msg.from);
  const toName = resolveName(nameMap, msg.to);
  const fromColor = getColor(nameMap, fromName);
  const toColor = getColor(nameMap, toName);
  const time = formatTime(msg.timestamp);
  const badge = TYPE_BADGES[msg.type] ?? `[${msg.type}]`;

  const indent = "           "; // length matches time column
  const bodyWidth = Math.max(40, termWidth - indent.length - 4);

  const header =
    `${DIM}${time}${RESET}  ${fromColor}${BOLD}${fromName}${RESET}` +
    ` ${DIM}\u2192${RESET} ${toColor}${BOLD}${toName}${RESET}` +
    `  ${badge}`;

  const lines = [header];

  if (msg.type === "control") {
    const ctrl = msg as ControlMessage;
    const action = `${BOLD}${ctrl.action}${RESET}`;
    const reason = ctrl.reason ? ` \u2014 ${ctrl.reason}` : "";
    lines.push(`${indent}${action}${DIM}${reason}${RESET}`);
  } else {
    const m = msg as Message;
    if (m.subject) {
      lines.push(`${indent}${BOLD}${m.subject}${RESET}`);
    }
    if (m.body) {
      const wrapped = wrapText(m.body, bodyWidth, indent);
      lines.push(`${indent}${wrapped}`);
    }
    if (m.in_reply_to) {
      lines.push(`${indent}${DIM}\u21b3 reply to ${m.in_reply_to.slice(0, 12)}${RESET}`);
    }
  }

  return lines.join("\n");
}

function renderDateSeparator(date: string, termWidth: number): string {
  const label = ` ${date} `;
  const padLen = Math.max(0, Math.floor((termWidth - label.length) / 2));
  const line = "\u2500".repeat(padLen);
  return `${DIM}${line}${label}${line}${RESET}`;
}

// ── CLI ──────────────────────────────────────────────────────

interface Options {
  follow: boolean;
  last: number;
  type: string | null;
  from: string | null;
}

function parseArgs(args: string[]): Options {
  const opts: Options = { follow: false, last: 0, type: null, from: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--follow":
      case "-f":
        opts.follow = true;
        break;
      case "--last":
      case "-n":
        opts.last = parseInt(args[++i] ?? "20", 10);
        break;
      case "--type":
      case "-t":
        opts.type = args[++i] ?? null;
        break;
      case "--from":
        opts.from = args[++i] ?? null;
        break;
      case "--help":
      case "-h":
        console.log(`
${BOLD}cc-mess viewer${RESET} — conversation timeline between Claude instances

${BOLD}Usage:${RESET}
  npx tsx src/viewer.ts [options]

${BOLD}Options:${RESET}
  -f, --follow      Live-tail new messages (poll every 2s)
  -n, --last N      Show only the last N messages
  -t, --type TYPE   Filter by message type (task, result, chat, etc.)
      --from NAME   Filter by sender name
  -h, --help        Show this help
`);
        process.exit(0);
    }
  }

  return opts;
}

function filterMessages(
  messages: CollectedMessage[],
  opts: Options,
  nameMap: NameMap,
): CollectedMessage[] {
  let filtered = messages;

  if (opts.type) {
    filtered = filtered.filter((m) => m.msg.type === opts.type);
  }
  if (opts.from) {
    const fromLower = opts.from.toLowerCase();
    filtered = filtered.filter((m) => {
      const name = resolveName(nameMap, m.msg.from).toLowerCase();
      return name.includes(fromLower);
    });
  }
  if (opts.last > 0) {
    filtered = filtered.slice(-opts.last);
  }

  return filtered;
}

function printTimeline(messages: CollectedMessage[], nameMap: NameMap): void {
  const termWidth = process.stdout.columns ?? 100;
  let lastDate = "";

  for (const collected of messages) {
    const date = formatDate(collected.msg.timestamp);
    if (date !== lastDate) {
      console.log("");
      console.log(renderDateSeparator(date, termWidth));
      lastDate = date;
    }
    console.log(renderMessage(collected, nameMap, termWidth));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(MESS_DIR)) {
    console.error(`${DIM}No mesh data found at ${MESS_DIR}${RESET}`);
    process.exit(1);
  }

  const nameMap = buildNameMap();
  const allMessages = collectAllMessages();
  const filtered = filterMessages(allMessages, opts, nameMap);

  if (filtered.length === 0) {
    console.log(`${DIM}No messages found.${RESET}`);
    if (!opts.follow) process.exit(0);
  }

  // Header
  const instanceCount = nameMap.idToName.size - 1; // exclude "human"
  console.log(
    `\n${BOLD}cc-mess${RESET} ${DIM}conversation viewer${RESET}` +
    `  ${DIM}(${allMessages.length} messages, ${instanceCount} instances)${RESET}\n`,
  );

  printTimeline(filtered, nameMap);

  if (!opts.follow) {
    console.log("");
    return;
  }

  // Follow mode — poll for new messages every 2s
  console.log(`\n${DIM}--- following (Ctrl+C to stop) ---${RESET}\n`);
  const seenIds = new Set(allMessages.map((m) => m.msg.id));

  const poll = (): void => {
    // Refresh name map in case new instances appeared
    const freshNameMap = buildNameMap();
    // Merge into existing
    for (const [id, name] of freshNameMap.idToName) {
      if (!nameMap.idToName.has(id)) {
        nameMap.idToName.set(id, name);
      }
    }
    for (const [name, color] of freshNameMap.colorMap) {
      if (!nameMap.colorMap.has(name)) {
        nameMap.colorMap.set(name, color);
      }
    }

    const current = collectAllMessages();
    const newMessages: CollectedMessage[] = [];

    for (const m of current) {
      if (!seenIds.has(m.msg.id)) {
        seenIds.add(m.msg.id);
        newMessages.push(m);
      }
    }

    if (newMessages.length > 0) {
      const toShow = filterMessages(newMessages, { ...opts, last: 0 }, nameMap);
      if (toShow.length > 0) {
        printTimeline(toShow, nameMap);
      }
    }
  };

  setInterval(poll, 2000);

  // Keep alive
  process.on("SIGINT", () => {
    console.log(`\n${DIM}stopped.${RESET}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
