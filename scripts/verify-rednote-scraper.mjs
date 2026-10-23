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

const noteId = "65abcDEF123";
const finalUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=test-token&xsec_source=pc_share`;
const stateHtml = `<html><head><title>Fixture</title></head><body>
<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"${noteId}":{"note":{
"noteId":"${noteId}","title":"测试小红书作品","desc":"三张参考图","user":{"nickname":"测试作者"},
"imageList":[
{"urlDefault":"http://sns-webpic-qc.xhscdn.com/image-1.jpg"},
{"urlDefault":"https://sns-webpic-qc.xhscdn.com/image-2.jpg","urlPre":"https://sns-webpic-qc.xhscdn.com/image-2-preview.jpg"},
{"urlDefault":"https://sns-webpic-qc.xhscdn.com/image-1.jpg"}],
"video":{"image":{"thumbnailUrl":"https://sns-webpic-qc.xhscdn.com/video-cover.jpg"},
"media":{"stream":{"h264":[{"masterUrl":"http://sns-video-bd.xhscdn.com/video-low.mp4","width":720,"height":1280,"avgBitrate":1000},
{"masterUrl":"https://sns-video-bd.xhscdn.com/video-high.mp4","width":1080,"height":1920,"avgBitrate":2000,
"backupUrls":["https://sns-video-bd.xhscdn.com/video-backup.mp4"]}]}},
"unused":undefined}}}}} };</script></body></html>`;
const graphHtml = `<html><head>
<meta property="og:title" content="OpenGraph 小红书">
<meta property="og:description" content="Fallback metadata">
<meta property="og:image" content="https://sns-webpic-qc.xhscdn.com/og-1.jpg">
<meta property="og:image" content="https://sns-webpic-qc.xhscdn.com/og-2.jpg">
<meta property="og:video" content="http://sns-video-bd.xhscdn.com/og-video.mp4">
</head></html>`;

const server = createDevServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.continue();
  });
  await context.addInitScript(({ stateHtml, graphHtml, finalUrl }) => {
    window.__rednoteRequests = [];
    window.MoriMainBridge = {
      httpRequestAsync: (json, reqId) => {
        const options = JSON.parse(json);
        window.__rednoteRequests.push(options);
        const graph = options.url.includes("og123");
        const result = JSON.stringify({
          status: 200,
          data: graph ? graphHtml : stateHtml,
          url: graph
            ? "https://www.xiaohongshu.com/explore/og123?xsec_token=og-token"
            : finalUrl,
        });
        setTimeout(() => window.__moriNativeCallbacks?.[reqId]?.(result), 0);
      },
      getEngineSecurityKey: () => "UNAUTHORIZED_CLONE",
    };
  }, { stateHtml, graphHtml, finalUrl });

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "load" });
  const stateResult = await page.evaluate(async () => {
    const { scrapeRedNote } = await import("/js/scrapers/index.js");
    return scrapeRedNote("http://xhslink.com/a/test-share");
  });
  assert.equal(stateResult.status, true);
  assert.equal(stateResult.result.title, "测试小红书作品");
  assert.equal(stateResult.result.author, "测试作者");
  assert.equal(stateResult.result.sourceUrl, finalUrl);
  assert.equal(stateResult.result.downloads.filter(item => item.type === "IMAGE").length, 2);
  const video = stateResult.result.downloads.find(item => item.type === "VIDEO");
  assert.equal(video.url, "https://sns-video-bd.xhscdn.com/video-high.mp4");
  assert.ok(video.fallbackUrls.includes("https://sns-video-bd.xhscdn.com/video-low.mp4"));
  assert.ok(video.fallbackUrls.includes("https://sns-video-bd.xhscdn.com/video-backup.mp4"));
  assert.equal(stateResult.result.downloads[0].url.startsWith("https://"), true);

  const graphResult = await page.evaluate(async () => {
    const { scrapeRedNote } = await import("/js/scrapers/index.js");
    return scrapeRedNote("https://www.xiaohongshu.com/explore/og123?xsec_token=og-token");
  });
  assert.equal(graphResult.status, true);
  assert.equal(graphResult.result.title, "OpenGraph 小红书");
  assert.equal(graphResult.result.downloads.filter(item => item.type === "IMAGE").length, 2);
  const graphVideo = graphResult.result.downloads.find(item => item.type === "VIDEO");
  assert.equal(graphVideo.url, "https://sns-video-bd.xhscdn.com/og-video.mp4");
  assert.ok((await page.evaluate(() => window.__rednoteRequests[0].headers["User-Agent"])).includes("Windows"));
  console.log("PASS: RedNote short-link redirect, xsec_token preservation, SSR image/video parsing, backup URLs and OpenGraph fallback");
  await context.close();
} finally {
  await browser.close();
  server.close();
}
