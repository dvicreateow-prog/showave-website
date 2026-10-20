/* ===========================================================================
   arena-sources.js — generators that actually make pictures.
   ---------------------------------------------------------------------------
   sources.htm: "Clips can also contain Sources - like a live camera or plugins
   that generate content on the fly. Basically a clip is any type of media you
   create your output with." A source occupies a clip slot exactly like a file
   does, so it answers the same questions the engine asks any clip — it has a
   name, a duration and a playhead.

   PARAMETER NAMES ARE NOT INVENTED HERE. They come from arena-source-params.js,
   which is generated from Resolume's own preset trees under
   `default\Presets\Sources`. Each preset is a serialised RenderPass, so its
   Params block is the generator's real parameter list. An earlier version of
   this file made names up — Checkered had "Size, Speed" when Resolume ships
   "Num X, Num Y, Color 1, Color 2" — which meant every panel row was wrong and
   no preset could ever have been applied to it.

   The draw functions below are honest 2D-canvas re-implementations, keyed to
   those real names. Where Resolume's generator does something a canvas cannot,
   the parameter still exists and still shows; it just may not affect the
   picture. has() reports which generators render at all.
   =========================================================================== */
(() => {
'use strict';

const TAU = Math.PI * 2;
const DEFS = (window.ArenaPresetParams && window.ArenaPresetParams.sources) || {};
const GROUPED_SPECS = new WeakMap();

/* Most plug-ins have one Params block and keep the compact legacy object.
   Shaper has three direct sibling blocks with duplicate names. Flattening them
   silently discarded Shape 1/Shape 2, so group identity becomes part of the
   stable parameter path while the visible label remains Arena's own name. */
function presetSpec(record){
  if(!record) return null;
  if(!record.paramGroups) return record.params || null;
  let out=GROUPED_SPECS.get(record); if(out) return out;
  out={};
  Object.entries(record.paramGroups).forEach(([groupName,groupParams])=>{
    const group=groupName==='Params'?null:groupName;
    Object.entries(groupParams||{}).forEach(([name,spec])=>{
      const path=group?group+'/'+name:name;
      out[path]=Object.assign({},spec,{name,path,group});
    });
  });
  GROUPED_SPECS.set(record,out);
  return out;
}

/* Resolume's className -> the name the browser shows. The presets carry this
   as the containing folder, so the mapping is data, not a guess. */
const LABEL = {};
Object.entries(DEFS).forEach(([cls, d]) => { LABEL[d.label] = cls; });

const DRAW = {};
const impl = (label, fn) => { DRAW[label] = fn; };
const DRAW_STATUS = new WeakMap();
let DIAGNOSTIC_OBSERVER=null;
function sourceDrawStatus(ctx,name){
  const record=DRAW_STATUS.get(ctx);
  return record&&record.name===name ? Object.assign({},record)
    : {name,ok:!!DRAW[name],state:DRAW[name]?'ready':'unavailable',reason:DRAW[name]?'':'This Source has no browser renderer.'};
}
function reportSourceDraw(ctx,record){
  DRAW_STATUS.set(ctx,record);
  if(DIAGNOSTIC_OBSERVER) try{DIAGNOSTIC_OBSERVER(Object.assign({},record));}catch(error){}
}
/* SHOWAVE extensions are deliberately outside Resolume's captured catalog.
   They share the Source lifecycle and renderer, but implemented()/known()
   continue to answer the native compatibility question that their callers and
   conformance tests ask. */
const CUSTOM_LABELS = new Set();
function customSpec(label){
  const C = window.OpenLiveChaser;
  return C && label === C.sourceName && typeof C.sourceParameters === 'function'
    ? C.sourceParameters() : null;
}

/* Wire patch parameters, mined per PATCH from reference/wired/*.wired.

   These take priority over the preset data, and must, because the preset
   extractor keys by className and every Wire source serialises as
   className="WireGenerator". That merged two patches into one entry: DEFS
   labels WireGenerator "Abstract Field" and gives it ten parameters, but the
   real Abstract Field patch exposes three — Octaves, Amplitude, Density. The
   other seven are Tunnelines'. Reading the patch file instead cannot make that
   mistake, since a .wired file IS one patch. */
const WIRED = (window.ArenaWiredParams) || {};
const WIRE_TYPE = { float:'ParamRange', integer:'ParamRange',
                    color:'ParamColor', bool:'Param', text:'ParamText' };
function wireDefault(p){
  if(typeof p.d === 'number' || typeof p.d === 'boolean' || typeof p.d === 'string') return p.d;
  if(p.type === 'color' && Array.isArray(p.d) && p.d.length >= 4){
    const byte = v => Math.max(0, Math.min(255, Math.round(Number(v) * 255)));
    return (((byte(p.d[3]) << 24) | (byte(p.d[0]) << 16) |
             (byte(p.d[1]) << 8) | byte(p.d[2])) >>> 0);
  }
  return null;
}
function wiredSpec(label){
  const w = WIRED[label];
  if(!w || w.category !== 'source' || !w.params || !w.params.length) return null;
  const out = {};
  w.params.forEach(p => {
    out[p.n] = {
      node: WIRE_TYPE[p.type] || 'ParamRange',
      /* Preserve scalar and colour defaults from the Wire patch. Resource
         ports such as Slice In deliberately remain null. */
      def: wireDefault(p),
      min: p.min == null ? null : p.min,
      max: p.max == null ? null : p.max,
      choices: null, alt: null, wire: p.type, defFrom: 'wire'
    };
  });
  return out;
}

/* The parameter spec for a generator, most trustworthy source first:
   the patch file, then Resolume's preset data, then the inferred EXTRA table
   for the ones it ships neither for. */
/* --------------------------------------------------------------------------
   COLOUR DEFAULTS THE PRESETS DO NOT CARRY, RECOVERED FROM THE CORPUS.

   Only 5 of the 22 ParamColor entries under default\Presets have a default:
   Resolume serialises a parameter that was never moved off its factory value
   as bare <ParamColor/>, so silence means "unchanged", not "no colour".

   The twelve real compositions in reference/compositions are the second
   witness. Counting every <ParamColor> in them by generator and value, a value
   that repeats across many clips and several files is almost certainly the
   factory default those clips never touched — that is exactly why it repeats.
   The counts are given so the strength of each claim is visible; none of these
   is a confirmed factory default and the panel does not call them one.

     Gradient     Color 1   #0000FF  18 clips     Color 2 #007FFF  18 clips
     Sine Wave    BG Color  #000000   3 clips     (opaque)
     Stroboscope  Color 1   transparent black 2   Color 2 #FFFFFF   2 clips
     Metaballs    BG Color  transparent black 1

   Values that occur once with no repeat (Line Scape's four different Colors,
   Rings' pair, Solid Color's eleven different hues) are user choices, not
   defaults, and are deliberately NOT here. Solid Color in particular is the
   generator people pick a colour on; its modal #FFFF00 says something about
   this venue's shows, nothing about Resolume.

   THE SECOND TIER IS WEAKER AND SAYS SO. arena-engine.js falls back to opaque
   white for a colour with no default anywhere, which is the right neutral
   answer for a lone parameter and the WRONG one for a generator with two:
   Checkered came out white squares on a white ground and Spiral white arms on
   a white background — two blank frames, measured. So each generator that
   needs one carries a fallback here, and those are the colours this file used
   to hardcode. They are NOT Resolume's defaults and are not claimed to be.
   They exist so an untouched generator still draws what it drew, and the
   difference now is that every one of them is a control you can change.
   -------------------------------------------------------------------------- */
const PATCHED = new WeakMap();
/* tier 1 — modal across reference/compositions; counts in the comment above */
const CORPUS_COLOR = {
  'Gradient':    { 'Color 1': 0xFF0000FF, 'Color 2': 0xFF007FFF },
  'Sine Wave':   { 'BG Color': 0xFF000000 },
  'Stroboscope': { 'Color 1': 0x00000000, 'Color 2': 0xFFFFFFFF },
  'Metaballs':   { 'BG Color': 0x00000000 }
};
/* tier 2 — ASSUMED: this file's own previous hardcoded values */
const ASSUMED_COLOR = {
  'Checkered':     { 'Color 1': 0xFF101010, 'Color 2': 0xFFE6E6E6 },
  'Lines':         { 'Color': 0xFFE8E8E8 },
  'Rings':         { 'Color 1': 0xFF38C8FF, 'Color 2': 0xFFE85AC8 },
  'Sine Wave':     { 'Color': 0xFF3CBEFF },
  'Metaballs':     { 'Color': 0xFF3CD2FF },
  'Spiral':        { 'Color': 0xFFFFA03C, 'BG Color': 0xFF000000 },
  'Line Scape':    { 'Color': 0xFF3CDCC8 },
  'Text Animator': { 'Color': 0xFFFFBE46 },
  'Slice Outline': { 'Color': 0xFF80FFD3 },
  'Solid Color':   { 'Color': 0xFFFFFFFF }
};

/* --------------------------------------------------------------------------
   WHAT THE GENERATORS STILL DO NOT READ, AND WHY.

   This table accounts for unsupported parameters BY NAME, so the Clip panel
   can retain their captured values as read-only rows instead of offering
   a control that silently does nothing — the same rule ArenaFX.has() follows
   for an unimplemented effect.

   Three reasons, and only one of them is a shortcoming of this codebase:

   'no labels'  A ParamChoice serialised with storeChoices="0". The option
             LABELS are genuinely absent from Resolume's own data, so the
             parameter is an integer index with no known meaning. Deciding that
             Rings' Style 2 means "filled disc" would be invention, and a wrong
             guess is worse than an honest gap here: Style's shipped default IS
             2, so a wrong mapping would change what every untouched Rings clip
             looks like. This is the largest group, and it is blocked on
             evidence rather than on effort.

   context   Wired and correct, but needing something only the running app
             supplies — the composite for Video Router, the Advanced Output's
             slices for Slice Outline, the previous frame for Feedback. These
             come alive as soon as the thing they need exists.

   todo      Genuinely not built yet. Spiral's Button group is the whole of it.

   Parameters that ARE wired but only bite when another one is engaged —
   Text Animator's Delay and Animated Position, which need Animated on; its
   Anchor, which needs a non-zero Rotation; Shaper's Noise Speed, which needs a
   non-zero Noise Amount — are deliberately NOT in this table. They work. They
   are conditional, and listing them would be crying wolf.
   -------------------------------------------------------------------------- */
const NO_LABELS = 'ParamChoice with storeChoices="0": Resolume does not store the option '
                + 'names, so the index has no known meaning here and guessing one would change '
                + 'what an untouched clip looks like.';
const NEEDS_PREV = 'Needs the previous frame, which only a running clip supplies.';
const NEEDS_SLICES = 'Needs slices from the Advanced Output; with none defined there is nothing to outline.';
const SPIRAL_BUTTON = 'Not implemented: Spiral\'s Button overlay is not drawn.';
const SHAPER_TYPE = 'UNDOCUMENTED: Resolume stores this Shaper ParamChoice without option labels; '
                  + 'its numeric value is preserved, but the label/index mapping is unavailable.';
const SHAPER_SHAPE = 'Stored, animatable and mappable, but the offline renderer cannot apply this '
                   + 'Shape setting until Shaper\'s undocumented Type mapping is captured.';
const UNWIRED = {
  'Gradient':      { 'Method': NO_LABELS, 'Palette': NO_LABELS, 'Mode': NO_LABELS, 'Type': NO_LABELS },
  'Metaballs':     { 'Blend': NO_LABELS },
  'Rings':         { 'Style': NO_LABELS },
  'Shaper':        { 'Combine': NO_LABELS, 'Noise Type': NO_LABELS,
                     'Shape 1/Enabled': SHAPER_SHAPE, 'Shape 1/Type': SHAPER_TYPE,
                     'Shape 1/Ring Radius': SHAPER_SHAPE, 'Shape 1/Ring Angle': SHAPER_SHAPE,
                     'Shape 1/Rectangle Radius': SHAPER_SHAPE, 'Shape 1/Rectangle Ratio': SHAPER_SHAPE,
                     'Shape 1/Size': SHAPER_SHAPE, 'Shape 1/Position X': SHAPER_SHAPE,
                     'Shape 1/Position Y': SHAPER_SHAPE, 'Shape 1/Rotation': SHAPER_SHAPE,
                     'Shape 2/Enabled': SHAPER_SHAPE, 'Shape 2/Type': SHAPER_TYPE,
                     'Shape 2/Ring Radius': SHAPER_SHAPE, 'Shape 2/Ring Angle': SHAPER_SHAPE,
                     'Shape 2/Rectangle Radius': SHAPER_SHAPE, 'Shape 2/Rectangle Ratio': SHAPER_SHAPE,
                     'Shape 2/Size': SHAPER_SHAPE, 'Shape 2/Position X': SHAPER_SHAPE,
                     'Shape 2/Position Y': SHAPER_SHAPE, 'Shape 2/Rotation': SHAPER_SHAPE },
  'Sine Wave':     { 'Mode': NO_LABELS, 'Direction': NO_LABELS },
  'Spiral':        { 'Control Mode': NO_LABELS, 'Middle Button': NO_LABELS,
                     'Button': SPIRAL_BUTTON, 'Button Size': SPIRAL_BUTTON,
                     'Button fuzzyness': SPIRAL_BUTTON,
                     'Spread Detail': 'Not implemented: only Spread Even is read.' },
  'Text Animator': { 'Font': NO_LABELS, 'Style': NO_LABELS, 'Alignment': NO_LABELS,
                     'Range': NO_LABELS, 'Order': NO_LABELS },
  'Feedback':      { 'Feedback': NEEDS_PREV, 'Zoom': NEEDS_PREV, 'Rotation': NEEDS_PREV,
                     'Offset X': NEEDS_PREV, 'Offset Y': NEEDS_PREV, 'Hue Shift': NEEDS_PREV },
  'Slice Outline': { 'Slice In': NEEDS_SLICES }
};
function unwiredReason(label, name){
  const t = UNWIRED[label];
  return (t && t[name]) || null;
}

function specOf(label){
  const w = wiredSpec(label);
  let spec = w || customSpec(label);
  if(!spec){
    const cls = LABEL[label];
    spec = (cls && DEFS[cls]) ? presetSpec(DEFS[cls]) : (EXTRA[label] || null);
  }
  if(!spec) return null;               /* initialised before any draw() lands */
  const mined = CORPUS_COLOR[label], assumed = ASSUMED_COLOR[label];
  if(!mined && !assumed) return spec;
  /* Patch a copy, once, so the shared preset table stays exactly as mined and
     the parameter ORDER — which reader() indexes by position — is preserved.
     A shipped preset default always wins; then the corpus; then the assumption. */
  let out = PATCHED.get(spec);
  if(!out){
    out = {};
    Object.entries(spec).forEach(([n, s]) => {
      if(s.def != null){ out[n] = s; return; }
      const m = mined && mined[n], a = assumed && assumed[n];
      out[n] = m != null ? Object.assign({}, s, {def: m, defFrom: 'corpus'})
             : a != null ? Object.assign({}, s, {def: a, defFrom: 'assumed'})
             : s;
    });
    PATCHED.set(spec, out);
  }
  return out;
}
/* Look a parameter up by its real name, falling back to the preset default. */
function reader(label, values){
  const spec = specOf(label) || {};
  const names = Object.keys(spec);
  return (name, fallback) => {
    const i = names.indexOf(name);
    const v = (values && i >= 0) ? values[i] : null;
    if(v != null) return v;
    const s = spec[name];
    /* a string default is as real as a numeric one — Text and Alignment both
       have one, and dropping them sent every text generator to its fallback */
    if(s && s.def != null) return s.def;
    return fallback;
  };
}
const hsl = (h, s, l, a) => `hsla(${((h%360)+360)%360} ${s}% ${l}% / ${a==null?1:a})`;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/* --------------------------------------------------------------------------
   COLOURS, READ RATHER THAN HARDCODED.

   Every generator in this file used to paint a fixed palette — Checkered was
   '#101010' and '#e6e6e6', Solid Color was hsl(200,70,45) — while the panel
   showed Color 1 and Color 2 as controls you could drag. Twenty-three colour
   parameters behaved that way, which is precisely the "control that appears to
   work" this project refuses everywhere else. col() is what closes it.

   The value is Resolume's packed 0xAARRGGBB word (see arena-engine.js). ALPHA
   IS CARRIED THROUGH: Metaballs ships a fully transparent BG Color and
   Stroboscope a fully transparent Color 1, so dropping alpha would paint solid
   black exactly where Resolume paints nothing.

   `fb` is the CSS to use when the parameter is genuinely absent from the spec —
   a generator asking for a colour its plugin does not have. It is not a
   substitute for an unset default; arena-engine.js owns that.
   -------------------------------------------------------------------------- */
const EN_ = () => window.ArenaEngine;
function col(g, name, fb){
  const v = g(name, null);
  if(v == null) return fb;
  const n = Number(v);
  if(!Number.isFinite(n)) return typeof v === 'string' ? v : fb;
  const E = EN_();
  if(E && E.colorCss) return E.colorCss(n >>> 0);
  const w = n >>> 0, a = (w >>> 24) & 255;
  return `rgba(${(w>>>16)&255} ${(w>>>8)&255} ${w&255} / ${(a/255).toFixed(3)})`;
}
/* Pull the four channels back out of whatever col() produced, so a generator
   can interpolate between two colours (a gradient ramp) or shade one of them
   (Rings' per-ring tint) instead of falling back to a hardcoded hue. */
function cssParts(css){
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?/i.exec(css || '');
  if(m) return { r:+m[1], g:+m[2], b:+m[3], a: m[4] == null ? 1 : +m[4] };
  const hx = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec((css || '').trim());
  if(hx) return { r:parseInt(hx[1].slice(0,2),16), g:parseInt(hx[1].slice(2,4),16),
                  b:parseInt(hx[1].slice(4,6),16), a: hx[2] ? parseInt(hx[2],16)/255 : 1 };
  return { r:255, g:255, b:255, a:1 };
}
function mixCss(a, b, u){
  const p = cssParts(a), q = cssParts(b), k = clamp01(u);
  const m = (s, e) => Math.round(s + (e - s)*k);
  return `rgba(${m(p.r,q.r)} ${m(p.g,q.g)} ${m(p.b,q.b)} / ${(p.a + (q.a - p.a)*k).toFixed(3)})`;
}
/* True when a colour is fully transparent, so a generator can skip the fill
   rather than draw an invisible rectangle over what is beneath it. */
function colClear(g, name){
  const v = g(name, null);
  if(v == null) return false;
  const n = Number(v);
  return Number.isFinite(n) && (((n >>> 0) >>> 24) & 255) === 0;
}

/* --------------------------------------------------------------------------
   Generators, keyed by the label the browser shows.
   -------------------------------------------------------------------------- */
impl('Checkered', (x, g, w, h) => {
  /* real params: Num X, Num Y, Color 1, Color 2 */
  const nx = Math.max(1, Math.round(g('Num X', 32)));
  const ny = Math.max(1, Math.round(g('Num Y', 18)));
  const cw = w/nx, ch = h/ny;
  const colors = [col(g, 'Color 2', '#e6e6e6'), col(g, 'Color 1', '#101010')];
  const clear = [colClear(g, 'Color 2'), colClear(g, 'Color 1')];
  /* Each square is an independent source pixel region. Painting Color 2 over
     a full-frame Color 1 first looks identical while both are opaque, but it
     destroys Resolume's alpha contract: a translucent Color 2 becomes an
     opaque blend with Color 1 underneath. Tile both colors directly onto the
     already-cleared source surface so their alpha remains premultiplied-safe. */
  for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) {
    const parity = (i + j) & 1;
    if(clear[parity]) continue;
    x.fillStyle = colors[parity];
    x.fillRect(i*cw, j*ch, cw, ch);
  }
});

/* A branded local Source, not a renamed Resolume plug-in. Its checker raster
   comes from the same logical idea as Checkered, while OpenLiveChaser supplies
   the slice/step contract shared with chaser.html. */
if(window.OpenLiveChaser && typeof window.OpenLiveChaser.drawSource === 'function'){
  const label = window.OpenLiveChaser.sourceName;
  impl(label, (x, g, w, h, t, info) => window.OpenLiveChaser.drawSource(x, g, w, h, t, info));
  CUSTOM_LABELS.add(label);
}

/* One deterministic noise tile serves all Gradient instances. It does not
   read an HD frame or allocate another texture per frame. source-atop retains
   the gradient's existing alpha, including fully transparent color stops. */
let gradientNoiseTile=null;
function gradientDither(x,w,h,amount){
  if(!(amount>0)) return;
  if(!gradientNoiseTile){
    const tile=document.createElement('canvas'); tile.width=tile.height=64;
    const ctx=tile.getContext('2d'),pixels=ctx.createImageData(64,64);
    for(let i=0;i<4096;i++){
      let seed=Math.imul(i+1,0x45d9f3b);seed=Math.imul(seed^(seed>>>16),0x45d9f3b);
      const shade=((seed^(seed>>>16))&1)?255:0,offset=i*4;
      pixels.data[offset]=pixels.data[offset+1]=pixels.data[offset+2]=shade;pixels.data[offset+3]=255;
    }
    ctx.putImageData(pixels,0,0); gradientNoiseTile=tile;
  }
  const pattern=x.createPattern(gradientNoiseTile,'repeat'); if(!pattern) return;
  x.save(); x.globalAlpha=Math.min(32,Math.max(0,amount))/510;
  x.globalCompositeOperation='source-atop'; x.fillStyle=pattern; x.fillRect(0,0,w,h); x.restore();
}
impl('Gradient', (x, g, w, h) => {
  /* real params: Method, Color 1, Color 2, Palette, Mode, Dither, Steps, Type, Size, Angle */
  const angle = g('Angle', 0) * Math.PI/180;
  const steps = Math.max(2, Math.round(g('Steps', 24)));
  const size = g('Size', 1) || 1;
  const dx = Math.cos(angle)*w/2*size, dy = Math.sin(angle)*h/2*size;
  const grad = x.createLinearGradient(w/2 - dx, h/2 - dy, w/2 + dx, h/2 + dy);
  /* The ramp runs between the generator's OWN two colours. It used to run
     between two hardcoded hsl() values, so Color 1 and Color 2 — the whole
     point of a gradient — moved nothing. The corpus says the untouched pair is
     #0000FF to #007FFF, which is the blue ramp Gradient opens on. */
  const c1 = col(g, 'Color 1', 'rgb(0 0 255)'), c2 = col(g, 'Color 2', 'rgb(0 127 255)');
  /* Steps quantises the ramp, which is what the Banding Test presets are for.
     Two stops per step, so the band edges are hard rather than interpolated —
     a smooth ramp with more stops on it is still a smooth ramp. */
  for(let i = 0; i < steps; i++){
    const a = i/steps, b = (i + 1)/steps;
    const cA = mixCss(c1, c2, a);
    grad.addColorStop(a, cA); grad.addColorStop(Math.min(1, b - 1e-6), cA);
  }
  grad.addColorStop(1, c2);
  x.fillStyle = grad; x.fillRect(0, 0, w, h);
  gradientDither(x,w,h,Number(g('Dither',0))||0);
});

impl('Lines', (x, g, w, h, t) => {
  /* real params: Fuzzyness, Amount, Width, Rotation, Position, Color */
  const n = Math.max(1, Math.round(g('Amount', 16)));
  const width = g('Width', 0.5);
  const rot = g('Rotation', 0) * Math.PI/180;
  const pos = g('Position', 0);
  const fuzz = clamp01(g('Fuzzyness', 0));
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.save(); x.translate(w/2, h/2); x.rotate(rot); x.translate(-w/2, -h/2);
  const span = Math.hypot(w, h), pitch = span/n;
  const bar = Math.max(1, width*pitch*0.5);
  const line = col(g, 'Color', '#e8e8e8');
  /* Fuzzyness softens the edge of each bar. A hard-edged bar is a gradient with
     no ramp, so the same path draws both and the parameter is no longer inert. */
  for(let i = -n; i <= n*2; i++){
    const q = (i*pitch + pos*pitch + t*pitch) % span;
    const x0 = q - span/4;
    if(fuzz <= 0.001) x.fillStyle = line;
    else {
      const soft = x.createLinearGradient(x0, 0, x0 + bar, 0);
      const e = clamp01(fuzz*0.5);
      soft.addColorStop(0, mixCss(line, 'rgba(0 0 0 / 0)', 1));
      soft.addColorStop(e, line); soft.addColorStop(1 - e, line);
      soft.addColorStop(1, mixCss(line, 'rgba(0 0 0 / 0)', 1));
      x.fillStyle = soft;
    }
    x.fillRect(x0, -span, bar, span*3);
  }
  x.restore();
});

impl('Rings', (x, g, w, h, t) => {
  /* real params: Num Rings, Size, Spacing, Line Width, Style, Gap, Rotation,
     Rotation Step, Rotation Alternate, Color 1, Color 2 */
  const n = Math.max(1, Math.round(g('Num Rings', 8)));
  const size = g('Size', 1), spacing = g('Spacing', 1);
  const lw = g('Line Width', 0.3), gap = g('Gap', 0);
  const rot = g('Rotation', 0) * Math.PI/180;
  const step = g('Rotation Step', 0) * Math.PI/180;
  const alt = g('Rotation Alternate', 0) >= 0.5;
  const max = Math.hypot(w, h)/2 * size;
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.lineWidth = Math.max(1, lw * max/n);
  const sweep = TAU - (gap * Math.PI/180);
  /* The two colours are the ends of the ring ramp, so ring 0 is Color 1 and the
     outermost is Color 2. This was a hardcoded hsl() sweep from cyan to pink,
     which is why both colour controls did nothing.
     Style is NOT read — see UNWIRED. */
  const c1 = col(g, 'Color 1', 'rgb(56 200 255)'), c2 = col(g, 'Color 2', 'rgb(232 90 200)');
  for(let i = 0; i < n; i++){
    const r = ((i + 1)/n) * max * spacing;
    const a0 = rot + i*step*(alt && (i%2) ? -1 : 1) + t*TAU*0.1;
    x.strokeStyle = n > 1 ? mixCss(c1, c2, i/(n - 1)) : c1;
    x.beginPath(); x.arc(w/2, h/2, Math.max(1, r), a0, a0 + sweep); x.stroke();
  }
});

impl('Sine Wave', (x, g, w, h, t) => {
  /* real params: Waves, Mode, Line Width, Fuzzyness, Direction, Mirror,
     Color, BG Color, Frequency, Modulator, Modulation Depth,
     Main Speed, Modulator Speed, Amplitude, Position */
  const waves = Math.max(1, Math.round(g('Waves', 6)));
  const freq = g('Frequency', 4), modl = g('Modulator', 0), depth = g('Modulation Depth', 0);
  const mainSpeed = g('Main Speed', 2), modSpeed = g('Modulator Speed', 1);
  const amp = g('Amplitude', 0.5), pos = g('Position', 0.5);
  const lw = g('Line Width', 0.2), mirror = g('Mirror', 0) >= 0.5;
  const fuzz = clamp01(g('Fuzzyness', 0.08));
  /* BG Color, not black. The corpus says the untouched value IS opaque black,
     which is why this looked right while the control did nothing.
     Mode and Direction are NOT read — see UNWIRED. */
  if(!colClear(g, 'BG Color')){ x.fillStyle = col(g, 'BG Color', '#000'); x.fillRect(0, 0, w, h); }
  const line = col(g, 'Color', 'rgb(60 190 255)');
  x.lineWidth = Math.max(1, lw * 6);
  /* Fuzzyness is a glow around the stroke — the canvas shadow does it without a
     second pass, and shadowColor keeps the wave's own colour. */
  x.shadowBlur = fuzz * 18; x.shadowColor = fuzz > 0.001 ? line : 'transparent';
  for(let k = 0; k < waves; k++){
    x.strokeStyle = waves > 1 ? mixCss(line, 'rgba(255 255 255 / 1)', (k/waves)*0.45) : line;
    x.beginPath();
    for(let i = 0; i <= w; i += 2){
      const u = i/w;
      const m = depth ? Math.sin(u*modl*TAU + t*modSpeed*TAU) * depth : 0;
      const y = h*pos + Math.sin(u*freq*TAU + t*mainSpeed*TAU + k*0.5 + m) * h*0.4*amp;
      i ? x.lineTo(i, y) : x.moveTo(i, y);
    }
    x.stroke();
    if(mirror){
      x.save(); x.translate(0, h); x.scale(1, -1);
      x.beginPath();
      for(let i = 0; i <= w; i += 2){
        const u = i/w;
        const m = depth ? Math.sin(u*modl*TAU + t*modSpeed*TAU) * depth : 0;
        const y = h*pos + Math.sin(u*freq*TAU + t*mainSpeed*TAU + k*0.5 + m) * h*0.4*amp;
        i ? x.lineTo(i, y) : x.moveTo(i, y);
      }
      x.stroke(); x.restore();
    }
  }
  x.shadowBlur = 0; x.shadowColor = 'transparent';
});

impl('Metaballs', (x, g, w, h, t) => {
  /* real params: Grid, Blend, Size, Distance, Radius, Fuzzyness, Speed,
     Position X, Position Y, Color, BG Color */
  const grid = Math.max(1, Math.round(g('Grid', 3)));
  const size = g('Size', 0.4), dist = g('Distance', 0.5), speed = g('Speed', 3);
  const px = g('Position X', 0), py = g('Position Y', 0);
  const radius = g('Radius', 0.5), fuzz = clamp01(g('Fuzzyness', 0.1));
  /* BG Color ships fully transparent in the corpus, and a transparent
     background must STAY transparent — filling black here is what stopped a
     Metaballs clip ever compositing over the layer beneath it.
     Blend is NOT read — see UNWIRED. */
  if(!colClear(g, 'BG Color')){ x.fillStyle = col(g, 'BG Color', '#000'); x.fillRect(0, 0, w, h); }
  /* Size scales the ball, Radius scales its falloff — two separate controls in
     Resolume, and Radius used to be one of them that did nothing. */
  const r = Math.max(1, size * Math.min(w, h) * 0.6 * Math.max(0.05, radius*2));
  const ball = col(g, 'Color', 'rgb(60 210 255)');
  x.globalCompositeOperation = 'lighter';
  const n = grid * grid;
  for(let i = 0; i < n; i++){
    const a = t*speed*0.6 + i*TAU/n;
    const cx = w/2 + px*w/2 + Math.cos(a*1.3 + i)*w*0.35*dist;
    const cy = h/2 + py*h/2 + Math.sin(a*1.7 + i*2)*h*0.35*dist;
    const grd = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    /* Fuzzyness moves where the falloff starts: 0 is a hard-edged disc, 1 a
       gradient all the way in from the centre. */
    grd.addColorStop(0, ball);
    grd.addColorStop(clamp01(1 - fuzz), ball);
    grd.addColorStop(1, mixCss(ball, 'rgba(0 0 0 / 0)', 1));
    x.fillStyle = grd; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }
  x.globalCompositeOperation = 'source-over';
});

impl('Spiral', (x, g, w, h, t) => {
  /* real params: Direction, Control Mode, Detail, Speed, Zoom, Leafs,
     Distortion, Fuzzyness, Ramification, Spread Even, ... */
  const detail = Math.max(1, Math.round(g('Detail', 5)));
  const speed = g('Speed', 0.6), zoom = g('Zoom', 1);
  const leafs = Math.max(1, Math.round(g('Leafs', 3)));
  const distort = g('Distortion', 1)/100;
  const dir = g('Direction', 0) >= 0.5 ? -1 : 1;
  const fuzz = clamp01(g('Fuzzyness', 0.1));
  const ramif = g('Ramification', 0), spread = g('Spread Even', 1);
  /* Direction, Control Mode and Middle Button are NOT read — see UNWIRED. */
  if(!colClear(g, 'BG Color')){ x.fillStyle = col(g, 'BG Color', '#000'); x.fillRect(0, 0, w, h); }
  const arm = col(g, 'Color', 'rgb(255 160 60)');
  const max = Math.hypot(w, h)/2 / Math.max(0.1, zoom);
  x.lineWidth = 2;
  x.shadowBlur = fuzz * 16; x.shadowColor = fuzz > 0.001 ? arm : 'transparent';
  x.strokeStyle = arm;
  /* Ramification splits each arm into extra branches; at 0 there is one arm per
     leaf, which is the shipped default and the picture that was there before. */
  const branches = 1 + Math.max(0, Math.round(ramif));
  for(let a = 0; a < leafs; a++) for(let br = 0; br < branches; br++){
    x.beginPath();
    const steps = detail * 40;
    /* Spread Even distributes the branches evenly around the arm; it is a
       0..10 range in Resolume and scales that offset. */
    const off = branches > 1 ? (br/branches) * (TAU/leafs) * clamp01(spread/10) : 0;
    for(let s = 0; s <= steps; s++){
      const q = s/steps, r = q*max;
      const ang = dir*(q*TAU*detail*0.6) + a*TAU/leafs + off + t*speed*TAU
                + Math.sin(q*TAU*3)*distort*2;
      const cx = w/2 + Math.cos(ang)*r, cy = h/2 + Math.sin(ang)*r;
      s ? x.lineTo(cx, cy) : x.moveTo(cx, cy);
    }
    x.stroke();
  }
  x.shadowBlur = 0; x.shadowColor = 'transparent';
});

impl('Stroboscope', (x, g, w, h, t, info) => {
  /* real params: Frequency, Fade, Color 1, Color 2.

     A STROBE IS TWO COLOURS, NOT A GREY RAMP. This used to compute one
     brightness and paint rgb(c,c,c), so both colour controls were inert and the
     generator rendered a flat white frame at its default — the panel offered
     four parameters and the picture answered to none of them.

     The two colours are what it alternates between, and reference/compositions
     carries the untouched pair on two clips in two files: Color 1 fully
     TRANSPARENT black, Color 2 opaque white. That is the strobe — flashes of
     white over nothing, so the layers below show through between flashes. A
     version that dropped alpha painted solid black there instead.

     Fade is a <Param>, i.e. a bool: off gives a hard square-wave flash, on
     ramps Color 2 back down to Color 1 across the beat. */
  const freq = g('Frequency', 0.5);
  const fade = g('Fade', 0) >= 0.5;
  const rate = 1 + freq*30;
  const beats = (info && typeof info.beats === 'number') ? info.beats : (t || 0) * 4;
  const phase = ((beats * rate) % 1 + 1) % 1;
  const v = fade ? Math.max(0, 1 - phase) : (phase < 0.5 ? 1 : 0);
  const c1 = col(g, 'Color 1', 'rgba(0 0 0 / 0)'), c2 = col(g, 'Color 2', '#ffffff');
  x.clearRect(0, 0, w, h);
  x.fillStyle = mixCss(c1, c2, v);
  x.fillRect(0, 0, w, h);
});

impl('Text Animator', (x, g, w, h, t, info) => {
  /* real params: Text, Font, Style, Color, Size, Alignment, Position X/Y,
     Spacing X/Y, Animated, Range, Order, Delay, Opacity, Scale,
     Animated Position X/Y, Rotation, Anchor X/Y.

     THE NAME IS THE SPEC: this is the animator, so it lays out and moves the
     characters INDIVIDUALLY. It used to draw the whole string as one fillText
     in a hardcoded amber and slide it sideways on a sine, which left sixteen of
     its twenty-one parameters — including Color, Spacing, Delay, Rotation and
     the whole Animated group — with nothing to do.

     Font, Style, Alignment, Range and Order stay unread: they are ParamChoice
     written with storeChoices="0", so the option LABELS are genuinely not in
     the data and picking meanings for the indices would be invention. See
     UNWIRED, which says so in the panel rather than leaving them silent. */
  const size = Math.max(8, g('Size', 1) * h * 0.12);
  const posX = g('Position X', 0), posY = g('Position Y', 0);
  const scale = g('Scale', 1);
  const spX = g('Spacing X', 0), spY = g('Spacing Y', 0);
  const animated = g('Animated', 0) >= 0.5;
  const delay = Math.max(0, g('Delay', 100));
  const opacity = clamp01(g('Opacity', 1));
  const apX = g('Animated Position X', 0), apY = g('Animated Position Y', 0);
  const rot = g('Rotation', 0);
  const ancX = g('Anchor X', 0), ancY = g('Anchor Y', 0);

  x.clearRect(0, 0, w, h);
  x.font = `700 ${size}px system-ui, sans-serif`;
  x.textBaseline = 'middle';
  /* Text is a ParamText in Resolume's own preset, so now that makeParams gives
     it a string control it is the thing that should be drawn — the clip name
     is only the fallback for an empty one. */
  const label = String(g('Text', '') || (info && info.label) || 'SHOWAVE');
  const chars = [...label];
  if(!chars.length || scale <= 0 || opacity <= 0) return;

  /* Lay the string out once so the whole block can be centred, then place each
     character from that layout. Spacing X is Resolume's -20..200 tracking. */
  const widths = chars.map(c => x.measureText(c).width);
  const track = spX * (size/100);
  const total = widths.reduce((s, v) => s + v, 0) + track * (chars.length - 1);
  const scaleFor = h/1080;                  /* Position is in output pixels */
  const baseX = w/2 - (total*scale)/2 + posX*scaleFor;
  const baseY = h/2 + posY*scaleFor;
  const fill = col(g, 'Color', 'rgb(255 190 70)');

  /* One clock for the stagger. Delay is in milliseconds per character in
     Resolume; the phase is taken from the clip's own position so it is
     deterministic and scrubs with the playhead rather than free-running. */
  const clock = (info && typeof info.beats === 'number') ? info.beats : (t || 0) * 4;
  let pen = 0;
  chars.forEach((ch, i) => {
    /* progress 0..1 for THIS character. Not animated: everything is settled. */
    let prog = 1;
    if(animated){
      const per = delay/1000;               /* seconds of stagger per character */
      const span = per*chars.length + 1;
      const cyc = span > 0 ? ((clock/2) % span) : 0;
      prog = clamp01(cyc - i*per);
    }
    const ease = prog*prog*(3 - 2*prog);    /* smoothstep, so it settles */
    /* Animated Position is where the character comes FROM; it decays to zero as
       that character settles. Spacing Y is a permanent per-character stagger
       down the line and is not part of the animation. */
    const ox = apX * scaleFor * (1 - ease);
    const oy = apY * scaleFor * (1 - ease) + spY*(size/100)*i;
    x.save();
    x.globalAlpha = opacity * (animated ? ease : 1);
    x.translate(baseX + pen*scale + ox, baseY + oy);
    /* Anchor moves the point the character rotates and scales about. */
    x.translate(ancX*scaleFor, ancY*scaleFor);
    if(rot) x.rotate(rot);
    x.scale(scale, scale);
    x.translate(-ancX*scaleFor, -ancY*scaleFor);
    x.fillStyle = fill;
    x.fillText(ch, 0, 0);
    x.restore();
    pen += widths[i] + track;
  });
});

/* --- the two I had wrongly marked unavailable ----------------------------- */
impl('Line Scape', (x, g, w, h, t) => {
  /* real params: Tilt, Direction, Position Y, Speed, Height, Jagginess, Wobble,
     Attenuation, Line Width, Fuzzyness, Color, Show Knots */
  const tilt = g('Tilt', 45), speed = g('Speed', 1), height = g('Height', 8);
  const lw = g('Line Width', 1), atten = g('Attenuation', 120);
  const posY = g('Position Y', 0), wobble = g('Wobble', 0);
  const dir = g('Direction', 0) * Math.PI/180;
  const jag = g('Jagginess', 0), fuzz = clamp01(g('Fuzzyness', 0.5));
  const knots = g('Show Knots', 1) >= 0.5;
  const line = col(g, 'Color', 'rgb(60 220 200)');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.lineWidth = Math.max(0.5, lw);
  /* Direction turns the whole landscape; Resolume gives it as -180..180. */
  x.save(); x.translate(w/2, h/2); x.rotate(dir); x.translate(-w/2, -h/2);
  x.shadowBlur = fuzz * 12; x.shadowColor = fuzz > 0.001 ? line : 'transparent';
  const rows = 22, horizon = h * (0.15 + posY/70);
  /* A deterministic hash, not Math.random: the ridges must be the same ridges
     on every frame, or Jagginess reads as noise rather than terrain. */
  const jitter = (a, b) => { let s = (a*73856093) ^ (b*19349663); s = (s ^ (s >>> 13)) >>> 0;
                             return (s % 2000)/1000 - 1; };
  for(let r = 0; r < rows; r++){
    const q = r/rows;
    const y = horizon + Math.pow(q, 1 + tilt/90) * (h - horizon);
    /* Distance fades the line out; the hue ramp it used to invent is gone and
       the generator's own Color carries it. */
    x.strokeStyle = mixCss(mixCss(line, 'rgba(0 0 0 / 0)', 1), line, 0.25 + q*0.75);
    x.beginPath();
    const pts = [];
    for(let i = 0; i <= w; i += 4){
      const u = i/w;
      const amp = (h*0.06) * (height/23) * (1 - q*0.5) * (atten/300 + 0.4);
      const yy = y + Math.sin(u*TAU*3 + r*0.6 + t*speed*TAU) * amp
                   + Math.sin(u*TAU*11 + t*speed*TAU*1.7) * amp * wobble * 0.35
                   + jitter(i, r) * amp * jag;
      pts.push([i, yy]);
      i ? x.lineTo(i, yy) : x.moveTo(i, yy);
    }
    x.stroke();
    /* Show Knots marks the control points the ridge is built from. */
    if(knots){
      x.fillStyle = line;
      for(let k = 0; k < pts.length; k += 8) x.fillRect(pts[k][0] - 1, pts[k][1] - 1, 2, 2);
    }
  }
  x.shadowBlur = 0; x.shadowColor = 'transparent';
  x.restore();
});

impl('Shaper', (x, g, w, h, t) => {
  /* real params: Combine, Round, Phase, Scale, Noise Type, Noise Amount,
     Noise Speed, Color, Outline, Outline Color */
  const round = g('Round', 0.3), phase = g('Phase', 0);
  const scale = g('Scale', 1) || 1;
  const noise = g('Noise Amount', 0), nspeed = g('Noise Speed', 0.3);
  const outline = g('Outline', 0.1);
  /* Both colours ship a REAL default in the presets — Color opaque white
     (4294967295) and Outline Color amber (4294955037 = #FFD01D) — so this is
     one of the five that never needed a corpus fallback, and one of the
     twenty-three that was hardcoded anyway. Combine and Noise Type are
     ParamChoice with no labels in the data; see UNWIRED. */
  x.clearRect(0, 0, w, h);
  const R = Math.min(w, h) * 0.36 * scale;
  const sides = Math.max(3, Math.round(3 + (1 - round)*9));
  x.beginPath();
  for(let i = 0; i <= sides; i++){
    const a = (i/sides)*TAU + phase*TAU + t*TAU*0.15;
    const wob = 1 + Math.sin(a*3 + t*nspeed*TAU*4) * noise * 0.3;
    const px = w/2 + Math.cos(a)*R*wob, py = h/2 + Math.sin(a)*R*wob;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.closePath();
  if(!colClear(g, 'Color')){ x.fillStyle = col(g, 'Color', '#ffffff'); x.fill(); }
  if(outline > 0 && !colClear(g, 'Outline Color')){
    x.lineWidth = Math.max(1, outline*20);
    x.strokeStyle = col(g, 'Outline Color', 'rgb(255 208 29)'); x.stroke();
  }
});

impl('Abstract Field', (x, g, w, h, t) => {
  /* WireGenerator — real params: Octaves, Amplitude, Density, Color 1, Color 2,
     Line Width, Zoom, Vertical, Horizontal, Frequency */
  const oct = Math.max(1, Math.round(g('Octaves', 3)));
  const amp = g('Amplitude', 0.5), dens = g('Density', 0.5);
  const lw = g('Line Width', 0.01), zoom = g('Zoom', 1.5) || 1, freq = g('Frequency', 0.08);
  /* This patch's two colours DO ship defaults — #2222FF and #A55400, straight
     out of Abstract Field.wired — and they were the ramp this drew by hand. */
  const c1 = col(g, 'Color 1', 'rgb(34 34 255)'), c2 = col(g, 'Color 2', 'rgb(165 84 0)');
  x.fillStyle = '#05070d'; x.fillRect(0, 0, w, h);
  const lines = Math.max(3, Math.round(6 + dens*40));
  x.lineWidth = Math.max(0.6, lw * 60);
  for(let l = 0; l < lines; l++){
    const q = l/lines;
    x.strokeStyle = mixCss(c1, c2, q);
    x.beginPath();
    for(let i = 0; i <= w; i += 4){
      const u = (i/w) * zoom;
      let y = h*q;
      for(let o = 1; o <= oct; o++)
        y += Math.sin(u*TAU*freq*o + t*TAU*0.3*o + l*0.4) * (h*0.12*amp)/o;
      i ? x.lineTo(i, y) : x.moveTo(i, y);
    }
    x.stroke();
  }
});
impl('Tunnelines', (x, g, w, h, t) => {
  /* also a WireGenerator patch — concentric perspective lines.
     Its ten parameters come from Tunnelines.wired; six of them did nothing.
     Vertical and Horizontal shift the vanishing point, which is what makes a
     tunnel look like it is turning rather than only rushing at you. */
  const zoom = g('Zoom', 1.5) || 1, freq = g('Frequency', 0.08), amp = g('Amplitude', 0.5);
  const lw = g('Line Width', 0.01);
  const vert = g('Vertical', 0.080729), horiz = g('Horizontal', 0.08774);
  const c1 = col(g, 'Color 1', 'rgb(34 34 255)'), c2 = col(g, 'Color 2', 'rgb(165 84 0)');
  x.fillStyle = '#05070d'; x.fillRect(0, 0, w, h);
  const rings = 26, max = Math.hypot(w, h)/2;
  /* Vertical/Horizontal are 0..1 with the patch's defaults just off centre, so
     they are read as an offset from the middle of the frame. */
  const cx = w/2 + (horiz - 0.5)*w*0.6, cy = h/2 + (vert - 0.5)*h*0.6;
  x.lineWidth = Math.max(0.6, lw * 150);
  for(let i = 0; i < rings; i++){
    const q = ((i/rings) + (t*0.35*freq)) % 1;
    const r = Math.pow(q, 2.2) * max * zoom;
    /* Near rings are Color 1, far rings Color 2, and distance still fades. */
    x.strokeStyle = mixCss(mixCss(c1, c2, q), 'rgba(0 0 0 / 0)', 1 - (0.2 + q*0.8));
    x.beginPath();
    for(let s = 0; s <= 48; s++){
      const a = s/48*TAU;
      const rr = r * (1 + Math.sin(a*5 + t*TAU*0.5)*0.08*amp);
      const px = cx + Math.cos(a)*rr, py = cy + Math.sin(a)*rr;
      s ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.closePath(); x.stroke();
  }
});

/* --- trivially real ------------------------------------------------------- */
/* SOLID COLOR HAD NO PARAMETERS AT ALL, which for the generator whose entire
   job is "be the colour I chose" is the starkest version of the problem this
   file just fixed elsewhere: it painted a hardcoded hsl(200,70,45) and the
   Clip panel offered nothing to change it with.

   It ships no preset, so DEFS has no entry — but it is not undocumented. The
   twelve compositions in reference/compositions contain 22 SolidColor clips
   carrying <ParamColor name="Color">, eleven of them on one value and ten more
   spread across nine others. The parameter is therefore real, named "Color",
   and the only thing the corpus cannot settle is its factory default (those
   are user choices — people pick a colour on a Solid Color). Opaque white is
   the fallback and arena-engine.js labels it as assumed. */
impl('Solid Color', (x, g, w, h) => {
  if(colClear(g, 'Color')){ x.clearRect(0, 0, w, h); return; }
  x.fillStyle = col(g, 'Color', '#ffffff'); x.fillRect(0, 0, w, h);
});
impl('Blank', (x, g, w, h) => { x.clearRect(0, 0, w, h); });
impl('Static', (x, g, w, h) => {
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  const s = 2;
  for(let yy = 0; yy < h; yy += s) for(let xx = 0; xx < w; xx += s){
    const v = Math.random(); if(v < 0.7){ const c = (v*255)|0;
      x.fillStyle = `rgb(${c},${c},${c})`; x.fillRect(xx, yy, s, s); }
  }
});
impl('Test Card', (x, g, w, h) => {
  const bars = ['#c0c0c0','#c0c000','#00c0c0','#00c000','#c000c0','#c00000','#0000c0'];
  bars.forEach((c, i) => { x.fillStyle = c; x.fillRect(i*w/bars.length, 0, w/bars.length + 1, h*0.7); });
  x.fillStyle = '#111'; x.fillRect(0, h*0.7, w, h*0.3);
  x.strokeStyle = '#fff'; x.lineWidth = 2;
  x.beginPath(); x.ellipse(w/2, h/2, Math.min(w,h)*0.42, Math.min(w,h)*0.42, 0, 0, TAU); x.stroke();
  x.strokeRect(1, 1, w-2, h-2);
});

/* ==========================================================================
   THE FOUR GENERATORS RESOLUME SHIPS NO PRESET FOR
   --------------------------------------------------------------------------
   Feedback, Slice Outline, Text Block and Video Router are listed in the
   Sources panel but `default\Presets\Sources` contains no preset for any of
   them, so — unlike the twelve above — their parameter names cannot be read
   out of Resolume's own data. Searching the twelve-composition corpus in
   `reference/compositions/` finds Video Router twice, as
   <VideoSource type="CompositionRouterVideoSource">, and in BOTH instances the
   element carries no <Params> block at all: the type name is real, the
   parameter names are not recoverable from it. The other three do not appear.

   So EXTRA below is INFERRED, and says so. Where a name means the same thing
   as one Resolume really does ship on a sibling generator (Text Animator's
   Text / Size / Position X / Position Y / Alignment) that real name is reused
   rather than a new one coined. Video Router's three are taken from the words
   sources.htm itself uses: "The toggles for Input Bypass/Solo and Input
   Opacity", "the selection will refer to the index of the selected item".
   ========================================================================== */
const EXTRA = {
  'Video Router': {
    /* sources.htm > Routing. Options are rebuilt from the live layer and group
       list by app.js, because "the Input options show the sources by their
       names" and those names change. */
    'Input':         { node:'ParamChoice', kind:'choice', options:['Layers Below'], def:'Layers Below' },
    'Input Opacity': { node:'Param', def:1 },
    'Input Bypass':  { node:'Param', def:1 },
    'Input Solo':    { node:'Param', def:1 }
  },
  'Text Block': {
    'Text':        { node:'ParamText', def:'' },
    'Size':        { node:'ParamRange', def:0.12, min:0.01, max:1 },
    'Line Height': { node:'ParamRange', def:1.2, min:0.5, max:3 },
    'Alignment':   { node:'ParamChoice', kind:'choice', options:['Left','Center','Right'], def:'Left' },
    'Position X':  { node:'ParamRange', def:0, min:-1, max:1 },
    'Position Y':  { node:'ParamRange', def:0, min:-1, max:1 },
    'Margin':      { node:'ParamRange', def:0.06, min:0, max:0.45 }
  },
  /* Slice Outline is NOT here any more: its real parameters are mined from
     reference/wired/Slice Outline.wired (Slice In, Color, Thickness) and
     specOf() reads the patch file first. The four names this table used to
     carry — Line Width, Fill, Show Names, Hue — were invented. */
  /* Solid Color ships no preset, so its parameter list is not in DEFS. It is
     not guesswork either: 22 SolidColor clips across the twelve compositions in
     reference/compositions carry <ParamColor name="Color">, which is the whole
     plugin. Without this entry the generator had ZERO parameters and painted a
     hardcoded blue. */
  'Solid Color': {
    'Color': { node:'ParamColor', t:'COLOR', kind:'color', def:null }
  },
  'Feedback': {
    'Feedback':   { node:'ParamRange', def:0.9,  min:0, max:1 },
    'Zoom':       { node:'ParamRange', def:1.03, min:0.8, max:1.2 },
    'Rotation':   { node:'ParamRange', def:1.5,  min:-30, max:30 },
    'Offset X':   { node:'ParamRange', def:0,    min:-0.1, max:0.1 },
    'Offset Y':   { node:'ParamRange', def:0,    min:-0.1, max:0.1 },
    'Hue Shift':  { node:'ParamRange', def:6,    min:-60, max:60 }
  }
};

/* Video Router is the only one of the four that cannot draw anything from its
   own parameters: it needs the composite. app.js hands it over in info.router
   and only while a router is actually playing — see the ROUTER block there.
   With nothing handed over the honest answer is a still black frame, not a
   fabricated picture, so this returns without painting. */
impl('Video Router', (x, g, w, h, t, info) => {
  const R = info && info.router;
  if(!R) return;
  const resolved = R.resolve(g('Input', 'Layers Below'), {
    opacity: !!g('Input Opacity', 1),
    bypass:  !!g('Input Bypass', 1),
    solo:    !!g('Input Solo', 1)
  });
  /* Named routed targets are leased while nested Router graphs render. Plain
     canvases remain valid for Layers Below and Preview. Always release after
     drawImage has consumed the frame, including when the draw itself fails. */
  const leased = !!(resolved && resolved.canvas && typeof resolved.release === 'function');
  const cv = leased ? resolved.canvas : resolved;
  try { if(cv) x.drawImage(cv, 0, 0, w, h); }
  finally { if(leased) resolved.release(); }
});

/* Draws every Advanced Output slice's INPUT rectangle — the region of the
   composition that slice grabs — in composition space, which is what makes it
   usable as a mapping aid on a layer above the content. Geometry is the live
   one from OpenLiveScreens, not a copy: move a slice in the editor and this
   moves with it. No screens set up means no outlines, and that is drawn as
   nothing rather than as an invented grid. */
impl('Slice Outline', (x, g, w, h) => {
  /* window.ArenaSlices() — the tree the Advanced Output publishes over
     ArenaBus. NOT window.OpenLiveScreens: that module is only loaded on
     advanced-output.html, so reading it here would draw nothing in the main
     window for a reason no one could see. Same source the Slice Transform
     effect uses, so the two always agree about where a slice is. */
  const tree = (typeof window !== 'undefined' && window.ArenaSlices) ? window.ArenaSlices() : null;
  const screens = (tree && tree.screens) || [];
  const cw  = (tree && tree.composition && tree.composition.width)  || 1920;
  const chh = (tree && tree.composition && tree.composition.height) || 1080;
  const sx = w/cw, sy = h/chh;
  /* REAL parameter names, mined from reference/wired/Slice Outline.wired:
     the patch exposes exactly three roots — Slice In, Color and Thickness
     (float, 0..1). An earlier version of this function invented Line Width,
     Fill, Show Names and Hue, none of which the patch has. Thickness is
     normalised, so it is scaled to pixels here against the short edge.
     Slice In selects which slices to outline; with no slice-picker plumbed in
     yet, every slice is outlined, which is what the patch does when its input
     is the whole screen. */
  const lw = Math.max(0.5, clamp01(g('Thickness', 0.07)) * Math.min(w, h) * 0.05);
  const outline = col(g, 'Color', 'rgba(128 255 211 / 1)');
  x.lineWidth = lw; x.lineJoin = 'round';
  x.strokeStyle = outline;
  screens.forEach(sc => {
    (sc.slices || []).forEach(sl => {
      /* a DMX fixture drives lights, not content — it has no picture to outline */
      if(sl.kind === 'dmx') return;
      const r = sl && sl.input;
      /* the vertices, not the bounding box: a rotated slice is not its box */
      const v = r && r.vertices;
      if(!v || v.length < 3) return;
      x.beginPath();
      x.moveTo(v[0].x*sx, v[0].y*sy);
      for(let i = 1; i < v.length; i++) x.lineTo(v[i].x*sx, v[i].y*sy);
      x.closePath();
      x.stroke();
    });
  });
});

/* A paragraph of text, wrapped to the frame — which is the one thing that
   distinguishes it from Text Animator, whose text is a single animated line.
   Falls back to the clip's own name when Text is empty, so the slot is never
   blank for no visible reason. */
impl('Text Block', (x, g, w, h, t, info) => {
  const body = String(g('Text', '') || (info && info.label) || 'Text Block');
  const size = Math.max(6, g('Size', 0.12) * h);
  const lh = size * g('Line Height', 1.2);
  const align = g('Alignment', 'Left');
  const margin = g('Margin', 0.06) * Math.min(w, h);
  const px = g('Position X', 0) * w, py = g('Position Y', 0) * h;
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.font = `${size}px system-ui, sans-serif`;
  x.textBaseline = 'top';
  const maxW = Math.max(1, w - margin*2);
  /* wrap on words, but keep the author's own line breaks */
  const lines = [];
  String(body).split('\n').forEach(para => {
    let line = '';
    para.split(/\s+/).forEach(word => {
      const next = line ? line + ' ' + word : word;
      if(line && x.measureText(next).width > maxW){ lines.push(line); line = word; }
      else line = next;
    });
    lines.push(line);
  });
  const anchor = align === 'Center' ? w/2 : align === 'Right' ? w - margin : margin;
  x.textAlign = align === 'Center' ? 'center' : align === 'Right' ? 'right' : 'left';
  const top = (h - lines.length*lh)/2 + py;
  x.fillStyle = '#fff';
  lines.forEach((l, i) => x.fillText(l, anchor + px, top + i*lh));
  x.textAlign = 'start';
});

/* THE COMPOSITION'S OWN PREVIOUS FRAME, fed back through a transform.

   The live catalogue captured from the running Arena's REST API
   (extracted/live-catalog.json, id FEEDBACK_SRC) settles what this source is:
   "Creates a feedback loop of the composition output. It continuously reuses
   the previous frame as part of the next one, similar to pointing a camera at
   its own screen. Make sure to tone down the opacity and work with content
   with a alpha channel to make the most of this source."

   An earlier version of this function was marked UNDOCUMENTED and fed back its
   OWN private buffer seeded with a moving blob — an infinite tunnel that owed
   nothing to the composition. That was a guess, and it was wrong: the loop is
   over the composition output, which is why the description warns about
   opacity and alpha. app.js captures the last composition frame and passes it
   as info.compFrame; a generator cannot reach it on its own.

   Parameter names remain INFERRED — Resolume ships no preset for this source
   and it appears in none of the twelve reference compositions. */
impl('Feedback', (x, g, w, h, t, info) => {
  const prev = info && info.compFrame;
  if(!prev){
    /* Nothing has been composited yet, or the compositor is not driving this
       draw (a thumbnail, a preview pass). A camera pointed at a dark screen
       sees a dark screen — that is the honest frame, not an invented one. */
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    return;
  }
  const fb   = clamp01(g('Feedback', 0.9));
  const zoom = g('Zoom', 1.03);
  const rot  = g('Rotation', 1.5) * Math.PI/180;
  const ox   = g('Offset X', 0) * w, oy = g('Offset Y', 0) * h;
  const hue  = g('Hue Shift', 6);
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  /* Each pass is dimmed by (1 - Feedback) so the recursion converges instead
     of clipping to white — the loop has to lose energy or it saturates. */
  x.save();
  x.globalAlpha = fb;
  x.filter = `hue-rotate(${hue}deg) brightness(${0.55 + fb*0.45})`;
  x.translate(w/2 + ox, h/2 + oy);
  x.rotate(rot);
  x.scale(zoom, zoom);
  x.translate(-w/2, -h/2);
  x.drawImage(prev, 0, 0, w, h);
  x.restore();
});

/* --------------------------------------------------------------------------
   Public
   -------------------------------------------------------------------------- */
function params(label){
  const spec = specOf(label);
  if(!spec) return null;
  return Object.entries(spec).map(([key, s]) => {
    /* `path` is structural identity; `n` is the Arena label. They are the
       same for ordinary Sources. Grouped Sources such as Shaper deliberately
       repeat labels (Shape 1/Size and Shape 2/Size), so using the label as the
       address would make presets, OSC, animation and save/reload collide. */
    const n = s.name || key;
    const path = s.path || key;
    const group = s.group || null;
    /* A COLOUR'S MISSING DEFAULT MUST STAY MISSING. The generic branch below
       substitutes min (i.e. 0) for an absent default, which for a packed
       0xAARRGGBB word is transparent black — so all seventeen colour
       parameters that ship no default arrived at the panel as an invisible
       swatch reading "#000000 alpha 0%". Only 5 of the 22 ParamColor entries
       in default\Presets carry a default at all; the rest are handed on as
       null so arena-engine.js can apply its own labelled fallback. */
    const isColor = s.node === 'ParamColor' || s.t === 'COLOR' || s.kind === 'color';
    /* storeChoices="0" omits option labels and a declared range, but shipped
       presets still carry authoritative numeric indices. The extractor records
       only indices it actually observed; using those bounds preserves e.g.
       Shaper Identity Crisis' Type 3/4 without inventing choice labels. */
    const inferredMin = s.node === 'ParamChoice' && Number.isFinite(s.observedMin)
      ? Math.min(0, s.observedMin) : 0;
    const inferredMax = s.node === 'ParamChoice'
      ? Math.max(1, Number.isFinite(s.def) ? s.def : 0,
                     Number.isFinite(s.observedMax) ? s.observedMax : 0)
      : 1;
    const unresolvedChoice = s.node === 'ParamChoice' &&
      (!Array.isArray(s.options) || !s.options.length);
    /* A choice with missing labels is still a CHOICE, not a continuous
       fader. Present each captured integer as its structural index so users
       cannot create impossible fractional values. The label says exactly
       what is missing; it deliberately does not guess that index 3 is a
       Circle, Rectangle, font, alignment, etc. */
    const unresolvedOptions = unresolvedChoice
      ? Array.from({length:Math.max(1,Math.floor(inferredMax-inferredMin)+1)},
          (_,index)=>Math.floor(inferredMin)+index)
      : null;
    const unresolvedLabels = unresolvedChoice
      ? unresolvedOptions.map(value=>'Index '+value+' (label unavailable)')
      : null;
    return {
      n, path, group, min: s.min == null ? inferredMin : s.min,
      max: s.max == null ? inferredMax : s.max,
      d: s.def != null ? s.def : (isColor ? null : (s.min == null ? 0 : s.min)),
      node: s.node, t: s.t, alt: s.alt,
      kind: unresolvedChoice ? 'choice' : s.kind,
      options: unresolvedChoice ? unresolvedOptions : s.options,
      optionValues:s.optionValues,
      optionLabels:unresolvedChoice ? unresolvedLabels : s.optionLabels,
      unresolvedChoice,
      /* where that default came from: undefined = Resolume's own shipped
         preset, 'corpus' = modal across reference/compositions, 'assumed' =
         this codebase's own choice. The panel says which. */
      defFrom: s.defFrom,
      /* null when the draw function reads it; otherwise the reason it does not */
      unwired: unwiredReason(label, path) || unwiredReason(label, n)
    };
  });
}
/* Which generators have a parameter list Resolume itself supplied, and which
   are this file's inference. The browser and the Clip panel say so out loud
   rather than letting an inferred list pass for a mined one. */
function paramsAreInferred(label){
  if(customSpec(label)) return false;
  return !wiredSpec(label) && !LABEL[label] && !!EXTRA[label];
}

/* --------------------------------------------------------------------------
   className -> the label the browser shows, for loading a .avc.
   A saved clip names its generator by CLASS (<RenderPass baseType="Generator"
   type="SolidColor">), never by the label, so without this map every source
   clip in a real composition loads as an empty slot. The classes below are the
   ones that actually occur — counted across the twelve compositions in
   reference/compositions/: 588 file clips, 58 GeneratorVideoSource, 20
   CaptureDeviceVideoSource and 2 CompositionRouterVideoSource.

   Most come free from the preset data's own className keys. The four extra
   entries are classes that appear in the corpus but ship no preset, so they
   are not in DEFS: SolidColor (22 clips), LineScape (4), Blank and Static.

   WireGenerator is a genuine collision — Abstract Field and Tunnelines are
   both type="WireGenerator" and are told apart only by @name, so the name is
   tried first for every lookup.
   -------------------------------------------------------------------------- */
const CLASS_EXTRA = {
  SolidColor: 'Solid Color', LineScape: 'Line Scape',
  Blank: 'Blank', StaticGenerator: 'Static', TestCard: 'Test Card'
};
const NAME_EXTRA = { AbstractField: 'Abstract Field', Tunnelines: 'Tunnelines' };
function labelForClass(cls, name){
  if(name && NAME_EXTRA[name]) return NAME_EXTRA[name];
  if(name && DEFS[name]) return DEFS[name].label;
  if(name && CLASS_EXTRA[name]) return CLASS_EXTRA[name];
  if(cls && DEFS[cls]) return DEFS[cls].label;
  if(cls && CLASS_EXTRA[cls]) return CLASS_EXTRA[cls];
  /* A label that is already a label — the browser and the quick search both
     pass one — round-trips rather than failing. */
  if(name && (LABEL[name] || EXTRA[name] || customSpec(name))) return name;
  if(cls && (LABEL[cls] || EXTRA[cls] || customSpec(cls))) return cls;
  return null;
}

/* `extra` carries the things a generator cannot reach on its own — a
   persistent buffer for Feedback, the composite for Video Router. It is merged
   into info rather than added as more positional arguments so a generator that
   does not want it is unaffected. */
function draw(ctx, name, w, h, t, beats, values, label, extra){
  const fn = DRAW[name];
  if(!fn){
    ctx.fillStyle = '#151515'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#333'; ctx.setLineDash([4,3]); ctx.strokeRect(2, 2, w-4, h-4); ctx.setLineDash([]);
    ctx.fillStyle = '#6a6a6a';
    ctx.font = `${Math.max(8, Math.round(h/9))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, w/2, h/2 - h/12);
    ctx.fillStyle = '#4a4a4a';
    ctx.font = `${Math.max(7, Math.round(h/13))}px system-ui, sans-serif`;
    ctx.fillText('source: not rendered', w/2, h/2 + h/8);
    ctx.textAlign = 'start';
    reportSourceDraw(ctx,{name,ok:false,state:'unavailable',reason:'This Source has no browser renderer.'});
    return false;
  }
  ctx.save();
  try{
    fn(ctx, reader(name, values), w, h, t, Object.assign({beats, label}, extra));
    /* Keep the warm render path free of diagnostic allocations. A successful
       retry clears the last failure so a repaired input can become ready. */
    const prior=DRAW_STATUS.get(ctx); if(prior&&prior.name===name) DRAW_STATUS.delete(ctx);
    return true;
  }catch(error){
    reportSourceDraw(ctx,{name,ok:false,state:'failed',reason:error&&error.message||String(error)});
    return false;
  }finally{ctx.restore();}
}

window.ArenaSources = {
  draw, params, paramsAreInferred, labelForClass,
  drawStatus:sourceDrawStatus,
  setDiagnosticObserver:observer=>{DIAGNOSTIC_OBSERVER=typeof observer==='function'?observer:null;},
  /* Which of a generator's parameters the draw function does NOT read, and the
     reason for each. The Clip panel marks those rows; without it a control
     that does nothing is indistinguishable from one that does. */
  unwired: label => Object.assign({}, UNWIRED[label] || {}),
  unwiredReason,
  unwiredCount: () => Object.values(UNWIRED).reduce((n, t) => n + Object.keys(t).length, 0),
  has: name => !!DRAW[name],
  /* which generators Resolume ships presets for, whether or not we render them */
  /* Three different questions, and they had been collapsed into one:
       known()    — Resolume ships a preset for it, so its parameters are mined
       inferred() — it is in the panel but has no preset; parameters are guessed
       implemented() — something here actually draws it
     known() must keep its own meaning: appending the inferred four to it made
     "12 sources have real parameter data" read as 16. */
  known: () => Object.values(DEFS).map(d => d.label).sort(),
  inferred: () => Object.keys(EXTRA).sort(),
  implemented: () => Object.keys(DRAW).filter(name => !CUSTOM_LABELS.has(name)).sort(),
  custom: () => [...CUSTOM_LABELS].sort(),
  allImplemented: () => Object.keys(DRAW).sort(),
  count: () => Object.keys(DRAW).filter(name => !CUSTOM_LABELS.has(name)).length,
  totalCount: () => Object.keys(DRAW).length
};
})();
