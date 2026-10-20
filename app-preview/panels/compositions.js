/* ===========================================================================
   panels/compositions.js — the Compositions panel.
   ---------------------------------------------------------------------------
   Arena's own panel (decoded, components.Composition, "Compositions / Decks"):
     "This list contains all your saved compositions with their included decks.
      Double click a composition or a deck to load. You can load a deck from any
      composition into your current composition."
   The REST API carries none of that list: there is no endpoint that enumerates
   saved compositions, no recent-files list, nothing that reports which file the
   running composition came from, and no way to import a deck out of another
   composition file. What it does carry, verified in swagger.yaml 7.27.1 and
   with OPTIONS against the running Arena:
     POST /composition/open   text/plain  file:/// URL   (discards unsaved work)
     POST /composition/save   text/plain  file:/// URL, or empty for the current file
     POST /composition/new                               (discards unsaved work)
   All three throw away or overwrite work, so none of them fires on a single
   click: every one asks first, and only the confirm control calls Arena.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;
const esc = Kit.esc;

const R = () => (window.RESOLUME || {}).arena || {};

/* ---- state, module-scope so a repaint never eats a half-typed path ------ */
const KEY = 'openlive.compositions';
const S = { path: '', ask: null, msg: '', bad: false, busy: false, root: null, sig: null };

function remembered() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]').filter(x => typeof x === 'string'); }
  catch { return []; }
}
function remember(p) {
  if (!p) return;
  const list = [p, ...remembered().filter(x => x !== p)].slice(0, 12);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
function forget(p) {
  try { localStorage.setItem(KEY, JSON.stringify(remembered().filter(x => x !== p))); } catch {}
}

/* ---- paths, exactly as the swagger spells them out ---------------------- */
function fileUrl(p) {
  let s = String(p || '').trim();
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/{2,3}/i, '');
    try { s = decodeURIComponent(s); } catch { /* leave it as typed */ }
  }
  s = s.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return '';
  return 'file:///' + s.split('/')
    .map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
}
const baseName = p => String(p || '').split(/[\\/]/).pop();

const WHY = {
  400: 'Arena calls that path invalid',
  404: 'nothing there',
  412: 'a precondition failed, e.g. the Show (Resolume Composition) is locked'
};
function why(e) {
  const m = /^(\d{3})/.exec(String((e && e.message) || e));
  return m ? `${m[1]}: ${WHY[+m[1]] || 'Arena refused the request'}`
           : String((e && e.message) || e);
}

/* ---- the composition Arena ships ----------------------------------------
   The decoded install tree holds exactly one .avc — RESOLUME.arena.tree
   .extensions.avc is 1 — and extracted/arena-tree.json names it
   default\Example.avc. Nothing in the REST API reports where Arena is
   installed, so the root is a setting; the Files panel shares it. */
const ROOT_KEY = 'openlive.arenaRoot';
const ROOT_DEFAULT = 'C:\\Program Files\\Resolume Arena';
const SHIPPED_AVC = 'default\\Example.avc';
function root() {
  if (S.root == null) {
    try { S.root = localStorage.getItem(ROOT_KEY) || ROOT_DEFAULT; }
    catch { S.root = ROOT_DEFAULT; }
  }
  return S.root;
}
function shipped() {
  const r = root().replace(/[\\/]+$/, '');
  const n = ((R().tree || {}).extensions || {}).avc;
  return (r && n) ? [{ path: r + '\\' + SHIPPED_AVC }] : [];
}

/* ---- calls -------------------------------------------------------------- */
const post = (path, body) => AL.rest(path, Object.assign(
  { method: 'POST' },
  body == null ? {} : { headers: { 'Content-Type': 'text/plain' }, body }));

/* ---- one-off panel CSS, tokens only ------------------------------------- */
if (!document.getElementById('cm-style')) {
  const st = document.createElement('style');
  st.id = 'cm-style';
  st.textContent = `
.cm-ask{ margin:var(--space-2) var(--space-3); padding:var(--space-3);
  border:1px solid var(--color-accent); border-radius:var(--radius-md);
  background:color-mix(in srgb,var(--color-accent) 8%,transparent);
  display:flex; flex-direction:column; gap:var(--space-2); }
.cm-ask p{ margin:0; color:var(--n300); font-size:11px; }
.cm-ask .row{ display:flex; gap:var(--space-2); }
.cm-ask b{ color:var(--n100); font-weight:500; }
.cm-act{ color:var(--n600); cursor:pointer; padding:0 4px; font-size:10px;
  border-radius:var(--radius-sm); }
.cm-act:hover{ color:var(--n100);
  background:color-mix(in srgb,var(--color-accent) 18%,transparent); }
.cm-bad{ color:var(--red); }
.cm-kv{ display:grid; grid-template-columns:104px 1fr; gap:2px var(--space-2);
  padding:var(--space-1) var(--space-3); font-size:10.5px; color:var(--n300); }
.cm-kv b{ color:var(--n600); font-weight:400; }`;
  document.head.appendChild(st);
}

/* =========================================================================
   render
   ========================================================================= */
/* every destructive call goes through here first — nothing calls Arena until
   the user clicks the one button inside this block */
function askBlock() {
  const a = S.ask;
  if (!a) return '';
  const name = Kit.val((AL.comp || {}).name) || 'this Show';
  const text = {
    open: `Opening <b>${esc(baseName(a.path))}</b> replaces what is loaded now.
           Unsaved changes to <b>${esc(name)}</b> are lost. Arena does not ask again.`,
    save: `Save <b>${esc(name)}</b> to <b>${esc(baseName(a.path))}</b>?
           An existing file at that path is overwritten.`,
    saveCurrent: `Save <b>${esc(name)}</b> over the file it was loaded from.
           The REST API does not report which file that is, so check Arena's
           title bar if you are not sure.`,
    fresh: `Start a blank Show. Unsaved changes to <b>${esc(name)}</b>
            are thrown away.`
  }[a.kind];
  const verb = { open: 'Open it', save: 'Save it', saveCurrent: 'Save', fresh: 'Discard and start blank' }[a.kind];
  return `<div class="cm-ask">
    <p>${text}</p>
    <div class="row">
      <button class="btn" id="cmGo"${S.busy ? ' disabled' : ''}>${esc(verb)}</button>
      <button class="btn" id="cmNo">Cancel</button>
    </div></div>`;
}

function currentSection() {
  const c = AL.comp;
  if (!c) return Kit.nothing('No Show yet.');
  const w = Kit.val(c.video && c.video.width), h = Kit.val(c.video && c.video.height);
  const clips = AL.layers().reduce((n, L) => n + (L.clips || []).length, 0);
  const files = new Set();
  AL.layers().forEach(L => (L.clips || []).forEach(k => ['video', 'audio'].forEach(t => {
    const fi = k && k[t] && k[t].fileinfo;
    if (fi && fi.path) files.add(fi.path);
  })));
  const kv = [
    ['Size', (w != null && h != null) ? `${w} × ${h}` : 'N/A'],
    ['Layers', String(AL.layers().length)],
    ['Cues', String(AL.columns().length)],
    ['Banks', String(AL.decks().length)],
    ['Clip slots', String(clips)],
    ['Files used', String(files.size)],
    ['Saved as', 'not carried by the API']
  ];
  return Kit.param('Name', c.name) +
    `<div class="cm-kv">${kv.map(([k, v]) =>
      `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div>` +
    `<div class="p-toolbar">
      <button class="btn" id="cmSaveCur">Save Show</button>
      <button class="btn" id="cmSaveAs">Save Show As…</button>
      <button class="btn" id="cmNew">New</button>
    </div>
    <div class="p-note">Save As and Open use the path box below.</div>`;
}

/* Arena's own words for this panel, and what is missing from the API */
const HELP = (Kit.components('Composition')
  .find(c => c.id === 'Compositions') || {}).help || '';
const GAP = Kit.unavailable('The saved Shows list',
  'Nothing in the Resolume REST API enumerates your Shows folder or reads a ' +
  'Composition file without opening it, so there is no list to double-click. ' +
  'POST /composition/open and POST /composition/save do exist, and both take a ' +
  'file:/// path, so this panel works by path.');

function openSection() {
  const ship = shipped(), recent = remembered();
  return `<div class="p-toolbar">
      <input type="text" id="cmPath"
        placeholder="Full path to a Resolume .avc Show" value="${esc(S.path)}">
      <button class="btn" id="cmOpen">Open…</button>
    </div>` +
    (S.msg ? `<div class="p-note${S.bad ? ' cm-bad' : ''}">${esc(S.msg)}</div>` : '') +
    (ship.length ? `<div class="p-note">Shipped with Arena: decoded from the
        install tree; edit the root in the Files panel if Arena lives elsewhere
        on this machine</div>
      <div class="p-list">${ship.map(f =>
        `<div class="p-row" data-open="${esc(f.path)}" title="${esc(f.path)}">
          <span>${esc(baseName(f.path))}</span>
          <span class="p-dim">${esc(f.path)}</span></div>`).join('')}</div>` : '') +
    `<div class="p-note">Remembered by this page: the API has no recent-files list</div>` +
    (recent.length
      ? `<div class="p-list">${recent.map(p =>
          `<div class="p-row" data-open="${esc(p)}" title="${esc(p)}">
            <span>${esc(baseName(p))}</span>
            <span class="p-dim">${esc(p.slice(0, Math.max(0, p.length - baseName(p).length - 1)))}</span>
            <span class="cm-act" data-forget="${esc(p)}" title="Forget this path">✕</span>
          </div>`).join('')}</div>`
      : Kit.nothing('Nothing opened or saved from this page yet.')) +
    `<div class="p-note">Click a row to put its path in the box; opening still
      needs the confirm.</div>`;
}

function decksSection() {
  const decks = AL.decks();
  if (!decks.length) return Kit.nothing('No Banks.');
  return `<div class="p-list">${decks.map((d, i) => {
    const sel = Kit.val(d.selected) === true;
    return `<div class="p-row${sel ? ' sel' : ''}" data-deck="${i + 1}">
      <span>${esc(Kit.dispName(Kit.val(d.name), i + 1))}</span>
      <span class="p-dim">${d.closed ? 'closed' : ''}${sel ? ' selected' : ''}</span>
    </div>`;
  }).join('')}</div>
  <div class="p-note">Double-click to switch Bank. Arena's panel also loads a Bank
    out of another Show file; the REST API has no endpoint for that, so
    this list is the Banks of the Show that is already open.</div>`;
}

function gapsSection() {
  const gaps = [
    ['Saved Shows list', 'no endpoint enumerates the Shows folder'],
    ['Banks inside a saved Show', 'nothing reads a Resolume Composition file without opening it'],
    ['Load a Bank from another Show', 'the Resolume deck endpoints add, duplicate, select, close and re-open only'],
    ['Which file this Show came from', 'the Resolume Composition object carries a name, not a path'],
    ['Open Recent', 'no recent-files endpoint'],
    ['Resolume: Collect Media / Copy Composition / Update Composition', 'the Media Manager is not in the REST API']
  ];
  return `<div class="p-list">${gaps.map(([a, b]) =>
    `<div class="p-row"><span>${esc(a)}</span><span class="p-dim">${esc(b)}</span></div>`).join('')}</div>`;
}

/* =========================================================================
   panel
   ========================================================================= */
function sig() {
  if (AL.status !== 'live') return AL.status;
  const c = AL.comp || {};
  return [AL.status, Kit.val(c.name), AL.layers().length, AL.columns().length,
    AL.decks().map(d => Kit.val(d.name) + (Kit.val(d.selected) === true ? '*' : '') +
      (d.closed ? 'x' : '')).join('|')].join('~');
}

WS.register('Compositions', {
  title: 'Shows',
  build(host) {
    const paint = (force) => {
      if (!host.isConnected) return;
      if (AL.status !== 'live') {
        S.sig = 'offline';
        host.innerHTML = Kit.offline('Opening and saving a Show needs a running Arena.');
        return;
      }
      const s = sig() + '~' + (S.ask ? S.ask.kind + S.ask.path : '') + '~' + S.msg + S.busy;
      if (!force && s === S.sig) return;
      S.sig = s;

      host.innerHTML =
        (HELP ? `<div class="p-note"><b>Resolume reference:</b> ${esc(HELP)}</div>` : '') +
        GAP +
        askBlock() +
        Kit.section('Current Show', currentSection()) +
        Kit.section('Open / Save', openSection()) +
        Kit.section('Banks', decksSection(), { tag: String(AL.decks().length) }) +
        Kit.section('Not in the REST API', gapsSection(), { folded: true });

      Kit.bind(host);
      wire(host, paint);
    };
    /* S is module-level, so S.sig survives a previous mount of this panel and
       an unchanged signature would make paint(false) return before touching the
       new host. Force the first paint of each host. Same fix as panels/files.js. */
    let first = true;
    Kit.live(host, () => { paint(first); first = false; }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});

/* =========================================================================
   wiring — every destructive control only ever sets S.ask
   ========================================================================= */
function wire(host, paint) {
  const $ = s => host.querySelector(s);

  const path = $('#cmPath');
  if (path) path.addEventListener('input', () => { S.path = path.value; });

  const need = () => {
    if (S.path.trim()) return true;
    S.msg = 'Type a full path first.'; S.bad = true; paint(true); return false;
  };

  const ask = (kind, p) => { S.ask = { kind, path: p || '' }; S.msg = ''; S.bad = false; paint(true); };

  const bOpen = $('#cmOpen');
  if (bOpen) bOpen.addEventListener('click', () => { if (need()) ask('open', S.path); });
  const bSaveAs = $('#cmSaveAs');
  if (bSaveAs) bSaveAs.addEventListener('click', () => { if (need()) ask('save', S.path); });
  const bSaveCur = $('#cmSaveCur');
  if (bSaveCur) bSaveCur.addEventListener('click', () => ask('saveCurrent'));
  const bNew = $('#cmNew');
  if (bNew) bNew.addEventListener('click', () => ask('fresh'));

  const no = $('#cmNo');
  if (no) no.addEventListener('click', () => { S.ask = null; paint(true); });
  const go = $('#cmGo');
  if (go) go.addEventListener('click', () => run(paint));

  host.querySelectorAll('[data-open]').forEach(r => {
    r.addEventListener('click', () => {
      S.path = r.dataset.open;
      const p = $('#cmPath'); if (p) p.value = S.path;
      S.msg = 'Path loaded. Press Open… to confirm.'; S.bad = false; paint(true);
    });
  });
  host.querySelectorAll('[data-forget]').forEach(b => b.addEventListener('click', ev => {
    ev.stopPropagation(); forget(b.dataset.forget); paint(true);
  }));

  host.querySelectorAll('[data-deck]').forEach(r => r.addEventListener('dblclick', () =>
    AL.rest(`/composition/decks/${r.dataset.deck}/select`, { method: 'POST' })
      .catch(e => { S.msg = `Bank switch refused: ${why(e)}`; S.bad = true; paint(true); })));
}

function run(paint) {
  const a = S.ask;
  if (!a || S.busy) return;
  const url = a.path ? fileUrl(a.path) : null;
  const job =
    a.kind === 'open'        ? post('/composition/open', url) :
    a.kind === 'save'        ? post('/composition/save', url) :
    a.kind === 'saveCurrent' ? post('/composition/save') :
    a.kind === 'fresh'       ? post('/composition/new') : null;
  if (!job) return;

  S.busy = true; S.msg = 'Asking Arena…'; S.bad = false; paint(true);
  job.then(() => {
    if (a.path) remember(a.path);
    S.msg = {
      open: `Opened ${baseName(a.path)}.`,
      save: `Saved to ${baseName(a.path)}.`,
      saveCurrent: 'Saved.',
      fresh: 'Blank Show.'
    }[a.kind];
    S.bad = false; S.ask = null;
  }).catch(e => {
    S.msg = `Arena refused: ${why(e)}`; S.bad = true;
  }).then(() => {
    S.busy = false; paint(true);
    AL.refresh().catch(() => {});      // /open replaces everything; re-read it
  });
}
})();
