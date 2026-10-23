import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/js/sync/manualPlannerSync.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('async function uploadMissingDisplayPreviews('), source.indexOf('async function drainOutbox('));
const entrypoint = source.slice(source.indexOf('export async function runPlannerManualSync('), source.indexOf('export async function initPlannerManualSync(')).replace(/^export /, '');
let shared = {}, local = {}, states = [], reads = 0, uploads = 0;
let encodingOptions;
const statuses = [];
const transport = {
  async getAssetStates() { return { states }; },
  async uploadDisplayAsset() { uploads += 1; },
};
const invoke = async command => {
  if (command === 'tauri_read_file_bytes') { reads += 1; return [1, 2, 3]; }
  if (command === 'tauri_sync_available') return true;
  return { path: 'mock-backup', verified: true, bytes: 2 };
};
const asset = { id: 'a', source: { mime: 'image/png' }, display: { hash: 'display-a', mime: 'image/png' } };
const context = vm.createContext({
  console, Uint8Array, window: { dispatchEvent() {} }, CustomEvent: class {},
  nativeInvoke: () => invoke, setBusy() {}, setStatus: (text, state) => statuses.push({ text, state }),
  preparePlannerImageAsset: async (bytes, options) => {
    encodingOptions = options;
    return { displayBytes: new Uint8Array([1, 2, 3]) };
  },
  getPlannerManualSyncState: async () => ({ rawText: '{}', generation: 0, readOnly: false }),
  persistPlannerProjectIdentityAfterBackup: async () => 'p',
  catalogCurrentPlannerImagesForSync: async () => ({ generation: 0, cataloguedCount: 0, skippedCount: 0 }),
  stageCurrentPlannerForManualSync: async () => ({ projectId: 'p', generation: 0, mutations: [] }),
  getPlannerSyncSnapshot: async () => ({ shared, local, projectId: 'p', generation: 0 }),
  getOrCreateSyncDeviceId: () => 'test', createTransport: () => transport,
  pullAndMergePlannerRemoteState: async () => ({ status: 'ok', reconciliationCount: 0, conflictCount: 0, receivedCount: 0, cursor: 1 }),
  listPlannerOutbox: async () => [], explainError: error => error.message,
});
vm.runInContext(`let syncBusy=false; ${helpers}\n${entrypoint}`, context);
const run = () => context.uploadMissingDisplayPreviews({ transport, shared, local, invoke });

shared = { nodes: [{ type: 'image' }, { type: 'image' }], assets: [] };
assert.equal((await run()).skippedCount, 2, 'legacy nodes without ids must be counted');
assert.equal(reads, 0);

shared = { nodes: [{ id: '1', type: 'image', assetId: 'a' }, { id: '2', type: 'image', assetId: 'b' }], assets: [asset] };
states = [{ assetId: 'a', display: 'present', displayHash: 'display-a' }, { assetId: 'b', display: 'present', displayHash: 'display-b' }];
const partial = await run();
assert.equal(partial.presentCount, 1, 'existing correct cloud preview needs no local file');
assert.equal(partial.skippedCount, 1, 'missing project metadata cannot be hidden by a global cloud object');
assert.equal(partial.totalCount, 2);
assert.equal(uploads, 0);
const result = await context.runPlannerManualSync();
assert.equal(result.previewAvailableCount, 1);
assert.equal(result.previewTotalCount, 2);
assert.equal(statuses.at(-1).state, 'warning');
assert.match(statuses.at(-1).text, /云端图片预览 1\/2.*1 张待补齐/);

shared = { nodes: [{ id: '1', type: 'image', assetId: 'a' }], assets: [asset] };
local = { nodeFiles: { '1': { path: 'mock-image.png' } } };
states = [{ assetId: 'a', display: 'present', displayHash: 'older-display' }];
const repaired = await run();
assert.equal(repaired.uploadedCount, 1, 'a different display variant must not be reported ready');
assert.equal(reads, 1);
assert.equal(uploads, 1);
assert.equal(encodingOptions.legacyDisplay, true, 'old metadata must keep the original encoding');

asset.display.encoding = { algorithm: 'canvas-reference-v1', maxSide: 2048, quality: 0.88 };
await run();
assert.equal(encodingOptions.legacyDisplay, false, 'new metadata must reproduce the current encoding');
assert.equal(encodingOptions.maxDisplaySide, 2048);
assert.equal(encodingOptions.displayQuality, 0.88);

local = {};
states = [];
assert.equal((await run()).skippedCount, 1, 'missing local file remains incomplete');
console.log('PASS: Windows preview identity, metadata, available counts, and partial warning');
