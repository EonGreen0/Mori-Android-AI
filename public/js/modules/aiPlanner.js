import { t } from "../i18n/index.js";
import { showToast } from "../utils/index.js";
import { showConfirm } from "./modals.js";
import { getAiAnalysisForFile } from "./inspiration.js";
import { ensureAiImageAnalysis } from "./aiOrganizer.js";
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
  try {
    const groups = new Map();
    let analyzed = 0;
    let reused = 0;
    const limit = Math.min(images.length, 40);
    for (const [index, image] of images.slice(0, limit).entries()) {
      setBusy(true, t("ai-planner-progress", { current: index + 1, total: limit }));
      const cached = getAiAnalysisForFile(image);
      const analysis = cached || await ensureAiImageAnalysis(image);
      if (cached) reused += 1;
      else analyzed += 1;
      const code = analysis.pose || "other";
      const bucket = groups.get(code) || {
        code,
        title: poseName(code),
        nodeIds: [],
      };
      bucket.nodeIds.push(image.id);
      groups.set(code, bucket);
    }
    const plan = [...groups.values()].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    const rows = plan.map(group =>
      `<li><strong>${String(group.title).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))}</strong> · ${group.nodeIds.length}</li>`,
    ).join("");
    const message = `<p>${t("ai-planner-confirm", { images: plan.reduce((sum, group) => sum + group.nodeIds.length, 0), groups: plan.length })}</p><ul>${rows}</ul><p>${t("ai-planner-cache-summary", { newCount: analyzed, cachedCount: reused })}</p>`;
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
    const message = `${t("ai-planner-failed")}：${String(error?.message || error)}`;
    setBusy(false, message);
    showToast(message);
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
