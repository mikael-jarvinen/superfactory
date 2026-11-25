// The GitHub traffic page, from /api/github. PR traffic per day by repo or by author, review traffic
// per day by reviewer, and the author and reviewer tables. The filters live in the URL, so a view can be shared.
const q = new URLSearchParams(location.search);
const view = {
  days: Number(q.get('days')) || 30,
  repos: q.get('repos') || '',
  bots: q.get('bots') === '1',
  pr: q.get('pr') || 'opened',
  // PR traffic stacked by repo, or by the PR's author
  by: q.get('by') === 'author' ? 'author' : 'repo',
  rv: q.get('rv') || 'reviews',
};
const PR_METRICS = { opened: 'Opened', merged: 'Merged', closed: 'Closed unmerged', open: "Open at day's end", lines: 'Lines changed' };
const RV_METRICS = { reviews: 'Reviews', approvals: 'Approvals', changes: 'Changes requested', lines: 'Lines reviewed' };
// The reviewers, and the PR authors, who get a colour of their own; the rest are Other.
const PEOPLE_SHOWN = 7;
let last = null;

const fmtDay = (d, long) => {
  const t = new Date(d + 'T12:00:00Z');
  return t.toLocaleDateString('en-GB', long ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const hours = h => h == null ? '–' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? (Math.round(h * 10) / 10) + ' h' : (Math.round(h / 24 * 10) / 10) + ' d';
const sum = xs => xs.reduce((a, b) => a + b, 0);
const num = n => Number(n).toLocaleString('en-GB');
// an axis number: 12k rather than 12000
const tick = n => n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
// a series value as the tooltip and the table say it: lines changed carry their added and removed halves
const said = (s, i) => s.split ? `${num(s.values[i] || 0)} <small>+${num(s.split.added[i] || 0)} −${num(s.split.deleted[i] || 0)}</small>` : num(s.values[i] || 0);
const slot = i => i < 8 ? `var(--c${i + 1})` : 'var(--cother)';
const avatar = p => p && p.avatar ? `<img class="av" src="${esc(p.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';

function save(){
  const p = new URLSearchParams();
  if(view.days !== 30) p.set('days', view.days);
  if(view.repos) p.set('repos', view.repos);
  if(view.bots) p.set('bots', '1');
  if(view.pr !== 'opened') p.set('pr', view.pr);
  if(view.by !== 'repo') p.set('by', view.by);
  if(view.rv !== 'reviews') p.set('rv', view.rv);
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
}
const apiUrl = () => `/api/github?days=${view.days}&repos=${encodeURIComponent(view.repos)}&bots=${view.bots ? 1 : 0}`;

// A stacked bar per day: series [{key,label,color,values}], one value per day. The hit area of a
// day spans its whole column, and its tooltip lists every series that day.
function bars(id, days, series, unit){
  const W = 960, H = 220, L = 40, B = 22, T = 8;
  const totals = days.map((_, i) => sum(series.map(s => s.values[i] || 0)));
  const max = Math.max(1, ...totals);
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const step = max <= 4 ? 1 : max <= 10 ? 2 : [1, 2, 2.5, 5, 10].map(m => m * mag).find(x => x >= raw);
  const top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top);
  const band = (W - L) / days.length, bw = Math.max(2, Math.min(28, band * 0.7));
  const every = days.length <= 10 ? 1 : days.length <= 31 ? 5 : 14;
  let g = '';
  for(let v = 0; v <= top; v += step) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${tick(v)}</text>`;
  days.forEach((d, i) => {
    const x = L + band * i + (band - bw) / 2;
    const idxFromEnd = days.length - 1 - i;
    if(idxFromEnd % every === 0) g += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(fmtDay(d, days.length <= 10))}</text>`;
    let base = 0;
    const segs = series.map(s => ({ s, v: s.values[i] || 0 })).filter(x => x.v > 0);
    segs.forEach((seg, j) => {
      const y0 = y(base), y1 = y(base + seg.v);
      const gap = j > 0 ? 2 : 0, h = Math.max(1, y0 - y1 - gap);
      const topSeg = j === segs.length - 1;
      const r = topSeg ? Math.min(4, bw / 2, h) : 0;
      const yy = y1, x2 = x + bw, yb = yy + h;
      g += r ? `<path d="M${x},${yb}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x2 - r}Q${x2},${yy} ${x2},${yy + r}V${yb}Z" fill="${seg.s.color}"/>`
             : `<rect x="${x}" y="${yy}" width="${bw}" height="${h}" fill="${seg.s.color}"/>`;
      base += seg.v;
    });
    g += `<rect class="hit" data-chart="${id}" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`;
  });
  return `<svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)} per day">${g}</svg>`;
}

function legend(series){
  return `<div class="legend">${series.map(s => `<span><i class="sw" style="background:${s.color}"></i>${s.icon || ''}${esc(s.label)}</span>`).join('')}</div>`;
}

function table(days, series){
  const rows = days.map((d, i) => `<tr><td>${esc(fmtDay(d, true))}</td>${series.map(s => `<td>${said(s, i)}</td>`).join('')}<td>${num(sum(series.map(s => s.values[i] || 0)))}</td></tr>`).reverse().join('');
  return `<details class="tbl"><summary>table</summary><div class="scroll"><table><thead><tr><th>day</th>${series.map(s => `<th>${esc(s.label)}</th>`).join('')}<th>total</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const charts = {};
function tipFor(el){
  const c = charts[el.dataset.chart], i = +el.dataset.i;
  if(!c) return;
  const rows = c.series.filter(s => (s.values[i] || 0) > 0).map(s => `<div><span><i class="sw" style="background:${s.color}"></i>${s.icon || ''}${esc(s.label)}</span><span>${said(s, i)}</span></div>`).join('');
  const tip = document.getElementById('tip');
  tip.innerHTML = `<b>${esc(fmtDay(c.days[i], true))} · ${esc(c.unit)}</b>${rows || '<div>none</div>'}<div class="tot"><span>total</span><span>${num(sum(c.series.map(s => s.values[i] || 0)))}</span></div>`;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), tw = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(scrollX + r.left + r.width / 2 - tw / 2, scrollX + document.documentElement.clientWidth - tw - 8)) + 'px';
  tip.style.top = (scrollY + r.top - tip.offsetHeight - 6 < scrollY ? scrollY + r.bottom + 6 : scrollY + r.top - tip.offsetHeight - 6) + 'px';
  document.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
  el.classList.add('on');
}
function hideTip(){
  document.getElementById('tip').hidden = true;
  document.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
}

function render(d){
  last = d;
  const root = document.getElementById('root');
  if(d.loading){
    root.innerHTML = `<div class="boot">reading GitHub for the first time, ${d.repos.length} repos <i></i><i></i><i></i></div>${d.error ? `<p class="note bad">${esc(d.error)}</p>` : ''}`;
    return;
  }
  const r = d.report;
  const selected = d.selected.join(',');
  const options = [['', 'all repos'], ...d.groups.filter(g => g.repos.length > 1 || d.groups.length > 1).map(g => [g.repos.join(','), g.label]), ...d.repos.map(x => [x.key, x.name])];
  const seen = new Set();
  const opts = options.filter(([v]) => !seen.has(v) && seen.add(v)).map(([v, l]) => `<option value="${esc(v)}" ${v === view.repos || (!view.repos && v === '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const ago = d.fetched ? Math.max(0, Math.round((Date.now() - Date.parse(d.fetched)) / 60000)) : null;

  // repos keep their configured colour whatever the filter
  const repoColor = k => slot(d.repos.findIndex(x => x.key === k));
  const prSeries = r.repos.map(k => ({ key: k, label: d.repos.find(x => x.key === k)?.name || k, color: repoColor(k), values: r.traffic[view.pr][k] || [],
    split: view.pr === 'lines' ? { added: r.traffic.added[k] || [], deleted: r.traffic.deleted[k] || [] } : null }));
  // people by one overall rank, PRs opened plus reviews, so a person has the same colour in both charts:
  // the first seven with a colour, the rest folded into Other
  const bySum = (per, l) => r.days.map((_, i) => sum(l.map(x => (per[x] || [])[i] || 0)));
  const personSeries = (per, rank, info, split) => {
    const top = rank.slice(0, PEOPLE_SHOWN);
    const out = top.filter(l => per[l] && sum(per[l]) > 0).map(l => ({ key: l, label: info[l]?.name || l, icon: avatar(info[l]), color: slot(top.indexOf(l)), values: per[l],
      split: split ? { added: split.added[l] || [], deleted: split.deleted[l] || [] } : null }));
    const rest = Object.keys(per).filter(l => !top.includes(l) && sum(per[l]) > 0);
    if(rest.length) out.push({ key: 'other', label: `Other (${rest.length})`, color: 'var(--cother)', values: bySum(per, rest),
      split: split ? { added: bySum(split.added, rest), deleted: bySum(split.deleted, rest) } : null });
    return out;
  };
  const people = Object.fromEntries(r.people.map(p => [p.login, p]));
  const rvSeries = personSeries(r.reviews[view.rv], d.rank, people, null);
  const authors = Object.fromEntries(r.authors.map(p => [p.login, p]));
  const prByAuthor = personSeries(r.byAuthor[view.pr], d.rank, authors, view.pr === 'lines' ? { added: r.byAuthor.added, deleted: r.byAuthor.deleted } : null);
  const prShown = view.by === 'author' ? prByAuthor : prSeries;
  const authorRows = r.authors.filter(a => a.opened || a.merged || a.closed);

  const total = m => sum(Object.values(r.traffic[m]).map(sum));
  const openNow = sum(Object.values(r.traffic.open).map(v => v[v.length - 1] || 0));
  const rvTotal = m => sum(Object.values(r.reviews[m]).map(sum));
  const added = total('added'), deleted = total('deleted');
  charts.pr = { days: r.days, series: prShown, unit: PR_METRICS[view.pr] };
  charts.rv = { days: r.days, series: rvSeries, unit: RV_METRICS[view.rv] };

  root.innerHTML = `
    <div class="controls">
      <div class="chips">${d.ranges.map(n => `<button class="chip ${n === d.days ? 'on' : ''}" data-days="${n}" aria-pressed="${n === d.days}">${n} days</button>`).join('')}</div>
      <select class="pick" id="repos" aria-label="repos">${opts}</select>
      <label class="tog"><input type="checkbox" id="bots" ${d.bots ? 'checked' : ''}> show bots</label>
    </div>
    <p class="note ${d.failed.length || d.error ? 'bad' : ''}">${ago === null ? '' : `GitHub read ${ago < 1 ? 'just now' : ago + ' min ago'}${d.fetching ? ', reading again' : ''}`}${d.failed.length ? ` · could not read ${esc(d.failed.join(', '))}` : ''}${d.error ? ` · ${esc(d.error)}` : ''}${d.reading.length ? ` · still reading ${esc(d.reading.map(x => x.upTo ? `${x.name} (up to ${fmtDay(x.upTo.slice(0, 10))})` : x.name).join(', '))}` : ''} · days in Helsinki time · ${d.bots ? 'bots and the factory\'s replies included' : 'human reviews only'}</p>
    <section><div class="tiles">
      <div class="tile"><div class="v">${total('opened')}</div><div class="l">PRs opened</div></div>
      <div class="tile"><div class="v">${total('merged')}</div><div class="l">merged</div></div>
      <div class="tile"><div class="v">${total('closed')}</div><div class="l">closed unmerged</div></div>
      <div class="tile"><div class="v">${openNow}</div><div class="l">open now</div></div>
      <div class="tile"><div class="v">${rvTotal('reviews')}</div><div class="l">reviews</div></div>
      <div class="tile"><div class="v">${rvTotal('approvals')}</div><div class="l">approvals</div></div>
      <div class="tile"><div class="v">${hours(r.medians.firstReviewHours)}</div><div class="l">median to first review · ${r.medians.firstReviewN} PRs</div></div>
      <div class="tile"><div class="v">${hours(r.medians.mergeHours)}</div><div class="l">median to merge · ${r.medians.mergeN} PRs</div></div>
      <div class="tile"><div class="v">${num(added + deleted)}</div><div class="l">lines merged · +${num(added)} −${num(deleted)}</div></div>
    </div><p class="note">Lines are additions plus deletions as GitHub counts them, and include lockfiles and generated files.</p></section>
    <section class="card">
      <h2>PR traffic</h2>
      <div class="chips">${Object.entries(PR_METRICS).map(([k, l]) => `<button class="chip ${k === view.pr ? 'on' : ''}" data-pr="${k}" aria-pressed="${k === view.pr}">${esc(l)}</button>`).join('')}</div>
      <div class="chips by" role="group" aria-label="group PR traffic by"><span class="lbl">group by</span>${[['repo', 'repo'], ['author', 'author']].map(([k, l]) => `<button class="chip ${k === view.by ? 'on' : ''}" data-by="${k}" aria-pressed="${k === view.by}">${l}</button>`).join('')}</div>
      ${prShown.length ? legend(prShown) + bars('pr', r.days, prShown, PR_METRICS[view.pr]) + table(r.days, prShown) : '<p class="note">none in this range</p>'}
    </section>
    <section class="card">
      <h2>Review traffic</h2>
      <div class="chips">${Object.entries(RV_METRICS).map(([k, l]) => `<button class="chip ${k === view.rv ? 'on' : ''}" data-rv="${k}" aria-pressed="${k === view.rv}">${esc(l)}</button>`).join('')}</div>
      ${rvSeries.length ? legend(rvSeries) + bars('rv', r.days, rvSeries, RV_METRICS[view.rv]) + table(r.days, rvSeries) : '<p class="note">none in this range</p>'}
    </section>
    <section class="card">
      <h2>PR authors</h2>
      ${authorRows.length ? `<div class="scroll"><table><thead><tr><th>author</th><th>PRs opened</th><th>merged</th><th>closed unmerged</th><th>lines merged</th></tr></thead><tbody>${authorRows.map(p =>
        `<tr><td class="who"><span class="p">${avatar(p)}${esc(p.name)}${p.name !== p.login ? ` <small>${esc(p.login)}</small>` : ''}${p.bot ? ' <small>bot</small>' : ''}</span></td><td>${p.opened}</td><td>${p.merged}</td><td>${p.closed}</td><td>${num(p.lines)} <small>+${num(p.added)} −${num(p.deleted)}</small></td></tr>`).join('')}</tbody></table></div>` : '<p class="note">no PRs in this range</p>'}
    </section>
    <section class="card">
      <h2>Reviewers</h2>
      ${r.people.length ? `<div class="scroll"><table><thead><tr><th>reviewer</th><th>reviews</th><th>approvals</th><th>changes requested</th><th>comments</th><th>lines reviewed</th></tr></thead><tbody>${r.people.map(p =>
        `<tr><td class="who"><span class="p">${avatar(p)}${esc(p.name)}${p.name !== p.login ? ` <small>${esc(p.login)}</small>` : ''}${p.bot ? ' <small>bot</small>' : ''}</span></td><td>${p.reviews}</td><td>${p.approvals}</td><td>${p.changes}</td><td>${p.comments}</td><td>${num(p.lines)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">nobody reviewed in this range</p>'}
    </section>`;
}

async function load(){
  const pulse = document.getElementById('pulse'), at = document.getElementById('at');
  let d;
  try {
    const res = await fetch(apiUrl(), {cache: 'no-store'});
    if(!res.ok) throw new Error(String(res.status));
    d = await res.json();
  } catch { pulse.classList.add('stale'); at.textContent = 'not answering'; return; }
  pulse.classList.remove('stale'); at.textContent = d.at;
  hideTip();
  render(d);
}

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-days],button[data-pr],button[data-rv],button[data-by]');
  if(!b) return;
  if(b.dataset.days){ view.days = +b.dataset.days; save(); load(); }
  else if(b.dataset.pr){ view.pr = b.dataset.pr; save(); last && render(last); }
  else if(b.dataset.by){ view.by = b.dataset.by; save(); last && render(last); }
  else if(b.dataset.rv){ view.rv = b.dataset.rv; save(); last && render(last); }
});
document.addEventListener('change', e => {
  if(e.target.id === 'repos'){ view.repos = e.target.value; save(); load(); }
  else if(e.target.id === 'bots'){ view.bots = e.target.checked; save(); load(); }
});
document.addEventListener('mouseover', e => { const h = e.target.closest('.hit'); h ? tipFor(h) : null; });
document.addEventListener('mouseout', e => { if(e.target.closest('.hit') && !e.relatedTarget?.closest?.('.hit')) hideTip(); });
load();
// GitHub is read at most every 15 minutes; the page asks once a minute, and sooner while the first read runs.
let ticks = 0;
setInterval(() => { ticks++; if(!last || last.loading || last.fetching || ticks % 4 === 0) load(); }, 15000);
