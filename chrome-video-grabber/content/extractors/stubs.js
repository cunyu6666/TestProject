/**
 * Site-specific extractors — YouTube / Xiaohongshu remain stubs.
 * Bilibili is implemented in:
 *   - content/extractors/bilibili-main.js (MAIN world)
 *   - content/extractors/bilibili.js (isolated bridge)
 * Classic content scripts load those via manifest matches (no bundler).
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

  if (host.includes("bilibili.com") || host.includes("bilibili.cn")) {
    // Real extractor is wired through manifest content_scripts + content-script.js.
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
 * Hook point for future site extractors. Bilibili handled elsewhere.
 * @returns {VideoHit[]}
 */
export function collectSiteSpecificVideos() {
  try {
    return runSiteExtractorStubs(location.hostname);
  } catch {
    return [];
  }
}
