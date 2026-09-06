export const limits = {
  requestBytes: 256 * 1024,
  responseBytes: 1024 * 1024,
  outputBytes: 256 * 1024,
  backgroundBytes: 64 * 1024,
  attachmentBytes: 512 * 1024,
  snapshotBytes: 4 * 1024 * 1024,
  bindingBytes: 1024 * 1024,
  bindings: 512,
  journalBytes: 16 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
  startupMs: 30_000,
  interruptMs: 1500,
  shutdownMs: 5000,
  diagnosticsMs: 5000,
  codeMs: 120_000,
  cellMs: 300_000,
  waitMs: 30_000,
  maxHeapMiB: 512,
  concurrentCode: 4,
  retainedExecutions: 64,
  nestedCalls: 64,
  nestedParallel: 8,
  nestedDepth: 1,
} as const;
export type Limits = { [K in keyof typeof limits]: number };
export function configureLimits(overrides: Partial<Limits> = {}): Limits {
  const result = { ...limits, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid limit: ${key}`);
  }
  return result;
}
