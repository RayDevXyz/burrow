// Tags follow Obsidian's rules:
//  • letters, numbers, _ - / and Unicode symbols/emoji; no spaces
//  • at least one non-numeric character (#1984 is not a tag, #y1984 is)
//  • case-insensitive, displayed with the casing they were first created with
//  • "/" makes nested tags: #inbox/to-read belongs to #inbox
const { db } = require('./db');

// Characters allowed inside a tag (besides letters and numbers): _ - / and emoji/symbol pieces
const TAG_CHARS = String.raw`\p{L}\p{N}\p{M}_\-\/\p{Extended_Pictographic}\p{So}‍️`;
const INVALID = new RegExp(`[^${TAG_CHARS}]`, 'gu');

/** Normalise user input into a valid tag (display form), or null if it can't be one. */
function cleanTag(t) {
  let s = String(t ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(INVALID, '');
  s = s.replace(/\/{2,}/g, '/').replace(/^[/-]+|[/]+$/g, '').slice(0, 60);
  if (!s || !/[^\d/]/u.test(s)) return null;
  return s;
}
const tagKey = t => t.toLowerCase();

/** #tags written in text (not URL fragments or "# Heading"), plus YAML front-matter tags. */
const INLINE = new RegExp(`(?:^|[\\s(\\[,;])#([${TAG_CHARS}]+)`, 'gu');
function extractTags(text) {
  if (!text) return [];
  const out = [];
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const block = fm[1].match(/^tags:[ \t]*(.*)\r?\n?((?:[ \t]*-[ \t]*.+\r?\n?)*)/m);
    if (block) {
      if (block[1].trim()) out.push(...block[1].replace(/^\[|\]$/g, '').split(','));
      out.push(...[...block[2].matchAll(/-[ \t]*(.+)/g)].map(m => m[1].replace(/^["']|["']$/g, '')));
    }
  }
  for (const m of text.matchAll(INLINE)) out.push(m[1]);
  return out.map(cleanTag).filter(Boolean);
}

/** Find a tag by key (case-insensitive), or create it with the given casing. */
function ensureTag(userId, name) {
  const key = tagKey(name);
  const found = db.prepare('SELECT id, name FROM tags WHERE user_id = ? AND key = ?').get(userId, key);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO tags (user_id, name, key) VALUES (?,?,?)').run(userId, name, key).lastInsertRowid);
}

/** Attach tags to a bookmark. replace=true first removes its user/AI tags (note tags are synced separately). */
function setTags(userId, bookmarkId, names, { source = 'user', replace = true } = {}) {
  const clean = [...new Map((names || []).map(cleanTag).filter(Boolean).map(n => [tagKey(n), n])).values()];
  if (replace) db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND source != 'note'`).run(bookmarkId);
  const link = db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag_id, source) VALUES (?,?,?) ON CONFLICT DO UPDATE SET source = excluded.source WHERE bookmark_tags.source = \'note\' AND excluded.source = \'user\'');
  for (const n of clean) link.run(bookmarkId, ensureTag(userId, n), source);
}

/** Keep tags written in the note text in sync with the note. */
function syncNoteTags(userId, bookmarkId, text) {
  const names = extractTags(text);
  const ids = [...new Set(names.map(n => ensureTag(userId, n)))];
  db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND source = 'note' ${ids.length ? `AND tag_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`)
    .run(bookmarkId, ...ids);
  const link = db.prepare(`INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source) VALUES (?,?,'note')`);
  for (const id of ids) link.run(bookmarkId, id);
}

function tagsFor(ids) {
  if (!ids.length) return {};
  const rows = db.prepare(
    `SELECT bt.bookmark_id, t.name, bt.source FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.bookmark_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.key`
  ).all(...ids);
  const out = {};
  for (const r of rows) (out[r.bookmark_id] ||= []).push({ name: r.name, source: r.source });
  return out;
}

/** SQL matching a tag and all of its nested children (tag:inbox → #inbox, #inbox/to-read, …). */
function tagFilterSql(userId, name) {
  const key = tagKey(String(name).replace(/^#/, ''));
  return {
    sql: `b.id IN (SELECT bt.bookmark_id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
            WHERE t.user_id = ? AND (t.key = ? OR substr(t.key, 1, ?) = ?))`,
    args: [userId, key, key.length + 1, key + '/'],
  };
}

function pruneOrphanTags(userId) {
  db.prepare('DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM bookmark_tags)').run(userId);
}

module.exports = { setTags, syncNoteTags, tagsFor, pruneOrphanTags, cleanTag, tagKey, extractTags, ensureTag, tagFilterSql };
