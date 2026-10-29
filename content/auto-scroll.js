(() => {
  "use strict";

  if (globalThis.__webToolsAutoScrollInstalled) return;
  globalThis.__webToolsAutoScrollInstalled = true;

  const settingsApi = globalThis.WebToolsSettings;
  const HOST_ID = "web-tools-auto-scroll-host";
  const MIN_STEP_PIXELS = 40;
  const BOTTOM_THRESHOLD_PIXELS = 2;
  const FINISHED_VISIBLE_MS = 2400;
  const SMOOTH_DURATION_RATIO = 0.4;
  const MIN_SMOOTH_MS = 180;
  const MAX_SMOOTH_MS = 700;
  const ANIMATION_WATCHDOG_BUFFER_MS = 400;
  const BOTTOM_CONFIRM_CHECKS = 3;
  const BOTTOM_CONFIRM_DELAY_MS = 1000;
  const MAX_CONSECUTIVE_ERRORS = 4;

  const state = {
    settings: settingsApi ? settingsApi.normalizeAutoScrollSettings(settingsApi.defaults) : null,
    running: false,
    phase: "idle",
    stopReason: null,
    scrollCount: 0,
    pausedUntil: 0,
    hiddenPause: false,
    nextTickAt: 0,
    timer: 0,
    animationFrame: 0,
    animationToken: 0,
    widgetTimer: 0,
    hideTimer: 0,
    host: null,
    panel: null,
    countdownNode: null,
    captionNode: null,
    ringNode: null,
    ringLength: 0,
    stopButton: null,
    target: null,
    consecutiveErrors: 0,
    customPosition: false,
    left: 0,
    top: 0
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.scope !== "web-tools" || message.tool !== "auto-scroll") return false;

    try {
      if (message.action === "start") startAutoScroll(message.settings);
      else if (message.action === "stop") stopAutoScroll("manual");
      else if (message.action === "update") updateAutoScrollSettings(message.settings);
      else if (message.action !== "status") {
        sendResponse({ ok: false, error: "未知操作" });
        return false;
      }
      sendResponse({ ok: true, status: getAutoScrollStatus() });
    } catch (error) {
      sendResponse({ ok: false, error: "页面里启动滚动失败" });
    }
    return false;
  });

  window.addEventListener("wheel", pauseForUserInput, { capture: true, passive: true });
  window.addEventListener("touchmove", pauseForUserInput, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("visibilitychange", onVisibilityChange);

  const hostObserver = new MutationObserver(() => {
    if (!state.running || !state.host || state.host.isConnected) return;
    document.documentElement.appendChild(state.host);
  });
  hostObserver.observe(document.documentElement, { childList: true });

  function startAutoScroll(settings) {
    state.settings = normalizeSettings(settings);
    state.running = true;
    state.phase = "scrolling";
    state.stopReason = null;
    state.scrollCount = 0;
    state.pausedUntil = 0;
    state.target = null;
    state.consecutiveErrors = 0;
    state.hiddenPause = document.hidden;
    clearTimeout(state.timer);
    clearTimeout(state.hideTimer);
    cancelScrollAnimation();
    showWidget();
    if (state.hiddenPause) {
      state.phase = "paused";
      updateWidget();
      return;
    }
    void runScrollCycle();
  }

  function updateAutoScrollSettings(settings) {
    state.settings = normalizeSettings(settings);
    if (!state.running || state.hiddenPause) {
      updateWidget();
      return;
    }
    if (state.phase === "waiting" || state.phase === "paused") {
      const remainingMs = state.phase === "paused"
        ? Math.max(0, state.pausedUntil - Date.now())
        : state.settings.intervalSeconds * 1000;
      scheduleWake(remainingMs, state.phase === "paused" ? "paused" : "waiting");
    }
    updateWidget();
  }

  function stopAutoScroll(reason) {
    const wasRunning = state.running;
    state.running = false;
    state.phase = "idle";
    state.stopReason = reason;
    state.pausedUntil = 0;
    state.hiddenPause = false;
    state.target = null;
    state.consecutiveErrors = 0;
    clearTimeout(state.timer);
    cancelScrollAnimation();
    if (wasRunning) notifyBackgroundStopped(reason);
    if (reason === "bottom" || reason === "error") showFinishedWidget();
    else hideWidget();
  }

  function runScrollCycle() {
    if (!state.running || state.hiddenPause) return;
    try {
      performScrollCycle();
    } catch (error) {
      handleCycleError(error);
    }
  }

  async function performScrollCycle() {
    if (!state.running || state.hiddenPause) return;
    if (Date.now() < state.pausedUntil) {
      scheduleWake(state.pausedUntil - Date.now(), "paused");
      return;
    }

    const target = resolveScrollTarget();
    const remaining = target ? getRemainingScroll(target) : 0;
    if (!target || remaining <= BOTTOM_THRESHOLD_PIXELS) {
      const canReturnToTop = Boolean(target)
        && !state.settings.stopAtBottom
        && getMaxScrollTop(target) > BOTTOM_THRESHOLD_PIXELS;
      if (canReturnToTop) {
        setScrollTop(target, 0);
        state.scrollCount += 1;
        state.consecutiveErrors = 0;
        scheduleWake(state.settings.intervalSeconds * 1000, "waiting");
        return;
      }
      if (!(await confirmReachedBottom())) {
        scheduleWake(state.settings.intervalSeconds * 1000, "waiting");
        return;
      }
      stopAutoScroll("bottom");
      return;
    }

    state.phase = "scrolling";
    updateWidget();
    const step = Math.min(Math.max(MIN_STEP_PIXELS, computeStepDistance(target)), remaining);
    const duration = state.settings.smooth ? getSmoothDuration(state.settings.intervalSeconds * 1000) : 0;
    const completed = await animateScroll(target, step, duration);
    if (!state.running || state.hiddenPause) return;

    if (completed) {
      state.scrollCount += 1;
      state.consecutiveErrors = 0;
    }
    if (Date.now() < state.pausedUntil) {
      scheduleWake(state.pausedUntil - Date.now(), "paused");
      return;
    }
    if (state.settings.stopAtBottom && getRemainingScroll(target) <= BOTTOM_THRESHOLD_PIXELS) {
      if (await confirmReachedBottom()) {
        stopAutoScroll("bottom");
        return;
      }
    }
    scheduleWake(state.settings.intervalSeconds * 1000, "waiting");
  }

  /**
   * Infinite feeds (X, 微博, 知乎…) append content right when we hit the bottom.
   * A single "no remaining scroll" reading is therefore not proof, so wait and
   * re-check before declaring the page finished.
   */
  async function confirmReachedBottom() {
    for (let attempt = 0; attempt < BOTTOM_CONFIRM_CHECKS; attempt += 1) {
      await wait(BOTTOM_CONFIRM_DELAY_MS);
      if (!state.running || state.hiddenPause) return false;
      const target = resolveScrollTarget();
      if (!target) continue;
      if (getRemainingScroll(target) > BOTTOM_THRESHOLD_PIXELS) return false;
    }
    return true;
  }

  /**
   * Sticking to one target avoids the loop silently switching to a tiny inner
   * scroller (sidebars, modals) that reports zero remaining distance.
   */
  function resolveScrollTarget() {
    const current = state.target;
    if (current && current.isConnected && getRemainingScroll(current) > BOTTOM_THRESHOLD_PIXELS) {
      return current;
    }
    const next = chooseScrollTarget();
    state.target = next;
    return next;
  }

  function handleCycleError(error) {
    state.consecutiveErrors += 1;
    console.warn("[定时下滑] 滚动出错：", error);
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      stopAutoScroll("error");
      return;
    }
    state.target = null;
    scheduleWake(Math.max(500, state.settings.intervalSeconds * 1000), "waiting");
  }

  function wait(delayMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  function scheduleWake(delayMs, phase) {
    clearTimeout(state.timer);
    const delay = Math.max(0, delayMs);
    state.phase = phase;
    state.nextTickAt = Date.now() + delay;
    state.timer = setTimeout(() => {
      runScrollCycle();
    }, delay);
    updateWidget();
  }

  function pauseForUserInput() {
    if (!state.running || state.hiddenPause) return;
    state.pausedUntil = Date.now() + (settingsApi?.userPauseMs || 2500);
    cancelScrollAnimation();
    scheduleWake(settingsApi?.userPauseMs || 2500, "paused");
  }

  function onKeyDown(event) {
    if (!state.running || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isEditableTarget(event.target)) return;
    const scrollingKeys = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Space"]);
    if (!scrollingKeys.has(event.code)) return;
    pauseForUserInput();
  }

  function onVisibilityChange() {
    if (!state.running) return;
    if (document.hidden) {
      state.hiddenPause = true;
      state.phase = "paused";
      clearTimeout(state.timer);
      cancelScrollAnimation();
      updateWidget();
      return;
    }
    state.hiddenPause = false;
    state.pausedUntil = 0;
    scheduleWake(300, "waiting");
  }

  function chooseScrollTarget() {
    const candidates = [];
    const probeRatios = [0.32, 0.55, 0.75];
    for (const ratio of probeRatios) {
      const found = findScrollableFromPoint(window.innerWidth / 2, window.innerHeight * ratio);
      if (found && !candidates.includes(found)) candidates.push(found);
    }

    const documentTarget = document.scrollingElement || document.documentElement;
    if (documentTarget && !candidates.includes(documentTarget)) candidates.push(documentTarget);

    let bestTarget = documentTarget;
    let bestScore = -1;
    for (const candidate of candidates) {
      const remaining = getRemainingScroll(candidate);
      const area = isDocumentScroller(candidate)
        ? window.innerWidth * window.innerHeight
        : candidate.clientWidth * candidate.clientHeight;
      const score = remaining * Math.max(area, 1);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = candidate;
      }
    }
    return bestTarget || documentTarget;
  }

  function findScrollableFromPoint(x, y) {
    const elements = document.elementsFromPoint(x, y);
    let current = elements.find((element) => !isOwnWidget(element)) || null;
    while (current && current !== document.documentElement && current !== document.body) {
      if (isScrollableElement(current)) return current;
      current = parentAcrossShadow(current);
    }
    return null;
  }

  function isOwnWidget(element) {
    if (!element) return false;
    if (element.id === HOST_ID || element === state.host) return true;
    return Boolean(state.host?.shadowRoot?.contains(element));
  }

  function parentAcrossShadow(element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function isScrollableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.clientHeight < 80 || element.clientWidth < 80) return false;
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") return false;
    return element.scrollHeight - element.clientHeight > 20;
  }

  function isDocumentScroller(element) {
    return element === document.scrollingElement || element === document.documentElement || element === document.body;
  }

  function computeStepDistance(element) {
    if (state.settings.distanceMode === "pixels") return state.settings.distancePixels;
    const viewportHeight = isDocumentScroller(element) ? window.innerHeight : element.clientHeight;
    return viewportHeight * state.settings.viewportRatio;
  }

  function getScrollTop(element) {
    if (isDocumentScroller(element)) return window.scrollY || 0;
    return element.scrollTop;
  }

  function setScrollTop(element, value) {
    if (isDocumentScroller(element)) {
      window.scrollTo({ left: window.scrollX, top: value, behavior: "auto" });
      return;
    }
    element.scrollTop = value;
  }

  function getMaxScrollTop(element) {
    if (isDocumentScroller(element)) {
      const scrollingElement = document.scrollingElement || document.documentElement;
      return Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
    }
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  function getRemainingScroll(element) {
    if (!element) return 0;
    return Math.max(0, getMaxScrollTop(element) - getScrollTop(element));
  }

  function getSmoothDuration(intervalMs) {
    return clamp(intervalMs * SMOOTH_DURATION_RATIO, MIN_SMOOTH_MS, MAX_SMOOTH_MS);
  }

  function animateScroll(element, distance, durationMs) {
    const token = ++state.animationToken;
    const startTop = getScrollTop(element);
    const targetTop = Math.min(getMaxScrollTop(element), startTop + distance);
    const delta = targetTop - startTop;
    if (delta <= 0 || durationMs <= 0) {
      setScrollTop(element, targetTop);
      return Promise.resolve(true);
    }

    const startedAt = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      let watchdog = 0;

      function settle(result) {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        state.animationFrame = 0;
        resolve(result);
      }

      function step(now) {
        if (token !== state.animationToken) {
          settle(false);
          return;
        }
        const progress = Math.min(1, (now - startedAt) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        setScrollTop(element, startTop + delta * eased);
        if (progress < 1) {
          state.animationFrame = requestAnimationFrame(step);
          return;
        }
        settle(true);
      }

      // Backgrounded or occluded tabs freeze requestAnimationFrame, which would
      // otherwise leave this promise pending forever and stall the whole loop.
      watchdog = setTimeout(() => {
        setScrollTop(element, targetTop);
        settle(true);
      }, durationMs + ANIMATION_WATCHDOG_BUFFER_MS);

      state.animationFrame = requestAnimationFrame(step);
    });
  }

  function cancelScrollAnimation() {
    state.animationToken += 1;
    if (state.animationFrame) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = 0;
    }
  }

  function getAutoScrollStatus() {
    const now = Date.now();
    return {
      running: state.running,
      paused: state.running && (state.hiddenPause || now < state.pausedUntil),
      hiddenPause: state.hiddenPause,
      pauseRemainingMs: Math.max(0, state.pausedUntil - now),
      nextTickAt: state.running ? state.nextTickAt : 0,
      scrollCount: state.scrollCount,
      phase: state.running ? state.phase : "idle",
      stopReason: state.stopReason,
      settings: state.settings
    };
  }

  function notifyBackgroundStopped(reason) {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({
        scope: "web-tools",
        tool: "auto-scroll",
        action: "stopped",
        stopReason: reason
      }).catch(() => {});
    } catch (error) {
      // The extension context can disappear after an update or reload.
    }
  }

  function ensureWidget() {
    if (state.host) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.display = "none";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 2147483647;
          width: max-content;
        }

        .orb {
          position: relative;
          width: 84px;
          height: 84px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 6px 20px rgba(16, 24, 40, 0.16);
          font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          user-select: none;
          cursor: grab;
          display: grid;
          place-items: center;
        }
        .orb:active { cursor: grabbing; }

        .ring {
          position: absolute;
          inset: 0;
          width: 84px;
          height: 84px;
          transform: rotate(-90deg);
          pointer-events: none;
        }
        .ring .track {
          fill: none;
          stroke: #e6e8eb;
          stroke-width: 3;
        }
        .ring .value {
          fill: none;
          stroke: #2f6feb;
          stroke-width: 3;
          stroke-linecap: round;
          stroke-dasharray: 1;
          stroke-dashoffset: 1;
          transition: stroke-dashoffset 180ms linear, stroke 160ms ease;
        }

        .core {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1px;
          text-align: center;
          pointer-events: none;
        }

        .countdown {
          color: #1c1f23;
          font-size: 20px;
          font-weight: 600;
          line-height: 1.1;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.01em;
        }

        .caption {
          color: #6b7280;
          font-size: 9.5px;
          line-height: 1.2;
          white-space: nowrap;
        }

        .stop {
          position: absolute;
          top: -2px;
          right: -2px;
          width: 20px;
          height: 20px;
          padding: 0;
          border: 1px solid #e6e8eb;
          border-radius: 50%;
          background: #ffffff;
          color: #9aa1ab;
          font: inherit;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          opacity: 0;
          transform: scale(0.9);
          transition: opacity 140ms ease, transform 140ms ease, color 140ms ease, border-color 140ms ease;
        }
        .orb:hover .stop,
        .stop:focus-visible {
          opacity: 1;
          transform: scale(1);
        }
        .stop:hover { color: #d1453b; border-color: #f3c9c5; background: #fdf3f2; }
        .stop:focus-visible { outline: 2px solid #2f6feb; outline-offset: 1px; }

        :host([data-phase="paused"]) .ring .value { stroke: #d59a1f; }
        :host([data-phase="paused"]) .countdown { color: #a8700c; }
        :host([data-phase="scrolling"]) .ring .value { stroke: #2f6feb; }
        :host([data-phase="finished"]) .ring .value { stroke: #3fa45b; }
        :host([data-phase="finished"]) .countdown { color: #3fa45b; font-size: 15px; }
        :host([data-phase="hidden"]) .ring .value { stroke: #d6dae0; }
        :host([data-phase="hidden"]) .countdown { color: #9aa1ab; }
      </style>
      <div class="orb" role="status" aria-live="off">
        <svg class="ring" viewBox="0 0 84 84" aria-hidden="true">
          <circle class="track" cx="42" cy="42" r="39"></circle>
          <circle class="value" cx="42" cy="42" r="39"></circle>
        </svg>
        <div class="core">
          <span class="countdown"></span>
          <span class="caption"></span>
        </div>
        <button class="stop" type="button" aria-label="停止定时下滑">×</button>
      </div>
    `;

    const orb = shadow.querySelector(".orb");
    state.host = host;
    state.panel = orb;
    state.countdownNode = shadow.querySelector(".countdown");
    state.captionNode = shadow.querySelector(".caption");
    state.ringNode = shadow.querySelector(".ring .value");
    state.stopButton = shadow.querySelector(".stop");
    const radius = Number(state.ringNode.getAttribute("r"));
    state.ringLength = 2 * Math.PI * radius;
    state.ringNode.style.strokeDasharray = String(state.ringLength);

    state.stopButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      stopAutoScroll("manual");
    });

    let dragState = null;
    orb.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = orb.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      orb.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    orb.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const maxLeft = Math.max(8, window.innerWidth - orb.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - orb.offsetHeight - 8);
      state.customPosition = true;
      state.left = clamp(event.clientX - dragState.offsetX, 8, maxLeft);
      state.top = clamp(event.clientY - dragState.offsetY, 8, maxTop);
      positionPanel();
    });
    orb.addEventListener("pointerup", () => {
      dragState = null;
    });
    orb.addEventListener("pointercancel", () => {
      dragState = null;
    });

    document.documentElement.appendChild(host);
  }

  function showWidget() {
    ensureWidget();
    clearTimeout(state.hideTimer);
    state.host.style.display = "block";
    if (state.stopButton) state.stopButton.hidden = false;
    positionPanel();
    ensureWidgetTicker();
    updateWidget();
  }

  function hideWidget() {
    clearTimeout(state.hideTimer);
    clearWidgetTicker();
    if (state.host) state.host.style.display = "none";
  }

  function showFinishedWidget() {
    showWidget();
    clearWidgetTicker();
    if (state.stopButton) state.stopButton.hidden = true;
    updateWidget();
    state.hideTimer = setTimeout(hideWidget, FINISHED_VISIBLE_MS);
  }

  function positionPanel() {
    if (!state.host) return;
    if (!state.customPosition) {
      state.host.style.left = "";
      state.host.style.top = "";
      state.host.style.right = "";
      state.host.style.bottom = "";
      return;
    }
    state.host.style.right = "auto";
    state.host.style.bottom = "auto";
    state.host.style.left = `${state.left}px`;
    state.host.style.top = `${state.top}px`;
  }

  function ensureWidgetTicker() {
    if (state.widgetTimer) return;
    state.widgetTimer = setInterval(updateWidget, 200);
  }

  function clearWidgetTicker() {
    if (!state.widgetTimer) return;
    clearInterval(state.widgetTimer);
    state.widgetTimer = 0;
  }

  function updateWidget() {
    if (!state.countdownNode) return;

    if (!state.running && state.stopReason === "bottom") {
      state.host.dataset.phase = "finished";
      state.countdownNode.textContent = "已到底";
      state.captionNode.textContent = "已停止";
      setWidgetProgress(1);
      return;
    }

    if (!state.running && state.stopReason === "error") {
      state.host.dataset.phase = "paused";
      state.countdownNode.textContent = "中断";
      state.captionNode.textContent = "刷新后重试";
      setWidgetProgress(0);
      return;
    }

    if (state.hiddenPause) {
      state.host.dataset.phase = "hidden";
      state.countdownNode.textContent = "暂停";
      state.captionNode.textContent = "切回后继续";
      setWidgetProgress(0);
      return;
    }

    if (state.phase === "paused") {
      const remainingMs = Math.max(0, state.pausedUntil - Date.now());
      state.host.dataset.phase = "paused";
      state.countdownNode.textContent = formatCountdown(remainingMs);
      state.captionNode.textContent = "手动暂停";
      const pauseMs = settingsApi?.userPauseMs || 2500;
      setWidgetProgress(remainingMs / pauseMs);
      return;
    }

    if (state.phase === "scrolling") {
      state.host.dataset.phase = "scrolling";
      state.countdownNode.textContent = "↓";
      state.captionNode.textContent = `${state.scrollCount} 次`;
      setWidgetProgress(1);
      return;
    }

    const remainingMs = Math.max(0, state.nextTickAt - Date.now());
    const intervalMs = Math.max(1, state.settings.intervalSeconds * 1000);
    state.host.dataset.phase = "waiting";
    state.countdownNode.textContent = formatCountdown(remainingMs);
    state.captionNode.textContent = `${state.scrollCount} 次`;
    setWidgetProgress(remainingMs / intervalMs);
  }

  /**
   * Keeps the orb readable at any interval: decimals for short waits, whole
   * seconds under a minute, and compact minutes above that.
   */
  function formatCountdown(remainingMs) {
    const totalSeconds = Math.max(0, remainingMs) / 1000;
    if (totalSeconds < 10) return totalSeconds.toFixed(1);
    if (totalSeconds < 60) return String(Math.ceil(totalSeconds));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setWidgetProgress(remainingRatio) {
    if (!state.ringNode || !state.ringLength) return;
    // The ring depletes with the countdown: full when a wait starts, empty when
    // the next scroll is due, so ring and number always read the same direction.
    const clampedRatio = clamp(remainingRatio, 0, 1);
    state.ringNode.style.strokeDashoffset = String(state.ringLength * (1 - clampedRatio));
  }

  function normalizeSettings(settings) {
    if (settingsApi) return settingsApi.normalizeAutoScrollSettings(settings);
    return settings;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    const tagName = target.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
    return target.isContentEditable;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
