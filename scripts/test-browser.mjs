import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { createDevServer } from "./dev-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const cases = [
  "planner-sync-idb-runtime.html",
  "planner-sync-asset-runtime.html",
  "planner-sync-transport-runtime.html",
  "planner-sync-remote-merge-runtime.html",
];
const requestedFiles = process.argv.slice(2);
if (requestedFiles.length > 1 || requestedFiles.some((file) => !cases.includes(file))) {
  process.stderr.write(`Usage: node scripts/test-browser.mjs [${cases.join("|")}]\n`);
  process.exit(2);
}
const selectedCases = requestedFiles.length === 1 ? requestedFiles : cases;

function findBrowser() {
  if (process.env.MORI_CHROME_PATH) return process.env.MORI_CHROME_PATH;
  const programDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const candidates = programDirs.flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
  const executablePath = candidates.find(existsSync);
  if (!executablePath) {
    throw new Error("Chrome or Edge was not found; set MORI_CHROME_PATH to its executable");
  }
  return executablePath;
}

const server = createDevServer();
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });

  let failed = false;
  for (const file of selectedCases) {
    process.stdout.write(`\n==> ${file}\n`);
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        const requestUrl = new URL(route.request().url());
        return requestUrl.origin === origin ? route.continue() : route.abort();
      });
      await page.goto(`${origin}/scripts/${file}`, { waitUntil: "load" });
      await page.waitForFunction(
        () => document.title === "PASS" || document.title === "FAIL",
        null,
        { timeout: 45000 },
      );
      const title = await page.title();
      const output = await page.locator("#result").textContent().catch(() => "");
      process.stdout.write(`${title}\n${output || ""}\n`);
      if (title !== "PASS") failed = true;
    } catch (error) {
      process.stderr.write(`${file} failed: ${error.stack || error}\n`);
      failed = true;
    } finally {
      await context.close();
    }
  }
  if (failed) process.exitCode = 1;
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
