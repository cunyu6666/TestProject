/**
 * Site-specific extractors — all major sites are implemented elsewhere.
 * Bilibili:
 *   - content/extractors/bilibili-main.js (MAIN world)
 *   - content/extractors/bilibili.js (isolated bridge)
 * YouTube:
 *   - content/extractors/youtube-main.js (MAIN world)
 *   - content/extractors/youtube.js (isolated bridge)
 * Xiaohongshu:
 *   - content/extractors/xiaohongshu-main.js (MAIN world)
 *   - content/extractors/xiaohongshu.js (isolated bridge)
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
    // Real extractor is wired through manifest content_scripts + content-script.js.
    return [];
  }
  if (host.includes("xiaohongshu.com") || host.includes("xhslink.com")) {
    // Real extractor is wired through manifest content_scripts + content-script.js.
    return [];
  }

  return [];
}

/**
 * Hook point for future site extractors. Bilibili / YouTube / XHS handled elsewhere.
 * @returns {VideoHit[]}
 */
export function collectSiteSpecificVideos() {
  try {
    return runSiteExtractorStubs(location.hostname);
  } catch {
    return [];
  }
}
