import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "public", "js", "sync", "assetCatalog.js");

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

const server = createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
      <meta charset="utf-8"><title>Asset compression verification</title>
      <script type="module">
        import * as assetCatalog from "/assetCatalog.js";
        window.assetCatalog = assetCatalog;
        document.title = "READY";
      </script>`);
    return;
  }
  if (request.url === "/assetCatalog.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(await readFile(catalogPath));
    return;
  }
  response.writeHead(404).end("Not found");
});

let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => window.assetCatalog?.preparePlannerImageAsset);

  const result = await page.evaluate(async () => {
    const {
      detectImageType,
      plannerAssetFromPackageEntry,
      plannerAssetNeedsDisplayRebuild,
      preparePlannerImageAsset,
    } = window.assetCatalog;
    const encoder = { algorithm: "canvas-reference-v1", maxSide: 2048, quality: 0.88 };

    async function makePng(width, height, transparentLeft = false) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: true });
      const pixels = ctx.createImageData(width, height);
      let seed = 0x12345678;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const index = (y * width + x) * 4;
          pixels.data[index] = seed & 0xff;
          pixels.data[index + 1] = (seed >>> 8) & 0xff;
          pixels.data[index + 2] = (seed >>> 16) & 0xff;
          pixels.data[index + 3] = transparentLeft && x < width / 2 ? 0 : 255;
        }
      }
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error("Browser PNG encoder returned no data");
      return new Uint8Array(await blob.arrayBuffer());
    }

    async function encode(bytes, inputMime, outputMime, quality) {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: inputMime }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { alpha: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputMime, quality));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob || blob.type !== outputMime) throw new Error(`Browser ${outputMime} encoder is unavailable`);
      return new Uint8Array(await blob.arrayBuffer());
    }

    function sameBytes(left, right) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return false;
      }
      return true;
    }

    async function inspectDisplay(prepared) {
      const bitmap = await createImageBitmap(new Blob([prepared.displayBytes], { type: prepared.asset.display.mime }));
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    }

    async function inspectPixel(prepared, x, y) {
      const bitmap = await createImageBitmap(new Blob([prepared.displayBytes], { type: prepared.asset.display.mime }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixel = [...ctx.getImageData(x, y, 1, 1).data];
      canvas.width = 0;
      canvas.height = 0;
      return pixel;
    }

    const smallPng = await makePng(320, 240);
    const small = await preparePlannerImageAsset(smallPng, { mime: "image/png", filename: "small.png" });
    const oldSmall = await preparePlannerImageAsset(smallPng, {
      mime: "image/png",
      filename: "small.png",
      legacyDisplay: true,
    });
    const smallDimensions = await inspectDisplay(small);
    if (small.asset.display.mime !== "image/jpeg" || small.asset.display.ext !== "jpg") {
      throw new Error("Small raster image was not converted to JPEG");
    }
    if (small.displayBytes.length >= smallPng.length) throw new Error("Small JPEG display output did not shrink");
    if (!sameBytes(oldSmall.displayBytes, smallPng)) throw new Error("Legacy small-image encoding changed source bytes");
    if (!sameBytes(small.sourceBytes, smallPng)) throw new Error("The source image bytes were changed");
    if (oldSmall.asset.display.encoding) throw new Error("Legacy metadata unexpectedly has a new encoding marker");
    if (small.asset.id !== oldSmall.asset.id) throw new Error("Source asset identity changed with display encoding");
    if (JSON.stringify(small.asset.display.encoding) !== JSON.stringify(encoder)) {
      throw new Error("New display metadata is missing the reference encoder parameters");
    }
    if (plannerAssetNeedsDisplayRebuild(small.asset)) throw new Error("Current display metadata was incorrectly marked for rebuild");
    if (!plannerAssetNeedsDisplayRebuild(oldSmall.asset)) throw new Error("Legacy display metadata was not marked for rebuild");
    if (smallDimensions.width !== 320 || smallDimensions.height !== 240) {
      throw new Error("Small JPEG did not decode at the source dimensions");
    }

    const largePng = await makePng(2400, 1200);
    const large = await preparePlannerImageAsset(largePng, { mime: "image/png", filename: "large.png" });
    const oldLarge = await preparePlannerImageAsset(largePng, {
      mime: "image/png",
      filename: "large.png",
      legacyDisplay: true,
    });
    const largeDimensions = await inspectDisplay(large);
    const oldLargeDimensions = await inspectDisplay(oldLarge);
    if (large.asset.display.mime !== "image/jpeg" || !large.asset.display.transformed) {
      throw new Error("Large raster image was not converted to JPEG");
    }
    if (largeDimensions.width !== 2048 || largeDimensions.height !== 1024) {
      throw new Error("Large image was not scaled to the 2048-pixel maximum side");
    }
    if (oldLarge.asset.display.mime !== "image/webp" || oldLargeDimensions.width !== 2048 || oldLargeDimensions.height !== 1024) {
      throw new Error("Legacy large-image WebP behavior changed");
    }
    const repeatedLegacyLarge = await preparePlannerImageAsset(largePng, {
      mime: "image/png",
      filename: "large.png",
      legacyDisplay: true,
    });
    if (!sameBytes(oldLarge.displayBytes, repeatedLegacyLarge.displayBytes)) {
      throw new Error("Legacy large-image bytes changed between retries");
    }

    const alphaPng = await makePng(192, 128, true);
    const alpha = await preparePlannerImageAsset(alphaPng, { mime: "image/png", filename: "alpha.png" });
    if (alpha.asset.display.mime !== "image/jpeg" || alpha.displayBytes.length >= alphaPng.length) {
      throw new Error("Transparent raster image did not produce a smaller JPEG");
    }
    const clearPixel = await inspectPixel(alpha, 10, 10);
    const opaquePixel = await inspectPixel(alpha, 150, 10);
    if (clearPixel[0] < 245 || clearPixel[1] < 245 || clearPixel[2] < 245 || clearPixel[3] !== 255) {
      throw new Error(`Transparent pixels were not flattened to white (${clearPixel.join(",")})`);
    }
    if (opaquePixel[3] !== 255) throw new Error("JPEG display unexpectedly retained transparency");

    const lowQualityJpeg = await encode(smallPng, "image/png", "image/jpeg", 0.02);
    const jpegNoExpansion = await preparePlannerImageAsset(lowQualityJpeg, { mime: "image/jpeg", filename: "small.jpg" });
    if (!sameBytes(jpegNoExpansion.displayBytes, lowQualityJpeg) || jpegNoExpansion.asset.display.transformed) {
      throw new Error("A larger JPEG candidate replaced the smaller JPEG source");
    }
    if (jpegNoExpansion.asset.display.mime !== "image/jpeg") throw new Error("JPEG source did not remain JPEG on no-expansion fallback");

    const staticWebpBytes = await encode(smallPng, "image/png", "image/webp", 0.96);
    const staticWebp = await preparePlannerImageAsset(staticWebpBytes, { mime: "image/webp", filename: "small.webp" });
    if (staticWebp.asset.display.mime !== "image/jpeg" || staticWebp.asset.display.ext !== "jpg") {
      throw new Error("Static WebP source was not converted to JPEG");
    }
    const webpDimensions = await inspectDisplay(staticWebp);
    if (webpDimensions.width !== 320 || webpDimensions.height !== 240) {
      throw new Error("Static WebP JPEG output did not decode at source dimensions");
    }

    const animatedGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0x00, 0x00,
      0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, 0x00, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x01, 0x0a, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00,
      0x3b,
    ]);
    const gif = await preparePlannerImageAsset(animatedGif, { mime: "image/gif", filename: "animated.gif" });
    if (gif.asset.display.mime !== "image/jpeg" || gif.asset.display.ext !== "jpg" || !gif.asset.display.transformed) {
      throw new Error("Animated GIF first frame was not converted to JPEG");
    }
    const gifDimensions = await inspectDisplay(gif);
    if (gifDimensions.width !== 1 || gifDimensions.height !== 1) throw new Error("GIF JPEG first-frame dimensions changed");
    const gifFirstFramePixel = await inspectPixel(gif, 0, 0);
    if (gifFirstFramePixel[0] < 245 || gifFirstFramePixel[1] < 245 || gifFirstFramePixel[2] < 245) {
      throw new Error(`Animated GIF first frame or white transparency background was not preserved (${gifFirstFramePixel.join(",")})`);
    }
    const legacyGif = await preparePlannerImageAsset(animatedGif, { mime: "image/gif", legacyDisplay: true });
    if (!sameBytes(legacyGif.displayBytes, animatedGif) || legacyGif.asset.display.mime !== "image/gif") {
      throw new Error("Legacy animated GIF bytes changed");
    }

    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
    const svg = await preparePlannerImageAsset(svgBytes, { mime: "image/svg+xml", filename: "icon.svg" });
    if (svg.asset.display.mime !== "image/jpeg" || svg.asset.display.ext !== "jpg") {
      throw new Error("Decodable SVG was not converted to JPEG");
    }

    const fakeAnimatedPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4c,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const fakeAnimatedWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x1c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x41, 0x4e, 0x4d, 0x46, 0x10, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    if (detectImageType(fakeAnimatedPng)?.ext !== "png" || detectImageType(fakeAnimatedWebp)?.ext !== "webp") {
      throw new Error("APNG/WebP container headers were not recognized");
    }
    const realCreateImageBitmap = window.createImageBitmap;
    const realDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    window.createImageBitmap = async () => ({ width: 32, height: 24, close() {} });
    CanvasRenderingContext2D.prototype.drawImage = function () {};
    let syntheticContainerConversions;
    try {
      const apng = await preparePlannerImageAsset(fakeAnimatedPng, { mime: "image/png", filename: "animated.png" });
      const webp = await preparePlannerImageAsset(fakeAnimatedWebp, { mime: "image/webp", filename: "animated.webp" });
      syntheticContainerConversions = [apng, webp].map((asset) => ({
        mime: asset.asset.display.mime,
        ext: asset.asset.display.ext,
        dimensions: [asset.asset.display.width, asset.asset.display.height],
      }));
      if (syntheticContainerConversions.some((item) => item.mime !== "image/jpeg" || item.ext !== "jpg")) {
        throw new Error("Synthetic APNG/WebP container did not use the generic JPEG path");
      }
    } finally {
      window.createImageBitmap = realCreateImageBitmap;
      CanvasRenderingContext2D.prototype.drawImage = realDrawImage;
    }

    const packaged = await plannerAssetFromPackageEntry(small.asset, small.displayBytes);
    if (JSON.stringify(packaged.display.encoding) !== JSON.stringify(encoder)) {
      throw new Error("Package asset conversion dropped the display encoder metadata");
    }
    if (packaged.id !== small.asset.id || packaged.display.hash !== small.asset.display.hash) {
      throw new Error("Package asset conversion changed source or display identity");
    }

    return {
      small: { inputBytes: smallPng.length, outputBytes: small.displayBytes.length, dimensions: smallDimensions },
      large: { inputBytes: largePng.length, outputBytes: large.displayBytes.length, dimensions: largeDimensions },
      legacyLarge: { outputBytes: oldLarge.displayBytes.length, mime: oldLarge.asset.display.mime, dimensions: oldLargeDimensions },
      transparent: { inputBytes: alphaPng.length, outputBytes: alpha.displayBytes.length, clearPixel, opaquePixel },
      noExpansionJpeg: { inputBytes: lowQualityJpeg.length, outputBytes: jpegNoExpansion.displayBytes.length },
      staticWebp: { inputBytes: staticWebpBytes.length, outputBytes: staticWebp.displayBytes.length, dimensions: webpDimensions },
      animatedGif: { inputBytes: animatedGif.length, outputBytes: gif.displayBytes.length, dimensions: gifDimensions, firstFramePixel: gifFirstFramePixel },
      svg: { inputBytes: svgBytes.length, outputBytes: svg.displayBytes.length, mime: svg.asset.display.mime },
      syntheticContainerConversions,
      legacySmallPreserved: sameBytes(oldSmall.displayBytes, smallPng),
      legacyGifPreserved: sameBytes(legacyGif.displayBytes, animatedGif),
      encoding: small.asset.display.encoding,
    };
  });

  assert.deepEqual(pageErrors, [], "production asset catalog should not raise browser errors");
  assert.deepEqual(result.small.dimensions, { width: 320, height: 240 });
  assert.deepEqual(result.large.dimensions, { width: 2048, height: 1024 });
  assert.equal(result.legacySmallPreserved, true);
  assert.equal(result.legacyGifPreserved, true);
  process.stdout.write(`PASS: production JPEG encode/decode, first-frame GIF, legacy compatibility, white alpha flattening, and package identity\n${JSON.stringify(result)}\n`);
  process.stdout.write("Synthetic APNG/WebP container conversions used a stub bitmap; this checks the generic encode path, not animation decoder playback.\n");
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
