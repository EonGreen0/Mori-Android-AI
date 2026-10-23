import { validateSyncEnvelope } from "./model.js";

export const ALBUM_LIBRARY_PREFIX = "album-library:";
export const SYNCED_ALBUMS_KEY = "mori_synced_albums_v1";

export function isAlbumLibraryProject(projectId) {
  return String(projectId || "").startsWith(ALBUM_LIBRARY_PREFIX);
}

export function sourceLink(value) {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch (_) { return ""; }
}

// Identities belong to this device. File paths are used only in this local map
// and the board's local bindings; the existing adapter removes them on upload.
export async function createAlbumLibraryBoard(snapshot, {
  projectId, identities = {}, previous = null, resolveAsset,
  idFactory = () => crypto.randomUUID(), onProgress = () => {}, plannerProjectId = "", sourceLibraryId = "",
} = {}) {
  if (!isAlbumLibraryProject(projectId)) throw new Error("Invalid album library identity");
  const ids = new Map(Object.entries(identities));
  const identity = key => {
    if (!ids.has(key)) ids.set(key, idFactory());
    return ids.get(key);
  };
  const nodes = [];
  const assets = new Map();
  const previousNodes = new Map((previous?.nodes || []).map(node => [node.id, node]));
  const previousAssets = new Map((previous?.assets || []).map(asset => [asset.id, asset]));
  const failures = [];
  const total = snapshot.groups.reduce((count, group) => count + group.files.length, 0);
  let index = 0;
  for (const [groupIndex, group] of snapshot.groups.entries()) {
    const groupId = identity(`group:${group.key}`);
    nodes.push({
      id: groupId, type: "album-source", title: group.title,
      sourceUrl: sourceLink(group.sourceUrl), timestamp: group.timestamp,
      albumIds: group.albumIds, hasVideo: group.hasVideo, order: groupIndex,
    });
    const seenFiles = new Set();
    for (const [fileIndex, file] of group.files.entries()) {
      const path = String(file.path || file.uri || "");
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      const id = identity(`file:${group.key}\n${path}`);
      onProgress(++index, total);
      let asset;
      try {
        if (!path) throw new Error("图片没有本地文件路径");
        asset = await resolveAsset(file);
      } catch (error) {
        const old = previousNodes.get(id);
        asset = previousAssets.get(old?.assetId);
        failures.push({ title: file.title || group.title, message: String(error?.message || error) });
      }
      if (asset) assets.set(asset.id, asset);
      nodes.push({
        id, type: "image", groupId, title: file.title || group.title,
        ...(asset ? { assetId: asset.id } : {}),
        savedAt: file.savedAt || group.timestamp, frame: file.frame === true,
        frameTime: Number(file.frameTime) || 0, order: fileIndex, path, uri: file.uri || path,
      });
    }
  }
  return {
    board: {
      projectId, projectTitle: snapshot.sourceAlbumId ? snapshot.albums[0].name : "相册资料库", kind: "album-library", libraryVersion: 1,
      ...(snapshot.sourceAlbumId ? { sourceAlbumId: snapshot.sourceAlbumId, sourceLibraryId, plannerProjectId } : {}),
      albums: snapshot.albums, nodes, edges: [],
    },
    assets: [...assets.values()], identities: Object.fromEntries(ids), failures,
  };
}

function readLibraries(storage) {
  const value = JSON.parse(storage.getItem(SYNCED_ALBUMS_KEY) || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地同步相册记录无法读取");
  return value;
}

export function importedAlbumLibrary(shared, bindings = []) {
  const validation = validateSyncEnvelope(shared);
  if (!validation.valid || !isAlbumLibraryProject(shared?.project?.id) ||
      shared.project.payload?.kind !== "album-library" || shared.project.payload.libraryVersion !== 1) {
    throw new Error("云端相册数据格式无效，已保留原相册");
  }
  const projectId = shared.project.id;
  const albumId = id => `synced:${projectId}:${id}`;
  const albums = (shared.project.payload.albums || []).map(album => ({
    id: albumId(album.id), name: String(album.name || "相册"), synced: true,
    syncProjectId: projectId,
    plannerProjectId: shared.project.payload.sourceAlbumId === album.id ? String(shared.project.payload.plannerProjectId || "") : "",
  }));
  const albumIds = new Set(albums.map(album => album.id));
  const files = new Map(bindings.map(binding => [binding.nodeId, binding]));
  const assets = new Map(shared.assets.map(asset => [asset.id, asset]));
  const groups = new Map(shared.nodes.filter(node => node.type === "album-source")
    .sort((a, b) => (a.order || 0) - (b.order || 0)).map(node => [node.id, {
    syncGroupId: `${projectId}:${node.id}`, title: String(node.title || "参考图"),
    sourceUrl: sourceLink(node.sourceUrl), timestamp: Number(node.timestamp) || 0,
    syncedAlbumIds: (node.albumIds || []).map(albumId).filter(id => albumIds.has(id)),
    syncedVideoLink: node.hasVideo === true, localFiles: [],
  }]));
  for (const node of [...shared.nodes].sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (node.type !== "image" || !groups.has(node.groupId)) continue;
    const binding = files.get(node.id);
    const uri = binding?.assetId === node.assetId ? String(binding.uri || "") : "";
    groups.get(node.groupId).localFiles.push({
      assetId: node.assetId || "", uri, title: String(node.title || "参考图"),
      type: node.frame ? "FRAME" : "IMAGE", isReferenceFrame: node.frame === true,
      frameTime: Number(node.frameTime) || 0, savedAt: Number(node.savedAt) || 0,
      displayHash: assets.get(node.assetId)?.display?.hash || "", syncMissing: !uri,
    });
  }
  return { title: shared.project.title, albums, groups: [...groups.values()], plannerProjectId: String(shared.project.payload.plannerProjectId || ""),
    sourceAlbumId: String(shared.project.payload.sourceAlbumId || ""), sourceLibraryId: String(shared.project.payload.sourceLibraryId || "") };
}

export function saveImportedAlbumLibrary(shared, bindings, storage = localStorage) {
  const library = importedAlbumLibrary(shared, bindings);
  const libraries = readLibraries(storage);
  libraries[shared.project.id] = library;
  // A single replacement preserves the previous library if storage is full.
  storage.setItem(SYNCED_ALBUMS_KEY, JSON.stringify(libraries));
  return library;
}

export function getImportedAlbumLibraries(storage = localStorage) {
  try {
    const entries = Object.entries(readLibraries(storage)).filter(([, library]) =>
      library && Array.isArray(library.albums) && Array.isArray(library.groups));
    const replacements = new Set(entries.filter(([, library]) => library.sourceLibraryId && library.sourceAlbumId)
      .map(([, library]) => `synced:${library.sourceLibraryId}:${library.sourceAlbumId}`));
    // A new scoped import supersedes the same album in an older full-library
    // view. Keep the old stored records and files recoverable; avoid duplicate
    // sidebar tabs and material lanes when upgrading from the previous build.
    return entries.map(([, library]) => {
      if (library.sourceAlbumId) return library;
      const hidden = new Set(library.albums.filter(album => replacements.has(album.id)).map(album => album.id));
      if (!hidden.size) return library;
      return { ...library, albums: library.albums.filter(album => !hidden.has(album.id)),
        groups: library.groups.flatMap(group => {
          const ids = (group.syncedAlbumIds || []).filter(id => !hidden.has(id));
          return group.syncedAlbumIds?.length && !ids.length ? [] : [{ ...group, syncedAlbumIds: ids }];
        }) };
    });
  }
  catch (error) { console.warn("Synced albums unavailable:", error); return []; }
}
