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
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARMAgYGBgAAAeAAH8j2q9AAAAAElFTkSuQmCC",
  "base64",
);

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
    window.__galleryWrites = [];
    window.__galleryFail = false;
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: uri => uri,
      Plugins: {
        Filesystem: {
          writeFile: async args => {
            if (window.__galleryFail) throw new Error("fixture storage failure");
            window.__galleryWrites.push({ path: args.path, data: args.data });
            return { uri: `file:///data/user/0/com.mori.downloader/files/${args.path}` };
          },
          getUri: async args => ({
            uri: `file:///data/user/0/com.mori.downloader/files/${args.path}`,
          }),
          deleteFile: async () => {},
        },
      },
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async () => {
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "target", name: "手机相册" }]));
    localStorage.setItem("mori_history", "[]");
    localStorage.setItem("mori_inspiration_link_albums", "{}");
    document.getElementById("homePage").classList.add("hidden");
    document.getElementById("inspirationPage").classList.remove("hidden");
    const inspiration = await import("/js/modules/inspiration.js");
    inspiration.initInspiration();
    inspiration.renderInspiration();
    (await import("/js/modules/albumPackage.js")).initAlbumPackageControls();
  });

  await page.locator('[data-album-id="target"]').tap();
  await page.locator("#albumMobileMore").tap();
  const packageDetails = page.locator("#albumPackageControls");
  if (!(await packageDetails.evaluate(element => element.open))) {
    await packageDetails.locator("summary").tap();
  }
  assert.equal(await page.locator("#albumGalleryImportBtn").isVisible(), true);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#albumGalleryImportBtn").tap();
  await (await chooser).setFiles([
    { name: "海边.png", mimeType: "image/png", buffer: png },
    { name: "人物.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForFunction(() => {
    const history = JSON.parse(localStorage.getItem("mori_history") || "[]");
    return history.some(item => item.localImportId && item.localFiles?.length === 2);
  });

  const state = await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("mori_history") || "[]");
    const item = history.find(entry => entry.localImportId);
    const assignments = JSON.parse(localStorage.getItem("mori_inspiration_link_albums") || "{}");
    return {
      item,
      assignment: assignments[`local-import:${item.localImportId}`],
      writes: window.__galleryWrites,
    };
  });
  assert.equal(state.item.localFiles.length, 2);
  assert.deepEqual(state.assignment, ["target"]);
  assert.equal(state.writes.length, 2);
  assert.ok(state.writes.every(write => write.path.startsWith("Mori/GalleryImports/")));
  assert.equal(await page.locator(".inspiration-lane").count(), 1);

  await page.evaluate(() => {
    window.__galleryFail = true;
  });
  await page.locator("#albumMobileMore").tap();
  if (!(await packageDetails.evaluate(element => element.open))) {
    await packageDetails.locator("summary").tap();
  }
  const failedChooser = page.waitForEvent("filechooser");
  await page.locator("#albumGalleryImportBtn").tap();
  await (await failedChooser).setFiles([
    { name: "失败.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForFunction(() => document.querySelector("#albumGalleryStatus").dataset.state === "error");
  assert.equal(await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mori_history") || "[]").filter(item => item.localImportId).length
  ), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: Android gallery multi-select, persistent image copy, current-album assignment, rendering and rollback");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
