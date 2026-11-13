/**
 * Offscreen Document — holds the merged Blob URL long enough for chrome.downloads.
 */

import { mergeHlsToBlob } from "../background/hls-merge.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "hls:offscreen-ping") {
    sendResponse({ ok: true, role: "offscreen" });
    return false;
  }

  if (message.type === "hls:merge-download") {
    const url = message.url;
    if (!url || typeof url !== "string") {
      sendResponse({ ok: false, reason: "missing-url" });
      return false;
    }

    void (async () => {
      let objectUrl = null;
      try {
        const result = await mergeHlsToBlob(url, {
          variant: message.variant === "lowest" ? "lowest" : "highest",
          onProgress: (info) => {
            // Best-effort progress for SW / popup (may be dropped if no listener).
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

        objectUrl = URL.createObjectURL(result.blob);
        const downloadId = await chrome.downloads.download({
          url: objectUrl,
          filename: result.filename,
          saveAs: false,
          conflictAction: "uniquify",
        });

        // Keep the blob URL alive briefly so the download manager can attach.
        await new Promise((r) => setTimeout(r, 2500));
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;

        sendResponse({
          ok: true,
          downloadId,
          filename: result.filename,
          segmentCount: result.segmentCount,
          bytes: result.bytes,
          variantLabel: result.variantLabel,
          extension: result.extension,
        });
      } catch (err) {
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            /* ignore */
          }
        }
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
