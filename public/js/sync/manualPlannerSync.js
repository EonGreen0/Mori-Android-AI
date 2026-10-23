import { createCloudflareTransport } from "./cloudflareTransport.js";
import { preparePlannerImageAsset } from "./assetCatalog.js";
import { getOrCreateSyncDeviceId } from "./device.js";
import { listPlannerOutbox } from "./outbox.js";
import { pullAndMergePlannerRemoteState, pushPlannerOutboxOnce } from "./syncEngine.js";
import { createTauriAuthenticatedFetch } from "./tauriAuthenticatedFetch.js";
import {
  applyPlannerMergedSharedState,
  catalogCurrentPlannerImagesForSync,
  getPlannerManualSyncState,
  getPlannerSyncSnapshot,
  persistPlannerProjectIdentityAfterBackup,
  stageCurrentPlannerForManualSync,
} from "../modules/planner.js";

const TEST_WORKER = "https://mori-sync-gateway-test.pages.dev";
const MAX_PUSH_BATCHES = 30;
const MANUAL_PUSH_MUTATION_LIMIT = 10;
let syncBusy = false;

function nativeInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || null;
}

function syncElements() {
  return {
    button: document.getElementById("plannerManualSyncBtn"),
    status: document.getElementById("plannerManualSyncStatus"),
  };
}

function setStatus(text, state = "idle") {
  const { status } = syncElements();
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

function setBusy(value) {
  syncBusy = value;
  const { button } = syncElements();
  if (button) button.disabled = value;
}

function explainError(error) {
  const message = String(error?.message || error || "未知错误");
  if (message.includes("backup") || message.includes("备份")) return `备份失败：${message}`;
  if (message.includes("identity") || message.includes("project identity")) return `项目身份迁移失败：${message}`;
  if (message.includes("pending-outbox")) return "本地仍有待上传操作，已停止拉取，请重试同步";
  if (message.includes("changed") || message.includes("generation")) return "同步期间画布发生了新编辑，本次远端写回已取消，请再次同步";
  if (message.includes("Native sync") || message.includes("credential") || message.includes("http_") || message.includes("network")) return `网络/认证失败：${message}`;
  return `同步失败：${message}`;
}

function createTransport(invoke) {
  return createCloudflareTransport({
    id: "cloudflare-manual-windows-test",
    baseUrl: TEST_WORKER,
    nativeAuth: true,
    fetchImpl: createTauriAuthenticatedFetch(invoke),
  });
}

async function uploadMissingDisplayPreviews({ transport, shared, local, invoke, onProgress = setStatus, onError = null }) {
  const assetsById = new Map(
    (Array.isArray(shared?.assets) ? shared.assets : [])
      .filter((asset) => asset?.id)
      .map((asset) => [String(asset.id), asset]),
  );
  const candidates = new Map();
  let missingIdentityCount = 0;
  (Array.isArray(shared?.nodes) ? shared.nodes : []).forEach((node) => {
    if (node?.type !== "image") return;
    if (!node.assetId) {
      missingIdentityCount += 1;
      return;
    }
    const assetId = String(node.assetId);
    const localFile = local?.nodeFiles?.[node.id] || {};
    const path = String(localFile.path || localFile.uri || "");
    const current = candidates.get(assetId);
    if (!current || (!current.path && path)) candidates.set(assetId, { assetId, path });
  });
  const assetIds = [...candidates.keys()];
  if (!assetIds.length) return {
    uploadedCount: 0, presentCount: 0,
    skippedCount: missingIdentityCount, totalCount: missingIdentityCount,
  };

  const remoteStates = [];
  for (let offset = 0; offset < assetIds.length; offset += 100) {
    const remote = await transport.getAssetStates({ assetIds: assetIds.slice(offset, offset + 100) });
    remoteStates.push(...(Array.isArray(remote?.states) ? remote.states : []));
  }
  const states = new Map(
    remoteStates
      .filter((state) => state?.assetId)
      .map((state) => [String(state.assetId), state]),
  );

  let uploadedCount = 0;
  let presentCount = 0;
  let skippedCount = missingIdentityCount;
  let index = 0;
  for (const { assetId, path } of candidates.values()) {
    index += 1;
    const asset = assetsById.get(assetId);
    if (!asset) {
      skippedCount += 1;
      continue;
    }
    const state = states.get(assetId);
    if (state?.display === "present" && state.displayHash === asset.display?.hash) {
      presentCount += 1;
      continue;
    }
    if (!path) {
      skippedCount += 1;
      continue;
    }
    onProgress(`正在上传图片预览 ${index}/${assetIds.length}…`, "working");
    try {
      const fileBytes = await invoke("tauri_read_file_bytes", { path });
      if (!fileBytes?.length) {
        skippedCount += 1;
        continue;
      }
      const prepared = await preparePlannerImageAsset(new Uint8Array(fileBytes), {
        mime: asset.source?.mime || "",
        filename: path,
        // Existing assets keep their original display encoding, so retries do
        // not upload newly encoded bytes against an older display identity.
        legacyDisplay: !asset.display?.encoding,
        maxDisplaySide: asset.display?.encoding?.maxSide,
        displayQuality: asset.display?.encoding?.quality,
      });
      await transport.uploadDisplayAsset({
        asset,
        bytes: prepared.displayBytes,
        hash: asset.display?.hash || "",
        mime: asset.display?.mime || "",
      });
      uploadedCount += 1;
    } catch (error) {
      if (!onError || [401, 403].includes(Number(error?.status))) throw error;
      skippedCount += 1;
      onError(assetId, error);
    }
  }
  return { uploadedCount, presentCount, skippedCount, totalCount: assetIds.length + missingIdentityCount };
}

async function drainOutbox({ transport, projectId, deviceId }) {
  let submittedCount = 0;
  let acknowledgedCount = 0;
  for (let index = 0; index < MAX_PUSH_BATCHES; index += 1) {
    const result = await pushPlannerOutboxOnce({
      transport,
      projectId,
      deviceId,
      mutationLimit: MANUAL_PUSH_MUTATION_LIMIT,
    });
    if (result.status === "idle") {
      return { submittedCount, acknowledgedCount, batches: index };
    }
    submittedCount += Number(result.submittedCount) || 0;
    acknowledgedCount += Number(result.acknowledgedCount) || 0;
    if (result.status !== "ok") {
      if (result.rejected?.length && result.rejected.every((item) => item.code === "revision_conflict")) {
        return { submittedCount, acknowledgedCount, batches: index + 1, conflict: true };
      }
      const detail = result.error || result.rejected?.[0]?.message || result.status;
      throw new Error(`Outbox push stopped: ${detail}`);
    }
  }
  throw new Error("Outbox push exceeded the safety batch limit");
}

/**
 * One explicit manual sync transaction. Nothing calls this on startup or on
 * Planner save; the UI button is the only normal entry point.
 *
 * testHooks are intentionally narrow: they can stop at a boundary or perform a
 * controlled local edit, but they cannot skip backup, bypass native auth, or
 * replace the production merge/apply path.
 */
export async function runPlannerManualSync({ testHooks = null } = {}) {
  if (syncBusy) throw new Error("Manual sync is already running");
  const invoke = nativeInvoke();
  if (typeof invoke !== "function") throw new Error("Tauri native bridge is unavailable");

  setBusy(true);
  try {
    const available = await invoke("tauri_sync_available");
    if (!available) throw new Error("Personal sync credential is unavailable on this device");

    setStatus("正在创建安全备份…", "working");
    const initial = await getPlannerManualSyncState();
    if (initial.readOnly) throw new Error("Read-only Planner cannot be uploaded by manual sync");
    await testHooks?.beforeBackup?.(initial);
    const backup = await invoke("tauri_sync_manual_backup", { rawText: initial.rawText });
    if (!backup?.path || backup?.verified !== true || !Number.isFinite(Number(backup?.bytes))) {
      throw new Error("Native Planner backup did not return a verified receipt");
    }

    setStatus(initial.identityNeedsBackup ? "备份完成，正在建立项目身份…" : "备份完成，正在整理本地变更…", "working");
    const projectId = await persistPlannerProjectIdentityAfterBackup(initial.rawText, initial.projectId);
    if (!projectId) throw new Error("Planner project identity is unavailable after backup");

    setStatus("正在建立图片预览索引…", "working");
    const catalog = await catalogCurrentPlannerImagesForSync({
      expectedGeneration: initial.generation,
      expectedProjectId: projectId,
    });

    const deviceId = getOrCreateSyncDeviceId();
    const staged = await stageCurrentPlannerForManualSync({
      deviceId,
      expectedGeneration: catalog.generation,
      expectedProjectId: projectId,
    });
    if (staged.projectId !== projectId) throw new Error("Planner project identity changed during staging");
    await testHooks?.afterStage?.({ projectId, generation: staged.generation, backup });

    const transport = createTransport(invoke);
    let pulled = null;
    let totalReceived = 0;
    let totalConflicts = 0;
    let totalReconciliation = 0;
    const pushedTotals = { submittedCount: 0, acknowledgedCount: 0 };
    // Pull before upload: replacing the captured Outbox and checkpoint happens
    // atomically only after the merged board has been persisted successfully.
    for (let pass = 0; pass < 5; pass += 1) {
      const beforePull = await getPlannerSyncSnapshot({
        expectedGeneration: staged.generation,
        expectedProjectId: projectId,
      });
      if (beforePull.generation !== staged.generation) throw new Error("Planner changed before remote merge");
      if (pass === 0) await testHooks?.beforePull?.({ projectId, generation: staged.generation, backup });
      setStatus("正在拉取并合并云端变更…", "working");
      pulled = await pullAndMergePlannerRemoteState({
        transport, projectId, localShared: beforePull.shared, deviceId,
        rebasePendingOutbox: true,
        applyMergedShared: async (shared) => {
          await testHooks?.beforeApply?.({ projectId, generation: staged.generation });
          return applyPlannerMergedSharedState(shared, {
            expectedGeneration: staged.generation, expectedProjectId: projectId,
          });
        },
      });
      if (pulled.status !== "ok") throw new Error(
        `Remote merge blocked: ${pulled.reason || pulled.status}`,
      );
      totalReceived += pulled.receivedCount;
      totalConflicts += pulled.conflictCount;
      totalReconciliation += pulled.reconciliationCount;
      if (!pulled.reconciliationCount) break;
      if (pass === 4) throw new Error("其他设备仍在修改策划，请稍后再次同步；本地修改已保留");
      setStatus("正在上传合并后的修改…", "working");
      const pushed = await drainOutbox({ transport, projectId, deviceId });
      pushedTotals.submittedCount += pushed.submittedCount;
      pushedTotals.acknowledgedCount += pushed.acknowledgedCount;
    }
    const previewSnapshot = await getPlannerSyncSnapshot({
      expectedGeneration: staged.generation, expectedProjectId: projectId,
    });
    setStatus("正在同步图片预览…", "working");
    const previewSync = await uploadMissingDisplayPreviews({
      transport, shared: previewSnapshot.shared, local: previewSnapshot.local, invoke,
    });
    const pending = await listPlannerOutbox({ projectId, limit: 1 });
    if (pending.length) throw new Error("Manual sync finished with pending Outbox operations");

    const result = {
      status: "ok",
      projectId,
      backupPath: backup.path,
      backupBytes: Number(backup.bytes) || 0,
      initialMutations: staged.mutations.length,
      submittedCount: pushedTotals.submittedCount,
      receivedCount: totalReceived,
      conflictCount: totalConflicts,
      reconciliationCount: totalReconciliation,
      cursor: pulled.cursor,
      generation: staged.generation,
      previewUploadedCount: previewSync.uploadedCount,
      previewAvailableCount: previewSync.uploadedCount + (previewSync.presentCount || 0),
      previewTotalCount: previewSync.totalCount || 0,
      previewSkippedCount: previewSync.skippedCount,
      previewCataloguedCount: catalog.cataloguedCount,
      previewCatalogSkippedCount: catalog.skippedCount,
    };
    const previewNote = result.previewTotalCount
      ? ` · 云端图片预览 ${result.previewAvailableCount}/${result.previewTotalCount}`
      : "";
    const incompleteNote = previewSync.skippedCount
      ? ` · ${previewSync.skippedCount} 张待补齐，请检查本地图片文件与资源索引`
      : "";
    setStatus(`已同步 · revision ${result.cursor ?? "-"}${previewNote}${incompleteNote}`,
      previewSync.skippedCount ? "warning" : "success");
    window.dispatchEvent(new CustomEvent("mori_planner_manual_sync_complete", { detail: result }));
    return result;
  } catch (error) {
    const message = explainError(error);
    setStatus(message, "error");
    window.dispatchEvent(new CustomEvent("mori_planner_manual_sync_failed", { detail: { message } }));
    throw error;
  } finally {
    setBusy(false);
  }
}

export async function initPlannerManualSync() {
  const { button } = syncElements();
  if (!button || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  if (window.Capacitor?.getPlatform?.() === "android") {
    button.classList.add("hidden");
    const status = syncElements().status;
    status?.classList.add("hidden");
    return;
  }
  const invoke = nativeInvoke();
  if (typeof invoke !== "function") {
    button.disabled = true;
    setStatus("当前平台未配置云同步", "idle");
    return;
  }
  let available = false;
  try {
    available = await invoke("tauri_sync_available");
  } catch (_) {}
  if (!available) {
    button.disabled = true;
    setStatus("当前设备未配置个人同步密钥", "idle");
    return;
  }
  setStatus("仅手动 · 点击后先备份再同步", "idle");
  button.addEventListener("click", () => {
    runPlannerManualSync().catch((error) => console.warn("Planner manual sync stopped:", error));
  });
}

export { uploadMissingDisplayPreviews };
