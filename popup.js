const PDF_PATH_RE = /\.pdf$/i;

function t(key, subs) {
  return chrome.i18n.getMessage(key, subs);
}

function applyStaticI18n() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
}

function isPdfUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    return PDF_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

function sanitizeFilename(name) {
  let s = (name || "").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  s = s.replace(/\s+/g, " ");
  if (!/\.pdf$/i.test(s)) s += ".pdf";
  if (s.length > 200) s = s.slice(0, 196) + ".pdf";
  return s || "download.pdf";
}

function tabFilename(tab) {
  const title = (tab.title || "").trim();
  if (title) return sanitizeFilename(title);
  try {
    const u = new URL(tab.url);
    const last = decodeURIComponent(u.pathname.split("/").pop() || "download");
    return sanitizeFilename(last);
  } catch {
    return "download.pdf";
  }
}

function waitForDownload(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== id) return;
      if (delta.state && delta.state.current !== "in_progress") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function findPdfTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((x) => isPdfUrl(x.url));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Serialize chrome.tabs.remove calls with a gap between each,
// so Chrome's tab strip UI has time to animate and doesn't leave ghosts.
function makeSerialCloser(intervalMs) {
  let chain = Promise.resolve();
  return function enqueue(tabId) {
    chain = chain.then(async () => {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
      await sleep(intervalMs);
    });
    return chain;
  };
}

const CLOSE_INTERVAL_MS = 300;

async function downloadAll(tabs, closeAfter, onProgress) {
  let done = 0;
  const total = tabs.length;
  const enqueueClose = makeSerialCloser(CLOSE_INTERVAL_MS);

  const tasks = tabs.map(async (tab) => {
    const filename = tabFilename(tab);
    try {
      const id = await chrome.downloads.download({ url: tab.url, filename });
      if (closeAfter && id !== undefined) {
        const finalState = await waitForDownload(id);
        if (finalState === "complete") {
          await enqueueClose(tab.id);
        }
      }
    } catch (e) {
      console.error("download failed:", tab.url, e);
    } finally {
      done++;
      onProgress(done, total);
    }
  });
  await Promise.all(tasks);
}

async function init() {
  applyStaticI18n();

  const list = document.getElementById("list");
  const countEl = document.getElementById("count");
  const btn = document.getElementById("download");
  const closeChk = document.getElementById("close-after");
  const statusEl = document.getElementById("status");

  const tabs = await findPdfTabs();

  countEl.textContent = t("countDetected", [String(tabs.length)]);

  list.innerHTML = "";
  if (tabs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("noPdfsFound");
    list.appendChild(li);
    btn.disabled = true;
  } else {
    for (const tab of tabs) {
      const li = document.createElement("li");
      li.textContent = tab.title || tab.url;
      li.title = tab.url;
      list.appendChild(li);
    }
    btn.disabled = false;
  }

  const stored = await chrome.storage.local.get("closeAfterDownload");
  closeChk.checked = Boolean(stored.closeAfterDownload);
  closeChk.addEventListener("change", () => {
    chrome.storage.local.set({ closeAfterDownload: closeChk.checked });
  });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    closeChk.disabled = true;
    statusEl.textContent = t("downloading", ["0", String(tabs.length)]);
    await downloadAll(tabs, closeChk.checked, (d, total) => {
      statusEl.textContent = t("downloading", [String(d), String(total)]);
    });
    statusEl.textContent = t("complete", [String(tabs.length)]);
  });
}

document.addEventListener("DOMContentLoaded", init);
