import { randomUUID } from "node:crypto";

import {
  STORE_CUSTOM_TYPE,
  STORE_VERSION,
  type Delegation,
  type DelegationEventKind,
  type DelegationStorePort,
  type DelegationStoreRecord,
  type SessionEntryLike,
} from "./types.ts";

function isRecord(value: unknown): value is DelegationStoreRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DelegationStoreRecord>;
  return (
    record.version === STORE_VERSION &&
    typeof record.eventId === "string" &&
    typeof record.delegationId === "string" &&
    typeof record.snapshot === "object" &&
    record.snapshot !== null
  );
}

export function recordsFromSessionEntries(
  entries: readonly SessionEntryLike[],
): DelegationStoreRecord[] {
  const seen = new Set<string>();
  const records: DelegationStoreRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STORE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data) || seen.has(entry.data.eventId)) continue;
    seen.add(entry.data.eventId);
    records.push(structuredClone(entry.data));
  }
  return records;
}

export function rebuildDelegations(
  records: readonly DelegationStoreRecord[],
): Map<string, Delegation> {
  const snapshots = new Map<string, Delegation>();
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.eventId)) continue;
    seen.add(record.eventId);
    snapshots.set(record.delegationId, structuredClone(record.snapshot));
  }
  return snapshots;
}

export class DelegationRepository {
  readonly #store: DelegationStorePort;
  readonly #delegations = new Map<string, Delegation>();

  constructor(store: DelegationStorePort) {
    this.#store = store;
    for (const [id, value] of rebuildDelegations(store.records())) {
      this.#delegations.set(id, value);
    }
  }

  list(): Delegation[] {
    return [...this.#delegations.values()].map((value) => structuredClone(value));
  }

  get(id: string): Delegation | undefined {
    const value = this.#delegations.get(id);
    return value ? structuredClone(value) : undefined;
  }

  save(snapshot: Delegation, kind: DelegationEventKind): DelegationStoreRecord {
    const record: DelegationStoreRecord = {
      version: STORE_VERSION,
      eventId: randomUUID(),
      delegationId: snapshot.id,
      kind,
      at: snapshot.updatedAt,
      snapshot: structuredClone(snapshot),
    };
    this.#store.append(record);
    this.#delegations.set(snapshot.id, structuredClone(snapshot));
    return record;
  }
}

export class InMemoryDelegationStore implements DelegationStorePort {
  readonly entries: DelegationStoreRecord[];

  constructor(entries: DelegationStoreRecord[] = []) {
    this.entries = entries.map((entry) => structuredClone(entry));
  }

  append(record: DelegationStoreRecord): void {
    this.entries.push(structuredClone(record));
  }

  records(): DelegationStoreRecord[] {
    return this.entries.map((entry) => structuredClone(entry));
  }
}

export class PiSessionDelegationStore implements DelegationStorePort {
  readonly #appendEntry: (customType: string, data: unknown) => void;
  #entries: DelegationStoreRecord[];

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
    return this.#entries.map((entry) => structuredClone(entry));
  }
}
