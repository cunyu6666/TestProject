/**
 * Site-specific extractors — stubs only (out of scope for generic detection).
 * Future tasks will replace these with real Bilibili / YouTube / Xiaohongshu logic.
 */

/**
 * @typedef {{ url: string, type?: string | null, size?: number | null, source?: string }} VideoHit
 */

/**
 * @param {string} hostname
 * @returns {VideoHit[]}
 */
export function runSiteExtractorStubs(hostname) {
  const host = (hostname || "").toLowerCase();

  if (host.includes("bilibili.com")) {
    // Stub: Bilibili DASH / playurl extractor — not implemented.
    return [];
  }
  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    // Stub: YouTube googlevideo / player response — not implemented.
    return [];
  }
  if (host.includes("xiaohongshu.com")) {
    // Stub: Xiaohongshu note media — not implemented.
    return [];
  }

  return [];
}

/**
 * Hook point for future site extractors. Always returns [] for now.
 * @returns {VideoHit[]}
 */
export function collectSiteSpecificVideos() {
  try {
    return runSiteExtractorStubs(location.hostname);
  } catch {
    return [];
  }
}
