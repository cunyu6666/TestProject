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
- Empty state when nothing was found
- YouTube / Xiaohongshu extractors remain **stubs**

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
│       └── stubs.js           # YT / XHS placeholders
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

No extra host permissions beyond the generic detector; Bilibili scripts are **match-scoped**.

## Load unpacked (local)

1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `chrome-video-grabber/` (contains `manifest.json`).
4. Open a page with media (or a Bilibili video — see below).
5. Play / let the media load, then open the extension popup.
6. Confirm entries appear with **复制** / **下载**; empty pages show「暂无视频链接」.

Reload the extension card after edits.

## Test on a public Bilibili video

1. Load the unpacked extension as above.
2. Open a **public** BV page, e.g. browse to any video on `https://www.bilibili.com/` that does not require login (guest-playable).
3. Start playback (so playurl / bilivideo CDN traffic fires).
4. Open the Video Grabber popup → expect entries with sources like `bilibili-playinfo-…`, `bilibili-playurl-…`, `bilibili-cdn`, or generic `network` / `dom`.
5. **复制** a URL; optionally **下载** a direct `mp4` / `m4s` link via the browser download manager.

Tips:

- If the list is empty, wait 2–3s after play starts and click **刷新**.
- Prefer a short public clip; avoid VIP-only / region-locked titles when validating.

## Known limits (Bilibili)

| Topic | Behavior |
|-------|----------|
| Login / quality | Higher resolutions often need a logged-in session; we only see streams the tab already requested or embedded in page playinfo. |
| DASH | Video and audio `m4s` URLs are listed **separately**. No HLS/DASH merge or remux in this version. |
| DRM / restricted | DRM, paid-only, or otherwise protected streams are out of scope. |
| Single-file mp4 | Available when the playurl response includes `durl` (quality / client dependent). |
| Personal use | Intended for local educational / personal archival of media you are allowed to access — not for redistribution. |

## Out of scope (later)

- YouTube / Xiaohongshu real extractors
- HLS playlist assembly / DASH muxing
- Background quality picker UI
