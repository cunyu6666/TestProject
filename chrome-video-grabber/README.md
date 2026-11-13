# Video Grabber (Chrome MV3)

Chrome Extension Manifest V3 — detect video resource URLs on the **active tab** and list them in the popup for **copy** / **browser download**.

Prefer **personal / educational local use**. Respect site terms and copyright.

## What this version does

- **Generic**
  - Scans `<video>` / `<source>` `src` (and `currentSrc`) via the content script
  - Captures obvious network media URLs (`mp4`, `webm`, `m4v`, …) through:
    - `chrome.webRequest.onHeadersReceived` (content-type / extension)
    - Performance resource timing in the page
  - Deduplicates per tab; shows type and size when cheap to obtain
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
- Empty state when nothing was found
- Xiaohongshu extractor remains a **stub**

## Layout

```
chrome-video-grabber/
├── manifest.json
├── shared/media.js
├── background/service-worker.js
├── content/
│   ├── content-script.js
│   └── extractors/
│       ├── bilibili-main.js   # world: MAIN
│       ├── bilibili.js        # isolated bridge
│       ├── youtube-main.js    # world: MAIN
│       ├── youtube.js         # isolated bridge
│       └── stubs.js           # XHS placeholder
├── popup/
├── fixtures/
├── icons/
└── README.md
```

## Permissions

| Kind | Values |
|------|--------|
| `permissions` | `storage`, `activeTab`, `tabs`, `webRequest`, `downloads` |
| `host_permissions` / generic content matches | `<all_urls>` (needed for generic tab detection + network) |
| Bilibili content scripts | `*.bilibili.com`, `*.bilibili.cn`, `*.biliintl.com`, `*.bili2233.cn` only |
| YouTube content scripts | `*.youtube.com`, `*.youtube-nocookie.com`, `youtu.be` only |

No new permission kinds beyond the generic detector; site scripts are **match-scoped**.

## Load unpacked (local)

1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `chrome-video-grabber/` (contains `manifest.json`).
4. Open a page with media (or a Bilibili / YouTube video — see below).
5. Play / let the media load, then open the extension popup.
6. Confirm entries appear with **复制** / **下载**; empty pages show「暂无视频链接」.

Reload the extension card after edits.

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

## Known limits (YouTube)

| Topic | Behavior |
|-------|----------|
| Login / quality | Higher resolutions and some formats need a logged-in session; we only see streams embedded in page player response or already requested by the tab. |
| Signature / n-param | No signature or `n` decipher. Formats that only expose `signatureCipher` without a usable direct `url` are skipped. Player-fetched googlevideo URLs usually already carry valid tokens but **expire**. |
| Adaptive / HLS | Adaptive A/V listed **separately**; HLS/DASH manifests listed when present. **No** playlist assembly or remux. |
| DRM / restricted | DRM, age-gated, members-only, or otherwise protected streams are out of scope. |
| Progressive mp4 | Best single-file option when `streamingData.formats` includes a direct `url` (often lower resolution). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Known limits (Bilibili)

| Topic | Behavior |
|-------|----------|
| Login / quality | Higher resolutions often need a logged-in session; we only see streams the tab already requested or embedded in page playinfo. |
| DASH | Video and audio `m4s` URLs are listed **separately**. No HLS/DASH merge or remux in this version. |
| DRM / restricted | DRM, paid-only, or otherwise protected streams are out of scope. |
| Single-file mp4 | Available when the playurl response includes `durl` (quality / client dependent). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Out of scope (later)

- Xiaohongshu real extractor
- Signature / n-parameter decipher for YouTube
- HLS playlist assembly / DASH muxing
- Background quality picker UI
