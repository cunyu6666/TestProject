/**
 * Xiaohongshu isolated-world bridge + DOM/script fallbacks.
 * Loaded only on xiaohongshu / xhslink hosts (see manifest). Exposes
 * `globalThis.VideoGrabberXiaohongshu` for the generic content script.
 *
 * Limits (personal/educational local use):
 * - Login / captcha walls are common on web; we only see JSON already in the tab
 * - CDN media URLs often expire or require the browser's cookies / Referer
 * - Watermark: prefer originVideoKey / streamType 258 when present; 259 may be
 *   a watermarked export stream. In-player overlay watermarks are not burned
 *   into every CDN file — honesty: we cannot guarantee a clean file forever
 * - No HLS playlist merge; progressive mp4 listed when available
 */

(function xiaohongshuIsolatedBridge() {
  const SOURCE = "video-grabber-xiaohongshu";
  const HOST_RE =
    /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$|(^|\.)xhscdn\.com$/i;
  const CDN_BASE = "https://sns-video-bd.xhscdn.com/";

  /**
   * @param {string} [hostname]
   * @returns {boolean}
   */
  function isXiaohongshuHost(hostname) {
    const host = (hostname || location.hostname || "").toLowerCase();
    return (
      HOST_RE.test(host) ||
      host.includes("xiaohongshu.com") ||
      host.includes("xhslink.com") ||
      host.includes("xhscdn.com")
    );
  }

  /**
   * Explore / discovery / note / user video pages (and xhslink redirects).
   * @param {string} [href]
   * @returns {boolean}
   */
  function isNoteOrVideoPage(href) {
    try {
      const u = new URL(href || location.href);
      const host = u.hostname.toLowerCase();
      if (host.includes("xhslink.com")) return true;
      const path = u.pathname.toLowerCase();
      return (
        path.startsWith("/explore/") ||
        path.startsWith("/discovery/item/") ||
        path.startsWith("/note/") ||
        path.includes("/user/profile/") ||
        /\/[0-9a-f]{16,}$/i.test(path)
      );
    } catch {
      return true;
    }
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isXiaohongshuCdnUrl(url) {
    try {
      const u = new URL(url, location.href);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      // Reject image CDN / extensions — generic scan must not treat photos as mp4.
      if (/\.(jpe?g|png|webp|gif|svg|ico|bmp|avif)(?:$)/i.test(path)) {
        return false;
      }
      if (/webpic|sns-avatar|sns-img/i.test(host)) return false;
      // sns-video-bd / sns-video-hw / spectrum / stream under *.xhscdn.com
      if (host === "xhscdn.com" || host.endsWith(".xhscdn.com")) {
        if (/sns-video/i.test(host)) return true;
        if (/\.(mp4|m3u8|m4s|webm|mov)(?:$)/i.test(path)) return true;
        if (/\/(?:spectrum|stream)\//i.test(path)) return true;
        return false;
      }
      if (host.includes("xiaohongshu.com") && /\.mp4(?:$|[?#])/i.test(url)) {
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
   * Soften JS expressions so JSON.parse can accept SSR blobs.
   * @param {string} raw
   * @returns {string}
   */
  function sanitizeJsObjectLiteral(raw) {
    return raw
      .replace(/\bundefined\b/g, "null")
      .replace(/new\s+Map\s*\([^)]*\)/g, "{}")
      .replace(/new\s+Set\s*\([^)]*\)/g, "[]")
      .replace(/new\s+Date\s*\([^)]*\)/g, "null");
  }

  /**
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    try {
      const path = new URL(url, location.href).pathname.toLowerCase();
      if (path.endsWith(".mp4") || path.includes(".mp4")) return "mp4";
      if (path.endsWith(".m3u8")) return "m3u8";
      if (path.endsWith(".m4s")) return "m4s";
      if (path.endsWith(".webm")) return "webm";
    } catch {
      /* ignore */
    }
    return isXiaohongshuCdnUrl(url) ? "mp4" : null;
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  function urlFromOriginVideoKey(key) {
    if (!key || typeof key !== "string") return null;
    const cleaned = key
      .replace(/\\u002F/gi, "/")
      .replace(/^\/+/, "")
      .trim();
    if (!cleaned) return null;
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
    return CDN_BASE + cleaned;
  }

  /**
   * @param {unknown} value
   * @returns {object | null}
   */
  function asObject(value) {
    return value && typeof value === "object"
      ? /** @type {object} */ (value)
      : null;
  }

  /**
   * @param {unknown} streamEntry
   * @param {string} origin
   * @param {string} codec
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function hitsFromStreamEntry(streamEntry, origin, codec) {
    const s = asObject(streamEntry);
    if (!s) return [];
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    const streamType =
      s.streamType != null
        ? String(s.streamType)
        : s.stream_type != null
          ? String(s.stream_type)
          : "";
    const preferred = streamType === "258" || streamType === "301";
    const watermarky = streamType === "259" || streamType === "309";

    /**
     * @param {string | null | undefined} url
     * @param {string} kind
     */
    function push(url, kind) {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      const tagBits = [
        codec,
        streamType && `t${streamType}`,
        preferred ? "clean" : watermarky ? "wm" : "",
      ]
        .filter(Boolean)
        .join("-");
      hits.push({
        url,
        type: guessType(url) || "mp4",
        size:
          typeof s.size === "number" && Number.isFinite(s.size) ? s.size : null,
        source: `${origin}-${kind}${tagBits ? "-" + tagBits : ""}`,
      });
    }

    const master =
      typeof s.masterUrl === "string"
        ? s.masterUrl
        : typeof s.master_url === "string"
          ? s.master_url
          : typeof s.url === "string"
            ? s.url
            : null;
    push(master, "stream");
    const backups = Array.isArray(s.backupUrls)
      ? s.backupUrls
      : Array.isArray(s.backup_urls)
        ? s.backup_urls
        : [];
    for (const b of backups) {
      if (typeof b === "string") push(b, "stream-backup");
    }
    return hits;
  }

  /**
   * @param {unknown} video
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromVideo(video, origin) {
    const v = asObject(video);
    if (!v) return [];
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    /**
     * @param {string | null | undefined} url
     * @param {string} source
     */
    function pushUrl(url, source) {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      hits.push({
        url,
        type: guessType(url) || "mp4",
        size: null,
        source,
      });
    }

    const consumer = asObject(v.consumer);
    if (consumer) {
      const key =
        typeof consumer.originVideoKey === "string"
          ? consumer.originVideoKey
          : typeof consumer.origin_video_key === "string"
            ? consumer.origin_video_key
            : null;
      const built = urlFromOriginVideoKey(key || "");
      if (built) pushUrl(built, `${origin}-originVideoKey`);
    }

    const media = asObject(v.media);
    if (media) {
      const mediaKey =
        typeof media.originVideoKey === "string"
          ? media.originVideoKey
          : typeof media.origin_video_key === "string"
            ? media.origin_video_key
            : null;
      const built = urlFromOriginVideoKey(mediaKey || "");
      if (built) pushUrl(built, `${origin}-media-originVideoKey`);

      const stream = asObject(media.stream);
      if (stream) {
        for (const codec of ["h264", "H264", "h265", "H265", "av1", "AV1"]) {
          const list = Array.isArray(stream[codec]) ? stream[codec] : [];
          for (const entry of list) {
            hits.push(
              ...hitsFromStreamEntry(entry, origin, codec.toLowerCase())
            );
          }
        }
      }
    }

    let mediaV2 = v.mediaV2 ?? v.media_v2;
    if (typeof mediaV2 === "string") {
      try {
        mediaV2 = JSON.parse(mediaV2);
      } catch {
        mediaV2 = null;
      }
    }
    const mv = asObject(mediaV2);
    if (mv) {
      const opaque = asObject(mv.opaque1) || asObject(mv.opaque);
      if (opaque) {
        for (const key of [
          "hd_screencast_stream",
          "default_screencast_stream",
          "screencast_stream",
        ]) {
          if (typeof opaque[key] === "string") {
            pushUrl(opaque[key], `${origin}-mediaV2-${key}`);
          }
        }
      }
      const mvConsumer = asObject(mv.consumer);
      if (mvConsumer && typeof mvConsumer.originVideoKey === "string") {
        const built = urlFromOriginVideoKey(mvConsumer.originVideoKey);
        if (built) pushUrl(built, `${origin}-mediaV2-originVideoKey`);
      }
    }

    if (typeof v.url === "string") pushUrl(v.url, `${origin}-video-url`);
    return hits;
  }

  /**
   * @param {unknown} note
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromNote(note, origin) {
    const n = asObject(note);
    if (!n) return [];
    if (n.video) return collectFromVideo(n.video, origin);
    const nested = asObject(n.note);
    if (nested?.video) return collectFromVideo(nested.video, origin);
    return [];
  }

  /**
   * @param {unknown} stateOrPayload
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromState(stateOrPayload, origin) {
    const root = asObject(stateOrPayload);
    if (!root) return [];
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    const noteRoot = asObject(root.note);
    if (noteRoot) {
      const map = asObject(noteRoot.noteDetailMap);
      if (map) {
        const preferredId =
          typeof noteRoot.firstNoteId === "string"
            ? noteRoot.firstNoteId
            : null;
        const ids = preferredId
          ? [preferredId, ...Object.keys(map).filter((k) => k !== preferredId)]
          : Object.keys(map);
        for (const id of ids) {
          const detail = asObject(map[id]);
          if (!detail) continue;
          const note = asObject(detail.note) || detail;
          hits.push(...collectFromNote(note, origin));
        }
      }
    }

    const noteDataOuter = asObject(root.noteData);
    const noteDataInner =
      asObject(asObject(noteDataOuter?.data)?.noteData) ||
      asObject(noteDataOuter?.noteData) ||
      asObject(noteDataOuter?.data) ||
      noteDataOuter;
    if (noteDataInner) {
      hits.push(...collectFromNote(noteDataInner, `${origin}-noteData`));
    }

    const data = asObject(root.data);
    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(root.items)
        ? root.items
        : [];
    for (const item of items) {
      const it = asObject(item);
      if (!it) continue;
      const card =
        asObject(it.note_card) ||
        asObject(it.noteCard) ||
        asObject(it.note) ||
        it;
      hits.push(...collectFromNote(card, `${origin}-feed`));
    }

    if (root.video) hits.push(...collectFromVideo(root.video, origin));
    return hits;
  }

  /**
   * Regex fallback: originVideoKey in page HTML / scripts.
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function extractOriginKeysFromText(text, origin) {
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    if (!text) return hits;
    const re = /"originVideoKey"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
      const url = urlFromOriginVideoKey(raw);
      if (url) {
        hits.push({
          url,
          type: "mp4",
          size: null,
          source: origin,
        });
      }
    }
    return hits;
  }

  /**
   * Parse window.__INITIAL_STATE__ embedded in page scripts.
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
        !text.includes("__INITIAL_STATE__") &&
        !text.includes("originVideoKey") &&
        !text.includes("noteDetailMap")
      ) {
        continue;
      }

      const markers = [
        "window.__INITIAL_STATE__",
        "__INITIAL_STATE__",
        "window.__INITIAL_SSR_STATE__",
      ];
      for (const marker of markers) {
        let from = 0;
        while (from < text.length) {
          const idx = text.indexOf(marker, from);
          if (idx === -1) break;
          const eq = text.indexOf("=", idx + marker.length);
          if (eq === -1) break;
          let i = eq + 1;
          while (i < text.length && /\s/.test(text[i])) i += 1;
          if (text[i] !== "{") {
            from = idx + marker.length;
            continue;
          }
          const jsonText = sliceJsonObject(text, i);
          from = idx + marker.length;
          if (!jsonText) continue;
          try {
            const parsed = JSON.parse(sanitizeJsObjectLiteral(jsonText));
            hits.push(
              ...collectFromState(parsed, "xiaohongshu-script-initial")
            );
          } catch {
            /* ignore malformed */
          }
        }
      }

      hits.push(
        ...extractOriginKeysFromText(text, "xiaohongshu-script-originKey")
      );
    }
    return hits;
  }

  /**
   * og:video meta (often a watermarked progressive mp4 — still useful).
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function extractFromMeta() {
    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];
    const metas = document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[name="og:video"]'
    );
    for (const meta of metas) {
      const content = meta.getAttribute("content");
      if (content && /^https?:\/\//i.test(content)) {
        hits.push({
          url: content,
          type: guessType(content) || "mp4",
          size: null,
          source: "xiaohongshu-og-video",
        });
      }
    }
    return hits;
  }

  /**
   * Performance entries on xhscdn / sns-video hosts.
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
      if (!entry?.name || !isXiaohongshuCdnUrl(entry.name)) continue;
      // Skip tiny images / sprites on the same CDN when possible.
      if (/\.(jpe?g|png|webp|gif|svg)(?:$|[?#])/i.test(entry.name)) continue;
      const size =
        typeof entry.transferSize === "number" && entry.transferSize > 0
          ? entry.transferSize
          : null;
      hits.push({
        url: entry.name,
        type: guessType(entry.name),
        size,
        source: "xiaohongshu-cdn",
      });
    }
    return hits;
  }

  /**
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collect() {
    if (!isXiaohongshuHost()) return [];
    const merged = [
      ...extractFromScriptTags(),
      ...extractFromMeta(),
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

  globalThis.VideoGrabberXiaohongshu = {
    isXiaohongshuHost,
    isNoteOrVideoPage,
    isXiaohongshuCdnUrl,
    collectFromState,
    collectFromVideo,
    collect,
    subscribeMainWorld,
  };
})();
