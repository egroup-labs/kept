/**
 * Kept — Kimi Auth Content Script
 *
 * Runs on kimi.com to extract the access_token from localStorage
 * and send it to the background service worker via messaging.
 * This avoids needing the "cookies" permission.
 */
(function () {
  function sendToken() {
    try {
      const token = localStorage.getItem("access_token");
      if (token) {
        chrome.runtime.sendMessage({ type: "kimi-auth-token", token });
      }
    } catch (_) {
      // localStorage may be blocked
    }
  }

  sendToken();
  // Retry after a short delay in case the token is set after page load
  setTimeout(sendToken, 2000);
})();
