import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import worker from "../cloudflare/src/index.js";
import { createDevServer } from "./dev-server.mjs";

// Use the real Worker SQL and HTTP routes with isolated SQLite/R2 memory.
class SQLiteD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const migration of ["0001_sync_core.sql", "0002_mutation_hash.sql", "0003_tombstone_guard.sql", "0004_project_directory_archive.sql"])
      this.db.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), "utf8"));
  }
  prepare(sql) {
    const statement = (args = []) => ({
      bind: (...values) => statement(values), first: () => this.db.prepare(sql).get(...args) || null,
      all: () => ({ results: this.db.prepare(sql).all(...args), success: true }),
      run: () => ({ success: true, meta: this.db.prepare(sql).run(...args) }),
    });
    return statement();
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try { const result = statements.map(statement => statement.run()); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
class MemoryR2 {
  objects = new Map();
  object(entry) { return entry ? {
    body: new Response(entry.bytes).body, etag: "fixture", httpEtag: '"fixture"',
    writeHttpMetadata(headers) { headers.set("content-type", entry.options.httpMetadata.contentType); },
  } : null; }
  async head(key) { return this.object(this.objects.get(key)); }
  async get(key) { return this.object(this.objects.get(key)); }
  async put(key, bytes, options) { this.objects.set(key, { bytes: new Uint8Array(bytes), options }); }
}
const env = { DB: new SQLiteD1(), ASSETS: new MemoryR2(), MORI_SYNC_TOKEN: "offline-fixture" };
const requests = [];
let failDownloads = false, failDirectory = false, failPull = false, failOneUpload = false, failPlannerPull = "";
async function requestFixture(request) {
  const url = new URL(request.url);
  requests.push({ url: request.url, method: request.method || "GET", body: request.bodyBase64 || "" });
  if (failOneUpload && request.method === "PUT") {
    failOneUpload = false;
    return { status: 503, bodyBase64: Buffer.from('{"error":"fixture_upload_unavailable"}').toString("base64"), headers: {} };
  }
  if (failDirectory && url.pathname === "/v1/projects") return { status: 503, bodyBase64: Buffer.from('{"error":"offline"}').toString("base64"), headers: {} };
  if (failPull && url.pathname.endsWith("/changes")) throw new Error("fixture pull interrupted");
  if (failPlannerPull && decodeURIComponent(url.pathname).includes(`/projects/${failPlannerPull}/changes`)) throw new Error("fixture plan interrupted");
  if (failDownloads && request.method === "GET" && url.pathname.endsWith("/display")) return { status: 503, bodyBase64: Buffer.from('{"error":"fixture_image_unavailable"}').toString("base64"), headers: {} };
  const headers = new Headers(request.headers || {}); headers.set("authorization", "Bearer offline-fixture");
  const response = await worker.fetch(new Request(request.url, {
    method: request.method || "GET", headers,
    ...(request.bodyBase64 ? { body: Buffer.from(request.bodyBase64, "base64") } : {}),
  }), env);
  return { status: response.status, bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64"), headers: Object.fromEntries(response.headers) };
}
const executablePath = [process.env.MORI_CHROME_PATH, ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)
  .flatMap(dir => [path.join(dir, "Google/Chrome/Application/chrome.exe"), path.join(dir, "Microsoft/Edge/Application/msedge.exe")])].find(value => value && existsSync(value));
assert.ok(executablePath);
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  async function surface(platform) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: platform === "android", viewport: { width: platform === "android" ? 412 : 1280, height: 915 } });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("fixtureRequest", requestFixture);
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
      return route.continue();
    });
    await page.addInitScript(platform => {
      const image = color => {
        const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 24);
        return canvas.toDataURL("image/png").split(",")[1];
      };
      window.fixtureImages = { "C:/private/one.png": image("#ec5a2c"), "C:/private/frame.png": image("#33aabb") };
      window.fixtureReads = [];
      if (platform === "windows") {
        window.__TAURI__ = { core: { invoke: async (command, args) => {
          if (command === "tauri_sync_available") return true;
          if (command === "tauri_sync_authenticated_request") return window.fixtureRequest(args.request);
          if (command === "tauri_sync_manual_backup") return { path: "fixture/backup.json", verified: true, bytes: args.rawText.length };
          if (command === "tauri_read_file_bytes") {
            window.fixtureReads.push(args.path);
            if (!window.fixtureImages[args.path]) throw new Error("fixture file missing");
            return Array.from(atob(window.fixtureImages[args.path]), char => char.charCodeAt(0));
          }
          throw new Error(`Unexpected command ${command}`);
        } } };
      } else {
        // Persist synthetic DATA files across reload without touching host files.
        const readFiles = () => JSON.parse(localStorage.getItem("fixture_data_files") || "{}");
        const key = options => `${options.directory}:${options.path}`;
        const fs = {
          async stat(options) { const data = readFiles()[key(options)]; if (!data || window.fixtureMissingCachedImages && options.path.startsWith("Mori/Sync/Images/")) throw new Error("ENOENT"); return { type: "file", size: atob(data).length }; },
          async getUri(options) { return { uri: `file:///data/app/${options.path}` }; },
          async writeFile(options) {
            if (options.path.startsWith("Mori/Sync/Recovery/") && window.fixtureFailBackup) throw new Error("fixture backup storage full");
            const files = readFiles(); files[key(options)] = options.data; localStorage.setItem("fixture_data_files", JSON.stringify(files));
            if (options.path.startsWith("Mori/Sync/Recovery/") && window.fixtureBackupRace) { const race = window.fixtureBackupRace; window.fixtureBackupRace = null; await race(); }
          },
          async rename(options) { const files = readFiles(); files[key({ ...options, path: options.to })] = files[key({ ...options, path: options.from })]; delete files[key({ ...options, path: options.from })]; localStorage.setItem("fixture_data_files", JSON.stringify(files)); },
          async readFile(options) { const files = readFiles(); const raw = String(options.path).replace("file:///data/app/", ""); const data = files[`DATA:${raw}`]; if (!data) throw new Error("ENOENT"); return { data: raw.startsWith("Mori/Sync/Recovery/") && window.fixtureCorruptBackup ? btoa("{}") : data }; },
        };
        window.Capacitor = { getPlatform: () => "android", Plugins: { Filesystem: fs },
          convertFileSrc: uri => `data:image/jpeg;base64,${readFiles()[`DATA:${uri.replace("file:///data/app/", "")}`] || ""}` };
        window.MoriMainBridge = {
          syncReadOnlyAvailable: () => true, syncPlannerWriteAvailable: () => localStorage.getItem("fixture_write") === "1",
          syncReadOnlyRequestAsync(raw, id) {
            const request = JSON.parse(raw);
            window.fixtureRequest(request).then(response => window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify({
              status: response.status, headers: response.headers, encoding: "base64", data: response.bodyBase64,
            }))).catch(error => window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify({ status: 0, error: error.message })));
          },
          syncPlannerWriteRequestAsync(raw, id) {
            const request = JSON.parse(raw);
            request.bodyBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(request.data)));
            window.fixtureRequest(request).then(response => window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify({
              status: response.status, headers: response.headers,
              data: new TextDecoder().decode(Uint8Array.from(atob(response.bodyBase64), char => char.charCodeAt(0))),
            }))).catch(error => window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify({ status: 0, error: error.message })));
          },
        };
      }
    }, platform);
    await page.goto(origin);
    await page.evaluate(() => { document.getElementById("homePage").classList.add("hidden"); document.getElementById("inspirationPage").classList.remove("hidden"); });
    if (platform === "windows") await page.evaluate(() => document.documentElement.classList.add("is-desktop"));
    return { context, page };
  }
  const pc = await surface("windows");
  await pc.page.evaluate(() => {
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "a", name: "动作参考", createdAt: 1 }, { id: "b", name: "色调参考", createdAt: 2 }]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({ "https://source.example/images": ["a", "b"], "https://source.example/video": ["a"], "https://source.example/link-only": ["b"] }));
    localStorage.setItem("mori_history", JSON.stringify([
      { title: "图片来源", sourceUrl: "https://source.example/images", timestamp: 1000, localFiles: [{ path: "C:/private/one.png", type: "IMAGE", savedAt: 1000 }, { path: "C:/private/frame.png", type: "FRAME", savedAt: 1000, frameTime: 3.5 }] },
      { title: "视频来源", sourceUrl: "https://source.example/video", timestamp: 2000, localFiles: [{ path: "C:/private/full-video.mp4", type: "VIDEO" }, { path: "C:/private/frame.png", type: "FRAME", frameTime: 2.5, savedAt: 2000 }] },
      { title: "视频链接", sourceUrl: "https://source.example/link-only", timestamp: 3000, localFiles: [{ path: "C:/private/second-video.mp4", type: "VIDEO" }] },
    ]));
    // Separate favorite references also enter the whole album library.
    localStorage.setItem("mori_inspiration_favorite_refs_v1", JSON.stringify([{ favoriteId: "fav", title: "收藏截图", timestamp: 4000, localFiles: [{ path: "C:/private/one.png", type: "FRAME", savedAt: 4000 }] }]));
  });
  const originalLocal = await pc.page.evaluate(() => localStorage.getItem("mori_history"));
  await pc.page.evaluate(async () => {
    const inspiration = await import("/js/modules/inspiration.js");
    inspiration.initInspiration(); inspiration.renderInspiration();
    document.querySelectorAll(".inspiration-album-tab")[1].click();
  });
  await pc.page.evaluate(async () => (await import("/js/sync/manualAlbumSync.js")).initManualAlbumSync());
  assert.equal(requests.length, 0, "PC startup must never upload or read a private library remotely");
  const syncPC = async (expectedState = "success") => {
    await pc.page.locator("#albumCloudSyncBtn").click();
    await pc.page.waitForFunction(() => ["success", "warning", "error"].includes(document.getElementById("albumCloudStatus").dataset.state) && !document.getElementById("albumCloudSyncBtn").disabled);
    assert.equal(await pc.page.locator("#albumCloudStatus").getAttribute("data-state"), expectedState, await pc.page.locator("#albumCloudStatus").textContent());
  };
  await syncPC();
  assert.equal(env.ASSETS.objects.size, 2, "same picture in history/favorites uploads only one display");
  assert.equal(await pc.page.evaluate(() => localStorage.getItem("mori_history")), originalLocal);
  assert.equal(await pc.page.evaluate(() => window.fixtureReads.some(path => path.endsWith(".mp4"))), false, "video originals are never read");
  for (const request of requests.filter(request => request.method === "POST" && request.url.endsWith("/mutations")))
    assert.doesNotMatch(Buffer.from(request.body, "base64").toString(), /C:\/private|full-video\.mp4|second-video\.mp4|thumbnail/);
  for (const object of env.ASSETS.objects.values()) {
    assert.equal(object.options.httpMetadata.contentType, "image/jpeg");
    assert.equal(object.bytes[0], 255); assert.equal(object.bytes[1], 216);
  }
  const writesBefore = requests.filter(request => request.method !== "GET").length;
  const revisionsBefore = env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  await syncPC();
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n, revisionsBefore, "unchanged sync must not create more revisions");
  assert.equal(requests.filter(request => request.method === "PUT").length, 2, "unchanged sync reuses cloud files");
  assert(requests.filter(request => request.method !== "GET").length > writesBefore, "asset availability was checked");
  console.log("PASS: production Windows manual album upload through Worker SQL/R2; JPG dedupe, group/video/frame metadata, privacy and unchanged revisions");

  const phone = await surface("android");
  await phone.page.evaluate(() => {
    localStorage.setItem("mori_history", "[]");
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "phone", name: "手机本地" }]));
  });
  const bootPhone = async () => phone.page.evaluate(async () => {
    document.getElementById("homePage").classList.add("hidden");
    document.getElementById("inspirationPage").classList.remove("hidden");
    document.documentElement.classList.add("is-android");
    await (await import("/js/modules/inspiration.js")).initInspiration();
    (await import("/js/modules/inspiration.js")).renderInspiration();
    await (await import("/js/sync/manualAlbumSync.js")).initManualAlbumSync();
    (await import("/js/sync/androidPlannerReadOnlySync.js")).initAndroidAlbumPlannerControls();
    (await import("/js/modules/planner.js")).initPlanner();
  });
  await bootPhone();
  assert.equal(await phone.page.locator("#albumCloudProject option").count(), 1);
  assert.equal(await phone.page.locator("#plannerAndroidCloudProject option").count(), 0, "album projects stay out of Planner directory");
  // Exercise the phone's new cover/menu navigation instead of clicking hidden desktop tabs.
  const phoneOptions = async () => {
    if (await phone.page.locator('#plannerMobileBackBtn').isVisible()) await phone.page.locator('#plannerMobileBackBtn').tap();
    if (!await phone.page.locator('#albumMobileMenu').isVisible()) await phone.page.locator('#albumMobileMore').tap();
    if (!await phone.page.locator('#albumMobileSync').evaluate(element => element.parentElement.open)) await phone.page.locator('#albumMobileMenu .album-sync-details').last().locator('summary').tap();
  };
  const closePhoneOptions = async () => {
    // A fast download can close the menu during this cleanup; perform the visibility check and action together.
    await phone.page.evaluate(() => {
      const menu = document.getElementById('albumMobileMenu');
      if (!menu.classList.contains('hidden')) menu.querySelector('.album-dialog-heading button').click();
    });
  };
  const phoneCloudClick = async selector => {
    await phoneOptions(); await phone.page.locator(selector).click(); await closePhoneOptions();
  };
  const phoneCloudSelect = async id => {
    await phoneOptions(); await phone.page.locator('#albumCloudProject').selectOption(id);
  };
  const phoneAlbum = async name => {
    await closePhoneOptions();
    if (await phone.page.locator('#plannerMobileBackBtn').isVisible()) await phone.page.locator('#plannerMobileBackBtn').tap();
    if (await phone.page.locator('#albumMobileBack').isVisible()) await phone.page.locator('#albumMobileBack').tap();
    if (['all', 'today'].includes(name)) await phone.page.locator(`#albumMobileShortcuts [data-album-id="${name}"]`).tap();
    else await phone.page.locator('.album-cover').filter({ hasText: name }).tap();
  };
  const phonePlanner = async () => {
    await closePhoneOptions();
    if (!await phone.page.locator('#inspirationPlannerModeBtn').isVisible()) await phoneAlbum('today');
    await phone.page.locator('#inspirationPlannerModeBtn').tap();
  };
  const syncPhone = async () => {
    await phoneCloudClick("#albumCloudSyncBtn");
    await phone.page.waitForFunction(() => ["success", "warning", "error"].includes(document.getElementById("albumCloudStatus").dataset.state) && !document.getElementById("albumCloudSyncBtn").disabled);
    assert.equal(await phone.page.locator("#albumCloudStatus").getAttribute("data-state"), "success", await phone.page.locator("#albumCloudStatus").textContent());
  };
  const phoneStart = requests.length;
  await syncPhone();
  assert.equal(requests.slice(phoneStart).every(request => request.method === "GET"), true, "Android album sync remains read-only");
  assert.equal(requests.slice(phoneStart).filter(request => request.url.endsWith("/display")).length, 2);
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_history")), "[]");
  assert.equal(await phone.page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_albums"))[0].id), "phone");
  assert.equal(await phone.page.locator(".inspiration-album-tab").count(), 4);
  await phoneAlbum("all");
  await phone.page.waitForFunction(() => [...document.querySelectorAll("#inspirationStage img")].length === 4 && [...document.querySelectorAll("#inspirationStage img")].every(img => img.complete && img.naturalWidth === 32));
  assert.equal(await phone.page.locator(".inspiration-video-link").count(), 1);
  assert.equal(await phone.page.locator(".inspiration-frame-card").count(), 3);
  const downloads = requests.filter(request => request.method === "GET" && request.url.endsWith("/display")).length;
  await syncPhone();
  assert.equal(requests.filter(request => request.method === "GET" && request.url.endsWith("/display")).length, downloads, "repeat refresh uses persistent DATA files");
  await phone.page.reload(); await bootPhone();
  await phoneAlbum("all");
  await phone.page.waitForFunction(() => [...document.querySelectorAll("#inspirationStage img")].every(img => img.complete && img.naturalWidth === 32));
  assert.equal(requests.filter(request => request.method === "GET" && request.url.endsWith("/display")).length, downloads, "opening after restart requires no image network fetch");

  const beforeFailure = await phone.page.evaluate(() => localStorage.getItem("mori_synced_albums_v1"));
  failPull = true;
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error");
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_synced_albums_v1")), beforeFailure, "interrupted pull preserves the imported library");
  failPull = false; failDirectory = true;
  await phoneCloudClick("#albumCloudReloadBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error");
  assert.equal(await phone.page.locator("#albumCloudProject option").count(), 1);
  assert.equal(await phone.page.locator("#albumCloudSyncBtn").isEnabled(), true);
  failDirectory = false;
  // Remove one source on the PC; refresh only changes imported references.
  await pc.page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("mori_history")); history.splice(1, 1);
    localStorage.setItem("mori_history", JSON.stringify(history));
  });
  await syncPC(); await syncPhone();
  await phoneAlbum("all");
  assert.equal(await phone.page.locator("#inspirationStage img").count(), 3);
  assert.equal(env.ASSETS.objects.size, 2, "removing library references never deletes cloud or local originals");
  console.log("PASS: production Android read-only download/import/render, local-album isolation, saved frame/video link, restart/cache reuse, interrupted reads and PC deletions");

  // Validate missing previews and a failed atomic local storage replacement.
  await phone.page.evaluate(async () => {
    const { saveImportedAlbumLibrary } = await import("/js/sync/albumLibrary.js");
    const { getPlannerSyncCheckpoint } = await import("/js/sync/plannerJournal.js");
    const projectId = document.getElementById("albumCloudProject").value;
    const shared = await getPlannerSyncCheckpoint(projectId);
    const previous = localStorage.getItem("mori_synced_albums_v1");
    try { saveImportedAlbumLibrary(shared, [], { getItem: key => localStorage.getItem(key), setItem() { throw new Error("quota"); } }); throw new Error("quota failure was ignored"); }
    catch (error) { if (error.message !== "quota") throw error; }
    if (previous !== localStorage.getItem("mori_synced_albums_v1")) throw new Error("quota failure changed data");
    localStorage.removeItem("fixture_data_files");
  });
  failDownloads = true;
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "warning");
  await phoneAlbum("all");
  assert.equal(await phone.page.locator(".inspiration-sync-missing").count(), 3, "failed images remain visible as retryable references");
  failDownloads = false; await syncPhone();
  // Exercise more than 300 records and the server's 100-assets-per-query limit.
  await pc.page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("mori_history"));
    for (let index = 0; index < 163; index++) {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = `rgb(${index},40,120)`; ctx.fillRect(0, 0, 32, 24);
      const path = `C:/private/bulk-${index}.png`;
      window.fixtureImages[path] = canvas.toDataURL("image/png").split(",")[1];
      history[0].localFiles.push({ path, type: "IMAGE", title: `图 ${index}`, savedAt: 1000 });
    }
    localStorage.setItem("mori_history", JSON.stringify(history));
  });
  const bulkStart = requests.length;
  const beforeBulk = env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  await syncPC();
  assert(env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n - beforeBulk > 300);
  assert(requests.slice(bulkStart).filter(request => request.url.endsWith("/states")).length >= 2);
  assert(requests.filter(request => request.url.endsWith("/states")).every(request => JSON.parse(Buffer.from(request.body, "base64").toString()).assetIds.length <= 100));
  const putCount = requests.filter(request => request.method === "PUT").length;
  await syncPC();
  assert.equal(requests.filter(request => request.method === "PUT").length, putCount, "all assets beyond the first 100 are reused");
  await pc.page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("mori_history"));
    for (const color of ["#ffffff", "#101010"]) {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 24);
      const path = `C:/private/retry-${color.slice(1)}.png`;
      window.fixtureImages[path] = canvas.toDataURL("image/png").split(",")[1];
      history[0].localFiles.push({ path, type: "IMAGE", savedAt: 1000 });
    }
    localStorage.setItem("mori_history", JSON.stringify(history));
  });
  const beforePartial = env.ASSETS.objects.size;
  failOneUpload = true;
  await syncPC("warning");
  assert.equal(env.ASSETS.objects.size, beforePartial + 1, "one failed upload does not block the remaining images");
  await syncPC();
  assert.equal(env.ASSETS.objects.size, beforePartial + 2, "retry fills the missing cloud image");
  // A missing source file must not delete its previously synchronized image.
  await pc.page.evaluate(() => { delete window.fixtureImages["C:/private/one.png"]; });
  const beforeMissing = env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  await syncPC("warning");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n, beforeMissing);
  await pc.page.evaluate(() => { localStorage.setItem("mori_history", "broken JSON"); });
  await syncPC("error");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n, beforeMissing, "corrupt local source never uploads an empty destructive snapshot");
  assert.deepEqual(errors, []);
  console.log("PASS: incomplete image downloads are reported and recover on retry; quota failure preserves the last local library");
  console.log("PASS: bulk library batches, 100-asset state pagination/reuse, unreadable-source preservation and corrupt-local-data rejection");

  // The real one-click UI publishes two independent album groups and their
  // existing Planner projects. No cloud deployment or user profile is used.
  await pc.page.evaluate(async () => {
    const nodes = (prefix, path, x) => [
      { id: `${prefix}-g`, type: "group", x: 20, y: 20, w: 600, h: 450, text: "动作分组", memberIds: [`${prefix}-i`, `${prefix}-t`] },
      { id: `${prefix}-i`, type: "image", x, y: 60, w: 240, path, comment: "现场备注", rotation: 15 },
      { id: `${prefix}-t`, type: "text", x: 300, y: 250, w: 190, text: prefix === "b" ? "较长的策划文字，用来验证浏览不产生修改。".repeat(3) : `${prefix} 的策划文字` },
    ];
    localStorage.setItem("mori_inspiration_favorite_refs_v1", "[]");
    localStorage.setItem("mori_history", JSON.stringify([
      { title: "A 素材", sourceUrl: "https://source.example/a", timestamp: 1000, localFiles: [{ path: "C:/private/one.png", type: "IMAGE", savedAt: 1000 }] },
      { title: "B 素材", sourceUrl: "https://source.example/b", timestamp: 1000, localFiles: [{ path: "C:/private/frame.png", type: "FRAME", savedAt: 1000, frameTime: 3.5 }] },
    ]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({ "https://source.example/a": ["a"], "https://source.example/b": ["b"] }));
    // Restore the synthetic source deliberately removed by the previous test.
    window.fixtureImages["C:/private/one.png"] = window.fixtureImages["C:/private/frame.png"];
    const index = { version: 2, projects: {}, activeProjectByAlbum: { a: "plan-a", b: "plan-b" }, legacyMigration: { completed: true } };
    for (const [suffix, image, x] of [["a", "one", 110], ["b", "frame", 160]]) {
      const projectId = `plan-${suffix}`;
      index.projects[projectId] = { projectId, title: `策划 ${suffix}`, albumIds: [suffix] };
      localStorage.setItem(`mori_planner_board_v2:${projectId}`, JSON.stringify({ projectId, projectTitle: `策划 ${suffix}`,
        nodes: nodes(suffix, `C:/private/${image}.png`, x), edges: [{ id: `${suffix}-edge`, from: `${suffix}-i`, to: `${suffix}-t` }],
        view: { zoom: 0.8, panX: 20, panY: 20 }, importCount: 1, commentFontSize: 17, readOnly: false }));
    }
    localStorage.setItem("mori_planner_projects_v2", JSON.stringify(index));
    const inspiration = await import("/js/modules/inspiration.js"); inspiration.renderInspiration();
    (await import("/js/modules/planner.js")).initPlanner();
  });
  const pcGroup = name => pc.page.locator(".inspiration-album-tab").filter({ hasText: name });
  await pcGroup("动作参考").click(); await syncPC();
  const groupA = await pc.page.evaluate(async () => (await import("/js/sync/outbox.js")).getPlannerSyncMeta("album_group_project_id_v1:a"));
  await pcGroup("色调参考").click(); await syncPC();
  const groupB = await pc.page.evaluate(async () => (await import("/js/sync/outbox.js")).getPlannerSyncMeta("album_group_project_id_v1:b"));
  assert.notEqual(groupA, groupB);
  // Upgrade a phone that used the old standalone Planner directory: the plan
  // exists with an unsent text edit, but its new album has never been imported.
  await phone.page.evaluate(async () => {
    localStorage.setItem("fixture_write", "1");
    const planner = await import("/js/modules/planner.js");
    await planner.prepareAndroidReadOnlyPlannerProject({ projectId: "plan-a", title: "策划 a" });
    const { createCloudflareTransport } = await import("/js/sync/cloudflareTransport.js");
    const { createAndroidReadOnlyAuthenticatedFetch } = await import("/js/sync/androidAuthenticatedFetch.js");
    const transport = createCloudflareTransport({ id: "cloudflare-android-readonly-test", baseUrl: "https://mori-sync-gateway-test.pages.dev", nativeAuth: true,
      fetchImpl: createAndroidReadOnlyAuthenticatedFetch() });
    await (await import("/js/sync/syncEngine.js")).pullPlannerRemoteStateReadOnly({ transport, projectId: "plan-a",
      applyRemoteShared: shared => planner.applyPlannerMergedSharedState(shared) });
    const saved = JSON.parse(localStorage.getItem("mori_planner_board_v2:plan-a"));
    const journal = await import("/js/sync/plannerJournal.js");
    const oldCheckpoint = await journal.getPlannerSyncCheckpoint("plan-a");
    for (const state of [saved, oldCheckpoint]) {
      for (const node of state.nodes) { delete node.commentScale; delete node.groupLabelScale; }
    }
    await (await import("/js/sync/outbox.js")).setPlannerSyncMeta(journal.plannerCheckpointKey("plan-a"), oldCheckpoint);
    saved.nodes.find(node => node.type === "text").text = "旧手机版保留的修改";
    localStorage.setItem("mori_planner_board_v2:plan-a", JSON.stringify(saved));
    const index = JSON.parse(localStorage.getItem("mori_planner_projects_v2"));
    index.activeProjectByAlbum.today = "plan-a";
    index.activeProjectByAlbum["phone-local"] = "phone-local-plan";
    index.projects["plan-a"].albumIds = ["today"];
    index.projects["phone-local-plan"] = { projectId: "phone-local-plan", title: "手机本地策划", albumIds: ["phone-local"] };
    localStorage.setItem("mori_planner_projects_v2", JSON.stringify(index));
    localStorage.setItem("fixture_old_index", JSON.stringify(index));
    localStorage.setItem("fixture_old_plan", JSON.stringify(saved));
    localStorage.setItem("mori_android_planner_directory_v1", JSON.stringify({ projects: [{ projectId: "plan-a", title: "策划 a" }] }));
    (await import("/js/sync/androidPlannerReadOnlySync.js")).initAndroidAlbumPlannerControls();
  });
  await phone.page.reload(); await bootPhone();
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_android_album_binding_backup_v1") === localStorage.getItem("fixture_old_index")), true);
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_planner_board_v2:plan-a") === localStorage.getItem("fixture_old_plan")), true, "repair keeps old board and unsent edits intact");
  const repairedIndex = await phone.page.evaluate(() => JSON.parse(localStorage.getItem("mori_planner_projects_v2")));
  assert.equal(repairedIndex.activeProjectByAlbum.today, undefined, "old standalone cloud plan is detached from Today");
  assert.equal(repairedIndex.activeProjectByAlbum["phone-local"], "phone-local-plan", "unrelated local association is preserved");
  await phonePlanner();
  await phone.page.waitForFunction(() => document.documentElement.classList.contains("planner-android-fullscreen"));
  const todayPlan = await phone.page.evaluate(async () => (await import("/js/modules/planner.js")).getPlannerSyncSnapshot());
  assert.notEqual(todayPlan.projectId, "plan-a", "Today opens a new local plan instead of a detached cloud plan");
  await phone.page.locator("#plannerMobileBackBtn").tap();
  await phoneCloudClick("#albumCloudReloadBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudProject").options.length === 3);
  assert.equal(await phone.page.locator("#plannerAndroidCloudControls").isVisible(), false, "no separate Planner download UI");
  for (const [groupId, projectId, name, x] of [[groupA, "plan-a", "动作参考", 110], [groupB, "plan-b", "色调参考", 160]]) {
    await phoneCloudSelect(groupId); await syncPhone();
    const saved = await phone.page.evaluate(projectId => JSON.parse(localStorage.getItem(`mori_planner_board_v2:${projectId}`)), projectId);
    assert.equal(saved.projectTitle, projectId === "plan-a" ? "策划 a" : "策划 b");
    if (projectId === "plan-a") assert.equal(saved.nodes.find(node => node.type === "text").text, "旧手机版保留的修改", "first scoped album import uploads the old standalone plan's edit");
    assert.equal(saved.nodes.find(node => node.type === "image").x, x);
    assert.equal(saved.nodes.find(node => node.type === "image").comment, "现场备注");
    assert(saved.nodes.find(node => node.type === "image").uri.startsWith("file:///data/app/"));
    assert.equal(saved.nodes.filter(node => node.type === "group").length, 1); assert.equal(saved.edges.length, 1);
    await phonePlanner();
    const selected = await phone.page.evaluate(async () => (await import("/js/modules/planner.js")).getPlannerSyncSnapshot());
    assert.equal(selected.projectId, projectId, "switch inside the downloaded album opens its own plan");
    await phone.page.locator("#plannerMobileFitBtn").tap();
    await phone.page.locator("#plannerMobileBackBtn").tap();
    assert.equal(await phone.page.evaluate(() => document.documentElement.classList.contains("planner-android-fullscreen")), false);
    assert.equal(await phone.page.locator(".inspiration-album-tab.active").textContent(), name);
    if (projectId === "plan-b") {
      const priorWrites = requests.filter(request => request.method === "POST").length;
      await phone.page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("mori_planner_board_v2:plan-b"));
        saved.nodes.find(node => node.type === "text").w = 190; // Width stored by the old loader, without a human edit.
        localStorage.setItem("mori_planner_board_v2:plan-b", JSON.stringify(saved));
      });
      await syncPhone();
      assert.equal(requests.filter(request => request.method === "POST").length, priorWrites, "old automatic text width is repaired without uploading an edit");
    }
  }
  await phoneAlbum("动作参考");
  await phonePlanner();
  assert.equal((await phone.page.evaluate(async () => (await import("/js/modules/planner.js")).getPlannerSyncSnapshot())).projectId, "plan-a");
  await phone.page.locator("#plannerMobileBackBtn").tap();
  await phone.page.evaluate(() => {
    const libraries = JSON.parse(localStorage.getItem("mori_synced_albums_v1"));
    const scoped = Object.values(libraries).find(library => library.sourceAlbumId === "a");
    const oldId = `synced:${scoped.sourceLibraryId}:a`;
    const old = { title: "旧全库", albums: [{ id: oldId, name: "动作参考", synced: true }],
      groups: scoped.groups.map(group => ({ ...group, syncGroupId: `legacy:${group.syncGroupId}`, syncedAlbumIds: [oldId] })) };
    libraries[scoped.sourceLibraryId] = old;
    localStorage.setItem("fixture_old_library", JSON.stringify(old));
    localStorage.setItem("mori_synced_albums_v1", JSON.stringify(libraries));
  });
  await phone.page.evaluate(async () => (await import("/js/modules/inspiration.js")).renderInspiration());
  assert.equal(await phone.page.locator(".inspiration-album-tab").filter({ hasText: "动作参考" }).count(), 1, "upgrade does not duplicate the same legacy album tab");
  assert.equal(await phone.page.evaluate(() => {
    const libraries = JSON.parse(localStorage.getItem("mori_synced_albums_v1"));
    const scoped = Object.values(libraries).find(item => item.sourceAlbumId === "a");
    return JSON.stringify(libraries[scoped.sourceLibraryId]) === localStorage.getItem("fixture_old_library");
  }), true, "legacy stored records remain recoverable");
  await phone.page.reload(); await bootPhone();
  await phoneAlbum("色调参考");
  await phonePlanner();
  assert.equal((await phone.page.evaluate(async () => (await import("/js/modules/planner.js")).getPlannerSyncSnapshot())).projectId, "plan-b", "album/plan binding survives restart");
  await phone.page.locator("#plannerMobileBackBtn").tap();

  // A plan pull failure and a quota failure keep both the last album and plan.
  const pairBefore = await phone.page.evaluate(() => ({ library: localStorage.getItem("mori_synced_albums_v1"), board: localStorage.getItem("mori_planner_board_v2:plan-b") }));
  failPlannerPull = "plan-b";
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error" && !document.getElementById("albumCloudSyncBtn").disabled);
  assert.deepEqual(await phone.page.evaluate(() => ({ library: localStorage.getItem("mori_synced_albums_v1"), board: localStorage.getItem("mori_planner_board_v2:plan-b") })), pairBefore);
  failPlannerPull = "";
  await phone.page.evaluate(() => {
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "mori_synced_albums_v1") throw new Error("fixture bundle quota"); return nativeSet.call(this, key, value); };
    window.restoreFixtureStorage = () => { Storage.prototype.setItem = nativeSet; };
  });
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error" && !document.getElementById("albumCloudSyncBtn").disabled);
  assert.deepEqual(await phone.page.evaluate(() => ({ library: localStorage.getItem("mori_synced_albums_v1"), board: localStorage.getItem("mori_planner_board_v2:plan-b") })), pairBefore);
  await phone.page.evaluate(() => window.restoreFixtureStorage());
  await syncPhone();

  // Enable the real restricted mobile writer, add one text node, and use the
  // same in-album sync action to upload it before the group is downloaded.
  await phone.page.evaluate(async () => {
    localStorage.setItem("fixture_write", "1");
    (await import("/js/sync/androidPlannerReadOnlySync.js")).initAndroidAlbumPlannerControls();
  });
  await phonePlanner();
  const beforeText = await phone.page.locator(".planner-node-text").count();
  await phone.page.locator("#plannerMobileAddTextBtn").tap();
  assert.equal(await phone.page.locator(".planner-node-text").count(), beforeText + 1);
  assert.equal(await phone.page.locator("#plannerMobileUploadChangesBtn").textContent(), "同步相册");
  await phone.page.locator("#plannerMobileUploadChangesBtn").tap();
  await phone.page.waitForFunction(() => ["success", "warning", "error"].includes(document.getElementById("albumCloudStatus").dataset.state) && !document.getElementById("albumCloudSyncBtn").disabled);
  assert.equal(await phone.page.locator("#albumCloudStatus").getAttribute("data-state"), "success", await phone.page.locator("#albumCloudStatus").textContent());
  assert.equal(await phone.page.locator(".planner-node-text").count(), beforeText + 1);
  await phone.page.locator("#plannerMobileBackBtn").tap();
  await pcGroup("色调参考").click(); await syncPC();
  const pcPlan = await pc.page.evaluate(() => JSON.parse(localStorage.getItem("mori_planner_board_v2:plan-b")));
  assert.equal(pcPlan.nodes.filter(node => node.type === "text").length, beforeText + 1, "phone change returns to the matching PC album's plan");
  await phonePlanner();
  await phone.page.locator("#plannerMobileAddTextBtn").tap();
  await phone.page.locator("#plannerMobileBackBtn").tap();
  const unsent = await phone.page.evaluate(() => localStorage.getItem("mori_planner_board_v2:plan-b"));
  await phone.page.evaluate(() => localStorage.setItem("fixture_write", "0"));
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error" && !document.getElementById("albumCloudSyncBtn").disabled);
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_planner_board_v2:plan-b")), unsent, "read-only retry cannot replace unuploaded mobile edits");
  await phone.page.evaluate(() => localStorage.setItem("fixture_write", "1"));
  await syncPhone();
  assert.equal(await phone.page.evaluate(() => localStorage.getItem("mori_history")), "[]");
  // The explicit PC-authoritative recovery handles an old unsupported queue.
  // Normal sync remains strict; recovery reads everything before replacing it.
  await phone.page.evaluate(async () => {
    const board = JSON.parse(localStorage.getItem("mori_planner_board_v2:plan-b"));
    board.nodes.find(node => node.type === "text").text = "手机旧版独有文字，必须在备份中";
    localStorage.setItem("mori_planner_board_v2:plan-b", JSON.stringify(board));
    await (await import("/js/sync/outbox.js")).enqueuePlannerMutations([
      { opId: "old-unsupported-project", projectId: "plan-b", entityType: "project", entityId: "plan-b", operation: "upsert", payload: { id: "plan-b", title: "旧记录" } },
      { opId: "unrelated-phone-edit", projectId: "plan-a", entityType: "project", entityId: "plan-a", operation: "upsert", payload: { id: "plan-a", title: "另一组未上传修改" } },
    ]);
    window.recoveryFixtureState = async () => {
      const { openPlannerSyncDb } = await import("/js/sync/database.js");
      const db = await openPlannerSyncDb();
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction("meta").objectStore("meta").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return { rawStorage: Object.fromEntries(["mori_planner_projects_v2", "mori_synced_albums_v1", "mori_planner_board_v2:plan-b"].map(key => [key, localStorage.getItem(key)])),
        operations: await (await import("/js/sync/outbox.js")).listPlannerOutbox({ all: true }), metadata: records };
    };
  });
  const beforeRecovery = await phone.page.evaluate(() => window.recoveryFixtureState());
  const recoverPhone = async expected => {
    await phoneCloudClick("#albumCloudRebuildBtn");
    await phone.page.locator("#okConfirmBtn").click();
    await phone.page.waitForFunction(() => ["success", "error"].includes(document.getElementById("albumCloudStatus").dataset.state) && !document.getElementById("albumCloudSyncBtn").disabled);
    assert.equal(await phone.page.locator("#albumCloudStatus").getAttribute("data-state"), expected, await phone.page.locator("#albumCloudStatus").textContent());
  };
  await phoneCloudClick("#albumCloudSyncBtn");
  await phone.page.waitForFunction(() => document.getElementById("albumCloudStatus").dataset.state === "error" && !document.getElementById("albumCloudSyncBtn").disabled);
  assert.match(await phone.page.locator("#albumCloudStatus").textContent(), /受限 Planner 节点修改/);
  // The normal writer may normalize old view defaults; capture its preserved
  // saved state before testing recovery's exact rollback boundaries.
  const recoveryBaseline = await phone.page.evaluate(() => window.recoveryFixtureState());
  assert.deepEqual(recoveryBaseline.operations, beforeRecovery.operations);
  await phoneCloudClick("#albumCloudRebuildBtn");
  await phone.page.locator("#cancelConfirmBtn").click();
  assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "cancelling recovery preserves all local records");
  failPlannerPull = "plan-b"; await recoverPhone("error"); failPlannerPull = "";
  assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "failed full remote pull preserves queue, checkpoints and saved pair");
  await phone.page.evaluate(() => { window.fixtureMissingCachedImages = true; });
  failDownloads = true; await recoverPhone("error"); failDownloads = false;
  await phone.page.evaluate(() => { window.fixtureMissingCachedImages = false; });
  assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "incomplete remote photos stop replacement");
  for (const flag of ["fixtureFailBackup", "fixtureCorruptBackup"]) {
    await phone.page.evaluate(flag => { window[flag] = true; }, flag); await recoverPhone("error");
    await phone.page.evaluate(flag => { window[flag] = false; }, flag);
    assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "failed/unreadable backup never removes old edits");
  }
  await phone.page.evaluate(() => {
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "mori_synced_albums_v1") throw new Error("fixture recovery quota"); return nativeSet.call(this, key, value); };
    window.restoreFixtureStorage = () => { Storage.prototype.setItem = nativeSet; };
  });
  await recoverPhone("error"); await phone.page.evaluate(() => window.restoreFixtureStorage());
  assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "quota failure rolls back saved plan/index and keeps exact queue/metadata");
  await phone.page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(record, ...args) { if (record.key === "planner_checkpoint_v1:plan-b") throw new Error("fixture recovery transaction failure"); return nativePut.call(this, record, ...args); };
    window.restoreFixtureDb = () => { IDBObjectStore.prototype.put = nativePut; };
  });
  await recoverPhone("error"); await phone.page.evaluate(() => window.restoreFixtureDb());
  assert.deepEqual(await phone.page.evaluate(() => window.recoveryFixtureState()), recoveryBaseline, "IndexedDB abort rolls back the visible pair and atomically retains old outbox/checkpoints");
  await phone.page.evaluate(() => {
    window.fixtureBackupRace = async () => (await import("/js/sync/outbox.js")).enqueuePlannerMutations([
      { opId: "new-during-recovery", projectId: "plan-b", entityType: "project", entityId: "plan-b", operation: "upsert", payload: { id: "plan-b", title: "恢复期间新增" } },
    ]);
  });
  await recoverPhone("error");
  const racedRecovery = await phone.page.evaluate(() => window.recoveryFixtureState());
  assert.deepEqual(racedRecovery.rawStorage, recoveryBaseline.rawStorage);
  assert.deepEqual(racedRecovery.metadata, recoveryBaseline.metadata);
  assert.equal(racedRecovery.operations.length, recoveryBaseline.operations.length + 1, "newly queued changes stop recovery without dropping any record");
  const postsBeforeRecovery = requests.filter(request => request.method === "POST").length;
  await recoverPhone("success");
  const afterRecovery = await phone.page.evaluate(() => window.recoveryFixtureState());
  assert.equal(requests.filter(request => request.method === "POST").length, postsBeforeRecovery, "PC-authoritative recovery never uploads unsupported old mutations");
  assert.deepEqual(afterRecovery.operations, recoveryBaseline.operations.filter(op => op.projectId !== "plan-b"), "only the selected pair's backed-up edits leave the active queue");
  const phoneRecoveredBoard = JSON.parse(afterRecovery.rawStorage["mori_planner_board_v2:plan-b"]);
  assert.equal(phoneRecoveredBoard.nodes.find(node => node.id === "b-t").text, pcPlan.nodes.find(node => node.id === "b-t").text);
  const recoveryBackup = await phone.page.evaluate(async () => {
    const module = await import("/js/sync/androidAlbumRecovery.js");
    return module.readAndroidAlbumRecoveryBackup(module.getLastAndroidAlbumRecoveryBackup().path);
  });
  assert.deepEqual(recoveryBackup.rawStorage, racedRecovery.rawStorage, "verified UTF-8 backup retains exact original board/index/libraries");
  assert.deepEqual(recoveryBackup.operations, racedRecovery.operations.filter(op => op.projectId === "plan-b"));
  await phoneOptions();
  assert.equal(await phone.page.locator("#albumCloudBackupBtn").isVisible(), true);
  await syncPhone();
  assert.equal(requests.filter(request => request.method === "POST").length, postsBeforeRecovery, "normal sync after recovery has no phantom local edits");
  await phone.page.reload(); await bootPhone();
  await phoneOptions();
  assert.equal(await phone.page.locator("#albumCloudBackupBtn").isVisible(), true, "backup remains discoverable after restart");
  await phoneAlbum("色调参考");
  await phonePlanner();
  assert.equal((await phone.page.evaluate(async () => (await import("/js/modules/planner.js")).getPlannerSyncSnapshot())).projectId, "plan-b");
  await phone.page.locator("#plannerMobileBackBtn").tap();
  console.log("PASS: unsupported old queue recovery backs up exact local data; cancel/remote/image/backup/quota/transaction/race failures preserve edits; scoped atomic replacement and normal sync/restart pass");
  assert.deepEqual(errors, []);
  if (process.env.MORI_QA_DIR) {
    await phone.page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mori-album-mobile.png") });
    await phonePlanner();
    await phone.page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mori-planner-mobile.png") });
    await pc.page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mori-album-desktop.png") });
  }
  console.log("PASS: one album action includes its existing plan; independent groups, in-album switching/restart, native taps on all four controls, paired failure rollback and mobile text round-trip through Worker SQL/R2");
  await pc.context.close(); await phone.context.close();
} finally {
  if (browser) await browser.close();
  server.close(); await once(server, "close");
}
