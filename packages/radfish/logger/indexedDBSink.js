/**
 * indexedDBSink.js — configurable IndexedDB persistence for the Logger.
 *
 * `createIndexedDBSink({ dbName, maxSize })` returns a sink (a `write`/`close`
 * object the Logger dispatches to) that ALSO exposes helpers to read/clear the
 * persisted data, so the app can hydrate previous-session logs on startup:
 *
 *   const sink = createIndexedDBSink({ dbName: "my-app-logs", maxSize: "5MB" });
 *   await sink.loadLogs();                   // previous-session log records
 *   await sink.clearLogs();                  // clear ALL streams' logs
 *   await sink.clearLogs({ stream: "app" }); // clear only ONE stream's logs
 *
 * One object store per database ("logs") holding the full log records that
 * reached the sink.
 *
 * The store is auto-trimmed to the `maxSize` storage budget (oldest records
 * evicted first) so it can't grow without bound. `maxSize` is human-friendly:
 * a string like "5MB" / "500KB" / "1GB", or a raw number of bytes. Units are
 * binary (1KB = 1024 bytes). Instance-scoped by `dbName`, so multiple databases
 * never collide.
 */

const LOGS = "logs";
const VERSION = 1;
const DEFAULT_MAX_SIZE = "5MB";

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
      if (!db.objectStoreNames.contains(LOGS)) {
        const store = db.createObjectStore(LOGS, { keyPath: "_id", autoIncrement: true });
        store.createIndex("timestamp", "timestamp");
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

  // Running byte total + record count for the store, seeded once from disk on
  // first use and then maintained incrementally. This avoids re-reading and
  // re-serializing the ENTIRE store on every write (which was O(n) per write →
  // O(n²) over a session). The common write path now touches only the new
  // record, plus any oldest rows it has to evict.
  const stats = {
    [LOGS]: { bytes: 0, count: 0, seeded: false },
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
    // Drive the stop condition off a PROJECTED total tracked locally, and apply
    // the change to the shared stats only AFTER the transaction commits. If
    // evictTx aborts (e.g. QuotaExceeded, tab closed mid-tx), IndexedDB rolls
    // back the deletes; the shared counter must not drift, since a drifted
    // (under-counted) counter silently disables eviction and lets the store
    // grow past maxSize — the exact thing maxSize exists to prevent.
    let projectedBytes = s.bytes;
    let projectedCount = s.count;
    let removedBytes = 0;
    let removedCount = 0;
    await new Promise((resolve, reject) => {
      const req = store.openCursor(); // ascending key order = oldest first
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || projectedBytes <= maxBytes || projectedCount <= 1) return resolve();
        cursor.delete();
        const size = accountedSize(cursor.value);
        projectedBytes -= size;
        projectedCount -= 1;
        removedBytes += size;
        removedCount += 1;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await txDone(evictTx);
    s.bytes -= removedBytes;
    s.count -= removedCount;
  }

  // Delete every record in `storeName` matching `predicate`, keeping the running
  // byte/count stats in sync. Stats are adjusted only AFTER the transaction
  // commits, so an aborted delete can't leave the counter drifted (which would
  // silently disable eviction). Used for scoped clears (e.g. one stream's logs).
  async function deleteWhere(storeName, predicate) {
    const database = await db();
    await seed(database, storeName);

    const tx = database.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    let removedBytes = 0;
    let removedCount = 0;
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (predicate(cursor.value)) {
          cursor.delete();
          removedBytes += accountedSize(cursor.value);
          removedCount += 1;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);

    const s = stats[storeName];
    s.bytes -= removedBytes;
    s.count -= removedCount;
  }

  return {
    dbName,
    // --- Logger sink contract ---
    write: async (record) => {
      if (!hasIDB()) return;
      const { _fromStorage, _id, ...clean } = record; // strip UI/key-only fields
      await addTo(LOGS, clean);
    },
    close: async ({ purge, stream } = {}) => {
      if (!purge || !hasIDB()) return;
      if (stream === undefined) {
        // Unscoped purge: clear the whole store.
        await clearStore(await db(), LOGS);
        resetStats(LOGS);
      } else {
        // Scoped purge: delete only THIS stream's records so other streams that
        // share the same sink (and backing store) keep their logs.
        await deleteWhere(LOGS, (r) => r.stream === stream);
      }
    },
    // --- persistence helpers (for hydration / clearing from the app) ---
    loadLogs: async () => (hasIDB() ? getAllFrom(await db(), LOGS) : []),
    // Clear all logs, or pass { stream } to clear just one stream's logs.
    clearLogs: async ({ stream } = {}) => {
      if (!hasIDB()) return;
      if (stream === undefined) {
        await clearStore(await db(), LOGS);
        resetStats(LOGS);
      } else {
        await deleteWhere(LOGS, (r) => r.stream === stream);
      }
    },
  };
}
