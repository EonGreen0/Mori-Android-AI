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
    localStorage.setItem("mori_ai_base_url", "https://api.example.test/v1");
    localStorage.setItem("mori_ai_model", "vision-test");
    localStorage.setItem("mori_ai_language", "zh-Hans");
    const makeImage = color => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#fff";
      context.fillRect(28, 30, 40, 68);
      return canvas.toDataURL("image/png");
    };
    const imageOne = makeImage("#8b634a");
    const imageTwo = makeImage("#487b86");
    const now = Date.now();
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "flower", name: "花海拍摄" }]));
    localStorage.setItem("mori_history", JSON.stringify([{
      title: "花海来源",
      sourceUrl: "https://example.test/flower",
      url: "https://example.test/flower",
      timestamp: now,
      localFiles: [
        { assetId: `sha256:${"a".repeat(64)}`, path: "Mori/Library/Images/flower-1.png", uri: imageOne, type: "IMAGE", storage: "cache", directory: "DATA", savedAt: now },
        { assetId: `sha256:${"b".repeat(64)}`, path: "Mori/Library/Images/flower-2.png", uri: imageTwo, type: "IMAGE", storage: "cache", directory: "DATA", savedAt: now + 1 },
      ],
    }]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({
      "https://example.test/flower": ["flower"],
    }));
    window.__aiCalls = 0;
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: value => value,
      Plugins: {
        Filesystem: {
          async readFile({ path }) { return { data: (path.endsWith("flower-2.png") ? imageTwo : imageOne).split(",")[1] }; },
          async getUri({ path }) { return { uri: `file:///data/user/0/com.mori.downloader/files/${path}` }; },
          async deleteFile() {},
        },
      },
    };
    window.MoriMainBridge = {
      aiCredentialAvailable: () => true,
      aiAnalysisProgressUpdate: () => true,
      aiRequestAsync: (json, reqId) => {
        window.__aiCalls += 1;
        const index = window.__aiCalls;
        const content = JSON.stringify({
          title: `花海参考 ${index}`,
          summary: "用于策划的站姿与光线参考。",
          pose: index === 1 ? "standing" : "sitting",
          shotType: "full_body",
          confidence: 0.91,
          tags: ["花海", "参考"],
          camera: {
            focalLength: "35-50mm",
            aperture: "f/2.8",
            shutter: "1/250s",
            iso: "ISO 100-400",
            angle: "Eye level",
            lighting: "Soft daylight",
          },
          composition: "人物放在三分线，保留花海层次。",
          poseAdvice: "重心放在后腿，肩膀放松。",
          retouch: "降低高光。",
          suggestions: ["保留环境留白。"],
        });
        const response = JSON.stringify({
          status: 200,
          data: JSON.stringify({ choices: [{ message: { content } }] }),
        });
        setTimeout(() => window.__moriAiCallbacks?.[reqId]?.(response), 0);
      },
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
  await page.locator('.album-cover[data-album-id="flower"]').click();
  await page.locator(".inspiration-card").first().tap();
  await page.waitForSelector("#albumMobilePreview:not(.hidden)");
  assert.equal(await page.locator("#albumPreviewAiIdentify").isVisible(), true);
  assert.equal(await page.locator("#albumPreviewSource").isVisible(), true);
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "single-image-footer-actions.png") });
  }

  await page.locator("#albumPreviewAiIdentify").click();
  await page.waitForFunction(() => !document.getElementById("albumPreviewAiSheet").classList.contains("hidden"));
  assert.equal(await page.evaluate(() => window.__aiCalls), 1);
  assert.match(await page.locator(".album-preview-ai-sheet-body").innerText(), /35-50mm/);
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.waitForTimeout(3200);
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "single-image-ai.png") });
  }

  await page.evaluate(() => {
    const handle = document.querySelector(".album-preview-ai-sheet-handle");
    const point = clientY => new Touch({
      identifier: 31, target: handle, clientX: 180, clientY, screenX: 180, screenY: clientY,
      pageX: 180, pageY: clientY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
    });
    const dispatch = (type, touches) => handle.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    }));
    dispatch("touchstart", [point(300)]);
    dispatch("touchmove", [point(390)]);
    dispatch("touchend", []);
  });
  assert.equal(await page.locator("#albumPreviewAiSheet").isVisible(), false);

  await page.evaluate(() => {
    const area = document.querySelector(".album-preview-image");
    const point = clientX => new Touch({
      identifier: 32, target: area, clientX, clientY: 350, screenX: clientX, screenY: 350,
      pageX: clientX, pageY: 350, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
    });
    const dispatch = (type, touches) => area.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    }));
    dispatch("touchstart", [point(310)]);
    dispatch("touchmove", [point(120)]);
    dispatch("touchend", [point(120)]);
  });
  await page.waitForFunction(() => document.getElementById("albumPreviewCount").textContent.trim() === "2 / 2");
  await page.locator("#albumPreviewAiIdentify").click();
  await page.waitForFunction(() => !document.getElementById("albumPreviewAiSheet").classList.contains("hidden"));
  assert.equal(await page.evaluate(() => window.__aiCalls), 2);

  await page.locator(".album-preview-close").click();
  await page.evaluate(async () => {
    const planner = await import("/js/modules/planner.js");
    planner.initPlanner();
    planner.switchPlannerMode("planner");
    const { initAiPlanner } = await import("/js/modules/aiPlanner.js");
    initAiPlanner();
  });
  await page.waitForFunction(() => document.documentElement.classList.contains("planner-android-fullscreen"));
  await page.locator("#plannerMobileAiLayoutBtn").click();
  await page.waitForFunction(() => !document.getElementById("confirmOverlay").classList.contains("hidden"));
  assert.match(await page.locator("#confirmMessage").innerText(), /新分析 0 张/);
  assert.equal(await page.evaluate(() => window.__aiCalls), 2, "planner must reuse single-photo analysis");
  await page.locator("#okConfirmBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".planner-node-group").length >= 2);
  if (process.env.MORI_QA_DIR) {
    await page.waitForTimeout(3400);
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "ai-planner-group-briefs.png") });
  }
  const boardAfterAi = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("mori_planner_board_v2:"))
    .map(([, value]) => JSON.parse(value))
    .find(board => board.nodes.some(node => node.aiGeneratedPlanner)));
  assert.ok(boardAfterAi.nodes.some(node => node.aiSummaryForGroup && /35-50mm/.test(node.text)));

  await page.locator("#plannerMobileClearBtn").click();
  await page.waitForFunction(() => !document.getElementById("confirmOverlay").classList.contains("hidden"));
  await page.locator("#okConfirmBtn").click();
  await page.waitForFunction(() => !document.getElementById("plannerEmpty").classList.contains("hidden"));
  assert.equal(await page.locator("#plannerEmptyAddTextBtn").isVisible(), true);
  assert.equal(await page.locator("#plannerEmptyAddGroupBtn").isVisible(), true);
  assert.equal(await page.locator("#plannerEmptyAddAlbumBtn").isVisible(), true);
  assert.equal(await page.locator("#plannerMobileAddTextBtn").isVisible(), true);
  await page.waitForFunction(() => document.getElementById("plannerMobileControls").scrollLeft === 0);
  if (process.env.MORI_QA_DIR) {
    await page.waitForTimeout(3200);
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "planner-empty-actions.png") });
  }
  await page.locator("#plannerEmptyAddTextBtn").tap();
  await page.waitForFunction(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("mori_planner_board_v2:"))
    .some(([, value]) => JSON.parse(value).nodes.some(node => node.type === "text")));

  await page.locator("#plannerMobileClearBtn").click();
  await page.waitForFunction(() => !document.getElementById("confirmOverlay").classList.contains("hidden"));
  await page.locator("#okConfirmBtn").click();
  await page.locator("#plannerEmptyAddAlbumBtn").tap();
  await page.waitForFunction(() => document.querySelectorAll(".planner-node").length >= 2);

  const deletion = await page.evaluate(async () => {
    const inspiration = await import("/js/modules/inspiration.js");
    const snapshot = inspiration.getInspirationLibrarySnapshot();
    return inspiration.deleteInspirationSource(snapshot.groups[0].key);
  });
  assert.equal(deletion.plannerRemoved.imagesRemoved, 2);
  await page.waitForFunction(() => !document.getElementById("plannerEmpty").classList.contains("hidden"));
  const remainingImages = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("mori_planner_board_v2:"))
    .flatMap(([, value]) => JSON.parse(value).nodes)
    .filter(node => node.type === "image" && node.albumId === "flower").length);
  assert.equal(remainingImages, 0);
  assert.deepEqual(errors, []);
  console.log("PASS: single-photo AI, horizontal gallery swiping, planner cache reuse, group briefs, empty-canvas actions and source-linked planner cleanup");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
