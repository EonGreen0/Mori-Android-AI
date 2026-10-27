import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";

const executablePath = [
  process.env.MORI_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(value => value && existsSync(value));
assert.ok(executablePath, "Chrome or Edge is required");

const server = createDevServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.continue();
  });
  await context.addInitScript(() => {
    localStorage.setItem("mori_lang", "zh");
    localStorage.setItem("mori_filename", "title");
    window.__downloadCalls = [];
    window.__deleteCalls = [];
    window.__scanCalls = [];
    window.__savedEvents = [];
    const files = new Set();
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: value => value,
      Plugins: {
        Filesystem: {
          async checkPermissions() { return { publicStorage: "granted" }; },
          async requestPermissions() { return { publicStorage: "granted" }; },
          async mkdir() {},
          async stat({ path: filePath }) { return files.has(filePath) ? { type: "file", size: 1 } : null; },
          async downloadFile(options) {
            window.__downloadCalls.push({ path: options.path, directory: options.directory });
            files.add(options.path);
            return { path: options.path };
          },
          async rename({ from, to }) { files.add(to); files.delete(from); },
          async copy({ from, to }) { files.add(to); files.delete(from); },
          async deleteFile({ path: filePath, directory }) {
            window.__deleteCalls.push({ path: filePath, directory });
            if (directory === "DATA") {
              files.delete(filePath);
              return;
            }
            throw new Error("gallery_delete_denied");
          },
          async getUri({ path: filePath, directory }) {
            const root = directory === "DATA"
              ? "file:///data/user/0/com.mori.downloader/files/"
              : "file:///storage/emulated/0/";
            return { uri: root + filePath };
          },
          async addListener() { return { remove: async () => {} }; },
          async readFile({ path: filePath }) {
            if (filePath.endsWith(".jpg")) return { data: "AA==" };
            throw new Error("missing");
          },
        },
      },
    };
    window.MoriMainBridge = {
      startDownloadService() {},
      stopDownloadService() {},
      showCompleteNotification() {},
      scanMediaFile(value) { window.__scanCalls.push(value); },
      deleteMediaFile() { return false; },
    };
    window.addEventListener("mori_file_saved", event => window.__savedEvents.push(event.detail));
    window.addEventListener("mori_source_deleted", event => { window.__sourceDeleted = event.detail; });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });

  await page.evaluate(async () => {
    const { chooseDownloadDestination } = await import("/js/ui/downloadDestination.js");
    window.__destinationResult = undefined;
    chooseDownloadDestination().then(value => { window.__destinationResult = value; });
  });
  await page.waitForSelector(".mori-action-overlay.is-visible");
  assert.match(await page.locator(".mori-action-sheet").innerText(), /仅保存到 Mori/);
  assert.match(await page.locator(".mori-action-sheet").innerText(), /同时保存到手机相册/);
  if (process.env.MORI_QA_DIR) {
    await page.waitForTimeout(380);
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "download-destination-sheet.png") });
  }
  await page.locator('[data-action-id="cache"]').click();
  await page.waitForFunction(() => window.__destinationResult === "cache");

  const downloadResult = await page.evaluate(async () => {
    window._moriPlaylistDownloading = true;
    const { startNativeDownload } = await import("/js/ui/nativeDownload.js");
    return startNativeDownload(
      "https://cdn.example.test/photo.jpg",
      "IMAGE",
      "缓存参考图",
      null,
      "https://example.test/source-a",
      true,
      [],
      { storageMode: "cache" },
    );
  });
  assert.equal(downloadResult.success, true);
  assert.equal(downloadResult.storageMode, "cache");
  const cacheCall = await page.evaluate(() => window.__downloadCalls.find(call => call.directory === "DATA"));
  assert.match(cacheCall.path, /^Mori\/Library\/Images\//);
  assert.equal((await page.evaluate(() => window.__scanCalls.length)), 0);
  assert.equal((await page.evaluate(() => window.__savedEvents.at(-1).cachedImage)), true);
  assert.equal((await page.evaluate(() => window.__savedEvents.at(-1).storageMode)), "cache");

  const galleryResult = await page.evaluate(async () => {
    const { startNativeDownload } = await import("/js/ui/nativeDownload.js");
    return startNativeDownload(
      "https://cdn.example.test/gallery.jpg",
      "IMAGE",
      "相册参考图",
      null,
      "https://example.test/source-b",
      true,
      [],
      { storageMode: "gallery" },
    );
  });
  assert.equal(galleryResult.storageMode, "gallery");
  assert.equal((await page.evaluate(() => window.__scanCalls.length)), 1);
  assert.equal((await page.evaluate(() => window.__savedEvents.at(-1).storageMode)), "gallery");

  await page.evaluate(async () => {
    const now = Date.now();
    const thumbA = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 160'%3E%3Crect width='120' height='160' fill='%23d9c7ae'/%3E%3Ccircle cx='60' cy='62' r='24' fill='%23fff6e8'/%3E%3Cellipse cx='60' cy='128' rx='38' ry='42' fill='%2395755e'/%3E%3C/svg%3E";
    const thumbB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 160'%3E%3Crect width='120' height='160' fill='%23bfd8d2'/%3E%3Ccircle cx='58' cy='58' r='23' fill='%23f7f4e9'/%3E%3Cellipse cx='58' cy='125' rx='37' ry='43' fill='%234d6d75'/%3E%3C/svg%3E";
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "album-a", name: "花海" }]));
    localStorage.setItem("mori_history", JSON.stringify([
      {
        title: "链接 A",
        sourceUrl: "https://example.test/source-a",
        url: "https://example.test/source-a",
        timestamp: now,
        localFiles: [
          { path: "Mori/Library/Images/a.jpg", uri: "file:///data/a.jpg", type: "IMAGE", storage: "cache", directory: "DATA", savedAt: now, thumbnail: thumbA },
          { path: "Download/Mori/a-gallery.jpg", uri: "file:///storage/emulated/0/Download/Mori/a-gallery.jpg", type: "IMAGE", storage: "gallery", savedAt: now, thumbnail: thumbA },
        ],
      },
      {
        title: "链接 B",
        sourceUrl: "https://example.test/source-b",
        url: "https://example.test/source-b",
        timestamp: now + 1,
        localFiles: [
          { path: "Mori/Library/Images/b.jpg", uri: "file:///data/b.jpg", type: "IMAGE", storage: "cache", directory: "DATA", savedAt: now + 1, thumbnail: thumbB },
        ],
      },
    ]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({
      "https://example.test/source-a": ["album-a"],
      "https://example.test/source-b": ["album-a"],
    }));
    const inspiration = await import("/js/modules/inspiration.js");
    document.getElementById("homePage").classList.add("hidden");
    document.getElementById("inspirationPage").classList.remove("hidden");
    document.documentElement.classList.add("is-android");
    inspiration.initInspiration();
    inspiration.renderInspiration();
  });
  await page.locator('.album-cover[data-album-id="album-a"]').click();
  await page.waitForSelector(".inspiration-source-menu");
  await page.locator(".inspiration-source-menu").first().click();
  await page.waitForSelector(".mori-action-overlay.is-visible");
  assert.match(await page.locator(".mori-action-sheet").innerText(), /删除链接和图片/);
  if (process.env.MORI_QA_DIR) {
    await page.waitForTimeout(380);
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "album-link-actions.png") });
  }
  await page.locator('[data-action-id="delete-source"]').click();
  await page.waitForFunction(() => !document.getElementById("confirmOverlay").classList.contains("hidden"));
  assert.match(await page.locator("#confirmMessage").innerText(), /链接 A/);
  await page.locator("#okConfirmBtn").click();
  await page.waitForFunction(() => !document.getElementById("infoOverlay").classList.contains("hidden"));
  assert.match(await page.locator("#infoMessage").innerText(), /没有权限删除/);
  const deletion = await page.evaluate(() => window.__sourceDeleted);
  assert.equal(deletion.removedSources, 1);
  assert.equal(deletion.deleted, 1);
  assert.equal(deletion.failed, 1);
  const historyTitles = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mori_history") || "[]").map(item => item.title));
  assert.deepEqual(historyTitles, ["链接 B"]);
  assert.match(JSON.stringify(await page.evaluate(() => window.__deleteCalls)), /Mori\/Library\/Images\/a\.jpg/);
  assert.match(JSON.stringify(await page.evaluate(() => window.__deleteCalls)), /a-gallery\.jpg/);
  assert.deepEqual(errors, []);
  console.log("PASS: private image cache choice, gallery opt-in, no media scan for cache, and link deletion with permission warning path");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
