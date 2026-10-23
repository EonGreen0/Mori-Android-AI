import { showToast, Filesystem } from "../utils/index.js";
import { getActiveInspirationLibrarySnapshot, showImportedInspirationLibrary } from "./inspiration.js";
import { getAlbumPlannerPackageSnapshot, saveLocalAlbumPackagePlanner, switchPlannerMode } from "./planner.js";
import { preparePlannerImageAsset } from "../sync/assetCatalog.js";
import { SYNCED_ALBUMS_KEY } from "../sync/albumLibrary.js";
import { buildAlbumPackage, parseAlbumPackage, materializeAlbumPackage, MAX_ALBUM_PACKAGE_BYTES } from "./albumPackageFormat.js";

let busy = false;
function android() { return window.Capacitor?.getPlatform?.() === "android"; }
function invoke() { return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke; }
function status(message) { const el = document.getElementById("albumPackageStatus"); if (el) el.textContent = message; }
function setBusy(value) {
  busy = value;
  for (const id of ["albumPackageExportBtn", "albumPackageImportBtn"]) { const el = document.getElementById(id); if (el) el.disabled = value; }
}
function readLibraries() {
  const value = JSON.parse(localStorage.getItem(SYNCED_ALBUMS_KEY) || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地相册记录无法读取，未改动原数据");
  return value;
}
function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export async function exportCurrentAlbumPackage() {
  if (busy || !invoke() || android()) return;
  setBusy(true);
  try {
    const snapshot = getActiveInspirationLibrarySnapshot();
    const planner = getAlbumPlannerPackageSnapshot(snapshot.sourceAlbumId);
    const pack = await buildAlbumPackage(snapshot, planner, {
      readImage: async path => new Uint8Array(await invoke()("tauri_read_file_bytes", { path })),
      prepareImage: (bytes, filename) => preparePlannerImageAsset(bytes, { filename }), onProgress: status,
    });
    const name = snapshot.albums[0].name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "Mori相册";
    const filename = `${name}-${Date.now()}.mori-album`;
    status("正在保存相册包…");
    const path = await invoke()("tauri_save_bytes_file", { bytes: Array.from(pack.bytes), filename, folder: "Mori/AlbumPackages" });
    const shell = document.getElementById("albumPackageResult");
    shell.classList.remove("hidden");
    const button = document.getElementById("albumPackageOpenFolder"); button.dataset.path = path;
    document.getElementById("albumPackagePath").textContent = path;
    status(`已导出 ${pack.manifest.assets.length} 张图片${planner ? "和关联策划" : ""}，发到手机后导入即可`);
    showToast("相册包已保存");
    return { ...pack, path };
  } catch (error) { status(`导出失败：${error.message}`); showToast("相册导出失败，原内容已保留"); }
  finally { setBusy(false); }
}

export async function importLocalAlbumPackage(file) {
  if (!file || busy || !android()) return;
  setBusy(true);
  try {
    if (file.size > MAX_ALBUM_PACKAGE_BYTES) throw new Error("相册包超过 128 MB，请在电脑拆成较小相册后导出");
    status("正在读取相册包…");
    const { manifest, images } = parseAlbumPackage(new Uint8Array(await file.arrayBuffer()));
    readLibraries();
    // Decode every image before writing metadata or files. File paths and names are generated locally.
    for (const [i, bytes] of images.entries()) {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("包内图片格式无效");
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const valid = bitmap.width > 0 && bitmap.height > 0 && Math.max(bitmap.width, bitmap.height) <= 8192;
      bitmap.close(); if (!valid) throw new Error("包内图片尺寸无效");
      status(`正在检查图片 ${i + 1}/${images.length}…`);
    }
    const importId = crypto.randomUUID(), paths = new Map();
    for (const [i, asset] of manifest.assets.entries()) {
      status(`正在保存图片 ${i + 1}/${images.length}…`);
      const result = await Filesystem.writeFile({ path: `Mori/AlbumPackages/${importId}/${asset.id}.jpg`, directory: "DATA", data: base64(images[i]), recursive: true });
      if (!result?.uri) throw new Error("手机未返回保存路径，请检查存储空间");
      paths.set(asset.id, result.uri);
    }
    const imported = materializeAlbumPackage(manifest, paths, importId);
    const commit = () => {
      const libraries = readLibraries();
      if (libraries[imported.libraryId]) throw new Error("本地导入身份冲突，未替换已有相册");
      libraries[imported.libraryId] = imported.library;
      localStorage.setItem(SYNCED_ALBUMS_KEY, JSON.stringify(libraries));
    };
    if (imported.planner) saveLocalAlbumPackagePlanner(imported.planner, imported.albumId, commit); else commit();
    switchPlannerMode("library");
    showImportedInspirationLibrary(imported.library);
    status(`已导入“${manifest.album.name}”，可以离线查看${imported.planner ? "相册和策划" : "相册"}；旧相册已保留`);
    document.getElementById("albumMobileMenu")?.classList.add("hidden");
    showToast("本地相册导入完成");
    return imported;
  } catch (error) { status(`导入失败：${error.message}`); showToast("相册导入失败，原内容已保留"); }
  finally { setBusy(false); }
}

export function initAlbumPackageControls() {
  const controls = document.getElementById("albumPackageControls");
  if (!controls || controls.dataset.bound) return;
  controls.dataset.bound = "1";
  const phone = android();
  controls.classList.toggle("hidden", !phone && !invoke());
  document.getElementById("albumPackageExportBtn").classList.toggle("hidden", phone);
  document.getElementById("albumPackageImportBtn").classList.toggle("hidden", !phone);
  document.getElementById("albumPackageExportBtn").addEventListener("click", exportCurrentAlbumPackage);
  const input = document.getElementById("albumPackageInput");
  document.getElementById("albumPackageImportBtn").addEventListener("click", () => { input.value = ""; input.click(); });
  input.addEventListener("change", async () => { await importLocalAlbumPackage(input.files?.[0]); input.value = ""; });
  document.getElementById("albumPackageOpenFolder").addEventListener("click", async event => {
    try {
      const path = event.currentTarget.dataset.path || "";
      const folder = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
      await invoke()("tauri_open_url", { url: folder });
    } catch (_) { showToast("无法打开文件夹，可按导出路径查找相册包"); }
  });
  status(phone ? "选择电脑导出的 .mori-album 文件；每次导入保留为独立副本" : "导出当前相册及关联策划，无需同步密钥");
}
