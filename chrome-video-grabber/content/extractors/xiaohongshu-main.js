/**
 * Xiaohongshu MAIN-world extractor (MV3 content_scripts world: "MAIN").
 * Reads `__INITIAL_STATE__` note video JSON and hooks note/feed API
 * fetch / XHR, then posts hits to the isolated content script via
 * window.postMessage (no chrome.* APIs here).
 *
 * Educational / personal local use — no HLS merge, no DRM unlock.
 * Limits: login walls common; CDN URLs may expire / need browser cookies;
 * originVideoKey / streamType 258 are typically cleaner than 259 watermarked
 * export streams — we prefer those when present.
 */
(function xiaohongshuMainExtractor() {
  const SOURCE = "video-grabber-xiaohongshu";
  const NOTE_API_HINT =
    /\/api\/sns\/web\/v1\/feed|\/api\/sns\/web\/v\d+\/note|\/api\/sns\/v\d+\/note|edith\.xiaohongshu\.com|\/web_api\/sns/i;
  const CDN_BASE = "https://sns-video-bd.xhscdn.com/";

  /** @type {Set<string>} */
  const sent = new Set();
  /** @type {Map<string, { url: string, type?: string | null, size?: number | null, source?: string }>} */
  const cache = new Map();

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
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    try {
      const path = new URL(url, location.href).pathname.toLowerCase();
      if (path.endsWith(".mp4")) return "mp4";
      if (path.endsWith(".m3u8")) return "m3u8";
      if (path.endsWith(".m4s")) return "m4s";
      if (path.endsWith(".webm")) return "webm";
      if (path.includes(".mp4")) return "mp4";
    } catch {
      /* ignore */
    }
    return null;
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
   * Prefer progressive masterUrl / origin keys; skip pure HLS playlists
   * unless they are the only stream (listed only — no merge).
   *
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
    const desc =
      typeof s.streamDesc === "string"
        ? s.streamDesc
        : typeof s.stream_desc === "string"
          ? s.stream_desc
          : "";

    // Prefer no/low-watermark progressive types (258 / 301 / X264_MP4).
    const preferred =
      streamType === "258" ||
      streamType === "301" ||
      /X264_MP4|ORIGIN|NO.?WATER/i.test(desc);
    const watermarky =
      streamType === "259" ||
      streamType === "309" ||
      /WATER.?MARK|小程序/i.test(desc);

    /**
     * @param {string | null | undefined} url
     * @param {string} kind
     */
    function push(url, kind) {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      let type = guessType(url);
      if (!type && /\.m3u8(?:$|[?#])/i.test(url)) type = "m3u8";
      if (!type) type = "mp4";
      const tagBits = [
        codec,
        streamType && `t${streamType}`,
        preferred ? "clean" : watermarky ? "wm" : "",
      ]
        .filter(Boolean)
        .join("-");
      hits.push({
        url,
        type,
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
   * Walk a note.video object (desktop + H5 shapes).
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
     * @param {{ type?: string | null, size?: number | null }} [extra]
     */
    function pushUrl(url, source, extra = {}) {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      hits.push({
        url,
        type: extra.type || guessType(url) || "mp4",
        size: extra.size ?? null,
        source,
      });
    }

    // Prefer consumer.originVideoKey (often cleaner progressive).
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

    // media.originVideoKey (some clients nest differently).
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

    // mediaV2 may be a JSON string with screencast / consumer keys.
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
      if (mvConsumer) {
        const key =
          typeof mvConsumer.originVideoKey === "string"
            ? mvConsumer.originVideoKey
            : null;
        const built = urlFromOriginVideoKey(key || "");
        if (built) pushUrl(built, `${origin}-mediaV2-originVideoKey`);
      }
    }

    if (typeof v.url === "string") {
      pushUrl(v.url, `${origin}-video-url`);
    }

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
    // Some payloads nest note again.
    if (asObject(n.note)?.video) {
      return collectFromVideo(asObject(n.note)?.video, origin);
    }
    return [];
  }

  /**
   * Normalize `__INITIAL_STATE__` / feed API JSON into video hits.
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

    // H5 / mobile noteData shapes.
    const noteDataOuter = asObject(root.noteData);
    const noteDataInner =
      asObject(asObject(noteDataOuter?.data)?.noteData) ||
      asObject(noteDataOuter?.noteData) ||
      asObject(noteDataOuter?.data) ||
      noteDataOuter;
    if (noteDataInner) {
      hits.push(...collectFromNote(noteDataInner, `${origin}-noteData`));
    }

    // Feed API: data.items[].note_card / note
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

    // Direct video object.
    if (root.video) {
      hits.push(...collectFromVideo(root.video, origin));
    }

    return hits;
  }

  /**
   * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} videos
   */
  function postVideos(videos) {
    if (!Array.isArray(videos) || videos.length === 0) return;
    try {
      window.postMessage(
        { source: SOURCE, type: "videos", videos },
        location.origin
      );
    } catch {
      window.postMessage({ source: SOURCE, type: "videos", videos }, "*");
    }
  }

  /**
   * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} hits
   */
  function publish(hits) {
    if (!Array.isArray(hits) || hits.length === 0) return;
    const fresh = [];
    for (const hit of hits) {
      if (!hit?.url) continue;
      const key = hit.url;
      // Always retain for late isolated-world subscribers (document_idle).
      cache.set(key, hit);
      if (sent.has(key)) continue;
      sent.add(key);
      fresh.push(hit);
    }
    postVideos(fresh);
  }

  /**
   * Replay every buffered hit so scan-request after document_idle recovers
   * API-only URLs that arrived before the bridge subscribed.
   */
  function replayBuffered() {
    const all = Array.from(cache.values());
    postVideos(all);
  }

  function scanGlobals() {
    try {
      // @ts-expect-error page global
      if (window.__INITIAL_STATE__) {
        // @ts-expect-error page global
        publish(
          collectFromState(window.__INITIAL_STATE__, "xiaohongshu-initial")
        );
      }
    } catch {
      /* ignore */
    }

    try {
      // @ts-expect-error page global
      if (window.__INITIAL_SSR_STATE__) {
        // @ts-expect-error page global
        publish(
          collectFromState(
            window.__INITIAL_SSR_STATE__,
            "xiaohongshu-ssr"
          )
        );
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} url
   * @param {unknown} payload
   */
  function handleNotePayload(url, payload) {
    const obj = asObject(payload);
    if (!obj) return;
    const looksLikeNote =
      asObject(obj.note) ||
      asObject(obj.noteData) ||
      asObject(asObject(obj.data)?.note) ||
      Array.isArray(asObject(obj.data)?.items) ||
      asObject(obj.video) ||
      NOTE_API_HINT.test(url);
    if (!looksLikeNote) return;
    publish(collectFromState(obj, "xiaohongshu-api"));
  }

  function hookNetwork() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto && !proto.__videoGrabberXhsPatched) {
      const open = proto.open;
      const send = proto.send;
      proto.open = function (method, url, ...rest) {
        try {
          this.__vgUrl = typeof url === "string" ? url : String(url);
        } catch {
          this.__vgUrl = "";
        }
        return open.call(this, method, url, ...rest);
      };
      proto.send = function (...args) {
        this.addEventListener("load", function () {
          try {
            const reqUrl = this.__vgUrl || "";
            if (!NOTE_API_HINT.test(reqUrl) && !/note|feed/i.test(reqUrl)) {
              return;
            }
            const text = this.responseText;
            if (!text) return;
            handleNotePayload(reqUrl, JSON.parse(text));
          } catch {
            /* ignore non-JSON */
          }
        });
        return send.apply(this, args);
      };
      proto.__videoGrabberXhsPatched = true;
    }

    if (
      typeof window.fetch === "function" &&
      !window.__videoGrabberXhsFetchPatched
    ) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        const response = await originalFetch(input, init);
        try {
          const reqUrl =
            typeof input === "string"
              ? input
              : input && typeof input.url === "string"
                ? input.url
                : "";
          if (NOTE_API_HINT.test(reqUrl) || /\/note|\/feed/i.test(reqUrl)) {
            const clone = response.clone();
            clone
              .json()
              .then((payload) => handleNotePayload(reqUrl, payload))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return response;
      };
      window.__videoGrabberXhsFetchPatched = true;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== "scan-request") return;
    scanGlobals();
    replayBuffered();
  });

  hookNetwork();
  scanGlobals();
  setTimeout(scanGlobals, 800);
  setTimeout(scanGlobals, 2500);
})();
