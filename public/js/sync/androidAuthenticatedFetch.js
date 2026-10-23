let requestSequence = 0;

function isClosedConnection(error) {
  return /connection (?:closed|reset|shutdown)|unexpected end of stream|broken pipe|stream was reset/i.test(String(error?.message || ""));
}

function retryPause(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(), delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function fromBase64(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bridgeOrThrow(bridge) {
  if (!bridge || typeof bridge.syncReadOnlyRequestAsync !== "function") {
    throw new Error("Android read-only sync bridge is unavailable");
  }
  return bridge;
}

export function createAndroidReadOnlyAuthenticatedFetch(bridge = window.MoriMainBridge) {
  const nativeBridge = bridgeOrThrow(bridge);
  window.__moriSyncReadOnlyCallbacks ||= {};
  const requestOnce = async (url, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    const method = String(init.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error("Android read-only sync only allows GET");
    if (init.body != null) throw new Error("Android read-only sync GET cannot have a body");
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const reqId = `sync_ro_${Date.now()}_${++requestSequence}`;
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        delete window.__moriSyncReadOnlyCallbacks[reqId];
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", abort);
        fn(value);
      };
      const abort = () => finish(reject, init.signal.reason || new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(reject, new Error("android_sync_request_timeout")), 35000);
      window.__moriSyncReadOnlyCallbacks[reqId] = (raw) => {
        try {
          const parsed = JSON.parse(String(raw || "{}"));
          if (!Number(parsed.status)) {
            finish(reject, new Error(String(parsed.error || "Android sync request failed")));
            return;
          }
          finish(resolve, parsed);
        } catch (error) {
          finish(reject, error);
        }
      };
      init.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (init.signal?.aborted) { abort(); return; }
        nativeBridge.syncReadOnlyRequestAsync(JSON.stringify({
          url: String(url),
          method,
          headers,
          responseType: init.responseType === "arrayBuffer" ? "base64" : "text",
        }), reqId);
      } catch (error) {
        finish(reject, error);
      }
    });
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    const body = response.encoding === "base64"
      ? fromBase64(response.data || "")
      : String(response.data || "");
    return new Response(body, {
      status: Number(response.status),
      headers: response.headers || {},
    });
  };
  return async (url, init = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await requestOnce(url, init);
      } catch (error) {
        // Only retry interrupted reads. HTTP/auth errors, invalid requests,
        // timeouts and all Planner writes retain their existing behavior.
        if (attempt >= 2 || init.signal?.aborted || !isClosedConnection(error)) throw error;
        await retryPause(attempt === 0 ? 400 : 1000, init.signal);
      }
    }
  };
}

export function createAndroidPlannerWriteAuthenticatedFetch(bridge = window.MoriMainBridge) {
  const nativeBridge = bridgeOrThrow(bridge);
  if (typeof nativeBridge.syncPlannerWriteRequestAsync !== "function") {
    throw new Error("Android planner-write sync bridge is unavailable");
  }
  const readOnlyFetch = createAndroidReadOnlyAuthenticatedFetch(nativeBridge);
  window.__moriSyncReadOnlyCallbacks ||= {};
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET") return readOnlyFetch(url, init);
    if (method !== "POST") throw new Error(`Android planner-write sync does not allow ${method}`);
    if (typeof init.body !== "string" || !init.body) {
      throw new Error("Android planner-write sync POST requires a JSON body");
    }
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const reqId = `sync_pw_${Date.now()}_${++requestSequence}`;
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        delete window.__moriSyncReadOnlyCallbacks[reqId];
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("android_sync_request_timeout")), 35000);
      window.__moriSyncReadOnlyCallbacks[reqId] = (raw) => {
        try {
          const parsed = JSON.parse(String(raw || "{}"));
          if (!Number(parsed.status)) {
            finish(reject, new Error(String(parsed.error || "Android sync request failed")));
            return;
          }
          finish(resolve, parsed);
        } catch (error) {
          finish(reject, error);
        }
      };
      try {
        nativeBridge.syncPlannerWriteRequestAsync(
          JSON.stringify({ url: String(url), method, headers, data: init.body }),
          reqId,
        );
      } catch (error) {
        finish(reject, error);
      }
    });
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    return new Response(String(response.data || ""), {
      status: Number(response.status),
      headers: response.headers || {},
    });
  };
}

export function androidReadOnlySyncAvailable(bridge = window.MoriMainBridge) {
  try {
    return Boolean(bridge?.syncReadOnlyAvailable?.());
  } catch (_) {
    return false;
  }
}

export function androidPlannerWriteSyncAvailable(bridge = window.MoriMainBridge) {
  try {
    return Boolean(bridge?.syncPlannerWriteAvailable?.());
  } catch (_) {
    return false;
  }
}
