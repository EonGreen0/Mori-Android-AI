import { createCloudflareTransport } from "./cloudflareTransport.js";
import { Filesystem } from "../utils/index.js";
import { findAndroidDisplayFile, saveAndroidDisplayFile, removeAndroidDisplayFile } from "./androidAssetFiles.js";
import {
  androidPlannerWriteSyncAvailable,
  androidReadOnlySyncAvailable,
  createAndroidPlannerWriteAuthenticatedFetch,
  createAndroidReadOnlyAuthenticatedFetch,
} from "./androidAuthenticatedFetch.js";
import { getOrCreateSyncDeviceId } from "./device.js";
import { diffPlannerSyncEnvelopes } from "./mutations.js";
import {
  getPlannerSyncCheckpoint,
  plannerCheckpointKey,
} from "./plannerJournal.js";
import {
  listPlannerOutbox,
  stagePlannerSyncChanges,
} from "./outbox.js";
import {
  pullPlannerRemoteStateReadOnly,
  pullAndMergePlannerRemoteState,
  pushPlannerOutboxOnce,
} from "./syncEngine.js";
import { SYNC_TRANSPORT_CAPABILITIES } from "./transport.js";
import { isAlbumLibraryProject } from "./albumLibrary.js";
import {
  applyPlannerMergedSharedState,
  bindAndroidPlannerDisplayPreviews,
  getSavedPlannerSyncSnapshot,
  normalizeAndroidPlannerSyncCheckpoint,
  getPlannerSyncSnapshot,
  prepareAndroidReadOnlyPlannerProject,
  setAndroidLimitedWriteEnabled,
} from "../modules/planner.js";

const TEST_WORKER = "https://mori-sync-gateway-test.pages.dev";
const MAX_ANDROID_PLANNER_MUTATIONS = 200;
const DIRECTORY_CACHE_KEY = "mori_android_planner_directory_v1";
let busy = false;
let plannerWriteEnabled = false;
let initialized = false;

function isAndroid() {
  return window.Capacitor?.getPlatform?.() === "android";
}

function elements() {
  return {
    controls: document.getElementById("plannerAndroidCloudControls"),
    select: document.getElementById("plannerAndroidCloudProject"),
    reloadButton: document.getElementById("plannerAndroidCloudReloadBtn"),
    button: document.getElementById("plannerAndroidCloudRefreshBtn"),
    resetButton: document.getElementById("plannerAndroidCloudRedownloadBtn"),
    status: document.getElementById("plannerAndroidCloudStatus"),
    writeButton: document.getElementById("plannerMobileUploadChangesBtn"),
    addTextButton: document.getElementById("plannerMobileAddTextBtn"),
  };
}

function setStatus(text, state = "idle") {
  const { status } = elements();
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

function setBusy(value) {
  busy = value;
  setAndroidLimitedWriteEnabled(plannerWriteEnabled && !value);
  const { button, resetButton, select, reloadButton, writeButton, addTextButton } = elements();
  if (button) {
    button.disabled = value || !select?.value;
    button.textContent = value ? "刷新中…" : "从云端刷新";
  }
  if (select) select.disabled = value || !select.options.length;
  if (reloadButton) {
    reloadButton.disabled = value;
    reloadButton.textContent = "刷新同步列表";
  }
  if (resetButton) resetButton.disabled = value || !select?.value;
  if (writeButton) writeButton.disabled = value || !plannerWriteEnabled;
  if (addTextButton) addTextButton.disabled = value || !plannerWriteEnabled;
}

function transport() {
  const capabilities = [
    SYNC_TRANSPORT_CAPABILITIES.PROJECT_DIRECTORY,
    SYNC_TRANSPORT_CAPABILITIES.CHANGES,
    SYNC_TRANSPORT_CAPABILITIES.ASSET_DISPLAY_DOWNLOAD,
  ];
  if (plannerWriteEnabled) capabilities.push(SYNC_TRANSPORT_CAPABILITIES.MUTATIONS);
  return createCloudflareTransport({
    id: "cloudflare-android-readonly-test",
    baseUrl: TEST_WORKER,
    nativeAuth: true,
    capabilities,
    fetchImpl: plannerWriteEnabled
      ? createAndroidPlannerWriteAuthenticatedFetch()
      : createAndroidReadOnlyAuthenticatedFetch(),
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function createAndroidPreviewResult(nodeCount = 0) {
  return {
    bindings: [],
    cachedCount: 0,
    reusedCount: 0,
    missingCount: 0,
    missingMetadataCount: 0,
    cloudMissingCount: 0,
    authFailedCount: 0,
    networkFailedCount: 0,
    downloadFailedCount: 0,
    emptyResponseCount: 0,
    incompleteResponseCount: 0,
    cacheWriteFailedCount: 0,
    failures: [],
    nodeCount,
  };
}

function addAndroidPreviewFailure(preview, assetId, category, error = null, fallbackReason = "preview_unavailable") {
  const status = Number(error?.status) > 0 ? Number(error.status) : null;
  const reason = String(error?.code || error?.message || fallbackReason)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 100);
  preview.missingCount += 1;
  preview[category] += 1;
  preview.failures.push({ assetId, category, status, reason });
  console.warn(`Planner display preview ${category} for ${assetId}:`, status ? `HTTP ${status}` : reason);
}

function androidPreviewDownloadFailureCategory(error) {
  const status = Number(error?.status) || 0;
  if (status === 404) return "cloudMissingCount";
  if (status === 401 || status === 403) return "authFailedCount";
  if (!status || status >= 500 || error?.name === "AbortError") return "networkFailedCount";
  return "downloadFailedCount";
}

function androidPreviewCompletion(result, preview) {
  const prefix = `已刷新 · revision ${result.cursor ?? "-"} · ${result.receivedCount ?? 0} 条`;
  if (!preview.nodeCount) return { text: prefix, state: "success" };

  const imageSummary = `本地图片 ${preview.bindings.length}/${preview.nodeCount} · 新下载 ${preview.cachedCount - preview.reusedCount} · 复用 ${preview.reusedCount}`;
  if (!preview.missingCount) {
    return {
      text: `${prefix} · ${imageSummary}`,
      state: "success",
    };
  }

  const issues = [];
  const advice = [];
  const appendIssue = (count, label, category) => {
    if (!count) return;
    const details = [...new Set(preview.failures
      .filter((failure) => failure.category === category)
      .map((failure) => failure.status ? `HTTP ${failure.status}` : failure.reason)
      .filter(Boolean))].slice(0, 2);
    issues.push(`${label} ${count}${details.length ? `（${details.join("、")}）` : ""}`);
  };

  appendIssue(preview.missingMetadataCount, "策划资源元数据缺失", "missingMetadataCount");
  appendIssue(preview.cloudMissingCount, "云端预览对象缺失", "cloudMissingCount");
  appendIssue(preview.authFailedCount, "认证失败", "authFailedCount");
  appendIssue(preview.networkFailedCount, "网络/服务失败", "networkFailedCount");
  appendIssue(preview.downloadFailedCount, "下载被拒绝", "downloadFailedCount");
  appendIssue(preview.emptyResponseCount, "云端响应为空", "emptyResponseCount");
  appendIssue(preview.incompleteResponseCount, "云端图片内容不完整", "incompleteResponseCount");
  appendIssue(preview.cacheWriteFailedCount, "本地图片保存失败", "cacheWriteFailedCount");

  if (preview.missingMetadataCount) advice.push("重新同步策划资源元数据");
  if (preview.cloudMissingCount) advice.push("确认 Windows 端预览已成功上传后重试");
  if (preview.authFailedCount) advice.push("检查 Android 个人同步密钥后重试");
  if (preview.networkFailedCount || preview.downloadFailedCount) advice.push("检查网络和同步服务后重试");
  if (preview.emptyResponseCount) advice.push("确认云端预览内容完整后重试");
  if (preview.incompleteResponseCount) advice.push("刷新资源信息后重试下载");
  if (preview.cacheWriteFailedCount) advice.push("检查设备存储空间后重试");

  return {
    text: `${prefix} · ${imageSummary} · 预览未完成：${issues.join("；")}。${advice.join("；")}`,
    state: "warning",
  };
}

async function cachePlannerDisplayPreviews(syncTransport, shared, { forceDownload = false, onProgress = setStatus } = {}) {
  const imageNodes = (Array.isArray(shared?.nodes) ? shared.nodes : [])
    .filter((node) => node?.type === "image");
  const preview = createAndroidPreviewResult(imageNodes.length);
  const nodesByAsset = new Map();
  imageNodes.forEach((node) => {
    if (!node.assetId) {
      addAndroidPreviewFailure(preview, "", "missingMetadataCount", null, "asset_id_missing");
      return;
    }
    const assetId = String(node.assetId);
    const nodes = nodesByAsset.get(assetId) || [];
    nodes.push(node);
    nodesByAsset.set(assetId, nodes);
  });
  const assetsById = new Map(
    (Array.isArray(shared?.assets) ? shared.assets : [])
      .filter((asset) => asset?.id)
      .map((asset) => [String(asset.id), asset]),
  );
  let index = 0;

  for (const [assetId, nodes] of nodesByAsset.entries()) {
    index += 1;
    const asset = assetsById.get(assetId);
    if (!asset?.display?.hash) {
      addAndroidPreviewFailure(preview, assetId, "missingMetadataCount", null, "asset_metadata_missing");
      continue;
    }
    if (forceDownload) {
      try {
        await removeAndroidDisplayFile(Filesystem, asset);
      } catch (error) {
        addAndroidPreviewFailure(preview, assetId, "cacheWriteFailedCount", error, "local_image_reset_failed");
        continue;
      }
    }
    const existingUri = forceDownload ? "" : await findAndroidDisplayFile(Filesystem, asset);
    if (existingUri) {
      nodes.forEach((node) => preview.bindings.push({ nodeId: node.id, assetId, uri: existingUri }));
      preview.cachedCount += 1;
      preview.reusedCount += 1;
      continue;
    }
    onProgress(`正在下载图片到本地 ${index}/${nodesByAsset.size}…`, "working");
    let bytes;
    try {
      const downloaded = await syncTransport.downloadDisplayAsset({ assetId });
      bytes = downloaded?.bytes instanceof Uint8Array
        ? downloaded.bytes
        : new Uint8Array(downloaded?.bytes || []);
    } catch (error) {
      addAndroidPreviewFailure(preview, assetId, androidPreviewDownloadFailureCategory(error), error);
      continue;
    }
    if (!bytes.length) {
      addAndroidPreviewFailure(preview, assetId, "emptyResponseCount", null, "empty_display_response");
      continue;
    }
    if (Number(asset.display.bytes) > 0 && bytes.length !== Number(asset.display.bytes)) {
      addAndroidPreviewFailure(preview, assetId, "incompleteResponseCount", null, "display_size_mismatch");
      continue;
    }
    try {
      const uri = await saveAndroidDisplayFile(Filesystem, asset, bytes, bytesToBase64(bytes));
      nodes.forEach((node) => preview.bindings.push({ nodeId: node.id, assetId, uri }));
      preview.cachedCount += 1;
    } catch (error) {
      addAndroidPreviewFailure(preview, assetId, "cacheWriteFailedCount", error);
    }
  }
  return preview;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((output, key) => {
      output[key] = stableValue(value[key]);
      return output;
    }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableWithoutFields(value, fields) {
  const copy = structuredClone(value || {});
  fields.forEach((field) => delete copy[field]);
  return stableJson(copy);
}

function isAllowedPlannerMutation(mutation, previousShared, nextShared) {
  const type = mutation?.payload?.type;
  if (
    mutation?.entityType !== "node" ||
    mutation?.operation !== "upsert" ||
    !["text", "image"].includes(type) ||
    String(mutation?.entityId || "") !== String(mutation?.payload?.id || "")
  ) {
    return false;
  }
  const nodeId = String(mutation.entityId);
  const previous = previousShared?.nodes?.find((node) => String(node?.id || "") === nodeId);
  const next = nextShared?.nodes?.find((node) => String(node?.id || "") === nodeId);
  if (!previous || !next || previous.type !== type || next.type !== type) return false;

  const positionChanged = previous.x !== next.x || previous.y !== next.y;
  const widthChanged = previous.w !== next.w;
  const rotationChanged = previous.rotation !== next.rotation;

  if (type === "image") {
    if (widthChanged) {
      if (next.userSized !== true) return false;
      return stableWithoutFields(previous, ["x", "y", "w", "userSized", "commentScale"])
        === stableWithoutFields(next, ["x", "y", "w", "userSized", "commentScale"]);
    }
    if (rotationChanged) {
      return stableWithoutFields(previous, ["rotation"])
        === stableWithoutFields(next, ["rotation"]);
    }
    if (!positionChanged) return false;
    return stableWithoutFields(previous, ["x", "y"]) === stableWithoutFields(next, ["x", "y"]);
  }

  const textChanged = String(previous.text || "") !== String(next.text || "");
  if (widthChanged && !textChanged) {
    if (next.userSized !== true) return false;
    return stableWithoutFields(previous, ["x", "y", "w", "userSized"])
      === stableWithoutFields(next, ["x", "y", "w", "userSized"]);
  }
  if (textChanged === positionChanged) return false;
  if (textChanged) {
    if ((previous.userSized === true || next.userSized === true) && previous.w !== next.w) return false;
    return stableWithoutFields(previous, ["text", "w"]) === stableWithoutFields(next, ["text", "w"]);
  }
  return stableWithoutFields(previous, ["x", "y"]) === stableWithoutFields(next, ["x", "y"]);
}

function isAllowedSingleTextCreateMutation(mutation, previousShared, nextShared) {
  if (
    mutation?.entityType !== "node" ||
    mutation?.operation !== "upsert" ||
    mutation?.payload?.type !== "text" ||
    String(mutation?.entityId || "") !== String(mutation?.payload?.id || "")
  ) {
    return false;
  }
  const nodeId = String(mutation.entityId);
  if (plannerNodeById(previousShared, nodeId)) return false;
  const nextNode = plannerNodeById(nextShared, nodeId);
  if (!nextNode || nextNode.type !== "text") return false;
  if (nextNode.assetId || Object.prototype.hasOwnProperty.call(nextNode, "memberIds")) return false;
  if (["path", "uri", "thumbnail", "fileKey"].some((field) => Object.prototype.hasOwnProperty.call(nextNode, field))) {
    return false;
  }
  if (stableJson(previousShared?.project) !== stableJson(nextShared?.project)) return false;
  if (stableJson(previousShared?.edges || []) !== stableJson(nextShared?.edges || [])) return false;
  if (stableJson(previousShared?.assets || []) !== stableJson(nextShared?.assets || [])) return false;

  const previousNodes = previousShared?.nodes || [];
  const nextNodesWithoutCreated = (nextShared?.nodes || []).filter((node) => String(node?.id || "") !== nodeId);
  if (stableJson(previousNodes) !== stableJson(nextNodesWithoutCreated)) return false;
  return stableJson(nextNode) === stableJson(mutation.payload);
}

function plannerNodeById(shared, nodeId) {
  return shared?.nodes?.find((node) => String(node?.id || "") === String(nodeId || "")) || null;
}

function purePositionChange(previous, next) {
  if (!previous || !next || previous.type !== next.type) return false;
  if (previous.x === next.x && previous.y === next.y) return false;
  return stableWithoutFields(previous, ["x", "y"]) === stableWithoutFields(next, ["x", "y"]);
}

function sameTranslation(previous, next, dx, dy) {
  const nextDx = Number(next.x) - Number(previous.x);
  const nextDy = Number(next.y) - Number(previous.y);
  return Math.abs(nextDx - dx) <= 1e-6 && Math.abs(nextDy - dy) <= 1e-6;
}

function plannerNodeElement(nodeId) {
  return document.querySelector(`.planner-node[data-node-id="${CSS.escape(String(nodeId || ""))}"]`);
}

function expectedGroupMoveNodeIds(group, previousShared) {
  const nodes = Array.isArray(previousShared?.nodes) ? previousShared.nodes : [];
  const byId = new Map(nodes.map((node) => [String(node?.id || ""), node]));
  const explicit = Array.isArray(group?.memberIds) ? group.memberIds.map(String).filter(Boolean) : [];
  if (explicit.length) {
    return new Set([
      String(group.id),
      ...explicit.filter((nodeId) => byId.has(nodeId)),
    ]);
  }

  const groupEl = plannerNodeElement(group?.id);
  if (!groupEl) return null;
  const groupRight = Number(group.x) + groupEl.offsetWidth;
  const groupBottom = Number(group.y) + groupEl.offsetHeight;
  const ids = new Set([String(group.id)]);
  for (const node of nodes) {
    if (!node?.id || node.id === group.id || node.type === "group") continue;
    const el = plannerNodeElement(node.id);
    if (!el) return null;
    const cx = Number(node.x) + el.offsetWidth / 2;
    const cy = Number(node.y) + el.offsetHeight / 2;
    if (cx >= Number(group.x) && cx <= groupRight && cy >= Number(group.y) && cy <= groupBottom) {
      ids.add(String(node.id));
    }
  }
  return ids;
}

function isAllowedGroupTranslationBatch(mutations, previousShared, nextShared) {
  const groupMutations = mutations.filter((mutation) => mutation?.payload?.type === "group");
  if (groupMutations.length !== 1) return false;
  const groupMutation = groupMutations[0];
  const groupId = String(groupMutation.entityId || "");
  const previousGroup = plannerNodeById(previousShared, groupId);
  const nextGroup = plannerNodeById(nextShared, groupId);
  if (!previousGroup || !nextGroup || previousGroup.type !== "group" || nextGroup.type !== "group") return false;
  if (!purePositionChange(previousGroup, nextGroup)) return false;

  const expectedIds = expectedGroupMoveNodeIds(previousGroup, previousShared);
  if (!expectedIds || expectedIds.size !== mutations.length) return false;
  const actualIds = new Set(mutations.map((mutation) => String(mutation?.entityId || "")));
  if (actualIds.size !== expectedIds.size || [...expectedIds].some((nodeId) => !actualIds.has(nodeId))) return false;

  const dx = Number(nextGroup.x) - Number(previousGroup.x);
  const dy = Number(nextGroup.y) - Number(previousGroup.y);
  return mutations.every((mutation) => {
    const type = mutation?.payload?.type;
    if (
      mutation?.entityType !== "node" ||
      mutation?.operation !== "upsert" ||
      !["text", "image", "group"].includes(type) ||
      String(mutation?.entityId || "") !== String(mutation?.payload?.id || "")
    ) {
      return false;
    }
    const previous = plannerNodeById(previousShared, mutation.entityId);
    const next = plannerNodeById(nextShared, mutation.entityId);
    return purePositionChange(previous, next) && sameTranslation(previous, next, dx, dy);
  });
}

function isAllowedSingleNodeDeleteBatch(mutations, previousShared, nextShared) {
  const nodeDeletes = mutations.filter(
    (mutation) => mutation?.entityType === "node" && mutation?.operation === "delete",
  );
  if (nodeDeletes.length !== 1) return false;
  const targetId = String(nodeDeletes[0]?.entityId || "");
  const previousTarget = plannerNodeById(previousShared, targetId);
  if (!previousTarget || !["text", "image", "group"].includes(previousTarget.type)) return false;
  if (plannerNodeById(nextShared, targetId)) return false;
  if (stableJson(previousShared?.project) !== stableJson(nextShared?.project)) return false;

  const expectedNodes = (previousShared?.nodes || [])
    .filter((node) => String(node?.id || "") !== targetId)
    .map((node) => {
      if (node?.type !== "group" || !Array.isArray(node.memberIds)) return structuredClone(node);
      return {
        ...structuredClone(node),
        memberIds: node.memberIds.filter((memberId) => String(memberId) !== targetId),
      };
    });
  const expectedEdges = (previousShared?.edges || []).filter(
    (edge) => String(edge?.from || "") !== targetId && String(edge?.to || "") !== targetId,
  );
  const remainingAssetIds = new Set(
    expectedNodes
      .filter((node) => node?.type === "image" && node?.assetId)
      .map((node) => String(node.assetId)),
  );
  const expectedAssets = (previousShared?.assets || []).filter((asset) =>
    remainingAssetIds.has(String(asset?.id || "")),
  );

  if (stableJson(expectedNodes) !== stableJson(nextShared?.nodes || [])) return false;
  if (stableJson(expectedEdges) !== stableJson(nextShared?.edges || [])) return false;
  if (stableJson(expectedAssets) !== stableJson(nextShared?.assets || [])) return false;

  return mutations.every((mutation) => {
    if (mutation?.operation === "delete") {
      return mutation.payload == null && ["node", "edge", "asset"].includes(mutation.entityType);
    }
    if (mutation?.operation !== "upsert" || mutation?.entityType !== "node") return false;
    return mutation?.payload?.type === "group"
      && String(mutation?.payload?.id || "") === String(mutation?.entityId || "");
  });
}

function isAllowedPlannerMutationBatch(mutations, previousShared, nextShared) {
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > MAX_ANDROID_PLANNER_MUTATIONS) {
    return false;
  }
  if (mutations.length === 1) {
    if (isAllowedPlannerMutation(mutations[0], previousShared, nextShared)) return true;
    if (isAllowedSingleTextCreateMutation(mutations[0], previousShared, nextShared)) return true;
  }
  if (isAllowedSingleNodeDeleteBatch(mutations, previousShared, nextShared)) return true;
  return isAllowedGroupTranslationBatch(mutations, previousShared, nextShared);
}

function assertPendingPlannerMutation(mutation) {
  if (mutation?.operation === "delete") {
    if (!['node', 'edge', 'asset'].includes(mutation?.entityType) || mutation?.payload != null) {
      throw new Error("Android 删除批次包含无效 delete mutation");
    }
    return;
  }

  const type = mutation?.payload?.type;
  const payload = mutation?.payload || {};
  const hasLocalImageField = ["path", "uri", "thumbnail", "fileKey"].some((field) =>
    Object.prototype.hasOwnProperty.call(payload, field),
  );
  const invalidMembers = type === "group"
    ? !Array.isArray(payload.memberIds)
    : Object.prototype.hasOwnProperty.call(payload, "memberIds");
  if (
    mutation?.entityType !== "node" ||
    mutation?.operation !== "upsert" ||
    !["text", "image", "group"].includes(type) ||
    String(mutation?.entityId || "") !== String(payload.id || "") ||
    hasLocalImageField ||
    invalidMembers
  ) {
    throw new Error("Android 当前只允许上传受限 Planner 节点修改");
  }
}

function assertPendingPlannerMutationBatch(mutations) {
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > MAX_ANDROID_PLANNER_MUTATIONS) {
    throw new Error("Android Planner 待上传批次大小无效");
  }
  mutations.forEach(assertPendingPlannerMutation);

  const nodeDeletes = mutations.filter(
    (mutation) => mutation?.entityType === "node" && mutation?.operation === "delete",
  );
  if (nodeDeletes.length) {
    if (nodeDeletes.length !== 1) throw new Error("Android 一次只允许删除一个节点");
    const invalidDeleteCompanion = mutations.some((mutation) => {
      if (mutation?.operation === "delete") return !["node", "edge", "asset"].includes(mutation?.entityType);
      return mutation?.operation !== "upsert"
        || mutation?.entityType !== "node"
        || mutation?.payload?.type !== "group";
    });
    if (invalidDeleteCompanion) throw new Error("Android 删除批次包含非必要伴随修改");
    return;
  }

  if (mutations.length > 1) {
    const groupCount = mutations.filter((mutation) => mutation?.payload?.type === "group").length;
    if (groupCount !== 1) throw new Error("Android 批量上传只允许一个组合框整体平移批次");
  }
}

function renderProjectDirectory(projects, preferredId = elements().select?.value) {
  const { select } = elements();
  if (!select) return;
  select.replaceChildren();
  projects.filter(project => !isAlbumLibraryProject(project.projectId)).forEach((project) => {
    const option = document.createElement("option");
    option.value = String(project.projectId || "");
    option.textContent = `${project.title || "未命名策划"} · r${Number(project.revision) || 0}`;
    option.dataset.title = String(project.title || "");
    select.appendChild(option);
  });
  if (preferredId && projects.some((project) => project.projectId === preferredId)) select.value = preferredId;
}

function restoreCachedProjectDirectory() {
  try {
    const cached = JSON.parse(localStorage.getItem(DIRECTORY_CACHE_KEY) || "null");
    if (cached?.baseUrl !== TEST_WORKER || !Array.isArray(cached.projects)) return;
    const projects = cached.projects.filter(project => typeof project?.projectId === "string" && project.projectId);
    renderProjectDirectory(projects, cached.selectedProjectId);
  } catch (_) {
    // An unavailable/damaged cache must not block a fresh directory request.
  }
}

async function refreshProjectDirectory(syncTransport) {
  const response = await syncTransport.listProjects({ limit: 100 });
  if (!Array.isArray(response?.projects)) throw new Error("云端列表响应无效");
  const projects = response.projects.filter(project => project?.projectId && !isAlbumLibraryProject(project.projectId)).map(project => ({
    projectId: String(project.projectId),
    title: String(project.title || ""),
    revision: Number(project.revision) || 0,
  }));
  renderProjectDirectory(projects);
  try {
    localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify({
      baseUrl: TEST_WORKER, projects, selectedProjectId: elements().select?.value || "",
    }));
  } catch (_) {
    // A successful cloud response stays usable even when local storage is full.
  }
  return projects;
}

async function reloadProjectDirectory(syncTransport) {
  if (busy) return;
  setBusy(true);
  const { reloadButton } = elements();
  if (reloadButton) reloadButton.textContent = "读取列表中…";
  setStatus("正在读取云端策划列表…", "working");
  try {
    const projects = await refreshProjectDirectory(syncTransport);
    const mode = plannerWriteEnabled ? "Android · 有限编辑" : "Android 只读";
    setStatus(projects.length ? `${mode} · ${projects.length} 个云端策划` : "云端暂无策划", "idle");
  } catch (error) {
    const preserved = elements().select?.options.length ? "已保留上次列表；" : "";
    setStatus(`云端列表读取失败：${String(error?.message || error)}。${preserved}请点击“刷新同步列表”重试`, "error");
  } finally {
    setBusy(false);
  }
}

async function refreshSelectedProject(syncTransport, { resetImages = false } = {}) {
  if (busy) return;
  const { select } = elements();
  const projectId = String(select?.value || "");
  if (!projectId) {
    setStatus("请选择一个云端策划后再刷新", "error");
    return;
  }
  const title = select.selectedOptions?.[0]?.dataset?.title || "";
  setBusy(true);
  try {
    setStatus("正在准备 Android 云端副本…", "working");
    const prepared = await prepareAndroidReadOnlyPlannerProject({ projectId, title });
    const pending = await listPlannerOutbox({ projectId, limit: 1 });
    if (pending.length) throw new Error("Android 存在待上传修改，请先上传后再刷新");
    setStatus("正在拉取云端策划…", "working");
    const result = await pullPlannerRemoteStateReadOnly({
      transport: syncTransport,
      projectId,
      fromStart: resetImages,
      applyRemoteShared: (shared) => applyPlannerMergedSharedState(shared, {
        expectedProjectId: projectId,
        expectedGeneration: prepared.generation,
      }),
    });
    if (result.status !== "ok") throw new Error(`Android 刷新被阻止：${result.reason || result.status}`);
    const pendingAfter = await listPlannerOutbox({ projectId, limit: 1 });
    if (pendingAfter.length) throw new Error("Android 刷新意外产生 Outbox，已停止");

    let preview = createAndroidPreviewResult(0);
    if (result.merged?.nodes?.some((node) => node?.type === "image")) {
      setStatus("正在准备图片预览…", "working");
      preview = await cachePlannerDisplayPreviews(syncTransport, result.merged, { forceDownload: resetImages });
      bindAndroidPlannerDisplayPreviews(preview.bindings, { resetSyncedImages: resetImages, expectedProjectId: projectId });
    }
    const completion = androidPreviewCompletion(result, preview);
    setStatus(`${resetImages ? "重新下载结果 · " : ""}${completion.text}`, completion.state);
    return { ...result, preview };
  } catch (error) {
    setStatus(`刷新失败：${String(error?.message || error)}`, "error");
    throw error;
  } finally {
    setBusy(false);
  }
}

async function uploadPlannerChange(syncTransport) {
  if (busy) return;
  if (!plannerWriteEnabled) throw new Error("当前 Android 构建未启用 Planner 写入");
  const { writeButton } = elements();
  if (document.activeElement?.isContentEditable) document.activeElement.blur();
  setBusy(true);
  try {
    const snapshot = await getPlannerSyncSnapshot();
    const projectId = snapshot.projectId;
    const deviceId = getOrCreateSyncDeviceId();
    let pending = await listPlannerOutbox({ projectId, limit: MAX_ANDROID_PLANNER_MUTATIONS + 1 });

    if (!pending.length) {
      const previous = normalizeAndroidPlannerSyncCheckpoint(await getPlannerSyncCheckpoint(projectId));
      if (!previous) throw new Error("请先从云端刷新当前策划，再进行编辑");
      const mutations = diffPlannerSyncEnvelopes(previous, snapshot.shared, { deviceId });
      if (!mutations.length) {
        setStatus("没有待上传的修改", "idle");
        return { status: "idle", submittedCount: 0 };
      }
      if (!isAllowedPlannerMutationBatch(mutations, previous, snapshot.shared)) {
        throw new Error("当前只允许受限节点编辑、组合框整体平移，或一次删除一个已有节点");
      }
      await stagePlannerSyncChanges({
        mutations,
        checkpointKey: plannerCheckpointKey(projectId),
        checkpointValue: snapshot.shared,
      });
      await getPlannerSyncSnapshot({
        expectedProjectId: projectId,
        expectedGeneration: snapshot.generation,
      });
      pending = await listPlannerOutbox({ projectId, limit: MAX_ANDROID_PLANNER_MUTATIONS + 1 });
    }

    assertPendingPlannerMutationBatch(pending);
    let result = null;
    let submittedCount = 0;
    let conflictCount = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      const current = await getPlannerSyncSnapshot({
        expectedProjectId: projectId, expectedGeneration: snapshot.generation,
      });
      setStatus("正在合并云端修改…", "working");
      const merged = await pullAndMergePlannerRemoteState({
        transport: syncTransport, projectId, localShared: current.shared, deviceId,
        rebasePendingOutbox: true,
        applyMergedShared: (shared) => applyPlannerMergedSharedState(shared, {
          expectedProjectId: projectId, expectedGeneration: snapshot.generation,
        }),
      });
      if (merged.status !== "ok") throw new Error(merged.reason || "云端合并未完成");
      conflictCount += merged.conflictCount;
      pending = await listPlannerOutbox({ projectId, limit: MAX_ANDROID_PLANNER_MUTATIONS + 1 });
      if (!pending.length) {
        result = { status: "ok", cursor: merged.cursor, submittedCount, conflictCount };
        break;
      }
      if (pass === 4) throw new Error("其他设备仍在修改，请稍后重试；本地修改已保留");
      assertPendingPlannerMutationBatch(pending);
      setStatus(`正在上传 ${pending.length} 条修改…`, "working");
      if (writeButton) writeButton.textContent = "上传中…";
      const pushed = await pushPlannerOutboxOnce({
        transport: syncTransport, projectId, deviceId,
        rawLimit: MAX_ANDROID_PLANNER_MUTATIONS + 1,
        mutationLimit: MAX_ANDROID_PLANNER_MUTATIONS,
      });
      submittedCount += pushed.submittedCount;
      if (pushed.status !== "ok" && !(pushed.rejected?.length &&
          pushed.rejected.every(item => item.code === "revision_conflict"))) {
        throw new Error(pushed.error || "Planner 修改批次未全部收到云端确认");
      }
    }
    setStatus(`修改已同步 · revision ${result.cursor ?? "-"}${conflictCount ? ' · 已合并冲突 ' + conflictCount : ''}`, "success");
    return result;
  } catch (error) {
    setStatus(`上传失败：${String(error?.message || error)}`, "error");
    throw error;
  } finally {
    if (writeButton) writeButton.textContent = writeButton.dataset.albumBound ? "同步相册" : "上传修改";
    setBusy(false);
  }
}

export async function initAndroidPlannerSync() {
  if (!isAndroid() || initialized) return;
  const { controls, button, resetButton, reloadButton, writeButton, addTextButton } = elements();
  controls?.classList.remove("hidden");
  plannerWriteEnabled = androidPlannerWriteSyncAvailable();
  setAndroidLimitedWriteEnabled(plannerWriteEnabled);
  if (writeButton) {
    writeButton.classList.toggle("hidden", !plannerWriteEnabled);
    writeButton.disabled = !plannerWriteEnabled;
  }
  if (addTextButton) {
    addTextButton.classList.toggle("hidden", !plannerWriteEnabled);
    addTextButton.disabled = !plannerWriteEnabled;
  }
  if (!androidReadOnlySyncAvailable()) {
    if (button) button.disabled = true;
    if (resetButton) resetButton.disabled = true;
    if (reloadButton) reloadButton.disabled = true;
    setStatus("当前设备未配置个人同步密钥", "idle");
    return;
  }
  const syncTransport = transport();
  initialized = true;
  restoreCachedProjectDirectory();
  reloadButton?.addEventListener("click", () => reloadProjectDirectory(syncTransport));
  button?.addEventListener("click", () => {
    refreshSelectedProject(syncTransport).catch((error) => {
      setStatus(`刷新失败：${String(error?.message || error)}`, "error");
      console.warn("Android sync refresh stopped:", error);
    });
  });
  resetButton?.addEventListener("click", () => {
    if (busy) return;
    const title = elements().select?.selectedOptions?.[0]?.dataset?.title || "所选策划";
    if (!window.confirm(`重新下载“${title}”的图片？\n将删除该策划的手机同步图片缓存并重新下载。策划内容、相册原图和云端数据保留。其他策划引用同一张图片时也会使用重新下载的文件。`)) return;
    refreshSelectedProject(syncTransport, { resetImages: true }).catch((error) => {
      console.warn("Android image redownload stopped:", error);
    });
  });
  writeButton?.addEventListener("click", () => {
    uploadPlannerChange(syncTransport).catch((error) => console.warn("Android planner-write sync stopped:", error));
  });
  await reloadProjectDirectory(syncTransport);
}

// Album sync owns the visible directory and the single download action. Keep
// the existing restricted Planner writer and merge protocol behind that action.
export function initAndroidAlbumPlannerControls() {
  if (!isAndroid()) return;
  plannerWriteEnabled = androidPlannerWriteSyncAvailable();
  setAndroidLimitedWriteEnabled(plannerWriteEnabled);
  const { controls, writeButton, addTextButton } = elements();
  controls?.classList.add("hidden");
  for (const button of [writeButton, addTextButton]) {
    button?.classList.toggle("hidden", !plannerWriteEnabled);
    if (button) button.disabled = !plannerWriteEnabled;
  }
  if (writeButton && !writeButton.dataset.albumBound) {
    writeButton.dataset.albumBound = "1";
    writeButton.textContent = "同步相册";
    writeButton.addEventListener("click", () => window.dispatchEvent(new CustomEvent("mori_album_sync_requested")));
  }
}

export async function uploadAndroidAlbumPlannerChanges(album) {
  if (album?.localPackage || String(album?.plannerProjectId || "").startsWith("local-album-plan:")) throw new Error("本地导入的相册只用于离线查看，无需云同步");
  if (!album?.plannerProjectId) return;
  if (document.activeElement?.isContentEditable) document.activeElement.blur();
  const saved = await getSavedPlannerSyncSnapshot(album.plannerProjectId);
  if (!saved) return;
  const previous = normalizeAndroidPlannerSyncCheckpoint(await getPlannerSyncCheckpoint(album.plannerProjectId));
  const pending = await listPlannerOutbox({ projectId: album.plannerProjectId, limit: 1 });
  if (!pending.length && previous && !diffPlannerSyncEnvelopes(previous, saved.shared).length) return;
  if (!previous) {
    if (!saved.shared.nodes.length && !saved.shared.edges.length) return;
    throw new Error("手机已有同身份策划但缺少同步记录，已保留内容；需要先恢复同步记录或备份后从电脑重建");
  }
  if (!androidPlannerWriteSyncAvailable()) {
    throw new Error("相册策划有手机修改，当前设备不能上传；已保留修改，未覆盖下载");
  }
  await prepareAndroidReadOnlyPlannerProject({ projectId: album.plannerProjectId, albumId: album.id });
  plannerWriteEnabled = true;
  return uploadPlannerChange(transport());
}

export async function assertAndroidAlbumPlannerCanDownload(projectId) {
  const pending = await listPlannerOutbox({ projectId, limit: 1 });
  if (pending.length) throw new Error("相册策划仍有待上传修改，未覆盖手机内容");
  const saved = await getSavedPlannerSyncSnapshot(projectId);
  if (!saved) return;
  const previous = normalizeAndroidPlannerSyncCheckpoint(await getPlannerSyncCheckpoint(projectId));
  if (!previous && saved.shared.nodes.length) throw new Error("手机已有同身份策划尚未建立同步记录，未覆盖本地内容");
  if (previous && diffPlannerSyncEnvelopes(previous, saved.shared).length) {
    throw new Error("本次未能上传手机策划修改，已保留内容；请重新点击“同步相册”");
  }
}

export { cachePlannerDisplayPreviews };
