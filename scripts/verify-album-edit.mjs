import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
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

async function longPress(page, selector) {
  const card = page.locator(selector);
  await card.dispatchEvent("pointerdown", {
    pointerType: "touch", button: 0, clientX: 100, clientY: 100,
  });
  await page.waitForTimeout(600);
  await card.dispatchEvent("pointerup", {
    pointerType: "touch", button: 0, clientX: 100, clientY: 100,
  });
  await page.waitForFunction(() => document.getElementById("albumEditOverlay"));
}

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
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    const now = Date.now();
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([
      { id: "a", name: "花海拍摄" },
      { id: "b", name: "人像参考" },
    ]));
    localStorage.setItem("mori_history", JSON.stringify([{
      title: "花海来源", sourceUrl: "https://example.test/flower", timestamp: now,
      localFiles: [{ path: image, uri: image, type: "IMAGE", title: "花海", savedAt: now }],
    }]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({
      "https://example.test/flower": ["a"],
    }));
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: uri => uri,
      Plugins: { Filesystem: {} },
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async () => {
    document.getElementById("homePage").classList.add("hidden");
    document.getElementById("inspirationPage").classList.remove("hidden");
    document.documentElement.classList.add("is-android");
    const inspiration = await import("/js/modules/inspiration.js");
    inspiration.initInspiration();
    inspiration.renderInspiration();
  });

  await longPress(page, '[data-album-id="a"]');
  assert.match(await page.locator("#albumEditOverlay").innerText(), /重命名相册/);
  if (process.env.MORI_QA_DIR) {
    const { mkdirSync } = await import("node:fs");
    const path = await import("node:path");
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "album-long-press-edit.png"), fullPage: false });
  }
  await page.locator('[data-action="rename"]').click();
  await page.locator("#inspirationAlbumNameInput").fill("花海精选");
  await page.locator("#okConfirmBtn").click();
  let albums = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_albums")));
  assert.ok(albums.some(album => album.id === "a" && album.name === "花海精选"));

  await longPress(page, '[data-album-id="a"]');
  await page.locator('[data-action="merge"]').click();
  await page.locator("#albumMergeTarget").selectOption("b");
  await page.locator('[data-action="merge-confirm"]').click();
  albums = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_albums")));
  let assignments = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_link_albums")));
  assert.equal(albums.some(album => album.id === "a"), false);
  assert.deepEqual(assignments["https://example.test/flower"], ["b"]);

  await longPress(page, '[data-album-id="b"]');
  await page.locator('[data-action="delete"]').click();
  await page.locator("#okConfirmBtn").click();
  albums = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_albums")));
  assignments = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_link_albums")));
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_history")));
  assert.equal(albums.length, 0);
  assert.equal(Object.keys(assignments).length, 0);
  assert.equal(history.length, 1, "deleting an album must preserve downloaded history");
  assert.deepEqual(errors, []);
  console.log("PASS: long-press album editing, rename, merge, delete and preservation of original history");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
