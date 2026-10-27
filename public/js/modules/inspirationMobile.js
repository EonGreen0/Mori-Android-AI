// Android album presentation. Existing album and Planner identities stay in inspiration.js.
import { t } from "../i18n/index.js";
import { showToast } from "../utils/index.js";
import {
  finishAiAnalysisProgress,
  isAiAnalysisProgressActive,
  startAiAnalysisProgress,
} from "./aiProgress.js";

let callbacks;
let overview = true;
let view = "groups";
let mounted = false;
let previewFiles = [];
let previewIndex = 0;
let returnFocus = null;
let previewGroup = null;
let previewTransitioning = false;
let previewAnalyzing = false;

export const isMobileInspiration = () => window.Capacitor?.getPlatform?.() === "android";
export const isMobileAlbumOverview = () => isMobileInspiration() && overview;
export const isMobileAlbumCanvas = () => isMobileInspiration() && !overview && view === "canvas";

function icon(name) {
  return `<span class="album-icon" aria-hidden="true" style="--album-icon: url('/icons/material/${name}.svg')"></span>`;
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog || dialog.classList.contains("hidden")) return false;
  dialog.classList.add("hidden");
  returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
  return true;
}

function openDialog(id, focus) {
  returnFocus = document.activeElement;
  const dialog = document.getElementById(id);
  dialog.classList.remove("hidden");
  dialog.querySelector(focus)?.focus({ preventScroll: true });
}

export function initMobileInspiration(options) {
  if (!isMobileInspiration() || mounted) return;
  mounted = true;
  callbacks = options;
  try { view = localStorage.getItem("mori_mobile_album_view") === "canvas" ? "canvas" : "groups"; } catch (_) {}
  const page = document.getElementById("inspirationPage");
  const header = document.createElement("div");
  header.id = "albumMobileHeader";
  header.innerHTML = `
    <div class="album-mobile-topbar">
      <button id="albumMobileBack" class="album-icon-button" type="button" aria-label="${t("album-back")}">${icon("arrow_back")}</button>
      <h2 id="albumMobileTitle">${t("planner-library-mode")}</h2>
      <button id="albumMobileNew" class="album-icon-button" type="button" aria-label="${t("inspiration-new-album")}">${icon("add")}</button>
      <button id="albumMobileMore" class="album-icon-button" type="button" aria-label="${t("album-options")}" aria-haspopup="dialog">${icon("more_horiz")}</button>
    </div>
    <div id="albumMobileNavigation" class="album-mobile-navigation">
      <div id="albumMobileModes"></div>
      <div class="album-view-switch" role="group" aria-label="${t("album-view")}">
        <button type="button" data-album-view="groups">${t("album-groups")}</button>
        <button type="button" data-album-view="canvas">${t("album-canvas")}</button>
      </div>
    </div>
    <div id="albumMobileAiCategories" class="album-ai-categories hidden"></div>`;
  page.prepend(header);
  header.querySelector("#albumMobileModes").appendChild(page.querySelector(".inspiration-mode-switch"));
  document.getElementById("inspirationLibraryModeBtn").textContent = t("planner-library-mode");
  document.getElementById("inspirationPlannerModeBtn").textContent = t("planner-plan-mode");
  const covers = document.createElement("section");
  covers.id = "albumMobileOverview";
  covers.innerHTML = `<div class="album-overview-heading"><h3>${t("album-recent")}</h3><span id="albumMobileCount"></span></div><div id="albumMobileShortcuts" class="album-shortcuts"></div><div id="albumMobileCovers" class="album-cover-grid"></div>`;
  header.after(covers);
  const floating = document.createElement("div");
  floating.id = "albumMobileZoom";
  floating.innerHTML = `<span id="albumMobileZoomLabel">70%</span><button type="button" class="album-icon-button" aria-label="${t("planner-fit-all")}">${icon("crop_free")}</button>`;
  document.getElementById("inspirationViewport").appendChild(floating);
  floating.querySelector("button").addEventListener("click", options.fitCanvas);
  const menu = document.createElement("div");
  menu.id = "albumMobileMenu";
  menu.className = "modal-overlay album-mobile-dialog hidden";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-modal", "true");
  menu.setAttribute("aria-labelledby", "albumMobileMenuTitle");
  menu.innerHTML = `<div class="album-menu-sheet"><div class="album-dialog-heading"><h3 id="albumMobileMenuTitle">${t("album-options")}</h3><button type="button" class="album-icon-button" aria-label="${t("album-close")}">${icon("close")}</button></div><div id="albumMobileActions"></div><details class="album-sync-details"><summary>${t("album-sync-options")}</summary><div id="albumMobileSync"></div></details></div>`;
  document.body.appendChild(menu);
  for (const id of ["inspirationNewAlbumBtn", "inspirationSaveTodayBtn"]) {
    menu.querySelector("#albumMobileActions").appendChild(document.getElementById(id));
  }
  const aiControls = document.getElementById("albumAiControls");
  if (aiControls) menu.querySelector(".album-sync-details").before(aiControls);
  menu.querySelector(".album-sync-details").before(document.getElementById("albumPackageControls"));
  // Move the existing controls, including dynamically added recovery buttons. Never clone their IDs or handlers.
  menu.querySelector("#albumMobileSync").appendChild(document.getElementById("albumCloudControls"));
  const organize = document.createElement("details");
  organize.id = "albumMobileOrganize";
  organize.className = "album-sync-details";
  organize.innerHTML = `<summary>${t("album-organize")}</summary><div id="albumMobileGroupTools"></div>`;
  menu.querySelector(".album-sync-details").before(organize);
  organize.addEventListener("toggle", () => {
    if (organize.open) options.renderGroupTools(document.getElementById("albumMobileGroupTools"));
  });
  menu.querySelector(".album-dialog-heading button").addEventListener("click", () => closeDialog(menu.id));
  menu.addEventListener("click", event => { if (event.target === menu) closeDialog(menu.id); });
  menu.querySelector("#albumMobileActions").addEventListener("click", () => closeDialog(menu.id));
  menu.querySelector("#albumMobileSync").addEventListener("click", event => {
    if (event.target.closest("#albumCloudRebuildBtn")) closeDialog(menu.id);
  });
  header.querySelector("#albumMobileBack").addEventListener("click", () => handleMobileInspirationBack());
  header.querySelector("#albumMobileNew").addEventListener("click", () => document.getElementById("inspirationNewAlbumBtn").click());
  header.querySelector("#albumMobileMore").addEventListener("click", () => {
    if (organize.open) options.renderGroupTools(document.getElementById("albumMobileGroupTools"));
    openDialog(menu.id, ".album-dialog-heading button");
  });
  header.querySelectorAll("[data-album-view]").forEach(button => button.addEventListener("click", () => {
    view = button.dataset.albumView;
    try { localStorage.setItem("mori_mobile_album_view", view); } catch (_) {}
    options.render();
  }));
  const preview = document.createElement("div");
  preview.id = "albumMobilePreview";
  preview.className = "modal-overlay album-photo-preview hidden";
  preview.setAttribute("role", "dialog");
  preview.setAttribute("aria-modal", "true");
  preview.setAttribute("aria-label", t("album-preview"));
  preview.innerHTML = `<button type="button" class="album-preview-close album-icon-button" aria-label="${t("album-close")}">${icon("close")}</button><div class="album-preview-image"><img alt="" /></div><button type="button" id="albumPreviewAiToggle" class="album-preview-ai-toggle hidden">${t("ai-swipe-up")}</button><div class="album-preview-footer"><div class="album-preview-pagination"><button type="button" class="album-icon-button" data-photo-step="-1" aria-label="${t("album-previous")}">${icon("chevron_left")}</button><span id="albumPreviewCount" aria-live="polite"></span><button type="button" class="album-icon-button" data-photo-step="1" aria-label="${t("album-next")}">${icon("chevron_right")}</button></div><div class="album-preview-actions"><button type="button" id="albumPreviewSource">${t("inspiration-open-source")}${icon("open_in_new")}</button><button type="button" id="albumPreviewAiIdentify"><span aria-hidden="true">✦</span><span class="album-preview-ai-identify-label">${t("ai-identify-image")}</span></button></div></div><section id="albumPreviewAiSheet" class="album-preview-ai-sheet hidden" aria-label="${t("ai-result-title")}"><button type="button" class="album-preview-ai-sheet-handle" aria-label="${t("ai-sheet-close-handle")}"><span></span></button><div class="album-preview-ai-sheet-body"></div></section>`;
  document.body.appendChild(preview);
  preview.querySelector(".album-preview-close").addEventListener("click", () => closeDialog(preview.id));
  preview.querySelectorAll("[data-photo-step]").forEach(button => button.addEventListener("click", () => {
    changePreview(Number(button.dataset.photoStep));
  }));
  preview.querySelector("#albumPreviewSource").addEventListener("click", () => callbacks.openSource(previewGroup.item.sourceUrl || previewGroup.item.url));
  const setAiSheetOpen = (open) => {
    const sheet = preview.querySelector("#albumPreviewAiSheet");
    const toggle = preview.querySelector("#albumPreviewAiToggle");
    if (toggle.classList.contains("hidden")) return;
    sheet.style.transition = "";
    sheet.style.transform = "";
    sheet.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  preview.querySelector("#albumPreviewAiToggle").addEventListener("click", () => setAiSheetOpen(true));
  preview.querySelector("#albumPreviewAiIdentify").addEventListener("click", async () => {
    const file = previewFiles[previewIndex];
    const existing = callbacks.getAiAnalysis?.(file);
    if (existing) {
      setAiSheetOpen(true);
      return;
    }
    const button = preview.querySelector("#albumPreviewAiIdentify");
    if (button.disabled) return;
    previewAnalyzing = true;
    button.disabled = true;
    button.classList.add("is-busy");
    button.querySelector(".album-preview-ai-identify-label").textContent = t("ai-identifying-image");
    const ownsProgress = !isAiAnalysisProgressActive();
    let completed = false;
    if (ownsProgress) startAiAnalysisProgress({ total: 1 });
    try {
      const { ensureAiImageAnalysisResult } = await import("./aiOrganizer.js");
      const result = await ensureAiImageAnalysisResult(file);
      if (ownsProgress) {
        finishAiAnalysisProgress("complete", { count: 1, total: 1 });
      }
      completed = true;
      showToast(t(result.cached ? "ai-single-image-reused" : "ai-single-image-complete"));
    } catch (error) {
      if (ownsProgress) {
        finishAiAnalysisProgress("failed", {
          count: 0,
          total: 1,
          detail: String(error?.message || error),
        });
      }
      showToast(`${t("ai-analysis-failed")}：${String(error?.message || error)}`);
    } finally {
      previewAnalyzing = false;
      button.disabled = false;
      button.classList.remove("is-busy");
      if (!document.getElementById("albumMobilePreview")?.classList.contains("hidden")) {
        renderPreview();
        if (completed) setAiSheetOpen(true);
      }
    }
  });
  const handle = preview.querySelector(".album-preview-ai-sheet-handle");
  let handleDrag = null;
  handle.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    handleDrag = {
      y: event.touches[0].clientY,
      sheet: preview.querySelector("#albumPreviewAiSheet"),
    };
    handleDrag.sheet.style.transition = "none";
  }, { passive: true });
  handle.addEventListener("touchmove", event => {
    if (!handleDrag || event.touches.length !== 1) return;
    const distance = Math.max(0, event.touches[0].clientY - handleDrag.y);
    handleDrag.distance = distance;
    handleDrag.sheet.style.transform = `translateY(${distance}px)`;
    if (distance > 0) event.preventDefault();
  }, { passive: false });
  handle.addEventListener("touchend", () => {
    if (!handleDrag) return;
    const shouldClose = Number(handleDrag.distance) > 64;
    const sheet = handleDrag.sheet;
    handleDrag = null;
    if (shouldClose) {
      setAiSheetOpen(false);
      return;
    }
    sheet.style.transition = "transform .2s ease";
    sheet.style.transform = "";
  }, { passive: true });
  handle.addEventListener("touchcancel", () => {
    if (!handleDrag) return;
    handleDrag.sheet.style.transition = "transform .2s ease";
    handleDrag.sheet.style.transform = "";
    handleDrag = null;
  }, { passive: true });
  let previewSwipe = null;
  const imageArea = preview.querySelector(".album-preview-image");
  imageArea.addEventListener("touchstart", event => {
    if (previewAnalyzing || event.touches.length !== 1 || !preview.querySelector("#albumPreviewAiSheet").classList.contains("hidden")) {
      previewSwipe = null;
      return;
    }
    const image = imageArea.querySelector("img");
    image.style.transition = "none";
    previewSwipe = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      image,
      horizontal: false,
    };
  }, { passive: true });
  imageArea.addEventListener("touchmove", event => {
    if (!previewSwipe || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - previewSwipe.x;
    const dy = event.touches[0].clientY - previewSwipe.y;
    if (!previewSwipe.horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      previewSwipe.horizontal = true;
    }
    if (!previewSwipe.horizontal) return;
    event.preventDefault();
    const atStart = previewIndex === 0 && dx > 0;
    const atEnd = previewIndex === previewFiles.length - 1 && dx < 0;
    const movement = atStart || atEnd ? dx * 0.22 : dx;
    previewSwipe.image.style.transform = `translateX(${movement}px) scale(${1 - Math.min(0.04, Math.abs(movement) / 5000)})`;
    previewSwipe.image.style.opacity = String(1 - Math.min(0.22, Math.abs(movement) / 1200));
  }, { passive: false });
  imageArea.addEventListener("touchend", event => {
    if (!previewSwipe || !event.changedTouches?.length) return;
    const dx = event.changedTouches[0].clientX - previewSwipe.x;
    const dy = event.changedTouches[0].clientY - previewSwipe.y;
    const swipe = previewSwipe;
    previewSwipe = null;
    if (!swipe.horizontal) {
      swipe.image.style.transition = "";
      swipe.image.style.transform = "";
      swipe.image.style.opacity = "";
      if (dy < -42 && Math.abs(dy) > Math.abs(dx)) setAiSheetOpen(true);
      return;
    }
    if (Math.abs(dx) >= 54) {
      changePreview(dx < 0 ? 1 : -1, { dragDistance: dx });
    } else {
      swipe.image.style.transition = "transform 240ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms ease";
      swipe.image.style.transform = "";
      swipe.image.style.opacity = "";
    }
  }, { passive: true });
  imageArea.addEventListener("touchcancel", () => {
    if (!previewSwipe) return;
    previewSwipe.image.style.transition = "transform 220ms ease";
    previewSwipe.image.style.transform = "";
    previewSwipe.image.style.opacity = "";
    previewSwipe = null;
  }, { passive: true });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && (closeDialog(preview.id) || closeDialog(menu.id))) event.preventDefault();
    if (!preview.classList.contains("hidden") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      changePreview(event.key === "ArrowLeft" ? -1 : 1);
    }
    if (event.key === "Tab") {
      const dialog = [preview, menu].find(element => !element.classList.contains("hidden"));
      const items = dialog && [...dialog.querySelectorAll("button:not(:disabled), select:not(:disabled), summary")].filter(element => element.getClientRects().length);
      if (!items?.length) return;
      const index = items.indexOf(document.activeElement);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    }
  });
}

export function showMobileAlbumDetail() {
  if (!isMobileInspiration()) return;
  overview = false;
  closeDialog("albumMobileMenu");
  closeDialog("albumMobilePreview");
}

export function handleMobileInspirationBack() {
  if (!isMobileInspiration() || document.getElementById("inspirationPage")?.classList.contains("hidden")) return false;
  // Confirm/file dialogs keep priority in app.js, including the create-album dialog.
  if (document.querySelector(".modal-overlay:not(.hidden):not(#albumMobilePreview):not(#albumMobileMenu)")) return false;
  if (closeDialog("albumMobilePreview") || closeDialog("albumMobileMenu")) return true;
  if (document.documentElement.classList.contains("planner-android-fullscreen") || overview) return false;
  overview = true;
  callbacks.render();
  document.getElementById("albumMobileTitle")?.focus({ preventScroll: true });
  return true;
}

export function renderMobileInspiration({
  albums, active, getGroups, loadImage, openSource, aiCategories = [], aiFilter = "all",
  selectAiCategory = () => {}, editAlbum = () => {},
}) {
  if (!isMobileInspiration() || !mounted) return;
  callbacks.loadImage = loadImage;
  callbacks.openSource = openSource;
  callbacks.editAlbum = editAlbum;
  const page = document.getElementById("inspirationPage");
  page.dataset.mobileScreen = overview ? "overview" : "detail";
  page.dataset.albumView = view;
  document.getElementById("albumMobileTitle").textContent = overview ? t("planner-library-mode") : active.name;
  document.getElementById("albumMobileBack").classList.toggle("hidden", overview);
  document.getElementById("albumMobileNew").classList.toggle("hidden", !overview);
  document.getElementById("albumMobileNavigation").classList.toggle("hidden", overview);
  document.getElementById("albumMobileOverview").classList.toggle("hidden", !overview);
  const aiBar = document.getElementById("albumMobileAiCategories");
  aiBar.classList.toggle("hidden", overview || !aiCategories.length);
  aiBar.replaceChildren();
  if (!overview && aiCategories.length) {
    const all = document.createElement("button");
    all.type = "button";
    all.textContent = `${t("ai-filter-all")} ${aiCategories.reduce((sum, category) => sum + category.count, 0)}`;
    all.className = aiFilter === "all" ? "active" : "";
    all.addEventListener("click", () => selectAiCategory("all"));
    aiBar.appendChild(all);
    aiCategories.forEach(category => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = aiFilter === category.code ? "active" : "";
      button.textContent = `${category.name} ${category.count}`;
      button.addEventListener("click", () => selectAiCategory(category.code));
      aiBar.appendChild(button);
    });
  }
  document.getElementById("albumMobileOrganize").classList.toggle("hidden", overview || !getGroups(active.id).length);
  if (document.getElementById("albumMobileOrganize").open) callbacks.renderGroupTools(document.getElementById("albumMobileGroupTools"));
  document.querySelectorAll("[data-album-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.albumView === view);
    button.setAttribute("aria-pressed", String(button.dataset.albumView === view));
  });
  if (!overview) return;
  document.getElementById("albumMobileCount").textContent = t("album-count", { count: albums.length });
  const shortcuts = document.getElementById("albumMobileShortcuts");
  shortcuts.replaceChildren();
  for (const album of [{ id: "today", name: t("inspiration-today") }, { id: "all", name: t("inspiration-all") }]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.albumId = album.id;
    button.textContent = album.name;
    button.addEventListener("click", () => callbacks.selectAlbum(album.id));
    shortcuts.appendChild(button);
  }
  const grid = document.getElementById("albumMobileCovers");
  grid.replaceChildren();
  if (!albums.length) {
    const empty = document.createElement("p");
    empty.className = "album-overview-empty";
    empty.textContent = t("album-empty-overview");
    grid.appendChild(empty);
  }
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("mori_mobile_album_recent") || "[]"); if (!Array.isArray(recent)) recent = []; } catch (_) {}
  const rank = id => { const index = recent.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  [...albums].sort((a, b) => rank(a.id) - rank(b.id) || Number(b.createdAt || 0) - Number(a.createdAt || 0)).forEach(album => {
    const groups = getGroups(album.id);
    const count = groups.reduce((sum, group) => sum + group.files.length, 0);
    const coverGroup = groups.find(group => group.files.some(file => !file.syncMissing));
    const card = document.createElement("button");
    card.type = "button";
    card.className = "album-cover";
    card.dataset.albumId = album.id;
    const cover = document.createElement("div");
    cover.className = "album-cover-image";
    if (coverGroup) {
      const image = document.createElement("img");
      image.alt = ""; image.draggable = false;
      loadImage(image, coverGroup.files.find(file => !file.syncMissing), coverGroup.item);
      cover.appendChild(image);
    } else cover.innerHTML = icon("image");
    const title = document.createElement("strong"); title.textContent = album.name;
    const meta = document.createElement("span");
    meta.textContent = `${t("album-photo-count", { count })}${album.plannerProjectId ? ` · ${t("album-has-plan")}` : ""}`;
    card.append(cover, title, meta);
    let longPressTimer = null;
    let longPressTriggered = false;
    let startPoint = null;
    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      startPoint = null;
    };
    card.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch" || event.button !== 0) return;
      longPressTriggered = false;
      startPoint = { x: event.clientX, y: event.clientY };
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        longPressTimer = null;
        try { navigator.vibrate?.(18); } catch (_) {}
        callbacks.editAlbum(album);
      }, 520);
    });
    card.addEventListener("pointermove", event => {
      if (!startPoint) return;
      if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 10) {
        cancelLongPress();
      }
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(type =>
      card.addEventListener(type, cancelLongPress));
    card.addEventListener("contextmenu", event => event.preventDefault());
    card.addEventListener("click", event => {
      if (longPressTriggered) {
        longPressTriggered = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      try { localStorage.setItem("mori_mobile_album_recent", JSON.stringify([album.id, ...recent.filter(id => id !== album.id)].slice(0, 50))); } catch (_) {}
      callbacks.selectAlbum(album.id);
    });
    grid.appendChild(card);
  });
}

function escapeMarkup(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function previewAiHtml(analysis) {
  const pose = t(`ai-pose-${String(analysis.pose || "other").replaceAll("_", "-")}`);
  const shot = t(`ai-shot-${String(analysis.shotType || "environment").replaceAll("_", "-")}`);
  const parameters = [
    ["ai-param-focal", analysis.camera?.focalLength],
    ["ai-param-aperture", analysis.camera?.aperture],
    ["ai-param-shutter", analysis.camera?.shutter],
    ["ai-param-iso", analysis.camera?.iso],
    ["ai-param-angle", analysis.camera?.angle],
    ["ai-param-light", analysis.camera?.lighting],
  ].filter(([, value]) => String(value || "").trim());
  const advice = [
    ["ai-result-composition", analysis.composition],
    ["ai-result-pose-advice", analysis.poseAdvice],
    ["ai-result-retouch", analysis.retouch],
  ].filter(([, value]) => String(value || "").trim());
  return `<header class="album-preview-ai-heading">
      <span class="ai-pose-badge">${escapeMarkup(pose)}</span>
      <strong>${escapeMarkup(analysis.title || t("ai-result-title"))}</strong>
      <span class="ai-shot-badge">${escapeMarkup(shot)}${analysis.confidence ? ` · ${Math.round(analysis.confidence * 100)}%` : ""}</span>
    </header>
    ${analysis.summary ? `<p>${escapeMarkup(analysis.summary)}</p>` : ""}
    ${parameters.length ? `<section><h4>${escapeMarkup(t("ai-result-parameters"))}</h4><dl class="ai-result-params">${parameters.map(([key, value]) => `<div><dt>${escapeMarkup(t(key))}</dt><dd>${escapeMarkup(value)}</dd></div>`).join("")}</dl></section>` : ""}
    ${advice.length ? `<section><h4>${escapeMarkup(t("ai-result-advice"))}</h4><dl class="ai-result-advice">${advice.map(([key, value]) => `<div><dt>${escapeMarkup(t(key))}</dt><dd>${escapeMarkup(value)}</dd></div>`).join("")}</dl></section>` : ""}
    ${analysis.suggestions?.length ? `<section><h4>${escapeMarkup(t("ai-result-suggestions"))}</h4><ul>${analysis.suggestions.map(item => `<li>${escapeMarkup(item)}</li>`).join("")}</ul></section>` : ""}
    <p class="ai-results-note">${escapeMarkup(t("ai-result-note"))}</p>`;
}

function changePreview(delta, { dragDistance = 0 } = {}) {
  const preview = document.getElementById("albumMobilePreview");
  if (!preview || previewTransitioning || previewAnalyzing) return;
  const nextIndex = Math.max(0, Math.min(previewFiles.length - 1, previewIndex + delta));
  if (nextIndex === previewIndex) {
    const image = preview.querySelector(".album-preview-image img");
    image.style.transition = "transform 240ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms ease";
    image.style.transform = "";
    image.style.opacity = "";
    return;
  }
  previewTransitioning = true;
  const image = preview.querySelector(".album-preview-image img");
  const direction = Math.sign(delta);
  const exitDistance = dragDistance
    ? direction * Math.max(90, Math.abs(dragDistance) * 1.25)
    : direction * Math.max(90, preview.clientWidth * 0.24);
  image.style.transition = "transform 160ms cubic-bezier(0.32, 0.72, 0, 1), opacity 130ms ease";
  image.style.transform = `translateX(${exitDistance}px) scale(0.98)`;
  image.style.opacity = "0.18";
  setTimeout(() => {
    previewIndex = nextIndex;
    previewTransitioning = false;
    renderPreview({ enterFrom: direction > 0 ? 16 : -16 });
  }, 145);
}

function renderPreview({ enterFrom = 0 } = {}) {
  const preview = document.getElementById("albumMobilePreview");
  const oldImage = preview.querySelector("img");
  // A fresh image prevents a slower previous file read from replacing the current photo.
  const image = document.createElement("img");
  image.alt = previewFiles[previewIndex].title || previewGroup.item.title || t("album-preview");
  if (enterFrom) {
    image.style.transition = "none";
    image.style.opacity = "0.42";
    image.style.transform = `translateX(${enterFrom}%) scale(0.985)`;
  }
  oldImage.replaceWith(image);
  if (enterFrom) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      image.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1), opacity 190ms ease";
      image.style.opacity = "";
      image.style.transform = "";
    }));
  } else {
    image.style.transition = "";
    image.style.opacity = "";
    image.style.transform = "";
  }
  callbacks.loadImage(image, previewFiles[previewIndex], previewGroup.item);
  preview.querySelector("#albumPreviewCount").textContent = `${previewIndex + 1} / ${previewFiles.length}`;
  preview.querySelector('[data-photo-step="-1"]').disabled = previewIndex === 0;
  preview.querySelector('[data-photo-step="1"]').disabled = previewIndex === previewFiles.length - 1;
  preview.querySelector("#albumPreviewSource").disabled = !(previewGroup.item.sourceUrl || previewGroup.item.url);
  const analysis = callbacks.getAiAnalysis?.(previewFiles[previewIndex]) || null;
  const toggle = preview.querySelector("#albumPreviewAiToggle");
  const sheet = preview.querySelector("#albumPreviewAiSheet");
  const body = sheet.querySelector(".album-preview-ai-sheet-body");
  const identify = preview.querySelector("#albumPreviewAiIdentify");
  identify.disabled = false;
  identify.classList.remove("is-busy");
  identify.querySelector(".album-preview-ai-identify-label").textContent =
    t(analysis ? "ai-view-image-analysis" : "ai-identify-image");
  toggle.classList.toggle("hidden", !analysis);
  toggle.setAttribute("aria-expanded", "false");
  sheet.classList.add("hidden");
  body.innerHTML = analysis ? previewAiHtml(analysis) : "";
}

export function openMobileAlbumPreview(group, file) {
  if (!isMobileInspiration() || file.syncMissing) return;
  previewGroup = group;
  previewFiles = group.files.filter(item => !item.syncMissing);
  previewIndex = previewFiles.indexOf(file);
  if (previewIndex < 0) return;
  renderPreview();
  openDialog("albumMobilePreview", ".album-preview-close");
}
