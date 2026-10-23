import assert from "node:assert/strict";
import { getAssetStates, getDisplayAsset, putDisplayAsset } from "../cloudflare/src/assets.js";

function sha256Hex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((buffer) =>
    [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join(""),
  );
}

class AssetDb {
  constructor(asset) { this.asset = asset; }
  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async () => {
          if (!String(sql).includes("entity_type = 'asset'")) throw new Error("unexpected query");
          if (args[0] !== this.asset.id) return null;
          return { payload_json: JSON.stringify(this.asset), revision: 3 };
        },
      }),
    };
  }
}

class FakeR2Object {
  constructor(bytes, options = {}) {
    this.bytes = bytes;
    this.body = new Response(bytes).body;
    this.httpEtag = '"etag"';
    this.etag = "etag";
    this.httpMetadata = options.httpMetadata || {};
    this.customMetadata = options.customMetadata || {};
  }
  writeHttpMetadata(headers) {
    if (this.httpMetadata.contentType) headers.set("content-type", this.httpMetadata.contentType);
    if (this.httpMetadata.cacheControl) headers.set("cache-control", this.httpMetadata.cacheControl);
  }
}

class FakeR2 {
  constructor() { this.objects = new Map(); }
  async head(key) {
    const entry = this.objects.get(key);
    return entry ? new FakeR2Object(entry.bytes, entry.options) : null;
  }
  async put(key, value, options = {}) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
    return new FakeR2Object(bytes, options);
  }
  async get(key) {
    const entry = this.objects.get(key);
    return entry ? new FakeR2Object(entry.bytes, entry.options) : null;
  }
}

const bytes = new TextEncoder().encode("mori-cloudflare-display");
const displayHash = `sha256:${await sha256Hex(bytes)}`;
const sourceHash = `sha256:${"a".repeat(64)}`;
const asset = {
  id: sourceHash,
  type: "image",
  source: { hash: sourceHash, mime: "image/png", ext: "png", width: 100, height: 50, bytes: 999 },
  display: { hash: displayHash, mime: "image/webp", ext: "webp", width: 100, height: 50, bytes: bytes.length, transformed: true },
};
const env = { DB: new AssetDb(asset), ASSETS: new FakeR2(), MORI_MAX_DISPLAY_BYTES: "1024" };

let state = await getAssetStates(env, [asset.id]);
assert.equal(state.states[0].metadata, "present");
assert.equal(state.states[0].display, "missing");

const request = new Request(`https://sync.example/v1/assets/${encodeURIComponent(asset.id)}/display`, {
  method: "PUT",
  headers: {
    "content-type": "image/webp",
    "x-mori-display-hash": displayHash,
  },
  body: bytes,
});
const uploaded = await putDisplayAsset(request, env, asset.id);
assert.equal(uploaded.displayHash, displayHash);
assert.match(uploaded.displayRef, /^display\/[a-f0-9]{2}\/[a-f0-9]{64}$/);

state = await getAssetStates(env, [asset.id]);
assert.equal(state.states[0].display, "present");
assert.equal(state.states[0].displayHash, displayHash);

const downloaded = await getDisplayAsset(env, asset.id);
assert.equal(downloaded.status, 200);
assert.equal(downloaded.headers.get("x-mori-display-hash"), displayHash);
assert.equal(downloaded.headers.get("x-mori-display-ref"), uploaded.displayRef);
assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())], [...bytes]);

let badHashRejected = false;
try {
  await putDisplayAsset(new Request(`https://sync.example/v1/assets/${encodeURIComponent(asset.id)}/display`, {
    method: "PUT",
    headers: {
      "content-type": "image/webp",
      "x-mori-display-hash": `sha256:${"b".repeat(64)}`,
    },
    body: bytes,
  }), env, asset.id);
} catch (error) {
  badHashRejected = error.message === "display_hash_mismatch";
}
assert.equal(badHashRejected, true);

let contentHashRejected = false;
try {
  const wrongBytes = new TextEncoder().encode("wrong-content-same-declared-hash");
  const wrongAsset = {
    ...asset,
    display: { ...asset.display, bytes: wrongBytes.length },
  };
  const wrongEnv = { ...env, DB: new AssetDb(wrongAsset) };
  await putDisplayAsset(new Request(`https://sync.example/v1/assets/${encodeURIComponent(asset.id)}/display`, {
    method: "PUT",
    headers: {
      "content-type": "image/webp",
      "x-mori-display-hash": displayHash,
    },
    body: wrongBytes,
  }), wrongEnv, asset.id);
} catch (error) {
  contentHashRejected = error.message === "display_content_hash_mismatch";
}
assert.equal(contentHashRejected, true);

console.log("cloudflare R2 asset verification passed");
