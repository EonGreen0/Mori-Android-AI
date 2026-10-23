import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "public", "js", "sync", "androidPlannerReadOnlySync.js");
const source = await readFile(sourcePath, "utf8");
const fileSource = await readFile(path.join(root, "public", "js", "sync", "androidAssetFiles.js"), "utf8");
const { findAndroidDisplayFile, saveAndroidDisplayFile, androidDisplayFileOptions, removeAndroidDisplayFile } =
  await import(`data:text/javascript;base64,${Buffer.from(fileSource).toString("base64")}`);
const start = source.indexOf("function createAndroidPreviewResult(");
const end = source.indexOf("\nfunction stableValue(", start);
assert.notEqual(start, -1, "Android preview helpers are present");
assert.notEqual(end, -1, "Android preview helper block has a stable end marker");

let files = new Map();
function filesystem() {
  return {
    async stat({ path: filePath, directory }) {
      assert.equal(directory, "DATA", "synchronized images must use persistent storage");
      if (!files.has(filePath)) throw new Error("File missing");
      return { type: "file", size: files.get(filePath).length };
    },
    async getUri({ path: filePath }) { return { uri: `file:///data/files/${filePath}` }; },
    async writeFile({ path: filePath, data, directory }) {
      assert.equal(directory, "DATA");
      if (filePath.includes("d".repeat(64))) throw new Error("No space left on device");
      files.set(filePath, Buffer.from(data, "base64"));
      return { uri: `file:///data/files/${filePath}` };
    },
    async rename({ from, to }) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteFile({ path: filePath, directory }) {
      assert.equal(directory, "DATA");
      assert(filePath.startsWith("Mori/Sync/Images/"));
      files.delete(filePath);
    },
  };
}
const sandbox = {
  console: { warn() {} },
  Filesystem: filesystem(),
  findAndroidDisplayFile, saveAndroidDisplayFile, removeAndroidDisplayFile,
  bytesToBase64(bytes) { return Buffer.from(bytes).toString("base64"); },
  setStatus() {},
};
vm.createContext(sandbox);
new vm.Script(`${source.slice(start, end)}\nglobalThis.previewApi = {
  cachePlannerDisplayPreviews,
  androidPreviewCompletion,
};`).runInContext(sandbox);

const { cachePlannerDisplayPreviews, androidPreviewCompletion } = sandbox.previewApi;
const assetId = (letter) => `sha256:${letter.repeat(64)}`;
const node = (id, key) => ({ id, type: "image", assetId: assetId(key) });
const asset = (key) => ({ id: assetId(key), display: { hash: assetId(key), ext: "webp", bytes: 3 } });
const completionFor = (preview) => androidPreviewCompletion({ cursor: 12, receivedCount: 0 }, preview);
let cases = 0;

{
  let downloads = 0;
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() { downloads += 1; throw new Error("must not download a missing id"); },
  }, { nodes: [{ id: "legacy-image", type: "image" }], assets: [] });
  const completion = completionFor(preview);
  assert.equal(preview.nodeCount, 1);
  assert.equal(preview.missingMetadataCount, 1);
  assert.equal(downloads, 0);
  assert.equal(completion.state, "warning");
  assert.match(completion.text, /本地图片 0\/1/);
  assert.match(completion.text, /asset_id_missing/);
  cases += 1;
}

{
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() {
      const error = new Error("invalid_token");
      error.status = 401;
      throw error;
    },
  }, { nodes: [node("auth-node", "a")], assets: [asset("a")] });
  const completion = completionFor(preview);
  assert.equal(preview.authFailedCount, 1);
  assert.equal(preview.cloudMissingCount, 0);
  assert.equal(preview.bindings.length, 0);
  assert.equal(completion.state, "warning");
  assert.match(completion.text, /认证失败 1（HTTP 401）/);
  assert.match(completion.text, /检查 Android 个人同步密钥后重试/);
  assert.doesNotMatch(completion.text, /未上云/);
  cases += 1;
}

{
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() {
      const error = new Error("asset_display_missing");
      error.status = 404;
      throw error;
    },
  }, { nodes: [node("missing-cloud", "b"), node("missing-meta", "c")], assets: [asset("b")] });
  const completion = completionFor(preview);
  assert.equal(preview.cloudMissingCount, 1);
  assert.equal(preview.missingMetadataCount, 1);
  assert.match(completion.text, /云端预览对象缺失 1（HTTP 404）/);
  assert.match(completion.text, /策划资源元数据缺失 1（asset_metadata_missing）/);
  assert.match(completion.text, /确认 Windows 端预览已成功上传后重试/);
  cases += 1;
}

{
  sandbox.Filesystem = filesystem();
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() { return { bytes: new Uint8Array([1, 2, 3]) }; },
  }, {
    nodes: [node("good-node", "e"), node("cache-fail", "d")],
    assets: [asset("e"), asset("d")],
  });
  const completion = completionFor(preview);
  assert.equal(preview.cachedCount, 1);
  assert.equal(preview.cacheWriteFailedCount, 1);
  assert.equal(preview.bindings.length, 1);
  assert.equal(preview.bindings[0].nodeId, "good-node");
  assert.equal(completion.state, "warning");
  assert.match(completion.text, /本地图片保存失败 1（No space left on device）/);
  assert.match(completion.text, /检查设备存储空间后重试/);
  cases += 1;
}

{
  sandbox.Filesystem = { ...filesystem(), async writeFile() { throw new Error("unexpected cache write"); } };
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() { return { bytes: new Uint8Array() }; },
  }, { nodes: [node("empty-node", "f")], assets: [asset("f")] });
  const completion = completionFor(preview);
  assert.equal(preview.emptyResponseCount, 1);
  assert.equal(preview.cacheWriteFailedCount, 0);
  assert.match(completion.text, /云端响应为空 1（empty_display_response）/);
  cases += 1;
}

{
  const preview = await cachePlannerDisplayPreviews({
    async downloadDisplayAsset() { throw new Error("android_sync_request_timeout"); },
  }, { nodes: [node("network-node", "g")], assets: [asset("g")] });
  const completion = completionFor(preview);
  assert.equal(preview.networkFailedCount, 1);
  assert.match(completion.text, /网络\/服务失败 1（android_sync_request_timeout）/);
  assert.match(completion.text, /检查网络和同步服务后重试/);
  cases += 1;
}

{
  files = new Map();
  sandbox.Filesystem = filesystem();
  let downloads = 0;
  const shared = { nodes: [node("first", "a"), node("duplicate", "a")], assets: [asset("a")] };
  const transport = { async downloadDisplayAsset() { downloads += 1; return { bytes: new Uint8Array([1, 2, 3]) }; } };
  const first = await cachePlannerDisplayPreviews(transport, shared);
  assert.equal(downloads, 1, "same asset on two nodes downloads once");
  assert.equal(first.bindings.length, 2);
  assert.equal(first.reusedCount, 0);
  assert.equal(files.size, 1, "temporary write must be promoted to one persistent file");
  const offline = { async downloadDisplayAsset() { throw new Error("offline network must not be used"); } };
  // A fresh invocation only uses the Filesystem, without an in-memory cache.
  const again = await cachePlannerDisplayPreviews(offline, structuredClone(shared));
  assert.equal(again.reusedCount, 1);
  assert.equal(again.bindings.length, 2);
  assert.equal(again.bindings[0].uri, first.bindings[0].uri);
  assert.equal(again.missingCount, 0);
  cases += 1;

  const oldPath = androidDisplayFileOptions(shared.assets[0]).path;
  shared.assets[0].display.hash = assetId("b");
  const updated = await cachePlannerDisplayPreviews(transport, shared);
  assert.equal(downloads, 2, "new display version must download once");
  assert.notEqual(updated.bindings[0].uri, first.bindings[0].uri);
  assert(files.has(oldPath), "previous local version must not be deleted");
  cases += 1;

  const path = androidDisplayFileOptions(shared.assets[0]).path;
  files.set(path, Buffer.from([1]));
  await cachePlannerDisplayPreviews(transport, shared);
  assert.equal(downloads, 3, "truncated local file must be fetched again");
  assert.equal(files.get(path).length, 3);
  cases += 1;

  files.delete(path);
  await cachePlannerDisplayPreviews(transport, shared);
  assert.equal(downloads, 4, "missing local file must be fetched again");
  cases += 1;

  files.delete(path);
  const short = await cachePlannerDisplayPreviews({ async downloadDisplayAsset() { return { bytes: new Uint8Array([1]) }; } }, shared);
  assert.equal(short.bindings.length, 0);
  assert.equal(short.incompleteResponseCount, 1);
  assert.equal(short.cacheWriteFailedCount, 0);
  assert.match(completionFor(short).text, /云端图片内容不完整/);
  assert(!files.has(path), "incomplete remote response must not become a persistent file");
  cases += 1;

  sandbox.Filesystem = { ...filesystem(), async rename() { throw new Error("rename failed"); } };
  const interrupted = await cachePlannerDisplayPreviews(transport, shared);
  assert.equal(interrupted.bindings.length, 0);
  assert(files.has(`${path}.part`));
  assert(!files.has(path), "interrupted promotion cannot be reused");
  sandbox.Filesystem = filesystem();
  await cachePlannerDisplayPreviews(transport, shared);
  assert(files.has(path));
  assert(!files.has(`${path}.part`));
  cases += 1;
}

{
  files = new Map(); sandbox.Filesystem = filesystem();
  const shared = { nodes: [node("reset", "a"), node("same", "a")], assets: [asset("a")] };
  const managed = androidDisplayFileOptions(shared.assets[0]).path;
  const unrelated = androidDisplayFileOptions(asset("b")).path;
  files.set(managed, Buffer.from([9, 9, 9])); files.set(`${managed}.part`, Buffer.from([9]));
  files.set(unrelated, Buffer.from([8, 8, 8])); files.set("Pictures/original.jpg", Buffer.from([7]));
  let downloads = 0;
  const reset = await cachePlannerDisplayPreviews({ async downloadDisplayAsset() {
    downloads += 1; assert(!files.has(managed) && !files.has(`${managed}.part`));
    return { bytes: new Uint8Array([1, 2, 3]) };
  } }, shared, { forceDownload: true });
  assert.equal(downloads, 1); assert.equal(reset.reusedCount, 0); assert.equal(reset.bindings.length, 2);
  assert.deepEqual([...files.get(managed)], [1, 2, 3]);
  assert(files.has(unrelated) && files.has("Pictures/original.jpg"), "only selected generated files are removed");
  cases += 1;
  sandbox.Filesystem = { ...filesystem(), async deleteFile() { throw new Error("delete denied"); } };
  const denied = await cachePlannerDisplayPreviews({ async downloadDisplayAsset() { throw new Error("must not download after deletion failure"); } }, shared, { forceDownload: true });
  assert.equal(denied.cacheWriteFailedCount, 1); assert.equal(denied.bindings.length, 0); assert(files.has(managed));
  cases += 1;
  sandbox.Filesystem = filesystem();
  const missing = await cachePlannerDisplayPreviews({ async downloadDisplayAsset() { const error = new Error("missing_cloud_image"); error.status = 404; throw error; } }, shared, { forceDownload: true });
  assert.equal(missing.cloudMissingCount, 1); assert(!files.has(managed));
  assert(files.has(unrelated)); cases += 1;
  await assert.rejects(removeAndroidDisplayFile({ async stat() { throw new Error("must not access invalid paths"); } }, { id: "../../original", display: { hash: assetId("a") } }), /invalid_asset/);
  const absent = await removeAndroidDisplayFile(filesystem(), asset("a")); assert.equal(absent, 0);
  cases += 1;
}
{
  const refreshStart = source.indexOf("async function refreshSelectedProject(");
  const refreshEnd = source.indexOf("\nasync function uploadPlannerChange(", refreshStart);
  let pulls = 0, caches = 0, pending = false;
  const refreshContext = {
    busy: false, console: { warn() {} },
    elements: () => ({ select: { value: "p", selectedOptions: [{ dataset: { title: "A" } }] } }),
    setStatus() {}, setBusy: (value) => { refreshContext.busy = value; },
    prepareAndroidReadOnlyPlannerProject: async () => ({ generation: 1 }),
    listPlannerOutbox: async () => pending ? [{ opId: "keep-this-edit" }] : [],
    pullPlannerRemoteStateReadOnly: async (options) => { pulls += 1; assert.equal(options.fromStart, true); return { status: "ok", merged: { nodes: [{ type: "image" }] } }; },
    cachePlannerDisplayPreviews: async (_transport, _shared, options) => { caches += 1; assert.equal(options.forceDownload, true); return { bindings: [] }; },
    createAndroidPreviewResult: () => ({ bindings: [] }),
    bindAndroidPlannerDisplayPreviews: (_bindings, options) => { assert.equal(options.expectedProjectId, "p"); assert.equal(options.resetSyncedImages, true); },
    androidPreviewCompletion: () => ({ text: "result", state: "warning" }),
  };
  vm.createContext(refreshContext);
  vm.runInContext(source.slice(refreshStart, refreshEnd) + "\nglobalThis.refresh = refreshSelectedProject;", refreshContext);
  await refreshContext.refresh({}, { resetImages: true });
  assert.equal(pulls, 1); assert.equal(caches, 1); assert.equal(refreshContext.busy, false);
  pending = true;
  await assert.rejects(refreshContext.refresh({}, { resetImages: true }), /待上传修改/);
  assert.equal(pulls, 1); assert.equal(caches, 1, "pending edits block reset before any cache deletion");
  assert.equal(refreshContext.busy, false);
  cases += 1;
}
process.stdout.write(`Android preview errors and persistent files passed (${cases} cases).\n`);
