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
    <div class="msg ${mine ? 'human' : esc(m.kind || 'note')} ${slot ? 'chat' : ''}"${m.qid ? ` id="q-${esc(m.qid)}"` : ''}>${slot}<div class="main">
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
  renderQueue(d);
  markSeen(d);
}

// The questions and decisions waiting on the human, oldest first, in a panel that stays shut until
// opened. A row goes when the board says it is resolved (see queue.ts): marked handled here, replied
// to from here, or its ticket moved out of blocked. Reading it does not. A row whose message is in the
// thread below links to it; an older one opens its words in the panel.
let lastQueue = '', replyTo = null, replyQuote = '';
const opened = new Set();
const firstLine = s => (String(s || '').split('\n').find(l => l.trim()) || '').replace(/^[#>*\s-]+/, '').trim();
function renderQueue(d){
  const panel = document.getElementById('queue'), qlist = document.getElementById('qlist');
  if(!panel || !qlist) return;
  const q = d.queue || [];
  document.getElementById('qcount').textContent = q.length;
  panel.classList.toggle('empty', !q.length);
  const sel = getSelection();
  if(!sel.isCollapsed && qlist.contains(sel.anchorNode)) return;
  const note = d.queue_note ? `<div class="qnote">${esc(d.queue_note)}</div>` : '';
  const html = note + (q.length ? q.map(i => {
    const head = `<span class="kind">${esc(i.kind)}</span>${i.ticket ? `<span class="tk">${esc(i.ticket)}</span>` : ''}<span class="when">${esc(when(i.age_min))}</span>`;
    const line = esc(firstLine(i.text) || i.kind);
    const open = opened.has(i.id);
    const go = i.in_thread ? `<a class="line" href="#q-${esc(i.id)}" data-go="${esc(i.id)}">${line}</a>`
      : open ? `<div class="body">${md(i.text)}</div>${i.link ? `<div class="link"><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.link)}</a></div>` : ''}`
      : `<button type="button" class="line" data-open="${esc(i.id)}" aria-expanded="false">${line}</button>`;
    const less = !i.in_thread && open ? `<button type="button" data-open="${esc(i.id)}" aria-expanded="true">less</button>` : '';
    return `<div class="qi ${esc(i.kind)}"><div class="qhead">${head}</div>${go}
      <div class="qact"><button type="button" data-reply="${esc(i.id)}">reply</button><button type="button" data-done="${esc(i.id)}">handled</button>${less}</div></div>`;
  }).join('') : '<div class="none">nothing waiting on you</div>');
  if(html !== lastQueue){ qlist.innerHTML = html; lastQueue = html; }
  qItems = new Map(q.map(i => [i.id, i]));
}
let qItems = new Map();

// quiet: after a reply, whose question may have left the queue on its own meanwhile (its ticket moved
// on). A refusal then says nothing worth showing under a message that was sent.
async function handled(id, quiet){
  err.textContent = '';
  try {
    const r = await fetch('/api/messages/handled', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id})});
    if(!r.ok && !(quiet && r.status === 400)) err.textContent = ((await r.json().catch(() => ({}))).error) || 'not marked handled';
  } catch { err.textContent = 'not marked handled: the board is not answering'; }
  lastQueue = ''; // redraw, so a button disabled by a failed mark is live again
  await tick();
}

function startReply(id){
  const i = qItems.get(id);
  if(!i) return;
  // The quote goes in front of whatever is already typed, and cancel takes back only the quote.
  const draft = unquote();
  replyTo = id;
  replyQuote = `> ${i.ticket ? i.ticket + ': ' : ''}${firstLine(i.text).slice(0, 200)}\n\n`;
  t.value = replyQuote + draft;
  document.getElementById('replyto').textContent = `replying to ${i.ticket || i.kind}: sending marks it handled`;
  document.getElementById('replying').hidden = false;
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
  scrollTo({top: 0, behavior: 'smooth'});
}
function unquote(){
  const v = t.value;
  return replyQuote && v.startsWith(replyQuote) ? v.slice(replyQuote.length) : v;
}
function stopReply(){
  replyTo = null; replyQuote = '';
  const r = document.getElementById('replying');
  if(r) r.hidden = true;
}

addEventListener('DOMContentLoaded', () => {
  const qlist = document.getElementById('qlist');
  if(!qlist) return;
  qlist.addEventListener('click', e => {
    const b = e.target.closest('[data-done],[data-reply],[data-open],[data-go]');
    if(!b) return;
    if(b.dataset.done){ b.disabled = true; handled(b.dataset.done); }
    else if(b.dataset.reply) startReply(b.dataset.reply);
    else if(b.dataset.open){
      const id = b.dataset.open;
      opened.has(id) ? opened.delete(id) : opened.add(id);
      lastQueue = ''; tick();
    } else if(b.dataset.go){
      const m = document.getElementById('q-' + b.dataset.go);
      if(!m) return;
      e.preventDefault();
      m.scrollIntoView({behavior: 'smooth', block: 'start'});
      m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash');
    }
  });
  document.getElementById('unreply').addEventListener('click', () => { t.value = unquote(); stopReply(); t.focus(); });
});

// While the page is visible, tell the board the newest lead message now on screen, so a reminder
// knows what the human has read. Lead rows have no id; their `t` is the mark. Each `t` is posted once
// per page. A post the board could not take (no answer, or a 5xx) is tried again on the next poll;
// a refusal (4xx) is not, as the same post would be refused again. Newest is the greatest `t`, not
// the last row appended: after the clock steps back, a later row can carry an earlier `t`.
let seenPosted = null;
function markSeen(d){
  if(document.visibilityState !== 'visible') return;
  let newest = null;
  for(const m of d.messages){
    if(m.from !== 'lead' || !m.t || !Number.isFinite(Date.parse(m.t))) continue;
    if(!newest || Date.parse(m.t) > Date.parse(newest.t)) newest = m;
  }
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
    if(r.ok){
      t.value = ''; clearPreview();
      // A reply started from the panel answers that question: it leaves the queue once sent.
      const answered = replyTo;
      stopReply();
      if(answered) await handled(answered, true); else await tick();
    } else { err.textContent = r.error || 'not sent'; }
  } catch { err.textContent = 'not sent: the board is not answering'; }
  b.disabled = false; b.textContent = 'send'; t.focus();
}
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); send(); });
t.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
