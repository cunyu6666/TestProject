/**
 * Background service worker (MV3).
 * Aggregates DOM + network media hits per tab, serves the popup, downloads.
 */

import {
  looksLikeMediaUrl,
  normalizeMediaUrl,
  guessTypeFromUrl,
  typeFromContentType,
  isBilibiliCdnUrl,
  isGoogleVideoUrl,
  isXiaohongshuCdnUrl,
  isHlsPlaylistUrl,
} from "../shared/media.js";

/** @typedef {{ url: string, type: string | null, size: number | null, source: string, foundAt: number, kind?: 'progressive' | 'hls' }} VideoEntry */

const OFFSCREEN_URL = "offscreen/offscreen.html";
/** @type {Promise<void> | null} */
let offscreenReady = null;

/** @type {Map<number, Map<string, VideoEntry>>} */
const videosByTab = new Map();

const STORAGE_PREFIX = "videos:tab:";

/**
 * @param {number} tabId
 * @returns {Map<string, VideoEntry>}
 */
function ensureTabMap(tabId) {
  let map = videosByTab.get(tabId);
  if (!map) {
    map = new Map();
    videosByTab.set(tabId, map);
  }
  return map;
}

/**
 * @param {number} tabId
 */
async function persistTab(tabId) {
  const map = videosByTab.get(tabId);
  const list = map ? Array.from(map.values()) : [];
  try {
    await chrome.storage.session.set({ [`${STORAGE_PREFIX}${tabId}`]: list });
  } catch (err) {
    console.debug("[Video Grabber] session persist failed", err);
  }
}

/**
 * @param {number} tabId
 */
async function hydrateTab(tabId) {
  if (videosByTab.has(tabId)) return;
  try {
    const key = `${STORAGE_PREFIX}${tabId}`;
    const data = await chrome.storage.session.get(key);
    const list = data[key];
    if (!Array.isArray(list) || list.length === 0) return;
    const map = ensureTabMap(tabId);
    for (const item of list) {
      if (item?.url) map.set(item.url, item);
    }
  } catch (err) {
    console.debug("[Video Grabber] session hydrate failed", err);
  }
}

/**
 * @param {number} tabId
 * @param {{ url: string, type?: string | null, size?: number | null, source?: string }} hit
 */
async function upsertVideo(tabId, hit) {
  if (tabId < 0 || !hit?.url) return;
  const url = normalizeMediaUrl(hit.url);
  if (url.startsWith("blob:") || url.startsWith("data:")) return;

  // DOM / Bilibili / YouTube / XHS hits may lack file extensions (tokenized CDNs).
  const source = hit.source || "";
  const isDom = source === "dom" || source === "dom-source";
  const isBili =
    typeof source === "string" && source.startsWith("bilibili");
  const isYt =
    typeof source === "string" && source.startsWith("youtube");
  const isXhs =
    typeof source === "string" && source.startsWith("xiaohongshu");
  if (
    !isDom &&
    !isBili &&
    !isYt &&
    !isXhs &&
    !looksLikeMediaUrl(url) &&
    !isBilibiliCdnUrl(url) &&
    !isGoogleVideoUrl(url) &&
    !isXiaohongshuCdnUrl(url)
  ) {
    return;
  }

  const map = ensureTabMap(tabId);
  const existing = map.get(url);
  const type =
    hit.type ||
    existing?.type ||
    guessTypeFromUrl(url) ||
    (isHlsPlaylistUrl(url) ? "m3u8" : null) ||
    (isBilibiliCdnUrl(url) ? "mp4" : null) ||
    (isGoogleVideoUrl(url) ? "mp4" : null) ||
    (isXiaohongshuCdnUrl(url) ? "mp4" : null) ||
    null;
  const size =
    hit.size != null && Number.isFinite(hit.size)
      ? hit.size
      : existing?.size ?? null;
  const kind =
    type === "m3u8" || isHlsPlaylistUrl(url) ? "hls" : "progressive";

  map.set(url, {
    url,
    type,
    size,
    source: hit.source || existing?.source || "unknown",
    foundAt: existing?.foundAt ?? Date.now(),
    kind,
  });
  await persistTab(tabId);
}

/**
 * @returns {Promise<boolean>}
 */
function pingOffscreen() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "hls:offscreen-ping" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(response?.ok));
    });
  });
}

/**
 * Ensure the Offscreen Document used for HLS blob merge exists and can reply.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  if (offscreenReady) {
    await offscreenReady;
    return;
  }

  offscreenReady = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (!contexts || contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["BLOBS"],
        justification:
          "Merge HLS (.m3u8) segments into a single Blob for chrome.downloads",
      });
    }

    // Script load is async after createDocument — wait briefly for ping.
    for (let i = 0; i < 20; i++) {
      if (await pingOffscreen()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Offscreen Document 未就绪，无法合并 HLS");
  })();

  try {
    await offscreenReady;
  } finally {
    offscreenReady = null;
  }
}

/**
 * @param {string} url
 * @param {'highest' | 'lowest'} [variant]
 * @returns {Promise<{ ok: boolean, reason?: string, downloadId?: number, filename?: string, segmentCount?: number, bytes?: number, variantLabel?: string | null }>}
 */
async function downloadHlsMerged(url, variant = "highest") {
  await ensureOffscreenDocument();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "hls:merge-download", url, variant },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(response || { ok: false, reason: "no-response" });
      }
    );
  });
}

/**
 * @param {number} tabId
 * @returns {Promise<VideoEntry[]>}
 */
async function listVideos(tabId) {
  await hydrateTab(tabId);
  const map = videosByTab.get(tabId);
  if (!map) return [];
  return Array.from(map.values()).sort((a, b) => a.foundAt - b.foundAt);
}

/**
 * @param {number} tabId
 */
async function clearTab(tabId) {
  videosByTab.delete(tabId);
  try {
    await chrome.storage.session.remove(`${STORAGE_PREFIX}${tabId}`);
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.info("[Video Grabber] installed", details.reason);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Fresh navigation — drop prior page's hits.
  if (changeInfo.status === "loading" && changeInfo.url) {
    void clearTab(tabId);
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method && details.method !== "GET") return;

    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentLength = null;

    for (const h of headers) {
      const name = (h.name || "").toLowerCase();
      if (name === "content-type") contentType = h.value || "";
      if (name === "content-length") {
        const n = Number(h.value);
        if (Number.isFinite(n) && n > 0) contentLength = n;
      }
    }

    if (!looksLikeMediaUrl(details.url, contentType)) return;

    const type = typeFromContentType(contentType) || guessTypeFromUrl(details.url);
    void upsertVideo(details.tabId, {
      url: details.url,
      type,
      size: contentLength,
      source: "network",
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "ping") {
    sendResponse({ ok: true, role: "service-worker" });
    return false;
  }

  if (message.type === "videos:found") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, reason: "no-tab" });
      return false;
    }
    const hits = Array.isArray(message.videos)
      ? message.videos
      : Array.isArray(message.urls)
        ? message.urls.map((url) => ({ url, source: "content" }))
        : [];
    void (async () => {
      for (const hit of hits) {
        await upsertVideo(tabId, hit);
      }
      sendResponse({ ok: true, stored: hits.length });
    })();
    return true;
  }

  if (message.type === "videos:list") {
    void (async () => {
      let tabId = message.tabId;
      if (tabId == null) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        tabId = tab?.id;
      }
      if (tabId == null) {
        sendResponse({ ok: false, videos: [] });
        return;
      }
      const videos = await listVideos(tabId);
      sendResponse({ ok: true, tabId, videos });
    })();
    return true;
  }

  if (message.type === "videos:download") {
    const url = message.url;
    if (!url || typeof url !== "string") {
      sendResponse({ ok: false, reason: "missing-url" });
      return false;
    }
    // Progressive / direct URL download — leave m3u8 to videos:download-hls.
    if (isHlsPlaylistUrl(url)) {
      sendResponse({
        ok: false,
        reason: "这是 HLS 播放列表，请使用「合并下载」",
      });
      return false;
    }
    void (async () => {
      try {
        let filename;
        try {
          const path = new URL(url).pathname;
          const base = path.split("/").filter(Boolean).pop();
          if (base) filename = decodeURIComponent(base.split("?")[0]);
        } catch {
          /* ignore */
        }
        const downloadId = await chrome.downloads.download({
          url,
          filename: filename || undefined,
          saveAs: false,
          conflictAction: "uniquify",
        });
        sendResponse({ ok: true, downloadId });
      } catch (err) {
        sendResponse({
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message.type === "videos:download-hls") {
    const url = message.url;
    if (!url || typeof url !== "string") {
      sendResponse({ ok: false, reason: "missing-url" });
      return false;
    }
    void (async () => {
      try {
        const variant =
          message.variant === "lowest" ? "lowest" : "highest";
        const result = await downloadHlsMerged(url, variant);
        sendResponse(result);
      } catch (err) {
        sendResponse({
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message.type === "videos:clear") {
    void (async () => {
      let tabId = message.tabId;
      if (tabId == null) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        tabId = tab?.id;
      }
      if (tabId != null) await clearTab(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
