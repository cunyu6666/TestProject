/**
 * Content script stub — injected on Xiaohongshu / YouTube / Bilibili.
 * Future: site-specific extractors, media network observation (no HLS yet).
 */

(function initVideoGrabberContentScript() {
  const host = location.hostname;

  chrome.runtime.sendMessage(
    { type: "ping" },
    (response) => {
      if (chrome.runtime.lastError) {
        console.debug(
          "[Video Grabber] background unreachable:",
          chrome.runtime.lastError.message
        );
        return;
      }
      console.debug("[Video Grabber] content ready on", host, response);
    }
  );

  // Reserved hook for future extractors:
  // chrome.runtime.sendMessage({ type: "videos:found", urls: [...] });
})();
