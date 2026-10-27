// inspiration.js — zoomable visual reference board built from downloaded history
import { t } from "../i18n/index.js";
import { showToast, Filesystem, triggerHaptic } from "../utils/index.js";
import { showConfirm, showInfoModal } from "./modals.js";
import { showActionSheet } from "../ui/actionSheet.js";
import { cleanUrl } from "../utils/urlUtils.js";
import { loadAndroidLocalImage } from "../utils/localImage.js";
import { getImportedAlbumLibraries } from "../sync/albumLibrary.js";
import { preparePlannerImageAsset } from "../sync/assetCatalog.js";
import { fileAssignmentKey } from "./imageFileIdentity.js";
import { listAiFileAnalyses } from "./aiStore.js";
import { initMobileInspiration, renderMobileInspiration, showMobileAlbumDetail, isMobileInspiration,
  isMobileAlbumOverview, isMobileAlbumCanvas, openMobileAlbumPreview } from "./inspirationMobile.js";

const ALBUMS_KEY = "mori_inspiration_albums";
const ASSIGNMENTS_KEY = "mori_inspiration_link_albums";
const FAVORITE_REFS_KEY = "mori_inspiration_favorite_refs_v1";
const FRAME_FOLDER = "Mori/Frames";

let activeAlbumId = "today";
let zoom = 1;
let panX = 24;
let panY = 24;
let boardBound = false;
let imageObserver = null;
let aiFileAnalyses = new Map();
let aiPoseFilter = "all";
const objectUrls = new Set();

function aiPoseLabel(code) {
  return t(`ai-pose-${String(code || "other").replaceAll("_", "-")}`);
}

export function getAiAnalysisForFile(file) {
  return aiFileAnalyses.get(fileAssignmentKey(file))?.analysis || null;
}

export async function refreshAiFileAnalyses({ render = true } = {}) {
  try {
    const records = await listAiFileAnalyses();
    aiFileAnalyses = new Map(records.map(record => [record.fileKey, record]));
  } catch (error) {
    console.warn("AI file analyses unavailable:", error);
    aiFileAnalyses = new Map();
  }
  if (render) renderInspiration();
  return aiFileAnalyses;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function loadAlbums() {
  const albums = safeJson(ALBUMS_KEY, []);
  return [...(Array.isArray(albums) ? albums : []),
    ...getImportedAlbumLibraries().flatMap(library => library.albums)];
}

function saveAlbums(albums) {
  localStorage.setItem(ALBUMS_KEY, JSON.stringify(albums.filter(album => !album.synced)));
}

function loadAssignments() {
  const value = safeJson(ASSIGNMENTS_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function saveAssignments(assignments) {
  localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
}

function sourceKey(item) {
  if (item?.localImportId) return `local-import:${item.localImportId}`;
  if (item?.syncGroupId) return `synced:${item.syncGroupId}`;
  if (item?.favoriteId) return `favorite:${item.favoriteId}`;
  return cleanUrl(item?.sourceUrl || item?.url || "") || String(item?.timestamp || "unknown");
}

function isToday(timestamp) {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function isFrameFile(file) {
  return file?.type === "FRAME" || file?.isReferenceFrame === true;
}

function isImageFile(file) {
  return (
    isFrameFile(file) ||
    file?.type === "IMAGE" ||
    /\.(jpg|jpeg|png|webp|gif|avif)(?:$|\?)/i.test(file?.path || file?.uri || "")
  );
}

function isVideoFile(file) {
  return (
    file?.type === "VIDEO" ||
    /\.(mp4|mov|m4v|webm)(?:$|\?)/i.test(file?.path || file?.uri || "")
  );
}

export { fileAssignmentKey } from "./imageFileIdentity.js";

function getGroups(albumId = activeAlbumId) {
  const favoriteRefs = safeJson(FAVORITE_REFS_KEY, []);
  const history = [...(Array.isArray(favoriteRefs) ? favoriteRefs : []), ...safeJson("mori_history", []),
    ...getImportedAlbumLibraries().flatMap(library => library.groups)];
  const assignments = loadAssignments();

  return history
    .map((item) => {
      const key = sourceKey(item);
      const localFiles = item.localFiles || [];
      const sourceVideos = localFiles
        .filter(isVideoFile)
        .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
      let files = localFiles.filter(isImageFile);
      let videos = sourceVideos;
      let videoLink = item.syncedVideoLink === true;

      if (albumId === "today") {
        files = files.filter((file) => isToday(file.savedAt || item.timestamp));
        videos = sourceVideos.filter((file) => isToday(file.savedAt || item.timestamp));
        videoLink = videoLink && isToday(item.timestamp);
      } else if (albumId !== "all") {
        const albumIds = [...(assignments[key] || []), ...(item.syncedAlbumIds || [])];
        const sourceAssigned = albumIds.includes(albumId);
        const assignedFiles = files.filter(file =>
          (assignments[fileAssignmentKey(file)] || []).includes(albumId));
        if (!sourceAssigned) {
          if (assignedFiles.length) {
            files = assignedFiles;
          } else {
            files = [];
            videos = [];
            videoLink = false;
          }
        }
      }

      const frames = files.filter(isFrameFile);
      const regularImages = files.filter((file) => !isFrameFile(file));
      const itemSource = String(item.sourceUrl || item.url || "");
      const isDouyinSource = /douyin\.com|iesdouyin\.com/i.test(itemSource);
      // Older Mori builds could save a Douyin post soundtrack/audio rendition as VIDEO.
      // Once real local images exist for a Douyin source, treat it as an image post so
      // those images stay visible in the album and can sync into Planner.
      const preferRegularImages = regularImages.length > 0 && (isDouyinSource || sourceVideos.length === 0);
      const displayFiles = item.syncGroupId ? files : preferRegularImages ? regularImages : frames;
      if (preferRegularImages) {
        videos = [];
      } else if (frames.length > 0 && sourceVideos.length > 0) {
        videos = sourceVideos;
      }

      return { key, item, files: displayFiles, frames, videos, videoLink };
    })
    .filter((group) => group.files.length > 0 || group.videos.length > 0 || group.videoLink);
}

export function getInspirationLibrarySnapshot() {
  const read = (key, fallback, array) => {
    const value = JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    if (!value || typeof value !== "object" || Array.isArray(value) !== array) {
      throw new Error("相册本地记录无法读取，未同步空数据");
    }
    return value;
  };
  const albums = read(ALBUMS_KEY, [], true).map(album => ({
    id: String(album.id), name: String(album.name || "相册"), createdAt: Number(album.createdAt) || 0,
  }));
  const assignments = read(ASSIGNMENTS_KEY, {}, false);
  const history = [...read(FAVORITE_REFS_KEY, [], true), ...read("mori_history", [], true)];
  const groups = new Map();
  const albumIds = new Set(albums.map(album => album.id));
  for (const item of history) {
    const key = sourceKey(item);
    const localFiles = Array.isArray(item.localFiles) ? item.localFiles : [];
    const files = localFiles.filter(isImageFile).map(file => ({
      path: String(file.path || ""), uri: String(file.uri || ""),
      title: String(file.title || item.title || "参考图"),
      savedAt: Number(file.savedAt || item.timestamp) || 0,
      frame: isFrameFile(file), frameTime: Number(file.frameTime) || 0,
    }));
    const hasVideo = localFiles.some(isVideoFile);
    if (!files.length && !hasVideo) continue;
    if (groups.has(key)) {
      groups.get(key).files.push(...files);
      groups.get(key).hasVideo ||= hasVideo;
    } else groups.set(key, {
      key, title: String(item.title || "参考图"), sourceUrl: String(item.sourceUrl || item.url || ""),
      timestamp: Number(item.timestamp) || 0, hasVideo, files,
      albumIds: (assignments[key] || []).filter(id => albumIds.has(id)),
    });
  }
  return { albums, groups: [...groups.values()] };
}

export function getActiveInspirationAlbumSnapshot() {
  const albums = loadAlbums();
  const activeAlbum = albums.find((album) => album.id === activeAlbumId);
  const name =
    activeAlbumId === "today"
      ? t("inspiration-today")
      : activeAlbumId === "all"
        ? t("inspiration-all")
        : activeAlbum?.name || "Album";

  return {
    id: activeAlbumId,
    name,
    synced: activeAlbum?.synced === true,
    localPackage: activeAlbum?.localPackage === true,
    syncProjectId: activeAlbum?.syncProjectId || "",
    plannerProjectId: activeAlbum?.plannerProjectId || "",
    groups: getGroups(activeAlbumId)
      .filter((group) => group.files.length > 0)
      .map((group) => ({
        key: group.key,
        title: group.item.title || "Reference",
        sourceUrl: group.item.sourceUrl || group.item.url || "",
        files: group.files.map((file) => ({
          assetId: file.assetId || "",
          path: file.path || "",
          uri: file.uri || "",
          title: file.title || group.item.title || "Reference",
          thumbnail: file.thumbnail || group.item.localThumbnail || group.item.thumbnail || "",
        })),
      })),
  };
}

// Read the complete source records, including frames hidden by the album's
// display filter. Sync only the selected album, never a UI-filtered image list.
export function getActiveInspirationLibrarySnapshot() {
  const library = getInspirationLibrarySnapshot();
  const active = getActiveInspirationAlbumSnapshot();
  if (active.synced) throw new Error("下载的相册不能作为电脑上传来源");
  const album = library.albums.find(item => item.id === active.id);
  if (!album && !["today", "all"].includes(active.id)) throw new Error("当前相册已不存在");
  const groups = library.groups.flatMap(group => {
    if (active.id !== "today" && active.id !== "all" && !group.albumIds.includes(active.id)) return [];
    const files = active.id === "today" ? group.files.filter(file => isToday(file.savedAt || group.timestamp)) : group.files;
    const hasVideo = group.hasVideo && (active.id !== "today" || isToday(group.timestamp));
    return files.length || hasVideo ? [{ ...group, files, hasVideo, albumIds: [active.id] }] : [];
  });
  return { albums: [album || { id: active.id, name: active.name, createdAt: 0 }], groups, sourceAlbumId: active.id };
}

export function getFavoriteAlbumTargets() {
  return { activeId: activeAlbumId, items: [
    { id: "today", name: t("inspiration-today") },
    { id: "all", name: t("inspiration-all") },
    ...loadAlbums().filter(album => !album.synced).map((album) => ({ id: album.id, name: album.name })),
  ] };
}

export function getManualAlbumTargets() {
  return loadAlbums().filter(album => !album.synced).map(album => ({
    id: album.id,
    name: album.name,
  }));
}

export function assignSourceUrlToAlbum(sourceUrl, albumId) {
  const key = cleanUrl(String(sourceUrl || ""));
  const target = loadAlbums().find(album => album.id === albumId && !album.synced);
  if (!key || !target) throw new Error("目标相册或来源链接无效");
  const assignments = loadAssignments();
  assignments[key] = [...new Set([...(assignments[key] || []), target.id])];
  saveAssignments(assignments);
  const page = document.getElementById("inspirationPage");
  if (page && !page.classList.contains("hidden") && !page.classList.contains("planner-mode")) {
    renderInspiration();
  }
  return { albumId: target.id, albumName: target.name };
}

export function createAlbumForSourceUrl(name, sourceUrl) {
  const trimmed = String(name || "").trim().slice(0, 48);
  if (!trimmed) throw new Error("请输入相册名称");
  const albums = loadAlbums().filter(album => !album.synced);
  let album = albums.find(candidate => candidate.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (!album) {
    album = {
      id: `album_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: trimmed,
      createdAt: Date.now(),
    };
    albums.push(album);
    saveAlbums(albums);
  }
  return assignSourceUrlToAlbum(sourceUrl, album.id);
}

export function insertFavoritesIntoAlbum(entries, albumId) {
  if (!getFavoriteAlbumTargets().items.some((album) => album.id === albumId)) throw new Error("目标相册已不存在，请重新选择");
  const refsRaw = localStorage.getItem(FAVORITE_REFS_KEY);
  const assignmentsRaw = localStorage.getItem(ASSIGNMENTS_KEY);
  const refs = JSON.parse(refsRaw || "[]");
  const assignments = JSON.parse(assignmentsRaw || "{}");
  if (!Array.isArray(refs) || !assignments || Array.isArray(assignments) || typeof assignments !== "object") throw new Error("相册记录无法读取，未改动原记录");
  const keyOf = (file) => String(file.path || file.uri || "").replace(/\\/g, "/").toLowerCase();
  const existing = new Set(getGroups(albumId).flatMap((group) => group.files.map(keyOf)));
  let added = 0;
  for (const entry of entries) {
    const pathKey = keyOf(entry);
    if (!pathKey) throw new Error("收藏图片缺少文件");
    if (existing.has(pathKey)) continue;
    // One image per independent reference: assigning it cannot include the
    // other frames of its original video/download group by accident.
    let item = refs.find((item) => item.favoriteId === entry.id);
    if (!item) {
      item = { favoriteId: entry.id, title: entry.title, url: entry.sourceUrl || "", sourceUrl: entry.sourceUrl || "", timestamp: Date.now(), platform: "FAVORITE", localFiles: [
        { path: entry.path, uri: entry.uri || entry.path, title: entry.title, type: "FRAME", isReferenceFrame: true, savedAt: Date.now() },
      ] };
      refs.unshift(item);
    } else if (albumId === "today") item.localFiles.forEach((file) => { file.savedAt = Date.now(); });
    if (albumId !== "today" && albumId !== "all") {
      const key = sourceKey(item);
      assignments[key] = [...new Set([...(assignments[key] || []), albumId])];
    }
    existing.add(pathKey); added += 1;
  }
  if (added) {
    let assignmentsWritten = false;
    try {
      localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
      assignmentsWritten = true;
      localStorage.setItem(FAVORITE_REFS_KEY, JSON.stringify(refs));
    } catch (error) {
      if (assignmentsWritten) {
        if (assignmentsRaw === null) localStorage.removeItem(ASSIGNMENTS_KEY);
        else localStorage.setItem(ASSIGNMENTS_KEY, assignmentsRaw);
      }
      throw error;
    }
    renderInspiration();
  }
  return { added, skipped: entries.length - added };
}

function revokeObjectUrls() {
  imageObserver?.disconnect();
  imageObserver = null;
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function guessMime(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".avif")) return "image/avif";
  return "image/jpeg";
}

async function loadLocalImage(img, file, item) {
  const fallback = file?.thumbnail || item?.localThumbnail || item?.thumbnail || "";
  if (await loadAndroidLocalImage(img, file, fallback)) return;
  const raw = file?.uri || file?.path || "";
  if (!raw) {
    img.src = file?.thumbnail || item?.localThumbnail || item?.thumbnail || "";
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
        objectUrls.add(objectUrl);
        img.src = objectUrl;
        return;
      }
    } catch (err) {
      console.warn("Inspiration local image read failed:", err);
    }
  }

  img.src = file?.thumbnail || item?.localThumbnail || item?.thumbnail || raw;
}

function observeLocalImage(img, file, item) {
  const fallback = file?.thumbnail || item?.localThumbnail || item?.thumbnail || "";
  if (fallback) img.src = fallback;

  if (!imageObserver) {
    loadLocalImage(img, file, item);
    return;
  }

  img._moriInspirationFile = file;
  img._moriInspirationItem = item;
  imageObserver.observe(img);
}

function createImageObserver() {
  const viewport = document.getElementById("inspirationViewport");
  if (!viewport || typeof IntersectionObserver === "undefined") return null;

  return new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        observer.unobserve(img);
        loadLocalImage(
          img,
          img._moriInspirationFile,
          img._moriInspirationItem,
        );
        delete img._moriInspirationFile;
        delete img._moriInspirationItem;
      });
    },
    { root: viewport, rootMargin: "500px" },
  );
}

async function openPath(path) {
  if (!path) return;
  if (window.MoriMainBridge?.openFile) {
    try {
      if (window.MoriMainBridge.openFile(path)) return;
    } catch (_) {}
  }
  const tauriInvoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (tauriInvoke) {
    try {
      await tauriInvoke("tauri_open_url", { url: path });
      return;
    } catch (_) {}
  }
  window.open(path, "_blank");
}

async function openSource(url) {
  if (!url) return;
  const tauriInvoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (tauriInvoke) {
    try {
      await tauriInvoke("tauri_open_url", { url });
      return;
    } catch (_) {}
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("inspiration-copied"));
    return true;
  } catch (_) {
    return false;
  }
}

async function copyImage(img, file) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Image clipboard unavailable");
    }

    const response = await fetch(img.src);
    const sourceBlob = await response.blob();
    let pngBlob = sourceBlob;

    if (sourceBlob.type !== "image/png") {
      const bitmap = await createImageBitmap(sourceBlob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      pngBlob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG conversion failed"))),
          "image/png",
        ),
      );
    }

    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    showToast(t("inspiration-copied"));
  } catch (err) {
    console.warn("Copy image failed:", err);
    await copyText(file?.path || file?.uri || "");
    showToast(t("inspiration-copy-image-failed"));
  }
}

function getTauriInvoke() {
  return (
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke ||
    null
  );
}

function cleanLocalPath(raw) {
  let path = String(raw || "");
  if (path.includes("_capacitor_file_")) {
    path = path.substring(path.indexOf("_capacitor_file_") + 16);
  }
  if (path.startsWith("file://")) path = path.replace(/^file:\/\//, "");
  try {
    path = decodeURIComponent(path);
  } catch (_) {}
  return path;
}

function videoMime(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function formatFrameTime(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const tenths = Math.floor((total % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function framesForItem(item, videoFile = null) {
  const target = sourceKey(item);
  const videoPath = videoFile?.path || videoFile?.uri || "";
  const history = safeJson("mori_history", []);
  const entry = history.find((candidate) => sourceKey(candidate) === target);
  if (!entry) return [];
  return (entry.localFiles || []).filter(
    (file) =>
      isFrameFile(file) &&
      (!videoPath || !file.sourceVideoPath || file.sourceVideoPath === videoPath),
  );
}

async function persistFrameBlob(blob, filename) {
  const invoke = getTauriInvoke();
  if (invoke) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await invoke("tauri_save_bytes_file", {
      bytes: Array.from(bytes),
      filename,
      folder: FRAME_FOLDER,
    });
    return { path, uri: path };
  }

  if (window.Capacitor?.isNativePlatform?.() && Filesystem) {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const relative = `${FRAME_FOLDER}/${filename}`;
    await Filesystem.writeFile({
      path: relative,
      data,
      directory: "DOCUMENTS",
      recursive: true,
    });
    const result = await Filesystem.getUri({ path: relative, directory: "DOCUMENTS" });
    return { path: relative, uri: result.uri || relative };
  }

  throw new Error("Persistent frame storage unavailable");
}

const MAX_GALLERY_FILE_BYTES = 40 * 1024 * 1024;

function galleryStatus(message, state = "idle") {
  const element = document.getElementById("albumGalleryStatus");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function galleryFileTitle(file, fallback) {
  return String(file?.name || fallback || "Gallery photo")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || fallback;
}

async function galleryJpegPreview(file) {
  if (typeof createImageBitmap !== "function") throw new Error("当前系统无法解码这张图片");
  const bitmap = await createImageBitmap(file);
  try {
    const maxSide = Math.max(bitmap.width, bitmap.height);
    if (!maxSide) throw new Error("图片尺寸无效");
    const scale = Math.min(1, 2048 / maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片转换不可用");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error("图片转换失败");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close?.();
  }
}

async function prepareGalleryFile(file) {
  if (!file || Number(file.size) <= 0) throw new Error("图片为空");
  if (Number(file.size) > MAX_GALLERY_FILE_BYTES) throw new Error(t("gallery-import-too-large"));
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return preparePlannerImageAsset(bytes, {
      filename: file.name,
      mime: file.type,
      maxDisplaySide: 2048,
      displayQuality: 0.88,
      legacyDisplay: false,
    });
  } catch (firstError) {
    if (!String(file.type || "").startsWith("image/")) throw firstError;
    const jpegBytes = await galleryJpegPreview(file);
    return preparePlannerImageAsset(jpegBytes, {
      filename: `${galleryFileTitle(file, "Gallery photo")}.jpg`,
      mime: "image/jpeg",
      maxDisplaySide: 2048,
      displayQuality: 0.88,
      legacyDisplay: false,
    });
  }
}

async function removeGalleryFiles(paths) {
  if (!Filesystem) return;
  for (const path of paths) {
    try {
      await Filesystem.deleteFile({ path, directory: "DATA" });
    } catch (_) {}
  }
}

export async function importGalleryFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) {
    galleryStatus(t("gallery-import-none"), "error");
    return { imported: 0, failed: 0 };
  }
  if (!Filesystem) throw new Error("手机文件存储不可用");
  const batchId = `gallery_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const writtenPaths = [];
  const localFiles = [];
  const failures = [];
  galleryStatus(t("gallery-import-reading"), "working");

  try {
    for (const [index, file] of files.entries()) {
      try {
        galleryStatus(`${t("gallery-import-reading")} ${index + 1}/${files.length}`, "working");
        const prepared = await prepareGalleryFile(file);
        const extension = prepared.asset.display.ext || "jpg";
        const relative = `Mori/GalleryImports/${batchId}/${String(index + 1).padStart(3, "0")}.${extension}`;
        const result = await Filesystem.writeFile({
          path: relative,
          directory: "DATA",
          data: bytesToBase64(prepared.displayBytes),
          recursive: true,
        });
        const uri = result?.uri || (await Filesystem.getUri({ path: relative, directory: "DATA" }))?.uri;
        if (!uri) throw new Error("保存后未返回图片路径");
        writtenPaths.push(relative);
        localFiles.push({
          path: relative,
          uri,
          assetId: prepared.asset.id,
          type: "IMAGE",
          title: galleryFileTitle(file, `Gallery photo ${index + 1}`),
          savedAt: Number(file.lastModified) || Date.now(),
          importedAt: Date.now(),
          galleryImport: true,
        });
      } catch (error) {
        failures.push({ name: file.name, message: String(error?.message || error) });
      }
    }
    if (!localFiles.length) {
      const detail = failures[0]?.message ? `：${failures[0].message}` : "";
      throw new Error(`${t("gallery-import-failed")}${detail}`);
    }

    const history = safeJson("mori_history", []);
    if (!Array.isArray(history)) throw new Error("下载记录无法读取");
    const assignments = loadAssignments();
    const baseTitle = localFiles[0].title;
    const item = {
      title: localFiles.length === 1 ? baseTitle : `${baseTitle} + ${localFiles.length - 1}`,
      sourceUrl: "",
      url: "",
      timestamp: Date.now(),
      platform: "GALLERY_IMPORT",
      localImportId: batchId,
      localFiles,
    };
    const previousHistory = localStorage.getItem("mori_history");
    const previousAssignments = localStorage.getItem(ASSIGNMENTS_KEY);
    try {
      history.unshift(item);
      if (!["today", "all"].includes(activeAlbumId)) {
        const key = sourceKey(item);
        assignments[key] = [...new Set([...(assignments[key] || []), activeAlbumId])];
      }
      localStorage.setItem("mori_history", JSON.stringify(history));
      saveAssignments(assignments);
    } catch (error) {
      if (previousHistory === null) localStorage.removeItem("mori_history");
      else localStorage.setItem("mori_history", previousHistory);
      if (previousAssignments === null) localStorage.removeItem(ASSIGNMENTS_KEY);
      else localStorage.setItem(ASSIGNMENTS_KEY, previousAssignments);
      throw error;
    }

    const message = failures.length
      ? t("gallery-import-partial", { count: localFiles.length, failed: failures.length })
      : t("gallery-imported", { count: localFiles.length });
    galleryStatus(message, failures.length ? "warning" : "ready");
    showToast(message);
    selectInspirationAlbum(activeAlbumId);
    window.dispatchEvent(new CustomEvent("mori_gallery_images_imported", {
      detail: { count: localFiles.length, failed: failures.length, albumId: activeAlbumId },
    }));
    return { imported: localFiles.length, failed: failures.length, item };
  } catch (error) {
    await removeGalleryFiles(writtenPaths);
    galleryStatus(String(error?.message || t("gallery-import-failed")), "error");
    showToast(t("gallery-import-failed"));
    throw error;
  }
}

function saveFrameRecord(item, videoFile, saved, frameTime) {
  const target = sourceKey(item);
  const history = safeJson("mori_history", []);
  let updated = false;
  const next = history.map((entry) => {
    if (updated || sourceKey(entry) !== target) return entry;
    updated = true;
    const localFiles = [...(entry.localFiles || [])];
    localFiles.push({
      path: saved.path,
      uri: saved.uri || saved.path,
      type: "FRAME",
      isReferenceFrame: true,
      sourceVideoPath: videoFile.path || videoFile.uri || "",
      frameTime,
      savedAt: Date.now(),
      title: `${entry.title || item.title || "Video"} · ${formatFrameTime(frameTime)}`,
    });
    return { ...entry, localFiles };
  });
  if (updated) {
    localStorage.setItem("mori_history", JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent("mori_reference_frame_saved", {
        detail: {
          path: saved.path,
          uri: saved.uri || saved.path,
          sourceUrl: item.sourceUrl || item.url || "",
          title: item.title || "Video frame",
          frameTime,
          savedAt: Date.now(),
        },
      }),
    );
  }
}

export function addCapturedFrameToActiveAlbum(saved, options = {}) {
  const framePath = String(saved?.path || saved?.uri || "");
  if (!framePath) return null;
  const now = Date.now();
  const title = String(options.title || t("planner-captured-frame-title") || "Captured frame");
  const item = {
    title,
    sourceUrl: "",
    url: "",
    timestamp: now,
    platform: "SCREEN_CAPTURE",
    localFiles: [
      {
        path: framePath,
        uri: saved?.uri || framePath,
        type: "FRAME",
        isReferenceFrame: true,
        savedAt: now,
        title,
      },
    ],
  };
  const history = safeJson("mori_history", []);
  history.unshift(item);
  localStorage.setItem("mori_history", JSON.stringify(history));

  if (activeAlbumId !== "today" && activeAlbumId !== "all") {
    const assignments = loadAssignments();
    const key = sourceKey(item);
    const current = Array.isArray(assignments[key]) ? assignments[key] : [];
    if (!current.includes(activeAlbumId)) assignments[key] = [...current, activeAlbumId];
    saveAssignments(assignments);
  }

  const detail = {
    path: framePath,
    uri: saved?.uri || framePath,
    sourceUrl: "",
    title,
    savedAt: now,
    albumId: activeAlbumId,
    forcePlanner: options.forcePlanner === true,
  };
  window.dispatchEvent(new CustomEvent("mori_reference_frame_saved", { detail }));
  const page = document.getElementById("inspirationPage");
  if (page && !page.classList.contains("hidden") && !page.classList.contains("planner-mode")) {
    renderInspiration();
  }
  return detail;
}

function saveDouyinWebFrameRecord(payload) {
  const sourceUrl = String(payload?.sourceUrl || "");
  const framePath = String(payload?.path || payload?.uri || "");
  if (!sourceUrl || !framePath) return false;
  const target = sourceKey({ sourceUrl });
  const history = safeJson("mori_history", []);
  const frameTime = Number(payload?.frameTime) || 0;
  const savedAt = Number(payload?.savedAt) || Date.now();
  let updated = false;
  const next = history.map((entry) => {
    if (updated || sourceKey(entry) !== target) return entry;
    updated = true;
    const localFiles = [...(entry.localFiles || [])];
    if (!localFiles.some((file) => file.path === framePath || file.uri === framePath)) {
      localFiles.push({
        path: framePath,
        uri: payload?.uri || framePath,
        type: "FRAME",
        isReferenceFrame: true,
        sourceWebVideo: true,
        sourceVideoPath: "",
        frameTime,
        savedAt,
        title: `${entry.title || payload?.title || "Douyin"} · ${formatFrameTime(frameTime)}`,
      });
    }
    return { ...entry, localFiles };
  });
  if (!updated) {
    next.unshift({
      url: sourceUrl,
      sourceUrl,
      title: payload?.title || "Douyin",
      timestamp: savedAt,
      localFiles: [
        {
          path: framePath,
          uri: payload?.uri || framePath,
          type: "FRAME",
          isReferenceFrame: true,
          sourceWebVideo: true,
          sourceVideoPath: "",
          frameTime,
          savedAt,
          title: `${payload?.title || "Douyin"} · ${formatFrameTime(frameTime)}`,
        },
      ],
    });
  }
  localStorage.setItem("mori_history", JSON.stringify(next));
  return true;
}

function bindDouyinWebFrameEvents() {
  if (window.__moriDouyinWebFrameEventsBound) return;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  window.__moriDouyinWebFrameEventsBound = true;
  Promise.resolve(
    listen("mori-douyin-frame-saved", (event) => {
      const payload = event?.payload || {};
      if (!saveDouyinWebFrameRecord(payload)) return;
      showToast(
        t("douyin-web-frame-saved", {
          time: formatFrameTime(payload.frameTime),
        }),
      );
      const page = document.getElementById("inspirationPage");
      if (page && !page.classList.contains("hidden")) renderInspiration();
    }),
  ).catch((error) => {
    console.warn("Could not bind Douyin web frame events:", error);
    window.__moriDouyinWebFrameEventsBound = false;
  });
}

async function loadFramePickerVideo(video, videoFile) {
  const raw = videoFile.uri || videoFile.path || "";
  if (!raw) throw new Error("Missing local video path");

  if (window.Capacitor?.convertFileSrc) {
    video.src = window.Capacitor.convertFileSrc(raw);
    video.load();
    return () => {};
  }

  const invoke = getTauriInvoke();
  if (invoke) {
    const path = cleanLocalPath(raw);
    const bytes = await invoke("tauri_read_file_bytes", { path });
    if (!bytes?.length) throw new Error("Could not read local video");
    const blobUrl = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: videoMime(path) }),
    );
    video.src = blobUrl;
    video.load();
    return () => URL.revokeObjectURL(blobUrl);
  }

  video.src = raw;
  video.load();
  return () => {};
}

function openFramePicker(item, videoFile) {
  if (!videoFile) return;
  document.querySelector(".inspiration-frame-picker-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "inspiration-frame-picker-overlay";
  const dialog = document.createElement("section");
  dialog.className = "inspiration-frame-picker";
  dialog.innerHTML = `
    <header class="frame-picker-header">
      <div>
        <strong>${escapeHtml(item.title || t("inspiration-video-reference"))}</strong>
        <span>${escapeHtml(t("inspiration-frame-picker-hint"))}</span>
      </div>
      <button type="button" class="frame-picker-close" aria-label="Close">×</button>
    </header>
    <div class="frame-picker-video-wrap">
      <video class="frame-picker-video" playsinline preload="metadata"></video>
      <div class="frame-picker-loading">${escapeHtml(t("inspiration-frame-loading"))}</div>
    </div>
    <div class="frame-picker-timeline">
      <input class="frame-picker-range" type="range" min="0" max="1" step="0.01" value="0" />
      <div class="frame-picker-time"><span class="frame-picker-current">00:00.0</span><span class="frame-picker-duration">00:00.0</span></div>
    </div>
    <div class="frame-picker-actions">
      <button type="button" class="frame-picker-play">${escapeHtml(t("inspiration-frame-play"))}</button>
      <button type="button" class="frame-picker-capture" disabled>${escapeHtml(t("inspiration-frame-capture"))}</button>
    </div>
    <div class="frame-picker-saved">
      <strong>${escapeHtml(t("inspiration-saved-frames"))}</strong>
      <div class="frame-picker-strip"></div>
    </div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const video = dialog.querySelector(".frame-picker-video");
  const loading = dialog.querySelector(".frame-picker-loading");
  const range = dialog.querySelector(".frame-picker-range");
  const current = dialog.querySelector(".frame-picker-current");
  const duration = dialog.querySelector(".frame-picker-duration");
  const playBtn = dialog.querySelector(".frame-picker-play");
  const captureBtn = dialog.querySelector(".frame-picker-capture");
  const strip = dialog.querySelector(".frame-picker-strip");
  const pickerUrls = new Set();
  let cleanupVideo = () => {};
  let scrubbing = false;
  let capturing = false;
  let changed = false;

  const renderSavedFrames = () => {
    strip.innerHTML = "";
    const frames = framesForItem(item, videoFile);
    if (!frames.length) {
      const empty = document.createElement("span");
      empty.className = "frame-picker-empty";
      empty.textContent = t("inspiration-no-saved-frames");
      strip.appendChild(empty);
      return;
    }
    frames.forEach((frame) => {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "frame-picker-thumb";
      thumb.title = formatFrameTime(frame.frameTime);
      const img = document.createElement("img");
      img.alt = frame.title || "Saved frame";
      loadLocalImage(img, frame, item);
      const label = document.createElement("span");
      label.textContent = formatFrameTime(frame.frameTime);
      thumb.append(img, label);
      thumb.addEventListener("click", () => {
        video.pause();
        video.currentTime = Math.min(video.duration || frame.frameTime, frame.frameTime || 0);
      });
      strip.appendChild(thumb);
    });
  };

  const close = () => {
    video.pause();
    cleanupVideo();
    pickerUrls.forEach((url) => URL.revokeObjectURL(url));
    pickerUrls.clear();
    overlay.remove();
    if (changed) renderInspiration();
  };
  dialog.querySelector(".frame-picker-close")?.addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });

  video.addEventListener("loadedmetadata", () => {
    range.max = String(Math.max(0.01, video.duration || 0.01));
    duration.textContent = formatFrameTime(video.duration);
    if (!video.videoWidth || !video.videoHeight) {
      loading.classList.remove("hidden");
      loading.textContent = t("inspiration-frame-audio-only");
      captureBtn.disabled = true;
      return;
    }
    loading.classList.add("hidden");
    captureBtn.disabled = false;
  });
  video.addEventListener("timeupdate", () => {
    if (!scrubbing) range.value = String(video.currentTime || 0);
    current.textContent = formatFrameTime(video.currentTime);
  });
  video.addEventListener("seeking", () => {
    captureBtn.disabled = true;
  });
  video.addEventListener("seeked", () => {
    if (!capturing) captureBtn.disabled = false;
    range.value = String(video.currentTime || 0);
    current.textContent = formatFrameTime(video.currentTime);
  });
  video.addEventListener("play", () => {
    playBtn.textContent = t("inspiration-frame-pause");
  });
  video.addEventListener("pause", () => {
    playBtn.textContent = t("inspiration-frame-play");
  });
  video.addEventListener("error", () => {
    loading.textContent = t("inspiration-frame-video-error");
    captureBtn.disabled = true;
  });

  range.addEventListener("pointerdown", () => {
    scrubbing = true;
    video.pause();
  });
  range.addEventListener("input", () => {
    video.currentTime = Number(range.value) || 0;
    current.textContent = formatFrameTime(range.value);
  });
  range.addEventListener("change", () => {
    scrubbing = false;
  });
  playBtn.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });

  captureBtn.addEventListener("click", async () => {
    if (!video.videoWidth || !video.videoHeight || video.seeking) return;
    video.pause();
    capturing = true;
    captureBtn.disabled = true;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("Frame encoding failed"))),
          "image/webp",
          0.94,
        ),
      );
      const frameTime = video.currentTime || 0;
      const filename = `Mori_Frame_${Date.now()}_${Math.round(frameTime * 1000)}.webp`;
      const saved = await persistFrameBlob(blob, filename);
      saveFrameRecord(item, videoFile, saved, frameTime);
      changed = true;
      renderSavedFrames();
      showToast(t("inspiration-frame-saved", { time: formatFrameTime(frameTime) }));
    } catch (err) {
      console.warn("Frame capture failed:", err);
      showToast(t("inspiration-frame-save-failed"));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      capturing = false;
      captureBtn.disabled = video.seeking;
    }
  });

  renderSavedFrames();
  loadFramePickerVideo(video, videoFile)
    .then((cleanup) => {
      cleanupVideo = cleanup;
    })
    .catch((err) => {
      console.warn("Frame picker video load failed:", err);
      loading.textContent = t("inspiration-frame-video-error");
    });
}

function applyTransform() {
  const stage = document.getElementById("inspirationStage");
  const label = document.getElementById("inspirationZoomLabel");
  if (stage) {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  const mobileLabel = document.getElementById("albumMobileZoomLabel");
  if (mobileLabel) mobileLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function resetView() {
  zoom = isMobileInspiration() ? 0.7 : 1;
  panX = isMobileInspiration() ? 14 : 24;
  panY = 24;
  applyTransform();
}

function fitMobileCanvas() {
  const viewport = document.getElementById("inspirationViewport");
  const lanes = [...document.querySelectorAll("#inspirationStage > .inspiration-lane")];
  if (!viewport || !lanes.length) return resetView();
  const width = Math.max(...lanes.map(lane => lane.offsetLeft + lane.offsetWidth));
  const height = Math.max(...lanes.map(lane => lane.offsetTop + lane.offsetHeight));
  zoom = Math.max(0.05, Math.min(1, (viewport.clientWidth - 28) / width, (viewport.clientHeight - 56) / height));
  panX = 14;
  panY = 24;
  applyTransform();
}

function setZoom(nextZoom, anchorX = null, anchorY = null) {
  const viewport = document.getElementById("inspirationViewport");
  const clamped = Math.min(2.4, Math.max(isMobileInspiration() ? 0.05 : 0.35, nextZoom));
  if (!viewport || anchorX === null || anchorY === null) {
    zoom = clamped;
    applyTransform();
    return;
  }

  const rect = viewport.getBoundingClientRect();
  const x = anchorX - rect.left;
  const y = anchorY - rect.top;
  const worldX = (x - panX) / zoom;
  const worldY = (y - panY) / zoom;
  zoom = clamped;
  panX = x - worldX * zoom;
  panY = y - worldY * zoom;
  applyTransform();
}

function createAlbum(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const albums = loadAlbums();
  const album = {
    id: `album_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: trimmed.slice(0, 48),
    createdAt: Date.now(),
  };
  albums.push(album);
  saveAlbums(albums);
  showToast(t("inspiration-album-created"));
  return album;
}

export function applyAiAlbumPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return { albums: [], albumNames: [] };
  const albums = loadAlbums().filter(album => !album.synced);
  const assignments = loadAssignments();
  const applied = [];
  for (const item of plan) {
    const name = String(item?.name || "").trim().slice(0, 48);
    const groupKeys = [...new Set((Array.isArray(item?.groupKeys) ? item.groupKeys : []).map(String).filter(Boolean))];
    const fileKeys = [...new Set((Array.isArray(item?.fileKeys) ? item.fileKeys : []).map(String).filter(Boolean))];
    if (!name || (!groupKeys.length && !fileKeys.length)) continue;
    let album = albums.find(candidate => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!album) {
      album = {
        id: `album_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        createdAt: Date.now(),
        aiOrganized: true,
      };
      albums.push(album);
    }
    for (const groupKey of groupKeys) {
      assignments[groupKey] = [...new Set([...(assignments[groupKey] || []), album.id])];
    }
    for (const fileKey of fileKeys) {
      assignments[fileKey] = [...new Set([...(assignments[fileKey] || []), album.id])];
    }
    applied.push(album);
  }
  if (!applied.length) return { albums: [], albumNames: [] };
  saveAlbums(albums);
  saveAssignments(assignments);
  selectInspirationAlbum(applied[0].id);
  return { albums: applied, albumNames: applied.map(album => album.name) };
}

const PLANNER_INDEX_KEY = "mori_planner_projects_v2";

function loadPlannerAlbumIndex() {
  try {
    const value = JSON.parse(localStorage.getItem(PLANNER_INDEX_KEY) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function refreshPlannerAlbumIndex(index, sourceId, targetId = "") {
  if (!index?.activeProjectByAlbum || !index?.projects) return;
  const sourceProjectId = String(index.activeProjectByAlbum[sourceId] || "");
  const targetProjectId = String(index.activeProjectByAlbum[targetId] || "");
  if (targetId && sourceProjectId && targetProjectId && sourceProjectId !== targetProjectId) {
    throw new Error("两个相册都已有独立策划，无法直接合并相册");
  }
  if (targetId && sourceProjectId && !targetProjectId) {
    index.activeProjectByAlbum[targetId] = sourceProjectId;
  }
  delete index.activeProjectByAlbum[sourceId];
  const projectId = sourceProjectId || targetProjectId;
  const project = projectId ? index.projects[projectId] : null;
  if (project) {
    const albumIds = [...new Set((Array.isArray(project.albumIds) ? project.albumIds : [])
      .filter(id => id !== sourceId))];
    if (targetId && !albumIds.includes(targetId)) albumIds.push(targetId);
    project.albumIds = albumIds;
  }
  localStorage.setItem(PLANNER_INDEX_KEY, JSON.stringify(index));
}

export function renameInspirationAlbum(albumId, nextName) {
  const name = String(nextName || "").trim().slice(0, 48);
  if (!name) throw new Error("请输入相册名称");
  const albums = loadAlbums().filter(album => !album.synced);
  const album = albums.find(item => item.id === albumId);
  if (!album) throw new Error("该相册不可编辑");
  if (albums.some(item => item.id !== albumId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("已经有同名相册");
  }
  album.name = name;
  saveAlbums(albums);
  renderInspiration();
  return album;
}

export function deleteInspirationAlbum(albumId) {
  const albums = loadAlbums().filter(album => !album.synced);
  const album = albums.find(item => item.id === albumId);
  if (!album) throw new Error("该相册不可删除");
  const assignments = loadAssignments();
  for (const [key, ids] of Object.entries(assignments)) {
    const next = (Array.isArray(ids) ? ids : []).filter(id => id !== albumId);
    if (next.length) assignments[key] = next;
    else delete assignments[key];
  }
  saveAssignments(assignments);
  saveAlbums(albums.filter(item => item.id !== albumId));
  const plannerIndex = loadPlannerAlbumIndex();
  if (plannerIndex) refreshPlannerAlbumIndex(plannerIndex, albumId);
  if (activeAlbumId === albumId) activeAlbumId = "all";
  renderInspiration();
  return album;
}

export function mergeInspirationAlbums(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) throw new Error("请选择不同的目标相册");
  const albums = loadAlbums().filter(album => !album.synced);
  const source = albums.find(album => album.id === sourceId);
  const target = albums.find(album => album.id === targetId);
  if (!source || !target) throw new Error("相册不存在或不可编辑");
  const plannerIndex = loadPlannerAlbumIndex();
  if (plannerIndex) refreshPlannerAlbumIndex(plannerIndex, sourceId, targetId);
  const assignments = loadAssignments();
  for (const [key, ids] of Object.entries(assignments)) {
    const current = Array.isArray(ids) ? ids : [];
    if (!current.includes(sourceId)) continue;
    assignments[key] = [...new Set(current.filter(id => id !== sourceId).concat(targetId))];
  }
  saveAssignments(assignments);
  saveAlbums(albums.filter(album => album.id !== sourceId));
  activeAlbumId = targetId;
  renderInspiration();
  return { source, target };
}

export function openAlbumEditor(album) {
  if (!album || album.synced || album.localPackage) {
    showToast(t("album-edit-readonly"));
    return;
  }
  document.getElementById("albumMobileMenu")?.classList.add("hidden");
  const overlay = document.createElement("div");
  overlay.id = "albumEditOverlay";
  overlay.className = "modal-overlay album-edit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "albumEditTitle");
  const targetAlbums = getManualAlbumTargets().filter(candidate => candidate.id !== album.id);
  overlay.innerHTML = `<div class="album-edit-sheet">
    <div class="album-edit-heading">
      <div><span>${escapeHtml(t("album-edit-label"))}</span><h3 id="albumEditTitle">${escapeHtml(album.name)}</h3></div>
      <button type="button" class="album-icon-button album-edit-close" data-action="close" aria-label="${escapeHtml(t("album-close"))}">×</button>
    </div>
    <button type="button" class="album-edit-action" data-action="rename"><strong>${escapeHtml(t("album-edit-rename"))}</strong><span>${escapeHtml(t("album-edit-rename-hint"))}</span></button>
    <button type="button" class="album-edit-action" data-action="merge" ${targetAlbums.length ? "" : "disabled"}><strong>${escapeHtml(t("album-edit-merge"))}</strong><span>${escapeHtml(targetAlbums.length ? t("album-edit-merge-hint") : t("album-edit-no-target"))}</span></button>
    <div class="album-edit-merge hidden">
      <label for="albumMergeTarget">${escapeHtml(t("album-edit-merge-into"))}</label>
      <select id="albumMergeTarget">${targetAlbums.map(target => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`).join("")}</select>
      <button type="button" data-action="merge-confirm">${escapeHtml(t("album-edit-merge-confirm"))}</button>
    </div>
    <button type="button" class="album-edit-action danger" data-action="delete"><strong>${escapeHtml(t("album-edit-delete"))}</strong><span>${escapeHtml(t("album-edit-delete-hint"))}</span></button>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", event => {
    if (event.target === overlay) close();
  });
  overlay.querySelectorAll('[data-action="close"]').forEach(button => button.addEventListener("click", close));
  overlay.querySelector('[data-action="rename"]')?.addEventListener("click", () => {
    close();
    showConfirm(
      t("album-edit-rename"),
      `<div class="inspiration-album-dialog"><label>${escapeHtml(t("inspiration-album-name"))}</label><input id="inspirationAlbumNameInput" type="text" maxlength="48" autocomplete="off" value="${escapeHtml(album.name)}" /></div>`,
      () => {
        try {
          const nextName = document.getElementById("inspirationAlbumNameInput")?.value || "";
          const renamed = renameInspirationAlbum(album.id, nextName);
          showToast(t("album-edit-renamed", { name: renamed.name }));
        } catch (error) {
          showToast(String(error?.message || error));
        }
      },
    );
    setTimeout(() => document.getElementById("inspirationAlbumNameInput")?.focus(), 60);
  });
  overlay.querySelector('[data-action="merge"]')?.addEventListener("click", () => {
    overlay.querySelector(".album-edit-merge")?.classList.remove("hidden");
  });
  overlay.querySelector('[data-action="merge-confirm"]')?.addEventListener("click", () => {
    const targetId = overlay.querySelector("#albumMergeTarget")?.value || "";
    try {
      const result = mergeInspirationAlbums(album.id, targetId);
      close();
      showToast(t("album-edit-merged", { source: result.source.name, target: result.target.name }));
    } catch (error) {
      showToast(String(error?.message || error));
    }
  });
  overlay.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
    close();
    showConfirm(
      t("album-edit-delete"),
      t("album-edit-delete-confirm", { name: album.name }),
      () => {
        try {
          deleteInspirationAlbum(album.id);
          showToast(t("album-edit-deleted", { name: album.name }));
        } catch (error) {
          showToast(String(error?.message || error));
        }
      },
    );
  });
}

function promptNewAlbum(onCreated) {
  showConfirm(
    t("inspiration-new-album"),
    `<div class="inspiration-album-dialog"><label>${t("inspiration-album-name")}</label><input id="inspirationAlbumNameInput" type="text" maxlength="48" autocomplete="off" /></div>`,
    () => {
      const input = document.getElementById("inspirationAlbumNameInput");
      const album = createAlbum(input?.value || "");
      if (album) onCreated?.(album);
    },
  );
  setTimeout(() => document.getElementById("inspirationAlbumNameInput")?.focus(), 60);
}

function addGroupToAlbum(groupKey, albumId) {
  if (!groupKey || !albumId) return;
  const assignments = loadAssignments();
  const current = new Set(assignments[groupKey] || []);
  current.add(albumId);
  assignments[groupKey] = [...current];
  saveAssignments(assignments);
}

function removeGroupFromAlbum(groupKey, albumId) {
  const assignments = loadAssignments();
  assignments[groupKey] = (assignments[groupKey] || []).filter((id) => id !== albumId);
  if (assignments[groupKey].length === 0) delete assignments[groupKey];
  saveAssignments(assignments);
}

function normalizedFilePath(file) {
  const value = String(file?.path || file?.uri || "").trim();
  if (!value || /^(?:https?:|data:|blob:)/i.test(value)) return "";
  try {
    return decodeURIComponent(value.replace(/^file:\/\//i, "")).replace(/\\/g, "/");
  } catch (_) {
    return value.replace(/^file:\/\//i, "").replace(/\\/g, "/");
  }
}

function fileAliases(file) {
  return [file?.path, file?.uri]
    .map(value => normalizedFilePath({ path: value }))
    .filter(Boolean);
}

function cacheFile(file) {
  const path = normalizedFilePath(file);
  return file?.cachedImage === true ||
    file?.storage === "cache" ||
    file?.directory === "DATA" ||
    /^Mori\/Library\/Images\//i.test(path);
}

async function deleteSourceFile(file) {
  const path = normalizedFilePath(file);
  if (!path) return true;
  if (path.startsWith("content:")) throw new Error("content_uri_not_owned");

  if (cacheFile(file)) {
    await Filesystem.deleteFile({
      path,
      directory: file?.directory || "DATA",
    });
    return true;
  }

  if (window.MoriMainBridge?.deleteMediaFile) {
    try {
      if (window.MoriMainBridge.deleteMediaFile(path) === true) return true;
    } catch (_) {}
  }

  let lastError = null;
  for (const directory of ["EXTERNAL_STORAGE", "DOCUMENTS", "EXTERNAL"]) {
    try {
      await Filesystem.deleteFile({ path, directory });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("file_delete_failed");
}

export async function deleteInspirationSource(groupOrKey) {
  const groupKey = typeof groupOrKey === "string" ? groupOrKey : groupOrKey?.key;
  if (!groupKey) return { removedSources: 0, deleted: 0, failed: 0 };

  const history = safeJson("mori_history", []);
  const favoriteRefs = safeJson(FAVORITE_REFS_KEY, []);
  const historyList = Array.isArray(history) ? history : [];
  const favoriteList = Array.isArray(favoriteRefs) ? favoriteRefs : [];
  const removedHistory = historyList.filter(item => sourceKey(item) === groupKey);
  const removedFavorites = favoriteList.filter(item => sourceKey(item) === groupKey);
  const removed = [...removedHistory, ...removedFavorites];
  if (!removed.length) return { removedSources: 0, deleted: 0, failed: 0 };

  const remaining = [
    ...historyList.filter(item => sourceKey(item) !== groupKey),
    ...favoriteList.filter(item => sourceKey(item) !== groupKey),
  ];
  const referencedPaths = new Set(remaining.flatMap(item =>
    (item.localFiles || []).flatMap(fileAliases)));
  const files = new Map();
  for (const file of removed.flatMap(item => item.localFiles || [])) {
    const path = normalizedFilePath(file);
    if (path && !referencedPaths.has(path)) files.set(path, file);
  }

  const nextHistory = historyList.filter(item => sourceKey(item) !== groupKey);
  const nextFavorites = favoriteList.filter(item => sourceKey(item) !== groupKey);
  if (typeof window.safeSetMoriHistory === "function") window.safeSetMoriHistory(nextHistory);
  else localStorage.setItem("mori_history", JSON.stringify(nextHistory));
  localStorage.setItem(FAVORITE_REFS_KEY, JSON.stringify(nextFavorites));

  const assignments = loadAssignments();
  delete assignments[groupKey];
  for (const file of files.values()) delete assignments[fileAssignmentKey(file)];
  saveAssignments(assignments);

  let deleted = 0;
  let failed = 0;
  for (const file of files.values()) {
    try {
      await deleteSourceFile(file);
      deleted += 1;
    } catch (error) {
      console.warn("Could not delete source image:", error);
      failed += 1;
    }
  }

  renderInspiration();
  window.dispatchEvent(new CustomEvent("mori_source_deleted", {
    detail: { key: groupKey, removedSources: removed.length, deleted, failed },
  }));
  return { removedSources: removed.length, deleted, failed };
}

async function openSourceActions(group) {
  const sourceUrl = group?.item?.sourceUrl || group?.item?.url || "";
  if (!sourceUrl) return;
  try { triggerHaptic?.("light"); } catch (_) {}
  const action = await showActionSheet({
    title: group.item.title || t("album-source-menu"),
    message: sourceUrl,
    options: [{
      id: "delete-source",
      label: t("album-source-delete"),
      description: t("album-source-delete-desc"),
      icon: "trash",
      destructive: true,
    }],
  });
  if (action !== "delete-source") return;
  showConfirm(
    t("album-source-delete-title"),
    t("album-source-delete-confirm", {
      title: escapeHtml(group.item.title || sourceUrl),
      count: group.files.length,
    }),
    async () => {
      try {
        const lane = [...document.querySelectorAll(".inspiration-lane")]
          .find(element => element.dataset.groupKey === group.key);
        lane?.classList.add("is-removing");
        await new Promise(resolve => setTimeout(resolve, 180));
        const result = await deleteInspirationSource(group);
        if (result.failed) {
          showInfoModal(
            t("album-source-delete-partial-title"),
            escapeHtml(t("album-source-delete-partial", {
              deleted: result.deleted,
              failed: result.failed,
            })),
          );
        } else {
          showToast(t("album-source-deleted", { count: result.deleted }));
        }
      } catch (error) {
        showInfoModal(
          t("album-source-delete-partial-title"),
          escapeHtml(String(error?.message || error)),
        );
      }
    },
  );
}

function saveTodayAsAlbum() {
  const groups = getGroups("today");
  if (!groups.length) {
    showToast(t("inspiration-empty"));
    return;
  }
  const now = new Date();
  const defaultName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const album = createAlbum(defaultName);
  if (!album) return;
  groups.forEach((group) => addGroupToAlbum(group.key, album.id));
  selectInspirationAlbum(album.id);
  showToast(t("inspiration-today-saved"));
}

function selectInspirationAlbum(id) {
  activeAlbumId = id;
  aiPoseFilter = "all";
  showMobileAlbumDetail();
  resetView();
  renderInspiration();
  window.dispatchEvent(new CustomEvent("mori_album_selected", { detail: getActiveInspirationAlbumSnapshot() }));
}

function renderAlbumTabs() {
  const container = document.getElementById("inspirationAlbumTabs");
  if (!container) return;
  const albums = loadAlbums();
  const tabs = [
    { id: "today", name: t("inspiration-today") },
    { id: "all", name: t("inspiration-all") },
    ...albums,
  ];

  if (!tabs.some((tab) => tab.id === activeAlbumId)) activeAlbumId = "today";
  container.innerHTML = "";
  tabs.forEach((tab) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `inspiration-album-tab ${tab.id === activeAlbumId ? "active" : ""}`;
    btn.textContent = tab.name;
    btn.addEventListener("click", () => selectInspirationAlbum(tab.id));
    container.appendChild(btn);
  });
}

function buildAlbumTools(groupKey, albums) {
  const albumTools = document.createElement("div");
  albumTools.className = "inspiration-lane-album-tools";
  const select = document.createElement("select");
  select.innerHTML = `<option value="">${escapeHtml(t("inspiration-add-to-album"))}</option>${albums.filter(album => !album.synced)
    .map(
      (album) =>
        `<option value="${escapeHtml(album.id)}">${escapeHtml(album.name)}</option>`,
    )
    .join("")}`;
  select.addEventListener("change", () => {
    if (!select.value) return;
    addGroupToAlbum(groupKey, select.value);
    showToast(t("inspiration-added-to-album"));
    select.value = "";
  });
  albumTools.appendChild(select);

  if (activeAlbumId !== "today" && activeAlbumId !== "all" && !albums.find(album => album.id === activeAlbumId)?.synced) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = t("inspiration-remove-from-album");
    removeBtn.addEventListener("click", () => {
      removeGroupFromAlbum(groupKey, activeAlbumId);
      renderInspiration();
    });
    albumTools.appendChild(removeBtn);
  }

  return albumTools;
}

function renderMobileGroupTools(container) {
  container.replaceChildren();
  const albums = loadAlbums();
  for (const group of getGroups()) {
    const section = document.createElement("section");
    const title = document.createElement("strong");
    title.textContent = group.item.title || "Reference";
    section.append(title, buildAlbumTools(group.key, albums));
    container.appendChild(section);
  }
}

function buildLane(group, albums) {
  const mobile = isMobileInspiration();
  const lane = document.createElement("section");
  lane.className = "inspiration-lane";
  lane.dataset.groupKey = group.key;

  const sourceUrl = group.item.sourceUrl || group.item.url || "";
  const removableSource = Boolean(
    sourceUrl &&
    !group.item.syncGroupId &&
    !group.item.localPackage &&
    !group.item.localImportId,
  );
  const videoFile = group.videos?.[0] || null;
  const summary = group.videoLink ? `视频链接 · ${group.frames.length} 帧` : videoFile
    ? t("inspiration-video-frame-summary", { count: group.frames?.length || 0 })
    : `${group.files.length}`;
  const header = document.createElement("div");
  header.className = "inspiration-lane-header";
  header.innerHTML = mobile ? `
    <div class="inspiration-lane-copy">
      <button class="inspiration-title-link" type="button" ${sourceUrl ? "" : "disabled"}>
        <strong>${escapeHtml(group.item.title || "Reference")}</strong>
        ${sourceUrl ? '<span class="album-icon" aria-hidden="true" style="--album-icon: url(\'/icons/material/open_in_new.svg\')"></span>' : ""}
      </button>
      <span>${escapeHtml(videoFile || group.videoLink ? summary : t("album-photo-count", { count: group.files.length }))}</span>
    </div>
    ${removableSource ? `<button type="button" class="inspiration-source-menu" aria-label="${escapeHtml(t("album-source-menu"))}">⋯</button>` : ""}` : `
    <div class="inspiration-lane-copy">
      <strong>${escapeHtml(group.item.title || "Reference")}</strong>
      <span>${escapeHtml(summary)} · ${escapeHtml(sourceUrl)}</span>
    </div>
    <div class="inspiration-lane-header-actions">
      ${videoFile ? `<button type="button" class="inspiration-frame-source-btn">${escapeHtml(group.frames?.length ? t("inspiration-frame-continue") : t("inspiration-frame-select"))}</button>` : ""}
      <button type="button" class="inspiration-source-btn">${escapeHtml(t("inspiration-open-source"))}</button>
      ${removableSource ? `<button type="button" class="inspiration-source-menu" aria-label="${escapeHtml(t("album-source-menu"))}">⋯</button>` : ""}
    </div>
  `;
  header.querySelector(".inspiration-title-link")?.addEventListener("click", () => openSource(sourceUrl));
  header.querySelector(".inspiration-source-btn")?.addEventListener("click", () =>
    openSource(sourceUrl),
  );
  header.querySelector(".inspiration-source-menu")?.addEventListener("click", () =>
    openSourceActions(group),
  );
  header.querySelector(".inspiration-frame-source-btn")?.addEventListener("click", () =>
    openFramePicker(group.item, videoFile),
  );

  const albumTools = buildAlbumTools(group.key, albums);

  const stack = document.createElement("div");
  stack.className = "inspiration-lane-stack";

  if (group.videoLink && !group.files.length) {
    const linkCard = document.createElement("button");
    linkCard.type = "button";
    linkCard.className = "inspiration-card inspiration-video-link";
    linkCard.textContent = "▶ 打开视频来源";
    linkCard.disabled = !sourceUrl;
    linkCard.addEventListener("click", () => openSource(sourceUrl));
    stack.appendChild(linkCard);
  }

  if (videoFile && group.files.length === 0) {
    const sourceCard = document.createElement("article");
    sourceCard.className = "inspiration-card inspiration-video-source-card";
    const thumb = videoFile.thumbnail || group.item.localThumbnail || group.item.thumbnail || "";
    if (thumb) {
      const img = document.createElement("img");
      img.alt = group.item.title || t("inspiration-video-reference");
      img.src = thumb;
      img.draggable = false;
      sourceCard.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "inspiration-video-placeholder";
      placeholder.textContent = "▶";
      sourceCard.appendChild(placeholder);
    }
    const sourceAction = document.createElement("button");
    sourceAction.type = "button";
    sourceAction.className = "inspiration-video-frame-action";
    sourceAction.textContent = t("inspiration-frame-select");
    sourceAction.addEventListener("click", () => openFramePicker(group.item, videoFile));
    sourceCard.appendChild(sourceAction);
    stack.appendChild(sourceCard);
  }

  group.files.forEach((file, fileIndex) => {
    const card = document.createElement("article");
    card.className = "inspiration-card";
    card.draggable = !mobile;
    if (mobile && !file.syncMissing) {
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `${t("album-preview")} · ${file.title || group.item.title || fileIndex + 1}`);
      card.addEventListener("click", () => openMobileAlbumPreview(group, file));
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); card.click(); }
      });
    }

    const img = document.createElement("img");
    img.alt = file.title || group.item.title || `Reference ${fileIndex + 1}`;
    img.loading = "lazy";
    img.draggable = false;
    if (file.syncMissing) {
      const missing = document.createElement("span");
      missing.className = "inspiration-sync-missing";
      missing.textContent = "图片尚未下载，重新同步可重试";
      card.appendChild(missing);
    } else observeLocalImage(img, file, group.item);

    card.addEventListener("dragstart", (event) => {
      const path = file.path || file.uri || "";
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", path || sourceUrl);
      if (sourceUrl) event.dataTransfer.setData("text/uri-list", sourceUrl);
      if (path) event.dataTransfer.setData("application/x-mori-file-path", path);
    });

    if (isFrameFile(file)) {
      card.classList.add("inspiration-frame-card");
      const timeBadge = document.createElement("span");
      timeBadge.className = "inspiration-frame-time";
      timeBadge.textContent = formatFrameTime(file.frameTime);
      card.appendChild(timeBadge);
    }

    const actions = document.createElement("div");
    actions.className = "inspiration-card-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = t("inspiration-open-file");
    openBtn.addEventListener("click", () => openPath(file.uri || file.path));

    const copyImageBtn = document.createElement("button");
    copyImageBtn.type = "button";
    copyImageBtn.textContent = t("inspiration-copy-image");
    copyImageBtn.addEventListener("click", () => copyImage(img, file));

    const copyPathBtn = document.createElement("button");
    copyPathBtn.type = "button";
    copyPathBtn.textContent = t("inspiration-copy-path");
    copyPathBtn.addEventListener("click", () => copyText(file.path || file.uri || ""));

    const copySourceBtn = document.createElement("button");
    copySourceBtn.type = "button";
    copySourceBtn.textContent = t("inspiration-copy-source");
    copySourceBtn.addEventListener("click", () => copyText(sourceUrl));

    actions.append(openBtn, copyImageBtn, copyPathBtn, copySourceBtn);
    if (!file.syncMissing) {
      card.appendChild(img);
      const aiAnalysis = getAiAnalysisForFile(file);
      if (aiAnalysis?.pose) {
        const aiBadge = document.createElement("span");
        aiBadge.className = "inspiration-ai-pose-badge";
        aiBadge.textContent = aiPoseLabel(aiAnalysis.pose);
        card.appendChild(aiBadge);
      }
    }
    if (!mobile) card.appendChild(actions);
    stack.appendChild(card);
  });

  lane.append(header);
  if (!mobile) lane.appendChild(albumTools);
  lane.appendChild(stack);
  return lane;
}

function bindBoardInteractions() {
  if (boardBound) return;
  const viewport = document.getElementById("inspirationViewport");
  if (!viewport) return;
  boardBound = true;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  // Delay activation until the last finger lifts. Pinch/pan never opens a photo or link.
  // Grouped view uses normal browser scrolling, rather than these canvas gestures.
  let touchGesture = null;
  let touchTarget = null;
  let touchMoved = false;
  let touchMultitouch = false;
  let suppressClickUntil = 0;
  const beginTouch = touches => {
    const rect = viewport.getBoundingClientRect();
    if (touches.length >= 2) {
      const [a, b] = touches;
      const x = (a.clientX + b.clientX) / 2 - rect.left;
      const y = (a.clientY + b.clientY) / 2 - rect.top;
      touchMultitouch = true;
      touchGesture = { type: "pinch", zoom, distance: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
        worldX: (x - panX) / zoom, worldY: (y - panY) / zoom };
    } else if (touches.length === 1) {
      touchGesture = { type: "pan", x: touches[0].clientX, y: touches[0].clientY, panX, panY };
    } else touchGesture = null;
  };
  viewport.addEventListener("click", event => {
    if (event.detail && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  viewport.addEventListener("touchstart", event => {
    if (!isMobileAlbumCanvas()) return;
    event.preventDefault();
    if (event.touches.length === 1) {
      touchMoved = false; touchMultitouch = false;
      touchTarget = event.target.closest("button, .inspiration-card");
    }
    beginTouch(event.touches);
  }, { passive: false });
  viewport.addEventListener("touchmove", event => {
    if (!isMobileAlbumCanvas()) return;
    event.preventDefault();
    if (!touchGesture || (event.touches.length >= 2 && touchGesture.type !== "pinch")) beginTouch(event.touches);
    if (!touchGesture) return;
    if (touchGesture.type === "pinch" && event.touches.length >= 2) {
      const [a, b] = event.touches;
      const rect = viewport.getBoundingClientRect();
      zoom = Math.max(0.05, Math.min(2.4, touchGesture.zoom * Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) / touchGesture.distance));
      panX = (a.clientX + b.clientX) / 2 - rect.left - touchGesture.worldX * zoom;
      panY = (a.clientY + b.clientY) / 2 - rect.top - touchGesture.worldY * zoom;
    } else if (event.touches.length === 1) {
      const point = event.touches[0];
      if (Math.hypot(point.clientX - touchGesture.x, point.clientY - touchGesture.y) > 8) touchMoved = true;
      panX = touchGesture.panX + point.clientX - touchGesture.x;
      panY = touchGesture.panY + point.clientY - touchGesture.y;
    }
    applyTransform();
  }, { passive: false });
  viewport.addEventListener("touchend", event => {
    if (!isMobileAlbumCanvas() || !touchGesture) return;
    event.preventDefault();
    suppressClickUntil = Date.now() + 600;
    if (event.touches.length) { beginTouch(event.touches); return; }
    const activate = !touchMultitouch && !touchMoved;
    touchGesture = null;
    if (activate) touchTarget?.click();
    touchTarget = null;
  }, { passive: false });
  viewport.addEventListener("touchcancel", () => {
    touchGesture = null; touchTarget = null;
    touchMultitouch = true; suppressClickUntil = Date.now() + 600;
  });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || (isMobileInspiration() && !isMobileAlbumCanvas())) return;
    const isMiddlePan = event.button === 1;
    const isBlankLeftPan =
      event.button === 0 &&
      !event.target.closest("button, select, .inspiration-card");
    if (!isMiddlePan && !isBlankLeftPan) return;

    if (isMiddlePan) event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    originX = panX;
    originY = panY;
    viewport.classList.add("is-panning");
    viewport.setPointerCapture(event.pointerId);
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX = originX + event.clientX - startX;
    panY = originY + event.clientY - startY;
    applyTransform();
  });

  const endPan = (event) => {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove("is-panning");
    try {
      viewport.releasePointerCapture(event.pointerId);
    } catch (_) {}
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  viewport.addEventListener(
    "wheel",
    (event) => {
      if (isMobileInspiration() && !isMobileAlbumCanvas()) return;
      event.preventDefault();

      const deltaUnit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(320, viewport.clientHeight)
            : 1;
      let deltaX = event.deltaX * deltaUnit;
      let deltaY = event.deltaY * deltaUnit;

      // Obsidian-style zoom: Ctrl/Cmd + wheel (and trackpad pinch, which
      // browsers expose as a Ctrl+wheel gesture) zooms around the cursor.
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-deltaY * 0.00135);
        setZoom(zoom * factor, event.clientX, event.clientY);
        return;
      }

      // Shift + wheel turns a normal vertical mouse wheel into horizontal pan.
      if (event.shiftKey) {
        if (Math.abs(deltaX) < Math.abs(deltaY)) deltaX = deltaY;
        deltaY = 0;
      }

      // Plain wheel / two-finger trackpad scrolling pans the canvas rather than
      // scrolling the surrounding page, matching Obsidian Canvas muscle memory.
      panX -= deltaX;
      panY -= deltaY;
      applyTransform();
    },
    { passive: false },
  );
}

export function renderInspiration() {
  const page = document.getElementById("inspirationPage");
  const stage = document.getElementById("inspirationStage");
  const empty = document.getElementById("inspirationEmpty");
  const saveTodayBtn = document.getElementById("inspirationSaveTodayBtn");
  if (!page || !stage) return;

  revokeObjectUrls();
  imageObserver = createImageObserver();
  renderAlbumTabs();
  const allGroups = getGroups(activeAlbumId);
  const poseCounts = new Map();
  for (const group of allGroups) {
    for (const file of group.files) {
      const pose = aiFileAnalyses.get(fileAssignmentKey(file))?.analysis?.pose;
      if (!pose) continue;
      const count = poseCounts.get(pose) || 0;
      poseCounts.set(pose, count + 1);
    }
  }
  const aiCategories = [...poseCounts].map(([code, count]) => ({
    code,
    count,
    name: aiPoseLabel(code),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (aiPoseFilter !== "all" && !poseCounts.has(aiPoseFilter)) aiPoseFilter = "all";
  const groups = aiPoseFilter === "all"
    ? allGroups
    : allGroups.map(group => ({
        ...group,
        files: group.files.filter(file =>
          aiFileAnalyses.get(fileAssignmentKey(file))?.analysis?.pose === aiPoseFilter),
      })).filter(group => group.files.length > 0);
  const albums = loadAlbums();
  stage.innerHTML = "";
  renderMobileInspiration({
    albums,
    active: getActiveInspirationAlbumSnapshot(),
    getGroups,
    loadImage: loadLocalImage,
    openSource,
    aiCategories,
    aiFilter: aiPoseFilter,
    editAlbum: openAlbumEditor,
    selectAiCategory: category => {
      aiPoseFilter = category;
      renderInspiration();
    },
  });

  if (empty) empty.classList.toggle("hidden", groups.length > 0 || isMobileAlbumOverview());
  if (saveTodayBtn) saveTodayBtn.classList.toggle("hidden", activeAlbumId !== "today");

  if (!isMobileAlbumOverview()) groups.forEach((group) => stage.appendChild(buildLane(group, albums)));
  applyTransform();
  bindBoardInteractions();
}

export function initInspiration() {
  initMobileInspiration({
    render: renderInspiration,
    selectAlbum: selectInspirationAlbum,
    fitCanvas: fitMobileCanvas,
    renderGroupTools: renderMobileGroupTools,
    getAiAnalysis: getAiAnalysisForFile,
  });
  if (isMobileInspiration()) resetView();
  bindDouyinWebFrameEvents();
  document.getElementById("inspirationZoomOut")?.addEventListener("click", () =>
    setZoom(zoom - 0.15),
  );
  document.getElementById("inspirationZoomIn")?.addEventListener("click", () =>
    setZoom(zoom + 0.15),
  );
  document.getElementById("inspirationZoomReset")?.addEventListener("click", resetView);
  document.getElementById("inspirationNewAlbumBtn")?.addEventListener("click", () =>
    promptNewAlbum((album) => {
      selectInspirationAlbum(album.id);
    }),
  );
  document.getElementById("inspirationSaveTodayBtn")?.addEventListener("click", saveTodayAsAlbum);

  const galleryButton = document.getElementById("albumGalleryImportBtn");
  const galleryInput = document.getElementById("albumGalleryInput");
  if (isMobileInspiration() && galleryButton && galleryInput) {
    galleryButton.classList.remove("hidden");
    galleryButton.textContent = t("gallery-import-button");
    galleryButton.addEventListener("click", () => {
      galleryInput.value = "";
      galleryInput.click();
    });
    galleryInput.addEventListener("change", async () => {
      const files = [...(galleryInput.files || [])];
      galleryInput.value = "";
      try {
        await importGalleryFiles(files);
      } catch (_) {
        // The import function has already displayed the actionable error.
      }
    });
  }

  window.addEventListener("mori_file_saved", () => {
    const page = document.getElementById("inspirationPage");
    if (page && !page.classList.contains("hidden")) renderInspiration();
  });
  refreshAiFileAnalyses({ render: false }).then(() => {
    const page = document.getElementById("inspirationPage");
    if (page && !page.classList.contains("hidden")) renderInspiration();
  });
}

export function showImportedInspirationLibrary(library) {
  selectInspirationAlbum(library.albums[0]?.id || "all");
}
