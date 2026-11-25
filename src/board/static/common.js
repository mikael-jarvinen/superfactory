// Shared by both pages: escaping, the theme switch, durations, and the two-second poll.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cap = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
const mins = m => m == null ? '' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m/60) + 'h' : Math.floor(m/1440) + 'd';
// An agent's round avatar. With no picture: their initial in the same circle when a name is given,
// otherwise nothing.
const face = (url, cls, name) => url ? `<img class="av ${cls}" src="${esc(url)}" alt="">`
  : name ? `<span class="av initial ${cls}">${esc(cap(name).charAt(0))}</span>` : '';

// The choice is this browser's, not the factory's, so it lives in localStorage and defaults to
// whatever the machine asks for. Wrapped because a private window can throw on access. Run from
// the head, so the page never paints in the wrong theme first.
try { const t = localStorage.getItem('sf-theme'); if(t) document.documentElement.dataset.theme = t; } catch {}
addEventListener('DOMContentLoaded', () => {
  document.getElementById('theme').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sf-theme', next); } catch {}
  });
});

// The JSON a board API answers. A refusal throws the board's own error when it sent one, else its
// HTTP status; a board that cannot be reached at all throws with no message.
async function getJSON(url){
  let res;
  try { res = await fetch(url, {cache:'no-store'}); } catch { throw new Error(''); }
  if(!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// The pulse goes stale and the header says why, when there is a why.
function notAnswering(e){
  document.getElementById('pulse').classList.add('stale');
  document.getElementById('at').textContent = e && e.message ? `not answering: ${e.message}` : 'not answering';
}

// Fetch url every two seconds and hand the JSON to render; the pulse says whether the board answers.
function poll(url, render){
  async function tick(){
    let d;
    try { d = await getJSON(url); } catch(e) { notAnswering(e); return; }
    document.getElementById('pulse').classList.remove('stale'); document.getElementById('at').textContent = d.at;
    render(d);
  }
  tick(); setInterval(tick, 2000);
  return tick;
}

// The local tracker's links in the header, when the workspace has one: the board passes its
// snapshot's `tracker`, every other page asks once. A local tracker brings the backlog and its wiki;
// a wiki beside another tracker, { wiki: true }, only the wiki. A workspace with neither answers
// 404 and the header stays as it is.
function trackerNav(t){
  const nav = document.querySelector('header nav');
  if(!nav || !t) return;
  const here = location.pathname;
  const links = t.backlog !== undefined ? [['/tickets', `backlog (${t.backlog})`], ['/wiki', 'wiki']] : t.wiki ? [['/wiki', 'wiki']] : [];
  for(const [href, label] of links){
    let a = nav.querySelector(`a[href="${href}"]`);
    if(!a){ a = document.createElement('a'); a.href = href; nav.appendChild(a); }
    a.textContent = label;
    a.classList.toggle('on', here === href);
  }
}
// The analytics link, after messages on every page, so a page's own header need not carry it.
addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('header nav');
  if(!nav || nav.querySelector('a[href="/analytics"]')) return;
  const a = document.createElement('a');
  a.href = '/analytics'; a.textContent = 'analytics';
  const msgs = nav.querySelector('a[href="/messages"]');
  msgs ? msgs.after(a) : nav.appendChild(a);
});
// The GitHub traffic page, after analytics.
addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('header nav');
  if(!nav || nav.querySelector('a[href="/github"]')) return;
  const a = document.createElement('a');
  a.href = '/github'; a.textContent = 'github';
  if(location.pathname === '/github') a.classList.add('on');
  const after = nav.querySelector('a[href="/analytics"]') || nav.querySelector('a[href="/messages"]');
  after ? after.after(a) : nav.appendChild(a);
});
addEventListener('DOMContentLoaded', () => {
  if(location.pathname === '/') return;
  fetch('/api/tickets?summary=1', {cache:'no-store'}).then(r => r.ok ? r.json() : null).then(trackerNav).catch(() => {});
});
