// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getStorageEstimate,
  requestPersistence,
  getPersistenceStatus,
  levelFor,
} from "./index.js";

/**
 * The module reads `navigator.storage` (and optionally `navigator.permissions`)
 * dynamically. We install fakes per test and restore the originals after, so no
 * global state leaks between tests.
 */
let origStorage;
let origPermissions;

const define = (key, value) =>
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });

beforeEach(() => {
  origStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
  origPermissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
});

afterEach(() => {
  if (origStorage) Object.defineProperty(navigator, "storage", origStorage);
  else delete navigator.storage;
  if (origPermissions) Object.defineProperty(navigator, "permissions", origPermissions);
  else delete navigator.permissions;
});

describe("levelFor", () => {
  it("maps fraction-used to a level with default thresholds", () => {
    expect(levelFor(0.1)).toBe("ok");
    expect(levelFor(0.8)).toBe("warning");
    expect(levelFor(0.9)).toBe("critical");
    expect(levelFor(null)).toBe("ok");
  });

  it("honors custom thresholds", () => {
    expect(levelFor(0.5, 0.4, 0.6)).toBe("warning");
    expect(levelFor(0.7, 0.4, 0.6)).toBe("critical");
  });
});

describe("getStorageEstimate", () => {
  it("reports supported=false when navigator.storage is absent", async () => {
    define("storage", undefined);
    const snap = await getStorageEstimate();
    expect(snap.supported).toBe(false);
    expect(snap.percentUsed).toBeNull();
    expect(snap.level).toBe("ok");
    expect(snap.persisted).toBe(false);
    expect(snap.usageBytes).toBeUndefined();
  });

  it("computes usage/quota/percent/level when supported", async () => {
    define("storage", {
      estimate: async () => ({ usage: 25, quota: 100 }),
      persisted: async () => false,
    });
    const snap = await getStorageEstimate();
    expect(snap.supported).toBe(true);
    expect(snap.usageBytes).toBe(25);
    expect(snap.quotaBytes).toBe(100);
    expect(snap.remainingBytes).toBe(75);
    expect(snap.percentUsed).toBeCloseTo(0.25);
    expect(snap.level).toBe("ok");
  });

  it("flags warning and critical levels", async () => {
    define("storage", { estimate: async () => ({ usage: 85, quota: 100 }), persisted: async () => false });
    expect((await getStorageEstimate()).level).toBe("warning");

    define("storage", { estimate: async () => ({ usage: 95, quota: 100 }), persisted: async () => false });
    expect((await getStorageEstimate()).level).toBe("critical");
  });

  it("passes through Chromium usageDetails and persisted state", async () => {
    define("storage", {
      estimate: async () => ({ usage: 10, quota: 100, usageDetails: { indexedDB: 8, caches: 2 } }),
      persisted: async () => true,
    });
    const snap = await getStorageEstimate();
    expect(snap.usageDetails).toEqual({ indexedDB: 8, caches: 2 });
    expect(snap.persisted).toBe(true);
  });

  it("degrades to supported=false if estimate() throws", async () => {
    define("storage", { estimate: async () => { throw new Error("nope"); }, persisted: async () => false });
    const snap = await getStorageEstimate();
    expect(snap.supported).toBe(false);
  });

  it("handles a zero/absent quota without dividing by zero", async () => {
    define("storage", { estimate: async () => ({ usage: 0, quota: 0 }), persisted: async () => false });
    const snap = await getStorageEstimate();
    expect(snap.percentUsed).toBeNull();
    expect(snap.level).toBe("ok");
  });
});

describe("requestPersistence", () => {
  it("returns the browser's grant result", async () => {
    define("storage", { persist: async () => true });
    expect(await requestPersistence()).toBe(true);

    define("storage", { persist: async () => false });
    expect(await requestPersistence()).toBe(false);
  });

  it("returns false when unsupported", async () => {
    define("storage", undefined);
    expect(await requestPersistence()).toBe(false);
  });
});

describe("getPersistenceStatus", () => {
  it("returns 'persisted' when already persisted", async () => {
    define("storage", { persisted: async () => true });
    expect(await getPersistenceStatus()).toBe("persisted");
  });

  it("returns 'never' when unsupported", async () => {
    define("storage", undefined);
    expect(await getPersistenceStatus()).toBe("never");
  });

  it("uses the Permissions API to distinguish grantable from denied", async () => {
    define("storage", { persisted: async () => false, persist: async () => false });

    define("permissions", { query: async () => ({ state: "granted" }) });
    expect(await getPersistenceStatus()).toBe("persisted");

    define("permissions", { query: async () => ({ state: "denied" }) });
    expect(await getPersistenceStatus()).toBe("never");

    define("permissions", { query: async () => ({ state: "prompt" }) });
    expect(await getPersistenceStatus()).toBe("prompt");
  });

  it("falls back to 'prompt' when persist() exists but no Permissions API", async () => {
    define("storage", { persisted: async () => false, persist: async () => true });
    define("permissions", undefined);
    expect(await getPersistenceStatus()).toBe("prompt");
  });
});
