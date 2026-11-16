// Shared by the tickets and wiki pages: JSON calls, the pulse, and moving between views without a reload.
// A call given ms is dropped if the board has not answered by then.
async function api(url, body, ms){
  const pulse = document.getElementById('pulse'), at = document.getElementById('at');
  const ctl = new AbortController(), timer = ms ? setTimeout(() => ctl.abort(), ms) : 0;
  let r, d;
  try {
    r = await fetch(url, body === undefined ? {cache:'no-store', signal: ctl.signal}
      : {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: ctl.signal});
    d = await r.json();
  } catch {
    pulse.classList.add('stale'); at.textContent = 'not answering';
    throw new Error(ctl.signal.aborted ? `the board did not answer in ${ms / 1000} s` : 'the board is not answering');
  } finally { clearTimeout(timer); }
  pulse.classList.remove('stale'); at.textContent = new Date().toTimeString().slice(0, 5);
  if(!r.ok) { const e = new Error(d.error || r.status); e.status = r.status; e.data = d; throw e; }
  return d;
}
const q = () => new URLSearchParams(location.search);
function go(params, replace){
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const url = location.pathname + (s.toString() ? '?' + s : '');
  (replace ? history.replaceState : history.pushState).call(history, null, '', url);
  route();
}
addEventListener('popstate', () => route());
const ago = iso => { const m = Math.floor((Date.now() - Date.parse(iso)) / 60000); return isFinite(m) ? mins(Math.max(m, 0)) : ''; };
const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], {dateStyle:'medium', timeStyle:'short'}); };
// Links inside the page go through go(), so the back button walks views.
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-go]');
  if(!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(Object.fromEntries(new URLSearchParams(a.getAttribute('data-go'))));
});
const goLink = (params, text, cls = '') => {
  const s = new URLSearchParams(params).toString();
  return `<a class="${cls}" href="${location.pathname}?${esc(s)}" data-go="${esc(s)}">${text}</a>`;
};
function flash(msg){ const e = document.getElementById('err'); if(e) e.textContent = msg || ''; }
