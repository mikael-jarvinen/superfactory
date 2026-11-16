// The thread between the human and the lead, newest first, from /api/messages. Names come from the data.
const when = m => m == null ? '' : m < 1 ? 'just now' : m < 60 ? m + 'm ago'
              : m < 1440 ? Math.floor(m/60) + 'h ago' : Math.floor(m/1440) + 'd ago';

let pressing = false, lastList = '', named = false;
document.getElementById('list').addEventListener('mousedown', () => { pressing = true; });
addEventListener('mouseup', () => { pressing = false; });

function render(d){
  const lead = cap(d.lead);
  if(!named){
    document.getElementById('t').placeholder = `message ${lead} · enter to send, shift-enter for a new line`;
    document.getElementById('lead').textContent = lead;
    named = true;
  }
  const doing = document.getElementById('doing');
  doing.hidden = !d.status;
  doing.className = 'doing' + (d.status === 'idle' ? ' idle' : d.status === 'offline' ? ' offline' : '');
  document.getElementById('words').textContent = d.status || '';
  // Replacing the list under a selection moves or drops it, so leave the list alone while the
  // mouse is down on it or a selection sits in it, and whenever nothing in it changed.
  const list = document.getElementById('list'), sel = getSelection();
  if(pressing || (!sel.isCollapsed && list.contains(sel.anchorNode))) return;
  // With a lead avatar, each row is a chat line: the avatar in a column of its own on the lead's
  // messages, and an empty slot of the same width on the human's, so every message's text lines up.
  const html = d.messages.length ? d.messages.map(m => {
    const mine = m.from === 'human';
    const slot = d.lead_avatar ? `<div class="slot">${mine ? '' : face(d.lead_avatar, 'm')}</div>` : '';
    return `
    <div class="msg ${mine ? 'human' : esc(m.kind || 'note')} ${slot ? 'chat' : ''}">${slot}<div class="main">
      <div class="who">
        <span class="name">${esc(mine ? d.human : lead)}</span>
        ${mine ? '' : `<span class="kind">${esc(m.kind || 'note')}</span>`}
        ${m.ticket ? `<span class="tk">${esc(m.ticket)}</span>` : ''}
        ${m.receipt ? `<span class="rcpt ${esc(m.receipt)}">${esc(m.receipt)}</span>` : ''}
        <span class="when">${esc(when(m.age_min))}</span>
      </div>
      ${m.text ? `<div class="body">${md(m.text)}</div>` : ''}
      ${(m.images || (m.image ? [m.image] : [])).map(f => `<div class="shot"><a href="/attachments/${esc(f)}" target="_blank" rel="noopener"><img src="/attachments/${esc(f)}" alt="screenshot" loading="lazy"></a></div>`).join('')}
      ${m.link ? `<div class="link"><a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.link)}</a></div>` : ''}
    </div></div>`;
  }).join('') : '<div class="none">nothing yet</div>';
  if(html !== lastList){ list.innerHTML = html; lastList = html; }
  markSeen(d);
}

// While the page is visible, tell the board the newest lead message now on screen, so a reminder
// knows what the human has read. Lead rows have no id; their `t` is the mark. Each `t` is posted once
// per page. A post the board could not take (no answer, or a 5xx) is tried again on the next poll;
// a refusal (4xx) is not, as the same post would be refused again.
let seenPosted = null;
function markSeen(d){
  if(document.visibilityState !== 'visible') return;
  const newest = d.messages.find(m => m.from === 'lead' && m.t);
  if(!newest || newest.t === seenPosted || newest.t === d.seen) return;
  if(d.seen && Date.parse(newest.t) <= Date.parse(d.seen)) return;
  const t = newest.t;
  seenPosted = t;
  fetch('/api/messages/seen', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({t})})
    .then(r => { if(r.status >= 500 && seenPosted === t) seenPosted = null; },() => { if(seenPosted === t) seenPosted = null; });
}
const tick = poll('/api/messages', render);
// Coming back to a tab that was hidden marks what it shows at once, not on the next poll.
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') tick(); });

const t = document.getElementById('t'), b = document.getElementById('b'), err = document.getElementById('err');
const preview = document.getElementById('preview');
// The screenshots pasted since the last send, in the order pasted. Each holds its place from the
// paste on, so one that reads slower than the next still goes in its turn.
let pending = [];
function drawPreview(){
  preview.innerHTML = '';
  for(const p of pending){
    if(!p.url) continue;
    const box = document.createElement('div'), img = document.createElement('img'), x = document.createElement('button');
    box.className = 'thumb'; img.src = p.url; img.alt = 'pasted screenshot';
    x.type = 'button'; x.title = 'remove'; x.innerHTML = '&times;';
    x.addEventListener('click', () => { pending = pending.filter(q => q !== p); drawPreview(); });
    box.append(img, x); preview.append(box);
  }
  preview.hidden = !preview.childElementCount;
}
function clearPreview(){ pending = []; drawPreview(); }

// Pasted screenshots ride along with the text, or stand in for it. Every image on the clipboard is
// taken, and each paste adds to those already waiting.
t.addEventListener('paste', e => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for(const it of items){
    if(!it.type || it.type.indexOf('image/') !== 0) continue;
    const file = it.getAsFile();
    if(!file) continue;
    const p = {url: null}, reader = new FileReader();
    pending.push(p);
    reader.onload = () => { p.url = reader.result; drawPreview(); };
    reader.readAsDataURL(file);
    e.preventDefault();
  }
});

async function send(){
  const text = t.value.trim(), images = pending.filter(p => p.url).map(p => p.url);
  if(!text && !images.length) return;
  b.disabled = true; b.textContent = 'sending'; err.textContent = '';
  try {
    const r = await (await fetch('/api/messages', {method:'POST', headers:{'Content-Type':'application/json'},
                                                   body: JSON.stringify({text, images})})).json();
    if(r.ok){ t.value = ''; clearPreview(); await tick(); } else { err.textContent = r.error || 'not sent'; }
  } catch { err.textContent = 'not sent: the board is not answering'; }
  b.disabled = false; b.textContent = 'send'; t.focus();
}
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); send(); });
t.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
