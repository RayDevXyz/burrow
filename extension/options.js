import { getConfig, api, syncSpaces, originPattern, hasServerAccess } from './lib.js';

const $ = id => document.getElementById(id);
const cfg = await getConfig();
$('server').value = cfg.server;
$('token').value = cfg.token;
$('shortcuts').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };

$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  const status = $('status');
  try { new URL(server); } catch { status.innerHTML = '<span class="err">Enter a valid URL</span>'; return; }
  // Ask Chrome for access to this server only. With it, requests skip CORS preflights,
  // which reverse proxies (Cosmos, Traefik, …) sometimes answer themselves.
  // (request() must run straight from the click; it resolves true at once if access was already granted)
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [originPattern(server)] }); } catch { granted = await hasServerAccess(server); }
  await chrome.storage.sync.set({ server, token });
  if (!granted) { status.innerHTML = '<span class="err">✗ Burrow needs permission to reach this server. Click Save & test again and choose Allow.</span>'; return; }
  status.textContent = 'Testing…';
  try {
    const me = await api('/me');
    await syncSpaces();
    status.innerHTML = `<span class="ok">✓ Connected as <b>${me.username.replace(/</g, '&lt;')}</b></span>`;
  } catch (e) {
    status.innerHTML = `<span class="err">✗ ${String(e.message).replace(/</g, '&lt;')}</span>`;
  }
};
