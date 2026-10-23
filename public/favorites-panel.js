import { groupFavoritesByDate } from "./js/modules/favoritesStore.js";

export function initFavoritesPanel(invoke) {
  const element = (id) => document.getElementById(id);
  const gallery = element("favoriteGallery");
  const selected = new Set();
  const urls = new Map();
  const pending = new Map();
  const openDates = new Set();
  let expanded = false, resizing = false, busy = false, dirty = false, revision = 0, initializedDates = false;
  let items = [];
  let observer;
  const status = (text, error = false) => {
    element("favoritesStatus").textContent = text;
    element("favoritesStatus").dataset.error = String(error);
  };
  const ready = Promise.all([
    window.__TAURI__?.event?.listen("mori-favorites-response", ({ payload }) => {
      const waiting = pending.get(payload?.requestId);
      if (!waiting) return;
      clearTimeout(waiting.timer); pending.delete(payload.requestId);
      payload.ok ? waiting.resolve(payload.data) : waiting.reject(new Error(payload.error || "操作失败"));
    }),
    window.__TAURI__?.event?.listen("mori-favorites-changed", () => {
      if (!expanded) return;
      if (busy) dirty = true;
      else reload().catch((error) => status(error.message, true));
    }),
  ]);
  ready.catch((error) => status(error.message, true));
  async function request(action, data = {}) {
    await ready;
    if (!window.__TAURI__?.event?.listen) throw new Error("请在Mori桌面版打开收藏夹");
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("主窗口未响应，请保持Mori主窗口打开后刷新")); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      invoke("tauri_favorites_request", { request: { requestId, action, ...data } }).catch((error) => {
        clearTimeout(timer); pending.delete(requestId); reject(error);
      });
    });
  }
  function updateSelection() {
    element("selectionCount").textContent = selected.size ? `已选 ${selected.size} 张` : "选择图片";
    element("clearSelection").disabled = busy || !selected.size;
    element("removeFavorites").disabled = busy || !selected.size;
    element("insertFavorites").disabled = busy || !selected.size || !element("favoriteTarget").value;
    element("pasteImage").disabled = busy;
    element("refreshFavorites").disabled = busy;
    element("undoRemove").disabled = busy;
    gallery.querySelectorAll("input").forEach((input) => { input.checked = selected.has(input.value); input.disabled = busy; });
  }
  async function loadPreview(image, entry, token) {
    if (urls.has(entry.id)) { image.src = urls.get(entry.id); return; }
    try {
      const bytes = await invoke("tauri_read_file_bytes", { path: entry.path || entry.uri });
      if (token !== revision || !expanded) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      let preview = blob;
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        preview = await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", .85)) || blob;
      }
      if (token !== revision || !expanded) return;
      const url = URL.createObjectURL(preview);
      const previous = urls.get(entry.id); if (previous) URL.revokeObjectURL(previous);
      urls.set(entry.id, url); image.src = url;
    } catch { if (token === revision) image.parentElement?.classList.add("unavailable"); }
  }
  function render() {
    observer?.disconnect(); gallery.replaceChildren();
    const token = revision;
    const valid = new Set(items.map((item) => item.id));
    for (const id of selected) if (!valid.has(id)) selected.delete(id);
    for (const [id, url] of urls) if (!valid.has(id)) { URL.revokeObjectURL(url); urls.delete(id); }
    element("favoriteCount").textContent = items.length;
    if (!items.length) {
      const empty = document.createElement("p"); empty.className = "empty-favorites";
      empty.textContent = "还没有收藏图片。\n点击收藏帧截图，或复制图片后粘贴。"; gallery.append(empty);
    }
    const groups = groupFavoritesByDate(items);
    const today = groupFavoritesByDate([{ savedAt: Date.now() }])[0].date;
    if (!initializedDates && groups.length) { openDates.add(groups.some((group) => group.date === today) ? today : groups[0].date); initializedDates = true; }
    observer = new IntersectionObserver((observed) => {
      for (const item of observed) if (item.isIntersecting) {
        observer.unobserve(item.target);
        const entry = items.find((entry) => entry.id === item.target.dataset.id);
        if (entry) loadPreview(item.target, entry, token);
      }
    }, { root: gallery, rootMargin: "80px" });
    for (const group of groups) {
      const section = document.createElement("details"); section.className = "date-group"; section.open = openDates.has(group.date);
      const summary = document.createElement("summary"); summary.textContent = group.date === today ? "今天" : group.date;
      const count = document.createElement("span"); count.textContent = `${group.entries.length} 张`; summary.append(count);
      const grid = document.createElement("div"); grid.className = "date-grid";
      section.addEventListener("toggle", () => { if (section.isConnected) section.open ? openDates.add(group.date) : openDates.delete(group.date); });
      for (const entry of group.entries) {
        const card = document.createElement("label"); card.className = "favorite-card";
        const image = document.createElement("img"); image.alt = entry.title; image.dataset.id = entry.id;
        image.addEventListener("error", () => card.classList.add("unavailable"));
        const input = document.createElement("input"); input.type = "checkbox"; input.value = entry.id; input.setAttribute("aria-label", `选择${entry.title}`);
        input.addEventListener("change", () => { input.checked ? selected.add(entry.id) : selected.delete(entry.id); updateSelection(); });
        const title = document.createElement("span"); title.className = "card-title"; title.textContent = entry.title; title.title = entry.title;
        card.append(image, input, title); grid.append(card); observer.observe(image);
      }
      section.append(summary, grid); gallery.append(section);
    }
    updateSelection();
  }
  async function reload() {
    const token = ++revision;
    const data = await request("list");
    if (token !== revision || !expanded) return;
    items = data.items;
    const target = element("favoriteTarget"); const previous = target.value; target.replaceChildren();
    for (const [type, label, collection] of [["album", "相册", data.albums], ["planner", "策划", data.planners]]) {
      const group = document.createElement("optgroup"); group.label = label;
      for (const item of collection.items) { const option = document.createElement("option"); option.value = `${type}:${item.id}`; option.textContent = item.name; group.append(option); }
      target.append(group);
    }
    if ([...target.options].some((option) => option.value === previous)) target.value = previous;
    else if (data.albums.activeId) target.value = `album:${data.albums.activeId}`;
    render();
  }
  async function operate(action, data = {}) {
    if (busy) return;
    busy = true; updateSelection();
    try {
      const result = await request(action, data);
      status(result.message);
      if (action === "remove") { selected.clear(); element("undoRemove").hidden = !result.undoAvailable; }
      if (action === "undo") element("undoRemove").hidden = true;
      if (expanded) await reload();
      dirty = false;
    } catch (error) { status(error.message || String(error), true); }
    finally {
      busy = false; updateSelection();
      if (dirty && expanded) { dirty = false; reload().catch((error) => status(error.message, true)); }
    }
  }
  async function setExpanded(value) {
    if (resizing || value === expanded) return;
    resizing = true;
    try {
      await invoke("tauri_expand_frame_floater", { expanded: value });
      expanded = value; document.body.classList.toggle("expanded", value); element("favoritesPanel").hidden = !value;
      document.querySelector(".drag").setAttribute("aria-expanded", String(value));
      if (value) { status("正在读取收藏…"); await reload(); status("选择图片后可加入相册或策划"); }
      else { revision += 1; observer?.disconnect(); for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); gallery.replaceChildren(); }
    } catch (error) { status(error.message || String(error), true); }
    finally { resizing = false; }
  }
  element("closePanel").addEventListener("click", () => setExpanded(false));
  element("pasteImage").addEventListener("click", () => operate("paste"));
  element("refreshFavorites").addEventListener("click", () => reload().catch((error) => status(error.message, true)));
  element("clearSelection").addEventListener("click", () => { selected.clear(); updateSelection(); });
  element("removeFavorites").addEventListener("click", () => operate("remove", { ids: [...selected] }));
  element("undoRemove").addEventListener("click", () => operate("undo"));
  element("favoriteTarget").addEventListener("change", updateSelection);
  element("insertFavorites").addEventListener("click", () => {
    const value = element("favoriteTarget").value; const colon = value.indexOf(":");
    operate("insert", { ids: [...selected], targetType: value.slice(0, colon), targetId: value.slice(colon + 1) });
  });
  document.addEventListener("paste", (event) => { if (expanded) { event.preventDefault(); operate("paste"); } });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && expanded) setExpanded(false); });
  updateSelection();
  return { toggle: () => setExpanded(!expanded) };
}
