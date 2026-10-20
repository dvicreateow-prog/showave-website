/* ===========================================================================
   panels/layers-and-clips.js — the deck: column trigger row, clip grid, layer
   strips and deck tabs, as the single panel Arena treats them as.
   ---------------------------------------------------------------------------
   Nothing here is decorative. Column, clip, layer and deck names, connected
   states, blend-mode option lists, fader ranges and thumbnails all come off
   the composition ArenaLive holds; every tooltip is Arena's own help string
   out of the decoded component manifest.

   The six View toggles that govern the layer strip's sub-controls are read
   through ws.param(), so switching "Show Audio Controls" off really removes
   the A fader rather than dimming it.

   Repaint strategy: the DOM is rebuilt only when the SHAPE changes (layer /
   column / deck count, which clip is playing on each layer, the toggles).
   Everything else — states, names, fader positions, thumbnails — is written
   into the existing nodes, so a burst of parameter traffic never flickers the
   grid and never loses the scroll position.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* ---- Arena's own help, keyed by the title the application shows ---------- */
const HELP = (() => {
  const idx = {};
  ['Autopilot', 'Browser', 'Clip', 'Column', 'Composition', 'Dashboard', 'Effects',
   'Layer', 'Monitor', 'Other', 'Output', 'Preferences', 'Record', 'Shortcuts']
    .forEach(g => Kit.components(g).forEach(c => {
      if (c.title && !(c.title in idx) && c.help) idx[c.title] = c.help;
    }));
  return t => idx[t] || t;
})();
/* summaries of the REST operations this panel calls, so even the "+" buttons
   are labelled with something Arena wrote rather than something we made up */
const SUMMARY = {
  addLayer:  'Add a new layer to the Show',
  addColumn: 'Add a new Cue to the Show',
  addDeck:   'Add a new Bank to the Show',
  openDeck:  'Re-open the given Bank',
  clearClip: 'Clears the clip by its position in the clip grid',
};
/* Arena drags clips between slots. /composition/clips/swap exists but the
   decoded spec carries no request body for it, so this surface will not
   pretend to offer the gesture. */
const NO_CLIP_MOVE =
  'Arena moves clips by dragging them between slots. The REST API exposes ' +
  '/composition/clips/swap but the decoded spec carries no request body for ' +
  'it, so this panel cannot perform the move.';

/* ---- View toggles -------------------------------------------------------
   workspace.js hands a docked panel its state object, panel.html hands an
   undocked one the Workspace API, and an undocked window never loaded a
   layout at all — which is what the presets' own defaults are for. */
const DEFAULTS = (() => {
  const r = window.RESOLUME && window.RESOLUME.arena;
  const out = {};
  Object.entries((r && r.layout_params) || {}).forEach(([k, v]) => { out[k] = v.default === '1'; });
  return out;
})();
function view(ws, name) {
  let v;
  if (ws && typeof ws.param === 'function') v = ws.param(name);
  else if (ws && ws.params && name in ws.params) v = ws.params[name];
  else if (WS && typeof WS.param === 'function') v = WS.param(name);
  return v === undefined ? !!DEFAULTS[name] : !!v;
}
const toggles = ws => ({
  audio:      view(ws, 'Show Audio Controls'),
  speed:      view(ws, 'Show Clip Speed Sliders on Layers'),
  transport:  view(ws, 'Show Layer Transport Controls'),
  transition: view(ws, 'Show Layer Transition Controls'),
  big:        view(ws, 'Show Big Column Triggers'),
  tall:       view(ws, 'Show Tall Column Triggers'),
});

/* ---- layout the shared vocabulary has no words for ---------------------- */
const CSS = `
.lc{ position:absolute; inset:0; display:flex; flex-direction:column; }
.lc-body{ flex:1; min-height:0; display:flex; align-items:flex-start; overflow:auto; }
.lc-strips{ flex:0 0 auto; position:sticky; left:0; z-index:2; background:var(--strip);
  border-right:1px solid var(--line); }
.lc-gap{ position:sticky; top:0; z-index:1; display:flex; align-items:center; box-sizing:border-box;
  gap:var(--space-2); padding:0 var(--space-2); background:var(--head);
  border-bottom:1px solid var(--line); }
.lc-gap .lbl{ flex:1; min-width:0; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--n600); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lc-grid{ display:table; border-spacing:0; }
.lc-colrow .gcell{ position:sticky; top:0; z-index:1; background:var(--bg); }
/* 84 / 20, tracking the main window. This panel builds its own strip out of
   flex rather than reusing #leftCol's grid, but it emits the same class
   vocabulary (.lx .lbs .lfad .lthumb .ltrans .lt .lab .lnav .lname .lclip),
   so arena.css's .layer .lab .btn{height:var(--lname-h)} and
   .layer .ltrans .r .btn{height:var(--ctl-h)} reach it at (0,3,0) and this
   file's (0,2,0) rules cannot outrank them. Both tokens moved to 20 with the
   main strip, so an 18px bottom bar would now be holding 20px buttons.
   Height follows: 62 control block + 20 bar + 2 padding = 84. */
.lc .layer{ display:flex; flex-direction:column; width:100%; height:84px; box-sizing:border-box; }
.lc .ls-top{ flex:1; min-height:0; display:flex; align-items:stretch; gap:2px; padding:2px; }
.lc .ls-bot{ flex:0 0 20px; display:flex; align-items:center; gap:2px; padding:0 2px; }
.lc .lx{ flex:0 0 20px; padding:0; }
.lc .lx .btn{ flex:1; padding:0; }
.lc .lbs{ flex:0 0 74px; padding:0; }
.lc .lfad{ flex:0 0 auto; padding:0; gap:2px; }
.lc .lfad .vfad{ width:15px; height:auto; align-self:stretch; }
.lc .lthumb{ flex:1 1 70px; min-width:40px; padding:0; }
.lc .ltrans{ flex:0 0 96px; min-width:0; padding:0; justify-content:center; }
.lc .ltrans .r .btn{ padding:0 4px; }
.lc .lt{ flex:0 0 60px; min-width:0; padding:0; justify-content:center; }
.lc .lt .r{ display:flex; align-items:center; gap:2px; }
.lc .ls-rng{ flex:1; min-width:0; height:13px; }
.lc .ls-val{ flex:0 0 26px; font-size:9px; color:var(--n600); text-align:right;
  font-variant-numeric:tabular-nums; }
.lc .lname{ flex:1 1 0; min-width:0; padding:0 var(--space-2); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.lc .lclip{ flex:1 1 0; min-width:0; padding:0 var(--space-2); cursor:pointer; }
.lc .lab, .lc .lnav{ flex:0 0 auto; }
.lc .lthumb .box img, .lc .clip .thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
.lc .clip[data-state^="Previewing"]{ border-color:var(--a600); }
.lc .colhead.lc-add{ width:22px; }
.lc-decks{ flex:0 0 auto; display:flex; align-items:center; gap:var(--space-1); overflow-x:auto;
  padding:var(--space-1) var(--space-2); background:var(--panel); border-top:1px solid var(--line); }
.lc-decks .deck-tab.closed{ opacity:.45; }
.lc-msg{ flex:0 0 auto; }
.lc-msg:empty{ display:none; }
`;
let styled = false;
function ensureStyle() {
  if (styled || document.getElementById('lc-style')) { styled = true; return; }
  const s = document.createElement('style');
  s.id = 'lc-style';
  s.textContent = CSS;
  document.head.appendChild(s);
  styled = true;
}

/* ---- one popup menu at a time, in the chrome the rest of the app uses ---- */
let openMenu = null;
const closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null; } };
addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
function menu(anchor, items, pick) {
  closeMenu();
  const d = Kit.el('div', 'dropdown');
  items.forEach(it => {
    if (it.sep) { d.appendChild(Kit.el('div', 'dd-sep')); return; }
    const row = Kit.el('div', 'dd-item' + (it.dis ? ' disabled' : ''),
      `<span class="chk">${it.on ? '✓' : ''}</span><span>${Kit.esc(it.label)}</span>`);
    if (it.help) row.title = it.help;
    if (!it.dis) row.addEventListener('click', () => {
      closeMenu();
      pick(it.value !== undefined ? it.value : it.label, it);
    });
    d.appendChild(row);
  });
  document.body.appendChild(d);
  const a = anchor.getBoundingClientRect(), m = d.getBoundingClientRect();
  d.style.left = Math.max(4, Math.min(a.left, innerWidth - m.width - 4)) + 'px';
  d.style.top  = Math.max(4, Math.min(a.bottom + 2, innerHeight - m.height - 4)) + 'px';
  openMenu = d;
  return d;
}
/* context menus open at the cursor, not under the whole strip */
const at = (x, y) => ({ getBoundingClientRect: () => ({ left: x, bottom: y, top: y, right: x, width: 0, height: 0 }) });

/* ---- model helpers ------------------------------------------------------ */
const nameOf   = (p, i) => Kit.dispName(Kit.val(p), i);
const clipState = k => String(Kit.val(k && k.connected) || 'Empty');
const isOn      = s => s.indexOf('Connected') === 0;
const pidOf     = p => (p && p.id != null) ? p.id : null;
const norm  = p => { const a = p.min ?? 0, b = p.max ?? 1;
                     return Kit.clamp(((+Kit.val(p) || 0) - a) / ((b - a) || 1), 0, 1); };
const denorm = (p, t) => { const a = p.min ?? 0, b = p.max ?? 1; return a + t * (b - a); };
const fmtFad = (p, unit) => unit === 'dB'
  ? (+Kit.val(p) || 0).toFixed(1) + ' dB'
  : Math.round(norm(p) * 100) + ' %';

/* the clip a layer is actually running. Arena also publishes layer.active_clip
   but it carries no grid index, and the index is what thumbnails need. */
function activeClip(l) {
  const L = AL.layer(l);
  const clips = (L && L.clips) || [];
  for (let c = 1; c <= clips.length; c++) if (isOn(clipState(clips[c - 1]))) return { k: clips[c - 1], c };
  return null;
}
const controlsOf = a => (a && a.k.transport && a.k.transport.controls) || null;

/* the layer strip's speed slider follows whichever clip is playing, so the
   active clip is part of the panel's shape, not of its state */
function shape(v) {
  const cols = AL.columns().length, decks = AL.decks().length;
  const per = AL.layers().map((L, i) => {
    const a = activeClip(i + 1);
    return [pidOf(L.master), L.audio ? 1 : 0, L.video ? 1 : 0, L.transition ? 1 : 0,
            a ? (a.k.id || a.c) : 0].join(':');
  }).join(',');
  return [cols, decks, AL.groups().length, per,
          v.audio, v.speed, v.transport, v.transition, v.big, v.tall].join('|');
}

/* =========================================================================
   markup
   ========================================================================= */
const headHeight = v => 20 + (v.big ? 8 : 0) + (v.tall ? 24 : 0);
/* the strips column is exactly as wide as the sub-controls the View toggles
   left standing, so hiding a group of controls really reclaims the space */
function stripWidth(v) {
  const anyAudio = AL.layers().some(L => L.audio && L.audio.volume);
  const faders = 2 + (v.audio && anyAudio ? 1 : 0);
  /* SECOND COPY of a track list, kept by hand — the main window's four
     --leftw literals were the first and are now derived from the tracks
     themselves. This one cannot be, because the panel's strip is flex and
     its widths live in the <style> above rather than in a grid template.
     If you change a flex-basis in `.lc .lx/.lbs/.lfad/.lthumb/.ltrans/.lt`,
     change the matching number here. */
  const parts = [20, 74, faders * 15 + (faders - 1) * 2, 70];
  if (v.speed || v.transport) parts.push(96);
  if (v.transition) parts.push(60);
  return 4 + (parts.length - 1) * 2 + parts.reduce((a, b) => a + b, 0);
}

function fader(cls, letter, p, help, unit) {
  if (!p || p.id == null) return '';
  return `<div class="vfad ${cls}" data-pid="${p.id}" data-unit="${unit}" data-help="${Kit.esc(help)}"
    title="${Kit.esc(help)}"><i style="height:0%"></i><b>${letter}</b></div>`;
}
/* a horizontal parameter slider Kit.bind() will wire and Kit.apply() will
   keep current, in the compact form the strip has room for */
function slider(p, help, role) {
  if (!p || p.id == null)                       // nothing to control: park it, do not fake a value
    return `<input class="ls-rng" type="range" data-role="${role}" min="0" max="1000" value="0"
              disabled title="${Kit.esc(help)}"><span class="ls-val">N/A</span>`;
  const min = p.min ?? 0, max = p.max ?? 1;
  return `<input class="ls-rng pbind" type="range" data-pid="${p.id}" data-role="${role}"
      data-min="${min}" data-max="${max}" min="0" max="1000" step="1"
      value="${Math.round(norm(p) * 1000)}" title="${Kit.esc(help)}">
    <span class="val ls-val" data-pid="${p.id}">${Kit.esc(Kit.fmt(p, Kit.val(p)))}</span>`;
}

function stripHTML(l, v) {
  const L = AL.layer(l) || {};
  const blend = L.video && L.video.mixer && L.video.mixer['Blend Mode'];
  const tr = L.transition || {};
  const ctl = controlsOf(activeClip(l));

  const bs = `<div class="lbs">
      <div class="top">
        <button class="btn" data-a="byp" title="${Kit.esc(HELP('Bypass Layer'))}">B</button>
        <button class="btn" data-a="solo" title="${Kit.esc(HELP('Layer Solo'))}">S</button>
      </div>
      ${blend
        ? `<button class="ls-blend" data-a="blend" title="${Kit.esc(HELP('Select Layer Blend Mode'))}"></button>`
        : `<button class="ls-blend" disabled title="This layer has no video mixer.">N/A</button>`}
    </div>`;

  const faders = `<div class="lfad">
      ${fader('m', 'M', L.master, HELP('Layer Master'), '%')}
      ${v.audio ? (L.audio
        ? fader('a', 'A', L.audio.volume, HELP('Audio Volume'), 'dB')
        : '') : ''}
      ${fader('v', 'V', L.video && L.video.opacity, HELP('Video Opacity'), '%')}
    </div>`;

  const transport = (v.speed || v.transport) ? `<div class="ltrans">
      ${v.speed ? `<div class="r">${slider(ctl && ctl.speed,
          ctl ? HELP('Speed') : 'No clip is playing on this layer.', 'speed')}</div>` : ''}
      ${v.transport ? `<div class="r">
        <button class="btn" data-a="back"  ${ctl ? '' : 'disabled'}
          title="${Kit.esc(HELP('Play Backwards'))}">◀</button>
        <button class="btn" data-a="pause" ${ctl ? '' : 'disabled'}
          title="${Kit.esc(HELP('Pause Playback'))}">‖</button>
        <button class="btn" data-a="fwd"   ${ctl ? '' : 'disabled'}
          title="${Kit.esc(HELP('Play Forwards'))}">▶</button>
        <button class="btn" data-a="playmode" ${ctl && ctl.playmode ? '' : 'disabled'}
          title="${Kit.esc(HELP('Play mode'))}">⟲</button>
      </div>` : ''}
    </div>` : '';

  const transition = v.transition ? `<div class="lt">
      <div class="r">${slider(tr.duration, HELP('Transition Time'), 'tdur')}</div>
      ${tr.blend_mode
        ? `<button class="ls-blend" data-a="tblend" title="${Kit.esc(HELP('Select Transition'))}"></button>`
        : ''}
    </div>` : '';

  return `<div class="layer" data-l="${l}">
    <div class="ls-top">
      <div class="lx"><button class="btn" data-a="clear"
        title="${Kit.esc(HELP('Clear Layer'))}">✕</button></div>
      ${bs}${faders}
      <div class="lthumb"><div class="box"></div></div>
      ${transport}${transition}
    </div>
    <div class="ls-bot">
      <div class="lname" data-a="select" title="${Kit.esc(HELP('Select and Preview Layer'))}"></div>
      <div class="lab">
        <button class="btn" data-a="busA" title="${Kit.esc(HELP('Assign to Crossfader Bus'))}">A</button>
        <button class="btn" data-a="busB" title="${Kit.esc(HELP('Assign to Crossfader Bus'))}">B</button>
      </div>
      <div class="lclip" data-a="selectclip" title="${Kit.esc(HELP('Current Clip'))}"></div>
      <div class="lnav">
        <button class="btn" data-a="prevClip" title="${Kit.esc(HELP('Trigger Previous Clip'))}">⏮</button>
        <button class="btn" data-a="nextClip" title="${Kit.esc(HELP('Trigger Next Clip'))}">⏭</button>
      </div>
    </div></div>`;
}

function render(v) {
  const H = headHeight(v);
  const nCols = AL.columns().length;
  const order = AL.layers().map((_, i) => AL.layers().length - i);   // top of the stack first

  const heads = AL.columns().map((_, i) => {
    const c = i + 1;
    return `<div class="gcell"><div class="colhead" data-col="${c}" style="height:${H - 2}px"
      title="${Kit.esc(HELP('Column Trigger'))}"><span class="ico"></span><span class="lbl"></span></div></div>`;
  }).join('');

  const rows = order.map(l => {
    let cells = '';
    for (let c = 1; c <= nCols; c++)
      cells += `<div class="gcell"><div class="clip" data-l="${l}" data-c="${c}">
        <div class="thumb"></div><div class="name"></div></div></div>`;
    return `<div class="grow" data-l="${l}">${cells}<div class="gcell"></div></div>`;
  }).join('');

  const decks = AL.decks().map((d, i) =>
    `<div class="deck-tab${d.closed ? ' closed' : ''}" data-deck="${i}"
      title="${Kit.esc(d.closed ? SUMMARY.openDeck : HELP('Deck'))}"></div>`).join('');

  const groups = AL.groups();
  const groupNote = groups.length
    ? `<div class="p-note lc-msg">${groups.length} layer group${groups.length > 1 ? 's' : ''}: ${
        Kit.esc(groups.map((g, i) => nameOf(g.name, i + 1)).join(', '))
      }: their own strips are the Group panel's.</div>`
    : '';

  return `<div class="lc">
    <div class="lc-body">
      <div class="lc-strips" style="width:${stripWidth(v)}px">
        <div class="lc-gap" style="height:${H}px">
          <span class="lbl">${AL.layers().length} layers · ${nCols} Cues</span>
          <button class="btn" data-a="addlayer" title="${Kit.esc(SUMMARY.addLayer)}">+</button>
        </div>
        ${order.map(l => stripHTML(l, v)).join('')}
      </div>
      <div class="lc-grid">
        <div class="grow lc-colrow">${heads}
          <div class="gcell"><div class="colhead lc-add" data-a="addcol" style="height:${H - 2}px"
            title="${Kit.esc(SUMMARY.addColumn)}">+</div></div>
        </div>
        ${rows}
      </div>
    </div>
    ${groupNote}
    <div class="p-note lc-msg" data-role="msg"></div>
    <div class="lc-decks" title="${Kit.esc(HELP('Decks'))}">
      <button class="btn" data-a="deckprev" title="${Kit.esc(HELP('Select Previous Deck'))}">◀</button>
      ${decks || '<span class="p-note">This Show has no Banks.</span>'}
      <button class="btn" data-a="decknext" title="${Kit.esc(HELP('Select Next Deck'))}">▶</button>
      <button class="btn" data-a="adddeck" title="${Kit.esc(SUMMARY.addDeck)}">+</button>
    </div></div>`;
}

/* =========================================================================
   state written into the existing nodes
   ========================================================================= */
function setImg(box, url) {
  let img = box.querySelector('img');
  if (!url) { if (img) img.remove(); return; }
  if (!img) { img = new Image(); img.draggable = false; img.alt = ''; box.appendChild(img); }
  if (img.getAttribute('src') !== url) img.setAttribute('src', url);
}
const setText = (node, s) => { if (node && node.textContent !== s) node.textContent = s; };

function refresh(S) {
  const layerNames = AL.layers().map((L, i) => nameOf(L.name, i + 1));
  const colNames   = AL.columns().map((C, i) => nameOf(C.name, i + 1));

  S.heads.forEach(({ node, c }) => {
    const col = AL.column(c); if (!col) return;
    const st = String(Kit.val(col.connected) || 'Disconnected');
    node.classList.toggle('on', st === 'Connected');
    node.classList.toggle('disabled', st === 'Empty');
    setText(node.querySelector('.ico'), st === 'Connected' ? '▶' : '■');
    setText(node.querySelector('.lbl'), colNames[c - 1] || '');
    node.title = `${colNames[c - 1] || ''}: ${st}\n${HELP('Column Trigger')}`;
  });

  S.cells.forEach(({ node, l, c }) => {
    const k = AL.clip(l, c);
    const st = k ? clipState(k) : 'Empty';
    const empty = st === 'Empty';
    const cls = 'clip' + (empty ? ' empty' : '') + (isOn(st) ? ' playing' : '') +
                (k && Kit.val(k.selected) === true ? ' selected' : '');
    if (node.className !== cls) node.className = cls;
    node.dataset.state = st;
    setText(node.querySelector('.name'), empty ? '' : (Kit.val(k.name) || ''));
    setImg(node.querySelector('.thumb'), empty ? null : AL.thumbUrl(l, c));
    node.title = `${layerNames[l - 1] || ''} · ${colNames[c - 1] || ''}: ${st}`;
  });

  S.strips.forEach(({ node, l }) => {
    const L = AL.layer(l); if (!L) return;
    node.classList.toggle('sel', Kit.val(L.selected) === true);

    const byp = node.querySelector('[data-a=byp]');
    if (byp) byp.classList.toggle('on-red', Kit.val(L.bypassed) === true);
    const solo = node.querySelector('[data-a=solo]');
    if (solo) solo.classList.toggle('on', Kit.val(L.solo) === true);

    const xf = String(Kit.val(L.crossfadergroup) || 'None');
    const bA = node.querySelector('[data-a=busA]'), bB = node.querySelector('[data-a=busB]');
    if (bA) bA.classList.toggle('on', xf === 'A');
    if (bB) bB.classList.toggle('on', xf === 'B');

    const blend = L.video && L.video.mixer && L.video.mixer['Blend Mode'];
    const bBtn = node.querySelector('[data-a=blend]');
    if (bBtn && blend) setText(bBtn, String(Kit.val(blend) || '') + ' ▾');
    const tBtn = node.querySelector('[data-a=tblend]');
    if (tBtn && L.transition) setText(tBtn, String(Kit.val(L.transition.blend_mode) || '') + ' ▾');

    node.querySelectorAll('.vfad[data-pid]').forEach(f => {
      const p = AL.paramById(+f.dataset.pid); if (!p) return;
      const bar = f.querySelector('i');
      const pct = (norm(p) * 100).toFixed(1) + '%';
      if (bar.style.height !== pct) bar.style.height = pct;
      f.title = `${f.dataset.help}: ${fmtFad(p, f.dataset.unit)}`;
    });

    /* the sliders Kit.bind() owns; keep them current between pushes too */
    node.querySelectorAll('input[type=range].pbind[data-pid]').forEach(r => {
      if (document.activeElement === r) return;
      const p = AL.paramById(+r.dataset.pid); if (!p) return;
      const a = +r.dataset.min, b = +r.dataset.max;
      r.value = Math.round(Kit.clamp(((+Kit.val(p) || 0) - a) / ((b - a) || 1), 0, 1) * 1000);
      setText(node.querySelector(`.val[data-pid="${r.dataset.pid}"]`), Kit.fmt(p, Kit.val(p)));
    });

    const a = activeClip(l);
    const ctl = controlsOf(a);
    const dir = ctl ? String(Kit.val(ctl.playdirection) || '') : '';
    const mark = (sel, on) => { const e = node.querySelector(sel); if (e) e.classList.toggle('on', on); };
    mark('[data-a=back]', dir === '<');
    mark('[data-a=pause]', dir === '||');
    mark('[data-a=fwd]', dir === '>');
    const pm = node.querySelector('[data-a=playmode]');
    if (pm && ctl && ctl.playmode) pm.title = `${HELP('Play mode')}: ${Kit.val(ctl.playmode)}`;

    setText(node.querySelector('.lname'), layerNames[l - 1] || '');
    setText(node.querySelector('.lclip'), a ? (Kit.val(a.k.name) || '') : '');
    setImg(node.querySelector('.lthumb .box'), a ? AL.thumbUrl(l, a.c) : null);
  });

  S.decks.forEach(({ node, i }) => {
    const d = AL.decks()[i]; if (!d) return;
    node.classList.toggle('on', Kit.val(d.selected) === true);
    setText(node, nameOf(d.name, i + 1) + (d.closed ? ' (closed)' : ''));
  });
}

/* the composition push resubscribes only what the main window draws, so the
   playing clips' transport parameters have to be asked for again each time */
function keepSubscribed() {
  AL.layers().forEach((L, i) => {
    const ctl = controlsOf(activeClip(i + 1));
    if (!ctl) return;
    [ctl.speed, ctl.playdirection, ctl.playmode].forEach(p => {
      if (p && p.id != null) AL.subscribe(p.id);
    });
  });
}

/* =========================================================================
   gestures
   ========================================================================= */
function say(host, text) {
  const m = host.querySelector('[data-role=msg]');
  if (!m) return;
  m.textContent = text;
  setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 4000);
}
const fail = (host, what) => e => say(host, `${what} failed: ${e && e.message ? e.message : e}`);

function stepClip(host, l, dir) {
  const n = AL.columns().length;
  if (!n) return;
  const a = activeClip(l), cur = a ? a.c : 0;
  for (let i = 1; i <= n; i++) {
    const c = ((cur - 1) + dir * i + n * 2) % n + 1;
    if (clipState(AL.clip(l, c)) !== 'Empty') {
      AL.cmd.triggerClip(l, c).catch(fail(host, 'Trigger'));
      return;
    }
  }
  say(host, 'This layer has no clips to step through.');
}

function wireClips(host, S) {
  S.cells.forEach(({ node, l, c }) => {
    node.querySelector('.thumb').addEventListener('click', () => {
      if (clipState(AL.clip(l, c)) === 'Empty') return AL.cmd.selectClip(l, c).catch(fail(host, 'Select'));
      AL.cmd.triggerClip(l, c).catch(fail(host, 'Trigger'));
    });
    node.querySelector('.name').addEventListener('click', e => {
      e.stopPropagation();
      AL.cmd.selectClip(l, c).catch(fail(host, 'Select'));
    });
    node.addEventListener('contextmenu', e => {
      e.preventDefault();
      const k = AL.clip(l, c), empty = clipState(k) === 'Empty';
      menu(at(e.clientX, e.clientY), [
        { label: `${nameOf((AL.layer(l) || {}).name, l)} · ${nameOf((AL.column(c) || {}).name, c)}`, dis: 1 },
        { sep: 1 },
        { label: 'Trigger Clip', value: 'trigger', dis: empty ? 1 : 0, help: HELP('Clip Handle') },
        { label: 'Select Clip',  value: 'select', help: HELP('Current Clip') },
        { label: 'Rename…',      value: 'rename', dis: empty ? 1 : 0, help: HELP('Clip Name') },
        { label: 'Clear Clip',   value: 'clear',  dis: empty ? 1 : 0, help: SUMMARY.clearClip },
        { sep: 1 },
        { label: 'Move to another slot', dis: 1, help: NO_CLIP_MOVE },
      ], v => {
        if (v === 'trigger') AL.cmd.triggerClip(l, c).catch(fail(host, 'Trigger'));
        if (v === 'select')  AL.cmd.selectClip(l, c).catch(fail(host, 'Select'));
        if (v === 'rename') {
          const cur = Kit.val(k.name) || '';
          const next = prompt('Clip name', cur);
          if (next != null && k.name) AL.setParam(k.name.id, next);
        }
        if (v === 'clear' && confirm(`Clear "${Kit.val(k.name) || ''}"?`))
          AL.rest(`/composition/layers/${l}/clips/${c}/clear`, { method: 'POST' })
            .catch(fail(host, 'Clear'));
      });
    });
    /* content dropped from the Sources, Effects or Files panels */
    node.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault(); e.stopPropagation();
      node.classList.add('drop');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', e => {
      node.classList.remove('drop');
      let item; try { item = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!item || item.ws) return;                 // a workspace tab, not content
      e.preventDefault(); e.stopPropagation();
      if (item.kind === 'source' && item.id)
        AL.cmd.openSource(l, c, item.id)
          .then(() => say(host, `${item.name || item.id} → ${nameOf((AL.layer(l) || {}).name, l)}`))
          .catch(fail(host, 'Open source'));
      else if (item.kind === 'effect' && (item.name || item.id))
        /* the add endpoint builds an effect:/// URI from the NAME; the
           idstring is rejected with a 400 */
        AL.cmd.addEffect(`/composition/layers/${l}/clips/${c}`, item.name || item.id)
          .then(() => say(host, `+ ${item.name || item.id}`))
          .catch(fail(host, 'Add effect'));
      else if (item.path)
        AL.cmd.openFile(l, c, item.path)
          .then(() => say(host, `${item.name || item.path} → ${nameOf((AL.layer(l) || {}).name, l)}`))
          .catch(fail(host, 'Open file'));
      else say(host, 'That drop carried nothing this panel can load.');
    });
  });
}

function wireStrips(host, S) {
  S.strips.forEach(({ node, l }) => {
    node.addEventListener('click', e => {
      const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
      const L = AL.layer(l); if (!L) return;
      const a = b.dataset.a;
      const ctl = controlsOf(activeClip(l));
      if (a === 'clear')  return void AL.cmd.clearLayer(l).catch(fail(host, 'Clear layer'));
      if (a === 'select') return void AL.cmd.selectLayer(l).catch(fail(host, 'Select layer'));
      if (a === 'byp')    return void AL.setParam(pidOf(L.bypassed), Kit.val(L.bypassed) !== true);
      if (a === 'solo')   return void AL.setParam(pidOf(L.solo), Kit.val(L.solo) !== true);
      if (a === 'busA' || a === 'busB') {
        const want = a === 'busA' ? 'A' : 'B';
        const cur = String(Kit.val(L.crossfadergroup) || 'None');
        return void AL.setParam(pidOf(L.crossfadergroup), cur === want ? 'None' : want);
      }
      if (a === 'prevClip') return void stepClip(host, l, -1);
      if (a === 'nextClip') return void stepClip(host, l, 1);
      if (a === 'selectclip') {
        const ac = activeClip(l);
        return void (ac ? AL.cmd.selectClip(l, ac.c).catch(fail(host, 'Select'))
                        : say(host, 'No clip is playing on this layer.'));
      }
      if (a === 'blend' || a === 'tblend') {
        const p = a === 'blend'
          ? (L.video && L.video.mixer && L.video.mixer['Blend Mode'])
          : (L.transition && L.transition.blend_mode);
        if (!p || !(p.options || []).length) return void say(host, 'Arena reports no options for this parameter.');
        const cur = Kit.val(p);
        return void menu(b, p.options.map(o => ({ label: o, on: o === cur })), o => AL.setParam(p.id, o));
      }
      if (a === 'back' || a === 'pause' || a === 'fwd') {
        if (!ctl || !ctl.playdirection) return void say(host, 'No clip is playing on this layer.');
        const want = a === 'back' ? '<' : a === 'pause' ? '||' : '>';
        const opts = ctl.playdirection.options || [];
        if (opts.length && !opts.includes(want))
          return void say(host, `Arena does not offer "${want}" for this transport.`);
        return void AL.setParam(ctl.playdirection.id, want);
      }
      if (a === 'playmode') {
        if (!ctl || !ctl.playmode) return void say(host, 'No clip is playing on this layer.');
        const cur = Kit.val(ctl.playmode);
        return void menu(b, (ctl.playmode.options || []).map(o => ({ label: o, on: o === cur })),
          o => AL.setParam(ctl.playmode.id, o));
      }
    });

    /* the M / A / V faders — vertical, so Kit.bind has no word for them */
    node.querySelectorAll('.vfad[data-pid]').forEach(f => {
      f.addEventListener('mousedown', ev => {
        ev.preventDefault();
        const p = AL.paramById(+f.dataset.pid); if (!p) return;
        const h = f.getBoundingClientRect().height || 1;
        const y0 = ev.clientY, v0 = norm(p), bar = f.querySelector('i');
        const mv = e2 => {
          const t = Kit.clamp(v0 + (y0 - e2.clientY) / h, 0, 1);
          bar.style.height = (t * 100).toFixed(1) + '%';
          AL.setParam(p.id, denorm(p, t));
        };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      });
      f.addEventListener('contextmenu', ev => {          // reset, as Arena does
        ev.preventDefault();
        AL.resetParam(+f.dataset.pid);
      });
    });

    node.addEventListener('contextmenu', e => {
      if (e.target.closest('.vfad')) return;
      e.preventDefault();
      const L = AL.layer(l); if (!L) return;
      menu(at(e.clientX, e.clientY), [
        { label: nameOf(L.name, l), dis: 1 },
        { sep: 1 },
        { label: 'Select and Preview Layer', value: 'select', help: HELP('Select and Preview Layer') },
        { label: 'Clear Layer', value: 'clear', help: HELP('Clear Layer') },
        { label: 'Rename…', value: 'rename', help: HELP('Layer Name') },
      ], v => {
        if (v === 'select') AL.cmd.selectLayer(l).catch(fail(host, 'Select layer'));
        if (v === 'clear')  AL.cmd.clearLayer(l).catch(fail(host, 'Clear layer'));
        if (v === 'rename') {
          const next = prompt('Layer name', Kit.val(L.name) || '');
          if (next != null && L.name) AL.setParam(L.name.id, next);
        }
      });
    });
  });
}

function wireHeadsAndDecks(host, S) {
  S.heads.forEach(({ node, c }) => {
    node.addEventListener('click', () => AL.cmd.triggerColumn(c).catch(fail(host, 'Trigger Cue')));
    node.addEventListener('contextmenu', e => {
      e.preventDefault();
      menu(at(e.clientX, e.clientY), [
        { label: nameOf((AL.column(c) || {}).name, c), dis: 1 },
        { sep: 1 },
        { label: 'Trigger Cue', value: 'connect', help: HELP('Column Trigger') },
        { label: 'Select Cue', value: 'select' },
        { label: 'Rename…', value: 'rename' },
      ], v => {
        const col = AL.column(c); if (!col) return;
        if (v === 'connect') AL.cmd.triggerColumn(c).catch(fail(host, 'Trigger Cue'));
        if (v === 'select')  AL.cmd.selectColumn(c).catch(fail(host, 'Select Cue'));
        if (v === 'rename') {
          const next = prompt('Cue name', Kit.val(col.name) || '');
          if (next != null && col.name) AL.setParam(col.name.id, next);
        }
      });
    });
  });

  S.decks.forEach(({ node, i }) => {
    node.addEventListener('click', () => {
      const d = AL.decks()[i]; if (!d) return;
      if (d.closed) return void AL.rest(`/composition/decks/${i + 1}/open`, { method: 'POST' })
        .catch(fail(host, 'Open Bank'));
      AL.cmd.selectDeck(i);
    });
  });

  host.querySelectorAll('[data-a]').forEach(b => {
    const a = b.dataset.a;
    if (a === 'addlayer') b.addEventListener('click', () => AL.cmd.addLayer().catch(fail(host, 'Add layer')));
    if (a === 'addcol')   b.addEventListener('click', () => AL.cmd.addColumn().catch(fail(host, 'Add Cue')));
    if (a === 'adddeck')  b.addEventListener('click', () => AL.cmd.addDeck().catch(fail(host, 'Add Bank')));
    if (a === 'deckprev' || a === 'decknext') b.addEventListener('click', () => {
      const n = AL.decks().length; if (!n) return;
      const next = Kit.clamp(AL.activeDeckIndex() + (a === 'decknext' ? 1 : -1), 0, n - 1);
      AL.cmd.selectDeck(next);
    });
  });
}

/* =========================================================================
   the panel
   ========================================================================= */
WS.register('LayersAndClips', {
  title: 'Layers and Clips',
  build(host, node, ws) {
    ensureStyle();
    const S = { sig: null, cells: [], heads: [], strips: [], decks: [] };

    Kit.live(host, () => {
      if (AL.status !== 'live') {
        S.sig = null;
        host.innerHTML = Kit.offline(
          'The grid, the layer strips, the Cue triggers and the Banks are all live state.');
        return;
      }
      if (!AL.comp) {
        S.sig = null;
        host.innerHTML = Kit.nothing('Connected: waiting for Arena to push the Show.');
        return;
      }
      if (!AL.layers().length) {
        S.sig = null;
        host.innerHTML = Kit.nothing('This Show has no layers.');
        return;
      }

      const v = toggles(ws);
      const sig = shape(v);
      if (sig !== S.sig) {
        const old = host.querySelector('.lc-body');
        const sx = old ? old.scrollLeft : 0, sy = old ? old.scrollTop : 0;
        S.sig = sig;
        host.innerHTML = render(v);

        S.cells  = [...host.querySelectorAll('.clip[data-l]')]
          .map(n => ({ node: n, l: +n.dataset.l, c: +n.dataset.c }));
        S.heads  = [...host.querySelectorAll('.colhead[data-col]')]
          .map(n => ({ node: n, c: +n.dataset.col }));
        S.strips = [...host.querySelectorAll('.layer[data-l]')]
          .map(n => ({ node: n, l: +n.dataset.l }));
        S.decks  = [...host.querySelectorAll('.deck-tab[data-deck]')]
          .map(n => ({ node: n, i: +n.dataset.deck }));

        wireClips(host, S);
        wireStrips(host, S);
        wireHeadsAndDecks(host, S);
        Kit.bind(host);

        const box = host.querySelector('.lc-body');
        if (box) { box.scrollLeft = sx; box.scrollTop = sy; }
      }
      keepSubscribed();
      refresh(S);
    }, { repaintOnParam: true });
  },
  destroy(host) {
    closeMenu();
    if (host._panelOff) host._panelOff();
  }
});
})();
