# Video Grabber (Chrome MV3 scaffold)

Chrome Extension Manifest V3 scaffold for capturing video resource URLs from **Xiaohongshu**, **YouTube**, and **Bilibili**.

This deliverable is scaffolding only: popup list shell, background service worker stub, and content-script stub. Site-specific extractors and HLS are **not** implemented yet.

## Layout

```
chrome-video-grabber/
├── manifest.json
├── background/service-worker.js
├── content/content-script.js
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
| `permissions` | `storage`, `activeTab` |
| `host_permissions` / content matches | `*.xiaohongshu.com`, `*.youtube.com`, `*.youtu.be`, `*.bilibili.com` |

Host permissions are declared up front so later extractors can call cross-origin APIs on those sites without reshaping the manifest.

## Load unpacked (local)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder: `chrome-video-grabber/` (the directory that contains `manifest.json`).
5. Pin **Video Grabber** from the toolbar puzzle icon if you want quick access.
6. Open the popup — you should see the empty “暂无视频链接” state.
7. Visit a supported site (e.g. youtube.com); open DevTools → Console on the page to see the content-script ready log (optional smoke check).

To reload after edits: on `chrome://extensions`, click the refresh icon on the extension card.

## Next steps (out of scope here)

- Site-specific video URL extractors
- HLS / media pipeline
- Persist detected URLs into the popup list via messaging + `chrome.storage`
