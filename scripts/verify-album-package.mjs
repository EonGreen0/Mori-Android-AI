import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createDevServer } from "./dev-server.mjs";
import { parseAlbumPackage, encodeAlbumPackage } from "../public/js/modules/albumPackageFormat.js";

// Browser plugin unavailable: existing playwright-core + installed Chrome, isolated profiles and synthetic media.
const executablePath = [process.env.MORI_CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(value => value && existsSync(value));
assert.ok(executablePath);
const server = createDevServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let savedPackage, failWriteAt = 0, writeCount = 0;
const files = new Map(), cloudRequests = [];
const errors = [];
async function contextFor(phone) {
  const context = await browser.newContext({ serviceWorkers: "block", hasTouch: phone, viewport: { width: phone ? 390 : 1280, height: 844 } });
  await context.exposeFunction("saveFixturePackage", args => { savedPackage = args; return `C:/Downloads/${args.folder}/${args.filename}`; });
  await context.exposeFunction("writeFixtureImage", args => {
    if (++writeCount === failWriteAt) throw new Error("fixture storage full");
    const uri = `file:///data/user/0/com.mori.downloader/files/${args.path}`;
    files.set(uri, args.data); return { uri };
  });
  await context.exposeFunction("readFixtureImage", args => {
    const data = files.get(args.path); if (!data) throw new Error("fixture image missing"); return { data };
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname.includes("mori-sync")) cloudRequests.push(url.href);
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/js/app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.pathname.startsWith("/package-image/")) {
      const data = files.get(decodeURIComponent(url.pathname.slice(15)));
      return data ? route.fulfill({ contentType: "image/jpeg", body: Buffer.from(data, "base64") }) : route.fulfill({ status: 404, body: "" });
    }
    return route.continue();
  });
  await context.addInitScript(phone => {
    localStorage.setItem("mori_lang", "zh");
    window.fixtureImage = (color) => {
      const canvas = document.createElement("canvas"); canvas.width = 90; canvas.height = 120;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0,0,90,120); return canvas.toDataURL("image/png");
    };
    if (phone) window.Capacitor = {
      getPlatform: () => "android",
      convertFileSrc: uri => `${location.origin}/package-image/${encodeURIComponent(uri)}`,
      Plugins: { Filesystem: { writeFile: args => window.writeFixtureImage(args), readFile: args => window.readFixtureImage(args) } },
    };
    else window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === "tauri_save_bytes_file") return window.saveFixturePackage(args);
      if (command === "tauri_read_file_bytes") {
        if (window.failFixtureRead === args.path) throw new Error("fixture source image missing");
        const image = window.fixtureImage({ "/one.png":"#ad8f77", "/frame.png":"#698a63", "/outside.png":"#d497a1", "/other-album.png":"#555" }[args.path] || "#6486a6");
        return Array.from(atob(image.split(",")[1]), char => char.charCodeAt(0));
      }
      if (command === "tauri_open_url") { window.openedFolder = args.url; return; }
      if (command === "tauri_sync_available") return false;
      throw new Error(`Unexpected native command ${command}`);
    } } };
  }, phone);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); assert.match(await page.title(), /Mori/);
  return { context, page };
}
async function start(page, phone) {
  await page.evaluate(async phone => {
    document.documentElement.classList.toggle("is-android", phone);
    document.getElementById("homePage").classList.add("hidden"); document.getElementById("inspirationPage").classList.remove("hidden");
    const inspiration = await import("/js/modules/inspiration.js"); inspiration.initInspiration(); inspiration.renderInspiration();
    (await import("/js/modules/planner.js")).initPlanner();
    (await import("/js/modules/albumPackage.js")).initAlbumPackageControls();
  }, phone);
}
try {
  const pc = await contextFor(false);
  await pc.page.evaluate(() => {
    const now = Date.now();
    localStorage.setItem("mori_inspiration_albums", JSON.stringify([{id:"a",name:"朋友试用相册"},{id:"b",name:"别的相册"}]));
    localStorage.setItem("mori_history", JSON.stringify([
      { title:"图片与隐藏收藏帧", sourceUrl:"https://source.example/photo", timestamp:now, localFiles:[{path:"/one.png",type:"IMAGE"},{path:"/frame.png",type:"FRAME",frameTime:4.5}] },
      { title:"视频来源", sourceUrl:"https://source.example/video", timestamp:now, localFiles:[{path:"/clip.mp4",type:"VIDEO"}] },
      { title:"不应导出的相册", sourceUrl:"https://source.example/other", timestamp:now, localFiles:[{path:"/other-album.png",type:"IMAGE"}] },
    ]));
    localStorage.setItem("mori_inspiration_link_albums", JSON.stringify({"https://source.example/photo":["a"],"https://source.example/video":["a"],"https://source.example/other":["b"]}));
    localStorage.setItem("mori_planner_projects_v2", JSON.stringify({version:2,projects:{planA:{projectId:"planA",albumIds:["a"]}},activeProjectByAlbum:{a:"planA"},legacyMigration:{completed:true}}));
    localStorage.setItem("mori_planner_board_v2:planA", JSON.stringify({projectId:"planA",projectTitle:"同相册策划",readOnly:false,
      nodes:[{id:"img",type:"image",path:"/one.png",x:0,y:0,w:100,h:120},{id:"external",type:"image",path:"/outside.png",x:140,y:0,w:100,h:120},
        {id:"note",type:"text",text:"策划备注保持",x:0,y:160,w:200,h:80},{id:"group",type:"group",memberIds:["img","external"],x:0,y:0,w:250,h:140}],
      edges:[{id:"edge",from:"note",to:"img",fromSide:"top",toSide:"bottom"}],view:{zoom:0.8,panX:30,panY:40},commentFontSize:18,importCount:2}));
  });
  await start(pc.page, false);
  await pc.page.locator('.inspiration-album-tab').filter({hasText:"朋友试用相册"}).click();
  await pc.page.locator("#albumPackageControls > summary").click();
  const pcData = await pc.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  await pc.page.locator("#albumPackageExportBtn").click();
  await pc.page.waitForFunction(() => document.querySelector("#albumPackageStatus").textContent.startsWith("已导出"));
  assert.ok(savedPackage.filename.endsWith(".mori-album"));
  const bytes = new Uint8Array(savedPackage.bytes), parsed = parseAlbumPackage(bytes);
  assert.equal(parsed.manifest.album.groups.length,2); assert.equal(parsed.manifest.assets.length,3);
  assert.equal(parsed.manifest.planner.nodes.length,4); assert.equal(parsed.manifest.album.groups[0].files[1].frameTime,4.5);
  assert.equal(parsed.manifest.album.groups[1].hasVideo,true);
  assert.ok(!new TextDecoder().decode(bytes).includes("/outside.png"));
  assert.deepEqual(await pc.page.evaluate(() => Object.fromEntries(Object.entries(localStorage))), pcData);
  await pc.page.locator("#albumPackageOpenFolder").click(); assert.match(await pc.page.evaluate(() => window.openedFolder), /Mori\/AlbumPackages$/);
  const savedBeforeFailure = savedPackage;
  await pc.page.evaluate(() => { window.failFixtureRead = "/outside.png"; });
  await pc.page.locator("#albumPackageExportBtn").click();
  await pc.page.waitForFunction(() => document.querySelector("#albumPackageStatus").textContent.startsWith("导出失败"));
  assert.equal(savedPackage, savedBeforeFailure);
  assert.deepEqual(await pc.page.evaluate(() => Object.fromEntries(Object.entries(localStorage))), pcData);
  await pc.context.close();
  console.log("PASS desktop selected album + hidden frame + video link + external plan image, source untouched");

  const phone = await contextFor(true);
  await phone.page.evaluate(() => {
    localStorage.setItem("mori_inspiration_albums",JSON.stringify([{id:"phone",name:"手机原相册"}]));
    localStorage.setItem("mori_history",JSON.stringify([{title:"手机独有素材",localFiles:[]}]));
    localStorage.setItem("mori_planner_projects_v2",JSON.stringify({version:2,projects:{},activeProjectByAlbum:{},legacyMigration:{completed:true}}));
  });
  await start(phone.page,true);
  const preserved = await phone.page.evaluate(() => [localStorage.getItem("mori_history"),localStorage.getItem("mori_inspiration_albums")]);
  async function importViaMenu(buffer) {
    await phone.page.locator("#albumMobileMore").tap();
    if (!(await phone.page.locator("#albumPackageControls").evaluate(element => element.open))) await phone.page.locator("#albumPackageControls > summary").tap();
    const chooser = phone.page.waitForEvent("filechooser"); await phone.page.locator("#albumPackageImportBtn").tap();
    await (await chooser).setFiles({name:"相册.mori-album",mimeType:"application/octet-stream",buffer:Buffer.from(buffer)});
    await phone.page.waitForFunction(() => !document.querySelector("#albumPackageImportBtn").disabled);
  }
  await importViaMenu(bytes);
  assert.equal(await phone.page.locator("#albumMobileTitle").textContent(),"朋友试用相册");
  assert.equal(await phone.page.locator(".inspiration-lane").count(),2);
  await phone.page.waitForFunction(() => [...document.querySelectorAll(".inspiration-card img")].every(img => img.naturalWidth > 0));
  await phone.page.locator("#inspirationPlannerModeBtn").tap();
  assert.equal(await phone.page.locator(".planner-node").count(),4);
  assert.equal(await phone.page.locator("#plannerMobileUploadChangesBtn").isVisible(),false);
  const firstImport = await phone.page.evaluate(() => JSON.parse(localStorage.getItem("mori_synced_albums_v1")));
  const firstAlbum = Object.values(firstImport)[0].albums[0], firstBoardKey = `mori_planner_board_v2:${firstAlbum.plannerProjectId}`;
  const firstBoard = await phone.page.evaluate(key => JSON.parse(localStorage.getItem(key)), firstBoardKey);
  assert.equal(firstBoard.localPackage,true); assert.equal(firstBoard.readOnly,true); assert.equal(firstBoard.nodes.find(n=>n.id==="note").text,"策划备注保持");
  await phone.page.evaluate(async () => { (await import("/js/modules/planner.js")).setAndroidLimitedWriteEnabled(true); });
  const noteBox = await phone.page.locator(".planner-node[data-node-id=note]").boundingBox();
  await phone.page.touchscreen.tap(noteBox.x + 20, noteBox.y + 20);
  assert.equal(await phone.page.locator(".planner-text-content[contenteditable=true]").count(),0);
  const oldPosition = firstBoard.nodes.find(n=>n.id==="img").x;
  const box = await phone.page.locator('.planner-node[data-node-id=img]').boundingBox();
  await phone.page.mouse.move(box.x+20,box.y+20); await phone.page.mouse.down(); await phone.page.mouse.move(box.x+60,box.y+70); await phone.page.mouse.up();
  assert.equal(await phone.page.evaluate(key=>JSON.parse(localStorage.getItem(key)).nodes.find(n=>n.id==="img").x,firstBoardKey),oldPosition);
  assert.equal(await phone.page.evaluate(async()=> (await (await import("/js/sync/outbox.js")).listPlannerOutbox({all:true})).length),0);
  await phone.page.locator("#plannerMobileBackBtn").tap();
  await importViaMenu(bytes);
  assert.equal(await phone.page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("mori_synced_albums_v1"))).length),2);
  assert.deepEqual(await phone.page.evaluate(()=>[localStorage.getItem("mori_history"),localStorage.getItem("mori_inspiration_albums")]),preserved);
  console.log("PASS credential-free phone import / images / linked full-screen plan / read-only even with cloud-write enabled / repeated copies");

  const beforeFailure = await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
  failWriteAt = writeCount + 2;
  await importViaMenu(bytes); assert.match(await phone.page.locator("#albumPackageStatus").textContent(),/导入失败/);
  assert.deepEqual(await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),beforeFailure);
  failWriteAt = 0;
  await phone.page.evaluate(()=>{ const original=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value){if(key==="mori_synced_albums_v1")throw new Error("fixture quota full");return original.call(this,key,value);};window.restoreStorage=()=>{Storage.prototype.setItem=original;}; });
  await phone.page.locator("#albumMobileMenu .album-dialog-heading button").tap();
  await importViaMenu(bytes); assert.match(await phone.page.locator("#albumPackageStatus").textContent(),/导入失败/);
  assert.deepEqual(await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),beforeFailure);
  await phone.page.evaluate(()=>window.restoreStorage());
  console.log("PASS file-save failure and library-commit quota failure preserve metadata and roll back new plan/index");

  // Direct malformed imports avoid menu state changes so preservation is measured exactly.
  await phone.page.evaluate(async bytes=>{await (await import("/js/modules/albumPackage.js")).importLocalAlbumPackage(new File([new Uint8Array(bytes)],"broken.mori-album"));},Array.from(bytes.slice(0,-1)));
  assert.deepEqual(await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),beforeFailure);
  const badManifest=structuredClone(parsed.manifest); badManifest.assets[0].offset=1;
  assert.throws(()=>encodeAlbumPackage(badManifest,parsed.images));
  assert.throws(()=>parseAlbumPackage(bytes.subarray(0,10)));
  const badJpeg=encodeAlbumPackage(parsed.manifest,parsed.images.map((image,i)=>i===0?new Uint8Array(image.length):image));
  const writesBefore=writeCount;
  await phone.page.evaluate(async bytes=>{await (await import("/js/modules/albumPackage.js")).importLocalAlbumPackage(new File([new Uint8Array(bytes)],"broken-image.mori-album"));},Array.from(badJpeg));
  assert.equal(writeCount,writesBefore);
  assert.deepEqual(await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),beforeFailure);
  await phone.page.evaluate(async () => {
    await (await import("/js/modules/albumPackage.js")).importLocalAlbumPackage({ size: 129 * 1024 * 1024, arrayBuffer: () => { throw new Error("oversized input must not be read"); } });
  });
  assert.match(await phone.page.locator("#albumPackageStatus").textContent(),/128 MB/);
  assert.deepEqual(await phone.page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),beforeFailure);
  const empty = { format:"mori-album-package",version:1,createdAt:new Date().toISOString(),album:{name:"无策划的空相册",groups:[]},planner:null,assets:[] };
  await phone.page.evaluate(async bytes=>{await (await import("/js/modules/albumPackage.js")).importLocalAlbumPackage(new File([new Uint8Array(bytes)],"empty.mori-album"));},Array.from(encodeAlbumPackage(empty,[])));
  assert.equal(await phone.page.locator("#albumMobileTitle").textContent(),"无策划的空相册");
  await phone.page.locator("#inspirationPlannerModeBtn").tap();
  assert.equal(await phone.page.locator("#inspirationPage").evaluate(el=>el.classList.contains("planner-mode")),false);
  await phone.page.reload(); await start(phone.page,true);
  assert.equal(await phone.page.locator(".album-cover").count(),4);
  await phone.page.locator(`[data-album-id="${firstAlbum.id}"]`).tap();
  await phone.page.waitForFunction(()=>[...document.querySelectorAll(".inspiration-card img")].every(img=>img.naturalWidth>0));
  await phone.page.locator("#inspirationPlannerModeBtn").tap(); assert.equal(await phone.page.locator(".planner-node").count(),4);
  if(process.env.MORI_QA_DIR){mkdirSync(process.env.MORI_QA_DIR,{recursive:true});await phone.page.screenshot({path:path.join(process.env.MORI_QA_DIR,"local-album-plan.png")});}
  assert.deepEqual(cloudRequests,[]); assert.deepEqual(errors,[]);
  await phone.context.close();
  console.log("PASS truncated/table/corrupt-image rejection + restart persistence + zero cloud requests + clean console");
} finally { await browser.close(); server.close(); }
