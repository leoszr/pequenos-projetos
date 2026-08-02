import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import type { DelegationService, ManageAction } from "../domain/service.ts";
import type { Capability, DelegationRequest, ThinkingLevel } from "../domain/types.ts";
import type { ModelPolicy } from "../models/policy.ts";
import { modelRequestSchemas } from "./model-policy-schema.ts";

export function registerHolisticTools(
  pi: ExtensionAPI,
  getService: () => DelegationService,
  policy: ModelPolicy,
  onChange: () => void = () => undefined,
  canCreate: () => boolean = () => true,
): void {
  const { capability, effort } = modelRequestSchemas(policy);
  pi.registerTool({
    name: "holistic_create",
    label: "Create Delegation",
    description: "Create and start one persistent auxiliary Pi delegation through Herdr.",
    promptSnippet: "Create a persistent Herdr delegation with explicit mission, authority, topology, evidence, minimum capability and reasoning policy",
    executionMode: "sequential",
    parameters: Type.Object({
      name: Type.String(),
      mission: Type.String(),
      context: Type.Optional(Type.String()),
      cwd: Type.String(),
      authority: Type.Object({
        mode: Type.Union([
          Type.Literal("read_only"),
          Type.Literal("controlled_mutation"),
          Type.Literal("isolated_mutation"),
        ]),
        allowedPaths: Type.Array(Type.String()),
        forbiddenPaths: Type.Optional(Type.Array(Type.String())),
        requireExternalSandbox: Type.Optional(Type.Boolean()),
      }),
      acceptanceEvidence: Type.Array(Type.String()),
      topology: Type.Union(
        [Type.Literal("pane"), Type.Literal("tab"), Type.Literal("worktree")],
        {
          description: "pane uses a shared auxiliary tab (maximum 3 panes); tab creates a dedicated auxiliary tab; worktree creates an isolated checkout/workspace. No option uses the coordinator tab.",
        },
      ),
      minimumCapability: capability,
      effort: Type.Optional(effort),
      allowDegraded: Type.Optional(Type.Boolean()),
      purpose: Type.Optional(Type.Union(
        [Type.Literal("execution"), Type.Literal("verification")],
        { description: "Delegation role; reviewOf infers verification, otherwise defaults to execution" },
      )),
      reviewOf: Type.Optional(Type.String({
        description: "Delegation being reviewed; implies verification and cannot use execution purpose",
      })),
      baseRef: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
      requiresCleanContext: Type.Optional(Type.Boolean({
        description: "Always launch a new Agent Session. Compaction does not satisfy this requirement.",
      })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (!canCreate()) {
        return toolError(new Error("Subagent mode is off. Enable it before creating a delegation."));
      }
      const request: DelegationRequest = {
        name: params.name,
        mission: params.mission,
        context: params.context,
        cwd: params.cwd,
        authority: params.authority,
        acceptanceEvidence: params.acceptanceEvidence,
        topology: params.topology,
        purpose: params.purpose,
        reviewOf: params.reviewOf,
        baseRef: params.baseRef,
        branch: params.branch,
        requiresCleanContext: params.requiresCleanContext,
        model: {
          minimumCapability: params.minimumCapability as Capability,
          effort: params.effort === "auto" ? undefined : params.effort as ThinkingLevel,
          allowDegraded: params.allowDegraded,
        },
      };
      try {
        const delegation = await getService().create(request, signal);
        onChange();
        return toolResult(summary(delegation), { delegation });
      } catch (error) {
        return toolError(error);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("accent", `create ${args.name} · ${args.topology}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const failed = typeof result.details === "object" && result.details !== null && "error" in result.details;
      return new Text(theme.fg(failed ? "error" : "success", firstText(result)), 0, 0);
    },
  });

  pi.registerTool({
    name: "holistic_list",
    label: "List Delegations",
    description: "List persistent delegations and their current semantic state.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const delegations = getService().list();
      return toolResult(
        delegations.length ? delegations.map(summary).join("\n") : "No delegations in this session.",
        { delegations },
      );
    },
  });

  pi.registerTool({
    name: "holistic_inspect",
    label: "Inspect Delegation",
    description: "Read a child's handoff and audit Git authority without accepting it.",
    executionMode: "sequential",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      try {
        const result = await getService().inspect(params.id, signal);
        onChange();
        return toolResult(
          `${summary(result.delegation)}\nAuthority: ${result.audit.ok ? "ok" : result.audit.violations.join("; ")}${artifactSummary(result.delegation)}\n\n${result.paneOutput}`,
          result,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "holistic_send",
    label: "Message Delegation",
    description: "Answer a child question or send a focused follow-up/correction to the same persistent pane.",
    executionMode: "sequential",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String(),
      questionId: Type.Optional(Type.String()),
      correction: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      try {
        const delegation = await getService().send(
          params.id,
          params.message,
          { questionId: params.questionId, correction: params.correction },
          signal,
        );
        onChange();
        return toolResult(summary(delegation), { delegation });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "holistic_manage",
    label: "Manage Delegation",
    description: "Focus, accept, fail, close or clean an owned delegation. Acceptance requires prior inspection.",
    executionMode: "sequential",
    parameters: Type.Object({
      id: Type.String(),
      action: Type.Union([
        Type.Literal("focus"),
        Type.Literal("accept"),
        Type.Literal("fail"),
        Type.Literal("close"),
        Type.Literal("cleanup"),
      ]),
      reason: Type.Optional(Type.String()),
      discardBranch: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const delegation = await getService().manage(params.id, params.action as ManageAction, {
          reason: params.reason,
          discardBranch: params.discardBranch,
        });
        onChange();
        return toolResult(summary(delegation), { delegation });
      } catch (error) {
        return toolError(error);
      }
    },
  });
}

function summary(delegation: {
  id: string;
  state: string;
  request: { name: string };
  health?: string;
  modelResolution?: {
    model: string;
    thinking: string;
    requestedEffort?: string;
    effectiveEffort?: string;
  };
}): string {
  const resolution = delegation.modelResolution;
  const routing = resolution
    ? ` · ${resolution.model} · effort:${resolution.requestedEffort ?? "legacy"}→${resolution.effectiveEffort ?? resolution.thinking} · think:${resolution.thinking}`
    : "";
  return `${delegation.id} · ${delegation.request.name} · ${delegation.state}${routing}${delegation.health ? ` (${delegation.health})` : ""}`;
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function artifactSummary(delegation: {
  handoff?: { manifest?: { artifacts: Array<{ id: string; mediaType: string; size: number; sha256: string }> } };
}): string {
  const refs = delegation.handoff?.manifest?.artifacts ?? [];
  return refs.length
    ? `\nArtifacts:\n${refs.map((ref) => `- ${ref.id} · ${ref.mediaType} · ${ref.size} bytes · sha256:${ref.sha256}`).join("\n")}`
    : "";
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message }, isError: true };
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}
