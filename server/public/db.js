/* Burrow databases — Notion-style views (table, kanban, list, grid) with typed properties,
 * filters, sorts, grouping, and a dashboard layout. Loaded before app.js; it uses the
 * helpers app.js exposes on window.Burrow at call time. */
(() => {
'use strict';

// The UI builds optional parts as `cond ? element : null`. The DOM's append/prepend/
// replaceChildren would print those as the text "null", so skip empty values app-wide.
for (const m of ['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith']) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const orig = proto[m];
    if (!orig || orig.__burrowSafe) continue;
    const safe = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter(n => n != null && n !== false && n !== '')); };
    safe.__burrowSafe = true;
    proto[m] = safe;
  }
}

const B = () => window.Burrow;
const h = (...a) => B().h(...a);
const F = () => window.BurrowFormula;

// ───────── constants ─────────
const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const HEX = { default: '#8b8b93', gray: '#9b9a97', brown: '#a27763', orange: '#d9730d', yellow: '#cb912f', green: '#448361', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47' };
const TYPES = {
  text: ['≡', 'Text'], number: ['#', 'Number'], select: ['▾', 'Select'], status: ['◔', 'Status'], multi_select: ['☰', 'Multi-select'],
  date: ['📅', 'Date'], formula: ['∑', 'Formula'], relation: ['↗', 'Relation'], file: ['📎', 'Files & media'], checkbox: ['☑', 'Checkbox'],
  url: ['🔗', 'URL'], created_time: ['🕒', 'Created time'], button: ['▶', 'Button'], id: ['№', 'ID'],
  title: ['Aa', 'Title'], tags: ['#', 'Tags'], collection: ['📁', 'Collection'],
};
const VIEW_TYPES = { table: ['▦', 'Table'], kanban: ['▥', 'Board'], list: ['☰', 'List'], grid: ['▣', 'Gallery'] };
const STATUS_GROUPS = [['todo', 'To-do'], ['progress', 'In progress'], ['done', 'Complete']];
const BUILTINS = [
  { key: 'title', name: 'Title', type: 'title', builtin: true },
  { key: 'url', name: 'Link', type: 'url', builtin: true },
  { key: 'tags', name: 'Tags', type: 'tags', builtin: true },
  { key: 'collection', name: 'Collection', type: 'collection', builtin: true },
  { key: 'favorite', name: 'Favorite', type: 'checkbox', builtin: true },
  { key: 'kind', name: 'Type', type: 'select', builtin: true, readonly: true, config: { options: [
    { id: 'link', name: 'Link', color: 'blue' }, { id: 'note', name: 'Note', color: 'yellow' }, { id: 'file', name: 'File', color: 'purple' }] } },
  { key: 'site', name: 'Site', type: 'text', builtin: true, readonly: true },
  { key: 'note', name: 'Note', type: 'text', builtin: true },
  { key: 'created', name: 'Created time', type: 'created_time', builtin: true },
];
const COMPUTED = new Set(['formula', 'created_time', 'button', 'id']);

// ───────── small helpers ─────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const pageCollection = page => (page && page.startsWith('c:') ? +page.slice(2) : null);
const optColor = c => HEX[c] || HEX.default;
const chip = (name, color, extra = {}) => h('span', { class: 'opt', style: { '--oc': optColor(color) }, ...extra }, name);

/** Minimal markdown for Text properties: **bold**, *italic*, `code`, [label](url) and bare links. Input is escaped first. */
function md(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\n/g, '<br>');
  const el = h('span', { class: 'md' }); el.innerHTML = s;
  el.querySelectorAll('a').forEach(a => a.addEventListener('click', e => e.stopPropagation()));
  return el;
}

const parseD = s => (s ? new Date(s.length === 10 ? s + 'T00:00' : s) : null);
function relDay(d) {
  const day = 864e5, t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(d).setHours(0, 0, 0, 0) - t0) / day);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 0 ? `In ${n} days` : `${-n} days ago`;
}
function fmtDate(s, format = 'short') {
  const d = parseD(s); if (!d || Number.isNaN(+d)) return '';
  const time = s.length > 10 ? ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  if (format === 'iso') return s.replace('T', ' ');
  if (format === 'relative') return relDay(d) + time;
  return d.toLocaleDateString(undefined, format === 'long' ? { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }) + time;
}
const fmtDateValue = (v, f) => v?.start ? fmtDate(v.start, f) + (v.end ? ' → ' + fmtDate(v.end, f) : '') : '';

function fmtNumber(v, c = {}) {
  if (v == null || v === '' || Number.isNaN(+v)) return '';
  const d = c.decimals ?? 0, o = { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 0) };
  switch (c.format) {
    case 'commas': return (+v).toLocaleString(undefined, o);
    case 'percent': return (v * 100).toLocaleString(undefined, o) + '%';
    case 'currency': try { return (+v).toLocaleString(undefined, { style: 'currency', currency: c.currency || 'EUR', ...o }); } catch { return String(v); }
    default: return d ? (+v).toFixed(d) : String(Math.round(v * 1e6) / 1e6);
  }
}

// ───────── popovers ─────────
let pop = null;
function closePop() { pop?.close(); }
/** Open a small floating panel next to an element. build(el, close) may return a commit() run on close. */
function popover(anchor, build, { width = 280, className = '' } = {}) {
  closePop();
  const el = h('div', { class: 'db-pop ' + className, style: { width: width + 'px' } });
  document.body.append(el);
  let commit = null, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    if (pop?.el === el) pop = null;
    el.remove();
    if (commit) await commit();
  };
  const outside = e => { if (!el.contains(e.target) && !e.target.closest?.('.tag-suggest')) close(); };
  const key = e => { if (!closed && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  pop = { el, close };
  commit = build(el, close) || null;
  // Position next to the anchor, inside the visible area. On phones the on-screen keyboard
  // shrinks the visual viewport, so re-place the popover above it instead of closing.
  function place() {
    if (closed) return;
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0, vLeft = vv ? vv.offsetLeft : 0;
    const vH = vv ? vv.height : innerHeight, vW = vv ? vv.width : innerWidth;
    el.style.maxHeight = Math.max(160, Math.min(560, vH - 16)) + 'px';
    const r = anchor.isConnected ? anchor.getBoundingClientRect() : { left: vLeft + 8, right: vLeft + 8, top: vTop + 8, bottom: vTop + 8 };
    const w = el.offsetWidth, hgt = el.offsetHeight;
    const left = Math.min(Math.max(vLeft + 8, r.left), vLeft + vW - w - 8);
    let top = r.bottom + 4;
    if (top + hgt > vTop + vH - 8) top = r.top - hgt - 4;          // flip above the anchor
    top = Math.min(Math.max(vTop + 8, top), vTop + vH - hgt - 8);   // keep it on screen
    Object.assign(el.style, { left: Math.max(vLeft + 8, left) + 'px', top: Math.max(vTop + 8, top) + 'px' });
  }
  place();
  // Listen on the next tick (so the opening tap doesn't close it) — but only if it's still open.
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true);
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
  });
  el.querySelector('input:not([type=checkbox]),textarea,select')?.focus();
  return { el, close };
}
const menuItem = (label, fn, cls = '') => h('button', { class: 'db-menu-item ' + cls, onclick: fn }, label);

// ───────── drag to reorder (pointer events: works with mouse and touch) ─────────
/** Rows are the children of `list` with data-idx; dragging a `handle` past a small threshold reorders. */
function sortable(list, { axis = 'y', handle = '.drag-handle', onMove, threshold = 5 }) {
  list.classList.add(axis === 'x' ? 'sort-x' : 'sort-y');
  list.addEventListener('pointerdown', e => {
    const hd = e.target.closest(handle);
    const row = hd?.closest('[data-idx]');
    if (!hd || !row || row.parentNode !== list || e.button > 0) return;
    const from = +row.dataset.idx, sx = e.clientX, sy = e.clientY;
    let to = from, started = false;
    const rows = () => [...list.children].filter(el => el.dataset.idx != null);
    const clear = () => rows().forEach(el => el.classList.remove('drop-before', 'drop-after', 'dragging'));
    const move = ev => {
      if (!started) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return; started = true; }
      ev.preventDefault();
      const els = rows(); clear(); row.classList.add('dragging');
      let idx = els.findIndex(el => { const r = el.getBoundingClientRect(); return axis === 'x' ? ev.clientX < r.left + r.width / 2 : ev.clientY < r.top + r.height / 2; });
      if (idx === -1) { idx = els.length; els[els.length - 1].classList.add('drop-after'); } else els[idx].classList.add('drop-before');
      to = idx > from ? idx - 1 : idx;
    };
    const stop = commit => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
      clear();
      if (!started) return;
      // a drag is not a click: swallow the click that follows pointerup
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, true); setTimeout(() => document.removeEventListener('click', swallow, true), 0);
      if (commit && to !== from) onMove(from, to);
    };
    const up = () => stop(true), cancel = () => stop(false);
    document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
  });
  return list;
}
const moveItem = (arr, from, to) => { const a = [...arr]; a.splice(to, 0, a.splice(from, 1)[0]); return a; };

// ───────── schema & data ─────────
const schemas = {}; // page → { properties, views, settings }
const titleCache = new Map(); // relation targets: id → {title,url,favicon}
const relOptions = new Map(); // relation prop id → pages of its linked collection [{id,title,url}]

/** Load the pages each relation can link to (its linked collection), for pickers, filters and board columns. */
async function loadRelOptions(schema, items) {
  const rels = schema.properties.filter(p => p.type === 'relation');
  await Promise.all(rels.filter(p => p.config.collectionId).map(async p => {
    try {
      const { items: pages } = await B().api(`/bookmarks?collection=${p.config.collectionId}&limit=200&sort=title`);
      relOptions.set(p.id, pages.map(r => ({ id: r.id, title: r.title || r.url || (r.note || '').split('\n')[0] || 'Untitled', url: r.url })));
      pages.forEach(r => titleCache.set(r.id, { id: r.id, title: r.title, url: r.url, favicon: r.favicon }));
    } catch {}
  }));
  const ids = [...new Set(items.flatMap(it => rels.flatMap(p => it.props?.[p.id] || [])))];
  await fetchTitles(ids);
}
function relationChoices(ctx, prop) {
  if (relOptions.has(prop.id)) return relOptions.get(prop.id);
  const ids = [...new Set(ctx.items.flatMap(it => it.props?.[prop.id] || []))];
  return ids.map(id => ({ id, title: titleCache.get(id)?.title || titleCache.get(id)?.url || 'Untitled' }));
}
async function loadSchema(page, force) {
  if (!force && schemas[page]) return schemas[page];
  const s = await B().api('/schema?page=' + encodeURIComponent(page));
  s.properties = s.properties.map(p => ({ ...p, key: 'p' + p.id }));
  return (schemas[page] = s);
}
const allProps = schema => [BUILTINS[0], ...schema.properties, ...BUILTINS.slice(1)];
const findProp = (schema, key) => allProps(schema).find(p => p.key === key);

// ───────── values ─────────
let formulaCache = new Map();
function rawValue(item, prop, schema, stack = []) {
  switch (prop.key) {
    case 'title': return item.title || item.url || (item.note || '').split('\n')[0] || 'Untitled';
    case 'url': return item.url || null;
    case 'tags': return item.tags.map(t => t.name);
    case 'site': return item.site_name || (item.url ? B().host(item.url) : '');
    case 'kind': return item.type;
    case 'favorite': return !!item.favorite;
    case 'collection': return item.collection_id ?? null;
    case 'created': return item.created_at * 1000;
    case 'note': return item.note || '';
  }
  switch (prop.type) {
    case 'created_time': return item.created_at * 1000;
    case 'id': return item.id;
    case 'button': return null;
    case 'formula': return formulaValue(item, prop, schema, stack);
  }
  return item.props?.[prop.id] ?? null;
}

/** Property value as a formula sees it: option names, Dates, numbers, booleans, lists. */
function formulaInput(item, prop, schema, stack) {
  const v = rawValue(item, prop, schema, stack);
  if (v == null) return null;
  const opts = prop.config?.options || [];
  switch (prop.type) {
    case 'select': case 'status': return opts.find(o => o.id === v)?.name ?? null;
    case 'multi_select': return v.map(id => opts.find(o => o.id === id)?.name).filter(Boolean);
    case 'date': return parseD(v.start);
    case 'created_time': return new Date(v);
    case 'relation': return v.map(id => titleCache.get(id)?.title || String(id));
    case 'file': return v.map(f => f.name);
    case 'collection': return B().state.collections.find(c => c.id === v)?.name ?? null;
    case 'formula': return v && v.error ? null : v;
    default: return v;
  }
}
function formulaValue(item, prop, schema, stack) {
  const ck = item.id + ':' + prop.id;
  if (formulaCache.has(ck)) return formulaCache.get(ck);
  if (stack.includes(prop.id)) return { error: 'Formula refers to itself' };
  const f = F().compile(prop.config?.expression || '');
  let out;
  try {
    out = f.run({
      id: () => item.id,
      prop: name => {
        const p = allProps(schema).find(x => x.name.toLowerCase() === String(name).toLowerCase());
        if (!p) throw new Error(`No property "${name}"`);
        return formulaInput(item, p, schema, [...stack, prop.id]);
      },
    });
    if (typeof out === 'number' && !Number.isFinite(out)) out = null;
  } catch (e) { out = { error: e.message }; }
  formulaCache.set(ck, out);
  return out;
}

/** A comparable key for sorting. */
function sortKey(item, prop, schema) {
  const v = rawValue(item, prop, schema);
  if (v == null || v === '') return null;
  const opts = prop.config?.options || [];
  switch (prop.type) {
    case 'select': return opts.findIndex(o => o.id === v);
    case 'status': { const o = opts.find(o => o.id === v); return o ? STATUS_GROUPS.findIndex(g => g[0] === o.group) * 1000 + opts.indexOf(o) : null; }
    case 'multi_select': return v.map(id => opts.find(o => o.id === id)?.name || '').join(',').toLowerCase();
    case 'tags': return v.join(',').toLowerCase();
    case 'date': return +parseD(v.start);
    case 'checkbox': return v ? 1 : 0;
    case 'relation': return v.map(id => (titleCache.get(id)?.title || '').toLowerCase()).sort().join(',') || null;
    case 'file': return v.length;
    case 'collection': return (B().state.collections.find(c => c.id === v)?.name || '').toLowerCase();
    case 'formula': return v?.error ? null : v instanceof Date ? +v : typeof v === 'boolean' ? +v : typeof v === 'string' ? v.toLowerCase() : v;
    default: return typeof v === 'string' ? v.toLowerCase() : v;
  }
}

// ───────── filters ─────────
const T = (op, label, value = true) => ({ op, label, value });
function opsFor(prop) {
  const textOps = [T('contains', 'contains'), T('not_contains', 'does not contain'), T('is', 'is'), T('is_not', 'is not'), T('starts', 'starts with'), T('ends', 'ends with')];
  const numOps = [T('eq', '='), T('neq', '≠'), T('gt', '>'), T('lt', '<'), T('gte', '≥'), T('lte', '≤')];
  const empty = [T('empty', 'is empty', false), T('not_empty', 'is not empty', false)];
  switch (prop.type) {
    case 'title': case 'text': case 'url': return [...textOps, ...empty];
    case 'number': case 'id': return [...numOps, ...empty];
    case 'select': case 'collection': return [T('is', 'is'), T('is_not', 'is not'), ...empty];
    case 'status': return [T('is', 'is'), T('is_not', 'is not'), T('group', 'is in group'), ...empty];
    case 'multi_select': case 'tags': return [T('has', 'contains'), T('has_not', 'does not contain'), ...empty];
    case 'relation': return [T('has', 'contains'), T('has_not', 'does not contain'), ...empty];
    case 'file': return empty;
    case 'checkbox': return [T('checked', 'is checked', false), T('unchecked', 'is not checked', false)];
    case 'date': case 'created_time': return [T('on', 'is'), T('before', 'is before'), T('after', 'is after'), T('on_before', 'is on or before'), T('on_after', 'is on or after'),
      T('today', 'is today', false), T('past_week', 'within past week', false), T('past_month', 'within past month', false),
      T('next_week', 'within next week', false), T('next_month', 'within next month', false), ...(prop.type === 'date' ? empty : [])];
    case 'formula': return [...textOps.slice(0, 3), ...numOps.slice(2), T('checked', 'is true', false), T('unchecked', 'is false', false), ...empty];
    default: return [];
  }
}
function matches(item, f, schema) {
  const prop = findProp(schema, f.prop); if (!prop) return true;
  let v = rawValue(item, prop, schema);
  if (v && v.error) v = null;
  const isEmpty = v == null || v === '' || (Array.isArray(v) && !v.length);
  if (f.op === 'empty') return isEmpty;
  if (f.op === 'not_empty') return !isEmpty;
  if (f.op === 'checked') return !!v;
  if (f.op === 'unchecked') return !v;
  const day = 864e5, today = new Date(); today.setHours(0, 0, 0, 0);
  if (prop.type === 'date' || prop.type === 'created_time' || v instanceof Date) {
    const t = v instanceof Date ? +v : prop.type === 'date' ? (v?.start ? +parseD(v.start) : null) : v;
    if (t == null) return false;
    const dayOf = x => new Date(x).setHours(0, 0, 0, 0);
    const target = f.value ? dayOf(parseD(f.value)) : null;
    switch (f.op) {
      case 'on': return target != null && dayOf(t) === target;
      case 'before': return target != null && dayOf(t) < target;
      case 'after': return target != null && dayOf(t) > target;
      case 'on_before': return target != null && dayOf(t) <= target;
      case 'on_after': return target != null && dayOf(t) >= target;
      case 'today': return dayOf(t) === +today;
      case 'past_week': return t >= +today - 7 * day && t < +today + day;
      case 'past_month': return t >= +today - 30 * day && t < +today + day;
      case 'next_week': return t >= +today && t < +today + 8 * day;
      case 'next_month': return t >= +today && t < +today + 31 * day;
    }
  }
  if (f.value == null || f.value === '') return true; // incomplete rule: ignore
  const list = Array.isArray(v) ? v : null;
  switch (f.op) {
    case 'has': return !!list && list.map(x => String(x).toLowerCase()).includes(String(f.value).toLowerCase());
    case 'has_not': return !list || !list.map(x => String(x).toLowerCase()).includes(String(f.value).toLowerCase());
    case 'group': { const o = prop.config.options.find(o => o.id === v); return o?.group === f.value; }
  }
  if (['eq', 'neq', 'gt', 'lt', 'gte', 'lte'].includes(f.op)) {
    if (isEmpty) return false;
    const a = +v, b = +f.value;
    return { eq: a === b, neq: a !== b, gt: a > b, lt: a < b, gte: a >= b, lte: a <= b }[f.op];
  }
  if (['select', 'status', 'collection'].includes(prop.type)) {
    const same = String(v) === String(f.value);
    return f.op === 'is' ? same : !same;
  }
  const s = (list ? list.join(' ') : String(v ?? '')).toLowerCase(), q = String(f.value).toLowerCase();
  switch (f.op) {
    case 'contains': return s.includes(q);
    case 'not_contains': return !s.includes(q);
    case 'is': return s === q;
    case 'is_not': return s !== q;
    case 'starts': return s.startsWith(q);
    case 'ends': return s.endsWith(q);
  }
  return true;
}

function applyView(items, view, schema) {
  const c = view.config;
  let out = items;
  const rules = (c.filters || []).filter(f => findProp(schema, f.prop));
  if (rules.length) out = out.filter(it => c.filterMode === 'or' ? rules.some(f => matches(it, f, schema)) : rules.every(f => matches(it, f, schema)));
  const sorts = (c.sorts || []).map(s => ({ ...s, prop: findProp(schema, s.prop) })).filter(s => s.prop);
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const x = sortKey(a, s.prop, schema), y = sortKey(b, s.prop, schema);
        if (x === y) continue;
        if (x == null) return 1; if (y == null) return -1; // empty last
        const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
        if (r) return s.dir === 'desc' ? -r : r;
      }
      return 0;
    });
  }
  return out;
}

// ───────── grouping ─────────
const GROUPABLE = new Set(['select', 'status', 'multi_select', 'checkbox', 'tags', 'collection', 'relation']);
function groupsFor(items, prop, schema, view) {
  const none = { id: '__none', name: `No ${prop.name}`, color: 'default', items: [] };
  let groups;
  if (prop.type === 'checkbox') groups = [{ id: 'true', name: `✓ ${prop.name}`, color: 'green', items: [] }, { id: 'false', name: `✗ ${prop.name}`, color: 'gray', items: [] }];
  else if (prop.type === 'tags') groups = [...new Set(items.flatMap(i => i.tags.map(t => t.name)))].sort().map(n => ({ id: n, name: '#' + n, color: 'purple', items: [] }));
  else if (prop.type === 'collection') groups = B().state.collections.map(c => ({ id: String(c.id), name: `${c.icon} ${c.name}`, color: 'blue', items: [] }));
  else if (prop.type === 'status') groups = STATUS_GROUPS.flatMap(([g]) => prop.config.options.filter(o => o.group === g)).map(o => ({ ...o, items: [] }));
  else if (prop.type === 'relation') groups = (relOptions.get(prop.id) || [...new Set(items.flatMap(i => rawValue(i, prop, schema) || []))]
    .map(id => ({ id, title: titleCache.get(id)?.title || titleCache.get(id)?.url || 'Untitled' }))).map(o => ({ id: String(o.id), name: '↗ ' + o.title, color: 'default', items: [] }));
  else groups = (prop.config?.options || []).map(o => ({ ...o, items: [] }));
  const byId = new Map(groups.map(g => [String(g.id), g]));
  for (const it of items) {
    const v = rawValue(it, prop, schema);
    const ids = prop.type === 'checkbox' ? [String(!!v)] : Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    const hit = ids.map(id => byId.get(id)).filter(Boolean);
    if (!hit.length) none.items.push(it); else hit.forEach(g => g.items.push(it));
  }
  if (prop.type !== 'checkbox') groups.push(none);
  return view.config.hideEmptyGroups ? groups.filter(g => g.items.length) : groups;
}

// ───────── saving ─────────
async function saveValue(ctx, item, prop, value) {
  const body = prop.builtin ? ({ title: { title: value }, url: { url: value }, tags: { tags: value }, favorite: { favorite: value },
    collection: { collectionId: value }, note: { note: value } })[prop.key] : { props: { [prop.id]: value } };
  if (!body) return;
  try {
    const upd = await B().api(`/bookmarks/${item.id}`, { method: 'PATCH', body });
    Object.assign(item, upd);
    if (ctx) { formulaCache = new Map(); ctx.draw(); }
    if (prop.key === 'tags' || prop.key === 'collection' || prop.key === 'favorite') B().refreshMeta();
    return upd;
  } catch (e) { B().toast(e.message); }
}

async function updateProperty(prop, changes) {
  const upd = await B().api(`/properties/${prop.id}`, { method: 'PATCH', body: { name: prop.name, type: prop.type, config: prop.config, ...changes } });
  Object.assign(prop, upd, { key: 'p' + upd.id });
  return prop;
}

// ───────── value display ─────────
function renderValue(item, prop, schema, ctx, { compact = false } = {}) {
  const v = rawValue(item, prop, schema);
  const cfg = prop.config || {};
  switch (prop.type) {
    case 'title': return h('span', { class: 'db-title' }, v);
    case 'text': return v ? (compact ? h('span', { class: 'clamp' }, md(v)) : md(v)) : null;
    case 'number': {
      if (v == null) return null;
      if (cfg.format === 'progress') {
        const pct = Math.max(0, Math.min(100, (v / (cfg.max || 100)) * 100));
        return h('span', { class: 'db-progress', title: `${v} / ${cfg.max || 100}` },
          h('span', { class: 'bar' }, h('span', { style: { width: pct + '%', background: optColor(cfg.color) } })), Math.round(pct) + '%');
      }
      return h('span', { class: 'num' }, fmtNumber(v, cfg));
    }
    case 'select': case 'status': {
      const o = (cfg.options || []).find(o => o.id === v); if (!o) return null;
      return prop.type === 'status' ? chip(o.name, o.color, { class: 'opt is-status' }) : chip(o.name, o.color);
    }
    case 'multi_select': return v?.length ? h('span', { class: 'chips' }, v.map(id => (cfg.options || []).find(o => o.id === id)).filter(Boolean).map(o => chip(o.name, o.color))) : null;
    case 'tags': return v.length ? h('span', { class: 'chips' }, v.map(n => h('a', { class: 'opt', style: { '--oc': HEX.purple }, href: B().tagHref(n), onclick: e => e.stopPropagation() }, '#' + n))) : null;
    case 'collection': { const c = B().state.collections.find(c => c.id === v); return c ? chip(`${c.icon} ${c.name}`, 'blue') : null; }
    case 'date': return v ? h('span', { class: 'date' }, fmtDateValue(v, cfg.format)) : null;
    case 'created_time': return h('span', { class: 'date muted' }, fmtDate(new Date(v).toISOString().slice(0, 16), 'short'));
    case 'checkbox': return h('input', { type: 'checkbox', class: 'db-check', checked: !!v, disabled: prop.readonly,
      onclick: e => { e.stopPropagation(); saveValue(ctx, item, prop, e.target.checked); } });
    case 'url': return v ? h('a', { class: 'db-url', href: v, target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation() },
      B().host(v) + (new URL(v).pathname.length > 1 ? new URL(v).pathname.slice(0, 30) : '')) : null;
    case 'id': return h('span', { class: 'muted num' }, (cfg.prefix ? cfg.prefix + '-' : '') + v);
    case 'formula': {
      if (v == null || v === '') return null;
      if (v.error) return h('span', { class: 'db-err', title: v.error }, '⚠ error');
      if (typeof v === 'boolean') return h('input', { type: 'checkbox', class: 'db-check', checked: v, disabled: true });
      if (v instanceof Date) return h('span', { class: 'date' }, fmtDate(v.toISOString().slice(0, 16)));
      if (typeof v === 'number') return h('span', { class: 'num' }, fmtNumber(v, { decimals: Number.isInteger(v) ? 0 : 2 }));
      return h('span', {}, F().toStr(v));
    }
    case 'relation': {
      if (!v?.length) return null;
      const missing = v.filter(id => !titleCache.has(id));
      if (missing.length && ctx) fetchTitles(missing).then(() => ctx.draw());
      return h('span', { class: 'chips' }, v.map(id => {
        const t = titleCache.get(id);
        return h('a', { class: 'opt rel', style: { '--oc': HEX.default }, href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); B().openDrawer(id); } },
          '↗ ' + (t ? (t.title || t.url || 'Untitled') : '…'));
      }));
    }
    case 'file': return v?.length ? h('span', { class: 'chips' }, v.map(f => /^image\//.test(f.mime)
      ? h('a', { href: f.url, target: '_blank', onclick: e => e.stopPropagation(), title: f.name }, h('img', { class: 'db-file-thumb', src: f.url, alt: f.name }))
      : h('a', { class: 'opt', style: { '--oc': HEX.gray }, href: f.url, target: '_blank', onclick: e => e.stopPropagation() }, '📄 ' + f.name))) : null;
    case 'button': return h('button', { class: 'btn small db-btn', onclick: e => { e.stopPropagation(); runButton(ctx, item, prop, schema); } }, '▶ ' + (cfg.label || 'Run'));
  }
  return v == null ? null : String(v);
}

let titlePending = null;
async function fetchTitles(ids) {
  const need = ids.filter(id => !titleCache.has(id));
  if (!need.length) return;
  need.forEach(id => titleCache.set(id, null));
  try { for (const t of await B().api('/bookmarks-titles?ids=' + need.join(','))) titleCache.set(t.id, t); } catch {}
  need.forEach(id => { if (titleCache.get(id) === null) titleCache.set(id, { title: '(deleted)' }); });
}

async function runButton(ctx, item, prop, schema) {
  for (const a of prop.config.actions || []) {
    if (a.type === 'archive') await B().api(`/bookmarks/${item.id}`, { method: 'PATCH', body: { archived: true } });
    else if (a.type === 'favorite') await saveValue(null, item, findProp(schema, 'favorite'), !item.favorite);
    else if (a.type === 'open' && item.url) window.open(item.url, '_blank', 'noopener');
    else if (a.type === 'set') {
      const target = schema.properties.find(p => p.id === a.propId); if (!target) continue;
      let val = a.value;
      if (target.type === 'date' && (val === 'today' || val == null)) { const d = new Date(); val = { start: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }; }
      if (target.type === 'checkbox') val = val === true || val === 'true';
      if (target.type === 'number' && val !== null) val = +val;
      await saveValue(null, item, target, val);
    }
  }
  B().toast(`${prop.config.label || 'Button'} ✓`);
  if (ctx) ctx.reload(); else B().onItemsChanged();
}

// ───────── value editors ─────────
function editable(prop) { return !prop.readonly && !COMPUTED.has(prop.type) && prop.type !== 'checkbox'; }

function editValue(ctx, item, prop, anchor, schema) {
  if (!editable(prop)) return;
  const v = rawValue(item, prop, schema);
  const save = val => saveValue(ctx, item, prop, val);
  const t = prop.type;
  if (t === 'title' || t === 'url' || t === 'number') {
    return popover(anchor, el => {
      const inp = h('input', { class: 'input', type: t === 'number' ? 'number' : t === 'url' ? 'url' : 'text', value: v ?? '', step: 'any',
        placeholder: t === 'url' ? 'https://…' : '', onkeydown: e => { if (e.key === 'Enter') pop?.close(); } });
      el.append(inp);
      return () => {
        const raw = inp.value.trim();
        const val = t === 'number' ? (raw === '' ? null : +raw) : raw || null;
        if (val !== (v ?? null) && !(t === 'title' && !val)) save(val);
      };
    }, { width: Math.max(260, anchor.offsetWidth) });
  }
  if (t === 'text') {
    return popover(anchor, el => {
      const ta = h('textarea', { class: 'input', rows: 6, placeholder: 'Write… **bold**, *italic*, `code`, [link](https://…)',
        onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) pop?.close(); } }, v || '');
      el.append(ta, h('div', { class: 'muted db-hint' }, 'Ctrl+Enter to save'));
      return () => { if (ta.value !== (v || '')) save(ta.value || null); };
    }, { width: Math.max(320, anchor.offsetWidth) });
  }
  if (t === 'select' || t === 'status' || t === 'multi_select') return optionEditor(ctx, item, prop, anchor, v);
  if (t === 'tags') return tagEditor(ctx, item, prop, anchor, v);
  if (t === 'collection') {
    return popover(anchor, (el, close) => {
      el.append(menuItem('— None —', () => { close(); save(null); }),
        ...B().state.collections.map(c => menuItem(`${c.icon} ${c.name}`, () => { close(); save(c.id); }, c.id === v ? 'on' : '')));
    });
  }
  if (t === 'date') return dateEditor(anchor, v, save);
  if (t === 'relation') return relationEditor(ctx, item, prop, anchor, v || []);
  if (t === 'file') return fileEditor(anchor, v || [], save);
}

function optionEditor(ctx, item, prop, anchor, v) {
  const multi = prop.type === 'multi_select';
  let selected = multi ? [...(v || [])] : v;
  return popover(anchor, (el, close) => {
    const search = h('input', { class: 'input', placeholder: multi ? 'Search or create options…' : 'Search or create an option…' });
    const list = h('div', { class: 'db-opts' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const opts = prop.config.options.filter(o => o.name.toLowerCase().includes(q));
      const exact = prop.config.options.some(o => o.name.toLowerCase() === q);
      const row = o => h('div', { class: 'db-opt-row' + ((multi ? selected.includes(o.id) : selected === o.id) ? ' on' : ''), onclick: () => pick(o.id) },
        chip(o.name, o.color), (multi ? selected.includes(o.id) : selected === o.id) ? h('span', { class: 'muted' }, '✓') : null);
      const sections = prop.type === 'status'
        ? STATUS_GROUPS.map(([g, label]) => { const os = opts.filter(o => o.group === g); return os.length ? [h('div', { class: 'db-opt-group' }, label), os.map(row)] : null; })
        : opts.map(row);
      list.replaceChildren(...[
        (multi ? selected.length : selected) ? h('div', { class: 'db-opt-row muted', onclick: () => { selected = multi ? [] : null; if (!multi) close(); else draw(); } }, '✕ Clear') : null,
        sections,
        q && !exact ? h('div', { class: 'db-opt-row create', onclick: () => create(search.value.trim()) }, 'Create ', chip(search.value.trim(), 'default')) : null,
      ].flat(Infinity).filter(Boolean));
    };
    const pick = id => {
      if (multi) { selected = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]; draw(); }
      else { selected = id; close(); }
    };
    const create = async name => {
      const color = COLORS[1 + prop.config.options.length % (COLORS.length - 1)];
      const o = { id: Math.random().toString(16).slice(2, 10), name, color, ...(prop.type === 'status' ? { group: 'todo' } : {}) };
      await updateProperty(prop, { config: { ...prop.config, options: [...prop.config.options, o] } });
      search.value = ''; pick(o.id); if (multi) draw();
    };
    search.addEventListener('input', draw);
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = search.value.trim(); if (!q) return close();
      const hit = prop.config.options.find(o => o.name.toLowerCase() === q.toLowerCase()) || prop.config.options.find(o => o.name.toLowerCase().includes(q.toLowerCase()));
      hit ? pick(hit.id) : create(q);
    });
    el.append(search, list); draw();
    return () => { if (JSON.stringify(selected ?? null) !== JSON.stringify(v ?? (multi ? [] : null))) saveValue(ctx, item, prop, multi ? selected : selected ?? null); };
  });
}

function tagEditor(ctx, item, prop, anchor, v) {
  let selected = [...v];
  return popover(anchor, el => {
    const inp = h('input', { class: 'input', placeholder: 'Add a tag…' });
    const chips = h('div', { class: 'chips db-sel' });
    const draw = () => chips.replaceChildren(...selected.map((n, i) => h('span', { class: 'opt x', style: { '--oc': HEX.purple }, onclick: () => { selected.splice(i, 1); draw(); } }, '#' + n + ' ×')));
    const add = n => { n = n.trim().replace(/^#+/, '').replace(/\s+/g, '-'); if (n && !selected.some(x => x.toLowerCase() === n.toLowerCase())) selected.push(n); inp.value = ''; draw(); inp.focus(); };
    inp.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) { e.preventDefault(); add(inp.value); } });
    B().tagSuggest(inp, { mode: 'list', onPick: add, exclude: () => selected });
    el.append(chips, inp); draw();
    return () => { if (inp.value.trim()) add(inp.value); if (JSON.stringify(selected) !== JSON.stringify(v)) saveValue(ctx, item, prop, selected); };
  });
}

function dateEditor(anchor, v, save) {
  let start = v?.start || '', end = v?.end || '';
  let withTime = start.length > 10, range = !!end;
  return popover(anchor, el => {
    const body = h('div', { class: 'db-date' });
    const draw = () => {
      const type = withTime ? 'datetime-local' : 'date';
      const conv = s => !s ? '' : withTime ? (s.length > 10 ? s : s + 'T09:00') : s.slice(0, 10);
      start = conv(start); end = conv(end);
      body.replaceChildren(
        h('input', { class: 'input', type, value: start, oninput: e => { start = e.target.value; } }),
        range ? h('input', { class: 'input', type, value: end, oninput: e => { end = e.target.value; } }) : null,
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: range, onchange: e => { range = e.target.checked; if (!range) end = ''; draw(); } }), ' End date'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: withTime, onchange: e => { withTime = e.target.checked; draw(); } }), ' Include time'),
        h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => { const d = new Date(); start = withTime ? new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); draw(); } }, 'Today'),
          h('span', { class: 'grow' }), h('button', { class: 'btn small danger', onclick: () => { start = ''; end = ''; pop?.close(); } }, 'Clear')));
    };
    el.append(body); draw();
    return () => {
      const val = start ? { start, ...(range && end && end >= start ? { end } : {}) } : null;
      if (JSON.stringify(val) !== JSON.stringify(v ?? null)) save(val);
    };
  });
}

function relationEditor(ctx, item, prop, anchor, v) {
  let selected = [...v];
  return popover(anchor, el => {
    const target = B().state.collections.find(c => c.id === prop.config.collectionId);
    const inp = h('input', { class: 'input', placeholder: target ? `Search ${target.name}…` : 'Search pages to link…' });
    const chosen = h('div', { class: 'chips db-sel' });
    const results = h('div', { class: 'db-opts' });
    const drawChosen = () => chosen.replaceChildren(...selected.map((id, i) => h('span', { class: 'opt x', style: { '--oc': HEX.default },
      onclick: () => { selected.splice(i, 1); drawChosen(); } }, '↗ ' + (titleCache.get(id)?.title || titleCache.get(id)?.url || '…') + ' ×')));
    const search = B().debounce(async () => {
      const p = new URLSearchParams({ limit: 30, archived: 'all' });
      if (inp.value.trim()) p.set('q', inp.value.trim());
      if (prop.config.collectionId) p.set('collection', prop.config.collectionId);
      const { items } = await B().api('/bookmarks?' + p);
      const q = inp.value.trim();
      const target = B().state.collections.find(c => c.id === prop.config.collectionId);
      const create = q && !items.some(r => (r.title || '').toLowerCase() === q.toLowerCase()) ? h('div', { class: 'db-opt-row create', onclick: async () => {
        try {
          const made = await B().api('/bookmarks', { method: 'POST', body: { title: q, ...(target ? { collectionId: target.id } : {}) } });
          titleCache.set(made.id, { id: made.id, title: made.title }); relOptions.delete(prop.id);
          selected = [...selected, made.id]; inp.value = ''; drawChosen(); search(); B().refreshMeta();
        } catch (e) { B().toast(e.message); }
      } }, `+ New “${q}”${target ? ` in ${target.icon} ${target.name}` : ''}`) : null;
      results.replaceChildren(create, ...items.filter(r => r.id !== item.id).map(r => {
        titleCache.set(r.id, { id: r.id, title: r.title, url: r.url, favicon: r.favicon });
        return h('div', { class: 'db-opt-row' + (selected.includes(r.id) ? ' on' : ''), onclick: () => {
          selected = selected.includes(r.id) ? selected.filter(x => x !== r.id) : [...selected, r.id]; drawChosen(); search(); } },
          h('span', { class: 'clamp' }, (r.type === 'note' ? '📝 ' : '🔗 ') + (r.title || r.url || 'Untitled')), selected.includes(r.id) ? '✓' : null);
      }));
    }, 200);
    inp.addEventListener('input', search);
    el.append(chosen, inp, results);
    fetchTitles(selected).then(drawChosen); drawChosen(); search();
    return () => { if (JSON.stringify(selected) !== JSON.stringify(v)) saveValue(ctx, item, prop, selected); };
  }, { width: 340 });
}

function fileEditor(anchor, v, save) {
  let files = [...v];
  return popover(anchor, el => {
    const list = h('div', { class: 'db-opts' });
    const draw = () => list.replaceChildren(...files.map((f, i) => h('div', { class: 'db-opt-row' },
      h('a', { href: f.url, target: '_blank', class: 'clamp' }, (/^image\//.test(f.mime) ? '🖼 ' : '📄 ') + f.name),
      h('button', { class: 'btn icon', onclick: () => { files.splice(i, 1); draw(); } }, '✕'))));
    const inp = h('input', { type: 'file', multiple: true, hidden: true, onchange: async e => {
      for (const f of e.target.files) {
        const fd = new FormData(); fd.append('file', f);
        try { files.push(await B().api('/prop-files', { method: 'POST', body: fd })); draw(); } catch (x) { B().toast(x.message); }
      }
    } });
    el.append(list, inp, h('button', { class: 'btn small', onclick: () => inp.click() }, '⬆ Upload files'));
    draw();
    return () => { if (JSON.stringify(files) !== JSON.stringify(v)) save(files); };
  });
}

// ───────── property management (page header → ⚙ Properties) ─────────
function addPropertyMenu(anchor, page, onCreated) {
  const cid = pageCollection(page);
  popover(anchor, (el, close) => {
    const name = h('input', { class: 'input', placeholder: 'Property name' });
    let scope = cid ? 'page' : 'all';
    el.append(name,
      cid ? h('div', { class: 'seg db-scope' }, [['page', 'This collection'], ['all', 'All pages']].map(([v, l]) =>
        h('button', { type: 'button', class: v === scope ? 'on' : '', onclick: e => { scope = v; e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); } }, l))) : null,
      h('div', { class: 'db-type-grid' }, Object.entries(TYPES).filter(([k]) => !['title', 'tags', 'collection'].includes(k)).map(([type, [icon, label]]) =>
        h('button', { class: 'db-menu-item', onclick: async () => {
          try {
            const p = await B().api('/properties', { method: 'POST', body: { name: name.value.trim() || label, type, collectionId: scope === 'page' ? cid : null } });
            close(); delete schemas[page]; Object.keys(schemas).forEach(k => delete schemas[k]);
            onCreated?.({ ...p, key: 'p' + p.id });
          } catch (e) { B().toast(e.message); }
        } }, h('span', { class: 'db-ti' }, icon), label))));
  }, { width: 320 });
}

function openPropertiesEditor(page, onDone) {
  document.querySelector('.drawer.props')?.remove(); document.querySelector('.backdrop.props')?.remove();
  const close = () => { document.querySelector('.drawer.props')?.remove(); document.querySelector('.backdrop.props')?.remove(); Object.keys(schemas).forEach(k => delete schemas[k]); onDone?.(); };
  const scroll = h('div', { class: 'scroll' });
  const cid = pageCollection(page);
  const col = B().state.collections.find(c => c.id === cid);
  const expanded = new Set();
  async function draw() {
    const schema = await loadSchema(page, true);
    schemaAll = await B().api('/properties').catch(() => []);
    const props = schema.properties;
    const row = (p, i) => {
      const open = expanded.has(p.id);
      const save = B().debounce(async changes => { try { await updateProperty(p, changes); if (changes.type) draw(); } catch (e) { B().toast(e.message); } }, 350);
      return h('div', { class: 'db-prop' + (open ? ' open' : ''), 'data-idx': i },
        h('div', { class: 'row' },
          h('span', { class: 'drag-handle', title: 'Drag to reorder' }, '⋮⋮'),
          h('span', { class: 'db-ti', title: TYPES[p.type][1] }, TYPES[p.type][0]),
          h('input', { class: 'input grow', value: p.name, oninput: e => { p.name = e.target.value; save({ name: p.name }); } }),
          h('button', { class: 'btn icon', title: 'Settings', onclick: () => { open ? expanded.delete(p.id) : expanded.add(p.id); draw(); } }, open ? '▾' : '⚙')),
        h('div', { class: 'muted db-hint' }, TYPES[p.type][1], ' · ', p.collection_id ? 'only this collection' : 'all pages'),
        open ? propConfig(p, schema, save, draw) : null);
    };
    const list = sortable(h('div', { class: 'db-prop-list' }, props.map(row)), { onMove: async (from, to) => {
      await B().api('/properties/reorder', { method: 'POST', body: { ids: moveItem(props.map(p => p.id), from, to) } }); draw();
    } });
    scroll.replaceChildren(
      h('p', { class: 'muted' }, cid ? `Properties for ${col?.icon || ''} ${col?.name || 'this collection'}. Properties marked "all pages" are shared with Home and every collection.`
        : 'These properties are available on every bookmark. Collections can add their own extra properties.'),
      list,
      props.length ? null : h('div', { class: 'empty', style: { padding: '24px' } }, 'No properties yet.'),
      h('button', { class: 'btn', onclick: e => addPropertyMenu(e.currentTarget, page, p => { expanded.add(p.id); draw(); }) }, '+ Add property'));
  }
  document.body.append(h('div', { class: 'backdrop props', onclick: close, style: { background: 'transparent' } }),
    h('div', { class: 'drawer props' },
      h('header', {}, h('b', { class: 'grow' }, '⚙ Properties'), h('button', { class: 'btn small ghost', onclick: close }, '✕')),
      scroll));
  draw();
}

let schemaAll = []; // every property (to name the other side of two-way relations)
function propConfig(p, schema, save, redraw) {
  const c = p.config;
  const field = (label, ...kids) => h('div', { class: 'field' }, h('label', {}, label), kids);
  const select = (val, opts, on) => h('select', { class: 'input', onchange: e => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
  const typeSel = field('Type', select(p.type, Object.entries(TYPES).filter(([k]) => !['title', 'tags', 'collection'].includes(k)).map(([k, [i, l]]) => [k, `${i}  ${l}`]),
    t => { if (confirm('Changing the type keeps only values that fit the new type. Continue?')) { p.type = t; p.config = {}; save({ type: t, config: {} }); } else redraw(); }));
  const del = h('button', { class: 'btn small danger', onclick: async () => {
    if (!confirm(`Delete the property “${p.name}” and all its values?`)) return;
    await B().api(`/properties/${p.id}`, { method: 'DELETE' }); redraw();
  } }, 'Delete property');
  let body = [];
  if (['select', 'multi_select', 'status'].includes(p.type)) {
    const optRow = (o, i) => h('div', { class: 'row db-optedit' },
      h('select', { class: 'input db-color', style: { color: optColor(o.color) }, onchange: e => { o.color = e.target.value; save({ config: c }); redraw(); } },
        COLORS.map(col => h('option', { value: col, selected: col === o.color, style: { color: optColor(col) } }, '● ' + col))),
      h('input', { class: 'input grow', value: o.name, oninput: e => { o.name = e.target.value; save({ config: c }); } }),
      p.type === 'status' ? h('select', { class: 'input', style: { width: 'auto' }, onchange: e => { o.group = e.target.value; save({ config: c }); } },
        STATUS_GROUPS.map(([g, l]) => h('option', { value: g, selected: g === o.group }, l))) : null,
      h('button', { class: 'btn icon', title: 'Remove option', onclick: () => { c.options.splice(i, 1); save({ config: c }); redraw(); } }, '✕'));
    body = [field('Options', h('div', { class: 'col' }, c.options.map(optRow),
      h('button', { class: 'btn small', onclick: () => { c.options.push({ id: Math.random().toString(16).slice(2, 10), name: 'Option ' + (c.options.length + 1), color: COLORS[1 + c.options.length % 9], ...(p.type === 'status' ? { group: 'todo' } : {}) }); save({ config: c }); redraw(); } }, '+ Add option')))];
  } else if (p.type === 'number') {
    body = [
      field('Format', select(c.format, [['number', 'Number'], ['commas', 'Number with commas'], ['percent', 'Percent'], ['currency', 'Currency'], ['progress', 'Progress bar']], v => { c.format = v; save({ config: c }); redraw(); })),
      c.format === 'currency' ? field('Currency', select(c.currency, ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'INR', 'CNY', 'BRL'].map(x => [x, x]), v => { c.currency = v; save({ config: c }); })) : null,
      c.format === 'progress' ? field('Divide by (100%)', h('input', { class: 'input', type: 'number', value: c.max, oninput: e => { c.max = +e.target.value || 100; save({ config: c }); } })) : null,
      c.format === 'progress' ? field('Bar color', select(c.color, COLORS.map(x => [x, x]), v => { c.color = v; save({ config: c }); })) : null,
      c.format !== 'progress' ? field('Decimals', select(c.decimals, [0, 1, 2, 3, 4].map(x => [x, x]), v => { c.decimals = +v; save({ config: c }); })) : null,
    ];
  } else if (p.type === 'date') {
    body = [field('Date format', select(c.format, [['short', 'Nov 21, 2026'], ['long', 'Sat, November 21, 2026'], ['iso', '2026-11-21'], ['relative', 'Relative (Today, In 3 days)']], v => { c.format = v; save({ config: c }); }))];
  } else if (p.type === 'formula') {
    const preview = h('div', { class: 'db-formula-preview muted' });
    const ta = h('textarea', { class: 'input mono', rows: 4, placeholder: 'prop("Price") * prop("Quantity")', oninput: e => { c.expression = e.target.value; save({ config: c }); check(); } }, c.expression || '');
    const check = () => {
      const f = F().compile(ta.value);
      if (f.error) { preview.textContent = '⚠ ' + f.error; preview.classList.add('db-err'); return; }
      preview.classList.remove('db-err');
      const sample = (B().state.dbItems || [])[0];
      if (!sample) { preview.textContent = '✓ Formula looks valid'; return; }
      formulaCache = new Map();
      const v = formulaValue(sample, { ...p, config: { expression: ta.value } }, schema, []);
      preview.textContent = v?.error ? '⚠ ' + v.error : `✓ Example (${sample.title || 'first item'}): ${v instanceof Date ? v.toLocaleString() : F().toStr(v)}`;
      if (v?.error) preview.classList.add('db-err');
    };
    const insert = s => { const pos = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, pos) + s + ta.value.slice(ta.selectionEnd ?? pos); ta.focus(); ta.dispatchEvent(new Event('input')); };
    body = [field('Formula', ta, preview,
      h('div', { class: 'db-hint' }, 'Properties: ', allProps(schema).filter(x => x.id !== p.id).map(x => h('button', { class: 'linkish', onclick: () => insert(`prop("${x.name}")`) }, x.name))),
      h('details', { class: 'db-hint' }, h('summary', {}, 'Functions & examples'),
        h('p', {}, h('code', {}, 'if(prop("Done"), "✅", "⏳")'), ' · ', h('code', {}, 'prop("Price") * 1.21'), ' · ', h('code', {}, 'dateBetween(prop("Due"), now(), "days")'), ' · ', h('code', {}, 'prop("Title").upper()')),
        h('p', {}, F().functions.join(', '))))];
    setTimeout(check);
  } else if (p.type === 'relation') {
    const target = B().state.collections.find(x => x.id === c.collectionId);
    const pair = c.pairedId ? schemaAll.find(x => x.id === c.pairedId) : null;
    const apply = () => updateProperty(p, { config: c }).then(() => { Object.keys(schemas).forEach(k => delete schemas[k]); redraw(); }).catch(e => B().toast(e.message));
    body = [
      field('Link to pages in', select(c.collectionId ?? '', [['', 'Any page'], ...B().state.collections.map(x => [x.id, `${x.icon} ${x.name}`])], v => { c.collectionId = v ? +v : null; apply(); })),
      h('label', { class: 'row db-menu-check' }, h('input', { type: 'checkbox', checked: !!c.twoWay, onchange: e => { c.twoWay = e.target.checked; apply(); } }),
        ` Show on ${target ? `${target.icon} ${target.name}` : 'the linked pages'} too (two-way)`),
      h('div', { class: 'muted db-hint' }, c.twoWay
        ? `Links show on both sides and stay in sync${pair ? ` — the other side is the “${pair.name}” property` : ''}. Turning this off removes the other side.`
        : 'Turn on to also see, on each linked page, what links to it.'),
    ];
  } else if (p.type === 'id') {
    body = [field('Prefix (optional)', h('input', { class: 'input', value: c.prefix || '', placeholder: 'e.g. TASK', oninput: e => { c.prefix = e.target.value; save({ config: c }); } })),
      h('div', { class: 'muted db-hint' }, 'IDs are generated automatically and can’t be changed.')];
  } else if (p.type === 'button') {
    const targets = schema.properties.filter(x => ['select', 'status', 'checkbox', 'text', 'number', 'date', 'url'].includes(x.type));
    const actRow = (a, i) => {
      const t = targets.find(x => x.id === a.propId);
      let valueInput = null;
      if (a.type === 'set' && t) {
        const set = v => { a.value = v; save({ config: c }); };
        valueInput = ['select', 'status'].includes(t.type) ? select(a.value ?? '', [['', '— clear —'], ...t.config.options.map(o => [o.id, o.name])], v => set(v || null))
          : t.type === 'checkbox' ? select(String(a.value === true || a.value === 'true'), [['true', 'Checked'], ['false', 'Unchecked']], v => set(v === 'true'))
          : t.type === 'date' ? select('today', [['today', 'Today']], () => set('today'))
          : h('input', { class: 'input', type: t.type === 'number' ? 'number' : 'text', value: a.value ?? '', placeholder: 'Value', oninput: e => set(e.target.value) });
      }
      return h('div', { class: 'db-action' },
        h('div', { class: 'row' }, select(a.type, [['set', 'Set property'], ['favorite', 'Toggle favorite'], ['archive', 'Archive'], ['open', 'Open link']], v => { a.type = v; save({ config: c }); redraw(); }),
          h('button', { class: 'btn icon', onclick: () => { c.actions.splice(i, 1); save({ config: c }); redraw(); } }, '✕')),
        a.type === 'set' ? h('div', { class: 'row' }, select(a.propId ?? '', [['', 'Choose property…'], ...targets.map(x => [x.id, x.name])], v => { a.propId = v ? +v : null; a.value = null; save({ config: c }); redraw(); }), valueInput) : null);
    };
    body = [field('Label', h('input', { class: 'input', value: c.label || '', oninput: e => { c.label = e.target.value; save({ config: c }); } })),
      field('When clicked', h('div', { class: 'col' }, (c.actions ||= []).map(actRow),
        h('button', { class: 'btn small', onclick: () => { c.actions.push({ type: 'set', propId: null, value: null }); save({ config: c }); redraw(); } }, '+ Add action')))];
  } else if (p.type === 'text') body = [h('div', { class: 'muted db-hint' }, 'Supports **bold**, *italic*, `code` and [links](https://…).')];
  return h('div', { class: 'db-prop-config' }, typeSel, body, h('div', { class: 'row' }, h('span', { class: 'grow' }), del));
}

// ───────── item drawer section ─────────
async function drawerSection(item, onChange) {
  const page = item.collection_id ? 'c:' + item.collection_id : 'home';
  const wrap = h('div', { class: 'field db-drawer-props' });
  let schema;
  try { schema = await loadSchema(page); } catch { return wrap; }
  const fakeCtx = { draw: () => draw(), reload: () => onChange?.() };
  function draw() {
    formulaCache = new Map();
    wrap.replaceChildren(h('label', { class: 'row' }, 'Properties', h('span', { class: 'grow' }),
      h('button', { class: 'linkish', onclick: () => openPropertiesEditor(page, () => { delete schemas[page]; drawerSection(item, onChange).then(n => wrap.replaceWith(n)); }) }, '⚙ Edit')),
      ...schema.properties.map(p => h('div', { class: 'db-kv' },
        h('div', { class: 'k' }, h('span', { class: 'db-ti' }, TYPES[p.type][0]), p.name),
        h('div', { class: 'v' + (editable(p) ? ' editable' : ''), onclick: e => editValue(fakeCtx, item, p, e.currentTarget, schema) },
          renderValue(item, p, schema, fakeCtx) ?? h('span', { class: 'muted' }, editable(p) ? 'Empty' : '—')))),
      schema.properties.length ? null : h('div', { class: 'muted db-hint' }, 'No properties on this page yet — use ⚙ Edit to add some.'));
  }
  draw();
  const orig = fakeCtx.draw;
  fakeCtx.draw = () => { orig(); onChange?.(); };
  return wrap;
}

// ───────── views ─────────
function defaultVisible(view, schema) {
  if (view.config.visible?.length) return view.config.visible.filter(k => findProp(schema, k) && k !== 'title');
  const custom = schema.properties.map(p => p.key);
  if (view.type === 'table') return [...custom, 'tags', 'created'];
  if (view.type === 'list') return [...custom.slice(0, 4), 'tags'];
  return [...custom.slice(0, 4), 'tags'];
}

/** Render the views of a page (Home or a collection) into a container. */
async function render(container, page, opts = {}) {
  const ctx = { page, container, q: opts.q || '', expanded: new Set() };
  const myToken = (container._dbToken = Math.random());
  container.replaceChildren(h('div', { class: 'db-loading muted' }, h('span', { class: 'spinner' }), ' Loading…'));
  async function load() {
    const params = new URLSearchParams({ full: '1' });
    const cid = pageCollection(page); if (cid) params.set('collection', cid);
    if (ctx.q) params.set('q', ctx.q);
    const [schema, res] = await Promise.all([loadSchema(page, true), B().api('/bookmarks?' + params)]);
    await loadRelOptions(schema, res.items);
    if (container._dbToken !== myToken) return false;
    ctx.schema = schema; ctx.items = res.items; B().state.dbItems = res.items;
    if (!schema.views.length) schema.views = [{ id: null, page, name: 'All', type: B().currentTheme().cards.layout === 'list' ? 'list' : 'grid', config: { filters: [], sorts: [], visible: [], filterMode: 'and' } }];
    const saved = B().store.get('view.' + page, null);
    if (!ctx.activeId || !schema.views.some(v => v.id === ctx.activeId)) ctx.activeId = schema.views.some(v => v.id === saved) ? saved : schema.views[0].id;
    return true;
  }
  ctx.reload = async () => { if (await load()) ctx.draw(); };
  ctx.draw = () => { formulaCache = new Map(); drawPage(ctx); schedulePoll(ctx); };
  try { if (await load()) ctx.draw(); } catch (e) { container.replaceChildren(h('div', { class: 'empty' }, '⚠ ' + e.message)); }
  container._db = ctx;
  return ctx;
}

function schedulePoll(ctx) {
  clearTimeout(ctx.poll);
  if (ctx.items.some(i => i.status === 'pending')) ctx.poll = setTimeout(() => { if (document.body.contains(ctx.container)) ctx.reload(); }, 3000);
}

// The local view object (and its config) stays the source of truth while menus are open,
// so only the id is taken from the server response.
async function persistView(ctx, view) {
  const body = { name: view.name, type: view.type, config: view.config };
  if (view.id == null) {
    view._saving ||= B().api('/views', { method: 'POST', body: { page: ctx.page, ...body } });
    const created = await view._saving;
    if (view.id == null) { view.id = created.id; ctx.activeId = created.id; B().store.set('view.' + ctx.page, created.id); await persistView(ctx, view); }
    delete view._saving;
  } else {
    await B().api(`/views/${view.id}`, { method: 'PATCH', body });
  }
}
const updateView = async (ctx, view, change) => { change(view.config, view); try { await persistView(ctx, view); } catch (e) { B().toast(e.message); } ctx.draw(); };

function drawPage(ctx) {
  const { schema, container } = ctx;
  const dashboard = schema.settings.layout === 'dashboard';
  const views = schema.views;
  const active = views.find(v => v.id === ctx.activeId) || views[0];
  const layoutToggle = h('div', { class: 'seg db-layout', title: 'Show views as tabs, or all at once as a dashboard' },
    [['tabs', 'Tabs'], ['dashboard', 'Dashboard']].map(([v, l]) => h('button', { class: (dashboard ? 'dashboard' : 'tabs') === v ? 'on' : '', onclick: async () => {
      const s = await B().api(`/pages/${encodeURIComponent(ctx.page)}/settings`, { method: 'PUT', body: { layout: v } });
      schema.settings = s; ctx.draw();
    } }, l)));
  const addView = h('button', { class: 'db-tab add', onclick: e => addViewMenu(ctx, e.currentTarget) }, '+ Add view');
  if (!dashboard) {
    const tabs = h('div', { class: 'db-tabs' },
      h('div', { class: 'db-tabs-scroll' }, views.map(v => h('button', { class: 'db-tab' + (v === active ? ' on' : ''),
        onclick: e => { if (v === active) return viewMenu(ctx, v, e.currentTarget); ctx.activeId = v.id; B().store.set("view." + ctx.page, v.id); ctx.draw(); },
 }, h('span', { class: 'db-ti' }, VIEW_TYPES[v.type][0]), v.name))),
      addView, layoutToggle);
    container.replaceChildren(tabs, viewBlock(ctx, active, { showTitle: false }));
    // Keep the active tab visible when the strip scrolls (phones, many views)
    const strip = tabs.querySelector('.db-tabs-scroll'), on = strip.querySelector('.db-tab.on');
    if (on && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2);
  } else {
    container.replaceChildren(h('div', { class: 'db-tabs' }, h('div', { class: 'db-tabs-scroll' }, h('span', { class: 'muted db-dash-label' }, `Dashboard · ${views.length} view${views.length === 1 ? '' : 's'}`), addView), layoutToggle),
      ...views.map(v => viewBlock(ctx, v, { showTitle: true, dashboard: true })));
  }
}

function addViewMenu(ctx, anchor) {
  popover(anchor, (el, close) => {
    const name = h('input', { class: 'input', placeholder: 'View name' });
    el.append(name, h('div', { class: 'db-type-grid' }, Object.entries(VIEW_TYPES).map(([type, [icon, label]]) => h('button', { class: 'db-menu-item', onclick: async () => {
      const cfg = { filters: [], sorts: [], visible: [], filterMode: 'and' };
      if (type === 'kanban') { const g = ctx.schema.properties.find(p => p.type === 'status') || ctx.schema.properties.find(p => p.type === 'select'); cfg.groupBy = g ? g.key : null; }
      try {
        const v = await B().api('/views', { method: 'POST', body: { page: ctx.page, name: name.value.trim() || label, type, config: cfg } });
        if (ctx.schema.views.length === 1 && ctx.schema.views[0].id == null) ctx.schema.views = [];
        ctx.schema.views.push(v); ctx.activeId = v.id; B().store.set('view.' + ctx.page, v.id);
        close(); ctx.draw();
        if (type === 'kanban' && !cfg.groupBy) B().toast('Board view needs a Select or Status property to group by — add one with ⚙ Properties');
      } catch (e) { B().toast(e.message); }
    } }, h('span', { class: 'db-ti' }, icon), label))));
  }, { width: 300 });
}

function viewMenu(ctx, view, anchor) {
  popover(anchor, (el, close) => {
    const name = h('input', { class: 'input', value: view.name, onkeydown: e => { if (e.key === 'Enter') close(); } });
    el.append(name,
      h('div', { class: 'db-type-grid' }, Object.entries(VIEW_TYPES).map(([type, [icon, label]]) => h('button', { class: 'db-menu-item' + (view.type === type ? ' on' : ''),
        onclick: () => updateView(ctx, view, (c, v) => { v.type = type; if (type === 'kanban' && !c.groupBy) { const g = ctx.schema.properties.find(p => ['status', 'select'].includes(p.type)); c.groupBy = g?.key || null; } }) },
        h('span', { class: 'db-ti' }, icon), label))),
      ['grid', 'kanban'].includes(view.type) ? h('label', { class: 'row db-menu-check' }, h('input', { type: 'checkbox', checked: view.config.showImages !== false,
        onchange: e => updateView(ctx, view, c => { c.showImages = e.target.checked; }) }), ' Show preview images') : null,
      view.type === 'grid' ? h('div', { class: 'seg' }, [['small', 'S'], ['medium', 'M'], ['large', 'L']].map(([s, l]) =>
        h('button', { class: view.config.cardSize === s ? 'on' : '', onclick: () => updateView(ctx, view, c => { c.cardSize = s; }) }, 'Cards ' + l))) : null,
      h('label', { class: 'row db-menu-check' }, 'Show at most ', h('input', { class: 'input', type: 'number', min: 0, max: 200, value: view.config.limit || '', placeholder: 'all', style: { width: '70px' },
        onchange: e => updateView(ctx, view, c => { c.limit = +e.target.value || 0; }) }), ' items'),
      h('hr'),
      menuItem('⧉ Duplicate view', async () => {
        close();
        const v = await B().api('/views', { method: 'POST', body: { page: ctx.page, name: view.name + ' copy', type: view.type, config: view.config } });
        if (view.id == null) ctx.schema.views = [];
        ctx.schema.views.push(v); ctx.activeId = v.id; ctx.draw();
      }),
      view.id != null ? menuItem('🗑 Delete view', async () => {
        if (!confirm(`Delete the view “${view.name}”? Your bookmarks are not affected.`)) return;
        close(); await B().api(`/views/${view.id}`, { method: 'DELETE' }); ctx.schema.views = ctx.schema.views.filter(v => v !== view);
        if (!ctx.schema.views.length) await ctx.reload(); else { ctx.activeId = ctx.schema.views[0].id; ctx.draw(); }
      }, 'danger') : null);
    return () => { const n = name.value.trim(); if (n && n !== view.name) { view.name = n; persistView(ctx, view).then(() => ctx.draw()); } };
  }, { width: 300 });
}

function viewToolbar(ctx, view) {
  const c = view.config;
  const btn = (label, count, fn, title) => h('button', { class: 'db-tool' + (count ? ' active' : ''), title, onclick: e => fn(e.currentTarget) }, label, count ? h('span', { class: 'badge' }, count) : null);
  return h('div', { class: 'db-toolbar' },
    btn('⚲ Filter', c.filters.length, a => filterMenu(ctx, view, a)),
    btn('⇅ Sort', c.sorts.length, a => sortMenu(ctx, view, a)),
    btn('⊞ Group', c.groupBy ? 1 : 0, a => groupMenu(ctx, view, a), view.type === 'kanban' ? 'Board columns' : 'Group into sections'),
    btn('☷ Properties', 0, a => visibleMenu(ctx, view, a)),
    h('button', { class: 'db-tool', title: 'View settings', onclick: e => viewMenu(ctx, view, e.currentTarget) }, '⋯'));
}

function propSelect(schema, value, filter, on, placeholder = 'Property') {
  return h('select', { class: 'input', onchange: e => on(e.target.value) }, h('option', { value: '', disabled: true, selected: !value }, placeholder),
    allProps(schema).filter(filter).map(p => h('option', { value: p.key, selected: p.key === value }, `${TYPES[p.type][0]}  ${p.name}`)));
}

function filterValueInput(ctx, prop, f, onChange) {
  const op = opsFor(prop).find(o => o.op === f.op);
  if (!op || !op.value) return null;
  const opts = prop.type === 'collection' ? B().state.collections.map(c => ({ id: String(c.id), name: `${c.icon} ${c.name}` }))
    : prop.type === 'tags' ? B().state.tags.map(t => ({ id: t.name, name: '#' + t.name }))
    : prop.type === 'multi_select' ? (prop.config.options || []).map(o => ({ id: o.name, name: o.name })) : prop.config?.options;
  if (prop.type === 'relation') return h('select', { class: 'input', onchange: e => onChange(e.target.value) }, h('option', { value: '' }, 'Choose a page…'),
    relationChoices(ctx, prop).map(o => h('option', { value: o.id, selected: String(f.value) === String(o.id) }, o.title)));
  if (f.op === 'group') return h('select', { class: 'input', onchange: e => onChange(e.target.value) }, h('option', { value: '' }, 'Choose…'), STATUS_GROUPS.map(([g, l]) => h('option', { value: g, selected: f.value === g }, l)));
  if (opts && ['select', 'status', 'multi_select', 'tags', 'collection'].includes(prop.type))
    return h('select', { class: 'input', onchange: e => onChange(e.target.value) }, h('option', { value: '' }, 'Choose…'), opts.map(o => h('option', { value: o.id, selected: String(f.value) === String(o.id) }, o.name)));
  if (['date', 'created_time'].includes(prop.type)) return h('input', { class: 'input', type: 'date', value: f.value || '', onchange: e => onChange(e.target.value) });
  return h('input', { class: 'input', type: ['number', 'id'].includes(prop.type) ? 'number' : 'text', value: f.value ?? '', placeholder: 'Value', oninput: B().debounce(e => onChange(e.target.value), 300) });
}

function filterMenu(ctx, view, anchor) {
  popover(anchor, el => {
    const c = view.config;
    const draw = () => el.replaceChildren(
      ...c.filters.map((f, i) => {
        const prop = findProp(ctx.schema, f.prop);
        return h('div', { class: 'db-rule' },
          i === 0 ? h('span', { class: 'db-where' }, 'Where') : i === 1 ? h('select', { class: 'input db-where', onchange: e => upd(cc => { cc.filterMode = e.target.value; }) },
            h('option', { value: 'and', selected: c.filterMode === 'and' }, 'And'), h('option', { value: 'or', selected: c.filterMode === 'or' }, 'Or'))
            : h('span', { class: 'db-where' }, c.filterMode === 'or' ? 'Or' : 'And'),
          propSelect(ctx.schema, f.prop, p => opsFor(p).length, k => upd(() => { f.prop = k; f.op = opsFor(findProp(ctx.schema, k))[0].op; f.value = null; })),
          prop ? h('select', { class: 'input', onchange: e => upd(() => { f.op = e.target.value; }) }, opsFor(prop).map(o => h('option', { value: o.op, selected: o.op === f.op }, o.label))) : null,
          prop ? filterValueInput(ctx, prop, f, v => upd(() => { f.value = v; }, false)) : null,
          h('button', { class: 'btn icon', title: 'Remove', onclick: () => upd(() => c.filters.splice(i, 1)) }, '✕'));
      }),
      c.filters.length ? null : h('div', { class: 'muted db-hint' }, 'No filters yet. Filters decide which bookmarks this view shows.'),
      h('button', { class: 'btn small', onclick: () => { const p = allProps(ctx.schema).find(p => opsFor(p).length); upd(() => c.filters.push({ prop: p.key, op: opsFor(p)[0].op, value: null })); } }, '+ Add filter'));
    const upd = (fn, redraw = true) => { updateView(ctx, view, () => fn(view.config)); if (redraw) draw(); };
    draw();
  }, { width: 520, className: 'wide' });
}

function sortMenu(ctx, view, anchor) {
  popover(anchor, el => {
    const c = view.config;
    const upd = fn => { updateView(ctx, view, () => fn()); draw(); };
    const draw = () => el.replaceChildren(
      ...c.sorts.map((s, i) => h('div', { class: 'db-rule' },
        propSelect(ctx.schema, s.prop, p => p.type !== 'button', k => upd(() => { s.prop = k; })),
        h('select', { class: 'input', onchange: e => upd(() => { s.dir = e.target.value; }) }, h('option', { value: 'asc', selected: s.dir === 'asc' }, 'Ascending'), h('option', { value: 'desc', selected: s.dir === 'desc' }, 'Descending')),
        h('button', { class: 'btn icon', onclick: () => upd(() => c.sorts.splice(i, 1)) }, '✕'))),
      c.sorts.length ? null : h('div', { class: 'muted db-hint' }, 'Sorted by newest first. Add a sort to change the order.'),
      h('button', { class: 'btn small', onclick: () => upd(() => c.sorts.push({ prop: 'title', dir: 'asc' })) }, '+ Add sort'));
    draw();
  }, { width: 380 });
}

function groupMenu(ctx, view, anchor) {
  popover(anchor, (el, close) => {
    const c = view.config;
    const options = allProps(ctx.schema).filter(p => GROUPABLE.has(p.type));
    el.append(
      h('div', { class: 'db-pop-title' }, view.type === 'kanban' ? 'Board columns from' : 'Group by'),
      view.type !== 'kanban' ? menuItem('None', () => { close(); updateView(ctx, view, cc => { cc.groupBy = null; }); }, !c.groupBy ? 'on' : '') : null,
      ...options.map(p => menuItem(`${TYPES[p.type][0]}  ${p.name}`, () => { close(); updateView(ctx, view, cc => { cc.groupBy = p.key; }); }, c.groupBy === p.key ? 'on' : '')),
      options.length ? null : h('div', { class: 'muted db-hint' }, 'Add a Select, Status, Multi-select or Checkbox property to group by.'),
      h('label', { class: 'row db-menu-check' }, h('input', { type: 'checkbox', checked: c.hideEmptyGroups, onchange: e => updateView(ctx, view, cc => { cc.hideEmptyGroups = e.target.checked; }) }), ' Hide empty groups'),
      h('hr'), menuItem('⚙ Add or edit properties…', () => { close(); openPropertiesEditor(ctx.page, () => ctx.reload()); }));
  }, { width: 280 });
}

function visibleMenu(ctx, view, anchor) {
  popover(anchor, (el, close) => {
    let vis = defaultVisible(view, ctx.schema);
    const all = allProps(ctx.schema).filter(p => p.key !== 'title');
    let order = [...vis.map(k => all.find(p => p.key === k)).filter(Boolean), ...all.filter(p => !vis.includes(p.key))];
    const list = h('div', { class: 'db-sort-list' });
    const draw = () => list.replaceChildren(...order.map((p, i) => h('div', { class: 'row db-menu-check db-sort-row', 'data-idx': i },
      h('span', { class: 'drag-handle', title: 'Drag to reorder' }, '⋮⋮'),
      h('label', { class: 'row grow' }, h('input', { type: 'checkbox', checked: vis.includes(p.key), onchange: () => toggle(p.key) }), ` ${TYPES[p.type][0]}  ${p.name}`))));
    const commit = () => updateView(ctx, view, c => { c.visible = vis.length ? vis : ['title']; });
    const toggle = k => { vis = vis.includes(k) ? vis.filter(x => x !== k) : order.map(p => p.key).filter(x => x === k || vis.includes(x)); draw(); commit(); };
    sortable(list, { onMove: (from, to) => { order = moveItem(order, from, to); vis = order.map(p => p.key).filter(k => vis.includes(k)); draw(); commit(); } });
    draw();
    el.append(h('div', { class: 'db-pop-title' }, 'Shown in this view · drag ⋮⋮ to reorder'), list,
      h('hr'), menuItem('+ New property', e => { close(); addPropertyMenu(anchor, ctx.page, p => { view.config.visible = [...vis, p.key]; persistView(ctx, view).then(() => ctx.reload()); }); }),
      menuItem('⚙ Edit properties…', () => { close(); openPropertiesEditor(ctx.page, () => ctx.reload()); }));
  }, { width: 280 });
}

function viewBlock(ctx, view, { showTitle, dashboard }) {
  const items = applyView(ctx.items, view, ctx.schema);
  const limit = view.config.limit || (dashboard ? 12 : 0);
  const key = String(view.id);
  const expanded = ctx.expanded.has(key);
  const shown = limit && !expanded ? items.slice(0, limit) : items;
  const block = h('section', { class: 'db-view db-view-' + view.type },
    h('div', { class: 'db-view-head' },
      showTitle ? h('button', { class: 'db-view-title', onclick: e => viewMenu(ctx, view, e.currentTarget) }, h('span', { class: 'db-ti' }, VIEW_TYPES[view.type][0]), view.name, h('span', { class: 'muted' }, ' ' + items.length)) : h('span', { class: 'muted db-count' }, `${items.length} item${items.length === 1 ? '' : 's'}`),
      h('span', { class: 'grow' }), viewToolbar(ctx, view)));
  const groupProp = view.config.groupBy && findProp(ctx.schema, view.config.groupBy);
  if (view.type === 'kanban') block.append(kanban(ctx, view, items, groupProp));
  else if (groupProp) {
    for (const g of groupsFor(shown, groupProp, ctx.schema, view)) {
      const gk = key + ':' + g.id, closed = ctx.expanded.has('closed:' + gk);
      block.append(h('div', { class: 'db-group' },
        h('button', { class: 'db-group-head', onclick: () => { closed ? ctx.expanded.delete('closed:' + gk) : ctx.expanded.add('closed:' + gk); ctx.draw(); } },
          closed ? '▸ ' : '▾ ', chip(g.name, g.color), h('span', { class: 'muted' }, ' ' + g.items.length)),
        closed ? null : body(ctx, view, g.items, { group: g, groupProp })));
    }
  } else block.append(body(ctx, view, shown, {}));
  if (limit && items.length > limit) block.append(h('button', { class: 'btn small db-more', onclick: () => { expanded ? ctx.expanded.delete(key) : ctx.expanded.add(key); ctx.draw(); } },
    expanded ? 'Show less' : `Show all ${items.length}`));
  return block;
}

function body(ctx, view, items, { group, groupProp }) {
  if (view.type === 'table') return table(ctx, view, items, group, groupProp);
  if (view.type === 'list') return list(ctx, view, items, group, groupProp);
  return gallery(ctx, view, items, group, groupProp);
}

const open = id => B().openDrawer(id);

function newItemRow(ctx, view, group, groupProp, label = '+ New') {
  return h('button', { class: 'db-new', onclick: e => newItem(ctx, e.currentTarget, group, groupProp) }, label);
}

/** Create a bookmark or note from a view; it gets the group's value and the page's collection. */
function newItem(ctx, anchor, group, groupProp) {
  popover(anchor, (el, close) => {
    const inp = h('input', { class: 'input', placeholder: 'Title, or paste a link…', onkeydown: async e => {
      if (e.key !== 'Enter' || !inp.value.trim()) return;
      const v = inp.value.trim(); const isUrl = /^https?:\/\/\S+$/i.test(v);
      const body = isUrl ? { url: v } : { title: v, note: '' };
      const cid = pageCollection(ctx.page); if (cid) body.collectionId = cid;
      if (group && groupProp && group.id !== '__none') {
        const k = groupProp.key;
        if (k === 'favorite') body.favorite = group.id === 'true';
        else if (k === 'collection') body.collectionId = +group.id;
        else if (k === 'tags') body.tags = [group.id];
        else if (groupProp.type === 'checkbox') body.props = { [groupProp.id]: group.id === 'true' };
        else if (groupProp.type === 'multi_select') body.props = { [groupProp.id]: [group.id] };
        else if (groupProp.type === 'relation') body.props = { [groupProp.id]: [+group.id] };
        else if (!groupProp.builtin) body.props = { [groupProp.id]: group.id };
      }
      if (!isUrl && !body.title) return;
      try { await B().api('/bookmarks', { method: 'POST', body: isUrl ? body : { ...body, note: undefined, title: v } }); close(); ctx.reload(); B().refreshMeta(); }
      catch (x) { B().toast(x.message); }
    } });
    el.append(inp, h('div', { class: 'muted db-hint' }, 'Enter to add'));
  });
}

function cellFor(ctx, item, prop, { compact = true } = {}) {
  const v = renderValue(item, prop, ctx.schema, ctx, { compact });
  return h('div', { class: 'db-cell t-' + prop.type + (editable(prop) ? ' editable' : ''), onclick: e => { e.stopPropagation(); editValue(ctx, item, prop, e.currentTarget, ctx.schema); } }, v ?? '');
}

function table(ctx, view, items, group, groupProp) {
  const cols = defaultVisible(view, ctx.schema).map(k => findProp(ctx.schema, k)).filter(Boolean);
  const widths = view.config.widths || {};
  const w = p => (widths[p.key] || (p.type === 'title' ? 280 : ['checkbox', 'favorite'].includes(p.type) ? 90 : p.type === 'text' ? 240 : 170)) + 'px';
  const title = findProp(ctx.schema, 'title');
  const head = h('div', { class: 'db-tr db-th' }, [title, ...cols].map((p, i) => h('div', { class: 'db-td', style: { width: w(p) }, 'data-idx': i ? i - 1 : null },
    h('button', { class: 'db-th-btn', onclick: e => headerMenu(ctx, view, p, e.currentTarget) }, h('span', { class: 'db-ti' }, TYPES[p.type][0]), p.name),
    h('span', { class: 'db-resize', onmousedown: e => startResize(e, ctx, view, p) }))),
    h('div', { class: 'db-td add' }, h('button', { class: 'db-th-btn', title: 'Add a property', onclick: e => addPropertyMenu(e.currentTarget, ctx.page, p => {
      view.config.visible = [...defaultVisible(view, ctx.schema), p.key]; persistView(ctx, view).then(() => ctx.reload()); }) }, '+')));
  sortable(head, { axis: 'x', handle: '.db-th-btn', onMove: (from, to) => updateView(ctx, view, c => { c.visible = moveItem(cols.map(p => p.key), from, to); }) });
  const rows = items.map(it => h('div', { class: 'db-tr' },
    h('div', { class: 'db-td db-title-cell', style: { width: w(title) }, onclick: () => open(it.id) },
      it.favicon ? h('img', { src: it.favicon, alt: '', class: 'fav', onerror: e => e.target.remove() }) : h('span', { class: 'fav' }, { note: '📝', file: '📄', link: '🔗' }[it.type]),
      h('span', { class: 'clamp' }, rawValue(it, title, ctx.schema)),
      it.status === 'pending' ? h('span', { class: 'spinner' }) : null,
      h('button', { class: 'db-open', onclick: e => { e.stopPropagation(); open(it.id); } }, 'Open')),
    cols.map(p => h('div', { class: 'db-td', style: { width: w(p) } }, cellFor(ctx, it, p)))));
  return h('div', { class: 'db-table-wrap' }, h('div', { class: 'db-table' }, head, rows,
    h('div', { class: 'db-tr db-foot' }, newItemRow(ctx, view, group, groupProp))));
}

function startResize(e, ctx, view, p) {
  e.preventDefault(); e.stopPropagation();
  const cell = e.target.parentNode, startX = e.clientX, startW = cell.offsetWidth;
  const colIdx = [...cell.parentNode.children].indexOf(cell);
  const tableEl = cell.closest('.db-table');
  const move = ev => { const nw = Math.max(60, Math.min(800, startW + ev.clientX - startX)); tableEl.querySelectorAll('.db-tr').forEach(r => { const c = r.children[colIdx]; if (c) c.style.width = nw + 'px'; }); };
  const up = ev => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    const nw = Math.max(60, Math.min(800, startW + ev.clientX - startX));
    view.config.widths = { ...(view.config.widths || {}), [p.key]: nw }; persistView(ctx, view);
  };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}

function headerMenu(ctx, view, prop, anchor) {
  popover(anchor, (el, close) => {
    el.append(h('div', { class: 'db-pop-title' }, `${TYPES[prop.type][0]}  ${prop.name}`),
      prop.type !== 'button' ? menuItem('↑ Sort ascending', () => { close(); updateView(ctx, view, c => { c.sorts = [{ prop: prop.key, dir: 'asc' }]; }); }) : null,
      prop.type !== 'button' ? menuItem('↓ Sort descending', () => { close(); updateView(ctx, view, c => { c.sorts = [{ prop: prop.key, dir: 'desc' }]; }); }) : null,
      opsFor(prop).length ? menuItem('⚲ Filter', () => { close(); updateView(ctx, view, c => { c.filters.push({ prop: prop.key, op: opsFor(prop)[0].op, value: null }); }); setTimeout(() => { const b = ctx.container.querySelector('.db-tool'); if (b) filterMenu(ctx, view, b); }, 50); }) : null,
      GROUPABLE.has(prop.type) ? menuItem('⊞ Group by this', () => { close(); updateView(ctx, view, c => { c.groupBy = prop.key; }); }) : null,
      prop.key !== 'title' ? menuItem('👁 Hide in this view', () => { close(); updateView(ctx, view, c => { c.visible = defaultVisible(view, ctx.schema).filter(k => k !== prop.key); if (!c.visible.length) c.visible = ['title']; }); }) : null,
      !prop.builtin ? [h('hr'), menuItem('⚙ Edit property…', () => { close(); openPropertiesEditor(ctx.page, () => ctx.reload()); })] : null);
  }, { width: 240 });
}

function propPills(ctx, view, item) {
  const props = defaultVisible(view, ctx.schema).map(k => findProp(ctx.schema, k)).filter(Boolean);
  const out = props.map(p => { const v = renderValue(item, p, ctx.schema, ctx, { compact: true }); return v == null || v === '' ? null : h('span', { class: 'db-pill', title: p.name, onclick: e => { e.stopPropagation(); editValue(ctx, item, p, e.currentTarget, ctx.schema); } }, v); }).filter(Boolean);
  return out.length ? h('div', { class: 'db-pills' }, out) : null;
}

function list(ctx, view, items, group, groupProp) {
  return h('div', { class: 'db-list' }, items.map(it => h('div', { class: 'db-row', onclick: () => open(it.id) },
    it.favicon ? h('img', { src: it.favicon, alt: '', class: 'fav', onerror: e => e.target.remove() }) : h('span', { class: 'fav' }, { note: '📝', file: '📄', link: '🔗' }[it.type]),
    h('div', { class: 'db-row-main' }, h('div', { class: 'db-row-title' }, rawValue(it, BUILTINS[0], ctx.schema)),
      it.url ? h('div', { class: 'muted db-row-sub' }, it.site_name || B().host(it.url)) : null),
    propPills(ctx, view, it))), newItemRow(ctx, view, group, groupProp));
}

function gallery(ctx, view, items, group, groupProp) {
  const grid = h('div', { class: 'grid db-gallery', style: { '--card-min': { small: '190px', medium: '250px', large: '330px' }[view.config.cardSize || 'medium'] } },
    items.map(it => {
      const c = B().card(it);
      c.querySelector('.check')?.remove();
      if (view.config.showImages === false) c.querySelector('.thumb')?.remove();
      const pills = propPills(ctx, view, it);
      if (pills) { c.querySelector('.tags')?.remove(); c.querySelector('.body').append(pills); }
      return c;
    }));
  return h('div', {}, grid, newItemRow(ctx, view, group, groupProp));
}

function kanban(ctx, view, items, groupProp) {
  if (!groupProp) return h('div', { class: 'empty' }, h('p', {}, 'A board needs a property to make columns from.'),
    h('button', { class: 'btn primary', onclick: e => groupMenu(ctx, view, e.currentTarget) }, 'Choose columns'));
  const canDrag = !groupProp.readonly;
  const groups = groupsFor(items, groupProp, ctx.schema, view);
  return h('div', { class: 'db-board' }, groups.map(g => h('div', { class: 'db-col', style: { '--oc': optColor(g.color) },
    ondragover: e => { if (canDrag && e.dataTransfer.types.includes('text/burrow-item')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
    ondragleave: e => e.currentTarget.classList.remove('drop'),
    ondrop: async e => {
      e.currentTarget.classList.remove('drop');
      const [id, from] = e.dataTransfer.getData('text/burrow-item').split('|');
      const item = ctx.items.find(i => i.id === +id); if (!item || from === String(g.id)) return;
      e.preventDefault();
      await moveToGroup(ctx, item, groupProp, from, g.id);
    } },
    h('div', { class: 'db-col-head' }, chip(g.name, g.color), h('span', { class: 'muted' }, g.items.length), h('span', { class: 'grow' }),
      h('button', { class: 'btn icon', title: 'Add to this column', onclick: e => newItem(ctx, e.currentTarget, g, groupProp) }, '+')),
    h('div', { class: 'db-col-body' }, g.items.map(it => {
      const img = view.config.showImages !== false && (it.type === 'file' && /^image\//.test(it.file_mime || '') ? `/api/bookmarks/${it.id}/file` : it.image_url);
      return h('div', { class: 'db-kcard', draggable: canDrag, onclick: () => open(it.id),
        ondragstart: e => { e.dataTransfer.setData('text/burrow-item', it.id + '|' + g.id); e.currentTarget.classList.add('dragging'); },
        ondragend: e => e.currentTarget.classList.remove('dragging') },
        img ? h('div', { class: 'db-kimg', style: { backgroundImage: B().cssUrl(img) } }) : null,
        h('div', { class: 'db-ktitle' }, it.favicon ? h('img', { src: it.favicon, alt: '', class: 'fav', onerror: e => e.target.remove() }) : null, rawValue(it, BUILTINS[0], ctx.schema)),
        propPills(ctx, { ...view, config: { ...view.config, visible: defaultVisible(view, ctx.schema).filter(k => k !== groupProp.key) } }, it));
    }), newItemRow(ctx, view, g, groupProp, '+ New')))));
}

async function moveToGroup(ctx, item, prop, from, to) {
  let v;
  if (prop.type === 'checkbox') v = to === 'true';
  else if (prop.type === 'collection') v = to === '__none' ? null : +to;
  else if (prop.type === 'multi_select' || prop.type === 'tags') {
    const cur = rawValue(item, prop, ctx.schema) || [];
    v = cur.filter(x => String(x) !== from); if (to !== '__none' && !v.includes(to)) v.push(to);
  } else if (prop.type === 'relation') {
    const cur = rawValue(item, prop, ctx.schema) || [];
    v = cur.filter(x => String(x) !== from); if (to !== '__none' && !v.includes(+to)) v.push(+to);
  } else v = to === '__none' ? null : to;
  await saveValue(ctx, item, prop, v);
  if (prop.key === 'collection' && pageCollection(ctx.page)) ctx.reload();
}

window.BurrowDB = { render, openPropertiesEditor, drawerSection, invalidate: () => Object.keys(schemas).forEach(k => delete schemas[k]) };
})();
