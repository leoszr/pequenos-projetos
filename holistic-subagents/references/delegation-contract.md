# Dynamic Delegation Contract

This is a brief generator, not a catalog of agents. Include only sections that
reduce ambiguity for the current task. Do not assign a permanent persona when a
plain task description is enough.

## Minimum brief

````md
You are an auxiliary Pi session created by the main agent for one bounded task.
Do not delegate or create additional sessions.

## Mission
<observable result>

## Context
- cwd or worktree: <path>
- relevant files, decisions, versions, or constraints
- base branch/commit when relevant

## Authority
- mode: <read-only | may mutate>
- may edit: <paths or boundary>
- must not edit: <paths or boundary>

## Acceptance evidence
- <test, diff, log, artifact, source, or concrete answer>

## Return
- result;
- evidence and exact commands executed;
- files or commits, when applicable;
- uncertainties, limitations, and risks.

Remain available in this session for follow-up.

If missing information or a decision prevents safe progress, first investigate
what you can and continue any independent work that remains safe. Then put the
full question, its impact, and concise viable options in your response. Notify
the parent once and end your turn; do not open `ask_user` or keep working while
waiting for the answer:

```bash
if [ -n "${HOLISTIC_PARENT_PANE_ID:-}" ]; then
  herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
    "[HOLISTIC_INPUT_REQUIRED] child=$HERDR_PANE_ID task=<short-summary>. Wait for the child to become idle/done, then read its pane and reply there."
fi
```

When work and evidence are ready, notify the parent once:

```bash
if [ -n "${HOLISTIC_PARENT_PANE_ID:-}" ]; then
  herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
    "[HOLISTIC_HANDOFF_READY] child=$HERDR_PANE_ID task=<short-summary>. Wait for the child to become idle/done, then read its pane."
fi
```
````

## Brief-writing rules

- Make the mission independently understandable.
- Provide decisions, not the whole parent conversation.
- Point to relevant files instead of pasting large source blocks.
- Distinguish facts, hypotheses, and unresolved questions.
- Give mutation authority explicitly. Default to read-only when editing is not
  needed.
- State what must be returned, not how the child must think.
- Avoid mandatory build, test, commit, or review steps when irrelevant.
- Avoid fixed labels such as `worker` or `reviewer`; use task-focused session
  names.
- Keep the parent notification short. The full handoff remains in this pane.
- For missing input, notify once per blocking episode and end the turn so the
  parent's status wait returns.
- For completion, notify once after validation.
- Notify only through the injected parent pane ID.
- The parent relies on these notifications. Do not assume it is periodically
  reading this pane.

## Examples of task-focused missions

### Investigation

```md
Determine why checkout retries can charge twice. Work read-only. Return the
call path, reproduction conditions, evidence by file and symbol, and the
smallest credible correction direction. Do not implement yet.
```

### Implementation

```md
Implement the accepted cache invalidation change in `src/search/**`. Do not
touch the shared API schema. Run focused tests, commit the result, and return
the commit hash, changed files, test output, and remaining uncertainty.
```

### Independent verification

```md
Inspect commit `<hash>` against `<acceptance criteria>`. Work read-only and do
not trust the author's summary. Return only actionable findings with severity,
location, reproduction or reasoning, impact, and smallest credible fix. Say
clearly when no actionable issue is supported by evidence.
```

These are examples, not roles or required workflow stages.

## Follow-up messages

Use the same persistent session. Keep follow-ups narrow and evidence-based:

```text
Your result leaves <specific uncertainty>. Inspect <path/symbol/scenario> and
return <specific evidence>.
```

```text
Validation found <exact failure>. Expected <behavior>. Correct it within the
same ownership boundary, rerun <check>, and report the delta.
```

Do not resend the original brief unless the child demonstrably lost context.
