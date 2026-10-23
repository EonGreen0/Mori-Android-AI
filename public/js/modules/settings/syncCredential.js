import { showToast } from "../../utils/index.js";
import { showConfirm } from "../modals.js";

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || null;
}

function androidBridge() {
  return window.MoriMainBridge || null;
}

function isAndroid() {
  return window.Capacitor?.getPlatform?.() === "android";
}

function validToken(token) {
  return token.length >= 20
    && token.length <= 512
    && /^[A-Za-z0-9_+/=-]+$/.test(token);
}

async function credentialAvailable() {
  if (isAndroid()) {
    try {
      return androidBridge()?.syncCredentialAvailable?.() === true;
    } catch (_) {
      return false;
    }
  }
  const invoke = tauriInvoke();
  if (!invoke) return false;
  try {
    return await invoke("tauri_sync_available") === true;
  } catch (_) {
    return false;
  }
}

async function storeCredential(token) {
  if (isAndroid()) {
    const bridge = androidBridge();
    if (!bridge?.syncCredentialStore) throw new Error("Android secure credential storage is unavailable");
    if (bridge.syncCredentialStore(token) !== true) throw new Error("Android could not store the sync credential");
    return;
  }
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("Windows secure credential storage is unavailable");
  await invoke("tauri_sync_credential_store", { token });
}

async function clearCredential() {
  if (isAndroid()) {
    const bridge = androidBridge();
    if (!bridge?.syncCredentialClear) throw new Error("Android secure credential storage is unavailable");
    if (bridge.syncCredentialClear() !== true) throw new Error("Android could not clear the sync credential");
    return;
  }
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("Windows secure credential storage is unavailable");
  await invoke("tauri_sync_credential_clear");
}

function reloadAfterCredentialChange() {
  window.setTimeout(() => window.location.reload(), 250);
}

export async function refreshSyncCredentialSettings() {
  const status = document.getElementById("syncCredentialStatus");
  const copyButton = document.getElementById("syncCredentialCopyBtn");
  const clearButton = document.getElementById("syncCredentialClearBtn");
  if (!status) return;

  const available = await credentialAvailable();
  status.textContent = available
    ? isAndroid() ? "已配置 · Android Keystore" : "已配置 · Windows DPAPI"
    : "未配置";
  status.dataset.state = available ? "ready" : "missing";
  if (copyButton) {
    copyButton.classList.toggle("hidden", isAndroid() || !available);
    copyButton.disabled = !available;
  }
  if (clearButton) clearButton.disabled = !available;
}

export function initSyncCredentialSettings() {
  const input = document.getElementById("syncCredentialInput");
  const saveButton = document.getElementById("syncCredentialSaveBtn");
  const copyButton = document.getElementById("syncCredentialCopyBtn");
  const clearButton = document.getElementById("syncCredentialClearBtn");
  if (!input || !saveButton || !clearButton) return;

  saveButton.addEventListener("click", async () => {
    const token = String(input.value || "").trim();
    if (!validToken(token)) {
      showToast("同步密钥格式不正确");
      return;
    }
    saveButton.disabled = true;
    try {
      await storeCredential(token);
      input.value = "";
      showToast("个人同步密钥已安全保存");
      await refreshSyncCredentialSettings();
      reloadAfterCredentialChange();
    } catch (error) {
      console.warn("Could not store personal sync credential:", error);
      showToast("保存同步密钥失败");
      saveButton.disabled = false;
    }
  });

  copyButton?.addEventListener("click", async () => {
    const invoke = tauriInvoke();
    if (!invoke || isAndroid()) return;
    copyButton.disabled = true;
    try {
      await invoke("tauri_sync_credential_copy");
      showToast("同步密钥已复制，可粘贴到自己的 Android 设备");
    } catch (error) {
      console.warn("Could not copy personal sync credential:", error);
      showToast("复制同步密钥失败");
    } finally {
      copyButton.disabled = false;
    }
  });

  clearButton.addEventListener("click", () => {
    showConfirm("清除个人同步密钥", "清除后此设备将停止云同步，直到重新保存密钥。", async () => {
      clearButton.disabled = true;
      try {
        await clearCredential();
        input.value = "";
        showToast("此设备的个人同步密钥已清除");
        await refreshSyncCredentialSettings();
        reloadAfterCredentialChange();
      } catch (error) {
        console.warn("Could not clear personal sync credential:", error);
        showToast("清除同步密钥失败");
        clearButton.disabled = false;
      }
    });
  });

  refreshSyncCredentialSettings();
}
