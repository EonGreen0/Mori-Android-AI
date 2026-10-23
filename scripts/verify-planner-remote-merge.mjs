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
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

const merge = await loadBundledModule("../public/js/sync/remoteMerge.js");

function envelope(nodes = [], edges = []) {
  return {
    schemaVersion: 1,
    project: { id: "project_1", title: "Plan", payload: { commentFontSize: 17 } },
    nodes,
    edges,
    assets: [],
  };
}

function remoteChange(revision, entityType, entityId, operation, payload = null) {
  return {
    projectId: "project_1",
    revision,
    entityType,
    entityId,
    operation,
    payload,
    serverTimestamp: 1000 + revision,
  };
}

function baseShadowWithNode(node) {
  let shadow = merge.createPlannerRemoteShadow("project_1");
  shadow = merge.applyPlannerRemoteChanges(shadow, [
    remoteChange(1, "project", "project_1", "upsert", envelope().project),
    remoteChange(2, "node", node.id, "upsert", node),
  ]).shadow;
  return shadow;
}

{
  const emptyRemote = merge.createPlannerRemoteShadow("project_1");
  const local = envelope([{ id: "node_seed", type: "text", text: "seed me" }]);
  const result = merge.mergePlannerRemoteState({
    baseShadow: emptyRemote,
    localShared: local,
    remoteShadow: emptyRemote,
  });
  const reconciliation = merge.buildPlannerReconciliationMutations({
    remoteShadow: emptyRemote,
    merged: result.merged,
  });
  assert.ok(reconciliation.some((item) => item.entityType === "project"));
  assert.ok(reconciliation.some((item) => item.entityId === "node_seed" && item.operation === "upsert"));
}

{
  const baseNode = { id: "node_a", type: "image", x: 0, y: 0, comment: "old" };
  const baseShadow = baseShadowWithNode(baseNode);
  const local = envelope([{ ...baseNode, x: 50 }]);
  const remoteShadow = merge.applyPlannerRemoteChanges(baseShadow, [
    remoteChange(3, "node", "node_a", "upsert", { ...baseNode, comment: "remote note" }),
  ]).shadow;

  const result = merge.mergePlannerRemoteState({ baseShadow, localShared: local, remoteShadow });
  assert.equal(result.merged.nodes[0].x, 50);
  assert.equal(result.merged.nodes[0].comment, "remote note");
  assert.equal(result.conflicts.filter((item) => item.kind === "field-conflict").length, 0);

  const reconciliation = merge.buildPlannerReconciliationMutations({
    remoteShadow,
    merged: result.merged,
    deviceId: "windows",
    timestamp: 2000,
  });
  const nodeMutation = reconciliation.find((item) => item.entityType === "node");
  assert.ok(nodeMutation);
  assert.equal(nodeMutation.baseRevision, 3);
  assert.equal(nodeMutation.payload.x, 50);
  assert.equal(nodeMutation.payload.comment, "remote note");
}

{
  const baseNode = { id: "node_b", type: "text", text: "old", x: 0, y: 0 };
  const baseShadow = baseShadowWithNode(baseNode);
  const local = envelope([{ ...baseNode, text: "local" }]);
  const remoteShadow = merge.applyPlannerRemoteChanges(baseShadow, [
    remoteChange(3, "node", "node_b", "upsert", { ...baseNode, text: "remote" }),
  ]).shadow;

  const result = merge.mergePlannerRemoteState({ baseShadow, localShared: local, remoteShadow });
  assert.equal(result.merged.nodes[0].text, "remote");
  const conflict = result.conflicts.find((item) => item.kind === "field-conflict");
  assert.ok(conflict);
  assert.equal(conflict.path, "text");
  assert.equal(conflict.resolution, "remote");

  const reconciliation = merge.buildPlannerReconciliationMutations({ remoteShadow, merged: result.merged });
  assert.equal(reconciliation.filter((item) => item.entityType === "node").length, 0);
}

{
  const baseNode = { id: "node_c", type: "text", text: "old", x: 0, y: 0 };
  const baseShadow = baseShadowWithNode(baseNode);
  const local = envelope([{ ...baseNode, text: "local unsynced" }]);
  const remoteShadow = merge.applyPlannerRemoteChanges(baseShadow, [
    remoteChange(3, "node", "node_c", "delete"),
  ]).shadow;

  const result = merge.mergePlannerRemoteState({ baseShadow, localShared: local, remoteShadow });
  assert.equal(result.merged.nodes.length, 0);
  assert.ok(result.conflicts.some((item) => item.kind === "remote-delete"));
  assert.equal(
    merge.buildPlannerReconciliationMutations({ remoteShadow, merged: result.merged })
      .filter((item) => item.entityType === "node").length,
    0,
  );

  const staleLocal = envelope([{ ...baseNode, text: "stale resurrection" }]);
  const repeated = merge.mergePlannerRemoteState({
    baseShadow: remoteShadow,
    localShared: staleLocal,
    remoteShadow,
  });
  assert.equal(repeated.merged.nodes.length, 0, "tombstone must block stale local resurrection");
}

{
  const baseNode = { id: "node_d", type: "text", text: "keep", x: 0, y: 0 };
  const baseShadow = baseShadowWithNode(baseNode);
  const local = envelope([]);
  const result = merge.mergePlannerRemoteState({ baseShadow, localShared: local, remoteShadow: baseShadow });
  assert.equal(result.merged.nodes.length, 0);
  const reconciliation = merge.buildPlannerReconciliationMutations({ remoteShadow: baseShadow, merged: result.merged });
  const deletion = reconciliation.find((item) => item.entityId === "node_d");
  assert.ok(deletion);
  assert.equal(deletion.operation, "delete");
  assert.equal(deletion.baseRevision, 2);
}

{
  let baseShadow = merge.createPlannerRemoteShadow("project_1");
  baseShadow = merge.applyPlannerRemoteChanges(baseShadow, [
    remoteChange(1, "project", "project_1", "upsert", envelope().project),
    remoteChange(2, "node", "node_1", "upsert", { id: "node_1", type: "text", text: "one" }),
    remoteChange(3, "node", "node_2", "upsert", { id: "node_2", type: "text", text: "two" }),
    remoteChange(4, "node", "group_1", "upsert", { id: "group_1", type: "group", memberIds: ["node_1", "node_2"] }),
    remoteChange(5, "edge", "edge_1", "upsert", { id: "edge_1", from: "node_1", to: "node_2" }),
  ]).shadow;
  const local = envelope(
    [
      { id: "node_1", type: "text", text: "one" },
      { id: "node_2", type: "text", text: "two" },
      { id: "group_1", type: "group", memberIds: ["node_1", "node_2"] },
    ],
    [{ id: "edge_1", from: "node_1", to: "node_2" }],
  );
  const remoteShadow = merge.applyPlannerRemoteChanges(baseShadow, [
    remoteChange(6, "node", "node_2", "delete"),
  ]).shadow;
  const result = merge.mergePlannerRemoteState({ baseShadow, localShared: local, remoteShadow });
  assert.equal(result.merged.nodes.some((node) => node.id === "node_2"), false);
  assert.equal(result.merged.edges.length, 0);
  assert.deepEqual(result.merged.nodes.find((node) => node.id === "group_1").memberIds, ["node_1"]);
  const reconciliation = merge.buildPlannerReconciliationMutations({ remoteShadow, merged: result.merged });
  assert.ok(reconciliation.some((item) => item.entityId === "edge_1" && item.operation === "delete"));
  assert.ok(reconciliation.some((item) => item.entityId === "group_1" && item.operation === "upsert"));
}

{
  const shadow = merge.createPlannerRemoteShadow("project_1");
  assert.throws(
    () => merge.applyPlannerRemoteChanges(shadow, [
      remoteChange(1, "project", "project_1", "upsert", envelope().project),
      remoteChange(1, "node", "node_x", "upsert", { id: "node_x", type: "text" }),
    ]),
    /Duplicate remote revision/,
  );
}

console.log("planner remote merge verification passed");
