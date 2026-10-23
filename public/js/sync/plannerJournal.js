import { splitPlannerBoardForSync } from "./plannerAdapter.js";
import { getPlannerAssetsByIds } from "./assetStore.js";
import { diffPlannerSyncEnvelopes } from "./mutations.js";
import {
  getPlannerSyncMeta,
  stagePlannerSyncChanges,
} from "./outbox.js";

const CHECKPOINT_PREFIX = "planner_checkpoint_v1:";

export function plannerCheckpointKey(projectId) {
  return `${CHECKPOINT_PREFIX}${projectId}`;
}

export async function getPlannerSyncCheckpoint(projectId) {
  if (!projectId) return null;
  return getPlannerSyncMeta(plannerCheckpointKey(projectId), null);
}

export async function snapshotPlannerBoardForSync(board) {
  const { shared, local } = splitPlannerBoardForSync(board);
  const assetIds = shared.nodes
    .filter((node) => node?.type === "image" && node?.assetId)
    .map((node) => node.assetId);
  shared.assets = await getPlannerAssetsByIds(assetIds);
  return { shared, local };
}

/**
 * Convert the current planner board into shared state, diff it against the
 * durable local checkpoint, and atomically append resulting mutations while
 * advancing that checkpoint.
 *
 * This function does not perform network I/O. It is safe to call while offline.
 */
export async function stagePlannerBoardForSync(board, options = {}) {
  const { shared, local } = await snapshotPlannerBoardForSync(board);
  const previous = await getPlannerSyncCheckpoint(shared.project.id);
  const mutations = diffPlannerSyncEnvelopes(previous, shared, {
    deviceId: options.deviceId || "local",
    timestamp: options.timestamp,
    idFactory: options.idFactory,
  });

  if (mutations.length > 0 || !previous) {
    await stagePlannerSyncChanges({
      mutations,
      checkpointKey: plannerCheckpointKey(shared.project.id),
      checkpointValue: shared,
    });
  }

  return {
    projectId: shared.project.id,
    shared,
    local,
    mutations,
  };
}
