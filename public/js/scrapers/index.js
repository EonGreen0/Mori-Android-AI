// MORI CORE SCRAPER ENGINE — SECURE RUNTIME LOADER
// Protected under GNU General Public License v3.0.
// All rights reserved (C) 2026 coflyn.

import * as utils from "../utils/index.js";
import * as urlUtils from "../utils/urlUtils.js";
import * as core from "../modules/core.js";
import { inflateSync } from "../vendor/inflate.min.js";
import { scraperFetch } from "./httpHelper.js";

export * from "./httpHelper.js";

// Expose dependencies to global bridge for the compiled core
window.__moriDeps = { utils, urlUtils, core };

let _corePromise = null;

async function obtainEngineSecret(challenge) {
  // 1. Android Native Bridge (Main or Share Bridge)
  const androidBridge = window.MoriMainBridge || window.MoriShareBridge;
  if (typeof androidBridge?.getEngineSecurityKey === "function") {
    try {
      const hex = androidBridge.getEngineSecurityKey(challenge);
      if (hex === "UNAUTHORIZED_CLONE") {
        throw new Error("Mori Engine: Unauthorized application distribution.");
      }
      if (hex && hex.length >= 32) return hex;
    } catch (e) {
      if (e.message?.includes("Unauthorized")) throw e;
    }
  }

  // 2. Desktop Tauri Native Bridge (Rust machine code / precompiled static binary)
  if (window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.invoke) {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.invoke;
    try {
      const hex = await invoke("tauri_get_engine_key", { challenge });
      if (hex && hex.length >= 32) return hex;
    } catch (e) {
      console.error("[Mori Engine] Native desktop security verification failed:", e);
    }
  }

  throw new Error("Mori Engine: Native security verification failed.");
}

async function loadCoreScrapers() {
  if (_corePromise) return _corePromise;
  _corePromise = (async () => {
    try {
      let arrayBuf = null;

      // 1. Android Native Bridge direct asset read (Instant & 100% reliable on file:// scheme)
      const androidBridge = window.MoriMainBridge || window.MoriShareBridge;
      if (typeof androidBridge?.getScrapersBinaryBase64 === "function") {
        try {
          const b64 = androidBridge.getScrapersBinaryBase64();
          if (b64) {
            const binStr = atob(b64);
            const len = binStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
            arrayBuf = bytes.buffer;
          }
        } catch (_) {}
      }

      // 2. Desktop Tauri Native Bridge
      if (!arrayBuf && (window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.invoke)) {
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.invoke;
        try {
          const rawBytes = await invoke("tauri_read_file_bytes", { path: "public/js/scrapers.bin" });
          arrayBuf = new Uint8Array(rawBytes).buffer;
        } catch (_) {}
      }

      // 3. Capacitor Filesystem Plugin
      if (!arrayBuf && window.Capacitor?.Plugins?.Filesystem) {
        try {
          const fs = window.Capacitor.Plugins.Filesystem;
          const readRes = await fs.readFile({ path: "public/js/scrapers.bin" });
          if (readRes?.data) {
            const binStr = atob(readRes.data);
            const len = binStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
            arrayBuf = bytes.buffer;
          }
        } catch (_) {}
      }

      // 4. Relative Fetch API
      if (!arrayBuf) {
        const binUrls = ["js/scrapers.bin", "/js/scrapers.bin", "./js/scrapers.bin", "file:///android_asset/public/js/scrapers.bin"];
        for (const u of binUrls) {
          try {
            const res = await fetch(u);
            if (res.ok) {
              arrayBuf = await res.arrayBuffer();
              break;
            }
          } catch (_) {}
        }
      }

      // 5. XMLHttpRequest Fallback (Works on file:///android_asset/... in WebView)
      if (!arrayBuf && typeof XMLHttpRequest !== "undefined") {
        const tryXhr = (url) => new Promise((resolve) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = "arraybuffer";
            xhr.onload = () => {
              if (xhr.status === 200 || (xhr.status === 0 && xhr.response && xhr.response.byteLength > 0)) {
                resolve(xhr.response);
              } else {
                resolve(null);
              }
            };
            xhr.onerror = () => resolve(null);
            xhr.send();
          } catch (_) {
            resolve(null);
          }
        });
        for (const u of ["js/scrapers.bin", "./js/scrapers.bin", "file:///android_asset/public/js/scrapers.bin"]) {
          arrayBuf = await tryXhr(u);
          if (arrayBuf) break;
        }
      }

      if (!arrayBuf) throw new Error("Could not locate scrapers.bin binary payload");

      const bytes = new Uint8Array(arrayBuf);
      
      // Dynamic handshake with native security layer
      const challenge = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      const hexKey = await obtainEngineSecret(challenge);
      
      if (!hexKey || hexKey.length < 32) {
        throw new Error("Security verification handshake failed");
      }

      const key = new Uint8Array(hexKey.length / 2);
      for (let i = 0; i < key.length; i++) {
        const encByte = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
        const ch = challenge.charCodeAt(i % challenge.length);
        key[i] = encByte ^ ch;
      }

      // Decrypt payload
      const deobf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        deobf[i] = bytes[i] ^ key[i % key.length] ^ ((i * 7) & 0xff);
      }

      // Decompress payload (zero-dependency pure synchronous inflate with fallback)
      let scriptText = null;
      try {
        const decompressedBytes = inflateSync(deobf);
        scriptText = new TextDecoder().decode(decompressedBytes);
      } catch (infErr) {
        if (typeof DecompressionStream !== "undefined") {
          try {
            const ds = new DecompressionStream("deflate-raw");
            const writer = ds.writable.getWriter();
            writer.write(deobf);
            writer.close();
            const decompressedBuf = await new Response(ds.readable).arrayBuffer();
            scriptText = new TextDecoder().decode(decompressedBuf);
          } catch (dsErr) {
            console.error("[Mori Engine] Decompression failed:", dsErr);
            throw infErr;
          }
        } else {
          throw infErr;
        }
      }

      // Execute and return the exports safely
      const fn = new Function(scriptText + "\nreturn typeof __MoriCoreScrapers !== 'undefined' ? __MoriCoreScrapers : window.__MoriCoreScrapers;");
      const mod = fn();

      if (!mod) {
        throw new Error("Core engine exports missing after execution");
      }

      window.__MoriCoreScrapers = mod;
      return mod;
    } catch (e) {
      console.error("[Mori Engine] Core runtime loading failed:", e);
      throw e;
    }
  })();
  return _corePromise;
}

export async function scrapeTikTok(...args) { return (await loadCoreScrapers()).scrapeTikTok(...args); }
export function setTikTokSource(...args) { loadCoreScrapers().then(m => m.setTikTokSource(...args)); }

export async function scrapeYouTube(...args) { return (await loadCoreScrapers()).scrapeYouTube(...args); }
export function setYouTubeSource(...args) { loadCoreScrapers().then(m => m.setYouTubeSource(...args)); }

export async function scrapeInstagram(...args) { return (await loadCoreScrapers()).scrapeInstagram(...args); }
export function setInstagramSource(...args) { loadCoreScrapers().then(m => m.setInstagramSource(...args)); }

export async function scrapeTwitter(...args) { return (await loadCoreScrapers()).scrapeTwitter(...args); }
export function setTwitterSource(...args) { loadCoreScrapers().then(m => m.setTwitterSource(...args)); }

export async function scrapeSpotify(...args) { return (await loadCoreScrapers()).scrapeSpotify(...args); }
export function setSpotifySource(...args) { loadCoreScrapers().then(m => m.setSpotifySource(...args)); }

export async function scrapeBilibili(...args) { return (await loadCoreScrapers()).scrapeBilibili(...args); }
export async function scrapePixiv(...args) { return (await loadCoreScrapers()).scrapePixiv(...args); }

const REDNOTE_DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REDNOTE_MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const REDNOTE_HOSTS = ["xiaohongshu.com", "xhslink.com", "xhslink.cn", "rednote.com"];

function isRedNoteHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return REDNOTE_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function redNoteNoteId(value) {
  const raw = String(value || "");
  try {
    const url = new URL(raw);
    if (!isRedNoteHost(url.hostname)) return "";
    const match = url.pathname.match(/\/(?:explore|discovery\/item|note)\/([a-zA-Z0-9]+)/i);
    return match?.[1] || "";
  } catch (_) {
    return raw.match(/\/(?:explore|discovery\/item|note)\/([a-zA-Z0-9]+)/i)?.[1] || "";
  }
}

function redNoteCanonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!isRedNoteHost(url.hostname)) return "";
    url.hash = "";
    if (!redNoteNoteId(url.href)) return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function balancedJsonObject(source, start) {
  if (start < 0 || source[start] !== "{") return null;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

function parseRedNoteInitialState(html) {
  const source = String(html || "");
  const marker = source.search(/window\.__INITIAL_STATE__\s*=/);
  if (marker < 0) return null;
  const objectStart = source.indexOf("{", marker);
  const objectText = balancedJsonObject(source, objectStart);
  if (!objectText) return null;
  const normalized = objectText
    .replace(/([:\[,]\s*)undefined(?=\s*[,}\]])/g, "$1null")
    .replace(/([:\[,]\s*)NaN(?=\s*[,}\]])/g, "$1null");
  try {
    return JSON.parse(normalized);
  } catch (_) {
    return null;
  }
}

function findRedNoteObject(value, noteId, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 20 || seen.has(value)) return null;
  seen.add(value);
  if (
    (!noteId || String(value.noteId || value.id || "") === String(noteId)) &&
    (Array.isArray(value.imageList) || value.video)
  ) {
    return value;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "comments" || key === "commentList") continue;
    const found = findRedNoteObject(child, noteId, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function redNoteStateFromHtml(html, noteId) {
  const state = parseRedNoteInitialState(html);
  if (!state) return null;
  const detailMap = state?.note?.noteDetailMap || state?.noteDetailMap;
  if (detailMap && typeof detailMap === "object") {
    if (noteId && detailMap[noteId]) return detailMap[noteId]?.note || detailMap[noteId];
    for (const entry of Object.values(detailMap)) {
      const note = entry?.note || entry;
      if (note && (Array.isArray(note.imageList) || note.video)) return note;
    }
  }
  return findRedNoteObject(state, noteId);
}

function redNoteImageCandidates(image) {
  const values = [];
  const add = value => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) values.push(value.replace(/^http:\/\//i, "https://"));
  };
  add(image?.urlDefault);
  add(image?.urlPre);
  add(typeof image?.url === "string" ? image.url : "");
  if (Array.isArray(image?.infoList)) {
    const ranked = [...image.infoList].sort((a, b) =>
      (Number(b?.width) * Number(b?.height)) - (Number(a?.width) * Number(a?.height)));
    ranked.forEach(item => add(item?.url));
  }
  return [...new Set(values)];
}

function redNoteVideoCandidates(video) {
  const streams = video?.media?.stream || video?.stream || {};
  const candidates = [];
  for (const codec of ["h264", "h265", "av1"]) {
    const variants = Array.isArray(streams?.[codec]) ? [...streams[codec]] : [];
    variants.sort((a, b) =>
      (Number(b?.width) * Number(b?.height) * Number(b?.avgBitrate || 1)) -
      (Number(a?.width) * Number(a?.height) * Number(a?.avgBitrate || 1)));
    for (const variant of variants) {
      if (/^https?:\/\//i.test(String(variant?.masterUrl || ""))) candidates.push(String(variant.masterUrl));
      for (const backup of Array.isArray(variant?.backupUrls) ? variant.backupUrls : []) {
        if (/^https?:\/\//i.test(String(backup || ""))) candidates.push(String(backup));
      }
    }
  }
  const originKey = video?.consumer?.originVideoKey || video?.originVideoKey;
  if (typeof originKey === "string" && originKey) {
    candidates.push(`https://sns-video-bd.xhscdn.com/${originKey.replace(/^\/+/, "")}`);
  }
  return [...new Set(candidates.map(url => url.replace(/^http:\/\//i, "https://")))];
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function redNoteOpenGraph(html) {
  const source = String(html || "");
  const meta = (name) => {
    const match = source.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"))
      || source.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["'][^>]*>`, "i"));
    return decodeHtmlAttribute(match?.[1] || "");
  };
  const all = [...source.matchAll(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map(match => decodeHtmlAttribute(match[1]))
    .filter(url => /^https?:\/\//i.test(url));
  const video = meta("og:video") || meta("og:video:url") || meta("twitter:player:stream");
  return {
    title: meta("og:title"),
    description: meta("og:description"),
    images: [...new Set(all)],
    video: /^https?:\/\//i.test(video) ? video.replace(/^http:\/\//i, "https://") : "",
    thumbnail: meta("og:image"),
  };
}

function buildRedNoteResult(note, sourceUrl, finalUrl) {
  const images = [...new Set((Array.isArray(note?.imageList) ? note.imageList : [])
    .flatMap(image => redNoteImageCandidates(image).slice(0, 1)))];
  const videos = redNoteVideoCandidates(note?.video);
  const downloads = [];
  images.forEach((url, index) => downloads.push({
    url,
    type: "IMAGE",
    quality: `Image ${index + 1}`,
    thumbnail: url,
    headers: { Referer: "https://www.xiaohongshu.com/" },
  }));
  if (videos.length) downloads.push({
    url: videos[0],
    type: "VIDEO",
    quality: "Original video",
    thumbnail: note?.video?.image?.thumbnailUrl || images[0] || "",
    headers: { Referer: "https://www.xiaohongshu.com/" },
    fallbackUrls: videos.slice(1),
  });
  if (!downloads.length) return null;
  const rawTitle = String(note?.title || note?.desc || "").trim();
  return {
    status: true,
    result: {
      title: rawTitle.slice(0, 240) || `RedNote ${note?.noteId || redNoteNoteId(finalUrl)}`,
      description: String(note?.desc || "").slice(0, 2000),
      thumbnail: note?.video?.image?.thumbnailUrl || images[0] || "",
      sourceUrl: finalUrl || sourceUrl,
      author: String(note?.user?.nickname || note?.user?.nickName || note?.user?.name || ""),
      mediaKind: videos.length && images.length ? "mixed" : videos.length ? "video" : "images",
      downloads,
    },
    sourceUrl: finalUrl || sourceUrl,
  };
}

function buildRedNoteOpenGraphResult(html, sourceUrl, finalUrl) {
  const graph = redNoteOpenGraph(html);
  const downloads = graph.images.map((url, index) => ({
    url,
    type: "IMAGE",
    quality: `Image ${index + 1}`,
    thumbnail: url,
    headers: { Referer: "https://www.xiaohongshu.com/" },
  }));
  if (graph.video) downloads.push({
    url: graph.video,
    type: "VIDEO",
    quality: "OpenGraph video",
    thumbnail: graph.thumbnail || graph.images[0] || "",
    headers: { Referer: "https://www.xiaohongshu.com/" },
  });
  if (!downloads.length) return null;
  return {
    status: true,
    result: {
      title: graph.title || graph.description.slice(0, 100) || "RedNote",
      description: graph.description,
      thumbnail: graph.thumbnail || graph.images[0] || "",
      sourceUrl: finalUrl || sourceUrl,
      mediaKind: graph.video ? "video" : "images",
      downloads,
    },
    sourceUrl: finalUrl || sourceUrl,
  };
}

async function fetchRedNotePage(url, userAgent) {
  return scraperFetch({
    url,
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
    rawResponse: true,
    parseJson: false,
  }, "Xiaohongshu");
}

async function scrapeRedNoteDirect(inputUrl) {
  let requestedUrl = String(inputUrl || "").trim();
  try {
    const parsed = new URL(requestedUrl);
    if (!isRedNoteHost(parsed.hostname)) {
      return { status: false, message: "This is not a Xiaohongshu link." };
    }
    requestedUrl = parsed.href;
  } catch (_) {
    return { status: false, message: "The Xiaohongshu link is invalid." };
  }

  let lastResponse = null;
  let lastError = null;
  for (const userAgent of [REDNOTE_DESKTOP_UA, REDNOTE_MOBILE_UA]) {
    try {
      const response = await fetchRedNotePage(requestedUrl, userAgent);
      lastResponse = response;
      const html = String(response?.data || "");
      const finalUrl = redNoteCanonicalUrl(response?.url) || redNoteCanonicalUrl(requestedUrl) || requestedUrl;
      const noteId = redNoteNoteId(finalUrl) || redNoteNoteId(requestedUrl);
      const note = redNoteStateFromHtml(html, noteId);
      const parsed = buildRedNoteResult(note, requestedUrl, finalUrl);
      if (parsed) return parsed;
      const graph = buildRedNoteOpenGraphResult(html, requestedUrl, finalUrl);
      if (graph) return graph;
    } catch (error) {
      lastError = error;
    }
  }

  const status = Number(lastResponse?.status) || 0;
  const html = String(lastResponse?.data || "");
  const blocked = /验证码|安全验证|访问频繁|访问受限|login|captcha|verify/i.test(html);
  const diagnostic = blocked
    ? `rednote_blocked_http_${status}`
    : `rednote_no_media_http_${status}_len_${html.length}`;
  return {
    status: false,
    statusCode: status || null,
    message: blocked
      ? "小红书返回了安全验证页面。请稍后重试，或先在小红书网页中打开该作品 [rednote_blocked]"
      : `没有从小红书页面找到可下载的图片或视频${lastError ? `：${String(lastError.message || lastError).slice(0, 120)}` : ""} [${diagnostic}]`,
  };
}

export async function scrapeRedNote(url, ...args) {
  const direct = await scrapeRedNoteDirect(url);
  if (direct?.status) return direct;
  try {
    const fallback = await (await loadCoreScrapers()).scrapeRedNote(url, ...args);
    if (fallback?.status) return fallback;
  } catch (error) {
    console.warn("[Mori Engine] Legacy RedNote fallback failed:", error);
  }
  return direct;
}

const DOUYIN_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";

function extractDouyinAwemeId(value) {
  const raw = String(value || "");
  const pathMatch = raw.match(/\/(?:video|note|share\/video|share\/slides)\/(\d{15,22})/i);
  if (pathMatch?.[1]) return pathMatch[1];
  try {
    const parsed = new URL(raw);
    for (const key of ["aweme_id", "item_id", "modal_id"]) {
      const candidate = parsed.searchParams.get(key);
      if (/^\d{15,22}$/.test(candidate || "")) return candidate;
    }
  } catch (_) {}
  return "";
}

function parseDouyinRouterData(html) {
  const source = String(html || "");
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(source))) {
    const script = match[1] || "";
    const markerIndex = script.indexOf("window._ROUTER_DATA");
    if (markerIndex < 0) continue;
    const equalIndex = script.indexOf("=", markerIndex);
    if (equalIndex < 0) continue;
    const assignment = script.slice(equalIndex + 1).trim();
    const start = assignment.indexOf("{");
    const end = assignment.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(assignment.slice(start, end + 1));
      } catch (_) {}
    }
  }

  const renderData = source.match(/<script\b[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (renderData) {
    for (const candidate of [renderData, (() => { try { return decodeURIComponent(renderData); } catch (_) { return ""; } })()]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch (_) {}
    }
  }
  return null;
}

function getDouyinUrlList(value) {
  if (!value) return [];
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(getDouyinUrlList);
  if (typeof value !== "object") return [];
  const candidates = [
    value.url_list,
    value.urlList,
    value.url,
    value.src,
    value.play_addr,
    value.playAddr,
  ];
  return candidates.flatMap(getDouyinUrlList);
}

function findDouyinAwemeObject(root, awemeId) {
  if (!root || typeof root !== "object") return null;
  const queue = [root];
  const seen = new Set();
  let visited = 0;
  let best = null;
  let bestScore = -1;

  while (queue.length && visited < 30000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    visited++;

    if (!Array.isArray(value)) {
      const candidateId = String(
        value.aweme_id ?? value.awemeId ?? value.item_id ?? value.itemId ?? value.id ?? "",
      );
      const video = value.video || value.video_info || value.videoInfo;
      const hasPlayableVideo = Boolean(
        video &&
          (getDouyinUrlList(video.play_addr).length ||
            getDouyinUrlList(video.playAddr).length ||
            getDouyinUrlList(video.play_addr_h264).length ||
            getDouyinUrlList(video.playAddrH264).length ||
            getDouyinUrlList(video.download_addr).length),
      );
      const hasImages = getDouyinImageCandidates(value).length > 0;
      if (hasPlayableVideo || hasImages) {
        let score = 10;
        if (awemeId && candidateId === awemeId) score += 100;
        if (candidateId) score += 8;
        if (value.desc || value.title) score += 4;
        if (value.author) score += 3;
        if (hasPlayableVideo) score += 6;
        if (score > bestScore) {
          best = value;
          bestScore = score;
        }
      }
    }

    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && typeof child === "object" && !seen.has(child)) queue.push(child);
    }
  }
  return best;
}

function getDouyinDirectUrlList(value) {
  if (!value) return [];
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  }
  if (typeof value !== "object") return [];
  const list = value.url_list ?? value.urlList;
  if (Array.isArray(list)) {
    return list.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  }
  const direct = value.url ?? value.src;
  return typeof direct === "string" && /^https?:\/\//i.test(direct) ? [direct] : [];
}

function getDouyinImageCandidates(aweme) {
  if (!aweme || typeof aweme !== "object") return [];

  const imageCollections = [
    aweme.images,
    aweme.images_v2,
    aweme.image_list,
    aweme.imageList,
    aweme.image_post_info?.images,
    aweme.imagePostInfo?.images,
    aweme.image_post_info?.image_list,
    aweme.imagePostInfo?.imageList,
    aweme.note?.images,
    aweme.slides,
  ].filter(Array.isArray);

  const rawImages = imageCollections.flat();
  const results = [];
  const seenPrimary = new Set();

  const collect = (image) => {
    if (!image) return;
    const orderedContainers = [
      image.origin_image,
      image.originImage,
      image.origin_url,
      image.originUrl,
      image.display_image,
      image.displayImage,
      image.url_list,
      image.urlList,
      image.url,
      image.download_url_list,
      image.downloadUrlList,
      image.download_url,
      image.downloadUrl,
      image.owner_watermark_image,
      image.ownerWatermarkImage,
    ];
    const urls = [];
    orderedContainers.forEach((value) => {
      getDouyinDirectUrlList(value).forEach((url) => {
        if (url && !urls.includes(url)) urls.push(url);
      });
    });
    if (!urls.length) {
      getDouyinUrlList(image).forEach((url) => {
        if (url && !urls.includes(url)) urls.push(url);
      });
    }
    const primary = urls[0];
    if (!primary || seenPrimary.has(primary)) return;
    seenPrimary.add(primary);
    results.push({
      url: primary,
      fallbackUrls: urls.slice(1),
      width: Number(image.width ?? image.display_image?.width ?? image.displayImage?.width ?? 0) || 0,
      height: Number(image.height ?? image.display_image?.height ?? image.displayImage?.height ?? 0) || 0,
    });
  };

  rawImages.forEach(collect);
  return results;
}

function getDouyinVideoCandidates(video) {
  if (!video || typeof video !== "object") return [];

  const rateItems = [
    ...(Array.isArray(video.bit_rate) ? video.bit_rate : []),
    ...(Array.isArray(video.bitRate) ? video.bitRate : []),
  ]
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const playAddr = item.play_addr ?? item.playAddr;
      const urls = getDouyinDirectUrlList(playAddr);
      const width = Number(playAddr?.width ?? item.width ?? 0) || 0;
      const height = Number(playAddr?.height ?? item.height ?? 0) || 0;
      const pixels = width > 0 && height > 0 ? width * height : Math.max(width, height);
      const bitrate = Number(item.bit_rate ?? item.bitRate ?? 0) || 0;
      const codec = String(
        item.codec_type ?? item.codecType ?? item.codec ?? item.gear_name ?? item.gearName ?? "",
      ).toLowerCase();
      const isH265 = item.is_h265 === true || item.isH265 === true || /h265|hevc/.test(codec);
      const isH264 = item.is_h265 === false || item.isH265 === false || /h264|avc/.test(codec);
      return { urls, pixels, bitrate, isH264, isH265 };
    })
    .filter((entry) => entry.urls.length > 0);

  // Match Douzy's current strategy: video.bit_rate[*].play_addr is authoritative.
  // Prefer the highest-resolution rung, then bitrate. Within equivalent quality,
  // prefer AVC/H.264 because WebView2/frame extraction can decode it reliably.
  rateItems.sort((a, b) => {
    if (b.pixels !== a.pixels) return b.pixels - a.pixels;
    if (a.isH264 !== b.isH264) return a.isH264 ? -1 : 1;
    if (a.isH265 !== b.isH265) return a.isH265 ? 1 : -1;
    return b.bitrate - a.bitrate;
  });

  const ordered = [];
  const pushUrls = (urls) => {
    urls.forEach((url) => {
      // Do not rewrite playwm -> play. That legacy trick can redirect modern
      // Douyin media to a different rendition (including audio-only content).
      if (url && !ordered.includes(url)) ordered.push(url);
    });
  };

  rateItems.forEach((entry) => pushUrls(entry.urls));

  // Only if the bitrate ladder is missing/incomplete, fall back to the explicit
  // play-address containers. Keep url_list boundaries strict; never recursively
  // harvest unrelated nested media URLs such as music.play_url.
  if (!ordered.length) {
    [
      video.play_addr_h264,
      video.playAddrH264,
      video.play_addr_265,
      video.playAddr265,
      video.play_addr_256,
      video.playAddr256,
      video.play_addr,
      video.playAddr,
    ].forEach((value) => pushUrls(getDouyinDirectUrlList(value)));
  }

  return ordered;
}

function buildDouyinSsrResult(aweme, awemeId, sourceUrl, pageUrl) {
  if (!aweme) return null;
  const video = aweme.video || aweme.video_info || aweme.videoInfo || {};
  const uniqueVideoUrls = getDouyinVideoCandidates(video);
  const playUrl = uniqueVideoUrls[0] || "";
  const imageSources = getDouyinImageCandidates(aweme);

  const cover = [
    video.cover,
    video.origin_cover,
    video.originCover,
    video.dynamic_cover,
    video.dynamicCover,
    aweme.cover,
  ].flatMap(getDouyinUrlList)[0] || imageSources[0]?.url || "";

  const downloads = [];
  // Douyin image posts often still expose a `video` object for soundtrack / compatibility
  // playback. If the aweme contains a real image collection, always treat it as a photo post
  // and never let that auxiliary video object steal precedence.
  if (imageSources.length) {
    imageSources.forEach((image, index) => {
      downloads.push({
        url: image.url,
        type: "IMAGE",
        quality: `Photo ${index + 1}`,
        thumbnail: image.url,
        headers: { Referer: pageUrl || "https://www.douyin.com/" },
        fallbackUrls: image.fallbackUrls,
      });
    });
  } else if (playUrl) {
    downloads.push({
      url: playUrl,
      type: "VIDEO",
      quality: "Original",
      thumbnail: cover,
      headers: { Referer: pageUrl || "https://www.iesdouyin.com/" },
      fallbackUrls: uniqueVideoUrls.slice(1),
    });
  }

  if (!downloads.length) return null;
  const authorName = aweme.author?.nickname || aweme.author?.unique_id || "";
  const title = String(aweme.desc || aweme.title || "").trim() ||
    (authorName ? `Douyin · ${authorName}` : `Douyin ${awemeId || "Video"}`);

  return {
    status: true,
    result: {
      title,
      thumbnail: cover,
      sourceUrl,
      author: authorName,
      duration: video.duration || aweme.duration || 0,
      downloads,
    },
    sourceUrl,
  };
}

function getDouyinAwemeFromRouterData(routerData, awemeId) {
  if (!routerData || typeof routerData !== "object") return null;
  const loaderData = routerData.loaderData || routerData.loader_data || {};
  const preferredKeys = [
    `video_${awemeId}/page`,
    `note_${awemeId}/page`,
    `slides_${awemeId}/page`,
  ];

  for (const key of preferredKeys) {
    const page = loaderData?.[key];
    const item =
      page?.videoInfoRes?.item_list?.[0] ||
      page?.videoInfoRes?.itemList?.[0] ||
      page?.aweme_detail ||
      page?.awemeDetail;
    if (item) return item;
  }

  for (const page of Object.values(loaderData || {})) {
    const item =
      page?.videoInfoRes?.item_list?.[0] ||
      page?.videoInfoRes?.itemList?.[0] ||
      page?.aweme_detail ||
      page?.awemeDetail;
    if (item) return item;
  }

  return findDouyinAwemeObject(routerData, awemeId);
}

async function scrapeDouyinFromIesSsr(awemeId, sourceUrl, pageUrlHint = "") {
  if (!awemeId) return { result: null, diagnostic: "missing_aweme_id" };
  const isPhotoHint = /\/(?:note|slides)\//i.test(String(pageUrlHint || ""));
  const pageUrl = isPhotoHint
    ? `https://www.iesdouyin.com/share/slides/${awemeId}/?from_ssr=1`
    : `https://www.iesdouyin.com/share/video/${awemeId}/?from_ssr=1`;
  try {
    const invoke =
      window.__TAURI__?.core?.invoke ||
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.invoke;
    const response = invoke
      ? await invoke("tauri_douyin_ssr_request", { url: pageUrl })
      : await scraperFetch(
          {
            url: pageUrl,
            method: "GET",
            headers: {
              "User-Agent": DOUYIN_MOBILE_UA,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
              Referer: "https://www.iesdouyin.com/",
            },
            rawResponse: true,
            parseJson: false,
          },
          "Douyin SSR",
        );
    const html = String(response?.data || "");
    const routerData = parseDouyinRouterData(html);
    if (!routerData) {
      const wafTag = response?.wafSolved ? `_waf_solved_${response?.wafNonce ?? "yes"}` : "";
      return {
        result: null,
        diagnostic: `ssr_http_${response?.status || 0}_router_data_missing_len_${html.length}${wafTag}`,
      };
    }
    const aweme = getDouyinAwemeFromRouterData(routerData, awemeId);
    if (!aweme) {
      return {
        result: null,
        diagnostic: `ssr_http_${response?.status || 0}_aweme_missing`,
      };
    }
    const result = buildDouyinSsrResult(
      aweme,
      awemeId,
      sourceUrl,
      response?.url || pageUrl,
    );
    return {
      result,
      diagnostic: result ? "ssr_success" : `ssr_http_${response?.status || 0}_media_missing`,
    };
  } catch (error) {
    console.warn("[Mori Engine] Douyin iesdouyin SSR fallback failed:", error);
    return {
      result: null,
      diagnostic: `ssr_request_failed_${String(error?.message || error || "unknown").slice(0, 160)}`,
    };
  }
}

async function douyinBrowserLoginAvailable() {
  const invoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) return false;
  try {
    const status = await invoke("tauri_douyin_auth_status", {});
    return status?.loggedIn === true;
  } catch (_) {
    return false;
  }
}

async function scrapeDouyinFromPageChannel(awemeId, sourceUrl) {
  if (!awemeId) return { result: null, diagnostic: "page_channel_missing_aweme_id" };
  const invoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) {
    return { result: null, diagnostic: "page_channel_unavailable" };
  }

  try {
    const response = await invoke("tauri_douyin_page_detail", { awemeId });
    const diagnostic = response?.diagnostic || `page_channel_http_${response?.status || 0}`;
    const payload = response?.data;
    if (!payload || typeof payload !== "object") {
      return { result: null, diagnostic };
    }

    const aweme =
      payload?.aweme_detail ||
      payload?.awemeDetail ||
      payload?.item_list?.[0] ||
      payload?.itemList?.[0] ||
      payload?.aweme_list?.[0] ||
      findDouyinAwemeObject(payload, awemeId);
    if (!aweme) {
      return { result: null, diagnostic: `${diagnostic}_aweme_missing` };
    }

    const pageUrl = `https://www.douyin.com/video/${awemeId}`;
    const result = buildDouyinSsrResult(
      aweme,
      awemeId,
      sourceUrl,
      response?.url || pageUrl,
    );
    if (result?.result?.downloads?.length) {
      const downloads = result.result.downloads;
      const isPhotoPost = downloads.every((item) => /image|photo/i.test(String(item?.type || "")));
      if (isPhotoPost) {
        downloads.forEach((item, index) => {
          item.quality = `Photo ${index + 1} · Page Channel`;
          item.diagnostic = diagnostic;
        });
        result.result.mediaKind = "images";
      } else if (downloads[0]) {
        const candidateCount = 1 + (downloads[0].fallbackUrls?.length || 0);
        downloads[0].quality = `Page Channel · ${candidateCount} Candidate${candidateCount === 1 ? "" : "s"}`;
        downloads[0].diagnostic = diagnostic;
        downloads[0].pageChannelCandidateCount = candidateCount;
        result.result.mediaKind = "video";
      }
    }
    return {
      result,
      diagnostic: result ? "page_channel_success" : `${diagnostic}_media_missing`,
    };
  } catch (error) {
    console.warn("[Mori Engine] Douyin page channel failed:", error);
    return {
      result: null,
      diagnostic: `page_channel_failed_${String(error?.message || error || "unknown").slice(0, 140)}`,
    };
  }
}

function mergeDouyinBrowserMediaIntoResult(baseResult, browserResult) {
  const browserDownloads = browserResult?.result?.downloads || [];
  const browserImages = browserDownloads.filter((item) =>
    /image|photo/i.test(String(item?.type || "")),
  );
  if (browserImages.length) {
    // Browser/API evidence of a real image collection is stronger than the old core's
    // compatibility VIDEO result, which may actually be the post soundtrack.
    return browserResult;
  }

  const baseDownload = baseResult?.result?.downloads?.find((item) =>
    /video|mp4/i.test(String(item?.type || "")),
  );
  const browserDownload = browserDownloads.find((item) =>
    /video|mp4/i.test(String(item?.type || "")),
  );
  if (!baseDownload || !browserDownload) return baseResult;

  const extraUrls = [
    browserDownload.url,
    ...(Array.isArray(browserDownload.fallbackUrls) ? browserDownload.fallbackUrls : []),
  ].filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
  if (!extraUrls.length) return baseResult;

  baseDownload.fallbackUrls = [...new Set([
    ...(Array.isArray(baseDownload.fallbackUrls) ? baseDownload.fallbackUrls : []),
    ...extraUrls,
  ].filter((value) => value && value !== baseDownload.url))];
  return baseResult;
}

function getDouyinPageHint(awemeId, pageUrlHint = "") {
  try {
    const parsed = new URL(String(pageUrlHint || ""));
    const host = parsed.hostname.toLowerCase();
    if (
      (host === "douyin.com" || host.endsWith(".douyin.com")) &&
      parsed.pathname.includes(String(awemeId || "")) &&
      /\/(?:video|note|slides)\//i.test(parsed.pathname)
    ) {
      return parsed.toString();
    }
  } catch (_) {}
  return `https://www.douyin.com/video/${awemeId}`;
}

function buildDouyinDomImageResult(capture, awemeId, sourceUrl, pageUrl) {
  const imageUrls = [...new Set(
    (Array.isArray(capture?.imageUrls) ? capture.imageUrls : [])
      .filter((value) => typeof value === "string" && /^https?:\/\//i.test(value)),
  )];
  const pageLooksLikePhoto =
    capture?.imagePost === true || /\/(?:note|slides)\//i.test(capture?.href || pageUrl || "");
  if (!imageUrls.length || (!pageLooksLikePhoto && imageUrls.length < 2)) return null;

  return {
    status: true,
    result: {
      title: String(capture?.title || `Douyin ${awemeId}`).trim(),
      thumbnail: imageUrls[0],
      sourceUrl,
      mediaKind: "images",
      downloads: imageUrls.map((url, index) => ({
        url,
        type: "IMAGE",
        quality: `Photo ${index + 1} · Browser`,
        thumbnail: url,
        headers: { Referer: capture?.href || pageUrl || "https://www.douyin.com/" },
      })),
    },
    sourceUrl,
  };
}

async function scrapeDouyinFromBrowser(awemeId, sourceUrl, pageUrlHint = "") {
  if (!awemeId) return { result: null, diagnostic: "browser_missing_aweme_id" };
  const invoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) {
    return { result: null, diagnostic: "browser_fallback_unavailable" };
  }

  const pageUrl = getDouyinPageHint(awemeId, pageUrlHint);
  try {
    const capture = await invoke("tauri_douyin_browser_request", { url: pageUrl });
    if (capture?.kind === "api") {
      const payload = capture.data || {};
      const aweme =
        payload?.item_list?.[0] ||
        payload?.itemList?.[0] ||
        payload?.aweme_detail ||
        payload?.awemeDetail ||
        findDouyinAwemeObject(payload, awemeId);
      const result = buildDouyinSsrResult(
        aweme,
        awemeId,
        sourceUrl,
        capture?.apiUrl || capture?.href || pageUrl,
      );
      const observedMediaUrls = [...new Set(
        (Array.isArray(capture?.mediaUrls) ? capture.mediaUrls : [])
          .filter((value) => typeof value === "string" && /^https?:\/\//i.test(value)),
      )];
      if (
        result?.result?.downloads?.[0] &&
        observedMediaUrls.length &&
        /video|mp4/i.test(String(result.result.downloads[0]?.type || ""))
      ) {
        const download = result.result.downloads[0];
        download.fallbackUrls = [...new Set([
          ...(download.fallbackUrls || []),
          ...observedMediaUrls,
        ].filter((value) => value && value !== download.url))];
      }
      if (!result && observedMediaUrls.length) {
        return {
          result: {
            status: true,
            result: {
              title: String(capture?.title || `Douyin ${awemeId}`).trim(),
              thumbnail: "",
              sourceUrl,
              downloads: [
                {
                  url: observedMediaUrls[0],
                  type: "VIDEO",
                  quality: "Browser Media",
                  thumbnail: "",
                  headers: { Referer: capture?.href || pageUrl },
                  fallbackUrls: observedMediaUrls.slice(1),
                },
              ],
            },
            sourceUrl,
          },
          diagnostic: "browser_observed_media_success",
        };
      }
      const domImages = buildDouyinDomImageResult(capture, awemeId, sourceUrl, pageUrl);
      return {
        result: result || domImages,
        diagnostic: result
          ? "browser_api_success"
          : domImages
            ? "browser_dom_images_success"
            : "browser_api_media_missing",
      };
    }

    const domImages = buildDouyinDomImageResult(capture, awemeId, sourceUrl, pageUrl);
    if (domImages) {
      return { result: domImages, diagnostic: "browser_dom_images_success" };
    }

    if (capture?.kind === "dom" && /^https?:\/\//i.test(capture.videoUrl || "")) {
      const observedMediaUrls = [...new Set(
        (Array.isArray(capture?.mediaUrls) ? capture.mediaUrls : [])
          .filter((value) => typeof value === "string" && /^https?:\/\//i.test(value)),
      )];
      return {
        result: {
          status: true,
          result: {
            title: String(capture.title || `Douyin ${awemeId}`).trim(),
            thumbnail: capture.poster || "",
            sourceUrl,
            downloads: [
              {
                url: capture.videoUrl,
                type: "VIDEO",
                quality: "Original",
                thumbnail: capture.poster || "",
                headers: { Referer: capture.href || pageUrl },
                fallbackUrls: observedMediaUrls.filter((value) => value !== capture.videoUrl),
              },
            ],
          },
          sourceUrl,
        },
        diagnostic: "browser_dom_success",
      };
    }

    const observedMediaUrls = [...new Set(
      (Array.isArray(capture?.mediaUrls) ? capture.mediaUrls : [])
        .filter((value) => typeof value === "string" && /^https?:\/\//i.test(value)),
    )];
    if (observedMediaUrls.length) {
      return {
        result: {
          status: true,
          result: {
            title: String(capture?.title || `Douyin ${awemeId}`).trim(),
            thumbnail: "",
            sourceUrl,
            downloads: [
              {
                url: observedMediaUrls[0],
                type: "VIDEO",
                quality: "Browser Media",
                thumbnail: "",
                headers: { Referer: capture?.href || pageUrl },
                fallbackUrls: observedMediaUrls.slice(1),
              },
            ],
          },
          sourceUrl,
        },
        diagnostic: "browser_observed_media_success",
      };
    }

    const loggedIn = capture?.loggedIn === true;
    return {
      result: null,
      diagnostic: loggedIn
        ? `browser_${capture?.kind || "unknown"}_logged_in`
        : "browser_login_required",
    };
  } catch (error) {
    console.warn("[Mori Engine] Douyin browser fallback failed:", error);
    return {
      result: null,
      diagnostic: `browser_failed_${String(error?.message || error || "unknown").slice(0, 140)}`,
    };
  }
}

export async function scrapeDouyin(url, ...rest) {
  const originalUrl = url;
  const normalizedUrl = urlUtils.extractCleanUrl?.(url) || url;
  let targetUrl = normalizedUrl;
  let resolvedUrl = normalizedUrl;
  let awemeId = extractDouyinAwemeId(normalizedUrl);

  if (
    typeof normalizedUrl === "string" &&
    (normalizedUrl.includes("v.douyin.com") || normalizedUrl.includes("/share/slides/"))
  ) {
    try {
      if (normalizedUrl.includes("v.douyin.com")) {
        const fetchRes = await scraperFetch(
          {
            url: normalizedUrl,
            method: "GET",
            headers: {
              "User-Agent": DOUYIN_MOBILE_UA,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            rawResponse: true,
          },
          "Douyin Resolver",
        );
        if (fetchRes?.url) resolvedUrl = fetchRes.url;
      }

      awemeId = awemeId || extractDouyinAwemeId(resolvedUrl);
      const slidesMatch = resolvedUrl.match(new RegExp("share/slides/([0-9]{15,22})", "i"));
      if (slidesMatch && slidesMatch[1]) {
        awemeId = awemeId || slidesMatch[1];
        targetUrl = "https://www.iesdouyin.com/share/video/" + slidesMatch[1] + "/";
      } else if (resolvedUrl && resolvedUrl !== normalizedUrl) {
        targetUrl = resolvedUrl;
      }
    } catch (e) {
      console.warn("[Mori Engine] Douyin resolver warning:", e);
    }
  }

  let pageDiagnostic = "";
  let pageChannelUsed = false;
  let res = null;

  // Since mid-Sep 2026 Douyin rejects aweme/detail requests made outside a real
  // page context. If a local login session is available, ask the official page to
  // perform the detail request first so its current security SDK signs it for us.
  if (awemeId && (await douyinBrowserLoginAvailable())) {
    const pageAttempt = await scrapeDouyinFromPageChannel(awemeId, originalUrl);
    pageDiagnostic = pageAttempt?.diagnostic || "page_channel_unknown";
    if (pageAttempt?.result?.status) {
      res = pageAttempt.result;
      pageChannelUsed = true;
      console.info("[Mori Engine] Douyin parsed via signed page channel", awemeId);
    }
  }

  const core = await loadCoreScrapers();
  if (!res?.status) {
    try {
      res = await core.scrapeDouyin(targetUrl, ...rest);
    } catch (err) {
      console.warn("[Mori Engine] Core Douyin scraper failed, trying iesdouyin SSR:", err);
    }
  }

  let ssrDiagnostic = "";
  let browserDiagnostic = "";

  // The protected core can currently report success while exposing an audio-only
  // Douyin rendition as VIDEO. Photo posts can also carry that compatibility video
  // object, so a resolved /note/ or /slides/ URL must still be checked in the real page
  // even when the page-channel request itself reported success.
  const photoPageHint = /\/(?:note|slides)\//i.test(String(targetUrl || resolvedUrl || ""));
  if (
    res?.status &&
    awemeId &&
    (photoPageHint || !pageChannelUsed) &&
    res?.result?.downloads?.some((item) => /video|mp4/i.test(String(item?.type || ""))) &&
    (await douyinBrowserLoginAvailable())
  ) {
    const browserEnrichment = await scrapeDouyinFromBrowser(
      awemeId,
      originalUrl,
      targetUrl || resolvedUrl,
    );
    browserDiagnostic = browserEnrichment?.diagnostic || "browser_enrichment_unknown";
    if (browserEnrichment?.result?.status) {
      res = mergeDouyinBrowserMediaIntoResult(res, browserEnrichment.result);
      console.info("[Mori Engine] Douyin core result enriched with browser media URLs", awemeId);
    }
  }

  if (!res?.status) {
    awemeId = awemeId || extractDouyinAwemeId(targetUrl) || extractDouyinAwemeId(resolvedUrl);
    const ssrAttempt = await scrapeDouyinFromIesSsr(
      awemeId,
      originalUrl,
      targetUrl || resolvedUrl,
    );
    ssrDiagnostic = ssrAttempt?.diagnostic || "ssr_unknown";
    if (ssrAttempt?.result?.status) {
      console.info("[Mori Engine] Douyin parsed via iesdouyin SSR fallback", awemeId);
      res = ssrAttempt.result;
    }
  }

  if (!res?.status) {
    const browserAttempt = await scrapeDouyinFromBrowser(
      awemeId,
      originalUrl,
      targetUrl || resolvedUrl,
    );
    browserDiagnostic = browserAttempt?.diagnostic || "browser_unknown";
    if (browserAttempt?.result?.status) {
      console.info("[Mori Engine] Douyin parsed via hidden WebView fallback", awemeId);
      res = browserAttempt.result;
    }
  }

  if (!res?.status) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      res = await core.scrapeDouyin(targetUrl, ...rest);
    } catch (_) {}
  }

  if (!res?.status && (pageDiagnostic || ssrDiagnostic || browserDiagnostic)) {
    const diagnostics = [pageDiagnostic, ssrDiagnostic, browserDiagnostic]
      .filter(Boolean)
      .join("|");
    const loginRequired = browserDiagnostic === "browser_login_required";
    res = {
      ...(res || {}),
      status: false,
      loginRequired,
      message: loginRequired
        ? `Douyin requires a browser login for this video. Open Settings → Network → Douyin Account, sign in, then retry. [${diagnostics}]`
        : `${res?.message || "Could not find video data in Douyin page."} [${diagnostics}]`,
    };
  }

  if (res) {
    if (res.result) res.result.sourceUrl = originalUrl;
    if (res.data) res.data.sourceUrl = originalUrl;
    res.sourceUrl = originalUrl;
  }
  return res;
}
export async function scrapeThreads(...args) { return (await loadCoreScrapers()).scrapeThreads(...args); }
export async function scrapePinterest(...args) { return (await loadCoreScrapers()).scrapePinterest(...args); }
export async function scrapeAppleMusic(...args) { return (await loadCoreScrapers()).scrapeAppleMusic(...args); }
export async function scrapeFacebook(...args) { return (await loadCoreScrapers()).scrapeFacebook(...args); }
export async function scrapeBandcamp(...args) { return (await loadCoreScrapers()).scrapeBandcamp(...args); }
