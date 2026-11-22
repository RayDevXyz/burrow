/* Burrow web app — vanilla JS, no build step. */
(() => {
'use strict';

// ───────── helpers ─────────
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv); }
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
  const r = await fetch('/api' + path, init);
  if (r.status === 401 && !path.startsWith('/auth')) { state.me = null; render(); throw new Error('Signed out'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function toast(msg) {
  const t = h('div', {}, msg); $('#toast').append(t); setTimeout(() => t.remove(), 3200);
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const ago = ts => {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('burrow.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('burrow.' + k, JSON.stringify(v)); } catch {} },
};

// ───────── state ─────────
const state = {
  me: undefined, status: null, items: [], hasMore: false, loading: false,
  collections: [], tags: [], stats: {}, q: '', sort: store.get('sort', ''),
  layout: store.get('layout', 'grid'), selected: new Set(), openId: null,
};
// ───────── themes ─────────
// The global theme (Home and every other page) lives on the user; a collection can have its own.
const GRADIENTS = {
  aurora: 'linear-gradient(135deg, #7c5cff 0%, #2dd4bf 100%)',
  sunset: 'linear-gradient(135deg, #f97316 0%, #db2777 55%, #7c3aed 100%)',
  ocean: 'linear-gradient(135deg, #0ea5e9 0%, #1e3a8a 100%)',
  forest: 'linear-gradient(135deg, #16a34a 0%, #064e3b 100%)',
  peach: 'linear-gradient(135deg, #fed7aa 0%, #fda4af 100%)',
  night: 'linear-gradient(135deg, #0f172a 0%, #312e81 60%, #581c87 100%)',
  candy: 'linear-gradient(135deg, #f0abfc 0%, #93c5fd 100%)',
  slate: 'linear-gradient(135deg, #64748b 0%, #1e293b 100%)',
};
const ACCENTS = ['#7c5cff', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#64748b'];
const DEFAULT_THEME = {
  accent: '#7c5cff', mode: 'auto',
  bg: { type: 'none', image: '', gradient: 'aurora', blur: 0, dim: 30, position: 'center' },
  header: { subtitle: '', emoji: '', banner: 'none', bannerImage: '', gradient: 'aurora', height: 'medium' },
  cards: { layout: 'grid', size: 'medium', radius: 12, glass: false },
};
const clone = o => JSON.parse(JSON.stringify(o));
const withDefaults = t => {
  const d = clone(DEFAULT_THEME); if (!t) return d;
  return { ...d, ...t, bg: { ...d.bg, ...t.bg }, header: { ...d.header, ...t.header }, cards: { ...d.cards, ...t.cards } };
};
const cssUrl = u => `url("${String(u).replace(/["\\\n]/g, '')}")`;

/** Theme for the page being shown: the collection's own theme, else the global one. */
function currentTheme() {
  const r = route();
  if (r.kind === 'collection') {
    const c = state.collections.find(c => c.id === r.id);
    if (c?.theme) return withDefaults(c.theme);
  }
  return withDefaults(state.me?.theme || store.get('globalTheme', null));
}

function applyTheme(t) {
  const root = document.documentElement;
  root.dataset.theme = t.mode;
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--radius', t.cards.radius + 'px');
  root.style.setProperty('--card-min', { small: '190px', medium: '250px', large: '330px' }[t.cards.size]);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.accent);
  let layer = document.getElementById('bg-layer');
  if (!layer) { layer = h('div', { id: 'bg-layer' }, h('div', { class: 'img' }), h('div', { class: 'dim' })); document.body.prepend(layer); }
  const img = layer.firstChild;
  const on = (t.bg.type === 'image' && t.bg.image) || t.bg.type === 'gradient';
  document.body.classList.toggle('has-bg', !!on);
  document.body.classList.toggle('glass', !!t.cards.glass);
  img.style.backgroundImage = !on ? 'none' : t.bg.type === 'image' ? cssUrl(t.bg.image) : GRADIENTS[t.bg.gradient];
  img.style.backgroundPosition = t.bg.position;
  img.style.filter = t.bg.blur ? `blur(${t.bg.blur}px)` : 'none';
  layer.lastChild.style.opacity = on ? t.bg.dim / 100 : 0;
}

function pageHeader(r, t, actions) {
  const hd = t.header;
  const banner = hd.banner === 'image' && hd.bannerImage ? cssUrl(hd.bannerImage) : hd.banner === 'gradient' ? GRADIENTS[hd.gradient] : null;
  return h('header', { class: 'page-header' + (banner ? ' banner ' + hd.height : '') , style: banner ? { backgroundImage: banner } : null },
    h('div', { class: 'ph-inner' },
      h('div', { class: 'ph-text' },
        h('div', { class: 'ph-title' }, h('span', { class: 'ph-emoji' }, hd.emoji || r.icon || ''), h('h2', {}, r.title)),
        hd.subtitle ? h('p', { class: 'ph-sub' }, hd.subtitle) : null),
      h('div', { class: 'ph-actions' }, actions)));
}

// ───────── theme editor (live preview) ─────────
function openThemeEditor() {
  const r = route();
  const col = r.kind === 'collection' ? state.collections.find(c => c.id === r.id) : null;
  const original = currentTheme();
  const t = clone(original);
  // A collection without its own theme starts from the global look, but keeps its own icon and no subtitle.
  if (col && !col.theme) { t.header.emoji = ''; t.header.subtitle = ''; }
  const close = () => { $('.drawer.theme')?.remove(); $('.backdrop.theme')?.remove(); };
  const preview = () => { applyTheme(t); const ph = $('.page-header'); if (ph) ph.replaceWith(headerFor(r, t)); renderList(); };
  const set = (path, v) => { const k = path.split('.'); let o = t; while (k.length > 1) o = o[k.shift()]; o[k[0]] = v; state.layout = t.cards.layout; preview(); body(); };

  const seg = (path, opts) => { const cur = path.split('.').reduce((o, k) => o[k], t);
    return h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { type: 'button', class: v === cur ? 'on' : '', onclick: () => set(path, v) }, l))); };
  const slider = (path, min, max, unit = '') => { const cur = path.split('.').reduce((o, k) => o[k], t);
    const out = h('span', { class: 'muted' }, cur + unit);
    return h('div', { class: 'row' }, h('input', { type: 'range', min, max, value: cur, class: 'grow',
      oninput: e => { out.textContent = e.target.value + unit; const k = path.split('.'); t[k[0]][k[1]] = +e.target.value; preview(); } }), out); };
  const swatches = (path) => { const cur = path.split('.').reduce((o, k) => o[k], t);
    return h('div', { class: 'swatches' }, Object.entries(GRADIENTS).map(([k, g]) =>
      h('button', { type: 'button', title: k, class: k === cur ? 'on' : '', style: { backgroundImage: g }, onclick: () => set(path, k) }))); };
  const imagePicker = (path) => {
    const cur = path.split('.').reduce((o, k) => o[k], t);
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('image', f);
      try { const { url } = await api('/theme-images', { method: 'POST', body: fd }); set(path, url); } catch (x) { toast(x.message); }
    } });
    return h('div', { class: 'col' },
      cur ? h('div', { class: 'thumb-preview', style: { backgroundImage: cssUrl(cur) } }) : null,
      h('div', { class: 'row' }, file, h('button', { type: 'button', class: 'btn small', onclick: () => file.click() }, '⬆ Upload image'),
        h('input', { class: 'input grow', placeholder: 'or paste an image URL', value: cur.startsWith('http') ? cur : '',
          onchange: e => set(path, e.target.value.trim()) })));
  };
  const field = (label, ...kids) => h('div', { class: 'field' }, h('label', {}, label), kids);

  const scroll = h('div', { class: 'scroll' });
  function body() {
    scroll.replaceChildren(...[
      h('h4', {}, '🎨 Colors & mode'),
      field('Accent color', h('div', { class: 'swatches accents' },
        ACCENTS.map(a => h('button', { type: 'button', class: a === t.accent ? 'on' : '', style: { background: a }, onclick: () => set('accent', a) })),
        h('input', { type: 'color', value: t.accent, title: 'Custom color', oninput: e => { t.accent = e.target.value; preview(); }, onchange: () => body() }))),
      field('Mode', seg('mode', [['auto', 'Auto'], ['light', '☀ Light'], ['dark', '☾ Dark']])),

      h('h4', {}, '🖼 Background'),
      field('Type', seg('bg.type', [['none', 'None'], ['gradient', 'Gradient'], ['image', 'Image']])),
      t.bg.type === 'gradient' ? field('Gradient', swatches('bg.gradient')) : null,
      t.bg.type === 'image' ? field('Image', imagePicker('bg.image')) : null,
      t.bg.type === 'image' ? field('Position', seg('bg.position', [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']])) : null,
      t.bg.type !== 'none' ? field('Blur', slider('bg.blur', 0, 30, 'px')) : null,
      t.bg.type !== 'none' ? field('Dim (keeps cards readable)', slider('bg.dim', 0, 90, '%')) : null,

      h('h4', {}, '🏷 Page header'),
      field('Emoji', h('input', { class: 'input', value: t.header.emoji, placeholder: r.icon || '🏠', maxlength: 8,
        oninput: e => { t.header.emoji = e.target.value; preview(); } })),
      field('Subtitle', h('input', { class: 'input', value: t.header.subtitle, placeholder: 'A short description for this page',
        oninput: e => { t.header.subtitle = e.target.value; preview(); } })),
      field('Banner', seg('header.banner', [['none', 'None'], ['gradient', 'Gradient'], ['image', 'Image']])),
      t.header.banner === 'gradient' ? field('Banner gradient', swatches('header.gradient')) : null,
      t.header.banner === 'image' ? field('Banner image', imagePicker('header.bannerImage')) : null,
      t.header.banner !== 'none' ? field('Banner height', seg('header.height', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])) : null,

      h('h4', {}, '🃏 Cards'),
      field('Layout', seg('cards.layout', [['grid', '▦ Grid'], ['list', '☰ List']])),
      field('Size', seg('cards.size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']])),
      field('Corner radius', slider('cards.radius', 0, 28, 'px')),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: t.cards.glass, onchange: e => set('cards.glass', e.target.checked) }),
        ' Glass cards (see-through, great over images)'),
    ].flat().filter(Boolean));
  }
  body();

  const save = async () => {
    try {
      if (col) {
        await api(`/collections/${col.id}`, { method: 'PATCH', body: { theme: t } });
        col.theme = t;
      } else {
        const r2 = await api('/me/theme', { method: 'PUT', body: { theme: t } });
        state.me.theme = r2.theme; store.set('globalTheme', r2.theme);
      }
      toast('Theme saved'); close(); renderMain();
    } catch (x) { toast(x.message); }
  };
  const cancel = () => { close(); applyTheme(original); state.layout = original.cards.layout; renderMain(); };
  const reset = async () => {
    if (col) {
      if (!confirm('Remove this collection’s theme and use the global theme again?')) return;
      await api(`/collections/${col.id}`, { method: 'PATCH', body: { theme: null } }); col.theme = null;
    } else {
      if (!confirm('Reset the global theme to the defaults?')) return;
      await api('/me/theme', { method: 'PUT', body: { theme: null } }); state.me.theme = null; store.set('globalTheme', null);
    }
    close(); renderMain(); toast('Theme reset');
  };

  document.body.append(
    h('div', { class: 'backdrop theme', onclick: cancel, style: { background: 'transparent' } }),
    h('div', { class: 'drawer theme' },
      h('header', {}, h('b', { class: 'grow' }, col ? `Theme · ${col.icon} ${col.name}` : 'Global theme'),
        h('button', { class: 'btn small ghost', onclick: cancel }, '✕')),
      col ? null : h('p', { class: 'muted', style: { margin: '10px 16px 0' } }, 'Used on Home and every page. Collections can have their own theme.'),
      scroll,
      h('footer', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save'),
        h('button', { class: 'btn', onclick: cancel }, 'Cancel'), h('span', { class: 'grow' }),
        h('button', { class: 'btn danger', onclick: reset }, col ? 'Use global theme' : 'Reset'))));
}
let headerFor = (r, t) => pageHeader(r, t, []);

applyTheme(withDefaults(store.get('globalTheme', null)));

function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  switch (p[0]) {
    case 'favorites': return { kind: 'favorites', title: 'Favorites', icon: '★', filter: { favorite: 1 } };
    case 'archive': return { kind: 'archive', title: 'Archive', icon: '🗄', filter: { archived: 1 } };
    case 'notes': return { kind: 'notes', title: 'Notes', icon: '📝', filter: { type: 'note' } };
    case 'files': return { kind: 'files', title: 'Files', icon: '📎', filter: { type: 'file' } };
    case 'unsorted': return { kind: 'unsorted', title: 'Unsorted', icon: '📥', filter: { collection: 'none' } };
    case 'c': {
      const c = state.collections.find(c => c.id === +p[1]);
      return { kind: 'collection', id: +p[1], title: c?.name || 'Collection', icon: c?.icon || '📁', filter: { collection: p[1] } };
    }
    case 't': {
      const name = decodeURIComponent(p[1] || '');
      const known = state.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
      return { kind: 'tag', title: '#' + (known?.name || name), icon: '', filter: { tag: known?.name || name } };
    }
    case 'spaces': return { kind: 'spaces', title: 'Tab spaces', icon: '🗂' };
    case 'settings': return { kind: 'settings', title: 'Settings', icon: '⚙' };
    // #/b/<id>: Home with that bookmark open (links from BrainWaves and elsewhere).
    case 'b': return { kind: 'all', title: 'Home', icon: '🏠', filter: {}, open: +p[1] || null };
    default: return { kind: 'all', title: 'Home', icon: '🏠', filter: {} };
  }
}

// ───────── tags: suggestions, nested tree, clickable #tags ─────────
const TAG_RE = /[\p{L}\p{N}\p{M}_\-\/\p{Extended_Pictographic}\p{So}‍️]/u;
const tagHref = name => `#/t/${encodeURIComponent(name)}`;

/** Tags matching a query, best first: prefix match, then a nested part matching (to-read → inbox/to-read), then contains. */
function matchTags(q, exclude = []) {
  const k = q.toLowerCase().replace(/^#/, '');
  const skip = new Set(exclude.map(x => x.toLowerCase()));
  const score = t => {
    const key = t.name.toLowerCase();
    if (!k) return 1;
    if (key.startsWith(k)) return 3;
    if (key.split('/').some(p => p.startsWith(k))) return 2;
    return key.includes(k) ? 1 : 0;
  };
  return state.tags.map(t => [t, score(t)]).filter(([t, s]) => s && !skip.has(t.name.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || b[0].count - a[0].count || a[0].name.localeCompare(b[0].name)).slice(0, 8).map(([t]) => t);
}

/**
 * Attach a tag suggestion dropdown to an input or textarea.
 *  mode 'hash'   → suggests after "#" (notes, composer)
 *  mode 'search' → suggests after "#" or "tag:" (search box)
 *  mode 'list'   → the whole value (or the part after the last comma) is the tag being typed
 * onPick(name) can take over what happens on selection (used by chip inputs).
 */
function tagSuggest(input, { mode = 'hash', onPick, exclude = () => [] } = {}) {
  let box = null, items = [], active = 0, token = null;
  const close = () => { box?.remove(); box = null; items = []; };
  const current = () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    if (mode === 'list') { const m = before.match(/(?:^|,)\s*([^,]*)$/); return m ? { start: before.length - m[1].length, text: m[1], prefix: '' } : null; }
    const re = mode === 'search' ? /(?:^|\s)(tag:#?|#)([^\s#]*)$/u : /(?:^|[\s(\[,;])(#)([^\s#]*)$/u;
    const m = before.match(re); if (!m) return null;
    if (m[2] && ![...m[2]].every(c => TAG_RE.test(c))) return null;
    return { start: before.length - m[2].length - m[1].length, text: m[2], prefix: m[1] };
  };
  function show() {
    token = current();
    if (!token || (mode === 'list' && !token.text)) return close();
    items = matchTags(token.text, exclude());
    if (!items.length) return close();
    active = 0;
    if (!box) { box = h('div', { class: 'tag-suggest' }); document.body.append(box); }
    const r = input.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: (r.bottom + 4) + 'px', minWidth: Math.min(r.width, 280) + 'px' });
    draw();
  }
  function draw() {
    box.replaceChildren(...items.map((t, i) => h('div', { class: 'ts-item' + (i === active ? ' on' : ''),
      onmousedown: e => { e.preventDefault(); pick(t); } }, h('span', {}, '#' + t.name), h('span', { class: 'muted' }, t.count))));
  }
  function pick(t) {
    close();
    if (onPick) return onPick(t.name);
    const v = input.value, end = input.selectionStart ?? v.length;
    let insert = mode === 'list' ? t.name + ', ' : (token.prefix.startsWith('tag:') ? 'tag:' : '#') + t.name + ' ';
    const start = mode === 'list' ? token.start : token.start;
    input.value = v.slice(0, start) + insert + v.slice(end);
    const pos = start + insert.length; input.setSelectionRange(pos, pos); input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { if (mode === 'list') show(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (!box) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, true);
  return { close };
}

/** Nested tag tree: #inbox/to-read sits under #inbox. Parents that are not tags themselves still show. */
function tagTree(tags) {
  const root = { children: new Map() };
  for (const t of tags) {
    let node = root, path = '';
    for (const part of t.name.split('/')) {
      path = path ? path + '/' + part : part;
      const k = part.toLowerCase();
      if (!node.children.has(k)) node.children.set(k, { label: part, path, count: 0, total: 0, children: new Map() });
      node = node.children.get(k);
      node.total += t.count;
    }
    node.count = t.count; node.tag = t;
  }
  return root;
}

/** Note text without its YAML front matter (shown on cards). */
const noteBody = text => (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').trim();

/** Text with #tags turned into links (for notes on cards and in the drawer). */
function linkifyTags(text) {
  const out = []; let last = 0;
  const re = /(^|[\s(\[,;])#([\p{L}\p{N}\p{M}_\-\/\p{Extended_Pictographic}\p{So}‍️]+)/gu;
  for (const m of text.matchAll(re)) {
    if (!/[^\d/]/u.test(m[2])) continue;
    const start = m.index + m[1].length;
    out.push(text.slice(last, start), h('a', { class: 'inline-tag', href: tagHref(m[2]), onclick: e => e.stopPropagation() }, '#' + m[2]));
    last = start + 1 + m[2].length;
  }
  out.push(text.slice(last));
  return out;
}

// ───────── data ─────────
async function loadMeta() {
  const [collections, tags, stats] = await Promise.all([api('/collections'), api('/tags'), api('/stats')]);
  Object.assign(state, { collections, tags, stats });
}
// Home and collections are databases with views (db.js); other pages use the simple card list.
const isDbPage = r => r.kind === 'all' || r.kind === 'collection';
const pageKey = r => (r.kind === 'collection' ? 'c:' + r.id : 'home');
const dbReload = () => $('#db')?._db?.reload();
async function loadItems(append = false) {
  const r = route(); if (!r.filter) return;
  if (isDbPage(r)) { state.items = []; state.hasMore = false; return; }
  const params = new URLSearchParams({ ...r.filter, limit: 48, offset: append ? state.items.length : 0 });
  if (state.q) params.set('q', state.q);
  if (state.sort) params.set('sort', state.sort);
  state.loading = true;
  try {
    const res = await api('/bookmarks?' + params);
    state.items = append ? state.items.concat(res.items) : res.items;
    state.hasMore = res.hasMore;
  } catch (e) { toast(e.message); }
  state.loading = false;
  schedulePoll();
}
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (state.items.some(i => i.status === 'pending')) pollTimer = setTimeout(async () => {
    await Promise.all([loadItems(), loadMeta()]); renderMain(); renderSidebar();
  }, 2500);
}
async function refresh() { await Promise.all([loadMeta(), loadItems()]); renderSidebar(); renderMain(); }

// ───────── auth screen ─────────
function renderAuth() {
  const setup = state.status?.needsSetup;
  let mode = setup ? 'register' : 'login';
  const err = h('div', { class: 'err' });
  const user = h('input', { class: 'input', placeholder: 'Username', autocomplete: 'username', required: true });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: setup ? 'new-password' : 'current-password', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, setup ? 'Create account' : 'Sign in');
  const sw = state.status?.allowSignup && !setup ? h('a', { href: '#', class: 'muted', onclick: e => {
    e.preventDefault(); mode = mode === 'login' ? 'register' : 'login';
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    sw.textContent = mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in';
  } }, 'Need an account? Sign up') : null;
  const form = h('form', { onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try { await api('/auth/' + mode, { method: 'POST', body: { username: user.value, password: pass.value } }); await boot(); }
    catch (x) { err.textContent = x.message; }
  } },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Burrow'),
    setup ? h('p', { class: 'muted' }, 'Welcome! Create the first (admin) account for this server.') : null,
    user, pass, err, submit, sw);
  $('#app').replaceChildren(h('div', { class: 'auth' }, form));
  user.focus();
}

// ───────── layout ─────────
function render() {
  if (!state.me) return renderAuth();
  if (!$('.layout')) {
    $('#app').replaceChildren(h('div', { class: 'layout' }, h('aside', { class: 'sidebar' }), h('main', { class: 'main' })));
  }
  renderSidebar(); renderMain();
}

function renderSidebar() {
  const r = route(); const s = state.stats;
  const nav = (href, icon, label, count, active) =>
    h('a', { href, class: 'nav-item' + (active ? ' active' : ''), onclick: () => $('.sidebar').classList.remove('open') },
      h('span', {}, icon), label, count != null ? h('span', { class: 'count' }, count) : null);
  const side = $('.sidebar');
  side.replaceChildren(...[
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Burrow'),
    nav('#/', '🏠', 'Home', s.all, r.kind === 'all'),
    nav('#/unsorted', '📥', 'Unsorted', s.unsorted, r.kind === 'unsorted'),
    nav('#/favorites', '★', 'Favorites', s.favorites, r.kind === 'favorites'),
    nav('#/notes', '📝', 'Notes', s.notes, r.kind === 'notes'),
    nav('#/files', '📎', 'Files', s.files, r.kind === 'files'),
    nav('#/archive', '🗄', 'Archive', s.archived, r.kind === 'archive'),
    nav('#/spaces', '🗂', 'Tab spaces', null, r.kind === 'spaces'),
    h('div', { class: 'nav-section' }, 'Collections', h('button', { title: 'New collection', onclick: newCollection }, '+')),
    state.collections.map(c => nav(`#/c/${c.id}`, c.icon, c.name, c.count, r.kind === 'collection' && r.id === c.id)),
    state.collections.length ? null : h('div', { class: 'muted', style: { padding: '2px 10px', fontSize: '12px' } }, 'No collections yet'),
    h('div', { class: 'nav-section' }, 'Tags'),
    state.tags.length ? sidebarTags(r) : h('div', { class: 'muted', style: { padding: '2px 10px', fontSize: '12px' } }, 'Type #tag in a note to create one'),
    h('div', { class: 'grow' }),
    nav('#/settings', '⚙', 'Settings', null, r.kind === 'settings'),
  ].flat().filter(Boolean));
}

function sidebarTags(r) {
  const open = new Set(store.get('openTags', []));
  const current = (r.filter?.tag || '').toLowerCase();
  const list = h('div', { class: 'tag-tree' });
  const filter = h('input', { class: 'input tag-filter', placeholder: 'Filter tags…', value: state.tagFilter || '',
    oninput: e => { state.tagFilter = e.target.value; draw(); } });
  function node(n, depth) {
    const kids = [...n.children.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    const isOpen = open.has(n.path.toLowerCase()) || current.startsWith(n.path.toLowerCase() + '/');
    return [h('div', { class: 'tt-row' + (current === n.path.toLowerCase() ? ' active' : ''), style: { paddingLeft: (6 + depth * 14) + 'px' } },
      kids.length ? h('button', { class: 'tt-toggle', title: isOpen ? 'Collapse' : 'Expand', onclick: () => {
        const k = n.path.toLowerCase(); open.has(k) ? open.delete(k) : open.add(k); store.set('openTags', [...open]); draw(); } }, isOpen ? '▾' : '▸')
        : h('span', { class: 'tt-toggle' }),
      h('a', { href: tagHref(n.path), class: 'tt-name', onclick: () => $('.sidebar').classList.remove('open') }, '#' + n.label),
      h('span', { class: 'count' }, kids.length && n.total !== n.count ? n.total : n.count)),
      isOpen ? kids.map(k => node(k, depth + 1)) : null];
  }
  function draw() {
    const q = (state.tagFilter || '').trim();
    if (q) { // flat search results across all levels
      const found = matchTags(q, []).concat(state.tags.filter(t => t.name.toLowerCase().includes(q.toLowerCase().replace(/^#/, '')))).filter((t, i, a) => a.indexOf(t) === i).slice(0, 30);
      list.replaceChildren(...(found.length ? found.map(t => h('div', { class: 'tt-row' + (current === t.name.toLowerCase() ? ' active' : '') },
        h('span', { class: 'tt-toggle' }), h('a', { href: tagHref(t.name), class: 'tt-name' }, '#' + t.name), h('span', { class: 'count' }, t.count)))
        : [h('div', { class: 'muted', style: { padding: '4px 10px', fontSize: '12px' } }, 'No tags match')]));
      return;
    }
    const kids = [...tagTree(state.tags).children.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    list.replaceChildren(...kids.flatMap(k => node(k, 0)).flat(Infinity).filter(Boolean));
  }
  draw();
  return h('div', {}, state.tags.length > 6 ? filter : null, list);
}

function renderMain() {
  const r = route();
  const main = $('.main');
  const theme = currentTheme();
  applyTheme(theme);
  if (state.themedRoute !== location.hash) { state.layout = theme.cards.layout; state.themedRoute = location.hash; }
  const search = h('input', { class: 'input', placeholder: 'Search… try #tag or tag:inbox  ( / )', value: state.q, id: 'q',
    oninput: debounce(async e => {
      state.q = e.target.value.trim(); if (!route().filter) location.hash = '#/';
      if (isDbPage(route())) { const box = $('#db'); if (box) window.BurrowDB.render(box, pageKey(route()), { q: state.q }); return; }
      await loadItems(); renderList();
    }, 250) });
  tagSuggest(search, { mode: 'search' });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn ghost menu-btn', onclick: () => $('.sidebar').classList.toggle('open') }, '☰'),
    h('div', { class: 'search' }, search),
    r.filter && !isDbPage(r) ? [
      h('select', { class: 'input', style: { width: 'auto' }, onchange: async e => { state.sort = e.target.value; store.set('sort', state.sort); await loadItems(); renderList(); } },
        [['', state.q ? 'Relevance' : 'Newest'], ['oldest', 'Oldest'], ['title', 'Title']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l))),
      h('button', { class: 'btn', title: 'Toggle layout', onclick: e => { state.layout = state.layout === 'grid' ? 'list' : 'grid'; e.currentTarget.textContent = state.layout === 'grid' ? '☰' : '▦'; renderList(); } }, state.layout === 'grid' ? '☰' : '▦'),
    ] : null,
  );
  const content = h('div', { class: 'content' });
  main.replaceChildren(topbar, content);
  if (r.kind === 'spaces') return renderSpaces(content);
  if (r.kind === 'settings') return renderSettings(content);

  const actions = () => [
    h('button', { class: 'btn small', title: r.kind === 'collection' ? 'Theme for this collection' : 'Global theme', onclick: openThemeEditor }, '🎨 Theme'),
    isDbPage(r) ? h('button', { class: 'btn small', title: r.kind === 'collection' ? 'Extra properties for this collection' : 'Properties for every bookmark',
      onclick: () => window.BurrowDB.openPropertiesEditor(pageKey(r), dbReload) }, '⚙ Properties') : null,
    r.kind === 'collection' ? h('button', { class: 'btn small', onclick: () => editCollection(r.id) }, 'Edit') : null,
    r.kind === 'tag' ? [
      h('button', { class: 'btn small', onclick: () => renameTag(r.filter.tag) }, 'Rename'),
      h('button', { class: 'btn small danger', onclick: () => deleteTag(r.filter.tag) }, 'Delete tag'),
    ] : null];
  headerFor = (rr, t) => pageHeader(rr, t, actions());
  content.append(headerFor(r, theme));
  if (r.kind === 'tag') content.append(brainwavesStrip(r.filter.tag));
  if (['all', 'collection', 'unsorted', 'notes', 'tag'].includes(r.kind)) content.append(composer(r));
  if (isDbPage(r)) {
    const box = h('div', { id: 'db' });
    content.append(box);
    window.BurrowDB.render(box, pageKey(r), { q: state.q });
    return;
  }
  content.append(h('div', { id: 'list' }));
  renderList();
}

function composer(r) {
  const ta = h('textarea', { placeholder: 'Paste a link, jot a note, or drop a file…  (Ctrl+Enter to save)', rows: 1,
    oninput: e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; },
    onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); } });
  tagSuggest(ta, { mode: 'hash' });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: e => uploadFiles([...e.target.files]) });
  const ctx = () => ({ collectionId: r.kind === 'collection' ? r.id : undefined, tags: r.kind === 'tag' ? [r.filter.tag] : undefined });
  async function save() {
    const v = ta.value.trim(); if (!v) return;
    const lines = v.split(/\s+/).filter(x => /^https?:\/\/\S+$/i.test(x));
    try {
      if (lines.length && lines.join(' ') === v.replace(/\s+/g, ' ')) {
        for (const url of lines) {
          const res = await api('/bookmarks', { method: 'POST', body: { url, ...ctx() } });
          if (res.duplicate) toast('Already saved: ' + (res.title || url));
        }
      } else {
        const [first, ...rest] = v.split('\n');
        await api('/bookmarks', { method: 'POST', body: { note: v, title: first.slice(0, 120), ...ctx() } });
      }
      ta.value = ''; ta.style.height = 'auto'; await refresh();
    } catch (e) { toast(e.message); }
  }
  async function uploadFiles(files) {
    for (const f of files) {
      const fd = new FormData(); fd.append('file', f);
      const c = ctx(); if (c.collectionId) fd.append('collectionId', c.collectionId); if (c.tags) fd.append('tags', c.tags.join(','));
      try { await api('/bookmarks/upload', { method: 'POST', body: fd }); } catch (e) { toast(e.message); }
    }
    toast(`Uploaded ${files.length} file(s)`); await refresh();
  }
  const box = h('div', { class: 'composer',
    ondragover: e => { e.preventDefault(); box.classList.add('drag'); }, ondragleave: () => box.classList.remove('drag'),
    ondrop: e => { e.preventDefault(); box.classList.remove('drag');
      if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
      else { ta.value = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text'); save(); } } },
    ta, h('div', { class: 'row' }, fileIn, h('button', { class: 'btn ghost small', onclick: () => fileIn.click() }, '📎 Upload'),
      h('span', { class: 'grow' }), h('button', { class: 'btn primary small', onclick: save }, 'Save')));
  return box;
}

function renderList() {
  const list = $('#list'); if (!list) return;
  if (!state.items.length && !state.loading) {
    list.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, state.q ? '🔍' : '🦫'),
      h('p', {}, state.q ? `Nothing matches “${state.q}”.` : 'Nothing here yet. Paste a link above or use the browser extension.')));
    return renderBulkbar();
  }
  const grid = h('div', { class: 'grid' + (state.layout === 'list' ? ' list' : '') + (state.selected.size ? ' selecting' : '') },
    state.items.map(card));
  list.replaceChildren(grid, ...(state.hasMore ? [h('div', { style: { textAlign: 'center', marginTop: '20px' } },
    h('button', { class: 'btn', onclick: async () => { await loadItems(true); renderList(); } }, 'Load more'))] : []));
  renderBulkbar();
}

function card(b) {
  const img = b.type === 'file' && /^image\//.test(b.file_mime || '') ? `/api/bookmarks/${b.id}/file` : b.image_url;
  const icon = { note: '📝', file: '📄', link: '🔗' }[b.type];
  const act = (label, title, fn) => h('button', { title, onclick: e => { e.stopPropagation(); fn(); } }, label);
  return h('article', { class: 'card' + (state.selected.has(b.id) ? ' selected' : ''), onclick: () => openDrawer(b.id) },
    h('input', { type: 'checkbox', class: 'check', checked: state.selected.has(b.id), onclick: e => {
      e.stopPropagation(); e.target.checked ? state.selected.add(b.id) : state.selected.delete(b.id); renderList(); } }),
    b.status === 'pending' ? h('span', { class: 'status' }, h('span', { class: 'spinner' }), ' fetching') : null,
    b.status === 'failed' ? h('span', { class: 'status', title: b.error }, '⚠ fetch failed') : null,
    b.type === 'note' && !img ? null : h('div', { class: 'thumb', style: img ? { backgroundImage: `url("${img.replace(/"/g, '%22')}")` } : null }, img ? null : icon),
    h('div', { class: 'body' },
      h('div', { class: 'site' }, b.favicon ? h('img', { src: b.favicon, alt: '', loading: 'lazy', onerror: e => e.target.remove() }) : h('span', {}, icon),
        b.site_name || host(b.url) || (b.type === 'note' ? 'Note' : 'File'), ' · ', ago(b.created_at)),
      h('div', { class: 'title' }, b.title || b.url || 'Untitled'),
      (b.type === 'note' ? noteBody(b.note) : b.description) ? h('div', { class: 'desc' }, b.type === 'note' ? linkifyTags(noteBody(b.note)) : b.description) : null,
      b.tags.length ? h('div', { class: 'tags' }, b.tags.map(t => h('a', { class: 'chip' + (t.source === 'ai' ? ' ai' : ''), href: tagHref(t.name),
        title: t.source === 'note' ? 'From the note text' : t.source === 'ai' ? 'Added by AI' : null, onclick: e => e.stopPropagation() }, t.name))) : null),
    h('div', { class: 'actions' },
      b.url ? act('↗', 'Open', () => window.open(b.url, '_blank', 'noopener')) : null,
      act(b.favorite ? '★' : '☆', 'Favorite', () => patch(b.id, { favorite: !b.favorite })),
      act(b.archived ? '↩' : '🗄', b.archived ? 'Unarchive' : 'Archive', () => patch(b.id, { archived: !b.archived })),
      act('🗑', 'Delete', () => del(b.id))),
  );
}

function renderBulkbar() {
  $('.bulkbar')?.remove();
  if (!state.selected.size) return;
  const ids = [...state.selected];
  const run = async (action, value) => {
    if (action === 'delete' && !confirm(`Delete ${ids.length} item(s)?`)) return;
    await api('/bookmarks/bulk', { method: 'POST', body: { ids, action, value } });
    state.selected.clear(); await refresh();
  };
  const move = h('select', { class: 'input', style: { width: 'auto' }, onchange: e => run('move', e.target.value || null) },
    h('option', { value: '' , disabled: true, selected: true }, 'Move to…'), h('option', { value: '' }, 'No collection'),
    state.collections.map(c => h('option', { value: c.id }, `${c.icon} ${c.name}`)));
  document.body.append(h('div', { class: 'bulkbar' }, h('b', {}, `${ids.length} selected`), move,
    h('button', { class: 'btn small', onclick: () => { const t = prompt('Add tag'); if (t) run('tag', t); } }, '# Tag'),
    h('button', { class: 'btn small', onclick: () => run('favorite', true) }, '★'),
    h('button', { class: 'btn small', onclick: () => run('archive', route().kind !== 'archive') }, route().kind === 'archive' ? 'Unarchive' : 'Archive'),
    h('button', { class: 'btn small danger', onclick: () => run('delete') }, 'Delete'),
    h('button', { class: 'btn small ghost', onclick: () => { state.selected.clear(); renderList(); } }, '✕')));
}

async function patch(id, body) {
  try {
    const upd = await api(`/bookmarks/${id}`, { method: 'PATCH', body });
    const i = state.items.findIndex(x => x.id === id);
    const r = route();
    const stillHere = !(('archived' in body) && (r.kind === 'archive' ? !upd.archived : upd.archived)) &&
      !(r.kind === 'favorites' && !upd.favorite);
    if (i >= 0) stillHere ? (state.items[i] = upd) : state.items.splice(i, 1);
    if (isDbPage(r)) dbReload(); else renderList();
    loadMeta().then(renderSidebar);
    return upd;
  } catch (e) { toast(e.message); }
}
async function del(id) {
  if (!confirm('Delete this item permanently?')) return;
  await api(`/bookmarks/${id}`, { method: 'DELETE' });
  state.items = state.items.filter(x => x.id !== id); closeDrawer();
  if (isDbPage(route())) dbReload(); else renderList();
  loadMeta().then(renderSidebar);
}

// ───────── detail drawer ─────────
function closeDrawer() { $('.drawer')?.remove(); $('.backdrop.d')?.remove(); state.openId = null; }
async function openDrawer(id) {
  closeDrawer(); state.openId = id;
  const b = await api(`/bookmarks/${id}`);
  const title = h('input', { class: 'input', value: b.title || '' });
  const desc = h('textarea', { class: 'input', rows: 3 }, b.description || '');
  const note = h('textarea', { class: 'input', rows: b.type === 'note' ? 10 : 4, placeholder: 'Your notes… type #tag to tag' }, b.note || '');
  tagSuggest(note, { mode: 'hash' });
  // Tags typed as #tag in the note are managed by the note text; the rest are edited here.
  let tags = b.tags.filter(t => t.source !== 'note').map(t => t.name);
  const noteTags = b.tags.filter(t => t.source === 'note').map(t => t.name);
  const tagWrap = h('div', { class: 'tag-input' });
  const addTag = v => { const t = v.trim().replace(/^#+/, '').replace(/\s+/g, '-'); if (t && !tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t); tagIn.value = ''; drawTags(); tagIn.focus(); };
  const tagIn = h('input', { placeholder: 'Add tag…', onkeydown: e => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && tagIn.value.trim()) { e.preventDefault(); addTag(tagIn.value); }
    else if (e.key === 'Backspace' && !tagIn.value && tags.length) { tags.pop(); drawTags(); } } });
  tagSuggest(tagIn, { mode: 'list', onPick: addTag, exclude: () => tags });
  const drawTags = () => tagWrap.replaceChildren(...tags.map((t, i) => h('span', { class: 'chip x', title: 'Remove', onclick: () => { tags.splice(i, 1); drawTags(); } }, t + ' ×')),
    ...noteTags.map(t => h('span', { class: 'chip note-tag', title: 'From the note text — edit the note to change it' }, '#' + t)), tagIn);
  drawTags();
  const col = h('select', { class: 'input' }, h('option', { value: '' }, '— None —'),
    state.collections.map(c => h('option', { value: c.id, selected: c.id === b.collection_id }, `${c.icon} ${c.name}`)));
  const save = async () => {
    if (tagIn.value.trim()) tags.push(tagIn.value.trim());
    await patch(id, { title: title.value, description: desc.value, note: note.value, tags, collectionId: col.value || null });
    toast('Saved'); closeDrawer();
  };
  // Custom properties (Notion-style) — edited in place, saved immediately
  const propsSlot = h('div');
  window.BurrowDB.drawerSection(b, () => { if (isDbPage(route())) dbReload(); }).then(el => propsSlot.replaceWith(el));
  const hero = b.type === 'file' && /^image\//.test(b.file_mime) ? `/api/bookmarks/${id}/file` : b.image_url;
  const drawer = h('div', { class: 'drawer', onkeydown: e => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } } },
    h('header', {}, h('b', { class: 'grow' }, { link: 'Bookmark', note: 'Note', file: 'File' }[b.type]),
      h('button', { class: 'btn small', onclick: () => patch(id, { favorite: !b.favorite }).then(u => { b.favorite = u.favorite; }) }, b.favorite ? '★' : '☆'),
      h('button', { class: 'btn small ghost', onclick: closeDrawer }, '✕')),
    h('div', { class: 'scroll' },
      hero ? h('img', { class: 'hero', src: hero, alt: '', onerror: e => e.target.remove() }) : null,
      b.url ? h('a', { href: b.url, target: '_blank', rel: 'noopener', style: { color: 'var(--accent)', wordBreak: 'break-all' } }, b.url) : null,
      h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        b.has_reader ? h('button', { class: 'btn small', onclick: () => openReader(b) }, '📖 Reader') : null,
        b.has_archive ? h('button', { class: 'btn small', onclick: () => openSnapshot(b) }, '🗃 Snapshot') : null,
        b.has_archive ? h('a', { class: 'btn small', href: `/api/bookmarks/${id}/archive?download=1` }, '⬇ HTML') : null,
        b.file_name ? h('a', { class: 'btn small', href: `/api/bookmarks/${id}/file`, target: '_blank' }, '⬇ Open file') : null,
        b.url ? h('button', { class: 'btn small', onclick: async () => { await api(`/bookmarks/${id}/refetch`, { method: 'POST' }); toast('Re-fetching…'); closeDrawer(); refresh(); } }, '↻ Refetch') : null),
      b.status === 'failed' ? h('div', { class: 'muted' }, '⚠ ', b.error) : null,
      h('div', { class: 'field' }, h('label', {}, 'Title'), title),
      b.type === 'link' ? h('div', { class: 'field' }, h('label', {}, 'Description'), desc) : null,
      h('div', { class: 'field' }, h('label', {}, b.type === 'note' ? 'Note' : 'Notes'), note),
      h('div', { class: 'field' }, h('label', {}, 'Tags'), tagWrap),
      h('div', { class: 'field' }, h('label', {}, 'Collection'), col),
      propsSlot,
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        `Saved ${new Date(b.created_at * 1000).toLocaleString()}`, b.author ? ` · by ${b.author}` : '', b.word_count ? ` · ${b.word_count} words · ~${Math.max(1, Math.round(b.word_count / 230))} min read` : ''),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save'),
        h('button', { class: 'btn', onclick: () => patch(id, { archived: !b.archived }).then(closeDrawer) }, b.archived ? 'Unarchive' : 'Archive'),
        h('span', { class: 'grow' }), h('button', { class: 'btn danger', onclick: () => del(id) }, 'Delete'))));
  document.body.append(h('div', { class: 'backdrop d', onclick: closeDrawer }), drawer);
}

function modal(titleText, iframe, extra) {
  const close = () => { m.remove(); bd.remove(); };
  const bd = h('div', { class: 'backdrop', onclick: close, style: { zIndex: 48 } });
  const m = h('div', { class: 'modal' }, h('header', {}, h('b', { class: 'grow' }, titleText), extra, h('button', { class: 'btn small ghost', onclick: close }, '✕')), iframe);
  document.body.append(bd, m);
}
async function openReader(b) {
  const full = await api(`/bookmarks/${b.id}`);
  const css = `body{font:18px/1.7 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222;background:#fffdf8}
    img,video{max-width:100%;height:auto}pre{overflow:auto;background:#f3f1ea;padding:12px;font-size:14px}a{color:#6b4fe0}
    h1{font:700 32px/1.25 system-ui,sans-serif}.meta{font:14px system-ui;color:#777;margin-bottom:28px}
    @media (prefers-color-scheme:dark){body{background:#17161f;color:#ddd}pre{background:#24232f}}`;
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const doc = `<!doctype html><meta charset="utf-8"><base href="${esc(b.url)}" target="_blank"><style>${css}</style>
    <h1>${esc(full.title)}</h1><div class="meta">${esc(full.site_name)}${full.author ? ' · ' + esc(full.author) : ''}</div>${full.content_html}`;
  // sandbox without allow-scripts / allow-same-origin: archived HTML can't run code or read our cookies
  modal(full.title, h('iframe', { sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: doc }));
}
function openSnapshot(b) {
  modal('Snapshot · ' + (b.title || b.url), h('iframe', { sandbox: 'allow-popups', src: `/api/bookmarks/${b.id}/archive` }),
    h('a', { class: 'btn small', href: `/api/bookmarks/${b.id}/archive`, target: '_blank' }, 'Open in tab'));
}

// ───────── dialogs ─────────
function dialog(titleText, fields, onOk, extra) {
  const close = () => { d.remove(); bd.remove(); };
  const bd = h('div', { class: 'backdrop', onclick: close, style: { zIndex: 48 } });
  const inputs = fields.map(f => h('input', { class: 'input', placeholder: f.label, value: f.value || '', style: f.style }));
  const d = h('form', { class: 'dialog', onsubmit: async e => { e.preventDefault(); try { await onOk(inputs.map(i => i.value)); close(); } catch (x) { toast(x.message); } } },
    h('h3', {}, titleText), fields.map((f, i) => h('div', { class: 'field' }, h('label', {}, f.label), inputs[i])),
    h('div', { class: 'row' }, extra ? extra(close) : null, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save')));
  document.body.append(bd, d); inputs[0].focus();
}
function newCollection() {
  dialog('New collection', [{ label: 'Name' }, { label: 'Icon (emoji)', value: '📁' }], async ([name, icon]) => {
    const c = await api('/collections', { method: 'POST', body: { name, icon } });
    await loadMeta(); location.hash = `#/c/${c.id}`;
  });
}
function editCollection(id) {
  const c = state.collections.find(c => c.id === id); if (!c) return;
  dialog('Edit collection', [{ label: 'Name', value: c.name }, { label: 'Icon (emoji)', value: c.icon }], async ([name, icon]) => {
    await api(`/collections/${id}`, { method: 'PATCH', body: { name, icon } }); await refresh();
  }, close => h('button', { type: 'button', class: 'btn danger', onclick: async () => {
    if (!confirm('Delete this collection? Items in it are kept (moved to Unsorted).')) return;
    await api(`/collections/${id}`, { method: 'DELETE' }); close(); location.hash = '#/'; await refresh();
  } }, 'Delete'));
}
function renameTag(name) {
  const t = state.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!t) return toast('This is a parent of nested tags; rename the nested tags instead');
  dialog('Rename tag — nested tags move with it, and an existing name merges', [{ label: 'Name', value: t.name }], async ([n]) => {
    const res = await api(`/tags/${t.id}`, { method: 'PATCH', body: { name: n } }); await loadMeta();
    location.hash = tagHref(res.name);
  });
}
async function deleteTag(name) {
  const t = state.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!t) return toast('This is a parent of nested tags; delete the nested tags instead');
  if (!confirm(`Remove tag #${name} from all items?`)) return;
  await api(`/tags/${t.id}`, { method: 'DELETE' }); location.hash = '#/';
}

// ───────── tab spaces (synced from extension) ─────────
const GROUP_HEX = { grey: '#8c8c8c', blue: '#4c8bf5', red: '#e8453c', yellow: '#f5b400', green: '#34a853',
  pink: '#f06292', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' };
async function renderSpaces(el) {
  el.append(h('div', { class: 'page-title' }, h('span', { style: { fontSize: '20px' } }, '🗂'), h('h2', {}, 'Tab spaces')),
    h('p', { class: 'muted' }, 'Workspaces and stashed tab stacks synced from the Burrow browser extension.'));
  const spaces = await api('/spaces');
  if (!spaces.length) return el.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🧩'),
    h('p', {}, 'No synced spaces yet. Install the extension, connect it in its options, and save a workspace.')));
  for (const kind of ['workspace', 'stack']) {
    const list = spaces.filter(s => s.kind === kind);
    if (!list.length) continue;
    el.append(h('h3', { style: { margin: '18px 0 10px' } }, kind === 'workspace' ? 'Workspaces' : 'Stacks'));
    for (const s of list) {
      el.append(h('section', { class: 'space' },
        h('header', {}, h('span', { class: 'dot', style: { background: GROUP_HEX[s.color] || s.color || 'var(--accent)' } }), s.emoji || '', h('b', {}, s.name),
          h('span', { class: 'muted' }, `${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'} · updated ${ago(s.updated_at / 1000)}`), h('span', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: () => s.tabs.forEach(t => window.open(t.url, '_blank', 'noopener')) }, 'Open all'),
          h('button', { class: 'btn small', onclick: async () => {
            let n = 0; for (const t of s.tabs) { try { const r = await api('/bookmarks', { method: 'POST', body: { url: t.url, title: t.title, tags: [s.name] } }); if (!r.duplicate) n++; } catch {} }
            toast(`Saved ${n} new bookmark(s) tagged #${s.name.toLowerCase()}`); loadMeta().then(renderSidebar);
          } }, 'Save as bookmarks')),
        h('ul', {}, s.tabs.map(t => h('li', {}, h('a', { href: t.url, target: '_blank', rel: 'noopener', title: t.url },
          t.favIconUrl && /^https?:/.test(t.favIconUrl) ? h('img', { src: t.favIconUrl, alt: '', onerror: e => e.target.remove() }) : h('span', {}, '🌐'),
          t.pinned ? '📌 ' : '', t.title || t.url))))));
    }
  }
}

// ───────── settings ─────────
async function renderSettings(el) {
  api('/auth/status').then(st => { const v = $('#app-version'); if (v) v.textContent = `Burrow v${st.version}`; }).catch(() => {});
  const tokens = await api('/tokens');
  const tokenOut = h('div');
  el.append(
    h('div', { class: 'page-title' }, h('h2', {}, 'Settings')),
    h('section', { class: 'panel' }, h('h3', {}, 'Account'),
      h('p', { class: 'muted', id: 'app-version', style: { fontSize: '12px', margin: '0 0 6px' } }),
      h('p', {}, 'Signed in as ', h('b', {}, state.me.username), state.me.aiEnabled ? ' · ✦ AI tagging enabled' : ' · AI tagging off (set AI_PROVIDER to enable)'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { location.hash = '#/'; setTimeout(openThemeEditor, 50); } }, '🎨 Customize theme'),
        h('span', { class: 'grow' }),
        installPrompt ? h('button', { class: 'btn primary', onclick: async () => {
          installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; } }, '📲 Install app') : null,
        h('button', { class: 'btn', onclick: () => dialog('Change password', [{ label: 'Current password' }, { label: 'New password' }], async ([current, next]) => {
          await api('/me/password', { method: 'POST', body: { current, next } }); toast('Password changed'); }) }, 'Change password'),
        h('button', { class: 'btn', onclick: async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); } }, 'Sign out'))),
    h('section', { class: 'panel' }, h('h3', {}, 'Browser extension & API tokens'),
      h('p', { class: 'muted' }, 'Create a token, then paste it and this server URL (', h('code', {}, location.origin), ') into the Burrow extension options.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        const t = await api('/tokens', { method: 'POST', body: { name: 'Browser extension' } });
        tokenOut.replaceChildren(h('p', {}, 'Copy this token now — it will not be shown again:'), h('code', { class: 'token' }, t.token));
      } }, 'New token')), tokenOut,
      tokens.length ? h('table', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Created'), h('th', {}, 'Last used'), h('th')),
        tokens.map(t => h('tr', {}, h('td', {}, t.name), h('td', {}, ago(t.created_at)), h('td', {}, t.last_used_at ? ago(t.last_used_at) : 'never'),
          h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { await api(`/tokens/${t.id}`, { method: 'DELETE' }); location.reload(); } }, 'Revoke'))))) : null),
    brainwavesSettings(),
    h('section', { class: 'panel' }, h('h3', {}, 'Import'),
      h('p', { class: 'muted' }, 'Netscape bookmark HTML (exported from Chrome, Firefox, Pocket, Raindrop, Linkwarden, Hoarder…) or a Burrow JSON export. Folders become collections.'),
      (() => {
        const f = h('input', { type: 'file', accept: '.html,.htm,.json' });
        const fetchCb = h('input', { type: 'checkbox', checked: true });
        return h('div', { class: 'row', style: { flexWrap: 'wrap' } }, f, h('label', {}, fetchCb, ' Fetch pages & archive'),
          h('button', { class: 'btn primary', onclick: async () => {
            if (!f.files[0]) return toast('Choose a file first');
            const fd = new FormData(); fd.append('file', f.files[0]); fd.append('fetch', String(fetchCb.checked));
            try { const r = await api('/import', { method: 'POST', body: fd }); toast(`Imported ${r.added}, skipped ${r.skipped}`); refresh(); } catch (e) { toast(e.message); }
          } }, 'Import'));
      })()),
    h('section', { class: 'panel' }, h('h3', {}, 'Export'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '/api/export' }, '⬇ JSON (everything)'), h('a', { class: 'btn', href: '/api/export?format=html' }, '⬇ Bookmarks HTML'))),
  );
}

// ───────── BrainWaves (the notes app): its pages on tag pages ─────────
/** On a tag page: the BrainWaves pages with the same tag. Empty when BrainWaves isn't connected. */
function brainwavesStrip(tag) {
  const box = h('div', { class: 'bw-strip', hidden: true });
  api(`/integrations/brainwaves/tag/${encodeURIComponent(tag)}`).then(r => {
    if (!r || !r.pages.length) return;
    box.hidden = false;
    box.replaceChildren(h('span', { class: 'bw-strip-label' }, '🧠 In BrainWaves'),
      ...r.pages.map(p => h('a', { class: 'bw-page', href: p.link, target: '_blank', rel: 'noopener' }, (p.icon ? p.icon + ' ' : '📄 ') + p.title)));
  }).catch(e => { box.hidden = false; box.replaceChildren(h('span', { class: 'bw-strip-label muted' }, '🧠 BrainWaves: ' + e.message)); });
  return box;
}

function brainwavesSettings() {
  const body = h('div');
  const draw = async () => {
    const c = await api('/integrations/brainwaves').catch(() => null);
    if (c) {
      body.replaceChildren(h('p', {}, 'Connected to ', h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.url), '. Tag pages show your BrainWaves pages with the same tag.'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await api('/integrations/brainwaves', { method: 'DELETE' }); draw(); } }, 'Disconnect')));
      return;
    }
    const url = h('input', { class: 'input', placeholder: 'https://notes.example.com' });
    const token = h('input', { class: 'input', type: 'password', placeholder: 'API token from BrainWaves' });
    body.replaceChildren(
      h('p', { class: 'muted' }, 'Show your BrainWaves pages on tag pages here. In BrainWaves, open Settings → Account and API tokens → New token, then paste its address and the token.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, url, token,
        h('button', { class: 'btn primary', onclick: async () => {
          try { await api('/integrations/brainwaves', { method: 'PUT', body: { url: url.value, token: token.value } }); toast('BrainWaves connected'); draw(); }
          catch (e) { toast(e.message); }
        } }, 'Connect')));
  };
  draw();
  return h('section', { class: 'panel' }, h('h3', {}, '🧠 BrainWaves'), body);
}

// ───────── share target (Android share sheet → /share?title=&text=&url=) ─────────
function sharedPayload() {
  if (location.pathname !== '/share') return null;
  const p = new URLSearchParams(location.search);
  const text = (p.get('text') || '').trim();
  let url = (p.get('url') || '').trim();
  // Most Android apps put the link inside "text", often after a description.
  if (!url) url = (text.match(/https?:\/\/[^\s]+/) || [''])[0];
  let note = url ? text.replace(url, '').trim() : text;
  const title = (p.get('title') || '').trim();
  if (note === title) note = '';
  return { url, title, note };
}
function leaveShare() { history.replaceState(null, '', '/'); boot(); }

// Shares made while offline are queued and sent the next time Burrow opens.
const queue = { get: () => store.get('pendingShares', []), set: v => store.set('pendingShares', v) };
async function flushQueue() {
  const pending = queue.get(); if (!pending.length) return;
  const left = [];
  for (const body of pending) { try { await api('/bookmarks', { method: 'POST', body }); } catch { left.push(body); } }
  queue.set(left);
  if (pending.length > left.length) toast(`Synced ${pending.length - left.length} item(s) shared while offline`);
}

function renderShare(share) {
  const title = h('input', { class: 'input', value: share.title, placeholder: share.url ? 'Fetched automatically if empty' : 'Title' });
  const tags = h('input', { class: 'input', placeholder: 'reading, recipes', autocapitalize: 'none' });
  tagSuggest(tags, { mode: 'list' });
  const col = h('select', { class: 'input' }, h('option', { value: '' }, '— Unsorted —'),
    state.collections.map(c => h('option', { value: c.id }, `${c.icon} ${c.name}`)));
  const note = h('textarea', { class: 'input', rows: share.url ? 3 : 6, placeholder: share.url ? 'Why are you saving this?' : 'Note' }, share.note);
  const fav = h('input', { type: 'checkbox' });
  const msg = h('div', { class: 'err' });
  const save = h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center', padding: '10px' } }, share.url ? 'Save link' : 'Save note');

  const done = (icon, text) => $('#app').replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'share-card', style: { textAlign: 'center' } },
    h('div', { style: { fontSize: '44px' } }, icon), h('h3', {}, text),
    h('button', { class: 'btn primary', style: { justifyContent: 'center' }, onclick: leaveShare }, 'Open Burrow'),
    h('button', { class: 'btn', style: { justifyContent: 'center' }, onclick: () => { window.close(); leaveShare(); } }, 'Close'))));

  const form = h('form', { class: 'share-card', onsubmit: async e => {
    e.preventDefault(); save.disabled = true; msg.textContent = '';
    const body = {
      ...(share.url ? { url: share.url } : {}),
      title: title.value.trim() || undefined,
      note: note.value.trim() || (share.url ? undefined : title.value.trim()),
      tags: tags.value.split(',').map(t => t.trim()).filter(Boolean),
      collectionId: col.value || null, favorite: fav.checked,
    };
    try {
      const r = await api('/bookmarks', { method: 'POST', body });
      done('✓', r.duplicate ? 'Already in your Burrow — tags added' : 'Saved to Burrow');
    } catch (err) {
      if (!navigator.onLine || err instanceof TypeError) { queue.set([...queue.get(), body]); done('📥', 'You’re offline — it will be saved next time you open Burrow'); }
      else { msg.textContent = err.message; save.disabled = false; }
    }
  } },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), share.url ? 'Save link' : 'Save note'),
    share.url ? h('div', { class: 'share-url' }, share.url) : null,
    h('div', { class: 'field' }, h('label', {}, 'Title'), title),
    h('div', { class: 'field' }, h('label', {}, 'Tags'), tags),
    h('div', { class: 'field' }, h('label', {}, 'Collection'), col),
    h('div', { class: 'field' }, h('label', {}, share.url ? 'Note' : 'Text'), note),
    h('label', { class: 'row' }, fav, ' ★ Favorite'),
    msg, save,
    h('button', { class: 'btn', type: 'button', style: { justifyContent: 'center' }, onclick: leaveShare }, 'Cancel'));
  $('#app').replaceChildren(h('div', { class: 'auth' }, form));
  if (!share.url && !share.note && !share.title) leaveShare();
}

// "Install app" button (Android/desktop Chrome) — appears in Settings when installable.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });

// Helpers shared with db.js (Notion-style database views)
window.Burrow = {
  h, $, api, toast, state, store, host, ago, debounce, cssUrl, tagHref, linkifyTags, noteBody, card, openDrawer, currentTheme, tagSuggest,
  refreshMeta: () => loadMeta().then(renderSidebar), onItemsChanged: () => dbReload(),
};

// ───────── boot ─────────
async function boot() {
  let offline = false;
  try { state.me = await api('/me'); store.set('me', state.me); store.set('globalTheme', state.me.theme); }
  catch (e) { state.me = null; offline = e instanceof TypeError; } // TypeError = network failure
  // Offline but signed in before: keep going so shares can be queued.
  if (!state.me && offline && store.get('me')) state.me = store.get('me');
  if (!state.me) { store.set('me', null); state.status = await api('/auth/status'); return render(); }
  $('#app').replaceChildren();
  await loadMeta().catch(() => {});
  flushQueue();
  applyTheme(withDefaults(state.me.theme));
  const share = sharedPayload();
  if (share) return renderShare(share);
  render(); await loadItems(); renderList();
  openLinked();
}
/** A #/b/<id> link opens that bookmark. */
function openLinked() { const id = route().open; if (id) openDrawer(id); }
window.addEventListener('online', () => { if (state.me) flushQueue().then(() => refresh()); });
window.addEventListener('hashchange', async () => {
  if (!state.me) return;
  state.selected.clear(); closeDrawer();
  renderSidebar(); renderMain(); await loadItems(); renderList();
  openLinked();
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q')?.focus(); }
  if (e.key === 'Escape') { closeDrawer(); document.querySelectorAll('.modal, .dialog, .backdrop').forEach(n => n.remove()); }
});
boot();
})();
