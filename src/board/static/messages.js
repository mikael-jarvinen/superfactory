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
  const html = d.messages.length ? d.messages.map(m => {
    const mine = m.from === 'human';
    return `
    <div class="msg ${mine ? 'human' : esc(m.kind || 'note')}">
      <div class="who">
        <span class="name">${esc(mine ? d.human : lead)}</span>
        ${mine ? '' : `<span class="kind">${esc(m.kind || 'note')}</span>`}
        ${m.ticket ? `<span class="tk">${esc(m.ticket)}</span>` : ''}
        ${m.receipt ? `<span class="rcpt ${esc(m.receipt)}">${esc(m.receipt)}</span>` : ''}
        <span class="when">${esc(when(m.age_min))}</span>
      </div>
      <div class="body">${esc(m.text)}</div>
      ${m.link ? `<div class="link"><a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.link)}</a></div>` : ''}
    </div>`;
  }).join('') : '<div class="none">nothing yet</div>';
  if(html !== lastList){ list.innerHTML = html; lastList = html; }
}
const tick = poll('/api/messages', render);

const t = document.getElementById('t'), b = document.getElementById('b'), err = document.getElementById('err');
async function send(){
  const text = t.value.trim();
  if(!text) return;
  b.disabled = true; b.textContent = 'sending'; err.textContent = '';
  try {
    const r = await (await fetch('/api/messages', {method:'POST', headers:{'Content-Type':'application/json'},
                                                   body: JSON.stringify({text})})).json();
    if(r.ok){ t.value = ''; await tick(); } else { err.textContent = r.error || 'not sent'; }
  } catch { err.textContent = 'not sent: the board is not answering'; }
  b.disabled = false; b.textContent = 'send'; t.focus();
}
document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); send(); });
t.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
