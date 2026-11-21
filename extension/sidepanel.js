import * as L from './lib.js';

// ───────── tiny DOM helper ─────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const $ = s => document.querySelector(s);
const toast = m => { const t = h('div', {}, m); $('#toast').append(t); setTimeout(() => t.remove(), 2400); };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${~~(s / 60)}m` : s < 86400 ? `${~~(s / 3600)}h` : `${~~(s / 86400)}d`; };
const icon = t => h('img', { src: L.favicon(t.url), alt: '' });
const ab = (label, title, fn, cls = 'btn icon') => h('button', { class: cls, title, onclick: e => { e.stopPropagation(); fn(e); } }, label);
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast('⚠ ' + e.message); } };

// ───────── state ─────────
const state = { view: 'tabs', q: '', selected: new Set(), expanded: new Set(), windowId: null, bmResults: [] };
try { state.view = localStorage.getItem('view') || 'tabs'; } catch {}
state.windowId = (await chrome.windows.getCurrent()).id;

$('#opts').onclick = () => chrome.runtime.openOptionsPage();
$('#web').onclick = async () => { const { server } = await L.getConfig(); server ? chrome.tabs.create({ url: server }) : chrome.runtime.openOptionsPage(); };
$('#sync').onclick = safe(async () => { $('#sync').disabled = true; const r = await L.syncSpaces(); $('#sync').disabled = false; toast(r.offline ? 'Not connected — see settings' : 'Synced'); render(); });
document.querySelectorAll('.seg button').forEach(b => {
  b.onclick = () => { state.view = b.dataset.view; try { localStorage.setItem('view', state.view); } catch {} render(); };
  // dragging a tab over "Stacks"/"Workspaces" switches view so it can be dropped on a card
  b.ondragenter = () => { if (state.view !== b.dataset.view) { state.view = b.dataset.view; render(); } };
});
let bmTimer;
$('#search').oninput = e => {
  state.q = e.target.value.trim().toLowerCase(); render();
  clearTimeout(bmTimer);
  bmTimer = setTimeout(async () => {
    state.bmResults = state.q.length > 1 && await L.isConfigured()
      ? (await L.api('/bookmarks?limit=8&q=' + encodeURIComponent(state.q)).catch(() => ({ items: [] }))).items : [];
    render();
  }, 300);
};
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape') { document.querySelectorAll('.menu').forEach(m => m.remove()); state.selected.clear(); render(); }
});
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach(m => m.remove()));

const match = (...fields) => !state.q || fields.some(f => (f || '').toLowerCase().includes(state.q));

// ───────── render ─────────
let renderQueued = false;
function render() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(async () => { renderQueued = false; await draw(); });
}

async function draw() {
  const [tabs, workspaces, stacks, activeId] = await Promise.all([
    chrome.tabs.query({}), L.listSpaces('workspace'), L.listSpaces('stack'), L.getActiveSpaceId(state.windowId)]);
  const active = workspaces.find(w => w.id === activeId);
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  $('#n-tabs').textContent = tabs.filter(t => t.windowId === state.windowId).length;
  $('#n-spaces').textContent = workspaces.length || '';
  $('#n-stacks').textContent = stacks.length || '';

  $('#current').replaceChildren(...(active
    ? [h('span', { class: 'dot', style: { background: L.COLOR_HEX[active.color] || active.color } }), h('b', { class: 'grow ellipsis' }, active.emoji || '', ' ', active.name),
       h('span', { class: 'muted' }, 'auto-saving'), ab('✕', 'Close workspace (tabs are kept in it)', safe(() => L.closeWorkspace(state.windowId)))]
    : [h('span', { class: 'muted grow' }, 'No workspace in this window'),
       h('button', { class: 'btn small', onclick: safe(newWorkspaceFromWindow) }, '+ Save as workspace')]));

  const view = $('#view');
  const scroll = view.scrollTop;
  if (state.q) view.replaceChildren(...searchView(tabs, workspaces, stacks).filter(Boolean));
  else if (state.view === 'tabs') view.replaceChildren(...tabsView(tabs, stacks).filter(Boolean));
  else if (state.view === 'spaces') view.replaceChildren(...spacesView(workspaces, activeId).filter(Boolean));
  else view.replaceChildren(...stacksView(stacks).filter(Boolean));
  view.scrollTop = scroll;
  drawSelbar(stacks);
}

// ───────── Tabs view ─────────
function tabRow(t, { groupColor } = {}) {
  return h('div', { class: 'tab' + (t.active && t.windowId === state.windowId ? ' active' : '') + (groupColor ? ' grouped' : ''),
    style: groupColor ? { '--gc': groupColor } : null, title: t.url, draggable: true,
    ondragstart: e => e.dataTransfer.setData('text/burrow-tab', String(t.id)),
    onclick: () => { chrome.tabs.update(t.id, { active: true }); chrome.windows.update(t.windowId, { focused: true }); } },
    h('input', { type: 'checkbox', checked: state.selected.has(t.id), onclick: e => {
      e.stopPropagation(); e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id); render(); } }),
    t.pinned ? h('span', { title: 'Pinned' }, '📌') : null,
    icon(t),
    h('div', { class: 't' }, h('div', {}, t.title || t.url), h('div', { class: 'u' }, host(t.url), t.audible ? ' · 🔊' : '', t.discarded ? ' · 💤' : '')),
    h('div', { class: 'acts' },
      ab('🔖', 'Save to Burrow', safe(async () => { await L.saveBookmark(t.url, { title: t.title }); chrome.runtime.sendMessage({ type: 'saved', url: t.url, tabId: t.id }); toast('Saved to Burrow'); })),
      ab('📥', 'Stash into a new stack', safe(async () => { await L.stashTabs([t.id]); toast('Stashed'); })),
      ab('✕', 'Close tab', () => chrome.tabs.remove(t.id))));
}

function windowBlock(winTabs, groups) {
  const out = []; let lastGroup = -1;
  for (const t of winTabs) {
    if (t.groupId > -1 && t.groupId !== lastGroup) {
      const g = groups[t.groupId] || {};
      out.push(h('div', { class: 'group-h' }, h('span', { class: 'bar', style: { background: L.COLOR_HEX[g.color] } }), g.title || 'Group',
        h('span', { class: 'grow' }), ab('📥', 'Stash group', safe(async () => {
          await L.stashTabs(winTabs.filter(x => x.groupId === t.groupId).map(x => x.id), g.title || undefined); toast('Group stashed'); }))));
    }
    lastGroup = t.groupId;
    out.push(tabRow(t, { groupColor: t.groupId > -1 ? L.COLOR_HEX[groups[t.groupId]?.color] : null }));
  }
  return out;
}

let groupsCache = {};
async function refreshGroups() {
  groupsCache = Object.fromEntries((await chrome.tabGroups.query({})).map(g => [g.id, g]));
}

function tabsView(tabs, stacks) {
  const w = state.windowId;
  const mine = tabs.filter(t => t.windowId === w).sort((a, b) => a.index - b.index);
  const others = Object.entries(Object.groupBy(tabs.filter(t => t.windowId !== w), t => t.windowId));
  const tb = (label, title, fn) => h('button', { class: 'btn small', title, onclick: safe(fn) }, label);
  return [
    h('div', { class: 'toolbar' },
      tb('🧹 Dedupe', 'Close duplicate tabs in this window', async () => toast(`Closed ${await L.closeDuplicates(w)} duplicate(s)`)),
      tb('🗂 Group by site', 'Group tabs by website', async () => toast(`Created ${await L.groupByDomain(w)} group(s)`)),
      tb('⊟ Ungroup', 'Remove all tab groups', () => L.ungroupAll(w)),
      tb('⇅ Sort', 'Sort ungrouped tabs by site', () => L.sortByDomain(w)),
      tb('📥 Stash all', 'Move every unpinned tab into a stack', async () => {
        const ids = mine.filter(t => !t.pinned).map(t => t.id); if (!ids.length) return;
        await L.stashTabs(ids); toast(`Stashed ${ids.length} tabs`); }),
      tb('🔖 Save all', 'Save every tab to Burrow', async () => {
        let n = 0; for (const t of mine.filter(t => L.isSavable(t.url))) { const r = await L.saveBookmark(t.url, { title: t.title }).catch(() => null); if (r && !r.duplicate) n++; }
        toast(`Saved ${n} new bookmark(s)`); })),
    h('div', { class: 'section' }, 'This window'),
    ...windowBlock(mine, groupsCache),
    ...others.flatMap(([wid, ts], i) => [
      h('div', { class: 'section' }, `Window ${i + 2}`, h('span', { class: 'grow muted' }, `· ${ts.length} tabs`),
        ab('⤵', 'Move all tabs to this window', safe(() => chrome.tabs.move(ts.map(t => t.id), { windowId: w, index: -1 })))),
      ...windowBlock(ts.sort((a, b) => a.index - b.index), groupsCache)]),
    stacks.length ? h('div', { class: 'muted', style: { padding: '14px 8px', fontSize: '12px' } }, `Tip: drag a tab onto a stack in the Stacks view, or select tabs to stash them together.`) : null,
  ];
}

// ───────── Workspaces view ─────────
function colorMenu(onPick) {
  return h('div', { class: 'colors' }, L.GROUP_COLORS.map(c => h('span', { title: c, style: { background: L.COLOR_HEX[c] }, onclick: () => onPick(c) })));
}
function openMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const m = h('div', { class: 'menu', onclick: e => e.stopPropagation() }, items);
  anchor.closest('.space').style.position = 'relative';
  anchor.closest('.space').append(m);
}

function spaceCard(s, { active, kind }) {
  const open = state.expanded.has(s.id);
  const card = h('section', { class: 'space' + (active ? ' active' : ''),
    ondragover: e => { if (e.dataTransfer.types.includes('text/burrow-tab')) e.preventDefault(); },
    ondrop: safe(async e => {
      const id = +e.dataTransfer.getData('text/burrow-tab'); if (!id) return;
      e.preventDefault();
      const tab = await chrome.tabs.get(id);
      const [cap] = await L.captureTabs([tab]); if (!cap) return;
      await L.putSpace({ id: s.id, tabs: [...s.tabs, cap] });
      if (kind === 'stack') await chrome.tabs.remove(id);
      toast(`Added to ${s.name}`);
    }) });
  const menuBtn = ab('⋯', 'More', e => openMenu(e.target, [
    kind === 'workspace' ? h('button', { onclick: safe(() => L.openWorkspaceInNewWindow(s.id)) }, '🪟 Open in new window') : null,
    kind === 'workspace' && active ? h('button', { onclick: safe(async () => { await L.putSpace({ id: s.id, tabs: await L.captureWindow(state.windowId) }); toast('Updated'); }) }, '💾 Update from this window') : null,
    kind === 'stack' ? h('button', { onclick: safe(() => L.restoreStack(s.id, { keep: true, windowId: state.windowId })) }, '↺ Restore & keep stack') : null,
    kind === 'stack' ? h('button', { onclick: safe(async () => {
      await L.putSpace({ id: s.id, kind: 'workspace', color: 'blue', position: (await L.listSpaces('workspace')).length }); toast('Converted to workspace'); }) }, '⇪ Turn into workspace') : null,
    h('button', { onclick: safe(async () => { const n = prompt('Name', s.name); if (n?.trim()) await L.putSpace({ id: s.id, name: n.trim() }); }) }, '✎ Rename'),
    h('button', { onclick: safe(async () => { const n = prompt('Emoji', s.emoji || ''); if (n !== null) await L.putSpace({ id: s.id, emoji: n.trim().slice(0, 4) }); }) }, '☺ Set emoji'),
    h('button', { onclick: safe(async () => {
      let n = 0; for (const t of s.tabs.filter(t => L.isSavable(t.url))) { const r = await L.saveBookmark(t.url, { title: t.title, tags: [s.name] }).catch(() => null); if (r && !r.duplicate) n++; }
      toast(`Saved ${n} bookmark(s) tagged #${s.name}`); }) }, '🔖 Save tabs to Burrow'),
    colorMenu(c => L.putSpace({ id: s.id, color: c })),
    h('button', { style: { color: 'var(--danger)' }, onclick: safe(async () => { if (confirm(`Delete “${s.name}”?`)) await L.deleteSpace(s.id); }) }, '🗑 Delete'),
  ]));
  card.append(
    h('header', { onclick: safe(async () => {
      if (kind === 'workspace' && !active) await L.switchWorkspace(state.windowId, s.id);
      else { open ? state.expanded.delete(s.id) : state.expanded.add(s.id); render(); }
    }) },
      h('span', { class: 'dot', style: { background: L.COLOR_HEX[s.color] || s.color || 'var(--accent)' } }),
      s.emoji ? h('span', {}, s.emoji) : null,
      h('span', { class: 'name' }, s.name),
      !open ? h('span', { class: 'favs' }, s.tabs.slice(0, 5).map(icon)) : null,
      h('span', { class: 'muted' }, s.tabs.length),
      ab(open ? '▾' : '▸', open ? 'Collapse' : 'Show tabs', () => { open ? state.expanded.delete(s.id) : state.expanded.add(s.id); render(); }),
      menuBtn),
  );
  if (open) card.append(h('div', { class: 'tabs' }, s.tabs.map((t, i) => h('div', { class: 'tab', title: t.url,
    onclick: () => chrome.tabs.create({ url: t.url, windowId: state.windowId }) },
    icon(t), h('div', { class: 't' }, h('div', {}, t.pinned ? '📌 ' : '', t.title || t.url), h('div', { class: 'u' }, host(t.url), t.group?.title ? ` · ${t.group.title}` : '')),
    h('div', { class: 'acts' }, ab('✕', 'Remove from ' + kind, safe(() => L.removeTabFromSpace(s.id, i))))))),
    kind === 'stack' ? h('div', { class: 'foot' }, h('span', { class: 'muted grow' }, `stashed ${ago(s.updated_at)}${ago(s.updated_at) === 'just now' ? '' : ' ago'}`)) : null);
  return card;
}

function spacesView(workspaces, activeId) {
  return [
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn small primary', onclick: safe(newWorkspaceFromWindow) }, '+ From this window'),
      h('button', { class: 'btn small', onclick: safe(async () => {
        const name = prompt('Workspace name'); if (!name?.trim()) return;
        const s = await L.putSpace({ id: L.uid(), kind: 'workspace', name: name.trim(), color: L.GROUP_COLORS[workspaces.length % 9], tabs: [], position: workspaces.length, deleted: false });
        await L.switchWorkspace(state.windowId, s.id);
      }) }, '+ Empty workspace')),
    workspaces.length ? null : h('div', { class: 'empty' }, h('div', { class: 'big' }, '🗂'),
      h('p', {}, 'Workspaces are named sets of tabs. Switching swaps this window’s tabs, and changes auto-save.')),
    ...workspaces.map(s => spaceCard(s, { active: s.id === activeId, kind: 'workspace' })),
  ];
}

function stacksView(stacks) {
  return [
    h('div', { class: 'toolbar' }, stacks.length ? h('span', { class: 'muted' }, 'Click a stack to peek. Drag tabs from the Tabs view onto a stack.') : null),
    stacks.length ? null : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📥'),
      h('p', {}, 'Stacks are tabs you’ve put aside. Stash a tab, a group, or a whole window to free memory and restore it later.')),
    ...stacks.map(s => {
      const c = spaceCard(s, { kind: 'stack' });
      c.querySelector('header').append(ab('↺', 'Restore tabs', safe(() => L.restoreStack(s.id, { windowId: state.windowId })), 'btn small'));
      return c;
    }),
  ];
}

// ───────── search across everything ─────────
function searchView(tabs, workspaces, stacks) {
  const t = tabs.filter(x => match(x.title, x.url));
  const sp = [...workspaces, ...stacks].flatMap(s => s.tabs.filter(x => match(x.title, x.url)).map(x => ({ ...x, space: s })));
  const named = [...workspaces, ...stacks].filter(s => match(s.name));
  const out = [];
  if (named.length) out.push(h('div', { class: 'section' }, 'Spaces'), ...named.map(s => spaceCard(s, { kind: s.kind })));
  if (t.length) out.push(h('div', { class: 'section' }, `Open tabs (${t.length})`), ...t.map(x => tabRow(x)));
  if (sp.length) out.push(h('div', { class: 'section' }, `In workspaces & stacks (${sp.length})`), ...sp.slice(0, 50).map(x =>
    h('div', { class: 'tab', title: x.url, onclick: () => chrome.tabs.create({ url: x.url, windowId: state.windowId }) },
      icon(x), h('div', { class: 't' }, h('div', {}, x.title), h('div', { class: 'u' }, `${x.space.kind === 'stack' ? '📥' : '🗂'} ${x.space.name} · ${host(x.url)}`)))));
  if (state.bmResults.length) out.push(h('div', { class: 'section' }, 'Burrow bookmarks'), ...state.bmResults.map(b =>
    h('div', { class: 'result-bm', title: b.url || '', onclick: async () => {
      if (b.url) chrome.tabs.create({ url: b.url, windowId: state.windowId });
      else { const { server } = await L.getConfig(); chrome.tabs.create({ url: server + '/#/notes' }); } } },
      b.url ? icon(b) : h('span', {}, '📝'), h('div', { class: 't grow' }, h('div', { class: 'ellipsis' }, b.title || b.url),
        h('div', { class: 'ellipsis muted', style: { fontSize: '11px' } }, b.tags.map(t => '#' + t.name).join(' ') || host(b.url))))));
  if (!out.length) out.push(h('div', { class: 'empty' }, 'No matches'));
  return out;
}

// ───────── selection bar ─────────
function drawSelbar(stacks) {
  const bar = $('#selbar');
  // drop ids of tabs that no longer exist
  if (!state.selected.size) { bar.hidden = true; return; }
  const ids = [...state.selected];
  const into = h('select', { class: 'input', onchange: safe(async e => {
    const target = e.target.value; e.target.value = '';
    if (target === '__new') await L.stashTabs(ids);
    else {
      const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
      const s = stacks.find(x => x.id === target);
      await L.putSpace({ id: target, tabs: [...s.tabs, ...(await L.captureTabs(tabs))] });
      await chrome.tabs.remove(ids);
    }
    state.selected.clear(); toast('Stashed'); render();
  }) }, h('option', { value: '', disabled: true, selected: true }, '📥 Stash into…'), h('option', { value: '__new' }, '+ New stack'),
    stacks.map(s => h('option', { value: s.id }, s.name)));
  bar.replaceChildren(h('b', {}, `${ids.length} selected`), into,
    h('button', { class: 'btn small', onclick: safe(async () => {
      const name = prompt('New workspace name'); if (!name?.trim()) return;
      const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
      const ws = await L.listSpaces('workspace');
      await L.putSpace({ id: L.uid(), kind: 'workspace', name: name.trim(), color: L.GROUP_COLORS[ws.length % 9], tabs: await L.captureTabs(tabs), position: ws.length, deleted: false });
      state.selected.clear(); toast('Workspace created'); render();
    }) }, '🗂 New workspace'),
    h('button', { class: 'btn small', onclick: safe(async () => {
      const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: state.windowId } });
      const title = prompt('Group name', host(tabs[0].url)); if (title !== null) await chrome.tabGroups.update(gid, { title });
      state.selected.clear(); render();
    }) }, '⊞ Group'),
    h('button', { class: 'btn small', onclick: safe(async () => {
      for (const id of ids) { const t = await chrome.tabs.get(id); if (L.isSavable(t.url)) await L.saveBookmark(t.url, { title: t.title }); }
      state.selected.clear(); toast('Saved to Burrow'); render();
    }) }, '🔖 Save'),
    h('button', { class: 'btn small danger', onclick: safe(async () => { await chrome.tabs.remove(ids); state.selected.clear(); render(); }) }, 'Close'),
    h('button', { class: 'btn icon', onclick: () => { state.selected.clear(); render(); } }, '✕'));
  bar.hidden = false;
}

async function newWorkspaceFromWindow() {
  const tabs = await chrome.tabs.query({ windowId: state.windowId, active: true });
  const name = prompt('Name this workspace', host(tabs[0]?.url || '') || 'My workspace');
  if (!name?.trim()) return;
  await L.createWorkspaceFromWindow(state.windowId, name.trim());
  state.view = 'spaces'; toast('Workspace created — changes now auto-save'); render();
}

// ───────── live updates ─────────
const rerender = async () => { await refreshGroups(); render(); };
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onAttached', 'onDetached']) {
  chrome.tabs[ev].addListener((id) => {
    if (ev === 'onRemoved') state.selected.delete(id);
    rerender();
  });
}
for (const ev of ['onCreated', 'onUpdated', 'onRemoved']) chrome.tabGroups[ev].addListener(rerender);
chrome.storage.onChanged.addListener(rerender);

await refreshGroups();
render();
L.syncSpaces().catch(() => {});
