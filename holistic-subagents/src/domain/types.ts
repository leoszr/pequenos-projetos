import type { HandoffManifest } from "../protocol/handoff.ts";

export const STORE_VERSION = 2 as const;
export const STORE_CUSTOM_TYPE = "holistic-delegation-v2";

export type RunState =
  | "prepared"
  | "starting"
  | "working"
  | "awaiting_input"
  | "ready_for_review"
  | "correcting"
  | "accepted"
  | "failed"
  | "cancelled";
export type DelegationState = RunState;
export type AgentSessionState =
  | "starting"
  | "idle"
  | "busy"
  | "closing"
  | "closed"
  | "failed";

export const AGENT_RUNTIME_STATUSES = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
] as const;
export type AgentRuntimeStatus = (typeof AGENT_RUNTIME_STATUSES)[number];

export function isAgentRuntimeStatus(value: unknown): value is AgentRuntimeStatus {
  return typeof value === "string"
    && (AGENT_RUNTIME_STATUSES as readonly string[]).includes(value);
}

export const DELEGATION_PURPOSES = ["execution", "verification"] as const;
export type DelegationPurpose = (typeof DELEGATION_PURPOSES)[number];
export type DelegationTopology = "pane" | "tab" | "worktree";
export type AuthorityMode =
  | "read_only"
  | "controlled_mutation"
  | "isolated_mutation";
export const CAPABILITIES = [
  "bounded",
  "scoped",
  "cross_cutting",
  "high_agency",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface AuthorityPolicy {
  mode: AuthorityMode;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  requireExternalSandbox?: boolean;
}

export interface TechnicalRequirements {
  minContextWindow?: number;
  modalities?: Array<"text" | "image">;
  tools?: string[];
  harness?: string[];
  maxLatencyRank?: number;
  maxCostRank?: number;
}

export interface IndependenceRequirement {
  required: boolean;
  avoidFamily?: string;
}

export interface ModelRequest {
  minimumCapability: Capability;
  effort?: ThinkingLevel;
  purpose?: DelegationPurpose;
  requirements?: TechnicalRequirements;
  independence?: IndependenceRequirement;
  allowDegraded?: boolean;
}

export interface ModelResolution {
  model: string;
  provider: string;
  family: string;
  thinking: ThinkingLevel;
  requestedCapability: Capability;
  providedCapability: Capability;
  degradedCapability: boolean;
  exactThinking: boolean;
  alternatives: string[];
  reason: string;
  requestedEffort: ThinkingLevel | "auto";
  effectiveEffort: ThinkingLevel;
  purpose: DelegationPurpose;
}

export interface DelegationRequest {
  name: string;
  mission: string;
  context?: string;
  cwd: string;
  authority: AuthorityPolicy;
  acceptanceEvidence: string[];
  topology: DelegationTopology;
  model: ModelRequest;
  purpose?: DelegationPurpose;
  reviewOf?: string;
  baseRef?: string;
  branch?: string;
  requiresCleanContext?: boolean;
}

export type ResourceKind =
  | "pane"
  | "tab"
  | "workspace"
  | "worktree"
  | "branch"
  | "process"
  | "artifact";

export interface DelegationResource {
  kind: ResourceKind;
  id: string;
  createdByExtension: boolean;
  ownershipToken: string;
  /** Shared coordinator resource; a Session must not remove it directly. */
  shared?: boolean;
  path?: string;
  label?: string;
  preserved?: boolean;
  removedAt?: string;
}

export interface DelegationQuestion {
  id: string;
  blocking: boolean;
  summary: string;
  openedAt: string;
  answeredAt?: string;
  answer?: string;
}

export interface DelegationEvidence {
  capturedAt: string;
  paneOutput?: string;
  gitStatus?: string;
  changedPaths?: string[];
  commands?: string[];
}

export interface AuthorityBaseline {
  capturedAt: string;
  gitRoot?: string;
  head?: string;
  statusLines: string[];
}

export interface AcceptanceTicket {
  token: string;
  revision: number;
  inspectedAt: string;
  cycleId?: string;
  mutationSequence?: number;
  manifestSha256?: string;
}

export interface HandoffCycle {
  id?: string;
  /** The child emitted HOLISTIC_HANDOFF_READY during this cycle. */
  claimed?: true;
  manifestId?: string;
  manifestSha256?: string;
  /** Validated structured evidence captured by holistic_inspect. */
  manifest?: HandoffManifest;
  /** Guards an in-flight live confirmation of an idle runtime event. */
  pendingIdleConfirmation?: string;
  /** Herdr observed Pi working during this cycle. */
  working?: true;
  /** Herdr observed Pi settle after working during this cycle. */
  settled?: true;
  /** A follow-up dispatch is in flight; a concurrent dispatch must not send. */
  dispatchPending?: true;
  /** A follow-up request may have reached Herdr after its response timed out. */
  effectMayHaveOccurred?: true;
}

export interface ArtifactRootRegistration {
  id: string;
  path: string;
  durable: boolean;
  createdAt: string;
  ownershipToken: string;
  removedAt?: string;
}

export interface AgentSession {
  version: typeof STORE_VERSION;
  id: string;
  /** Identity written into Herdr ownership metadata. */
  ownershipId: string;
  parentSessionId: string;
  parentPaneId: string;
  state: AgentSessionState;
  /** Monotonic version for every persisted Session/active-Run mutation. */
  mutationSequence: number;
  activeRunId?: string;
  trustScope: string;
  authorityCeiling: AuthorityPolicy;
  modelResolution: ModelResolution;
  topology: DelegationTopology;
  cwd: string;
  runtimeCwd?: string;
  resources: DelegationResource[];
  artifactRoots: ArtifactRootRegistration[];
  authorityBaseline?: AuthorityBaseline;
  callbackToken: string;
  health?: string;
  failure?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

/** The single disposable data-plane root of a Session (ownership on the Session). */
export function temporaryArtifactRoot(
  session: AgentSession,
): ArtifactRootRegistration | undefined {
  return session.artifactRoots.find((root) => !root.durable && !root.removedAt);
}

/** Upserts a resource into a Session, replacing any prior resource of the same kind and id. */
export function upsertSessionResource(
  session: AgentSession,
  resource: DelegationResource,
): AgentSession {
  const resources = [...session.resources];
  const index = resources.findIndex(
    (item) => item.kind === resource.kind && item.id === resource.id,
  );
  if (index < 0) resources.push(resource);
  else resources[index] = resource;
  return { ...session, resources, updatedAt: new Date().toISOString() };
}

export interface DelegationRun {
  version: typeof STORE_VERSION;
  id: string;
  sessionId: string;
  parentSessionId: string;
  parentPaneId: string;
  callbackToken: string;
  state: RunState;
  request: DelegationRequest;
  purpose: DelegationPurpose;
  reviewOf?: string;
  reviewerIds: string[];
  modelResolution: ModelResolution;
  questions: DelegationQuestion[];
  evidence: DelegationEvidence[];
  authorityBaseline?: AuthorityBaseline;
  runtimeCwd?: string;
  health?: string;
  failure?: string;
  handoff?: HandoffCycle;
  revision: number;
  acceptanceTicket?: AcceptanceTicket;
  createdAt: string;
  updatedAt: string;
  /** Compatibility projection; ownership remains on AgentSession. */
  resources: DelegationResource[];
}
export type Delegation = DelegationRun;

export type DelegationEventKind =
  | "created"
  | "transition"
  | "resource"
  | "model"
  | "question"
  | "evidence"
  | "relation"
  | "health";

export interface RunStoreRecord {
  version: typeof STORE_VERSION;
  eventId: string;
  kind: DelegationEventKind;
  at: string;
  entity: "run";
  entityId: string;
  snapshot: DelegationRun;
  delegationId?: string;
}

export interface SessionStoreRecord {
  version: typeof STORE_VERSION;
  eventId: string;
  kind: DelegationEventKind;
  at: string;
  entity: "session";
  entityId: string;
  snapshot: AgentSession;
}

export type DelegationStoreRecord = RunStoreRecord | SessionStoreRecord;

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface DelegationStorePort {
  append(record: DelegationStoreRecord): void;
  records(): DelegationStoreRecord[];
}

export interface RuntimeIdentity {
  parentSessionId: string;
  parentPaneId: string;
}
