import { getConfig, api, syncSpaces } from './lib.js';

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
  await chrome.storage.sync.set({ server, token });
  status.textContent = 'Testing…';
  try {
    const me = await api('/me');
    await syncSpaces();
    status.innerHTML = `<span class="ok">✓ Connected as <b>${me.username.replace(/</g, '&lt;')}</b></span>`;
  } catch (e) {
    status.innerHTML = `<span class="err">✗ ${String(e.message).replace(/</g, '&lt;')}</span>`;
  }
};
