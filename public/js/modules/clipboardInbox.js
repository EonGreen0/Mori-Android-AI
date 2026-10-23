// clipboardInbox.js — Windows clipboard-history powered batch link inbox
import { t } from "../i18n/index.js";
import { showToast, cleanUrl } from "../utils/index.js";
import { analyzeUrlSilent } from "./batchManager.js";
import {
  batchToggleBtn,
  batchUrlInput,
  downloadBtn,
  isBatchMode,
} from "./core.js";

const INBOX_KEY = "mori_batch_link_inbox";
const MAX_ITEMS = 80;
const ANALYSIS_TTL = 24 * 60 * 60 * 1000;
const ANALYSIS_RESULT_CACHE_TTL = 5 * 60 * 1000;
let isResolvingTitles = false;
window._moriBatchAnalysisCache = window._moriBatchAnalysisCache || new Map();

const inboxPanel = document.getElementById("batchInboxPanel");
const inboxList = document.getElementById("batchInboxList");
const inboxEmpty = document.getElementById("batchInboxEmpty");
const inboxMeta = document.getElementById("batchInboxMeta");
const inboxNotice = document.getElementById("batchInboxNotice");
const refreshBtn = document.getElementById("batchRefreshHistoryBtn");
const selectAllBtn = document.getElementById("batchSelectAllBtn");
const clearBtn = document.getElementById("batchClearInboxBtn");
const exitBtn = document.getElementById("batchExitBtn");
const manualInput = document.getElementById("batchManualInput");
const manualAddBtn = document.getElementById("batchAddManualBtn");

function loadInbox() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INBOX_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.url === "string")
      .slice(0, MAX_ITEMS);
  } catch (_) {
    return [];
  }
}

function saveInbox(items) {
  localStorage.setItem(INBOX_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

function normalizeUrl(raw) {
  let value = String(raw || "")
    .trim()
    .replace(/[\]\[(){}<>，。；、!！?？'"`]+$/g, "")
    .replace(/[.,;:]+$/g, "");
  if (!/^https?:\/\//i.test(value)) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch (_) {
    return "";
  }
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const seen = new Set();
  const output = [];
  matches.forEach((raw) => {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    output.push(url);
  });
  return output;
}

function decodeTitle(value) {
  const el = document.createElement("textarea");
  el.innerHTML = String(value || "");
  return el.value.replace(/\s+/g, " ").trim();
}

function titleFingerprint(title, author = "") {
  const cleanTitle = String(title || "")
    .toLowerCase()
    .replace(/#[^\s#]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  const cleanAuthor = String(author || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  if (cleanTitle.length < 6) return "";
  return `${cleanTitle}|${cleanAuthor}`;
}

function contentIdentity(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/$/, "");

    if (host.includes("xiaohongshu.com") || host.includes("rednote.com")) {
      const match = path.match(/\/(?:discovery\/item|explore)\/([a-zA-Z0-9]+)/i);
      if (match) return `rednote:${match[1]}`;
    }
    if (host.includes("instagram.com") || host.includes("instagr.am")) {
      const match = path.match(/\/(?:p|reel|tv)\/([^/]+)/i);
      if (match) return `instagram:${match[1]}`;
    }
    if (host.includes("tiktok.com")) {
      const match = path.match(/\/video\/(\d+)/i);
      if (match) return `tiktok:${match[1]}`;
    }
    if (host.includes("douyin.com")) {
      const match = path.match(/\/(?:video|note)\/(\d+)/i);
      if (match) return `douyin:${match[1]}`;
    }
    if (host.includes("youtube.com")) {
      const videoId = parsed.searchParams.get("v");
      if (videoId) return `youtube:${videoId}`;
    }
    if (host.includes("youtu.be")) {
      const id = path.split("/").filter(Boolean)[0];
      if (id) return `youtube:${id}`;
    }
    if (host.includes("pinterest.com")) {
      const match = path.match(/\/pin\/(\d+)/i);
      if (match) return `pinterest:${match[1]}`;
    }
    if (host.includes("bilibili.com")) {
      const match = path.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
      if (match) return `bilibili:${match[1].toLowerCase()}`;
    }
    return cleanUrl(url);
  } catch (_) {
    return cleanUrl(url);
  }
}

function domainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "link";
  }
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const tail = `${parsed.pathname}${parsed.search}`;
    return tail.length > 78 ? `${tail.slice(0, 75)}…` : tail || parsed.hostname;
  } catch (_) {
    return url.length > 82 ? `${url.slice(0, 79)}…` : url;
  }
}

function selectedItems(items = loadInbox()) {
  return items.filter((item) => item.selected !== false);
}

function syncHiddenBatchInput(items = loadInbox()) {
  const selected = selectedItems(items);
  if (batchUrlInput) {
    batchUrlInput.value = selected.map((item) => item.url).join("\n");
    batchUrlInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (inboxMeta) {
    inboxMeta.textContent = t("batch-selected-count", {
      selected: selected.length,
      total: items.length,
    });
  }
  if (isBatchMode && downloadBtn) {
    downloadBtn.disabled = selected.length === 0;
  }
}

function setNotice(message = "", kind = "info") {
  if (!inboxNotice) return;
  inboxNotice.textContent = message;
  inboxNotice.dataset.kind = kind;
  inboxNotice.classList.toggle("hidden", !message);
}

function renderInbox() {
  if (!inboxList) return;
  const items = loadInbox();
  inboxList.innerHTML = "";
  inboxEmpty?.classList.toggle("hidden", items.length > 0);

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `batch-inbox-item ${item.selected === false ? "" : "is-selected"}`;
    row.dataset.url = item.url;

    const check = document.createElement("button");
    check.type = "button";
    check.className = "batch-inbox-check";
    check.setAttribute("aria-pressed", String(item.selected !== false));
    check.setAttribute("aria-label", `${domainLabel(item.url)} ${index + 1}`);
    check.textContent = item.selected === false ? "" : "✓";

    const copy = document.createElement("div");
    copy.className = "batch-inbox-copy";
    const title = document.createElement("strong");
    title.textContent =
      item.analysisState === "loading"
        ? t("batch-title-resolving")
        : item.title || domainLabel(item.url);
    const detail = document.createElement("span");
    detail.textContent = item.title
      ? `${domainLabel(item.url)} · ${shortUrl(item.url)}`
      : shortUrl(item.url);
    detail.title = item.url;
    copy.append(title, detail);

    if (item.analysisState && item.analysisState !== "idle") {
      const badge = document.createElement("small");
      badge.className = `batch-inbox-analysis-badge ${item.analysisState}`;
      if (item.analysisState === "duplicate") {
        badge.textContent = t("batch-title-duplicate");
      } else if (item.analysisState === "invalid") {
        badge.textContent = t("batch-title-invalid");
      } else if (item.analysisState === "ready") {
        badge.textContent = t("batch-title-ready");
      } else if (item.analysisState === "loading") {
        badge.textContent = t("batch-title-resolving");
      }
      copy.appendChild(badge);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "batch-inbox-remove";
    remove.setAttribute("aria-label", "Remove");
    remove.textContent = "×";

    const toggle = () => {
      const next = loadInbox();
      const target = next.find((entry) => entry.url === item.url);
      if (!target) return;
      target.selected = target.selected === false;
      saveInbox(next);
      renderInbox();
    };

    check.addEventListener("click", toggle);
    copy.addEventListener("click", toggle);
    remove.addEventListener("click", () => {
      const next = loadInbox().filter((entry) => entry.url !== item.url);
      saveInbox(next);
      renderInbox();
    });

    row.append(check, copy, remove);
    inboxList.appendChild(row);
  });

  syncHiddenBatchInput(items);
}

async function resolveInboxTitles({ force = false } = {}) {
  if (isResolvingTitles) return;
  const initial = loadInbox();
  const pending = initial.filter(
    (item) =>
      force ||
      !item.analyzedAt ||
      Date.now() - item.analyzedAt > ANALYSIS_TTL ||
      (item.analysisState !== "invalid" && !item.title),
  );
  if (pending.length === 0) return;

  isResolvingTitles = true;
  const preferServer = localStorage.getItem("mori_prefer_server") || "auto";
  const queue = [...pending];

  const worker = async () => {
    while (queue.length > 0) {
      const nextItem = queue.shift();
      if (!nextItem) break;

      let items = loadInbox();
      let target = items.find((entry) => entry.url === nextItem.url);
      if (!target) continue;
      target.analysisState = "loading";
      saveInbox(items);
      renderInbox();

      const data = await analyzeUrlSilent(nextItem.url, preferServer);
      window._moriBatchAnalysisCache.set(nextItem.url, {
        data,
        timestamp: Date.now(),
        ttl: ANALYSIS_RESULT_CACHE_TTL,
      });
      items = loadInbox();
      target = items.find((entry) => entry.url === nextItem.url);
      if (!target) continue;

      target.analyzedAt = Date.now();
      if (data?.status && data.result) {
        target.title = decodeTitle(data.result.title || "Media");
        target.author = decodeTitle(data.result.author || "");
        target.canonicalUrl = cleanUrl(data.result.sourceUrl || nextItem.url);
        target.contentKey = contentIdentity(target.canonicalUrl || nextItem.url);
        target.fingerprint = titleFingerprint(target.title, target.author);
        target.analysisState = "ready";
        target.analysisError = "";
      } else {
        target.analysisState = "invalid";
        target.analysisError = data?.message || "Unsupported or unavailable link";
        target.selected = false;
      }
      saveInbox(items);
      renderInbox();
    }
  };

  await Promise.all([worker(), worker()]);

  const resolved = loadInbox();
  const seenContent = new Map();
  resolved.forEach((item) => {
    if (item.analysisState !== "ready") return;
    const contentKey = item.contentKey || contentIdentity(item.canonicalUrl || item.url);
    const duplicateOf = contentKey ? seenContent.get(contentKey) || "" : "";

    if (duplicateOf) {
      item.analysisState = "duplicate";
      item.duplicateOf = duplicateOf;
      item.selected = false;
    } else {
      item.duplicateOf = "";
      if (contentKey) seenContent.set(contentKey, item.url);
    }
  });
  saveInbox(resolved);
  renderInbox();
  isResolvingTitles = false;

  // Clipboard-history import and title resolution may overlap. If new links
  // arrived while the workers were busy, immediately consume that second wave.
  const hasNewPending = loadInbox().some(
    (item) =>
      !item.analyzedAt ||
      (item.analysisState !== "invalid" && !item.title),
  );
  if (hasNewPending) queueMicrotask(() => resolveInboxTitles());
}

function mergeUrls(urls, source = "clipboard") {
  const unique = [];
  const seen = new Set();
  urls.forEach((raw) => {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    unique.push(url);
  });
  if (unique.length === 0) return 0;

  const existing = loadInbox();
  const existingMap = new Map(existing.map((item) => [item.url, item]));
  const now = Date.now();
  const imported = unique.map((url, index) => {
    const previous = existingMap.get(url);
    existingMap.delete(url);
    return {
      url,
      selected: true,
      source: source || previous?.source || "clipboard",
      addedAt: previous?.addedAt || now - index,
      lastSeenAt: now - index,
      title: previous?.title || "",
      author: previous?.author || "",
      canonicalUrl: previous?.canonicalUrl || "",
      fingerprint: previous?.fingerprint || "",
      contentKey: previous?.contentKey || "",
      analyzedAt: previous?.analyzedAt || 0,
      analysisState: previous?.analysisState || "idle",
      analysisError: previous?.analysisError || "",
    };
  });
  const untouched = existing.filter((item) => existingMap.has(item.url));
  saveInbox([...imported, ...untouched].slice(0, MAX_ITEMS));
  renderInbox();
  return unique.length;
}

async function readCurrentClipboardFallback() {
  try {
    const text = await navigator.clipboard?.readText?.();
    return extractUrls(text);
  } catch (_) {
    return [];
  }
}

export async function refreshClipboardHistory({ silent = false } = {}) {
  if (!refreshBtn || refreshBtn.disabled) return;
  refreshBtn.disabled = true;
  refreshBtn.classList.add("is-loading");
  setNotice("");

  try {
    const tauriInvoke =
      window.__TAURI__?.core?.invoke ||
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.invoke;

    let urls = [];
    let status = "unsupported";
    let enabled = false;

    if (tauriInvoke) {
      try {
        const result = await tauriInvoke("tauri_get_clipboard_history");
        status = result?.status || "unavailable";
        enabled = result?.enabled === true;
        (result?.items || []).forEach((item) => {
          urls.push(...extractUrls(item?.text || ""));
        });
      } catch (err) {
        console.warn("Clipboard history bridge failed:", err);
        status = "unavailable";
      }
    }

    if (urls.length === 0) {
      urls = await readCurrentClipboardFallback();
    }

    const count = mergeUrls(urls, status === "success" ? "history" : "clipboard");
    if (count > 0) resolveInboxTitles();

    if (status === "disabled" || (!enabled && status === "disabled")) {
      const message = t("toast-batch-history-disabled");
      setNotice(message, "warning");
      if (!silent) showToast(message);
    } else if (status !== "success" && count === 0) {
      const message = t("toast-batch-history-unavailable");
      setNotice(message, "warning");
      if (!silent) showToast(message);
    } else if (count > 0) {
      const message = t("toast-batch-history-loaded", { count });
      setNotice(message, "success");
      if (!silent) showToast(message);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove("is-loading");
  }
}

selectAllBtn?.addEventListener("click", () => {
  const items = loadInbox();
  const shouldSelect = items.some((item) => item.selected === false);
  items.forEach((item) => {
    item.selected = shouldSelect;
  });
  saveInbox(items);
  renderInbox();
});

clearBtn?.addEventListener("click", () => {
  saveInbox([]);
  setNotice("");
  renderInbox();
});

refreshBtn?.addEventListener("click", () => refreshClipboardHistory());

exitBtn?.addEventListener("click", () => batchToggleBtn?.click());

manualAddBtn?.addEventListener("click", () => {
  const urls = extractUrls(manualInput?.value || "");
  if (urls.length === 0) {
    showToast(t("toast-no-batch-urls"));
    return;
  }
  mergeUrls(urls, "manual");
  resolveInboxTitles();
  if (manualInput) manualInput.value = "";
});

manualInput?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    manualAddBtn?.click();
  }
});

window.addEventListener("mori_batch_mode_opened", () => {
  renderInbox();
  resolveInboxTitles();
  refreshClipboardHistory({ silent: true });
});

window.addEventListener("mori_batch_completed", () => {
  const items = loadInbox();
  items.forEach((item) => {
    if (item.selected !== false) item.selected = false;
  });
  saveInbox(items);
  renderInbox();
});

renderInbox();

export function getSelectedBatchUrls() {
  return selectedItems().map((item) => item.url);
}
