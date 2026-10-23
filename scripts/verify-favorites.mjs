import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createFavoritesStore, groupFavoritesByDate } from "../public/js/modules/favoritesStore.js";

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values };
};
const storage = memory();
let serial = 0;
const options = { now: () => 10000, makeId: () => `favorite-${++serial}` };
const store = createFavoritesStore(storage, options);
const original = { path: "C:/Mori/Frames/original.png", savedAt: 1000, title: "原帧" };
const history = [{ timestamp: 500, localFiles: [{ ...original, type: "FRAME" }, { path: "C:/ordinary.jpg", type: "IMAGE" }] }];
store.migrate(history);
assert.equal(store.list().length, 1);
const entry = store.list()[0];
assert.equal(store.add({ ...original, path: "c:\\mori\\frames\\ORIGINAL.png" }).id, entry.id);
const removed = store.remove([entry.id]);
const restarted = createFavoritesStore(storage, options);
restarted.migrate(history);
assert.equal(restarted.list().length, 0, "removed legacy frames must not return after restart");
restarted.restore(removed); restarted.restore(removed);
assert.equal(restarted.list().length, 1, "undo does not duplicate favorites");
assert.deepEqual(history[0].localFiles[0], { ...original, type: "FRAME" }, "remove never mutates original history/file references");
const pasted = restarted.add({ path: "C:/Mori/Frames/pasted.png" });
assert.equal(createFavoritesStore(storage, options).get(pasted.id).path, pasted.path, "new clipboard entry persists");
const dates = groupFavoritesByDate([{ savedAt: new Date(2026, 9, 1, 1).getTime() }, { savedAt: new Date(2026, 8, 30, 23).getTime() }]);
assert.deepEqual(dates.map((group) => group.date), ["2026-10-01", "2026-09-30"], "date groups use local calendar days");
const corrupt = memory(); corrupt.setItem("mori_favorites_v1", "invalid json");
assert.throws(() => createFavoritesStore(corrupt, options).add(original));
assert.equal(corrupt.getItem("mori_favorites_v1"), "invalid json", "corrupt records are never replaced with an empty store");
const quota = memory(); quota.setItem = () => { throw new Error("quota"); };
assert.throws(() => createFavoritesStore(quota, options).add(original), /quota/);
console.log("PASS: favorites persistence, legacy migration, removal/undo, date groups and failure preservation");

const plannerSource = await readFile(new URL("../public/js/modules/planner.js", import.meta.url), "utf8");
const plannerStart = plannerSource.indexOf("export function getFavoritePlannerTargets()");
const plannerEnd = plannerSource.length;
const plannerStorage = memory();
const active = { projectId: "a", nodes: [{ id: "old", type: "text", comment: "keep" }], edges: [], readOnly: false };
const other = { projectId: "b", nodes: [], edges: [], readOnly: false };
plannerStorage.setItem("board:b", JSON.stringify(other));
const index = { projects: { a: { projectId: "a", albumIds: ["album-a"] }, b: { projectId: "b", albumIds: ["album-b"] } }, activeProjectByAlbum: { "album-a": "a", "album-b": "b" } };
const planner = {
  localStorage: plannerStorage, board: active, activePlannerProjectId: "a", plannerLocalGeneration: 2,
  isAndroidNative: () => false, loadPlannerIndex: () => structuredClone(index),
  loadProjectBoard: (id) => JSON.parse(plannerStorage.getItem(`board:${id}`)), plannerBoardStorageKey: (id) => `board:${id}`,
  normalizePlannerFileKey: (path) => path.replace(/\\/g, "/").toLowerCase(), plannerViewportCenterPoint: () => ({ x: 100, y: 100 }),
  id: () => `node-${++serial}`, registerPlannerProject: (value, next, albumId) => { assert.equal(albumId, null); value.projects[next.projectId].updated = true; },
  savePlannerIndex: (next) => { Object.assign(index, next); }, queued: [], queuePlannerSyncCapture: (next) => planner.queued.push(next), renders: 0,
  renderPlanner: () => { planner.renders += 1; },
};
vm.createContext(planner);
vm.runInContext(plannerSource.slice(plannerStart, plannerEnd).replaceAll("export function", "function") + "\nglobalThis.insert = insertFavoritesIntoPlanner;", planner);
assert.equal(planner.insert([entry], "b").added, 1);
assert.equal(planner.activePlannerProjectId, "a"); assert.equal(planner.board, active);
assert.equal(planner.renders, 0); assert.deepEqual(index.activeProjectByAlbum, { "album-a": "a", "album-b": "b" });
assert.equal(JSON.parse(plannerStorage.getItem("board:b")).nodes[0].path, entry.path);
assert.equal(planner.insert([entry], "b").skipped, 1, "repeated insertion is idempotent");
assert.equal(planner.insert([entry], "a").added, 1); assert.equal(planner.renders, 1);
assert.equal(planner.board.nodes[0].comment, "keep"); assert.equal(planner.plannerLocalGeneration, 3);
assert.throws(() => planner.insert([entry], "missing"), /不存在/);
planner.board.readOnly = true; assert.throws(() => planner.insert([pasted], "a"), /无法编辑/);
planner.board.readOnly = false;
const activeBeforeFailure = planner.board; const generationBeforeFailure = planner.plannerLocalGeneration;
const rawBeforeFailure = plannerStorage.getItem("board:a");
planner.savePlannerIndex = () => { throw new Error("index quota"); };
assert.throws(() => planner.insert([pasted], "a"), /index quota/);
assert.equal(plannerStorage.getItem("board:a"), rawBeforeFailure);
assert.equal(planner.board, activeBeforeFailure); assert.equal(planner.plannerLocalGeneration, generationBeforeFailure);
console.log("PASS: active/inactive Planner insertion, target identity, duplicate suppression and read-only rejection");

const albumSource = await readFile(new URL("../public/js/modules/inspiration.js", import.meta.url), "utf8");
const albumStart = albumSource.indexOf("export function getFavoriteAlbumTargets()");
const albumEnd = albumSource.indexOf("\nfunction ", albumStart);
const albumStorage = memory(); albumStorage.setItem("mori_history", JSON.stringify(history));
const albums = { localStorage: albumStorage, ASSIGNMENTS_KEY: "assignments", FAVORITE_REFS_KEY: "album-refs", activeAlbumId: "album-a", loadAlbums: () => [{ id: "album-a", name: "A" }, { id: "album-b", name: "B" }], t: (key) => key,
  getImportedAlbumLibraries: () => [],
  cleanUrl: (value) => value, safeJson: (key, fallback) => JSON.parse(albumStorage.getItem(key) || JSON.stringify(fallback)),
  loadAssignments: () => JSON.parse(albumStorage.getItem("assignments") || "{}"), renderInspiration() {},
};
vm.createContext(albums);
vm.runInContext(albumSource.slice(albumSource.indexOf("function sourceKey("), albumSource.indexOf("export function getActiveInspirationAlbumSnapshot(")).replace(/^export /gm, ""), albums);
vm.runInContext(albumSource.slice(albumStart, albumEnd).replaceAll("export function", "function") + "\nglobalThis.insert = insertFavoritesIntoAlbum;", albums);
assert.equal(albums.insert([entry], "album-b").added, 1);
assert.equal(albums.activeAlbumId, "album-a");
assert.equal(albums.getGroups("album-b").length, 1); assert.equal(albums.getGroups("album-b")[0].files.length, 1, "inserting a frame must not assign the entire source group");
assert.equal(albums.insert([entry], "album-b").skipped, 1);
assert.throws(() => albums.insert([entry], "missing"), /不存在/);
const beforeHistory = albumStorage.getItem("mori_history"); const beforeAssignments = albumStorage.getItem("assignments");
const beforeRefs = albumStorage.getItem("album-refs");
assert.equal(beforeHistory, JSON.stringify(history), "album insertion never changes download history");
const write = albumStorage.setItem;
albumStorage.setItem = (key, value) => { if (key === "album-refs") throw new Error("quota"); write(key, value); };
assert.throws(() => albums.insert([pasted], "album-b"), /quota/);
assert.equal(albumStorage.getItem("mori_history"), beforeHistory);
assert.equal(albumStorage.getItem("album-refs"), beforeRefs);
assert.equal(albumStorage.getItem("assignments"), beforeAssignments, "failed reference write rolls back album assignments");
albumStorage.setItem = write;
albumStorage.removeItem("mori_history");
assert.equal(albums.getGroups("album-b")[0].files[0].path, entry.path, "clearing history cannot remove inserted album references");
console.log("PASS: album target isolation, one-image references, duplicate suppression and storage rollback");

const bridgeSource = await readFile(new URL("../public/js/modules/favoritesBridge.js", import.meta.url), "utf8");
const bridgeStorage = memory(); const handlers = new Map(); const responses = [];
let pasteCount = 0, clipboardImage = true, pasteBusyRemaining = 0;
const bridge = {
  createFavoritesStore, localStorage: bridgeStorage, navigator: { userAgent: "Windows NT 10.0" }, console, setTimeout: (resolve) => resolve(),
  getFavoriteAlbumTargets: () => ({ items: [{ id: "b" }] }), getFavoritePlannerTargets: () => ({ items: [{ id: "p" }] }),
  insertFavoritesIntoAlbum: (entries, target) => { assert.equal(target, "b"); assert.equal(entries.length, 1); return { added: 1, skipped: 0 }; },
  insertFavoritesIntoPlanner: () => { throw new Error("read-only"); },
  window: { addEventListener: (name, handler) => handlers.set(name, handler), __TAURI__: {
    event: { listen: async (name, handler) => { handlers.set(name, handler); } },
    core: { invoke: async (command, args) => {
      if (command === "tauri_favorites_response") responses.push(args.response);
      if (command === "tauri_save_clipboard_frame") {
        assert.equal(args.previousSequence, null);
        pasteCount += 1;
        if (pasteBusyRemaining-- > 0) return { saved: false, reason: "clipboard_busy" };
        return clipboardImage ? { saved: true, path: `C:/clipboard-${pasteCount}.png` } : { saved: false };
      }
    } },
  } },
};
vm.createContext(bridge);
vm.runInContext(bridgeSource.replace(/^import .*;\r?\n/gm, "").replace("export function", "function") + "\ninitFavoritesBridge();", bridge);
const request = (payload) => handlers.get("mori-favorites-request")({ payload });
await Promise.all([request({ requestId: "paste-one", action: "paste" }), request({ requestId: "paste-one", action: "paste" })]);
assert.equal(pasteCount, 1, "a repeated bridge request performs clipboard/file storage once");
assert.equal(responses.at(-1).ok, true);
await request({ requestId: "list-one", action: "list" });
const favoriteId = responses.at(-1).data.items[0].id;
await request({ requestId: "album-one", action: "insert", ids: [favoriteId], targetType: "album", targetId: "b" });
assert.equal(responses.at(-1).ok, true);
await request({ requestId: "planner-one", action: "insert", ids: [favoriteId], targetType: "planner", targetId: "p" });
assert.equal(responses.at(-1).ok, false); assert.equal(responses.at(-1).error, "read-only");
await request({ requestId: "remove-one", action: "remove", ids: [favoriteId] });
assert.equal(responses.at(-1).data.undoAvailable, true);
await request({ requestId: "undo-one", action: "undo" });
assert.equal(createFavoritesStore(bridgeStorage).list().length, 1);
await handlers.get("mori-douyin-frame-saved")({ payload: { path: "C:/douyin-frame.png", title: "网页帧" } });
assert.equal(createFavoritesStore(bridgeStorage).list().length, 2, "new native web-video frames enter favorites after legacy migration");
clipboardImage = false;
await request({ requestId: "empty-paste", action: "paste" });
assert.equal(responses.at(-1).ok, false); assert.match(responses.at(-1).error, /没有图片/);
clipboardImage = true; pasteBusyRemaining = 2;
await request({ requestId: "busy-recovery-paste", action: "paste" });
assert.equal(responses.at(-1).ok, true);
const beforeBusy = createFavoritesStore(bridgeStorage).list().length;
pasteBusyRemaining = 10;
await request({ requestId: "busy-failed-paste", action: "paste" });
assert.equal(responses.at(-1).ok, false); assert.match(responses.at(-1).error, /占用/);
assert.equal(createFavoritesStore(bridgeStorage).list().length, beforeBusy);
console.log("PASS: main-window bridge acknowledgement, duplicate requests, routing, undo and error propagation");

const captureStart = plannerSource.indexOf("async function captureFrameWithSystemSnip()");
const captureEnd = plannerSource.indexOf("\nasync function importImageBytes", captureStart);
let ensured = 0, collected = 0;
const capture = { frameCaptureBusy: false, navigator: { userAgent: "Windows NT 10.0" }, document: { getElementById: () => null },
  ensurePlannerForActiveAlbum: () => { ensured += 1; }, getTauriInvoke: () => async (command) => command === "tauri_save_clipboard_frame" ? { saved: true, path: "C:/new-snip.png" } : null,
  showToast() {}, t: (key) => key, setTimeout: (resolve) => resolve(), collectFavoriteFrame: () => { collected += 1; }, console,
};
vm.createContext(capture); vm.runInContext(plannerSource.slice(captureStart, captureEnd) + "\nglobalThis.capture = captureFrameWithSystemSnip;", capture);
await capture.capture(); assert.equal(collected, 1); assert.equal(ensured, 0, "Windows capture must not create or edit an unrelated Planner");
assert.equal(capture.frameCaptureBusy, false);
console.log("PASS: Windows screen capture stores favorites without creating an album/Planner");

async function captureScenario(read, options = {}) {
  const calls = [], messages = [], entries = [];
  const button = { disabled: false };
  const context = { ...capture, frameCaptureBusy: false, document: { getElementById: () => button },
    showToast: (value) => messages.push(value), console: { warn() {} },
    collectFavoriteFrame: (value) => { if (options.collectionError) throw new Error("quota"); entries.push(value); },
    getTauriInvoke: () => async (command, args) => {
      calls.push({ command, args });
      if (command === "tauri_clipboard_image_sequence") {
        if (options.baselineError) throw new Error("baseline failure");
        return 42;
      }
      if (command === "tauri_start_screen_snip" && options.launchError) throw new Error("snip_launch: Windows error 31");
      if (command === "tauri_save_clipboard_frame") { assert.equal(args.previousSequence, 42); return read(); }
    },
  };
  vm.createContext(context);
  vm.runInContext(plannerSource.slice(captureStart, captureEnd) + "\nglobalThis.capture = captureFrameWithSystemSnip;", context);
  await context.capture();
  assert.equal(context.frameCaptureBusy, false); assert.equal(button.disabled, false);
  assert.equal(calls.at(-1).command, "tauri_set_frame_floater_visible"); assert.equal(calls.at(-1).args.visible, true);
  return { calls, messages, entries };
}
let attempts = 0;
const recovered = await captureScenario(() => ++attempts < 3 ? { saved: false, reason: "clipboard_busy" } : { saved: true, path: "C:/region.png" });
assert.equal(recovered.entries.length, 1); assert.equal(attempts, 3, "temporary clipboard contention must not abort region capture");
const cancelled = await captureScenario(() => ({ saved: false, reason: "unchanged" }));
assert.equal(cancelled.entries.length, 0); assert.equal(cancelled.messages.at(-1), "planner-capture-frame-cancelled");
const busy = await captureScenario(() => ({ saved: false, reason: "clipboard_busy" }));
assert.equal(busy.messages.at(-1), "planner-capture-frame-busy");
const noImage = await captureScenario(() => ({ saved: false, reason: "no_image" }));
assert.equal(noImage.entries.length, 0, "copying text must never save the old image");
const launchFailed = await captureScenario(() => { throw new Error("must not poll"); }, { launchError: true });
assert.match(launchFailed.messages.at(-1), /launch-failed.*31/);
assert.equal(launchFailed.calls.filter((call) => call.command === "tauri_save_clipboard_frame").length, 0);
const readFailed = await captureScenario(() => { throw new Error("clipboard_bitmap: damaged"); });
assert.match(readFailed.messages.at(-1), /read-failed.*clipboard_bitmap/);
const captureQuota = await captureScenario(() => ({ saved: true, path: "C:/saved-original.png" }), { collectionError: true });
assert.match(captureQuota.messages.at(-1), /frame-failed.*quota/); assert.equal(captureQuota.entries.length, 0);
console.log("PASS: region capture retries, cancellation, staged failures and floater restoration");
