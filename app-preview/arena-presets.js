/* ===========================================================================
   arena-presets.js — Resolume's own preset files, read as data.
   ---------------------------------------------------------------------------
   Arena ships 245 XML presets in `default/Presets`. Four of the seven folders
   describe things arena-engine.js already models — parameter animations,
   envelopes, colour palettes and render settings — so rather than invent a
   preset format for the clone, this module reads Resolume's.

   Three things make that harder than it looks, and each shaped the code:

     1. TWO WRITERS, ONE FORMAT.  Files stamped revision 70000 (Arena 7.3) wrap
        attributes across newlines and use LF; the 7.11+ writers keep one line
        per element and use CRLF. Any line-oriented regex silently misses
        fields on half the set, so everything here goes through DOMParser.

     2. THE CURVE ENUM IS SPARSE.  `point@curve` is an integer on a 4-wide
        per-family layout, not a flat list. Three of the codes the shipped
        presets actually use have no entry in the engine's EASINGS map and
        currently fall through to Linear — see EXTRA_CURVES.

     3. RESOLUME'S UNITS ARE NOT THE ENGINE'S.  FFT gain is stored in dB and
        fall in milliseconds, while the engine wants a linear multiplier and
        seconds. Loading a preset without converting would be silently wrong
        rather than loudly broken.

   Behaviour cited from the manual at "C:\Program Files\Resolume User Manual
   HTML files". Where the files do not settle a question the comment says so
   instead of guessing; those points are gathered under UNKNOWNS at the end.

   No DOM beyond parsing, no engine dependency at load time.
   =========================================================================== */
(() => {
'use strict';

/* The decoded XML record is a catalogue template, never live Parameter state.
   Loads intentionally share one cached decode, so make that template deeply
   immutable and clone any nested structure before an instance can edit it.
   This preserves Resolume's preset contract: applying a child is a one-time
   settings copy; later edits belong only to that Effect or Source instance. */
function deepFreezePreset(value, seen){
  if(!value || typeof value !== 'object') return value;
  seen = seen || new Set();
  if(seen.has(value)) return value;
  seen.add(value);
  Object.keys(value).forEach(key => deepFreezePreset(value[key], seen));
  return Object.freeze(value);
}
function clonePresetData(value, seen){
  if(!value || typeof value !== 'object') return value;
  seen = seen || new Map();
  if(seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  Object.keys(value).forEach(key => { copy[key] = clonePresetData(value[key], seen); });
  return copy;
}

/* =========================================================================
   1. XML ACCESS
   Deliberately a small surface — getAttribute, element children and
   getElementsByTagName — so the same code runs against a browser Document or
   any equivalent node tree a build script hands it.
   ========================================================================= */
function toRoot(input){
  if(!input) throw new Error('arena-presets: nothing to parse');
  if(typeof input !== 'string') return input.documentElement || input;
  if(typeof DOMParser === 'undefined') throw new Error('arena-presets: no DOMParser here');
  const doc = new DOMParser().parseFromString(input, 'application/xml');
  /* browsers report malformed XML as a <parsererror> element rather than by
     throwing, so a caller that never checks gets a plausible-looking empty
     record instead of an error */
  const bad = doc.getElementsByTagName('parsererror')[0];
  if(bad) throw new Error('arena-presets: ' + String(bad.textContent || 'XML parse error').trim().split('\n')[0]);
  if(!doc.documentElement) throw new Error('arena-presets: empty document');
  return doc.documentElement;
}

function elements(el){
  if(!el) return [];
  /* Browser Element.children is an HTMLCollection, while the lightweight
     XML test DOM exposes an Array. Normalise both so parser code has one
     deterministic collection contract in production and tests. */
  if(el.children) return Array.prototype.slice.call(el.children);
  const out = [], k = el.childNodes || [];
  for(let i = 0; i < k.length; i++) if(k[i].nodeType === 1) out.push(k[i]);
  return out;
}
const A = (el, n) => (el ? el.getAttribute(n) : null);
function num(el, n, fallback){
  const v = A(el, n);
  if(v === null || v === '') return fallback === undefined ? null : fallback;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : (fallback === undefined ? null : fallback);
}
const bool = (el, n) => A(el, n) === '1';

function kids(el, tag){
  const k = elements(el), out = [];
  for(let i = 0; i < k.length; i++) if(k[i].tagName === tag) out.push(k[i]);
  return out;
}
const kid  = (el, tag) => kids(el, tag)[0] || null;
const desc = (el, tag) => { const k = el && el.getElementsByTagName(tag); return k && k.length ? k[0] : null; };

/* Parameters are addressed by @name, and the tag varies (Param, ParamRange,
   ParamChoice, ParamColor, ParamText). Direct children only: `Duration`
   carries its own nested `DurationType` and `DurationIsScalable` copies of the
   Params-level ones, and a descendant search would pick whichever came first.
   (Checked across all 245 files: the nested and sibling DurationType always
   agree, so which one wins is moot — but only by luck.) */
function namedChild(parent, name){
  const k = elements(parent);
  for(let i = 0; i < k.length; i++) if(A(k[i], 'name') === name) return k[i];
  return null;
}
const valueOf = (parent, name, fallback) => num(namedChild(parent, name), 'value', fallback);
function rangeOf(paramEl, which){
  const r = kids(paramEl, 'ValueRange');
  for(let i = 0; i < r.length; i++) if(A(r[i], 'name') === which)
    return {min: num(r[i], 'min'), max: num(r[i], 'max')};
  return null;
}

function versionOf(root){
  const v = kid(root, 'versionInfo');
  if(!v) return null;
  return {app: A(v, 'name'), major: num(v, 'majorVersion'), minor: num(v, 'minorVersion'),
          micro: num(v, 'microVersion'), revision: A(v, 'revision')};
}

/* =========================================================================
   2. INTERPOLATION CURVES — envelopes.htm
   `point@curve` is an integer. Two facts about it are certain from the files,
   and one is not:

   CERTAIN — which segment it governs. "Curves are always applied between the
   keyframe you've selected and the previous one", so point[i].curve describes
   the run point[i-1] -> point[i] and point[0].curve is dead data. Resolume
   writes 33 there in 48 of the 49 shipped envelopes and 4 in the other
   (Video Effects/Radial Cloner/Revealer.xml), which is only possible if
   nothing reads it.

   CERTAIN — the arithmetic. 1 is Linear and 33 is Hold; everything else sits
   on a 4-wide block per easing family with slots In / Out / In-Out and one
   unused. Quadratic is block 0: Dual Head.xml needs curve 3 arriving at each
   extreme of a sine-shaped wave and curve 2 leaving it, which only makes a
   continuous curve if 3 is Out and 2 is In, and EasyEase.xml is the manual's
   own worked Quadratic In/Out example written as curve 4.

   NOT CERTAIN — the family NAMES from block 1 on. Bounce ends at 28 and Hold
   sits at 33, leaving block 7 (29..32) unexplained, so either the seven
   documented families are the whole list (adopted here) or an undocumented
   eighth sits somewhere in the middle and shifts every name down one. The
   integer is the identity; the name is a label. Key on the integer.
   ========================================================================= */
const CURVE_FAMILIES = ['Quadratic','Sine','Circular','Exponential','Elastic','Back','Bounce'];
const CURVE_SLOTS    = ['In','Out','In/Out'];

function curveName(code){
  code = +code;
  if(code === 1)  return 'Linear';
  if(code === 33) return 'Hold';
  const block = Math.floor((code - 2) / 4), slot = (code - 2) % 4;
  if(block < 0 || block >= CURVE_FAMILIES.length || slot > 2) return 'Linear';
  return CURVE_FAMILIES[block] + ' ' + CURVE_SLOTS[slot];
}

/* Every curve integer in the 245 shipped presets, with its count. Nothing
   else occurs — notably no Elastic, no Bounce, and none of the "unused" slot
   codes (5, 9, 13, ...), which is the evidence for the stride of 4. */
const CURVE_CODES = {1:198, 2:2, 3:10, 4:36, 10:17, 12:9, 14:4, 16:6, 24:2, 33:56};

/* The three curves shipped presets use that arena-engine.js:883 has no entry
   for. Today envelopeAt() does `EASINGS[b.curve] || EASINGS.Linear`, so
   Envelopes/ADSR, Envelopes/ASR, Envelopes/LFO, Animation/BPM - 1 to the
   Floor, the three "Ex FFT - * with Threshold" presets and Radial Cloner's
   Half Gate / Revealer / Springy all render as straight lines.
   Ready to paste straight into EASINGS. */
const EXTRA_CURVES = {
  'Circular In/Out':    t => t < .5 ? (1 - Math.sqrt(1 - 4*t*t)) / 2
                                    : (Math.sqrt(1 - 4*(t-1)*(t-1)) + 1) / 2,
  'Exponential In/Out': t => t === 0 ? 0 : t === 1 ? 1
                                    : t < .5 ? Math.pow(2, 20*t - 10) / 2
                                             : (2 - Math.pow(2, -20*t + 10)) / 2,
  'Back In/Out':        t => { const c = 2.5949095; return t < .5
                                    ? (Math.pow(2*t, 2) * ((c+1) * 2*t - c)) / 2
                                    : (Math.pow(2*t - 2, 2) * ((c+1) * (2*t-2) + c) + 2) / 2; }
};

/* The rest of the enum. No shipped preset uses these, but envelopes.htm lists
   Elastic, Back and Bounce as menu entries, so a user-drawn envelope can
   produce them and the engine is missing five of the six halves. Installed
   alongside EXTRA_CURVES for that reason; self-contained so either object can
   be pasted whole. */
const EXTRA_CURVES_UNUSED = {
  'Elastic In':    t => t === 0 || t === 1 ? t
                        : -Math.pow(2, 10*t - 10) * Math.sin((t*10 - 10.75) * (2*Math.PI/3)),
  'Elastic In/Out':t => t === 0 || t === 1 ? t : t < .5
                        ? -(Math.pow(2,  20*t - 10) * Math.sin((20*t - 11.125) * (2*Math.PI/4.5))) / 2
                        :  (Math.pow(2, -20*t + 10) * Math.sin((20*t - 11.125) * (2*Math.PI/4.5))) / 2 + 1,
  'Back In':       t => 2.70158*t*t*t - 1.70158*t*t,
  'Bounce In':     t => { const b = x => { const n = 7.5625, d = 2.75;
                            if(x < 1/d) return n*x*x;
                            if(x < 2/d) return n*(x -= 1.5/d)*x + .75;
                            if(x < 2.5/d) return n*(x -= 2.25/d)*x + .9375;
                            return n*(x -= 2.625/d)*x + .984375; };
                          return 1 - b(1 - t); },
  'Bounce In/Out': t => { const b = x => { const n = 7.5625, d = 2.75;
                            if(x < 1/d) return n*x*x;
                            if(x < 2/d) return n*(x -= 1.5/d)*x + .75;
                            if(x < 2.5/d) return n*(x -= 2.25/d)*x + .9375;
                            return n*(x -= 2.625/d)*x + .984375; };
                          return t < .5 ? (1 - b(1 - 2*t)) / 2 : (1 + b(2*t - 1)) / 2; }
};

/* Splice the missing easings into the engine. Never overwrites: the engine's
   own definitions stay authoritative for the names it already has. */
function installCurves(target){
  const E = target || (window.ArenaEngine && window.ArenaEngine.EASINGS);
  if(!E) return [];
  const added = [];
  [EXTRA_CURVES, EXTRA_CURVES_UNUSED].forEach(set => {
    Object.keys(set).forEach(k => { if(!E[k]){ E[k] = set[k]; added.push(k); } });
  });
  return added;
}

/* =========================================================================
   3. ENVELOPES — envelopes.htm
   Shape matches ArenaEngine.newEnvelope(): {points:[{phase, value, curve}]},
   phase on the x-axis and the parameter's value on the y.
   ========================================================================= */
function readEnvelope(el){
  if(!el) return null;
  const src = el.getElementsByTagName('point'), points = [];
  for(let i = 0; i < src.length; i++){
    const code = A(src[i], 'curve');
    points.push({
      phase: num(src[i], 'x', 0),
      value: num(src[i], 'y', 0),
      /* index 0's stored curve is never read (see section 2); newEnvelope()
         writes Linear there, so match it rather than surface a stray Hold */
      curve: i === 0 ? 'Linear' : curveName(code),
      code:  code === null ? null : +code
    });
  }
  /* Saw and 4 To The Floor store an instantaneous jump as two points sharing
     one x. Nothing here may de-duplicate by phase or the jump becomes a ramp;
     envelopeAt()'s sort is stable, so the pair survives in document order. */
  return points.length ? {points} : null;
}

/* Envelopes/*.xml — the flattest preset in the set: <ModifierEnvelope> is a
   direct child of <Preset>, with no <Animation> and no <Modifier> wrapper,
   because "Envelopes have their own presets". */
function parseEnvelope(xml){
  const root = toRoot(xml);
  const el = kid(root, 'ModifierEnvelope') || desc(root, 'ModifierEnvelope');
  if(!el) throw new Error('arena-presets: no ModifierEnvelope in this file');
  return {
    kind:     'envelope',
    name:     A(root, 'name'),
    uniqueId: A(root, 'uniqueId'),
    className:A(root, 'className'),
    version:  versionOf(root),
    /* a millisecond epoch stamped when the envelope was created; absent on
       the 7.3-era files, and meaningless as an ordering key across machines */
    created:  A(el, 'uniqueId'),
    envelope: readEnvelope(el)
  };
}

/* An FFT "threshold" is not a stored field — the three "with Threshold"
   presets get it from a flat run at y=0 at the head of the envelope, which
   swallows every input below that phase. Ex FFT - Bass ON OFF does the same
   thing with a single Hold segment instead of a flat pair. Reported as the
   phase below which the envelope outputs nothing; 0 when there is no floor. */
function thresholdOf(env){
  if(!env || !env.points.length || env.points[0].value !== 0) return 0;
  let t = 0;
  for(let i = 1; i < env.points.length; i++){
    const p = env.points[i];
    if(p.value === 0){ t = p.phase; continue; }        // still on the floor
    if(p.curve === 'Hold'){ t = p.phase; }             // held at 0 right up to here
    break;
  }
  return t;
}

/* =========================================================================
   4. ANIMATION PRESETS — parameter-animation.htm
   "A parameter preset will save the playback mode, loopback mode, timeline
   mode, duration and envelope, start settings and animation settings. In/Out
   points are not saved." That sentence is the whole contract, and it is why
   nothing here touches the target parameter's in/out points.

   Naming collision worth stating once: Resolume's *playback* mode is the
   transport direction and its *loopback* mode is Loop/Ping Pong/Random/...
   The engine calls the second one `playmode` (arena-engine.js:936) and the
   first one `direction`, so the record carries `playmode` with the engine's
   meaning, `loopmode` as the manual's name for the same field, and
   `direction` for the transport.
   ========================================================================= */

/* video.htm lists the transport buttons in this order — backwards, pause,
   forwards for direction; Loop, Ping Pong, Random, Play Once and Eject, Play
   Once and Hold for playmode. The stored ints index those lists. Names are
   the clone's own vocabulary (arena-data.js DIRECTIONS / PLAY_MODES) so a
   parsed preset drops straight into a transport dropdown: "Bounce" is Arena's
   Ping Pong and "Play Once & Clear" is its Play Once and Eject. */
const DIRECTIONS = ['Backwards','Paused','Forwards'];
const PLAY_MODES = ['Loop','Bounce','Random','Play Once & Clear','Play Once & Hold'];

/* DurationSource@defaultDuration is a magnitude and a unit in one string —
   "4b" is four beats, "5s" five seconds. */
function readDurationSource(el){
  if(!el) return null;
  const d = String(A(el, 'defaultDuration') || '');
  const m = /^([\d.]+)\s*([bs])$/.exec(d);
  return {
    unit:     m ? (m[2] === 'b' ? 'beats' : 'seconds') : null,
    value:    m ? parseFloat(m[1]) : null,
    raw:      d || null,
    /* present only when the user overrode the default */
    userValue: num(el, 'userDuration'),
    /* Verified across all 31 shipped ParamRanges that carry both: `scale`
       equals the startStop span over the defaultRange span, exactly. So this
       is the in/out-point fraction, which is what "Duration Changes With In &
       Out Points" scales the duration by. The other 85 have no startStop and
       scale 1. */
    scale:    num(el, 'scale', 1)
  };
}

/* PhaseSourceTimeline in an Animation preset. The effect presets embed a
   variant of the same element with Beats/BPM/Syncmode instead of
   Duration/DurationType, so both shapes are read here. */
function readTimeline(el){
  const P = kid(el, 'Params');
  const hard = A(el, 'hardSynced');
  /* hardSynced is the Timeline/BPM Sync switch, and it also decides which of
     the two parameters labelled "Speed" is live: Speed (0..10) drives seconds
     mode, Multiplier (altName "Speed", 0..16) drives BPM. Both are always
     written, so reading the wrong one is silent. */
  /* Effect/source presets omit hardSynced, but encode the same distinction in
     the phase-source class itself: PhaseSourceTimeline is seconds and
     PhaseSourceTransportTimeline is BPM Sync. Treating the missing attribute
     as unknown made ArenaEngine fall back to an arbitrary four-second
     Timeline for almost every factory preset. */
  const transportTimeline = el.tagName === 'PhaseSourceTransportTimeline';
  const beatsMode = hard === null ? transportTimeline : hard === '1';
  const dur   = namedChild(P, 'Duration');
  const dtype = valueOf(P, 'DurationType', null);
  const interval = namedChild(P, 'Interval');
  const distance = namedChild(P, 'Max Distance');
  /* video.htm is explicit that Interval and Distance use the active
     transport's unit. Keep that unit beside each raw value instead of
     silently treating both as normalised phase; 1 means one second in
     Timeline and one beat in BPM Sync. */
  const randomUnit = beatsMode ? 'beats' : 'seconds';
  const out = {
    mode:      beatsMode ? 'BPM Sync' : 'Timeline',
    hardSynced: hard === null ? beatsMode : hard === '1',
    direction: DIRECTIONS[valueOf(P, 'PlayDirection', -1)] || null,
    playmode:  PLAY_MODES[valueOf(P, 'PlayMode', -1)] || null,
    speed:     valueOf(P, beatsMode ? 'Multiplier' : 'Speed', null),
    /* video.htm: in Random playmode "Interval controls how often the playhead
       will jump" and Distance "the range from which a random point will be
       picked" — both meaningless in the other playmodes, both always written */
    interval:  valueOf(P, 'Interval', null),
    distance:  valueOf(P, 'Max Distance', null),
    intervalUnit: randomUnit,
    distanceUnit: randomUnit,
    intervalRange: rangeOf(interval, 'defaultRange') || rangeOf(interval, 'range'),
    distanceRange: rangeOf(distance, 'defaultRange') || rangeOf(distance, 'range'),
    durationScalesWithInOut: A(namedChild(P, 'DurationIsScalable'), 'value') === '1',
    /* the two fallbacks the UI shows when you flip modes */
    defaults:  {ms: num(el, 'defaultMillisecondsDuration'), beats: num(el, 'defaultBeatsDuration')},
    duration:  null, beats: null, durationType: null,
    /* the playhead position at save time. Cosmetic — animate() starts at 0. */
    savedPhase: num(el, 'phase'),
    /* the pick-up modes; only 0 (play from start) occurs anywhere in the data */
    playmodeAway: valueOf(P, 'PlayModeAway', null),
    /* the effect-embedded variant's own fields */
    syncmode:  valueOf(P, 'Syncmode', null),
    bpm:       valueOf(P, 'BPM', null)
  };
  if(dur){
    /* DurationType 0 = seconds, 2 = beats. 1 is never written anywhere in the
       shipped data and its meaning is unknown; a file carrying it is passed
       through as the raw integer rather than guessed at. */
    out.durationType = dtype === 0 ? 'seconds' : dtype === 2 ? 'beats' : dtype;
    const v = num(dur, 'value');
    if(dtype === 2) out.beats = v; else if(dtype === 0) out.duration = v;
  } else {
    /* effect-embedded form: Beats is a plain parameter and the seconds
       duration lives on the host ParamRange's DurationSource */
    out.beats = valueOf(P, 'Beats', null);
  }
  return out;
}

/* PhaseSourceFFT. There is no L/M/H field: parameter-animation.htm says the
   L, M and H buttons are shorthand for "the in and out points below the audio
   spectrum display", and those in/out points are FrequencyRange's startStop,
   normalised 0..1 across the spectrum. FrequencyRange@value is the live meter
   reading at save time, not a band edge, and is dropped. */
function readFFT(el){
  const P = kid(el, 'Params');
  const band = rangeOf(namedChild(P, 'FrequencyRange'), 'startStop') || {min: null, max: null};
  const db   = valueOf(P, 'Gain', 0);
  const ms   = valueOf(P, 'Fallback', 1000);
  const link = A(el, 'linkId');
  const beh  = valueOf(P, 'ValueBehaviour', null);
  const mid  = band.min === null ? null : (band.min + band.max) / 2;
  return {
    link,
    /* All four shipped FFT presets are External FFT. Composition, Layer and
       Clip FFT would carry a different linkId and no example exists here, so
       an unrecognised link is reported as plain 'FFT' rather than named. */
    mode: link === '/audioengine/externalfft' ? 'External FFT' : 'FFT',
    bandLow: band.min, bandHigh: band.max,
    /* The engine's runAnimations() picks one of three synthesised bands by
       letter, so the range is collapsed onto the nearest third of the
       spectrum. Approximate by construction — bandLow/bandHigh are the truth
       and the only values worth round-tripping. */
    band: mid === null ? null : mid < 1/3 ? 'L' : mid < 2/3 ? 'M' : 'H',
    /* stored in dB over -48..48; a.gain in the engine is a linear multiplier */
    gainDb: db, gain: Math.pow(10, db / 20),
    /* the Fall control, "how quickly the value falls back from a peak",
       stored in ms over 100..2000; a.fall is in seconds */
    fallMs: ms, fall: ms / 1000,
    /* the >, <, - and + buttons. Only 0 occurs in the data and the documented
       default is drive-low-to-high, so 0 is named and 1..3 are left raw. */
    behaviourCode: beh,
    behaviour: beh === 0 ? 'Low to High' : null,
    threshold: 0                                    // filled in from the envelope below
  };
}

/* AnimationStarter@flags / AnimationSettings > Setting@flags is a uint64
   bitfield of the Parameter Start Settings — composition load, clip trigger,
   column trigger, run manually, plus BPM Phase Lock. Only four distinct values
   exist across the whole data directory (8, 0x8000000000000001,
   0x8000000000000002, 0xFFFFFFFFFFFFFFFF), which pins bit 0 to Clip Trigger —
   that value is both the overwhelming majority and the documented clip-level
   default — and settles nothing else. The rest of the field is passed through
   untouched.
   BigInt, not Number: 9223372036854775809 rounds to ...808 as a double and
   loses precisely the bit we can read. */
function readStarter(el){
  const raw = A(el, 'flags');
  let clipTrigger = null;
  try { if(raw != null) clipTrigger = (BigInt(raw) & 1n) === 1n; } catch(e){ /* leave unknown */ }
  return {flags: raw, clipTrigger};
}

function parseAnimation(xml){
  const root = toRoot(xml);
  const anim = kid(root, 'Animation') || desc(root, 'Animation');
  if(!anim) throw new Error('arena-presets: no <Animation> in this file');

  const tl  = kid(anim, 'PhaseSourceTimeline') || kid(anim, 'PhaseSourceTransportTimeline');
  const ff  = kid(anim, 'PhaseSourceFFT');
  const dash = kid(anim, 'PhaseSourceDashboardLink');
  const env = readEnvelope(desc(anim, 'ModifierEnvelope'));
  const src = readDurationSource(kid(anim, 'DurationSource'));

  const rec = {
    kind:      'animation',
    name:      A(root, 'name'),
    uniqueId:  A(root, 'uniqueId'),
    className: A(root, 'className'),
    version:   versionOf(root),
    mode: null, playmode: null, loopmode: null, direction: null,
    speed: null, duration: null, beats: null, durationType: null,
    interval: null, distance: null, intervalUnit: null, distanceUnit: null,
    intervalRange: null, distanceRange: null, durationScalesWithInOut: false,
    defaults: null, durationSource: src, savedPhase: null,
    fft: null, envelope: env,
    start: readStarter(kid(anim, 'AnimationStarter'))
  };

  if(tl){
    const t = readTimeline(tl);
    rec.mode = t.mode;
    rec.playmode = rec.loopmode = t.playmode;      // one field, two manual names
    rec.direction = t.direction;
    rec.speed = t.speed;
    rec.duration = t.duration; rec.beats = t.beats; rec.durationType = t.durationType;
    rec.interval = t.interval; rec.distance = t.distance;
    rec.intervalUnit = t.intervalUnit; rec.distanceUnit = t.distanceUnit;
    rec.intervalRange = t.intervalRange; rec.distanceRange = t.distanceRange;
    rec.durationScalesWithInOut = t.durationScalesWithInOut;
    rec.defaults = t.defaults; rec.savedPhase = t.savedPhase;
    rec.timeline = t;
  } else if(ff){
    const f = readFFT(ff);
    f.threshold = thresholdOf(env);
    rec.mode = f.mode;
    rec.fft = f;
    rec.savedPhase = num(ff, 'phase');
  } else if(dash){
    /* dashboard.htm — a parameter driven by one of the eight dials records it
       as a link, /link1../link8. No preset in the shipped set uses this; it
       appears eight times in default/Example.avc, which is where the element
       name and the linkId form come from. */
    const m = /(\d+)$/.exec(A(dash, 'linkId') || '');
    rec.mode = 'Dashboard';
    rec.dial = m ? +m[1] : null;
  }
  /* the duration unit is metadata even for FFT, where duration is unused */
  if(src) rec.durationUnit = src.unit;
  return rec;
}

/* A parsed record as ArenaEngine.animate() wants it. Only keys with real
   values are emitted so animate()'s own defaults fill the rest. Parameter
   in/out points are applied by the caller because they belong to the target
   Parameter, not its animation object. fft.threshold is deliberately not
   passed: it is a shape in the envelope, and envelopeAt() reproduces it
   exactly from `env`. Interval and Distance remain in their documented
   transport units; the engine converts them to phase only while evaluating
   the matching seconds/beats duration. */
function toAnimSpec(rec){
  /* Do not force phase 0 here: animate() starts backwards transports at phase
     1, which is required by reverse one-shots. `savedPhase` is the editor
     playhead at save time and remains intentionally cosmetic. */
  const s = {running: true};
  if(rec.mode) s.mode = rec.mode;
  if(rec.playmode) s.playmode = rec.playmode;
  if(rec.direction) s.direction = rec.direction;
  if(rec.speed != null) s.speed = rec.speed;
  const sourceDuration = rec.durationSource &&
    (rec.durationSource.userValue != null
      ? rec.durationSource.userValue : rec.durationSource.value);
  if(rec.duration != null) s.duration = rec.duration;
  else if(rec.mode === 'Timeline' && sourceDuration != null) s.duration = sourceDuration;
  if(rec.beats != null) s.beats = rec.beats;
  else if(rec.mode === 'BPM Sync' && sourceDuration != null) s.beats = sourceDuration;
  if(rec.interval != null) s.interval = rec.interval;
  if(rec.distance != null) s.distance = rec.distance;
  if(rec.intervalUnit) s.intervalUnit = rec.intervalUnit;
  if(rec.distanceUnit) s.distanceUnit = rec.distanceUnit;
  /* Each applied instance owns its envelope points. The preset XML decode is
     cached, and assigning the record object here made two otherwise separate
     Effects share edits to the same point array. */
  if(rec.envelope) s.env = clonePresetData(rec.envelope);
  if(rec.fft){ s.band = rec.fft.band; s.gain = rec.fft.gain; s.fall = rec.fft.fall; }
  return s;
}

/* =========================================================================
   5. COLOUR PALETTES — parameters.htm > Palette
   "On a Palette, you can keep a range of your favorite colors." The swatches
   are <Choice> children in document order, which is the order the UI shows
   and the order the Sort and Flip options rewrite, so it must be preserved.
   ========================================================================= */
function parsePalette(xml){
  const root = toRoot(xml);
  const pc = desc(root, 'ParamChoice');
  if(!pc) throw new Error('arena-presets: no ParamChoice in this palette');
  const src = pc.getElementsByTagName('Choice');
  const swatches = [], rgba = [];
  for(let i = 0; i < src.length; i++){
    /* Choice@value is a uint32 packed 0xAABBGGRR — the RGBA bytes in memory,
       little-endian. Reading it as ARGB swaps red and blue, and the tell is
       that "Blue" ships as 4294901760 = 0xFFFF0000. */
    const v = (+A(src[i], 'value')) >>> 0;
    const c = {r: v & 255, g: (v >> 8) & 255, b: (v >> 16) & 255, a: (v >>> 24) & 255,
               enabled: bool(src[i], 'enabled'), active: bool(src[i], 'active')};
    /* Choice@name is a debug label from a formatter that drops each byte's
       leading zero (#0A0636FF is written "0xa636ff") and appends a
       disambiguation counter. It is never the colour. */
    c.css = '#' + [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    swatches.push(c.css); rgba.push(c);
  }
  return {
    kind:      'palette',
    name:      A(root, 'name'),
    uniqueId:  A(root, 'uniqueId'),
    className: A(root, 'className'),
    version:   versionOf(root),
    swatches, rgba
    /* ParamChoice@value is deliberately dropped: it is the parameter's colour
       at save time and is frequently not one of the swatches at all —
       Greyscale Chimpanzee stores pure green over an eleven-step grey ramp. */
  };
}

/* The nine swatches every ParamColor carries before you touch it, which is
   what parameters.htm's "replace them with the default ones" restores.
   Taken from the inline <ColorPalette> in the shipped ParamColor elements. */
const DEFAULT_PALETTE = ['#000000','#FF0000','#00FF00','#FFFF00','#7F7F7F',
                         '#0000FF','#FF00FF','#00FFFF','#FFFFFF'];

/* =========================================================================
   6. RENDER AND RECORD — recording.htm, rendering-to-dxv.htm
   Five attributes and a path. Included because it completes the folder, not
   because there is anything to decode.
   ========================================================================= */
function parseConversion(xml){
  const root = toRoot(xml);
  const c = kid(root, 'Conversion');
  if(!c) throw new Error('arena-presets: no <Conversion> in this file');
  return {
    kind:      'conversion',
    name:      A(root, 'name'),
    uniqueId:  A(root, 'uniqueId'),
    className: A(root, 'className'),
    version:   versionOf(root),
    codec:  A(c, 'Codec'), format: A(c, 'Format'),
    autoSize: A(c, 'AutoSize'), customSize: bool(c, 'CustomSize'),
    audio: bool(c, 'AudioEnabled'), sampleRate: num(c, 'SampleRate'), bitDepth: num(c, 'BitDepth'),
    /* every one of the eleven ships the original author's macOS home
       directory. A load must substitute the local recordings folder. */
    outputPath: A(kid(c, 'OutputPath'), 'Path'),
    outputPathType: num(kid(c, 'OutputPath'), 'Type')
  };
}

/* =========================================================================
   7. DISPATCH
   Sources and Video Effects decode their plugin snapshots here, including
   embedded parameter animations. Interface is still only classified because
   it describes window layout rather than engine state.
   ========================================================================= */
/* Source and effect snapshots share the XML grammar but not their role. A
   source creates Clip content; an effect modifies an existing stream. Keep
   `kind` in every lookup/cache key so same-name records cannot cross roles.

   Only the innermost plugin's direct <Params> children are user parameters.
   The dry/wet wrapper and ChoosableMixer are implementation layers and are
   decoded separately. */
const STATIC_PARAM_TAGS = {
  Param: 1, ParamRange: 1, ParamChoice: 1,
  ParamColor: 1, ParamText: 1, ParamFile: 1
};

function scalar(raw){
  if(raw === null || raw === undefined) return null;
  const s = String(raw);
  if(s === '') return '';
  const n = Number(s);
  if(/^[+-]?\d+$/.test(s) && !Number.isSafeInteger(n)) return s;
  return Number.isFinite(n) ? n : s;
}

function booleanValue(raw){
  if(raw === null || raw === undefined) return null;
  return raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true';
}

/* Preset XML stores colour as 0xAABBGGRR; the engine contract is
   0xAARRGGBB. Both representations are retained for lossless persistence. */
function presetColorToEngine(raw){
  if(raw === null || raw === undefined || raw === '') return null;
  const v = Number(raw) >>> 0;
  return ((v & 0xff000000) | ((v & 0x000000ff) << 16) |
          (v & 0x0000ff00) | ((v & 0x00ff0000) >>> 16)) >>> 0;
}

function decodePresetColor(raw){
  if(raw === null || raw === undefined || raw === '') return null;
  const preset = Number(raw) >>> 0;
  const r = preset & 0xff, g = (preset >>> 8) & 0xff;
  const b = (preset >>> 16) & 0xff, a = (preset >>> 24) & 0xff;
  return {
    preset, engine: presetColorToEngine(preset), r, g, b, a,
    css: 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255).toFixed(3) + ')'
  };
}

function directChoiceValues(el){
  return kids(el, 'Choice').map(c => ({
    name: A(c, 'name'), value: scalar(A(c, 'value')),
    enabled: A(c, 'enabled') === null ? null : booleanValue(A(c, 'enabled')),
    active: A(c, 'active') === null ? null : booleanValue(A(c, 'active'))
  }));
}

/* ParamColor does not store palette swatches directly under ColorPalette:
   the real path is ColorPalette/Params/ParamChoice/Choice. Keep the packed
   preset colour for round-tripping and expose the converted engine colour as
   the value a renderer should consume. */
function decodeColorPalette(el){
  const paletteEl = kid(el, 'ColorPalette');
  const params = kid(paletteEl, 'Params');
  const choice = namedChild(params, 'Colors') || kid(params, 'ParamChoice');
  if(!choice) return null;
  const color = decodePresetColor(A(choice, 'value'));
  const defaultColor = decodePresetColor(A(choice, 'default'));
  const choices = kids(choice, 'Choice').map(c => {
    const choiceColor = decodePresetColor(A(c, 'value'));
    return {
      name: A(c, 'name'), shortName: A(c, 'shortName'),
      value: choiceColor ? choiceColor.engine : null,
      sourceValue: choiceColor ? choiceColor.preset : null,
      color: choiceColor,
      enabled: A(c, 'enabled') === null ? null : booleanValue(A(c, 'enabled')),
      active: A(c, 'active') === null ? null : booleanValue(A(c, 'active'))
    };
  });
  return {
    name: A(choice, 'name'), label: A(choice, 'altName') || A(choice, 'name'),
    value: color ? color.engine : null,
    default: defaultColor ? defaultColor.engine : null,
    sourceValue: color ? color.preset : null,
    sourceDefault: defaultColor ? defaultColor.preset : null,
    color, defaultColor,
    storeChoices: A(choice, 'storeChoices') === null ? null : booleanValue(A(choice, 'storeChoices')),
    choices
  };
}

function decodeTextLines(el){
  const linesParam = namedChild(kid(el, 'Params'), 'Lines');
  if(!linesParam) return null;
  const raw = A(linesParam, 'value');
  const value = raw === null ? '' : String(raw);
  const rawDefault = A(linesParam, 'default');
  return {
    value,
    default: rawDefault === null ? null : String(rawDefault),
    values: value.split(/\r\n?|\n/)
  };
}

function fileValue(el){
  const attrs = ['value', 'path', 'Path', 'file', 'fileName', 'filename'];
  for(let i = 0; i < attrs.length; i++){
    const v = A(el, attrs[i]);
    if(v !== null) return v;
  }
  const child = kid(el, 'Path') || kid(el, 'File');
  if(!child) return null;
  for(let i = 0; i < attrs.length; i++){
    const v = A(child, attrs[i]);
    if(v !== null) return v;
  }
  return null;
}

function decodeStaticParam(el){
  if(!el || !STATIC_PARAM_TAGS[el.tagName]) return null;
  const tag = el.tagName, name = A(el, 'name');
  let type = 'value', raw = A(el, 'value'), value, defaultValue, textLines = null;
  if(tag === 'ParamRange') type = 'range';
  else if(tag === 'ParamChoice') type = 'choice';
  else if(tag === 'ParamColor') type = 'color';
  else if(tag === 'ParamText') type = 'text';
  else if(tag === 'ParamFile') type = 'file';
  else if(A(el, 'T') === 'BOOL') type = 'bool';
  else if(A(el, 'T') === 'STRING') type = 'text';

  if(type === 'bool'){
    value = booleanValue(raw);
    defaultValue = booleanValue(A(el, 'default'));
  } else if(type === 'color'){
    raw = raw === null ? A(el, 'color') : raw;
    const color = decodePresetColor(raw);
    const defaultColor = decodePresetColor(A(el, 'default'));
    value = color ? color.engine : null;
    defaultValue = defaultColor ? defaultColor.engine : null;
    const channels = kid(el, 'Params');
    const channelValues = {};
    const channelElements = elements(channels);
    for(let i = 0; i < channelElements.length; i++){
      const ch = channelElements[i];
      if(STATIC_PARAM_TAGS[ch.tagName]) channelValues[A(ch, 'name')] = scalar(A(ch, 'value'));
    }
    const palette = decodeColorPalette(el);
    return {
      name, label: A(el, 'altName') || name, tag, type,
      value, default: defaultValue, sourceValue: color ? color.preset : null,
      sourceDefault: defaultColor ? defaultColor.preset : null,
      color, defaultColor, channels: channelValues,
      channelMode: scalar(A(el, 'channelmode')),
      paletteEnabled: A(el, 'paletteEnabled') === null ? null : booleanValue(A(el, 'paletteEnabled')),
      palette,
      choices: palette ? palette.choices : []
    };
  } else if(type === 'text'){
    textLines = decodeTextLines(el);
    value = textLines ? textLines.value : (raw === null ? '' : String(raw));
    defaultValue = textLines ? textLines.default :
      (A(el, 'default') === null ? null : String(A(el, 'default')));
  } else if(type === 'file'){
    value = fileValue(el);
    defaultValue = A(el, 'default');
  } else {
    value = scalar(raw);
    defaultValue = scalar(A(el, 'default'));
  }

  const record = {
    name, label: A(el, 'altName') || name, tag, type,
    value, default: defaultValue
  };
  if(type === 'range'){
    record.range = rangeOf(el, 'defaultRange');
    record.minMax = rangeOf(el, 'minMax');
    record.inOut = rangeOf(el, 'startStop');
  }
  if(type === 'choice') record.choices = directChoiceValues(el);
  if(textLines){
    record.lines = textLines.values.slice();
    record.values = textLines.values.slice();
    record.savedPhase = scalar(raw);
  }
  return record;
}

function descendants(el, tag){
  if(!el || !el.getElementsByTagName) return [];
  return Array.prototype.slice.call(el.getElementsByTagName(tag) || []);
}

function pluginPass(root, kind){
  const all = descendants(root, 'RenderPass');
  const wantedBase = kind === 'source' ? 'Generator' : 'Effect';
  for(let i = 0; i < all.length; i++) if(A(all[i], 'baseType') === wantedBase) return all[i];
  const id = A(root, 'uniqueId');
  for(let i = all.length - 1; i >= 0; i--) if(A(all[i], 'uniqueTypeId') === id) return all[i];
  return null;
}

function wrapperPass(root, kind, plugin){
  if(kind === 'effect'){
    const outer = kid(root, 'RenderPass');
    return outer === plugin ? null : outer;
  }
  const source = desc(root, 'VideoSource');
  const passes = kids(source, 'RenderPass');
  for(let i = 0; i < passes.length; i++){
    if(passes[i] !== plugin && A(passes[i], 'baseType') === 'RenderPassChain') return passes[i];
  }
  return null;
}

function decodeWrapper(pass){
  const params = kid(pass, 'Params');
  const bypass = namedChild(params, 'Bypassed');
  const opacity = namedChild(params, 'Opacity');
  return {
    bypassed: bypass ? booleanValue(A(bypass, 'value')) : null,
    opacity: opacity ? scalar(A(opacity, 'value')) : null
  };
}

function decodeMixer(root){
  const chooser = desc(root, 'ChoosableMixer');
  if(!chooser) return null;
  const passes = kids(chooser, 'RenderPass');
  let selected = null;
  for(let i = 0; i < passes.length; i++){
    if(A(passes[i], 'baseType') === 'Mixer') { selected = passes[i]; break; }
  }
  const choice = decodeStaticParam(namedChild(kid(chooser, 'Params'), 'Blend Mode'));
  return {
    name: selected ? A(selected, 'name') : null,
    uniqueId: selected ? A(selected, 'uniqueTypeId') : null,
    choice: choice ? choice.value : null
  };
}

function classify(root){
  root = toRoot(root);
  if(root.tagName === 'Layout') return 'layout';       // Interface/*.xml is not a <Preset>
  const id = A(root, 'uniqueId');
  if(id === 'Animation') return 'animation';
  if(id === 'MOD_ENVELOPE') return 'envelope';
  if(id === 'PARAM_SPACE_COLOR_PALETTE') return 'palette';
  if(id === 'CONVERSION') return 'conversion';
  if(desc(root, 'VideoSource')) return 'source';
  if(kid(root, 'RenderPass')) return 'effect';
  return 'unknown';
}

/* Every parameter in a source or effect preset that carries a phase source,
   i.e. every one that is actually animated. Everything else holds a
   <PhaseSourceStatic>, which means "no animation".

   Not just sliders: parameter-animation.htm's "Animate Everything!" covers
   toggles, events, dropdowns, colours and text too, and the data agrees —
   Sources/Text Animator/Countdown from 10 with fade animates a ParamText,
   where @value stops being the string and becomes the phase across the
   choices (the manual's Basic mode). Matching on the Param* prefix rather
   than on ParamRange is what catches it. */
function embeddedAnimations(root, plugin){
  const out = [];
  (function walk(el){
    const k = elements(el);
    for(let i = 0; i < k.length; i++){
      const p = k[i];
      if(p.tagName.slice(0, 5) === 'Param' && p.tagName !== 'Params'){
        const tl = kid(p, 'PhaseSourceTimeline') || kid(p, 'PhaseSourceTransportTimeline');
        const ff = kid(p, 'PhaseSourceFFT');
        if(tl || ff){
          const env = readEnvelope(desc(kid(p, 'BehaviourDouble'), 'ModifierEnvelope'));
          let group=null, parent=p.parentNode;
          while(parent && parent !== plugin){
            if(parent.tagName === 'Params' && parent.parentNode === plugin){
              const groupName=A(parent,'name') || 'Params';
              group=groupName === 'Params' ? null : groupName;
              break;
            }
            parent=parent.parentNode;
          }
          const param=A(p, 'name');
          const rec = {param, path:group ? group+'/'+param : param, group,
                       label: A(p, 'altName') || param,
                       type: p.tagName, value: num(p, 'value'), envelope: env,
                       durationSource: readDurationSource(kid(p, 'DurationSource')),
                       range: rangeOf(p, 'defaultRange'),
                       /* Springy sweeps 0..200 of a 0..360 parameter: on an
                          animated parameter, startStop is the animation's
                          value in/out points, not a limit. */
                       inOut: rangeOf(p, 'startStop')};
          if(tl) Object.assign(rec, readTimeline(tl));
          if(ff){ rec.fft = readFFT(ff); rec.fft.threshold = thresholdOf(env); rec.mode = rec.fft.mode; }
          if(rec.playmode) rec.loopmode = rec.playmode;
          out.push(rec);
        }
      }
      walk(p);
    }
  })(toRoot(root));
  return out;
}

function parse(xml, name){
  const root = toRoot(xml);
  const kind = classify(root);
  if(kind === 'animation')  return parseAnimation(root);
  if(kind === 'envelope')   return parseEnvelope(root);
  if(kind === 'palette')    return parsePalette(root);
  if(kind === 'conversion') return parseConversion(root);
  if(kind === 'layout') return {
    /* layouts.htm. The docking tree and the View menu are real data, but
       nothing in the clone consumes a window layout yet, so this reports the
       file rather than decoding it. Note the name has to come from the
       caller: <Layout> carries no name attribute, only the filename does.
       The View-menu block is 36 booleans on eight of the ten shipped layouts
       and 34 on Big Monitor and Monitor Top Left, so it is not a fixed list. */
    kind, name: name || null, layoutVersion: A(root, 'version'), version: versionOf(root),
    windows:      root.getElementsByTagName('Window').length,
    hiddenPanels: elements(kid(root, 'HiddenPanels')).length,
    viewOptions:  elements(desc(root, 'Params')).length
  };
  /* Preset@uniqueId is the plugin identity and equals the innermost
     RenderPass@uniqueTypeId. Bind on it, never on the folder name: Video
     Effects/Tile holds four A113 TileEffect presets and one (Luxaflex) for
     the older A041 Tile. 38 of the presets also carry an <FFGLPlugin
     fileName> naming one of ten bundles inside an Arena 6 install on the
     author's Mac; the path is dead and only the uniqueId means anything. */
  if(kind === 'source' || kind === 'effect'){
    const videoSource = kind === 'source' ? desc(root, 'VideoSource') : null;
    const plugin = pluginPass(root, kind);
    const wrapper = wrapperPass(root, kind, plugin);
    const animations = embeddedAnimations(root, plugin);
    const byName = {}, byPath={};
    animations.forEach(a => { if(!byName[a.param]) byName[a.param] = a; });
    animations.forEach(a => { if(a.path && !byPath[a.path]) byPath[a.path] = a; });
    const params = [];
    const groups=elements(plugin).filter(el=>el.tagName === 'Params');
    for(let blockIndex=0; blockIndex<groups.length; blockIndex++){
      const block=groups[blockIndex];
      const groupName=A(block,'name') || 'Params';
      const group=groupName === 'Params' ? null : groupName;
      const pluginParamElements = elements(block);
      for(let i = 0; i < pluginParamElements.length; i++){
        const el = pluginParamElements[i];
        if(!STATIC_PARAM_TAGS[el.tagName] || A(el, 'name') === 'Bypassed') continue;
        const p = decodeStaticParam(el);
        if(!p) continue;
        p.group=group;
        p.path=group ? group+'/'+p.name : p.name;
        if(byPath[p.path] || (!group && byName[p.name]))
          p.animation=byPath[p.path] || byName[p.name];
        params.push(p);
      }
    }
    const values = {}, valuesByPath={};
    params.forEach(p => {
      valuesByPath[p.path]=p.value;
      if(!Object.prototype.hasOwnProperty.call(values,p.name)) values[p.name]=p.value;
    });
    return {
      kind, name: A(root, 'name'), uniqueId: A(root, 'uniqueId'),
      className: A(root, 'className'), version: versionOf(root),
      pluginPassName: plugin ? (A(plugin, 'name') || A(plugin, 'type')) : null,
      /* Source raster belongs to the saved Source configuration. Almost all
         factory presets are 1920x1080, but Lines/45 Degree Pan is 1280x720;
         silently using the Clip default makes that child a different preset. */
      source: videoSource ? {
        width:num(videoSource, 'width'), height:num(videoSource, 'height')
      } : null,
      wrapper: decodeWrapper(wrapper), mixer: kind === 'effect' ? decodeMixer(root) : null,
      params, values, valuesByPath, animations
    };
  }
  return {
    kind, name: A(root, 'name'), uniqueId: A(root, 'uniqueId'),
    className: A(root, 'className'), version: versionOf(root), animations: []
  };
}

/* =========================================================================
   8. INVENTORY
   Every preset on disk at $SOURCE_HOME/.../default/Presets, so a panel can list
   them without walking a directory the browser cannot see. Names are literal;
   the file path is derived, because Preset@name equals the filename stem in
   all 245 files (checked, zero exceptions). Order is the order the files sort
   on disk, which is why "BPM - Step 1 2 3 4" precedes "BPM - Step 1 2".
   ========================================================================= */
const PRESET_ROOT = '$SOURCE_HOME/New Openlive/Resolume Arena  Clone godrick/default/Presets';
const PRESET_BASE = 'default/Presets';                 // how a composition addresses them

/* folder, kind, names */
const FLAT = [
  ['Animation', 'animation', [
    'BPM - 1 to the Floor', 'BPM - 4 to the Floor', 'BPM - On Off', 'BPM - Random',
    'BPM - Step 1 2 3 4', 'BPM - Step 1 2', 'Double Trouble', 'Ex FFT - Bass ON OFF',
    'Ex FFT - Bass with Threshold', 'Ex FFT - Low-Mid with Threshold',
    'Ex FFT - Mid with Threshold', 'Glitchy', 'Jittery', 'Jumpy', 'Wavey'
  ]],
  ['Color Palettes', 'palette', [
    'Broadway Boogie Woogie', 'Clockwork Orange', 'Greyscale Chimpanzee', 'Inferno',
    'Lichtenstein', 'Magma', 'Mona Lisa', 'Plasma', 'Purple Rain', 'Rainbow',
    'Shades of Salmon', 'Viridis', 'Warhol'
  ]],
  ['Envelopes', 'envelope', [
    '4 To The Floor', 'ADSR', 'ASR', 'Digital', 'EasyEase', 'Jaws', 'LFO', 'Noise', 'Saw',
    'Up N Down'
  ]],
  ['Interface', 'layout', [
    'Big Monitor', 'Dual Display', 'Many Layers', 'Many Monitors Left', 'Many Monitors Top',
    'Minimal', 'Monitor Top Left', 'Panels Left & Right', 'Panels On Top', 'Triple Display'
  ]],
  ['Render and Record', 'conversion', [
    'DXV 3 High Quality No Alpha', 'DXV 3 High Quality With Alpha',
    'DXV 3 Normal Quality No Alpha', 'DXV 3 Normal Quality With Alpha', 'H264 High Quality',
    'H264 Low Quality', 'H264 Medium Quality', 'Motion JPEG', 'ProRes 422 High Quality',
    'ProRes 422 Normal Quality', 'ProRes 4444'
  ]]
];

/* sub-folder, plugin uniqueId, className, names */
const SOURCES = [
  ['Abstract Field', 'c_35de2952-eebe-4238-ac4a-2e9864da6621', 'WireGenerator', [
    'Big Sweepers', 'Dot Dot Dot', 'In & Out Fader', 'Smoke Storm', 'Thin Lines', 'Wavey'
  ]],
  ['Checkered', '736772465707583394', 'Checkered', ['Doe Maar']],
  ['Gradient', 'A401', 'Gradient', [
    'Banding Test - Gray', 'Banding Test - Green', 'Delta Sun', 'Dutch Sky', 'Smooth Edges',
    'Vignette'
  ]],
  ['Line Scape', 'P204', 'Line Scape', [
    'Dancing In The Dark', 'Harp Strings', 'Lasers', 'Line Wobble', 'Sand Dunes', 'Water Fall',
    'Waving Ribbons'
  ]],
  ['Lines', 'P201', 'Lines', ['45 Degree Pan', 'Neon Up']],
  ['Metaballs', '844752396506092017', 'Metaballs', [
    'Gummy', 'Micro encounters', 'Red cells', 'Virus'
  ]],
  ['Rings', '8642267115', 'Rings', [
    '3 Some', 'Animate', 'FireFlies', 'Flappy Bird', 'Light House', 'Near Misses', 'Radar',
    'Saw', 'Sparkles'
  ]],
  ['Shaper', '7946640550597690042', 'ShaperGenerator', ['Identity Crisis']],
  ['Sine Wave', '9011349750094602', 'SineWave', [
    'Curvacious', 'Dancing windows', 'Habichuelas', 'Hair dance', 'In the clouds', 'Kisses',
    'Lava lamp', 'Phantom signal', 'River', 'Rorschach', 'Spain', 'Waterflow'
  ]],
  ['Spiral', '884102460919', 'Spiral', [
    'Minimal', 'Outerscope', 'Propeller', 'Radial emissions', 'Revolutions', 'Sea dizyness',
    'Solar eclipse'
  ]],
  ['Stroboscope', 'MSTR', 'StroboscopeGenerator', ['Fast', 'Heartbeat']],
  ['Text Animator', '11421072728336491440', 'TextGenerator', [
    'Countdown from 10 with fade', 'Countdown from 10', 'Dangle', 'Flickr', 'One Shot',
    'Type On & Off', 'Wave'
  ]],
  ['Tunnelines', 'c_7312a083-7086-48df-9619-081fb81b456a', 'WireGenerator', [
    'Doughnut', 'Left & Right', 'Nauseating', 'Spinnin', 'Spiraling Heart', 'Wormhole'
  ]]
];

const EFFECTS = [
  ['Add Subtract', 'A101', 'AddSubtract', ['Blue', 'Green', 'Red']],
  ['Blow', 'A139', 'Blow', ['Bright Lines', 'Solid']],
  ['Colorize', 'A103', 'Colorize', ['Blue', 'Pink', 'Rainbow Palette']],
  ['Cube Tiles', 'A117', 'CubeTiles', [
    'Closeup', 'Complex', 'Inside Cube', 'Nauseating', 'Rotation', 'Slow Rotate', 'Tiles'
  ]],
  ['Distortion', 'A129', 'Distortion', ['Dr Bibber']],
  ['Flip', 'A104', 'Flip', ['Ace of Spades', 'Soft Mirror H', 'Soft Mirror V', 'Surface Refraction']],
  ['Fragment', 'sy08', 'Fragment', ['Horizon', 'Mist', 'Shake']],
  ['Freeze', 'A132', 'Freeze', ['Frozen Solid', 'Stop & Fade']],
  ['Goo', 'sy06', 'Goo', ['Jagged', 'Pieces', 'Shimmer']],
  ['Invert RGB', 'A105', 'InvertRGB', ['Sweded']],
  ['Iterate', 'sy13', 'Iterate', ['Rotator', 'Shards', 'Swirly', 'hBlur']],
  ['Kaleidoscope', 'sy02', 'Kaleidoscope', ['Insanity', 'Moving']],
  ['Keystone', 'A137', 'Keystone', ['Pyramid']],
  ['Linear Cloner', '9611534302831352414', 'LinearCloner', [
    'Basic', 'Comet Spin', 'Dual Head', 'Octopussy', 'Trail Twist', 'Wokkel', 'Worm Twist',
    'Xenomorph', 'Yin&Yang'
  ]],
  ['LoRez', 'A039', 'LoRez', ['Mario']],
  ['Mirror', 'A108', 'Mirror', ['Basic', 'Black Hole', 'Horizontal']],
  ['Particle System', 'A191', 'ParticleSystem', [
    'BlurryButterfly', 'Fountain', 'Rain', 'Random', 'Starfield', 'Windows95'
  ]],
  ['Radial Cloner', '15777305184926876320', 'RadialCloner', [
    'Beat Bounce', 'Divide', 'Fibonacci Spiral', 'Fibonacci Twist', 'Half Gate', 'Revealer',
    'Springy'
  ]],
  ['RadialBlur', 'sy03', 'RadialBlur', ['Spiral']],
  ['Ripples', 'sy05', 'Ripples', ['Gentle', 'Spikes']],
  /* "Hoirzontal" is Resolume's own typo, kept because it is the filename */
  ['Shift Glitch', 'MBSH', 'Shift Glitch', ['Hoirzontal', 'Kapot', 'Lines', 'Vertical']],
  ['Shift RGB', 'A153', 'ShiftRGB', ['3D Glasses', 'Acid Trip', 'Just Good', 'RGB Rotated', 'Up & Down']],
  ['Slide', 'A136', 'Slide', ['4D', 'Down', 'Left', 'Right', 'Up']],
  ['Static', 'MSTF', 'StaticEffect', ['Difference', 'Subtle', 'White Only']],
  ['Stripper', 'sy69', 'Stripper', [
    'Both Ways', 'Crossing Strips', 'Invert Strips', 'Rotating Strips', 'Sliding Strips',
    'Soft Strips'
  ]],
  ['Suckr', 'A126', 'Suckr', ['Lazer']],
  ['Tile', 'A113', 'TileEffect', ['Blow', 'Lamellen', 'Lines', 'Luxaflex', 'MetaImage']],
  ['Tunnel', 'sy04', 'Tunnel', ['Basic', 'Spiral', 'Streams', 'Turning', 'Wobbly']],
  ['Twitch', 'A183', 'TwitchEffect', ['Bzzzt', 'Chaos', 'Subtle']],
  ['VideoWall', 'sy88', 'VideoWall', ['BouncingSquares', 'Panning', 'RandomTiles', 'Subscreens', 'Tiles']],
  ['Vignette', 'sy77', 'Vignette', ['Round', 'Soft']],
  ['Wave Warp', 'MWWP', 'Wave Warp', [
    'Big Wave', 'Curly', 'MMM', 'Rotating Panels', 'Strokes', 'Sync Disturbance', 'Twitch'
  ]]
];

/* One preset in the whole set does not use its folder's plugin id. */
const PLUGIN_OVERRIDE = {'Video Effects/Tile/Luxaflex': {uniqueId: 'A041', className: 'Tile'}};

function buildIndex(){
  const flat = [], folders = [];
  const entry = (folder, kind, name, plugin) => {
    const rel = folder + '/' + name;
    const o = {name, kind, folder, file: PRESET_BASE + '/' + rel + '.xml',
               path: PRESET_ROOT + '/' + rel + '.xml'};
    if(plugin) {
      o.pluginName = plugin.pluginName;
      o.uniqueId = plugin.uniqueId;
      o.className = plugin.className;
    }
    const ov = PLUGIN_OVERRIDE[rel];
    if(ov){ o.uniqueId = ov.uniqueId; o.className = ov.className; }
    flat.push(o);
    return o;
  };
  FLAT.forEach(([folder, kind, names]) => {
    folders.push({name: folder, kind, count: names.length,
                  presets: names.map(n => entry(folder, kind, n))});
  });
  [['Sources', 'source', SOURCES], ['Video Effects', 'effect', EFFECTS]].forEach(([top, kind, table]) => {
    const groups = table.map(([sub, uniqueId, className, names]) => ({
      name: sub, uniqueId, className, count: names.length,
      presets: names.map(n => entry(top + '/' + sub, kind, n,
                                    {pluginName: sub, uniqueId, className}))
    }));
    folders.push({name: top, kind, count: groups.reduce((s, g) => s + g.count, 0), groups});
  });
  return {source: PRESET_ROOT, base: PRESET_BASE, count: flat.length, folders, presets: flat,
          folder: name => folders.find(f => f.name === name) || null,
          find: (folder, name) => flat.find(p => p.folder === folder && p.name === name) || null};
}
const INDEX = buildIndex();

/* Arena 7.27.1's browser differs from the raw preset folder in two deliberate
   ways. LoRez/Mario and the legacy A041 Tile/Luxaflex XML still exist on disk
   but are no longer advertised. CRT and Strokes are Wire effects whose 15
   presets are exposed by the live registry without XML files. INDEX remains
   the lossless disk index; BROWSER_INDEX is the versioned UI manifest. */
const RETIRED_727 = {
  'Video Effects/LoRez/Mario': 1,
  'Video Effects/Tile/Luxaflex': 1
};
const LIVE_WIRE_PRESETS = {
  CRT: [
    'Big Beautiful Beams', 'Big Grid Energy', 'Bit of a Grid', 'Jagged Lines',
    'Mind the Gap', 'Red-Green Lensch Flare', 'Scanlines Horizontal',
    'Scanlines Vertical', 'Trinitron'
  ],
  Strokes: [
    'Adamantium Claws', 'Arrow Cloud', 'Bubble Bath', 'Floating Oil',
    'Product Placement', 'Starry Night'
  ]
};

function wireSnapshot(pluginName, presetName){
  const catalog = window.ArenaWirePresets;
  if(!catalog) return null;
  if(typeof catalog.find === 'function') return catalog.find(pluginName, presetName) || null;
  if(typeof catalog.presetsFor === 'function'){
    const rows = catalog.presetsFor(pluginName) || [];
    return rows.find(r => r && (r.preset === presetName || r.name === presetName)) || null;
  }
  return null;
}

function buildBrowserIndex(){
  const source = INDEX.presets.filter(p => p.kind === 'source').map(p =>
    Object.assign({}, p, {transportOnly: false, runtimeOnly: false}));
  const effect = INDEX.presets.filter(p => p.kind === 'effect' &&
    !RETIRED_727[p.folder + '/' + p.name]).map(p =>
      Object.assign({}, p, {transportOnly: false, runtimeOnly: false}));
  Object.keys(LIVE_WIRE_PRESETS).forEach(pluginName => {
    LIVE_WIRE_PRESETS[pluginName].forEach(name => {
      const snapshot = wireSnapshot(pluginName, name);
      effect.push({
        name, kind: 'effect', pluginName,
        folder: 'Video Effects/' + pluginName,
        runtimeOnly: true, transportOnly: !snapshot,
        snapshot: snapshot || null
      });
    });
  });
  const presets = effect.concat(source);
  return {
    version: '7.27.1', count: presets.length,
    counts: {effect: effect.length, source: source.length},
    effect, source, effects: effect, sources: source, presets
  };
}
const BROWSER_INDEX = buildBrowserIndex();
/* Browser expansion asks this question once per installed Effect/Source. A
   filter across the complete preset manifest for every row turned opening the
   Sources tab into O(plugins x presets) main-thread work. Index the immutable
   factory manifest once; user presets remain the small mutable suffix below. */
const BROWSER_PRESETS_BY_PLUGIN = {effect:new Map(), source:new Map()};
['effect','source'].forEach(role => (BROWSER_INDEX[role]||[]).forEach(entry => {
  const key=String(entry.pluginName||'');
  if(!BROWSER_PRESETS_BY_PLUGIN[role].has(key)) BROWSER_PRESETS_BY_PLUGIN[role].set(key,[]);
  BROWSER_PRESETS_BY_PLUGIN[role].get(key).push(entry);
}));

function roleOf(kind){
  const k = String(kind || '').toLowerCase();
  if(k === 'effect' || k === 'effects' || k === 'video effect' || k === 'video effects') return 'effect';
  if(k === 'source' || k === 'sources') return 'source';
  return null;
}

/* =========================================================================
   8a. USER EFFECT / SOURCE PRESETS

   Factory XML and live Wire snapshots are immutable catalogue data. User
   presets are a second, browser-local layer and never mutate BROWSER_INDEX:
   callers receive factory entries first, followed by entries from this store.

   Identity is role + Effect track + parent plug-in + stable preset id. The
   visible name is unique (case-insensitively) only inside that same tuple,
   matching Arena's tree anatomy while allowing a video and audio Distortion,
   an Effect and Source, or two different Effects to use the same name safely.

   Only JSON data is persisted. Engine object ids, owner paths, DOM objects,
   functions, Blob/File handles and blob: URLs are runtime state rather than a
   preset and are deliberately discarded by sanitiseUserRecord(). */
const USER_PRESET_STORAGE_KEY = 'openlive.arena.user-presets.v1';
const USER_PRESETS_CHANGED_EVENT = 'openlive:presets-changed';
const USER_PRESET_LIMITS = Object.freeze({
  name: 96, parent: 160, id: 96, records: 512,
  bytes: 256 * 1024, depth: 32, nodes: 20000,
  array: 4096, keys: 4096, string: 32768
});

const USER_DROP = Object.freeze({});
const USER_RUNTIME_KEYS = new Set([
  'entry', 'id', 'uid', 'uuid', 'uniqueid', 'runtimeid', 'runtimeuid',
  'objectid', 'ownerid', 'parameterid', 'paramid', 'instanceid', 'linkid',
  'presetid', 'path', 'ownerpath', 'oscaddress', 'domid', 'elementid',
  'userpreset', 'runtimeonly', 'transportonly'
]);

function userLabel(value, label, limit){
  if(typeof value !== 'string') throw new TypeError('arena-presets: ' + label + ' must be text');
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if(!clean) throw new Error('arena-presets: ' + label + ' is required');
  if(clean.length > limit) throw new Error('arena-presets: ' + label + ' is longer than ' + limit + ' characters');
  return clean;
}

function runtimeRecordKey(key){
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unsupportedUserValue(value){
  if(typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined)
    return true;
  if(!value || typeof value !== 'object') return false;
  const tag = Object.prototype.toString.call(value);
  if(tag === '[object Blob]' || tag === '[object File]' || tag === '[object FileList]' ||
     tag === '[object ArrayBuffer]' || /Array\]$/.test(tag) && tag !== '[object Array]') return true;
  const proto = Object.getPrototypeOf(value);
  return !Array.isArray(value) && proto !== null &&
    (!proto.constructor || proto.constructor.name !== 'Object');
}

function sanitiseUserRecord(input){
  if(!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('arena-presets: user preset record must be an object');
  let nodes = 0;
  const seen = new Set();
  function clean(value, depth, container){
    if(++nodes > USER_PRESET_LIMITS.nodes) throw new Error('arena-presets: user preset record is too complex');
    if(depth > USER_PRESET_LIMITS.depth) throw new Error('arena-presets: user preset record is too deeply nested');
    if(unsupportedUserValue(value)) return USER_DROP;
    if(value === null || typeof value === 'boolean') return value;
    if(typeof value === 'number') return Number.isFinite(value) ? value : USER_DROP;
    if(typeof value === 'string'){
      if(/^blob:/i.test(value)) return USER_DROP;
      if(value.length > USER_PRESET_LIMITS.string)
        throw new Error('arena-presets: user preset text value is too long');
      return value;
    }
    if(seen.has(value)) return USER_DROP;
    seen.add(value);
    let out;
    if(Array.isArray(value)){
      if(value.length > USER_PRESET_LIMITS.array) throw new Error('arena-presets: user preset array is too large');
      out = [];
      value.forEach(item => {
        const v = clean(item, depth + 1, container);
        if(v !== USER_DROP) out.push(v);
      });
    }else{
      const keys = Object.keys(value);
      if(keys.length > USER_PRESET_LIMITS.keys) throw new Error('arena-presets: user preset object has too many fields');
      out = {};
      keys.forEach(key => {
        const normalisedKey=runtimeRecordKey(key);
        /* `path` is normally an engine-owner address and must not leave the
           runtime. A parameter snapshot is the one exception: grouped Sources
           such as Shaper repeat display names, so params[].path is their
           structural identity across save/reload. Keep only that direct field;
           root owner paths and animation/resource paths remain transient. */
        const groupedParameterPath=normalisedKey==='path' && container==='params';
        if(key === '__proto__' || key === 'prototype' || key === 'constructor' ||
           (USER_RUNTIME_KEYS.has(normalisedKey) && !groupedParameterPath)) return;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if(!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
        const v = clean(descriptor.value, depth + 1, key);
        if(v !== USER_DROP) out[key.slice(0, 256)] = v;
      });
    }
    seen.delete(value);
    return out;
  }
  const record = clean(input, 0, null);
  const serial = JSON.stringify(record);
  if(serial.length > USER_PRESET_LIMITS.bytes)
    throw new Error('arena-presets: user preset record exceeds ' + USER_PRESET_LIMITS.bytes + ' bytes');
  return record;
}

function userStorage(){
  try{
    const storage = typeof window !== 'undefined' && window.localStorage;
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage : null;
  }catch(_error){ return null; }
}

/* Resolve storage once. If it is wholly absent (including a blocked
   window.localStorage getter), user presets intentionally remain valid for
   this page session. If a storage object was available and later rejects a
   write (quota, revoked permission, private-mode failure), that is a real
   persistence failure and the public mutation is rolled back below. */
const USER_PRESET_STORAGE = userStorage();

const USER_PRESETS = new Map();
function userTrack(kind, track, strict){
  const value = String(track || '').toLowerCase();
  if(kind === 'source'){
    if(!value || value === 'video' || value === 'source') return 'video';
  }else if(kind === 'effect'){
    if(!value || value === 'video' || value === 'video effect' || value === 'video effects') return 'video';
    if(value === 'audio' || value === 'audio effect' || value === 'audio effects') return 'audio';
  }
  if(strict) throw new Error('arena-presets: invalid preset track');
  return null;
}
const userCompositeKey = (kind, track, parent, id) => JSON.stringify([kind, track, parent, id]);
const userNameKey = value => String(value || '').toLocaleLowerCase();

function generatedUserId(kind, track, parent, name){
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'preset';
  let hash = 2166136261;
  const text = kind + '\u0000' + track + '\u0000' + parent + '\u0000' + name;
  for(let i = 0; i < text.length; i++){
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const base = 'user-' + slug + '-' + (hash >>> 0).toString(36);
  let id = base, suffix = 2;
  while(USER_PRESETS.has(userCompositeKey(kind, track, parent, id))) id = base + '-' + suffix++;
  return id.slice(0, USER_PRESET_LIMITS.id);
}

function userEntry(item){
  const folder = (item.kind === 'effect' ? (item.track === 'audio' ? 'Audio Effects/' : 'Video Effects/') : 'Sources/') + item.pluginName;
  return deepFreezePreset({
    kind: item.kind, track:item.track, pluginName: item.pluginName, name: item.name,
    id: item.id, presetId: item.id, folder,
    userPreset: true, runtimeOnly: false, transportOnly: false,
    persistent: item.persistent === true,
    file: null
  });
}

function findUserItem(kind, track, parent, nameOrId){
  const needle = String(nameOrId || '');
  const direct = USER_PRESETS.get(userCompositeKey(kind, track, parent, needle));
  if(direct) return direct;
  const folded = userNameKey(needle);
  for(const item of USER_PRESETS.values())
    if(item.kind === kind && item.track === track && item.pluginName === parent && userNameKey(item.name) === folded) return item;
  return null;
}

function exactUserItem(kind, track, parent, id, name){
  if(id === undefined || id === null || name === undefined || name === null) return null;
  const item = USER_PRESETS.get(userCompositeKey(kind, track, parent, String(id)));
  return item && item.name === String(name) ? item : null;
}

function persistUserPresets(){
  if(!USER_PRESET_STORAGE) return false;
  try{
    USER_PRESET_STORAGE.setItem(USER_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      presets: Array.from(USER_PRESETS.values(), item => ({
        kind:item.kind, track:item.track, pluginName:item.pluginName, name:item.name, id:item.id,
        record:item.record
      }))
    }));
    return true;
  }catch(error){
    const failure = new Error('arena-presets: could not persist user presets');
    try{ failure.cause = error; }catch(_ignored){ /* older browsers */ }
    throw failure;
  }
}

function restoreUserPresets(){
  if(!USER_PRESET_STORAGE) return;
  let value;
  try{ value = JSON.parse(USER_PRESET_STORAGE.getItem(USER_PRESET_STORAGE_KEY) || 'null'); }
  catch(_error){ return; }
  const rows = value && value.version === 1 && Array.isArray(value.presets) ? value.presets : [];
  rows.slice(0, USER_PRESET_LIMITS.records).forEach(row => {
    try{
      const kind = roleOf(row && row.kind);
      if(!kind) return;
      const track = userTrack(kind, row.track, true);
      const pluginName = userLabel(row.pluginName, 'preset parent', USER_PRESET_LIMITS.parent);
      const name = userLabel(row.name, 'preset name', USER_PRESET_LIMITS.name);
      const id = userLabel(row.id, 'preset id', USER_PRESET_LIMITS.id);
      const record = sanitiseUserRecord(row.record);
      if(findUserItem(kind, track, pluginName, id) || findUserItem(kind, track, pluginName, name)) return;
      USER_PRESETS.set(userCompositeKey(kind, track, pluginName, id),
        {kind, track, pluginName, name, id, record, persistent:true});
    }catch(_error){ /* One damaged entry must not hide the rest of the library. */ }
  });
}

function dispatchUserPresetChange(operation, item, previousName){
  try{
    if(typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const detail = deepFreezePreset({
      operation, kind:item.kind, track:item.track, pluginName:item.pluginName,
      name:item.name, previousName:previousName || null, id:item.id,
      persistent:item.persistent === true,
      entry:userEntry(item)
    });
    let event = null;
    if(typeof window.CustomEvent === 'function') event = new window.CustomEvent(USER_PRESETS_CHANGED_EVENT, {detail});
    else if(typeof window.Event === 'function'){
      event = new window.Event(USER_PRESETS_CHANGED_EVENT);
      try{ Object.defineProperty(event, 'detail', {value:detail}); }catch(_error){ /* optional */ }
    }
    if(event) window.dispatchEvent(event);
  }catch(_error){ /* Preset persistence must not depend on an event target. */ }
}

function userStoreSnapshot(){ return Array.from(USER_PRESETS.entries()); }
function restoreUserStore(snapshot){
  USER_PRESETS.clear();
  snapshot.forEach(([key, item]) => USER_PRESETS.set(key, item));
}
function markUserStorePersistence(persistent){
  USER_PRESETS.forEach(item => { item.persistent = persistent === true; });
}

function saveUserPreset(kind, pluginName, name, record, id, track){
  if(kind && typeof kind === 'object'){
    const input = kind;
    kind = input.kind;
    pluginName = input.pluginName || input.parent || input.plugin;
    name = input.name;
    id = input.presetId || input.id;
    track = input.track;
    record = input.record !== undefined ? input.record :
      (input.snapshot !== undefined ? input.snapshot : input);
  }
  kind = roleOf(kind);
  if(!kind) throw new Error('arena-presets: user preset role must be effect or source');
  if(track === undefined && (id === 'video' || id === 'audio')){ track = id; id = null; }
  track = userTrack(kind, track, true);
  pluginName = userLabel(pluginName, 'preset parent', USER_PRESET_LIMITS.parent);
  name = userLabel(name, 'preset name', USER_PRESET_LIMITS.name);
  const sameName = findUserItem(kind, track, pluginName, name);
  id = id == null || id === '' ? (sameName ? sameName.id : generatedUserId(kind, track, pluginName, name)) :
    userLabel(String(id), 'preset id', USER_PRESET_LIMITS.id);
  const sameId = findUserItem(kind, track, pluginName, id);
  const replacing = sameId || sameName;
  if(sameId && sameName && sameId !== sameName)
    throw new Error('arena-presets: preset id and name belong to different presets');
  if(!replacing && USER_PRESETS.size >= USER_PRESET_LIMITS.records)
    throw new Error('arena-presets: user preset limit of ' + USER_PRESET_LIMITS.records + ' reached');
  const clean = sanitiseUserRecord(record);
  const before = userStoreSnapshot();
  if(replacing) USER_PRESETS.delete(userCompositeKey(kind, track, pluginName, replacing.id));
  const item = {kind, track, pluginName, name, id, record:clean, persistent:false};
  USER_PRESETS.set(userCompositeKey(kind, track, pluginName, id), item);
  try{
    const persistent = persistUserPresets();
    markUserStorePersistence(persistent);
  }catch(error){
    restoreUserStore(before);
    throw error;
  }
  dispatchUserPresetChange(replacing ? 'update' : 'save', item);
  return userEntry(item);
}

function removeUserPreset(kind, pluginName, nameOrId, track){
  kind = roleOf(kind);
  if(!kind) return false;
  track = userTrack(kind, track, false);
  if(!track) return false;
  try{ pluginName = userLabel(pluginName, 'preset parent', USER_PRESET_LIMITS.parent); }
  catch(_error){ return false; }
  const item = findUserItem(kind, track, pluginName, nameOrId);
  if(!item) return false;
  const before = userStoreSnapshot();
  USER_PRESETS.delete(userCompositeKey(kind, track, pluginName, item.id));
  try{
    const persistent = persistUserPresets();
    markUserStorePersistence(persistent);
    item.persistent = persistent === true;
  }catch(error){
    restoreUserStore(before);
    throw error;
  }
  dispatchUserPresetChange('remove', item);
  return true;
}

function renameUserPreset(kind, pluginName, nameOrId, newName, track){
  kind = roleOf(kind);
  if(!kind) throw new Error('arena-presets: user preset role must be effect or source');
  track = userTrack(kind, track, true);
  pluginName = userLabel(pluginName, 'preset parent', USER_PRESET_LIMITS.parent);
  newName = userLabel(newName, 'preset name', USER_PRESET_LIMITS.name);
  const item = findUserItem(kind, track, pluginName, nameOrId);
  if(!item) throw new Error('arena-presets: user preset not found');
  const collision = findUserItem(kind, track, pluginName, newName);
  if(collision && collision !== item) throw new Error('arena-presets: a preset named "' + newName + '" already exists');
  const previousName = item.name;
  const before = userStoreSnapshot();
  const renamed = Object.assign({}, item, {name:newName});
  USER_PRESETS.set(userCompositeKey(kind, track, pluginName, item.id), renamed);
  try{
    const persistent = persistUserPresets();
    markUserStorePersistence(persistent);
  }catch(error){
    restoreUserStore(before);
    throw error;
  }
  dispatchUserPresetChange('rename', renamed, previousName);
  return userEntry(renamed);
}

function userPresetsFor(kind, pluginName, track){
  kind = roleOf(kind);
  if(!kind) return [];
  track = userTrack(kind, track, false);
  if(!track) return [];
  return Array.from(USER_PRESETS.values())
    .filter(item => item.kind === kind && item.track === track &&
      (pluginName === undefined || pluginName === null || item.pluginName === pluginName))
    .map(userEntry);
}

restoreUserPresets();

function hydrateRuntimeEntry(entry){
  if(!entry || !entry.runtimeOnly) return entry ? Object.assign({}, entry) : entry;
  const snapshot = wireSnapshot(entry.pluginName, entry.name);
  if(!snapshot) return Object.assign({}, entry, {snapshot: null, transportOnly: true});
  return Object.assign({}, entry, {snapshot, transportOnly: false});
}

function presetsFor(kind, pluginName, track){
  const role = roleOf(kind);
  if(!role) return [];
  const wantedTrack = userTrack(role, track, false);
  if(!wantedTrack) return [];
  /* Arena 7.27.1 ships no Audio Effect preset children. Explicit audio
     queries therefore receive only audio user presets, never same-name video
     factory children (Distortion is the important collision). */
  const indexed = pluginName === undefined || pluginName === null
    ? BROWSER_INDEX[role]
    : (BROWSER_PRESETS_BY_PLUGIN[role].get(String(pluginName))||[]);
  const factory = role === 'effect' && wantedTrack === 'audio' ? [] : indexed
    .map(p => Object.assign({}, hydrateRuntimeEntry(p), {track:'video'}));
  return factory.concat(userPresetsFor(role, pluginName, wantedTrack));
}
function hasPresetsFor(kind, pluginName, track){
  const role=roleOf(kind); if(!role) return false;
  const wantedTrack=userTrack(role,track,false); if(!wantedTrack) return false;
  const hasFactory=!(role==='effect'&&wantedTrack==='audio') &&
    (BROWSER_PRESETS_BY_PLUGIN[role].get(String(pluginName))||[]).length>0;
  return hasFactory || userPresetsFor(role,pluginName,wantedTrack).length>0;
}

const LOAD_CACHE = new Map();

function runtimePresetRecord(entry, snapshot){
  const values = snapshot && snapshot.params ? snapshot.params : null;
  const params = values ? Object.keys(values).map(name => ({
    name, label: name,
    type: typeof values[name] === 'boolean' ? 'bool' :
          typeof values[name] === 'number' ? 'range' : 'value',
    value: values[name]
  })) : [];
  return deepFreezePreset({
    kind: entry.kind, track:entry.track || 'video', name: entry.name, pluginName: entry.pluginName,
    runtimeOnly: true, transportOnly: !snapshot,
    wrapper: null, mixer: null, params, values,
    animations: [], unsupported: snapshot && snapshot.unsupported || null,
    snapshot: snapshot || null, entry
  });
}

function loadPreset(input){
  const role = input && roleOf(input.kind);
  if(!role) return Promise.reject(new Error('arena-presets: invalid preset entry'));
  const explicitUser = input.userPreset === true;
  /* A presetId is also used by browser/live payloads and is not proof that an
     entry belongs to the local user store. An unmarked entry is accepted only
     when its role, track, parent, stable id and visible name all match one
     exact internal item, and it has no factory file/runtime identity. */
  const inputParent = input.pluginName || input.parent || input.plugin;
  const possibleExactUser = (input.userPreset === undefined || input.userPreset === null) &&
    input.presetId != null && typeof inputParent === 'string' && typeof input.name === 'string' &&
    input.file == null && input.runtimeOnly !== true;
  if(explicitUser || possibleExactUser){
    let parent, track;
    try{
      parent = userLabel(inputParent, 'preset parent', USER_PRESET_LIMITS.parent);
      track = userTrack(role, input.track, true);
    }
    catch(error){ return Promise.reject(error); }
    const item = explicitUser
      ? findUserItem(role, track, parent, input.presetId || input.id || input.name)
      : exactUserItem(role, track, parent, input.presetId, input.name);
    if(item){
      const decoded = clonePresetData(item.record);
      const entry = userEntry(item);
      return Promise.resolve(deepFreezePreset(Object.assign({}, decoded, {
        kind:item.kind, track:item.track, name:item.name, pluginName:item.pluginName,
        userPreset:true, presetId:item.id, persistent:item.persistent === true,
        runtimeOnly:false, transportOnly:false, entry
      })));
    }
    if(explicitUser) return Promise.reject(new Error('arena-presets: user preset not found'));
  }
  const normalized = input.kind === role ? input : Object.assign({}, input, {kind: role});
  const entry = hydrateRuntimeEntry(normalized);
  if(entry.runtimeOnly) return Promise.resolve(runtimePresetRecord(entry, entry.snapshot));
  if(!entry.file) return Promise.reject(new Error('arena-presets: preset has no XML file'));
  const key = entry.kind + '|' + entry.file;
  if(LOAD_CACHE.has(key)) return LOAD_CACHE.get(key);
  if(typeof fetch !== 'function') return Promise.reject(new Error('arena-presets: fetch is unavailable'));
  const pending = Promise.resolve(fetch(entry.file)).then(response => {
    if(!response || (typeof response.ok === 'boolean' && !response.ok)){
      throw new Error('arena-presets: could not load ' + entry.file +
                      (response && response.status ? ' (' + response.status + ')' : ''));
    }
    if(typeof response.text !== 'function') throw new Error('arena-presets: invalid fetch response for ' + entry.file);
    return response.text();
  }).then(xml => {
    const decoded = parse(xml, entry.name);
    if(decoded.kind !== entry.kind){
      throw new Error('arena-presets: role mismatch for ' + entry.file +
                      ' (expected ' + entry.kind + ', got ' + decoded.kind + ')');
    }
    if(entry.uniqueId && decoded.uniqueId && entry.uniqueId !== decoded.uniqueId){
      throw new Error('arena-presets: plugin mismatch for ' + entry.file);
    }
    return deepFreezePreset(Object.assign({}, decoded, {
      pluginName: entry.pluginName || decoded.pluginPassName,
      track:entry.track || 'video',
      runtimeOnly: false, transportOnly: false, entry
    }));
  }).catch(error => {
    LOAD_CACHE.delete(key);
    throw error;
  });
  LOAD_CACHE.set(key, pending);
  return pending;
}

function clearLoadCache(){ LOAD_CACHE.clear(); }

/* =========================================================================
   9. UNKNOWNS
   Things the shipped files do not settle. Listed so nothing downstream mistakes
   a default for a decode.

   - AnimationStarter@flags beyond bit 0 (Clip Trigger). Four distinct values.
   - Which easing family owns curve blocks 1..6. The arithmetic is certain,
     the names are not — see section 2.
   - DurationType = 1. Never written; only 0 (seconds) and 2 (beats) occur.
   - ValueBehaviour 1..3, the FFT <, - and + buttons. Only 0 occurs.
   - PlayDirection 0/1 and PlayMode 4, and every PlayModeAway except 0. The
     names come from video.htm's button order; no preset exercises them.
   - Syncmode on the effect-embedded PhaseSourceTimeline. Only 0 occurs, so
     which mode it selects is undetermined and the record leaves it raw.
   - linkId for Composition, Layer and Clip FFT. All four FFT presets are
     External.
   - ParamColor@channelmode 1 vs 2 (RGB vs HSB is the obvious reading, and
     nothing here proves it), Choice@enabled/@active other than 1,
     Conversion@AutoSize other than "Fit", OutputPath@Type other than 2.
   ========================================================================= */

window.ArenaPresets = {
  /* the four families the engine can actually consume */
  parseAnimation, parsePalette, parseEnvelope, parseConversion,
  /* raw disk inventory and the installed 7.27.1 browser manifest */
  INDEX, BROWSER_INDEX, presetsFor, hasPresetsFor, loadPreset, clearLoadCache,
  /* browser-local Effect/Source preset layer */
  saveUserPreset, removeUserPreset, renameUserPreset, userPresetsFor,
  USER_PRESET_STORAGE_KEY, USER_PRESETS_CHANGED_EVENT, USER_PRESET_LIMITS,
  LIVE_WIRE_PRESETS, RETIRED_727,
  EXTRA_CURVES, EXTRA_CURVES_UNUSED,
  /* dispatch and identity */
  parse, classify, embeddedAnimations, decodeStaticParam,
  presetColorToEngine, decodePresetColor,
  /* curve enum */
  curveName, CURVE_CODES, CURVE_FAMILIES, installCurves,
  /* engine glue */
  toAnimSpec, thresholdOf, PLAY_MODES, DIRECTIONS, DEFAULT_PALETTE
};
})();
