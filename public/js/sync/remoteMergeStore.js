import { openPlannerSyncDb, PLANNER_SYNC_STORES } from "./database.js";
import { cloneJson, validateSyncEnvelope } from "./model.js";
import { plannerCheckpointKey } from "./plannerJournal.js";
import { createPlannerRemoteShadow, validatePlannerRemoteShadow } from "./remoteMerge.js";

const REMOTE_STATE_PREFIX = "planner_remote_state_v1:";
const MAX_STORED_CONFLICTS = 50;

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

export function remoteStateKey(transportId, projectId) {
  const transport = String(transportId || "").trim();
  const project = String(projectId || "").trim();
  if (!transport || !project) throw new Error("Remote sync state requires transportId and projectId");
  return `${REMOTE_STATE_PREFIX}${transport}:${project}`;
}

function queuedMutation(mutation, queuedAt) {
  return {
    ...cloneJson(mutation),
    queuedAt: Number(mutation?.queuedAt) || queuedAt,
    attempts: Number(mutation?.attempts) || 0,
    lastAttemptAt: Number(mutation?.lastAttemptAt) || 0,
    lastError: String(mutation?.lastError || ""),
  };
}

export async function getPlannerRemoteSyncState({ transportId, projectId } = {}) {
  const key = remoteStateKey(transportId, projectId);
  const db = await openPlannerSyncDb();
  const transaction = db.transaction(PLANNER_SYNC_STORES.META, "readonly");
  const record = await requestToPromise(transaction.objectStore(PLANNER_SYNC_STORES.META).get(key));
  const value = record?.value;

  if (!value) {
    return {
      transportId: String(transportId),
      projectId: String(projectId),
      cursor: null,
      shadow: createPlannerRemoteShadow(projectId),
      conflicts: [],
      updatedAt: 0,
    };
  }

  const validation = validatePlannerRemoteShadow(value.shadow, projectId);
  if (!validation.valid) {
    throw new Error(`Stored remote shadow is invalid: ${validation.errors.join("; ")}`);
  }

  return {
    transportId: String(transportId),
    projectId: String(projectId),
    cursor: value.cursor ?? null,
    shadow: cloneJson(value.shadow),
    conflicts: Array.isArray(value.conflicts) ? cloneJson(value.conflicts) : [],
    updatedAt: Number(value.updatedAt) || 0,
  };
}

/**
 * Commit the durable half of a remote merge after the caller has successfully
 * persisted the merged Planner board locally. Shadow/cursor/checkpoint and any
 * reconciliation mutations advance in one IndexedDB transaction.
 */
export async function commitPlannerRemoteMerge({
  transportId,
  projectId,
  cursor,
  shadow,
  merged,
  conflicts = [],
  reconciliationMutations = [],
  replaceOutboxOpIds = [],
} = {}) {
  remoteStateKey(transportId, projectId);
  const shadowValidation = validatePlannerRemoteShadow(shadow, projectId);
  if (!shadowValidation.valid) {
    throw new Error(`Cannot commit invalid remote shadow: ${shadowValidation.errors.join("; ")}`);
  }
  const mergedValidation = validateSyncEnvelope(merged);
  if (!mergedValidation.valid) {
    throw new Error(`Cannot commit invalid merged Planner state: ${mergedValidation.errors.join("; ")}`);
  }
  if (merged.project.id !== projectId) throw new Error("Merged Planner project id mismatch");

  const mutations = (Array.isArray(reconciliationMutations) ? reconciliationMutations : [])
    .filter((mutation) => mutation?.opId && mutation?.projectId === projectId);
  if (mutations.length !== (Array.isArray(reconciliationMutations) ? reconciliationMutations.length : 0)) {
    throw new Error("Invalid reconciliation mutation set");
  }

  const db = await openPlannerSyncDb();
  const transaction = db.transaction(
    [PLANNER_SYNC_STORES.META, PLANNER_SYNC_STORES.OUTBOX, PLANNER_SYNC_STORES.ASSETS],
    "readwrite",
  );
  const meta = transaction.objectStore(PLANNER_SYNC_STORES.META);
  const outbox = transaction.objectStore(PLANNER_SYNC_STORES.OUTBOX);
  const assets = transaction.objectStore(PLANNER_SYNC_STORES.ASSETS);
  const now = Date.now();

  // These exact operations were captured before the pull and are superseded
  // by the merged reconciliation. Keep unrelated/newly queued operations.
  replaceOutboxOpIds.forEach((opId) => outbox.delete(opId));

  meta.put({
    key: remoteStateKey(transportId, projectId),
    value: {
      transportId: String(transportId),
      projectId: String(projectId),
      cursor: cursor ?? null,
      shadow: cloneJson(shadow),
      conflicts: cloneJson((Array.isArray(conflicts) ? conflicts : []).slice(-MAX_STORED_CONFLICTS)),
      updatedAt: now,
    },
  });
  meta.put({
    key: plannerCheckpointKey(projectId),
    value: cloneJson(merged),
  });

  (Array.isArray(merged.assets) ? merged.assets : []).forEach((asset) => {
    if (asset?.id) assets.put(cloneJson(asset));
  });

  mutations.forEach((mutation, index) => {
    outbox.put(queuedMutation(mutation, now + index));
  });

  await transactionDone(transaction);
  return {
    cursor: cursor ?? null,
    reconciliationCount: mutations.length,
    conflictCount: Math.min(MAX_STORED_CONFLICTS, conflicts.length || 0),
  };
}
