import { findAssetMetadata } from "./db.js";

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_sha256_hash");
  return hash;
}

function hashHex(value) {
  return normalizeHash(value).slice("sha256:".length);
}

function displayObjectKey(displayHash) {
  const hex = hashHex(displayHash);
  return `display/${hex.slice(0, 2)}/${hex}`;
}

async function sha256AssetId(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function assetDisplayMetadata(asset) {
  const displayHash = normalizeHash(asset?.display?.hash);
  return {
    displayHash,
    mime: String(asset?.display?.mime || "application/octet-stream"),
    bytes: Math.max(0, Number(asset?.display?.bytes) || 0),
  };
}

export async function getAssetStates(env, assetIds) {
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(String).filter(Boolean))].slice(0, 100);
  const states = await Promise.all(ids.map(async (assetId) => {
    const metadata = await findAssetMetadata(env.DB, assetId);
    if (!metadata) {
      return {
        assetId,
        metadata: "missing",
        display: "missing",
        original: "missing",
      };
    }

    let displayInfo;
    try {
      displayInfo = assetDisplayMetadata(metadata.asset);
    } catch (_) {
      return {
        assetId,
        metadata: "present",
        display: "missing",
        original: "missing",
      };
    }

    const key = displayObjectKey(displayInfo.displayHash);
    const object = await env.ASSETS.head(key);
    return {
      assetId,
      metadata: "present",
      display: object ? "present" : "missing",
      original: "missing",
      displayHash: displayInfo.displayHash,
      displayRef: object ? key : "",
    };
  }));

  return { states };
}

export async function putDisplayAsset(request, env, assetId) {
  const metadata = await findAssetMetadata(env.DB, assetId);
  if (!metadata) {
    const error = new Error("asset_metadata_missing");
    error.status = 409;
    throw error;
  }

  const display = assetDisplayMetadata(metadata.asset);
  const declaredHash = normalizeHash(request.headers.get("x-mori-display-hash"));
  if (declaredHash !== display.displayHash) {
    const error = new Error("display_hash_mismatch");
    error.status = 409;
    throw error;
  }

  const maxBytes = Math.max(1024, Number(env.MORI_MAX_DISPLAY_BYTES) || 12 * 1024 * 1024);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    const error = new Error("display_too_large");
    error.status = 413;
    throw error;
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    const error = new Error("display_too_large");
    error.status = 413;
    throw error;
  }
  if (display.bytes && display.bytes !== bytes.byteLength) {
    const error = new Error("display_size_mismatch");
    error.status = 409;
    throw error;
  }

  const actualHash = await sha256AssetId(bytes);
  if (actualHash !== display.displayHash) {
    const error = new Error("display_content_hash_mismatch");
    error.status = 409;
    throw error;
  }

  const key = displayObjectKey(display.displayHash);
  await env.ASSETS.put(key, bytes, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || display.mime,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      assetId,
      displayHash: display.displayHash,
    },
  });

  return {
    assetId,
    displayHash: display.displayHash,
    displayRef: key,
    original: "missing",
  };
}

export async function getDisplayAsset(env, assetId) {
  const metadata = await findAssetMetadata(env.DB, assetId);
  if (!metadata) return null;
  const display = assetDisplayMetadata(metadata.asset);
  const key = displayObjectKey(display.displayHash);
  const object = await env.ASSETS.get(key);
  if (!object?.body) return null;

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("etag", object.httpEtag || object.etag || display.displayHash);
  headers.set("x-mori-display-hash", display.displayHash);
  headers.set("x-mori-display-ref", key);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { status: 200, headers });
}
