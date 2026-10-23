import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";

// Browser plugin not available. Production HTML/modules/CSS in an isolated headless profile.
// Synthetic media and storage only; no user profile, phone or cloud is accessed.
const executablePath = [process.env.MORI_CHROME_PATH, ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
  .filter(Boolean).flatMap(root => ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"].map(file => path.join(root, file)))].find(file => file && existsSync(file));
assert.ok(executablePath);
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [390, 320, 768, 1280]) {
    const mobile = width !== 1280;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.url().includes("/icons/material/") && response.status() >= 400) errors.push(`Icon HTTP ${response.status()}: ${response.url()}`); });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
      return route.continue();
    });
    await page.addInitScript(mobile => {
      localStorage.setItem("mori_lang", "zh");
      const image = (width, height, color) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/png");
      };
      window.fixtureImages = { "/one.png": image(240, 320, "#ce9ca8"), "/two.png": image(320, 190, "#e6b984"), "/three.png": image(240, 260, "#b38a94") };
      window.sourceOpens = [];
      window.open = url => { window.sourceOpens.push(url); return null; };
      if (mobile) window.Capacitor = { getPlatform: () => "android", convertFileSrc: uri => window.fixtureImages[new URL(uri).pathname] || uri, Plugins: {} };
      else window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "tauri_open_url") { window.sourceOpens.push(args.url); return; }
        if (command === "tauri_read_file_bytes") return Array.from(atob(window.fixtureImages[args.path].split(",")[1]), char => char.charCodeAt(0));
        throw new Error(`Unexpected fixture command ${command}`);
      } } };
    }, mobile);
    await page.goto(origin);
    assert.match(await page.title(), /Mori/i);
    await page.evaluate(async mobile => {
      document.documentElement.classList.add(mobile ? "is-android" : "is-desktop");
      document.getElementById("homePage").classList.add("hidden");
      document.getElementById("inspirationPage").classList.remove("hidden");
      localStorage.setItem("mori_inspiration_albums", JSON.stringify([{ id: "a", name: "粉黛乱子草", createdAt: 2 }, { id: "b", name: "色调参考", createdAt: 1 }, { id: "empty", name: "空相册" }]));
      const paths = ["/one.png", "/two.png", "/three.png"];
      localStorage.setItem("mori_history", JSON.stringify(["粉黛外拍参考", "逆光与场景", "视频收藏帧"].map((title, index) => ({
        title, sourceUrl: `https://source.example/${index}`, timestamp: Date.now(),
        localFiles: Array.from({ length: index === 2 ? 2 : 5 }, (_, i) => ({ path: paths[(i + index) % 3], type: index === 2 ? "FRAME" : "IMAGE", frameTime: i * 3, savedAt: Date.now() })),
      }))));
      localStorage.setItem("mori_inspiration_link_albums", JSON.stringify(Object.fromEntries([0, 1, 2].map(index => [`https://source.example/${index}`, ["a", ...(index === 1 ? ["b"] : [])]]))));
      const inspiration = await import("/js/modules/inspiration.js"); inspiration.initInspiration(); inspiration.renderInspiration();
      const planner = await import("/js/modules/planner.js"); planner.initPlanner();
      if (mobile) await (await import("/js/sync/manualAlbumSync.js")).initManualAlbumSync();
      window.albumFixtureBack = (await import("/js/modules/inspirationMobile.js")).handleMobileInspirationBack;
      window.albumSelected = [];
      window.addEventListener("mori_album_selected", event => window.albumSelected.push(event.detail.id));
    }, mobile);
    const dataBefore = await page.evaluate(() => Object.fromEntries(["mori_history", "mori_inspiration_albums", "mori_inspiration_link_albums"].map(key => [key, localStorage.getItem(key)])));
    if (!mobile) {
      assert.equal(await page.locator("#albumMobileHeader").count(), 0);
      assert.equal(await page.locator(".inspiration-album-tab").count(), 5);
      await page.locator(".inspiration-album-tab").filter({ hasText: "粉黛乱子草" }).click();
      assert.equal(await page.locator(".inspiration-lane").count(), 3);
      assert.equal(await page.locator(".inspiration-card-actions").count(), 12);
      await context.close(); continue;
    }
    assert.equal(await page.locator(".album-cover").count(), 3);
    assert.equal(await page.locator(".app-container > header").isVisible(), false);
    assert.equal(await page.locator(".bottom-nav").isVisible(), true);
    await page.waitForFunction(() => [...document.querySelectorAll(".album-cover-image img")].every(img => img.naturalWidth > 0));
    if (width === 390 && process.env.MORI_QA_DIR) {
      mkdirSync(process.env.MORI_QA_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mobile-covers.png") });
    }
    await page.locator('[data-album-id="a"]').tap();
    assert.equal(await page.locator("#albumMobileTitle").textContent(), "粉黛乱子草");
    assert.equal(await page.locator(".bottom-nav").isVisible(), false);
    assert.equal(await page.locator("#inspirationPage").getAttribute("data-album-view"), "groups");
    assert.equal(await page.locator(".inspiration-lane").count(), 3);
    assert.equal(await page.locator(".inspiration-card-actions").count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll(".inspiration-card img")].some(img => img.naturalWidth > 0));
    const strip = page.locator(".inspiration-lane-stack").first();
    await strip.evaluate(element => { element.scrollLeft = 100; });
    assert.ok(await strip.evaluate(element => element.scrollLeft) > 0);
    await page.locator(".inspiration-title-link").first().tap();
    assert.deepEqual(await page.evaluate(() => window.sourceOpens), ["https://source.example/0"]);
    await page.locator(".inspiration-card").nth(1).tap();
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), true);
    await page.waitForFunction(() => document.querySelector("#albumMobilePreview img").naturalWidth > 0);
    await page.locator('[data-photo-step="1"]').tap();
    assert.equal(await page.locator("#albumPreviewCount").textContent(), "3 / 5");
    assert.equal(await page.evaluate(() => window.albumFixtureBack()), true);
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), false);
    if (width === 390 && process.env.MORI_QA_DIR) await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mobile-groups.png") });
    await page.locator('[data-album-view="canvas"]').tap();
    assert.equal(await page.locator("#albumMobileZoomLabel").textContent(), "70%");
    assert.ok((await page.locator("#inspirationViewport").boundingBox()).height > 700);
    const cdp = await context.newCDPSession(page);
    const touch = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x,y,id]) => ({ x,y,id,radiusX:2,radiusY:2 })) });
    const transformBefore = await page.locator("#inspirationStage").evaluate(element => element.style.transform);
    // First finger starts on an image. Adding a second finger takes priority over photo activation.
    await touch("touchStart", [[70,230,1]]);
    await touch("touchStart", [[70,230,1],[210,230,2]]);
    await touch("touchMove", [[45,250,1],[255,250,2]]);
    await touch("touchEnd", [[45,250,1]]);
    await touch("touchMove", [[60,270,1]]);
    await touch("touchEnd", []);
    assert.notEqual(await page.locator("#inspirationStage").evaluate(element => element.style.transform), transformBefore);
    assert.equal(await page.locator("#albumMobileZoomLabel").textContent(), "105%");
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), false);
    assert.equal(await page.locator(".inspiration-card[aria-selected=true]").count(), 0);
    // Cancelled touches and dragging back to the start never turn into a tap.
    await touch("touchStart", [[80,260,1]]); await touch("touchMove", [[130,260,1]]);
    await touch("touchMove", [[80,260,1]]); await touch("touchEnd", []);
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), false);
    await touch("touchStart", [[80,260,1]]); await touch("touchCancel", []);
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), false);
    // Reset to a stable location, then a genuine single tap still previews the image.
    await page.locator("#albumMobileBack").tap(); await page.locator('[data-album-id="a"]').tap();
    await touch("touchStart", [[70,230,1]]); await touch("touchEnd", []);
    assert.equal(await page.locator("#albumMobilePreview").isVisible(), true);
    await page.evaluate(() => window.albumFixtureBack());
    if (width === 390 && process.env.MORI_QA_DIR) await page.screenshot({ path: path.join(process.env.MORI_QA_DIR, "mobile-canvas.png") });
    await page.locator("#albumMobileZoom button").tap();
    assert.ok(parseInt(await page.locator("#albumMobileZoomLabel").textContent()) < 70);
    await page.locator("#albumMobileMore").tap();
    assert.equal(await page.locator("#albumMobileMenu").isVisible(), true);
    assert.equal(await page.locator("#albumMobileSync").isVisible(), false, "sync is discoverable but collapsed away from the gallery");
    await page.locator("#albumMobileSync").evaluate(element => { element.parentElement.open = true; });
    assert.equal(await page.locator("#albumCloudSyncBtn").isVisible(), true);
    assert.equal(await page.evaluate(() => window.albumFixtureBack()), true);
    assert.equal(await page.locator("#albumMobileTitle").textContent(), "粉黛乱子草");
    await page.locator("#albumMobileBack").tap();
    await page.locator('[data-album-id="b"]').tap();
    assert.equal(await page.locator(".inspiration-lane").count(), 1, "changing albums does not retain the previous sources");
    await page.locator("#albumMobileBack").tap();
    await page.locator('[data-album-id="empty"]').tap();
    assert.equal(await page.locator("#inspirationEmpty").isVisible(), true);
    // A downloaded album opens its own existing Planner in full screen.
    await page.evaluate(async () => {
      const { showImportedInspirationLibrary } = await import("/js/modules/inspiration.js");
      localStorage.setItem("mori_planner_board_v2:phone-plan", JSON.stringify({ version: 2, projectId: "phone-plan", projectTitle: "相册策划", readOnly: true, nodes: [], edges: [], view: { zoom: 1, panX: 0, panY: 0 } }));
      // Use the production persistence format, as downloaded by manualAlbumSync.
      const { createAlbumLibraryBoard, saveImportedAlbumLibrary } = await import("/js/sync/albumLibrary.js");
      const { splitPlannerBoardForSync } = await import("/js/sync/plannerAdapter.js");
      const catalog = await createAlbumLibraryBoard({ sourceAlbumId: "a", albums: [{ id: "a", name: "下载相册" }], groups: [] }, { projectId: "album-library:fixture", plannerProjectId: "phone-plan" });
      const library = saveImportedAlbumLibrary(splitPlannerBoardForSync(catalog.board).shared, []);
      showImportedInspirationLibrary(library);
    });
    await page.locator("#inspirationPlannerModeBtn").tap();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("planner-android-fullscreen")), true);
    assert.equal(await page.locator("#albumMobileHeader").isVisible(), false);
    assert.equal(await page.locator("#plannerMobileControls").isVisible(), true);
    await page.locator("#plannerMobileBackBtn").tap();
    assert.equal(await page.locator("#albumMobileTitle").textContent(), "下载相册");
    assert.equal(await page.locator("#inspirationPage").getAttribute("data-mobile-screen"), "detail");
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(["mori_history", "mori_inspiration_albums", "mori_inspiration_link_albums"].map(key => [key, localStorage.getItem(key)]))), dataBefore);
    await page.locator("#albumMobileBack").tap();
    await page.locator("#albumMobileNew").tap();
    assert.equal(await page.evaluate(() => window.albumFixtureBack()), false, "create confirmation retains priority over album navigation");
    await page.locator("#inspirationAlbumNameInput").fill("新相册");
    await page.locator("#okConfirmBtn").tap();
    assert.equal(await page.locator("#albumMobileTitle").textContent(), "新相册");
    assert.equal(await page.locator("#inspirationEmpty").isVisible(), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("mori_inspiration_albums")).length), 4);
    await page.locator("#albumMobileBack").tap(); await page.locator('[data-album-id="a"]').tap();
    await page.locator("#albumMobileMore").tap();
    await page.locator("#albumMobileOrganize summary").tap();
    await page.locator("#albumMobileGroupTools select").first().selectOption("b");
    await page.evaluate(() => window.albumFixtureBack());
    await page.locator("#albumMobileBack").tap(); await page.locator('[data-album-id="b"]').tap();
    assert.equal(await page.locator(".inspiration-lane").count(), 2, "source assignment remains available through the menu");
    await page.locator("#albumMobileMore").tap();
    await page.locator("#albumMobileGroupTools button").first().tap();
    assert.equal(await page.locator(".inspiration-lane").count(), 1, "remove group updates the album without deleting image files");
    assert.deepEqual(errors, []);
    console.log(`PASS: ${width}px covers, groups, preview, source links, native pinch/pan/tap/cancel, back stack, scoped albums and full-screen Planner`);
    await context.close();
  }
  console.log("PASS: desktop album controls and data preserved");
} finally {
  await browser?.close(); server.close(); await once(server, "close");
}
