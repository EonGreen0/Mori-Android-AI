import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";

const executablePath = process.env.MORI_CHROME_PATH || [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)
  .flatMap((root) => [path.join(root, "Google/Chrome/Application/chrome.exe"), path.join(root, "Microsoft/Edge/Application/msedge.exe")]).find(existsSync);
assert.ok(executablePath, "local Chrome/Edge is available");
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 340, height: 560 } });
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners = new Map();
    const today = Date.now();
    let items = [{ id: "recent", title: "最近图片", path: "C:/Frames/recent.png", savedAt: today }, { id: "old", title: "旧图片", path: "C:/Frames/old.png", savedAt: today - 86400000 * 3 }];
    let undo = [];
    window.testCalls = [];
    const fire = (event, payload) => queueMicrotask(() => listeners.get(event)?.({ payload }));
    window.__TAURI__ = { event: { listen: async (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); } }, core: { invoke: async (command, args) => {
      window.testCalls.push({ command, args });
      if (command === "tauri_move_frame_floater") return { x: 100, y: 100, scaleFactor: 1 };
      if (command === "tauri_read_file_bytes") {
        const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 6;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "#d17d61"; ctx.fillRect(0, 0, 8, 6);
        return Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (char) => char.charCodeAt(0));
      }
      if (command === "tauri_favorites_request") {
        const request = args.request; let data = {};
        switch (request.action) {
          case "list": data = { items, albums: { activeId: "album-a", items: [{ id: "album-a", name: "相册 A" }, { id: "album-b", name: "相册 B" }] }, planners: { activeId: "planner-a", items: [{ id: "planner-b", name: "策划 B" }] } }; break;
          case "paste": items.unshift({ id: `pasted-${items.length}`, title: "粘贴图片", path: "C:/Frames/pasted.png", savedAt: today }); data = { message: "已加入收藏" }; break;
          case "remove": undo = items.filter((entry) => request.ids.includes(entry.id)); items = items.filter((entry) => !request.ids.includes(entry.id)); data = { message: "原文件保留", undoAvailable: true }; break;
          case "undo": items.push(...undo); undo = []; data = { message: "已恢复收藏" }; break;
          case "insert": data = { message: "已加入1张" }; break;
        }
        fire("mori-favorites-response", { requestId: request.requestId, ok: true, data });
      }
    } } };
  });
  await page.goto(`${origin}/frame-floater.html`);
  await page.locator(".drag").click();
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 2);
  assert.equal(await page.locator(".drag").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(".date-group[open]").count(), 1);
  assert.equal(await page.locator(".date-group[open] summary").textContent(), "今天1 张");
  await page.waitForFunction(() => document.querySelector('img[data-id="recent"]').naturalWidth > 0);
  await page.locator('input[value="recent"]').check();
  await page.locator("#favoriteTarget").selectOption("planner:planner-b");
  await page.locator("#insertFavorites").click();
  await page.waitForFunction(() => document.getElementById("favoritesStatus").textContent === "已加入1张");
  const insert = await page.evaluate(() => window.testCalls.find((call) => call.args?.request?.action === "insert").args.request);
  assert.deepEqual(insert.ids, ["recent"]); assert.equal(insert.targetType, "planner"); assert.equal(insert.targetId, "planner-b");
  await page.locator("#removeFavorites").click();
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 1);
  assert.equal(await page.locator("#undoRemove").isVisible(), true);
  await page.locator("#undoRemove").click();
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 2);
  await page.locator("#pasteImage").click();
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 3);
  await page.evaluate(() => document.dispatchEvent(new Event("paste", { cancelable: true })));
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 4);
  await page.locator("#closePanel").click();
  assert.equal(await page.locator("#favoritesPanel").isVisible(), false);
  await page.locator(".drag").focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".favorite-card").length === 4);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#favoritesPanel").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log("PASS: isolated favorites panel click/keyboard, date folding, selection, target routing, paste, removal/undo and close/reopen");
  await context.close();
} finally {
  if (browser) await browser.close();
  server.close(); await once(server, "close");
}
