/* ===========================================================================
   panels/monitor.js — the Monitor panel. One module, all 26 layout instances.
   ---------------------------------------------------------------------------
   The layout node carries subject_type / subject_index / instance /
   checker_board / showUI. Every one is read off the node and honoured, because
   the ten shipped layouts place this same panel 26 times and only those
   attributes tell the instances apart.

   WHAT THE PICTURE IS. Arena 7.27.1 does publish its render targets over REST
   — checked against the running application rather than assumed:

       GET /composition/monitors                   -> [{id,name,associated_object}]
       GET /composition/monitors/<id>/snapshot.jpg -> image/jpeg, ACAO:*

   The list it answers with is Composition, Preview, Result, Bus A, Bus B,
   Selected Group, Selected Layer, plus one entry per layer whose
   associated_object is /composition/layers/by-id/<layer id>. So this panel
   shows the real GPU frame — but as a polled still, one JPEG at a time. It is
   not a stream, and the caption says so rather than implying video.

   Where Arena has no render target the panel is explicit about it. A single
   clip has none, so Clip Preview uses /composition/clips/selected/thumbnail
   and is labelled a thumbnail. Advanced Output screens have none either, and
   the REST API carries no Advanced Output at all — no screen, slice or warp
   path among the 258 it publishes — so those sources render Kit.unavailable.

   The thumbnail composite is the honest offline-ish fallback and a first-class
   choice in the cog menu: each layer's playing clip thumbnail stacked with
   that layer's own blend mode and opacity. CSS carries 13 of Arena's ~60 blend
   modes; the caption counts the ones it had to drop.

   Footer and cog follow Arena's own — the manual puts the cogwheel at the
   bottom right of a monitor, and RESOLUME's CTX_MONITOR names its items. Fold
   state comes from the workspace's four *Monitor Fold params.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;
const esc = Kit.esc, clamp = Kit.clamp;
const ui = value => window.ShowaveBrand && typeof window.ShowaveBrand.label === 'function'
  ? window.ShowaveBrand.label(value) : String(value == null ? '' : value);

/* ---- decoded reference --------------------------------------------------- */
const helpOf = (panel, title) => {
  const c = Kit.components(panel).find(x => x.title === title);
  return c ? c.help : '';
};
/* arena-data.js declares these at script scope, not on window */
const SOURCES = (typeof MONITOR_SOURCES !== 'undefined') ? MONITOR_SOURCES : null;

/* a MONITOR_SOURCES entry -> the name /composition/monitors answers with.
   'Layers' and 'Groups' are families expanded from the live list; 'Selected
   Clip' has no render target and falls back to the clip thumbnail. */
const SOURCE_TARGET = {
  'Composition': 'Composition',
  'Preview': 'Preview',
  'Crossfader Result': 'Result',
  'Crossfader Bus A': 'Bus A',
  'Crossfader Bus B': 'Bus B',
  'Layer Preview': 'Selected Layer',
  'Group Preview': 'Selected Group',
  'Screen 1': 'Screen 1',
  'Screen 2': 'Screen 2',
};

/* the four monitor names Arena's own component manifest carries, plus the
   Clip Monitor its fold param names */
const SUBJECT = {
  'Composition':   { label: ui('Composition Monitor'), fold: 'Composition Monitor Fold', pick: { type: 'name', name: 'Composition' } },
  'Preview':       { label: 'Preview Monitor',     fold: 'Clip Monitor Fold',        pick: { type: 'name', name: 'Preview' } },
  'Layer':         { label: 'Layer Monitor',       fold: 'Layer Monitor Fold',       pick: { type: 'layer' } },
  'Layer Preview': { label: 'Layer Monitor',       fold: 'Layer Monitor Fold',       pick: { type: 'name', name: 'Selected Layer' } },
  'Group':         { label: 'Group Monitor',       fold: 'Layer Group Monitor Fold', pick: { type: 'name', name: 'Selected Group' } },
  'Group Preview': { label: 'Group Monitor',       fold: 'Layer Group Monitor Fold', pick: { type: 'name', name: 'Selected Group' } },
  'Clip Preview':  { label: 'Clip Monitor',        fold: 'Clip Monitor Fold',        pick: { type: 'clip' } },
};

/* the manual: the widget is not available on the crossfader monitors */
const NO_WIDGET = { 'Result': 1, 'Bus A': 1, 'Bus B': 1 };

const FITS = ['Fit', 'Fill', 'Stretch', '1:1'];   // Arena's own resize vocabulary
const RATES = [0, 1, 2, 5, 10];
const TICK = 100;                                 // poll clock; fps gates inside

/* Arena ships ~60 blend modes, CSS has 16. Only these carry over honestly;
   everything else is drawn source-over and named in the caption. */
const CSS_BLEND = {
  'Alpha': 'normal', 'Add': 'plus-lighter', 'Screen': 'screen', 'Multiply': 'multiply',
  'Darken': 'darken', 'Lighten': 'lighten', 'Difference': 'difference',
  'Exclusion': 'exclusion', 'Overlay': 'overlay', 'Hard Light': 'hard-light',
  'Soft Light': 'soft-light', 'Dodge': 'color-dodge', 'Burn': 'color-burn',
};

/* =========================================================================
   the render-target list, shared by every instance in this document
   ========================================================================= */
const Targets = {
  list: null, err: null, at: 0, busy: false, waiters: [],
  ensure(cb) {
    if (this.list && Date.now() - this.at < 5000) return this.list;
    if (cb) this.waiters.push(cb);
    if (this.busy) return this.list;
    this.busy = true;
    AL.rest('/composition/monitors')
      .then(l => { this.list = Array.isArray(l) ? l : []; this.err = null; })
      .catch(e => { this.err = String((e && e.message) || e); if (!this.list) this.list = []; })
      .then(() => {
        this.busy = false; this.at = Date.now();
        const w = this.waiters; this.waiters = [];
        w.forEach(f => { try { f(); } catch (x) { console.error('monitor', x); } });
      });
    return this.list;
  },
  byName(n) { return (this.list || []).find(t => t.name === n) || null; },
  byObject(p) { return (this.list || []).find(t => t.associated_object === p) || null; },
  family(kind) {
    const re = kind === 'Layers' ? /^\/composition\/layers\/by-id\// : /^\/composition\/layergroups\/by-id\//;
    return (this.list || []).filter(t => re.test(t.associated_object || ''));
  },
};

/* =========================================================================
   stylesheet — injected once per document, tokens only
   ========================================================================= */
(function style() {
  if (document.getElementById('mon-css')) return;
  const s = document.createElement('style');
  s.id = 'mon-css';
  s.textContent = `
.mon-wrap{ display:flex; flex-direction:column; min-width:0; }
.mon-stage{ position:relative; overflow:hidden; min-height:110px; background:var(--inset);
  border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
/* checker_board=1 is Arena's "blocked background" behind transparency */
.mon-stage.chk{ background-image:
  linear-gradient(45deg,var(--n900) 25%,transparent 25%,transparent 75%,var(--n900) 75%),
  linear-gradient(45deg,var(--n900) 25%,transparent 25%,transparent 75%,var(--n900) 75%);
  background-size:16px 16px; background-position:0 0,8px 8px; }
.mon-stage.pan{ cursor:grab; } .mon-stage.panning{ cursor:grabbing; }
/* isolate so an additive layer blends against the picture, not the page */
.mon-frame{ position:absolute; left:0; top:0; isolation:isolate; }
.mon-pic{ position:absolute; inset:0; width:100%; height:100%; display:block;
  opacity:0; transition:opacity .1s linear; }
.mon-pic.on{ opacity:1; }
.mon-lay{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.mon-ov{ position:absolute; inset:0; pointer-events:none; z-index:50; }
.mon-grid{ background-image:
  repeating-linear-gradient(to right,color-mix(in srgb,var(--n100) 38%,transparent) 0 1px,transparent 1px 33.3333%),
  repeating-linear-gradient(to bottom,color-mix(in srgb,var(--n100) 38%,transparent) 0 1px,transparent 1px 33.3333%); }
.mon-safe::before{ content:''; position:absolute; inset:5%;
  border:1px dashed color-mix(in srgb,var(--n100) 42%,transparent); }
.mon-safe::after{ content:'90 %'; position:absolute; left:5%; top:5%; font-size:9px;
  color:var(--n300); background:color-mix(in srgb,var(--color-bg) 70%,transparent); padding:0 3px; }
.mon-wid{ position:absolute; z-index:60; cursor:move; border:1px solid var(--color-accent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--color-accent) 35%,transparent); }
.mon-wid .h{ position:absolute; width:9px; height:9px; background:var(--color-surface);
  border:1px solid var(--color-accent); border-radius:var(--radius-sm); }
.mon-wid .h.br{ right:-5px; bottom:-5px; cursor:nwse-resize; }
.mon-wid.off{ border-style:dashed; border-color:var(--n700); box-shadow:none; cursor:not-allowed; }
.mon-wid.off .h{ border-color:var(--n700); }
.mon-badge{ position:absolute; left:var(--space-2); top:var(--space-2); z-index:70; display:flex;
  gap:var(--space-1); flex-wrap:wrap; pointer-events:none; max-width:calc(100% - var(--space-4)); }
.mon-tag{ font-size:9px; letter-spacing:.06em; text-transform:uppercase; color:var(--n400);
  background:color-mix(in srgb,var(--color-bg) 74%,transparent); border:1px solid var(--n800);
  border-radius:999px; padding:0 6px; white-space:nowrap; }
.mon-tag.on{ color:var(--a200); border-color:var(--color-accent); }
.mon-gap{ position:absolute; inset:0; display:grid; place-items:center; overflow:auto; }
.mon-foot{ border-bottom:0; border-top:1px solid var(--line); }
.mon-foot .sp{ flex:1; }
.mon-foot .btn{ font-size:10px; height:16px; padding:0 6px; display:inline-flex; align-items:center; }
.mon-cap code{ color:var(--n500); font-size:10px; }
.mon-menu{ min-width:224px; }
.mon-menu .dd-item.sub{ padding-left:40px; }
.mon-menu .dd-why{ padding:1px 22px 4px 24px; color:var(--n700); font-size:9.5px;
  white-space:normal; max-width:280px; }
`;
  document.head.appendChild(s);
})();

/* =========================================================================
   model reads
   ========================================================================= */
const compSize = () => {
  const v = (AL.comp || {}).video;
  const w = v ? +AL.val(v.width) : 0, h = v ? +AL.val(v.height) : 0;
  return (w > 0 && h > 0) ? { w, h } : null;
};
const layerName = n => Kit.dispName(AL.val((AL.layer(n) || {}).name), n);
const groupName = n => Kit.dispName(AL.val((AL.groups()[n - 1] || {}).name), n);
const pv = p => (p && p.value != null) ? +p.value : null;

function selectedClip() {
  const ls = AL.layers();
  for (let l = 1; l <= ls.length; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++)
      if (clips[c - 1] && AL.val(clips[c - 1].selected) === true) return { l, c, k: clips[c - 1] };
  }
  return null;
}
function countSelectedClips() {
  let n = 0;
  AL.layers().forEach(L => (L.clips || []).forEach(k => { if (AL.val(k.selected) === true) n++; }));
  return n;
}
/* the first, undeletable Transform of whatever this monitor is looking at */
function transformOf(owner) {
  const fx = ((owner && owner.video && owner.video.effects) || []).find(f => f.name === 'Transform');
  return fx ? fx.params : null;
}

/* =========================================================================
   which picture this instance shows
   ========================================================================= */
function resolve(st) {
  const p = st.pick;
  if (p.type === 'composite') return { kind: 'composite' };
  if (p.type === 'clip') {
    const sel = selectedClip();
    return sel ? { kind: 'clip', sel, title: Kit.dispName(AL.val(sel.k.name), sel.c) }
      : { kind: 'gap', what: 'Selected Clip',
          why: 'No clip is selected in Arena, and this source has no render target of its own.' };
  }
  if (p.type === 'layer') {
    const L = AL.layer(p.n);
    if (!L) return { kind: 'gap', what: 'Layer ' + p.n, why: 'This Show has no layer ' + p.n + '.' };
    const t = L.id != null ? Targets.byObject('/composition/layers/by-id/' + L.id) : null;
    return t ? { kind: 'target', t, owner: L, title: layerName(p.n) }
             : { kind: 'gap', what: layerName(p.n), why: 'Arena lists no render target for this layer.' };
  }
  if (p.type === 'group') {
    const G = AL.groups()[p.n - 1];
    if (!G) return { kind: 'gap', what: 'Group ' + p.n, why: 'This Show has no layer group ' + p.n + '.' };
    const t = (G.id != null && Targets.byObject('/composition/layergroups/by-id/' + G.id)) || Targets.byName(groupName(p.n));
    return t ? { kind: 'target', t, owner: G, title: groupName(p.n) }
             : { kind: 'gap', what: groupName(p.n), why: 'Arena lists no render target for this group.' };
  }
  const t = Targets.byName(p.name);
  if (t) return { kind: 'target', t, owner: ownerFor(p.name), title: ui(p.name) };
  if (p.name === 'Screen 1' || p.name === 'Screen 2')
    return { kind: 'gap', what: ui(p.name), why:
      'SHOWAVE Map is not exposed by Resolume REST (Advanced Output). None of its 258 paths touch screens, slices or warping, and Arena lists no render target by this name.' };
  return { kind: 'gap', what: ui(p.name), why: Targets.err
    ? 'Could not read /composition/monitors: ' + Targets.err
    : 'Arena lists no render target named "' + p.name + '".' };
}
/* whose Transform the widget drives — per the manual, the monitor's subject */
function ownerFor(name) {
  if (name === 'Composition') return AL.comp;
  if (name === 'Selected Layer') return AL.layers().find(L => AL.val(L.selected) === true) || null;
  if (name === 'Selected Group') return AL.groups().find(G => AL.val(G.selected) === true) || null;
  if (name === 'Preview') { const s = selectedClip(); return s ? s.k : null; }
  return null;
}

const snapUrl = t => `http://${AL.host()}/api/v1/composition/monitors/${t.id}/snapshot.jpg?t=`;
const clipUrl = () => `http://${AL.host()}/api/v1/composition/clips/selected/thumbnail?t=`;

/* =========================================================================
   the thumbnail composite
   ========================================================================= */
function compositeLayers() {
  const ls = AL.layers();
  const solo = ls.some(L => AL.val(L.solo) === true);
  const stack = [], dropped = [];
  for (let l = 1; l <= ls.length; l++) {                 // 1..n is bottom-to-top
    const L = ls[l - 1];
    if (AL.val(L.bypassed) === true) continue;
    if (solo && AL.val(L.solo) !== true) continue;
    let c = 0;
    const clips = L.clips || [];
    for (let i = 1; i <= clips.length; i++) if (AL.isPlaying(l, i)) { c = i; break; }
    if (!c) continue;
    const url = AL.thumbUrl(l, c);
    if (!url) continue;
    const raw = String(AL.val(((L.video || {}).mixer || {})['Blend Mode']) || '');
    const half = /^50 /.test(raw);                        // Arena's "50 X" is X at half mix
    const mode = CSS_BLEND[half ? raw.slice(3) : raw];
    if (!mode) dropped.push(raw || 'unnamed');
    const op = (L.video && L.video.opacity ? +AL.val(L.video.opacity) : 1) *
               (L.master ? +AL.val(L.master) : 1) * (half && mode ? 0.5 : 1);
    stack.push({ l, c, url, blend: mode || 'normal', opacity: clamp(op, 0, 1),
                 name: layerName(l), raw, exact: !!mode && !half });
  }
  return { stack, dropped };
}

/* =========================================================================
   one instance
   ========================================================================= */
function makeState(host, node) {
  const subj = String((node && node.subject_type) || 'Composition');
  const def = SUBJECT[subj] || SUBJECT.Composition;
  const idx = (node && node.subject_index != null) ? +node.subject_index : null;
  const pick = Object.assign({}, def.pick);
  if (pick.type === 'layer') pick.n = (idx != null ? idx : 0) + 1;   // layouts count layers from 0
  return {
    subject: subj, def, node, pick, doc: host.ownerDocument || document,
    instance: (node && node.instance != null) ? String(node.instance) : '',
    checker: String((node && node.checker_board) != null ? node.checker_board : '0') === '1',
    showUI: String((node && node.showUI) != null ? node.showUI : '1') !== '0',
    /* the manual: on by default on every monitor but the composition one */
    widget: subj !== 'Composition',
    folded: (WS && WS.param) ? WS.param(def.fold) === true : false,
    blackBG: false, grid: false, safe: false,
    fit: 'Fit', zoom: 1, panX: 0, panY: 0,
    fps: 5, natural: null, front: 0, tickAt: 0,
    menu: null, menuOff: null, timer: null, ro: null,
    sig: '', pics: [], lay: new Map(), stage: null, frame: null, wid: null, wt: null,
  };
}

WS.register('Monitor', {
  title: 'Monitor',
  build(host, node) {
    const st = makeState(host, node);
    host._mon = st;

    /* the one repaint this panel has: Kit.live drives it on every composition
       and status push, and the cog menu calls the very same function so a
       source change lands without waiting for the next push */
    const repaint = () => {
      if (!host.isConnected) return;      // a queued Targets fetch can outlive the panel
      if (AL.status !== 'live') {
        teardownView(st);
        host.innerHTML = Kit.offline('A monitor shows Arena\'s own render output; there is nothing to show until it answers.');
        return;
      }
      Targets.ensure(repaint);
      const res = resolve(st);
      const s = signature(st, res);
      if (s === st.sig && st.stage && st.stage.isConnected) { relayout(st); refresh(st, res); return; }
      st.sig = s;
      closeMenu(st);
      render(host, st, res, node);
      relayout(st);
      refresh(st, res);
    };
    st.repaint = repaint;

    Kit.live(host, repaint, { repaintOnParam: false });

    /* the picture refreshes on its own clock so an open menu, a drag or a
       scroll position survives a new frame */
    st.timer = setInterval(() => {
      if (!host.isConnected || AL.status !== 'live' || st.doc.hidden) return;
      if (!st.stage || !st.stage.offsetParent) return;         // folded or hidden
      refresh(st, resolve(st));
    }, TICK);

    const off = host._panelOff;
    host._panelOff = () => {
      clearInterval(st.timer); st.timer = null;
      teardownView(st);
      if (off) off();
    };
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});

function teardownView(st) {
  if (st.ro) { try { st.ro.disconnect(); } catch {} st.ro = null; }
  closeMenu(st);
  st.stage = st.frame = st.wid = null;
  st.pics = []; st.lay = new Map(); st.sig = '';
}

function signature(st, res) {
  const c = AL.comp || {}, m = compSize();
  return [st.subject, st.pick.type, st.pick.name || '', st.pick.n || '',
    res.kind, (res.t && res.t.id) || '', res.what || '', res.title || '',
    (c.layers || []).length, (c.layergroups || []).length,
    m ? m.w + 'x' + m.h : '', st.folded ? 'F' : '', st.widget ? 'W' : '', st.fps].join('|');
}

/* =========================================================================
   render
   ========================================================================= */
function render(host, st, res, node) {
  const m = compSize();
  const body = `<div class="mon-wrap">
      ${st.showUI ? headBar(st, res) : ''}
      <div class="mon-stage${st.checker && !st.blackBG ? ' chk' : ''}"${
        m ? ` style="aspect-ratio:${m.w}/${m.h}"` : ''}>
        ${res.kind === 'gap'
          ? `<div class="mon-gap">${Kit.unavailable(res.what, res.why)}</div>`
          : '<div class="mon-frame"></div>'}
        <div class="mon-badge">${badges(st, res)}</div>
      </div>
      <div class="p-note mon-cap">${caption(st, res)}</div>
      ${st.showUI ? footBar(st, res) : ''}
    </div>`;

  host.innerHTML = Kit.section(st.def.label, body, {
    folded: st.folded,
    tag: res.kind === 'target' ? ui(res.t.name) : res.kind === 'composite' ? 'composite' : '',
  });
  Kit.wireSections(host);
  /* folding is the workspace's own state; track it so the poll clock and the
     next repaint agree with what the user just did to the header */
  const h4 = host.querySelector('.p-sec > h4');
  if (h4) h4.addEventListener('click', () => { st.folded = h4.parentElement.classList.contains('folded'); });

  st.stage = host.querySelector('.mon-stage');
  st.frame = host.querySelector('.mon-frame');
  st.pics = []; st.lay = new Map(); st.natural = null; st.tickAt = 0;

  if (st.frame) {
    if (res.kind !== 'composite') buildPics(st);
    st.frame.insertAdjacentHTML('beforeend',
      `<div class="mon-ov mon-grid"${st.grid ? '' : ' hidden'}></div>
       <div class="mon-ov mon-safe"${st.safe ? '' : ' hidden'}></div>`);
    if (st.widget) buildWidget(st, res);
  }
  wire(host, st, res, node);

  if (st.stage && typeof ResizeObserver === 'function') {
    if (st.ro) { try { st.ro.disconnect(); } catch {} }
    st.ro = new ResizeObserver(() => relayout(st));
    st.ro.observe(st.stage);
  }
}

function headBar(st, res) {
  const m = compSize();
  const where = res.kind === 'target' ? ui(res.t.name)
              : res.kind === 'clip' ? (res.title || 'Selected Clip')
              : res.kind === 'composite' ? 'Thumbnail composite' : res.what;
  return `<div class="p-toolbar" title="${esc(helpOf('Monitor', 'Monitors'))}">
    <span style="color:var(--n300)">${esc(where)}</span>
    <span class="p-dim" style="margin-left:auto" data-mon-size>${m ? `${m.w} &times; ${m.h}` : ''}</span>
  </div>`;
}

function badges(st, res) {
  const b = [];
  if (res.kind === 'target') b.push(`<span class="mon-tag on" title="${
    esc('GET /api/v1/composition/monitors/' + res.t.id + '/snapshot.jpg')
  }">render target · ${st.fps ? st.fps + ' fps' : 'paused'}</span>`);
  if (res.kind === 'clip') b.push('<span class="mon-tag">clip thumbnail</span>');
  if (res.kind === 'composite') b.push('<span class="mon-tag">thumbnail composite</span>');
  if (st.instance) b.push(`<span class="mon-tag">#${esc(st.instance)}</span>`);
  return b.join('');
}

function caption(st, res) {
  if (res.kind === 'gap') return 'Nothing is polled while this source is unavailable.';
  if (res.kind === 'target')
    return `Arena's real output: a JPEG still of the <b>${esc(ui(res.t.name))}</b> render target${
      ui(res.t.name) === res.t.name ? '' : ` (Resolume <code>${esc(res.t.name)}</code>)`}, polled ` +
      `${st.fps ? st.fps + ' times a second' : '(paused)'} from ` +
      `<code>/composition/monitors/${res.t.id}/snapshot.jpg</code>. It is a sequence of snapshots, ` +
      `not a video stream. A continuous, frame-accurate preview still needs Spout, NDI or Syphon.`;
  if (res.kind === 'clip')
    return `The selected clip's stored thumbnail, from <code>/composition/clips/selected/thumbnail</code>. ` +
      `Arena publishes no render target for a single clip, so this is the frame it last stored for the ` +
      `clip, not live output.`;
  const c = compositeLayers();
  const drop = [...new Set(c.dropped)];
  return `Thumbnail composite: <b>not the GPU output</b>. ${c.stack.length} playing clip ` +
    `${c.stack.length === 1 ? 'thumbnail' : 'thumbnails'} stacked with each layer's own blend mode ` +
    `and opacity. ` +
    (drop.length ? `${drop.length} blend mode${drop.length === 1 ? '' : 's'} ` +
      `(${esc(drop.join(', '))}) ${drop.length === 1 ? 'has' : 'have'} no CSS equivalent and ` +
      `${drop.length === 1 ? 'is' : 'are'} drawn source-over. ` : '') +
    `Effects, masks and the crossfader are not applied. True output preview needs Spout, NDI or Syphon.`;
}

function footBar(st, res) {
  const fits = FITS.map(f => `<button class="btn${f === st.fit ? ' on' : ''}" data-fit="${f}"${
    f === '1:1' ? ' title="Original: one output pixel per screen pixel"' : ''}>${f}</button>`).join('');
  const w = widgetTarget(st, res);
  return `<div class="p-toolbar mon-foot">
    ${fits}
    <span class="sp"></span>
    <button class="btn${st.widget ? ' on' : ''}${w.ok ? '' : ' disabled'}" data-widget
      title="${esc(w.ok ? 'Transform Widget: drag to set Position, the corner to set Scale' : w.why)}">Widget</button>
    <button class="btn" data-cog title="${esc(helpOf('Composition', 'Monitor Options'))}">&#9881;</button>
  </div>`;
}

/* ---- pictures ------------------------------------------------------------ */
function buildPics(st) {
  st.pics = [0, 1].map(() => {
    const i = new Image();
    i.className = 'mon-pic';
    i.crossOrigin = 'anonymous';        // Arena answers ACAO:*; keeps Copy Image possible
    i.decoding = 'async';
    st.frame.appendChild(i);
    return i;
  });
}

function refresh(st, res) {
  if (!st.frame || !st.frame.isConnected) return;
  const now = Date.now();
  if (res.kind === 'composite') {
    if (now - st.tickAt < 250) return;              // thumbnails change rarely
    st.tickAt = now;
    return refreshComposite(st);
  }
  if (res.kind !== 'target' && res.kind !== 'clip') return;
  if (!st.fps || !st.pics.length) return;
  if (now - st.tickAt < 1000 / st.fps) return;
  st.tickAt = now;
  const base = res.kind === 'target' ? snapUrl(res.t) : clipUrl();
  const next = st.pics[st.front ^ 1], cur = st.pics[st.front];
  next.onload = () => {
    if (!next.isConnected) return;
    if (!st.natural && next.naturalWidth) {
      st.natural = { w: next.naturalWidth, h: next.naturalHeight };
      const cell = st.stage && st.stage.parentElement && st.stage.parentElement.querySelector('[data-mon-size]');
      if (cell && !cell.textContent) cell.textContent = `${st.natural.w} × ${st.natural.h}`;
      relayout(st);
    }
    next.classList.add('on'); cur.classList.remove('on');
    st.front ^= 1;
  };
  next.onerror = () => { next.onload = null; };
  next.src = base + now;      // Arena sends no cache headers; the stamp forces a fresh frame
}

function refreshComposite(st) {
  const { stack } = compositeLayers();
  const seen = new Set();
  stack.forEach((s, z) => {
    seen.add(s.l);
    let img = st.lay.get(s.l);
    if (!img) {
      img = new Image();
      img.className = 'mon-lay';
      img.crossOrigin = 'anonymous';
      st.frame.insertBefore(img, st.frame.firstChild);
      st.lay.set(s.l, img);
    }
    if (img.dataset.src !== s.url) { img.dataset.src = s.url; img.src = s.url; }
    img.style.zIndex = z;
    img.style.opacity = s.opacity;
    img.style.mixBlendMode = s.blend;
    img.title = `${s.name}: ${s.raw || 'no blend mode'}${s.exact ? '' : ' (approximated)'} · ${
      Math.round(s.opacity * 100)} %`;
  });
  st.lay.forEach((img, l) => { if (!seen.has(l)) { img.remove(); st.lay.delete(l); } });
}

/* ---- geometry ------------------------------------------------------------ */
const mediaSize = st => compSize() || st.natural || null;

function relayout(st) {
  const stage = st.stage, frame = st.frame;
  if (!stage || !frame || !stage.isConnected) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) return;
  const m = mediaSize(st);
  let w, h;
  if (!m || st.fit === 'Stretch') { w = sw * st.zoom; h = sh * st.zoom; }
  else {
    const k = st.fit === 'Fill' ? Math.max(sw / m.w, sh / m.h)
            : st.fit === '1:1' ? 1
            : Math.min(sw / m.w, sh / m.h);
    w = m.w * k * st.zoom; h = m.h * k * st.zoom;
  }
  frame.style.width = w + 'px'; frame.style.height = h + 'px';
  frame.style.left = ((sw - w) / 2 + st.panX) + 'px';
  frame.style.top = ((sh - h) / 2 + st.panY) + 'px';
  stage.classList.toggle('pan', w > sw + 1 || h > sh + 1);
  layoutWidget(st);
}

/* ---- transform widget ----------------------------------------------------
   The manual: the widget drives the Transform of whatever the monitor shows,
   and is disabled when Rotation X/Y or any Anchor is off default, when more
   than one clip is selected, or on the crossfader monitors. */
function widgetTarget(st, res) {
  if (res.kind === 'gap') return { ok: false, why: 'Nothing is being monitored.' };
  if (res.kind === 'composite')
    return { ok: false, why: 'The composite is assembled here, not in Arena: there is no Transform behind it.' };
  if (res.kind === 'target' && NO_WIDGET[res.t.name])
    return { ok: false, why: 'The Transform Widget is not available on the crossfader monitors.' };
  const owner = res.kind === 'clip' ? res.sel.k : res.owner;
  const t = transformOf(owner);
  if (!t) return { ok: false, why: 'This monitor\'s subject has no Transform to drive.' };
  const off = ['Rotation X', 'Rotation Y', 'Anchor X', 'Anchor Y', 'Anchor Z']
    .some(k => t[k] && Math.abs(pv(t[k]) || 0) > 1e-6);
  if (off || countSelectedClips() > 1)
    return { ok: false, t, owner, why: helpOf('Other', 'Widget is disabled') };
  return { ok: true, t, owner };
}

function buildWidget(st, res) {
  const w = widgetTarget(st, res);
  st.wt = w;
  if (!w.t) { st.wid = null; return; }
  const d = st.doc.createElement('div');
  d.className = 'mon-wid' + (w.ok ? '' : ' off');
  d.title = w.ok ? 'Drag to set Position, the corner to set Scale. Right-click to reset the Transform.' : w.why;
  d.innerHTML = '<span class="h br"></span>';
  st.frame.appendChild(d);
  st.wid = d;
}

/* the subject's bounds in composition pixels, from the Transform's own values.
   Arena documents no sign for Position Y, so it follows the composition
   raster: Y counts downward, the way the snapshot itself is laid out. */
function widgetBox(st) {
  const w = st.wt, m = compSize();
  if (!w || !w.t || !m) return null;
  const t = w.t, owner = w.owner || {};
  const src = (owner.video && owner.video.width) ? owner.video : (AL.comp || {}).video;
  const kw = src ? +AL.val(src.width) : m.w, kh = src ? +AL.val(src.height) : m.h;
  if (!(kw > 0 && kh > 0)) return null;
  const s = (pv(t['Scale']) != null ? pv(t['Scale']) : 100) / 100;
  const sw = (pv(t['Scale W']) != null ? pv(t['Scale W']) : 100) / 100;
  const sh = (pv(t['Scale H']) != null ? pv(t['Scale H']) : 100) / 100;
  return {
    w: kw * s * sw, h: kh * s * sh,
    cx: m.w / 2 + (pv(t['Position X']) || 0),
    cy: m.h / 2 + (pv(t['Position Y']) || 0),
    rz: pv(t['Rotation Z']) || 0,
  };
}
function layoutWidget(st) {
  if (!st.wid || !st.frame) return;
  const m = mediaSize(st), b = widgetBox(st);
  if (!m || !b || !st.frame.clientWidth) { st.wid.hidden = true; return; }
  st.wid.hidden = false;
  const kx = st.frame.clientWidth / m.w, ky = st.frame.clientHeight / m.h;
  st.wid.style.width = (b.w * kx) + 'px';
  st.wid.style.height = (b.h * ky) + 'px';
  st.wid.style.left = ((b.cx - b.w / 2) * kx) + 'px';
  st.wid.style.top = ((b.cy - b.h / 2) * ky) + 'px';
  st.wid.style.transform = b.rz ? `rotate(${b.rz}deg)` : '';
}

/* =========================================================================
   wiring
   ========================================================================= */
function wire(host, st, res, node) {
  host.querySelectorAll('[data-fit]').forEach(b => b.addEventListener('click', () => {
    st.fit = b.dataset.fit; st.zoom = 1; st.panX = st.panY = 0;
    host.querySelectorAll('[data-fit]').forEach(o => o.classList.toggle('on', o === b));
    relayout(st);
  }));
  const wbtn = host.querySelector('[data-widget]');
  if (wbtn) wbtn.addEventListener('click', () => {
    if (!st.widget && !widgetTarget(st, res).ok) return;
    st.widget = !st.widget;
    st.repaint();
  });
  const cog = host.querySelector('[data-cog]');
  if (cog) cog.addEventListener('click', e => { e.stopPropagation(); openMenu(host, st, res, node, cog); });

  const stage = st.stage;
  if (stage) {
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      st.zoom = clamp(st.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.05, 16);
      relayout(st);
    }, { passive: false });
    stage.addEventListener('mousedown', e => {
      if (e.button !== 0 || (st.wid && st.wid.contains(e.target))) return;
      const x0 = e.clientX, y0 = e.clientY, px = st.panX, py = st.panY;
      stage.classList.add('panning');
      const mv = ev => { st.panX = px + (ev.clientX - x0); st.panY = py + (ev.clientY - y0); relayout(st); };
      const up = () => {
        stage.classList.remove('panning');
        removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
  }
  if (st.wid) wireWidget(st);
}

function wireWidget(st) {
  const d = st.wid, w = st.wt;
  if (!d || !w || !w.ok) return;
  const t = w.t;
  d.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const m = mediaSize(st), b = widgetBox(st);
    if (!m || !b || !st.frame.clientWidth) return;
    const kx = m.w / st.frame.clientWidth, ky = m.h / st.frame.clientHeight;
    const corner = e.target.classList.contains('br');
    const x0 = e.clientX, y0 = e.clientY;
    const p0x = pv(t['Position X']) || 0, p0y = pv(t['Position Y']) || 0;
    const s0 = pv(t['Scale']) != null ? pv(t['Scale']) : 100;
    const mv = ev => {
      const dx = (ev.clientX - x0) * kx, dy = (ev.clientY - y0) * ky;
      if (corner) {
        if (!b.w || !t['Scale']) return;
        const lo = t['Scale'].min != null ? t['Scale'].min : 0;
        const hi = t['Scale'].max != null ? t['Scale'].max : 1000;
        AL.setParam(t['Scale'].id, clamp(s0 * (1 + (dx * 2) / b.w), lo, hi));
      } else {
        if (t['Position X']) AL.setParam(t['Position X'].id, p0x + dx);
        if (t['Position Y']) AL.setParam(t['Position Y'].id, p0y + dy);
      }
      layoutWidget(st);
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
  /* the manual's right-click option: reset all transformations */
  d.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    Object.values(t).forEach(p => { if (p && p.id != null) AL.resetParam(p.id); });
    setTimeout(() => layoutWidget(st), 150);
  });
}

/* =========================================================================
   cog menu — Arena's CTX_MONITOR, plus this panel's own view controls
   ========================================================================= */
function closeMenu(st) {
  if (st.menu) { try { st.menu.remove(); } catch {} st.menu = null; }
  if (st.menuOff) { st.doc.removeEventListener('mousedown', st.menuOff, true); st.menuOff = null; }
}

function item(label, o) {
  o = o || {};
  return `<div class="dd-item${o.disabled ? ' disabled' : ''}${o.sub ? ' sub' : ''}"${
    o.act ? ` data-act="${esc(o.act)}"` : ''}${o.arg != null ? ` data-arg="${esc(o.arg)}"` : ''}${
    o.title ? ` title="${esc(o.title)}"` : ''}><span class="chk">${o.on ? '✓' : ''}</span>${
    esc(label)}${o.note ? `<span class="kbd">${esc(o.note)}</span>` : ''}</div>` +
    (o.why ? `<div class="dd-why">${esc(o.why)}</div>` : '');
}
const SEP = '<div class="dd-sep"></div>';

/* index a family render target back to its 1-based position in the model */
function famIndex(kind, t) {
  const id = (/by-id\/(\d+)/.exec(t.associated_object || '') || [])[1];
  if (!id) return 0;
  const arr = kind === 'Layers' ? AL.layers() : AL.groups();
  return arr.findIndex(x => String(x.id) === id) + 1;
}

function sourceRows(st) {
  if (!SOURCES)
    return '<div class="dd-why">arena-data.js is not loaded, so Arena\'s decoded source list is unavailable.</div>';
  const cur = st.pick, rows = [];
  SOURCES.forEach(name => {
    if (name === 'Layers' || name === 'Groups') {
      const fam = Targets.family(name);
      if (!fam.length) {
        rows.push(item(name, { disabled: true, why: name === 'Layers'
          ? 'Arena lists no per-layer render targets.'
          : 'This Show has no layer groups, so Arena lists no group render targets.' }));
        return;
      }
      rows.push(item(name, { disabled: true }));
      fam.forEach(t => {
        const n = famIndex(name, t);
        if (n < 1) { rows.push(item(ui(t.name), { disabled: true, sub: true, why: 'No object in the Show matches this render target.' })); return; }
        const want = name === 'Layers' ? 'layer' : 'group';
        rows.push(item(name === 'Layers' ? layerName(n) : groupName(n), {
          on: cur.type === want && cur.n === n, sub: true,
          act: want === 'layer' ? 'pickLayer' : 'pickGroup', arg: n, note: ui(t.name) }));
      });
      return;
    }
    if (name === 'Selected Clip') {
      rows.push(item(name, { on: cur.type === 'clip', act: 'pickClip', note: 'thumbnail',
        title: 'Arena publishes no render target for a single clip; this reads /composition/clips/selected/thumbnail.' }));
      return;
    }
    const tn = SOURCE_TARGET[name];
    const t = tn ? Targets.byName(tn) : null;
    if (!t) {
      rows.push(item(ui(name), { disabled: true, why: (name === 'Screen 1' || name === 'Screen 2')
        ? 'SHOWAVE Map is not exposed by Resolume REST (Advanced Output), and Arena lists no render target by this name.'
        : 'Arena lists no render target named "' + tn + '".' }));
      return;
    }
    rows.push(item(ui(name), { on: cur.type === 'name' && cur.name === tn, act: 'pickName', arg: tn, note: ui(t.name) }));
  });
  return rows.join('');
}

function openMenu(host, st, res, node, anchor) {
  closeMenu(st);
  const doc = st.doc;
  const menu = doc.createElement('div');
  menu.className = 'dropdown mon-menu';
  const w = widgetTarget(st, res);
  const inPop = !!(node && node.uid === 'pop');

  menu.innerHTML =
    item(st.def.label, { disabled: true, note: st.instance ? '#' + st.instance : '' }) +
    SEP +
    item('Grid overlay', { on: st.grid, act: 'grid', note: 'thirds' }) +
    item('Safe area', { on: st.safe, act: 'safe', note: '90 %' }) +
    item('Reset view', { act: 'reset' }) +
    SEP +
    item('Render target snapshot', { on: st.pick.type !== 'composite', act: 'modeTarget',
      title: 'Poll /composition/monitors/<id>/snapshot.jpg: Arena\'s real output, one still at a time.' }) +
    item('Thumbnail composite', { on: st.pick.type === 'composite', act: 'modeComposite',
      title: 'Stack the playing clips\' thumbnails with each layer\'s blend mode and opacity. Not the GPU output.' }) +
    RATES.map(r => item(r ? r + ' fps' : 'Paused', { on: st.fps === r, sub: true, act: 'fps', arg: r })).join('') +
    SEP +
    sourceRows(st) +
    SEP +
    item('Transform Widget', { on: st.widget, act: 'widget', disabled: !w.ok && !st.widget,
      why: w.ok ? '' : w.why }) +
    item('Black BG', { on: st.blackBG, act: 'black',
      title: 'Arena: keep the blocked background, or go fully black instead.' }) +
    SEP +
    item('Copy Image', { act: 'copy', disabled: st.pick.type === 'composite',
      why: st.pick.type === 'composite' ? 'The composite is many blended images, not one frame.' : '' }) +
    item('Monitor Setup', { disabled: true, title: helpOf('Monitor', 'Monitor Setup'),
      why: 'How many monitors there are and where they sit is the workspace layout: change it from the Layout selector or View > Panels.' }) +
    /* layouts.htm, Multiple Monitors: "right click on an existing monitor and
       press duplicate ... Press the cogwheel at the bottom-right of a monitor to
       change what you want to monitor." That is Resolume's projector: a second
       monitor, pointed at a different surface, undockable to its own window.
       This row was disabled with "its engine has no duplicate operation" — the
       engine has one now (Workspace.duplicate), so the row does its job.
       Still honestly disabled in a popout: a duplicate is placed beside its
       original in the layout tree, and an undocked panel is not in the tree. */
    item('Duplicate Monitor', { act: 'duplicate', disabled: inPop || !(WS && WS.duplicate),
      why: inPop
        ? 'This panel is undocked, so it is not in the layout tree and has nothing to sit beside. Duplicate it from the docked monitor.'
        : (!(WS && WS.duplicate) ? 'workspace.js does not expose a duplicate operation.' : ''),
      title: 'A second monitor beside this one: give it its own subject with the cogwheel, '
           + 'then Undock Panel to put it on another screen. [layouts.htm]' }) +
    item('Undock Panel', { act: 'undock', disabled: inPop, why: inPop ? 'This panel is already undocked.' : '' });

  doc.body.appendChild(menu);
  st.menu = menu;
  const r = anchor.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
  const mh = menu.offsetHeight;
  menu.style.left = clamp(r.right - menu.offsetWidth, 4, Math.max(4, vw - menu.offsetWidth - 4)) + 'px';
  menu.style.top = (r.top - 6 - mh >= 4 ? r.top - 6 - mh : clamp(r.bottom + 6, 4, Math.max(4, vh - mh - 4))) + 'px';

  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('click', e => {
    const row = e.target.closest('.dd-item[data-act]');
    if (!row || row.classList.contains('disabled')) return;
    act(host, st, node, row.dataset.act, row.dataset.arg);
  });
  st.menuOff = () => closeMenu(st);
  setTimeout(() => doc.addEventListener('mousedown', st.menuOff, true), 0);
}

function act(host, st, node, what, arg) {
  const again = () => { closeMenu(st); st.repaint(); };
  switch (what) {
    case 'grid': st.grid = !st.grid; toggleOv(host, '.mon-grid', st.grid); closeMenu(st); return;
    case 'safe': st.safe = !st.safe; toggleOv(host, '.mon-safe', st.safe); closeMenu(st); return;
    case 'reset':
      st.zoom = 1; st.panX = st.panY = 0; st.fit = 'Fit';
      host.querySelectorAll('[data-fit]').forEach(o => o.classList.toggle('on', o.dataset.fit === 'Fit'));
      relayout(st); closeMenu(st); return;
    case 'fps': st.fps = +arg; st.tickAt = 0; return again();
    case 'modeTarget': st.pick = defaultPick(st); return again();
    case 'modeComposite': st.pick = { type: 'composite' }; return again();
    case 'pickName': st.pick = { type: 'name', name: arg }; return again();
    case 'pickLayer': st.pick = { type: 'layer', n: +arg }; return again();
    case 'pickGroup': st.pick = { type: 'group', n: +arg }; return again();
    case 'pickClip': st.pick = { type: 'clip' }; return again();
    case 'widget': st.widget = !st.widget; return again();
    case 'black':
      st.blackBG = !st.blackBG;
      if (st.stage) st.stage.classList.toggle('chk', st.checker && !st.blackBG);
      closeMenu(st); return;
    case 'copy': copyImage(st); closeMenu(st); return;
    case 'undock': closeMenu(st); if (WS && WS.undock && node) WS.undock(node); return;
    /* The duplicate opens on Composition rather than inheriting this monitor's
       subject: two monitors showing the same thing is the one arrangement
       nobody duplicates in order to get, and layouts.htm's next sentence is
       "press the cogwheel ... to change what you want to monitor". */
    case 'duplicate': {
      closeMenu(st);
      if (!(WS && WS.duplicate) || !node) return;
      /* A refusal has to be visible. PanelKit has no toast, so the failure is
         reported where a panel's failures already go rather than through an
         API that does not exist — a `Kit.toast &&` guard would have swallowed
         this silently, which is the same dead control in a smaller costume. */
      if (!WS.duplicate(node))
        console.warn('Monitor: the layout tree would not take a duplicate of', node.uid);
      return;
    }
  }
}

function defaultPick(st) {
  const p = Object.assign({}, (SUBJECT[st.subject] || SUBJECT.Composition).pick);
  if (p.type === 'layer')
    p.n = st.pick.type === 'layer' ? st.pick.n
      : (((st.node && st.node.subject_index != null) ? +st.node.subject_index : 0) + 1);
  return p;
}
function toggleOv(host, sel, on) {
  const e = host.querySelector(sel);
  if (e) e.hidden = !on;
}

/* Arena's own Copy Image, from the cogwheel */
function copyImage(st) {
  const img = st.pics[st.front];
  if (!img || !img.naturalWidth) return;
  try {
    const c = st.doc.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    c.toBlob(b => {
      if (!b || !navigator.clipboard || !window.ClipboardItem) return;
      navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])
        .catch(e => console.warn('monitor: copy image', e));
    }, 'image/png');
  } catch (e) { console.warn('monitor: copy image', e); }
}
})();
