import { api, getConfig, isConfigured, isSavable, lookup, saveBookmark, stashTabs, favicon } from './lib.js';

const root = document.getElementById('root');
document.getElementById('settings').onclick = () => chrome.runtime.openOptionsPage();
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

const tools = el(`<div class="actions">
  <button class="btn" id="stash">📥 Stash tab</button>
  <button class="btn" id="panel">🗂 Tab manager</button>
</div>`);
tools.querySelector('#stash').onclick = async () => { await stashTabs([tab.id]); window.close(); };
tools.querySelector('#panel').onclick = async () => { await chrome.sidePanel.open({ windowId: tab.windowId }); window.close(); };

if (!(await isConfigured())) {
  root.append(el(`<div class="notice">Connect Burrow to your server to save pages.<br><br>
    <button class="btn primary" id="go">Open settings</button></div>`), tools);
  root.querySelector('#go').onclick = () => chrome.runtime.openOptionsPage();
} else if (!isSavable(tab.url)) {
  root.append(el(`<div class="notice muted">This page can't be saved. You can still manage your tabs.</div>`), tools);
} else {
  const { server } = await getConfig();
  root.append(el(`<div>
    <div class="page"><img src="${esc(favicon(tab.url))}" alt=""><div class="grow"><div class="ellipsis"><b>${esc(tab.title)}</b></div>
      <div class="ellipsis muted">${esc(tab.url)}</div></div></div>
    <label class="lbl">Title</label><input class="input" id="title" value="${esc(tab.title)}">
    <label class="lbl">Tags <span class="muted" style="text-transform:none">(comma separated)</span></label>
    <input class="input" id="tags" list="taglist" placeholder="reading, design"><datalist id="taglist"></datalist>
    <label class="lbl">Collection</label><select class="input" id="col"><option value="">— Unsorted —</option></select>
    <label class="lbl">Note</label><textarea class="input" id="note" rows="2" placeholder="Why are you saving this?"></textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary grow" id="save" style="justify-content:center">Save page</button>
      <button class="btn" id="open" title="Open Burrow">↗</button></div>
    <div id="status" class="muted"></div>
  </div>`), tools);
  const $ = s => root.querySelector(s);
  const status = $('#status');
  $('#open').onclick = () => chrome.tabs.create({ url: server });

  let existing = null;
  Promise.all([api('/collections'), api('/tags'), lookup(tab.url)]).then(([cols, tags, found]) => {
    for (const c of cols) $('#col').append(new Option(`${c.icon} ${c.name}`, c.id));
    for (const t of tags) $('#taglist').append(new Option(t.name));
    if (found) {
      existing = found;
      $('#title').value = found.title || tab.title;
      $('#tags').value = found.tags.map(t => t.name).join(', ');
      $('#note').value = found.note || '';
      $('#col').value = found.collection_id || '';
      $('#save').textContent = 'Update';
      status.innerHTML = '<span class="ok">✓ Already in your Burrow</span>';
    }
  }).catch(e => { status.innerHTML = `<span class="err">${esc(e.message)}</span>`; });

  const doSave = async () => {
    $('#save').disabled = true; status.textContent = 'Saving…';
    const body = {
      title: $('#title').value.trim(), note: $('#note').value.trim() || undefined,
      tags: $('#tags').value.split(',').map(s => s.trim()).filter(Boolean),
      collectionId: $('#col').value || null,
    };
    try {
      if (existing) await api(`/bookmarks/${existing.id}`, { method: 'PATCH', body: { ...body, note: body.note ?? '' } });
      else await saveBookmark(tab.url, body);
      chrome.runtime.sendMessage({ type: 'saved', url: tab.url, tabId: tab.id });
      status.innerHTML = '<span class="ok">✓ Saved</span>';
      setTimeout(() => window.close(), 700);
    } catch (e) { status.innerHTML = `<span class="err">${esc(e.message)}</span>`; $('#save').disabled = false; }
  };
  $('#save').onclick = doSave;
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT')) doSave(); });
  $('#tags').focus();
}
