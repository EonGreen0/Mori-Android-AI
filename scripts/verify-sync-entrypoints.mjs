import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function declaration(file, name, next) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(next, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}

// Exercise production entrypoint control flow: four accepted uploads require
// a fifth (echo-only) pull; a fourth conflict must never report success.
for (const platform of ["android", "windows"]) {
  for (const converges of [true, false]) {
    let pulls = 0, pushes = 0;
    const pending = [{ opId: "local", entityType: "node" }];
    const snapshot = { projectId: "p", generation: 0, shared: { project: { id: "p" } }, local: {} };
    const context = vm.createContext({
      console, Number, String, Error, Set,
      document: { activeElement: null },
      window: { dispatchEvent() {} },
      CustomEvent: class {},
      elements: () => ({ writeButton: { dataset: {} } }),
      setBusy() {}, setStatus() {}, nativeInvoke: () => async command =>
        command === "tauri_sync_available" ? true : { path: "backup", verified: true, bytes: 2 },
      getPlannerSyncSnapshot: async () => snapshot,
      getPlannerManualSyncState: async () => ({ ...snapshot, rawText: "{}", readOnly: false }),
      persistPlannerProjectIdentityAfterBackup: async () => "p",
      catalogCurrentPlannerImagesForSync: async () => ({ generation: 0, cataloguedCount: 0, skippedCount: 0 }),
      stageCurrentPlannerForManualSync: async () => ({ ...snapshot, mutations: pending }),
      getOrCreateSyncDeviceId: () => "test", createTransport: () => ({}),
      listPlannerOutbox: async () => pending,
      assertPendingPlannerMutationBatch() {},
      pullAndMergePlannerRemoteState: async () => {
        pulls += 1;
        pending.length = pulls === 5 && converges ? 0 : 1;
        return { status: "ok", reconciliationCount: pending.length, conflictCount: 0, receivedCount: 0, cursor: pulls };
      },
      pushPlannerOutboxOnce: async () => {
        pushes += 1; pending.length = 0;
        return { status: "ok", acknowledgedCount: 1, submittedCount: 1 };
      },
      drainOutbox: async () => {
        pushes += 1; pending.length = 0;
        return { submittedCount: 1, acknowledgedCount: 1 };
      },
      uploadMissingDisplayPreviews: async () => ({ uploadedCount: 0, skippedCount: 0 }),
      explainError: error => error.message,
    });
    const code = platform === "android"
      ? declaration("../public/js/sync/androidPlannerReadOnlySync.js", "uploadPlannerChange", "export async function initAndroidPlannerSync")
      : declaration("../public/js/sync/manualPlannerSync.js", "runPlannerManualSync", "export async function initPlannerManualSync");
    vm.runInContext(`let busy=false, syncBusy=false, plannerWriteEnabled=true; const MAX_ANDROID_PLANNER_MUTATIONS=200; ${code}`, context);
    const run = vm.runInContext(platform === "android" ? "uploadPlannerChange({})" : "runPlannerManualSync()", context);
    if (converges) {
      const result = await run;
      assert.equal(result.status, "ok");
      assert.equal(result.cursor, 5);
      assert.equal(pending.length, 0);
    } else {
      await assert.rejects(run, /其他设备仍在修改/);
      assert.equal(pending.length, 1, "contention must preserve the newly reconciled operation");
    }
    assert.equal(pulls, 5);
    assert.equal(pushes, 4);
  }
}
console.log("Windows/Android fourth-upload echo and contention entrypoints passed (4 cases)");

// The real refresh entrypoint must report images without an asset identity,
// rather than silently skip the image stage and display a successful refresh.
{
  let bound = false;
  let checked = false;
  let completion;
  const context = vm.createContext({
    String, Error,
    elements: () => ({ select: { value: "p", selectedOptions: [{ dataset: { title: "test" } }] } }),
    setBusy() {}, setStatus(text, state) { completion = { text, state }; },
    prepareAndroidReadOnlyPlannerProject: async () => ({ generation: 0 }),
    listPlannerOutbox: async () => [],
    pullPlannerRemoteStateReadOnly: async () => ({ status: "ok", merged: { nodes: [{ id: "legacy", type: "image" }] } }),
    applyPlannerMergedSharedState() {}, createAndroidPreviewResult: () => ({ bindings: [] }),
    cachePlannerDisplayPreviews: async () => { checked = true; return { bindings: [], missingCount: 1 }; },
    bindAndroidPlannerDisplayPreviews() { bound = true; },
    androidPreviewCompletion: () => ({ text: "missing identity", state: "warning" }),
  });
  const code = declaration("../public/js/sync/androidPlannerReadOnlySync.js", "refreshSelectedProject", "async function uploadPlannerChange");
  vm.runInContext(`let busy=false; ${code}`, context);
  await vm.runInContext("refreshSelectedProject({})", context);
  assert(checked && bound);
  assert.equal(completion.state, "warning");
}
console.log("Android refresh without asset identity reports missing images (1 case)");
