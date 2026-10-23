const STORAGE_KEY = "mori_favorites_v1";
const fileKey = (entry) => String(entry?.path || entry?.uri || "").replace(/\\/g, "/").toLowerCase();

// Only the main window owns this store. The floating window sends requests.
export function createFavoritesStore(storage, options = {}) {
  const now = options.now || Date.now;
  const makeId = options.makeId || (() => crypto.randomUUID());
  const load = () => {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { version: 1, items: [], legacyImported: false };
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Array.isArray(state.items)) throw new Error("收藏记录无法读取，原记录已保留");
    return state;
  };
  const save = (state) => storage.setItem(STORAGE_KEY, JSON.stringify(state));
  const normalize = (entry) => {
    if (!fileKey(entry)) throw new Error("图片缺少本地文件");
    return {
      id: String(entry.id || makeId()), path: String(entry.path || entry.uri),
      uri: String(entry.uri || entry.path), title: String(entry.title || "收藏图片").slice(0, 128),
      savedAt: Number(entry.savedAt) > 0 ? Number(entry.savedAt) : now(),
      sourceUrl: String(entry.sourceUrl || ""),
    };
  };
  return {
    list() { return load().items.slice().sort((a, b) => b.savedAt - a.savedAt); },
    migrate(history) {
      const state = load();
      if (state.legacyImported) return;
      const known = new Set(state.items.map(fileKey));
      for (const item of history) {
        for (const file of item.localFiles || []) {
          if (!(file.type === "FRAME" || file.isReferenceFrame) || !fileKey(file) || known.has(fileKey(file))) continue;
          state.items.push(normalize({ ...file, title: file.title || item.title, savedAt: file.savedAt || item.timestamp, sourceUrl: item.sourceUrl || item.url }));
          known.add(fileKey(file));
        }
      }
      state.legacyImported = true;
      save(state);
    },
    add(entry) {
      const state = load();
      const existing = state.items.find((item) => fileKey(item) === fileKey(entry));
      if (existing) return existing;
      const item = normalize(entry);
      state.items.unshift(item);
      save(state);
      return item;
    },
    get(id) {
      const item = load().items.find((item) => item.id === id);
      if (!item) throw new Error("这张图片已移出收藏");
      return item;
    },
    remove(ids) {
      const state = load();
      const selected = new Set(ids);
      const removed = state.items.filter((item) => selected.has(item.id));
      state.items = state.items.filter((item) => !selected.has(item.id));
      save(state);
      return removed;
    },
    restore(entries) {
      const state = load();
      const known = new Set(state.items.map(fileKey));
      for (const entry of entries) {
        if (!known.has(fileKey(entry))) { state.items.push(normalize(entry)); known.add(fileKey(entry)); }
      }
      save(state);
    },
  };
}

export function groupFavoritesByDate(items) {
  const groups = new Map();
  for (const item of items) {
    const date = new Date(item.savedAt);
    const key = Number.isNaN(date.getTime()) ? "更早" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, entries]) => ({ date, entries: entries.sort((a, b) => b.savedAt - a.savedAt) }));
}

export function collectFavoriteFrame(entry) {
  const store = createFavoritesStore(localStorage);
  const history = JSON.parse(localStorage.getItem("mori_history") || "[]");
  if (!Array.isArray(history)) throw new Error("原收藏记录无法读取，未改动原记录");
  store.migrate(history);
  return store.add(entry);
}
