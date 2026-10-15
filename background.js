const SITES_KEY = 'sites';
const ERRORS_KEY = 'engineErrors';
const BADGE_COLOR = '#18181b';
const BADGE_COLOR_ERROR = '#e5322a';

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.hostname;
  } catch (e) {
    return null;
  }
}

function badgeText(entry) {
  const semitones = entry && typeof entry.pitch === 'number' ? entry.pitch : 0;
  if (semitones === 0) return '';
  return (semitones > 0 ? '+' : '') + String(semitones);
}

function updateBadgeForTab(tabId, url) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  chrome.storage.sync.get([SITES_KEY], (result) => {
    chrome.storage.session.get([ERRORS_KEY], (session) => {
      const hasError = !!(session[ERRORS_KEY] || {})[tabId];
      const entry = (result[SITES_KEY] || {})[hostname];
      chrome.action.setBadgeText({ tabId, text: hasError ? 'ERR' : badgeText(entry) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: hasError ? BADGE_COLOR_ERROR : BADGE_COLOR });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
      }
    });
  });
}

function refreshAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id !== undefined && tab.url) {
        updateBadgeForTab(tab.id, tab.url);
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);
refreshAllTabs();

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (tab && tab.url) updateBadgeForTab(tabId, tab.url);
  });
});

function setTabError(tabId, message) {
  chrome.storage.session.get([ERRORS_KEY], (session) => {
    const errors = session[ERRORS_KEY] || {};
    if (message) errors[tabId] = message;
    else delete errors[tabId];
    chrome.storage.session.set({ [ERRORS_KEY]: errors }, () => {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.url) updateBadgeForTab(tabId, tab.url);
      });
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => setTabError(tabId, null));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url === undefined) setTabError(tabId, null);
  if ((changeInfo.url || changeInfo.status === 'complete') && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[SITES_KEY]) {
    refreshAllTabs();
  }
});

// A cross-origin iframe cannot read its tab's top-level URL; `sender.tab`
// always resolves to the real hosting tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'ENGINE_ERROR' && sender.tab) {
    setTabError(sender.tab.id, message.message || 'Unknown error');
    return;
  }
  if (message && message.type === 'GET_TAB_HOSTNAME') {
    sendResponse({ hostname: hostnameFromUrl(sender.tab && sender.tab.url) });
  }
});
