/* ===========================================================================
   arena-engine.js — the composition model.
   ---------------------------------------------------------------------------
   Everything the interface study used to fake with loose flags now lives here
   as one document tree of real parameters, wired together the way the Resolume
   Arena 7 manual describes. Three ideas carry the whole file:

     1. ONE PARAMETER, MANY SURFACES.  A layer's opacity is a single object.
        The V fader on the layer strip, the Opacity row in the Layer panel and
        the composite in the monitors all read and write that same object, so
        moving any one of them moves the others. This is what the manual means
        when it says of the Layer Transport Controls, "Changing anything in one
        place, will also update it in the other."  (layers.htm)

     2. VALUES INHERIT.  Beat Snap, Clip Target, Trigger Style, Fader Start,
        Ignore Column Trigger, Transition and Autopilot all have a
        "Composition Determined" / "Layer Determined" sentinel. resolve()
        walks clip -> layer -> group -> composition until it finds a real
        value.  (clips.htm, layers.htm, composition.htm, autopilot.htm)

     3. THE STACK IS A GRAPH.  Layers composite bottom-up; groups are
        sub-compositions that flatten before rejoining; crossfader buses render
        first and collapse onto the lowest bused layer; masks reach downward;
        solo and bypass gate the whole thing. renderStack() computes that graph
        every frame and the monitors paint it.  (layers.htm, groups.htm,
        composition.htm)

   No DOM in this file. arena-ui.js binds it to the window.
   =========================================================================== */
(() => {
'use strict';

const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const DETERMINED_COMP  = 'Composition Determined';
const DETERMINED_LAYER = 'Layer Determined';
const COMPOSITION_FRAME_RATES = Object.freeze(['Auto', 23.976, 24, 25, 29.97, 30, 50, 59.94, 60]);
const COMPOSITION_BIT_DEPTHS = Object.freeze([8, 16]);
/* Arena documents can carry 16-bpc Composition metadata, but this clone's
   Canvas2D programme raster is 8-bpc. Keep the full document choice list for
   import/round-trip fidelity while exposing the honest interactive capability
   separately. */
const COMPOSITION_SUPPORTED_BIT_DEPTHS = Object.freeze([8]);

/* =========================================================================
   1. PARAMETERS
   Every knob in the document is one of these. `id` is stable and is what the
   UI binds to; `home` is the human path used by menus and the dashboard.
   ========================================================================= */
let _pid = 1;
const REG = new Map();              // id -> param
const listeners = new Set();
let batching = 0, dirty = new Set();
let documentGeneration = 0;
let replacingDocument = 0;

function notify(p){
  dirty.add(p);
  if(batching || replacingDocument) return;
  const set = dirty; dirty = new Set();
  listeners.forEach(fn => set.forEach(q => fn(q)));
}
function batch(fn){ batching++; try { fn(); } finally { batching--; if(!batching && dirty.size) notify([...dirty][0]); } }

function P(spec){
  const p = Object.assign({
    id: _pid++, type:'range', min:0, max:1, options:null,
    anim:null,            // {mode, phase, speed, duration, beats, fft, env, running}
    dash:null,            // set when linked to a dashboard dial
    owner:null, key:null, home:''
  }, spec);
  if(p.def === undefined) p.def = p.value;
  /* In and out points belong to the parameter, not to whatever happens to be
     driving it. Resolume's own RangeParameter carries them:
       in  — "The lowest value we clamped the range to, inclusive"
       out — "The highest value we clamped the range to, inclusive"
     min/max stay the absolute bounds; in/out are the window anything driving
     the parameter actually travels through. This engine used to have three
     separate half-versions of the idea — on the clip transport, inside an
     animation, and on a dashboard link — and none of them applied to a plain
     parameter, so dashboard.htm's "you can set the in and out point for the
     param" was only true for params already on a dial. */
  if(p.in  === undefined) p.in  = p.min;
  if(p.out === undefined) p.out = p.max;
  REG.set(p.id, p);
  return p;
}
/* the travelled window, guarding against a reversed or collapsed range */
function windowOf(p){
  const lo = p.in  == null ? p.min : p.in;
  const hi = p.out == null ? p.max : p.out;
  return hi === lo ? {lo, hi: lo + 1e-9} : (hi < lo ? {lo: hi, hi: lo} : {lo, hi});
}
const val   = p => p && p.value;
const param = id => REG.get(+id);

/* set a parameter. Everything in the app funnels through here so that undo,
   notification and the linked-parameter side effects all happen in one place. */
function setParam(id, v, opts){
  const p = typeof id === 'object' ? id : REG.get(+id);
  if(!p) return;
  opts = opts || {};
  if(p.type === 'range' || p.type === 'number') v = clamp(+v, p.min, p.max);
  if(p.type === 'bool') v = !!v;
  if(p.type === 'choice' && p.options && !p.options.includes(v)) return;
  /* Image parameters store a stable RESOURCE ID, never the File, Blob or
     decoded bitmap itself. That keeps the parameter value serialisable and,
     just as importantly, makes an image selection a normal REG entry: OSC and
     the UI address the same value and undo/redo records the selection instead
     of trying to retain a browser-owned decoder object. ArenaFX owns the
     decoded resource behind this id. */
  if(p.type === 'image'){
    if(v == null) v = '';
    else if(typeof v === 'object') v = v.id || v.ref || v.url || '';
    v = String(v);
  }
  if(p.value === v && p.type !== 'event') return;
  /* A transport gesture divides the current elapsed interval. Evaluate its
     old settings once at the gesture time; otherwise a delayed next frame
     would apply a new Pause, speed or BPM to time before the operator changed
     it. Internal per-frame writes must never re-enter the engine. */
  if(!opts.silent && !ticking && clock.lastT !== null && isTransportBoundary(p))
    tick(performance.now());
  const from = p.value;
  p.value = v;
  if(!opts.silent && doc.comp && /\/transport\/position$/.test(p.home || '')){
    doc.layers.forEach(L => {
      const pl=L.playing;
      if(pl && pl.clip.transport.position === p){
        pl.position=v;
        pl._transportT=performance.now();
        pl._held=false;
      }
    });
  }
  if(!opts.silent && /\/transport\/(mode|direction|playmode|in|out)$/.test(p.home || '')){
    doc.layers.forEach(L => {
      if(L.playing && Object.values(L.playing.clip.transport).includes(p)) L.playing._held=false;
    });
  }
  if(!opts.silent && !opts.noUndo && !p.transient) pushUndo(p, from, v);
  if(p.onset) p.onset(v, from);
  /* `silent` is for the engine's own per-frame writes — playheads, animation
     output, autopilot bookkeeping. They must not wake the DOM every frame;
     the UI polls those in place instead. */
  if(!opts.silent) notify(p);
}
function reset(id){                                   // right-click a slider
  const p = typeof id === 'object' ? id : REG.get(+id);
  if(!p) return;
  /* Momentary actions have no stored/default state to restore. In particular,
     Clip Resize is a command whose persistent result lives in Width/Height;
     presenting Reset on the action would create a bogus undo record for 0. */
  if(p.type === 'event' || p.action) return false;
  /* A file Resource is more than its stable id. The friendly filename and a
     session-only embedded payload are part of the same Parameter state; a
     value-only reset leaves the old filename visible and can later register
     the old bytes under a different preset's id. Keep this in the engine so
     every reset surface (label, context menu, control bus, preset tooling)
     receives the same one-entry undo contract. */
  if(p.type === 'resource'){
    return editParameterState('Reset ' + (p.name || 'resource'), [p], opts => {
      delete p.resourceName;
      delete p.resourceData;
      setRange(p, p.min, p.max);
      setParam(p, p.def, opts);
    });
  }
  p.in = p.min; p.out = p.max;        // the window opens back up with the value
  setParam(p, p.def);
}
/* Event Parameters are momentary actions. They neither persist an On state nor
   add an undo entry; mappings and the UI all call this same pulse. Keeping the
   value high briefly guarantees the next render frame observes it, while the
   serial prevents an older release timer from cancelling a newer press. */
function triggerEvent(id){
  const p=typeof id==='object'?id:REG.get(+id);
  if(!p || p.type!=='event') return false;
  const serial=(p._eventPulse||0)+1;
  p._eventPulse=serial;
  const from=p.value; p.value=1;
  if(p.onset) p.onset(1,from);
  notify(p);
  setTimeout(()=>{
    if(p._eventPulse!==serial) return;
    const prior=p.value; p.value=0;
    if(p.onset) p.onset(0,prior);
    notify(p);
  },50);
  return true;
}

/* =========================================================================
   PARAMETER CONTROL MAPPINGS

   Runtime Parameter ids are deliberately ephemeral; a Composition reload
   creates new objects. Keyboard/MIDI/OSC/DMX mappings therefore persist the
   exact public Parameter `home` and keep `_targetId` only as a runtime cache.
   This is the same identity used by Dashboard persistence and OSC.           */
const CONTROL_MAPPING_KINDS=new Set(['keyboard','midi','osc','dmx']);
const CONTROL_MAPPING_MODES=new Set([
  'absolute','button','toggle','value','relative','increment','decrement',
  'select-next','select-previous','random'
]);
let controlMappings=[], controlMappingSerial=1;
function controlKind(value){
  const kind=String(value || '').trim().toLowerCase();
  if(kind==='key') return 'keyboard';
  return kind;
}
function parameterByHome(home){
  home=String(home || ''); let result=null;
  REG.forEach(p => { if(!result && p && p.home===home) result=p; });
  return result;
}
function isControlMappingTarget(p){
  return !!(p && !p.transient && p.home &&
    !['string','image','resource','color'].includes(p.type));
}
function cloneControlMapping(record, portable){
  if(!record) return null;
  const out={};
  Object.keys(record).forEach(key => {
    if(portable && key[0]==='_') return;
    out[key]=cloneEffectValue(record[key]);
  });
  return out;
}
function nextControlMappingId(){ return 'mapping-'+(controlMappingSerial++); }
function observeControlMappingId(id){
  const match=/^mapping-(\d+)$/.exec(String(id || ''));
  if(match) controlMappingSerial=Math.max(controlMappingSerial,+match[1]+1);
}
function normaliseControlMapping(spec, existing, allowMissing){
  spec=Object.assign({},existing || {},spec || {});
  const kind=controlKind(spec.kind);
  if(!CONTROL_MAPPING_KINDS.has(kind)) throw new Error('Unsupported control mapping kind: '+kind);
  const target=spec.target && spec.target.id!=null ? spec.target
    : REG.get(+spec._targetId) || parameterByHome(spec.targetHome);
  if(target && !isControlMappingTarget(target))
    throw new Error((target.name || 'Parameter')+' cannot be mapped to a numeric control surface');
  if((!target || target.transient) && !allowMissing)
    throw new Error('Control mapping target is not available');
  const id=String(spec.id || (existing && existing.id) || nextControlMappingId());
  observeControlMappingId(id);
  const mode=CONTROL_MAPPING_MODES.has(String(spec.mode || '').toLowerCase())
    ? String(spec.mode).toLowerCase() : (kind==='keyboard' ? 'toggle' : 'absolute');
  const record={
    id,kind,targetHome:String((target && target.home) || spec.targetHome || ''),
    _targetId:target ? target.id : null,
    mode,
    min:clamp(Number.isFinite(+spec.min) ? +spec.min : 0,0,1),
    max:clamp(Number.isFinite(+spec.max) ? +spec.max : 1,0,1),
    invert:!!spec.invert
  };
  if(kind==='keyboard') Object.assign(record,{
    code:String(spec.code || ''),key:String(spec.key || ''),
    ctrl:!!spec.ctrl,shift:!!spec.shift,alt:!!spec.alt,meta:!!spec.meta
  });
  if(kind==='midi') Object.assign(record,{
    deviceId:String(spec.deviceId || ''),deviceName:String(spec.deviceName || ''),
    channel:clamp(Math.round(+spec.channel || 1),1,16),
    message:['note','cc','pitchbend'].includes(String(spec.message || '').toLowerCase())
      ? String(spec.message).toLowerCase() : 'cc',
    number:clamp(Math.round(+spec.number || 0),0,127),
    step:clamp(Number.isFinite(+spec.step) ? Math.abs(+spec.step) : 1/127,1/16384,1),
    feedback:spec.feedback!==false,
    outputDeviceId:String(spec.outputDeviceId || ''),
    velocityOff:clamp(Math.round(+spec.velocityOff || 0),0,127),
    velocityOn:clamp(Math.round(spec.velocityOn==null ? 127 : +spec.velocityOn),0,127)
  });
  if(kind==='osc') Object.assign(record,{
    address:String(spec.address || (target && target.home) || spec.targetHome || ''),
    outputAddress:String(spec.outputAddress || spec.address || (target && target.home) || spec.targetHome || ''),
    output:!!spec.output
  });
  if(kind==='dmx') Object.assign(record,{
    universe:clamp(Math.round(+spec.universe || 1),1,32768),
    channel:clamp(Math.round(+spec.channel || 1),1,512),
    width16:!!spec.width16
  });
  return record;
}
function mappingTarget(record){
  let p=record && REG.get(+record._targetId);
  if(!p || p.home!==record.targetHome){
    p=parameterByHome(record && record.targetHome);
    if(record) record._targetId=p ? p.id : null;
  }
  return p || null;
}
function notifyControlMappingTargets(records){
  const seen=new Set();
  (records || []).forEach(record => {
    const p=mappingTarget(record); if(p && !seen.has(p)){ seen.add(p); notify(p); }
  });
}
function installControlMappings(records){
  const before=controlMappings;
  controlMappings=(records || []).map(record => normaliseControlMapping(record,null,true))
    .filter(record => record.targetHome);
  notifyControlMappingTargets(before.concat(controlMappings));
}
function sameControlMappings(a,b){
  return JSON.stringify((a||[]).map(record=>cloneControlMapping(record,true))) ===
    JSON.stringify((b||[]).map(record=>cloneControlMapping(record,true)));
}
function commitControlMappings(label,next,opts){
  opts=opts || {};
  const before=controlMappings.map(record=>cloneControlMapping(record));
  const after=(next || []).map(record=>normaliseControlMapping(record,null,true));
  if(sameControlMappings(before,after)) return false;
  installControlMappings(after);
  if(!opts.noUndo) pushStructuralUndo(label || 'Edit shortcut',
    () => installControlMappings(before),
    () => installControlMappings(after));
  return true;
}
function listControlMappings(filter){
  filter=filter || {};
  const kind=filter.kind && controlKind(filter.kind), targetHome=filter.targetHome;
  return controlMappings.filter(record => (!kind || record.kind===kind) &&
    (!targetHome || record.targetHome===targetHome))
    .map(record=>cloneControlMapping(record,true));
}
function controlMappingsFor(target){
  const p=typeof target==='object' ? target : REG.get(+target) || parameterByHome(target);
  if(!p) return [];
  return controlMappings.filter(record => record._targetId===p.id || record.targetHome===p.home)
    .map(record=>cloneControlMapping(record,true));
}
function controlMappingKinds(target){
  return [...new Set(controlMappingsFor(target).map(record=>record.kind))];
}
function addControlMapping(spec,opts){
  const record=normaliseControlMapping(spec);
  const next=controlMappings.concat(record);
  commitControlMappings('Create '+record.kind+' shortcut',next,opts);
  return cloneControlMapping(record,true);
}
function updateControlMapping(id,patch,opts){
  const index=controlMappings.findIndex(record=>record.id===String(id));
  if(index<0) return null;
  const next=controlMappings.map(record=>cloneControlMapping(record));
  next[index]=normaliseControlMapping(Object.assign({},patch,{id:String(id)}),next[index]);
  commitControlMappings('Edit '+next[index].kind+' shortcut',next,opts);
  return cloneControlMapping(next[index],true);
}
function removeControlMapping(id,opts){
  const record=controlMappings.find(item=>item.id===String(id)); if(!record) return false;
  return commitControlMappings('Clear '+record.kind+' shortcut',
    controlMappings.filter(item=>item!==record),opts);
}
function clearControlMappings(filter,opts){
  filter=filter || {};
  const kind=filter.kind && controlKind(filter.kind), targetHome=filter.targetHome;
  const next=controlMappings.filter(record => !((!kind || record.kind===kind) &&
    (!targetHome || record.targetHome===targetHome)));
  return commitControlMappings('Clear shortcuts',next,opts);
}
function duplicateControlMapping(id,opts){
  const found=controlMappings.find(record=>record.id===String(id)); if(!found) return null;
  const copy=cloneControlMapping(found); copy.id=nextControlMappingId();
  const index=controlMappings.indexOf(found)+1, next=controlMappings.slice(); next.splice(index,0,copy);
  commitControlMappings('Duplicate shortcut',next,opts);
  return cloneControlMapping(copy,true);
}
function retargetControlMappingParameter(p,nextHome){
  if(!p || !nextHome || p.home===nextHome) return;
  controlMappings.forEach(record => {
    if(record._targetId===p.id){
      const oldHome=record.targetHome;
      record.targetHome=nextHome;
      if(record.kind==='osc'){
        if(record.address===oldHome) record.address=nextHome;
        if(record.outputAddress===oldHome) record.outputAddress=nextHome;
      }
    }
  });
}
function controlTargets(){
  const out=[];
  REG.forEach(p => {
    if(!isControlMappingTarget(p)) return;
    out.push({home:p.home,name:p.name,type:p.type,min:p.min,max:p.max,
      mappings:controlMappingKinds(p)});
  });
  return out.sort((a,b)=>a.home.localeCompare(b.home));
}
function mappingMatches(record,input){
  if(record.kind==='keyboard'){
    const code=String(input.code || ''), key=String(input.key || '').toLowerCase();
    if(record.code ? record.code!==code : String(record.key||'').toLowerCase()!==key) return false;
    return !!record.ctrl===!!input.ctrlKey && !!record.shift===!!input.shiftKey &&
      !!record.alt===!!input.altKey && !!record.meta===!!input.metaKey;
  }
  if(record.kind==='midi'){
    if(input.direction && String(input.direction).toLowerCase()!=='in') return false;
    const type=String(input.type || '').toLowerCase();
    const family=type==='noteon'||type==='noteoff' ? 'note' : type;
    return family===record.message && +input.channel===record.channel &&
      (record.message==='pitchbend' || +input.number===record.number) &&
      (!record.deviceId || record.deviceId===String(input.deviceId || ''));
  }
  if(record.kind==='osc') return record.address===String(input.address || input.path || '');
  if(record.kind==='dmx') return +input.universe===record.universe && +input.channel===record.channel;
  return false;
}
function controlInputValue(record,input){
  if(record.kind==='keyboard') return input.phase==='up' ? 0 : 1;
  if(record.kind==='midi'){
    const type=String(input.type || '').toLowerCase();
    if(type==='noteoff') return 0;
    if(record.message==='pitchbend')
      return clamp((((+input.value||0)<<7)|(+input.number||0))/16383,0,1);
    return clamp((+input.value||+input.velocity||0)/127,0,1);
  }
  if(record.kind==='dmx'){
    const max=record.width16 ? 65535 : 255;
    return clamp((+input.value||0)/max,0,1);
  }
  return clamp(+input.value||0,0,1);
}
function applyControlMapping(record,input){
  const p=mappingTarget(record); if(!p) return false;
  const phase=String(input.phase || '').toLowerCase();
  if(record.kind==='keyboard' && input.repeat &&
     !['absolute','button','value'].includes(record.mode)) return false;
  let raw=controlInputValue(record,input), current=normalised(p), next=raw, invertAfter=true;
  if(record.mode==='toggle'){
    if(raw<=0 || phase==='up') return false;
    next=current>=.5 ? 0 : 1;
  } else if(record.mode==='button' || record.mode==='value') next=raw;
  else if(record.mode==='relative'){
    const midi=+input.value||0, delta=record.kind==='midi'
      ? (midi===64?0:(midi<64?midi:-(128-midi)))*record.step : (raw-.5)*record.step;
    next=current+(record.invert?-delta:delta); invertAfter=false;
  } else if(record.mode==='increment' || record.mode==='select-next'){
    if(raw<=0 || phase==='up') return false;
    next=current+(p.type==='choice'&&p.options ? 1/Math.max(1,p.options.length-1) : (record.step||1/127));
  } else if(record.mode==='decrement' || record.mode==='select-previous'){
    if(raw<=0 || phase==='up') return false;
    next=current-(p.type==='choice'&&p.options ? 1/Math.max(1,p.options.length-1) : (record.step||1/127));
  } else if(record.mode==='random'){
    if(raw<=0 || phase==='up') return false; next=Math.random();
  }
  next=clamp(next,0,1); if(record.invert&&invertAfter) next=1-next;
  next=record.min+next*(record.max-record.min);
  if(p.type==='event') return next>0 && triggerEvent(p);
  applyNormalised(p,next,{noUndo:true});
  return true;
}
function applyControlInput(kind,input){
  kind=controlKind(kind); input=input || {}; let applied=0;
  controlMappings.forEach(record => {
    if(record.kind===kind && mappingMatches(record,input) && applyControlMapping(record,input)) applied++;
  });
  /* OSC is already a public address space. Even without an explicit output
     shortcut, writing a Parameter's exact home controls it directly. */
  if(kind==='osc' && !applied){
    const p=parameterByHome(input.address || input.path);
    if(p && !p.transient){
      if(p.type==='event') applied=triggerEvent(p) ? 1 : 0;
      else if(p.type==='string'){
        setParam(p,String(input.value == null ? '' : input.value),{noUndo:true}); applied=1;
      } else if(p.type==='choice' && typeof input.value==='string' &&
                Array.isArray(p.options) && p.options.includes(input.value)){
        setParam(p,input.value,{noUndo:true}); applied=1;
      } else if(isControlMappingTarget(p)){
        applyNormalised(p,clamp(+input.value||0,0,1),{noUndo:true}); applied=1;
      }
    }
  }
  return applied;
}

/* --- typed values accept arithmetic, per parameters.htm "Math" ------------ */
function evalNumeric(text, fallback){
  const s = String(text).trim();
  if(/^-?[\d.]+$/.test(s)) return parseFloat(s);
  if(!/^[-+*/(). \d]+$/.test(s)) return fallback;       // digits and operators only
  try { const r = Function('"use strict";return (' + s + ')')(); return Number.isFinite(r) ? r : fallback; }
  catch { return fallback; }
}

/* --- undo ---------------------------------------------------------------- */
const undoStack = [], redoStack = [];
// PDF views are runtime resources. History may restore a removed Clip, so keep
// its view valid until the owning Composition and its Undo graph are retired.
const documentPresentationPlayers = new Set();
let undoGroup = null;
function pushUndo(p, from, to){
  const e = {id:p.id, from, to, label:p.home || p.name};
  if(undoGroup) undoGroup.push(e); else { undoStack.push([e]); redoStack.length = 0; }
  if(undoStack.length > 200) undoStack.shift();
}
/* A pointer drag can update a Range Parameter hundreds of times. Resolume
   treats that whole drag as one gesture, so intermediate frames deliberately
   use setParam(..., {noUndo:true}) and only the final value is recorded here.
   Keeping this contract in the engine also lets Dashboard dials and future
   MIDI/OSC editors share it instead of each inventing an undo workaround. */
function beginParamGesture(id, label){
  const p = typeof id === 'object' ? id : REG.get(+id);
  if(!p || p.type === 'event') return null;
  return {p, id:p.id, from:cloneEffectValue(p.value), label:label || p.home || p.name};
}
function endParamGesture(gesture){
  if(!gesture || !gesture.p || gesture.p.id !== gesture.id) return false;
  const p=gesture.p, to=cloneEffectValue(p.value);
  if(sameParameterStates(gesture.from,to)) return false;
  if(p.transient) return false;
  const e={id:p.id,from:gesture.from,to,label:gesture.label || p.home || p.name};
  if(undoGroup) undoGroup.push(e);
  else {
    const g=[e]; g.label=e.label;
    undoStack.push(g); redoStack.length=0;
    if(undoStack.length>200) undoStack.shift();
  }
  return true;
}
/* Structural edits cannot be represented as a parameter's before/after value.
   Keep them in the same gesture groups as parameter edits, but give the record
   explicit inverse operations. */
function pushStructuralUndo(label, undoFn, redoFn){
  const e = {label, undo:undoFn, redo:redoFn};
  if(undoGroup) undoGroup.push(e);
  else {
    const g = [e]; g.label = label;
    undoStack.push(g); redoStack.length = 0;
    if(undoStack.length > 200) undoStack.shift();
  }
}

/* Async resources (capture devices today) need lease semantics around Undo.
   A device open can still be pending when its Clip is cleared, then the same
   device can be restored before that promise settles. Starting a second open
   in that window races two streams, while releasing the first by device id can
   accidentally stop the second. Keep one in-flight acquisition per key and
   release it only after the last owner has gone away. This remains DOM-free;
   app.js supplies the real getUserMedia-backed acquire/release functions. */
function createResourceLeasePool(acquireResource, releaseResource){
  if(typeof acquireResource !== 'function') throw new TypeError('acquireResource must be a function');
  if(typeof releaseResource !== 'function') throw new TypeError('releaseResource must be a function');
  const entries = new Map();

  function releaseEntry(key, entry){
    if(entries.get(key) !== entry || entry.owners.size || !entry.settled) return false;
    entries.delete(key);
    try { releaseResource(key, entry.resource); } catch(e){ /* release is best-effort */ }
    return true;
  }

  function acquire(key, owner){
    if(owner == null) throw new TypeError('resource lease owner is required');
    let entry = entries.get(key);
    if(!entry){
      entry = {owners:new Set(), settled:false, resource:null, promise:null};
      entries.set(key, entry);
      let requested;
      /* Call synchronously: getDisplayMedia requires transient user activation,
         which would be lost if acquisition were deferred to a microtask. */
      try { requested = acquireResource(key); }
      catch(error){ requested = Promise.reject(error); }
      entry.promise = Promise.resolve(requested).then(resource => {
        entry.settled = true;
        entry.resource = resource;
        releaseEntry(key, entry);       // abandoned while the open was pending
        return resource;
      }, error => {
        if(entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    }
    entry.owners.add(owner);
    return entry.settled ? Promise.resolve(entry.resource) : entry.promise;
  }

  function release(key, owner){
    const entry = entries.get(key);
    if(!entry || !entry.owners.delete(owner)) return false;
    releaseEntry(key, entry);
    /* A pending, now-unowned entry deliberately stays in the map. A quick Undo
       can claim that same promise instead of opening a competing stream. */
    return true;
  }

  return {acquire, release};
}

/* Serialize asynchronous user gestures per destination without making
   unrelated destinations wait for each other. A rejected operation is still
   observed by its caller, but it cannot poison the tail and prevent the next
   gesture for that destination from running. This is used by app.js for
   Source opens (per Slot) and Effect inserts (per scope + track). */
function createSerialCommitQueue(){
  const tails = new Map();
  function enqueue(key, task){
    if(typeof task !== 'function') return Promise.reject(new TypeError('serial commit task must be a function'));
    const previous = tails.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    tails.set(key, run);
    const clear = () => { if(tails.get(key) === run) tails.delete(key); };
    run.then(clear, clear);
    return run;
  }
  return {
    enqueue,
    pending:key => tails.has(key),
    size:() => tails.size
  };
}
function transaction(label, fn){
  const prev = undoGroup; undoGroup = [];
  try { batch(fn); } finally {
    const g = undoGroup; undoGroup = prev;
    if(g.length){ g.label = label; if(prev) prev.push(...g); else { undoStack.push(g); redoStack.length = 0; } }
  }
}
const groupLabel = g => g.label || (g[0] && (REG.get(g[0].id)||{}).name) || 'change';
function undo(){
  const g = undoStack.pop(); if(!g) return null;
  const label = groupLabel(g);
  batch(() => [...g].reverse().forEach(e => {
    if(e.undo) e.undo(); else setParam(e.id, e.from, {noUndo:1});
  }));
  redoStack.push(g); return label;
}
function redo(){
  const g = redoStack.pop(); if(!g) return null;
  const label = groupLabel(g);
  batch(() => g.forEach(e => {
    if(e.redo) e.redo(); else setParam(e.id, e.to, {noUndo:1});
  }));
  undoStack.push(g); return label;
}

/* A ParamColor's inline preset palette is parameter state too. The picker
   reads `p.palette` as CSS hex strings, while preset files carry packed engine
   colour words. Keep the conversion and the undo record here so applying a
   factory preset remains one gesture even when only its palette changed. */
function paletteHex(value){
  if(value == null || value === '') return '';
  if(typeof value === 'number' && Number.isFinite(value)){
    const c=colorParts(value), rgb=colorHex(value).toUpperCase();
    /* Six-digit picker swatches intentionally inherit the current color's
       alpha. A numeric/XML palette entry is a complete packed ARGB value,
       so retain a non-opaque alpha explicitly as #RRGGBBAA. */
    return c.a===255 ? rgb : rgb+c.a.toString(16).padStart(2,'0').toUpperCase();
  }
  const text = String(value).trim();
  if(/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if(/^(?:0x)?[0-9a-f]{8}$/i.test(text))
    return colorHex(parseInt(text.replace(/^0x/i, ''), 16)).toUpperCase();
  return text;
}
function paletteWord(value, alpha){
  if(value == null || value === '') return null;
  if(typeof value === 'number' && Number.isFinite(value)) return Number(value) >>> 0;
  const text=String(value).trim();
  let match=/^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if(match){
    const rgb=parseInt(match[1],16), a=match[2]?parseInt(match[2],16)
      : (Number.isFinite(+alpha) ? clamp(Math.round(+alpha),0,255) : 255);
    return colorWord((rgb>>>16)&255,(rgb>>>8)&255,rgb&255,a);
  }
  match=/^(?:0x)?([0-9a-f]{8})$/i.exec(text);
  return match ? (parseInt(match[1],16) >>> 0) : null;
}
function paletteState(p){
  return {
    hasPalette: Object.prototype.hasOwnProperty.call(p, 'palette'),
    palette: Array.isArray(p.palette) ? p.palette.slice() : [],
    hasEnabled: Object.prototype.hasOwnProperty.call(p, 'paletteEnabled'),
    enabled: p.paletteEnabled
  };
}
function samePaletteState(a, b){
  return a.hasPalette === b.hasPalette && a.hasEnabled === b.hasEnabled &&
    a.enabled === b.enabled && a.palette.length === b.palette.length &&
    a.palette.every((value, i) => value === b.palette[i]);
}
function restorePaletteState(p, state, silent){
  if(state.hasPalette) p.palette = state.palette.slice(); else delete p.palette;
  if(state.hasEnabled) p.paletteEnabled = state.enabled; else delete p.paletteEnabled;
  if(!silent) notify(p);
}
function setPalette(id, colors, opts){
  const p = typeof id === 'object' ? id : REG.get(+id);
  if(!p) return false;
  opts = opts || {};
  const from = paletteState(p);
  const to = {
    hasPalette: true,
    palette: Array.from(colors || [], paletteHex),
    hasEnabled: from.hasEnabled,
    enabled: from.enabled
  };
  if(Object.prototype.hasOwnProperty.call(opts, 'enabled')){
    to.hasEnabled = true;
    to.enabled = !!opts.enabled;
  }
  if(samePaletteState(from, to)) return false;
  restorePaletteState(p, to, !!opts.silent);
  if(!opts.noUndo && !p.transient) pushStructuralUndo(opts.label || 'Set palette',
    () => restorePaletteState(p, from, false),
    () => restorePaletteState(p, to, false));
  return true;
}

/* Applying a preset is one user gesture even though it can replace dozens of
   values, range windows, palettes and animation graphs. A normal transaction
   can group setParam() calls, but animation/range metadata is not itself a
   Parameter value. Capture the complete mutable Parameter state so Undo puts
   the instance back exactly as it was instead of leaving the preset's
   animation running over an old value.

   Runtime identity and relationships are deliberately excluded. Presets do
   not replace OSC addresses, owners, callbacks or Dashboard links. */
const PARAM_STATE_RUNTIME_KEYS = new Set([
  'id','home','owner','key','onset','dash','path','group','transient','_eventPulse'
]);
const PARAM_STATE_POISON_KEYS = new Set(['__proto__','constructor','prototype']);
const PARAM_ANIMATION_RUNTIME_KEYS = new Set([
  '_v','_randomElapsed','_cleared','_eventHigh','_started'
]);
function snapshotParameterState(p){
  if(!p) return null;
  const state = {};
  Object.keys(p).forEach(key => {
    if(key !== 'name' && !PARAM_STATE_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key))
      state[key] = cloneEffectValue(p[key]);
  });
  const snapshot={name:p.name, state};
  if(p.path) snapshot.path=p.path;
  if(p.group) snapshot.group=p.group;
  return snapshot;
}
function restoreParameterState(p, snapshot, silent){
  if(!p || !snapshot) return p;
  if(!ticking && clock.lastT !== null && isTransportBoundary(p)) tick(performance.now());
  const saved = snapshot.state || {};
  Object.keys(p).forEach(key => {
    if(key !== 'name' && !PARAM_STATE_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key) &&
       !Object.prototype.hasOwnProperty.call(saved,key)) delete p[key];
  });
  Object.keys(saved).forEach(key => {
    if(!PARAM_STATE_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key))
      {
        const value=cloneEffectValue(saved[key]);
        if(key === 'anim' && value && typeof value === 'object')
          PARAM_ANIMATION_RUNTIME_KEYS.forEach(runtimeKey => delete value[runtimeKey]);
        p[key] = value;
      }
  });
  if(p.anim) p.anim._started=performance.now();
  if(!silent) notify(p);
  return p;
}
function sameParameterStates(a,b){
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch(error){ return false; }
}
function editParameterState(label, params, edit){
  const unique=[];
  (params || []).forEach(p => { if(p && !unique.includes(p)) unique.push(p); });
  if(!unique.length || typeof edit !== 'function') return false;
  const before=unique.map(snapshotParameterState);
  /* A Parameter's animation mode and its Dashboard source are selected from
     the same cogwheel menu. Changing one can therefore change both the
     Parameter state and a dial's structural link. Collect any structural
     records made by the edit in the same Undo group instead of leaving a
     half-animation/half-Dashboard state that needs two Ctrl+Z presses. */
  const parentGroup=undoGroup, editGroup=[];
  undoGroup=editGroup;
  try { batch(() => edit({noUndo:true})); }
  catch(error){
    batch(() => {
      [...editGroup].reverse().forEach(record => { if(record.undo) record.undo(); });
      unique.forEach((p,i)=>restoreParameterState(p,before[i],false));
    });
    undoGroup=parentGroup;
    throw error;
  }
  const after=unique.map(snapshotParameterState);
  const parameterChanged=!sameParameterStates(before,after);
  if(parameterChanged && !unique.every(p=>p.transient))
    editGroup.push({label:label || 'Apply preset',
      undo:() => batch(() => unique.forEach((p,i)=>restoreParameterState(p,before[i],false))),
      redo:() => batch(() => unique.forEach((p,i)=>restoreParameterState(p,after[i],false)))});
  undoGroup=parentGroup;
  if(!editGroup.length) return parameterChanged;
  if(parentGroup) parentGroup.push(...editGroup);
  else {
    editGroup.label=label || groupLabel(editGroup);
    undoStack.push(editGroup); redoStack.length=0;
    if(undoStack.length > 200) undoStack.shift();
  }
  return true;
}

/* =========================================================================
   2. SHARED SUB-STRUCTURES
   The manual repeats the same blocks at several levels — Common, Audio,
   Video, Transform, Autopilot, Dashboard. Building them from one factory is
   what makes a group behave like "a hybrid between a little sub composition
   and a layer" (groups.htm) without duplicating logic.
   ========================================================================= */
function audioBlock(home){
  return {
    volume: P({home:home+'/audio/volume', name:'Volume', type:'range', min:0, max:1, value:0.8}),
    pan:    P({home:home+'/audio/pan',    name:'Pan',    type:'range', min:-1, max:1, value:0}),
    /* OpenLive's OBS-inspired Audio Mixer needs a real latch rather than
       destroying Volume when Mute is pressed. Keeping it as a Parameter makes
       mute saveable, undoable and addressable by the normal control surfaces. */
    muted:  P({home:home+'/audio/mute',   name:'Mute',   type:'bool', value:false}),
    effects: []
  };
}
function videoBlock(home, opts){
  opts = opts || {};
  const maxDimension=Number(opts.maxDimension)>0?Math.round(Number(opts.maxDimension)):16384;
  const initialWidth=Number(opts.width)>0
    ? clamp(Math.round(Number(opts.width)),1,maxDimension) : 1920;
  const initialHeight=Number(opts.height)>0
    ? clamp(Math.round(Number(opts.height)),1,maxDimension) : 1080;
  const b = {
    opacity: P({home:home+'/video/opacity', name:'Opacity', type:'range', min:0, max:1, value:1}),
    blend:   P({home:home+'/video/blend',   name:'Blend Mode', type:'choice',
                options:allBlends(), value:opts.blend || 'Add'}),
    width:   P({home:home+'/video/width',   name:'Width',  type:'number', min:1, max:maxDimension, value:initialWidth}),
    height:  P({home:home+'/video/height',  name:'Height', type:'number', min:1, max:maxDimension, value:initialHeight}),
    effects: []
  };
  if(opts.autosize) b.autosize = P({home:home+'/video/autosize', name:'Auto Size', type:'choice',
                                    options:window.AUTO_SIZE, value:'Off'});
  return b;
}
/* transform.htm — "automatically applied to each clip, layer and group as well
   as to the entire composition", and the first one can never be deleted. */
function transformBlock(home){
  const px  = (k,n) => P({home:home+'/transform/'+k, name:n, type:'number', min:-16384, max:16384, value:0, unit:' px'});
  const deg = (k,n) => P({home:home+'/transform/'+k, name:n, type:'number', min:-360, max:360, value:0, unit:' °'});
  const scl = (k,n) => P({home:home+'/transform/'+k, name:n, type:'range', min:0, max:4, value:1, unit:'%', disp:100});
  return {
    fixed:true, name:'Transform',
    posX: px('x','Position X'),   posY: px('y','Position Y'),
    scale: scl('scale','Scale'),  scaleX: scl('scalex','Scale Width'), scaleY: scl('scaley','Scale Height'),
    rot: deg('rot','Rotation'),   rotX: deg('rotx','Rotation X'),      rotY: deg('roty','Rotation Y'),
    anchorX: px('ax','Anchor X'), anchorY: px('ay','Anchor Y')
  };
}
/* autopilot.htm — the option sets differ per level, so the factory takes them. */
function autopilotBlock(home, level){
  const durations = level === 'clip'
    ? ['Clip Transport','Seconds','Beats']
    : level === 'layer'
      ? ['Clip Transport','Seconds','Beats']
      : ['Longest Clip','Shortest Clip','Top Clip','Bottom Clip','Seconds','Beats'];
  const b = {
    direction: P({home:home+'/autopilot/direction', name:'Direction', type:'choice',
                  options:['Off','Forward','Backward','Random'], value:'Off'}),
    random:    P({home:home+'/autopilot/random', name:'Random', type:'choice',
                  options:window.AUTOPILOT_RANDOM, value:'Other'}),
    duration:  P({home:home+'/autopilot/duration', name:'Duration', type:'choice',
                  options:durations, value:durations[0]}),
    seconds:   P({home:home+'/autopilot/seconds', name:'Seconds', type:'number', min:0.1, max:600, value:8}),
    beats:     P({home:home+'/autopilot/beats', name:'Beats', type:'number', min:1, max:256, value:16}),
    loop:      P({home:home+'/autopilot/loop', name:'Loop', type:'bool', value:true})
  };
  if(level === 'clip' || level === 'column'){
    b.action = P({home:home+'/autopilot/action', name:'Action', type:'choice',
      options:[DETERMINED_LAYER,'Do Nothing','Play Next','Play Previous','Play Random',
               'Play First','Play Last','Play Specific'], value:DETERMINED_LAYER});
    b.specific = P({home:home+'/autopilot/specific', name:'Target', type:'number', min:1, max:64, value:1});
  }
  if(level === 'clip')   b.loops = P({home:home+'/autopilot/loops', name:'Loops', type:'number', min:1, max:64, value:1});
  if(level === 'layer')  b.loops = P({home:home+'/autopilot/loops', name:'Loops', type:'number', min:1, max:64, value:1});
  if(level === 'group' || level === 'comp')
    b.masterlayer = P({home:home+'/autopilot/masterlayer', name:'Master Layer', type:'choice',
                       options:['None'], value:'None'});
  b._runtime = {t0:0, beats0:0, bag:[]};
  b.direction.onset=(value,from)=>{
    if(from === 'Off' && value !== 'Off'){
      b._runtime.t0=0;
      b._runtime.beats0=clock.beats;
    }
  };
  return b;
}
/* dashboard.htm — eight dials, each holding any number of parameter links. */
function dashboardBlock(home){
  return Array.from({length:8}, (_,i) => ({
    index: i+1,
    name: P({home:`${home}/dashboard/${i+1}/name`, name:'Name', type:'string', value:'Dial '+(i+1)}),
    value:P({home:`${home}/dashboard/${i+1}`, name:'Dial '+(i+1), type:'range', min:0, max:1, value:0,
             onset:v => driveDial(home, i, v)}),
    links: []       // {paramId, inPoint, outPoint, invert, dialMin, dialMax}
  }));
}

function allBlends(){
  return [...(window.BLEND_MODES||['Add']), ...(window.BLEND_50||[]),
          ...(window.BLEND_TRANSITIONS||[]), ...(window.BLEND_CREATIVE||[])];
}

/* =========================================================================
   3. THE DOCUMENT
   ========================================================================= */
const doc = {
  comp: null, groups: [], layers: [], columns: [], decks: [], deck: 0,
  selection: {layer:null, clip:null, column:null, group:null, panel:'pLayer'}
};

function buildComposition(){
  const home = '/composition';
  const c = {
    kind:'composition', home,
    name:   P({home:home+'/name', name:'Name', type:'string', value:'Untitled'}),
    description: P({home:home+'/description', name:'Description', type:'string', value:''}),
    /* composition.htm > Composition Settings. The REST schema exposes the
       Composition VideoTrack Width/Height Parameters but does not publish
       Frame Rate or Bit Depth, so those two addresses are an offline-model
       convention rather than a claimed Arena REST address. Keeping them as
       Parameters still gives the settings transaction the same Undo,
       notification and portable-document contract as Name and Size. */
    framerate: P({home:home+'/framerate', name:'Frame Rate', type:'choice',
                  options:COMPOSITION_FRAME_RATES.slice(), value:'Auto'}),
    bitdepth: P({home:home+'/bitdepth', name:'Bit Depth', type:'choice',
                 options:COMPOSITION_BIT_DEPTHS.slice(), value:8}),
    master: P({home:home+'/master', name:'Master', type:'range', min:0, max:1, value:1}),
    speed:  P({home:home+'/speed',  name:'Speed',  type:'range', min:0, max:4, value:1}),
    bypassed:P({home:home+'/bypassed', name:'Bypassed', type:'bool', value:false}),
    audio:  audioBlock(home),
    video:  videoBlock(home, {blend:'Alpha'}),
    /* composition.htm > Crossfader */
    crossfader: {
      phase:     P({home:home+'/crossfader/phase', name:'Phase', type:'range', min:0, max:1, value:0}),
      blend:     P({home:home+'/crossfader/blend', name:'Blend Mode', type:'choice', options:allBlends(), value:'Alpha'}),
      behaviour: P({home:home+'/crossfader/behaviour', name:'Behaviour', type:'choice',
                    options:window.XFADER_BEHAVIOUR, value:'Jump'}),
      curve:     P({home:home+'/crossfader/curve', name:'Curve', type:'choice',
                    options:window.XFADER_CURVE, value:'Linear'}),
      /* Button behaviour is runtime gesture state, not Composition data.
         composition.htm: Jump latches immediately; Jump & Return toggles
         back on the next press; Cut returns on release; Fade (Legacy) takes
         four beats.  The historical local label "Cut & Return" is accepted
         below as an alias, but is never a different algorithm. */
      _runtime: {returnPhase:null, toggleSide:null, heldSide:null, fade:null}
    },
    /* bpm.htm */
    tempo: {
      bpm:    P({home:home+'/tempo/bpm', name:'BPM', type:'number', min:20, max:500, value:120}),
      state:  P({home:home+'/tempo/state', name:'Play State', type:'choice',
                 options:['Playing','Paused','Stopped'], value:'Playing'}),
      metro:  P({home:home+'/tempo/metronome', name:'Metronome', type:'bool', value:false}),
      link:   P({home:home+'/tempo/link', name:'Ableton Link', type:'bool', value:false})
    },
    /* composition.htm > Trigger Options — the top of every inheritance chain */
    trigger: {
      beatsnap: P({home:home+'/trigger/beatsnap', name:'Beat Snap', type:'choice',
                   options:window.BEAT_SNAP, value:'None'}),
      target:   P({home:home+'/trigger/target', name:'Clip Target', type:'choice',
                   options:['Own Layer','Active Layer','Free Layer'], value:'Own Layer'}),
      style:    P({home:home+'/trigger/style', name:'Trigger Style', type:'choice',
                   options:window.TRIGGER_STYLES, value:'Normal'}),
      transport:P({home:home+'/trigger/transport', name:'Global Transport', type:'choice',
                   options:window.GLOBAL_TRANSPORT, value:'BPM Sync & Timeline'}),
      firstcolumn:P({home:home+'/trigger/firstcolumn',
                     name:'Trigger First Column On Play', type:'bool', value:false}),
      direction:P({home:home+'/trigger/direction', name:'Direction', type:'choice',
                   options:window.DIRECTIONS, value:'Forwards'})
    },
    autopilot: autopilotBlock(home, 'comp'),
    dashboard: dashboardBlock(home),
    transform: transformBlock(home),
    fft: {gain: P({home:home+'/fft/gain', name:'FFT Gain', type:'range', min:0, max:4, value:1})}
  };
  return c;
}

/* Composition Settings is one modal confirmation and therefore one Undo
   gesture. Validate every supplied field before touching the document: an
   invalid Height must not leave a new Name behind. Width/Height are the
   Composition render size only; Layer/Clip VideoTrack dimensions, their reset
   defaults and Advanced Output Screen dimensions are distinct objects and
   deliberately untouched. (composition.htm, layers.htm) */
function normaliseCompositionFrameRate(value){
  if(value == null || value === '' || String(value).toLowerCase() === 'auto') return 'Auto';
  const numeric=Number(value);
  return COMPOSITION_FRAME_RATES.includes(numeric) ? numeric : null;
}
function normaliseCompositionBitDepth(value){
  const numeric=Number(value);
  return COMPOSITION_BIT_DEPTHS.includes(numeric) ? numeric : null;
}
function compositionSettings(){
  const c=doc.comp;
  return c ? {
    name:String(val(c.name) == null ? '' : val(c.name)),
    description:String(val(c.description) == null ? '' : val(c.description)),
    width:Math.round(Number(val(c.video.width)) || 1),
    height:Math.round(Number(val(c.video.height)) || 1),
    frameRate:val(c.framerate),
    bitDepth:val(c.bitdepth)
  } : null;
}
function setCompositionSettings(next, opts){
  if(!doc.comp) throw new Error('Composition is not initialised');
  if(!next || typeof next !== 'object') throw new TypeError('Composition settings must be an object');
  opts=opts || {};
  const c=doc.comp, values={};
  const has=key => Object.prototype.hasOwnProperty.call(next,key);
  if(has('name')) values.name=String(next.name == null ? '' : next.name).slice(0,1000000);
  if(has('description')) values.description=String(next.description == null ? '' : next.description).slice(0,1000000);
  ['width','height'].forEach(key => {
    if(!has(key)) return;
    const numeric=Number(next[key]);
    if(!Number.isFinite(numeric) || numeric < 1 || numeric > 16384)
      throw new RangeError('Composition '+key+' must be between 1 and 16384 pixels');
    values[key]=Math.round(numeric);
  });
  if(has('frameRate') || has('framerate')){
    const value=normaliseCompositionFrameRate(has('frameRate') ? next.frameRate : next.framerate);
    if(value == null) throw new RangeError('Unsupported Composition frame rate');
    values.frameRate=value;
  }
  if(has('bitDepth') || has('bitdepth')){
    const value=normaliseCompositionBitDepth(has('bitDepth') ? next.bitDepth : next.bitdepth);
    if(value == null) throw new RangeError('Composition bit depth must be 8 or 16');
    if(!COMPOSITION_SUPPORTED_BIT_DEPTHS.includes(value) && !opts.allowUnsupportedBitDepth)
      throw new RangeError('16-bpc Composition rendering is not supported by the Canvas2D renderer; use 8-bpc');
    values.bitDepth=value;
  }
  const writes=[
    ['name',c.name],['description',c.description],['width',c.video.width],
    ['height',c.video.height],['frameRate',c.framerate],['bitDepth',c.bitdepth]
  ].filter(([key]) => Object.prototype.hasOwnProperty.call(values,key));
  const changed=writes.some(([key,param]) => val(param) !== values[key]);
  if(!changed) return compositionSettings();
  const apply=() => writes.forEach(([key,param]) => setParam(param,values[key],{noUndo:!!opts.noUndo}));
  if(opts.noUndo) batch(apply); else transaction(opts.label || 'Composition settings',apply);
  return compositionSettings();
}
function compositionFrameInterval(){
  if(!doc.comp) return 0;
  const rate=normaliseCompositionFrameRate(val(doc.comp.framerate));
  return rate === 'Auto' || rate == null ? 0 : 1000/rate;
}

/* COLOUR CODING IS A PARAMETER, not a CSS string on the side.
   Measured in reference/compositions/ as
     <ParamChoice name="ColorId" T="INT32" default="0" value="N" storeChoices="0"/>
   on Composition/Deck/Column (36), Composition/Layer (4) and
   Composition/Deck/Clip (1); arena-live.js subscribes to `colorid` on decks,
   columns, layers, clips AND groups, so all five scopes carry it in the real
   application even though layers.htm and groups.htm never mention colour.

   0 is "no colour" and 1-5 are Arena's five swatches — exactly COLOR_SWATCHES'
   indices, so the UI index and the stored value are the same number. Modelled
   with P() rather than a bare field so it inherits the whole parameter
   contract at the address Arena itself uses, /composition/<scope>/N/colorid:
   right-click to reset, undo, MIDI/OSC/DMX mapping. [parameters.htm]

   The options are INTEGERS, not the strings a choice parameter usually holds:
   the file declares T="INT32" and the parser hands back a number, so string
   options silently rejected every value loaded from disk — setParam(p, 3) left
   it at 0 while setParam(p, '3') worked. The file's own type wins. */
const COLOR_IDS = [0, 1, 2, 3, 4, 5];
function colorParam(home){
  return P({home:home+'/colorid', name:'Color', type:'choice', options:COLOR_IDS, value:0});
}

/* One factory for Decks, so New / Insert / Duplicate build them through the
   same path init() does - the shape Layers and Columns already follow with
   buildLayer/buildColumn.
   `closed` stays a PLAIN BOOLEAN and is deliberately not a Parameter: Close is
   not mappable, not animatable and has no right-click reset, so wrapping it in
   P() would advertise a contract it does not honour. */
function buildDeck(index, name){
  const home = '/composition/decks/' + index;
  return {
    kind:'deck', index, home, closed:false,
    colorid: colorParam(home),
    name: P({home:home+'/name', name:'Name', type:'string',
             value: name == null ? 'Deck ' + index : String(name)}),
    clips: new Map()
  };
}

function buildLayer(index){
  const home = '/composition/layers/' + index;
  /* UNDOCUMENTED - inferring: a new Layer begins at the current Composition
     raster. Width/Height remain ordinary independent Parameters after creation. */
  const compositionWidth=doc.comp&&doc.comp.video ? val(doc.comp.video.width) : 1920;
  const compositionHeight=doc.comp&&doc.comp.video ? val(doc.comp.video.height) : 1080;
  return {
    kind:'layer', index, home, group:null, folded:false,
    /* SHOWAVE's audiovisual and GSL5 lighting engines share the cue grid, but
       they do not share a Layer.  The first real Clip assigns the Layer's
       content domain; keeping that assignment on the Layer makes every empty
       Slot in the row honest and prevents a later media drop from silently
       turning a lighting executor into a video mixer (or vice versa). */
    contentDomain:'unassigned',
    colorid: colorParam(home),
    name:     P({home:home+'/name', name:'Name', type:'string', value:'Layer #'}),
    master:   P({home:home+'/master', name:'Master', type:'range', min:0, max:1, value:1}),
    bypassed: P({home:home+'/bypassed', name:'Bypassed', type:'bool', value:false}),
    solo:     P({home:home+'/solo', name:'Solo', type:'bool', value:false}),
    /* composition.htm > Crossfader: "You assign layers to a bus, by toggling
       the A or B buttons to the right of the layer's name." */
    crossfadergroup: P({home:home+'/crossfadergroup', name:'Crossfader Group', type:'choice',
                        options:window.CROSSFADER_GROUPS, value:'None'}),
    /* layers.htm > Mask Layer */
    maskmode: P({home:home+'/maskmode', name:'Mask Mode', type:'choice',
                 options:window.MASK_MODES, value:'Disabled'}),
    lock:     P({home:home+'/lock', name:'Lock Content', type:'bool', value:false}),
    /* layers.htm > Trigger Options — inheritable downward to clips */
    ignorecolumn: P({home:home+'/ignorecolumntrigger', name:'Ignore Column Trigger', type:'bool', value:false}),
    faderstart:   P({home:home+'/faderstart', name:'Fader Start', type:'bool', value:false}),
    triggerfirst: P({home:home+'/triggerfirstclip', name:'Trigger first clip on play', type:'bool', value:false}),
    audio: audioBlock(home),
    video: videoBlock(home, {blend:'Add', autosize:true,
      width:compositionWidth,height:compositionHeight}),
    /* layers.htm > Layer Transition */
    transition: {
      blend:    P({home:home+'/transition/blend', name:'Blend Mode', type:'choice',
                   options:[...allBlends(),'Random'], value:'Alpha'}),
      duration: P({home:home+'/transition/duration', name:'Duration', type:'number',
                   min:0, max:10, value:0, multiplier:1, precision:3})
    },
    autopilot: autopilotBlock(home, 'layer'),
    dashboard: dashboardBlock(home),
    transform: transformBlock(home),
    /* runtime */
    playing: null,     // {clip, started, position, transitionFrom, transitionFromPos, transitionT}
    _lastOpacity: 1
  };
}

function buildGroup(index){
  const home = '/composition/groups/' + index;
  return {
    kind:'group', index, home, folded:false, layers:[],
    colorid: colorParam(home),
    name:     P({home:home+'/name', name:'Name', type:'string', value:'Group #'}),
    master:   P({home:home+'/master', name:'Master', type:'range', min:0, max:1, value:1}),
    speed:    P({home:home+'/speed', name:'Speed', type:'range', min:0, max:4, value:1}),
    bypassed: P({home:home+'/bypassed', name:'Bypassed', type:'bool', value:false}),
    solo:     P({home:home+'/solo', name:'Solo', type:'bool', value:false}),
    crossfadergroup: P({home:home+'/crossfadergroup', name:'Crossfader Group', type:'choice',
                        options:window.CROSSFADER_GROUPS, value:'None'}),
    ignorecolumn: P({home:home+'/ignorecolumntrigger', name:'Ignore Column Trigger', type:'bool', value:false}),
    lock:     P({home:home+'/lock', name:'Lock Content', type:'bool', value:false}),
    audio: audioBlock(home),
    /* groups.htm — "Groups default to Alpha blend mode with 100% opacity." */
    video: videoBlock(home, {blend:'Alpha'}),
    autopilot: autopilotBlock(home, 'group'),
    dashboard: dashboardBlock(home),
    transform: transformBlock(home)
  };
}

function buildColumn(index){
  const home = '/composition/columns/' + index;
  return {
    kind:'column', index, home, colorid: colorParam(home),
    name: P({home:home+'/name', name:'Name', type:'string', value:'Column #'}),
    connected: P({home:home+'/connected', name:'Connect', type:'event', value:0}),
    /* A Column is itself a quantised trigger surface. The live REST schema
       exposes `/columns/#/beatsnap`, and Arena's menu gives it the same
       Composition Determined + Beat Snap choices as a Clip. Keeping it on the
       Column (instead of borrowing the first Clip's setting) is what lets the
       whole vertical trigger fire on one musical boundary. */
    trigger: {
      /* OSC/REST address shape is /composition/columns/{1-based}/beatsnap;
         `trigger` is the JS anatomy only and must not leak into the address. */
      beatsnap: P({home:home+'/beatsnap', name:'Beat Snap', type:'choice',
                   options:[DETERMINED_COMP, ...window.BEAT_SNAP], value:DETERMINED_COMP})
    },
    autopilot: autopilotBlock(home, 'column')
  };
}

function buildClip(layerIndex, column, deck, name){
  const home = `/composition/decks/${deck}/layers/${layerIndex}/clips/${column}`;
  const filled = !!name;
  const k = {
    kind:'clip', home, layer:layerIndex, column, deck, filled,
    colorid: colorParam(home),
    name: P({home:home+'/name', name:'Name', type:'string', value:name || ''}),
    persistent: P({home:home+'/persistent', name:'Persistent', type:'bool', value:false}),
    /* video.htm > Playback */
    transport: {
      mode:      P({home:home+'/transport/mode', name:'Transport', type:'choice',
                    options:window.TRANSPORTS, value:'Timeline'}),
      position:  P({home:home+'/transport/position', name:'Position', type:'range', min:0, max:1, value:0}),
      speed:     P({home:home+'/transport/speed', name:'Speed', type:'range', min:0, max:10, value:1}),
      duration:  P({home:home+'/transport/duration', name:'Duration', type:'number', min:0.1, max:3600,
                    value:4 + (hashName(name) % 24)}),
      beats:     P({home:home+'/transport/beats', name:'Beats', type:'number', min:1, max:512, value:16}),
      direction: P({home:home+'/transport/direction', name:'Direction', type:'choice',
                    options:window.DIRECTIONS, value:'Forwards'}),
      playmode:  P({home:home+'/transport/playmode', name:'Play Mode', type:'choice',
                    options:window.PLAY_MODES, value:'Loop'}),
      away:      P({home:home+'/transport/away', name:'Playmode Away', type:'choice',
                    options:['Play from start','Pick-up','Relative pick-up'], value:'Play from start'}),
      inpoint:   P({home:home+'/transport/in', name:'In', type:'range', min:0, max:1, value:0}),
      outpoint:  P({home:home+'/transport/out', name:'Out', type:'range', min:0, max:1, value:1}),
      beatloop:  P({home:home+'/transport/beatloop', name:'Beat Loop', type:'choice',
                    options:['Off','1/8','1/4','1/2','1','2','4','8','16'], value:'Off'}),
      catchup:   P({home:home+'/transport/catchup', name:'Catch Up', type:'bool', value:true}),
      cues: Array.from({length:8}, (_,i) =>
        P({home:home+'/transport/cue/'+(i+1), name:'Cue '+(i+1), type:'number', min:0, max:1, value:-1}))
    },
    /* clips.htm > Trigger Settings — every one of these can defer upward */
    trigger: {
      beatsnap: P({home:home+'/trigger/beatsnap', name:'Beat Snap', type:'choice',
                   options:[DETERMINED_COMP, ...window.BEAT_SNAP], value:DETERMINED_COMP}),
      target:   P({home:home+'/trigger/target', name:'Clip Target', type:'choice',
                   options:[DETERMINED_COMP,'Own Layer','Active Layer','Free Layer'], value:DETERMINED_COMP}),
      style:    P({home:home+'/trigger/style', name:'Trigger Style', type:'choice',
                   options:[DETERMINED_COMP, ...window.TRIGGER_STYLES], value:DETERMINED_COMP}),
      faderstart:   P({home:home+'/trigger/faderstart', name:'Fader Start', type:'choice',
                       options:window.FADER_START, value:DETERMINED_LAYER}),
      ignorecolumn: P({home:home+'/trigger/ignorecolumn', name:'Ignore Column Trigger', type:'choice',
                       options:window.IGNORE_COL, value:DETERMINED_LAYER})
    },
    audio: Object.assign(audioBlock(home), {present:false, _presentDeclared:false}),
    video: (() => {
      /* Native decoding rejects geometry beyond 32768 rather than silently
         shrinking it. Clip Width/Height must therefore preserve every raster
         the decoder accepts; Composition/Layer allocations retain 16K caps. */
      const v = videoBlock(home, {blend:'Alpha',maxDimension:32768});
      v.alphatype = P({home:home+'/video/alpha', name:'Alpha Type', type:'choice',
                       options:['Premultiplied','Straight'], value:'Premultiplied'});
      v.r = P({home:home+'/video/r', name:'R', type:'bool', value:true});
      v.g = P({home:home+'/video/g', name:'G', type:'bool', value:true});
      v.b = P({home:home+'/video/b', name:'B', type:'bool', value:true});
      v.a = P({home:home+'/video/a', name:'A', type:'bool', value:true});
      /* clips.htm > Video Properties: Resize is a one-shot button. Repeated
         presses cycle Fill / Fit / Stretch / Original, and the manual is
         explicit that this is "not a setting that stays fixed". Keep one
         addressable Event so Keyboard/MIDI/OSC/DMX can press the same control;
         Width/Height are the only persistent result. `options` describes the
         action cycle for the UI, not a selected Choice state. */
      v.resize = P({home:home+'/video/resize', name:'Resize', type:'event', value:0,
                    options:window.RESIZE_MODES.slice(), action:true});
      /* clips.htm: a clip blend "will override whatever blend mode you have
         selected on the layer, for as long as this clip is playing" — but only
         when the user actually picks one, hence the sentinel default. */
      v.blend.options = [DETERMINED_LAYER, ...allBlends()];
      v.blend.value = v.blend.def = DETERMINED_LAYER;
      /* Clip track existence is content state, not a Parameter. Seeded names
         predate media discovery, so this is deliberately an inferred value
         until replaceClipContent() declares the real tracks. */
      v.present = filled;
      v._presentDeclared = false;
      return v;
    })(),
    transition: {
      blend:    P({home:home+'/transition/blend', name:'Blend Mode', type:'choice',
                   options:[DETERMINED_LAYER, ...allBlends(),'Random'], value:DETERMINED_LAYER}),
      duration: P({home:home+'/transition/duration', name:'Duration', type:'choice',
                   options:[DETERMINED_LAYER,'Custom'], value:DETERMINED_LAYER}),
      seconds:  P({home:home+'/transition/seconds', name:'Seconds', type:'number', min:0, max:10, value:0})
    },
    autopilot: autopilotBlock(home, 'clip'),
    dashboard: dashboardBlock(home),
    transform: transformBlock(home),
    info: {codec:'DXV3', fps:30, bpm:128},
    /* Portable tombstone used when a saved live input cannot carry its
       MediaStream/permission across a reload. It is content state, not a fake
       stream, and disappears as soon as real Source/media/live content wins. */
    unavailableLive: null
  };
  /* Runtime ownership lets app.js apply MIDI/OSC/DMX/keyboard writes to this
     one-shot action without parsing a structural address. `owner` is excluded
     from Parameter snapshots and therefore cannot make documents recursive. */
  k.video.resize.owner=k;
  return k;
}
function hashName(s){ let h = 9; for(const c of String(s||'')) h = Math.imul(h ^ c.charCodeAt(0), 387420489); return h >>> 0; }

/* --- initial document ----------------------------------------------------- */
/* Rebuilding a Composition is a destructive engine operation. Retire every
   resource-owning Clip before dropping the old graph, then clear all identity
   and history that was meaningful only inside that graph. Event subscribers
   deliberately survive: the UI subscribes once for the lifetime of the page. */
function disposeDocument(){
  const seen = new Set();
  (doc.decks || []).forEach(deck => {
    if(!deck || !deck.clips || typeof deck.clips.values !== 'function') return;
    for(const k of deck.clips.values()){
      if(!k || seen.has(k)) continue;
      seen.add(k);
      if(typeof k.onRelease === 'function'){
        try { k.onRelease(k, clipContentStateOf(k)); } catch(error){ /* best effort */ }
      }
      sourceParamsOn(k.source, false);
    }
  });
  for(const player of documentPresentationPlayers){try{player.release?.();}catch(_){}}
  documentPresentationPlayers.clear();
  /* Keep ids monotonic for the lifetime of the page. REG is cleared, but an
     external control can still hold an old number; reusing it would silently
     retarget that stale control at an unrelated Parameter in the new file. */
  REG.clear();
  controlMappings=[]; controlMappingSerial=1;
  undoStack.length = 0; redoStack.length = 0; undoGroup = null;
  pending.length = 0;
  dirty = new Set();
  fxClipboard = null;
  doc.comp = null; doc.groups = []; doc.layers = []; doc.columns = [];
  doc.decks = []; doc.deck = 0;
  Object.assign(doc.selection,
    {layer:null, clip:null, column:null, group:null, panel:'pLayer'});
}

function init(opts){
  opts = opts || {};
  disposeDocument();
  /* A new Show opens with 4 Layers and 16 Columns. Arena's own default is 3
     and 8; this is a SHOWAVE house default, not a parity value, chosen for
     the size of show this is actually used for. Callers that pass explicit
     counts - including every test - are unaffected. */
  const nLayers = opts.layers || 4, nCols = opts.columns || 16;
  const layerIndexes = Array.isArray(opts.layerIndexes) && opts.layerIndexes.length
    ? opts.layerIndexes.slice() : Array.from({length:nLayers}, (_,i) => i + 1);
  const columnIndexes = Array.isArray(opts.columnIndexes) && opts.columnIndexes.length
    ? opts.columnIndexes.slice() : Array.from({length:nCols}, (_,i) => i + 1);
  const deckDefs = Array.isArray(opts.decks) && opts.decks.length
    ? opts.decks.map((deck, i) => typeof deck === 'string' ? {name:deck} :
        {name:String((deck && deck.name) || ('Deck ' + (i + 1)))})
    : (window.DECKS || [{name:'Deck 1'}]);
  doc.comp = buildComposition();
  /* A newly opened Composition owns a fresh global clock. Keeping beats,
     nudge and the previous rAF timestamp from the file that was just closed
     made the first tick of a new show inherit the old transport phase. */
  clock.beats = 0; clock.lastT = null; clock.nudge = 0; clock.taps = [];
  clock.transportState = 'Playing';
  doc.layers = layerIndexes.map(buildLayer);
  doc.columns = columnIndexes.map(buildColumn);
  doc.decks = deckDefs.map((d,i) => buildDeck(i+1, d.name));
  /* seed clips from the demo content table, one row per layer, per deck.
     Composition import passes seed:false and receives the same complete Slot
     topology without demo media leaking into the restored document. */
  const NAMES = window.CLIP_NAMES || [[]];
  doc.decks.forEach((deck, di) => {
    doc.layers.forEach(L => {
      const row = NAMES[(L.index - 1 + di) % NAMES.length] || [];
      columnIndexes.forEach((c, ci) => {
        const nm = opts.seed === false ? '' : (row[ci % row.length] || '');
        deck.clips.set(key(L.index, c), buildClip(L.index, c, di + 1, nm));
      });
    });
  });
  doc.selection.layer = doc.layers[doc.layers.length - 1] || null;
  refreshMasterLayerOptions();
  /* Identity changes even when the replacement has identical topology. This
     synchronous token lets address books invalidate without notifying midway
     through restoreCompositionState(), which hydrates values after init(). */
  documentGeneration++;
  return API;
}

/* init() is also restoreCompositionState()'s construction scaffold, so it must
   remain silent by default. A caller that has completed a standalone document
   replacement (Composition > New) uses this explicit commit point to wake
   lifetime subscribers exactly once, after the new graph is fully usable. */
function publishDocument(){
  if(!doc.comp || !doc.comp.master) return false;
  notify(doc.comp.master);
  return true;
}
const key = (l,c) => l + ':' + c;

function clip(l, c, deckIndex){
  const d = doc.decks[(deckIndex == null ? doc.deck : deckIndex)];
  if(!d) return null;
  const own = d.clips.get(key(l,c));
  /* clips.htm > Persistent Clips: "these persistent clips will be loaded in the
     same slot in every deck you switch to." The covered clip stays reachable. */
  for(const other of doc.decks){
    if(other === d) continue;
    const p = other.clips.get(key(l,c));
    if(p && p.filled && val(p.persistent)) return Object.assign(Object.create(p), {covers: own});
  }
  return own;
}
const layer  = n => doc.layers.find(L => L.index === n) || null;
const column = c => doc.columns.find(C => C.index === c) || null;
const columnIndexOf = ref => ref && ref.kind === 'column' ? ref.index : (+ref || 1);
/* Column selection is an inspector concern since 7.22. Performance navigation
   and container Autopilot follow the connected Column when one exists, then
   fall back to selection for a freshly opened Composition. */
function connectedColumnIndex(){
  const connected=doc.columns.find(C => !!val(C.connected));
  return connected ? connected.index : columnIndexOf(doc.selection.column);
}
/* Group Cues have their own performance cursor. A private Layer override must
   not move it, and another Group/Composition must not supply its next step. */
function containerColumnIndex(node){
  return node && node.kind === 'group' && column(node._connectedColumn)
    ? node._connectedColumn : connectedColumnIndex();
}

/* display name with # replaced by stack position (layers.htm > Rename) */
function displayName(node){
  const raw = String(val(node.name) ?? '');
  const pos = node.kind === 'layer' ? stackPosition(node) : node.index;
  return raw.replace(/#/g, pos);
}
function stackPosition(L){ return doc.layers.indexOf(L) + 1; }

/* =========================================================================
   4. INHERITANCE
   The single most-repeated relationship in the manual. A clip says
   "Composition Determined" or "Layer Determined"; we walk until something
   commits to a value.
   ========================================================================= */
function groupOf(L){ return L && L.group ? doc.groups.find(g => g.index === L.group) : null; }
function groupFrom(ref){
  if(ref && ref.kind === 'group') return doc.groups.includes(ref) ? ref : null;
  const index=typeof ref === 'number' ? ref : ref && ref.index;
  return doc.groups.find(g => g.index === +index) || null;
}
function groupMembers(ref){
  const g=groupFrom(ref); if(!g) return [];
  const wanted=new Set(g.layers||[]);
  return doc.layers.filter(L => L.group===g.index && wanted.has(L.index));
}

function resolve(node, path){
  let cur = node, seen = 0;
  while(cur && seen++ < 8){
    const p = at(cur, path);
    if(p){
      const v = val(p);
      if(v !== DETERMINED_COMP && v !== DETERMINED_LAYER) return {value:v, from:cur, param:p};
      /* explicit sentinel: jump to the level it names */
      cur = v === DETERMINED_COMP ? doc.comp : (parentOf(cur) || doc.comp);
      continue;
    }
    cur = parentOf(cur);
  }
  return {value:undefined, from:null, param:null};
}
function parentOf(node){
  if(!node) return null;
  if(node.kind === 'clip')  return layer(node.layer);
  if(node.kind === 'layer') return groupOf(node) || doc.comp;
  if(node.kind === 'group') return doc.comp;
  if(node.kind === 'column') return doc.comp;
  return null;
}
function at(node, path){
  return path.split('.').reduce((o,k) => (o && o[k] != null ? o[k] : null), node);
}
/* Booleans that live as plain bool on layer/group but as a tri-state on clips. */
function resolveFlag(node, clipPath, nodePath){
  if(node && node.kind === 'clip'){
    const v = val(at(node, clipPath));
    if(v === 'On')  return true;
    if(v === 'Off') return false;
    node = layer(node.layer);
  }
  while(node){
    const p = at(node, nodePath);
    if(p) return !!val(p);
    node = parentOf(node);
  }
  return false;
}

/* =========================================================================
   5. CLOCK — bpm.htm
   Beats, bars and phrases, plus the quantise queue that Beat Snap feeds.
   ========================================================================= */
const clock = {
  beats: 0, lastT: null, nudge: 0, taps: [], running: true,
  transportState:'Playing',
  bar(){ return Math.floor(this.beats / 4); },
  phrase(){ return Math.floor(this.beats / 32); },
  beatPhase(){ return this.beats - Math.floor(this.beats); },
  barPhase(){ return (this.beats % 4) / 4; },
  bpm(){ return val(doc.comp.tempo.bpm) + this.nudge; }
};
const pending = [];                                   // quantised triggers
let ticking = false;

function isTransportBoundary(p){
  const home=p.home || '';
  if(/^\/composition\/tempo\/(state|bpm)$/.test(home) ||
     home === '/composition/trigger/transport') return true;
  if(/^\/composition(?:\/groups\/\d+)?\/speed$/.test(home))
    return doc.layers.some(L=>L.playing);
  if(/\/transport\/(mode|direction|speed|duration|beats|playmode|in|out)$/.test(home))
    return doc.layers.some(L=>L.playing && Object.values(L.playing.clip.transport).includes(p));
  if(/\/autopilot\/(direction|duration|seconds|beats|loops)$/.test(home))
    return [doc.comp,...doc.groups,...doc.layers].some(node=>node && Object.values(node.autopilot).includes(p));
  return false;
}

/* The caller intentionally suspends this model while controlling an external
   Arena. Rebase that explicit ownership boundary without charging offline
   Clips for the time spent elsewhere. A hidden local tab still follows wall
   time when its next tick arrives. */
function rebaseClock(now){
  now=now == null ? performance.now() : +now;
  if(!Number.isFinite(now) || now < 0) return false;
  if(clock.lastT !== null && now < clock.lastT) return false;
  clock.lastT=now;
  return true;
}

function frameElapsedSince(started, dt, now){
  return Number.isFinite(started) ? Math.min(dt,Math.max(0,(now-started)/1000)) : dt;
}

/* Phase arithmetic reaches an exact edge through several floating point
   additions. Snap only sub-nanophase rounding, so a true terminal crossing
   cannot be deferred by 0.9999999999999999. */
const completedPeriods=(distance,span)=>Math.floor(distance/span+1e-9);
function periodRemainder(distance,span){
  const remainder=((distance%span)+span)%span;
  return remainder < span*1e-9 || span-remainder < span*1e-9 ? 0 : remainder;
}

const SNAP_BEATS = {'None':0, '1/4 Bar':1, '1/2 Bar':2, '1 Bar':4, '2 Bars':8, '4 Bars':16, '8 Bars':32};

function tap(){
  const now = performance.now();
  clock.taps = clock.taps.filter(t => now - t < 2500).concat(now);
  if(clock.taps.length >= 3){
    const gaps = clock.taps.slice(1).map((t,i) => t - clock.taps[i]);
    const avg = gaps.reduce((a,b) => a+b, 0) / gaps.length;
    setParam(doc.comp.tempo.bpm, clamp(Math.round(60000 / avg), 20, 500));
  }
}
/* link.htm — "When using Link, the Resync and Pause buttons for the BPM are
   disabled. It's considered bad musical practice..." */
function linkActive(){ return !!val(doc.comp.tempo.link); }
function resync(){
  if(linkActive()) return false;
  if(!ticking && clock.lastT !== null) tick(performance.now());
  clock.beats = 0;
  resetAutopilotBeatOrigins();
  return true;
}
function resetAutopilotBeatOrigins(){
  [doc.comp,...doc.groups,...doc.layers].forEach(node=>{
    if(node && node.autopilot) node.autopilot._runtime.beats0=0;
  });
}
function nudge(d){
  if(!ticking && clock.lastT !== null) tick(performance.now());
  clock.nudge = d;
}

function tick(now){
  now=+now;
  if(ticking || !Number.isFinite(now) || now < 0 ||
     (clock.lastT !== null && now < clock.lastT)) return 0;
  const dt = clock.lastT === null ? 0 : (now - clock.lastT) / 1000;
  clock.lastT = now;
  ticking=true;
  try {
  const state = val(doc.comp.tempo.state);
  const previousState = clock.transportState;
  if(state !== previousState) applyGlobalTransportState(state, previousState);
  clock.transportState = state;
  const beatsBefore = clock.beats;
  if(state === 'Playing') clock.beats += dt * clock.bpm() / 60;
  const beatDelta = clock.beats - beatsBefore;
  /* Global Transport controls whether Pause/Stop owns Timeline transports as
     well as BPM Sync. BPM Sync always follows the beat clock; Timeline keeps
     running only in the legacy "BPM Sync Only" mode. */
  /* The legacy BPM-Sync-only mode lets Timeline transports keep running while
     the global clock is PAUSED. Stop is stronger: it ejects the show and must
     remain stopped until Play is pressed again. Treating Stopped like Paused
     let a Seconds Autopilot repopulate a Column on the very next tick. */
  const timelineDt = state === 'Playing' ||
    (state === 'Paused' && val(doc.comp.trigger.transport) === 'BPM Sync Only') ? dt : 0;

  batch(() => {
    flushPending();
    advanceCrossfaderFade(beatDelta, dt, now);
    const clipAutopilotPlans = advanceClips(timelineDt, beatDelta, dt, now);
    /* Stop owns the entire transport. In particular, do not let an already-due
       Clip-Transport/Seconds Autopilot undo applyGlobalTransportState()'s
       eject in the same frame. */
    if(state !== 'Stopped') runAutopilots(timelineDt, clipAutopilotPlans);
    runAnimations(timelineDt, null, {beats:clock.beats, beatDelta, bpm:clock.bpm(), fft,
      frameDt:dt, now});
    applyFaderStart();
  });
  return dt;
  } finally { ticking=false; }
}

/* Global Stop rewinds clocks/animations and ejects playing Clips. On the next
   Play, Layers with Trigger First Clip enabled start their first populated
   Slot. Keeping this in the engine makes the Composition Play State Parameter
   behave the same from the panel, OSC, MIDI and the toolbar. */
function applyGlobalTransportState(state, previous){
  if(state === 'Stopped'){
    clock.beats = 0;
    resetAutopilotBeatOrigins();
    pending.length = 0;
    doc.layers.forEach(L => { if(!layerContentLocked(L)) L.playing = null; });
    REG.forEach(p => {
      const a=p && p.anim;
      if(!a || (a.mode !== 'Timeline' && a.mode !== 'BPM Sync')) return;
      a.phase = a.direction === 'Backwards' ? 1 : 0;
      a.running = true; a._randomElapsed = 0; a._cleared = false;
    });
    if(doc.comp && doc.comp.crossfader && doc.comp.crossfader._runtime)
      doc.comp.crossfader._runtime.fade = null;
    return;
  }
  if(state === 'Playing' && previous === 'Stopped'){
    /* UNDOCUMENTED — inferred from the documented Layer-level "Trigger First
       Clip" transport gesture. Composition owns one Column trigger, rather
       than independently retriggering Column 1 on every Layer. Run it first:
       eligible Layers become occupied, while ignored/empty Layers remain
       available for their existing first-populated-Clip rule below. */
    if(val(doc.comp.trigger.firstcolumn)) triggerColumn(1,{immediate:true});
    doc.layers.forEach(L => {
      if(!val(L.triggerfirst) || L.playing || val(L.lock)) return;
      const first=doc.columns.map(C => clip(L.index,C.index))
        .find(k => k && k.filled);
      if(first) triggerClip(L.index,first.column,{immediate:true});
    });
  }
}

/* clips.htm > Beat Snap — "have clips wait until the next beat, the next bar,
   in 2 bars, in 4 bars and so on, before it starts." */
function snapBeats(node){
  const r = resolve(node, 'trigger.beatsnap');
  return SNAP_BEATS[r.value] || 0;
}
function cancelPendingScope(scope){
  if(!scope) return;
  for(let i=pending.length-1;i>=0;i--)
    if(pending[i].scope===scope) pending.splice(i,1);
}
function schedule(node, fn, scope){
  /* A newer gesture owns its target even when it is unsnapped. Cancelling
     before the immediate-return prevents an older armed Clip/Column from
     unexpectedly coming back on its original Beat Snap boundary. */
  cancelPendingScope(scope);
  if(!ticking && clock.lastT !== null) tick(performance.now());
  const q = snapBeats(node);
  if(!q || val(doc.comp.tempo.state) !== 'Playing'){ fn(); return null; }
  const due = Math.ceil((clock.beats + 1e-6) / q) * q;
  /* A performer can change their mind while waiting for the quantise
     boundary. Keep only the newest queued Clip for a target Layer and the
     newest queued Column for the Composition. Previously every click stayed
     queued and flushPending ran backwards, so the earliest click executed
     last and appeared to ignore/freeze later Clip or Column choices. */
  const e = {due, fn, node, scope:scope||null, queuedAt:clock.beats,
    span:Math.max(1e-9,due-clock.beats)};
  pending.push(e);
  return e;
}
function flushPending(){
  /* Execute due gestures in the order they were made, leaving the latest one
     as the final state when different scopes share a boundary. */
  for(let i=0;i<pending.length;){
    if(clock.beats >= pending[i].due){ const e=pending.splice(i,1)[0]; e.fn(); }
    else i++;
  }
}
const pendingFor = node => pending.filter(e => e.node === node);
/* The whole quantise queue, so the UI can show what is waiting. A snapped
   trigger does nothing for up to several seconds — clips.htm: "have clips wait
   until the next beat, the next bar, in 2 bars, in 4 bars and so on, before it
   starts" — and without a visible pending state that is indistinguishable from
   a click that missed. */
function pendingList(){
  return pending.map(e => ({
    kind: e.scope && e.scope.kind === 'group' ? 'group-column' :
      (e.node && e.node.kind === 'column' ? 'column' : 'clip'),
    group: e.scope && e.scope.kind === 'group' ? e.scope.index : null,
    layer: e.node && e.node.layer,
    column: e.node && (e.node.column != null ? e.node.column :
      (e.node.kind === 'column' ? e.node.index : null)),
    due: e.due,
    beatsAway: Math.max(0, e.due - clock.beats),
    progress: clamp(1-(Math.max(0,e.due-clock.beats)/(e.span||1)),0,1)
  }));
}

/* =========================================================================
   6. TRIGGERING — clips.htm
   ========================================================================= */
function targetLayer(k, sourceLayer){
  const mode = resolve(k, 'trigger.target').value;
  if(mode === 'Active Layer') return doc.selection.layer || sourceLayer;
  if(mode === 'Free Layer'){
    const free = doc.layers.find(L => !L.playing && !val(L.lock));
    return free || sourceLayer;
  }
  return sourceLayer;
}
function triggerStyle(k){ return resolve(k, 'trigger.style').value || 'Normal'; }

function triggerClip(l, c, opts){
  opts = opts || {};
  const k = clip(l, c); if(!k || !k.filled) return false;
  const L = targetLayer(k, layer(l)); if(!L) return false;
  const parentGroup=groupOf(L);
  /* layers.htm > Lock Content — "you cannot accidentally eject the current clip
     or trigger a different clip into this layer" */
  if((val(L.lock)||(parentGroup&&val(parentGroup.lock))) && L.playing && L.playing.clip !== k) return false;

  const style = triggerStyle(k);
  if(style === 'Toggle' && L.playing && L.playing.clip === k && !opts.fromColumn){ eject(L.index); return true; }

  const run = () => batch(() => {
    const prev = L.playing;
    const tDur = transitionDuration(k, L);
    L.playing = {
      clip: k, started: performance.now(), beats0: clock.beats,
      position: startPosition(k, prev),
      transitionFrom: tDur > 0 && prev ? prev.clip : null,
      /* the outgoing clip's transport stops at trigger time, so the frame it
         was on is frozen here for the painter to blend away from */
      transitionFromPos: tDur > 0 && prev ? prev.position : 0,
      transitionT: tDur > 0 && prev ? 0 : 1,
      transitionDur: tDur,
      transitionBlend: transitionBlend(k, L),
      loops: 0, piano: style === 'Piano'
    };
    /* parameter-animation.htm > Start Settings: layer params default to
       "composition load and clip trigger", clip params to "clip trigger". */
    restartAnimations(L, 'clip');
    restartAnimations(k, 'clip');
  });
  /* The Layer object is the stable scheduling identity. Its numeric index can
     change while a Clip waits (Layer reorder), but the armed target does not. */
  /* `immediate` is also the internal execution path for a snapped Column and
     for Autopilot. It must not erase an independently queued, later Clip
     gesture; only the public scheduling path owns queue replacement. */
  if(opts.immediate) run(); else schedule(k, run, L);
  return true;
}
/* video.htm > Playmode Away */
function startPosition(k, prev){
  const away = val(k.transport.away);
  if(away === 'Pick-up') return val(k.transport.position);
  if(away === 'Relative pick-up' && prev) return prev.position;
  return val(k.transport.inpoint);
}
function transitionDuration(k, L){
  const mode = val(k.transition.duration);
  if(mode === DETERMINED_LAYER) return val(L.transition.duration);
  return val(k.transition.seconds);
}
function transitionBlend(k, L){
  let b = val(k.transition.blend);
  if(b === DETERMINED_LAYER) b = val(L.transition.blend);
  if(b === 'Random'){
    /* Resolve exactly once into a transition this offline renderer can draw.
       The captured result then remains stable for the whole fade. */
    const all = (window.LOCAL_TRANSITION_MODES || ['Alpha'])
      .filter(name => name && name !== 'Random');
    return all[Math.floor(Math.random()*all.length)] || 'Alpha';
  }
  return b;
}

function releaseClip(l, c){                            // piano style key-up
  const L = layer(l);
  if(L && L.playing && L.playing.piano && L.playing.clip.column === c) eject(l);
}

/* clips.htm / layers.htm > Ignore Column Trigger, including the clip-level
   exception: "you can set a clip to trigger even if the layer's setting is
   Ignore to create exceptions." */
function respectsColumn(L, k){
  if(k){
    const v = val(k.trigger.ignorecolumn);
    if(v === 'On')  return false;
    if(v === 'Off') return true;
  }
  const g = groupOf(L);
  if(g && val(g.ignorecolumn)) return false;
  return !val(L.ignorecolumn);
}
function layerContentLocked(L){
  const g=groupOf(L);
  return !!(L&&(val(L.lock)||(g&&val(g.lock))));
}
function triggerColumn(c, opts){
  opts = opts || {};
  const C = column(+c); if(!C) return false;
  const run = () => batch(() => {
    let populated=false, started=false;
    const groupCues=new Map();
    doc.layers.forEach(L => {
      /* A snapped Column can be structurally reindexed while it waits. Resolve
         its current index from the stable Column object at execution time;
         the numeric index from the original click may now name another Slot. */
      const k = clip(L.index, C.index);
      if(!k || !k.filled){
        /* A Column is a complete vertical cue, not merely a list of the Slots
           which happen to contain media. Its empty Slot clears this Layer so a
           Clip moved to another Layer cannot keep rendering through a later
           Column trigger from its stale runtime reference. Ignore Column
           Trigger and Lock Content are the documented ways to keep a Layer
           playing across that cue. */
        if(respectsColumn(L,null) && !layerContentLocked(L)) {
          L.playing=null;
          const g=groupOf(L); if(g&&!groupCues.has(g)) groupCues.set(g,false);
        }
        return;
      }
      populated=true;
      if(!respectsColumn(L, k)) return;
      /* The Column owns the quantisation. Once its boundary arrives, every
         eligible Clip starts immediately; re-running each Clip's Beat Snap
         here would split one Column gesture across several boundaries. */
      const triggered=triggerClip(L.index, C.index, {fromColumn:true, immediate:true});
      if(triggered){const g=groupOf(L);if(g)groupCues.set(g,true);}
      started=triggered || started;
    });
    /* Column Power (Arena 7.22): an empty Column is the Composition-wide Stop
       Column. Keep locked Layers protected, exactly as Eject All does. */
    if(!populated) doc.layers.forEach(L => {
      if(!layerContentLocked(L)) {
        L.playing=null;
        const g=groupOf(L);if(g)groupCues.set(g,false);
      }
    });
    /* A real Composition cue also cues its affected Groups. Ignored/locked
       Groups keep their private cursor; more specific Layer cues never change
       either the Group cursor or the Composition connected Column. */
    groupCues.forEach((connected,g)=>{g._connectedColumn=connected?C.index:0;});
    /* Triggering is performance state, not an edit (undo.htm). */
    if(started || !populated)
      doc.columns.forEach(item => setParam(item.connected, started && item === C ? 1 : 0, {noUndo:true}));
  });
  if(opts.immediate) run(); else schedule(C, run, 'column');
  return true;
}
/* A Group Cue is the Group's own vertical trigger surface. It deliberately
   shares the Column's Beat Snap Parameter, while its scheduling scope is the
   stable Group object: two Groups may arm different Cues without cancelling
   each other or the Composition-wide Column gesture. Empty Slots clear only
   member Layers, and Group/Layer locks protect the same runtime state that an
   ordinary Layer trigger protects. */
function triggerGroupColumn(groupRef,c,opts){
  opts=opts||{};
  const g=groupFrom(groupRef), C=column(+c); if(!g||!C) return false;
  const members=groupMembers(g); if(!members.length) return false;
  const run=()=>batch(()=>{
    let populated=false,started=false;
    members.forEach(L=>{
      const k=clip(L.index,C.index);
      if(!k||!k.filled){
        if(respectsColumn(L,null)&&!val(g.lock)&&!val(L.lock)) L.playing=null;
        return;
      }
      populated=true;
      if(!respectsColumn(L,k)) return;
      if(val(g.lock)&&L.playing&&L.playing.clip!==k) return;
      started=triggerClip(L.index,C.index,{fromColumn:true,immediate:true})||started;
    });
    if(!populated&&!val(g.lock)) members.forEach(L=>{ if(!val(L.lock)) L.playing=null; });
    g._connectedColumn=started?C.index:0;
  });
  if(opts.immediate) run(); else schedule(C,run,g);
  return true;
}
function eject(l){
  const L = layer(l); if(!L) return;
  const g=groupOf(L);
  if(layerContentLocked(L)) return;
  transaction('Eject', () => { L.playing = null; });
}
function ejectGroup(groupRef){
  const g=groupFrom(groupRef); if(!g||val(g.lock)) return false;
  cancelPendingScope(g);
  batch(()=>groupMembers(g).forEach(L=>{ if(!val(L.lock)) L.playing=null; }));
  g._connectedColumn=0;
  return true;
}
function ejectAll(){ transaction('Eject all', () => doc.layers.forEach(L => { if(!layerContentLocked(L)) L.playing = null; })); }

/* layers.htm > Fader Start — "This will retrigger the current clip, every time
   you bring the opacity up." */
function applyFaderStart(){
  doc.layers.forEach(L => {
    const o = val(L.video.opacity), was = L._lastOpacity;
    L._lastOpacity = o;
    if(o > 0 && was === 0 && L.playing){
      const on = resolveFlag(L.playing.clip, 'trigger.faderstart', 'faderstart');
      if(on) L.playing.position = val(L.playing.clip.transport.inpoint);
    }
  });
}

/* =========================================================================
   7. CLIP TRANSPORT — video.htm
   ========================================================================= */
function clipLength(k){
  const mode = val(k.transport.mode);
  if(mode === 'BPM Sync') return val(k.transport.beats) * 60 / clock.bpm();
  return val(k.transport.duration);
}
function advanceClips(timelineDt, beatDelta, frameDt, now){
  const globalSpeed = val(doc.comp.speed);
  /* A Play Once & Clear Clip can finish on the same frame as Layer, Group and
     Composition Autopilots. Compute its Clip-level decision from the frame's
     original state now, but apply it after the lower-priority containers in
     runAutopilots(). This is how the documented priority remains deterministic
     instead of depending on function-call order. */
  const clipAutopilotPlans = [];
  doc.layers.forEach(L => {
    const pl = L.playing; if(!pl) return;
    const k = pl.clip;
    const since=frameElapsedSince(Number.isFinite(pl._transportT) ? pl._transportT : pl.started,frameDt,now);
    const clipDt=Math.min(timelineDt,since);
    const clipBeats=frameDt > 0 ? beatDelta * since / frameDt : 0;
    pl._transportT=now;
    if(pl.transitionT < 1 && pl.transitionDur > 0){
      pl.transitionT = Math.min(1, pl.transitionT + clipDt / pl.transitionDur);
      if(pl.transitionT >= 1){
        /* The outgoing Clip is runtime state only. Release it at the exact
           endpoint so Effect Clips, media decoders and save snapshots cannot
           keep treating an invisible predecessor as active. */
        pl.transitionFrom = null;
        pl.transitionFromPos = 0;
        pl.transitionDur = 0;
      }
    }

    const dir = val(k.transport.direction);
    if(dir === 'Paused') return;
    const bpmSync = val(k.transport.mode) === 'BPM Sync';
    /* composition.htm — "the global speed control has no effect on BPM-synced
       clips, as those are controlled by the master BPM clock instead." */
    const grp = groupOf(L);
    /* Group and Composition master speed are Timeline-only multipliers. BPM
       Sync follows the master clock and its quantised Clip speed modifier. */
    const speed = val(k.transport.speed) *
      (bpmSync ? 1 : globalSpeed * (grp ? val(grp.speed) : 1));
    const stepMagnitude = bpmSync
      ? ((+clipBeats || 0) / Math.max(1e-6,val(k.transport.beats))) * speed
      : (clipDt / Math.max(0.05,val(k.transport.duration))) * speed;
    let step = stepMagnitude * (dir === 'Backwards' ? -1 : 1);

    const inP = Math.min(val(k.transport.inpoint),val(k.transport.outpoint));
    const outP = Math.max(val(k.transport.inpoint),val(k.transport.outpoint));
    const span=outP-inP, loopsBefore=pl.loops || 0;
    let pos = pl.position + step;
    const mode = val(k.transport.playmode);
    let finished = false;

    if(span <= 1e-9){ pos=inP; }
    else if(stepMagnitude > 0 && mode === 'Bounce'){
      const start=clamp(pl.position,inP,outP);
      const distance=stepMagnitude;
      const first=dir === 'Backwards' ? start-inP : outP-start;
      const crossings=distance+span*1e-9 >= first ? 1+completedPeriods(distance-first,span) : 0;
      const phase=(start-inP)/span;
      const travel=(dir === 'Backwards' ? 2-phase : phase)+distance/span;
      let folded=periodRemainder(travel,2);
      if(Math.abs(folded-1)<1e-9) folded=1;
      pos=inP+(folded <= 1 ? folded : 2-folded)*span;
      if(crossings){
        pl.loops=loopsBefore+crossings;
        setParam(k.transport.direction,folded < 1 ? 'Forwards' : 'Backwards',{silent:1});
        finished=true;
      }
    }
    else if(step > 0 && pos+span*1e-9 >= outP){
      if(mode === 'Loop'){
        const distance=pos-inP;
        pl.loops=loopsBefore+completedPeriods(distance,span);
        pos=inP+periodRemainder(distance,span);
        finished=true;
      }
      else if(mode === 'Play Once & Clear'){
        L.playing = null;
        const next=nextClipAutopilotColumn(L,k);
        if(next!=null) clipAutopilotPlans.push({node:L,next,source:'clip'});
        return;
      }
      else if(mode === 'Play Once & Hold'){
        pos = outP; finished = !pl._held; pl._held=true;
      }
      else if(mode === 'Random'){ pos = inP + Math.random() * (outP - inP); }
      else { pos = inP; pl.loops++; finished = true; }
    } else if(pos <= inP+span*1e-9 && step < 0){
      if(mode === 'Loop'){
        const distance=outP-pos;
        pl.loops=loopsBefore+completedPeriods(distance,span);
        pos=outP-periodRemainder(distance,span);
      } else { pos = outP - (inP - pos); pl.loops++; }
      finished = true;
    }
    pl.position = clamp(pos, 0, 1);
    setParam(k.transport.position, pl.position, {silent:1, noUndo:1});
    if(finished){ pl.justLooped = true; pl.loopsBefore=loopsBefore; }
  });
  return clipAutopilotPlans;
}

/* =========================================================================
   8. AUTOPILOT — autopilot.htm
   Priority, per the manual: "The clip overrules the layer, the layer overrules
   the group and the group overrules the composition."
   ========================================================================= */
function apDue(node, ap, dt){
  const dur = val(ap.duration);
  const rt = ap._runtime;
  if(dur === 'Seconds'){
    rt.t0 += dt;
    const span=Math.max(0.1,val(ap.seconds));
    const periods=completedPeriods(rt.t0,span);
    if(periods > 0){ rt.t0=Math.max(0,rt.t0-periods*span); return true; }
    return false;
  }
  if(dur === 'Beats'){
    if(!Number.isFinite(rt.beats0) || rt.beats0 > clock.beats) rt.beats0 = clock.beats;
    const span=Math.max(1,val(ap.beats)), elapsed=clock.beats-rt.beats0;
    const periods=completedPeriods(elapsed,span);
    if(periods > 0){ rt.beats0 += periods*span; return true; }
    return false;
  }
  if(dur === 'Clip Transport'){
    if(node.kind === 'layer' && node.playing && node.playing.justLooped){
      node.playing.justLooped = false;
      const need = val(ap.loops || {value:1}) || 1;
      const loops=node.playing.loops, before=node.playing.loopsBefore;
      return Number.isFinite(before) && loops > before
        ? Math.floor(loops/need) > Math.floor(before/need)
        : loops % need === 0;
    }
    return false;
  }
  /* Longest/Shortest/Top/Bottom clip — composition and group only */
  const col = containerColumnIndex(node);
  const members = (node.kind === 'group' ? node.layers.map(layer) : doc.layers).filter(Boolean);
  const cand = members.map(L => clip(L.index, col)).filter(k => k && k.filled);
  if(!cand.length) return false;
  let ref = null;
  if(dur === 'Longest Clip')  ref = cand.reduce((a,b) => clipLength(b) > clipLength(a) ? b : a);
  if(dur === 'Shortest Clip') ref = cand.reduce((a,b) => clipLength(b) < clipLength(a) ? b : a);
  if(dur === 'Top Clip')      ref = cand[cand.length - 1];
  if(dur === 'Bottom Clip')   ref = cand[0];
  if(!ref) return false;
  rt.t0 += dt;
  const span=Math.max(0.05,clipLength(ref));
  const periods=completedPeriods(rt.t0,span);
  if(periods > 0){ rt.t0=Math.max(0,rt.t0-periods*span); return true; }
  return false;
}
function pickNext(list, current, dir, randomMode, rt){
  if(!list.length) return null;
  const i = list.indexOf(current);
  if(dir === 'Forward')  return list[(i + 1 + list.length) % list.length];
  if(dir === 'Backward') return list[(i - 1 + list.length) % list.length];
  if(dir === 'Random'){
    if(randomMode === 'Bag'){
      if(!rt.bag.length) rt.bag = list.slice().sort(() => Math.random() - 0.5);
      return rt.bag.pop();
    }
    let pick, guard = 0;
    do { pick = list[Math.floor(Math.random() * list.length)]; } while(randomMode === 'Other' && pick === current && list.length > 1 && guard++ < 20);
    return pick;
  }
  return null;
}
function nextClipAutopilotColumn(L, k){
  const ap = L.autopilot;
  const dir = val(ap.direction);
  if(dir === 'Off') return null;
  const cols = doc.columns.map(c => c.index).filter(c => { const q = clip(L.index, c); return q && q.filled; });
  if(!cols.length) return null;
  const cur = k ? k.column : null;

  /* clip action overrules the layer (autopilot.htm > Clip Actions) */
  let action = k ? val(k.autopilot.action) : DETERMINED_LAYER;
  if(action === 'Do Nothing') return null;
  let next = null;
  if(action === DETERMINED_LAYER) next = pickNext(cols, cur, dir, val(ap.random), ap._runtime);
  else if(action === 'Play Next')     next = cols[(cols.indexOf(cur) + 1) % cols.length];
  else if(action === 'Play Previous') next = cols[(cols.indexOf(cur) - 1 + cols.length) % cols.length];
  else if(action === 'Play Random')   next = pickNext(cols, cur, 'Random', val(ap.random), ap._runtime);
  else if(action === 'Play First')    next = cols[0];
  else if(action === 'Play Last')     next = cols[cols.length - 1];
  else if(action === 'Play Specific') next = val(k.autopilot.specific);
  if(next == null) return null;
  if(!val(ap.loop) && cols.indexOf(next) < cols.indexOf(cur)) return null;
  return next;
}
function runClipAutopilot(L, k){
  const next=nextClipAutopilotColumn(L,k);
  return next==null ? false : triggerClip(L.index,next,{immediate:true});
}
function containerAutopilotPlan(node, dt, layerPlans){
  const ap = node.autopilot;
  if(val(ap.direction) === 'Off') return null;
  /* autopilot.htm > Master Layer: "the autopilot will follow that layer" */
  const ml = ap.masterlayer && val(ap.masterlayer);
  if(ml && ml !== 'None'){
    const L = doc.layers.find(x => displayName(x) === ml);
    /* The Master Layer makes the container follow the Layer's ONE decision;
       it does not run that Layer's timer a second time. Reusing the precomputed
       plan also means a Composition and its Master Layer cannot advance twice
       on the same frame. Most importantly, the result is a Column plan for the
       whole container, not a private trigger on the named Layer. */
    if(L){
      const followed=layerPlans.get(L);
      return followed ? {node,next:followed.next,source:'master-layer'} : null;
    }
  }
  if(!apDue(node, ap, dt)) return null;
  const cols = doc.columns.map(c => c.index);
  const cur = containerColumnIndex(node);
  const C = column(cur);
  let next = null;
  const action = C ? val(C.autopilot.action) : DETERMINED_LAYER;
  if(action === 'Do Nothing') return null;
  if(action === DETERMINED_LAYER) next = pickNext(cols, cur, val(ap.direction), val(ap.random), ap._runtime);
  else if(action === 'Play Next')     next = cols[(cols.indexOf(cur) + 1) % cols.length];
  else if(action === 'Play Previous') next = cols[(cols.indexOf(cur) - 1 + cols.length) % cols.length];
  else if(action === 'Play Random')   next = pickNext(cols, cur, 'Random', val(ap.random), ap._runtime);
  else if(action === 'Play First')    next = cols[0];
  else if(action === 'Play Last')     next = cols[cols.length - 1];
  else if(action === 'Play Specific') next = val(C.autopilot.specific);
  if(next == null) return null;
  if(!val(ap.loop) && cols.indexOf(next) < cols.indexOf(cur)) return null;
  return {node,next,source:'container'};
}
function applyLayerAutopilotPlan(plan){
  if(!plan || !plan.node || plan.next==null) return false;
  const current=plan.node.playing && plan.node.playing.clip;
  /* A lower-priority container may already have put the Layer on this exact
     Slot. Do not retrigger it merely to express the same decision: retriggering
     would restart animations and make Master Layer followers appear to fire
     twice. */
  if(current && current.column===plan.next) return true;
  return triggerClip(plan.node.index,plan.next,{immediate:true});
}
function runAutopilots(dt, clipPlans){
  /* Evaluate every decision against the same pre-trigger frame. Then apply
     them from broadest to most specific so the documented priority is exact:
       Clip > Layer > Group > Composition.
     Computing and applying in one pass made the last function called win and
     also made a Layer calculate "next" from the Column just chosen by the
     Composition, rather than from the Column that was on air this frame. */
  const layerPlans=new Map();
  doc.layers.forEach(L => {
    const ap=L.autopilot;
    if(val(ap.direction)==='Off' || !apDue(L,ap,dt)) return;
    const next=nextClipAutopilotColumn(L,L.playing&&L.playing.clip);
    if(next!=null) layerPlans.set(L,{node:L,next,source:'layer'});
  });
  /* A Clip that just completed is the most specific Master Layer decision.
     Let a following container see it now, while the same Clip plan is still
     applied last below to preserve its priority over every container. */
  const masterPlans=new Map(layerPlans);
  (clipPlans||[]).forEach(plan=>masterPlans.set(plan.node,plan));
  const compositionPlan=containerAutopilotPlan(doc.comp,dt,masterPlans);
  const groupPlans=doc.groups.map(g=>containerAutopilotPlan(g,dt,masterPlans)).filter(Boolean);

  /* Composition first, then Group, then Layer. A Group is a sub-composition,
     so its Autopilot must use the same member-scoped Cue surface as the Group
     strip; routing it through triggerColumn() leaked into unrelated Layers. */
  if(compositionPlan) triggerColumn(compositionPlan.next);
  groupPlans.forEach(plan=>triggerGroupColumn(plan.node,plan.next));
  layerPlans.forEach(applyLayerAutopilotPlan);
  (clipPlans||[]).forEach(applyLayerAutopilotPlan);
}
function refreshMasterLayerOptions(){
  const names = ['None', ...doc.layers.map(displayName)];
  [doc.comp, ...doc.groups].forEach(n => {
    if(n.autopilot && n.autopilot.masterlayer) n.autopilot.masterlayer.options = names;
  });
}

/* =========================================================================
   9. PARAMETER ANIMATION — parameter-animation.htm + envelopes.htm
   ========================================================================= */
/* envelopes.htm names seven interpolation families and says each comes as In,
   Out and In/Out: "Quadratic, Sine, Circular and Exponential do basic easing at
   various strengths. Elastic, Back and Bounce let you do some of the harder to
   master principles of animation", plus Linear and "Hold simply holds the value
   of the previous keyframe until the current one is reached."

   That is 7 x 3 + 2 = 23. This table used to hold 15, missing the In/Out of
   four families and both ends of two — and Resolume's own shipped animation
   presets use Circular In/Out, Exponential In/Out and Back In/Out, so an
   envelope loaded from a preset silently fell back to Linear. */
const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1;
const C4 = (2*Math.PI)/3, C5 = (2*Math.PI)/4.5;
const bounceOut = t => { const n = 7.5625, d = 2.75;
  if(t < 1/d) return n*t*t;
  if(t < 2/d) return n*(t -= 1.5/d)*t + .75;
  if(t < 2.5/d) return n*(t -= 2.25/d)*t + .9375;
  return n*(t -= 2.625/d)*t + .984375; };

const EASINGS = {
  'Linear': t => t,

  'Quadratic In': t => t*t,
  'Quadratic Out': t => 1-(1-t)*(1-t),
  'Quadratic In/Out': t => t<.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2,

  'Sine In': t => 1-Math.cos(t*Math.PI/2),
  'Sine Out': t => Math.sin(t*Math.PI/2),
  'Sine In/Out': t => -(Math.cos(Math.PI*t)-1)/2,

  'Circular In': t => 1-Math.sqrt(1-t*t),
  'Circular Out': t => Math.sqrt(1-(t-1)*(t-1)),
  'Circular In/Out': t => t<.5
    ? (1-Math.sqrt(1-Math.pow(2*t,2)))/2
    : (Math.sqrt(1-Math.pow(-2*t+2,2))+1)/2,

  'Exponential In': t => t===0?0:Math.pow(2,10*t-10),
  'Exponential Out': t => t===1?1:1-Math.pow(2,-10*t),
  'Exponential In/Out': t => t===0?0 : t===1?1 : t<.5
    ? Math.pow(2,20*t-10)/2
    : (2-Math.pow(2,-20*t+10))/2,

  'Elastic In': t => t===0||t===1 ? t : -Math.pow(2,10*t-10)*Math.sin((t*10-10.75)*C4),
  'Elastic Out': t => t===0||t===1 ? t : Math.pow(2,-10*t)*Math.sin((t*10-.75)*C4)+1,
  'Elastic In/Out': t => t===0||t===1 ? t : t<.5
    ? -(Math.pow(2,20*t-10)*Math.sin((20*t-11.125)*C5))/2
    : (Math.pow(2,-20*t+10)*Math.sin((20*t-11.125)*C5))/2 + 1,

  'Back In': t => C3*t*t*t - C1*t*t,
  'Back Out': t => 1 + C3*Math.pow(t-1,3) + C1*Math.pow(t-1,2),
  'Back In/Out': t => t<.5
    ? (Math.pow(2*t,2)*((C2+1)*2*t - C2))/2
    : (Math.pow(2*t-2,2)*((C2+1)*(t*2-2) + C2) + 2)/2,

  'Bounce In': t => 1 - bounceOut(1-t),
  'Bounce Out': bounceOut,
  'Bounce In/Out': t => t<.5 ? (1-bounceOut(1-2*t))/2 : (1+bounceOut(2*t-1))/2,

  'Hold': () => 0
};
/* envelopes.htm — x-axis is phase, y-axis is the parameter value */
function newEnvelope(){
  return {points:[{phase:0, value:0, curve:'Linear'}, {phase:1, value:1, curve:'Linear'}]};
}
function envelopeAt(env, phase){
  if(!env || !env.points || env.points.length < 2) return phase;
  const pts = env.points.slice().sort((a,b) => a.phase - b.phase);
  if(phase <= pts[0].phase) return pts[0].value;
  if(phase >= pts[pts.length-1].phase) return pts[pts.length-1].value;
  for(let i = 1; i < pts.length; i++){
    if(phase <= pts[i].phase){
      const a = pts[i-1], b = pts[i];
      const t = (phase - a.phase) / ((b.phase - a.phase) || 1);
      const ease = EASINGS[b.curve] || EASINGS.Linear;
      return b.curve === 'Hold' ? a.value : a.value + (b.value - a.value) * ease(t);
    }
  }
  return pts[pts.length-1].value;
}

/* a synthetic spectrum so FFT-driven parameters have something to chew on
   offline; a real build swaps this for the audio device. */
const fft = {low:0, mid:0, high:0};
function updateFFT(target, time, random){
  target = target || fft;
  const beats = time && Number.isFinite(time.beats) ? time.beats : clock.beats;
  const b = beats - Math.floor(beats), bar = (beats % 4) / 4;
  const rng = typeof random === 'function' ? random : Math.random;
  const kick = Math.pow(1 - b, 6);
  target.low  = clamp(kick * 0.95 + rng()*0.05, 0, 1);
  target.mid  = clamp(Math.pow(1 - ((beats*2) % 1), 3) * 0.7 + rng()*0.15, 0, 1);
  target.high = clamp((bar > .5 ? 0.6 : 0.25) * rng() + Math.pow(1-((beats*4)%1),8)*0.5, 0, 1);
}

function animate(p, spec){
  spec = spec || {};
  /* Structural commands are not Parameter values. Resolume documents that
     Effect Event Parameters can animate, but a Clip Resize/eject-style action
     has no persistent value domain for an Envelope/LFO to own. */
  if(!p || p.action || p.unwired || ['image','resource'].includes(p.type)) return null;
  /* A text parameter has no continuous numeric domain. Timeline/BPM Sync can
     only choose among its Basic-animation values, so activating either mode
     without at least two values would display a running animation that can
     never change the text. Preserve an existing list when switching modes. */
  const requestedMode=spec.mode || 'Timeline';
  if(p && p.type==='string'){
    const supplied=Array.isArray(spec.values) ? spec.values
      : Array.isArray(spec.lines) ? spec.lines : null;
    const existing=p.anim && Array.isArray(p.anim.values) ? p.anim.values : null;
    const values=supplied || existing;
    if(!values || values.length<2) return null;
    if(!supplied) spec=Object.assign({},spec,{values:values.slice()});
  }
  if(p.type==='color' && (!Array.isArray(p.palette) ||
     !p.palette.some(value=>paletteWord(value)!=null))) return null;
  /* Dashboard is one of the sources in the animation cogwheel, not a second
     source which fights the selected animation every frame. `editParameterState`
     groups this structural unlink with the animation edit; direct engine calls
     keep animate()'s historic no-Undo contract and unlink silently. */
  if(p.dash)
    unlinkFromDashboard(p.dash.home,p.dash.dial,p.id,{noUndo:!undoGroup});
  p.anim = Object.assign({
    mode:'Timeline', phase:0, speed:1, duration:4, beats:4,
    direction:'Forwards', playmode:'Loop', band:'L', gain:1, fall:0.5,
    interval:0.5, distance:null, intervalUnit:null, distanceUnit:null,
    env:null, running:true, invert:false, values:null, _v:0,
    _randomElapsed:0, _cleared:false, _eventHigh:false
  }, spec);
  p.anim._started=performance.now();
  /* A reverse transport starts at its out point. Factory Text Animator / One
     Shot depends on this; starting every animation at zero made a backwards
     one-shot finish on its first evaluation. An explicitly supplied phase is
     still authoritative. */
  if(!Object.prototype.hasOwnProperty.call(spec, 'phase'))
    p.anim.phase = p.anim.direction === 'Backwards' ? 1 : 0;
  p.anim.phase = clamp(Number.isFinite(+p.anim.phase) ? +p.anim.phase : 0, 0, 1);
  /* ParamText Basic animation stores its selectable lines beside the saved
     parameter rather than inside PhaseSourceTimeline. Copy them into runtime
     state: callers may reuse or discard the parsed record after application. */
  if(Array.isArray(p.anim.values)) p.anim.values = p.anim.values.map(value => String(value));
  else if(Array.isArray(p.anim.lines)) p.anim.values = p.anim.lines.map(value => String(value));
  notify(p);
  return p.anim;
}
function stopAnimation(p){ p.anim = null; notify(p); }
function restartAnimations(node, cause){
  walkParams(node, p => {
    if(p.anim && p.anim.start !== 'manual'){
      p.anim.phase = p.anim.direction === 'Backwards' ? 1 : 0;
      p.anim.running = true;
      p.anim._randomElapsed = 0;
      p.anim._cleared = false;
      p.anim._eventHigh = false;
      p.anim._started=performance.now();
    }
  });
}
function walkParams(node, fn, seen){
  seen = seen || new Set();
  if(!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  let properties,prototype;
  try{
    const id=Object.getOwnPropertyDescriptor(node,'id');
    if(id && 'value' in id && REG.get(id.value)===node){ fn(node); return; }
    prototype=Object.getPrototypeOf(node);
    /* A persistent Clip on another Bank is a deliberate overlay on its
       registered Clip model. Keep walking that proven model; other native
       prototypes (File, canvas, video, Window, CSSStyleSheet) are resources,
       never parameter trees. Cross-realm plain objects remain valid. */
    const parent=prototype && Object.getPrototypeOf(prototype);
    if(prototype && parent!==null && !Array.isArray(node)){
      const kind=Object.getOwnPropertyDescriptor(prototype,'kind'),name=Object.getOwnPropertyDescriptor(prototype,'name');
      const nameId=name?.value && Object.getOwnPropertyDescriptor(name.value,'id');
      if(kind?.value!=='clip' || !nameId || !('value' in nameId) || REG.get(nameId.value)!==name.value) return;
      walkParams(prototype,fn,seen);
    }
    properties=Object.getOwnPropertyDescriptors(node);
  }catch(_){return;}
  /* Runtime originals and renderer objects are opaque capabilities. Reading
     inherited DOM accessors here previously reached cross-origin cssRules,
     aborting Clip trigger/animation restart while a content player was open. */
  for(const [k,property] of Object.entries(properties)){
    if(!property.enumerable || !('value' in property) || k === '_runtime' || k === 'playing' ||
      k === 'clips' || k === 'covers' || k === 'media' || k === 'live' || k === 'sourceFile' ||
      k === 'originalSource' || k === 'sourceReference') continue;
    const v = property.value;
    if(v && typeof v === 'object') walkParams(v, fn, seen);
  }
}

const wrapPhase = phase => ((phase % 1) + 1) % 1;

/* Advance a Timeline/BPM playhead by a positive phase distance. Direction is
   a separate transport control in Arena, so Random still jumps when Speed is
   zero (the shipped Jumpy preset is the proof) and Bounce flips it only at a
   boundary. Returns true when Play Once & Clear reached its terminal edge. */
function advanceAnimationPhase(a, amount){
  if(a.direction === 'Paused' || amount <= 0) return false;
  const sign = a.direction === 'Backwards' ? -1 : 1;
  const next = a.phase + amount * sign;
  const mode = a.playmode || 'Loop';

  if(mode === 'Loop' || mode === 'Random'){
    a.phase = wrapPhase(next);
    return false;
  }
  if(mode === 'Bounce'){
    if(next > 0 && next < 1){ a.phase = next; return false; }
    if(next === 1){ a.phase = 1; a.direction = 'Backwards'; return false; }
    if(next === 0){ a.phase = 0; a.direction = 'Forwards'; return false; }
    /* Fold any overshoot into a two-phase triangle in O(1), even after a tab
       was suspended or the animation duration is extremely small. */
    const folded = ((next % 2) + 2) % 2;
    a.phase = folded <= 1 ? folded : 2 - folded;
    if(sign > 0) a.direction = folded < 1 ? 'Forwards' : 'Backwards';
    else a.direction = folded < 1 ? 'Backwards' : 'Forwards';
    return false;
  }
  const reached = sign > 0 ? next >= 1 : next <= 0;
  if(!reached){ a.phase = next; return false; }
  a.running = false;
  if(mode === 'Play Once & Clear'){
    a.phase = 0;
    a._cleared = true;
    return true;
  }
  /* Play Once & Hold (and an unknown one-shot code) retain the frame at the
     edge in the direction of travel. */
  a.phase = sign > 0 ? 1 : 0;
  return false;
}

/* UNDOCUMENTED — inferred. video.htm defines Clear as ejecting a Clip, but a
   free-standing parameter has nothing to eject. The neutral equivalent is a
   zero/first value (or an empty text/image), while Hold keeps the terminal
   value. This also makes Text Animator one-shots actually disappear. */
function clearAnimatedValue(p){
  if(p.type === 'event'){
    if(p.anim) p.anim._eventHigh=false;
  } else if(p.type === 'string' || p.type === 'image')
    setParam(p, '', {silent:1, noUndo:1});
  else if(p.type === 'color')
    setParam(p, 0, {silent:1, noUndo:1});
  else
    applyNormalised(p, 0, {silent:1, noUndo:1});
}

function writeAnimatedValue(p, a, out){
  if(p.type === 'event'){
    /* Event Parameters are pulses. Drive them exactly once when the Basic
       phase crosses its switch point from low to high; holding the animation
       above 0.5 must not retrigger Reset/Randomize at frame rate. */
    const high=clamp(out,0,1) >= 0.5;
    if(high && !a._eventHigh) triggerEvent(p);
    a._eventHigh=high;
  } else if(p.type === 'string' && Array.isArray(a.values) && a.values.length){
    const at = clamp(Math.floor(clamp(out, 0, 1) * a.values.length), 0, a.values.length - 1);
    setParam(p, a.values[at], {silent:1, noUndo:1});
  } else {
    /* the in/out window lives on the parameter, so applyNormalised already
       maps into it — the animation does not carry a second copy */
    applyNormalised(p, out, {silent:1, noUndo:1});
  }
}

function animationParamList(params){
  if(params == null) return Array.from(REG.values());
  if(Array.isArray(params)) return params;
  if(typeof params[Symbol.iterator] === 'function') return Array.from(params);
  return [params];
}

function runAnimations(dt, params, time){
  time = time || {beats:clock.beats, beatDelta:dt * clock.bpm() / 60,
                  bpm:clock.bpm(), fft};
  const spectrum = time.fft || fft;
  updateFFT(spectrum, time, time.random);
  animationParamList(params).forEach(p => {
    if(!p || typeof p !== 'object') return;
    const a = p.anim; if(!a || !a.running) return;
    const elapsed=Number.isFinite(time.now)
      ? frameElapsedSince(a._started,time.frameDt,time.now) : dt;
    const animationDt=Math.min(dt,elapsed);
    const animationBeats=Number.isFinite(time.now)
      ? (time.frameDt > 0 ? time.beatDelta*elapsed/time.frameDt : 0) : time.beatDelta;
    let clear = false;
    if(a.mode === 'Timeline'){
      clear = advanceAnimationPhase(a,
        (animationDt / Math.max(0.05, +a.duration || 0)) * Math.max(0, +a.speed || 0));
    } else if(a.mode === 'BPM Sync'){
      clear = advanceAnimationPhase(a,
        ((+animationBeats || 0) / Math.max(1e-6, +a.beats || 0)) * Math.max(0, +a.speed || 0));
    } else if(a.mode === 'Clip Position'){
      const L = doc.layers.find(x => x.playing && ownsParam(x.playing.clip, p));
      a.phase = L && L.playing ? L.playing.position : a.phase;
    } else if(a.mode === 'Crossfader Phase'){
      a.phase = val(doc.comp.crossfader.phase);
    } else if(/FFT/.test(a.mode)){
      const band = a.band === 'L' ? spectrum.low : a.band === 'M' ? spectrum.mid : spectrum.high;
      const target = clamp(band * a.gain * val(doc.comp.fft.gain), 0, 1);
      a.phase = a._v = target > a._v ? target :
        a._v + (target - a._v) * clamp(dt / Math.max(0.01, a.fall), 0, 1);
    } else return;

    if((a.mode === 'Timeline' || a.mode === 'BPM Sync') && a.playmode === 'Random'){
      const intervalUnit = a.intervalUnit || (a.mode === 'BPM Sync' ? 'beats' : 'seconds');
      const distanceUnit = a.distanceUnit || (a.mode === 'BPM Sync' ? 'beats' : 'seconds');
      const elapsed = intervalUnit === 'beats' ? (+animationBeats || 0) : animationDt;
      const interval = Math.max(0, +a.interval || 0);
      a._randomElapsed = Math.max(0, +a._randomElapsed || 0) + Math.max(0, elapsed);
      if(interval === 0 || a._randomElapsed >= interval){
        if(interval > 0) a._randomElapsed %= interval; else a._randomElapsed = 0;
        const duration = distanceUnit === 'beats'
          ? Math.max(1e-6, +a.beats || 0)
          : Math.max(0.05, +a.duration || 0);
        const span = a.distance == null ? 1 : clamp(Math.abs(+a.distance || 0) / duration, 0, 1);
        /* UNDOCUMENTED — inferred. Distance describes a local range but the
           docs do not say how it behaves at an edge. Clip the window to the
           timeline so a full-duration Distance can still select any point. */
        const lo = Math.max(0, a.phase - span), hi = Math.min(1, a.phase + span);
        const rng = typeof a.random === 'function' ? a.random : Math.random;
        a.phase = lo + clamp(+rng() || 0, 0, 1) * (hi - lo);
      }
    }
    a.phase = clamp(a.phase, 0, 1);
    if(clear){ clearAnimatedValue(p); return; }
    /* envelopes.htm — "Resolume will apply the envelope to the input of your
       parameter. This means any input!" */
    let out = a.env ? envelopeAt(a.env, a.phase) : a.phase;
    if(a.invert) out = 1 - out;
    /* ParamText's Basic animation is a discrete walk through its Lines. It
       cannot use applyNormalised(), whose numeric/choice contract correctly
       ignores strings. Like every other animation write this is silent and
       no-undo: loading a preset is one gesture, not one gesture per frame. */
    writeAnimatedValue(p, a, out);
  });
}

/* Advance only a caller-owned parameter set. This is used by live-mode
   browser previews: it deliberately does not touch the composition clock,
   clips, quantise queue or autopilot. `state` is the preview's private clock
   and is mutated in place so callers allocate it only once. */
function tickParams(params, now, state){
  state = state || {};
  now = Number.isFinite(+now) ? +now : performance.now();
  let dt = 0;
  if(Number.isFinite(state.lastT)) dt = clamp((now - state.lastT) / 1000, 0, 0.1);
  state.lastT = now;
  if(!Number.isFinite(state.beats)) state.beats = 0;
  const before = state.beats;
  const bpm = Number.isFinite(+state.bpm) ? +state.bpm : clock.bpm();
  if(state.running !== false) state.beats += dt * bpm / 60;
  if(!state.fft) state.fft = {low:0, mid:0, high:0};
  batch(() => runAnimations(dt, params, {
    beats:state.beats, beatDelta:state.beats - before, bpm,
    fft:state.fft, random:state.random
  }));
  return dt;
}
function ownsParam(node, p){ let hit = false; walkParams(node, q => { if(q === p) hit = true; }); return hit; }

/* 0..1 in, and 0..1 out, both across the parameter's in/out window rather than
   its absolute bounds — so anything driving a parameter (a slider, an envelope,
   an FFT band, a dashboard dial) travels only the part of the range the user
   opened up. */
function applyNormalised(p, n, opts){
  n=clamp(Number.isFinite(+n) ? +n : 0,0,1);
  if(p.type === 'range' || p.type === 'number'){
    const w = windowOf(p);
    setParam(p, w.lo + n * (w.hi - w.lo), opts);
  }
  else if(p.type === 'bool') setParam(p, n >= 0.5, opts);
  else if(p.type === 'choice' && p.options && p.options.length)
    setParam(p, p.options[clamp(Math.floor(n * p.options.length), 0, p.options.length - 1)], opts);
  else if(p.type === 'color'){
    /* Resolume animates a Color *palette*: phase walks the enabled swatches.
       A packed ARGB word is not a meaningful scalar and interpolating from
       black to 0xFFFFFFFF would invent semantics. Work only from actual,
       non-empty palette entries and preserve the current alpha unless the
       swatch explicitly carries one. Color interpolation is a separate Arena
       Animation Setting; this discrete path deliberately does not fake it. */
    const alpha=colorParts(p.value).a;
    const colors=Array.isArray(p.palette)
      ? p.palette.map(value=>paletteWord(value,alpha)).filter(value=>value!=null) : [];
    if(colors.length)
      setParam(p,colors[clamp(Math.floor(n*colors.length),0,colors.length-1)],opts);
  }
}
function normalised(p){
  if(p.type === 'range' || p.type === 'number'){
    const w = windowOf(p);
    return clamp((p.value - w.lo) / ((w.hi - w.lo) || 1), 0, 1);
  }
  if(p.type === 'bool') return p.value ? 1 : 0;
  if(p.type === 'choice' && p.options) return p.options.indexOf(p.value) / Math.max(1, p.options.length - 1);
  if(p.type === 'color' && Array.isArray(p.palette)){
    const alpha=colorParts(p.value).a;
    const colors=p.palette.map(value=>paletteWord(value,alpha)).filter(value=>value!=null);
    if(colors.length){
      const at=colors.indexOf(Number(p.value)>>>0);
      return at < 0 ? 0 : at / Math.max(1,colors.length-1);
    }
  }
  return 0;
}
/* Set the window. Reset restores the full range, which is what right-clicking
   an untouched parameter should give you back. */
function setRange(id, inPt, outPt){
  const p = typeof id === 'object' ? id : REG.get(+id);
  if(!p) return;
  p.in  = inPt  == null ? p.min : clamp(+inPt,  p.min, p.max);
  p.out = outPt == null ? p.max : clamp(+outPt, p.min, p.max);
  notify(p);
}

/* =========================================================================
   10. DASHBOARD — dashboard.htm
   One dial drives any number of parameters, each with its own in/out point,
   invert and dial range.
   ========================================================================= */
function dashOf(home){
  if(home === doc.comp.home) return doc.comp.dashboard;
  const all = [doc.comp, ...doc.groups, ...doc.layers];
  const n = all.find(x => x.home === home);
  if(n) return n.dashboard;
  for(const d of doc.decks) for(const k of d.clips.values()) if(k.home === home) return k.dashboard;
  return null;
}
function driveDial(home, i, v){
  const dash = dashOf(home); if(!dash) return;
  const dial = dash[i]; if(!dial) return;
  dial.links.forEach(link => {
    const p = REG.get(link.paramId); if(!p) return;
    /* Dial Range: which slice of the dial's travel owns this parameter */
    const lo = link.dialMin ?? 0, hi = link.dialMax ?? 1;
    let t = (v - lo) / ((hi - lo) || 1);
    t = clamp(t, 0, 1);
    if(link.invert) t = 1 - t;
    const a = link.inPoint ?? 0, b = link.outPoint ?? 1;
    applyNormalised(p, a + t * (b - a), {silent:1, noUndo:1});
  });
}
function dashboardLinkState(dial,p){
  return {links:cloneEffectValue(dial.links||[]),name:snapshotParameterState(dial.name),
    dash:cloneEffectValue(p.dash),anim:cloneEffectValue(p.anim)};
}
function restoreDashboardLinkState(dial,p,state){
  dial.links=cloneEffectValue(state.links||[]);
  restoreParameterState(dial.name,state.name,false);
  p.dash=cloneEffectValue(state.dash);
  p.anim=cloneEffectValue(state.anim);
  if(p.anim) PARAM_ANIMATION_RUNTIME_KEYS.forEach(key=>delete p.anim[key]);
  if(p.anim) p.anim._started=performance.now();
  notify(dial.value); notify(p);
}
function linkToDashboard(home, dialIndex, paramId, opts){
  opts=opts||{};
  const dash = dashOf(home); if(!dash) return null;
  const dial = dash[dialIndex]; if(!dial) return null;
  const p = REG.get(+paramId); if(!p) return null;
  if(p.transient || p.unwired || p.type === 'event' || p.action ||
     ['string','image','resource'].includes(p.type)) return null;
  /* A bare packed color has no scalar Dashboard domain. A real palette does:
     Dashboard position selects its swatches just like a color animation. */
  if(p.type==='color' && (!Array.isArray(p.palette) || !p.palette.some(value=>paletteWord(value)!=null)))
    return null;
  // Preview controls and one-shot commands never own persistent Dashboard links.
  if(dial.links.some(l => l.paramId === p.id)) return dial;
  const before=dashboardLinkState(dial,p), linkOpts=Object.assign({},opts); delete linkOpts.noUndo;
  p.anim=null;
  dial.links.push(Object.assign({paramId:p.id, inPoint:0, outPoint:1, invert:false, dialMin:0, dialMax:1}, linkOpts));
  p.dash = {home, dial:dialIndex};
  /* "The dial will rename itself to the name of the parameter." */
  if(dial.links.length === 1) setParam(dial.name, p.name, {silent:1,noUndo:true});
  else if(!/\+/.test(val(dial.name))) setParam(dial.name, val(dial.name) + ' +', {silent:1,noUndo:true});
  notify(dial.value);
  if(!opts.noUndo){
    const after=dashboardLinkState(dial,p);
    pushStructuralUndo('Link '+p.name+' to Dashboard',
      ()=>restoreDashboardLinkState(dial,p,before),
      ()=>restoreDashboardLinkState(dial,p,after));
  }
  return dial;
}
function unlinkFromDashboard(home, dialIndex, paramId, opts){
  opts=opts||{};
  const dash = dashOf(home); if(!dash) return;
  const dial = dash[dialIndex]; if(!dial) return;
  const p = REG.get(+paramId); if(!dial.links.some(l=>l.paramId===+paramId)) return false;
  const before=p&&dashboardLinkState(dial,p);
  dial.links = dial.links.filter(l => l.paramId !== +paramId);
  if(p) p.dash = null;
  if(!dial.links.length) setParam(dial.name, 'Dial ' + (dialIndex + 1), {silent:1,noUndo:true});
  notify(dial.value);
  if(p) notify(p);
  if(p&&!opts.noUndo){
    const after=dashboardLinkState(dial,p);
    pushStructuralUndo('Unlink '+p.name+' from Dashboard',
      ()=>restoreDashboardLinkState(dial,p,before),
      ()=>restoreDashboardLinkState(dial,p,after));
  }
  return true;
}
function editDashboardLink(home, dialIndex, paramId, patch, opts){
  opts=opts||{};
  const dash=dashOf(home),dial=dash&&dash[dialIndex];
  if(!dial) return false;
  const p=REG.get(+paramId),link=(dial.links||[]).find(item=>+item.paramId===+paramId);
  if(!p||!link) return false;
  const before=dashboardLinkState(dial,p),next=Object.assign({},link);
  const numeric=['inPoint','outPoint','dialMin','dialMax'];
  numeric.forEach(key=>{
    if(patch&&Object.prototype.hasOwnProperty.call(patch,key))
      next[key]=clamp(Number.isFinite(+patch[key])?+patch[key]:link[key],0,1);
  });
  if(patch&&Object.prototype.hasOwnProperty.call(patch,'invert')) next.invert=!!patch.invert;
  /* A range may be collapsed, but never reversed. This mirrors the two-handle
     Dashboard range controls while keeping a pasted/programmatic edit honest. */
  if(next.inPoint>next.outPoint) [next.inPoint,next.outPoint]=[next.outPoint,next.inPoint];
  if(next.dialMin>next.dialMax) [next.dialMin,next.dialMax]=[next.dialMax,next.dialMin];
  if(sameParameterStates(link,next)) return false;
  Object.assign(link,next); notify(dial.value); notify(p);
  if(!opts.noUndo){
    const after=dashboardLinkState(dial,p);
    pushStructuralUndo(opts.label||('Edit '+p.name+' Dashboard link'),
      ()=>restoreDashboardLinkState(dial,p,before),
      ()=>restoreDashboardLinkState(dial,p,after));
  }
  return true;
}

/* =========================================================================
   11. THE RENDER GRAPH
   layers.htm + groups.htm + composition.htm. This is the payoff: it turns the
   parameter tree into an ordered composite the monitors can actually paint,
   so every relationship above becomes visible.
   ========================================================================= */
const XF_CURVE = {
  'Linear': t => t,
  'Gentle': t => t*t*(3-2*t),
  'Fast':   t => t<.5 ? 2*t*t : 1-2*(1-t)*(1-t),
  'Cut':    t => t < .5 ? 0 : 1
};
function soloActive(){ return doc.layers.some(L => val(L.solo)) || doc.groups.some(g => val(g.solo)); }

function crossfaderPhase(){
  const curve = XF_CURVE[val(doc.comp.crossfader.curve)] || XF_CURVE.Linear;
  return clamp(curve(clamp(val(doc.comp.crossfader.phase), 0, 1)), 0, 1);
}

function crossfaderTarget(side){ return String(side).toUpperCase() === 'B' ? 1 : 0; }
function crossfaderPress(side){
  if(!doc.comp || !doc.comp.crossfader) return false;
  side=String(side).toUpperCase()==='B' ? 'B' : 'A';
  const xf=doc.comp.crossfader, rt=xf._runtime || (xf._runtime={});
  const behaviour=val(xf.behaviour), target=crossfaderTarget(side);
  rt.fade=null;
  if(behaviour==='Cut'){
    if(rt.heldSide==null) rt.returnPhase=val(xf.phase);
    rt.heldSide=side;
    setParam(xf.phase,target,{noUndo:true});
    return true;
  }
  /* Current docs call this Jump & Return. Older local data used Cut & Return;
     accept saved compositions using that label without changing its meaning. */
  if(behaviour==='Jump & Return' || behaviour==='Cut & Return'){
    if(rt.toggleSide===side && rt.returnPhase!=null){
      const back=rt.returnPhase;
      rt.returnPhase=null; rt.toggleSide=null;
      setParam(xf.phase,back,{noUndo:true});
    } else {
      rt.returnPhase=val(xf.phase); rt.toggleSide=side;
      setParam(xf.phase,target,{noUndo:true});
    }
    return true;
  }
  if(behaviour==='Fade (Legacy)'){
    rt.fade={from:val(xf.phase),to:target,elapsed:0,duration:4,started:performance.now()};
    return true;
  }
  rt.returnPhase=null; rt.toggleSide=null; rt.heldSide=null;
  setParam(xf.phase,target,{noUndo:true});
  return true;
}
function crossfaderRelease(side){
  if(!doc.comp || !doc.comp.crossfader) return false;
  side=String(side).toUpperCase()==='B' ? 'B' : 'A';
  const xf=doc.comp.crossfader, rt=xf._runtime || {};
  if(val(xf.behaviour)!=='Cut' || rt.heldSide!==side) return false;
  const back=rt.returnPhase;
  rt.returnPhase=null; rt.heldSide=null;
  if(back!=null) setParam(xf.phase,back,{noUndo:true});
  return true;
}
function advanceCrossfaderFade(beatDelta,frameDt,now){
  const xf=doc.comp && doc.comp.crossfader;
  const rt=xf && xf._runtime, fade=rt && rt.fade;
  if(!fade || !(beatDelta>0)) return;
  if(frameDt > 0) beatDelta *= frameElapsedSince(fade.started,frameDt,now)/frameDt;
  fade.elapsed=Math.min(fade.duration,fade.elapsed+beatDelta);
  if(fade.duration-fade.elapsed < 1e-9) fade.elapsed=fade.duration;
  const t=fade.duration>0 ? fade.elapsed/fade.duration : 1;
  setParam(xf.phase,fade.from+(fade.to-fade.from)*t,{noUndo:true});
  if(t>=1) rt.fade=null;
}

/* The three global Direction controls affect Clips that are playing now; they
   are not a persistent override on every future Clip transport. */
function setGlobalDirection(direction){
  if(!window.DIRECTIONS.includes(direction)) return false;
  batch(() => doc.layers.forEach(L => {
    if(L.playing) setParam(L.playing.clip.transport.direction,direction,{noUndo:true});
  }));
  setParam(doc.comp.trigger.direction,direction,{noUndo:true});
  return true;
}

/* groups.htm — a Group is a sub-composition, so a member Layer assigned to
   crossfader bus A/B must stay inside that Group.  Hoisting it into the
   Composition buses would skip the Group's effects, Transform and opacity.

   Once the flattened Group itself is assigned to A or B, its bus is
   authoritative and the child assignments are deliberately inactive:
   Resolume documents that you cannot crossfade to a Layer in a Group when the
   Group is on another bus. */
function groupCrossfader(children, groupBus){
  const A = children.filter(entry => entry.bus === 'A');
  const B = children.filter(entry => entry.bus === 'B');
  if(groupBus !== 'None' || (!A.length && !B.length)) return null;

  return {
    kind:'crossfade', A, B, phase:crossfaderPhase(),
    anchor:children.findIndex(entry => entry.bus === 'A' || entry.bus === 'B'),
    blend:val(doc.comp.crossfader.blend)
  };
}

function effectiveBlend(L){
  /* clips.htm — a playing clip's own blend overrides the layer's */
  const pl = L.playing;
  if(pl){ const b = val(pl.clip.video.blend); if(b && b !== DETERMINED_LAYER) return b; }
  return val(L.video.blend);
}
function layerOpacity(L){
  const g = groupOf(L);
  let o = val(L.video.opacity) * val(L.master);
  if(L.playing) o *= val(L.playing.clip.video.opacity);
  /* the transition crossfade itself is painted by the monitors from
     playing.transitionT / transitionFrom — opacity here is transition-free */
  return clamp(o, 0, 1);
}
function layerVisible(L){
  if(val(L.bypassed)) return false;                       // B
  const g = groupOf(L);
  if(g && val(g.bypassed)) return false;
  if(soloActive()){                                       // S — "hiding everything but"
    const soloed = val(L.solo) || (g && val(g.solo));
    if(!soloed) return false;
  }
  return true;
}

function renderStack(){
  const stack = [];                    // bottom-up, exactly as the manual describes
  const used = new Set();
  doc.layers.forEach(L => {
    if(used.has(L)) return;
    const g = groupOf(L);
    if(g){
      if(used.has(g)) return;
      used.add(g);
      /* groups.htm — the group renders on a transparent black canvas of its
         own, then rejoins the composition as one flattened layer. */
      const members = doc.layers.filter(x => x.group === g.index);
      members.forEach(m => used.add(m));
      const groupBus = val(g.crossfadergroup);
      const children = members.map((m,i) => ({
        kind:'layer', node:m, name:displayName(m),
        visible: layerVisible(m), opacity: layerOpacity(m),
        /* "The first layer of a group is first rendered on a transparent
           black background. It doesn't blend with the layers underneath it." */
        blend: i === 0 ? 'Alpha' : effectiveBlend(m),
        bus: val(m.crossfadergroup),
        mask: maskOf(m), playing: m.playing
      }));
      stack.push({
        kind:'group', node:g, name:displayName(g),
        /* A soloed member has to keep its flattened Group alive.  The child
           visibility calculation below already hides the Group's other
           members; requiring the Group's own Solo as well discarded the one
           member that was explicitly soloed. */
        visible: !val(g.bypassed) && (!soloActive() || val(g.solo) ||
          members.some(member => val(member.solo))),
        blend: val(g.video.blend), opacity: val(g.video.opacity) * val(g.master),
        bus: groupBus,
        children,
        mix: groupCrossfader(children, groupBus)
      });
    } else {
      used.add(L);
      stack.push({
        kind:'layer', node:L, name:displayName(L),
        visible: layerVisible(L), opacity: layerOpacity(L),
        blend: effectiveBlend(L), bus: val(L.crossfadergroup),
        mask: maskOf(L), playing: L.playing
      });
    }
  });

  /* composition.htm > Crossfader. Bused entries render into A and B first;
     the mix collapses onto the position of the lowest bused entry. */
  const busA = stack.filter(e => e.bus === 'A'), busB = stack.filter(e => e.bus === 'B');
  let mix = null;
  if(busA.length || busB.length){
    const phase = crossfaderPhase();
    const anchor = stack.findIndex(e => e.bus === 'A' || e.bus === 'B');
    mix = {kind:'crossfade', A:busA, B:busB, phase, anchor, blend: val(doc.comp.crossfader.blend)};
  }
  const order = mix ? stack.filter(e => e.bus !== 'A' && e.bus !== 'B') : stack;
  if(mix) order.splice(Math.min(mix.anchor, order.length), 0, mix);

  return {
    order, mix,
    master: val(doc.comp.master) * (val(doc.comp.bypassed) ? 0 : 1) * val(doc.comp.video.opacity),
    bypassed: val(doc.comp.bypassed),
    size: {w: val(doc.comp.video.width), h: val(doc.comp.video.height)}
  };
}
/* layers.htm > Mask Layer */
function maskOf(L){
  const m = val(L.maskmode);
  if(m === 'Disabled') return null;
  const i = doc.layers.indexOf(L);
  const below = doc.layers.slice(0, i);
  return {mode:m, targets: m === 'One Below' ? below.slice(-1) : below};
}

/* canvas blend names for the modes we can express directly */
const CANVAS_BLEND = {
  'Add':'lighter', 'Screen':'screen', 'Lighten':'lighten', 'Dodge':'color-dodge',
  'Multiply':'multiply', 'Darken':'darken', 'Burn':'color-burn', 'Subtract':'difference',
  'Overlay':'overlay', 'Hard Light':'hard-light', 'Soft Light':'soft-light',
  'Difference':'difference', 'Difference I':'difference', 'Exclusion':'exclusion',
  'Alpha':'source-over', 'Cut':'destination-out', 'B&W':'luminosity',
  '50 Add':'lighter', '50 Multiply':'multiply', '50 Lighten':'lighten',
  '50 Difference':'difference', '50 Overlay':'overlay', '50 Subtract':'difference',
  '50 Dodge':'color-dodge', '50 Burn':'color-burn', '50 Mask':'destination-in'
};
const canvasBlend = name => CANVAS_BLEND[name] || 'source-over';

/* Resolume's regular Layer/Effect mixer has a two-sided opacity curve
   (layers.htm > Types of Blends):

     0%   destination only
     50%  the selected blend at full strength
     100% foreground/source only

   The explicitly named `50 ...` modes are different: they reach the selected
   blend at 100%. Canvas globalAlpha on its own implements only that latter
   curve, which is why Add at 100% used to keep adding every Layer until the
   Composition became a pale "white soup". Keep this calculation independent
   of the painter so Layers, Groups and Effects cannot drift apart again. */
const TWO_SIDED_MIXERS = new Set([
  'Add','Screen','Lighten','Dodge','Multiply','Darken','Burn','Subtract',
  'Overlay','Hard Light','Soft Light','Difference','Difference I','Exclusion',
  'B&W'
]);
function mixerPlan(name, opacity){
  const mode = String(name || 'Alpha');
  const o = clamp(Number(opacity) || 0, 0, 1);
  const operation = canvasBlend(mode);
  if(o <= 0) return {kind:'skip', mode, operation, opacity:o};
  /* destination-in cannot be faded by lowering source globalAlpha: that
     multiplies the whole destination by o*mask and jumps from unchanged at 0
     to almost transparent just above 0. Interpolate unchanged -> masked. */
  if(mode === '50 Mask' && o < 1)
    return {kind:'mask-interpolate', mode, operation, alpha:o, opacity:o};
  if(!TWO_SIDED_MIXERS.has(mode))
    return {kind:'single', mode, operation, alpha:o, opacity:o};
  if(o < 0.5)
    return {kind:'single', mode, operation, alpha:o * 2, opacity:o};
  if(o === 0.5)
    return {kind:'single', mode, operation, alpha:1, opacity:o};
  /* The common full-fader endpoint is a single, cheap source-over draw. */
  if(o >= 1)
    return {kind:'single', mode, operation:'source-over', alpha:1, opacity:o};
  return {kind:'blend-to-source', mode, operation, alpha:1,
          sourceMix:o * 2 - 1, opacity:o};
}

/* =========================================================================
   12. EFFECTS — effects.htm
   ========================================================================= */
function effectParamList(fx){
  return [fx && fx.bypassed, fx && fx.opacity, fx && fx.blend, fx && fx.drywet,
          ...((fx && fx.params) || [])].filter(p => p && p.id != null);
}
function registerEffectParams(fx, on){
  effectParamList(fx).forEach(p => { if(on) REG.set(p.id, p); else REG.delete(p.id); });
}
/* Effect addresses are positional in Resolume. Reindex after every structural
   mutation so removing slot 1 cannot leave stale or duplicate addresses. */
function reindexEffects(scope, audio){
  const track = audio ? 'audio' : 'video';
  const list = scope[track].effects;
  list.forEach((fx, i) => {
    const old = fx.home;
    const next = `${scope.home}/effects/${track}/${i + 1}`;
    fx.home = next;
    effectParamList(fx).forEach(p => {
      if(old && p.home && p.home.indexOf(old) === 0){
        const nextParamHome=next+p.home.slice(old.length);
        retargetControlMappingParameter(p,nextParamHome);
        p.home=nextParamHome;
      }
    });
  });
}
function touchEffectChain(scope, fx){ notify((fx && fx.bypassed) || scope.master || doc.comp.master); }
function insertEffectObject(scope, fx, index, audio){
  const list = audio ? scope.audio.effects : scope.video.effects;
  if(list.includes(fx)) return;
  list.splice(clamp(index, 0, list.length), 0, fx);
  registerEffectParams(fx, true);
  reindexEffects(scope, audio);
  touchEffectChain(scope, fx);
}
function removeEffectObject(scope, fx, audio){
  const list = audio ? scope.audio.effects : scope.video.effects;
  const index = list.indexOf(fx); if(index < 0) return;
  list.splice(index, 1);
  registerEffectParams(fx, false);
  reindexEffects(scope, audio);
  touchEffectChain(scope, fx);
}
/* Dashboard mappings belong to a concrete Effect instance, not to the slot it
   happens to occupy. Structural Undo keeps that instance alive, so detach its
   mappings before unregistering its Parameters and restore them only after the
   same Parameters are registered again. The snapshot is deliberately refreshed
   on every detach: a user may remap a restored Effect before Redo. */
function effectPresenceTransition(scope, fx, index, audio){
  let mappings=null;
  return {
    detach(){
      mappings=snapshotParameterMappings(effectParamList(fx));
      removeParameterMappings(mappings);
      removeEffectObject(scope,fx,audio);
    },
    attach(){
      insertEffectObject(scope,fx,index,audio);
      restoreParameterMappings(mappings);
    }
  };
}
function moveEffectObject(scope, fx, index, audio){
  const list = audio ? scope.audio.effects : scope.video.effects;
  const from = list.indexOf(fx); if(from < 0) return;
  list.splice(from, 1);
  list.splice(clamp(index, 0, list.length), 0, fx);
  reindexEffects(scope, audio);
  touchEffectChain(scope, fx);
}
function effectFactoryRecord(name, isAudio){
  if(isAudio){
    return {
      implemented:!!(window.ArenaMedia && window.ArenaMedia.hasAudioEffect &&
        window.ArenaMedia.hasAudioEffect(name)),
      specs:(window.AUDIO_EFFECT_PARAMS &&
        Object.prototype.hasOwnProperty.call(window.AUDIO_EFFECT_PARAMS,name) &&
        window.AUDIO_EFFECT_PARAMS[name]) || []
    };
  }
  const implemented=!!(window.ArenaFX && typeof window.ArenaFX.has === 'function' &&
    window.ArenaFX.has(name));
  const declared=window.ArenaFX && window.ArenaFX.params ? window.ArenaFX.params(name) : null;
  if(Array.isArray(declared)) return {implemented,specs:declared};
  const names=window.PRESETS && Object.prototype.hasOwnProperty.call(window.PRESETS,name)
    ? window.PRESETS[name] : ['Amount','Speed'];
  return {implemented,specs:(Array.isArray(names) ? names : ['Amount','Speed'])
    .slice(0,6).map(n => ({n:String(n),kind:'range',min:0,max:1,d:.5}))};
}
function addEffect(scope, name, opts){
  opts = opts || {};
  const isAudio = !!opts.audio;
  /* Effects created through menus, presets, paste/import and direct callers all
     converge here. A SHOWAVE Audio/Video Effect is never a GSL5 modifier, so it
     cannot be attached to a Lighting Clip, an empty Slot reserved by a Lighting
     Layer, or any legacy Layer whose actual Clips are mixed. Keep removal
     unguarded below so old corrupt chains can still be repaired. */
  if(scope&&(scope.kind==='clip'||scope.kind==='layer')){
    const ownerLayer=scope.kind==='layer'?scope:layer(scope.layer), domains=[
      scope.kind==='clip'&&clipStateContentDomain(clipContentStateOf(scope)),
      ownerLayer&&layerDomain(ownerLayer),
      ownerLayer&&observedLayerContentDomain(ownerLayer)
    ];
    if(domains.some(domain=>domain==='lighting'||domain==='mixed'))
      throw new RangeError('SHOWAVE Audio or Video Effects cannot be added to a Lighting Clip or Lighting Layer. Use a GSL5 Lighting Effect.');
  }
  /* A filled Clip can accept Effects only on native track components it owns.
     Empty Slots remain allowed because app.js first turns a dropped Effect into
     an Effect Clip inside the same transaction. Silently appending to an absent
     track creates a dormant chain that cannot exist in Arena or be saved by the
     v2 codec. */
  if(scope && scope.kind === 'clip' && scope.filled &&
     !hasClipTrack(scope,isAudio ? 'audio' : 'video'))
    throw new Error((isAudio?'Audio':'Video')+' track is not present on this Clip');
  /* Import preflights factories before disposing the current Composition and
     passes the resulting immutable-enough description here. That prevents a
     plug-in getter throwing only after the old document has been torn down. */
  /* effectFactoryRecord reads AUDIO_EFFECT_PARAMS for the audio role; a
     preflighted import supplies the equivalent cached record. */
  const factory=opts.factory || effectFactoryRecord(name,isAudio);
  const list = isAudio ? scope.audio.effects : scope.video.effects;
  const home = `${scope.home}/effects/${isAudio ? 'audio' : 'video'}/${list.length + 1}`;
  /* Sampled from Arena 7.27.1's live REST schema: Mask is the one video effect
     in this catalogue with mixer:null. Its image/channel operation is direct,
     so it has neither the generic effect Opacity nor Blend Mode parameters. */
  const hasVideoMixer = !isAudio && name !== 'Mask';
  const fx = {
    name, display: name, color:'none', home,
    bypassed: P({home:home+'/bypassed', name:'Bypassed', type:'bool', value:false}),
    /* "video effects always have at least two parameters: Opacity and Blend Mode" */
    opacity: hasVideoMixer ? P({home:home+'/opacity', name:'Opacity', type:'range', min:0, max:1,
                                value: opts.alt ? 0 : 1}) : null,
    blend:   hasVideoMixer ? P({home:home+'/blend', name:'Blend Mode', type:'choice',
                                options:allBlends(), value:'Alpha'}) : null,
    /* An effect that arena-fx.js actually implements declares its real
       parameters — names, ranges and defaults. Anything else falls back to the
       generic pair, and ArenaFX.has() tells the UI it will not process pixels.

       THESE GO THROUGH makeParams, NOT THROUGH type:'range'. Forcing every
       declared parameter to a range is what made two of Resolume's effects
       unshippable: Text Animator and Text Block are defined by a ParamText, and
       a 0..1 slider you cannot type into is not that parameter. The generic
       builder here now asks paramKind() the same question makeParams asks for a
       source, so an effect can declare a string, a choice, a bool or a colour
       and get a real registered parameter — addressable, animatable, mappable
       and undoable — instead of the Slice Transform's Scaling being hand-built
       by the calling window because nothing else could express it.

       Nothing changes for the effects that only have numbers: a spec with no
       kind and no node still comes back 'range', which is what they all were. */
    implemented:!!factory.implemented,
    params:makeParams(home,factory.specs || [])
  };
  if(isAudio) fx.drywet = P({home:home+'/drywet', name:'Dry/Wet', type:'range', min:0, max:1, value:1});
  const at = list.length;
  list.push(fx);
  reindexEffects(scope, isAudio);
  if(!opts.noUndo){
    const presence=effectPresenceTransition(scope,fx,at,isAudio);
    pushStructuralUndo('Add effect',presence.detach,presence.attach);
  }
  notify(fx.opacity || fx.bypassed);
  return fx;
}
/* Some effects need a parameter the generic builder above cannot express. The
   Slice Transform's Scaling is the case in point: transform.htm gives it Fill /
   Fit / Stretch / Mask / Invert Mask, which is a CHOICE, while the fallback
   builder makes everything a 0..1 range. Building it here rather than in the
   calling window matters — P() registers the parameter in REG, and being in REG
   is what makes it addressable, animatable, dashboard-linkable and writable
   through setParam like every other parameter in the composition. A literal
   object assigned from outside would look identical and be none of those. */
function addEffectParam(fx, spec){
  if(!fx || !spec || !spec.name) return null;
  const safe={home:`${fx.home}/${spec.name}`};
  Object.keys(spec).forEach(key => {
    if(!PARAM_STATE_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key))
      safe[key]=cloneEffectValue(spec[key]);
  });
  const p = P(safe);
  (fx.params = fx.params || []).push(p);
  return p;
}
function removeEffect(scope, index, audio, opts){
  opts = opts || {};
  const list = audio ? scope.audio.effects : scope.video.effects;
  index = +index;
  if(!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const fx = list[index];
  const presence=effectPresenceTransition(scope,fx,index,!!audio);
  presence.detach();
  if(!opts.noUndo) pushStructuralUndo('Remove effect',presence.attach,presence.detach);
  return fx;
}
function moveEffect(scope, from, to, audio){
  const list = audio ? scope.audio.effects : scope.video.effects;
  from = +from; to = +to;
  if(!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= list.length) return false;
  const target = clamp(to, 0, list.length - 1);
  if(from === target) return false;
  const fx = list[from];
  moveEffectObject(scope, fx, target, !!audio);
  pushStructuralUndo('Move effect',
    () => moveEffectObject(scope, fx, from, !!audio),
    () => moveEffectObject(scope, fx, target, !!audio));
  return true;
}
/* "You can copy effects from a clip, layer, group or composition to another".
   The copied item is the Effect INSTANCE, not just its plug-in name: Resolume
   carries its current settings and animation with it. Keep a detached value
   graph in the clipboard so editing the source after Copy cannot rewrite what
   Paste will produce, and clone that graph again for every Paste so two pasted
   Effects never share an envelope, palette or options array.

   Dashboard membership deliberately is not copied. A Dashboard link belongs
   to the source scope's dial.links array and assigning only p.dash on the new
   Parameter would create a one-sided, non-working link. A factory/user preset
   name is not copied either: applying a preset is a one-time settings write,
   not persistent provenance on the Effect instance. */
function cloneEffectValue(value, seen){
  if(value === null || typeof value !== 'object') return value;
  seen = seen || new Map();
  if(seen.has(value)) return seen.get(value);
  if(Array.isArray(value)){
    const out = []; seen.set(value, out);
    value.forEach(item => out.push(cloneEffectValue(item, seen)));
    return out;
  }
  const out = {}; seen.set(value, out);
  Object.keys(value).forEach(key => {
    if(!PARAM_STATE_POISON_KEYS.has(key)) out[key] = cloneEffectValue(value[key], seen);
  });
  return out;
}
const EFFECT_PARAM_RUNTIME_KEYS = new Set([
  'id','home','owner','key','onset','dash','path','group','transient','_eventPulse'
]);
function snapshotEffectParam(p){
  if(!p) return null;
  const state = {};
  Object.keys(p).forEach(key => {
    if(!EFFECT_PARAM_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key) && key !== 'name')
      state[key] = cloneEffectValue(p[key]);
  });
  return {name:p.name, state};
}
function restoreEffectParam(p, snapshot){
  if(!p || !snapshot) return p;
  Object.keys(snapshot.state || {}).forEach(key => {
    if(!EFFECT_PARAM_RUNTIME_KEYS.has(key) && !PARAM_STATE_POISON_KEYS.has(key))
      p[key] = cloneEffectValue(snapshot.state[key]);
  });
  return p;
}
function snapshotEffect(fx){
  return {
    name:fx.name,
    display:fx.display,
    color:cloneEffectValue(fx.color),
    bypassed:snapshotEffectParam(fx.bypassed),
    opacity:snapshotEffectParam(fx.opacity),
    blend:snapshotEffectParam(fx.blend),
    drywet:snapshotEffectParam(fx.drywet),
    params:(fx.params || []).map(snapshotEffectParam)
  };
}
function restoreEffect(fx, snapshot){
  if(snapshot.display !== undefined) fx.display = snapshot.display;
  if(snapshot.color !== undefined) fx.color = cloneEffectValue(snapshot.color);
  restoreEffectParam(fx.bypassed, snapshot.bypassed);
  restoreEffectParam(fx.opacity, snapshot.opacity);
  restoreEffectParam(fx.blend, snapshot.blend);
  restoreEffectParam(fx.drywet, snapshot.drywet);

  const unused = new Set((fx.params || []).map((_, index) => index));
  (snapshot.params || []).forEach((saved, savedIndex) => {
    let index = -1;
    if(unused.has(savedIndex) && fx.params[savedIndex] && fx.params[savedIndex].name === saved.name)
      index = savedIndex;
    if(index < 0) index = fx.params.findIndex((p, i) => unused.has(i) && p.name === saved.name);
    let target = index < 0 ? null : fx.params[index];
    /* A copied composition can outlive a schema update. Retain a parameter
       that no longer comes from the factory rather than silently dropping its
       saved setting; the renderer will either recognise its name or ignore it
       honestly. */
    if(!target){
      target = addEffectParam(fx, Object.assign({name:saved.name},
        cloneEffectValue(saved.state || {})));
    } else unused.delete(index);
    restoreEffectParam(target, saved);
  });
  return fx;
}
let fxClipboard = null;
function copyEffects(scope){
  if(!scope) return null;
  fxClipboard = {
    video:((scope.video && scope.video.effects) || []).map(snapshotEffect),
    audio:((scope.audio && scope.audio.effects) || []).map(snapshotEffect)
  };
  /* Do not expose the clipboard's mutable canonical graph to callers. */
  return cloneEffectValue(fxClipboard);
}
function pasteEffects(scope){
  if(!scope || !fxClipboard) return [];
  const added = [];
  transaction('Paste effects', () => {
    ['video','audio'].forEach(track => (fxClipboard[track] || []).forEach(snapshot => {
      const fx = addEffect(scope, snapshot.name, {audio:track === 'audio'});
      restoreEffect(fx, snapshot);
      added.push(fx);
    }));
  });
  return added;
}

/* =========================================================================
   13. STRUCTURE EDITS
   ========================================================================= */
function addLayer(where, ref){
  const R=layerFrom(ref);
  if(where === 'above' && R) return insertLayerAt(doc.layers.indexOf(R)+1,R,'Insert layer above');
  if(where === 'below' && R) return insertLayerAt(doc.layers.indexOf(R),R,'Insert layer below');
  return insertLayerAt(doc.layers.length,null,'New layer');
}
function insertLayerAbove(ref){ return addLayer('above',ref); }
function insertLayerBelow(ref){ return addLayer('below',ref); }
function removeLayer(ref){ return removeLayerStructural(ref); }
function moveLayer(ref, toIndex){ return moveLayerStructural(ref,toIndex); }

/* groups.htm — "A group can never be empty ... Resolume will create a new
   empty layer in its place." */
function newGroup(L){
  return createGroupForLayer(L);
}
function setLayerGroup(L, groupIndex){
  return moveLayerToGroup(L,groupIndex);
}

/* -------------------------------------------------------------------------
   Columns are structural bundles, not standalone headers.

   A Column position is encoded in four places at once: the Column object, the
   key of every Deck's Slot, each Clip's `column`, and every nested Parameter
   home. Insert/remove therefore has exactly one safe implementation: move the
   header and all of those Slots together, then rebase their addresses. Keeping
   this in the model also gives every menu gesture one structural Undo record.
   ------------------------------------------------------------------------- */
const COLUMN_GRAPH_SKIP = new Set([
  'media','live','onAcquire','onRelease','covers','playing','info','_runtime','clips'
]);
function engineParamObject(value){
  return !!(value && typeof value === 'object' && value.id != null &&
    typeof value.type === 'string' && Object.prototype.hasOwnProperty.call(value,'value'));
}
function visitColumnGraph(value, fn, seen){
  if(!value || typeof value !== 'object') return;
  seen = seen || new Set(); if(seen.has(value)) return; seen.add(value);
  if(engineParamObject(value)){ fn(value); return; }
  if(Array.isArray(value)){ value.forEach(item => visitColumnGraph(item,fn,seen)); return; }
  Object.keys(value).forEach(name => {
    if(COLUMN_GRAPH_SKIP.has(name)) return;
    visitColumnGraph(value[name],fn,seen);
  });
}
function rebaseColumnGraph(value, fromHome, toHome, seen){
  if(!value || typeof value !== 'object') return;
  seen = seen || new Set(); if(seen.has(value)) return; seen.add(value);
  if(typeof value.home === 'string' && value.home.indexOf(fromHome) === 0){
    const nextHome=toHome+value.home.slice(fromHome.length);
    if(engineParamObject(value)) retargetControlMappingParameter(value,nextHome);
    value.home=nextHome;
  }
  if(engineParamObject(value)){
    if(value.dash && typeof value.dash.home === 'string' && value.dash.home.indexOf(fromHome) === 0)
      value.dash.home=toHome+value.dash.home.slice(fromHome.length);
    return;
  }
  if(Array.isArray(value)){ value.forEach(item => rebaseColumnGraph(item,fromHome,toHome,seen)); return; }
  Object.keys(value).forEach(name => {
    if(COLUMN_GRAPH_SKIP.has(name)) return;
    rebaseColumnGraph(value[name],fromHome,toHome,seen);
  });
  /* Dashboard dial callbacks are closures over the owner's original home.
     Rebind them after a positional Layer/Clip address changes. */
  if(Array.isArray(value.dashboard) && typeof value.home === 'string')
    value.dashboard.forEach((dial,index) => {
      if(dial && dial.value) dial.value.onset=v => driveDial(value.home,index,v);
    });
}
function bundleClips(bundle){
  const out=[];
  (bundle.clips || []).forEach(byLayer => byLayer && byLayer.forEach(k => { if(k) out.push(k); }));
  return out;
}
function setBundleRegistered(bundle, on){
  visitColumnGraph(bundle.column, p => {
    if(on) REG.set(p.id,p); else if(REG.get(p.id) === p) REG.delete(p.id);
  });
  bundleClips(bundle).forEach(k => visitColumnGraph(k, p => {
    if(on) REG.set(p.id,p); else if(REG.get(p.id) === p) REG.delete(p.id);
  }));
}
function setBundleLifecycle(bundle, on){
  bundleClips(bundle).forEach(k => {
    const state=clipContentStateOf(k);
    const hook=on ? k.onAcquire : k.onRelease;
    if(typeof hook === 'function'){
      try { hook(k,state); } catch(error){ /* resource hooks report their own failure */ }
    }
  });
}
function setBundleAttached(bundle, on){
  if(on){ setBundleRegistered(bundle,true); setBundleLifecycle(bundle,true); }
  else { setBundleLifecycle(bundle,false); setBundleRegistered(bundle,false); }
}

/* -------------------------------------------------------------------------
   Layers are structural bundles too. A positional Layer index is repeated in
   the Layer home, every Deck's Slot key, every Clip home, Group membership and
   runtime selection. Resolume's REST contract explicitly says indices change
   when Layers are reordered, so all of those references move as one object
   graph and one Undo gesture. */
function layerFrom(ref){ return ref && ref.kind === 'layer' ? ref : layer(+ref); }
function currentLayerBundles(){
  return doc.layers.map(L => ({
    layer:L,
    clips:doc.decks.map(deck => {
      const byColumn=new Map();
      doc.columns.forEach(C => byColumn.set(C.index,deck.clips.get(key(L.index,C.index))));
      return byColumn;
    })
  }));
}
function makeLayerBundle(){
  const index=doc.layers.length+1;
  return {
    layer:buildLayer(index),
    clips:doc.decks.map((deck,deckIndex) => {
      const byColumn=new Map();
      doc.columns.forEach(C => byColumn.set(C.index,buildClip(index,C.index,deckIndex+1,'')));
      return byColumn;
    })
  };
}
function setLayerBundleRegistered(bundle,on,includeLayer){
  if(includeLayer !== false) visitColumnGraph(bundle.layer,p => {
    if(on) REG.set(p.id,p); else if(REG.get(p.id)===p) REG.delete(p.id);
  });
  bundleClips(bundle).forEach(k => visitColumnGraph(k,p => {
    if(on) REG.set(p.id,p); else if(REG.get(p.id)===p) REG.delete(p.id);
  }));
}
function setLayerBundleLifecycle(bundle,on){
  bundleClips(bundle).forEach(k => {
    const state=clipContentStateOf(k), hook=on?k.onAcquire:k.onRelease;
    if(typeof hook==='function'){
      try { hook(k,state); } catch(error){ /* resource hook owns its error reporting */ }
    }
  });
}
function setLayerBundleAttached(bundle,on){
  if(on){ setLayerBundleRegistered(bundle,true); setLayerBundleLifecycle(bundle,true); }
  else { setLayerBundleLifecycle(bundle,false); setLayerBundleRegistered(bundle,false); }
}
function setGroupRegistered(group,on){
  visitColumnGraph(group,p => {
    if(on) REG.set(p.id,p); else if(REG.get(p.id)===p) REG.delete(p.id);
  });
}
function layerMembershipState(){
  return doc.groups.map(g => ({group:g,members:g.layers.map(layer).filter(Boolean)}));
}
function editLayerMembership(state,edit){
  const next=state.map(record => ({group:record.group,members:record.members.slice()}));
  if(typeof edit==='function') edit(new Map(next.map(record => [record.group,record.members])));
  return next;
}
function applyLayerMembership(state,bundles){
  const current=new Set(bundles.map(bundle => bundle.layer));
  bundles.forEach(bundle => { bundle.layer.group=null; });
  const records=new Map((state||[]).map(record => [record.group,record.members]));
  doc.groups.forEach(g => {
    const wanted=new Set((records.get(g)||[]).filter(L => current.has(L)));
    const members=bundles.map(bundle => bundle.layer).filter(L => wanted.has(L));
    g.layers=members.map(L => L.index);
    members.forEach(L => { L.group=g.index; });
  });
}
function reindexLayerBundles(bundles,membership){
  doc.layers=bundles.map(bundle => bundle.layer);
  bundles.forEach((bundle,offset) => {
    const index=offset+1, L=bundle.layer, oldLayerHome=L.home;
    rebaseColumnGraph(L,oldLayerHome,'/composition/layers/'+index);
    L.index=index;
    bundle.clips.forEach((byColumn,deckIndex) => byColumn.forEach(k => {
      const oldClipHome=k.home;
      const nextHome=`/composition/decks/${deckIndex+1}/layers/${index}/clips/${k.column}`;
      rebaseColumnGraph(k,oldClipHome,nextHome);
      k.layer=index; k.deck=deckIndex+1;
    }));
  });
  doc.decks.forEach((deck,deckIndex) => {
    const next=new Map();
    bundles.forEach(bundle => bundle.clips[deckIndex] && bundle.clips[deckIndex].forEach(k => {
      if(k) next.set(key(k.layer,k.column),k);
    }));
    deck.clips=next;
  });
  applyLayerMembership(membership,bundles);
}
function layerSelectionState(){
  return {
    layer:layerFrom(doc.selection.layer) || doc.selection.layer,
    clip:doc.selection.clip,
    column:doc.selection.column,
    group:doc.selection.group,
    panel:doc.selection.panel
  };
}
function layerClipIdentity(k){
  if(!k||k.kind!=='clip') return k;
  const prototype=Object.getPrototypeOf(k);
  /* clip() represents a Persistent Clip over the active Deck with a lightweight
     prototype wrapper. Its structural identity is the persistent Slot object;
     keep the wrapper selected while that Slot still belongs to the document. */
  return prototype&&prototype.kind==='clip'?prototype:k;
}
function restoreLayerSelection(state,bundles,fallbackLayer){
  const layers=new Set(bundles.map(bundle => bundle.layer));
  const clips=new Set(); bundles.forEach(bundle => bundleClips(bundle).forEach(k => clips.add(k)));
  let selected=state.layer;
  if(selected != null){
    if(typeof selected==='number') selected=doc.layers.find(L => L.index===selected)||null;
    if(!layers.has(selected)) selected=fallbackLayer||doc.layers[doc.layers.length-1]||null;
  }
  doc.selection.layer=selected;
  doc.selection.clip=clips.has(layerClipIdentity(state.clip))?state.clip:null;
  doc.selection.column=state.column;
  doc.selection.group=state.group;
  doc.selection.panel=state.panel;
}
/* Master Layer is stored as a display label in the public parameter tree, but
   `Layer #` makes that label positional. Capture the resolved Layer object
   before a structural edit so an insert/move cannot silently retarget
   Composition or Group Autopilot to whichever Layer inherited the old label. */
function layerMasterTargetState(nodes){
  return (nodes || [doc.comp,...doc.groups]).map(node => {
    const p=node && node.autopilot && node.autopilot.masterlayer;
    if(!p) return null;
    const raw=val(p);
    return {node,target:doc.layers.find(L => displayName(L)===raw)||null,raw};
  }).filter(Boolean);
}
function remapLayerMasterTargets(state,bundles,extraNodes){
  const current=new Set(bundles.map(bundle => bundle.layer));
  const out=(state||[]).map(record => ({
    node:record.node,
    target:record.target&&current.has(record.target)?record.target:null,
    raw:record.target&&!current.has(record.target)?'None':record.raw
  }));
  (extraNodes||[]).forEach(node => out.push({node,target:null,raw:'None'}));
  return out;
}
function applyLayerMasterTargets(state){
  refreshMasterLayerOptions();
  (state||[]).forEach(record => {
    if(record.node!==doc.comp && !doc.groups.includes(record.node)) return;
    const p=record.node.autopilot&&record.node.autopilot.masterlayer; if(!p) return;
    const next=record.target&&doc.layers.includes(record.target)?displayName(record.target):(record.raw||'None');
    setParam(p,p.options.includes(next)?next:'None',{noUndo:true});
  });
}
function retireLayerRuntime(bundle){
  const clips=new Set(bundleClips(bundle));
  for(let i=pending.length-1;i>=0;i--)
    if(pending[i].node===bundle.layer || clips.has(pending[i].node)) pending.splice(i,1);
  retireClipRuntimeRefs(clips);
  bundle.layer.playing=null;
}
function switchLayerBundles(from,to,selection,membership,fallbackLayer,masterTargets){
  const fromSet=new Set(from), toSet=new Set(to);
  from.forEach(bundle => {
    if(!toSet.has(bundle)){ retireLayerRuntime(bundle); setLayerBundleAttached(bundle,false); }
  });
  reindexLayerBundles(to,membership);
  to.forEach(bundle => { if(!fromSet.has(bundle)) setLayerBundleAttached(bundle,true); });
  restoreLayerSelection(selection,to,fallbackLayer);
  if(masterTargets) applyLayerMasterTargets(masterTargets); else refreshMasterLayerOptions();
  notify(doc.comp.master);
}
function parametersInLayerBundle(bundle){
  const out=[];
  if(!bundle) return out;
  visitColumnGraph(bundle.layer,p=>{ if(!out.includes(p)) out.push(p); });
  bundleClips(bundle).forEach(k=>visitColumnGraph(k,p=>{ if(!out.includes(p)) out.push(p); }));
  return out;
}
function parametersInColumnBundle(bundle){
  const out=[];
  if(!bundle) return out;
  visitColumnGraph(bundle.column,p=>{ if(!out.includes(p)) out.push(p); });
  bundleClips(bundle).forEach(k=>visitColumnGraph(k,p=>{ if(!out.includes(p)) out.push(p); }));
  return out;
}
function parametersOnlyInBundles(from,to,reader){
  const retained=new Set(to || []), out=[];
  (from || []).forEach(bundle => {
    if(retained.has(bundle)) return;
    reader(bundle).forEach(p=>{ if(!out.includes(p)) out.push(p); });
  });
  return out;
}
function commitLayerBundles(label,before,after,beforeSelection,afterSelection,
                            beforeMembership,afterMembership,fallback){
  const beforeMaster=layerMasterTargetState();
  const afterMaster=remapLayerMasterTargets(beforeMaster,after);
  const beforeOnly=parametersOnlyInBundles(before,after,parametersInLayerBundle);
  const afterOnly=parametersOnlyInBundles(after,before,parametersInLayerBundle);
  let beforeMappings=null, afterMappings=null;
  const applyAfter=()=>{
    /* Refresh the relationship snapshot on every crossing. Mapping edits do
       not consume structural Redo, so an object restored by Undo may have
       acquired a different Keyboard/MIDI/OSC/DMX or Dashboard assignment. */
    beforeMappings=snapshotParameterMappings(beforeOnly);
    removeParameterMappings(beforeMappings);
    switchLayerBundles(before,after,afterSelection,afterMembership,fallback,afterMaster);
    restoreParameterMappings(afterMappings);
  };
  const applyBefore=()=>{
    afterMappings=snapshotParameterMappings(afterOnly);
    removeParameterMappings(afterMappings);
    switchLayerBundles(after,before,beforeSelection,beforeMembership,beforeSelection.layer,beforeMaster);
    restoreParameterMappings(beforeMappings);
  };
  applyAfter();
  pushStructuralUndo(label,applyBefore,applyAfter);
}
function mapScopeParameters(from,to,map){
  const targets=new Map();
  visitColumnGraph(to,p => targets.set(p.home.slice(to.home.length),p));
  visitColumnGraph(from,p => {
    const target=targets.get(p.home.slice(from.home.length)); if(target) map.set(p,target);
  });
}
function copyDashboardLinks(from,to,paramMap){
  if(!from||!to||!Array.isArray(from.dashboard)||!Array.isArray(to.dashboard)) return;
  from.dashboard.forEach((dial,index) => {
    const targetDial=to.dashboard[index]; if(!targetDial) return;
    targetDial.links=[];
    (dial.links||[]).forEach(link => {
      const oldTarget=REG.get(link.paramId), target=paramMap.get(oldTarget);
      /* A duplicated owner receives links to its duplicated descendants. An
         external target is intentionally not stolen from its existing
         Dashboard, because a Parameter can belong to only one Dashboard. */
      if(!target) return;
      const copied=cloneEffectValue(link)||{}; copied.paramId=target.id;
      targetDial.links.push(copied); target.dash={home:to.home,dial:index};
    });
  });
}
function cloneLayerBundle(source){
  const bundle=makeLayerBundle();
  bundle.layer.folded=!!source.layer.folded;
  bundle.layer.contentDomain=layerDomain(source.layer);
  restoreNodeParameters(bundle.layer,snapshotNodeParameters(source.layer));
  restoreEffectsFromRecord(bundle.layer,portableEffects(source.layer));
  bundle.clips.forEach((byColumn,deckIndex) => byColumn.forEach((to,columnIndex) => {
    const from=source.clips[deckIndex] && source.clips[deckIndex].get(columnIndex);
    if(!from||!to) return;
    const saved=snapshotScope(from,{content:snapshotClipContent(from)});
    restoreClipContent(to,saved.content,{skipLayerDomain:true});
    restoreNodeParameters(to,saved.parameters);
    restoreEffectsFromRecord(to,saved.effects);
  }));
  const paramMap=new Map();
  mapScopeParameters(source.layer,bundle.layer,paramMap);
  source.clips.forEach((byColumn,deckIndex) => byColumn.forEach((from,columnIndex) => {
    const to=bundle.clips[deckIndex]&&bundle.clips[deckIndex].get(columnIndex);
    if(from&&to) mapScopeParameters(from,to,paramMap);
  }));
  copyDashboardLinks(source.layer,bundle.layer,paramMap);
  source.clips.forEach((byColumn,deckIndex) => byColumn.forEach((from,columnIndex) => {
    const to=bundle.clips[deckIndex]&&bundle.clips[deckIndex].get(columnIndex);
    copyDashboardLinks(from,to,paramMap);
  }));
  /* Factory construction registers eagerly; the structural switch owns the
     first attachment so Undo/Redo can symmetrically retire the graph. */
  setLayerBundleRegistered(bundle,false);
  return bundle;
}
function membershipAdding(state,group,L){
  return editLayerMembership(state,map => {
    if(group && map.has(group) && !map.get(group).includes(L)) map.get(group).push(L);
  });
}
function createGroupForLayer(ref){
  const L=layerFrom(ref); if(!L||doc.groups.length>=COMPOSITION_LIMITS.groups) return null;
  const before=currentLayerBundles(), beforeGroups=doc.groups.slice();
  if(!before.some(bundle=>bundle.layer===L)) return null;
  const beforeMembership=layerMembershipState(), oldGroup=groupOf(L);
  const oldMembers=oldGroup?(beforeMembership.find(record=>record.group===oldGroup)||{members:[]}).members:[];
  if(oldGroup&&oldMembers.length===1&&before.length>=COMPOSITION_LIMITS.layers) return null;
  const groupIndex=beforeGroups.reduce((max,g)=>Math.max(max,g.index||0),0)+1;
  const group=buildGroup(groupIndex); setGroupRegistered(group,false);
  const afterGroups=beforeGroups.concat(group), after=before.slice();
  let afterMembership=editLayerMembership(beforeMembership,map => {
    map.forEach(members => { const index=members.indexOf(L); if(index>=0) members.splice(index,1); });
  });
  if(oldGroup&&oldMembers.length===1){
    const at=after.findIndex(bundle=>bundle.layer===L), filler=makeLayerBundle();
    setLayerBundleRegistered(filler,false); after.splice(at,0,filler);
    afterMembership=membershipAdding(afterMembership,oldGroup,filler.layer);
  }
  afterMembership=afterMembership.concat({group,members:[L]});
  const beforeSelection=layerSelectionState(), afterSelection=Object.assign({},beforeSelection);
  const beforeMaster=layerMasterTargetState([doc.comp,...beforeGroups]),
    afterMaster=remapLayerMasterTargets(beforeMaster,after,[group]);
  const addedParams=[];
  visitColumnGraph(group,p=>{ if(!addedParams.includes(p)) addedParams.push(p); });
  parametersOnlyInBundles(after,before,parametersInLayerBundle)
    .forEach(p=>{ if(!addedParams.includes(p)) addedParams.push(p); });
  let afterMappings=null;
  const applyAfter=()=>{
    doc.groups=afterGroups; setGroupRegistered(group,true);
    switchLayerBundles(before,after,afterSelection,afterMembership,L,afterMaster);
    restoreParameterMappings(afterMappings);
  };
  const applyBefore=()=>{
    afterMappings=snapshotParameterMappings(addedParams);
    removeParameterMappings(afterMappings);
    switchLayerBundles(after,before,beforeSelection,beforeMembership,beforeSelection.layer,beforeMaster);
    setGroupRegistered(group,false); doc.groups=beforeGroups;
    applyLayerMasterTargets(beforeMaster); notify(doc.comp.master);
  };
  applyAfter();
  pushStructuralUndo('New group',applyBefore,applyAfter);
  return group;
}
function insertLayerAt(position,groupRef,label){
  if(doc.layers.length>=COMPOSITION_LIMITS.layers) return null;
  const before=currentLayerBundles(), beforeMembership=layerMembershipState();
  const at=clamp(+position||0,0,before.length), bundle=makeLayerBundle();
  setLayerBundleRegistered(bundle,false);
  const after=before.slice(); after.splice(at,0,bundle);
  const group=groupRef?groupOf(layerFrom(groupRef)):null;
  const afterMembership=membershipAdding(beforeMembership,group,bundle.layer);
  const beforeSelection=layerSelectionState(), afterSelection=Object.assign({},beforeSelection);
  commitLayerBundles(label||'New layer',before,after,beforeSelection,afterSelection,
    beforeMembership,afterMembership,bundle.layer);
  return bundle.layer;
}
function duplicateLayer(ref){
  const L=layerFrom(ref); if(!L || doc.layers.length>=COMPOSITION_LIMITS.layers) return null;
  const before=currentLayerBundles(), source=before.find(bundle => bundle.layer===L);
  if(!source) return null;
  const beforeMembership=layerMembershipState(), copy=cloneLayerBundle(source);
  /* Swagger: duplicate is inserted BELOW the source. doc.layers is bottom to
     top, so the copy occupies the source's former array position. */
  const at=before.indexOf(source), after=before.slice(); after.splice(at,0,copy);
  const afterMembership=membershipAdding(beforeMembership,groupOf(L),copy.layer);
  const beforeSelection=layerSelectionState();
  const afterSelection=Object.assign({},beforeSelection,{layer:copy.layer,clip:null});
  if(beforeSelection.clip && source.clips[(beforeSelection.clip.deck||1)-1])
    afterSelection.clip=copy.clips[(beforeSelection.clip.deck||1)-1].get(beforeSelection.clip.column)||null;
  commitLayerBundles('Duplicate layer',before,after,beforeSelection,afterSelection,
    beforeMembership,afterMembership,copy.layer);
  return copy.layer;
}
function removeLayerStructural(ref){
  const L=layerFrom(ref); if(!L) return null;
  const before=currentLayerBundles(), source=before.find(bundle => bundle.layer===L);
  if(!source) return null;
  const oldGroup=groupOf(L), beforeMembership=layerMembershipState();
  const oldMembers=oldGroup ? (beforeMembership.find(record => record.group===oldGroup)||{members:[]}).members : [];
  if(before.length===1 && !oldGroup) return null;
  const at=before.indexOf(source), after=before.filter(bundle => bundle!==source);
  let replacement=null;
  let afterMembership=editLayerMembership(beforeMembership,map => {
    map.forEach(members => { const i=members.indexOf(L); if(i>=0) members.splice(i,1); });
  });
  if(oldGroup && oldMembers.length===1){
    replacement=makeLayerBundle(); setLayerBundleRegistered(replacement,false);
    after.splice(at,0,replacement);
    afterMembership=membershipAdding(afterMembership,oldGroup,replacement.layer);
  }
  if(!after.length) return null;
  const fallback=(replacement||after[Math.min(at,after.length-1)]||after[after.length-1]).layer;
  const beforeSelection=layerSelectionState();
  const removedClips=new Set(bundleClips(source));
  const afterSelection=Object.assign({},beforeSelection,{
    layer:beforeSelection.layer===L?fallback:beforeSelection.layer,
    clip:removedClips.has(beforeSelection.clip)?null:beforeSelection.clip
  });
  commitLayerBundles('Remove layer',before,after,beforeSelection,afterSelection,
    beforeMembership,afterMembership,fallback);
  return {removed:L,selected:fallback,replacement:replacement&&replacement.layer};
}
function moveLayerStructural(ref,toIndex){
  const L=layerFrom(ref); if(!L) return false;
  const before=currentLayerBundles(), from=before.findIndex(bundle => bundle.layer===L);
  if(from<0) return false;
  const after=before.slice(), bundle=after.splice(from,1)[0];
  after.splice(clamp(toIndex|0,0,after.length),0,bundle);
  if(after.every((item,index) => item===before[index])) return false;
  const membership=layerMembershipState(), selection=layerSelectionState();
  commitLayerBundles('Move layer',before,after,selection,selection,membership,membership,L);
  return L;
}
function moveLayerToGroup(ref,groupIndex){
  const L=layerFrom(ref); if(!L) return null;
  const oldGroup=groupOf(L);
  const target=groupIndex==null||+groupIndex===0 ? null : doc.groups.find(g => g.index===+groupIndex);
  if(groupIndex && !target) return null;
  if(oldGroup===target) return L;
  const before=currentLayerBundles(); if(!before.some(bundle=>bundle.layer===L)) return null;
  const beforeMembership=layerMembershipState();
  const oldMembers=oldGroup?(beforeMembership.find(record => record.group===oldGroup)||{members:[]}).members:[];
  if(oldGroup && oldMembers.length===1 && before.length>=COMPOSITION_LIMITS.layers) return null;
  const after=before.slice();
  let afterMembership=editLayerMembership(beforeMembership,map => {
    map.forEach(members => { const i=members.indexOf(L); if(i>=0) members.splice(i,1); });
    if(target && map.has(target)) map.get(target).push(L);
  });
  if(oldGroup && oldMembers.length===1){
    const at=after.findIndex(bundle => bundle.layer===L), filler=makeLayerBundle();
    setLayerBundleRegistered(filler,false); after.splice(at,0,filler);
    afterMembership=membershipAdding(afterMembership,oldGroup,filler.layer);
  }
  if(target){
    const moving=after.splice(after.findIndex(bundle => bundle.layer===L),1)[0];
    const targetMembers=new Set((afterMembership.find(record => record.group===target)||{members:[]}).members.filter(x=>x!==L));
    let at=-1; after.forEach((bundle,index) => { if(targetMembers.has(bundle.layer)) at=index; });
    after.splice(at+1,0,moving);
  }
  const selection=layerSelectionState();
  commitLayerBundles('Move to group',before,after,selection,selection,
    beforeMembership,afterMembership,L);
  return L;
}
function clipRowSelection(state,from,to){
  if(!state.clip) return state;
  const identity=layerClipIdentity(state.clip), old=bundleClips(from);
  if(!old.includes(identity)) return state;
  const deckIndex=(identity.deck||1)-1;
  return Object.assign({},state,{clip:to.clips[deckIndex]&&to.clips[deckIndex].get(identity.column)||null});
}
function switchLayerClipRows(from,to,selection){
  const oldClips=new Set(bundleClips(from));
  for(let i=pending.length-1;i>=0;i--) if(oldClips.has(pending[i].node)) pending.splice(i,1);
  retireClipRuntimeRefs(oldClips);
  setLayerBundleLifecycle(from,false); setLayerBundleRegistered(from,false,false);
  to.clips.forEach((byColumn,deckIndex) => byColumn.forEach(k => {
    const oldHome=k.home, nextHome=`/composition/decks/${deckIndex+1}/layers/${to.layer.index}/clips/${k.column}`;
    rebaseColumnGraph(k,oldHome,nextHome); k.layer=to.layer.index; k.deck=deckIndex+1;
    doc.decks[deckIndex].clips.set(key(k.layer,k.column),k);
  }));
  setLayerBundleRegistered(to,true,false); setLayerBundleLifecycle(to,true);
  doc.selection.layer=selection.layer; doc.selection.clip=selection.clip;
  doc.selection.column=selection.column; doc.selection.group=selection.group; doc.selection.panel=selection.panel;
  notify(doc.comp.master);
}
function clearLayerClips(ref){
  const L=layerFrom(ref); if(!L) return false;
  const before=currentLayerBundles().find(bundle => bundle.layer===L); if(!before) return false;
  const after={layer:L,clips:doc.decks.map((deck,deckIndex) => {
    const byColumn=new Map();
    doc.columns.forEach(C => byColumn.set(C.index,buildClip(L.index,C.index,deckIndex+1,'')));
    return byColumn;
  })};
  setLayerBundleRegistered(after,false,false);
  const beforeSelection=layerSelectionState(), afterSelection=clipRowSelection(beforeSelection,before,after);
  const beforeParams=bundleClips(before).flatMap(k=>{
    const out=[]; visitColumnGraph(k,p=>out.push(p)); return out;
  });
  const afterParams=bundleClips(after).flatMap(k=>{
    const out=[]; visitColumnGraph(k,p=>out.push(p)); return out;
  });
  let beforeMappings=null, afterMappings=null;
  const applyAfter=()=>{
    beforeMappings=snapshotParameterMappings(beforeParams);
    removeParameterMappings(beforeMappings);
    switchLayerClipRows(before,after,afterSelection);
    restoreParameterMappings(afterMappings);
  };
  const applyBefore=()=>{
    afterMappings=snapshotParameterMappings(afterParams);
    removeParameterMappings(afterMappings);
    switchLayerClipRows(after,before,beforeSelection);
    restoreParameterMappings(beforeMappings);
  };
  applyAfter();
  pushStructuralUndo('Clear layer clips',applyBefore,applyAfter);
  return true;
}
function clearLayer(ref){
  const L=layerFrom(ref); if(!L) return false;
  /* Clear is runtime state (Swagger `/clear`), so it deliberately creates no
     Undo record. A queued Clip in this Layer is part of the same pending
     playback request and must not resurrect the Layer after it was cleared. */
  for(let i=pending.length-1;i>=0;i--)
    if(pending[i].node && pending[i].node.kind==='clip' && pending[i].node.layer===L.index)
      pending.splice(i,1);
  L.playing=null; notify(L.master); return true;
}

function currentColumnBundles(){
  return doc.columns.map(C => ({
    column:C,
    clips:doc.decks.map(deck => {
      const byLayer=new Map();
      doc.layers.forEach(L => byLayer.set(L.index,deck.clips.get(key(L.index,C.index))));
      return byLayer;
    })
  }));
}
function makeColumnBundle(){
  const index=doc.columns.length + 1;
  return {
    column:buildColumn(index),
    clips:doc.decks.map((deck,deckIndex) => {
      const byLayer=new Map();
      doc.layers.forEach(L => byLayer.set(L.index,buildClip(L.index,index,deckIndex+1,'')));
      return byLayer;
    })
  };
}
function reindexColumnBundles(bundles){
  doc.columns=bundles.map(bundle => bundle.column);
  bundles.forEach((bundle,offset) => {
    const index=offset+1, C=bundle.column, oldColumnHome=C.home;
    rebaseColumnGraph(C,oldColumnHome,'/composition/columns/'+index);
    C.index=index;
    bundle.clips.forEach((byLayer,deckIndex) => byLayer.forEach(k => {
      const oldClipHome=k.home;
      const nextHome=`/composition/decks/${deckIndex+1}/layers/${k.layer}/clips/${index}`;
      rebaseColumnGraph(k,oldClipHome,nextHome);
      k.column=index; k.deck=deckIndex+1;
    }));
  });
  doc.decks.forEach((deck,deckIndex) => {
    const next=new Map();
    doc.layers.forEach(L => bundles.forEach(bundle => {
      const k=bundle.clips[deckIndex] && bundle.clips[deckIndex].get(L.index);
      if(k) next.set(key(L.index,k.column),k);
    }));
    deck.clips=next;
  });
}
function columnSelectionState(){
  const selectedColumn=columnFrom(doc.selection.column);
  return {
    layer:doc.selection.layer, clip:doc.selection.clip,
    column:selectedColumn || doc.selection.column,
    group:doc.selection.group, panel:doc.selection.panel
  };
}
function restoreColumnSelection(state, bundles, fallbackColumn){
  const columns=new Set(bundles.map(bundle => bundle.column));
  const clips=new Set(); bundles.forEach(bundle => bundleClips(bundle).forEach(k => clips.add(k)));
  let selected=state.column;
  if(selected != null){
    if(typeof selected === 'number') selected=doc.columns.find(C => C.index === selected) || null;
    if(!columns.has(selected)) selected=fallbackColumn || doc.columns[0] || null;
  }
  doc.selection.layer=state.layer;
  doc.selection.clip=clips.has(state.clip) ? state.clip : null;
  doc.selection.column=selected;
  doc.selection.group=state.group;
  doc.selection.panel=state.panel;
}
function retireClipRuntimeRefs(clips){
  doc.layers.forEach(L => {
    const playing=L.playing; if(!playing) return;
    if(clips.has(playing.clip)){ L.playing=null; return; }
    /* Removing only the frozen outgoing side of a transition must not eject
       the still-valid incoming Clip. Finish that transition in place. */
    if(clips.has(playing.transitionFrom)){
      playing.transitionFrom=null;
      playing.transitionFromPos=0;
      playing.transitionT=1;
      playing.transitionDur=0;
    }
  });
}
function retireColumnRuntime(bundle){
  const clips=new Set(bundleClips(bundle));
  for(let i=pending.length-1;i>=0;i--)
    if(pending[i].node === bundle.column || clips.has(pending[i].node)) pending.splice(i,1);
  retireClipRuntimeRefs(clips);
  bundle.column.connected.value=0;
}
function switchColumnBundles(from, to, selection, fallbackColumn){
  const fromSet=new Set(from), toSet=new Set(to);
  from.forEach(bundle => { if(!toSet.has(bundle)){ retireColumnRuntime(bundle); setBundleAttached(bundle,false); } });
  reindexColumnBundles(to);
  to.forEach(bundle => { if(!fromSet.has(bundle)) setBundleAttached(bundle,true); });
  restoreColumnSelection(selection,to,fallbackColumn);
  notify(doc.comp.master);                 // one structural invalidation, no frame readback
}
function commitColumnBundles(label, before, after, beforeSelection, afterSelection, fallback){
  const beforeOnly=parametersOnlyInBundles(before,after,parametersInColumnBundle);
  const afterOnly=parametersOnlyInBundles(after,before,parametersInColumnBundle);
  let beforeMappings=null, afterMappings=null;
  const applyAfter=()=>{
    beforeMappings=snapshotParameterMappings(beforeOnly);
    removeParameterMappings(beforeMappings);
    switchColumnBundles(before,after,afterSelection,fallback);
    restoreParameterMappings(afterMappings);
  };
  const applyBefore=()=>{
    afterMappings=snapshotParameterMappings(afterOnly);
    removeParameterMappings(afterMappings);
    switchColumnBundles(after,before,beforeSelection,beforeSelection.column);
    restoreParameterMappings(beforeMappings);
  };
  applyAfter();
  pushStructuralUndo(label,applyBefore,applyAfter);
}
function columnFrom(ref){
  return ref && ref.kind === 'column' ? ref : column(+ref);
}
function cloneColumnBundle(source){
  const bundle=makeColumnBundle();
  restoreNodeParameters(bundle.column,snapshotNodeParameters(source.column));
  /* Arena's Column menu belongs to the active Deck. The engine currently uses
     one shared Column-count topology, so other Decks receive an empty Slot at
     the new position while the active Deck receives the actual duplicate. */
  const deckIndex=doc.deck;
  doc.layers.forEach(L => {
    const from=source.clips[deckIndex] && source.clips[deckIndex].get(L.index);
    const to=bundle.clips[deckIndex] && bundle.clips[deckIndex].get(L.index);
    if(!from || !to) return;
    const saved=snapshotScope(from,{content:snapshotClipContent(from)});
    restoreClipContent(to,saved.content);
    restoreNodeParameters(to,saved.parameters);
    restoreEffectsFromRecord(to,saved.effects);
  });
  /* Factory construction registers Parameters immediately. Hold the new graph
     detached until switchColumnBundles attaches it exactly once. */
  setBundleRegistered(bundle,false);
  return bundle;
}
function columnBundlesForRefs(refs, bundles){
  bundles=bundles || currentColumnBundles();
  const wanted=new Set();
  (Array.isArray(refs) ? refs : [refs]).forEach(ref => {
    const C=columnFrom(ref); if(C) wanted.add(C);
  });
  return bundles.filter(bundle => wanted.has(bundle.column));
}
function insertColumnAt(position, copyFrom, label){
  if(doc.columns.length >= COMPOSITION_LIMITS.columns) return null;
  const before=currentColumnBundles();
  const at=clamp(+position||0,0,before.length);
  const source=copyFrom == null ? null : before.find(bundle => bundle.column === columnFrom(copyFrom));
  const bundle=source ? cloneColumnBundle(source) : makeColumnBundle();
  if(!source) setBundleRegistered(bundle,false);
  const after=before.slice(); after.splice(at,0,bundle);
  const beforeSelection=columnSelectionState();
  const afterSelection=Object.assign({},beforeSelection,{column:bundle.column});
  commitColumnBundles(label || (source?'Duplicate column':'New column'),before,after,
    beforeSelection,afterSelection,bundle.column);
  return bundle.column;
}
function addColumn(){ return insertColumnAt(doc.columns.length,null,'New column'); }
function insertColumnBefore(ref){
  const C=columnFrom(ref); if(!C) return null;
  return insertColumnAt(doc.columns.indexOf(C),null,'Insert column before');
}
function insertColumnAfter(ref){
  const C=columnFrom(ref); if(!C) return null;
  return insertColumnAt(doc.columns.indexOf(C)+1,null,'Insert column after');
}
function duplicateColumns(refs, label){
  const before=currentColumnBundles();
  const sources=columnBundlesForRefs(refs,before);
  if(!sources.length || before.length+sources.length>COMPOSITION_LIMITS.columns) return null;
  const copies=sources.map(cloneColumnBundle);
  /* Keep the selected sequence intact: duplicating A+B yields A,B,A',B', not
     A,A',B,B'. This also gives non-contiguous selections a deterministic
     document-order result. */
  const at=before.indexOf(sources[sources.length-1])+1;
  const after=before.slice(); after.splice(at,0,...copies);
  const beforeSelection=columnSelectionState();
  const afterSelection=Object.assign({},beforeSelection,{column:copies[0].column});
  commitColumnBundles(label || (copies.length===1?'Duplicate column':'Duplicate columns'),
    before,after,beforeSelection,afterSelection,copies[0].column);
  return copies.map(bundle => bundle.column);
}
function duplicateColumn(ref){
  const copies=duplicateColumns([ref],'Duplicate column');
  return copies && copies[0] || null;
}
/* Move one or more Columns as a stable document-order block. `position` is a
   boundary in the pre-move list (0 = before the first, length = after the
   last), which maps directly to the left/right half of a dropped header. */
function moveColumns(refs, position, label){
  const before=currentColumnBundles();
  const moved=columnBundlesForRefs(refs,before);
  if(!moved.length) return null;
  const movedSet=new Set(moved), boundary=clamp(position|0,0,before.length);
  const remaining=before.filter(bundle=>!movedSet.has(bundle));
  let at=remaining.length;
  for(let i=0;i<remaining.length;i++){
    if(before.indexOf(remaining[i])>=boundary){ at=i; break; }
  }
  const after=remaining.slice(); after.splice(at,0,...moved);
  if(after.every((bundle,index)=>bundle===before[index])) return null;
  const selection=columnSelectionState();
  commitColumnBundles(label || (moved.length===1?'Move column':'Move columns'),
    before,after,selection,selection,selection.column || moved[0].column);
  return moved.map(bundle=>bundle.column);
}
function removeColumns(refs, label, fallbackRef){
  const before=currentColumnBundles();
  const removed=columnBundlesForRefs(refs,before);
  if(!removed.length || before.length-removed.length<1) return null;
  const removedSet=new Set(removed);
  const after=before.filter(bundle => !removedSet.has(bundle));
  const beforeSelection=columnSelectionState();
  const fallbackBundle=fallbackRef
    ? after.find(bundle => bundle.column === columnFrom(fallbackRef))
    : (()=>{
        const first=before.indexOf(removed[0]);
        return after.find(bundle => before.indexOf(bundle)>=first) || after[after.length-1];
      })();
  const fallback=fallbackBundle ? fallbackBundle.column : after[0].column;
  const removedColumns=new Set(removed.map(bundle => bundle.column));
  const afterSelection=Object.assign({},beforeSelection,{
    column:removedColumns.has(beforeSelection.column) ? fallback : beforeSelection.column
  });
  commitColumnBundles(label || (removed.length===1?'Remove column':'Remove columns'),
    before,after,beforeSelection,afterSelection,fallback);
  return {removed:removed.map(bundle => bundle.column), selected:fallback};
}
function removeColumn(ref){
  return removeColumns([ref],'Remove column');
}
function removeColumnsBefore(ref){
  const C=columnFrom(ref); if(!C) return null;
  const at=doc.columns.indexOf(C);
  return removeColumns(doc.columns.slice(0,at),'Remove all columns before',C);
}
function removeColumnsAfter(ref){
  const C=columnFrom(ref); if(!C) return null;
  const at=doc.columns.indexOf(C);
  return removeColumns(doc.columns.slice(at+1),'Remove all columns after',C);
}
function clearColumns(refs, deckIndex, label){
  const columns=columnBundlesForRefs(refs).map(bundle => bundle.column);
  if(!columns.length) return false;
  const deck=doc.decks[deckIndex == null ? doc.deck : clamp(deckIndex|0,0,doc.decks.length-1)];
  if(!deck) return false;
  /* Use direct Slot entries. clip() may return a Persistent-Clip overlay from
     another Deck, which is intentionally not the thing Clear Clips removes. */
  const targets=[];
  columns.forEach(C => doc.layers.forEach(L => {
    const k=deck.clips.get(key(L.index,C.index));
    if(k && (k.filled || k.source || k.media || k.live || k.unavailableLive || k.sourceFile))
      targets.push(k);
  }));
  if(!targets.length) return false;
  transaction(label || (columns.length===1?'Clear column':'Clear columns'), () => targets.forEach(k => replaceClipContent(k,{
    name:'',filled:false,source:null,media:null,sourceFile:null,
    live:null,unavailableLive:null,onAcquire:null,onRelease:null,info:null
  },{label:'Clear clip'})));
  const cleared=new Set(targets);
  retireClipRuntimeRefs(cleared);
  return true;
}
function clearColumn(ref, deckIndex){ return clearColumns([ref],deckIndex,'Clear column'); }

/* -------------------------------------------------------------------------
   DECKS - the third structural container, and the shallowest of the three: a
   Deck OWNS its Clip Slots, so the "bundle" is the Deck object itself rather
   than the {column, clips[]} pairing Columns need.

   decks.htm > Organising Decks governs all of it, and is explicit that Close,
   Clear Clips and Remove are three DIFFERENT operations:
     "Closing a deck will remove a deck from view, but keep its contents intact
      and it will remain part of the composition. It will remain closed until
      you open it again."
     "Clear Clips will clear a deck of all its contents, but keeps the empty
      deck open."
     "Removing a deck will delete it in its entirety."
   So Close writes one boolean and touches nothing else; Clear replaces clip
   content and leaves `closed` alone; only Remove splices and renumbers.

   doc.deck is a 0-BASED array index, not a deck number. Any splice that does
   not re-derive it retargets clip(), clipSlot(), duplicateClip() and
   clearColumns() at the wrong Deck, so selection is captured and restored BY
   OBJECT and never carried across an edit as a number.
   ------------------------------------------------------------------------- */
function deckFrom(ref){
  if(ref && ref.kind === 'deck') return ref;
  if(ref == null) return doc.decks[doc.deck] || null;
  const n = +ref;                          /* 1-BASED, as columnFrom is */
  return Number.isInteger(n) ? (doc.decks.find(d => d.index === n) || null) : null;
}
function deckClipList(deck){ return deck && deck.clips ? [...deck.clips.values()] : []; }
function currentDeckBundles(){ return doc.decks.slice(); }
function deckSelectionState(){
  return {
    deck:doc.decks[doc.deck] || null,
    layer:doc.selection.layer,
    clip:doc.selection.clip,
    column:doc.selection.column,
    group:doc.selection.group,
    panel:doc.selection.panel
  };
}
function parametersInDeckBundle(deck){
  const out=[];
  if(!deck) return out;
  const add=p => { if(!out.includes(p)) out.push(p); };
  visitColumnGraph(deck,add);
  deckClipList(deck).forEach(k => visitColumnGraph(k,add));
  return out;
}
function setDeckRegistered(deck,on){
  const mark = p => { if(on) REG.set(p.id,p); else if(REG.get(p.id)===p) REG.delete(p.id); };
  visitColumnGraph(deck,mark);
  deckClipList(deck).forEach(k => visitColumnGraph(k,mark));
}
function setDeckAttached(deck,on){
  if(on){ setDeckRegistered(deck,true); deckClipList(deck).forEach(k => setClipGraphLifecycle(k,true)); }
  else { deckClipList(deck).forEach(k => setClipGraphLifecycle(k,false)); setDeckRegistered(deck,false); }
}
function makeDeck(name){
  const deck=buildDeck(doc.decks.length+1,name);   /* reindex owns the final home */
  doc.layers.forEach(L => doc.columns.forEach(C =>
    deck.clips.set(key(L.index,C.index), buildClip(L.index,C.index,deck.index,''))));
  setDeckRegistered(deck,false);   /* factories register eagerly; attach once, in switchDeckBundles */
  return deck;
}
function cloneDeckBundle(source){
  /* Name comes from restoreNodeParameters below, so the copy carries the
     source's name - the same behaviour cloneColumnBundle gives a duplicated
     Column. decks.htm does not say whether Arena appends a suffix. */
  const deck=buildDeck(doc.decks.length+1, val(source.name));
  restoreNodeParameters(deck,snapshotNodeParameters(source));
  /* Deep copy every Clip graph. A shallow copy would leave the two Decks
     sharing Parameter objects - and therefore one REG id and one OSC home
     answering for both - and would leave video.resize.owner pointing at the
     SOURCE clip, so Resize on the duplicate would fire on the original.
     cloneClipGraph is the helper that gets both right. */
  /* cloneClipGraph returns a RECORD {clip,paramMap,mappings}, not the clip, and
     its deckIndex argument is 0-BASED - it does buildClip(...,deckIndex+1).
     The mapping snapshots have to survive until the graph is attached, exactly
     as duplicateClip defers built.mappings, or the copy loses the MIDI/OSC/DMX
     assignments it inherited from the source. */
  const pendingMappings=[];
  doc.layers.forEach(L => doc.columns.forEach(C => {
    const from=source.clips.get(key(L.index,C.index));
    if(!from) return;
    const built=cloneClipGraph(from,deck.index-1,L.index,C.index);
    deck.clips.set(key(L.index,C.index), built.clip);
    if(built.mappings) pendingMappings.push(built.mappings);
  }));
  if(pendingMappings.length)
    Object.defineProperty(deck,'_pendingMappings',{value:pendingMappings,configurable:true,writable:true});
  setDeckRegistered(deck,false);
  return deck;
}
function reindexDeckBundles(bundles){
  doc.decks=bundles;
  bundles.forEach((deck,offset) => {
    const index=offset+1, oldHome=deck.home;
    rebaseColumnGraph(deck,oldHome,'/composition/decks/'+index);
    deck.index=index;
    /* The Slot key is layer:column and carries no Deck token, so unlike
       reindexColumnBundles the Map itself is NOT rebuilt - only the Clip homes
       and their back-references move. */
    deck.clips.forEach(k => {
      rebaseColumnGraph(k,k.home,
        `/composition/decks/${index}/layers/${k.layer}/clips/${k.column}`);
      k.deck=index;
    });
  });
}
function restoreDeckSelection(selection,bundles,fallback){
  const wanted=selection && selection.deck;
  let at=wanted ? bundles.indexOf(wanted) : -1;
  if(at<0 && fallback) at=bundles.indexOf(fallback);
  if(at<0) at=clamp(doc.deck,0,bundles.length-1);
  /* Never land on a closed Deck: decks.htm says a closed Deck is out of view. */
  if(bundles[at] && bundles[at].closed){
    const open=bundles.findIndex(d => !d.closed);
    if(open>=0) at=open;
  }
  doc.deck=clamp(at,0,Math.max(0,bundles.length-1));
  const clips=new Set();
  bundles.forEach(deck=>deckClipList(deck).forEach(k=>clips.add(k)));
  const selected=selection&&selection.clip;
  doc.selection.layer=selection&&selection.layer || null;
  doc.selection.clip=selected&&clips.has(layerClipIdentity(selected))?selected:null;
  doc.selection.column=selection&&selection.column || null;
  doc.selection.group=selection&&selection.group || null;
  doc.selection.panel=selection&&selection.panel || 'pLayer';
}
function deckClipSelection(state,from,to){
  if(!state||!state.clip||!from||!to) return state;
  const selected=layerClipIdentity(state.clip);
  if(!deckClipList(from).includes(selected)) return Object.assign({},state,{clip:null});
  return Object.assign({},state,{clip:to.clips.get(key(selected.layer,selected.column))||null});
}
function retireDeckRuntime(deck){
  const clips=new Set(deckClipList(deck));
  for(let i=pending.length-1;i>=0;i--)
    if(pending[i].node===deck || clips.has(pending[i].node)) pending.splice(i,1);
  retireClipRuntimeRefs(clips);
}
function switchDeckBundles(from,to,selection,fallback){
  const fromSet=new Set(from), toSet=new Set(to);
  from.forEach(deck => { if(!toSet.has(deck)){ retireDeckRuntime(deck); setDeckAttached(deck,false); } });
  reindexDeckBundles(to);
  to.forEach(deck => {
    if(fromSet.has(deck)) return;
    setDeckAttached(deck,true);
    /* A duplicated Deck's clip mappings are restored once, after attach - the
       same ordering duplicateClip uses. */
    if(deck._pendingMappings){
      deck._pendingMappings.forEach(restoreParameterMappings);
      delete deck._pendingMappings;
    }
  });
  restoreDeckSelection(selection,to,fallback);
  notify(doc.comp.master);                 // one structural invalidation
}
function commitDeckBundles(label,before,after,beforeSelection,afterSelection,fallback){
  const beforeOnly=parametersOnlyInBundles(before,after,parametersInDeckBundle);
  const afterOnly=parametersOnlyInBundles(after,before,parametersInDeckBundle);
  let beforeMappings=null, afterMappings=null;
  const applyAfter=()=>{
    beforeMappings=snapshotParameterMappings(beforeOnly);
    removeParameterMappings(beforeMappings);
    switchDeckBundles(before,after,afterSelection,fallback);
    restoreParameterMappings(afterMappings);
  };
  const applyBefore=()=>{
    afterMappings=snapshotParameterMappings(afterOnly);
    removeParameterMappings(afterMappings);
    switchDeckBundles(after,before,beforeSelection,beforeSelection.deck);
    restoreParameterMappings(beforeMappings);
  };
  applyAfter();
  pushStructuralUndo(label,applyBefore,applyAfter);
}
function insertDeckAt(position,copyFrom,label){
  if(doc.decks.length >= COMPOSITION_LIMITS.decks) return null;
  const before=currentDeckBundles();
  const at=clamp(+position||0,0,before.length);
  const source=copyFrom == null ? null : deckFrom(copyFrom);
  const deck=source ? cloneDeckBundle(source) : makeDeck(null);
  const after=before.slice(); after.splice(at,0,deck);
  const beforeSelection=deckSelectionState();
  const afterSelection=source
    ? Object.assign({},deckClipSelection(beforeSelection,source,deck),{deck})
    : Object.assign({},beforeSelection,{deck,clip:null});
  commitDeckBundles(label || (source?'Duplicate deck':'New deck'),before,after,
    beforeSelection,afterSelection,deck);
  return deck;
}
/* "The New option adds the new deck to the end of the list while the Insert
   option adds it before or after the currently selected deck." [decks.htm] */
function addDeck(){ return insertDeckAt(doc.decks.length,null,'New deck'); }
function insertDeckBefore(ref){
  const D=deckFrom(ref); if(!D) return null;
  return insertDeckAt(doc.decks.indexOf(D),null,'Insert deck before');
}
function insertDeckAfter(ref){
  const D=deckFrom(ref); if(!D) return null;
  return insertDeckAt(doc.decks.indexOf(D)+1,null,'Insert deck after');
}
function duplicateDeck(ref){
  const D=deckFrom(ref); if(!D) return null;
  return insertDeckAt(doc.decks.indexOf(D)+1,D,'Duplicate deck');
}
/* decks.htm documents drag reordering. `toIndex` is the Deck's final 0-based
   array position, matching moveLayer(); the Deck and every owned Clip keep
   object identity while their positional REST/OSC homes are rebased. */
function moveDeck(ref,toIndex){
  const D=deckFrom(ref); if(!D) return false;
  const before=currentDeckBundles(), from=before.indexOf(D); if(from<0) return false;
  const after=before.slice(), deck=after.splice(from,1)[0];
  after.splice(clamp(toIndex|0,0,after.length),0,deck);
  if(after.every((item,index)=>item===before[index])) return false;
  const selection=deckSelectionState();
  commitDeckBundles('Move deck',before,after,selection,selection,D);
  return D;
}
function renameDeck(ref,name){
  const D=deckFrom(ref); if(!D) return false;
  const next=String(name==null?'':name).trim();
  if(!next || next===val(D.name)) return false;
  transaction('Rename deck',()=>setParam(D.name.id,next));
  return true;
}
/* "Removing a deck will delete it in its entirety." [decks.htm]
   UNDOCUMENTED - inferring: a Composition keeps at least one Deck. decks.htm
   states no minimum, but "when you select a deck, all of the clips in the deck
   are displayed in their layers" has no meaning with none, and the clip grid
   has nothing to draw. */
function removeDeck(ref){
  const D=deckFrom(ref); if(!D || doc.decks.length<=1) return false;
  const before=currentDeckBundles();
  const at=before.indexOf(D); if(at<0) return false;
  const after=before.slice(); after.splice(at,1);
  const fallback=after[Math.min(at,after.length-1)], beforeSelection=deckSelectionState();
  const removedClips=new Set(deckClipList(D));
  const afterSelection=Object.assign({},beforeSelection,{
    deck:fallback,
    clip:removedClips.has(layerClipIdentity(beforeSelection.clip))?null:beforeSelection.clip
  });
  commitDeckBundles('Remove deck',before,after,beforeSelection,afterSelection,fallback);
  return true;
}
/* Close is NOT Remove. The Deck stays in doc.decks, keeps its 1-based index,
   keeps its Clips registered, and its Parameters keep answering at their home -
   which is exactly what re-opening by index requires. One boolean, wrapped in a
   transaction because `closed` is serialized composition state and undo.htm
   makes composition state undoable. */
function setDeckClosed(ref,closed){
  const D=deckFrom(ref); if(!D) return false;
  const next=!!closed;
  if(D.closed===next) return false;
  if(next && doc.decks.filter(d => !d.closed).length<=1) return false;   /* keep one open */
  /* pushStructuralUndo, NOT transaction(). transaction() records Parameter
     writes, and `closed` is deliberately a plain boolean - so wrapping this in
     a transaction recorded nothing and Close was silently un-undoable: the next
     Undo skipped past it and popped the previous entry instead. `closed` is
     serialized by snapshotCompositionState, which makes it composition state,
     and undo.htm makes composition state undoable. */
  const prevClosed=D.closed, beforeSelection=deckSelectionState();
  const hiddenClips=new Set(deckClipList(D));
  const fallback=next && beforeSelection.deck===D
    ? doc.decks.find(deck=>deck!==D&&!deck.closed) : beforeSelection.deck;
  const afterSelection=Object.assign({},beforeSelection,{
    deck:fallback,
    clip:next&&hiddenClips.has(layerClipIdentity(beforeSelection.clip))?null:beforeSelection.clip
  });
  const apply=()=>{
    D.closed=next;
    restoreDeckSelection(afterSelection,doc.decks,fallback);
    notify(doc.comp.master);
  };
  const revert=()=>{
    D.closed=prevClosed;
    restoreDeckSelection(beforeSelection,doc.decks,beforeSelection.deck);
    notify(doc.comp.master);
  };
  apply();
  pushStructuralUndo(next?'Close deck':'Open deck',revert,apply);
  return true;
}
function closeDeck(ref){ return setDeckClosed(ref,true); }
function openDeck(ref){ return setDeckClosed(ref,false); }
/* "Clear Clips will clear a deck of all its contents, but keeps the empty deck
   open." [decks.htm] - so this must not touch `closed`. Note the axis: this is
   all layers x all columns of ONE deck, the transpose of clearLayerClips. */
function clearDeckClips(ref){
  const D=deckFrom(ref); if(!D) return false;
  const targets=deckClipList(D).filter(k =>
    k && (k.filled || k.source || k.media || k.live || k.unavailableLive || k.sourceFile));
  if(!targets.length) return false;
  transaction('Clear deck clips',()=>targets.forEach(k => replaceClipContent(k,{
    name:'',filled:false,source:null,media:null,sourceFile:null,
    live:null,unavailableLive:null,onAcquire:null,onRelease:null,info:null
  },{label:'Clear clip'})));
  retireClipRuntimeRefs(new Set(targets));
  return true;
}

/* -------------------------------------------------------------------------
   Clip Slot drag/drop.

   A Clip is not only its media descriptor. It owns Parameter objects, two
   Effect chains, a Dashboard, shortcut mappings and (for capture Sources) a
   live-resource lifecycle. Moving only `filled/name/media`, as an early UI
   prototype did, leaves the old Effects and mappings behind and can keep a
   camera leased from a Slot that now looks empty.

   Keep the operation structural and in the engine:
     - a normal drag swaps the complete Slot graphs (an empty destination is
       simply the usual move case);
     - a duplicate builds a fresh, independent graph and replaces the target;
     - one structural Undo crosses the whole operation;
     - moving never releases/reacquires a resource, while replacing retires the
       displaced graph exactly once and reactivates it on Undo.

   clips.htm documents drag-loading and the Clip's complete state, and the
   shortcut table documents Ctrl-drag on Windows / Option-drag on macOS for
   duplication. Occupied-target swap/replace is not documented there. The
   least-destructive inferred contract is therefore swap for Move and Replace
   (with Undo) for Duplicate.                                                     */
function clipSlot(l,c,deckIndex){
  const index=deckIndex==null?doc.deck:(deckIndex|0), deck=doc.decks[index];
  return deck ? deck.clips.get(key(+l,+c)) || null : null;
}
function clipGraphParams(k){
  const out=[];
  visitColumnGraph(k,p=>{ if(!out.includes(p)) out.push(p); });
  return out;
}
function setClipGraphRegistered(k,on){
  visitColumnGraph(k,p=>{
    if(on) REG.set(p.id,p);
    else if(REG.get(p.id)===p) REG.delete(p.id);
  });
}
function setClipGraphLifecycle(k,on){
  if(!k) return;
  const state=clipContentStateOf(k), hook=on?k.onAcquire:k.onRelease;
  if(typeof hook==='function'){
    try { hook(k,state); } catch(error){ /* resource hook reports its own failure */ }
  }
}
function setClipGraphAttached(k,on){
  if(on){ setClipGraphRegistered(k,true); setClipGraphLifecycle(k,true); }
  else { setClipGraphLifecycle(k,false); setClipGraphRegistered(k,false); }
}
function clipSlotSelectionState(){
  return {layer:doc.selection.layer,clip:doc.selection.clip,column:doc.selection.column,
    group:doc.selection.group,panel:doc.selection.panel};
}
function clipGraphInDocument(k){
  const own=layerClipIdentity(k);
  return doc.decks.some(deck=>[...deck.clips.values()].some(candidate=>candidate===own));
}
function restoreClipSlotSelection(state,fallback){
  let selected=state&&state.clip;
  if(selected&&!clipGraphInDocument(selected))
    selected=fallback&&clipGraphInDocument(fallback)?fallback:null;
  doc.selection.clip=selected;
  if(selected){
    doc.selection.layer=layer(selected.layer)||state.layer;
    doc.selection.column=column(selected.column)||state.column;
  } else {
    doc.selection.layer=state.layer;
    doc.selection.column=state.column;
  }
  doc.selection.group=state.group;
  doc.selection.panel=state.panel;
}
function rehomeClipGraph(k,deckIndex,layerIndex,columnIndex){
  const oldHome=k.home,
    nextHome=`/composition/decks/${deckIndex+1}/layers/${layerIndex}/clips/${columnIndex}`;
  rebaseColumnGraph(k,oldHome,nextHome);
  k.deck=deckIndex+1; k.layer=layerIndex; k.column=columnIndex;
}
function swapClipGraphPositions(deck,deckIndex,a,b){
  const ap={layer:a.layer,column:a.column}, bp={layer:b.layer,column:b.column};
  deck.clips.delete(key(ap.layer,ap.column));
  deck.clips.delete(key(bp.layer,bp.column));
  rehomeClipGraph(a,deckIndex,bp.layer,bp.column);
  rehomeClipGraph(b,deckIndex,ap.layer,ap.column);
  deck.clips.set(key(a.layer,a.column),a);
  deck.clips.set(key(b.layer,b.column),b);
  /* Map insertion order is part of the portable document's deterministic
     Clip array. Replacing two keys must not make save/reload reorder Slots. */
  const ordered=new Map();
  doc.layers.forEach(L=>doc.columns.forEach(C=>{
    const k=deck.clips.get(key(L.index,C.index)); if(k) ordered.set(key(L.index,C.index),k);
  }));
  deck.clips=ordered;
}
function layerDomainAfterIncoming(L,state,verb){
  const before=L&&L.contentDomain||'unassigned';
  const current=L&&layerDomain(L)||'unassigned';
  const incoming=assertLayerAcceptsContent(L,state,verb);
  if(before!=='unassigned'&&LAYER_CONTENT_DOMAINS.includes(before)) return before;
  if(current!=='unassigned'&&LAYER_CONTENT_DOMAINS.includes(current)) return current;
  return incoming||'unassigned';
}
function assertClipLayerDomainTransfer(source,target,fromRef,toRef,copy){
  const from=layerFrom(fromRef),to=layerFrom(toRef);
  if(!source||!target||!from||!to) throw new RangeError('The Clip transfer target is unavailable.');
  const fromBefore=from.contentDomain||'unassigned',toBefore=to.contentDomain||'unassigned';
  if(from===to) return {from,to,fromBefore,toBefore,fromAfter:fromBefore,toAfter:toBefore};
  const verb=copy?'Duplicating this Clip':'Moving this Clip';
  return {from,to,fromBefore,toBefore,
    fromAfter:copy?fromBefore:layerDomainAfterIncoming(from,clipContentStateOf(target),verb),
    toAfter:layerDomainAfterIncoming(to,clipContentStateOf(source),verb)};
}
function moveClip(fromLayer,fromColumn,toLayer,toColumn,opts){
  opts=opts||{};
  const deckIndex=opts.deck==null?doc.deck:(opts.deck|0), deck=doc.decks[deckIndex];
  if(!deck) return null;
  const source=clipSlot(fromLayer,fromColumn,deckIndex),
    target=clipSlot(toLayer,toColumn,deckIndex);
  if(!source||!target||!source.filled) return null;
  if(source===target) return {clip:source,displaced:null,swapped:false,noOp:true};
  const transfer=assertClipLayerDomainTransfer(source,target,+fromLayer,+toLayer,false);
  const sourceLayer=transfer.from,targetLayer=transfer.to,
    sourceDomainBefore=transfer.fromBefore,targetDomainBefore=transfer.toBefore,
    sourceDomainAfter=transfer.fromAfter,targetDomainAfter=transfer.toAfter;
  const beforeSelection=clipSlotSelectionState();
  const afterSelection=Object.assign({},beforeSelection,{clip:source,
    layer:layer(+toLayer),column:column(+toColumn)});
  const applyAfter=()=>{
    if(sourceLayer!==targetLayer){
      sourceLayer.contentDomain=sourceDomainAfter||'unassigned'; targetLayer.contentDomain=targetDomainAfter||'unassigned';
    }
    swapClipGraphPositions(deck,deckIndex,source,target);
    restoreClipSlotSelection(afterSelection,source);
    notify(doc.comp.master);
  };
  const applyBefore=()=>{
    swapClipGraphPositions(deck,deckIndex,source,target);
    if(sourceLayer!==targetLayer){
      sourceLayer.contentDomain=sourceDomainBefore; targetLayer.contentDomain=targetDomainBefore;
    }
    restoreClipSlotSelection(beforeSelection,source);
    notify(doc.comp.master);
  };
  applyAfter();
  pushStructuralUndo(opts.label||'Move clip',applyBefore,applyAfter);
  return {clip:source,displaced:target,swapped:!!target.filled,noOp:false};
}

function cloneLiveDescriptor(live){
  if(!live||typeof live!=='object') return null;
  const copy={};
  Object.keys(live).forEach(name=>{
    if(name==='stream'||name==='capture') return;
    const value=live[name];
    if(typeof value!=='function') copy[name]=cloneEffectValue(value);
  });
  copy.state='opening'; copy.error=null; copy.stream=null; copy.capture=null;
  return copy;
}
let presentationMediaCopySerial=0;
function cloneClipMediaDescriptor(media){
  if(!media||typeof media!=='object'||!media.presentation) return media;
  const presentation=media.presentation;
  const pages=Array.isArray(presentation.pages)
    ? presentation.pages.map(page=>Object.assign({},page)) : [];
  /* A duplicated document is a new Presentation Clip instance, not a second
     reference to the same performance state. Keep the immutable File/blob
     resources shared, preserve the currently shown slide, and isolate every
     mutable descriptor the clicker changes. */
  const copy=Object.assign({},media,{
    id:'presentation-clip:engine-copy-'+(++presentationMediaCopySerial),
    libraryId:media.libraryId||media.id,
    presentation:Object.assign({},presentation,{pages})
  });
  if(presentation.player){
    copy.presentation.player=presentation.player.fork();
    const player=copy.presentation.player;documentPresentationPlayers.add(player);
    copy._presentationUnsubscribe=player.subscribe(()=>{
      const frame=player.frame();if(frame){copy.width=frame.width;copy.height=frame.height;}
      copy.presentation.current=Math.max(0,player.state().index);
      copy.sourceRevision=(Number(copy.sourceRevision)||0)+1;
      window.ArenaMedia?.touch?.();
    });
  }
  return copy;
}
function duplicateClipMappingSnapshot(source,paramMap){
  const sourceIds=new Set(paramMap.keys()), targets=[...paramMap.values()];
  const targetIds=new Set(targets.map(p=>p.id)), dials=[];
  dashboardOwners().forEach(owner=>{
    /* The duplicate already owns an independent copy of its own Dashboard.
       Only copy relationships from Dashboards outside the source Clip here. */
    if(owner===source) return;
    (owner.dashboard||[]).forEach((dial,index)=>{
      const links=(dial.links||[]).filter(link=>sourceIds.has(REG.get(+link.paramId)))
        .map(link=>{
          const target=paramMap.get(REG.get(+link.paramId));
          if(!target) return null;
          const copied=cloneEffectValue(link)||{}; copied.paramId=target.id; return copied;
        }).filter(Boolean);
      if(links.length) dials.push({dial,index,nameState:snapshotParameterState(dial.name),links});
    });
  });
  const controls=[];
  controlMappings.slice().forEach(record=>{
    const from=REG.get(+record._targetId)||parameterByHome(record.targetHome), target=paramMap.get(from);
    if(!target) return;
    const copy=cloneControlMapping(record); copy.id=nextControlMappingId();
    const oldHome=copy.targetHome; copy.targetHome=target.home; copy._targetId=target.id;
    if(copy.kind==='osc'){
      if(copy.address===oldHome) copy.address=target.home;
      if(copy.outputAddress===oldHome) copy.outputAddress=target.home;
    }
    controls.push(copy);
  });
  return {ids:targetIds,dials,controls,params:targets.map((p,index)=>{
    const from=[...paramMap.keys()][index];
    return {p,dash:cloneEffectValue(p.dash||from&&from.dash)};
  })};
}
function cloneClipGraph(source,deckIndex,layerIndex,columnIndex){
  const copy=buildClip(layerIndex,columnIndex,deckIndex+1,'');
  const state=clipContentStateOf(source);
  if(source.source){
    restoreClipContent(copy,snapshotClipContent(source),{skipLayerDomain:true});
  } else {
    replaceClipContent(copy,{
      name:state.name,filled:state.filled,source:null,media:cloneClipMediaDescriptor(state.media),
      sourceFile:state.sourceFile,live:cloneLiveDescriptor(state.live),
      unavailableLive:cloneEffectValue(state.unavailableLive),
      onAcquire:null,onRelease:null,info:cloneEffectValue(state.info),
      tracks:cloneEffectValue(state.tracks),trackDeclarations:cloneEffectValue(state._trackDeclarations),
      duration:state.duration,beats:state.beats
    },{noUndo:true,skipLayerDomain:true});
    /* Install hooks only after the detached graph is complete. Its first real
       attachment below acquires exactly one lease. */
    copy.onAcquire=state.onAcquire; copy.onRelease=state.onRelease;
  }
  restoreNodeParameters(copy,snapshotNodeParameters(source));
  restoreEffectsFromRecord(copy,portableEffects(source));
  const paramMap=new Map(); mapScopeParameters(source,copy,paramMap);
  copyDashboardLinks(source,copy,paramMap);
  const mappings=duplicateClipMappingSnapshot(source,paramMap);
  /* buildClip/Source/Effect factories register eagerly. Park the graph until
     the structural switch so target and copy never answer at the same home. */
  setClipGraphRegistered(copy,false);
  return {clip:copy,paramMap,mappings};
}
function retireOneClipRuntime(k){
  for(let i=pending.length-1;i>=0;i--) if(pending[i].node===k) pending.splice(i,1);
  retireClipRuntimeRefs(new Set([k]));
}
function duplicateClip(fromLayer,fromColumn,toLayer,toColumn,opts){
  opts=opts||{};
  const deckIndex=opts.deck==null?doc.deck:(opts.deck|0), deck=doc.decks[deckIndex];
  if(!deck) return null;
  const source=clipSlot(fromLayer,fromColumn,deckIndex),
    target=clipSlot(toLayer,toColumn,deckIndex);
  if(!source||!target||!source.filled) return null;
  if(source===target) return {clip:source,displaced:null,replaced:false,noOp:true};
  const transfer=assertClipLayerDomainTransfer(source,target,+fromLayer,+toLayer,true);
  const targetLayer=transfer.to,targetDomainBefore=transfer.toBefore,targetDomainAfter=transfer.toAfter;
  const built=cloneClipGraph(source,deckIndex,+toLayer,+toColumn), copy=built.clip;
  const targetParams=clipGraphParams(target), copyParams=clipGraphParams(copy);
  const beforeSelection=clipSlotSelectionState();
  const afterSelection=Object.assign({},beforeSelection,{clip:copy,
    layer:layer(+toLayer),column:column(+toColumn)});
  let targetMappings=null, copyMappings=built.mappings;
  const applyAfter=()=>{
    targetMappings=snapshotParameterMappings(targetParams);
    removeParameterMappings(targetMappings);
    retireOneClipRuntime(target);
    setClipGraphAttached(target,false);
    deck.clips.set(key(+toLayer,+toColumn),copy);
    targetLayer.contentDomain=targetDomainAfter||'unassigned';
    setClipGraphAttached(copy,true);
    restoreParameterMappings(copyMappings);
    restoreClipSlotSelection(afterSelection,copy);
    notify(doc.comp.master);
  };
  const applyBefore=()=>{
    copyMappings=snapshotParameterMappings(copyParams);
    removeParameterMappings(copyMappings);
    retireOneClipRuntime(copy);
    setClipGraphAttached(copy,false);
    deck.clips.set(key(+toLayer,+toColumn),target);
    targetLayer.contentDomain=targetDomainBefore;
    setClipGraphAttached(target,true);
    restoreParameterMappings(targetMappings);
    restoreClipSlotSelection(beforeSelection,target);
    notify(doc.comp.master);
  };
  applyAfter();
  pushStructuralUndo(opts.label||'Duplicate clip',applyBefore,applyAfter);
  return {clip:copy,displaced:target,replaced:!!target.filled,noOp:false};
}
function loadClip(l, c, name){
  const k = clip(l, c); if(!k) return null;
  transaction('Load clip', () => { setParam(k.name, name); k.filled = !!name; });
  return k;
}

/* A Source is clip content, not an Effect. Replacing one therefore swaps the
   clip's content record while leaving its Effect chains alone. app.js used to
   assign k.source directly inside a parameter transaction: Undo changed only
   the clip name, the new generator kept rendering, and every parameter from
   the replaced generator remained in REG where OSC/MIDI could still address
   it. Keep the structural state and the parameter registry in one operation.

   The caller builds `source.params` with makeParams() before entering here;
   those parameters are already registered. Applying either snapshot makes
   exactly that snapshot's Source parameters live and unregisters the other
   one. When called inside transaction(), this structural record and all
   preset parameter writes form one undo entry. */
function sourceParamsOn(source, on){
  ((source && source.params) || []).forEach(p => {
    if(!p || p.id == null) return;
    if(on) REG.set(p.id, p); else REG.delete(p.id);
  });
}

/* clips.htm > Show & Strip / Clip Properties.

   A Clip may carry Video, Audio, or both. The decoder/media descriptor remains
   shared because an AV file is one piece of content, while these booleans say
   which native Clip track components are still present. `_presentDeclared`
   distinguishes an intentional Strip from old/directly-seeded Clips whose
   media metadata arrived after buildClip(). That lets legacy callers be
   inferred without ever resurrecting a track the user explicitly removed. */
const CLIP_TRACK_NAMES = Object.freeze(['audio','video']);
function clipTrackName(track){
  const name=String(track || '').toLowerCase();
  if(!CLIP_TRACK_NAMES.includes(name)) throw new TypeError('Clip track must be audio or video');
  return name;
}
function clipTrackBoolean(record, track){
  if(!record || typeof record !== 'object') return null;
  const value=record[track];
  if(typeof value === 'boolean') return value;
  return value && typeof value.present === 'boolean' ? value.present : null;
}
function inferredClipTracks(state){
  state=state || {};
  const info=state.info && typeof state.info === 'object' ? state.info : {};
  const media=state.media && typeof state.media === 'object' ? state.media : {};
  const filled=!!state.filled || !!(state.source || state.media || state.live ||
    state.unavailableLive || state.sourceFile);
  let audio=typeof info.hasAudio === 'boolean' ? info.hasAudio :
    (typeof media.hasAudio === 'boolean' ? media.hasAudio : !!media.audio);
  let video;
  if(typeof info.hasVideo === 'boolean') video=info.hasVideo;
  else if(typeof media.hasVideo === 'boolean') video=media.hasVideo;
  else if(Object.prototype.hasOwnProperty.call(media,'video')) video=!!media.video;
  else if(lightingEnvelopeOf(state)) video=false;
  else if(String(info.codec || '').toLowerCase() === 'effect' && audio) video=false;
  else video=filled;
  if(!filled){ audio=false; video=false; }
  return {audio:{present:!!audio},video:{present:!!video}};
}
function inferredClipTrackDeclarations(state){
  state=state || {};
  const info=state.info && typeof state.info === 'object' ? state.info : {};
  const media=state.media && typeof state.media === 'object' ? state.media : {};
  if(state.filled === false) return {audio:true,video:true};
  const codec=String(info.codec || '').toLowerCase();
  return {
    audio:typeof info.hasAudio === 'boolean' || typeof media.hasAudio === 'boolean' ||
      (Object.prototype.hasOwnProperty.call(media,'audio') && media.audio != null) || codec === 'effect',
    video:typeof info.hasVideo === 'boolean' || typeof media.hasVideo === 'boolean' ||
      Object.prototype.hasOwnProperty.call(media,'video') || !!state.source || !!state.live ||
      !!state.unavailableLive || codec === 'effect' || codec === 'source' || codec === 'live'
  };
}
function normaliseClipTracks(state, declared){
  const fallback=inferredClipTracks(state), source=declared && typeof declared === 'object' ? declared : null;
  const out={audio:{present:false},video:{present:false}};
  CLIP_TRACK_NAMES.forEach(track => {
    const explicit=clipTrackBoolean(source,track);
    out[track].present=explicit == null ? fallback[track].present : explicit;
  });
  return out;
}
function setClipTracksOnClip(k, tracks, declarations){
  if(!k) return;
  const normal=normaliseClipTracks(k,tracks), declared=declarations || {};
  CLIP_TRACK_NAMES.forEach(track => {
    if(!k[track] || typeof k[track] !== 'object') return;
    k[track].present=normal[track].present;
    k[track]._presentDeclared=!!declared[track];
    setClipTrackParamsRegistered(k,track,normal[track].present);
  });
}
function clipTrackBaseParams(k, track){
  track=clipTrackName(track);
  const out=[], seen=new Set();
  function visit(value){
    if(!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if(engineParamObject(value)){ out.push(value); return; }
    Object.keys(value).forEach(key => {
      if(key === 'effects' || key[0] === '_') return;
      visit(value[key]);
    });
  }
  visit(k && k[track]);
  return out;
}
function setClipTrackParamsRegistered(k, track, on){
  clipTrackBaseParams(k,track).forEach(p => {
    if(on) REG.set(p.id,p);
    else if(REG.get(p.id) === p) REG.delete(p.id);
  });
}
function clipTracks(k){
  if(!k || k.kind !== 'clip') return {audio:{present:false},video:{present:false}};
  const inferred=inferredClipTracks(k), known=inferredClipTrackDeclarations(k);
  const out={audio:{present:false},video:{present:false}};
  CLIP_TRACK_NAMES.forEach(track => {
    const component=k[track];
    const declared=component && component._presentDeclared === true;
    const present=declared && typeof component.present === 'boolean' ? component.present :
      (known[track] ? inferred[track].present :
        (!!(component && component.present) || inferred[track].present));
    out[track].present=!!present;
    /* Materialise the current inference for old code that reads `.present`, but
       leave it undeclared so later media discovery can still refine it. */
    if(component && component._presentDeclared !== true) component.present=!!present;
    setClipTrackParamsRegistered(k,track,!!present);
  });
  return out;
}
function hasClipTrack(k, track){ return clipTracks(k)[clipTrackName(track)].present; }

/* Strip Audio/Video removes the corresponding native track's Effect chain as
   well as the track component (REST remove-*-track contract). Work directly
   with the Effect objects so the surrounding track edit owns the sole Undo
   record; removeEffect()/addEffect() would each create an extra gesture. */
function replaceClipTrackEffects(k, track, effects){
  track=clipTrackName(track);
  const audio=track === 'audio', target=Array.isArray(effects) ? effects : [];
  const current=(k[track] && k[track].effects) || [];
  if(current.length === target.length && current.every((fx,index) => fx === target[index])) return;
  current.slice().forEach(fx => removeEffectObject(k,fx,audio));
  target.forEach((fx,index) => insertEffectObject(k,fx,index,audio));
}

function clipEffectChains(k){
  return {
    audio:((k.audio && k.audio.effects) || []).slice(),
    video:((k.video && k.video.effects) || []).slice()
  };
}
function replaceClipEffectChains(k, chains){
  CLIP_TRACK_NAMES.forEach(track => replaceClipTrackEffects(k,track,
    chains && chains[track] || []));
}
function clipStateIsEmpty(state){
  return !state.filled && !state.source && !state.media && !state.sourceFile &&
    !state.live && !state.unavailableLive;
}

const LAYER_CONTENT_DOMAINS=Object.freeze(['unassigned','media','lighting']);
function lightingEnvelopeOf(state){
  const envelope=state&&state.info&&state.info.showaveLighting;
  return envelope&&envelope.schema===1&&Array.isArray(envelope.bindings)&&
    envelope.bindings.some(binding=>binding&&typeof binding==='object') ? envelope : null;
}
function clipStateContentDomain(state){
  if(!state||clipStateIsEmpty(state)) return '';
  const lighting=!!lightingEnvelopeOf(state);
  const tracks=state.tracks||inferredClipTracks(state);
  const audiovisual=!!(state.source||state.media||state.sourceFile||state.live||
    state.unavailableLive||tracks.audio&&tracks.audio.present||tracks.video&&tracks.video.present);
  if(lighting&&audiovisual) return 'mixed';
  return lighting?'lighting':'media';
}
function clipContentDomain(k){ return k?clipStateContentDomain(clipContentStateOf(k)):''; }
function observedLayerContentDomain(ref){
  const L=layerFrom(ref); if(!L) return '';
  let found='';
  doc.decks.forEach(deck=>{
    for(const k of deck.clips.values()){
      if(k.layer!==L.index) continue;
      const domain=clipContentDomain(k); if(!domain) continue;
      if(domain==='mixed'||found&&found!==domain){ found='mixed'; break; }
      found=domain;
    }
  });
  return found||'unassigned';
}
function layerDomain(ref){
  const L=layerFrom(ref); if(!L) return '';
  if(LAYER_CONTENT_DOMAINS.includes(L.contentDomain)&&L.contentDomain!=='unassigned') return L.contentDomain;
  return observedLayerContentDomain(L);
}
function layerContentDomain(ref){ return layerDomain(ref); }
function assertLayerDomain(ref,requested,verb){
  const L=layerFrom(ref); if(!L) throw new RangeError('The target Layer is unavailable.');
  const wanted=String(requested||'');
  if(!LAYER_CONTENT_DOMAINS.includes(wanted)||wanted==='unassigned')
    throw new TypeError('Layer content domain must be media or lighting.');
  const current=layerDomain(L);
  if(current==='mixed')
    throw new RangeError('This legacy Layer already mixes lighting and media. Separate its Clips before editing it.');
  if(current!=='unassigned'&&current!==wanted){
    const article=wanted==='lighting'?'a Lighting Clip':'media content';
    const owned=current==='lighting'?'Lighting Layer':'media Layer';
    throw new RangeError(`${verb||'That operation'} cannot place ${article} on a ${owned}. Use another Layer.`);
  }
  return L;
}
function claimLayerDomain(ref,requested,opts){
  const L=assertLayerDomain(ref,requested,'Assigning this Layer'); opts=opts||{};
  const before=L.contentDomain, after=String(requested);
  if(before===after) return L;
  const apply=()=>{L.contentDomain=after;notify(L.name);};
  const restore=()=>{L.contentDomain=before;notify(L.name);};
  apply();
  if(!opts.noUndo) pushStructuralUndo(opts.label||`Assign ${after} Layer`,restore,apply);
  return L;
}
function assertLayerAcceptsContent(L,state,verb){
  if(!L) throw new RangeError('The target Layer is unavailable.');
  const incoming=clipStateContentDomain(state); if(!incoming) return '';
  if(incoming==='mixed')
    throw new RangeError('A Clip cannot mix lighting with video, audio, media, or live input content.');
  const current=layerDomain(L);
  if(current==='mixed')
    throw new RangeError('This legacy Layer already mixes lighting and media. Separate its Clips before editing it.');
  if(current!=='unassigned'&&current!==incoming){
    const wanted=incoming==='lighting'?'Lighting Clip':'media Clip';
    const owned=current==='lighting'?'Lighting Layer':'media Layer';
    throw new RangeError(`${verb||'That operation'} cannot place a ${wanted} on a ${owned}. Use another Layer.`);
  }
  return incoming;
}

/* Clear resets the Slot's reusable Clip controls, not just its decoder. Keep a
   runtime snapshot (object identity included) so one structural Undo restores
   parameter values/animations/ranges and Dashboard relationships exactly. */
const CLIP_SETTING_SKIP=new Set([
  'effects','source','media','sourceFile','live','unavailableLive','onAcquire','onRelease',
  'info','playing','covers','_runtime'
]);
function clipSettingParams(k){
  const out=[], seen=new Set();
  function visit(value){
    if(!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if(engineParamObject(value)){ out.push(value); return; }
    if(Array.isArray(value)){ value.forEach(visit); return; }
    Object.keys(value).forEach(key => {
      if(CLIP_SETTING_SKIP.has(key) || key[0] === '_') return;
      visit(value[key]);
    });
  }
  visit(k);
  return out;
}
function snapshotClipSettings(k){
  const params=clipSettingParams(k);
  const effectParams=CLIP_TRACK_NAMES.flatMap(track =>
    ((k[track] && k[track].effects) || []).flatMap(effectParamList));
  const ownedParams=params.concat(effectParams.filter(p => !params.includes(p)));
  const ids=new Set(ownedParams.map(p => p.id));
  const dials=[];
  const seenOwners=new Set();
  dashboardOwners().forEach(owner => {
    if(!owner || seenOwners.has(owner)) return; seenOwners.add(owner);
    (owner.dashboard || []).forEach((dial,index) => {
      const links=(dial.links || []);
      if(owner === k || links.some(link => ids.has(+link.paramId)))
        dials.push({dial,index,owned:owner === k,
          nameState:snapshotParameterState(dial.name),
          links:links.map(link => cloneEffectValue(link))});
    });
  });
  const linked=new Set(ownedParams);
  dials.forEach(record => record.links.forEach(link => {
    const p=REG.get(+link.paramId); if(p) linked.add(p);
  }));
  return {
    k, ids,
    params:params.map(p => ({p,state:snapshotParameterState(p)})),
    dials,
    dashes:Array.from(linked,p => ({p,dash:cloneEffectValue(p.dash)}))
  };
}
function resetClipSettings(snapshot){
  if(!snapshot) return;
  snapshot.dials.forEach(record => {
    const removed=(record.dial.links || []).filter(link => record.owned || snapshot.ids.has(+link.paramId));
    removed.forEach(link => {
      const p=REG.get(+link.paramId) ||
        (snapshot.dashes.find(item => item.p.id === +link.paramId) || {}).p;
      if(p) p.dash=null;
    });
    record.dial.links=record.owned ? [] :
      (record.dial.links || []).filter(link => !snapshot.ids.has(+link.paramId));
    if(!record.dial.links.length)
      setParam(record.dial.name,'Dial '+(record.index+1),{silent:1});
  });
  snapshot.params.forEach(({p}) => {
    const current=snapshotParameterState(p), state=current && current.state || {};
    state.value=cloneEffectValue(p.def); state.in=p.min; state.out=p.max; state.anim=null;
    delete state.palette; delete state.paletteEnabled;
    restoreParameterState(p,{name:p.name,state},false); p.dash=null;
  });
}
function restoreClipSettings(snapshot){
  if(!snapshot) return;
  snapshot.params.forEach(({p,state}) => restoreParameterState(p,state,false));
  snapshot.dials.forEach(record => {
    (record.dial.links || []).forEach(link => {
      const p=REG.get(+link.paramId); if(p) p.dash=null;
    });
    record.dial.links=record.links.map(link => cloneEffectValue(link));
    restoreParameterState(record.dial.name,record.nameState,false);
  });
  snapshot.dashes.forEach(({p,dash}) => { p.dash=cloneEffectValue(dash); });
  notify(snapshot.k.name);
}

function snapshotParameterMappings(params){
  const unique=[];
  (params || []).forEach(p => { if(p && p.id != null && !unique.includes(p)) unique.push(p); });
  const ids=new Set(unique.map(p => p.id)), dials=[], seenOwners=new Set();
  dashboardOwners().forEach(owner => {
    if(!owner || seenOwners.has(owner)) return; seenOwners.add(owner);
    (owner.dashboard || []).forEach((dial,index) => {
      if((dial.links || []).some(link => ids.has(+link.paramId)))
        dials.push({dial,index,nameState:snapshotParameterState(dial.name),
          linkOrder:(dial.links || []).map(link=>+link.paramId),
          links:(dial.links || []).filter(link => ids.has(+link.paramId))
            .map(link => cloneEffectValue(link))});
    });
  });
  const controls=controlMappings.filter(record => ids.has(+record._targetId))
    .map(record=>cloneControlMapping(record));
  return {ids,dials,controls,controlOrder:controlMappings.map(record=>record.id),
    params:unique.map(p => ({p,dash:cloneEffectValue(p.dash)}))};
}
function removeParameterMappings(snapshot){
  if(!snapshot) return;
  snapshot.dials.forEach(record => {
    record.dial.links=(record.dial.links || []).filter(link => !snapshot.ids.has(+link.paramId));
    if(!record.dial.links.length)
      setParam(record.dial.name,'Dial '+(record.index+1),{silent:1});
    notify(record.dial.value);
  });
  if(snapshot.controls && snapshot.controls.length){
    const mappingIds=new Set(snapshot.controls.map(record=>record.id));
    installControlMappings(controlMappings.filter(record=>!mappingIds.has(record.id)));
  }
  snapshot.params.forEach(({p}) => { p.dash=null; });
}
function restoreParameterMappings(snapshot){
  if(!snapshot) return;
  snapshot.dials.forEach(record => {
    const wasEmpty=!(record.dial.links || []).length;
    const links=(record.dial.links || [])
      .filter(link => !snapshot.ids.has(+link.paramId))
      .concat(record.links.map(link => cloneEffectValue(link)));
    const order=record.linkOrder || [];
    record.dial.links=links.slice().sort((a,b)=>{
      const ai=order.indexOf(+a.paramId), bi=order.indexOf(+b.paramId);
      if(ai<0) return bi<0?0:1;
      if(bi<0) return -1;
      return ai-bi;
    });
    /* Do not rename a dial which acquired an unrelated mapping while these
       Parameters were absent. If this restore repopulates an empty dial, its
       mapped name is part of the relationship being restored. */
    if(wasEmpty) restoreParameterState(record.dial.name,record.nameState,false);
    notify(record.dial.value);
  });
  if(snapshot.controls && snapshot.controls.length){
    const mappingIds=new Set(snapshot.controls.map(record=>record.id));
    const combined=controlMappings.filter(record=>!mappingIds.has(record.id))
      .concat(snapshot.controls.map(record=>cloneControlMapping(record)));
    const order=snapshot.controlOrder || [];
    combined.sort((a,b)=>{
      const ai=order.indexOf(a.id), bi=order.indexOf(b.id);
      if(ai<0) return bi<0?0:1;
      if(bi<0) return -1;
      return ai-bi;
    });
    installControlMappings(combined);
  }
  snapshot.params.forEach(({p,dash}) => { p.dash=cloneEffectValue(dash); });
}
function clipTrackOwnedParams(k, track, effects){
  const out=clipTrackBaseParams(k,track);
  (effects || []).forEach(fx => effectParamList(fx).forEach(p => {
    if(!out.includes(p)) out.push(p);
  }));
  return out;
}

function clipContentStateOf(k){
  const tracks=clipTracks(k);
  return {
    name: val(k.name), filled: !!k.filled,
    source: k.source || null, media: k.media || null,
    sourceFile: k.sourceFile || null, live: k.live || null,
    unavailableLive: k.unavailableLive || null,
    onAcquire: k.onAcquire || null, onRelease: k.onRelease || null,
    info: k.info || null,
    tracks,
    _trackDeclarations:{
      audio:!!(k.audio && k.audio._presentDeclared),
      video:!!(k.video && k.video._presentDeclared)
    },
    duration: val(k.transport.duration), beats: val(k.transport.beats)
  };
}
function applyClipContentState(k, state){
  const current = clipContentStateOf(k);
  const lifecycleChanged = current.live !== state.live ||
    current.onAcquire !== state.onAcquire || current.onRelease !== state.onRelease;
  /* Deactivate while the old descriptor is still installed. Hooks receive the
     snapshot explicitly, so they never have to null k.live before Undo has had
     a chance to remember it. */
  if(lifecycleChanged && typeof current.onRelease === 'function'){
    try { current.onRelease(k, current); } catch(e){ /* replacement continues */ }
  }
  if(k.source !== state.source) sourceParamsOn(k.source, false);
  k.source = state.source || null;
  sourceParamsOn(k.source, true);
  k.filled = !!state.filled;
  k.media = state.media || null;
  if(k.media?.presentation?.player&&k.media.libraryId)
    documentPresentationPlayers.add(k.media.presentation.player);
  k.sourceFile = state.sourceFile || null;
  k.live = state.live || null;
  k.unavailableLive = state.unavailableLive || null;
  k.onAcquire = state.onAcquire || null;
  k.onRelease = state.onRelease || null;
  k.info = state.info || null;
  setClipTracksOnClip(k,state.tracks,
    state._trackDeclarations || inferredClipTrackDeclarations(state));
  setParam(k.name, state.name || '', {noUndo:true});
  setParam(k.transport.duration, state.duration, {noUndo:true});
  setParam(k.transport.beats, state.beats, {noUndo:true});
  notify(k.name);
  if(lifecycleChanged && typeof k.onAcquire === 'function'){
    try { k.onAcquire(k, state); } catch(e){ /* async hook reports its own error */ }
  }
}

/* Generic clip-content swap used when a file replaces a Source. Keeping this
   in the engine is essential: app.js cannot safely reach into REG to retire a
   generator's parameter ids. `next` is a complete content snapshot delta; any
   omitted field retains its current value. Resource-owning content is switched
   by the lifecycle hooks above, so the old descriptor remains available to the
   structural Undo snapshot. */
function replaceClipContent(k, next, opts){
  if(!k) return null;
  opts = opts || {};
  const before = clipContentStateOf(k);
  const after = Object.assign({}, before, next || {});
  const ownerLayer=layer(k.layer), beforeLayerDomain=ownerLayer&&ownerLayer.contentDomain||'unassigned';
  const replacesContentKind=['source','media','live','sourceFile','unavailableLive'].some(field =>
    Object.prototype.hasOwnProperty.call(next || {},field));
  const declaresContent=replacesContentKind || ['filled','info'].some(field =>
    Object.prototype.hasOwnProperty.call(next || {},field));
  if(Object.prototype.hasOwnProperty.call(next || {},'tracks')){
    after.tracks=normaliseClipTracks(after,next.tracks);
    const saved=next && next.trackDeclarations;
    after._trackDeclarations={
      audio:saved && typeof saved.audio === 'boolean' ? saved.audio : true,
      video:saved && typeof saved.video === 'boolean' ? saved.video : true
    };
  } else if(declaresContent){
    after.tracks=inferredClipTracks(after);
    after._trackDeclarations=inferredClipTrackDeclarations(after);
  }
  if(!Object.prototype.hasOwnProperty.call(next || {},'unavailableLive') &&
     (replacesContentKind || (next && next.filled === false)))
    after.unavailableLive = null;
  const beforeEffects=clipEffectChains(k);
  const afterEffects={
    audio:after.tracks.audio.present ? beforeEffects.audio.slice() : [],
    video:after.tracks.video.present ? beforeEffects.video.slice() : []
  };
  const clearing=clipStateIsEmpty(after);
  const incomingDomain=opts.skipLayerDomain?'':assertLayerAcceptsContent(ownerLayer,after,'Replacing this Clip');
  const currentLayerDomain=ownerLayer&&layerDomain(ownerLayer)||'unassigned';
  const afterLayerDomain=opts.skipLayerDomain?beforeLayerDomain:
    (beforeLayerDomain!=='unassigned'&&LAYER_CONTENT_DOMAINS.includes(beforeLayerDomain)?beforeLayerDomain:
      currentLayerDomain!=='unassigned'&&LAYER_CONTENT_DOMAINS.includes(currentLayerDomain)?currentLayerDomain:
      incomingDomain||'unassigned');
  const removedParams=clearing ? [] : CLIP_TRACK_NAMES.flatMap(track =>
    after.tracks[track].present ? [] : clipTrackOwnedParams(k,track,beforeEffects[track]));
  const sourceChanged=before.source !== after.source;
  let settings=null, mappings=null, beforeSourceMappings=null, afterSourceMappings=null;
  if(clearing){
    after.duration=k.transport.duration.def;
    after.beats=k.transport.beats.def;
  }
  const applyAfter=() => {
    /* Capture the side we are leaving every time. Dashboard mapping changes do
       not consume structural Redo, so a restored Source/track may have been
       remapped since the previous transition. */
    if(sourceChanged){
      beforeSourceMappings=snapshotParameterMappings(before.source && before.source.params);
      removeParameterMappings(beforeSourceMappings);
    }
    if(clearing){ settings=snapshotClipSettings(k); resetClipSettings(settings); }
    else if(removedParams.length){
      mappings=snapshotParameterMappings(removedParams);
      removeParameterMappings(mappings);
    }
    if(ownerLayer&&!opts.skipLayerDomain) ownerLayer.contentDomain=afterLayerDomain||'unassigned';
    applyClipContentState(k,after);
    replaceClipEffectChains(k,afterEffects);
    if(sourceChanged) restoreParameterMappings(afterSourceMappings);
    if(clearing) doc.layers.forEach(L => {
      if(L.playing && L.playing.clip === k) L.playing=null;
    });
  };
  const applyBefore=() => {
    if(sourceChanged){
      afterSourceMappings=snapshotParameterMappings(after.source && after.source.params);
      removeParameterMappings(afterSourceMappings);
    }
    applyClipContentState(k,before);
    if(ownerLayer&&!opts.skipLayerDomain) ownerLayer.contentDomain=beforeLayerDomain;
    replaceClipEffectChains(k,beforeEffects);
    if(clearing) restoreClipSettings(settings);
    else if(removedParams.length) restoreParameterMappings(mappings);
    if(sourceChanged) restoreParameterMappings(beforeSourceMappings);
  };
  applyAfter();
  if(!opts.noUndo) pushStructuralUndo(opts.label || 'Replace clip content',applyBefore,applyAfter);
  return after;
}

function setClipTrackPresent(k, track, present, opts){
  if(!k || k.kind !== 'clip') return false;
  track=clipTrackName(track); present=!!present; opts=opts || {};
  const before=clipContentStateOf(k), current=before.tracks[track].present;
  /* Lighting Clips deliberately have no native Audio or Video component.  This
     guard belongs before both the no-op and empty-Clip exits: an empty Slot on
     a Lighting Layer is still reserved for lighting, and a corrupt mixed Clip
     must never be silently accepted as an already-present track. Removing a
     stray track remains possible so repair/import tooling can make old data
     valid again. */
  if(present){
    const ownerLayer=layer(k.layer), clipDomain=clipStateContentDomain(before),
      ownerDomain=ownerLayer&&layerDomain(ownerLayer)||'unassigned';
    if(clipDomain==='lighting'||ownerDomain==='lighting'||
       clipDomain==='mixed'||ownerDomain==='mixed')
      throw new RangeError('A Lighting Clip or Lighting Layer cannot contain Audio or Video tracks.');
  }
  if(current === present) return false;
  /* Browser media discovery is asynchronous. `hasAudio:null` plus an
     undeclared Audio component means topology is still pending, so removing
     the only proven Video component could incorrectly clear an AV Clip a frame
     before canplay reports Audio. Internal repair/import callers may force it. */
  if(!present && track === 'video' && !opts.force && before.media &&
     before.media.hasAudio === null && !before._trackDeclarations.audio &&
     !before.tracks.audio.present) return false;
  /* A cleared Clip no longer owns a decoder/source to reattach. Adding media is
     a content replacement operation; this API only edits tracks on content
     that still exists. */
  if(present && !before.filled && !before.source && !before.media && !before.live &&
     !before.unavailableLive && !before.sourceFile) return false;
  const after=Object.assign({},before,{
    tracks:normaliseClipTracks(before,before.tracks),
    _trackDeclarations:Object.assign({},before._trackDeclarations,{[track]:true})
  });
  after.tracks[track]={present};
  const remaining=CLIP_TRACK_NAMES.some(name => after.tracks[name].present);
  const clearing=!remaining;
  if(!remaining){
    Object.assign(after,{name:'',filled:false,source:null,media:null,sourceFile:null,
      live:null,unavailableLive:null,onAcquire:null,onRelease:null,info:null,
      duration:k.transport.duration.def,beats:k.transport.beats.def});
    after._trackDeclarations={audio:true,video:true};
  } else if(after.info && typeof after.info === 'object'){
    after.info=Object.assign({},after.info,{
      hasAudio:after.tracks.audio.present,hasVideo:after.tracks.video.present
    });
  }
  const beforeEffects=clipEffectChains(k);
  /* Restoring a track does not manufacture Effects; undoing a removal does.
     Removing a track always leaves an empty chain, including noUndo/import
     callers, so a hidden dormant chain can never survive present:false. */
  const afterEffects={
    audio:after.tracks.audio.present ? beforeEffects.audio.slice() : [],
    video:after.tracks.video.present ? beforeEffects.video.slice() : []
  };
  const removedParams=!clearing && !present ?
    clipTrackOwnedParams(k,track,beforeEffects[track]) : [];
  const sourceChanged=before.source !== after.source;
  let settings=null, mappings=null, beforeSourceMappings=null, afterSourceMappings=null;
  const applyAfter=() => {
    if(sourceChanged){
      beforeSourceMappings=snapshotParameterMappings(before.source && before.source.params);
      removeParameterMappings(beforeSourceMappings);
    }
    if(clearing){ settings=snapshotClipSettings(k); resetClipSettings(settings); }
    else if(removedParams.length){
      mappings=snapshotParameterMappings(removedParams);
      removeParameterMappings(mappings);
    }
    applyClipContentState(k,after);
    replaceClipEffectChains(k,afterEffects);
    if(sourceChanged) restoreParameterMappings(afterSourceMappings);
    if(!after.filled)
      doc.layers.forEach(L => { if(L.playing && L.playing.clip === k) L.playing=null; });
  };
  const applyBefore=() => {
    if(sourceChanged){
      afterSourceMappings=snapshotParameterMappings(after.source && after.source.params);
      removeParameterMappings(afterSourceMappings);
    }
    applyClipContentState(k,before);
    replaceClipEffectChains(k,beforeEffects);
    if(clearing) restoreClipSettings(settings);
    else if(removedParams.length) restoreParameterMappings(mappings);
    if(sourceChanged) restoreParameterMappings(beforeSourceMappings);
  };
  applyAfter();
  if(!opts.noUndo) pushStructuralUndo(opts.label ||
    ((present?'Restore ':'Remove ')+track+' track'),
    applyBefore,applyAfter);
  return true;
}
function removeClipTrack(k, track, opts){
  return setClipTrackPresent(k,track,false,opts);
}

function replaceClipSource(k, source, opts){
  if(!k || !source) return null;
  opts = opts || {};
  const content={
    name: opts.name || source.name || '', filled: true,
    source, media: null, sourceFile: null, live: null, unavailableLive:null,
    onAcquire:null, onRelease: null,
    info: opts.info || {codec:'Source', fps:60, keyed:false, hasAudio:false,hasVideo:true},
    duration: opts.duration == null ? 8 : opts.duration,
    beats: opts.beats == null ? 16 : opts.beats
  };
  if(Object.prototype.hasOwnProperty.call(opts,'tracks')) content.tracks=opts.tracks;
  if(Object.prototype.hasOwnProperty.call(opts,'trackDeclarations'))
    content.trackDeclarations=opts.trackDeclarations;
  replaceClipContent(k, content, {noUndo:opts.noUndo, label:opts.label || 'Open source',
    skipLayerDomain:!!opts.skipLayerDomain});
  return source;
}
function clearClip(l, c){
  const k = clip(l, c); if(!k) return;
  /* The content swap invokes the old snapshot's release hook and Undo invokes
     its acquire hook. The engine remains MediaStream/DOM-free. */
  transaction('Clear clip', () => replaceClipContent(k, {
    name:'', filled:false, source:null, media:null, sourceFile:null,
    live:null, unavailableLive:null, onAcquire:null, onRelease:null, info:null
  }, {label:'Clear clip'}));
  doc.layers.forEach(L => { if(L.playing && L.playing.clip === k) L.playing = null; });
}
/* doc.deck is a 0-BASED array index and the implicit Deck for clip(),
   clipSlot(), duplicateClip() and clearColumns(). clamp(NaN,...) returns NaN,
   which silently breaks every one of those lookups, so a non-finite argument
   holds the current selection instead of destroying it. */
function selectDeck(i){
  const n = Number.isFinite(+i) ? +i : doc.deck;
  const next=clamp(n,0,doc.decks.length-1), deck=doc.decks[next];
  if(!deck || deck.closed) return false;
  if(next!==doc.deck) doc.selection.clip=null;
  doc.deck = next;
  notify(doc.comp.master);
  return true;
}

/* =========================================================================
   14. OPENLIVE COMPOSITION JSON

   This is deliberately a value codec, not JSON.stringify(doc). The live tree
   contains Maps, callbacks, MediaStreams, decoded media and numeric Parameter
   ids whose only meaning is this page load. The portable document instead
   names every Parameter by structural tokens, rehydrates plug-ins through the
   same factories as a fresh instance, and records Dashboard relationships by
   semantic Parameter home.                                                       */
const OPENLIVE_COMPOSITION_FORMAT = 'openlive-composition';
const OPENLIVE_COMPOSITION_VERSION = 2;
const COMPOSITION_LIMITS = {
  layers:256, columns:512, decks:64, groups:256, effects:512,
  clips:65536, params:8192, text:1000000, nodes:250000
};
const PORTABLE_PARAM_RUNTIME_KEYS = new Set([
  '_v','_randomElapsed','_cleared','_eventHigh','_started'
]);
const NODE_PARAM_SKIP = new Set([
  'effects','links','source','media','live','onAcquire','onRelease','playing',
  'clips','covers','info','unavailableLive','_runtime'
]);

function portableValue(value, seen, depth){
  depth = depth || 0;
  if(depth > 40) return undefined;
  if(value == null || typeof value === 'boolean') return value;
  if(typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if(typeof value === 'string'){
    if(/^blob:/i.test(value)) return undefined;
    return value.slice(0, COMPOSITION_LIMITS.text);
  }
  if(typeof value !== 'object') return undefined;
  if((typeof Blob !== 'undefined' && value instanceof Blob) ||
     (typeof MediaStream !== 'undefined' && value instanceof MediaStream)) return undefined;
  seen = seen || new Set();
  if(seen.has(value)) return undefined;
  seen.add(value);
  if(Array.isArray(value)){
    const out = value.slice(0, COMPOSITION_LIMITS.params).map(v => portableValue(v, seen, depth + 1));
    seen.delete(value); return out;
  }
  const proto = Object.getPrototypeOf(value);
  if(proto !== Object.prototype && proto !== null &&
     Object.prototype.toString.call(value) !== '[object Object]'){
    seen.delete(value); return undefined;
  }
  const out = {};
  Object.keys(value).slice(0, COMPOSITION_LIMITS.params).forEach(k => {
    if(PARAM_STATE_POISON_KEYS.has(k)) return;
    const v = portableValue(value[k], seen, depth + 1);
    if(v !== undefined) out[k] = v;
  });
  seen.delete(value); return out;
}

function portableParam(p){
  const saved = snapshotParameterState(p);
  if(!saved) return null;
  const state = portableValue(saved.state) || {};
  if(state.anim && typeof state.anim === 'object')
    PORTABLE_PARAM_RUNTIME_KEYS.forEach(key => delete state.anim[key]);
  const out={name:String(saved.name || '').slice(0,256), state};
  if(saved.path) out.path=String(saved.path).slice(0,512);
  if(saved.group) out.group=String(saved.group).slice(0,256);
  return out;
}

function snapshotNodeParameters(node){
  const out = [], seen = new Set();
  function visit(value, path){
    if(!value || typeof value !== 'object' || seen.has(value)) return;
    if(value.id != null && REG.get(value.id) === value){
      /* Action identity is rebuilt from the model factory and mappings restore
         by `home`. Saving a pulse/cycle cursor would turn a one-shot control
         into a sticky setting, contrary to clips.htm. */
      if(value.action) return;
      out.push({path:path.slice(), parameter:portableParam(value)}); return;
    }
    seen.add(value);
    Object.keys(value).forEach(k => {
      if(NODE_PARAM_SKIP.has(k) || k[0] === '_') return;
      const child = value[k];
      if(child && typeof child === 'object') visit(child, path.concat(k));
    });
  }
  visit(node, []);
  return out;
}

function parameterAtTokens(node, tokens){
  let cur = node;
  for(const token of tokens || []){
    if(!cur || (typeof cur !== 'object' && !Array.isArray(cur))) return null;
    cur = cur[token];
  }
  return cur && cur.id != null && REG.get(cur.id) === cur ? cur : null;
}
function restoreNodeParameters(node, records){
  (records || []).forEach(record => {
    const p = parameterAtTokens(node, record.path);
    /* Older OpenLive builds serialised Clip Resize as a sticky Choice. Never
       let that legacy state overwrite the factory's momentary Event; its saved
       Width/Height already contain the visible result. */
    if(p && !p.action) restoreParameterState(p, record.parameter, true);
  });
}

function portableEffects(scope){
  const snapshot = fx => {
    const saved=portableValue(snapshotEffect(fx));
    [saved.bypassed,saved.opacity,saved.blend,saved.drywet,...(saved.params||[])].forEach(param => {
      if(param && param.state && param.state.anim)
        PORTABLE_PARAM_RUNTIME_KEYS.forEach(key => delete param.state.anim[key]);
    });
    return saved;
  };
  return {
    video:((scope.video && scope.video.effects) || []).map(snapshot),
    audio:((scope.audio && scope.audio.effects) || []).map(snapshot)
  };
}
function restoreEffectsFromRecord(scope, effects){
  ['video','audio'].forEach(track => ((effects && effects[track]) || []).forEach(saved => {
    const fx = addEffect(scope, saved.name, {audio:track === 'audio', noUndo:true,
      factory:saved._factory});
    restoreEffect(fx, saved);
  }));
}

function stableMediaString(value){
  if(value == null) return null;
  const text = String(value).slice(0,4096);
  return /^(?:blob|data|mediastream):/i.test(text) ? null : text;
}
function snapshotClipContent(k){
  const base = {filled:!!k.filled, info:portableValue(k.info) || null,
    tracks:clipTracks(k),trackDeclarations:{
      audio:!!(k.audio && k.audio._presentDeclared),
      video:!!(k.video && k.video._presentDeclared)
    }};
  if(clipContentDomain(k)==='lighting'){
    base.kind='lighting';
  } else if(k.source){
    base.kind = 'source';
    base.source = {
      name:String(k.source.name || val(k.name) || '').slice(0,256),
      specs:portableValue(k.source.specs || []) || [],
      parameters:(k.source.params || []).map(portableParam)
    };
  } else if(k.live || k.unavailableLive){
    /* A browser cannot persist permission or a MediaStream. Retain the Slot and
       its settings as an explicit unresolved input, never a fake live object. */
    base.kind = 'live'; base.unavailable = true;
  } else if(k.media || k.sourceFile){
    base.kind = 'media';
    base.media = {
      id:stableMediaString(k.media && k.media.id),
      name:stableMediaString((k.media && k.media.name) || val(k.name)),
      source:stableMediaString(k.media && k.media.source),
      sourceFile:stableMediaString(k.sourceFile)
    };
  } else base.kind = 'empty';
  return base;
}

function snapshotScope(scope, extra){
  return Object.assign({parameters:snapshotNodeParameters(scope), effects:portableEffects(scope)}, extra || {});
}
function dashboardOwners(){
  const owners = [doc.comp, ...doc.groups, ...doc.layers];
  doc.decks.forEach(deck => { for(const k of deck.clips.values()) owners.push(k); });
  return owners.filter(owner => owner && owner.dashboard);
}
function snapshotDashboards(){
  return dashboardOwners().map(owner => ({
    ownerHome:owner.home,
    dials:owner.dashboard.map(dial => ({links:(dial.links || []).map(link => {
      const target = REG.get(link.paramId); if(!target) return null;
      const copy = portableValue(link) || {}; delete copy.paramId;
      copy.targetHome = target.home;
      return copy;
    }).filter(Boolean)}))
  })).filter(record => record.dials.some(dial => dial.links.length));
}

function snapshotCompositionState(){
  const selectionClip = doc.selection.clip;
  const selectionColumn = doc.selection.column;
  return {
    format:OPENLIVE_COMPOSITION_FORMAT,
    version:OPENLIVE_COMPOSITION_VERSION,
    composition:snapshotScope(doc.comp),
    groups:doc.groups.map(group => snapshotScope(group, {
      index:group.index, folded:!!group.folded, layers:group.layers.slice()
    })),
    layers:doc.layers.map(layer => snapshotScope(layer, {
      index:layer.index, group:layer.group || null, folded:!!layer.folded,
      contentDomain:layerDomain(layer)
    })),
    columns:doc.columns.map(column => ({index:column.index, parameters:snapshotNodeParameters(column)})),
    decks:doc.decks.map(deck => ({
      index:deck.index, closed:!!deck.closed, parameters:snapshotNodeParameters(deck),
      clips:[...deck.clips.values()].map(k => snapshotScope(k, {
        layer:k.layer, column:k.column, content:snapshotClipContent(k)
      }))
    })),
    activeDeck:doc.deck,
    selection:{
      layer:doc.selection.layer && doc.selection.layer.index || null,
      column:typeof selectionColumn === 'number' ? selectionColumn :
        (selectionColumn && selectionColumn.index) || null,
      clip:selectionClip ? {deck:selectionClip.deck, layer:selectionClip.layer,
        column:selectionClip.column} : null,
      group:doc.selection.group && doc.selection.group.index || null,
      panel:String(doc.selection.panel || 'pLayer').slice(0,64)
    },
    dashboards:snapshotDashboards(),
    controlMappings:listControlMappings()
  };
}

function assertPortableTree(value){
  let nodes = 0;
  const seen = new Set();
  function visit(v, depth){
    if(++nodes > COMPOSITION_LIMITS.nodes) throw new Error('Composition document is too large');
    if(depth > 40) throw new Error('Composition document is too deeply nested');
    if(v == null || typeof v === 'boolean') return;
    if(typeof v === 'number'){
      if(!Number.isFinite(v)) throw new Error('Composition contains a non-finite number');
      return;
    }
    if(typeof v === 'string'){
      if(v.length > COMPOSITION_LIMITS.text) throw new Error('Composition text value is too large');
      if(/^blob:/i.test(v)) throw new Error('Composition contains a non-portable blob URL');
      return;
    }
    if(typeof v !== 'object') throw new Error('Composition contains a non-JSON value');
    if((typeof Blob !== 'undefined' && v instanceof Blob) ||
       (typeof MediaStream !== 'undefined' && v instanceof MediaStream))
      throw new Error('Composition contains a runtime media object');
    if(seen.has(v)) throw new Error('Composition contains a cycle');
    seen.add(v);
    const proto = Object.getPrototypeOf(v);
    if(!Array.isArray(v) && proto !== Object.prototype && proto !== null &&
       Object.prototype.toString.call(v) !== '[object Object]')
      throw new Error('Composition contains a non-plain object');
    Object.keys(v).forEach(k => {
      if(PARAM_STATE_POISON_KEYS.has(k)) throw new Error('Composition contains a poison object key');
      visit(v[k], depth + 1);
    });
    seen.delete(v);
  }
  visit(value,0);
}

/* Version 1 pre-dates explicit Clip track components. Recover what that format
   can prove and choose the non-destructive interpretation for ambiguous filled
   Clips: Video present, plus Audio when metadata or an Audio Effect chain says
   so. An Effect chain is evidence of a live track because v1 had no Strip
   operation capable of leaving a deliberate present:false marker. */
function migrateCompositionV1(data){
  (Array.isArray(data.decks) ? data.decks : []).forEach(deck =>
    (Array.isArray(deck.clips) ? deck.clips : []).forEach(record => {
      const content=record && record.content;
      if(!content || typeof content !== 'object') return;
      const filled=!!content.filled || content.kind !== 'empty';
      const effects=record.effects && typeof record.effects === 'object' ? record.effects : {};
      /* v1 Clear could leave Effect arrays behind on an empty Slot. There is no
         component to own them and no content to recover, so migration drops
         those dormant chains instead of producing a v2 document that fails its
         own absent-track invariant. */
      if(!filled){
        if(Array.isArray(effects.audio)) effects.audio.length=0;
        if(Array.isArray(effects.video)) effects.video.length=0;
        content.tracks={audio:{present:false},video:{present:false}};
        content.trackDeclarations={audio:true,video:true};
        return;
      }
      if(content.tracks && typeof content.tracks === 'object'){
        content.tracks=normaliseClipTracks({
          filled:!!content.filled,
          source:content.kind === 'source' ? content.source : null,
          media:content.kind === 'media' ? content.media : null,
          live:content.kind === 'live' ? {} : null,
          info:content.info || null
        },content.tracks);
        content.trackDeclarations={audio:true,video:true};
        return;
      }
      const info=content.info && typeof content.info === 'object' ? content.info : {};
      const audioEffects=Array.isArray(effects.audio) && effects.audio.length > 0;
      const videoEffects=Array.isArray(effects.video) && effects.video.length > 0;
      let audio=typeof info.hasAudio === 'boolean' ? info.hasAudio : false;
      let video=typeof info.hasVideo === 'boolean' ? info.hasVideo : filled;
      if(audioEffects) audio=true;
      if(videoEffects) video=true;
      if(String(info.codec || '').toLowerCase() === 'effect' && audio &&
         typeof info.hasVideo !== 'boolean' && !videoEffects) video=false;
      if(!filled){ audio=false; video=false; }
      content.tracks={audio:{present:!!audio},video:{present:!!video}};
      content.trackDeclarations={audio:true,video:true};
    }));
  data.version=OPENLIVE_COMPOSITION_VERSION;
  return data;
}
function validateCompositionState(payload){
  assertPortableTree(payload);
  let data = JSON.parse(JSON.stringify(payload));
  if(!data || data.format !== OPENLIVE_COMPOSITION_FORMAT)
    throw new Error('Not a SHOWAVE Show');
  if(data.version === 1) data=migrateCompositionV1(data);
  if(data.version !== OPENLIVE_COMPOSITION_VERSION)
    throw new Error('Unsupported SHOWAVE Show version: ' + data.version);
  const arrays = ['groups','layers','columns','decks'];
  arrays.forEach(name => { if(!Array.isArray(data[name])) throw new Error('Missing '+name); });
  if(!data.composition || typeof data.composition !== 'object') throw new Error('Missing composition');
  if(!data.layers.length || data.layers.length > COMPOSITION_LIMITS.layers) throw new Error('Invalid layer count');
  if(!data.columns.length || data.columns.length > COMPOSITION_LIMITS.columns) throw new Error('Invalid column count');
  if(!data.decks.length || data.decks.length > COMPOSITION_LIMITS.decks) throw new Error('Invalid deck count');
  if(data.groups.length > COMPOSITION_LIMITS.groups) throw new Error('Invalid group count');
  const ids = (records, label) => {
    const found = new Set();
    records.forEach(record => {
      if(!Number.isInteger(record.index) || record.index < 1 || found.has(record.index))
        throw new Error('Invalid '+label+' index');
      found.add(record.index);
    });
    return found;
  };
  const layerIds=ids(data.layers,'layer'), columnIds=ids(data.columns,'column');
  ids(data.groups,'group'); ids(data.decks,'deck');
  function checkParams(record){
    if(!Array.isArray(record.parameters) || record.parameters.length > COMPOSITION_LIMITS.params)
      throw new Error('Invalid Parameter records');
    record.parameters.forEach(paramRecord => {
      if(!Array.isArray(paramRecord.path) || !paramRecord.parameter ||
         !paramRecord.path.every(token => typeof token === 'string' || Number.isInteger(token)))
        throw new Error('Invalid Parameter path');
      checkSavedParam(paramRecord.parameter);
    });
  }
  function checkSavedParam(parameter){
    if(!parameter || typeof parameter.name !== 'string' || parameter.name.length > 256 ||
       !parameter.state || typeof parameter.state !== 'object' || Array.isArray(parameter.state))
      throw new Error('Invalid Parameter state');
    const forbidden=Object.keys(parameter.state).find(key =>
      PARAM_STATE_RUNTIME_KEYS.has(key) || PARAM_STATE_POISON_KEYS.has(key));
    if(forbidden) throw new Error('Forbidden Parameter state key: '+forbidden);
  }
  function checkScope(record){
    checkParams(record);
    ['video','audio'].forEach(track => {
      const list=record.effects && record.effects[track];
      if(!Array.isArray(list) || list.length > COMPOSITION_LIMITS.effects)
        throw new Error('Invalid '+track+' Effect chain');
      list.forEach(effect => {
        if(!effect || typeof effect.name !== 'string' || effect.name.length > 256 ||
           !Array.isArray(effect.params) || effect.params.length > COMPOSITION_LIMITS.params)
          throw new Error('Invalid Effect record');
        [effect.bypassed,effect.opacity,effect.blend,effect.drywet].filter(Boolean).forEach(checkSavedParam);
        effect.params.forEach(checkSavedParam);
      });
    });
  }
  checkScope(data.composition);
  data.groups.forEach(group => {
    checkScope(group);
    if(!Array.isArray(group.layers) || group.layers.some(index => !layerIds.has(index)))
      throw new Error('Invalid Group membership');
  });
  data.layers.forEach(layer => {
    checkScope(layer);
    if(layer.contentDomain!=null&&!LAYER_CONTENT_DOMAINS.includes(layer.contentDomain))
      throw new Error('Invalid Layer content domain');
    /* Files written before Layer domains were persisted are still valid.  The
       Clips below provide the missing value; an explicit assignment is checked
       against them after every Deck has been inspected. */
    if(layer.contentDomain==null) layer.contentDomain='unassigned';
    if(layer.group != null &&
      !data.groups.some(group => group.index === layer.group && group.layers.includes(layer.index)))
      throw new Error('Invalid Layer group');
  });
  data.columns.forEach(checkParams);
  let clips = 0;
  const clipDomainsByLayer=new Map(data.layers.map(layer=>[layer.index,new Set()]));
  const safeLightingId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&
    value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
  function validateLightingEnvelope(content){
    const info=content.info;
    if(!info||typeof info!=='object'||Array.isArray(info)||
       !Object.prototype.hasOwnProperty.call(info,'showaveLighting'))
      throw new Error('Invalid Lighting Clip content');
    const envelope=info.showaveLighting;
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||
       envelope.schema!==1||!Array.isArray(envelope.bindings)||
       !envelope.bindings.length||envelope.bindings.length>32)
      throw new Error('Invalid Lighting Clip content');
    envelope.bindings.forEach(binding=>{
      if(!binding||typeof binding!=='object'||Array.isArray(binding)||
         binding.schema!=='showave.gsl5.binding/1'||!safeLightingId(binding.showId)||
         !safeLightingId(binding.assetType)||!safeLightingId(binding.assetId)||
         !['source','effect'].includes(binding.role)||
         (binding.role==='effect')!==(binding.assetType==='effect')||
         (binding.layerId!=null&&!safeLightingId(binding.layerId))||
         (binding.profileId!=null&&!safeLightingId(binding.profileId))||
         (binding.lightClip!=null&&typeof binding.lightClip!=='boolean')||
         (binding.quantity!=null&&(!Number.isInteger(binding.quantity)||
           binding.quantity<1||binding.quantity>512)))
        throw new Error('Invalid Lighting Clip binding');
    });
    return envelope;
  }
  function recordClipDomain(layerIndex,domain){
    const found=clipDomainsByLayer.get(layerIndex);
    if(found&&domain) found.add(domain);
  }
  data.decks.forEach(deck => {
    checkParams(deck);
    if(!Array.isArray(deck.clips)) throw new Error('Invalid Deck clips');
    const slots=new Set();
    deck.clips.forEach(k => {
      if(++clips > COMPOSITION_LIMITS.clips || !layerIds.has(k.layer) || !columnIds.has(k.column))
        throw new Error('Invalid Clip Slot');
      const slot=k.layer+':'+k.column; if(slots.has(slot)) throw new Error('Duplicate Clip Slot');
      slots.add(slot); checkScope(k);
      if(!k.content || !['empty','source','media','live','lighting'].includes(k.content.kind))
        throw new Error('Invalid Clip content');
      const tracks=k.content.tracks;
      if(typeof k.content.filled !== 'boolean' || !tracks ||
         !tracks.audio || typeof tracks.audio.present !== 'boolean' ||
         !tracks.video || typeof tracks.video.present !== 'boolean')
        throw new Error('Invalid Clip track components');
      if(k.content.trackDeclarations == null)
        k.content.trackDeclarations={audio:true,video:true};
      const declarations=k.content.trackDeclarations;
      if(!declarations || typeof declarations.audio !== 'boolean' ||
         typeof declarations.video !== 'boolean')
        throw new Error('Invalid Clip track declarations');
      if(!tracks.audio.present && k.effects.audio.length)
        throw new Error('Audio Effects require an Audio track');
      if(!tracks.video.present && k.effects.video.length)
        throw new Error('Video Effects require a Video track');
      const info=k.content.info, hasLightingEnvelope=!!(info&&typeof info==='object'&&
        !Array.isArray(info)&&Object.prototype.hasOwnProperty.call(info,'showaveLighting'));
      const carriesMedia=['source','media','sourceFile','live','unavailable','unavailableLive']
        .some(field=>k.content[field]!=null&&k.content[field]!==false);
      if(k.content.kind==='lighting'){
        validateLightingEnvelope(k.content);
        if(!k.content.filled||tracks.audio.present||tracks.video.present||carriesMedia||
           info.hasAudio===true||info.hasVideo===true)
          throw new Error('Invalid Lighting Clip content');
        recordClipDomain(k.layer,'lighting');
      } else if(!tracks.audio.present && !tracks.video.present &&
         (k.content.filled || k.content.kind !== 'empty'))
        throw new Error('Filled Clip has no track components');
      if(k.content.kind!=='lighting'&&hasLightingEnvelope)
        throw new Error('A Clip cannot mix lighting with media content');
      if(k.content.kind!=='lighting'&&(k.content.kind!=='empty'||k.content.filled||
         tracks.audio.present||tracks.video.present||carriesMedia)) recordClipDomain(k.layer,'media');
      if(k.content.kind === 'source' && (!k.content.source ||
         typeof k.content.source.name !== 'string' || !Array.isArray(k.content.source.parameters)))
        throw new Error('Invalid Source record');
      if(k.content.kind === 'source'){
        const source=k.content.source;
        if(source.name.length > 256 || !Array.isArray(source.specs) ||
           source.specs.length > COMPOSITION_LIMITS.params ||
           source.specs.some(spec => !spec || typeof spec !== 'object' ||
             typeof spec.n !== 'string' || spec.n.length > 256) ||
           source.parameters.length > COMPOSITION_LIMITS.params)
          throw new Error('Invalid Source schema');
        source.parameters.forEach(checkSavedParam);
      }
    });
    if(slots.size !== layerIds.size * columnIds.size) throw new Error('Incomplete Deck topology');
  });
  /* The Layer assignment is global to the cue row, so it must agree with every
     non-empty Clip in every Deck.  Missing/unassigned legacy metadata is safely
     inferred; contradictory persisted metadata or cross-Deck mixtures are
     rejected while the currently running document is still untouched. */
  data.layers.forEach(layer=>{
    const domains=clipDomainsByLayer.get(layer.index)||new Set();
    if(domains.size>1) throw new Error('A Layer cannot mix lighting and media Clips across Decks');
    const inferred=domains.size?[...domains][0]:'unassigned';
    if(inferred!=='unassigned'&&layer.contentDomain!=='unassigned'&&layer.contentDomain!==inferred)
      throw new Error('Layer content domain does not match its Clips');
    if(layer.contentDomain==='unassigned'&&inferred!=='unassigned') layer.contentDomain=inferred;
  });
  /* A closed Deck is intentionally absent from the tab strip. Imported files
     that close every Deck (or point activeDeck at a closed one) would leave no
     selectable surface at all, so normalise that impossible UI state before
     the current document is disposed. */
  data.decks.forEach(deck=>{ deck.closed=!!deck.closed; });
  if(data.decks.every(deck=>deck.closed)) data.decks[0].closed=false;
  let activeDeck=clamp(Number.isInteger(data.activeDeck)?data.activeDeck:0,0,data.decks.length-1);
  if(data.decks[activeDeck].closed) activeDeck=data.decks.findIndex(deck=>!deck.closed);
  data.activeDeck=activeDeck;
  if(data.selection&&data.selection.clip){
    const selectedDeck=clamp((data.selection.clip.deck||1)-1,0,data.decks.length-1);
    if(data.decks[selectedDeck].closed) data.selection.clip=null;
  }
  if(data.dashboards != null){
    if(!Array.isArray(data.dashboards) || data.dashboards.length > COMPOSITION_LIMITS.clips)
      throw new Error('Invalid Dashboard records');
    data.dashboards.forEach(record => {
      if(!record || typeof record.ownerHome !== 'string' || !Array.isArray(record.dials) ||
         record.dials.length > 8) throw new Error('Invalid Dashboard owner');
      record.dials.forEach(dial => {
        if(!dial || !Array.isArray(dial.links) || dial.links.length > COMPOSITION_LIMITS.params ||
           dial.links.some(link => !link || typeof link.targetHome !== 'string'))
          throw new Error('Invalid Dashboard links');
      });
    });
  }
  if(data.controlMappings != null){
    if(!Array.isArray(data.controlMappings) || data.controlMappings.length>COMPOSITION_LIMITS.params)
      throw new Error('Invalid control mapping records');
    const mappingIds=new Set();
    data.controlMappings.forEach(record => {
      if(!record || typeof record.id!=='string' || !record.id || mappingIds.has(record.id) ||
         !CONTROL_MAPPING_KINDS.has(controlKind(record.kind)) ||
         typeof record.targetHome!=='string' || !record.targetHome || record.targetHome.length>4096)
        throw new Error('Invalid control mapping');
      mappingIds.add(record.id);
      ['address','outputAddress','deviceId','deviceName','code','key'].forEach(key => {
        if(record[key]!=null && (typeof record[key]!=='string' || record[key].length>4096))
          throw new Error('Invalid control mapping '+key);
      });
    });
  }
  return data;
}

function restoreSourceParameters(source, records){
  const unused = new Set(source.params.map((_,i) => i));
  (records || []).forEach((saved, savedIndex) => {
    const savedPath=saved && (saved.path || (saved.state && saved.state.path));
    let index = savedPath
      ? source.params.findIndex((p,i) => unused.has(i) && p.path === savedPath)
      : -1;
    if(index < 0) index = unused.has(savedIndex) && source.params[savedIndex] &&
      source.params[savedIndex].name === saved.name ? savedIndex :
      source.params.findIndex((p,i) => unused.has(i) && p.name === saved.name);
    if(index >= 0){ unused.delete(index); restoreParameterState(source.params[index], saved, true); }
  });
}
function sourceSpecsForRecord(saved){
  /* The installed Source factory owns today's schema. Saved specs then append
     parameters that no longer ship, so an old Composition loses neither its
     values nor a deliberately unknown/custom control. */
  const specs = Array.isArray(saved._factorySpecs)
    ? saved._factorySpecs.map(spec => cloneEffectValue(spec)) : [];
  const specIdentity=spec => spec && (spec.path || spec.n);
  (Array.isArray(saved.specs) ? saved.specs : []).forEach(spec => {
    if(spec && !specs.some(current => specIdentity(current) === specIdentity(spec)))
      specs.push(cloneEffectValue(spec));
  });
  (saved.parameters || []).forEach(parameter => {
    const identity=parameter.path || parameter.name;
    if(specs.some(spec => specIdentity(spec) === identity)) return;
    const state=parameter.state || {};
    specs.push({n:parameter.name, path:identity, group:parameter.group || null,
      kind:state.type || 'range', min:state.min, max:state.max,
      options:state.options, d:state.def !== undefined ? state.def : state.value});
  });
  return specs;
}
function restoreClipContent(k, content, opts){
  opts=opts||{};
  if(content.kind === 'source'){
    const saved=content.source, specs=sourceSpecsForRecord(saved);
    const source={name:saved.name, specs, params:makeParams(k.home+'/source',specs)};
    replaceClipSource(k,source,{name:saved.name,noUndo:true,info:content.info || undefined,
      tracks:content.tracks,trackDeclarations:content.trackDeclarations,
      skipLayerDomain:!!opts.skipLayerDomain});
    restoreSourceParameters(source,saved.parameters);
    return;
  }
  if(content.kind === 'media'){
    const saved=content.media || {}, ref=saved.id || saved.sourceFile || saved.source || saved.name;
    const media=(window.ArenaMedia && window.ArenaMedia.find && window.ArenaMedia.find(ref)) ||
      {id:saved.id || null,name:saved.name || '',source:saved.source || null};
    replaceClipContent(k,{filled:!!content.filled,media,source:null,
      sourceFile:saved.sourceFile || saved.source || null,live:null,unavailableLive:null,
      onAcquire:null,onRelease:null,
      info:content.info || null,tracks:content.tracks,
      trackDeclarations:content.trackDeclarations},{noUndo:true,skipLayerDomain:!!opts.skipLayerDomain});
    return;
  }
  replaceClipContent(k,{filled:!!content.filled,
    source:null,media:null,sourceFile:null,live:null,
    unavailableLive:content.kind === 'live' ? {unavailable:true} : null,
    onAcquire:null,onRelease:null,
    info:content.info || null,tracks:content.tracks,
    trackDeclarations:content.trackDeclarations},{noUndo:true,skipLayerDomain:!!opts.skipLayerDomain});
}
function restoreDashboards(records){
  const owners=new Map(dashboardOwners().map(owner => [owner.home,owner]));
  const params=new Map(); REG.forEach(p => { if(p && p.home) params.set(p.home,p); });
  (records || []).forEach(record => {
    const owner=owners.get(record.ownerHome); if(!owner) return;
    (record.dials || []).forEach((savedDial,index) => {
      const dial=owner.dashboard[index]; if(!dial) return;
      dial.links=[];
      (savedDial.links || []).forEach(saved => {
        const target=params.get(saved.targetHome); if(!target) return;
        if(target.type==='event'||target.action) return;
        const link=portableValue(saved) || {}; delete link.targetHome; link.paramId=target.id;
        /* Older OpenLive documents could contain both sources. Preserve the
           saved animation graph for round-trip compatibility, but Dashboard
           wins at runtime while the link exists. Every new user edit is
           mutually exclusive via animate()/linkToDashboard(). */
        dial.links.push(link); target.dash={home:owner.home,dial:index};
      });
    });
  });
}
function restoreControlMappings(records){
  const restored=[];
  (records || []).forEach(saved => {
    try {
      const record=normaliseControlMapping(saved,null,true);
      if(parameterByHome(record.targetHome)) restored.push(record);
    } catch(error){ /* one invalid/missing mapping never blocks Composition load */ }
  });
  installControlMappings(restored);
}

function preflightFactorySpecs(specs, label){
  if(!Array.isArray(specs) || specs.length > COMPOSITION_LIMITS.params)
    throw new Error(label+' factory returned an invalid Parameter list');
  const safe=portableValue(specs);
  if(!Array.isArray(safe) || safe.some(spec => !spec || typeof spec !== 'object' ||
     typeof spec.n !== 'string' || !spec.n || spec.n.length > 256))
    throw new Error(label+' factory returned an invalid Parameter');
  return safe;
}
function preflightCompositionFactories(data){
  const scopes=[data.composition,...data.groups,...data.layers];
  data.decks.forEach(deck => scopes.push(...deck.clips));
  scopes.forEach(scope => ['video','audio'].forEach(track =>
    (scope.effects[track] || []).forEach(effect => {
      const factory=effectFactoryRecord(effect.name,track === 'audio');
      effect._factory={implemented:!!factory.implemented,
        specs:preflightFactorySpecs(factory.specs,effect.name)};
    })));
  data.decks.forEach(deck => deck.clips.forEach(clipRecord => {
    if(clipRecord.content.kind !== 'source') return;
    const source=clipRecord.content.source;
    let factory=[];
    if(window.ArenaSources && typeof window.ArenaSources.params === 'function')
      factory=window.ArenaSources.params(source.name) || [];
    source._factorySpecs=preflightFactorySpecs(factory,source.name);
  }));
  return data;
}

function restoreCompositionState(payload){
  /* Validation and cloning finish before disposeDocument() inside init(). */
  const data=preflightCompositionFactories(validateCompositionState(payload));
  replacingDocument++;
  try {
  init({seed:false,layerIndexes:data.layers.map(layer => layer.index),
    columnIndexes:data.columns.map(column => column.index),
    decks:data.decks.map((deck,i) => ({name:'Deck '+(i+1)}))});
  doc.groups=data.groups.map(saved => {
    const group=buildGroup(saved.index); group.folded=!!saved.folded;
    group.layers=saved.layers.slice(); return group;
  });
  data.layers.forEach(saved => {
    const L=layer(saved.index); L.group=saved.group || null; L.folded=!!saved.folded;
    L.contentDomain=LAYER_CONTENT_DOMAINS.includes(saved.contentDomain)?saved.contentDomain:'unassigned';
    restoreNodeParameters(L,saved.parameters); restoreEffectsFromRecord(L,saved.effects);
  });
  data.groups.forEach(saved => {
    const group=doc.groups.find(g => g.index === saved.index);
    restoreNodeParameters(group,saved.parameters); restoreEffectsFromRecord(group,saved.effects);
  });
  restoreNodeParameters(doc.comp,data.composition.parameters);
  restoreEffectsFromRecord(doc.comp,data.composition.effects);
  data.columns.forEach(saved => restoreNodeParameters(column(saved.index),saved.parameters));
  data.decks.forEach((savedDeck,deckIndex) => {
    const deck=doc.decks[deckIndex]; deck.closed=!!savedDeck.closed;
    restoreNodeParameters(deck,savedDeck.parameters);
    savedDeck.clips.forEach(saved => {
      const k=deck.clips.get(key(saved.layer,saved.column));
      restoreClipContent(k,saved.content);
      restoreNodeParameters(k,saved.parameters);
      restoreEffectsFromRecord(k,saved.effects);
    });
  });
  doc.deck=clamp(Number.isInteger(data.activeDeck) ? data.activeDeck : 0,0,doc.decks.length-1);
  const savedSelection=data.selection || {};
  doc.selection.layer=layer(savedSelection.layer) || doc.layers[doc.layers.length-1] || null;
  doc.selection.column=column(savedSelection.column) || null;
  doc.selection.group=doc.groups.find(g => g.index === savedSelection.group) || null;
  const sc=savedSelection.clip;
  doc.selection.clip=sc && doc.decks[clamp((sc.deck || 1)-1,0,doc.decks.length-1)]
    ? doc.decks[clamp((sc.deck || 1)-1,0,doc.decks.length-1)].clips.get(key(sc.layer,sc.column)) || null : null;
  doc.selection.panel=String(savedSelection.panel || 'pLayer').slice(0,64);
  restoreDashboards(data.dashboards);
  restoreControlMappings(data.controlMappings);
  refreshMasterLayerOptions();
  undoStack.length=0; redoStack.length=0; undoGroup=null; pending.length=0;
  } catch(error){
    replacingDocument--;
    if(!replacingDocument) dirty=new Set();
    throw error;
  }
  replacingDocument--;
  /* Helpers used during hydration normally notify their individual Parameters.
     Drop those partial-graph invalidations and publish one complete document. */
  if(!replacingDocument) dirty=new Set();
  notify(doc.comp.master);
  return {layers:doc.layers.length,columns:doc.columns.length,decks:doc.decks.length,
    groups:doc.groups.length,selection:cloneEffectValue(data.selection || {})};
}

/* =========================================================================
   15. PUBLIC API
   ========================================================================= */
/* Build engine parameters from a list of {n, min, max, d} specs — the shape
   arena-sources.js reads out of Resolume's presets. A generator's controls are
   parameters like any other, so they belong in the registry: editable in a
   panel, animatable from the cog, droppable on a dashboard dial. */
/* A source's parameters are parameters like any other (parameters.htm), so they
   must carry the RIGHT KIND, not all be ranges. Forcing everything to 'range'
   had two visible consequences: Text Animator's `Text` — a ParamText — was a
   0..1 slider you could not type into, and every ParamChoice whose default is
   above 1 (Style def 2, Combine/Noise Type def 1) had its own default clamped
   out of range the moment the clip opened.

   The kind comes from what Resolume itself serialises, which
   arena-source-params.js now carries verbatim from the shipped presets: the
   node tag AND the T attribute. T is authoritative where it is present, and
   the node tag supplies the default where Resolume omitted it — which it does
   whenever T is the tag's own default type.

   The node tag alone is not enough, and that is measured, not assumed: across
   default\Presets a bare <Param> is T="BOOL" 412 times and T="STRING" 7, and
   <ParamChoice> is INT32 106, COLOR 35, UINT8 6, STRING 4, UINT64 3.

     ParamText   -> string     Param        -> bool, unless T says STRING
     ParamRange  -> range      ParamChoice  -> range over indices, unless T
                                               says STRING
   ParamChoice is written with storeChoices="0", so the option LABELS are
   genuinely not in the data. Rather than invent a list the index stays a
   number, and the upper bound is widened to fit the observed default instead
   of silently clamping it away.

   ParamColor is its own kind, and parameters.htm is explicit about why:
   "Wherever color is used, Resolume will show a special UI item to set it."
   It used to be forced to 'range', which put a 32-bit colour word on a 0..1
   slider — so every colour control in the app was unreachable, and every
   generator quietly hardcoded its palette instead. Twenty-three source
   parameters were dead for that one reason.

   THE WORD IS 0xAARRGGBB, alpha in the high byte, and that is measured rather
   than assumed. Resolume serialises <ParamColor value="4278190335"/> as a
   decimal uint32; decoding default\Presets\Color Palettes\Magma.xml as ARGB
   gives black -> dark red -> magenta -> orange, which is the magma ramp the
   preset is named after, and Rainbow.xml gives a rainbow. Decoded the other
   way round both come out as a constant red at nonsense alphas. The corpus
   agrees: reference/compositions carries alpha 0 on exactly the parameters
   where transparency is the point (Metaballs BG Color, Stroboscope Color 1).

   An explicit s.kind wins, for generators whose kinds are known some other
   way (the four with no shipped preset). */
function paramKind(s){
  if(s.kind) return s.kind;
  if(s.t === 'COLOR' || s.node === 'ParamColor') return 'color';
  if(s.t === 'STRING' && s.node !== 'ParamRange') return 'string';
  switch(s.node){
    case 'ParamText':  return 'string';
    case 'Param':      return 'bool';
    default:           return 'range';
  }
}
/* --- the packed colour word, in both directions --------------------------
   Kept here rather than in the UI because it is a value-domain concern: the
   .avc reader, the preset reader and the panel must all agree about what the
   number means, and they cannot if each converts it itself. */
const COLOR_WHITE = 0xFFFFFFFF;
function colorParts(word){
  const n = (Number(word) >>> 0);
  return { a: (n >>> 24) & 255, r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255 };
}
function colorWord(r, g, b, a){
  return (((a & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
}
/* CSS for painting. Alpha 0 means transparent and must stay transparent —
   a generator that drops it paints an opaque black where Resolume paints
   nothing, which is how Metaballs lost its background. */
function colorCss(word){
  const c = colorParts(word);
  return c.a === 255 ? `rgb(${c.r} ${c.g} ${c.b})`
                     : `rgba(${c.r} ${c.g} ${c.b} / ${(c.a / 255).toFixed(3)})`;
}
const colorHex = word => { const c = colorParts(word);
  return '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join(''); };
function makeParams(home, specs){
  return (specs || []).map(s => {
    const kind = paramKind(s);
    /* `unwired` rides along from arena-sources.js: the reason this particular
       parameter does not move the picture, or absent when it does. It is on the
       PARAMETER rather than looked up by the panel so that every surface —
       Clip panel, dashboard, OSC — sees the same answer. */
    const path=s.path || s.n;
    const base = { home: home + '/' + path, name: s.n, path,
      group:s.group || null, type: kind, unwired: s.unwired || null,
      /* Presentation is schema, not DOM. Keeping it on the Parameter lets the
         inspector, preview, mappings and any future control surface agree on
         how one underlying value is shown without changing its public home. */
      control:s.control || null,
      multiplier:Number.isFinite(s.multiplier) ? s.multiplier : null,
      suffix:s.suffix == null ? null : String(s.suffix),
      precision:Number.isInteger(s.precision) ? s.precision : null };
    /* A texture/image input is a typed parameter rather than a side channel.
       Its value is the stable key understood by ArenaFX's resource registry;
       the decoded ImageBitmap deliberately never enters the composition tree.
       Keeping it in P() gives image selection the same reset, notification and
       one-entry undo contract as every other effect parameter. */
    if(kind === 'image')  return P(Object.assign(base,
      { value: s.d == null ? '' : String(s.d), accept: s.accept || 'image/*',
        resourceType: 'image' }));
    if(kind === 'resource') return P(Object.assign(base,
      { value:s.d == null ? '' : String(s.d), accept:s.accept || '*/*',
        resourceType:s.resourceType || 'file' }));
    if(kind === 'string') return P(Object.assign(base, { value: s.d == null ? '' : String(s.d) }));
    if(kind === 'bool')   return P(Object.assign(base, { value: !!s.d }));
    /* A colour carries the packed word as its value. min/max stay the full
       32-bit span so nothing clamps it; the picker, not a slider, sets it.
       Only 5 of the 22 ParamColor entries in the shipped presets carry a
       default at all — the other 17 were never moved off the factory value, so
       Resolume had nothing to serialise. What filled the gap is recorded on the
       parameter rather than smoothed over: 'corpus' is the modal value across
       the twelve real compositions, 'assumed' is this codebase's own choice,
       and a colour with neither falls back to opaque white and says so. */
    if(kind === 'color')  return P(Object.assign(base,
      { value: s.d == null ? COLOR_WHITE : (Number(s.d) >>> 0),
        min: 0, max: 0xFFFFFFFF,
        defFrom: s.d == null ? 'fallback' : (s.defFrom || 'preset') }));
    if(kind === 'choice'){
      const options=Array.isArray(s.options) ? s.options.slice() : [];
      const optionValues=Array.isArray(s.optionValues) ? s.optionValues.slice() : null;
      const optionLabels=Array.isArray(s.optionLabels) ? s.optionLabels.slice() : null;
      let value=s.d == null ? options[0] : s.d;
      if(optionValues && !options.includes(value)){
        const index=optionValues.findIndex(candidate => String(candidate) === String(value));
        if(index >= 0 && index < options.length) value=options[index];
      }
      return P(Object.assign(base,{options,optionValues,optionLabels,value,
        unresolvedChoice:!!s.unresolvedChoice}));
    }
    let min = s.min == null ? 0 : s.min;
    let max = s.max == null ? 1 : s.max;
    const v = s.d == null ? 0 : s.d;
    if(s.node === 'ParamChoice' && s.min == null && s.max == null) max = Math.max(1, v);
    if(v < min) min = v;
    if(v > max) max = v;
    return P(Object.assign(base, { min, max, value: v }));
  });
}

/* Previewing a browser plug-in creates the same typed parameters as a real
   Source/Effect, but those controls are transient and must not remain mapped
   after another row is previewed. Only remove entries that still point at the
   supplied object, so a later parameter that reused an address is never
   accidentally unregistered. */
function releaseParams(params){
  (params || []).forEach(p => {
    if(!p || p.id == null) return;
    if(p.dash) unlinkFromDashboard(p.dash.home,p.dash.dial,p.id,{noUndo:true});
    if(REG.get(p.id) === p) REG.delete(p.id);
    p.anim = null; p.dash = null;
  });
}

const API = {
  init, publishDocument, doc, makeParams, releaseParams, createResourceLeasePool, createSerialCommitQueue,
  documentGeneration: () => documentGeneration,
  snapshotCompositionState, restoreCompositionState, validateCompositionState,
  OPENLIVE_COMPOSITION_FORMAT, OPENLIVE_COMPOSITION_VERSION,
  compositionSettings, setCompositionSettings, compositionFrameInterval,
  COMPOSITION_FRAME_RATES, COMPOSITION_BIT_DEPTHS, COMPOSITION_SUPPORTED_BIT_DEPTHS,
  /* parameters */
  param, val, setParam, reset, triggerEvent, normalised, applyNormalised, evalNumeric, setRange, windowOf,
  beginParamGesture, endParamGesture,
  parameterByHome, isControlMappingTarget, controlTargets, listControlMappings, controlMappingsFor, controlMappingKinds,
  addControlMapping, updateControlMapping, removeControlMapping, clearControlMappings,
  duplicateControlMapping, applyControlInput,
  /* colour words — one codec, so the panel, the presets and the .avc reader
     cannot disagree about what 4278190335 means */
  colorParts, colorWord, colorCss, colorHex, setPalette, COLOR_WHITE,
  snapshotParameterState, restoreParameterState, editParameterState,
  subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); },
  batch, transaction, undo, redo,
  canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
  /* tree */
  comp: () => doc.comp, layers: () => doc.layers, layer, groups: () => doc.groups, group: i => doc.groups.find(g => g.index === i),
  columns: () => doc.columns, column, connectedColumnIndex,
  decks: () => doc.decks, deck: () => doc.deck, selectDeck,
  /* Deck structural operations [decks.htm > Organising Decks]. Close, Clear
     Clips and Remove are three different things - see the block above. */
  addDeck, insertDeckBefore, insertDeckAfter, duplicateDeck, moveDeck, renameDeck,
  removeDeck, closeDeck, openDeck, setDeckClosed, clearDeckClips, deckFrom,
  clip, groupOf, parentOf, displayName, stackPosition,
  layerDomain, layerContentDomain, assertLayerDomain, claimLayerDomain,
  clipContentDomain, assertClipLayerDomainTransfer,
  selection: doc.selection,
  /* relationships */
  resolve, resolveFlag, respectsColumn, renderStack, canvasBlend, mixerPlan, maskOf,
  effectiveBlend, layerOpacity, layerVisible, soloActive,
  /* transport */
  clock, tick, rebaseClock, tickParams, tap, resync, nudge, linkActive, pendingFor, pendingList, snapBeats, clipLength, fft,
  crossfaderPress, crossfaderRelease, setGlobalDirection,
  /* actions */
  triggerClip, triggerColumn, triggerGroupColumn, releaseClip, eject, ejectGroup, ejectAll,
  /* structure */
  addLayer, insertLayerAbove, insertLayerBelow, duplicateLayer,
  removeLayer, moveLayer, clearLayer, clearLayerClips, newGroup, setLayerGroup,
  addColumn, insertColumnBefore, insertColumnAfter, duplicateColumn, duplicateColumns, moveColumns,
  clearColumn, clearColumns, removeColumn, removeColumns, removeColumnsBefore, removeColumnsAfter,
  clipSlot, moveClip, duplicateClip, loadClip, clearClip,
  replaceClipContent, replaceClipSource,
  clipTracks, hasClipTrack, setClipTrackPresent, removeClipTrack,
  /* effects */
  addEffect, addEffectParam, removeEffect, moveEffect, copyEffects, pasteEffects,
  /* animation + dashboard */
  animate, stopAnimation, newEnvelope, envelopeAt, EASINGS,
  linkToDashboard, unlinkFromDashboard, editDashboardLink, dashOf, walkParams,
  /* constants */
  DETERMINED_COMP, DETERMINED_LAYER, allBlends, SNAP_BEATS
};
window.ArenaEngine = API;
})();
