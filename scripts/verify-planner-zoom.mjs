import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";

// Browser plugin not available. Use an isolated headless profile, synthetic local
// files and the production module/CSS; no user app, files or cloud are accessed.
const source = await readFile(new URL("../public/js/modules/planner.js", import.meta.url), "utf8");
const executablePath = process.env.MORI_CHROME_PATH || [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
  .filter(Boolean).flatMap((root) => ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"].map((file) => path.join(root, file))).find(existsSync);
assert.ok(executablePath, "existing Chrome/Edge is available");
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  for (const platform of ["desktop", "android"]) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: platform === "android", viewport: platform === "desktop" ? { width: 1280, height: 850 } : { width: 412, height: 915 } });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
      if (url.pathname === "/js/modules/planner.js") return route.fulfill({ contentType: "text/javascript", body: source + `
        window.zoomTest = {
          mount(nodes) {
            const next = createEmptyBoard({ projectId: 'isolated-zoom' });
            next.nodes = nodes; next.edges = [{ id: 'edge', from: 'a', to: 'b', fromSide: 'right', toSide: 'left' }];
            next.view = { zoom: 1, panX: 20, panY: 20 };
            activatePlannerBoard(next, 'today');
            document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
            const el = plannerElements(); el.page.classList.remove('hidden'); el.page.classList.add('planner-mode');
            el.viewport.classList.remove('hidden'); el.libraryViewport.classList.add('hidden');
            if (isAndroidNative()) document.documentElement.classList.add('planner-android-fullscreen', 'is-android');
            bindPlannerInteractions(); renderPlanner({ full: true });
            selectedNodeIds.add('a'); updateSelectionUI();
          },
          zoom: setPlannerZoom,
          touchSetup(ids = []) {
            board.view = { zoom: 0.6, panX: 20, panY: 110 };
            setAndroidLimitedWriteEnabled(true);
            selectedNodeIds = new Set(ids); updateSelectionUI(); applyPlannerTransform();
          },
          state: () => ({ view: { ...board.view }, selected: [...selectedNodeIds], nodes: JSON.parse(JSON.stringify(board.nodes)) })
        };` });
      return route.continue();
    });
    await page.addInitScript((platform) => {
      window.imageReads = 0; window.imageLoads = 0;
      window.addEventListener("load", (event) => { if (event.target.tagName === "IMG") window.imageLoads++; }, true);
      const png = () => {
        const canvas = document.createElement("canvas"); canvas.width = 24; canvas.height = 32;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "#e47a2c"; ctx.fillRect(0, 0, 24, 32);
        return canvas.toDataURL("image/png");
      };
      if (platform === "android") window.Capacitor = { getPlatform: () => "android", convertFileSrc: () => { window.imageReads++; return png(); }, Plugins: {} };
      else window.__TAURI__ = { core: { invoke: async (command) => {
        if (command !== "tauri_read_file_bytes") throw new Error(`Unexpected command ${command}`);
        window.imageReads++; return Array.from(atob(png().split(",")[1]), char => char.charCodeAt(0));
      } } };
    }, platform);
    await page.goto(origin);
    assert.match(await page.title(), /Mori/i);
    await page.evaluate(async () => {
      await import("/js/modules/planner.js");
      window.zoomTest.mount([
        { id: "g", type: "group", x: 0, y: 0, w: 650, h: 440, text: "References", memberIds: ["a", "b", "nested"] },
        { id: "nested", type: "group", x: 300, y: 0, w: 300, h: 440, text: "Nested", memberIds: ["b"] },
        { id: "a", type: "image", x: 20, y: 20, w: 240, uri: "file:///synthetic/a.png" },
        { id: "b", type: "image", x: 320, y: 20, w: 240, uri: "file:///synthetic/b.png" },
        { id: "c", type: "image", x: 700, y: 20, w: 120, uri: "file:///synthetic/c.png" }
      ]);
      window.initialImages = [...document.querySelectorAll('.planner-node-image img')];
    });
    await page.waitForFunction(() => window.initialImages.every(img => img.complete && img.naturalWidth === 24));
    const before = await page.evaluate(() => ({ reads: window.imageReads, loads: window.imageLoads }));
    const visibility = [];
    for (const zoom of [1, 0.3, 0.19, 0.18, 0.2, 0.28, 0.3, 0.1, 0.001, 0.4, 1, 2, 0.18, 0.3]) {
      await page.evaluate((zoom) => window.zoomTest.zoom(zoom, 80, 80), zoom);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const state = await page.evaluate(() => ({
        visible: window.initialImages.filter(img => getComputedStyle(img.parentElement).display !== "none").length,
        stable: window.initialImages.every(img => img.isConnected && img.complete && img.naturalWidth === 24),
        selected: window.zoomTest.state().selected,
        edges: document.querySelectorAll('.planner-edge-path').length,
        edgeBounds: (() => { const edges=document.getElementById('plannerEdges').getBoundingClientRect(); const viewport=document.getElementById('plannerViewport').getBoundingClientRect(); return { width: edges.width, height: edges.height, maxWidth: viewport.width, maxHeight: viewport.height }; })(),
        edgeAlignment: (() => { const point=new DOMPoint(20,20).matrixTransform(document.getElementById('plannerEdges').getScreenCTM()); const node=document.querySelector('[data-node-id="a"]').getBoundingClientRect(); return { x: point.x-node.left, y: point.y-node.top }; })(),
      }));
      visibility.push([zoom, state.visible]);
      if (!process.argv.includes("--probe")) {
        assert.equal(state.visible, 3, `${platform}: all reference images stay rendered at zoom ${zoom}`);
        assert.equal(state.stable, true, `${platform}: image elements and decoded sources survive zoom`);
        assert.deepEqual(state.selected, ["a"], `${platform}: zoom preserves image selection`);
        assert.equal(state.edges, 1, `${platform}: image connections stay rendered`);
        assert(state.edgeBounds.width <= state.edgeBounds.maxWidth && state.edgeBounds.height <= state.edgeBounds.maxHeight, 'edge raster bounds stay within the viewport at every scale');
        assert(Math.abs(state.edgeAlignment.x) < 2 && Math.abs(state.edgeAlignment.y) < 2, `${platform}: edge coordinates follow node coordinates at zoom ${zoom}`);
      }
    }
    if (process.argv.includes("--probe")) { console.log(`${platform} visibility: ${JSON.stringify(visibility)}`); await context.close(); continue; }
    // Exercise the actual desktop wheel and Android pinch handlers, including
    // repeated crossing of the previous automatic folding thresholds.
    await page.evaluate((platform) => {
      const viewport = document.getElementById("plannerViewport");
      window.zoomTest.zoom(0.3, 80, 80);
      for (let index = 0; index < 8; index++) {
        if (platform === "desktop") {
          for (const deltaY of [500, -500]) viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY, clientX: 80, clientY: 80, bubbles: true, cancelable: true }));
        } else {
          const touches = (distance) => [new Touch({ identifier: 1, target: viewport, clientX: 50, clientY: 100 }), new Touch({ identifier: 2, target: viewport, clientX: 50 + distance, clientY: 100 })];
          for (const [type, distance] of [["touchstart", 200], ["touchmove", 100], ["touchmove", 200], ["touchend", 0]]) {
            viewport.dispatchEvent(new TouchEvent(type, { touches: distance ? touches(distance) : [], bubbles: true, cancelable: true }));
            if (window.initialImages.some(img => getComputedStyle(img.parentElement).display === "none")) throw new Error("image hidden during pinch");
          }
        }
      }
    }, platform);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const after = await page.evaluate(() => ({ reads: window.imageReads, loads: window.imageLoads, selected: window.zoomTest.state().selected,
      stable: window.initialImages.every(img => img.isConnected && img.complete && getComputedStyle(img.parentElement).display !== "none") }));
    assert.equal(after.reads, before.reads, "zoom must not read image files again");
    assert.equal(after.loads, before.loads, "zoom must not assign/reload image sources");
    assert.deepEqual(after.selected, ["a"]); assert.equal(after.stable, true);
    if (platform === "android") {
      // Dispatch native Chromium touch input, including pointer events and
      // implicit capture. Synthetic viewport-only touches missed this bug.
      const cdp = await context.newCDPSession(page);
      const dispatch = async (type, touchPoints) => {
        await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      };
      const pointFor = async (selector, id) => {
        const rect = await page.locator(selector).boundingBox(); assert(rect);
        return { id, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      const state = () => page.evaluate(() => window.zoomTest.state());
      const reset = ids => page.evaluate(ids => window.zoomTest.touchSetup(ids), ids);
      const a = '.planner-node[data-node-id="a"]';
      const b = '.planner-node[data-node-id="b"]';
      await reset([]);
      const beforePinch = await state();
      const first = await pointFor(`${a} img`, 1); const second = await pointFor(`${b} img`, 2);
      await dispatch("touchStart", [first]);
      assert.deepEqual((await state()).selected, [], "first touch on an image does not select on down");
      await dispatch("touchStart", [first, second]);
      await dispatch("touchMove", [{ ...first, x: first.x - 15 }, { ...second, x: second.x + 15 }]);
      assert.notEqual((await state()).view.zoom, beforePinch.view.zoom, "two image fingers zoom the canvas");
      await dispatch("touchEnd", [first]); await dispatch("touchEnd", []);
      assert.deepEqual((await state()).selected, [], "lifting the last pinch finger never selects an image");
      assert.deepEqual((await state()).nodes, beforePinch.nodes);

      // Single tap selects; an unselected image drag pans, while dragging an
      // already selected image keeps the existing limited edit capability.
      await reset([]);
      const tap = await pointFor(`${a} img`, 1);
      await dispatch("touchStart", [tap]); await dispatch("touchEnd", []);
      assert.deepEqual((await state()).selected, ["a"]);
      for (const selector of [`${a} img`, `${a} .planner-resize-handle.is-se`, `${a} .planner-rotate-handle`]) {
        await reset(["a"]);
        const original = await state(); const finger = await pointFor(selector, 1);
        await dispatch("touchStart", [finger]);
        const moved = { ...finger, x: finger.x + 12, y: finger.y + 9 };
        await dispatch("touchMove", [moved]);
        assert.notDeepEqual((await state()).nodes, original.nodes, `${selector}: selected-image single finger still manipulates the node`);
        const another = { id: 2, x: Math.max(20, moved.x - 100), y: Math.max(80, moved.y - 60) };
        await dispatch("touchStart", [moved, another]);
        assert.deepEqual((await state()).nodes, original.nodes, "second finger rolls back the unfinished node manipulation");
        await dispatch("touchMove", [{ ...moved, x: moved.x + 15 }, { ...another, x: another.x - 15 }]);
        assert.notEqual((await state()).view.zoom, original.view.zoom);
        await dispatch("touchEnd", []);
        assert.deepEqual((await state()).nodes, original.nodes); assert.deepEqual((await state()).selected, ["a"]);
      }
      await cdp.detach();
      console.log("PASS: native mobile touches on two images; deferred tap selection, pinch-to-one-finger, selected drag/resize/rotate cancellation with unchanged node data");
    }
    await page.setViewportSize({ width: platform === "android" ? 915 : 1024, height: platform === "android" ? 412 : 768 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const resized = await page.evaluate(() => {
      const edges = document.getElementById('plannerEdges');
      const point = new DOMPoint(20,20).matrixTransform(edges.getScreenCTM());
      const node = document.querySelector('[data-node-id="a"]').getBoundingClientRect();
      return { x: point.x-node.left, y: point.y-node.top, width: edges.getBoundingClientRect().width, maxWidth: document.getElementById('plannerViewport').clientWidth };
    });
    assert(Math.abs(resized.x) < 2 && Math.abs(resized.y) < 2 && resized.width <= resized.maxWidth, 'resized/rotated viewport retains aligned, bounded edges');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${platform} production zoom/wheel/pinch; grouped/nested/ungrouped images, selection, edges and decoded sources stay stable`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  server.close(); await once(server, "close");
}
