import { KEPT_APP_URL } from "./utils.js";

document.addEventListener("DOMContentLoaded", async () => {
  const syncBtn = document.getElementById("syncBtn");
  const appStatusTag = document.getElementById("appStatusTag");

  const syncLimitSlider = document.getElementById("syncLimitSlider");
  const syncLimitValue = document.getElementById("syncLimitValue");
  const syncTargetInput = document.getElementById("syncTargetInput");

  const providerToggles = {
    chatgpt: document.getElementById("providerChatgpt"),
    claude: document.getElementById("providerClaude"),
    gemini: document.getElementById("providerGemini"),
    grok: document.getElementById("providerGrok"),
    kimi: document.getElementById("providerKimi"),
  };

  const providerStatusEls = {
    chatgpt: {
      row: document.getElementById("chatgptRow"),
      tag: document.getElementById("chatgptTag"),
      detail: document.getElementById("chatgptDetail"),
    },
    claude: {
      row: document.getElementById("claudeRow"),
      tag: document.getElementById("claudeTag"),
      detail: document.getElementById("claudeDetail"),
    },
    gemini: {
      row: document.getElementById("geminiRow"),
      tag: document.getElementById("geminiTag"),
      detail: document.getElementById("geminiDetail"),
    },
    grok: {
      row: document.getElementById("grokRow"),
      tag: document.getElementById("grokTag"),
      detail: document.getElementById("grokDetail"),
    },
    kimi: {
      row: document.getElementById("kimiRow"),
      tag: document.getElementById("kimiTag"),
      detail: document.getElementById("kimiDetail"),
    },
  };

  // Latest per-provider status, kept around so toggle changes can re-evaluate
  // the dim state (which combines "toggle off" and "signed out").
  let latestStatus = {};

  function applyRowDim(name) {
    const els = providerStatusEls[name];
    const toggle = providerToggles[name];
    if (!els || !toggle) return;
    const signedOut = latestStatus[name]?.notLoggedIn === true;
    els.row.classList.toggle("dim", !toggle.checked || signedOut);
    // When signed out we keep the underlying `enabledProviders` setting
    // intact (so it survives a re-login) but force the toggle to render as
    // off so the row can't appear "on but unable to sync".
    els.row.classList.toggle("signed-out", signedOut);
  }

  async function checkAppStatus() {
    appStatusTag.textContent = "checking…";

    try {
      const resp = await fetch(`${KEPT_APP_URL}/api/ping`, {
        signal: AbortSignal.timeout(2000),
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "ok") {
          appStatusTag.textContent = "connected";
          return;
        }
      }

      appStatusTag.textContent = "offline";
    } catch {
      appStatusTag.textContent = "offline";
    }
  }

  checkAppStatus();

  const {
    enabledProviders = {},
    syncLimit = 0,
    syncTargetDir = "",
  } = await chrome.storage.local.get([
    "enabledProviders",
    "syncLimit",
    "syncTargetDir",
  ]);

  syncLimitSlider.value = String(syncLimit || 0);
  syncLimitValue.textContent = syncLimit > 0 ? String(syncLimit) : "All";
  syncTargetInput.value = syncTargetDir || "";

  for (const [name, toggle] of Object.entries(providerToggles)) {
    toggle.checked = enabledProviders[name] !== false;
    applyRowDim(name);
  }

  let syncTimeout = null;
  let isSyncing = false;

  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  // Always render at least once so the static "-" placeholders in the HTML
  // are replaced with the per-provider hidden/visible state, even when no
  // sync history exists yet.
  renderStatus(lastStatus || {});

  syncBtn.addEventListener("click", () => {
    if (isSyncing) {
      chrome.runtime.sendMessage({ type: "stop-sync" });
      syncBtn.disabled = true;
      syncBtn.textContent = "Stopping…";
      return;
    }

    isSyncing = true;
    syncBtn.textContent = "Stop Sync";
    syncBtn.classList.add("stop");

    syncTimeout = setTimeout(() => {
      isSyncing = false;
      syncBtn.classList.remove("stop");
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
    }, 5 * 60 * 1000);

    chrome.runtime.sendMessage({ type: "sync-now" });
  });

  syncLimitSlider.addEventListener("input", () => {
    const val = Number(syncLimitSlider.value) || 0;
    syncLimitValue.textContent = val > 0 ? String(val) : "All";
  });

  syncLimitSlider.addEventListener("change", () => {
    const val = Number(syncLimitSlider.value) || 0;
    chrome.runtime.sendMessage({
      type: "update-settings",
      settings: { syncLimit: val },
    });
  });

  // Persist sync target on blur / Enter so we don't write every keystroke.
  // Empty string clears the override and restores the default vault.
  function commitSyncTarget() {
    const value = syncTargetInput.value.trim();
    syncTargetInput.value = value;
    chrome.runtime.sendMessage({
      type: "update-settings",
      settings: { syncTargetDir: value },
    });
  }
  syncTargetInput.addEventListener("change", commitSyncTarget);
  syncTargetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      syncTargetInput.blur();
    }
  });

  for (const [name, toggle] of Object.entries(providerToggles)) {
    toggle.addEventListener("change", () => {
      // If turning a signed-out provider back on, optimistically clear the
      // local marker so the row un-dims immediately, and ask the background
      // to retry the sync. Failed retry will re-mark it.
      const wasSignedOut = latestStatus[name]?.notLoggedIn === true;
      if (toggle.checked && wasSignedOut) {
        latestStatus[name] = { ...latestStatus[name], notLoggedIn: false, error: null };
        chrome.runtime.sendMessage({ type: "retry-auth", provider: name });
      }

      applyRowDim(name);
      const enabledProviders = {};
      for (const [providerName, providerToggle] of Object.entries(providerToggles)) {
        enabledProviders[providerName] = providerToggle.checked;
      }

      chrome.runtime.sendMessage({
        type: "update-settings",
        settings: { enabledProviders },
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "sync-status") {
      renderStatus(msg.status);
    }
  });

  function renderStatus(status) {
    latestStatus = status || {};

    if (status.syncing) {
      isSyncing = true;
      syncBtn.disabled = false;
      syncBtn.textContent = "Stop Sync";
      syncBtn.classList.add("stop");
    } else {
      if (syncTimeout) {
        clearTimeout(syncTimeout);
        syncTimeout = null;
      }

      isSyncing = false;
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
      syncBtn.classList.remove("stop");
    }

    for (const [providerName, els] of Object.entries(providerStatusEls)) {
      renderPlatformRow(status[providerName], els.tag, els.detail);
      applyRowDim(providerName);
    }
  }

  function renderPlatformRow(platformStatus, tagEl, detailEl) {
    tagEl.className = "platform-tag";
    tagEl.hidden = false;

    if (!platformStatus) {
      tagEl.hidden = true;
      tagEl.textContent = "";
      detailEl.textContent = "Not synced yet";
      return;
    }

    if (platformStatus.syncing) {
      tagEl.classList.add("syncing");
      tagEl.textContent = "syncing…";
      detailEl.textContent = "In progress";
    } else if (platformStatus.disabled) {
      // Row is already dimmed by the provider toggle — no extra pill needed.
      tagEl.hidden = true;
      tagEl.textContent = "";
      detailEl.textContent = "Disabled for background sync";
    } else if (platformStatus.notLoggedIn) {
      tagEl.classList.add("off");
      tagEl.textContent = "signed out";
      detailEl.textContent = "Sign in to sync.";
    } else if (platformStatus.error) {
      tagEl.classList.add("error");
      tagEl.textContent = "error";
      detailEl.textContent = String(platformStatus.error)
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 100) || "Unknown error";
    } else if (platformStatus.lastSync) {
      const count = platformStatus.count || 0;
      if (count > 0) {
        tagEl.classList.add("ok");
        tagEl.textContent = `${count} new`;
      } else {
        tagEl.hidden = true;
        tagEl.textContent = "";
      }
      const total = platformStatus.total || 0;
      const time = formatRelativeTime(new Date(platformStatus.lastSync));
      detailEl.textContent = `${total} total · ${time}`;
    } else {
      tagEl.hidden = true;
      tagEl.textContent = "";
      detailEl.textContent = "Not synced yet";
    }
  }
});

function formatRelativeTime(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return date.toLocaleDateString();
}
