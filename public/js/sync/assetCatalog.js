const DEFAULT_MAX_DISPLAY_SIDE = 2048;
const DEFAULT_DISPLAY_QUALITY = 0.88;
const DISPLAY_ENCODING_ALGORITHM = "canvas-reference-v1";

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value || []);
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export async function sha256Hex(bytes) {
  const data = asBytes(bytes);
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("SHA-256 is unavailable on this platform");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function sha256AssetId(hash) {
  const value = String(hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid SHA-256 hash");
  return `sha256:${value}`;
}

export function detectImageType(bytes, mimeHint = "", nameHint = "") {
  const data = asBytes(bytes);
  const mime = String(mimeHint || "").toLowerCase();
  const name = String(nameHint || "").toLowerCase();

  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(data, 0, 6))) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (data.length >= 2 && ascii(data, 0, 2) === "BM") {
    return { ext: "bmp", mime: "image/bmp" };
  }
  if (data.length >= 12 && ascii(data, 4, 4) === "ftyp") {
    const brand = ascii(data, 8, 4).toLowerCase();
    if (["avif", "avis"].includes(brand)) return { ext: "avif", mime: "image/avif" };
  }

  const prefix = new TextDecoder().decode(data.slice(0, Math.min(data.length, 256))).trimStart();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) {
    return { ext: "svg", mime: "image/svg+xml" };
  }

  const mimeMap = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
  };
  if (mimeMap[mime]) return { ext: mimeMap[mime], mime: mime === "image/jpg" ? "image/jpeg" : mime };

  const extension = name.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]?.toLowerCase();
  const extMap = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  if (extension && extMap[extension]) {
    return { ext: extension === "jpeg" ? "jpg" : extension, mime: extMap[extension] };
  }
  return null;
}

async function decodeImage(bytes, mime, allowImageFallback = false) {
  const blob = new Blob([asBytes(bytes)], { type: mime || "application/octet-stream" });
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch (_) {
      // Fall through to the browser's image decoder when the bitmap decoder
      // does not support this image format, notably SVG in some WebViews.
    }
  }

  if (!allowImageFallback || typeof Image !== "function" || typeof URL?.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Image decode failed"));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Decoded image has no dimensions");
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      image,
      close() {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
        URL.revokeObjectURL(url);
      },
    };
  } catch (_) {
    URL.revokeObjectURL(url);
    return null;
  }
}

async function imageDimensions(bytes, mime, allowImageFallback = false) {
  const bitmap = await decodeImage(bytes, mime, allowImageFallback);
  if (!bitmap) return { width: 0, height: 0 };
  const dimensions = { width: Number(bitmap.width) || 0, height: Number(bitmap.height) || 0 };
  bitmap.close?.();
  return dimensions;
}

async function buildDisplayVariant(bytes, type, options = {}) {
  const data = asBytes(bytes);
  const maxSideLimit = Math.max(256, Number(options.maxDisplaySide) || DEFAULT_MAX_DISPLAY_SIDE);
  const quality = Math.max(0.1, Math.min(1, Number(options.displayQuality) || DEFAULT_DISPLAY_QUALITY));
  const legacyDisplay = options.legacyDisplay === true;
  const encoding = legacyDisplay
    ? null
    : { algorithm: DISPLAY_ENCODING_ALGORITHM, maxSide: maxSideLimit, quality };
  const unchanged = (width = 0, height = 0) => ({
    bytes: data,
    mime: type.mime,
    ext: type.ext,
    width,
    height,
    transformed: false,
    ...(encoding ? { encoding } : {}),
  });
  const bitmap = await decodeImage(data, type.mime, !legacyDisplay);

  if (!bitmap) {
    return unchanged();
  }

  const width = Number(bitmap.width) || 0;
  const height = Number(bitmap.height) || 0;
  const maxSide = Math.max(width, height);
  const canRasterize = !legacyDisplay || !["gif", "svg"].includes(type.ext);

  if (!canRasterize || (legacyDisplay && maxSide <= maxSideLimit)) {
    bitmap.close?.();
    return unchanged(width, height);
  }

  const scale = maxSide > maxSideLimit ? maxSideLimit / maxSide : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { alpha: legacyDisplay });
  if (!ctx) {
    bitmap.close?.();
    canvas.width = 0;
    canvas.height = 0;
    return unchanged(width, height);
  }
  if (!legacyDisplay) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  try {
    ctx.drawImage(bitmap.image || bitmap, 0, 0, canvas.width, canvas.height);
  } catch (_) {
    bitmap.close?.();
    canvas.width = 0;
    canvas.height = 0;
    return unchanged(width, height);
  }
  bitmap.close?.();

  const displayWidth = canvas.width;
  const displayHeight = canvas.height;
  const outputType = legacyDisplay ? "image/webp" : "image/jpeg";
  let output = null;
  try {
    output = await new Promise((resolve) => canvas.toBlob(resolve, outputType, quality));
  } catch (_) {
    output = null;
  }
  canvas.width = 0;
  canvas.height = 0;

  if (!output || output.type !== outputType) {
    return unchanged(width, height);
  }

  const outputBytes = new Uint8Array(await output.arrayBuffer());
  if (!outputBytes.length || (!legacyDisplay && type.ext === "jpg" && outputBytes.length > data.length)) {
    return unchanged(width, height);
  }

  return {
    bytes: outputBytes,
    mime: outputType,
    ext: outputType === "image/jpeg" ? "jpg" : "webp",
    width: displayWidth,
    height: displayHeight,
    transformed: true,
    ...(encoding ? { encoding } : {}),
  };
}

export async function preparePlannerImageAsset(bytes, options = {}) {
  const sourceBytes = asBytes(bytes);
  if (!sourceBytes.length) throw new Error("Planner asset is empty");

  const type = detectImageType(sourceBytes, options.mime, options.filename || options.name);
  if (!type) throw new Error("Planner asset is not a supported image");

  const sourceHashHex = await sha256Hex(sourceBytes);
  const sourceHash = sha256AssetId(sourceHashHex);
  const sourceDimensions = await imageDimensions(sourceBytes, type.mime, options.legacyDisplay !== true);
  const display = await buildDisplayVariant(sourceBytes, type, options);
  const displayHash = sha256AssetId(await sha256Hex(display.bytes));

  return {
    asset: {
      id: sourceHash,
      type: "image",
      source: {
        hash: sourceHash,
        mime: type.mime,
        ext: type.ext,
        width: sourceDimensions.width || display.width || 0,
        height: sourceDimensions.height || display.height || 0,
        bytes: sourceBytes.length,
      },
      display: {
        hash: displayHash,
        mime: display.mime,
        ext: display.ext,
        width: display.width || sourceDimensions.width || 0,
        height: display.height || sourceDimensions.height || 0,
        bytes: display.bytes.length,
        transformed: display.transformed === true,
        ...(display.encoding ? { encoding: display.encoding } : {}),
      },
    },
    sourceBytes,
    displayBytes: display.bytes,
  };
}

export function plannerAssetNeedsDisplayRebuild(asset) {
  const encoding = asset?.display?.encoding;
  return (
    encoding?.algorithm !== DISPLAY_ENCODING_ALGORITHM ||
    Number(encoding?.maxSide) !== DEFAULT_MAX_DISPLAY_SIDE ||
    Number(encoding?.quality) !== DEFAULT_DISPLAY_QUALITY
  );
}

export async function plannerAssetFromPackageEntry(entry, bytes) {
  const displayBytes = asBytes(bytes);
  if (!displayBytes.length) throw new Error("Planner package asset is empty");
  const type = detectImageType(displayBytes, entry?.display?.mime || entry?.mime, entry?.filename);
  if (!type) throw new Error("Planner package asset is not a supported image");

  const actualDisplayHash = sha256AssetId(await sha256Hex(displayBytes));
  const declaredDisplayHash = String(entry?.display?.hash || "");
  if (declaredDisplayHash && declaredDisplayHash !== actualDisplayHash) {
    throw new Error("Planner package display asset hash mismatch");
  }

  const displayDimensions = await imageDimensions(displayBytes, type.mime);
  const sourceId = String(entry?.id || entry?.source?.hash || actualDisplayHash);
  if (!sourceId.startsWith("sha256:")) {
    throw new Error("Planner package asset id must be sha256-based");
  }

  return {
    id: sourceId,
    type: "image",
    source: {
      hash: sourceId,
      mime: String(entry?.source?.mime || ""),
      ext: String(entry?.source?.ext || ""),
      width: Number(entry?.source?.width) || 0,
      height: Number(entry?.source?.height) || 0,
      bytes: Number(entry?.source?.bytes ?? entry?.originalBytes) || 0,
    },
    display: {
      hash: actualDisplayHash,
      mime: String(entry?.display?.mime || entry?.mime || type.mime),
      ext: String(entry?.display?.ext || type.ext),
      width: Number(entry?.display?.width) || displayDimensions.width || 0,
      height: Number(entry?.display?.height) || displayDimensions.height || 0,
      bytes: displayBytes.length,
      transformed: entry?.display?.transformed === true || sourceId !== actualDisplayHash,
      ...(entry?.display?.encoding && typeof entry.display.encoding === "object"
        ? { encoding: { ...entry.display.encoding } }
        : {}),
    },
  };
}

export function createPlannerAssetLocalBinding(assetId, local = {}) {
  if (!String(assetId || "").startsWith("sha256:")) {
    throw new Error("Planner asset local binding requires a sha256 asset id");
  }
  return {
    assetId: String(assetId),
    path: String(local.path || ""),
    uri: String(local.uri || local.path || ""),
    thumbnail: String(local.thumbnail || ""),
    filename: String(local.filename || ""),
    updatedAt: Number(local.updatedAt) || Date.now(),
  };
}
