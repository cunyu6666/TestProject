/**
 * Popup UI — list shell for future video URLs + empty state.
 * Extractors / HLS are intentionally not wired yet.
 */

const videoListEl = document.getElementById("video-list");
const emptyStateEl = document.getElementById("empty-state");
const countBadgeEl = document.getElementById("count-badge");

/**
 * @param {string[]} urls
 */
function renderVideoList(urls) {
  const items = Array.isArray(urls) ? urls.filter(Boolean) : [];

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
  for (const url of items) {
    const li = document.createElement("li");
    li.className = "video-item";

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;

    li.appendChild(link);
    fragment.appendChild(li);
  }
  videoListEl.appendChild(fragment);
}

// Scaffold: no capture yet — always show empty state.
// Later: chrome.storage / messaging from content scripts.
renderVideoList([]);
