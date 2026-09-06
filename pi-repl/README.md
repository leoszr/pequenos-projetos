# pi-repl-notebook (experimental)

Standalone Pi extension offering two complementary programmatic runtimes over the Pi's real tools.

> Status: functional but **experimental**. Unit suite, typecheck, lint and build pass; Deno integration runs on Linux/macOS/Windows via CI (`verify` + `integration`). Interrupt races and external-kill hardening are still in progress (see `docs/implementation-plan.md`). **Notebook and Code Mode are not a sandbox.**

## Philosophy

- **Direct tool**: single or interactive operations stay as normal Pi tools.
- **Code Mode**: self-contained composition in a fresh, disposable Deno Jupyter kernel per execution.
- **Notebook Mode**: persistent composition with bindings, checkpoints, profiles, pins and journal in one kernel per Pi session.

## Requirements

- Pi 0.85.1 (extension API)
- Deno **2.9.6** on `PATH` (pinned; the kernel refuses other runtimes)
- Node 20+ and the `zeromq` npm dependency (Jupyter wire transport)

## Install

As a local Pi package:

```bash
pi install ./pi-repl-notebook
```

or load once for a test run:

```bash
pi -e ./pi-repl-notebook/src/index.ts
```

No processes, downloads or kernels start on load. Everything is lazy: the first real execution boots what it needs.

## Model-facing surface

One tool, `repl_notebook`:

| `mode` | `action` | Purpose |
|---|---|---|
| code/notebook | `exec` | Run TypeScript; long runs return `yielded` + `execution_id` |
| code/notebook | `wait` / `interrupt` / `terminate` | Follow up, cancel, or kill an execution |
| code/notebook | `status` / `diagnostics` / `tools` | Inspect state, authorized tools, integration |
| notebook | `bindings` / `snapshot` / `checkpoint` / `restart` | Inspect and persist state |
| notebook | `reset` / `pin` / `unpin` / `release` / `prune` | Explicit state surgery (scoped, pins protected) |
| notebook | `profile` / `project` / `journal` | Profiles, project generations, history export |

```ts
// Code Mode: self-contained composition, no bindings leak out.
const files = await tools.find_files({ pattern: "**/*.ts" });
const bodies = await Promise.all(files.slice(0, 5).map((file) => tools.read({ path: file })));
return bodies;
```

```ts
// Notebook Mode cell 1: bindings persist while the session lives.
const files = await tools.find_files({ pattern: "**/*.ts" });
const selected = files.slice(0, 10);
```

```ts
// Notebook Mode cell 2: `selected` is still available.
text(selected.join("\n"));
```

Administration (status, enable/disable, checkpoint, profiles, limits, policies) lives in `/repl`, not in extra tools.

## How tools reach the runtime

`tools.*` is served by a cooperative `ToolProvider` integrated with the Pi host: real tool definitions, current schemas, preflight/approval, cancellation and context. Without an integrated provider the bridge fails closed (local computation still works). The extension never reimplements shell or file tools; it calls the host.

Interactive tools are never auto-answered inside a runtime. Approval, cwd, session context and cancellation propagate from the host.

## State layout

```
${PI_REPL_STATE_DIR:-~/.pi/agent/repl-notebook}/<sha256(project)>/sessions/<sha256(sessionId)>/
```

Sessions keep private forks; promotion to project generations is explicit with CAS conflicts. A promote intent reconciles crashes between project promotion and session checkpoint.

## Docs

- `docs/implementation-plan.md` — architecture, protocol, phases, test matrix, pending hardening
- `docs/reference-map.md` — what was learned from each reference (no copied code)
- `docs/bridge.md`, `docs/persistence.md`, `docs/pi-integration.md` — module contracts

## Verify

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:integration
```

## Licenses

MIT — see `LICENSE`. Concept attributions — see `NOTICE`.
