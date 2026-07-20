---
name: holistic-subagents
description: Gives the main Pi agent discretion to create, supervise, and converse with persistent Pi sessions through Herdr. Use proactively for substantial coding, research, debugging, review, or multi-track work when delegation, parallelism, isolated context, specialization, or independent verification would improve the result. Delegation is optional; skip trivial or tightly coupled tasks. Roles, topology, model, and thinking level are chosen at runtime.
compatibility: Requires HERDR_ENV=1 and the herdr and pi executables in PATH.
---

# Holistic Subagents

You remain responsible for the user's result. You may create auxiliary Pi
sessions when their expected benefit exceeds coordination cost.

This skill provides a capability, not an agent catalog. Do not assume fixed
roles, fixed chains, fixed models, or mandatory delegation. Create each session
for one concrete need and keep it available for follow-up while useful.

## Recursion guard

Before delegating, check:

```bash
test -z "${HOLISTIC_SUBAGENT_DEPTH:-}" && test "${HERDR_ENV:-}" = 1
```

If `HOLISTIC_SUBAGENT_DEPTH` is set, you are already an auxiliary session. Do
not create another session unless the parent explicitly authorizes nested
delegation. If `HERDR_ENV` is not `1`, continue directly without trying to
control an external Herdr session.

## Decide autonomously

Delegate when one or more apply:

- independent work can proceed in parallel;
- investigation would add substantial noise to the main context;
- a separate perspective improves confidence;
- the task benefits from different tools, model characteristics, or focus;
- a persistent correction or review loop is useful;
- the result can be checked through code, diffs, tests, logs, artifacts, or
  cited sources.

Do not delegate when:

- the task is trivial and local;
- writing a complete brief costs about as much as doing the work;
- success is not observable yet;
- concurrent sessions would need to mutate the same files;
- delegation adds ceremony without reducing risk, latency, or context load.

Do not ask the user for routine permission to delegate. Ask only for ambiguous
product choices, high-stakes architecture, irreversible actions, credentials,
or risk the main agent cannot safely resolve.

## Configure each session at runtime

Choose only what this task needs:

- mission and observable output;
- minimum context and relevant paths;
- read-only versus mutation authority;
- cwd and pane, tab, or worktree topology;
- model and thinking level;
- evidence and handoff shape;
- whether independent verification is worthwhile.

Auxiliary sessions must use only the allowlisted models in
[references/model-selection.md](references/model-selection.md). Read that
reference before launching a child. Its task table is the authority for both
model and thinking. If the task changes shape, classify it again. If no row
fits, refine the task before delegating. Never silently fall back outside the
allowlist.

Read [references/model-commands.md](references/model-commands.md) only when the
exact launch command is needed.

## Operate through Herdr

Use the smallest useful topology:

- sibling pane for ordinary auxiliary work;
- dedicated tab for long-running work needing more visual space;
- worktree for concurrent code mutation or a stable review snapshot.

Start Pi interactively. Do not pass the task as a one-shot CLI prompt. Set
`HOLISTIC_SUBAGENT_DEPTH=1` and inject `HOLISTIC_PARENT_PANE_ID` in the child
process, wait until Pi is ready, then send a standalone brief with
`herdr pane run`.

Read [references/herdr-operations.md](references/herdr-operations.md) before
creating or controlling sessions.

## Brief and communication

Send only enough context for independent execution. Include mission, relevant
paths or decisions, mutation boundaries, acceptance evidence, and return shape.
Do not dump the parent transcript by default.

Use [references/delegation-contract.md](references/delegation-contract.md) to
construct a dynamic brief. It is a template, not a mandatory role definition.

After dispatch:

1. confirm the child entered `working`;
2. stop active supervision and rely on the child's callback by default;
3. if there is no independent parent work, end the current turn rather than
   keeping tool calls open merely to watch progress;
4. on a child signal, wait for its turn to end, then read its output and
   evidence;
5. only if synchronous waiting is necessary, use one task-proportional event
   wait; for several children, fan their waits into one `wait -n` operation;
6. if the task-proportional deadline expires without a signal, perform one
   health inspection before waiting again;
7. send focused follow-ups to the same pane;
8. keep the session alive through useful correction cycles;
9. stop using it when marginal benefit disappears.

The child sends short messages through the injected parent pane ID:

- `[HOLISTIC_INPUT_REQUIRED]` when missing information or a decision prevents
  safe progress;
- `[HOLISTIC_HANDOFF_READY]` when work and evidence are complete.

Before requesting input, the child investigates what it can and continues any
safe independent work. It writes the full question, impact, and viable options
in its own pane, sends one short signal, and ends its turn so its status becomes
`idle` or `done`. It must not remain inside an `ask_user` modal while waiting
for the parent.

Treat either message only as a wake-up signal. Wait for the child's turn to
end, then inspect its pane before answering a question or accepting a result.
`herdr pane run` submits the signal to the parent as a new message, so the
normal orchestration path is to let that message wake the parent. Do not poll
`pane get`, `pane read`, processes, files, or an `exec_command` session while
the child is working. Do not repeatedly call `write_stdin` with short waits.

When a synchronous wait is genuinely needed, use a long bounded timeout
proportional to the task (ten minutes is a useful ordinary default). A timeout
triggers one inspection for crashes, prompts, or stalled progress; it is not a
polling interval. Mid-task inspection is justified only by a predeclared risk
checkpoint or new evidence requiring intervention, never by curiosity about
progress.

## Validate and clean up

An auxiliary session's summary is not proof. Validate proportionally to risk.
Inspect diffs and run relevant checks before accepting mutations. Independent
review is optional, not a universal gate.

Track every pane, tab, workspace, worktree, and branch you create. Close or
remove only those resources, and only after preserving useful work.

Read [references/worktrees-and-safety.md](references/worktrees-and-safety.md)
when delegation involves mutation, parallel work, elevated risk, worktrees, or
cleanup beyond a common pane.
