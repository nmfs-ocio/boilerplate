/**
 * indexedDBSink.js — configurable IndexedDB persistence for the Logger.
 *
 * `createIndexedDBSink({ dbName, maxSize })` returns a sink (a `write`/`close`
 * object the Logger dispatches to) that ALSO exposes helpers to read/clear the
 * persisted data, so the app can hydrate previous-session logs on startup:
 *
 *   const sink = createIndexedDBSink({ dbName: "my-app-logs", maxSize: "5MB" });
 *   await sink.loadLogs();          // previous-session log records
 *   await sink.clearLogs();
 *   await sink.saveDiagnostic({ kind, stream, reason, timestamp });
 *   await sink.loadDiagnostics();   // metadata-only logger events
 *
 * Two object stores per database:
 *   - "logs"        — full log records that reached the sinks.
 *   - "diagnostics" — the logger's OWN events (drops/errors/lifecycle) as
 *                     METADATA ONLY ({ kind, stream, reason, timestamp }). A
 *                     dropped/errored record's payload is never stored, so a
 *                     redacted secret can't be re-persisted here.
 *
 * Each store is auto-trimmed to the `maxSize` storage budget (oldest records
 * evicted first) so it can't grow without bound. `maxSize` is human-friendly:
 * a string like "5MB" / "500KB" / "1GB", or a raw number of bytes. Units are
 * binary (1KB = 1024 bytes). Instance-scoped by `dbName`, so multiple databases
 * never collide.
 */

const LOGS = "logs";
const DIAGNOSTICS = "diagnostics";
const VERSION = 1;
const DEFAULT_MAX_SIZE = "5MB"; // per store

const hasIDB = () => typeof indexedDB !== "undefined";

// Serialized UTF-8 size of a record — what it actually costs on disk.
const encoder = new TextEncoder();
const byteSize = (item) => encoder.encode(JSON.stringify(item)).length;

// Parse a human-friendly size into bytes. Accepts a number (already bytes) or a
// string like "5MB", "500 kb", "1.5gb". Binary units (1KB = 1024 bytes).
const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
function parseSize(value) {
  let bytes;
  if (typeof value === "number") {
    bytes = value;
  } else {
    const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(String(value));
    if (!match) {
      throw new Error(`Invalid maxSize: "${value}". Use a string like "5MB"/"500KB" or a positive number of bytes.`);
    }
    bytes = parseFloat(match[1]) * SIZE_UNITS[(match[2] || "b").toLowerCase()];
  }
  // Reject NaN / Infinity / <= 0. A silently-bad budget (e.g. "." -> NaN, or a
  // negative number) would disable trimming entirely and let the store grow
  // without bound — exactly what maxSize exists to prevent.
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`Invalid maxSize: "${value}". Must be a positive size like "5MB" or a positive number of bytes.`);
  }
  return Math.round(bytes);
}

function openDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [LOGS, DIAGNOSTICS]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "_id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Size of a record as we account for it: the clean payload WITHOUT the
// auto-increment `_id`, so seeding (which reads stored rows that have an `_id`)
// and incremental adds measure the same shape.
function accountedSize(item) {
  const { _id, ...rest } = item;
  return byteSize(rest);
}

function getAllFrom(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const r = tx.objectStore(storeName).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

async function clearStore(db, storeName) {
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

export function createIndexedDBSink({ dbName = "radfish-logs", maxSize = DEFAULT_MAX_SIZE } = {}) {
  const maxBytes = parseSize(maxSize);
  let dbPromise;
  const db = () => (dbPromise ||= openDB(dbName));

  // Running byte total + record count per store, seeded once from disk on first
  // use and then maintained incrementally. This avoids re-reading and
  // re-serializing the ENTIRE store on every write (which was O(n) per write →
  // O(n²) over a session). The common write path now touches only the new
  // record, plus any oldest rows it has to evict.
  const stats = {
    [LOGS]: { bytes: 0, count: 0, seeded: false },
    [DIAGNOSTICS]: { bytes: 0, count: 0, seeded: false },
  };

  async function seed(database, storeName) {
    const s = stats[storeName];
    if (s.seeded) return;
    const items = await getAllFrom(database, storeName);
    s.bytes = items.reduce((sum, it) => sum + accountedSize(it), 0);
    s.count = items.length;
    s.seeded = true;
  }

  function resetStats(storeName) {
    stats[storeName] = { bytes: 0, count: 0, seeded: true };
  }

  // Add a record, then evict oldest-first until within budget. A cursor walks
  // from the oldest record and stops as soon as the budget is met (or only the
  // single newest record remains — it is always kept, even if it alone exceeds
  // the budget). The common case deletes nothing.
  async function addTo(storeName, item) {
    const database = await db();
    await seed(database, storeName);

    const addTx = database.transaction(storeName, "readwrite");
    addTx.objectStore(storeName).add(item);
    await txDone(addTx);
    const s = stats[storeName];
    s.bytes += accountedSize(item);
    s.count += 1;

    if (s.bytes <= maxBytes || s.count <= 1) return;

    const evictTx = database.transaction(storeName, "readwrite");
    const store = evictTx.objectStore(storeName);
    await new Promise((resolve, reject) => {
      const req = store.openCursor(); // ascending key order = oldest first
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || s.bytes <= maxBytes || s.count <= 1) return resolve();
        cursor.delete();
        s.bytes -= accountedSize(cursor.value);
        s.count -= 1;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await txDone(evictTx);
  }

  return {
    dbName,
    // --- Logger sink contract ---
    write: async (record) => {
      if (!hasIDB()) return;
      const { _fromStorage, _id, ...clean } = record; // strip UI/key-only fields
      await addTo(LOGS, clean);
    },
    close: async ({ purge } = {}) => {
      if (purge && hasIDB()) {
        await clearStore(await db(), LOGS);
        resetStats(LOGS);
      }
    },
    // --- persistence helpers (for hydration / clearing from the app) ---
    loadLogs: async () => (hasIDB() ? getAllFrom(await db(), LOGS) : []),
    clearLogs: async () => {
      if (hasIDB()) {
        await clearStore(await db(), LOGS);
        resetStats(LOGS);
      }
    },
    saveDiagnostic: async (meta) => {
      if (!hasIDB()) return;
      const { kind, stream, reason, timestamp } = meta; // metadata only — never a payload
      await addTo(DIAGNOSTICS, { kind, stream, reason: reason ?? null, timestamp });
    },
    loadDiagnostics: async () => (hasIDB() ? getAllFrom(await db(), DIAGNOSTICS) : []),
    clearDiagnostics: async () => {
      if (hasIDB()) {
        await clearStore(await db(), DIAGNOSTICS);
        resetStats(DIAGNOSTICS);
      }
    },
  };
}
