import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

const plannerSource = await readFile(new URL("../public/js/modules/planner.js", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = plannerSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Could not find production declaration ${startMarker}`);
  const end = plannerSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Could not find production boundary ${endMarker}`);
  return plannerSource.slice(start, end);
}

const productionFunctions = [
  sourceBetween("function plannerBoardStorageKey(", "\nfunction loadPlannerIndex("),
  sourceBetween("function loadPlannerIndex(", "\nfunction savePlannerIndex("),
  sourceBetween("function savePlannerIndex(", "\nfunction inferLegacyAlbumId("),
  sourceBetween("function registerPlannerProject(", "\nfunction migrateLegacyPlannerIfNeeded("),
  sourceBetween("function loadProjectBoard(", "\nexport function getAlbumPlannerProject("),
  sourceBetween("function activatePlannerBoard(", "\nfunction ensurePlannerForActiveAlbum("),
  sourceBetween("function ensurePlannerForActiveAlbum(", "\nfunction plannerSyncCaptureEnabled("),
  sourceBetween("function normalizeBoardForPersistence(", "\nfunction saveBoard("),
  sourceBetween("function saveBoard(", "\nfunction loadPendingImageImports("),
  sourceBetween("function safePackageName(", "\nasync function loadPlannerImage("),
  sourceBetween("export function switchPlannerMode(", "\nexport function initPlanner(").replace(/^export /, ""),
].join("\n");

const MAGIC = "MORI-PLAN-1\n";
const PACKAGE_VERSION = 1;
const PROJECT_INDEX_KEY = "mori_planner_projects_v2";
const BOARD_PREFIX = "mori_planner_board_v2:";

class MemoryStorage {
  constructor(entries = [], { failBackupWrites = false } = {}) {
    this.values = new Map(entries);
    this.failBackupWrites = failBackupWrites;
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    const normalizedKey = String(key);
    if (this.failBackupWrites && normalizedKey.startsWith("mori_planner_package_import_backup_v1:")) {
      throw new Error("QuotaExceededError");
    }
    this.values.set(normalizedKey, String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  entries() {
    return [...this.values.entries()];
  }
}

function plannerIndex(projects = {}, activeProjectByAlbum = {}) {
  return JSON.stringify({ version: 2, projects, activeProjectByAlbum });
}

function makePackage({ projectId, title, nodes = [], edges = [], assets = [] }, payloads = []) {
  const manifestAssets = assets.map((asset, index) => ({
    id: asset.id,
    filename: asset.filename,
    mime: asset.mime || "image/jpeg",
    offset: payloads.slice(0, index).reduce((sum, bytes) => sum + bytes.length, 0),
    length: payloads[index].length,
    originalBytes: payloads[index].length,
    source: { bytes: payloads[index].length, mime: asset.mime || "image/jpeg" },
    display: { bytes: payloads[index].length, mime: asset.mime || "image/jpeg", ext: "jpg" },
  }));
  const manifest = {
    format: "mori-planner-package",
    version: PACKAGE_VERSION,
    createdAt: "2026-09-30T00:00:00.000Z",
    project: { id: projectId, title },
    board: {
      nodes,
      edges,
      view: { zoom: 1, panX: 0, panY: 0 },
      importCount: 0,
      commentFontSize: 17,
    },
    assets: manifestAssets,
  };
  const magicBytes = new TextEncoder().encode(MAGIC);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const payloadLength = payloads.reduce((sum, bytes) => sum + bytes.length, 0);
  const output = new Uint8Array(magicBytes.length + 4 + manifestBytes.length + payloadLength);
  let cursor = 0;
  output.set(magicBytes, cursor);
  cursor += magicBytes.length;
  new DataView(output.buffer).setUint32(cursor, manifestBytes.length, true);
  cursor += 4;
  output.set(manifestBytes, cursor);
  cursor += manifestBytes.length;
  payloads.forEach((bytes) => {
    output.set(bytes, cursor);
    cursor += bytes.length;
  });
  return output;
}

function asArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function makeHarness({
  board,
  projectIndex = plannerIndex(),
  storageEntries = [],
  failBackupWrites = false,
  invoke,
  prepareAsset,
} = {}) {
  const localStorage = new MemoryStorage(storageEntries, { failBackupWrites });
  localStorage.setItem(PROJECT_INDEX_KEY, projectIndex);
  const confirms = [];
  const toasts = [];
  const projectBoardLoads = [];
  let plannerElementsCalls = 0;
  const uiElement = { classList: { toggle() {} }, focus() {} };
  const context = {
    board: structuredClone(board || {
      nodes: [],
      edges: [],
      view: { zoom: 1, panX: 0, panY: 0 },
      importCount: 0,
      commentFontSize: 17,
      projectId: "project_B",
      projectTitle: "Project B",
    }),
    activePlannerProjectId: board?.projectId || "project_B",
    activePlannerAlbumId: "album_B",
    plannerLocalGeneration: 1,
    selectedNodeIds: new Set(),
    selectedEdgeId: null,
    connectingEdge: null,
    semanticCollapsedGroupIds: new Set(),
    semanticHiddenNodeIds: new Set(),
    BOARD_KEY_PREFIX: BOARD_PREFIX,
    PROJECT_INDEX_KEY,
    MORI_PACKAGE_MAGIC: MAGIC,
    MORI_PACKAGE_VERSION: PACKAGE_VERSION,
    PLANNER_SYNC_FOLDER: "Mori/PlannerSync",
    LAST_EXPORT_PATH_KEY: "mori_planner_last_export_path_v1",
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    localStorage,
    window: {
      confirm(message) {
        confirms.push(String(message));
        return true;
      },
      prompt() {
        return null;
      },
    },
    document: {
      documentElement: { classList: { toggle() {} } },
      getElementById() {
        return { textContent: "", disabled: false, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} };
      },
    },
    console: { warn() {}, error() {}, log() {} },
    confirms,
    toasts,
    projectBoardLoads,
    t(key) {
      if (key === "planner-import-replace-confirm") return "导入会替换当前策划，是否继续？";
      if (key === "planner-default-project-title") return "Untitled Plan";
      if (key === "planner-imported-package") return "imported";
      if (key === "planner-imported-readonly") return "imported read only";
      if (key === "planner-import-package-failed") return "import failed";
      return key;
    },
    id(prefix) {
      context.nextId = (context.nextId || 0) + 1;
      return `${prefix}_test_${context.nextId}`;
    },
    showToast(message) {
      toasts.push(message);
    },
    getTauriInvoke() {
      return invoke || (async () => "saved-file-path");
    },
    safeExternalFilename(filename) {
      return filename;
    },
    isAndroidNative() {
      return false;
    },
    bytesToBase64() {
      return "";
    },
    imageTypeFromBytes() {
      return { mime: "image/jpeg" };
    },
    guessMime() {
      return "image/jpeg";
    },
    preparePlannerImageAsset: prepareAsset || (async (bytes, options) => ({
      asset: {
        id: options.filename === "path_A.jpg" ? "asset_A" : "asset_other",
        source: { bytes: bytes.length, mime: "image/jpeg" },
        display: { bytes: 3, mime: "image/jpeg", ext: "jpg" },
      },
      displayBytes: new Uint8Array([41, 42, 43]),
    })),
    createPlannerAssetLocalBinding(assetId, fields) {
      return { assetId, ...fields };
    },
    plannerAssetFromPackageEntry(asset, bytes) {
      return { id: asset.id, bytes: bytes.length, source: asset.source, display: asset.display };
    },
    async putPlannerAsset() {},
    normalizeCommentFontSize(value) {
      return Number(value) || 17;
    },
    normalizeStoredBoard(parsed, options) {
      if (parsed) projectBoardLoads.push(options.projectId);
      return parsed;
    },
    migrateLegacyPlannerIfNeeded(index) {
      return index;
    },
    getActiveInspirationAlbumSnapshot() {
      return { id: "album_B", name: "Album B" };
    },
    isDefaultPlannerProjectTitle(value) {
      return !value || value === "Untitled Plan" || value === "未命名策划";
    },
    normalizeRotation(value) {
      return Number(value) || 0;
    },
    normalizeImageCommentScale(value) {
      return Number(value) || 1;
    },
    normalizeGroupLabelScale(value) {
      return Number(value) || 1;
    },
    plannerSyncCaptureEnabled() {
      return false;
    },
    revokePlannerObjectUrls() {},
    renderPlanner() {},
    syncPlannerProjectUI() {},
    syncPendingActiveAlbumImages() {},
    plannerElements() {
      plannerElementsCalls += 1;
      return {
        page: uiElement,
        libraryModeBtn: uiElement,
        plannerModeBtn: uiElement,
        viewport: uiElement,
        toolbar: uiElement,
        libraryToolbar: uiElement,
        libraryViewport: uiElement,
      };
    },
    requestAnimationFrame() {},
    fitAllContent() {},
  };
  vm.createContext(context);
  vm.runInContext(productionFunctions, context, { filename: "planner-package-production.js" });
  return {
    context,
    localStorage,
    confirms,
    toasts,
    projectBoardLoads,
    get plannerElementsCalls() { return plannerElementsCalls; },
  };
}

function packageBoardForA() {
  return makePackage({
    projectId: "project_A",
    title: "Plan A from package",
    nodes: [{ id: "old_A", type: "text", text: "stale package copy" }],
  });
}

{
  const originalA = JSON.stringify({
    nodes: [{ id: "unique_A", type: "text", text: "unsynced local work" }],
    edges: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    importCount: 0,
    commentFontSize: 17,
    projectId: "project_A",
    projectTitle: "Existing Plan A",
  });
  const originalB = JSON.stringify({
    nodes: [],
    edges: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    importCount: 0,
    commentFontSize: 17,
    projectId: "project_B",
    projectTitle: "Project B",
  });
  const harness = makeHarness({
    board: JSON.parse(originalB),
    projectIndex: plannerIndex(
      {
        project_A: { projectId: "project_A", title: "Existing Plan A", albumIds: ["album_A"] },
        project_B: { projectId: "project_B", title: "Project B", albumIds: ["album_B"] },
      },
      { album_A: "project_A", album_B: "project_B" },
    ),
    storageEntries: [
      [`${BOARD_PREFIX}project_A`, originalA],
      [`${BOARD_PREFIX}project_B`, originalB],
    ],
  });
  const { context, localStorage, confirms, projectBoardLoads } = harness;

  await context.importPlannerPackageFile({ arrayBuffer: async () => asArrayBuffer(packageBoardForA()) });

  assert.equal(confirms.length, 1, "existing target A must be confirmed while empty B is active");
  assert.match(confirms[0], /project_A/);
  assert.match(confirms[0], /Existing Plan A/);
  assert.match(confirms[0], /本地策划/);
  assert.doesNotMatch(confirms[0], /Target project:/);
  const backup = localStorage.entries().find(([key]) => key.startsWith(
    "mori_planner_package_import_backup_v1:project_A:",
  ));
  assert.ok(backup, "the old target board should have a localStorage backup");
  assert.equal(backup[1], originalA, "the backup must preserve the exact prior raw value");
  assert.equal(JSON.parse(localStorage.getItem(`${BOARD_PREFIX}project_A`)).nodes[0].id, "old_A");
  assert.equal(localStorage.getItem(`${BOARD_PREFIX}project_B`), originalB, "active B remains untouched");
  assert.equal(context.board.projectId, "project_A");
  assert.equal(context.activePlannerAlbumId, "album_B");
  assert.equal(
    JSON.parse(localStorage.getItem(PROJECT_INDEX_KEY)).activeProjectByAlbum.album_B,
    "project_A",
    "the selected album should intentionally activate imported project A",
  );
  assert.ok(projectBoardLoads.includes("project_A"), "the real switch/ensure path should reload A from storage");
  assert.ok(harness.plannerElementsCalls > 0, "the production switchPlannerMode path should run");
}

{
  const originalA = JSON.stringify({
    nodes: [{ id: "unique_A", type: "text", text: "keep me" }],
    edges: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    projectId: "project_A",
    projectTitle: "Existing Plan A",
  });
  const originalB = JSON.stringify({
    nodes: [], edges: [], view: { zoom: 1, panX: 0, panY: 0 },
    projectId: "project_B", projectTitle: "Project B",
  });
  const { context, localStorage } = makeHarness({
    board: JSON.parse(originalB),
    storageEntries: [[`${BOARD_PREFIX}project_A`, originalA]],
    failBackupWrites: true,
  });

  await context.importPlannerPackageFile({ arrayBuffer: async () => asArrayBuffer(packageBoardForA()) });

  assert.equal(localStorage.getItem(`${BOARD_PREFIX}project_A`), originalA);
  assert.equal(context.board.projectId, "project_B");
  assert.equal(
    localStorage.entries().some(([key]) => key.startsWith("mori_planner_package_import_backup_v1:")),
    false,
  );
}

{
  let releaseAssetSave;
  let assetSaveStarted;
  const started = new Promise((resolve) => { assetSaveStarted = resolve; });
  const delayedSave = new Promise((resolve) => { releaseAssetSave = resolve; });
  const originalA = JSON.stringify({
    nodes: [{ id: "unique_A", type: "text", text: "keep if active context changes" }],
    edges: [], view: { zoom: 1, panX: 0, panY: 0 }, projectId: "project_A", projectTitle: "Existing A",
  });
  const originalB = JSON.stringify({
    nodes: [], edges: [], view: { zoom: 1, panX: 0, panY: 0 }, projectId: "project_B", projectTitle: "Project B",
  });
  const bytes = makePackage({
    projectId: "project_A",
    title: "Plan A package",
    nodes: [{ id: "image_A", type: "image", assetId: "asset_A", title: "A" }],
    assets: [{ id: "asset_A", filename: "A.jpg" }],
  }, [new Uint8Array([1, 2, 3, 4])]);
  const { context, localStorage } = makeHarness({
    board: JSON.parse(originalB),
    storageEntries: [[`${BOARD_PREFIX}project_A`, originalA], [`${BOARD_PREFIX}project_B`, originalB]],
    invoke: async (command) => {
      if (command === "tauri_save_bytes_file") {
        assetSaveStarted();
        return delayedSave;
      }
      return "unexpected-command";
    },
  });

  const importing = context.importPlannerPackageFile({ arrayBuffer: async () => asArrayBuffer(bytes) });
  await started;
  const boardC = {
    nodes: [{ id: "new_C", type: "text", text: "user switched projects" }],
    edges: [], view: { zoom: 1, panX: 0, panY: 0 }, projectId: "project_C", projectTitle: "Project C",
  };
  context.activatePlannerBoard(boardC, "album_C");
  releaseAssetSave("saved-A-asset.jpg");
  await importing;

  assert.equal(localStorage.getItem(`${BOARD_PREFIX}project_A`), originalA);
  assert.equal(localStorage.getItem(`${BOARD_PREFIX}project_B`), originalB);
  assert.equal(context.board.projectId, "project_C");
  assert.ok(localStorage.entries().some(([key, value]) =>
    key.startsWith("mori_planner_package_import_backup_v1:project_A:") && value === originalA,
  ));
}

{
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const delayedRead = new Promise((resolve) => { releaseRead = resolve; });
  const imageBytes = new Uint8Array([7, 8, 9, 10]);
  const originalA = {
    nodes: [{ id: "image_A", type: "image", title: "A reference", path: "path_A.jpg", uri: "uri_A", assetId: "", fileKey: "", comment: "A snapshot" }],
    edges: [{ id: "edge_A", from: "image_A", to: "note_A" }],
    view: { zoom: 0.7, panX: 30, panY: 40 },
    importCount: 2,
    commentFontSize: 18,
    projectId: "project_A",
    projectTitle: "Title A",
  };
  const originalB = {
    nodes: [{ id: "image_B", type: "image", title: "B reference", path: "path_B.jpg", assetId: "", fileKey: "" }],
    edges: [], view: { zoom: 1, panX: 0, panY: 0 }, importCount: 0, commentFontSize: 17,
    projectId: "project_B", projectTitle: "Title B",
  };
  const { context, localStorage } = makeHarness({
    board: originalA,
    projectIndex: plannerIndex(
      { project_A: { projectId: "project_A", title: "Title A", albumIds: ["album_A"] } },
      { album_A: "project_A" },
    ),
    storageEntries: [[`${BOARD_PREFIX}project_A`, JSON.stringify(originalA)]],
    invoke: async (command, options) => {
      if (command === "tauri_read_file_bytes" && options.path === "uri_A") {
        readStarted();
        return delayedRead;
      }
      throw new Error(`Unexpected read: ${command} ${options.path}`);
    },
    prepareAsset: async (bytes) => ({
      asset: {
        id: "asset_from_A",
        source: { bytes: bytes.length, mime: "image/jpeg" },
        display: { bytes: 3, mime: "image/jpeg", ext: "jpg" },
      },
      displayBytes: new Uint8Array([51, 52, 53]),
    }),
  });
  const liveA = context.board;

  const building = context.buildPlannerPackage("Title A");
  await started;
  context.activatePlannerBoard(originalB, "album_B");
  const liveB = context.board;
  const storedB = JSON.stringify({
    nodes: originalB.nodes,
    edges: originalB.edges,
    view: originalB.view,
    importCount: originalB.importCount,
    commentFontSize: originalB.commentFontSize,
    projectId: originalB.projectId,
    projectTitle: originalB.projectTitle,
  });
  localStorage.setItem(`${BOARD_PREFIX}project_B`, storedB);
  releaseRead(Array.from(imageBytes));
  const pack = await building;

  assert.equal(pack.manifest.project.id, "project_A");
  assert.equal(pack.manifest.project.title, "Title A");
  assert.equal(pack.manifest.board.nodes[0].id, "image_A");
  assert.equal(pack.manifest.board.nodes[0].assetId, "asset_from_A");
  assert.equal(pack.manifest.board.edges[0].from, "image_A");
  assert.equal(pack.manifest.assets[0].id, "asset_from_A");
  const parsed = context.parsePlannerPackage(pack.bytes);
  assert.deepEqual(
    Array.from(parsed.data.subarray(parsed.payloadStart + pack.manifest.assets[0].offset, parsed.payloadStart + pack.manifest.assets[0].offset + pack.manifest.assets[0].length)),
    [51, 52, 53],
  );
  assert.equal(liveA.nodes[0].assetId, "", "the background export must not write identities into the old board");
  assert.equal(liveB, context.board, "the active B board must remain active");
  assert.equal(context.board.nodes[0].id, "image_B");
  assert.equal(context.board.nodes[0].assetId, "");
  assert.equal(localStorage.getItem(`${BOARD_PREFIX}project_B`), storedB);
}

{
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const delayedRead = new Promise((resolve) => { releaseRead = resolve; });
  const original = {
    nodes: [{ id: "image_A", type: "image", title: "A reference", path: "path_A.jpg", uri: "uri_A", assetId: "", fileKey: "", comment: "snapshot comment" }],
    edges: [], view: { zoom: 1, panX: 0, panY: 0 }, importCount: 0, commentFontSize: 17,
    projectId: "project_A", projectTitle: "Title A",
  };
  const { context } = makeHarness({
    board: original,
    invoke: async (command) => {
      if (command === "tauri_read_file_bytes") {
        readStarted();
        return delayedRead;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    prepareAsset: async (bytes) => ({
      asset: { id: "asset_from_A", source: { bytes: bytes.length }, display: { bytes: 3, mime: "image/jpeg", ext: "jpg" } },
      displayBytes: new Uint8Array([61, 62, 63]),
    }),
  });

  const building = context.buildPlannerPackage("Title A");
  await started;
  context.board.nodes[0].comment = "edited while export waits";
  context.plannerLocalGeneration += 1;
  releaseRead([11, 12, 13]);
  const pack = await building;

  assert.equal(pack.manifest.board.nodes[0].comment, "snapshot comment");
  assert.equal(context.board.nodes[0].comment, "edited while export waits");
  assert.equal(context.board.nodes[0].assetId, "", "export must not save snapshot identities over a live edit");
}

console.log("Planner package safety verification passed.");
