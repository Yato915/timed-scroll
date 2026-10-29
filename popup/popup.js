"use strict";

const settingsApi = globalThis.WebToolsSettings;

const pageContext = document.querySelector("#page-context");
const pageTitle = document.querySelector("#page-title");
const statusCard = document.querySelector("#status-card");
const statusBadge = document.querySelector("#status-badge");
const statText = document.querySelector("#stat-text");
const progressBar = document.querySelector("#progress-bar");
const scrollCountNode = document.querySelector("#scroll-count");
const intervalInput = document.querySelector("#interval");
const intervalUnit = document.querySelector("#interval-unit");
const intervalMinus = document.querySelector("#interval-minus");
const intervalPlus = document.querySelector("#interval-plus");
const intervalChips = [...document.querySelectorAll("[data-interval]")];
const distanceButtons = [...document.querySelectorAll("[data-distance]")];
const pixelsField = document.querySelector("#pixels-field");
const pixelsInput = document.querySelector("#pixels");
const smoothInput = document.querySelector("#smooth");
const stopAtBottomInput = document.querySelector("#stop-at-bottom");
const messageNode = document.querySelector("#message");
const toggleButton = document.querySelector("#toggle");
const shortcutHint = document.querySelector("#shortcut-hint");
const versionBadge = document.querySelector("#version-badge");

const INTERVAL_MIN_SECONDS = settingsApi.minIntervalSeconds;
const INTERVAL_MAX_SECONDS = settingsApi.maxIntervalSeconds;

let distanceMode = "viewport";
let viewportRatio = 1;
let pageUnsupported = false;
let latestStatus = null;
let hasSyncedRunningSettings = false;
let busy = false;
let pollTimer = 0;
let persistTimer = 0;
let activeUnit = "seconds";
let targetTabId = null;

initializePopup();

function initializePopup() {
  intervalInput.addEventListener("input", renderInterval);
  intervalInput.addEventListener("change", () => {
    const totalSeconds = readIntervalSeconds();
    activeUnit = totalSeconds >= 60 && totalSeconds % 60 === 0 ? "minutes" : "seconds";
    intervalUnit.value = activeUnit;
    applyUnitLimits();
    intervalInput.value = String(roundForDisplay(totalSeconds / getUnitMultiplier()));
    renderInterval();
    void commitSettings();
  });
  intervalUnit.addEventListener("change", () => {
    const previousSeconds = Number(intervalInput.value) * unitMultiplierOf(activeUnit);
    activeUnit = intervalUnit.value === "minutes" ? "minutes" : "seconds";
    applyUnitLimits();
    intervalInput.value = String(clamp(previousSeconds / getUnitMultiplier(), Number(intervalInput.min), Number(intervalInput.max)));
    renderInterval();
    queueSettingsChange();
  });
  intervalMinus.addEventListener("click", () => {
    void stepInterval(-1);
  });
  intervalPlus.addEventListener("click", () => {
    void stepInterval(1);
  });
  pixelsInput.addEventListener("input", () => {
    pixelsInput.setAttribute("aria-label", `每次滚动 ${pixelsInput.value || 0} 像素`);
  });
  pixelsInput.addEventListener("change", () => {
    pixelsInput.value = String(readPixels());
    void commitSettings();
  });
  smoothInput.addEventListener("change", queueSettingsChange);
  stopAtBottomInput.addEventListener("change", queueSettingsChange);
  intervalChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      applyIntervalPreset(Number(chip.dataset.interval));
      queueSettingsChange();
    });
  });
  distanceButtons.forEach((button) => {
    button.addEventListener("click", () => {
      applyDistanceChoice(button.dataset.distance);
      queueSettingsChange();
    });
  });
  toggleButton.addEventListener("click", () => {
    void toggleAutoScroll();
  });

  void loadInitialState();
}

async function loadInitialState() {
  await Promise.all([loadPageContext(), loadShortcutHint(), loadStoredSettings()]);
  await refreshStatus();
}

async function loadPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  targetTabId = tab?.id ?? null;
  const title = tab?.title || "当前没有网页";
  pageTitle.textContent = title;
  pageContext.title = title;
  pageUnsupported = settingsApi.isUnsupportedPageUrl(tab?.url);
  pageContext.classList.toggle("is-blocked", pageUnsupported);
  if (pageUnsupported) {
    showMessage("这个页面不能使用工具箱，请打开一个普通网页。");
    toggleButton.disabled = true;
  }
}

async function loadShortcutHint() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === "toggle-auto-scroll");
  shortcutHint.textContent = command?.shortcut
    ? `快捷键 ${command.shortcut} 可开始或停止`
    : "还没有快捷键。可在 edge://extensions/shortcuts 里设置";
  const manifest = chrome.runtime.getManifest();
  versionBadge.textContent = `v${manifest.version}`;
}

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get(settingsApi.storageKey);
  fillForm(settingsApi.normalizeAutoScrollSettings(stored[settingsApi.storageKey]));
}

function fillForm(settings) {
  const normalized = settingsApi.normalizeAutoScrollSettings(settings);
  const useMinutes = normalized.intervalSeconds >= 60;
  activeUnit = useMinutes ? "minutes" : "seconds";
  intervalUnit.value = activeUnit;
  applyUnitLimits();
  intervalInput.value = String(roundForDisplay(normalized.intervalSeconds / getUnitMultiplier()));
  pixelsInput.value = String(normalized.distancePixels);
  smoothInput.checked = normalized.smooth;
  stopAtBottomInput.checked = normalized.stopAtBottom;
  distanceMode = normalized.distanceMode;
  viewportRatio = normalized.viewportRatio;
  renderInterval();
  renderDistanceButtons();
}

function unitMultiplierOf(unit) {
  return unit === "minutes" ? 60 : 1;
}

function applyUnitLimits() {
  const multiplier = unitMultiplierOf(activeUnit);
  intervalInput.min = multiplier === 60 ? "1" : String(INTERVAL_MIN_SECONDS);
  intervalInput.max = String(INTERVAL_MAX_SECONDS / multiplier);
  intervalInput.step = "any";
}

function getUnitMultiplier() {
  return unitMultiplierOf(activeUnit);
}

function readIntervalSeconds() {
  const rawValue = Number(intervalInput.value);
  const multiplier = getUnitMultiplier();
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return latestStatus?.settings?.intervalSeconds ?? settingsApi.defaults.intervalSeconds;
  }
  return clamp(rawValue * multiplier, INTERVAL_MIN_SECONDS, INTERVAL_MAX_SECONDS);
}

function readPixels() {
  const rawValue = Number(pixelsInput.value);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return settingsApi.defaults.distancePixels;
  return clamp(Math.round(rawValue), 80, 4000);
}

function readForm() {
  return settingsApi.normalizeAutoScrollSettings({
    intervalSeconds: readIntervalSeconds(),
    distanceMode,
    viewportRatio,
    distancePixels: readPixels(),
    smooth: smoothInput.checked,
    stopAtBottom: stopAtBottomInput.checked
  });
}

function applyIntervalPreset(totalSeconds) {
  activeUnit = totalSeconds >= 60 && totalSeconds % 60 === 0 ? "minutes" : "seconds";
  intervalUnit.value = activeUnit;
  applyUnitLimits();
  intervalInput.value = String(totalSeconds / getUnitMultiplier());
  renderInterval();
}

async function stepInterval(direction) {
  const currentSeconds = readIntervalSeconds();
  const stepSeconds = activeUnit === "minutes" ? 60 : 0.5;
  const nextSeconds = clamp(currentSeconds + direction * stepSeconds, INTERVAL_MIN_SECONDS, INTERVAL_MAX_SECONDS);
  intervalInput.value = String(roundForDisplay(nextSeconds / getUnitMultiplier()));
  renderInterval();
  await commitSettings();
}

function applyDistanceChoice(choice) {
  if (choice === "pixels") distanceMode = "pixels";
  else {
    distanceMode = "viewport";
    viewportRatio = choice === "half" ? 0.5 : 1;
  }
  renderDistanceButtons();
}

function renderInterval() {
  const currentSeconds = readIntervalSeconds();
  intervalChips.forEach((chip) => {
    const chipSeconds = Number(chip.dataset.interval);
    const matches = Math.abs(chipSeconds - currentSeconds) < 0.01;
    chip.classList.toggle("is-selected", matches);
  });
  intervalInput.setAttribute("aria-label", `滚动间隔 ${settingsApi.formatSeconds(currentSeconds)}`);
}

function renderDistanceButtons() {
  distanceButtons.forEach((button) => {
    const choice = button.dataset.distance;
    const selected = choice === "pixels"
      ? distanceMode === "pixels"
      : distanceMode === "viewport" && viewportRatio === (choice === "half" ? 0.5 : 1);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  pixelsField.hidden = distanceMode !== "pixels";
}

function queueSettingsChange() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void commitSettings();
  }, 180);
}

async function commitSettings() {
  const settings = readForm();
  await chrome.storage.local.set({ [settingsApi.storageKey]: settings });
  if (!latestStatus?.running) return;
  const response = await sendCommand("update", settings);
  if (!response?.ok) {
    showMessage(response?.error || "没能更新正在运行的滚动。");
    return;
  }
  clearMessage();
  applyStatus(response.status);
}

async function toggleAutoScroll() {
  if (busy || pageUnsupported) return;
  busy = true;
  toggleButton.disabled = true;
  try {
    const action = latestStatus?.running ? "stop" : "start";
    const settings = readForm();
    await chrome.storage.local.set({ [settingsApi.storageKey]: settings });
    const response = await sendCommand(action, settings);
    if (!response?.ok) {
      showMessage(response?.error || "操作失败。");
      return;
    }
    clearMessage();
    applyStatus(response.status);
  } catch (error) {
    showMessage("操作没有成功，请重开工具箱后再试。");
  } finally {
    busy = false;
    toggleButton.disabled = pageUnsupported;
  }
}

async function refreshStatus() {
  const response = await sendCommand("status");
  if (!response?.ok) {
    showMessage(response?.error || "读取状态失败。");
    return;
  }
  if (!response.status.running) clearMessageIfStatusOnly();
  applyStatus(response.status);
}

function applyStatus(status) {
  latestStatus = status;
  if (status.running && status.settings && !hasSyncedRunningSettings) {
    fillForm(status.settings);
    hasSyncedRunningSettings = true;
  }
  if (!status.running) hasSyncedRunningSettings = false;
  renderStatus(status);
  syncPolling();
}

function renderStatus(status) {
  const running = Boolean(status.running);
  const paused = running && Boolean(status.paused);
  toggleButton.textContent = running ? "停止下滑" : "开始下滑";
  toggleButton.classList.toggle("is-running", running);
  statusCard.classList.toggle("is-running", running && !paused);
  statusCard.classList.toggle("is-paused", paused);

  if (!running && status.stopReason === "bottom") statusBadge.textContent = "已到底";
  else if (!running && status.stopReason === "error") statusBadge.textContent = "已中断";
  else if (paused) statusBadge.textContent = status.hiddenPause ? "后台暂停" : "暂停中";
  else if (running) statusBadge.textContent = "进行中";
  else statusBadge.textContent = "未开始";

  statText.textContent = describeStatus(status);
  scrollCountNode.textContent = String(status.scrollCount ?? 0);
  const progressRatio = Math.min(1, Math.max(0, getProgressRatio(status)));
  progressBar.style.width = `${Math.round(progressRatio * 100)}%`;
}

function describeStatus(status) {
  if (status.hiddenPause) return "页面在后台，切回来会继续。";
  if (status.running && status.phase === "paused") {
    const seconds = Math.max(0, status.pauseRemainingMs) / 1000;
    return `检测到手动滚动，${seconds.toFixed(1)} 秒后继续。`;
  }
  if (status.running && status.phase === "scrolling") return "正在向下滚动…";
  if (status.running) {
    const seconds = Math.max(0, status.nextTickAt - Date.now()) / 1000;
    const distanceLabel = settingsApi.describeAutoScrollDistance(status.settings);
    return `${seconds.toFixed(1)} 秒后继续 · 每次 ${distanceLabel}`;
  }
  if (status.stopReason === "bottom") return "已经滚到页面底部，自动停止了。";
  if (status.stopReason === "error") return "页面结构变化导致中断，请刷新页面后重试。";
  return "设置好间隔后点开始。";
}

function getProgressRatio(status) {
  if (!status.running) return status.stopReason === "bottom" ? 1 : 0;
  if (status.phase === "scrolling") return 1;
  if (status.phase === "paused" && !status.hiddenPause) {
    return 1 - status.pauseRemainingMs / settingsApi.userPauseMs;
  }
  if (status.phase === "waiting" && status.settings) {
    const intervalMs = status.settings.intervalSeconds * 1000;
    const remainingMs = Math.max(0, status.nextTickAt - Date.now());
    return 1 - remainingMs / intervalMs;
  }
  return 0;
}

function syncPolling() {
  clearInterval(pollTimer);
  if (!latestStatus?.running) return;
  pollTimer = setInterval(() => {
    void refreshStatus();
  }, 250);
}

async function sendCommand(action, settings) {
  return chrome.runtime.sendMessage({
    scope: "web-tools",
    tool: "auto-scroll",
    action,
    settings,
    tabId: targetTabId
  });
}

function showMessage(text) {
  messageNode.hidden = false;
  messageNode.textContent = text;
}

function clearMessage() {
  messageNode.hidden = true;
  messageNode.textContent = "";
}

function clearMessageIfStatusOnly() {
  if (messageNode.hidden) return;
  if (messageNode.textContent.startsWith("这个页面不能使用")) return;
  clearMessage();
}

function roundForDisplay(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
