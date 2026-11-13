# Video Grabber (Chrome MV3)

Chrome Extension Manifest V3 — detect video resource URLs on the **active tab** and list them in the popup for **copy** / **browser download**, plus **clear HLS (.m3u8) VOD merge-download**.

Prefer **personal / educational local use**. Respect site terms and copyright.

## What this version does

- **Generic**
  - Scans `<video>` / `<source>` `src` (and `currentSrc`) via the content script
  - Captures obvious network media URLs (`mp4`, `webm`, `m4v`, `m3u8`, …) through:
    - `chrome.webRequest.onHeadersReceived` (content-type / extension)
    - Performance resource timing in the page
  - Deduplicates per tab; shows type and size when cheap to obtain
- **HLS (.m3u8)**
  - Detects playlist URLs (DOM / network / MIME) and labels them **HLS** in the popup
  - **合并下载**: Offscreen Document fetches the playlist + segments (extension host access), concatenates clear VOD into one `.ts` / `.mp4` file, then `chrome.downloads`
  - Master playlists: picks the **highest-bandwidth** variant (one hop)
  - Progressive mp4 / direct downloads stay unchanged (**下载**)
- **Bilibili** (`*.bilibili.com` / `*.bilibili.cn` / related bili hosts)
  - MAIN-world read of `__playinfo__` + playurl `fetch` / XHR hooks
  - Isolated-world parse of embedded `__playinfo__` script tags
  - bilivideo CDN URLs from performance / network (tokenized paths OK)
  - Lists **durl** (mp4/flv-style) and **DASH** video/audio URLs separately when present
- **YouTube** (`*.youtube.com` / `youtu.be` / `*.youtube-nocookie.com` — watch / Shorts / embed / live)
  - MAIN-world read of `ytInitialPlayerResponse` / `ytplayer.config` + youtubei player `fetch` / XHR hooks
  - Isolated-world parse of embedded `ytInitialPlayerResponse` script tags
  - `googlevideo.com` / `videoplayback` URLs from performance / network (already signed by the player)
  - Lists **progressive** (muxed) and **adaptive** (separate A/V) formats when they include a direct `url`
- **Xiaohongshu** (`*.xiaohongshu.com` / `xhslink.com` — explore / discovery / note pages)
  - MAIN-world read of `__INITIAL_STATE__` note JSON + note/feed `fetch` / XHR hooks
  - Isolated-world parse of embedded `__INITIAL_STATE__`, `originVideoKey`, and `og:video`
  - Prefers `consumer.originVideoKey` → `sns-video-bd.xhscdn.com/...` and progressive stream `masterUrl`s
  - `*.xhscdn.com` CDN URLs from performance / network
- Empty state when nothing was found

## Layout

```
chrome-video-grabber/
├── manifest.json
├── shared/media.js
├── shared/hls.js                 # m3u8 parse / caps
├── background/service-worker.js
├── background/hls-merge.js       # fetch + concatenate segments
├── offscreen/                    # Blob URL + downloads (MV3)
├── content/
│   ├── content-script.js
│   └── extractors/
│       ├── bilibili-main.js      # world: MAIN
│       ├── bilibili.js           # isolated bridge
│       ├── youtube-main.js       # world: MAIN
│       ├── youtube.js            # isolated bridge
│       ├── xiaohongshu-main.js   # world: MAIN
│       ├── xiaohongshu.js        # isolated bridge
│       └── stubs.js              # markers only
├── popup/
├── fixtures/
│   ├── sample-video.html         # progressive mp4
│   └── sample-hls.html           # public Mux m3u8
├── icons/
└── README.md
```

## Permissions

| Kind | Values |
|------|--------|
| `permissions` | `storage`, `activeTab`, `tabs`, `webRequest`, `downloads`, `offscreen` |
| `host_permissions` / generic content matches | `<all_urls>` (needed for generic tab detection + network) |
| Bilibili content scripts | `*.bilibili.com`, `*.bilibili.cn`, `*.biliintl.com`, `*.bili2233.cn` only |
| YouTube content scripts | `*.youtube.com`, `*.youtube-nocookie.com`, `youtu.be` only |
| Xiaohongshu content scripts | `*.xiaohongshu.com`, `xhslink.com` only |

No new permission kinds beyond the generic detector; site scripts are **match-scoped**.

## Load unpacked (local)

1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `chrome-video-grabber/` (contains `manifest.json`).
4. Open a page with media (or a Bilibili / YouTube / Xiaohongshu video — see below).
5. Play / let the media load, then open the extension popup.
6. Confirm entries appear with **复制** / **下载** (progressive) or **合并下载** (HLS); empty pages show「暂无视频链接」.

Reload the extension card after edits.

## Test HLS merge with a public m3u8 fixture

Public clear VOD (Mux Big Buck Bunny test stream):

- Master: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- Smaller media (faster): `https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8`

Steps:

1. Load the unpacked extension as above.
2. Serve the fixture folder:
   `cd chrome-video-grabber/fixtures && python3 -m http.server 8765 --bind 127.0.0.1`
3. Open `http://127.0.0.1:8765/sample-hls.html` in Chrome.
4. Open the Video Grabber popup → expect an **HLS** / `m3u8` row (from `<video src>` and/or network).
5. Click **合并下载**. Wait while segments fetch; Chrome Downloads should receive a concatenated `.ts` (or `.mp4` for fMP4 playlists).
6. Optional: open the master URL in the same page / network tab and merge that instead (highest-bandwidth variant).

Smoke-check without the UI: the same Mux media URL is clear MPEG-TS VOD (~64 segments) suitable for a quick merge.

## Test on a Xiaohongshu video note

1. Load the unpacked extension as above.
2. In a normal Chrome profile, open a **video note** you can already view, e.g.:
   - Desktop: `https://www.xiaohongshu.com/explore/<noteId>` (keep `xsec_token` / share query params if the share link included them)
   - Or open an `https://xhslink.com/...` short link and let it redirect into `xiaohongshu.com`
3. **Login may be required.** Guest / bot sessions often hit a login wall or empty `__INITIAL_STATE__` — use a session that can play the note in the tab.
4. Start playback (so `xhscdn` traffic fires). Wait ~2s.
5. Open the Video Grabber popup → expect entries with sources like `xiaohongshu-initial-originVideoKey`, `xiaohongshu-script-…`, `xiaohongshu-cdn`, `xiaohongshu-og-video`, `xiaohongshu-api-…`, and/or generic `network` / `dom`.
6. Prefer an `originVideoKey` / `t258` / `clean` row when present (progressive mp4), then **复制** or **下载**.

Tips:

- If the list is empty, dismiss login/captcha, wait for the note player, then click **刷新**.
- Image-only notes will not produce video rows (expected).
- CDN downloads may **403 after expiry** or without the browser cookie / Referer context that fetched them — copy soon after play, or download while the tab still plays.
- Watermark honesty: App “save” often burns a watermark; many CDN progressive files (especially `originVideoKey` / streamType `258`) are cleaner than `259` export streams, but overlays and future CDN changes are outside our control.

## Test on a public YouTube video

1. Load the unpacked extension as above.
2. Open a **public** watch page, e.g. `https://www.youtube.com/watch?v=jNQXAC9IVRw` (Me at the zoo — short, public).
   - Shorts also work: `https://www.youtube.com/shorts/…`
   - `https://youtu.be/jNQXAC9IVRw` redirects into a watch page covered by the same extractors.
3. Start playback (so googlevideo / player traffic fires). Wait ~2s.
4. Open the Video Grabber popup → expect entries with sources like `youtube-player-response-…`, `youtube-script-player-response-…`, `youtube-googlevideo`, `youtube-player-api-…`, and/or generic `network` / `dom`.
5. Prefer a **progressive** (`itag18` / similar) row when present — single-file muxed mp4 — then **复制** or **下载**.
6. Adaptive rows are separate video-only / audio-only streams (no merge in this extension).

Tips:

- If the list is empty, wait 2–3s after play starts and click **刷新**.
- Prefer a short public clip; avoid age-gated / members-only / region-locked titles when validating.
- Cipher-only formats (no direct `url`) are skipped; downloads of unsigned / expired googlevideo links may 403.

## Test on a public Bilibili video

1. Load the unpacked extension as above.
2. Open a **public** BV page, e.g. browse to any video on `https://www.bilibili.com/` that does not require login (guest-playable).
3. Start playback (so playurl / bilivideo CDN traffic fires).
4. Open the Video Grabber popup → expect entries with sources like `bilibili-playinfo-…`, `bilibili-playurl-…`, `bilibili-cdn`, or generic `network` / `dom`.
5. **复制** a URL; optionally **下载** a direct `mp4` / `m4s` link via the browser download manager.

## Known limits (Xiaohongshu)

| Topic | Behavior |
|-------|----------|
| Login / captcha | Web often requires a logged-in browser session (or valid share `xsec_*` params). Headless / logged-out tabs frequently see empty state or a login wall — we only read JSON already present in the tab. |
| Watermark | Prefer `originVideoKey` and streamType `258`/`301` when labeled `clean`. StreamType `259`/`309` may be watermarked export variants. In-player UI overlays are not always burned into the CDN file; we do **not** guarantee forever-clean media. |
| CDN expiry | `xhscdn` URLs are time-/cookie-/Referer-sensitive. Links copied later may 403; download while the note still plays when possible. |
| HLS | Clear `.m3u8` VOD can use **合并下载**. Prefer progressive `originVideoKey` when available. |
| Short links | `xhslink.com` is match-scoped; extraction runs after redirect onto `xiaohongshu.com` (and on the short-link host if state is present). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Known limits (YouTube)

| Topic | Behavior |
|-------|----------|
| Login / quality | Higher resolutions and some formats need a logged-in session; we only see streams embedded in page player response or already requested by the tab. |
| Signature / n-param | No signature or `n` decipher. Formats that only expose `signatureCipher` without a usable direct `url` are skipped. Player-fetched googlevideo URLs usually already carry valid tokens but **expire**. |
| Adaptive / HLS | Adaptive A/V listed **separately**. Clear HLS playlists can use **合并下载**; DASH still has no mux. |
| DRM / restricted | DRM, age-gated, members-only, or otherwise protected streams are out of scope. |
| Progressive mp4 | Best single-file option when `streamingData.formats` includes a direct `url` (often lower resolution). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Known limits (Bilibili)

| Topic | Behavior |
|-------|----------|
| Login / quality | Higher resolutions often need a logged-in session; we only see streams the tab already requested or embedded in page playinfo. |
| DASH | Video and audio `m4s` URLs are listed **separately**. No DASH A/V mux in this version. |
| DRM / restricted | DRM, paid-only, or otherwise protected streams are out of scope. |
| Single-file mp4 | Available when the playurl response includes `durl` (quality / client dependent). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Known limits (HLS merge)

| Topic | Behavior |
|-------|----------|
| Encrypted HLS / DRM | `#EXT-X-KEY` (AES-128 etc.) and Widevine/FairPlay-style DRM are **not** decrypted. Merge refuses with a clear error. |
| Live / event | Playlists without `#EXT-X-ENDLIST` (and not `PLAYLIST-TYPE:VOD`) are refused — MVP is VOD-only. |
| CORS / cookies | Extension fetch uses host permissions (not the page’s CORS). Cookie-gated CDNs may still 403 when fetched without the tab’s credential context (`credentials: omit`). Prefer playlists the extension can GET anonymously, or progressive downloads that the browser download manager handles with cookies. |
| Memory / size | Segments are buffered in the Offscreen Document. Soft caps: **~400 segments** and **~180 MiB** total. Large VOD may OOM or hit the cap — use an external downloader for big files. |
| Master playlists | One variant hop only; default **highest** bandwidth. Multi-audio / subtitle renditions are not selected. |
| Byte-range | `#EXT-X-BYTERANGE` / MAP `BYTERANGE` playlists are **rejected** (MVP does not Range-fetch; silent ignore would corrupt output). |
| Redirects | Relative segment/variant URIs resolve against the **final** playlist response URL after redirects. |
| Output | MPEG-TS segments → `.ts` (concat). fMP4 (`#EXT-X-MAP` / `.m4s`) → `.mp4` (init + media concat). Not a remux to a guaranteed universal mp4 — players that accept TS/fMP4 concat work best. |
| Progressive mp4 | Unchanged: direct **下载** via `chrome.downloads` for non-playlist URLs. |

## Out of scope (later)

- Signature / n-parameter decipher for YouTube
- DASH audio+video mux
- AES-128 HLS key fetch / decrypt
- Quality picker UI / live sliding-window capture
