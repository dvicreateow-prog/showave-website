/* ===========================================================================
   panels/files.js — the Files panel: Arena's media browser, as far as the
   REST API actually reaches.
   ---------------------------------------------------------------------------
   Arena's own File Browser (decoded, components.Browser):
     "Drag files from this browser to one of the clips in the deck to load it.
      Double click a file to preview it in the preview monitor."
   It walks the filesystem. The REST API does not: the whole `files` tag in
   Arena 7.27.1's swagger is one operation, POST /file-info, and that only
   answers questions about paths you already have. There is no directory
   listing, no drive list, no folder walk, no file thumbnail. So this panel
   cannot browse a disk, and says so rather than pretending.

   What it can do, all of it sourced:
     · POST /composition/layers/{l}/clips/{c}/open   text/plain, a file:/// URL
     · POST /file-info                              json array of file:/// URLs
     · the media Arena ships — RESOLUME.arena.assets.media, 51 real files,
       browsable and openable once the install root is joined on
     · the files the running composition already references — every clip's
       video/audio fileinfo, with the missing ones marked, which is Arena's
       own "File Info" list
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;
const esc = Kit.esc;

const R      = () => (window.RESOLUME || {}).arena || {};
const MEDIA  = () => (R().assets || {}).media || [];
/* arena-data.js declares these as script-scope consts, not window properties */
const ROOTS   = () => (typeof FILE_ROOTS   !== 'undefined') ? FILE_ROOTS   : [];
const FILTERS = () => (typeof MEDIA_FILTERS !== 'undefined') ? MEDIA_FILTERS : [];

/* ---- panel state, kept outside build() so a repaint never eats a half-typed
   path or a search term ---------------------------------------------------- */
const S = {
  path: '', target: null, msg: '', bad: false,
  folder: '', filter: 'All Media', query: '',
  probe: {}, probed: false, probing: false,
  root: null, rootOk: null,
  info: null, drop: null, sig: null
};

/* Nothing in the REST API reports where Arena is installed — no endpoint
   carries the application path — so the install root is a setting here. Its
   default is the root the decode ran against (extracted/arena-tree.json);
   a different machine edits it, and Arena confirms it through /file-info. */
const ROOT_KEY = 'openlive.arenaRoot';
const ROOT_DEFAULT = 'C:\\Program Files\\Resolume Arena';
function root() {
  if (S.root == null) {
    try { S.root = localStorage.getItem(ROOT_KEY) || ROOT_DEFAULT; }
    catch { S.root = ROOT_DEFAULT; }
  }
  return S.root;
}
function setRoot(v) {
  S.root = String(v || '').replace(/[\\/]+$/, '');
  S.rootOk = null; S.probe = {}; S.probed = false;
  try { localStorage.setItem(ROOT_KEY, S.root); } catch { /* private mode */ }
}

/* ---- paths -------------------------------------------------------------- */
/* swagger is explicit: three slashes, forward separators even on Windows,
   every special character percent-encoded, the drive colon left alone.
     $USER_HOME\file 1.mov  ->  file:///$USER_HOME/file%201.mov              */
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
/* the inverse of fileUrl, for showing a dropped file:/// URL as a path */
function nativePath(u) {
  let s = String(u || '').trim();
  if (!/^file:/i.test(s)) return s;
  s = s.replace(/^file:\/{2,3}/i, '');
  try { s = decodeURIComponent(s); } catch { /* leave it encoded */ }
  return /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\') : '/' + s;
}
const K = 1024;
function size(b) {
  if (b == null) return '';
  if (b < K) return b + ' B';
  if (b < K * K) return Math.round(b / K) + ' KB';
  return (b / K / K).toFixed(1) + ' MB';
}

/* the swagger's own words for the codes these calls can return */
const WHY = {
  400: 'the given URL is invalid: check drive, folder and spelling',
  404: 'no clip at that position',
  412: 'a precondition failed, the clip cannot be loaded right now'
};
function why(e) {
  const m = /^(\d{3})/.exec(String((e && e.message) || e));
  return m ? `${m[1]}: ${WHY[+m[1]] || 'Arena refused the request'}`
           : String((e && e.message) || e);
}

/* ---- what Arena ships ---------------------------------------------------
   RESOLUME.arena.assets.media is the decoded inventory: 51 real files with
   their folder, name and byte count. Only the install root has to be joined
   on, and that is the one part the API cannot tell us. */
function shipped() {
  const r = root().replace(/[\\/]+$/, '');
  if (!r) return [];
  return MEDIA().map(m => Object.assign({}, m, {
    path: r + '\\' + m.folder + '\\' + m.file
  }));
}
const folders = list => [...new Set(list.map(m => m.folder))];

/* ---- what the composition already references ---------------------------- */
/* Arena calls this File Info: "List of all the files in this composition.
   Missing files are marked in red." Every clip carries its own fileinfo. */
function compFiles() {
  const out = [], seen = new Map();
  AL.layers().forEach((L, li) => (L.clips || []).forEach((k, ci) => {
    ['video', 'audio'].forEach(track => {
      const fi = k && k[track] && k[track].fileinfo;
      if (!fi || !fi.path) return;
      const key = track + '|' + fi.path;
      let rec = seen.get(key);
      if (!rec) { rec = { track, fi, uses: [] }; seen.set(key, rec); out.push(rec); }
      rec.uses.push({ l: li + 1, c: ci + 1 });
    });
  }));
  return out;
}

/* ---- the clip this panel loads into ------------------------------------- */
function selectedClip() {
  const layers = AL.layers();
  for (let l = 1; l <= layers.length; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++)
      if (clips[c - 1] && AL.val(clips[c - 1].selected) === true) return { l, c };
  }
  return null;
}
/* null target means "follow whatever is selected in Arena", which is how the
   drag-onto-a-clip gesture behaves in the application */
function target() {
  const layers = AL.layers();
  if (!layers.length) return null;
  const t = S.target || selectedClip() || { l: 1, c: 1 };
  const l = Kit.clamp(t.l, 1, layers.length);
  const n = ((AL.layer(l) || {}).clips || []).length;
  return { l, c: n ? Kit.clamp(t.c, 1, n) : 1 };
}

/* ---- calls -------------------------------------------------------------- */
const openInto = (l, c, url) =>
  AL.rest(`/composition/layers/${l}/clips/${c}/open`,
    { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: url });

const fileInfo = urls =>
  AL.rest('/file-info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(urls)
  });

/* ---- previews ----------------------------------------------------------- */
/* the View toggle Arena's listTypeButton drives; default comes from the
   decoded layout params when no layout is loaded (undocked panel) */
function previews() {
  const v = WS.param('ShowFileBrowserThumbnails');
  if (v !== undefined) return !!v;
  const p = (R().layout_params || {}).ShowFileBrowserThumbnails;
  return !!p && p.default === '1';
}

/* ---- one-off panel CSS, tokens only ------------------------------------- */
if (!document.getElementById('fb-style')) {
  const st = document.createElement('style');
  st.id = 'fb-style';
  st.textContent = `
.fb-drop{ margin:var(--space-2) var(--space-3); }
.fb-tools{ flex-wrap:wrap; }
.fb-tools select{ font-size:10.5px; padding:1px var(--space-2); }
.fb-tile{ border:1px solid var(--n800); border-radius:var(--radius-md);
  background:var(--panel2); padding:var(--space-2); display:flex; flex-direction:column;
  gap:2px; cursor:grab; overflow:hidden; }
.fb-tile:hover{ border-color:var(--a600); }
.fb-tile b{ font-weight:500; color:var(--n200); font-size:11px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fb-tile i{ font-style:normal; color:var(--n600); font-size:10px; }
.fb-miss{ color:var(--red); }
.fb-act{ color:var(--n600); cursor:pointer; padding:0 4px; font-size:10px;
  border-radius:var(--radius-sm); }
.fb-act:hover{ color:var(--n100);
  background:color-mix(in srgb,var(--color-accent) 18%,transparent); }
.fb-kv{ display:grid; grid-template-columns:96px 1fr; gap:2px var(--space-2);
  padding:var(--space-1) var(--space-3); font-size:10.5px; color:var(--n300); }
.fb-kv b{ color:var(--n600); font-weight:400; }`;
  document.head.appendChild(st);
}

/* =========================================================================
   render
   ========================================================================= */
function targetRow() {
  const layers = AL.layers();
  const t = target();
  if (!t) return '<div class="p-note">This Show has no layers.</div>';
  const clips = (AL.layer(t.l) || {}).clips || [];
  const lopts = layers.map((L, i) =>
    `<option value="${i + 1}"${i + 1 === t.l ? ' selected' : ''}>${
      esc(Kit.dispName(AL.val(L.name), i + 1))}</option>`).join('');
  const copts = clips.map((_, i) =>
    `<option value="${i + 1}"${i + 1 === t.c ? ' selected' : ''}>${
      esc(Kit.dispName(AL.val((AL.column(i + 1) || {}).name), i + 1))}</option>`).join('');
  return `<div class="p-toolbar fb-tools">
    <span style="color:var(--n600);font-size:10px">Into</span>
    <select id="fbLayer">${lopts}</select>
    <select id="fbClip">${copts}</select>
    ${S.target ? '<button class="btn" id="fbFollow">Follow selection</button>' : ''}
  </div>`;
}

function mediaSection(list) {
  const fold = folders(list);
  const state = S.rootOk === true ? 'confirmed by Arena'
              : S.rootOk === false ? 'Arena finds nothing there'
              : 'not checked';
  const rootRow = `<div class="p-toolbar fb-tools">
    <span style="color:var(--n600);font-size:10px">Root</span>
    <input type="text" id="fbRoot" value="${esc(root())}"
      title="Where Arena is installed. No endpoint reports this, so it is a setting.">
    <button class="btn" id="fbCheck">Check</button>
    <span class="p-dim${S.rootOk === false ? ' fb-miss' : ''}">${esc(state)}</span>
  </div>`;
  const tools = rootRow + `<div class="p-toolbar fb-tools">
    <select id="fbFolder">
      <option value=""${S.folder ? '' : ' selected'}>All folders</option>
      ${fold.map(f => `<option${f === S.folder ? ' selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
    <select id="fbFilter" title="Arena's own media filters">
      ${FILTERS().map(f => `<option${f === S.filter ? ' selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
    <input type="text" id="fbQuery" placeholder="Search" value="${esc(S.query)}">
    <button class="btn${previews() ? ' on' : ''}" id="fbPrev"
      title="When activated the browser will show previews for pictures and video files.">Show Previews</button>
  </div>`;

  if (!list.length) return tools + Kit.nothing(root()
    ? 'RESOLUME.arena.assets.media carries no entries, so there is no shipped inventory to list.'
    : 'Set the install root above to turn the decoded inventory into real paths.');

  if (S.filter === 'Stills') return tools +
    `<div class="p-note">Arena's FileInfo reports an audio track and a video track
      and carries no still/motion flag, so <b>Stills</b> cannot be resolved over
      the REST API. The other filters are answered by Arena itself.</div>`;

  /* the search box filters the rendered rows in place, so typing never
     triggers a repaint that would take the caret with it */
  const rows = list.filter(m => (!S.folder || m.folder === S.folder) && passes(m));

  let body;
  if (S.probing) body = '<div class="p-note">Asking Arena about these files…</div>';
  else if (!rows.length && S.filter !== 'All Media' && !S.probed)
    body = '<div class="p-note">Arena has not reported on these files yet.</div>';
  else if (!rows.length) body = Kit.nothing('Nothing matches.');
  else if (previews()) body =
    `<div class="p-note">Show Previews is on. Arena draws those previews itself.
      the REST API carries a thumbnail for a <i>clip</i> only, never for a file on
      disk, and a page cannot read ${esc(root())} directly. These tiles carry the
      real name, type and size instead.</div>` +
    `<div class="p-grid">${rows.map(m => `<div class="fb-tile" draggable="true"
        data-path="${esc(m.path)}" title="${esc(m.path)}">
        <b>${esc(m.name)}</b><i>${esc(m.ext.toUpperCase())} · ${esc(size(m.bytes))}</i>
        <i>${esc(m.folder)}</i>${probeLine(m)}</div>`).join('')}</div>`;
  else body =
    `<div class="p-list">${rows.map(m => `<div class="p-row" draggable="true"
        data-path="${esc(m.path)}" title="${esc(m.path)}">
        <span>${esc(m.file)}</span>
        <span class="p-dim">${esc(m.folder)} · ${esc(size(m.bytes))}${esc(probeText(m))}</span>
      </div>`).join('')}</div>`;

  return tools + body +
    `<div class="p-note">Double-click to load into the target clip above, or drag a
      row out. <span id="fbCount">${rows.length}</span> of ${list.length} shown.</div>`;
}

function applyQuery(host) {
  const q = S.query.toLowerCase();
  let n = 0;
  host.querySelectorAll('[data-path]').forEach(r => {
    const hit = !q || (r.dataset.path.toLowerCase().includes(q));
    r.style.display = hit ? '' : 'none';
    if (hit) n++;
  });
  const c = host.querySelector('#fbCount');
  if (c) c.textContent = String(n);
}

function passes(m) {
  if (S.filter === 'All Media') return true;
  const fi = S.probe[fileUrl(m.path)];
  if (!fi) return false;                       // unknown until Arena answers
  const v = !!fi.video, a = !!fi.audio;
  if (S.filter === 'Video') return v;
  if (S.filter === 'Audio') return a;
  if (S.filter === 'AudioVideo') return v && a;
  if (S.filter === 'VideoOnly') return v && !a;
  if (S.filter === 'AudioOnly') return a && !v;
  return false;
}
function probeText(m) {
  const fi = S.probe[fileUrl(m.path)];
  if (!fi) return '';
  if (!fi.exists) return ' · missing';
  const v = fi.video;
  return v ? ` · ${v.width}×${v.height} · ${v.duration}` : ' · audio';
}
function probeLine(m) {
  const t = probeText(m);
  return t ? `<i>${esc(t.replace(/^ · /, ''))}</i>` : '';
}

function infoSection() {
  const fi = S.info;
  if (!fi) return '<div class="p-note">Nothing inspected yet. Type a path above and press Inspect. This asks Arena, over POST /file-info, what it can read at that location.</div>';
  const kv = [['URI', fi.uri], ['Exists', fi.exists ? 'yes' : 'no'],
              ['Size', fi.file_size != null ? size(fi.file_size) : 'N/A']];
  if (fi.video) kv.push(
    ['Video', `${fi.video.width}×${fi.video.height}`],
    ['Duration', fi.video.duration],
    ['Frame rate', fi.video.framerate
      ? (fi.video.framerate.num / (fi.video.framerate.denom || 1)).toFixed(2) + ' fps' : 'N/A']);
  if (fi.audio) kv.push(
    ['Audio', `${fi.audio.format}, ${fi.audio.num_channels} ch`],
    ['Sample rate', fi.audio.sample_rate + ' Hz'],
    ['BPM', String(fi.audio.bpm)]);
  return `<div class="fb-kv">${kv.map(([k, v]) =>
    `<b>${esc(k)}</b><span${!fi.exists && k === 'Exists' ? ' class="fb-miss"' : ''}>${esc(v)}</span>`
  ).join('')}</div>`;
}

function compSection() {
  const files = compFiles();
  if (!files.length) return Kit.nothing('No clip in this Show references a file.');
  return `<div class="p-list">${files.map(r => {
    const fi = r.fi, ok = fi.exists !== false, u = r.uses[0];
    const where = r.uses.map(x => `${x.l}·${x.c}`).join(' ');
    return `<div class="p-row" title="${esc(fi.path)}">
      <span class="${ok ? '' : 'fb-miss'}">${esc(baseName(fi.path))}</span>
      <span class="p-dim">${esc(r.track)} · ${ok ? esc(fi.format || '') : 'MISSING'} · ${esc(where)}</span>
      <span class="fb-act" data-relocate="${esc(fi.path)}" data-l="${u.l}" data-c="${u.c}"
        title="Relocate or replace this particular file.">relocate</span>
    </div>`;
  }).join('')}</div>
  <div class="p-note">Clip positions are layer · Cue. Relocate fills the path box
    above and aims it at the first clip that uses the file; Arena has no relocate
    endpoint, so a re-open is the relocate.</div>`;
}

/* the honest headline: the control exists in Arena, the API does not carry it */
const GAP = Kit.unavailable('Browsing the filesystem',
  'The REST API has one file operation, POST /file-info, and it only answers ' +
  'questions about a path you already have. There is no directory listing, no ' +
  'drive list and no file thumbnail, so no page can walk your disks. Type or ' +
  'drop a path, or use the media Arena ships, below.');

function referenceSection() {
  const roots = ROOTS(), filters = FILTERS();
  return `<div class="p-note">Arena's browser opens on these roots. Reference
      only. Nothing here is somewhere this page can navigate to.</div>` +
    `<div class="p-list">${roots.map(r =>
      `<div class="p-row"><span>${esc(r)}</span><span class="p-dim">root</span></div>`).join('')}</div>` +
    `<div class="p-note">Media filters: ${filters.map(esc).join(' · ')}</div>`;
}

function checklistSection() {
  const list = Kit.components('Browser');
  if (!list.length) return Kit.nothing('No decoded component data.');
  return `<div class="p-list">${list.map(c =>
    `<div class="p-row" title="${esc(c.help || '')}">
      <span>${esc(c.title)}</span><span class="p-dim">${esc(c.id)}</span></div>`).join('')}</div>`;
}

/* =========================================================================
   panel
   ========================================================================= */
function sig() {
  if (AL.status !== 'live') return AL.status;
  const t = target();
  return [AL.status, AL.layers().length, t ? t.l + '/' + t.c : '-',
    compFiles().map(r => r.fi.path + (r.fi.exists ? '1' : '0')).join('|')].join('~');
}

WS.register('Files', {
  title: 'Files',
  build(host) {
    const paint = (force) => {
      if (!host.isConnected) return;
      if (AL.status !== 'live') {
        S.sig = 'offline';
        host.innerHTML = Kit.offline('The file browser needs a running Arena to load anything.');
        return;
      }
      const s = sig();
      if (!force && s === S.sig) return;      // a 5 s reconcile must not eat typing
      S.sig = s;

      const list = shipped();
      const missing = compFiles().filter(r => r.fi.exists === false).length;

      host.innerHTML =
        GAP +
        targetRow() +
        `<div class="p-toolbar fb-tools">
          <input type="text" id="fbPath" placeholder="Full path, e.g. ${esc(root())}\\media\\AV\\Bass 001.mov"
            value="${esc(S.path)}">
          <button class="btn" id="fbOpen">Open</button>
          <button class="btn" id="fbInspect">Inspect</button>
        </div>` +
        (S.msg ? `<div class="p-note${S.bad ? ' fb-miss' : ''}">${esc(S.msg)}</div>` : '') +
        `<div class="dropmsg fb-drop" id="fbDrop">Drop files from your desktop here</div>` +
        (S.drop ? `<div class="p-note">${S.drop}</div>` : '') +
        Kit.section('Arena Media', mediaSection(list),
          { tag: String(list.length) }) +
        Kit.section('Files in This Show', compSection(),
          { tag: missing ? missing + ' missing' : '' }) +
        Kit.section('File Info', infoSection(), { folded: !S.info }) +
        Kit.section('Browse', referenceSection(), { folded: true }) +
        Kit.section('This Panel in Arena', checklistSection(), { folded: true });

      Kit.bind(host);
      wire(host, paint);
    };
    /* S is module-level so a half-typed path survives a repaint — but that also
       means S.sig survives a previous mount of this panel. On a fresh host the
       signature is unchanged, so paint(false) hit the early return above and
       left the new host empty. The first paint of each host must be forced. */
    let first = true;
    Kit.live(host, () => { paint(first); first = false; }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});

/* =========================================================================
   wiring
   ========================================================================= */
function wire(host, paint) {
  const $ = s => host.querySelector(s);

  const lay = $('#fbLayer'), clp = $('#fbClip');
  if (lay) lay.addEventListener('change', () => {
    S.target = { l: +lay.value, c: +((clp && clp.value) || 1) }; paint(true);
  });
  if (clp) clp.addEventListener('change', () => {
    S.target = { l: +((lay && lay.value) || 1), c: +clp.value }; paint(true);
  });
  const fol = $('#fbFollow');
  if (fol) fol.addEventListener('click', () => { S.target = null; paint(true); });

  const path = $('#fbPath');
  if (path) path.addEventListener('input', () => { S.path = path.value; });

  const open = $('#fbOpen');
  if (open) open.addEventListener('click', () => doOpen(S.path, paint));

  const insp = $('#fbInspect');
  if (insp) insp.addEventListener('click', () => doInspect(S.path, paint));

  /* media list */
  const rt = $('#fbRoot');
  if (rt) rt.addEventListener('change', () => { setRoot(rt.value); paint(true); });
  const chk = $('#fbCheck');
  if (chk) chk.addEventListener('click', () => checkRoot(paint));

  const fld = $('#fbFolder');
  if (fld) fld.addEventListener('change', () => { S.folder = fld.value; paint(true); });
  const flt = $('#fbFilter');
  if (flt) flt.addEventListener('change', () => {
    S.filter = flt.value; paint(true);
    /* the track-based filters are Arena's answer, not a guess from the
       extension, so ask it once */
    if (S.filter !== 'All Media' && S.filter !== 'Stills' && !S.probed && !S.probing)
      probeShipped(paint);
  });
  const q = $('#fbQuery');
  if (q) q.addEventListener('input', () => { S.query = q.value; applyQuery(host); });
  applyQuery(host);
  const pv = $('#fbPrev');
  if (pv) pv.addEventListener('click', () => {
    WS.param('ShowFileBrowserThumbnails', !previews());
    paint(true);
  });

  host.querySelectorAll('[data-path]').forEach(r => {
    r.addEventListener('click', () => { S.path = r.dataset.path; const p = $('#fbPath'); if (p) p.value = S.path; });
    r.addEventListener('dblclick', () => doOpen(r.dataset.path, paint));
    r.addEventListener('dragstart', e => {
      const url = fileUrl(r.dataset.path);
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'file', path: r.dataset.path, url }));
      e.dataTransfer.setData('text/uri-list', url);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  host.querySelectorAll('[data-relocate]').forEach(b => b.addEventListener('click', ev => {
    ev.stopPropagation();
    S.path = b.dataset.relocate;
    S.target = { l: +b.dataset.l, c: +b.dataset.c };
    S.msg = 'Edit the path and press Open to relocate this file.'; S.bad = false;
    paint(true);
  }));

  /* OS drop */
  const drop = $('#fbDrop');
  if (drop) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drop'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('drop');
      handleDrop(e.dataTransfer, paint);
    });
  }
}

function doOpen(p, paint) {
  const url = fileUrl(p);
  const t = target();
  if (!url) { S.msg = 'Type a full path first.'; S.bad = true; return paint(true); }
  if (!t) { S.msg = 'No layer to load into.'; S.bad = true; return paint(true); }
  S.msg = `Loading ${baseName(p)} into layer ${t.l}, Cue ${t.c}…`; S.bad = false; paint(true);
  openInto(t.l, t.c, url)
    .then(() => { S.msg = `Opened ${baseName(p)} in ${t.l}·${t.c}.`; S.bad = false; paint(true); })
    .catch(e => { S.msg = `Arena did not load it: ${why(e)}`; S.bad = true; paint(true); });
}

function doInspect(p, paint) {
  const url = fileUrl(p);
  if (!url) { S.msg = 'Type a full path first.'; S.bad = true; return paint(true); }
  S.msg = 'Asking Arena about ' + baseName(p) + '…'; S.bad = false; paint(true);
  fileInfo([url])
    .then(r => {
      S.info = (r && r[0]) || null;
      S.msg = S.info ? '' : 'Arena returned nothing for that path.';
      S.bad = !S.info;
      paint(true);
    })
    .catch(e => { S.msg = `/file-info refused: ${why(e)}`; S.bad = true; paint(true); });
}

/* the install root is the one part of a shipped-media path we cannot decode,
   so let Arena settle it: /file-info reports whether the first file is there */
function checkRoot(paint) {
  const list = shipped();
  if (!list.length) return;
  S.msg = 'Checking the install root with Arena…'; S.bad = false; paint(true);
  fileInfo([fileUrl(list[0].path)])
    .then(r => {
      const fi = r && r[0];
      S.rootOk = !!(fi && fi.exists);
      S.msg = S.rootOk ? '' : `Arena cannot find ${list[0].file} under that root.`;
      S.bad = !S.rootOk;
      paint(true);
    })
    .catch(e => { S.msg = `/file-info refused: ${why(e)}`; S.bad = true; paint(true); });
}

function probeShipped(paint) {
  const list = shipped();
  if (!list.length) return;
  const urls = list.map(m => fileUrl(m.path));
  S.probing = true; paint(true);
  fileInfo(urls)
    .then(res => {
      (res || []).forEach((fi, i) => { if (fi) S.probe[urls[i]] = fi; });
      S.probed = true;
    })
    .catch(e => { S.msg = `/file-info refused: ${why(e)}`; S.bad = true; })
    .then(() => { S.probing = false; paint(true); });
}

/* A page gets a dropped file's bytes, not its location: File.path is an
   Electron extension and does not exist in a browser. Some file managers do
   hand over a text/uri-list, so try that first and be plain about the rest. */
function handleDrop(dt, paint) {
  if (!dt) return;
  const uri = (dt.getData('text/uri-list') || '').split('\n')
    .map(s => s.trim()).filter(s => s && s[0] !== '#')[0] || '';
  const plain = (dt.getData('text/plain') || '').trim();
  const files = [...(dt.files || [])];

  /* a row dragged out of this panel's own media list carries its path */
  if (plain[0] === '{') {
    let item; try { item = JSON.parse(plain); } catch { item = null; }
    if (item && item.kind === 'file' && item.path) {
      S.path = item.path;
      S.drop = `<b>${esc(baseName(item.path))}</b> from the Arena media list. Press Open.`;
      S.msg = ''; S.bad = false;
      return paint(true);
    }
  }

  const native = files.length && typeof files[0].path === 'string' ? files[0].path : '';

  const looksAbsolute = s => /^file:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s) || /^\//.test(s);
  const found = native || (looksAbsolute(uri) ? uri : looksAbsolute(plain) ? plain : '');

  if (found) {
    S.path = nativePath(found);
    S.drop = `Read the full path from the drop: <b>${esc(baseName(S.path))}</b>. Press Open.`;
    S.msg = ''; S.bad = false;
    return paint(true);
  }
  if (files.length) {
    S.path = files[0].name;
    S.drop = `Your browser handed over ${files.length} file${files.length > 1 ? 's' : ''} ` +
      `(${files.map(f => esc(f.name) + ' · ' + size(f.size)).join(', ')}) but not their ` +
      `location on disk: only a packaged desktop build can read that. Arena loads by ` +
      `path, so complete the folder in the box above. Dropping onto Arena's own window ` +
      `still works as it always did.`;
    S.msg = ''; S.bad = false;
    return paint(true);
  }
  S.drop = 'Nothing usable in that drop.';
  paint(true);
}
})();
