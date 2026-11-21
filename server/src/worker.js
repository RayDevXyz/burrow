// Background processing: fetch page, extract metadata + readable text,
// store a static HTML snapshot, then optionally AI-tag.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { db, DATA_DIR, reindex } = require('./db');
const { suggestTags, aiEnabled } = require('./ai');
const { setTags } = require('./tags');

const MAX_BYTES = 8 * 1024 * 1024;
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_URLS === 'true';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Burrow/1.0';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') ||
    (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}

async function guardUrl(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs can be fetched');
  if (BLOCK_PRIVATE) {
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Private network address blocked');
  }
}

async function fetchPage(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await guardUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel(); break; }
      chunks.push(value);
    }
    return { finalUrl: current, type, body: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

const abs = (u, base) => { try { return u ? new URL(u, base).href : null; } catch { return null; } };

function extract(html, url) {
  const { document } = parseHTML(html);
  const meta = n => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content')?.trim() || null;
  const icon = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]')?.getAttribute('href');
  const info = {
    title: meta('og:title') || meta('twitter:title') || document.querySelector('title')?.textContent?.trim() || null,
    description: meta('og:description') || meta('description') || meta('twitter:description'),
    image_url: abs(meta('og:image') || meta('twitter:image'), url),
    site_name: meta('og:site_name') || new URL(url).hostname.replace(/^www\./, ''),
    author: meta('author') || meta('article:author'),
    favicon: abs(icon || '/favicon.ico', url),
    content_html: null, content_text: null,
  };
  try {
    const rdoc = parseHTML(html).document;
    // Readability drops <button>s, but code highlighters (e.g. twoslash) wrap identifiers in them.
    rdoc.querySelectorAll('pre button, code button').forEach(b => b.replaceWith(rdoc.createTextNode(b.textContent)));
    const article = new Readability(rdoc, { charThreshold: 200 }).parse();
    if (article) {
      info.content_html = article.content;
      info.content_text = article.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200000);
      info.author ||= article.byline;
      info.description ||= article.excerpt;
    }
  } catch { /* readability is best-effort */ }
  if (!info.content_text) info.content_text = document.body?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 50000) || null;
  return info;
}

/** Static snapshot: strip scripts, add <base> so relative assets still resolve. */
function snapshot(html, url) {
  const { document } = parseHTML(html);
  document.querySelectorAll('script, noscript, iframe, object, embed').forEach(n => n.remove());
  document.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  const head = document.querySelector('head');
  if (head) {
    const base = document.createElement('base'); base.setAttribute('href', url);
    head.prepend(base);
    const m = document.createElement('meta'); m.setAttribute('name', 'burrow-archived');
    m.setAttribute('content', new Date().toISOString()); head.append(m);
  }
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

async function processBookmark(id) {
  const b = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!b) return;
  try {
    if (b.type === 'link' && b.url) {
      const page = await fetchPage(b.url);
      if (page.type.includes('html')) {
        const info = extract(page.body, page.finalUrl);
        fs.writeFileSync(path.join(DATA_DIR, 'archives', `${id}.html`), snapshot(page.body, page.finalUrl));
        db.prepare(`UPDATE bookmarks SET
            title = COALESCE(NULLIF(title,''), ?), description = COALESCE(NULLIF(description,''), ?),
            image_url = ?, favicon = ?, site_name = ?, author = ?, content_html = ?, content_text = ?,
            has_archive = 1, status = 'ready', error = NULL, updated_at = unixepoch() WHERE id = ?`)
          .run(info.title, info.description, info.image_url, info.favicon, info.site_name, info.author,
            info.content_html, info.content_text, id);
      } else {
        db.prepare(`UPDATE bookmarks SET site_name = ?, status = 'ready', error = NULL WHERE id = ?`)
          .run(new URL(page.finalUrl).hostname, id);
      }
    } else {
      db.prepare(`UPDATE bookmarks SET status = 'ready' WHERE id = ?`).run(id);
    }
  } catch (e) {
    db.prepare(`UPDATE bookmarks SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(String(e.message || e).slice(0, 300), id);
  }

  if (aiEnabled()) {
    try {
      const fresh = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
      const existing = db.prepare('SELECT name FROM tags WHERE user_id = ?').all(fresh.user_id).map(r => r.name);
      const tags = await suggestTags(fresh, existing);
      if (tags.length) setTags(fresh.user_id, id, tags, { source: 'ai', replace: false });
    } catch (e) { console.warn(`[ai] tagging #${id} failed:`, e.message); }
  }
  reindex(id);
}

// Tiny in-process queue with limited concurrency
const queue = []; let running = 0; const CONCURRENCY = 3;
function enqueue(id) { queue.push(id); pump(); }
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift(); running++;
    processBookmark(id).catch(e => console.error(e)).finally(() => { running--; pump(); });
  }
}
function resumePending() {
  db.prepare(`SELECT id FROM bookmarks WHERE status = 'pending'`).all().forEach(r => enqueue(r.id));
}

module.exports = { enqueue, resumePending };
