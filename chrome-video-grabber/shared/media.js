/**
 * Shared media URL helpers — used by background + content (duplicated logic
 * kept in sync via this module for the SW; content script inlines a copy
 * because classic content scripts cannot import ES modules without a bundler).
 */

export const MEDIA_EXTENSIONS = [
  "mp4",
  "webm",
  "m4v",
  "mov",
  "mkv",
  "ogv",
  "ogg",
  "avi",
  "flv",
  "ts",
  "m4s",
];

export const MEDIA_MIME_PREFIXES = ["video/", "application/vnd.apple.mpegurl"];

const EXT_PATTERN = new RegExp(
  `\\.(${MEDIA_EXTENSIONS.join("|")})(?:$|[?#])`,
  "i"
);

/**
 * @param {string} url
 * @returns {string | null}
 */
export function guessTypeFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    if (!match) return null;
    const ext = match[1].toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext) ? ext : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} contentType
 * @returns {string | null}
 */
export function typeFromContentType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("video/")) {
    const subtype = mime.slice("video/".length);
    if (subtype === "quicktime") return "mov";
    if (subtype === "x-m4v") return "m4v";
    if (subtype === "ogg") return "ogv";
    return subtype || "video";
  }
  if (mime === "application/vnd.apple.mpegurl" || mime === "application/x-mpegurl") {
    return "m3u8";
  }
  return null;
}

/**
 * Bilibili / bili* media CDN hosts (playurl dash segments, mp4 durl).
 * @param {string} url
 * @returns {boolean}
 */
export function isBilibiliCdnUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "bilivideo.com" ||
      host.endsWith(".bilivideo.com") ||
      host === "bilivideo.cn" ||
      host.endsWith(".bilivideo.cn") ||
      host.endsWith(".bilivideo.net")
    );
  } catch {
    return false;
  }
}

/**
 * YouTube googlevideo / videoplayback media URLs (often extensionless + query tokens).
 * @param {string} url
 * @returns {boolean}
 */
export function isGoogleVideoUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) {
      return true;
    }
    if (
      (host.includes("youtube.com") || host.includes("youtu.be")) &&
      /\/videoplayback/i.test(u.pathname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Xiaohongshu media CDN hosts (sns-video-*.xhscdn.com progressive / spectrum keys).
 * @param {string} url
 * @returns {boolean}
 */
export function isXiaohongshuCdnUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "xhscdn.com" || host.endsWith(".xhscdn.com");
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {string} [contentType]
 * @returns {boolean}
 */
export function looksLikeMediaUrl(url, contentType) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("blob:") || url.startsWith("data:")) return false;
  if (contentType && MEDIA_MIME_PREFIXES.some((p) => contentType.toLowerCase().startsWith(p))) {
    return true;
  }
  if (typeFromContentType(contentType || "")) return true;
  // Bilibili / YouTube / XHS CDNs often use tokenized URLs without a clear extension;
  // also accept octet-stream from those hosts.
  if (
    isBilibiliCdnUrl(url) ||
    isGoogleVideoUrl(url) ||
    isXiaohongshuCdnUrl(url)
  ) {
    if (!contentType) return true;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime === "application/octet-stream" ||
      mime === "application/dash+xml" ||
      mime === ""
    ) {
      return true;
    }
  }
  return EXT_PATTERN.test(url);
}

/**
 * Strip fragment; keep query (CDNs often put tokens there).
 * @param {string} url
 * @returns {string}
 */
export function normalizeMediaUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * @param {number | undefined | null} bytes
 * @returns {string | null}
 */
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
