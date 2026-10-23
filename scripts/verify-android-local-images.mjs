import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const utilsRoot = path.join(root, "public", "js", "utils");
const moduleFiles = new Map([
  ["/public/js/utils/localImage.js", path.join(utilsRoot, "localImage.js")],
  ["/public/js/utils/plugins.js", path.join(utilsRoot, "plugins.js")],
]);

function findBrowser() {
  if (process.env.MORI_CHROME_PATH) return process.env.MORI_CHROME_PATH;
  const programDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const candidates = programDirs.flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
  const executablePath = candidates.find(existsSync);
  if (!executablePath) throw new Error("Chrome or Edge was not found; set MORI_CHROME_PATH to its executable");
  return executablePath;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function makePng(red, green, blue) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = deflateSync(Buffer.from([0, red, green, blue, 255]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const pngRed = makePng(220, 20, 20);
const pngGreen = makePng(20, 180, 40);
const pngBlue = makePng(20, 40, 220);
const server = createServer((_request, response) => response.writeHead(404).end());
let browser;
let requestUrls = [];

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.__moriPlatform = "android";
    window.__fsCalls = { getUri: [], readFile: [] };
    window.__fsHandlers = {
      async getUri() { throw new Error("Unexpected getUri call"); },
      async readFile() { throw new Error("Unexpected readFile call"); },
    };
    const filesystem = {
      async getUri(options) {
        window.__fsCalls.getUri.push({ ...options });
        return window.__fsHandlers.getUri(options);
      },
      async readFile(options) {
        window.__fsCalls.readFile.push({ ...options });
        return window.__fsHandlers.readFile(options);
      },
    };
    window.Capacitor = {
      getPlatform: () => window.__moriPlatform,
      Plugins: { Filesystem: filesystem },
      convertFileSrc(raw) {
        const value = String(raw);
        if (value.startsWith("file://")) {
          return location.origin + value.replace("file://", "/_capacitor_file_");
        }
        if (value.startsWith("content://")) {
          return location.origin + value.replace("content:/", "/_capacitor_content_");
        }
        return value;
      },
    };
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") {
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><meta charset="utf-8"><title>READY</title><body><script type="module">
          import { loadAndroidLocalImage } from "/public/js/utils/localImage.js";
          window.loadAndroidLocalImage = loadAndroidLocalImage;
          document.title = "READY";
        </script></body>`,
      });
    }
    if (moduleFiles.has(url.pathname)) {
      return route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: await readFile(moduleFiles.get(url.pathname)),
      });
    }
    if (url.pathname.startsWith("/_capacitor_file_/")) {
      requestUrls.push(url.href);
      const localPath = decodeURIComponent(url.pathname.slice("/_capacitor_file_".length));
      if (
        localPath.includes("relative-external-miss") ||
        localPath.includes("missing-first") ||
        localPath.includes("/cache/") ||
        localPath.includes("/unavailable/")
      ) {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "synthetic missing file" });
      }
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(pngGreen, "base64") });
    }
    if (url.pathname.startsWith("/_capacitor_content_/")) {
      requestUrls.push(url.href);
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(pngBlue, "base64") });
    }
    return route.abort();
  });

  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.loadAndroidLocalImage === "function");
  const fallbackDataUrl = `data:image/png;base64,${pngRed}`;

  const relative = await page.evaluate(async ({ fallback }) => {
    const source = "Download/Mori/relative image #1% 猫.png";
    window.__fsHandlers.getUri = async ({ directory, path }) => {
      if (path !== source) throw new Error("Unexpected relative path");
      if (directory === "EXTERNAL_STORAGE") {
        return { uri: "file:///storage/emulated/0/Download/Mori/relative-external-miss.png" };
      }
      if (directory === "DOCUMENTS") {
        return { uri: "file:///storage/emulated/0/Documents/relative%20image%20%231%25%20%E7%8C%AB.png" };
      }
      throw new Error(`Unexpected directory ${directory}`);
    };
    window.__fsHandlers.readFile = async ({ directory }) => {
      if (directory === "EXTERNAL_STORAGE") throw new Error("synthetic inaccessible legacy path");
      throw new Error("A successfully displayed URI should not be read again");
    };
    const image = document.createElement("img");
    let existingLoadHandlerCalls = 0;
    image.onload = () => { existingLoadHandlerCalls += 1; };
    const handled = await window.loadAndroidLocalImage(image, source, fallback);
    return {
      handled,
      connectedDuringLoad: image.isConnected,
      naturalWidth: image.naturalWidth,
      state: image.dataset.localImageState,
      getUri: window.__fsCalls.getUri,
      readFile: window.__fsCalls.readFile,
      existingLoadHandlerCalls,
      src: image.src,
    };
  }, { fallback: fallbackDataUrl });
  assert.equal(relative.handled, true, "Android helper must take over relative local paths");
  assert.equal(relative.connectedDuringLoad, false, "the production image element is loaded before DOM insertion");
  assert.equal(relative.naturalWidth, 1, "the decoded relative-path PNG must have real image dimensions");
  assert.equal(relative.state, "loaded");
  assert.deepEqual(relative.getUri.map((call) => call.directory), ["EXTERNAL_STORAGE", "DOCUMENTS"]);
  assert.equal(relative.getUri[0].path, "Download/Mori/relative image #1% 猫.png");
  assert.deepEqual(relative.readFile.map((call) => call.directory), ["EXTERNAL_STORAGE"]);
  assert.equal(relative.existingLoadHandlerCalls, 1, "helper listeners must preserve caller onload handlers");

  const cached = await page.evaluate(async ({ png }) => {
    const path = "file:///data/user/0/com.mori.downloader/cache/Mori/PlannerSync/preview.png";
    window.__fsCalls.readFile = [];
    window.__fsHandlers.readFile = async (options) => {
      if (options.path !== path) throw new Error("Filesystem received the wrong absolute path");
      return { data: png };
    };
    const image = document.createElement("img");
    const handled = await window.loadAndroidLocalImage(image, path);
    return {
      handled,
      naturalWidth: image.naturalWidth,
      state: image.dataset.localImageState,
      calls: window.__fsCalls.readFile,
      src: image.src,
    };
  }, { png: pngGreen });
  assert.equal(cached.handled, true);
  assert.equal(cached.naturalWidth, 1, "Filesystem.readFile fallback must decode the cached PNG");
  assert.equal(cached.state, "loaded");
  assert.deepEqual(cached.calls, [{ path: "file:///data/user/0/com.mori.downloader/cache/Mori/PlannerSync/preview.png" }]);
  assert.ok(cached.src.startsWith("data:image/png;base64,"));

  const content = await page.evaluate(async () => {
    const image = document.createElement("img");
    const handled = await window.loadAndroidLocalImage(image, "content://media/external/images/media/42");
    return { handled, naturalWidth: image.naturalWidth, state: image.dataset.localImageState, src: image.src };
  });
  assert.equal(content.handled, true);
  assert.equal(content.naturalWidth, 1, "content:// converted route must decode the synthetic PNG");
  assert.equal(content.state, "loaded");
  assert.ok(content.src.includes("/_capacitor_content_/"));

  const alternatePath = await page.evaluate(async () => {
    window.__fsCalls.getUri = [];
    window.__fsCalls.readFile = [];
    window.__fsHandlers.readFile = async () => { throw new Error("first URI is missing"); };
    const image = document.createElement("img");
    const handled = await window.loadAndroidLocalImage(image, {
      uri: "file:///storage/emulated/0/missing-first.png",
      path: "content://media/external/images/media/43",
    });
    return {
      handled,
      naturalWidth: image.naturalWidth,
      state: image.dataset.localImageState,
      readFile: window.__fsCalls.readFile,
      src: image.src,
    };
  });
  assert.equal(alternatePath.handled, true);
  assert.equal(alternatePath.naturalWidth, 1, "a bad uri must not prevent trying the alternate path");
  assert.equal(alternatePath.state, "loaded");
  assert.deepEqual(alternatePath.readFile, [{ path: "file:///storage/emulated/0/missing-first.png" }]);
  assert.ok(alternatePath.src.includes("/_capacitor_content_/"));

  const encodedAbsolutePath = await page.evaluate(async () => {
    const rawPath = "/storage/emulated/0/Mori/猫 #1%20?.png";
    const image = document.createElement("img");
    const handled = await window.loadAndroidLocalImage(image, rawPath);
    return { handled, naturalWidth: image.naturalWidth, state: image.dataset.localImageState, src: image.src };
  });
  assert.equal(encodedAbsolutePath.handled, true);
  assert.equal(encodedAbsolutePath.naturalWidth, 1);
  assert.equal(encodedAbsolutePath.state, "loaded");
  assert.ok(encodedAbsolutePath.src.includes("%E7%8C%AB%20%231%2520%3F.png"));

  const finalFallback = await page.evaluate(async ({ fallback }) => {
    window.__fsHandlers.readFile = async () => { throw new Error("synthetic unreadable file"); };
    const image = document.createElement("img");
    const handled = await window.loadAndroidLocalImage(
      image,
      "file:///data/user/0/com.mori.downloader/cache/unavailable/preview.png",
      fallback,
    );
    return { handled, naturalWidth: image.naturalWidth, state: image.dataset.localImageState, src: image.src };
  }, { fallback: fallbackDataUrl });
  assert.equal(finalFallback.handled, true);
  assert.equal(finalFallback.state, "unavailable", "fallback does not mark the missing original as loaded");
  assert.equal(finalFallback.src, fallbackDataUrl);
  assert.equal(finalFallback.naturalWidth, 1, "fallback must be a decoded synthetic PNG");

  const stale = await page.evaluate(async ({ png }) => {
    let releaseRead;
    let readStarted = false;
    window.__fsHandlers.readFile = async () => {
      readStarted = true;
      return new Promise((resolve) => { releaseRead = resolve; });
    };
    const image = document.createElement("img");
    const oldLoad = window.loadAndroidLocalImage(
      image,
      "file:///data/user/0/com.mori.downloader/cache/Mori/PlannerSync/stale.png",
    );
    for (let tries = 0; !readStarted && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!readStarted) throw new Error("old image read did not reach deferred filesystem call");
    const newLoad = window.loadAndroidLocalImage(image, "content://media/external/images/media/99");
    await newLoad;
    const newSrc = image.src;
    releaseRead({ data: png });
    await oldLoad;
    return {
      naturalWidth: image.naturalWidth,
      state: image.dataset.localImageState,
      src: image.src,
      newSrc,
    };
  }, { png: pngRed });
  assert.equal(stale.naturalWidth, 1);
  assert.equal(stale.src, stale.newSrc, "a late old read must not overwrite the newer source");
  assert.equal(stale.state, "loaded", "a stale request must not overwrite the newer load state");
  assert.ok(stale.src.includes("/_capacitor_content_/"));

  const desktop = await page.evaluate(() => {
    window.__moriPlatform = "web";
    const image = document.createElement("img");
    const beforeSrc = image.getAttribute("src");
    const beforeCalls = JSON.stringify(window.__fsCalls);
    return window.loadAndroidLocalImage(image, "Download/Mori/no-touch.png").then((handled) => ({
      handled,
      beforeSrc,
      afterSrc: image.getAttribute("src"),
      beforeCalls,
      afterCalls: JSON.stringify(window.__fsCalls),
    }));
  });
  assert.equal(desktop.handled, false, "desktop/web should keep the existing non-Android loader");
  assert.equal(desktop.afterSrc, desktop.beforeSrc);
  assert.equal(desktop.afterCalls, desktop.beforeCalls, "desktop must not call Android Filesystem");

  process.stdout.write("Android local image browser checks passed (8 cases; real synthetic PNG decode verified).\n");
  await context.close();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
}
