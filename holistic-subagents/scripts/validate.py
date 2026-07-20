#!/usr/bin/env python3
"""Validate the local holistic-subagents skill without installing it."""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
SELECTION = ROOT / "references/model-selection.md"
COMMANDS = ROOT / "references/model-commands.md"

MODEL_THINKING_RE = re.compile(
    r"`((?:openai-codex|deepseek|openrouter)/[^`]+)` com "
    r"`(off|minimal|low|medium|high|xhigh|max)`"
)
COMMAND_RE = re.compile(
    r"--model\s+(\S+)\s+\\\n\s+--thinking\s+"
    r"(off|minimal|low|medium|high|xhigh|max)\b"
)
MARKDOWN_LINK_RE = re.compile(r"\[[^]]+\]\(([^)]+\.md)\)")
FORBIDDEN_FLAGS = {
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-approve",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_frontmatter() -> None:
    text = SKILL.read_text()
    if not text.startswith("---\n"):
        fail("SKILL.md has no YAML frontmatter")
    try:
        _, frontmatter, _ = text.split("---\n", 2)
    except ValueError:
        fail("SKILL.md frontmatter is not closed")
    fields = {
        line.split(":", 1)[0].strip()
        for line in frontmatter.splitlines()
        if ":" in line
    }
    missing = {"name", "description"} - fields
    if missing:
        fail(f"SKILL.md missing frontmatter fields: {sorted(missing)}")


def validate_links() -> None:
    for markdown in ROOT.rglob("*.md"):
        for target in MARKDOWN_LINK_RE.findall(markdown.read_text()):
            if not (markdown.parent / target).resolve().is_file():
                fail(f"broken link in {markdown.relative_to(ROOT)}: {target}")


def route_pairs() -> Counter[tuple[str, str]]:
    pairs = Counter(MODEL_THINKING_RE.findall(SELECTION.read_text()))
    if not pairs:
        fail("no model/thinking routes found in model-selection.md")
    return pairs


def command_pairs() -> Counter[tuple[str, str]]:
    pairs = Counter(COMMAND_RE.findall(COMMANDS.read_text()))
    if not pairs:
        fail("no model commands found in model-commands.md")
    return pairs


def validate_routes() -> set[str]:
    routes = route_pairs()
    commands = command_pairs()
    if routes != commands:
        missing = routes - commands
        extra = commands - routes
        if missing:
            print(f"Missing commands: {list(missing.elements())}", file=sys.stderr)
        if extra:
            print(f"Extra commands: {list(extra.elements())}", file=sys.stderr)
        fail("model-selection.md and model-commands.md diverged")
    return {model for model, _ in routes}


def validate_removed_isolation_policy() -> None:
    offenders: list[str] = []
    for markdown in ROOT.rglob("*.md"):
        text = markdown.read_text()
        found = sorted(flag for flag in FORBIDDEN_FLAGS if flag in text)
        if found:
            offenders.append(f"{markdown.relative_to(ROOT)}: {', '.join(found)}")
    if offenders:
        fail("removed isolation flags returned:\n  " + "\n  ".join(offenders))


def validate_handoff_protocol() -> None:
    required = {
        ROOT / "SKILL.md": (
            "HOLISTIC_PARENT_PANE_ID",
            "HOLISTIC_INPUT_REQUIRED",
            "HOLISTIC_HANDOFF_READY",
        ),
        ROOT / "references/herdr-operations.md": (
            "HOLISTIC_PARENT_PANE_ID",
            "HOLISTIC_INPUT_REQUIRED",
            "HOLISTIC_HANDOFF_READY",
        ),
        ROOT / "references/delegation-contract.md": (
            "HOLISTIC_PARENT_PANE_ID",
            "HOLISTIC_INPUT_REQUIRED",
            "HOLISTIC_HANDOFF_READY",
        ),
    }
    for path, markers in required.items():
        text = path.read_text()
        missing = [marker for marker in markers if marker not in text]
        if missing:
            fail(
                f"handoff protocol incomplete in {path.relative_to(ROOT)}: "
                f"{missing}"
            )

    operations = (ROOT / "references/herdr-operations.md").read_text()
    orchestration_markers = ("wait -n", "yield_time_ms=1000", "polling")
    missing = [marker for marker in orchestration_markers if marker not in operations]
    if missing:
        fail(f"event-driven wait guidance incomplete: {missing}")


def available_models() -> set[str]:
    models: set[str] = set()
    for query in ("gpt-5.6", "deepseek-v4"):
        result = subprocess.run(
            ["pi", "--list-models", query],
            check=True,
            text=True,
            capture_output=True,
        )
        for line in result.stdout.splitlines():
            columns = line.split()
            if len(columns) >= 2 and columns[0] != "provider":
                models.add(f"{columns[0]}/{columns[1]}")
    return models


def validate_availability(allowed: set[str]) -> None:
    try:
        available = available_models()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"could not query Pi models: {error}")
    missing = sorted(allowed - available)
    if missing:
        fail(f"allowlisted models unavailable in Pi: {missing}")


def validate_herdr_integration() -> None:
    try:
        result = subprocess.run(
            ["herdr", "integration", "status"],
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"could not query Herdr integrations: {error}")
    pi_line = next(
        (line for line in result.stdout.splitlines() if line.startswith("pi:")),
        "",
    )
    if not pi_line.startswith("pi: current"):
        fail(f"Herdr Pi integration is not current: {pi_line or 'not found'}")


def main() -> None:
    validate_frontmatter()
    validate_links()
    allowed = validate_routes()
    validate_removed_isolation_policy()
    validate_handoff_protocol()
    validate_availability(allowed)
    validate_herdr_integration()
    print(
        "OK: skill structure, links, routing commands, handoff protocol, "
        "removed isolation flags, Herdr integration, and "
        f"{len(allowed)} model IDs validated"
    )


if __name__ == "__main__":
    main()
