# tailclaude

**`tail -f` for Claude Code sessions.** See what Claude is doing in real-time, from another terminal.

```
npx @lukebechtel/tailclaude
```

<img alt="screenshot placeholder" src="https://img.shields.io/badge/zero_dependencies-black?style=flat-square"> <img alt="npm" src="https://img.shields.io/npm/v/@lukebechtel/tailclaude?style=flat-square&color=blue"> <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square">

---

## What it does

Claude Code stores every conversation turn as JSONL in `~/.claude/projects/`. These files are dense and unreadable. `tailclaude` turns them into a compact, color-coded live stream:

```
14:32:01 ▶ USER  "Add error handling to the upload endpoint"
14:32:03 ◀ ASST  [thinking 2.1K] ⚙ Read: src/routes/upload.ts
14:32:04 ◀ ASST  ✓ tool_result (4.8K)
14:32:05 ◀ ASST  [thinking 1.4K] ⚙ Edit: src/routes/upload.ts
14:32:06 ◀ ASST  ✓ tool_result (312B)
14:32:07 ◀ ASST  "Done. I wrapped the handler in a try/catch..."
```

It auto-detects the most recent session, follows for live updates, and just works.

## Install

```bash
# Run directly (no install needed)
npx @lukebechtel/tailclaude

# Or with bun
bunx @lukebechtel/tailclaude

# Or install globally
npm i -g @lukebechtel/tailclaude
```

## Usage

```bash
# Tail the most recent session (auto-detected)
tailclaude

# Match a session by UUID prefix
tailclaude ffbb89d7

# Tail a specific file
tailclaude /path/to/session.jsonl

# Show last 10 entries, then follow
tailclaude -n 10

# One-shot: print and exit (no follow)
tailclaude --no-follow

# AI-powered summaries for large tool results (requires claude CLI)
tailclaude --ai-summary
```

## Options

| Flag | Description |
|------|-------------|
| `-n <count>` | Number of recent entries to show (default: 20) |
| `-f, --follow` | Follow the file for new entries (default) |
| `--no-follow` | Print entries and exit |
| `--ai-summary` | Summarize large tool results (>3KB) using Claude Haiku |
| `--no-color` | Disable colored output |
| `-h, --help` | Show help |

## AI Summaries

When `--ai-summary` is passed, tool results larger than 3KB get a one-line summary from Claude Haiku. This makes it easy to see *what* a tool returned without reading walls of text:

```
14:32:04 ◀ ASST  ✓ tool_result (4.8K) → [AI] "Express route handler with multer upload, validates file type and size"
```

This requires the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) to be installed. If you're using `tailclaude`, you probably already have it. Without `--ai-summary`, no external tools are needed.

## How it works

- Scans `~/.claude/projects/` for session JSONL files
- Picks the most recently modified session (or matches by UUID prefix)
- Parses each JSONL line and renders it as a compact, colored summary
- In follow mode, polls for new data every 500ms (like `tail -f`)

## Requirements

- Node.js >= 18
- Claude CLI (only if using `--ai-summary`)

## License

MIT
