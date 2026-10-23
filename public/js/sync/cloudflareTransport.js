import {
  createSyncTransport,
  SYNC_TRANSPORT_CAPABILITIES,
} from "./transport.js";

function normalizeBaseUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("Cloudflare sync baseUrl must be http(s)");
  return url;
}

function encode(value) {
  return encodeURIComponent(String(value || ""));
}

async function responseError(response) {
  let code = `http_${response.status}`;
  try {
    const body = await response.clone().json();
    if (body?.error) code = String(body.error);
  } catch (_) {}
  const error = new Error(code);
  error.status = response.status;
  return error;
}

export function createCloudflareTransport(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw new Error("Cloudflare sync transport requires fetch");
  if (options.nativeAuth !== true && typeof options.getAccessToken !== "function") {
    throw new Error("Cloudflare sync transport requires getAccessToken() so secrets stay outside the transport");
  }
  if (options.nativeAuth === true && (typeof options.fetchImpl !== "function" || options.getAccessToken)) {
    throw new Error("Native auth requires an authenticated fetchImpl without getAccessToken");
  }
  const timeoutMs = Math.max(1000, Math.min(120000, Number(options.timeoutMs) || 30000));

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("sync_request_timeout")), timeoutMs);
    const headers = new Headers(init.headers || {});
    if (options.nativeAuth === true) {
      if (headers.has("authorization")) throw new Error("Native auth request cannot supply authorization");
    } else {
      const token = String(await options.getAccessToken() || "");
      if (!token) throw new Error("Cloudflare sync access token is unavailable");
      headers.set("authorization", `Bearer ${token}`);
    }

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("content-type", "application/json");
    const response = await request(path, { ...init, headers });
    return response.json();
  }

  return createSyncTransport({
    id: String(options.id || "cloudflare"),
    capabilities: options.capabilities || Object.values(SYNC_TRANSPORT_CAPABILITIES),

    async listProjects({ limit = 100 } = {}) {
      const query = new URLSearchParams();
      query.set("limit", String(Math.max(1, Math.min(200, Number(limit) || 100))));
      return requestJson(`/v1/projects?${query.toString()}`);
    },

    async pushMutations({ projectId, deviceId, mutations }) {
      return requestJson(`/v1/projects/${encode(projectId)}/mutations`, {
        method: "POST",
        body: JSON.stringify({ deviceId: String(deviceId || ""), mutations }),
      });
    },

    async pullChanges({ projectId, cursor, limit }) {
      const query = new URLSearchParams();
      if (cursor != null && cursor !== "") query.set("cursor", String(cursor));
      query.set("limit", String(Math.max(1, Math.min(500, Number(limit) || 200))));
      return requestJson(`/v1/projects/${encode(projectId)}/changes?${query.toString()}`);
    },

    async getAssetStates({ assetIds }) {
      return requestJson("/v1/assets/states", {
        method: "POST",
        body: JSON.stringify({ assetIds }),
      });
    },

    async uploadDisplayAsset({ asset, bytes, hash, mime }) {
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      const response = await request(`/v1/assets/${encode(asset.id)}/display`, {
        method: "PUT",
        headers: {
          "content-type": String(mime || asset?.display?.mime || "application/octet-stream"),
          "x-mori-display-hash": String(hash || asset?.display?.hash || ""),
        },
        body,
      });
      return response.json();
    },

    async downloadDisplayAsset({ assetId }) {
      const response = await request(`/v1/assets/${encode(assetId)}/display`, {
        method: "GET",
        responseType: "arrayBuffer",
      });
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        displayRef: response.headers.get("x-mori-display-ref") || "",
      };
    },
  });
}
