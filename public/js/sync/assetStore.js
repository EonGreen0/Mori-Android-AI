import { openPlannerSyncDb, PLANNER_SYNC_STORES } from "./database.js";
import { cloneJson, isPlainObject } from "./model.js";

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

function validateAsset(asset) {
  if (!isPlainObject(asset) || !String(asset.id || "").startsWith("sha256:")) {
    throw new Error("Planner asset requires a sha256 id");
  }
  if (asset.type !== "image") throw new Error(`Unsupported planner asset type: ${String(asset.type)}`);
  if (!isPlainObject(asset.source) || asset.source.hash !== asset.id) {
    throw new Error("Planner asset source hash must match asset id");
  }
  if (!isPlainObject(asset.display) || !String(asset.display.hash || "").startsWith("sha256:")) {
    throw new Error("Planner asset display hash is required");
  }
}

export async function putPlannerAsset(asset, localBinding = null) {
  validateAsset(asset);
  const db = await openPlannerSyncDb();
  const stores = [PLANNER_SYNC_STORES.ASSETS];
  if (localBinding) stores.push(PLANNER_SYNC_STORES.ASSET_BINDINGS);
  const transaction = db.transaction(stores, "readwrite");
  transaction.objectStore(PLANNER_SYNC_STORES.ASSETS).put(cloneJson(asset));

  if (localBinding) {
    if (localBinding.assetId !== asset.id) {
      transaction.abort();
      throw new Error("Planner asset binding id does not match asset id");
    }
    transaction.objectStore(PLANNER_SYNC_STORES.ASSET_BINDINGS).put(cloneJson(localBinding));
  }

  await transactionDone(transaction);
  return asset.id;
}

export async function getPlannerAsset(assetId) {
  if (!assetId) return null;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSETS, "readonly");
  const value = await requestToPromise(
    transaction.objectStore(PLANNER_SYNC_STORES.ASSETS).get(assetId),
  );
  return value || null;
}

export async function getPlannerAssetsByIds(assetIds) {
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).filter(Boolean))];
  if (!ids.length) return [];
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSETS, "readonly");
  const store = transaction.objectStore(PLANNER_SYNC_STORES.ASSETS);
  const assets = await Promise.all(ids.map((assetId) => requestToPromise(store.get(assetId))));
  return assets.filter(Boolean);
}

export async function getPlannerAssetBinding(assetId) {
  if (!assetId) return null;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_BINDINGS, "readonly");
  const value = await requestToPromise(
    transaction.objectStore(PLANNER_SYNC_STORES.ASSET_BINDINGS).get(assetId),
  );
  return value || null;
}

export async function putPlannerAssetBinding(binding) {
  if (!binding?.assetId) throw new Error("Planner asset binding requires assetId");
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSET_BINDINGS, "readwrite");
  transaction.objectStore(PLANNER_SYNC_STORES.ASSET_BINDINGS).put(cloneJson(binding));
  await transactionDone(transaction);
  return binding.assetId;
}

export async function listPlannerAssets({ limit = 1000 } = {}) {
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.ASSETS, "readonly");
  const request = transaction.objectStore(PLANNER_SYNC_STORES.ASSETS).openCursor();
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
    request.onerror = () => reject(request.error || new Error("Could not list planner assets"));
    transaction.onabort = () => reject(transaction.error || new Error("Planner asset list aborted"));
  });

  return result;
}
