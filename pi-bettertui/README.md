# pi-bettertui

Minimal polished TUI extension for `@earendil-works/pi-coding-agent` v0.80+.

## Features

- Theme-aware header with compact animated π logo.
- Full footer: cwd, git branch/dirty count, model, thinking, tokens, cost, context bar, last response time, extension statuses.
- Framed editor with `π` prefix and Ctrl+C quit guard.
- Subtle working indicator.
- Omarchy integration: watches `~/.config/omarchy/current/theme.name`, switches to `omarchy-current`, and reads `light.mode`/`colors.toml` when present.
- No monkey-patches. Uses official `setHeader`, `setFooter`, `setEditorComponent`, `setWorkingIndicator`.

## Requirements

- pi v0.80+
- Truecolor terminal for logo fade (`COLORTERM=truecolor` or `24bit`). Without truecolor, logo is static.

## Install / dev

```bash
npm install
pi -e ./src/index.ts
```

Or symlink/copy this repo into `~/.pi/agent/extensions/pi-bettertui` and run `/reload`.

## Commands

```text
/bettertui enable
/bettertui disable
/bettertui status
/bettertui reload
```

## Omarchy theme generation

Run:

```bash
node ./scripts/omarchy-to-pi-theme.ts
```

It writes `~/.pi/agent/themes/omarchy-current.json` with `meta.luminance`.

## FAQ

**Does it work without Omarchy?** Yes. It falls back to current pi theme tokens.

**Does it replace other extension statuses?** No. Footer includes `footerData.getExtensionStatuses()`.

**Why no startup columns?** They require parsing internal chat layout. Fragile. Use official APIs only.
