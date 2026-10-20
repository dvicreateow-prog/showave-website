/* ===========================================================================
   openlive-output-editor.js — the two LIVE display windows of Advanced Output.
   ---------------------------------------------------------------------------
   Arena's Advanced Output is not a diagram. Both of its stages are GL views
   (binary: ScreenSetupGlView::addEditor, "Input Editor", "Output Editor",
   ScreenRenderer::renderScreen) showing content that is running:

     INPUT SELECTION   "The Input Selection stage shows a preview of your
                       composition output."                [input-selection.htm]
                       Every number on this stage is expressed against that
                       composition raster — Arena's own help for
                       InputAdvancedScreenSetupComponent X/Y says "Position of
                       the middle point of the slice ... RELATIVE TO THE
                       COMPOSITION", and for ScreenLayerInputParams Width/Height
                       "the size of the area of the composition you will use
                       for input."

     OUTPUT TRANSFORM  the SCREEN DEVICE RASTER, in output pixels — Arena help
                       for OutputAdvancedScreenSetupComponent Width/Height:
                       "This defines the size IN THE OUTPUT"; X/Y: "relative to
                       the output". The manual never says in one sentence what
                       this canvas *displays* (see MANUAL-SILENT, below), so
                       this file makes the only choice that can be checked
                       against the shipped shader: it draws the slices through
                       the REAL renderer — openlive-screen-render.js, i.e.
                       bezier patch -> homography -> soft-edge alpha — fed by
                       the same live frame the input window is showing.

   SO: no placeholders anywhere. The input window blits the frame the host is
   actually producing this instant; the output window blits the GL result of
   putting that frame through the slice pipeline. Drag a handle and the model
   changes before the next paint in the SAME tick, so the picture moves with
   the mouse rather than one frame behind it.

   CONTRACT
     OpenLiveOutputEditor.mount(hostElement, opts) -> editor
       editor.setSetup(setup)        an OpenLiveScreens setup
       editor.setFrameSource(fn)     fn(kind,id) -> canvas carrying the CURRENT
                                     frame for composition|layer|group|preview|
                                     screen|live
       editor.selectScreen(id) / editor.selectSlice(id)
       editor.stage("input"|"output")
       editor.tick(timeMs)           every rAF; repaints BOTH windows
       editor.destroy()
     additive, not required by the contract but needed to build a real page:
       editor.setSources(list) / editor.refresh() / editor.on(evt,fn)
       editor.setFlag(name,value) / editor.flags / editor.stats / editor.state

   DEPENDENCIES, all feature-detected at call time and never captured at load
   time (openlive-routing.js is being written in parallel and may arrive after
   this file):
       window.OpenLiveScreens        model + geometry            REQUIRED
       window.OpenLiveScreenRender   WebGL2 slice renderer       degrades
       window.OpenLiveRouting        per-slice input routing     optional

   MANUAL-SILENT — every place this file had to choose is marked in-line with
   the words "CLONE CHOICE". The three big ones:
     1. Both stages are shown side by side and both stay live. Arena shows one
        at a time on tabs. stage() still exists and still means something here:
        it picks which window owns the keyboard and gets the emphasis.
     2. The input window's backdrop follows the selected slice's routed source.
        Nothing in the manual or in Arena's help says the backdrop changes;
        the Input Source dropdown is documented, the backdrop's reaction is not.
        Toggleable, defaults on, badge names what you are looking at.
     3. Coarsening a warp grid (Subdivisions -) resamples the surface. Refining
        it (+) is exact de Casteljau and changes nothing you can see.

   Plain classic script. No modules, no libraries, no network.
   =========================================================================== */
window.OpenLiveOutputEditor = (() => {
'use strict';

const VERSION = 1;

/* Resolved per call, never cached: load order is not ours to dictate. */
const SC = () => window.OpenLiveScreens || null;
const GR = () => window.OpenLiveScreenRender || null;
const RT = () => window.OpenLiveRouting || null;
const CHR = () => window.OpenLiveChannelRouting || null;

/* ---------------------------------------------------------------------------
   numbers. Everything in a decoded AdvancedOutput.xml is a STRING, so nothing
   read out of the model may be trusted to be numeric.
   --------------------------------------------------------------------------- */
const isNum = v => typeof v === 'number' && isFinite(v);
function num(v, d) {
  if (typeof v === 'string') { const n = parseFloat(v); return isNum(n) ? n : d; }
  return isNum(v) ? v : d;
}
function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'string') return v !== '0' && v.toLowerCase() !== 'false';
  return !!v;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const P = (x, y) => ({ x: x, y: y });
const fmt = (n, d) => {
  const v = num(n, 0);
  const s = v.toFixed(d === undefined ? 1 : d);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

/* ---- 3x3, row major, same layout OpenLiveScreens.solveHomography returns --- */
const IDENT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function applyH(H, p) {
  if (!H) return P(p.x, p.y);
  const w = H[6] * p.x + H[7] * p.y + H[8];
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w;
  return P((H[0] * p.x + H[1] * p.y + H[2]) * iw, (H[3] * p.x + H[4] * p.y + H[5]) * iw);
}
/* Needed because a bezier control point is stored in SRC space but dragged in
   SCREEN space: the mouse position has to come back through H before it can be
   written to the net. Without this the small handles would run away from the
   cursor on any perspective-warped slice. */
function invert3(H) {
  if (!H) return null;
  const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
          B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
          C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

/* ---- 2D affine, {a,b,c,d,e,f}: x' = a x + c y + e ------------------------- */
const AF = {
  move: (dx, dy) => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }),
  mul: (m, n) => ({                             /* apply n, then m */
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f
  }),
  about: (cx, cy, m) => AF.mul(AF.move(cx, cy), AF.mul(m, AF.move(-cx, -cy))),
  scale: (sx, sy) => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }),
  rot: t => ({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t), e: 0, f: 0 }),
  ap: (m, p) => P(m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f)
};

const d2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
function pointInPoly(p, v) {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const yi = v[i].y, yj = v[j].y;
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < (v[j].x - v[i].x) * (p.y - yi) / ((yj - yi) || 1e-12) + v[i].x) inside = !inside;
  }
  return inside;
}
const bounds = v => v.reduce((r, p) => ({
  x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y),
  x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y)
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/* "type '/3' after the width setting and press return" [input-selection.htm].
   A leading operator continues from the current value; anything else is an
   arithmetic expression. Deliberately not eval(): only digits and operators
   ever reach the Function constructor, and a syntax error keeps the old value. */
function evalNum(expr, cur) {
  const s = String(expr == null ? '' : expr).trim();
  if (!s) return null;
  const body = /^[*/+-]/.test(s) ? '(' + num(cur, 0) + ')' + s : s;
  if (!/^[-+*/(). 0-9]+$/.test(body)) return null;
  try {
    /* eslint-disable-next-line no-new-func */
    const v = Function('"use strict";return (' + body + ')')();
    return isNum(v) ? v : null;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
   chrome. Only the handful of rules advanced-output.css does not already have;
   every value is one of nocturne.css's tokens so this stays the same window.
   --------------------------------------------------------------------------- */
const CSS_ID = 'openlive-output-editor-css';
const CSS = `
/* The stage column is a toolbar row over the panes — the arrangement measured
   off Arena in output-transformation.htm, where zoom / pan / undo / redo and
   the grid toggles sit in a 36px strip directly above the canvas. */
.oo-split{ flex:1; min-width:0; min-height:0; display:flex; flex-direction:column;
  position:relative; }
.oo-toolbar{ flex:0 0 30px; display:flex; align-items:center; gap:4px;
  padding:0 var(--space-2); background:var(--panel);
  border-bottom:1px solid var(--line);
  /* A backstop, not a design. The window has a minimum width that fits this
     row, so it should never clip — but a longer label in some future locale
     must lose its own tail rather than paint over the inspector. */
  overflow:hidden; }
.oo-toolbar .oo-tsp{ flex:1 1 auto; min-width:0; }
.oo-position-bar{ display:flex; flex:0 0 auto; align-items:center; flex-wrap:wrap;
  gap:4px; padding:5px 8px; background:var(--panel); border-bottom:1px solid var(--line); }
.oo-position-bar[hidden]{ display:none; }
.oo-position-name{ max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  margin-right:4px; color:var(--n500); font-size:11px; }
.oo-position-field{ display:flex; align-items:center; gap:4px; padding:2px 5px;
  border:1px solid var(--line); border-radius:4px; font-size:10px; color:var(--n500); }
.oo-position-field:focus-within{ border-color:var(--accent,#008cff); }
.oo-position-field input{ width:48px; min-width:0; padding:1px 0; border:0; outline:0;
  background:transparent; color:var(--txt); font-family:inherit; font-size:11px; font-variant-numeric:tabular-nums; }
.oo-position-bar .ao-btn{ min-width:26px; height:24px; padding:2px 5px; }
.oo-position-bar button[aria-pressed="true"]{ color:var(--accent,#008cff); border-color:var(--accent,#008cff); }
.oo-position-bar button svg{ display:block; width:14px; height:14px; }
.oo-box > .oo-gesture-feedback{ position:absolute; left:50%; bottom:32px; transform:translateX(-50%);
  padding:6px 10px; border-radius:6px; background:#161c2bee; border:1px solid #52617b;
  color:#fff; font:11px system-ui,sans-serif; font-variant-numeric:tabular-nums;
  white-space:nowrap; pointer-events:none; box-shadow:0 3px 12px #0004; }
.oo-gesture-feedback[hidden]{ display:none; }
.oo-box > .ao-readout{ color:#b8c3d6; background:#111827bb; padding:3px 6px; border-radius:3px; }
/* square, glyph-only, and never squeezed to nothing by the flex line */
.oo-toolbar .oo-ico{ flex:0 0 auto; width:25px; padding:0; text-align:center;
  font-size:12px; line-height:1; }
.oo-toolbar > .ao-btn, .oo-toolbar > .ao-chip{ flex:0 0 auto; }
.ao.oo-dmx-stage .oo-toolbar .oo-spatial-only{ display:none; }
.ao.oo-dmx-stage .oo-toolbar .ao-sep{ display:none; }
.ao.oo-dmx-stage #ao-stage-output .oo-badge{ display:none; }
.ao.oo-dmx-stage #ao-stage-output .oo-box{ background:var(--panel); }
.oo-toolbar .ao-composition{ flex:0 0 auto; min-width:36px; text-align:center;
  font-variant-numeric:tabular-nums; }
.oo-panes{ flex:1; min-width:0; min-height:0; display:flex; }
/* Arena shows ONE stage at a time and the tab strip switches it — see
   input-selection.htm and output-transformation.htm, which describe the two as
   stages you move between, not panes you see together. solo is the default;
   View > Split Stages drops it to show both, which is a clone extension. */
.oo-split.solo .oo-pane{ display:none; }
.oo-split.solo .oo-pane.on{ display:flex; }
.oo-pane{ flex:1 1 0; min-width:0; min-height:0; display:flex; flex-direction:column;
  border-right:1px solid var(--line); }
.oo-pane:last-child{ border-right:0; }
/* With one stage showing, the tab already names it — but the feed name and the
   frame time are not duplicated anywhere, so only the title goes. */
.oo-split.solo .oo-panehd b{ display:none; }
.oo-panehd{ flex:0 0 21px; display:flex; align-items:center; gap:6px; padding:0 var(--space-3);
  background:var(--head); border-bottom:1px solid var(--line); cursor:pointer; }
.oo-pane.on .oo-panehd{ box-shadow:inset 0 2px 0 var(--color-accent); }
.oo-panehd b{ font-size:9.5px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--n500); font-weight:500; white-space:nowrap; }
.oo-pane.on .oo-panehd b{ color:var(--a200); }
.oo-panehd .oo-fed{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:9.5px; color:var(--n600); }
.oo-panehd .oo-hud{ margin-left:auto; font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--n600); white-space:nowrap; font-variant-numeric:tabular-nums; }
.oo-box{ flex:1; min-height:0; position:relative; overflow:hidden; background:#0b0c14; }
.oo-box canvas{ display:block; position:absolute; inset:0; touch-action:none; }
.oo-msg{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); max-width:82%;
  padding:10px 14px; border:1px solid var(--red); border-radius:var(--radius-md);
  background:color-mix(in srgb,var(--red) 14%,var(--color-surface)); color:#f3d6d2;
  font-size:11px; line-height:1.45; text-align:center; pointer-events:none; }
.oo-msg b{ display:block; margin-bottom:3px; font-size:9.5px; letter-spacing:.08em;
  text-transform:uppercase; color:#f0b4ac; }
.oo-msg code{ font:10.5px/1.4 ui-monospace,monospace; color:var(--n300); word-break:break-word; }
.oo-badge{ position:absolute; left:var(--space-3); top:var(--space-2); display:flex; gap:4px;
  align-items:center; padding:2px 8px; font-size:9.5px; letter-spacing:.05em;
  text-transform:uppercase; border-radius:999px; pointer-events:none;
  background:color-mix(in srgb,var(--color-surface) 84%,transparent);
  border:1px solid var(--n800); color:var(--n500); }
.oo-badge i{ width:6px; height:6px; border-radius:50%; background:var(--n700); }
.oo-badge.live i{ background:var(--mint); box-shadow:0 0 7px var(--mint); }
.oo-badge.routed{ border-color:var(--a600); color:var(--a200); }
.oo-badge.routed i{ background:var(--color-accent); box-shadow:0 0 7px var(--color-accent); }
/* These three overlays are visual readouts, never pointer surfaces. Keeping
   the rule here as well as in advanced-output.css makes the editor safe when
   it is mounted on its own (which is how the focused interaction tests mount
   it), and prevents a badge/status message from creating a dead drag zone. */
.oo-box > .oo-badge,.oo-box > .oo-msg,.oo-box > .ao-readout{ pointer-events:none; }
.oo-tabs{ display:flex; align-self:stretch; }
.oo-tab{ height:29px; padding:0 var(--space-3); font-size:11px; color:var(--n500);
  background:transparent; border:0; border-right:1px solid var(--line); cursor:pointer; }
.oo-tab:first-child{ border-left:1px solid var(--line); }
.oo-tab:hover{ color:var(--n300); }
.oo-tab.on{ color:var(--a200); box-shadow:inset 0 -2px 0 var(--color-accent);
  background:color-mix(in srgb,var(--color-accent) 12%,transparent); }
.oo-sub{ display:flex; align-items:center; gap:3px; flex:1; min-width:0; }
.oo-sub .ao-btn{ flex:0 0 24px; padding:0; }
.oo-sub b{ flex:1; text-align:center; font-size:10.5px; color:var(--n300);
  font-variant-numeric:tabular-nums; }
.oo-tabrow{ display:flex; gap:0; padding:3px var(--space-3); }
.oo-tabrow button{ flex:1; height:21px; font-size:10px; letter-spacing:.05em; text-transform:uppercase;
  border:1px solid var(--n800); background:transparent; color:var(--n500); cursor:pointer; }
.oo-tabrow button:first-child{ border-radius:var(--radius-sm) 0 0 var(--radius-sm); }
.oo-tabrow button:last-child{ border-left:0; border-radius:0 var(--radius-sm) var(--radius-sm) 0; }
.oo-tabrow button.on{ color:var(--a200); border-color:var(--color-accent);
  background:color-mix(in srgb,var(--color-accent) 16%,transparent); }
.oo-grab{ cursor:grab; } .oo-grabbing{ cursor:grabbing; }

/* ---- slice stack, in the tree -------------------------------------------
   The caption is the only thing in the UI that states which end of the list is
   in front, so it is not decoration. The drop marker is a 2px line rather than
   a moved row: nothing may look reordered until it is. */
.oo-stackcap{ display:flex; justify-content:space-between; gap:8px;
  padding:1px var(--space-3) 1px var(--space-4); font-size:9px; letter-spacing:.06em;
  text-transform:uppercase; color:var(--n600); cursor:help; user-select:none; }
.ao-item[draggable="true"]{ cursor:grab; }
.ao-item.oo-dragging{ opacity:.45; cursor:grabbing; }
.ao-item.oo-dropabove{ box-shadow:inset 0 2px 0 var(--color-accent); }
.ao-item.oo-dropbelow{ box-shadow:inset 0 -2px 0 var(--color-accent); }
/* A menu item Arena does not have. Dimmed and italic is the mood; the badge is
   the statement — a tooltip alone is not a visible mark, and the user has to be
   able to tell which commands exist in the real application without hovering. */
.ao-mitem.oo-mext{ color:var(--n500); font-style:italic;
  display:flex; align-items:center; gap:10px; }
.oo-mexttag{ margin-left:auto; padding:0 4px; border:1px solid var(--n700);
  border-radius:var(--radius-sm); font-size:8px; font-style:normal;
  letter-spacing:.06em; text-transform:uppercase; color:var(--n600);
  white-space:nowrap; }
.ao-mitem.oo-mext:hover .oo-mexttag{ color:var(--n300); border-color:var(--n600); }

/* ---- inspector ----------------------------------------------------------
   advanced-output.css already dims a disabled .ao-tog; these carry the same
   treatment to every other control type AND to the row's label, because an
   inert control whose label still reads at full strength looks broken rather
   than inapplicable. */
.ao-row.oo-off > label{ opacity:.42; }
.ao-row input:disabled,.ao-row select:disabled,.ao-row button:disabled{
  cursor:not-allowed; opacity:.45; }
.oo-ext{ display:inline-block; margin-left:5px; padding:0 4px; border-radius:999px;
  border:1px solid color-mix(in srgb,var(--amber) 55%,var(--n800));
  background:color-mix(in srgb,var(--amber) 12%,transparent);
  color:var(--amber); font-size:8px; letter-spacing:.06em; text-transform:uppercase;
  vertical-align:middle; }
.oo-warn{ margin:3px var(--space-3) var(--space-2); padding:5px 7px;
  border-left:2px solid var(--red); border-radius:0 var(--radius-sm) var(--radius-sm) 0;
  background:color-mix(in srgb,var(--red) 10%,var(--inset)); color:#f0cccc;
  font-size:9.5px; line-height:1.35; }
.oo-shapes{ display:flex; flex-wrap:wrap; gap:3px; flex:1; min-width:0; }
.oo-shapes .ao-btn{ flex:1 1 28%; padding:0 4px; }
.oo-dip{ display:flex; gap:2px; flex:1; min-width:0; }
.oo-dip button{ flex:1 1 0; min-width:0; height:26px; padding:0; font-size:8px;
  border:1px solid var(--n800); border-radius:var(--radius-sm); background:transparent;
  color:var(--n600); cursor:pointer; font-variant-numeric:tabular-nums; }
.oo-dip button.on{ color:var(--a200); border-color:var(--color-accent);
  background:color-mix(in srgb,var(--color-accent) 18%,transparent); }
.oo-pix{ flex:1; min-width:0; height:22px; image-rendering:pixelated;
  border:1px solid var(--n800); border-radius:var(--radius-sm); background:#05060b; }
`;
function injectCSS(doc) {
  if (!doc || doc.getElementById(CSS_ID)) return;
  const s = doc.createElement('style');
  s.id = CSS_ID;
  s.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(s);
}

/* handle radii, in view pixels. homographyDragger.png is the big one and
   warpCtrlDragger.png the small one; Arena ships no size for either, so these
   are the renderer's own defaults so that pick() and the drawing agree. */
const HR = 8, CR = 5, ROT_ARM = 34, ROT_RADIUS = 11, ROT_CORNER_RADIUS = 23;
// One 24-unit monoline glyph for the handle and pointer; no font-dependent symbols.
const ROT_GLYPH = 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1.02 6.74 2.74L21 9M21 3v6h-6';
let rotationGlyphPath = null;
const ROT_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="translate(4 4)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="'+ROT_GLYPH+'" stroke="#0b1018" stroke-width="4"/><path d="'+ROT_GLYPH+'" stroke="#eef2f7" stroke-width="1.75"/></g></svg>') + '") 16 16, crosshair';

const COL = {
  frame: 'rgba(255,255,255,0.16)',
  slice: 'rgba(120,190,255,0.85)', sliceFill: 'rgba(120,190,255,0.09)',
  sel: 'rgba(255,190,60,1)', selFill: 'rgba(255,190,60,0.14)',
  mask: 'rgba(255,90,90,0.90)', bad: 'rgba(255,72,72,1)',
  net: 'rgba(255,255,255,0.30)', ctrl: 'rgba(255,255,255,0.92)',
  corner: 'rgba(255,235,120,1)', tan: 'rgba(150,215,255,0.95)',
  label: 'rgba(255,255,255,0.82)', led: 'rgba(120,190,255,0.10)',
  identify: 'rgba(255,255,255,0.55)', lasso: 'rgba(145,132,217,0.9)',
  dmx: 'rgba(216,151,60,0.95)'
};

/* =========================================================================
   mount
   ========================================================================= */
function mount(host, options) {
  const opts = options || {};
  if (!host || !host.ownerDocument) throw new Error('OpenLiveOutputEditor.mount: no host element');
  const doc = host.ownerDocument;
  injectCSS(doc);

  /* ---- state ------------------------------------------------------------ */
  const ST = {
    setup: opts.setup || (SC() ? SC().setup() : null),
    frameSource: typeof opts.frameSource === 'function' ? opts.frameSource : null,
    sources: Array.isArray(opts.sources) ? opts.sources.slice() : [],
    screenId: null,
    sel: [],                       /* slice ids, [0] is the primary */
    stage: opts.stage === 'output' ? 'output' : 'input',
    mode: 'transform',             /* transformButton / editPointsButton, T toggles */
    routes: new Map(),             /* sliceId -> {kind,id,name,ignoreOpacity,bypass,solo} */
    guides: new Map(),             /* screenId -> {input:Image|null, output:Image|null, opacity} */
    hidden: new Set(),             /* slice ids toggled off in the tree */
    /* Enable Screen / Fold Screen are PARAMS ("Hidden", "folded" in the Screen's
       <Params>), not editor state — they used to live in two Sets here and did
       not survive a save. point is the currently selected warp/mask point, which
       is what Arena's <Params name="Point"> X/Y readout is about. */
    point: null,                   /* {sliceId, handle, index, stage} */
    split: false,                  /* both stages at once — a clone extension, off by default */
    /* Arena enumerates real hardware; a page cannot. Displays and playback-card
       ports therefore come from the host (setDisplays / setCaptureDevices) and
       fall back to what the browser will admit to. */
    displays: Array.isArray(opts.displays) ? opts.displays.slice() : null,
    outputStates: new Map(),          /* browser presentation state, never setup XML */
    captures: Array.isArray(opts.captureDevices) ? opts.captureDevices.slice() : [],
    fixtures: Array.isArray(opts.fixtures) ? opts.fixtures.slice() : null,
    artNetNodes: Array.isArray(opts.artNetNodes) ? opts.artNetNodes.slice() : [],
    /* Half the enable rules in Arena's help are "Arena only" carve-outs. */
    product: /avenue/i.test(String(opts.product || 'Arena')) ? 'Avenue' : 'Arena',
    flags: {
      snap: true,                  /* snapButton / IsSnapping */
      showGrid: false,             /* showGrid / ShowSelectedSliceGrid */
      ledGrid: false,              /* showLedGrid / ShowLEDGrid — also snaps */
      identify: false,             /* IsIdentifying */
      showInOutput: false,
      followRouting: true,         /* CLONE CHOICE — see the header, item 2 */
      testCard: false,             /* Output > Show Test Card */
      outputOff: false             /* Ctrl+Shift+D */
    },
    view: { input: null, output: null },
    drag: null, lasso: null, hover: null, space: false, lockRatio: false,
    /* Repeated clicks at one stage coordinate cycle through coincident Slice
       bodies. It is deliberately editor state, not setup state. */
    pickCycle: null, cycleSuppressDouble: false, nudgeActive: false,
    lastDup: null,                 /* Alt-drag delta, so Ctrl+D can repeat it */
    stamp: 0, timeMs: 0,
    undo: [], redo: [],
    stats: { fps: 0, inMs: 0, outMs: 0, glMs: 0, drawn: 0, tris: 0 },
    /* Paint errors belong to the stage that produced them. A transient Output
       error must not replace Input Selection's Composition coordinate label,
       and a successful repaint clears only its own previous failure. */
    stageError: { input: null, output: null },
    lastError: null, destroyed: false
  };
  const listeners = {};
  const emit = (ev, a) => { (listeners[ev] || []).forEach(f => { try { f(a); } catch (e) { /* a listener must not stop the loop */ } }); };

  /* ---- DOM -------------------------------------------------------------- */
  host.classList.add('ao');
  host.innerHTML = '';
  const E = {};
  const mk = (tag, cls, parent, html) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };

  /* toolbar */
  E.bar = mk('div', 'ao-bar', host);
  E.barL = mk('div', 'ao-bar-left', E.bar);
  E.barC = mk('div', 'ao-bar-center', E.bar);
  E.barR = mk('div', 'ao-bar-right', E.bar);
  E.preset = mk('button', 'ao-btn ao-preset', E.barL, 'Screen Setup ▾');
  E.tabs = mk('div', 'oo-tabs', E.barC);
  E.tabs.setAttribute('role', 'tablist');
  E.tabs.setAttribute('aria-label', 'SHOWAVE Map stages');
  E.tabIn = mk('button', 'oo-tab', E.tabs, 'Input Selection');
  E.tabOut = mk('button', 'oo-tab', E.tabs, 'Output Transformation');
  E.tabIn.setAttribute('role', 'tab');
  E.tabOut.setAttribute('role', 'tab');
  E.tabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const output = e.key === 'ArrowRight' || e.key === 'End';
    setStage(output ? 'output' : 'input');
    (output ? E.tabOut : E.tabIn).focus();
  });
  E.stat = mk('span', 'ao-composition', E.barR, '');
  /* Everything that used to live here as a pill row is now either in the stage
     toolbar (zoom, undo/redo, the two grid toggles — where Arena puts them) or
     in the View menu, which already carried all seven flags as items. Nothing
     was removed; 840px of intrinsic width in a cell that resolves to a fraction
     of that was, and it was painting over its neighbours at any window size
     this app can reach. */

  /* body: tree | two live windows | inspector */
  E.main = mk('div', 'ao-main', host);
  E.tree = mk('div', 'ao-tree', E.main);
  /* The plus menu sits at the TOP of the left column, directly under the preset
     dropdown — measured off the Arena window in output-transformation.htm. It
     was at the foot of the list, which is where the manual's prose puts it
     ("the plus+ menu at the foot of the list") but not where the screenshots
     show it. The screenshots win: they are the interface. */
  E.treefoot = mk('div', 'ao-treefoot ao-treetop', E.tree);
  E.addScreen = mk('button', 'ao-btn ao-plus', mk('div', 'ao-menu-wrap', E.treefoot), '+');
  E.addSlice = mk('button', 'ao-btn ao-plus', mk('div', 'ao-menu-wrap', E.treefoot), '+ Slice ▾');
  E.treelist = mk('div', 'ao-treelist', E.tree);
  E.treelist.setAttribute('role', 'tree');
  E.treelist.setAttribute('aria-label', 'Screens and Slices');
  /* Arena ends the left column with a titled box explaining whatever is under
     the cursor or selected. It is the window's only prose, and this clone has
     the same text already — in title attributes with their manual citations. */
  E.help = mk('div', 'ao-help', E.tree);
  E.helpTitle = mk('div', 'ao-help-t', E.help, '');
  E.helpBody = mk('div', 'ao-help-b', E.help, '');
  E.split = mk('div', 'oo-split solo', E.main);
  /* the stage toolbar [output-transformation.htm]: zoom and history on the
     left, the grid toggles beside them, Transform / Edit Points on the right —
     that last pair stays the per-pane overlay in the canvas corner for now. */
  E.tools = mk('div', 'oo-toolbar', E.split);
  E.zoomOut = mk('button', 'ao-btn', E.tools, '−');
  E.zoomLbl = mk('span', 'ao-composition', E.tools, '100%');
  E.zoomIn = mk('button', 'ao-btn', E.tools, '+');
  E.fit = mk('button', 'ao-btn', E.tools, 'Fit');
  mk('div', 'ao-sep', E.tools);
  /* Glyphs rather than words, because that is what Arena's stage toolbar uses
     and it is the only reason a toolbar of this many controls fits above the
     stage at all. Each keeps its full name and manual citation in the tooltip,
     which is how the rest of this window labels its icons. */
  E.undoBtn = mk('button', 'ao-btn oo-ico', E.tools, '↶');
  E.undoBtn.title = 'Undo (Ctrl+Z)';
  E.redoBtn = mk('button', 'ao-btn oo-ico', E.tools, '↷');
  E.redoBtn.title = 'Redo (Ctrl+Y) [shortcuts.htm]';
  mk('div', 'ao-sep', E.tools);
  const chip = (label, flag, title) => {
    const b = mk('button', 'ao-chip oo-ico', E.tools, label);
    b.title = title || '';
    b.addEventListener('click', () => { setFlag(flag, !ST.flags[flag]); });
    b.dataset.flag = flag;
    return b;
  };
  E.chSnap = chip('⊞', 'snap', 'Snap: slices snap to the stage edges, the centre and to each other. Ctrl-drag suspends it. [input-selection.htm]');
  E.chGrid = chip('▦', 'showGrid', 'Slice Grid: name, bounds, a perspective grid for the slice surface, and a big red cross at the cursor.');
  mk('span', 'oo-tsp', E.tools);
  /* Right end of the stage toolbar, where output-transformation.htm shows them:
     "+ Edit Points" then "Transform", the active one lit. One pair, not one per
     pane — with a single stage showing there is a single thing to switch. */
  E.tPt = mk('button', 'ao-tool', E.tools, '+ Edit Points');
  E.tTr = mk('button', 'ao-tool', E.tools, 'Transform');
  E.tPt.addEventListener('click', () => setMode('points'));
  E.tTr.addEventListener('click', () => setMode('transform'));
  E.position = mk('div', 'oo-position-bar', E.split);
  E.position.setAttribute('role', 'group');
  E.position.setAttribute('aria-label', 'Selection position and size');
  E.positionName = mk('span', 'oo-position-name', E.position);
  E.positionFields = {};
  for (const [key, label, name] of [['cx','X','Centre X'], ['cy','Y','Centre Y'],
      ['w','W','Selection width'], ['h','H','Selection height'], ['rot','°','Selection rotation']]) {
    const row = mk('label', 'oo-position-field', E.position);
    mk('span', '', row, label);
    const input = mk('input', '', row);
    input.type = 'text'; input.inputMode = 'decimal'; input.setAttribute('aria-label', name);
    input.title = name + (key === 'rot' ? ' in degrees' : ' in pixels') + ' · Enter to apply, Escape to cancel · arithmetic supported';
    input.addEventListener('focus', () => { input._selection = positionSignature(); });
    input.addEventListener('change', () => commitPosition(key, input));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitPosition(key, input); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = positionValue(key); input.blur(); }
    });
    E.positionFields[key] = input;
  }
  const positionButton = (name, path, action) => {
    const b = mk('button', 'ao-btn', E.position,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>');
    b.type = 'button'; b.title = name; b.setAttribute('aria-label', name);
    b.addEventListener('click', action); return b;
  };
  E.ratio = positionButton('Lock aspect ratio', '<rect x="6" y="10" width="12" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', () => {
    ST.lockRatio = !ST.lockRatio; syncPositionBar();
  });
  positionButton('Centre horizontally in stage', '<path d="M12 2v20M4 6h16v4H4zM7 14h10v4H7z"/>', () => alignSelection('x'));
  positionButton('Centre vertically in stage', '<path d="M2 12h20M6 4v16h4V4zM14 7v10h4V7z"/>', () => alignSelection('y'));
  E.resetRotation = positionButton('Reset selection rotation', '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>', () => setSelectionFrame({rot:0}, 'reset rotation'));
  E.panes = mk('div', 'oo-panes', E.split);
  E.side = mk('div', 'ao-side', E.main);

  function pane(key, title) {
    const p = mk('div', 'oo-pane', E.panes);
    p.id = 'ao-stage-' + key;
    p.setAttribute('role', 'tabpanel');
    const hd = mk('div', 'oo-panehd', p);
    const titleEl = mk('b', '', hd, title);
    const fed = mk('span', 'oo-fed', hd, '');
    const hud = mk('span', 'oo-hud', hd, '');
    const box = mk('div', 'oo-box', p);
    const cv = mk('canvas', 'ao-canvas', box);
    cv.tabIndex = 0;
    cv.setAttribute('aria-label', title + ' canvas. Drag to move, square handles to resize, outside corners to rotate. Arrow keys nudge; Escape cancels a drag.');
    const badge = mk('div', 'oo-badge', box, '<i></i><span>Show</span>');
    /* Transform / Edit Points used to be an overlay floating in this corner.
       They are in the stage toolbar now, which is where Arena has them. */
    const read = mk('div', 'ao-readout', box, '');
    const feedback = mk('div', 'oo-gesture-feedback', box, '');
    feedback.hidden = true;
    const msg = mk('div', 'oo-msg', box, '');
    msg.style.display = 'none';
    hd.addEventListener('mousedown', () => setStage(key));
    return { key, root: p, head: hd, title: titleEl, fed, hud, box, cv,
      ctx: cv.getContext('2d'), badge, read, msg, feedback };
  }
  E.pIn = pane('input', 'Input Selection');
  E.pOut = pane('output', 'Output Transformation');
  E.tabIn.setAttribute('aria-controls', E.pIn.root.id);
  E.tabOut.setAttribute('aria-controls', E.pOut.root.id);

  E.foot = mk('div', 'ao-foot', host);
  E.footL = mk('div', 'ao-foot-left', E.foot, '');
  E.footC = mk('div', 'ao-foot-center', E.foot);
  E.footR = mk('div', 'ao-foot-right', E.foot);
  E.hint = mk('div', 'ao-hint', E.split);
  /* Arena's footer carries Cancel and Save & Close and nothing else. Export and
     Import stay reachable — the Screen Setup dropdown already offers them as
     "Save as…" and "Load…", which is where advanced-output.htm says setups are
     saved and loaded. They keep their nodes so every existing handler and the
     preset menu's fn() still fire; they are just no longer in the footer, which
     they were overflowing leftward into the status text. */
  E.exportBtn = mk('button', 'ao-btn', null, 'Export XML');
  E.exportBtn.dataset.act = 'export';
  E.importBtn = mk('button', 'ao-btn', null, 'Import XML');
  E.importBtn.dataset.act = 'import';
  E.fit.dataset.act = 'fit';
  [E.zoomOut, E.zoomLbl, E.zoomIn, E.fit, E.chSnap, E.tPt, E.tTr]
    .forEach(el => el.classList.add('oo-spatial-only'));

  /* ---- the renderer ------------------------------------------------------
     Its canvas is OFFSCREEN and sized to the screen device raster, because a
     screen's output is device pixels and nothing else. What the pane shows is
     a fitted blit of that raster — so the picture on screen is literally the
     output, scaled, not a redrawing of it. */
  const glCanvas = doc.createElement('canvas');
  let renderer = null, glReason = 'renderer not created';
  function makeRenderer() {
    const G = GR();
    if (!G || typeof G.create !== 'function') { glReason = 'openlive-screen-render.js is not loaded'; return null; }
    const r = G.create(glCanvas, { defaults: { meshDensity: opts.meshDensity || 24 } });
    if (!r || !r.gl) { glReason = (r && r.lastError) || 'WebGL2 unavailable'; return r || null; }
    glReason = null;
    return r;
  }
  renderer = makeRenderer();
  const hasGL = () => !!(renderer && renderer.gl);

  /* =======================================================================
     model access
     ======================================================================= */
  const setup = () => ST.setup;
  const screens = () => { const s = setup(); return s && s.screensList ? s.screensList : (s && s.screens ? s.screens() : []); };
  const screenById = id => screens().find(s => String(s.uniqueId) === String(id)) || null;
  const curScreen = () => screenById(ST.screenId) || screens()[0] || null;
  const slicesOf = sc => (sc && sc.layers) ? sc.layers : [];
  const sliceById = id => {
    for (const sc of screens()) for (const sl of slicesOf(sc)) if (String(sl.uniqueId) === String(id)) return sl;
    return null;
  };
  const screenOfSlice = id => {
    for (const sc of screens()) for (const sl of slicesOf(sc)) if (String(sl.uniqueId) === String(id)) return sc;
    return null;
  };
  const primary = () => (ST.sel.length ? sliceById(ST.sel[0]) : null);
  const selected = () => ST.sel.map(sliceById).filter(Boolean);

  /* ---- slice stacking order --------------------------------------------
     One direction, read from the model so the tree, the picture and the menu
     cannot drift apart. index 0 in <layers> is drawn FIRST, is therefore
     BACK-most, and is the TOP row here — so Bring Forward moves a row DOWN.
     That direction is an inference (see OpenLiveScreens.ORDER); everything in
     this file asks ORDER rather than hard-coding a sign, so if it ever gets
     checked against a running Arena and turns out inverted, one constant in
     openlive-screens.js flips the whole clone. */
  const ORDER = (window.OpenLiveScreens && window.OpenLiveScreens.ORDER) || {
    forwardDelta: +1, backwardDelta: -1,
    frontIndex: n => Math.max(0, (n | 0) - 1), backIndex: () => 0,
    topLabel: 'back', bottomLabel: 'front', verified: false
  };
  /* The model owns the semantics; this is only the fallback for a setup that
     arrived as a plain decoded object rather than as a live OpenLiveScreens
     screen. Both paths permute sc.layers and nothing else — there is no index
     field on a slice to keep in step. */
  const stack = {
    move(sc, ids, delta) {
      if (!sc || !delta) return false;
      if (typeof sc.moveSelection === 'function') return sc.moveSelection(ids, delta);
      const l = sc.layers || [], want = new Set(ids.map(String));
      const has = i => want.has(String(l[i].uniqueId));
      let moved = false;
      const step = delta > 0 ? 1 : -1;
      for (let n = 0; n < Math.abs(delta); n++) {
        if (step > 0) { for (let i = l.length - 2; i >= 0; i--) if (has(i) && !has(i + 1)) { const t = l[i]; l[i] = l[i + 1]; l[i + 1] = t; moved = true; } }
        else { for (let i = 1; i < l.length; i++) if (has(i) && !has(i - 1)) { const t = l[i]; l[i] = l[i - 1]; l[i - 1] = t; moved = true; } }
      }
      return moved;
    },
    /* CLONE EXTENSIONS. Arena.exe contains "Bring Forward" and "Send Backwards"
       and no to-front / to-back literal at all, so these two are ours and are
       labelled as such wherever they appear. */
    toEnd(sc, ids, end) {
      if (!sc) return false;
      const l = sc.layers || [], want = new Set(ids.map(String));
      const moving = l.filter(s => want.has(String(s.uniqueId)));
      const rest = l.filter(s => !want.has(String(s.uniqueId)));
      if (!moving.length) return false;
      /* ASK ORDER FOR WHICH END IS THE FRONT. This line used to read
         `end === 'front' ? rest.concat(moving) : moving.concat(rest)`, which
         hard-codes "front is the end of the array" — the one thing the comment
         forty lines above promises nothing in this file does. It was measured:
         mutating ORDER inverted Bring Forward and Send Backwards correctly while
         Bring to Front and Send to Back did not move at all, so after a flip
         "Bring to Front" would have sent the slice to the BACK. The model's own
         bringToFront/sendToBack are ORDER-aware but unreachable from here,
         because toEnd builds a whole permutation and hands it to reorder(). */
      const n = l.length;
      const frontIsLast = ORDER.frontIndex(n) >= ORDER.backIndex(n);
      const toFront = (end === 'front');
      const next = (toFront === frontIsLast) ? rest.concat(moving) : moving.concat(rest);
      if (typeof sc.reorder === 'function') return sc.reorder(next.map(s => s.uniqueId));
      const same = next.every((s, i) => s === l[i]);
      l.splice(0, l.length, ...next);
      return !same;
    },
    /* drop a set of slices so that they land starting at `at`, keeping their own
       relative order — the drag equivalent of the menu items, and the gesture
       modifiers.htm calls "essentially the same" as them */
    dropAt(sc, ids, at) {
      if (!sc) return false;
      const l = sc.layers || [], want = new Set(ids.map(String));
      const moving = l.filter(s => want.has(String(s.uniqueId)));
      const rest = l.filter(s => !want.has(String(s.uniqueId)));
      if (!moving.length) return false;
      const before = l.slice(0, clamp(at | 0, 0, l.length)).filter(s => !want.has(String(s.uniqueId))).length;
      const next = rest.slice(0, before).concat(moving, rest.slice(before));
      if (typeof sc.reorder === 'function') return sc.reorder(next.map(s => s.uniqueId));
      const same = next.every((s, i) => s === l[i]);
      l.splice(0, l.length, ...next);
      return !same;
    }
  };
  function moveSlicesToScreen(ids,targetScreenId,at){
    ids=(ids || []).map(String);
    const from=ids.length ? screenOfSlice(ids[0]) : null;
    const to=screenById(targetScreenId);
    if(!from || !to || !setup() || typeof setup().moveSlices!=='function'){
      const result={ok:false,code:'unsupported',message:'This Screen model cannot move Slices between Screens'};
      hint(result.message,true); return result;
    }
    if(from===to){
      push('reorder slices');
      const ok=stack.dropAt(to,ids,at);
      if(ok){ ST.screenId=to.uniqueId; ST.sel=ids.slice(); refresh(); hint('Reordered'); }
      else refreshTree();
      return {ok,code:ok?'reordered':'unchanged',moved:ok?ids:[]};
    }
    const check=setup().moveSlices(ids,from.uniqueId,to.uniqueId,at,{validateOnly:true});
    if(!check.ok){ hint(check.message || 'Could not move Slices',true); refreshTree(); return check; }
    push('move slices between screens');
    const result=setup().moveSlices(ids,from.uniqueId,to.uniqueId,at);
    if(!result.ok){ hint(result.message || 'Could not move Slices',true); refreshTree(); return result; }
    ST.screenId=to.uniqueId; ST.sel=result.moved.slice(); ST.point=null; ST.pickCycle=null;
    emit('move',result); refresh(); hint(result.message);
    return result;
  }
  const compSize = () => {
    const s = setup();
    if (s && typeof s.compositionSize === 'function') return s.compositionSize();
    return { width: 1920, height: 1080 };
  };
  const devSize = sc => (sc && typeof sc.deviceSize === 'function') ? sc.deviceSize() : { width: 1920, height: 1080 };
  const sliceName = sl => (sl && sl.name) || (sl ? (sl.type === 'DmxSlice' ? 'Fixture' : sl.type === 'Polygon' ? 'Polygon' : 'Slice') : '');
  const isMask = sl => !!sl && /mask/i.test(String(sl.type || ''));
  const isDmx = sl => !!sl && /^Dmx/i.test(String(sl.type || ''));
  const isPoly = sl => !!sl && /poly/i.test(String(sl.type || ''));
  /* "Hidden" and "folded" are Screen params, so both toggles round-trip.
     Hidden is inverted on purpose: the param says hidden, the button says
     Enable Screen ("Enable or disable all the slices and masks in this screen
     in one fell swoop" — English.xml:1041). */
  const screenOn = sc => !!sc && !pbool(sc, ['Hidden', 'hidden'], false);
  const setScreenOn = (sc, on) => pset(sc, 'Params', 'Hidden', on ? 0 : 1, 'BOOL');
  const foldedOf = sc => !!sc && pbool(sc, ['folded', 'Folded'], false);
  const setFolded = (sc, f) => pset(sc, 'Params', 'folded', f ? 1 : 0, 'BOOL');
  /* Enable Slice mirrors Enable Screen: it is a PARAM on the slice, not editor
     state. It used to live only in ST.hidden, a Set, so the eye gated the render
     for the session and then vanished on save — the picture and the file
     disagreed. ST.hidden is still consulted so a slice toggled before this ran
     keeps its state for the rest of the session, but the param is the truth. */
  const sliceOn = sl => {
    if (!sl) return false;
    if (pget(sl, ['Hidden', 'hidden'], null) != null) return !pbool(sl, ['Hidden', 'hidden'], false);
    return !ST.hidden.has(String(sl.uniqueId));
  };
  const setSliceOn = (sl, on) => {
    if (!sl) return;
    pset(sl, 'Params', 'Hidden', on ? 0 : 1, 'BOOL');
    /* keep the legacy Set in step so anything still reading it agrees */
    const id = String(sl.uniqueId);
    if (on) ST.hidden.delete(id); else ST.hidden.add(id);
  };
  /* 'Point Mode' is a param on the slice (contract block "Point"), not a global
     editor toggle — two slices can be in different modes at once. */
  const pointModeOf = sl => (num(pget(sl, ['Point Mode', 'pointMode'], 0), 0) >= 1 ? 'bezier' : 'linear');
  const isAvenue = () => ST.product === 'Avenue';

  const verts = (sl, which) => {
    const r = which === 'input' ? sl.inputRect : sl.outputRect;
    return r && Array.isArray(r.vertices) ? r.vertices : [];
  };
  const netOf = sl => (sl && sl.warper && sl.warper.bezier) || null;
  const homoOf = sl => (sl && sl.warper && sl.warper.homography) || null;
  function matrixOf(sl) {
    const S = SC();
    if (S && typeof S.homographyOf === 'function') { const H = S.homographyOf(sl); if (H) return H; }
    const h = homoOf(sl);
    const G = GR();
    if (h && G && typeof G.solveHomography === 'function') return G.solveHomography(h.src, h.dst) || IDENT3;
    return IDENT3;
  }

  /* Parameter read/write. The renderer looks a value up as a FLAT property
     first and only then inside the named Params blocks (prop() in
     openlive-screen-render.js), and the model's own name/softEdgeEnable are
     flat accessors — so writing a flat property is what makes an inspector
     edit visible in the very next frame. Values are also mirrored into the
     Params block that serialises, so the edit survives a save. */
  function pget(node, names, dflt) {
    if (!node) return dflt;
    for (const n of names) {
      const v = node[n];
      if (v !== undefined && v !== null) return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    }
    const blocks = node.params;
    if (blocks) for (const b in blocks) for (const n of names) {
      const v = blocks[b] && blocks[b][n];
      if (v !== undefined && v !== null) return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    }
    return dflt;
  }
  const pnum = (node, names, d) => num(pget(node, names, undefined), d);
  const pbool = (node, names, d) => bool(pget(node, names, undefined), d);
  function pset(node, block, name, value, type, tag) {
    if (!node) return;
    /* the flat copy is what the renderer reads this frame */
    try { node[name] = value; } catch (e) { /* a defined accessor wins, and that is fine */ }
    node.params = node.params || {};
    const b = node.params[block] || (node.params[block] = {});
    const rec = b[name];
    if (rec && typeof rec === 'object') rec.value = String(value);
    else b[name] = { tag: tag || (type === 'BOOL' ? 'Param' : 'ParamRange'), type: type || 'DOUBLE',
                     default: String(value), value: String(value) };
  }
  /* Used to retire params this clone invented in an earlier version ("Flip H",
     "Flip V"): a file written by that version has to stop carrying them, or the
     single Arena "Flip" ParamChoice and the two booleans would disagree. */
  function pdrop(node, name) {
    if (!node) return;
    try { delete node[name]; } catch (e) { /* an accessor, then; leave it */ }
    const blocks = node.params;
    if (blocks) for (const b in blocks) if (blocks[b] && blocks[b][name] !== undefined) delete blocks[b][name];
  }

  /* =======================================================================
     undo. Snapshot is the model's own XML, restored into the SAME setup
     object — deserialize(xml, into) clears and repopulates in place, so every
     reference this editor holds stays valid and nothing has to be rebound.
     ======================================================================= */
  const UNDO_MAX = 60;
  function canUndo() { const S = SC(); return !!(S && typeof S.serialize === 'function' && typeof S.deserialize === 'function' && setup()); }
  function snapshot() {
    if (!canUndo()) return null;
    try { return SC().serialize(setup()); } catch (e) { return null; }
  }
  function push(label) {
    const s = snapshot();
    if (!s) return;
    ST.undo.push({ xml: s, label: label || '' });
    if (ST.undo.length > UNDO_MAX) ST.undo.shift();
    ST.redo.length = 0;
    paintFoot();
  }
  function restore(xml) {
    try { SC().deserialize(xml, setup()); } catch (e) { ST.lastError = String(e && e.message || e); return false; }
    if (renderer && renderer.setSetup) renderer.setSetup(setup());
    if (!screenById(ST.screenId)) ST.screenId = screens().length ? screens()[0].uniqueId : null;
    ST.sel = ST.sel.filter(id => !!sliceById(id));
    refresh();
    screens().forEach(sc => emit('device', {
      screenId: String(sc.uniqueId),
      device: Object.assign({}, sc.outputDevice || {}),
      source: 'history'
    }));
    return true;
  }
  function undo() {
    if (!ST.undo.length) return hint('Nothing to undo', true);
    const cur = snapshot();
    const e = ST.undo.pop();
    if (restore(e.xml) && cur) ST.redo.push({ xml: cur, label: e.label });
    hint('Undo' + (e.label ? ': ' + e.label : ''));
    paintFoot();
  }
  function redo() {
    if (!ST.redo.length) return hint('Nothing to redo', true);
    const cur = snapshot();
    const e = ST.redo.pop();
    if (restore(e.xml) && cur) ST.undo.push({ xml: cur, label: e.label });
    hint('Redo' + (e.label ? ': ' + e.label : ''));
    paintFoot();
  }
  function paintFoot() {
    E.undoBtn.disabled = !ST.undo.length;
    E.redoBtn.disabled = !ST.redo.length;
    const sc = curScreen();
    E.footL.textContent = sc ? (screens().length + ' screens · ' + slicesOf(sc).length + ' slices in ' + (sc.name || 'screen')) : 'no screens';
  }

  let hintTimer = 0;
  function hint(text, bad) {
    E.hint.textContent = text;
    E.hint.className = 'ao-hint on' + (bad ? ' bad' : '');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { E.hint.className = 'ao-hint' + (bad ? ' bad' : ''); }, 1800);
  }

  /* =======================================================================
     sources + routing

     Routing rules, verbatim from slice-routing.htm: a slice's Input Source may
     be the composition (default), a composition LAYER, a GROUP, the PREVIEW,
     or ANOTHER SCREEN's output; and when a LAYER is routed, "layer and clip
     effects are applied but blend modes and composition effects are not" —
     routing a layer deliberately bypasses the composition. This editor does
     not composite the sources itself: it ASKS the host for the frame of the
     thing that was routed, which is the only way that rule can be honoured
     honestly. openlive-routing.js, when present, owns the graph; when it is
     absent the same shape is kept locally so the UI behaves identically.
     ======================================================================= */
  function routingApi() {
    const R = RT();
    if (!R) return null;
    try { return typeof R.graph === 'function' ? R.graph() : R; } catch (e) { return null; }
  }
  /* openlive-routing.js's shapes, transcribed rather than guessed:
       sources()          -> [{id, kind, label, available, isDefault, note, reason}]
       sliceInput(id)     -> {source:{kind,id}, opts:{ignoreOpacity, ignoreBypassSolo,
                              inputOpacity, inputBypassSolo, effective}, isDefault}
       setSliceInput(id, {kind,id}, opts) -> {ok:true,...} | {ok:false, error, message}
       resolve(id, frameContext)          -> {ok, texture, opacity, visible, ...}
     Its `label` is our `name`, and its opts carry BOTH polarities because
     Arena's control is "Input Opacity" while the stored flag is the inverse.
     Every call is still wrapped: an optional module that throws is still
     optional. */
  function sourceList() {
    const g = routingApi();
    let out = [];
    if (g && typeof g.sources === 'function') {
      try {
        const list = g.sources();
        if (Array.isArray(list)) out = list.map(normSource);
      } catch (e) { out = []; }
    }
    /* Merge, never replace: the routing graph only knows about layers and
       groups its composition provider was given, and a host that told US about
       a layer must not watch it vanish from the dropdown. */
    for (const s of ST.sources.map(normSource))
      if (!out.some(o => o.kind === s.kind && String(o.id) === String(s.id))) out.push(s);
    if (!out.some(s => s.kind === 'composition')) out.unshift({ kind: 'composition', id: 'composition', name: 'Show', available: true });
    if (!out.some(s => s.kind === 'preview')) out.push({ kind: 'preview', id: 'preview', name: 'Preview', available: true });
    for (const sc of screens()) {
      if (isDmxScreen(sc)) continue;
      if (!out.some(s => s.kind === 'screen' && String(s.id) === String(sc.uniqueId)))
        out.push({ kind: 'screen', id: String(sc.uniqueId), name: sc.name || 'Screen', available: true });
    }
    return out;
  }
  const isDmxScreen = sc => !!sc && String(sc.type) === 'DmxScreen';
  const isStreamScreen = sc => !!sc && String(sc.type) === 'StreamScreen';
  function normSource(s) {
    if (!s) return { kind: 'composition', id: 'composition', name: 'Show', available: true };
    if (typeof s === 'string') return { kind: s, id: s, name: s[0].toUpperCase() + s.slice(1), available: true };
    const kind=String(s.kind || 'composition');
    const sourceName=String(s.label || s.name || s.kind || 'Show');
    return {
      kind,
      id: s.id == null ? null : String(s.id),
      name: kind === 'composition' && sourceName === 'Composition' ? 'Show' : sourceName,
      available: s.available !== false,
      note: s.note || s.reason || null
    };
  }
  const routeKey = r => r.kind + ':' + (r.id == null ? '' : r.id);
  const DEFAULT_ROUTE = () => ({ kind: 'composition', id: 'composition', name: 'Show',
    ignoreOpacity: false, ignoreBypassSolo: false, effective: false, isDefault: true });

  function routeOf(sliceId) {
    const g = routingApi();
    if (g && typeof g.sliceInput === 'function') {
      try {
        const r = g.sliceInput(String(sliceId));
        if (r && r.source) {
          const named = sourceList().find(s => s.kind === r.source.kind && String(s.id) === String(r.source.id));
          const o = r.opts || {};
          return {
            kind: String(r.source.kind), id: r.source.id == null ? null : String(r.source.id),
            name: named ? named.name : String(r.source.kind),
            ignoreOpacity: !!o.ignoreOpacity, ignoreBypassSolo: !!o.ignoreBypassSolo,
            effective: !!o.effective, isDefault: !!r.isDefault
          };
        }
      } catch (e) { /* the local map is the fallback, not an error */ }
    }
    const local = ST.routes.get(String(sliceId));
    if (local) return Object.assign(DEFAULT_ROUTE(), local, { isDefault: false });
    return DEFAULT_ROUTE();
  }
  function setRoute(sliceId, patch) {
    const cur = routeOf(sliceId);
    const next = Object.assign({}, cur, patch, { isDefault: false });
    const g = routingApi();
    let ok = true;
    if (g && typeof g.setSliceInput === 'function') {
      try {
        const opts = { ignoreOpacity: !!next.ignoreOpacity, ignoreBypassSolo: !!next.ignoreBypassSolo };
        const res = ('kind' in patch || 'id' in patch)
          ? g.setSliceInput(String(sliceId), { kind: next.kind, id: next.id }, opts)
          : (typeof g.setSliceInputOptions === 'function'
            ? g.setSliceInputOptions(String(sliceId), opts)
            : g.setSliceInput(String(sliceId), { kind: next.kind, id: next.id }, opts));
        /* A refusal is information, not a failure to swallow: the graph refuses
           cycles by default and names the screens in the message. */
        if (res && res.ok === false) {
          ok = false;
          hint(res.message || ('Routing refused: ' + res.error), true);
        } else if (res && res.warnings && res.warnings.length) {
          hint(String(res.warnings[0].message || res.warnings[0]));
        }
      } catch (e) { ST.lastError = 'routing: ' + String(e && e.message || e); }
    }
    if (ok) ST.routes.set(String(sliceId), next);
    emit('route', { sliceId: String(sliceId), source: next, accepted: ok });
    return ok ? next : cur;
  }

  /* The test card is an OUTPUT feature — "Display your test card on the
     projector and keep moving the slices towards each other" [edge-blending] —
     so it replaces the frame at the SOURCE, which is what puts it on every
     slice of every screen at once. */
  let testCv = null, testCtx = null, testStamp = -1;
  function testCard(w, h, t) {
    if (!testCv) { testCv = doc.createElement('canvas'); testCtx = testCv.getContext('2d'); }
    if (testCv.width !== w || testCv.height !== h) {
      testCv.width = w; testCv.height = h; testStamp = -1;
    }
    /* frameForSlice asks for its source once per Slice. The card is global to
       the Composition, so painting a full texture N times for N Slices is pure
       duplicate work. One shared editor stamp is one diagnostic frame. */
    if (testStamp === ST.stamp) return testCv;
    testStamp = ST.stamp;
    const c = testCtx;
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#101010'];
    for (let i = 0; i < bars.length; i++) { c.fillStyle = bars[i]; c.fillRect(i * w / bars.length, 0, w / bars.length + 1, h * 0.72); }
    c.fillStyle = '#0a0a0a'; c.fillRect(0, h * 0.72, w, h * 0.28);
    /* the moving diagonal line the manual tells you to align against */
    const period = 3000, ph = ((t % period) / period);
    c.strokeStyle = '#ffffff'; c.lineWidth = Math.max(2, h / 200);
    c.beginPath();
    const off = ph * (w + h) * 2 - (w + h);
    c.moveTo(off, 0); c.lineTo(off + h, h);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.30)'; c.lineWidth = 1;
    for (let x = 0; x <= w; x += 64) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = '#ffffff';
    c.font = 'bold ' + Math.round(h / 14) + 'px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(w + ' × ' + h, w / 2, h * 0.80);
    c.font = Math.round(h / 22) + 'px ui-monospace, monospace';
    c.fillText(new Date().toLocaleTimeString('en-GB') + '.' + String(Math.floor(t % 1000)).padStart(3, '0'), w / 2, h * 0.90);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    return testCv;
  }

  /* One frame of whatever was asked for. kind 'screen' is answered from this
     editor's own per-screen render so that "routing Virtual Screens back into
     a slice" (Arena help, Input Source) actually works. */
  function frameFor(kind, id, depth) {
    const comp = compSize();
    if (ST.flags.testCard) return testCard(Math.round(comp.width), Math.round(comp.height), ST.timeMs);
    if (kind === 'screen') {
      const sc = screenById(id);
      if (sc) return renderScreenFrame(sc, (depth || 0) + 1);
      return null;
    }
    if (!ST.frameSource) return null;
    try { return ST.frameSource(kind, id) || null; }
    catch (e) { ST.lastError = 'frameSource: ' + String(e && e.message || e); return null; }
  }
  /* What one slice is looking at THIS frame, and how much of it survives.

     When openlive-routing.js is loaded this goes through its resolve(), which
     is where the manual's carve-out actually lives — it decides whether a
     routed layer is gated off by Bypass/Solo, whether its opacity is pre- or
     post-fader, and whether a screen-to-screen edge has to be fed last frame's
     texture. Its frameContext accepts FUNCTIONS as the per-kind bags, so only
     the one source this slice needs is ever fetched.

     Without the module the answer is the same minus the gating: the routed
     source's frame, at full opacity. */
  function frameForSlice(sl, depth) {
    const id = String(sl.uniqueId);
    const g = routingApi();
    if (g && typeof g.resolve === 'function') {
      try {
        const res = g.resolve(id, {
          composition: frameFor('composition', null, depth),
          preview: frameFor('preview', null, depth),
          layers: lid => frameFor('layer', lid, depth),
          groups: gid => frameFor('group', gid, depth),
          screens: sid => frameFor('screen', sid, depth),
          previousScreens: sid => lastFrameOf(sid),
          live: did => frameFor('live', did, depth)
        });
        if (res) {
          return {
            src: res.visible === false ? null : (res.texture || null),
            opacity: clamp(num(res.opacity, 1), 0, 1),
            reason: res.reason || null,
            deferred: !!res.deferredFrame
          };
        }
      } catch (e) { ST.lastError = 'routing.resolve: ' + String(e && e.message || e); }
    }
    const r = routeOf(id);
    const f = frameFor(r.kind, r.id, depth);
    /* An unresolvable route draws nothing rather than quietly falling back to
       the composition: an empty slice is a truthful answer about a broken
       route, a substituted picture is not. */
    return { src: f || null, opacity: 1, reason: f ? null : 'no-' + r.kind + '-surface', deferred: false };
  }
  /* the texture a screen had at the END of the last frame — what a broken back
     edge is fed, and the only thing that can be fed without inventing one */
  function lastFrameOf(screenId) {
    const rec = frames.get(String(screenId));
    return rec && rec.canvas && rec.canvas.width ? rec.canvas : undefined;
  }

  /* =======================================================================
     the real output: renderScreen through openlive-screen-render.js

     One renderScreen call takes ONE source, but per-slice routing means the
     slices of a screen can be looking at different things. So the screen is
     drawn as a sequence of RUNS of consecutive slices that share a source —
     consecutive, because the slice stack is z-order and a mask cuts what is
     under it, so re-ordering the passes would re-order the picture.
     ======================================================================= */
  const frames = new Map();          /* screenId -> {canvas, ctx, stamp} */
  const rendering = new Set();

  function frameRec(sc) {
    const id = String(sc.uniqueId);
    let rec = frames.get(id);
    if (!rec) {
      const cv = doc.createElement('canvas');
      rec = { canvas: cv, ctx: cv.getContext('2d'), stamp: -1 };
      frames.set(id, rec);
    }
    return rec;
  }

  function renderScreenFrame(sc, depth) {
    if (!sc || !hasGL()) return null;
    const rec = frameRec(sc);
    const id = String(sc.uniqueId);
    /* A screen that routes to itself (or to a cycle) gets LAST frame's canvas.
       That is not a workaround: a feedback path is one frame late in any real
       compositor, Arena included. */
    if (rec.stamp === ST.stamp || rendering.has(id) || (depth || 0) > 3) return rec.canvas;
    /* Ctrl+Shift+D is a panic latch for external sinks, not an instruction to
       erase the editor's preview. Projector windows close in advanced-output,
       and setFlag() stops Broadcast sessions; keeping this raster live lets the
       operator repair a setup before re-enabling output. */
    if (!screenOn(sc)) {
      rec.stamp = ST.stamp; rec.painted = 0;
      rec.reasons = ['screen disabled'];
      clearRec(rec, sc); return rec.canvas;
    }
    rendering.add(id);
    try {
      /* IN MODEL ORDER, and it has to stay that way: the loop below splits the
         slices into RUNS by source and draws one renderScreen pass per run onto
         the same canvas. Because the runs are built by walking slicesOf(sc)
         forwards and are drawn in that order with source-over, the stack
         survives the split. Sorting or grouping this list by source would
         silently reorder the picture. */
      /* Masks do not resolve a source of their own. They stay out of this source
         list, but remain ENABLED inside every renderer run below so their exact
         stack position can destructively clip the slices already drawn in that
         run. Repeating a mask over independently cleared runs is algebraically
         equivalent to applying it once to the interleaved final stack. */
      const list = slicesOf(sc).filter(sl => sliceOn(sl) && !isMask(sl) && !isDmx(sl));
      /* resolve every source BEFORE clearing, so a self-reference above still
         reads the previous frame instead of the canvas we are about to wipe */
      const runs = [];
      const gain = new Map();                 /* sliceId -> routed opacity */
      /* WHY A SCREEN CAME OUT EMPTY, KEPT RATHER THAN THROWN AWAY.
         frameForSlice already names its failures ('no-layer-surface' and so on)
         and every caller was dropping the answer, so a screen that drew nothing
         was indistinguishable from one that drew black — and the output pane
         lit its green LIVE badge over both. Collected here so paintOutput can
         say which of the two it is. */
      const reasons = [];
      rec.painted = 0;
      for (const sl of list) {
        const r = frameForSlice(sl, depth || 0);
        if (!r.src && r.reason && reasons.indexOf(r.reason) < 0) reasons.push(r.reason);
        gain.set(String(sl.uniqueId), r.opacity);
        const last = runs[runs.length - 1];
        if (last && last.src === r.src) last.ids.push(String(sl.uniqueId));
        else runs.push({ src: r.src, ids: [String(sl.uniqueId)] });
      }
      const dev = devSize(sc);
      const w = Math.max(1, Math.round(dev.width)), h = Math.max(1, Math.round(dev.height));
      if (rec.canvas.width !== w || rec.canvas.height !== h) { rec.canvas.width = w; rec.canvas.height = h; }
      rec.ctx.clearRect(0, 0, w, h);
      rec.stamp = ST.stamp;

      const t0 = now();
      for (const run of runs) {
        if (!run.src) continue;
        /* Gate the slices of the other runs off for the length of this pass.
           renderScreen honours a flat `enabled` (propBool(s,['enabled',...])),
           and a flat property is not part of what serialises, so this leaves
           no trace in the model. */
        const marked = [];
        for (const sl of slicesOf(sc)) {
          const sid = String(sl.uniqueId);
          if (!isMask(sl) && run.ids.indexOf(sid) < 0) { sl.enabled = false; marked.push(sl); }
        }
        try {
          /* The routed source's opacity goes in as the renderer's textureOpacity
             — Arena's ONLY per-draw opacity — instead of being written onto the
             slice as a fake `opacity` param. A slice has no opacity of its own;
             this number belongs to the layer or group feeding it, and Input
             Opacity decides whether it reaches the picture at all. */
          renderer.renderScreen(sc.uniqueId, run.src, {
            autoSize: true, clearColor: [0, 0, 0, 0],
            /* Runs are composited below. The Screen fader belongs to the
               finished Screen, not to each routed source independently. */
            ignoreScreenOpacity: true,
            ignoreScreenColor: true,
            sliceOpacity: sl => num(gain.get(String(sl && sl.uniqueId)), 1)
          });
          if (glCanvas.width === w && glCanvas.height === h) rec.ctx.drawImage(glCanvas, 0, 0);
          else {
            /* the GL canvas is rescaled into the screen's device raster here —
               the third resampling context in the chain, and the one the audit
               trail missed. Default 'low' would undo the sharpness the rest of
               the lane now preserves. */
            rec.ctx.imageSmoothingEnabled = true;
            rec.ctx.imageSmoothingQuality = 'high';
            rec.ctx.drawImage(glCanvas, 0, 0, w, h);
          }
          rec.painted++;
          ST.stats.drawn = renderer.stats ? renderer.stats.drawn : 0;
          ST.stats.tris = renderer.stats ? renderer.stats.triangles : 0;
        } finally {
          /* a FLAT property, which is why it can be removed cleanly: nothing
             flat is part of what serialises. The opacity temporary that used to
             sit beside it is gone — it is an option on the call now. */
          for (const sl of marked) {
            try { delete sl.enabled; } catch (e) { sl.enabled = true; }
          }
        }
      }
      /* Screen colour + Opacity are one post-composite GPU pass. This preserves
         the documented Screen-stage scope across routed-source runs; most
         importantly, opacity scales the already composited alpha exactly once.
         The renderer uploads this finished raster and performs no readPixels. */
      const screenOpacity = clamp(pnum(sc, ['opacity', 'Opacity'], 1), 0, 1);
      if (rec.painted && renderer && typeof renderer.renderFinalScreen === 'function') {
        renderer.renderFinalScreen(sc.uniqueId, rec.canvas, { autoSize: true });
        rec.ctx.clearRect(0, 0, w, h);
        if (glCanvas.width === w && glCanvas.height === h) rec.ctx.drawImage(glCanvas, 0, 0);
        else {
          rec.ctx.imageSmoothingEnabled = true;
          rec.ctx.imageSmoothingQuality = 'high';
          rec.ctx.drawImage(glCanvas, 0, 0, w, h);
        }
      } else if (rec.painted && screenOpacity < 1) {
        /* CPU fallback for an older/no-GL renderer: preserves the fader even
           though per-channel Screen compensation is unavailable there. */
        rec.ctx.save();
        rec.ctx.setTransform(1, 0, 0, 1, 0, 0);
        rec.ctx.globalCompositeOperation = 'destination-in';
        rec.ctx.globalAlpha = screenOpacity;
        rec.ctx.fillStyle = 'rgba(0,0,0,1)';
        rec.ctx.fillRect(0, 0, w, h);
        rec.ctx.restore();
      }
      ST.stats.glMs += ((now() - t0) - ST.stats.glMs) * 0.15;
      /* Distinguish the two ways of drawing nothing: a screen with no drawable
         slices at all (the filter above removes masks and DMX slices), and one
         whose slices are all routed to something that will not resolve. */
      rec.reasons = rec.painted ? []
        : (list.length ? (reasons.length ? reasons : ['no source resolved'])
                       : ['no drawable slices']);
    } catch (e) {
      ST.lastError = 'renderScreen: ' + String(e && e.message || e);
      rec.reasons = ['render error'];
    } finally {
      rendering.delete(id);
    }
    return rec.canvas;
  }
  function clearRec(rec, sc) {
    const dev = devSize(sc);
    const w = Math.max(1, Math.round(dev.width)), h = Math.max(1, Math.round(dev.height));
    if (rec.canvas.width !== w || rec.canvas.height !== h) { rec.canvas.width = w; rec.canvas.height = h; }
    rec.ctx.clearRect(0, 0, w, h);
  }
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  /* =======================================================================
     view transform. Model space is composition pixels on the input stage and
     device pixels on the output stage; both panes carry their own pan+zoom.
     ======================================================================= */
  function viewOf(key, mw, mh, cssW, cssH) {
    let v = ST.view[key];
    if (!v) v = ST.view[key] = { scale: 0, ox: 0, oy: 0, fit: true, w: mw, h: mh };
    /* A CHANGE OF RASTER IS A CHANGE OF DOCUMENT.
       The Output stage's model space is the Screen's device raster [screens.htm:
       "Resolume will show the name and resolution of this connection"], so
       reassigning the Device — or editing a Virtual Screen's Width/Height —
       replaces the thing this view is a view OF. Only `v.fit` used to trigger a
       recompute, so once the pane had been panned or zoomed the stage kept the
       previous scale and origin: switching a Screen from 1920x1080 to 2560x1440
       left the zoom at 75% instead of 56%, drawing the new raster 1928px wide
       inside a 1490px pane with its right edge off-screen and unreachable.
       Measured before this line existed: model deviceSize 2560x1080, stage 75%. */
    const rasterChanged = v.w !== mw || v.h !== mh;
    v.w = mw; v.h = mh;
    if (v.fit || rasterChanged || !(v.scale > 0)) {
      /* a pane that has not been laid out yet reports a 1px box; clamping keeps
         the first frame from being drawn at a negative scale (mirrored) */
      const pad = 22;
      v.scale = Math.max(0.01, Math.min((cssW - pad * 2) / mw, (cssH - pad * 2) / mh) || 1);
      v.ox = (cssW - mw * v.scale) / 2;
      v.oy = (cssH - mh * v.scale) / 2;
    }
    return v;
  }
  const toView = (v, p) => P(v.ox + p.x * v.scale, v.oy + p.y * v.scale);
  const toModel = (v, p) => P((p.x - v.ox) / v.scale, (p.y - v.oy) / v.scale);
  function zoomBy(key, factor, anchor) {
    if (ST.drag) return;
    const v = ST.view[key];
    if (!v) return;
    const a = anchor || P(v.ox + v.w * v.scale / 2, v.oy + v.h * v.scale / 2);
    const m = toModel(v, a);
    v.scale = clamp(v.scale * factor, 0.02, 40);
    v.ox = a.x - m.x * v.scale;
    v.oy = a.y - m.y * v.scale;
    v.fit = false;
    E.zoomLbl.textContent = Math.round(v.scale * 100) + '%';
  }
  function fitAll() {
    if (ST.drag) return;
    const v = ST.view[ST.stage];
    if (v) v.fit = true;
  }
  function resetViewFits() {
    if (ST.view.input) ST.view.input.fit = true;
    if (ST.view.output) ST.view.output.fit = true;
  }

  function sizeCanvas(p) {
    const r = p.box.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    /* Clamped at 2 this rendered soft on a 3x display for no reason — the
       stage is one canvas, not a page full of them, and the cost is linear in
       an area that is already small. */
    const dpr = Math.min(opts.maxDpr || 3, window.devicePixelRatio || 1);
    const dw = Math.round(w * dpr), dh = Math.round(h * dpr);
    if (p.cv.width !== dw || p.cv.height !== dh) { p.cv.width = dw; p.cv.height = dh; }
    p.cv.style.width = w + 'px'; p.cv.style.height = h + 'px';
    p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* The stage fits a 1920-wide composition into a box a few hundred pixels
       across — better than 5:1 minification, and the readout says so ("17%").
       Canvas2D resamples at 'low' by default: a single bilinear tap, which at
       that ratio discards most of the detail and reads as a soft, crawling
       picture. Set every frame rather than once, because assigning width or
       height to a canvas resets its context state. */
    p.ctx.imageSmoothingEnabled = true;
    p.ctx.imageSmoothingQuality = 'high';
    return { w, h };
  }

  /* =======================================================================
     geometry the overlays are drawn from. All of it is OpenLiveScreens maths,
     which is CPU-side and therefore identical with and without WebGL — the
     overlay never disappears just because the GL context did.
     ======================================================================= */
  function inputAt(sl, u, v) {
    const S = SC();
    if (S && typeof S.sliceInputAt === 'function') return S.sliceInputAt(sl, u, v);
    const V = verts(sl, 'input');
    if (V.length < 4) return P(0, 0);
    return P(V[0].x + (V[1].x - V[0].x) * u + (V[3].x - V[0].x) * v,
             V[0].y + (V[1].y - V[0].y) * u + (V[3].y - V[0].y) * v);
  }
  function outputAt(sl, u, v, H) {
    const S = SC();
    if (S && typeof S.sliceOutputAt === 'function') return S.sliceOutputAt(sl, u, v, H);
    const V = verts(sl, 'output');
    if (V.length < 4) return P(0, 0);
    const ax = V[0].x + (V[1].x - V[0].x) * u, ay = V[0].y + (V[1].y - V[0].y) * u;
    const bx = V[3].x + (V[2].x - V[3].x) * u, by = V[3].y + (V[2].y - V[3].y) * u;
    return applyH(H, P(ax + (bx - ax) * v, ay + (by - ay) * v));
  }
  /* The boundary, sampled along the parametric border, so a curved patch reads
     as a curve and not as four straight lines. */
  function outline(sl, mode, steps) {
    const V = verts(sl, mode === 'input' ? 'input' : 'output');
    if (mode === 'input') return V.length ? V.map(p => P(p.x, p.y)) : [];
    if (V.length !== 4 && !netOf(sl)) {
      const H = matrixOf(sl);
      return V.map(p => applyH(H, p));
    }
    const H = matrixOf(sl), n = Math.max(2, steps || 14), out = [];
    for (let i = 0; i < n; i++) out.push(outputAt(sl, i / n, 0, H));
    for (let i = 0; i < n; i++) out.push(outputAt(sl, 1, i / n, H));
    for (let i = n; i > 0; i--) out.push(outputAt(sl, i / n, 1, H));
    for (let i = n; i > 0; i--) out.push(outputAt(sl, 0, i / n, H));
    return out;
  }
  /* The BIG corner draggers ARE the homography's dst quad, not the parametric
     corners of the warped surface: a bezier patch interpolates its corners, so
     the small handle already sits at S(0,0) and drawing the big one there too
     would make the two impossible to tell apart or drag separately — which is
     the whole of "use the big corner points for perspective warping and their
     baby brothers for additional bezier warping" [output-transformation.htm]. */
  function cornersOf(sl) {
    const h = homoOf(sl);
    if (h && h.dst && h.dst.length >= 4) return h.dst.slice(0, 4).map(p => P(p.x, p.y));
    const V = verts(sl, 'output');
    return V.length >= 4 ? V.slice(0, 4).map(p => P(p.x, p.y)) : [];
  }
  /* Control points live in SRC space, before the homography, so they are drawn
     through H — that is why the manual says the small points travel with the
     big ones. */
  function netPoints(sl) {
    const g = netOf(sl);
    if (!g || !Array.isArray(g.vertices)) return [];
    const H = matrixOf(sl);
    return g.vertices.map(p => applyH(H, p));
  }
  function rectFrame(V) {                       /* 4 vertices -> centre/size/rotation */
    if (!V || V.length < 4) return { cx: 0, cy: 0, w: 0, h: 0, rot: 0 };
    const ux = V[1].x - V[0].x, uy = V[1].y - V[0].y;
    const vx = V[3].x - V[0].x, vy = V[3].y - V[0].y;
    return {
      cx: (V[0].x + V[1].x + V[2].x + V[3].x) / 4,
      cy: (V[0].y + V[1].y + V[2].y + V[3].y) / 4,
      w: Math.hypot(ux, uy), h: Math.hypot(vx, vy),
      rot: Math.atan2(uy, ux)
    };
  }
  function frameToVerts(f) {
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    const hx = f.w / 2, hy = f.h / 2;
    const at = (dx, dy) => P(f.cx + dx * c - dy * s, f.cy + dx * s + dy * c);
    return [at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)];
  }

  function positionSignature() { return ST.stage + ':' + selectedForStage(ST.stage).map(sl => sl.uniqueId).join(','); }
  function selectionFrame(mode) {
    const list = selectedForStage(mode);
    if (!list.length) return null;
    if (list.length === 1) {
      const sl = list[0], f = typeof sl.geometryFrame === 'function' && sl.geometryFrame(mode);
      return f ? {cx:f.x, cy:f.y, w:f.width, h:f.height, rot:f.rotation * Math.PI / 180} : rectFrame(verts(sl, mode));
    }
    const b = selectionBounds(list.map(sl => String(sl.uniqueId)), mode);
    return b ? {cx:(b.x0+b.x1)/2, cy:(b.y0+b.y1)/2, w:b.x1-b.x0, h:b.y1-b.y0, rot:0} : null;
  }
  function positionValue(key) {
    const f = selectionFrame(ST.stage);
    return f ? fmt(key === 'rot' ? f.rot * 180 / Math.PI : f[key], 2) : '';
  }
  function syncPositionBar() {
    const list = selectedForStage(ST.stage);
    E.position.hidden = ST.mode !== 'transform' || (ST.stage === 'output' && isDmxScreen(curScreen()));
    if (E.position.hidden) return;
    const label = list.length === 1 ? sliceName(list[0]) : list.length ? list.length + ' slices' : 'Select a slice';
    if (E.positionName.textContent !== label) E.positionName.textContent = label;
    E.positionName.title = label + ' · centre-based position';
    for (const key of Object.keys(E.positionFields)) {
      const input = E.positionFields[key], value = positionValue(key);
      input.disabled = !list.length;
      if (doc.activeElement !== input && input.value !== value) input.value = value;
    }
    E.ratio.setAttribute('aria-pressed', String(ST.lockRatio));
    E.position.querySelectorAll('button').forEach(b => { b.disabled = !list.length; });
    E.resetRotation.disabled = list.length !== 1;
  }
  function commitPosition(key, input) {
    if (ST.drag || input._selection !== positionSignature()) { input.value = positionValue(key); return; }
    const f = selectionFrame(ST.stage);
    if (!f) return;
    const before = key === 'rot' ? f.rot * 180 / Math.PI : f[key];
    const value = evalNum(input.value, before);
    if (!isFinite(value) || ((key === 'w' || key === 'h') && value < 1)) {
      input.value = fmt(before, 2); hint('Enter a valid value; dimensions must be at least 1 pixel.', true); return;
    }
    const patch = { [key]: key === 'rot' ? value * Math.PI / 180 : value };
    if (ST.lockRatio && key === 'w') patch.h = Math.max(1, f.h * value / f.w);
    if (ST.lockRatio && key === 'h') patch.w = Math.max(1, f.w * value / f.h);
    setSelectionFrame(patch, 'selection ' + key);
    input.value = positionValue(key);
  }
  function setSelectionFrame(patch, label) {
    if (ST.drag) return;
    const mode = ST.stage, list = selectedForStage(mode), f = selectionFrame(mode);
    if (!f || !f.w || !f.h) return;
    const n = Object.assign({}, f, patch);
    if (!Object.values(n).every(isFinite) || n.w < 1 || n.h < 1) return;
    if (Object.keys(patch).every(k => Math.abs(n[k] - f[k]) < 1e-9)) return;
    push(label);
    if (list.length === 1 && typeof list[0].setGeometryFrame === 'function') {
      list[0].setGeometryFrame(mode, {x:n.cx, y:n.cy, width:n.w, height:n.h, rotation:n.rot * 180 / Math.PI});
    } else {
      const m = AF.mul(AF.move(n.cx,n.cy), AF.mul(AF.rot(n.rot), AF.mul(AF.scale(n.w/f.w,n.h/f.h),
        AF.mul(AF.rot(-f.rot),AF.move(-f.cx,-f.cy)))));
      list.forEach(sl => applyAffine(sl,m,mode));
    }
    refreshSide(); syncPositionBar();
  }
  function alignSelection(axis) {
    const list = selectedForStage(ST.stage), f = selectionFrame(ST.stage);
    const b = selectionBounds(list.map(sl => String(sl.uniqueId)), ST.stage);
    const size = ST.stage === 'input' ? compSize() : devSize(curScreen());
    if (!b || !f) return;
    /* Align the visible hull, including a warped output, rather than its unwarped rect. */
    setSelectionFrame(axis === 'x' ? {cx:f.cx + size.width/2 - (b.x0+b.x1)/2}
      : {cy:f.cy + size.height/2 - (b.y0+b.y1)/2}, 'centre ' + axis);
  }

  /* Apply an affine to a whole slice. On the output stage that means the rect,
     BOTH homography quads and the bezier net: transforming src and dst by the
     same A turns H into A·H·A⁻¹, and transforming the control net by A then
     gives A(H(S(u,v))) — the slice moves rigidly and the warp is untouched. */
  function applyAffine(sl, m, which) {
    const move = arr => { for (let i = 0; i < arr.length; i++) { const q = AF.ap(m, arr[i]); arr[i].x = q.x; arr[i].y = q.y; } };
    if (which === 'input') { const r = sl.inputRect; if (r) move(r.vertices); return; }
    if (sl.outputRect) move(sl.outputRect.vertices);
    const h = homoOf(sl);
    if (h) { move(h.src); move(h.dst); }
    const g = netOf(sl);
    if (g && Array.isArray(g.vertices)) move(g.vertices);
    sl._h = null;
  }

  /* =======================================================================
     snapping. "Slices will snap to the stage edges, the center and to each
     other" [input-selection.htm]; Show 8×8 LED Grid both draws AND snaps
     (Arena help showLedGrid: "Shows a 8x8 pixel grid and snaps all slices to
     it"). Ctrl suspends it [modifiers.htm].
     ======================================================================= */
  function snapTargets(mode, sc, exclude) {
    const xs = [], ys = [];
    const box = mode === 'input' ? compSize() : devSize(sc);
    xs.push(0, box.width / 2, box.width);
    ys.push(0, box.height / 2, box.height);
    const list = mode === 'input' ? screens().filter(inputScreenVisible) : [sc];
    for (const s of list) for (const sl of slicesOf(s)) {
      if (!sl || exclude.indexOf(String(sl.uniqueId)) >= 0 || !sliceOn(sl)) continue;
      const V = mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 4);
      if (!V.length) continue;
      const b = bounds(V);
      xs.push(b.x0, (b.x0 + b.x1) / 2, b.x1);
      ys.push(b.y0, (b.y0 + b.y1) / 2, b.y1);
    }
    return { xs, ys };
  }
  function snapDelta(movingBox, targets, tol, led) {
    let dx = 0, dy = 0, bx = tol, by = tol, hitX = null, hitY = null;
    const mx = [movingBox.x0, (movingBox.x0 + movingBox.x1) / 2, movingBox.x1];
    const my = [movingBox.y0, (movingBox.y0 + movingBox.y1) / 2, movingBox.y1];
    for (const a of mx) for (const t of targets.xs) {
      const d = t - a;
      if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; hitX = t; }
    }
    for (const a of my) for (const t of targets.ys) {
      const d = t - a;
      if (Math.abs(d) < by) { by = Math.abs(d); dy = d; hitY = t; }
    }
    if (led) {
      /* the 8×8 grid wins when it is closer — 99% of LED screens are blocks of 8 */
      const g8 = v => Math.round(v / 8) * 8;
      const gx = g8(movingBox.x0) - movingBox.x0, gy = g8(movingBox.y0) - movingBox.y0;
      if (Math.abs(gx) < Math.abs(dx) || hitX === null) { dx = gx; hitX = null; }
      if (Math.abs(gy) < Math.abs(dy) || hitY === null) { dy = gy; hitY = null; }
    }
    return { dx, dy, hitX, hitY };
  }

  /* =======================================================================
     painting — the input window
     ======================================================================= */
  function paintInput() {
    const p = E.pIn, t0 = now();
    ST.stageError.input = null;
    const size = sizeCanvas(p);
    const ctx = p.ctx;
    const comp = compSize();
    const v = viewOf('input', comp.width, comp.height, size.w, size.h);
    ctx.clearRect(0, 0, size.w, size.h);

    /* 1. the live frame. What the manual states, and the only thing it states,
          is that this stage "shows a preview of your composition output". */
    const prim = primary();
    const route = prim ? routeOf(prim.uniqueId) : { kind: 'composition', id: null, name: 'Show' };
    const followed = ST.flags.followRouting && prim && route.kind !== 'composition';
    const feed = followed ? frameFor(route.kind, route.id, 0) : frameFor('composition', null, 0);
    const x = v.ox, y = v.oy, w = comp.width * v.scale, h = comp.height * v.scale;

    ctx.save();
    ctx.fillStyle = '#05060b';
    ctx.fillRect(x, y, w, h);
    let feedOk = false;
    if (feed && (feed.width || feed.videoWidth) && (feed.height || feed.videoHeight)) {
      try { ctx.drawImage(feed, x, y, w, h); feedOk = true; }
      catch (e) { ST.stageError.input = 'input blit: ' + String(e && e.message || e); }
    }
    ctx.restore();

    /* 2. the Input Guide, at NATIVE RESOLUTION in the TOP LEFT, with its own
          opacity slider [modifiers.htm]. */
    drawGuide(ctx, v, 'input');

    if (!feedOk) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,120,120,0.5)'; ctx.setLineDash([5, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = 'rgba(240,190,190,0.8)';
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('No frame from the source', x + w / 2, y + h / 2);
      ctx.restore();
    }

    /* 3. composition frame + optional grids */
    ctx.save();
    ctx.strokeStyle = COL.frame; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
    if (ST.flags.ledGrid) drawLed(ctx, v, comp.width, comp.height);

    /* 4. EVERY slice of EVERY unfolded, active screen — folding is the
          documented way to reduce clutter here, so an unfolded screen's slices
          are all drawn [screens.htm; Arena help foldButton/Screen]. */
    const sc = curScreen();
    for (const s of screens()) {
      if (!screenOn(s) || foldedOf(s)) continue;
      for (const sl of slicesOf(s)) drawSliceInput(ctx, v, s, sl, s === sc);
    }
    drawSelectionWidgets(ctx, v, 'input');
    drawLasso(ctx, 'input');

    /* 5. readouts */
    badge(p, 'oo-badge' + (feedOk ? ' live' : '') + (followed ? ' routed' : ''),
      followed ? route.name + ' → routed' : 'Show');
    p.fed.textContent = Math.round(comp.width) + '×' + Math.round(comp.height) + ' Show canvas';
    p.read.textContent = readoutFor('input', v);
    ST.stats.inMs += ((now() - t0) - ST.stats.inMs) * 0.15;
    p.hud.textContent = ST.stats.inMs.toFixed(1) + 'ms';
  }

  function drawSliceInput(ctx, v, sc, sl, ofCurrent) {
    const V = verts(sl, 'input');
    if (V.length < 3) return;
    const poly = V.map(q => toView(v, q));
    const sel = ST.sel.indexOf(String(sl.uniqueId)) >= 0;
    const hov = ST.hover && ST.hover.sliceId === String(sl.uniqueId);
    const off = !sliceOn(sl);
    ctx.save();
    ctx.globalAlpha = off ? 0.32 : 1;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    /* Identify Slices: "light up your slices in WHITE when you MOUSE-OVER
       them" [modifiers.htm] */
    /* The editing contour must not colour-grade the programme preview. A
       normal or selected Slice is stroke-only; Identify Slices is the one
       deliberate fill because its documented job is to light up the hovered
       Slice. Stacking unfolded Slice fills used to create a false fog that was
       unrelated to every real Opacity parameter. */
    if (ST.flags.identify && hov) { ctx.fillStyle = COL.identify; ctx.fill(); }
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = isDmx(sl) ? COL.dmx : isMask(sl) ? COL.mask : sel ? COL.sel : COL.slice;
    if (isMask(sl)) ctx.setLineDash([6, 4]);
    if (isPoly(sl) && !triangulatable(V)) ctx.strokeStyle = COL.bad;   /* "Resolume will draw the outline in RED" */
    ctx.stroke();
    ctx.setLineDash([]);

    if (sel) {
      /* Multi-select Transform exposes ONE hull. Drawing each Slice's corners
         as well made those hidden/ambiguous handles win hit-testing. Edit
         Points remains per-Slice, as documented. */
      const pts = ST.mode === 'points' ? V
        : (selectedForStage('input').length === 1 ? V.slice(0, 4) : []);
      const bez = ST.mode === 'points' && pointModeOf(sl) === 'bezier' && !isPoly(sl);
      for (let i = 0; i < pts.length; i++) drawHandle(ctx, toView(v, pts[i]), CR + 1, COL.corner, bez);
      if (bez) drawTangents(ctx, v, V);
    }
    if (ofCurrent || sel) {
      const b = bounds(poly);
      ctx.fillStyle = COL.label;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(sliceName(sl) + (isMask(sl) ? ' (mask)' : isDmx(sl) ? ' (fixture)' : ''), b.x0 + 2, b.y0 - 3);
    }
    ctx.restore();
  }

  /* =======================================================================
     painting — the output window
     ======================================================================= */
  const DMX_CHANNELS = 512, DMX_MAX_UNIVERSES = 16;
  /* Arena's DMX Output screenshot lays a 16-pixel RGB bar across one row:
     16 pixels x 3 channels = 48 channel cells. The next fixture begins on the
     next row at channel 49. This is a wrapped patch grid, not a 512-channel
     timeline squeezed into the width of the stage. */
  const DMX_ROW_CHANNELS = 48;
  const DMX_ROWS_PER_UNIVERSE = Math.ceil(DMX_CHANNELS / DMX_ROW_CHANNELS);
  const DMX_GRID_TOP = 9, DMX_GRID_LEFT = 8, DMX_ROW_HEIGHT = 22;
  const DMX_UNIVERSE_GAP = 8, DMX_NAV_WIDTH = 72, DMX_NAV_GAP = 10;
  let dmxPaletteCache = null;

  /* The DMX Output tab is address space, not a disguised device raster. Arena
     lays fixtures out by start channel and marks collisions in red. Keep that
     model separate from OutputRect: OutputRect is the fixture's placement data,
     while Start Channel is the patch that this stage edits. */
  function dmxStart(sl) { return Math.max(1, Math.round(pnum(sl, ['Start Channel'], 1))); }
  function dmxLayout(sc) {
    const fixtures = slicesOf(sc).filter(isDmx).map(sl => {
      const start = dmxStart(sl), channels = fixtureChannels(sl);
      return { sl, id: String(sl.uniqueId), start, channels, end: start + channels - 1, overlap: false };
    });
    let overlapCount = 0;
    for (let i = 0; i < fixtures.length; i++) for (let j = i + 1; j < fixtures.length; j++) {
      const a = fixtures[i], b = fixtures[j];
      if (a.start <= b.end && b.start <= a.end) {
        a.overlap = b.overlap = true;
        overlapCount++;
      }
    }
    const maxEnd = fixtures.reduce((n, f) => Math.max(n, f.end), 1);
    const autoSpan = pbool(sc, ['Auto Span'], true);
    const universeCount = autoSpan
      ? clamp(Math.ceil(maxEnd / DMX_CHANNELS), 1, DMX_MAX_UNIVERSES)
      : 1;
    return { fixtures, overlapCount, maxEnd, autoSpan, universeCount,
      width: DMX_ROW_CHANNELS,
      height: universeCount * DMX_ROWS_PER_UNIVERSE * DMX_ROW_HEIGHT +
        Math.max(0, universeCount - 1) * DMX_UNIVERSE_GAP };
  }
  function dmxPalette() {
    if (dmxPaletteCache) return dmxPaletteCache;
    let css = null;
    try { css = window.getComputedStyle(host); } catch (e) {}
    const token = (name, fallback) => {
      const value = css && css.getPropertyValue(name);
      return value && value.trim() ? value.trim() : fallback;
    };
    dmxPaletteCache = {
      lane: token('--inset', COL.sliceFill),
      grid: token('--n800', COL.frame),
      text: token('--n400', COL.label),
      dim: token('--n600', COL.net),
      fixture: token('--n600', COL.net),
      selected: token('--color-accent', COL.sel),
      overlap: token('--red', COL.bad),
      disabled: token('--n700', COL.net),
      hover: token('--n100', COL.ctrl),
      surface: token('--panel', COL.sliceFill)
    };
    return dmxPaletteCache;
  }
  function dmxGrid(size) {
    const navWidth = size.w >= 420 ? DMX_NAV_WIDTH : 0;
    const right = size.w - DMX_GRID_LEFT - (navWidth ? navWidth + DMX_NAV_GAP : 0);
    return {
      left: DMX_GRID_LEFT,
      top: DMX_GRID_TOP,
      right,
      width: Math.max(DMX_ROW_CHANNELS, right - DMX_GRID_LEFT),
      cellWidth: Math.max(1, (right - DMX_GRID_LEFT) / DMX_ROW_CHANNELS),
      rowHeight: DMX_ROW_HEIGHT,
      rowsPerUniverse: DMX_ROWS_PER_UNIVERSE,
      navWidth,
      navLeft: navWidth ? right + DMX_NAV_GAP : 0,
      universeTop(u) {
        return DMX_GRID_TOP + u * (DMX_ROWS_PER_UNIVERSE * DMX_ROW_HEIGHT + DMX_UNIVERSE_GAP);
      },
      rowTop(u, row) { return this.universeTop(u) + row * DMX_ROW_HEIGHT; }
    };
  }
  function dmxTargetLabel(sc) {
    const mode = artTargetOf(sc);
    const item = ART_TARGETS.find(t => t.value === mode);
    const address = artAddressOf(sc);
    const label = item ? item.label : mode;
    return 'Art-Net · ' + label + (address ? ' · ' + address : '');
  }
  function dmxReadout(map) {
    const sl = primary();
    const selected = sl && isDmx(sl) && screenOfSlice(sl.uniqueId) === map.screen
      ? map.fixtures.find(f => f.id === String(sl.uniqueId)) : null;
    if (!selected) return map.fixtures.length + ' fixture' + (map.fixtures.length === 1 ? '' : 's') +
      '   ·   ' + map.universeCount + ' universe' + (map.universeCount === 1 ? '' : 's') +
      '   ·   no fixture selected';
    const universe = Math.floor((selected.start - 1) / DMX_CHANNELS);
    const channel = ((selected.start - 1) % DMX_CHANNELS) + 1;
    return sliceName(selected.sl) + '   ·   channels ' + selected.start + '–' + selected.end +
      '   ·   universe ' + universe + ' / channel ' + channel +
      (selected.overlap ? '   ·   OVERLAP' : '');
  }
  function syncStageIdentity() {
    const sc = curScreen(), dmx = isDmxScreen(sc);
    const title = dmx ? 'DMX Output' : 'Output Transformation';
    if (E.tabOut.textContent !== title) E.tabOut.textContent = title;
    if (E.pOut.title.textContent !== title) E.pOut.title.textContent = title;
    E.pOut.root.dataset.stageKind = dmx ? 'dmx-output' : 'output-transformation';
    if (dmx) {
      E.pOut.cv.tabIndex = 0;
      E.pOut.cv.setAttribute('role', 'application');
      E.pOut.cv.setAttribute('aria-label', 'DMX Output fixture map for ' + String((sc && sc.name) || 'Lumiverse'));
    } else {
      E.pOut.cv.removeAttribute('tabindex');
      E.pOut.cv.removeAttribute('role');
      E.pOut.cv.removeAttribute('aria-label');
      E.pOut.cv.removeAttribute('title');
      delete E.pOut.cv.dataset.universes;
      delete E.pOut.cv.dataset.fixtureCount;
      delete E.pOut.cv.dataset.overlapCount;
    }
  }
  function paintDmxOutputLegacy(p, size, sc, t0) {
    const ctx = p.ctx, data = dmxLayout(sc), colours = dmxPalette();
    const v = viewOf('output', data.width, data.height, size.w, size.h);
    const baseUniverse = Math.round(pnum(sc, ['Universe'], 0));
    const blocks = [];
    hideMsg(p);

    ctx.save();
    for (let u = 0; u < data.universeCount; u++) {
      const laneY = u * DMX_LANE_PITCH + DMX_LANE_TOP;
      const a = toView(v, P(0, laneY));
      const b = toView(v, P(DMX_CHANNELS, laneY + DMX_LANE_HEIGHT));
      ctx.fillStyle = colours.lane;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = colours.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, Math.max(0, b.x - a.x - 1), Math.max(0, b.y - a.y - 1));
      for (let channel = 64; channel < DMX_CHANNELS; channel += 64) {
        const x = toView(v, P(channel, laneY)).x;
        ctx.beginPath(); ctx.moveTo(x + 0.5, a.y); ctx.lineTo(x + 0.5, b.y); ctx.stroke();
      }
      ctx.fillStyle = colours.dim;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('U' + (baseUniverse + u), a.x - 5, (a.y + b.y) / 2);
    }

    for (const fixture of data.fixtures) {
      for (let u = 0; u < data.universeCount; u++) {
        const first = u * DMX_CHANNELS + 1, last = first + DMX_CHANNELS - 1;
        const segStart = Math.max(fixture.start, first), segEnd = Math.min(fixture.end, last);
        if (segStart > segEnd) continue;
        const x0m = segStart - first;
        const x1m = segEnd - first + 1;
        const y0m = u * DMX_LANE_PITCH + DMX_LANE_TOP + 5;
        const y1m = y0m + DMX_LANE_HEIGHT - 10;
        const a = toView(v, P(x0m, y0m)), b = toView(v, P(x1m, y1m));
        const selected = ST.sel.indexOf(fixture.id) >= 0;
        const fill = fixture.overlap ? colours.overlap : selected ? colours.selected
          : sliceOn(fixture.sl) ? colours.fixture : colours.disabled;
        const visualWidth = Math.max(3, b.x - a.x);
        ctx.globalAlpha = sliceOn(fixture.sl) ? 0.82 : 0.36;
        ctx.fillStyle = fill;
        ctx.fillRect(a.x, a.y, visualWidth, b.y - a.y);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = fixture.overlap ? colours.overlap : selected ? colours.selected : colours.grid;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(a.x + 0.5, a.y + 0.5, Math.max(1, visualWidth - 1), Math.max(1, b.y - a.y - 1));
        if (visualWidth >= 42) {
          ctx.save();
          ctx.beginPath(); ctx.rect(a.x + 3, a.y, visualWidth - 6, b.y - a.y); ctx.clip();
          ctx.fillStyle = colours.text;
          ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(sliceName(fixture.sl) + '  ' + fixture.start + '–' + fixture.end,
            a.x + 5, (a.y + b.y) / 2);
          ctx.restore();
        }
        blocks.push({ sliceId: fixture.id, fixture, universe: u,
          x0: a.x, y0: a.y, x1: a.x + visualWidth, y1: b.y });
      }
    }
    ctx.restore();

    const map = Object.assign(data, { screen: sc, view: v, blocks });
    p._dmxMap = map;
    p.cv.dataset.universes = String(data.universeCount);
    p.cv.dataset.fixtureCount = String(data.fixtures.length);
    p.cv.dataset.overlapCount = String(data.overlapCount);
    p.cv.setAttribute('aria-label', 'DMX Output fixture map for ' + String(sc.name || 'Lumiverse') +
      ': ' + data.fixtures.length + ' fixture' + (data.fixtures.length === 1 ? '' : 's') +
      ', ' + data.overlapCount + ' overlap' + (data.overlapCount === 1 ? '' : 's'));
    p.cv.title = 'Select a fixture, then drag it along the universe lanes to change Start Channel. Arrow keys move one channel; Shift moves ten.';

    const disabled = ST.flags.outputOff ? ' · output disabled' : '';
    const overlap = data.overlapCount ? ' · ' + data.overlapCount + ' overlap' + (data.overlapCount === 1 ? '' : 's') : '';
    badge(p, 'oo-badge' + (!ST.flags.outputOff && screenOn(sc) && artTargetOf(sc) !== 'TT_DISABLED' ? ' routed' : ''),
      (sc.name || 'Lumiverse') + ' · ' + data.universeCount + ' universe' +
      (data.universeCount === 1 ? '' : 's') + ' · ' + data.fixtures.length + ' fixture' +
      (data.fixtures.length === 1 ? '' : 's') + overlap);
    p.fed.textContent = dmxTargetLabel(sc) + disabled;
    p.read.textContent = dmxReadout(map);
    p.hud.textContent = data.fixtures.length + ' fixtures · ' + data.maxEnd + ' channels · ' +
      data.overlapCount + ' overlaps';
    ST.stats.outMs += ((now() - t0) - ST.stats.outMs) * 0.15;
  }

  function paintDmxOutput(p, size, sc, t0) {
    const ctx = p.ctx, data = dmxLayout(sc), colours = dmxPalette();
    /* Populate the shared view cache, while the DMX pointer path uses the
       pixel-exact wrapped grid. DMX Output itself has no spatial pan/zoom. */
    const v = viewOf('output', data.width, data.height, size.w, size.h);
    const grid = dmxGrid(size);
    const baseUniverse = Math.round(pnum(sc, ['Universe'], 0));
    const blocks = [];
    hideMsg(p);

    ctx.save();
    for (let u = 0; u < data.universeCount; u++) {
      for (let row = 0; row < DMX_ROWS_PER_UNIVERSE; row++) {
        const first = row * DMX_ROW_CHANNELS;
        const count = Math.min(DMX_ROW_CHANNELS, DMX_CHANNELS - first);
        const y = grid.rowTop(u, row);
        ctx.fillStyle = colours.lane;
        ctx.fillRect(grid.left, y, DMX_ROW_CHANNELS * grid.cellWidth, grid.rowHeight);
        if (count < DMX_ROW_CHANNELS) {
          ctx.globalAlpha = 0.38;
          ctx.fillStyle = colours.disabled;
          ctx.fillRect(grid.left + count * grid.cellWidth, y,
            (DMX_ROW_CHANNELS - count) * grid.cellWidth, grid.rowHeight);
          ctx.globalAlpha = 1;
        }
        /* Pixel boundaries (three channels for the default RGB personality)
           are always visible. The Grid toggle adds the individual channel
           lines without ever making the patch itself disappear. */
        for (let ch = 0; ch <= DMX_ROW_CHANNELS; ch++) {
          if (!ST.flags.showGrid && ch % 3 !== 0) continue;
          const x = grid.left + ch * grid.cellWidth;
          ctx.globalAlpha = ch % 3 === 0 ? 0.9 : 0.42;
          ctx.strokeStyle = colours.grid;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y);
          ctx.lineTo(x + 0.5, y + grid.rowHeight);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colours.grid;
        ctx.strokeRect(grid.left + 0.5, y + 0.5,
          Math.max(0, DMX_ROW_CHANNELS * grid.cellWidth - 1), grid.rowHeight - 1);
        if (row === 0) {
          ctx.fillStyle = colours.dim;
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText('U' + (baseUniverse + u), grid.left + 2, y + 2);
        }
      }
    }

    for (const fixture of data.fixtures) {
      let cursor = fixture.start, remaining = fixture.channels, fixtureOffset = 0;
      while (remaining > 0) {
        const zero = cursor - 1;
        const u = clamp(Math.floor(zero / DMX_CHANNELS), 0, data.universeCount - 1);
        const inUniverse = zero - u * DMX_CHANNELS;
        const row = Math.floor(inUniverse / DMX_ROW_CHANNELS);
        const col = inUniverse % DMX_ROW_CHANNELS;
        const availableInRow = Math.min(DMX_ROW_CHANNELS - col, DMX_CHANNELS - inUniverse);
        const span = Math.min(remaining, availableInRow);
        const x = grid.left + col * grid.cellWidth;
        const y = grid.rowTop(u, row) + 3;
        const w = span * grid.cellWidth;
        const h = grid.rowHeight - 6;
        const selected = ST.sel.indexOf(fixture.id) >= 0;
        const hovered = ST.hover && ST.hover.sliceId === fixture.id;
        const fill = fixture.overlap ? colours.overlap : selected ? colours.selected
          : sliceOn(fixture.sl) ? colours.fixture : colours.disabled;
        ctx.globalAlpha = sliceOn(fixture.sl) ? 0.82 : 0.36;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, Math.max(2, w), h);

        /* Raised caps expose the personality's pixel grouping. For RGB, each
           cap spans three channels, matching Arena's 16-block LED bar. */
        const info = fixtureOf(fixture.sl);
        const perPixel = Math.max(1, fixture.channels / Math.max(1, info.pixels || 1));
        ctx.globalAlpha = sliceOn(fixture.sl) ? 0.95 : 0.42;
        for (let off = 0; off < span; off += perPixel) {
          const capX = x + off * grid.cellWidth + 1;
          const capW = Math.max(1, Math.min(perPixel, span - off) * grid.cellWidth - 2);
          ctx.fillRect(capX, y - 3, capW, 4);
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = fixture.overlap ? colours.overlap : hovered ? colours.hover
          : selected ? colours.selected : colours.grid;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        if (fixtureOffset === 0 && w >= 54) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 3, y, w - 6, h);
          ctx.clip();
          ctx.fillStyle = colours.text;
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(sliceName(fixture.sl) + '  ' + fixture.start + '-' + fixture.end,
            x + 5, y + h / 2);
          ctx.restore();
        }
        blocks.push({ sliceId: fixture.id, fixture, universe: u,
          x0: x, y0: y - 3, x1: x + Math.max(2, w), y1: y + h });
        cursor += span;
        remaining -= span;
        fixtureOffset += span;
      }
    }

    /* The small top-right patch overview is drawn from this layout only. It
       adds no composition render and no GPU-to-CPU readback. */
    if (grid.navWidth) {
      const nx = grid.navLeft, ny = grid.top, nw = grid.navWidth;
      const nh = Math.max(34, Math.min(52, data.universeCount * 18 + 18));
      ctx.fillStyle = colours.surface;
      ctx.fillRect(nx, ny, nw, nh);
      ctx.strokeStyle = colours.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(nx + 0.5, ny + 0.5, nw - 1, nh - 1);
      const total = Math.max(1, data.universeCount * DMX_CHANNELS);
      for (const fixture of data.fixtures) {
        const y0 = ny + 6 + ((fixture.start - 1) / total) * (nh - 12);
        const y1 = ny + 6 + (fixture.end / total) * (nh - 12);
        ctx.fillStyle = fixture.overlap ? colours.overlap
          : ST.sel.indexOf(fixture.id) >= 0 ? colours.selected : colours.fixture;
        ctx.fillRect(nx + 6, y0, nw - 12, Math.max(2, y1 - y0));
      }
      ctx.fillStyle = colours.text;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(data.universeCount), nx + nw / 2, ny + 3);
    }
    ctx.restore();

    const map = Object.assign(data, { screen: sc, view: v, grid, blocks });
    p._dmxMap = map;
    p.cv.dataset.universes = String(data.universeCount);
    p.cv.dataset.fixtureCount = String(data.fixtures.length);
    p.cv.dataset.overlapCount = String(data.overlapCount);
    p.cv.setAttribute('aria-label', 'DMX Output fixture map for ' + String(sc.name || 'Lumiverse') +
      ': ' + data.fixtures.length + ' fixture' + (data.fixtures.length === 1 ? '' : 's') +
      ', ' + data.overlapCount + ' overlap' + (data.overlapCount === 1 ? '' : 's'));
    p.cv.title = 'Select a fixture, then drag it across the patch grid to change Start Channel. Arrow keys move one channel; Shift moves ten.';

    const disabled = ST.flags.outputOff ? ' - output disabled' : '';
    badge(p, 'oo-badge', '');
    p.fed.textContent = dmxTargetLabel(sc) + disabled;
    p.read.textContent = dmxReadout(map);
    p.hud.textContent = data.fixtures.length + ' fixtures - ' + data.maxEnd + ' channels - ' +
      data.overlapCount + ' overlaps';
    ST.stats.outMs += ((now() - t0) - ST.stats.outMs) * 0.15;
  }

  function paintOutput() {
    const p = E.pOut, t0 = now();
    ST.stageError.output = null;
    const size = sizeCanvas(p);
    const ctx = p.ctx;
    const sc = curScreen();
    ctx.clearRect(0, 0, size.w, size.h);
    if (!sc) {
      showMsg(p, 'No screen', 'The setup has no screens. Add one with the + menu at the foot of the tree.');
      return;
    }
    syncStageIdentity();
    if (isDmxScreen(sc)) {
      paintDmxOutput(p, size, sc, t0);
      return;
    }
    p._dmxMap = null;
    const dev = devSize(sc);
    const v = viewOf('output', dev.width, dev.height, size.w, size.h);
    const x = v.ox, y = v.oy, w = dev.width * v.scale, h = dev.height * v.scale;

    /* the device raster, on a checkerboard so straight alpha reads as alpha —
       a slice composites with STRAIGHT alpha when a layer is routed to it
       [slice-routing.htm], and that is only visible against a known ground */
    ctx.save();
    checker(ctx, x, y, w, h);
    let ok = false;
    if (!hasGL()) {
      /* honest degradation: say what is missing, do not draw a stand-in */
      showMsg(p, 'WebGL2 unavailable', 'The output window renders slices through the real GL pipeline ' +
        '(bezier patch → homography → soft-edge alpha). Without a WebGL2 context there is no warped frame to show, ' +
        'so none is invented. The geometry below is live and still editable.<br><code>' + esc(String(glReason || (renderer && renderer.lastError) || 'no context')) + '</code>');
    } else {
      const frame = renderScreenFrame(sc, 0);
      const rec = frames.get(String(sc.uniqueId));
      /* A CANVAS IS NOT A PICTURE.
         This used to accept any sized canvas as a good frame, which a screen
         whose every slice was skipped still produces — cleared, fully
         transparent, and the right dimensions. So the pane hid its message and
         lit the green LIVE badge over nothing at all, which is the same
         dishonesty as showing a fake picture, just quieter. Ask the renderer
         how many passes actually landed. */
      const painted = rec ? (rec.painted || 0) : 0;
      if (frame && frame.width && painted > 0) {
        try { ctx.drawImage(frame, x, y, w, h); ok = true; hideMsg(p); }
        catch (e) { ST.stageError.output = 'output blit: ' + String(e && e.message || e); }
      }
      if (!ok) {
        const why = (rec && rec.reasons && rec.reasons.length) ? rec.reasons.join(', ') : null;
        showMsg(p, 'No frame', why
          ? 'Nothing was drawn this frame: <code>' + esc(why) + '</code>. The geometry below is live and still editable.'
          : 'The renderer produced nothing this frame. ' +
            (renderer && renderer.lastError ? '<code>' + esc(renderer.lastError) + '</code>'
                                            : 'Check that a source is routed and playing.'));
      }
    }
    ctx.restore();

    if (ST.flags.showInOutput) drawGuide(ctx, v, 'output');

    ctx.save();
    ctx.strokeStyle = COL.frame; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
    if (ST.flags.ledGrid) drawLed(ctx, v, dev.width, dev.height);

    for (const sl of slicesOf(sc)) drawSliceOutput(ctx, v, sl);
    drawSelectionWidgets(ctx, v, 'output');
    drawLasso(ctx, 'output');

    const disabled = ST.flags.outputOff ? ' · output disabled' : '';
    badge(p, 'oo-badge' + (ok && !ST.flags.outputOff ? ' live' : ''),
      (sc.name || 'Screen') + ' · ' + Math.round(dev.width) + '×' + Math.round(dev.height));
    const outputDeviceLabel = deviceLabel(sc);
    const outputRaster = Math.round(dev.width) + '×' + Math.round(dev.height);
    const labelHasRaster = new RegExp('\\b' + Math.round(dev.width) + '\\s*[x×]\\s*' +
      Math.round(dev.height) + '\\b', 'i').test(outputDeviceLabel);
    p.fed.textContent = (labelHasRaster ? outputDeviceLabel : outputDeviceLabel + ': ' + outputRaster) + disabled;
    p.read.textContent = readoutFor('output', v);
    ST.stats.outMs += ((now() - t0) - ST.stats.outMs) * 0.15;
    p.hud.textContent = ST.stats.outMs.toFixed(1) + 'ms · gl ' + ST.stats.glMs.toFixed(1) + 'ms · ' +
      ST.stats.drawn + ' slices · ' + Math.round(ST.stats.tris) + ' tris';
  }

  function drawSliceOutput(ctx, v, sl) {
    if (isDmx(sl)) return;                     /* a fixture's output is DMX channels, not pixels */
    const poly = outline(sl, 'output', 16).map(q => toView(v, q));
    if (poly.length < 3) return;
    const sel = ST.sel.indexOf(String(sl.uniqueId)) >= 0;
    const hov = ST.hover && ST.hover.sliceId === String(sl.uniqueId);
    const off = !sliceOn(sl);
    ctx.save();
    ctx.globalAlpha = off ? 0.3 : 1;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    if (ST.flags.identify && hov) { ctx.fillStyle = COL.identify; ctx.fill(); }
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = isMask(sl) ? COL.mask : sel ? COL.sel : COL.slice;
    if (isMask(sl)) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (sel) {
      if (ST.flags.showGrid) drawSliceGrid(ctx, v, sl);
      /* Warp controls belong to Edit Points. They used to remain visible in
         Transform mode, where dragging one actually scaled the whole Slice —
         a visually identical handle with two unrelated meanings. */
      const net = ST.mode === 'points' ? netPoints(sl) : [], g = netOf(sl);
      if (ST.mode === 'points' && net.length && g) {
        ctx.strokeStyle = COL.net; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let r = 0; r < g.controlHeight; r++)
          for (let c = 0; c < g.controlWidth; c++) {
            const q = toView(v, net[r * g.controlWidth + c]);
            c ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
          }
        for (let c = 0; c < g.controlWidth; c++)
          for (let r = 0; r < g.controlHeight; r++) {
            const q = toView(v, net[r * g.controlWidth + c]);
            r ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
          }
        ctx.stroke();
        ctx.setLineDash([]);
        /* Point Mode = Bezier draws the two tangent handles per corner. In this
           model the tangents ARE the neighbouring control points of the cubic —
           there is nowhere else for a tangent to live in a 4×4 Bernstein net —
           so the "two additional bezier handles" are drawn as the arms from
           each corner to its two neighbours. */
        const bezNet = pointModeOf(sl) === 'bezier' && !isPoly(sl);
        if (bezNet) drawNetTangents(ctx, v, net, g);
        ctx.fillStyle = COL.ctrl;
        for (let i = 0; i < net.length; i++) {
          const q = toView(v, net[i]);
          if (bezNet) { ctx.beginPath(); ctx.arc(q.x, q.y, CR - 1, 0, Math.PI * 2); ctx.fill(); }
          else ctx.fillRect(q.x - (CR - 1), q.y - (CR - 1), (CR - 1) * 2, (CR - 1) * 2);
        }
      }
      /* The four BIG corners are perspective points in Edit Points and whole-
         Slice scale handles in Transform. A Transform multi-selection uses the
         one hull drawn by drawSelectionWidgets instead. */
      if (ST.mode === 'points' || selectedForStage('output').length === 1) {
        const cs = cornersOf(sl);
        for (let i = 0; i < cs.length; i++) drawHandle(ctx, toView(v, cs[i]), HR - 2, COL.corner, false);
      }
      drawSoftEdgeBand(ctx, v, sl);
    }
    ctx.restore();
  }

  /* Show Slice Grid — Arena help showGrid: "Shows the NAME and BOUNDS of the
     currently active slice ..., a PERSPECTIVE GRID for the slice surface and A
     BIG RED CROSS WHERE YOUR CURSOR IS." */
  function drawSliceGrid(ctx, v, sl) {
    const H = matrixOf(sl), n = 8;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      for (let i = 0; i <= 16; i++) {
        const q = toView(v, outputAt(sl, i / 16, k / n, H));
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      for (let i = 0; i <= 16; i++) {
        const q = toView(v, outputAt(sl, k / n, i / 16, H));
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
    }
    ctx.stroke();
    const b = bounds(outline(sl, 'output', 8).map(q => toView(v, q)));
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(sliceName(sl), b.x0 + 4, b.y0 + 14);
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(Math.round(b.x1 - b.x0) + '×' + Math.round(b.y1 - b.y0), b.x0 + 4, b.y0 + 26);
    if (ST.hover && ST.hover.stage === 'output' && ST.hover.view) {
      ctx.strokeStyle = 'rgba(255,60,60,0.95)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ST.hover.view.x - 22, ST.hover.view.y); ctx.lineTo(ST.hover.view.x + 22, ST.hover.view.y);
      ctx.moveTo(ST.hover.view.x, ST.hover.view.y - 22); ctx.lineTo(ST.hover.view.x, ST.hover.view.y + 22);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Where the blend actually falls. The band widths are clone-side state
     (Arena's per-edge widths were collapsed to a boolean by the extractor), so
     this is drawn from slice.softEdge, which is what the renderer reads too. */
  function drawSoftEdgeBand(ctx, v, sl) {
    if (!sl.softEdgeEnable) return;
    const b = sl.softEdge || {};
    const H = matrixOf(sl);
    const edges = [
      ['left', num(b.left, 0), (t, e) => outputAt(sl, e, t, H)],
      ['right', num(b.right, 0), (t, e) => outputAt(sl, 1 - e, t, H)],
      ['top', num(b.top, 0), (t, e) => outputAt(sl, t, e, H)],
      ['bottom', num(b.bottom, 0), (t, e) => outputAt(sl, t, 1 - e, H)]
    ];
    ctx.save();
    ctx.strokeStyle = 'rgba(255,120,255,0.55)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    for (const [, wdt, fn] of edges) {
      if (!(wdt > 0)) continue;
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const q = toView(v, fn(i / 12, clamp(wdt, 0, 0.5)));
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawNetTangents(ctx, v, net, g) {
    const cw = g.controlWidth, ch = g.controlHeight;
    const corners = [[0, 0], [cw - 1, 0], [cw - 1, ch - 1], [0, ch - 1]];
    ctx.save();
    ctx.strokeStyle = COL.tan; ctx.lineWidth = 1;
    for (const [c, r] of corners) {
      const o = toView(v, net[r * cw + c]);
      const nb = [[c + (c === 0 ? 1 : -1), r], [c, r + (r === 0 ? 1 : -1)]];
      for (const [nc, nr] of nb) {
        if (nc < 0 || nc >= cw || nr < 0 || nr >= ch) continue;
        const q = toView(v, net[nr * cw + nc]);
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawTangents(ctx, v, V) {
    ctx.save();
    ctx.strokeStyle = COL.tan; ctx.lineWidth = 1;
    for (let i = 0; i < V.length; i++) {
      const a = toView(v, V[i]), b = toView(v, V[(i + 1) % V.length]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25); ctx.stroke();
    }
    ctx.restore();
  }

  /* The transform widget and the multi-select bounding box: "A bounding box
     will appear around your selection that you can drag, rotate or scale ...
     the numbers reflect the properties of the bounding box, not the individual
     slices" [input-selection.htm]. */
  function drawSelectionWidgets(ctx, v, mode) {
    if (!ST.sel.length) return;
    const list = selectedForStage(mode);
    if (!list.length) return;
    let all = [];
    for (const sl of list) all = all.concat(mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8));
    if (!all.length) return;
    const b = bounds(all.map(q => toView(v, q)));
    ctx.save();
    if (list.length > 1 && ST.mode === 'transform') {
      ctx.strokeStyle = COL.sel; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.setLineDash([]);
      const cs = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
      for (const c of cs) drawHandle(ctx, c, CR, COL.sel, false);
    }
    drawSnapGuides(ctx, v, mode);
    /* Rotation belongs to the slice's top edge, not its changing AABB. */
    if (ST.mode === 'transform') {
      const {top, knob} = rotationWidget(v, mode);
      const d = ST.drag, rotating = d && d.kind === 'rotate' && d.mode === mode;
      const hovered = ST.hover && ST.hover.stage === mode && ST.hover.handle === 'rotate';
      const topHot = rotating ? d.rotationCorner === -1 : hovered && ST.hover.corner === -1;
      const armLength = Math.hypot(knob.x-top.x,knob.y-top.y);
      if (armLength > ROT_RADIUS) {
        const end = (armLength-ROT_RADIUS)/armLength;
        ctx.strokeStyle = topHot ? COL.sel : '#788493'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(top.x,top.y);
        ctx.lineTo(top.x+(knob.x-top.x)*end,top.y+(knob.y-top.y)*end); ctx.stroke();
      }
      if (rotating) {
        const c = toView(v,d.centre);
        ctx.strokeStyle = d.angleSnapped ? '#df8bff' : '#ffffff66'; ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(knob.x,knob.y); ctx.stroke(); ctx.setLineDash([]);
        drawHandle(ctx,c,3,'#fff',true);
      }
      drawRotationControl(ctx,knob,topHot ? (rotating ? 'drag' : 'hover') : 'idle');
      for (const edge of edgeHandles(v,mode)) drawHandle(ctx,edge.point,4,'#fff',true);
      for (const corner of rotationCorners(v,mode)) {
        const hot = rotating ? d.rotationCorner === corner.index : hovered && ST.hover.corner === corner.index;
        // Keep the frame quiet at rest. The existing outside-corner hit zones
        // stay intact; reveal the same compact control at the active grip only.
        if (hot) drawRotationControl(ctx,corner.grip,rotating ? 'drag' : 'hover');
      }
    }
    ctx.restore();
  }
  function drawRotationControl(ctx,centre,state) {
    ctx.save(); ctx.setLineDash([]); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(centre.x,centre.y,10,0,Math.PI*2);
    ctx.fillStyle = state === 'idle' ? '#171c24' : '#28313d'; ctx.fill();
    ctx.strokeStyle = state === 'drag' ? COL.sel : state === 'hover' ? '#c4cedb' : '#788493';
    ctx.lineWidth = 1; ctx.stroke();
    ctx.translate(centre.x-8,centre.y-8); ctx.scale(2/3,2/3);
    ctx.strokeStyle = state === 'drag' ? COL.sel : '#eef2f7'; ctx.lineWidth = 2;
    if (!rotationGlyphPath) rotationGlyphPath = new Path2D(ROT_GLYPH);
    ctx.stroke(rotationGlyphPath);
    ctx.restore();
  }
  function rotationWidget(v, mode) {
    const list = selectedForStage(mode);
    if (!list.length) return null;
    const d = ST.drag;
    if (d && d.kind === 'rotate' && d.mode === mode && d.widget) {
      const m = AF.about(d.centre.x,d.centre.y,AF.rot(d.appliedAngle || 0));
      return {top:toView(v,AF.ap(m,d.widget.top)), knob:toView(v,AF.ap(m,d.widget.knob))};
    }
    let all = [];
    for (const sl of list) all = all.concat(mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8));
    if (!all.length) return null;
    const b = bounds(all.map(q => toView(v, q)));
    let top = P((b.x0+b.x1)/2,b.y0), normal = P(0,-1);
    if (list.length === 1 && !isMask(list[0]) && !isPoly(list[0])) {
      const V = mode === 'input' ? verts(list[0],mode) : cornersOf(list[0]);
      if (V.length === 4) {
        const a = toView(v,V[0]), z = toView(v,V[1]), length = Math.hypot(z.x-a.x,z.y-a.y) || 1;
        top = P((a.x+z.x)/2,(a.y+z.y)/2); normal = P((z.y-a.y)/length,-(z.x-a.x)/length);
      }
    }
    const pane = mode === 'input' ? E.pIn : E.pOut;
    const knob = P(clamp(top.x+normal.x*ROT_ARM,14,Math.max(14,pane.box.clientWidth-14)),
      clamp(top.y+normal.y*ROT_ARM,14,Math.max(14,pane.box.clientHeight-40)));
    return {top,knob};
  }
  const rotKnob = (v,mode) => { const w = rotationWidget(v,mode); return w && w.knob; };

  function rotationCorners(v,mode) {
    if (ST.mode !== 'transform') return [];
    const list = selectedForStage(mode);
    if (!list.length) return [];
    let corners;
    if (list.length === 1) {
      if (isMask(list[0]) || isPoly(list[0])) return [];
      corners = (mode === 'input' ? verts(list[0],mode) : cornersOf(list[0])).slice(0,4).map(q => toView(v,q));
    } else {
      const b = selectionBounds(list.map(sl => String(sl.uniqueId)),mode);
      if (!b) return [];
      corners = [P(b.x0,b.y0),P(b.x1,b.y0),P(b.x1,b.y1),P(b.x0,b.y1)].map(q => toView(v,q));
    }
    if (corners.length !== 4) return [];
    const c = toView(v,selectionCentre(list,mode));
    return corners.map((point,index) => {
      // The exterior edge bisector gives the same perpendicular clearance on
      // both sides, even for a very wide/tall or rotated slice. A centre-to-
      // corner offset was aspect-ratio dependent and looked misaligned.
      const previous = corners[(index+3)%4], next = corners[(index+1)%4];
      const a = Math.hypot(point.x-previous.x,point.y-previous.y) || 1;
      const b = Math.hypot(point.x-next.x,point.y-next.y) || 1;
      let nx = (point.x-previous.x)/a+(point.x-next.x)/b;
      let ny = (point.y-previous.y)/a+(point.y-next.y)/b;
      if (Math.hypot(nx,ny)<1e-6) { nx=point.x-c.x; ny=point.y-c.y; }
      const length = Math.hypot(nx,ny) || 1, angle = Math.atan2(ny,nx);
      return {point,index,angle,grip:P(point.x+nx*ROT_CORNER_RADIUS/length,point.y+ny*ROT_CORNER_RADIUS/length)};
    });
  }
  function rotationHitAt(ptv,v,mode) {
    if (ST.mode !== 'transform') return null;
    const corners = rotationCorners(v,mode);
    // Resize gets the square itself; rotation lives strictly outside it.
    if (corners.some(c => d2(c.point,ptv) <= (HR+3)*(HR+3))) return null;
    const knob = rotKnob(v,mode);
    if (knob && d2(knob,ptv) <= (ROT_RADIUS+4)*(ROT_RADIUS+4)) return {corner:-1};
    const hit = corners.find(c => d2(c.grip,ptv) <= 11*11);
    return hit ? {corner:hit.index} : null;
  }

  function edgeHandles(v,mode) {
    const list = selectedForStage(mode);
    if (ST.mode !== 'transform' || list.length !== 1 || isMask(list[0]) || isPoly(list[0])) return [];
    /* A perspective-warped output has corner handles, not rectangular side grips. */
    const sl = list[0], V = verts(sl,mode);
    if (V.length !== 4) return [];
    if (mode === 'output' && cornersOf(sl).some((q,i) => d2(q,V[i]) > 1e-6)) return [];
    return V.map((q,i) => {
      const z = V[(i+1)%4], a = toView(v,q), b = toView(v,z);
      return {index:i, point:P((a.x+b.x)/2,(a.y+b.y)/2), length:Math.hypot(a.x-b.x,a.y-b.y), slice:sl};
    }).filter(h => h.length >= 36);
  }
  function drawSnapGuides(ctx,v,mode) {
    const d = ST.drag;
    if (!d || d.mode !== mode || !d.guides) return;
    const pane = mode === 'input' ? E.pIn : E.pOut;
    ctx.save(); ctx.strokeStyle = '#df8bff'; ctx.lineWidth = 1; ctx.setLineDash([5,3]); ctx.beginPath();
    if (d.guides.hitX !== null) { const x = toView(v,P(d.guides.hitX,0)).x; ctx.moveTo(x,0); ctx.lineTo(x,pane.box.clientHeight); }
    if (d.guides.hitY !== null) { const y = toView(v,P(0,d.guides.hitY)).y; ctx.moveTo(0,y); ctx.lineTo(pane.box.clientWidth,y); }
    ctx.stroke(); ctx.restore();
  }
  function syncGestureFeedback() {
    for (const p of [E.pIn,E.pOut]) {
      const d = ST.drag, f = selectionFrame(p.key);
      p.feedback.hidden = !d || d.mode !== p.key || !d.moved || !f || d.kind === 'pan' || d.kind === 'dmx-channel';
      if (p.feedback.hidden) continue;
      const text = d.kind === 'rotate'
        ? fmt((d.baseRot+(d.appliedAngle || 0))*180/Math.PI,1)+'°'+(d.angleSnapped ? ' · snapped' : '')+'  ·  Shift 15°  ·  Ctrl free'
        : d.kind === 'body' ? 'X '+fmt(f.cx)+'   Y '+fmt(f.cy)+'  ·  Shift axis  ·  Ctrl free'
        : 'W '+fmt(f.w)+' × H '+fmt(f.h)+'  ·  Shift ratio  ·  Alt centre';
      if (p.feedback.textContent !== text) p.feedback.textContent = text;
    }
  }

  function drawHandle(ctx, p, r, fill, round) {
    ctx.save();
    ctx.fillStyle = fill; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
    if (round) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2); ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2); }
    ctx.restore();
  }
  function drawLed(ctx, v, mw, mh) {
    const step = 8 * v.scale;
    if (step < 3) return;                       /* below this it is a grey wash, not a grid */
    ctx.save();
    ctx.strokeStyle = COL.led; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= mw; x += 8) { const q = toView(v, P(x, 0)); ctx.moveTo(q.x, v.oy); ctx.lineTo(q.x, v.oy + mh * v.scale); }
    for (let y = 0; y <= mh; y += 8) { const q = toView(v, P(0, y)); ctx.moveTo(v.ox, q.y); ctx.lineTo(v.ox + mw * v.scale, q.y); }
    ctx.stroke();
    ctx.restore();
  }
  function checker(ctx, x, y, w, h) {
    const s = 12;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = '#15161f'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#1b1d28';
    for (let j = 0; j * s < h; j++) for (let i = (j % 2); i * s < w; i += 2) ctx.fillRect(x + i * s, y + j * s, s, s);
    ctx.restore();
  }
  function drawLasso(ctx, mode) {
    if (!ST.lasso || ST.lasso.stage !== mode) return;
    const l = ST.lasso;
    ctx.save();
    ctx.strokeStyle = COL.lasso; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(145,132,217,0.10)';
    const x = Math.min(l.a.x, l.b.x), y = Math.min(l.a.y, l.b.y);
    ctx.fillRect(x, y, Math.abs(l.b.x - l.a.x), Math.abs(l.b.y - l.a.y));
    ctx.strokeRect(x, y, Math.abs(l.b.x - l.a.x), Math.abs(l.b.y - l.a.y));
    ctx.restore();
  }
  function drawGuide(ctx, v, which) {
    const sc = curScreen();
    if (!sc) return;
    const g = ST.guides.get(String(sc.uniqueId));
    const img = g && g[which];
    if (!img || !img.width) return;
    ctx.save();
    ctx.globalAlpha = clamp(num(g.opacity, 1), 0, 1);
    /* "It will load the file at its NATIVE RESOLUTION and position it in the
       TOP LEFT of your screen" [modifiers.htm] */
    ctx.drawImage(img, v.ox, v.oy, img.width * v.scale, img.height * v.scale);
    ctx.restore();
  }
  function readoutFor(mode, v) {
    const sl = primary();
    if (!sl) return Math.round(v.scale * 100) + '%   ·   no slice selected';
    const V = mode === 'input' ? verts(sl, 'input') : verts(sl, 'output');
    const f = rectFrame(V);
    return Math.round(v.scale * 100) + '%   ·   ' + sliceName(sl) +
      '   X ' + fmt(f.cx) + '  Y ' + fmt(f.cy) +
      '  W ' + fmt(f.w) + '  H ' + fmt(f.h) +
      '  R ' + fmt(f.rot * 180 / Math.PI) + '°' +
      (ST.sel.length > 1 ? '   (' + ST.sel.length + ' selected)' : '');
  }
  const triangulatable = V => {
    /* a self-crossing contour cannot be triangulated: "Resolume will draw the
       outline in RED" [input-selection.htm]. Segment-intersection is enough. */
    const n = V.length;
    if (n < 4) return true;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCross(V[i], V[(i + 1) % n], V[j], V[(j + 1) % n])) return false;
    }
    return true;
  };
  function segCross(a, b, c, d) {
    const s = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return s(a, b, c) !== s(a, b, d) && s(c, d, a) !== s(c, d, b);
  }
  function showMsg(p, title, html) {
    if (p._msg === title + html) { p.msg.style.display = ''; return; }
    p._msg = title + html;
    p.msg.style.display = '';
    p.msg.innerHTML = '<b>' + esc(title) + '</b>' + html;
  }
  function hideMsg(p) { p.msg.style.display = 'none'; }
  /* innerHTML churn is the one DOM write in the paint path that is worth
     caching: it runs 120 times a second across two panes otherwise */
  function badge(p, cls, text) {
    if (p._badge !== text) { p._badge = text; p.badge.innerHTML = '<i></i><span>' + esc(text) + '</span>'; }
    if (p.badge.className !== cls) p.badge.className = cls;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* "The screen will show the output it's sending to under its name"
     [screens.htm]. The output, not the screen's own name — the old version put
     d.name here, which is a copy of the screen name and therefore said nothing. */
  function deviceLabel(sc) {
    const d = sc && sc.outputDevice;
    if (!d) return 'no output device';
    const t = DEVICE_BY_KIND[d.kind];
    if (!t) return String(d.kind || 'device');
    if (t.kind === 'OutputDeviceDisplay') {
      const found = displayList().find(x => String(x.deviceId) === String(d.deviceId || d.name || ''));
      return found ? found.name : 'Display · unavailable';
    }
    if (t.enumerated) return t.label + ' · ' + String(d.deviceId || d.name || '?');
    if (t.senderField) return t.label + ' · ' + String(sc.name || '');
    return t.label;
  }

  /* =======================================================================
     hit testing
     ======================================================================= */
  /* Pointer picking is deliberately split into SELECTED handles and Slice
     bodies. The renderer's generic pick() correctly returns the topmost drawn
     Slice, but that made a Slice chosen in the tree impossible to drag whenever
     another Slice overlapped it. Arena draws handles only for the selection, so
     those visible handles (and the selected body beneath them) have first
     refusal. A click with no drag can still advance through the coincident body
     list; see cycleBodyClick(). */
  function inputScreenVisible(sc) { return !!sc && screenOn(sc) && !foldedOf(sc); }

  function bodyHitsAt(ptView, mode, v) {
    const out = [];
    const add = sc => {
      const list = slicesOf(sc);
      for (let i = list.length - 1; i >= 0; i--) {
        const sl = list[i];
        if (!sl || (mode === 'output' && isDmx(sl))) continue;
        const poly = (mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 12)).map(q => toView(v, q));
        if (poly.length >= 3 && pointInPoly(ptView, poly)) {
          out.push({ sliceId: String(sl.uniqueId), handle: 'body', index: -1,
            space: mode === 'input' ? 'composition' : 'screen', screen: sc });
        }
      }
    };
    if (mode === 'output') {
      const sc = curScreen();
      if (sc) add(sc);
    } else {
      const list = screens().filter(inputScreenVisible);
      /* Screens and Slices are painted in model order, so reverse both lists
         to enumerate exactly topmost -> backmost. */
      for (let i = list.length - 1; i >= 0; i--) add(list[i]);
    }
    return out;
  }

  function selectedForStage(mode) {
    const sc = curScreen();
    return selected().filter(sl => {
      const owner = screenOfSlice(sl.uniqueId);
      return mode === 'input' ? inputScreenVisible(owner) : owner === sc && !isDmx(sl);
    });
  }

  function selectionCornerAt(ptView, mode, v) {
    if (ST.mode !== 'transform') return null;
    const list = selectedForStage(mode);
    if (list.length < 2) return null;
    let all = [];
    for (const sl of list) all = all.concat(mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8));
    if (!all.length) return null;
    const b = bounds(all.map(q => toView(v, q)));
    const cs = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
    let best = null;
    for (let i = 0; i < cs.length; i++) {
      const d = d2(cs[i], ptView);
      if (d <= (CR + 3) * (CR + 3) && (!best || d < best.d)) best = { d, i };
    }
    if (!best) return null;
    const sl = list[0], sc = screenOfSlice(sl.uniqueId);
    return { sliceId: String(sl.uniqueId), handle: 'selection-corner', index: best.i,
      space: mode === 'input' ? 'composition' : 'screen', screen: sc };
  }

  function selectedHandleAt(ptView, mode, v) {
    const list = selectedForStage(mode);
    /* Transforming a multi-selection uses its one bounding box, never the
       individual Slice corners hidden underneath that box. */
    if (ST.mode === 'transform' && list.length !== 1) return null;
    for (const edge of edgeHandles(v,mode)) {
      if (d2(edge.point,ptView) <= 9*9) return {sliceId:String(edge.slice.uniqueId),
        handle:'side', index:edge.index, screen:screenOfSlice(edge.slice.uniqueId)};
    }
    let best = null;
    const take = (sl, sc, handle, index, q, radius, tie) => {
      const d = d2(toView(v, q), ptView);
      if (d > radius * radius) return;
      const rank = tie || 0;
      if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && rank > best.rank))
        best = { d, rank, sliceId: String(sl.uniqueId), handle, index,
          space: mode === 'input' ? 'composition' : (handle === 'bezier' ? 'src' : 'screen'), screen: sc };
    };
    for (const sl of list) {
      const sc = screenOfSlice(sl.uniqueId);
      if (mode === 'input') {
        const V = verts(sl, 'input');
        const n = ST.mode === 'points' ? V.length : Math.min(4, V.length);
        for (let i = 0; i < n; i++) take(sl, sc, 'input-corner', i, V[i], HR + 1, 1);
        continue;
      }
      /* In Transform mode only the four large whole-Slice corners are drawn.
         In Edit Points the net is drawn too; exact ties go to the large corner,
         matching drawSliceOutput()'s paint order and Arena's perspective
         draggers. */
      if (ST.mode === 'points') {
        const net = netPoints(sl);
        for (let i = 0; i < net.length; i++) take(sl, sc, 'bezier', i, net[i], CR, 0);
      }
      const cs = cornersOf(sl);
      for (let i = 0; i < cs.length; i++) take(sl, sc, 'output-corner', i, cs[i], HR, 2);
    }
    if (!best) return null;
    delete best.d; delete best.rank;
    return best;
  }

  /* On the Input stage every visible Screen participates. Body candidates are
     retained on the returned hit so pointer-up can cycle without re-running a
     hit test against geometry that may have moved during the gesture. */
  function pickAny(ptView, mode, v) {
    const groupCorner = selectionCornerAt(ptView, mode, v);
    if (groupCorner) return groupCorner;
    const selectedHandle = selectedHandleAt(ptView, mode, v);
    if (selectedHandle) return selectedHandle;
    const hits = bodyHitsAt(ptView, mode, v);
    if (!hits.length) return null;
    let chosen = null;
    /* Selection order matters: ST.sel[0] is the primary shown in the
       inspector. Prefer it, then the rest, before falling back to topmost. */
    for (const id of ST.sel) {
      chosen = hits.find(h => h.sliceId === String(id));
      if (chosen) break;
    }
    chosen = chosen || hits[0];
    return Object.assign({}, chosen, {
      overlaps: hits.map(h => ({ sliceId: h.sliceId, screen: h.screen }))
    });
  }

  /* =======================================================================
     pointer interaction
     ======================================================================= */
  /* The view a POINTER must be measured against is the view of the pane RIGHT
     NOW, not the one the last paint left behind. Clicking an inactive pane
     makes it the active one, which widens it (see setStage) — so between the
     event arriving and the hit test running, the box has already changed size
     and a cached fit-scale would put the cursor several hundred model pixels
     away from where the user aimed. Re-deriving it here costs one layout read
     and makes every gesture exact on the first click. */
  function liveView(p) {
    const size = sizeCanvas(p);
    if (p.key === 'input') {
      const c = compSize();
      return viewOf('input', c.width, c.height, size.w, size.h);
    }
    const sc = curScreen();
    if (!sc) return null;
    if (isDmxScreen(sc)) {
      const dmx = dmxLayout(sc);
      return viewOf('output', dmx.width, dmx.height, size.w, size.h);
    }
    const d = devSize(sc);
    return viewOf('output', d.width, d.height, size.w, size.h);
  }

  function bindPane(p) {
    const mode = p.key;
    const local = e => {
      const r = p.cv.getBoundingClientRect();
      return P(e.clientX - r.left, e.clientY - r.top);
    };
    p.box.addEventListener('contextmenu', e => { e.preventDefault(); liveView(p); onContext(p, local(e)); });
    p.cv.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      setStage(mode);
      liveView(p);                 /* the widen has already happened — re-measure */
      try { p.cv.focus({ preventScroll: true }); } catch (err) { p.cv.focus(); }
      p.cv.setPointerCapture(e.pointerId);
      onDown(p, local(e), e);
    });
    p.cv.addEventListener('pointermove', e => onMove(p, local(e), e));
    p.cv.addEventListener('pointerup', e => { try { p.cv.releasePointerCapture(e.pointerId); } catch (err) { } onUp(p, local(e), e); });
    p.cv.addEventListener('pointercancel', () => cancelGesture());
    p.cv.addEventListener('lostpointercapture', () => { if (ST.drag) cancelGesture(); });
    p.cv.addEventListener('dblclick', e => onDouble(p, local(e), e));
    p.cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (ST.drag) return;
      zoomBy(mode, e.deltaY < 0 ? 1.12 : 1 / 1.12, local(e));
    }, { passive: false });
  }

  function dmxHitAt(p, ptv) {
    const map = p && p._dmxMap;
    if (!map || !Array.isArray(map.blocks)) return null;
    for (let i = map.blocks.length - 1; i >= 0; i--) {
      const b = map.blocks[i];
      if (ptv.x >= b.x0 && ptv.x <= b.x1 && ptv.y >= b.y0 && ptv.y <= b.y1) return b;
    }
    return null;
  }
  function dmxAddressAt(map, ptv) {
    if (!map || !map.grid) return 1;
    const g = map.grid;
    const localY = Math.max(0, ptv.y - g.top);
    const universePitch = g.rowsPerUniverse * g.rowHeight + DMX_UNIVERSE_GAP;
    const universe = clamp(Math.floor(localY / universePitch), 0, map.universeCount - 1);
    const inUniverseY = localY - universe * universePitch;
    const row = clamp(Math.floor(inUniverseY / g.rowHeight), 0, g.rowsPerUniverse - 1);
    const column = clamp(Math.floor((ptv.x - g.left) / g.cellWidth), 0, DMX_ROW_CHANNELS - 1);
    const channel = clamp(row * DMX_ROW_CHANNELS + column + 1, 1, DMX_CHANNELS);
    return universe * DMX_CHANNELS + channel;
  }
  function dmxDown(p, ptv, e) {
    const map = p._dmxMap, hit = dmxHitAt(p, ptv);
    if (!hit) {
      if (!e.shiftKey) select([], 'output');
      return;
    }
    select([hit.sliceId], 'output');
    const address = dmxAddressAt(map, ptv);
    ST.drag = {
      kind: 'dmx-channel', mode: 'output', sliceId: hit.sliceId,
      screen: map.screen, map, start: ptv,
      grabOffset: address - hit.fixture.start, moved: false,
      pending: 'move fixture channel'
    };
  }

  function onDown(p, ptv, e) {
    const mode = p.key;
    const v = ST.view[mode];
    if (!v) return;
    ST.cycleSuppressDouble = false;
    /* Spacebar+drag pans the stage [modifiers.htm; shortcuts.htm; dmx.htm] */
    if (ST.space || e.button === 1) {
      ST.drag = { kind: 'pan', mode, start: ptv, ox: v.ox, oy: v.oy, fit: v.fit };
      p.cv.classList.add('oo-grabbing');
      return;
    }
    if (mode === 'output' && isDmxScreen(curScreen())) {
      dmxDown(p, ptv, e);
      return;
    }
    const mod = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };

    /* the rotation dragger comes before anything the renderer knows about */
    const rotationHit = rotationHitAt(ptv,v,mode);
    const stageSelection = selectedForStage(mode);
    if (rotationHit && stageSelection.length) {
      const list = stageSelection;
      const c = selectionCentre(list, mode);
      /* Shift constrains the resulting angle, not the drag delta. */
      const p0 = list[0];
      const baseRot = p0 ? rectFrame(mode === 'input' ? verts(p0, 'input') : verts(p0, 'output')).rot : 0;
      const widget = rotationWidget(v,mode);
      ST.drag = {
        kind: 'rotate', mode, centre: c, start: ptv, startModel: toModel(v, ptv),
        startAngle: angleAt(v, c, ptv), mod: mod, ids: list.map(sl => String(sl.uniqueId)),
        baseRot: baseRot,
        rotationCorner: rotationHit.corner,
        widget: {top:toModel(v,widget.top), knob:toModel(v,widget.knob)},
        lastAngle:angleAt(v,c,ptv), totalAngle:0, appliedAngle:0,
        before: list.map(sl => snapSlice(sl, mode)), pending: 'rotate', moved: false
      };
      return;
    }

    const hit = pickAny(ptv, mode, v);
    if (!hit) {
      /* "Drag around a group of slices on the stage to lasso them together" */
      if (!mod.shift) select([], mode);
      ST.lasso = { stage: mode, a: ptv, b: ptv, add: mod.shift };
      return;
    }
    const sl = sliceById(hit.sliceId);
    if (!sl) return;
    if (hit.screen && hit.screen !== curScreen() && mode === 'input') ST.screenId = hit.screen.uniqueId;

    /* Shift on a slice body means two documented things, and which one it is
       cannot be known at pointerdown:
         input-selection.htm  "shift click individual slices ... to add or
                               remove them from the selection"
         modifiers.htm        "hold down Shift while dragging to constrain
                               movement to either the x or y axis"
       One is a CLICK, the other a DRAG. This used to toggle the selection and
       return, which made the constrained drag unreachable — a shift-drag moved
       a slice by exactly 0. So the decision is deferred the same way the undo
       entry below already is: press sets the drag up, the first real movement
       cancels the toggle, and a press that never moves toggles on release.
       An unselected slice joins the selection at once either way, because that
       is the documented result of shift-clicking one. */
    let shiftToggle = null;
    if (mod.shift && hit.handle === 'body') {
      if (ST.sel.indexOf(String(hit.sliceId)) >= 0) shiftToggle = String(hit.sliceId);
      else { select(ST.sel.concat([String(hit.sliceId)]), mode); refreshSide(); }
    } else if (ST.sel.indexOf(String(hit.sliceId)) < 0) select([hit.sliceId], mode);

    /* "X and Y position information of the CURRENTLY SELECTED POINT"
       [English.xml:1353]. Grabbing a point is what selects it; the inspector's
       Point section then reads and writes that one vertex. */
    if (hit.handle === 'body' || hit.handle === 'selection-corner' || hit.handle === 'side') ST.point = null;
    else { ST.point = { sliceId: String(hit.sliceId), handle: hit.handle, index: hit.index | 0, stage: mode }; refreshSide(); }

    /* Alt-drag makes a transformed COPY. Duplication is deferred until the
       pointer crosses the drag threshold: Alt-click is still only a click, and
       the eventual duplicate+move is one Undo gesture. */
    const ids = mode === 'output' ? selectedForStage(mode).map(x => String(x.uniqueId)) : ST.sel.slice();

    ST.drag = {
      kind: hit.handle, mode, ids, hit, mod,
      start: ptv, startModel: toModel(v, ptv),
      before: ids.map(id => snapSlice(sliceById(id), mode)),
      overlaps: hit.overlaps || null,
      altDuplicate: mod.alt && hit.handle === 'body', dup: false, moved: false,
      toggle: shiftToggle,        /* survives only if this press never moves */
      /* the undo entry is taken on the first actual MOVE, not here: a click
         that only selects must not fill the undo stack with no-ops. The model
         is still untouched at that point, so the snapshot is the same one this
         line would have taken. */
      pending: mod.alt && hit.handle === 'body' ? 'duplicate (alt-drag)'
        : hit.handle === 'body' ? 'move'
        : hit.handle === 'selection-corner' ? 'scale selection'
        : (hit.handle === 'input-corner' || (hit.handle === 'output-corner' && ST.mode === 'transform')) ? 'scale'
        : hit.handle
    };
    if (hit.handle === 'selection-corner') ST.drag.selectionBox = selectionBounds(ids, mode);
  }

  function onMove(p, ptv, e) {
    const mode = p.key;
    const v = ST.view[mode];
    if (!v) return;
    ST.hover = null;
    const d = ST.drag;
    if (d && d.mode !== mode) return;
    if (mode === 'output' && isDmxScreen(curScreen()) && (!d || d.kind === 'dmx-channel')) {
      if (!d) {
        const hit = dmxHitAt(p, ptv);
        ST.hover = hit ? { sliceId: hit.sliceId, stage: mode, view: ptv, handle: 'body' }
          : { sliceId: null, stage: mode, view: ptv };
        p.cv.style.cursor = hit ? 'ew-resize' : 'default';
        return;
      }
      const travel = Math.hypot(ptv.x - d.start.x, ptv.y - d.start.y);
      if (!d.moved && travel <= 3) return;
      if (!d.moved) {
        d.moved = true;
        rememberGesture(d);
        if (d.pending) { push(d.pending); d.pending = null; }
      }
      const sl = sliceById(d.sliceId);
      if (!sl) return;
      setStartChannel(sl, dmxAddressAt(d.map, ptv) - d.grabOffset, d.screen);
      syncSide();
      return;
    }
    if (!d) {
      const hit = pickAny(ptv, mode, v);
      const rotationHit = rotationHitAt(ptv,v,mode);
      ST.hover = hit ? { sliceId: String(hit.sliceId), stage: mode, view: ptv, handle: hit.handle } : { sliceId: null, stage: mode, view: ptv };
      if (rotationHit) ST.hover = {stage:mode,handle:'rotate',corner:rotationHit.corner};
      p.cv.style.cursor = ST.space ? 'grab' : rotationHit ? ROT_CURSOR : hit ? resizeCursor(hit,mode) : 'default';
      if (ST.lasso) { ST.lasso.b = ptv; }
      return;
    }
    const mod = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
    d.guides = null;
    if (d.kind === 'pan') {
      v.ox = d.ox + (ptv.x - d.start.x);
      v.oy = d.oy + (ptv.y - d.start.y);
      v.fit = false;
      return;
    }
    /* Past this distance the gesture is a drag, not a click. Pointermove can
       fire without any meaningful displacement, so neither geometry nor Undo
       may change until this threshold is crossed. Once crossed, the chosen
       Slice is locked for the rest of the gesture. */
    const travel = Math.hypot(ptv.x - d.start.x, ptv.y - d.start.y);
    if (!d.moved && travel <= 3) return;
    if (!d.moved) {
      d.moved = true;
      d.toggle = null;
      ST.pickCycle = null;
      rememberGesture(d);
      if (d.pending) { push(d.pending); d.pending = null; }
      if (d.altDuplicate) {
        const copies = d.ids.map(id => duplicateSlice(sliceById(id))).filter(Boolean);
        if (copies.length) {
          d.ids = copies.map(c => String(c.uniqueId));
          d.before = copies.map(c => snapSlice(c, mode));
          d.dup = true;
          ST.sel = d.ids.slice();
          ST.point = null;
          refreshTree(); refreshSide();
          emit('select', { slices: ST.sel.slice(), screenId: ST.screenId });
        }
      }
    }
    if (d.kind === 'rotate') {
      if (d2(toView(v,d.centre),ptv) < 16) return;
      const a = rotationDelta(d,angleAt(v,d.centre,ptv),mod,ST.flags.snap);
      p.cv.style.cursor = 'grabbing';
      for (let i = 0; i < d.ids.length; i++) {
        const sl = sliceById(d.ids[i]);
        if (!sl) continue;
        restoreSlice(sl, d.before[i], mode);
        applyAffine(sl, AF.about(d.centre.x, d.centre.y, AF.rot(a)), mode);
      }
      syncSide();
      return;
    }
    const dmv = toModel(v, ptv), dstart = d.startModel;
    let dx = dmv.x - dstart.x, dy = dmv.y - dstart.y;
    /* Shift constrains MOVEMENT to one axis — "Hold down Shift while dragging
       to constrain movement to either the x or y axis" [modifiers.htm]. That is
       a different modifier from "Hold down Shift while scaling slices to
       constrain aspect ratio", which scaleFromCorner() applies itself.
       Corner handles used to be listed here too, which zeroed one component
       BEFORE line 2445 rotates the delta into slice axes: on an unrotated Slice
       that pinned one ratio at exactly 1.0 and Shift-shrink became a silent
       no-op, and on a rotated one it leaked into both local axes so dragging
       inward GREW the Slice. Body, bezier and the Edit-Points perspective
       corners are true movement and keep the axis constraint. */
    if (mod.shift && (d.kind === 'body' || d.kind === 'bezier' ||
        (d.kind === 'output-corner' && ST.mode === 'points'))) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }

    if (d.kind === 'body') {
      for (let i = 0; i < d.ids.length; i++) {
        const sl = sliceById(d.ids[i]);
        if (!sl) continue;
        restoreSlice(sl, d.before[i], mode);
      }
      /* Ctrl temporarily disables snapping [modifiers.htm; input-selection.htm] */
      if (ST.flags.snap && !mod.ctrl) {
        const all = [];
        for (const id of d.ids) {
          const sl = sliceById(id);
          if (!sl) continue;
          const V = mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 4);
          for (const q of V) all.push(P(q.x + dx, q.y + dy));
        }
        if (all.length) {
          const tol = 8 / v.scale;
          const s = snapDelta(bounds(all), snapTargets(mode, curScreen(), d.ids), tol, ST.flags.ledGrid);
          /* Snapping must not leak movement onto the Shift-locked axis. */
          const lockX = mod.shift && Math.abs(dmv.x-dstart.x) <= Math.abs(dmv.y-dstart.y);
          const lockY = mod.shift && !lockX;
          if (!lockX) dx += s.dx; else s.hitX = null;
          if (!lockY) dy += s.dy; else s.hitY = null;
          d.guides = s;
        }
      }
      for (const id of d.ids) {
        const sl = sliceById(id);
        if (sl) applyAffine(sl, AF.move(dx, dy), mode);
      }
      ST.lastDup = d.dup ? { dx, dy } : ST.lastDup;
      syncSide();
      return;
    }

    if (d.kind === 'selection-corner') {
      scaleSelectionFromCorner(d, dmv, Object.assign({},mod,{shift:mod.shift || ST.lockRatio}));
      syncSide();
      return;
    }

    if (d.kind === 'side' || d.kind === 'input-corner' || (d.kind === 'output-corner' && ST.mode === 'transform')) {
      const sl = sliceById(d.ids[0]);
      if (!sl) return;
      restoreSlice(sl, d.before[0], mode);
      if (ST.mode === 'points') { movePoint(sl, mode, d.hit.index, dmv, mod); syncSide(); return; }
      scaleFromCorner(sl, mode, d.hit.index, dx, dy,
        Object.assign({},mod,{shift:mod.shift || ST.lockRatio, side:d.kind === 'side'}));
      syncSide();
      return;
    }
    if (d.kind === 'output-corner') {                 /* Edit Points: perspective */
      const sl = sliceById(d.ids[0]);
      const h = homoOf(sl);
      if (!sl || !h) return;
      restoreSlice(sl, d.before[0], mode);
      let q = P(d.before[0].homo.dst[d.hit.index].x + dx, d.before[0].homo.dst[d.hit.index].y + dy);
      if (ST.flags.snap && !mod.ctrl && ST.flags.ledGrid) q = P(Math.round(q.x / 8) * 8, Math.round(q.y / 8) * 8);
      h.dst[d.hit.index].x = q.x; h.dst[d.hit.index].y = q.y;
      sl._h = null;
      syncSide();
      return;
    }
    if (d.kind === 'bezier') {
      const sl = sliceById(d.ids[0]);
      const g = netOf(sl);
      if (!sl || !g) return;
      restoreSlice(sl, d.before[0], mode);
      /* the handle is seen through H, so the cursor has to come back through
         H⁻¹ before it is written into the (src-space) control net */
      const Hi = invert3(matrixOf(sl));
      const before = d.before[0].net[d.hit.index];
      const seen = applyH(matrixOf(sl), before);
      const want = P(seen.x + dx, seen.y + dy);
      const src = Hi ? applyH(Hi, want) : want;
      g.vertices[d.hit.index].x = src.x;
      g.vertices[d.hit.index].y = src.y;
      syncSide();
      return;
    }
  }

  function resizeCursor(hit,mode) {
    if (hit.handle === 'body') return 'move';
    if (ST.mode !== 'transform' || hit.handle === 'bezier') return 'crosshair';
    const f = rectFrame(verts(sliceById(hit.sliceId),mode));
    const angle = (hit.handle === 'side' ? (hit.index % 2 ? 0 : 90)
      : hit.index % 2 ? -45 : 45) + f.rot * 180 / Math.PI;
    return ['ew-resize','nwse-resize','ns-resize','nesw-resize'][((Math.round(angle/45)%4)+4)%4];
  }
  function rotationDelta(d,angle,mod,snap) {
    /* Unwrap successive pointer angles so crossing ±180° and multiple turns
       remain continuous. No rounding is accumulated into the geometry. */
    const delta = Math.atan2(Math.sin(angle-d.lastAngle),Math.cos(angle-d.lastAngle));
    d.totalAngle += delta; d.lastAngle = angle;
    let result = d.baseRot+d.totalAngle;
    const step = (mod.shift ? 15 : 45)*Math.PI/180;
    const nearest = Math.round(result/step)*step;
    d.angleSnapped = !mod.ctrl && (mod.shift || (snap && Math.abs(result-nearest) <= 2.5*Math.PI/180));
    if (d.angleSnapped) result = nearest;
    d.appliedAngle = result-d.baseRot;
    return d.appliedAngle;
  }
  function rememberGesture(d) {
    d.cancelXML = snapshot();
    d.history = {undo:ST.undo.slice(),redo:ST.redo.slice(),sel:ST.sel.slice(),lastDup:ST.lastDup,
      point:ST.point, routes:new Map(ST.routes)};
  }
  function cancelGesture() {
    const d = ST.drag;
    ST.drag = null; ST.lasso = null;
    if (d && d.kind === 'pan' && ST.view[d.mode]) Object.assign(ST.view[d.mode],{ox:d.ox,oy:d.oy,fit:d.fit});
    for (const p of [E.pIn,E.pOut]) { p.cv.classList.remove('oo-grabbing'); p.cv.style.cursor = 'default'; }
    if (d && d.cancelXML && d.history) {
      ST.sel = d.history.sel; ST.lastDup = d.history.lastDup; ST.point = d.history.point; ST.routes = d.history.routes;
      restore(d.cancelXML);
      ST.undo = d.history.undo; ST.redo = d.history.redo;
      paintFoot();
    } else if (d && d.before) {
      d.ids.forEach((id,i) => restoreSlice(sliceById(id),d.before[i]));
    }
    refreshSide(); syncPositionBar(); syncGestureFeedback();
  }

  const PICK_CYCLE_MS = 900, PICK_CYCLE_TOL = 6;
  function cycleBodyClick(d, ptv) {
    const hits = (d && d.overlaps || []).filter(h => !!sliceById(h.sliceId));
    if (hits.length < 2) { ST.pickCycle = null; return; }
    const pressed = sliceById(d.hit && d.hit.sliceId);
    /* A mask/poly double-click owns its documented point-edit gesture. Regular
       Slice bodies use the second click of a double-click to advance. */
    if (isMask(pressed) || isPoly(pressed)) { ST.pickCycle = null; return; }
    const signature = d.mode + '|' + hits.map(h => h.sliceId).join('|');
    const t = now(), prev = ST.pickCycle;
    const same = !!prev && prev.signature === signature && prev.mode === d.mode &&
      (t - prev.time) <= PICK_CYCLE_MS && d2(prev.point, ptv) <= PICK_CYCLE_TOL * PICK_CYCLE_TOL;
    let index = hits.findIndex(h => h.sliceId === String(d.hit.sliceId));
    if (index < 0) index = 0;
    if (same) {
      index = (prev.index + 1) % hits.length;
      const target = hits[index];
      select([target.sliceId], d.mode, true);
      ST.cycleSuppressDouble = true;
      hint('Selected ' + sliceName(sliceById(target.sliceId)) + ' · ' + (index + 1) + '/' + hits.length);
    }
    ST.pickCycle = { signature, mode: d.mode, point: P(ptv.x, ptv.y), index, time: t };
  }

  function onUp(p, ptv) {
    p.cv.classList.remove('oo-grabbing');
    if (ST.lasso) {
      const l = ST.lasso, v = ST.view[l.stage];
      const x0 = Math.min(l.a.x, l.b.x), x1 = Math.max(l.a.x, l.b.x);
      const y0 = Math.min(l.a.y, l.b.y), y1 = Math.max(l.a.y, l.b.y);
      const got = [];
      if (Math.abs(x1 - x0) > 3 && Math.abs(y1 - y0) > 3) {
        const list = l.stage === 'input' ? screens().filter(inputScreenVisible) : [curScreen()];
        for (const sc of list) for (const sl of slicesOf(sc || {})) {
          if (!sl) continue;
          const V = (l.stage === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8)).map(q => toView(v, q));
          if (!V.length) continue;
          const b = bounds(V);
          if (b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1) got.push(String(sl.uniqueId));
        }
      }
      if (got.length) select(l.add ? ST.sel.concat(got) : got, l.stage);
      ST.lasso = null;
    }
    if (ST.drag && ST.drag.kind === 'dmx-channel') {
      ST.drag = null;
      refreshSide();
      return;
    }
    /* A shift-press that never became a drag toggles selection. An ordinary
       body click seeds/advances overlap cycling. A real drag does neither. */
    if (ST.drag && ST.drag.toggle) toggleSel(ST.drag.toggle);
    else if (ST.drag && !ST.drag.moved && ST.drag.kind === 'body' && !ST.drag.mod.shift && !ST.drag.mod.alt)
      cycleBodyClick(ST.drag, ptv);
    ST.drag = null;
    syncGestureFeedback(); syncPositionBar();
    refreshSide();
  }

  /* Double click on a mask/polygon path adds a point there; on a point, removes
     it [modifiers.htm; input-selection.htm; output-transformation.htm]. The
     warp grid is deliberately NOT included: the manual gives it Subdivisions
     X/Y and no gesture. */
  function onDouble(p, ptv) {
    if (ST.cycleSuppressDouble) { ST.cycleSuppressDouble = false; return; }
    const mode = p.key, v = ST.view[mode];
    const sl = primary();
    if (!sl || !v) return;
    if (!isPoly(sl) && !isMask(sl)) return;
    const r = mode === 'input' ? sl.inputRect : sl.outputRect;
    if (!r) return;
    const V = r.vertices;
    for (let i = 0; i < V.length; i++) {
      if (d2(toView(v, V[i]), ptv) <= (HR + 2) * (HR + 2)) {
        if (V.length <= 3) return hint('A shape needs at least three points', true);
        push('remove point'); V.splice(i, 1); refresh(); return;
      }
    }
    let best = -1, bd = 14 * 14;
    for (let i = 0; i < V.length; i++) {
      const a = toView(v, V[i]), b = toView(v, V[(i + 1) % V.length]);
      const d = distToSeg(ptv, a, b);
      if (d * d < bd) { bd = d * d; best = i; }
    }
    if (best >= 0) {
      push('add point');
      const m = toModel(v, ptv);
      V.splice(best + 1, 0, P(m.x, m.y));
      refresh();
    }
  }
  function distToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const L = vx * vx + vy * vy;
    const t = L ? clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / L, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }

  const angleAt = (v, c, ptv) => { const m = toModel(v, ptv); return Math.atan2(m.y - c.y, m.x - c.x); };
  function selectionBounds(ids, mode) {
    let all = [];
    for (const id of ids || []) {
      const sl = sliceById(id);
      if (!sl || (mode === 'output' && isDmx(sl))) continue;
      all = all.concat(mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8));
    }
    return all.length ? bounds(all) : null;
  }
  function selectionCentre(list, mode) {
    let all = [];
    for (const sl of list) all = all.concat(mode === 'input' ? verts(sl, 'input') : outline(sl, 'output', 8));
    if (!all.length) return P(0, 0);
    const b = bounds(all);
    return P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  }

  /* Multi-select hull scaling. The hull is axis-aligned in stage space, which
     is exactly what drawSelectionWidgets paints. Alt changes the anchor to the
     centre; Shift uses one factor on both axes. Every Slice is restored from
     the pointer-down snapshot before the one affine is applied, so rounding
     cannot accumulate over pointermove frames. */
  function scaleSelectionFromCorner(d, mpos, mod) {
    const b = d.selectionBox;
    if (!b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) return;
    const cs = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
    const opposite = [2, 3, 0, 1][d.hit.index | 0];
    const start = cs[d.hit.index | 0] || cs[0];
    const origin = mod.alt ? P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) : cs[opposite];
    const vx = start.x - origin.x, vy = start.y - origin.y;
    let sx = Math.abs(vx) > 1e-9 ? (mpos.x - origin.x) / vx : 1;
    let sy = Math.abs(vy) > 1e-9 ? (mpos.y - origin.y) / vy : 1;
    /* Like scaleFromCorner(), crossing the opposite edge collapses to one
       pixel rather than silently flipping the selection. */
    sx = Math.max(1 / Math.max(1, b.x1 - b.x0), sx);
    sy = Math.max(1 / Math.max(1, b.y1 - b.y0), sy);
    if (mod.shift) {
      const k = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
      sx = k; sy = k;
    }
    for (let i = 0; i < d.ids.length; i++) {
      const sl = sliceById(d.ids[i]);
      if (!sl) continue;
      restoreSlice(sl, d.before[i], d.mode);
      applyAffine(sl, AF.about(origin.x, origin.y, AF.scale(sx, sy)), d.mode);
    }
  }

  /* Scale from a corner. Shift constrains the aspect, Alt scales from the
     centre rather than the opposite corner, Shift+Alt does both — "Make sure
     you hold down both Shift and Alt to scale proportionally from the center!"
     [input-maps.htm] */
  function scaleFromCorner(sl, mode, index, dx, dy, mod) {
    const V = mode === 'input' ? verts(sl, 'input') : verts(sl, 'output');
    if (V.length < 4) return;
    const f = rectFrame(V);
    if (!(f.w > 0.001) || !(f.h > 0.001)) return;
    const c = Math.cos(-f.rot), s = Math.sin(-f.rot);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;         /* delta in slice axes */
    const sx = mod.side ? (index === 1 ? 1 : index === 3 ? -1 : 0) : index === 0 || index === 3 ? -1 : 1;
    const sy = mod.side ? (index === 2 ? 1 : index === 0 ? -1 : 0) : index === 0 || index === 1 ? -1 : 1;
    let nw = Math.max(1, f.w + lx * sx * (mod.alt ? 2 : 1));
    let nh = Math.max(1, f.h + ly * sy * (mod.alt ? 2 : 1));
    if (mod.shift) {
      /* "Hold down Shift while scaling slices to constrain aspect ratio"
         [modifiers.htm]. The dominant axis is the one that DEVIATED MOST from
         1, not the largest ratio — when shrinking, both ratios are < 1 and
         Math.max() picked the *smallest* shrink. Same rule the multi-selection
         hull already uses in scaleSelectionFromCorner(). */
      const rw = nw / f.w, rh = nh / f.h;
      const k = Math.abs(rw - 1) >= Math.abs(rh - 1) ? rw : rh;
      nw = f.w * k; nh = f.h * k;
    }
    const next = { cx: f.cx, cy: f.cy, w: nw, h: nh, rot: f.rot };
    if (!mod.alt) {
      /* Keep the opposite corner pinned. The centre travels HALF the size
         change, in the same direction as the corner being dragged: sx/sy
         already carry that corner's sense (-1 on the left/top edges, +1 on the
         right/bottom), so the offset is +sx, not -sx. Negating it moved the
         centre backwards, which grew the Slice correctly but slid it away from
         the cursor — the dragged corner stayed put and the OPPOSITE one moved.
         Measured: dragging BR by +100,+50 view px at 41% gave the right
         W/H (1736.1 x 866.5) with X/Y off by exactly -2x the intended shift. */
      const ox = sx * (nw - f.w) / 2, oy = sy * (nh - f.h) / 2;
      const cc = Math.cos(f.rot), ss = Math.sin(f.rot);
      next.cx = f.cx + ox * cc - oy * ss;
      next.cy = f.cy + ox * ss + oy * cc;
    }
    const nv = frameToVerts(next);
    if (mode === 'input') { for (let i = 0; i < 4; i++) { V[i].x = nv[i].x; V[i].y = nv[i].y; } return; }
    /* on the output stage the whole warped slice scales with the rect */
    const m = AF.mul(AF.move(next.cx, next.cy),
      AF.mul(AF.rot(next.rot), AF.mul(AF.scale(nw / f.w, nh / f.h),
        AF.mul(AF.rot(-f.rot), AF.move(-f.cx, -f.cy)))));
    applyAffine(sl, m, 'output');
  }
  function movePoint(sl, mode, index, mpos, mod) {
    const r = mode === 'input' ? sl.inputRect : sl.outputRect;
    if (!r || index < 0 || index >= r.vertices.length) return;
    let q = P(mpos.x, mpos.y);
    if (ST.flags.snap && !mod.ctrl && ST.flags.ledGrid) q = P(Math.round(q.x / 8) * 8, Math.round(q.y / 8) * 8);
    r.vertices[index].x = q.x;
    r.vertices[index].y = q.y;
    sl._h = null;
  }

  /* per-drag restore points, so a drag is always computed from the state the
     drag started in rather than accumulating rounding every frame */
  function snapSlice(sl, mode) {
    if (!sl) return null;
    const cp = a => (a || []).map(p => P(p.x, p.y));
    return {
      input: cp(verts(sl, 'input')),
      output: cp(verts(sl, 'output')),
      net: netOf(sl) ? cp(netOf(sl).vertices) : [],
      homo: homoOf(sl) ? { src: cp(homoOf(sl).src), dst: cp(homoOf(sl).dst) } : null
    };
  }
  function restoreSlice(sl, snap) {
    if (!sl || !snap) return;
    const put = (dst, src) => { if (!dst) return; for (let i = 0; i < dst.length && i < src.length; i++) { dst[i].x = src[i].x; dst[i].y = src[i].y; } };
    put(verts(sl, 'input'), snap.input);
    put(verts(sl, 'output'), snap.output);
    if (netOf(sl)) put(netOf(sl).vertices, snap.net);
    if (homoOf(sl) && snap.homo) { put(homoOf(sl).src, snap.homo.src); put(homoOf(sl).dst, snap.homo.dst); }
    sl._h = null;
  }

  /* =======================================================================
     selection
     ======================================================================= */
  function select(ids, mode, preserveCycle) {
    const arr = [];
    (Array.isArray(ids) ? ids : [ids]).forEach(id => { const s = String(id); if (s && arr.indexOf(s) < 0 && sliceById(s)) arr.push(s); });
    if (!preserveCycle) ST.pickCycle = null;
    ST.sel = arr;
    if (ST.point && arr.indexOf(String(ST.point.sliceId)) < 0) ST.point = null;
    if (arr.length) {
      const sc = screenOfSlice(arr[0]);
      /* Tree, stage and public API selection must agree on the owning Screen.
         Previously selectSlice() on an Output-stage Slice from another Screen
         left the old Screen visible and the new selection in the inspector. */
      if (sc) ST.screenId = sc.uniqueId;
    }
    refreshTree(); refreshSide();
    emit('select', { slices: ST.sel.slice(), screenId: ST.screenId });
  }
  function toggleSel(id) {
    const s = String(id), i = ST.sel.indexOf(s);
    if (i >= 0) ST.sel.splice(i, 1); else ST.sel.push(s);
    ST.pickCycle = null;
    if (ST.point && ST.sel.indexOf(String(ST.point.sliceId)) < 0) ST.point = null;
    const sc = sliceById(s) && screenOfSlice(s);
    if (sc) ST.screenId = sc.uniqueId;
    refreshTree(); refreshSide();
    emit('select', { slices: ST.sel.slice(), screenId: ST.screenId });
  }

  /* =======================================================================
     slice actions — the contextual menu, verbatim from Arena's own strings
     ======================================================================= */
  function duplicateSlice(sl) {
    if (!sl) return null;
    const sc = screenOfSlice(sl.uniqueId);
    if (!sc || typeof sc.addSlice !== 'function') return null;
    const cloneData = value => {
      if (value == null) return value;
      if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch (e) { /* plain-data fallback below */ }
      }
      return JSON.parse(JSON.stringify(value));
    };
    const copy = sc.addSlice(sl.type, {
      inputRect: { orientation: sl.inputRect ? sl.inputRect.orientation : '0', vertices: verts(sl, 'input').map(p => ({ x: p.x, y: p.y })) },
      outputRect: { orientation: sl.outputRect ? sl.outputRect.orientation : '0', vertices: verts(sl, 'output').map(p => ({ x: p.x, y: p.y })) },
      name: sliceName(sl) + ' copy'
    });
    if (copy) {
      /* addSlice() supplies defaults; duplication must replace those defaults
         with the source's real Arena parameter blocks. Otherwise a duplicated
         LED 16 becomes the 1-pixel RGB fallback and occupies channels 1-3. */
      copy.params = cloneData(sl.params) || {};
      copy.fixture = cloneData(sl.fixture);
      copy.extra = cloneData(sl.extra) || [];
      copy.softEdgeGroup = !!sl.softEdgeGroup;
      copy.softEdgeGroupAttrs = cloneData(sl.softEdgeGroupAttrs);
      copy.softEdgeGroupNodes = cloneData(sl.softEdgeGroupNodes);
      copy.flipX = !!sl.flipX;
      copy.flipY = !!sl.flipY;
      copy.name = sliceName(sl) + ' copy';
    }
    if (copy && sl.warper) {
      copy.warper = {
        bezier: netOf(sl) ? { controlWidth: netOf(sl).controlWidth, controlHeight: netOf(sl).controlHeight, vertices: netOf(sl).vertices.map(p => ({ x: p.x, y: p.y })) } : null,
        homography: homoOf(sl) ? { src: homoOf(sl).src.map(p => ({ x: p.x, y: p.y })), dst: homoOf(sl).dst.map(p => ({ x: p.x, y: p.y })) } : null
      };
      copy._h = null;
    }
    if (copy) {
      copy.softEdgeEnable = sl.softEdgeEnable;
      copy.softEdge = Object.assign({}, sl.softEdge);
      const r = routeOf(sl.uniqueId);
      ST.routes.set(String(copy.uniqueId), Object.assign({}, r));
    }
    return copy;
  }
  /* The four ordering commands. They are NOT part of the per-slice loop below:
     applying a one-step move slice by slice collapses a multi-selection onto
     itself (two adjacent selected rows swap with each other and the group
     scrambles). One call, whole selection, relative order preserved. */
  const STACK_ACTS = {
    'Bring Forward': sc => stack.move(sc, ST.sel, ORDER.forwardDelta),
    'Send Backwards': sc => stack.move(sc, ST.sel, ORDER.backwardDelta),
    'Bring to Front': sc => stack.toEnd(sc, ST.sel, 'front'),
    'Send to Back': sc => stack.toEnd(sc, ST.sel, 'back')
  };
  function stackAction(act) {
    const list = selected();
    if (!list.length) return hint('Select a slice first', true);
    /* a selection can span screens; each screen's stack is its own list */
    const byScreen = new Map();
    for (const sl of list) {
      const sc = screenOfSlice(sl.uniqueId);
      if (sc && !byScreen.has(sc)) byScreen.set(sc, true);
    }
    push(act);
    let moved = false;
    byScreen.forEach((_, sc) => { if (STACK_ACTS[act](sc)) moved = true; });
    refresh();
    hint(moved ? act : act + ': already at the ' + (/Forward|Front/.test(act) ? ORDER.bottomLabel : ORDER.topLabel));
  }
  function sliceAction(act) {
    if (STACK_ACTS[act]) return stackAction(act);
    const list = selected();
    if (!list.length) return hint('Select a slice first', true);
    const mode = ST.stage;
    const box = mode === 'input' ? compSize() : devSize(curScreen());
    push(act);
    for (const sl of list) {
      const V = mode === 'input' ? verts(sl, 'input') : verts(sl, 'output');
      const f = rectFrame(V);
      const put = fr => {
        const nv = frameToVerts(fr);
        if (mode === 'input') { for (let i = 0; i < 4 && i < V.length; i++) { V[i].x = nv[i].x; V[i].y = nv[i].y; } }
        else {
          const m = AF.mul(AF.move(fr.cx, fr.cy), AF.mul(AF.rot(fr.rot),
            AF.mul(AF.scale(fr.w / (f.w || 1), fr.h / (f.h || 1)), AF.mul(AF.rot(-f.rot), AF.move(-f.cx, -f.cy)))));
          applyAffine(sl, m, 'output');
        }
      };
      switch (act) {
        case 'Center X': put({ cx: box.width / 2, cy: f.cy, w: f.w, h: f.h, rot: f.rot }); break;
        case 'Center Y': put({ cx: f.cx, cy: box.height / 2, w: f.w, h: f.h, rot: f.rot }); break;
        case 'Mirror X': applyAffine(sl, AF.about(f.cx, f.cy, AF.scale(-1, 1)), mode); break;
        case 'Mirror Y': applyAffine(sl, AF.about(f.cx, f.cy, AF.scale(1, -1)), mode); break;
        case 'Left Half': put({ cx: box.width / 4, cy: box.height / 2, w: box.width / 2, h: box.height, rot: 0 }); break;
        case 'Right Half': put({ cx: box.width * 3 / 4, cy: box.height / 2, w: box.width / 2, h: box.height, rot: 0 }); break;
        case 'Top Half': put({ cx: box.width / 2, cy: box.height / 4, w: box.width, h: box.height / 2, rot: 0 }); break;
        case 'Bottom Half': put({ cx: box.width / 2, cy: box.height * 3 / 4, w: box.width, h: box.height / 2, rot: 0 }); break;
        case 'Whole Area': put({ cx: box.width / 2, cy: box.height / 2, w: box.width, h: box.height, rot: 0 }); break;
        case 'Make Triangle': makeShape(sl, mode, 3); break;
        case 'Make Circle': makeShape(sl, mode, 32); break;
        case 'Match Output Shape': matchShape(sl, 'output->input'); break;
        case 'Match Input Shape': matchShape(sl, 'input->output'); break;
        case 'Swap Input Output Shape': swapShapes(sl); break;
        case 'Duplicate': { const c = duplicateSlice(sl); if (c) ST.sel = [String(c.uniqueId)]; break; }
        case 'Remove Slice': removeSlice(sl); break;
        default: break;
      }
      sl._h = null;
    }
    refresh();
    hint(act);
  }
  /* Make Triangle / Make Circle rewrite the contour. NOTE: toDecoded() caps a
     rect at four vertices, so a circle survives XML (serialize keeps them all)
     but not a decoded-JSON round trip — undo here goes through the XML path. */
  function makeShape(sl, mode, n) {
    const r = mode === 'input' ? sl.inputRect : sl.outputRect;
    if (!r) return;
    const f = rectFrame(r.vertices);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      out.push(P(f.cx + Math.cos(a) * f.w / 2, f.cy + Math.sin(a) * f.h / 2));
    }
    r.vertices = out;
  }
  /* "MATCH OUTPUT SHAPE, which snaps the slice's input rect to the shape it has
     on the Output Transformation stage" [modifiers.htm] */
  function matchShape(sl, dir) {
    const i = sl.inputRect, o = sl.outputRect;
    if (!i || !o) return;
    if (dir === 'output->input') {
      const b = bounds(outline(sl, 'output', 8));
      const comp = compSize(), dev = devSize(screenOfSlice(sl.uniqueId));
      const sx = comp.width / (dev.width || 1), sy = comp.height / (dev.height || 1);
      i.vertices = [P(b.x0 * sx, b.y0 * sy), P(b.x1 * sx, b.y0 * sy), P(b.x1 * sx, b.y1 * sy), P(b.x0 * sx, b.y1 * sy)];
    } else {
      const b = bounds(verts(sl, 'input'));
      const comp = compSize(), dev = devSize(screenOfSlice(sl.uniqueId));
      const sx = (dev.width || 1) / comp.width, sy = (dev.height || 1) / comp.height;
      o.vertices = [P(b.x0 * sx, b.y0 * sy), P(b.x1 * sx, b.y0 * sy), P(b.x1 * sx, b.y1 * sy), P(b.x0 * sx, b.y1 * sy)];
      if (typeof sl.resetWarp === 'function') sl.resetWarp();
    }
    sl._h = null;
  }
  /* The third of Arena's shape commands. The two rects do not live in the same
     space — the input is composition pixels, the output is the screen's device
     raster — so this is not an exchange of vertex lists. Each side is carried
     across the same proportional mapping the two Match commands use, which is
     what makes the result mean "put the selection where the output was, and the
     output where the selection was" rather than "multiply everything by the
     aspect difference". Both bounds are read BEFORE either is written, or the
     second read would see the first write. */
  function swapShapes(sl) {
    const i = sl.inputRect, o = sl.outputRect;
    if (!i || !o) return;
    const comp = compSize(), dev = devSize(screenOfSlice(sl.uniqueId));
    const bi = bounds(verts(sl, 'input'));
    const bo = bounds(outline(sl, 'output', 8));
    const toComp = [comp.width / (dev.width || 1), comp.height / (dev.height || 1)];
    const toDev  = [(dev.width || 1) / comp.width, (dev.height || 1) / comp.height];
    i.vertices = [P(bo.x0 * toComp[0], bo.y0 * toComp[1]), P(bo.x1 * toComp[0], bo.y0 * toComp[1]),
                  P(bo.x1 * toComp[0], bo.y1 * toComp[1]), P(bo.x0 * toComp[0], bo.y1 * toComp[1])];
    o.vertices = [P(bi.x0 * toDev[0], bi.y0 * toDev[1]), P(bi.x1 * toDev[0], bi.y0 * toDev[1]),
                  P(bi.x1 * toDev[0], bi.y1 * toDev[1]), P(bi.x0 * toDev[0], bi.y1 * toDev[1])];
    if (typeof sl.resetWarp === 'function') sl.resetWarp();
    sl._h = null;
  }
  function removeSlice(sl) {
    const sc = screenOfSlice(sl.uniqueId);
    if (!sc) return;
    /* "a screen should always contain at least one slice, so Resolume will stop
       you when you try to drag the last slice to another screen" — the same
       rule is what makes deleting the last one refuse. */
    if (sc.layers.length <= 1) { hint('A screen must keep at least one slice', true); return; }
    sc.removeSlice(sl.uniqueId);
    ST.sel = ST.sel.filter(id => id !== String(sl.uniqueId));
  }

  /* =======================================================================
     keyboard. Every modifier the manual and shortcuts.htm list, plus T, which
     appears only in Arena's shipped contextual help.
     ======================================================================= */
  function onKeyDown(e) {
    if (ST.destroyed) return;
    if (e.key === 'Escape' && (ST.drag || ST.lasso)) { e.preventDefault(); e.stopPropagation(); cancelGesture(); return; }
    if (ST.drag) return; /* Do not mix history, deletion, zoom or nudges into a pointer transaction. */
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      /* Space on a focused control activates that control; only the stage-level
         key is the documented pan modifier. */
      if (/BUTTON|A/.test(tag)) return;
      e.preventDefault(); ST.space = true; return;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); setFlag('testCard', !ST.flags.testCard); return; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setFlag('outputOff', true); return; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); snapshotPng(); return; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); hint('This window is SHOWAVE Map'); return; }
    if (ctrl && e.shiftKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      hint('Full-screen output to display ' + e.key + ' cannot be taken from a browser tab', true);
      return;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key === '=' || ctrl && e.key === '+') { e.preventDefault(); zoomBy(ST.stage, 1.2); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); zoomBy(ST.stage, 1 / 1.2); return; }
    if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      /* "When first using Alt-Drag to make a transformed copy, Ctrl-D will then
         duplicate and repeat the transformation." */
      const list = selected();
      if (!list.length) return;
      push('duplicate');
      const copies = list.map(duplicateSlice).filter(Boolean);
      if (ST.lastDup) for (const c of copies) applyAffine(c, AF.move(ST.lastDup.dx, ST.lastDup.dy), ST.stage);
      ST.sel = copies.map(c => String(c.uniqueId));
      refresh();
      hint(ST.lastDup ? 'Duplicate + repeat transform' : 'Duplicate');
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const list = selected();
      if (!list.length) return;
      push('delete');
      list.forEach(removeSlice);
      refresh();
      return;
    }
    if (e.key.toLowerCase() === 't' && !ctrl) {
      if (!E.tTr.disabled && !E.tPt.disabled) setMode(ST.mode === 'transform' ? 'points' : 'transform');
      return;
    }
    if (e.key.toLowerCase() === 'f' && !ctrl) { fitAll(); return; }
    if (/^Arrow/.test(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;                 /* 1px, or 10px with Shift */
      if (ST.stage === 'output' && isDmxScreen(curScreen())) {
        const sl = primary();
        if (!sl || !isDmx(sl)) return;
        const direction = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1
          : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
        if (!direction) return;
        if (!ST.nudgeActive) { push('nudge fixture channel'); ST.nudgeActive = true; }
        setStartChannel(sl, dmxStart(sl) + direction * step, curScreen());
        syncSide();
        return;
      }
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const list = selected();
      if (!list.length) return;
      if (!ST.nudgeActive) { push('nudge'); ST.nudgeActive = true; }
      for (const sl of list) applyAffine(sl, AF.move(dx, dy), ST.stage);
      syncSide();
      return;
    }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') ST.space = false;
    if (/^Arrow/.test(e.key)) ST.nudgeActive = false;
  }

  /* Ctrl+Shift+P — "saves a .PNG of the output" [shortcuts.htm]. In a browser
     the Recordings folder is the download folder; the user's own keypress is
     what starts it. */
  function snapshotPng() {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Saving a snapshot'); }
      catch (error) { return hint(error.message, true); }
    }
    const sc = curScreen();
    const rec = sc ? frames.get(String(sc.uniqueId)) : null;
    if (!rec || !rec.canvas.width) return hint('Nothing to snapshot', true);
    try {
      const a = doc.createElement('a');
      a.download = (sc.name || 'screen').replace(/\s+/g, '_') + '_' + Date.now() + '.png';
      a.href = rec.canvas.toDataURL('image/png');
      a.click();
      hint('Snapshot saved');
    } catch (err) { hint('Snapshot failed: ' + (err && err.message), true); }
  }

  /* =======================================================================
     menus
     ======================================================================= */
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(items, x, y) {
    closeMenu();
    const m = mk('div', 'ao-menu', doc.body);
    for (const it of items) {
      if (it.sep) { mk('div', 'ao-msep', m); continue; }
      if (it.group) { mk('div', 'ao-mgroup', m, esc(it.group)); continue; }
      /* it.clone marks a command Arena does not have. The badge is deliberate:
         a title tooltip is invisible until hovered, and the whole point is that
         the user can see at a glance which items are ours. */
      const e = mk('div', 'ao-mitem' + (it.clone ? ' oo-mext' : ''), m,
        '<span class="ao-mchk">' + (it.on ? '✓' : '') + '</span>' + esc(it.label) +
        (it.clone ? '<span class="oo-mexttag">clone ext</span>' : ''));
      if (it.title) e.title = it.title;
      e.addEventListener('click', () => { closeMenu(); if (it.fn) it.fn(); });
    }
    m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
    m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
    menuEl = m;
  }
  /* Arena's own two, verbatim from the binary: "Bring Forward" (singular) and
     "Send Backwards" (plural). Both are ONE STEP — modifiers.htm: "Bring
     Forwards/Backwards moves the slice up or down in the slice stack. This is
     essentially the same as dragging the slice around in the slice list on the
     left side." The two after them do not exist in Arena and say so. */
  /* "forward" always means towards the FRONT of the stack; that word is fixed.
     ORDER only decides which way that is in the LIST, so only the row direction
     and the end labels come from it — otherwise flipping ORDER would produce
     "Bring Forward — towards the back", which is nonsense. */
  const ORDER_ENDS = ' Top of the list is the ' + ORDER.topLabel + ', bottom is the ' + ORDER.bottomLabel + '.';
  const STACK_MENU = [
    { label: 'Bring Forward', title: 'Towards the front of the stack: one row ' + (ORDER.forwardDelta > 0 ? 'down' : 'up') + ' the slice list.' + ORDER_ENDS },
    { label: 'Send Backwards', title: 'Towards the back of the stack: one row ' + (ORDER.backwardDelta > 0 ? 'down' : 'up') + ' the slice list.' + ORDER_ENDS },
    { label: 'Bring to Front', clone: 1, title: 'CLONE EXTENSION. Arena has no to-front command; it has only the single-step pair above, plus dragging in the list.' },
    { label: 'Send to Back', clone: 1, title: 'CLONE EXTENSION. Arena has no to-back command; it has only the single-step pair above, plus dragging in the list.' }
  ];
  const stackItems = () => STACK_MENU.map(it => ({ label: it.label, title: it.title, clone: it.clone, fn: () => sliceAction(it.label) }));

  function onContext(p, ptv) {
    if (p.key === 'output' && isDmxScreen(curScreen())) {
      const hit = dmxHitAt(p, ptv);
      if (!hit) return;
      if (ST.sel.indexOf(String(hit.sliceId)) < 0) select([hit.sliceId], p.key);
      const r = p.cv.getBoundingClientRect();
      openMenu([
        { label: 'Duplicate', fn: () => sliceAction('Duplicate') },
        { sep: 1 },
        { label: 'Remove Fixture', fn: () => sliceAction('Remove Slice') }
      ], r.left + ptv.x, r.top + ptv.y);
      return;
    }
    const v = ST.view[p.key];
    const hit = v ? pickAny(ptv, p.key, v) : null;
    if (hit && ST.sel.indexOf(String(hit.sliceId)) < 0) select([hit.sliceId], p.key);
    const r = p.cv.getBoundingClientRect();
    const acts = ['Center X', 'Center Y', 'Mirror X', 'Mirror Y', null, 'Left Half', 'Right Half', 'Top Half', 'Bottom Half',
      'Whole Area', null, 'Make Triangle', 'Make Circle', null, '@stack', null,
      /* Arena groups all three shape commands together (arena-data.js:217);
         only the two Match ones were offered here. Swap is the one you reach
         for when the input and output rects were built the wrong way round. */
      'Duplicate', p.key === 'input' ? 'Match Output Shape' : 'Match Input Shape',
      'Swap Input Output Shape', null, 'Remove Slice'];
    const items = [];
    acts.forEach(a => {
      if (!a) return items.push({ sep: 1 });
      if (a === '@stack') return items.push(...stackItems());
      items.push({ label: a, fn: () => sliceAction(a) });
    });
    openMenu(items, r.left + ptv.x, r.top + ptv.y);
  }
  const onDocDown = e => {
    if (menuEl && !(e.target && e.target.closest && e.target.closest('.ao-menu'))) closeMenu();
  };
  doc.addEventListener('mousedown', onDocDown);

  /* =======================================================================
     the screen tree
     ======================================================================= */
  /* drag-to-reorder state. Kept in closure rather than in dataTransfer because
     dragover may not read dataTransfer data, and the drop marker has to follow
     the pointer while it moves. */
  let dragIds = null, dragScreen = null;
  const dropAfter = (el, e) => {
    const r = el.getBoundingClientRect();
    return (e.clientY - r.top) > r.height / 2;
  };
  function clearDropMarks() {
    if (!E.treelist) return;
    E.treelist.querySelectorAll('.oo-dropabove,.oo-dropbelow,.oo-dragging')
      .forEach(n => n.classList.remove('oo-dropabove', 'oo-dropbelow', 'oo-dragging'));
  }
  function refreshTree() {
    const list = E.treelist;
    list.innerHTML = '';
    for (const sc of screens()) {
      const id = String(sc.uniqueId);
      const dmxScreen = isDmxScreen(sc);
      const row = mk('div', 'ao-screenrow' + (sc === curScreen() ? ' on' : '') + (screenOn(sc) ? '' : ' off'), list);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', sc === curScreen() && ST.sel.length === 0 ? 'true' : 'false');
      row.tabIndex = sc === curScreen() && ST.sel.length === 0 ? 0 : -1;
      row.dataset.screenId = id;
      /* enableButton / foldButton are tree-row controls in Arena, not inspector
         rows — and both are Screen PARAMS, so both survive a save now. */
      const tog = mk('span', 'ao-eye', row, screenOn(sc) ? '◉' : '○');
      tog.title = dmxScreen ? 'Turn off the fixtures in this Lumiverse in one fell swoop'
        : 'Enable or disable all the slices and masks in this screen in one fell swoop';
      tog.setAttribute('role', 'button');
      tog.tabIndex = 0;
      tog.setAttribute('aria-label', (screenOn(sc) ? 'Disable ' : 'Enable ') + String(sc.name || 'Screen'));
      tog.setAttribute('aria-pressed', screenOn(sc) ? 'true' : 'false');
      const toggleScreen = e => {
        e.stopPropagation();
        push('enable screen');
        setScreenOn(sc, !screenOn(sc));
        emit('screen', { screenId: String(sc.uniqueId), enabled: screenOn(sc), source: 'tree' });
        refreshTree(); refreshSide();
      };
      tog.addEventListener('click', toggleScreen);
      tog.addEventListener('keydown', e => {
        if(e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); toggleScreen(e);
      });
      const fold = mk('span', 'ao-fold', row, foldedOf(sc) ? '▶' : '▼');
      fold.title = 'Fold up all the slices in this ' + (dmxScreen ? 'Lumiverse' : 'screen') +
        '. This also hides them on the Input Selection tab, so it becomes less cluttered.';
      fold.addEventListener('click', e => { e.stopPropagation(); push('fold screen'); setFolded(sc, !foldedOf(sc)); refreshTree(); });
      const nm = mk('div', 'ao-screennm', row);
      const b = mk('b', '', nm, esc(sc.name || 'Screen'));
      mk('small', '', nm, esc(deviceLabel(sc)));
      b.addEventListener('dblclick', e => {
        e.stopPropagation();
        const v = prompt('Screen name', sc.name || '');
        if (v != null) { push('rename screen'); sc.name = v; refresh(); }
      });
      const x = mk('span', 'ao-x', row, '✕');
      x.title = 'This deletes this screen and everything in it!';
      x.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm('Delete "' + (sc.name || 'screen') + '" and everything in it?')) return;
        push('remove screen'); setup().removeScreen(sc.uniqueId);
        if (ST.screenId === id) ST.screenId = screens().length ? screens()[0].uniqueId : null;
        refresh();
      });
      /* Selecting a screen deselects the slices. The inspector shows one object
         and the tree is what picks it, so leaving a slice selected under a
         screen click left two things claiming to be the selection. */
      const selectScreenRow = restoreFocus => {
        ST.screenId = sc.uniqueId; ST.sel = []; ST.point = null; ST.pickCycle = null;
        refreshTree(); refreshSide();
        emit('select', { slices: [], screenId: ST.screenId });
        if(restoreFocus) queueMicrotask(() => {
          const next = E.treelist.querySelector('[data-screen-id="' + id + '"]');
          if(next) next.focus();
        });
      };
      row.addEventListener('click', () => selectScreenRow(false));
      row.addEventListener('keydown', e => {
        if(e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); selectScreenRow(true);
      });
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        /* "Right click to quickly assign an output" [Arena help, Screen] — and
           for a Lumiverse, "Right click to send it to an Art-Net node directly"
           [English.xml:1097], which is a different list entirely. */
        openMenu(dmxScreen ? artNetMenu(sc) : deviceMenu(sc), e.clientX, e.clientY);
      });
      if (foldedOf(sc)) continue;
      const box = mk('div', 'ao-slices', list);
      /* THE DIRECTION, SPELLED OUT. Order only means anything once two slices
         can overlap, so the caption appears only then — and it says which end
         is which rather than leaving the user to discover it by dragging. */
      if (slicesOf(sc).length > 1) {
        const cap = mk('div', 'oo-stackcap', box,
          '<span>↑ ' + esc(ORDER.topLabel) + ' · drawn first</span><span>↓ ' + esc(ORDER.bottomLabel) + ' · drawn last</span>');
        cap.title = 'Slices are drawn top to bottom and stack with straight alpha, with no blend mode, no per-slice opacity. '
          + 'The bottom row is drawn last and therefore covers the ones above it. Drag a row to reorder.'
          + (ORDER.verified ? '' : ' (Direction inferred from Arena\'s shader and manual, not observed.)');
      }
      slicesOf(sc).forEach((sl, i) => {
        const sid = String(sl.uniqueId);
        const it = mk('div', 'ao-item' + (ST.sel.indexOf(sid) >= 0 ? ' on' : '') + (sliceOn(sl) ? '' : ' off'), box);
        /* "This is essentially the same as dragging the slice around in the
           slice list on the left side" [modifiers.htm] — so the list drag is
           the primary gesture and the menu items are its one-step shortcut. */
        it.draggable = true;
        it.dataset.sliceId = sid;
        it.dataset.sliceIndex = String(i);
        it.addEventListener('dragstart', e => {
          dragIds = ST.sel.indexOf(sid) >= 0 ? ST.sel.slice() : [sid];
          dragScreen = sc;
          it.classList.add('oo-dragging');
          try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', sid); } catch (err) { /* Safari */ }
        });
        it.addEventListener('dragend', () => { dragIds = null; dragScreen = null; clearDropMarks(); refreshTree(); });
        it.addEventListener('dragover', e => {
          if (!dragIds) return;
          e.preventDefault();
          const cross=dragScreen!==sc && setup() && typeof setup().moveSlices==='function'
            ? setup().moveSlices(dragIds,dragScreen&&dragScreen.uniqueId,sc.uniqueId,i,{validateOnly:true}) : null;
          e.dataTransfer.dropEffect = dragScreen === sc || (cross&&cross.ok) ? 'move' : 'none';
          clearDropMarks();
          if (dragScreen !== sc && !(cross&&cross.ok)) return;
          it.classList.add(dropAfter(it, e) ? 'oo-dropbelow' : 'oo-dropabove');
        });
        it.addEventListener('drop', e => {
          if (!dragIds) return;
          e.preventDefault();
          const ids = dragIds, from = dragScreen;
          dragIds = null; dragScreen = null;
          clearDropMarks();
          const at = (i | 0) + (dropAfter(it, e) ? 1 : 0);
          moveSlicesToScreen(ids,sc.uniqueId,at);
        });
        mk('span', 'ao-num', it, String(i + 1));
        const nmEl = mk('span', 'ao-nm', it, esc(sliceName(sl)));
        mk('span', 'ao-kind', it, esc(sl.type === 'Slice' ? '' : sl.type));
        const rt = routeOf(sid);
        mk('span', 'ao-route' + (rt.kind === 'composition' ? '' : ' live'), it, '<i></i>' + esc(rt.kind === 'composition' ? 'Show' : rt.name));
        const eye = mk('span', 'ao-eye', it, sliceOn(sl) ? '◉' : '○');
        eye.addEventListener('click', e => { e.stopPropagation(); setSliceOn(sl, !sliceOn(sl)); refreshTree(); });
        it.addEventListener('click', e => {
          ST.screenId = sc.uniqueId;
          if (e.shiftKey) { toggleSel(sid); refreshSide(); } else select([sid], ST.stage);
        });
        nmEl.addEventListener('dblclick', e => {
          e.stopPropagation();
          const v = prompt('Slice name', sliceName(sl));
          if (v != null) { push('rename slice'); sl.name = v; refresh(); }
        });
        it.addEventListener('contextmenu', e => {
          e.preventDefault();
          /* right-clicking INSIDE a multi-selection keeps it, so the ordering
             commands can act on the whole group the way the drag does */
          if (ST.sel.indexOf(sid) < 0) select([sid], ST.stage);
          openMenu([{ label: 'Center X', fn: () => sliceAction('Center X') },
                    { label: 'Center Y', fn: () => sliceAction('Center Y') },
                    { sep: 1 },
                    { label: 'Duplicate', fn: () => sliceAction('Duplicate') },
                    ...stackItems(),
                    { sep: 1 },
                    { label: 'Remove Slice', fn: () => sliceAction('Remove Slice') }],
            e.clientX, e.clientY);
        });
      });
      if (!slicesOf(sc).length) mk('div', 'ao-none', box, 'no slices');
    }
    paintFoot();
  }
  /* =======================================================================
     OUTPUT DEVICES

     A Screen holds exactly one <OutputDevice> wrapping exactly one TYPED
     CHILD. It never takes another screen as its device — routing one screen's
     output into another is the SLICE's Input Source dropdown
     [slice-routing.htm, "Routing Screens to Slices"], which sourceList()
     already does. The nine classes below are verbatim binary literals
     (OutputDeviceVirtual … OutputDeviceDmx); their UI labels are literals too.
     openlive-routing.js's outputDevices() cannot be used as the combo's model:
     it concatenates one row per ALREADY-ASSIGNED device named after its screen
     with one template row per kind, which is exactly how screen names ended up
     sitting above device types in the dropdown. Its assignDevice() IS used,
     because that is where the exclusivity demotion lives.
     ======================================================================= */
  const MAC = /Mac|iPhone|iPad/i.test((typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '');
  const DEVICE_TYPES = [
    { kind: 'OutputDeviceVirtual', label: 'Virtual', size: 'edit',
      note: 'An offscreen render target. Screens set to a Virtual Output can be picked as input for slices in other screens. [screens.htm]' },
    { kind: 'OutputDeviceDisplay', label: 'Display', size: 'display', exclusive: true, enumerated: true,
      note: 'A monitor or projector connected to the computer. Resolume does not create outputs; the operating system does. [screens.htm]' },
    { kind: 'OutputDeviceSpout', label: MAC ? 'Syphon' : 'Spout', size: 'edit', senderField: 'Sender Name',
      note: 'Texture sharing between applications on one machine. Resolume uses the SCREEN NAME as the sender name. [screens.htm]' },
    { kind: 'OutputDeviceNDI', label: 'Network NDI Output', size: 'edit', senderField: 'Stream Name',
      note: 'Announced on the network automatically; other NDI applications pick it up. [screens.htm]' },
    { kind: 'OutputDeviceCapture', label: 'Capture Output', size: 'display', exclusive: true, enumerated: true,
      note: 'Blackmagic / Datapath / AJA playback card, Arena only. Shows extra options such as port and video format. [screens.htm]' },
    { kind: 'OutputDeviceSnapshot', label: 'Snapshot Output', size: 'edit', dirField: true, internalOnly: true,
      note: 'Writes PNG frames to a directory.' },
    { kind: 'OutputDeviceApiSnapshot', label: 'API Snapshot Output', size: 'edit', internalOnly: true,
      note: 'The same frame, served over the REST API instead of written to disk.' },
    { kind: 'OutputDeviceComponent', label: 'Component Output', size: 'edit', internalOnly: true,
      note: 'Renders the screen into a UI pane (Arena\'s Screen Monitor / Preview Monitor).' },
    { kind: 'OutputDeviceDmx', label: 'Lumiverse', size: 'none', dmxOnly: true,
      note: 'The Lumiverse device. Art-Net addressing lives on the Lumiverse\'s own params, not here.' },
    /* OpenLive extension. `size:'edit'` because unlike the Lumiverse a Broadcast
       has a real raster — it is the encode resolution. */
    { kind: 'OutputDeviceStream', label: 'Broadcast', size: 'edit', streamOnly: true,
      note: 'SHOWAVE extension: Resolume cannot stream [streaming.htm]. The encode raster. ' +
            'The destination and encoder live on the Broadcast\'s own params, not here.' }
  ];
  const DEVICE_BY_KIND = DEVICE_TYPES.reduce((m, d) => (m[d.kind] = d, m), {});
  const devKind = sc => (sc && sc.outputDevice && sc.outputDevice.kind) || 'OutputDeviceVirtual';
  /* An unknown kind must NOT quietly resolve to the Virtual descriptor: the
     <select> would then read "Virtual" while the model held something else, and
     nothing would match currentDeviceKey — a control stating the wrong thing.
     Return a synthesised descriptor that names the literal instead, the way
     deviceLabel already does for unknown kinds. */
  const devType = sc => DEVICE_BY_KIND[devKind(sc)] || {
    kind: devKind(sc), label: devKind(sc).replace(/^OutputDevice/, ''), size: 'none', unknown: true,
    note: 'This build does not know the output device "' + devKind(sc) + '". It was preserved ' +
          'from the document unchanged, but nothing here can configure it.'
  };

  /* Window Management reports display bounds in CSS pixels. Advanced Output's
     Screen raster is physical pixels, so normalize once at this component
     boundary. The host currently supplies pixelWidth/pixelHeight as well, but
     direct setDisplays(OpenLiveDisplays.list()) callers must be equally safe. */
  function displayPixelSize(d) {
    d = d || {};
    const dpr = Number(d.devicePixelRatio), reportedScale = Number(d.scale);
    const scale = dpr > 0 ? dpr : (reportedScale > 0 ? reportedScale : 1);
    const logicalW = num(d.width, 0), logicalH = num(d.height, 0);
    const width = num(d.pixelWidth, 0) || logicalW * scale;
    const height = num(d.pixelHeight, 0) || logicalH * scale;
    return {
      width: width > 0 ? Math.round(width) : null,
      height: height > 0 ? Math.round(height) : null
    };
  }

  /* Real display enumeration is the Window Management API: async and
     permission-gated, which is not something a paint-driven inspector may do.
     So the host supplies the list (setDisplays) and, absent that, the browser
     admits to exactly one screen — plus any Display already named in the file,
     so loading a two-projector setup does not silently forget one. */
  function displayList() {
    const out = [];
    const add = (id, name, w, h, blocked, reason, permission, unavailable) => {
      if (!id || out.some(d => d.deviceId === id)) return;
      out.push({ deviceId: String(id), name: String(name || id), width: w || null, height: h || null,
                 blocked: !!blocked, reason: reason || '', permission: permission || 'unknown',
                 unavailable: unavailable || '' });
    };
    /* openlive-displays.js distinguishes "there is one display" from "there are
       more and the permission to measure them is denied", and marks the second
       kind blocked with a reason. That distinction has to survive into the
       dropdown: a 0 x 0 display we cannot locate must not be offered as a thing
       to assign a screen to, because the output window would be positioned by
       guesswork. Carried through and disabled instead of dropped, so the
       operator knows the monitor was seen. */
    if (ST.displays) ST.displays.forEach((d, i) => {
      const px = displayPixelSize(d);
      add(d.deviceId || d.id || d.label || ('Display ' + (i + 1)),
        d.label || d.name || ('Display ' + (i + 1)), px.width, px.height,
        d.blocked, d.reason, d.permission);
    });
    else if (typeof window !== 'undefined' && window.screen) {
      const px = displayPixelSize({
        width: window.screen.width,
        height: window.screen.height,
        devicePixelRatio: window.devicePixelRatio || 1
      });
      add('Display 1', 'Display 1', px.width, px.height);
    }
    for (const sc of screens()) {
      const d = sc.outputDevice;
      if (d && d.kind === 'OutputDeviceDisplay') {
        const id = d.deviceId || d.name;
        const missing = !!ST.displays && !ST.displays.some(x =>
          String(x.deviceId || x.id || x.label || '') === String(id));
        add(id, d.name || d.deviceId, num(d.width, null), num(d.height, null), false, '', 'unknown',
          missing ? 'This saved display is not currently reported by the operating system.' : '');
      }
    }
    return out;
  }
  function captureList() {
    const out = ST.captures.map((c, i) => ({
      deviceId: String(c.deviceId || c.id || ('Card ' + (i + 1))),
      name: String(c.label || c.name || ('Playback Card ' + (i + 1))),
      width: num(c.width, null), height: num(c.height, null),
      formats: Array.isArray(c.formats) ? c.formats.slice() : []
    }));
    for (const sc of screens()) {
      const d = sc.outputDevice;
      if (d && d.kind === 'OutputDeviceCapture' && !out.some(o => o.deviceId === String(d.deviceId || d.name)))
        out.push({ deviceId: String(d.deviceId || d.name), name: String(d.name || d.deviceId), width: num(d.width, null), height: num(d.height, null), formats: [] });
    }
    return out;
  }

  /* ONE ROW PER DEVICE INSTANCE. Enumerated kinds contribute one row per real
     piece of hardware; every other kind is a singleton. No screen names. */
  const devKey = (kind, id) => kind + '' + String(id == null ? '' : id);
  function deviceInstances(currentScreen) {
    const rows = [];
    for (const t of DEVICE_TYPES) {
      if (t.dmxOnly) continue;                 /* a Lumiverse is never offered to a Screen */
      /* ...and the encoder raster is never offered to one either. A Broadcast is
         created from the + menu as its own screen kind, exactly as a Lumiverse
         is; letting an ordinary Screen become one would give it a destination
         and an encoder with no panel to configure them. */
      if (t.streamOnly && (!currentScreen || currentScreen.type !== 'StreamScreen')) continue;
      /* These native classes are runtime internals, not entries in Arena's
         documented Screen device picker. Keep an already-loaded value visible
         and inert so imported XML still round-trips; never offer it as a new
         destination. */
      if (t.internalOnly) {
        if (devKind(currentScreen) === t.kind) rows.push({
          kind: t.kind, deviceId: '', type: t, label: t.label,
          unavailable: 'Internal runtime output. It is preserved when loaded, but is not an assignable SHOWAVE Map Screen device.'
        });
        continue;
      }
      if (t.kind === 'OutputDeviceDisplay') {
        const ds = displayList();
        if (!ds.length) rows.push({ kind: t.kind, deviceId: '', label: 'Display: none connected', type: t, unavailable: 'The operating system reports no output. [screens.htm]' });
        /* The host's label may already carry the resolution — openlive-displays.js
           builds "Display 1 — 1920 x 1080" — and appending it again produced
           "Display 1 — 1920 x 1080  1920×1080". Compare on digits alone so the
           two spellings of the separator do not defeat the check. */
        const digits = s => String(s).replace(/[^0-9]/g, '');
        ds.forEach(d => {
          if (d.blocked) return;                 /* diagnostics are not devices */
          const dim = (d.width && d.height) ? Math.round(d.width) + '×' + Math.round(d.height) : '';
          const dup = dim && digits(d.name).includes(digits(dim));
          rows.push({
            kind: t.kind, deviceId: d.deviceId, type: t,
            label: d.name + (dim && !dup ? '  ' + dim : ''),
            width: d.width, height: d.height,
            unavailable: d.unavailable || null
          });
        });
        continue;
      }
      if (t.kind === 'OutputDeviceCapture') {
        const cs = captureList();
        if (!cs.length) rows.push({ kind: t.kind, deviceId: '', label: 'Capture Output: no card detected', type: t, unavailable: 'No playback card is present. Output via playback cards is Arena only. [screens.htm]' });
        cs.forEach(c => rows.push({ kind: t.kind, deviceId: c.deviceId, type: t, label: c.name, width: c.width, height: c.height, formats: c.formats }));
        continue;
      }
      rows.push({ kind: t.kind, deviceId: '', type: t, label: t.label });
    }
    return rows;
  }
  function currentDeviceKey(sc) {
    const d = sc && sc.outputDevice;
    if (!d) return devKey('OutputDeviceVirtual', '');
    const t = DEVICE_BY_KIND[d.kind];
    return devKey(d.kind, (t && t.enumerated) ? (d.deviceId || d.name || '') : '');
  }

  /* screens.htm: "When you select an output already in use by another screen,
     Resolume will set the output of the other screen back to virtual." Arena
     ALLOWS the pick and demotes the other screen — so the row is never greyed,
     and the demotion is reported instead of happening in silence. */
  function applyDevice(sc, rowDef) {
    if (!sc || !rowDef) return;
    const t = rowDef.type;
    const beforeKey = currentDeviceKey(sc);
    const afterKey = devKey(t.kind, rowDef.deviceId);
    const screensApi = SC();
    const canFollow = !!(screensApi && typeof screensApi.outputDeviceCanFollowComposition === 'function' &&
      screensApi.outputDeviceCanFollowComposition(t.kind));
    /* OPENLIVE EXTENSION, not an Arena parameter. A real device switch to a
       configurable destination starts linked to Composition. Re-selecting an
       already-custom destination keeps its saved raster. */
    const follow = canFollow && (beforeKey !== afterKey ||
      !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition()));
    const dev = devSize(sc);
    const attrs = { name: sc.name, deviceId: rowDef.deviceId || t.label };
    if (t.size === 'display') {
      attrs.width = String(Math.round(num(rowDef.width, dev.width)));
      attrs.height = String(Math.round(num(rowDef.height, dev.height)));
    } else if (t.size === 'edit') {
      attrs.width = String(Math.round(dev.width));
      attrs.height = String(Math.round(dev.height));
    }
    const g = routingApi();
    let done = false;
    if (g && typeof g.assignDevice === 'function') {
      try {
        const res = g.assignDevice(sc.uniqueId, Object.assign({ kind: t.kind }, attrs));
        /* openlive-routing.js's own catalog is missing OutputDeviceApiSnapshot,
           so it refuses that kind. That is its bug, not a reason to drop the
           kind here — fall through to the model and say nothing. */
        if (res && res.ok) {
          done = true;
          if (sc.setDeviceFollowComposition) sc.setDeviceFollowComposition(follow);
          /* Taking an exclusive physical output demotes its previous owner to
             Virtual. That is a device switch too, so it gets the same explicit
             OpenLive default instead of inheriting the old display raster. */
          if (res.demoted && res.demoted.length) res.demoted.forEach(d => {
            const other = setup() && setup().screenById && setup().screenById(d.screenId);
            if (other && other.setDeviceFollowComposition) other.setDeviceFollowComposition(true);
          });
          if (res.demoted && res.demoted.length)
            hint(res.demoted.map(d => d.name).join(', ') + ' went back to Virtual. Every output can only have a single screen [screens.htm]', true);
          else if (res.warnings && res.warnings.length) hint(String(res.warnings[0]));
        }
      } catch (e) { /* an optional module that throws is still optional */ }
    }
    if (!done) sc.setOutputDevice(t.kind, attrs, { followComposition: follow });
    refresh();
    /* Device assignment is not only inspector state. screens.htm makes the
       selected device the Screen's output destination, so the host must get a
       synchronous notification while the select/change gesture is still live
       (window.open is popup-blocked if this is deferred). The editor remains
       transport-agnostic: it reports the model change and advanced-output.html
       owns the real display window. */
    emit('device', {
      screenId: String(sc.uniqueId),
      device: Object.assign({}, sc.outputDevice || {}),
      source: 'inspector'
    });
  }
  /* ---- Art-Net target ----------------------------------------------------
     The contract attaches the enum TT_IP | TT_NODE | TT_BROADCAST |
     TT_LOCALHOST | TT_DISABLED to the Lumiverse's TargetIP param, and the
     binary's own failure message reads "Invalid ArtNetTarget IP CONFIG stored,
     defaulting to disabled" — a config, not a bare address. So TargetIP is
     modelled as ONE param whose value is either a TT_ token (the modes that
     need no address) or the literal address / node name. The combo box
     (binary: artnetTargetComboBox) picks the mode; the mode is derived back
     out of the stored value. INFERRED: Arena stores this as one value, but
     nothing states its encoding. */
  const ART_TARGETS = [
    { value: 'TT_NODE', label: 'Art-Net Node', entry: 'Node Name' },
    { value: 'TT_IP', label: 'IP Address', entry: 'IP Address' },
    { value: 'TT_BROADCAST', label: 'Broadcast', entry: null },
    { value: 'TT_LOCALHOST', label: 'Localhost', entry: null },
    { value: 'TT_DISABLED', label: 'No Output', entry: null }
  ];
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  function artTargetOf(sc) {
    const v = String(pget(sc, ['TargetIP'], '') || '');
    if (ART_TARGETS.some(t => t.value === v)) return v;
    if (IPV4.test(v)) return 'TT_IP';
    return v ? 'TT_NODE' : 'TT_DISABLED';
  }
  /* The address survives a trip through Broadcast and back: switching mode only
     rewrites TargetIP when the new mode cannot carry an address. */
  function setArtTarget(sc, mode) {
    const cur = String(pget(sc, ['TargetIP'], '') || '');
    const keep = (mode === 'TT_IP' && IPV4.test(cur)) || (mode === 'TT_NODE' && cur && !ART_TARGETS.some(t => t.value === cur) && !IPV4.test(cur));
    pset(sc, 'Params', 'TargetIP', keep ? cur : mode, 'STRING', 'ParamChoice');
  }
  const artAddressOf = sc => {
    const v = String(pget(sc, ['TargetIP'], '') || '');
    return ART_TARGETS.some(t => t.value === v) ? '' : v;
  };

  function deviceMenu(sc) {
    const cur = currentDeviceKey(sc);
    return [{ group: 'Assign output' }].concat(deviceInstances(sc).map(r => ({
      label: r.label,
      on: devKey(r.kind, r.deviceId) === cur,
      fn: () => {
        if (r.unavailable) return hint(r.unavailable, true);
        push('assign output');
        applyDevice(sc, r);
      }
    })));
  }
  /* A Lumiverse's device is ALWAYS OutputDeviceDmx; right-clicking it picks an
     Art-Net node, which writes the Lumiverse's own TargetIP param. */
  function artNetMenu(sc) {
    const nodes = Array.isArray(ST.artNetNodes) ? ST.artNetNodes : [];
    const items = [{ group: 'Send to Art-Net node' }];
    if (!nodes.length) items.push({ label: 'No nodes detected. A page cannot listen for Art-Net poll replies', fn: () => hint('Art-Net discovery is UDP; a browser has no UDP socket', true) });
    nodes.forEach(n => items.push({
      label: String(n.name || n.ip), on: String(pget(sc, ['TargetIP'], '')) === String(n.ip),
      fn: () => { push('art-net node'); pset(sc, 'Params', 'TargetIP', String(n.ip), 'STRING', 'Param'); refresh(); }
    }));
    items.push({ sep: 1 });
    ART_TARGETS.forEach(t => items.push({
      label: t.label, on: artTargetOf(sc) === t.value,
      fn: () => { push('art-net target'); setArtTarget(sc, t.value); refresh(); }
    }));
    return items;
  }

  /* =======================================================================
     inspector — row builders
     ======================================================================= */
  /* Section titles are Arena's own Params BLOCK names / fold headers, so the
     panel reads the same way the file does: Common, Input, InputMask,
     MaskParams, Soft Edge, Output, Black Level Compensation, Warping, Point,
     Device, Fixture. `ext` marks a section that has no Arena counterpart. */
  /* The bar at the top of the inspector naming the selected object — Arena's
     "Slice 1". Without it the panel gives no clue which thing it is editing. */
  function selHead(name) { mk('div', 'ao-selhead', E.side, esc(name)); }
  function sec(title, ext) {
    const s = mk('div', 'ao-sec', E.side);
    mk('h4', '', s, esc(title) + (ext ? '<span class="oo-ext">SHOWAVE extension</span>' : ''));
    return s;
  }
  function row(parent, label, ext) {
    const r = mk('div', 'ao-row', parent);
    mk('label', '', r, esc(label) + (ext ? '<span class="oo-ext">ext</span>' : ''));
    return r;
  }
  /* An inert control must LOOK inert: the disabled attribute AND the dimmed row,
     so the operator can tell "does nothing here" from "does nothing yet". */
  function inert(el, why) {
    if (!el) return el;
    el.disabled = true;
    if (why) el.title = why;
    const r = el.closest ? el.closest('.ao-row') : null;
    if (r) r.classList.add('oo-off');
    return el;
  }
  const note = (parent, text) => mk('div', 'ao-note', parent, esc(text));
  const warn = (parent, text) => mk('div', 'oo-warn', parent, esc(text));
  function txtRow(parent, label, get, set, ext) {
    const r = row(parent, label, ext);
    const i = mk('input', '', r);
    i.type = 'text';
    i.value = String(get() == null ? '' : get());
    i.addEventListener('change', () => { push(label); set(i.value); refreshSide(); });
    return i;
  }
  /* A multi-line text row. Description is prose that runs to paragraphs on
     YouTube, and a 22px single-line input makes writing one an act of faith. */
  function taRow(parent, label, get, set, ext) {
    const r = row(parent, label, ext);
    r.classList.add('oo-ta-row');
    const t = mk('textarea', 'oo-ta', r);
    t.value = String(get() == null ? '' : get());
    t.rows = 3;
    t.addEventListener('change', () => { push(label); set(t.value); refreshSide(); });
    return t;
  }
  function roRow(parent, label, text, ext) {
    const r = row(parent, label, ext);
    mk('div', 'ao-ro', r, esc(text));
    return r;
  }
  function numRow(parent, label, get, set, step, ext) {
    const r = row(parent, label, ext);
    const inp = mk('input', '', r);
    inp.type = 'text';
    inp.value = fmt(get(), 2);
    inp.dataset.live = '1';
    inp._get = get;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { commit(); inp.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : (step || 1));
        push(label); set(num(get(), 0) + d); inp.value = fmt(get(), 2);
      }
    });
    inp.addEventListener('blur', commit);
    function commit() {
      const v = evalNum(inp.value, get());      /* "type '/3' after the width setting" */
      if (v == null) { inp.value = fmt(get(), 2); return; }
      const before = num(get(), 0);
      if (Math.abs(v - before) <= 1e-9) { inp.value = fmt(before, 2); return; }
      push(label); set(v);
      /* Enter is followed by blur. Canonicalising now means blur observes the
         committed value instead of evaluating an expression such as "/3" a
         second time and adding a second Undo entry. */
      inp.value = fmt(get(), 2);
      refreshSide();
    }
    return inp;
  }
  function togRow(parent, label, get, set, title, ext) {
    const r = row(parent, label, ext);
    const b = mk('button', 'ao-tog' + (get() ? ' on' : ''), r, get() ? 'On' : 'Off');
    if (title) b.title = title;
    b.addEventListener('click', () => { push(label); set(!get()); refreshSide(); });
    return b;
  }
  function selRow(parent, label, list, cur, set, ext) {
    const r = row(parent, label, ext);
    const s = mk('select', '', r);
    list.forEach(o => {
      const e = mk('option', '', s, esc(o.label));
      e.value = o.value;
      if (o.disabled) e.disabled = true;
      if (o.title) e.title = o.title;
      if (String(o.value) === String(cur)) e.selected = true;
    });
    s.addEventListener('change', () => { push(label); set(s.value); refreshSide(); });
    return s;
  }
  function sliderRow(parent, label, get, set, min, max, ext) {
    const r = row(parent, label, ext);
    const s = mk('input', '', r);
    s.type = 'range'; s.min = String(min); s.max = String(max); s.step = '0.001';
    s.value = String(get());
    const val = mk('span', 'ao-val', r, fmt(get(), 2));
    s.addEventListener('input', () => { set(parseFloat(s.value)); val.textContent = fmt(get(), 2); });
    s.addEventListener('change', () => { push(label); });
    return s;
  }
  /* An integer field with a hard clamp — Delay 0..100, Universe 0..15, Start
     Channel 1..512. Arena clamps; so does this. */
  function intRow(parent, label, get, set, lo, hi, ext) {
    return numRow(parent, label, get, v => set(Math.round(clamp(v, lo, hi))), 1, ext);
  }

  /* =======================================================================
     THE INSPECTOR

     Sections are Arena's own Params BLOCK names and fold headers, and the rows
     inside them follow the order Arena's shipped contextual help declares them
     (Arena\docs\help\English.xml). Declaration order is only a PROXY for panel
     order — it is the best evidence there is, and the one place it changes the
     panel is that the guides now sit above Delay, as English.xml has them.

     Two things this used to get wrong, both fixed here:
       · a DmxScreen got the regular Screen panel, Device / Width / Height /
         Delay / guides and all. A Lumiverse has none of those.
       · the Device dropdown mixed SCREEN NAMES in with DEVICE TYPES. A screen
         has one OutputDevice; it never takes another screen as its device.
     ======================================================================= */
  /* The help box at the foot of the left column. Arena fills it with a short
     explanation of whatever is selected, and it changes with the stage. The
     wording here is this project's own — the shape of the region is Arena's,
     the sentences are not lifted from it — and each one says which manual page
     it is drawn from. */
  function refreshHelp() {
    const sc = curScreen();
    const sl = primary();
    const sliceSelected = sl && screenOfSlice(sl.uniqueId) === sc;
    let title, body;
    if (!sc) {
      title = 'Screen Setup';
      body = 'A setup has no screens yet. Add one from the + menu above. Every screen is one output leaving this application. [advanced-output.htm]';
    } else if (!sliceSelected) {
      title = isDmxScreen(sc) ? 'Lumiverse' : 'Screen';
      body = isDmxScreen(sc)
        ? 'A universe of DMX fixtures. Pick a fixture in the list to place it in the Show. Right click the Lumiverse for its output options. [dmx.htm]'
        : 'One output leaving this application. Right click it to choose which device it goes to; double click the name to rename it. The toggle in front turns the whole screen off. [screens.htm]';
    } else if (ST.stage === 'output') {
      if (isDmxScreen(sc)) {
        title = 'DMX Output';
        body = 'Place this fixture in the Lumiverse channel patch. Drag its block to change Start Channel; overlapping channel ranges are marked red. [dmx.htm]';
      } else {
        title = 'Output Transformation';
        body = 'Drag the slice to move; squares and side grips resize. Drag just outside any corner, or the round arrow, to rotate around the centre. Shift: one axis, proportional resize, or 15° rotation. Ctrl: no snapping. Alt: duplicate on move or resize from centre. Escape cancels. Edit Points controls the warp.';
      }
    } else {
      title = isDmx(sl) ? 'Fixture' : 'Slice';
      body = isDmx(sl)
        ? 'Choose which part of the Show feeds this fixture. Arrow keys nudge it a pixel at a time, Shift ten. [dmx.htm]'
        : 'Drag to position; pink guides mark aligned edges and centres. Squares resize; just outside each corner rotates. The round arrow also rotates. Shift: one axis, proportional resize, or 15° rotation. Ctrl: no snapping. Alt: duplicate on move or resize from centre. Arrows: 1 px, Shift: 10 px. Space: pan. Escape: cancel.';
    }
    E.helpTitle.textContent = title;
    E.helpBody.textContent = body;
  }

  /* Deferred while the operator is actually using a control.

     refreshSide() rebuilds the whole inspector with innerHTML = '', so any
     control that is mid-interaction is destroyed under the pointer. With only
     synchronous callers that was invisible: a refresh always followed a
     completed action. It stopped being invisible once the destination picker
     and the relay capability started fetching from the helper — those resolve
     on their own schedule, and an open <select> popup would vanish before the
     operator could pick anything.

     A dropdown that closes itself is worse than a stale one, so the render
     waits for the control to be finished with rather than winning the race. */
  let sideDeferred = false;
  function deferSideRefresh(active) {
    if (sideDeferred) return;
    sideDeferred = true;
    const resume = () => {
      active.removeEventListener('blur', resume);
      active.removeEventListener('change', resume);
      sideDeferred = false;
      refreshSide();
    };
    active.addEventListener('blur', resume);
    active.addEventListener('change', resume);
  }

  function refreshSide() {
    syncStreamInfoFields();
    /* A focused SELECT may have its popup open — the DOM gives no way to ask —
       so treat focus as "in use". INPUT and TEXTAREA carry a caret and a
       partly-typed value that a rebuild would discard. */
    const active = doc.activeElement;
    if (active && E.side.contains(active) &&
        /^(SELECT|INPUT|TEXTAREA)$/.test(active.tagName)) {
      deferSideRefresh(active);
      return;
    }
    streamInfoFields.clear();
    E.side.innerHTML = '';
    syncStageIdentity();
    syncStageTools();
    refreshHelp();
    const sc = curScreen();
    if (!sc) { mk('div', 'ao-none', E.side, 'No screens.'); return; }
    const dmxScreen = isDmxScreen(sc);

    /* Arena's inspector shows ONE object: the thing selected in the tree. It
       used to show the screen's parameters and then the selected slice's
       parameters stacked underneath, which is two objects at once and made the
       panel 1409px tall in a 774px column. Selecting a screen in the tree now
       clears the slice selection, so which object this is is never ambiguous. */
    const sl = primary();
    if (!sl || screenOfSlice(sl.uniqueId) !== sc) {
      const streamScreen = isStreamScreen(sc);
      selHead(sc.name || (dmxScreen ? 'Lumiverse' : streamScreen ? 'Broadcast' : 'Screen'));
      if (dmxScreen) lumiverseSection(sc);
      else if (streamScreen) broadcastSection(sc);
      else screenSection(sc);
      return;
    }

    selHead(sliceName(sl) || 'Slice');
    /* <Params name="Common"> — one row, Name, and Arena shows it as the fold
       header of the selection [English.xml:1175]. It was missing entirely: the
       only way to rename a slice was a double click in the tree. */
    const cm = sec('Common');
    txtRow(cm, 'Name', () => sliceName(sl), v => { sl.name = v; refreshTree(); });

    if (isDmx(sl)) fixtureInspector(sc, sl); else sliceInspector(sc, sl);

    if (ST.sel.length > 1) mk('div', 'ao-primary-note', E.side,
      '<strong>Multi select</strong>' + ST.sel.length + ' slices are selected. The geometry above ' +
      'is the BOUNDING BOX of the selection, and editing it transforms every slice in the box. ' +
      'Colour compensation writes to all of them; Name and the per-slice blocks below apply to ' +
      'the primary.');
  }

  /* ---------------------------------------------------------------------
     Screen
     --------------------------------------------------------------------- */
  function screenSection(sc) {
    const s = sec('Screen');
    txtRow(s, 'Name', () => sc.name || '', v => { sc.name = v; refreshTree(); });

    /* DEVICE. One row per device INSTANCE: one per enumerated display, one per
       detected playback-card port, one per singleton virtual kind. No screen
       names — routing a screen into a slice is the SLICE's Input Source. */
    const rows = deviceInstances(sc);
    const t = devType(sc);
    const dsel = selRow(s, 'Device',
      rows.map(r => ({ label: r.label, value: devKey(r.kind, r.deviceId), disabled: !!r.unavailable, title: r.unavailable || r.type.note })),
      currentDeviceKey(sc),
      v => { const r = rows.find(x => devKey(x.kind, x.deviceId) === v); if (r && !r.unavailable) applyDevice(sc, r); });
    dsel.id = 'ao-device-' + String(sc.uniqueId).replace(/[^A-Za-z0-9_-]/g, '-');
    const dlabel = dsel.closest('.ao-row').querySelector('label');
    if (dlabel) dlabel.htmlFor = dsel.id;
    dsel.title = 'Choose which physical or virtual output this screen should be sent to. ' + t.note;
    /* Window Management permission is a browser concession, not an output
       device. Keep its diagnostic beside the combo instead of inserting a fake
       0x0 Display option into the hardware list. */
    const blocked = displayList().filter(d => d.blocked);
    if (blocked.length) {
      const accessRow = row(s, 'Displays', true);
      const denied = blocked.every(d => d.permission === 'denied' || d.permission === 'unsupported');
      const access = mk('button', 'ao-btn', accessRow, denied ? 'Display access blocked' : 'Allow Displays…');
      access.type = 'button';
      access.title = blocked.map(d => d.reason).filter(Boolean).join(' ');
      if (denied) inert(access, access.title);
      else access.addEventListener('click', () => emit('display-access', {
        screenId: String(sc.uniqueId), source: 'inspector'
      }));
      warn(s, blocked.map(d => d.reason).filter(Boolean).join(' '));
    }
    if ((sc.outputDevice || {}).kind === 'OutputDeviceDisplay') {
      const runtime = ST.outputStates.get(String(sc.uniqueId)) || { state: 'stopped' };
      const value = runtime.state === 'running'
        ? 'Running' + (runtime.label ? ' · ' + runtime.label : '')
        : runtime.state === 'error'
          ? 'Stopped · output window failed'
          : (screenOn(sc) ? 'Stopped · toggle Screen off/on to reopen' : 'Stopped');
      roRow(s, 'Presentation', value, true);
      if (runtime.error) warn(s, runtime.error);
    }

    deviceFields(s, sc, t);

    const screensApi = SC();
    const canFollow = !!(screensApi && typeof screensApi.outputDeviceCanFollowComposition === 'function' &&
      screensApi.outputDeviceCanFollowComposition(devKind(sc)));
    if (canFollow) togRow(s, 'Follow Show',
      () => !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition()),
      v => { if (sc.setDeviceFollowComposition) sc.setDeviceFollowComposition(v); },
      'SHOWAVE extension. When On, this configurable output uses the Show Width and Height. Editing Width or Height turns it Off.', true);

    /* Width / Height. "Set the width and height of your VIRTUAL output"
       [English.xml:1185]. A Display is dictated by the connected output, so the
       two fields read it rather than set it (INFERRED from the binary's
       rj::DisplayOutputDevice::requestSizeChange). */
    const wi = numRow(s, 'Width', () => devSize(sc).width, v => setDev(sc, v, devSize(sc).height), 8);
    const he = numRow(s, 'Height', () => devSize(sc).height, v => setDev(sc, devSize(sc).width, v), 8);
    if (t.size === 'display') {
      const why = 'The connected ' + (t.kind === 'OutputDeviceCapture' ? 'card' : 'display') +
        ' dictates this size. Editable on Virtual, Spout/Syphon and NDI. [INFERRED from English.xml:1185 "your virtual output"]';
      inert(wi, why); inert(he, why);
    }

    /* Bit depth. A Screen param in the contract and a binary literal ("Bit
       depth", "Bit Depth", "Bit Depth:") — but there is NO English.xml entry
       and no mention in screens.htm or 10-bit-color-output.htm, which documents
       only Composition > Settings > Color Depth. The two states are INFERRED. */
    selRow(s, 'Bit depth', [{ label: '8 bit', value: '0' }, { label: '10 bit', value: '1' }],
      String(Math.round(pnum(sc, ['Bit depth', 'bitDepth'], 0))),
      v => pset(sc, 'Params', 'Bit depth', Math.round(num(v, 0)), 'INT', 'ParamChoice')
    ).title = 'INFERRED. "Bit depth" is a Screen param in the contract and a binary literal, but Arena ships no help text and no manual entry for it, so the enum is this clone\'s reading.';

    sliderRow(s, 'Opacity', () => pnum(sc, ['opacity', 'Opacity'], 1), v => pset(sc, 'Params', 'Opacity', v), 0, 1);
    colourRows(s, sc, 'Params');
    guideRows(s, sc);
    /* Arena's param literal is "Delay"; the unit lives in the help text, not in
       the label. 0..100 ms [screens.htm]. */
    intRow(s, 'Delay', () => pnum(sc, ['delay', 'Delay'], 0), v => pset(sc, 'Params', 'Delay', v), 0, 100)
      .title = 'Add a delay in milliseconds to this screen, to compensate for any delay appearing in other outputs. Each screen can have a delay between 0 and 100 ms.';
  }

  /* Brightness / Contrast / Red / Green / Blue — one help entry covers all five
     on both Screen and Lumiverse [English.xml:1191]. Arena displays neutral as
     0; the exact non-zero curve/range is undocumented, so the clone retains its
     existing internal multiplier and exposes the equivalent signed adjustment. */
  /* `targets` is optional and, when given, is a function returning every node
     the write should reach — that is how a five-slice selection gets five
     writes instead of one. The read still comes from `node`, which is the
     primary: a single number cannot report five different values, and showing
     the primary's is the same thing Arena does. */
  /* Storage keeps the renderer's 0..2 multiplier; Arena-facing controls expose
     the equivalent signed adjustment, with identity displayed as 0. */
  function colourRows(parent, node, block, targets) {
    [['Brightness', 'brightness'], ['Contrast', 'contrast'], ['Red', 'red'], ['Green', 'green'], ['Blue', 'blue']]
      .forEach(p => sliderRow(parent, p[0], () => pnum(node, [p[1], p[0]], 1) - 1,
        v => { const list = targets ? targets() : [node]; for (const n of list) pset(n, block, p[0], v + 1); },
        -1, 1));
  }

  /* Only the fields that actually belong to the chosen device class. */
  function deviceFields(parent, sc, t) {
    const d = sc.outputDevice || (sc.outputDevice = { kind: t.kind });
    const dset = (k, v) => { d[k] = String(v); };
    if (t.enumerated) {
      let shown = String(d.deviceId || d.name || 'N/A');
      if (t.kind === 'OutputDeviceDisplay') {
        const found = displayList().find(x => String(x.deviceId) === String(d.deviceId || d.name || ''));
        shown = found ? found.name : 'Unavailable · ' + shown;
      }
      roRow(parent, t.kind === 'OutputDeviceCapture' ? 'Card' : 'Display', shown);
    }
    if (t.senderField) {
      /* "Resolume will use the name you give the screen as the Server Name /
         Sender Name" [screens.htm] — so it is not separately editable. */
      inert(txtRow(parent, t.senderField, () => sc.name || '', () => { }),
        'The ' + t.senderField.toLowerCase() + ' IS the screen name. Rename the screen to rename the stream. [screens.htm]');
    }
    if (t.kind === 'OutputDeviceCapture') {
      /* "Depending on the card, this will display various extra options that
         will let you select things like which port and what video format to
         use" [screens.htm]. The list comes from the card; a page has none. */
      const row0 = (captureList().find(c => c.deviceId === String(d.deviceId)) || {}).formats || [];
      const list = row0.length ? row0.map(f => ({ label: String(f), value: String(f) }))
        : [{ label: 'Unknown: no card driver to ask', value: String(d.videoFormat || '') }];
      const vf = selRow(parent, 'Video Format', list, String(d.videoFormat || (list[0] && list[0].value) || ''), v => dset('videoFormat', v));
      if (!row0.length) inert(vf, 'A browser cannot enumerate a playback card\'s video formats. Supply them with setCaptureDevices().');
    }
    if (t.dirField) txtRow(parent, 'Output Directory', () => String(d.directory || ''), v => dset('directory', v))
      .title = 'Where the PNG frames are written. Arena\'s literal is "Snapshot Output Directory".';
  }

  /* ---------------------------------------------------------------------
     Lumiverse (DmxScreen) — a completely different panel, which is the point.
     No Device (it is always OutputDeviceDmx), no Width/Height (its extent is
     512 channels x N universes, not pixels), no Delay (DMX delay is a shared
     preference), no guides.
     --------------------------------------------------------------------- */
  /* ---- Broadcast egress ---------------------------------------------------
     The transports themselves live in openlive-stream.js on the HOST page; this
     panel runs inside the Advanced Output frame. Same origin, so the host module
     is a direct reference, and openlive-stream.js's own outputApi() walks back
     to this frame to find the screen. When Advanced Output is opened standalone
     there is no host and therefore no transport — that is reported, not faked.

     Sessions are keyed by destination id and held ONLY here, in memory. A key
     is a password and this page has no OS credential store — but the local
     helper does (DPAPI, openlive-endpoints.py), so a pasted RTMP ingest is
     handed there once and the destination keeps only its id (`endpointRef`).
     Nothing secret is ever written to the document, localStorage or the Hub.
     WHIP still asks each session: it is spoken by the tab itself, so there is
     no helper to hold its token for it. */
  const liveDest = new Map();          /* destination id -> an OPEN session, only */
  const ACTIVE_EGRESS_STATES = new Set(['connecting', 'live', 'reconnecting', 'stopping', 'stop-failed']);
  const activeEgressRecord = rec => !!(rec && ACTIVE_EGRESS_STATES.has(String(rec.state || '')));
  const failedEgressRecord = rec => !!(rec &&
    (rec.state === 'failed' || rec.state === 'finish-failed' || rec.state === 'stop-failed'));
  const activeEgressCount = () => [...liveDest.values()].filter(activeEgressRecord).length;
  /* Own the corner surface here: the document footer deliberately removes its
     legacy globals. Depending on __aoNotify silently discarded stream errors.
     Nothing in this bounded, in-memory history is saved to the output setup. */
  let cornerMessages = null;
  function notify(text, kind) {
    if (ST.destroyed || !text) return;
    if (!cornerMessages) cornerMessages = createCornerMessages(host);
    cornerMessages.show(text, kind);
  }
  function createCornerMessages(parent) {
    const box = mk('section', 'oo-messages', parent);
    box.setAttribute('aria-label', 'Output messages');
    const panel = mk('div', 'oo-messages-panel', box);
    const head = mk('div', 'oo-messages-head', panel);
    mk('strong', '', head, 'Messages');
    const close = mk('button', 'ao-btn', head, '×');
    close.type = 'button'; close.setAttribute('aria-label', 'Dismiss output messages');
    const list = mk('div', 'oo-messages-list', panel);
    const toggle = mk('button', 'ao-btn oo-messages-toggle', box);
    toggle.type = 'button'; toggle.setAttribute('aria-label', 'Open output message history');
    const announce = mk('div', 'oo-message-announcer', box);
    announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite');
    announce.setAttribute('aria-atomic', 'true');
    const records = [], timers = new Set();
    let history = false, disposed = false;
    // Never render provider errors as HTML, or retain ingest paths/tokens in a
    // notification. The original diagnostic remains on its owning live record.
    const safeText = value => String(value)
      .replace(/\b(?:rtmps?|srt):\/\/[^\s<>"']+/gi, '[ingest address hidden]')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [hidden]')
      .replace(/(["']?(?:access_token|refresh_token|stream_key|client_secret)["']?\s*[:=]\s*)["']?[^\s,"'&}]+["']?/gi, '$1[hidden]');
    function paint() {
      const visible = history ? records : records.filter(rec => rec.active).slice(0, 3);
      panel.hidden = !visible.length;
      toggle.hidden = !records.length;
      toggle.textContent = 'Messages · ' + records.length;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      list.replaceChildren();
      visible.forEach(rec => {
        const item = mk('article', 'oo-message ' + rec.kind, list);
        const label = mk('strong', 'oo-message-label', item);
        label.textContent = rec.kind === 'error' ? 'Error' : rec.kind === 'warn' ? 'Attention'
          : rec.kind === 'live' ? 'Live' : rec.kind === 'help' ? 'Help' : 'Info';
        const body = mk('div', 'oo-message-text', item);
        body.textContent = rec.text;
      });
    }
    close.addEventListener('click', () => {
      records.forEach(rec => { rec.active = false; }); history = false; paint(); toggle.focus();
    });
    toggle.addEventListener('click', () => {
      if (!panel.hidden) { records.forEach(rec => { rec.active = false; }); history = false; }
      else history = true;
      paint();
    });
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close.click(); }
    });
    paint();
    return {
      show(value, severity) {
        if (disposed) return;
        const text = safeText(value);
        const kind = ['error', 'warn', 'live', 'help'].includes(severity) ? severity : 'info';
        const previous = records[0];
        if (previous && previous.text === text && previous.kind === kind && previous.active) return;
        const rec = { text, kind, active: true };
        records.unshift(rec); records.splice(30);
        history = false;
        announce.textContent = text;
        paint();
        // Errors, warnings and requested help stay until dismissed. Routine
        // progress expires, but remains available through the history button.
        if (kind === 'info' || kind === 'live') {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (disposed || box.matches(':hover') || box.contains(doc.activeElement)) return;
            rec.active = false; paint();
          }, 8000);
          timers.add(timer);
        }
      },
      destroy() { disposed = true; timers.forEach(clearTimeout); timers.clear(); box.remove(); }
    };
  }
  function broadcastHelp(parent, text) {
    // One help control per section; explanations never expand the inspector.
    const heading = parent.querySelector('h4') || parent;
    let help = heading.querySelector('.oo-section-help');
    if (!help) {
      help = mk('button', 'ao-btn oo-section-help', heading, '?');
      help.type = 'button'; help._notes = [];
      help.setAttribute('aria-label', 'About ' + (heading.textContent || 'this setting').replace('?', '').trim());
      help.title = 'Show help in the corner';
      help.addEventListener('click', () => notify(help._notes.join('\n\n'), 'help'));
    }
    help._notes.push(text);
  }
  function broadcastDetail(parent, label, text, kind) {
    const button = mk('button', 'ao-btn oo-broadcast-detail' + (kind ? ' ' + kind : ''), parent);
    button.type = 'button'; button.textContent = label; button.title = label + ': show details in the corner';
    button.addEventListener('click', () => notify(text, kind || 'help'));
    return button;
  }
  const broadcastFolds = new Set();
  function broadcastFold(parent, sc, key, label) {
    const id = String(sc.uniqueId) + ':' + key;
    const details = mk('details', 'oo-broadcast-fold', parent);
    const summary = mk('summary', '', details);
    summary.textContent = label;
    details.open = broadcastFolds.has(id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) broadcastFolds.add(id); else broadcastFolds.delete(id);
    });
    return details;
  }
  function hostStream() {
    try { if (window.OpenLiveStream) return window.OpenLiveStream; } catch (e) {}
    try { if (window.parent && window.parent !== window && window.parent.OpenLiveStream)
            return window.parent.OpenLiveStream; } catch (e) {}
    try { if (window.opener && window.opener.OpenLiveStream) return window.opener.OpenLiveStream; } catch (e) {}
    return null;
  }

  function destinationRecord(destId) {
    const key = String(destId || '');
    for (const sc of screens()) {
      const dest = (sc.destinations || []).find(d => String(d.uniqueId) === key);
      if (dest) return { sc: sc, dest: dest };
    }
    return null;
  }

  /* Stopping a relay closes the media socket; it does not by itself close a
     platform object such as YouTube's liveBroadcast.  Keep this second edge on
     the same attempt record as the platform ids returned by provisioning. */
  function retainFailedProvision(rec, error) {
    const S = hostStream();
    if (!S?.accounts?.retainProvisionCleanup?.(rec, error, rec?.destination?.accountId)) return false;
    const saved = rec.destination;
    if (liveDest.get(String(saved.uniqueId)) !== rec) {
      let id = String(saved.uniqueId) + ':cleanup';
      while (liveDest.has(id)) id += ':';
      rec.destination = Object.assign({}, saved, { uniqueId:id });
      rec.grouped = null; rec.finalizing = false; rec.cancelled = false;
      rec.state = 'finish-failed';
      rec.error = 'The previous YouTube setup still needs cleanup. Use Stop All to retry ending it.';
      liveDest.set(id, rec); notify(rec.error, 'error'); refresh();
    }
    return true;
  }

  function retainAttemptCleanup(rec, state, error) {
    const saved = rec.destination;
    if (!saved) throw new Error('The original output identity is unavailable.');
    const original = String(saved.uniqueId);
    if (liveDest.get(original) !== rec) {
      let id = original + ':cleanup';
      while (liveDest.has(id) && liveDest.get(id) !== rec) id += ':';
      rec.destination = Object.assign({}, saved, { uniqueId:id });
      liveDest.set(id, rec);
    }
    rec.grouped = null; rec.finalizing = false; rec.stopPromise = null;
    rec.cancelled = true; rec.state = state; rec.error = error;
    notify(error + ' Use End All to retry the original output.', 'error'); refresh();
    return String(rec.destination.uniqueId);
  }
  function retainMediaCleanup(rec, session, source) {
    rec.session = session; rec.source = source;
    return retainAttemptCleanup(rec, 'stop-failed',
      'The previous media output has not confirmed End. Its session is still owned.');
  }
  function retainGroupMediaCleanup(groupId, group, attempts, dests) {
    let ownedId = groupId;
    if (screenRelay.get(ownedId) !== group) {
      ownedId += ':cleanup';
      while (screenRelay.has(ownedId) && screenRelay.get(ownedId) !== group) ownedId += ':';
    }
    group.destIds = dests.map(dest => {
      const rec = attempts.get(String(dest.uniqueId));
      const id = retainMediaCleanup(rec, group.session, null); rec.grouped = ownedId; return id;
    });
    group.cancelled = true; group.stopPromise = null; group.armPromise = null;
    screenRelay.set(ownedId, group);
  }

  function finishPlatformDestination(dest, rec, disposition) {
    if (rec && rec.destination) dest = rec.destination;
    if (rec && rec.provisionCleanupPending && (!dest || !dest.accountId || (!rec.broadcastId && !rec.streamId)))
      return Promise.reject(new Error('YouTube setup cleanup is still unconfirmed, but its original object identity is unavailable. Review the setup on YouTube before starting again.'));
    if (!dest || !dest.accountId || !rec || (!rec.broadcastId && !rec.streamId))
      return Promise.resolve({ state: 'media-stopped' });
    const S = hostStream();
    if (!S || !S.accounts || typeof S.accounts.finishBroadcast !== 'function')
      return Promise.reject(new Error('The accounts helper has no platform-finish route.'));
    if (rec.finishPromise) return rec.finishPromise;
    rec.finishPromise = S.accounts.finishBroadcast(dest.accountId, {
      broadcastId: rec.broadcastId || undefined,
      streamId: rec.streamId || undefined,
      disposition: disposition === 'abort' ? 'abort' : 'complete'
    }).then(result => {
      rec.finalized = true;
      rec.provisionCleanupPending = false;
      rec.finishResult = result || null;
      rec.finishError = null;
      return result;
    }).catch(error => {
      rec.finishError = error && error.message || String(error);
      rec.finishPromise = null;
      throw error;
    });
    return rec.finishPromise;
  }

  function finishFailedDestination(dest, rec, disposition) {
    if (!dest || !rec || rec.finalized || rec.finalizing ||
        (!rec.broadcastId && !rec.streamId)) return Promise.resolve();
    rec.finalizing = true;
    return finishPlatformDestination(dest, rec, disposition ||
      (rec.startedAt ? 'complete' : 'abort'))
      .then(() => { rec.finalizing = false; refresh(); })
      .catch(error => {
        rec.finalizing = false;
        rec.state = 'finish-failed';
        rec.error = 'Media stopped, but the platform broadcast could not be ended: ' +
          (error && error.message || error);
        notify(dest.name + ': ' + rec.error, 'error');
        refresh();
      });
  }

  function abortResolvedPlatforms(resolved) {
    return Promise.allSettled((resolved || []).filter(r => r && !r.error).map(r => {
      const attempt = r.rec || liveDest.get(String(r.d.uniqueId)) || {};
      attempt.broadcastId = r.broadcastId || attempt.broadcastId || null;
      attempt.streamId = r.streamId || attempt.streamId || null;
      return finishPlatformDestination(r.d, attempt, 'abort').catch(error => {
        notify(r.d.name + ': cancelled setup could not be removed from the platform: ' +
          (error && error.message || error), 'error');
        throw error;
      });
    }));
  }
  /* THE DESTINATION CATALOGUE — services, not protocols.

     A destination row used to offer a transport: Disabled / WHIP / File / RTMP
     (helper) / SRT (helper) / OBS. That is plumbing, and it is the wrong
     question to put to an operator: nobody thinks "I would like to RTMP", they
     think "I would like to go out on our YouTube". Restream and n8n both put
     the SERVICE first and treat the protocol as an implementation detail, and
     the transport genuinely is one now that the relay carries RTMP.

     Rows come from the helper (/api/accounts/destinations), which merges the
     59-platform catalogue with whatever accounts are actually connected, and
     tags each one:
       channel  a connected account's channel  - ready, no key ever typed
       connect  can be connected in one click  - YouTube, Kick
       key      paste an RTMP URL              - the relay carries it
       whip     the tab speaks this unaided
       blocked  cannot be carried yet, with the reason
     null means "not asked yet", which is a different answer from "empty". */
  /* Ingest URLs typed into a destination row.

     The URL is a TYPING BUFFER only. The moment a valid one is entered it is
     handed to the helper, which stores it encrypted (openlive-endpoints.py)
     and hands back an id; the destination record carries that id as
     `endpointRef` — a field it has had since day one and that nothing resolved
     until now — and the buffer is cleared. So the key is in page JavaScript
     for the length of one 'change' event, not the life of the window, and it
     is still never on the destination record, which is exported and mailed.
     The map only keeps a URL for a row whose save FAILED, and that row says so.
     Keyed by destination uniqueId. */
  const sessionUrl = new Map();

  /* What the helper holds, minus the URLs: id, platform, label, host, times.
     null means "not asked yet", which is a different answer from "empty". */
  let endpointRows = null;
  let endpointsAsked = false;
  function refreshEndpoints(force) {
    const S = hostStream();
    if (!S || !S.endpoints) { endpointRows = []; return; }
    if (endpointsAsked && !force) return;
    endpointsAsked = true;
    S.endpoints.list().then(r => { endpointRows = r.endpoints || []; refresh(); })
      .catch(() => { endpointRows = []; refresh(); });
  }
  const endpointRow = id => (endpointRows || []).find(r => r.id === id) || null;

  /* THE STALL WATCH.

     A destination that closes announces itself: ffmpeg logs the slave failure
     and the session state changes, so an event reaches the row. A destination
     that ACCEPTS the connection and then stops reading announces nothing — it
     blocks ffmpeg's tee, which blocks its stdin, which blocks the helper's
     ingest thread. MEASURED: everything wedges, no event is emitted, and the
     row keeps saying LIVE indefinitely while zero bytes reach any destination,
     including the healthy ones. The only way to see it is to ask, so this is
     the one thing in this panel that polls. It runs solely while a relay
     session is open and stops itself when the last one closes. */
  let stallTimer = null;
  function watchRelayStalls() {
    if (stallTimer) return;
    stallTimer = setInterval(() => {
      const S = hostStream();
      const sessions = new Map();
      liveDest.forEach((rec, id) => {
        if (rec && rec.session && rec.session.kind === 'relay') sessions.set(rec.session, id);
      });
      if (!sessions.size || !S || !S.relay || typeof S.relay.stats !== 'function') {
        clearInterval(stallTimer); stallTimer = null; return;
      }
      sessions.forEach((_id, session) => {
        S.relay.stats(session).then(s => {
          if (!s) return;
          let changed = false;
          liveDest.forEach((rec, id) => {
            if (!rec || rec.session !== session) return;
            const was = rec.stalledSeconds == null ? null : Math.round(rec.stalledSeconds);
            const now = s.stalledSeconds == null ? null : Math.round(s.stalledSeconds);
            if (was !== now) changed = true;
            rec.stalledSeconds = s.stalledSeconds;
            rec.stalledReason = s.stalledReason || '';
            const destStat = (s.destinations || []).find(d => String(d.id) === String(id)) || null;
            rec.destinationState = destStat;
            if (destStat && !rec.finalizing && rec.state !== 'stopping' && rec.state !== 'stop-failed') {
              if (destStat.state === 'failed') {
                const newlyFailed = !failedEgressRecord(rec);
                rec.state = 'failed';
                rec.error = destStat.reason || 'The relay reported that this destination dropped.';
                if (newlyFailed) {
                  const found = destinationRecord(id);
                  if (found) {
                    notify(found.dest.name + ' failed while the other destinations continue: ' +
                      rec.error + ' End the shared output to complete platform cleanup.', 'error');
                  }
                }
                changed = true;
              } else if (destStat.state === 'live' && rec.state !== 'live') {
                rec.state = 'live';
                rec.error = null;
                if (!rec.startedAt) rec.startedAt = Date.now();
                changed = true;
              }
            }
          });
          if (changed) refresh();
        }).catch(() => { /* a status blip must not kill the watch */ });
      });
    }, 2000);
  }
  /* "14:02 today" / "yesterday 09:10" / "3 days ago", from a helper timestamp
     in seconds. A per-show key is only as good as WHEN it was pasted. */
  function agoText(sec) {
    const t = new Date(sec * 1000), now = new Date();
    const hm = t.toTimeString().slice(0, 5);
    if (t.toDateString() === now.toDateString()) return hm + ' today';
    const days = Math.round((now - t) / 86400000);
    return days <= 1 ? 'yesterday ' + hm : days + ' days ago';
  }
  /* The catalogue row a destination points at, outside the renderer: what the
     arm and failure paths need to say something platform-specific. */
  function catalogueRowFor(dest) {
    if (!dest || !destCat || !destCat.destinations) return null;
    return destCat.destinations.find(x => x.serviceKey === dest.serviceKey ||
      (x.kind === 'key' && dest.platformId != null && x.platformId === dest.platformId && !x.accountId)) || null;
  }

  /* ---- STREAM INFO — what the show IS, as opposed to where it goes -------

     The requirement is Restream's shape, not this panel's old one: connect the
     account, fill Title / Description / Category ONCE on the Broadcast, press
     Go, and every destination that can take them gets them. Nothing is pasted.

     These are NOT secrets — a title is written to be read by strangers — so
     unlike an ingest URL they belong in the saved document, and they live in
     the Broadcast's own Params block beside Encoder. That is the mechanism
     every other field in this section already uses (pset/pget -> <Params> ->
     openlive-screens.js), so they serialise, undo and round-trip with no
     change to the persistence layer and none to the Destination record, which
     stays free of anything that is not a reference.

     TITLE AND DESCRIPTION ARE GLOBAL. CATEGORY IS PER DESTINATION.

     That split is Restream's, and the reason is structural rather than
     stylistic. Restream keeps one Title/Description box for the whole setup
     ("Enter your title, description, and thumbnail, and click Update All") but
     Category is not in that dialog at all — it is reached per channel, "click
     Edit next to a channel, select a game or topic under Category"
     (ZERO-PASTE-GOLIVE.md §1, from Restream's own help pages). YouTube video
     category ids, Twitch game ids and Kick category ids are three disjoint
     taxonomies with no shared vocabulary, so ONE global Category cannot be
     correct for two platforms at once: it is a control that cannot do its job,
     which is what a global field here used to be.

     So the per-destination Category lives in the Broadcast's own <Params>
     under a name carrying the destination's uniqueId. That is deliberate: the
     Destination record is serialised by openlive-screens.js, which writes a
     fixed attribute list, and a field added to the record alone would live in
     memory and die on save — the exact half-fix tools/test-destination-
     persistence.js exists to catch. A Param round-trips through the writer and
     the reader that already exist, and through undo, with no change to the
     persistence layer. */
  const INFO_FIELDS = [
    { key: 'title',       param: 'Stream Title',       label: 'Title' },
    { key: 'description', param: 'Stream Description', label: 'Description' }
  ];
  /* Not in INFO_FIELDS: it is not global. `param` is the LEGACY name — the one
     a document written by the previous version carries a single global value
     under — and is used as the prefix for the per-destination ones. */
  const CATEGORY_FIELD = { key: 'category', param: 'Stream Category', label: 'Category' };
  /* Every field name the helper's report can carry, not only the three this
     panel sends. openlive-accounts.py METADATA_FIELDS is the source: a report
     mentioning tags or thumbnail must read as English rather than as a key. */
  const INFO_LABELS = { title: 'Title', description: 'Description', category: 'Category',
                        tags: 'Tags', privacy: 'Privacy', thumbnail: 'Thumbnail',
                        language: 'Language' };
  const infoLabel = key => INFO_LABELS[String(key)] || String(key);
  const infoOf = (sc, f) => {
    const shared = sharedShowInfo();
    return String(shared ? shared[f.key] : pget(sc, [f.param], '') || '').trim();
  };
  /* GLOBAL stream info — what every destination on this Broadcast shares. */
  function streamInfo(sc) {
    const out = {};
    INFO_FIELDS.forEach(f => { const v = infoOf(sc, f); if (v) out[f.key] = v; });
    return out;
  }
  /* One Param per destination. The id is sanitised because it reaches an XML
     attribute name's VALUE (paramToXML writes name="…"), and a document from
     another machine can carry any string in uniqueId. */
  const catParam = dest =>
    CATEGORY_FIELD.param + ' ' + String((dest && dest.uniqueId) || '').replace(/[^\w.:-]/g, '_');
  const categoryOf = (sc, dest) => String(pget(sc, [catParam(dest)], '') || '').trim();
  const setCategory = (sc, dest, v) =>
    pset(sc, 'Params', catParam(dest), String(v == null ? '' : v).trim(), 'STRING', 'Param');
  /* The single global Category a document written before this split carries.
     It is NOT sent anywhere any more — one value cannot be right for two
     taxonomies — so it is surfaced and migrated rather than silently dropped. */
  const legacyCategory = sc => String(pget(sc, [CATEGORY_FIELD.param], '') || '').trim();

  /* What this ONE destination is told: the Broadcast's global text plus its own
     Category. */
  function streamInfoFor(sc, dest) {
    const out = streamInfo(sc);
    const c = categoryOf(sc, dest);
    if (c) out.category = c;
    return out;
  }
  /* The body of the provision request.

     `title` is NOT unconditional, and the reason is a real hazard rather than
     tidiness. A YouTube liveBroadcast is a NEW object per show and cannot be
     inserted without a title, so a fallback there is harmless. Twitch and Kick
     are the opposite: their title is PERSISTENT CHANNEL STATE that survives
     between streams (PERSISTENT-KEY-MODEL.md), so sending a fallback would
     overwrite whatever the operator set on the platform with this Broadcast's
     internal name — renaming a real channel to "Broadcast 1" on every Go Live.
     So the operator's title travels only when they actually typed one, and
     `fallbackTitle` is offered separately for the create-a-new-object case
     alone. Same reasoning as description and category: an empty string is not
     "leave it alone".

     `fallbackTitle` belongs to THIS call and to no other. The edit-time Update
     All below sends streamInfoFor() WITHOUT it, because that write lands on
     permanent Twitch and Kick channel state and there is no new object needing
     a name. */
  function ingestRequest(sc, dest) {
    return Object.assign({ fallbackTitle: (sc && sc.name) || 'SHOWAVE broadcast' },
                         streamInfoFor(sc, dest));
  }

  /* WHAT THE PLATFORM ACTUALLY TOOK — read from the helper, never assumed.

     Only the helper talks to YouTube, Twitch and Kick, so only the helper can
     say whether the category resolved or the description was dropped. Twitch
     has no per-stream description field at all, and its channel PATCH answers
     204 with an empty body even when it silently ignored an unrecognised game
     id — so a panel that reported success because "the call returned" would be
     reporting a fiction. This reads the per-field verdict out of the ingest
     response and renders exactly that, no more. When the response carries
     none, the row says the helper did not report; it never fills the gap in.

     The helper's shape is not frozen yet, so every obvious encoding is
     accepted, and anything else is shown as unrecognised rather than swallowed:
       { title: 'applied', category: { state: 'failed', why: '...' } }
       { title: { status: 'applied' }, description: { status: 'unsupported',
                                                      reason: '...' } }
       { applied: ['title'], unsupported: [{ field: 'description', why: '...' }] }
     and the per-field map may arrive under streamInfo, stream_info, fields,
     results or metadata. Reading all of them is cheaper than a shape argument
     across two tiers, and being liberal here cannot invent a verdict: an
     unreadable answer still yields null, which the row renders as "the helper
     reported nothing" rather than as success. */
  /* The vocabulary is the helper's, not this panel's: openlive-accounts.py
     METADATA_STATES names applied / unconfirmed / deferred / skipped /
     unsupported / not-implemented / blocked / failed, and a state this table
     does not carry renders as 'reported as "x"' rather than being guessed at.
     `unverified` is kept as an alias for `unconfirmed` because the ingest path
     shipped with that spelling and a stored report may still use it.

     DEFERRED is not bad. It is the honest YouTube answer at edit time: there is
     no liveBroadcast object to write to until Go Live creates one, so the value
     is held rather than lost, and saying "failed" would be as wrong as saying
     "applied". */
  const INFO_STATE = {
    applied:          { word: 'applied',            bad: false },
    unconfirmed:      { word: 'sent, unconfirmed',  bad: false },
    unverified:       { word: 'sent, unconfirmed',  bad: false },
    deferred:         { word: 'deferred to Go Live', bad: false },
    skipped:          { word: 'not sent',           bad: false },
    /* NOT a fault. A Twitch channel has nowhere to put a Description — that is
       the platform's shape, not something wrong with this Broadcast, and
       styling it amber made a correct setup nag on every single push forever.
       It is STATED, in the summary and the tooltip, and left neutral. */
    unsupported:      { word: 'not supported here', bad: false },
    'not-implemented': { word: 'not written by SHOWAVE yet', bad: true },
    blocked:          { word: 'blocked: reconnect the channel', bad: true },
    failed:           { word: 'failed',             bad: true }
  };
  const infoWord = st => (INFO_STATE[st] ? INFO_STATE[st].word : 'reported as "' + st + '"');
  const infoBad = st => (INFO_STATE[st] ? INFO_STATE[st].bad : true);
  function readStreamInfoResult(res) {
    const raw = res && (res.streamInfo || res.stream_info || res.fields ||
                        res.results || res.metadata);
    if (!raw || typeof raw !== 'object') return null;
    const out = [];
    const add = (field, state, why) => {
      if (!field) return;
      out.push({ field: String(field), state: String(state || 'unrecognised'),
                 why: why ? String(why) : '' });
    };
    if (Array.isArray(raw)) {
      raw.forEach(x => {
        if (x && typeof x === 'object') add(x.field || x.name, x.state || x.status,
                                            x.why || x.reason);
      });
    } else {
      Object.keys(raw).forEach(k => {
        const v = raw[k];
        if (INFO_STATE[k] && Array.isArray(v)) {
          /* the {applied:[...], unsupported:[...]} encoding */
          v.forEach(x => {
            if (typeof x === 'string') add(x, k, '');
            else if (x && typeof x === 'object') add(x.field, k, x.why || x.reason);
          });
        } else if (typeof v === 'string') add(k, v, '');
        else if (v && typeof v === 'object')
          add(k, v.state || v.status, v.why || v.reason);
      });
    }
    return out.length ? out : null;
  }
  /* One short line for the row; the reasons ride on its tooltip, because the
     row is 216px wide and a truncated reason is worse than a legible summary
     plus a hover. */
  /* The one-line summary carries only the fields something HAPPENED to. A
     YouTube row otherwise read "Tags not sent \u00b7 Privacy not sent \u00b7 Thumbnail
     not sent \u00b7 Language not sent \u00b7 Title deferred to Go Live", burying the one
     verdict that matters behind four no-ops. "skipped" means the operator never
     filled that field in, which is not news \u2014 it stays in the tooltip
     (infoDetail) where the full picture belongs. */
  const infoSummary = list => (list.filter(x => x.state !== 'skipped').length ? list.filter(x => x.state !== 'skipped') : list)
    .map(x => infoLabel(x.field) + ' ' + infoWord(x.state)).join(' \u00b7 ');
  const infoDetail = list => list
    .map(x => infoLabel(x.field) + ': ' + infoWord(x.state) + (x.why ? ': ' + x.why : ''))
    .join('\n');

  /* Put the verdict on the live record and say it once in the corner. Called
     from BOTH arm paths, because a grouped Go Live must report per destination
     exactly as a single-row Go does — one aggregate "applied" across a fan-out
     would be false the moment one platform refused a field. */
  function noteStreamInfo(rec, dest, sc, list) {
    if (!rec) return;
    /* Per destination, not global: this one's Category is its own. */
    const asked = Object.keys(streamInfoFor(sc, dest));
    rec.streamInfoAsked = asked;
    rec.streamInfo = list || null;
    rec.streamInfoUnreported = false;
    if (!asked.length) return;
    /* A destination carrying a pasted key has NO account and therefore no API
       call: the relay pushes a bitstream at an ingest URL and that is all. So
       there was no request to carry a title, and saying SHOWAVE "sent" one
       would be a plain untruth. Say instead where the operator must set it. */
    if (!dest || !dest.accountId) {
      rec.streamInfoUnreported = false;
      rec.streamInfoNoChannel = true;
      notify(dest ? dest.name + ': ' + asked.map(infoLabel).join(', ') + ' cannot be applied from ' +
             'here. This destination is a pasted ingest key, which carries a bitstream and nothing ' +
             'else. Set them on the platform itself, or connect the account so SHOWAVE can.'
             : 'Stream info cannot be applied to a destination with no connected account.', 'warn');
      return;
    }
    if (!list) {
      rec.streamInfoUnreported = true;
      notify(dest.name + ': SHOWAVE sent ' + asked.map(infoLabel).join(', ') + ' with the ingest ' +
             'request and the helper returned no per-field result, so nothing here can say which ' +
             'of them the platform took. Check the channel before relying on it.', 'warn');
      return;
    }
    notify(dest.name + ': stream info: ' + infoSummary(list),
           list.some(x => infoBad(x.state)) ? 'warn' : '');
  }

  /* OPTIONAL catalogue field, guarded for absence in both directions.

     A platform row MAY one day carry streamInfo:{title:true, description:false,
     category:true}, measured by whoever researched that platform's API. Until
     it does this renders NOTHING: an absent field is not "supported" and it is
     not "unsupported" either, and rendering either would be an invention. */
  function infoCapabilityText(cr) {
    const cap = cr && cr.streamInfo;
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) return '';
    const no = INFO_FIELDS.filter(f => cap[f.key] === false).map(f => f.label);
    if (!no.length) return '';
    return (cr.platform || cr.displayName || 'This platform') + ' cannot take ' +
           no.join(' or ') + '. Set ' + (no.length > 1 ? 'those' : 'that') + ' on the platform.';
  }

  /* ---- THE CAPABILITY TABLE, BEFORE THE FACT ----------------------------

     openlive-accounts.py metadata_capability() answers, per provider and per
     FIELD, one of supported / platform-unsupported / not-implemented, with the
     reason, plus `when` — whether that provider's stream info can be written at
     any time or only when Go Live creates the broadcast. That is what lets a
     Description box be greyed for a Twitch destination BEFORE the operator
     types into it, instead of the row apologising afterwards.

     Every path here is guarded for the route being ABSENT, because it is new:
     a 404 is "this helper does not publish the table", which is a third answer
     and renders as neither supported nor unsupported. A field this table cannot
     speak for stays live and ungreyed — refusing to guess in the permissive
     direction, since greying a control that would have worked is as much a lie
     as offering one that cannot. */
  const META_CAP_ROUTE = '/api/accounts/metadata-capability';
  const APPLY_NOW_ROUTE = '/api/accounts/apply-now';
  /* Direct HTTP rather than through OpenLiveStream: these two routes are newer
     than that module's accounts surface. If it grows them, they are preferred —
     that keeps one fetch implementation once it exists. */
  function acctHTTP(route, body) {
    let f = null;
    try { f = (typeof fetch === 'function') ? fetch : null; } catch (e) { f = null; }
    if (!f) return Promise.reject(new Error('this window has no fetch, so the helper cannot be called'));
    const opts = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) };
    return f(route, opts).then(r => r.json().catch(() => ({})).then(data => {
      if (!r.ok) {
        const err = new Error((data && data.error) ||
          ('the helper answered HTTP ' + r.status + ' for ' + route));
        err.status = r.status;
        err.absent = r.status === 404;
        throw err;
      }
      return data;
    }));
  }

  /* null = not asked yet, which is neither yes nor no and must render as
     neither. { absent: true } = the helper has no such route. */
  let metaCap = null, metaCapAsked = false;
  function refreshMetaCapability(force) {
    if (metaCap && !force) return Promise.resolve(metaCap);
    metaCapAsked = true;
    /* Straight to the route rather than through OpenLiveStream: that module has
       no accounts.metadataCapability today, and inventing a call signature for
       one that might arrive would be a guess. The route's contract is read from
       devserver.py — GET, no body, the metadata_capability() document. */
    return acctHTTP(META_CAP_ROUTE).then(doc => {
      metaCap = (doc && typeof doc === 'object') ? doc : { absent: true,
        reason: 'The helper answered ' + META_CAP_ROUTE + ' with something this panel cannot read.' };
      try { refresh(); } catch (e) {}
      return metaCap;
    }).catch(error => {
      metaCap = { absent: true,
        reason: error && error.absent
          ? ('This helper does not publish ' + META_CAP_ROUTE + ', so nothing here knows in ' +
             'advance which fields a platform can take. Each row still reports what the ' +
             'platform actually did, after the write.')
          : ('The stream-info capability table could not be read: ' +
             ((error && error.message) || error)) };
      try { refresh(); } catch (e) {}
      return metaCap;
    });
  }
  /* Which provider a destination belongs to. The catalogue row carries it for a
     connected channel; the account id is the fallback ("youtube:455496a2…"). */
  function destProvider(dest, cr) {
    if (cr && cr.provider) return String(cr.provider);
    const id = String((dest && dest.accountId) || '');
    const i = id.indexOf(':');
    return i > 0 ? id.slice(0, i) : '';
  }
  /* The provider's block of the table, or null when it is unknown, unread or
     unpublished. Null means "say nothing", never "supported". */
  function metaCapFor(dest, cr) {
    if (!metaCapAsked) { metaCapAsked = true; refreshMetaCapability(false); }
    if (!metaCap || metaCap.absent) return null;
    const provider = destProvider(dest, cr);
    if (!provider) return null;
    const providers = metaCap.providers || metaCap;
    const block = providers && providers[provider];
    if (!block || typeof block !== 'object' || block.known === false) return null;
    return block;
  }
  /* One field's entry: { state, supported, reason } or null when unknown. */
  function metaFieldCap(dest, cr, key) {
    const block = metaCapFor(dest, cr);
    const f = block && block.fields && block.fields[key];
    return (f && typeof f === 'object') ? f : null;
  }
  const metaFieldBlocked = f => !!f && f.state !== 'supported';
  /* WHEN this provider's stream info can be written. 'go-live' is YouTube's
     answer and the whole reason Update All reports three outcomes rather than
     one. Both spellings of "any time" are accepted because the value is the
     helper's to choose. */
  function metaWhen(dest, cr) {
    const block = metaCapFor(dest, cr);
    const w = block && block.when ? String(block.when) : '';
    return w === 'go-live' ? 'go-live' : (w === 'any-time' || w === 'anytime') ? 'any-time' : '';
  }

  /* ---- UPDATE ALL — the edit-time push ----------------------------------

     Restream pushes stream info when the operator presses Update All, not when
     they go live, and its 2026-06-23 changelog is explicit that the write
     reaches compatible channels "even if they're currently disabled, so you can
     prepare everything before going live" (ZERO-PASTE-GOLIVE.md §1). So this
     deliberately includes destinations whose On toggle is Off: On governs which
     destinations receive the VIDEO, and a staged show is exactly the case where
     the title must land before the fan-out does.

     There is no bulk endpoint underneath — Restream's own API is one PATCH per
     channel — so this is a client-side fan-out of N independent writes to N
     different platform APIs, and partial success is the normal case. Nothing
     here ever collapses that into one "Updated": each channel gets its own
     verdict, and the three that exist are applied, DEFERRED (YouTube, with the
     reason), and failed with the platform's own message. */
  const applyNow = new Map();          /* destination uniqueId -> verdict record */
  let applyNowRunning = 0;
  const streamInfoCatalogueReads = new WeakSet();
  /* Show text is owned by the composition whenever its host is available.
     A standalone Map retains its per-Broadcast draft. Neither path contacts a
     platform: only the explicit Update All / Go actions below do that. */
  const streamInfoFields = new Set();
  const streamInfoOwners = new WeakMap();
  const streamInfoOwnerPrefix = 'map-draft:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2) + ':';
  let streamInfoOwnerSequence = 0, streamInfoUndoGroup = null;
  let stopShowInfoSubscription = null;
  function sharedShowInfo() {
    try {
      const shared = window.OpenLiveShowInfo && window.OpenLiveShowInfo.read();
      return shared && typeof shared.owner === 'string' && typeof shared.title === 'string' &&
        typeof shared.description === 'string' ? shared : null;
    } catch (error) { return null; }
  }
  function localStreamInfoOwner(sc) {
    const id = String(sc.uniqueId);
    let record = streamInfoOwners.get(sc);
    if (!record || record.id !== id) {
      record = { id, owner: streamInfoOwnerPrefix + (++streamInfoOwnerSequence) };
      streamInfoOwners.set(sc, record);
    }
    return record.owner;
  }
  function streamInfoDraft(screenId) {
    const sc = screenById(screenId);
    if (ST.destroyed || !sc || sc.type !== 'StreamScreen') return null;
    const shared = sharedShowInfo();
    if (shared) return { owner: shared.owner, title: shared.title, description: shared.description };
    const draft = { owner: localStreamInfoOwner(sc) };
    INFO_FIELDS.forEach(field => { draft[field.key] = String(pget(sc, [field.param], '') || ''); });
    return draft;
  }
  function patchStreamInfo(patch, owner, gesture) {
    if (ST.destroyed || !patch || typeof owner !== 'string') return false;
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !INFO_FIELDS.some(field => field.key === key) || typeof patch[key] !== 'string')) return false;
    const shared = sharedShowInfo();
    if (shared) {
      if (shared.owner !== owner) return false;
      try { return window.OpenLiveShowInfo.patch(patch, owner) === true; }
      catch (error) { return false; }
    }
    // Search exact live owners only. Replacing/deleting a screen, including an
    // undo/load with the same id, never transfers permission to its replacement.
    const sc = screens().find(screen => screen.type === 'StreamScreen' && localStreamInfoOwner(screen) === owner);
    if (!sc) return false;
    const changed = INFO_FIELDS.filter(field => keys.includes(field.key) &&
      String(pget(sc, [field.param], '') || '') !== patch[field.key]);
    if (!changed.length) return true;
    const signature = changed.map(field => field.key).sort().join(','), at = Date.now();
    const previous = streamInfoUndoGroup;
    const top = ST.undo[ST.undo.length - 1];
    if (!previous || previous.owner !== owner || previous.signature !== signature || previous.entry !== top ||
        (gesture ? previous.gesture !== gesture : previous.gesture || at - previous.at > 1000)) {
      push('set stream ' + signature);
    }
    streamInfoUndoGroup = { owner, signature, gesture: gesture || null, at, entry: ST.undo[ST.undo.length - 1] };
    changed.forEach(field => pset(sc, 'Params', field.param, patch[field.key], 'STRING', 'Param'));
    syncStreamInfoFields();
    return true;
  }
  function syncStreamInfoField(binding) {
    if (binding.el.isConnected === false) { streamInfoFields.delete(binding); return; }
    if (ST.destroyed || screenById(binding.sc.uniqueId) !== binding.sc) return;
    const next = streamInfoDraft(binding.sc.uniqueId);
    if (!next || binding.composing) return;
    const value = next[binding.field.key], el = binding.el;
    binding.expected = value;
    binding.owner = next.owner;
    if (el.value === value) return;
    const start = el.selectionStart, end = el.selectionEnd, direction = el.selectionDirection;
    el.value = value;
    if (typeof start === 'number' && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length), direction || 'none'); } catch (error) { /* not a text control */ }
    }
  }
  function syncStreamInfoFields() {
    streamInfoFields.forEach(syncStreamInfoField);
  }
  function streamInfoScopeCurrent(sc) {
    return !ST.destroyed && !!sc && screenById(sc.uniqueId) === sc && curScreen() === sc;
  }
  function streamInfoIdentity(dest) {
    return JSON.stringify([dest.uniqueId, dest.accountId, dest.channelId,
      dest.provider, dest.platformId, dest.transport]);
  }
  function streamInfoRecord(sc, dest) {
    if (ST.destroyed) return null;
    const rec = applyNow.get(String(dest.uniqueId));
    if (!rec || !rec.request) return rec || null;
    const sent = rec.request;
    if (sent.sc !== sc || sent.dest !== dest || screenById(sc.uniqueId) !== sc ||
        !(sc.destinations || []).includes(dest) || sent.identity !== streamInfoIdentity(dest) ||
        sent.owner !== (streamInfoDraft(sc.uniqueId) || {}).owner) return null;
    if (sent.data !== JSON.stringify(streamInfoFor(sc, dest))) return Object.assign({}, rec, {
      state: 'stale', note: 'Draft details changed. This result belongs to the previous values; update again to send the current draft.'
    });
    return rec;
  }
  function setStreamInfoDraft(sc, field, value, expected, owner, gesture) {
    if (ST.destroyed) return false;
    const current = streamInfoDraft(sc && sc.uniqueId);
    if (!streamInfoScopeCurrent(sc) || !current || current[field.key] !== expected ||
        (owner && current.owner !== owner)) {
      notify('This stream-details view changed. Reopen the current Broadcast before editing it.', 'warn');
      return false;
    }
    if (expected === value) return true;
    const accepted = patchStreamInfo({ [field.key]: String(value) }, current.owner, gesture);
    if (!accepted) notify('The Show details could not be updated. Reconnect to the current Show and try again.', 'warn');
    return accepted;
  }
  function streamInfoDraftField(parent, sc, field) {
    const line = row(parent, field.label);
    const description = field.key === 'description';
    if (description) line.classList.add('oo-ta-row');
    const el = mk(description ? 'textarea' : 'input', description ? 'oo-ta' : '', line);
    if (description) el.rows = 3; else el.type = 'text';
    const draft = streamInfoDraft(sc.uniqueId);
    const binding = { el, sc, field, expected: draft ? draft[field.key] : '', owner: draft && draft.owner,
      gesture: {}, composing: false };
    streamInfoFields.add(binding);
    el.value = binding.expected;
    el.setAttribute('aria-label', 'Broadcast ' + field.label);
    const commit = () => {
      if (binding.composing) return;
      if (setStreamInfoDraft(sc, field, el.value, binding.expected, binding.owner, binding.gesture)) {
        binding.expected = el.value;
      }
      syncStreamInfoField(binding);
    };
    el.addEventListener('focus', () => { binding.gesture = {}; });
    el.addEventListener('compositionstart', () => { binding.composing = true; });
    el.addEventListener('compositionend', () => { binding.composing = false; commit(); });
    el.addEventListener('input', commit);
    el.addEventListener('change', commit);
    // Some input methods deliver input + blur without change. Commit before a
    // deferred inspector rebuild, with the expected value preventing repeats.
    el.addEventListener('blur', () => { binding.composing = false; commit(); binding.gesture = {}; });
    return el;
  }
  function streamInfoAccountProblem(dest) {
    const connected = connectedRowFor(dest);
    if (!connected) return 'A destination is no longer connected. Reconnect it or remove its stale route before updating.';
    if (typeof mapAccountDisconnectPending !== 'undefined' &&
        mapAccountDisconnectPending.has(String(dest.accountId))) return 'Wait for account disconnection to finish.';
    const blocked = (destCat && destCat.destinations || []).some(row => row.kind === 'blocked' &&
      row.platformId != null && String(row.platformId) === String(connected.platformId));
    if (blocked || connected.ready === false || connected.eligibility && connected.eligibility.state === 'blocked')
      return String(connected.error || connected.eligibility && connected.eligibility.message ||
        connected.note || 'This platform channel is unavailable for updates.');
    return '';
  }

  /* The request and response contract is READ from devserver.py
     _api_accounts_apply_now(), not guessed:

       POST { accountIds: [id, …], info: { title, description, categories } }
       ->   { accounts: [ { accountId, status, …per-field report }, … ] }

     `info.categories` is keyed by account id, which is what makes ONE request
     carry a DIFFERENT category per channel — openlive-accounts.py _scoped_info()
     resolves each destination's own before the per-provider write, and strips
     the table so no channel's category travels into another's request. There is
     one row per account and no combined verdict, which is exactly what this
     panel needs: it renders N lines and never an aggregate. */
  function applyAllStreamInfo(sc) {
    if (ST.destroyed) return Promise.resolve(false);
    if (!streamInfoScopeCurrent(sc)) {
      notify('This Broadcast view is stale. Reopen its stream details before updating.', 'warn');
      return Promise.resolve(false);
    }
    if (applyNowRunning || streamInfoCatalogueReads.has(sc)) {
      notify('A stream-details update is already in progress. Wait for its result.', 'warn');
      return Promise.resolve(false);
    }
    if (!destCat) {
      const ownerBeforeRead = (streamInfoDraft(sc.uniqueId) || {}).owner;
      const draftBeforeRead = JSON.stringify((sc.destinations || []).map(dest =>
        [streamInfoIdentity(dest), streamInfoFor(sc, dest)]));
      streamInfoCatalogueReads.add(sc);
      return Promise.resolve().then(() => refreshDestCatalogue(false)).then(() => {
        streamInfoCatalogueReads.delete(sc);
        if (ST.destroyed) return false;
        if (!destCat) { notify('Connected channels could not be verified. Nothing was sent.', 'warn'); return false; }
        if (ownerBeforeRead !== (streamInfoDraft(sc.uniqueId) || {}).owner ||
            draftBeforeRead !== JSON.stringify((sc.destinations || []).map(dest =>
          [streamInfoIdentity(dest), streamInfoFor(sc, dest)]))) {
          notify('The stream draft or its channels changed while checking connections. Review it and press Update All again.', 'warn');
          return false;
        }
        return applyAllStreamInfo(sc);
      }, () => {
        streamInfoCatalogueReads.delete(sc);
        if (ST.destroyed) return false;
        notify('Connected channels could not be verified. Nothing was sent.', 'warn'); return false;
      });
    }
    if (destCat.error) {
      notify('Stream info was not sent because connected channels could not be verified: ' +
             destCat.error, 'error');
      return;
    }
    const dests = (sc.destinations || []).filter(d => d && d.accountId);
    const problem = dests.map(streamInfoAccountProblem).find(Boolean);
    if (problem) { notify('Stream info was not sent: ' + problem, 'warn'); return Promise.resolve(false); }
    if (!dests.length) {
      notify('Nothing to update: no destination on this Broadcast is backed by a connected ' +
             'channel. A pasted stream key carries video and has no API to set a title on.', 'warn');
      return;
    }
    const askedFor = d => Object.keys(streamInfoFor(sc, d));
    const requestFor = dest => ({ sc, dest, id: String(dest.uniqueId),
      owner: (streamInfoDraft(sc.uniqueId) || {}).owner,
      accountId: String(dest.accountId), name: dest.name, identity: streamInfoIdentity(dest),
      data: JSON.stringify(streamInfoFor(sc, dest)), asked: askedFor(dest) });
    const sendable = dests.filter(d => askedFor(d).length);
    dests.filter(d => !askedFor(d).length).forEach(d => {
      applyNow.set(String(d.uniqueId), { at: Date.now(), state: 'nothing', request: requestFor(d), asked: [],
        note: 'Nothing to push: no Title, Description or Category is set for this destination.' });
    });
    if (!sendable.length) {
      notify('Nothing was sent: no Title or Description is set on this Broadcast and no ' +
             'destination has a Category of its own.', 'warn');
      refresh();
      return;
    }
    /* Two destinations on ONE account write to the SAME channel. That is fine
       for the shared title; it is not fine for two different categories, and
       only one of them can be sent. Say which rather than reporting both. */
    const byAccount = new Map();
    sendable.forEach(d => {
      const k = String(d.accountId);
      byAccount.set(k, (byAccount.get(k) || []).concat([d]));
    });
    const clashes = [...byAccount.values()].filter(group => {
      const cats = group.map(d => categoryOf(sc, d));
      return new Set(cats).size > 1 || new Set(group.map(d => String(d.channelId || ''))).size > 1;
    });
    if (clashes.length) {
      notify('Stream info was not sent: duplicate account routes have conflicting channels or categories. ' +
        'Resolve the destination settings before updating.', 'warn');
      return Promise.resolve(false);
    }

    /* ONE request, N rows back. NO fallbackTitle: this write lands on permanent
       Twitch and Kick channel state, and there is no new object needing a name,
       so sending the Broadcast's internal name would rename a real channel. */
    const info = streamInfo(sc);
    const categories = {};
    byAccount.forEach((group, accountId) => {
      const c = group.map(d => categoryOf(sc, d)).filter(Boolean)[0];
      if (c) categories[accountId] = c;
    });
    if (Object.keys(categories).length) info.categories = categories;
    const ids = [...byAccount.keys()];

    const requests = sendable.map(requestFor);
    const stillOwned = sent => !ST.destroyed && screenById(sc.uniqueId) === sc &&
      sent.owner === (streamInfoDraft(sc.uniqueId) || {}).owner &&
      (sc.destinations || []).includes(sent.dest) && streamInfoIdentity(sent.dest) === sent.identity &&
      applyNow.get(sent.id) && applyNow.get(sent.id).request === sent;
    const record = (sent, result) => {
      if (stillOwned(sent)) applyNow.set(sent.id, Object.assign({ at: Date.now(), request: sent, asked: sent.asked }, result));
    };
    requests.forEach(sent => applyNow.set(sent.id,
      { at: Date.now(), state: 'running', asked: sent.asked, request: sent }));
    applyNowRunning++;
    refresh();

    let call;
    try { call = acctHTTP(APPLY_NOW_ROUTE, { accountIds: ids, info: info }); }
    catch (e) { call = Promise.reject(e); }
    return Promise.resolve(call).then(res => {
      const rows = res && Array.isArray(res.accounts) ? res.accounts : null;
      requests.forEach(sent => {
        if (!stillOwned(sent)) return;
        if (!rows) {
          record(sent, { state: 'unreported',
            note: 'The helper answered ' + APPLY_NOW_ROUTE + ' without the per-account rows this ' +
                  'panel reads, so nothing here can say what any platform took.' });
          return;
        }
        const row = rows.find(x => x && String(x.accountId) === sent.accountId);
        if (!row) {
          record(sent, { state: 'unreported',
            note: 'The helper returned no row for this channel, so its outcome is unknown.' });
          return;
        }
        if (row.error) {
          record(sent, { state: 'failed',
            error: String(row.error) + (row.status && row.status !== 200
              ? ' (HTTP ' + row.status + ')' : '') });
          return;
        }
        const list = readStreamInfoResult(row);
        record(sent, { state: list ? 'reported' : 'unreported',
          fields: list, when: row.when ? String(row.when) : '',
          categorySource: row.categorySource || null,
          note: list ? '' : 'The helper answered for this channel without a per-field result.' });
      });
      /* One notification per channel. A fan-out that partially succeeds is the
         normal case, so a single line for all of them would be false the moment
         one platform refused a field. */
      requests.forEach(sent => {
        if (!stillOwned(sent)) return;
        const rec = streamInfoRecord(sc, sent.dest);
        if (!rec) return;
        notify(sent.name + ': Update All: ' +
               (rec.state === 'reported' ? infoSummary(rec.fields || [])
                : rec.state === 'failed' ? 'failed: ' + rec.error
                : rec.note || 'no result reported.'),
               applyLineBad(rec) ? 'warn' : '');
      });
    }).catch(error => {
      if (ST.destroyed || !requests.some(stillOwned)) return;
      /* A lost response cannot prove that no provider accepted the write. */
      const why = error && error.absent
        ? ('This helper has no ' + APPLY_NOW_ROUTE + ' route, so stream info cannot be pushed ' +
           'before Go Live from this build. It is still applied at Go.')
        : ((error && error.message) || String(error));
      requests.forEach(sent => record(sent,
        { state: 'failed', error: why }));
      notify('Could not confirm the stream-details update: ' + why +
        ' Check the platforms before retrying; some changes may already have arrived.', 'error');
    }).finally(() => {
      applyNowRunning = Math.max(0, applyNowRunning - 1);
      try { if (!ST.destroyed) refresh(); } catch (e) {}
    });
  }
  /* One line per channel for the Stream info section — never one line for all
     of them. Returns [] when nothing has been pushed yet. */
  function applyAllLines(sc) {
    const out = [];
    (sc.destinations || []).forEach(dest => {
      const rec = streamInfoRecord(sc, dest);
      if (!rec) return;
      out.push({ dest: dest, rec: rec, text: applyLineText(dest, rec), bad: applyLineBad(rec) });
    });
    return out;
  }
  function applyLineText(dest, rec) {
    if (rec.state === 'stale') return dest.name + ': ' + rec.note;
    if (rec.state === 'running') return dest.name + ': pushing…';
    if (rec.state === 'nothing') return dest.name + ': ' + rec.note;
    if (rec.state === 'failed') return dest.name + ': failed: ' + rec.error;
    if (rec.state === 'unreported')
      return dest.name + ': sent: ' + (rec.note || 'the helper reported no per-field result.');
    return dest.name + ': ' + infoSummary(rec.fields || []);
  }
  const applyLineBad = rec => rec.state === 'stale' || rec.state === 'failed' || rec.state === 'unreported' ||
    (rec.state === 'reported' && (rec.fields || []).some(x => infoBad(x.state)));
  /* The same guard for a length ceiling. YouTube documents 100 characters for a
     broadcast title and Twitch 140, but neither number is in this repo's
     catalogue today, so nothing is shown unless a row actually carries
     titleMax. A hardcoded limit would be a fabricated measurement. */
  function titleCeiling(list) {
    let low = null;
    (list || []).forEach(dest => {
      const cr = catalogueRowFor(dest);
      const n = cr && typeof cr.titleMax === 'number' && cr.titleMax > 0 ? cr.titleMax : null;
      if (n != null && (low === null || n < low.max)) low = { max: n, who: cr.platform || cr.displayName || '' };
    });
    return low;
  }

  let destCat = null;
  let destCatAsked = false;
  function syncConnectedChannels(catalogue, enableForScreenId) {
    const router = CHR();
    if (!router) return false;
    let changed = false;
    screens().forEach(sc => {
      if (!isStreamScreen(sc)) return;
      const wasEmpty = !(sc.destinations || []).length;
      let gaveEmptyScreenItsDefault = false;
      const result = router.reconcile(sc.destinations, catalogue, {
        create: init => sc.addDestination(init),
        /* A channel connected from THIS Broadcast is immediately On here. In
           every other Broadcast it appears Off, ready for its own toggle. An
           imported empty Broadcast still gets one sensible On row. */
        enableNew: () => {
          if (enableForScreenId != null &&
              String(sc.uniqueId) === String(enableForScreenId)) return true;
          if (wasEmpty && !gaveEmptyScreenItsDefault) {
            gaveEmptyScreenItsDefault = true;
            return true;
          }
          return false;
        }
      });
      result.removed.forEach(old => {
        pdrop(sc, catParam(old));
        applyNow.delete(String(old.uniqueId));
      });
      changed = result.changed || changed;
    });
    return changed;
  }

  // Map account management ownership
  const mapAccountDisconnectPending = new Set();
  const mapAccountConnectPending = new Set();
  let mapAccountDisconnectConfirmation = null; // Owner/identity only; never retain inspector DOM.
  let destCatalogueRevision = 0;
  function refreshMapAccountView() { if (!ST.destroyed) refresh(); }
  function notifyMapAccount(message, kind) { if (!ST.destroyed) notify(message, kind); }
  function refreshDestCatalogue(force, options) {
    if (ST.destroyed) return Promise.resolve(destCat);
    const S = hostStream();
    if (!S || !S.accounts) {
      ++destCatalogueRevision;
      destCat = { destinations: [], error:
        'The streaming module is on the main SHOWAVE Live window, so the destination ' +
        'catalogue cannot be read from here. Open Output > SHOWAVE Map from SHOWAVE Live.' };
      return Promise.resolve(destCat);
    }
    if (destCat && !force) return Promise.resolve(destCat);
    destCatAsked = true;
    const revision = ++destCatalogueRevision;
    return S.accounts.destinations().then(d => {
      if (ST.destroyed || revision !== destCatalogueRevision) return destCat;
      destCat = d;
      syncConnectedChannels(d, options && options.enableForScreenId);
      try { refreshMapAccountView(); } catch (e) {}
      return d;
    }).catch(error => {
      if (ST.destroyed || revision !== destCatalogueRevision) return destCat;
      destCat = { destinations: [],
        error: `The destination catalogue could not be read: ${error && error.message || error}` };
      try { refreshMapAccountView(); } catch (e) {}
      return destCat;
    });
  }

  function mapAccountScopeLock(sc, screenId) {
    if (ST.destroyed) return 'This SHOWAVE Map editor was closed. Reopen it before changing accounts.';
    if (!sc || sc.uniqueId !== screenId || screenById(screenId) !== sc || curScreen() !== sc)
      return 'This account view is stale. Reopen the current Broadcast.';
    if (activeEgressCount() > 0 || liveDest.size > 0)
      return 'Stop and clear all output attempts before changing connected accounts.';
    if (applyNowRunning > 0)
      return 'Wait for the stream details update to finish before changing connected accounts.';
    if (!destCat || destCat.error)
      return 'Refresh the account catalogue before changing a connection.';
    return '';
  }
  function mapAccountChannelIdentity(ch) {
    return JSON.stringify([ch.accountId, ch.channelId, ch.provider, ch.platformId]);
  }
  function mapAccountConfirmationOpen(sc, ch) {
    const owner = mapAccountDisconnectConfirmation;
    if (!owner) return false;
    const current = (destCat && destCat.destinations || []).find(row => row.kind === 'channel' &&
      String(row.accountId) === owner.identity.accountId &&
      mapAccountChannelIdentity(row) === owner.identity.channelIdentity);
    if (owner.sc !== sc || !current || mapAccountDisconnectLock(owner.sc, current, owner.identity)) {
      mapAccountDisconnectConfirmation = null;
      return false;
    }
    return String(ch.accountId) === owner.identity.accountId &&
      mapAccountChannelIdentity(ch) === owner.identity.channelIdentity;
  }
  function openMapAccountConfirmation(sc, ch, identity) {
    const locked = mapAccountDisconnectLock(sc, ch, identity);
    if (locked) { notifyMapAccount(locked, 'warn'); refreshMapAccountView(); return false; }
    mapAccountDisconnectConfirmation = { sc, identity: Object.assign({}, identity) };
    return true;
  }
  function clearMapAccountConfirmation(sc, identity) {
    const owner = mapAccountDisconnectConfirmation;
    if (owner && owner.sc === sc && owner.identity.screenId === identity.screenId &&
        owner.identity.accountId === identity.accountId && owner.identity.channelIdentity === identity.channelIdentity)
      mapAccountDisconnectConfirmation = null;
  }
  function mapAccountDisconnectLock(sc, ch, identity) {
    const locked = mapAccountScopeLock(sc, identity.screenId);
    if (locked) return locked;
    if (!identity.accountId || String(ch.accountId) !== identity.accountId ||
        mapAccountChannelIdentity(ch) !== identity.channelIdentity ||
        !(destCat.destinations || []).includes(ch) || ch.kind !== 'channel')
      return 'This connected account changed. Reopen its current connection controls.';
    if (mapAccountDisconnectPending.size)
      return 'An account disconnect is already in progress. Wait for it to finish.';
    if (mapAccountConnectPending.size)
      return 'Finish the account sign-in before disconnecting an account.';
    const S = hostStream();
    if (!S || !S.accounts || typeof S.accounts.disconnect !== 'function')
      return 'The accounts helper is not available to disconnect this account.';
    return '';
  }
  async function disconnectMapAccount(sc, ch, identity) {
    const locked = mapAccountDisconnectLock(sc, ch, identity);
    if (locked) { notifyMapAccount(locked, 'warn'); refreshMapAccountView(); return false; }
    const accountId = identity.accountId;
    const S = hostStream();
    mapAccountDisconnectConfirmation = null;
    mapAccountDisconnectPending.add(accountId);
    ++destCatalogueRevision; // In-flight reads cannot resurrect pre-disconnect routes.
    refreshMapAccountView();
    let disconnected = false;
    try {
      const outcome = await S.accounts.disconnect(accountId);
      if (!outcome || typeof outcome.removed !== 'boolean')
        throw new Error('The accounts helper did not confirm disconnection.');
      disconnected = true;
      ++destCatalogueRevision;
      for (const screen of screens()) {
        const routes = screen.destinations || [];
        for (let index = routes.length - 1; index >= 0; index--) {
          const old = routes[index];
          if (String(old.accountId || '') !== accountId) continue;
          invalidateDestinationConnection(old);
          pdrop(screen, catParam(old));
          applyNow.delete(String(old.uniqueId));
          sessionUrl.delete(String(old.uniqueId));
          routes.splice(index, 1);
        }
      }
      destCat = Object.assign({}, destCat, { destinations: (destCat.destinations || [])
        .filter(row => !(row.kind === 'channel' && String(row.accountId) === accountId)) });
      await refreshDestCatalogue(true);
      notifyMapAccount('Account disconnected from SHOWAVE on this machine. Its channels were removed from every Broadcast; connect again to use them.', '');
      return true;
    } catch (_) {
      notifyMapAccount(disconnected
        ? 'The account was disconnected, but its local views could not all be refreshed. Reload SHOWAVE before reconnecting.'
        : 'Could not disconnect this account. Its local connection and Broadcast routes were kept; please retry.', 'error');
      return false;
    } finally {
      mapAccountDisconnectPending.delete(accountId);
      refreshMapAccountView();
    }
  }
  function mapAccountConnectLock(target, broadcast, screenId) {
    const locked = mapAccountScopeLock(broadcast, screenId);
    if (locked) return locked;
    if (!target || target.kind !== 'connect' || !target.provider ||
        !(destCat.destinations || []).includes(target))
      return 'This sign-in option changed. Choose it again from the current platform list.';
    if ((destCat.destinations || []).some(row => row.kind === 'blocked' &&
        String(row.platformId) === String(target.platformId)))
      return 'This platform is unavailable. Review its current workflow before connecting.';
    if (mapAccountDisconnectPending.size)
      return 'Wait for the account disconnect to finish before adding an account.';
    if (mapAccountConnectPending.size)
      return 'An account sign-in is already in progress. Finish or cancel it in the platform window first.';
    const S = hostStream();
    if (!S || !S.accounts || typeof S.accounts.connect !== 'function')
      return 'The accounts helper is not available to connect this account.';
    return '';
  }

  /* Connect ONE account, end to end: the build's registered platform app opens
     the platform's own consent page, then refreshes so its channels appear.

     Account-level on purpose. The channel this produces belongs to the app and
     shows up on every Broadcast, which is precisely why this is not reachable
     from a per-destination control. */
  async function connectChannel(target, broadcast) {
    const screenId = broadcast && broadcast.uniqueId;
    const locked = mapAccountConnectLock(target, broadcast, screenId);
    if (locked) { notifyMapAccount(locked, 'warn'); refreshMapAccountView(); return false; }
    const S = hostStream();
    const provider = String(target.provider);
    const label = target.displayName || provider;
    if (!target.ready) {
      ST.addChannelOpen = true;
      notifyMapAccount(`${label} sign-in is not enabled in this SHOWAVE build. The SHOWAVE distributor ` +
             `must configure and ship that platform's OAuth application; an end user should ` +
             `never paste a client id.`, 'warn');
      refreshMapAccountView(); return false;
    }
    mapAccountDisconnectConfirmation = null;
    mapAccountConnectPending.add(provider);
    refreshMapAccountView();
    try {
      const outcome = await S.accounts.connect(provider, {
        flow: target.flow,
        /* Report what actually happened rather than asserting a window opened.
           The helper opens the operator's real browser — where their platform
           session already lives, which is why the password step disappears. If
           it could not, hand over the URL instead of failing silently.

           A device-code provider (Twitch) also hands back a short code. Some
           platforms prefill it into the page, some ask for it to be typed —
           so it is always shown, never assumed away. */
        onPrompt: begun => {
          const code = begun.userCode ? ` If the page asks for a code, enter ${begun.userCode}.` : '';
          const where = begun.authorizeUrl || begun.verificationUri || '';
          if (begun.openedSystemBrowser) {
            notifyMapAccount(`${label} sign-in opened in your browser. You are likely already signed in ` +
                   `there, so it will only ask you to Allow once, for this channel.${code}`, '');
          } else {
            notifyMapAccount(`SHOWAVE could not open your browser (${begun.openError || 'no reason given'}). ` +
                   `Open this URL yourself to continue: ${where}${code}`, 'warn');
          }
        }
      });
      if (ST.destroyed) return true; // The explicit sign-in finished; do not revive a closed view.
      const catalogue = await refreshDestCatalogue(true, {
        enableForScreenId: screenById(screenId) === broadcast ? screenId : undefined
      });
      if (!catalogue || catalogue.error) {
        notifyMapAccount(`${label} sign-in completed, but its channels could not be refreshed. Reload the connection list before continuing.`, 'warn');
        return false;
      }
      if (outcome && outcome.alreadyConnected) {
        notifyMapAccount(`Channel already added. ${outcome.message ||
          `Switch account on ${label} in the sign-in browser and try again.`}`, 'warn');
        return true;
      }
      notifyMapAccount(`${label} connected. Its channels are now destination rows on every Broadcast. ` +
             `Use On or Off, then press Go Live; no ingest settings are required.`, '');
      return true;
    } catch (_) {
      notifyMapAccount(`${label} could not be connected. Existing connections and Broadcast routes were kept.`, 'error');
      return false;
    } finally {
      mapAccountConnectPending.delete(provider);
      refreshMapAccountView();
    }
  }
  // End Map account management ownership

  /* The non-platform destinations that are still real and still wanted. These
     are not services, so they are not in the catalogue, but File and OBS are
     genuinely useful and WHIP is the one thing the tab can do with no helper. */
  const DIRECT_ROWS = [
    { key: 'ST_DISABLED', label: 'Not routed', transport: 'ST_DISABLED', kind: 'direct',
      note: 'Configured but not routed anywhere.' },
    { key: 'ST_FILE', label: 'Record to file', transport: 'ST_FILE', kind: 'direct',
      note: 'Record this Broadcast to a local file. Not a network destination.' },
    { key: 'ST_OBS', label: 'OBS setup guide', transport: 'ST_OBS', kind: 'direct',
      note: 'Shows and copies setup steps for capturing the Studio Programme projector in OBS. Video only; configure audio separately in OBS. Starts no stream.' }
  ];

  /* The helper's measured relay capability. null means "not asked yet", which
     is a different answer from false and must never render as either a working
     control or a permanent refusal. */
  let relayCap = null;
  let relayCapAsked = false;
  function refreshRelayCapability(force) {
    const S = hostStream();
    if (!S || !S.relay) { relayCap = { relay: false,
      reason: 'The streaming module is not reachable from this window.' }; return Promise.resolve(relayCap); }
    relayCapAsked = true;
    return S.relay.capability(!!force).then(cap => {
      relayCap = cap;
      try { refresh(); } catch (e) {}
      return cap;
    }).catch(error => {
      relayCap = { relay: false,
        reason: `The local helper did not answer: ${error && error.message ? error.message : error}` };
      try { refresh(); } catch (e) {}
      return relayCap;
    });
  }

  /* Which transports this build can actually carry, and why not for the rest. */
  function destCapability(transport) {
    /* The output page needs its SHOWAVE opener to read frames. An independent
       OBS Browser Source has no such opener, so its URL cannot carry media.
       This action is setup guidance for window capture, even in a standalone
       Map; it does not depend on a relay or claim an OBS connection. */
    if (transport === 'ST_OBS') return { ok: true, handoff: true };
    if (!relayCapAsked) { relayCapAsked = true; refreshRelayCapability(false); }
    const S = hostStream();
    if (!S) return { ok: false, why: 'The streaming module is on the main SHOWAVE Live window and SHOWAVE Map ' +
      'is open on its own, so nothing here can transmit. Open Output > SHOWAVE Map from SHOWAVE Live.' };
    switch (transport) {
      case 'ST_ENDPOINT': return { ok: true };
      case 'ST_FILE': return { ok: true };
      /* RTMP still needs a raw TCP socket that a tab does not have — but the
         local helper now carries one. This used to be a hardcoded refusal,
         which meant the UI could not tell a machine with ffmpeg from one
         without. relayCap is refreshed by refreshRelayCapability() below, so
         the answer is measured. Until that first measurement lands the answer
         is "not yet known", never a fabricated yes. */
      case 'ST_HELPER_RTMP': {
        if (relayCap === null) {
          return { ok: false, pending: true,
            why: 'Asking the local helper whether it can relay RTMP…' };
        }
        if (!relayCap.relay) {
          return { ok: false, why: relayCap.reason ||
            'The local helper cannot relay RTMP: ffmpeg was not found on this machine.' };
        }
        const S2 = hostStream();
        const mime = S2 && S2.relay ? S2.relay.mime(relayCap) : null;
        if (!mime) {
          return { ok: false, why: 'This browser has no MediaRecorder codec the relay can carry.' };
        }
        return { ok: true, relay: true, mime: mime,
          copy: /h264|avc1/i.test(mime),
          why: '' };
      }
      case 'ST_HELPER_SRT': return { ok: false, why: 'SRT needs a UDP socket and libsrt. Same local helper, ' +
        'not built yet.' };
      default: return { ok: false, why: 'This destination has no transport selected.' };
    }
  }
  const connectedRowFor = dest => !dest || !dest.accountId ? null
    : ((destCat && destCat.destinations) || []).find(row =>
        row && row.kind === 'channel' && String(row.accountId) === String(dest.accountId) &&
        String(row.channelId || '') === String(dest.channelId || '')) || null;
  /* A transport can be healthy while the account that is supposed to obtain
     its ingest has been signed out. Verify both halves before enabling Go;
     otherwise an old output document presents a stream-ready row that can only
     fail after the operator is already trying to go live. */
  function routeCapability(dest) {
    const cap = destCapability(dest && dest.transport);
    if (!dest) return cap;
    if (typeof mapAccountConnectPending !== 'undefined' && mapAccountConnectPending.size)
      return { ok: false, pending: true, why: 'Finish the account sign-in before starting an output.' };
    if (dest.accountId && typeof mapAccountDisconnectPending !== 'undefined' &&
        mapAccountDisconnectPending.has(String(dest.accountId)))
      return { ok: false, pending: true, why: 'This account is being disconnected. Wait for the operation to finish.' };
    const channelRow = connectedRowFor(dest);
    const platformId = dest.platformId != null && String(dest.platformId).trim() !== ''
      ? dest.platformId : channelRow && channelRow.platformId;
    /* A saved output or stale ready account can still name a retired platform
       after the picker has disabled it. Neither a healthy relay nor a stored
       authorization overrides that refusal. Match only explicit identities:
       unlabelled custom endpoints must not inherit unrelated refusals. */
    const blocked = ((destCat && destCat.destinations) || []).find(row =>
      row && row.kind === 'blocked' && (
        (platformId != null && row.platformId != null &&
          String(platformId) === String(row.platformId)) ||
        (dest.serviceKey && row.platformId != null &&
          dest.serviceKey === 'plat:' + String(row.platformId)) ||
        (dest.serviceKey && row.serviceKey && dest.serviceKey === row.serviceKey)));
    if (blocked) return {
      ok: false, platformBlocked: true,
      why: String(blocked.note || blocked.error ||
        'This platform destination is unavailable in SHOWAVE.')
    };
    if (dest.endpointRef && typeof savedIngestForgetPending !== 'undefined' &&
        savedIngestForgetPending.has(dest.endpointRef)) return {
      ok: false, pending: true,
      why: 'This saved ingest is being deleted. Wait for the operation to finish before starting.'
    };
    if (!dest.accountId) return cap;
    const S = hostStream();
    if (!S || !S.accounts) return { ok: false, why:
      'This destination needs a connected platform account, but the accounts helper is not reachable.' };
    if (!destCat) return { ok: false, pending: true, why:
      'Checking that this platform channel is still authorised on this machine…' };
    if (destCat.error) return { ok: false, why: destCat.error };
    if (!channelRow) return { ok: false, why:
      'This saved destination is no longer connected on this machine. Sign in again under ' +
      '+ Add Channel, or remove this stale route.' };
    const eligibility = channelRow.eligibility && typeof channelRow.eligibility === 'object'
      ? channelRow.eligibility : null;
    if (channelRow.ready === false || (eligibility && eligibility.state === 'blocked'))
      return {
        ok: false,
        why: String(channelRow.error || (eligibility && eligibility.message) || channelRow.note ||
          'This platform channel is not eligible to stream.'),
        code: eligibility && eligibility.code || null,
        actionLabel: channelRow.actionLabel || (eligibility && eligibility.actionLabel) || null,
        actionUrl: channelRow.actionUrl || (eligibility && eligibility.actionUrl) || null,
        platformBlocked: true
      };
    if (dest.transport !== 'ST_HELPER_RTMP') return { ok: false, why:
      'A connected platform channel must use the RTMP relay, but this saved row names another transport.' };
    return cap;
  }
  /* Selection is operator intent, not readiness. An unavailable selected
     service must remain visibly On and fail preflight until it is turned Off.
     Legacy unrouted placeholders, however, never count as selected outputs. */
  function isDestinationSelected(dest) {
    return !!(dest && dest.enabled && (dest.accountId ||
      (String(dest.transport || '').trim() && dest.transport !== 'ST_DISABLED')));
  }
  function destinationRoutingIdentity(dest) {
    return JSON.stringify([dest.serviceKey, dest.transport, dest.platformId,
      dest.accountId, dest.channelId, dest.endpointRef]);
  }
  function destinationToggleState(sc, dest) {
    const selected = isDestinationSelected(dest);
    const fail = why => ({ selected, disabled: true, why });
    if (screenById(sc.uniqueId) !== sc || curScreen() !== sc ||
        !(sc.destinations || []).includes(dest))
      return fail('This destination view is stale. Reopen the current Broadcast.');
    if (activeEgressCount() > 0)
      return fail('Stop active outputs before changing the On/Off routing set.');
    if (liveDest.has(String(dest.uniqueId)))
      return fail('Clear or finish this destination\'s previous output attempt before changing its routing.');
    if (!selected) {
      if (!isDestinationSelected(Object.assign({}, dest, { enabled: true })))
        return fail('Choose a destination service before turning it On.');
      const cap = routeCapability(dest);
      if (cap.platformBlocked || (dest.accountId && !cap.ok)) return fail(cap.why);
    }
    return { selected, disabled: false, why: '' };
  }
  function noteRelayStop(owner, session, result, label) {
    const outcome = result && typeof result === 'object' ? result : session && session.stopResult;
    if (!owner || !outcome || outcome.stopped !== true || outcome.truncated !== true) return null;
    /* A confirmed live-only stop may discard its pending tail. It releases
       media ownership, but must not read as a fully delivered ending. Keep
       the receipt with the attempt while platform cleanup is still pending,
       and keep the warning in Messages after the attempt itself is cleared. */
    owner.stopResult = outcome;
    const warning = 'Media stopped, but some final live media was discarded: ' +
      (outcome.reason || 'The buffered media could not be fully delivered.');
    if (owner.stopWarning !== warning) notify((label || 'Output') + ': ' + warning, 'warn');
    owner.stopWarning = warning;
    return warning;
  }

  function stopDest(destId) {
    const key = String(destId);
    const rec = liveDest.get(key);
    if (!rec) return;

    /* A grouped session carries several rows on ONE ffmpeg. Stopping any of
       them stops all of them, because there is one process and one tee. Say
       that plainly rather than letting a row look individually stoppable. */
    if (rec.grouped && screenRelay.has(rec.grouped)) {
      const groupId = rec.grouped;
      const group = screenRelay.get(groupId);
      if (group.stopPromise) return group.stopPromise;
      group.cancelled = true;
      const entries = group.destIds.map(id => {
        const rowRec = liveDest.get(String(id));
        const found = destinationRecord(id);
        return rowRec ? { id: String(id), dest: rowRec.destination || found && found.dest, rec: rowRec } : null;
      }).filter(Boolean);
      entries.forEach(row => {
        row.rec.cancelled = true;
        row.rec.finalizing = true;
        row.rec.state = 'stopping';
      });
      refresh();
      group.stopPromise = Promise.resolve().then(async () => {
        if (!group.session && group.armPromise) {
          try { await group.armPromise; } catch (e) {}
        }
        const S = hostStream();
        try {
          if (group.session) {
            if (!S?.relay?.stop) throw new Error('The streaming engine is unavailable.');
            const result = await S.relay.stop(group.session);
            noteRelayStop(group, group.session, result, 'Shared output');
            if (group.stopWarning) entries.forEach(row => {
              row.rec.stopResult = group.stopResult; row.rec.stopWarning = group.stopWarning;
            });
          }
        } catch (error) {
          entries.forEach(row => { row.rec.finalizing=false;row.rec.state='stop-failed';
            row.rec.session=group.session;row.rec.error='Media stop was not confirmed. Press Retry End.'; });
          notify('The shared output could not be ended. Media ownership was kept; press Retry End.', 'error');
          refresh();return {ok:false,stage:'media'};
        }
        try { if (group.source && group.source.stop) group.source.stop(); } catch (e) {}
        group.source=null;
        const results = await Promise.allSettled(entries.map(row =>
          finishPlatformDestination(row.dest, row.rec,
            row.rec.startedAt ? 'complete' : 'abort')));
        let finishFailures = 0;
        results.forEach((result, index) => {
          const row = entries[index];
          row.rec.finalizing = false;
          row.rec.session = null;
          row.rec.source = null;
          row.rec.grouped = null;
          if (result.status === 'rejected') {
            finishFailures++;
            row.rec.state = 'finish-failed';
            row.rec.error = 'Media stopped, but the platform broadcast could not be ended: ' +
              (result.reason && result.reason.message || result.reason);
          } else if (liveDest.get(row.id) === row.rec) liveDest.delete(row.id);
        });
        screenRelay.delete(groupId);
        notify(finishFailures
          ? 'Media stopped on ' + entries.length + ' destinations; ' + finishFailures +
            ' platform broadcast' + (finishFailures === 1 ? ' needs' : 's need') + ' Retry End.'
          : 'Ended all ' + entries.length + ' destinations; they shared one encode and one stop.',
          finishFailures ? 'error' : '');
        refresh();
        return {ok:finishFailures===0};
      }).finally(() => { group.stopPromise=null; });
      return group.stopPromise;
    }

    if (rec.stopPromise) return rec.stopPromise;
    rec.cancelled = true;
    rec.finalizing = true;
    rec.state = 'stopping';
    refresh();
    rec.stopPromise = Promise.resolve().then(async () => {
      if (!rec.session && rec.startPromise) {
        try { await rec.startPromise; } catch (e) {}
      }
      const S = hostStream();
      try {
        if (rec.session && rec.session.kind === 'relay') {
          if (!S?.relay?.stop) throw new Error('The streaming engine is unavailable.');
          const result = await S.relay.stop(rec.session);
          noteRelayStop(rec, rec.session, result, rec.destination?.name);
        } else if (rec.session && rec.session.recorder && !rec.session.pc) {
          if (!S?.recorder?.stop) throw new Error('The recording engine is unavailable.');
          await Promise.resolve(S.recorder.stop(rec.session));
        } else if (rec.session && rec.session.stop) {
          await Promise.resolve(rec.session.stop());
        } else if (rec.session) {
          throw new Error('This output has no available stop control.');
        }
      } catch (error) {
        rec.finalizing=false;rec.state='stop-failed';rec.error='Media stop was not confirmed. Press Retry End.';
        notify((rec.destination?.name || 'Destination') + ': ' + rec.error, 'error');
        refresh();return {ok:false,stage:'media'};
      }
      rec.session=null;
      try { if (rec.source && rec.source.stop) rec.source.stop(); } catch (e) {}
      rec.source=null;
      const found = destinationRecord(key);
      const destination = rec.destination || found && found.dest;
      try {
        await finishPlatformDestination(destination, rec,
          rec.startedAt ? 'complete' : 'abort');
        if (liveDest.get(key) === rec) liveDest.delete(key);
        notify((destination && destination.name || 'Destination') + ' ended.', '');
        return {ok:true};
      } catch (error) {
        rec.finalizing = false;
        rec.stopPromise = null;
        rec.session = null;
        rec.state = 'finish-failed';
        rec.error = 'Media stopped, but the platform broadcast could not be ended: ' +
          (error && error.message || error);
        notify((destination && destination.name || 'Destination') + ': ' + rec.error +
          ' Press Retry End.', 'error');
        return {ok:false,stage:'platform'};
      }
    }).finally(() => { rec.stopPromise=null;refresh(); });
    return rec.stopPromise;
  }
  /* Grouped relay sessions, keyed by screen uniqueId. One entry per screen that
     has RTMP destinations live: { session, source, destIds[] }. */
  const screenRelay = new Map();

  /* Open ONE relay session carrying every RTMP destination on this screen.

     This is the shape openlive-relay.py was built for and the shape the UI was
     not using: one MediaRecorder, one WebSocket, one ffmpeg, N tee slaves. The
     twentieth destination costs a socket and uplink bandwidth rather than
     another encoder — which is the claim the Encoder note in this panel has
     been making all along.

     ffmpeg fixes its tee slave list when it spawns (openlive-relay.py builds
     the spec once in _tee_spec), so a destination cannot join a running
     session. That is stated on the single-row Go rather than worked around,
     because quietly opening a second encode would defeat the whole point. */
  function armScreenRelay(sc, dests) {
    const S = hostStream();
    if (!S || !S.relay) {
      notify('The streaming module is not reachable from this window.', 'error');
      return;
    }
    if (screenRelay.has(String(sc.uniqueId))) {
      notify(sc.name + ' already has a relay session open. Stop it before opening another.', 'warn');
      return;
    }

    let source;
    try {
      source = S.sources.fromScreen(String(sc.uniqueId), {
        fps: Math.round(pnum(sc, ['Framerate'], 30)) || 30, audio: true
      });
    } catch (e) {
      notify(sc.name + ' could not be captured: ' + e.message, 'error');
      return;
    }

    const groupId = String(sc.uniqueId);
    const group = {
      session: null,
      source: source,
      destIds: dests.map(d => String(d.uniqueId)),
      cancelled: false,
      mediaStarted: false,
      stopPromise: null
    };
    /* Publish the pending group BEFORE provisioning.  Stop during a slow OAuth
       API call must cancel that attempt; without this record the late promise
       could start ffmpeg after the UI already said it was stopped. */
    screenRelay.set(groupId, group);

    /* Mark every row connecting up front, so a slow provision does not look
       like nothing happening. */
    const attempts = new Map();
    dests.forEach(d => {
      const rec = { source: null, session: null, state: 'connecting',
        error: null, grouped: groupId, cancelled: false, finalized: false,
        finalizing: false, destination: Object.assign({}, d) };
      attempts.set(String(d.uniqueId), rec); liveDest.set(String(d.uniqueId), rec);
    });
    refresh();

    /* Resolve each destination to a URL. An account-backed one is provisioned
       on the platform; a pasted one already has its URL in the session map.
       Provisions run in parallel because a four-destination show should not
       wait four round trips end to end. */
    const resolve = d => {
      if (d.accountId && S.accounts) {
        const attempt = attempts.get(String(d.uniqueId));
        return S.accounts.provisionIngest(d.accountId, ingestRequest(sc, d))
          .catch(error => {
            retainFailedProvision(attempt, error);
            throw error;
          })
          .then(ing => {
            if (!ing || !ing.url)
              throw new Error('the helper provisioned no ingest URL for this channel');
            return { d: d, rec:attempt, url: ing.url, watchUrl: ing.watchUrl,
                     broadcastId: ing.broadcastId, streamId: ing.streamId,
                     /* The helper's own per-field verdict travels with the
                        ingest. Read here, reported per row below — never
                        collapsed into one "applied" for the whole fan-out. */
                     info: readStreamInfoResult(ing) };
          });
      }
      /* A saved ingest travels as its id; the helper substitutes the URL. */
      if (d.endpointRef) return Promise.resolve({ d: d, endpointRef: d.endpointRef });
      const url = (sessionUrl.get(String(d.uniqueId)) || '').trim();
      if (!url) return Promise.reject(new Error('no ingest URL. Paste one on the row, or connect an account'));
      return Promise.resolve({ d: d, url: url });
    };

    group.armPromise = Promise.all(dests.map(d => resolve(d).catch(err => ({ d: d, error: err }))))
      .then(resolved => {
        if (group.cancelled) return abortResolvedPlatforms(resolved).then(() => null);
        if (screenRelay.get(groupId) !== group || dests.some(d =>
            liveDest.get(String(d.uniqueId)) !== attempts.get(String(d.uniqueId)))) {
          return abortResolvedPlatforms(resolved).then(() => {
            try { source.stop(); } catch (_) {}
            if (screenRelay.get(groupId) === group) screenRelay.delete(groupId);
            refresh(); return null;
          });
        }
        const ok = resolved.filter(r => !r.error);
        const bad = resolved.filter(r => r.error);
        /* Report the failures individually and carry on with the rest. Partial
           failure is the normal case, not the exception. */
        bad.forEach(r => {
          const cur = liveDest.get(String(r.d.uniqueId));
          const why = r.error && r.error.eligibility && r.error.eligibility.message ||
            r.error.message || String(r.error);
          if (cur) {
            cur.state = cur.provisionCleanupPending ? 'finish-failed' : 'failed';
            cur.error = why + (cur.provisionCleanupPending ? ' Setup cleanup was not confirmed. Press Retry End before trying Go again.' : '');
            cur.grouped = null;
            cur.eligibility = r.error && r.error.eligibility || null;
          }
          notify(r.d.name + ' could not be prepared: ' + why, 'error');
        });
        if (bad.some(r => r.d.accountId && r.error && r.error.eligibility))
          refreshDestCatalogue(true);
        if (!ok.length) {
          try { source.stop(); } catch (e) {}
          screenRelay.delete(groupId);
          refresh();
          return;
        }
        group.destIds = ok.map(r => String(r.d.uniqueId));
        ok.forEach(r => {
          const cur = liveDest.get(String(r.d.uniqueId));
          if (!cur) return;
          cur.watchUrl = r.watchUrl; cur.broadcastId = r.broadcastId;
          cur.streamId = r.streamId; cur.provisionedAt = r.broadcastId ? Date.now() : undefined;
          noteStreamInfo(cur, r.d, sc, r.info);
        });

        group.mediaStarted = true;
        return S.relay.start({
          source: source,
          destinations: ok.map(r => ({ id: String(r.d.uniqueId), name: r.d.name,
                                       platform: r.d.platformId, url: r.url,
                                       endpointRef: r.endpointRef })),
          onState: (state, err, session) => {
            if (screenRelay.get(groupId) !== group) return;
            if (session) group.session=session;
            /* One session state fans to every row it carries. Per-destination
               truth comes from relay.stats(), which reads ffmpeg's own
               per-slave verdict — this only carries the session-wide events. */
            const failed = state === 'failed' || (err != null && typeof err === 'object');
            const why = err == null || err === '' ? '' : (err.message || String(err));
            ok.forEach(r => {
              const cur = liveDest.get(String(r.d.uniqueId));
              if (cur !== attempts.get(String(r.d.uniqueId))) return;
              if (session) cur.session=session;
              if (cur.finalizing || cur.state === 'stopping' || cur.state === 'stop-failed') return;
              cur.state = failed ? 'failed' : state;
              cur.error = failed ? (why || 'failed') : null;
              if (state === 'live' && !cur.startedAt) cur.startedAt = Date.now();
              if (failed && !group.session) finishFailedDestination(r.d, cur,
                cur.startedAt ? 'complete' : 'abort');
            });
            if (failed) notify(sc.name + ' relay failed: ' + (why || 'no reason given'), 'error');
            else if (state === 'live')
              notify(sc.name + ' is live on ' + ok.length +
                     ' destination' + (ok.length === 1 ? '' : 's') + ' from one encode.', 'live');
            else if (state === 'stopped' && !group.stopPromise) {
              noteRelayStop(group, group.session, null, sc.name);
              group.cancelled = true;
              group.stopPromise = Promise.allSettled(ok.map(r => {
                const cur = attempts.get(String(r.d.uniqueId));
                if (!cur) return Promise.resolve();
                if (group.stopWarning) { cur.stopResult = group.stopResult; cur.stopWarning = group.stopWarning; }
                cur.state = 'stopping';
                cur.finalizing = true;
                return finishPlatformDestination(r.d, cur,
                  cur.startedAt ? 'complete' : 'abort');
              })).then(results => {
                results.forEach((result, index) => {
                  const r = ok[index];
                  const cur = attempts.get(String(r.d.uniqueId));
                  if (!cur) return;
                  cur.finalizing = false;
                  cur.session = null;
                  cur.grouped = null;
                  cur.source = null;
                  if (result.status === 'rejected') {
                    cur.state = 'finish-failed';
                    cur.error = 'Media stopped, but the platform broadcast could not be ended: ' +
                      (result.reason && result.reason.message || result.reason);
                    if (liveDest.get(String(r.d.uniqueId)) !== cur)
                      retainAttemptCleanup(cur,'finish-failed',cur.error);
                  } else if (liveDest.get(String(r.d.uniqueId)) === cur) liveDest.delete(String(r.d.uniqueId));
                });
                if (screenRelay.get(groupId) === group) screenRelay.delete(groupId);
                try { if(group.source)group.source.stop(); } catch (e) {}
                group.source=null;
                notify(sc.name + ' ended.', '');
                refresh();
              });
            }
            refresh();
          }
        }).then(async session => {
          if (!session) return null;
          group.session=session;
          if (group.cancelled && group.stopPromise && screenRelay.get(groupId) === group) return session;
          if (group.cancelled || screenRelay.get(groupId) !== group) {
            try {
              const result = await S.relay.stop(session);
              noteRelayStop(group, session, result, sc.name);
            }
            catch (error) {
              retainGroupMediaCleanup(groupId, group, attempts, ok.map(r=>r.d));return null;
            }
            return Promise.allSettled(ok.map(r => {
              const cur = attempts.get(String(r.d.uniqueId)) || {
                broadcastId: r.broadcastId, streamId: r.streamId
              };
              if (group.stopWarning) { cur.stopResult = group.stopResult; cur.stopWarning = group.stopWarning; }
              return finishPlatformDestination(r.d, cur,
                cur.startedAt ? 'complete' : 'abort').catch(error => {
                  cur.session=null;cur.source=null;
                  retainAttemptCleanup(cur,'finish-failed','The previous platform output has not confirmed End: '+(error.message||error));
                });
            })).then(() => { try { if(group.source)group.source.stop(); } catch (_) {} group.source=null;return null; });
          }
          group.session = session;
          ok.forEach(r => {
            const cur = liveDest.get(String(r.d.uniqueId));
            if (cur === attempts.get(String(r.d.uniqueId))) { cur.session = session; cur.source = source; }
          });
          watchRelayStalls();
          refresh();
          return session;
        });
      })
      .catch(err => {
        if (err?.session) group.session=err.session;
        if (screenRelay.get(groupId) !== group) {
          if (group.session) retainGroupMediaCleanup(groupId, group, attempts, dests);
          else try { source.stop(); } catch (_) {}
          return;
        }
        if (!group.session) try { source.stop(); } catch (e) {}
        dests.forEach(d => {
          const cur = liveDest.get(String(d.uniqueId));
          if (cur === attempts.get(String(d.uniqueId))) {
            if (group.session) cur.session=group.session;
            if (cur.finalizing || group.stopPromise || cur.state === 'stop-failed') return;
            cur.state = 'failed'; cur.error = err && err.message || String(err);
            if (!group.session) finishFailedDestination(d, cur,
              cur.startedAt ? 'complete' : 'abort');
          }
        });
        if (!group.session) screenRelay.delete(groupId);
        notify(sc.name + ' could not go live: ' + (err && err.message || err), 'error');
        refresh();
      });
  }

  function showObsSetup(dest) {
    const steps = 'OBS setup: Studio Programme\n\n' +
      '1. In Broadcast, check that Studio Programme shows the picture you want to send. ' +
      'Open Programme projector > Open windowed projector.\n' +
      '2. In OBS, add Sources > + > Window Capture and select "SHOWAVE Broadcast: Programme projector". ' +
      'Capture the picture only, disable cursor capture, and verify the moving preview.\n' +
      '3. The projector is video only. Configure your mixer/interface or audio output as a separate ' +
      'OBS audio source. Capture each audio feed once to avoid echo; check levels and sync with a test recording.\n' +
      '4. Set the destination and stream details in OBS; start and stop publishing there. ' +
      'Keep Broadcast and the projector window open.\n\n' +
      'This captures Studio Programme, not this Map screen\'s transformed output. ' +
      'SHOWAVE has no independent OBS Browser Source feed and cannot verify OBS capture or publishing. ' +
      'Opening this guide starts no stream.';
    notify((dest.name || 'OBS') + ':\n' + steps, 'help');
    const done = copied => notify(copied
      ? 'OBS setup steps copied. Complete the setup and verify picture and audio in OBS before publishing.'
      : 'OBS setup steps could not be copied. They remain in Output messages.',
      copied ? '' : 'warn');
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function')
        Promise.resolve(navigator.clipboard.writeText(steps)).then(() => done(true), () => done(false));
      else done(false);
    } catch (_) { done(false); }
  }

  function armDest(sc, dest) {
    if (liveDest.has(String(dest.uniqueId))) {
      notify((dest.name || 'Destination') + ': end or clear the previous attempt before starting again.', 'warn');
      return;
    }
    if (ST.flags.outputOff) {
      notify('All output is disabled. Clear Disable Output before opening a destination.', 'warn');
      return;
    }
    const S = hostStream();
    const cap = routeCapability(dest);
    if ((!S && !cap.handoff) || !cap.ok) {
      notify((dest.name || 'Destination') + ': ' + (cap.why || 'Streaming is not available.'), 'error');
      return;
    }
    /* Keep setup outside liveDest. Clipboard success proves only that the
       instructions were copied, never that OBS received or published media. */
    if (cap.handoff) {
      showObsSetup(dest);
      return;
    }
    let url = '', token = '';
    if (dest.transport === 'ST_ENDPOINT') {
      /* Session-only. Deliberately not remembered — see the comment above. */
      url = (window.prompt('WHIP ingest URL for "' + dest.name + '"\n\n' +
        'Held for this session only. It is never written to the output document, ' +
        'which is exported and mailed.', '') || '').trim();
      if (!url) return;
      token = (window.prompt('Bearer token, if your ingest issues one. Leave empty if the key is in the URL.', '') || '').trim();
    }
    /* "Connect an account" is not a destination you can go live on yet — it is
       the step BEFORE that. Running the consent flow here, rather than failing
       with "no transport", is what makes the row mean what it says. */
    /* A destination can no longer BE a "connect" row - connecting moved to the
       section's "+ Add Channel" button, because it is an account-level act and
       not a per-Broadcast routing choice. A saved document from before that
       split can still carry one, so route it to the same place rather than
       failing with a confusing "no transport". */
    if (String(dest.serviceKey || '').startsWith('connect:')) {
      const provider = String(dest.serviceKey).slice('connect:'.length);
      const target = (destCat && destCat.destinations || [])
        .find(x => x.kind === 'connect' && x.provider === provider);
      if (target) connectChannel(target, sc);
      else notify('That platform can no longer be connected from a destination row. ' +
                  'Use "+ Add Channel" above.', 'warn');
      return;
    }

    /* A connected channel needs no prompt at all. This is the whole point of
       the accounts tier: SHOWAVE creates the broadcast and reads back the
       ingest, and the key exists only in the value handed to the relay. */
    if (dest.accountId && dest.transport === 'ST_HELPER_RTMP') {
      const entry0 = { source: null, session: null, state: 'connecting', error: null,
        cancelled: false, finalized: false, finalizing: false, destination: Object.assign({}, dest) };
      liveDest.set(String(dest.uniqueId), entry0);
      refresh();
      let src0;
      try {
        src0 = S.sources.fromScreen(String(sc.uniqueId), {
          fps: Math.round(pnum(sc, ['Framerate'], 30)) || 30, audio: true });
      } catch (e) {
        liveDest.set(String(dest.uniqueId), { state: 'failed', error: e.message });
        notify(dest.name + ' could not start: ' + e.message, 'error'); refresh(); return;
      }
      entry0.source = src0;
      /* Title / Description / Category travel WITH the provision, because that
         is the only call that reaches the platform. The helper applies what the
         platform accepts and reports the rest per field; this panel reports what
         it is told and invents nothing when it is told nothing. */
      entry0.startPromise = S.accounts.provisionIngest(dest.accountId, ingestRequest(sc, dest))
        .then(ing => {
          noteStreamInfo(entry0, dest, sc, readStreamInfoResult(ing));
          entry0.watchUrl = ing.watchUrl || null;
          entry0.broadcastId = ing.broadcastId || null;
          entry0.streamId = ing.streamId || null;
          entry0.provisionedAt = ing.broadcastId ? Date.now() : null;
          if (!ing.url) throw new Error('the helper provisioned no ingest URL for this channel');
          if (entry0.cancelled || liveDest.get(String(dest.uniqueId)) !== entry0) {
            return finishPlatformDestination(dest, entry0, 'abort')
              .catch(error => notify(dest.name + ': cancelled setup could not be removed from the platform: ' +
                (error && error.message || error), 'error'))
              .then(() => null);
          }
          return S.relay.start({
            source: src0,
            destinations: [{ id: String(dest.uniqueId), name: dest.name,
                             platform: dest.platformId, url: ing.url }],
            onState: (state, err, session) => {
              const cur = liveDest.get(String(dest.uniqueId));
              if (cur !== entry0) return;
              if (session) cur.session=session;
              if (cur.finalizing || cur.state === 'stopping' || cur.state === 'stop-failed') return;
              const failed = state === 'failed' || (err != null && typeof err === 'object');
              const why = err == null || err === '' ? '' : (err.message || String(err));
              cur.state = failed ? 'failed' : state;
              cur.error = failed ? (why || 'failed') : null;
              if (state === 'live' && !cur.startedAt) cur.startedAt = Date.now();
              if (failed) {
                notify(dest.name + ' failed: ' + (why || 'no reason given'), 'error');
                if (!cur.session) finishFailedDestination(dest, cur, cur.startedAt ? 'complete' : 'abort');
              }
              else if (state === 'live') notify(dest.name + ' is live.', 'live');
              if (state === 'stopped' && !cur.finalizing) {
                noteRelayStop(cur, cur.session, null, dest.name);
                cur.state = 'stopping';
                cur.finalizing = true;
                finishPlatformDestination(dest, cur,
                  cur.startedAt ? 'complete' : 'abort')
                  .then(() => {
                    if (liveDest.get(String(dest.uniqueId)) === cur) liveDest.delete(String(dest.uniqueId));
                    try { if (cur.source && cur.source.stop) cur.source.stop(); } catch (e) {}
                    notify(dest.name + ' ended.', ''); refresh();
                  })
                  .catch(error => {
                    cur.finalizing = false;
                    cur.session = null;
                    try { if(cur.source)cur.source.stop(); } catch (_) {}
                    cur.source = null;
                    cur.state = 'finish-failed';
                    cur.error = 'Media stopped, but the platform broadcast could not be ended: ' +
                      (error && error.message || error);
                    if (liveDest.get(String(dest.uniqueId)) !== cur)
                      retainAttemptCleanup(cur,'finish-failed',cur.error);
                    notify(dest.name + ': ' + cur.error, 'error'); refresh();
                  });
              }
              refresh();
            }
          }).then(async session => {
            if (!session) return null;
            if (entry0.cancelled && entry0.stopPromise && liveDest.get(String(dest.uniqueId)) === entry0) {
              entry0.session=session;return session;
            }
            if (entry0.cancelled || liveDest.get(String(dest.uniqueId)) !== entry0) {
              try {
                const result = await S.relay.stop(session);
                noteRelayStop(entry0, session, result, dest.name);
              }
              catch (error) { retainMediaCleanup(entry0,session,src0);return null; }
              try {
                await finishPlatformDestination(dest, entry0,
                  entry0.startedAt ? 'complete' : 'abort');
              } catch (error) {
                entry0.session=null;entry0.source=null;
                retainAttemptCleanup(entry0,'finish-failed','The previous platform output has not confirmed End: '+(error.message||error));
              }
              try { if (src0 && src0.stop) src0.stop(); } catch (e) {}
              return null;
            }
            entry0.session = session;
            refresh();
            return session;
          });
        })
        .catch(err => {
          retainFailedProvision(entry0, err);
          if (err?.session) entry0.session=err.session;
          if (liveDest.get(String(dest.uniqueId)) !== entry0) {
            if(entry0.session)retainMediaCleanup(entry0,entry0.session,src0);
            else try{src0.stop();}catch(_){}
            return;
          }
          if (entry0.cancelled || entry0.finalizing || entry0.state === 'stop-failed') return;
          const cur = liveDest.get(String(dest.uniqueId));
          const why = err && err.eligibility && err.eligibility.message ||
            err && err.message || String(err);
          if (cur) {
            cur.state = cur.provisionCleanupPending ? 'finish-failed' : 'failed';
            cur.error = why + (cur.provisionCleanupPending ? ' Setup cleanup was not confirmed. Press Retry End before trying Go again.' : '');
            cur.eligibility = err && err.eligibility || null;
            if (!cur.provisionCleanupPending && !cur.session) finishFailedDestination(dest, cur, cur.startedAt ? 'complete' : 'abort');
          }
          if (!entry0.session) try { src0.stop(); } catch (e) {}
          if (err && err.eligibility) refreshDestCatalogue(true);
          notify(dest.name + ' could not go live: ' + why, 'error');
          refresh();
        });
      return;
    }

    /* A destination cannot join a session that is already running: ffmpeg fixes
       its tee slave list when it spawns (openlive-relay.py _tee_spec). Say so,
       rather than quietly opening a second encode for this one row — which
       would be N encodes again, the exact thing the grouped path just fixed. */
    if (dest.transport === 'ST_HELPER_RTMP' && screenRelay.has(String(sc.uniqueId))) {
      notify(dest.name + ' cannot join the relay session already running on ' + sc.name +
             '. ffmpeg fixes its destination list when it starts, so this row would need a ' +
             'second encode. Stop that session and Go Live again to include it.', 'warn');
      return;
    }

    if (dest.transport === 'ST_HELPER_RTMP') {
      /* Taken from the row's own field, not a prompt. window.prompt() is a
         blocking dialog that froze this window during testing and that some
         hosts suppress outright - a poor thing to stand between an operator
         and going live. Session-only for the same reason as WHIP: for every
         platform in PLATFORM-INTEGRATION-CONTRACT.md the stream key is IN this
         URL, and the output document is exported and mailed. Once an account is
         connected this branch is skipped and the ingest is provisioned. */
      if (dest.endpointRef) {
        /* Saved ingest: only the id travels, the helper resolves it at start.
           A ref the helper no longer holds fails at start with the helper's
           own per-destination refusal naming this row, not silently. */
        url = '';
        /* A per-show key that is not from today will fail at the platform's
           ingest, which arrives as an opaque ffmpeg error. Say the likely
           cause NOW, from the catalogue's keyModel and the store's addedAt —
           and still go, because the stored key may be today's. */
        const cr = catalogueRowFor(dest);
        const ep = endpointRow(dest.endpointRef);
        if (cr && cr.keyModel === 'per-broadcast' &&
            ep && ep.addedAt && (Date.now() / 1000 - ep.addedAt) > 6 * 3600) {
          notify(dest.name + ': the saved key was pasted ' + agoText(ep.addedAt) + ' and ' +
                 cr.platform + ' hands out a new one each show. Going anyway; if it is refused, ' +
                 'Replace it with today\'s.', 'warn');
        }
      } else {
        url = (sessionUrl.get(String(dest.uniqueId)) || '').trim();
        if (!url) {
          notify(dest.name + ': paste the ingest URL with its stream key in the field above, '
                 + 'then press Go.', 'warn');
          return;
        }
        if (!/^rtmps?:\/\//i.test(url)) {
          notify(dest.name + ': the relay carries rtmp:// and rtmps:// only. That URL is neither.', 'error');
          return;
        }
      }
    }
    let source;
    try {
      source = S.sources.fromScreen(String(sc.uniqueId), {
        fps: Math.round(pnum(sc, ['Framerate'], 30)) || 30, audio: true
      });
    } catch (e) {
      liveDest.set(String(dest.uniqueId), { state: 'failed', error: e.message });
      notify(dest.name + ' could not start: ' + e.message, 'error');
      refresh(); return;
    }
    const entry = { source: source, session: null, state: 'connecting', error: null,
      cancelled: false, finalized: false, finalizing: false, destination:Object.assign({},dest) };
    liveDest.set(String(dest.uniqueId), entry);
    refresh();
    const onState = (state, err, session) => {
      const cur = liveDest.get(String(dest.uniqueId));
      if (cur !== entry) return;
      if (session) cur.session=session;
      if (cur.finalizing || cur.state === 'stopping' || cur.state === 'stop-failed') return;
      /* The two transports disagree about what an error IS: the recorder and
         WHIP emit Error objects, the relay emits a reason STRING (its helper
         sends {state, reason} over the ingest socket). Reading .message
         unconditionally turned every relay failure into "failed: undefined",
         throwing away the exact sentence the helper works to produce —
         "every destination dropped, so the session ended: ...". Normalise. */
      const why = err && err.message ? err.message : (err ? String(err) : '');
      const failed = state === 'failed' || (err != null && typeof err === 'object');
      cur.state = failed ? 'failed' : state;
      cur.error = failed ? (why || 'failed') : null;
      if (state === 'live' && !cur.startedAt) cur.startedAt = Date.now();
      if (failed) {
        /* On a saved persistent key, the one thing worth adding to ffmpeg's
           verdict is the platform's own list of what invalidates a key. */
        const cr = dest.endpointRef ? catalogueRowFor(dest) : null;
        const hint = cr && cr.keyModel === 'persistent' && cr.keyNote
          ? ' If the platform rejected the key, Forget and re-paste it. ' + cr.keyNote : '';
        notify(dest.name + ' failed: ' + why + hint, 'error');
      }
      else if (state === 'live') notify(dest.name + ' is live.', 'live');
      else if (state === 'reconnecting') notify(dest.name + ' dropped; reconnecting.', 'warn');
      else if (state === 'stopped') {
        noteRelayStop(cur, cur.session, null, dest.name);
        notify(dest.name + ' stopped.', '');
      }
      if (state === 'stopped' && !cur.finalizing) {
        liveDest.delete(String(dest.uniqueId));
        try { if (cur.source && cur.source.stop) cur.source.stop(); } catch (e) {}
      }
      refresh();
    };
    /* Route by transport EXPLICITLY. This was a two-branch ternary whose else
       arm was the file recorder, so any transport that ever became capable
       would silently record to disk while the row reported "live" — the exact
       failure CLAUDE.md forbids. Anything unrouted now refuses out loud. */
    let started;
    try {
    if (dest.transport === 'ST_ENDPOINT') {
      started = S.whip.start({ url: url, token: token, source: source, onState: onState });
    } else if (dest.transport === 'ST_HELPER_RTMP') {
      /* One destination per session here because this is the single-row Go.
         The relay's real shape is one session carrying MANY destinations —
         that is what makes the twentieth destination cost a socket rather than
         another encode — and it is what the Go Live / arm-all path uses. */
      started = S.relay.start({
        source: source,
        destinations: [{ id: String(dest.uniqueId), name: dest.name,
                         url: url || undefined, endpointRef: dest.endpointRef || undefined }],
        onState: onState
      });
    } else if (dest.transport === 'ST_FILE') {
      started = S.recorder.start({ source: source, onState: onState });
    } else {
      try { source.stop(); } catch (e) {}
      liveDest.delete(String(dest.uniqueId));
      notify(dest.name + ': no transport in this build opens that destination.', 'error');
      refresh();
      return;
    }
    } catch (error) { started = Promise.reject(error); }
    entry.startPromise = Promise.resolve(started).then(async session => {
      if (!session) return null;
      if (entry.cancelled && entry.stopPromise && liveDest.get(String(dest.uniqueId)) === entry) {
        entry.session=session;return session;
      }
      if (entry.cancelled || liveDest.get(String(dest.uniqueId)) !== entry) {
        try {
          if (session.kind === 'relay' && S?.relay?.stop) {
            const result = await S.relay.stop(session);
            noteRelayStop(entry, session, result, dest.name);
          }
          else if (session.recorder && !session.pc && S && S.recorder)
            await Promise.resolve(S.recorder.stop(session));
          else if (session.stop) await Promise.resolve(session.stop());
          else throw new Error('This output has no available stop control.');
        } catch (error) { retainMediaCleanup(entry,session,source);return null; }
        try { if (source && source.stop) source.stop(); } catch (e) {}
        return null;
      }
      const cur = liveDest.get(String(dest.uniqueId));
      if (cur) { cur.session = session; if (cur.state === 'connecting' && dest.transport === 'ST_FILE') cur.state = 'live'; }
      if (session && session.kind === 'relay') watchRelayStalls();
      refresh();
    }).catch(err => {
      if (err?.session) entry.session=err.session;
      if (liveDest.get(String(dest.uniqueId)) !== entry) {
        if(entry.session)retainMediaCleanup(entry,entry.session,source);
        else try{source.stop();}catch(_){}
        return;
      }
      if (entry.cancelled || entry.finalizing || entry.state === 'stop-failed') return;
      const cur = liveDest.get(String(dest.uniqueId));
      if (cur) { cur.state = 'failed'; cur.error = (err && err.message) || String(err || ""); }
      if (!entry.session) try { source.stop(); } catch (e) {}
      refresh();
    });
  }

  /* OPENLIVE EXTENSION — a Broadcast, the streaming peer of a Lumiverse.
     streaming.htm: "It's not possible to directly stream from Resolume", so
     there is no Arena panel to match and every section carries the badge.

     The raster, the Feeds, input selection, output transformation, save and
     load are real, and so is egress: a destination on a transport this build
     carries (WHIP, local file) opens a real session from here. OBS shows setup
     guidance for an external publisher; it is never a SHOWAVE media session.
     The two helper transports are inert and say which kind of "off" they are —
     the distinction inert() was written for. They are NOT hidden: a control that
     will exist should be visible and explain itself, as the DMX Output stage
     does. Nothing in this section may describe the feature as unbuilt; that was
     true when it was written and stopped being true, and a panel narrating its
     own half-builtness reads exactly as badly as one overclaiming. */
  // Destination connection ownership
  // A row may be repurposed while the helper is saving a key. Neither a late
  // success nor a late failure may attach that old key to the new service.
  const destinationConnectionRevisions = new WeakMap();
  function destinationServiceKey(dest) {
    return dest.serviceKey || (DIRECT_ROWS.some(x => x.key === dest.transport) ? dest.transport
      : dest.transport === 'ST_ENDPOINT' ? 'plat:' + (dest.platformId == null ? 81 : dest.platformId)
      : dest.transport === 'ST_HELPER_RTMP' ? 'plat:' + (dest.platformId == null ? 29 : dest.platformId)
      : 'ST_DISABLED');
  }
  function destinationConnectionScope(sc, dest) {
    return screenById(sc.uniqueId) === sc && (sc.destinations || []).includes(dest);
  }
  function destinationConnectionLock(sc, dest) {
    if (!destinationConnectionScope(sc, dest) || curScreen() !== sc)
      return 'This destination view is stale. Reopen the current Broadcast.';
    if (activeEgressCount() > 0 || liveDest.has(String(dest.uniqueId)))
      return 'Stop and clear the previous output attempt before changing its connection.';
    if (applyNowRunning > 0)
      return 'Wait for the stream details update to finish before changing this connection.';
    return '';
  }
  function invalidateDestinationConnection(dest) {
    const revision = (destinationConnectionRevisions.get(dest) || 0) + 1;
    destinationConnectionRevisions.set(dest, revision);
    return revision;
  }
  function destinationConnectionIdentity(dest) {
    return JSON.stringify([dest.uniqueId, dest.serviceKey, dest.transport, dest.platformId,
      dest.provider, dest.accountId, dest.channelId, dest.endpointRef]);
  }
  function beginDestinationConnectionEdit(sc, dest) {
    return { sc, dest, revision: invalidateDestinationConnection(dest),
      identity: destinationConnectionIdentity(dest) };
  }
  function destinationConnectionEditCurrent(edit) {
    return destinationConnectionScope(edit.sc, edit.dest) &&
      destinationConnectionRevisions.get(edit.dest) === edit.revision &&
      destinationConnectionIdentity(edit.dest) === edit.identity &&
      activeEgressCount() === 0 && applyNowRunning === 0 &&
      !liveDest.has(String(edit.dest.uniqueId));
  }
  function changeDestinationService(sc, dest, key) {
    const locked = destinationConnectionLock(sc, dest);
    if (locked) { notify(locked, 'warn'); return false; }
    if (key === destinationServiceKey(dest)) return true;
    if (dest.accountId && connectedRowFor(dest)) {
      notify('Connected channels keep their own destination rows. Add a separate custom output instead.', 'warn');
      return false;
    }
    let chosen = DIRECT_ROWS.find(x => x.key === key);
    if (!chosen && /^plat:[^:]+$/.test(String(key))) {
      const workflows = window.OpenLivePlatformWorkflows;
      const resolved = workflows && workflows.resolve(destCat && destCat.destinations, key.slice(5), 'key');
      if (resolved && (resolved.kind === 'key' || resolved.kind === 'whip')) chosen = resolved.target;
    }
    if (!chosen || !chosen.transport) {
      notify('This service is unavailable. Review its current workflow under + Add Channel.', 'warn');
      return false;
    }
    const oldKey = destinationServiceKey(dest);
    const previous = DIRECT_ROWS.find(x => x.key === oldKey) ||
      (destCat && destCat.destinations || []).find(x =>
        (x.kind === 'key' || x.kind === 'whip') && 'plat:' + x.platformId === oldKey);
    const defaultName = !dest.name || /^Destination \d+$/.test(dest.name) ||
      (previous && [previous.displayName, previous.label].includes(dest.name));
    push('set destination service');
    invalidateDestinationConnection(dest);
    // Detach only this row. The encrypted store entry may be used by other shows.
    dest.endpointRef = '';
    sessionUrl.delete(String(dest.uniqueId));
    dest.provider = null;
    dest.accountId = null;
    dest.channelId = null;
    pdrop(sc, catParam(dest));
    applyNow.delete(String(dest.uniqueId));
    dest.serviceKey = key;
    dest.transport = chosen.transport;
    dest.platformId = chosen.platformId == null ? null : chosen.platformId;
    dest.enabled = false;
    if (defaultName) dest.name = chosen.displayName || chosen.label;
    notify('Destination changed and left Off. Its previous connection was detached; shared saved ingests were kept.', '');
    return true;
  }
  async function saveDestinationIngest(sc, dest, value) {
    const locked = destinationConnectionLock(sc, dest);
    if (locked) { notify(locked, 'warn'); return false; }
    if (dest.accountId || dest.transport !== 'ST_HELPER_RTMP') return false;
    const edit = beginDestinationConnectionEdit(sc, dest);
    const v = String(value || '').trim();
    if (v && !/^rtmps?:\/\//i.test(v)) {
      notify(dest.name + ': the relay carries rtmp:// and rtmps:// only. That is neither.', 'error');
      return false;
    }
    if (!v) { sessionUrl.delete(String(dest.uniqueId)); refresh(); return true; }
    const S = hostStream();
    const sessionOnly = message => {
      if (!destinationConnectionEditCurrent(edit)) return false;
      // Go prioritises a saved reference over a session URL. A missing imported
      // reference must not shadow the replacement the user has just provided.
      if (dest.endpointRef) { push('replace missing ingest'); dest.endpointRef = ''; }
      sessionUrl.set(String(dest.uniqueId), v);
      notify(dest.name + ': ' + message + ' Held for this session only.', 'warn');
      refresh(); return true;
    };
    if (!S || !S.endpoints) return sessionOnly('The streaming module is not reachable to save it.');
    let rec;
    try {
      rec = await S.endpoints.add(v, dest.platformId, dest.name);
      if (!rec || !rec.id) throw new Error('Invalid saved ingest response');
    } catch (_) {
      // Error strings from the helper may contain the credential-bearing URL.
      return sessionOnly('Could not save the ingest on this machine.');
    }
    if (!destinationConnectionEditCurrent(edit)) return false;
    push('save ingest');
    dest.endpointRef = rec.id;
    sessionUrl.delete(String(dest.uniqueId));
    endpointRows = (endpointRows || []).filter(r => r.id !== rec.id).concat([rec]);
    notify(dest.name + ': ingest saved on this machine. Its lifetime is controlled by the platform.', '');
    refresh(); return true;
  }

  // Saved-ingest directory ownership
  const savedIngestForgetPending = new Set();
  function savedIngestForgetLock(sc, ep, identity) {
    if (sc.uniqueId !== identity.screenId || screenById(identity.screenId) !== sc || curScreen() !== sc)
      return 'This saved-ingest view is stale. Reopen the current Broadcast.';
    if (!identity.endpointId || ep.id !== identity.endpointId || endpointRow(identity.endpointId) !== ep)
      return 'This saved ingest changed. Reopen the current connection list.';
    if (savedIngestForgetPending.has(identity.endpointId))
      return 'This saved ingest is already being deleted.';
    if (activeEgressCount() > 0)
      return 'Stop active outputs before deleting a shared saved ingest.';
    for (const [destId, rec] of liveDest) {
      const found = destinationRecord(destId);
      // Old attempts may outlive their document row. Without that identity,
      // do not guess which shared credential an unresolved attempt still uses.
      if (!found || String(found.dest.endpointRef || '') === String(identity.endpointId) ||
          String(rec && rec.endpointRef || '') === String(identity.endpointId))
        return 'Clear the previous output attempt before deleting this saved ingest.';
    }
    if (applyNowRunning > 0)
      return 'Wait for the stream details update to finish before deleting a saved ingest.';
    const S = hostStream();
    if (!S || !S.endpoints || typeof S.endpoints.remove !== 'function')
      return 'The streaming helper is not available to delete this saved ingest.';
    return '';
  }
  async function forgetSavedIngest(sc, ep, identity) {
    const locked = savedIngestForgetLock(sc, ep, identity);
    if (locked) { notify(locked, 'warn'); refresh(); return false; }
    const endpointId = identity.endpointId;
    const S = hostStream();
    savedIngestForgetPending.add(endpointId);
    // An explicit global deletion invalidates earlier saves belonging to any
    // destination that still references this shared credential.
    for (const screen of screens()) {
      for (const dest of (screen.destinations || [])) {
        if (String(dest.endpointRef || '') === String(endpointId))
          invalidateDestinationConnection(dest);
      }
    }
    refresh();
    try {
      await S.endpoints.remove(endpointId);
      // This is a store-level operation: completion updates the same captured
      // id even if the operator has since navigated to another Broadcast.
      endpointRows = (endpointRows || []).filter(row => row.id !== endpointId);
      notify('Saved ingest deleted from this machine for every Broadcast. Destinations using it must reconnect.', '');
      return true;
    } catch (_) {
      // Helper errors can contain secret-bearing URLs; keep them out of UI.
      notify('Could not delete this saved ingest. It remains listed; retry when the helper is available.', 'error');
      return false;
    } finally {
      savedIngestForgetPending.delete(endpointId);
      refresh();
    }
  }
  // End saved-ingest directory ownership

  /* Selecting a destination is not connecting an account or starting media.
     Existing account routes are reused; explicit local outputs begin Off. */
  function destinationPickerSection(parent, sc) {
    const line = row(parent, '');
    const open = mk('button', 'ao-btn', line,
      ST.addDestinationOpen ? 'Close destinations' : '+ Add Destination');
    open.type = 'button';
    open.setAttribute('aria-expanded', String(!!ST.addDestinationOpen));
    open.title = 'Choose a connected channel, a local output, or a streaming platform.';
    open.addEventListener('click', () => {
      ST.addDestinationOpen = !ST.addDestinationOpen;
      refresh();
    });
    if (!ST.addDestinationOpen) return;
    const panel = mk('div', 'oo-platform-picker oo-destination-picker', parent);
    note(panel, 'Choose a destination before adding it. Enabling a channel selects it for Go Live; ' +
      'it does not start streaming. New local outputs are added Off.');
    const label = mk('label', '', panel, 'Destination');
    const select = mk('select', '', label);
    select.setAttribute('aria-label', 'Destination to add');
    const placeholder = mk('option', '', select, 'Choose a destination…');
    placeholder.value = '';
    const items = [];
    const channels = mk('optgroup', '', select);
    channels.label = 'Your connected channels';
    (sc.destinations || []).filter(dest => dest.accountId).forEach(dest => {
      const key = 'channel:' + String(dest.uniqueId);
      const name = dest.name && !/^(undefined|null)$/i.test(String(dest.name).trim())
        ? String(dest.name) : 'Connected channel';
      items.push({ key, kind: 'channel', id: String(dest.uniqueId),
        accountId: String(dest.accountId), channelId: String(dest.channelId || ''), label: name });
      const cap = routeCapability(dest);
      const state = !cap.ok ? (cap.pending ? ': Checking…' : ': Unavailable')
        : dest.enabled ? ': On' : ': Off';
      const option = mk('option', '', channels, esc(name + state));
      option.value = key;
    });
    if (!items.length) {
      const empty = mk('option', '', channels, 'No connected channels. Choose a platform below');
      empty.value = 'no-channels'; empty.disabled = true;
    }
    const local = mk('optgroup', '', select);
    local.label = 'Local outputs';
    DIRECT_ROWS.filter(item => ['ST_FILE', 'ST_OBS'].includes(item.key)).forEach(item => {
      items.push({ ...item, kind: 'direct' });
      const option = mk('option', '', local, esc(item.label));
      option.value = item.key;
    });
    const platforms = mk('option', '', select, 'Browse streaming platforms…');
    platforms.value = 'platforms';
    items.push({ key: 'platforms', kind: 'platforms' });
    select.value = items.some(item => item.key === ST.destinationChoice) ? ST.destinationChoice : '';
    const detail = mk('p', 'oo-platform-status', panel);
    detail.setAttribute('role', 'status');
    const action = mk('button', 'ao-btn', panel, 'Choose destination');
    action.type = 'button';
    let committed = false;
    const chosen = () => items.find(item => item.key === select.value);
    // Snapshot identities, not mutable object references: an imported/replaced
    // row must not make an old click enable a different account or channel.
    const currentChannel = item => (sc.destinations || []).find(dest =>
      String(dest.uniqueId) === item.id && String(dest.accountId || '') === item.accountId &&
      String(dest.channelId || '') === item.channelId);
    function paint() {
      const item = chosen();
      const locked = activeEgressCount() > 0;
      action.disabled = true;
      action.textContent = 'Choose destination';
      detail.textContent = 'No destination is added until you confirm a choice.';
      if (item && item.kind === 'channel') {
        const dest = currentChannel(item);
        const cap = dest ? routeCapability(dest) : { ok: false, why: 'This channel is no longer available.' };
        action.textContent = !cap.ok ? 'Unavailable' : dest.enabled ? 'Already included' : 'Enable channel';
        action.disabled = locked || !cap.ok || !!dest.enabled;
        detail.textContent = !cap.ok ? cap.why : dest.enabled
          ? 'This channel already has an On destination. No duplicate will be added.'
          : 'Use the existing channel destination and turn it On for this Broadcast.';
      } else if (item && item.kind === 'direct') {
        const cap = destCapability(item.transport);
        action.textContent = cap.ok ? 'Add output' : 'Unavailable';
        action.disabled = locked || !cap.ok;
        detail.textContent = cap.ok ? item.note + ' Will be added Off; Go is a separate action.' : cap.why;
      } else if (item) {
        action.textContent = 'Choose platform';
        action.disabled = locked;
        detail.textContent = 'Read the platform workflow, then connect an account or add its manual output.';
      }
      if (locked) detail.textContent = 'Stop active outputs before changing destinations.';
    }
    select.addEventListener('change', () => { ST.destinationChoice = select.value; paint(); });
    action.addEventListener('click', () => {
      if (committed || action.disabled) return;
      const item = chosen();
      if (!item || activeEgressCount() > 0) { paint(); return; }
      if (screenById(sc.uniqueId) !== sc || curScreen() !== sc) {
        notify('This Broadcast changed. Choose a destination on the current Broadcast again.', 'warn');
        refresh(); return;
      }
      if (item.kind === 'platforms') {
        committed = true;
        ST.addChannelOpen = true;
        ST.addDestinationOpen = false;
        refresh(); return;
      }
      if (item.kind === 'channel') {
        const dest = currentChannel(item);
        const cap = dest ? routeCapability(dest) : { ok: false, why: 'This channel is no longer available.' };
        if (!cap.ok || dest.enabled) {
          notify(cap.ok ? 'This channel is already included.' : cap.why, 'warn');
          refresh(); return;
        }
        committed = true;
        push('enable channel destination');
        dest.enabled = true;
      } else {
        const cap = destCapability(item.transport);
        if (!cap.ok) { notify(cap.why, 'warn'); refresh(); return; }
        committed = true;
        push('add destination');
        sc.addDestination({ name: item.label, enabled: false, transport: item.transport,
          serviceKey: item.key, platformId: null, accountId: null, channelId: null });
      }
      ST.addDestinationOpen = false;
      refresh();
    });
    paint();
  }

  function platformPickerSection(parent, sc, cat) {
    const line = row(parent, '');
    const button = mk('button', 'ao-btn', line, ST.addChannelOpen ? 'Close platforms' : '+ Add Channel');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(!!ST.addChannelOpen));
    button.title = 'Browse account login, manual output and unavailable platform workflows.';
    button.addEventListener('click', () => {
      ST.addChannelOpen = !ST.addChannelOpen;
      refresh();
    });
    if (!ST.addChannelOpen) return;
    const picker = window.OpenLiveMapPlatformPicker;
    if (!picker) { note(parent, 'Platform picker could not be loaded. Reload SHOWAVE Map.'); return; }
    note(parent, 'Sign-in requires your approval on the platform. Reading a guide does not connect ' +
      'an account or start a stream.');
    picker.mount(parent, {
      rows: cat, selectedId: ST.platformWorkflowId, locked: activeEgressCount() > 0,
      onSelect: id => { ST.platformWorkflowId = id; },
      onConnect: target => {
        // The helper may have refreshed while the operator was reading a guide.
        const resolved = window.OpenLivePlatformWorkflows.resolve(
          (destCat && destCat.destinations) || [], target.platformId);
        const current = resolved.target;
        if (resolved.kind !== 'account' || !current || current.kind !== 'connect' ||
            current.provider !== target.provider || !current.ready || activeEgressCount() > 0) {
          notify('This connection is no longer ready. Stop active outputs and check its current status.', 'warn');
          refresh(); return;
        }
        connectChannel(current, sc);
      },
      onCustom: target => {
        const workflows = window.OpenLivePlatformWorkflows;
        const current = workflows.resolve((destCat && destCat.destinations) || [], target.platformId, 'key');
        if (!['key', 'whip'].includes(current.kind) || activeEgressCount() > 0) {
          notify('This custom output is no longer available. Check its current status.', 'warn');
          refresh(); return;
        }
        push('add platform custom output');
        sc.addDestination({ name: current.label, enabled: false,
          platformId: current.target.platformId, serviceKey: 'plat:' + current.target.platformId,
          transport: current.target.transport || (current.kind === 'whip' ? 'ST_ENDPOINT' : 'ST_HELPER_RTMP') });
        ST.addChannelOpen = false;
        notify(current.label + ' custom output added Off. Configure its connection before Go.', '');
        refresh();
      }
    });
  }

  function broadcastSection(sc) {
    const s = sec('Broadcast', true);
    txtRow(s, 'Name', () => sc.name || '', v => { sc.name = v; refreshTree(); });

    /* The device row exists so the Broadcast states what it is, but it is the
       only kind offered here — deviceInstances() filters `streamOnly` to
       StreamScreens and everything else out — so it is a readout, not a choice. */
    roRow(s, 'Device', devType(sc).label);

    /* Width/Height ARE the encode resolution. This is the concrete difference
       from a Lumiverse, whose device is sizeless because a fixture samples
       single pixels; an encoder needs a frame. */
    numRow(s, 'Width', () => devSize(sc).width, v => setDev(sc, v, devSize(sc).height), 8);
    numRow(s, 'Height', () => devSize(sc).height, v => setDev(sc, devSize(sc).width, v), 8);
    const screensApi = SC();
    if (screensApi && typeof screensApi.outputDeviceCanFollowComposition === 'function' &&
        screensApi.outputDeviceCanFollowComposition(devKind(sc)))
      togRow(s, 'Follow Show',
        () => !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition()),
        v => { if (sc.setDeviceFollowComposition) sc.setDeviceFollowComposition(v); },
        'SHOWAVE extension. When On, the encode raster tracks the Show size. Editing Width or Height turns it Off.', true);

    sliderRow(s, 'Opacity', () => pnum(sc, ['opacity', 'Opacity'], 1), v => pset(sc, 'Params', 'Opacity', v), 0, 1);
    colourRows(s, sc, 'Params');
    broadcastHelp(s, 'Width and Height are the encode resolution. Feeds are ordinary Slices: each one ' +
            'has its own Input Selection and Output Transformation, so a vertical destination ' +
            'is simply a vertical Feed rectangle.');

    const e = sec('Encoder');
    inert(txtRow(e, 'Encoder', () => pstrOf(sc, 'Encoder', ''), v => pset(sc, 'Params', 'Encoder', v, 'STRING')),
      'Picked from the Encoder Library: Arena menu > Encoder Editor. Not yet bound: a session ' +
      'started from here currently uses the transport\'s own defaults rather than this profile, ' +
      'so the field is shown and disabled instead of pretending to be applied.');
    broadcastHelp(e, 'RTMP destinations started together share the Broadcast raster and relay encode. ' +
            'WHIP and file outputs use separate sessions. Use another Broadcast for a different ' +
            'output size. The Encoder Library profile is not applied by this panel yet.');

    /* STREAM INFO — GLOBAL text, pushed WHEN THE OPERATOR ASKS.

       The operator's requirement, verbatim: "the user is not supposed to paste
       anything ... User only logs into their platforms and then clicks Go Live,
       and every setting and configuration is applied, starting from the Topics,
       Descriptions etc." This block is where those live.

       Two things changed here to match Restream rather than approximate it
       (both from ZERO-PASTE-GOLIVE.md §1, which quotes Restream's own pages):

       1. THE PUSH HAPPENS AT EDIT TIME, not only at Go. "Updates are applied to
          compatible channels — even if they're currently disabled, so you can
          prepare everything before going live." A disabled channel is in no
          broadcast, so that write cannot have been deferred to Go Live. Update
          All below is that push. Go still applies what can only happen then —
          a YouTube liveBroadcast does not exist until Go Live creates it.
       2. CATEGORY IS PER CHANNEL. It is not in Restream's Update All dialog at
          all; it is reached with "click Edit next to a channel". One global
          Category cannot be correct for two platforms at once, so it now sits
          on each channel-backed destination row instead of here.

       These are not secrets and they belong in the document: they persist as
       ordinary <Params> on the Broadcast, exactly like Encoder above. */
    const si = sec('Stream info');
    const chanDests = (sc.destinations || []).filter(d =>
      d && d.accountId && (!destCat || connectedRowFor(d)));
    /* Which of this Broadcast's channels cannot take a given field, read from
       the helper's capability table BEFORE the operator types — the difference
       between greying a box and apologising for it afterwards. An unread or
       unpublished table yields nothing rather than a guess. */
    const cannotTake = key => {
      const out = [];
      chanDests.forEach(d => {
        const f = metaFieldCap(d, null, key);
        if (!metaFieldBlocked(f)) return;
        const block = metaCapFor(d, null);
        const who = (block && block.label) || destProvider(d, null) || d.name;
        if (!out.some(x => x.who === who)) out.push({ who: who, why: f.reason || '' });
      });
      return out;
    };
    INFO_FIELDS.forEach(f => {
      const el = streamInfoDraftField(si, sc, f);
      const blocked = cannotTake(f.key);
      el.title = (f.key === 'title'
        ? 'The title the show goes out under, for every destination on this Broadcast backed by a ' +
          'connected channel. Update All pushes it now; Go applies it to anything that can only ' +
          'take it then. Left empty, the Broadcast\'s Name above is used at Go for a platform ' +
          'that MUST have one to create a broadcast; it is never sent to a platform whose title ' +
          'is permanent channel state, because that would rename a real channel.'
        : 'Prose for the platforms that have a description field. Update All pushes it now; Go ' +
          'applies it where it can only happen then.') +
        (blocked.length
          ? '\n\nNot taken by: ' + blocked.map(b => b.who).join(', ') + '.\n' +
            blocked.map(b => b.who + ': ' + (b.why || 'no reason given')).join('\n')
          : '');
      if (blocked.length) {
        const who = blocked.map(x => x.who);
        const detail = (who.length > 1
            ? who.slice(0, -1).join(', ') + ' and ' + who[who.length - 1]
            : who[0]) +
          (blocked.length > 1 ? ' have no ' : ' has no ') + f.label.toLowerCase() +
          ' field; it is not sent there.';
        broadcastHelp(si, detail + '\n' + blocked.map(x => x.who + ': ' + (x.why || 'no reason given')).join('\n'));
      }
    });
    /* An OPTIONAL catalogue ceiling, shown only where a platform row carries
       one. YouTube documents 100 characters and Twitch 140, but neither number
       is in this repo's catalogue, and printing a limit nothing measured would
       be exactly the fabrication CLAUDE.md forbids. */
    const ceiling = titleCeiling((sc.destinations || []).filter(x => x.enabled));
    const titleNow = infoOf(sc, INFO_FIELDS[0]);
    if (ceiling && titleNow.length > ceiling.max)
      warn(si, 'The title is ' + titleNow.length + ' characters and ' + (ceiling.who || 'a destination') +
               ' takes ' + ceiling.max + '.');

    /* A global Category from a document written before the split. It is no
       longer sent — one value cannot be correct on two taxonomies — so it is
       named, offered to each channel row, and only then dropped. Silently
       ignoring a value the operator typed is the failure this panel exists to
       avoid. */
    const legacyCat = legacyCategory(sc);
    if (legacyCat) {
      warn(si, 'This Broadcast carries one global Category, "' + legacyCat + '", from an earlier ' +
               'version. It is no longer sent anywhere: YouTube category ids, Twitch game ids and ' +
               'Kick categories are disjoint lists, so one value cannot be right for two ' +
               'platforms. Category is now set per destination below.');
      const lr = row(si, '');
      const copy = mk('button', 'ao-btn', lr, 'Copy to each channel');
      copy.type = 'button';
      copy.title = 'Writes "' + legacyCat + '" into the Category of every channel-backed ' +
                   'destination on this Broadcast that has none yet, then removes the global one. ' +
                   'Check each row afterwards; the same word is unlikely to be the right ' +
                   'category on two different platforms.';
      copy.addEventListener('click', () => {
        push('migrate global category');
        let n = 0;
        chanDests.forEach(d => { if (!categoryOf(sc, d)) { setCategory(sc, d, legacyCat); n++; } });
        pdrop(sc, CATEGORY_FIELD.param);
        notify(n ? 'Category "' + legacyCat + '" copied to ' + n + ' destination' +
                   (n === 1 ? '' : 's') + '. Check each one; the platforms do not share a list.'
                 : 'The global Category was removed. Every channel destination already had its own.',
               n ? '' : 'warn');
        refresh();
      });
      const drop = mk('button', 'ao-btn', lr, 'Discard');
      drop.type = 'button';
      drop.title = 'Removes the global Category from this Broadcast without copying it anywhere.';
      drop.addEventListener('click', () => {
        push('discard global category');
        pdrop(sc, CATEGORY_FIELD.param);
        notify('The global Category was removed. Nothing was sent by it.', '');
        refresh();
      });
    }

    /* UPDATE ALL — the edit-time push, reported per channel. */
    const ur0 = row(si, '');
    const upd = mk('button', 'ao-btn', ur0, applyNowRunning ? 'Updating…' : 'Update All');
    upd.type = 'button';
    if (!chanDests.length) {
      inert(upd, 'No destination on this Broadcast is backed by a connected channel, so there is ' +
                 'no API to push anything to. A pasted stream key carries video only. Connect a ' +
                 'channel under "+ Add Channel" below.');
    } else if (applyNowRunning) {
      inert(upd, 'A push is in flight. Each channel is written independently and reports on its ' +
                 'own line below.');
    } else {
      upd.title = 'Pushes the Title and Description above, plus each destination\'s own Category, ' +
                  'to all ' + chanDests.length + ' connected channel' +
                  (chanDests.length === 1 ? '' : 's') + ' on this Broadcast, including any whose ' +
                  'On toggle is Off, because On governs which destinations receive the video, not ' +
                  'which may be prepared. One write per channel, so each reports its own outcome: ' +
                  'applied, deferred to Go Live, or the platform\'s own failure. Nothing is ' +
                  'summarised into a single "Updated".';
      upd.addEventListener('click', () => applyAllStreamInfo(sc));
    }
    /* The capability table's own state, said plainly. Not knowing is a third
       answer and reads as neither working nor broken. */
    if (metaCap && metaCap.absent && metaCap.reason)
      broadcastDetail(si, 'Metadata support unknown', metaCap.reason, 'warn');
    if (metaCap && metaCap.unverified) {
      // Older helpers used this provenance field to assert no OAuth app was
      // configured. Readiness comes from the current account catalogue, not
      // from a static documentation disclaimer.
      broadcastHelp(si, 'Platform field support comes from reference documentation, not a live test. ' +
        'A connected account alone does not prove metadata or media delivery.');
    }
    /* Keep every per-channel / per-field receipt available, off the main form. */
    const receipts = applyAllLines(sc);
    if (receipts.length) broadcastDetail(si, 'View update results', receipts.map(line =>
      line.text + '\n' + (line.rec.fields ? infoDetail(line.rec.fields)
        : line.rec.error || line.rec.note || '')).join('\n\n'),
      receipts.some(line => line.bad) ? 'warn' : 'help');

    broadcastHelp(si, 'Title and Description are shared; Category is per channel. Update All includes ' +
             'Off channels and reports each field separately. YouTube fields are deferred until ' +
             'Go creates the broadcast. Manual outputs need stream details set on the platform. ' +
             'Thumbnail upload and per-channel overrides are available in Broadcast Studio.');
    broadcastHelp(si, 'When linked to a Show, Title and Description update Show Settings and Broadcast Studio ' +
      'as you type; Map Cancel does not undo those shared Show edits. A standalone Map keeps these fields in ' +
      'its output draft. Save & Close keeps the output setup; Cancel discards its draft edits. Update All ' +
      'sends details to platforms now, and Cancel cannot undo those platform changes.');
    upd.title += '\nSends to platforms now. Cancel cannot undo platform changes.';

    /* DESTINATIONS — the fan-out. dmx.htm: "one Lumiverse can be routed to
       multiple universes, and a universe is how that Lumiverse gets routed
       outside Resolume." A Broadcast is routed to many destinations the same
       way, and the list is deliberately unbounded.

       The list itself is REAL: add, remove, rename and enable all work and all
       persist. Only the transport is inert, and only that row says so. */
    const d = sec('Destinations');
    const list = sc.destinations || [];
    if (!destCatAsked) refreshDestCatalogue(false);
    const cat = (destCat && destCat.destinations) || [];
    if (destCat && destCat.error) broadcastDetail(d, 'Connection unavailable', destCat.error, 'error');
    else if (!destCat) note(d, 'Checking connections…');

    /* THE ZERO-PASTE PATH, SAID FIRST.

       This list used to open on a 56-entry "Paste a stream key" group, which
       made pasting read as the normal way to use SHOWAVE. It is the fallback.
       Connecting is the path the Stream info above depends on, because a
       stream key is a transport credential and carries no metadata: there is no
       API on the far end of a pasted URL to set a title with. */
    broadcastHelp(d, 'Connect supported accounts once; their channels appear automatically. On chooses ' +
            'the destinations for Go Live. Go starts one destination. Check each platform workflow ' +
            'for supported settings and extra publish steps.');
    platformPickerSection(d, sc, cat);

    /* One key per option so a channel and its platform never collide. */
    const optKey = r => r.kind === 'channel'
      ? `ch:${r.accountId}:${r.channelId || ''}`
      : r.kind === 'connect' ? `connect:${r.provider}`
      : `plat:${r.platformId}`;
    const rowFor = key => DIRECT_ROWS.find(x => x.key === key)
      || cat.find(r => optKey(r) === key) || null;
    /* What a destination record currently points at. Records written before the
       catalogue existed carry only a transport, so fall back to that rather
       than showing them as unset. */
    const currentKey = destinationServiceKey;
    /* What a stored ingest key is worth on this platform, from the catalogue
       row's keyModel / goLive / keyNote. A per-show LinkedIn key must not read
       like a Twitch one just because both show a lock and a host. One hint per
       row; the keyNote (which names the setting, and flags what the research
       could only infer) rides on the tooltip. A platform nobody researched has
       no keyModel and gets NOTHING — absence must not render as "reusable". */
    const keyHint = pr => {
      const km = pr && pr.keyModel ? String(pr.keyModel) : '';
      const gl = pr && pr.goLive ? String(pr.goLive) : '';
      const tip = pr && pr.keyNote ? String(pr.keyNote) : '';
      const none = { text: '', tip: '', bad: false, replace: false };
      if (!km) return none;
      if (km === 'per-broadcast')
        return { text: 'Key changes every show. Paste today\'s before Go.', tip, bad: true, replace: true };
      if (km === 'undocumented')
        return { text: 'Key lifetime unverified. Check it on the platform before Go.', tip, bad: true, replace: false };
      if (km === 'persistent-optional')
        return { text: 'Reusable only with the platform\'s persistent-key setting on' +
                       (gl === 'click' ? '; still click Go Live there each show.' : '.'),
                 tip, bad: false, replace: false };
      /* An unknown model is not a known-good one: say nothing rather than guess. */
      if (km !== 'persistent') return none;
      if (gl === 'click')
        return { text: 'Reusable; still click Go Live on the platform each show.', tip, bad: false, replace: false };
      if (gl === 'push-with-setting')
        /* Not "one-time": for Kick, whether title/category survive a session
           is NOT DOCUMENTED. The keyNote tooltip carries each platform's own
           frequency; the shared line only says a setting must be in place. */
        return { text: 'Reusable; a platform-side setting must be in place (hover for which).', tip, bad: false, replace: false };
      return { text: '', tip: tip || 'Reusable; re-paste only after a reset.', bad: false, replace: false };
    };
    list.forEach((dest, i) => {
      const r = row(d, String(i + 1));
      /* Five controls in a 216px column do not fit on one line. The row wraps and
         the name takes the first line, so twenty destinations stay scannable. */
      r.classList.add('oo-dest');
      const nameEl = dest.accountId
        ? mk('div', 'ao-ro', r, esc(dest.name))
        : mk('input', '', r);
      if (!dest.accountId) {
        nameEl.type = 'text'; nameEl.value = dest.name;
        nameEl.addEventListener('change', () => {
          push('rename destination'); dest.name = nameEl.value || 'Destination';
          nameEl.blur(); refresh();
        });
      } else {
        nameEl.title = 'Connected channel. SHOWAVE creates its ingest automatically at Go; ' +
                       'there is no URL or stream key to enter on this row.';
      }
      /* The service picker exists only for custom outputs. It starts by saying
         that connected channels already have automatic rows, then offers
         direct transports and the paste-a-key fallback. */
      const sel = mk('select', '', r);
      const addOpt = (parent, key, label, title, disabled) => {
        const o = mk('option', '', parent, esc(label));
        o.value = key;
        if (title) o.title = title;
        if (disabled) o.disabled = true;
        return o;
      };
      const group = label => {
        const g = mk('optgroup', '', sel); g.label = label; return g;
      };

      /* ADDING A CHANNEL IS NOT CHOOSING A DESTINATION.

         Connecting an account is an ACCOUNT-level act: you authorise once and
         that channel belongs to the whole app, available to every Broadcast
         from then on. Choosing a destination is a PER-BROADCAST routing
         decision over channels that already exist.

         They were briefly the same control here, and that was wrong: it put a
         one-time setup action inside a per-show dropdown, so "YouTube — needs
         setup" looked like somewhere this Broadcast could be sent. Connecting
         now lives on the section's own "+ Add Channel" button. Its channels
         become rows automatically; this picker cannot duplicate them. */
      const channels = cat.filter(x => x.kind === 'channel');
      /* RENDERED EVEN WHEN EMPTY. With nothing connected this group vanished
         and the picker opened on Direct followed by the 56 paste-a-key rows, so
         the fallback occupied the position of the primary path. An empty group
         naming the button to press is the shorter true statement. */
      const gCh = group(channels.length ? 'Connected channels: automatic rows'
                                        : 'Connected channels: none yet');
      if (channels.length) {
        addOpt(gCh, '', 'Already listed automatically; no assignment needed',
               'Each connected channel has its own On/Off destination row. This custom-output ' +
               'picker cannot create a duplicate route to the same account.', true);
      } else {
        addOpt(gCh, '', 'Press "+ Add Channel" below to connect one',
               'A connected channel needs no stream key, and it is the only kind of destination ' +
               'the Stream info above can be applied to.', true);
      }
      const gDirect = group('Direct');
      DIRECT_ROWS.forEach(x => addOpt(gDirect, x.key, x.label, x.note));
      const whips = cat.filter(x => x.kind === 'whip');
      whips.forEach(x => addOpt(gDirect, optKey(x), x.displayName, x.note));

      const keyed = cat.filter(x => x.kind === 'key')
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (keyed.length) {
        /* A key is not the only way in for the three platforms that also have a
           connect row, and the option must not imply that it is. The reason
           rides on the tooltip rather than the label: a 216px select cannot
           carry a sentence, and truncating one is worse than hovering for it. */
        const connectFor = pid => pid == null ? null
          : cat.find(x => x.kind === 'connect' && x.platformId === pid) || null;
        const g = group(`Paste a stream key as a fallback (${keyed.length})`);
        /* The label says what a pasted key BUYS on that platform, from the
           catalogue's researched keyModel. A platform without one gets no
           suffix — absence must never read as reusable. */
        const keySuffix = x => x.keyModel === 'per-broadcast' ? ' (key per show)'
          : x.keyModel === 'undocumented' ? ' (key reuse not documented)'
          : x.keyModel === 'persistent-optional' ? ' (key reusable with a platform setting)'
          : '';
        keyed.forEach(x => {
          const cn = connectFor(x.platformId);
          const alt = !cn ? ''
            : cn.ready
              ? `\n\n${cn.displayName} can be connected instead, under "+ Add Channel": no key is ` +
                `typed, and the Stream info above can be pushed to it with Update All and again ` +
                `at Go. A pasted key sets no title.`
              : `\n\n${cn.displayName} supports sign-in, but it is unavailable in this ` +
                `distribution until the SHOWAVE publisher configures that platform's OAuth ` +
                `application. This is not an end-user setting; see "+ Add Channel" for status.`;
          addOpt(g, optKey(x), x.displayName + keySuffix(x), (x.keyNote || x.note || '') + alt);
        });
      }
      const blocked = cat.filter(x => x.kind === 'blocked');
      if (blocked.length) {
        const g = group('Unavailable');
        blocked.forEach(x => addOpt(g, optKey(x), x.displayName, x.note, true));
      }

      const key = currentKey(dest);
      const picked = rowFor(key);
      sel.value = key;
      sel.title = (picked && picked.note) || '';
      const serviceIdentity = destinationConnectionIdentity(dest);
      const connectionLock = destinationConnectionLock(sc, dest);
      sel.disabled = !!connectionLock;
      if (connectionLock) sel.title = connectionLock;
      sel.setAttribute('aria-label', (dest.name || 'Destination') + ' service');
      if (dest.accountId && (!destCat || connectedRowFor(dest))) {
        /* The account/channel identity comes from OAuth and is not a per-show
           picker. Hiding this old routing selector removes the manual step
           while keeping it available for custom-output rows. */
        sel.hidden = true;
        sel.disabled = true;
      }
      sel.addEventListener('change', () => {
        if (destinationConnectionIdentity(dest) !== serviceIdentity)
          notify('This destination changed. Review its current connection before switching services.', 'warn');
        else changeDestinationService(sc, dest, sel.value);
        sel.blur();
        refresh();
      });
      const cap = routeCapability(dest);
      const toggleState = destinationToggleState(sc, dest);
      const effectiveOn = isDestinationSelected(dest);
      const toggleOn = !effectiveOn;
      const toggleIdentity = destinationRoutingIdentity(dest);
      const en = mk('button', 'ao-tog' + (effectiveOn ? ' on' : ''), r, effectiveOn ? 'On' : 'Off');
      en.type = 'button';
      en.disabled = toggleState.disabled;
      en.setAttribute('aria-pressed', String(!!effectiveOn));
      en.setAttribute('aria-label', (dest.name || 'Destination') + ' included in Go Live');
      en.title = toggleState.disabled ? toggleState.why
        : effectiveOn && !cap.ok ? cap.why + ' Turn this destination Off to exclude it from Go Live.'
        : 'On: this destination is INCLUDED when Go Live opens the Broadcast. Off: it ' +
          'stays configured and is left out. This governs the VIDEO only: Update All in ' +
          'Stream info still pushes the title, description and category to an Off channel, ' +
          'which is what makes a show stageable before it is routed.';
      en.addEventListener('click', () => {
        const fresh = destinationToggleState(sc, dest);
        if (fresh.disabled || destinationRoutingIdentity(dest) !== toggleIdentity) {
          notify(fresh.disabled ? fresh.why : 'This destination changed. Review its current routing before toggling it.', 'warn');
          refresh(); return;
        }
        if (fresh.selected === toggleOn) { refresh(); return; }
        push('toggle destination'); dest.enabled = toggleOn; refresh();
      });

      /* Per-destination arm. The capability check decides whether this can do
         its job, and prints the reason on the button itself when it cannot —
         the operator never has to guess which of the six transports is real. */
      const live = liveDest.get(String(dest.uniqueId));
      const isConnectRow = String(dest.serviceKey || '').startsWith('connect:');
      const pickedRow = rowFor(currentKey(dest));
      if (!cap.ok) {
        broadcastDetail(r, cap.pending ? 'Checking…' : 'Needs attention',
          (dest.name || 'Destination') + ': ' + cap.why, cap.pending ? 'help' : 'warn');
      }

      /* CATEGORY — PER DESTINATION, on the row it belongs to.

         Restream puts it here and nowhere else: it is absent from Update All's
         global box and is reached with "click Edit next to a channel, select a
         game or topic under Category". The reason is that YouTube video
         category ids, Twitch game ids and Kick category ids share no
         vocabulary, so a single field for all of them would be a control that
         cannot do its job on at least one platform.

         Only on a channel-backed row. A pasted key has no API to set a category
         through, and offering the box there would be exactly the fabricated
         capability this file spends its comments avoiding. */
      if (dest.accountId && (!destCat || connectedRowFor(dest))) {
        const settings = broadcastFold(d, sc, 'channel-' + dest.uniqueId, (dest.name || 'Channel') + ' · settings');
        const cr0 = row(settings, '');
        cr0.classList.add('oo-dest');
        const catLbl = mk('span', 'oo-dest-cat-label', cr0, 'Category');
        const capCat = metaFieldCap(dest, pickedRow, 'category');
        const capBlock = metaCapFor(dest, pickedRow);
        const who = (capBlock && capBlock.label) || (pickedRow && pickedRow.platform) ||
                    destProvider(dest, pickedRow) || 'This platform';
        catLbl.title = 'Category belongs to this channel alone. It is sent with Update All and ' +
                       'again at Go, never to any other destination.';
        const categoryPicker = window.OpenLiveMapCategoryPicker;
        if (!categoryPicker) {
          note(cr0, 'Category controls could not be loaded. Reload SHOWAVE Map; the saved category is unchanged.');
        } else {
          const categoryIdentity = JSON.stringify([dest.uniqueId, dest.accountId, dest.channelId,
            dest.provider, dest.platformId, dest.transport]);
          const categorySnapshot = categoryOf(sc, dest);
          const categoryProvider = destProvider(dest, pickedRow);
          const categoryCurrent = () => !ST.destroyed && screenById(sc.uniqueId) === sc && curScreen() === sc &&
            (sc.destinations || []).includes(dest) && (!destCat || !!connectedRowFor(dest)) &&
            JSON.stringify([dest.uniqueId, dest.accountId, dest.channelId,
              dest.provider, dest.platformId, dest.transport]) === categoryIdentity &&
            categoryOf(sc, dest) === categorySnapshot &&
            destProvider(dest, connectedRowFor(dest)) === categoryProvider &&
            metaFieldBlocked(metaFieldCap(dest, connectedRowFor(dest), 'category')) === metaFieldBlocked(capCat);
          categoryPicker.mount(cr0, {
            provider: categoryProvider, accountId: dest.accountId,
            compact: true, notify: message => notify(message, 'warn'),
            region: categoryPicker.regionFor(navigator.language),
            label: 'Category: ' + (dest.name || who), channelLabel: dest.name || who,
            getValue: () => categoryOf(sc, dest), isCurrent: categoryCurrent,
            blocked: metaFieldBlocked(capCat),
            note: capCat && (capCat.reason || capCat.note) ||
              'The connector has not reported category support. Update All reports what this platform accepts.',
            loadCategories: (accountId, region) => {
              const S = hostStream();
              if (!categoryCurrent() || !connectedRowFor(dest) || !S || !S.accounts ||
                  typeof S.accounts.categories !== 'function')
                return Promise.reject(new Error('Category reader unavailable'));
              return S.accounts.categories(accountId, region);
            },
            onChange: value => {
              if (!categoryCurrent() || !connectedRowFor(dest) ||
                  metaFieldBlocked(metaFieldCap(dest, connectedRowFor(dest), 'category'))) return;
              push('set destination category');
              setCategory(sc, dest, value);
              refresh();
            }
          });
        }
      }

      /* THE INGEST FIELD, inline rather than a prompt.

         This is the shortest path to a working broadcast - paste the URL your
         platform gave you and press Go - so it must not depend on
         window.prompt(), which is a blocking dialog that froze this window
         during testing and which some hosts suppress entirely.

         Session-only, deliberately. For every platform in
         PLATFORM-INTEGRATION-CONTRACT.md the stream key is IN this URL, and the
         output document is exported and mailed. It is held on the live record
         in memory and never written to the destination that gets saved. */
      if (!live && !isConnectRow && !dest.accountId && dest.transport === 'ST_HELPER_RTMP') {
        const ur = row(d, '');
        ur.classList.add('oo-dest');
        const ingestIdentity = destinationConnectionIdentity(dest);
        const editableIngest = () => {
          const why = destinationConnectionLock(sc, dest);
          if (why || destinationConnectionIdentity(dest) !== ingestIdentity) {
            notify(why || 'This destination connection changed. Reopen its current settings.', 'warn');
            refresh(); return false;
          }
          return true;
        };
        if (dest.endpointRef && endpointRows === null) refreshEndpoints();
        const saved = dest.endpointRef ? endpointRow(dest.endpointRef) : null;
        if (saved) {
          /* Connected once. The key went into the helper's encrypted store the
             moment it was typed; from then on the row shows the host it points
             at and the helper substitutes the URL at Go. Nothing here can leak
             it because nothing here has it. */
          const lbl = mk('span', 'oo-dest-saved', ur,
                         '🔒 ' + (saved.host || 'saved ingest') + (saved.lastUsedAt ? '' : ' · never used'));
          const hint = keyHint(pickedRow);
          lbl.title = 'Saved ingest ' + saved.id + '. The URL and its key are held encrypted by the ' +
                      'helper on this machine and never return to this window. ' +
                      (hint.replace ? 'Replace it to paste today\'s.' : 'Detach it to choose a different one.') +
                      (hint.tip ? '\n\n' + hint.tip : '');
          /* "Replace" where the platform hands out a new key per show: the
             stored one may still be today's, so Go stays live — but the button
             must say what the operator will actually be doing most nights. */
          const forget = mk('button', 'ao-btn', ur, hint.replace ? 'Replace' : 'Detach');
          forget.type = 'button';
          forget.title = 'Detach this saved ingest from this destination only. Other Broadcasts keep it. ' +
            'Choose another saved ingest or provide its replacement; use Accounts → Forget to delete it from this machine.';
          if (hint.text) {
            /* textContent, not mk()'s innerHTML: the tooltip text comes from the
               catalogue, and the hint must never become markup. */
            const h = mk('span', 'oo-dest-hint' + (hint.bad ? ' bad' : ''), ur);
            /* A per-show key is anchored to WHEN it was saved, so "today's" is
               something the operator can read rather than guess. */
            h.textContent = hint.text +
              (hint.replace && saved.addedAt ? ' Saved ' + agoText(saved.addedAt) + '.' : '');
            h.title = hint.tip || hint.text;
          }
          forget.addEventListener('click', () => {
            if (!editableIngest()) return;
            push('detach saved ingest');
            invalidateDestinationConnection(dest);
            dest.endpointRef = '';
            sessionUrl.delete(String(dest.uniqueId));
            dest.enabled = false;
            notify('Saved ingest detached from this destination; shared saved ingests were kept. This destination is now Off.', '');
            refresh();
          });
        } else {
          const Sn = hostStream();
          if (dest.endpointRef && endpointRows !== null && Sn && Sn.endpoints) {
            /* A ref the store does not know: the document came from another
               machine, or the store was cleared. Say so rather than presenting
               an empty field as if nothing had ever been set. */
            const warn = mk('span', 'oo-dest-note', ur, 'Saved ingest not on this machine. Paste it again.');
            warn.title = 'This destination references ingest ' + dest.endpointRef + ', which the helper ' +
                         'on this machine does not hold. Keys never travel inside the output document.';
          }
          /* CONNECT ONCE per app, not per row: an ingest already saved for this
             platform can be picked instead of pasted again, so the second
             Broadcast aimed at the same channel costs one click, not a key. */
          if (endpointRows === null) refreshEndpoints();
          const reusable = (endpointRows || []).filter(r =>
            dest.platformId != null && r.platformId === dest.platformId);
          if (reusable.length) {
            const use = mk('select', 'oo-dest-use', ur);
            const o0 = mk('option', '', use, 'Use a saved ingest…'); o0.value = '';
            reusable.forEach(r => {
              const o = mk('option', '', use, esc(`${r.label || r.host} · ${r.host}`)); o.value = r.id;
            });
            use.title = 'Ingests already saved on this machine for this platform. Picking one points ' +
                        'this destination at it; nothing is re-pasted and the key stays in the helper.';
            use.addEventListener('change', () => {
              if (!use.value) return;
              if (!editableIngest()) return;
              const chosen = endpointRow(use.value);
              if (!chosen || String(chosen.platformId) !== String(dest.platformId)) {
                notify('That saved ingest is no longer available for this platform.', 'warn');
                use.blur(); refresh(); return;
              }
              push('use saved ingest');
              invalidateDestinationConnection(dest);
              dest.endpointRef = use.value;
              sessionUrl.delete(String(dest.uniqueId));
              use.blur();
              refresh();
            });
          }
          const urlEl = mk('input', '', ur);
          urlEl.type = 'text';
          urlEl.value = sessionUrl.get(String(dest.uniqueId)) || '';
          urlEl.placeholder = (pickedRow && pickedRow.ingestExample) || 'rtmps://…/<stream-key>';
          const keyNote = pickedRow && pickedRow.keyNote ? String(pickedRow.keyNote) : '';
          urlEl.title = 'The full ingest URL including the stream key, exactly as the platform gave ' +
                        'it to you. The helper holds it in memory for this session; replace it when ' +
                        'the platform expires or rotates the key. ' +
                        'This destination remembers it by id. It is never written to the output ' +
                        'document, which is exported and mailed. While live, ffmpeg carries it on ' +
                        'its command line, so it is readable from this machine\'s process list.' +
                        (keyNote ? '\n\n' + keyNote : '');
          urlEl.addEventListener('change', () => {
            if (!editableIngest()) return;
            const v = urlEl.value;
            urlEl.blur();
            saveDestinationIngest(sc, dest, v);
          });
        }
      }
      /* A destination that is actually carrying something goes solid red, for
         the same reason the master button does — on-air state has to read at a
         glance, not on inspection. `handoff` is not a session, so it stays
         neutral rather than claiming to be live. */
      const running = activeEgressRecord(live);
      const go = mk('button', 'ao-btn' + (running ? ' oo-go-on' : ''), r,
                    live && live.state === 'stop-failed' ? 'Retry End' : running ? 'Stop' : live && live.state === 'finish-failed' ? 'Retry End'
                      : live ? 'Clear' : isConnectRow ? 'Connect' : cap.handoff ? 'OBS setup' : 'Go');
      go.type = 'button';
      if (live) {
        go.title = live.state === 'stop-failed' ? 'Retry stopping this exact media session; its previous stop was not confirmed.' : running ? 'Stop this destination.'
          : live.state === 'finish-failed'
            ? 'Retry ending the platform broadcast. Media is already stopped.'
            : 'Clear this failed attempt after any platform-side setup is closed.';
        go.addEventListener('click', () => { stopDest(dest.uniqueId); refresh(); });
      } else if (isConnectRow) {
        /* A legacy connect row says what the click does. An unconfigured OAuth
           application is a distributor-level refusal, not an operator setup
           step and never a field for them to fill. */
        go.title = pickedRow && pickedRow.ready
          ? `Opens ${pickedRow.displayName}'s own sign-in page in your browser. You approve once; ` +
            `the channel then appears in this list and no stream key is ever typed.`
          : `Unavailable in this SHOWAVE distribution until its publisher configures the ` +
            `platform OAuth application. End users are not asked for developer credentials.`;
        go.addEventListener('click', () => armDest(sc, dest));
      } else if (!cap.ok) {
        inert(go, cap.why);
      } else if (cap.handoff) {
        go.title = 'Shows and copies setup steps for capturing Studio Programme in OBS. ' +
          'Configure audio separately and start or stop publishing in OBS. Starts no stream.';
        go.addEventListener('click', () => armDest(sc, dest));
      } else {
        /* Go opens THIS ONE destination. Studio's Go Live opens every
           enabled destination on the Broadcast at once, on a single encode.
           The two are different acts and the tooltip has to say which is which,
           because the buttons sit two panels apart and read alike. */
        go.title = 'Go: opens THIS destination now, on its own, without the rest of the ' +
                   'Broadcast. (Studio Go Live opens every destination that is On.) ' +
          (dest.transport === 'ST_ENDPOINT'
          ? 'Asks for the ingest URL, then opens a real WHIP session from this Broadcast. The URL is ' +
            'held for this session only and is never written to the document.'
          : dest.accountId
            ? 'Creates the broadcast on the connected channel, applies the Stream info (the ' +
              'global Title and Description plus THIS row\'s Category), reads back its ingest ' +
              'and starts sending media. No stream key is entered by the user. Each field the platform took, ' +
              'refused or has no place for is reported back on this row.'
            : dest.transport === 'ST_HELPER_RTMP'
              ? (dest.endpointRef
                  ? 'Fans this Broadcast out through the local relay using the saved ingest. The ' +
                    'helper substitutes the URL; this window never sees the key. A key carries ' +
                    'video only, so no Stream info is applied here.'
                  : 'Paste the ingest URL with its stream key in the field above first; it is saved ' +
                    'once by the helper, then this fans the Broadcast out through the local relay.')
              : 'Records this Broadcast to a file you choose.');
        go.addEventListener('click', () => armDest(sc, dest));
      }

      const staleAccount = !!(dest.accountId && destCat && !destCat.error && !connectedRowFor(dest));
      if (!dest.accountId || staleAccount) {
        const del = mk('button', 'ao-btn', r, '✕');
        del.type = 'button'; del.title = staleAccount
          ? 'Remove this stale route. Its connected account is no longer present on this machine.'
          : 'Remove this custom output';
        del.addEventListener('click', () => {
          push('remove destination'); stopDest(dest.uniqueId);
          /* Its Category is a Param keyed by this destination's id, so removing
             the destination without it would leave an orphan in the document that
             nothing renders and nothing can ever reach again. */
          pdrop(sc, catParam(dest));
          applyNow.delete(String(dest.uniqueId));
          sc.removeDestination(dest.uniqueId); refresh();
        });
      }

      /* STATE stays on the row, because it persists and belongs to this object;
         the prose that explains it went to the notification area. One short word
         plus the button's colour, so twenty destinations stay scannable. */
      if (live) {
        /* A stall arrives through no event — the relay is blocked, so nothing
           is emitted — which is exactly why it is polled. Saying LIVE while
           nothing has moved for ten seconds is the failure this project
           forbids, so the stall outranks the state. */
        const bad = failedEgressRecord(live) || live.stalledSeconds != null;
        const label = live.stalledSeconds != null
          ? 'STALLED ' + Math.round(live.stalledSeconds) + 's'
          : live.state === 'stop-failed' || live.state === 'finish-failed' ? 'END FAILED'
          : live.state === 'failed' ? 'FAILED' : live.state.toUpperCase();
        const detail = live.stalledSeconds != null
          ? (live.stalledReason || 'Nothing has moved for several seconds.')
          : failedEgressRecord(live)
            ? (live.error || 'No reason reported.')
            : (live.session && live.session.fileName) || 'Open.';
        const st = broadcastDetail(r, label, (dest.name || 'Destination') + ': ' + detail, bad ? 'error' : 'help');
        st.classList.add('oo-deststate');
      }

      /* WHAT THIS PLATFORM TOOK, on the row that asked for it.

         Restream shows a per-channel "Channel doesn't support custom titles"
         and calls it explicitly not an error; this goes one further and also
         shows applied and failed, because a fan-out that partially succeeds is
         the normal case and one aggregate word for N platforms would be false
         the moment one of them refused a field.

         Three states are rendered and no fourth is invented: what the helper
         reported; that the helper reported nothing; and that this KIND of
         destination cannot carry stream info at all.

         `asked` is per destination now: the global Title and Description plus
         THIS destination's own Category. */
      const asked = streamInfoFor(sc, dest);
      const askedKeys = Object.keys(asked);
      const pushed = streamInfoRecord(sc, dest);
      const metaCapable = !!dest.accountId;
      const metaRelevant = dest.transport === 'ST_HELPER_RTMP' || dest.transport === 'ST_ENDPOINT';
      if (live && live.streamInfo) {
        const bad = live.streamInfo.some(x => infoBad(x.state));
        broadcastDetail(r, bad ? 'Stream info · attention' : 'Stream info · results',
          dest.name + ': ' + infoDetail(live.streamInfo), bad ? 'warn' : 'help');
      } else if (live && live.streamInfoNoChannel) {
        /* No account means no API call was made at all, so there is nothing to
           report a verdict on. Say where the operator must set it instead. */
        broadcastDetail(r, 'Stream info · manual',
          'This destination is a pasted ingest key. The relay pushes a bitstream to it and ' +
                   'makes no API call, so ' + (live.streamInfoAsked || []).map(infoLabel).join(', ') +
                   ' could not be sent anywhere. Set them on the platform, or connect the account.', 'warn');
      } else if (live && live.streamInfoUnreported) {
        broadcastDetail(r, 'Stream info · unconfirmed',
          'SHOWAVE sent ' + (live.streamInfoAsked || []).map(infoLabel).join(', ') +
                   ' with the ingest request. The helper answered without a per-field verdict, so ' +
                   'this panel cannot say which of them the platform took, and will not guess. ' +
                   'Check the channel.', 'warn');
      } else if (!live && pushed) {
        /* THE EDIT-TIME PUSH, on the row it was sent from. Same rule as the Go
           verdict: this destination's own outcome, never the fan-out's. */
        broadcastDetail(r, 'Update All · ' + (applyLineBad(pushed) ? 'attention' : pushed.state === 'running' ? 'updating…' : 'results'),
          dest.name + ': ' + (pushed.fields ? infoDetail(pushed.fields)
                     : pushed.error || pushed.note || 'Sent.') +
                   '\n\nPushed at ' + new Date(pushed.at).toTimeString().slice(0, 8) +
                   ', before Go. Go applies whatever can only happen then.', applyLineBad(pushed) ? 'warn' : 'help');
      } else if (!live && !isConnectRow && askedKeys.length && metaRelevant && !metaCapable) {
        /* Restream's "connected manually" class, and the same conclusion: the
           control cannot do its job, so it says so and names the remedy. */
        const where = (pickedRow && (pickedRow.platform || pickedRow.displayName)) || 'the platform';
        broadcastDetail(r, 'Stream info · manual', 'Set the title on ' + where + ' itself. ' +
          'This destination is reached by a stream key, which is a transport credential ' +
                   'and carries no metadata: there is no API on the far end of a pasted URL to set ' +
                   'a Title, Description or Category with. Connect the account instead: Update All ' +
                   'then pushes them before the show and Go applies what can only happen then.', 'warn');
      } else if (!live && !isConnectRow && askedKeys.length && metaCapable) {
        /* BEFORE anything is sent. Two facts can be known in advance and only
           from the helper's own tables: which fields this platform has no place
           for, and WHEN it can be written at all. Neither is invented — an
           unread or unpublished capability table draws nothing. */
        const blockedHere = askedKeys
          .map(k => ({ key: k, cap: metaFieldCap(dest, pickedRow, k) }))
          .filter(x => metaFieldBlocked(x.cap));
        const when = metaWhen(dest, pickedRow);
        const block = metaCapFor(dest, pickedRow);
        const parts = [], tips = [];
        if (when === 'go-live') {
          parts.push('Written when Go Live creates the broadcast.');
          tips.push(block && block.whenNote ? String(block.whenNote)
            : 'This platform has no object to write stream info to until Go Live creates one, ' +
              'so Update All reports these fields as deferred rather than applied.');
        } else if (when === 'any-time') {
          parts.push('Can be pushed now with Update All.');
          if (block && block.whenNote) tips.push(String(block.whenNote));
        }
        if (blockedHere.length) {
          parts.push(blockedHere.map(x => infoLabel(x.key)).join(' and ') + ' not taken here.');
          blockedHere.forEach(x => tips.push(infoLabel(x.key) + ': ' +
            (x.cap.reason || 'no reason given')));
        }
        /* The older catalogue-side field, still honoured where a row carries
           one. No field means nothing is drawn — not "supported". */
        const capText = infoCapabilityText(pickedRow);
        if (capText) { parts.push(capText); tips.push(capText); }
        if (parts.length) {
          broadcastHelp(d, dest.name + ': ' + parts.join(' ') + '\n' + tips.join('\n\n') +
                     '\n\nRead from the helper\'s capability table before ' +
                     'anything is sent; the row reports the platform\'s own per-field verdict ' +
                     'after it.');
        }
      }
    });
    destinationPickerSection(d, sc);

    /* WHAT IS CONNECTED, always visible — not hidden behind a button.

       An operator asked to "see all the accounts connected or available" and
       they were right: the connected list only appeared once + Add Channel was
       expanded, so the normal state of the panel answered neither question.
       This row answers both at a glance, and the accounts themselves are listed
       under it. */
    const connectedChannels = cat.filter(x => x.kind === 'channel');
    /* Saved ingests count as "connected" too: for the platforms with no public
       API they are the ONLY kind of connection there is, and an operator with
       nine keys saved must not read "None connected". */
    if (endpointRows === null) refreshEndpoints();
    const savedIngests = endpointRows || [];
    const acctParts = [];
    if (connectedChannels.length)
      acctParts.push(`${connectedChannels.length} channel${connectedChannels.length === 1 ? '' : 's'} connected`);
    if (savedIngests.length)
      acctParts.push(`${savedIngests.length} saved ingest${savedIngests.length === 1 ? '' : 's'}`);
    roRow(d, 'Accounts',
      acctParts.length ? acctParts.join(' · ')
        : (destCat && endpointRows !== null ? 'None connected' : 'reading…'));
    connectedChannels.forEach((ch, channelIndex) => {
      const cr = row(d, '');
      cr.classList.add('oo-dest');
      mk('div', 'ao-ro', cr, esc(`${ch.platform}: ${ch.displayName}`));
      const off = mk('button', 'ao-btn', cr, 'Disconnect…');
      off.type = 'button';
      const disconnectIdentity = { screenId: sc.uniqueId, accountId: String(ch.accountId || ''),
        channelIdentity: mapAccountChannelIdentity(ch) };
      const disconnectLock = mapAccountDisconnectLock(sc, ch, disconnectIdentity);
      off.disabled = !!disconnectLock;
      off.title = (disconnectLock ? disconnectLock + '\n\n' : '') +
        'Disconnect this account from SHOWAVE on this machine. Every channel and Broadcast route ' +
        'under the same account will be removed. This does not sign you out of the platform website.';
      off.setAttribute('aria-label', 'Disconnect ' + (ch.displayName || ch.platform || 'account'));
      const confirmation = mk('div', 'oo-account-confirm', cr);
      confirmation.id = 'oo-account-confirm-' + String(sc.uniqueId) + '-' + channelIndex;
      confirmation.hidden = !mapAccountConfirmationOpen(sc, ch);
      confirmation.setAttribute('role', 'group');
      confirmation.setAttribute('aria-label', 'Confirm account disconnection');
      off.setAttribute('aria-controls', confirmation.id);
      off.setAttribute('aria-expanded', String(!confirmation.hidden));
      const explanation = mk('p', 'oo-dest-note', confirmation);
      explanation.textContent = 'Disconnect this account from SHOWAVE on this machine? All of its ' +
        'channel routes will be removed from every Broadcast. Connect the account again to use them. ' +
        'Your platform website login stays signed in; revoke SHOWAVE in the platform settings if you also want to remove its grant.';
      const confirm = mk('button', 'ao-btn', confirmation, 'Disconnect account');
      confirm.type = 'button';
      const cancel = mk('button', 'ao-btn', confirmation, 'Cancel');
      cancel.type = 'button';
      off.addEventListener('click', () => {
        if (!openMapAccountConfirmation(sc, ch, disconnectIdentity)) return;
        confirmation.hidden = false;
        off.setAttribute('aria-expanded', 'true');
        confirm.focus();
      });
      cancel.addEventListener('click', () => {
        clearMapAccountConfirmation(sc, disconnectIdentity);
        confirmation.hidden = true; off.setAttribute('aria-expanded', 'false'); off.focus();
      });
      confirm.addEventListener('click', () => {
        if (!mapAccountConfirmationOpen(sc, ch)) {
          notifyMapAccount('Open and review this account\'s Disconnect confirmation again before continuing.', 'warn');
          refreshMapAccountView(); return false;
        }
        return disconnectMapAccount(sc, ch, disconnectIdentity);
      });
    });

    /* Saved ingests, listed with the accounts: what is connected has to answer
       for key-based platforms too. Host and label only — the key is in the
       helper and never here. Forget deletes it for every Broadcast. */
    savedIngests.forEach(ep => {
      const er = row(d, '');
      er.classList.add('oo-dest');
      const plat = cat.find(x => x.kind === 'key' && x.platformId === ep.platformId);
      const lbl = mk('div', 'ao-ro', er,
        esc(`🔒 ${plat ? plat.platform || plat.displayName : 'Custom'}: ${ep.host || ep.label}`));
      lbl.title = `${ep.label || ''}\nSaved ${ep.addedAt ? agoText(ep.addedAt) : 'N/A'}` +
                  (ep.lastUsedAt ? `, last used ${agoText(ep.lastUsedAt)}` : ', never used') +
                  '. The URL and its key are held in memory until this session closes.';
      const off = mk('button', 'ao-btn', er, 'Forget');
      off.type = 'button';
      const forgetIdentity = { screenId: sc.uniqueId, endpointId: ep.id };
      const forgetLock = savedIngestForgetLock(sc, ep, forgetIdentity);
      off.disabled = !!forgetLock;
      off.setAttribute('aria-label', 'Forget saved ingest for every Broadcast');
      off.title = (forgetLock ? forgetLock + '\n\n' : '') +
        'Delete this shared saved ingest from this machine for EVERY Broadcast, not just this row. ' +
        'All destinations using it will need to reconnect. Use Detach on a destination to keep the shared ingest.';
      off.addEventListener('click', () => forgetSavedIngest(sc, ep, forgetIdentity));
    });

    const on = list.filter(isDestinationSelected).length;
    roRow(d, 'Enabled', on + ' of ' + list.length);

    /* This used to be a permanent red block reading "no encoder is attached to
       this Broadcast yet, so none of them can open" — sitting directly above Go
       buttons that open real WHIP sessions and real MediaRecorders. Narrating
       half-builtness that is no longer true is the same defect as claiming a
       control works when it does not, pointed the other way.
       It now warns only when NOTHING enabled can actually open, and quotes that
       destination's own reason so this box and the greyed button say one
       sentence between them. */
    const enabledList = list.filter(isDestinationSelected);
    const armableNow = enabledList.filter(x => routeCapability(x).ok);
    if (enabledList.length && !armableNow.length) {
      const why = routeCapability(enabledList[0]).why;
      broadcastDetail(d, 'Output needs attention', why, 'warn');
    }
    broadcastHelp(d, 'Saved ingest credentials stay in this machine\'s encrypted helper store, not in the ' +
            'exported output document. Key lifetime and extra start/stop steps depend on the platform.');
  }
  /* Small reader for the STRING params above; pnum/pbool already exist. */
  function pstrOf(sc, name, dflt) {
    const p = sc && sc.params && sc.params.Params && sc.params.Params[name];
    return p && p.value != null ? String(p.value) : dflt;
  }

  function lumiverseSection(sc) {
    const s = sec('Lumiverse');
    txtRow(s, 'Name', () => sc.name || '', v => { sc.name = v; refreshTree(); });

    /* "A Lumiverse has the same Opacity, Brightness, Contrast and Color options
       that a regular Screen has. In addition, it has a Auto Span and Align
       Output toggles" [dmx.htm]. */
    const auto = pbool(sc, ['Auto Span'], true);
    togRow(s, 'Auto Span', () => auto, v => pset(sc, 'Params', 'Auto Span', v ? 1 : 0, 'BOOL'),
      'Expands the amount of universes in a Lumiverse when you use more than 512 channels, so you do not have to cut long LED strips into several Lumiverses.');
    const align = togRow(s, 'Align Output', () => pbool(sc, ['Align Output'], true),
      v => pset(sc, 'Params', 'Align Output', v ? 1 : 0, 'BOOL'),
      'Makes sure pixels are never split up between universes. Leave it on unless you are having issues with spanning.');
    if (!auto) inert(align, 'Alignment only matters while a fixture spans a universe boundary, which is what Auto Span creates. INFERRED that Arena greys it.');

    sliderRow(s, 'Opacity', () => pnum(sc, ['opacity', 'Opacity'], 1), v => pset(sc, 'Params', 'Opacity', v), 0, 1);
    colourRows(s, sc, 'Params');

    const a = sec('Art-Net');
    const target = artTargetOf(sc);
    const def = ART_TARGETS.find(t => t.value === target) || ART_TARGETS[0];
    selRow(a, 'Target IP', ART_TARGETS.map(t => ({ label: t.label, value: t.value })), target, v => setArtTarget(sc, v))
      .title = 'The Art-Net node that this Lumiverse is sending to. Right-click the Lumiverse in the tree to pick a detected node directly.';
    const addr = txtRow(a, def.entry || 'Address', () => artAddressOf(sc),
      v => { const t = String(v).trim(); pset(sc, 'Params', 'TargetIP', t || target, 'STRING', 'ParamChoice'); });
    if (!def.entry) inert(addr, target === 'TT_BROADCAST'
      ? 'When broadcasting there is no need to set the IP, but you still need Subnet and Universe. [dmx.htm]'
      : target === 'TT_LOCALHOST' ? 'Localhost is a fixed address.' : 'No Output sends nothing.');
    intRow(a, 'Subnet', () => pnum(sc, ['Subnet'], 0), v => pset(sc, 'Params', 'Subnet', v, 'INT'), 0, 15);
    intRow(a, 'Universe', () => pnum(sc, ['Universe'], 0), v => pset(sc, 'Params', 'Universe', v, 'INT'), 0, 15)
      .title = 'For most devices, Universe 0 on Subnet 0 is the default for the first port. Arena refuses above 15: "Highest supported universe is 15, not sending dmx."';
    intRow(a, 'Framerate', () => pnum(sc, ['Framerate'], 40), v => pset(sc, 'Params', 'Framerate', v, 'INT'), 1, 44)
      .title = 'How often this Lumiverse sends. Art-Net tops out around 44 Hz; Arena does not document its own range.';
    note(a, 'LIVE AMBIGUITY: Framerate is a DmxScreen param in the contract and has its own help entry, but dmx.htm (v7.22, ArtSync) says the output frame rate and delay live in the DMX preferences and that all universes share them. Both ship with 7.27.1.');
    if (target === 'TT_DISABLED') note(a, 'Target is No Output. This Lumiverse is sending nothing.');
  }

  /* ---------------------------------------------------------------------
     guides — now real <ScreenGuide type="0"|"1"> children instead of a Map
     that vanished on save.
     --------------------------------------------------------------------- */
  function guideOf(sc, which) {
    const t = which === 'input' ? '0' : '1';
    return sc.guides.find(g => String(g.type) === t) || sc.addGuide(t);
  }
  function guideRows(parent, sc) {
    const id = String(sc.uniqueId);
    const imgs = ST.guides.get(id) || { input: null, output: null, opacity: 1 };
    ST.guides.set(id, imgs);
    ['input', 'output'].forEach(which => {
      const gd = guideOf(sc, which);
      const r = row(parent, which === 'input' ? 'Input Guide' : 'Output Guide');
      const b = mk('button', 'ao-btn', r, esc(gd.file ? String(gd.file).slice(0, 18) : 'Load…'));
      b.title = 'Load an image file to act as a visual guide for your pixel map.' +
        (gd.file && !imgs[which] ? '\n\n' + gd.file + ' is named in the file, but a page cannot re-open a path. Pick it again to see it.' : '');
      b.addEventListener('click', () => {
        const f = doc.createElement('input');
        f.type = 'file'; f.accept = 'image/*';
        f.addEventListener('change', () => {
          const file = f.files && f.files[0];
          if (!file) return;
          const img = new Image();
          img.onload = () => {
            push('load guide');
            imgs[which] = img;
            /* the reference is written to the guide element, so at least the
               NAME survives a save; the decoded image cannot, and does not
               pretend to */
            gd.file = file.name;
            refreshSide();
          };
          img.src = URL.createObjectURL(file);
        });
        f.click();
      });
      const x = mk('button', 'ao-btn danger', r, '✕');
      x.title = 'Clear this guide';
      x.addEventListener('click', () => { push('clear guide'); imgs[which] = null; delete gd.file; refreshSide(); });
    });
    /* Guide Opacity has no literal in the binary and no help entry — but the
       three-deep wildcard '*' '*' '*' 'Input Guide' does prove the guide is a
       multi-control fold, so SOME sub-control exists. Kept because drawGuide
       needs it, and labelled so it is not passed off as Arena's. */
    const gi = guideOf(sc, 'input'), go = guideOf(sc, 'output');
    imgs.opacity = num(gi.opacity, imgs.opacity);
    sliderRow(parent, 'Guide Opacity', () => num(imgs.opacity, 1),
      v => { imgs.opacity = v; gi.opacity = String(v); go.opacity = String(v); }, 0, 1, true);
  }

  /* ---------------------------------------------------------------------
     Slice
     --------------------------------------------------------------------- */
  function sliceInspector(sc, sl) {
    const stage = ST.stage;
    if (stage === 'output' && isAvenue()) {
      const s = sec('Output Transformation');
      note(s, 'The Output Transformation stage is available on Resolume Arena only. [output-transformation.htm]');
      return;
    }
    if (stage === 'input') {
      inputSection(sl);
      geomSection(sl, 'input', 'Input Selection', {});
      inputMaskSection(sl);
      softEdgeSection(sl);
    } else {
      /* Input Source is on BOTH stages. It was removed from this one on the
         strength of slice-routing.htm's sentence placing the dropdown "on the
         right hand side of the Input Selection stage" — but that says where to
         find it, not that it is only there, and the Arena screenshot in
         output-transformation.htm shows "Input Source | Composition" as the
         FIRST row of this panel, above X. The picture is the interface.
         Only the Source row: Input Opacity and Input Bypass/Solo are not in
         that screenshot, and stay on the Input Selection stage. */
      inputSection(sl, { sourceOnly: true });
      geomSection(sl, 'output', 'Output Transformation', { colour: true });
      outputSection(sl);
      blackLevelSection(sl);
      if (isMask(sl)) maskInvertRow(sec('Output Mask'), sl, 'OutputMaskParams',
        'By default a mask in Resolume is inverted; this switches between masking the inside and the outside. [output-transformation.htm]');
    }
    warpSection(sl, stage);
    pointSection(sl, stage);
  }

  /* <Params name="Input"> — the routing block. slice-routing.htm describes the
     dropdown "on the right hand side of the Input Selection stage", and the
     Arena screenshot in output-transformation.htm shows it as the first row of
     the OUTPUT Transformation panel too. Both stages carry Input Source; only
     the Input Selection stage carries the two toggles beside it.
     opts.sourceOnly draws the dropdown alone. */
  function inputSection(sl, opts) {
    const sourceOnly = !!(opts && opts.sourceOnly);
    const s = sec('Input');
    s.classList.add('ao-source-sec');
    const route = routeOf(sl.uniqueId);
    const srcs = sourceList();
    const av = isAvenue();
    selRow(s, 'Input Source', srcs.map(x => ({
      label: x.name + (x.available ? '' : '  (unavailable)'),
      value: routeKey(x),
      disabled: av && x.kind === 'group',
      title: av && x.kind === 'group' ? 'Groups exist in Arena only. [slice-routing.htm]' : (x.note || '')
    })), routeKey(route), v => {
      const found = srcs.find(x => routeKey(x) === v) || srcs[0];
      setRoute(sl.uniqueId, { kind: found.kind, id: found.id, name: found.name });
      refreshTree();
    });
    if (sourceOnly) return s;
    /* Arena's controls are Input Opacity and Input Bypass/Solo; the stored flags
       are their inverses. sources.htm: both are inert unless the source is a
       layer or a group — the routing graph reports that as opts.effective. */
    const t1 = togRow(s, 'Input Opacity', () => !route.ignoreOpacity,
      v => setRoute(sl.uniqueId, { ignoreOpacity: !v }),
      'On: follow the layer\'s opacity fader. Off: always show it at full.');
    const t2 = togRow(s, 'Input Bypass/Solo', () => !route.ignoreBypassSolo,
      v => setRoute(sl.uniqueId, { ignoreBypassSolo: !v }),
      'Off: bypass the layer in the Show and it STAYS VISIBLE in the slice.');
    if (!route.effective) {
      const why = 'Inert on this source. The two toggles are only functional when a specific LAYER or GROUP is the input. [sources.htm]';
      inert(t1, why); inert(t2, why);
    }
    if (route.kind === 'layer' || route.kind === 'group') {
      note(s, 'Layer and clip effects are applied. Blend modes and Show effects are NOT, and the ' +
        'slice composites with straight alpha; routing a layer deliberately bypasses the Show. [slice-routing.htm]' +
        (route.kind === 'group' ? ' The carve-out is DERIVED for groups; the manual states it for layers.' : ''));
    }
    const g = routingApi();
    if (g && typeof g.detectCycles === 'function') {
      try {
        const cyc = g.detectCycles();
        if (cyc && cyc.length) note(s, 'Routing cycle detected. The feedback path renders one frame late.');
      } catch (e) { /* an optional module that throws is still optional */ }
    }
  }

  /* Seven numbers per stage, in Arena's order. X/Y are the MIDDLE point, Left/
     Top are the EDGES — Arena's help declares both pairs separately
     (English.xml:1227/1231 input, 1323/1327 output), so four position numbers
     per stage is correct and Left/Top are NOT a clone invention. */
  function geomSection(sl, which, title, o) {
    const opt = o || {};
    const s = sec(title);

    /* A MULTI-SELECTION IS A BOX, NOT ITS FIRST SLICE.
       These seven numbers used to describe the primary slice however many were
       selected, and the panel printed a note calling that a documented
       divergence from Arena. It is a divergence that makes the fields actively
       misleading: the stage drags all of them, so the numbers described one
       slice while the gesture beside them moved five. Arena reports the
       selection's bounding box and writes back as a box transform, and so does
       this now. Slices on another screen are excluded — the box would otherwise
       span two device rasters and mean nothing. */
    const picked = () => {
      if (ST.sel.length < 2) return [sl];
      const home = screenOfSlice(sl.uniqueId);
      const list = ST.sel.map(id => sliceById(id)).filter(Boolean)
                         .filter(q => screenOfSlice(q.uniqueId) === home);
      return list.length ? list : [sl];
    };
    const boxOf = list => {
      if (list.length === 1) return rectFrame(verts(list[0], which));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      /* Output's visible selection hull is the warped outline, not the four
         unwarped outputRect vertices. Keep the inspector's multi-selection
         numbers on exactly the same geometry drawSelectionWidgets() exposes. */
      const geometry = q => which === 'output' ? outline(q, 'output', 8) : verts(q, 'input');
      for (const q of list) for (const p of geometry(q)) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      if (!isFinite(x0)) return { cx: 0, cy: 0, w: 0, h: 0, rot: 0 };
      /* An axis-aligned hull has no rotation of its own; Rotation therefore
         reads 0 for a multi-selection and turns the whole box when written. */
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rot: 0 };
    };
    const F = () => boxOf(picked());
    const setFrame = patch => {
      const list = picked();
      const f = boxOf(list), n = Object.assign({}, f, patch);
      if (list.length === 1 && typeof sl.setGeometryFrame === 'function') {
        /* Model-owned frame edits transform the complete contour. That matters
           for Input masks/polygons with more than four points, and on Output it
           carries the Bezier + homography controls through the same affine. */
        sl.setGeometryFrame(which, {
          x: n.cx, y: n.cy, width: n.w, height: n.h,
          rotation: n.rot * 180 / Math.PI
        });
        return;
      }
      /* Plain decoded records (without the live model method) keep the same
         affine fallback. Unlike the old first-four rewrite, it transforms every
         point and therefore cannot tear a mask contour. */
      const m = AF.mul(AF.move(n.cx, n.cy), AF.mul(AF.rot(n.rot),
        AF.mul(AF.scale(n.w / (f.w || 1), n.h / (f.h || 1)),
          AF.mul(AF.rot(-f.rot), AF.move(-f.cx, -f.cy)))));
      for (const q of list) { applyAffine(q, m, which); q._h = null; }
    };
    numRow(s, 'X', () => F().cx, v => setFrame({ cx: v }));
    numRow(s, 'Y', () => F().cy, v => setFrame({ cy: v }));
    numRow(s, 'Left', () => F().cx - F().w / 2, v => setFrame({ cx: v + F().w / 2 }));
    numRow(s, 'Top', () => F().cy - F().h / 2, v => setFrame({ cy: v + F().h / 2 }));
    if (!opt.noSize) {
      numRow(s, 'Width', () => F().w, v => setFrame({ w: Math.max(1, v) }));
      numRow(s, 'Height', () => F().h, v => setFrame({ h: Math.max(1, v) }));
    }
    numRow(s, 'Rotation', () => F().rot * 180 / Math.PI, v => setFrame({ rot: v * Math.PI / 180 }));
    /* Color Compensation sits on OutputAdvancedScreenSetupComponent, i.e. in
       the same fold as the output geometry [English.xml:1331]. */
    /* Colour compensation is per slice, so a selection of five wants five
       writes — the panel used to change only the primary and look as if it had
       changed them all. */
    if (opt.colour) colourRows(s, sl, 'Output', picked);
    return s;
  }

  /* <Params name="InputMask"> + <Params name="MaskParams">.
     input-selection.htm: "click on any of the preset options on the right hand
     side of the Input Selection screen". */
  const MASK_SHAPES = [
    { id: 0, label: 'None' },
    { id: 1, label: 'Square', rect: true },
    { id: 2, label: 'Circle', n: 32 },
    { id: 3, label: 'Triangle', n: 3 },
    { id: 4, label: 'Hexagon', n: 6 },
    { id: 5, label: 'Heart', heart: true },
    { id: 6, label: 'Draw' }
  ];
  const maskShapeOf = sl => clamp(Math.round(pnum(sl, ['maskshape'], 0)), 0, 6);
  const hasInputMask = sl => maskShapeOf(sl) > 0 || isMask(sl);
  /* The preset rewrites the contour as well as the param, because "maskshape"
     without a contour is a number nobody can see. makeShape's ellipse is right
     for circle/triangle/hexagon; a square is the rect itself and a heart needs
     its own curve, so neither goes through it. */
  function setMaskShape(sl, id) {
    pset(sl, 'InputMask', 'maskshape', id, 'INT', 'ParamChoice');
    const sh = MASK_SHAPES.find(x => x.id === id);
    if (!sh) return;
    const r = sl.inputRect;
    if (sh.n >= 3) { makeShape(sl, 'input', sh.n); return; }
    if (!r || !r.vertices) return;
    const f = rectFrame(r.vertices);
    if (sh.rect) { r.vertices = frameToVerts(f); return; }
    if (sh.heart) {
      const out = [];
      for (let i = 0; i < 40; i++) {
        const t = i * 2 * Math.PI / 40;
        const x = Math.pow(Math.sin(t), 3);                       /* 16 sin³t, /16 */
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16;
        const c = Math.cos(f.rot), s = Math.sin(f.rot);
        const dx = x * f.w / 2, dy = y * f.h / 2;
        out.push(P(f.cx + dx * c - dy * s, f.cy + dx * s + dy * c));
      }
      r.vertices = out;
    }
  }
  function maskInvertRow(parent, sl, block, why) {
    /* output-transformation.htm: Resolume's Mask is inverted by default so a
       newly added shape behaves like the familiar keep-inside crop. */
    const b = togRow(parent, 'Invert', () => pbool(sl, ['Invert'], true),
      v => pset(sl, block, 'Invert', v ? 1 : 0, 'BOOL'), why);
    if (!hasInputMask(sl)) inert(b, 'There is no mask on this slice yet. [English.xml:1373]');
    return b;
  }
  function inputMaskSection(sl) {
    const s = sec('Input Mask');
    if (isAvenue()) { note(s, 'Slice masks are available on Resolume Arena only! [input-selection.htm]'); return; }
    const r = row(s, 'Add');
    const box = mk('div', 'oo-shapes', r);
    MASK_SHAPES.filter(x => x.id > 0).forEach(sh => {
      const b = mk('button', 'ao-btn' + (maskShapeOf(sl) === sh.id ? ' on' : ''), box, esc(sh.label));
      b.title = sh.id === 5 ? 'Because only love can fill the void.'
        : sh.id === 6 ? 'Draw your own input mask shape on this slice.'
          : 'Quickly add a preset mask shape to this slice.';
      b.addEventListener('click', () => { push('input mask'); setMaskShape(sl, sh.id); refresh(); });
    });
    selRow(s, 'Mask Shape', MASK_SHAPES.map(x => ({ label: x.label, value: String(x.id) })),
      String(maskShapeOf(sl)), v => setMaskShape(sl, clamp(Math.round(num(v, 0)), 0, 6)))
      .title = 'The slice param literal is "maskshape". None removes the mask.';
    /* "Mask Mode" / "maskmode" are binary literals with NO help entry and no
       manual mention, so both the block they live in and their states are
       INFERRED. Bound anyway — a param that round-trips beats a missing one. */
    const mm = selRow(s, 'Mask Mode', [{ label: 'Mask', value: '0' }, { label: 'Alpha', value: '1' }],
      String(Math.round(pnum(sl, ['maskmode', 'Mask Mode'], 0))),
      v => pset(sl, 'MaskParams', 'Mask Mode', Math.round(num(v, 0)), 'INT', 'ParamChoice'));
    mm.title = 'INFERRED. "Mask Mode" and "maskmode" are binary literals; Arena documents neither their placement nor their states.';
    if (!hasInputMask(sl)) inert(mm, 'There is no mask on this slice yet.');
    maskInvertRow(s, sl, 'MaskParams', 'This will switch between masking the inside or the outside of the mask shape.');
  }

  /* <Params name="Input"> SoftEdgeEnable + the root <SoftEdging> block.
     The whole fold belongs to the INPUT stage: SoftEdgeEnable is an Input-block
     param, blending is driven by input overlap ("Overlap the Input",
     edge-blending.htm), and edge-blending.htm singles out only Black Level
     Compensation as being "available on the output tab". */
  function softEdgeSection(sl) {
    const s = sec('Soft Edge');
    const en = togRow(s, 'Enable', () => !!sl.softEdgeEnable, v => { sl.softEdgeEnable = v; },
      'Turn soft edging on or off for the current slice. The output is masked in the area where the slices overlap.');
    if (isAvenue()) inert(en, 'Edge blending is available on Resolume Arena only. [edge-blending.htm]');
    note(s, 'Enabling this produces no visible blend unless this slice\'s INPUT rectangle overlaps another slice\'s. [edge-blending.htm]');

    /* SoftEdgeGroup decides WHICH slices blend against each other. Arena stores
       it as a <SoftEdgeGroup> element; the extractor kept only its presence, so
       the toggle binds to that and any attributes read off disk are shown
       verbatim rather than guessed at. */
    togRow(s, 'Soft Edge Group', () => !!sl.softEdgeGroup, v => { sl.softEdgeGroup = v; },
      'The blend group this slice belongs to. Arena writes a <SoftEdgeGroup> element; its attributes were dropped by the extractor and are preserved verbatim on round trip.');
    const ga = sl.softEdgeGroupAttrs;
    if (ga) for (const k in ga) roRow(s, k, String(ga[k]));

    /* GLOBAL. One <SoftEdging><Params name="Soft Edge"> for the WHOLE screen
       setup — not per slice, not per screen. They are shown inside the slice's
       Soft Edge fold because that is where Arena shows them, and the note says
       what moving one of them actually does. */
    const st = setup();
    sliderRow(s, 'Power', () => st.softEdgeValue('Power', 2), v => st.setSoftEdgeValue('Power', v), 0.1, 6)
      .title = 'Steepness of the curve of the soft edge in the blending area.';
    sliderRow(s, 'Luminance', () => st.softEdgeValue('Luminance', 0.5), v => st.setSoftEdgeValue('Luminance', v), 0, 1)
      .title = 'Brightness of the centre point of the soft edge curve.';
    sliderRow(s, 'Gamma', () => st.softEdgeValue('Gamma', 2.2), v => st.setSoftEdgeValue('Gamma', v), 0.1, 4)
      .title = 'Overall brightness of the soft edge in the blending area.';
    ['Gamma Red', 'Gamma Green', 'Gamma Blue'].forEach(k =>
      sliderRow(s, k, () => st.softEdgeValue(k, st.softEdgeValue('Gamma', 2.2)), v => st.setSoftEdgeValue(k, v), 0.1, 4)
        .title = 'RGB Gamma Compensation: control the colour channels in the blending area.');
    note(s, 'Power, Luminance, Gamma and the three Gamma channels are ONE root-level <SoftEdging> block. ' +
      'They are global to the whole screen setup; moving one of them changes every blend in the show, not this slice.');

    /* CLONE EXTENSION. Arena derives the blend region from slice overlap and
       exposes no per-edge width; the renderer now does the same automatically.
       These controls are explicit per-edge overrides, kept in their own
       section so they cannot be mistaken for Arena parameters. */
    const w = sec('Soft Edge Width', true);
    note(w, 'Widths are automatic from Input overlap until an edge is changed here. An explicit 0 disables that edge. Overrides are written only to the <OpenLive> compatibility sidecar, never into the native Resolume subtree.');
    ['left', 'right', 'top', 'bottom'].forEach(k => {
      sliderRow(w, k[0].toUpperCase() + k.slice(1), () => num((sl.softEdge || {})[k], 0),
        v => { sl.softEdge = sl.softEdge || {}; sl.softEdge[k] = v; }, 0, 0.5);
    });
  }

  /* <Params name="Output"> — Flip, Is Key, Black BG. Arena's Flip is ONE
     ParamChoice with four states (binary labels "No Flip", "Flip X", "Flip Y"
     plus noFlip/flipX/flipY/flipXY), not two booleans. */
  const FLIP_STATES = [{ v: 0, label: 'No Flip' }, { v: 1, label: 'Flip X' }, { v: 2, label: 'Flip Y' }, { v: 3, label: 'Flip X Y' }];
  function flipOf(sl) {
    const v = pget(sl, isDmx(sl) ? ['flipXY', 'Flip'] : ['Flip', 'flipXY'], undefined);
    if (v !== undefined && v !== null && v !== '') return clamp(Math.round(num(v, 0)), 0, 3);
    /* a file this clone wrote before, when Flip was two invented booleans */
    return (bool(sl.flipX, false) ? 1 : 0) | (bool(sl.flipY, false) ? 2 : 0);
  }
  function setFlip(sl, n) {
    const v = clamp(Math.round(num(n, 0)), 0, 3);
    /* a DmxSlice stores its flip as the raw flipXY attribute while sharing the
       same UI control — English.xml:1285 says "this slice OR FIXTURE" */
    if (isDmx(sl)) pset(sl, 'Output', 'flipXY', v, 'INT', 'ParamChoice');
    else pset(sl, 'Output', 'Flip', v, 'INT', 'ParamChoice');
    /* the renderer reads flat flipX / flipY, so the one ParamChoice drives both */
    sl.flipX = !!(v & 1);
    sl.flipY = !!(v & 2);
    pdrop(sl, 'Flip H'); pdrop(sl, 'Flip V');
  }
  function flipRow(parent, sl) {
    return selRow(parent, 'Flip', FLIP_STATES.map(f => ({ label: f.label, value: String(f.v) })),
      String(flipOf(sl)), v => setFlip(sl, v));
  }
  function outputSection(sl) {
    const s = sec('Output');
    flipRow(s, sl).title = 'Flip the output of this slice or fixture horizontally, vertically or both. Arena calls these the Pacman icons.';
    togRow(s, 'Is Key', () => pbool(sl, ['isKey', 'Is Key'], false), v => pset(sl, 'Output', 'Is Key', v ? 1 : 0, 'BOOL'),
      'Renders alpha channels as black and white for use with broadcast mixers.');
    togRow(s, 'Black BG', () => pbool(sl, ['blackBG', 'Black BG'], false), v => pset(sl, 'Output', 'Black BG', v ? 1 : 0, 'BOOL'),
      'Renders this slice on a solid black background, even when its opacity is fully down.');
    /* The per-slice Opacity slider that used to live here is GONE: English.xml
       scopes Opacity to 'Screen' and 'Lumiverse' only, OutputAdvancedScreen-
       SetupComponent lists Brightness/Contrast/R/G/B and no opacity, and the
       contract's slice param literals have none either. */
  }
  function blackLevelSection(sl) {
    /* "Black Level Compensation is available on the output tab" [edge-blending].
       BRed is pooled by the compiler; BGreen and BBlue are literals. */
    const s = sec('Black Level Compensation');
    [['Red', 'BRed'], ['Green', 'BGreen'], ['Blue', 'BBlue']].forEach(p =>
      sliderRow(s, p[0], () => pnum(sl, [p[1]], 0), v => pset(sl, 'Black Level Compensation', p[1], v), 0, 0.5)
        .title = 'Increase the amount of ' + p[0].toLowerCase() + ' in the black of this slice.');
  }

  /* <Params name="Warping"> + <Params name="Point">. Point Mode is a param on
     the SLICE now, not a global editor toggle: two slices can be in different
     modes at once, which the old ST.pointMode could not represent. */
  function subdivCount(sl, axis) {
    const g = netOf(sl);
    const stored = pnum(sl, ['Subdivisions ' + axis.toUpperCase()], NaN);
    if (!g) return isNum(stored) ? Math.max(1, Math.round(stored)) : 1;
    /* the control net is the geometry, so it wins and the param is rewritten to
       match — the two are views of one thing and must never disagree */
    return Math.max(1, Math.round(((axis === 'x' ? g.controlWidth : g.controlHeight) - 1) / 3));
  }
  function syncSubdiv(sl) {
    const g = netOf(sl);
    if (!g) return;
    pset(sl, 'Warping', 'Subdivisions X', Math.max(1, Math.round((g.controlWidth - 1) / 3)), 'INT');
    pset(sl, 'Warping', 'Subdivisions Y', Math.max(1, Math.round((g.controlHeight - 1) / 3)), 'INT');
  }
  function warpSection(sl, stage) {
    if (ST.mode !== 'points') return;
    const s = sec('Warping');
    const poly = isPoly(sl);
    const pm = selRow(s, 'Point Mode', [{ label: 'Linear', value: '0' }, { label: 'Bezier', value: '1' }],
      pointModeOf(sl) === 'bezier' ? '1' : '0',
      v => pset(sl, 'Point', 'Point Mode', Math.round(num(v, 0)), 'INT', 'ParamChoice'));
    pm.title = 'Choose between linear and bezier interpolation modes for slice points.';
    if (poly) inert(pm, 'Bezier points are not available on poly slices. [input-selection.htm]');

    const net = netOf(sl);
    const sx = subRow(s, 'Subdivisions X', subdivCount(sl, 'x'), d => { subdivide(sl, 'x', d); syncSubdiv(sl); });
    const sy = subRow(s, 'Subdivisions Y', subdivCount(sl, 'y'), d => { subdivide(sl, 'y', d); syncSubdiv(sl); });
    if (poly || !net) {
      const why = poly ? 'A poly slice\'s points are freeform, not a rectangular warp net. [INFERRED from output-transformation.htm]'
        : 'This slice has no warp net.';
      [sx, sy].forEach(g => { inert(g.minus, why); inert(g.plus, why); });
    }
    note(s, 'Refining is exact de Casteljau; the surface does not move. CLONE CHOICE: coarsening resamples the surface, so fine detail is lost.');

    /* CLONE EXTENSION: Arena's equivalent is the right-click preset menu. */
    const r = row(s, 'Reset warp', true);
    const rb = mk('button', 'ao-btn', r, 'Identity');
    rb.title = 'Clone extension: Arena has no Reset button; its equivalent is the right-click preset menu on the slice.';
    rb.addEventListener('click', () => { push('reset warp'); if (sl.resetWarp) sl.resetWarp(); syncSubdiv(sl); refresh(); });
  }
  function pointPos(sl, p) {
    if (p.handle === 'input-corner') { const V = verts(sl, 'input'); return V[p.index] ? P(V[p.index].x, V[p.index].y) : P(0, 0); }
    if (p.handle === 'output-corner') { const cs = cornersOf(sl); return cs[p.index] ? P(cs[p.index].x, cs[p.index].y) : P(0, 0); }
    const g = netOf(sl);
    /* a control point lives in SRC space but is SEEN through the homography, so
       the number the operator reads has to be the one under the cursor */
    return (g && g.vertices[p.index]) ? applyH(matrixOf(sl), g.vertices[p.index]) : P(0, 0);
  }
  function setPointPos(sl, p, q) {
    if (p.handle === 'input-corner') sl.setInputVertex(p.index, q);
    else if (p.handle === 'output-corner') { if (!sl.setHomographyVertex('dst', p.index, q)) sl.setOutputVertex(p.index, q); }
    else {
      const inv = invert3(matrixOf(sl));
      sl.setBezierVertex(p.index, inv ? applyH(inv, q) : q);
    }
    sl._h = null;
    pset(sl, 'Point', 'X', q.x);
    pset(sl, 'Point', 'Y', q.y);
  }
  function pointSection(sl, stage) {
    if (ST.mode !== 'points') return;
    const s = sec('Point');
    const p = (ST.point && ST.point.sliceId === String(sl.uniqueId) && ST.point.stage === stage) ? ST.point : null;
    if (!p) { note(s, 'X and Y position information of the currently selected point. Click a point on the ' + (stage === 'input' ? 'Input Selection' : 'Output Transformation') + ' stage.'); return; }
    numRow(s, 'X', () => pointPos(sl, p).x, v => setPointPos(sl, p, P(v, pointPos(sl, p).y)))
      .title = 'Position of currently selected point along the x-axis in pixels.';
    numRow(s, 'Y', () => pointPos(sl, p).y, v => setPointPos(sl, p, P(pointPos(sl, p).x, v)))
      .title = 'Position of currently selected point along the y-axis in pixels.';
    roRow(s, 'Handle', p.handle === 'bezier' ? 'warp point ' + p.index : p.handle === 'input-corner' ? 'contour point ' + p.index : 'perspective corner ' + p.index);
  }

  /* ---------------------------------------------------------------------
     Fixture (DmxSlice) — none of Soft Edge, Black Level Compensation, Is Key,
     Black BG or an output Width/Height belongs to a fixture, and it is not on
     the Output Transformation stage at all.
     --------------------------------------------------------------------- */
  const BUILTIN_FIXTURES = [
    { uuid: '', name: 'RGB Pixel', pixels: 1 },
    { uuid: '83d2b59141554bccb1e9632080f11aa7', name: 'LED 16', pixels: 16 }
  ];
  function fixtureList(sl) {
    /* The Hub library extends the personalities shipped with the application;
       it does not replace them.  In particular, a persisted LED 16 UUID must
       still resolve to its 48-channel built-in personality after the Fixture
       Editor publishes an unrelated custom fixture.  UUID is the personality
       identity, so seed a Map with the built-ins and then let an external
       record with that exact UUID deliberately override it without creating a
       second dropdown row.  Map#set keeps the built-in's stable position when
       it is overridden and appends genuinely new personalities. */
    const merged = new Map();
    [...BUILTIN_FIXTURES, ...(ST.fixtures || [])].forEach(raw => {
      const f = raw || {};
      const width = Math.max(1, Math.round(num(f.width, 1)));
      const height = Math.max(1, Math.round(num(f.height, 1)));
      const record = {
        uuid: String(f.uuid == null ? (f.id == null ? '' : f.id) : f.uuid),
        name: String(f.name || f.fixtureName || f.uuid || f.id || 'Fixture'),
        pixels: Math.max(1, Math.round(num(f.pixels, num(f.pixelCount, width * height)))),
        channels: num(f.channels, num(f.channelCount, null)),
        params: Array.isArray(f.params) ? f.params
          : Array.isArray(f.parameters) ? f.parameters : null
      };
      merged.set(record.uuid, record);
    });
    const out = [...merged.values()];
    /* a personality the file refers to but the library does not have must not
       disappear from the dropdown — that would silently repatch the fixture */
    const cur = String(pget(sl, ['Fixture'], (sl.fixture && sl.fixture.uuid) || ''));
    if (cur && !out.some(f => f.uuid === cur))
      out.push({ uuid: cur, name: (sl.fixture && sl.fixture.fixtureName) || ('unknown personality ' + cur.slice(0, 8)), pixels: 1, channels: null, params: null });
    return out;
  }
  const fixtureOf = sl => {
    const cur = String(pget(sl, ['Fixture'], (sl.fixture && sl.fixture.uuid) || ''));
    return fixtureList(sl).find(f => f.uuid === cur) || fixtureList(sl)[0];
  };
  /* "the first fixture takes up 48 channels. This makes sense, as it has 16
     pixels, each with a R, G and B value ( 16 * 3 = 48 )" [dmx.htm] */
  const fixtureChannels = sl => {
    const f = fixtureOf(sl);
    return Math.max(1, Math.round(isNum(num(f.channels, NaN)) ? num(f.channels, 3) : f.pixels * 3));
  };
  function setFixture(sl, uuid) {
    const f = fixtureList(sl).find(x => x.uuid === uuid);
    pset(sl, 'Input', 'Fixture', uuid, 'STRING', 'ParamChoice');
    sl.fixture = Object.assign(sl.fixture || {}, { uuid: uuid, fixtureName: f ? f.name : '' });
  }
  /* Start Channel and DipSwitches are two views of ONE value; each edit updates
     the other, exactly as dmx.htm describes. */
  function setStartChannel(sl, v, sc) {
    const auto = pbool(sc, ['Auto Span'], true);
    const span = fixtureChannels(sl);
    const top = Math.max(1, (auto ? 512 * 16 : 512) - span + 1);
    const n = Math.round(clamp(num(v, 1), 1, top));
    pset(sl, 'Input', 'Start Channel', n, 'INT');
    pset(sl, 'Input', 'DipSwitches', n - 1, 'INT');
  }
  function fixtureSection(sc, sl) {
    const s = sec('Fixture');
    const list = fixtureList(sl);
    const cur = fixtureOf(sl);
    const fx = selRow(s, 'Fixture', list.map(f => ({ label: f.name, value: f.uuid })), cur.uuid, v => setFixture(sl, v));
    fx.title = 'Select the personality to use for this fixture slice.';
    const gear = mk('button', 'ao-btn', fx.parentNode, '⚙');
    gear.title = 'Edit the current personality or create a new one from scratch.';
    gear.addEventListener('click', () => {
      const opened = window.open('fixture-editor.html', 'openlive-fixture-editor',
        'popup=yes,width=1120,height=760,resizable=yes,scrollbars=yes');
      if (!opened) window.location.href = 'fixture-editor.html';
    });
    if (!ST.fixtures) note(s, 'Personalities live in the user\'s fixture library, which a page cannot read. This is the built-in list plus whatever the file already refers to; call setFixtures() to supply the real one.');

    const start = Math.round(pnum(sl, ['Start Channel'], 1));
    const span = fixtureChannels(sl);
    numRow(s, 'Start Channel', () => Math.round(pnum(sl, ['Start Channel'], 1)), v => setStartChannel(sl, v, sc), 1)
      .title = 'First channel in your Lumiverse that this fixture will send to. This one takes up ' + span + ' channels (' + cur.pixels + ' pixels x 3).';

    /* dmx.htm: "you can see how your dip switches should be set up visually in
       the bottom of the fixture info tab" — address - 1 in binary. */
    const dr = row(s, 'DipSwitches');
    const box = mk('div', 'oo-dip', dr);
    for (let b = 0; b < 10; b++) {
      const bit = 1 << b;
      const on = ((start - 1) & bit) !== 0;
      const btn = mk('button', on ? 'on' : '', box, String(b + 1));
      btn.title = 'Switch ' + (b + 1) + ' = ' + bit + '. Start Channel and the dip switches are two views of one value.';
      btn.addEventListener('click', () => { push('dip switch'); setStartChannel(sl, ((start - 1) ^ bit) + 1, sc); refreshSide(); });
    }

    selRow(s, 'Filter Mode', [{ label: 'Nearest', value: '0' }, { label: 'Linear', value: '1' }],
      String(Math.round(pnum(sl, ['Filter Mode'], 0))),
      v => pset(sl, 'Input', 'Filter Mode', Math.round(num(v, 0)), 'INT', 'ParamChoice'))
      .title = 'INFERRED. "Filter Mode", "Nearest" and "Linear" are binary literals with no help entry and no manual mention; read as the sampling mode the fixture uses to read its pixels out of the composition.';

    /* "Controls specific functionality of this fixture" — generated from the
       selected personality, so there is nothing to generate without one. */
    if (cur.params && cur.params.length) {
      cur.params.forEach(p => {
        const nm = String(p.name || 'Parameter');
        if (Array.isArray(p.choices) && p.choices.length)
          selRow(s, nm, p.choices.map((c, i) => ({ label: String(c), value: String(i) })),
            String(Math.round(pnum(sl, [nm], num(p.value, 0)))),
            v => pset(sl, 'Fixture', nm, Math.round(num(v, 0)), 'INT', 'ParamChoice'));
        else
          sliderRow(s, nm, () => pnum(sl, [nm], num(p.value, 0)), v => pset(sl, 'Fixture', nm, v),
            num(p.min, 0), num(p.max, 1));
      });
    } else note(s, 'DMX Parameters are generated from the selected personality; this one declares none.');

    /* "You'll see exactly which colours it's sending in the preview on the
       bottom of the slice info" [dmx.htm]. Real pixels off the routed source,
       sampled across the fixture's input rect. Rotation is ignored. */
    const pr = row(s, 'Output Preview');
    drawFixturePixels(mk('canvas', 'oo-pix', pr), sl, cur);

    overlapWarning(s, sc, sl);
  }
  function drawFixturePixels(cv, sl, info) {
    const n = Math.max(1, info ? info.pixels : 1);
    cv.width = n; cv.height = 1;
    const c = cv.getContext('2d');
    c.fillStyle = '#111318'; c.fillRect(0, 0, n, 1);
    const V = verts(sl, 'input');
    if (!V.length) return;
    const r = routeOf(sl.uniqueId);
    const src = frameFor(r.kind, r.id, 0);
    if (!src || !(src.width || src.videoWidth)) return;
    const b = bounds(V);
    try { c.drawImage(src, b.x0, b.y0, Math.max(1, b.x1 - b.x0), Math.max(1, b.y1 - b.y0), 0, 0, n, 1); }
    catch (e) { /* a source the canvas will not read is not an error worth stopping for */ }
  }
  function overlapWarning(parent, sc, sl) {
    const start = Math.round(pnum(sl, ['Start Channel'], 1));
    const end = start + fixtureChannels(sl) - 1;
    const clash = slicesOf(sc).filter(o => o !== sl && isDmx(o)).filter(o => {
      const s2 = Math.round(pnum(o, ['Start Channel'], 1)), e2 = s2 + fixtureChannels(o) - 1;
      return start <= e2 && s2 <= end;
    });
    if (clash.length) warn(parent, 'Channels ' + start + '–' + end + ' overlap ' + clash.map(sliceName).join(', ') +
      '. Resolume marks overlapping channels in red. Make sure they do not overlap. [dmx.htm]');
    if (!pbool(sc, ['Auto Span'], true) && end > 512)
      warn(parent, 'Fixture does not fit into the Lumiverse: it needs channels up to ' + end + ' and Auto Span is off.');
  }
  function fixtureInspector(sc, sl) {
    fixtureSection(sc, sl);
    /* English.xml:1229/1233/1237/1241 all say "slice, slice mask OR FIXTURE",
       so a fixture gets the full seven-number input transform. */
    geomSection(sl, 'input', 'Input Selection', {});
    /* DMX Output is a THIRD, NARROWER set: X, Y, Left, Top, Rotation. Width/
       Height (1319) and Brightness/Contrast/RGB (1331) name
       OutputAdvancedScreenSetupComponent ONLY, so a fixture has neither there. */
    const g = geomSection(sl, 'output', 'DMX Output', { noSize: true });
    flipRow(g, sl).title = 'Use the Pacman icons to flip a fixture\'s output if a tube was mounted upside down or the wrong way round. [dmx.htm]';
    /* dmx.htm: "you can adjust their brightness and contrast should that be
       necessary" — but English.xml scopes Color Compensation to the regular
       Output stage, so the PLACEMENT of these two is UNVERIFIED. */
    sliderRow(g, 'Brightness', () => pnum(sl, ['brightness', 'Brightness'], 1), v => pset(sl, 'Output', 'Brightness', v), 0, 2, true)
      .title = 'dmx.htm says a fixture can be brightness/contrast adjusted; English.xml scopes Color Compensation to the regular Output stage, so the placement is UNVERIFIED.';
    sliderRow(g, 'Contrast', () => pnum(sl, ['contrast', 'Contrast'], 1), v => pset(sl, 'Output', 'Contrast', v), 0, 2, true);
    note(g, 'A fixture has no pixel output, so it never appears on the Output Transformation stage. Arena patches it on the DMX Output stage above; drag its channel block there to change Start Channel.');
  }

  /* Transform / Edit Points live at the right end of the STAGE TOOLBAR, which
     is where output-transformation.htm shows them. One pair, gated on whichever
     stage is showing — on Input Selection they are live only once the slice has
     a slice mask or is a poly slice [input-selection.htm]; on Output
     Transformation they are Arena-only and never apply to a fixture. */
  function syncStageTools() {
    const sl = primary();
    let ok, why;
    if (ST.stage === 'output' && isDmxScreen(curScreen())) {
      host.classList.add('oo-dmx-stage');
      E.chGrid.title = 'Show DMX channel grid';
      ok = false;
      why = 'DMX Output edits fixture channel patches. Drag a fixture block to change Start Channel; Transform and Edit Points apply to spatial stages.';
      [E.tTr, E.tPt].forEach(b => { b.disabled = true; b.title = why; });
      E.tabOut.disabled = isAvenue();
      return;
    }
    host.classList.remove('oo-dmx-stage');
    E.chGrid.title = 'Slice Grid';
    if (ST.stage === 'input') {
      ok = !!sl && (isPoly(sl) || isMask(sl) || hasInputMask(sl));
      why = ok ? 'Hit T to quickly switch between Edit Points and Transform mode.'
        : 'These appear on the Input Selection stage once the slice has a slice mask or is a poly slice. [input-selection.htm]';
    } else {
      ok = !!sl && !isDmx(sl) && !isAvenue();
      why = ok ? 'Hit T to quickly switch between Edit Points and Transform mode.'
        : isAvenue() ? 'The Output Transformation stage is available on Resolume Arena only.'
          : 'A fixture has no pixel output to transform.';
    }
    [E.tTr, E.tPt].forEach(b => { b.disabled = !ok; b.title = why; });
    E.tabOut.disabled = isAvenue();
    if (isAvenue()) E.tabOut.title = 'Output Transformation, slice masks, poly slices, edge blending and DMX output are Arena only.';
  }

  function subRow(parent, label, value, apply) {
    const r = row(parent, label);
    const box = mk('div', 'oo-sub', r);
    const minus = mk('button', 'ao-btn', box, '−');
    const b = mk('b', '', box, String(value));
    const plus = mk('button', 'ao-btn', box, '+');
    minus.addEventListener('click', () => { push(label); apply(-1); refreshSide(); });
    plus.addEventListener('click', () => { push(label); apply(+1); refreshSide(); });
    return { minus: minus, plus: plus, value: b };
  }
  function setDev(sc, w, h) {
    if (!sc.outputDevice) sc.setOutputDevice('OutputDeviceVirtual', {});
    if (typeof sc.setDeviceSize === 'function') {
      sc.setDeviceSize(w, h);                  /* manual edit opts out of Follow Composition */
      return;
    }
    /* Compatibility with a pre-policy OpenLiveScreens model. */
    sc.outputDevice.width = String(Math.max(1, Math.round(num(w, 1920))));
    sc.outputDevice.height = String(Math.max(1, Math.round(num(h, 1080))));
  }

  /* Refining a warp grid: de Casteljau at t=0.5 on every patch of every row (or
     column). Exact — the surface is unchanged, there are simply more handles.
     4 -> 7 -> 13 -> 25 control points, all of the form 3n+1 the evaluator
     requires. */
  function subdivide(sl, axis, dir) {
    const g = netOf(sl);
    if (!g) return;
    const cw = g.controlWidth, ch = g.controlHeight, V = g.vertices;
    const at = (c, r) => V[r * cw + c];
    if (dir > 0) {
      if (axis === 'x') {
        const ncw = cw * 2 - 1, out = [];
        for (let r = 0; r < ch; r++) {
          const row = [];
          for (let c = 0; c < cw; c++) row.push(at(c, r));
          out.push(splitRow(row));
        }
        g.controlWidth = ncw;
        g.vertices = [].concat.apply([], out);
      } else {
        const cols = [];
        for (let c = 0; c < cw; c++) {
          const col = [];
          for (let r = 0; r < ch; r++) col.push(at(c, r));
          cols.push(splitRow(col));
        }
        const nch = ch * 2 - 1, out = new Array(nch * cw);
        for (let c = 0; c < cw; c++) for (let r = 0; r < nch; r++) out[r * cw + c] = cols[c][r];
        g.controlHeight = nch;
        g.vertices = out;
      }
    } else {
      /* CLONE CHOICE: there is no exact inverse of subdivision, so the coarser
         net is taken by sampling the SURFACE at the coarser lattice. The gross
         shape survives; detail finer than the new spacing does not. */
      const ncw = axis === 'x' ? Math.max(4, (cw - 1) / 2 + 1) : cw;
      const nch = axis === 'y' ? Math.max(4, (ch - 1) / 2 + 1) : ch;
      if (ncw === cw && nch === ch) return;
      const S = SC();
      const out = [];
      for (let r = 0; r < nch; r++) for (let c = 0; c < ncw; c++) {
        const u = ncw > 1 ? c / (ncw - 1) : 0, v = nch > 1 ? r / (nch - 1) : 0;
        const p = (S && S.evalBezier) ? S.evalBezier(g, u, v) : P(0, 0);
        out.push(P(p.x, p.y));
      }
      g.controlWidth = Math.round(ncw); g.controlHeight = Math.round(nch);
      g.vertices = out;
    }
    sl._h = null;
  }
  function splitRow(row) {
    /* row is 3n+1 control points = n cubic segments; split each at 0.5 */
    const n = (row.length - 1) / 3, out = [];
    for (let s = 0; s < n; s++) {
      const p0 = row[s * 3], p1 = row[s * 3 + 1], p2 = row[s * 3 + 2], p3 = row[s * 3 + 3];
      const mid = (a, b) => P((a.x + b.x) / 2, (a.y + b.y) / 2);
      const a = mid(p0, p1), b = mid(p1, p2), c = mid(p2, p3);
      const d = mid(a, b), e = mid(b, c), f = mid(d, e);
      if (s === 0) out.push(P(p0.x, p0.y));
      out.push(a, d, f, e, c, P(p3.x, p3.y));
    }
    return out;
  }

  /* =======================================================================
     wiring
     ======================================================================= */
  function setStage(k) {
    const next = k === 'output' ? 'output' : 'input';
    if (ST.stage !== next) { ST.pickCycle = null; ST.hover = null; }
    ST.stage = next;
    E.tabIn.classList.toggle('on', ST.stage === 'input');
    E.tabOut.classList.toggle('on', ST.stage === 'output');
    E.tabIn.setAttribute('aria-selected', ST.stage === 'input' ? 'true' : 'false');
    E.tabOut.setAttribute('aria-selected', ST.stage === 'output' ? 'true' : 'false');
    E.tabIn.tabIndex = ST.stage === 'input' ? 0 : -1;
    E.tabOut.tabIndex = ST.stage === 'output' ? 0 : -1;
    /* `.on` now does two jobs: it is the accent on the pane head, and in solo
       mode it is what makes the pane the visible one.
       The note that used to stand here argued both panes should stay equally
       big, because resizing one under the cursor mid-gesture moves the picture
       away from where the user aimed. That objection holds for a click on the
       pane itself and it still does — which is why only the TAB switches
       stages. A tab click is a deliberate change of stage, not a click at a
       coordinate, so there is no gesture for the resize to interrupt. */
    E.pIn.root.classList.toggle('on', ST.stage === 'input');
    E.pOut.root.classList.toggle('on', ST.stage === 'output');
    /* Some contract harnesses execute this state transition in isolation; the
       identity painter is a mounted-DOM concern and therefore optional here. */
    if (typeof syncStageIdentity === 'function') syncStageIdentity();
    syncPanes();
    refreshSide();
    emit('stage', ST.stage);
  }
  /* Showing both stages at once is a clone extension, not Arena — Arena moves
     between them. Kept because it is genuinely useful for checking an input
     rectangle against where it lands, and reachable from View. */
  function setSplit(v) {
    ST.split = !!v;
    E.split.classList.toggle('solo', !ST.split);
    syncPanes();
    emit('split', ST.split);
  }
  /* A pane that is not painted has no frame time, so it must not keep showing
     the last one it had. Measured on this machine: the visible stage alone
     costs 0.6ms a frame, against 0.8 + 1.7ms for both. */
  function syncPanes() {
    [E.pIn, E.pOut].forEach(p => {
      const painted = ST.split || p.key === ST.stage;
      p.root.hidden = !painted;
      if (!painted) { p.hud.textContent = ''; p.fed.textContent = ''; }
    });
  }
  function setMode(m) {
    ST.mode = m === 'points' ? 'points' : 'transform';
    ST.pickCycle = null;
    E.tTr.classList.toggle('on', ST.mode === 'transform');
    E.tPt.classList.toggle('on', ST.mode === 'points');
    refreshSide();
  }
  function setFlag(k, v) {
    ST.flags[k] = !!v;
    host.querySelectorAll('.ao-chip[data-flag]').forEach(b => b.classList.toggle('on', !!ST.flags[b.dataset.flag]));
    if (k === 'testCard') hint(v ? 'Test Card on: colour bars, resolution, time, moving diagonal' : 'Test Card off');
    if (k === 'outputOff') {
      if (v) {
        /* Display windows are owned by advanced-output.html. Broadcast sessions
           live here, so the panic latch must stop those too even though editor
           previews deliberately continue rendering. */
        for (const id of [...liveDest.keys()]) stopDest(id);
      }
      hint(v ? 'All output disabled (Ctrl+Shift+D)' : 'Output enabled');
    }
    emit('flag', { name: k, value: !!v });
  }

  E.tabIn.addEventListener('click', () => setStage('input'));
  E.tabOut.addEventListener('click', () => setStage('output'));
  E.zoomIn.addEventListener('click', () => zoomBy(ST.stage, 1.2));
  E.zoomOut.addEventListener('click', () => zoomBy(ST.stage, 1 / 1.2));
  E.fit.addEventListener('click', fitAll);
  E.undoBtn.addEventListener('click', undo);
  E.redoBtn.addEventListener('click', redo);
  E.exportBtn.addEventListener('click', () => {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Exporting output settings'); }
      catch (error) { hint(error.message, true); }
      return;
    }
    const S = SC();
    if (!S) return hint('SHOWAVE Map model is not loaded', true);
    const xml = S.serialize(setup());
    const a = doc.createElement('a');
    a.download = 'AdvancedOutput.xml';
    a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    a.click();
    hint('Exported ScreenSetupInspector XML');
  });
  E.importBtn.addEventListener('click', () => {
    const f = doc.createElement('input');
    f.type = 'file'; f.accept = '.xml,application/xml,text/xml';
    f.addEventListener('change', () => {
      const file = f.files && f.files[0];
      if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        push('import');
        try { SC().deserialize(String(rd.result), setup()); }
        catch (err) { return hint('Import failed: ' + (err && err.message), true); }
        if (renderer && renderer.setSetup) renderer.setSetup(setup());
        ST.screenId = screens().length ? screens()[0].uniqueId : null;
        ST.sel = [];
        refresh();
        hint('Imported');
      };
      rd.readAsText(file);
    });
    f.click();
  });
  E.preset.addEventListener('click', e => {
    /* the preset dropdown, top left [advanced-output.htm]. Presets are .xml
       files in Documents\Resolume Avenue-Arena 5\presets\screensetup — a browser
       cannot enumerate that folder, so the verbs that CAN work are offered and
       the one that cannot says why. */
    const r = e.currentTarget.getBoundingClientRect();
    openMenu([
      { group: 'Screen Setup' },
      { label: 'New…', fn: () => { push('new setup'); setup().clear(); ST.sel = []; ST.screenId = null; refresh(); } },
      { label: 'Save as… (Export XML)', fn: () => E.exportBtn.click() },
      { label: 'Load… (Import XML)', fn: () => E.importBtn.click() },
      { sep: 1 },
      { label: 'Reveal in Explorer (not available in a browser)', fn: () => hint('A page cannot open a file manager', true) }
    ], r.left, r.bottom);
  });
  E.addScreen.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu([
      /* the new screen's own slice is selected with it — otherwise the inspector
         shows the new screen next to the OLD screen's slice */
      { label: 'Add Screen', fn: () => { push('add screen'); const s = setup().addScreen({}); const f = s.addSlice('Slice', {}); ST.screenId = s.uniqueId; ST.sel = f ? [String(f.uniqueId)] : []; ST.point = null; refresh(); } },
      { label: 'Add Lumiverse', fn: () => { push('add lumiverse'); const s = setup().addScreen({ type: 'DmxScreen' }); const f = s.addSlice('DmxSlice', {}); ST.screenId = s.uniqueId; ST.sel = f ? [String(f.uniqueId)] : []; ST.point = null; refresh(); } },
      /* OpenLive extension — Arena's own + menu has two entries (help
         English.xml:995/:1024) and no stream concept at all, because
         streaming.htm's first sentence is that Resolume cannot stream. A
         Broadcast's child is an ordinary Slice, not a new type: unlike a
         fixture, an encoder consumes a raster, so the existing Feed machinery
         (input selection, output transformation, routing) applies unchanged. */
      { label: 'Add Broadcast', badge: 'SHOWAVE extension', fn: () => { push('add broadcast'); const s = setup().addScreen({ type: 'StreamScreen' }); const f = s.addSlice('Slice', {}); ST.screenId = s.uniqueId; ST.sel = f ? [String(f.uniqueId)] : []; ST.point = null; refresh(); } }
    ], r.left, r.top - 4);
  });
  E.addSlice.addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    const sc = curScreen();
    if (!sc) return hint('Add a screen first', true);
    const add = (kind, label, shape) => ({
      label: label, fn: () => {
        push('add ' + label);
        const sl = sc.addSlice(kind, {});
        if (sl) {
          sl.name = label.replace(/^Add /, '');
          if (shape) { makeShape(sl, 'input', shape); makeShape(sl, 'output', shape); }
          ST.sel = [String(sl.uniqueId)];
        }
        refresh();
      }
    });
    openMenu([
      { group: 'Add to ' + (sc.name || 'screen') },
      add('Slice', 'Slice'), add('Polygon', 'Polygon'), add('Polygon', 'Triangle Polygon', 3),
      { sep: 1 }, add('Mask', 'Mask'), add('Mask', 'Circle Mask', 32),
      add('Mask', 'Triangle Mask', 3), add('SliceMask', 'Input Mask'),
      { sep: 1 }, add('DmxSlice', 'Fixture')
    ], r.left, r.top - 4);
  });

  bindPane(E.pIn);
  bindPane(E.pOut);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);

  /* =======================================================================
     the frame loop entry point
     ======================================================================= */
  let lastTick = now(), fpsS = 60;
  /* UI windows and output surfaces can ask for work on the same display beat.
     One shared stamp is the contract that keeps screen-to-screen routes and
     previous-frame cycle breaks coherent across several outputs. Advancing a
     stamp independently in each popup would render the same setup multiple
     times and make the result depend on which display happened to call first. */
  const FRAME_STAMP_MIN_MS = 15;
  let lastFrameStampAt = -Infinity;
  function advanceFrame(timeMs) {
    const wall = now();
    const t = num(timeMs, wall);
    if (wall - lastFrameStampAt >= FRAME_STAMP_MIN_MS) {
      ST.timeMs = t;
      ST.stamp++;
      lastFrameStampAt = wall;
    }
    return t;
  }
  /* last strings written to the footer, so an unchanged value costs a compare
     rather than a DOM mutation — see the note in tick() */
  let lastStatTxt = null, lastZoomTxt = null;
  function tick(timeMs) {
    if (ST.destroyed) return;
    const t = advanceFrame(timeMs);
    const dt = now() - lastTick; lastTick = now();
    fpsS += ((1000 / Math.max(1, dt)) - fpsS) * 0.08;
    ST.stats.fps = fpsS;
    /* A hidden pane has a zero-size box, so painting it draws nothing and costs
       a full pass anyway. Solo mode halves the per-frame stage work. */
    const showIn = ST.split || ST.stage === 'input';
    const showOut = ST.split || ST.stage === 'output';
    if (showIn) { try { paintInput(); } catch (e) { ST.stageError.input = 'input: ' + String(e && e.message || e); } }
    if (showOut) { try { paintOutput(); } catch (e) { ST.stageError.output = 'output: ' + String(e && e.message || e); } }
    /* Arena reads "Composition( 1920, 1080 )" here — the size everything on the
       Input Selection stage is measured against. The frame rate the fps counter
       used to show is already in the status bar at the foot of the window, so
       nothing is lost by giving the space back to the number that belongs in it.
       An active-stage paint error still preempts that stage's label: a stale
       readout beside a broken renderer is the wrong thing to be reading. */
    /* FOUR DOM WRITES PER TICK, WRITING THE SAME STRINGS.
       The status text, its error class, its tooltip and the zoom label were
       rewritten on every tick — 84 times a second, measured — for text that
       changes when the composition is resized or the operator zooms, i.e.
       almost never. Assigning textContent invalidates layout even when the
       value is identical, and rewriting .title every frame is work no one can
       ever observe. Each is now compared first, which is a string compare
       against a cached value instead of a DOM mutation.
       fps is deliberately NOT in the compare key: it drifts continuously, so
       including it would defeat the whole point and rewrite the tooltip every
       tick again. It is read from the cached value when the tooltip does change,
       which is exactly as accurate as anyone reading a tooltip needs. */
    /* Input Selection is Composition-space; Output Transformation is the
       selected Screen's Device-space. The status must name the coordinate
       system that the visible stage is actually editing. */
    const outputStage = ST.stage === 'output';
    const outputScreen = ST.stage === 'output' ? curScreen() : null;
    const dmxOutput = outputStage && outputScreen && String(outputScreen.type) === 'DmxScreen';
    const dmxStatus = dmxOutput && typeof dmxLayout === 'function'
      ? dmxLayout(outputScreen)
      : null;
    const cz = outputScreen && !dmxOutput ? devSize(outputScreen) : compSize();
    const coordinateName = outputStage ? 'Output' : 'Show';
    const activeStageError = ST.stageError[ST.stage];
    const statTxt = activeStageError
      ? activeStageError.slice(0, 72)
      : outputStage && !outputScreen
        ? 'Output( no Screen )'
        : dmxOutput
          ? 'DMX Output( ' + dmxStatus.universeCount + ' universe' +
            (dmxStatus.universeCount === 1 ? '' : 's') + ', ' + dmxStatus.maxEnd + ' channels )'
        : coordinateName + '( ' +
          Math.round(cz.width) + ', ' + Math.round(cz.height) + ' )';
    if (statTxt !== lastStatTxt) {
      E.stat.textContent = statTxt;
      E.stat.classList.toggle('oo-stat-err', !!activeStageError);
      E.stat.title = activeStageError ? activeStageError
        : dmxOutput
          ? 'The Lumiverse channel patch edited by DMX Output. ' + Math.round(fpsS) + ' fps.'
        : outputScreen
          ? 'The selected Screen Device raster used by Output Transformation. ' + Math.round(fpsS) + ' fps.'
          : outputStage
            ? 'Output Transformation has no selected Screen.'
          : 'The Show canvas every Input Selection rectangle is measured in. ' +
            Math.round(fpsS) + ' fps.';
      lastStatTxt = statTxt;
    }
    const av = ST.view[ST.stage];
    if (av) {
      const zoomTxt = Math.round(av.scale * 100) + '%';
      if (zoomTxt !== lastZoomTxt) { E.zoomLbl.textContent = zoomTxt; lastZoomTxt = zoomTxt; }
    }
    syncPositionBar(); syncGestureFeedback();
    if (ST.drag) syncSide();
  }
  /* during a drag only the VALUES are rewritten — rebuilding the inspector's
     DOM every frame would eat the focus and the caret */
  function syncSide() {
    E.side.querySelectorAll('input[data-live]').forEach(inp => {
      if (doc.activeElement === inp) return;
      try { inp.value = fmt(inp._get(), 2); } catch (e) { /* a stale row is not fatal */ }
    });
  }

  function refresh() {
    if (renderer && renderer.setSetup) renderer.setSetup(setup());
    if (!ST.screenId && screens().length) ST.screenId = screens()[0].uniqueId;
    syncStageIdentity();
    refreshTree();
    refreshSide();
    paintFoot();
  }

  /* ---- boot ------------------------------------------------------------- */
  if (setup() && renderer && renderer.setSetup) renderer.setSetup(setup());
  if (screens().length) {
    ST.screenId = screens()[0].uniqueId;
    const first = slicesOf(screens()[0])[0];
    if (first) ST.sel = [String(first.uniqueId)];
  }
  setStage(ST.stage);
  setMode('transform');
  setFlag('snap', true);
  setFlag('followRouting', true);
  refresh();
  if (window.OpenLiveShowInfo && typeof window.OpenLiveShowInfo.subscribe === 'function') {
    stopShowInfoSubscription = window.OpenLiveShowInfo.subscribe(() => {
      if (!ST.destroyed) syncStreamInfoFields();
    });
  }
  if (!hasGL()) {
    hint('WebGL2 unavailable. The output window will say so rather than fake a picture', true);
  }

  /* =======================================================================
     public surface
     ======================================================================= */
  const editor = {
    version: VERSION,
    el: host,
    setSetup(s) {
      ST.setup = s || null;
      if (renderer && renderer.setSetup) renderer.setSetup(ST.setup);
      frames.clear();
      ST.sel = [];
      ST.point = null;
      ST.screenId = screens().length ? screens()[0].uniqueId : null;
      resetViewFits();
      refresh();
      return editor;
    },
    setFrameSource(fn) { ST.frameSource = typeof fn === 'function' ? fn : null; return editor; },
    setSources(list) { ST.sources = Array.isArray(list) ? list.slice() : []; refreshSide(); return editor; },
    /* Everything Arena enumerates from real hardware and a page cannot: the
       connected displays, the playback-card ports and their video formats, the
       fixture personality library, the Art-Net nodes on the network. Each one
       is the Device dropdown's or the Fixture dropdown's model, so a host that
       CAN see them makes those dropdowns real. */
    setDisplays(list) { ST.displays = Array.isArray(list) ? list.slice() : null; refresh(); return editor; },
    setCaptureDevices(list) { ST.captures = Array.isArray(list) ? list.slice() : []; refresh(); return editor; },
    setFixtures(list) { ST.fixtures = Array.isArray(list) ? list.slice() : null; refreshSide(); return editor; },
    setArtNetNodes(list) { ST.artNetNodes = Array.isArray(list) ? list.slice() : []; refreshSide(); return editor; },
    /* Half of Arena's enable rules are "Arena only" carve-outs, so which product
       this is pretending to be decides what is inert. */
    product(p) { if (p === undefined) return ST.product; ST.product = /avenue/i.test(String(p)) ? 'Avenue' : 'Arena'; refresh(); return editor; },
    selectScreen(id) {
      if (screenById(id)) {
        ST.screenId = String(id); ST.sel = []; ST.point = null; ST.pickCycle = null;
        refresh();
        emit('select', { slices: [], screenId: ST.screenId });
      }
      return editor;
    },
    selectSlice(id) { select(id == null ? [] : [id], ST.stage); return editor; },
    moveSlicesToScreen(ids,screenId,index) { return moveSlicesToScreen(ids,screenId,index); },
    stage(k) { if (k === undefined) return ST.stage; setStage(k); return editor; },
    splitStages(v) { if (v === undefined) return ST.split; setSplit(v); return editor; },
    mode(m) { if (m === undefined) return ST.mode; setMode(m); return editor; },
    tick: tick,
    /* Programme outputs are demand-driven by their presentation surfaces, not
       by whichever editor tab happens to be visible. Render every requested
       Screen on ONE stamp, in the routing graph's producer-first order. A
       dependency that is not itself presented is still rendered recursively
       by renderScreenFrame(), which is how Virtual Outputs keep working. */
    renderOutputs(timeMs, screenIds) {
      if (ST.destroyed) return { stamp: ST.stamp, frames: {} };
      advanceFrame(timeMs);
      const wanted = [];
      const seen = new Set();
      (Array.isArray(screenIds) ? screenIds : [screenIds]).forEach(id => {
        const key = String(id == null ? '' : id);
        if (key && !seen.has(key) && screenById(key)) { seen.add(key); wanted.push(key); }
      });
      let ordered = wanted.slice();
      const g = routingApi();
      if (g && typeof g.order === 'function') {
        try {
          const rank = g.order();
          if (Array.isArray(rank)) {
            ordered = rank.map(String).filter(id => seen.has(id));
            /* cycleMode:'exclude' deliberately removes every Screen in a
               persisted loop. Re-appending missing ids here silently defeated
               that safety policy and reintroduced order-dependent feedback. */
            if (g.cycleMode !== 'exclude')
              wanted.forEach(id => { if (ordered.indexOf(id) < 0) ordered.push(id); });
          }
        } catch (e) { /* a cycle policy error falls back to stable request order */ }
      }
      const out = {};
      ordered.forEach(id => {
        const sc = screenById(id);
        out[id] = sc ? renderScreenFrame(sc, 0) : null;
      });
      /* Exclusion is an explicit black/error frame, not permission to retain
         yesterday's canvas forever. Advance its stamp so presentation surfaces
         replace the frozen picture immediately. */
      if (g && g.cycleMode === 'exclude') {
        wanted.forEach(id => {
          if (ordered.indexOf(id) >= 0) return;
          const sc = screenById(id);
          if (!sc) return;
          const rec = frameRec(sc);
          rec.stamp = ST.stamp; rec.painted = 0;
          rec.reasons = ['routing cycle excluded'];
          clearRec(rec, sc);
          out[id] = rec.canvas;
        });
      }
      return { stamp: ST.stamp, frames: out };
    },
    refresh: refresh,
    setScreenEnabled(id, on) {
      const sc = screenById(id);
      if (!sc) return false;
      setScreenOn(sc, !!on);
      refreshTree(); refreshSide();
      return true;
    },
    setOutputState(id, state) {
      const key = String(id || '');
      if (!key) return false;
      ST.outputStates.set(key, Object.assign({ state: 'stopped' }, state || {}));
      if (String(ST.screenId) === key && !ST.sel.length) refreshSide();
      return true;
    },
    message(text, bad) { hint(String(text || ''), !!bad); return editor; },
    setFlag: setFlag,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return editor; },
    screenFrame(id) { const sc = screenById(id); return sc ? (frames.get(String(sc.uniqueId)) || {}).canvas || null : null; },
    /* The screens a consumer outside this window may attach to, with the state
       that decides whether attaching would produce pixels. openlive-stream.js
       needs this to offer real screen names instead of a typed-in id, and a
       chooser that listed a hidden or not-yet-rendered screen as available
       would be the "looks like it works" failure the rest of this file avoids —
       hence `rendering`, taken from whether a frame record actually exists. */
    /* ---- egress, for the footer's Go Live ---------------------------------
       Reports only what is measurable: how many enabled destinations this build
       can actually carry, how many are open, how many failed. `armable` counts
       transports that pass destCapability(), so the footer can say "2 of 3"
       rather than opening a subset and calling it success. */
    egress() {
      let total = 0, armable = 0, live = 0, connecting = 0;
      let reconnecting = 0, stopping = 0, failed = 0, retained = 0, why = null;
      for (const sc of screens()) {
        if (sc.type !== 'StreamScreen') continue;
        for (const d of (sc.destinations || [])) {
          if (!isDestinationSelected(d)) continue;
          total++;
          const cap = routeCapability(d);
          const noSavedRtmp = d.transport === 'ST_HELPER_RTMP' && !d.accountId &&
            !d.endpointRef && !(sessionUrl.get(String(d.uniqueId)) || '').trim();
          if (cap.ok && !cap.handoff && !noSavedRtmp) armable++;
          else if (!why) why = !cap.ok ? cap.why : cap.handoff
            ? 'OBS setup starts no stream. Publish in OBS, or turn this route Off before SHOWAVE Go Live.'
            : 'An enabled custom RTMP route has no saved ingest.';
        }
      }
      // Pending cleanup still belongs to this output, even if its row was removed.
      for (const rec of liveDest.values()) {
        if (rec.state === 'live') live++;
        else if (rec.state === 'connecting') connecting++;
        else if (rec.state === 'reconnecting') reconnecting++;
        else if (rec.state === 'stopping') stopping++;
        if (failedEgressRecord(rec)) {
          failed++;
          if (rec.session) retained++;
        }
      }
      return { total, armable, open: live + connecting + reconnecting + stopping + retained,
        live, connecting, reconnecting, stopping, failed, retained, blockedWhy: why };
    },
    /* ---- per-destination, for the Broadcast window ------------------------
       That window is a VIEW over this editor, not a second authority: it reads
       these and calls these, and owns no egress state of its own. Each returns
       null rather than a placeholder when there is nothing to report, so the
       caller renders an em dash instead of a zero. */
    destinationState(destId) {
      const rec = liveDest.get(String(destId));
      if (!rec) return null;
      return { state: rec.state, error: rec.error || null,
               startedAt: rec.startedAt || null,
               stopWarning: rec.stopWarning || null,
               /* The helper's per-field stream-info verdict, or null. The
                  Broadcast window renders an em dash for null rather than
                  implying the fields were applied. */
               streamInfo: rec.streamInfo || null,
               streamInfoUnreported: !!rec.streamInfoUnreported,
               fileName: (rec.session && rec.session.fileName) || null };
    },
    destinationCapability(transport) { return destCapability(transport); },
    /* Real getStats() off the live peer connection, or null. Never synthesised. */
    destinationStats(destId) {
      const rec = liveDest.get(String(destId));
      const S = hostStream();
      if (!rec || !rec.session || !S || !S.whip || typeof S.whip.stats !== 'function') return null;
      try { return S.whip.stats(rec.session); } catch (e) { return null; }
    },
    armDestination(screenId, destId) {
      const sc = screenById(screenId);
      const d = sc && sc.destinationById ? sc.destinationById(destId) : null;
      if (sc && d) armDest(sc, d);
    },
    stopDestination(destId) { const result = stopDest(destId); refresh(); return result; },
    async armAllEgress() {
      /* ONE ENCODE, N DESTINATIONS — as behaviour, not as a comment.

         This looped armDest() per destination, and armDest builds its own
         fromScreen() capture and its own relay.start() with a one-element
         array. So Go Live on three RTMP destinations produced three
         MediaRecorders, three WebSockets and three ffmpeg processes: N encodes
         for N destinations, which is exactly what openlive-relay.py exists to
         prevent. The relay's own test proves the claim only because the TEST
         passes an array; the shipped UI never did.

         RTMP destinations for one screen are now grouped into a single relay
         session. Everything else stays per-destination because it genuinely is
         a separate session: WHIP is its own RTCPeerConnection with its own
         encoder, a File is its own recorder, and OBS is a hand-off. */
      if (activeEgressCount()) {
        notify('End the current broadcast before starting another.', 'warn');
        return false;
      }
      const stale = [];
      for (const sc of screens()) {
        if (sc.type !== 'StreamScreen') continue;
        for (const d of (sc.destinations || [])) {
          if (failedEgressRecord(liveDest.get(String(d.uniqueId)))) stale.push(d);
        }
      }
      if (stale.length) await Promise.allSettled(stale.map(d =>
        Promise.resolve(stopDest(d.uniqueId))));
      if ([...liveDest.values()].some(failedEgressRecord)) {
        notify('Go Live did not start: a previous platform broadcast still needs Retry End.', 'error');
        refresh(); return false;
      }

      const selected = [];
      const blocked = [];
      for (const sc of screens()) {
        if (sc.type !== 'StreamScreen') continue;
        for (const d of (sc.destinations || [])) {
          if (!isDestinationSelected(d)) continue;
          const cap = routeCapability(d);
          const noSavedRtmp = d.transport === 'ST_HELPER_RTMP' && !d.accountId &&
            !d.endpointRef && !(sessionUrl.get(String(d.uniqueId)) || '').trim();
          if (!cap.ok || cap.handoff || noSavedRtmp) {
            blocked.push({ d: d, why: !cap.ok ? cap.why : cap.handoff
              ? 'OBS setup starts no stream. Publish in OBS, or turn this route Off before SHOWAVE Go Live.'
              : 'No saved custom ingest is selected.' });
          } else selected.push({ sc: sc, d: d });
        }
      }
      if (!selected.length && !blocked.length) {
        notify('Go Live needs at least one destination turned On.', 'warn');
        return false;
      }
      if (blocked.length) {
        notify('Go Live did not start. Every On destination must pass preflight: ' +
          blocked.map(row => row.d.name + ': ' + row.why).join(' · '), 'error');
        return false;
      }

      for (const sc of screens()) {
        if (sc.type !== 'StreamScreen') continue;
        const enabled = (sc.destinations || []).filter(d =>
          isDestinationSelected(d) && !liveDest.has(String(d.uniqueId)) && routeCapability(d).ok &&
          !routeCapability(d).handoff);
        const relayed = enabled.filter(d => d.transport === 'ST_HELPER_RTMP');
        const separate = enabled.filter(d => d.transport !== 'ST_HELPER_RTMP');
        if (relayed.length) armScreenRelay(sc, relayed);
        for (const d of separate) armDest(sc, d);
      }
      refresh();
      return true;
    },
    async stopAllEgress() {
      const work = [], seen = new Set();
      for (const id of [...liveDest.keys()]) {
        const rec = liveDest.get(id);
        if (rec && rec.grouped) {
          if (seen.has(rec.grouped)) continue;
          seen.add(rec.grouped);
        }
        work.push(Promise.resolve(stopDest(id)));
      }
      const results = await Promise.allSettled(work);
      refresh();
      return results.every(result => result.status === 'fulfilled' && result.value?.ok !== false) &&
        liveDest.size === 0;
    },
    streamInfoDraft(screenId) { return streamInfoDraft(screenId); },
    patchStreamInfo(patch, owner) { return patchStreamInfo(patch, owner); },
    screenList() {
      return screens().map(sc => {
        const rec = frames.get(String(sc.uniqueId));
        const cv = rec && rec.canvas;
        const capturable = sc.type !== 'DmxScreen';
        /* Device geometry exists before a consumer asks for the first frame.
           Reporting canvas dimensions made an idle, perfectly valid Screen
           look sizeless until retainScreen()/renderOutputs() happened. Read the
           model instead; it also means a Display mode change is visible to a
           chooser immediately, before the old frame record is resized. */
        const size = capturable ? devSize(sc) : null;
        return {
          id: String(sc.uniqueId),
          name: sc.name || 'Screen',
          type: sc.type,
          /* A detached Broadcast studio uses the configured Broadcast Screen as
             its source of truth.  These are routing/metadata values only — no
             ingest URL, stream key or bearer token can enter this read model. */
          streamInfo: sc.type === 'StreamScreen' ? streamInfo(sc) : null,
          streamInfoDraft: sc.type === 'StreamScreen' ? streamInfoDraft(sc.uniqueId) : null,
          destinationStreamInfo: sc.type === 'StreamScreen'
            ? (sc.destinations || []).filter(d => d && d.accountId).map(d => ({
                accountId: String(d.accountId),
                channelId: d.channelId == null ? '' : String(d.channelId),
                provider: d.provider == null ? '' : String(d.provider),
                platformId: d.platformId == null ? null : d.platformId,
                info: streamInfoFor(sc, d)
              }))
            : null,
          /* A Lumiverse has no pixel raster at all — its device is sizeless
             because a fixture samples single pixels rather than receiving a
             frame. It was being offered to the Stream & Record dialog as a
             capturable source, where it can only ever yield nothing. Consumers
             filter on this explicit capability rather than guessing from
             dimensions; valid idle Screens now report their Device raster. */
          capturable: capturable,
          uncapturableReason: sc.type === 'DmxScreen'
            ? 'A Lumiverse carries DMX channel data, not a frame; there is nothing to capture.'
            : null,
          width: size ? Math.max(1, Math.round(Number(size.width) || 1)) : null,
          height: size ? Math.max(1, Math.round(Number(size.height) || 1)) : null,
          rendering: !!cv,
          visible: screenOn(sc)
        };
      });
    },
    screenFrameInfo(id) {
      const sc = screenById(id);
      const rec = sc ? frames.get(String(sc.uniqueId)) : null;
      return rec ? {
        canvas: rec.canvas,
        stamp: rec.stamp,
        painted: rec.painted || 0,
        reasons: Array.isArray(rec.reasons) ? rec.reasons.slice() : []
      } : null;
    },
    get flags() { return ST.flags; },
    get stats() { return ST.stats; },
    get state() { return ST; },
    get renderer() { return renderer; },
    get lastError() { return ST.lastError; },
    destroy() {
      ST.destroyed = true;
      if (typeof stopShowInfoSubscription === 'function') stopShowInfoSubscription();
      streamInfoFields.clear();
      clearTimeout(hintTimer);
      if (cornerMessages) cornerMessages.destroy();
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keyup', onKeyUp);
      doc.removeEventListener('mousedown', onDocDown);
      closeMenu();
      try { if (renderer && renderer.dispose) renderer.dispose(); } catch (e) { /* teardown must not throw */ }
      frames.clear();
      host.innerHTML = '';
      host.classList.remove('ao');
    }
  };
  return editor;
}

return { mount: mount, version: VERSION };
})();
