const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'archives'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'burrow.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📁',
  color TEXT DEFAULT '#8b5cf6',
  parent_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'link',            -- link | note | file
  url TEXT,
  title TEXT,
  description TEXT,
  note TEXT,
  image_url TEXT,
  favicon TEXT,
  site_name TEXT,
  author TEXT,
  content_html TEXT,
  content_text TEXT,
  has_archive INTEGER NOT NULL DEFAULT 0,
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | ready | failed
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_bm_user ON bookmarks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bm_url ON bookmarks(user_id, url);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'user',          -- user | ai
  PRIMARY KEY (bookmark_id, tag_id)
);
-- Tab workspaces & stacks synced from the browser extension
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,                          -- client-generated uuid
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'workspace',       -- workspace | stack
  name TEXT NOT NULL,
  color TEXT,
  emoji TEXT,
  tabs TEXT NOT NULL DEFAULT '[]',              -- JSON [{url,title,favIconUrl,pinned,group}]
  position INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL                   -- ms, last-write-wins
);
CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  title, description, note, content_text, url, tags,
  tokenize = 'porter unicode61'
);
`);

// Migrations for columns added after the first release
for (const [table, col] of [['users', 'theme'], ['collections', 'theme']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
}

// Tags are case-insensitive: "key" is the lowercase form used for matching, "name" keeps the original casing.
if (!db.prepare('PRAGMA table_info(tags)').all().some(c => c.name === 'key')) {
  db.exec('ALTER TABLE tags ADD COLUMN key TEXT');
  const upd = db.prepare('UPDATE tags SET key = ? WHERE id = ?');
  for (const t of db.prepare('SELECT id, name FROM tags').all()) upd.run(t.name.toLowerCase(), t.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_key ON tags(user_id, key)');

// Notion-style databases: custom properties, their values, and saved views per page
db.exec(`
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,  -- NULL = on every page
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prop_values (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  prop_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, prop_id)
);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page TEXT NOT NULL,                         -- 'home' or 'c:<collection id>'
  name TEXT NOT NULL,
  type TEXT NOT NULL,                         -- table | kanban | list | grid
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS page_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, page)
);
`);

/** Searchable text from custom property values (text, URL, select options). */
function propText(id) {
  const rows = db.prepare(`SELECT p.type, p.config, v.value FROM prop_values v JOIN properties p ON p.id = v.prop_id
    WHERE v.bookmark_id = ? AND p.type IN ('text','url','select','multi_select','status')`).all(id);
  const out = [];
  for (const r of rows) {
    const v = JSON.parse(r.value);
    if (r.type === 'text' || r.type === 'url') out.push(String(v));
    else {
      const opts = JSON.parse(r.config).options || [];
      for (const oid of [].concat(v)) { const o = opts.find(o => o.id === oid); if (o) out.push(o.name); }
    }
  }
  return out.join(' ');
}

/** Rebuild the full-text row for one bookmark. */
function reindex(id) {
  const b = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?').run(id);
  if (!b) return;
  const tags = db.prepare(
    'SELECT t.name FROM tags t JOIN bookmark_tags bt ON bt.tag_id = t.id WHERE bt.bookmark_id = ?'
  ).all(id).map(r => r.name).join(' ');
  db.prepare(
    'INSERT INTO bookmarks_fts (rowid, title, description, note, content_text, url, tags) VALUES (?,?,?,?,?,?,?)'
  ).run(id, b.title || '', b.description || '', [b.note || '', propText(id)].join(' '), b.content_text || '', b.url || b.file_name || '', tags);
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, reindex, tx };
