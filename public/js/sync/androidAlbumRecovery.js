import { Filesystem, Share } from "../utils/index.js";
import { openPlannerSyncDb, PLANNER_SYNC_STORES } from "./database.js";
import { fetchPlannerRemoteChanges } from "./syncEngine.js";
import { createPlannerRemoteShadow, applyPlannerRemoteChanges, materializePlannerRemoteShadow } from "./remoteMerge.js";
import { remoteStateKey } from "./remoteMergeStore.js";
import { plannerCheckpointKey } from "./plannerJournal.js";
import { listPlannerOutbox } from "./outbox.js";
import { isAlbumLibraryProject, importedAlbumLibrary, saveImportedAlbumLibrary, SYNCED_ALBUMS_KEY } from "./albumLibrary.js";
import { cachePlannerDisplayPreviews } from "./androidPlannerReadOnlySync.js";
import { saveAndroidAlbumPlanner, normalizeAndroidPlannerSyncCheckpoint, settleAndroidPlannerEdits, refreshAndroidPlannerFromStorage } from "../modules/planner.js";

const BACKUP_DIRECTORY = "Mori/Sync/Recovery/";
const LAST_BACKUP_KEY = "mori_android_album_recovery_backup_v1";
const INDEX_KEY = "mori_planner_projects_v2";

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function operationsText(operations) {
  return JSON.stringify([...operations].sort((a, b) => String(a.opId).localeCompare(String(b.opId))));
}

function encodeText(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

function decodeText(data) {
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(data), char => char.charCodeAt(0)));
}

export async function readAndroidAlbumRecoveryBackup(path) {
  if (!String(path || "").startsWith(BACKUP_DIRECTORY) || path.includes("..")) throw new Error("旧内容备份路径无效");
  const result = await Filesystem.readFile({ path, directory: "DATA" });
  const backup = JSON.parse(decodeText(result.data));
  if (backup.format !== "mori-album-recovery" || backup.version !== 1 || !isAlbumLibraryProject(backup.projectId)) {
    throw new Error("旧内容备份格式无效");
  }
  return backup;
}

export function getLastAndroidAlbumRecoveryBackup() {
  try { return JSON.parse(localStorage.getItem(LAST_BACKUP_KEY) || "null"); } catch { return null; }
}

export async function exportLastAndroidAlbumRecoveryBackup() {
  const saved = getLastAndroidAlbumRecoveryBackup();
  if (!saved?.path || !Share) throw new Error("当前没有可导出的旧内容备份");
  const backup = await readAndroidAlbumRecoveryBackup(saved.path);
  const path = `Mori/Recovery/${saved.path.split("/").pop()}`;
  // Android's share provider exposes CACHE. Keep the verified original in DATA.
  await Filesystem.writeFile({ path, directory: "CACHE", data: encodeText(JSON.stringify(backup)), recursive: true });
  const file = await Filesystem.getUri({ path, directory: "CACHE" });
  await Share.share({ title: "Mori 手机旧内容备份", files: [file.uri], dialogTitle: "保存旧内容备份" });
}

// Read from revision zero without committing any cursor or touching the old
// Outbox. Only the explicit recovery action may replace these pending edits.
async function readRemote(transport, projectId) {
  let shadow = createPlannerRemoteShadow(projectId), cursor = null;
  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    const page = await fetchPlannerRemoteChanges({ transport, projectId, cursor, limit: 200 });
    shadow = applyPlannerRemoteChanges(shadow, page.changes, { projectId }).shadow;
    if (page.hasMore && page.cursor === cursor) throw new Error("云端下载未能推进，请重试");
    cursor = page.cursor;
    if (!page.hasMore) {
      if (!shadow.records.project || shadow.records.project.deleted) throw new Error("云端相册或策划已不存在，保留手机旧内容");
      return { projectId, cursor, shadow, shared: materializePlannerRemoteShadow(shadow) };
    }
  }
  throw new Error("云端记录过多，本次未替换手机内容");
}

export async function rebuildAndroidAlbumFromCloud({ transport, projectId, onProgress = () => {} }) {
  if (window.Capacitor?.getPlatform?.() !== "android" || !isAlbumLibraryProject(projectId)) throw new Error("请在手机选择电脑上传的相册");
  if (!Filesystem) throw new Error("手机备份功能不可用，未替换旧内容");
  await settleAndroidPlannerEdits();
  onProgress("正在完整读取电脑上传的相册与策划…", "working");
  const album = await readRemote(transport, projectId);
  const parsed = importedAlbumLibrary(album.shared);
  if (!parsed.sourceAlbumId || parsed.albums.length !== 1) throw new Error("请先在电脑按当前相册重新上传，再重建手机内容");
  const plan = parsed.plannerProjectId ? await readRemote(transport, parsed.plannerProjectId) : null;
  if (plan && isAlbumLibraryProject(plan.projectId)) throw new Error("相册关联策划身份无效");
  const states = [album, ...(plan ? [plan] : [])];
  const ids = new Set(states.map(state => state.projectId));
  const rawStorage = {
    [INDEX_KEY]: localStorage.getItem(INDEX_KEY),
    [SYNCED_ALBUMS_KEY]: localStorage.getItem(SYNCED_ALBUMS_KEY),
    ...(plan ? { [`mori_planner_board_v2:${plan.projectId}`]: localStorage.getItem(`mori_planner_board_v2:${plan.projectId}`) } : {}),
  };
  const operations = (await listPlannerOutbox({ all: true })).filter(op => ids.has(op.projectId));
  const db = await openPlannerSyncDb();
  const metadataKeys = states.flatMap(state => [plannerCheckpointKey(state.projectId), remoteStateKey(transport.id, state.projectId)]);
  const metaRead = db.transaction(PLANNER_SYNC_STORES.META, "readonly").objectStore(PLANNER_SYNC_STORES.META);
  const metadata = (await Promise.all(metadataKeys.map(key => requestValue(metaRead.get(key))))).filter(Boolean);
  const backup = { format: "mori-album-recovery", version: 1, createdAt: new Date().toISOString(),
    projectId, plannerProjectId: plan?.projectId || "", rawStorage, operations, metadata };
  onProgress("正在下载并核对这一组的全部图片…", "working");
  const preview = await cachePlannerDisplayPreviews(transport, album.shared, { onProgress });
  const plannerPreview = plan ? await cachePlannerDisplayPreviews(transport, plan.shared, { onProgress }) : null;
  if (preview.missingCount || plannerPreview?.missingCount) throw new Error("电脑上传的图片尚未下载完整，保留手机旧内容；请先在电脑补齐同步");
  onProgress("正在保存手机旧策划和待上传记录的备份…", "working");
  const path = `${BACKUP_DIRECTORY}${Date.now()}-${crypto.randomUUID()}.json`;
  const text = JSON.stringify(backup);
  await Filesystem.writeFile({ path, directory: "DATA", data: encodeText(text), recursive: true });
  const readBack = await Filesystem.readFile({ path, directory: "DATA" });
  if (decodeText(readBack.data) !== text) throw new Error("手机旧内容备份未保存完整，未替换任何记录");
  const savedBackup = { path, projectId, title: parsed.albums[0].name, createdAt: backup.createdAt };
  // Remember the recovery file before replacing anything. A full localStorage
  // must stop recovery rather than leave a backup the user cannot find.
  localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(savedBackup));
  for (const [key, value] of Object.entries(rawStorage)) {
    if (localStorage.getItem(key) !== value) throw new Error("备份期间手机内容发生变化，未替换；请重试");
  }
  let library, writtenStorage = null;
  onProgress("旧内容已备份，正在按电脑内容重建这一组…", "working");
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([PLANNER_SYNC_STORES.OUTBOX, PLANNER_SYNC_STORES.META, PLANNER_SYNC_STORES.ASSETS], "readwrite");
      let failure;
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(failure || transaction.error);
      transaction.onabort = () => reject(failure || transaction.error || new Error("手机重建事务未完成"));
      const outbox = transaction.objectStore(PLANNER_SYNC_STORES.OUTBOX);
      const check = outbox.getAll();
      check.onsuccess = () => {
        try {
          if (operationsText(check.result.filter(op => ids.has(op.projectId))) !== operationsText(operations)) {
            throw new Error("备份期间新增了手机修改，未替换；请重试");
          }
          for (const [key, value] of Object.entries(rawStorage)) {
            if (localStorage.getItem(key) !== value) throw new Error("备份期间手机相册发生变化，未替换；请重试");
          }
          if (plan) {
            saveAndroidAlbumPlanner(plan.shared, plannerPreview.bindings, parsed.albums[0].id,
              () => { library = saveImportedAlbumLibrary(album.shared, preview.bindings); });
            plan.shared = normalizeAndroidPlannerSyncCheckpoint(plan.shared);
          } else library = saveImportedAlbumLibrary(album.shared, preview.bindings);
          writtenStorage = Object.fromEntries(Object.keys(rawStorage).map(key => [key, localStorage.getItem(key)]));
          const meta = transaction.objectStore(PLANNER_SYNC_STORES.META);
          const assets = transaction.objectStore(PLANNER_SYNC_STORES.ASSETS);
          for (const state of states) {
            meta.put({ key: plannerCheckpointKey(state.projectId), value: state.shared });
            meta.put({ key: remoteStateKey(transport.id, state.projectId), value: { transportId: transport.id,
              projectId: state.projectId, cursor: state.cursor, shadow: state.shadow, conflicts: [], updatedAt: Date.now() } });
            for (const asset of state.shared.assets) assets.put(asset);
          }
          // Exact backed-up operations only. Other albums and their edits stay.
          for (const operation of operations) outbox.delete(operation.opId);
        } catch (error) { failure = error; transaction.abort(); }
      };
    });
  } catch (error) {
    if (writtenStorage) {
      for (const [key, value] of Object.entries(rawStorage)) {
        if (localStorage.getItem(key) !== writtenStorage[key]) continue;
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
      }
      if (plan) refreshAndroidPlannerFromStorage(plan.projectId);
    }
    throw new Error(`${error?.message || error}；旧内容备份已保留`);
  }
  return { library, preview, plannerPreview, backup: savedBackup };
}
