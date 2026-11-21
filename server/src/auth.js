const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 30;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256(token), userId, Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
function createApiToken(userId, name) {
  const token = 'brw_' + crypto.randomBytes(24).toString('base64url');
  const r = db.prepare('INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?,?,?)')
    .run(userId, name, sha256(token));
  return { id: Number(r.lastInsertRowid), token };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

/** Resolves the user from a Bearer API token or the session cookie. */
function authenticate(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const row = db.prepare('SELECT id, user_id FROM api_tokens WHERE token_hash = ?').get(sha256(h.slice(7).trim()));
    if (!row) return null;
    db.prepare('UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ?').run(row.id);
    return row.user_id;
  }
  const token = parseCookies(req.headers.cookie).burrow_session;
  if (!token) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s || s.expires_at < Date.now() / 1000) return null;
  return s.user_id;
}

function requireAuth(req, res, next) {
  const uid = authenticate(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = uid;
  next();
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `burrow_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, createApiToken,
  parseCookies, requireAuth, setSessionCookie,
};
