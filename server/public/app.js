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
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
document.documentElement.dataset.theme = store.get('theme', 'auto');

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
    case 't': return { kind: 'tag', title: '#' + decodeURIComponent(p[1] || ''), icon: '', filter: { tag: decodeURIComponent(p[1] || '') } };
    case 'spaces': return { kind: 'spaces', title: 'Tab spaces', icon: '🗂' };
    case 'settings': return { kind: 'settings', title: 'Settings', icon: '⚙' };
    default: return { kind: 'all', title: 'Home', icon: '🏠', filter: {} };
  }
}

// ───────── data ─────────
async function loadMeta() {
  const [collections, tags, stats] = await Promise.all([api('/collections'), api('/tags'), api('/stats')]);
  Object.assign(state, { collections, tags, stats });
}
async function loadItems(append = false) {
  const r = route(); if (!r.filter) return;
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
    h('div', { class: 'tag-cloud' }, state.tags.slice(0, 60).map(t =>
      h('a', { class: 'chip', href: `#/t/${encodeURIComponent(t.name)}`, style: r.filter?.tag === t.name ? { background: 'var(--accent)', color: '#fff' } : null }, `#${t.name} `, h('span', { class: 'muted' }, t.count)))),
    h('div', { class: 'grow' }),
    nav('#/settings', '⚙', 'Settings', null, r.kind === 'settings'),
  ].flat().filter(Boolean));
}

function renderMain() {
  const r = route();
  const main = $('.main');
  const search = h('input', { class: 'input', placeholder: 'Search everything…  ( / )', value: state.q, id: 'q',
    oninput: debounce(async e => { state.q = e.target.value.trim(); if (!route().filter) location.hash = '#/'; await loadItems(); renderList(); }, 250) });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn ghost menu-btn', onclick: () => $('.sidebar').classList.toggle('open') }, '☰'),
    h('div', { class: 'search' }, search),
    r.filter ? [
      h('select', { class: 'input', style: { width: 'auto' }, onchange: async e => { state.sort = e.target.value; store.set('sort', state.sort); await loadItems(); renderList(); } },
        [['', state.q ? 'Relevance' : 'Newest'], ['oldest', 'Oldest'], ['title', 'Title']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l))),
      h('button', { class: 'btn', title: 'Toggle layout', onclick: () => { state.layout = state.layout === 'grid' ? 'list' : 'grid'; store.set('layout', state.layout); renderList(); } }, state.layout === 'grid' ? '☰' : '▦'),
    ] : null,
  );
  const content = h('div', { class: 'content' });
  main.replaceChildren(topbar, content);
  if (r.kind === 'spaces') return renderSpaces(content);
  if (r.kind === 'settings') return renderSettings(content);

  const titleRow = h('div', { class: 'page-title' }, r.icon ? h('span', { style: { fontSize: '20px' } }, r.icon) : null, h('h2', {}, r.title),
    h('span', { class: 'grow' }),
    r.kind === 'collection' ? [
      h('button', { class: 'btn small', onclick: () => editCollection(r.id) }, 'Edit'),
    ] : null,
    r.kind === 'tag' ? [
      h('button', { class: 'btn small', onclick: () => renameTag(r.filter.tag) }, 'Rename'),
      h('button', { class: 'btn small danger', onclick: () => deleteTag(r.filter.tag) }, 'Delete tag'),
    ] : null);
  content.append(titleRow);
  if (['all', 'collection', 'unsorted', 'notes', 'tag'].includes(r.kind)) content.append(composer(r));
  content.append(h('div', { id: 'list' }));
  renderList();
}

function composer(r) {
  const ta = h('textarea', { placeholder: 'Paste a link, jot a note, or drop a file…  (Ctrl+Enter to save)', rows: 1,
    oninput: e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; },
    onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); } });
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
  list.replaceChildren(grid, state.hasMore ? h('div', { style: { textAlign: 'center', marginTop: '20px' } },
    h('button', { class: 'btn', onclick: async () => { await loadItems(true); renderList(); } }, 'Load more')) : null);
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
      (b.type === 'note' ? b.note : b.description) ? h('div', { class: 'desc' }, b.type === 'note' ? b.note : b.description) : null,
      b.tags.length ? h('div', { class: 'tags' }, b.tags.map(t => h('span', { class: 'chip' + (t.source === 'ai' ? ' ai' : '') }, t.name))) : null),
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
    renderList(); loadMeta().then(renderSidebar);
    return upd;
  } catch (e) { toast(e.message); }
}
async function del(id) {
  if (!confirm('Delete this item permanently?')) return;
  await api(`/bookmarks/${id}`, { method: 'DELETE' });
  state.items = state.items.filter(x => x.id !== id); closeDrawer(); renderList(); loadMeta().then(renderSidebar);
}

// ───────── detail drawer ─────────
function closeDrawer() { $('.drawer')?.remove(); $('.backdrop.d')?.remove(); state.openId = null; }
async function openDrawer(id) {
  closeDrawer(); state.openId = id;
  const b = await api(`/bookmarks/${id}`);
  const title = h('input', { class: 'input', value: b.title || '' });
  const desc = h('textarea', { class: 'input', rows: 3 }, b.description || '');
  const note = h('textarea', { class: 'input', rows: b.type === 'note' ? 10 : 4, placeholder: 'Your notes…' }, b.note || '');
  let tags = b.tags.map(t => t.name);
  const tagWrap = h('div', { class: 'tag-input' });
  const tagIn = h('input', { placeholder: 'Add tag…', list: 'tag-list', onkeydown: e => {
    if ((e.key === 'Enter' || e.key === ',') && tagIn.value.trim()) { e.preventDefault(); tags.push(tagIn.value.trim().toLowerCase()); tagIn.value = ''; drawTags(); }
    else if (e.key === 'Backspace' && !tagIn.value && tags.length) { tags.pop(); drawTags(); } } });
  const drawTags = () => tagWrap.replaceChildren(...tags.map((t, i) => h('span', { class: 'chip x', title: 'Remove', onclick: () => { tags.splice(i, 1); drawTags(); } }, t + ' ×')), tagIn);
  drawTags();
  const col = h('select', { class: 'input' }, h('option', { value: '' }, '— None —'),
    state.collections.map(c => h('option', { value: c.id, selected: c.id === b.collection_id }, `${c.icon} ${c.name}`)));
  const save = async () => {
    if (tagIn.value.trim()) tags.push(tagIn.value.trim());
    await patch(id, { title: title.value, description: desc.value, note: note.value, tags, collectionId: col.value || null });
    toast('Saved'); closeDrawer();
  };
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
      h('div', { class: 'field' }, h('label', {}, 'Tags'), tagWrap,
        h('datalist', { id: 'tag-list' }, state.tags.map(t => h('option', { value: t.name })))),
      h('div', { class: 'field' }, h('label', {}, 'Collection'), col),
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
  const t = state.tags.find(t => t.name === name); if (!t) return;
  dialog('Rename tag (renaming to an existing tag merges them)', [{ label: 'Name', value: name }], async ([n]) => {
    await api(`/tags/${t.id}`, { method: 'PATCH', body: { name: n } }); await loadMeta();
    location.hash = `#/t/${encodeURIComponent(n.trim().toLowerCase())}`;
  });
}
async function deleteTag(name) {
  const t = state.tags.find(t => t.name === name);
  if (!t || !confirm(`Remove tag #${name} from all items?`)) return;
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
  const tokens = await api('/tokens');
  const tokenOut = h('div');
  const theme = store.get('theme', 'auto');
  el.append(
    h('div', { class: 'page-title' }, h('h2', {}, 'Settings')),
    h('section', { class: 'panel' }, h('h3', {}, 'Account'),
      h('p', {}, 'Signed in as ', h('b', {}, state.me.username), state.me.aiEnabled ? ' · ✦ AI tagging enabled' : ' · AI tagging off (set AI_PROVIDER to enable)'),
      h('div', { class: 'row' },
        h('label', {}, 'Theme '), h('select', { class: 'input', style: { width: 'auto' }, onchange: e => { store.set('theme', e.target.value); document.documentElement.dataset.theme = e.target.value; } },
          ['auto', 'light', 'dark'].map(t => h('option', { selected: t === theme }, t))),
        h('span', { class: 'grow' }),
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

// ───────── boot ─────────
async function boot() {
  try { state.me = await api('/me'); } catch { state.me = null; }
  if (!state.me) { state.status = await api('/auth/status'); return render(); }
  $('#app').replaceChildren();
  await loadMeta(); render(); await loadItems(); renderList();
}
window.addEventListener('hashchange', async () => {
  if (!state.me) return;
  state.selected.clear(); closeDrawer();
  renderSidebar(); renderMain(); await loadItems(); renderList();
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q')?.focus(); }
  if (e.key === 'Escape') { closeDrawer(); document.querySelectorAll('.modal, .dialog, .backdrop').forEach(n => n.remove()); }
});
boot();
})();
