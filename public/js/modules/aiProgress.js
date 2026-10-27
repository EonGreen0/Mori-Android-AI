import { t } from "../i18n/index.js";

const MAX_TOTAL = 999;
let activeSession = null;
let hideTimer = null;

function progressIsland() {
  if (!document.documentElement.classList.contains("is-android")) return null;
  let island = document.getElementById("aiAnalysisIsland");
  if (island) return island;
  island = document.createElement("div");
  island.id = "aiAnalysisIsland";
  island.className = "ai-analysis-island hidden";
  island.setAttribute("role", "status");
  island.setAttribute("aria-live", "polite");
  island.innerHTML = `<span class="ai-analysis-island-icon" aria-hidden="true"></span>
    <span class="ai-analysis-island-copy"><strong></strong><small></small></span>
    <span class="ai-analysis-island-count"></span>`;
  document.body.appendChild(island);
  return island;
}

function renderIsland({ state = "running", title = "", text = "", current = 0, total = 1 } = {}) {
  const island = progressIsland();
  if (!island) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  island.dataset.state = state;
  island.classList.remove("hidden");
  island.querySelector("strong").textContent = title;
  island.querySelector("small").textContent = text;
  island.querySelector(".ai-analysis-island-count").textContent =
    state === "running" || state === "cancelling" ? shortText(current, total) : "";
  if (["complete", "cancelled", "failed"].includes(state)) {
    hideTimer = setTimeout(() => {
      island.classList.add("hidden");
      hideTimer = null;
    }, state === "complete" ? 1800 : 2800);
  }
}

function progressBridge() {
  const bridge = window.MoriMainBridge;
  return bridge && typeof bridge.aiAnalysisProgressUpdate === "function" ? bridge : null;
}

function clampProgress(value, total) {
  const safeTotal = Math.max(1, Math.min(MAX_TOTAL, Number(total) || 1));
  return {
    total: safeTotal,
    current: Math.max(0, Math.min(safeTotal, Number(value) || 0)),
  };
}

function shortText(current, total) {
  return `${current}/${total}`;
}

function send(payload) {
  const bridge = progressBridge();
  if (!bridge) return false;
  try {
    bridge.aiAnalysisProgressUpdate(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

export function startAiAnalysisProgress({ total } = {}) {
  const safe = clampProgress(0, total);
  activeSession = {
    ...safe,
    cancelling: false,
  };
  send({
    action: "start",
    state: "running",
    current: 0,
    total: safe.total,
    title: t("ai-progress-title"),
    text: t("ai-progress-preparing", { total: safe.total }),
    shortText: shortText(0, safe.total),
  });
  renderIsland({
    state: "running",
    title: t("ai-progress-title"),
    text: t("ai-progress-preparing", { total: safe.total }),
    current: 0,
    total: safe.total,
  });
}

export function updateAiAnalysisProgress({ current, total, fileName = "" } = {}) {
  const sessionTotal = total ?? activeSession?.total;
  const safe = clampProgress(current ?? activeSession?.current, sessionTotal);
  if (activeSession) {
    activeSession.current = safe.current;
    activeSession.total = safe.total;
  }
  const file = String(fileName || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const cancelling = Boolean(activeSession?.cancelling);
  send({
    action: "update",
    state: cancelling ? "cancelling" : "running",
    current: safe.current,
    total: safe.total,
    title: t("ai-progress-title"),
    text: cancelling
      ? t("ai-progress-cancelling", { current: safe.current, total: safe.total })
      : file
        ? t("ai-progress-current-file", { current: safe.current, total: safe.total, file })
        : t("ai-progress-current", { current: safe.current, total: safe.total }),
    shortText: shortText(safe.current, safe.total),
  });
  renderIsland({
    state: cancelling ? "cancelling" : "running",
    title: t("ai-progress-title"),
    text: cancelling
      ? t("ai-progress-cancelling", { current: safe.current, total: safe.total })
      : file
        ? t("ai-progress-current-file", { current: safe.current, total: safe.total, file })
        : t("ai-progress-current", { current: safe.current, total: safe.total }),
    current: safe.current,
    total: safe.total,
  });
}

export function requestAiAnalysisProgressCancel() {
  if (!activeSession) return false;
  activeSession.cancelling = true;
  updateAiAnalysisProgress({
    current: activeSession.current,
    total: activeSession.total,
  });
  return true;
}

export function finishAiAnalysisProgress(state = "complete", { count, total, detail = "" } = {}) {
  if (!activeSession) return false;
  const safe = clampProgress(count ?? activeSession.current, total ?? activeSession.total);
  const normalized = ["complete", "cancelled", "failed"].includes(state) ? state : "complete";
  const text = detail
    ? String(detail).trim().slice(0, 220)
    : normalized === "complete"
      ? t("ai-progress-complete", { count: safe.current, total: safe.total })
      : normalized === "cancelled"
        ? t("ai-progress-cancelled")
        : t("ai-progress-failed");
  send({
    action: "finish",
    state: normalized,
    current: safe.current,
    total: safe.total,
    title: normalized === "complete"
      ? t("ai-progress-complete-title")
      : normalized === "cancelled"
        ? t("ai-progress-cancelled-title")
        : t("ai-progress-failed-title"),
    text,
    shortText: normalized === "complete" ? shortText(safe.current, safe.total) : "",
  });
  renderIsland({
    state: normalized,
    title: normalized === "complete"
      ? t("ai-progress-complete-title")
      : normalized === "cancelled"
        ? t("ai-progress-cancelled-title")
        : t("ai-progress-failed-title"),
    text,
    current: safe.current,
    total: safe.total,
  });
  activeSession = null;
  return true;
}

export function isAiAnalysisProgressActive() {
  return Boolean(activeSession);
}
