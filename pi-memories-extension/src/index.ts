import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXT = "pi-memories";
const GLOBAL_DIR = path.join(os.homedir(), ".pi", "agent", "memory");
const PROJECT_DIR = ".pi-memory";

const LIMITS = {
  USER: { soft: 1600, hard: 1800, scope: "global" },
  MEMORY: { soft: 3600, hard: 4200, scope: "global" },
  PROJECT: { soft: 1800, hard: 2400, scope: "project" },
  ACTIVE: { soft: 1000, hard: 1600, scope: "project" },
  DESIGN: { soft: 4000, hard: 5200, scope: "project" },
  DECISIONS: { soft: 4000, hard: 5200, scope: "project" },
} as const;

type MemoryName = keyof typeof LIMITS;
type MemoryScope = "global" | "project";
type WriteMode = "append" | "replace";

type MemoryFile = {
  name: MemoryName;
  scope: MemoryScope;
  file: string;
  exists: boolean;
  chars: number;
  soft: number;
  hard: number;
  status: "missing" | "ok" | "soft" | "hard";
  content?: string;
};

type Ctx = Pick<ExtensionContext, "cwd">;

function globalFile(name: "USER" | "MEMORY") {
  return path.join(GLOBAL_DIR, `${name}.md`);
}

function projectFile(cwd: string, name: Exclude<MemoryName, "USER" | "MEMORY">) {
  return path.join(cwd, PROJECT_DIR, `${name}.md`);
}

function fileFor(cwd: string, name: MemoryName): string {
  if (name === "USER" || name === "MEMORY") return globalFile(name);
  return projectFile(cwd, name);
}

function titleFor(name: MemoryName): string {
  return `# ${name}.md\n`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function statusFor(chars: number, existsFlag: boolean, soft: number, hard: number): MemoryFile["status"] {
  if (!existsFlag) return "missing";
  if (chars > hard) return "hard";
  if (chars > soft) return "soft";
  return "ok";
}

async function inspectMemory(cwd: string, name: MemoryName, includeContent = false): Promise<MemoryFile> {
  const file = fileFor(cwd, name);
  const content = await readText(file);
  const existsFlag = await exists(file);
  const limits = LIMITS[name];
  return {
    name,
    scope: limits.scope as MemoryScope,
    file,
    exists: existsFlag,
    chars: content.length,
    soft: limits.soft,
    hard: limits.hard,
    status: statusFor(content.length, existsFlag, limits.soft, limits.hard),
    ...(includeContent ? { content } : {}),
  };
}

async function inspectAll(cwd: string, includeContent = false): Promise<MemoryFile[]> {
  const names = Object.keys(LIMITS) as MemoryName[];
  return Promise.all(names.map((name) => inspectMemory(cwd, name, includeContent)));
}

async function initMemory(cwd: string): Promise<string[]> {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.mkdir(path.join(cwd, PROJECT_DIR), { recursive: true });
  const created: string[] = [];
  for (const name of Object.keys(LIMITS) as MemoryName[]) {
    const file = fileFor(cwd, name);
    if (!(await exists(file))) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, template(name), "utf8");
      created.push(file);
    }
  }
  return created;
}

function template(name: MemoryName): string {
  switch (name) {
    case "USER":
      return "# USER.md\n\n- Preferred language/style and stable personal preferences go here.\n";
    case "MEMORY":
      return "# MEMORY.md\n\n- Durable cross-project lessons, habits, environment notes, and recurring patterns go here.\n";
    case "PROJECT":
      return "# PROJECT.md\n\n## Purpose\n\n## Architecture\n\n## Commands\n\n## Constraints\n";
    case "ACTIVE":
      return "# ACTIVE.md\n\n## Current Stage\n\n## Current Focus\n\n## Next Steps\n\n## Blockers / Open Questions\n";
    case "DESIGN":
      return "# DESIGN.md\n\n## Design Intent\n\n## Visual Personality\n\n## Color Tokens\n\n## Typography\n\n## Spacing\n\n## Layout\n\n## Shape\n\n## Elevation\n\n## Components\n\n## Motion\n\n## Accessibility\n\n## Do / Don't\n";
    case "DECISIONS":
      return "# DECISIONS.md\n\n## YYYY-MM-DD — Decision title\n\nContext:\n\nDecision:\n\nReason:\n\nConsequences:\n";
  }
}

function hasSecret(text: string): boolean {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\b\s*[:=]\s*\S{8,}/i,
    /\b(?:ghp|github_pat|sk|xoxb|xoxp|AKIA)[A-Za-z0-9_\-]{12,}\b/,
  ];
  return patterns.some((p) => p.test(text));
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasDuplicate(current: string, addition: string): boolean {
  const currentLines = new Set(normalizeLines(current));
  const additionLines = normalizeLines(addition);
  return additionLines.length > 0 && additionLines.every((line) => currentLines.has(line));
}

async function backup(file: string): Promise<string | undefined> {
  if (!(await exists(file))) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.${stamp}.bak`;
  await fs.copyFile(file, target);
  return target;
}

async function writeMemory(cwd: string, name: MemoryName, mode: WriteMode, content: string): Promise<{ file: string; chars: number; warning?: string }> {
  const limits = LIMITS[name];
  const file = fileFor(cwd, name);
  if (hasSecret(content)) throw new Error("Refusing to write memory: possible secret detected.");

  return withFileMutationQueue(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await readText(file);
    if (mode === "append" && hasDuplicate(current, content)) {
      return { file, chars: current.length, warning: "Skipped exact duplicate content." };
    }
    const next = mode === "replace" ? ensureTitle(name, content) : appendBlock(current || titleFor(name), content);
    if (next.length > limits.hard) {
      throw new Error(`Refusing to write ${name}.md: ${next.length} chars exceeds hard limit ${limits.hard}.`);
    }
    await backup(file);
    await fs.writeFile(file, next, "utf8");
    const warning = next.length > limits.soft ? `${name}.md above soft limit: ${next.length}/${limits.soft} chars.` : undefined;
    return { file, chars: next.length, warning };
  });
}

function ensureTitle(name: MemoryName, text: string): string {
  const trimmed = text.trimEnd();
  if (/^#\s+/m.test(trimmed)) return `${trimmed}\n`;
  return `${titleFor(name)}\n${trimmed}\n`;
}

function appendBlock(current: string, content: string): string {
  const trimmedCurrent = current.trimEnd();
  const trimmedContent = content.trim();
  const date = new Date().toISOString().slice(0, 10);
  return `${trimmedCurrent}\n\n## ${date}\n\n${trimmedContent}\n`;
}

function formatStatus(files: MemoryFile[]): string {
  const rows = files.map((f) => {
    const mark = f.status === "ok" ? "ok" : f.status === "missing" ? "missing" : f.status === "soft" ? "soft limit" : "hard limit";
    return `- ${f.name}.md (${f.scope}): ${mark}, ${f.chars}/${f.hard} chars — ${f.file}`;
  });
  return `Memory status:\n${rows.join("\n")}`;
}

function reviewMemory(files: MemoryFile[]): string {
  const notes: string[] = [];
  for (const file of files) {
    if (!file.exists) notes.push(`- ${file.name}.md missing: run /memory-init.`);
    if (file.status === "soft") notes.push(`- ${file.name}.md above soft limit (${file.chars}/${file.soft}); consolidate soon.`);
    if (file.status === "hard") notes.push(`- ${file.name}.md above hard limit (${file.chars}/${file.hard}); injection may be skipped.`);
    const content = file.content ?? "";
    if (hasSecret(content)) notes.push(`- ${file.name}.md may contain secret-like text; review manually.`);
    const seen = new Set<string>();
    let dupes = 0;
    for (const line of normalizeLines(content)) {
      if (seen.has(line)) dupes++;
      seen.add(line);
    }
    if (dupes > 0) notes.push(`- ${file.name}.md has ${dupes} duplicate non-empty line(s).`);
  }
  return notes.length ? `Memory review:\n${notes.join("\n")}` : "Memory review: no obvious issues.";
}

function cleanContent(content: string): string {
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  let previousBlank = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const normalized = line.trim();
    const blank = normalized === "";
    if (blank && previousBlank) continue;
    previousBlank = blank;
    if (/^[-*]\s+/.test(normalized)) {
      if (seen.has(normalized)) continue;
      seen.add(normalized);
    }
    out.push(line);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

async function cleanMemory(cwd: string): Promise<string> {
  const changed: string[] = [];
  for (const f of await inspectAll(cwd, true)) {
    if (!f.exists || !f.content) continue;
    const next = cleanContent(f.content);
    if (next !== f.content) {
      await backup(f.file);
      await fs.writeFile(f.file, next, "utf8");
      changed.push(`${f.name}.md (${f.content.length} -> ${next.length})`);
    }
  }
  return changed.length ? `Cleaned:\n- ${changed.join("\n- ")}` : "No cleanup changes needed.";
}

function isUiTask(prompt: string): boolean {
  return /\b(ui|ux|frontend|front-end|design|visual|component|page|screen|layout|css|tailwind|react|vue|svelte|interface|dashboard)\b/i.test(prompt);
}

function isDecisionTask(prompt: string): boolean {
  return /\b(architecture|architectural|decision|decide|tradeoff|trade-off|adr|design decision|refactor|migration|stack)\b/i.test(prompt);
}

async function promptMemory(cwd: string, prompt: string): Promise<{ text: string; loaded: string[]; warnings: string[] }> {
  const always: MemoryName[] = ["USER", "MEMORY", "PROJECT", "ACTIVE"];
  const lazy: MemoryName[] = [];
  if (isUiTask(prompt)) lazy.push("DESIGN");
  if (isDecisionTask(prompt)) lazy.push("DECISIONS");
  const names = [...always, ...lazy];
  const sections: string[] = [];
  const loaded: string[] = [];
  const warnings: string[] = [];

  for (const name of names) {
    const f = await inspectMemory(cwd, name, true);
    if (!f.exists || !f.content?.trim()) continue;
    if (f.status === "hard") {
      warnings.push(`${name}.md skipped: ${f.chars}/${f.hard} chars exceeds hard limit.`);
      continue;
    }
    if (f.status === "soft") warnings.push(`${name}.md above soft limit: ${f.chars}/${f.soft} chars.`);
    loaded.push(f.file);
    sections.push(`### ${name}.md (${f.scope})\n${f.content.trim()}`);
  }

  const policy = `Memory behavior:
+- If the user says "remember this", "se lembre disso", "guarde isso", "memorize", or similar, treat it as explicit consent to write a concise curated memory with memory_write.
+- Choose USER/MEMORY for cross-project preferences or recurring behavior; choose PROJECT/ACTIVE/DESIGN/DECISIONS for project-specific facts.
+- Do not store secrets, raw logs, transient details, or bulky text. Summarize into one or a few durable bullets.
+- When you infer a durable preference, recurring workflow, important project fact, or architectural decision that would help future sessions, ask the user before writing memory.
+- If scope is unclear, ask one focused question before writing.`;

  if (sections.length === 0) return { text: `\n\n## Pi Memories\n${policy}`, loaded, warnings };
  const pathList = loaded.map((p) => `- ${p}`).join("\n");
  const warningText = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
  return {
    loaded,
    warnings,
    text: `\n\n## Pi Memories\nLoaded memory files:\n${pathList}${warningText}\n\nRules:\n- Treat global memory as higher priority than project memory.\n- Memory is curated guidance, not raw logs.\n- Do not store or reveal secrets.\n- Follow Memory behavior below.\n\n${policy}\n\n${sections.join("\n\n")}`,
  };
}

async function sessionFiles(): Promise<string[]> {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

async function bootstrapReport(): Promise<{ report: string; user: string; memory: string; skills: string }> {
  const files = await sessionFiles();
  const prefs = new Set<string>();
  const workflows = new Set<string>();
  const skillCandidates = new Set<string>();
  let userMessages = 0;
  const projects = new Map<string, number>();

  const prefRe = /\b(?:prefer|prefiro|sempre|always|never|nunca|responda|answer|use|don't|do not|evite|avoid)\b.{0,180}/gi;
  const workflowRe = /\b(?:run|test|build|check|execute|use|workflow|command|comando|ferramenta|tool)\b.{0,180}/gi;

  for (const file of files.slice(0, 500)) {
    const raw = await readText(file);
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && typeof obj === "object" && (obj as { type?: string }).type === "session") {
        const cwd = String((obj as { cwd?: unknown }).cwd ?? "unknown");
        projects.set(cwd, (projects.get(cwd) ?? 0) + 1);
      }
      const entry = obj as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      userMessages++;
      const text = textFromContent(entry.message.content).replace(/\s+/g, " ").trim();
      for (const m of text.matchAll(prefRe)) {
        const candidate = m[0].trim();
        if (candidate.length >= 20 && !hasSecret(candidate)) prefs.add(candidate);
      }
      for (const m of text.matchAll(workflowRe)) {
        const candidate = m[0].trim();
        if (candidate.length >= 25 && !hasSecret(candidate)) workflows.add(candidate);
      }
      if (/\b(skill|checklist|workflow|sempre que|whenever|use this before)\b/i.test(text) && text.length < 500) {
        skillCandidates.add(text);
      }
    }
  }

  const prefList = [...prefs].slice(0, 10);
  const workflowList = [...workflows].slice(0, 12);
  const skillList = [...skillCandidates].slice(0, 12);
  const projectList = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const user = `# USER.md\n\n${prefList.map((p) => `- Candidate preference: ${p}`).join("\n") || "- No strong preference candidates found."}\n`;
  const memory = `# MEMORY.md\n\n${workflowList.map((p) => `- Candidate recurring pattern: ${p}`).join("\n") || "- No strong global memory candidates found."}\n`;
  const skills = `# Skill Candidates\n\n${skillList.map((p, i) => `## Candidate ${i + 1}\nTrigger:\nProcedure observed: ${p}\nEvidence: session heuristic\nValue expected:\nRisk/observations: requires user review before creating skill\n`).join("\n") || "No skill candidates found.\n"}`;
  const report = `# Pi Memory Bootstrap Report\n\nSessions analyzed: ${files.length}\nUser messages scanned: ${userMessages}\n\n## Projects\n${projectList.map(([p, n]) => `- ${p}: ${n}`).join("\n") || "- none"}\n\n## Accepted candidates\nNone automatically accepted. All candidates need review.\n\n## Ambiguous candidates\n- USER.md candidates: ${prefList.length}\n- MEMORY.md candidates: ${workflowList.length}\n- Skill candidates: ${skillList.length}\n\n## Safety\nSecret-like candidates were filtered heuristically. Review before writing.\n`;
  return { report, user, memory, skills };
}

async function runBootstrap(cwd: string, ctx: ExtensionContext): Promise<string> {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  const { report, user, memory, skills } = await bootstrapReport();
  const reportFile = path.join(GLOBAL_DIR, "bootstrap-report.md");
  const skillsFile = path.join(GLOBAL_DIR, "skill-candidates.md");
  await fs.writeFile(reportFile, report, "utf8");
  await fs.writeFile(skillsFile, skills, "utf8");

  let wrote = false;
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Write global memory candidates?", `Review first:\n${reportFile}\n${skillsFile}\n\nWrite USER.md and MEMORY.md with candidate content now?`);
    if (ok) {
      await writeMemory(cwd, "USER", "replace", user.slice(0, LIMITS.USER.hard));
      await writeMemory(cwd, "MEMORY", "replace", memory.slice(0, LIMITS.MEMORY.hard));
      wrote = true;
    }
  }
  return `Bootstrap complete.\n- report: ${reportFile}\n- skill candidates: ${skillsFile}\n${wrote ? "- wrote USER.md and MEMORY.md" : "- did not write USER.md/MEMORY.md (confirmation not given or no UI)"}`;
}

export default function piMemories(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const mem = await promptMemory(ctx.cwd, event.prompt);
    if (!mem.text) return;
    return { systemPrompt: event.systemPrompt + mem.text };
  });

  pi.registerCommand("memory-init", {
    description: "Create global and project memory Markdown files",
    handler: async (_args, ctx) => {
      const created = await initMemory(ctx.cwd);
      const msg = created.length ? `Created:\n${created.map((p) => `- ${p}`).join("\n")}` : "Memory files already exist.";
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show memory files, sizes, and limits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatStatus(await inspectAll(ctx.cwd)), "info");
    },
  });

  pi.registerCommand("memory-review", {
    description: "Review memory files without changing them",
    handler: async (_args, ctx) => {
      ctx.ui.notify(reviewMemory(await inspectAll(ctx.cwd, true)), "info");
    },
  });

  pi.registerCommand("memory-clean", {
    description: "Safely clean duplicate bullets and excessive blank lines in memory files",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Clean memory files?", "Creates .bak backups, removes duplicate bullet lines and repeated blank lines.");
        if (!ok) return;
      }
      ctx.ui.notify(await cleanMemory(ctx.cwd), "info");
    },
  });

  pi.registerCommand("memory-bootstrap", {
    description: "Analyze saved Pi sessions and generate global memory candidates",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await runBootstrap(ctx.cwd, ctx), "info");
    },
  });

  pi.registerCommand("memory-skill-candidates", {
    description: "Generate skill candidate report from saved sessions",
    handler: async (_args, ctx) => {
      await fs.mkdir(GLOBAL_DIR, { recursive: true });
      const { skills } = await bootstrapReport();
      const skillsFile = path.join(GLOBAL_DIR, "skill-candidates.md");
      await fs.writeFile(skillsFile, skills, "utf8");
      ctx.ui.notify(`Skill candidates written: ${skillsFile}`, "info");
    },
  });

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show Pi memory files, sizes, soft/hard limits, and paths.",
    promptSnippet: "Inspect configured Pi memory files and size-limit status.",
    promptGuidelines: ["Use memory_status before writing memory when you need current memory file sizes or paths."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const files = await inspectAll(ctx.cwd);
      return { content: [{ type: "text", text: formatStatus(files) }], details: { files } };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Append or replace curated Markdown memory with soft/hard limit validation. Rejects secret-like content and exact duplicates.",
    promptSnippet: "Write curated facts to USER/MEMORY/PROJECT/ACTIVE/DESIGN/DECISIONS Markdown memory files.",
    promptGuidelines: [
      "When the user explicitly asks you to remember something, use memory_write without extra confirmation unless scope or safety is unclear.",
      "When you notice a durable preference, recurring workflow, important project fact, or architectural decision, ask the user before writing memory.",
      "Use memory_write only for durable curated memory, not raw logs or secrets.",
      "Use memory_write with project files for project-specific facts and global files only for cross-project user preferences or recurring patterns.",
      "Prefer concise consolidation over append-only growth when using memory_write.",
    ],
    parameters: Type.Object({
      file: StringEnum(["USER", "MEMORY", "PROJECT", "ACTIVE", "DESIGN", "DECISIONS"] as const, { description: "Memory file to update" }),
      mode: StringEnum(["append", "replace"] as const, { description: "Append a dated block or replace whole file" }),
      content: Type.String({ description: "Curated Markdown content to write" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await writeMemory(ctx.cwd, params.file as MemoryName, params.mode as WriteMode, params.content);
      const text = [`Updated ${result.file}`, `${result.chars} chars`, result.warning].filter(Boolean).join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
