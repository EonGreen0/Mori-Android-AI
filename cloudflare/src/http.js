export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-mori-display-hash",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function withCors(response, request) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function requireBearerToken(request, env) {
  const expected = String(env.MORI_SYNC_TOKEN || "");
  const auth = request.headers.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (expected && supplied === expected) return;

  const url = new URL(request.url);
  const localInsecure =
    env.ALLOW_INSECURE_LOCAL === "1" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!expected && localInsecure) return;

  const error = new Error("unauthorized");
  error.status = 401;
  throw error;
}

export async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const error = new Error("content_type_must_be_json");
    error.status = 415;
    throw error;
  }
  try {
    return await request.json();
  } catch (_) {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
}
