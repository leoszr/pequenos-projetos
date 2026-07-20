export const STORE_VERSION = 1 as const;
export const STORE_CUSTOM_TYPE = "holistic-delegation-v1";

export type DelegationState =
  | "prepared"
  | "starting"
  | "working"
  | "awaiting_input"
  | "ready_for_review"
  | "correcting"
  | "accepted"
  | "failed"
  | "closing"
  | "closed";

export type DelegationPurpose = "execution" | "verification";
export type DelegationTopology = "pane" | "tab" | "worktree";
export type AuthorityMode =
  | "read_only"
  | "controlled_mutation"
  | "isolated_mutation";
export type Capability =
  | "bounded"
  | "scoped"
  | "cross_cutting"
  | "high_agency";
export type CanonicalEffort = "low" | "medium" | "high";

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
  avoidProvider?: "openai-codex" | "deepseek";
  avoidFamily?: string;
}

export interface ModelRequest {
  minimumCapability: Capability;
  effort: CanonicalEffort;
  requirements?: TechnicalRequirements;
  independence?: IndependenceRequirement;
  allowDegraded?: boolean;
}

export interface ModelResolution {
  model: string;
  provider: "openai-codex" | "deepseek";
  family: string;
  thinking: CanonicalEffort;
  requestedCapability: Capability;
  providedCapability: Capability;
  degradedCapability: boolean;
  exactThinking: boolean;
  alternatives: string[];
  reason: string;
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

export interface Delegation {
  version: typeof STORE_VERSION;
  id: string;
  parentSessionId: string;
  parentPaneId: string;
  callbackToken: string;
  state: DelegationState;
  request: DelegationRequest;
  purpose: DelegationPurpose;
  reviewOf?: string;
  reviewerIds: string[];
  modelResolution?: ModelResolution;
  resources: DelegationResource[];
  questions: DelegationQuestion[];
  evidence: DelegationEvidence[];
  authorityBaseline?: AuthorityBaseline;
  runtimeCwd?: string;
  health?: string;
  failure?: string;
  createdAt: string;
  updatedAt: string;
}

export type DelegationEventKind =
  | "created"
  | "transition"
  | "resource"
  | "model"
  | "question"
  | "evidence"
  | "relation"
  | "health";

export interface DelegationStoreRecord {
  version: typeof STORE_VERSION;
  eventId: string;
  delegationId: string;
  kind: DelegationEventKind;
  at: string;
  snapshot: Delegation;
}

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
