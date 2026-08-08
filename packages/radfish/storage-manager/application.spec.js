// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Application } from "../index.js";

/**
 * Integration: the Application's storage-manager surface end-to-end, with a
 * mocked navigator.storage. Covers the init snapshot, storage:pressure emission,
 * persistence, and RADFish-specific augmentation (logsBytes + databases).
 */
const define = (key, value) =>
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });

let origStorage;
let origPermissions;

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

describe("Application storage-manager integration", () => {
  it("captures a snapshot at init, augmented with logsBytes + databases", async () => {
    define("storage", { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;

    expect(app.storageEstimate).not.toBeNull();
    expect(app.storageEstimate.supported).toBe(true);
    expect(app.storageEstimate.percentUsed).toBeCloseTo(0.1);
    expect(app.storageEstimate.logsBytes).toBeNull(); // no logger configured
    expect(app.storageEstimate.databases).toEqual([]); // no stores configured
  });

  it("emits storage:pressure at init when usage is at a critical level", async () => {
    define("storage", { estimate: async () => ({ usage: 95, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: { warnAt: 0.8, criticalAt: 0.9 } });

    const events = [];
    app.on("storage:pressure", (e) => events.push(e.detail)); // registered before the async snapshot fires

    await app._initializationPromise;

    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("critical");
  });

  it("emits storage:pressure when RADFish usage rises, and storage:ok on recovery", async () => {
    define("storage", { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: { warnAt: 0.8, criticalAt: 0.9 } });
    // Give the app measurable RADFish usage so the simulated quota is meaningful
    // (simulation now measures radfishBytes against the fake quota, not origin usage).
    app.logger = { persistence: { usage: async () => 10, dbName: "app-logs" } };
    const pressure = [];
    const oks = [];
    app.on("storage:pressure", (e) => pressure.push(e.detail.level));
    app.on("storage:ok", () => oks.push(true));
    await app._initializationPromise;
    await app.getStorageEstimate(); // baseline with logger attached
    expect(pressure).toEqual([]); // radfishBytes(10) / real quota(100) = ok

    // shrink the simulated quota so radfishBytes (10) is now 100% -> critical
    app.simulateQuota(10);
    await app.getStorageEstimate();
    expect(pressure).toEqual(["critical"]);
    expect(app.storageEstimate.simulated).toBe(true);

    // staying critical must not re-emit
    await app.getStorageEstimate();
    expect(pressure).toEqual(["critical"]);

    // clearing the simulation drops back to ok AND emits a recovery event
    app.simulateQuota(null);
    await app.getStorageEstimate();
    expect(app.storageEstimate.level).toBe("ok");
    expect(oks).toEqual([true]);
  });

  it("does not emit storage:pressure when usage is fine", async () => {
    define("storage", { estimate: async () => ({ usage: 5, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: {} });
    const events = [];
    app.on("storage:pressure", (e) => events.push(e.detail));
    await app._initializationPromise;
    expect(events).toHaveLength(0);
  });

  it("getStorageEstimate() augments with the logger's byte usage", async () => {
    define("storage", { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;

    // stand in a logger + store after init to exercise the augmentation
    app.logger = { persistence: { usage: async () => 2048, dbName: "radfish-app-logs" } };
    app.stores = { catchReports: { connector: { dbName: "catch-store" } } };

    const snap = await app.getStorageEstimate();
    expect(snap.logsBytes).toBe(2048);
    expect(snap.databases).toEqual(["catch-store", "radfish-app-logs"]);
  });

  it("aggregates per-store bytes into stores / storesBytes / radfishBytes", async () => {
    define("storage", { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;

    app.logger = { persistence: { usage: async () => 500, dbName: "radfish-app-logs" } };
    app.stores = {
      catchData: { connector: { dbName: "radfish-catch-data", usage: async () => 2000 } },
      otherData: { connector: { dbName: "other-db", usage: async () => 300 } },
    };

    const snap = await app.getStorageEstimate();
    expect(snap.logsBytes).toBe(500);
    expect(snap.stores).toEqual({ "radfish-catch-data": 2000, "other-db": 300 });
    expect(snap.storesBytes).toBe(2300);
    expect(snap.radfishBytes).toBe(2800); // 500 logs + 2300 stores
  });

  it("handles no stores / no logger (storesBytes 0, radfishBytes = logs only)", async () => {
    define("storage", { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false });
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;

    const snap = await app.getStorageEstimate();
    expect(snap.stores).toEqual({});
    expect(snap.storesBytes).toBe(0);
    expect(snap.radfishBytes).toBe(0); // no logger, no stores
  });

  it("requestPersistence() updates the cached snapshot", async () => {
    define("storage", {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => false,
      persist: async () => true,
    });
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;
    expect(app.storageEstimate.persisted).toBe(false);

    const granted = await app.requestPersistence();
    expect(granted).toBe(true);
    expect(app.storageEstimate.persisted).toBe(true);
  });

  it("reflects a persistence grant in the cached snapshot at init (persist:true)", async () => {
    // persisted() returns false until persist() is called, then true — models a
    // grant that lands after the initial snapshot's persisted() read.
    let persistedState = false;
    define("storage", {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => persistedState,
      persist: async () => { persistedState = true; return true; },
    });
    const app = new Application({ storageManager: { persist: true } });
    await app._initializationPromise;
    // let the fire-and-forget requestPersistence().then(refresh) settle
    await new Promise((r) => setTimeout(r, 10));
    expect(app.storageEstimate.persisted).toBe(true);
  });

  it("storageDatabases() dedupes a store dbName that matches the logs db", async () => {
    define("storage", undefined);
    const app = new Application({});
    await app._initializationPromise;
    app.stores = { logsStore: { connector: { dbName: "radfish-logs" } } };
    app.logger = { persistence: { dbName: "radfish-logs" } };
    expect(app.storageDatabases()).toEqual(["radfish-logs"]); // not duplicated
  });

  it("getPersistenceStatus() returns the tri-state", async () => {
    define("storage", { persisted: async () => false, persist: async () => false });
    define("permissions", { query: async () => ({ state: "prompt" }) });
    const app = new Application({});
    await app._initializationPromise;
    expect(await app.getPersistenceStatus()).toBe("prompt");
  });

  it("storageDatabases() enumerates store connectors and the logs db", async () => {
    define("storage", undefined);
    const app = new Application({});
    await app._initializationPromise;
    app.stores = { catchReports: { connector: { dbName: "catch-store" } } };
    app.logger = { persistence: { dbName: "radfish-app-logs" } };
    expect(app.storageDatabases()).toEqual(["catch-store", "radfish-app-logs"]);
  });

  it("degrades gracefully when the browser lacks storage APIs", async () => {
    define("storage", undefined);
    const app = new Application({ storageManager: {} });
    await app._initializationPromise;
    expect(app.storageEstimate.supported).toBe(false);
    expect(app.storageEstimate.level).toBe("ok");
  });
});
