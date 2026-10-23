import { openPlannerSyncDb, PLANNER_SYNC_STORES } from "./database.js";
import { cloneJson } from "./model.js";

export const REMOTE_ASSET_PRESENCE = Object.freeze({
  UNKNOWN: "unknown",
  MISSING: "missing",
  PRESENT: "present",
});

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function normalizePresence(value) {
  return Object.values(REMOTE_ASSET_PRESENCE).includes(value)
    ? value
    : REMOTE_ASSET_PRESENCE.UNKNOWN;
}

function remoteStateKey(transportId, assetId) {
  return `${String(transportId || "").trim()}::${String(assetId || "").trim()}`;
}

export function normalizeRemoteAssetState(value = {}) {
  const transportId = String(value.transportId || "").trim();
  const assetId = String(value.assetId || "").trim();
  if (!transportId || !assetId) {
    throw new Error("Remote asset state requires transportId and assetId");
  }

  return {
    key: remoteStateKey(transportId, assetId),
    transportId,
    assetId,
    metadata: normalizePresence(value.metadata),
    display: normalizePresence(value.display),
    original: normalizePresence(value.original),
    displayHash: String(value.displayHash || ""),
    originalHash: String(value.originalHash || ""),
    displayRef: String(value.displayRef || ""),
    originalRef: String(value.originalRef || ""),
    checkedAt: Number(value.checkedAt) || 0,
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

export async function putRemoteAssetState(state) {
  const normalized = normalizeRemoteAssetState(state);
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE, "readwrite");
  transaction.objectStore(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE).put(cloneJson(normalized));
  await transactionDone(transaction);
  return normalized;
}

export async function putRemoteAssetStates(states) {
  const values = (Array.isArray(states) ? states : []).map(normalizeRemoteAssetState);
  if (!values.length) return [];
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE, "readwrite");
  const store = transaction.objectStore(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE);
  values.forEach((value) => store.put(cloneJson(value)));
  await transactionDone(transaction);
  return values;
}

export async function getRemoteAssetState(transportId, assetId) {
  if (!transportId || !assetId) return null;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE, "readonly");
  const value = await requestToPromise(
    transaction.objectStore(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE)
      .get(remoteStateKey(transportId, assetId)),
  );
  return value || null;
}

export async function listRemoteAssetStates({ transportId = "", limit = 1000 } = {}) {
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE, "readonly");
  const store = transaction.objectStore(PLANNER_SYNC_STORES.ASSET_REMOTE_STATE);
  const request = transportId
    ? store.index("transportId").openCursor(IDBKeyRange.only(transportId))
    : store.openCursor();
  const result = [];
  const max = Math.max(1, Math.min(10000, Number(limit) || 1000));

  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= max) {
        resolve();
        return;
      }
      result.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not list remote asset states"));
    transaction.onabort = () => reject(transaction.error || new Error("Remote asset state list aborted"));
  });

  return result;
}
