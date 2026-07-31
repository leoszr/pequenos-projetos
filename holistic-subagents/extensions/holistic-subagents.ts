import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHolisticDashboard } from "../src/pi/dashboard.ts";
import { registerHolisticMode } from "../src/pi/mode.ts";
import {
  availableModels,
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from "../src/pi/runtime.ts";
import { updateHolisticStatus } from "../src/pi/status.ts";
import { registerHolisticTools } from "../src/pi/tools.ts";
import {
  createModelPolicyResolver,
  loadEffectiveModelPolicy,
  unavailablePolicyModels,
} from "../src/models/policy.ts";
import { coordinatorEnabled } from "../src/security/authority.ts";

/** Pi package entrypoint. */
export default function holisticSubagents(pi: ExtensionAPI): void {
  if (process.env.HOLISTIC_SUBAGENT_DEPTH) {
    registerChildPolicy(pi);
    return;
  }
  if (!coordinatorEnabled()) return;

  const mode = registerHolisticMode(pi);
  let runtime: CoordinatorRuntime | undefined;
  let currentContext: Parameters<typeof updateHolisticStatus>[0] | undefined;
  const service = () => {
    if (!runtime) throw new Error("Holistic runtime is not ready; start Pi inside Herdr");
    return runtime.service;
  };
  const refresh = () => {
    void runtime?.syncSubscriptions().catch(() => undefined);
    if (currentContext) updateHolisticStatus(currentContext, runtime?.service);
  };

  registerHolisticDashboard(pi, service, (ctx) => updateHolisticStatus(ctx, runtime?.service));

  const initialize = async (ctx: Parameters<typeof updateHolisticStatus>[0]) => {
    mode.setAvailable(false);
    runtime?.close();
    runtime = undefined;
    currentContext = ctx;
    const loaded = await loadEffectiveModelPolicy({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      projectConfigDirName: CONFIG_DIR_NAME,
    });
    const models = availableModels(ctx);
    const unavailable = unavailablePolicyModels(loaded.policy, models);
    if (unavailable.length) {
      ctx.ui.notify(
        `Holistic model policy warning (${loaded.path}): unavailable models: ${unavailable.join(", ")}`,
        "warning",
      );
    }
    if (loaded.created) {
      ctx.ui.notify(`Created editable holistic model policy: ${loaded.path}`, "info");
    }
    registerHolisticTools(pi, service, loaded.policy, refresh, mode.isEnabled);
    runtime = await createCoordinatorRuntime(
      pi,
      ctx,
      refresh,
      createModelPolicyResolver(loaded.policy),
    );
    mode.setAvailable(true);
    updateHolisticStatus(ctx, runtime.service);
  };

  const safeInitialize = async (ctx: Parameters<typeof updateHolisticStatus>[0]) => {
    try {
      await initialize(ctx);
    } catch (error) {
      mode.setAvailable(false);
      ctx.ui.notify(
        `Holistic runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await safeInitialize(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => safeInitialize(ctx));
  pi.on("input", async (event) => {
    if (!runtime || event.source === "extension") return { action: "continue" };
    const result = runtime.service.handleCallbackInput(event.text);
    if (!result.matched || !result.valid || !result.transformedText) {
      return { action: "continue" };
    }
    refresh();
    return { action: "transform", text: result.transformedText, images: event.images };
  });
  pi.on("session_shutdown", async () => {
    runtime?.close();
    runtime = undefined;
  });
}

function registerChildPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const encoded = process.env.HOLISTIC_AUTHORITY_POLICY;
    let authority = "Follow the authority declared in the delegation brief.";
    if (encoded) {
      try {
        authority = `Delegation authority (binding policy, not a sandbox): ${Buffer.from(encoded, "base64url").toString("utf8")}`;
      } catch {
        // Keep the safe generic policy.
      }
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\nYou are a holistic child session. Do not delegate or control other sessions. ${authority}`,
    };
  });
}
