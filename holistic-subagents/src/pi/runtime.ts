import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { DelegationService } from "../domain/service.ts";
import { isActiveState } from "../domain/state-machine.ts";
import { isAgentRuntimeStatus } from "../domain/types.ts";
import { DelegationRepository, PiSessionDelegationStore } from "../domain/store.ts";
import type { SessionEntryLike } from "../domain/types.ts";
import { HerdrClient, type HerdrSubscriptionEvent } from "../herdr/client.ts";
import type { HerdrSnapshot } from "../herdr/client.ts";
import type { AvailableModel, ModelPolicyResolver } from "../models/policy.ts";
import type { CommandRunner } from "../security/authority.ts";

export interface CoordinatorRuntime {
  service: DelegationService;
  client: HerdrClient;
  syncSubscriptions(): Promise<void>;
  close(): void;
}

export function createInfrastructureEventHandler(
  service: Pick<DelegationService, "onInfrastructureEvent">,
  ctx: { ui: Pick<ExtensionContext["ui"], "notify"> },
  onChange: () => void,
): (event: HerdrSubscriptionEvent) => Promise<void> {
  return async (event) => {
    try {
      await service.onInfrastructureEvent(event);
      onChange();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Holistic infrastructure event rejected: ${reason}`, "error");
    }
  };
}

function isSafeReconciliationSnapshot(snapshot: HerdrSnapshot): boolean {
  return Array.isArray(snapshot.panes)
    && snapshot.panes.every((pane) =>
      typeof pane?.pane_id === "string"
      && pane.pane_id.length > 0
      && isAgentRuntimeStatus(pane.agent_status),
    );
}

export async function createCoordinatorRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  onChange: () => void,
  modelPolicy: ModelPolicyResolver,
): Promise<CoordinatorRuntime> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const parentPaneId = process.env.HERDR_PANE_ID;
  const parentWorkspaceId = process.env.HERDR_WORKSPACE_ID;
  const parentTabId = process.env.HERDR_TAB_ID;
  if (!socketPath || !parentPaneId || !parentWorkspaceId || !parentTabId) {
    throw new Error("Herdr environment is incomplete for holistic-subagents");
  }
  const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
  const store = new PiSessionDelegationStore(branch, (type, data) => pi.appendEntry(type, data));
  const repository = new DelegationRepository(store);
  const client = new HerdrClient(socketPath);
  const runner: CommandRunner = {
    async run(command, args, cwd) {
      const result = await pi.exec(command, args, { cwd });
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    },
  };
  const service = new DelegationService({
    repository,
    herdr: client,
    runner,
    identity: {
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentPaneId,
      parentWorkspaceId,
      parentTabId,
    },
    availableModels: () => availableModels(ctx),
    modelPolicy,
  });
  const snapshot = await client.connect();
  if (!isSafeReconciliationSnapshot(snapshot)) {
    throw new Error("Herdr snapshot is incomplete; coordinator runtime was not reconciled");
  }
  service.reconcile(snapshot);
  const handleEvent = createInfrastructureEventHandler(service, ctx, onChange);
  const unsubscribers = new Map<string, () => void>();
  const runtime: CoordinatorRuntime = {
    service,
    client,
    async syncSubscriptions() {
      const paneIds = new Set(
        service
          .list()
          .filter((delegation) => isActiveState(delegation.state))
          .flatMap((delegation) =>
            delegation.resources
              .filter((resource) => resource.kind === "pane" && !resource.removedAt)
              .map((resource) => resource.id),
          ),
      );
      for (const [paneId, unsubscribe] of unsubscribers) {
        if (!paneIds.has(paneId)) {
          unsubscribe();
          unsubscribers.delete(paneId);
        }
      }
      for (const paneId of paneIds) {
        if (unsubscribers.has(paneId)) continue;
        const unsubscribe = await client.subscribe(
          [{ type: "pane.agent_status_changed", pane_id: paneId }],
          (event) => {
            void handleEvent(event);
          },
        );
        unsubscribers.set(paneId, unsubscribe);
      }
    },
    close() {
      for (const unsubscribe of unsubscribers.values()) unsubscribe();
      unsubscribers.clear();
      client.close();
    },
  };
  await runtime.syncSubscriptions();
  return runtime;
}

export function availableModels(ctx: ExtensionContext): AvailableModel[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
    input: model.input.filter((input): input is "text" | "image" => input === "text" || input === "image"),
  }));
}
