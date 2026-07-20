#!/usr/bin/env python3
"""Validate the hybrid holistic-subagents Pi package."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "package.json"
SKILL = ROOT / "skills/holistic-subagents/SKILL.md"
POLICY = ROOT / "src/models/policy.json"
MARKDOWN_LINK_RE = re.compile(r"\[[^]]+\]\(([^)]+\.md)\)")
ALLOWED_PROVIDERS = {"openai-codex", "deepseek"}
ALLOWED_EFFORTS = ["low", "medium", "high"]
REQUIRED_CALLBACKS = {
    "HOLISTIC_QUESTION",
    "HOLISTIC_INPUT_REQUIRED",
    "HOLISTIC_HANDOFF_READY",
}
REQUIRED_HERDR_METHODS = {
    "session.snapshot",
    "agent.start",
    "pane.send_input",
    "pane.report_metadata",
    "workspace.report_metadata",
    "events.subscribe",
    "worktree.create",
    "worktree.remove",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid JSON in {path.relative_to(ROOT)}: {error}")


def validate_package() -> None:
    package = load_json(PACKAGE)
    if package.get("type") != "module":
        fail("package.json must be an ESM package")
    if "pi-package" not in package.get("keywords", []):
        fail("package.json is missing pi-package keyword")
    resources = package.get("pi", {})
    expected = {
        "extensions": ["./extensions/holistic-subagents.ts"],
        "skills": ["./skills"],
    }
    for kind, paths in expected.items():
        if resources.get(kind) != paths:
            fail(f"package.json pi.{kind} must be {paths}")
        for relative in paths:
            if not (ROOT / relative).exists():
                fail(f"missing package resource: {relative}")


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
    missing = {"name", "description", "compatibility"} - fields
    if missing:
        fail(f"SKILL.md missing frontmatter fields: {sorted(missing)}")


def markdown_files() -> list[Path]:
    files = [path for path in ROOT.glob("*.md") if path.is_file()]
    files.extend(path for path in (ROOT / "skills").rglob("*.md"))
    return files


def validate_links() -> None:
    for markdown in markdown_files():
        for target in MARKDOWN_LINK_RE.findall(markdown.read_text()):
            if target.startswith(("http://", "https://")):
                continue
            if not (markdown.parent / target).resolve().is_file():
                fail(f"broken link in {markdown.relative_to(ROOT)}: {target}")


def validate_policy() -> set[str]:
    policy = load_json(POLICY)
    if policy.get("version") != 1:
        fail("unsupported model policy version")
    if set(policy.get("providers", [])) != ALLOWED_PROVIDERS:
        fail("model providers must be exactly OpenAI Codex and DeepSeek")
    if policy.get("efforts") != ALLOWED_EFFORTS:
        fail("model efforts must be exactly low, medium, high")
    models: set[str] = set()
    for model in policy.get("models", []):
        model_id = model.get("id", "")
        provider = model_id.split("/", 1)[0]
        if provider not in ALLOWED_PROVIDERS:
            fail(f"model outside provider allowlist: {model_id}")
        if model_id in models:
            fail(f"duplicate model in policy: {model_id}")
        models.add(model_id)
        thinking = model.get("thinkingMap", {})
        if set(thinking) != set(ALLOWED_EFFORTS):
            fail(f"incomplete thinking map: {model_id}")
        if any(value not in ALLOWED_EFFORTS for value in thinking.values()):
            fail(f"invalid thinking level: {model_id}")
    if not models:
        fail("model policy is empty")
    if (ROOT / "skills/holistic-subagents/references/model-commands.md").exists():
        fail("model-commands.md returned; launch argv must come from policy")
    return models


def validate_callbacks() -> None:
    for path in (
        SKILL,
        ROOT / "skills/holistic-subagents/references/delegation-contract.md",
    ):
        text = path.read_text()
        missing = REQUIRED_CALLBACKS - {marker for marker in REQUIRED_CALLBACKS if marker in text}
        if missing:
            fail(f"callback protocol incomplete in {path.relative_to(ROOT)}: {sorted(missing)}")
    source = (ROOT / "src/protocol/callback.ts").read_text()
    missing = REQUIRED_CALLBACKS - {marker for marker in REQUIRED_CALLBACKS if marker in source}
    if missing:
        fail(f"callback parser is incomplete: {sorted(missing)}")


def collect_consts(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        const = value.get("const")
        if isinstance(const, str):
            found.add(const)
        for child in value.values():
            found.update(collect_consts(child))
    elif isinstance(value, list):
        for child in value:
            found.update(collect_consts(child))
    return found


def validate_herdr() -> None:
    try:
        integration = subprocess.run(
            ["herdr", "integration", "status"],
            check=True,
            text=True,
            capture_output=True,
        )
        schema_result = subprocess.run(
            ["herdr", "api", "schema", "--json"],
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"could not query Herdr: {error}")
    pi_line = next(
        (line for line in integration.stdout.splitlines() if line.startswith("pi:")),
        "",
    )
    if not pi_line.startswith("pi: current"):
        fail(f"Herdr Pi integration is not current: {pi_line or 'not found'}")
    schema = json.loads(schema_result.stdout)
    if int(schema.get("protocol", 0)) < 16:
        fail(f"Herdr protocol is too old: {schema.get('protocol')}")
    missing = REQUIRED_HERDR_METHODS - collect_consts(schema.get("schemas", {}).get("request", {}))
    if missing:
        fail(f"Herdr schema is missing required methods: {sorted(missing)}")


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


def validate_model_availability(allowed: set[str]) -> None:
    try:
        available = available_models()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"could not query Pi models: {error}")
    missing = allowed - available
    if missing:
        fail(f"policy models unavailable in Pi: {sorted(missing)}")


def main() -> None:
    validate_package()
    validate_frontmatter()
    validate_links()
    models = validate_policy()
    validate_callbacks()
    validate_herdr()
    validate_model_availability(models)
    print(
        "OK: hybrid manifest, skill, links, callback protocol, Herdr socket API, "
        f"and {len(models)} OpenAI/DeepSeek models validated"
    )


if __name__ == "__main__":
    main()
