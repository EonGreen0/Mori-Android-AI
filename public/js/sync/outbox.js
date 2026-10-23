import { compactPlannerMutations } from "./compaction.js";
import { openPlannerSyncDb, PLANNER_SYNC_STORES } from "./database.js";

const OUTBOX_STORE = PLANNER_SYNC_STORES.OUTBOX;
const META_STORE = PLANNER_SYNC_STORES.META;

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

function queuedMutation(mutation, queuedAt) {
  return {
    ...mutation,
    queuedAt: Number(mutation.queuedAt) || queuedAt,
    attempts: Number(mutation.attempts) || 0,
    lastAttemptAt: Number(mutation.lastAttemptAt) || 0,
    lastError: String(mutation.lastError || ""),
  };
}

export async function enqueuePlannerMutations(mutations) {
  const items = Array.isArray(mutations) ? mutations.filter((item) => item?.opId) : [];
  if (!items.length) return 0;

  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const queuedAt = Date.now();

  items.forEach((mutation, index) => {
    store.put(queuedMutation(mutation, queuedAt + index));
  });

  await transactionDone(transaction);
  return items.length;
}

export async function stagePlannerSyncChanges({ mutations, checkpointKey, checkpointValue } = {}) {
  if (!checkpointKey) throw new Error("Planner sync checkpoint key is required");
  const items = Array.isArray(mutations) ? mutations.filter((item) => item?.opId) : [];
  const db = await openPlannerSyncDb();
  const transaction = db.transaction([OUTBOX_STORE, META_STORE], "readwrite");
  const outbox = transaction.objectStore(OUTBOX_STORE);
  const meta = transaction.objectStore(META_STORE);
  const queuedAt = Date.now();

  items.forEach((mutation, index) => {
    outbox.put(queuedMutation(mutation, queuedAt + index));
  });
  meta.put({ key: checkpointKey, value: checkpointValue });

  await transactionDone(transaction);
  return items.length;
}

export async function listPlannerOutbox({ projectId = "", limit = 200, all = false } = {}) {
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readonly");
  const store = transaction.objectStore(OUTBOX_STORE);
  const request = store.index("queuedAt").openCursor();
  const result = [];
  const max = all ? Infinity : Math.max(1, Math.min(2000, Number(limit) || 200));

  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= max) {
        resolve();
        return;
      }
      if (!projectId || cursor.value?.projectId === projectId) result.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not read Mori sync outbox"));
    transaction.onabort = () => reject(transaction.error || new Error("Outbox read aborted"));
  });

  return result;
}

/**
 * Read raw durable operations and coalesce only the operations that are still
 * safe to combine before transport. This function is read-only: raw IndexedDB
 * records remain untouched until transport explicitly acknowledges or discards
 * the returned source operation ids.
 */
export async function preparePlannerOutboxBatch({
  projectId = "",
  rawLimit = 2000,
  mutationLimit = 200,
} = {}) {
  const raw = await listPlannerOutbox({ projectId, limit: rawLimit });
  const compacted = compactPlannerMutations(raw);
  const max = Math.max(1, Math.min(1000, Number(mutationLimit) || 200));
  const entries = compacted.entries.slice(0, max);

  return {
    entries,
    mutations: entries.map((entry) => entry.mutation),
    discardOpIds: compacted.discardOpIds,
    rawCount: raw.length,
    compactedCount: compacted.outputCount,
    returnedCount: entries.length,
    hasMore: compacted.outputCount > entries.length,
  };
}

export async function sealPreparedPlannerOutboxBatch(batch = {}) {
  const entries = Array.isArray(batch.entries) ? batch.entries.filter((entry) => entry?.mutation?.opId) : [];
  const representativeIds = new Set(entries.map((entry) => entry.mutation.opId));
  const discardOpIds = [...new Set(
    (Array.isArray(batch.discardOpIds) ? batch.discardOpIds : [])
      .filter((opId) => opId && !representativeIds.has(opId)),
  )];

  if (!entries.length && !discardOpIds.length) {
    return { entries: [], mutations: [], discardedCount: 0 };
  }

  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const sealedAt = Date.now();
  const sealedEntries = [];

  entries.forEach((entry, index) => {
    const mutation = entry.mutation;
    const sourceOpIds = [...new Set(
      (Array.isArray(entry.sourceOpIds) ? entry.sourceOpIds : [mutation.opId]).filter(Boolean),
    )];
    const representativeOpId = mutation.opId;

    sourceOpIds.forEach((opId) => {
      if (opId !== representativeOpId) store.delete(opId);
    });

    const priorSources = Array.isArray(mutation.compactedSourceOpIds)
      ? mutation.compactedSourceOpIds.filter(Boolean)
      : [];
    const compactedSourceOpIds = [...new Set([...priorSources, ...sourceOpIds])];
    const sealedMutation = queuedMutation(
      {
        ...mutation,
        sealedAt: Number(mutation.sealedAt) || sealedAt + index,
        compactedSourceOpIds,
      },
      sealedAt + index,
    );

    store.put(sealedMutation);
    sealedEntries.push({
      mutation: sealedMutation,
      sourceOpIds: [representativeOpId],
      compacted: entry.compacted === true || compactedSourceOpIds.length > 1,
    });
  });

  discardOpIds.forEach((opId) => store.delete(opId));
  await transactionDone(transaction);

  return {
    entries: sealedEntries,
    mutations: sealedEntries.map((entry) => entry.mutation),
    discardedCount: discardOpIds.length,
  };
}

export async function removePlannerOutboxOperations(opIds) {
  const ids = [...new Set((Array.isArray(opIds) ? opIds : []).filter(Boolean))];
  if (!ids.length) return 0;

  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  ids.forEach((opId) => store.delete(opId));
  await transactionDone(transaction);
  return ids.length;
}

export async function markPlannerOutboxAttempt(opId, error = "") {
  if (!opId) return false;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const current = await requestToPromise(store.get(opId));
  if (!current) {
    transaction.abort();
    return false;
  }
  store.put({
    ...current,
    attempts: Number(current.attempts || 0) + 1,
    lastAttemptAt: Date.now(),
    lastError: String(error || ""),
  });
  await transactionDone(transaction);
  return true;
}

export async function setPlannerOutboxError(opId, error = "") {
  if (!opId) return false;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(OUTBOX_STORE, "readwrite");
  const store = transaction.objectStore(OUTBOX_STORE);
  const current = await requestToPromise(store.get(opId));
  if (!current) {
    transaction.abort();
    return false;
  }
  store.put({
    ...current,
    lastError: String(error || ""),
  });
  await transactionDone(transaction);
  return true;
}

export async function getPlannerSyncMeta(key, fallback = null) {
  if (!key) return fallback;
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(META_STORE, "readonly");
  const record = await requestToPromise(transaction.objectStore(META_STORE).get(key));
  return record ? record.value : fallback;
}

export async function setPlannerSyncMeta(key, value) {
  if (!key) throw new Error("Sync metadata key is required");
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).put({ key, value });
  await transactionDone(transaction);
  return value;
}
