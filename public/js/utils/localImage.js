import { Filesystem } from "./plugins.js";

const loads = new WeakMap();
const publicDirectories = ["EXTERNAL_STORAGE", "DOCUMENTS", "EXTERNAL"];

function mimeFor(path) {
  const extension = String(path).split(/[?#]/)[0].split(".").pop().toLowerCase();
  return { png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" }[extension] || "image/jpeg";
}

function originalLocalPath(raw) {
  try {
    const url = new URL(raw);
    // Previously stored WebView URLs are display addresses, not filesystem paths.
    if (url.origin === window.location.origin) {
      if (url.pathname.startsWith("/_capacitor_file_/")) {
        return decodeURIComponent(url.pathname.slice("/_capacitor_file_".length));
      }
      if (url.pathname.startsWith("/_capacitor_content_/")) {
        return `content:/${url.pathname.slice("/_capacitor_content_".length)}${url.search}`;
      }
    }
  } catch (_) {}
  return raw;
}

function displayUrl(uri) {
  // Plain absolute paths can contain #, ?, %, spaces or non-ASCII filenames.
  const fileUri = uri.startsWith("/")
    ? `file://${uri.split("/").map(encodeURIComponent).join("/")}`
    : uri;
  return window.Capacitor.convertFileSrc(fileUri);
}

export async function loadAndroidLocalImage(img, source, fallback = "") {
  if (window.Capacitor?.getPlatform?.() !== "android") return false;

  loads.get(img)?.cancel?.();
  const state = { cancel: null };
  loads.set(img, state);
  const isCurrent = () => loads.get(img) === state;
  const show = (url) => new Promise((resolve) => {
    if (!isCurrent() || !url) return resolve(false);
    const finish = (loaded) => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      if (state.cancel === cancel) state.cancel = null;
      resolve(loaded && isCurrent());
    };
    const onLoad = () => finish(img.naturalWidth > 0);
    const onError = () => finish(false);
    const cancel = () => finish(false);
    state.cancel = cancel;
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    img.src = url;
  });

  const paths = typeof source === "string"
    ? [source]
    : [source?.uri, source?.path];
  let lastError = "local_image_unavailable";
  for (const raw of [...new Set(paths.filter(Boolean).map(String))]) {
    const path = originalLocalPath(raw);
    const relative = !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path);
    const declaredDirectory = typeof source === "object" && source
      ? source.directory || (source.storage === "cache" || source.cachedImage ? "DATA" : "")
      : "";
    const options = declaredDirectory
      ? [{ path, directory: declaredDirectory }]
      : relative
        ? publicDirectories.map((directory) => ({ path, directory }))
        : [{ path }];
    for (const option of options) {
      if (!isCurrent()) return true;
      try {
        // convertFileSrc deliberately leaves relative paths unchanged. Resolve the
        // directory first; a getUri result alone does not prove the file exists.
        const uri = relative ? (await Filesystem.getUri(option))?.uri : path;
        if (!isCurrent()) return true;
        if (uri && await show(displayUrl(uri))) {
          img.dataset.localImageState = "loaded";
          return true;
        }
        if (!isCurrent()) return true;
        if (Filesystem && !/^(?:https?:|data:|blob:)/i.test(path)) {
          const result = await Filesystem.readFile(option);
          if (!isCurrent()) return true;
          if (typeof result?.data === "string" && result.data) {
            const dataUrl = result.data.startsWith("data:")
              ? result.data : `data:${mimeFor(path)};base64,${result.data}`;
            if (await show(dataUrl)) {
              img.dataset.localImageState = "loaded";
              return true;
            }
          }
        }
      } catch (error) {
        lastError = String(error?.code || "local_image_read_failed");
      }
    }
  }
  if (!isCurrent()) return true;
  img.dataset.localImageState = "unavailable";
  // Keep useful thumbnail fallback, but never retry it recursively or rewrite data.
  if (fallback) await show(fallback);
  if (isCurrent()) console.warn("Android local image unavailable:", lastError);
  return true;
}
