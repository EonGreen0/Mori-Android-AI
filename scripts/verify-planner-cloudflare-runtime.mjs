import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
if (!process.env.MORI_TEST_TOKEN) {
  throw new Error("MORI_TEST_TOKEN must be supplied to run this explicit online test");
}
const { chromium } = require("playwright-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localOrigin = "http://localhost:8765";
const workerOrigin = "https://mori-sync-test.mori-sync-worker.workers.dev";
const browser = await chromium.launch({
  executablePath: process.env.MORI_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(`PAGE ERROR: ${error.message}\n`));
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`BROWSER ERROR: ${message.text()}\n`);
  });
  page.on("requestfailed", (request) => process.stderr.write(`REQUEST FAILED: ${request.url()} ${request.failure()?.errorText}\n`));
  await page.exposeFunction("__moriTestAccessToken", () => process.env.MORI_TEST_TOKEN);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === localOrigin) {
      const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
      const body = await readFile(file);
      return route.fulfill({
        status: 200,
        contentType: file.endsWith(".html") ? "text/html" : "text/javascript",
        body,
      });
    }
    if (url.origin === workerOrigin) {
      const response = await fetch(url, {
        method: request.method(),
        headers: request.headers(),
        body: request.postDataBuffer() || undefined,
      });
      const headers = Object.fromEntries(response.headers);
      delete headers["content-length"];
      delete headers["content-encoding"];
      return route.fulfill({
        status: response.status,
        headers,
        body: Buffer.from(await response.arrayBuffer()),
      });
    }
    return route.abort();
  });

  await page.goto(`${localOrigin}/scripts/planner-sync-cloudflare-runtime.html`);
  try {
    await page.waitForFunction(() => document.title === "PASS" || document.title === "FAIL", null, { timeout: 45000 });
  } catch (error) {
    process.stderr.write(`Browser remained at ${await page.title()} (${page.url()}): ${await page.locator("#result").textContent()}\n`);
    throw error;
  }
  const output = await page.locator("#result").textContent();
  process.stdout.write(output + "\n");
  if ((await page.title()) !== "PASS") process.exitCode = 1;
  await context.close();
} finally {
  await browser.close();
}
