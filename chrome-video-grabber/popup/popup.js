/**
 * Popup — lists detected video URLs with copy + download / HLS merge-download.
 */

import { formatBytes, isHlsPlaylistUrl } from "../shared/media.js";

const videoListEl = document.getElementById("video-list");
const emptyStateEl = document.getElementById("empty-state");
const countBadgeEl = document.getElementById("count-badge");
const refreshBtn = document.getElementById("refresh-btn");
const statusLineEl = document.getElementById("status-line");

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
  if (!text) {
    statusLineEl.hidden = true;
    statusLineEl.textContent = "";
    statusLineEl.classList.remove("error");
    return;
  }
  statusLineEl.hidden = false;
  statusLineEl.textContent = text;
  statusLineEl.classList.toggle("error", isError);
}

/**
 * @param {{ url: string, type?: string | null, kind?: string }} item
 * @returns {boolean}
 */
function isHlsItem(item) {
  if (item?.kind === "hls") return true;
  if (item?.type === "m3u8" || item?.type === "m3u") return true;
  return isHlsPlaylistUrl(item?.url || "");
}

/**
 * @param {string} url
 */
async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/**
 * @param {string} url
 */
function downloadUrl(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "videos:download", url }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: "no-response" });
    });
  });
}

/**
 * @param {string} url
 * @param {'highest' | 'lowest'} [variant]
 */
function downloadHls(url, variant = "highest") {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "videos:download-hls", url, variant },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, reason: "no-response" });
      }
    );
  });
}

/**
 * @param {Array<{ url: string, type?: string | null, size?: number | null, source?: string, kind?: string }>} videos
 */
function renderVideoList(videos) {
  const items = Array.isArray(videos) ? videos.filter((v) => v?.url) : [];

  videoListEl.replaceChildren();

  if (items.length === 0) {
    emptyStateEl.hidden = false;
    countBadgeEl.hidden = true;
    countBadgeEl.textContent = "0";
    return;
  }

  emptyStateEl.hidden = true;
  countBadgeEl.hidden = false;
  countBadgeEl.textContent = String(items.length);

  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const hls = isHlsItem(item);
    const li = document.createElement("li");
    li.className = hls ? "video-item video-item-hls" : "video-item";

    const link = document.createElement("a");
    link.className = "video-url";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.url;
    link.title = item.url;

    const meta = document.createElement("div");
    meta.className = "video-meta";

    if (hls) {
      const hlsChip = document.createElement("span");
      hlsChip.className = "meta-chip hls";
      hlsChip.textContent = "HLS";
      meta.appendChild(hlsChip);
    }

    if (item.type) {
      const typeChip = document.createElement("span");
      typeChip.className = "meta-chip type";
      typeChip.textContent = item.type;
      meta.appendChild(typeChip);
    }

    const sizeLabel = formatBytes(item.size);
    if (sizeLabel) {
      const sizeChip = document.createElement("span");
      sizeChip.className = "meta-chip";
      sizeChip.textContent = sizeLabel;
      meta.appendChild(sizeChip);
    }

    if (item.source) {
      const sourceChip = document.createElement("span");
      sourceChip.className = "meta-chip";
      sourceChip.textContent = item.source;
      meta.appendChild(sourceChip);
    }

    const actions = document.createElement("div");
    actions.className = "video-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "action-btn";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyUrl(item.url);
      if (ok) {
        copyBtn.textContent = "已复制";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "复制";
          copyBtn.classList.remove("copied");
        }, 1200);
      } else {
        setStatus("复制失败", true);
      }
    });

    actions.appendChild(copyBtn);

    if (hls) {
      const mergeBtn = document.createElement("button");
      mergeBtn.type = "button";
      mergeBtn.className = "action-btn action-btn-primary";
      mergeBtn.textContent = "合并下载";
      mergeBtn.title =
        "拉取分片并在扩展内拼接为单个文件（仅未加密 VOD；大文件受内存限制）";
      mergeBtn.addEventListener("click", async () => {
        mergeBtn.disabled = true;
        mergeBtn.textContent = "合并中…";
        setStatus("正在拉取 HLS 分片并合并…");
        const result = await downloadHls(item.url, "highest");
        mergeBtn.disabled = false;
        if (result.ok) {
          const mb =
            result.bytes != null
              ? `${(result.bytes / (1024 * 1024)).toFixed(1)} MB`
              : "";
          const segs =
            result.segmentCount != null ? `${result.segmentCount} 片` : "";
          mergeBtn.textContent = "已开始";
          setStatus(
            [
              "HLS 合并下载已开始",
              result.filename,
              segs,
              mb,
              result.variantLabel,
            ]
              .filter(Boolean)
              .join(" · ")
          );
          setTimeout(() => {
            mergeBtn.textContent = "合并下载";
          }, 1600);
        } else {
          mergeBtn.textContent = "合并下载";
          setStatus(result.reason || "HLS 合并失败", true);
        }
      });
      actions.appendChild(mergeBtn);
    } else {
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "action-btn";
      dlBtn.textContent = "下载";
      dlBtn.addEventListener("click", async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "…";
        const result = await downloadUrl(item.url);
        dlBtn.disabled = false;
        if (result.ok) {
          dlBtn.textContent = "已开始";
          setTimeout(() => {
            dlBtn.textContent = "下载";
          }, 1200);
          setStatus("已开始浏览器下载");
        } else {
          dlBtn.textContent = "下载";
          setStatus(result.reason || "下载失败", true);
        }
      });
      actions.appendChild(dlBtn);
    }

    li.append(link, meta, actions);
    fragment.appendChild(li);
  }

  videoListEl.appendChild(fragment);
}

function loadVideos() {
  setStatus("加载中…");
  chrome.runtime.sendMessage({ type: "videos:list" }, (response) => {
    if (chrome.runtime.lastError) {
      renderVideoList([]);
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }
    if (!response?.ok) {
      renderVideoList([]);
      setStatus("无法读取当前标签页", true);
      return;
    }
    renderVideoList(response.videos || []);
    const hlsCount = (response.videos || []).filter(isHlsItem).length;
    if (!response.videos?.length) {
      setStatus("");
      return;
    }
    setStatus(
      hlsCount
        ? `当前标签 · ${response.videos.length} 条（HLS ${hlsCount}）`
        : `当前标签 · ${response.videos.length} 条`
    );
  });
}

refreshBtn.addEventListener("click", () => {
  loadVideos();
});

loadVideos();
