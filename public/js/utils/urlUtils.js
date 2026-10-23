/**
 * URL Utilities for Mori Media Downloader
 * Handles URL extraction, protocol normalization, and tracker parameter stripping.
 */

/**
 * Extracts a clean URL from an input string (which may contain share text, comments, etc.)
 * and normalizes the protocol.
 * @param {string} text - Raw input text or URL
 * @returns {string} Clean normalized URL
 */
export function extractCleanUrl(text) {
  if (!text || typeof text !== "string") return "";
  const match = text.match(/https?:\/\/[^\s]+/i);
  const trimmed = text.trim();
  let clean = match ? match[0] : trimmed;

  // If there is no explicit http(s) URL, only accept a single bare domain/path.
  // This prevents arbitrary clipboard prose from being turned into `https://...`.
  if (!match) {
    const looksLikeBareUrl =
      !/\s/.test(clean) &&
      /^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(clean);
    if (!looksLikeBareUrl) return "";
  }

  // Shared captions often append punctuation directly after the URL.
  // Strip only obvious sentence/quote terminators so signed query strings stay intact.
  clean = clean.replace(/[，。！？；：、）】》〉」』”’"'>),;!?]+$/g, "");

  if (!clean) return "";

  // Ensure it has a protocol if missing
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = "https://" + clean;
  }

  return cleanUrl(clean);
}

/**
 * Backwards-compatible alias for extractCleanUrl.
 */
export function getCleanUrl(text) {
  return extractCleanUrl(text);
}

/**
 * Strips tracking parameters and normalizes URL trailing slashes.
 * @param {string} url - Target URL to clean
 * @returns {string} Sanitized URL
 */
export function cleanUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const trackerParams = [
      "igsh",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "s",
      "t",
      "si",
      "feature",
    ];

    trackerParams.forEach((p) => u.searchParams.delete(p));

    if (u.hostname.includes("tiktok.com")) {
      u.search = ""; // TikTok tracking parameters
    } else if (
      u.hostname.includes("youtube.com") ||
      u.hostname.includes("youtu.be")
    ) {
      if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
        const v = u.searchParams.get("v");
        u.search = "";
        u.searchParams.set("v", v);
      }
    } else if (
      u.hostname.includes("xiaohongshu.com") ||
      u.hostname.includes("rednote.com") ||
      u.hostname.includes("xhslink.com") ||
      u.hostname.includes("xhslink.cn")
    ) {
      // Keep xsec_token for Xiaohongshu / RedNote security validation
    } else if (!u.hostname.includes("facebook.com")) {
      if (!u.searchParams.has("id") && !u.searchParams.has("story_fbid")) {
        u.search = "";
      }
    }

    return u.href.replace(/\/$/, "");
  } catch (e) {
    return url.split("?")[0].replace(/\/$/, "");
  }
}
