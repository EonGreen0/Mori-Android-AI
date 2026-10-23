const DB_NAME = "mori_sync_v1";
const DB_VERSION = 3;

export const PLANNER_SYNC_STORES = Object.freeze({
  OUTBOX: "outbox",
  META: "meta",
  ASSETS: "assets",
  ASSET_BINDINGS: "assetBindings",
  ASSET_REMOTE_STATE: "assetRemoteState",
});

let dbPromise = null;

function requireIndexedDb() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable on this platform");
  }
  return globalThis.indexedDB;
}

export function openPlannerSyncDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = requireIndexedDb().open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLANNER_SYNC_STORES.OUTBOX)) {
        const store = db.createObjectStore(PLANNER_SYNC_STORES.OUTBOX, { keyPath: "opId" });
        store.createIndex("projectId", "projectId", { unique: false });
        store.createIndex("queuedAt", "queuedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(PLANNER_SYNC_STORES.META)) {
        db.createObjectStore(PLANNER_SYNC_STORES.META, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PLANNER_SYNC_STORES.ASSETS)) {
        const assets = db.createObjectStore(PLANNER_SYNC_STORES.ASSETS, { keyPath: "id" });
        assets.createIndex("type", "type", { unique: false });
      }
      if (!db.objectStoreNames.contains(PLANNER_SYNC_STORES.ASSET_BINDINGS)) {
        db.createObjectStore(PLANNER_SYNC_STORES.ASSET_BINDINGS, { keyPath: "assetId" });
      }
      if (!db.objectStoreNames.contains(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE)) {
        const remoteState = db.createObjectStore(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE, {
          keyPath: "key",
        });
        remoteState.createIndex("transportId", "transportId", { unique: false });
        remoteState.createIndex("assetId", "assetId", { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error("Could not open Mori sync database"));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("Mori sync database upgrade is blocked by another window"));
    };
  });

  return dbPromise;
}
