import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromSource = createRequire(import.meta.url);
const { build } = requireFromSource("esbuild");

async function loadBundledModule(relativePath) {
  const entry = fileURLToPath(new URL(relativePath, import.meta.url));
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const source = bundle.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const mutationsModule = await loadBundledModule("../public/js/sync/mutations.js");
const compactionModule = await loadBundledModule("../public/js/sync/compaction.js");

const {
  createPlannerMutation,
  diffPlannerSyncEnvelopes,
  PLANNER_MUTATION_OPERATIONS,
} = mutationsModule;
const { compactPlannerMutations } = compactionModule;

function upsert(id, payload, overrides = {}) {
  return {
    ...createPlannerMutation({
      projectId: "project_1",
      entityType: "node",
      entityId: id,
      operation: PLANNER_MUTATION_OPERATIONS.UPSERT,
      payload,
      baseRevision: 7,
      baseExists: true,
      deviceId: "device_1",
      timestamp: overrides.clientTimestamp || Date.now(),
      opId: overrides.opId || `op_${id}_${payload.x ?? "x"}`,
    }),
    queuedAt: overrides.queuedAt || Date.now(),
    attempts: overrides.attempts || 0,
  };
}

function remove(id, overrides = {}) {
  return {
    ...createPlannerMutation({
      projectId: "project_1",
      entityType: "node",
      entityId: id,
      operation: PLANNER_MUTATION_OPERATIONS.DELETE,
      baseRevision: overrides.baseRevision ?? 7,
      baseExists: overrides.baseExists ?? true,
      deviceId: "device_1",
      timestamp: overrides.clientTimestamp || Date.now(),
      opId: overrides.opId || `op_${id}_delete`,
    }),
    queuedAt: overrides.queuedAt || Date.now(),
    attempts: overrides.attempts || 0,
  };
}

{
  const initial = {
    schemaVersion: 1,
    project: { id: "project_1", title: "Plan", payload: {} },
    nodes: [{ id: "node_new", type: "text", text: "hello" }],
    edges: [],
  };
  const firstDiff = diffPlannerSyncEnvelopes(null, initial, {
    deviceId: "device_1",
    timestamp: 1,
  });
  const createdNode = firstDiff.find((mutation) => mutation.entityId === "node_new");
  assert.equal(createdNode.baseExists, null);

  const knownEmpty = { ...initial, nodes: [] };
  const createdFromKnownEmpty = diffPlannerSyncEnvelopes(knownEmpty, initial, {
    deviceId: "device_1",
    timestamp: 2,
  }).find((mutation) => mutation.entityId === "node_new");
  assert.equal(createdFromKnownEmpty.baseExists, false);

  const removed = { ...initial, nodes: [] };
  const secondDiff = diffPlannerSyncEnvelopes(initial, removed, {
    deviceId: "device_1",
    timestamp: 3,
  });
  const deletedNode = secondDiff.find((mutation) => mutation.entityId === "node_new");
  assert.equal(deletedNode.baseExists, true);
}

{
  const manyMoves = Array.from({ length: 20 }, (_, index) =>
    upsert("node_a", { id: "node_a", x: index }, {
      opId: `move_${index}`,
      queuedAt: 100 + index,
    }),
  );
  const result = compactPlannerMutations(manyMoves);
  assert.equal(result.inputCount, 20);
  assert.equal(result.outputCount, 1);
  assert.equal(result.entries[0].mutation.payload.x, 19);
  assert.equal(result.entries[0].mutation.baseRevision, 7);
  assert.equal(result.entries[0].sourceOpIds.length, 20);
}

{
  const result = compactPlannerMutations([
    upsert("node_b", { id: "node_b", x: 1 }, { opId: "b_upsert", queuedAt: 1 }),
    remove("node_b", { opId: "b_delete", queuedAt: 2, baseExists: true }),
  ]);
  assert.equal(result.outputCount, 1);
  assert.equal(result.entries[0].mutation.operation, "delete");
  assert.deepEqual(result.entries[0].sourceOpIds, ["b_upsert", "b_delete"]);
}

{
  const created = upsert("node_c", { id: "node_c", x: 1 }, { opId: "c_create", queuedAt: 1 });
  created.baseRevision = 0;
  created.baseExists = false;
  const updated = upsert("node_c", { id: "node_c", x: 2 }, { opId: "c_update", queuedAt: 2 });
  updated.baseRevision = 0;
  updated.baseExists = true;
  const deleted = remove("node_c", { opId: "c_delete", queuedAt: 3, baseRevision: 0, baseExists: true });
  const result = compactPlannerMutations([created, updated, deleted]);
  assert.equal(result.outputCount, 0);
  assert.deepEqual(result.discardOpIds, ["c_create", "c_update", "c_delete"]);
}

{
  const attempted = upsert("node_d", { id: "node_d", x: 1 }, {
    opId: "d_attempted",
    queuedAt: 1,
    attempts: 1,
  });
  const second = upsert("node_d", { id: "node_d", x: 2 }, { opId: "d_second", queuedAt: 2 });
  const third = upsert("node_d", { id: "node_d", x: 3 }, { opId: "d_third", queuedAt: 3 });
  const result = compactPlannerMutations([attempted, second, third]);
  assert.equal(result.outputCount, 2);
  assert.deepEqual(result.entries[0].sourceOpIds, ["d_attempted"]);
  assert.deepEqual(result.entries[1].sourceOpIds, ["d_second", "d_third"]);
  assert.equal(result.entries[1].mutation.payload.x, 3);
}

{
  const a1 = upsert("node_a", { id: "node_a", x: 1 }, { opId: "a1", queuedAt: 1 });
  const b1 = upsert("node_b", { id: "node_b", x: 10 }, { opId: "b1", queuedAt: 2 });
  const a2 = upsert("node_a", { id: "node_a", x: 2 }, { opId: "a2", queuedAt: 3 });
  const result = compactPlannerMutations([a1, b1, a2]);
  assert.equal(result.outputCount, 2);
  assert.equal(result.entries[0].mutation.entityId, "node_a");
  assert.equal(result.entries[0].mutation.payload.x, 2);
  assert.equal(result.entries[1].mutation.entityId, "node_b");
}

console.log("planner mutation compaction verification passed");
