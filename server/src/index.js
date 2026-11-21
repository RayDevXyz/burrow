const express = require('express');
const path = require('path');
const api = require('./api');
const { resumePending } = require('./worker');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

// The browser extension calls the API cross-origin with a Bearer token.
// No cookies are accepted cross-origin (no Allow-Credentials), so this is safe.
app.use('/api', (req, res, next) => {
  if (req.headers.origin) {
    res.set({
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use('/api', api);
app.get('/healthz', (_, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`🦫 Burrow listening on http://localhost:${PORT}`);
  resumePending();
});
