import { Store, Schema, LocalStorageConnector, IndexedDBConnector } from './storage/index.js';
import { StorageMethod, IndexedDBMethod, LocalStorageMethod } from "./on-device-storage/storage/index.js";
import { Logger } from "./logger/Logger.js";
import { createIndexedDBSink } from "./logger/indexedDBSink.js";
import {
  getStorageEstimate as readStorageEstimate,
  requestPersistence as requestPersistentStorage,
  getPersistenceStatus as readPersistenceStatus,
  levelFor,
} from "./storage-manager/index.js";

const registerServiceWorker = async (url) => {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register(url, {
        scope: "/",
      });
      if (registration.installing) {
        console.log("Service worker installing");
      } else if (registration.waiting) {
        console.log("Service worker installed");
      } else if (registration.active) {
        console.log("Service worker active");
      }
      return registration;
    } catch (error) {
      console.error(`Registration failed with ${error}`);
    }
  }
};

export class Application {
  constructor(options = {}) {
    this.emitter = new EventTarget();
    this.serviceWorker = null;
    this.isOnline = navigator.onLine;
    this._options = options;
    this._initializationPromise = null;

    // Build the logger synchronously so `app.logger` is available immediately.
    this.logger = this._createLogger(options.logger);

    // Populated during _initialize() once stores are open. See getStorageEstimate().
    this.storageEstimate = null;
    // Optional testing/demo override for the storage quota (bytes). null = use
    // the browser's real quota. Set via simulateQuota().
    this._simulatedQuotaBytes = null;

    // Register event listeners
    this._registerEventListeners();

    // Initialize everything
    this._initializationPromise = this._initialize();
  }

  /**
   * Build the app-wide Logger from the `logger` config block. Returns null when
   * no logger config is provided. Sinks are assembled by the framework so the
   * developer only declares stream levels + an optional IndexedDB config:
   *
   *   new Application({
   *     logger: {
   *       streams: { app: { level: "info" }, system: { level: "warn" } },
   *       indexedDB: { dbName: "my-app-logs", maxSize: "5MB" }, // optional persistence
   *       middleware: [ enrichFn, redactFn ],                    // optional
   *     },
   *   });
   *
   * Access it anywhere via `app.logger` (in React: `useApplication().logger`).
   * @private
   */
  _createLogger(config) {
    if (!config) return null;

    // A logging misconfiguration must degrade logging, not brick app startup.
    // Any error building the logger falls back to no logger (or console-only for
    // a bad persistence config) and warns, instead of throwing out of the
    // Application constructor.
    try {
      const baseSinks = [{ type: "console" }];
      let persistence = null;
      if (config.indexedDB) {
        try {
          persistence = createIndexedDBSink({
            dbName: config.indexedDB.dbName,
            maxSize: config.indexedDB.maxSize,
          });
          baseSinks.push(persistence);
        } catch (err) {
          // e.g. an unparseable maxSize like "5 megs". Keep console logging.
          console.warn(
            `[radfish] logger IndexedDB persistence disabled — ${err.message}`,
          );
        }
      }

      const streams = {};
      for (const [name, def] of Object.entries(config.streams || {})) {
        streams[name] = {
          level: def.level || "info",
          // framework-provided sinks (console [+ IndexedDB]) plus any the dev adds
          sinks: [...baseSinks, ...(def.sinks || [])],
        };
      }

      const logger = new Logger({ streams, middleware: config.middleware });
      // expose persistence helpers (loadLogs/clearLogs/...) for hydration; null if no IndexedDB
      logger.persistence = persistence;
      return logger;
    } catch (err) {
      console.warn(`[radfish] logger disabled due to invalid config — ${err.message}`);
      return null;
    }
  }

  /**
   * Initialize the application stores and collections
   * @private
   */
  async _initialize() {
    // Initialize stores
    this.stores = null;
    if (this._options.stores && typeof this._options.stores === 'object') {
      this.stores = {};
      
      // Initialize each store and its connector
      const storeInitPromises = [];
      
      for (let storeKey in this._options.stores) {
        const store = this._options.stores[storeKey]
        let name = store.name || storeKey;
        let connector = store.connector;
        
        if (!connector) {
          throw new Error(`Store ${name} is missing a connector`);
        }
        
        // Create the store
        this.stores[name] = new Store({name, connector});
        
        // Initialize the connector
        const initPromise = this.stores[name].connector.initialize()
          .then(async () => {
            // Add collections if they exist
            if (store.collections) {
              const collectionPromises = [];
              
              for (let collectionKey in store.collections) {
                let collection = store.collections[collectionKey];
                let schema = collection.schema;
                
                // Handle schema configuration object
                if (typeof schema === 'object' && !(schema instanceof Schema)) {
                  // If schema doesn't have a name, use the collectionKey as default
                  if (!schema.name) {
                    schema = { ...schema, name: collectionKey };
                  }
                  schema = new Schema(schema);
                }
                
                // Add collection (might be async for IndexedDBConnector)
                const addCollectionPromise = Promise.resolve(
                  this.stores[name].connector.addCollection(schema)
                );
                collectionPromises.push(addCollectionPromise);
              }
              
              // Wait for all collections to be added
              return Promise.all(collectionPromises);
            }
          });
        
        storeInitPromises.push(initPromise);
      }
      
      // Wait for all stores to be initialized
      await Promise.all(storeInitPromises);
    }

    // Capture an initial storage snapshot now that the stores (if any) are open.
    await this._captureInitialStorage();

    // Dispatch the init event
    this._dispatch("init");

    return true;
  }

  /**
   * Take the first storage estimate at init, optionally request persistent
   * storage, and emit `storage:pressure` if usage is already at a warning level.
   * Storage measurement must never break app init, so this never throws.
   * @private
   */
  async _captureInitialStorage() {
    const config = this._options.storageManager || {};
    try {
      // Request persistence fire-and-forget — persist() can prompt (Firefox), so
      // we must not block init/ready on it. Once the grant resolves we re-run
      // getStorageEstimate() so the cached snapshot's `persisted` reflects the
      // post-grant state (the initial snapshot below may read persisted() before
      // the grant lands, and requestPersistence()'s own patch is skipped while
      // this.storageEstimate is still null).
      if (config.persist) {
        this.requestPersistence()
          .then(() => this.getStorageEstimate())
          .catch(() => {});
      }
      // getStorageEstimate() captures the snapshot and emits storage:pressure if
      // we're already under pressure at startup.
      await this.getStorageEstimate();
    } catch {
      // never let storage measurement break initialization
    }
  }

  /**
   * Read a fresh storage estimate, augmented with RADFish-specific info the
   * browser can't provide: the logger's own byte usage and the names of the
   * IndexedDB databases RADFish owns. Also refreshes the cached `storageEstimate`.
   * @returns {Promise<import('./storage-manager/index.js').StorageSnapshot & { logsBytes: number|null, databases: string[] }>}
   */
  async getStorageEstimate() {
    const config = this._options.storageManager || {};
    const snapshot = await readStorageEstimate({
      warnAt: config.warnAt,
      criticalAt: config.criticalAt,
    });
    snapshot.logsBytes = this.logger?.persistence?.usage
      ? await this.logger.persistence.usage()
      : null;

    // Per-subsystem byte usage. RADFish measures these itself because the browser
    // gives no per-database breakdown cross-browser (see IndexedDBConnector.usage
    // and the logger sink). `stores` = per data-store bytes; `storesBytes` = their
    // total; `radfishBytes` = logger + stores (all RADFish-managed storage).
    const stores = {};
    let storesBytes = 0;
    for (const [name, store] of Object.entries(this.stores ?? {})) {
      if (typeof store?.connector?.usage !== "function") continue;
      try {
        const bytes = await store.connector.usage();
        // null = "not measurable right now" (e.g. mid schema-change) — skip it
        // rather than counting it as 0, which would under-report the total.
        if (bytes == null) continue;
        // Keyed by dbName when present (IndexedDB), else the store name (e.g.
        // localStorage). storesBytes sums independently, so it stays correct even
        // if two stores share a key.
        stores[store.connector.dbName ?? name] = bytes;
        storesBytes += bytes;
      } catch {
        // a store that can't be measured shouldn't break the estimate
      }
    }
    snapshot.stores = stores;
    snapshot.storesBytes = storesBytes;
    snapshot.radfishBytes = (snapshot.logsBytes ?? 0) + storesBytes;

    snapshot.databases = this.storageDatabases();

    // Testing/demo: pretend the quota is a set size so warnAt/criticalAt are
    // reachable without actually filling hundreds of GB. Derived fields are
    // recomputed against RADFish's OWN usage (radfishBytes), not the origin-wide
    // usageBytes — otherwise unrelated browser storage would dominate the
    // simulated percent on a real browser and pin it to critical. `simulated`
    // flags the snapshot so consumers/telemetry can tell it isn't a real reading.
    if (this._simulatedQuotaBytes != null && snapshot.supported) {
      const quota = this._simulatedQuotaBytes;
      const simUsage = snapshot.radfishBytes ?? 0;
      snapshot.quotaBytes = quota;
      snapshot.remainingBytes = Math.max(0, quota - simUsage);
      snapshot.percentUsed = quota > 0 ? simUsage / quota : null;
      snapshot.level = levelFor(snapshot.percentUsed, config.warnAt, config.criticalAt);
      snapshot.simulated = true;
    }

    this._applyStorageSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Cache the snapshot and emit on any level change: `storage:pressure` when the
   * level moves into/between warning/critical, and `storage:ok` when it returns
   * to ok — so an event-driven UI can both raise AND clear a pressure banner. No
   * event when the level is unchanged.
   * @private
   */
  _applyStorageSnapshot(snapshot) {
    const previousLevel = this.storageEstimate ? this.storageEstimate.level : "ok";
    this.storageEstimate = snapshot;
    if (snapshot.level !== previousLevel) {
      this._dispatch(snapshot.level === "ok" ? "storage:ok" : "storage:pressure", snapshot);
    }
  }

  /**
   * Testing/demo aid: override the reported storage quota (in bytes) so the
   * warnAt/criticalAt thresholds can be exercised without filling real disk.
   * Pass null to clear and use the browser's real quota again.
   */
  simulateQuota(bytes) {
    this._simulatedQuotaBytes = bytes;
  }

  /**
   * Request persistent storage (exempts the origin from best-effort eviction).
   * Best called from a user gesture. Updates the cached snapshot's `persisted`.
   * @returns {Promise<boolean>}
   */
  async requestPersistence() {
    const granted = await requestPersistentStorage();
    if (this.storageEstimate) this.storageEstimate.persisted = granted;
    return granted;
  }

  /**
   * Persistence capability as a tri-state: 'persisted' | 'prompt' | 'never'.
   * @returns {Promise<'persisted'|'prompt'|'never'>}
   */
  async getPersistenceStatus() {
    return readPersistenceStatus();
  }

  /**
   * Names of the IndexedDB databases RADFish owns (each store's connector + the
   * logs DB). Names only — the browser provides no per-database byte usage.
   * @returns {string[]}
   */
  storageDatabases() {
    const names = [];
    for (const store of Object.values(this.stores || {})) {
      const name = store?.connector?.dbName;
      if (name) names.push(name);
    }
    const logsDb = this.logger?.persistence?.dbName;
    if (logsDb) names.push(logsDb);
    // Dedupe: a store dbName can coincide with the logs dbName; callers use this
    // list to delete databases, so a name should appear at most once.
    return [...new Set(names)];
  }

  get storage() {
    if (!this._options.storage) {
      return null;
    }

    console.warn('Deprecation: Please update to use Connectors instead of StorageMethod: https://nmfs-radfish.github.io/radfish/design-system/storage');

    if (!(this._options.storage instanceof StorageMethod)) {
      switch (this._options.storage?.type) {
        case "indexedDB": {
          return new IndexedDBMethod(
            this._options.storage.name,
            this._options.storage.version,
            this._options.storage.stores
          );
        }
        case "localStorage": {
          return new LocalStorageMethod(this._options.storage.name);
        }
        default: {
          throw new Error(`Invalid storage method type: ${this._options.storage.type}`);
        }
      }
    }

    return this._options.storage;
  }

  on(event, callback) {
    return this.emitter.addEventListener(event, callback);
  }

  off(event, callback) {
    return this.emitter.removeEventListener(event, callback);
  }

  _dispatch(event, detail) {
    this.emitter.dispatchEvent(
      new CustomEvent(event, { bubbles: false, detail: detail })
    );
  }

  _registerEventListeners() {
    console.log(
      `%c[RAD] Registering event listeners`,
      "color:#3984C5;font-weight:bold;"
    );
    this.on("init", async () => {
      console.debug("Application initialized");
      const worker = await this._installServiceWorker(
        this._options?.mocks?.handlers,
        this._options?.serviceWorker?.url
      );

      this.serviceWorker = worker;

      // Only dispatch ready event if worker is successfully installed or if no service worker was configured
      this._dispatch("ready");
    });

    const handleOnline = (event) => {
      this.isOnline = true;
      this._dispatch("online", { event });
    };
    window.addEventListener("online", handleOnline, true);

    const handleOffline = (event) => {
      this.isOnline = false;
      this._dispatch("offline", { event });
    };
    window.addEventListener("offline", handleOffline, true);
  }

  async _installServiceWorker(handlers, url) {
    if (!url) return null;
    console.info("Installing service worker");
    
    try {
      const registration = await registerServiceWorker(url);
      
      console.debug("Service worker installed and started successfully");
      // return worker;
      return registration;
    } catch (error) {
      console.error("Failed to install service worker:", error);
      return null;
    }
  }
}

export * from "./on-device-storage/storage/index.js";
