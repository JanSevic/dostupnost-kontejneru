// Earlier versions installed a service worker for offline use. The web version no longer works
// offline, so remove the old service worker and its cache (otherwise it could keep serving old files).
(function () {
  "use strict";
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
  if (typeof caches !== "undefined") {
    caches.keys().then((keys) => keys.filter((k) => k.indexOf("dostupnost-") === 0).forEach((k) => caches.delete(k))).catch(() => {});
  }
})();
