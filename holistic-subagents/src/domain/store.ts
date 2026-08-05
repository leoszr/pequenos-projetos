import { randomUUID } from "node:crypto";

import {
  STORE_CUSTOM_TYPE,
  STORE_VERSION,
  type AgentSession,
  type Delegation,
  type DelegationEventKind,
  type DelegationStorePort,
  type DelegationStoreRecord,
  type SessionEntryLike,
} from "./types.ts";

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

/** Branch-order adapter. v1 entries are ignored; only v2 records are replayed. */
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
        records.push(normalizeV2Record(entry.data));
      }
      continue;
    }
  }
  return records;
}

function normalizeV2Record(record: DelegationStoreRecord): DelegationStoreRecord {
  if (record.entity === "run") return structuredClone(record);
  return {
    ...structuredClone(record),
    snapshot: {
      ...structuredClone(record.snapshot),
      mutationSequence: Number.isSafeInteger(record.snapshot.mutationSequence)
        && record.snapshot.mutationSequence >= 0
        ? record.snapshot.mutationSequence
          : 0,
        artifactRoots: structuredClone(record.snapshot.artifactRoots ?? []),
    },
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
    for (const rawRecord of store.records()) {
      const record = normalizeV2Record(rawRecord);
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
    });
  }

  /** Repairs a terminal Run persisted before its corresponding Session state. */
  #recoverSessions(): void {
    for (const session of this.#sessions.values()) {
      if (session.state === "starting" && !session.activeRunId) {
        this.#quarantineOrphan(session, "Session startup has no persisted Run");
        continue;
      }
      if (!["starting", "busy"].includes(session.state) || !session.activeRunId) continue;
      const run = this.#runs.get(session.activeRunId);
      if (!run) {
        this.#quarantineOrphan(session, `active Run ${session.activeRunId} is missing`);
        continue;
      }
      if (!["accepted", "failed", "cancelled"].includes(run.state)) continue;
      const accepted = run.state === "accepted";
      const repaired: AgentSession = {
        ...session,
        mutationSequence: session.mutationSequence + 1,
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
      mutationSequence: session.mutationSequence + 1,
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
