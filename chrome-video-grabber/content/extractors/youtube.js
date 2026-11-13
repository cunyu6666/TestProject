/**
 * YouTube isolated-world bridge + DOM/script fallbacks.
 * Loaded only on YouTube hosts (see manifest). Exposes
 * `globalThis.VideoGrabberYouTube` for the generic content script.
 *
 * Limits (personal/educational local use):
 * - Adaptive (DASH-like) video/audio are listed separately — no mux/merge in MV3
 * - Formats needing signature / n-parameter decipher are skipped or may 403
 * - Higher qualities often require login / whatever the tab already played
 * - DRM / age-restricted / paid / copyright-claim blocked streams are out of scope
 */

(function youtubeIsolatedBridge() {
  const SOURCE = "video-grabber-youtube";
  const HOST_RE =
    /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$|(^|\.)googlevideo\.com$/i;

  /**
   * @param {string} [hostname]
   * @returns {boolean}
   */
  function isYouTubeHost(hostname) {
    const host = (hostname || location.hostname || "").toLowerCase();
    return (
      HOST_RE.test(host) ||
      host.includes("youtube.com") ||
      host.includes("youtu.be") ||
      host.includes("youtube-nocookie.com")
    );
  }

  /**
   * Watch / Shorts / youtu.be paths (extraction is still useful on other YT pages
   * if a player is present, but we gate aggressive scans to media pages).
   * @param {string} [href]
   * @returns {boolean}
   */
  function isWatchOrShortsPage(href) {
    try {
      const u = new URL(href || location.href);
      const path = u.pathname.toLowerCase();
      if (u.hostname.toLowerCase().includes("youtu.be") && path.length > 1) {
        return true;
      }
      return (
        path === "/watch" ||
        path.startsWith("/watch/") ||
        path.startsWith("/shorts/") ||
        path.startsWith("/embed/") ||
        path.startsWith("/live/")
      );
    } catch {
      return true;
    }
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isGoogleVideoUrl(url) {
    try {
      const u = new URL(url, location.href);
      const host = u.hostname.toLowerCase();
      if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) {
        return true;
      }
      // videoplayback on youtube hosts
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
   * Extract a balanced JSON object starting at `start` (`{`).
   * @param {string} text
   * @param {number} start
   * @returns {string | null}
   */
  function sliceJsonObject(text, start) {
    if (text[start] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Type from URL query/path only — never hostname defaults.
   * @param {string} url
   * @returns {string | null}
   */
  function guessTypeFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const mime = u.searchParams.get("mime");
      if (mime) {
        const decoded = decodeURIComponent(mime).toLowerCase();
        if (decoded.includes("webm")) return "webm";
        if (decoded.includes("mp4")) return "mp4";
        if (decoded.includes("mp2t")) return "ts";
      }
      const path = u.pathname.toLowerCase();
      if (path.endsWith(".mp4")) return "mp4";
      if (path.endsWith(".webm")) return "webm";
      if (path.endsWith(".m3u8")) return "m3u8";
      if (path.endsWith(".mpd")) return "mpd";
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * @param {unknown} mimeType
   * @returns {string | null}
   */
  function typeFromMimeType(mimeType) {
    if (typeof mimeType !== "string") return null;
    const mime = mimeType.toLowerCase();
    if (mime.includes("webm")) return "webm";
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("mp2t")) return "ts";
    return null;
  }

  /**
   * Performance / CDN fallback: URL metadata first, then googlevideo → mp4.
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    return guessTypeFromUrl(url) || (isGoogleVideoUrl(url) ? "mp4" : null);
  }

  /**
   * @param {string} cipher
   * @returns {string | null}
   */
  function urlFromSignatureCipher(cipher) {
    if (!cipher || typeof cipher !== "string") return null;
    try {
      return new URLSearchParams(cipher).get("url");
    } catch {
      return null;
    }
  }

  /**
   * @param {unknown} playerResponse
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromPlayerResponse(playerResponse, origin) {
    if (!playerResponse || typeof playerResponse !== "object") return [];
    const root = /** @type {Record<string, unknown>} */ (playerResponse);

    let nested = null;
    if (root.playerResponse && typeof root.playerResponse === "object") {
      nested = root.playerResponse;
    } else if (typeof root.player_response === "string") {
      try {
        nested = JSON.parse(root.player_response);
      } catch {
        nested = null;
      }
    }

    const pr =
      nested && typeof nested === "object"
        ? /** @type {Record<string, unknown>} */ (nested)
        : root;

    const streamingRaw = pr.streamingData || root.streamingData;
    if (!streamingRaw || typeof streamingRaw !== "object") return [];
    const streaming = /** @type {Record<string, unknown>} */ (streamingRaw);

    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    /**
     * @param {unknown} item
     * @param {string} kind
     */
    function pushFormat(item, kind) {
      if (!item || typeof item !== "object") return;
      const f = /** @type {Record<string, unknown>} */ (item);

      let url = typeof f.url === "string" ? f.url : null;
      let source = `${origin}-${kind}`;
      if (!url && typeof f.signatureCipher === "string") {
        url = urlFromSignatureCipher(f.signatureCipher);
        source = `${origin}-${kind}-cipher`;
      }
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;

      const itag = f.itag != null ? String(f.itag) : "";
      const quality =
        typeof f.qualityLabel === "string"
          ? f.qualityLabel
          : typeof f.audioQuality === "string"
            ? f.audioQuality
            : "";
      const tagBits = [itag && `itag${itag}`, quality].filter(Boolean).join("-");
      if (tagBits) source = `${source}-${tagBits}`;

      let size = null;
      if (f.contentLength != null) {
        const n = Number(f.contentLength);
        if (Number.isFinite(n) && n > 0) size = n;
      }

      // Prefer format mimeType over URL heuristics / googlevideo mp4 fallback.
      let type = typeFromMimeType(f.mimeType) || guessTypeFromUrl(url);
      if (!type && isGoogleVideoUrl(url)) type = "mp4";

      hits.push({ url, type, size, source });
    }

    const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
    for (const item of formats) pushFormat(item, "progressive");

    const adaptive = Array.isArray(streaming.adaptiveFormats)
      ? streaming.adaptiveFormats
      : [];
    for (const item of adaptive) pushFormat(item, "adaptive");

    if (typeof streaming.hlsManifestUrl === "string") {
      hits.push({
        url: streaming.hlsManifestUrl,
        type: "m3u8",
        size: null,
        source: `${origin}-hls`,
      });
    }
    if (typeof streaming.dashManifestUrl === "string") {
      hits.push({
        url: streaming.dashManifestUrl,
        type: "mpd",
        size: null,
        source: `${origin}-dash`,
      });
    }

    return hits;
  }

  /**
   * Parse `ytInitialPlayerResponse` / player_response embedded in page scripts.
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function extractFromScriptTags() {
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text || text.length < 40) continue;
      if (
        !text.includes("ytInitialPlayerResponse") &&
        !text.includes("streamingData") &&
        !text.includes("player_response")
      ) {
        continue;
      }

      const markers = [
        {
          key: "ytInitialPlayerResponse",
          origin: "youtube-script-player-response",
        },
        {
          key: "var ytInitialPlayerResponse",
          origin: "youtube-script-player-response",
        },
      ];

      for (const marker of markers) {
        let from = 0;
        while (from < text.length) {
          const idx = text.indexOf(marker.key, from);
          if (idx === -1) break;
          const eq = text.indexOf("=", idx + marker.key.length);
          if (eq === -1) break;
          let i = eq + 1;
          while (i < text.length && /\s/.test(text[i])) i += 1;
          if (text[i] !== "{") {
            from = idx + marker.key.length;
            continue;
          }
          const jsonText = sliceJsonObject(text, i);
          from = idx + marker.key.length;
          if (!jsonText) continue;
          try {
            const parsed = JSON.parse(jsonText);
            hits.push(...collectFromPlayerResponse(parsed, marker.origin));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
    return hits;
  }

  /**
   * Performance entries on googlevideo / videoplayback hosts.
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function extractFromPerformance() {
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    let entries;
    try {
      entries = performance.getEntriesByType("resource");
    } catch {
      return hits;
    }
    for (const entry of entries) {
      if (!entry?.name || !isGoogleVideoUrl(entry.name)) continue;
      const size =
        typeof entry.transferSize === "number" && entry.transferSize > 0
          ? entry.transferSize
          : null;
      hits.push({
        url: entry.name,
        type: guessType(entry.name),
        size,
        source: "youtube-googlevideo",
      });
    }
    return hits;
  }

  /**
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collect() {
    if (!isYouTubeHost()) return [];
    const merged = [
      ...extractFromScriptTags(),
      ...extractFromPerformance(),
    ];
    try {
      window.postMessage(
        { source: SOURCE, type: "scan-request" },
        location.origin
      );
    } catch {
      window.postMessage({ source: SOURCE, type: "scan-request" }, "*");
    }
    return merged;
  }

  /**
   * @param {(hits: Array<{ url: string, type?: string | null, size?: number | null, source?: string }>) => void} onHits
   * @returns {() => void} unsubscribe
   */
  function subscribeMainWorld(onHits) {
    /**
     * @param {MessageEvent} event
     */
    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== SOURCE || data.type !== "videos") return;
      if (!Array.isArray(data.videos)) return;
      onHits(data.videos);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }

  globalThis.VideoGrabberYouTube = {
    isYouTubeHost,
    isWatchOrShortsPage,
    isGoogleVideoUrl,
    collectFromPlayerResponse,
    collect,
    subscribeMainWorld,
  };
})();
