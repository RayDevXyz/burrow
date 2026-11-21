// Shared logic for the Burrow extension: server API, tab spaces, tab utilities.

// ───────── config & API ─────────
export async function getConfig() {
  const { server = '', token = '' } = await chrome.storage.sync.get(['server', 'token']);
  return { server: server.replace(/\/+$/, ''), token };
}
export async function isConfigured() { const c = await getConfig(); return !!(c.server && c.token); }

export async function api(path, { method = 'GET', body } = {}) {
  const { server, token } = await getConfig();
  if (!server || !token) throw new Error('Not connected — open the extension options');
  const r = await fetch(server + '/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const saveBookmark = (url, extra = {}) => api('/bookmarks', { method: 'POST', body: { url, ...extra } });
export const lookup = url => api('/bookmarks/lookup?url=' + encodeURIComponent(url));
export const isSavable = url => /^https?:\/\//i.test(url || '');

// ───────── tab capture ─────────
export const uid = () => crypto.randomUUID();
export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];
export const COLOR_HEX = { grey: '#8c8c8c', blue: '#4c8bf5', red: '#e8453c', yellow: '#f5b400', green: '#34a853',
  pink: '#f06292', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' };

const skip = url => !url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(url) && !/^chrome:\/\/newtab/i.test(url);

export async function captureTabs(tabs) {
  const groups = {};
  for (const id of new Set(tabs.map(t => t.groupId).filter(g => g > -1))) {
    try { const g = await chrome.tabGroups.get(id); groups[id] = { title: g.title || '', color: g.color }; } catch {}
  }
  return tabs.filter(t => !skip(t.url || t.pendingUrl)).map(t => ({
    url: t.url || t.pendingUrl, title: t.title || t.url, favIconUrl: t.favIconUrl || '',
    pinned: !!t.pinned, group: groups[t.groupId] || null,
  }));
}
export async function captureWindow(windowId) {
  return captureTabs(await chrome.tabs.query({ windowId }));
}

/** Open saved tabs into a window, restoring pins and tab groups. Returns created tab ids. */
export async function openTabs(windowId, tabs, { active = true } = {}) {
  const created = []; const groupMap = new Map();
  for (const [i, t] of tabs.entries()) {
    const tab = await chrome.tabs.create({ windowId, url: t.url, pinned: t.pinned, active: active && i === 0 });
    created.push(tab.id);
    if (t.group && !t.pinned) {
      const key = t.group.title + '|' + t.group.color;
      (groupMap.get(key) || groupMap.set(key, { ...t.group, ids: [] }).get(key)).ids.push(tab.id);
    }
  }
  for (const g of groupMap.values()) {
    const gid = await chrome.tabs.group({ tabIds: g.ids, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: false });
  }
  return created;
}

// ───────── spaces store (workspaces + stacks) ─────────
// Stored in chrome.storage.local as { spaces: {id: space}, lastSync }.
// Window → active workspace mapping lives in storage.session (window ids are per-session).
export async function getSpaces() {
  const { spaces = {} } = await chrome.storage.local.get('spaces');
  return spaces;
}
export async function listSpaces(kind) {
  return Object.values(await getSpaces()).filter(s => !s.deleted && (!kind || s.kind === kind))
    .sort((a, b) => (a.position - b.position) || (b.updated_at - a.updated_at));
}
export async function putSpace(space) {
  const spaces = await getSpaces();
  spaces[space.id] = { ...spaces[space.id], ...space, updated_at: Date.now(), dirty: true };
  await chrome.storage.local.set({ spaces });
  scheduleSync();
  return spaces[space.id];
}
export async function deleteSpace(id) {
  const spaces = await getSpaces();
  if (!spaces[id]) return;
  spaces[id] = { ...spaces[id], deleted: true, tabs: [], updated_at: Date.now(), dirty: true };
  await chrome.storage.local.set({ spaces });
  const map = await getActiveMap();
  for (const [w, sid] of Object.entries(map)) if (sid === id) delete map[w];
  await chrome.storage.session.set({ active: map });
  scheduleSync();
}

export async function getActiveMap() { const { active = {} } = await chrome.storage.session.get('active'); return active; }
export async function getActiveSpaceId(windowId) { return (await getActiveMap())[windowId] || null; }
export async function setActiveSpace(windowId, spaceId) {
  const map = await getActiveMap();
  for (const [w, sid] of Object.entries(map)) if (sid === spaceId) delete map[w]; // one window per space
  if (spaceId) map[windowId] = spaceId; else delete map[windowId];
  await chrome.storage.session.set({ active: map });
}

// ───────── sync with server (last-write-wins per space) ─────────
let syncTimer;
export function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncSpaces().catch(() => {}), ms); }

export async function syncSpaces() {
  if (!(await isConfigured())) return { offline: true };
  const local = await getSpaces();
  const dirty = Object.values(local).filter(s => s.dirty).map(({ dirty, ...s }) => s);
  const { spaces: remote } = await api('/spaces/sync', { method: 'POST', body: { spaces: dirty } });
  const merged = { ...local };
  for (const r of remote) {
    const l = merged[r.id];
    if (!l || (!l.dirty && r.updated_at >= l.updated_at) || r.updated_at > l.updated_at) merged[r.id] = { ...r, dirty: false };
  }
  for (const s of dirty) if (merged[s.id] && merged[s.id].updated_at === s.updated_at) merged[s.id].dirty = false;
  // Drop local tombstones the server has already forgotten about
  const remoteIds = new Set(remote.map(r => r.id));
  for (const [id, s] of Object.entries(merged)) if (s.deleted && !s.dirty && !remoteIds.has(id)) delete merged[id];
  await chrome.storage.local.set({ spaces: merged, lastSync: Date.now() });
  return { ok: true };
}

// ───────── workspace operations ─────────
export async function createWorkspaceFromWindow(windowId, name, color) {
  const tabs = await captureWindow(windowId);
  const all = await listSpaces('workspace');
  const space = await putSpace({ id: uid(), kind: 'workspace', name, color: color || GROUP_COLORS[all.length % GROUP_COLORS.length],
    tabs, position: all.length, deleted: false });
  await setActiveSpace(windowId, space.id);
  return space;
}

export async function saveActiveWorkspace(windowId) {
  const id = await getActiveSpaceId(windowId);
  if (!id) return;
  const spaces = await getSpaces();
  if (!spaces[id] || spaces[id].deleted) return setActiveSpace(windowId, null);
  const tabs = await captureWindow(windowId);
  if (JSON.stringify(tabs) === JSON.stringify(spaces[id].tabs)) return;
  await putSpace({ id, tabs });
}

/** Workona-style switch: save current workspace, replace this window's tabs with the target's. */
export async function switchWorkspace(windowId, spaceId) {
  await saveActiveWorkspace(windowId);
  const space = (await getSpaces())[spaceId];
  if (!space) return;
  const map = await getActiveMap();
  const otherWindow = Object.entries(map).find(([w, sid]) => sid === spaceId && +w !== windowId);
  if (otherWindow) { // already open elsewhere → just focus it
    try { await chrome.windows.update(+otherWindow[0], { focused: true }); return; } catch { /* window gone */ }
  }
  const old = await chrome.tabs.query({ windowId });
  await setActiveSpace(windowId, spaceId); // set first so tab events don't save into the wrong space
  if (space.tabs.length) await openTabs(windowId, space.tabs);
  else await chrome.tabs.create({ windowId });
  await chrome.tabs.remove(old.map(t => t.id));
}

export async function openWorkspaceInNewWindow(spaceId) {
  const space = (await getSpaces())[spaceId];
  const win = await chrome.windows.create({ focused: true });
  await setActiveSpace(win.id, spaceId);
  const blank = (await chrome.tabs.query({ windowId: win.id })).map(t => t.id);
  if (space.tabs.length) { await openTabs(win.id, space.tabs); await chrome.tabs.remove(blank); }
}

export async function closeWorkspace(windowId) {
  await saveActiveWorkspace(windowId);
  await setActiveSpace(windowId, null);
  const old = await chrome.tabs.query({ windowId });
  await chrome.tabs.create({ windowId });
  await chrome.tabs.remove(old.map(t => t.id));
}

// ───────── stacks (stash tabs to restore later) ─────────
export async function stashTabs(tabIds, name) {
  const tabs = await Promise.all(tabIds.map(id => chrome.tabs.get(id)));
  const captured = await captureTabs(tabs);
  if (!captured.length) throw new Error('Nothing to stash');
  const label = name || `${captured.length} tab${captured.length > 1 ? 's' : ''} · ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const stack = await putSpace({ id: uid(), kind: 'stack', name: label, color: 'purple', tabs: captured, position: 0, deleted: false });
  // keep the window alive if we are closing every tab in it
  const windowId = tabs[0].windowId;
  const remaining = await chrome.tabs.query({ windowId });
  if (remaining.every(t => tabIds.includes(t.id))) await chrome.tabs.create({ windowId });
  await chrome.tabs.remove(tabIds);
  return stack;
}

export async function restoreStack(stackId, { keep = false, windowId } = {}) {
  const stack = (await getSpaces())[stackId];
  if (!stack) return;
  const win = windowId ?? (await chrome.windows.getLastFocused()).id;
  await openTabs(win, stack.tabs);
  if (!keep) await deleteSpace(stackId);
}

export async function removeTabFromSpace(spaceId, index) {
  const s = (await getSpaces())[spaceId];
  const tabs = s.tabs.slice(); tabs.splice(index, 1);
  if (!tabs.length && s.kind === 'stack') return deleteSpace(spaceId);
  await putSpace({ id: spaceId, tabs });
}

// ───────── tab hygiene ─────────
// Keep the #fragment: single-page apps use it for routing (app/#/inbox vs app/#/settings).
const normUrl = u => { try { const x = new URL(u); if (x.hash === '#') x.hash = ''; return x.href; } catch { return u; } };
const domain = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export async function closeDuplicates(windowId) {
  const tabs = await chrome.tabs.query(windowId ? { windowId } : {});
  const seen = new Map(); const dupes = [];
  for (const t of tabs) {
    const k = normUrl(t.url);
    if (seen.has(k)) dupes.push(t.active ? seen.get(k) : t.id); else seen.set(k, t.id);
  }
  if (dupes.length) await chrome.tabs.remove(dupes);
  return dupes.length;
}

export async function groupByDomain(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned);
  const by = {};
  for (const t of tabs) (by[domain(t.url)] ||= []).push(t.id);
  let n = 0, c = 0;
  for (const [d, ids] of Object.entries(by)) {
    if (!d || ids.length < 2) continue;
    const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title: d.split('.').slice(-2, -1)[0] || d, color: GROUP_COLORS[c++ % GROUP_COLORS.length] });
    n++;
  }
  return n;
}

export async function ungroupAll(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(t => t.groupId > -1);
  if (tabs.length) await chrome.tabs.ungroup(tabs.map(t => t.id));
}

export async function sortByDomain(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(t => !t.pinned && t.groupId === -1);
  const pinned = (await chrome.tabs.query({ windowId, pinned: true })).length;
  const grouped = (await chrome.tabs.query({ windowId })).filter(t => t.groupId > -1).length;
  tabs.sort((a, b) => domain(a.url).localeCompare(domain(b.url)) || (a.title || '').localeCompare(b.title || ''));
  for (const [i, t] of tabs.entries()) await chrome.tabs.move(t.id, { index: pinned + grouped + i });
}

export function favicon(url, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url); u.searchParams.set('size', String(size));
  return u.toString();
}
