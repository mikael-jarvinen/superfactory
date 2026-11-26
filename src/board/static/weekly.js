// The weekly usage chart, from /api/weekly (weekly.ts): how much of the plan's weekly limit was spent,
// cumulatively within each week, from the reset two weeks before the current week's to the next
// one. The dashed line is the estimate from the transcripts and the solid one the plan's own
// figure, where the board has sampled it. The chart's one axis is the percent: the estimate's
// tokens are read from it on hover, on its latest point and in the legend's limit, but are no axis of
// their own, as the limit is cost, not tokens, so tokens do not run in step with the percent. A
// table says how much was spent by the end of each Friday and Sunday (midnight after them, in the
// browser's time), and by the reset, in percent and in tokens. The board makes a new report every
// thirty seconds at most, so the page asks once a minute.
(function(){
  const DAY = 86400000;
  const el = document.getElementById('weekly');
  if(!el) return;
  let last = null, hoverT = null, geo = null;
  const pct = v => v == null ? '–' : (v < 10 ? v.toFixed(1) : Math.round(v)) + '%';
  const usd = v => '$' + (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
  const big = n => n < 1e3 ? String(Math.round(n)) : n < 1e6 ? Math.round(n / 1e3) + 'k' : n < 1e9 ? (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M' : (n / 1e9).toFixed(2) + 'B';
  // the token types, in the order the report lists them (token_kinds)
  const kinds = d => d.token_kinds.map(k => k.replace('_', ' '));
  // the tokens of the estimate at a time, by type, from its point there (the full week's at a reset)
  const tokensAt = (d, t, full = false) => {
    let row = null;
    for(const p of d.tokens){ if(p[0] > t) break; if(!(full && row && row[0] === p[0])) row = p; }
    return row && row.slice(1);
  };
  const total = s => s ? s.reduce((a, b) => a + b, 0) : null;
  const toks = n => n == null ? '–' : big(n);
  const day = (t, o) => new Date(t).toLocaleString('en-GB', o);
  const when = t => day(t, {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});

  // The value of a series at a time: its last point at or before it, none before its first.
  function valueAt(series, t, gap = Infinity){
    let v = null, at = null;
    for(const [x, y] of series){ if(x > t) break; v = y; at = x; }
    return at != null && t - at <= gap ? v : null;
  }
  // The actual line's gaps: no sample within an hour of a time is no value there.
  const GAP = 3600000;

  el.innerHTML = `<section><h2>Weekly usage</h2><div class="legend" id="wlegend"></div>` +
    `<div class="wchart" id="wchart"></div><div id="wtable"></div><p class="note" id="wnote"></p></section>`;
  const chart = el.querySelector('#wchart');

  function svg(d){
    const W = Math.max(chart.clientWidth || 0, 320), H = W < 520 ? 220 : 280;
    const L = 40, R = 10, T = 14, B = 30;
    const x = t => L + (t - d.start) / (d.end - d.start) * (W - L - R);
    const top = Math.max(100, ...d.estimate.map(p => p[1]), ...d.actual.map(p => p[1]));
    const ymax = Math.ceil(top * 1.04 / 25) * 25;
    const y = v => T + (1 - v / ymax) * (H - T - B);
    const parts = [];
    // the grid: every 25%, the limit's line stronger
    for(let v = 0; v <= ymax; v += 25){
      parts.push(`<line class="${v === 100 ? 'lim' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`);
    }
    // a tick at each local midnight; a label on each day when they fit, else on Fridays and Sundays
    const perDay = (W - L - R) / ((d.end - d.start) / DAY);
    const first = new Date(d.start); first.setHours(24, 0, 0, 0);
    for(let m = new Date(first); m.getTime() < d.end; m.setDate(m.getDate() + 1)){
      const t = m.getTime(), wd = m.getDay();
      parts.push(`<line class="tick" x1="${x(t)}" x2="${x(t)}" y1="${H - B}" y2="${H - B + 4}"/>`);
      if(perDay >= 34 || wd === 5 || wd === 0) {
        parts.push(`<text class="ax${wd === 5 || wd === 0 ? ' key' : ''}" x="${x(t + DAY / 2)}" y="${H - B + 16}" text-anchor="middle">${day(t, {weekday: 'short'})}</text>`);
        if(perDay >= 34 && wd === 1 || perDay < 34 && wd === 5) parts.push(`<text class="ax dim" x="${x(t + DAY / 2)}" y="${H - B + 27}" text-anchor="middle">${day(t, {day: 'numeric', month: 'short'})}</text>`);
      }
    }
    for(const r of d.resets) parts.push(`<line class="reset" x1="${x(r)}" x2="${x(r)}" y1="${T}" y2="${H - B}"/>`);
    parts.push(`<text class="ax dim" x="${x(d.resets[1]) + 4}" y="${T + 10}">reset</text>`);
    if(d.now < d.end) parts.push(`<line class="now" x1="${x(d.now)}" x2="${x(d.now)}" y1="${T}" y2="${H - B}"/>`);
    const path = (s, gap) => {
      let p = '', prev = null;
      // a gap in the samples, or a reset (two points at one time), starts the line afresh
      for(const [t, v] of s){ p += (prev == null || t - prev > gap || t === prev ? 'M' : 'L') + x(t).toFixed(1) + ' ' + y(v).toFixed(1); prev = t; }
      return p;
    };
    if(d.estimate.length) parts.push(`<path class="est" d="${path(d.estimate, Infinity)}"/>`);
    if(d.actual.length) parts.push(`<path class="act" d="${path(d.actual, GAP)}"/>`);
    // each line's latest value, marked and labelled, so a single sample shows too
    const ends = [['est', d.estimate.at(-1)], ['act', d.actual.at(-1)]].filter(e => e[1]);
    let prevY = null;
    for(const [k, [t, v]] of ends.sort((a, b) => a[1][1] - b[1][1])){
      const label = k === 'est' && d.tokens.length ? `${pct(v)} · ${big(total(d.tokens.at(-1).slice(1)))}` : pct(v);
      const left = x(t) > W - 6 * label.length - 20;
      let ly = y(v) + 4;
      if(prevY != null && Math.abs(prevY - ly) < 12) ly = prevY - 12;
      prevY = ly;
      parts.push(`<circle class="dot ${k}" cx="${x(t)}" cy="${y(v)}" r="4"/>` +
        `<text class="val" x="${x(t) + (left ? -8 : 8)}" y="${ly}" text-anchor="${left ? 'end' : 'start'}">${label}</text>`);
    }
    for(const h of d.hits){
      const v = valueAt(d.estimate, h) ?? 100;
      parts.push(`<g class="hit" transform="translate(${x(h)},${y(v)})"><circle r="5"/><path d="M-2.5 -2.5L2.5 2.5M2.5 -2.5L-2.5 2.5"/></g>`);
    }
    if(hoverT != null){
      parts.push(`<line class="cross" x1="${x(hoverT)}" x2="${x(hoverT)}" y1="${T}" y2="${H - B}"/>`);
      const e = valueAt(d.estimate, hoverT), a = valueAt(d.actual, hoverT, GAP);
      if(e != null) parts.push(`<circle class="dot est" cx="${x(hoverT)}" cy="${y(e)}" r="4"/>`);
      if(a != null) parts.push(`<circle class="dot act" cx="${x(hoverT)}" cy="${y(a)}" r="4"/>`);
    }
    return {html: `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly usage, percent of the weekly limit, over three weeks">${parts.join('')}</svg>`, x, L, R, W};
  }

  function tipView(d, t){
    const e = valueAt(d.estimate, t), a = valueAt(d.actual, t, GAP), s = tokensAt(d, t);
    return `<b>${esc(when(t))}</b><dl>` +
      `<dt><i class="sw dash"></i>estimated</dt><dd>${pct(e)}</dd>` +
      `<dt><i class="sw solid"></i>actual</dt><dd>${pct(a)}</dd>` +
      (s ? `<dt class="tk">tokens</dt><dd>${toks(total(s))}</dd>` + kinds(d).map((k, i) => `<dt class="sub">${k}</dt><dd class="sub">${toks(s[i])}</dd>`).join('') : '') +
      `</dl>`;
  }

  function draw(){
    const d = last;
    if(!d) return;
    if(d.start == null){
      geo = null;
      chart.innerHTML = `<p class="note">No weekly reset is known yet: it comes from the plan's own figure or a call the weekly limit refused.</p>`;
      return;
    }
    const g = svg(d);
    chart.innerHTML = g.html + `<div class="tip wtip" id="wtip" role="tooltip"${hoverT == null ? ' hidden' : ''}></div>`;
    if(hoverT != null){
      const tip = chart.querySelector('#wtip');
      tip.innerHTML = tipView(d, hoverT);
      const px = g.x(hoverT);
      tip.style.top = '8px';
      tip.style.left = (px > g.W / 2 ? Math.max(0, px - 190) : px + 12) + 'px';
    }
    geo = g;
  }
  // a pointer over the chart, a mouse's or a finger's, shows both figures at its time
  chart.addEventListener('pointermove', ev => {
    const d = last, svgEl = chart.querySelector('svg');
    if(!d || !geo || !svgEl) return;
    const r = svgEl.getBoundingClientRect();
    const fx = (ev.clientX - r.left) / (r.width || geo.W) * geo.W;
    const f = (fx - geo.L) / (geo.W - geo.L - geo.R);
    const t = f < 0 || f > 1 ? null : Math.min(d.now, d.start + f * (d.end - d.start));
    if(t === hoverT) return;
    hoverT = t;
    draw();
  });
  chart.addEventListener('pointerleave', () => { if(hoverT != null){ hoverT = null; draw(); } });

  // Each week's figures at the end of its Friday and Sunday, local time, and at its reset (or now).
  function tableView(d){
    if(d.start == null) return '';
    const rows = [];
    for(let i = 0; i < 3; i++){
      const s = d.resets[i], e = d.resets[i + 1];
      const ends = [5, 0].map(wd => {
        const m = new Date(s); m.setHours(24, 0, 0, 0);
        while(m.getDay() !== (wd + 1) % 7) m.setDate(m.getDate() + 1);
        return m.getTime() < e ? m.getTime() : null;
      });
      // Each column once: its time, or none, and whether it is the current week's so far. The
      // estimate has a point at each local midnight, and at the reset a full week's point before
      // its 0; the plan's figure at the reset is its last sample before it.
      const cols = [...ends, e].map(t =>
        t == null ? null
        : t <= d.now ? {t, sofar: false, reset: t === e}
        : t === e && d.now < e ? {t: d.now, sofar: true, reset: false}
        : null);
      const cells = [], tcells = [];
      for(const c of cols){
        // the first token column carries the divider from the % ones
        const tk = tcells.length ? 'tk' : 'tk tk1';
        if(!c){ cells.push(`<td>–</td>`); tcells.push(`<td class="${tk}">–</td>`); continue; }
        const sp = tokensAt(d, c.t, c.reset);
        // on a narrow screen the token columns fold into the % cell, as its last line
        const tl = sp ? `<small class="tkl">${big(total(sp))} tok</small>` : '';
        if(c.sofar) cells.push(`<td class="so">${pct(valueAt(d.estimate, c.t))} <small>so far</small>${tl}</td>`);
        else {
          const e1 = c.reset ? (d.estimate.find(p => p[0] === e) ?? [0, valueAt(d.estimate, e - 1)])[1] : valueAt(d.estimate, c.t);
          const a = valueAt(d.actual, c.reset ? c.t - 1 : c.t, GAP);
          cells.push(`<td>${pct(e1)}${a != null ? `<small>${pct(a)} actual</small>` : ''}${tl}</td>`);
        }
        // the tokens by then, with their split on hover
        tcells.push(sp ? `<td class="${tk}" title="${kinds(d).map((k, i) => `${k} ${big(sp[i])}`).join(', ')}">${big(total(sp))}</td>` : `<td class="${tk}">–</td>`);
      }
      rows.push(`<tr><td class="k">${esc(day(s, {day: 'numeric', month: 'short'}))} – ${esc(day(e, {day: 'numeric', month: 'short'}))}</td>${cells.join('')}${tcells.join('')}</tr>`);
    }
    return `<div class="tbl wtbl"><table><thead>` +
      `<tr class="grp"><th class="k"></th><th colspan="3">% of limit</th><th colspan="3" class="tk">tokens</th></tr>` +
      `<tr><th class="k">Week</th><th>by Fri</th><th>by Sun</th><th>at reset</th><th class="tk tk1">by Fri</th><th class="tk">by Sun</th><th class="tk">at reset</th></tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table></div>`;
  }

  function noteView(d){
    const s = [];
    if(d.limit){
      const spread = d.spread != null && d.weeks.length > 1 ? `, each within ${Math.round(d.spread * 100)}% of it` : '';
      s.push(`Estimated: the tokens of every Claude Code session on the hosts the board reads, priced by model and token type at API rates, against a weekly limit of ${usd(d.limit)}: the mean of ${d.weeks.length} week${d.weeks.length === 1 ? '' : 's'} the limit was hit${spread}.`);
      if(d.limit_tokens){
        const ts = d.token_spread != null && d.weeks.length > 1 ? `, each within ${Math.round(d.token_spread * 100)}% of it` : '';
        s.push(`In tokens the limit is about ${big(d.limit_tokens)}, the mean the same weeks spent${ts}: an estimate, and a looser one, since a cache read spends a small fraction of what an input token does.`);
      }
      s.push(`This week so far: ${big(d.week_tokens)} tokens, ${usd(d.week_cost)}.`);
    } else s.push('No week in the transcripts hit the limit yet, so there is no estimate to draw.');
    if(d.check) s.push(`At ${esc(when(d.check.at))} the plan said ${pct(d.check.percent)}: 1% cost ${usd(d.check.per_percent)}, against ${d.limit ? usd(d.limit / 100) : '–'} by the estimate. The plan also counts what the transcripts do not hold, such as claude.ai.`);
    if(d.actual_error) s.push(`The plan's own figure could not be read: ${esc(d.actual_error)}.`);
    return s.join(' ');
  }

  function render(d){
    last = d;
    el.querySelector('#wlegend').innerHTML =
      `<span><i class="sw dash"></i>estimated, from transcripts</span><span><i class="sw solid"></i>actual, the plan's own figure</span>` +
      `<span><i class="sw hitk"></i>limit hit</span>` +
      (d.limit_tokens ? `<span class="lim-t"><i class="sw limk"></i>100% ≈ ${big(d.limit_tokens)} tokens, est.</span>` : '');
    draw();
    el.querySelector('#wtable').innerHTML = tableView(d);
    el.querySelector('#wnote').innerHTML = noteView(d);
  }
  window.renderWeekly = render;

  let width = 0;
  addEventListener('resize', () => { if(chart.clientWidth !== width){ width = chart.clientWidth; draw(); } });
  async function tick(){
    try { render(await getJSON('/api/weekly')); } catch { /* analytics.js says when the board is not answering */ }
  }
  tick(); setInterval(tick, 60000);
})();
