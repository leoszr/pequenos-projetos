import type { AgentSession, DelegationResource } from "../domain/types.ts";

const MAX_PANES_PER_TAB = 3;

export interface SharedTabTarget {
  tabId: string;
  anchorPaneId: string;
}

export function findSharedTabTarget(
  sessions: readonly AgentSession[],
  coordinatorTabId: string,
): SharedTabTarget | undefined {
  const tabs = new Map<string, { paneIds: Set<string>; lastUsedAt: string }>();
  for (const session of sessions) {
    if (session.topology !== "pane") continue;
    const tab = session.resources.find((resource) =>
      isSharedTabResource(resource)
      && !resource.removedAt
      && resource.id !== coordinatorTabId
    );
    const pane = session.resources.find((resource) =>
      resource.kind === "pane" && !resource.removedAt
    );
    if (!tab || !pane) continue;
    const current = tabs.get(tab.id) ?? {
      paneIds: new Set<string>(),
      lastUsedAt: session.lastUsedAt,
    };
    current.paneIds.add(pane.id);
    if (session.lastUsedAt > current.lastUsedAt) current.lastUsedAt = session.lastUsedAt;
    tabs.set(tab.id, current);
  }
  return [...tabs.entries()]
    .filter(([, value]) => value.paneIds.size < MAX_PANES_PER_TAB)
    .sort((left, right) =>
      right[1].paneIds.size - left[1].paneIds.size
      || right[1].lastUsedAt.localeCompare(left[1].lastUsedAt)
    )
    .map(([tabId, value]) => ({ tabId, anchorPaneId: [...value.paneIds][0]! }))[0];
}

export function sessionRunsOutsideCoordinatorTab(
  session: AgentSession,
  coordinatorTabId: string,
): boolean {
  if (session.topology === "worktree") return true;
  return session.resources.some((resource) =>
    resource.kind === "tab" && !resource.removedAt && resource.id !== coordinatorTabId
  );
}

export function sharedTabResource(
  id: string,
): Omit<DelegationResource, "createdByExtension" | "ownershipToken"> {
  return { kind: "tab", id, label: "Subagents", shared: true };
}

export function isSharedTabResource(resource: DelegationResource): boolean {
  return resource.kind === "tab" && resource.shared === true;
}
