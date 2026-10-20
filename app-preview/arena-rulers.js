/* ===========================================================================
   arena-rulers.js — make alignment checkable instead of eyeballed.
   ---------------------------------------------------------------------------
   arena.css defines one set of rulers: a 2px base unit, a handful of named
   steps, and one load-bearing number, --row-h, which is simultaneously the
   height of a layer strip and the height of its row of clips. This file draws
   those rulers over the window and audits the DOM against them.

   Arena has the same instinct in the Advanced Output, where View > Show Slice
   Grid and Show 8x8 LED Grid exist so that alignment can be verified rather
   than assumed (modifiers.htm). This is that, for the main window.

     ArenaRulers.toggle()   — draw the grid (View > Show Alignment Grid)
     ArenaRulers.audit()    — report every element that is off the rulers
     ArenaRulers.rows()     — check each layer strip against its clip row
     ArenaRulers.columns()  — check the strip's COLUMN grid, across strips
     ArenaRulers.glyphs()   — check no control renders a colour emoji
     ArenaRulers.modules()  — check every control is 20 / 40 / 60 / 80 wide and tall

   The audit is the part that matters: it is what turns "the alignment is still
   lacking" into a list of offenders with numbers next to them.
   =========================================================================== */
(() => {
'use strict';
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const px = v => Math.round(parseFloat(v) || 0);

/* The rulers are declared as calc() so the arithmetic stays visible in the
   stylesheet. getPropertyValue hands back the literal "calc(var(--u) * 40)"
   string, which parseFloat turns into NaN — and a NaN row height makes the
   draw loop below advance by zero forever. Resolve them through a probe
   element instead, so we read the number the browser actually computed. */
let probe = null;
function resolve(name, fallback){
  if(!probe){
    probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0';
    document.body.appendChild(probe);
  }
  probe.style.height = `var(${name})`;
  const v = px(getComputedStyle(probe).height);
  return v > 0 ? v : fallback;
}
function tokens(){
  return {
    u: resolve('--u', 2),
    unit: resolve('--lc-1', 21),          /* the strip's column pitch */
    ctl: resolve('--lc-ctl', 20),
    row: resolve('--row-h', 80),
    head: resolve('--head-h', 26),
    lname: resolve('--lname-h', 20),
    steps: [7,8,9,10,11,12,13,20].reduce((o,n) =>
      (o['step-'+n] = resolve('--step-'+n, n*2), o), {})
  };
}

/* --------------------------------------------------------------------------
   Draw
   Horizontal lines on the row rhythm, anchored to where the deck actually
   starts, plus verticals on the clip-column pitch.
   -------------------------------------------------------------------------- */
function draw(){
  let host = $('#alignGrid');
  if(!host){ host = document.createElement('div'); host.id = 'alignGrid'; document.body.appendChild(host); }
  host.innerHTML = '';
  const t = tokens();
  const layers = $('#layers');
  if(!layers) return;

  const origin = Math.round(layers.getBoundingClientRect().top);
  const H = innerHeight;
  if(!(t.row > 0)) return;                 // never let the loop below stall
  /* horizontals every --row-h from the top of the layer list; the row boundary
     is 'major' because that is the line a strip and its clips must share */
  for(let y = origin, i = 0; y < H; y += t.row, i++){
    const d = document.createElement('div');
    d.className = 'h major'; d.style.top = y + 'px';
    host.appendChild(d);
    const l = document.createElement('div');
    l.className = 'lbl'; l.style.top = y + 'px'; l.style.left = '2px';
    l.textContent = 'row ' + i + '  ' + (y - origin) + 'px';
    host.appendChild(l);
    /* the name-bar line inside each strip */
    const m = document.createElement('div');
    m.className = 'h'; m.style.top = (y + t.lname) + 'px';
    host.appendChild(m);
  }
  /* the header line: composition row and column headers must share it */
  const hd = document.createElement('div');
  hd.className = 'h major'; hd.style.top = (origin - t.head) + 'px';
  host.appendChild(hd);

  /* verticals on the STRIP's own column pitch, across the left column - the
     half of the grid this file used to leave undrawn */
  const strip0 = $('#layers .layer');
  if(strip0 && t.unit > 4){
    const sr = strip0.getBoundingClientRect();
    const mon0 = strip0.querySelector('.lthumb');
    /* both unit runs - see columns() for why there are two */
    const runs = [sr.left];
    if(mon0) runs.push(mon0.getBoundingClientRect().right);
    runs.forEach((from, i) => {
      const to = i === 0 && mon0 ? mon0.getBoundingClientRect().left : sr.right;
      for(let x = Math.round(from); x <= to + 0.5; x += t.unit){
        const v = document.createElement('div');
        v.className = 'v'; v.style.left = x + 'px';
        host.appendChild(v);
      }
    });
  }
  /* verticals on the clip pitch, so columns line up with their headers */
  const first = $('#gridTable .clip') || $('#gridTable .colhead');
  if(first){
    const cell = first.closest('.gcell') || first;
    const w = Math.round(cell.getBoundingClientRect().width);
    const x0 = Math.round(cell.getBoundingClientRect().left);
    for(let x = x0; x < innerWidth && w > 4; x += w){
      const v = document.createElement('div');
      v.className = 'v'; v.style.left = x + 'px';
      host.appendChild(v);
    }
  }
  /* and mark anything the audit says is off */
  audit().offenders.forEach(o => {
    if(!o.rect) return;
    const b = document.createElement('div');
    b.className = 'bad';
    b.style.cssText = `left:${o.rect.x}px;top:${o.rect.y}px;width:${o.rect.w}px;height:${o.rect.h}px`;
    b.title = o.what + ': ' + o.why;
    host.appendChild(b);
  });
}

/* --------------------------------------------------------------------------
   Audit — the check that actually matters
   -------------------------------------------------------------------------- */
function rows(){
  const strips = $$('.layer');
  const grid = $$('#gridTable .grow').slice(1);   // row 0 is the column header
  return strips.map((s, i) => {
    const g = grid[i];
    const a = s.getBoundingClientRect();
    const b = g ? g.getBoundingClientRect() : null;
    return {
      layer: s.dataset.layer,
      stripTop: Math.round(a.top), stripH: Math.round(a.height),
      rowTop: b ? Math.round(b.top) : null, rowH: b ? Math.round(b.height) : null,
      deltaTop: b ? Math.round(a.top - b.top) : null,
      deltaH: b ? Math.round(a.height - b.height) : null,
      ok: !!b && Math.abs(a.top - b.top) <= 1 && Math.abs(a.height - b.height) <= 1
    };
  });
}

/* The caption line: a layer's name and its clips' names are the same gesture at
   two scales (clips.htm), so they have to share a line. */
function captions(){
  const strips = $$('.layer');
  const grid = $$('#gridTable .grow').slice(1);
  return strips.map((s, i) => {
    const ln = s.querySelector('.lname');
    const cn = grid[i] && grid[i].querySelector('.clip .name');
    if(!ln || !cn) return null;
    const a = ln.getBoundingClientRect(), b = cn.getBoundingClientRect();
    /* BOTTOMS, not tops. This asserted both, and both was wrong once the two
       columns were measured properly: the strip spends its gutter BETWEEN the
       tall row and the name bar, as 1px of black, while the clip has no black
       line under its thumbnail and spends the same gutter INSIDE its caption
       (2.svg draws the caption plate running up behind the thumbnail). So the
       clip caption is 21 to the strip's 20 and legitimately starts a pixel
       higher — 137..158 against 138..158.
       What has to hold is the LINE the two names sit on, and that is the
       bottom edge. Testing the top as well reported four false offenders on a
       layout that matched the drawings exactly. */
    return { layer: s.dataset.layer,
      layerName: Math.round(a.top) + '..' + Math.round(a.bottom),
      clipName:  Math.round(b.top) + '..' + Math.round(b.bottom),
      ok: Math.round(a.bottom) === Math.round(b.bottom) };
  }).filter(Boolean);
}

/* --------------------------------------------------------------------------
   Columns - the check this file did not have, and the reason horizontal drift
   went unnoticed for so long. Everything above measures DOWNWARDS: heights
   against --u, strip tops against clip-row tops, the caption line. Nothing
   looked sideways, so the composition row could sit on a 23px pitch offset by
   4 while every layer under it sat on 21, and no audit had an opinion about it.

   Two rules, both of which the layout drawings state:

     1. the same control is at the same x, and the same width, in every strip
     2. a control's left edge is a whole number of column units from one of the
        strip's two unit ORIGINS, and its edges are whole pixels

   TWO origins, because the strip has two runs of unit columns with the layer
   monitor between them, and the monitor is 80 wide - four units would be 84.
   The drawings are built the same way and measure the same: their left run is
   0, 20.9, 62.3, 83, 103.8, then the monitor at 124.6 w80.3, then the right run
   restarts at 205.7, 227.2, 248.7, 270, 291.7. A single pitch from x=0 declares
   everything after the monitor 3px wrong, which is the ruler being wrong rather
   than the layout - the first version of this check did exactly that.

   Rule 2 has exemptions too, and they are NAMED rather than silently skipped:
   the three-across transport row divides its 83px block by three, which no 21px
   pitch can express, and the composition row's two sideways faders span several
   units rather than starting on one.
   -------------------------------------------------------------------------- */
const COLUMN_SELECTORS = [
  '.lx .btn', '.lbs .top .btn', '.ls-blend', '.lfad .vfad', '.lthumb .box',
  '.ltrans .r.r1 .btn', '.tfad', '.lfold', '.lname', '.lab .btn', '.lclip', '.ltb .btn'
];
/* selector -> why this one cannot sit on the unit pitch */
const OFF_PITCH_BY_DESIGN = {
  '.ltrans .r.r3 .btn':
    'three buttons dividing an 83px block: 27 + 27 + 27 and two gutters, not a 21 multiple',
  '#cM': 'a sideways fader spanning four units, placed by the units before it',
  '#cSpeed': 'a sideways fader spanning the thumbnail track'
};
function columns(){
  const issues = [];
  const strips = $$('#layers .layer').filter(s => !s.classList.contains('folded'));
  if(!strips.length) return issues;
  const t = tokens();
  const left = strips[0].getBoundingClientRect().left;
  const off = (v, step) => Math.abs(v - Math.round(v / step) * step);
  /* the second run starts where the monitor ends */
  const mon = strips[0].querySelector('.lthumb');
  const origin2 = mon ? +(mon.getBoundingClientRect().right - left).toFixed(2) : null;
  const onGrid = x => off(x, t.unit) <= 0.5 ||
                      (origin2 != null && off(x - origin2, t.unit) <= 0.5);

  COLUMN_SELECTORS.forEach(sel => {
    const perStrip = strips.map(s => [...s.querySelectorAll(sel)].map(e => {
      const r = e.getBoundingClientRect();
      return { x: +(r.left - left).toFixed(2), w: +r.width.toFixed(2) };
    }));
    const n = Math.max(...perStrip.map(r => r.length));
    if(!n) return;
    for(let i = 0; i < n; i++){
      const cells = perStrip.map(r => r[i]);
      const tag = sel + '[' + i + ']';
      if(cells.some(c => !c)){
        issues.push({ what: tag, why: 'present in some layer strips and not others' });
        continue;
      }
      const xs = cells.map(c => c.x), ws = cells.map(c => c.w);
      const dx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      const dw = Math.max.apply(null, ws) - Math.min.apply(null, ws);
      if(dx > 0.5) issues.push({ what: tag,
        why: 'left edge differs between strips by ' + dx.toFixed(2) + 'px (' + xs.join(', ') + ')' });
      if(dw > 0.5) issues.push({ what: tag,
        why: 'width differs between strips by ' + dw.toFixed(2) + 'px (' + ws.join(', ') + ')' });
      if(off(xs[0], 1) > 0.01) issues.push({ what: tag,
        why: 'left edge ' + xs[0] + 'px is not a whole pixel' });
      if(off(ws[0], 1) > 0.01) issues.push({ what: tag,
        why: 'width ' + ws[0] + 'px is not a whole pixel' });
      if(!OFF_PITCH_BY_DESIGN[sel] && !onGrid(xs[0])) issues.push({ what: tag,
        why: 'left edge ' + xs[0] + 'px is on neither unit run (0 or ' + origin2 +
             '), nearest is ' + off(xs[0], t.unit).toFixed(2) + 'px away' });
    }
  });

  /* the composition row heads the same columns the strips below it use */
  const comp = $('.comp-row');
  if(comp){
    [...comp.children].forEach(el => {
      const r = el.getBoundingClientRect();
      if(r.width < 1) return;
      const x = +(r.left - left).toFixed(2);
      const id = el.id ? '#' + el.id : '.comp-row > ' + el.tagName.toLowerCase();
      if(OFF_PITCH_BY_DESIGN[id]) return;
      if(!onGrid(x)) issues.push({ what: id,
        why: 'composition row control at ' + x + 'px is on neither unit run the ' +
             'strips below it use (0 or ' + origin2 + ')' });
    });
  }
  return issues;
}

/* --------------------------------------------------------------------------
   Glyphs - the third thing this file had no opinion about. rows() and
   captions() measure downwards, columns() sideways, and nothing looked at what
   the type actually RENDERS AS.

   Two ways a label can be wrong without any geometry being wrong:

     1. it renders as a COLOUR EMOJI. Around twenty Unicode symbols default to
        emoji presentation, so the OS substitutes a bitmap from the emoji font.
        It arrives coloured, roughly twice the width of its upright neighbours
        and four times the ink, which reads as a crooked row as much as a
        colourful one.
     2. it renders ITALIC. <i> is used throughout this app as a fill element
        rather than for emphasis, and anything inside one inherits the slant.

   Both were found by a person looking at the screen rather than by anything in
   this repo, which is the reason this function exists. It rasterises each
   distinct label and asks whether the ink came back grey.
   -------------------------------------------------------------------------- */
let glyphCanvas = null;
/* Does this CODEPOINT default to emoji presentation? That is a property of the
   character and the installed fonts, so rasterising it is the right way to ask.
   What rasterising cannot tell you is what the DOM did with it: canvas 2d takes
   a font shorthand and ignores font-variant-emoji entirely, so a probe keeps
   reporting a coloured glyph long after the page has forced the text form. The
   first version of this check did exactly that and called a working fix broken.
   So: canvas answers "would this default to emoji", the DOM answers "did we
   override it", and an offender needs both. */
const emojiDefault = new Map();
function defaultsToEmoji(ch, family){
  const key = ch + '|' + family;
  if(emojiDefault.has(key)) return emojiDefault.get(key);
  if(!glyphCanvas){
    glyphCanvas = document.createElement('canvas');
    glyphCanvas.width = 48; glyphCanvas.height = 48;
  }
  const g = glyphCanvas.getContext('2d', { willReadFrequently:true });
  g.clearRect(0,0,48,48);
  g.fillStyle = '#ffffff'; g.font = '28px ' + family; g.textBaseline = 'top';
  g.fillText(ch, 4, 4);
  const px = g.getImageData(0,0,48,48).data;
  let ink = 0, coloured = 0;
  for(let i = 0; i < px.length; i += 4){
    if(px[i+3] < 20) continue;
    ink++;
    if(Math.max(px[i],px[i+1],px[i+2]) - Math.min(px[i],px[i+1],px[i+2]) > 24) coloured++;
  }
  const v = ink ? coloured / ink > 0.25 : false;
  emojiDefault.set(key, v);
  return v;
}
function glyphs(){
  const issues = [];
  $$('button,.btn,.ico,.ic,.cnm,.lfold,.ls-blend,.vfad b,.tfad b').forEach(el => {
    const r = el.getBoundingClientRect();
    if(!r.width || !r.height) return;
    const t = (el.textContent || '').trim();
    if(!t || t.length > 4) return;
    const cs = getComputedStyle(el);
    if(cs.fontStyle !== 'normal'){
      issues.push({ what: label(el), why: 'renders ' + cs.fontStyle +
        ' - <i> is a fill element in this app, not emphasis' });
    }
    /* the page forces the text form either in CSS or with a VS15 in the string */
    const forced = cs.fontVariantEmoji === 'text' || t.indexOf('\uFE0E') >= 0;
    if(forced) return;
    for(const ch of t){
      if(ch.codePointAt(0) < 0x2000) continue;
      if(!defaultsToEmoji(ch, cs.fontFamily)) continue;
      issues.push({ what: label(el),
        why: 'U+' + ch.codePointAt(0).toString(16).toUpperCase() + ' in "' + t +
             '" defaults to emoji presentation and nothing here overrides it, so ' +
             'the OS substitutes a colour bitmap for the UI font' });
    }
  });
  return issues;
}
function label(el){
  const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal
                                                                 : el.className || '').toString();
  return (el.id ? '#' + el.id : el.tagName.toLowerCase()) + (cls ? '.' + cls.split(' ')[0] : '');
}

/* --------------------------------------------------------------------------
   Modules - the size check.

   The layout drawings are built from ONE control size and its multiples. In the
   client's words: 20, 40, 60, 80. On screen those are 20 and then n of them
   with the 1px gutters that separate them absorbed, because two 20s that touch
   with a gutter between occupy 41 rather than 40:

     1 unit    20      eject, B, S, a fader, a bus button, prev, next
     2 units   41      the B/S pair, Add, the T fader, Alpha, loop, play mode
     3 units   62      the fader bank, the height of the control block
     4 units   83      the transport block; the monitor is 80 because it is a
                       clip, and a clip column is 80 on an 82 pitch

   So a legal size is 21n - 1, and this reports anything that is not. That is a
   stricter rule than the 18/20/24/32 height scale --step-* encodes: that one
   governed heights only, and said nothing about width, which is how eleven
   different button widths survived in one strip until the drawings arrived.

   Exemptions are named, never silent. There are two, and both are divisions
   rather than modules: the three-across transport row splits an 83px block into
   27 + 27 + 27, and the composition row's two sideways faders are 83 and 80
   because they span the blocks above them rather than being built from units.
   -------------------------------------------------------------------------- */
const MODULE_EXEMPT = {
  '.ltrans .r.r3 .btn': '83 divided as the drawings divide it: 26 + 29 + 26, the centre control wider',
  '#cM': 'a sideways fader spanning the eject/bypass units and the B/S block',
  '#cSpeed': 'a sideways fader spanning the monitor column',
  '.lclip': 'spans the monitor and transport blocks: 81 + 84 tracks, 165 of content',
  '.lname': 'spans the B/S block and the first fader unit',
  '.lthumb .box': 'the layer monitor is a clip, so it is 80 like a clip column'
};
/* HEIGHT IS A DIFFERENT RULE FROM WIDTH, and until now this file applied the
   horizontal one to both. Across a row, n controls and their gutters measure
   21n - 1, which is what legal() tests. Down the strip the tall row is not a
   run of controls at all - it is a STACK: B/S 40 + gutter 1 + Add 20 = 61, and
   61 + gutter 1 + name bar 20 = 82 of content. 61 and 40 are therefore correct
   and 62 and 41 are not, which is the opposite of what legal() says.
   Confirmed against the drawings' authored rects rather than their pixels:
   7.svg gives 60.99 for eject, each M/A/V fader, the T fader, the layer
   monitor and the clip slots opposite, and 39.99 for B and S.
   These are exemptions from the 21n-1 FORMULA, not from measurement - each one
   still has to be the number named here, which vertical() below checks. */
const HEIGHT_EXPECT = {
  '.lx .btn':          [61, 'the whole tall row: 40 + 1 + 20'],
  '.lbs .top .btn':    [40, 'B and S share the tall row above Add: 61 - 1 - 20'],
  '.ls-blend':         [20, 'Add sits under B/S, one control tall'],
  '.lfad .vfad':       [61, 'a fader spans the tall row'],
  '.lthumb .box':      [61, 'the layer monitor spans the tall row'],
  '.tfad':             [61, 'the transition fader spans the tall row'],
  '.ltrans .r.r1 .btn':[20, 'three 20px rows fill the 61: 20 + 20 + 20, borders touching'],
  '.ltrans .r.r2 .btn':[20, 'as r1'],
  '.ltrans .r.r3 .btn':[20, 'as r1']
};
function modules(){
  const issues = [];
  const t = tokens();
  const unit = t.ctl || 20, pitch = t.unit || 21;
  const legal = n => {
    if(n < unit - 0.5) return false;
    const k = Math.round((n + 1) / pitch);
    return k >= 1 && Math.abs(n - (pitch * k - 1)) <= 0.5;
  };
  const nearest = n => {
    const k = Math.max(1, Math.round((n + 1) / pitch));
    return pitch * k - 1;
  };
  const SEL = ['.lx .btn', '.lbs .top .btn', '.ls-blend', '.lfad .vfad', '.lthumb .box',
               '.ltrans .r.r1 .btn', '.ltrans .r.r2 .btn', '.ltrans .r.r3 .btn',
               '.tfad', '.lfold', '.lname', '.lab .btn', '.lclip', '.ltb .btn'];
  const strip = $('#layers .layer:not(.folded)') || $('#layers .layer');
  if(!strip) return issues;
  /* HEIGHT_EXPECT describes the UNFOLDED strip - 61 for a fader, 40 for B/S.
     A folded row is a different geometry: one --lc-ctl band, every control 20
     tall. The selector above falls back to a folded strip when every layer is
     folded, and checking that against the tall-row numbers reported the fader
     and the monitor as 20-should-be-61 - the ruler calling a correct layout
     wrong, which is worse than not checking. */
  const foldedStrip = strip.classList.contains('folded');
  const expectFor = sel => foldedStrip
    ? [t.ctl || 20, 'a folded row is one control band, every control ' + (t.ctl || 20)]
    : HEIGHT_EXPECT[sel];
  SEL.forEach(sel => {
    const seen = new Set();
    [...strip.querySelectorAll(sel)].forEach(el => {
      const r = el.getBoundingClientRect();
      if(!r.width || !r.height) return;
      const w = +r.width.toFixed(2), h = +r.height.toFixed(2);
      const key = w + 'x' + h;
      if(seen.has(key)) return;
      seen.add(key);
      const why = MODULE_EXEMPT[sel];
      if(!why && !legal(w)) issues.push({ what: sel,
        why: 'width ' + w + ' is not a module - nearest is ' + nearest(w) +
             ' (' + Math.round((nearest(w)+1)/pitch) + ' units)' });
      /* height: the named vertical stack first, the 21n-1 run only as a
         fallback for the controls that genuinely are one control tall */
      const expect = expectFor(sel);
      if(expect){
        if(Math.abs(h - expect[0]) > 0.5) issues.push({ what: sel,
          why: 'height ' + h + ' should be ' + expect[0] + ' - ' + expect[1] });
      } else if(!legal(h)) issues.push({ what: sel,
        why: 'height ' + h + ' is not a module - nearest is ' + nearest(h) +
             ' (' + Math.round((nearest(h)+1)/pitch) + ' units)' });
    });
  });
  return issues;
}

/* Every element whose height is not a whole number of base units, or that sits
   off the row rhythm, with the numbers to prove it. */
const WATCH = ['#menubar','.comp-row','.layer','.clip','.colhead','#xfRow','#transport',
               '.mon-head','.mon-foot','.pname','.sect > h3','.ptabs .ptab','.deck'];
function audit(){
  const t = tokens();
  const offenders = [];
  WATCH.forEach(sel => {
    const seen = new Set();
    $$(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      const h = Math.round(r.height);
      if(!h || seen.has(h)) return;
      seen.add(h);
      if(h % t.u !== 0){
        offenders.push({ what: sel, why: `height ${h}px is not a multiple of ${t.u}px`,
          rect:{x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h} });
      }
    });
  });
  /* the load-bearing checks */
  captions().forEach(c => {
    if(!c.ok) offenders.push({ what:'layer '+c.layer+' caption',
      why:`name ${c.layerName} is not on the clip-name line ${c.clipName}`, rect:null });
  });
  rows().forEach(r => {
    if(!r.ok) offenders.push({ what:'layer '+r.layer,
      why:`strip top ${r.stripTop}/h ${r.stripH} vs clip row top ${r.rowTop}/h ${r.rowH}`,
      rect:null });
  });
  const cols = columns();
  cols.forEach(c => offenders.push({ what: c.what, why: c.why, rect: null }));
  const gly = glyphs();
  gly.forEach(c => offenders.push({ what: c.what, why: c.why, rect: null }));
  const mods = modules();
  mods.forEach(c => offenders.push({ what: c.what, why: c.why, rect: null }));
  return {
    unit: t.u, columnPitch: t.unit, rowHeight: t.row, headHeight: t.head,
    rowsAligned: rows().every(r => r.ok),
    columnsAligned: cols.length === 0,
    glyphsUpright: gly.length === 0,
    onModule: mods.length === 0,
    offenders,
    verdict: offenders.length ? `${offenders.length} off the rulers` : 'everything on the rulers'
  };
}

function toggle(on){
  const root = document.documentElement;
  const want = on == null ? !root.classList.contains('show-aligngrid') : !!on;
  root.classList.toggle('show-aligngrid', want);
  if(want) draw();
  return want;
}
addEventListener('resize', () => {
  if(document.documentElement.classList.contains('show-aligngrid')) draw();
});

window.ArenaRulers = { toggle, draw, audit, rows, captions, columns, glyphs, modules, tokens };
})();
