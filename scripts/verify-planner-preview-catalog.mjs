import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "public", "js", "modules", "planner.js");
const source = await readFile(sourcePath, "utf8");
const catalogSource = await readFile(path.join(root, "public", "js", "sync", "assetCatalog.js"), "utf8");
const { plannerAssetNeedsDisplayRebuild } = await import(`data:text/javascript;base64,${Buffer.from(catalogSource).toString("base64")}`);
const start = source.indexOf("export async function catalogCurrentPlannerImagesForSync(");
const end = source.indexOf("\nexport async function stageCurrentPlannerForManualSync(", start);
assert.notEqual(start, -1, "Planner image catalog function is present");
assert.notEqual(end, -1, "Planner image catalog function has a stable end marker");
const functionSource = source
  .slice(start, end)
  .replace("export async function catalogCurrentPlannerImagesForSync(", "async function catalogCurrentPlannerImagesForSync(");

const oldId = `sha256:${"a".repeat(64)}`;
const actualId = `sha256:${"f".repeat(64)}`;
const displayHash = `sha256:${"e".repeat(64)}`;
const completeAsset = {
  id: oldId,
  type: "image",
  source: { hash: oldId, mime: "image/jpeg", ext: "jpg", bytes: 3 },
  display: { hash: displayHash, mime: "image/jpeg", ext: "jpg", bytes: 2, encoding: { algorithm: "canvas-reference-v1", maxSide: 2048, quality: 0.88 } },
};

function createHarness({
  board = { projectId: "project-a", nodes: [] },
  assets = [],
  readBytes = async () => new Uint8Array([1, 2, 3]),
  prepareAsset = async (bytes) => {
    const id = bytes[0] === 2 ? oldId : actualId;
    return {
      asset: {
        id,
        type: "image",
        source: { hash: id, mime: "image/jpeg", ext: "jpg", bytes: bytes.length },
        display: structuredClone(completeAsset.display),
      },
    };
  },
  onPut = async () => {},
} = {}) {
  const assetsById = new Map(assets.map((asset) => [String(asset.id), asset]));
  const state = {
    activePlannerProjectId: "project-a",
    board,
    plannerLocalGeneration: 7,
    plannerSyncStageQueue: Promise.resolve(),
    isAndroidNative: () => false,
    plannerAssetNeedsDisplayRebuild,
    assertActivePlannerSyncTarget(options = {}) {
      const projectId = String(state.activePlannerProjectId || state.board?.projectId || "");
      if (options.expectedProjectId && String(options.expectedProjectId) !== projectId) {
        throw new Error("Planner project changed while sync was in progress");
      }
      if (options.expectedGeneration !== undefined && Number(options.expectedGeneration) !== state.plannerLocalGeneration) {
        throw new Error("Planner changed while sync was in progress");
      }
      return projectId;
    },
    async getPlannerAssetsByIds(ids) {
      state.lookups.push([...ids]);
      const wanted = new Set(ids.map(String));
      return [...assetsById.values()].filter((asset) => wanted.has(String(asset.id)));
    },
    async readPlannerNodeBytes(node) {
      state.reads.push(String(node.id));
      return readBytes(node);
    },
    guessMime() { return "image/jpeg"; },
    async preparePlannerImageAsset(bytes, options) { return prepareAsset(bytes, options); },
    createPlannerAssetLocalBinding(assetId, local) { return { assetId, ...local }; },
    async putPlannerAsset(asset, binding) {
      state.puts.push({ asset, binding });
      assetsById.set(String(asset.id), asset);
      await onPut({ state, asset, binding });
    },
    saveBoard(options) {
      state.saves.push(options);
      if (options?.markLocalChange !== false) state.plannerLocalGeneration += 1;
    },
    console: { warn() {} },
    lookups: [],
    reads: [],
    puts: [],
    saves: [],
  };

  vm.createContext(state);
  new vm.Script(`${functionSource}\nglobalThis.catalogApi = catalogCurrentPlannerImagesForSync;`).runInContext(state);
  return { state, catalog: state.catalogApi };
}

let cases = 0;

{
  const legacy = { ...completeAsset, display: { hash: displayHash, mime: "image/webp", ext: "webp", bytes: 2 } };
  const node = { id: "legacy-format", type: "image", assetId: oldId, path: "C:/Planner/source.jpg", x: 17, comment: "keep" };
  const { state, catalog } = createHarness({
    board: { projectId: "project-a", nodes: [node] }, assets: [legacy],
    readBytes: async () => new Uint8Array([2, 3, 4]),
  });
  const migrated = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.equal(migrated.cataloguedCount, 1);
  assert.equal(state.puts[0].asset.id, oldId, "encoding migration must preserve source identity");
  assert.equal(state.puts[0].asset.display.mime, "image/jpeg");
  assert.equal(node.assetId, oldId);
  assert.equal(node.x, 17);
  assert.equal(node.comment, "keep");
  assert.equal(node.path, "C:/Planner/source.jpg");
  const again = await catalog({ expectedProjectId: "project-a", expectedGeneration: state.plannerLocalGeneration });
  assert.equal(again.cataloguedCount, 0);
  assert.deepEqual(state.reads, ["legacy-format"], "current encoding must not be rebuilt on every sync");
  cases += 1;

  const missing = createHarness({
    board: { projectId: "project-a", nodes: [{ ...node }] }, assets: [legacy],
    readBytes: async () => new Uint8Array(),
  });
  const skipped = await missing.catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.equal(skipped.skippedCount, 1);
  assert.equal(missing.state.puts.length, 0, "missing original must preserve the existing display catalog");
  assert.equal(missing.state.board.nodes[0].assetId, oldId);
  cases += 1;

  const imported = createHarness({
    board: { projectId: "project-a", nodes: [{ ...node }] }, assets: [legacy],
    prepareAsset: async () => ({ asset: {
      id: displayHash, type: "image", source: { hash: displayHash, mime: "image/webp", bytes: 2 },
      display: structuredClone(completeAsset.display),
    } }),
  });
  await imported.catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.equal(imported.state.puts[0].asset.id, oldId, "known package display copy must keep the original source identity");
  assert.deepEqual(JSON.parse(JSON.stringify(imported.state.puts[0].asset.source)), legacy.source);
  assert.equal(imported.state.board.nodes[0].assetId, oldId);
  cases += 1;
}

{
  const node = {
    id: "stale-id",
    type: "image",
    assetId: oldId,
    fileKey: oldId,
    path: "C:/Planner/current.jpg",
    uri: "C:/Planner/current.jpg",
    title: "keep title",
    x: 37,
    y: 91,
    comment: "keep comment",
  };
  const { state, catalog } = createHarness({ board: { projectId: "project-a", nodes: [node] } });
  const result = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.deepEqual(state.lookups, [[oldId]]);
  assert.deepEqual(state.reads, ["stale-id"]);
  assert.equal(state.puts[0].asset.id, actualId);
  assert.equal(node.assetId, actualId);
  assert.equal(node.fileKey, actualId);
  assert.equal(node.path, "C:/Planner/current.jpg");
  assert.equal(node.uri, "C:/Planner/current.jpg");
  assert.equal(node.title, "keep title");
  assert.equal(node.x, 37);
  assert.equal(node.y, 91);
  assert.equal(node.comment, "keep comment");
  assert.equal(result.cataloguedCount, 1);
  assert.equal(result.skippedCount, 0);
  cases += 1;
}

{
  const node = {
    id: "no-id",
    type: "image",
    fileKey: "C:/Planner/new.jpg",
    path: "C:/Planner/new.jpg",
    uri: "C:/Planner/new.jpg",
    title: "new local image",
    w: 420,
  };
  const { state, catalog } = createHarness({ board: { projectId: "project-a", nodes: [node] } });
  const result = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.deepEqual(state.lookups, [[]]);
  assert.equal(node.assetId, actualId);
  assert.equal(node.fileKey, actualId);
  assert.equal(node.path, "C:/Planner/new.jpg");
  assert.equal(node.w, 420);
  assert.equal(result.cataloguedCount, 1);
  cases += 1;
}

{
  const node = { id: "catalogued", type: "image", assetId: oldId, path: "C:/Planner/ready.jpg" };
  const { state, catalog } = createHarness({
    board: { projectId: "project-a", nodes: [node] },
    assets: [completeAsset],
  });
  const result = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.deepEqual(state.lookups, [[oldId]]);
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.puts, []);
  assert.deepEqual(state.saves, []);
  assert.equal(node.assetId, oldId);
  assert.equal(result.cataloguedCount, 0);
  assert.equal(result.totalCount, 1);
  cases += 1;
}

{
  const node = {
    id: "missing-file",
    type: "image",
    assetId: oldId,
    fileKey: oldId,
    path: "",
    uri: "",
    title: "preserved",
  };
  const { state, catalog } = createHarness({ board: { projectId: "project-a", nodes: [node] } });
  const result = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.puts, []);
  assert.deepEqual(state.saves, []);
  assert.equal(node.assetId, oldId);
  assert.equal(node.fileKey, oldId);
  assert.equal(node.title, "preserved");
  assert.equal(result.cataloguedCount, 0);
  assert.equal(result.skippedCount, 1);
  cases += 1;
}

{
  const originalBoard = {
    projectId: "project-a",
    nodes: [{ id: "switch-during-put", type: "image", assetId: oldId, path: "C:/Planner/switch.jpg" }],
  };
  const nextNode = { id: "new-project-node", type: "image", assetId: oldId, title: "untouched" };
  const nextBoard = { projectId: "project-b", nodes: [nextNode] };
  const { state, catalog } = createHarness({
    board: originalBoard,
    onPut: async ({ state: current }) => {
      current.activePlannerProjectId = "project-b";
      current.board = nextBoard;
      current.plannerLocalGeneration += 1;
    },
  });
  await assert.rejects(
    catalog({ expectedProjectId: "project-a", expectedGeneration: 7 }),
    /Planner changed while sync was in progress/,
  );
  assert.equal(state.board, nextBoard);
  assert.equal(nextNode.assetId, oldId);
  assert.equal(nextNode.fileKey, undefined);
  assert.deepEqual(state.saves, []);
  cases += 1;
}

{
  const idFor = (index) => `sha256:${Number(index).toString(16).padStart(64, "0")}`;
  const nodes = Array.from({ length: 49 }, (_, index) => {
    const complete = index < 4;
    const currentId = idFor(index);
    const previousAssetId = complete || index === 4 ? currentId : idFor(index + 100);
    return {
      id: `image-${index}`,
      type: "image",
      assetId: previousAssetId,
      fileKey: previousAssetId,
      path: `C:/Planner/image-${index}.jpg`,
      uri: `C:/Planner/image-${index}.jpg`,
      thumbnail: `thumb-${index}`,
      title: `Image ${index}`,
      x: index * 13,
      y: index * 17,
      rotation: index % 4 * 90,
      comment: `note ${index}`,
      sourceUrl: `https://example.test/${index}`,
    };
  });
  const completeAssets = nodes.slice(0, 4).map((node) => ({
    id: node.assetId,
    type: "image",
    source: { hash: node.assetId, mime: "image/jpeg", ext: "jpg", bytes: 3 },
    display: { hash: displayHash, mime: "image/webp", ext: "webp", bytes: 2 },
  }));
  const originalFields = nodes.map(({ assetId, fileKey, ...fields }) => fields);
  const { state, catalog } = createHarness({
    board: { projectId: "project-a", nodes },
    assets: completeAssets,
    readBytes: async (node) => new Uint8Array([Number(node.id.slice("image-".length)) + 1]),
    prepareAsset: async (bytes) => {
      const index = bytes[0] - 1;
      const id = idFor(index);
      return {
        asset: {
          id,
          type: "image",
          source: { hash: id, mime: "image/jpeg", ext: "jpg", bytes: 1 },
          display: structuredClone(completeAsset.display),
        },
      };
    },
  });
  const result = await catalog({ expectedProjectId: "project-a", expectedGeneration: 7 });
  const finalIds = nodes.map((node, index) => {
    assert.equal(node.assetId, idFor(index));
    assert.equal(node.fileKey, idFor(index));
    const { assetId, fileKey, ...fields } = node;
    assert.deepEqual(fields, originalFields[index]);
    return node.assetId;
  });
  const snapshotAssets = await state.getPlannerAssetsByIds(finalIds);
  assert.equal(new Set(finalIds).size, 49);
  assert.equal(snapshotAssets.length, 49);
  assert.equal(state.reads.length, 49, "45 missing assets and 4 legacy encodings must be prepared");
  assert.equal(state.puts.length, 49);
  assert.equal(state.saves.length, 1);
  assert.equal(result.cataloguedCount, 49);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.totalCount, 49);
  assert.equal(nodes[4].assetId, idFor(4), "an existing id matching the local file remains unchanged");
  assert(snapshotAssets.every((asset) => asset.display.mime === "image/jpeg"));
  const repeat = await catalog({ expectedProjectId: "project-a", expectedGeneration: state.plannerLocalGeneration });
  assert.equal(repeat.cataloguedCount, 0);
  assert.equal(state.reads.length, 49, "already migrated images must not be recompressed on the next sync");
  cases += 1;
}

process.stdout.write(`Planner preview catalog checks passed (${cases} cases).\n`);
