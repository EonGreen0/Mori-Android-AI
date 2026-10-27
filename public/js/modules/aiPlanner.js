import { t } from "../i18n/index.js";
import { showToast } from "../utils/index.js";
import { showConfirm } from "./modals.js";
import { getAiAnalysisForFile } from "./inspiration.js";
import { ensureAiImageAnalysisResult } from "./aiOrganizer.js";
import {
  finishAiAnalysisProgress,
  startAiAnalysisProgress,
  updateAiAnalysisProgress,
} from "./aiProgress.js";
import { applyAiPlannerPlan, ensureEditablePlannerCopy, getPlannerAiImages } from "./planner.js";

let running = false;
let bound = false;

function setBusy(value, message = "") {
  running = value;
  for (const id of ["plannerMobileAiLayoutBtn", "plannerAiLayoutBtn"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = value;
    button.textContent = value ? (message || t("ai-planner-working")) : t("ai-planner-button");
  }
  const mobileStatus = document.getElementById("plannerMobileAiStatus");
  if (mobileStatus) {
    mobileStatus.textContent = message;
    mobileStatus.classList.toggle("hidden", !message);
  }
}

function poseName(code) {
  return t(`ai-pose-${String(code || "other").replaceAll("_", "-")}`);
}

function shotLabel(code) {
  return t(`ai-shot-${String(code || "environment").replaceAll("_", "-")}`);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

async function runAiPlannerLayout() {
  if (running) return;
  try {
    if (ensureEditablePlannerCopy()) {
      showToast(t("ai-planner-copy-created"));
    }
  } catch (error) {
    showToast(String(error?.message || error));
    return;
  }
  const images = getPlannerAiImages();
  if (!images.length) {
    setBusy(false, t("ai-planner-no-images"));
    showToast(t("ai-planner-no-images"));
    return;
  }
  running = true;
  setBusy(true, t("ai-planner-working"));
  const limit = Math.min(images.length, 40);
  let analyzedCount = 0;
  let progressFinished = false;
  startAiAnalysisProgress({ total: limit });
  try {
    const groups = new Map();
    let analyzed = 0;
    let reused = 0;
    for (const [index, image] of images.slice(0, limit).entries()) {
      setBusy(true, t("ai-planner-progress", { current: index + 1, total: limit }));
      updateAiAnalysisProgress({
        current: index + 1,
        total: limit,
        fileName: image.title || image.name || image.id || `#${index + 1}`,
      });
      const cached = getAiAnalysisForFile(image);
      const resolved = cached
        ? { analysis: cached, cached: true }
        : await ensureAiImageAnalysisResult(image);
      const analysis = resolved.analysis;
      if (resolved.cached) reused += 1;
      else analyzed += 1;
      analyzedCount = index + 1;
      const code = analysis.pose || "other";
      const bucket = groups.get(code) || {
        code,
        title: poseName(code),
        nodeIds: [],
        analyses: [],
      };
      bucket.nodeIds.push(image.id);
      bucket.analyses.push(analysis);
      groups.set(code, bucket);
    }
    const plan = [...groups.values()].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    progressFinished = finishAiAnalysisProgress("complete", { count: analyzedCount, total: limit });
    const rows = plan.map(group => {
      const focal = [...new Set(group.analyses.map(item => item.camera?.focalLength).filter(Boolean))].slice(0, 2).join(" / ");
      const shot = [...new Set(group.analyses.map(item => item.shotType).filter(Boolean))].slice(0, 2).map(shotLabel).join(" / ");
      const detail = [shot, focal].filter(Boolean).join(" · ");
      return `<li><strong>${escapeHtml(group.title)}</strong> · ${group.nodeIds.length}${detail ? ` · ${escapeHtml(detail)}` : ""}</li>`;
    }).join("");
    const message = `<p>${t("ai-planner-confirm", { images: plan.reduce((sum, group) => sum + group.nodeIds.length, 0), groups: plan.length })}</p><ul>${rows}</ul><p>${t("ai-planner-uses-existing-analysis")}</p><p>${t("ai-planner-cache-summary", { newCount: analyzed, cachedCount: reused })}</p>`;
    setBusy(false, t("ai-planner-ready"));
    showConfirm(t("ai-planner-title"), message, () => {
      try {
        const result = applyAiPlannerPlan(plan);
        setBusy(false, t("ai-planner-applied", { images: result.images, groups: result.groups }));
      } catch (error) {
        setBusy(false, String(error?.message || error));
      }
    }, () => setBusy(false, ""));
  } catch (error) {
    if (!progressFinished) {
      progressFinished = finishAiAnalysisProgress("failed", {
        count: analyzedCount,
        total: limit,
        detail: String(error?.message || error),
      });
    }
    const message = `${t("ai-planner-failed")}：${String(error?.message || error)}`;
    setBusy(false, message);
    showToast(message);
  } finally {
    if (!progressFinished) finishAiAnalysisProgress("failed", { count: analyzedCount, total: limit });
  }
}

export function initAiPlanner() {
  if (bound) return;
  const buttons = [
    document.getElementById("plannerMobileAiLayoutBtn"),
    document.getElementById("plannerAiLayoutBtn"),
  ].filter(Boolean);
  if (!buttons.length) return;
  bound = true;
  buttons.forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    runAiPlannerLayout();
  }));
}
