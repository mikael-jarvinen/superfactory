// The local tracker's wiki: every page by project, one page rendered, and an editor that saves only
// over the text it opened. Views: ?page=RPE/product-vision, &edit=1; ?new=1&project=RPE.
const slug = t => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'page';
const DRAFT = ref => 'sf-wiki-draft:' + ref;
const draft = {
  get(ref){ try { return JSON.parse(localStorage.getItem(DRAFT(ref))); } catch { return null; } },
  set(ref, v){ try { localStorage.setItem(DRAFT(ref), JSON.stringify(v)); } catch {} },
  drop(ref){ try { localStorage.removeItem(DRAFT(ref)); } catch {} },
};

async function route(){
  const p = q();
  try {
    if(p.get('new')) return await editView(null, p.get('project'), p.get('parent'));
    if(p.get('page') && p.get('edit')) return await editView(p.get('page'));
    if(p.get('page')) return await pageView(p.get('page'));
    return await listView();
  } catch(e){
    document.getElementById('root').innerHTML = `<div class="err">${esc(e.message)}</div><p>${goLink({}, '&larr; all pages')}</p>`;
  }
}

async function listView(){
  const d = await api('/api/wiki');
  document.title = 'wiki · superfactory';
  document.getElementById('root').innerHTML = `<div class="bar"><h1>wiki</h1></div>` + d.projects.map(pr => {
    const pages = d.pages.filter(x => x.project === pr.key);
    return `<section><div class="sh"><h2>${esc(pr.key)} &middot; ${esc(pr.name)}</h2>${goLink({new: 1, project: pr.key}, '+ new page', 'btn')}</div>
      <div class="rows">${pages.map(x => {
        const depth = x.path.split('/').length - 1;
        return `<a class="row page" style="--depth:${depth}" href="?page=${esc(pr.key + '/' + x.path)}" data-go="page=${esc(pr.key + '/' + x.path)}">
          <span class="ti">${esc(x.title)}</span><span class="meta"><span class="ago">${ago(x.updated)}</span></span></a>`;
      }).join('') || '<p class="none">no pages yet</p>'}</div></section>`;
  }).join('');
}

async function pageView(ref){
  const pg = await api('/api/wiki/' + ref.split('/').map(encodeURIComponent).join('/'));
  document.title = pg.title + ' · wiki';
  const hist = pg.history.slice().reverse().map(h => `<li>${esc(when(h.t))} &middot; ${esc(h.by)} <span class="sha">${esc(h.sha)}</span></li>`).join('');
  document.getElementById('root').innerHTML = `
    <p>${goLink({}, '&larr; wiki')}</p>
    <div class="sh"><h1>${esc(pg.title)}</h1><span>${goLink({page: ref, edit: 1}, 'edit', 'btn')}</span></div>
    <p class="foot">${esc(pg.project)}/${esc(pg.path)} &middot; updated ${esc(when(pg.updated))} &middot; ${goLink({new: 1, project: pg.project, parent: pg.path}, '+ child page')}</p>
    <div class="body md page-body">${md(pg.body)}</div>
    ${hist ? `<details class="hist"><summary>history (${pg.history.length})</summary><ul>${hist}</ul></details>` : ''}`;
}

async function editView(ref, project, parent){
  let pg = null;
  if(ref) pg = await api('/api/wiki/' + ref.split('/').map(encodeURIComponent).join('/'));
  const key = ref || `new:${project}/${parent || ''}`;
  const saved = draft.get(key);
  const useDraft = saved && (!pg || saved.base === pg.sha);
  document.getElementById('root').innerHTML = `
    <p>${ref ? goLink({page: ref}, '&larr; ' + esc(pg.title)) : goLink({}, '&larr; wiki')}</p>
    <form class="stack edit" id="f">
      <input id="title" placeholder="title" required maxlength="300">
      ${ref ? '' : `<p class="foot">saved as <span id="path"></span></p>`}
      <textarea id="body" rows="24" placeholder="markdown"></textarea>
      <div class="err" id="err"></div>
      <div id="theirs"></div>
      <div class="inline"><button id="save">save</button><button type="button" class="lnk" id="preview">preview</button>${ref ? goLink({page: ref}, 'cancel', 'lnk') : ''}</div>
      <div class="body md" id="pv" hidden></div>
    </form>`;
  const title = document.getElementById('title'), body = document.getElementById('body');
  title.value = useDraft ? saved.title : pg ? pg.title : '';
  body.value = useDraft ? saved.body : pg ? pg.body : '';
  if(useDraft) flash('restored your unsaved draft');
  let base = pg ? pg.sha : null;
  const pathOf = () => (parent ? parent + '/' : '') + slug(title.value);
  const showPath = () => { const s = document.getElementById('path'); if(s) s.textContent = `${project}/${pathOf()}`; };
  showPath();
  const keep = () => draft.set(key, {base, title: title.value, body: body.value});
  title.addEventListener('input', () => { showPath(); keep(); });
  body.addEventListener('input', keep);
  document.getElementById('preview').addEventListener('click', () => {
    const pv = document.getElementById('pv'); pv.hidden = !pv.hidden; if(!pv.hidden) pv.innerHTML = md(body.value);
  });
  document.getElementById('f').addEventListener('submit', async e => {
    e.preventDefault();
    const target = ref || `${project}/${pathOf()}`;
    const b = document.getElementById('save'); b.disabled = true;
    try {
      await api('/api/wiki/' + target.split('/').map(encodeURIComponent).join('/'), {title: title.value, body: body.value, base});
      draft.drop(key);
      go({page: target}, true);
    } catch(err){
      b.disabled = false;
      if(err.status === 409 && err.data.current){
        const cur = err.data.current;
        flash(ref ? 'someone saved this page since you opened it. Your text is still here; theirs is below. Save again to put yours over theirs.'
          : 'a page with that path already exists; change the title.');
        if(ref){
          base = cur.sha; keep();
          document.getElementById('theirs').innerHTML = `<details open class="hist"><summary>their version</summary><pre class="theirs">${esc(cur.body)}</pre></details>`;
        }
      } else flash(err.message);
    }
  });
}

route();
