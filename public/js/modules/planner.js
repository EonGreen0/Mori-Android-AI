// planner.js — freeform planning canvas built from inspiration albums
import { t } from "../i18n/index.js";
import { showToast, Filesystem } from "../utils/index.js";
import { loadAndroidLocalImage } from "../utils/localImage.js";
import { showConfirm } from "./modals.js";
import { getOrCreateSyncDeviceId } from "../sync/device.js";
import { collectFavoriteFrame } from "./favoritesStore.js";
import {
  createPlannerAssetLocalBinding,
  plannerAssetFromPackageEntry,
  plannerAssetNeedsDisplayRebuild,
  preparePlannerImageAsset,
} from "../sync/assetCatalog.js";
import { getPlannerAssetsByIds, putPlannerAsset } from "../sync/assetStore.js";
import { getImportedAlbumLibraries } from "../sync/albumLibrary.js";
import {
  snapshotPlannerBoardForSync,
  stagePlannerBoardForSync,
} from "../sync/plannerJournal.js";
import {
  mergePlannerBoardFromSync,
  splitPlannerBoardForSync,
} from "../sync/plannerAdapter.js";
import {
  addCapturedFrameToActiveAlbum,
  getActiveInspirationAlbumSnapshot,
  renderInspiration,
} from "./inspiration.js";

const LEGACY_BOARD_KEY = "mori_planner_board_v1";
const PROJECT_INDEX_KEY = "mori_planner_projects_v2";
const BOARD_KEY_PREFIX = "mori_planner_board_v2:";
const ALBUM_BINDING_BACKUP_KEY = "mori_android_album_binding_backup_v1";
const PENDING_IMAGE_IMPORTS_KEY = "mori_planner_pending_image_imports_v1";
const LAST_EXPORT_PATH_KEY = "mori_planner_last_export_path_v1";
const MIN_NODE_WIDTH = 96;
const MAX_IMAGE_WIDTH = 3600;
const MAX_TEXT_WIDTH = 2400;
const MAX_GROUP_WIDTH = 6000;
const MAX_GROUP_HEIGHT = 4800;
const MIN_TEXT_FONT_SIZE = 12;
const MAX_TEXT_FONT_SIZE = 96;
const DEFAULT_TEXT_FONT_SIZE = 16;
const MIN_COMMENT_FONT_SIZE = 14;
const MAX_COMMENT_FONT_SIZE = 30;
const DEFAULT_COMMENT_FONT_SIZE = 17;
const MIN_PLANNER_ZOOM = 0.001;
const MAX_PLANNER_ZOOM = 8;
const MIN_IMAGE_COMMENT_SCALE = 0.5;
const MAX_IMAGE_COMMENT_SCALE = 6;
const MIN_GROUP_LABEL_SCALE = 0.6;
const MAX_GROUP_LABEL_SCALE = 8;
const PLANNER_EXTERNAL_FOLDER = "Mori/Planner";
const PLANNER_SYNC_FOLDER = "Mori/PlannerSync";
const MORI_PACKAGE_MAGIC = "MORI-PLAN-1\n";
const MORI_PACKAGE_VERSION = 1;
const PLANNER_SYNC_CAPTURE_FLAG_KEY = "mori_planner_sync_capture_v1";

let board = createEmptyBoard();
let activePlannerAlbumId = null;
let activePlannerProjectId = null;
let selectedNodeIds = new Set();
let selectedEdgeId = null;
let connectingEdge = null;
let plannerBound = false;
let globalFrameListenerBound = false;
let frameCaptureBusy = false;
let spacePressed = false;
let lastPlannerPointer = null;
const plannerObjectUrls = new Set();
const plannerObjectUrlByNode = new Map();
let plannerSyncStageQueue = Promise.resolve();
let plannerLocalGeneration = 0;
let androidLimitedWriteEnabled = false;
let androidTouchWasMultitouch = false;
let androidTouchManipulation = null;

function createEmptyBoard(options = {}) {
  return {
    nodes: [],
    edges: [],
    view: { zoom: 0.9, panX: 80, panY: 80 },
    importCount: 0,
    commentFontSize: DEFAULT_COMMENT_FONT_SIZE,
    projectId: options.projectId || id("project"),
    projectTitle: options.projectTitle || t("planner-default-project-title"),
    readOnly: options.readOnly === true,
  };
}

function isDefaultPlannerProjectTitle(value) {
  const title = String(value || "").trim();
  if (!title) return true;
  return new Set([
    t("planner-default-project-title"),
    "Untitled Plan",
    "未命名策划",
  ]).has(title);
}

function normalizeStoredBoard(parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
  const nodes = parsed.nodes.map((node) => {
    const next = { ...node };
    if (next.type === "text" && !next.userSized) next.w = autoSizedTextWidth(next);
    if (next.type === "image") {
      next.rotation = normalizeRotation(next.rotation);
      next.commentScale = normalizeImageCommentScale(next.commentScale);
    }
    if (next.type === "group") next.groupLabelScale = normalizeGroupLabelScale(next.groupLabelScale);
    return next;
  });
  return {
    nodes,
    edges: parsed.edges,
    view: {
      zoom: Number(parsed.view?.zoom) || 0.9,
      panX: Number.isFinite(parsed.view?.panX) ? parsed.view.panX : 80,
      panY: Number.isFinite(parsed.view?.panY) ? parsed.view.panY : 80,
    },
    importCount: Number(parsed.importCount) || 0,
    commentFontSize: normalizeCommentFontSize(parsed.commentFontSize),
    projectId: parsed.projectId || options.projectId || id("project"),
    projectTitle: parsed.projectTitle || options.projectTitle || t("planner-default-project-title"),
    readOnly: parsed.readOnly === true || options.readOnly === true,
    ...(parsed.localPackage === true ? { localPackage: true } : {}),
  };
}

function plannerBoardStorageKey(projectId) {
  return `${BOARD_KEY_PREFIX}${String(projectId || "").trim()}`;
}

function loadPlannerIndex() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_INDEX_KEY) || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        version: 2,
        projects:
          parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
            ? parsed.projects
            : {},
        activeProjectByAlbum:
          parsed.activeProjectByAlbum &&
          typeof parsed.activeProjectByAlbum === "object" &&
          !Array.isArray(parsed.activeProjectByAlbum)
            ? parsed.activeProjectByAlbum
            : {},
        legacyMigration:
          parsed.legacyMigration && typeof parsed.legacyMigration === "object"
            ? parsed.legacyMigration
            : null,
      };
    }
  } catch (_) {}
  return { version: 2, projects: {}, activeProjectByAlbum: {}, legacyMigration: null };
}

function savePlannerIndex(index) {
  localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(index));
}

function inferLegacyAlbumId(legacyBoard) {
  const counts = new Map();
  (legacyBoard?.nodes || []).forEach((node) => {
    if (node?.type !== "image") return;
    const albumId = String(node.albumId || "").trim();
    if (!albumId || albumId === "external") return;
    counts.set(albumId, (counts.get(albumId) || 0) + 1);
  });
  let bestId = "";
  let bestCount = 0;
  counts.forEach((count, albumId) => {
    if (count > bestCount) {
      bestId = albumId;
      bestCount = count;
    }
  });
  return bestId;
}

function registerPlannerProject(index, nextBoard, albumId) {
  const projectId = String(nextBoard?.projectId || "").trim();
  if (!projectId) throw new Error("Planner project requires a stable projectId");
  const now = Date.now();
  const previous = index.projects[projectId] || {};
  const albumIds = new Set(Array.isArray(previous.albumIds) ? previous.albumIds : []);
  if (albumId) albumIds.add(albumId);
  index.projects[projectId] = {
    ...previous,
    projectId,
    title: nextBoard.projectTitle || previous.title || t("planner-default-project-title"),
    albumIds: [...albumIds],
    createdAt: Number(previous.createdAt) || now,
    updatedAt: now,
  };
  if (albumId) index.activeProjectByAlbum[albumId] = projectId;
}

function migrateLegacyPlannerIfNeeded(index, currentAlbumId) {
  if (index.legacyMigration?.completed) return index;
  const rawText = localStorage.getItem(LEGACY_BOARD_KEY);
  if (!rawText) {
    index.legacyMigration = { completed: true, sourceKey: LEGACY_BOARD_KEY, empty: true };
    savePlannerIndex(index);
    return index;
  }
  try {
    const parsed = JSON.parse(rawText);
    const meaningful =
      Array.isArray(parsed?.nodes) &&
      Array.isArray(parsed?.edges) &&
      (parsed.nodes.length > 0 || parsed.edges.length > 0 || String(parsed.projectId || "").trim());
    if (!meaningful) {
      index.legacyMigration = { completed: true, sourceKey: LEGACY_BOARD_KEY, empty: true };
      savePlannerIndex(index);
      return index;
    }
    // Old Android downloads had no album identity. Keep their boards available
    // for sync without attaching them to whichever tab happens to be open.
    const legacyAlbumId = isAndroidNative() ? "" : inferLegacyAlbumId(parsed) || currentAlbumId || "";
    const migrated = normalizeStoredBoard(parsed, {
      projectId: String(parsed.projectId || "").trim() || id("project"),
    });
    if (!migrated) throw new Error("Legacy Planner board is invalid");
    localStorage.setItem(plannerBoardStorageKey(migrated.projectId), JSON.stringify(migrated));
    registerPlannerProject(index, migrated, legacyAlbumId);
    index.legacyMigration = {
      completed: true,
      sourceKey: LEGACY_BOARD_KEY,
      projectId: migrated.projectId,
      albumId: legacyAlbumId,
      migratedAt: Date.now(),
    };
    savePlannerIndex(index);
  } catch (error) {
    console.warn("Could not migrate legacy Planner board; keeping legacy data untouched:", error);
  }
  return index;
}

function loadProjectBoard(projectId) {
  if (!projectId) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(plannerBoardStorageKey(projectId)) || "null");
    return normalizeStoredBoard(parsed, { projectId });
  } catch (_) {
    return null;
  }
}

export function getAlbumPlannerProject(albumId) {
  // Corrupt indexes must stop publishing rather than detach an existing plan.
  const raw = localStorage.getItem(PROJECT_INDEX_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" ||
        !parsed.activeProjectByAlbum || Array.isArray(parsed.activeProjectByAlbum) || typeof parsed.activeProjectByAlbum !== "object") {
      throw new Error("策划索引无法读取，已停止同步");
    }
  }
  const index = migrateLegacyPlannerIfNeeded(loadPlannerIndex(), albumId);
  const projectId = String(index.activeProjectByAlbum[albumId] || "");
  if (!projectId) return null;
  const stored = localStorage.getItem(plannerBoardStorageKey(projectId));
  const saved = stored && normalizeStoredBoard(JSON.parse(stored), { projectId });
  if (!saved) throw new Error("相册关联的策划无法读取，已停止同步");
  return { projectId, title: saved.projectTitle };
}

export async function getSavedPlannerSyncSnapshot(projectId) {
  const raw = localStorage.getItem(plannerBoardStorageKey(projectId));
  if (raw === null) return null;
  const saved = normalizeStoredBoard(JSON.parse(raw), { projectId });
  if (!saved) throw new Error("手机已有策划无法读取，未覆盖本地数据");
  return snapshotPlannerBoardForSync(saved);
}

export function getAlbumPlannerPackageSnapshot(albumId) {
  const linked = getAlbumPlannerProject(albumId);
  if (!linked) return null;
  const saved = loadProjectBoard(linked.projectId);
  if (!saved) throw new Error("关联策划无法读取，已停止导出");
  return JSON.parse(JSON.stringify(saved));
}

export function saveLocalAlbumPackagePlanner(nextBoard, albumId, commitLibrary) {
  if (!isAndroidNative() || nextBoard.localPackage !== true || !String(nextBoard.projectId).startsWith("local-album-plan:")) throw new Error("无效的本地相册策划");
  const boardKey = plannerBoardStorageKey(nextBoard.projectId);
  if (localStorage.getItem(boardKey) !== null) throw new Error("导入身份已存在，已保留原内容");
  const previousIndex = localStorage.getItem(PROJECT_INDEX_KEY);
  if (previousIndex) {
    const raw = JSON.parse(previousIndex);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        !raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects) ||
        !raw.activeProjectByAlbum || typeof raw.activeProjectByAlbum !== "object" || Array.isArray(raw.activeProjectByAlbum)) throw new Error("策划索引无效，未改动原数据");
  }
  const next = normalizeStoredBoard(nextBoard);
  if (!next) throw new Error("策划内容无效");
  const index = loadPlannerIndex();
  registerPlannerProject(index, next, albumId);
  try {
    localStorage.setItem(boardKey, JSON.stringify(next));
    savePlannerIndex(index);
    commitLibrary();
  } catch (error) {
    localStorage.removeItem(boardKey);
    if (previousIndex === null) localStorage.removeItem(PROJECT_INDEX_KEY); else localStorage.setItem(PROJECT_INDEX_KEY, previousIndex);
    throw error;
  }
}

export async function settleAndroidPlannerEdits() {
  if (!isAndroidNative()) return;
  await plannerSyncStageQueue;
}

export function refreshAndroidPlannerFromStorage(projectId) {
  if (!isAndroidNative() || activePlannerProjectId !== projectId) return;
  const saved = loadProjectBoard(projectId);
  if (!saved) return;
  activatePlannerBoard(saved, activePlannerAlbumId);
  renderPlanner({ full: true });
}

export function normalizeAndroidPlannerSyncCheckpoint(shared) {
  if (!shared) return null;
  // Defaults introduced by older UI migrations are presentation repairs, not
  // user edits. Compare both sides using the same local board representation.
  const normalized = normalizeStoredBoard(mergePlannerBoardFromSync(shared, { readOnly: true }));
  return { ...splitPlannerBoardForSync(normalized).shared, assets: shared.assets || [] };
}

export function repairAndroidPlannerAlbumBindings() {
  if (!isAndroidNative()) return false;
  const previousIndex = localStorage.getItem(PROJECT_INDEX_KEY);
  if (!previousIndex) return false;
  const raw = JSON.parse(previousIndex);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      !raw.activeProjectByAlbum || typeof raw.activeProjectByAlbum !== "object" || Array.isArray(raw.activeProjectByAlbum)) {
    throw new Error("策划索引无法读取，未整理旧关联");
  }
  const index = loadPlannerIndex();
  const cloudProjects = new Set();
  try {
    const oldDirectory = JSON.parse(localStorage.getItem("mori_android_planner_directory_v1") || "null");
    for (const project of oldDirectory?.projects || []) if (project.projectId) cloudProjects.add(String(project.projectId));
  } catch (_) { /* Only verified old directory entries can identify orphan bindings. */ }
  const linkedAlbums = new Map();
  for (const album of getImportedAlbumLibraries().flatMap(library => library.albums)) {
    if (!album.plannerProjectId) continue;
    cloudProjects.add(album.plannerProjectId);
    if (!loadProjectBoard(album.plannerProjectId)) continue;
    if (!linkedAlbums.has(album.plannerProjectId)) linkedAlbums.set(album.plannerProjectId, new Set());
    linkedAlbums.get(album.plannerProjectId).add(album.id);
  }
  let changed = false;
  for (const [albumId, projectId] of Object.entries(index.activeProjectByAlbum)) {
    if (cloudProjects.has(projectId) && !linkedAlbums.get(projectId)?.has(albumId)) {
      delete index.activeProjectByAlbum[albumId]; changed = true;
    }
  }
  for (const projectId of cloudProjects) {
    const albumIds = [...(linkedAlbums.get(projectId) || [])];
    for (const albumId of albumIds) {
      if (index.activeProjectByAlbum[albumId] !== projectId) {
        index.activeProjectByAlbum[albumId] = projectId; changed = true;
      }
    }
    const project = index.projects[projectId];
    if (project && JSON.stringify(project.albumIds || []) !== JSON.stringify(albumIds)) {
      project.albumIds = albumIds; changed = true;
    }
  }
  if (!changed) return false;
  if (!localStorage.getItem(ALBUM_BINDING_BACKUP_KEY)) localStorage.setItem(ALBUM_BINDING_BACKUP_KEY, previousIndex);
  savePlannerIndex(index);
  return true;
}

export function saveAndroidAlbumPlanner(shared, bindings, albumId, commitLibrary) {
  if (!isAndroidNative()) throw new Error("仅手机可以保存下载的相册策划");
  const projectId = String(shared?.project?.id || "");
  const boardKey = plannerBoardStorageKey(projectId);
  const previousBoard = localStorage.getItem(boardKey);
  const previousIndex = localStorage.getItem(PROJECT_INDEX_KEY);
  const existing = previousBoard ? normalizeStoredBoard(JSON.parse(previousBoard), { projectId }) : null;
  const local = existing ? splitPlannerBoardForSync(existing).local : { readOnly: true };
  const next = normalizeStoredBoard(mergePlannerBoardFromSync(shared, local), { projectId, readOnly: true });
  const byNode = new Map(bindings.map(binding => [binding.nodeId, binding]));
  for (const node of next.nodes) {
    const binding = byNode.get(node.id);
    if (node.type === "image" && binding?.assetId === node.assetId) {
      node.uri = binding.uri; node.path = ""; node.thumbnail = "";
    } else if (node.type === "image") {
      for (const field of ["uri", "path"]) {
        if (String(node[field] || "").includes("/Mori/Sync/Images/")) node[field] = "";
      }
    }
  }
  if (previousIndex) JSON.parse(previousIndex);
  const index = loadPlannerIndex();
  registerPlannerProject(index, next, albumId);
  try {
    localStorage.setItem(boardKey, JSON.stringify(next));
    savePlannerIndex(index);
    commitLibrary();
  } catch (error) {
    if (previousBoard === null) localStorage.removeItem(boardKey); else localStorage.setItem(boardKey, previousBoard);
    if (previousIndex === null) localStorage.removeItem(PROJECT_INDEX_KEY); else localStorage.setItem(PROJECT_INDEX_KEY, previousIndex);
    throw error;
  }
  if (activePlannerProjectId === projectId && activePlannerAlbumId === albumId) {
    activatePlannerBoard(next, albumId);
    renderPlanner({ full: true });
  }
}

function activatePlannerBoard(nextBoard, albumId) {
  const nextProjectId = String(nextBoard?.projectId || "");
  const changedProject = activePlannerProjectId !== nextProjectId;
  revokePlannerObjectUrls();
  board = nextBoard;
  activePlannerProjectId = nextProjectId;
  activePlannerAlbumId = albumId || null;
  selectedNodeIds.clear();
  selectedEdgeId = null;
  connectingEdge = null;
  if (changedProject) plannerLocalGeneration += 1;
}

function ensurePlannerForActiveAlbum({ seedFromAlbum = true } = {}) {
  const snapshot = getActiveInspirationAlbumSnapshot();
  if (isAndroidNative()) repairAndroidPlannerAlbumBindings();
  let index = loadPlannerIndex();
  index = migrateLegacyPlannerIfNeeded(index, snapshot.id);
  const boundProjectId = String((isAndroidNative() && snapshot.synced ? snapshot.plannerProjectId : index.activeProjectByAlbum[snapshot.id]) || "");
  const existing = loadProjectBoard(boundProjectId);
  if (existing) {
    const albumTitle = String(snapshot.name || "").trim();
    const repairedTitle =
      !isAndroidNative() &&
      albumTitle &&
      !isDefaultPlannerProjectTitle(albumTitle) &&
      isDefaultPlannerProjectTitle(existing.projectTitle);
    if (repairedTitle) existing.projectTitle = albumTitle;
    const enableLocalEditing = !snapshot.synced && existing.readOnly === true;
    if (enableLocalEditing) {
      existing.readOnly = false;
    }
    if (
      repairedTitle ||
      enableLocalEditing ||
      activePlannerProjectId !== existing.projectId ||
      activePlannerAlbumId !== snapshot.id
    ) {
      activatePlannerBoard(existing, snapshot.id);
    }
    if (repairedTitle || enableLocalEditing) saveBoard({ captureSync: false });
    return { board: existing, snapshot, created: false, repairedTitle };
  }
  const nextBoard = createEmptyBoard({ projectTitle: snapshot.name || t("planner-default-project-title") });
  activatePlannerBoard(nextBoard, snapshot.id);
  registerPlannerProject(index, nextBoard, snapshot.id);
  savePlannerIndex(index);
  localStorage.setItem(plannerBoardStorageKey(nextBoard.projectId), JSON.stringify(nextBoard));
  if (seedFromAlbum) {
    addAlbumSnapshotToBoard(snapshot);
    saveBoard();
  }
  return { board: nextBoard, snapshot, created: true };
}

function plannerSyncCaptureEnabled() {
  return localStorage.getItem(PLANNER_SYNC_CAPTURE_FLAG_KEY) === "1";
}

function queuePlannerSyncCapture(snapshot) {
  if (snapshot.localPackage || !plannerSyncCaptureEnabled()) return;
  const deviceId = getOrCreateSyncDeviceId();
  plannerSyncStageQueue = plannerSyncStageQueue
    .then(() => stagePlannerBoardForSync(snapshot, { deviceId }))
    .catch((error) => {
      console.warn("Planner sync staging failed:", error);
    });
}

function normalizeBoardForPersistence() {
  (board?.nodes || []).forEach((node) => {
    if (node?.type === "image") {
      node.rotation = normalizeRotation(node.rotation);
      node.commentScale = normalizeImageCommentScale(node.commentScale);
    }
    if (node?.type === "group") {
      node.groupLabelScale = normalizeGroupLabelScale(node.groupLabelScale);
    }
  });
}

function saveBoard(options = {}) {
  const projectId = String(board?.projectId || activePlannerProjectId || "").trim();
  if (!projectId) return;
  if (options.markLocalChange !== false) plannerLocalGeneration += 1;
  board.projectId = projectId;
  activePlannerProjectId = projectId;
  normalizeBoardForPersistence();
  const serialized = JSON.stringify(board);
  localStorage.setItem(plannerBoardStorageKey(projectId), serialized);
  const index = loadPlannerIndex();
  registerPlannerProject(index, board, activePlannerAlbumId);
  savePlannerIndex(index);
  if (!board.localPackage && options.captureSync !== false && plannerSyncCaptureEnabled()) {
    queuePlannerSyncCapture(JSON.parse(serialized));
  }
}

function loadPendingImageImports() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_IMAGE_IMPORTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.fileKey) : [];
  } catch (_) {
    return [];
  }
}

function savePendingImageImports(items) {
  const next = Array.isArray(items) ? items.slice(-240) : [];
  localStorage.setItem(PENDING_IMAGE_IMPORTS_KEY, JSON.stringify(next));
}

function normalizePlannerFileKey(value) {
  return String(value || "")
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function isPlannerImagePath(value) {
  return /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:$|[?#])/i.test(String(value || ""));
}

function rememberPendingImageImport(detail) {
  const fileKey = String(detail?.path || detail?.uri || "");
  if (!fileKey || !isPlannerImagePath(fileKey)) return;
  const normalized = normalizePlannerFileKey(fileKey);
  const pending = loadPendingImageImports();
  const next = pending.filter((item) => normalizePlannerFileKey(item.fileKey) !== normalized);
  next.push({
    fileKey,
    path: detail?.path || "",
    uri: detail?.uri || detail?.path || "",
    sourceUrl: detail?.url || detail?.sourceUrl || "",
    title: detail?.title || "Reference",
    savedAt: Date.now(),
  });
  savePendingImageImports(next);
}

function normalizeCommentFontSize(value) {
  return Math.max(
    MIN_COMMENT_FONT_SIZE,
    Math.min(MAX_COMMENT_FONT_SIZE, Number(value) || DEFAULT_COMMENT_FONT_SIZE),
  );
}

function normalizeImageCommentScale(value) {
  return Math.max(
    MIN_IMAGE_COMMENT_SCALE,
    Math.min(MAX_IMAGE_COMMENT_SCALE, Number(value) || 1),
  );
}

function normalizeGroupLabelScale(value) {
  return Math.max(
    MIN_GROUP_LABEL_SCALE,
    Math.min(MAX_GROUP_LABEL_SCALE, Number(value) || 1),
  );
}

function applyPlannerCommentFontSize({ persist = false } = {}) {
  board.commentFontSize = normalizeCommentFontSize(board.commentFontSize);
  document.documentElement.style.setProperty(
    "--planner-comment-font-size",
    `${board.commentFontSize}px`,
  );
  document.querySelectorAll(".planner-comment-size-value").forEach((el) => {
    el.textContent = `${board.commentFontSize}`;
  });
  if (persist) saveBoard();
}

function adjustPlannerCommentFontSize(delta) {
  if (board.readOnly) return;
  board.commentFontSize = normalizeCommentFontSize(board.commentFontSize + delta);
  applyPlannerCommentFontSize({ persist: true });
}

function id(prefix = "node") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function plannerElements() {
  return {
    page: document.getElementById("inspirationPage"),
    viewport: document.getElementById("plannerViewport"),
    toolbar: document.getElementById("plannerToolbar"),
    libraryToolbar: document.querySelector("#inspirationPage > .inspiration-toolbar"),
    libraryViewport: document.getElementById("inspirationViewport"),
    stage: document.getElementById("plannerStage"),
    nodes: document.getElementById("plannerNodes"),
    edges: document.getElementById("plannerEdges"),
    marquee: document.getElementById("plannerMarquee"),
    selectionToolbar: document.getElementById("plannerSelectionToolbar"),
    mobileControls: document.getElementById("plannerMobileControls"),
    multiTransform: document.getElementById("plannerMultiTransform"),
    empty: document.getElementById("plannerEmpty"),
    selectionCount: document.getElementById("plannerSelectionCount"),
    libraryModeBtn: document.getElementById("inspirationLibraryModeBtn"),
    plannerModeBtn: document.getElementById("inspirationPlannerModeBtn"),
  };
}

function isPlannerMode() {
  return plannerElements().page?.classList.contains("planner-mode") || false;
}

function revokePlannerObjectUrls() {
  plannerObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  plannerObjectUrls.clear();
  plannerObjectUrlByNode.clear();
}

function revokePlannerObjectUrlForNode(nodeId) {
  const url = plannerObjectUrlByNode.get(nodeId);
  if (!url) return;
  URL.revokeObjectURL(url);
  plannerObjectUrls.delete(url);
  plannerObjectUrlByNode.delete(nodeId);
}

function guessMime(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".avif")) return "image/avif";
  if (lower.includes(".bmp")) return "image/bmp";
  if (lower.includes(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function getTauriInvoke() {
  return (
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke ||
    null
  );
}

function isAndroidNative() {
  return window.Capacitor?.getPlatform?.() === "android";
}

function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function imageTypeFromBytes(bytes, mimeHint = "", nameHint = "") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const mime = String(mimeHint || "").toLowerCase();
  const name = String(nameHint || "").toLowerCase();
  const ascii = (start, length) =>
    String.fromCharCode(...data.slice(start, start + length));

  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (data.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (data.length >= 2 && ascii(0, 2) === "BM") {
    return { ext: "bmp", mime: "image/bmp" };
  }
  if (data.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4).toLowerCase();
    if (["avif", "avis"].includes(brand)) return { ext: "avif", mime: "image/avif" };
  }

  const prefix = new TextDecoder().decode(data.slice(0, Math.min(data.length, 256))).trimStart();
  if (prefix.startsWith("<svg") || prefix.startsWith("<?xml") && prefix.includes("<svg")) {
    return { ext: "svg", mime: "image/svg+xml" };
  }

  const mimeMap = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
  };
  if (mimeMap[mime]) return { ext: mimeMap[mime], mime: mime === "image/jpg" ? "image/jpeg" : mime };

  const extension = name.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase();
  const extMap = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  if (extension && extMap[extension]) {
    return { ext: extension === "jpeg" ? "jpg" : extension, mime: extMap[extension] };
  }
  return null;
}

function safeExternalFilename(nameHint, ext) {
  const rawBase = String(nameHint || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}_ -]+/gu, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 48);
  const base = rawBase || "Planner_Image";
  return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

async function persistExternalImage(bytes, { name = "", mime = "" } = {}) {
  const type = imageTypeFromBytes(bytes, mime, name);
  if (!type) throw new Error("Not an image");
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const filename = safeExternalFilename(name, type.ext);
  const invoke = getTauriInvoke();

  if (invoke) {
    const path = await invoke("tauri_save_bytes_file", {
      bytes: Array.from(data),
      filename,
      folder: PLANNER_EXTERNAL_FOLDER,
    });
    return { path, mime: type.mime, filename };
  }

  if (isAndroidNative() && Filesystem) {
    const result = await Filesystem.writeFile({
      path: `${PLANNER_EXTERNAL_FOLDER}/${filename}`,
      directory: "DATA",
      data: bytesToBase64(data),
      recursive: true,
    });
    return {
      path: result?.uri || `${PLANNER_EXTERNAL_FOLDER}/${filename}`,
      mime: type.mime,
      filename,
    };
  }

  throw new Error("Persistent image import is unavailable on this platform");
}

function plannerPastePoint() {
  const { viewport } = plannerElements();
  if (!viewport) return { x: 0, y: 0 };
  if (lastPlannerPointer) {
    return viewportPointToWorld(lastPlannerPointer.x, lastPlannerPointer.y);
  }
  const rect = viewport.getBoundingClientRect();
  return viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function plannerViewportCenterPoint() {
  const { viewport } = plannerElements();
  if (!viewport) return { x: 0, y: 0 };
  const rect = viewport.getBoundingClientRect();
  if (rect.width > 2 && rect.height > 2) {
    return viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  const fallbackWidth = 900;
  const fallbackHeight = 600;
  return {
    x: (fallbackWidth / 2 - board.view.panX) / board.view.zoom,
    y: (fallbackHeight / 2 - board.view.panY) / board.view.zoom,
  };
}

function addExternalImageNode(path, point, title = "External image", assetId = "") {
  const node = {
    id: id("image"),
    type: "image",
    fileKey: path,
    path,
    uri: path,
    thumbnail: "",
    title,
    sourceUrl: "",
    albumId: "external",
    x: point.x,
    y: point.y,
    w: 280,
    rotation: 0,
    comment: "",
    external: true,
    ...(assetId ? { assetId, fileKey: assetId } : {}),
  };
  board.nodes.push(node);
  selectedNodeIds = new Set([node.id]);
  selectedEdgeId = null;
  saveBoard();
  renderPlanner();
  return node;
}

function addReferenceFrameNode(detail, { render = true, point = null } = {}) {
  const fileKey = detail?.path || detail?.uri || "";
  if (!fileKey || board.nodes.some((node) => node.type === "image" && node.fileKey === fileKey)) {
    return null;
  }
  point = point || plannerPastePoint();
  const node = {
    id: id("image"),
    type: "image",
    fileKey,
    path: detail.path || "",
    uri: detail.uri || detail.path || "",
    thumbnail: detail.thumbnail || "",
    title: detail.title || t("planner-captured-frame-title"),
    sourceUrl: detail.sourceUrl || "",
    albumId: detail.albumId || getActiveInspirationAlbumSnapshot().id,
    x: point.x,
    y: point.y,
    w: 280,
    rotation: 0,
    comment: "",
    external: false,
  };
  board.nodes.push(node);
  selectedNodeIds = new Set([node.id]);
  selectedEdgeId = null;
  saveBoard();
  if (render) renderPlanner();
  return node;
}

function syncPendingActiveAlbumImages() {
  if (board.readOnly) return 0;
  const snapshot = getActiveInspirationAlbumSnapshot();
  const pending = loadPendingImageImports();
  if (!pending.length) return 0;

  const pendingKeys = new Set(pending.map((item) => normalizePlannerFileKey(item.fileKey)));
  const existing = new Set(
    board.nodes
      .filter((node) => node.type === "image")
      .flatMap((node) => [node.fileKey, node.path, node.uri])
      .filter(Boolean)
      .map(normalizePlannerFileKey),
  );
  const consumed = new Set();
  let added = 0;
  let offset = 0;
  const point = plannerPastePoint();

  snapshot.groups.forEach((group) => {
    group.files.forEach((file) => {
      const fileKey = file.path || file.uri || "";
      const normalized = normalizePlannerFileKey(fileKey);
      if (!normalized || !pendingKeys.has(normalized)) return;
      consumed.add(normalized);
      if (existing.has(normalized)) return;
      existing.add(normalized);
      board.nodes.push({
        id: id("image"),
        type: "image",
        fileKey,
        path: file.path || "",
        uri: file.uri || "",
        thumbnail: file.thumbnail || "",
        title: file.title || group.title || "Reference",
        sourceUrl: group.sourceUrl || "",
        albumId: snapshot.id,
        x: point.x + offset * 32,
        y: point.y + offset * 32,
        w: 260,
        rotation: 0,
        comment: "",
      });
      offset += 1;
      added += 1;
    });
  });

  if (consumed.size) {
    savePendingImageImports(
      pending.filter((item) => !consumed.has(normalizePlannerFileKey(item.fileKey))),
    );
  }
  if (added) saveBoard();
  return added;
}

async function captureFrameWithSystemSnip() {
  if (frameCaptureBusy) return;
  const invoke = getTauriInvoke();
  if (!invoke) {
    showToast(t("planner-capture-frame-unsupported"));
    return;
  }
  const useFavorites = /Windows/i.test(navigator.userAgent);
  if (!useFavorites) {
    ensurePlannerForActiveAlbum();
    if (board.readOnly) return;
  }
  const button = document.getElementById("plannerCaptureFrameBtn");
  frameCaptureBusy = true;
  if (button) button.disabled = true;
  let stage = "planner-capture-frame-read-failed";
  try {
    await invoke("tauri_set_frame_floater_visible", { visible: false }).catch(() => {});
    const previousSequence = await invoke("tauri_clipboard_image_sequence");
    showToast(t(useFavorites ? "favorites-capture-hint" : "planner-capture-frame-hint"));
    stage = "planner-capture-frame-launch-failed";
    await invoke("tauri_start_screen_snip");
    stage = "planner-capture-frame-read-failed";
    let lastReason = "unchanged";
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await invoke("tauri_save_clipboard_frame", { previousSequence });
      lastReason = result?.reason || "no_image";
      if (result?.saved && result?.path) {
        stage = "planner-capture-frame-failed";
        if (useFavorites) {
          collectFavoriteFrame({ ...result, title: t("planner-captured-frame-title"), savedAt: Date.now() });
          await invoke("tauri_favorites_changed").catch(console.warn);
        } else {
          addCapturedFrameToActiveAlbum(result, { title: t("planner-captured-frame-title"), forcePlanner: true });
        }
        showToast(t(useFavorites ? "favorites-capture-saved" : "planner-capture-frame-saved"));
        return;
      }
    }
    showToast(t(lastReason === "clipboard_busy" ? "planner-capture-frame-busy" : "planner-capture-frame-cancelled"));
  } catch (error) {
    console.warn("System frame capture failed:", error);
    const detail = String(error?.message || error).slice(0, 160);
    showToast(`${t(stage)} ${detail}`);
  } finally {
    frameCaptureBusy = false;
    if (button) button.disabled = false;
    await invoke("tauri_set_frame_floater_visible", { visible: true }).catch(() => {});
  }
}

async function importImageBytes(bytes, options = {}) {
  const point = options.point || plannerPastePoint();
  const prepared = await preparePlannerImageAsset(bytes, {
    mime: options.mime || "",
    filename: options.name || options.title || "",
  });
  const saved = await persistExternalImage(bytes, options);
  const binding = createPlannerAssetLocalBinding(prepared.asset.id, {
    path: saved.path,
    uri: saved.path,
    filename: saved.filename,
  });
  await putPlannerAsset(prepared.asset, binding).catch((error) => {
    console.warn("Could not catalog planner image asset:", error);
  });
  return addExternalImageNode(
    saved.path,
    point,
    options.title || options.name || "External image",
    prepared.asset.id,
  );
}

async function importImageFile(file, point) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return importImageBytes(bytes, {
    point,
    name: file.name || "Dropped_Image",
    mime: file.type || "",
    title: file.name || "Dropped image",
  });
}

function looksLikeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

async function importImageUrl(url, point) {
  const invoke = getTauriInvoke();
  if (!invoke) throw new Error("URL image import is only available in the desktop app");
  const normalized = String(url || "").trim();
  if (!looksLikeHttpUrl(normalized)) throw new Error("Invalid image URL");
  const bytes = new Uint8Array(
    await invoke("tauri_fetch_bytes", {
      url: normalized,
      headers: null,
    }),
  );
  const type = imageTypeFromBytes(bytes, "", normalized);
  if (!type) throw new Error("URL does not point to an image");
  const pathname = (() => {
    try {
      return decodeURIComponent(new URL(normalized).pathname.split("/").pop() || "Web_Image");
    } catch (_) {
      return "Web_Image";
    }
  })();
  return importImageBytes(bytes, {
    point,
    name: pathname,
    mime: type.mime,
    title: pathname || "Web image",
  });
}

function imageUrlFromTransfer(dataTransfer) {
  if (!dataTransfer) return "";
  const uri = String(dataTransfer.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));
  if (looksLikeHttpUrl(uri)) return uri.trim();

  const html = dataTransfer.getData("text/html");
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const src = doc.querySelector("img")?.src;
      if (looksLikeHttpUrl(src)) return src;
    } catch (_) {}
  }

  const text = String(dataTransfer.getData("text/plain") || "").trim();
  return looksLikeHttpUrl(text) ? text : "";
}

function safePackageName(value) {
  return (
    String(value || "Mori_Plan")
      .replace(/[\\/:*?"<>|#%&{}\[\]@$^+=~`';,]/g, " ")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 72) || "Mori_Plan"
  );
}

async function readPlannerNodeBytes(node) {
  const raw = node?.uri || node?.path || "";
  if (!raw) throw new Error("Image node has no local file");
  const invoke = getTauriInvoke();
  if (invoke) {
    const bytes = await invoke("tauri_read_file_bytes", { path: raw });
    return new Uint8Array(bytes || []);
  }
  throw new Error("Planner package export currently requires the desktop app");
}

async function buildPlannerPackage(projectTitle) {
  const liveBoard = board;
  const exportContext = {
    activeProjectId: activePlannerProjectId,
    albumId: activePlannerAlbumId,
    generation: plannerLocalGeneration,
  };
  const snapshot = JSON.parse(JSON.stringify(board));
  snapshot.projectId = String(snapshot.projectId || activePlannerProjectId || id("project"));
  snapshot.projectTitle = String(
    projectTitle || snapshot.projectTitle || t("planner-default-project-title"),
  );
  const writebackBaseByNode = new Map(
    snapshot.nodes.map((node) => [
      node.id,
      { path: node.path, uri: node.uri, assetId: node.assetId, fileKey: node.fileKey },
    ]),
  );
  const imageNodes = snapshot.nodes.filter((node) => node.type === "image");
  const assetByHash = new Map();
  const assetIdByNode = new Map();

  for (let index = 0; index < imageNodes.length; index++) {
    const node = imageNodes[index];
    const originalBytes = await readPlannerNodeBytes(node);
    if (!originalBytes.length) continue;
    const originalType = imageTypeFromBytes(
      originalBytes,
      guessMime(node.path || node.uri || ""),
      node.path || node.uri || node.title || "",
    );
    const prepared = await preparePlannerImageAsset(originalBytes, {
      mime: originalType?.mime || "",
      filename: node.path || node.uri || node.title || "",
    });
    const assetId = prepared.asset.id;
    assetIdByNode.set(node.id, assetId);
    node.assetId = assetId;
    node.fileKey = assetId;
    const binding = createPlannerAssetLocalBinding(assetId, {
      path: node.path || "",
      uri: node.uri || node.path || "",
      thumbnail: node.thumbnail || "",
      filename: (node.path || node.uri || "").split(/[\\/]/).pop() || "",
    });
    await putPlannerAsset(prepared.asset, binding).catch((error) => {
      console.warn("Could not catalog packaged planner asset:", error);
    });
    if (assetByHash.has(assetId)) continue;

    const baseName = safePackageName(node.title || `asset_${index + 1}`);
    assetByHash.set(assetId, {
      ...prepared.asset,
      filename: `${baseName}.${prepared.asset.display.ext}`,
      mime: prepared.asset.display.mime,
      bytes: prepared.displayBytes,
      originalBytes: prepared.asset.source.bytes,
    });
  }

  const assets = [...assetByHash.values()];
  let offset = 0;
  const manifestAssets = assets.map((asset) => {
    const entry = {
      id: asset.id,
      filename: asset.filename,
      mime: asset.mime,
      offset,
      length: asset.bytes.length,
      originalBytes: asset.originalBytes,
      source: { ...asset.source },
      display: { ...asset.display },
    };
    offset += asset.bytes.length;
    return entry;
  });

  const packagedNodes = snapshot.nodes.map((node) => {
    const next = { ...node };
    if (next.type === "image") {
      next.assetId = assetIdByNode.get(next.id) || next.assetId || "";
      next.fileKey = next.assetId || next.fileKey || "";
      delete next.path;
      delete next.uri;
      delete next.thumbnail;
    }
    return next;
  });

  const manifest = {
    format: "mori-planner-package",
    version: MORI_PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    project: {
      id: snapshot.projectId,
      title: snapshot.projectTitle,
    },
    board: {
      nodes: packagedNodes,
      edges: snapshot.edges.map((edge) => ({ ...edge })),
      view: { ...snapshot.view },
      importCount: Number(snapshot.importCount) || 0,
      commentFontSize: normalizeCommentFontSize(snapshot.commentFontSize),
    },
    assets: manifestAssets,
  };

  const encoder = new TextEncoder();
  const magic = encoder.encode(MORI_PACKAGE_MAGIC);
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const totalBytes =
    magic.length + 4 + manifestBytes.length + assets.reduce((sum, asset) => sum + asset.bytes.length, 0);
  const output = new Uint8Array(totalBytes);
  let cursor = 0;
  output.set(magic, cursor);
  cursor += magic.length;
  new DataView(output.buffer).setUint32(cursor, manifestBytes.length, true);
  cursor += 4;
  output.set(manifestBytes, cursor);
  cursor += manifestBytes.length;
  assets.forEach((asset) => {
    output.set(asset.bytes, cursor);
    cursor += asset.bytes.length;
  });

  const exportContextIsCurrent =
    board === liveBoard &&
    String(board?.projectId || "") === snapshot.projectId &&
    activePlannerProjectId === exportContext.activeProjectId &&
    activePlannerAlbumId === exportContext.albumId &&
    plannerLocalGeneration === exportContext.generation;
  if (exportContextIsCurrent) {
    let identityChanged = false;
    const liveNodeById = new Map((board.nodes || []).map((node) => [node.id, node]));
    for (const [nodeId, assetId] of assetIdByNode) {
      const node = liveNodeById.get(nodeId);
      const base = writebackBaseByNode.get(nodeId);
      if (
        !node ||
        !base ||
        node.type !== "image" ||
        node.path !== base.path ||
        node.uri !== base.uri ||
        node.assetId !== base.assetId ||
        node.fileKey !== base.fileKey
      ) {
        continue;
      }
      if (node.assetId !== assetId || node.fileKey !== assetId) {
        node.assetId = assetId;
        node.fileKey = assetId;
        identityChanged = true;
      }
    }
    if (identityChanged) saveBoard();
  }
  return { bytes: output, manifest };
}


function parsePlannerPackage(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const encoder = new TextEncoder();
  const magic = encoder.encode(MORI_PACKAGE_MAGIC);
  if (data.length < magic.length + 4) throw new Error("Invalid Mori package");
  for (let i = 0; i < magic.length; i++) {
    if (data[i] !== magic[i]) throw new Error("Invalid Mori package magic");
  }
  const manifestLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    magic.length,
    true,
  );
  const manifestStart = magic.length + 4;
  const payloadStart = manifestStart + manifestLength;
  if (manifestLength <= 0 || payloadStart > data.length) throw new Error("Invalid Mori manifest");
  const manifest = JSON.parse(
    new TextDecoder().decode(data.subarray(manifestStart, payloadStart)),
  );
  if (manifest?.format !== "mori-planner-package" || manifest?.version !== MORI_PACKAGE_VERSION) {
    throw new Error("Unsupported Mori package version");
  }
  for (const asset of manifest.assets || []) {
    const start = payloadStart + Number(asset.offset || 0);
    const end = start + Number(asset.length || 0);
    if (start < payloadStart || end > data.length || end < start) {
      throw new Error("Corrupted Mori asset table");
    }
  }
  return { manifest, payloadStart, data };
}

async function persistPackageAsset(asset, bytes, projectId) {
  const invoke = getTauriInvoke();
  const filename = safeExternalFilename(asset.filename || "Planner_Asset", asset.filename?.split(".").pop() || "webp");
  if (invoke) {
    const path = await invoke("tauri_save_bytes_file", {
      bytes: Array.from(bytes),
      filename,
      folder: `${PLANNER_SYNC_FOLDER}/${safePackageName(projectId)}`,
    });
    return path;
  }
  if (isAndroidNative() && Filesystem) {
    const result = await Filesystem.writeFile({
      path: `${PLANNER_SYNC_FOLDER}/${safePackageName(projectId)}/${filename}`,
      directory: "DATA",
      data: bytesToBase64(bytes),
      recursive: true,
    });
    return result?.uri || `${PLANNER_SYNC_FOLDER}/${safePackageName(projectId)}/${filename}`;
  }
  throw new Error("No persistent storage provider available");
}

function parentLocalPath(path) {
  const value = String(path || "").replace(/[\\/]+$/, "");
  const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  return index > 0 ? value.slice(0, index) : value;
}

function showPlannerExportResult(path) {
  const value = String(path || "").trim();
  const shell = document.getElementById("plannerExportResult");
  const pathBtn = document.getElementById("plannerExportPath");
  if (!shell || !pathBtn) return;
  if (!value) {
    shell.classList.add("hidden");
    pathBtn.textContent = "";
    pathBtn.dataset.path = "";
    return;
  }
  pathBtn.textContent = value;
  pathBtn.dataset.path = value;
  shell.classList.remove("hidden");
}

async function openPlannerExportPath(path, preferFile = true) {
  const value = String(path || "").trim();
  const invoke = getTauriInvoke();
  if (!value || !invoke) return;
  await invoke("tauri_open_url", { url: preferFile ? value : parentLocalPath(value) });
}

async function copyPlannerExportPath(path) {
  const value = String(path || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(t("planner-export-path-copied"));
  } catch (_) {
    window.prompt(t("planner-export-location"), value);
  }
}

async function exportPlannerPackage() {
  if (!board.nodes.length) {
    showToast(t("planner-empty"));
    return;
  }
  if (!getTauriInvoke()) {
    showToast(t("planner-export-desktop-only"));
    return;
  }

  const suggested = board.projectTitle || t("planner-default-project-title");
  const title = window.prompt(t("planner-project-name-prompt"), suggested)?.trim();
  if (!title) return;
  board.projectTitle = title;
  board.projectId ||= id("project");
  saveBoard();
  syncPlannerProjectUI();

  const button = document.getElementById("plannerExportPackageBtn");
  const previous = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = t("planner-exporting");
  }

  try {
    const pack = await buildPlannerPackage(title);
    const invoke = getTauriInvoke();
    const filename = `${safePackageName(title)}.mori`;
    const path = await invoke("tauri_save_bytes_file", {
      bytes: Array.from(pack.bytes),
      filename,
      folder: "Mori/Sync",
    });
    localStorage.setItem(LAST_EXPORT_PATH_KEY, path);
    showPlannerExportResult(path);
    showToast(t("planner-exported", { path }));
  } catch (err) {
    console.error("Planner package export failed:", err);
    showToast(t("planner-export-failed"));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previous || t("planner-export-phone");
    }
  }
}

async function importPlannerPackageFile(file) {
  if (!file) return;
  const selectedAlbumId = String(getActiveInspirationAlbumSnapshot()?.id || "");
  const importContext = {
    board,
    projectId: String(activePlannerProjectId || board?.projectId || ""),
    albumId: activePlannerAlbumId,
    selectedAlbumId,
    targetAlbumId: activePlannerAlbumId || selectedAlbumId || null,
    generation: plannerLocalGeneration,
  };
  const assertImportContextIsCurrent = () => {
    if (
      board !== importContext.board ||
      String(activePlannerProjectId || board?.projectId || "") !== importContext.projectId ||
      activePlannerAlbumId !== importContext.albumId ||
      String(getActiveInspirationAlbumSnapshot()?.id || "") !== importContext.selectedAlbumId ||
      plannerLocalGeneration !== importContext.generation
    ) {
      throw new Error("Planner changed during package import");
    }
  };
  const button = document.getElementById("plannerImportPackageBtn");
  const previous = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = t("planner-importing-package");
  }

  try {
    const parsed = parsePlannerPackage(new Uint8Array(await file.arrayBuffer()));
    assertImportContextIsCurrent();
    const { manifest, payloadStart, data } = parsed;
    const projectId = String(manifest.project?.id || id("project"));
    const targetBoardKey = plannerBoardStorageKey(projectId);
    const existingTargetRaw = localStorage.getItem(targetBoardKey);
    if (existingTargetRaw !== null) {
      let existingTarget = null;
      try {
        existingTarget = JSON.parse(existingTargetRaw);
      } catch (_) {}
      const targetTitle = String(
        existingTarget?.projectTitle || manifest.project?.title || projectId,
      ).trim();
      const replacePrompt = t("planner-import-replace-confirm");
      const targetDescription = /[\u3400-\u9fff]/u.test(replacePrompt)
        ? `本地策划“${targetTitle}”（${projectId}）`
        : `saved local project “${targetTitle}” (${projectId})`;
      const confirmed = window.confirm(
        replacePrompt.replace(/当前策划|current plan/i, targetDescription),
      );
      if (!confirmed) return;
      assertImportContextIsCurrent();

      const backupKey = [
        "mori_planner_package_import_backup_v1",
        encodeURIComponent(projectId),
        Date.now(),
        id("backup"),
      ].join(":");
      // Keep the exact prior value so it can be restored even if it is not valid JSON.
      // If storage is full, setItem throws and the import stops before replacing anything.
      localStorage.setItem(backupKey, existingTargetRaw);
    }
    const targetAlbumId = importContext.targetAlbumId;
    const paths = new Map();

    for (const asset of manifest.assets || []) {
      const start = payloadStart + Number(asset.offset || 0);
      const end = start + Number(asset.length || 0);
      const assetBytes = data.subarray(start, end);
      const path = await persistPackageAsset(asset, assetBytes, projectId);
      assertImportContextIsCurrent();
      paths.set(asset.id, path);
      try {
        const catalogAsset = await plannerAssetFromPackageEntry(asset, assetBytes);
        const binding = createPlannerAssetLocalBinding(catalogAsset.id, {
          path,
          uri: path,
          filename: asset.filename || "",
        });
        await putPlannerAsset(catalogAsset, binding);
      } catch (error) {
        console.warn("Could not catalog imported planner asset:", error);
      }
      assertImportContextIsCurrent();
    }

    const nodes = (manifest.board?.nodes || []).map((node) => {
      const next = { ...node };
      if (next.type === "image") {
        const path = paths.get(next.assetId);
        next.path = path || "";
        next.uri = path || "";
        next.fileKey = next.assetId || next.fileKey || path || "";
      }
      return next;
    });

    const importedBoard = {
      nodes,
      edges: Array.isArray(manifest.board?.edges) ? manifest.board.edges : [],
      view: {
        zoom: Number(manifest.board?.view?.zoom) || 0.9,
        panX: Number.isFinite(manifest.board?.view?.panX) ? manifest.board.view.panX : 80,
        panY: Number.isFinite(manifest.board?.view?.panY) ? manifest.board.view.panY : 80,
      },
      importCount: Number(manifest.board?.importCount) || 0,
      commentFontSize: normalizeCommentFontSize(manifest.board?.commentFontSize),
      projectId,
      projectTitle: manifest.project?.title || t("planner-default-project-title"),
      readOnly: false,
    };
    assertImportContextIsCurrent();
    activatePlannerBoard(importedBoard, targetAlbumId);
    saveBoard();
    renderPlanner({ full: true });
    switchPlannerMode("planner");
    syncPlannerProjectUI();
    requestAnimationFrame(() => fitAllContent());
    showToast(
      board.readOnly
        ? t("planner-imported-readonly")
        : t("planner-imported-package"),
    );
  } catch (err) {
    console.error("Planner package import failed:", err);
    showToast(t("planner-import-package-failed"));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previous || t("planner-import-package");
    }
  }
}

async function loadPlannerImage(img, node) {
  if (await loadAndroidLocalImage(img, node, node.thumbnail || "")) return;
  const raw = node.uri || node.path || "";
  if (!raw) {
    img.src = node.thumbnail || "";
    return;
  }

  if (window.Capacitor?.convertFileSrc) {
    img.src = window.Capacitor.convertFileSrc(raw);
    return;
  }

  const tauriInvoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (tauriInvoke) {
    try {
      const bytes = await tauriInvoke("tauri_read_file_bytes", { path: raw });
      if (bytes?.length) {
        const blob = new Blob([new Uint8Array(bytes)], { type: guessMime(raw) });
        const objectUrl = URL.createObjectURL(blob);
        const previous = plannerObjectUrlByNode.get(node.id);
        if (previous && previous !== objectUrl) {
          URL.revokeObjectURL(previous);
          plannerObjectUrls.delete(previous);
        }
        plannerObjectUrls.add(objectUrl);
        plannerObjectUrlByNode.set(node.id, objectUrl);
        if (!img.isConnected) {
          URL.revokeObjectURL(objectUrl);
          plannerObjectUrls.delete(objectUrl);
          plannerObjectUrlByNode.delete(node.id);
          return;
        }
        img.src = objectUrl;
        return;
      }
    } catch (err) {
      console.warn("Planner image read failed:", err);
    }
  }

  img.src = node.thumbnail || raw;
}

function syncPlannerEdgeViewport() {
  const { edges, viewport } = plannerElements();
  if (!edges || !viewport) return;
  const zoom = Math.max(MIN_PLANNER_ZOOM, Number(board.view.zoom) || 0.9);
  // The SVG stays as small as the screen; its viewBox follows world coordinates.
  // A 200000px SVG inside the scaled stage risks huge mobile raster surfaces.
  edges.setAttribute("viewBox", `${-board.view.panX / zoom} ${-board.view.panY / zoom} ${Math.max(1, viewport.clientWidth) / zoom} ${Math.max(1, viewport.clientHeight) / zoom}`);
  edges.setAttribute("preserveAspectRatio", "none");
}

function applyPlannerTransform() {
  const { stage, viewport } = plannerElements();
  if (!stage) return;
  const zoom = Math.max(
    MIN_PLANNER_ZOOM,
    Math.min(MAX_PLANNER_ZOOM, Number(board.view.zoom) || 0.9),
  );
  board.view.zoom = zoom;
  const controlScale = Math.min(200, Math.max(1, 1 / zoom));
  const readableScale = Math.min(120, Math.max(1, 1 / zoom));
  stage.style.setProperty("--planner-control-scale", String(controlScale));
  stage.style.setProperty("--planner-readable-scale", String(readableScale));
  stage.style.transform = `translate(${board.view.panX}px, ${board.view.panY}px) scale(${zoom})`;
  const mobileZoomLabel = document.getElementById("plannerMobileZoomLabel");
  if (mobileZoomLabel) mobileZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  if (viewport) {
    let worldGrid = 24;
    while (worldGrid * board.view.zoom < 14) worldGrid *= 2;
    while (worldGrid * board.view.zoom > 52 && worldGrid > 12) worldGrid /= 2;
    const grid = worldGrid * board.view.zoom;
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${board.view.panX}px ${board.view.panY}px`;
  }
  // Zoom only changes the camera. Keep images, connections and selection mounted
  // at every scale instead of replacing small groups with summary cards.
  syncPlannerEdgeViewport();
  requestAnimationFrame(updateImageSelectionToolbarPosition);
}

function viewportPointToWorld(clientX, clientY) {
  const { viewport } = plannerElements();
  if (!viewport) return { x: 0, y: 0 };
  const rect = viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - board.view.panX) / board.view.zoom,
    y: (clientY - rect.top - board.view.panY) / board.view.zoom,
  };
}

function syncPlannerProjectUI() {
  const { page, viewport } = plannerElements();
  const readOnly = board.readOnly === true;
  const title = document.getElementById("plannerProjectTitle");
  const mode = document.getElementById("plannerProjectMode");
  if (title) title.textContent = board.projectTitle || t("planner-default-project-title");
  if (mode) mode.textContent = t(readOnly ? "planner-phone-readonly" : "planner-local-project");
  if (mode && board.localPackage) {
    mode.textContent = readOnly ? t("planner-imported-readonly") : t("planner-package-editable");
  }
  page?.classList.toggle("planner-offline-package", board.localPackage === true);
  page?.classList.toggle("planner-android-limited-write", androidLimitedWriteEnabled && !board.localPackage);
  page?.classList.toggle("planner-readonly", readOnly);
  viewport?.classList.toggle("is-readonly", readOnly);

  [
    "plannerAddTextBtn",
    "plannerAddGroupBtn",
    "plannerClearBtn",
    "plannerTextColor",
    "plannerCardColor",
    "plannerFontSize",
    "inspirationAddAlbumToPlannerBtn",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  const exportBtn = document.getElementById("plannerExportPackageBtn");
  if (exportBtn) exportBtn.disabled = readOnly || !getTauriInvoke();
}

function updateSelectionUI() {
  const { nodes, selectionCount } = plannerElements();
  nodes?.querySelectorAll(".planner-node").forEach((el) => {
    el.classList.toggle("is-selected", selectedNodeIds.has(el.dataset.nodeId));
  });
  document.querySelectorAll(".planner-edge-path").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.edgeId === selectedEdgeId);
  });
  const totalSelected = selectedNodeIds.size + (selectedEdgeId ? 1 : 0);
  if (selectionCount) selectionCount.textContent = String(totalSelected);

  const textColor = document.getElementById("plannerTextColor");
  const cardColor = document.getElementById("plannerCardColor");
  const fontSize = document.getElementById("plannerFontSize");
  const fontSizeValue = document.getElementById("plannerFontSizeValue");
  const selectedModels = board.nodes.filter((node) => selectedNodeIds.has(node.id));
  const textNodes = selectedModels.filter((node) => node.type === "text");

  const readOnly = board.readOnly === true;
  if (textColor) textColor.disabled = readOnly || textNodes.length === 0;
  if (cardColor) cardColor.disabled = readOnly || textNodes.length === 0;
  if (fontSize) fontSize.disabled = readOnly || textNodes.length === 0;
  if (textNodes.length === 1) {
    if (textColor) textColor.value = textNodes[0].textColor || "#171717";
    if (cardColor) cardColor.value = textNodes[0].background || "#fffaf0";
    const size = Math.max(
      MIN_TEXT_FONT_SIZE,
      Math.min(MAX_TEXT_FONT_SIZE, Number(textNodes[0].fontSize) || DEFAULT_TEXT_FONT_SIZE),
    );
    if (fontSize) fontSize.value = String(size);
    if (fontSizeValue) fontSizeValue.textContent = String(size);
  } else if (fontSizeValue) {
    fontSizeValue.textContent = textNodes.length > 1 ? "—" : String(DEFAULT_TEXT_FONT_SIZE);
  }

  syncImageSelectionToolbar();
  syncMultiImageTransformOverlay();
}

function normalizeRotation(value) {
  const raw = Number(value) || 0;
  return ((raw % 360) + 360) % 360;
}

function signedRotation(value) {
  const normalized = normalizeRotation(value);
  return normalized > 180 ? normalized - 360 : normalized;
}

function getSelectedImageNode() {
  if (board.readOnly || selectedEdgeId || selectedNodeIds.size !== 1) return null;
  const nodeId = Array.from(selectedNodeIds)[0];
  const node = board.nodes.find((item) => item.id === nodeId);
  return node?.type === "image" ? node : null;
}

function updateImageSelectionToolbarPosition() {
  const { viewport, selectionToolbar } = plannerElements();
  if (!viewport || !selectionToolbar || selectionToolbar.classList.contains("hidden")) return;
  const selectedEls = Array.from(
    document.querySelectorAll(".planner-node.is-selected"),
  ).filter((el) => selectedNodeIds.has(el.dataset.nodeId));
  if (!selectedEls.length) return;

  const viewportRect = viewport.getBoundingClientRect();
  const rects = selectedEls.map((el) => el.getBoundingClientRect());
  const minLeft = Math.min(...rects.map((rect) => rect.left));
  const maxRight = Math.max(...rects.map((rect) => rect.right));
  const controlRects = isAndroidNative() ? selectedEls.flatMap(el => {
    const handle = el.querySelector(".planner-rotate-handle");
    return handle && getComputedStyle(handle).display !== "none" ? [handle.getBoundingClientRect()] : [];
  }) : [];
  const minTop = Math.min(...[...rects, ...controlRects].map((rect) => rect.top));
  const maxBottom = Math.max(...rects.map((rect) => rect.bottom));
  const toolbarRect = selectionToolbar.getBoundingClientRect();
  const halfWidth = Math.max(80, toolbarRect.width / 2);
  const preferredLeft = (minLeft + maxRight) / 2 - viewportRect.left;
  const left = Math.max(halfWidth + 10, Math.min(viewport.clientWidth - halfWidth - 10, preferredLeft));
  let top = minTop - viewportRect.top - 10;

  const mobileControls = isAndroidNative() ? document.getElementById("plannerMobileControls") : null;
  const safeTop = mobileControls && !mobileControls.classList.contains("hidden")
    ? mobileControls.getBoundingClientRect().bottom - viewportRect.top + 10 : 10;
  if (top < toolbarRect.height + safeTop) {
    top = maxBottom - viewportRect.top + toolbarRect.height + 10;
  }
  selectionToolbar.style.left = `${left}px`;
  selectionToolbar.style.top = `${top}px`;
}

function syncImageSelectionToolbar() {
  const { selectionToolbar } = plannerElements();
  if (!selectionToolbar) return;
  const androidSingleDelete =
    board.readOnly === true &&
    isAndroidNative() &&
    androidLimitedWriteEnabled && !board.localPackage &&
    !selectedEdgeId &&
    selectedNodeIds.size === 1;
  if ((board.readOnly && !androidSingleDelete) || selectedEdgeId || selectedNodeIds.size === 0) {
    selectionToolbar.classList.add("hidden");
    return;
  }

  const selectedModels = board.nodes.filter((node) => selectedNodeIds.has(node.id));
  const singleImage = selectedModels.length === 1 && selectedModels[0]?.type === "image";
  const allImages = selectedModels.length >= 2 && selectedModels.every((node) => node.type === "image");
  const groupBtn = document.getElementById("plannerSelectionGroup");
  groupBtn?.classList.toggle("hidden", androidSingleDelete || !allImages);
  const deleteBtn = document.getElementById("plannerSelectionDelete");
  if (deleteBtn) {
    deleteBtn.textContent = singleImage
      ? t("planner-delete-image")
      : t("planner-delete-selected", { count: selectedModels.length });
  }

  const node = singleImage ? selectedModels[0] : null;
  if (node) {
    const angle = signedRotation(node.rotation);
    const range = document.getElementById("plannerRotationRange");
    const output = document.getElementById("plannerRotationValue");
    if (range) range.value = String(angle);
    if (output) output.textContent = `${Math.round(angle)}°`;
  }
  selectionToolbar.classList.remove("hidden");
  requestAnimationFrame(updateImageSelectionToolbarPosition);
}

function setSelectedImageRotation(value, { persist = false } = {}) {
  const node = getSelectedImageNode();
  if (!node) return;
  const angle = Math.max(-180, Math.min(180, Number(value) || 0));
  node.rotation = angle;
  const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
  if (el) el.style.transform = `rotate(${angle}deg)`;
  const output = document.getElementById("plannerRotationValue");
  if (output) output.textContent = `${Math.round(angle)}°`;
  renderEdges();
  requestAnimationFrame(updateImageSelectionToolbarPosition);
  if (persist) saveBoard();
}

function getNodeBox(nodeId) {
  const model = board.nodes.find((node) => node.id === nodeId);
  const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!model || !el) return null;
  return {
    model,
    el,
    x: model.x,
    y: model.y,
    w: el.offsetWidth,
    h: el.offsetHeight,
    rotation: normalizeRotation(model.rotation),
  };
}

function rotateVector(x, y, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function getSelectedImageTransformBoxes() {
  if (board.readOnly || selectedEdgeId) return [];
  const selectedModels = board.nodes.filter((node) => selectedNodeIds.has(node.id));
  if (selectedModels.length < 2 || selectedModels.some((node) => node.type !== "image")) {
    return [];
  }
  const boxes = selectedModels.map((node) => getNodeBox(node.id)).filter(Boolean);
  return boxes.length === selectedModels.length ? boxes : [];
}

function getRotatedBoxCorners(box) {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  return [
    [-box.w / 2, -box.h / 2],
    [box.w / 2, -box.h / 2],
    [box.w / 2, box.h / 2],
    [-box.w / 2, box.h / 2],
  ].map(([x, y]) => {
    const point = rotateVector(x, y, box.rotation);
    return { x: center.x + point.x, y: center.y + point.y };
  });
}

function getMultiImageTransformBounds(boxes = getSelectedImageTransformBoxes()) {
  if (!boxes.length) return null;
  const points = boxes.flatMap(getRotatedBoxCorners);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

function applyImageNodeTransformVisual(model, el) {
  if (!model || !el) return;
  el.style.left = `${model.x}px`;
  el.style.top = `${model.y}px`;
  el.style.width = `${model.w}px`;
  el.style.transform = `rotate(${normalizeRotation(model.rotation)}deg)`;
  const counterRotation = `${-normalizeRotation(model.rotation)}deg`;
  el.querySelector(".planner-rotate-handle")?.style.setProperty("--counter-rotation", counterRotation);
  const commentShell = el.querySelector(".planner-image-comment-shell");
  commentShell?.style.setProperty("--counter-rotation", counterRotation);
  commentShell?.style.setProperty("--comment-scale", String(normalizeImageCommentScale(model.commentScale)));
}

function applyGroupNodeTransformVisual(model, el) {
  if (!model || !el) return;
  el.style.left = `${model.x}px`;
  el.style.top = `${model.y}px`;
  el.style.width = `${model.w}px`;
  el.style.height = `${model.h}px`;
  el.style.transform = `rotate(${normalizeRotation(model.rotation)}deg)`;
  const label = el.querySelector(".planner-group-label");
  label?.style.setProperty("--group-label-scale", String(normalizeGroupLabelScale(model.groupLabelScale)));
  label?.style.setProperty("--group-counter-rotation", `${-normalizeRotation(model.rotation)}deg`);
}

function syncMultiImageTransformOverlay() {
  const { stage, multiTransform } = plannerElements();
  if (!stage || !multiTransform) return;
  const boxes = getSelectedImageTransformBoxes();
  const bounds = getMultiImageTransformBounds(boxes);
  const active = Boolean(bounds);
  stage.classList.toggle("has-multi-image-selection", active);
  multiTransform.classList.toggle("hidden", !active);
  multiTransform.setAttribute("aria-hidden", active ? "false" : "true");
  if (!bounds) return;
  multiTransform.style.left = `${bounds.x}px`;
  multiTransform.style.top = `${bounds.y}px`;
  multiTransform.style.width = `${bounds.w}px`;
  multiTransform.style.height = `${bounds.h}px`;
}

function getMultiImageTransformStartState() {
  const boxes = getSelectedImageTransformBoxes();
  const bounds = getMultiImageTransformBounds(boxes);
  if (!bounds) return null;
  const selectedIds = new Set(boxes.map((box) => box.model.id));
  const linkedGroups = board.nodes
    .filter(
      (node) =>
        node.type === "group" &&
        Array.isArray(node.memberIds) &&
        node.memberIds.length > 0 &&
        node.memberIds.every((memberId) => selectedIds.has(memberId)),
    )
    .map((node) => getNodeBox(node.id))
    .filter(Boolean)
    .map((box) => ({
      model: box.model,
      el: box.el,
      w: box.w,
      h: box.h,
      rotation: normalizeRotation(box.rotation),
      groupLabelScale: normalizeGroupLabelScale(box.model.groupLabelScale),
      centerX: box.x + box.w / 2,
      centerY: box.y + box.h / 2,
    }));
  return {
    bounds,
    linkedGroups,
    items: boxes.map((box) => ({
      model: box.model,
      el: box.el,
      w: box.w,
      h: box.h,
      rotation: normalizeRotation(box.rotation),
      commentScale: normalizeImageCommentScale(box.model.commentScale),
      centerX: box.x + box.w / 2,
      centerY: box.y + box.h / 2,
    })),
  };
}

function bindMultiImageResizeHandle(handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (board.readOnly || event.button !== 0) return;
    const state = getMultiImageTransformStartState();
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();

    const corner = handle.dataset.corner || "se";
    const sx = corner.includes("w") ? -1 : 1;
    const sy = corner.includes("n") ? -1 : 1;
    const { bounds, items, linkedGroups } = state;
    const anchor = {
      x: sx > 0 ? bounds.x : bounds.x + bounds.w,
      y: sy > 0 ? bounds.y : bounds.y + bounds.h,
    };
    let minScale = Math.max(...items.map((item) => MIN_NODE_WIDTH / Math.max(1, item.w)));
    let maxScale = Math.min(...items.map((item) => MAX_IMAGE_WIDTH / Math.max(1, item.w)));
    linkedGroups.forEach((group) => {
      minScale = Math.max(
        minScale,
        MIN_NODE_WIDTH / Math.max(1, group.w),
        120 / Math.max(1, group.h),
      );
      maxScale = Math.min(
        maxScale,
        MAX_GROUP_WIDTH / Math.max(1, group.w),
        MAX_GROUP_HEIGHT / Math.max(1, group.h),
      );
    });
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const point = viewportPointToWorld(moveEvent.clientX, moveEvent.clientY);
      const scaleX = (point.x - anchor.x) / (sx * bounds.w);
      const scaleY = (point.y - anchor.y) / (sy * bounds.h);
      const candidates = [scaleX, scaleY].filter(
        (value) => Number.isFinite(value) && value > 0.04,
      );
      let scale = candidates.length ? Math.max(...candidates) : minScale;
      scale = Math.max(minScale, Math.min(maxScale, scale));

      items.forEach((item) => {
        const centerX = anchor.x + (item.centerX - anchor.x) * scale;
        const centerY = anchor.y + (item.centerY - anchor.y) * scale;
        const nextWidth = item.w * scale;
        const nextHeight = item.h * scale;
        item.model.w = nextWidth;
        item.model.x = centerX - nextWidth / 2;
        item.model.y = centerY - nextHeight / 2;
        item.model.commentScale = normalizeImageCommentScale(item.commentScale * scale);
        item.model.userSized = true;
        applyImageNodeTransformVisual(item.model, item.el);
      });
      linkedGroups.forEach((group) => {
        const centerX = anchor.x + (group.centerX - anchor.x) * scale;
        const centerY = anchor.y + (group.centerY - anchor.y) * scale;
        group.model.w = group.w * scale;
        group.model.h = group.h * scale;
        group.model.x = centerX - group.model.w / 2;
        group.model.y = centerY - group.model.h / 2;
        group.model.groupLabelScale = normalizeGroupLabelScale(group.groupLabelScale * scale);
        applyGroupNodeTransformVisual(group.model, group.el);
      });
      renderEdges();
      syncMultiImageTransformOverlay();
      updateImageSelectionToolbarPosition();
    };

    const onEnd = (endEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch (_) {}
      saveBoard();
      renderEdges();
      syncMultiImageTransformOverlay();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });
}

function bindMultiImageRotateHandle(handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (board.readOnly || event.button !== 0) return;
    const state = getMultiImageTransformStartState();
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();

    const { bounds, items, linkedGroups } = state;
    const center = { x: bounds.centerX, y: bounds.centerY };
    const startPoint = viewportPointToWorld(event.clientX, event.clientY);
    const startAngle = Math.atan2(startPoint.y - center.y, startPoint.x - center.x) * 180 / Math.PI;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const point = viewportPointToWorld(moveEvent.clientX, moveEvent.clientY);
      const angle = Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
      let delta = angle - startAngle;
      if (moveEvent.shiftKey) delta = Math.round(delta / 15) * 15;

      items.forEach((item) => {
        const offset = rotateVector(item.centerX - center.x, item.centerY - center.y, delta);
        const nextCenterX = center.x + offset.x;
        const nextCenterY = center.y + offset.y;
        item.model.x = nextCenterX - item.w / 2;
        item.model.y = nextCenterY - item.h / 2;
        item.model.rotation = normalizeRotation(item.rotation + delta);
        applyImageNodeTransformVisual(item.model, item.el);
      });
      linkedGroups.forEach((group) => {
        const offset = rotateVector(group.centerX - center.x, group.centerY - center.y, delta);
        const nextCenterX = center.x + offset.x;
        const nextCenterY = center.y + offset.y;
        group.model.x = nextCenterX - group.w / 2;
        group.model.y = nextCenterY - group.h / 2;
        group.model.rotation = normalizeRotation(group.rotation + delta);
        applyGroupNodeTransformVisual(group.model, group.el);
      });
      renderEdges();
      syncMultiImageTransformOverlay();
      updateImageSelectionToolbarPosition();
    };

    const onEnd = (endEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch (_) {}
      saveBoard();
      renderEdges();
      syncMultiImageTransformOverlay();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });
}

function bindMultiImageTransformControls() {
  const { multiTransform } = plannerElements();
  if (!multiTransform || multiTransform.dataset.bound === "true") return;
  multiTransform.dataset.bound = "true";
  multiTransform.querySelectorAll(".planner-multi-resize-handle").forEach((handle) => {
    bindMultiImageResizeHandle(handle);
  });
  const rotate = multiTransform.querySelector(".planner-multi-rotate-handle");
  if (rotate) bindMultiImageRotateHandle(rotate);
}

function sideVector(side, rotation = 0) {
  const base =
    side === "top"
      ? { x: 0, y: -1 }
      : side === "bottom"
        ? { x: 0, y: 1 }
        : side === "left"
          ? { x: -1, y: 0 }
          : { x: 1, y: 0 };
  return rotateVector(base.x, base.y, rotation);
}

function getNodeAnchor(nodeId, side = "right") {
  const box = getNodeBox(nodeId);
  if (!box) return null;
  const local =
    side === "top"
      ? { x: 0, y: -box.h / 2 }
      : side === "bottom"
        ? { x: 0, y: box.h / 2 }
        : side === "left"
          ? { x: -box.w / 2, y: 0 }
          : { x: box.w / 2, y: 0 };
  const offset = rotateVector(local.x, local.y, box.rotation);
  return {
    x: box.x + box.w / 2 + offset.x,
    y: box.y + box.h / 2 + offset.y,
    vector: sideVector(side, box.rotation),
  };
}

function nearestSide(nodeId, worldPoint) {
  const box = getNodeBox(nodeId);
  if (!box) return "left";
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const delta = rotateVector(
    worldPoint.x - center.x,
    worldPoint.y - center.y,
    -box.rotation,
  );
  const distances = [
    ["left", Math.abs(delta.x + box.w / 2)],
    ["right", Math.abs(delta.x - box.w / 2)],
    ["top", Math.abs(delta.y + box.h / 2)],
    ["bottom", Math.abs(delta.y - box.h / 2)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function inferEdgeSides(edge) {
  if (edge.fromSide && edge.toSide) return;
  const fromBox = getNodeBox(edge.from);
  const toBox = getNodeBox(edge.to);
  if (!fromBox || !toBox) return;
  const fromCenter = {
    x: fromBox.x + fromBox.w / 2,
    y: fromBox.y + fromBox.h / 2,
  };
  const toCenter = {
    x: toBox.x + toBox.w / 2,
    y: toBox.y + toBox.h / 2,
  };
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y);
  if (horizontal) {
    edge.fromSide = toCenter.x >= fromCenter.x ? "right" : "left";
    edge.toSide = toCenter.x >= fromCenter.x ? "left" : "right";
  } else {
    edge.fromSide = toCenter.y >= fromCenter.y ? "bottom" : "top";
    edge.toSide = toCenter.y >= fromCenter.y ? "top" : "bottom";
  }
}

function buildEdgePath(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const control = Math.max(60, Math.min(260, distance * 0.38));
  return `M ${from.x} ${from.y} C ${from.x + from.vector.x * control} ${from.y + from.vector.y * control}, ${to.x + to.vector.x * control} ${to.y + to.vector.y * control}, ${to.x} ${to.y}`;
}

function renderEdges() {
  const { edges } = plannerElements();
  if (!edges) return;
  syncPlannerEdgeViewport();
  edges.innerHTML = "";

  board.edges.forEach((edge) => {
    inferEdgeSides(edge);
    const from = getNodeAnchor(edge.from, edge.fromSide || "right");
    const to = getNodeAnchor(edge.to, edge.toSide || "left");
    if (!from || !to) return;
    const d = buildEdgePath(from, to);

    const visible = document.createElementNS("http://www.w3.org/2000/svg", "path");
    visible.setAttribute("d", d);
    visible.setAttribute(
      "class",
      `planner-edge-path ${selectedEdgeId === edge.id ? "is-selected" : ""}`.trim(),
    );
    visible.dataset.edgeId = edge.id;

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "planner-edge-hit");
    hit.dataset.edgeId = edge.id;
    hit.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectedNodeIds.clear();
      selectedEdgeId = edge.id;
      updateSelectionUI();
    });

    edges.append(visible, hit);
  });

  if (connectingEdge) {
    const from = getNodeAnchor(connectingEdge.from, connectingEdge.fromSide);
    if (from) {
      const to = {
        x: connectingEdge.x,
        y: connectingEdge.y,
        vector: { x: 0, y: 0 },
      };
      const preview = document.createElementNS("http://www.w3.org/2000/svg", "path");
      preview.setAttribute("d", buildEdgePath(from, to));
      preview.setAttribute("class", "planner-edge-path is-preview");
      edges.appendChild(preview);
    }
  }
}

function autoSizedTextWidth(node) {
  const text = String(node.text || "");
  const lines = text.split(/\n/);
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const contentLength = text.replace(/\s+/g, " ").trim().length;
  const fontSize = Math.max(
    MIN_TEXT_FONT_SIZE,
    Math.min(MAX_TEXT_FONT_SIZE, Number(node.fontSize) || DEFAULT_TEXT_FONT_SIZE),
  );
  const estimatedCharWidth = fontSize * 0.54;
  const target = Math.max(
    145,
    Math.min(
      900,
      Math.max(
        longest * estimatedCharWidth + 34,
        contentLength > 120 ? Math.min(900, fontSize * 24) : 0,
      ),
    ),
  );
  return Math.round(target);
}

function fitTextNode(nodeEl, node) {
  if (!nodeEl || node.userSized) return;
  node.w = autoSizedTextWidth(node);
  nodeEl.style.width = `${node.w}px`;
}

function canEditPlannerText() {
  return board.readOnly !== true || (isAndroidNative() && androidLimitedWriteEnabled && !board.localPackage);
}

function startEditingText(nodeEl, node) {
  if (!canEditPlannerText()) return;
  const content = nodeEl.querySelector(".planner-text-content");
  if (!content) return;
  nodeEl.classList.add("is-editing");
  content.contentEditable = "true";
  content.focus();

  const range = document.createRange();
  range.selectNodeContents(content);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  const onKeyDown = (event) => {
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      content.blur();
    }
  };
  const finish = () => {
    node.text = content.textContent?.trim() || t("planner-text-placeholder");
    content.textContent = node.text;
    content.contentEditable = "false";
    nodeEl.classList.remove("is-editing");
    fitTextNode(nodeEl, node);
    saveBoard(isAndroidNative() ? { captureSync: false } : {});
    renderEdges();
    content.removeEventListener("blur", finish);
    content.removeEventListener("keydown", onKeyDown);
  };
  content.addEventListener("blur", finish);
  content.addEventListener("keydown", onKeyDown);
}

function startEditingGroupLabel(nodeEl, node) {
  if (board.readOnly) return;
  const content = nodeEl.querySelector(".planner-group-label");
  if (!content) return;
  nodeEl.classList.add("is-editing");
  content.contentEditable = "true";
  content.focus();

  const range = document.createRange();
  range.selectNodeContents(content);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  const finish = () => {
    node.text = content.textContent?.trim() || t("planner-group-placeholder");
    content.textContent = node.text;
    content.contentEditable = "false";
    nodeEl.classList.remove("is-editing");
    saveBoard();
    content.removeEventListener("blur", finish);
    content.removeEventListener("keydown", onKeyDown);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      content.blur();
    }
  };
  content.addEventListener("blur", finish);
  content.addEventListener("keydown", onKeyDown);
}

function bindConnectorHandle(handle, node, side) {
  handle.addEventListener("pointerdown", (event) => {
    if (board.readOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectedEdgeId = null;
    selectedNodeIds = new Set([node.id]);
    updateSelectionUI();

    const start = viewportPointToWorld(event.clientX, event.clientY);
    connectingEdge = {
      from: node.id,
      fromSide: side,
      x: start.x,
      y: start.y,
    };
    renderEdges();
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const point = viewportPointToWorld(moveEvent.clientX, moveEvent.clientY);
      connectingEdge.x = point.x;
      connectingEdge.y = point.y;
      renderEdges();
    };

    const onEnd = (endEvent) => {
      const point = viewportPointToWorld(endEvent.clientX, endEvent.clientY);
      const hit = document.elementFromPoint(endEvent.clientX, endEvent.clientY);
      const targetNode = hit?.closest?.(".planner-node");
      const targetId = targetNode?.dataset.nodeId;
      if (targetId && targetId !== node.id) {
        const hitHandle = hit.closest?.(".planner-connector-handle");
        const toSide =
          hitHandle?.dataset.side && hitHandle.closest(".planner-node") === targetNode
            ? hitHandle.dataset.side
            : nearestSide(targetId, point);
        const duplicate = board.edges.some(
          (edge) => edge.from === node.id && edge.to === targetId && edge.fromSide === side && edge.toSide === toSide,
        );
        if (!duplicate) {
          board.edges.push({
            id: id("edge"),
            from: node.id,
            to: targetId,
            fromSide: side,
            toSide,
          });
          saveBoard();
        }
      }
      connectingEdge = null;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch (_) {}
      renderEdges();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });
}

function bindResizeHandle(handle, nodeEl, node, corner = "se") {
  handle.addEventListener("pointerdown", (event) => {
    const androidLimitedResize =
      board.readOnly &&
      isAndroidNative() &&
      androidLimitedWriteEnabled && !board.localPackage &&
      (node.type === "text" || node.type === "image");
    if ((board.readOnly && !androidLimitedResize) || event.button !== 0) return;
    const androidTouch = androidLimitedResize && event.pointerType === "touch";
    if (androidTouch && event.isPrimary === false) return;
    const original = androidTouch ? structuredClone(node) : null;
    event.preventDefault();
    event.stopPropagation();
    selectedEdgeId = null;
    selectedNodeIds = new Set([node.id]);
    updateSelectionUI();

    const startWidth = nodeEl.offsetWidth;
    const startHeight = nodeEl.offsetHeight;
    const startX = node.x;
    const startY = node.y;
    const startCommentScale = normalizeImageCommentScale(node.commentScale);
    const startGroupLabelScale = normalizeGroupLabelScale(node.groupLabelScale);
    const groupMemberStarts =
      node.type === "group" && Array.isArray(node.memberIds) && node.memberIds.length
        ? node.memberIds
            .map((memberId) => getNodeBox(memberId))
            .filter(Boolean)
            .map((box) => ({
              model: box.model,
              el: box.el,
              w: box.w,
              h: box.h,
              centerX: box.x + box.w / 2,
              centerY: box.y + box.h / 2,
              commentScale: normalizeImageCommentScale(box.model.commentScale),
              fontSize: Number(box.model.fontSize) || DEFAULT_TEXT_FONT_SIZE,
            }))
        : [];
    const rotation = normalizeRotation(node.rotation);
    const sx = corner.includes("w") ? -1 : 1;
    const sy = corner.includes("n") ? -1 : 1;
    const center = { x: startX + startWidth / 2, y: startY + startHeight / 2 };
    const anchorOffset = rotateVector((-sx * startWidth) / 2, (-sy * startHeight) / 2, rotation);
    const anchor = { x: center.x + anchorOffset.x, y: center.y + anchorOffset.y };
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const point = viewportPointToWorld(moveEvent.clientX, moveEvent.clientY);
      const local = rotateVector(point.x - anchor.x, point.y - anchor.y, -rotation);
      const scaleX = local.x / (sx * startWidth);
      const scaleY = local.y / (sy * startHeight);
      const positive = [scaleX, scaleY].filter((value) => Number.isFinite(value) && value > 0.05);
      let scale = positive.length ? Math.max(...positive) : 0.05;
      const maxWidth =
        node.type === "image"
          ? MAX_IMAGE_WIDTH
          : node.type === "group"
            ? MAX_GROUP_WIDTH
            : MAX_TEXT_WIDTH;
      let minScale = MIN_NODE_WIDTH / startWidth;
      let maxScale = maxWidth / startWidth;
      if (node.type === "group") {
        minScale = Math.max(minScale, 120 / Math.max(1, startHeight));
        maxScale = Math.min(maxScale, MAX_GROUP_HEIGHT / Math.max(1, startHeight));
        if (groupMemberStarts.length) {
          groupMemberStarts.forEach((item) => {
            if (item.model.type === "image") {
              minScale = Math.max(minScale, MIN_NODE_WIDTH / Math.max(1, item.w));
              maxScale = Math.min(maxScale, MAX_IMAGE_WIDTH / Math.max(1, item.w));
            }
          });
        }
      }
      scale = Math.max(minScale, Math.min(maxScale, scale));

      const nextWidth = startWidth * scale;
      const nextHeight = node.type === "group"
        ? Math.max(120, Math.min(MAX_GROUP_HEIGHT, startHeight * scale))
        : startHeight * scale;
      const centerOffset = rotateVector((sx * nextWidth) / 2, (sy * nextHeight) / 2, rotation);
      const nextCenter = { x: anchor.x + centerOffset.x, y: anchor.y + centerOffset.y };

      node.w = nextWidth;
      node.x = nextCenter.x - nextWidth / 2;
      node.y = nextCenter.y - nextHeight / 2;
      if (node.type === "group") {
        node.h = nextHeight;
        node.groupLabelScale = normalizeGroupLabelScale(startGroupLabelScale * scale);
      }
      if (node.type === "image") {
        node.commentScale = normalizeImageCommentScale(startCommentScale * scale);
      }
      node.userSized = true;
      nodeEl.style.width = `${node.w}px`;
      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
      if (node.type === "group") {
        nodeEl.style.height = `${node.h}px`;
        nodeEl.querySelector(".planner-group-label")?.style.setProperty(
          "--group-label-scale",
          String(node.groupLabelScale),
        );
      }
      if (node.type === "image") {
        nodeEl.querySelector(".planner-image-comment-shell")?.style.setProperty(
          "--comment-scale",
          String(node.commentScale),
        );
      }
      if (node.type === "group" && groupMemberStarts.length) {
        groupMemberStarts.forEach((item) => {
          const memberCenterX = anchor.x + (item.centerX - anchor.x) * scale;
          const memberCenterY = anchor.y + (item.centerY - anchor.y) * scale;
          const memberWidth = item.w * scale;
          const memberHeight = item.h * scale;
          item.model.w = memberWidth;
          item.model.x = memberCenterX - memberWidth / 2;
          item.model.y = memberCenterY - memberHeight / 2;
          item.model.userSized = true;
          if (item.model.type === "image") {
            item.model.commentScale = normalizeImageCommentScale(item.commentScale * scale);
            applyImageNodeTransformVisual(item.model, item.el);
          } else {
            item.el.style.left = `${item.model.x}px`;
            item.el.style.top = `${item.model.y}px`;
            item.el.style.width = `${item.model.w}px`;
            if (item.model.type === "text") {
              item.model.fontSize = Math.max(
                MIN_TEXT_FONT_SIZE,
                Math.min(MAX_TEXT_FONT_SIZE, item.fontSize * scale),
              );
              item.el.querySelector(".planner-text-content")?.style.setProperty(
                "font-size",
                `${item.model.fontSize}px`,
              );
            }
          }
        });
      }
      renderEdges();
      updateImageSelectionToolbarPosition();
    };
    const onEnd = (endEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch (_) {}
      if (androidTouch) androidTouchManipulation = null;
      if (androidTouch && (endEvent.type === "pointercancel" || androidTouchWasMultitouch)) {
        restoreAndroidTouchNode(node, original, nodeEl);
        return;
      }
      saveBoard(androidLimitedResize ? { captureSync: false } : {});
      renderEdges();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    if (androidTouch) androidTouchManipulation = { movesNode: true, cancel: () => onEnd({ type: "pointercancel", pointerId: event.pointerId }) };
  });
}

function bindRotateHandle(handle, nodeEl, node) {
  handle.addEventListener("pointerdown", (event) => {
    const androidLimitedRotate =
      board.readOnly && isAndroidNative() && androidLimitedWriteEnabled && !board.localPackage && node.type === "image";
    if ((board.readOnly && !androidLimitedRotate) || event.button !== 0) return;
    const androidTouch = androidLimitedRotate && event.pointerType === "touch";
    if (androidTouch && event.isPrimary === false) return;
    const original = androidTouch ? structuredClone(node) : null;
    event.preventDefault();
    event.stopPropagation();
    selectedNodeIds = new Set([node.id]);
    selectedEdgeId = null;
    updateSelectionUI();

    const rect = nodeEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const startPointerAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
    const startRotation = signedRotation(node.rotation);
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX) * 180 / Math.PI;
      node.rotation = normalizeRotation(startRotation + angle - startPointerAngle);
      nodeEl.style.transform = `rotate(${node.rotation}deg)`;
      handle.style.setProperty("--counter-rotation", `${-node.rotation}deg`);
      const commentShell = nodeEl.querySelector(".planner-image-comment-shell");
      if (commentShell) commentShell.style.setProperty("--counter-rotation", `${-node.rotation}deg`);
      renderEdges();
      updateImageSelectionToolbarPosition();
    };
    const onEnd = (endEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try {
        handle.releasePointerCapture(endEvent.pointerId);
      } catch (_) {}
      if (androidTouch) androidTouchManipulation = null;
      if (androidTouch && (endEvent.type === "pointercancel" || androidTouchWasMultitouch)) {
        restoreAndroidTouchNode(node, original, nodeEl);
        return;
      }
      saveBoard(androidLimitedRotate ? { captureSync: false } : {});
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    if (androidTouch) androidTouchManipulation = { movesNode: true, cancel: () => onEnd({ type: "pointercancel", pointerId: event.pointerId }) };
  });

  handle.addEventListener("dblclick", (event) => {
    const androidLimitedRotate =
      board.readOnly && isAndroidNative() && androidLimitedWriteEnabled && !board.localPackage && node.type === "image";
    if (board.readOnly && !androidLimitedRotate) return;
    event.preventDefault();
    event.stopPropagation();
    node.rotation = 0;
    nodeEl.style.transform = "rotate(0deg)";
    handle.style.setProperty("--counter-rotation", "0deg");
    const commentShell = nodeEl.querySelector(".planner-image-comment-shell");
    if (commentShell) commentShell.style.setProperty("--counter-rotation", "0deg");
    saveBoard(androidLimitedRotate ? { captureSync: false } : {});
    renderEdges();
    updateImageSelectionToolbarPosition();
  });
}

function bindCommentSizeControl(control) {
  control.addEventListener("pointerdown", (event) => event.stopPropagation());
  control.addEventListener("click", (event) => event.stopPropagation());
  control.querySelector("[data-comment-size='down']")?.addEventListener("click", () =>
    adjustPlannerCommentFontSize(-1),
  );
  control.querySelector("[data-comment-size='up']")?.addEventListener("click", () =>
    adjustPlannerCommentFontSize(1),
  );
}

function bindImageComment(commentEl, node) {
  commentEl.addEventListener("pointerdown", (event) => event.stopPropagation());
  commentEl.addEventListener("click", (event) => event.stopPropagation());
  commentEl.addEventListener("focus", () => {
    if (commentEl.dataset.empty === "true") commentEl.textContent = "";
    commentEl.classList.add("is-editing");
  });
  const save = () => {
    const value = commentEl.textContent?.trim() || "";
    node.comment = value;
    commentEl.dataset.empty = value ? "false" : "true";
    const shell = commentEl.closest(".planner-image-comment-shell");
    if (shell) shell.dataset.empty = value ? "false" : "true";
    commentEl.textContent = value || t("planner-image-comment-placeholder");
    commentEl.classList.remove("is-editing");
    saveBoard();
  };
  commentEl.addEventListener("blur", save);
  commentEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      commentEl.blur();
    }
    event.stopPropagation();
  });
}

function restoreAndroidTouchNode(node, original, nodeEl) {
  Object.keys(node).forEach(key => delete node[key]);
  Object.assign(node, original);
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
  nodeEl.style.width = `${node.w}px`;
  nodeEl.style.transform = `rotate(${normalizeRotation(node.rotation)}deg)`;
  nodeEl.querySelector(".planner-rotate-handle")?.style.setProperty("--counter-rotation", `${-normalizeRotation(node.rotation)}deg`);
  const comment = nodeEl.querySelector(".planner-image-comment-shell");
  comment?.style.setProperty("--counter-rotation", `${-normalizeRotation(node.rotation)}deg`);
  comment?.style.setProperty("--comment-scale", String(normalizeImageCommentScale(node.commentScale)));
  renderEdges();
  updateImageSelectionToolbarPosition();
}

function bindNodeDrag(nodeEl, node) {
  let skipNextTextClick = false;
  nodeEl.addEventListener("pointerdown", (event) => {
    const androidLimitedMove =
      board.readOnly &&
      isAndroidNative() &&
      androidLimitedWriteEnabled && !board.localPackage &&
      (node.type === "text" || node.type === "image" || node.type === "group");
    if (board.readOnly && !androidLimitedMove) return;
    if (event.button !== 0 || nodeEl.classList.contains("is-editing")) return;
    const androidTouch = androidLimitedMove && event.pointerType === "touch";
    if (androidTouch && event.isPrimary === false) return;
    const wasSelected = selectedNodeIds.has(node.id);
    event.stopPropagation();

    selectedEdgeId = null;
    if (androidTouch) {
      // Select only after a completed single-finger tap. A first finger landing
      // on an image must not turn the following pinch into a node drag.
    } else if (androidLimitedMove) {
      selectedNodeIds = new Set([node.id]);
    } else if (event.shiftKey) {
      if (selectedNodeIds.has(node.id)) selectedNodeIds.delete(node.id);
      else selectedNodeIds.add(node.id);
    } else if (!selectedNodeIds.has(node.id)) {
      selectedNodeIds = new Set([node.id]);
    }
    updateSelectionUI();

    const selectedModels = androidLimitedMove
      ? [node]
      : board.nodes.filter((item) => selectedNodeIds.has(item.id));
    let dragModels = selectedModels;
    if (node.type === "group") {
      const explicitMembers = Array.isArray(node.memberIds) && node.memberIds.length
        ? board.nodes.filter((item) => node.memberIds.includes(item.id))
        : [];
      const groupRight = node.x + nodeEl.offsetWidth;
      const groupBottom = node.y + nodeEl.offsetHeight;
      const contained = explicitMembers.length
        ? explicitMembers
        : board.nodes.filter((item) => {
            if (item.id === node.id || item.type === "group") return false;
            const box = getNodeBox(item.id);
            if (!box) return false;
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            return cx >= node.x && cx <= groupRight && cy >= node.y && cy <= groupBottom;
          });
      dragModels = [
        ...new Map([...selectedModels, ...contained].map((item) => [item.id, item])).values(),
      ];
    }
    const starts = new Map(dragModels.map((item) => [item.id, { x: item.x, y: item.y }]));
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    if (!androidTouch || wasSelected) nodeEl.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      if (isAndroidNative() && androidTouchWasMultitouch) return;
      const dx = (moveEvent.clientX - startX) / board.view.zoom;
      const dy = (moveEvent.clientY - startY) / board.view.zoom;
      if (androidTouch) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 8) moved = true;
        if (!moved || !wasSelected || androidTouchWasMultitouch) return;
      } else if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      dragModels.forEach((item) => {
        const start = starts.get(item.id);
        item.x = start.x + dx;
        item.y = start.y + dy;
        const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(item.id)}"]`);
        if (el) {
          el.style.left = `${item.x}px`;
          el.style.top = `${item.y}px`;
        }
      });
      renderEdges();
      syncMultiImageTransformOverlay();
      updateImageSelectionToolbarPosition();
    };

    const onEnd = (endEvent) => {
      nodeEl.removeEventListener("pointermove", onMove);
      nodeEl.removeEventListener("pointerup", onEnd);
      nodeEl.removeEventListener("pointercancel", onEnd);
      if (isAndroidNative() && androidTouchWasMultitouch) {
        dragModels.forEach(item => {
          const start = starts.get(item.id);
          item.x = start.x;
          item.y = start.y;
          const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(item.id)}"]`);
          if (el) {
            el.style.left = `${item.x}px`;
            el.style.top = `${item.y}px`;
          }
        });
        renderEdges();
        updateImageSelectionToolbarPosition();
        skipNextTextClick = true;
        return;
      }
      if (androidTouch) {
        androidTouchManipulation = null;
        try { nodeEl.releasePointerCapture(event.pointerId); } catch (_) {}
        if (androidTouchWasMultitouch || endEvent?.type === "pointercancel") {
          dragModels.forEach(item => {
            const start = starts.get(item.id); item.x = start.x; item.y = start.y;
            const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(item.id)}"]`);
            if (el) { el.style.left = `${item.x}px`; el.style.top = `${item.y}px`; }
          });
          renderEdges(); updateImageSelectionToolbarPosition();
          skipNextTextClick = true;
          return;
        }
        if (!moved) {
          selectedNodeIds = new Set([node.id]); selectedEdgeId = null; updateSelectionUI();
          if (node.type === "text") { skipNextTextClick = true; startEditingText(nodeEl, node); }
          return;
        }
        if (!wasSelected) return;
      }
      if (!moved) return;
      skipNextTextClick = androidLimitedMove && node.type === "text";
      saveBoard(androidLimitedMove ? { captureSync: false } : {});
    };

    nodeEl.addEventListener("pointermove", onMove);
    nodeEl.addEventListener("pointerup", onEnd);
    nodeEl.addEventListener("pointercancel", onEnd);
    if (androidTouch) androidTouchManipulation = { movesNode: wasSelected, cancel: () => onEnd({ type: "pointercancel" }) };
  });

  if (node.type === "text") {
    nodeEl.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startEditingText(nodeEl, node);
    });
    nodeEl.addEventListener("click", (event) => {
      if (!board.readOnly || board.localPackage || !isAndroidNative() || !androidLimitedWriteEnabled) return;
      event.stopPropagation();
      if (skipNextTextClick) {
        skipNextTextClick = false;
        return;
      }
      startEditingText(nodeEl, node);
    });
  } else if (node.type === "group") {
    nodeEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startEditingGroupLabel(nodeEl, node);
    });
  }
}

function createPlannerNodeElement(node) {
  const el = document.createElement("article");
  el.className = `planner-node planner-node-${node.type}`;
  el.dataset.nodeId = node.id;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.width = `${node.w || (node.type === "text" ? 190 : node.type === "group" ? 520 : 240)}px`;
  if (node.type === "group") el.style.height = `${node.h || 320}px`;
  el.style.transform = `rotate(${normalizeRotation(node.rotation)}deg)`;
  el.style.transformOrigin = "center center";

  if (node.type === "image") {
    const img = document.createElement("img");
    img.alt = node.title || "Reference";
    img.draggable = false;
    img.loading = "eager";
    img.decoding = "async";
    img.addEventListener(
      "load",
      () => {
        renderEdges();
        syncMultiImageTransformOverlay();
        updateImageSelectionToolbarPosition();
      },
      { once: true },
    );
    loadPlannerImage(img, node);
    el.appendChild(img);

    const rotateHandle = document.createElement("button");
    rotateHandle.type = "button";
    rotateHandle.className = "planner-rotate-handle";
    rotateHandle.textContent = "↻";
    rotateHandle.title = t("planner-rotate-drag");
    rotateHandle.style.setProperty("--counter-rotation", `${-normalizeRotation(node.rotation)}deg`);
    bindRotateHandle(rotateHandle, el, node);
    el.appendChild(rotateHandle);

    const commentShell = document.createElement("div");
    commentShell.className = "planner-image-comment-shell";
    commentShell.dataset.empty = node.comment ? "false" : "true";
    commentShell.style.setProperty("--counter-rotation", `${-normalizeRotation(node.rotation)}deg`);
    commentShell.style.setProperty("--comment-scale", String(normalizeImageCommentScale(node.commentScale)));

    const comment = document.createElement("div");
    comment.className = "planner-image-comment";
    comment.contentEditable = board.readOnly ? "false" : "true";
    comment.spellcheck = false;
    comment.dataset.empty = node.comment ? "false" : "true";
    comment.textContent = node.comment || t("planner-image-comment-placeholder");
    bindImageComment(comment, node);
    commentShell.appendChild(comment);

    if (!board.readOnly) {
      const sizeControl = document.createElement("div");
      sizeControl.className = "planner-comment-size-control";
      sizeControl.innerHTML = `
        <button type="button" data-comment-size="down" aria-label="Smaller comment text">A−</button>
        <span class="planner-comment-size-value">${normalizeCommentFontSize(board.commentFontSize)}</span>
        <button type="button" data-comment-size="up" aria-label="Larger comment text">A+</button>
      `;
      bindCommentSizeControl(sizeControl);
      commentShell.appendChild(sizeControl);
    }
    el.appendChild(commentShell);
  } else if (node.type === "group") {
    const label = document.createElement("div");
    label.className = "planner-group-label";
    label.textContent = node.text || t("planner-group-placeholder");
    label.style.setProperty("--group-label-scale", String(normalizeGroupLabelScale(node.groupLabelScale)));
    label.style.setProperty("--group-counter-rotation", `${-normalizeRotation(node.rotation)}deg`);
    el.appendChild(label);
  } else {
    const content = document.createElement("div");
    content.className = "planner-text-content";
    content.textContent = node.text || t("planner-text-placeholder");
    content.style.color = node.textColor || "";
    content.style.fontSize = `${Math.max(
      MIN_TEXT_FONT_SIZE,
      Math.min(MAX_TEXT_FONT_SIZE, Number(node.fontSize) || DEFAULT_TEXT_FONT_SIZE),
    )}px`;
    el.style.backgroundColor = node.background || "";
    el.appendChild(content);
  }

  if (node.type !== "group") {
    ["top", "right", "bottom", "left"].forEach((side) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = `planner-connector-handle is-${side}`;
      handle.dataset.side = side;
      handle.setAttribute("aria-label", `Connect ${side}`);
      bindConnectorHandle(handle, node, side);
      el.appendChild(handle);
    });
  }

  if (node.type === "image") {
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const resizeHandle = document.createElement("button");
      resizeHandle.type = "button";
      resizeHandle.className = `planner-resize-handle is-${corner}`;
      resizeHandle.setAttribute("aria-label", `Resize ${corner}`);
      bindResizeHandle(resizeHandle, el, node, corner);
      el.appendChild(resizeHandle);
    });
  } else {
    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.className = "planner-resize-handle is-se";
    resizeHandle.setAttribute("aria-label", "Resize");
    bindResizeHandle(resizeHandle, el, node, "se");
    el.appendChild(resizeHandle);
  }

  bindNodeDrag(el, node);
  return el;
}

function mountPlannerNode(node, { prepend = false, deferUi = false } = {}) {
  const { nodes, empty } = plannerElements();
  if (!nodes || !node?.id) return null;
  const existing = nodes.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
  if (existing) return existing;
  const el = createPlannerNodeElement(node);
  if (prepend) nodes.prepend(el);
  else nodes.appendChild(el);
  if (node.type === "text") fitTextNode(el, node);
  if (!deferUi) {
    if (empty) empty.classList.toggle("hidden", board.nodes.length > 0);
    updateSelectionUI();
    requestAnimationFrame(renderEdges);
  }
  return el;
}

function removePlannerNodeElements(nodeIds) {
  const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
  if (!ids.size) return;
  const { nodes, empty } = plannerElements();
  ids.forEach((nodeId) => {
    revokePlannerObjectUrlForNode(nodeId);
    nodes?.querySelector(`.planner-node[data-node-id="${CSS.escape(nodeId)}"]`)?.remove();
  });
  if (empty) empty.classList.toggle("hidden", board.nodes.length > 0);
}

function syncPlannerNodeDom() {
  const { nodes, empty } = plannerElements();
  if (!nodes) return;
  const desired = new Set(board.nodes.map((node) => node.id));
  Array.from(nodes.children).forEach((el) => {
    if (!el.classList?.contains("planner-node")) return;
    const nodeId = el.dataset.nodeId;
    if (!desired.has(nodeId)) {
      revokePlannerObjectUrlForNode(nodeId);
      el.remove();
    }
  });
  board.nodes.forEach((node) => mountPlannerNode(node, { deferUi: true }));
  if (empty) empty.classList.toggle("hidden", board.nodes.length > 0);
  updateSelectionUI();
  requestAnimationFrame(renderEdges);
}

function renderNodes() {
  const { nodes, empty } = plannerElements();
  if (!nodes) return;
  revokePlannerObjectUrls();
  nodes.innerHTML = "";
  board.nodes.forEach((node) => mountPlannerNode(node, { deferUi: true }));
  if (empty) empty.classList.toggle("hidden", board.nodes.length > 0);
  empty?.querySelector(".planner-empty-actions")?.classList.toggle("hidden", board.readOnly);
  if (board.nodes.length === 0) {
    const controls = document.getElementById("plannerMobileControls");
    if (controls) controls.scrollLeft = 0;
  }
  const mobileClear = document.getElementById("plannerMobileClearBtn");
  if (mobileClear) {
    mobileClear.classList.toggle("hidden", board.readOnly || board.nodes.length === 0);
  }
  updateSelectionUI();
  requestAnimationFrame(renderEdges);
}

function renderPlanner({ full = false } = {}) {
  applyPlannerCommentFontSize();
  if (full) renderNodes();
  else syncPlannerNodeDom();
  applyPlannerTransform();
  syncPlannerProjectUI();
}

function addTextAt(x, y) {
  const androidAddText = board.readOnly === true && !board.localPackage && isAndroidNative() && androidLimitedWriteEnabled;
  if (board.readOnly && !androidAddText) return;
  const node = {
    id: id("text"),
    type: "text",
    text: t("planner-text-placeholder"),
    x,
    y,
    w: 190,
    fontSize: DEFAULT_TEXT_FONT_SIZE,
    textColor: "#171717",
    background: "#fffaf0",
  };
  board.nodes.push(node);
  selectedNodeIds = new Set([node.id]);
  saveBoard(androidAddText ? { captureSync: false } : {});
  renderPlanner();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (el) startEditingText(el, node);
  });
}

function addGroupAt(x, y) {
  if (board.readOnly) return;
  const node = {
    id: id("group"),
    type: "group",
    text: t("planner-group-placeholder"),
    x,
    y,
    w: 520,
    h: 320,
    groupLabelScale: 1,
    memberIds: [],
  };
  board.nodes.unshift(node);
  selectedEdgeId = null;
  selectedNodeIds = new Set([node.id]);
  saveBoard();
  renderPlanner();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (el) startEditingGroupLabel(el, node);
  });
}

function createGroupAroundSelection() {
  if (board.readOnly || selectedEdgeId) return;
  const boxes = getSelectedImageTransformBoxes();
  const bounds = getMultiImageTransformBounds(boxes);
  if (!bounds) return;
  const padding = 56;
  const memberIds = boxes.map((box) => box.model.id);
  const node = {
    id: id("group"),
    type: "group",
    text: t("planner-group-placeholder"),
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
    groupLabelScale: 1,
    memberIds,
  };
  board.nodes.unshift(node);
  selectedNodeIds = new Set([node.id]);
  selectedEdgeId = null;
  saveBoard();
  renderPlanner();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (el) startEditingGroupLabel(el, node);
  });
}

function addAlbumSnapshotToBoard(snapshot) {
  if (!snapshot?.groups?.length) return 0;
  const existingKeys = new Set(
    board.nodes
      .filter((node) => node.type === "image")
      .flatMap((node) => [node.fileKey, node.path, node.uri])
      .filter(Boolean)
      .map(normalizePlannerFileKey),
  );
  const block = board.importCount++;
  const blockCol = block % 4;
  const blockRow = Math.floor(block / 4);
  const baseX = 180 + blockCol * 1300;
  const baseY = 180 + blockRow * 1100;
  let added = 0;

  snapshot.groups.forEach((group, groupIndex) => {
    let y = baseY;
    group.files.forEach((file) => {
      const fileKey = file.path || file.uri || `${group.key}:${file.title}`;
      const normalized = normalizePlannerFileKey(fileKey);
      if (!normalized || existingKeys.has(normalized)) return;
      existingKeys.add(normalized);
      board.nodes.push({
        id: id("image"),
        type: "image",
        fileKey,
        path: file.path || "",
        uri: file.uri || "",
        thumbnail: file.thumbnail || "",
        title: file.title || group.title || "Reference",
        sourceUrl: group.sourceUrl || "",
        albumId: snapshot.id,
        x: baseX + groupIndex * 275,
        y,
        w: 240,
        rotation: 0,
        comment: "",
      });
      y += 250;
      added++;
    });
  });
  return added;
}

function addAlbumToPlanner() {
  const snapshot = getActiveInspirationAlbumSnapshot();
  if (activePlannerAlbumId !== snapshot.id) ensurePlannerForActiveAlbum({ seedFromAlbum: false });
  if (board.readOnly) return;
  if (!snapshot.groups.length) {
    showToast(t("inspiration-empty"));
    return;
  }
  const added = addAlbumSnapshotToBoard(snapshot);
  saveBoard();
  switchPlannerMode("planner");
  renderPlanner();
  showToast(added > 0 ? t("planner-added-album") : t("batch-title-duplicate"));
}

function rotateSelectedImages() {
  if (board.readOnly) return;
  const selectedImages = board.nodes.filter(
    (node) => selectedNodeIds.has(node.id) && node.type === "image",
  );
  if (!selectedImages.length) return;
  selectedImages.forEach((node) => {
    node.rotation = (normalizeRotation(node.rotation) + 90) % 360;
    const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (el) el.style.transform = `rotate(${node.rotation}deg)`;
  });
  saveBoard();
  renderEdges();
}

function applyTextStyle(kind, value) {
  if (board.readOnly) return;
  const textNodes = board.nodes.filter(
    (node) => selectedNodeIds.has(node.id) && node.type === "text",
  );
  if (!textNodes.length) return;
  textNodes.forEach((node) => {
    if (kind === "text") node.textColor = value;
    if (kind === "background") node.background = value;
    if (kind === "fontSize") {
      node.fontSize = Math.max(
        MIN_TEXT_FONT_SIZE,
        Math.min(MAX_TEXT_FONT_SIZE, Number(value) || DEFAULT_TEXT_FONT_SIZE),
      );
    }
    const el = document.querySelector(`.planner-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (!el) return;
    const content = el.querySelector(".planner-text-content");
    if (kind === "text") {
      if (content) content.style.color = value;
    } else if (kind === "fontSize") {
      if (content) content.style.fontSize = `${node.fontSize}px`;
      if (!node.userSized) fitTextNode(el, node);
    } else {
      el.style.backgroundColor = value;
    }
  });
  saveBoard();
}

function fitAllContent() {
  const { viewport } = plannerElements();
  if (!viewport || board.nodes.length === 0) return;
  const boxes = board.nodes
    .map((node) => getNodeBox(node.id))
    .filter(Boolean)
    .map((box) => {
      const radians = (box.rotation * Math.PI) / 180;
      const cos = Math.abs(Math.cos(radians));
      const sin = Math.abs(Math.sin(radians));
      const w = box.w * cos + box.h * sin;
      const h = box.w * sin + box.h * cos;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      return {
        left: cx - w / 2,
        right: cx + w / 2,
        top: cy - h / 2,
        bottom: cy + h / 2,
      };
    });
  if (!boxes.length) return;
  const minX = Math.min(...boxes.map((box) => box.left));
  const maxX = Math.max(...boxes.map((box) => box.right));
  const minY = Math.min(...boxes.map((box) => box.top));
  const maxY = Math.max(...boxes.map((box) => box.bottom));
  const contentW = Math.max(200, maxX - minX);
  const contentH = Math.max(160, maxY - minY);
  const padding = 100;
  const zoom = Math.max(
    MIN_PLANNER_ZOOM,
    Math.min(
      1.4,
      (viewport.clientWidth - padding) / contentW,
      (viewport.clientHeight - padding) / contentH,
    ),
  );
  board.view.zoom = zoom;
  board.view.panX = viewport.clientWidth / 2 - ((minX + maxX) / 2) * zoom;
  board.view.panY = viewport.clientHeight / 2 - ((minY + maxY) / 2) * zoom +
    (isAndroidNative() ? 58 : 0);
  applyPlannerTransform();
  saveBoard();
}

export function getPlannerAiImages() {
  return board.nodes
    .filter(node => node.type === "image" && (node.assetId || node.path || node.uri))
    .map(node => ({
      id: node.id,
      type: "image",
      title: node.title || node.assetId || "Image",
      assetId: node.assetId || "",
      path: node.path || "",
      uri: node.uri || "",
      savedAt: Number(node.savedAt) || 0,
      confidence: 0,
    }));
}

export function removePlannerContentForAlbumSource({ albumId, sourceUrl, fileKeys = [] } = {}) {
  if (!albumId) return { imagesRemoved: 0, groupsRemoved: 0 };
  const linked = getAlbumPlannerProject(albumId);
  if (!linked?.projectId) return { imagesRemoved: 0, groupsRemoved: 0 };
  const active = activePlannerAlbumId === albumId && activePlannerProjectId === linked.projectId;
  const target = active ? board : loadProjectBoard(linked.projectId);
  if (!target || target.readOnly) return { imagesRemoved: 0, groupsRemoved: 0 };

  const normalizedFiles = new Set(
    (Array.isArray(fileKeys) ? fileKeys : [])
      .filter(Boolean)
      .map(normalizePlannerFileKey),
  );
  const source = String(sourceUrl || "");
  const removedImageIds = new Set(
    target.nodes
      .filter(node => {
        if (node.type !== "image" || node.albumId !== albumId) return false;
        if (source && String(node.sourceUrl || "") === source) return true;
        return [node.fileKey, node.path, node.uri]
          .filter(Boolean)
          .some(value => normalizedFiles.has(normalizePlannerFileKey(value)));
      })
      .map(node => node.id),
  );
  if (!removedImageIds.size) return { imagesRemoved: 0, groupsRemoved: 0 };

  const affectedGeneratedGroups = new Set(
    target.nodes
      .filter(node =>
        node.type === "group" &&
        node.aiGeneratedPlanner === true &&
        (node.memberIds || []).some(id => removedImageIds.has(id)))
      .map(node => node.id),
  );
  target.nodes = target.nodes
    .filter(node => !removedImageIds.has(node.id))
    .map(node => node.type === "group"
      ? {
          ...node,
          memberIds: (node.memberIds || []).filter(id => !removedImageIds.has(id)),
          ...(affectedGeneratedGroups.has(node.id) ? { summaryNodeId: "" } : {}),
        }
      : node);
  target.edges = target.edges.filter(edge =>
    !removedImageIds.has(edge.from) && !removedImageIds.has(edge.to));

  const removedGeneratedGroups = new Set();
  target.nodes.forEach(node => {
    if (node.type !== "group" || node.aiGeneratedPlanner !== true) return;
    if ((node.memberIds || []).length === 0) removedGeneratedGroups.add(node.id);
  });
  if (removedGeneratedGroups.size) {
    target.nodes = target.nodes.filter(node =>
      !removedGeneratedGroups.has(node.id) &&
      !(node.aiGeneratedPlanner === true && removedGeneratedGroups.has(node.aiSummaryForGroup)));
  }
  target.nodes = target.nodes.filter(node =>
    !(node.aiGeneratedPlanner === true &&
      node.aiSummaryForGroup &&
      affectedGeneratedGroups.has(node.aiSummaryForGroup)));

  if (active) {
    selectedNodeIds.clear();
    selectedEdgeId = null;
    saveBoard();
    renderPlanner({ full: true });
  } else {
    localStorage.setItem(plannerBoardStorageKey(linked.projectId), JSON.stringify(target));
  }
  return {
    imagesRemoved: removedImageIds.size,
    groupsRemoved: removedGeneratedGroups.size,
  };
}

export function ensureEditablePlannerCopy() {
  if (!board.readOnly) return false;
  const clone = normalizeStoredBoard(structuredClone(board), {
    projectId: id("project"),
    readOnly: false,
  });
  if (!clone) throw new Error("当前策划无法复制");
  clone.projectId = id("project");
  clone.projectTitle = `${board.projectTitle || t("planner-default-project-title")} · AI`;
  clone.readOnly = false;
  clone.localPackage = true;
  const index = loadPlannerIndex();
  activatePlannerBoard(clone, activePlannerAlbumId);
  registerPlannerProject(index, clone, activePlannerAlbumId);
  savePlannerIndex(index);
  localStorage.setItem(plannerBoardStorageKey(clone.projectId), JSON.stringify(clone));
  renderPlanner({ full: true });
  return true;
}

function aiPlannerGroupBrief(group) {
  const analyses = (Array.isArray(group?.analyses) ? group.analyses : [])
    .filter(analysis => analysis && typeof analysis === "object");
  const unique = (values) => [...new Set(values
    .map(value => String(value || "").trim())
    .filter(Boolean))];
  const cameraFields = [
    ["ai-param-focal", analyses.map(item => item.camera?.focalLength)],
    ["ai-param-aperture", analyses.map(item => item.camera?.aperture)],
    ["ai-param-shutter", analyses.map(item => item.camera?.shutter)],
    ["ai-param-iso", analyses.map(item => item.camera?.iso)],
  ];
  const camera = cameraFields
    .map(([label, values]) => [t(label), unique(values).slice(0, 2).join(" / ")])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} ${value}`);
  const lines = [];
  if (camera.length) lines.push(camera.join(" · ").slice(0, 180));
  const composition = unique(analyses.map(item => item.composition)).slice(0, 1);
  if (composition.length) lines.push(`${t("ai-result-composition")}：${composition.join("；")}`);
  const poseAdvice = unique(analyses.map(item => item.poseAdvice)).slice(0, 1);
  if (poseAdvice.length) lines.push(`${t("ai-result-pose-advice")}：${poseAdvice.join("；")}`);
  const lighting = unique(analyses.map(item => item.camera?.lighting)).slice(0, 1);
  if (lighting.length) lines.push(`${t("ai-param-light")}：${lighting.join("；")}`);
  return lines.join("\n").slice(0, 320);
}

export function applyAiPlannerPlan(plan = []) {
  if (board.readOnly) throw new Error("当前策划为只读，不能应用 AI 排版");
  const imageIds = new Set(getPlannerAiImages().map(image => image.id));
  const validGroups = (Array.isArray(plan) ? plan : [])
    .map(group => ({
      code: String(group?.code || "other"),
      title: String(group?.title || group?.code || "AI"),
      analyses: Array.isArray(group?.analyses) ? group.analyses : [],
      nodeIds: [...new Set((Array.isArray(group?.nodeIds) ? group.nodeIds : []).map(String))]
        .filter(id => imageIds.has(id)),
    }))
    .filter(group => group.nodeIds.length);
  if (!validGroups.length) throw new Error("没有可排版的 AI 图片分组");

  board.nodes = board.nodes.filter(node => node.aiGeneratedPlanner !== true);
  const imageNodes = new Map(board.nodes.filter(node => node.type === "image").map(node => [node.id, node]));
  const groups = [];
  const generatedNodes = [];
  let groupY = 80;
  const columnWidth = 300;
  const rowHeight = 360;
  for (const group of validGroups) {
    const columns = Math.min(3, group.nodeIds.length);
    const rows = Math.ceil(group.nodeIds.length / 3);
    const width = Math.max(430, columns * columnWidth + 70);
    const brief = aiPlannerGroupBrief(group);
    const height = Math.max(340, rows * rowHeight + 100) + (brief ? 320 : 0);
    const noteId = brief ? id("ai_note") : "";
    const groupNode = {
      id: id("ai_group"),
      type: "group",
      text: group.title,
      x: 80,
      y: groupY,
      w: width,
      h: height,
      rotation: 0,
      memberIds: [...group.nodeIds],
      summaryNodeId: noteId || "",
      aiGeneratedPlanner: true,
      aiPose: group.code,
    };
    group.nodeIds.forEach((nodeId, index) => {
      const node = imageNodes.get(nodeId);
      if (!node) return;
      node.x = groupNode.x + 40 + (index % 3) * columnWidth;
      node.y = groupNode.y + 80 + Math.floor(index / 3) * rowHeight;
      node.w = 250;
      node.rotation = 0;
      node.userSized = true;
    });
    groups.push(groupNode);
    generatedNodes.push(groupNode);
    if (brief) {
      generatedNodes.push({
        id: noteId,
        type: "text",
        text: brief,
        x: groupNode.x + 40,
        y: groupNode.y + 80 + rows * rowHeight + 4,
        w: width - 80,
        fontSize: 16,
        textColor: "#3e3e43",
        background: "#fffdf8",
        aiGeneratedPlanner: true,
        aiSummaryForGroup: groupNode.id,
      });
    }
    groupY += height + 80;
  }
  board.nodes = [...generatedNodes, ...board.nodes];
  selectedNodeIds.clear();
  selectedEdgeId = null;
  saveBoard({ captureSync: isAndroidNative() ? false : undefined });
  renderPlanner({ full: true });
  requestAnimationFrame(() => fitAllContent());
  return { groups: groups.length, images: groups.reduce((sum, group) => sum + group.memberIds.length, 0) };
}

function deleteSelected() {
  const androidSingleDelete =
    board.readOnly === true &&
    isAndroidNative() &&
    androidLimitedWriteEnabled && !board.localPackage &&
    !selectedEdgeId &&
    selectedNodeIds.size === 1;
  if (board.readOnly && !androidSingleDelete) return;
  if (selectedEdgeId) {
    board.edges = board.edges.filter((edge) => edge.id !== selectedEdgeId);
    selectedEdgeId = null;
  }
  if (selectedNodeIds.size > 0) {
    const removedIds = new Set(selectedNodeIds);
    board.nodes = board.nodes
      .filter((node) => !removedIds.has(node.id))
      .map((node) =>
        node.type === "group" && Array.isArray(node.memberIds)
          ? { ...node, memberIds: node.memberIds.filter((memberId) => !removedIds.has(memberId)) }
          : node,
      );
    board.edges = board.edges.filter(
      (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
    );
    selectedNodeIds.clear();
  }
  saveBoard(androidSingleDelete ? { captureSync: false } : {});
  renderPlanner();
}

function clearPlanner() {
  if (board.readOnly || board.nodes.length === 0) return;
  showConfirm(t("planner-clear"), t("confirm-msg-default"), () => {
    board.nodes = [];
    board.edges = [];
    board.importCount = 0;
    selectedNodeIds.clear();
    selectedEdgeId = null;
    saveBoard();
    renderPlanner();
    requestAnimationFrame(() => {
      const controls = document.getElementById("plannerMobileControls");
      if (controls) controls.scrollTo({ left: 0, behavior: "smooth" });
      document.getElementById("plannerEmptyAddTextBtn")?.focus({ preventScroll: true });
    });
  });
}

function setPlannerZoom(nextZoom, clientX, clientY) {
  const { viewport } = plannerElements();
  if (!viewport) return;
  const next = Math.max(MIN_PLANNER_ZOOM, Math.min(MAX_PLANNER_ZOOM, nextZoom));
  const rect = viewport.getBoundingClientRect();
  const anchorX = clientX ?? rect.left + rect.width / 2;
  const anchorY = clientY ?? rect.top + rect.height / 2;
  const worldX = (anchorX - rect.left - board.view.panX) / board.view.zoom;
  const worldY = (anchorY - rect.top - board.view.panY) / board.view.zoom;
  board.view.zoom = next;
  board.view.panX = anchorX - rect.left - worldX * next;
  board.view.panY = anchorY - rect.top - worldY * next;
  applyPlannerTransform();
  saveBoard();
}

function bindPlannerInteractions() {
  if (plannerBound) return;
  const { viewport, marquee, selectionToolbar } = plannerElements();
  if (!viewport || !marquee) return;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(syncPlannerEdgeViewport).observe(viewport);
  }
  plannerBound = true;

  selectionToolbar?.addEventListener("pointerdown", (event) => event.stopPropagation());
  selectionToolbar?.addEventListener("dblclick", (event) => event.stopPropagation());

  let gesture = null;
  let touchGesture = null;

  viewport.addEventListener("pointerdown", event => {
    if (!isAndroidNative() || event.pointerType !== "touch") return;
    if (event.isPrimary !== false) androidTouchWasMultitouch = false;
    else {
      androidTouchWasMultitouch = true;
      androidTouchManipulation?.cancel();
    }
  }, { capture: true });
  viewport.addEventListener("touchstart", event => {
    if (!isPlannerMode()) return;
    if (event.touches.length >= 2) {
      androidTouchWasMultitouch = true;
      androidTouchManipulation?.cancel();
    } else androidTouchWasMultitouch = false;
  }, { capture: true, passive: true });
  viewport.addEventListener("click", event => {
    if (androidTouchWasMultitouch && event.detail) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true });

  viewport.addEventListener("pointerdown", (event) => {
    if (isAndroidNative() && event.pointerType === "touch") return;
    if (
      !board.readOnly &&
      (event.target.closest(".planner-node") ||
        event.target.closest(".planner-edge-hit") ||
        event.target.closest(".planner-mobile-controls"))
    ) {
      return;
    }
    viewport.focus({ preventScroll: true });

    const isPan =
      event.button === 1 ||
      (event.button === 0 && spacePressed) ||
      (board.readOnly && event.button === 0);
    if (isPan) {
      event.preventDefault();
      gesture = {
        type: "pan",
        startX: event.clientX,
        startY: event.clientY,
        panX: board.view.panX,
        panY: board.view.panY,
      };
      viewport.classList.add("is-panning");
      viewport.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) return;
    selectedEdgeId = null;
    const rect = viewport.getBoundingClientRect();
    gesture = {
      type: "marquee",
      startX: event.clientX,
      startY: event.clientY,
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      additive: event.shiftKey,
      moved: false,
    };
    marquee.classList.remove("hidden");
    marquee.style.left = `${gesture.left}px`;
    marquee.style.top = `${gesture.top}px`;
    marquee.style.width = "0px";
    marquee.style.height = "0px";
    viewport.setPointerCapture(event.pointerId);
  });

  viewport.addEventListener("pointermove", (event) => {
    lastPlannerPointer = { x: event.clientX, y: event.clientY };
    if (!gesture) return;
    if (gesture.type === "pan") {
      board.view.panX = gesture.panX + event.clientX - gesture.startX;
      board.view.panY = gesture.panY + event.clientY - gesture.startY;
      applyPlannerTransform();
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    const left = Math.min(gesture.left, currentX);
    const top = Math.min(gesture.top, currentY);
    const width = Math.abs(currentX - gesture.left);
    const height = Math.abs(currentY - gesture.top);
    gesture.moved = width + height > 4;
    marquee.style.left = `${left}px`;
    marquee.style.top = `${top}px`;
    marquee.style.width = `${width}px`;
    marquee.style.height = `${height}px`;
  });

  const finishGesture = (event) => {
    if (!gesture) return;
    if (gesture.type === "pan") {
      viewport.classList.remove("is-panning");
      saveBoard();
    } else {
      const selectionRect = marquee.getBoundingClientRect();
      if (!gesture.additive) selectedNodeIds.clear();
      selectedEdgeId = null;
      if (gesture.moved) {
        document.querySelectorAll(".planner-node").forEach((nodeEl) => {
          const rect = nodeEl.getBoundingClientRect();
          const intersects =
            rect.right >= selectionRect.left &&
            rect.left <= selectionRect.right &&
            rect.bottom >= selectionRect.top &&
            rect.top <= selectionRect.bottom;
          if (intersects) selectedNodeIds.add(nodeEl.dataset.nodeId);
        });
      }
      marquee.classList.add("hidden");
      updateSelectionUI();
    }
    try {
      viewport.releasePointerCapture(event.pointerId);
    } catch (_) {}
    gesture = null;
  };
  viewport.addEventListener("pointerup", finishGesture);
  viewport.addEventListener("pointercancel", finishGesture);
  viewport.addEventListener("pointerenter", (event) => {
    lastPlannerPointer = { x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener("pointerleave", () => {
    lastPlannerPointer = null;
  });

  const beginReadonlyTouchGesture = (touches) => {
    const rect = viewport.getBoundingClientRect();
    if (touches.length >= 2) {
      const first = touches[0];
      const second = touches[1];
      const centerX = (first.clientX + second.clientX) / 2;
      const centerY = (first.clientY + second.clientY) / 2;
      const distance = Math.max(
        1,
        Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
      );
      touchGesture = {
        type: "pinch",
        distance,
        zoom: board.view.zoom,
        worldX: (centerX - rect.left - board.view.panX) / board.view.zoom,
        worldY: (centerY - rect.top - board.view.panY) / board.view.zoom,
      };
      return;
    }
    if (touches.length === 1) {
      touchGesture = {
        type: "pan",
        x: touches[0].clientX,
        y: touches[0].clientY,
        panX: board.view.panX,
        panY: board.view.panY,
        tapBlank: false,
      };
    }
  };

  viewport.addEventListener(
    "touchstart",
    (event) => {
      if (!isPlannerMode()) return;
      if (event.touches.length < 2 && (androidTouchManipulation?.movesNode ||
          event.target.closest?.(".planner-node, .planner-edge-hit, .planner-mobile-controls, .planner-selection-toolbar, button, input, textarea, [contenteditable='true']"))) return;
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      beginReadonlyTouchGesture(event.touches);
      if (touchGesture?.type === "pan") {
        touchGesture.tapBlank = !event.target.closest?.(".planner-node, .planner-edge-hit, .planner-mobile-controls, .planner-selection-toolbar, button, input, textarea, [contenteditable='true']");
      }
      viewport.classList.add("is-panning");
    },
    { passive: false },
  );

  viewport.addEventListener(
    "touchmove",
    (event) => {
      if (!isPlannerMode()) return;
      if (event.touches.length < 2 && (androidTouchManipulation?.movesNode ||
          event.target.closest?.(".planner-node, .planner-edge-hit, .planner-mobile-controls, .planner-selection-toolbar, button, input, textarea, [contenteditable='true']"))) return;
      event.preventDefault();
      const touches = event.touches;
      if (!touchGesture || (touches.length >= 2 && touchGesture.type !== "pinch")) {
        beginReadonlyTouchGesture(touches);
      }
      if (!touchGesture) return;

      if (touches.length >= 2 && touchGesture.type === "pinch") {
        const first = touches[0];
        const second = touches[1];
        const centerX = (first.clientX + second.clientX) / 2;
        const centerY = (first.clientY + second.clientY) / 2;
        const distance = Math.max(
          1,
          Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        );
        const nextZoom = Math.max(
          MIN_PLANNER_ZOOM,
          Math.min(MAX_PLANNER_ZOOM, touchGesture.zoom * (distance / touchGesture.distance)),
        );
        const rect = viewport.getBoundingClientRect();
        board.view.zoom = nextZoom;
        board.view.panX = centerX - rect.left - touchGesture.worldX * nextZoom;
        board.view.panY = centerY - rect.top - touchGesture.worldY * nextZoom;
        applyPlannerTransform();
        return;
      }

      if (touches.length === 1 && touchGesture.type === "pan") {
        if (Math.hypot(touches[0].clientX - touchGesture.x, touches[0].clientY - touchGesture.y) > 8) {
          touchGesture.tapBlank = false;
        }
        board.view.panX = touchGesture.panX + touches[0].clientX - touchGesture.x;
        board.view.panY = touchGesture.panY + touches[0].clientY - touchGesture.y;
        applyPlannerTransform();
      }
    },
    { passive: false },
  );

  viewport.addEventListener(
    "touchend",
    (event) => {
      if (!isPlannerMode()) return;
      if (!touchGesture || (event.touches.length < 2 && !androidTouchWasMultitouch &&
          event.target.closest?.(".planner-node, .planner-edge-hit, .planner-mobile-controls, .planner-selection-toolbar, button, input, textarea, [contenteditable='true']"))) return;
      event.preventDefault();
      if (event.touches.length > 0) {
        beginReadonlyTouchGesture(event.touches);
      } else {
        if (touchGesture?.tapBlank) {
          selectedNodeIds.clear();
          selectedEdgeId = null;
          connectingEdge = null;
          renderEdges();
          updateSelectionUI();
        }
        touchGesture = null;
        viewport.classList.remove("is-panning");
        saveBoard();
      }
    },
    { passive: false },
  );

  viewport.addEventListener("touchcancel", () => {
    androidTouchManipulation?.cancel();
    touchGesture = null;
    viewport.classList.remove("is-panning");
  });

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(320, viewport.clientHeight)
            : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;

      if (event.ctrlKey || event.metaKey) {
        setPlannerZoom(board.view.zoom * Math.exp(-dy * 0.00135), event.clientX, event.clientY);
        return;
      }
      if (event.shiftKey) {
        if (Math.abs(dx) < Math.abs(dy)) dx = dy;
        dy = 0;
      }
      board.view.panX -= dx;
      board.view.panY -= dy;
      applyPlannerTransform();
    },
    { passive: false },
  );

  viewport.addEventListener("dblclick", (event) => {
    if (board.readOnly || event.target.closest(".planner-node")) return;
    const point = viewportPointToWorld(event.clientX, event.clientY);
    addTextAt(point.x, point.y);
  });

  viewport.addEventListener("dragenter", (event) => {
    if (!isPlannerMode() || board.readOnly) return;
    event.preventDefault();
    viewport.classList.add("is-external-drag");
  });

  viewport.addEventListener("dragover", (event) => {
    if (!isPlannerMode() || board.readOnly) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    viewport.classList.add("is-external-drag");
  });

  viewport.addEventListener("dragleave", (event) => {
    if (!viewport.contains(event.relatedTarget)) {
      viewport.classList.remove("is-external-drag");
    }
  });

  viewport.addEventListener("drop", async (event) => {
    if (!isPlannerMode() || board.readOnly) return;
    event.preventDefault();
    viewport.classList.remove("is-external-drag");
    const point = viewportPointToWorld(event.clientX, event.clientY);
    const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
      file.type?.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(file.name || ""),
    );

    try {
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          await importImageFile(files[i], { x: point.x + i * 24, y: point.y + i * 24 });
        }
        showToast(t("planner-imported-images", { count: files.length }));
        return;
      }

      const url = imageUrlFromTransfer(event.dataTransfer);
      if (url) {
        await importImageUrl(url, point);
        showToast(t("planner-imported-image"));
      }
    } catch (error) {
      console.warn("Planner drop import failed:", error);
      showToast(t("planner-import-failed"));
    }
  });

  window.addEventListener("paste", async (event) => {
    if (!isPlannerMode() || board.readOnly) return;
    if (event.target.closest?.("[contenteditable='true'], input, textarea")) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const imageItems = Array.from(clipboard.items || []).filter((item) =>
      item.type?.startsWith("image/"),
    );
    const point = plannerPastePoint();

    try {
      if (imageItems.length > 0) {
        event.preventDefault();
        let added = 0;
        for (let i = 0; i < imageItems.length; i++) {
          const file = imageItems[i].getAsFile();
          if (!file) continue;
          await importImageFile(file, { x: point.x + added * 24, y: point.y + added * 24 });
          added++;
        }
        if (added > 0) showToast(t("planner-imported-images", { count: added }));
        return;
      }

      const text = String(clipboard.getData("text/plain") || "").trim();
      if (looksLikeHttpUrl(text)) {
        event.preventDefault();
        await importImageUrl(text, point);
        showToast(t("planner-imported-image"));
      }
    } catch (error) {
      console.warn("Planner paste import failed:", error);
      showToast(
        String(error?.message || "").includes("does not point to an image")
          ? t("planner-url-not-image")
          : t("planner-import-failed"),
      );
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!isPlannerMode()) return;
    if (board.readOnly) {
      if (event.key === "Escape") {
        selectedNodeIds.clear();
        selectedEdgeId = null;
        connectingEdge = null;
        renderEdges();
        updateSelectionUI();
      }
      return;
    }
    const editing = event.target.closest?.("[contenteditable='true'], input, textarea");
    if (event.code === "Space" && !editing) {
      spacePressed = true;
      event.preventDefault();
    }
    if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      deleteSelected();
    }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectedEdgeId = null;
      selectedNodeIds = new Set(board.nodes.map((node) => node.id));
      updateSelectionUI();
    }
    if (!editing && event.key === "Escape") {
      selectedNodeIds.clear();
      selectedEdgeId = null;
      connectingEdge = null;
      renderEdges();
      updateSelectionUI();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") spacePressed = false;
  });
}

function assertActivePlannerSyncTarget(options = {}) {
  const currentProjectId = String(activePlannerProjectId || board?.projectId || "");
  if (options.expectedProjectId && String(options.expectedProjectId) !== currentProjectId) {
    throw new Error("Planner project changed while sync was in progress");
  }
  if (
    options.expectedGeneration !== undefined &&
    Number(options.expectedGeneration) !== plannerLocalGeneration
  ) {
    throw new Error("Planner changed while sync was in progress");
  }
  return currentProjectId;
}

export function setAndroidLimitedWriteEnabled(enabled) {
  androidLimitedWriteEnabled = isAndroidNative() && enabled === true;
  plannerElements().page?.classList.toggle("planner-android-limited-write", androidLimitedWriteEnabled && !board.localPackage);
}

export async function prepareAndroidReadOnlyPlannerProject(project = {}) {
  if (!isAndroidNative()) throw new Error("Android read-only Planner is only available on Android");
  await plannerSyncStageQueue;
  const projectId = String(project.projectId || "").trim();
  if (!projectId) throw new Error("Android read-only Planner requires projectId");
  const snapshot = getActiveInspirationAlbumSnapshot();
  let index = loadPlannerIndex();
  index = migrateLegacyPlannerIfNeeded(index, snapshot.id);
  const existing = loadProjectBoard(projectId);
  const nextBoard = existing || createEmptyBoard({
    projectId,
    projectTitle: String(project.title || "") || t("planner-default-project-title"),
    readOnly: true,
  });
  nextBoard.projectId = projectId;
  if (project.title) nextBoard.projectTitle = String(project.title);
  nextBoard.readOnly = true;
  const albumId = String(project.albumId || "");
  activatePlannerBoard(nextBoard, albumId);
  registerPlannerProject(index, nextBoard, albumId);
  savePlannerIndex(index);
  localStorage.setItem(plannerBoardStorageKey(projectId), JSON.stringify(nextBoard));
  renderPlanner({ full: true });
  syncPlannerProjectUI();
  return {
    projectId,
    albumId,
    generation: plannerLocalGeneration,
    readOnly: true,
  };
}

export async function getPlannerManualSyncState() {
  ensurePlannerForActiveAlbum();
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget();
  const rawText = localStorage.getItem(plannerBoardStorageKey(projectId)) ?? JSON.stringify(board);
  return {
    rawText,
    projectId,
    albumId: activePlannerAlbumId,
    identityNeedsBackup: false,
    generation: plannerLocalGeneration,
    readOnly: board.readOnly === true,
  };
}

export async function persistPlannerProjectIdentityAfterBackup(expectedRawText, expectedProjectId = "") {
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget({ expectedProjectId });
  const currentRaw = localStorage.getItem(plannerBoardStorageKey(projectId)) ?? JSON.stringify(board);
  if (currentRaw !== expectedRawText) {
    throw new Error("Planner changed while the safety backup was being created");
  }
  if (!projectId) throw new Error("Planner project identity is unavailable");
  return projectId;
}

export async function getPlannerSyncSnapshot(options = {}) {
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget(options);
  const snapshot = await snapshotPlannerBoardForSync(board);
  if (snapshot.shared?.project?.id !== projectId) {
    throw new Error("Planner sync snapshot target changed unexpectedly");
  }
  return { ...snapshot, projectId, generation: plannerLocalGeneration };
}

export async function catalogCurrentPlannerImagesForSync(options = {}) {
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget(options);
  if (isAndroidNative()) throw new Error("Planner image cataloging for manual sync is desktop-only");
  const generation = plannerLocalGeneration;
  const assertCatalogTargetIsCurrent = () => {
    const currentProjectId = String(activePlannerProjectId || board?.projectId || "");
    if (
      plannerLocalGeneration !== generation ||
      currentProjectId !== projectId ||
      String(board?.projectId || "") !== projectId
    ) {
      throw new Error("Planner changed while sync was in progress");
    }
  };

  let cataloguedCount = 0;
  let skippedCount = 0;
  const imageNodes = board.nodes.filter((node) => node?.type === "image");
  const knownAssetIds = [...new Set(imageNodes.map((node) => String(node?.assetId || "")).filter(Boolean))];
  const knownAssets = await getPlannerAssetsByIds(knownAssetIds);
  assertCatalogTargetIsCurrent();
  const assetsById = new Map(knownAssets.map((asset) => [String(asset?.id || ""), asset]));
  const needsCataloging = (assetId) => {
    if (!assetId) return true;
    const asset = assetsById.get(String(assetId));
    return !(
      asset?.type === "image" &&
      asset?.source?.hash === asset.id &&
      String(asset?.display?.hash || "").startsWith("sha256:") &&
      !plannerAssetNeedsDisplayRebuild(asset)
    );
  };
  const candidates = imageNodes.filter((node) => needsCataloging(node?.assetId));
  const pendingNodeUpdates = [];

  for (const node of candidates) {
    assertCatalogTargetIsCurrent();
    const raw = String(node?.uri || node?.path || "");
    if (!raw) {
      skippedCount += 1;
      continue;
    }
    try {
      const bytes = await readPlannerNodeBytes(node);
      assertCatalogTargetIsCurrent();
      if (!bytes.length) {
        skippedCount += 1;
        continue;
      }
      const prepared = await preparePlannerImageAsset(bytes, {
        mime: guessMime(raw),
        filename: raw || node.title || "",
      });
      assertCatalogTargetIsCurrent();
      const existingAsset = assetsById.get(String(node.assetId || ""));
      // Imported packages can bind the display copy rather than the original.
      // Re-encoding that known copy must preserve its original asset identity.
      if (
        existingAsset?.source?.hash === existingAsset?.id &&
        prepared.asset.id === existingAsset?.display?.hash
      ) {
        prepared.asset = { ...prepared.asset, id: existingAsset.id, source: { ...existingAsset.source } };
      }
      const assetId = String(prepared.asset.id || "");
      if (!assetId || prepared.asset.source?.hash !== assetId) {
        throw new Error("Planner image bytes did not produce a valid source asset id");
      }
      const binding = createPlannerAssetLocalBinding(assetId, {
        path: node.path || "",
        uri: node.uri || node.path || "",
        thumbnail: node.thumbnail || "",
        filename: raw.split(/[\\/]/).pop() || "",
      });
      await putPlannerAsset(prepared.asset, binding);
      assertCatalogTargetIsCurrent();
      pendingNodeUpdates.push({
        nodeId: String(node.id || ""),
        previousAssetId: String(node.assetId || ""),
        assetId,
      });
    } catch (error) {
      assertCatalogTargetIsCurrent();
      skippedCount += 1;
      console.warn("Could not catalog Planner image for sync:", error);
    }
  }

  assertCatalogTargetIsCurrent();
  for (const update of pendingNodeUpdates) {
    const currentNode = board.nodes.find((item) => String(item?.id || "") === update.nodeId);
    if (
      !currentNode ||
      currentNode.type !== "image" ||
      String(currentNode.assetId || "") !== update.previousAssetId
    ) {
      skippedCount += 1;
      continue;
    }
    currentNode.assetId = update.assetId;
    currentNode.fileKey = update.assetId;
    cataloguedCount += 1;
  }

  if (cataloguedCount) saveBoard({ captureSync: false });
  return {
    projectId,
    generation: plannerLocalGeneration,
    cataloguedCount,
    skippedCount,
    totalCount: imageNodes.length,
  };
}

export async function stageCurrentPlannerForManualSync(options = {}) {
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget(options);
  const generation = plannerLocalGeneration;
  const staged = await stagePlannerBoardForSync(board, {
    deviceId: options.deviceId || getOrCreateSyncDeviceId(),
  });
  if (staged.projectId !== projectId) throw new Error("Planner sync staging target changed unexpectedly");
  if (plannerLocalGeneration !== generation || activePlannerProjectId !== projectId) {
    throw new Error("Planner changed while sync staging was in progress");
  }
  return { ...staged, projectId, generation };
}

export async function applyPlannerMergedSharedState(shared, options = {}) {
  await plannerSyncStageQueue;
  const projectId = assertActivePlannerSyncTarget(options);
  if (String(shared?.project?.id || "") !== projectId) {
    throw new Error("Remote Planner project does not match the active local project");
  }
  const { local } = splitPlannerBoardForSync(board);
  board = mergePlannerBoardFromSync(shared, local);

  const activeNodeIds = new Set(board.nodes.map((node) => node.id));
  const activeEdgeIds = new Set(board.edges.map((edge) => edge.id));
  selectedNodeIds = new Set([...selectedNodeIds].filter((nodeId) => activeNodeIds.has(nodeId)));
  if (selectedEdgeId && !activeEdgeIds.has(selectedEdgeId)) selectedEdgeId = null;
  if (connectingEdge?.nodeId && !activeNodeIds.has(connectingEdge.nodeId)) connectingEdge = null;

  // Rebuild visible nodes before persistence so deterministic UI-derived
  // layout (notably auto-sized text cards) is captured in the same checkpoint.
  renderPlanner({ full: true });
  saveBoard({ captureSync: false, markLocalChange: false });
  return (await snapshotPlannerBoardForSync(board)).shared;
}

export function bindAndroidPlannerDisplayPreviews(bindings = [], options = {}) {
  if (!isAndroidNative()) return 0;
  if (options.expectedProjectId) assertActivePlannerSyncTarget({ expectedProjectId: options.expectedProjectId });
  const byNodeId = new Map(
    (Array.isArray(bindings) ? bindings : [])
      .filter((binding) => binding?.nodeId && binding?.uri)
      .map((binding) => [String(binding.nodeId), binding]),
  );
  let boundCount = 0;
  let clearedCount = 0;
  board.nodes.forEach((node) => {
    if (node?.type !== "image") return;
    if (options.resetSyncedImages && node.assetId) {
      for (const field of ["uri", "path"]) {
        if (String(node[field] || "").includes("/Mori/Sync/Images/")) {
          node[field] = "";
          clearedCount += 1;
        }
      }
    }
    const binding = byNodeId.get(String(node.id));
    if (!binding) return;
    if (binding.assetId && String(node.assetId || "") !== String(binding.assetId)) return;
    node.uri = String(binding.uri);
    node.thumbnail = "";
    boundCount += 1;
  });
  if (boundCount || clearedCount) {
    saveBoard({ captureSync: false, markLocalChange: false });
    renderPlanner({ full: true });
  }
  return boundCount;
}

export function switchPlannerMode(mode) {
  const {
    page,
    libraryModeBtn,
    plannerModeBtn,
    viewport,
    toolbar,
    libraryToolbar,
    libraryViewport,
  } = plannerElements();
  if (!page) return;
  const planner = mode === "planner";
  const album = getActiveInspirationAlbumSnapshot();
  if (planner) ensurePlannerForActiveAlbum();
  const androidFullscreen = planner && isAndroidNative();
  document.documentElement.classList.toggle("planner-android-fullscreen", androidFullscreen);
  page.classList.toggle("planner-mode", planner);
  libraryModeBtn?.classList.toggle("active", !planner);
  plannerModeBtn?.classList.toggle("active", planner);
  toolbar?.classList.toggle("hidden", !planner || androidFullscreen);
  document.getElementById("plannerMobileControls")?.classList.toggle("hidden", !androidFullscreen);
  const mobileEdit = planner && isAndroidNative() && !board.readOnly;
  document.getElementById("plannerMobileAddTextBtn")?.classList.toggle("hidden", !mobileEdit && !androidLimitedWriteEnabled);
  document.getElementById("plannerMobileAddGroupBtn")?.classList.toggle("hidden", !mobileEdit);
  document.getElementById("plannerMobileClearBtn")?.classList.toggle("hidden", !mobileEdit);
  document.getElementById("plannerMobileAiLayoutBtn")?.classList.toggle("hidden", !planner);
  const desktopAiButton = document.getElementById("plannerAiLayoutBtn");
  if (desktopAiButton) desktopAiButton.disabled = false;
  viewport?.classList.toggle("hidden", !planner);
  libraryToolbar?.classList.toggle("hidden", planner);
  libraryViewport?.classList.toggle("hidden", planner);
  document.getElementById("inspirationSaveTodayBtn")?.classList.toggle("hidden", planner);
  document.getElementById("inspirationNewAlbumBtn")?.classList.toggle("hidden", planner);
  if (planner) {
    syncPendingActiveAlbumImages();
    renderPlanner();
    requestAnimationFrame(() => viewport?.focus({ preventScroll: true }));
  } else {
    renderInspiration();
  }
}

export function initPlanner() {
  try { repairAndroidPlannerAlbumBindings(); }
  catch (error) { console.warn("Could not repair old Android album bindings; keeping stored data:", error); }
  // Windows already has the compact native capture window and global hotkey.
  // Keep the in-canvas fallback only on platforms without that window.
  if (getTauriInvoke() && /Windows/i.test(navigator.userAgent)) {
    document.getElementById("plannerCaptureFrameBtn")?.remove();
  }
  bindMultiImageTransformControls();
  bindPlannerInteractions();
  if (!globalFrameListenerBound) {
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
      globalFrameListenerBound = true;
      listen("mori-global-frame-request", () => captureFrameWithSystemSnip()).catch((error) => {
        globalFrameListenerBound = false;
        console.warn("Could not bind global frame capture shortcut:", error);
      });
    }
  }
  document.getElementById("plannerExportPackageBtn")?.addEventListener("click", exportPlannerPackage);
  const lastExportPath = localStorage.getItem(LAST_EXPORT_PATH_KEY) || "";
  showPlannerExportResult(lastExportPath);
  document.getElementById("plannerExportPath")?.addEventListener("click", (event) => {
    copyPlannerExportPath(event.currentTarget.dataset.path || event.currentTarget.textContent || "");
  });
  document.getElementById("plannerOpenExportFolder")?.addEventListener("click", () => {
    const path = document.getElementById("plannerExportPath")?.dataset.path || "";
    openPlannerExportPath(path, false).catch((error) =>
      console.warn("Could not open planner export folder:", error),
    );
  });
  document.getElementById("plannerOpenExportFile")?.addEventListener("click", () => {
    const path = document.getElementById("plannerExportPath")?.dataset.path || "";
    openPlannerExportPath(path, true).catch((error) =>
      console.warn("Could not open planner export file:", error),
    );
  });
  document.getElementById("plannerImportPackageBtn")?.addEventListener("click", () => {
    const input = document.getElementById("plannerPackageInput");
    if (!input) return;
    input.value = "";
    input.click();
  });
  document.getElementById("plannerPackageInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importPlannerPackageFile(file);
    event.target.value = "";
  });
  document.getElementById("inspirationLibraryModeBtn")?.addEventListener("click", () =>
    switchPlannerMode("library"),
  );
  document.getElementById("inspirationPlannerModeBtn")?.addEventListener("click", () =>
    switchPlannerMode("planner"),
  );
  document.getElementById("inspirationAddAlbumToPlannerBtn")?.addEventListener("click", addAlbumToPlanner);
  document.getElementById("plannerAddTextBtn")?.addEventListener("click", () => {
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addTextAt(point.x, point.y);
  });
  document.getElementById("plannerAddGroupBtn")?.addEventListener("click", () => {
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addGroupAt(point.x - 260, point.y - 160);
  });
  document.getElementById("plannerFitBtn")?.addEventListener("click", fitAllContent);
  document.getElementById("plannerMobileAddTextBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addTextAt(point.x, point.y);
  });
  document.getElementById("plannerMobileAddGroupBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addGroupAt(point.x - 260, point.y - 160);
  });
  const addTextFromEmpty = (event) => {
    event.stopPropagation();
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addTextAt(point.x, point.y);
  };
  const addGroupFromEmpty = (event) => {
    event.stopPropagation();
    const { viewport } = plannerElements();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = viewportPointToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addGroupAt(point.x - 260, point.y - 160);
  };
  document.getElementById("plannerEmptyAddTextBtn")?.addEventListener("click", addTextFromEmpty);
  document.getElementById("plannerEmptyAddGroupBtn")?.addEventListener("click", addGroupFromEmpty);
  document.getElementById("plannerEmptyAddAlbumBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    addAlbumToPlanner();
  });
  document.getElementById("plannerMobileClearBtn")?.addEventListener("click", event => {
    event.stopPropagation();
    clearPlanner();
  });
  document.getElementById("plannerMobileZoomOutBtn")?.addEventListener("click", event => {
    event.stopPropagation();
    setPlannerZoom(board.view.zoom / 1.25);
  });
  document.getElementById("plannerMobileZoomInBtn")?.addEventListener("click", event => {
    event.stopPropagation();
    setPlannerZoom(board.view.zoom * 1.25);
  });
  document.getElementById("plannerMobileZoomLabel")?.addEventListener("click", event => {
    event.stopPropagation();
    const { viewport } = plannerElements();
    const rect = viewport?.getBoundingClientRect();
    setPlannerZoom(1, rect ? rect.left + rect.width / 2 : undefined, rect ? rect.top + rect.height / 2 : undefined);
  });
  document.getElementById("plannerMobileFitBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    fitAllContent();
  });
  document.getElementById("plannerMobileBackBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    switchPlannerMode("library");
  });
  document.getElementById("plannerMobileControls")?.addEventListener("pointerdown", (event) =>
    event.stopPropagation(),
  );
  for (const name of ["touchstart", "touchmove", "touchend"]) {
    document.getElementById("plannerMobileControls")?.addEventListener(name, event => {
      if (event.touches.length < 2) event.stopPropagation();
    }, { passive: true });
  }
  document.getElementById("plannerClearBtn")?.addEventListener("click", clearPlanner);
  document.getElementById("plannerCaptureFrameBtn")?.addEventListener("click", captureFrameWithSystemSnip);
  window.addEventListener("mori_file_saved", (event) => {
    const detail = event.detail || {};
    rememberPendingImageImport(detail);
    if (!isPlannerMode() || board.readOnly) return;
    setTimeout(() => {
      const added = syncPendingActiveAlbumImages();
      if (added) renderPlanner();
    }, 0);
  });
  window.addEventListener("mori_reference_frame_saved", (event) => {
    if (board.readOnly) return;
    const detail = event.detail || {};
    if (!detail.path && !detail.uri) return;
    const snapshot = getActiveInspirationAlbumSnapshot();
    const linked = board.nodes.some(
      (node) => node.type === "image" && node.albumId === snapshot.id,
    );
    const belongs =
      detail.albumId === snapshot.id ||
      snapshot.groups.some(
        (group) =>
          (detail.sourceUrl && group.sourceUrl === detail.sourceUrl) ||
          group.files.some((file) => (file.path || file.uri) === (detail.path || detail.uri)),
      );
    if (detail.forcePlanner || (linked && belongs)) {
      addReferenceFrameNode(
        { ...detail, albumId: snapshot.id },
        {
          render: isPlannerMode(),
          point: detail.forcePlanner ? plannerViewportCenterPoint() : null,
        },
      );
    }
  });
  document.getElementById("plannerSelectionDismiss")?.addEventListener("click", (event) => {
    event.stopPropagation();
    selectedNodeIds.clear();
    selectedEdgeId = null;
    updateSelectionUI();
  });
  document.getElementById("plannerSelectionGroup")?.addEventListener("click", (event) => {
    event.stopPropagation();
    createGroupAroundSelection();
  });
  document.getElementById("plannerSelectionDelete")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const androidSingleDelete =
      board.readOnly === true &&
      isAndroidNative() &&
      androidLimitedWriteEnabled && !board.localPackage &&
      !selectedEdgeId &&
      selectedNodeIds.size === 1;
    if (androidSingleDelete) {
      showConfirm(
        t("planner-delete-selected", { count: 1 }),
        t("confirm-msg-default"),
        () => deleteSelected(),
      );
      return;
    }
    deleteSelected();
  });
  document.getElementById("plannerRotationReset")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const range = document.getElementById("plannerRotationRange");
    if (range) range.value = "0";
    setSelectedImageRotation(0, { persist: true });
  });
  document.getElementById("plannerRotationRange")?.addEventListener("input", (event) => {
    event.stopPropagation();
    setSelectedImageRotation(event.target.value, { persist: false });
  });
  document.getElementById("plannerRotationRange")?.addEventListener("change", (event) => {
    event.stopPropagation();
    setSelectedImageRotation(event.target.value, { persist: true });
  });
  document.getElementById("plannerTextColor")?.addEventListener("input", (event) =>
    applyTextStyle("text", event.target.value),
  );
  document.getElementById("plannerCardColor")?.addEventListener("input", (event) =>
    applyTextStyle("background", event.target.value),
  );
  document.getElementById("plannerFontSize")?.addEventListener("input", (event) => {
    const value = Math.max(
      MIN_TEXT_FONT_SIZE,
      Math.min(MAX_TEXT_FONT_SIZE, Number(event.target.value) || DEFAULT_TEXT_FONT_SIZE),
    );
    const output = document.getElementById("plannerFontSizeValue");
    if (output) output.textContent = String(value);
    applyTextStyle("fontSize", value);
  });
  renderPlanner();
}

export function getFavoritePlannerTargets() {
  const index = loadPlannerIndex();
  return { activeId: activePlannerProjectId, items: Object.values(index.projects)
    .filter((project) => project?.projectId)
    .map((project) => ({ id: project.projectId, name: project.title || "未命名策划" })) };
}

export function insertFavoritesIntoPlanner(entries, projectId) {
  if (isAndroidNative() || !loadPlannerIndex().projects[projectId]) throw new Error("目标策划已不存在，请重新选择");
  const active = projectId === activePlannerProjectId;
  const target = active ? board : loadProjectBoard(projectId);
  if (!target || target.readOnly) throw new Error("目标策划无法编辑");
  const next = JSON.parse(JSON.stringify(target));
  const known = new Set(next.nodes.filter((node) => node.type === "image")
    .flatMap((node) => [node.path, node.uri, node.fileKey].filter(Boolean)).map(normalizePlannerFileKey));
  const point = active ? plannerViewportCenterPoint() : { x: 80, y: Math.max(0, ...next.nodes.map((node) => Number(node.y || 0) + Number(node.h || node.w || 240))) + 64 };
  let added = 0;
  for (const entry of entries) {
    const path = entry.path || entry.uri;
    if (!path) throw new Error("收藏图片缺少文件");
    const key = normalizePlannerFileKey(path);
    if (known.has(key)) continue;
    next.nodes.push({ id: id("image"), type: "image", fileKey: path, path: entry.path || "", uri: entry.uri || path,
      title: entry.title, sourceUrl: entry.sourceUrl || "", x: point.x + (added % 4) * 264,
      y: point.y + Math.floor(added / 4) * 300, w: 240, rotation: 0, comment: "", external: false });
    known.add(key); added += 1;
  }
  if (added) {
    // Persist before changing the active board. Selecting another target never
    // switches the user's current canvas or binds it to the current album.
    const key = plannerBoardStorageKey(projectId);
    const previous = localStorage.getItem(key);
    let written = false;
    try {
      localStorage.setItem(key, JSON.stringify(next)); written = true;
      const index = loadPlannerIndex();
      registerPlannerProject(index, next, null);
      savePlannerIndex(index);
    } catch (error) {
      if (written) {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      }
      throw error;
    }
    if (active) { board = next; plannerLocalGeneration += 1; }
    queuePlannerSyncCapture(JSON.parse(JSON.stringify(next)));
    if (active) renderPlanner();
  }
  return { added, skipped: entries.length - added };
}
