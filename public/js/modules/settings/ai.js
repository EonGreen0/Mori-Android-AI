import { showToast } from "../../utils/index.js";
import { showConfirm } from "../modals.js";
import { t } from "../../i18n/index.js";
import {
  AI_LANGUAGES,
  aiCredentialAvailable,
  authorizeAiEndpoint,
  clearAiCredential,
  getAiBridge,
  readAiConfig,
  saveAiConfig,
  storeAiCredential,
  testAiConnection,
} from "../aiClient.js";

function setStatus(message, state = "idle") {
  const status = document.getElementById("aiCredentialStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function elements() {
  return {
    baseUrl: document.getElementById("aiBaseUrlInput"),
    model: document.getElementById("aiModelInput"),
    key: document.getElementById("aiApiKeyInput"),
    language: document.getElementById("aiOutputLanguageSelect"),
    save: document.getElementById("aiSettingsSaveBtn"),
    test: document.getElementById("aiSettingsTestBtn"),
    clear: document.getElementById("aiApiKeyClearBtn"),
    hint: document.getElementById("aiSettingsHint"),
  };
}

export async function refreshAiSettings() {
  const config = readAiConfig();
  const fields = elements();
  const native = Boolean(getAiBridge());
  if (fields.baseUrl) fields.baseUrl.value = config.baseUrl;
  if (fields.model) fields.model.value = config.model;
  if (fields.language) fields.language.value = config.language;
  const available = await aiCredentialAvailable();
  setStatus(t(available ? "ai-key-ready" : "ai-key-missing"), available ? "ready" : "missing");
  if (fields.save) fields.save.disabled = !native;
  if (fields.clear) fields.clear.disabled = !native || !available;
  if (fields.test) fields.test.disabled = !native || !available || !fields.model?.value.trim();
  if (fields.hint) fields.hint.textContent = native
    ? t("ai-key-native-hint")
    : t("ai-android-only");
}

function readForm() {
  const fields = elements();
  const baseUrl = String(fields.baseUrl?.value || "").trim().replace(/\/+$/, "");
  const model = String(fields.model?.value || "").trim();
  const language = String(fields.language?.value || "zh-Hans");
  if (!/^https:\/\//i.test(baseUrl)) throw new Error(t("ai-invalid-url"));
  if (!model) throw new Error(t("ai-model-required"));
  if (!Object.hasOwn(AI_LANGUAGES, language)) throw new Error(t("ai-language-invalid"));
  return { baseUrl, model, language };
}

export function initAiSettings() {
  const fields = elements();
  if (!fields.save || fields.save.dataset.bound) return;
  fields.save.dataset.bound = "1";

  fields.save.addEventListener("click", async () => {
    fields.save.disabled = true;
    setStatus(t("ai-saving"), "working");
    try {
      const config = readForm();
      const apiKey = String(fields.key?.value || "").trim();
      if (apiKey) storeAiCredential(apiKey, config.baseUrl);
      else if (await aiCredentialAvailable()) authorizeAiEndpoint(config.baseUrl);
      saveAiConfig(config);
      if (fields.key) fields.key.value = "";
      await refreshAiSettings();
      showToast(t("ai-settings-saved"));
    } catch (error) {
      setStatus(String(error?.message || error), "error");
      showToast(t("ai-settings-save-failed"));
    } finally {
      fields.save.disabled = !getAiBridge();
    }
  });

  fields.test?.addEventListener("click", async () => {
    fields.test.disabled = true;
    setStatus(t("ai-testing"), "working");
    let succeeded = false;
    try {
      const apiKey = String(fields.key?.value || "").trim();
      const config = readForm();
      if (apiKey) storeAiCredential(apiKey, config.baseUrl);
      else if (await aiCredentialAvailable()) authorizeAiEndpoint(config.baseUrl);
      if (fields.key) fields.key.value = "";
      saveAiConfig(config);
      await testAiConnection();
      succeeded = true;
      setStatus(t("ai-test-ok"), "ready");
      showToast(t("ai-test-ok"));
    } catch (error) {
      setStatus(`${t("ai-test-failed")}：${String(error?.message || error)}`, "error");
      showToast(t("ai-test-failed"));
    } finally {
      await refreshAiSettings();
      if (succeeded) setStatus(t("ai-test-ok"), "ready");
    }
  });

  fields.clear?.addEventListener("click", () => {
    showConfirm(t("ai-clear-key"), t("ai-clear-key-confirm"), async () => {
      try {
        clearAiCredential();
        if (fields.key) fields.key.value = "";
        await refreshAiSettings();
        showToast(t("ai-key-cleared"));
      } catch (error) {
        setStatus(String(error?.message || error), "error");
      }
    });
  });

  refreshAiSettings();
}
