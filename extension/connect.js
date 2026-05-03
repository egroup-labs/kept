/**
 * Kept - Connect Page Content Script
 */
(function () {
  console.log("[Kept connect.js] content script running");

  var statusTagEl = document.getElementById("kept-status-tag");
  var detailEl = document.getElementById("kept-connect-detail");
  var installSection = document.getElementById("kept-install-section");
  var params = new URLSearchParams(window.location.search);
  var shouldAutoClose = params.get("close") === "1";
  var shouldSync = params.get("sync") === "1";
  var shouldStop = params.get("stop") === "1";

  if (!statusTagEl) {
    console.error("[Kept connect.js] could not find status tag element - wrong page?");
    return;
  }

  if (installSection) installSection.style.display = "none";
  statusTagEl.className = "status-tag";
  statusTagEl.textContent = "connecting...";
  if (detailEl) detailEl.textContent = "Saving auth token...";

  var tokenMeta = document.querySelector('meta[name="kept-token"]');
  var token = tokenMeta ? tokenMeta.getAttribute("content") : null;
  console.log("[Kept connect.js] token from meta tag:", token ? token.slice(0, 8) + "..." : "MISSING");

  function setError(msg) {
    console.error("[Kept connect.js] error:", msg);
    statusTagEl.className = "status-tag not-found";
    statusTagEl.textContent = "error";
    if (detailEl) detailEl.textContent = msg;
  }

  function reportResult(payload, callback) {
    chrome.runtime.sendMessage(
      Object.assign(
        {
          type: "connect-flow-result",
          autoClose: shouldAutoClose,
        },
        payload,
      ),
      function (resp) {
        if (chrome.runtime.lastError) {
          callback({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        callback(resp || { ok: false, error: "No response from background worker" });
      },
    );
  }

  function failConnection(msg) {
    reportResult({ ok: false, error: msg }, function () {});
    if (!shouldAutoClose) {
      setError(msg);
    }
  }

  if (!token) {
    failConnection("No token found in page - is the desktop app running?");
    return;
  }

  console.log("[Kept connect.js] saving keptAppToken to storage...");
  chrome.storage.local.set({ keptAppToken: token }, function () {
    if (chrome.runtime.lastError) {
      failConnection("Storage error: " + chrome.runtime.lastError.message);
      return;
    }

    console.log("[Kept connect.js] token saved, notifying background...");
    reportResult({ ok: true, token: token }, function (resp) {
      if (resp && resp.ok) {
        statusTagEl.className = "status-tag connected";
        statusTagEl.textContent = "connected";
        if (detailEl) {
          detailEl.textContent =
            "Your extension is now connected to the Kept desktop app. You can close this tab.";
        }
        // If the app requested an immediate sync (e.g. from onboarding import step)
        if (shouldSync) {
          var syncMsg = { type: "sync-now" };
          var syncProviders = params.get("providers");
          if (syncProviders) syncMsg.providers = syncProviders.split(",");
          var syncLimit = parseInt(params.get("limit"), 10);
          if (syncLimit > 0) syncMsg.maxConversations = syncLimit;
          chrome.runtime.sendMessage(syncMsg);
        }
        // If the app requested a sync stop
        if (shouldStop) {
          chrome.runtime.sendMessage({ type: "stop-sync" });
        }
      } else {
        setError((resp && resp.error) || "Could not verify the Kept desktop app. Try clicking Refresh in the desktop app.");
      }
    });
  });
})();
