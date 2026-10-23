export const SYNC_TRANSPORT_CAPABILITIES = Object.freeze({
  PROJECT_DIRECTORY: "project-directory",
  MUTATIONS: "mutations",
  CHANGES: "changes",
  ASSET_STATE: "asset-state",
  ASSET_DISPLAY_UPLOAD: "asset-display-upload",
  ASSET_DISPLAY_DOWNLOAD: "asset-display-download",
});

const REQUIRED_METHODS = Object.freeze({
  [SYNC_TRANSPORT_CAPABILITIES.PROJECT_DIRECTORY]: "listProjects",
  [SYNC_TRANSPORT_CAPABILITIES.MUTATIONS]: "pushMutations",
  [SYNC_TRANSPORT_CAPABILITIES.CHANGES]: "pullChanges",
  [SYNC_TRANSPORT_CAPABILITIES.ASSET_STATE]: "getAssetStates",
  [SYNC_TRANSPORT_CAPABILITIES.ASSET_DISPLAY_UPLOAD]: "uploadDisplayAsset",
  [SYNC_TRANSPORT_CAPABILITIES.ASSET_DISPLAY_DOWNLOAD]: "downloadDisplayAsset",
});

function normalizeCapabilities(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

export function createSyncTransport(implementation = {}) {
  const id = String(implementation.id || "").trim();
  if (!id) throw new Error("Sync transport requires a stable id");
  const capabilities = normalizeCapabilities(implementation.capabilities);

  capabilities.forEach((capability) => {
    const method = REQUIRED_METHODS[capability];
    if (!method) throw new Error(`Unknown sync transport capability: ${capability}`);
    if (typeof implementation[method] !== "function") {
      throw new Error(`Transport ${id} declares ${capability} but does not implement ${method}()`);
    }
  });

  return Object.freeze({
    id,
    capabilities,
    listProjects: implementation.listProjects?.bind(implementation),
    pushMutations: implementation.pushMutations?.bind(implementation),
    pullChanges: implementation.pullChanges?.bind(implementation),
    getAssetStates: implementation.getAssetStates?.bind(implementation),
    uploadDisplayAsset: implementation.uploadDisplayAsset?.bind(implementation),
    downloadDisplayAsset: implementation.downloadDisplayAsset?.bind(implementation),
  });
}

export function transportSupports(transport, capability) {
  return Boolean(transport?.capabilities?.includes(capability));
}

export function requireTransportCapability(transport, capability) {
  if (!transport?.id) throw new Error("A sync transport is required");
  if (!transportSupports(transport, capability)) {
    throw new Error(`Transport ${transport.id} does not support ${capability}`);
  }
  const method = REQUIRED_METHODS[capability];
  if (!method || typeof transport[method] !== "function") {
    throw new Error(`Transport ${transport.id} is missing ${String(method || capability)}`);
  }
  return transport;
}

export function normalizeMutationPushResult(result, submittedMutations = []) {
  const submitted = new Set(
    (Array.isArray(submittedMutations) ? submittedMutations : [])
      .map((mutation) => mutation?.opId)
      .filter(Boolean),
  );
  const acknowledgedOpIds = [...new Set(
    (Array.isArray(result?.acknowledgedOpIds) ? result.acknowledgedOpIds : [])
      .filter((opId) => submitted.has(opId)),
  )];
  const rejected = (Array.isArray(result?.rejected) ? result.rejected : [])
    .filter((item) => item?.opId && submitted.has(item.opId))
    .map((item) => ({
      opId: item.opId,
      code: String(item.code || "rejected"),
      message: String(item.message || "Mutation rejected"),
      retryable: item.retryable !== false,
    }));

  return {
    acknowledgedOpIds,
    rejected,
    cursor: result?.cursor ?? null,
  };
}

export function normalizePullResult(result) {
  return {
    changes: Array.isArray(result?.changes) ? result.changes : [],
    cursor: result?.cursor ?? null,
    hasMore: result?.hasMore === true,
  };
}
