// The local tracker's tickets: a list to filter, one ticket to read and change, and a form for a new one.
// Everything written here is written as the human. Views live in the query string: ?key=RPE-12, ?new=1.
let meta = null; // projects, states, relations, the human's name
const OPEN = s => s !== 'Done' && s !== 'Cancelled';
const stateCls = s => 'st-' + s.toLowerCase().replace(/\s+/g, '-');
const badge = s => `<span class="state ${stateCls(s)}">${esc(s)}</span>`;
const labelsOf = p => meta.projects.find(x => x.key === p)?.labels || null;
let listCache = null;

async function route(){
  const p = q();
  try {
    if(p.get('key')) return await ticketView(p.get('key'));
    if(p.get('new')) return await newView(p.get('project'));
    return await listView(p);
  } catch(e){
    document.getElementById('root').innerHTML = `<div class="err">${esc(e.message)}</div><p>${goLink({}, '&larr; all tickets')}</p>`;
  }
}

async function listView(p){
  const d = await api('/api/tickets' + (p.get('project') ? '?project=' + encodeURIComponent(p.get('project')) : ''));
  meta = d; listCache = d.tickets;
  const state = p.get('state') || 'open', text = (p.get('q') || '').toLowerCase(), label = p.get('label') || '';
  const counts = {open: 0}; for(const t of d.tickets){ counts[t.state] = (counts[t.state] || 0) + 1; if(OPEN(t.state)) counts.open++; }
  let rows = d.tickets.filter(t => state === 'all' ? true : state === 'open' ? OPEN(t.state) : t.state === state);
  if(label) rows = rows.filter(t => t.labels.includes(label));
  if(text) rows = rows.filter(t => (t.key + ' ' + t.title).toLowerCase().includes(text));
  rows.sort((a, b) => b.updated.localeCompare(a.updated));
  const keep = {project: p.get('project') || '', q: p.get('q') || '', label};
  const chip = (s, name) => goLink({...keep, state: s}, `${esc(name)} <b>${counts[s] ?? (s === 'all' ? d.tickets.length : 0)}</b>`, 'chip' + (s === state ? ' on' : ''));
  const projects = d.projects.length > 1
    ? `<select id="proj"><option value="">all projects</option>${d.projects.map(x => `<option value="${esc(x.key)}" ${x.key === p.get('project') ? 'selected' : ''}>${esc(x.key)} &middot; ${esc(x.name)}</option>`).join('')}</select>` : '';
  document.getElementById('root').innerHTML = `
    <div class="bar"><h1>tickets</h1>${projects}${goLink({new: 1, project: p.get('project') || ''}, '+ new', 'btn')}</div>
    <div class="chips">${chip('open', 'open')}${d.states.map(s => chip(s, s)).join('')}${chip('all', 'all')}</div>
    <input id="search" type="search" placeholder="search key or title" value="${esc(p.get('q') || '')}">
    ${label ? `<p class="filter">label <span class="lbl">${esc(label)}</span> ${goLink({...keep, state, label: ''}, '&times; clear')}</p>` : ''}
    <div class="err" id="err"></div>
    <div class="rows">${rows.map(t => `
      <a class="row" href="?key=${esc(t.key)}" data-go="key=${esc(t.key)}">
        <span class="k">${esc(t.key)}</span>${badge(t.state)}
        <span class="ti">${esc(t.title)}</span>
        <span class="meta">${t.labels.map(l => `<span class="lbl">${esc(l)}</span>`).join('')}${t.comments ? `<span class="cm">${t.comments} comment${t.comments === 1 ? "" : "s"}</span>` : ''}<span class="ago">${ago(t.updated)}</span></span>
      </a>`).join('') || '<p class="none">no tickets here</p>'}</div>`;
  const s = document.getElementById('search');
  let timer;
  s.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => go({...keep, state, q: s.value}, true), 250); });
  if(p.get('q')) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  document.getElementById('proj')?.addEventListener('change', e => go({state, project: e.target.value}));
}

function labelPicker(project, have){
  const fixed = labelsOf(project);
  if(fixed) return `<div class="labels">${fixed.map(l => `<label class="lbl-pick"><input type="checkbox" value="${esc(l)}" ${have.includes(l) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
  return `<input id="labels" placeholder="labels, comma separated" value="${esc(have.join(', '))}">`;
}
const pickedLabels = root => {
  const free = root.querySelector('#labels');
  if(free) return free.value.split(',').map(s => s.trim()).filter(Boolean);
  return [...root.querySelectorAll('.lbl-pick input:checked')].map(i => i.value);
};

async function newView(project){
  if(!meta) meta = await api('/api/tickets');
  project = project || meta.projects[0]?.key;
  document.getElementById('root').innerHTML = `
    <p>${goLink({}, '&larr; tickets')}</p>
    <h1>new ticket</h1>
    <form class="stack" id="f">
      ${meta.projects.length > 1 ? `<select id="project">${meta.projects.map(x => `<option ${x.key === project ? 'selected' : ''}>${esc(x.key)}</option>`).join('')}</select>` : ''}
      <input id="title" placeholder="title" required maxlength="300">
      <textarea id="body" rows="10" placeholder="description (markdown)"></textarea>
      <div id="lbls">${labelPicker(project, [])}</div>
      <select id="state">${meta.states.map(s => `<option ${s === 'Backlog' ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <div class="err" id="err"></div>
      <button>create</button>
    </form>`;
  const f = document.getElementById('f');
  document.getElementById('project')?.addEventListener('change', e => { document.getElementById('lbls').innerHTML = labelPicker(e.target.value, []); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const b = f.querySelector('button'); b.disabled = true;
    try {
      const r = await api('/api/tickets', {project: document.getElementById('project')?.value || project,
        title: document.getElementById('title').value, body: document.getElementById('body').value,
        labels: pickedLabels(f), state: document.getElementById('state').value});
      go({key: r.ticket.key}, true);
    } catch(err){ flash(err.message); b.disabled = false; }
  });
}

let current = null;
async function ticketView(key){
  const t = current = await api('/api/tickets/' + encodeURIComponent(key));
  if(!meta) meta = await api('/api/tickets');
  document.title = `${t.key} · ${t.title}`;
  const rel = t.relations.map(r => `<li><span class="rk">${esc(r.kind.replace(/_/g, ' '))}</span> ${goLink({key: r.to}, esc(r.to))}
      <button class="x" data-unrelate="${esc(r.kind)}|${esc(r.to)}" title="remove">&times;</button></li>`).join('');
  const links = t.links.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title || l.url)}</a></li>`).join('');
  const comments = t.comments.map(c => `<div class="msg ${c.by === meta.human ? 'human' : ''}"><div class="who"><span class="name">${esc(c.by)}</span><span class="when">${esc(when(c.t))}</span></div><div class="body">${md(c.body)}</div></div>`).join('');
  document.getElementById('root').innerHTML = `
    <p>${goLink({}, '&larr; tickets')}</p>
    <div class="tkhead"><span class="k">${esc(t.key)}</span>
      <select id="state" class="${stateCls(t.state)}">${meta.states.map(s => `<option ${s === t.state ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
    <h1 class="title" id="title" title="tap to rename">${esc(t.title)}</h1>
    <div class="err" id="err"></div>
    <div id="lbls">${labelPicker(t.project, t.labels)}</div>
    <section><div class="sh"><h2>description</h2><button class="lnk" id="editbody">edit</button></div>
      <div class="body md" id="body">${t.body.trim() ? md(t.body) : '<p class="none">no description</p>'}</div></section>
    <section><h2>relations</h2><ul class="rel">${rel || '<li class="none">none</li>'}</ul>
      <form class="inline" id="relf"><select id="rkind">${meta.relations.map(k => `<option value="${k}">${k.replace(/_/g, ' ')}</option>`).join('')}</select><input id="rto" placeholder="RPE-12" size="9"><button>add</button></form></section>
    <section><h2>links</h2><ul class="rel">${links || '<li class="none">none</li>'}</ul>
      <form class="inline" id="linkf"><input id="lurl" type="url" placeholder="https://"><input id="ltitle" placeholder="title (optional)"><button>add</button></form></section>
    <section><h2>comments <span class="n">${t.comments.length}</span></h2>${comments}
      <form class="stack" id="cf"><textarea id="ctext" rows="3" placeholder="comment (markdown)"></textarea><button>comment</button></form></section>
    <p class="foot">created ${esc(when(t.created))} by ${esc(t.by)} &middot; updated ${esc(when(t.updated))}${t.source?.system ? ` &middot; from ${esc(t.source.system)}` : ''}</p>`;
  const post = async body => {
    try { current = (await api('/api/tickets/' + encodeURIComponent(t.key), body)).ticket; await ticketView(t.key); }
    catch(e){ flash(e.message); }
  };
  document.getElementById('state').addEventListener('change', e => post({op: 'move', to: e.target.value}));
  document.querySelectorAll('.lbl-pick input').forEach(i => i.addEventListener('change', () => post({op: 'label', name: i.value, add: i.checked})));
  document.getElementById('labels')?.addEventListener('change', async e => {
    const want = pickedLabels(document.getElementById('lbls'));
    for(const l of want.filter(x => !t.labels.includes(x))) await api('/api/tickets/' + t.key, {op: 'label', name: l, add: true}).catch(err => flash(err.message));
    for(const l of t.labels.filter(x => !want.includes(x))) await api('/api/tickets/' + t.key, {op: 'label', name: l, add: false}).catch(err => flash(err.message));
    ticketView(t.key);
  });
  document.getElementById('title').addEventListener('click', () => {
    const v = prompt('title', t.title);
    if(v != null && v.trim() && v.trim() !== t.title) post({op: 'title', title: v});
  });
  document.getElementById('editbody').addEventListener('click', () => {
    const box = document.getElementById('body');
    box.innerHTML = `<form class="stack" id="bf"><textarea id="btext" rows="16"></textarea><div class="inline"><button>save</button><button type="button" class="lnk" id="bcancel">cancel</button></div></form>`;
    const ta = document.getElementById('btext'); ta.value = t.body; ta.focus();
    document.getElementById('bcancel').addEventListener('click', () => ticketView(t.key));
    document.getElementById('bf').addEventListener('submit', e => { e.preventDefault(); post({op: 'body', body: ta.value}); });
  });
  document.getElementById('relf').addEventListener('submit', e => { e.preventDefault(); post({op: 'relate', kind: document.getElementById('rkind').value, to: document.getElementById('rto').value.trim()}); });
  document.querySelectorAll('[data-unrelate]').forEach(b => b.addEventListener('click', () => {
    const [kind, to] = b.dataset.unrelate.split('|');
    if(confirm(`remove ${kind.replace(/_/g, ' ')} ${to}?`)) post({op: 'relate', kind, to, remove: true});
  }));
  document.getElementById('linkf').addEventListener('submit', e => { e.preventDefault(); post({op: 'link', url: document.getElementById('lurl').value.trim(), title: document.getElementById('ltitle').value}); });
  document.getElementById('cf').addEventListener('submit', e => {
    e.preventDefault();
    const v = document.getElementById('ctext').value;
    if(v.trim()) post({op: 'comment', body: v});
  });
}

route();
