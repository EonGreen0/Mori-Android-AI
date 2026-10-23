// Offline album exchange. IDs in this file are package-local, never cloud project IDs.
export const ALBUM_PACKAGE_MAGIC = "MORI-ALBUM-1\n";
export const MAX_ALBUM_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const fail = () => { throw new Error("相册包格式无效或不完整，未修改原有相册"); };
const record = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 2000) => typeof value === "string" && value.length <= max ? value : fail();
const number = value => Number.isFinite(value) ? value : fail();
const array = (value, max) => Array.isArray(value) && value.length <= max ? value : fail();

function sourceUrl(value) {
  if (!value) return "";
  const raw = text(value, 8192);
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
  catch (_) { return ""; }
}

function validateManifest(manifest, payloadLength) {
  if (!record(manifest) || manifest.format !== "mori-album-package" || manifest.version !== 1 || !record(manifest.album)) fail();
  text(manifest.album.name); text(manifest.createdAt, 100);
  const assets = array(manifest.assets, 5000);
  const ids = new Set();
  let offset = 0;
  for (const asset of assets) {
    if (!record(asset) || !/^image_\d+$/.test(asset.id) || ids.has(asset.id) ||
        !Number.isSafeInteger(asset.offset) || asset.offset !== offset ||
        !Number.isSafeInteger(asset.length) || asset.length <= 0 || asset.length > 12 * 1024 * 1024) fail();
    ids.add(asset.id); offset += asset.length;
  }
  if (offset !== payloadLength) fail();
  let fileCount = 0;
  for (const group of array(manifest.album.groups, 5000)) {
    if (!record(group)) fail();
    text(group.title); sourceUrl(group.sourceUrl); number(group.timestamp);
    if (typeof group.hasVideo !== "boolean") fail();
    for (const file of array(group.files, 5000)) {
      if (++fileCount > 20000) fail();
      if (!record(file) || !ids.has(file.assetId) || typeof file.frame !== "boolean") fail();
      text(file.title); number(file.savedAt); number(file.frameTime);
    }
  }
  if (manifest.planner !== null) {
    const planner = manifest.planner;
    if (!record(planner) || !record(planner.view)) fail();
    text(planner.title); number(planner.view.zoom); number(planner.view.panX); number(planner.view.panY);
    const nodeIds = new Set();
    for (const node of array(planner.nodes, 10000)) {
      if (!record(node) || !["image", "text", "group"].includes(node.type) ||
          !text(node.id, 200) || nodeIds.has(node.id)) fail();
      if (node.type === "image" && !ids.has(node.assetId)) fail();
      if (["path", "uri", "thumbnail"].some(key => node[key])) fail();
      for (const key of ["x", "y", "w", "h", "rotation"]) if (node[key] !== undefined) number(node[key]);
      if (node.text !== undefined) text(node.text, 100000);
      if (node.title !== undefined) text(node.title);
      nodeIds.add(node.id);
    }
    for (const edge of array(planner.edges, 20000)) {
      if (!record(edge) || !text(edge.id, 200) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail();
    }
  }
  return manifest;
}

export function encodeAlbumPackage(manifest, imageBytes) {
  const payloadLength = imageBytes.reduce((total, bytes) => total + bytes.length, 0);
  validateManifest(manifest, payloadLength);
  if (imageBytes.length !== manifest.assets.length || imageBytes.some((bytes, i) => bytes.length !== manifest.assets[i].length)) fail();
  const magic = new TextEncoder().encode(ALBUM_PACKAGE_MAGIC);
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const size = magic.length + 4 + json.length + payloadLength;
  if (json.length > MAX_MANIFEST_BYTES || size > MAX_ALBUM_PACKAGE_BYTES) throw new Error("相册包超过 128 MB，请拆成几个较小相册后导出");
  const bytes = new Uint8Array(size);
  bytes.set(magic);
  new DataView(bytes.buffer).setUint32(magic.length, json.length, true);
  bytes.set(json, magic.length + 4);
  let cursor = magic.length + 4 + json.length;
  for (const image of imageBytes) { bytes.set(image, cursor); cursor += image.length; }
  return bytes;
}

export function parseAlbumPackage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ALBUM_PACKAGE_BYTES) fail();
  const magic = new TextEncoder().encode(ALBUM_PACKAGE_MAGIC);
  if (bytes.length < magic.length + 4 || magic.some((byte, i) => byte !== bytes[i])) fail();
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length, true);
  const payloadStart = magic.length + 4 + length;
  if (!length || length > MAX_MANIFEST_BYTES || payloadStart > bytes.length) fail();
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(magic.length + 4, payloadStart))); }
  catch (_) { fail(); }
  validateManifest(manifest, bytes.length - payloadStart);
  return { manifest, images: manifest.assets.map(asset => bytes.subarray(payloadStart + asset.offset, payloadStart + asset.offset + asset.length)) };
}

export async function buildAlbumPackage(snapshot, planner, { readImage, prepareImage, onProgress = () => {} }) {
  const assets = [], images = [], byPath = new Map();
  let totalBytes = 0;
  const addImage = async file => {
    const path = String(file.uri || file.path || "");
    if (!path) throw new Error(`图片缺少本地文件：${file.title || "参考图"}`);
    if (byPath.has(path)) return byPath.get(path);
    onProgress(`正在打包图片 ${assets.length + 1}…`);
    const raw = await readImage(path);
    const prepared = await prepareImage(raw, path);
    const bytes = prepared.displayBytes;
    if (!bytes?.length || prepared.asset.display.mime !== "image/jpeg") throw new Error(`图片无法转为预览：${file.title || "参考图"}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_ALBUM_PACKAGE_BYTES) throw new Error("相册包超过 128 MB，请拆成几个较小相册后导出");
    const assetId = `image_${assets.length + 1}`;
    assets.push({ id: assetId, offset: totalBytes - bytes.length, length: bytes.length });
    images.push(bytes); byPath.set(path, assetId); return assetId;
  };
  const groups = [];
  for (const group of snapshot.groups) {
    const files = [];
    for (const file of group.files) files.push({ assetId: await addImage(file), title: String(file.title || group.title || "参考图"),
      frame: file.frame === true, frameTime: Number(file.frameTime) || 0, savedAt: Number(file.savedAt) || 0 });
    groups.push({ title: String(group.title || "参考图"), sourceUrl: sourceUrl(group.sourceUrl), timestamp: Number(group.timestamp) || 0,
      hasVideo: group.hasVideo === true, files });
  }
  let plan = null;
  if (planner) {
    const nodes = [];
    for (const node of planner.nodes) {
      const copy = { ...node };
      if (node.type === "image") { copy.assetId = await addImage(node); copy.fileKey = copy.assetId; }
      for (const key of ["path", "uri", "thumbnail", "albumId"]) delete copy[key];
      nodes.push(copy);
    }
    plan = { title: String(planner.projectTitle || snapshot.albums[0].name), nodes, edges: planner.edges,
      view: planner.view, importCount: planner.importCount, commentFontSize: planner.commentFontSize };
  }
  const manifest = { format: "mori-album-package", version: 1, createdAt: new Date().toISOString(),
    album: { name: String(snapshot.albums[0].name), groups }, planner: plan, assets };
  return { bytes: encodeAlbumPackage(manifest, images), manifest };
}

export function materializeAlbumPackage(manifest, paths, importId) {
  if (!/^[a-zA-Z0-9-]+$/.test(importId)) fail();
  if (manifest.assets.some(asset => !paths.get(asset.id))) throw new Error("相册图片未全部保存，已保留原有内容");
  const albumId = `package:${importId}`, projectId = manifest.planner ? `local-album-plan:${importId}` : "";
  const library = { title: manifest.album.name, localPackage: true, importedAt: Date.now(),
    albums: [{ id: albumId, name: manifest.album.name, synced: true, localPackage: true, syncProjectId: "", plannerProjectId: projectId }],
    groups: manifest.album.groups.map((group, i) => ({
      syncGroupId: `local-package:${importId}:${i}`, title: group.title, sourceUrl: sourceUrl(group.sourceUrl), timestamp: group.timestamp,
      syncedAlbumIds: [albumId], syncedVideoLink: group.hasVideo,
      localFiles: group.files.map(file => ({ uri: paths.get(file.assetId), assetId: file.assetId, title: file.title,
        type: file.frame ? "FRAME" : "IMAGE", isReferenceFrame: file.frame, frameTime: file.frameTime, savedAt: file.savedAt })),
    })) };
  const planner = manifest.planner ? { ...manifest.planner, projectId, projectTitle: manifest.planner.title,
    readOnly: true, localPackage: true, nodes: manifest.planner.nodes.map(node => node.type === "image"
      ? { ...node, uri: paths.get(node.assetId), path: "", thumbnail: "", albumId } : { ...node }) } : null;
  return { library, planner, albumId, libraryId: `local-package:${importId}` };
}
