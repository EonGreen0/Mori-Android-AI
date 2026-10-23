import assert from "node:assert/strict";
import worker from "../cloudflare/src/index.js";

const env = { MORI_SYNC_TOKEN: "secret-token" };

let response = await worker.fetch(new Request("https://sync.example/health"), env);
assert.equal(response.status, 200);
assert.equal((await response.json()).ok, true);

response = await worker.fetch(new Request("https://sync.example/v1/projects/p/changes"), env);
assert.equal(response.status, 401);
assert.equal((await response.json()).error, "unauthorized");
assert.equal(response.headers.get("access-control-allow-origin"), "*");

response = await worker.fetch(new Request("https://sync.example/v1/unknown", {
  headers: { authorization: "Bearer secret-token", origin: "tauri://localhost" },
}), env);
assert.equal(response.status, 404);
assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");

response = await worker.fetch(new Request("https://sync.example/v1/projects/p/changes", {
  method: "OPTIONS",
  headers: { origin: "http://localhost" },
}), env);
assert.equal(response.status, 204);
assert.match(response.headers.get("access-control-allow-methods"), /GET/);
assert.match(response.headers.get("access-control-allow-headers"), /authorization/);

console.log("cloudflare Worker HTTP boundary verification passed");
