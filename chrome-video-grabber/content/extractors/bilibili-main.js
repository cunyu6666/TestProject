/**
 * Bilibili MAIN-world extractor (MV3 content_scripts world: "MAIN").
 * Reads page `__playinfo__` / playurl API responses and posts hits to the
 * isolated content script via window.postMessage (no chrome.* APIs here).
 *
 * Educational / personal local use — no HLS merge, no DRM unlock.
 */
(function bilibiliMainExtractor() {
  const SOURCE = "video-grabber-bilibili";
  const PLAYURL_HINT =
    /playurl|player\/wbi\/playurl|player\/playurl|pgc\/player|pugv\/player/i;

  /** @type {Map<string, { url: string, type?: string | null, size?: number | null, source?: string }>} */
  const buffered = new Map();

  /**
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    try {
      const path = new URL(url, location.href).pathname.toLowerCase();
      if (path.endsWith(".m4s")) return "m4s";
      if (path.endsWith(".mp4")) return "mp4";
      if (path.endsWith(".flv")) return "flv";
      if (path.endsWith(".m3u8")) return "m3u8";
      if (path.includes(".m4s")) return "m4s";
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * @param {unknown} value
   * @returns {object | null}
   */
  function asObject(value) {
    return value && typeof value === "object" ? /** @type {object} */ (value) : null;
  }

  /**
   * Normalize playinfo / playurl JSON into video hits.
   * @param {unknown} playinfo
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromPlayinfo(playinfo, origin) {
    const root = asObject(playinfo);
    if (!root) return [];

    const data =
      asObject(root.data) ||
      asObject(root.result) ||
      asObject(root.dash ? root : null) ||
      root;

    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    /**
     * @param {string | undefined | null} url
     * @param {string} source
     * @param {{ type?: string | null, size?: number | null }} [extra]
     */
    function pushUrl(url, source, extra = {}) {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;
      hits.push({
        url,
        type: extra.type || guessType(url),
        size: extra.size ?? null,
        source,
      });
    }

    const durl = /** @type {unknown[]} */ (
      Array.isArray(data.durl) ? data.durl : Array.isArray(root.durl) ? root.durl : []
    );
    for (const item of durl) {
      const d = asObject(item);
      if (!d) continue;
      const size =
        typeof d.size === "number" && Number.isFinite(d.size) ? d.size : null;
      pushUrl(
        typeof d.url === "string" ? d.url : null,
        `${origin}-durl`,
        { type: guessType(String(d.url || "")) || "mp4", size }
      );
      const backups = Array.isArray(d.backup_url) ? d.backup_url : [];
      for (const b of backups) {
        if (typeof b === "string") {
          pushUrl(b, `${origin}-durl-backup`, {
            type: guessType(b) || "mp4",
            size,
          });
        }
      }
    }

    const dash =
      asObject(data.dash) ||
      asObject(root.dash) ||
      null;
    if (dash) {
      const videos = Array.isArray(dash.video) ? dash.video : [];
      for (const item of videos) {
        const v = asObject(item);
        if (!v) continue;
        const id = v.id != null ? String(v.id) : "";
        const base = typeof v.baseUrl === "string" ? v.baseUrl : typeof v.base_url === "string" ? v.base_url : null;
        const size =
          typeof v.size === "number" && Number.isFinite(v.size) ? v.size : null;
        pushUrl(base, `${origin}-dash-video${id ? "-" + id : ""}`, {
          type: guessType(base || "") || "m4s",
          size,
        });
        const backups = Array.isArray(v.backupUrl)
          ? v.backupUrl
          : Array.isArray(v.backup_url)
            ? v.backup_url
            : [];
        for (const b of backups) {
          if (typeof b === "string") {
            pushUrl(b, `${origin}-dash-video-backup`, {
              type: guessType(b) || "m4s",
            });
          }
        }
      }

      const audios = Array.isArray(dash.audio) ? dash.audio : [];
      for (const item of audios) {
        const a = asObject(item);
        if (!a) continue;
        const base =
          typeof a.baseUrl === "string"
            ? a.baseUrl
            : typeof a.base_url === "string"
              ? a.base_url
              : null;
        pushUrl(base, `${origin}-dash-audio`, {
          type: guessType(base || "") || "m4s",
        });
        const backups = Array.isArray(a.backupUrl)
          ? a.backupUrl
          : Array.isArray(a.backup_url)
            ? a.backup_url
            : [];
        for (const b of backups) {
          if (typeof b === "string") {
            pushUrl(b, `${origin}-dash-audio-backup`, {
              type: guessType(b) || "m4s",
            });
          }
        }
      }
    }

    return hits;
  }

  /**
   * Store hits so early document_start discoveries survive until the
   * isolated bridge listens (document_idle) and can request a replay.
   * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} hits
   * @param {{ replayAll?: boolean }} [opts]
   */
  function publish(hits, opts = {}) {
    if (!Array.isArray(hits) || hits.length === 0) {
      if (!opts.replayAll || buffered.size === 0) return;
    }
    const fresh = [];
    for (const hit of hits || []) {
      if (!hit?.url) continue;
      const key = hit.url;
      if (!buffered.has(key)) {
        buffered.set(key, hit);
        fresh.push(hit);
      }
    }
    const toSend = opts.replayAll
      ? Array.from(buffered.values())
      : fresh;
    if (toSend.length === 0) return;
    try {
      window.postMessage(
        { source: SOURCE, type: "videos", videos: toSend },
        location.origin
      );
    } catch {
      window.postMessage(
        { source: SOURCE, type: "videos", videos: toSend },
        "*"
      );
    }
  }

  /** Replay every buffered hit (for late bridge subscribers). */
  function replayBuffered() {
    publish([], { replayAll: true });
  }

  function scanGlobals() {
    try {
      // @ts-expect-error page global
      if (window.__playinfo__) {
        // @ts-expect-error page global
        publish(collectFromPlayinfo(window.__playinfo__, "bilibili-playinfo"));
      }
    } catch {
      /* ignore */
    }

    try {
      // @ts-expect-error page global
      const state = window.__INITIAL_STATE__;
      if (state && typeof state === "object") {
        // Some embeds stash playurl under nested keys; best-effort walk one level.
        const maybe =
          state.playData ||
          state.videoData?.playData ||
          state.player ||
          null;
        if (maybe) {
          publish(collectFromPlayinfo(maybe, "bilibili-initial"));
        }
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} url
   * @param {unknown} payload
   */
  function handlePlayurlPayload(url, payload) {
    if (!PLAYURL_HINT.test(url) && !asObject(payload)?.dash && !asObject(asObject(payload)?.data)?.dash) {
      // Still accept if it looks like playinfo shape.
      const data = asObject(asObject(payload)?.data);
      if (!data?.dash && !Array.isArray(data?.durl) && !Array.isArray(asObject(payload)?.durl)) {
        return;
      }
    }
    publish(collectFromPlayinfo(payload, "bilibili-playurl"));
  }

  function hookNetwork() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto && !proto.__videoGrabberBiliPatched) {
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
            if (!PLAYURL_HINT.test(reqUrl)) return;
            let payload = null;
            // responseType "json" makes responseText throw InvalidStateError.
            if (this.responseType === "json") {
              payload = this.response;
            } else if (this.responseType === "" || this.responseType === "text") {
              const text = this.responseText;
              if (!text) return;
              payload = JSON.parse(text);
            } else if (typeof this.response === "string" && this.response) {
              payload = JSON.parse(this.response);
            }
            if (payload == null) return;
            handlePlayurlPayload(reqUrl, payload);
          } catch {
            /* ignore non-JSON */
          }
        });
        return send.apply(this, args);
      };
      proto.__videoGrabberBiliPatched = true;
    }

    if (typeof window.fetch === "function" && !window.__videoGrabberBiliFetchPatched) {
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
          if (PLAYURL_HINT.test(reqUrl)) {
            const clone = response.clone();
            clone
              .json()
              .then((payload) => handlePlayurlPayload(reqUrl, payload))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return response;
      };
      window.__videoGrabberBiliFetchPatched = true;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "scan-request" || data.type === "ready") {
      scanGlobals();
      replayBuffered();
    }
  });

  hookNetwork();
  scanGlobals();
  // Player often fills __playinfo__ just after first paint.
  setTimeout(scanGlobals, 800);
  setTimeout(scanGlobals, 2500);
})();
