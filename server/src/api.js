const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parseHTML } = require('linkedom');
const { db, DATA_DIR, reindex, tx } = require('./db');
const auth = require('./auth');
const { setTags, syncNoteTags, tagsFor, pruneOrphanTags, cleanTag, tagKey, tagFilterSql } = require('./tags');
const { enqueue } = require('./worker');
const { aiEnabled } = require('./ai');
const { sanitizeTheme } = require('./theme');
const crypto = require('crypto');
const database = require('./database');

const api = express.Router();
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 50 * 1024 * 1024 } });
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === 'true';
const int = v => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ───────────────────────── Auth ─────────────────────────
api.get('/auth/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  res.json({ needsSetup: count === 0, allowSignup: ALLOW_SIGNUP, aiEnabled: aiEnabled(), version: require('../package.json').version });
});

api.post('/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0 && !ALLOW_SIGNUP) return bad(res, 'Sign-ups are disabled', 403);
  if (!username || !/^[\w.-]{2,32}$/.test(username)) return bad(res, 'Username: 2-32 letters, digits, . _ -');
  if (!password || password.length < 8) return bad(res, 'Password must be at least 8 characters');
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(username, auth.hashPassword(password));
    auth.setSessionCookie(req, res, auth.createSession(Number(r.lastInsertRowid)));
    res.json({ ok: true });
  } catch { bad(res, 'Username taken', 409); }
});

api.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || !auth.verifyPassword(password || '', u.password_hash)) return bad(res, 'Invalid credentials', 401);
  auth.setSessionCookie(req, res, auth.createSession(u.id));
  res.json({ ok: true });
});

api.post('/auth/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req.headers.cookie).burrow_session);
  res.setHeader('Set-Cookie', 'burrow_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Everything below requires a session cookie or API token
api.use(auth.requireAuth);
api.use('/integrations/brainwaves', require('./brainwaves'));
api.use(database.router);

api.get('/me', (req, res) => {
  const u = db.prepare('SELECT id, username, created_at, theme FROM users WHERE id = ?').get(req.userId);
  res.json({ ...u, theme: u.theme ? JSON.parse(u.theme) : null, aiEnabled: aiEnabled() });
});

// Global theme: used for Home and every page without its own collection theme
api.put('/me/theme', (req, res) => {
  const theme = sanitizeTheme(req.body?.theme);
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme ? JSON.stringify(theme) : null, req.userId);
  res.json({ theme });
});

// ───────────────────────── Theme images (backgrounds & banners) ─────────────────────────
const themeUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads'),
    filename: (req, file, cb) => cb(null, `theme-${req.userId}-${crypto.randomBytes(12).toString('hex')}${
      { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' }[file.mimetype] || '.bin'}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimetype)),
});
api.post('/theme-images', themeUpload.single('image'), (req, res) => {
  if (!req.file) return bad(res, 'Upload a PNG, JPEG, GIF, WebP or AVIF image');
  res.status(201).json({ url: `/api/theme-images/${req.file.filename}` });
});
api.get('/theme-images/:name', (req, res) => {
  const name = req.params.name;
  if (!new RegExp(`^theme-${req.userId}-[a-f0-9]{24}\\.(png|jpg|gif|webp|avif)$`).test(name)) return bad(res, 'Not found', 404);
  res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(path.join(DATA_DIR, 'uploads', name), err => { if (err && !res.headersSent) bad(res, 'Not found', 404); });
});

api.post('/me/password', (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!auth.verifyPassword(current || '', u.password_hash)) return bad(res, 'Current password is wrong', 403);
  if (!next || next.length < 8) return bad(res, 'New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.userId);
  res.json({ ok: true });
});

// ───────────────────────── API tokens ─────────────────────────
api.get('/tokens', (req, res) => {
  res.json(db.prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC').all(req.userId));
});
api.post('/tokens', (req, res) => {
  const name = (req.body?.name || 'Browser extension').slice(0, 60);
  res.json({ ...auth.createApiToken(req.userId, name), name });
});
api.delete('/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(int(req.params.id), req.userId);
  res.json({ ok: true });
});

// ───────────────────────── Bookmarks ─────────────────────────
const LIST_COLS = `b.id, b.type, b.url, b.title, b.description, b.note, b.image_url, b.favicon, b.site_name,
  b.author, b.has_archive, b.file_name, b.file_mime, b.file_size, b.collection_id, b.favorite, b.archived,
  b.status, b.error, b.created_at, b.updated_at, (b.content_html IS NOT NULL) AS has_reader`;

function withTags(rows) {
  const ids = rows.map(r => r.id);
  const map = tagsFor(ids);
  const props = database.propsFor(ids);
  return rows.map(r => ({ ...r, tags: map[r.id] || [], props: props[r.id] || {} }));
}

/** Split a search into tag filters (tag:#x, tag:x, #x) and free text. */
function parseSearch(q) {
  const tags = [];
  const text = q.replace(/(^|\s)(?:tag:#?|#)([^\s#"]+)/giu, (m, pre, t) => { if (cleanTag(t)) { tags.push(cleanTag(t)); return pre; } return m; });
  return { tags, text: text.trim() };
}

function ftsQuery(q) {
  const terms = q.match(/"[^"]+"|\S+/g) || [];
  return terms.map(t => t.startsWith('"') ? t : `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

api.get('/bookmarks', (req, res) => {
  const { q, tag, collection, favorite, archived, type, sort } = req.query;
  // full=1: database views load a whole page at once and filter/sort/group in the browser
  const limit = req.query.full === '1' ? 5000 : Math.min(int(req.query.limit) || 50, 200);
  const offset = int(req.query.offset) || 0;
  const where = ['b.user_id = ?']; const args = [req.userId];
  let from = 'bookmarks b';
  let order = 'b.created_at DESC, b.id DESC';

  const search = parseSearch(String(q || ''));
  if (search.text) {
    from = 'bookmarks_fts f JOIN bookmarks b ON b.id = f.rowid';
    where.push('bookmarks_fts MATCH ?'); args.push(ftsQuery(search.text));
    if (!sort) order = 'bm25(bookmarks_fts, 10, 5, 4, 1, 3, 6)';
  }
  // Every tag filter must match; each also matches nested children (tag:inbox → inbox/to-read)
  for (const t of [...search.tags, ...(tag ? [tag] : [])]) {
    const f = tagFilterSql(req.userId, t); where.push(f.sql); args.push(...f.args);
  }
  if (collection === 'none') where.push('b.collection_id IS NULL');
  else if (collection) { where.push('b.collection_id = ?'); args.push(int(collection)); }
  if (favorite === '1') where.push('b.favorite = 1');
  if (archived === '1') where.push('b.archived = 1');
  else if (archived !== 'all') where.push('b.archived = 0');
  if (type) { where.push('b.type = ?'); args.push(type); }
  if (sort === 'oldest') order = 'b.created_at ASC';
  if (sort === 'title') order = 'lower(b.title) ASC';

  try {
    const sql = `SELECT ${LIST_COLS} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...args, limit + 1, offset);
    res.json({ items: withTags(rows.slice(0, limit)), hasMore: rows.length > limit });
  } catch (e) { bad(res, 'Bad search query: ' + e.message); }
});

api.get('/bookmarks/lookup', (req, res) => {
  const url = String(req.query.url || '');
  const row = db.prepare(`SELECT ${LIST_COLS} FROM bookmarks b WHERE b.user_id = ? AND b.url = ? LIMIT 1`).get(req.userId, url);
  res.json(row ? withTags([row])[0] : null);
});

function createBookmark(userId, body) {
  const type = body.url ? 'link' : 'note';
  if (type === 'link') {
    try { const u = new URL(body.url); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
    const dupe = db.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND url = ?').get(userId, body.url);
    if (dupe) return { id: dupe.id, duplicate: true };
  } else if (!body.note && !body.title) {
    throw Object.assign(new Error('Provide a url or a note'), { status: 400 });
  }
  return tx(() => {
    const r = db.prepare(`INSERT INTO bookmarks (user_id, type, url, title, description, note, collection_id, favorite, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, unixepoch()))`).run(
      userId, type, body.url || null, body.title || null, body.description || null, body.note || null,
      int(body.collectionId), body.favorite ? 1 : 0, type === 'link' ? 'pending' : 'ready', int(body.createdAt));
    const id = Number(r.lastInsertRowid);
    if (body.tags?.length) setTags(userId, id, body.tags);
    if (body.note) syncNoteTags(userId, id, body.note);
    reindex(id);
    return { id, duplicate: false };
  });
}

api.post('/bookmarks', (req, res) => {
  try {
    const { id, duplicate } = createBookmark(req.userId, req.body || {});
    if (!duplicate && req.body.props) { try { tx(() => database.setProps(req.userId, id, req.body.props)); reindex(id); } catch (e) { return bad(res, e.message, e.status || 400); } }
    if (duplicate && req.body.tags?.length) { setTags(req.userId, id, req.body.tags, { replace: false }); reindex(id); }
    if (!duplicate) enqueue(id);
    const row = db.prepare(`SELECT ${LIST_COLS} FROM bookmarks b WHERE id = ?`).get(id);
    res.status(duplicate ? 200 : 201).json({ ...withTags([row])[0], duplicate });
  } catch (e) { bad(res, e.message, e.status || 500); }
});

api.post('/bookmarks/upload', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'No file');
  const r = db.prepare(`INSERT INTO bookmarks (user_id, type, title, note, file_name, file_mime, file_size, collection_id, status)
    VALUES (?,?,?,?,?,?,?,?, 'pending')`).run(req.userId, 'file', req.body.title || req.file.originalname,
    req.body.note || null, req.file.filename + '|' + req.file.originalname, req.file.mimetype, req.file.size, int(req.body.collectionId));
  const id = Number(r.lastInsertRowid);
  if (req.body.tags) setTags(req.userId, id, String(req.body.tags).split(','));
  if (req.body.note) syncNoteTags(req.userId, id, req.body.note);
  reindex(id); enqueue(id);
  res.status(201).json({ id });
});

function own(req, res) {
  const b = db.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!b) bad(res, 'Not found', 404);
  return b;
}

api.get('/bookmarks/:id', (req, res) => {
  const b = own(req, res); if (!b) return;
  const { content_text, ...rest } = b;
  res.json({ ...withTags([rest])[0], has_reader: !!b.content_html, word_count: content_text ? content_text.split(' ').length : 0 });
});

api.patch('/bookmarks/:id', (req, res) => {
  const b = own(req, res); if (!b) return;
  const fields = { title: 'title', description: 'description', note: 'note', collectionId: 'collection_id',
    favorite: 'favorite', archived: 'archived', url: 'url' };
  const sets = []; const args = [];
  for (const [k, col] of Object.entries(fields)) {
    if (k in req.body) {
      let v = req.body[k];
      if (k === 'favorite' || k === 'archived') v = v ? 1 : 0;
      if (k === 'collectionId') v = int(v);
      sets.push(`${col} = ?`); args.push(v);
    }
  }
  try { if (req.body.props) tx(() => database.setProps(req.userId, b.id, req.body.props)); }
  catch (e) { return bad(res, e.message, e.status || 400); }
  tx(() => {
    if (sets.length || req.body.props) db.prepare(`UPDATE bookmarks SET ${sets.length ? sets.join(', ') + ',' : ''} updated_at = unixepoch() WHERE id = ?`).run(...args, b.id);
    if (Array.isArray(req.body.tags)) setTags(req.userId, b.id, req.body.tags);
    if ('note' in req.body) syncNoteTags(req.userId, b.id, req.body.note || '');
    if (Array.isArray(req.body.tags) || 'note' in req.body) pruneOrphanTags(req.userId);
    reindex(b.id);
  });
  const row = db.prepare(`SELECT ${LIST_COLS} FROM bookmarks b WHERE id = ?`).get(b.id);
  res.json(withTags([row])[0]);
});

function removeFiles(b) {
  fs.rmSync(path.join(DATA_DIR, 'archives', `${b.id}.html`), { force: true });
  if (b.file_name) fs.rmSync(path.join(DATA_DIR, 'uploads', b.file_name.split('|')[0]), { force: true });
}

api.delete('/bookmarks/:id', (req, res) => {
  const b = own(req, res); if (!b) return;
  tx(() => {
    db.prepare('DELETE FROM bookmarks WHERE id = ?').run(b.id);
    db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?').run(b.id);
    database.unlinkBookmark(req.userId, b.id);
    pruneOrphanTags(req.userId);
  });
  removeFiles(b);
  res.json({ ok: true });
});

api.post('/bookmarks/bulk', (req, res) => {
  const { ids = [], action, value } = req.body || {};
  const owned = ids.map(int).filter(id => db.prepare('SELECT 1 FROM bookmarks WHERE id = ? AND user_id = ?').get(id, req.userId));
  tx(() => {
    for (const id of owned) {
      if (action === 'delete') {
        const b = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
        db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
        db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?').run(id);
        database.unlinkBookmark(req.userId, id);
        removeFiles(b);
      } else if (action === 'archive') db.prepare('UPDATE bookmarks SET archived = ? WHERE id = ?').run(value ? 1 : 0, id);
      else if (action === 'favorite') db.prepare('UPDATE bookmarks SET favorite = ? WHERE id = ?').run(value ? 1 : 0, id);
      else if (action === 'move') db.prepare('UPDATE bookmarks SET collection_id = ? WHERE id = ?').run(int(value), id);
      else if (action === 'tag') { setTags(req.userId, id, [value], { replace: false }); reindex(id); }
    }
    pruneOrphanTags(req.userId);
  });
  res.json({ ok: true, count: owned.length });
});

api.post('/bookmarks/:id/refetch', (req, res) => {
  const b = own(req, res); if (!b) return;
  db.prepare(`UPDATE bookmarks SET status = 'pending', error = NULL WHERE id = ?`).run(b.id);
  enqueue(b.id);
  res.json({ ok: true });
});

// Archived snapshot: served sandboxed so nothing in it can run or touch our origin.
api.get('/bookmarks/:id/archive', (req, res) => {
  const b = own(req, res); if (!b) return;
  const file = path.join(DATA_DIR, 'archives', `${b.id}.html`);
  if (!fs.existsSync(file)) return bad(res, 'No archive', 404);
  res.set({ 'Content-Security-Policy': "sandbox; script-src 'none'", 'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'text/html; charset=utf-8' });
  if (req.query.download) res.attachment(`burrow-${b.id}.html`);
  fs.createReadStream(file).pipe(res);
});

api.get('/bookmarks/:id/file', (req, res) => {
  const b = own(req, res); if (!b) return;
  if (!b.file_name) return bad(res, 'No file', 404);
  const [stored, original] = b.file_name.split('|');
  const inline = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|text\/plain)$/.test(b.file_mime || '');
  res.set({ 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff', 'Content-Type': inline ? b.file_mime : 'application/octet-stream' });
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(original || stored)}`);
  fs.createReadStream(path.join(DATA_DIR, 'uploads', stored)).pipe(res);
});

// ───────────────────────── Tags ─────────────────────────
api.get('/tags', (req, res) => {
  res.json(db.prepare(`SELECT t.id, t.name, t.key, COUNT(bt.bookmark_id) AS count FROM tags t
    LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id WHERE t.user_id = ? GROUP BY t.id ORDER BY count DESC, t.key`).all(req.userId));
});

/** Rename one tag; if the new name already exists (any casing) the two are merged. */
function renameOne(userId, t, newName) {
  const key = tagKey(newName);
  const target = db.prepare('SELECT * FROM tags WHERE user_id = ? AND key = ?').get(userId, key);
  if (target && target.id !== t.id) {
    db.prepare('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source) SELECT bookmark_id, ?, source FROM bookmark_tags WHERE tag_id = ?').run(target.id, t.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(t.id);
  } else db.prepare('UPDATE tags SET name = ?, key = ? WHERE id = ?').run(newName, key, t.id);
}

// Renaming #inbox to #todo also renames nested tags (#inbox/x → #todo/x).
api.patch('/tags/:id', (req, res) => {
  const name = cleanTag(req.body?.name);
  if (!name) return bad(res, 'Invalid tag: use letters, numbers, _ - / or emoji, with at least one non-number');
  const t = db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!t) return bad(res, 'Not found', 404);
  const children = db.prepare('SELECT * FROM tags WHERE user_id = ? AND substr(key, 1, ?) = ?').all(req.userId, t.key.length + 1, t.key + '/');
  const ids = [t, ...children].map(x => x.id);
  const affected = db.prepare(`SELECT DISTINCT bookmark_id FROM bookmark_tags WHERE tag_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.bookmark_id);
  tx(() => {
    renameOne(req.userId, t, name);
    for (const c of children) renameOne(req.userId, c, name + c.name.slice(t.name.length));
    // Rewrite #old and #old/child in note text (and YAML tag lists) so notes keep matching their tags
    const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inline = new RegExp(`(^|[\\s(\\[,;])#${esc}(?=/|[^\\p{L}\\p{N}\\p{M}_\\-]|$)`, 'giu');
    const yaml = new RegExp(`^([ \\t]*-[ \\t]*["']?)${esc}(?=/|["']?[ \\t]*$)`, 'gimu');
    const upd = db.prepare('UPDATE bookmarks SET note = ? WHERE id = ?');
    for (const id of affected) {
      const note = db.prepare('SELECT note FROM bookmarks WHERE id = ?').get(id)?.note;
      if (!note) continue;
      let next = note.replace(inline, `$1#${name}`);
      next = next.replace(/^---\r?\n[\s\S]*?\r?\n---/, fm => fm.replace(yaml, `$1${name}`));
      if (next !== note) upd.run(next, id);
    }
    affected.forEach(reindex);
  });
  res.json({ ok: true, name });
});
api.delete('/tags/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!t) return bad(res, 'Not found', 404);
  const affected = db.prepare('SELECT bookmark_id FROM bookmark_tags WHERE tag_id = ?').all(t.id).map(r => r.bookmark_id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(t.id);
  affected.forEach(reindex);
  res.json({ ok: true });
});

// ───────────────────────── Collections ─────────────────────────
api.get('/collections', (req, res) => {
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM bookmarks b WHERE b.collection_id = c.id AND b.archived = 0) AS count
    FROM collections c WHERE c.user_id = ? ORDER BY lower(c.name)`).all(req.userId)
    .map(c => ({ ...c, theme: c.theme ? JSON.parse(c.theme) : null })));
});
api.post('/collections', (req, res) => {
  const { name, icon, color, parentId } = req.body || {};
  if (!name?.trim()) return bad(res, 'Name required');
  const r = db.prepare('INSERT INTO collections (user_id, name, icon, color, parent_id) VALUES (?,?,?,?,?)')
    .run(req.userId, name.trim().slice(0, 80), icon || '📁', color || '#8b5cf6', int(parentId));
  res.status(201).json(db.prepare('SELECT * FROM collections WHERE id = ?').get(Number(r.lastInsertRowid)));
});
api.patch('/collections/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(int(req.params.id), req.userId);
  if (!c) return bad(res, 'Not found', 404);
  const { name = c.name, icon = c.icon, color = c.color } = req.body || {};
  // theme: object = set, null = go back to the global theme, absent = unchanged
  const theme = 'theme' in (req.body || {}) ? sanitizeTheme(req.body.theme) : (c.theme ? JSON.parse(c.theme) : null);
  db.prepare('UPDATE collections SET name = ?, icon = ?, color = ?, theme = ? WHERE id = ?')
    .run(String(name).trim().slice(0, 80) || c.name, icon, color, theme ? JSON.stringify(theme) : null, c.id);
  res.json({ ok: true });
});
api.delete('/collections/:id', (req, res) => {
  db.prepare('DELETE FROM views WHERE user_id = ? AND page = ?').run(req.userId, 'c:' + int(req.params.id));
  db.prepare('DELETE FROM page_settings WHERE user_id = ? AND page = ?').run(req.userId, 'c:' + int(req.params.id));
  db.prepare('DELETE FROM collections WHERE id = ? AND user_id = ?').run(int(req.params.id), req.userId);
  res.json({ ok: true });
});

// ───────────────────────── Tab spaces (extension sync) ─────────────────────────
// Client sends the spaces it changed; server keeps the newest version of each
// (last-write-wins on updated_at) and returns the full current set.
function spaceOut(s) { return { ...s, tabs: JSON.parse(s.tabs), deleted: !!s.deleted, user_id: undefined }; }

api.get('/spaces', (req, res) => {
  res.json(db.prepare('SELECT * FROM spaces WHERE user_id = ? AND deleted = 0 ORDER BY kind, position, updated_at DESC')
    .all(req.userId).map(spaceOut));
});

api.post('/spaces/sync', (req, res) => {
  const incoming = Array.isArray(req.body?.spaces) ? req.body.spaces : [];
  const get = db.prepare('SELECT user_id, updated_at FROM spaces WHERE id = ?');
  const upsert = db.prepare(`INSERT INTO spaces (id, user_id, kind, name, color, emoji, tabs, position, deleted, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, color=excluded.color,
    emoji=excluded.emoji, tabs=excluded.tabs, position=excluded.position, deleted=excluded.deleted, updated_at=excluded.updated_at`);
  tx(() => {
    for (const s of incoming) {
      if (!s?.id || typeof s.id !== 'string' || s.id.length > 64) continue;
      const cur = get.get(s.id);
      if (cur && (cur.user_id !== req.userId || cur.updated_at >= s.updated_at)) continue;
      const tabs = (Array.isArray(s.tabs) ? s.tabs : []).slice(0, 500).map(t => ({
        url: String(t.url || '').slice(0, 4000), title: String(t.title || '').slice(0, 500),
        favIconUrl: String(t.favIconUrl || '').slice(0, 2000), pinned: !!t.pinned,
        group: t.group ? { title: String(t.group.title || '').slice(0, 100), color: String(t.group.color || 'grey') } : null,
      }));
      upsert.run(s.id, req.userId, s.kind === 'stack' ? 'stack' : 'workspace', String(s.name || 'Untitled').slice(0, 100),
        s.color || null, s.emoji || null, JSON.stringify(tabs), int(s.position) || 0, s.deleted ? 1 : 0, Number(s.updated_at) || Date.now());
    }
    // Forget tombstones after 30 days
    db.prepare('DELETE FROM spaces WHERE user_id = ? AND deleted = 1 AND updated_at < ?').run(req.userId, Date.now() - 30 * 864e5);
  });
  res.json({ spaces: db.prepare('SELECT * FROM spaces WHERE user_id = ?').all(req.userId).map(spaceOut) });
});

// ───────────────────────── Stats ─────────────────────────
api.get('/stats', (req, res) => {
  const q = sql => db.prepare(sql).get(req.userId).c;
  res.json({
    all: q('SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND archived = 0'),
    favorites: q('SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND favorite = 1'),
    archived: q('SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND archived = 1'),
    notes: q(`SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND type = 'note'`),
    files: q(`SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND type = 'file'`),
    unsorted: q('SELECT COUNT(*) c FROM bookmarks WHERE user_id = ? AND collection_id IS NULL AND archived = 0'),
  });
});

// ───────────────────────── Import / export ─────────────────────────
api.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at').all(req.userId);
  const tags = tagsFor(rows.map(r => r.id));
  const cols = Object.fromEntries(db.prepare('SELECT id, name FROM collections WHERE user_id = ?').all(req.userId).map(c => [c.id, c.name]));
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  if (req.query.format === 'html') {
    const groups = {};
    for (const b of rows.filter(r => r.url)) (groups[cols[b.collection_id] || ''] ||= []).push(b);
    let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    for (const [g, items] of Object.entries(groups)) {
      if (g) out += `<DT><H3>${esc(g)}</H3>\n<DL><p>\n`;
      for (const b of items) {
        out += `<DT><A HREF="${esc(b.url)}" ADD_DATE="${b.created_at}" TAGS="${esc((tags[b.id] || []).map(t => t.name).join(','))}">${esc(b.title || b.url)}</A>\n`;
        if (b.note) out += `<DD>${esc(b.note)}\n`;
      }
      if (g) out += '</DL><p>\n';
    }
    out += '</DL><p>\n';
    res.attachment('burrow-bookmarks.html').type('html').send(out);
  } else {
    res.attachment('burrow-export.json').json({
      version: 1, exportedAt: new Date().toISOString(),
      collections: db.prepare('SELECT id, name, icon, color FROM collections WHERE user_id = ?').all(req.userId),
      bookmarks: rows.map(b => ({ type: b.type, url: b.url, title: b.title, description: b.description, note: b.note,
        collection: cols[b.collection_id] || null, favorite: !!b.favorite, archived: !!b.archived,
        createdAt: b.created_at, tags: (tags[b.id] || []).map(t => t.name) })),
      spaces: db.prepare('SELECT * FROM spaces WHERE user_id = ? AND deleted = 0').all(req.userId).map(spaceOut),
    });
  }
});

api.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'No file');
  const text = fs.readFileSync(req.file.path, 'utf8');
  fs.rmSync(req.file.path, { force: true });
  const items = [];
  try {
    if (text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      for (const b of data.bookmarks || []) items.push(b);
    } else {
      // Netscape bookmark HTML (Chrome, Firefox, Pocket, Raindrop, Linkwarden, ...).
      // These files are loosely nested, so tokenize instead of trusting a DOM tree.
      const decode = s => parseHTML(`<p>${s}</p>`).document.querySelector('p').textContent.trim();
      const attr = (attrs, n) => (attrs.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1];
      const folders = [];
      const re = /<h3[^>]*>([\s\S]*?)<\/h3>|<\/dl>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(text))) {
        if (m[1] !== undefined) folders.push(decode(m[1]));
        else if (m[0].toLowerCase() === '</dl>') folders.pop();
        else {
          const href = attr(m[2], 'href');
          if (!href) continue;
          items.push({ url: decode(href), title: decode(m[3]), collection: folders.at(-1) || null,
            createdAt: int(attr(m[2], 'add_date')),
            tags: (decode(attr(m[2], 'tags') || '')).split(',').map(t => t.trim()).filter(Boolean) });
        }
      }
    }
  } catch (e) { return bad(res, 'Could not parse file: ' + e.message); }

  const colIds = {};
  const colFor = name => {
    if (!name) return null;
    if (colIds[name]) return colIds[name];
    const c = db.prepare('SELECT id FROM collections WHERE user_id = ? AND name = ?').get(req.userId, name);
    colIds[name] = c ? c.id : Number(db.prepare('INSERT INTO collections (user_id, name) VALUES (?,?)').run(req.userId, name).lastInsertRowid);
    return colIds[name];
  };
  let added = 0, skipped = 0;
  const fetchMeta = req.body.fetch !== 'false';
  for (const it of items) {
    if (it.url && !/^https?:/i.test(it.url)) { skipped++; continue; }
    try {
      const { id, duplicate } = createBookmark(req.userId, { ...it, collectionId: colFor(it.collection) });
      if (duplicate) { skipped++; continue; }
      if (it.archived) db.prepare('UPDATE bookmarks SET archived = 1 WHERE id = ?').run(id);
      added++;
      if (fetchMeta) enqueue(id); else db.prepare(`UPDATE bookmarks SET status = 'ready' WHERE id = ?`).run(id);
    } catch { skipped++; }
  }
  res.json({ added, skipped });
});

module.exports = api;
