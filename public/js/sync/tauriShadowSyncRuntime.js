import { preparePlannerImageAsset } from "./assetCatalog.js";
import { getPlannerAssetsByIds, putPlannerAsset } from "./assetStore.js";
import { createCloudflareTransport } from "./cloudflareTransport.js";
import { stagePlannerBoardForSync, snapshotPlannerBoardForSync } from "./plannerJournal.js";
import { createPlannerRemoteShadow, applyPlannerRemoteChanges, materializePlannerRemoteShadow } from "./remoteMerge.js";
import { pullAndMergePlannerRemoteState, pushPlannerOutboxOnce } from "./syncEngine.js";
import { listPlannerOutbox } from "./outbox.js";
import { stableStringify } from "./mutations.js";
import { createTauriAuthenticatedFetch } from "./tauriAuthenticatedFetch.js";

const BOARD_KEY = "mori_planner_board_v1";
const SHADOW_ID_KEY = "mori_planner_shadow_project_id_v1";
const TEST_WORKER = "https://mori-sync-gateway-test.pages.dev";
const DEVICE_ID = "windows-shadow-test";

const prepareButton = document.getElementById("prepareShadow");
const uploadButton = document.getElementById("uploadShadow");
const result = document.getElementById("shadowResult");
const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
let prepared = null;

function assert(value, message) {
  if (!value) throw new Error(message);
}

function canonical(shared) {
  const sort = (items) => [...(items || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { ...shared, nodes: sort(shared.nodes), edges: sort(shared.edges), assets: sort(shared.assets) };
}

function mismatchCount(expected, actual) {
  let count = stableStringify(expected.project) === stableStringify(actual.project) ? 0 : 1;
  for (const name of ["nodes", "edges", "assets"]) {
    const left = new Map(expected[name].map((item) => [item.id, item]));
    const right = new Map(actual[name].map((item) => [item.id, item]));
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      if (stableStringify(left.get(id)) !== stableStringify(right.get(id))) count += 1;
    }
  }
  return count;
}

function transport() {
  return createCloudflareTransport({
    id: "cloudflare-shadow-test",
    baseUrl: TEST_WORKER,
    nativeAuth: true,
    fetchImpl: createTauriAuthenticatedFetch(invoke),
  });
}

async function fillMissingAssetMetadata(board) {
  const imageNodes = board.nodes.filter((node) => node?.type === "image" && node.assetId);
  const ids = [...new Set(imageNodes.map((node) => node.assetId))];
  const existing = new Set((await getPlannerAssetsByIds(ids)).map((asset) => asset.id));
  const missing = imageNodes.filter((node) => !existing.has(node.assetId));
  const additions = new Map();
  for (const node of missing) {
    assert(node.path || node.uri, "Referenced image has no local file");
    const bytes = new Uint8Array(await invoke("tauri_read_file_bytes", { path: node.uri || node.path }));
    const candidate = await preparePlannerImageAsset(bytes, { filename: node.path || node.uri || "" });
    assert(candidate.asset.id === node.assetId, "Referenced image assetId differs from local file");
    additions.set(candidate.asset.id, candidate.asset);
  }
  for (const asset of additions.values()) await putPlannerAsset(asset);
  const complete = await getPlannerAssetsByIds(ids);
  assert(complete.length === ids.length, "Image metadata catalog is incomplete");
  return { references: imageNodes.length, uniqueAssets: ids.length, metadataBackfilled: additions.size };
}

async function prepare() {
  assert(typeof invoke === "function", "Tauri bridge is unavailable");
  const rawText = localStorage.getItem(BOARD_KEY);
  assert(rawText, "Planner Board is absent");
  const parsed = JSON.parse(rawText);
  assert(Array.isArray(parsed.nodes) && Array.isArray(parsed.edges), "Planner Board shape is invalid");
  // This native command writes and reads back the D: backup before any cloud request.
  const backup = await invoke("tauri_sync_shadow_backup", { rawText });
  assert(backup?.path && backup?.verified === true, "Native Board backup failed");
  const savedId = localStorage.getItem(SHADOW_ID_KEY);
  assert(!savedId || /^mori-shadow-personal-[0-9a-f-]{36}$/.test(savedId), "Existing shadow Project ID is invalid");
  const projectId = savedId || `mori-shadow-personal-${crypto.randomUUID()}`;
  const board = { ...parsed, projectId, projectTitle: parsed.projectTitle || "Mori Shadow Test" };
  const assets = await fillMissingAssetMetadata(board);
  const snapshot = await snapshotPlannerBoardForSync(board);
  assert(snapshot.shared.assets.length === assets.uniqueAssets, "Snapshot dropped referenced Asset metadata");
  assert(localStorage.getItem(BOARD_KEY) === rawText, "Planner Board changed during preparation");
  // A separate, non-secret key makes retries stable without editing the Board key.
  localStorage.setItem(SHADOW_ID_KEY, projectId);
  return { rawText, board, snapshot, backup, assets, projectId };
}

async function rebuildFromCloud(t, projectId) {
  let shadow = createPlannerRemoteShadow(projectId);
  let cursor = "0";
  for (let page = 0; page < 20; page++) {
    const result = await t.pullChanges({ projectId, cursor, limit: 200 });
    shadow = applyPlannerRemoteChanges(shadow, result.changes, { projectId }).shadow;
    if (!result.hasMore) return { shared: materializePlannerRemoteShadow(shadow), revision: Number(result.cursor) || 0 };
    assert(result.cursor !== cursor, "Cloud cursor did not advance");
    cursor = result.cursor;
  }
  throw new Error("Cloud rebuild exceeded page limit");
}

async function upload(preparedState) {
  assert(localStorage.getItem(BOARD_KEY) === preparedState.rawText, "Planner Board changed after backup; stop and prepare again");
  const { projectId, board, snapshot, assets, backup } = preparedState;
  const t = transport();
  const existing = await t.pullChanges({ projectId, cursor: "0", limit: 1 });
  const pendingBefore = await listPlannerOutbox({ projectId, limit: 1 });
  // A remotely populated project without a local checkpoint is ambiguous.
  if (existing.changes.length && !pendingBefore.length) {
    const localCheckpoint = await import("./plannerJournal.js").then((module) => module.getPlannerSyncCheckpoint(projectId));
    assert(localCheckpoint, "Cloud shadow project exists without a local checkpoint; refusing first upload");
  }
  const staged = await stagePlannerBoardForSync(board, { deviceId: DEVICE_ID });
  assert(stableStringify(canonical(staged.shared)) === stableStringify(canonical(snapshot.shared)), "Shared snapshot changed during staging");
  let submitted = 0;
  for (let batch = 0; batch < 20; batch++) {
    const pushed = await pushPlannerOutboxOnce({ transport: t, projectId, deviceId: DEVICE_ID });
    if (pushed.status === "idle") break;
    assert(pushed.status === "ok", `Shadow push stopped: ${pushed.status}`);
    submitted += pushed.submittedCount;
  }
  assert((await listPlannerOutbox({ projectId, limit: 1 })).length === 0, "Shadow Outbox is not empty");
  const rebuilt = await rebuildFromCloud(t, projectId);
  const mismatches = mismatchCount(canonical(snapshot.shared), canonical(rebuilt.shared));
  if (mismatches !== 0) {
    const error = new Error(`Cloud round-trip mismatch count: ${mismatches}`);
    error.mismatches = mismatches;
    throw error;
  }
  let shadowApplied = null;
  const merged = await pullAndMergePlannerRemoteState({
    transport: t, projectId, localShared: snapshot.shared, deviceId: DEVICE_ID,
    applyMergedShared: async (shared) => { shadowApplied = shared; },
  });
  assert(merged.status === "ok" && shadowApplied, "Isolated shadow merge failed");
  assert(mismatchCount(canonical(snapshot.shared), canonical(shadowApplied)) === 0, "Isolated shadow merge differs from source");
  assert(merged.reconciliationCount === 0, "Shadow merge generated reconciliation mutations");
  const restaged = await stagePlannerBoardForSync(board, { deviceId: DEVICE_ID });
  assert(restaged.mutations.length === 0, "Repeated shadow staging generated duplicate mutations");
  assert(localStorage.getItem(BOARD_KEY) === preparedState.rawText, "Planner Board changed during shadow upload");
  return {
    status: "PASS", projectId, backupPath: backup.path, backupBytes: Number(backup.bytes) || 0,
    nodes: snapshot.shared.nodes.length, edges: snapshot.shared.edges.length,
    groups: snapshot.shared.nodes.filter((node) => node.type === "group").length,
    assetReferences: assets.references, assetMetadata: snapshot.shared.assets.length,
    displayUploaded: false,
    initialMutations: staged.mutations.length, submittedMutations: submitted,
    remoteRevision: rebuilt.revision, mismatches, repeatMutations: restaged.mutations.length,
    reconciliationCount: merged.reconciliationCount, boardUnchanged: true,
  };
}

prepareButton?.addEventListener("click", async () => {
  prepareButton.disabled = true;
  uploadButton.disabled = true;
  result.textContent = "正在备份并检查本地 Board；尚未上传…";
  try {
    prepared = await prepare();
    result.textContent = JSON.stringify({ status: "READY", projectId: prepared.projectId,
      backupPath: prepared.backup.path, backupBytes: Number(prepared.backup.bytes) || 0,
      nodes: prepared.snapshot.shared.nodes.length, edges: prepared.snapshot.shared.edges.length,
      assetReferences: prepared.assets.references, metadataBackfilled: prepared.assets.metadataBackfilled }, null, 2);
    uploadButton.disabled = false;
  } catch (error) {
    prepared = null;
    result.textContent = JSON.stringify({ status: "STOPPED_BEFORE_UPLOAD", error: String(error?.message || error) }, null, 2);
  } finally {
    prepareButton.disabled = false;
  }
});

uploadButton?.addEventListener("click", async () => {
  if (!prepared) return;
  uploadButton.disabled = true;
  prepareButton.disabled = true;
  result.textContent = "正在手动 shadow upload 和隔离重建；不会写回本地 Board…";
  let succeeded = false;
  try {
    result.textContent = JSON.stringify(await upload(prepared), null, 2);
    succeeded = true;
  } catch (error) {
    result.textContent = JSON.stringify({ status: "STOPPED", projectId: prepared.projectId,
      error: String(error?.message || error), mismatches: error?.mismatches ?? null,
      boardUnchanged: localStorage.getItem(BOARD_KEY) === prepared.rawText }, null, 2);
  } finally {
    prepareButton.disabled = false;
    uploadButton.disabled = !succeeded;
  }
});

document.getElementById("closeShadow")?.addEventListener("click", () => window.close());
