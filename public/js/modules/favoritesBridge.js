import { createFavoritesStore } from "./favoritesStore.js";
import { getFavoriteAlbumTargets, insertFavoritesIntoAlbum } from "./inspiration.js";
import { getFavoritePlannerTargets, insertFavoritesIntoPlanner } from "./planner.js";

export function initFavoritesBridge() {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  if (!invoke || !listen || !/Windows/i.test(navigator.userAgent)) return;
  const store = createFavoritesStore(localStorage);
  let queue = Promise.resolve();
  let undo = [];
  const completed = new Map();
  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const migrate = () => {
    const history = JSON.parse(localStorage.getItem("mori_history") || "[]");
    if (!Array.isArray(history)) throw new Error("原收藏帧记录无法读取，未改动原记录");
    store.migrate(history);
  };
  const changed = () => invoke("tauri_favorites_changed").catch(console.warn);
  const collect = (entry) => enqueue(() => { migrate(); store.add(entry); }).then(changed).catch(console.warn);
  window.addEventListener("mori_reference_frame_saved", (event) => {
    if (event.detail?.favoriteAlbumOnly) return;
    collect(event.detail);
  });
  listen("mori-douyin-frame-saved", (event) => collect(event.payload)).catch(console.warn);
  listen("mori-favorites-request", async ({ payload: request }) => {
    if (!request?.requestId || typeof request.requestId !== "string") return;
    let response;
    if (completed.has(request.requestId)) response = await completed.get(request.requestId);
    else {
      const operation = enqueue(async () => {
        migrate();
        const ids = [...new Set(Array.isArray(request.ids) ? request.ids : [])];
        if (ids.length > 200) throw new Error("一次最多操作200张图片");
        switch (request.action) {
          case "list": return { items: store.list(), albums: getFavoriteAlbumTargets(), planners: getFavoritePlannerTargets() };
          case "paste": {
            let saved;
            for (let attempt = 0; attempt < 4; attempt += 1) {
              saved = await invoke("tauri_save_clipboard_frame", { previousSequence: null });
              if (saved?.reason !== "clipboard_busy") break;
              if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150));
            }
            if (saved?.reason === "clipboard_busy") throw new Error("剪贴板暂时被其他程序占用，请稍后粘贴");
            if (!saved?.saved || !saved.path) throw new Error("剪贴板中没有图片，请先复制图片后粘贴");
            store.add({ ...saved, title: "粘贴图片", savedAt: Date.now() });
            await changed();
            return { message: "已加入收藏" };
          }
          case "remove": {
            undo = store.remove(ids);
            await changed();
            return { message: `已移除${undo.length}张收藏，原文件保留`, undoAvailable: undo.length > 0 };
          }
          case "undo": {
            store.restore(undo); undo = [];
            await changed();
            return { message: "已恢复收藏" };
          }
          case "insert": {
            if (!ids.length) throw new Error("请先选择图片");
            const entries = ids.map((id) => store.get(id));
            let result;
            if (request.targetType === "album") result = insertFavoritesIntoAlbum(entries, request.targetId);
            else if (request.targetType === "planner") result = insertFavoritesIntoPlanner(entries, request.targetId);
            else throw new Error("请选择相册或策划");
            return { message: `已加入${result.added}张，已存在${result.skipped}张` };
          }
          default: throw new Error("不支持的收藏操作");
        }
      }).then((data) => ({ ok: true, data }), (error) => ({ ok: false, error: error.message || String(error) }));
      completed.set(request.requestId, operation);
      if (completed.size > 100) completed.delete(completed.keys().next().value);
      response = await operation;
    }
    await invoke("tauri_favorites_response", { response: { requestId: request.requestId, ...response } }).catch(console.warn);
  }).catch(console.warn);
}
