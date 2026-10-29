(function initializeWebToolsSettings(globalObject) {
  "use strict";

  const STORAGE_KEY = "autoScrollSettings";
  const USER_PAUSE_MS = 2500;
  const MIN_INTERVAL_SECONDS = 0.5;
  const MAX_INTERVAL_SECONDS = 3600;

  const DEFAULT_AUTO_SCROLL_SETTINGS = {
    intervalSeconds: 2,
    distanceMode: "viewport",
    viewportRatio: 1,
    distancePixels: 600,
    smooth: true,
    stopAtBottom: true
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeAutoScrollSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const intervalSeconds = clamp(
      Number(source.intervalSeconds) || DEFAULT_AUTO_SCROLL_SETTINGS.intervalSeconds,
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    );
    const distanceMode = source.distanceMode === "pixels" ? "pixels" : "viewport";
    const viewportRatio = Number(source.viewportRatio) === 0.5 ? 0.5 : 1;
    const distancePixels = clamp(
      Math.round(Number(source.distancePixels) || DEFAULT_AUTO_SCROLL_SETTINGS.distancePixels),
      80,
      4000
    );

    return {
      intervalSeconds: Math.round(intervalSeconds * 10) / 10,
      distanceMode,
      viewportRatio,
      distancePixels,
      smooth: source.smooth !== false,
      stopAtBottom: source.stopAtBottom !== false
    };
  }

  function formatSeconds(value) {
    const rounded = Math.round(Number(value) * 10) / 10;
    if (!Number.isFinite(rounded) || rounded <= 0) return "0 秒";
    if (rounded >= 60) {
      const minutes = rounded / 60;
      const text = Number.isInteger(minutes) ? minutes.toFixed(0) : minutes.toFixed(1);
      return `${text} 分钟`;
    }
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)} 秒` : `${rounded.toFixed(1)} 秒`;
  }

  function describeAutoScrollDistance(settings) {
    const normalized = normalizeAutoScrollSettings(settings);
    if (normalized.distanceMode === "pixels") return `${normalized.distancePixels} 像素`;
    return normalized.viewportRatio === 0.5 ? "半屏" : "一屏";
  }

  function isUnsupportedPageUrl(url) {
    if (!url) return true;
    const lowerUrl = url.toLowerCase();
    if (/^(edge|chrome|devtools|chrome-extension|edge-extension|extension|about|view-source|chrome-untrusted):/.test(lowerUrl)) {
      return true;
    }
    return (
      lowerUrl.startsWith("https://chrome.google.com/webstore") ||
      lowerUrl.startsWith("https://chromewebstore.google.com") ||
      lowerUrl.startsWith("https://microsoftedge.microsoft.com/addons")
    );
  }

  globalObject.WebToolsSettings = {
    storageKey: STORAGE_KEY,
    userPauseMs: USER_PAUSE_MS,
    minIntervalSeconds: MIN_INTERVAL_SECONDS,
    maxIntervalSeconds: MAX_INTERVAL_SECONDS,
    defaults: DEFAULT_AUTO_SCROLL_SETTINGS,
    normalizeAutoScrollSettings,
    formatSeconds,
    describeAutoScrollDistance,
    isUnsupportedPageUrl
  };
})(globalThis);
