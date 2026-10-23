import { createCloudflareTransport } from "./cloudflareTransport.js";
import { createTauriAuthenticatedFetch } from "./tauriAuthenticatedFetch.js";
import { stagePlannerBoardForSync, snapshotPlannerBoardForSync } from "./plannerJournal.js";
import { pushPlannerOutboxOnce, pullAndMergePlannerRemoteState } from "./syncEngine.js";
import { getPlannerRemoteSyncState } from "./remoteMergeStore.js";
import { listPlannerOutbox } from "./outbox.js";

const TEST_WORKER = "https://mori-sync-gateway-test.pages.dev";
const result = document.getElementById("diagnosticResult");
const runButton = document.getElementById("runDiagnostic");
const closeButton = document.getElementById("closeDiagnostic");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getInvoke() {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Tauri command bridge is unavailable");
  return invoke;
}

function syntheticBoard(projectId) {
  return {
    projectId,
    projectTitle: "Synthetic Mori Sync Test",
    nodes: [{ id: "node_a", type: "text", text: "synthetic only", x: 0, y: 0, comment: "old" }],
    edges: [],
  };
}

export function createTauriSyncTestRuntime() {
  let state = "disabled";
  let running = false;
  let queue = Promise.resolve();
  let lastProjectId = "";
  let lastError = "";

  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };

  async function run() {
    if (running) throw new Error("Synthetic sync diagnostic is already running");
    running = true;
    state = "running";
    lastError = "";
    const projectId = `mori-tauri-test-${crypto.randomUUID()}`;
    lastProjectId = projectId;
    const steps = [];
    try {
      const invoke = getInvoke();
      const transport = createCloudflareTransport({
        id: "cloudflare-tauri-test",
        baseUrl: TEST_WORKER,
        nativeAuth: true,
        fetchImpl: createTauriAuthenticatedFetch(invoke),
      });
      const deviceId = "windows-tauri-test";
      let board = syntheticBoard(projectId);
      const localShared = async () => (await snapshotPlannerBoardForSync(board)).shared;
      const applyMergedShared = async (merged) => {
        board = {
          ...board,
          projectId: merged.project.id,
          projectTitle: merged.project.title,
          nodes: merged.nodes,
          edges: merged.edges,
        };
      };
      const changes = async () => (await transport.pullChanges({ projectId, cursor: "0", limit: 100 })).changes;

      const probe = await fetch(`${TEST_WORKER}/health`, { cache: "no-store" });
      assert(probe.ok && (await probe.json()).ok === true, "WebView2 direct HTTP/CORS probe failed");
      steps.push("WebView2 origin → test Worker HTTP/CORS: PASS");

      const staged = await stagePlannerBoardForSync(board, { deviceId });
      assert(staged.mutations.length === 2, "Synthetic Board did not stage project + node");
      assert((await listPlannerOutbox({ projectId })).length === 2, "IndexedDB Outbox missing initial mutations");
      const first = await serial(() => pushPlannerOutboxOnce({ transport, projectId, deviceId }));
      assert(first.status === "ok" && first.acknowledgedCount === 2, "Initial push failed");
      assert((await listPlannerOutbox({ projectId })).length === 0, "Initial ACK did not drain Outbox");
      assert((await changes()).length === 2, "D1 initial change count mismatch");
      steps.push("IndexedDB/Journal → Outbox → real Worker ACK: PASS");

      const firstPull = await serial(async () => pullAndMergePlannerRemoteState({
        transport, projectId, localShared: await localShared(), deviceId, applyMergedShared, pageLimit: 1,
      }));
      assert(firstPull.status === "ok" && firstPull.cursor === "2", "Initial remote cursor mismatch");

      const remote = await transport.pushMutations({
        projectId,
        deviceId: "independent-test-device",
        mutations: [{
          opId: `${projectId}-remote`, projectId, entityType: "node", entityId: "node_a",
          operation: "upsert", payload: { ...board.nodes[0], comment: "remote" },
          deviceId: "independent-test-device", baseRevision: 2,
        }],
      });
      assert(remote.acknowledgedOpIds.length === 1, "Independent remote change failed");
      const secondPull = await serial(async () => pullAndMergePlannerRemoteState({
        transport, projectId, localShared: await localShared(), deviceId, applyMergedShared,
      }));
      assert(secondPull.status === "ok" && secondPull.cursor === "3" && board.nodes[0].comment === "remote", "Remote merge/cursor failed");
      assert((await getPlannerRemoteSyncState({ transportId: transport.id, projectId })).cursor === "3", "Durable cursor missing");
      steps.push("Pull → local apply → Remote Shadow/Cursor: PASS");

      board.nodes[0] = { ...board.nodes[0], x: 42 };
      await stagePlannerBoardForSync(board, { deviceId });
      const beforeFailure = await listPlannerOutbox({ projectId });
      assert(beforeFailure.length === 1, "Failure test mutation not staged");
      const failingTransport = {
        ...transport,
        pushMutations: async () => { throw new Error("synthetic failure before send"); },
      };
      const failed = await serial(() => pushPlannerOutboxOnce({ transport: failingTransport, projectId, deviceId }));
      const retained = await listPlannerOutbox({ projectId });
      assert(failed.status === "error" && retained[0]?.opId === beforeFailure[0].opId, "Failure did not retain sealed opId");
      const retried = await serial(() => pushPlannerOutboxOnce({ transport, projectId, deviceId }));
      assert(retried.status === "ok" && retried.cursor === "4", "Retry did not apply exactly once");
      steps.push("Send-before failure → stable opId retry: PASS");

      board.nodes[0] = { ...board.nodes[0], y: 24 };
      await stagePlannerBoardForSync(board, { deviceId });
      const beforeLostAck = await listPlannerOutbox({ projectId });
      assert(beforeLostAck.length === 1, "ACK-loss mutation not staged");
      const lostAckTransport = {
        ...transport,
        pushMutations: async (request) => {
          const applied = await transport.pushMutations(request);
          assert(applied.acknowledgedOpIds.length === 1, "Server did not apply before ACK loss");
          throw new Error("synthetic ACK loss after server apply");
        },
      };
      const lost = await serial(() => pushPlannerOutboxOnce({ transport: lostAckTransport, projectId, deviceId }));
      assert(lost.status === "error" && (await listPlannerOutbox({ projectId }))[0]?.opId === beforeLostAck[0].opId, "ACK loss did not retain opId");
      assert((await changes()).length === 5, "Server did not apply lost-ACK operation");
      const ackRetry = await serial(() => pushPlannerOutboxOnce({ transport, projectId, deviceId }));
      assert(ackRetry.status === "ok" && ackRetry.cursor === "5", "ACK-loss retry failed");
      assert((await changes()).length === 5 && (await listPlannerOutbox({ projectId })).length === 0, "ACK-loss retry duplicated revision");
      steps.push("Server-applied ACK loss → same opId without duplicate revision: PASS");

      // Synthetic 1×1 PNG only: exercise JSON state and binary PUT/GET over the native bridge.
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", png));
      const hash = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const asset = {
        id: hash,
        source: { hash, mime: "image/png", bytes: png.length, width: 1, height: 1 },
        display: { hash, mime: "image/png", bytes: png.length, width: 1, height: 1 },
      };
      const assetMutation = await transport.pushMutations({
        projectId, deviceId, mutations: [{
          opId: `${projectId}-asset`, projectId, entityType: "asset", entityId: asset.id,
          operation: "upsert", payload: asset, deviceId, baseRevision: 5,
        }],
      });
      assert(assetMutation.acknowledgedOpIds.length === 1, "Synthetic Asset metadata push failed");
      const assetStateBefore = await transport.getAssetStates({ assetIds: [asset.id] });
      assert(assetStateBefore.states[0]?.metadata === "present", "Synthetic Asset metadata state missing");
      await transport.uploadDisplayAsset({ asset, bytes: png, hash, mime: "image/png" });
      const assetStateAfter = await transport.getAssetStates({ assetIds: [asset.id] });
      assert(assetStateAfter.states[0]?.display === "present", "Synthetic Asset display state missing");
      const downloaded = await transport.downloadDisplayAsset({ assetId: asset.id });
      assert(downloaded.bytes.length === png.length && downloaded.bytes.every((byte, index) => byte === png[index]), "Synthetic Asset binary round trip mismatch");
      assert(downloaded.contentType.includes("image/png"), "Synthetic Asset response content-type missing");
      steps.push("Native bridge Asset state → binary upload/download: PASS");

      state = "pass";
      return { status: "PASS", projectId, revision: 6, steps };
    } catch (error) {
      state = "fail";
      const message = String(error?.message || error);
      lastError = message;
      return { status: "FAIL", projectId, steps, error: lastError };
    } finally {
      running = false;
    }
  }

  return {
    run,
    disable: () => { if (!running) state = "disabled"; },
    status: () => ({ state, running, projectId: lastProjectId, error: lastError }),
  };
}

const runtime = createTauriSyncTestRuntime();
runButton?.addEventListener("click", async () => {
  runButton.disabled = true;
  result.textContent = "正在运行合成诊断；没有读取真实 Planner…";
  try {
    result.textContent = JSON.stringify(await runtime.run(), null, 2);
  } finally {
    runButton.disabled = false;
  }
});
closeButton?.addEventListener("click", () => {
  runtime.disable();
  window.close();
});
