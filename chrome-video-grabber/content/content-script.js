/**
 * Content script — generic video detection on the active page.
 * - DOM: <video> / <source> src (+ currentSrc)
 * - Performance resource timing for obvious media URLs
 * - MutationObserver for late-injected media
 * - Bilibili: uses content/extractors/bilibili*.js when present (manifest)
 * - YouTube / Xiaohongshu: stub hooks only
 */

(function initVideoGrabberContentScript() {
  const MEDIA_EXTENSIONS = [
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
  const EXT_PATTERN = new RegExp(
    `\\.(${MEDIA_EXTENSIONS.join("|")})(?:$|[?#])`,
    "i"
  );

  /** @type {Set<string>} */
  const reported = new Set();
  let flushTimer = 0;
  /** @type {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>} */
  const pending = [];

  /**
   * @param {string} url
   * @returns {string}
   */
  function normalize(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = "";
      return u.href;
    } catch {
      return url;
    }
  }

  /**
   * @param {string} url
   * @returns {string | null}
   */
  function guessType(url) {
    try {
      const path = new URL(url, location.href).pathname;
      const match = path.match(/\.([a-z0-9]+)$/i);
      if (!match) return null;
      const ext = match[1].toLowerCase();
      return MEDIA_EXTENSIONS.includes(ext) ? ext : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isBilibiliCdn(url) {
    if (globalThis.VideoGrabberBilibili?.isBilibiliCdnUrl) {
      return globalThis.VideoGrabberBilibili.isBilibiliCdnUrl(url);
    }
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
   * @param {string} url
   * @returns {boolean}
   */
  function looksLikeMedia(url) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
    if (EXT_PATTERN.test(url)) return true;
    return isBilibiliCdn(url);
  }

  /**
   * @param {string} rawUrl
   * @param {string} source
   * @param {{ type?: string | null, size?: number | null }} [extra]
   */
  function enqueue(rawUrl, source, extra = {}) {
    if (!rawUrl) return;
    const url = normalize(rawUrl);
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (reported.has(url)) return;
    // DOM / Bilibili playurl may use extensionless or tokenized CDN URLs.
    const allowLoose =
      source === "dom" ||
      source === "dom-source" ||
      (typeof source === "string" && source.startsWith("bilibili"));
    if (!allowLoose && !looksLikeMedia(url)) {
      return;
    }
    reported.add(url);
    pending.push({
      url,
      type: extra.type || guessType(url) || (isBilibiliCdn(url) ? "mp4" : null),
      size: extra.size ?? null,
      source,
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 120);
  }

  function flush() {
    flushTimer = 0;
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    chrome.runtime.sendMessage(
      { type: "videos:found", videos: batch },
      () => {
        if (chrome.runtime.lastError) {
          console.debug(
            "[Video Grabber] videos:found failed:",
            chrome.runtime.lastError.message
          );
        }
      }
    );
  }

  function scanDomVideos() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const current = video.currentSrc || video.src;
      if (current) enqueue(current, "dom");
      const sources = video.querySelectorAll("source");
      for (const source of sources) {
        const src = source.src || source.getAttribute("src");
        if (src) enqueue(src, "dom-source");
      }
    }

    // Standalone <source> under media elements (rare outside video/audio).
    for (const source of document.querySelectorAll("video > source, source[src]")) {
      const parent = source.parentElement;
      if (parent && parent.tagName === "VIDEO") {
        const src = source.src || source.getAttribute("src");
        if (src) enqueue(src, "dom-source");
      }
    }
  }

  function scanPerformanceEntries() {
    let entries;
    try {
      entries = performance.getEntriesByType("resource");
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      if (!looksLikeMedia(entry.name)) continue;
      const size =
        typeof entry.transferSize === "number" && entry.transferSize > 0
          ? entry.transferSize
          : null;
      enqueue(entry.name, "performance", { size });
    }
  }

  /**
   * Lightweight PerformanceObserver for future media resources.
   */
  function observePerformance() {
    if (typeof PerformanceObserver !== "function") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry?.name || !looksLikeMedia(entry.name)) continue;
          const size =
            typeof entry.transferSize === "number" && entry.transferSize > 0
              ? entry.transferSize
              : null;
          enqueue(entry.name, "performance", { size });
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      /* Safari / restricted contexts */
    }
  }

  function observeDomMutations() {
    const observer = new MutationObserver((mutations) => {
      let dirty = false;
      for (const m of mutations) {
        if (m.type === "attributes") {
          const el = m.target;
          if (
            el instanceof HTMLVideoElement ||
            el instanceof HTMLSourceElement
          ) {
            dirty = true;
            break;
          }
        }
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.tagName === "VIDEO" ||
            node.tagName === "SOURCE" ||
            node.querySelector?.("video, source")
          ) {
            dirty = true;
            break;
          }
        }
        if (dirty) break;
      }
      if (dirty) scanDomVideos();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
  }

  /**
   * Site-specific hooks. Bilibili is real (manifest-injected); others stubbed.
   * @returns {Array<{ url: string, type?: string | null, size?: number | null, source?: string }>}
   */
  function collectSiteSpecificVideos() {
    const host = location.hostname.toLowerCase();
    const bili = globalThis.VideoGrabberBilibili;
    if (bili?.isBilibiliHost?.(host) || host.includes("bilibili.")) {
      try {
        return typeof bili?.collect === "function" ? bili.collect() : [];
      } catch (err) {
        console.debug("[Video Grabber] bilibili collect failed", err);
        return [];
      }
    }
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      // Stub: YouTube extractor — not implemented.
      return [];
    }
    if (host.includes("xiaohongshu.com")) {
      // Stub: Xiaohongshu extractor — not implemented.
      return [];
    }
    return [];
  }

  function runSiteExtractors() {
    for (const hit of collectSiteSpecificVideos()) {
      if (hit?.url) {
        enqueue(hit.url, hit.source || "site", {
          type: hit.type,
          size: hit.size ?? null,
        });
      }
    }
  }

  function wireBilibiliMainWorld() {
    const bili = globalThis.VideoGrabberBilibili;
    if (!bili?.subscribeMainWorld) return;
    bili.subscribeMainWorld((hits) => {
      for (const hit of hits) {
        if (hit?.url) {
          enqueue(hit.url, hit.source || "bilibili", {
            type: hit.type,
            size: hit.size ?? null,
          });
        }
      }
    });
  }

  chrome.runtime.sendMessage({ type: "ping" }, (response) => {
    if (chrome.runtime.lastError) {
      console.debug(
        "[Video Grabber] background unreachable:",
        chrome.runtime.lastError.message
      );
      return;
    }
    console.debug("[Video Grabber] content ready on", location.hostname, response);
  });

  wireBilibiliMainWorld();
  scanDomVideos();
  scanPerformanceEntries();
  observePerformance();
  observeDomMutations();
  runSiteExtractors();

  // Re-scan shortly after load for late players / Bilibili playinfo.
  setTimeout(() => {
    scanDomVideos();
    scanPerformanceEntries();
    runSiteExtractors();
  }, 1500);
  setTimeout(() => {
    runSiteExtractors();
  }, 3500);
})();
