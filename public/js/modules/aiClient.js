// Android-native AI transport. API keys stay in Android Keystore and are
// attached by the native bridge; JavaScript only receives model output.

export const AI_LANGUAGES = Object.freeze({
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "English",
});

export const AI_SETTINGS = Object.freeze({
  BASE_URL: "mori_ai_base_url",
  MODEL: "mori_ai_model",
  LANGUAGE: "mori_ai_language",
});

let requestSequence = 0;

export function getAiBridge() {
  const bridge = window.MoriMainBridge;
  return bridge && typeof bridge.aiRequestAsync === "function" ? bridge : null;
}

export function readAiConfig() {
  return {
    baseUrl: String(localStorage.getItem(AI_SETTINGS.BASE_URL) || "https://api.openai.com/v1").trim(),
    model: String(localStorage.getItem(AI_SETTINGS.MODEL) || "").trim(),
    language: Object.hasOwn(AI_LANGUAGES, localStorage.getItem(AI_SETTINGS.LANGUAGE))
      ? localStorage.getItem(AI_SETTINGS.LANGUAGE)
      : "zh-Hans",
  };
}

export function saveAiConfig(config = {}) {
  if (config.baseUrl !== undefined) localStorage.setItem(AI_SETTINGS.BASE_URL, String(config.baseUrl).trim());
  if (config.model !== undefined) localStorage.setItem(AI_SETTINGS.MODEL, String(config.model).trim());
  if (config.language !== undefined && Object.hasOwn(AI_LANGUAGES, config.language)) {
    localStorage.setItem(AI_SETTINGS.LANGUAGE, config.language);
  }
}

export async function aiCredentialAvailable(bridge = getAiBridge()) {
  try {
    return bridge?.aiCredentialAvailable?.() === true;
  } catch (_) {
    return false;
  }
}

export function storeAiCredential(apiKey, baseUrl, bridge = getAiBridge()) {
  if (!bridge?.aiCredentialStore) throw new Error("Android AI credential storage is unavailable");
  if (bridge.aiCredentialStore(String(apiKey || ""), String(baseUrl || "")) !== true) {
    throw new Error("无法保存 AI API Key");
  }
}

export function authorizeAiEndpoint(baseUrl, bridge = getAiBridge()) {
  if (!bridge?.aiEndpointAuthorize) throw new Error("Android AI endpoint authorization is unavailable");
  if (bridge.aiEndpointAuthorize(String(baseUrl || "")) !== true) {
    throw new Error("无法授权 AI 服务地址");
  }
}

export function clearAiCredential(bridge = getAiBridge()) {
  if (!bridge?.aiCredentialClear) throw new Error("Android AI credential storage is unavailable");
  if (bridge.aiCredentialClear() !== true) throw new Error("无法清除 AI API Key");
}

function responseError(status, body) {
  let message = "";
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || parsed?.error || "";
  } catch (_) {
    message = String(body || "").slice(0, 300);
  }
  const error = new Error(message || `AI 服务返回 HTTP ${status}`);
  error.status = Number(status) || 0;
  return error;
}

function modelContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => part?.text || part?.content || "").join("");
  }
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output.flatMap(item => item?.content || [])
      .map(part => part?.text || part?.output_text || "")
      .join("");
  }
  return "";
}

export async function requestAiContent({ prompt, imageDataUrls = [], bridge = getAiBridge(), timeoutMs = 130000 } = {}) {
  if (!bridge) throw new Error("AI 功能需要在 Android Mori 中使用");
  const config = readAiConfig();
  if (!config.baseUrl || !config.model) throw new Error("请先在设置中填写 AI 服务地址和模型");
  if (!(await aiCredentialAvailable(bridge))) throw new Error("请先在设置中保存 AI API Key");
  if (!prompt || !String(prompt).trim()) throw new Error("AI 请求内容为空");

  window.__moriAiCallbacks ||= {};
  const reqId = `ai_${Date.now()}_${++requestSequence}`;
  const raw = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window.__moriAiCallbacks[reqId];
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("AI 请求超时，请检查网络或缩短相册批次")), timeoutMs);
    window.__moriAiCallbacks[reqId] = value => finish(resolve, String(value || ""));
    try {
      bridge.aiRequestAsync(JSON.stringify({
        baseUrl: config.baseUrl,
        model: config.model,
        prompt: String(prompt),
        imageDataUrls: imageDataUrls.map(String),
      }), reqId);
    } catch (error) {
      finish(reject, error);
    }
  });

  let result;
  try {
    result = JSON.parse(raw);
  } catch (_) {
    throw new Error("AI 原生桥返回了无效响应");
  }
  const status = Number(result.status) || 0;
  if (!status) throw new Error(result.error || "AI 网络请求失败");
  if (status < 200 || status >= 300) throw responseError(status, result.data);
  let payload;
  try {
    payload = JSON.parse(result.data || "{}");
  } catch (_) {
    throw new Error("AI 服务返回了无法解析的响应");
  }
  const content = modelContent(payload).trim();
  if (!content) throw new Error("AI 服务没有返回分析内容");
  return content;
}

export function parseAiJson(content) {
  let value = String(content || "").trim();
  value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 没有返回 JSON 整理结果");
  const parsed = JSON.parse(value.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AI 整理结果格式无效");
  return parsed;
}

export async function requestAiJson(options = {}) {
  return parseAiJson(await requestAiContent(options));
}

export async function testAiConnection() {
  const result = await requestAiJson({
    prompt: "Connection test. Return only this JSON object: {\"ok\":true}",
  });
  if (result.ok !== true) throw new Error("AI 服务响应格式不符合预期");
  return true;
}
