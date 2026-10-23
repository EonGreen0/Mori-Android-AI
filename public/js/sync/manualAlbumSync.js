import { createCloudflareTransport } from "./cloudflareTransport.js";
import { createTauriAuthenticatedFetch } from "./tauriAuthenticatedFetch.js";
import { androidReadOnlySyncAvailable, createAndroidReadOnlyAuthenticatedFetch } from "./androidAuthenticatedFetch.js";
import { getOrCreateSyncDeviceId } from "./device.js";
import { preparePlannerImageAsset } from "./assetCatalog.js";
import { putPlannerAsset } from "./assetStore.js";
import { splitPlannerBoardForSync } from "./plannerAdapter.js";
import { getPlannerSyncCheckpoint, plannerCheckpointKey } from "./plannerJournal.js";
import { diffPlannerSyncEnvelopes } from "./mutations.js";
import { getPlannerSyncMeta, setPlannerSyncMeta, stagePlannerSyncChanges, listPlannerOutbox } from "./outbox.js";
import { pullAndMergePlannerRemoteState, pushPlannerOutboxOnce, pullPlannerRemoteStateReadOnly } from "./syncEngine.js";
import { uploadMissingDisplayPreviews, runPlannerManualSync } from "./manualPlannerSync.js";
import { cachePlannerDisplayPreviews, initAndroidAlbumPlannerControls, uploadAndroidAlbumPlannerChanges, assertAndroidAlbumPlannerCanDownload } from "./androidPlannerReadOnlySync.js";
import { getAlbumPlannerProject, getPlannerSyncSnapshot, getSavedPlannerSyncSnapshot, saveAndroidAlbumPlanner, switchPlannerMode, setAndroidLimitedWriteEnabled } from "../modules/planner.js";
import { androidPlannerWriteSyncAvailable } from "./androidAuthenticatedFetch.js";
import { ALBUM_LIBRARY_PREFIX, isAlbumLibraryProject, createAlbumLibraryBoard, importedAlbumLibrary, saveImportedAlbumLibrary } from "./albumLibrary.js";
import { getActiveInspirationLibrarySnapshot, getActiveInspirationAlbumSnapshot, showImportedInspirationLibrary } from "../modules/inspiration.js";
import { showConfirm } from "../modules/modals.js";

const BASE_URL = "https://mori-sync-gateway-test.pages.dev";
const DIRECTORY_KEY = "mori_android_album_directory_v1";
let busy = false;

function elements() {
  return {
    controls: document.getElementById("albumCloudControls"),
    select: document.getElementById("albumCloudProject"),
    reload: document.getElementById("albumCloudReloadBtn"),
    button: document.getElementById("albumCloudSyncBtn"),
    rebuild: document.getElementById("albumCloudRebuildBtn"),
    backup: document.getElementById("albumCloudBackupBtn"),
    status: document.getElementById("albumCloudStatus"),
  };
}

function setStatus(text, state = "idle") {
  const { status } = elements();
  if (status) { status.textContent = text; status.dataset.state = state; }
  const mobile = document.getElementById("plannerMobileSyncStatus");
  if (mobile) { mobile.textContent = text; mobile.dataset.state = state; mobile.classList.remove("hidden"); }
}

function setBusy(value) {
  busy = value;
  const { button, reload, select, rebuild, backup } = elements();
  if (button) button.disabled = value || (!select?.classList.contains("hidden") && !select?.value);
  if (reload) reload.disabled = value;
  if (select) select.disabled = value || !select.options.length;
  if (rebuild) rebuild.disabled = value || !select?.value;
  if (backup) backup.disabled = value;
  if (window.Capacitor?.getPlatform?.() === "android") {
    const canWrite = androidPlannerWriteSyncAvailable();
    setAndroidLimitedWriteEnabled(!value && canWrite);
    for (const id of ["plannerMobileUploadChangesBtn", "plannerMobileAddTextBtn"]) {
      const button = document.getElementById(id);
      if (button) button.disabled = value || !canWrite;
    }
  }
}

async function drainAlbumOutbox(transport, projectId, deviceId, onProgress) {
  const pending = await listPlannerOutbox({ projectId, all: true });
  const maxBatches = Math.ceil(pending.length / 25) + 1;
  let uploaded = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    onProgress(`正在上传相册记录 ${Math.min(uploaded, pending.length)}/${pending.length}…`, "working");
    const result = await pushPlannerOutboxOnce({ transport, projectId, deviceId, mutationLimit: 25 });
    if (result.status === "idle") return;
    uploaded += result.acknowledgedCount || 0;
    if (result.status !== "ok") {
      if (result.rejected?.length && result.rejected.every(item => item.code === "revision_conflict")) return;
      throw new Error(result.error || result.rejected?.[0]?.message || "相册上传未全部确认");
    }
  }
  throw new Error("相册记录仍有待上传内容，请重试");
}

// The PC library owns this project. Remote reconciliation never overwrites
// local history, albums, assignments or original files.
export async function uploadAlbumLibrary({ snapshot, transport, invoke, deviceId, plannerProjectId = "", onProgress = () => {} }) {
  const projectKey = snapshot.sourceAlbumId ? `album_group_project_id_v1:${snapshot.sourceAlbumId}` : "album_library_project_id_v1";
  let projectId = await getPlannerSyncMeta(projectKey, "");
  if (!projectId) {
    projectId = `${ALBUM_LIBRARY_PREFIX}${deviceId}${snapshot.sourceAlbumId ? `:${encodeURIComponent(snapshot.sourceAlbumId)}` : ""}`;
    await setPlannerSyncMeta(projectKey, projectId);
  }
  const previous = await getPlannerSyncCheckpoint(projectId);
  const identitiesKey = `album_library_identities_v1:${projectId}`;
  const catalog = await createAlbumLibraryBoard(snapshot, {
    projectId, previous, identities: await getPlannerSyncMeta(identitiesKey, {}), plannerProjectId,
    sourceLibraryId: `${ALBUM_LIBRARY_PREFIX}${deviceId}`,
    onProgress: (index, total) => onProgress(`正在压缩相册图片 ${index}/${total}…`, "working"),
    resolveAsset: async file => {
      const path = file.path || file.uri;
      const bytes = await invoke("tauri_read_file_bytes", { path });
      const prepared = await preparePlannerImageAsset(new Uint8Array(bytes || []), { filename: path });
      if (prepared.asset.display.mime !== "image/jpeg") throw new Error("图片无法转换为 JPG");
      await putPlannerAsset(prepared.asset);
      return prepared.asset;
    },
  });
  await setPlannerSyncMeta(identitiesKey, catalog.identities);
  const { shared, local } = splitPlannerBoardForSync(catalog.board);
  shared.assets = catalog.assets;
  const mutations = diffPlannerSyncEnvelopes(previous, shared, { deviceId });
  await stagePlannerSyncChanges({ mutations, checkpointKey: plannerCheckpointKey(projectId), checkpointValue: shared });
  let working = shared;
  let merged;
  for (let pass = 0; pass < 5; pass++) {
    onProgress("正在核对云端相册记录…", "working");
    merged = await pullAndMergePlannerRemoteState({
      transport, projectId, localShared: working, deviceId, rebasePendingOutbox: true, maxPages: 1000,
      applyMergedShared: next => { working = next; return next; },
    });
    if (merged.status !== "ok") throw new Error(merged.reason || "相册同步未完成");
    if (!merged.reconciliationCount) break;
    if (pass === 4) throw new Error("相册仍有并发修改，请稍后重试");
    await drainAlbumOutbox(transport, projectId, deviceId, onProgress);
  }
  const previewFailures = [];
  const preview = await uploadMissingDisplayPreviews({ transport, shared: working, local, invoke, onProgress,
    onError: (assetId, error) => previewFailures.push({ assetId, message: String(error?.message || error) }),
  });
  if ((await listPlannerOutbox({ projectId, limit: 1 })).length) throw new Error("相册仍有待上传记录");
  return { projectId, cursor: merged.cursor, albumCount: snapshot.albums.length, preview, previewFailures, catalogFailures: catalog.failures };
}

export async function downloadAlbumLibrary({ transport, projectId, onProgress = () => {}, onPlannerSynced = () => {} }) {
  if (!isAlbumLibraryProject(projectId)) throw new Error("请选择云端相册资料库");
  let library, preview, plannerPreview;
  onProgress("正在读取云端相册…", "working");
  const result = await pullPlannerRemoteStateReadOnly({
    transport, projectId, maxPages: 1000,
    applyRemoteShared: async shared => {
      const parsed = importedAlbumLibrary(shared);
      if (parsed.plannerProjectId) {
        // Resolve the associated plan from the cloud album before checking for
        // edits. Older phones can have this plan without any scoped album yet.
        onProgress("正在同步手机上的策划修改…", "working");
        await uploadAndroidAlbumPlannerChanges({ id: parsed.albums[0].id, plannerProjectId: parsed.plannerProjectId });
        onPlannerSynced();
        await assertAndroidAlbumPlannerCanDownload(parsed.plannerProjectId);
      }
      preview = await cachePlannerDisplayPreviews(transport, shared, { onProgress });
      if (parsed.plannerProjectId) {
        onProgress("正在同步相册内的策划和图片…", "working");
        const plannerResult = await pullPlannerRemoteStateReadOnly({
          transport, projectId: parsed.plannerProjectId, maxPages: 1000,
          applyRemoteShared: async plannerShared => {
            if (isAlbumLibraryProject(plannerShared.project.id)) throw new Error("相册关联策划身份无效");
            plannerPreview = await cachePlannerDisplayPreviews(transport, plannerShared, { onProgress });
            saveAndroidAlbumPlanner(plannerShared, plannerPreview.bindings, parsed.albums[0].id,
              () => { library = saveImportedAlbumLibrary(shared, preview.bindings); });
            return (await getSavedPlannerSyncSnapshot(plannerShared.project.id)).shared;
          },
        });
        if (plannerResult.status !== "ok") throw new Error(plannerResult.reason || "相册策划下载未完成");
      } else library = saveImportedAlbumLibrary(shared, preview.bindings);
      return shared;
    },
  });
  if (result.status !== "ok") throw new Error(result.reason || "相册下载未完成");
  return { ...result, library, preview, plannerPreview };
}

function saveDirectory() {
  const { select } = elements();
  try {
    localStorage.setItem(DIRECTORY_KEY, JSON.stringify({ baseUrl: BASE_URL, selectedId: select.value,
      projects: [...select.options].map(option => ({ id: option.value, title: option.textContent })),
    }));
  } catch (_) { /* The visible directory remains usable when storage is full. */ }
}

function renderDirectory(projects, preferredId = elements().select?.value) {
  const { select } = elements();
  if (!select) return;
  select.replaceChildren(...projects.filter(project => isAlbumLibraryProject(project.id)).map(project => {
    const option = document.createElement("option");
    option.value = project.id; option.textContent = project.title || "相册资料库";
    return option;
  }));
  if ([...select.options].some(option => option.value === preferredId)) select.value = preferredId;
}

async function reloadDirectory(transport) {
  if (busy) return;
  setBusy(true);
  setStatus("正在读取云端相册列表…", "working");
  try {
    const result = await transport.listProjects({ limit: 200 });
    if (!Array.isArray(result?.projects)) throw new Error("云端相册目录响应无效");
    renderDirectory(result.projects.filter(project => isAlbumLibraryProject(project.id || project.projectId))
      .map(project => ({ id: project.id || project.projectId, title: `${project.title || "相册资料库"} · r${project.revision ?? "-"}` })));
    saveDirectory();
    setStatus(elements().select.options.length ? "点击同步，将图片和收藏帧下载到手机" : "请先在电脑上传相册", "idle");
  } catch (error) {
    setStatus(`列表读取失败：${String(error.message || error)}。可点击刷新重试`, "error");
  } finally { setBusy(false); }
}

export async function initManualAlbumSync() {
  const { controls, select, reload, button } = elements();
  if (!controls || !button || button.dataset.bound) return;
  button.dataset.bound = "1";
  const android = window.Capacitor?.getPlatform?.() === "android";
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (!android && typeof invoke !== "function") return;
  controls.classList.remove("hidden");
  select.classList.toggle("hidden", !android);
  reload.classList.toggle("hidden", !android);
  button.textContent = android ? "同步所选相册" : "同步当前相册";
  let recovery;
  if (android) {
    initAndroidAlbumPlannerControls();
    recovery = await import("./androidAlbumRecovery.js");
    for (const [id, title] of [["albumCloudRebuildBtn", "按电脑重建"], ["albumCloudBackupBtn", "导出旧内容备份"]]) {
      const control = document.createElement("button");
      control.id = id; control.type = "button"; control.textContent = title;
      controls.insertBefore(control, elements().status);
    }
    elements().backup.classList.toggle("hidden", !recovery.getLastAndroidAlbumRecoveryBackup());
  }
  let available = android ? androidReadOnlySyncAvailable() : false;
  if (!android) { try { available = await invoke("tauri_sync_available"); } catch (_) {} }
  if (!available) {
    button.disabled = true; reload.disabled = true; select.disabled = true;
    if (elements().rebuild) elements().rebuild.disabled = true;
    setStatus("当前设备未配置个人同步密钥");
    return;
  }
  const transport = createCloudflareTransport({
    id: android ? "cloudflare-albums-android" : "cloudflare-albums-windows", baseUrl: BASE_URL, nativeAuth: true,
    fetchImpl: android ? createAndroidReadOnlyAuthenticatedFetch() : createTauriAuthenticatedFetch(invoke),
  });
  const syncSelected = async (rebuild = false, selectedId = select.value) => {
    if (busy) return;
    if (android) document.activeElement?.blur?.();
    setBusy(true);
    try {
      if (android) {
        const inPlanner = document.getElementById("inspirationPage")?.classList.contains("planner-mode");
        const result = rebuild
          ? await recovery.rebuildAndroidAlbumFromCloud({ transport, projectId: selectedId, onProgress: setStatus })
          : await downloadAlbumLibrary({ transport, projectId: selectedId, onProgress: setStatus, onPlannerSynced: () => setBusy(true) });
        showImportedInspirationLibrary(result.library);
        if (inPlanner) switchPlannerMode("planner");
        const preview = result.plannerPreview ? {
          ...result.preview, failures: [...result.preview.failures, ...result.plannerPreview.failures],
          missingCount: result.preview.missingCount + result.plannerPreview.missingCount,
          bindings: [...result.preview.bindings, ...result.plannerPreview.bindings],
          nodeCount: result.preview.nodeCount + result.plannerPreview.nodeCount,
          reusedCount: result.preview.reusedCount + result.plannerPreview.reusedCount,
        } : result.preview;
        const detail = preview.failures.length ? ` · ${preview.failures.length} 张未完成（${[...new Set(preview.failures.map(failure => failure.reason))].slice(0, 2).join("、")}），重试会补下` : "";
        setStatus(`${rebuild ? "已备份旧内容并按电脑重建" : "已同步相册"}${result.library.plannerProjectId ? "与策划" : "（暂无策划）"} · 本地图片 ${preview.bindings.length}/${preview.nodeCount} · 复用 ${preview.reusedCount}${detail}`,
          preview.missingCount ? "warning" : "success");
      } else {
        const snapshot = getActiveInspirationLibrarySnapshot();
        const assertAlbum = () => {
          if (JSON.stringify(getActiveInspirationLibrarySnapshot()) !== JSON.stringify(snapshot)) throw new Error("同步期间相册发生修改或切换，请重新同步");
        };
        const planner = getAlbumPlannerProject(snapshot.sourceAlbumId);
        let plannerResult;
        if (planner) {
          setStatus("正在同步相册内的策划…", "working");
          plannerResult = await runPlannerManualSync();
          assertAlbum();
          if (plannerResult.projectId !== planner.projectId) throw new Error("相册关联的策划发生变化，请重试");
        }
        const result = await uploadAlbumLibrary({ snapshot, transport, invoke,
          plannerProjectId: planner?.projectId || "",
          deviceId: getOrCreateSyncDeviceId(), onProgress: setStatus });
        assertAlbum();
        if (plannerResult) await getPlannerSyncSnapshot({ expectedProjectId: planner.projectId, expectedGeneration: plannerResult.generation });
        const available = result.preview.uploadedCount + result.preview.presentCount;
        const failures = result.catalogFailures.length;
        const incomplete = result.preview.skippedCount ? ` · ${result.preview.skippedCount} 张参考图待补齐，可重试` : "";
        const detail = result.previewFailures.length ? `（${result.previewFailures[0].message}）` : "";
        const plannerIncomplete = plannerResult?.previewSkippedCount || 0;
        setStatus(`已同步“${snapshot.albums[0].name}”${planner ? "及策划" : "（暂无策划）"} · 云端相册图片 ${available}/${result.preview.totalCount}${incomplete}${detail}${plannerIncomplete ? ` · 策划有 ${plannerIncomplete} 张图片待补齐` : ""}${failures ? ` · ${failures} 张本地文件读取失败，请检查原文件` : ""}`,
          result.preview.skippedCount || failures || plannerIncomplete ? "warning" : "success");
      }
    } catch (error) {
      setStatus(`相册同步失败：${String(error?.message || error)}，可重新点击同步`, "error");
      console.warn("Album manual sync stopped:", error);
    } finally {
      if (android) elements().backup.classList.toggle("hidden", !recovery.getLastAndroidAlbumRecoveryBackup());
      setBusy(false);
    }
  };
  button.addEventListener("click", () => syncSelected());
  if (android) {
    elements().rebuild.addEventListener("click", () => {
      if (busy || !select.value) return;
      const selectedId = select.value;
      showConfirm("按电脑内容重建所选相册", "请先在电脑同步这一组。手机旧策划和待上传记录将保存备份，随后用电脑上传的相册及策划替换这一组。其他相册和本地图片保留。", () => syncSelected(true, selectedId));
    });
    elements().backup.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      try { await recovery.exportLastAndroidAlbumRecoveryBackup(); }
      catch (error) { setStatus(`备份导出未完成：${error?.message || error}`, "error"); }
      finally { setBusy(false); }
    });
    try {
      const cached = JSON.parse(localStorage.getItem(DIRECTORY_KEY) || "null");
      if (cached?.baseUrl === BASE_URL && Array.isArray(cached.projects)) renderDirectory(cached.projects, cached.selectedId);
    } catch (_) {}
    select.addEventListener("change", saveDirectory);
    window.addEventListener("mori_album_selected", event => {
      const id = event.detail?.syncProjectId;
      if (id && [...select.options].some(option => option.value === id)) { select.value = id; saveDirectory(); }
    });
    window.addEventListener("mori_album_sync_requested", () => {
      const album = getActiveInspirationAlbumSnapshot();
      if (!album.syncProjectId || ![...select.options].some(option => option.value === album.syncProjectId)) {
        setStatus("请先在相册页选择并同步电脑上传的相册", "error");
        return;
      }
      select.value = album.syncProjectId;
      button.click();
    });
    reload.addEventListener("click", () => reloadDirectory(transport));
    await reloadDirectory(transport);
  } else {
    setBusy(false);
    setStatus("同步当前相册的图片、视频链接、收藏帧和关联策划");
  }
}
