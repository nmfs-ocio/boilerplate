/**
 * storage-manager — framework-agnostic helpers around the browser StorageManager
 * API (`navigator.storage`).
 *
 * Everything here feature-detects and degrades gracefully so callers never touch
 * `navigator.storage` or its null-checks directly. On browsers/contexts where the
 * API is missing (older Safari < 17, in-app webviews, non-secure contexts), the
 * estimate reports `supported: false` rather than throwing.
 *
 * IMPORTANT: `estimate()` returns ORIGIN-WIDE usage/quota — the browser gives no
 * per-database breakdown (except Chromium's non-standard `usageDetails`). The
 * numbers are an approximation, not a guarantee: quota is derived from total disk,
 * padded for privacy, and drifts. Treat it as an advisory signal, not a budget.
 */

export const DEFAULT_WARN_AT = 0.8;
export const DEFAULT_CRITICAL_AT = 0.9;

const hasStorageManager = () =>
  typeof navigator !== "undefined" && navigator.storage != null;

const canEstimate = () =>
  hasStorageManager() && typeof navigator.storage.estimate === "function";

/** 'ok' | 'warning' | 'critical' from a fraction-used and thresholds. */
export function levelFor(percentUsed, warnAt = DEFAULT_WARN_AT, criticalAt = DEFAULT_CRITICAL_AT) {
  if (percentUsed == null) return "ok";
  if (percentUsed >= criticalAt) return "critical";
  if (percentUsed >= warnAt) return "warning";
  return "ok";
}

/** Current persistence state; false when unsupported or on error. */
export async function isPersisted() {
  if (hasStorageManager() && typeof navigator.storage.persisted === "function") {
    try {
      return await navigator.storage.persisted();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * @typedef {Object} StorageSnapshot
 * @property {boolean} supported      estimate() available in this browser/context
 * @property {number=} usageBytes     origin-wide bytes used (undefined if unsupported)
 * @property {number=} quotaBytes     origin-wide bytes available (undefined if unsupported)
 * @property {number=} remainingBytes quotaBytes - usageBytes (undefined if unsupported)
 * @property {number|null} percentUsed 0..1, or null if unknown
 * @property {'ok'|'warning'|'critical'} level
 * @property {boolean} persisted      navigator.storage.persisted()
 * @property {Object|null} usageDetails Chromium-only per-system breakdown, else null
 */

/**
 * Read a fresh storage estimate. Never throws.
 * @param {{ warnAt?: number, criticalAt?: number }} [options]
 * @returns {Promise<StorageSnapshot>}
 */
export async function getStorageEstimate({ warnAt = DEFAULT_WARN_AT, criticalAt = DEFAULT_CRITICAL_AT } = {}) {
  const persisted = await isPersisted();

  if (!canEstimate()) {
    return {
      supported: false,
      usageBytes: undefined,
      quotaBytes: undefined,
      remainingBytes: undefined,
      percentUsed: null,
      level: "ok",
      persisted,
      usageDetails: null,
    };
  }

  let estimate;
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return {
      supported: false,
      usageBytes: undefined,
      quotaBytes: undefined,
      remainingBytes: undefined,
      percentUsed: null,
      level: "ok",
      persisted,
      usageDetails: null,
    };
  }

  const usageBytes = estimate.usage ?? 0;
  const quotaBytes = estimate.quota ?? 0;
  const percentUsed = quotaBytes > 0 ? usageBytes / quotaBytes : null;

  return {
    supported: true,
    usageBytes,
    quotaBytes,
    remainingBytes: quotaBytes > 0 ? Math.max(0, quotaBytes - usageBytes) : undefined,
    percentUsed,
    level: levelFor(percentUsed, warnAt, criticalAt),
    persisted,
    usageDetails: estimate.usageDetails ?? null,
  };
}

/**
 * Request persistent storage (exempts the origin from best-effort eviction).
 * Best called from a user gesture — Firefox prompts; Chrome/Safari grant on
 * heuristics (installed PWA, engagement). Returns false when unsupported.
 * @returns {Promise<boolean>}
 */
export async function requestPersistence() {
  if (hasStorageManager() && typeof navigator.storage.persist === "function") {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Tri-state persistence capability (à la Dexie): more actionable than a bare
 * boolean — the app can branch on whether persistence is already on, hopeless,
 * or grantable via a user gesture.
 * @returns {Promise<'persisted'|'prompt'|'never'>}
 */
export async function getPersistenceStatus() {
  if (!(hasStorageManager() && typeof navigator.storage.persisted === "function")) {
    return "never";
  }
  try {
    if (await navigator.storage.persisted()) return "persisted";
  } catch {
    return "never";
  }

  // Not yet persisted — is it grantable? Prefer the Permissions API when present.
  if (typeof navigator.permissions?.query === "function") {
    try {
      const status = await navigator.permissions.query({ name: "persistent-storage" });
      if (status.state === "granted") return "persisted";
      if (status.state === "denied") return "never";
      return "prompt";
    } catch {
      // fall through to the persist() heuristic below
    }
  }

  // No Permissions API, but persist() exists → a request is at least possible.
  return typeof navigator.storage.persist === "function" ? "prompt" : "never";
}
