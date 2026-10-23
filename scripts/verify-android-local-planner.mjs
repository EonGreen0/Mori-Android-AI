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
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    const now = Date.now();
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "flower", name: "花海拍摄" }]));
    localStorage.setItem("mori_history", JSON.stringify([{
      title: "花海参考",
      sourceUrl: "https://example.test/flower",
      timestamp: now,
      localFiles: [{ path: image, uri: image, type: "IMAGE", title: "花海", savedAt: now }],
    }]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({
      "https://example.test/flower": ["flower"],
    }));
    localStorage.setItem("mori_ai_base_url", "https://api.example.test/v1");
    localStorage.setItem("mori_ai_model", "vision-test");
    localStorage.setItem("mori_ai_language", "zh-Hans");
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: uri => uri,
      Plugins: { Filesystem: {} },
    };
    window.MoriMainBridge = {
      aiCredentialAvailable: () => true,
      aiRequestAsync: (json, reqId) => {
        const options = JSON.parse(json);
        const content = JSON.stringify({
          title: "花海站姿参考",
          summary: "适合作为站姿构参考。",
          pose: "standing",
          shotType: "full_body",
          confidence: 0.9,
          tags: ["花海", "站姿"],
          camera: {
            focalLength: "35-50mm",
            aperture: "f/2.8",
            shutter: "1/250s",
            iso: "ISO 100-400",
            angle: "Eye level",
            lighting: "Soft daylight",
          },
          composition: "人物放在三分线。",
          poseAdvice: "重心放在后腿。",
          retouch: "降低高光。",
          suggestions: ["保留花海环境层次。"],
        });
        const response = JSON.stringify({
          status: 200,
          data: JSON.stringify({ choices: [{ message: { content } }] }),
        });
        window.__plannerAiCalls = window.__plannerAiCalls || [];
        window.__plannerAiCalls.push(options);
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
    const planner = await import("/js/modules/planner.js");
    planner.initPlanner();
    const { initAiPlanner } = await import("/js/modules/aiPlanner.js");
    initAiPlanner();
    window.switchPlannerMode = planner.switchPlannerMode;
  });
  await page.evaluate(() => [...document.querySelectorAll(".inspiration-album-tab")]
    .find(button => button.textContent === "花海拍摄")?.click());
  await page.evaluate(() => window.switchPlannerMode("planner"));
  await page.waitForFunction(() => document.documentElement.classList.contains("planner-android-fullscreen"));
  assert.equal(await page.locator("#inspirationPage").evaluate(element => element.classList.contains("planner-readonly")), false);
  assert.ok((await page.locator(".planner-node").count()) >= 1);
  assert.equal(await page.locator("#plannerMobileAddTextBtn").isVisible(), true);
  assert.equal(await page.locator("#plannerMobileAddGroupBtn").isVisible(), true);
  assert.equal(await page.locator("#plannerMobileClearBtn").isVisible(), true);
  const zoomBefore = Number((await page.locator("#plannerMobileZoomLabel").innerText()).replace("%", ""));
  await page.locator("#plannerMobileZoomInBtn").click();
  const zoomAfter = Number((await page.locator("#plannerMobileZoomLabel").innerText()).replace("%", ""));
  assert.ok(zoomAfter > zoomBefore);
  await page.locator("#plannerMobileZoomLabel").click();
  await page.evaluate(() => {
    const viewport = document.getElementById("plannerViewport");
    const point = (identifier, clientX, clientY) => new Touch({
      identifier, target: viewport, clientX, clientY, screenX: clientX, screenY: clientY,
      pageX: clientX, pageY: clientY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
    });
    const dispatch = (type, touches) => viewport.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    }));
    const first = point(1, 120, 300);
    const second = point(2, 220, 300);
    dispatch("touchstart", [first, second]);
    dispatch("touchmove", [point(1, 60, 300), point(2, 280, 300)]);
    dispatch("touchend", []);
  });
  const pinchZoom = Number((await page.locator("#plannerMobileZoomLabel").innerText()).replace("%", ""));
  assert.ok(pinchZoom > 100, "two-finger pinch must zoom editable mobile plans");
  const before = await page.locator(".planner-node").count();
  await page.locator("#plannerMobileAddTextBtn").tap();
  await page.locator(".planner-text-content").last().press("Control+Enter");
  assert.ok((await page.locator(".planner-node").count()) > before);
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "android-local-plan.png"), fullPage: false });
  }
  const boards = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith("mori_planner_board_v2:"))
    .map(key => JSON.parse(localStorage.getItem(key))));
  assert.ok(boards.some(board => board.readOnly === false && board.nodes.some(node => node.type === "text")));
  await page.locator("#plannerMobileAiLayoutBtn").click();
  await page.waitForFunction(() => !document.getElementById("confirmOverlay").classList.contains("hidden"));
  assert.match(await page.locator("#confirmMessage").innerText(), /站姿/);
  await page.locator("#okConfirmBtn").click();
  assert.ok((await page.locator(".planner-node-group").count()) >= 1);
  assert.match(await page.locator(".planner-group-label").first().innerText(), /站姿/);
  assert.equal(await page.evaluate(() => window.__plannerAiCalls.length), 1);
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "android-ai-planner.png"), fullPage: false });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: mobile plan zoom controls, editable local planning, AI image analysis and executable pose-group layout");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
