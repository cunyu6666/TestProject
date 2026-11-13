/**
 * Bilibili isolated-world bridge + DOM/script fallbacks.
 * Loaded only on bilibili hosts (see manifest). Exposes
 * `globalThis.VideoGrabberBilibili` for the generic content script.
 *
 * Limits (personal/educational local use):
 * - DASH video/audio are listed separately — no mux/merge in MV3 yet
 * - Higher qualities often require login / the quality the tab actually played
 * - DRM / paid / restricted streams are out of scope
 */

(function bilibiliIsolatedBridge() {
  const SOURCE = "video-grabber-bilibili";
  const HOST_RE = /(^|\.)bilibili\.(com|cn)$|(^|\.)biliintl\.com$|(^|\.)bili2233\.cn$/i;

  /**
   * @param {string} [hostname]
   * @returns {boolean}
   */
  function isBilibiliHost(hostname) {
    const host = (hostname || location.hostname || "").toLowerCase();
    return HOST_RE.test(host) || host.includes("bilibili.com") || host.includes("bilibili.cn");
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isBilibiliCdnUrl(url) {
    try {
      const host = new URL(url, location.href).hostname.toLowerCase();
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
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    try {
      const path = new URL(url, location.href).pathname.toLowerCase();
      const match = path.match(/\.([a-z0-9]+)(?:$)/i);
      if (match) {
        const ext = match[1].toLowerCase();
        if (["mp4", "flv", "m4s", "m3u8", "ts"].includes(ext)) return ext;
      }
      if (path.includes(".m4s")) return "m4s";
    } catch {
      /* ignore */
    }
    return isBilibiliCdnUrl(url) ? "mp4" : null;
  }

  /**
   * @param {unknown} playinfo
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromPlayinfo(playinfo, origin) {
    if (!playinfo || typeof playinfo !== "object") return [];
    const root = /** @type {Record<string, unknown>} */ (playinfo);
    const dataRaw = root.data || root.result || root;
    const data =
      dataRaw && typeof dataRaw === "object"
        ? /** @type {Record<string, unknown>} */ (dataRaw)
        : root;

    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    /**
     * @param {unknown} url
     * @param {string} source
     * @param {{ type?: string | null, size?: number | null }} [extra]
     */
    function pushUrl(url, source, extra = {}) {
      if (typeof url !== "string" || !url) return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      hits.push({
        url,
        type: extra.type || guessType(url),
        size: extra.size ?? null,
        source,
      });
    }

    const durl = Array.isArray(data.durl)
      ? data.durl
      : Array.isArray(root.durl)
        ? root.durl
        : [];
    for (const item of durl) {
      if (!item || typeof item !== "object") continue;
      const d = /** @type {Record<string, unknown>} */ (item);
      const size =
        typeof d.size === "number" && Number.isFinite(d.size) ? d.size : null;
      pushUrl(d.url, `${origin}-durl`, {
        type: guessType(String(d.url || "")) || "mp4",
        size,
      });
      if (Array.isArray(d.backup_url)) {
        for (const b of d.backup_url) pushUrl(b, `${origin}-durl-backup`, { size });
      }
    }

    const dash =
      data.dash && typeof data.dash === "object"
        ? /** @type {Record<string, unknown>} */ (data.dash)
        : root.dash && typeof root.dash === "object"
          ? /** @type {Record<string, unknown>} */ (root.dash)
          : null;

    if (dash) {
      const videos = Array.isArray(dash.video) ? dash.video : [];
      for (const item of videos) {
        if (!item || typeof item !== "object") continue;
        const v = /** @type {Record<string, unknown>} */ (item);
        const id = v.id != null ? String(v.id) : "";
        const base = typeof v.baseUrl === "string" ? v.baseUrl : v.base_url;
        const size =
          typeof v.size === "number" && Number.isFinite(v.size) ? v.size : null;
        pushUrl(base, `${origin}-dash-video${id ? "-" + id : ""}`, {
          type: guessType(String(base || "")) || "m4s",
          size,
        });
        const backups = Array.isArray(v.backupUrl)
          ? v.backupUrl
          : Array.isArray(v.backup_url)
            ? v.backup_url
            : [];
        for (const b of backups) {
          pushUrl(b, `${origin}-dash-video-backup`, {
            type: guessType(String(b || "")) || "m4s",
          });
        }
      }

      const audios = Array.isArray(dash.audio) ? dash.audio : [];
      for (const item of audios) {
        if (!item || typeof item !== "object") continue;
        const a = /** @type {Record<string, unknown>} */ (item);
        const base = typeof a.baseUrl === "string" ? a.baseUrl : a.base_url;
        pushUrl(base, `${origin}-dash-audio`, {
          type: guessType(String(base || "")) || "m4s",
        });
        const backups = Array.isArray(a.backupUrl)
          ? a.backupUrl
          : Array.isArray(a.backup_url)
            ? a.backup_url
            : [];
        for (const b of backups) {
          pushUrl(b, `${origin}-dash-audio-backup`, {
            type: guessType(String(b || "")) || "m4s",
          });
        }
      }
    }

    return hits;
  }

  /**
   * Parse `__playinfo__` / playurl JSON embedded in page `<script>` text.
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function extractFromScriptTags() {
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text || text.length < 20) continue;

      const markers = [
        { key: "window.__playinfo__", origin: "bilibili-script-playinfo" },
        { key: "__playinfo__", origin: "bilibili-script-playinfo" },
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
            hits.push(...collectFromPlayinfo(parsed, marker.origin));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
    return hits;
  }

  /**
   * Performance entries on bilivideo CDN hosts (often query-token URLs).
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
      if (!entry?.name || !isBilibiliCdnUrl(entry.name)) continue;
      const size =
        typeof entry.transferSize === "number" && entry.transferSize > 0
          ? entry.transferSize
          : null;
      hits.push({
        url: entry.name,
        type: guessType(entry.name),
        size,
        source: "bilibili-cdn",
      });
    }
    return hits;
  }

  /**
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collect() {
    if (!isBilibiliHost()) return [];
    const merged = [
      ...extractFromScriptTags(),
      ...extractFromPerformance(),
    ];
    // Ask MAIN world to re-scan globals / hooked playurl cache.
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

  globalThis.VideoGrabberBilibili = {
    isBilibiliHost,
    isBilibiliCdnUrl,
    collectFromPlayinfo,
    collect,
    subscribeMainWorld,
  };
})();
