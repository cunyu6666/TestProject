/**
 * Minimal HLS (m3u8) helpers for MVP merge-download.
 * Supports clear (unencrypted) VOD media playlists and master → variant pick.
 */

/** Soft caps for in-extension merge (memory / practical MVP). */
export const HLS_MAX_SEGMENTS = 400;
export const HLS_MAX_BYTES = 180 * 1024 * 1024; // ~180 MiB

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isHlsPlaylistUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return true;
    if (/[?&](m3u8|playlist|format=m3u8)\b/i.test(u.search)) return true;
    return false;
  } catch {
    return /\.m3u8(?:$|[?#])/i.test(url);
  }
}

/**
 * @param {string} baseUrl
 * @param {string} ref
 * @returns {string}
 */
export function resolvePlaylistRef(baseUrl, ref) {
  return new URL(ref, baseUrl).href;
}

/**
 * @typedef {{ kind: 'master', variants: Array<{ uri: string, bandwidth: number, resolution: string | null, name: string | null }> }} MasterPlaylist
 * @typedef {{ kind: 'media', mediaSequence: number, targetDuration: number | null, playlistType: string | null, endList: boolean, encrypted: boolean, mapUri: string | null, segments: Array<{ uri: string, duration: number | null }> }} MediaPlaylist
 */

/**
 * @param {string} text
 * @param {string} baseUrl
 * @returns {MasterPlaylist | MediaPlaylist}
 */
export function parseM3u8(text, baseUrl) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("空的 m3u8 内容");
  }
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines[0]?.startsWith("#EXTM3U")) {
    throw new Error("不是有效的 HLS 播放列表（缺少 #EXTM3U）");
  }

  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (isMaster) {
    /** @type {MasterPlaylist['variants']} */
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const attrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
      const next = lines[i + 1];
      if (!next || next.startsWith("#")) {
        throw new Error("Master 播放列表缺少 variant URI");
      }
      variants.push({
        uri: resolvePlaylistRef(baseUrl, next),
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION || null,
        name: attrs.NAME || null,
      });
      i += 1;
    }
    if (variants.length === 0) {
      throw new Error("Master 播放列表没有可用 variant");
    }
    return { kind: "master", variants };
  }

  /** @type {MediaPlaylist} */
  const media = {
    kind: "media",
    mediaSequence: 0,
    targetDuration: null,
    playlistType: null,
    endList: false,
    encrypted: false,
    mapUri: null,
    segments: [],
  };

  let pendingDuration = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      media.mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      media.targetDuration =
        Number(line.slice("#EXT-X-TARGETDURATION:".length)) || null;
      continue;
    }
    if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      media.playlistType = line.slice("#EXT-X-PLAYLIST-TYPE:".length).trim();
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      media.endList = true;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
      const method = (attrs.METHOD || "").toUpperCase();
      if (method && method !== "NONE") {
        media.encrypted = true;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        media.mapUri = resolvePlaylistRef(baseUrl, stripQuotes(attrs.URI));
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const body = line.slice("#EXTINF:".length);
      const durationPart = body.split(",")[0];
      pendingDuration = Number(durationPart);
      if (!Number.isFinite(pendingDuration)) pendingDuration = null;
      continue;
    }
    if (line.startsWith("#")) continue;

    media.segments.push({
      uri: resolvePlaylistRef(baseUrl, line),
      duration: pendingDuration,
    });
    pendingDuration = null;
  }

  return media;
}

/**
 * Pick a media variant from a master playlist (highest bandwidth by default).
 * @param {MasterPlaylist} master
 * @param {'highest' | 'lowest'} [preference]
 * @returns {{ uri: string, bandwidth: number, resolution: string | null, name: string | null }}
 */
export function pickVariant(master, preference = "highest") {
  const sorted = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
  if (preference === "lowest") return sorted[0];
  return sorted[sorted.length - 1];
}

/**
 * Guess output extension from segment / map URIs.
 * @param {MediaPlaylist} media
 * @returns {'ts' | 'mp4'}
 */
export function guessMergedExtension(media) {
  const sample = media.mapUri || media.segments[0]?.uri || "";
  try {
    const path = new URL(sample).pathname.toLowerCase();
    if (path.endsWith(".m4s") || path.endsWith(".mp4") || path.endsWith(".cmfv")) {
      return "mp4";
    }
  } catch {
    /* ignore */
  }
  if (media.mapUri) return "mp4";
  return "ts";
}

/**
 * @param {string} attrText
 * @returns {Record<string, string>}
 */
function parseAttrList(attrText) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([A-Z0-9-]+)=("(?:[^"]|\\")*"|[^,]*)/gi;
  let match;
  while ((match = re.exec(attrText)) !== null) {
    out[match[1].toUpperCase()] = match[2];
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}
