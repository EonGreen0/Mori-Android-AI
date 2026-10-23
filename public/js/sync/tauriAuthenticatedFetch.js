function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value || "");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createTauriAuthenticatedFetch(invoke) {
  if (typeof invoke !== "function") throw new Error("Tauri invoke is unavailable");
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    let body = new Uint8Array();
    if (typeof init.body === "string") body = new TextEncoder().encode(init.body);
    else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    else if (ArrayBuffer.isView(init.body)) body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    else if (init.body != null) throw new Error("Unsupported native request body");
    // IPC cancellation cannot recall a request already accepted by native code.
    // Sync Engine retries the same sealed opId after an uncertain acknowledgement.
    const response = await invoke("tauri_sync_authenticated_request", {
      request: {
        url: String(url),
        method: String(init.method || "GET"),
        headers,
        bodyBase64: toBase64(body),
      },
    });
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("Aborted", "AbortError");
    return new Response(fromBase64(response.bodyBase64), {
      status: response.status,
      headers: response.headers,
    });
  };
}
