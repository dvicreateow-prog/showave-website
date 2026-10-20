/* ===========================================================================
   advanced-output.js — the Advanced Output editor.
   ---------------------------------------------------------------------------
   The one surface Arena's REST API carries nothing of. Verified again this
   session against the running 7.27.1 rev 15990: no path under /composition
   mentions screen, slice, warp, dmx or lumiverse, and the composition Arena
   pushes has no such keys. So this editor does not drive Arena — it is a real
   editor over the same model, read from and written back to the same file:

     Preferences/AdvancedOutput.xml

   whose structure is decoded into extracted/arena-advanced-output.json and
   embedded in every saved composition:

     ScreenSetup
       CurrentCompositionTextureSize
       Screen | DmxScreen          (LumiverseId, Auto Span, Align Output)
         guides    ScreenGuide type 0 = vertical, 1 = horizontal
         layers
           Slice | DmxSlice
             InputRect   4+ vertices — the region taken from the composition
             OutputRect  4+ vertices — where it lands on the device
             Warper
               BezierWarper   controlWidth × controlHeight grid
               Homography     src 4 → dst 4
             SoftEdgeGroup
             FixtureInstance → Fixture (uuid)          (DMX only)
         OutputDevice → OutputDeviceVirtual | OutputDeviceDmx
       SoftEdging   Soft Edge Power

   Everything below is that model, an editor for it, and an XML writer that
   produces a file Arena reads back.
   =========================================================================== */
window.AdvancedOutput = (() => {
'use strict';

const AL = window.ArenaLive, WS = window.Workspace;
const RA = () => (window.RESOLUME || {}).arena || {};

/* ===========================================================================
   THE COMPOSITION THIS WINDOW IS SLICING
   This page is a separate document, so it cannot reach the engine in the main
   window. arena-bus.js carries a snapshot across: the composition texture size
   and every layer and group a slice can be routed to. With no host running the
   page still works — it just has the composition as its only input, and says so.
   =========================================================================== */
const BUS = window.ArenaBus || null;
const SOURCE_CLIENT_ID = 'advanced-output-legacy:' +
  (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
if(BUS) addEventListener('pagehide', () => {
  try { BUS.send({ op:'needSources', clientId:SOURCE_CLIENT_ID, intent:'idle', sources:[] }); }
  catch(e){}
});
let COMP = (BUS && BUS.snapshot) || null;

/* Editors mounted in this document.

   The snapshot arrives here, at module scope, but everything that can repaint —
   draw(), side_render(), tree_render() — is declared inside mount(). That gap
   used to be bridged by `if(typeof side === 'function') side()`, which was
   false twice over: `side` is a DOM element rather than a function, and neither
   name is in scope out here. Both guards were permanently false, so a snapshot
   arrived and changed nothing on screen — a new layer never appeared in the
   Input Source list, and a resized composition was never noticed. */
const MOUNTED = [];

if(BUS) BUS.onSnapshot(snap => {
  const resized = !COMP || COMP.width !== snap.width || COMP.height !== snap.height;
  COMP = snap;
  MOUNTED.forEach(m => {
    /* advanced-output.htm: the Advanced Output slices the composition's own
       texture, so the composition texture *is* the composition's resolution,
       not a private setting of this window. The snapshot has always carried
       the right number; nothing ever read it, which is how this window came to
       show 1600×1200 while the composition was 1920×1080. */
    if(resized && snap.width && snap.height) m.setCompositionTexture(snap.width, snap.height);
    m.refresh();
  });
});
/* Frames of each source the slices here are routed to.

   slice-routing.htm: "By default, slices take the complete Resolume
   composition as input... Every individual layer is also available." This
   window is a separate document and cannot reach the composition's canvases,
   so the host renders each source it is told is in use and sends a frame. Until
   now there was nothing to send and nothing asking, so every slice sampled the
   same synthetic checkerboard whatever its Input Source said. */
const SOURCE_IMG  = new Map();   // id -> a canvas at composition-texture size
const SOURCE_LAST = new Map();   // id -> last data URL, so we decode each once

if(BUS) BUS.onFrames(data => {
  for(const id in data){
    const url = data[id];
    if(typeof ImageBitmap !== 'undefined' && url instanceof ImageBitmap){
      const previous = SOURCE_IMG.get(id);
      SOURCE_IMG.set(id, url);
      SOURCE_LAST.delete(id);
      try { if(previous && previous !== url && previous.close) previous.close(); } catch(e){}
      MOUNTED.forEach(m => m.repaint());
      continue;
    }
    if(SOURCE_LAST.get(id) === url) continue;
    SOURCE_LAST.set(id, url);
    const img = new Image();
    img.onload = () => {
      /* The host sends a monitor-sized frame, but texTri() samples with
         InputRect coordinates — composition pixels — and draws the source at
         its natural size. Handed the small frame directly, a routed slice
         painted only the top-left corner of its input rect at full scale. It
         went unnoticed because the ed.texture fallback is built at composition
         size and therefore lined up.

         Rasterising to composition-texture size here fixes it in one place,
         rather than threading a scale factor through the sampling maths. */
      const cw = (COMP && COMP.width)  || 1920;
      const ch = (COMP && COMP.height) || 1080;
      let c = SOURCE_IMG.get(id);
      if(c && c.close){ try { c.close(); } catch(e){} c = null; }
      if(!c || c.tagName !== 'CANVAS'){ c = document.createElement('canvas'); }
      if(c.width !== cw || c.height !== ch){ c.width = cw; c.height = ch; }
      const g2 = c.getContext('2d');
      g2.clearRect(0, 0, cw, ch);
      g2.drawImage(img, 0, 0, cw, ch);
      SOURCE_IMG.set(id, c);
      MOUNTED.forEach(m => m.repaint());
    };
    img.src = url;
  }
});
/* An unrouted slice takes the composition, which is what the manual means by
   "by default". */
function sourceImage(id){ return SOURCE_IMG.get(id || 'composition') || null; }

if(BUS) BUS.hello();

/* One place that turns a chosen device label into a device record, so the
   context menu and the inspector cannot disagree about what a Display is. The
   class comes from the catalogue rather than from a regex over the label. */
/* The Connected Outputs group, from the machine rather than from a literal.
   `arena-data.js` used to ship three invented displays; a screen assigned to
   "Display 3 — 3840 x 2160" was assigned to nothing at all.

   openlive-displays.js is careful about the difference between "there is one
   display" and "there are more but the window-management permission has not
   been granted", and it marks the latter `blocked` with a reason. That
   distinction is kept here: a display we cannot measure is shown and disabled,
   because assigning a screen to it would position the output by guesswork. */
function connectedOutputs(){
  const D = window.OpenLiveDisplays;
  if(!D) return null;
  return D.list().map(d => ({
    label: d.label, deviceId: d.id, kind: 'OutputDeviceDisplay',
    width: d.width, height: d.height, blocked: !!d.blocked, reason: d.reason || ''
  }));
}
function deviceGroups(){
  const real = connectedOutputs();
  return V.devices.map(g => {
    if(g.group === 'Connected Outputs' && real && real.length)
      return Object.assign({}, g, {items: real});
    /* arena-data.js used to carry three invented displays and three invented
       playback cards, so neither group was ever empty and neither ever had to
       explain itself. They are empty now unless real hardware fills them, and a
       group that renders as a blank strip reads as a fault. Say what it is:
       a browser cannot see an SDI card at all, so Playback Cards stays empty on
       every machine. */
    if(!g.items || !g.items.length)
      return Object.assign({}, g, {items: [{
        label: g.group === 'Playback Cards'
          ? 'No playback card: a browser cannot see one (Arena only)'
          : 'No output reported by the operating system',
        disabled: true, blocked: true,
        reason: g.group === 'Playback Cards'
          ? 'Blackmagic / Datapath / AJA playback output needs a native driver. [screens.htm]'
          : 'screens.htm: "Resolume itself does not create outputs. This is handled by your computer."'
      }]});
    return g;
  });
}
function deviceLookup(){
  const m = new Map(V.deviceByLabel);
  (connectedOutputs() || []).forEach(d => m.set(d.label, d));
  return m;
}

function deviceFor(label, prev){
  const d = deviceLookup().get(label);
  const keep = prev || {};
  if(!d) return { name: label, deviceId: label, idHash: '',
                  kind: 'OutputDeviceVirtual',
                  width: keep.width || 1920, height: keep.height || 1080 };
  return { name: label, deviceId: d.deviceId, idHash: '',
           kind: d.kind,
           width:  d.width  == null ? (keep.width  || 1920) : d.width,
           height: d.height == null ? (keep.height || 1080) : d.height };
}

function inputSources(){
  if(COMP && COMP.sources && COMP.sources.length) return COMP.sources;
  return [{id:'composition', label:'Show', kind:'composition'}];
}
/* Arena's Input Source dropdown is grouped, in this order: Screens,
   Composition, CrossFader, Groups, Layers (slice-routing.htm). It was a flat
   list of whatever the host happened to send, with no Screens and no
   CrossFader at all. Screens come from this window's own model, because the
   composition has never heard of them. */
const SOURCE_GROUPS = [
  ['screen',      'Screens'],
  ['composition', 'Show'],
  ['crossfader',  'CrossFader'],
  ['group',       'Groups'],
  ['layer',       'Layers']
];
function inputSourceOptions(sel, model){
  const all = inputSources().slice();
  (model && model.screens || []).forEach((sc, i) =>
    all.push({id:'screen:' + i, label: sc.name || ('Screen ' + (i+1)), kind:'screen'}));

  return SOURCE_GROUPS.map(([kind, label]) => {
    const items = all.filter(o => o.kind === kind);
    if(!items.length) return '';
    return `<optgroup label="${esc(label)}">` + items.map(o =>
      `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${
        esc(o.label)}${o.kind === 'layer' && o.playing ? ': ' + esc(o.playing) : ''}</option>`
    ).join('') + '</optgroup>';
  }).join('');
}
const esc = s => String(s ?? '').replace(/[<>&"]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* =========================================================================
   canvas palette
   -------------------------------------------------------------------------
   The stage is a canvas, so it cannot inherit the stylesheet — but it must
   not fall out of the theme either. Every colour it draws with is read from
   the same custom properties the chrome around it uses, cached on first draw
   and cleared when the theme changes. The fallbacks are the Nocturne values,
   so the editor still draws in the right key if the stylesheet is missing.
   ========================================================================= */
const FONT = '"Inter", system-ui, "Segoe UI", sans-serif';
/* the tokens are 6-digit hex, so alpha is two more digits on the end */
const withA = (hex, aa) => /^#[0-9a-f]{6}$/i.test(hex) ? hex + aa : hex;
let PAL_CACHE = null;
function PAL() {
  if (PAL_CACHE) return PAL_CACHE;
  const cs = getComputedStyle(document.documentElement);
  const t = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return (PAL_CACHE = {
    void:     t('--color-bg', '#161826'),      // the room around the device
    surface:  t('--color-surface', '#232532'),
    inset:    t('--inset', '#12141f'),         // inside the device rectangle
    edge:     t('--n800', '#3f424d'),          // hairline edges, pane splits
    dim:      t('--n700', '#595d6c'),          // guides, unselected outlines
    label:    t('--n500', '#9397ab'),          // pane captions, slice numbers
    labelOn:  t('--a200', '#e7e5fe'),
    text:     t('--n200', '#e4e7f5'),
    hi:       t('--n100', '#f3f5fe'),          // the handle under the cursor
    accent:   t('--color-accent', '#9184d9'),
    accentHi: t('--a400', '#b5abfc'),
    mask:     t('--red', '#cf8080'),           // mask slices, calibration marks
    dmx:      t('--amber', '#d9b980'),         // DMX slices
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { PAL_CACHE = null; });
addEventListener('openlive:appearancechange', () => {
  PAL_CACHE = null;
  MOUNTED.forEach(editor => editor.refresh());
});

/* the application's own menus, so nothing here is invented vocabulary */
const V = {
  tools:  typeof AO_SLICE_TOOLS     !== 'undefined' ? AO_SLICE_TOOLS     : ['Transform', 'Edit Points', 'Draw'],
  stages: typeof AO_STAGES          !== 'undefined' ? AO_STAGES          : ['Input Selection', 'Output Transformation'],
  add:    typeof AO_ADD_MENU        !== 'undefined' ? AO_ADD_MENU        : [],
  screen: typeof AO_NEW_SCREEN      !== 'undefined' ? AO_NEW_SCREEN      : [],
  ctx:    typeof AO_SLICE_CTX       !== 'undefined' ? AO_SLICE_CTX       : [],
  screenCtx: typeof AO_SCREEN_CTX   !== 'undefined' ? AO_SCREEN_CTX      : [],
  devices:typeof AO_OUTPUT_DEVICES  !== 'undefined' ? AO_OUTPUT_DEVICES  : [],
  deviceByLabel:typeof AO_DEVICE_BY_LABEL !== 'undefined' ? AO_DEVICE_BY_LABEL : new Map(),
  viewOpt:typeof AO_VIEW_OPTIONS    !== 'undefined' ? AO_VIEW_OPTIONS    : [],
  preset: typeof AO_PRESET_MENU     !== 'undefined' ? AO_PRESET_MENU     : [],
  filter: typeof AO_FILTER_MODES    !== 'undefined' ? AO_FILTER_MODES    : ['Nearest', 'Linear'],
  warp:   typeof AO_WARP_MODES      !== 'undefined' ? AO_WARP_MODES      : ['Transform', 'Perspective', 'Bezier', 'Linear Grid'],
  space:  typeof DMX_COLOR_SPACES   !== 'undefined' ? DMX_COLOR_SPACES   : [],
  extra:  typeof DMX_EXTRA_CHANNELS !== 'undefined' ? DMX_EXTRA_CHANNELS : [],
  lumi:   typeof LUMIVERSES         !== 'undefined' ? LUMIVERSES         : [],
};
/* the stage the manual calls "Input Selection" is this editor's input view,
   "Output Transformation" its output view */
const STAGE_VIEW = { 'Input Selection': 'input', 'Output Transformation': 'output' };
const VIEW_STAGE = { input: 'Input Selection', output: 'Output Transformation', both: 'Both' };

/* =========================================================================
   geometry
   ========================================================================= */
const P = (x, y) => ({ x: +x || 0, y: +y || 0 });
const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* vertices run TL, TR, BR, BL — the order the decoded file stores them in */
function quadLerp(v, u, t) {
  const top = lerp(v[0], v[1], u), bot = lerp(v[3], v[2], u);
  return lerp(top, bot, t);
}

/* Heckbert's unit-square → quad projective map. Bilinear interpolation is not
   the same thing once a slice is keystoned, and keystoning is the entire point
   of Perspective, so this is worth doing properly. */
function unitToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return { a: p1.x - p0.x, b: p3.x - p0.x, c: p0.x,
             d: p1.y - p0.y, e: p3.y - p0.y, f: p0.y, g: 0, h: 0 };
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9)
    return { a: p1.x - p0.x, b: p3.x - p0.x, c: p0.x,
             d: p1.y - p0.y, e: p3.y - p0.y, f: p0.y, g: 0, h: 0 };
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y, g, h,
  };
}
function applyH(m, u, v) {
  const w = m.g * u + m.h * v + 1 || 1e-9;
  return P((m.a * u + m.b * v + m.c) / w, (m.d * u + m.e * v + m.f) / w);
}

/* tensor-product Bézier of degree (cw-1, ch-1) — a 4×4 grid is the bicubic
   patch Arena's BezierWarper stores, but the file allows any grid size */
function binom(n, i) { let c = 1; for (let k = 0; k < i; k++) c = c * (n - k) / (k + 1); return c; }
const BERN = new Map();
function bern(n, i, t) {
  const key = n * 100 + i;
  let c = BERN.get(key);
  if (c === undefined) { c = binom(n, i); BERN.set(key, c); }
  return c * Math.pow(t, i) * Math.pow(1 - t, n - i);
}
function patchPoint(ctrl, cw, ch, u, v) {
  let x = 0, y = 0;
  for (let j = 0; j < ch; j++) {
    const bv = bern(ch - 1, j, v);
    if (!bv) continue;
    for (let i = 0; i < cw; i++) {
      const w = bern(cw - 1, i, u) * bv;
      if (!w) continue;
      const p = ctrl[j * cw + i];
      if (!p) continue;
      x += p.x * w; y += p.y * w;
    }
  }
  return P(x, y);
}
/* Linear Grid is the same control net read as bilinear patches rather than as
   one smooth surface — the cell the sample falls in, interpolated */
function gridPoint(ctrl, cw, ch, u, v) {
  const gx = clamp(u, 0, 0.999999) * (cw - 1), gy = clamp(v, 0, 0.999999) * (ch - 1);
  const i = Math.floor(gx), j = Math.floor(gy), fu = gx - i, fv = gy - j;
  const at = (a, b) => ctrl[clamp(b, 0, ch - 1) * cw + clamp(a, 0, cw - 1)] || P(0, 0);
  return lerp(lerp(at(i, j), at(i + 1, j), fu), lerp(at(i, j + 1), at(i + 1, j + 1), fu), fv);
}

const polyBounds = v => v.reduce((r, p) => ({
  x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y),
  x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y),
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

function pointInPoly(pt, v) {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const a = v[i], b = v[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < (b.x - a.x) * (pt.y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

/* regular polygon inscribed in a box, first vertex at the top */
function regular(n, box, rotate) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const rx = (box.x1 - box.x0) / 2, ry = (box.y1 - box.y0) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (rotate || -Math.PI / 2) + i * 2 * Math.PI / n;
    out.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return out;
}

/* =========================================================================
   model
   ========================================================================= */
let uid = Date.now();
const nextId = () => String(++uid);

function defaultWarper(rect) {
  const b = polyBounds(rect), cw = 4, ch = 4, verts = [];
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++)
      verts.push(P(b.x0 + (b.x1 - b.x0) * i / (cw - 1), b.y0 + (b.y1 - b.y0) * j / (ch - 1)));
  return {
    bezier: { controlWidth: cw, controlHeight: ch, vertices: verts },
    homography: { src: rect.slice(0, 4).map(p => P(p.x, p.y)), dst: rect.slice(0, 4).map(p => P(p.x, p.y)) },
  };
}

function newSlice(kind, screen, box) {
  const dev = screen.outputDevice || {};
  const w = +dev.width || 1920, h = +dev.height || 1080;
  const b = box || { x0: w * 0.15, y0: h * 0.15, x1: w * 0.85, y1: h * 0.85 };
  const rect = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
  let verts = rect;
  if (kind === 'Triangle Slice' || kind === 'Triangle Mask') verts = regular(3, b);
  if (kind === 'Polygon Slice' || kind === 'Polygon Mask')   verts = regular(6, b);
  if (kind === 'Circle Mask')                                verts = regular(24, b);
  if (kind === 'Hexagon Mask')                               verts = regular(6, b);
  if (kind === 'Love Mask')                                  verts = heart(b);

  const mask = /Mask$/.test(kind);
  const dmx  = kind === 'DMX Fixture';
  return {
    type: dmx ? 'DmxSlice' : 'Slice',
    kind, mask, uniqueId: nextId(),
    name: kind, enabled: true, selected: false,
    softEdgeEnable: false, warpMode: 'Transform', filterMode: 'Linear',
    opacity: 1,
    /* slice-routing.htm — a slice takes the whole composition unless told
       otherwise, and a routed layer can ignore that layer's own opacity and
       its Bypass/Solo state. */
    inputSource: 'composition', ignoreOpacity: false, ignoreBypass: false,
    InputRect:  { orientation: '0', vertices: verts.map(p => P(p.x, p.y)) },
    OutputRect: { orientation: '0', vertices: verts.map(p => P(p.x, p.y)) },
    warper: defaultWarper(verts),
    fixture: dmx ? { uuid: '', fixtureName: '', colorSpace: 'RGB', pixels: 16 } : null,
  };
}
function heart(b) {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = (b.x1 - b.x0) / 32, ry = (b.y1 - b.y0) / 32;
  const out = [];
  for (let i = 0; i < 32; i++) {
    const t = i * 2 * Math.PI / 32;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    out.push(P(cx + x * rx, cy + y * ry));
  }
  return out;
}

function newScreen(kind) {
  const dmx = kind === 'DMX Lumiverse';
  const s = {
    type: dmx ? 'DmxScreen' : 'Screen',
    name: dmx ? 'Lumiverse 1' : (kind === 'Virtual Output' ? 'Virtual Output' : 'Screen'),
    uniqueId: nextId(),
    lumiverseId: dmx ? '0' : null,
    enabled: true,
    autoSpan: true, alignOutput: true,
    guides: [{ name: 'ScreenGuide', type: '0' }, { name: 'ScreenGuide', type: '1' }],
    layers: [],
    outputDevice: dmx
      ? { name: 'Lumiverse', deviceId: 'Lumiverse', kind: 'OutputDeviceDmx', width: 1920, height: 1080 }
      : { name: 'Virtual', deviceId: 'Virtual', kind: 'OutputDeviceVirtual', width: 1920, height: 1080 },
  };
  s.layers.push(newSlice(dmx ? 'DMX Fixture' : 'Slice', s));
  return s;
}

/* read the decoded AdvancedOutput.xml into the editor's own shape */
function fromDecoded(d) {
  if (!d || !d.screens) return null;
  const pv = (o, group, key, dflt) => {
    const g = o && o.params && o.params[group];
    const p = g && g[key];
    return p && p.value != null ? p.value : dflt;
  };
  const model = {
    compositionTexture: {
      width:  +((d.compositionTexture || {}).width)  || 1920,
      height: +((d.compositionTexture || {}).height) || 1080,
    },
    softEdgePower: +(((d.softEdging || {})['Soft Edge'] || {}).Power || {}).value || 2,
    screens: d.screens.map(s => ({
      type: s.type, name: s.name, uniqueId: s.uniqueId || nextId(),
      lumiverseId: s.lumiverseId, enabled: true,
      autoSpan:    pv(s, 'Params', 'Auto Span', '1') === '1',
      alignOutput: pv(s, 'Params', 'Align Output', '1') === '1',
      guides: (s.guides || []).map(g => ({ name: g.name, type: g.type })),
      outputDevice: Object.assign({ width: 1920, height: 1080 }, s.outputDevice || {}),
      layers: (s.layers || []).map(l => {
        const inV  = ((l.InputRect  || {}).vertices || []).map(p => P(p.x, p.y));
        const outV = ((l.OutputRect || {}).vertices || []).map(p => P(p.x, p.y));
        const verts = outV.length ? outV : inV;
        return {
          type: l.type,
          kind: l.type === 'DmxSlice' ? 'DMX Fixture' : 'Slice',
          mask: false,
          uniqueId: l.uniqueId || nextId(),
          name: pv(l, 'Common', 'Name', l.type) || l.type,
          enabled: true, selected: false,
          softEdgeEnable: pv(l, 'Input', 'SoftEdgeEnable', '0') === '1',
          warpMode: (l.warper && l.warper.bezier) ? 'Bezier' : 'Transform',
          filterMode: 'Linear', opacity: 1,
          InputRect:  { orientation: (l.InputRect  || {}).orientation || '0', vertices: inV.length ? inV : verts },
          OutputRect: { orientation: (l.OutputRect || {}).orientation || '0', vertices: verts },
          warper: l.warper && l.warper.bezier ? {
            bezier: {
              controlWidth:  +l.warper.bezier.controlWidth  || 4,
              controlHeight: +l.warper.bezier.controlHeight || 4,
              vertices: (l.warper.bezier.vertices || []).map(p => P(p.x, p.y)),
            },
            homography: {
              src: ((l.warper.homography || {}).src || []).map(p => P(p.x, p.y)),
              dst: ((l.warper.homography || {}).dst || []).map(p => P(p.x, p.y)),
            },
          } : defaultWarper(verts),
          fixture: l.fixture
            ? Object.assign({ colorSpace: 'RGB', pixels: 16 }, l.fixture)
            : (l.type === 'DmxSlice' ? { uuid: '', fixtureName: '', colorSpace: 'RGB', pixels: 16 } : null),
        };
      }),
    })),
  };
  /* a warper whose grid was never edited still has to match its own slice */
  model.screens.forEach(s => s.layers.forEach(l => {
    if (!l.warper.bezier.vertices.length) l.warper = defaultWarper(l.OutputRect.vertices);
  }));
  return model;
}

function blankModel() {
  const m = { compositionTexture: { width: 1920, height: 1080 },
              softEdgePower: 2, softEdgeLuminance: 0.5, softEdgeGamma: 1, screens: [] };
  m.screens.push(newScreen('Screen'));
  return m;
}

/* Levels, delay and the slice options are newer than some stored models and
   than the decoded file, so fill them in rather than render undefined. */
const LEVELS = { opacity: 1, brightness: 1, contrast: 1, r: 1, g: 1, b: 1 };
function normalise(m) {
  if (!m) return m;
  /* Arena's blend curve takes three numbers, not one. Models stored before
     Luminance and Gamma existed get Arena's defaults — L at 0.5 is what makes
     two facing ramps sum back to full brightness. */
  if (typeof m.softEdgePower !== 'number')     m.softEdgePower = 2;
  if (typeof m.softEdgeLuminance !== 'number') m.softEdgeLuminance = 0.5;
  if (typeof m.softEdgeGamma !== 'number')     m.softEdgeGamma = 1;
  m.screens.forEach(sc => {
    Object.keys(LEVELS).forEach(k => { if (typeof sc[k] !== 'number') sc[k] = LEVELS[k]; });
    if (typeof sc.delay !== 'number') sc.delay = 0;
    if (typeof sc.enabled !== 'boolean') sc.enabled = true;
    sc.layers.forEach(l => {
      Object.keys(LEVELS).forEach(k => { if (typeof l[k] !== 'number') l[k] = LEVELS[k]; });
      ['flipH', 'flipV', 'isKey', 'blackBG'].forEach(k => {
        if (typeof l[k] !== 'boolean') l[k] = false;
      });
    });
  });
  return m;
}

/* =========================================================================
   XML — the same shape AdvancedOutput.xml carries, so it round-trips
   ========================================================================= */
function toXML(m) {
  const q = s => esc(s);
  const verts = (tag, o) =>
    `        <${tag} orientation="${q(o.orientation || '0')}">\n` +
    o.vertices.map(p => `          <v x="${p.x}" y="${p.y}"/>`).join('\n') +
    `\n        </${tag}>`;
  const par = (n, t, d, v) => `        <Param name="${q(n)}" type="${t}" default="${q(d)}" value="${q(v)}"/>`;

  const body = m.screens.map(s => {
    const dmx = s.type === 'DmxScreen';
    const layers = s.layers.map(l => {
      const w = l.warper.bezier;
      return `      <${l.type} uniqueId="${q(l.uniqueId)}">
        <Params>
${par('Name', 'STRING', 'Layer', l.name)}
${par('Enabled', 'BOOL', '1', l.enabled ? '1' : '0')}
${par('SoftEdgeEnable', 'BOOL', '0', l.softEdgeEnable ? '1' : '0')}
${par('WarpMode', 'STRING', 'Transform', l.warpMode)}
${par('FilterMode', 'STRING', 'Linear', l.filterMode)}
        </Params>
${verts('InputRect', l.InputRect)}
${verts('OutputRect', l.OutputRect)}
        <Warper>
          <BezierWarper controlWidth="${w.controlWidth}" controlHeight="${w.controlHeight}">
${w.vertices.map(p => `            <v x="${p.x}" y="${p.y}"/>`).join('\n')}
          </BezierWarper>
          <Homography>
            <src>${l.warper.homography.src.map(p => `<v x="${p.x}" y="${p.y}"/>`).join('')}</src>
            <dst>${l.warper.homography.dst.map(p => `<v x="${p.x}" y="${p.y}"/>`).join('')}</dst>
          </Homography>
        </Warper>${l.softEdgeEnable ? '\n        <SoftEdgeGroup/>' : ''}${
        l.fixture ? `\n        <FixtureInstance>
          <Fixture uuid="${q(l.fixture.uuid)}" name="${q(l.fixture.fixtureName)}"/>
          <ParamFixturePixels value="${+l.fixture.pixels || 0}"/>
          <ParamColorSpace value="${q(l.fixture.colorSpace)}"/>
        </FixtureInstance>` : ''}
      </${l.type}>`;
    }).join('\n');

    return `  <${s.type} uniqueId="${q(s.uniqueId)}"${dmx ? ` LumiverseId="${q(s.lumiverseId)}"` : ''}>
    <Params>
${par('Name', 'STRING', '', s.name)}${dmx ? `\n${par('Auto Span', 'BOOL', '1', s.autoSpan ? '1' : '0')}
${par('Align Output', 'BOOL', '1', s.alignOutput ? '1' : '0')}` : ''}
    </Params>
    <guides>
${s.guides.map(g => `      <ScreenGuide type="${q(g.type)}"/>`).join('\n')}
    </guides>
    <layers>
${layers}
    </layers>
    <OutputDevice>
      <${s.outputDevice.kind} name="${q(s.outputDevice.name)}" deviceId="${q(s.outputDevice.deviceId)}"${
        s.outputDevice.kind === 'OutputDeviceVirtual'
          ? ` width="${s.outputDevice.width}" height="${s.outputDevice.height}"` : ''}/>
    </OutputDevice>
  </${s.type}>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ScreenSetup>
  <CurrentCompositionTextureSize width="${m.compositionTexture.width}" height="${m.compositionTexture.height}"/>
${body}
  <SoftEdging>
    <Param name="Power" type="DOUBLE" default="2" value="${m.softEdgePower}"/>
  </SoftEdging>
</ScreenSetup>`;
}

function fromXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not well-formed XML.');
  const num = (n, a, d) => { const v = n && n.getAttribute(a); return v == null ? d : +v; };
  /* Resolume writes a typed element per parameter — Param for the plain ones,
     ParamRange / ParamChoice / ParamFixturePixels for the rest. Matching only
     <Param> silently lost every DmxScreen setting, because those are all
     typed. */
  const PARAM_EL = ':scope > Params > Param, :scope > Params > ParamRange, ' +
                   ':scope > Params > ParamChoice, :scope > Params > ParamFixturePixels';
  const pval = (scope, name, d) => {
    const p = [...scope.querySelectorAll(PARAM_EL)].find(x => x.getAttribute('name') === name);
    return p ? p.getAttribute('value') : d;
  };
  const readVerts = n => n ? [...n.querySelectorAll('v')].map(v => P(num(v, 'x', 0), num(v, 'y', 0))) : [];

  const cts = doc.querySelector('CurrentCompositionTextureSize');
  const m = {
    compositionTexture: { width: num(cts, 'width', 1920), height: num(cts, 'height', 1080) },
    /* Power is written as <ParamRange>, not <Param>, so this used to fall back
       to 2 whatever the file said. */
    softEdgePower: +(([...doc.querySelectorAll('SoftEdging Param, SoftEdging ParamRange')]
      .find(p => p.getAttribute('name') === 'Power') || {}).getAttribute?.('value') || 2),
    screens: [],
  };
  /* Screens are grandchildren of ScreenSetup: Resolume wraps them in a
     lowercase <screens> element, exactly as it wraps slices in <layers> and
     guides in <guides>. Selecting `ScreenSetup > Screen` therefore matched
     nothing at all, every real AdvancedOutput.xml produced an empty model, and
     the "No Screen or DmxScreen elements" guard below threw on files that were
     perfectly valid. Matching on the wrapper reads both shapes. */
  [...doc.querySelectorAll('screens > Screen, screens > DmxScreen, ' +
                           'ScreenSetup > Screen, ScreenSetup > DmxScreen')].forEach(sn => {
    const dev = sn.querySelector('OutputDevice > *');
    const s = {
      type: sn.tagName, name: pval(sn, 'Name', sn.tagName), uniqueId: sn.getAttribute('uniqueId') || nextId(),
      lumiverseId: sn.getAttribute('LumiverseId'), enabled: true,
      autoSpan: pval(sn, 'Auto Span', '1') === '1',
      alignOutput: pval(sn, 'Align Output', '1') === '1',
      guides: [...sn.querySelectorAll('guides > ScreenGuide')].map(g => ({ name: 'ScreenGuide', type: g.getAttribute('type') })),
      /* Resolume identifies a device by deviceId and idHash, never by the
         label it happens to show. Keeping both is what lets a re-opened file
         land on the same physical output instead of on whatever sits first in
         the dropdown. */
      outputDevice: dev ? {
        kind: dev.tagName, name: dev.getAttribute('name') || '',
        deviceId: dev.getAttribute('deviceId') || '',
        idHash: dev.getAttribute('idHash') || '',
        width: num(dev, 'width', 1920), height: num(dev, 'height', 1080),
      } : { kind: 'OutputDeviceVirtual', name: '', deviceId: '', idHash: '',
            width: 1920, height: 1080 },
      layers: [],
    };
    [...sn.querySelectorAll('layers > Slice, layers > DmxSlice')].forEach(ln => {
      const bz = ln.querySelector('BezierWarper');
      const outV = readVerts(ln.querySelector('OutputRect'));
      const inV  = readVerts(ln.querySelector('InputRect'));
      const fx   = ln.querySelector('FixtureInstance > Fixture');
      const verts = outV.length ? outV : inV;
      s.layers.push({
        type: ln.tagName, kind: ln.tagName === 'DmxSlice' ? 'DMX Fixture' : 'Slice', mask: false,
        uniqueId: ln.getAttribute('uniqueId') || nextId(),
        name: pval(ln, 'Name', ln.tagName), enabled: pval(ln, 'Enabled', '1') === '1', selected: false,
        softEdgeEnable: pval(ln, 'SoftEdgeEnable', '0') === '1',
        warpMode: pval(ln, 'WarpMode', bz ? 'Bezier' : 'Transform'),
        filterMode: pval(ln, 'FilterMode', 'Linear'), opacity: 1,
        InputRect:  { orientation: '0', vertices: inV.length ? inV : verts },
        OutputRect: { orientation: '0', vertices: verts },
        warper: bz ? {
          bezier: { controlWidth: num(bz, 'controlWidth', 4), controlHeight: num(bz, 'controlHeight', 4),
                    vertices: readVerts(bz) },
          homography: { src: readVerts(ln.querySelector('Homography > src')),
                        dst: readVerts(ln.querySelector('Homography > dst')) },
        } : defaultWarper(verts),
        fixture: fx ? {
          uuid: fx.getAttribute('uuid') || '', fixtureName: fx.getAttribute('name') || '',
          colorSpace: (ln.querySelector('ParamColorSpace') || {}).getAttribute?.('value') || 'RGB',
          pixels: +((ln.querySelector('ParamFixturePixels') || {}).getAttribute?.('value') || 16),
        } : null,
      });
    });
    m.screens.push(s);
  });
  if (!m.screens.length) throw new Error('No Screen or DmxScreen elements in that file.');
  m.screens.forEach(s => s.layers.forEach(l => {
    if (!l.warper.bezier.vertices.length) l.warper = defaultWarper(l.OutputRect.vertices);
  }));
  return m;
}

/* =========================================================================
   the composition texture the editor warps
   -------------------------------------------------------------------------
   Arena publishes no render target for the output, so this is not the GPU
   output and is never labelled as such. It is a calibration pattern at the
   composition texture's own size, over which the live thumbnail composite is
   drawn when Arena is connected — enough to read a warp against, and honest
   about what it is.
   ========================================================================= */
function makeTexture(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
  const g = c.getContext('2d');
  paintPattern(g, c.width, c.height);
  return c;
}
function paintPattern(g, w, h) {
  const C = PAL();
  g.fillStyle = C.inset; g.fillRect(0, 0, w, h);
  const step = Math.max(32, Math.round(Math.min(w, h) / 12));
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const odd = ((x / step | 0) + (y / step | 0)) % 2;
      g.fillStyle = odd ? C.void : C.surface;
      g.fillRect(x, y, step, step);
    }
  g.strokeStyle = withA(C.accent, '59'); g.lineWidth = Math.max(1, w / 900);
  for (let x = 0; x <= w; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  /* corner and centre marks — what a warp is actually judged against */
  g.strokeStyle = withA(C.mask, 'e6'); g.lineWidth = Math.max(2, w / 500);
  g.strokeRect(g.lineWidth, g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h);
  g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.beginPath(); g.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, 7); g.stroke();
  g.fillStyle = withA(C.text, 'd9');
  g.font = `${Math.round(Math.min(w, h) / 14)}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(`${w} × ${h}`, w / 2, h / 2);
  g.textAlign = 'left';  g.fillText('TL', step * .3, step * .5);
  g.textAlign = 'right'; g.fillText('TR', w - step * .3, step * .5);
  g.textAlign = 'left';  g.fillText('BL', step * .3, h - step * .5);
  g.textAlign = 'right'; g.fillText('BR', w - step * .3, h - step * .5);
}

/* =========================================================================
   the editor
   ========================================================================= */
function mount(host, opts) {
  opts = opts || {};
  const ed = {
    model: null, screenIndex: 0,
    tool: 'Transform', view: 'output',        // output | input | both
    sel: new Set(), drag: null, hover: null,
    zoom: 1, pan: { x: 0, y: 0 }, fit: true,
    showWarp: true, showGuides: true, showNumbers: true, showTexture: true, showSoftEdge: true,
    /* the manual's View Options */
    sliceGrid: false, ledGrid: false, identify: false, showInOutput: true,
    folded: new Set(),                    // screens folded shut in the tree
    setup: 'Default',                     // the loaded screen-setup preset
    mesh: 12, texture: null, live: null, dirty: false,
  };

  /* ---- state ---------------------------------------------------------- */
  const KEY = 'ao.model';
  function loadModel() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.screens && s.screens.length) return s;
    } catch {}
    return fromDecoded(RA().advanced_output) || blankModel();
  }
  function persist() {
    ed.dirty = false;
    try { localStorage.setItem(KEY, JSON.stringify(ed.model)); return true; } catch { return false; }
  }
  ed.model = normalise(loadModel());
  ed.texture = makeTexture(ed.model.compositionTexture.width, ed.model.compositionTexture.height);

  const screen = () => ed.model.screens[ed.screenIndex] || ed.model.screens[0];
  const slices = () => (screen() || { layers: [] }).layers;
  const selected = () => slices().filter(s => ed.sel.has(s.uniqueId));
  const devSize = () => {
    const d = (screen() || {}).outputDevice || {};
    return { w: +d.width || 1920, h: +d.height || 1080 };
  };
  /* Input Selection and Output Transformation are two different jobs on the
     same slice, and a slice carries a rectangle for each:

       InputRect   which pixels this slice takes OUT of the composition
                   texture — measured in composition pixels
       OutputRect  where those pixels LAND on the device, and how they are
                   warped to get there — measured in device pixels

     They work hand in hand, but editing one is not editing the other.

     Which one you are editing used to be decided by the stage tab alone. In
     the Both stage that resolved to 'both', which is neither, so it fell
     through to OutputRect — and dragging a handle in the *input* pane moved
     the output shape. The pane under the pointer is the honest answer, so
     viewAt() records it and everything below asks that. */
  let editMode = null;
  const modeNow = () => editMode || (ed.view === 'both' ? 'output' : ed.view);
  const space = () => modeNow() === 'input'
    ? { w: ed.model.compositionTexture.width, h: ed.model.compositionTexture.height }
    : devSize();
  const rectOf = s => modeNow() === 'input' ? s.InputRect : s.OutputRect;

  /* ---- chrome ----------------------------------------------------------
     Laid out where the manual puts things:

       top left      the screen-setup preset dropdown
       top centre    the two stages — Input Selection, Output Transformation
       top right     view options, then fit / import / export
       left column   the screen tree: a toggle in front of each screen, a fold
                     arrow beneath it, its slices nested under it, and the
                     plus+ menu at the foot of the list
       stage         the canvas, with Transform / Edit Points in its top right
       right column  the properties for whatever is selected
     ---------------------------------------------------------------------- */
  host.classList.add('ao');
  host.innerHTML = `
    <div class="ao-bar">
      <div class="ao-menu-wrap">
        <button class="ao-btn ao-preset" data-menu="preset"
          title="Screen setups: save and select whole output setups">Screen Setup ▾</button>
      </div>
      <span class="ao-sep"></span>
      <div class="ao-stages">
        ${V.stages.map(s =>
          `<button class="ao-stagetab" data-stage="${esc(s)}">${esc(s)}</button>`).join('')}
        <button class="ao-stagetab" data-stage="Both" title="Both stages side by side">Both</button>
      </div>
      <span class="ao-sp"></span>
      <div class="ao-menu-wrap"><button class="ao-btn" data-menu="view">View ▾</button></div>
      <span class="ao-sep"></span>
      <button class="ao-btn" data-act="fit" title="Fit to the window (F)">Fit</button>
      <button class="ao-btn" data-act="import" title="Read an AdvancedOutput.xml">Import</button>
      <button class="ao-btn" data-act="export" title="Write an AdvancedOutput.xml">Export</button>
      <input type="file" class="ao-file" accept=".xml,text/xml" hidden>
    </div>
    <div class="ao-main">
      <div class="ao-tree">
        <div class="ao-treelist"></div>
        <div class="ao-treefoot">
          <div class="ao-menu-wrap"><button class="ao-btn ao-plus" data-menu="add"
            title="Add a slice, mask or fixture to this screen">+ ▾</button></div>
          <div class="ao-menu-wrap"><button class="ao-btn ao-plus" data-menu="screen"
            title="Add a screen">+ Screen ▾</button></div>
        </div>
      </div>
      <div class="ao-stage"><canvas class="ao-canvas"></canvas>
        <div class="ao-tools"></div>
        <div class="ao-readout"></div>
        <div class="ao-hint"></div>
      </div>
      <div class="ao-side"></div>
    </div>
    <div class="ao-menu" hidden></div>`;

  const cv = host.querySelector('.ao-canvas');
  const g = cv.getContext('2d');
  const stageG = g;                       // the stage, for helpers that can target elsewhere

  /* A scratch surface the size of the stage. A soft-edged slice is rasterised
     here first, attenuated, and only then composited — see drawWarped(). */
  const sfx = document.createElement('canvas');
  const sfxG = sfx.getContext('2d');
  function sfxClear() {
    if (sfx.width !== cv.width || sfx.height !== cv.height) {
      sfx.width = cv.width; sfx.height = cv.height;
    }
    sfxG.setTransform(1, 0, 0, 1, 0, 0);
    sfxG.globalAlpha = 1; sfxG.globalCompositeOperation = 'source-over'; sfxG.filter = 'none';
    sfxG.clearRect(0, 0, sfx.width, sfx.height);
    return sfxG;
  }

  const stage = host.querySelector('.ao-stage');
  const side = host.querySelector('.ao-side');
  const tree = host.querySelector('.ao-treelist');
  const readout = host.querySelector('.ao-readout');
  const menu = host.querySelector('.ao-menu');
  const fileInput = host.querySelector('.ao-file');

  /* Transform / Edit Points, in the top right of the stage */
  host.querySelector('.ao-tools').innerHTML = V.tools.map(t =>
    `<button class="ao-tool" data-tool="${esc(t)}">${esc(t)}</button>`).join('');

  /* ---- view transform -------------------------------------------------- */
  let VIEWS = [];        // [{ mode, ox, oy, scale, w, h }] — one or two panes
  function computeViews() {
    const rect = stage.getBoundingClientRect();
    const W = Math.max(80, rect.width), H = Math.max(80, rect.height);
    cv.width = Math.round(W * devicePixelRatio); cv.height = Math.round(H * devicePixelRatio);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const panes = ed.view === 'both' ? ['input', 'output'] : [ed.view];
    const pad = 18;
    VIEWS = panes.map((mode, i) => {
      const paneW = W / panes.length, ox0 = i * paneW;
      const sp = mode === 'input'
        ? { w: ed.model.compositionTexture.width, h: ed.model.compositionTexture.height }
        : devSize();
      const s = Math.min((paneW - pad * 2) / sp.w, (H - pad * 2) / sp.h) * (ed.fit ? 1 : ed.zoom);
      return {
        mode, scale: s, w: sp.w, h: sp.h, paneW, paneX: ox0,
        ox: ox0 + (paneW - sp.w * s) / 2 + (ed.fit ? 0 : ed.pan.x),
        oy: (H - sp.h * s) / 2 + (ed.fit ? 0 : ed.pan.y),
      };
    });
    if (ed.fit && VIEWS[0]) ed.zoom = VIEWS[0].scale / (VIEWS[0].scale || 1);
  }
  const toScreen = (v, p) => P(v.ox + p.x * v.scale, v.oy + p.y * v.scale);
  const toModel  = (v, x, y) => P((x - v.ox) / v.scale, (y - v.oy) / v.scale);
  /* Every interaction path asks this first, so it is the one place that knows
     which pane the pointer is in — and therefore which of the slice's two
     rectangles is being edited. See rectOf(). */
  function viewAt(x) {
    for (const v of VIEWS) if (x >= v.paneX && x < v.paneX + v.paneW) { editMode = v.mode; return v; }
    if (VIEWS[0]) editMode = VIEWS[0].mode;
    return VIEWS[0];
  }

  /* ---- warp sampling --------------------------------------------------- */
  /* output position for (u,v) in the slice's own unit square */
  function outAt(s, u, v) {
    const o = s.OutputRect.vertices;
    if (s.warpMode === 'Bezier')
      return patchPoint(s.warper.bezier.vertices, s.warper.bezier.controlWidth, s.warper.bezier.controlHeight, u, v);
    if (s.warpMode === 'Linear Grid')
      return gridPoint(s.warper.bezier.vertices, s.warper.bezier.controlWidth, s.warper.bezier.controlHeight, u, v);
    if (s.warpMode === 'Perspective' && o.length === 4)
      return applyH(unitToQuad(o), u, v);
    return o.length === 4 ? quadLerp(o, u, v) : polyAt(o, u, v);
  }
  /* a polygon has no unit square, so it is sampled over its bounding box */
  function polyAt(v, u, t) {
    const b = polyBounds(v);
    return P(b.x0 + (b.x1 - b.x0) * u, b.y0 + (b.y1 - b.y0) * t);
  }
  function inAt(s, u, v) {
    const i = s.InputRect.vertices;
    return i.length === 4 ? quadLerp(i, u, v) : polyAt(i, u, v);
  }

  /* affine texture mapping, one triangle at a time — the dest is expanded a
     hair so adjacent cells do not show a seam */
  /* `gx` lets a slice be rasterised somewhere other than the stage — soft edge
     needs the slice on its own surface before it can be attenuated. */
  function texTri(img, s0, s1, s2, d0, d1, d2, gx) {
    const g = gx || stageG;
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3, k = 1.008;
    const e = p => P(cx + (p.x - cx) * k, cy + (p.y - cy) * k);
    const e0 = e(d0), e1 = e(d1), e2 = e(d2);
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (!den) return;
    const m11 = ((e1.x - e0.x) * (s2.y - s0.y) - (e2.x - e0.x) * (s1.y - s0.y)) / den;
    const m12 = ((e1.y - e0.y) * (s2.y - s0.y) - (e2.y - e0.y) * (s1.y - s0.y)) / den;
    const m21 = ((e2.x - e0.x) * (s1.x - s0.x) - (e1.x - e0.x) * (s2.x - s0.x)) / den;
    const m22 = ((e2.y - e0.y) * (s1.x - s0.x) - (e1.y - e0.y) * (s2.x - s0.x)) / den;
    g.save();
    g.beginPath(); g.moveTo(e0.x, e0.y); g.lineTo(e1.x, e1.y); g.lineTo(e2.x, e2.y); g.closePath(); g.clip();
    g.transform(m11, m12, m21, m22, e0.x - m11 * s0.x - m21 * s0.y, e0.y - m12 * s0.x - m22 * s0.y);
    g.drawImage(img, 0, 0);
    g.restore();
  }

  /* ---- draw ------------------------------------------------------------ */
  function draw() {
    computeViews();
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const W = cv.width / devicePixelRatio, H = cv.height / devicePixelRatio;
    const C = PAL();
    g.clearRect(0, 0, W, H);
    g.fillStyle = C.void; g.fillRect(0, 0, W, H);

    VIEWS.forEach((v, i) => {
      g.save();
      g.beginPath(); g.rect(v.paneX, 0, v.paneW, H); g.clip();
      drawPane(v);
      g.restore();
      if (i) { g.strokeStyle = C.edge; g.beginPath(); g.moveTo(v.paneX, 0); g.lineTo(v.paneX, H); g.stroke(); }
      /* pane caption, in the same key as the section heads in the chrome */
      g.fillStyle = C.label; g.font = `10px ${FONT}`; g.textAlign = 'left';
      g.fillText(v.mode === 'input'
        ? `INPUT · Show canvas ${v.w} × ${v.h}`
        : `OUTPUT · ${(screen() || {}).name || ''} ${v.w} × ${v.h}`, v.paneX + 8, 14);
    });
    paintReadout();
    syncGeom();
  }

  /* The vertex table is built once per selection, so a drag or a nudge would
     leave it showing whatever the shape was when it was selected. Rebuilding
     the whole side on every mousemove would tear the focused field out from
     under the caret, so the numbers are written into the fields that are
     already there — the same thing panel-kit's apply() does for parameters. */
  function syncGeom() {
    const s = selected()[0];
    if (!s) return;
    const verts = rectOf(s).vertices;
    side.querySelectorAll('.ao-vrow input[data-v]').forEach(n => {
      if (n === document.activeElement) return;
      const p = verts[+n.dataset.v];
      if (!p) return;
      const v = Math.round(p[n.dataset.axis] * 100) / 100;
      if (+n.value !== v) n.value = v;
    });
  }

  function drawPane(v) {
    const C = PAL();
    /* the device / texture rectangle itself */
    const o = toScreen(v, P(0, 0)), e = toScreen(v, P(v.w, v.h));
    g.fillStyle = C.inset; g.fillRect(o.x, o.y, e.x - o.x, e.y - o.y);

    /* The Input Selection stage is a view *of the composition texture* — it is
       what you are cutting slices out of, so it has to show what is playing.
       It used to be an empty rectangle, which made the input rectangles
       impossible to place against actual content. */
    if (v.mode === 'input') {
      const img = sourceImage('composition') || ed.live || ed.texture;
      if (img) { try { g.drawImage(img, o.x, o.y, e.x - o.x, e.y - o.y); } catch (err) {} }
    }

    g.strokeStyle = C.edge; g.lineWidth = 1;
    g.strokeRect(o.x + .5, o.y + .5, e.x - o.x, e.y - o.y);

    /* Show 8x8 LED Grid — the manual: 99% of LED screens are blocks of 8px,
       so the stage can rule the output off in eights to snap against */
    if (ed.ledGrid) {
      const step = 8 * v.scale;
      if (step >= 3) {
        g.strokeStyle = withA(C.dim, '22'); g.lineWidth = 1;
        g.beginPath();
        for (let x = 0; x <= v.w; x += 8) { const p = o.x + x * v.scale; g.moveTo(p, o.y); g.lineTo(p, e.y); }
        for (let y = 0; y <= v.h; y += 8) { const p = o.y + y * v.scale; g.moveTo(o.x, p); g.lineTo(e.x, p); }
        g.stroke();
      }
    }

    if (ed.showGuides) {
      g.strokeStyle = withA(C.dim, '2e');
      (screen().guides || []).forEach(gd => {
        g.beginPath();
        if (gd.type === '0') { const m = (o.x + e.x) / 2; g.moveTo(m, o.y); g.lineTo(m, e.y); }
        else { const m = (o.y + e.y) / 2; g.moveTo(o.x, m); g.lineTo(e.x, m); }
        g.stroke();
      });
    }

    const list = slices();
    const sc = screen();
    /* the screen's toggle disables all output to it, so the composite goes
       away while the shapes stay editable */
    const outputOn = sc.enabled !== false;
    list.forEach((s, i) => {
      if (!s.enabled) return;
      if (outputOn && v.mode === 'output' && ed.showTexture && !s.mask) drawWarped(v, s);
      drawOutline(v, s, i);
    });
    if (!outputOn) {
      g.fillStyle = C.label; g.font = `10px ${FONT}`; g.textAlign = 'center';
      g.fillText('OUTPUT DISABLED', (o.x + e.x) / 2, o.y + 16);
      g.textAlign = 'left';
    }
    /* the warp net sits over everything so its points stay grabbable */
    if (v.mode === 'output' && ed.showWarp)
      list.forEach(s => { if (ed.sel.has(s.uniqueId)) drawWarpNet(v, s); });
  }

  function drawWarped(v, s) {
    /* Each slice samples the source it is routed to. This used to be one image
       for every slice, so the Input Source dropdown stored an answer that
       nothing ever read. */
    const img = sourceImage(s.inputSource) || ed.live || ed.texture;
    const N = Math.max(2, Math.min(48, ed.mesh));
    const at = (i, j) => j * (N + 1) + i;
    const src = [], dst = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const u = i / N, t = j / N;
        /* the Pacman flips mirror which pixels the slice takes, not where it
           lands — so they act on the input side of the pair */
        src.push(inAt(s, s.flipH ? 1 - u : u, s.flipV ? 1 - t : t));
        dst.push(toScreen(v, outAt(s, u, t)));
      }
    }
    /* the outline of the warped mesh, walked border-first */
    const border = () => {
      const p = [];
      for (let i = 0; i <= N; i++) p.push(dst[at(i, 0)]);
      for (let j = 1; j <= N; j++) p.push(dst[at(N, j)]);
      for (let i = N - 1; i >= 0; i--) p.push(dst[at(i, N)]);
      for (let j = N - 1; j >= 1; j--) p.push(dst[at(0, j)]);
      return p;
    };

    /* edge-blending.htm. A soft-edged slice is rasterised on its own surface,
       attenuated there, and only then composited. It used to be attenuated
       straight onto the stage with 'destination-out', which does not erase the
       slice — it erases the *destination*, i.e. the background fill, the
       device rectangle and every slice already drawn. One soft edge punched a
       hole through all of them.

       The finished slice is composited with 'lighter' because that is what two
       projectors do to a shared wall: the two ramps add, and where they are
       complementary they sum back to full brightness. */
    const soft = s.softEdgeEnable && ed.showSoftEdge;
    const gt = soft ? sfxClear() : g;

    gt.save();
    /* the slice's own opacity, under the screen's — the manual's Adjustments */
    const sc = screen();
    gt.globalAlpha = (s.opacity == null ? 1 : s.opacity)
      * (sc.opacity == null ? 1 : sc.opacity)
      * (ed.sel.has(s.uniqueId) ? 1 : .82);

    /* Black BG renders the slice over black, whatever is playing in it */
    if (s.blackBG) {
      gt.save(); gt.beginPath();
      border().forEach((p, i) => i ? gt.lineTo(p.x, p.y) : gt.moveTo(p.x, p.y));
      gt.closePath(); gt.fillStyle = PAL().void; gt.fill(); gt.restore();
    }

    /* brightness / contrast / channels, the screen's multiplied by the slice's;
       Is Key sends luminance instead of colour */
    const f = (a, b) => (a == null ? 1 : a) * (b == null ? 1 : b);
    const br = f(s.brightness, sc.brightness), ct = f(s.contrast, sc.contrast);
    const chan = (f(s.r, sc.r) + f(s.g, sc.g) + f(s.b, sc.b)) / 3;
    const bits = [];
    if (br !== 1 || chan !== 1) bits.push(`brightness(${(br * chan).toFixed(3)})`);
    if (ct !== 1) bits.push(`contrast(${ct.toFixed(3)})`);
    if (s.isKey) bits.push('grayscale(1)');
    if (bits.length) gt.filter = bits.join(' ');

    gt.imageSmoothingEnabled = s.filterMode !== 'Nearest';
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        texTri(img, src[a], src[b], src[c], dst[a], dst[b], dst[c], gt);
        texTri(img, src[a], src[c], src[d], dst[a], dst[c], dst[d], gt);
      }
    gt.restore();

    if (soft) {
      applySoftEdge(gt, s, N, dst);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 1; g.filter = 'none';
      g.drawImage(sfx, 0, 0);
      g.restore();
    }
  }

  /* the soft edge is a falloff toward the slice border, raised to the Power
     the file stores — drawn as a darkening mask so overlap reads correctly */
  /* Arena's blend curve, from the slice fragment shader:
        c = L * (2x)^P                for x < 0.5
        c = 1 - (1-L) * (2-2x)^P      otherwise
        c = c ^ (1/gamma)
     x runs 0 at the outer edge of the blend band to 1 at its inner edge.

     This used to be `1 - pow(x, 1/P)`. Two things were wrong with that: the
     exponent is reciprocal, so raising Power *flattened* the fade instead of
     steepening it, and with L implicitly 1 the two halves of a seam summed to
     1.41 rather than 1. With L at 0.5 the pair is complementary for any P —
     c(x) + c(1-x) = 1 — which is the whole point of an edge blend. */
  function blendCurve(x, P, L, G) {
    x = clamp(x, 0, 1);
    const c = x < 0.5
      ? L * Math.pow(2 * x, P)
      : 1 - (1 - L) * Math.pow(2 - 2 * x, P);
    return clamp(Math.pow(clamp(c, 0, 1), 1 / (G || 1)), 0, 1);
  }

  /* edge-blending.htm — a slice fades *where it overlaps another slice*. The
     outer boundary of the array is the edge of the picture and stays at full
     brightness. This used to be a fixed 25% inset on all four edges of every
     soft-edged slice, so a single slice faded into nothing on all sides and an
     array darkened at its outer border. Depths come back in this slice's own
     0..1 space, one per edge. */
  function overlapBands(s) {
    const b = polyBounds(s.OutputRect.vertices);
    const w = Math.max(1e-6, b.x1 - b.x0), h = Math.max(1e-6, b.y1 - b.y0);
    const band = { l: 0, r: 0, t: 0, b: 0 };
    slices().forEach(o => {
      if (o === s || o.enabled === false || !o.softEdgeEnable) return;
      const q = polyBounds(o.OutputRect.vertices);
      if (q.x1 <= b.x0 || q.x0 >= b.x1 || q.y1 <= b.y0 || q.y0 >= b.y1) return;
      if (q.x0 > b.x0 && q.x0 < b.x1) band.r = Math.max(band.r, (b.x1 - q.x0) / w);
      if (q.x1 > b.x0 && q.x1 < b.x1) band.l = Math.max(band.l, (q.x1 - b.x0) / w);
      if (q.y0 > b.y0 && q.y0 < b.y1) band.b = Math.max(band.b, (b.y1 - q.y0) / h);
      if (q.y1 > b.y0 && q.y1 < b.y1) band.t = Math.max(band.t, (q.y1 - b.y0) / h);
    });
    return band;
  }

  /* Attenuate a slice that has already been rasterised onto `gt`. Alpha only,
     and scoped to that surface — nothing else on the stage is touched. */
  function applySoftEdge(gt, s, N, dst) {
    const P = +ed.model.softEdgePower || 2;
    const L = ed.model.softEdgeLuminance == null ? 0.5 : +ed.model.softEdgeLuminance;
    const G = +ed.model.softEdgeGamma || 1;
    const band = overlapBands(s);
    if (!band.l && !band.r && !band.t && !band.b) return;   // nothing overlaps: no fade
    const edge = (x, d) => d <= 1e-4 ? 1 : blendCurve(x / d, P, L, G);
    const at = (i, j) => j * (N + 1) + i;

    gt.save();
    gt.globalCompositeOperation = 'destination-out';
    gt.filter = 'none';
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const u = (i + .5) / N, t = (j + .5) / N;
        const keep = edge(u, band.l) * edge(1 - u, band.r)
                   * edge(t, band.t) * edge(1 - t, band.b);
        const cut = 1 - keep;
        if (cut <= 0.002) continue;
        const p0 = dst[at(i, j)], p1 = dst[at(i + 1, j)], p2 = dst[at(i + 1, j + 1)], p3 = dst[at(i, j + 1)];
        gt.globalAlpha = clamp(cut, 0, 1);
        gt.beginPath(); gt.moveTo(p0.x, p0.y); gt.lineTo(p1.x, p1.y);
        gt.lineTo(p2.x, p2.y); gt.lineTo(p3.x, p3.y); gt.closePath(); gt.fill();
      }
    gt.restore();
  }

  function drawOutline(v, s, idx) {
    const C = PAL();
    const verts = rectOf(s).vertices.map(p => toScreen(v, p));
    if (!verts.length) return;
    const on = ed.sel.has(s.uniqueId), hot = ed.hover && ed.hover.slice === s.uniqueId;
    g.beginPath();
    verts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
    g.closePath();
    if (s.mask) { g.fillStyle = withA(C.mask, '1a'); g.fill(); }
    /* Identify Slices — the manual: slices light up white under the pointer */
    if (ed.identify && hot) { g.fillStyle = withA(C.hi, '38'); g.fill(); }
    g.lineWidth = on ? 2 : 1;
    /* selection is the accent, as it is everywhere else in the application */
    g.strokeStyle = s.mask ? C.mask
      : s.type === 'DmxSlice' ? C.dmx
      : on ? C.accentHi : hot ? C.accent : withA(C.dim, '90');
    g.stroke();

    if (ed.showNumbers) {
      const b = polyBounds(verts);
      g.fillStyle = on ? C.labelOn : C.label;
      g.font = `11px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`${idx + 1} · ${s.name}`, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    }
    /* Show Slice Grid — the outlines and a grid for the selected slice */
    if (on && ed.sliceGrid) {
      g.save(); g.clip();
      g.strokeStyle = withA(C.accent, '40'); g.lineWidth = 1;
      g.beginPath();
      for (let i = 1; i < 8; i++) {
        const a = lerp(verts[0], verts[1] || verts[0], i / 8);
        const b2 = lerp(verts[3] || verts[0], verts[2] || verts[0], i / 8);
        g.moveTo(a.x, a.y); g.lineTo(b2.x, b2.y);
        const c2 = lerp(verts[0], verts[3] || verts[0], i / 8);
        const d2 = lerp(verts[1] || verts[0], verts[2] || verts[0], i / 8);
        g.moveTo(c2.x, c2.y); g.lineTo(d2.x, d2.y);
      }
      g.stroke(); g.restore();
    }
    /* points are grabbable in Edit Points; Transform moves the whole slice */
    if (on && ed.tool !== 'Draw') verts.forEach((p, i) => handle(p, ed.hover &&
      ed.hover.slice === s.uniqueId && ed.hover.kind === 'vertex' && ed.hover.i === i));
  }

  function drawWarpNet(v, s) {
    if (s.warpMode !== 'Bezier' && s.warpMode !== 'Linear Grid') return;
    const C = PAL();
    const b = s.warper.bezier, cw = b.controlWidth, ch = b.controlHeight;
    g.strokeStyle = withA(C.accent, '59'); g.lineWidth = 1;
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const p = b.vertices[j * cw + i]; if (!p) continue;
        const a = toScreen(v, p);
        if (i + 1 < cw && b.vertices[j * cw + i + 1]) {
          const q = toScreen(v, b.vertices[j * cw + i + 1]);
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(q.x, q.y); g.stroke();
        }
        if (j + 1 < ch && b.vertices[(j + 1) * cw + i]) {
          const q = toScreen(v, b.vertices[(j + 1) * cw + i]);
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(q.x, q.y); g.stroke();
        }
      }
    b.vertices.forEach((p, i) => {
      const hot = ed.hover && ed.hover.slice === s.uniqueId && ed.hover.kind === 'ctrl' && ed.hover.i === i;
      handle(toScreen(v, p), hot, PAL().accentHi);
    });
  }

  function handle(p, hot, col) {
    const C = PAL();
    const r = hot ? 5.5 : 4;
    g.beginPath(); g.arc(p.x, p.y, r, 0, 7);
    g.fillStyle = hot ? C.hi : (col || C.labelOn);
    g.fill();
    g.lineWidth = 1; g.strokeStyle = C.void; g.stroke();
  }

  function paintReadout() {
    const s = selected()[0];
    const parts = [`${ed.tool}`, `${slices().length} slice${slices().length === 1 ? '' : 's'}`];
    if (s) {
      const b = polyBounds(rectOf(s).vertices);
      parts.push(`${s.name} · ${Math.round(b.x1 - b.x0)} × ${Math.round(b.y1 - b.y0)} @ ${Math.round(b.x0)},${Math.round(b.y0)}`);
    }
    if (ed.dirty) parts.push('unsaved');
    readout.textContent = parts.join('   ·   ');
  }

  /* ---- hit testing ------------------------------------------------------ */
  const GRAB = 9;
  function hitTest(v, mx, my) {
    const m = toModel(v, mx, my);
    const list = slices();
    /* control points first — they sit on top */
    if (v.mode === 'output' && ed.showWarp)
      for (let n = list.length - 1; n >= 0; n--) {
        const s = list[n];
        if (!ed.sel.has(s.uniqueId)) continue;
        if (s.warpMode !== 'Bezier' && s.warpMode !== 'Linear Grid') continue;
        const b = s.warper.bezier;
        for (let i = 0; i < b.vertices.length; i++) {
          const p = toScreen(v, b.vertices[i]);
          if (Math.hypot(p.x - mx, p.y - my) <= GRAB) return { slice: s.uniqueId, kind: 'ctrl', i };
        }
      }
    for (let n = list.length - 1; n >= 0; n--) {
      const s = list[n];
      if (!s.enabled) continue;
      const verts = rectOf(s).vertices;
      if (ed.sel.has(s.uniqueId) && ed.tool !== 'Draw')
        for (let i = 0; i < verts.length; i++) {
          const p = toScreen(v, verts[i]);
          if (Math.hypot(p.x - mx, p.y - my) <= GRAB) return { slice: s.uniqueId, kind: 'vertex', i };
        }
      if (pointInPoly(m, verts)) return { slice: s.uniqueId, kind: 'body' };
    }
    return null;
  }
  const byId = id => slices().find(s => s.uniqueId === id);

  /* ---- interaction ------------------------------------------------------ */
  stage.addEventListener('mousemove', ev => {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    if (ed.drag) { doDrag(mx, my, ev); return; }
    const v = viewAt(mx);
    const h = hitTest(v, mx, my);
    const changed = JSON.stringify(h) !== JSON.stringify(ed.hover);
    ed.hover = h;
    cv.style.cursor = !h ? 'default'
      : h.kind === 'body' ? (ed.tool === 'Transform' ? 'move' : 'pointer') : 'crosshair';
    if (changed) draw();
  });

  stage.addEventListener('mousedown', ev => {
    if (ev.button === 2) return;                       // handled by contextmenu
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const v = viewAt(mx);
    hideMenu();
    /* middle button, or space held, pans */
    if (ev.button === 1 || ed.spaceDown) {
      ed.fit = false;
      ed.drag = { kind: 'pan', mx, my, pan: { x: ed.pan.x, y: ed.pan.y } };
      ev.preventDefault(); return;
    }
    const h = hitTest(v, mx, my);
    if (!h) {
      if (!ev.shiftKey) { ed.sel.clear(); tree_render(); side_render(); }
      ed.drag = { kind: 'marquee', v, from: toModel(v, mx, my), to: toModel(v, mx, my) };
      draw(); return;
    }
    if (!ed.sel.has(h.slice)) {
      if (!ev.shiftKey) ed.sel.clear();
      ed.sel.add(h.slice);
      tree_render(); side_render();
    } else if (ev.shiftKey) { ed.sel.delete(h.slice); tree_render(); side_render(); draw(); return; }

    const s = byId(h.slice);
    ed.drag = {
      kind: h.kind, v, slice: h.slice, i: h.i,
      from: toModel(v, mx, my),
      snapshot: selected().map(x => ({
        id: x.uniqueId,
        rect: rectOf(x).vertices.map(p => P(p.x, p.y)),
        ctrl: x.warper.bezier.vertices.map(p => P(p.x, p.y)),
      })),
      one: s ? rectOf(s).vertices.map(p => P(p.x, p.y)) : null,
    };
    draw();
  });

  function doDrag(mx, my, ev) {
    const d = ed.drag;
    if (d.kind === 'pan') {
      ed.pan.x = d.pan.x + (mx - d.mx); ed.pan.y = d.pan.y + (my - d.my);
      draw(); return;
    }
    if (d.kind === 'marquee') {
      d.to = toModel(d.v, mx, my);
      const b = polyBounds([d.from, d.to]);
      ed.sel.clear();
      slices().forEach(s => {
        const c = polyBounds(rectOf(s).vertices);
        const mid = P((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
        if (mid.x >= b.x0 && mid.x <= b.x1 && mid.y >= b.y0 && mid.y <= b.y1) ed.sel.add(s.uniqueId);
      });
      tree_render(); side_render(); draw(); return;
    }
    const now = toModel(d.v, mx, my);
    let dx = now.x - d.from.x, dy = now.y - d.from.y;
    if (ev && ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }

    if (d.kind === 'ctrl') {
      const s = byId(d.slice), snap = d.snapshot.find(x => x.id === d.slice);
      if (s && snap) {
        const p = snap.ctrl[d.i];
        s.warper.bezier.vertices[d.i] = P(p.x + dx, p.y + dy);
      }
    } else if (d.kind === 'vertex') {
      const s = byId(d.slice);
      if (s && d.one) {
        rectOf(s).vertices[d.i] = P(d.one[d.i].x + dx, d.one[d.i].y + dy);
        /* Edit Points reshapes only the outline; the warp net follows the
           outline when it has not been touched independently */
        if (ed.view === 'output' && s.warpMode === 'Transform') syncWarper(s);
      }
    } else {                                    // body — move every selected shape
      d.snapshot.forEach(snap => {
        const s = byId(snap.id); if (!s) return;
        rectOf(s).vertices.forEach((p, i) => { p.x = snap.rect[i].x + dx; p.y = snap.rect[i].y + dy; });
        if (ed.view === 'output')
          s.warper.bezier.vertices.forEach((p, i) => { p.x = snap.ctrl[i].x + dx; p.y = snap.ctrl[i].y + dy; });
      });
    }
    ed.dirty = true;
    draw();
  }
  function syncWarper(s) { s.warper = defaultWarper(s.OutputRect.vertices); }

  addEventListener('mouseup', () => {
    if (!ed.drag) return;
    const wasMarquee = ed.drag.kind === 'marquee';
    ed.drag = null;
    if (!wasMarquee) persist();
    draw();
  });

  stage.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const v = viewAt(mx), before = toModel(v, mx, my);
    ed.fit = false;
    ed.zoom = clamp(ed.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 0.05, 40);
    computeViews();
    const v2 = viewAt(mx), after = toModel(v2, mx, my);
    ed.pan.x += (after.x - before.x) * v2.scale;
    ed.pan.y += (after.y - before.y) * v2.scale;
    draw();
  }, { passive: false });

  stage.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const v = viewAt(mx), h = hitTest(v, mx, my);
    if (h && !ed.sel.has(h.slice)) { ed.sel.clear(); ed.sel.add(h.slice); tree_render(); side_render(); }
    if (!h && !ed.sel.size) return;
    /* the same contextual menu the slice list carries — the manual has it on
       both the list and the stage */
    showMenu(ev.clientX, ev.clientY, listMenu(V.ctx, sliceAction));
    draw();
  });

  /* ---- keyboard --------------------------------------------------------- */
  function onKey(ev) {
    if (!host.isConnected) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (ev.code === 'Space') { ed.spaceDown = ev.type === 'keydown'; return; }
    if (ev.type !== 'keydown') return;
    const step = ev.shiftKey ? 10 : 1;
    const nudge = (dx, dy) => {
      selected().forEach(s => {
        rectOf(s).vertices.forEach(p => { p.x += dx; p.y += dy; });
        if (ed.view === 'output') s.warper.bezier.vertices.forEach(p => { p.x += dx; p.y += dy; });
      });
      ed.dirty = true; persist(); draw();
    };
    switch (ev.key) {
      case 'ArrowLeft':  nudge(-step, 0); ev.preventDefault(); break;
      case 'ArrowRight': nudge(step, 0);  ev.preventDefault(); break;
      case 'ArrowUp':    nudge(0, -step); ev.preventDefault(); break;
      case 'ArrowDown':  nudge(0, step);  ev.preventDefault(); break;
      case 'Delete': case 'Backspace': removeSelected(); ev.preventDefault(); break;
      case 'f': case 'F': ed.fit = true; ed.pan = { x: 0, y: 0 }; draw(); break;
      case 'a': case 'A':
        if (ev.ctrlKey || ev.metaKey) { slices().forEach(s => ed.sel.add(s.uniqueId)); tree_render(); side_render(); draw(); ev.preventDefault(); }
        break;
      case 'd': case 'D':
        if (ev.ctrlKey || ev.metaKey) { duplicateSelected(); ev.preventDefault(); }
        break;
      case 'Escape': ed.sel.clear(); hideMenu(); tree_render(); side_render(); draw(); break;
      case '1': ed.tool = 'Transform'; syncChips(); draw(); break;
      case '2': ed.tool = 'Edit Points'; syncChips(); draw(); break;
      case '3': ed.tool = 'Draw'; syncChips(); draw(); break;
    }
  }
  addEventListener('keydown', onKey); addEventListener('keyup', onKey);

  /* ---- the slice context actions, for real ------------------------------ */
  function sliceAction(a) {
    /* the two that act on the selection as a whole, not slice by slice */
    if (a === 'Duplicate') return duplicateSelected();
    if (a === 'Delete')    return removeSelected();

    const list = selected();
    const sp = space();
    /* move every vertex by the same offset, so the shape is kept */
    const shift = (s, dx, dy) => {
      rectOf(s).vertices.forEach(p => { p.x += dx; p.y += dy; });
      if (ed.view === 'output') s.warper.bezier.vertices.forEach(p => { p.x += dx; p.y += dy; });
    };
    /* scale the shape into a box, the way the half presets do */
    const fitTo = (s, x0, y0, x1, y1) => {
      const b = polyBounds(rectOf(s).vertices);
      const sx = (b.x1 - b.x0) ? (x1 - x0) / (b.x1 - b.x0) : 1;
      const sy = (b.y1 - b.y0) ? (y1 - y0) / (b.y1 - b.y0) : 1;
      rectOf(s).vertices.forEach(p => {
        p.x = x0 + (p.x - b.x0) * sx; p.y = y0 + (p.y - b.y0) * sy;
      });
      if (ed.view === 'output') syncWarper(s);
    };
    list.forEach(s => {
      const whole = [P(0, 0), P(sp.w, 0), P(sp.w, sp.h), P(0, sp.h)];
      const b = polyBounds(rectOf(s).vertices);
      switch (a) {
        case 'Center X': shift(s, (sp.w - (b.x0 + b.x1)) / 2, 0); break;
        case 'Center Y': shift(s, 0, (sp.h - (b.y0 + b.y1)) / 2); break;
        /* mirror places the slice on the opposite side of the centre axis */
        case 'Mirror X': shift(s, sp.w - (b.x0 + b.x1), 0); break;
        case 'Mirror Y': shift(s, 0, sp.h - (b.y0 + b.y1)); break;
        case 'Left Half':   fitTo(s, 0, 0, sp.w / 2, sp.h); break;
        case 'Right Half':  fitTo(s, sp.w / 2, 0, sp.w, sp.h); break;
        case 'Top Half':    fitTo(s, 0, 0, sp.w, sp.h / 2); break;
        case 'Bottom Half': fitTo(s, 0, sp.h / 2, sp.w, sp.h); break;
        case 'Match Input Shape':
          s.OutputRect.vertices = s.InputRect.vertices.map(p => P(p.x, p.y)); syncWarper(s); break;
        case 'Match Output Shape':
          s.InputRect.vertices = s.OutputRect.vertices.map(p => P(p.x, p.y)); break;
        case 'Swap Input Output Shape': {
          const t = s.InputRect.vertices;
          s.InputRect.vertices = s.OutputRect.vertices; s.OutputRect.vertices = t; syncWarper(s); break;
        }
        case 'Whole Area':
          rectOf(s).vertices = whole; if (ed.view === 'output') syncWarper(s); break;
        case 'Make Circle':
          rectOf(s).vertices = regular(24, polyBounds(rectOf(s).vertices)); break;
        case 'Make Triangle':
          rectOf(s).vertices = regular(3, polyBounds(rectOf(s).vertices)); break;
        case 'Bring Forward': {
          const l = slices(), i = l.indexOf(s);
          if (i < l.length - 1) { l.splice(i, 1); l.splice(i + 1, 0, s); } break;
        }
        case 'Send Backwards': {
          const l = slices(), i = l.indexOf(s);
          if (i > 0) { l.splice(i, 1); l.splice(i - 1, 0, s); } break;
        }
        case 'Identify Slices': flashNumbers(); break;
        case 'Show in Output': s.enabled = !s.enabled; break;
      }
    });
    ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }
  function flashNumbers() {
    const was = ed.showNumbers;
    ed.showNumbers = true; draw();
    setTimeout(() => { ed.showNumbers = was; draw(); }, 1400);
  }
  function removeSelected() {
    const l = slices();
    selected().forEach(s => { const i = l.indexOf(s); if (i >= 0) l.splice(i, 1); });
    ed.sel.clear(); ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }
  function duplicateSelected() {
    const l = slices(), made = [];
    selected().forEach(s => {
      const c = JSON.parse(JSON.stringify(s));
      c.uniqueId = nextId(); c.name = s.name + ' copy';
      [c.InputRect.vertices, c.OutputRect.vertices, c.warper.bezier.vertices]
        .forEach(v => v.forEach(p => { p.x += 24; p.y += 24; }));
      l.push(c); made.push(c.uniqueId);
    });
    ed.sel.clear(); made.forEach(id => ed.sel.add(id));
    ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }

  /* ---- menus ------------------------------------------------------------
     The same vocabulary the main window's dropdowns use: a separator, a
     greyed group header, a tick for a state, and a plain item. */
  function showMenu(clientX, clientY, items) {
    menu.innerHTML = items.map((it, i) =>
      it.sep   ? '<div class="ao-msep"></div>'
    : it.group ? `<div class="ao-mgroup">${esc(it.group)}</div>`
      /* dis/title were ignored, so an unusable entry looked exactly like a
         usable one and only announced itself after being clicked. */
    : `<div class="ao-mitem${it.on ? ' on' : ''}${it.dis ? ' dis' : ''}" data-i="${i}"` +
      `${it.title ? ` title="${esc(it.title)}"` : ''}>` +
      `<span class="ao-mchk">${it.on ? '✓' : ''}</span>${esc(it.label)}</div>`).join('');
    menu.hidden = false;
    const r = host.getBoundingClientRect();
    menu.style.left = Math.max(2, Math.min(clientX - r.left, r.width - menu.offsetWidth - 6)) + 'px';
    menu.style.top  = Math.max(2, Math.min(clientY - r.top, r.height - menu.offsetHeight - 8)) + 'px';
    menu.querySelectorAll('.ao-mitem').forEach(n => n.addEventListener('click', () => {
      const it = items[+n.dataset.i];
      if (it && it.dis) { note(it.title || 'Not available.', true); return; }
      hideMenu(); if (it && it.act) it.act();
    }));
  }
  const hideMenu = () => { menu.hidden = true; };
  /* a flat list of labels, where '-' is a separator */
  const listMenu = (labels, act) => labels.map(l =>
    l === '-' ? { sep: 1 } : { label: l, act: () => act(l) });
  addEventListener('mousedown', ev => { if (!menu.hidden && !menu.contains(ev.target)) hideMenu(); }, true);

  /* the plus+ menus, the setup presets and the view options */
  function addSlice(kind) {
    const s = newSlice(kind, screen());
    slices().push(s); ed.sel.clear(); ed.sel.add(s.uniqueId);
    ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }
  function addScreen(kind) {
    ed.model.screens.push(newScreen(kind));
    ed.screenIndex = ed.model.screens.length - 1;
    ed.sel.clear(); ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }
  const SETUPS = ['Default', 'Club: 2 projectors', 'Festival: LED wall', 'Studio: single screen'];
  function presetMenu() {
    return [{ group: 'Screen Setups' }]
      .concat(SETUPS.map(n => ({ label: n, on: ed.setup === n, act: () => {
        ed.setup = n; note(`Screen setup: ${n}`); chrome_render();
      } })))
      .concat([{ sep: 1 }], listMenu(V.preset, a => {
        if (a === 'Save')     note(persist() ? `Saved “${ed.setup}”.` : 'Could not save.');
        else if (a === 'Save As…') {
          const n = prompt('Save this screen setup as', ed.setup);
          if (n) { ed.setup = n.trim(); if (!SETUPS.includes(ed.setup)) SETUPS.push(ed.setup);
            persist(); chrome_render(); note(`Saved “${ed.setup}”.`); }
        } else note('Presets live in Documents/Resolume Avenue-Arena 5/presets/screensetup/');
      }));
  }
  /* the four View Options the manual names, each a tick */
  const VIEW_KEYS = { 'Show Slice Grid': 'sliceGrid', 'Show 8x8 LED Grid': 'ledGrid',
    'Identify Slices': 'identify', 'Show in Output': 'showInOutput' };
  function viewMenu() {
    return [{ group: 'View Options' }].concat(V.viewOpt.map(l => ({
      label: l, on: !!ed[VIEW_KEYS[l]],
      act: () => { ed[VIEW_KEYS[l]] = !ed[VIEW_KEYS[l]]; side_render(); draw(); },
    })), [{ sep: 1 }], [
      { label: 'Show Warp Net',  on: ed.showWarp,     act: () => { ed.showWarp = !ed.showWarp; draw(); } },
      { label: 'Show Guides',    on: ed.showGuides,   act: () => { ed.showGuides = !ed.showGuides; draw(); } },
      { label: 'Show Numbers',   on: ed.showNumbers,  act: () => { ed.showNumbers = !ed.showNumbers; draw(); } },
      { label: 'Show Texture',   on: ed.showTexture,  act: () => { ed.showTexture = !ed.showTexture; draw(); } },
      { label: 'Show Soft Edge', on: ed.showSoftEdge, act: () => { ed.showSoftEdge = !ed.showSoftEdge; draw(); } },
    ]);
  }

  host.querySelectorAll('[data-menu]').forEach(b => b.addEventListener('click', ev => {
    ev.stopPropagation();
    const r = b.getBoundingClientRect();
    const k = b.dataset.menu;
    if (k === 'add')          showMenu(r.left, r.bottom, listMenu(V.add, addSlice));
    else if (k === 'screen')  showMenu(r.left, r.bottom, listMenu(V.screen, addScreen));
    else if (k === 'preset')  showMenu(r.left, r.bottom, presetMenu());
    else if (k === 'view')    showMenu(r.left, r.bottom, viewMenu());
  }));

  /* right-clicking a screen lists every output connected to the machine,
     then the screen's own actions — as the manual describes */
  function screenMenu(sc, clientX, clientY) {
    const items = [{ group: 'Output Device' }];
    /* screens.htm makes THIS the primary gesture: "right click on it on the left
       hand side. You will see a dropdown of all outputs that are connected to
       your computer." It read V.devices — the literal table — so it showed the
       three invented displays and never a real one, while the inspector's Device
       combo beside it had already been switched to deviceGroups(). Two controls
       for one setting, disagreeing about what hardware exists. */
    deviceGroups().forEach(grp => {
      items.push({ sep: 1 }, { group: grp.group });
      grp.items.forEach(it => { const nm = it.label || it; items.push({
        label: nm, on: sc.outputDevice.name === nm,
        dis: !!it.blocked, title: it.reason || '',
        act: () => {
          if (it.blocked) return note(it.reason || 'That output cannot be used.', true);
          /* one output, one screen — the manual: taking an output from another
             screen sets that screen back to virtual */
          ed.model.screens.forEach(o => {
            if (o !== sc && o.outputDevice.name === nm)
              o.outputDevice = { name: 'Virtual', deviceId: 'Virtual', idHash: '',
                kind: 'OutputDeviceVirtual', width: o.outputDevice.width, height: o.outputDevice.height };
          });
          sc.outputDevice = deviceFor(nm, sc.outputDevice);
          ed.dirty = true; persist(); tree_render(); side_render(); draw();
        },
      }); });
    });
    items.push({ sep: 1 });
    V.screenCtx.forEach(a => items.push(a === '-' ? { sep: 1 } : {
      label: a, on: a === 'Fold' ? ed.folded.has(sc) : a === 'Show in Output' ? sc.enabled : false,
      act: () => screenAction(a, sc),
    }));
    showMenu(clientX, clientY, items);
  }
  function screenAction(a, sc) {
    if (a === 'Rename') {
      const n = prompt('Screen name', sc.name);
      if (n) sc.name = n.trim();
    } else if (a === 'Duplicate Screen') {
      const c = JSON.parse(JSON.stringify(sc));
      c.uniqueId = nextId(); c.name = sc.name + ' copy';
      c.layers.forEach(l => { l.uniqueId = nextId(); });
      ed.model.screens.splice(ed.model.screens.indexOf(sc) + 1, 0, c);
    } else if (a === 'Fold') {
      ed.folded.has(sc) ? ed.folded.delete(sc) : ed.folded.add(sc);
    } else if (a === 'Show in Output') {
      sc.enabled = !sc.enabled;
    } else if (a === 'Remove Screen') {
      if (ed.model.screens.length < 2) return note('A setup needs at least one screen.', true);
      ed.model.screens.splice(ed.model.screens.indexOf(sc), 1);
      ed.screenIndex = 0; ed.sel.clear();
    }
    ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }

  /* ---- toolbar wiring ---------------------------------------------------- */
  function syncChips() {
    host.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === ed.tool));
    host.querySelectorAll('[data-stage]').forEach(b => b.classList.toggle('on',
      b.dataset.stage === (ed.view === 'both' ? 'Both' : VIEW_STAGE[ed.view])));
  }
  host.querySelectorAll('[data-tool]').forEach(b =>
    b.addEventListener('click', () => { ed.tool = b.dataset.tool; syncChips(); side_render(); draw(); }));
  /* the stage decides which rect the properties are editing — rectOf() switches
     with it, so the side has to be rebuilt, not just repainted */
  host.querySelectorAll('[data-stage]').forEach(b =>
    b.addEventListener('click', () => {
      ed.view = STAGE_VIEW[b.dataset.stage] || 'both';
      /* the pane the pointer was last in no longer decides anything once the
         stage has been chosen explicitly */
      editMode = null;
      ed.fit = true; ed.pan = { x: 0, y: 0 };
      syncChips(); side_render(); draw();
    }));

  host.querySelector('[data-act=fit]').addEventListener('click', () => {
    ed.fit = true; ed.pan = { x: 0, y: 0 }; draw();
  });
  host.querySelector('[data-act=export]').addEventListener('click', () => {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Exporting output settings'); }
      catch (error) { note(error.message); }
      return;
    }
    const blob = new Blob([toXML(ed.model)], { type: 'text/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'AdvancedOutput.xml';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  host.querySelector('[data-act=import]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    f.text().then(t => {
      try {
        ed.model = fromXML(t);
        ed.screenIndex = 0; ed.sel.clear();
        ed.texture = makeTexture(ed.model.compositionTexture.width, ed.model.compositionTexture.height);
        persist(); chrome_render(); side_render(); draw();
        note(`Read ${ed.model.screens.length} screen${ed.model.screens.length === 1 ? '' : 's'} from ${f.name}.`);
      } catch (e) { note('Could not read that file: ' + e.message, true); }
      fileInput.value = '';
    });
  });
  function note(msg, bad) {
    const n = host.querySelector('.ao-hint');
    n.textContent = msg; n.classList.toggle('bad', !!bad); n.classList.add('on');
    clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove('on'), 4200);
  }

  function chrome_render() {
    host.querySelector('.ao-preset').textContent = ed.setup + ' ▾';
    tree_render();
  }

  /* ---- the screen tree, down the left ------------------------------------
     One row per screen — a toggle in front of it that enables or disables all
     output to that screen, its output device underneath the name, and a fold
     arrow that hides its slices without stopping the output. The screen's
     slices are nested under it, in stacking order, and can be dragged between
     screens; a screen always keeps at least one. */
  function tree_render() {
    tree.innerHTML = ed.model.screens.map((sc, si) => {
      const folded = ed.folded.has(sc);
      const dev = sc.outputDevice || {};
      const rows = folded ? '' : sc.layers.map((x, i) => `
        <div class="ao-item${ed.sel.has(x.uniqueId) ? ' on' : ''}${x.enabled ? '' : ' off'}"
             data-slice="${esc(x.uniqueId)}" data-screen="${si}" draggable="true">
          <span class="ao-num">${i + 1}</span>
          <span class="ao-nm">${esc(x.name)}</span>
          <span class="ao-kind">${esc(x.type === 'DmxSlice' ? 'DMX' : x.mask ? 'mask' : x.warpMode)}</span>
          <span class="ao-eye" data-eye="${esc(x.uniqueId)}" title="Show in Output">${x.enabled ? '◉' : '○'}</span>
        </div>`).join('') || '<div class="ao-none">No slices on this screen.</div>';
      return `
        <div class="ao-screenrow${si === ed.screenIndex ? ' on' : ''}${sc.enabled ? '' : ' off'}"
             data-screenrow="${si}" title="Right-click to pick an output">
          <span class="ao-eye" data-screeneye="${si}" title="Enable output to this screen">${sc.enabled ? '◉' : '○'}</span>
          <span class="ao-fold" data-fold="${si}" title="Fold this screen">${folded ? '▸' : '▾'}</span>
          <span class="ao-screennm">
            <b>${esc(sc.name)}</b>
            <small>${esc(dev.name || dev.kind || 'Virtual')} · ${dev.width || 1920} × ${dev.height || 1080}</small>
          </span>
        </div>
        <div class="ao-slices">${rows}</div>`;
    }).join('');
    wireTree();
  }

  function wireTree() {
    tree.querySelectorAll('[data-screenrow]').forEach(n => {
      const si = +n.dataset.screenrow, sc = ed.model.screens[si];
      n.addEventListener('mousedown', ev => {
        if (ev.target.dataset.fold || ev.target.dataset.screeneye) return;
        if (ev.button === 2) return;
        ed.screenIndex = si; ed.sel.clear(); ed.fit = true;
        tree_render(); side_render(); draw();
      });
      /* double click renames, as it does in the application */
      n.addEventListener('dblclick', ev => {
        if (ev.target.dataset.fold || ev.target.dataset.screeneye) return;
        screenAction('Rename', sc);
      });
      n.addEventListener('contextmenu', ev => {
        ev.preventDefault(); ev.stopPropagation();
        ed.screenIndex = si; tree_render(); side_render(); draw();
        screenMenu(sc, ev.clientX, ev.clientY);
      });
      /* a slice dropped on a screen row moves to that screen */
      n.addEventListener('dragover', ev => { ev.preventDefault(); n.classList.add('drop'); });
      n.addEventListener('dragleave', () => n.classList.remove('drop'));
      n.addEventListener('drop', ev => {
        ev.preventDefault(); n.classList.remove('drop');
        moveSliceToScreen(ev.dataTransfer.getData('text/plain'), si);
      });
    });
    tree.querySelectorAll('[data-fold]').forEach(n => n.addEventListener('click', ev => {
      ev.stopPropagation();
      const sc = ed.model.screens[+n.dataset.fold];
      ed.folded.has(sc) ? ed.folded.delete(sc) : ed.folded.add(sc);
      tree_render();
    }));
    tree.querySelectorAll('[data-screeneye]').forEach(n => n.addEventListener('click', ev => {
      ev.stopPropagation();
      const sc = ed.model.screens[+n.dataset.screeneye];
      sc.enabled = !sc.enabled;
      ed.dirty = true; persist(); tree_render(); draw();
    }));

    tree.querySelectorAll('[data-slice]').forEach(n => {
      n.addEventListener('mousedown', ev => {
        if (ev.target.dataset.eye || ev.button === 2) return;
        const si = +n.dataset.screen;
        if (si !== ed.screenIndex) { ed.screenIndex = si; ed.sel.clear(); }
        else if (!ev.shiftKey) ed.sel.clear();
        ed.sel.add(n.dataset.slice);
        tree_render(); side_render(); draw();
      });
      n.addEventListener('contextmenu', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const si = +n.dataset.screen;
        if (si !== ed.screenIndex) { ed.screenIndex = si; ed.sel.clear(); }
        if (!ed.sel.has(n.dataset.slice)) { ed.sel.clear(); ed.sel.add(n.dataset.slice); }
        tree_render(); side_render(); draw();
        showMenu(ev.clientX, ev.clientY, listMenu(V.ctx, sliceAction));
      });
      n.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', n.dataset.slice);
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
    tree.querySelectorAll('[data-eye]').forEach(n => n.addEventListener('click', ev => {
      ev.stopPropagation();
      const s = anySlice(n.dataset.eye); if (!s) return;
      s.enabled = !s.enabled;
      ed.dirty = true; persist(); tree_render(); side_render(); draw();
    }));
  }

  /* a screen must keep at least one slice, so the last one will not move */
  function moveSliceToScreen(id, si) {
    const to = ed.model.screens[si];
    const from = ed.model.screens.find(sc => sc.layers.some(l => l.uniqueId === id));
    if (!to || !from || from === to) return;
    if (from.layers.length < 2) return note('A screen needs at least one slice.', true);
    const s = from.layers.find(l => l.uniqueId === id);
    from.layers.splice(from.layers.indexOf(s), 1);
    to.layers.push(s);
    ed.screenIndex = si; ed.sel.clear(); ed.sel.add(id);
    ed.dirty = true; persist(); tree_render(); side_render(); draw();
  }
  const anySlice = id => {
    for (const sc of ed.model.screens) {
      const s = sc.layers.find(l => l.uniqueId === id);
      if (s) return s;
    }
    return null;
  };

  /* ---- the properties side ---------------------------------------------- */
  function row(label, html) {
    /* Arena's inspector is a property *table*: a label cell and a value cell
       per row, each with its own background, separated by hairlines. The value
       needs its own cell for that grid to hold — several rows put a control
       and a readout side by side, and without a wrapper those became extra
       columns and the rows stopped lining up with each other. */
    return `<div class="ao-row"><label>${esc(label)}</label>` +
           `<div class="ao-cell">${html}</div></div>`;
  }
  const optionTags = (list, cur) => list.map(o =>
    `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');

  /* the level controls the manual lists under Adjustments, as one block */
  function levelRows(o, attr) {
    const lv = (label, key, min, max, dp) => row(label,
      `<input type="range" min="${min}" max="${max}" step="0.01" ${attr}="${key}" value="${o[key]}">` +
      `<span class="ao-val">${(+o[key]).toFixed(dp)}</span>`);
    return lv('Opacity', 'opacity', 0, 1, 2) + lv('Brightness', 'brightness', 0, 2, 2) +
           lv('Contrast', 'contrast', 0, 2, 2) +
           lv('Red', 'r', 0, 1, 2) + lv('Green', 'g', 0, 1, 2) + lv('Blue', 'b', 0, 1, 2);
  }

  function side_render() {
    const s = selected()[0], sc = screen(), n = selected().length;
    normalise(ed.model);
    side.innerHTML =
      `<div class="ao-sec"><h4>Screen</h4>
        ${row('Name', `<input type="text" data-s="name" value="${esc(sc.name)}">`)}
        ${row('Type', `<span class="ao-ro">${esc(sc.type)}</span>`)}
        ${/* A screen loaded from a file carries a device this list has never
              heard of — Resolume writes names like "Screen 1" with deviceId
              "VirtualScreen 1". Matching on the label alone left nothing
              selected, so the browser showed the first option and every
              imported screen appeared to be on Display 1. Show the screen's
              actual device as an option of its own when it is not enumerated. */''}
        ${row('Device', (() => {
          const cur = sc.outputDevice.name || '';
          const groups = deviceGroups();
          const known = deviceLookup().has(cur);
          const own = known ? '' : `<optgroup label="From file"><option selected>${esc(cur || 'Virtual')}</option></optgroup>`;
          return `<select data-s="device">${own}${
            groups.map(grp => `<optgroup label="${esc(grp.group)}">${
              grp.items.map(it => { const nm = it.label || it;
                /* a display we know exists but cannot measure is offered and
                   disabled, with the reason on hover — never silently omitted */
                return `<option${known && nm === cur ? ' selected' : ''}${
                  it.blocked ? ` disabled title="${esc(it.reason)}"` : ''}>${esc(nm)}</option>`; }).join('')
            }</optgroup>`).join('')}</select>`;
        })())}
        ${row('Class', `<span class="ao-ro" title="The OutputDevice class Resolume writes for this screen">${esc(sc.outputDevice.kind || 'OutputDeviceVirtual')}</span>`)}
        ${row('Width',  `<input type="number" data-s="w" value="${sc.outputDevice.width}">`)}
        ${row('Height', `<input type="number" data-s="h" value="${sc.outputDevice.height}">`)}
        ${row('Delay', `<input type="range" min="0" max="100" step="1" data-s="delay"
           value="${sc.delay}"><span class="ao-val">${sc.delay} ms</span>`)}
        ${sc.type === 'DmxScreen' ? row('Lumiverse',
          `<select data-s="lumi">${optionTags(V.lumi, V.lumi[+sc.lumiverseId || 0])}</select>`) : ''}
        ${sc.type === 'DmxScreen' ? row('Auto Span',
          `<button class="ao-tog ${sc.autoSpan ? 'on' : ''}" data-s="autoSpan">${sc.autoSpan ? 'On' : 'Off'}</button>`) : ''}
        ${sc.type === 'DmxScreen' ? row('Align Output',
          `<button class="ao-tog ${sc.alignOutput ? 'on' : ''}" data-s="alignOutput">${sc.alignOutput ? 'On' : 'Off'}</button>`) : ''}
        ${row('Remove', `<button class="ao-btn danger" data-s="rmScreen">Remove Screen</button>`)}
      </div>` +

      `<div class="ao-sec"><h4>Screen Levels</h4>${levelRows(sc, 'data-sl')}</div>` +

      `<div class="ao-sec"><h4>Show Canvas</h4>
        ${row('Width',  `<input type="number" data-c="w" value="${ed.model.compositionTexture.width}">`)}
        ${row('Height', `<input type="number" data-c="h" value="${ed.model.compositionTexture.height}">`)}
        ${row('Soft Edge Power', `<input type="range" min="0.2" max="6" step="0.05"
           data-c="pow" value="${ed.model.softEdgePower}"><span class="ao-val">${(+ed.model.softEdgePower).toFixed(2)}</span>`)}
        ${/* the other two numbers Arena's blend curve takes; Luminance at 0.5
              is what makes two facing ramps sum back to full brightness */''}
        ${row('Blend Luminance', `<input type="range" min="0" max="1" step="0.01"
           data-c="lum" value="${ed.model.softEdgeLuminance}"><span class="ao-val">${(+ed.model.softEdgeLuminance).toFixed(2)}</span>`)}
        ${row('Blend Gamma', `<input type="range" min="0.2" max="4" step="0.05"
           data-c="gam" value="${ed.model.softEdgeGamma}"><span class="ao-val">${(+ed.model.softEdgeGamma).toFixed(2)}</span>`)}
      </div>` +

      (!s ? `<div class="ao-sec"><div class="ao-none">Select a slice to edit it.</div></div>` :
      /* Ordered as Arena orders it. In Resolume's own Slice inspector the
         header is the slice's name and INPUT SOURCE is the first row — before
         anything about warping — because the first question about a slice is
         what it is showing, and only then where it lands. Ignore Opacity and
         Ignore Bypass/Solo sit directly beneath it because slice-routing.htm
         makes them a sub-section of routing, not free-standing toggles.

         Warp and its control grid are Output Transformation work, so they only
         appear on that stage; Filter is how the *input* is sampled and stays. */
      `<div class="ao-sec"><h4>${esc(s.name || 'Slice')}${n > 1 ? ` · ${n} selected` : ''}</h4>
        ${/* slice-routing.htm — "By default, slices take the complete Resolume
              composition as input. You can assign which input is used for a
              slice on the Input Source dropdown on the right hand side of the
              Input Selection stage." The list of layers, groups, buses and
              screens comes from the running composition over ArenaBus; without
              a host it falls back to just the composition. */''}
        ${row('Input Source', `<select data-l="inputSource" title="What this slice takes as its input">${
          inputSourceOptions(s.inputSource || 'composition', ed.model)
        }</select>`)}
        ${(s.inputSource && s.inputSource !== 'composition') ? row('', `<span class="ao-note">
           Routed input bypasses the Show: Layer and Clip effects still apply,
           blend modes and Show effects do not.</span>`) : ''}
        ${(s.inputSource && s.inputSource.startsWith('layer:')) ?
          row('Ignore Opacity', `<button class="ao-tog ${s.ignoreOpacity ? 'on' : ''}" data-l="ignoreOpacity"
             title="Take the layer before its own opacity is applied">${s.ignoreOpacity ? 'On' : 'Off'}</button>`) +
          row('Ignore B/S', `<button class="ao-tog ${s.ignoreBypass ? 'on' : ''}" data-l="ignoreBypass"
             title="Take the layer even when it is bypassed or another layer is soloed">${s.ignoreBypass ? 'On' : 'Off'}</button>`)
          : ''}
        ${row('Name', `<input type="text" data-l="name" value="${esc(s.name)}">`)}
        ${row('Filter', `<select data-l="filterMode">${optionTags(V.filter, s.filterMode)}</select>`)}
        ${modeNow() === 'input' ? '' :
          row('Warp', `<select data-l="warpMode">${optionTags(V.warp, s.warpMode)}</select>`)}
        ${(modeNow() !== 'input' && (s.warpMode === 'Bezier' || s.warpMode === 'Linear Grid')) ? row('Grid',
          `<input type="number" min="2" max="12" data-l="cw" value="${s.warper.bezier.controlWidth}" style="width:44px">
           <span class="ao-x">×</span>
           <input type="number" min="2" max="12" data-l="ch" value="${s.warper.bezier.controlHeight}" style="width:44px">
           <button class="ao-btn" data-l="resetWarp">Reset</button>`) : ''}
        ${row('Soft Edge', `<button class="ao-tog ${s.softEdgeEnable ? 'on' : ''}" data-l="softEdgeEnable">${s.softEdgeEnable ? 'On' : 'Off'}</button>`)}
        ${row('Enabled', `<button class="ao-tog ${s.enabled ? 'on' : ''}" data-l="enabled">${s.enabled ? 'On' : 'Off'}</button>`)}
        ${row('Opacity', `<input type="range" min="0" max="1" step="0.01" data-l="opacity" value="${s.opacity}"><span class="ao-val">${Math.round(s.opacity * 100)}%</span>`)}
        ${row('Vertices', `<span class="ao-ro">${rectOf(s).vertices.length}</span>
           <button class="ao-btn" data-l="addVertex" title="Add a point">+</button>
           <button class="ao-btn" data-l="delVertex" title="Remove the last point">−</button>`)}
      </div>` +

      /* the manual's Slice Options — Output Transformation stage only */
      (ed.view === 'input' ? '' : `<div class="ao-sec"><h4>Slice Options</h4>
        ${row('Flip', `<button class="ao-tog ${s.flipH ? 'on' : ''}" data-l="flipH" title="Flip horizontally">↔</button>
           <button class="ao-tog ${s.flipV ? 'on' : ''}" data-l="flipV" title="Flip vertically">↕</button>`)}
        ${row('Is Key', `<button class="ao-tog ${s.isKey ? 'on' : ''}" data-l="isKey"
           title="Replace the alpha channel with luminance">${s.isKey ? 'On' : 'Off'}</button>`)}
        ${row('Black BG', `<button class="ao-tog ${s.blackBG ? 'on' : ''}" data-l="blackBG"
           title="Render this slice over black, whatever is playing">${s.blackBG ? 'On' : 'Off'}</button>`)}
      </div>
      <div class="ao-sec"><h4>Slice Colour</h4>${levelRows(s, 'data-lv')}</div>`) +

      (s.fixture ? `<div class="ao-sec"><h4>DMX Fixture</h4>
        ${row('Fixture', `<select data-f="uuid">${
          [{ uuid: '', name: '(none)' }].concat((RA().fixtures || []).map(f =>
            ({ uuid: f.uuid || f.name, name: f.name }))).map(f =>
            `<option value="${esc(f.uuid)}"${f.uuid === s.fixture.uuid ? ' selected' : ''}>${esc(f.name)}</option>`).join('')
        }</select>`)}
        ${row('Colour Space', `<select data-f="colorSpace">${optionTags(V.space, s.fixture.colorSpace)}</select>`)}
        ${row('Pixels', `<input type="number" min="1" max="4096" data-f="pixels" value="${s.fixture.pixels}">`)}
      </div>` : '') +

      `<div class="ao-sec"><h4>Geometry</h4>
        <div class="ao-verts">${rectOf(s).vertices.map((p, i) =>
          `<div class="ao-vrow"><span>${i}</span>
            <input type="number" step="0.5" data-v="${i}" data-axis="x" value="${Math.round(p.x * 100) / 100}">
            <input type="number" step="0.5" data-v="${i}" data-axis="y" value="${Math.round(p.y * 100) / 100}">
          </div>`).join('')}</div>
        <div class="ao-note">${ed.view === 'input'
          ? 'Input Selection: the region taken from the Show canvas.'
          : 'Output Transformation: where it lands on the device.'}</div>
      </div>` +

      /* the View Options themselves live in the View ▾ dropdown, as they do in
         the application; only the warp density belongs to the selection */
      `<div class="ao-sec"><h4>Warp Mesh</h4>
        ${row('Mesh', `<input type="range" min="2" max="40" step="1" data-o="mesh" value="${ed.mesh}"><span class="ao-val">${ed.mesh}</span>`)}
      </div>`);

    wireSide();
  }

  function wireSide() {
    const sc = screen();
    const commit = () => { ed.dirty = true; persist(); draw(); reportSources(); };

    side.querySelectorAll('[data-s]').forEach(n => {
      const k = n.dataset.s;
      const ev = n.tagName === 'BUTTON' ? 'click' : 'change';
      n.addEventListener(ev, () => {
        if (k === 'name') sc.name = n.value;
        else if (k === 'w') sc.outputDevice.width = +n.value || 1920;
        else if (k === 'h') sc.outputDevice.height = +n.value || 1080;
        else if (k === 'delay') sc.delay = +n.value;
        else if (k === 'device') {
          /* the same rule the right-click list follows: one output, one screen */
          ed.model.screens.forEach(o => {
            if (o !== sc && o.outputDevice.name === n.value)
              o.outputDevice = Object.assign({}, o.outputDevice,
                { name: 'Virtual', deviceId: 'Virtual', kind: 'OutputDeviceVirtual' });
          });
          sc.outputDevice = deviceFor(n.value, sc.outputDevice);
        }
        else if (k === 'lumi') sc.lumiverseId = String(V.lumi.indexOf(n.value));
        else if (k === 'autoSpan' || k === 'alignOutput') sc[k] = !sc[k];
        else if (k === 'rmScreen') {
          if (ed.model.screens.length < 2) return note('A setup needs at least one screen.', true);
          ed.model.screens.splice(ed.screenIndex, 1);
          ed.screenIndex = 0; ed.sel.clear();
        }
        commit(); chrome_render(); side_render();
      });
    });

    /* screen levels — Opacity, Brightness, Contrast, R, G, B */
    side.querySelectorAll('[data-sl]').forEach(n => n.addEventListener('input', () => {
      sc[n.dataset.sl] = +n.value; commit(); side_render();
    }));

    side.querySelectorAll('[data-c]').forEach(n => n.addEventListener('input', () => {
      const k = n.dataset.c;
      if (k === 'pow') ed.model.softEdgePower = +n.value;
      if (k === 'lum') ed.model.softEdgeLuminance = +n.value;
      if (k === 'gam') ed.model.softEdgeGamma = +n.value;
      else {
        ed.model.compositionTexture[k === 'w' ? 'width' : 'height'] = +n.value || 1920;
        ed.texture = makeTexture(ed.model.compositionTexture.width, ed.model.compositionTexture.height);
        /* The other half of the link. The composition texture is the
           composition's resolution, so setting it here has to set it there —
           the host applies it through the engine and it comes back to every
           window on the next snapshot. `setCompSize` has been handled in
           app.js all along; nothing had ever sent it. */
        if (BUS) BUS.send({ op: 'setCompSize',
                            width:  ed.model.compositionTexture.width,
                            height: ed.model.compositionTexture.height });
      }
      commit(); side_render();
    }));

    const s = selected()[0];
    if (!s) return;
    side.querySelectorAll('[data-l]').forEach(n => {
      const k = n.dataset.l;
      const ev = n.tagName === 'BUTTON' ? 'click' : (n.type === 'range' ? 'input' : 'change');
      n.addEventListener(ev, () => {
        selected().forEach(t => {
          if (k === 'name') t.name = n.value;
          else if (k === 'warpMode') { t.warpMode = n.value; if (!t.warper.bezier.vertices.length) syncWarper(t); }
          else if (k === 'filterMode') t.filterMode = n.value;
          else if (k === 'softEdgeEnable' || k === 'enabled' ||
                   k === 'flipH' || k === 'flipV' || k === 'isKey' || k === 'blackBG' ||
                   k === 'ignoreOpacity' || k === 'ignoreBypass') t[k] = !t[k];
          /* slice-routing.htm — routing a slice to a layer or group */
          else if (k === 'inputSource') t.inputSource = n.value;
          else if (k === 'opacity') t.opacity = +n.value;
          else if (k === 'cw' || k === 'ch') regrid(t, k === 'cw' ? +n.value : null, k === 'ch' ? +n.value : null);
          else if (k === 'resetWarp') syncWarper(t);
          else if (k === 'addVertex') {
            const v = rectOf(t).vertices;
            v.splice(1, 0, lerp(v[0], v[1] || v[0], 0.5));
          } else if (k === 'delVertex') {
            const v = rectOf(t).vertices;
            if (v.length > 3) v.pop();
          }
        });
        commit(); tree_render(); side_render();
      });
    });
    /* slice colour — applied to every selected slice, as the manual allows */
    side.querySelectorAll('[data-lv]').forEach(n => n.addEventListener('input', () => {
      selected().forEach(t => { t[n.dataset.lv] = +n.value; });
      commit(); side_render();
    }));
    side.querySelectorAll('[data-f]').forEach(n => n.addEventListener('change', () => {
      const k = n.dataset.f;
      selected().forEach(t => { if (t.fixture) t.fixture[k] = k === 'pixels' ? +n.value : n.value; });
      commit(); side_render();
    }));
    side.querySelectorAll('[data-v]').forEach(n => n.addEventListener('change', () => {
      const i = +n.dataset.v, ax = n.dataset.axis;
      const v = rectOf(s).vertices[i]; if (!v) return;
      v[ax] = +n.value;
      if (ed.view === 'output' && s.warpMode === 'Transform') syncWarper(s);
      commit(); side_render();
    }));
    side.querySelectorAll('[data-o]').forEach(n => {
      const k = n.dataset.o;
      n.addEventListener(n.tagName === 'BUTTON' ? 'click' : 'input', () => {
        if (k === 'mesh') ed.mesh = +n.value; else ed[k] = !ed[k];
        draw(); side_render();
      });
    });
  }

  /* resize the control net, keeping the shape it currently describes */
  function regrid(s, cw, ch) {
    const b = s.warper.bezier;
    const nw = clamp(cw || b.controlWidth, 2, 12), nh = clamp(ch || b.controlHeight, 2, 12);
    const sample = (u, v) => patchPoint(b.vertices, b.controlWidth, b.controlHeight, u, v);
    const out = [];
    for (let j = 0; j < nh; j++)
      for (let i = 0; i < nw; i++) out.push(sample(i / (nw - 1), j / (nh - 1)));
    s.warper.bezier = { controlWidth: nw, controlHeight: nh, vertices: out };
  }

  /* ---- live thumbnail composite, when Arena is there --------------------- */
  let liveTimer = null;
  function pollLive() {
    if (!AL || AL.status !== 'live') { ed.live = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { ed.live = img; draw(); };
    img.onerror = () => { ed.live = null; };
    img.src = `http://${AL.host()}/api/v1/composition/clips/selected/thumbnail?t=` + Date.now();
  }

  /* Tell the host which sources this window is drawing from. Only this side
     knows how the slices are routed, so only this side can ask — and asking
     keeps the host from rendering layers nobody is looking at.

     The two overrides are per source rather than per slice, because the host
     renders a source once. If any slice wants the layer as the composition
     sees it, that is what gets sent; "ignore" only wins when every slice on
     that source ignores (slice-routing.htm > Ignore Opacity and Bypass/Solo). */
  function reportSources() {
    if (!BUS) return;
    const seen = new Map();
    /* A screen's slices are its `layers` — Resolume's own AdvancedOutput.xml
       calls them that, and the model follows the file rather than the UI word. */
    (ed.model.screens || []).forEach(sc => (sc.layers || []).forEach(s => {
      if (s.enabled === false) return;
      const id = s.inputSource || 'composition';
      const cur = seen.get(id) || { id, ignoreOpacity: true, ignoreBypass: true };
      cur.ignoreOpacity = cur.ignoreOpacity && !!s.ignoreOpacity;
      cur.ignoreBypass  = cur.ignoreBypass  && !!s.ignoreBypass;
      seen.set(id, cur);
    }));
    /* the Input Selection stage draws the composition whatever the slices do */
    if (!seen.has('composition'))
      seen.set('composition', { id: 'composition', ignoreOpacity: false, ignoreBypass: false });
    BUS.send({ op: 'needSources', clientId: SOURCE_CLIENT_ID,
               intent: 'preview', sources: [...seen.values()] });
  }

  /* ---- go ---------------------------------------------------------------- */
  chrome_render(); syncChips(); side_render(); reportSources();
  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);
  draw();
  if (opts.live !== false) { pollLive(); liveTimer = setInterval(pollLive, 2000); }

  const api = {
    editor: ed,
    /* Repaint everything a snapshot can affect: the slice tree, the inspector
       (its Input Source list is built from the composition's layers and
       groups) and the canvas. Exposed because the bus listener lives at module
       scope and cannot see these. */
    refresh() {
      try { tree_render(); } catch (e) { console.error('ao tree', e); }
      try { side_render(); } catch (e) { console.error('ao side', e); }
      try { draw(); }        catch (e) { console.error('ao draw', e); }
      try { reportSources(); } catch (e) { console.error('ao sources', e); }
    },
    /* canvas only — a new frame does not change the tree or the inspector */
    repaint() { try { draw(); } catch (e) { console.error('ao draw', e); } },
    /* Adopt the composition's resolution. The texture is rebuilt because every
       slice samples from it, and the views re-laid-out because the input pane
       is drawn at the texture's aspect. */
    setCompositionTexture(w, h) {
      if (!w || !h) return;
      if (ed.model.compositionTexture.width === w &&
          ed.model.compositionTexture.height === h) return;
      ed.model.compositionTexture.width  = w;
      ed.model.compositionTexture.height = h;
      ed.texture = makeTexture(w, h);
      persist();
    },
    destroy() {
      ro.disconnect();
      if (liveTimer) clearInterval(liveTimer);
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKey);
      const i = MOUNTED.indexOf(api); if (i >= 0) MOUNTED.splice(i, 1);
    },
    exportXML: () => toXML(ed.model),
  };

  /* Adopt the composition's size at mount too, not only on the next change —
     a window opened after the composition was resized would otherwise sit at
     the wrong texture until something else moved. */
  MOUNTED.push(api);
  if (COMP && COMP.width && COMP.height) api.setCompositionTexture(COMP.width, COMP.height);

  return api;
}

/* =========================================================================
   panel registration
   ========================================================================= */
if (window.Workspace) {
  window.Workspace.register('AdvancedOutput', {
    title: 'SHOWAVE Map',
    build(host) { host._ao = mount(host); },
    destroy(host) { if (host._ao) host._ao.destroy(); },
  });
}

return { mount, toXML, fromXML, fromDecoded, blankModel,
         geometry: { unitToQuad, applyH, patchPoint, gridPoint, quadLerp, pointInPoly, regular } };
})();
