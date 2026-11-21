import {
  api, saveBookmark, lookup, isSavable, isConfigured, stashTabs, saveActiveWorkspace, syncSpaces,
  setActiveSpace, scheduleSync,
} from './lib.js';

// ───────── setup ─────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-page', title: 'Save page to Burrow', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'save-link', title: 'Save link to Burrow', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'save-selection', title: 'Save selection as note', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'stash-tab', title: 'Stash this tab', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'stash-window', title: 'Stash all tabs in this window', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'open-panel', title: 'Open tab manager', contexts: ['action'] });
  });
  chrome.alarms.create('sync', { periodInMinutes: 5 });
  if (reason === 'install' && !(await isConfigured())) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 5 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') syncSpaces().catch(() => {}); });

// ───────── badge: show ✓ when the current page is already saved ─────────
const savedCache = new Map(); // url -> boolean
async function updateBadge(tabId, url) {
  if (!isSavable(url) || !(await isConfigured())) return chrome.action.setBadgeText({ tabId, text: '' });
  let saved = savedCache.get(url);
  if (saved === undefined) {
    try { saved = !!(await lookup(url)); } catch { return; }
    savedCache.set(url, saved);
    if (savedCache.size > 500) savedCache.delete(savedCache.keys().next().value);
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c5cff' });
  chrome.action.setBadgeText({ tabId, text: saved ? '✓' : '' });
}

async function notify(tabId, text, ok = true) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#30a46c' : '#e5484d' });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.tabs.get(tabId).then(t => updateBadge(tabId, t.url)).catch(() => {}), 2500);
}

async function quickSave(tab, url = tab.url, extra = {}) {
  try {
    await saveBookmark(url, { title: url === tab.url ? tab.title : undefined, ...extra });
    savedCache.set(url, true);
    notify(tab.id, '✓');
  } catch (e) { console.warn(e); notify(tab.id, '!', false); }
}

// ───────── context menu & commands ─────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case 'save-page': return quickSave(tab);
    case 'save-link': return quickSave(tab, info.linkUrl, { title: undefined });
    case 'save-selection':
      try {
        await api('/bookmarks', { method: 'POST', body: {
          note: `${info.selectionText}\n\n— ${tab.title}\n${tab.url}`, title: (tab.title || 'Quote').slice(0, 120) } });
        notify(tab.id, '✓');
      } catch { notify(tab.id, '!', false); }
      return;
    case 'stash-tab': return stashTabs([tab.id]).catch(console.warn);
    case 'stash-window': {
      const tabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: false });
      return stashTabs(tabs.map(t => t.id)).catch(console.warn);
    }
    case 'open-panel': return chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  tab ||= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return;
  if (cmd === 'save-page') quickSave(tab);
  if (cmd === 'open-panel') chrome.sidePanel.open({ windowId: tab.windowId });
  if (cmd === 'stash-tab') stashTabs([tab.id]).catch(console.warn);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'saved') { savedCache.set(msg.url, true); updateBadge(msg.tabId, msg.url); }
  if (msg?.type === 'sync') { syncSpaces().then(r => reply(r), e => reply({ error: e.message })); return true; }
});

// ───────── auto-save the active workspace as tabs change ─────────
const pending = new Map();
function touch(windowId) {
  if (windowId == null || windowId < 0) return;
  clearTimeout(pending.get(windowId));
  pending.set(windowId, setTimeout(() => { pending.delete(windowId); saveActiveWorkspace(windowId).catch(() => {}); }, 1200));
}
chrome.tabs.onCreated.addListener(t => touch(t.windowId));
chrome.tabs.onRemoved.addListener((_, info) => { if (!info.isWindowClosing) touch(info.windowId); });
chrome.tabs.onMoved.addListener((_, info) => touch(info.windowId));
chrome.tabs.onAttached.addListener((_, info) => touch(info.newWindowId));
chrome.tabs.onDetached.addListener((_, info) => touch(info.oldWindowId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.pinned !== undefined || change.groupId !== undefined || change.status === 'complete') touch(tab.windowId);
  if (change.status === 'complete' && tab.active) updateBadge(tabId, tab.url);
});
chrome.tabGroups.onUpdated.addListener(g => touch(g.windowId));
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t) updateBadge(tabId, t.url);
});
// Closing a window keeps its workspace saved — it just becomes inactive.
chrome.windows.onRemoved.addListener(windowId => setActiveSpace(windowId, null));

scheduleSync(3000);
