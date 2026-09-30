// Shared by both pages: escaping, the theme switch, durations, and the two-second poll.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cap = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
const mins = m => m == null ? '' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m/60) + 'h' : Math.floor(m/1440) + 'd';

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

// Fetch url every two seconds and hand the JSON to render; the pulse says whether the board answers.
function poll(url, render){
  async function tick(){
    const pulse = document.getElementById('pulse'), at = document.getElementById('at');
    let d;
    try { d = await (await fetch(url, {cache:'no-store'})).json(); }
    catch { pulse.classList.add('stale'); at.textContent = 'not answering'; return; }
    pulse.classList.remove('stale'); at.textContent = d.at;
    render(d);
  }
  tick(); setInterval(tick, 2000);
  return tick;
}
