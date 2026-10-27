// The board: team, stacks, work and heartbeats, from /api. Every name on it comes from the data.
let human = '', avatars = {};

// A team's accent is its portraits' backdrop: the top rows of the first member's avatar, averaged once
// per image. Until it is sampled, and for a team with no avatars, the heading keeps the plain rule.
const tints = {};
function tint(url){
  if(!url) return '';
  if(url in tints) return tints[url];
  tints[url] = '';
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 2).data;
      const avg = k => Math.round(d.filter((_, i) => i % 4 === k).reduce((a, b) => a + b, 0) / (d.length / 4));
      tints[url] = `rgb(${avg(0)},${avg(1)},${avg(2)})`;
      document.querySelectorAll('[data-tint]').forEach(e => { if(e.dataset.tint === url) e.style.setProperty('--tint', tints[url]); });
    } catch {}
  };
  img.src = url;
  return '';
}

// A person in the chart: portrait with the running dot on its corner, name, and what they are on.
function member(p, cls = ''){
  // A builder whose only items are in review is free for new work, session or not.
  const status = p.ticket
    ? `<span class="tk">${esc(p.ticket)}</span><span class="st">${esc(p.state)}${p.since_min != null ? ' &middot; ' + mins(p.since_min) : ''}</span>`
    : p.in_review && p.in_review.length
    ? `<span class="st">free &middot; ${p.in_review.map(esc).join(', ')} in review</span>`
    : `<span class="st">${p.alive ? esc(p.status || 'idle') : 'not running'}</span>`;
  return `<div class="mem ${cls}"><span class="face">${face(avatars[p.name], '', p.name)}<span class="dot ${p.alive ? 'on' : ''}"></span></span>
      <div class="nm">${esc(p.name)}</div><div class="status">${status}</div></div>`;
}

function roster(g){
  const url = g.members.map(m => avatars[m.name]).find(Boolean);
  const t = tint(url);
  return `<div class="roster"${url ? ` data-tint="${esc(url)}"` : ''}${t ? ` style="--tint:${t}"` : ''}>
      <h3><span class="tt">${esc(g.title)}</span>${g.scope ? `<span class="scope">${esc(g.scope)}</span>` : ''}<span class="n">${g.members.length}</span></h3>
      <div class="people">${g.members.map(p => member(p)).join('')}</div></div>`;
}

// An org chart of rosters rather than a box per person: the lead on top, the assistants to the side on
// a dashed line, the teams below on a bar that joins them.
function team(groups){
  const lead = groups.filter(g => g.key === 'lead').flatMap(g => g.members);
  const staff = groups.filter(g => g.key === 'assistants');
  const rest = groups.filter(g => g.key !== 'lead' && g.key !== 'assistants');
  const members = groups.flatMap(g => g.members);
  return `<section class="team"><div class="shead"><h2>Team</h2><span class="sum">${members.filter(p => p.alive).length} of ${members.length} running</span></div>
    <div class="top">${lead.length ? `<div class="head">${lead.map(p => member(p, 'big')).join('')}</div>` : ''}
      ${staff.length ? `<div class="staff">${staff.map(roster).join('')}</div>` : ''}</div>
    <div class="rosters" style="--n:${rest.length || 1}">${rest.map(roster).join('')}</div></section>`;
}

const stackName = st => st.mine ? `${esc(human)}&rsquo;s ${esc(st.label)}` : `${esc(st.label)} ${st.slot}`;

function owner(st){
  if(st.mine) return `<div class="own"><b>${esc(human)}</b> &middot; reserved</div>`;
  const held = st.sites.map(s => s.owner).filter(o => o && !o.idle);
  if(!held.length){
    const free = st.sites.every(s => s.owner && s.owner.free);
    return `<div class="own idle">${free ? 'free slot' : 'idle'}</div>`;
  }
  const seen = new Set();
  return `<div class="own">${held.filter(o => !seen.has(o.ticket) && seen.add(o.ticket)).map(o =>
    `${o.who ? `${face(avatars[String(o.who).toLowerCase()], 'c')}<b>${esc(o.who)}</b> ` : ''}<span class="tk">${esc(o.ticket)}</span>` +
    (o.released ? ' &middot; in review, free for the next item' : '')).join(', ')}</div>`;
}

function stackCard(st){
  // A non-web slot (events: a Firebase emulator + Android AVD, no URL) has no up/down: its state is
  // free/reserved/in-use from the worktree, and each site is a status note rather than a link.
  if(st.web === false){
    const notes = st.sites.map(s => `<div class="site note">${esc(s.link)}</div>`).join('');
    return `<div class="stack noweb ${st.mine ? 'mine' : ''}">
      <div class="top"><span class="nm">${stackName(st)}</span></div>
      ${owner(st)}<div class="sites">${notes}</div></div>`;
  }
  const down = st.up < st.of;
  const pill = !down ? 'up' : st.of > 1 && st.up ? `${st.of - st.up} of ${st.of} down` : 'down';
  const sites = st.sites.map(s => `<a class="site" href="${esc(s.link)}" target="_blank" rel="noopener">
      <span class="dot ${s.up ? 'on' : 'down'}"></span>${esc(s.name)}
      ${s.up ? '' : `<span class="code">${s.code ? esc(s.code) : 'no answer'}</span>`}<span class="arr">&#8599;</span></a>`).join('');
  return `<div class="stack ${down ? 'down' : ''} ${st.mine ? 'mine' : ''}">
      <div class="top"><span class="nm">${stackName(st)}</span><span class="pill ${down ? 'down' : ''}">${pill}</span></div>
      <div class="host">${esc(st.host)}</div>
      ${owner(st)}<div class="sites">${sites}</div></div>`;
}

let stacksOpen = false;

// Nothing at all when the workspace exports no stacks: a panel saying so is noise on every visit.
function stacksPanel(s){
  if(!s.present) return '';
  const head = (sum, bad, more) => `<div class="shead"><h2>Stacks</h2><span class="sum ${bad ? 'bad' : ''}">${sum}</span></div>
    <button class="stacksum" aria-expanded="${stacksOpen}"><h2>Stacks</h2>
      <span class="sum ${bad ? 'bad' : ''}">${sum}</span><span class="more">${more}</span></button>`;
  if(s.checked_s == null)
    return `<aside class="side">${head('checking', false, '')}</aside>`;
  // The up/of summary counts web stacks only; non-web slots (events) have no HTTP health to sum.
  const webStacks = s.stacks.filter(x => x.web !== false);
  const up = webStacks.filter(x => x.up === x.of).length, all = webStacks.length;
  const ago = s.checked_s < 60 ? s.checked_s + 's ago' : mins(Math.floor(s.checked_s / 60)) + ' ago';
  const downs = s.stacks.filter(x => x.up < x.of).map(stackName);
  const sum = `${up} of ${all} up${downs.length ? ' &middot; ' + downs.join(', ') + ' down' : ''} &middot; checked ${ago}`;
  const kinds = [...new Set(s.stacks.map(x => x.stack))].map(k => s.stacks.filter(x => x.stack === k))
    .map(l => `<div class="kind ${l.some(x => x.up < x.of) ? 'hasdown' : ''}">${l.map(stackCard).join('')}</div>`).join('');
  return `<aside class="side ${stacksOpen ? 'open' : ''} ${downs.length ? 'anydown' : ''}">
    ${head(sum, downs.length, stacksOpen ? 'hide' : downs.length ? 'show all' : 'show')}
    <div class="kinds">${kinds}</div></aside>`;
}

// Where a PR in review stands with its human reviewers: none yet, reviewed, changes asked for, or
// approved and ready to merge. The parts after the first only appear when there is something to say.
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
function review(r){
  if(!r) return '';
  const tip = r.reviewers.map(x => `${x.login}: ${x.state.toLowerCase().replace('_', ' ')}`).join(', ');
  const when = `checked ${r.checked_s < 60 ? 'just now' : mins(Math.floor(r.checked_s / 60)) + ' ago'}${r.stale ? ', and the last read failed' : ''}`;
  const head = {
    none: ['none', 'No reviews yet'],
    commented: ['seen', `${plural(r.reviewers.length, 'review')} &middot; commented`],
    changes: ['changes', 'Changes requested'],
    approved: ['ok', r.ready ? 'Approved &middot; ready to merge' : 'Approved'],
    merged: ['done', 'merged'],
    closed: ['done', 'closed'],
  }[r.state] || ['none', esc(r.state)];
  const open = r.state !== 'merged' && r.state !== 'closed';
  // each its own small pill, so a narrow card wraps between them rather than inside one
  const more = open ? [
    r.draft ? '<span class="rv x">draft</span>' : '',
    r.threads ? `<span class="rv x">${plural(r.threads, 'open thread')}</span>` : '',
    r.conflicts ? '<span class="rv x bad">conflicts</span>' : '',
    r.stale ? '<span class="rv x">stale</span>' : '',
  ].join('') : '';
  return `<span class="rvs" title="${esc((tip ? tip + ' \u00b7 ' : '') + when)}"><span class="rv ${head[0]}${r.ready ? ' ready' : ''}">${head[1]}</span>${more}</span>`;
}

function work(d){
  const cols = d.columns.map(col => {
    const mine = d.waiting_on_you.includes(col);
    const here = d.tickets.filter(t => t.state === col);
    const cards = here.map(t => `
      <div class="card">
        <div class="k">${esc(t.ticket)}${t.local ? '<span class="tag">local</span>' : ''}</div>
        ${t.title ? `<div class="t">${esc(t.title)}</div>` : ''}
        <div class="m">${t.agent ? `${face(avatars[t.agent], 'c', t.agent)}<span class="who">${esc(t.agent)}</span>` : '<span class="who none">unassigned</span>'}
          ${t.age_min != null ? `<span class="age">${mins(t.age_min)} here</span>` : ''}</div>
        ${t.prs.length ? `<div class="pr">${t.prs.map(p => `<div class="prl"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.repo)}#${esc(p.number)}</a>${review(p.review)}</div>`).join('')}</div>` : ''}
        ${t.question ? `<div class="q">${esc(t.question)}</div>` : ''}
        ${t.line && t.line !== t.question ? `<div class="line">${esc(t.line)}</div>` : ''}
      </div>`).join('');
    return `<div class="col ${mine ? 'you' : ''} ${here.length ? '' : 'none'}">
      <div class="colhead"><h3>${esc((d.labels || {})[col] || col)}</h3><span class="count">${here.length}</span></div>
      <p class="why">${esc(d.descriptions[col] || '')}</p>
      ${cards || '<div class="empty">empty</div>'}</div>`;
  }).join('');
  return `<section><div class="shead"><h2>Work</h2><span class="sum">${d.tickets.length} open</span></div>
    <div class="board">${cols}</div></section>`;
}

function render(d){
  human = d.human; avatars = d.avatars || {};
  const plumbing = d.plumbing.map(h => {
    const stale = h.age_s == null || h.age_s > 7800;
    const when = h.age_s == null ? 'never' : Math.floor(h.age_s / 60) + 'm ago';
    return `<span class="${stale ? 'stale' : ''}">${esc(h.name.replace(/\.heartbeat$/, ''))} ${when}</span>`;
  }).join('');
  // The sidebar scrolls on its own, and replacing it every tick would throw its position away.
  const kept = document.querySelector('.side')?.scrollTop || 0;
  const side = stacksPanel(d.stacks);
  document.getElementById('root').innerHTML =
    `<div class="layout ${side ? 'stacked' : ''}">${side}<main>${team(d.teams)}${work(d)}</main></div><footer>${plumbing}</footer>`;
  const aside = document.querySelector('.side');
  if(aside) aside.scrollTop = kept;
}

document.getElementById('root').addEventListener('click', e => {
  const b = e.target.closest('.stacksum');
  if(!b) return;
  stacksOpen = !stacksOpen;
  const side = b.closest('.side');
  side.classList.toggle('open', stacksOpen);
  b.setAttribute('aria-expanded', stacksOpen);
  b.querySelector('.more').textContent = stacksOpen ? 'hide' : side.classList.contains('anydown') ? 'show all' : 'show';
});
// The sidebar sticks under the header, whose height depends on the font and the width.
const head = () => document.documentElement.style.setProperty('--head', document.querySelector('header').offsetHeight + 'px');
head(); addEventListener('resize', head);

poll('/api', render);
