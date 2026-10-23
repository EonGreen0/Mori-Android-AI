import {
  listPlannerOutbox,
  markPlannerOutboxAttempt,
  preparePlannerOutboxBatch,
  removePlannerOutboxOperations,
  sealPreparedPlannerOutboxBatch,
  setPlannerOutboxError,
} from "./outbox.js";
import {
  applyPlannerRemoteChanges,
  buildPlannerReconciliationMutations,
  createPlannerRemoteShadow,
  materializePlannerRemoteShadow,
  mergePlannerRemoteState,
} from "./remoteMerge.js";
import {
  commitPlannerRemoteMerge,
  getPlannerRemoteSyncState,
} from "./remoteMergeStore.js";
import {
  normalizeMutationPushResult,
  normalizePullResult,
  requireTransportCapability,
  SYNC_TRANSPORT_CAPABILITIES,
} from "./transport.js";

function errorMessage(error) {
  return String(error?.message || error || "Sync transport error");
}

/**
 * Flush one durable Planner mutation batch.
 *
 * The batch is sealed before network I/O, every operation is marked attempted
 * before it leaves the device, and only explicitly acknowledged opIds are
 * removed. Timeouts and partial responses leave durable retry records intact.
 */
export async function pushPlannerOutboxOnce({
  transport,
  projectId,
  deviceId = "",
  rawLimit = 2000,
  mutationLimit = 200,
} = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.MUTATIONS);
  if (!projectId) throw new Error("Planner outbox push requires projectId");

  const prepared = await preparePlannerOutboxBatch({ projectId, rawLimit, mutationLimit });
  const sealed = await sealPreparedPlannerOutboxBatch(prepared);
  const mutations = sealed.mutations;

  if (!mutations.length) {
    return {
      status: "idle",
      submittedCount: 0,
      acknowledgedCount: 0,
      rejectedCount: 0,
      discardedCount: sealed.discardedCount,
    };
  }

  await Promise.all(mutations.map((mutation) => markPlannerOutboxAttempt(mutation.opId)));

  let rawResult;
  try {
    rawResult = await transport.pushMutations({
      projectId,
      deviceId: String(deviceId || ""),
      mutations,
    });
  } catch (error) {
    const message = errorMessage(error);
    await Promise.all(mutations.map((mutation) => setPlannerOutboxError(mutation.opId, message)));
    return {
      status: "error",
      submittedCount: mutations.length,
      acknowledgedCount: 0,
      rejectedCount: 0,
      discardedCount: sealed.discardedCount,
      error: message,
    };
  }

  const result = normalizeMutationPushResult(rawResult, mutations);
  const acknowledged = new Set(result.acknowledgedOpIds);
  const rejectedById = new Map(result.rejected.map((item) => [item.opId, item]));

  if (result.acknowledgedOpIds.length) {
    await removePlannerOutboxOperations(result.acknowledgedOpIds);
  }

  await Promise.all(
    mutations
      .filter((mutation) => !acknowledged.has(mutation.opId))
      .map((mutation) => {
        const rejected = rejectedById.get(mutation.opId);
        const message = rejected
          ? `${rejected.code}: ${rejected.message}`
          : "Transport returned no acknowledgement for this mutation";
        return setPlannerOutboxError(mutation.opId, message);
      }),
  );

  return {
    status:
      result.acknowledgedOpIds.length === mutations.length
        ? "ok"
        : result.acknowledgedOpIds.length > 0
          ? "partial"
          : "unacknowledged",
    submittedCount: mutations.length,
    acknowledgedCount: result.acknowledgedOpIds.length,
    rejectedCount: result.rejected.length,
    discardedCount: sealed.discardedCount,
    cursor: result.cursor,
    rejected: result.rejected,
  };
}

/**
 * Fetch remote changes without advancing any durable cursor.
 * Cursor persistence must wait until the remote-merge layer has applied the
 * returned changes successfully; that layer is intentionally a later stage.
 */
export async function fetchPlannerRemoteChanges({
  transport,
  projectId,
  cursor = null,
  limit = 200,
} = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.CHANGES);
  if (!projectId) throw new Error("Planner change pull requires projectId");
  const result = await transport.pullChanges({ projectId, cursor, limit });
  return normalizePullResult(result);
}

/**
 * Remote-authoritative pull for read-only clients. Unlike the normal three-way
 * merge path, this never creates reconciliation mutations and never pushes.
 * Device-local Planner fields are preserved by the caller's apply callback.
 */
export async function pullPlannerRemoteStateReadOnly({
  transport,
  projectId,
  applyRemoteShared,
  pageLimit = 200,
  maxPages = 20,
  fromStart = false,
} = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.CHANGES);
  if (!projectId) throw new Error("Read-only Planner pull requires projectId");
  if (typeof applyRemoteShared !== "function") {
    throw new Error("Read-only Planner pull requires applyRemoteShared()");
  }
  const pending = await listPlannerOutbox({ projectId, limit: 1 });
  if (pending.length) {
    return { status: "blocked", reason: "pending-outbox", pendingCountAtLeast: 1 };
  }

  // Rebuild in memory first. Failed downloads must not erase the durable remote state.
  const durable = fromStart
    ? { shadow: createPlannerRemoteShadow(projectId), cursor: null }
    : await getPlannerRemoteSyncState({ transportId: transport.id, projectId });
  let remoteShadow = durable.shadow;
  let cursor = durable.cursor;
  let pageCount = 0;
  let receivedCount = 0;
  let appliedChangeCount = 0;
  let ignoredChangeCount = 0;
  let hasMore = false;

  do {
    if (pageCount >= Math.max(1, Number(maxPages) || 20)) {
      throw new Error("Read-only Planner pull exceeded maxPages before reaching a stable cursor");
    }
    const priorCursor = cursor;
    const page = await fetchPlannerRemoteChanges({
      transport,
      projectId,
      cursor,
      limit: pageLimit,
    });
    pageCount += 1;
    receivedCount += page.changes.length;
    const applied = applyPlannerRemoteChanges(remoteShadow, page.changes, { projectId });
    remoteShadow = applied.shadow;
    appliedChangeCount += applied.applied.length;
    ignoredChangeCount += applied.ignored.length;
    cursor = page.cursor;
    hasMore = page.hasMore;
    if (hasMore && cursor === priorCursor) {
      throw new Error("Read-only transport returned hasMore without advancing cursor");
    }
  } while (hasMore);

  const pendingAfterPull = await listPlannerOutbox({ projectId, limit: 1 });
  if (pendingAfterPull.length) {
    return {
      status: "blocked",
      reason: "local-edits-during-pull",
      pendingCountAtLeast: 1,
      receivedCount,
      cursorNotCommitted: cursor,
    };
  }

  const remoteShared = materializePlannerRemoteShadow(remoteShadow, {
    fallbackProject: { id: projectId, title: "", payload: {} },
  });
  const appliedShared = await applyRemoteShared(remoteShared, { cursor, remoteShadow });
  // The board callback can normalize layout, but its snapshot reads Assets
  // before this transaction saves them. Keep the authoritative pulled catalog.
  const committedShared = appliedShared?.project?.id === projectId
    ? { ...appliedShared, assets: remoteShared.assets }
    : remoteShared;
  const committed = await commitPlannerRemoteMerge({
    transportId: transport.id,
    projectId,
    cursor,
    shadow: remoteShadow,
    merged: committedShared,
    conflicts: [],
    reconciliationMutations: [],
  });
  return {
    status: "ok",
    cursor: committed.cursor,
    pages: pageCount,
    receivedCount,
    appliedChangeCount,
    ignoredChangeCount,
    reconciliationCount: 0,
    merged: committedShared,
  };
}

/**
 * Pull all currently available pages, three-way merge them against the last
 * durable remote shadow and current local shared state, persist the merged
 * Planner through the caller, then atomically advance shadow/cursor/checkpoint.
 *
 * Pull is intentionally blocked while the Outbox contains pending operations.
 * This avoids mixing a remote merge with ambiguous in-flight local mutations;
 * callers should drain/resolve the Outbox first.
 */
export async function pullAndMergePlannerRemoteState({
  transport,
  projectId,
  localShared,
  deviceId = "local",
  applyMergedShared,
  pageLimit = 200,
  maxPages = 20,
  idFactory,
  rebasePendingOutbox = false,
} = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.CHANGES);
  if (!projectId) throw new Error("Planner remote merge requires projectId");
  if (localShared?.project?.id !== projectId) {
    throw new Error("Planner remote merge local project id mismatch");
  }
  if (typeof applyMergedShared !== "function") {
    throw new Error("Planner remote merge requires applyMergedShared()");
  }

  const pending = await listPlannerOutbox({ projectId, limit: 1, all: rebasePendingOutbox });
  if (pending.length && !rebasePendingOutbox) {
    return {
      status: "blocked",
      reason: "pending-outbox",
      pendingCountAtLeast: 1,
    };
  }

  const durable = await getPlannerRemoteSyncState({ transportId: transport.id, projectId });
  const baseShadow = durable.shadow;
  let remoteShadow = baseShadow;
  let cursor = durable.cursor;
  let hasMore = false;
  let pageCount = 0;
  let receivedCount = 0;
  let appliedChangeCount = 0;
  let ignoredChangeCount = 0;

  do {
    if (pageCount >= Math.max(1, Number(maxPages) || 20)) {
      throw new Error("Planner remote pull exceeded maxPages before reaching a stable cursor");
    }
    const priorCursor = cursor;
    const page = await fetchPlannerRemoteChanges({
      transport,
      projectId,
      cursor,
      limit: pageLimit,
    });
    pageCount += 1;
    receivedCount += page.changes.length;

    const applied = applyPlannerRemoteChanges(remoteShadow, page.changes, { projectId });
    remoteShadow = applied.shadow;
    appliedChangeCount += applied.applied.length;
    ignoredChangeCount += applied.ignored.length;
    cursor = page.cursor;
    hasMore = page.hasMore;

    if (hasMore && cursor === priorCursor) {
      throw new Error("Planner remote transport returned hasMore without advancing cursor");
    }
  } while (hasMore);

  const pendingAfterPull = await listPlannerOutbox({ projectId, limit: 1, all: rebasePendingOutbox });
  const originalPendingIds = new Set(pending.map((operation) => operation.opId));
  if (pendingAfterPull.some((operation) => !originalPendingIds.has(operation.opId)) ||
      (!rebasePendingOutbox && pendingAfterPull.length)) {
    return {
      status: "blocked",
      reason: "local-edits-during-pull",
      pendingCountAtLeast: 1,
      receivedCount,
      appliedChangeCount,
      cursorNotCommitted: cursor,
    };
  }

  const merge = mergePlannerRemoteState({
    baseShadow,
    localShared,
    remoteShadow,
  });
  // Persist the visible/local Planner first. If the app crashes after this
  // callback but before the IndexedDB commit, replaying the same remote page is
  // safe. Advancing the cursor before this callback would risk silent data loss.
  // The Planner apply layer may normalize derived UI state (for example an
  // auto-sized text card) while preserving the same semantic merge. If it
  // returns a valid shared envelope, use that exact persisted state for the
  // durable checkpoint and reconciliation diff so restart does not create a
  // phantom local mutation.
  const appliedShared = await applyMergedShared(merge.merged, {
    conflicts: merge.conflicts,
    remoteShadow,
    cursor,
  });
  const committedMerged = appliedShared?.project?.id === projectId
    ? { ...appliedShared, assets: merge.merged.assets }
    : merge.merged;
  const reconciliationMutations = buildPlannerReconciliationMutations({
    remoteShadow,
    merged: committedMerged,
    deviceId,
    idFactory,
  });

  const committed = await commitPlannerRemoteMerge({
    transportId: transport.id,
    projectId,
    cursor,
    shadow: remoteShadow,
    merged: committedMerged,
    conflicts: [...durable.conflicts, ...merge.conflicts],
    reconciliationMutations,
    replaceOutboxOpIds: rebasePendingOutbox ? [...originalPendingIds] : [],
  });

  return {
    status: "ok",
    cursor: committed.cursor,
    pages: pageCount,
    receivedCount,
    appliedChangeCount,
    ignoredChangeCount,
    conflictCount: merge.conflicts.length,
    conflicts: merge.conflicts,
    reconciliationCount: committed.reconciliationCount,
    merged: committedMerged,
  };
}
