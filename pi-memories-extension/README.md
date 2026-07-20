# Pi Memories Extension

Markdown memory extension for Pi. It injects compact curated memory into the system prompt and provides tools/commands to manage memory files.

## Files

Global:

```txt
~/.pi/agent/memory/USER.md
~/.pi/agent/memory/MEMORY.md
```

Project:

```txt
<repo>/.pi-memory/PROJECT.md
<repo>/.pi-memory/ACTIVE.md
<repo>/.pi-memory/DESIGN.md
<repo>/.pi-memory/DECISIONS.md
```

Always loaded: `USER.md`, `MEMORY.md`, `PROJECT.md`, `ACTIVE.md`.
Lazy loaded: `DESIGN.md` for UI/frontend prompts, `DECISIONS.md` for architecture/decision prompts.

## Commands

- `/memory-init` — create memory structure.
- `/memory-status` — show sizes and limits.
- `/memory-review` — audit without changing files.
- `/memory-clean` — backup then remove duplicate bullet lines/repeated blanks.
- `/memory-bootstrap` — scan saved Pi sessions, write reports, ask before writing global memory candidates.
- `/memory-skill-candidates` — generate skill candidate report.

## Tools

- `memory_status`
- `memory_write`

`memory_write` validates soft/hard limits, skips exact duplicates, backs up before writes, and rejects secret-like content.

## Install / Try

```bash
npm install
pi -e .
```

Or install as a local Pi package:

```bash
pi install /absolute/path/to/pi-memories-extension
```
