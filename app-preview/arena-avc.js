/* ===========================================================================
   arena-avc.js — read a Resolume composition (.avc) into a plain document.
   ---------------------------------------------------------------------------
   An .avc is UTF-8 XML with no namespaces. This file turns one into the shape
   arena-engine.js already thinks in, and does nothing else: no fetch, no DOM
   mutation, no engine import, no globals beyond window.ArenaAVC. Hand the
   result to a loader and it can walk it straight onto the document tree.

   Three things about the format are worth knowing before reading any of this,
   because they are the reason the file is shaped the way it is:

     1. EVERY KNOB IS THE SAME NODE.  Clip playhead, layer opacity, effect
     slider and dashboard dial are all <Param>/<ParamRange>/<ParamChoice>/
        <ParamColor>/<ParamText>/<ParamFile> with name + default + value, and an optional
        <PhaseSource*> child that says where the value comes from. readParam()
        below is therefore the whole parser in miniature; the rest is structure.

     2. THE PLAYHEAD IS A PARAMETER ANIMATION.  A clip's transport is
        Transport > Params > ParamRange[Position] whose phase source is
        <PhaseSourceTransportTimeline>. Same grammar as an animated effect
        slider — which is exactly what parameter-animation.htm means when it
        offers "Clip Position" as an animation source for anything else.

     3. THE FILE IS ZERO-BASED, THE ENGINE IS ONE-BASED.  layerIndex,
        columnIndex, deckIndex and ColumnAttributes/@index all start at 0.
        arena-engine.js builds buildLayer(i+1) / buildColumn(i+1) and addresses
        clips as /composition/decks/{d}/layers/{l}/clips/{c} with all three >= 1
        — and so does Resolume's own runtime API (default\Shortcuts\ uses
        /composition/layers/3/solo). The conversion happens HERE, once, so no
        caller has to remember it. currentDeckIndex is the single exception:
        doc.deck in the engine is already zero-based, so it passes through.

   Absent is not unsupported. Serialisation is only partly sparse — a core set
   (Width, Height, Position, RScale..AScale, TransportType, Name) is always
   written, everything else only when it deviates from its default. A field
   this parser reports as null means "the file did not say"; the loader must
   keep the engine's own default rather than write null over it.

   Written against Example.avc, which declares itself
   <versionInfo name="Resolume Avenue" majorVersion="7" minorVersion="4">.
   That is Avenue, not Arena: it contains no <Group> element anywhere, so this
   parser has no group reader and does not pretend to. See SCHEMA_NOTES.
   =========================================================================== */
(() => {
'use strict';

/* =========================================================================
   0. SMALL HELPERS
   ========================================================================= */
const num = (v, d) => {
  if(v === null || v === undefined || v === '') return d === undefined ? null : d;
  const n = Number(v);
  return Number.isFinite(n) ? n : (d === undefined ? null : d);
};
const bool = (v, d) => {
  if(v === null || v === undefined || v === '') return d === undefined ? null : d;
  return v === '1' || v === 'true' || v === true;
};
const str = (v, d) => (v === null || v === undefined) ? (d === undefined ? null : d) : String(v);

function warn(ctx, msg){
  if(!ctx || !ctx.warnings) return;
  if(ctx.seen.has(msg)) return;            // one line per distinct problem, not per node
  ctx.seen.add(msg);
  ctx.warnings.push(msg);
}
/* Tolerance is a requirement, not a nicety: a composition saved by a newer
   Arena will contain elements this file has never seen. Every structural
   reader runs inside safe(), so one unreadable subtree costs that subtree and
   nothing else. */
function safe(ctx, label, fn, fallback){
  try { return fn(); }
  catch(e){ warn(ctx, label + ': ' + ((e && e.message) || e)); return fallback === undefined ? null : fallback; }
}

/* --- paths ---------------------------------------------------------------
   compositionIsRelative="1" means media paths are relative to the folder the
   .avc itself sits in, so "../media/AV/Beat 001.mov" saved in default\ means
   <install>\media\AV\Beat 001.mov. Verified against the filesystem.
   Paths use forward slashes, may contain spaces, and are NOT url-escaped —
   arena-media.js keys its index on basename(raw).toLowerCase(), so the raw
   string has to survive untouched. Both are returned. */
function resolvePath(raw, base){
  if(raw === null || raw === undefined || raw === '') return null;
  const p = String(raw).replace(/\\/g, '/');
  if(!base) return p;
  if(/^([a-zA-Z]:\/|\/\/|https?:|file:)/.test(p)) return p;      // already absolute
  const segs = String(base).replace(/\\/g, '/').replace(/\/+$/, '').split('/').concat(p.split('/'));
  const out = [];
  for(let i = 0; i < segs.length; i++){
    const s = segs[i];
    if(s === '.') continue;
    if(s === ''){ if(!out.length) out.push(''); continue; }       // keep a leading /
    if(s === '..'){
      const last = out[out.length - 1];
      if(out.length && last !== '..' && last !== '') out.pop(); else out.push('..');
      continue;
    }
    out.push(s);
  }
  return out.join('/') || '/';
}
function basename(p){
  if(!p) return null;
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

/* =========================================================================
   1. XML ACCESS
   Deliberately the narrowest surface that will do the job — tagName,
   getAttribute and element children. Nothing else, so the module stays
   testable under any minimal DOM.
   ========================================================================= */
const tagOf = el => (el && (el.tagName || el.nodeName)) || '';
const attr  = (el, n) => (el && el.getAttribute) ? el.getAttribute(n) : null;

function kids(el){
  if(!el) return [];
  const out = [];
  const cs = el.children;
  if(cs && typeof cs.length === 'number'){ for(let i = 0; i < cs.length; i++) out.push(cs[i]); return out; }
  const ns = el.childNodes || [];
  for(let i = 0; i < ns.length; i++) if(ns[i].nodeType === 1) out.push(ns[i]);
  return out;
}
const kidsNamed = (el, tag)      => kids(el).filter(c => tagOf(c) === tag);
const child     = (el, tag)      => kids(el).find(c => tagOf(c) === tag) || null;
const childNamed = (el, tag, nm) => kids(el).find(c => tagOf(c) === tag && attr(c, 'name') === nm) || null;
/* depth-first over everything; used only for the self-check sweep at the end */
function walk(el, fn){
  if(!el) return;
  fn(el);
  const cs = kids(el);
  for(let i = 0; i < cs.length; i++) walk(cs[i], fn);
}

/* =========================================================================
   2. VOCABULARY
   The .avc stores choices as bare integers with storeChoices="0", i.e. the
   option list lives in the engine, not the file. Every list below is sourced,
   never guessed — the two I could not source are left unmapped on purpose.
   ========================================================================= */

/* Provably zero-based: the 18 clips in Example.avc with TransportType value="1"
   are exactly the 18 that also carry <Param name="TempoSynced" value="1"> and a
   per-clip <ParamRange name="BPM">. A running Arena reports
   /layers/0/clips/0/transporttype options ["Timeline","BPM Sync"]
   (extracted/live-catalog.json). The four extras are Arena-only and never occur
   in an Avenue file; they are listed so an Arena-saved .avc still resolves. */
const TRANSPORT_TYPES = ['Timeline', 'BPM Sync', 'SMPTE 1', 'SMPTE 2', 'Denon DJ', 'Pioneer DJ'];

/* NOT an index into arena-data.js's PLAY_MODES — that list is in a different
   order and index 2 there is "Play Once & Hold", which would silently turn
   Random into its opposite. This is the order a running Arena reports for
   /transport/controls/playmode (extracted/live-catalog.json), and the shipped
   presets agree: BPM - Random, Glitchy, Jittery, Jumpy and Double Trouble all
   write value="2", Wavey (a bounce) writes 1, the metronome presets write 0.
   Every label here also exists verbatim in window.PLAY_MODES, so the loader can
   assign the string straight onto the engine's choice parameter. */
const PLAY_MODES = ['Loop', 'Bounce', 'Random', 'Play Once & Clear', 'Play Once & Hold'];

/* Live API reports ["<","||",">"] with index 2 as the default; the engine
   spells the same three DIRECTIONS = ['Backwards','Paused','Forwards'] in the
   same order. Note Example.avc writes default="1" for PlayDirection while the
   7.23 presets write default="2" for the same control — so the DEFAULT is not
   a reliable anchor, only the value is. */
const PLAY_DIRECTIONS = ['Backwards', 'Paused', 'Forwards'];

/* Live API: ["Restart","Continue","Relative"]. The engine uses the manual's
   prose names for the same three in the same order (video.htm > Playmode Away),
   so this maps by index onto the engine's inline option list. */
const PLAY_MODE_AWAY = ['Play from start', 'Pick-up', 'Relative pick-up'];

/* clips.htm > Beat Snap. Order confirmed twice: window.BEAT_SNAP in
   arena-data.js and /clipbeatsnap in extracted/live-catalog.json are identical.
   Example.avc stores value="5" at composition level => "1/2 Bar". */
const BEAT_SNAP = ['None', '8 Bars', '4 Bars', '2 Bars', '1 Bar', '1/2 Bar', '1/4 Bar'];
/* Layer/VideoTrack/Params/Auto Size is stored as a zero-based ParamChoice with
   storeChoices="0". This is the order exposed by Arena's live Layer VideoTrack
   and documented in layers.htm. */
const AUTO_SIZE = ['Off', 'Fill', 'Fit', 'Stretch'];

/* parameter-animation.htm > Timeline / BPM Sync. There is no PhaseSourceBpm
   element — BPM Sync is a PhaseSourceTimeline whose duration is counted in
   beats. DurationType 0 = seconds, 2 = beats: every shipped preset with
   defaultDuration="...s" writes 0 and every one with "...b" writes 2, 13 of 13.
   Value 1 is never observed anywhere, so it is left unmapped. */
const DURATION_TYPES = {0: 'seconds', 2: 'beats'};

/* envelopes.htm. @curve is an integer interpolation code on the segment ENDING
   at that point. Only two are certain from the shipped envelope presets:
   1 = Linear (Saw, Noise, Up N Down) and 33 = Hold (Digital is a pure step
   envelope and every one of its five points is 33). Codes 3, 4, 10, 12 and 14
   occur in 4 To The Floor, EasyEase, LFO, ADSR/ASR and Jaws respectively and
   are named in none of the shipped files, so they are reported as their integer
   and fall back to Linear rather than being invented into an easing name. */
const CURVES = {1: 'Linear', 33: 'Hold'};

/* parameter-animation.htm > Audio Analysis lists External / Composition /
   Clip / Layer / Group FFT. Only the external linkId occurs in any shipped
   file, so it is the only one mapped; anything else keeps its raw linkId and
   the generic mode, which still satisfies the engine's /FFT/ test. */
const FFT_SOURCES = {'/audioengine/externalfft': 'External FFT'};

/* =========================================================================
   3. THE PARAMETER NODE
   Six element names, one grammar:
     Param* ::= ( DurationSource? , PhaseSource* , ValueRange* ,
                  BehaviourDouble? , Params? , Choice* )
   Exactly one PhaseSource per parameter. PhaseSourceStatic means "not
   animated" and its @phase is the value normalised to the parameter's full
   range — i.e. precisely EN.normalised(p). The range itself is NOT stored for
   most parameters; with one equation and two unknowns it cannot be recovered,
   so min/max stay null unless a <ValueRange> says otherwise and the loader
   uses its own table.
   ========================================================================= */
const PARAM_TAGS = {
  Param: 1, ParamRange: 1, ParamChoice: 1, ParamColor: 1, ParamText: 1, ParamFile: 1
};

function typeOf(tag, T){
  if(tag === 'ParamRange')  return 'range';
  if(tag === 'ParamChoice') return 'choice';
  if(tag === 'ParamColor')  return 'color';
  if(tag === 'ParamText')   return 'string';
  if(tag === 'ParamFile')   return 'file';
  return T === 'BOOL' ? 'bool' : 'string';           // <Param> is only ever BOOL or STRING
}
function coerce(type, raw){
  if(raw === null || raw === undefined) return null;
  if(type === 'bool')   return bool(raw);
  if(type === 'range')  return num(raw);
  if(type === 'choice') return num(raw);             // an index, or a UINT64 registry id
  if(type === 'color')  return num(raw);
  return String(raw);
}

/* ParamColor packs as 0xAABBGGRR — alpha high, then blue, green, red. Proven
   on the three samples that also write their <Params name="Channels">:
   0xFFA030FF has Green 0.188 (=0x30) and Blue 0.627 (=0xA0) with Red at its
   default 1.0 (=0xFF). The hex string inside a <Choice name="0xff30a0ff 2">
   uses a different byte order and is a label — do not parse it. */
function decodeColor(v){
  if(v === null || v === undefined) return null;
  const u = (Number(v) >>> 0);
  return {
    packed: u,
    r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff,
    css: 'rgba(' + (u & 0xff) + ',' + ((u >>> 8) & 0xff) + ',' + ((u >>> 16) & 0xff) + ',' +
         (((u >>> 24) & 0xff) / 255).toFixed(3) + ')'
  };
}

/* "16b" = 16 beats, "8.0000000000000017764s" = 8 seconds. userDuration is a
   bare number in whatever unit defaultDuration declared — the user's manual
   override of the media's own length. */
function parseDuration(s){
  if(s === null || s === undefined || s === '') return null;
  const m = /^\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*([sb])?\s*$/.exec(String(s));
  if(!m) return null;
  return {value: num(m[1]), unit: m[2] === 'b' ? 'beats' : m[2] === 's' ? 'seconds' : null, raw: String(s)};
}

function readDurationSource(el){
  if(!el) return null;
  const d = parseDuration(attr(el, 'defaultDuration'));
  return {
    unit: d ? d.unit : null,
    defaultDuration: d ? d.value : null,
    defaultDurationRaw: str(attr(el, 'defaultDuration')),
    userDuration: num(attr(el, 'userDuration')),        // bare number, same unit
    scale: num(attr(el, 'scale'))                       // 7.23+ only
  };
}

/* Resolume's own beat detection for the media. detected="0" leaves the
   detected fields at -1 (no analysis ran); numManualBeats is what the user
   typed. bpm.htm > Clip BPM. */
function readBeats(el){
  if(!el) return null;
  return {
    mode: num(attr(el, 'mode')),
    numDetectedBeats: num(attr(el, 'numDetectedBeats')),
    numManualBeats:   num(attr(el, 'numManualBeats')),
    detectedTempo:    num(attr(el, 'detectedTempo')),
    manualTempo:      num(attr(el, 'manualTempo')),
    detected:         bool(attr(el, 'detected'), false)
  };
}

/* envelopes.htm — "Resolume will apply the envelope to the input of your
   parameter. This means any input!" That is why the envelope hangs off
   BehaviourDouble BESIDE the phase source rather than inside it, and why
   arena-engine.js applies a.env to a.phase regardless of a.mode. */
function readEnvelope(behaviour, ctx){
  if(!behaviour) return null;
  const mod = child(behaviour, 'Modifier');
  const env = mod ? child(mod, 'ModifierEnvelope') : child(behaviour, 'ModifierEnvelope');
  if(!env) return null;
  const holder = child(env, 'points');
  const pts = kidsNamed(holder, 'point').map(p => {
    const code = num(attr(p, 'curve'));
    if(code !== null && !CURVES[code]) warn(ctx, 'envelope curve code ' + code + ' is not named in any shipped file; treated as Linear');
    return {
      phase: num(attr(p, 'x'), 0),
      value: num(attr(p, 'y'), 0),
      curve: CURVES[code] || 'Linear',
      curveCode: code
    };
  });
  if(!pts.length) return null;
  return {name: str(attr(env, 'altName')) || 'Envelope', uid: str(attr(env, 'uniqueId')), points: pts};
}

/* --- phase sources = where a value comes from ---------------------------- */
function readPhaseSource(el, ctx, owner){
  const tag = tagOf(el);
  const phase = num(attr(el, 'phase'), 0);

  /* not animated. arena-engine.js's p.anim === null. */
  if(tag === 'PhaseSourceStatic') return {phase, anim: null};

  const sub  = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  const beat = readBeats(child(el, 'Beats_d'));
  const pick = n => (sub.map[n] ? sub.map[n].value : null);
  /* A phase source's sub-parameters are ordinary parameters — Speed and BPM
     carry their own ranges and could themselves be animated — so the decoded
     nodes ride along on every anim as .params rather than being reduced to
     bare numbers and thrown away. */
  const carry = a => { a.params = sub.map; a.paramList = sub.list; return a; };

  if(tag === 'PhaseSourceTimeline'){
    /* There is no PhaseSourceBpm element. BPM Sync is this element with its
       duration counted in beats — DurationType = 2, or a "...b" suffix on
       DurationSource, plus hardSynced for parameter-animation.htm's BPM Phase
       Lock ("free the parameter from the Master BPM"). */
    const dt   = sub.map.DurationType ? sub.map.DurationType.value : null;
    const ds   = owner ? owner.duration : null;
    const unit = DURATION_TYPES[dt] || (ds ? ds.unit : null);
    if(dt !== null && !DURATION_TYPES[dt]) warn(ctx, 'DurationType ' + dt + ' is not observed in any shipped file; duration unit left unknown');
    let beats   = num(attr(el, 'defaultBeatsDuration'));
    let seconds = num(attr(el, 'defaultMillisecondsDuration')) === null ? null
                : num(attr(el, 'defaultMillisecondsDuration')) / 1000;
    /* DurationSource is the user's override of whichever unit is in play, and
       it wins: the RadialCloner's Master Rotation carries
       defaultDuration="0.005s" userDuration="2.56" against a phase source
       still reporting 5 ms, and 2.56 s is what the animation actually runs. */
    const dsVal = ds ? (ds.userDuration != null ? ds.userDuration : ds.defaultDuration) : null;
    if(dsVal != null){ if(unit === 'beats') beats = dsVal; else seconds = dsVal; }
    const pm  = pick('PlayMode'), pd = pick('PlayDirection'), pa = pick('PlayModeAway');
    return {phase, anim: carry({
      source: 'Timeline',
      mode: unit === 'beats' ? 'BPM Sync' : 'Timeline',
      phase,
      speed: pick('Speed'),
      multiplier: pick('Multiplier'),                 // 7.23 only
      interval: pick('Interval'),                     // 7.23 only, gates Random
      /* the Random play mode's maximum jump. Inferred, not documented: its
         default is always the full duration, and BPM - Random is the only
         shipped preset that touches it. */
      maxDistance: pick('Max Distance'),
      durationUnit: unit,
      durationType: dt,
      /* the engine's a.duration is seconds and a.beats is a beat count; which
         of the two is authoritative is durationUnit's job to say. */
      duration: seconds, seconds, beats,
      playmode:  pm === null ? null : (PLAY_MODES[pm] || null),
      playmodeCode: pm,
      direction: pd === null ? null : (PLAY_DIRECTIONS[pd] || null),
      directionCode: pd,
      away: pa === null ? null : (PLAY_MODE_AWAY[pa] || null),
      hardSynced: bool(attr(el, 'hardSynced')),
      durationIsScalable: sub.map.DurationIsScalable ? sub.map.DurationIsScalable.value : null,
      beatsData: beat, env: null, running: true
    })};
  }

  if(tag === 'PhaseSourceTransportTimeline'){
    /* The clip playhead. On the clip's own Transport/Position this IS the
       transport and readClip() reads the detail off it; anywhere else it is
       parameter-animation.htm's "Clip Position" source. */
    return {phase, anim: carry({
      source: 'TransportTimeline', mode: 'Clip Position', phase,
      speed: pick('Speed'),
      bpm: pick('BPM'),                                // per-clip tempo, range 20..500
      tempoSynced: sub.map.TempoSynced ? sub.map.TempoSynced.value : null,
      maxDistance: pick('Max Distance'),
      seconds: num(attr(el, 'defaultMillisecondsDuration')) === null ? null
             : num(attr(el, 'defaultMillisecondsDuration')) / 1000,
      milliseconds: num(attr(el, 'defaultMillisecondsDuration')),
      beats: num(attr(el, 'defaultBeatsDuration')),
      beatsData: beat, env: null, running: true
    })};
  }

  if(tag === 'PhaseSourceFFT'){
    const link = str(attr(el, 'linkId'));
    if(link && !FFT_SOURCES[link]) warn(ctx, 'FFT linkId "' + link + '" is not in any shipped file; mode left generic');
    const freq = sub.map.FrequencyRange || null;
    const gainDb = pick('Gain');
    const fallMs = pick('Fallback');
    return {phase, anim: carry({
      source: 'FFT', mode: FFT_SOURCES[link] || 'FFT', phase, linkId: link,
      /* The in/out points under the spectrum display. Which of L/M/H the band
         corresponds to is a position on a continuous spectrum, not a stored
         enum, so band stays null rather than being guessed at. */
      band: null,
      frequency: freq ? {value: freq.value, in: freq.inOut ? freq.inOut.min : null,
                                            out: freq.inOut ? freq.inOut.max : null} : null,
      gainDb,
      gain: gainDb === null ? null : Math.pow(10, gainDb / 20),   // engine a.gain is linear
      fall: fallMs === null ? null : fallMs / 1000,               // engine a.fall is seconds
      behaviour: sub.map.ValueBehaviour ? sub.map.ValueBehaviour.value : null,
      beatsData: beat, env: null, running: true
    })};
  }

  if(tag === 'PhaseSourceDashboardLink'){
    /* dashboard.htm. The link is stored on the TARGET, not on the dial — the
       driven parameter simply replaces its PhaseSourceStatic with this. And
       linkId is one-based (/link1../link8), the only one-based index in the
       whole file; EN.linkToDashboard wants 0..7, hence dialIndex. */
    const id = str(attr(el, 'linkId')) || '';
    const n  = num((/(\d+)\s*$/.exec(id) || [])[1]);
    return {phase, anim: carry({
      source: 'DashboardLink', mode: 'Dashboard', phase,
      linkId: id, linkName: str(attr(el, 'linkName')),
      dial: n, dialIndex: n === null ? null : n - 1
    })};
  }

  warn(ctx, 'unknown phase source <' + tag + '>; value kept, animation dropped');
  return {phase, anim: null};
}

/* --- the reader itself --------------------------------------------------- */
function readParam(el, ctx){
  const tag = tagOf(el);
  const T   = str(attr(el, 'T'));
  const type = typeOf(tag, T);
  const p = {
    node: tag,
    name: str(attr(el, 'name'), ''),
    /* altName is the user-facing label, name is the stable id. Bind UI to
       label, identity to name. ("Max Distance"/"Distance", "Link 1"/"RGB".) */
    label: str(attr(el, 'altName')) || str(attr(el, 'name'), ''),
    T, type,
    value:   coerce(type, attr(el, 'value')),
    default: coerce(type, attr(el, 'default')),
    raw: {value: str(attr(el, 'value')), default: str(attr(el, 'default'))},
    min: null, max: null, rangeFrom: null, ranges: null, inOut: null,
    options: null, storeChoices: bool(attr(el, 'storeChoices')),
    phase: null, anim: null, duration: null, color: null,
    fileRaw: null, file: null, sub: null
  };

  /* T is optional on ParamChoice — 49 of the 67 in Example.avc omit it. */
  let phaseEl = null, behaviour = null, ranges = null, subParams = null, choices = null;
  kids(el).forEach(c => {
    const t = tagOf(c);
    if(t === 'DurationSource'){ p.duration = readDurationSource(c); return; }
    if(t === 'ValueRange'){
      ranges = ranges || {};
      ranges[str(attr(c, 'name'), 'range')] = {min: num(attr(c, 'min')), max: num(attr(c, 'max'))};
      return;
    }
    if(t.indexOf('PhaseSource') === 0){ phaseEl = phaseEl || c; return; }
    if(t === 'BehaviourDouble'){ behaviour = c; return; }
    if(t === 'Params'){ subParams = c; return; }
    if(t === 'Choice'){
      choices = choices || [];
      choices.push({name: str(attr(c, 'name')), value: num(attr(c, 'value')),
                    enabled: bool(attr(c, 'enabled'), true), active: bool(attr(c, 'active'), false),
                    shortName: str(attr(c, 'shortName'))});
      return;
    }
    if(t === 'ColorPalette'){ p.palette = readParamsBlock(childNamed(c, 'Params', 'Params'), ctx).map; return; }
    warn(ctx, 'unknown child <' + t + '> under <' + tag + ' name="' + p.name + '">; skipped');
  });

  if(ranges){
    p.ranges = ranges;
    /* minMax is the hard limit, defaultRange the nominal one, startStop the
       in/out sub-range. Volume is the exception that proves the rule: it
       carries only startStop (-48..+12) and that IS its range, in decibels. */
    const pick = ranges.minMax || ranges.defaultRange || ranges.range || null;
    if(pick){ p.min = pick.min; p.max = pick.max; p.rangeFrom = ranges.minMax ? 'minMax' : ranges.defaultRange ? 'defaultRange' : 'range'; }
    else if(ranges.startStop){ p.min = ranges.startStop.min; p.max = ranges.startStop.max; p.rangeFrom = 'startStop'; }
    if(ranges.startStop) p.inOut = ranges.startStop;
  }

  /* 7.3 nests the phase source INSIDE BehaviourDouble; 7.4 and 7.23 make it a
     direct child of the parameter. Accept both. */
  if(!phaseEl && behaviour) phaseEl = kids(behaviour).find(c => tagOf(c).indexOf('PhaseSource') === 0) || null;

  if(phaseEl){
    const ps = readPhaseSource(phaseEl, ctx, p);
    p.phase = ps.phase;
    p.anim  = ps.anim;
  }
  if(p.anim && behaviour) p.anim.env = readEnvelope(behaviour, ctx);

  if(choices) p.options = choices;
  if(subParams){
    const b = readParamsBlock(subParams, ctx);
    p.sub = b.map;
    p.subList = b.list;
  }
  if(type === 'color'){
    p.color = decodeColor(p.value);
    p.colorDefault = decodeColor(p.default);
    p.channelMode = num(attr(el, 'channelmode'));
    p.paletteEnabled = bool(attr(el, 'paletteEnabled'));
    p.interpolated = bool(attr(el, 'interpolated'));
  }
  if(type === 'file'){
    p.fileRaw = p.value;
    p.file = resolvePath(p.value, ctx && ctx.mediaBase);
  }

  /* A cheap correctness check on the loader's own range table: phase is the
     value normalised over the full range, so where the file states the range
     the two must agree. Skipped for Volume, whose fader is documented
     non-linear (value 4.2002 against phase 0.6265 over -48..+12 fits no line)
     and for which Example.avc holds exactly one sample, so the curve cannot be
     derived and is not fitted here. */
  if(ctx && ctx.checkPhase && p.phase !== null && p.min !== null && p.max !== null &&
     p.type === 'range' && p.name !== 'Volume' && p.max !== p.min){
    const implied = p.min + p.phase * (p.max - p.min);
    const tol = Math.max(1e-6, Math.abs(p.max - p.min) * 1e-6);
    if(Math.abs(implied - p.value) > tol)
      warn(ctx, 'phase/value mismatch on "' + p.name + '" (' + p.value + ' vs ' + implied + ' over ' + p.min + '..' + p.max + ')');
  }

  /* dashboard.htm — collect the reverse index while we are here, because the
     dial may be written before or after its targets and the link can only be
     resolved once the whole tree exists. */
  if(p.anim && p.anim.source === 'DashboardLink' && ctx)
    ctx.links.push({dial: p.anim.dial, dialIndex: p.anim.dialIndex, linkId: p.anim.linkId,
                    linkName: p.anim.linkName, at: ctx.at, param: p.name, label: p.label});
  return p;
}

/* <Params name="Params"> -> {map by name, list in document order}. Order
   matters for effect parameters, name lookup for everything else. */
function readParamsBlock(el, ctx){
  const list = [];
  if(el) kids(el).forEach(c => {
    if(!PARAM_TAGS[tagOf(c)]){
      warn(ctx, 'unexpected <' + tagOf(c) + '> inside <Params>; skipped');
      return;
    }
    list.push(readParam(c, ctx));
  });
  const map = {};
  list.forEach(p => { if(!(p.name in map)) map[p.name] = p; });
  return {map, list};
}
const pv = (b, n, d) => (b && b.map[n] && b.map[n].value !== null && b.map[n].value !== undefined) ? b.map[n].value : (d === undefined ? null : d);

/* A pass can carry SEVERAL sibling <Params> blocks, each with its own @name —
   the ShaperGenerator in Example.avc writes "Params", "Shape 1" and "Shape 2".
   The unnamed-by-convention "Params" block is the pass's own parameter list;
   the rest are named groups the panel draws as sub-sections, and dropping them
   would lose 14 real parameters. */
function readParamGroups(el, ctx){
  const blocks = kidsNamed(el, 'Params');
  const primary = blocks.find(b => attr(b, 'name') === 'Params') || blocks[0] || null;
  const main = readParamsBlock(primary, ctx);
  const groups = {};
  blocks.forEach(b => {
    if(b === primary) return;
    groups[str(attr(b, 'name'), 'Params')] = readParamsBlock(b, ctx);
  });
  return {main, groups: Object.keys(groups).length ? groups : null};
}

/* =========================================================================
   4. RENDER PASS CHAINS = EFFECTS — effects.htm
   Every video effect is a two-level sandwich: an outer baseType="DryWetEffect"
   wrapper carrying the effect's Opacity, containing (a) the inner
   baseType="Effect" pass with the real parameters and (b) a ChoosableMixer
   carrying the effect's Blend Mode. That is exactly effects.htm's "video
   effects always have at least two parameters: Opacity and Blend Mode".
   ========================================================================= */

/* The mixer's blend is its <RenderPass baseType="Mixer"> CHILD, never the
   UINT64 in ParamChoice[Blend Mode]: the ids are not contiguous (A008 ->
   67464117 but A010 -> 67464210), so the integer indexes nothing. The child's
   @name is already the string the engine's blend picker uses. */
function readMixer(el, ctx){
  if(!el) return null;
  const rp = kids(el).find(c => tagOf(c) === 'RenderPass' && attr(c, 'baseType') === 'Mixer') || null;
  const own = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  const inner = rp ? readParamsBlock(childNamed(rp, 'Params', 'Params'), ctx) : null;
  return {
    name: str(attr(el, 'name')),
    blend: rp ? str(attr(rp, 'name')) : null,
    blendType: rp ? str(attr(rp, 'type')) : null,
    blendTypeId: rp ? str(attr(rp, 'uniqueTypeId')) : null,
    blendId: pv(own, 'Blend Mode'),
    /* Opacity is a parameter OF the selected mixer, so it lives on a different
       object per blend mode — unlike the engine, where videoBlock() makes
       opacity and blend siblings. Round-trip with care. */
    opacity: inner ? pv(inner, 'Opacity') : null,
    opacityParam: inner ? (inner.map.Opacity || null) : null,
    params: own.map, mixerParams: inner ? inner.map : null,
    empty: !rp
  };
}

function readEffect(el, ctx){
  const baseType = str(attr(el, 'baseType'));
  const view = child(el, 'View');
  const fx = {
    name: str(attr(el, 'name')),
    type: str(attr(el, 'type')),
    uniqueTypeId: str(attr(el, 'uniqueTypeId')),
    uid: str(attr(el, 'uniqueId')),
    index: num(attr(el, 'index')),
    baseType,
    /* transform.htm — "automatically applied to each clip, layer and group as
       well as to the entire composition". The serialised marker for that is
       View/@bCanBeRemoved="0", not the index. */
    transform: str(attr(el, 'type')) === 'TransformEffect',
    removable:   view ? bool(attr(view, 'bCanBeRemoved'), true) : true,
    disableable: view ? bool(attr(view, 'bCanBeDisabled'), true) : true,
    folded: view ? bool(attr(view, 'folded')) : null,
    opacity: null, bypassed: null, blend: null, blendId: null,
    params: [], paramsByName: {}, animated: null
  };

  /* Name the effect in the path while its parameters are decoded, so a
     dashboard link collected below says which Opacity it drives — three of the
     eight dials in Example.avc drive a parameter literally called "Opacity". */
  const at = ctx.at;
  ctx.at = at + '/effects/' + (fx.index === null ? '?' : fx.index) + ':' + (fx.name || fx.type);

  if(baseType === 'DryWetEffect'){
    const wrap  = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
    const inner = kids(el).find(c => tagOf(c) === 'RenderPass' && attr(c, 'dwType') === 'Effect')
               || kids(el).find(c => tagOf(c) === 'RenderPass' && attr(c, 'baseType') === 'Effect') || null;
    const mixer = readMixer(childNamed(el, 'ChoosableMixer', 'Mixer'), ctx);
    fx.type      = inner ? str(attr(inner, 'type')) : fx.type;
    fx.innerUid  = inner ? str(attr(inner, 'uniqueId')) : null;
    fx.opacity   = pv(wrap, 'Opacity', 1);
    fx.opacityParam = wrap.map.Opacity || null;
    /* Bypassed never appears in Example.avc (nothing is bypassed) but does in
       Presets\Video Effects\Kaleidoscope\Insanity.xml — absent means false. */
    fx.bypassed  = pv(wrap, 'Bypassed', false);
    fx.blend     = mixer ? mixer.blend : null;
    fx.blendId   = mixer ? mixer.blendId : null;
    fx.mixer     = mixer;
    fx.wrapperParams = wrap.map;
    if(inner){
      const ip = readParamGroups(inner, ctx);
      fx.params = ip.main.list;
      fx.paramsByName = ip.main.map;
      fx.paramGroups = ip.groups;
      fx.animated = readAnimationSettings(child(inner, 'AnimationSettings'));
    }
    ctx.at = at;
    return fx;
  }

  /* A bare baseType="Effect" in a chain. In Example.avc this is only ever
     Transform, which is NOT wrapped in a DryWetEffect and therefore has no
     Opacity and no Blend Mode at all. */
  const ip = readParamGroups(el, ctx);
  fx.params = ip.main.list;
  fx.paramsByName = ip.main.map;
  fx.paramGroups = ip.groups;
  fx.animated = readAnimationSettings(child(el, 'AnimationSettings'));
  ctx.at = at;
  return fx;
}

/* Lists exactly the parameters of the owning pass that have a non-static phase
   source. parameter-animation.htm > Parameter Start Settings names the four
   conditions (composition load, clip trigger, column trigger, manual) but the
   bit assignment is not recoverable from the four distinct flag values in the
   corpus, so the integer is passed through unmapped. */
function readAnimationSettings(el){
  if(!el) return null;
  const out = kidsNamed(el, 'Setting').map(s => ({name: str(attr(s, 'name')), flags: str(attr(s, 'flags'))}));
  return out.length ? out : null;
}

/* In 7.4 the Transform is the LAST serialized entry (index 8 after eight
   effects); 7.23 often writes it first and omits every index. Preserve document
   order where indexes are absent, honor explicit indexes where present, then
   hand Transform back separately because arena-engine.js keeps
   transformBlock() outside video.effects[]. */
function readChain(chainEl, ctx){
  const all = [];
  kids(chainEl).forEach(c => {
    const t = tagOf(c);
    if(t !== 'RenderPass'){
      if(t !== 'View') warn(ctx, 'unexpected <' + t + '> inside a RenderPassChain; skipped');
      return;
    }
    const bt = str(attr(c, 'baseType'));
    if(bt === 'RenderPassChain'){ warn(ctx, 'nested RenderPassChain not read'); return; }
    all.push(readEffect(c, ctx));
  });
  all.sort((a, b) => (a.index === null ? 1e9 : a.index) - (b.index === null ? 1e9 : b.index));
  return {
    effects: all.filter(f => !f.transform),
    transform: all.find(f => f.transform) || null,
    order: all.map(f => f.name)
  };
}
/* 7.4 writes baseType="RenderPassChain"; 7.23 writes only
   name="RenderPassChain" on the same wrapper. Requiring baseType discarded
   every effect in newer compositions while still making the track look valid. */
const chainOf = el => kids(el).find(c => tagOf(c) === 'RenderPass' &&
  (attr(c, 'baseType') === 'RenderPassChain' || attr(c, 'name') === 'RenderPassChain')) || null;

/* =========================================================================
   5. VIDEO AND AUDIO TRACKS
   The same two elements appear on Clip, Layer, Composition and CrossFader —
   which is precisely arena-engine.js's videoBlock()/audioBlock() factories.
   ========================================================================= */
function readVideoTrack(el, ctx){
  if(!el) return null;
  const ps = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  const chain = readChain(chainOf(el), ctx);
  const mixers = {};
  kidsNamed(el, 'ChoosableMixer').forEach(m => { mixers[str(attr(m, 'name'))] = readMixer(m, ctx); });
  const blend = mixers.Blend || null;
  /* Arena 7.26 stores Opacity on the selected Blend mixer, while 7.27 can
     store the same Parameter directly on VideoTrack/Params. They are two
     serialisation layouts for one control, so expose one authoritative record
     and let the importer preserve its PhaseSource in either version. */
  const opacityParam = ps.map.Opacity || (blend && blend.opacityParam) || null;
  return {
    /* always written, even at default. Phase arithmetic proves the range is
       0..16384: 1280/16384 = 0.078125 exactly, 720/16384 = 0.0439453125. */
    width:  pv(ps, 'Width'),
    height: pv(ps, 'Height'),
    autosize: (() => {
      const index=pv(ps,'Auto Size');
      return Number.isInteger(index) ? (AUTO_SIZE[index] || null) : null;
    })(),
    /* clips only, always all four, and note AScale defaults to 0 not 1 */
    r: pv(ps, 'RScale'), g: pv(ps, 'GScale'), b: pv(ps, 'BScale'), a: pv(ps, 'AScale'),
    blend:   blend ? blend.blend : null,
    blendId: blend ? blend.blendId : null,
    opacity: opacityParam ? opacityParam.value : null,
    opacityParam,
    mixers,
    effects: chain.effects,
    transform: chain.transform,
    manualDuration: num(attr(el, 'manualDuration')),
    params: ps.map
  };
}

function readAudioTrack(el, ctx){
  if(!el) return null;
  const ps = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  const src = child(el, 'PrimarySource');
  const afs = src ? child(src, 'AudioFileSource') : null;
  const vol = ps.map.Volume || null;
  const chain = child(el, 'AudioEffectChain');
  const fx = chain ? kidsNamed(chain, 'RenderPass').map(c => readEffect(c, ctx)) : [];
  if(chain && kids(chain).length && !fx.length)
    warn(ctx, 'AudioEffectChain has children this parser does not read');
  return {
    /* capitalisation trap: video paths use fileName, audio uses FileName */
    fileRaw: str(afs ? attr(afs, 'FileName') : null),
    file: resolvePath(afs ? attr(afs, 'FileName') : null, ctx.mediaBase),
    basename: basename(afs ? attr(afs, 'FileName') : null),
    /* DECIBELS, not a 0..1 gain: <ValueRange name="startStop" min="-48"
       max="12"/> with default="0" = unity. The engine's audioBlock() is a
       linear 0..1, and app.js multiplies four of them together — dB add where
       gains multiply, so a loader MUST convert rather than assign. gain is
       that conversion; it is not clamped, because +12 dB is 3.98x and the
       clamping policy belongs to the loader. */
    volumeDb: vol ? vol.value : null,
    volumeRange: vol && vol.min !== null ? {min: vol.min, max: vol.max} : null,
    gain: vol && vol.value !== null ? Math.pow(10, vol.value / 20) : null,
    volumeParam: vol,
    /* never written anywhere in Example.avc, i.e. always at default */
    pan: pv(ps, 'Pan'),
    panParam: ps.map.Pan || null,
    effects: fx,
    params: ps.map
  };
}

/* PrimarySource. Three source types occur: VideoFormatReaderSource (a movie),
   GeneratorVideoSource (a built-in or Wire generator) and
   CompositionRouterVideoSource (a Video Router clip, which has no file). */
function readVideoSource(trackEl, ctx){
  const prim = trackEl ? child(trackEl, 'PrimarySource') : null;
  const vs = prim ? child(prim, 'VideoSource') : null;
  if(!vs) return null;
  const reader = child(vs, 'VideoFormatReaderSource');
  const gen = kids(vs).find(c => tagOf(c) === 'RenderPass' && attr(c, 'baseType') === 'Generator') || null;
  const raw = reader ? str(attr(reader, 'fileName')) : null;
  return {
    type: str(attr(vs, 'type')),
    width:  num(attr(vs, 'width')),
    height: num(attr(vs, 'height')),
    fileRaw: raw,
    file: resolvePath(raw, ctx.mediaBase),
    basename: basename(raw),
    loadingThread: reader ? str(attr(reader, 'LoadingThread')) : null,
    generator: gen ? readEffect(gen, ctx) : null,
    /* Wire clips carry an extra <WireRenderPass><SliceInputs/></WireRenderPass>;
       both are empty in Example.avc so nothing is claimed about their shape. */
    wire: gen ? !!child(gen, 'WireRenderPass') : false
  };
}

/* =========================================================================
   6. CLIPS
   ========================================================================= */
function readTransport(clipEl, typeIndex, ctx){
  const t = child(clipEl, 'Transport');
  const ps = t ? readParamsBlock(childNamed(t, 'Params', 'Params'), ctx) : {map: {}, list: []};
  const pos = ps.map.Position || null;
  const a = pos && pos.anim && pos.anim.source === 'TransportTimeline' ? pos.anim : null;
  const d = pos ? pos.duration : null;
  const bd = a ? a.beatsData : null;

  /* Three redundant copies of the real length live in the file: the transport
     phase source's defaultMillisecondsDuration, the Position parameter's
     <ValueRange name="minMax" max> in ms, and DurationSource/@defaultDuration
     with a unit suffix. They agree; take them in that order. This is what
     replaces arena-engine.js's 4 + (hashName(name) % 24). */
  let seconds = a ? a.seconds : null;
  if(seconds === null && pos && pos.ranges && pos.ranges.minMax && pos.ranges.minMax.max !== null)
    seconds = pos.ranges.minMax.max / 1000;
  if(d && d.unit === 'seconds' && d.userDuration != null) seconds = d.userDuration;  // user override wins
  else if(seconds === null && d && d.unit === 'seconds' && d.defaultDuration != null) seconds = d.defaultDuration;

  /* video.htm > BPM Sync — "you will need to set the number of beats that the
     clip spans". Resolume already worked it out; do not recompute it. Where
     its own detector ran the number comes from detectedTempo, not from the
     120 BPM nearest-power-of-two guess, so a recomputation gets AV clips wrong. */
  let beats = a ? a.beats : null;
  if(d && d.unit === 'beats' && d.userDuration != null) beats = d.userDuration;      // user override wins
  else if(beats === null && d && d.unit === 'beats' && d.defaultDuration != null) beats = d.defaultDuration;
  if(beats === null && bd && bd.numManualBeats > 0) beats = bd.numManualBeats;

  return {
    type: TRANSPORT_TYPES[typeIndex] || 'Timeline',
    typeIndex,
    position: pos ? (pos.phase !== null ? pos.phase : 0) : 0,   // 0..1, as the engine models it
    positionMs: pos ? pos.value : null,
    durationSeconds: seconds,
    durationMs: a ? a.milliseconds : (pos && pos.ranges && pos.ranges.minMax ? pos.ranges.minMax.max : null),
    beats,
    speed: a ? a.speed : null,
    bpm: a ? a.bpm : null,
    tempoSynced: a ? a.tempoSynced : null,
    maxDistance: a ? a.maxDistance : null,
    /* not serialised anywhere in Example.avc — every clip is at default. null
       means "keep the engine default", never "off". */
    playmode: null, direction: null, away: null,
    inpoint: null, outpoint: null,
    duration: d,
    valueRangeMs: pos && pos.ranges ? pos.ranges.minMax || null : null,
    beatsDetected: bd,
    param: pos
  };
}

function readClip(el, deck0, ctx){
  const layer0  = num(attr(el, 'layerIndex'), 0);
  const column0 = num(attr(el, 'columnIndex'), 0);
  const ps = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  const nameParam = ps.map.Name || null;

  const at = ctx.at;
  ctx.at = at + '/clips/' + (layer0 + 1) + ':' + (column0 + 1);
  const videoEl = childNamed(el, 'VideoTrack', 'VideoTrack');
  const audioEl = childNamed(el, 'AudioTrack', 'AudioTrack');
  const video = readVideoTrack(videoEl, ctx);
  const audio = readAudioTrack(audioEl, ctx);
  const source = readVideoSource(videoEl, ctx);
  const transport = readTransport(el, num(pv(ps, 'TransportType', 0), 0), ctx);
  ctx.at = at;

  /* PreloadData is the fast path — it lets Resolume draw the grid and warm the
     file cache before instantiating any source, so the same two paths are
     written twice. The source is authoritative; preload is the fallback. */
  const pre = child(el, 'PreloadData');
  const preVideo = pre ? child(pre, 'VideoFile') : null;
  const preAudio = pre ? child(pre, 'AudioFile') : null;
  const thumbEl  = pre ? child(pre, 'EmbeddedThumbnail') : null;
  const preVideoRaw = preVideo ? str(attr(preVideo, 'value')) : null;
  const preAudioRaw = preAudio ? str(attr(preAudio, 'value')) : null;

  const videoRaw = (source && source.fileRaw) || preVideoRaw || null;
  const audioRaw = (audio && audio.fileRaw) || preAudioRaw || null;
  if(preVideoRaw && source && source.fileRaw && preVideoRaw !== source.fileRaw)
    warn(ctx, 'PreloadData/VideoFile disagrees with VideoFormatReaderSource/@fileName; the source wins');

  return {
    /* INDEX CONVERSION: the file writes layerIndex/columnIndex/deckIndex
       zero-based, arena-engine.js addresses clips one-based
       (/composition/decks/{d}/layers/{l}/clips/{c}, all >= 1) and so does
       Resolume's runtime API. +1 happens here so no caller repeats it; the
       untouched originals stay on .zeroBased for anyone writing the file back. */
    deck: deck0 + 1, layer: layer0 + 1, column: column0 + 1,
    /* clips.htm — "you can now give each clip or set of clips its own nice
       pastelly highlight". Written as <ParamChoice name="ColorId" T="INT32"
       default="0" value="N"/>: 0 is no colour and 1-5 are Arena's five
       swatches, which is exactly COLOR_SWATCHES' 0-5. null here means the file
       said nothing at all, which the engine must not confuse with an explicit
       0 — a clip whose colour was cleared and one that never had one look the
       same on screen but differ on save. */
    colorid: pv(ps, 'ColorId', null),
    zeroBased: {deck: deck0, layer: layer0, column: column0},
    uid: str(attr(el, 'uniqueId')),
    filled: true,
    /* @default is the auto-derived name — the source file's stem — and @value
       is the user's rename. 27 of the 47 in Example.avc are unrenamed. Never
       read @default as a factory constant; it is context-derived throughout
       this format. */
    name: nameParam ? nameParam.value : '',
    defaultName: nameParam ? nameParam.default : null,
    transportType: num(pv(ps, 'TransportType', 0), 0),
    video: {
      /* Strip Video removes the native track node, not the Clip transport.
         PreloadData is only a cache hint and can outlive that edit, so node
         existence (not a remembered file path) is the authoritative bit. */
      present: !!videoEl,
      fileRaw: videoRaw,
      file: resolvePath(videoRaw, ctx.mediaBase),
      basename: basename(videoRaw),
      width:  video ? video.width  : null,
      height: video ? video.height : null,
      /* native size of the source, which is what the engine should seed
         clip/video/{width,height} from */
      nativeWidth:  source ? source.width  : null,
      nativeHeight: source ? source.height : null,
      r: video ? video.r : null, g: video ? video.g : null,
      b: video ? video.b : null, a: video ? video.a : null,
      /* Clip/VideoTrack/ChoosableMixer[Blend] is empty on all 47 clips, i.e.
         no clip asserts a blend and the engine's DETERMINED_LAYER sentinel
         stands. clips.htm: a clip blend overrides the layer's "for as long as
         this clip is playing" — only once the user picks one. */
      blend:   video ? video.blend   : null,
      blendId: video ? video.blendId : null,
      opacity: video ? video.opacity : null,
      sourceType: source ? source.type : null,
      generator: source ? source.generator : null,
      manualDuration: video ? video.manualDuration : null,
      mixers: video ? video.mixers : null,
      params: video ? video.params : null
    },
    audio: {
      present: !!audioEl,
      fileRaw: audioRaw,
      file: resolvePath(audioRaw, ctx.mediaBase),
      basename: basename(audioRaw),
      volume: audio ? audio.volumeDb : null,       // dB
      gain:   audio ? audio.gain : null,           // the same figure as a linear gain
      volumeRange: audio ? audio.volumeRange : null,
      pan: audio ? audio.pan : null,
      effects: audio ? audio.effects : [],
      params: audio ? audio.params : null
    },
    transport,
    effects: video ? video.effects : [],
    transform: video ? video.transform : null,
    source,
    /* LZF-compressed 32-bit RGBA, base64. Only generator and Wire clips carry
       one — file-backed clips regenerate theirs from the movie. Passed through
       verbatim; nothing here decodes LZF. */
    thumbnail: thumbEl ? {
      encoding: str(attr(thumbEl, 'encoding')), width: num(attr(thumbEl, 'width')),
      height: num(attr(thumbEl, 'height')), bitdepth: num(attr(thumbEl, 'bitdepth')),
      data: ctx.thumbnails ? str(attr(thumbEl, 'data')) : null
    } : null,
    params: ps.map
  };
}

/* =========================================================================
   7. LAYERS, COLUMNS, DECKS
   ========================================================================= */
function readLayer(el, ctx){
  const index0 = num(attr(el, 'layerIndex'), 0);
  ctx.at = '/composition/layers/' + (index0 + 1);
  const video = readVideoTrack(childNamed(el, 'VideoTrack', 'VideoTrack'), ctx);
  const audio = readAudioTrack(childNamed(el, 'AudioTrack', 'AudioTrack'), ctx);
  const transition = video && video.mixers ? video.mixers.Transition : null;
  ctx.at = '/composition';
  return {
    index: index0 + 1,                                  // +1: file 0-based, engine 1-based
    zeroBased: index0,
    uid: str(attr(el, 'uniqueId')),
    /* A <Layer> in Example.avc has only uniqueId and layerIndex — no name
       attribute and no Params of its own; everything lives on its tracks. That
       was read as "layers never carry Params", and it is not true of the wider
       corpus: Composition/Layer/Params/ParamChoice[@name="ColorId"] occurs 4
       times across reference/compositions/. So the block IS read now, and the
       fields that genuinely never appear stay null so buildLayer()'s defaults
       stand. */
    name: null, master: null, bypassed: null, solo: null,
    crossfadergroup: null, maskmode: null, lock: null,
    ignorecolumntrigger: null, faderstart: null, triggerfirstclip: null,
    colorid: pv(readParamsBlock(childNamed(el, 'Params', 'Params'), ctx), 'ColorId', null),
    /* layers.htm > Layer Folding. Stored as an attribute on <LayerView>, a
       direct child of <Layer> — NOT as a Param, unlike every other layer flag
       above. That is Resolume's own choice and worth stating, because the
       obvious move is to make it a Param to inherit undo/save/MIDI: the
       corpus says otherwise. 153 zeros and 4 ones across the twelve
       compositions in reference/compositions, so folded layers do occur.
       Distinct from FoldParams > FoldState below, which is panel-section fold
       state and is deliberately not parsed. */
    folded: (() => {
      const v = childNamed(el, 'LayerView', 'LayerView');
      if (!v) return null;                       // absent: the engine default stands
      const f = attr(v, 'foldedControl');
      return f == null ? null : num(f, 0) !== 0;
    })(),
    /* layers.htm — the layer's opacity is a parameter of the SELECTED blend
       mixer, so it is null whenever the mixer wrote no Params (meaning 1.0). */
    opacity: video ? video.opacity : null,
    blend:   video ? video.blend : null,
    blendId: video ? video.blendId : null,
    width:  video ? video.width : null,
    height: video ? video.height : null,
    autosize: video ? video.autosize : null,
    /* layers.htm > Layer Transition. The blend is a second ChoosableMixer;
       <ClipTransition> is empty in all three layers so the file says nothing
       about how the transition DURATION is stored. */
    transition: {blend: transition ? transition.blend : null, duration: null},
    effects: video ? video.effects : [],
    transform: video ? video.transform : null,
    audio, video
  };
}

function readDeck(el, ctx){
  const index0 = num(attr(el, 'deckIndex'), 0);
  const ps = readParamsBlock(childNamed(el, 'Params', 'Params'), ctx);
  ctx.at = '/composition/decks/' + (index0 + 1);
  const clips = kidsNamed(el, 'Clip').map(c => safe(ctx, 'clip in deck ' + index0, () => readClip(c, index0, ctx))).filter(Boolean);

  /* decks.htm — column NAMES belong to the deck, not to the composition:
     switching decks relabels the columns. Only renamed columns are written,
     so this is sparse. The "#" in "AV 00#" is Resolume's stack-position
     placeholder, which EN.displayName() already substitutes. */
  const names = [];
  kidsNamed(el, 'ColumnAttributes').forEach(c => {
    const i0 = num(attr(c, 'index'), 0);
    names[i0] = str(attr(c, 'name'));                   // names[0] is column 1
  });
  /* THE COLUMNS ARE HERE, AND THIS IS WHY "columns recovered 0".
     Two column paths existed and neither matched a real file. Measured across
     all twelve compositions in reference/compositions/ with a real XML parse:

       <Column> as a child of the root <Composition>   0     (parse() looked here)
       <ColumnAttributes> inside a <Deck>              0     (the loop above)
       <Column> inside a <Deck>                      330     (nobody looked here)

     A deck's column carries its identity AND its parameters:
       <Column uniqueId="1782401650282" columnIndex="0">
         <Params><Param name="Name" value="HOLDING LIVEFEED"/>
                 <ParamChoice name="ColorId" T="INT32" default="0" value="3"/></Params>
       </Column>
     So 330 columns, their real names and 36 colour assignments were being
     dropped on every load. ColumnAttributes is kept above rather than replaced:
     it costs nothing and an older file may still use it. */
  const columns = kidsNamed(el, 'Column').map(c => {
    const cps = readParamsBlock(childNamed(c, 'Params', 'Params'), ctx);
    const i0 = num(attr(c, 'columnIndex'), 0);
    const nm = pv(cps, 'Name', null);
    if(nm != null && names[i0] == null) names[i0] = str(nm);
    return {
      index: i0 + 1,                                    // +1: file 0-based, engine 1-based
      zeroBased: i0,
      uid: str(attr(c, 'uniqueId')),
      name: nm == null ? null : str(nm),
      /* colour coding — see the ColorId note in readClip. null means the file
         said nothing, which is not the same as 0 ("no colour"). */
      colorid: pv(cps, 'ColorId', null)
    };
  }).sort((a, b) => a.index - b.index);
  ctx.at = '/composition';
  return {
    index: index0 + 1,                                  // +1, as everywhere else
    zeroBased: index0,
    id: str(attr(el, 'uniqueId')),
    name: pv(ps, 'Name', ''),                           // default is the literal "empty"
    closed: bool(attr(el, 'closed')),                   // null -> fall back to DeckInfo/@closed
    /* per-deck grid size; deck 3 in Example.avc says numColumns="8" while the
       composition says 9. The engine has one global count — take the
       composition's and let short decks have empty slots, which is what Arena
       displays anyway. */
    numLayers: num(attr(el, 'numLayers')),
    numColumns: num(attr(el, 'numColumns')),
    numLayersWithContent: num(attr(el, 'numLayersWithContent')),
    numColumnsWithContent: num(attr(el, 'numColumnsWithContent')),
    columnNames: names,
    columns,
    clips,
    params: ps.map
  };
}

/* =========================================================================
   8. PARSE
   ========================================================================= */
function emptyDoc(){
  return {
    name: '', description: '', width: null, height: null,
    numLayers: 0, numColumns: 0, numDecks: 0,
    /* zero-based, deliberately: arena-engine.js's doc.deck is zero-based too,
       so this one index needs no conversion. */
    currentDeck: 0,
    relative: false, version: null, uid: null,
    decks: [], layers: [], columns: [], clips: [],
    dashboard: [], dashboardLinks: [],
    params: {}, tempo: {bpm: null}, crossfader: {},
    video: null, audio: null, warnings: []
  };
}

function parse(xmlString, opts){
  opts = opts || {};
  const ctx = {
    warnings: [], seen: new Set(), links: [], at: '/composition',
    mediaBase: opts.mediaBase || null,
    thumbnails: opts.thumbnails !== false,
    checkPhase: opts.checkPhase !== false
  };
  const doc = emptyDoc();
  doc.warnings = ctx.warnings;

  /* opts.DOMParser is the testing seam: node has no DOM, and a parser that
     reached for a bundled XML implementation would stop being a pure function
     of its input. */
  const DP = opts.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if(!DP){ warn(ctx, 'no DOMParser available'); return doc; }
  if(typeof xmlString !== 'string' || !xmlString.trim()){ warn(ctx, 'empty input'); return doc; }

  let xml;
  try { xml = new DP().parseFromString(xmlString, 'text/xml'); }
  catch(e){ warn(ctx, 'XML parse failed: ' + ((e && e.message) || e)); return doc; }

  /* DOMParser signals failure with a <parsererror> element rather than
     throwing, so it has to be checked for explicitly. */
  if(xml && xml.getElementsByTagName){
    const pe = xml.getElementsByTagName('parsererror');
    if(pe && pe.length){ warn(ctx, 'XML parse error: ' + ((pe[0].textContent || '').slice(0, 200))); return doc; }
  }
  const root = xml.documentElement || (xml.getElementsByTagName ? xml.getElementsByTagName('Composition')[0] : null);
  if(!root || tagOf(root) !== 'Composition'){ warn(ctx, 'root is <' + tagOf(root) + '>, expected <Composition>'); return doc; }

  doc.uid         = str(attr(root, 'uniqueId'));
  doc.numLayers   = num(attr(root, 'numLayers'), 0);
  doc.numColumns  = num(attr(root, 'numColumns'), 0);
  doc.numDecks    = num(attr(root, 'numDecks'), 0);
  doc.currentDeck = num(attr(root, 'currentDeckIndex'), 0);
  /* "1" = media paths are relative to the folder holding the .avc. Everything
     resolved below assumes it; an absolute-path file (0) resolves unchanged
     because resolvePath() passes drive letters and leading slashes through. */
  doc.relative    = bool(attr(root, 'compositionIsRelative'), false);

  const vi = child(root, 'versionInfo');
  if(vi) doc.version = {
    product: str(attr(vi, 'name')), major: num(attr(vi, 'majorVersion')),
    minor: num(attr(vi, 'minorVersion')), micro: num(attr(vi, 'microVersion')),
    revision: num(attr(vi, 'revision'))
  };

  /* CompositionInfo duplicates name/width/height that also live in Params and
     VideoTrack. It exists so Resolume can populate the open dialog without
     parsing 350 KB — treat it as a preview header and prefer the parameters. */
  const info = child(root, 'CompositionInfo');
  const deckInfo = info ? kidsNamed(info, 'DeckInfo').map(d => ({
    name: str(attr(d, 'name')), id: str(attr(d, 'id')), closed: bool(attr(d, 'closed'), false)
  })) : [];
  if(info){
    doc.name = str(attr(info, 'name'), '');
    doc.description = str(attr(info, 'description'), '');
    doc.width  = num(attr(info, 'width'));
    doc.height = num(attr(info, 'height'));
  }

  safe(ctx, 'composition Params', () => {
    const b = readParamsBlock(childNamed(root, 'Params', 'Params'), ctx);
    const snap = b.map['Beat Snap'] ? b.map['Beat Snap'].value : null;
    doc.params = {
      name: pv(b, 'Name', doc.name),
      master: pv(b, 'Master'),
      speed: pv(b, 'Speed'),                          // range 0..4: value ~1 at phase ~0.25
      bypassed: pv(b, 'Bypassed'),
      beatSnapIndex: snap,
      beatSnap: snap === null ? null : (BEAT_SNAP[snap] || null),
      keyboardShortcutPreset: pv(b, 'KeyboardShortcutPreset'),
      midiShortcutPreset: pv(b, 'MidiShortcutPreset'),
      oscShortcutPreset: pv(b, 'OscShortcutPreset'),
      map: b.map
    };
    if(doc.params.name) doc.name = doc.params.name;
    if(snap !== null && !BEAT_SNAP[snap]) warn(ctx, 'Beat Snap index ' + snap + ' is outside the known option list');
  });

  /* dashboard.htm — always exactly eight, always named Link 1..Link 8, and
     always all written. altName is the user-facing dial name, which is what
     "the dial will rename itself to the name of the parameter" produces. The
     dial is an ordinary 0..1 ParamRange with its own phase source, so a dial
     can itself be animated. */
  safe(ctx, 'dashboard', () => {
    const b = readParamsBlock(childNamed(root, 'Params', 'Dashboard'), ctx);
    doc.dashboard = b.list.map((p, i) => ({
      index: num((/(\d+)\s*$/.exec(p.name) || [])[1], i + 1),   // already 1-based in the file
      name: p.label,                                            // the altName
      value: p.value,
      default: p.default,
      anim: p.anim,
      param: p,
      links: []
    }));
  });

  safe(ctx, 'composition VideoTrack', () => {
    ctx.at = '/composition/video';
    doc.video = readVideoTrack(childNamed(root, 'VideoTrack', 'VideoTrack'), ctx);
    ctx.at = '/composition';
    if(doc.video){
      if(doc.video.width  !== null) doc.width  = doc.video.width;   // the parameter wins
      if(doc.video.height !== null) doc.height = doc.video.height;
    }
  });
  safe(ctx, 'composition AudioTrack', () => {
    ctx.at = '/composition/audio';
    doc.audio = readAudioTrack(childNamed(root, 'AudioTrack', 'AudioTrack'), ctx);
    ctx.at = '/composition';
  });

  safe(ctx, 'layers', () => {
    doc.layers = kidsNamed(root, 'Layer').map(l => safe(ctx, 'layer', () => readLayer(l, ctx))).filter(Boolean);
    doc.layers.sort((a, b) => a.index - b.index);
  });

  /* Columns at the ROOT are identity only, and in the twelve-composition corpus
     there are none at all — every <Column> is inside a <Deck>, with its name and
     its ColorId (see readDeck). The root form is still read first, because a
     file that has it is telling us the composition-level identity directly; the
     deck union is the fallback that actually fires on real files.

     decks.htm — column NAMES belong to the deck, so switching decks relabels
     the columns. doc.columns is therefore a naive-loader convenience taking the
     first deck that names a given column; doc.decks[].columns stays the correct
     source for a UI that follows deck changes. */
  safe(ctx, 'columns', () => {
    doc.columns = kidsNamed(root, 'Column').map(c => ({
      index: num(attr(c, 'columnIndex'), 0) + 1,                 // +1
      zeroBased: num(attr(c, 'columnIndex'), 0),
      uid: str(attr(c, 'uniqueId')),
      name: null,
      colorid: null
    }));
    doc.columns.sort((a, b) => a.index - b.index);
  });

  safe(ctx, 'decks', () => {
    doc.decks = kidsNamed(root, 'Deck').map(d => safe(ctx, 'deck', () => readDeck(d, ctx))).filter(Boolean);
    doc.decks.sort((a, b) => a.index - b.index);
    /* DeckInfo/@id === Deck/@uniqueId, 1:1 and in the same order. Carry the
       header's name/closed across only where the deck itself is silent. */
    doc.decks.forEach(dk => {
      const hdr = deckInfo.find(h => h.id === dk.id);
      if(hdr){ if(!dk.name) dk.name = hdr.name; if(dk.closed === null) dk.closed = hdr.closed; }
      if(dk.closed === null) dk.closed = false;
    });
    doc.clips = doc.decks.reduce((acc, dk) => acc.concat(dk.clips), []);
    /* The union that recovers the 330 columns the root has never carried. Runs
       only when the root gave none, so a file that DOES declare them keeps its
       own identities. First deck to name or colour a column index wins, which
       matches what the composition shows before any deck switch. */
    if(!doc.columns.length){
      const byIndex = new Map();
      doc.decks.forEach(dk => (dk.columns || []).forEach(c => {
        const prev = byIndex.get(c.index);
        if(!prev){ byIndex.set(c.index, Object.assign({}, c)); return; }
        if(prev.name == null && c.name != null) prev.name = c.name;
        if(prev.colorid == null && c.colorid != null) prev.colorid = c.colorid;
      }));
      doc.columns = [...byIndex.values()].sort((a, b) => a.index - b.index);
    }
  });

  /* the current deck's column names, promoted onto the composition columns */
  safe(ctx, 'column names', () => {
    const cur = doc.decks[doc.currentDeck];
    if(!cur) return;
    doc.columns.forEach(c => { const n = cur.columnNames[c.zeroBased]; if(n) c.name = n; });
  });

  safe(ctx, 'CrossFader', () => {
    const cf = child(root, 'CrossFader');
    if(!cf) return;
    ctx.at = '/composition/crossfader';
    const own = readParamsBlock(childNamed(cf, 'Params', 'Params'), ctx);
    const v = readVideoTrack(childNamed(cf, 'VideoTrack', 'VideoTrack'), ctx);
    ctx.at = '/composition';
    const mode = v && v.mixers ? v.mixers['Blend mode'] : null;   // lower-case m, as written
    /* CrossFader Phase is persisted as the Opacity Parameter on its
       "Blend mode" mixer in Arena 7.x compositions. Keeping the record (not
       just the number) preserves Timeline/BPM/Dashboard modulation. */
    const phaseParam = own.map.Phase || (mode && mode.opacityParam) || null;
    doc.crossfader = {
      width: v ? v.width : null, height: v ? v.height : null,
      /* composition.htm > Crossfader. Two mixers: "Blend mode" is the
         crossfader's own blend, "Blend" is how its output rejoins. */
      blend: mode ? mode.blend : null,
      rejoinBlend: v ? v.blend : null,
      effects: v ? v.effects : [],
      transform: v ? v.transform : null,
      mixers: v ? v.mixers : null,
      params: v ? v.params : null,
      phase: phaseParam ? phaseParam.value : null,
      phaseParam,
      /* Behaviour and Curve are absent from the verified corpus. Read a
         future/direct record by its literal value, but do not invent numeric
         choice tables for fields the format evidence does not name. */
      behaviour: pv(own, 'Behaviour'),
      behaviourParam: own.map.Behaviour || null,
      curve: pv(own, 'Curve'),
      curveParam: own.map.Curve || null,
      ownParams: own.map
    };
  });

  /* bpm.htm. One parameter and nothing else: no play state, no metronome, no
     Ableton Link flag. Range 20..500, verified exactly: (128-20)/480 = 0.225. */
  safe(ctx, 'TempoController', () => {
    const tc = child(root, 'TempoController');
    if(!tc) return;
    const b = readParamsBlock(childNamed(tc, 'Params', 'Params'), ctx);
    doc.tempo = {bpm: pv(b, 'Tempo'), param: b.map.Tempo || null};
  });

  /* Resolve the dashboard links last, as the loader recipe requires: the dial
     may be written before or after its targets. */
  safe(ctx, 'dashboard links', () => {
    doc.dashboardLinks = ctx.links;
    ctx.links.forEach(l => {
      const dial = doc.dashboard.find(d => d.index === l.dial);
      if(dial) dial.links.push(l);
      else warn(ctx, 'dashboard link "' + l.linkId + '" names a dial that does not exist');
    });
  });

  /* Self-check: every PhaseSourceDashboardLink in the document should have
     been collected while decoding a parameter. A shortfall means a subtree
     carrying parameters was not read, which is worth saying out loud. */
  safe(ctx, 'link sweep', () => {
    let n = 0;
    walk(root, el => { if(tagOf(el) === 'PhaseSourceDashboardLink') n++; });
    if(n !== ctx.links.length)
      warn(ctx, 'found ' + n + ' PhaseSourceDashboardLink elements but decoded ' + ctx.links.length);
  });

  /* CompositionView/LayerView/ClipView > FoldParams > FoldState is pure UI
     state: a lowercased slash path through the VIEW tree, under several
     historical prefixes and even a localised one. It is not a parameter
     address and is deliberately not parsed. */

  if(doc.version && !/arena/i.test(doc.version.product || ''))
    warn(ctx, 'this is a ' + doc.version.product + ' file; Avenue has no Groups, no Advanced Output and no SMPTE, so no <Group> reader ran');
  if(doc.layers.length !== doc.numLayers)
    warn(ctx, 'numLayers says ' + doc.numLayers + ' but ' + doc.layers.length + ' <Layer> elements were read');
  if(doc.columns.length !== doc.numColumns)
    warn(ctx, 'numColumns says ' + doc.numColumns + ' but ' + doc.columns.length + ' <Column> elements were read');
  if(doc.decks.length !== doc.numDecks)
    warn(ctx, 'numDecks says ' + doc.numDecks + ' but ' + doc.decks.length + ' <Deck> elements were read');

  return doc;
}

/* =========================================================================
   9. SCHEMA NOTES
   What the format says, and — just as importantly — what it does not. Kept
   with the parser so the two cannot drift apart.
   ========================================================================= */
const SCHEMA_NOTES = [
  'Source: default/Example.avc, <versionInfo name="Resolume Avenue" majorVersion="7" minorVersion="4">.',
  '',
  'INDICES. layerIndex, columnIndex, deckIndex and ColumnAttributes/@index are all ZERO-based in',
  'the file. This parser adds +1 to every one of them, because arena-engine.js and Resolume\'s own',
  'runtime API are both one-based (default/Shortcuts uses /composition/layers/3/solo). The',
  'originals survive on .zeroBased. currentDeckIndex is NOT converted: doc.deck in the engine is',
  'zero-based as well.',
  '',
  'PARAMETERS. Six element names share one grammar, including ParamFile image inputs. PhaseSourceStatic/@phase is the value',
  'normalised over the parameter\'s full range, so value = min + phase*(max-min). The range itself',
  'is not stored for most parameters — one equation, two unknowns — so min/max are null unless a',
  '<ValueRange> is present and the loader must carry its own table. @default is dynamic and',
  'inherited, never a schema constant: a clip\'s Name default is the media file stem, a layer\'s',
  'Width default is the composition\'s current width.',
  '',
  'CERTAIN. TransportType 0=Timeline 1=BPM Sync. PlayMode 0=Loop 1=Bounce 2=Random (live API order,',
  'corroborated by preset names) — NOT the order of arena-data.js\'s PLAY_MODES. DurationType',
  '0=seconds 2=beats (13 of 13 presets). Envelope curve 1=Linear, 33=Hold. ParamColor packs as',
  '0xAABBGGRR. Audio Volume is decibels over -48..+12, not a 0..1 gain. Blend must be read from the',
  'ChoosableMixer\'s <RenderPass baseType="Mixer"> child; the UINT64 id is not contiguous and',
  'indexes nothing. In 7.4 Transform is the LAST entry (highest @index); 7.23 often writes it first',
  'without an index. Its stable marker is type="TransformEffect" plus View/@bCanBeRemoved="0", not position.',
  '',
  'UNKNOWN, and left unmapped rather than guessed:',
  '- The audio Volume phase does not obey the linear rule that holds exactly everywhere else. All',
  '  18 audio clips carry the identical value/phase pair, so there is one sample and the dB taper',
  '  cannot be derived. volumeDb is trustworthy; the phase is not used.',
  '- Envelope curve codes 3, 4, 10, 12, 14 are named in no shipped file. Reported as curveCode and',
  '  treated as Linear.',
  '- AnimationSettings/Setting/@flags and AnimationStarter/@flags: four distinct values across the',
  '  whole corpus, four documented start conditions, no derivable bit assignment. Passed through.',
  '- PlayDirection\'s @default differs between 7.4 (1) and 7.23 (2) for the same control, so only',
  '  @value is trusted; the labels come from the live API\'s ["<","||",">"] with index 2 default.',
  '- Max Distance (altName "Distance") is read as the Random play mode\'s maximum jump. Inferred',
  '  from BPM - Random being the only preset that changes it; the manual never names the control.',
  '- Beats_d/@mode is 0 in all 50 occurrences. Its meaning is unknown.',
  '- ParamState never occurs in any shipped XML and cannot be characterised. ParamEvent is the',
  '  class of trigger parameters (connect, clear, tempotap, resync) and is never serialised into a',
  '  composition, because it has no persistent value.',
  '',
  'NOT IN THE FILE, therefore null here — and null means "at default", never "unsupported":',
  'layer name/master/bypassed/solo/crossfadergroup/maskmode/lock/fader start/ignore column trigger,',
  'transition duration, clip persistent/in-out/cue points/play mode/direction/playmode away/beat',
  'loop/alpha type/beat snap, audio Pan, crossfader behaviour/curve, tempo play state,',
  'metronome and Ableton Link, FFT gain, the entire Autopilot subsystem, and any <Group> element.',
  '',
  'FOUND WHILE VERIFYING, and not in the decode notes: a RenderPass can carry SEVERAL sibling',
  '<Params> blocks distinguished by @name. The ShaperGenerator writes "Params", "Shape 1" and',
  '"Shape 2"; reading only the block literally named "Params" silently loses 14 real parameters.',
  'They arrive here as effect.paramGroups. With that handled, all 779 parameter nodes in',
  'Example.avc decode and every one is reachable from the returned document.',
  '',
  'DRIFT a loader must tolerate: 7.3 nests PhaseSource* inside <BehaviourDouble> and uses',
  'Syncmode/Beats/BPM and ValueRange name="range"; 7.4 and 7.23 make the phase source a direct',
  'child and use DurationType/Duration/Multiplier/Interval/hardSynced. Video paths use @fileName,',
  'audio paths use @FileName. Deck attribute ORDER differs between deck 0 and decks 1-3, so parse',
  'by name. Both are handled above.'
].join('\n');

window.ArenaAVC = {
  parse,
  SCHEMA_NOTES,
  /* exported because they are pure and a loader legitimately needs them */
  resolvePath, basename, decodeColor,
  TRANSPORT_TYPES, PLAY_MODES, PLAY_DIRECTIONS, PLAY_MODE_AWAY, BEAT_SNAP, CURVES
};
})();
