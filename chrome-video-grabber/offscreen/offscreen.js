/**
 * Offscreen Document — merge HLS into a Blob and keep the object URL alive.
 * chrome.downloads is NOT available here; the service worker starts the download.
 */

import { mergeHlsToBlob } from "../background/hls-merge.js";

/** @type {Map<string, string>} blobUrl → filename (tracked for revoke) */
const liveBlobUrls = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "hls:offscreen-ping") {
    sendResponse({ ok: true, role: "offscreen" });
    return false;
  }

  if (message.type === "hls:revoke-blob") {
    const blobUrl = message.blobUrl;
    if (typeof blobUrl === "string" && liveBlobUrls.has(blobUrl)) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* ignore */
      }
      liveBlobUrls.delete(blobUrl);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "hls:merge-download") {
    const url = message.url;
    if (!url || typeof url !== "string") {
      sendResponse({ ok: false, reason: "missing-url" });
      return false;
    }

    void (async () => {
      try {
        const result = await mergeHlsToBlob(url, {
          variant: message.variant === "lowest" ? "lowest" : "highest",
          onProgress: (info) => {
            try {
              chrome.runtime.sendMessage({
                type: "hls:progress",
                url,
                ...info,
              });
            } catch {
              /* ignore */
            }
          },
        });

        const blobUrl = URL.createObjectURL(result.blob);
        liveBlobUrls.set(blobUrl, result.filename);

        // Return the blob URL to the service worker; do not call chrome.downloads here.
        sendResponse({
          ok: true,
          blobUrl,
          filename: result.filename,
          segmentCount: result.segmentCount,
          bytes: result.bytes,
          variantLabel: result.variantLabel,
          extension: result.extension,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  return false;
});
