const { db } = require('./db');

const norm = t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40);

/** Attach tags to a bookmark. replace=true removes user tags not in the list. */
function setTags(userId, bookmarkId, names, { source = 'user', replace = true } = {}) {
  const clean = [...new Set((names || []).map(norm).filter(Boolean))];
  if (replace) db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').run(bookmarkId);
  const ins = db.prepare('INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT(user_id, name) DO NOTHING');
  const get = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?');
  const link = db.prepare('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source) VALUES (?,?,?)');
  for (const n of clean) {
    ins.run(userId, n);
    link.run(bookmarkId, get.get(userId, n).id, source);
  }
}

function tagsFor(ids) {
  if (!ids.length) return {};
  const rows = db.prepare(
    `SELECT bt.bookmark_id, t.name, bt.source FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.bookmark_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name`
  ).all(...ids);
  const out = {};
  for (const r of rows) (out[r.bookmark_id] ||= []).push({ name: r.name, source: r.source });
  return out;
}

function pruneOrphanTags(userId) {
  db.prepare('DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM bookmark_tags)').run(userId);
}

module.exports = { setTags, tagsFor, pruneOrphanTags, norm };
