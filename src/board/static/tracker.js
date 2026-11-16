// Shared by the tickets and wiki pages: JSON calls, the pulse, and moving between views without a reload.
// A call given ms stops waiting after that long and throws, though the board may still carry it out.
// The pulse shows the newest call that has settled, so an older one giving up later does not mark a
// board that has since answered.
let calls = 0, pulsed = 0;
async function api(url, body, ms){
  const pulse = document.getElementById('pulse'), at = document.getElementById('at');
  const ctl = new AbortController(), timer = ms ? setTimeout(() => ctl.abort(), ms) : 0, n = ++calls;
  const beat = ok => { if(n < pulsed) return; pulsed = n; pulse.classList.toggle('stale', !ok); at.textContent = ok ? new Date().toTimeString().slice(0, 5) : 'not answering'; };
  let r, d;
  try {
    r = await fetch(url, body === undefined ? {cache:'no-store', signal: ctl.signal}
      : {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: ctl.signal});
    // a refusal with a body that is not JSON, such as a proxy's error page, still carries its status
    d = await r.json().catch(err => { if(r.ok) throw err; return {error: `HTTP ${r.status}`}; });
  } catch {
    beat(false);
    if(!ctl.signal.aborted) throw new Error('the board is not answering');
    const e = new Error(`the board did not answer in ${ms / 1000} s`); e.timeout = true; throw e;
  } finally { clearTimeout(timer); }
  beat(true);
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
