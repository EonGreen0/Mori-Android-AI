import { createServer } from "node:http";
import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const scriptsRoot = path.join(root, "scripts");
const runtimePages = new Set([
  "/scripts/planner-sync-idb-runtime.html",
  "/scripts/planner-sync-asset-runtime.html",
  "/scripts/planner-sync-transport-runtime.html",
  "/scripts/planner-sync-remote-merge-runtime.html",
  "/scripts/planner-sync-cloudflare-runtime.html",
]);
const forbiddenNames = /^(?:\.git|local-archive|\.env(?:\..*)?|.*\.(?:key|pem|p12|pfx|jks|keystore))$/i;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function createDevServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    if (pathname.includes("\\")) {
      response.writeHead(400).end("Bad request");
      return;
    }

    let relativePath;
    if (pathname.startsWith("/scripts/")) {
      if (!runtimePages.has(pathname)) {
        response.writeHead(404).end("Not found");
        return;
      }
      relativePath = pathname.slice("/scripts/".length);
    } else if (pathname === "/scripts" || pathname === "/scripts/") {
      response.writeHead(404).end("Not found");
      return;
    } else if (pathname.startsWith("/public/")) {
      relativePath = pathname.slice("/public/".length);
    } else {
      relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    }

    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".." || forbiddenNames.test(segment))) {
      response.writeHead(404).end("Not found");
      return;
    }

    const basePath = pathname.startsWith("/scripts/") ? scriptsRoot : publicRoot;
    let filePath = path.resolve(basePath, relativePath);
    if (!isInside(basePath, filePath)) {
      response.writeHead(404).end("Not found");
      return;
    }

    try {
      filePath = await realpath(filePath);
      const realBase = await realpath(basePath);
      if (!isInside(realBase, filePath)) {
        response.writeHead(404).end("Not found");
        return;
      }
      let info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = await realpath(path.join(filePath, "index.html"));
        if (!isInside(realBase, filePath)) throw new Error("Path outside public root");
        info = await stat(filePath);
      }
      if (!info.isFile()) throw new Error("Not a file");
      const body = request.method === "HEAD" ? null : await readFile(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
        "content-length": info.size,
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MORI_DEV_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write("MORI_DEV_PORT must be an integer from 0 to 65535\n");
    process.exitCode = 2;
  } else {
    const server = createDevServer();
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(`Mori dev server: http://127.0.0.1:${address.port}\n`);
    });
    server.on("error", (error) => {
      process.stderr.write(`Dev server failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
