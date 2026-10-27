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
    localStorage.setItem("mori_ai_language", "zh-Hant");
    window.__aiCalls = [];
    window.__aiProgressCalls = [];
    window.Capacitor = {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      convertFileSrc: uri => uri,
      Plugins: {
        Filesystem: {
          readFile: async () => {
            throw new Error("data URLs do not use Filesystem");
          },
        },
      },
    };
    window.MoriMainBridge = {
      aiCredentialAvailable: () => true,
      aiAnalysisProgressUpdate: payload => {
        window.__aiProgressCalls.push(JSON.parse(payload));
        return true;
      },
      aiCredentialStore: (value, origin) => {
        window.__storedAiKey = value;
        window.__storedAiOrigin = origin;
        return true;
      },
      aiEndpointAuthorize: origin => {
        window.__storedAiOrigin = origin;
        return true;
      },
      aiCredentialClear: () => true,
      aiRequestAsync: (optionsJson, reqId) => {
        const options = JSON.parse(optionsJson);
        window.__aiCalls.push(options);
        if (options.prompt.includes("Connection test")) {
          const response = JSON.stringify({
            status: 200,
            data: JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
          });
          setTimeout(() => window.__moriAiCallbacks?.[reqId]?.(response), Number(window.__qaAiResponseDelay) || 0);
          return;
        }
        const index = window.__aiCalls.length;
        const pose = index % 2 === 1 ? "standing" : "sitting";
        const shotType = index % 2 === 1 ? "full_body" : "half_body";
        const content = JSON.stringify({
          title: `參考圖 ${index}`,
          summary: "可用于复现这张照片的姿势与光线。",
          pose,
          shotType,
          tags: ["視覺", "參考"],
          confidence: 0.92,
          camera: {
            focalLength: "35-50mm",
            aperture: "f/2.8",
            shutter: "1/250s",
            iso: "ISO 100-400",
            angle: "Eye level",
            lighting: "Soft side light",
          },
          composition: "保持人物视线方向留白。",
          poseAdvice: "肩部放松，重心放在后腿。",
          retouch: "降低高光，保留自然肤色。",
          suggestions: ["移动半步避免背景线条穿过头部。"],
        });
        const response = JSON.stringify({
          status: 200,
          data: JSON.stringify({ choices: [{ message: { content } }] }),
        });
        setTimeout(() => window.__moriAiCallbacks?.[reqId]?.(response), Number(window.__qaAiResponseDelay) || 0);
      },
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async () => {
    function imageData(color) {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#fff";
      context.fillRect(24, 28, 48, 72);
      return canvas.toDataURL("image/jpeg", 0.9);
    }
    const first = imageData("#7a4b35");
    const second = imageData("#245a70");
    const now = Date.now();
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "source", name: "來源相冊" }]));
    localStorage.setItem("mori_history", JSON.stringify([
      { title: "人物來源", sourceUrl: "https://example.test/portrait", timestamp: now, localFiles: [{ path: first, type: "IMAGE", savedAt: now }] },
      { title: "建築來源", sourceUrl: "https://example.test/city", timestamp: now + 1, localFiles: [{ path: second, type: "IMAGE", savedAt: now + 1 }] },
    ]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({
      "https://example.test/portrait": ["source"],
      "https://example.test/city": ["source"],
    }));
    document.getElementById("homePage").classList.add("hidden");
    document.getElementById("inspirationPage").classList.remove("hidden");
    document.documentElement.classList.add("is-android");
    const inspiration = await import("/js/modules/inspiration.js");
    inspiration.initInspiration();
    inspiration.renderInspiration();
    const { initAiOrganizer, runAiAlbumOrganization } = await import("/js/modules/aiOrganizer.js");
    initAiOrganizer();
    window.runAiAlbumOrganization = runAiAlbumOrganization;
  });

  await page.evaluate(() => [...document.querySelectorAll(".inspiration-album-tab")]
    .find(button => button.textContent === "來源相冊")?.click());
  if (process.env.MORI_QA_DIR) await page.evaluate(() => { window.__qaAiResponseDelay = 350; });
  await page.evaluate(() => { window.runAiAlbumOrganization(); });
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.waitForFunction(() =>
      document.querySelector("#aiAnalysisIsland")?.innerText.includes("1/2"));
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "ai-progress-running.png"), fullPage: false });
  }
  await page.waitForFunction(() => document.getElementById("aiResultOverlay"));
  assert.equal(await page.locator("#aiAnalysisIsland").isVisible(), true);
  assert.match(await page.locator("#aiAnalysisIsland").innerText(), /已完成 2\/2 张图片/);
  const progressCalls = await page.evaluate(() => window.__aiProgressCalls);
  assert.equal(progressCalls[0].action, "start");
  assert.equal(progressCalls[0].total, 2);
  assert.ok(progressCalls.some(call =>
    call.action === "update" && call.current === 1 && call.total === 2 && /1\/2/.test(call.text)));
  assert.ok(progressCalls.some(call =>
    call.action === "finish" && call.state === "complete" && call.current === 2));
  assert.equal(await page.locator(".ai-result-card").count(), 2);
  const resultText = await page.locator("#aiResultOverlay").innerText();
  assert.match(resultText, /建议拍摄参数/);
  assert.match(resultText, /站姿/);
  assert.match(resultText, /坐姿/);
  assert.match(resultText, /35-50mm/);
  assert.match(resultText, /原始 EXIF/);
  assert.equal((await page.evaluate(() => window.__aiCalls.length)), 2);
  assert.match(await page.evaluate(() => window.__aiCalls[0].prompt), /Traditional Chinese/);
  assert.match(await page.evaluate(() => window.__aiCalls[0].prompt), /pose MUST be one of/);
  assert.ok((await page.evaluate(() => window.__aiCalls[0].imageDataUrls[0].length)) > 100);
  if (process.env.MORI_QA_DIR) {
    mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "ai-pose-results.png"), fullPage: false });
  }
  await page.locator(".ai-results-apply").click();
  await page.waitForFunction(() => !document.getElementById("aiResultOverlay"));

  const stored = await page.evaluate(() => ({
    albums: JSON.parse(localStorage.getItem("mori_inspiration_albums") || "[]"),
    assignments: JSON.parse(localStorage.getItem("mori_inspiration_link_albums") || "{}"),
  }));
  assert.deepEqual(stored.albums.map(album => album.name), ["來源相冊"]);
  assert.deepEqual(Object.keys(stored.assignments).sort(), [
    "https://example.test/city",
    "https://example.test/portrait",
  ]);
  const categoryButtons = page.locator("#albumMobileAiCategories button");
  await page.waitForFunction(() => document.querySelectorAll("#albumMobileAiCategories button").length === 3);
  assert.equal(await categoryButtons.count(), 3);
  if (process.env.MORI_QA_DIR) {
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "ai-in-album-categories.png"), fullPage: false });
  }
  await categoryButtons.filter({ hasText: "站姿" }).click();
  assert.equal(await page.locator(".inspiration-lane").count(), 1);

  await page.locator(".inspiration-card").first().tap();
  assert.equal(await page.locator("#albumPreviewAiToggle").isVisible(), true);
  await page.locator("#albumPreviewAiToggle").click();
  assert.equal(await page.locator("#albumPreviewAiSheet").isVisible(), true);
  assert.match(await page.locator("#albumPreviewAiSheet").innerText(), /建议拍摄参数/);
  if (process.env.MORI_QA_DIR) {
    await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "ai-preview-vertical-analysis.png"), fullPage: false });
  }
  await page.evaluate(() => {
    const body = document.querySelector(".album-preview-ai-sheet-body");
    const point = (clientY) => new Touch({
      identifier: 11, target: body, clientX: 180, clientY, screenX: 180, screenY: clientY,
      pageX: 180, pageY: clientY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
    });
    const dispatch = (type, touches) => body.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    }));
    dispatch("touchstart", [point(400)]);
    dispatch("touchend", [point(520)]);
  });
  assert.equal(await page.locator("#albumPreviewAiSheet").isVisible(), true, "swiping inside analysis content must not close the sheet");
  await page.evaluate(() => {
    const handle = document.querySelector(".album-preview-ai-sheet-handle");
    const point = (clientY) => new Touch({
      identifier: 12, target: handle, clientX: 180, clientY, screenX: 180, screenY: clientY,
      pageX: 180, pageY: clientY, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1,
    });
    const dispatch = (type, touches) => handle.dispatchEvent(new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    }));
    dispatch("touchstart", [point(300)]);
    dispatch("touchmove", [point(390)]);
    dispatch("touchend", []);
  });
  assert.equal(await page.locator("#albumPreviewAiSheet").isVisible(), false, "dragging the white handle down must close the sheet");
  await page.locator("#albumMobilePreview .album-preview-close").click();
  await page.locator("#albumMobileAiCategories button").filter({ hasText: "全部姿势" }).click();

  await page.evaluate(() => [...document.querySelectorAll(".inspiration-album-tab")]
    .find(button => button.textContent === "來源相冊")?.click());
  await page.evaluate(() => { window.runAiAlbumOrganization(); });
  await page.waitForFunction(() => document.getElementById("aiResultOverlay"));
  assert.equal(await page.evaluate(() => window.__aiCalls.length), 2, "cached analysis must not send duplicate AI requests");
  await page.locator(".ai-results-cancel").click();

  await page.evaluate(async () => {
    const { initAiSettings } = await import("/js/modules/settings/ai.js");
    initAiSettings();
  });
  await page.evaluate(() => {
    document.getElementById("aiModelInput").value = "vision-test";
    document.getElementById("aiOutputLanguageSelect").value = "zh-Hant";
    document.getElementById("aiApiKeyInput").value = "sk-test-connection-key";
    document.getElementById("aiSettingsSaveBtn").click();
  });
  await page.waitForFunction(() => document.querySelector("#aiCredentialStatus").dataset.state === "ready");
  assert.equal(await page.evaluate(() => window.__storedAiKey), "sk-test-connection-key");
  assert.equal(await page.evaluate(() => window.__storedAiOrigin), "https://api.example.test/v1");
  assert.equal(await page.evaluate(() => document.getElementById("aiApiKeyInput").value), "");
  await page.waitForFunction(() => document.getElementById("aiSettingsTestBtn").disabled === false);
  await page.evaluate(() => document.getElementById("aiSettingsTestBtn").click());
  await page.waitForFunction(() => document.querySelector("#aiCredentialStatus").textContent.includes("连接成功"));
  assert.equal(await page.evaluate(() => window.__aiCalls.at(-1).imageDataUrls.length), 0);
  assert.equal(await page.locator('[data-value="zh-Hant"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: AI pose taxonomy, camera suggestions, detailed result feedback, in-album pose filters, per-image swipe-up analysis, live image progress, cache, Keystore settings and connection test");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
