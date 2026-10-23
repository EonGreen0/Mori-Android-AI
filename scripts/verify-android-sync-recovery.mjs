import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";

const fetchSource = await readFile(new URL("../public/js/sync/androidAuthenticatedFetch.js", import.meta.url), "utf8");
function bridgeTest(replies) {
  const context = vm.createContext({ window: {}, Headers, Response, DOMException, Uint8Array, atob, setTimeout, clearTimeout, console });
  vm.runInContext(fetchSource.replace(/^export /gm, ""), context);
  const calls = [];
  const dispatch = (options, id) => {
    calls.push({ options: JSON.parse(options), id });
    const reply = replies.shift();
    if (reply) queueMicrotask(() => context.window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify(reply)));
  };
  const bridge = { syncReadOnlyRequestAsync: dispatch, syncPlannerWriteRequestAsync: dispatch };
  return { context, calls, read: context.createAndroidReadOnlyAuthenticatedFetch(bridge), write: context.createAndroidPlannerWriteAuthenticatedFetch(bridge) };
}
const closed = () => ({ status: 0, error: "connection closed" });
const ok = () => ({ status: 200, data: "hello", headers: { "content-type": "text/plain" } });
const url = "https://mori-sync-gateway-test.pages.dev/v1/projects?limit=100";
{
  const test = bridgeTest([closed(), closed(), ok()]);
  assert.equal(await (await test.read(url)).text(), "hello");
  assert.equal(test.calls.length, 3); assert.equal(new Set(test.calls.map(call => call.id)).size, 3);
  assert(test.calls.every(call => !Object.hasOwn(call.options.headers, "authorization")));
  assert.equal(Object.keys(test.context.window.__moriSyncReadOnlyCallbacks).length, 0);
}
{
  const test = bridgeTest([closed(), closed(), closed(), ok()]);
  await assert.rejects(test.read(url), /connection closed/); assert.equal(test.calls.length, 3);
  assert.equal(Object.keys(test.context.window.__moriSyncReadOnlyCallbacks).length, 0);
}
for (const reply of [{ status: 401, data: "unauthorized" }, { status: 0, error: "Android sync credential is unavailable" }, { status: 0, error: "Android sync redirect is not allowed" }]) {
  const test = bridgeTest([reply]);
  if (reply.status) assert.equal((await test.read(url)).status, 401);
  else await assert.rejects(test.read(url));
  assert.equal(test.calls.length, 1, "authentication/security failures are not retried");
}
{
  const test = bridgeTest([closed(), ok()]);
  await assert.rejects(test.write(url, { method: "POST", body: "{}" }), /connection closed/);
  assert.equal(test.calls.length, 1, "Planner POST writes are not retried automatically");
  await assert.rejects(test.read(url, { method: "POST" }), /only allows GET/);
  await assert.rejects(test.read(url, { body: "data" }), /cannot have a body/);
  assert.equal(test.calls.length, 1);
}
{
  const test = bridgeTest([]); const controller = new AbortController();
  const pending = test.read(url, { signal: controller.signal }); controller.abort(new Error("cancel read"));
  await assert.rejects(pending, /cancel read/); assert.equal(test.calls.length, 1);
  assert.equal(Object.keys(test.context.window.__moriSyncReadOnlyCallbacks).length, 0);
  await assert.rejects(test.read(url, { signal: controller.signal }), /cancel read/);
  assert.equal(test.calls.length, 1);
}
{
  const test = bridgeTest([closed(), ok()]); const controller = new AbortController();
  const pending = test.read(url, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancel backoff")), 20);
  await assert.rejects(pending, /cancel backoff/); assert.equal(test.calls.length, 1);
}
console.log("PASS: native GET interruption retry limit, callback cleanup, abort, auth/security failures and no POST retry");

// Browser plugin not available. Exercise production controls/module in a fresh
// headless profile with a synthetic native bridge; all real network is blocked.
const executablePath = process.env.MORI_CHROME_PATH || [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)
  .flatMap(root => ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"].map(file => path.join(root, file))).find(existsSync);
assert.ok(executablePath);
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 412, height: 915 } });
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) return route.abort();
    if (requested.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.continue();
  });
  await page.addInitScript(() => {
    window.Capacitor = { getPlatform: () => "android", Plugins: {} };
    window.directoryCalls = []; window.directoryReplies = [];
    window.MoriMainBridge = {
      syncReadOnlyAvailable: () => true, syncPlannerWriteAvailable: () => false,
      syncReadOnlyRequestAsync(options, id) {
        const request = JSON.parse(options); window.directoryCalls.push(request);
        if (request.method !== "GET" || !request.url.includes("/v1/projects?")) throw new Error("Unexpected request");
        const reply = window.directoryReplies.shift() || { status: 0, error: "connection closed" };
        setTimeout(() => window.__moriSyncReadOnlyCallbacks[id]?.(JSON.stringify(reply)), 0);
      },
    };
  });
  const boot = async () => {
    await page.evaluate(async () => {
      document.getElementById("homePage")?.classList.add("hidden");
      document.getElementById("inspirationPage").classList.remove("hidden");
      await (await import("/js/sync/androidPlannerReadOnlySync.js")).initAndroidPlannerSync();
    });
  };
  const replyWith = async (projects) => page.evaluate(projects => window.directoryReplies.push({ status: 200, data: JSON.stringify({ projects }) }), projects);
  const reload = page.locator("#plannerAndroidCloudReloadBtn");
  const select = page.locator("#plannerAndroidCloudProject");
  const status = page.locator("#plannerAndroidCloudStatus");
  await page.goto(origin); await boot();
  assert.match(await page.title(), /Mori/i); assert.equal(await reload.isVisible(), true);
  assert.equal(await reload.isEnabled(), true, "initial connection failure leaves a retry control");
  assert.equal(await page.locator("#plannerAndroidCloudRefreshBtn").isDisabled(), true);
  assert.equal(await select.locator("option").count(), 0);
  assert.equal(await page.evaluate(() => window.directoryCalls.length), 3);
  assert.match(await status.textContent(), /刷新同步列表.*重试/);

  await replyWith([{ projectId: "p1", title: "Reference A", revision: 181 }, { projectId: "p2", title: "Reference B", revision: 4 }]);
  await reload.click(); await page.waitForFunction(() => document.querySelector("#plannerAndroidCloudStatus").dataset.state === "idle");
  assert.equal(await select.locator("option").count(), 2);
  assert.equal(await page.locator("#plannerAndroidCloudRefreshBtn").isEnabled(), true);
  await select.selectOption("p2");
  await reload.click(); await page.waitForFunction(() => document.querySelector("#plannerAndroidCloudStatus").dataset.state === "error");
  assert.equal(await select.inputValue(), "p2"); assert.equal(await select.locator("option").count(), 2);
  assert.match(await status.textContent(), /已保留上次列表/); assert.equal(await reload.isEnabled(), true);

  await replyWith([{ projectId: "p1", title: "Reference A", revision: 181 }, { projectId: "p2", title: "Reference B", revision: 5 }]);
  await reload.click(); await page.waitForFunction(() => document.querySelector("#plannerAndroidCloudStatus").dataset.state === "idle");
  assert.equal(await select.inputValue(), "p2");
  await page.reload(); await boot();
  assert.equal(await select.locator("option").count(), 2, "last successful directory survives restart without a connection");
  assert.equal(await select.inputValue(), "p2"); assert.equal(await reload.isEnabled(), true);
  await page.evaluate(() => window.directoryReplies.push({ status: 200, data: '{"invalid":true}' }));
  await reload.click(); await page.waitForFunction(() => document.querySelector("#plannerAndroidCloudStatus").dataset.state === "error");
  assert.equal(await select.locator("option").count(), 2, "invalid cloud response cannot erase a usable directory");
  await replyWith([]); await reload.click();
  await page.waitForFunction(() => document.querySelector("#plannerAndroidCloudStatus").textContent === "云端暂无策划");
  assert.equal(await select.locator("option").count(), 0, "a successful empty directory remains authoritative");
  assert.equal(await reload.isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log("PASS: production Android cold-start failure/manual retry, preserved directory/selection, offline restart, malformed response and authoritative empty list");
  await context.close();
} finally {
  if (browser) await browser.close();
  server.close(); await once(server, "close");
}
