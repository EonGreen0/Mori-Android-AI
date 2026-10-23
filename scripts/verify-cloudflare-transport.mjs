import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromSource = createRequire(import.meta.url);
const { build } = requireFromSource("esbuild");

async function loadBundledModule(relativePath) {
  const entry = fileURLToPath(new URL(relativePath, import.meta.url));
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const source = bundle.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { createCloudflareTransport } = await loadBundledModule("../public/js/sync/cloudflareTransport.js");
const calls = [];
const displayBytes = new Uint8Array([1, 2, 3, 4]);

const fakeFetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const headers = new Headers(init.headers || {});
  calls.push({ url: parsed, method: init.method || "GET", headers, body: init.body });
  assert.equal(headers.get("authorization"), "Bearer secret-token");

  if (parsed.pathname.endsWith("/mutations")) {
    const body = JSON.parse(String(init.body));
    return Response.json({ acknowledgedOpIds: body.mutations.map((item) => item.opId), rejected: [], cursor: "4" });
  }
  if (parsed.pathname.endsWith("/changes")) {
    return Response.json({ changes: [], cursor: parsed.searchParams.get("cursor") || "0", hasMore: false });
  }
  if (parsed.pathname === "/v1/assets/states") {
    return Response.json({ states: [{ assetId: "sha256:a", metadata: "present", display: "missing", original: "missing" }] });
  }
  if (init.method === "PUT" && parsed.pathname.endsWith("/display")) {
    assert.equal(headers.get("content-type"), "image/webp");
    assert.equal(headers.get("x-mori-display-hash"), "sha256:display");
    assert.deepEqual([...new Uint8Array(init.body)], [...displayBytes]);
    return Response.json({ displayRef: "display/ref", original: "missing" });
  }
  if (init.method === "GET" && parsed.pathname.endsWith("/display")) {
    return new Response(displayBytes, {
      headers: {
        "content-type": "image/webp",
        "x-mori-display-ref": "display/ref",
      },
    });
  }
  return new Response("missing", { status: 404 });
};

const transport = createCloudflareTransport({
  baseUrl: "https://sync.example.test/",
  getAccessToken: async () => "secret-token",
  fetchImpl: fakeFetch,
});

const pushed = await transport.pushMutations({
  projectId: "project/1",
  deviceId: "device-1",
  mutations: [{ opId: "op-1" }],
});
assert.deepEqual(pushed.acknowledgedOpIds, ["op-1"]);
assert.equal(calls[0].url.pathname, "/v1/projects/project%2F1/mutations");

const pulled = await transport.pullChanges({ projectId: "project/1", cursor: "3", limit: 25 });
assert.equal(pulled.cursor, "3");
assert.equal(calls[1].url.searchParams.get("limit"), "25");

const state = await transport.getAssetStates({ assetIds: ["sha256:a"] });
assert.equal(state.states[0].display, "missing");

const uploaded = await transport.uploadDisplayAsset({
  asset: { id: "sha256:asset", display: { mime: "image/webp", hash: "sha256:display" } },
  bytes: displayBytes,
  hash: "sha256:display",
  mime: "image/webp",
});
assert.equal(uploaded.displayRef, "display/ref");

const downloaded = await transport.downloadDisplayAsset({ assetId: "sha256:asset" });
assert.deepEqual([...downloaded.bytes], [...displayBytes]);
assert.equal(downloaded.contentType, "image/webp");
assert.equal(downloaded.displayRef, "display/ref");

console.log("cloudflare transport verification passed");
