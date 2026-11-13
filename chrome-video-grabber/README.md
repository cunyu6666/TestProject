# Video Grabber (Chrome MV3)

Chrome Extension Manifest V3 — detect video resource URLs on the **active tab** and list them in the popup for **copy** / **browser download**.

## What this version does

- Scans `<video>` / `<source>` `src` (and `currentSrc`) via the content script
- Captures obvious network media URLs (`mp4`, `webm`, `m4v`, …) through:
  - `chrome.webRequest.onHeadersReceived` (content-type / extension)
  - Performance resource timing in the page
- Deduplicates per tab; shows type and size when cheap to obtain
- Empty state when nothing was found
- Site-specific Bilibili / YouTube / Xiaohongshu extractors are **stubs only**

## Layout

```
chrome-video-grabber/
├── manifest.json
├── shared/media.js
├── background/service-worker.js
├── content/
│   ├── content-script.js
│   └── extractors/stubs.js
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/
└── README.md
```

## Permissions

| Kind | Values |
|------|--------|
| `permissions` | `storage`, `activeTab`, `tabs`, `webRequest`, `downloads` |
| `host_permissions` / content matches | `<all_urls>` |

## Load unpacked (local)

1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `chrome-video-grabber/` (contains `manifest.json`).
4. Open a page with a direct video file or an HTML5 `<video>` (e.g. a sample `.mp4` URL).
5. Play / let the media load, then open the extension popup.
6. Confirm entries appear with **复制** / **下载**; empty pages show「暂无视频链接」.

Reload the extension card after edits.

## Out of scope (later)

- Real Bilibili / YouTube / Xiaohongshu extractors (stubs under `content/extractors/`)
- HLS playlist assembly / muxing
