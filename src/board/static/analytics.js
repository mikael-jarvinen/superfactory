// The analytics page, from /api/analytics. The top chart answers "how long does a piece of work
// spend in each state": one bar per period (or one for all time), each segment the average per
// ticket that ended a stay in that state then, with its median, p80 and p95 on hover or tap. Week
// and month add a trend card per measure and a table with each figure's change from the period
// before. All time adds every item's totals. The board reads the history once every thirty
// seconds, so the page asks as often.
const METRICS = {
  time: {label: 'time', key: 'seconds', of: c => c.seconds, fmt: s => dur(s)},
  entries: {label: 'entries', key: 'entries', of: c => c.entries, fmt: n => Number.isInteger(n) ? String(n) : n.toFixed(1)},
  tokens: {label: 'tokens', key: 'tokens', of: c => tok(c.tokens), fmt: n => big(n)},
  output: {label: 'output tokens', key: 'output', of: c => c.tokens.output, fmt: n => big(n)},
};
const tok = t => t.input + t.output + t.cache_read + t.cache_write;
const dur = s => s < 60 ? (s > 0 ? '<1m' : '0') : s < 3600 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd';
const big = n => n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
const color = (states, s) => `var(--s${states.indexOf(s) % 12})`;
// a count of tickets changes by how many, not by percent
const COUNT = {fmt: n => String(n), abs: true};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const pick = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let metric = pick('sf-analytics-metric', 'time');
if(!METRICS[metric]) metric = 'time';
const PERIODS = {all: 'all time', week: 'week', month: 'month'};
let period = pick('sf-analytics-period', 'all');
if(!PERIODS[period]) period = 'all';
let showAll = false, find = '', last = null, bars = [];
const SHOWN = 12;

// The buckets the period switch picks, oldest first: all time is one. Each has its label, and
// whether it is still running, so its figures are only so far.
function bucketsOf(d){
  if(period === 'all') return [{...d.all, key: 'all', label: 'All time', running: true}];
  if(period === 'month') return d.months.map(m => {
    const [y, mo] = m.month.split('-').map(Number);
    const start = Date.UTC(y, mo - 1, 1), end = Date.UTC(y, mo, 1);
    return {...m, key: m.month, end, running: d.now < end,
      label: new Date(start).toLocaleDateString('en-GB', {month: 'long', year: 'numeric', timeZone: 'UTC'}),
      short: new Date(start).toLocaleDateString('en-GB', {month: 'long', timeZone: 'UTC'})};
  });
  return d.weeks.map(w => {
    const start = Date.parse(w.week + 'T00:00:00Z'), end = start + 7 * 86400000;
    const day = new Date(start).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'});
    return {...w, key: w.week, end, running: d.now < end, label: 'Week of ' + day, short: day};
  });
}
const avg = (b, s) => b.stats[s] ? b.stats[s][METRICS[metric].key].mean : 0;
const shown = bs => bs.slice(-(showAll ? bs.length : SHOWN));

// The change from the period before: by how much for a count, by percent for an average.
// Nothing when both are empty or there is no period before. Callers pass no average whose period
// before had no figure, as there is nothing to compare it with.
function change(cur, prev, m = METRICS[metric]){
  if(prev === undefined || (!cur && !prev)) return '';
  if(cur === prev) return `<small class="dl">=</small>`;
  const up = cur > prev;
  const by = prev && !m.abs ? Math.round(Math.abs(cur - prev) / prev * 100) + '%' : m.fmt(Math.abs(cur - prev));
  return `<small class="dl" title="${up ? 'up' : 'down'} from ${esc(m.fmt(prev))}">${up ? '↑' : '↓'}${esc(by)}</small>`;
}

const stillIn = (b, s) => b.open && b.open[s] ? `${b.open[s].n} still in` : '';

// The top chart: a bar per bucket, newest first. Segments are per-state averages over different
// tickets, so the bar ends in how many tickets it covers, not a sum.
function barsView(d, bs){
  const m = METRICS[metric];
  bars = shown(bs).slice().reverse();
  if(!d.items.length) return '<p class="empty">No transitions recorded yet.</p>';
  const width = b => d.states.reduce((a, s) => a + avg(b, s), 0);
  const max = Math.max(1e-9, ...bars.map(width));
  return `<div class="weeks">${bars.map((b, bi) => {
    const segs = d.states.filter(s => avg(b, s) > 0).map(s =>
      `<i tabindex="0" data-b="${bi}" data-s="${esc(s)}" style="width:${(avg(b, s) / max * 100).toFixed(3)}%;background:${color(d.states, s)}" aria-label="${esc(s)}: average ${esc(m.fmt(avg(b, s)))} per ticket"></i>`).join('');
    // a state with only open stays has no segment, and so no tip: the longest wait shows here too
    const open = d.states.filter(s => b.open && b.open[s]).map(s => `${esc(s)} ${b.open[s].n} (longest ${esc(dur(b.open[s].longest))})`).join(', ');
    return `<div class="wk"><span class="d">${esc(b.label)}${b.running && period !== 'all' ? ' <em>so far</em>' : ''}</span>` +
      `<div class="stk" role="group" aria-label="${esc(b.label)}, average per ticket">${segs}</div>` +
      `<span class="v">${esc(plural(b.tickets, 'ticket', 'tickets'))}</span>` +
      (open ? `<span class="open">still in: ${open}</span>` : '') + `</div>`;
  }).join('')}</div>`;
}

// The tooltip of one segment: the state, its average in real units, the median, p80 and p95, and
// over how many tickets, plus the tickets still in it.
function tipView(b, s){
  const m = METRICS[metric], st = b.stats[s][m.key];
  const o = b.open && b.open[s];
  return `<b><span class="sw" style="background:${color(last.states, s)}"></span>${esc(s)}</b><span class="per">${esc(b.label)} &middot; ${esc(m.label)} per ticket</span>` +
    `<dl><dt>average</dt><dd>${esc(m.fmt(st.mean))}</dd><dt>median</dt><dd>${esc(m.fmt(st.p50))}</dd>` +
    `<dt>p80</dt><dd>${esc(m.fmt(st.p80))}</dd><dt>p95</dt><dd>${esc(m.fmt(st.p95))}</dd><dt>n</dt><dd>${esc(plural(st.n, 'ticket', 'tickets'))}</dd></dl>` +
    (o ? `<span class="per">${esc(plural(o.n, 'ticket', 'tickets'))} still in ${esc(s)}, not counted, the longest ${esc(dur(o.longest))} so far</span>` : '');
}

// How the tip was opened: a tap or click toggles it, while focus and a mouse's hover only show it,
// as a tap focuses the segment just before its click lands.
let tipFor = null, tipBy = null;
function showTip(el, by){
  const tip = document.getElementById('tip'), b = bars[+el.dataset.b];
  if(!b || !b.stats[el.dataset.s]) return hideTip();
  tip.innerHTML = tipView(b, el.dataset.s);
  tip.hidden = false;
  tipFor = el;
  tipBy = by;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth || 220, vw = document.documentElement.clientWidth || innerWidth;
  tip.style.left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  tip.style.top = (r.bottom + 8 + scrollY) + 'px';
}
function hideTip(){
  const tip = document.getElementById('tip');
  if(tip) tip.hidden = true;
  tipFor = tipBy = null;
}

function trendsView(d, bs){
  return Object.entries(METRICS).map(([k, m]) => {
    // an empty period has no figure, so it carries no point and shows no change
    const fig = b => b && b.total ? b.total[m.key].mean : null;
    const series = shown(bs).map(fig);
    const cur = series[series.length - 1];
    // the change compares the last two finished periods, so the card says whether the latest whole
    // week or month was better or worse than the one before; the running one is only on the line
    const done = bs.filter(b => !b.running), a = done[done.length - 1], p = done[done.length - 2];
    const vs = a && p && fig(a) !== null && fig(p) !== null ? change(fig(a), fig(p), m) : '';
    const tc = vs ? `<span class="tc">${esc(a.label)} vs ${esc(p.short)}: ${esc(m.fmt(fig(a)))} ${vs}</span>` : '';
    return `<button class="trend ${k === metric ? 'on' : ''}" data-metric="${k}" aria-pressed="${k === metric}">` +
      `<span class="tl">${esc(m.label)}</span><span class="tv">${cur === null ? '&middot;' : esc(m.fmt(cur))}</span>` +
      `<span class="tu">avg per ticket${bs[bs.length - 1].running ? ', so far' : ''}</span>${tc}${spark(series, bs[bs.length - 1].running)}</button>`;
  }).join('');
}

// One small line per measure, oldest period on the left; the period still running is dashed, as
// its figure is only so far. An empty period (null) has no figure, so it breaks the line rather
// than dipping it to the floor; a figure alone between gaps shows as a dot.
function spark(vals, running){
  if(vals.length < 2) return '';
  const max = Math.max(0, ...vals.filter(v => v !== null)), n = vals.length;
  const pts = vals.map((v, i) => v === null ? null : `${(i / (n - 1) * 100).toFixed(2)},${(29 - (max ? v / max * 26 : 0)).toFixed(2)}`);
  const done = running ? pts.slice(0, -1) : pts;
  const runs = [[]];
  for(const p of done) p === null ? runs.push([]) : runs[runs.length - 1].push(p);
  // a lone point is drawn as a line of no length, which its round cap makes a dot
  const line = (r, cls = '') => r.length ? `<polyline${cls} points="${(r.length > 1 ? r : [r[0], r[0]]).join(' ')}"/>` : '';
  const last = pts.slice(-2);
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">` +
    runs.map(r => line(r)).join('') +
    (running && last[1] !== null ? (last[0] !== null ? line(last, ' class="so"') : line([last[1]], ' class="so"')) : '') + `</svg>`;
}

function tableView(d, bs){
  const m = METRICS[metric];
  const cols = d.states.filter(s => bs.some(b => b.stats[s] || (b.open && b.open[s])));
  const rows = bs.map((b, i) => ({...b, prev: bs[i - 1]}));
  const head = `<th class="k">${period}</th><th>tickets</th>${cols.map(s => `<th><span class="sw" style="background:${color(d.states, s)}"></span>${esc(s)}</th>`).join('')}`;
  // a period still running shows its figures so far, but no change from the one before
  // nor does a state with no stay ending in the period: it has no figure, so nothing to compare
  const vs = (b, cur, prev, m) => b.prev && !b.running ? change(cur, prev, m) : '';
  // and an average whose period before had none is not a change by how much: nothing to compare
  const vsState = (b, s) => b.stats[s] && b.prev && b.prev.stats[s] ? vs(b, avg(b, s), avg(b.prev, s)) : '';
  return `<div class="tbl"><table class="per"><thead><tr>${head}</tr></thead><tbody>${shown(rows).reverse().map(b => {
    const empty = !b.tickets && !Object.keys(b.open || {}).length;
    const tickets = `<td class="${b.tickets ? '' : 'z'}">${b.tickets || '&middot;'}${vs(b, b.tickets, b.prev && b.prev.tickets, COUNT)}</td>`;
    return `<tr class="${empty ? 'none' : ''}"><td class="k"><b>${esc(b.label)}</b><small>${b.running ? 'so far' : empty ? 'nothing recorded' : ''}</small></td>${tickets}` +
      cols.map(s => {
        const v = avg(b, s), o = stillIn(b, s);
        return `<td class="${v ? '' : 'z'}">${v ? esc(m.fmt(v)) : '&middot;'}${vsState(b, s)}${o ? `<small class="still">${esc(o)}</small>` : ''}</td>`;
      }).join('') + `</tr>`;
  }).join('')}</tbody></table></div>`;
}

function itemsView(d){
  const m = METRICS[metric];
  const val = (cells, s) => cells[s] ? m.of(cells[s]) : 0;
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
  const unit = {all: 'all time', week: 'that week', month: 'that month'}[period];
  return `<p class="note">The bars are averages per ticket: each segment is what a ticket spent in that state, its stays there added up, ` +
    `averaged over the tickets that ended a stay in it ${unit}. A stay counts whole in the ${period === 'all' ? 'period' : period} it ended. ` +
    `Stays still open are left out of the averages and shown as "still in". Hover or tap a segment for the median, p80, p95 and n. ` +
    `${period === 'week' ? 'Weeks start on Monday, UTC. ' : period === 'month' ? 'Months are calendar months, UTC. ' : ''}` +
    `${period === 'all' ? '' : `Arrows are the change from the ${period} before. The ${period} still running counts only so far, and shows no change until it ends. `}` +
    `Done counts entries only. Tokens are input, output and cache reads and writes of the item's agent while it was on that item. ` +
    `Every agent counts, on whichever machine it runs; the lead and the reviewers are never an item's agent, so theirs is spent with no item. ` +
    `${d.left_out.length ? `Not counted yet: ${esc(d.left_out.join(', '))} (${esc(hostsNote(d.hosts))}). ` : ''}` +
    `${stale(d.hosts) ? `${esc(stale(d.hosts))}. ` : ''}` +
    `${un ? `Spent with no item: ${un}.` : ''}</p>`;
}

// Why a host's agents are not counted: it has not been read yet, or its read failed.
function hostsNote(hosts){
  return Object.entries(hosts || {}).filter(([, r]) => r.read_at == null)
    .map(([h, r]) => r.error ? `${h} could not be read: ${r.error}` : `${h} is still being read`).join('; ');
}

// A host read before whose last read failed: its counts are as of that earlier read.
function stale(hosts){
  return Object.entries(hosts || {}).filter(([, r]) => r.read_at != null && r.error)
    .map(([h, r]) => `${h} as of ${new Date(r.read_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, as its last read failed: ${r.error}`).join('; ');
}

// The page is built once and each part is refilled in place, so the filter keeps its caret and any
// composition in progress, and the tables keep where they were scrolled to, across every refresh.
function shell(root){
  root.innerHTML =
    `<div class="chips" role="group" aria-label="period" id="periods"></div>` +
    `<div class="chips" role="group" aria-label="measure" id="metrics"></div>` +
    `<section><h2 id="barsh"></h2><div class="legend" id="legend"></div><div id="weeks"></div><div id="more"></div></section>` +
    `<div id="per" hidden><section><h2>Trend, average per ticket</h2><div class="trends" id="trends"></div></section>` +
    `<section><h2>Average per ticket, by state</h2><div id="ptable"></div></section></div>` +
    `<div id="all"><section><h2>Totals by item</h2><input class="find" id="find" type="search" placeholder="filter items" aria-label="filter items">` +
    `<div id="items"></div></section></div>` +
    `<div id="foot"></div><div class="tip" id="tip" role="tooltip" hidden></div>`;
  root.addEventListener('click', e => {
    const seg = e.target.closest('.stk i'), b = e.target.closest('[data-metric]'), p = e.target.closest('[data-period]');
    if(seg){ seg === tipFor && tipBy === 'tap' && !document.getElementById('tip').hidden ? hideTip() : showTip(seg, 'tap'); return; }
    if(!e.target.closest('#tip')) hideTip();
    if(b){ metric = b.dataset.metric; keep('sf-analytics-metric', metric); render(last); }
    else if(p){ period = p.dataset.period; keep('sf-analytics-period', period); showAll = false; render(last); }
    else if(e.target.closest('#showall')){ showAll = !showAll; render(last); }
  });
  // a mouse shows the tip on hover; a touch has no hover, and taps instead
  root.addEventListener('pointerover', e => { const seg = e.target.closest('.stk i'); if(seg && e.pointerType === 'mouse' && seg !== tipFor) showTip(seg, 'hover'); });
  root.addEventListener('pointerout', e => { const seg = e.target.closest('.stk i'); if(seg && e.pointerType === 'mouse' && seg === tipFor && tipBy === 'hover') hideTip(); });
  root.addEventListener('focusin', e => { const seg = e.target.closest('.stk i'); if(seg && seg !== tipFor) showTip(seg, 'focus'); });
  root.addEventListener('focusout', e => { if(e.target.closest('.stk i') && tipBy === 'focus') hideTip(); });
  addEventListener('keydown', e => { if(e.key === 'Escape') hideTip(); });
  const f = root.querySelector('#find');
  f.value = find;
  f.addEventListener('input', () => { find = f.value; items(last); });
}

function fill(id, html){
  const el = document.getElementById(id);
  if(el.innerHTML !== html) el.innerHTML = html;
}

// Refill a box holding a sideways-scrolling table, and keep where it was scrolled to.
function fillScrolled(id, html){
  const box = document.querySelector(`#${id} .tbl`);
  const x = box ? box.scrollLeft : 0;
  fill(id, html);
  const nbox = document.querySelector(`#${id} .tbl`);
  if(nbox && nbox !== box) nbox.scrollLeft = x;
}
const items = d => fillScrolled('items', itemsView(d));

function render(d){
  last = d;
  const root = document.getElementById('root');
  if(!document.getElementById('find')) shell(root);
  fill('periods', Object.entries(PERIODS).map(([k, x]) =>
    `<button class="chip ${k === period ? 'on' : ''}" data-period="${k}" aria-pressed="${k === period}">${esc(x)}</button>`).join(''));
  fill('metrics', Object.entries(METRICS).map(([k, x]) =>
    `<button class="chip ${k === metric ? 'on' : ''}" data-metric="${k}" aria-pressed="${k === metric}">${esc(x.label)}</button>`).join(''));
  const bs = bucketsOf(d), unit = period === 'week' ? 'weeks' : 'months';
  document.getElementById('all').hidden = period !== 'all';
  document.getElementById('per').hidden = period === 'all';
  fill('barsh', `Average ${esc(METRICS[metric].label)} per ticket, ${period === 'all' ? 'all time' : 'by ' + period}`);
  const used = d.states.filter(s => bs.some(b => avg(b, s) > 0));
  fill('legend', used.map(s => `<span><i class="sw" style="background:${color(d.states, s)}"></i>${esc(s)}</span>`).join(''));
  // an open tip is redrawn from the new figures, on the same period and state, as an open stay's
  // longest wait grows between refreshes; it hides when that segment is gone
  const was = tipFor && !document.getElementById('tip').hidden ? {key: bars[+tipFor.dataset.b]?.key, s: tipFor.dataset.s, by: tipBy} : null;
  fill('weeks', barsView(d, bs));
  const bi = was ? bars.findIndex(b => b.key === was.key) : -1;
  const seg = bi < 0 ? null : [...document.querySelectorAll('#weeks .stk i')].find(x => +x.dataset.b === bi && x.dataset.s === was.s);
  seg ? showTip(seg, was.by) : hideTip();
  fill('more', bs.length > SHOWN ? `<div class="chips"><button class="chip" id="showall">${showAll ? `last ${SHOWN} ${unit}` : `all ${bs.length} ${unit}`}</button></div>` : '');
  if(period === 'all') items(d);
  else {
    fill('trends', trendsView(d, bs));
    fillScrolled('ptable', tableView(d, bs));
  }
  fill('foot', footView(d));
}

(function(){
  async function tick(){
    const pulse = document.getElementById('pulse'), at = document.getElementById('at');
    let d;
    try {
      const res = await fetch('/api/analytics', {cache: 'no-store'});
      // the board's own error, when it sent one, says why
      if(!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '');
      d = await res.json();
    }
    catch(e) { pulse.classList.add('stale'); at.textContent = e.message ? `not answering: ${e.message}` : 'not answering'; return; }
    pulse.classList.remove('stale'); at.textContent = d.at;
    render(d);
  }
  tick(); setInterval(tick, 30000);
})();
