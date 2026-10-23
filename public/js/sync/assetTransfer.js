import { getPlannerAsset } from "./assetStore.js";
import { sha256AssetId, sha256Hex } from "./assetCatalog.js";
import {
  getRemoteAssetState,
  normalizeRemoteAssetState,
  putRemoteAssetState,
  putRemoteAssetStates,
  REMOTE_ASSET_PRESENCE,
} from "./remoteAssetState.js";
import {
  requireTransportCapability,
  SYNC_TRANSPORT_CAPABILITIES,
} from "./transport.js";

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value || []);
}

function normalizeTransportState(transportId, value = {}) {
  return normalizeRemoteAssetState({
    ...value,
    transportId,
    checkedAt: Number(value.checkedAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  });
}

export async function refreshPlannerRemoteAssetStates({ transport, assetIds } = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.ASSET_STATE);
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).filter(Boolean))];
  if (!ids.length) return [];

  const result = await transport.getAssetStates({ assetIds: ids });
  const byId = new Map(
    (Array.isArray(result?.states) ? result.states : [])
      .filter((state) => state?.assetId)
      .map((state) => [state.assetId, state]),
  );

  const states = ids.map((assetId) =>
    normalizeTransportState(transport.id, {
      assetId,
      ...(byId.get(assetId) || {}),
    }),
  );
  await putRemoteAssetStates(states);
  return states;
}

export async function ensurePlannerDisplayAssetRemote({
  transport,
  assetId,
  getDisplayBytes,
} = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.ASSET_STATE);
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.ASSET_DISPLAY_UPLOAD);
  if (!assetId) throw new Error("Display asset upload requires assetId");
  if (typeof getDisplayBytes !== "function") {
    throw new Error("Display asset upload requires getDisplayBytes(asset)");
  }

  const asset = await getPlannerAsset(assetId);
  if (!asset) throw new Error(`Planner asset not found: ${assetId}`);

  let remote = await getRemoteAssetState(transport.id, assetId);
  if (
    remote?.display === REMOTE_ASSET_PRESENCE.PRESENT &&
    remote.displayHash === asset.display?.hash
  ) {
    return { uploaded: false, state: remote };
  }

  [remote] = await refreshPlannerRemoteAssetStates({ transport, assetIds: [assetId] });
  if (
    remote?.display === REMOTE_ASSET_PRESENCE.PRESENT &&
    remote.displayHash === asset.display?.hash
  ) {
    return { uploaded: false, state: remote };
  }

  const bytes = asBytes(await getDisplayBytes(asset));
  if (!bytes.length) throw new Error(`Display bytes are empty for ${assetId}`);
  const actualHash = sha256AssetId(await sha256Hex(bytes));
  if (actualHash !== asset.display?.hash) {
    throw new Error(`Display hash mismatch for ${assetId}`);
  }

  const result = await transport.uploadDisplayAsset({
    asset,
    bytes,
    contentType: asset.display?.mime || "application/octet-stream",
    hash: actualHash,
  });
  const state = normalizeTransportState(transport.id, {
    assetId,
    metadata: REMOTE_ASSET_PRESENCE.PRESENT,
    display: REMOTE_ASSET_PRESENCE.PRESENT,
    original: result?.original || remote?.original || REMOTE_ASSET_PRESENCE.UNKNOWN,
    displayHash: actualHash,
    originalHash: result?.originalHash || remote?.originalHash || "",
    displayRef: result?.displayRef || "",
    originalRef: result?.originalRef || remote?.originalRef || "",
  });
  await putRemoteAssetState(state);
  return { uploaded: true, state };
}

export async function downloadPlannerDisplayAsset({ transport, assetId } = {}) {
  requireTransportCapability(transport, SYNC_TRANSPORT_CAPABILITIES.ASSET_DISPLAY_DOWNLOAD);
  if (!assetId) throw new Error("Display asset download requires assetId");
  const asset = await getPlannerAsset(assetId);
  if (!asset) throw new Error(`Planner asset not found: ${assetId}`);

  const result = await transport.downloadDisplayAsset({
    assetId,
    expectedHash: asset.display?.hash || "",
  });
  const bytes = asBytes(result?.bytes);
  if (!bytes.length) throw new Error(`Downloaded display asset is empty: ${assetId}`);
  const actualHash = sha256AssetId(await sha256Hex(bytes));
  if (actualHash !== asset.display?.hash) {
    throw new Error(`Downloaded display hash mismatch for ${assetId}`);
  }

  const state = normalizeTransportState(transport.id, {
    assetId,
    metadata: REMOTE_ASSET_PRESENCE.PRESENT,
    display: REMOTE_ASSET_PRESENCE.PRESENT,
    original: result?.original || REMOTE_ASSET_PRESENCE.UNKNOWN,
    displayHash: actualHash,
    displayRef: result?.displayRef || "",
  });
  await putRemoteAssetState(state);
  return { bytes, contentType: result?.contentType || asset.display?.mime || "", state };
}
