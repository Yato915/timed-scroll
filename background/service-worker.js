"use strict";

importScripts("../shared/settings.js");

const settingsApi = globalThis.WebToolsSettings;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.scope !== "web-tools" || message.tool !== "auto-scroll") return;

  handleAutoScrollMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({ ok: false, error: toUserError(error) });
    });
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-auto-scroll") return;
  toggleAutoScrollOnActiveTab().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const cleared = chrome.action.setBadgeText({ tabId, text: "" });
  if (cleared?.catch) cleared.catch(() => {});
});

async function handleAutoScrollMessage(message, sender) {
  if (message.action === "stopped") {
    if (sender.tab?.id) await syncBadge(sender.tab.id, { running: false });
    return { ok: true };
  }

  // The popup polls from its own tab; messages carrying a tabId must target that
  // tab instead of whatever happens to be active, otherwise switching tabs makes
  // a running scroll look stopped.
  const tab = await resolveTargetTab(message, sender);
  if (settingsApi.isUnsupportedPageUrl(tab.url)) {
    return { ok: false, error: "这个页面不允许插件运行，请换一个普通网页再试。" };
  }

  if (message.action === "status") {
    const result = await readStatus(tab.id);
    await syncBadge(tab.id, result.status);
    return result;
  }

  if (message.action === "start") {
    const settings = await saveSettings(message.settings);
    await ensureContentScript(tab.id);
    const result = await sendToContent(tab.id, "start", settings);
    if (result.ok) await syncBadge(tab.id, result.status);
    return result;
  }

  if (message.action === "update") {
    const settings = await saveSettings(message.settings);
    await ensureContentScript(tab.id);
    const result = await sendToContent(tab.id, "update", settings);
    if (result.ok) await syncBadge(tab.id, result.status);
    return result;
  }

  if (message.action === "stop") {
    const result = await sendToContent(tab.id, "stop");
    if (!result.ok && result.disconnected) {
      await syncBadge(tab.id, { running: false });
      return { ok: true, status: idleStatus() };
    }
    if (result.ok) await syncBadge(tab.id, result.status);
    return result;
  }

  return { ok: false, error: "不认识这个操作。" };
}

async function toggleAutoScrollOnActiveTab() {
  const tab = await getActiveTab();
  if (settingsApi.isUnsupportedPageUrl(tab.url)) return;

  const current = await readStatus(tab.id);
  if (current.status?.running) {
    const result = await sendToContent(tab.id, "stop");
    await syncBadge(tab.id, result.ok ? result.status : { running: false });
    return;
  }

  const settings = await readStoredSettings();
  await ensureContentScript(tab.id);
  const result = await sendToContent(tab.id, "start", settings);
  if (result.ok) await syncBadge(tab.id, result.status);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }
  return tab;
}

/**
 * A message sent from the popup carries the popup's own tab, which is the page
 * the user is configuring. Fall back to the active tab for keyboard shortcuts.
 */
async function resolveTargetTab(message, sender) {
  const explicitTabId = Number(message?.tabId);
  if (Number.isInteger(explicitTabId) && explicitTabId > 0) {
    try {
      const tab = await chrome.tabs.get(explicitTabId);
      if (tab?.id) return tab;
    } catch (error) {
      // Tab closed in the meantime; fall through to the active tab.
    }
  }
  if (sender?.tab?.id) return sender.tab;
  return getActiveTab();
}

async function readStoredSettings() {
  const stored = await chrome.storage.local.get(settingsApi.storageKey);
  return settingsApi.normalizeAutoScrollSettings(stored[settingsApi.storageKey]);
}

async function saveSettings(settings) {
  const normalized = settingsApi.normalizeAutoScrollSettings(settings);
  await chrome.storage.local.set({ [settingsApi.storageKey]: normalized });
  return normalized;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["shared/settings.js", "content/auto-scroll.js"]
    });
  } catch (error) {
    throw new Error(toUserError(error));
  }
}

async function readStatus(tabId) {
  const result = await sendToContent(tabId, "status");
  if (result.ok) return result;
  if (result.disconnected) return { ok: true, status: idleStatus() };
  return result;
}

async function sendToContent(tabId, action, settings) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      scope: "web-tools",
      tool: "auto-scroll",
      action,
      settings
    });
    if (!response) return { ok: false, error: "页面没有响应，请刷新后再试。" };
    return response;
  } catch (error) {
    const disconnected = /receiving end does not exist|could not establish connection/i.test(String(error?.message || error));
    return {
      ok: false,
      disconnected,
      error: disconnected ? "页面里还没有滚动脚本。" : toUserError(error)
    };
  }
}

function idleStatus() {
  return {
    running: false,
    paused: false,
    hiddenPause: false,
    pauseRemainingMs: 0,
    nextTickAt: 0,
    scrollCount: 0,
    phase: "idle",
    stopReason: null,
    settings: settingsApi.defaults
  };
}

async function syncBadge(tabId, status) {
  if (status?.running) {
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: "#2A2112" });
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#E6A23C" });
    await chrome.action.setBadgeText({ tabId, text: "下滑" });
    return;
  }
  await chrome.action.setBadgeText({ tabId, text: "" });
}

function toUserError(error) {
  const message = String(error?.message || error || "");
  if (/这个页面不允许插件运行|请换一个普通网页|找不到当前标签页|页面没有响应/.test(message)) {
    return message;
  }
  if (/cannot access|cannot be scripted|extensions gallery|error page|The extensions gallery/i.test(message)) {
    return "这个页面不允许插件运行，请换一个普通网页再试。";
  }
  if (/No tab with id/i.test(message)) return "找不到当前标签页。";
  return "操作没有成功，请刷新页面后再试。";
}
