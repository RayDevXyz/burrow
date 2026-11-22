// Notion-style databases: custom properties per page, typed values per bookmark,
// and saved views (table / kanban / list / grid) with filters, sorts and grouping.
// Every value is validated here by property type before it is stored.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { db, DATA_DIR, reindex, tx } = require('./db');

const router = express.Router();
const int = v => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

const TYPES = ['text', 'number', 'select', 'status', 'multi_select', 'date', 'formula', 'relation',
  'file', 'checkbox', 'url', 'created_time', 'button', 'id'];
const STORED = new Set(['text', 'number', 'select', 'status', 'multi_select', 'date', 'relation', 'file', 'checkbox', 'url']);
const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const VIEW_TYPES = ['table', 'kanban', 'list', 'grid'];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'INR', 'CNY', 'BRL'];

const newId = () => crypto.randomBytes(4).toString('hex');
const DEFAULT_STATUS = [
  { id: 'todo', name: 'Not started', color: 'gray', group: 'todo' },
  { id: 'doing', name: 'In progress', color: 'blue', group: 'progress' },
  { id: 'done', name: 'Done', color: 'green', group: 'done' },
];

function cleanOptions(list, withGroup) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 200).map(o => ({
    id: typeof o?.id === 'string' && /^[\w-]{1,32}$/.test(o.id) ? o.id : newId(),
    name: str(o?.name, 100).trim() || 'Option',
    color: COLORS.includes(o?.color) ? o.color : 'default',
    ...(withGroup ? { group: ['todo', 'progress', 'done'].includes(o?.group) ? o.group : 'todo' } : {}),
  })).filter(o => !seen.has(o.id) && seen.add(o.id));
}

function cleanConfig(type, c = {}) {
  switch (type) {
    case 'select': case 'multi_select': return { options: cleanOptions(c.options) };
    case 'status': return { options: c.options ? cleanOptions(c.options, true) : DEFAULT_STATUS };
    case 'number': return {
      format: ['number', 'commas', 'percent', 'currency', 'progress'].includes(c.format) ? c.format : 'number',
      currency: CURRENCIES.includes(c.currency) ? c.currency : 'EUR',
      decimals: Math.min(6, Math.max(0, int(c.decimals) ?? 0)),
      max: Number.isFinite(+c.max) && +c.max > 0 ? +c.max : 100,
      color: COLORS.includes(c.color) ? c.color : 'green',
    };
    case 'date': return { format: ['short', 'long', 'iso', 'relative'].includes(c.format) ? c.format : 'short' };
    case 'formula': return { expression: str(c.expression, 4000) };
    // twoWay: a matching relation on the target collection is kept in sync (pairedId is managed by the server)
    case 'relation': return { collectionId: int(c.collectionId), twoWay: !!c.twoWay, pairedId: null };
    case 'id': return { prefix: str(c.prefix, 12).replace(/[^\w-]/g, '') };
    case 'button': return {
      label: str(c.label, 40) || 'Run',
      actions: (Array.isArray(c.actions) ? c.actions : []).slice(0, 10).map(a => ({
        type: ['set', 'archive', 'favorite', 'open'].includes(a?.type) ? a.type : 'set',
        propId: int(a?.propId), value: a?.value ?? null,
      })),
    };
    case 'text': return { };
    default: return {};
  }
}

const iso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v) && !Number.isNaN(Date.parse(v));

/** Validate one value for a property. Returns undefined when the value is invalid. null clears it. */
function cleanValue(userId, prop, v) {
  if (v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const cfg = JSON.parse(prop.config);
  switch (prop.type) {
    case 'text': return typeof v === 'string' ? v.slice(0, 20000) : undefined;
    case 'number': return Number.isFinite(+v) && v !== true && v !== false ? +v : undefined;
    case 'checkbox': return v === true || v === false ? v : undefined;
    case 'url': try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href.slice(0, 4000) : undefined; } catch { return undefined; }
    case 'select': case 'status': return cfg.options.some(o => o.id === v) ? v : undefined;
    case 'multi_select': return Array.isArray(v) ? [...new Set(v.filter(id => cfg.options.some(o => o.id === id)))] : undefined;
    case 'date':
      if (!v || !iso(v.start)) return undefined;
      return { start: v.start, ...(iso(v.end) && v.end >= v.start ? { end: v.end } : {}) };
    case 'relation': {
      if (!Array.isArray(v)) return undefined;
      const ids = [...new Set(v.map(int).filter(Boolean))].slice(0, 200);
      const ok = ids.filter(id => db.prepare('SELECT 1 FROM bookmarks WHERE id = ? AND user_id = ?').get(id, userId));
      return ok;
    }
    case 'file':
      if (!Array.isArray(v)) return undefined;
      return v.slice(0, 50).filter(f => typeof f?.url === 'string' && new RegExp(`^/api/prop-files/pf-${userId}-[a-f0-9]{24}\\.[\\w]{1,8}$`).test(f.url))
        .map(f => ({ url: f.url, name: str(f.name, 200) || 'file', mime: str(f.mime, 100), size: int(f.size) || 0 }));
    default: return undefined; // formula, created_time, button, id are computed, never stored
  }
}

function parseProp(p) { return { ...p, config: JSON.parse(p.config), user_id: undefined }; }
function parseView(v) { return { ...v, config: JSON.parse(v.config), user_id: undefined }; }

function pageOk(userId, page) {
  if (page === 'home') return true;
  const m = /^c:(\d+)$/.exec(page || '');
  return !!(m && db.prepare('SELECT 1 FROM collections WHERE id = ? AND user_id = ?').get(+m[1], userId));
}

/** Property values for many bookmarks: { bookmarkId: { propId: value } } */
function propsFor(ids) {
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    for (const r of db.prepare(`SELECT bookmark_id, prop_id, value FROM prop_values WHERE bookmark_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk))
      (out[r.bookmark_id] ||= {})[r.prop_id] = JSON.parse(r.value);
  }
  return out;
}

// ───────── two-way relations ─────────
const relIds = v => (Array.isArray(v) ? v : []).map(Number);
function readRel(bookmarkId, propId) {
  const r = db.prepare('SELECT value FROM prop_values WHERE bookmark_id = ? AND prop_id = ?').get(bookmarkId, propId);
  return r ? relIds(JSON.parse(r.value)) : [];
}
function writeRel(bookmarkId, propId, ids) {
  if (!ids.length) db.prepare('DELETE FROM prop_values WHERE bookmark_id = ? AND prop_id = ?').run(bookmarkId, propId);
  else db.prepare('INSERT INTO prop_values (bookmark_id, prop_id, value) VALUES (?,?,?) ON CONFLICT DO UPDATE SET value = excluded.value')
    .run(bookmarkId, propId, JSON.stringify([...new Set(ids)]));
}
/** X's relation changed from oldIds to newIds: mirror it on the paired property of each linked page. */
function mirror(bookmarkId, pairedId, oldIds, newIds) {
  for (const y of oldIds.filter(id => !newIds.includes(id))) writeRel(y, pairedId, readRel(y, pairedId).filter(id => id !== bookmarkId));
  for (const y of newIds.filter(id => !oldIds.includes(id))) {
    if (!db.prepare('SELECT 1 FROM bookmarks WHERE id = ?').get(y)) continue;
    const cur = readRel(y, pairedId); if (!cur.includes(bookmarkId)) writeRel(y, pairedId, [...cur, bookmarkId]);
  }
}

/** Create, update or remove the paired property so it matches prop.config.twoWay. */
function syncPairing(userId, propId) {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(propId);
  if (!p || p.type !== 'relation') return;
  const cfg = JSON.parse(p.config);
  const pair = cfg.pairedId ? db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(cfg.pairedId, userId) : null;
  const save = (id, c) => db.prepare('UPDATE properties SET config = ? WHERE id = ?').run(JSON.stringify(c), id);
  if (!cfg.twoWay) {
    if (pair) db.prepare('DELETE FROM properties WHERE id = ?').run(pair.id);
    if (cfg.pairedId) save(p.id, { ...cfg, pairedId: null });
    return;
  }
  const target = cfg.collectionId ?? null;
  if (pair && pair.collection_id === target && JSON.parse(pair.config).collectionId === (p.collection_id ?? null)) return; // already right
  if (pair) db.prepare('DELETE FROM properties WHERE id = ?').run(pair.id);
  // Name the other side after where the links come from, e.g. "Projects" on the Areas pages
  const srcName = p.collection_id ? db.prepare('SELECT name FROM collections WHERE id = ?').get(p.collection_id)?.name : null;
  const name = srcName && srcName !== p.name ? srcName : `${p.name} (linked)`;
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM properties WHERE user_id = ?').get(userId).p;
  const pairId = Number(db.prepare('INSERT INTO properties (user_id, collection_id, name, type, config, position) VALUES (?,?,?,?,?,?)')
    .run(userId, target, name, 'relation', JSON.stringify({ collectionId: p.collection_id ?? null, twoWay: true, pairedId: p.id }), pos).lastInsertRowid);
  save(p.id, { ...cfg, pairedId: pairId });
  // Backfill: every existing link X → Y also appears as Y → X
  for (const r of db.prepare('SELECT bookmark_id, value FROM prop_values WHERE prop_id = ?').all(p.id))
    mirror(r.bookmark_id, pairId, [], relIds(JSON.parse(r.value)));
}

/** Apply { propId: value } changes to one bookmark. Throws on invalid input. */
function setProps(userId, bookmarkId, changes) {
  for (const [pid, raw] of Object.entries(changes || {})) {
    const prop = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(int(pid), userId);
    if (!prop) throw Object.assign(new Error(`Unknown property ${pid}`), { status: 400 });
    if (!STORED.has(prop.type)) throw Object.assign(new Error(`${prop.name} is computed and can't be edited`), { status: 400 });
    const v = cleanValue(userId, prop, raw);
    if (v === undefined) throw Object.assign(new Error(`Invalid value for ${prop.name}`), { status: 400 });
    const pairedId = prop.type === 'relation' ? JSON.parse(prop.config).pairedId : null;
    if (pairedId) mirror(bookmarkId, pairedId, readRel(bookmarkId, prop.id), relIds(v || []));
    if (v === null) db.prepare('DELETE FROM prop_values WHERE bookmark_id = ? AND prop_id = ?').run(bookmarkId, prop.id);
    else db.prepare('INSERT INTO prop_values (bookmark_id, prop_id, value) VALUES (?,?,?) ON CONFLICT DO UPDATE SET value = excluded.value')
      .run(bookmarkId, prop.id, JSON.stringify(v));
  }
}

// ───────── schema for a page: properties + views + settings ─────────
router.get('/schema', (req, res) => {
  const page = String(req.query.page || 'home');
  if (!pageOk(req.userId, page)) return bad(res, 'Unknown page', 404);
  const cid = page === 'home' ? null : +page.slice(2);
  const properties = db.prepare(`SELECT * FROM properties WHERE user_id = ? AND (collection_id IS NULL ${cid ? 'OR collection_id = ?' : ''})
    ORDER BY position, id`).all(...[req.userId, ...(cid ? [cid] : [])]).map(parseProp);
  const views = db.prepare('SELECT * FROM views WHERE user_id = ? AND page = ? ORDER BY position, id').all(req.userId, page).map(parseView);
  const s = db.prepare('SELECT settings FROM page_settings WHERE user_id = ? AND page = ?').get(req.userId, page);
  res.json({ page, properties, views, settings: s ? JSON.parse(s.settings) : {} });
});

// Every property of the user (for formulas/relations across pages)
router.get('/properties', (req, res) => {
  res.json(db.prepare('SELECT * FROM properties WHERE user_id = ? ORDER BY collection_id IS NOT NULL, position, id').all(req.userId).map(parseProp));
});

router.post('/properties', (req, res) => {
  const { name, type, collectionId, config } = req.body || {};
  if (!TYPES.includes(type)) return bad(res, 'Unknown property type');
  const cid = int(collectionId);
  if (cid && !db.prepare('SELECT 1 FROM collections WHERE id = ? AND user_id = ?').get(cid, req.userId)) return bad(res, 'Unknown collection');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM properties WHERE user_id = ?').get(req.userId).p;
  const id = tx(() => {
    const r = db.prepare('INSERT INTO properties (user_id, collection_id, name, type, config, position) VALUES (?,?,?,?,?,?)')
      .run(req.userId, cid, str(name, 80).trim() || 'Property', type, JSON.stringify(cleanConfig(type, config)), pos);
    const newId = Number(r.lastInsertRowid);
    syncPairing(req.userId, newId);
    return newId;
  });
  res.status(201).json(parseProp(db.prepare('SELECT * FROM properties WHERE id = ?').get(id)));
});

router.patch('/properties/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!p) return bad(res, 'Not found', 404);
  const type = TYPES.includes(req.body?.type) ? req.body.type : p.type;
  const config = cleanConfig(type, req.body?.config ?? JSON.parse(p.config));
  if (type === 'relation') config.pairedId = JSON.parse(p.config).pairedId || null; // never taken from the client
  else if (p.type === 'relation' && JSON.parse(p.config).pairedId) // changing away from relation drops the other side
    db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').run(JSON.parse(p.config).pairedId, req.userId);
  const name = req.body?.name !== undefined ? (str(req.body.name, 80).trim() || p.name) : p.name;
  tx(() => {
    db.prepare('UPDATE properties SET name = ?, type = ?, config = ? WHERE id = ?').run(name, type, JSON.stringify(config), p.id);
    // Drop values that no longer fit the (new) type or option list
    const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(p.id);
    for (const r of db.prepare('SELECT bookmark_id, value FROM prop_values WHERE prop_id = ?').all(p.id)) {
      const v = STORED.has(type) ? cleanValue(req.userId, prop, JSON.parse(r.value)) : undefined;
      if (v === undefined || v === null) db.prepare('DELETE FROM prop_values WHERE bookmark_id = ? AND prop_id = ?').run(r.bookmark_id, p.id);
      else db.prepare('UPDATE prop_values SET value = ? WHERE bookmark_id = ? AND prop_id = ?').run(JSON.stringify(v), r.bookmark_id, p.id);
    }
    syncPairing(req.userId, p.id);
    // Turning two-way off on one side turns it off on the other too
    const pairOf = db.prepare(`SELECT id, config FROM properties WHERE user_id = ? AND type = 'relation' AND json_extract(config, '$.pairedId') = ?`).get(req.userId, p.id);
    if (pairOf && type === 'relation' && !config.twoWay) {
      db.prepare('UPDATE properties SET config = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(pairOf.config), twoWay: false, pairedId: null }), pairOf.id);
    }
  });
  res.json(parseProp(db.prepare('SELECT * FROM properties WHERE id = ?').get(p.id)));
});

router.delete('/properties/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!p) return res.json({ ok: true });
  // Deleting one side of a two-way relation deletes the other side too
  const pairedId = p.type === 'relation' ? JSON.parse(p.config).pairedId : null;
  tx(() => {
    db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
    if (pairedId) db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').run(pairedId, req.userId);
  });
  res.json({ ok: true });
});

router.post('/properties/reorder', (req, res) => {
  const upd = db.prepare('UPDATE properties SET position = ? WHERE id = ? AND user_id = ?');
  tx(() => (req.body?.ids || []).forEach((id, i) => upd.run(i, int(id), req.userId)));
  res.json({ ok: true });
});

// ───────── views ─────────
function cleanViewConfig(c = {}) {
  const key = k => (typeof k === 'string' && /^(p\d+|[a-z_]{2,20})$/.test(k) ? k : null);
  return {
    filters: (Array.isArray(c.filters) ? c.filters : []).slice(0, 30).map(f => ({ prop: key(f?.prop), op: str(f?.op, 30), value: f?.value ?? null })).filter(f => f.prop),
    filterMode: c.filterMode === 'or' ? 'or' : 'and',
    sorts: (Array.isArray(c.sorts) ? c.sorts : []).slice(0, 10).map(s => ({ prop: key(s?.prop), dir: s?.dir === 'desc' ? 'desc' : 'asc' })).filter(s => s.prop),
    groupBy: key(c.groupBy),
    hideEmptyGroups: !!c.hideEmptyGroups,
    visible: (Array.isArray(c.visible) ? c.visible : []).map(key).filter(Boolean).slice(0, 100),
    widths: Object.fromEntries(Object.entries(c.widths || {}).filter(([k, w]) => key(k) && Number.isFinite(+w)).map(([k, w]) => [k, Math.min(800, Math.max(60, +w))])),
    cardSize: ['small', 'medium', 'large'].includes(c.cardSize) ? c.cardSize : 'medium',
    showImages: c.showImages !== false,
    limit: Math.min(200, Math.max(0, int(c.limit) || 0)),
  };
}

router.post('/views', (req, res) => {
  const { page, name, type, config } = req.body || {};
  if (!pageOk(req.userId, page)) return bad(res, 'Unknown page');
  if (!VIEW_TYPES.includes(type)) return bad(res, 'Unknown view type');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM views WHERE user_id = ? AND page = ?').get(req.userId, page).p;
  const r = db.prepare('INSERT INTO views (user_id, page, name, type, config, position) VALUES (?,?,?,?,?,?)')
    .run(req.userId, page, str(name, 60).trim() || 'View', type, JSON.stringify(cleanViewConfig(config)), pos);
  res.status(201).json(parseView(db.prepare('SELECT * FROM views WHERE id = ?').get(Number(r.lastInsertRowid))));
});

router.patch('/views/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM views WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!v) return bad(res, 'Not found', 404);
  const name = req.body?.name !== undefined ? (str(req.body.name, 60).trim() || v.name) : v.name;
  const type = VIEW_TYPES.includes(req.body?.type) ? req.body.type : v.type;
  const config = req.body?.config ? cleanViewConfig(req.body.config) : JSON.parse(v.config);
  db.prepare('UPDATE views SET name = ?, type = ?, config = ? WHERE id = ?').run(name, type, JSON.stringify(config), v.id);
  res.json(parseView(db.prepare('SELECT * FROM views WHERE id = ?').get(v.id)));
});

router.delete('/views/:id', (req, res) => {
  db.prepare('DELETE FROM views WHERE id = ? AND user_id = ?').run(int(req.params.id), req.userId);
  res.json({ ok: true });
});

router.post('/views/reorder', (req, res) => {
  const upd = db.prepare('UPDATE views SET position = ? WHERE id = ? AND user_id = ?');
  tx(() => (req.body?.ids || []).forEach((id, i) => upd.run(i, int(id), req.userId)));
  res.json({ ok: true });
});

router.put('/pages/:page/settings', (req, res) => {
  const page = req.params.page;
  if (!pageOk(req.userId, page)) return bad(res, 'Unknown page', 404);
  const s = { layout: req.body?.layout === 'dashboard' ? 'dashboard' : 'tabs' };
  db.prepare('INSERT INTO page_settings (user_id, page, settings) VALUES (?,?,?) ON CONFLICT DO UPDATE SET settings = excluded.settings')
    .run(req.userId, page, JSON.stringify(s));
  res.json(s);
});

// Titles for relation chips (targets can live in other collections)
router.get('/bookmarks-titles', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(int).filter(Boolean).slice(0, 500);
  if (!ids.length) return res.json([]);
  res.json(db.prepare(`SELECT id, title, url, type, favicon FROM bookmarks WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.userId, ...ids));
});

// ───────── files for File properties ─────────
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads'),
    filename: (req, file, cb) => cb(null, `pf-${req.userId}-${crypto.randomBytes(12).toString('hex')}${(path.extname(file.originalname).toLowerCase().match(/^\.[\w]{1,8}$/) || ['.bin'])[0]}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});
router.post('/prop-files', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'No file');
  res.status(201).json({ url: `/api/prop-files/${req.file.filename}`, name: req.file.originalname.slice(0, 200), mime: req.file.mimetype, size: req.file.size });
});
router.get('/prop-files/:name', (req, res) => {
  const name = req.params.name;
  if (!new RegExp(`^pf-${req.userId}-[a-f0-9]{24}\\.[\\w]{1,8}$`).test(name)) return bad(res, 'Not found', 404);
  const inline = /\.(png|jpe?g|gif|webp|avif|pdf|txt)$/i.test(name);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
  if (!inline) res.set('Content-Disposition', 'attachment');
  res.sendFile(path.join(DATA_DIR, 'uploads', name), err => { if (err && !res.headersSent) bad(res, 'Not found', 404); });
});

/** Remove a deleted bookmark from every relation that links to it. */
function unlinkBookmark(userId, bookmarkId) {
  const rows = db.prepare(`SELECT pv.bookmark_id, pv.prop_id, pv.value FROM prop_values pv JOIN properties p ON p.id = pv.prop_id
    WHERE p.user_id = ? AND p.type = 'relation' AND EXISTS (SELECT 1 FROM json_each(pv.value) WHERE json_each.value = ?)`).all(userId, bookmarkId);
  for (const r of rows) writeRel(r.bookmark_id, r.prop_id, relIds(JSON.parse(r.value)).filter(id => id !== bookmarkId));
}

module.exports = { router, propsFor, setProps, unlinkBookmark, reindexAfterProps: reindex };
