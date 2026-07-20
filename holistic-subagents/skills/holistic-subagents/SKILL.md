---
name: holistic-subagents
description: Gives the main Pi agent discretion to create, supervise, question, review, and reuse persistent auxiliary Pi sessions through the holistic extension and Herdr. Use proactively for substantial coding, research, debugging, review, or parallel work when delegation improves latency, context isolation, specialization, or independent verification. Delegation remains optional.
compatibility: Requires the holistic-subagents Pi extension, HERDR_ENV=1, and current Herdr Pi integration.
---

# Holistic Subagents

You remain responsible for the user's result. Delegate only when the expected
benefit exceeds coordination cost. The extension executes and records a
delegation; Herdr hosts it; you inspect evidence and decide acceptance.

## Recursion guard

If `HOLISTIC_SUBAGENT_DEPTH` is set, you are an auxiliary session. Do not
delegate. The extension does not register coordinator tools in child sessions.

If `HERDR_ENV` is not `1` or the `holistic_*` tools are unavailable, continue
directly unless delegation is essential. Use
[references/herdr-operations.md](references/herdr-operations.md) only for
diagnosis or explicit manual fallback.

## Decide autonomously

Delegate when independent work can proceed in parallel, investigation would
pollute the main context, a persistent correction loop is useful, or an
independent check materially reduces risk. Do not delegate trivial work,
tightly coupled edits, unobservable missions, or work whose brief costs as much
as direct execution.

Do not ask routine permission to delegate. Ask the user for ambiguous product
choices, credentials, irreversible actions, or risk you cannot safely resolve.

## Define one delegation

Before `holistic_create`, specify:

- an observable mission and minimum context;
- acceptance evidence and return shape;
- absolute cwd and topology: pane, tab, or worktree;
- authority: read-only, controlled mutation, or isolated mutation;
- allowed/forbidden paths;
- minimum task capability and thinking effort;
- whether it verifies another delegation.

Use [references/delegation-contract.md](references/delegation-contract.md) for
brief semantics and [references/worktrees-and-safety.md](references/worktrees-and-safety.md)
for mutation or cleanup.

### Capability and effort

Classify task shape, not price or role:

- `bounded`: localized, explicit, low-agency work;
- `scoped`: bounded multi-step implementation/investigation;
- `cross_cutting`: several modules, wider exploration or material ambiguity;
- `high_agency`: broad, long, uncertain work requiring sustained autonomy.

Choose effort separately: `low`, `medium`, or `high`. Never request another
thinking level. Concrete models are resolved from the package policy and are
limited to OpenAI Codex and DeepSeek. Read
[references/model-selection.md](references/model-selection.md) for filters,
independence and degraded fallback.

## Operate through the extension

1. Call `holistic_create` with the complete delegation request.
2. If only degraded capability exists, proceed only after explicitly deciding
   that the lower capability is acceptable and retrying with opt-in.
3. Confirm the returned state is `working`; then stop active supervision.
4. Continue independent parent work or end the turn. Do not poll panes,
   processes, files, tool sessions, or status.
5. Reuse `holistic_send` for answers, focused follow-ups and corrections.
6. Use `holistic_list` only when a current summary is needed, not as polling.

The child can converse with you:

- `[HOLISTIC_QUESTION]` keeps it working while a non-blocking callback wakes
  you;
- `[HOLISTIC_INPUT_REQUIRED]` moves it to `awaiting_input` and ends its turn;
- `[HOLISTIC_HANDOFF_READY]` moves it to `ready_for_review`.

Callbacks are authenticated and transformed into readable parent input. Inspect
the child once after a signal; the full question/handoff remains in its pane.

## Review and acceptance

`ready_for_review` is a claim, not proof. Call `holistic_inspect` to read the
handoff and audit Git/authority. Check diffs, tests, logs, sources or artifacts
proportionally to risk.

Treat the structured `Authority`/`audit.ok` returned by `holistic_inspect` as
the authority for workspace cleanliness. The child's prose may be mistaken or
refer to a different checkout; do not override the extension's audited cwd and
baseline with an unsupported self-report.

You may review directly or create a verification delegation with
`purpose=verification` and `reviewOf=<original-id>`. Give the reviewer a stable
commit/diff and read-only authority. It may use the other allowed provider to
reduce correlated errors. The reviewer reports findings; only you accept the
original.

If validation fails, call `holistic_send` with `correction=true` and a precise,
evidence-based request. Reuse the original executor session. Accept with
`holistic_manage` only after inspection; reviewer and executor summaries never
accept themselves.

## Cleanup

Track state through the extension ledger. `holistic_manage` closes only owned
resources and refuses dirty or ownership-divergent cleanup. Preserve/integrate
useful commits and artifacts before closing. Never use discard/force merely to
hide unreviewed work.

The user can inspect and act on the same delegations with `/holistic`.
