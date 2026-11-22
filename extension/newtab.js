// Burrow New Tab / startup page: clock, search (Burrow + web), favorites,
// workspaces, stacks and recent bookmarks, styled with the Burrow global theme.
import * as L from './lib.js';

const $ = id => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c.nodeType ? c : String(c));
  return el;
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const ago = s => { const d = Date.now() / 1000 - s; return d < 3600 ? `${Math.max(1, ~~(d / 60))}m` : d < 86400 ? `${~~(d / 3600)}h` : `${~~(d / 86400)}d`; };
const icon = url => h('img', { src: L.favicon(url), alt: '' });

// ───────── settings (stored in Chrome sync) ─────────
const DEFAULTS = { favorites: true, workspaces: true, stacks: true, recent: true, clock24: !/[ap]m/i.test(new Date().toLocaleTimeString()), useTheme: true };
let prefs = { ...DEFAULTS, ...(await chrome.storage.sync.get('newtab')).newtab };
const savePrefs = () => chrome.storage.sync.set({ newtab: prefs });

// ───────── theme (from the Burrow server, cached for an instant first paint) ─────────
const GRADIENTS = {
  aurora: 'linear-gradient(135deg, #7c5cff 0%, #2dd4bf 100%)', sunset: 'linear-gradient(135deg, #f97316 0%, #db2777 55%, #7c3aed 100%)',
  ocean: 'linear-gradient(135deg, #0ea5e9 0%, #1e3a8a 100%)', forest: 'linear-gradient(135deg, #16a34a 0%, #064e3b 100%)',
  peach: 'linear-gradient(135deg, #fed7aa 0%, #fda4af 100%)', night: 'linear-gradient(135deg, #0f172a 0%, #312e81 60%, #581c87 100%)',
  candy: 'linear-gradient(135deg, #f0abfc 0%, #93c5fd 100%)', slate: 'linear-gradient(135deg, #64748b 0%, #1e293b 100%)',
};
let bgObjectUrl = null;
async function applyTheme(t, bgUrl) {
  const root = document.documentElement;
  const mode = t?.mode && t.mode !== 'auto' ? t.mode : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = mode;
  root.style.setProperty('--accent', t?.accent || '#7c5cff');
  const bg = t?.bg || {};
  const img = $('bg').querySelector('.img');
  const on = prefs.useTheme && ((bg.type === 'image' && (bgUrl || bg.image)) || bg.type === 'gradient');
  document.body.classList.toggle('has-bg', !!on);
  img.style.backgroundImage = !on ? 'none' : bg.type === 'gradient' ? GRADIENTS[bg.gradient] || GRADIENTS.aurora : `url("${String(bgUrl || bg.image).replace(/["\\]/g, '')}")`;
  img.style.backgroundPosition = bg.position || 'center';
  img.style.filter = bg.blur ? `blur(${bg.blur}px)` : 'none';
  $('bg').querySelector('.dim').style.opacity = on ? (bg.dim ?? 30) / 100 : 0;
}

/** Background images uploaded to Burrow need the API token, so load them as a blob and cache a data URL. */
async function themeImage(theme) {
  const src = theme?.bg?.type === 'image' ? theme.bg.image : null;
  if (!src || !src.startsWith('/api/')) return src;
  const { server, token } = await L.getConfig();
  const cached = (await chrome.storage.local.get('ntBg')).ntBg;
  if (cached?.src === src) return cached.data;
  const r = await fetch(server + src, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const blob = await r.blob();
  const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  if (data.length < 4.5e6) chrome.storage.local.set({ ntBg: { src, data } }); // keep within storage quota
  return data;
}

// ───────── clock & greeting ─────────
let username = '';
function tick() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString([], { hour: prefs.clock24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !prefs.clock24 });
  const hr = d.getHours();
  const part = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('greet').textContent = `${part}${username ? ', ' + username : ''} · ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`;
}
tick(); setInterval(tick, 1000 * 15);

// ───────── data: cache first, then refresh from the server ─────────
let data = (await chrome.storage.local.get('ntCache')).ntCache || { favorites: [], recent: [], theme: null, username: '' };
async function refresh() {
  if (!(await L.isConfigured())) {
    $('notice').replaceChildren(h('div', { class: 'notice glassy', style: { display: 'inline-block' } }, 'Connect Burrow to see your bookmarks here. ',
      h('button', { class: 'btn small primary', onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings')));
    return;
  }
  try {
    const [me, fav, rec] = await Promise.all([L.api('/me'), L.api('/bookmarks?favorite=1&limit=24'), L.api('/bookmarks?limit=8')]);
    data = { favorites: fav.items.map(slim), recent: rec.items.map(slim), theme: me.theme, username: me.username };
    chrome.storage.local.set({ ntCache: data });
    $('notice').replaceChildren();
    L.syncSpaces().catch(() => {});
  } catch (e) {
    $('notice').replaceChildren(h('div', { class: 'muted' }, '⚠ ', e.message));
  }
  render();
  applyTheme(data.theme, await themeImage(data.theme).catch(() => null));
}
const slim = b => ({ id: b.id, url: b.url, title: b.title, type: b.type, favicon: b.favicon, created_at: b.created_at, note: b.note ? b.note.slice(0, 120) : '' });

// ───────── sections ─────────
async function render() {
  username = data.username; tick();
  const { server } = await L.getConfig();
  $('web').href = server || '#';
  const show = (id, on) => { $('sec-' + id).hidden = !on; };

  show('favorites', prefs.favorites && data.favorites.length);
  $('favorites').replaceChildren(...data.favorites.map(b => h('a', { class: 'nt-tile', href: b.url || `${server}/#/notes`, title: b.title || b.url },
    h('div', { class: 'fi' }, b.url ? icon(b.url) : '📝'), h('span', {}, b.title || host(b.url)))));

  show('recent', prefs.recent && data.recent.length);
  $('recent').replaceChildren(...data.recent.map(b => h('a', { class: 'nt-row', href: b.url || `${server}/#/notes` },
    b.url ? icon(b.url) : h('span', { class: 'ico' }, '📝'), h('span', { class: 't' }, b.title || b.url || b.note), h('span', { class: 'when' }, ago(b.created_at)))));

  const win = (await chrome.windows.getCurrent()).id;
  const activeId = await L.getActiveSpaceId(win);
  const card = (s, kind) => h('div', { class: 'nt-space' },
    h('header', {}, h('span', { class: 'dot', style: { background: L.COLOR_HEX[s.color] || s.color || 'var(--accent)' } }), s.emoji || null,
      h('b', {}, s.name), h('span', { class: 'muted' }, s.tabs.length)),
    h('div', { class: 'favs' }, s.tabs.slice(0, 12).map(t => icon(t.url))),
    h('div', { class: 'acts' }, kind === 'workspace'
      ? [s.id === activeId ? h('span', { class: 'muted' }, '● Open in this window')
          : h('button', { class: 'btn small primary', onclick: () => L.switchWorkspace(win, s.id) }, 'Switch here'),
         h('button', { class: 'btn small', onclick: () => L.openWorkspaceInNewWindow(s.id) }, 'New window')]
      : [h('button', { class: 'btn small primary', onclick: () => L.restoreStack(s.id, { windowId: win }) }, 'Restore'),
         h('button', { class: 'btn small', onclick: () => L.restoreStack(s.id, { windowId: win, keep: true }) }, 'Open & keep')]));
  const ws = await L.listSpaces('workspace'), st = await L.listSpaces('stack');
  show('workspaces', prefs.workspaces && ws.length);
  $('workspaces').replaceChildren(...ws.map(s => card(s, 'workspace')));
  show('stacks', prefs.stacks && st.length);
  $('stacks').replaceChildren(...st.slice(0, 9).map(s => card(s, 'stack')));
}

// ───────── search: Burrow bookmarks, open tabs, then the web ─────────
const q = $('q'), results = $('results');
let items = [], active = -1, searchSeq = 0;
function drawResults() {
  results.hidden = !items.length;
  results.replaceChildren(...items.map((r, i) => h('div', { class: 'nt-res' + (i === active ? ' on' : ''), onmousedown: e => { e.preventDefault(); go(r); } },
    r.icon, h('div', { class: 't' }, h('div', {}, r.title), r.sub ? h('div', { class: 'sub' }, r.sub) : null), h('span', { class: 'kind' }, r.kind))));
}
async function search() {
  const text = q.value.trim(), seq = ++searchSeq;
  if (!text) { items = []; active = -1; return drawResults(); }
  const lower = text.toLowerCase();
  const tabs = (await chrome.tabs.query({})).filter(t => (t.title + ' ' + t.url).toLowerCase().includes(lower) && !t.url.startsWith('chrome-extension://'))
    .slice(0, 4).map(t => ({ kind: 'Open tab', title: t.title, sub: host(t.url), icon: icon(t.url), tab: t }));
  const web = { kind: 'Web', title: `Search the web for “${text}”`, icon: h('span', { class: 'ico' }, '🔎'), web: text };
  const isUrl = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(text) && !/\s/.test(text);
  const goUrl = isUrl ? [{ kind: 'Go to', title: text, icon: icon(/^https?:/.test(text) ? text : 'https://' + text), url: /^https?:/.test(text) ? text : 'https://' + text }] : [];
  items = [...goUrl, ...tabs, web]; active = 0; drawResults();
  if (!(await L.isConfigured())) return;
  try {
    const { items: found } = await L.api('/bookmarks?limit=8&archived=all&q=' + encodeURIComponent(text));
    if (seq !== searchSeq) return;
    const { server } = await L.getConfig();
    const marks = found.map(b => ({ kind: b.type === 'note' ? 'Note' : 'Burrow', title: b.title || b.url || 'Untitled',
      sub: b.tags.map(t => '#' + t.name).join(' ') || host(b.url), icon: b.url ? icon(b.url) : h('span', { class: 'ico' }, '📝'), url: b.url || `${server}/#/notes` }));
    items = [...goUrl, ...marks, ...tabs, web]; active = 0; drawResults();
  } catch {}
}
function go(r) {
  if (r.tab) { chrome.tabs.update(r.tab.id, { active: true }); chrome.windows.update(r.tab.windowId, { focused: true }); }
  else if (r.web) chrome.search.query({ text: r.web, disposition: 'CURRENT_TAB' });
  else location.href = r.url;
}
let t;
q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 120); });
q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; drawResults(); }
  else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = (active - 1 + items.length) % items.length; drawResults(); }
  else if (e.key === 'Enter') { e.preventDefault(); const text = q.value.trim(); if (!text) return; go(items[active] || { web: text }); }
  else if (e.key === 'Escape') { q.value = ''; items = []; drawResults(); }
});
q.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
q.addEventListener('focus', () => { if (items.length) results.hidden = false; });

// ───────── toolbar & customize menu ─────────
$('panel').onclick = async () => chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
$('settings').onclick = e => {
  e.stopPropagation();
  const m = $('menu');
  if (!m.hidden) { m.hidden = true; return; }
  const box = (key, label) => h('label', {}, h('input', { type: 'checkbox', checked: !!prefs[key], onchange: ev => { prefs[key] = ev.target.checked; savePrefs(); render(); tick(); applyTheme(data.theme, bgObjectUrl); } }), label);
  m.replaceChildren(h('h3', {}, 'Show'), box('favorites', '★ Favorites'), box('workspaces', '🗂 Workspaces'), box('stacks', '📥 Stacks'), box('recent', '🕒 Recently saved'),
    h('h3', {}, 'Look'), box('useTheme', 'Use my Burrow theme background'), box('clock24', '24-hour clock'),
    h('button', { class: 'btn small', onclick: () => chrome.runtime.openOptionsPage() }, 'Burrow settings…'));
  m.hidden = false;
};
document.addEventListener('click', e => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });

// Live updates when workspaces/stacks change in other windows
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.spaces) render(); });

// First paint from cache, then refresh
const cachedBg = data.theme?.bg?.type === 'image' && data.theme.bg.image?.startsWith('/api/') ? (await chrome.storage.local.get('ntBg')).ntBg?.data : null;
bgObjectUrl = cachedBg;
applyTheme(data.theme, cachedBg);
render();
refresh().then(async () => { bgObjectUrl = await themeImage(data.theme).catch(() => null); });
