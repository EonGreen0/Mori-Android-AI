import { Filesystem, showToast } from "../utils/index.js";
import { t } from "../i18n/index.js";
import { preparePlannerImageAsset } from "../sync/assetCatalog.js";
import { requestAiJson, getAiBridge, aiCredentialAvailable, readAiConfig } from "./aiClient.js";
import { analysisKey, getAiAnalysis, putAiAnalysis, putAiFileAnalysis } from "./aiStore.js";
import {
  finishAiAnalysisProgress,
  requestAiAnalysisProgressCancel,
  startAiAnalysisProgress,
  updateAiAnalysisProgress,
} from "./aiProgress.js";
import {
  getActiveInspirationAlbumSnapshot,
  refreshAiFileAnalyses,
  renderInspiration,
} from "./inspiration.js";
import { fileAssignmentKey } from "./imageFileIdentity.js";

const PROMPT_VERSION = "v2";
const MAX_IMAGES_PER_RUN = 60;
const PUBLIC_DIRECTORIES = ["EXTERNAL_STORAGE", "DOCUMENTS", "EXTERNAL"];
const POSE_CODES = new Set([
  "standing", "sitting", "squatting", "kneeling", "lying", "walking",
  "running", "jumping", "leaning", "portrait", "interaction", "no_person", "other",
]);
const SHOT_CODES = new Set(["headshot", "half_body", "full_body", "environment", "detail"]);
let running = false;
let cancelRequested = false;
let bound = false;

function status(message, state = "idle") {
  const element = document.getElementById("albumAiStatus");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

function setRunning(value) {
  running = value;
  const button = document.getElementById("albumAiAnalyzeBtn");
  if (!button) return;
  button.classList.toggle("is-running", value);
  button.textContent = value ? t("ai-cancel") : t("ai-organize-button");
  button.disabled = false;
}

function originalLocalPath(raw) {
  try {
    const url = new URL(raw);
    if (url.origin === window.location.origin) {
      if (url.pathname.startsWith("/_capacitor_file_/")) {
        return decodeURIComponent(url.pathname.slice("/_capacitor_file_".length));
      }
      if (url.pathname.startsWith("/_capacitor_content_/")) {
        return `content:/${url.pathname.slice("/_capacitor_content_".length)}${url.search}`;
      }
    }
  } catch (_) {}
  return raw;
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function readLocalImageBytes(file) {
  const values = [file?.uri, file?.path].filter(Boolean).map(String);
  let lastError = null;
  for (const raw of [...new Set(values)]) {
    if (/^data:image\//i.test(raw)) {
      return base64ToBytes(raw.slice(raw.indexOf(",") + 1));
    }
    const path = originalLocalPath(raw);
    if (/^https?:\/\//i.test(path)) {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    const relative = !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path);
    const declaredDirectory = file?.directory ||
      (file?.storage === "cache" || file?.cachedImage ? "DATA" : "");
    const options = declaredDirectory
      ? [{ path, directory: declaredDirectory }]
      : relative
        ? PUBLIC_DIRECTORIES.map(directory => ({ path, directory }))
        : [{ path }];
    for (const option of options) {
      try {
        const result = await Filesystem.readFile(option);
        if (typeof result?.data === "string" && result.data) return base64ToBytes(result.data);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(lastError?.message || "无法读取本地图片");
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeAnalysis(value) {
  const raw = value && typeof value === "object" ? value : {};
  const title = cleanText(raw.title || "", 100);
  const summary = cleanText(raw.summary || raw.description || "", 500);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 10)
    : [];
  const pose = POSE_CODES.has(raw.pose) ? raw.pose : "other";
  const shotType = SHOT_CODES.has(raw.shotType) ? raw.shotType : "environment";
  const camera = raw.camera && typeof raw.camera === "object" ? raw.camera : {};
  const suggestions = Array.isArray(raw.suggestions)
    ? raw.suggestions.map(item => cleanText(item, 220)).filter(Boolean).slice(0, 6)
    : [];
  if (!title && !summary && !suggestions.length) throw new Error("AI 返回的分析内容为空");
  return {
    title,
    summary,
    tags,
    pose,
    shotType,
    camera: {
      focalLength: cleanText(camera.focalLength, 80),
      aperture: cleanText(camera.aperture, 80),
      shutter: cleanText(camera.shutter, 80),
      iso: cleanText(camera.iso, 80),
      angle: cleanText(camera.angle, 120),
      lighting: cleanText(camera.lighting, 160),
    },
    composition: cleanText(raw.composition, 300),
    poseAdvice: cleanText(raw.poseAdvice, 300),
    retouch: cleanText(raw.retouch, 300),
    suggestions,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
  };
}

function analysisPrompt(language) {
  const languageInstruction = {
    "zh-Hans": "Use concise Simplified Chinese for every human-readable field.",
    "zh-Hant": "Use concise Traditional Chinese for every human-readable field.",
    en: "Use concise English for every human-readable field.",
  }[language];
  return [
    "Analyze this reference image for a photography inspiration album.",
    languageInstruction,
    "Return exactly one JSON object and no markdown:",
    JSON.stringify({
      title: "short descriptive title",
      summary: "one practical sentence",
      pose: "standing",
      shotType: "full_body",
      confidence: 0.85,
      tags: ["3 to 8 useful tags"],
      camera: {
        focalLength: "suggested full-frame equivalent range",
        aperture: "suggested aperture range",
        shutter: "suggested shutter speed",
        iso: "suggested ISO range",
        angle: "suggested camera height and angle",
        lighting: "suggested light direction and quality",
      },
      composition: "composition and framing advice",
      poseAdvice: "how to recreate or improve the visible pose",
      retouch: "brief color and retouching direction",
      suggestions: ["2 to 5 actionable photography suggestions"],
    }),
    "pose MUST be one of: standing, sitting, squatting, kneeling, lying, walking, running, jumping, leaning, portrait, interaction, no_person, other.",
    "shotType MUST be one of: headshot, half_body, full_body, environment, detail.",
    "Use no_person when there is no visible person. Use portrait for a posed portrait that does not fit another posture, and interaction for two or more people.",
    "Camera values are recommendations for recreating the look, not original EXIF metadata. Never claim to know settings that are not visible.",
    "Analyze only visible content. Do not identify people by name or infer sensitive traits.",
  ].join("\n");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function poseLabel(code) {
  return t(`ai-pose-${String(code || "other").replaceAll("_", "-")}`);
}

function shotLabel(code) {
  return t(`ai-shot-${String(code || "environment").replaceAll("_", "-")}`);
}

function parameterRows(analysis) {
  const camera = analysis.camera || {};
  return [
    ["ai-param-focal", camera.focalLength],
    ["ai-param-aperture", camera.aperture],
    ["ai-param-shutter", camera.shutter],
    ["ai-param-iso", camera.iso],
    ["ai-param-angle", camera.angle],
    ["ai-param-light", camera.lighting],
  ].filter(([, value]) => String(value || "").trim());
}

function showAiResultOverlay({ entries, planList, analyzed, reused, failures, seen, totalAvailable }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "aiResultOverlay";
    overlay.className = "modal-overlay ai-results-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "aiResultTitle");
    const categoryPills = planList.map(plan =>
      `<span class="ai-result-pill"><strong>${escapeHtml(plan.name)}</strong> ${plan.imageCount}</span>`,
    ).join("");
    const cards = entries.map((entry, index) => {
      const analysis = entry.analysis;
      const params = parameterRows(analysis).map(([labelKey, value]) =>
        `<div><dt>${escapeHtml(t(labelKey))}</dt><dd>${escapeHtml(value)}</dd></div>`,
      ).join("");
      const advice = [
        ["ai-result-composition", analysis.composition],
        ["ai-result-pose-advice", analysis.poseAdvice],
        ["ai-result-retouch", analysis.retouch],
      ].filter(([, value]) => String(value || "").trim()).map(([labelKey, value]) =>
        `<div><dt>${escapeHtml(t(labelKey))}</dt><dd>${escapeHtml(value)}</dd></div>`,
      ).join("");
      const suggestions = analysis.suggestions.length
        ? `<ul>${analysis.suggestions.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";
      const confidence = analysis.confidence > 0
        ? ` · ${Math.round(analysis.confidence * 100)}%`
        : "";
      return `<article class="ai-result-card">
        <header>
          <span class="ai-pose-badge">${escapeHtml(poseLabel(analysis.pose))}</span>
          <strong>${escapeHtml(analysis.title || entry.file.title || `#${index + 1}`)}</strong>
          <span class="ai-shot-badge">${escapeHtml(shotLabel(analysis.shotType))}${confidence}</span>
        </header>
        ${analysis.summary ? `<p>${escapeHtml(analysis.summary)}</p>` : ""}
        ${params ? `<section><h4>${escapeHtml(t("ai-result-parameters"))}</h4><dl class="ai-result-params">${params}</dl></section>` : ""}
        ${advice ? `<section><h4>${escapeHtml(t("ai-result-advice"))}</h4><dl class="ai-result-advice">${advice}</dl></section>` : ""}
        ${suggestions ? `<section><h4>${escapeHtml(t("ai-result-suggestions"))}</h4>${suggestions}</section>` : ""}
      </article>`;
    }).join("");
    const warnings = [
      failures.length ? t("ai-failed-skipped", { count: failures.length }) : "",
      seen < totalAvailable ? t("ai-max-images", { count: seen }) : "",
    ].filter(Boolean).map(text => `<p>${escapeHtml(text)}</p>`).join("");
    overlay.innerHTML = `<div class="ai-results-dialog">
      <header class="ai-results-heading">
        <div><h2 id="aiResultTitle">${escapeHtml(t("ai-result-title"))}</h2>
        <p>${escapeHtml(t("ai-result-summary", { images: entries.length, poses: planList.length }))}</p></div>
        <button type="button" class="ai-results-close" aria-label="${escapeHtml(t("album-close"))}">×</button>
      </header>
      <div class="ai-results-overview">
        <div class="ai-result-pills">${categoryPills}</div>
        <p class="ai-results-cache">${escapeHtml(t("ai-analysis-summary", { newCount: analyzed, cachedCount: reused }))}</p>
        ${warnings}
        <p class="ai-results-note">${escapeHtml(t("ai-result-note"))}</p>
      </div>
      <div class="ai-results-list">${cards}</div>
      <footer class="ai-results-actions">
        <button type="button" class="ai-results-cancel">${escapeHtml(t("btn-cancel"))}</button>
        <button type="button" class="ai-results-apply">${escapeHtml(t("ai-apply-classification"))}</button>
      </footer>
    </div>`;
    document.body.appendChild(overlay);
    const finish = (accepted) => {
      overlay.remove();
      resolve(accepted);
    };
    overlay.querySelector(".ai-results-close").addEventListener("click", () => finish(false));
    overlay.querySelector(".ai-results-cancel").addEventListener("click", () => finish(false));
    overlay.querySelector(".ai-results-apply").addEventListener("click", () => finish(true));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) finish(false);
    });
    overlay.querySelector(".ai-results-close").focus();
  });
}

async function analyzeFile(file, config, index, total) {
  status(t("ai-organize-progress", { current: index, total }), "working");
  const sourceBytes = await readLocalImageBytes(file);
  const prepared = await preparePlannerImageAsset(sourceBytes, {
    filename: file.title || "",
    maxDisplaySide: 768,
    displayQuality: 0.82,
    legacyDisplay: false,
  });
  const imageHash = prepared.asset.id;
  const key = analysisKey({
    imageHash,
    model: config.model,
    language: config.language,
    promptVersion: PROMPT_VERSION,
  });
  const cached = await getAiAnalysis(key);
  const fileKey = fileAssignmentKey(file);
  if (cached?.analysis) {
    return { analysis: normalizeAnalysis(cached.analysis), cached: true, imageHash, file, fileKey };
  }

  const analysis = normalizeAnalysis(await requestAiJson({
    prompt: analysisPrompt(config.language),
    imageDataUrls: [`data:${prepared.asset.display.mime};base64,${bytesToBase64(prepared.displayBytes)}`],
  }));
  await putAiAnalysis({
    key,
    imageHash,
    model: config.model,
    language: config.language,
    promptVersion: PROMPT_VERSION,
    analysis,
    updatedAt: Date.now(),
  });
  return { analysis, cached: false, imageHash, file, fileKey };
}

export async function ensureAiImageAnalysis(file) {
  const config = readAiConfig();
  if (!getAiBridge() || !config.model || !(await aiCredentialAvailable())) {
    throw new Error(t("ai-not-configured"));
  }
  const result = await analyzeFile(file, config, 1, 1);
  await putAiFileAnalysis({
    fileKey: result.fileKey,
    imageHash: result.imageHash,
    model: config.model,
    language: config.language,
    promptVersion: PROMPT_VERSION,
    analysis: result.analysis,
    updatedAt: Date.now(),
  });
  await refreshAiFileAnalyses({ render: false });
  return result.analysis;
}

export async function runAiAlbumOrganization() {
  if (running) {
    cancelRequested = true;
    requestAiAnalysisProgressCancel();
    status(t("ai-cancel"), "working");
    return;
  }
  const bridge = getAiBridge();
  const config = readAiConfig();
  if (!bridge || !config.model || !(await aiCredentialAvailable())) {
    status(t("ai-not-configured"), "error");
    showToast(t("ai-not-configured"));
    return;
  }
  const snapshot = getActiveInspirationAlbumSnapshot();
  const groups = (snapshot.groups || []).filter(group => group.files?.length);
  const totalAvailable = groups.reduce((total, group) => total + group.files.length, 0);
  if (!totalAvailable) {
    status(t("ai-no-images"), "error");
    showToast(t("ai-no-images"));
    return;
  }

  const entries = [];
  let seen = 0;
  let reused = 0;
  let analyzed = 0;
  const failures = [];
  const progressTotal = Math.min(totalAvailable, MAX_IMAGES_PER_RUN);
  let progressFinished = false;
  cancelRequested = false;
  setRunning(true);
  status(t("ai-analyzing"), "working");
  startAiAnalysisProgress({ total: progressTotal });
  try {
    for (const group of groups) {
      if (seen >= MAX_IMAGES_PER_RUN) break;
      const seenHashes = new Set();
      for (const file of group.files) {
        if (seen >= MAX_IMAGES_PER_RUN || cancelRequested) break;
        try {
          const current = seen + 1;
          seen = current;
          updateAiAnalysisProgress({
            current,
            total: progressTotal,
            fileName: file.title || group.title || `#${current}`,
          });
          const result = await analyzeFile(file, config, current, progressTotal);
          if (seenHashes.has(result.imageHash)) continue;
          seenHashes.add(result.imageHash);
          entries.push(result);
          if (result.cached) reused += 1;
          else analyzed += 1;
        } catch (error) {
          if (error?.status === 401 || error?.status === 403) throw error;
          failures.push({ title: file.title || group.title, message: String(error?.message || error) });
        }
      }
    }
    if (cancelRequested) {
      progressFinished = finishAiAnalysisProgress("cancelled", { count: seen, total: progressTotal });
      status(t("ai-plan-cancelled"), "idle");
      return;
    }
    if (!entries.length) {
      const details = failures[0]?.message ? `：${failures[0].message}` : "";
      throw new Error(`${t("ai-plan-empty")}${details}`);
    }

    const plans = new Map();
    for (const entry of entries) {
      const code = POSE_CODES.has(entry.analysis.pose) ? entry.analysis.pose : "other";
      const bucket = plans.get(code) || {
        code,
        name: poseLabel(code),
        fileKeys: new Set(),
        imageCount: 0,
      };
      bucket.fileKeys.add(entry.fileKey);
      bucket.imageCount += 1;
      plans.set(code, bucket);
    }
    const planList = [...plans.values()].sort((a, b) => b.imageCount - a.imageCount);
    progressFinished = finishAiAnalysisProgress("complete", { count: seen, total: progressTotal });
    status(`${t("ai-plan-title")} · ${t("ai-analysis-summary", { newCount: analyzed, cachedCount: reused })}`, "ready");
    const accepted = await showAiResultOverlay({
      entries,
      planList,
      analyzed,
      reused,
      failures,
      seen,
      totalAvailable,
    });
    if (!accepted) {
      status(t("ai-plan-cancelled"), "idle");
      return;
    }
    for (const entry of entries) {
      await putAiFileAnalysis({
        fileKey: entry.fileKey,
        imageHash: entry.imageHash,
        model: config.model,
        language: config.language,
        promptVersion: PROMPT_VERSION,
        analysis: entry.analysis,
        updatedAt: Date.now(),
      });
    }
    await refreshAiFileAnalyses({ render: false });
    renderInspiration();
    status(`${t("ai-analysis-saved")} · ${planList.map(plan => `${plan.name} ${plan.imageCount}`).join(" · ")}`, "ready");
    showToast(t("ai-analysis-saved"));
    document.getElementById("albumMobileMenu")?.classList.add("hidden");
  } catch (error) {
    if (!progressFinished) {
      progressFinished = finishAiAnalysisProgress("failed", {
        count: seen,
        total: progressTotal,
        detail: String(error?.message || error),
      });
    }
    status(`${t("ai-analysis-failed")}：${String(error?.message || error)}`, "error");
    showToast(t("ai-analysis-failed"));
  } finally {
    if (!progressFinished) finishAiAnalysisProgress("failed", { count: seen, total: progressTotal });
    setRunning(false);
  }
}

export function initAiOrganizer() {
  if (bound) return;
  const button = document.getElementById("albumAiAnalyzeBtn");
  if (!button) return;
  bound = true;
  const controls = document.getElementById("albumAiControls");
  if (controls) controls.classList.toggle("hidden", !getAiBridge());
  button.addEventListener("click", runAiAlbumOrganization);
  status("");
}
