import { getAssetStates, getDisplayAsset, putDisplayAsset } from "./assets.js";
import { applyMutationBatch, listProjects, pullChanges } from "./db.js";
import { corsHeaders, jsonResponse, readJson, requireBearerToken, withCors } from "./http.js";

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function routeInfo(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  return { url, parts };
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const { url, parts } = routeInfo(request);
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "mori-sync" });
  }

  requireBearerToken(request, env);

  if (
    request.method === "GET" &&
    parts.length === 2 &&
    parts[0] === "v1" &&
    parts[1] === "projects"
  ) {
    return jsonResponse(await listProjects(env.DB, url.searchParams.get("limit") || 100));
  }

  if (
    request.method === "POST" &&
    parts.length === 4 &&
    parts[0] === "v1" &&
    parts[1] === "projects" &&
    parts[3] === "mutations"
  ) {
    const projectId = parts[2];
    const body = await readJson(request);
    const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
    if (mutations.length > 200) {
      const error = new Error("too_many_mutations");
      error.status = 413;
      throw error;
    }
    const result = await applyMutationBatch(env.DB, projectId, mutations);
    return jsonResponse(result);
  }

  if (
    request.method === "GET" &&
    parts.length === 4 &&
    parts[0] === "v1" &&
    parts[1] === "projects" &&
    parts[3] === "changes"
  ) {
    const projectId = parts[2];
    const cursor = url.searchParams.get("cursor") || "0";
    const limit = Number(url.searchParams.get("limit") || 200);
    return jsonResponse(await pullChanges(env.DB, projectId, cursor, limit));
  }

  if (
    request.method === "POST" &&
    parts.length === 3 &&
    parts[0] === "v1" &&
    parts[1] === "assets" &&
    parts[2] === "states"
  ) {
    const body = await readJson(request);
    return jsonResponse(await getAssetStates(env, body?.assetIds));
  }

  if (
    request.method === "PUT" &&
    parts.length === 4 &&
    parts[0] === "v1" &&
    parts[1] === "assets" &&
    parts[3] === "display"
  ) {
    return jsonResponse(await putDisplayAsset(request, env, parts[2]));
  }

  if (
    request.method === "GET" &&
    parts.length === 4 &&
    parts[0] === "v1" &&
    parts[1] === "assets" &&
    parts[3] === "display"
  ) {
    const response = await getDisplayAsset(env, parts[2]);
    return response || jsonResponse({ error: "asset_display_missing" }, 404);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return withCors(await handleRequest(request, env), request);
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = String(error?.message || "internal_error");
      if (status >= 500) console.error("Mori sync Worker error", error);
      return withCors(jsonResponse({ error: code }, status), request);
    }
  },
};
