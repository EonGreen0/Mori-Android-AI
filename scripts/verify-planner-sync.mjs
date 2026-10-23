import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromSource = createRequire(import.meta.url);
const { build } = requireFromSource("esbuild");

const entry = fileURLToPath(new URL("../public/js/sync/plannerAdapter.js", import.meta.url));
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
});

const source = bundle.outputFiles[0].text;
const adapter = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const board = {
  nodes: [
    {
      id: "image_a",
      type: "image",
      fileKey: "D:\\Mori\\photo.jpg",
      path: "D:\\Mori\\photo.jpg",
      uri: "file:///D:/Mori/photo.jpg",
      thumbnail: "blob:local-preview",
      title: "Reference",
      sourceUrl: "https://example.com/post/1",
      albumId: "album_1",
      x: 120,
      y: 220,
      w: 280,
      rotation: 90,
      comment: "pose",
    },
    {
      id: "image_b",
      type: "image",
      assetId: "sha256:abc123",
      fileKey: "sha256:abc123",
      path: "content://device/image-b",
      uri: "content://device/image-b",
      x: 400,
      y: 200,
      w: 240,
    },
    {
      id: "text_a",
      type: "text",
      text: "shoot at sunset",
      x: 40,
      y: 50,
      w: 190,
      fontSize: 16,
      textColor: "#171717",
      background: "#fffaf0",
    },
    {
      id: "group_a",
      type: "group",
      text: "Standing poses",
      x: 20,
      y: 20,
      w: 700,
      h: 500,
      memberIds: ["image_a", "image_b"],
    },
  ],
  edges: [
    {
      id: "edge_a",
      from: "text_a",
      to: "image_a",
      fromSide: "right",
      toSide: "left",
    },
  ],
  view: { zoom: 0.42, panX: 300, panY: -80 },
  importCount: 3,
  commentFontSize: 17,
  projectId: "project_demo",
  projectTitle: "Demo Plan",
  readOnly: false,
  futurePlannerField: { keepMe: true },
};

const { shared, local } = adapter.splitPlannerBoardForSync(board);
assert.equal(shared.schemaVersion, 1);
assert.equal(shared.project.id, "project_demo");
assert.deepEqual(local.view, board.view);
assert.equal(local.readOnly, false);
assert.equal(shared.nodes[0].path, undefined);
assert.equal(shared.nodes[0].uri, undefined);
assert.equal(shared.nodes[0].thumbnail, undefined);
assert.equal(shared.nodes[0].fileKey, undefined);
assert.equal(shared.nodes[1].fileKey, "sha256:abc123");
assert.equal(local.nodeFiles.image_a.path, "D:\\Mori\\photo.jpg");
assert.equal(local.nodeFiles.image_b.path, "content://device/image-b");

const serializedShared = JSON.stringify(shared);
assert.equal(serializedShared.includes("D:\\\\Mori"), false);
assert.equal(serializedShared.includes("content://device"), false);
assert.equal(serializedShared.includes("blob:local-preview"), false);

const restored = adapter.mergePlannerBoardFromSync(shared, local);
assert.deepEqual(restored, board);
assert.deepEqual(adapter.plannerBoardRoundTrip(board), board);

const remoteDeviceBoard = adapter.mergePlannerBoardFromSync(shared, {
  view: { zoom: 1, panX: 0, panY: 0 },
  readOnly: true,
});
assert.equal(remoteDeviceBoard.nodes[0].path, undefined);
assert.equal(remoteDeviceBoard.nodes[1].assetId, "sha256:abc123");
assert.deepEqual(remoteDeviceBoard.view, { zoom: 1, panX: 0, panY: 0 });
assert.equal(remoteDeviceBoard.readOnly, true);

const changedAssetShared = structuredClone(shared);
changedAssetShared.nodes[1].assetId = "sha256:def456";
changedAssetShared.nodes[1].fileKey = "sha256:def456";
const changedAssetBoard = adapter.mergePlannerBoardFromSync(changedAssetShared, local);
assert.equal(changedAssetBoard.nodes[1].assetId, "sha256:def456");
assert.equal(changedAssetBoard.nodes[1].path, undefined);
assert.equal(changedAssetBoard.nodes[1].uri, undefined);

console.log("Planner sync adapter verification passed.");
