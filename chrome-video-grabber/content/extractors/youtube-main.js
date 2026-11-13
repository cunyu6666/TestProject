/**
 * YouTube MAIN-world extractor (MV3 content_scripts world: "MAIN").
 * Reads ytInitialPlayerResponse / streamingData and hooks player-related
 * fetch / XHR, then posts hits to the isolated content script via
 * window.postMessage (no chrome.* APIs here).
 *
 * Educational / personal local use — no signature decipher, no HLS merge, no DRM.
 */
(function youtubeMainExtractor() {
  const SOURCE = "video-grabber-youtube";
  const PLAYER_HINT =
    /\/youtubei\/v1\/player|get_video_info|\/player\?/i;

  /**
   * All discovered hits. Early postMessages may fire before the isolated
   * subscriber is attached (document_start vs document_idle); we buffer and
   * replay on scan-request so those URLs are not permanently lost.
   * @type {Map<string, { url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  const buffered = new Map();

  /** URLs already postMessaged in the current "live" window (not during replay). */
  /** @type {Set<string>} */
  const sent = new Set();

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
   * @param {unknown} value
   * @returns {object | null}
   */
  function asObject(value) {
    return value && typeof value === "object" ? /** @type {object} */ (value) : null;
  }

  /**
   * @param {string} cipher
   * @returns {string | null}
   */
  function urlFromSignatureCipher(cipher) {
    if (!cipher || typeof cipher !== "string") return null;
    try {
      const params = new URLSearchParams(cipher);
      const raw = params.get("url");
      return raw || null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize player response / streamingData into video hits.
   * Only emits formats that already have a playable `url` (or cipher-embedded
   * url=). Signature / n-parameter decipher is intentionally out of scope —
   * cipher-only streams without a working URL are skipped.
   *
   * @param {unknown} playerResponse
   * @param {string} origin
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectFromPlayerResponse(playerResponse, origin) {
    const root = asObject(playerResponse);
    if (!root) return [];

    // Some payloads wrap the real response.
    const nested =
      asObject(root.playerResponse) ||
      asObject(root.response) ||
      (typeof root.player_response === "string"
        ? (() => {
            try {
              return JSON.parse(root.player_response);
            } catch {
              return null;
            }
          })()
        : null);

    const pr = nested || root;
    const streaming =
      asObject(pr.streamingData) ||
      asObject(root.streamingData) ||
      null;
    if (!streaming) return [];

    /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
    const hits = [];

    /**
     * @param {unknown} item
     * @param {string} kind
     */
    function pushFormat(item, kind) {
      const f = asObject(item);
      if (!f) return;

      let url = typeof f.url === "string" ? f.url : null;
      let source = `${origin}-${kind}`;
      if (!url && typeof f.signatureCipher === "string") {
        url = urlFromSignatureCipher(f.signatureCipher);
        // Cipher URL without decipher usually 403s — still surface only if
        // a direct url= is present so the user can see it; mark source.
        source = `${origin}-${kind}-cipher`;
      }
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:") || url.startsWith("data:")) return;

      // Prefer progressive (muxed) over adaptive when labeling.
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
      if (typeof f.contentLength === "string" || typeof f.contentLength === "number") {
        const n = Number(f.contentLength);
        if (Number.isFinite(n) && n > 0) size = n;
      }

      // Prefer format mimeType over URL/host heuristics.
      const type = typeFromMimeType(f.mimeType) || guessTypeFromUrl(url);

      hits.push({ url, type, size, source });
    }

    const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
    for (const item of formats) pushFormat(item, "progressive");

    const adaptive = Array.isArray(streaming.adaptiveFormats)
      ? streaming.adaptiveFormats
      : [];
    for (const item of adaptive) pushFormat(item, "adaptive");

    // HLS / DASH manifests when present (listed only; no merge).
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
   * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} videos
   */
  function postVideos(videos) {
    if (!videos.length) return;
    try {
      window.postMessage(
        { source: SOURCE, type: "videos", videos },
        location.origin
      );
    } catch {
      window.postMessage(
        { source: SOURCE, type: "videos", videos },
        "*"
      );
    }
  }

  /**
   * Merge into buffer; post only URLs not yet sent (live path).
   * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} hits
   */
  function publish(hits) {
    if (!Array.isArray(hits) || hits.length === 0) return;
    const fresh = [];
    for (const hit of hits) {
      if (!hit?.url) continue;
      const key = hit.url;
      const prev = buffered.get(key);
      if (!prev) {
        buffered.set(key, hit);
      } else {
        buffered.set(key, {
          ...prev,
          ...hit,
          type: hit.type || prev.type || null,
          size: hit.size ?? prev.size ?? null,
          source: hit.source || prev.source,
        });
      }
      if (sent.has(key)) continue;
      sent.add(key);
      fresh.push(buffered.get(key));
    }
    postVideos(fresh);
  }

  /**
   * Replay every buffered hit (clears the live sent gate). Used when the
   * isolated bridge asks for a scan after connecting at document_idle.
   */
  function replayBuffered() {
    if (buffered.size === 0) return;
    const videos = Array.from(buffered.values());
    sent.clear();
    for (const hit of videos) sent.add(hit.url);
    postVideos(videos);
  }

  function scanGlobals() {
    try {
      // @ts-expect-error page global
      if (window.ytInitialPlayerResponse) {
        // @ts-expect-error page global
        publish(
          collectFromPlayerResponse(
            window.ytInitialPlayerResponse,
            "youtube-player-response"
          )
        );
      }
    } catch {
      /* ignore */
    }

    try {
      // @ts-expect-error page global
      const cfg = window.ytplayer?.config;
      const args = asObject(cfg?.args);
      if (args) {
        if (typeof args.player_response === "string") {
          try {
            publish(
              collectFromPlayerResponse(
                JSON.parse(args.player_response),
                "youtube-ytplayer-config"
              )
            );
          } catch {
            /* ignore */
          }
        } else if (args.player_response) {
          publish(
            collectFromPlayerResponse(
              args.player_response,
              "youtube-ytplayer-config"
            )
          );
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
  function handlePlayerPayload(url, payload) {
    const obj = asObject(payload);
    if (!obj) return;
    const hasStreaming =
      asObject(obj.streamingData) ||
      asObject(asObject(obj.response)?.streamingData) ||
      asObject(asObject(obj.playerResponse)?.streamingData);
    if (!hasStreaming && !PLAYER_HINT.test(url)) return;
    publish(collectFromPlayerResponse(obj, "youtube-player-api"));
  }

  function hookNetwork() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto && !proto.__videoGrabberYtPatched) {
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
            if (!PLAYER_HINT.test(reqUrl) && !/player/i.test(reqUrl)) return;
            const text = this.responseText;
            if (!text) return;
            handlePlayerPayload(reqUrl, JSON.parse(text));
          } catch {
            /* ignore non-JSON */
          }
        });
        return send.apply(this, args);
      };
      proto.__videoGrabberYtPatched = true;
    }

    if (typeof window.fetch === "function" && !window.__videoGrabberYtFetchPatched) {
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
          if (PLAYER_HINT.test(reqUrl) || /\/youtubei\/v1\/player/i.test(reqUrl)) {
            const clone = response.clone();
            clone
              .json()
              .then((payload) => handlePlayerPayload(reqUrl, payload))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return response;
      };
      window.__videoGrabberYtFetchPatched = true;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== "scan-request") return;
    scanGlobals();
    // Re-emit buffered hits so early MAIN posts (before subscribe) are recovered.
    replayBuffered();
  });

  hookNetwork();
  scanGlobals();
  setTimeout(scanGlobals, 800);
  setTimeout(scanGlobals, 2500);
})();
