/**
 * Background service worker (MV3) — stub.
 * Future: coordinate capture requests, persist detected video URLs, download flow.
 */

const SUPPORTED_HOST_HINTS = [
  "xiaohongshu.com",
  "youtube.com",
  "youtu.be",
  "bilibili.com",
];

chrome.runtime.onInstalled.addListener((details) => {
  console.info("[Video Grabber] installed", details.reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "ping") {
    sendResponse({ ok: true, role: "service-worker" });
    return false;
  }

  // Placeholder for future: { type: "videos:found", urls: [...] }
  if (message.type === "videos:found") {
    console.info("[Video Grabber] videos:found (stub)", message.urls ?? []);
    sendResponse({ ok: true, stored: false, reason: "not-implemented" });
    return false;
  }

  return false;
});

export { SUPPORTED_HOST_HINTS };
