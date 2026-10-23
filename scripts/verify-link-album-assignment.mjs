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

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.continue();
  });
  await context.addInitScript(() => {
    localStorage.setItem("mori_lang", "zh");
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "flower", name: "花海拍摄" }]));
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async () => {
    const { renderResult } = await import("/js/ui/result.js");
    renderResult({
      title: "花海参考",
      sourceUrl: "https://example.test/flower-link",
      thumbnail: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      downloads: [{
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
        type: "IMAGE",
      }],
    }, "https://example.test/flower-link");
  });

  assert.equal(await page.locator(".result-album-assignment").count(), 1);
  await page.locator(".result-album-assignment select").selectOption("flower");
  await page.locator(".result-album-assignment button").click();
  let assignments = await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_link_albums") || "{}"));
  assert.deepEqual(assignments["https://example.test/flower-link"], ["flower"]);
  assert.match(await page.locator(".result-album-assignment-status").innerText(), /花海拍摄/);

  await page.locator(".result-album-assignment select").selectOption("__new");
  await page.locator(".result-album-assignment button").click();
  await page.locator("#resultAlbumNameInput").fill("海边人像");
  await page.locator("#okConfirmBtn").click();
  const stored = await page.evaluate(() => ({
    albums: JSON.parse(localStorage.getItem("mori_inspiration_albums") || "[]"),
    assignments: JSON.parse(localStorage.getItem("mori_inspiration_link_albums") || "{}"),
  }));
  const newAlbum = stored.albums.find(album => album.name === "海边人像");
  assert.ok(newAlbum);
  assert.deepEqual(stored.assignments["https://example.test/flower-link"], ["flower", newAlbum.id]);
  console.log("PASS: extracted-link manual album assignment, existing-album reuse and new-album creation");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
