/**
 * Fetch clear HLS playlists + segments and concatenate into one Blob.
 * Intended for Offscreen Document / SW (extension host_permissions bypass page CORS).
 */

import {
  parseM3u8,
  pickVariant,
  guessMergedExtension,
  HLS_MAX_SEGMENTS,
  HLS_MAX_BYTES,
} from "../shared/hls.js";

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function fetchOk(url, init) {
  const res = await fetch(url, {
    credentials: "omit",
    cache: "no-store",
    ...init,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} · ${url.slice(0, 120)}`);
  }
  return res;
}

/**
 * Resolve a playlist URL to a clear media playlist (follow one master hop).
 * Uses the final response URL after redirects as the base for relative refs.
 * @param {string} playlistUrl
 * @param {{ variant?: 'highest' | 'lowest' }} [opts]
 * @returns {Promise<{ media: import('../shared/hls.js').MediaPlaylist, mediaUrl: string, variantLabel: string | null }>}
 */
export async function resolveMediaPlaylist(playlistUrl, opts = {}) {
  const res = await fetchOk(playlistUrl);
  const text = await res.text();
  const finalUrl = res.url || playlistUrl;
  const parsed = parseM3u8(text, finalUrl);

  if (parsed.kind === "media") {
    return { media: parsed, mediaUrl: finalUrl, variantLabel: null };
  }

  const variant = pickVariant(parsed, opts.variant || "highest");
  const mediaRes = await fetchOk(variant.uri);
  const mediaText = await mediaRes.text();
  const mediaFinalUrl = mediaRes.url || variant.uri;
  const media = parseM3u8(mediaText, mediaFinalUrl);
  if (media.kind !== "media") {
    throw new Error("Master 的 variant 仍是 master（多层 master 未支持）");
  }
  const labelParts = [
    variant.name,
    variant.resolution,
    variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)}kbps` : null,
  ].filter(Boolean);
  return {
    media,
    mediaUrl: mediaFinalUrl,
    variantLabel: labelParts.join(" · ") || mediaFinalUrl,
  };
}

/**
 * @param {string} playlistUrl
 * @param {{
 *   variant?: 'highest' | 'lowest',
 *   onProgress?: (info: { phase: string, done: number, total: number, bytes: number }) => void,
 * }} [opts]
 * @returns {Promise<{ blob: Blob, filename: string, segmentCount: number, bytes: number, variantLabel: string | null, extension: string }>}
 */
export async function mergeHlsToBlob(playlistUrl, opts = {}) {
  const onProgress = opts.onProgress || (() => {});

  onProgress({ phase: "playlist", done: 0, total: 0, bytes: 0 });
  const { media, variantLabel } = await resolveMediaPlaylist(playlistUrl, {
    variant: opts.variant,
  });

  if (media.encrypted) {
    throw new Error(
      "该 HLS 使用 #EXT-X-KEY 加密（或 DRM）。MVP 不支持解密 / Widevine 等受保护流。"
    );
  }

  if (media.hasByteRange) {
    throw new Error(
      "该播放列表使用 #EXT-X-BYTERANGE（或 MAP BYTERANGE）。MVP 不支持按字节范围拉取，避免整文件重复下载导致损坏。"
    );
  }

  if (!media.endList && media.playlistType !== "VOD") {
    // Live / event playlists without ENDLIST — refuse for MVP (would grow forever).
    throw new Error(
      "看起来是直播 / 未结束的播放列表（无 #EXT-X-ENDLIST）。MVP 仅支持 VOD 合并。"
    );
  }

  if (media.segments.length === 0) {
    throw new Error("媒体播放列表没有分片");
  }

  if (media.segments.length > HLS_MAX_SEGMENTS) {
    throw new Error(
      `分片过多（${media.segments.length} > ${HLS_MAX_SEGMENTS}）。请换更短的 VOD 或更低码率 variant。`
    );
  }

  /** @type {string[]} */
  const urls = [];
  if (media.mapUri) urls.push(media.mapUri);
  for (const seg of media.segments) urls.push(seg.uri);

  const total = urls.length;
  /** @type {ArrayBuffer[]} */
  const parts = [];
  let bytes = 0;

  for (let i = 0; i < urls.length; i++) {
    onProgress({ phase: "segments", done: i, total, bytes });
    const buf = await (await fetchOk(urls[i])).arrayBuffer();
    bytes += buf.byteLength;
    if (bytes > HLS_MAX_BYTES) {
      throw new Error(
        `合并体积超过上限（>${Math.round(HLS_MAX_BYTES / (1024 * 1024))} MiB）。大 VOD 请用外部工具。`
      );
    }
    parts.push(buf);
  }

  onProgress({ phase: "merge", done: total, total, bytes });

  const extension = guessMergedExtension(media);
  const mime =
    extension === "mp4" ? "video/mp4" : "video/mp2t";
  const blob = new Blob(parts, { type: mime });

  let base = "hls-merged";
  try {
    const path = new URL(playlistUrl).pathname;
    const leaf = path.split("/").filter(Boolean).pop() || "";
    const stem = leaf.replace(/\.m3u8?$/i, "");
    if (stem) base = stem.slice(0, 80);
  } catch {
    /* ignore */
  }

  return {
    blob,
    filename: `${base}.${extension}`,
    segmentCount: media.segments.length,
    bytes,
    variantLabel,
    extension,
  };
}
