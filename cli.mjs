#!/usr/bin/env node
// tailclaude — human-readable tail -f for Claude Code session JSONL files.
//
// Usage:
//   npx tailclaude                           # latest session (auto-detect)
//   npx tailclaude ffbb89d7                  # match by UUID prefix
//   npx tailclaude /path/to/session.jsonl    # full path
//   npx tailclaude -n 10 ffbb               # last 10 entries, match prefix
//   npx tailclaude --no-follow latest        # one-shot, most recent session
//   npx tailclaude --ai-summary ffbb89d7    # Haiku summaries for large tool results
//   npx tailclaude --ai-updates              # periodic AI status digests every 30s

import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

// ── ANSI colors ─────────────────────────────────────────────────────────────

let NO_COLOR = !process.stdout.isTTY || !!process.env.NO_COLOR;

const c = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const dim = (t) => c("2", t);
const cyan = (t) => c("36", t);
const green = (t) => c("32", t);
const yellow = (t) => c("33", t);
const red = (t) => c("31", t);
const bold = (t) => c("1", t);
const magenta = (t) => c("35", t);

// ── size formatting ─────────────────────────────────────────────────────────

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

// ── timestamp formatting ────────────────────────────────────────────────────

function fmtTs(tsStr) {
  try {
    const dt = new Date(tsStr);
    if (isNaN(dt.getTime())) return "??:??:??";
    return dt.toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "??:??:??";
  }
}

// ── content helpers ─────────────────────────────────────────────────────────

function truncate(s, maxlen = 100) {
  s = s.replace(/\n/g, " ").trim();
  return s.length > maxlen ? s.slice(0, maxlen) + "…" : s;
}

function contentText(block) {
  const content = block.content ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === "string" ? item : item?.text ?? JSON.stringify(item)
      )
      .join(" ");
  }
  return String(content);
}

// ── content block rendering ─────────────────────────────────────────────────

function renderBlock(block, aiSummary, summarizer) {
  const btype = block.type ?? "unknown";

  if (btype === "text") {
    return `"${truncate(block.text ?? "")}"`;
  }
  if (btype === "thinking") {
    const raw = block.thinking ?? "";
    return dim(`[thinking ${fmtSize(raw.length)}]`);
  }
  if (btype === "tool_use") {
    const name = block.name ?? "?";
    const inp = block.input ?? {};
    let summary = "";
    if (typeof inp === "object" && inp !== null && !Array.isArray(inp)) {
      for (const key of [
        "command", "pattern", "file_path", "query", "prompt", "url",
        "old_string", "skill", "description",
      ]) {
        if (key in inp) {
          summary = truncate(String(inp[key]), 60);
          break;
        }
      }
      if (!summary) summary = truncate(JSON.stringify(inp), 60);
    } else {
      summary = truncate(String(inp), 60);
    }
    return `${yellow("⚙")} ${bold(name)}: ${summary}`;
  }
  if (btype === "tool_result") {
    const raw = contentText(block);
    const size = raw.length;
    const base = `${green("✓")} tool_result (${fmtSize(size)})`;
    if (aiSummary && summarizer && size > 3000) {
      const aiText = summarizer(raw);
      if (aiText) {
        return `${base} ${magenta("→")} ${magenta("[AI]")} "${truncate(aiText, 120)}"`;
      }
    }
    return base;
  }
  return dim(`[${btype}]`);
}

// ── entry rendering ─────────────────────────────────────────────────────────

function renderEntry(entry, aiSummary, summarizer) {
  const etype = entry.type ?? "unknown";
  const ts = fmtTs(entry.timestamp ?? "");

  if (etype === "queue-operation") {
    const op = entry.operation ?? "?";
    return `${dim(ts)} ${dim("──")} ${dim(`queue: ${op}`)}`;
  }

  const msg = entry.message ?? {};
  const role = msg.role ?? etype;
  const content = msg.content ?? [];

  let prefix;
  if (role === "user") {
    prefix = `${ts} ${cyan("▶ USER ")}`;
  } else if (role === "assistant") {
    prefix = `${ts} ${green("◀ ASST ")}`;
  } else {
    prefix = `${ts} ${dim(`  ${etype.padEnd(6)}`)}`;
  }

  if (typeof content === "string") {
    return `${prefix} "${truncate(content)}"`;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return `${prefix} ${dim("(empty)")}`;
  }

  const parts = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    parts.push(renderBlock(block, aiSummary, summarizer));
  }

  if (parts.length === 0) {
    return `${prefix} ${dim("(no renderable content)")}`;
  }

  if (parts.length <= 3) {
    return `${prefix} ${parts.join(" ")}`;
  }

  // Summarize for many blocks
  const toolUses = content.filter((b) => b?.type === "tool_use");
  const texts = content.filter((b) => b?.type === "text");
  const thinkings = content.filter((b) => b?.type === "thinking");
  const summaryParts = [];

  if (thinkings.length) {
    const total = thinkings.reduce((s, b) => s + (b.thinking ?? "").length, 0);
    summaryParts.push(dim(`[thinking ${fmtSize(total)}]`));
  }
  if (texts.length) {
    summaryParts.push(`"${truncate(texts[0].text ?? "", 60)}"`);
  }
  if (toolUses.length) {
    const name = toolUses[0].name ?? "?";
    summaryParts.push(
      `${yellow("⚙")} ${bold(name)} (${dim(`×${toolUses.length} tools`)})`
    );
  }
  return `${prefix} ${summaryParts.join(" ")}`;
}

// ── Claude AI summarizer (shells out to `claude`) ───────────────────────────

function createSummarizer() {
  const cache = new Map();
  let lastCall = 0;
  const rateLimit = 1000; // ms between calls

  // Check claude is available
  const which = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (which.status !== 0) {
    console.error(
      `${red("⚠")} --ai-summary requires the 'claude' CLI to be installed.`
    );
    process.exit(1);
  }

  return function summarize(content) {
    // Simple hash for cache key (first 5000 chars)
    const key = content.slice(0, 5000);
    if (cache.has(key)) return cache.get(key);

    const now = Date.now();
    if (now - lastCall < rateLimit) return null;
    lastCall = now;

    const truncated = content.slice(0, 4000);
    const prompt = `Summarize this tool output in 1 short sentence (max 120 chars). Focus on what information it contains, not formatting details.\n\n${truncated}`;

    try {
      const result = spawnSync("claude", ["-p", prompt, "--model", "claude-haiku-4-5-20251001"], {
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.status === 0 && result.stdout) {
        const summary = result.stdout.trim();
        if (summary) {
          cache.set(key, summary);
          return summary;
        }
      }
    } catch {
      // Silently skip
    }
    return null;
  };
}

// ── AI status updates ────────────────────────────────────────────────────────

function digestEntry(entry) {
  const etype = entry.type ?? "unknown";
  if (etype === "queue-operation") return null;

  const msg = entry.message ?? {};
  const role = msg.role ?? etype;
  const content = msg.content ?? [];

  if (typeof content === "string") {
    return `[${role}] ${content.slice(0, 200)}`;
  }
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const bt = block.type ?? "";
    if (bt === "text") {
      parts.push(block.text?.slice(0, 200) ?? "");
    } else if (bt === "thinking") {
      parts.push(`<thinking>${(block.thinking ?? "").slice(0, 300)}</thinking>`);
    } else if (bt === "tool_use") {
      const inp = block.input ?? {};
      const arg = inp.command ?? inp.file_path ?? inp.pattern ?? inp.query ?? inp.description ?? "";
      parts.push(`[tool:${block.name ?? "?"}] ${String(arg).slice(0, 150)}`);
    } else if (bt === "tool_result") {
      const raw = contentText(block);
      parts.push(`[result] ${raw.slice(0, 200)}`);
    }
  }
  if (parts.length === 0) return null;
  return `[${role}] ${parts.join(" | ")}`;
}

function buildTranscriptDigest(entries, maxChars = 8000) {
  const lines = [];
  // Work backwards from most recent, keep within budget
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = digestEntry(entries[i]);
    if (line) lines.unshift(line);
  }
  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = result.slice(-maxChars);
    const nl = result.indexOf("\n");
    if (nl !== -1) result = result.slice(nl + 1);
  }
  return result;
}

function checkClaudeCli() {
  const which = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (which.status !== 0) {
    console.error(
      `${red("⚠")} This feature requires the 'claude' CLI to be installed.`
    );
    process.exit(1);
  }
}

function runAiUpdate(digest) {
  const prompt = `You are a concise status reporter watching a Claude Code session in real-time.

Below is a transcript of recent activity (most recent at bottom). Based on this, give a brief status update covering:

1. **Working on**: What is Claude currently doing? (1 sentence)
2. **Progress**: How is it going — stuck, making progress, wrapping up? (1 sentence)
3. **Next**: What will it probably do next? (1 sentence)

Be specific — mention file names, function names, tool names. Keep the entire response under 4 lines. No preamble.

--- TRANSCRIPT ---
${digest}`;

  try {
    const result = spawnSync("claude", ["-p", prompt, "--model", "claude-haiku-4-5-20251001"], {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Silently skip
  }
  return null;
}

function printAiUpdate(text) {
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const bar = "─".repeat(60);
  console.log("");
  console.log(magenta(`┌${bar}┐`));
  console.log(magenta(`│`) + bold(` AI Status Update `) + dim(`(${now})`) + " ".repeat(Math.max(0, 60 - 19 - now.length - 2)) + magenta(`│`));
  console.log(magenta(`├${bar}┤`));
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    // Pad line to fit box, truncate if too long
    const display = stripped.length > 58 ? stripped.slice(0, 57) + "…" : stripped;
    console.log(magenta(`│`) + ` ${display}` + " ".repeat(Math.max(0, 59 - display.length)) + magenta(`│`));
  }
  console.log(magenta(`└${bar}┘`));
  console.log("");
}

// ── JSONL reading ───────────────────────────────────────────────────────────

function readAllEntries(filePath) {
  const entries = [];
  const data = readFileSync(filePath, "utf-8");
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      entries.push({ _raw: trimmed, type: "parse_error", timestamp: "" });
    }
  }
  return entries;
}

// ── file tailing ────────────────────────────────────────────────────────────

function tailFollow(filePath, n, aiSummary, noFollow, aiUpdates) {
  const summarizer = aiSummary ? createSummarizer() : null;
  if (aiUpdates) checkClaudeCli();

  const entries = readAllEntries(filePath);
  const show = entries.slice(-n);

  for (const entry of show) {
    if (entry._raw) {
      console.log(`${red("⚠")} ${truncate(entry._raw)}`);
    } else {
      console.log(renderEntry(entry, aiSummary, summarizer));
    }
  }

  // For --ai-updates in --no-follow mode, run one digest on the shown entries
  if (noFollow) {
    if (aiUpdates && show.length > 0) {
      const digest = buildTranscriptDigest(show);
      if (digest) {
        const update = runAiUpdate(digest);
        if (update) printAiUpdate(update);
      }
    }
    return;
  }

  console.log(dim(`\n── following ${basename(filePath)} (Ctrl+C to stop) ──\n`));

  let filePos = statSync(filePath).size;
  let buf = "";

  // Accumulate recent entries for AI updates
  const recentEntries = aiUpdates ? entries.slice(-50) : [];

  const poll = () => {
    let curSize;
    try {
      curSize = statSync(filePath).size;
    } catch {
      console.log(red("File removed, stopping."));
      process.exit(0);
    }

    if (curSize < filePos) {
      filePos = 0;
      if (aiUpdates) recentEntries.length = 0;
      console.log(yellow("── file truncated, re-reading ──"));
    }

    if (curSize > filePos) {
      const fd = openSync(filePath, "r");
      const chunk = Buffer.alloc(curSize - filePos);
      readSync(fd, chunk, 0, chunk.length, filePos);
      closeSync(fd);
      filePos = curSize;

      buf += chunk.toString("utf-8");
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          console.log(renderEntry(entry, aiSummary, summarizer));
          if (aiUpdates) {
            recentEntries.push(entry);
            // Keep a sliding window
            if (recentEntries.length > 100) recentEntries.splice(0, recentEntries.length - 80);
          }
        } catch {
          console.log(`${red("⚠")} ${truncate(line)}`);
        }
      }
    }
  };

  setInterval(poll, 500);

  // AI status update every 30 seconds
  if (aiUpdates) {
    let lastDigestHash = "";
    setInterval(() => {
      if (recentEntries.length === 0) return;
      const digest = buildTranscriptDigest(recentEntries);
      if (!digest || digest === lastDigestHash) return;
      lastDigestHash = digest;
      const update = runAiUpdate(digest);
      if (update) printAiUpdate(update);
    }, 30000);
  }

  process.on("SIGINT", () => {
    console.log(dim("\n── stopped ──"));
    process.exit(0);
  });
}

// ── session resolver ────────────────────────────────────────────────────────

function getProjectDirs() {
  const base = join(homedir(), ".claude", "projects");
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ path: join(base, e.name), mtime: statSync(join(base, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return dirs.map((d) => d.path);
  } catch {
    return [];
  }
}

function globJsonl(dir, pattern) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f.startsWith(pattern))
      .map((f) => {
        const full = join(dir, f);
        try {
          return { path: full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveSession(spec) {
  // Full path
  if (spec && (spec.includes("/") || spec.endsWith(".jsonl"))) {
    try {
      statSync(spec);
      return spec;
    } catch {
      console.error(`Error: ${spec} does not exist`);
      process.exit(1);
    }
  }

  // "latest" or no argument
  if (!spec || spec === "latest") {
    let best = null;
    let bestMtime = 0;
    for (const dir of getProjectDirs()) {
      for (const match of globJsonl(dir, "")) {
        if (match.mtime > bestMtime) {
          bestMtime = match.mtime;
          best = match.path;
        }
      }
    }
    if (best) return best;
    console.error("Error: no session JSONL files found in ~/.claude/projects/");
    process.exit(1);
  }

  // UUID prefix match
  const matches = [];
  for (const dir of getProjectDirs()) {
    for (const match of globJsonl(dir, spec)) {
      matches.push(match);
    }
  }

  if (matches.length === 0) {
    console.error(
      `Error: no session matching '${spec}*' found in ~/.claude/projects/`
    );
    process.exit(1);
  }

  matches.sort((a, b) => b.mtime - a.mtime);

  if (matches.length > 1) {
    console.error(
      `Matched ${matches.length} sessions for '${spec}*', using most recent:`
    );
    for (let i = 0; i < Math.min(matches.length, 5); i++) {
      const { path: p, mtime } = matches[i];
      const ts = new Date(mtime).toISOString().replace("T", " ").slice(0, 19);
      const stem = basename(p, ".jsonl");
      const marker = i === 0 ? " ←" : "";
      console.error(`  ${stem}  (${ts})${marker}`);
    }
    if (matches.length > 5) {
      console.error(`  ... and ${matches.length - 5} more`);
    }
  }

  return matches[0].path;
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        n: { type: "string", short: "n", default: "20" },
        follow: { type: "boolean", short: "f", default: true },
        "no-follow": { type: "boolean", default: false },
        "ai-summary": { type: "boolean", default: false },
        "ai-updates": { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (args.values.help) {
    console.log(`tailclaude — human-readable tail -f for Claude Code session JSONL files.

Usage:
  tailclaude                           latest session (auto-detect)
  tailclaude ffbb89d7                  match by UUID prefix
  tailclaude /path/to/session.jsonl    full path
  tailclaude -n 10 ffbb               last 10 entries, match prefix
  tailclaude --no-follow latest        one-shot, most recent session
  tailclaude --ai-summary ffbb89d7    AI summaries for large tool results
  tailclaude --ai-updates              periodic AI status digests every 30s

Options:
  -n <count>       Number of recent entries to show (default: 20)
  -f, --follow     Follow the file for new entries (default: true)
  --no-follow      Show entries and exit
  --ai-summary     Use Claude Haiku to summarize large tool results (>3K)
                   Requires 'claude' CLI to be installed
  --ai-updates     Print an AI-generated status digest every 30 seconds
                   covering what Claude is working on, progress, and next steps
                   Requires 'claude' CLI to be installed
  --no-color       Disable colored output
  -h, --help       Show this help`);
    process.exit(0);
  }

  if (args.values["no-color"]) {
    NO_COLOR = true;
  }

  const n = parseInt(args.values.n, 10) || 20;
  const noFollow = args.values["no-follow"];
  const aiSummary = args.values["ai-summary"];
  const aiUpdates = args.values["ai-updates"];
  const file = args.positionals[0] ?? null;

  const resolved = resolveSession(file);
  console.error(dim(`Session: ${resolved}`));
  tailFollow(resolved, n, aiSummary, noFollow, aiUpdates);
}

main();
