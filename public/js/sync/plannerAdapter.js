import {
  cloneJson,
  createSyncEnvelope,
  validateSyncEnvelope,
} from "./model.js";

const BOARD_LOCAL_FIELDS = new Set(["view", "readOnly", "localPackage"]);
const BOARD_STRUCTURAL_FIELDS = new Set(["nodes", "edges"]);
const BOARD_ID_FIELDS = new Set(["projectId", "projectTitle"]);
const IMAGE_LOCAL_FIELDS = ["path", "uri", "thumbnail"];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPortableAssetKey(value, assetId = "") {
  const key = String(value || "");
  if (!key) return false;
  if (assetId && key === assetId) return true;
  return key.startsWith("sha256:");
}

function plannerProjectPayload(board) {
  const payload = {};
  Object.entries(board || {}).forEach(([key, value]) => {
    if (BOARD_LOCAL_FIELDS.has(key) || BOARD_STRUCTURAL_FIELDS.has(key) || BOARD_ID_FIELDS.has(key)) {
      return;
    }
    payload[key] = cloneJson(value);
  });
  return payload;
}

function splitPlannerNode(node) {
  const shared = cloneJson(node || {});
  const local = {};

  if (shared?.type === "image") {
    IMAGE_LOCAL_FIELDS.forEach((key) => {
      if (!hasOwn(shared, key)) return;
      local[key] = cloneJson(shared[key]);
      delete shared[key];
    });

    if (hasOwn(shared, "fileKey") && !isPortableAssetKey(shared.fileKey, shared.assetId)) {
      local.fileKey = cloneJson(shared.fileKey);
      delete shared.fileKey;
    }
  }

  return { shared, local };
}

/**
 * Split the current planner board into transport-safe shared state and device-local state.
 * Device-local file references never enter the shared envelope.
 */
export function splitPlannerBoardForSync(board) {
  if (!board || typeof board !== "object" || Array.isArray(board)) {
    throw new Error("Planner board must be an object");
  }

  const projectId = String(board.projectId || "").trim();
  if (!projectId) throw new Error("Planner board requires projectId before sync");

  const nodeFiles = {};
  const nodes = (Array.isArray(board.nodes) ? board.nodes : []).map((node) => {
    const { shared, local } = splitPlannerNode(node);
    if (Object.keys(local).length > 0 && shared.id) {
      nodeFiles[shared.id] = {
        ...local,
        __assetId: String(shared.assetId || ""),
      };
    }
    return shared;
  });

  const shared = createSyncEnvelope({
    project: {
      id: projectId,
      title: String(board.projectTitle || ""),
      payload: plannerProjectPayload(board),
    },
    nodes,
    edges: Array.isArray(board.edges) ? board.edges : [],
  });

  const local = {
    nodeFiles,
  };
  if (hasOwn(board, "view")) local.view = cloneJson(board.view);
  if (hasOwn(board, "readOnly")) local.readOnly = board.readOnly === true;

  return { shared, local };
}

/**
 * Rebuild a planner board from a shared sync envelope plus this device's local bindings.
 * Missing local file bindings are allowed so another device can attach/download assets later.
 */
export function mergePlannerBoardFromSync(shared, local = {}) {
  const validation = validateSyncEnvelope(shared);
  if (!validation.valid) {
    throw new Error(`Invalid planner sync envelope: ${validation.errors.join("; ")}`);
  }

  const payload = shared.project?.payload;
  const board = payload && typeof payload === "object" && !Array.isArray(payload)
    ? cloneJson(payload)
    : {};

  board.nodes = shared.nodes.map((node) => {
    const next = cloneJson(node);
    const localFile = local?.nodeFiles?.[next.id];
    if (localFile && typeof localFile === "object") {
      const boundAssetId = String(localFile.__assetId || "");
      const remoteAssetId = String(next.assetId || "");
      const bindingStillMatches = !boundAssetId || !remoteAssetId || boundAssetId === remoteAssetId;
      if (bindingStillMatches) {
        Object.entries(localFile).forEach(([key, value]) => {
          if (key === "__assetId") return;
          next[key] = cloneJson(value);
        });
      }
    }
    return next;
  });
  board.edges = cloneJson(shared.edges);
  board.projectId = shared.project.id;
  board.projectTitle = shared.project.title || "";

  if (hasOwn(local, "view")) board.view = cloneJson(local.view);
  if (hasOwn(local, "readOnly")) board.readOnly = local.readOnly === true;

  return board;
}

export function plannerBoardRoundTrip(board) {
  const { shared, local } = splitPlannerBoardForSync(board);
  return mergePlannerBoardFromSync(shared, local);
}
