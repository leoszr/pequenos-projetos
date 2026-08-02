import { randomUUID } from "node:crypto";

import {
  LEGACY_STORE_CUSTOM_TYPE,
  STORE_CUSTOM_TYPE,
  STORE_VERSION,
  type AgentSession,
  type Delegation,
  type DelegationEventKind,
  type DelegationRequest,
  type DelegationResource,
  type DelegationStorePort,
  type DelegationStoreRecord,
  type ModelResolution,
  type RunState,
  type SessionEntryLike,
} from "./types.ts";

interface LegacyStoreRecord {
  eventId: string;
  delegationId: string;
  kind: DelegationEventKind;
  at: string;
  snapshot: LegacyDelegation;
}

interface LegacyDelegation {
  id: string;
  parentSessionId: string;
  parentPaneId: string;
  callbackToken: string;
  state: string;
  request: DelegationRequest;
  purpose: Delegation["purpose"];
  reviewOf?: string;
  reviewerIds?: string[];
  modelResolution?: ModelResolution;
  resources?: DelegationResource[];
  questions?: Delegation["questions"];
  evidence?: Delegation["evidence"];
  authorityBaseline?: Delegation["authorityBaseline"];
  runtimeCwd?: string;
  health?: string;
  failure?: string;
  createdAt: string;
  updatedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isV2Record(value: unknown): value is DelegationStoreRecord {
  if (!isObject(value)) return false;
  return value.version === STORE_VERSION
    && typeof value.eventId === "string"
    && (value.entity === "run" || value.entity === "session")
    && typeof value.entityId === "string"
    && isObject(value.snapshot);
}

function isLegacyRecord(value: unknown): value is LegacyStoreRecord {
  if (!isObject(value) || !isObject(value.snapshot)) return false;
  return typeof value.eventId === "string"
    && typeof value.delegationId === "string"
    && typeof value.kind === "string"
    && typeof value.at === "string"
    && typeof value.snapshot.id === "string"
    && isObject(value.snapshot.request);
}

/**
 * Branch-order adapter. Every v1 snapshot produces a replacement v2 Session
 * and Run snapshot, so later legacy events deterministically win during replay.
 * Migrated Sessions are sealed and can never receive a new Run.
 */
export function recordsFromSessionEntries(
  entries: readonly SessionEntryLike[],
): DelegationStoreRecord[] {
  const records: DelegationStoreRecord[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === STORE_CUSTOM_TYPE && isV2Record(entry.data)) {
      if (!seen.has(entry.data.eventId)) {
        seen.add(entry.data.eventId);
        records.push(structuredClone(entry.data));
      }
      continue;
    }
    if (entry.customType !== LEGACY_STORE_CUSTOM_TYPE || !isLegacyRecord(entry.data)) {
      continue;
    }
    if (seen.has(`legacy:${entry.data.eventId}`)) continue;
    seen.add(`legacy:${entry.data.eventId}`);
    records.push(...adaptLegacyRecord(entry.data));
  }
  return records;
}

function adaptLegacyRecord(record: LegacyStoreRecord): DelegationStoreRecord[] {
  const legacy = record.snapshot;
  const sessionId = `legacy-session-${legacy.id}`;
  const modelResolution = legacy.modelResolution ?? legacyModelResolution(legacy.request);
  const terminal = ["accepted", "failed", "closing", "closed"].includes(legacy.state);
  const run: Delegation = {
    version: STORE_VERSION,
    id: legacy.id,
    sessionId,
    parentSessionId: legacy.parentSessionId,
    parentPaneId: legacy.parentPaneId,
    callbackToken: legacy.callbackToken,
    state: legacyRunState(legacy.state),
    request: structuredClone(legacy.request),
    purpose: legacy.purpose,
    reviewOf: legacy.reviewOf,
    reviewerIds: structuredClone(legacy.reviewerIds ?? []),
    modelResolution,
    resources: [],
    questions: structuredClone(legacy.questions ?? []),
    evidence: structuredClone(legacy.evidence ?? []),
    authorityBaseline: structuredClone(legacy.authorityBaseline),
    runtimeCwd: legacy.runtimeCwd,
    health: legacy.health,
    failure: legacy.failure,
    revision: 0,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
  const session: AgentSession = {
    version: STORE_VERSION,
    id: sessionId,
    ownershipId: legacy.id,
    parentSessionId: legacy.parentSessionId,
    parentPaneId: legacy.parentPaneId,
    state: terminal ? (legacy.state === "failed" ? "failed" : "closed") : "busy",
    activeRunId: terminal ? undefined : legacy.id,
    sealed: true,
    trustScope: legacy.authorityBaseline?.gitRoot ?? legacy.request.cwd,
    authorityCeiling: structuredClone(legacy.request.authority),
    modelResolution,
    topology: legacy.request.topology,
    cwd: legacy.runtimeCwd ?? legacy.request.cwd,
    runtimeCwd: legacy.runtimeCwd,
    resources: structuredClone(legacy.resources ?? []),
    authorityBaseline: structuredClone(legacy.authorityBaseline),
    callbackToken: legacy.callbackToken,
    health: legacy.health,
    failure: legacy.failure,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    lastUsedAt: legacy.updatedAt,
  };
  return [
    sessionRecord(session, record.kind, record.at, `v1-session-${record.eventId}`),
    runRecord(run, record.kind, record.at, `v1-run-${record.eventId}`),
  ];
}

function legacyRunState(state: string): RunState {
  if (state === "closing" || state === "closed") return "cancelled";
  const states: RunState[] = [
    "prepared", "starting", "working", "awaiting_input", "ready_for_review",
    "correcting", "accepted", "failed", "cancelled",
  ];
  return states.includes(state as RunState) ? state as RunState : "failed";
}

function legacyModelResolution(request: DelegationRequest): ModelResolution {
  const purpose = request.purpose ?? (request.reviewOf ? "verification" : "execution");
  return {
    model: "legacy/unknown",
    provider: "legacy",
    family: "legacy",
    thinking: request.model.effort ?? "off",
    requestedCapability: request.model.minimumCapability,
    providedCapability: request.model.minimumCapability,
    degradedCapability: false,
    exactThinking: true,
    alternatives: [],
    reason: "Recovered from v1 without a recorded model resolution",
    requestedEffort: request.model.effort ?? "auto",
    effectiveEffort: request.model.effort ?? "off",
    purpose,
  };
}

function runRecord(
  snapshot: Delegation,
  kind: DelegationEventKind,
  at: string,
  eventId: string = randomUUID(),
): DelegationStoreRecord {
  return {
    version: STORE_VERSION,
    eventId,
    kind,
    at,
    entity: "run",
    entityId: snapshot.id,
    delegationId: snapshot.id,
    snapshot: structuredClone(snapshot),
  };
}

function sessionRecord(
  snapshot: AgentSession,
  kind: DelegationEventKind,
  at: string,
  eventId: string = randomUUID(),
): DelegationStoreRecord {
  return {
    version: STORE_VERSION,
    eventId,
    kind,
    at,
    entity: "session",
    entityId: snapshot.id,
    snapshot: structuredClone(snapshot),
  };
}

export class DelegationRepository {
  readonly #store: DelegationStorePort;
  readonly #runs = new Map<string, Delegation>();
  readonly #sessions = new Map<string, AgentSession>();

  constructor(store: DelegationStorePort) {
    this.#store = store;
    for (const record of store.records()) {
      if (record.entity === "run") {
        this.#runs.set(record.entityId, structuredClone(record.snapshot));
      } else {
        this.#sessions.set(record.entityId, structuredClone(record.snapshot));
      }
    }
    this.#recoverSessions();
  }

  list(): Delegation[] {
    return [...this.#runs.values()].map((run) => this.#project(run));
  }

  get(id: string): Delegation | undefined {
    const run = this.#runs.get(id);
    return run ? this.#project(run) : undefined;
  }

  listSessions(): AgentSession[] {
    return [...this.#sessions.values()].map((session) => structuredClone(session));
  }

  getSession(id: string): AgentSession | undefined {
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  save(snapshot: Delegation, kind: DelegationEventKind): DelegationStoreRecord {
    const stored = { ...snapshot, version: STORE_VERSION, resources: [] };
    const record = runRecord(stored, kind, snapshot.updatedAt);
    this.#store.append(record);
    this.#runs.set(snapshot.id, structuredClone(stored));
    return record;
  }

  saveSession(
    snapshot: AgentSession,
    kind: DelegationEventKind,
  ): DelegationStoreRecord {
    const stored = { ...snapshot, version: STORE_VERSION };
    const record = sessionRecord(stored, kind, snapshot.updatedAt);
    this.#store.append(record);
    this.#sessions.set(snapshot.id, structuredClone(stored));
    return record;
  }

  #project(run: Delegation): Delegation {
    const session = this.#sessions.get(run.sessionId);
    return structuredClone({
      ...run,
      resources: session?.resources ?? [],
      runtimeCwd: run.runtimeCwd ?? (session?.sealed ? session.runtimeCwd : undefined),
      health: run.health ?? (session?.sealed ? session.health : undefined),
      authorityBaseline: run.authorityBaseline
        ?? (session?.sealed ? session.authorityBaseline : undefined),
    });
  }

  /** Repairs a terminal Run persisted before its corresponding Session state. */
  #recoverSessions(): void {
    for (const session of this.#sessions.values()) {
      if (session.sealed) continue;
      if (session.state === "starting" && !session.activeRunId) {
        this.#quarantineOrphan(session, "Session startup has no persisted Run");
        continue;
      }
      if (session.state !== "busy" || !session.activeRunId) continue;
      const run = this.#runs.get(session.activeRunId);
      if (!run) {
        this.#quarantineOrphan(session, `active Run ${session.activeRunId} is missing`);
        continue;
      }
      if (!["accepted", "failed", "cancelled"].includes(run.state)) continue;
      const accepted = run.state === "accepted";
      const repaired: AgentSession = {
        ...session,
        state: accepted ? "idle" : "failed",
        activeRunId: undefined,
        failure: accepted ? session.failure : run.failure ?? `active Run ended as ${run.state}`,
        updatedAt: run.updatedAt,
        lastUsedAt: run.updatedAt,
      };
      this.#sessions.set(repaired.id, structuredClone(repaired));
      this.#store.append(sessionRecord(repaired, "transition", repaired.updatedAt));
    }
  }

  #quarantineOrphan(session: AgentSession, failure: string): void {
    const repaired: AgentSession = {
      ...session,
      state: "failed",
      activeRunId: undefined,
      health: "failed",
      failure,
      updatedAt: session.updatedAt,
    };
    this.#sessions.set(repaired.id, structuredClone(repaired));
    this.#store.append(sessionRecord(repaired, "transition", repaired.updatedAt));
  }
}

export class InMemoryDelegationStore implements DelegationStorePort {
  readonly entries: DelegationStoreRecord[];

  constructor(entries: DelegationStoreRecord[] = []) {
    this.entries = structuredClone(entries);
  }

  append(record: DelegationStoreRecord): void {
    this.entries.push(structuredClone(record));
  }

  records(): DelegationStoreRecord[] {
    return structuredClone(this.entries);
  }
}

export class PiSessionDelegationStore implements DelegationStorePort {
  readonly #appendEntry: (customType: string, data: unknown) => void;
  readonly #entries: DelegationStoreRecord[];

  constructor(
    branchEntries: readonly SessionEntryLike[],
    appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.#entries = recordsFromSessionEntries(branchEntries);
    this.#appendEntry = appendEntry;
  }

  append(record: DelegationStoreRecord): void {
    this.#appendEntry(STORE_CUSTOM_TYPE, structuredClone(record));
    this.#entries.push(structuredClone(record));
  }

  records(): DelegationStoreRecord[] {
    return structuredClone(this.#entries);
  }
}
