// The analytics page: per state totals by week, and every item's time, entries and tokens per
// state, from /api/analytics. The board reads the history once every thirty seconds, so the page
// asks as often.
const METRICS = {
  time: {label: 'time', of: c => c.seconds, fmt: s => dur(s)},
  entries: {label: 'entries', of: c => c.entries, fmt: n => String(n)},
  tokens: {label: 'tokens', of: c => tok(c.tokens), fmt: n => big(n)},
  output: {label: 'output tokens', of: c => c.tokens.output, fmt: n => big(n)},
};
const tok = t => t.input + t.output + t.cache_read + t.cache_write;
const dur = s => s < 60 ? (s > 0 ? '<1m' : '0') : s < 3600 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd';
const big = n => n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
const color = (states, s) => `var(--s${states.indexOf(s) % 12})`;
const day = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});

const pick = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let metric = pick('sf-analytics-metric', 'time');
if(!METRICS[metric]) metric = 'time';
let allWeeks = false, find = '', last = null;

const val = (cells, s) => cells[s] ? METRICS[metric].of(cells[s]) : 0;

function weeksView(d){
  const m = METRICS[metric];
  const rows = (allWeeks ? d.weeks : d.weeks.slice(-12)).slice().reverse();
  if(!rows.length) return '<p class="empty">No transitions recorded yet.</p>';
  const totals = rows.map(w => d.states.reduce((a, s) => a + val(w.states, s), 0));
  const max = Math.max(1, ...totals);
  return `<div class="weeks">${rows.map((w, i) => {
    const segs = d.states.filter(s => val(w.states, s) > 0).map(s =>
      `<i style="width:${(val(w.states, s) / max * 100).toFixed(3)}%;background:${color(d.states, s)}" title="${esc(s)}: ${esc(m.fmt(val(w.states, s)))}"></i>`).join('');
    return `<div class="wk"><span class="d">${esc(day(w.week))}</span><div class="stk" role="img" aria-label="week of ${esc(w.week)}: ${esc(m.fmt(totals[i]))}">${segs}</div><span class="v">${esc(m.fmt(totals[i]))}</span></div>`;
  }).join('')}</div>`;
}

function itemsView(d){
  const m = METRICS[metric];
  const q = find.trim().toLowerCase();
  const items = d.items.filter(it => !q || it.ticket.toLowerCase().includes(q) || (it.title || '').toLowerCase().includes(q))
    .map(it => ({...it, total: d.states.reduce((a, s) => a + val(it.states, s), 0)}))
    .sort((a, b) => b.total - a.total || (a.ticket < b.ticket ? -1 : 1));
  const cols = d.states.filter(s => d.items.some(it => val(it.states, s) > 0));
  if(!items.length) return `<p class="empty">${q ? 'No item matches.' : 'No items yet.'}</p>`;
  return `<div class="tbl"><table><thead><tr><th class="k">item</th><th>total</th>${cols.map(s =>
      `<th><span class="sw" style="background:${color(d.states, s)}"></span>${esc(s)}</th>`).join('')}</tr></thead><tbody>${items.map(it =>
    `<tr class="${it.live ? '' : 'gone'}"><td class="k"><b>${esc(it.ticket)}</b><small>${esc(it.title || '')}${it.title ? ' &middot; ' : ''}<span class="nowst">${esc(it.live ? it.state || '' : 'off the board')}</span></small></td>` +
    `<td>${esc(m.fmt(it.total))}</td>${cols.map(s => { const v = val(it.states, s); return `<td class="${v ? '' : 'z'}">${v ? esc(m.fmt(v)) : '&middot;'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function footView(d){
  const un = Object.entries(d.unattributed).map(([who, t]) => `${esc(who)} ${esc(big(tok(t)))}`).join(', ');
  return `<p class="note">Time runs from each state change to the next, and the current state counts up to now; done counts entries only. ` +
    `Tokens are input, output and cache reads and writes of the item's agent while it was on that item. ` +
    `${d.left_out.length ? `Not counted: ${esc(d.left_out.join(', '))} (the lead, reviewers, and agents on another host). ` : ''}` +
    `${un ? `Spent with no item: ${un}.` : ''}</p>`;
}

function render(d){
  last = d;
  const root = document.getElementById('root');
  const focused = document.activeElement && document.activeElement.id === 'find';
  const used = d.states.filter(s => d.weeks.some(w => w.states[s]));
  root.innerHTML =
    `<div class="chips" role="group" aria-label="measure">${Object.entries(METRICS).map(([k, x]) =>
      `<button class="chip ${k === metric ? 'on' : ''}" data-metric="${k}" aria-pressed="${k === metric}">${esc(x.label)}</button>`).join('')}</div>` +
    `<section><h2>By week</h2><div class="legend">${used.map(s => `<span><i class="sw" style="background:${color(d.states, s)}"></i>${esc(s)}</span>`).join('')}</div>` +
    weeksView(d) +
    (d.weeks.length > 12 ? `<div class="chips"><button class="chip" id="allweeks">${allWeeks ? 'last 12 weeks' : `all ${d.weeks.length} weeks`}</button></div>` : '') +
    `</section><section><h2>By item</h2><input class="find" id="find" type="search" placeholder="filter items" aria-label="filter items" value="${esc(find)}">` +
    itemsView(d) + footView(d) + `</section>`;
  root.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => { metric = b.dataset.metric; keep('sf-analytics-metric', metric); render(last); }));
  const aw = document.getElementById('allweeks');
  if(aw) aw.addEventListener('click', () => { allWeeks = !allWeeks; render(last); });
  const f = document.getElementById('find');
  f.addEventListener('input', () => { find = f.value; render(last); });
  if(focused){ f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

(function(){
  async function tick(){
    const pulse = document.getElementById('pulse'), at = document.getElementById('at');
    let d;
    try { d = await (await fetch('/api/analytics', {cache: 'no-store'})).json(); }
    catch { pulse.classList.add('stale'); at.textContent = 'not answering'; return; }
    pulse.classList.remove('stale'); at.textContent = d.at;
    render(d);
  }
  tick(); setInterval(tick, 30000);
})();
