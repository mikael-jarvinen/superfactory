// The board: team, stacks, work and heartbeats, from /api. Every name on it comes from the data.
let human = '';

function person(p){
  const job = p.ticket
    ? `<b>${esc(p.ticket)}</b> <span class="st">${esc(p.state)}${p.since_min != null ? ' &middot; ' + mins(p.since_min) : ''}</span>`
    : (p.alive ? esc(p.status || 'idle') : 'not running');
  return `<div class="person">
      <div class="who"><span class="dot ${p.alive ? 'on' : ''}"></span><span class="nm">${esc(p.name)}</span></div>
      <div class="job">${job}</div></div>`;
}

function team(groups){
  const lead = groups.filter(g => g.key === 'lead');
  const rest = groups.filter(g => g.key !== 'lead');
  const leads = lead.flatMap(g => g.members).map(person).join('');
  const cols = rest.map(g => `<div class="group">
      <h3>${esc(g.title)}<span class="scope">${esc(g.scope)}</span><span class="n">${g.members.length}</span></h3>
      ${g.members.map(person).join('')}</div>`).join('');
  const members = groups.flatMap(g => g.members);
  return `<section><div class="shead"><h2>Team</h2><span class="sum">${members.filter(p => p.alive).length} of ${members.length} running</span></div>
    ${leads ? `<div class="lead">${leads}</div>` : ''}
    <div class="groups" style="--n:${rest.length || 1}">${cols}</div></section>`;
}

const stackName = st => st.mine ? `${esc(human)}&rsquo;s ${esc(st.stack)}` : `${esc(cap(st.stack))} ${st.slot}`;

function owner(st){
  if(st.mine) return `<div class="own"><b>${esc(human)}</b> &middot; reserved</div>`;
  const held = st.sites.map(s => s.owner).filter(o => o && !o.idle);
  if(!held.length){
    const free = st.sites.every(s => s.owner && s.owner.free);
    return `<div class="own idle">${free ? 'free slot' : 'idle'}</div>`;
  }
  const seen = new Set();
  return `<div class="own">${held.filter(o => !seen.has(o.ticket) && seen.add(o.ticket)).map(o =>
    `${o.who ? `<b>${esc(o.who)}</b> ` : ''}<span class="tk">${esc(o.ticket)}</span>`).join(', ')}</div>`;
}

function stackCard(st){
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
  const up = s.stacks.filter(x => x.up === x.of).length, all = s.stacks.length;
  const ago = s.checked_s < 60 ? s.checked_s + 's ago' : mins(Math.floor(s.checked_s / 60)) + ' ago';
  const downs = s.stacks.filter(x => x.up < x.of).map(stackName);
  const sum = `${up} of ${all} up${downs.length ? ' &middot; ' + downs.join(', ') + ' down' : ''} &middot; checked ${ago}`;
  const kinds = [...new Set(s.stacks.map(x => x.stack))].map(k => s.stacks.filter(x => x.stack === k))
    .map(l => `<div class="kind ${l.some(x => x.up < x.of) ? 'hasdown' : ''}">${l.map(stackCard).join('')}</div>`).join('');
  return `<aside class="side ${stacksOpen ? 'open' : ''} ${downs.length ? 'anydown' : ''}">
    ${head(sum, downs.length, stacksOpen ? 'hide' : downs.length ? 'show all' : 'show')}
    <div class="kinds">${kinds}</div></aside>`;
}

function work(d){
  const cols = d.columns.map(col => {
    const mine = d.waiting_on_you.includes(col);
    const here = d.tickets.filter(t => t.state === col);
    const cards = here.map(t => `
      <div class="card">
        <div class="k">${esc(t.ticket)}${t.local ? '<span class="tag">local</span>' : ''}</div>
        ${t.title ? `<div class="t">${esc(t.title)}</div>` : ''}
        <div class="m"><span class="who">${esc(t.agent || 'unassigned')}</span>${t.age_min != null ? ' &middot; ' + mins(t.age_min) + ' here' : ''}</div>
        ${t.prs.length ? `<div class="pr">${t.prs.map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.repo)}#${esc(p.number)}</a>`).join('')}</div>` : ''}
        ${t.question ? `<div class="q">${esc(t.question)}</div>` : ''}
        ${t.line && t.line !== t.question ? `<div class="line">${esc(t.line)}</div>` : ''}
      </div>`).join('');
    return `<div class="col ${mine ? 'you' : ''} ${here.length ? '' : 'none'}">
      <div class="colhead"><h3>${esc(col)}</h3><span class="count">${here.length}</span></div>
      <p class="why">${esc(d.descriptions[col] || '')}</p>
      ${cards || '<div class="empty">empty</div>'}</div>`;
  }).join('');
  return `<section><div class="shead"><h2>Work</h2><span class="sum">${d.tickets.length} open</span></div>
    <div class="board">${cols}</div></section>`;
}

function render(d){
  human = d.human;
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
