// BrainWaves (https://github.com/RayDevXyz/nmuch), the user's notes app: its address and an API
// token (BrainWaves → Settings → Account and API tokens). Burrow's server calls BrainWaves, so the
// token never reaches the browser. Used to list BrainWaves pages on a tag page.
const express = require('express');
const { db } = require('./db');

const router = express.Router();
const get = (userId) => {
  const row = db.prepare("SELECT value FROM integrations WHERE user_id = ? AND kind = 'brainwaves'").get(userId);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
};

async function call(conn, command, body) {
  const res = await fetch(`${conn.url}/api/${command}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw Object.assign(new Error('BrainWaves refused the token: make a new one in BrainWaves (Settings → Account and API tokens).'), { status: 400 });
  if (!res.ok) throw Object.assign(new Error(`BrainWaves answered ${res.status}`), { status: 502 });
  if (!(res.headers.get('content-type') || '').includes('json')) throw Object.assign(new Error('That address answered with a web page, not BrainWaves. If a proxy asks for its own login there, turn that off for BrainWaves.'), { status: 400 });
  return res.json();
}

router.get('/', (req, res) => {
  const c = get(req.userId);
  res.json(c ? { url: c.url } : null);
});

router.put('/', async (req, res) => {
  const url = String(req.body?.url || '').trim().replace(/\/+$/, '');
  const token = String(req.body?.token || '').trim();
  if (!/^https?:\/\/\S+$/.test(url) || url.length > 300) return res.status(400).json({ error: 'Enter the BrainWaves address, like https://notes.example.com' });
  if (token.length < 8 || token.length > 300) return res.status(400).json({ error: 'Paste an API token from BrainWaves' });
  try { await call({ url, token }, 'tags'); }
  catch (e) { return res.status(e.status || 502).json({ error: e.name === 'TimeoutError' ? `BrainWaves at ${url} didn't answer` : e.message }); }
  db.prepare("INSERT INTO integrations (user_id, kind, value) VALUES (?, 'brainwaves', ?) ON CONFLICT(user_id, kind) DO UPDATE SET value = excluded.value")
    .run(req.userId, JSON.stringify({ url, token }));
  res.json({ url });
});

router.delete('/', (req, res) => {
  db.prepare("DELETE FROM integrations WHERE user_id = ? AND kind = 'brainwaves'").run(req.userId);
  res.json({ ok: true });
});

// BrainWaves pages with a tag (nested tags too: #research also finds #research/web).
const cache = new Map();
router.get('/tag/:tag', async (req, res) => {
  const c = get(req.userId);
  if (!c) return res.json(null);
  const tag = String(req.params.tag).replace(/^#/, '').slice(0, 120);
  const key = `${req.userId}:${tag.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return res.json(hit.value);
  try {
    const [tags, pages] = await Promise.all([call(c, 'tags'), call(c, 'listPages')]);
    const lower = tag.toLowerCase();
    const matching = tags.map(t => t.tag).filter(t => t.toLowerCase() === lower || t.toLowerCase().startsWith(lower + '/'));
    const ids = new Set((await Promise.all(matching.map(t => call(c, 'pagesWithTag', { tag: t })))).flat());
    const value = {
      url: c.url,
      pages: pages.filter(p => ids.has(p.id) && p.trashedAt == null)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
        .map(p => ({ id: p.id, title: p.title || 'Untitled', icon: p.icon || '', link: `${c.url}/#/p/${p.id}` })),
    };
    cache.set(key, { at: Date.now(), value });
    res.json(value);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.name === 'TimeoutError' ? "BrainWaves didn't answer" : e.message });
  }
});

module.exports = router;
