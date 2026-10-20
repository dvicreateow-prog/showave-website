/* ===========================================================================
   arena-media.js — real footage in the clone.
   ---------------------------------------------------------------------------
   Browser-native media is decoded directly. DXV and other formats the browser
   cannot decode are opened by OpenLive's native, source-resolution decoder;
   the user's media is not converted or resized. This module is the shared
   playback and frame-derived poster gateway for both paths.

   The engine stays the authority on time. It owns each layer's playhead, its
   speed, direction and play mode; a <video> element here is only a decoder that
   gets told where to be. That ordering matters — the manual's transport rules
   (video.htm) are engine behaviour, not <video> behaviour, and a browser cannot
   express half of them (there is no negative playbackRate, so Backwards has to
   be driven by seeking).

   Browsers also cap how many videos decode at once, so elements come from a
   small pool keyed by layer rather than one per clip.
   =========================================================================== */
(() => {
'use strict';

const INDEX_URL = 'assets/media-index.json';

const state = {
  ready: false, index: null,
  byId: new Map(), byName: new Map(), byFile: new Map(),
  nameCandidates: new Map(), fileCandidates: new Map(),
  posters: new Map(),          // id -> HTMLImageElement (decoded)
  posterWork: new Map(),       // id -> one native first-frame capture per media revision
  posterQueue: [], posterActive: 0, // one shared budget for browser and native posters
  fullStills: new Map(),       // source token -> {image, refs}; trigger-time, ref-counted
  dirty: 0,                    // bumped whenever a poster finishes decoding
  /* Full-resolution stills are owned only by attached decoder slots. They are
     never placed in the poster cache, so an untriggered image library retains
     only its small thumbnails. detach()/source replacement releases them. */
  pool: new Map(),             // layer index -> {video, image, id, audio}
  errors: [],
  audioRuntime: {
    context: null,             // one context; every playing slot gets its own graph
    contextFailed: false,
    workletState: 'idle',      // idle | loading | ready | unavailable
    workletPromise: null,
    compositionBus: null, streamTap: null, outputRoute: null,
    groupBuses: new Map(),
    /* Input meters are deliberately outside the playback pool. Their graph is
       MediaStreamSource -> splitter -> analysers, with no connection to the
       Composition bus, stream tap or AudioContext destination. */
    inputMeters: new Map()
  }
};

function addCandidate(candidates, current, key, record){
  if(!key) return;
  let set=candidates.get(key);
  if(!set){ set=new Set(); candidates.set(key,set); }
  set.delete(record); set.add(record); current.set(key,record);
}
function removeCandidate(candidates, current, key, record){
  const set=key && candidates.get(key); if(!set) return;
  set.delete(record);
  if(!set.size){ candidates.delete(key); current.delete(key); return; }
  current.set(key,[...set].at(-1));
}
function indexRecord(c){
  state.byId.set(c.id,c);
  for(const alias of c.aliases||[]) if(alias && !state.byId.has(alias)) state.byId.set(alias,c);
  addCandidate(state.nameCandidates,state.byName,String(c.name||'').toLowerCase(),c);
  if(c.source) addCandidate(state.fileCandidates,state.byFile,basename(c.source).toLowerCase(),c);
}
function unindexRecord(c){
  if(state.byId.get(c.id)===c) state.byId.delete(c.id);
  for(const alias of c.aliases||[]) if(state.byId.get(alias)===c) state.byId.delete(alias);
  removeCandidate(state.nameCandidates,state.byName,String(c.name||'').toLowerCase(),c);
  if(c.source) removeCandidate(state.fileCandidates,state.byFile,basename(c.source).toLowerCase(),c);
}

/* Arena 7.27.1's live API exposes these six Audio Effects. Bypassed and Dry/Wet
   are shared; AUDIO_EFFECT_SCHEMAS below carries each effect's own parameters.

   effects.htm documents the important mixing rule: Dry/Wet=0 is the original
   signal, Dry/Wet=1 is only the processed signal, and effects run in list
   order. */
const AUDIO_EFFECTS = Object.freeze([
  'Bitcrusher', 'Distortion', 'EQ-3', 'Flanger', 'HighPass', 'LowPass'
]);
/* Sampled from Arena 7.27.1's live REST graph after plugin initialisation.
   Values are Arena's normalised 0..1 representation. Property order is the
   order Arena exposes in the effect panel. */
const AUDIO_EFFECT_SCHEMAS = Object.freeze({
  Bitcrusher: Object.freeze({
    'Dry Wet':1, 'Gain':1, 'Sample Rate':1, 'Bit Depth':1,
    'Dither':false, 'Jitter':false
  }),
  Distortion: Object.freeze({
    'Dry Wet':1, 'Pre Gain':0.1, 'Drive':0, 'Tone':1, 'Post Gain':0.1
  }),
  'EQ-3': Object.freeze({'Dry Wet':1, 'Low':0.5, 'Mid':0.5, 'High':0.5}),
  Flanger: Object.freeze({
    'Dry Wet':1, 'Depth':0, 'Rate':0.05, 'Feedback':0.7,
    'Invert':false, 'Width':0.0003
  }),
  HighPass: Object.freeze({'Dry Wet':1, 'Frequency':0, 'Resonance':0}),
  LowPass: Object.freeze({'Dry Wet':1, 'Frequency':1, 'Resonance':0})
});
const AUDIO_EFFECT_KEY = Object.freeze({
  bitcrusher:'Bitcrusher', distortion:'Distortion', eq3:'EQ-3',
  flanger:'Flanger', highpass:'HighPass', lowpass:'LowPass'
});

/* --------------------------------------------------------------------------
   Load
   -------------------------------------------------------------------------- */
async function load(url){
  try {
    const res = await fetch(url || INDEX_URL, {cache:'no-store'});
    if(!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const idx = await res.json();
    const prior=state.index && state.index.clips ? state.index.clips.slice() : [];
    const priorFolders=state.index && state.index.folders ? state.index.folders.slice() : [];
    const seen=new Set((idx.clips||[]).map(c=>c.id));
    idx.clips=[...(idx.clips||[]),...prior.filter(c=>c && !seen.has(c.id))];
    idx.folders=[...(idx.folders||[])];
    for(const folder of priorFolders) if(!idx.folders.includes(folder)) idx.folders.push(folder);
    idx.count=idx.clips.length;
    state.index = idx;
    state.byId.clear(); state.byName.clear(); state.byFile.clear();
    state.nameCandidates.clear(); state.fileCandidates.clear();
    idx.clips.forEach(c => {
      indexRecord(c);
      /* the .avc references clips by their original path, e.g.
         "../media/Shop74/FogAndDust_3.mov" — index by basename so a parsed
         composition can find its media whatever the prefix is */
    });
    state.ready = true;
    return idx;
  } catch(err){
    state.errors.push(String(err));
    /* An optional bundled catalogue failure must not hide Files that the user
       already imported. Registered browser File capabilities remain the real
       media index even when media-index.json is unavailable. */
    const hasRegistered=!!(state.index && state.index.clips && state.index.clips.length);
    state.ready=hasRegistered;
    if(hasRegistered){
      state.index.count=state.index.clips.length;
      return state.index;
    }
    return null;
  }
}
const basename = p => String(p||'').split(/[\\/]/).pop();

/* Resolve however the caller happens to refer to a clip: index id, bare name,
   or a path out of a composition file. */
function find(ref){
  if(!ref) return null;
  /* Presentation Clips are per-Slot runtime records. They deliberately do not
     enter the Files catalogue, because two Slots loaded from one deck must be
     able to show different slides. Accept that direct record at the decoder
     boundary instead of collapsing it back to the shared library source. */
  if(typeof ref==='object') return ref;
  const s = String(ref);
  return state.byId.get(s)
      || state.byFile.get(basename(s).toLowerCase())
      || state.byName.get(s.toLowerCase())
      || state.byName.get(stripExt(basename(s)).toLowerCase())
      || null;
}
const stripExt = s => String(s||'').replace(/\.[^.]+$/, '');

/* --------------------------------------------------------------------------
   Posters — the clip grid and the layer thumbnails
   -------------------------------------------------------------------------- */
/* Posters decode asynchronously. A caller that paints once — the clip grid does
   — would otherwise keep whatever it drew while the image was still loading,
   forever. `dirty` goes up each time one arrives so the frame loop can repaint
   the grid once and then stop caring. */
function poster(ref){
  const m = find(ref); if(!m) return null;
  if(m.presentation?.player)return m.presentation.player.frame();
  /* Browser-native files acquire a poster during their metadata probe. Native
     records do not have a browser <video>, so start one deduplicated, temporary
     source-resolution decoder the first time a thumbnail actually asks. */
  if(!m.poster){ ensurePoster(m); return null; }
  const hit = state.posters.get(m.id);
  const token=String(m.poster)+':'+String(m.sourceRevision||0);
  if(hit&&hit._openlivePosterToken===token) return hit.complete && hit.naturalWidth ? hit : null;
  if(hit){hit.onload=hit.onerror=null;try{hit.src='';}catch(error){}state.posters.delete(m.id);}
  const img = new Image();
  img._openlivePosterToken=token;
  img.decoding = 'async';
  img.onload = () => { state.dirty++; };
  img.onerror = () => { state.errors.push('poster ' + m.poster); };
  img.src = encodeURI(m.poster);
  state.posters.set(m.id, img);
  return null;                       // caller falls back until it decodes
}

/* Native media is not converted to make a thumbnail. Decode one real frame
   through the same raw-RGBA transport used for playback, reduce only the UI
   poster's longest edge, and keep the resulting PNG as a transient blob URL.
   The source record, resolution, alpha and bytes remain untouched. */
function ensurePoster(ref){
  const m = ref && typeof ref === 'object' ? ref : find(ref);
  if(m?.presentation?.player)return Promise.resolve(m.presentation.player.frame());
  if(!m || state.byId.get(m.id)!==m) return Promise.resolve(null);
  if(m.poster) return Promise.resolve(m.poster);

  const record=m.nativeRecord||m.dxvRecord;
  const ready=!!(record && record.transport==='raw-rgba' &&
    (!record.state || record.state==='ready') &&
    (!m.requiresPrepare || m.prepareState==='ready'));
  if(!ready) return Promise.resolve(null);

  const revision=String(m.sourceRevision||0)+':'+String(record.source||record.key||'');
  const prior=state.posterWork.get(m.id);
  if(prior && prior.media===m && prior.revision===revision) return prior.promise;

  const task=schedulePosterTask(()=>new Promise(resolve=>{
    if(state.byId.get(m.id)!==m || (m.nativeRecord||m.dxvRecord)!==record){resolve(null);return;}
    const dxv=window.OpenLiveDXV;
    if(!dxv || typeof dxv.attach!=='function' || typeof dxv.detach!=='function' ||
       typeof dxv.drawable!=='function'){
      m.nativePosterError='Native poster decoding is unavailable.';
      state.errors.push('poster '+m.id+': '+m.nativePosterError);
      state.dirty++;
      resolve(null);
      return;
    }

    const video=document.createElement('video');
    video.muted=true; video.playsInline=true; video.preload='metadata';
    try { video.pause(); } catch(error){}

    let decoder=null, pollTimer=0, deadlineTimer=0, done=false, capturing=false;
    let lastError='';
    const registered=()=>state.byId.get(m.id)===m &&
      (m.nativeRecord||m.dxvRecord)===record &&
      String(m.sourceRevision||0)+':'+String(record.source||record.key||'')===revision;
    const cleanup=()=>{
      if(pollTimer) clearTimeout(pollTimer);
      if(deadlineTimer) clearTimeout(deadlineTimer);
      pollTimer=deadlineTimer=0;
      try { dxv.detach(video); } catch(error){}
      try { video.pause(); video.removeAttribute('src'); } catch(error){}
    };
    const complete=value=>{
      if(done) return;
      done=true; cleanup(); resolve(value||null);
    };
    const fail=reason=>{
      if(done) return;
      const message=String(reason&&reason.message||reason||lastError||'Native poster frame did not arrive.');
      if(registered()){
        m.nativePosterError=message;
        state.errors.push('poster '+m.id+': '+message);
        state.dirty++;
      }
      complete(null);
    };
    const install=source=>{
      if(capturing || done) return;
      capturing=true;
      try {
        const sw=+(source&&(source.videoWidth||source.naturalWidth||source.width))||+record.width||0;
        const sh=+(source&&(source.videoHeight||source.naturalHeight||source.height))||+record.height||0;
        if(!(sw>0 && sh>0)) return fail('Native poster frame has no dimensions.');
        const scale=Math.min(1,320/Math.max(sw,sh));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(sw*scale));
        canvas.height=Math.max(1,Math.round(sh*scale));
        canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>{
          if(done) return;
          if(!blob) return fail('The native poster could not be encoded as PNG.');
          try {
            const url=URL.createObjectURL(blob);
            /* The folder may have been removed, or the same id may now describe
               a fresh File, while PNG encoding was in flight. Never install
               across that capability boundary or leak the rejected blob. */
            if(!registered() || m.poster){
              try { URL.revokeObjectURL(url); } catch(error){}
              complete(registered() ? m.poster : null);
              return;
            }
            m.poster=url;
            m.nativePosterError=null;
            state.posters.delete(m.id);
            state.dirty++;
            complete(url);
          } catch(error){
            fail(error);
          }
        },'image/png');
      } catch(error){ fail(error); }
    };
    const poll=()=>{
      if(done) return;
      if(!registered()) return complete(null);
      let source=null;
      try { source=dxv.drawable(video); }
      catch(error){ lastError=String(error&&error.message||error); }
      if(source) return install(source);
      pollTimer=setTimeout(poll,25);
    };

    try {
      decoder=dxv.attach(video,record,{
        free:false,
        onError:reason=>{ lastError=String(reason||'Native poster decoder failed.'); },
        onReady:poll
      });
      if(!decoder) return fail('The native decoder refused the poster session.');
      const duration=+record.duration||+m.duration||
        ((+record.frames>0 && +record.fps>0) ? +record.frames/+record.fps : 0);
      const sampleTime=duration>0 ? Math.min(1,duration*0.1) : 0;
      const position=duration>0 ? sampleTime/duration : 0;
      /* sync() makes DirectDecoder non-free and targets one representative
         frame. No clock advances this temporary decoder afterwards. */
      if(typeof dxv.sync==='function') dxv.sync(video,position,{direction:'Paused'});
      deadlineTimer=setTimeout(()=>fail(lastError||'Timed out waiting for a native poster frame.'),15000);
      poll();
    } catch(error){ fail(error); }
  }));

  state.posterWork.set(m.id,{media:m,revision,promise:task});
  return task;
}
/* A library of native files used to allocate one full-size decoder per cell
   while the live layers were playing. Share the background decode budget with
   Files' browser posters, and give input/rendering a turn between tasks. */
function schedulePosterTask(run){
  return new Promise((resolve,reject)=>{
    state.posterQueue.push({run,resolve,reject});
    schedulePosterTurn();
  });
}
let posterTurnPending=false;
function schedulePosterTurn(delay=0){
  if(posterTurnPending)return;
  posterTurnPending=true;
  setTimeout(()=>{posterTurnPending=false;pumpPosterTasks();},delay);
}
function pumpPosterTasks(){
  const value=window.OpenLivePerformance?.backgroundConcurrency?.();
  const limit=Number.isFinite(value)?Math.max(0,Math.min(2,value)):2;
  while(state.posterActive<limit&&state.posterQueue.length){
    const task=state.posterQueue.shift();state.posterActive++;
    Promise.resolve().then(task.run).then(task.resolve,task.reject).finally(()=>{
      state.posterActive--;schedulePosterTurn();
    });
  }
  if(limit===0&&state.posterQueue.length)schedulePosterTurn(250);
}
/* Warm every poster up front: the grid wants them all, and asking for them one
   cell at a time means the first paint of each cell is always the fallback. */
function preloadPosters(){
  (state.index ? state.index.clips : []).forEach(m => poster(m.id));
}

/* --------------------------------------------------------------------------
   Video pool
   One element per layer. A layer only ever shows one clip at a time, so this
   is the natural granularity and it keeps concurrent decodes down to the layer
   count rather than the clip count.
   -------------------------------------------------------------------------- */
function slot(layer){
  let s = state.pool.get(layer);
  if(s) return s;
  const video = document.createElement('video');
  video.muted = true;               // audio uses a separately controlled decoder
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  s = {
    video, image:null, imageEntry:null, id:null, media:null, videoUrl:null, sourceToken:null, generation:0, audio:null, failed:false,
    audioGraph:null, audioGraphFailed:false, liveStream:null, liveLabel:null,
    videoPlayPending:null, audioPlayPending:null, videoDecodeFallback:null, seekTargets:{}, forwardSync:{}, seekCount:0
  };
  state.pool.set(layer, s);
  return s;
}

function releaseStillDrawable(s){
  const entry=s&&s.imageEntry;
  if(!entry){ if(s) s.image=null; return; }
  entry.refs.delete(s);
  s.imageEntry=null; s.image=null;
  if(entry.refs.size) return;
  if(state.fullStills.get(entry.key)===entry) state.fullStills.delete(entry.key);
  entry.image.onload=entry.image.onerror=null;
  try { entry.image.src=''; } catch(error){}
}

function acquireStillDrawable(s,m,key,url){
  let entry=state.fullStills.get(key);
  if(!entry){
    const image=new Image(); image.decoding='async';
    entry={key,image,refs:new Set(),ready:false,failed:false};
    state.fullStills.set(key,entry);
    image.onload=()=>{
      entry.ready=true; entry.failed=false;
      for(const owner of entry.refs) owner.failed=false;
      state.dirty++;
    };
    image.onerror=()=>{
      entry.failed=true;
      for(const owner of entry.refs) owner.failed=true;
      m.unplayableReason='The still image could not be decoded.';
      state.dirty++;
    };
    image.src=url;
  }
  entry.refs.add(s); s.imageEntry=entry; s.image=entry.image; s.failed=entry.failed;
  return entry;
}

/* --------------------------------------------------------------------------
   Audio Effects — one cached WebAudio graph per decoder slot
   --------------------------------------------------------------------------
   The browser's media element remains the transport. WebAudio only owns the
   signal path:

     media source -> Clip/Layer FX -> slot volume/pan
       -> optional shared Group FX + volume/pan
       -> shared Composition FX + volume/pan -> destination

   A parameter move updates AudioParam values on the existing stage. Nodes are
   rebuilt only when the ordered list of effect names changes. This is crucial
   because sync() runs at display cadence.

   UNDOCUMENTED — inferring: neither effects.htm nor the live REST surface
   publishes the private DSP coefficient mapping of Arena's built-ins. The
   conversions below preserve its parameter defaults and endpoints, and map
   the normalised values onto WebAudio's native units. */
const DISTORT_CURVE = makeCurve(4096, x => Math.tanh(x * 18) / Math.tanh(18));
const BITCRUSH_CURVES = new Map();

function makeCurve(size, fn){
  const curve = new Float32Array(size);
  for(let i=0; i<size; i++) curve[i] = fn(i * 2 / (size - 1) - 1);
  return curve;
}
function bitcrushCurve(bits){
  bits = Math.max(2, Math.min(16, Math.round(bits)));
  if(BITCRUSH_CURVES.has(bits)) return BITCRUSH_CURVES.get(bits);
  const levels = Math.pow(2, bits - 1) - 1;
  const curve = makeCurve(4096, x => Math.round(x * levels) / levels);
  BITCRUSH_CURVES.set(bits, curve);
  return curve;
}
function canonicalAudioEffect(name){
  return AUDIO_EFFECT_KEY[String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || null;
}
function hasAudioEffect(name){
  return !!canonicalAudioEffect(name) && !!(window.AudioContext || window.webkitAudioContext);
}
function unwrap(v, fallback){
  if(v && typeof v === 'object' && 'value' in v) v = v.value;
  return v == null ? fallback : v;
}
function asBool(v, fallback){
  v = unwrap(v, fallback);
  return v === true || v === 1 || String(v).toLowerCase() === 'true';
}
function effectParam(raw, key, fallback){
  const params = raw && raw.params;
  if(params && Object.prototype.hasOwnProperty.call(params, key)) return unwrap(params[key], fallback);
  return fallback;
}
function effectList(raw){
  const out = [];
  for(const fx of Array.isArray(raw) ? raw : []){
    const name = canonicalAudioEffect(fx && (fx.name || fx.display || fx.display_name));
    if(!name) continue;
    const schema = AUDIO_EFFECT_SCHEMAS[name], params = {};
    for(const [key, fallback] of Object.entries(schema)){
      if(key === 'Dry Wet') continue;
      const value = effectParam(fx, key, fallback);
      params[key] = typeof fallback === 'boolean'
        ? asBool(value, fallback)
        : clamp(Number.isFinite(+value) ? +value : fallback, 0, 1);
    }
    const dryValue = fx.drywet != null ? fx.drywet
      : fx.dryWet != null ? fx.dryWet
      : effectParam(fx, 'Dry Wet', schema['Dry Wet']);
    const dryNumber = +unwrap(dryValue, schema['Dry Wet']);
    out.push({
      name, params,
      bypassed: asBool(fx.bypassed, false),
      drywet: clamp(Number.isFinite(dryNumber) ? dryNumber : schema['Dry Wet'], 0, 1)
    });
  }
  return out;
}
function setAudioParam(param, value, ctx){
  if(!param) return;
  try {
    if(typeof param.setValueAtTime === 'function') param.setValueAtTime(value, ctx.currentTime || 0);
    else param.value = value;
  } catch { try { param.value = value; } catch {} }
}
function disconnect(node){ if(node && typeof node.disconnect === 'function') try { node.disconnect(); } catch {} }

function audioContext(){
  const rt = state.audioRuntime;
  if(rt.context) return rt.context;
  if(rt.contextFailed) return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if(!Ctor) return null;                           // direct HTMLAudio fallback
  try {
    rt.context = new Ctor(window.OpenLiveAudioOutput?.contextOptions());
    rt.outputRoute = window.OpenLiveAudioOutput?.create(rt.context,{masterDelay:true}) || null;
    bindAudioUnlock(rt.context);
    return rt.context;
  } catch(err){
    rt.contextFailed = true;
    state.errors.push('WebAudio: ' + String(err));
    return null;
  }
}

/* A context created before a user gesture starts suspended in Chromium. Keep
   the fallback transport alive, then resume this single context on the first
   real interaction rather than constructing a new context for every slot. */
let unlockBound = false;
function bindAudioUnlock(ctx){
  if(!ctx || ctx.state === 'running' || unlockBound || !document.addEventListener) return;
  unlockBound = true;
  const unlock = () => {
    const p = ctx.resume && ctx.resume();
    if(p && p.then) p.then(() => {
      if(ctx.state !== 'running') return;
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      unlockBound = false;
    }).catch(()=>{});
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

const BITCRUSH_WORKLET = `
class ArenaBitcrusher extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [
    {name:'gain',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'},
    {name:'sampleRate',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'},
    {name:'bitDepth',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'},
    {name:'dither',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
    {name:'jitter',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'}
  ]; }
  constructor(){ super(); this.held=[]; this.left=[]; }
  process(inputs, outputs, parameters){
    const input=inputs[0]||[], output=outputs[0]||[];
    const gain=parameters.gain[0], rate=parameters.sampleRate[0];
    const depth=parameters.bitDepth[0], dither=parameters.dither[0]>=0.5;
    const jitter=parameters.jitter[0]>=0.5;
    const bits=2+Math.round(depth*14), levels=Math.pow(2,bits-1)-1;
    const holdBase=1+Math.round(Math.pow(1-rate,2)*31);
    for(let ch=0; ch<output.length; ch++){
      const src=input[ch]||input[0], dst=output[ch];
      let held=this.held[ch]||0, left=this.left[ch]||0;
      for(let i=0; i<dst.length; i++){
        if(left<=0){
          let sample=((src&&src[i])||0)*gain;
          if(dither) sample+=(Math.random()-Math.random())/levels;
          held=Math.round(sample*levels)/levels;
          left=jitter ? Math.max(1,Math.round(holdBase*(0.5+Math.random()))) : holdBase;
        }
        dst[i]=held; left--;
      }
      this.held[ch]=held; this.left[ch]=left;
    }
    return true;
  }
}
registerProcessor('arena-bitcrusher', ArenaBitcrusher);`;

function ensureBitcrusherWorklet(ctx){
  const rt = state.audioRuntime;
  if(rt.workletState !== 'idle') return;
  const canLoad = ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function'
    && typeof Blob !== 'undefined' && window.URL && typeof window.URL.createObjectURL === 'function';
  if(!canLoad){ rt.workletState = 'unavailable'; return; }
  rt.workletState = 'loading';
  const url = window.URL.createObjectURL(new Blob([BITCRUSH_WORKLET], {type:'text/javascript'}));
  rt.workletPromise = Promise.resolve(ctx.audioWorklet.addModule(url)).then(() => {
    rt.workletState = 'ready';
    /* Replace only fallback Bitcrusher stages, once, on their next sync. */
    const mark = graph => {
      if(graph && graph.stages.some(stage => stage.name === 'Bitcrusher')) graph.rebuild = true;
    };
    for(const s of state.pool.values()){
      mark(s.audioGraph);
    }
    mark(rt.compositionBus);
    for(const bus of rt.groupBuses.values()) mark(bus);
  }).catch(err => {
    rt.workletState = 'unavailable';
    state.errors.push('Bitcrusher AudioWorklet: ' + String(err));
  }).finally(() => { try { window.URL.revokeObjectURL(url); } catch {} });
}

function biquad(ctx, type, frequency, q, gain){
  const n = ctx.createBiquadFilter();
  n.type = type;
  setAudioParam(n.frequency, frequency, ctx);
  if(n.Q) setAudioParam(n.Q, q == null ? 0.707 : q, ctx);
  if(n.gain && gain != null) setAudioParam(n.gain, gain, ctx);
  return n;
}

const norm = value => clamp(Number.isFinite(+value) ? +value : 0, 0, 1);
function frequencyHz(value, ctx){
  const high = Math.min(20000, ((ctx.sampleRate || 48000) * 0.45));
  return 20 * Math.pow(high / 20, norm(value));
}
const resonanceQ = value => 0.707 + norm(value) * 19.293;
/* Pre/Post Gain default to 0.1 in Arena. Anchor that point at unity and expose
   the remainder as an inferred logarithmic gain range. */
const distortionGain = value => Math.pow(10, ((norm(value) - 0.1) * 24) / 20);

function bitcrusherFallback(ctx){
  const gain = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const rate = biquad(ctx, 'lowpass', frequencyHz(1,ctx), 0.707);
  gain.connect(shaper); shaper.connect(rate);
  shaper.curve = bitcrushCurve(16); shaper.oversample = 'none';
  const nodes = [gain,shaper,rate];
  const controls = {kind:'bitcrusher-fallback', gain:gain.gain, shaper, rate:rate.frequency};
  let noise = null;
  /* Native-node fallback for browsers where AudioWorklet is blocked. Noise is
     real dither, and its second branch approximates sample-clock jitter by
     modulating the anti-alias filter without a main-thread audio callback. */
  if(typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function'){
    try {
      const length = Math.max(256, Math.min(4096, ctx.sampleRate || 48000));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate || 48000);
      const data = buffer.getChannelData(0);
      for(let i=0; i<data.length; i++) data[i] = Math.random()*2-1;
      noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true;
      const dither = ctx.createGain(), jitter = ctx.createGain();
      setAudioParam(dither.gain,0,ctx); setAudioParam(jitter.gain,0,ctx);
      noise.connect(dither); dither.connect(shaper);
      noise.connect(jitter); jitter.connect(rate.frequency);
      noise.start(); nodes.push(noise,dither,jitter);
      controls.dither=dither.gain; controls.jitter=jitter.gain;
    } catch {}
  }
  return {
    input:gain, output:rate, nodes, controls,
    stop:() => { if(noise) try { noise.stop(); } catch {} }
  };
}

function processor(ctx, name){
  let input, output, nodes = [], stop = null, controls = {};
  if(name === 'Bitcrusher'){
    ensureBitcrusherWorklet(ctx);
    const Worklet = window.AudioWorkletNode;
    if(state.audioRuntime.workletState === 'ready' && Worklet){
      try { input = output = new Worklet(ctx, 'arena-bitcrusher'); } catch {}
    }
    if(input){
      nodes = [input]; controls = {kind:'bitcrusher-worklet', params:input.parameters};
    } else {
      return bitcrusherFallback(ctx);
    }
  } else if(name === 'Distortion'){
    const pre=ctx.createGain(), clean=ctx.createGain(), shape=ctx.createWaveShaper();
    const driven=ctx.createGain(), sum=ctx.createGain(), tone=biquad(ctx,'lowpass',frequencyHz(1,ctx),.707);
    const post=ctx.createGain();
    shape.curve=DISTORT_CURVE; shape.oversample='4x';
    pre.connect(clean); clean.connect(sum);
    pre.connect(shape); shape.connect(driven); driven.connect(sum);
    sum.connect(tone); tone.connect(post);
    input=pre; output=post; nodes=[pre,clean,shape,driven,sum,tone,post];
    controls={pre:pre.gain,clean:clean.gain,drive:driven.gain,tone:tone.frequency,post:post.gain};
  } else if(name === 'EQ-3'){
    const low = biquad(ctx, 'lowshelf', 180, 0.707, 0);
    const mid = biquad(ctx, 'peaking', 1000, 0.8, 0);
    const high = biquad(ctx, 'highshelf', 5000, 0.707, 0);
    low.connect(mid); mid.connect(high);
    input = low; output = high; nodes = [low, mid, high];
    controls={low:low.gain,mid:mid.gain,high:high.gain};
  } else if(name === 'Flanger'){
    const head = ctx.createGain();
    const direct = ctx.createGain();
    const delay = ctx.createDelay(0.05);
    const feedback = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const delayed = ctx.createGain();
    const sum = ctx.createGain();
    setAudioParam(direct.gain,.5,ctx); setAudioParam(delayed.gain,.5,ctx);
    head.connect(direct); direct.connect(sum);
    head.connect(delay);
    delay.connect(feedback); feedback.connect(delay);
    lfo.connect(depth); depth.connect(delay.delayTime);
    delay.connect(delayed); delayed.connect(sum);
    lfo.start();
    input=head; output=sum; nodes=[head,direct,delay,feedback,lfo,depth,delayed,sum];
    controls={width:delay.delayTime,feedback:feedback.gain,rate:lfo.frequency,
              depth:depth.gain,invert:delayed.gain};
    stop = () => { try { lfo.stop(); } catch {} };
  } else if(name === 'HighPass'){
    input = output = biquad(ctx, 'highpass', frequencyHz(0,ctx), 0.707);
    nodes = [input];
    controls={frequency:input.frequency,resonance:input.Q};
  } else if(name === 'LowPass'){
    input = output = biquad(ctx, 'lowpass', frequencyHz(1,ctx), 0.707);
    nodes = [input];
    controls={frequency:input.frequency,resonance:input.Q};
  }
  return {input, output, nodes, stop, controls};
}

function stageValue(stage, key, value, apply){
  if(Object.is(stage.values[key],value)) return;
  stage.values[key]=value; apply(value);
}
function updateProcessor(stage, fx, ctx){
  const p=fx.params, c=stage.processor.controls || {};
  if(fx.name === 'Bitcrusher'){
    if(c.kind === 'bitcrusher-worklet'){
      const set=(key,value) => stageValue(stage,key,value,v=>setAudioParam(c.params.get(key),v,ctx));
      set('gain',p['Gain']); set('sampleRate',p['Sample Rate']); set('bitDepth',p['Bit Depth']);
      set('dither',p['Dither']?1:0); set('jitter',p['Jitter']?1:0);
    } else {
      const bits=2+Math.round(p['Bit Depth']*14), rate=frequencyHz(p['Sample Rate'],ctx);
      stageValue(stage,'gain',p['Gain'],v=>setAudioParam(c.gain,v,ctx));
      stageValue(stage,'bits',bits,v=>{ c.shaper.curve=bitcrushCurve(v); });
      stageValue(stage,'rate',rate,v=>setAudioParam(c.rate,v,ctx));
      const levels=Math.pow(2,bits-1)-1;
      const dither=p['Dither'] ? 0.5/levels : 0;
      const jitter=p['Jitter'] ? rate*0.15 : 0;
      stageValue(stage,'dither',dither,v=>setAudioParam(c.dither,v,ctx));
      stageValue(stage,'jitter',jitter,v=>setAudioParam(c.jitter,v,ctx));
    }
  } else if(fx.name === 'Distortion'){
    const pre=distortionGain(p['Pre Gain']), drive=p['Drive'];
    const tone=frequencyHz(p['Tone'],ctx), post=distortionGain(p['Post Gain']);
    stageValue(stage,'pre',pre,v=>setAudioParam(c.pre,v,ctx));
    stageValue(stage,'clean',1-drive,v=>setAudioParam(c.clean,v,ctx));
    stageValue(stage,'drive',drive,v=>setAudioParam(c.drive,v,ctx));
    stageValue(stage,'tone',tone,v=>setAudioParam(c.tone,v,ctx));
    stageValue(stage,'post',post,v=>setAudioParam(c.post,v,ctx));
  } else if(fx.name === 'EQ-3'){
    for(const [key,target] of [['Low',c.low],['Mid',c.mid],['High',c.high]]){
      const db=(p[key]-.5)*24;
      stageValue(stage,key,db,v=>setAudioParam(target,v,ctx));
    }
  } else if(fx.name === 'Flanger'){
    const width=.0003+p['Width']*.0197;
    const rate=.05+p['Rate']*9.95;
    stageValue(stage,'width',width,v=>setAudioParam(c.width,v,ctx));
    stageValue(stage,'depth',p['Depth']*width*.5,v=>setAudioParam(c.depth,v,ctx));
    stageValue(stage,'rate',rate,v=>setAudioParam(c.rate,v,ctx));
    stageValue(stage,'feedback',p['Feedback']*.95,v=>setAudioParam(c.feedback,v,ctx));
    stageValue(stage,'invert',p['Invert']?-.5:.5,v=>setAudioParam(c.invert,v,ctx));
  } else if(fx.name === 'HighPass' || fx.name === 'LowPass'){
    stageValue(stage,'frequency',frequencyHz(p['Frequency'],ctx),v=>setAudioParam(c.frequency,v,ctx));
    stageValue(stage,'resonance',resonanceQ(p['Resonance']),v=>setAudioParam(c.resonance,v,ctx));
  }
}

function buildStage(ctx, upstream, fx){
  const dry = ctx.createGain(), wet = ctx.createGain(), mix = ctx.createGain();
  const proc = processor(ctx, fx.name);
  upstream.connect(dry); dry.connect(mix);
  upstream.connect(proc.input); proc.output.connect(wet); wet.connect(mix);
  return {
    name:fx.name, dry, wet, mix, processor:proc,
    lastDry:null, lastWet:null, values:Object.create(null)
  };
}
function destroyStage(stage){
  if(!stage) return;
  if(stage.processor && stage.processor.stop) stage.processor.stop();
  disconnect(stage.dry); disconnect(stage.wet); disconnect(stage.mix);
  for(const node of (stage.processor && stage.processor.nodes) || []) disconnect(node);
}

function rebuildEffects(graph, effects){
  disconnect(graph.head);
  graph.stages.forEach(destroyStage);
  graph.stages = [];
  let upstream = graph.head;
  for(const fx of effects){
    const stage = buildStage(graph.context, upstream, fx);
    graph.stages.push(stage);
    upstream = stage.mix;
  }
  upstream.connect(graph.master);
  graph.signature = effects.map(fx => fx.name).join('\u001f');
  graph.rebuild = false;
}

function updateEffectGraph(graph, rawEffects){
  const effects=effectList(rawEffects);
  const signature=effects.map(fx=>fx.name).join('\u001f');
  if(graph.rebuild || graph.signature!==signature) rebuildEffects(graph,effects);
  for(let i=0;i<graph.stages.length;i++){
    const stage=graph.stages[i], fx=effects[i];
    const wet=fx.bypassed ? 0 : fx.drywet, dry=1-wet;
    if(stage.lastDry!==dry){ setAudioParam(stage.dry.gain,dry,graph.context); stage.lastDry=dry; }
    if(stage.lastWet!==wet){ setAudioParam(stage.wet.gain,wet,graph.context); stage.lastWet=wet; }
    updateProcessor(stage,fx,graph.context);
  }
}

function newAudioBus(ctx, key, destination){
  const head=ctx.createGain(), master=ctx.createGain();
  const pan=typeof ctx.createStereoPanner==='function' ? ctx.createStereoPanner() : ctx.createGain();
  head.connect(master); master.connect(pan); pan.connect(destination);
  return {
    kind:'bus', key, context:ctx, head, master, pan,
    hasStereoPan:!!pan.pan, stages:[], signature:'', rebuild:false,
    lastVolume:null, lastPan:null, members:new Set(), meter:null
  };
}

/* OBS keeps metering beside the gain control, but the meter is an observer of
   the existing signal graph rather than another audio path. Mirror that
   architecture: a splitter and two analysers hang off the post-pan node. They
   never connect to the destination and never alter gain, routing or latency.

   OBS's published Audio Mixer guide distinguishes four readings: an immediate
   input indicator, a falling Peak Programme Meter, an approximately 300 ms VU
   reading, and a long peak hold. Keep their ballistics beside the analyser so
   opening/rebuilding UI cannot reset the measurement, and so no second timer or
   render loop is needed. */
const METER_FLOOR_DB=-60;
const METER_PPM_DECAY_DB_PER_SECOND=11.76;
const METER_VU_INTEGRATION_MS=300;
const METER_PEAK_HOLD_MS=20000;
const METER_CLIP_LATCH_MS=1000;
const METER_NEAR_CLIP_DB=-0.5;
const METER_CLIP_DB=0;

function meterChannelState(){
  return {ppmDb:METER_FLOOR_DB,vuPower:0,peakHoldDb:METER_FLOOR_DB,
    peakHoldUntil:0,clippingUntil:0};
}
function meterDb(amplitude){
  return Math.max(METER_FLOOR_DB,20*Math.log10(Math.max(+amplitude||0,0.001)));
}
function meterLevel(db){
  const value=Number.isFinite(+db)?+db:METER_FLOOR_DB;
  return clamp((Math.max(METER_FLOOR_DB,value)-METER_FLOOR_DB)/
    -METER_FLOOR_DB,0,1);
}
function meterClock(owner){
  const seconds=owner&&owner.context&&+owner.context.currentTime;
  if(Number.isFinite(seconds)&&seconds>=0) return seconds*1000;
  if(typeof performance!=='undefined'&&performance&&typeof performance.now==='function')
    return performance.now();
  return Date.now();
}
function meterInputZone(db,active){
  if(!active) return 'silent';
  /* OBS Audio Mixer Technical Details: dark green below -50 dBFS, green to
     -20, yellow to -9, red to -0.5, and white above that near-clip point. */
  if(db < -50) return 'dark-green';
  if(db < -20) return 'green';
  if(db < -9) return 'yellow';
  if(db < METER_NEAR_CLIP_DB) return 'red';
  return 'white';
}
function silentMeterReading(channelCount){
  const channel=()=>({left:0,right:0,leftDb:METER_FLOOR_DB,rightDb:METER_FLOOR_DB,
    db:METER_FLOOR_DB});
  return {
    left:0,right:0,peak:0,db:METER_FLOOR_DB,
    channelCount:Math.max(0,+channelCount||0),
    ppm:Object.assign(channel(),{decayDbPerSecond:METER_PPM_DECAY_DB_PER_SECOND}),
    vu:Object.assign(channel(),{integrationMs:METER_VU_INTEGRATION_MS}),
    peakHold:Object.assign(channel(),{holdMs:METER_PEAK_HOLD_MS}),
    inputPeak:Object.assign(channel(),{leftZone:'silent',rightZone:'silent',active:false}),
    clipping:{left:false,right:false,any:false,latchMs:METER_CLIP_LATCH_MS}
  };
}
function ensureMeter(owner){
  if(!owner || owner.meter || !owner.context || !owner.pan) return owner && owner.meter;
  const ctx=owner.context;
  try {
    const splitter=ctx.createChannelSplitter(2);
    const analysers=[ctx.createAnalyser(),ctx.createAnalyser()];
    analysers.forEach(analyser=>{
      analyser.fftSize=256;
      analyser.smoothingTimeConstant=0;
    });
    owner.pan.connect(splitter);
    splitter.connect(analysers[0],0);
    splitter.connect(analysers[1],1);
    owner.meter={splitter,analysers,data:analysers.map(a=>new Float32Array(a.fftSize)),
      channels:[meterChannelState(),meterChannelState()],lastReadAt:null};
  } catch(error){
    owner.meter={failed:true};
    state.errors.push('WebAudio meter: '+String(error));
  }
  return owner.meter;
}
function destroyMeter(owner){
  const meter=owner&&owner.meter;
  if(!meter) return;
  disconnect(meter.splitter);
  (meter.analysers||[]).forEach(disconnect);
  owner.meter=null;
}

/* A live microphone is an input observer, not a programme source. Keep this
   as a separate graph primitive instead of a muted playback Slot: muting the
   normal Slot graph would also flatten the requested meter, and a later reset
   or mapping could re-open the route to speakers, recordings and streams. */
function attachInputMeter(key,stream,label){
  key=String(key||'');
  const tracks=stream&&stream.getAudioTracks?stream.getAudioTracks():[];
  if(!key||!tracks.some(track=>track.readyState!=='ended')){
    if(key) detachInputMeter(key);
    return false;
  }
  const rt=state.audioRuntime,prior=rt.inputMeters.get(key);
  if(prior&&prior.stream===stream){ prior.label=String(label||prior.label||key); return true; }
  detachInputMeter(key);
  const ctx=audioContext();
  if(!ctx||typeof ctx.createMediaStreamSource!=='function') return false;
  try{
    const source=ctx.createMediaStreamSource(stream);
    const record={kind:'input-meter',key,stream,label:String(label||key),context:ctx,
      source,pan:source,meter:null};
    rt.inputMeters.set(key,record);
    ensureMeter(record);
    if(ctx.state==='suspended') bindAudioUnlock(ctx);
    return true;
  }catch(error){
    state.errors.push('Input meter source: '+String(error));
    return false;
  }
}
function detachInputMeter(key){
  key=String(key||'');
  const rt=state.audioRuntime,record=rt.inputMeters.get(key);
  if(!record) return false;
  destroyMeter(record); disconnect(record.source); rt.inputMeters.delete(key);
  return true;
}
function readMeter(owner){
  const meter=ensureMeter(owner);
  if(!meter || meter.failed) return silentMeterReading(audioOutputChannelCount(owner&&owner.context));
  const now=meterClock(owner);
  const elapsedMs=meter.lastReadAt==null ? (1000/30) : Math.max(0,now-meter.lastReadAt);
  meter.lastReadAt=now;
  const elapsedSeconds=elapsedMs/1000;
  const vuAlpha=1-Math.exp(-elapsedMs/METER_VU_INTEGRATION_MS);
  const levels=meter.analysers.map((analyser,index)=>{
    const data=meter.data[index];
    analyser.getFloatTimeDomainData(data);
    let sum=0, peak=0;
    for(let i=0;i<data.length;i++){
      const value=Math.abs(data[i]);
      sum+=value*value; if(value>peak) peak=value;
    }
    const rms=Math.sqrt(sum/Math.max(1,data.length));
    const samplePeakDb=meterDb(peak), state=meter.channels[index];

    /* The main OBS bar is a sample-peak PPM: attack immediately and fall by the
       documented 11.76 dB each second. The VU indicator integrates power over
       roughly 300 ms, which is closer to perceived loudness than sample peak. */
    state.ppmDb=samplePeakDb>=state.ppmDb ? samplePeakDb :
      Math.max(samplePeakDb,METER_FLOOR_DB,state.ppmDb-
        METER_PPM_DECAY_DB_PER_SECOND*elapsedSeconds);
    const rmsPower=rms*rms;
    state.vuPower+=(rmsPower-state.vuPower)*vuAlpha;
    const vuDb=meterDb(Math.sqrt(Math.max(0,state.vuPower)));

    /* OBS holds the loudest peak for 20 seconds, then returns the marker to the
       current PPM. A full-scale clipping sample also latches for one second so a
       single bad transient stays visible long enough for the operator to act. */
    if(samplePeakDb>=state.peakHoldDb){
      state.peakHoldDb=samplePeakDb;
      state.peakHoldUntil=now+METER_PEAK_HOLD_MS;
    } else if(now>=state.peakHoldUntil){
      state.peakHoldDb=state.ppmDb;
    }
    if(samplePeakDb>=METER_CLIP_DB) state.clippingUntil=now+METER_CLIP_LATCH_MS;
    const active=peak>0.001;
    return {
      ppmDb:state.ppmDb,ppm:meterLevel(state.ppmDb),
      vuDb,vu:meterLevel(vuDb),
      samplePeakDb,samplePeak:meterLevel(samplePeakDb),
      peakHoldDb:state.peakHoldDb,peakHold:meterLevel(state.peakHoldDb),
      inputZone:meterInputZone(samplePeakDb,active),active,
      clipping:now<state.clippingUntil
    };
  });
  const left=levels[0],right=levels[1],max=(key)=>Math.max(left[key],right[key]);
  return {
    /* Backward-compatible scalar keys. `left`/`right`/`db` now describe the
       requested PPM main bars; `peak` remains the immediate sample peak so an
       older UI can keep applying its own hold until it adopts peakHold below. */
    left:left.ppm,right:right.ppm,peak:max('samplePeak'),db:max('ppmDb'),
    channelCount:audioOutputChannelCount(owner&&owner.context),
    ppm:{left:left.ppm,right:right.ppm,leftDb:left.ppmDb,rightDb:right.ppmDb,
      db:max('ppmDb'),decayDbPerSecond:METER_PPM_DECAY_DB_PER_SECOND},
    vu:{left:left.vu,right:right.vu,leftDb:left.vuDb,rightDb:right.vuDb,
      db:max('vuDb'),integrationMs:METER_VU_INTEGRATION_MS},
    peakHold:{left:left.peakHold,right:right.peakHold,leftDb:left.peakHoldDb,
      rightDb:right.peakHoldDb,db:max('peakHoldDb'),holdMs:METER_PEAK_HOLD_MS},
    inputPeak:{left:left.samplePeak,right:right.samplePeak,leftDb:left.samplePeakDb,
      rightDb:right.samplePeakDb,db:max('samplePeakDb'),leftZone:left.inputZone,
      rightZone:right.inputZone,active:left.active||right.active},
    clipping:{left:left.clipping,right:right.clipping,any:left.clipping||right.clipping,
      latchMs:METER_CLIP_LATCH_MS}
  };
}
function ensureCompositionBus(ctx){
  const rt=state.audioRuntime;
  if(!rt.compositionBus){
    const route=rt.outputRoute;
    rt.compositionBus=newAudioBus(ctx,'composition',route?.programme || route?.speaker || ctx.destination);
    if(route?.programme) route.programme.connect(route.speaker);
    /* A stream tap outlives any one composition bus, so a bus rebuilt after the
       last audio slot was released has to be re-joined to it here. */
    if(rt.streamTap) (route?.programme || rt.compositionBus.pan).connect(rt.streamTap);
  }
  return rt.compositionBus;
}

/* The composition master bus, tapped as a MediaStream for the streamer and the
   recorder.

   Taken off `pan` — the last node before ctx.destination — so the tap carries
   exactly what the operator hears: post clip gain, post layer/group bus, post
   audio effects, post master volume and pan. A tap taken further upstream would
   quietly stream a different mix than the one being monitored.

   This is the SAME AudioContext the composition already plays through
   (audioContext() memoises one), not a second handle and not a second sample
   clock. Returns null rather than an empty node when no context exists yet —
   the caller reports that as the real reason instead of adding a silent track
   and calling the stream "with audio". */
function streamDestination(){
  const rt=state.audioRuntime;
  const ctx=audioContext();
  if(!ctx || typeof ctx.createMediaStreamDestination!=='function') return null;
  if(!rt.streamTap) rt.streamTap=ctx.createMediaStreamDestination();
  if(rt.outputRoute?.programme)window.OpenLiveAudioOutput.markMasterDelay(rt.streamTap.stream);
  /* Connect here, not only in ensureCompositionBus(). By the time anything asks
     to stream, the composition bus almost always ALREADY exists — a clip with
     audio built it — so relying on the creation path alone handed back a tap
     that was wired to nothing and produced a track of pure silence. Measured:
     RMS 0.00000 across ten samples. WebAudio ignores a duplicate identical
     connection, so calling this every time is safe and idempotent. */
  const bus=ensureCompositionBus(ctx);
  (rt.outputRoute?.programme || bus.pan).connect(rt.streamTap);
  return rt.streamTap;
}
function ensureGroupBus(ctx, spec){
  const key=String(spec && (spec.id!=null ? spec.id : spec.key!=null ? spec.key : ''));
  if(!key) return null;
  const rt=state.audioRuntime;
  let bus=rt.groupBuses.get(key);
  if(!bus){
    bus=newAudioBus(ctx,key,ensureCompositionBus(ctx).head);
    rt.groupBuses.set(key,bus);
  }
  return bus;
}
function updateBus(bus, spec){
  spec=spec||{};
  updateEffectGraph(bus,spec.effects);
  const volume=spec.muted ? 0 : clamp(spec.volume==null ? 1 : +spec.volume||0,0,1);
  const pan=clamp(spec.pan==null ? 0 : +spec.pan||0,-1,1);
  if(bus.lastVolume!==volume){ setAudioParam(bus.master.gain,volume,bus.context); bus.lastVolume=volume; }
  if(bus.hasStereoPan && bus.lastPan!==pan){ setAudioParam(bus.pan.pan,pan,bus.context); bus.lastPan=pan; }
}
function destroyBus(bus){
  if(!bus) return;
  destroyMeter(bus);
  bus.stages.forEach(destroyStage);
  disconnect(bus.head); disconnect(bus.master); disconnect(bus.pan);
  bus.members.clear();
}
function releaseGroupRoute(s){
  const graph=s && s.audioGraph, key=graph && graph.groupKey;
  if(!key) return;
  const rt=state.audioRuntime, bus=rt.groupBuses.get(key);
  if(bus){
    bus.members.delete(s);
    if(!bus.members.size){ destroyBus(bus); rt.groupBuses.delete(key); }
  }
  graph.groupKey=null;
}
function routeSlot(s, graph, groupSpec){
  const nextKey=groupSpec && (groupSpec.id!=null ? groupSpec.id : groupSpec.key);
  const key=nextKey==null ? null : String(nextKey);
  const comp=ensureCompositionBus(graph.context);
  if(graph.routeKey===key) return key ? state.audioRuntime.groupBuses.get(key) : comp;
  disconnect(graph.pan);
  releaseGroupRoute(s);
  const group=key ? ensureGroupBus(graph.context,groupSpec) : null;
  if(group){ group.members.add(s); graph.groupKey=key; graph.pan.connect(group.head); }
  else graph.pan.connect(comp.head);
  graph.routeKey=key;
  return group || comp;
}

function ensureAudioGraph(s){
  if(!s || !s.audio || s.audioGraphFailed) return null;
  if(s.audioGraph) return s.audioGraph;
  const ctx = audioContext();
  if(!ctx) return null;
  try {
    const source = s.liveStream
      ? ctx.createMediaStreamSource(s.liveStream)
      : ctx.createMediaElementSource(s.audio);
    const head = ctx.createGain();
    const master = ctx.createGain();
    const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : ctx.createGain();
    source.connect(head); head.connect(master); master.connect(pan);
    s.audioGraph = {
      context:ctx, source, head, master, pan,
      hasStereoPan: !!pan.pan,
      stages:[], signature:'', rebuild:false,
      lastVolume:null, lastPan:null,
      routeKey:undefined, groupKey:null, meter:null
    };
    if(!s.liveStream) s.audio.volume = 1;      // master GainNode now owns level
    return s.audioGraph;
  } catch(err){
    s.audioGraphFailed = true;
    state.errors.push('WebAudio media source: ' + String(err));
    return null;
  }
}

function effectiveAudioVolume(opts){
  opts=opts||{};
  /* Track presence is independent of transport. Removing/closing a Clip's
     Audio track silences this branch without stopping the shared Clip playhead
     or its Video decoder. Layer A/M are already folded into `opts.volume` by
     app.js; this final gate prevents a removed track from leaking through when
     those faders remain at 100%. */
  const slot=(opts.muted || opts.audioEnabled === false)
    ? 0 : clamp(opts.volume==null ? 0 : +opts.volume||0,0,1);
  const group=opts.group ? (opts.group.muted?0:clamp(opts.group.volume==null ? 1 : +opts.group.volume||0,0,1)) : 1;
  const composition=opts.composition
    ? (opts.composition.muted?0:clamp(opts.composition.volume==null ? 1 : +opts.composition.volume||0,0,1)) : 1;
  return slot*group*composition;
}
function updateAudioGraph(s, opts){
  const graph = ensureAudioGraph(s);
  const volume = (opts.muted || opts.audioEnabled === false)
    ? 0 : clamp(opts.volume == null ? 0 : +opts.volume || 0, 0, 1);
  const pan = clamp(opts.pan == null ? 0 : +opts.pan || 0, -1, 1);
  if(!graph){
    /* WebAudio is optional. Direct playback keeps the established volume and
       transport behaviour; pan/effects are unavailable rather than fatal. */
    if(!s.liveStream) s.audio.volume = effectiveAudioVolume(opts);
    return null;
  }
  if(!s.liveStream) s.audio.volume = 1;
  updateEffectGraph(graph,opts.effects);
  if(graph.lastVolume !== volume){ setAudioParam(graph.master.gain, volume, graph.context); graph.lastVolume = volume; }
  if(graph.hasStereoPan && graph.lastPan !== pan){ setAudioParam(graph.pan.pan, pan, graph.context); graph.lastPan = pan; }
  const composition=ensureCompositionBus(graph.context);
  updateBus(composition,opts.composition);
  const group=routeSlot(s,graph,opts.group);
  if(opts.group && group!==composition) updateBus(group,opts.group);
  if(graph.context.state === 'suspended') bindAudioUnlock(graph.context);
  return graph;
}

function destroyAudioGraph(s){
  const graph = s && s.audioGraph;
  if(!graph) return;
  releaseGroupRoute(s);
  destroyMeter(graph);
  graph.stages.forEach(destroyStage);
  disconnect(graph.source); disconnect(graph.head); disconnect(graph.master); disconnect(graph.pan);
  s.audioGraph = null;
  if(![...state.pool.values()].some(slot => !!slot.audioGraph)){
    const rt=state.audioRuntime;
    for(const bus of rt.groupBuses.values()) destroyBus(bus);
    rt.groupBuses.clear();
    /* rt.streamTap deliberately survives: a live stream must not lose its audio
       track because the last clip carrying audio happened to be released.
       ensureCompositionBus() re-joins the next bus to it. */
    destroyBus(rt.compositionBus); rt.compositionBus=null;
  }
}

function audioOutputChannelCount(ctx){
  const count=ctx&&ctx.destination&&+ctx.destination.channelCount;
  return Number.isFinite(count)&&count>0 ? Math.round(count) : (ctx?2:0);
}
function audioMixerSnapshot(){
  const options=arguments[0]||{};
  const includeSources=options.includeSources!==false;
  const includeMaster=options.includeMaster!==false;
  const meterKeys=new Set(Array.isArray(options.meterKeys)?options.meterKeys.map(String):[]);
  const ctx=state.audioRuntime.context;
  const composition=state.audioRuntime.compositionBus;
  const channelCount=audioOutputChannelCount(ctx), sources=[], meters=Object.create(null);
  let sourceCount=0;
  for(const [layer,s] of state.pool){
    if(!s || !s.audio || !s.id) continue;
    sourceCount++;
    /* A compact caller can request exact source keys without waking every
       source analyser. Source identity remains available as sourceCount, and
       the default remains the historical full snapshot for API compatibility. */
    const key=String(layer),requested=meterKeys.has(key);
    if(!includeSources&&!requested) continue;
    const media=state.byId.get(s.id);
    const levels=s.audioGraph?readMeter(s.audioGraph):silentMeterReading(channelCount);
    if(requested) meters[key]=levels;
    if(!includeSources) continue;
    sources.push({layer:typeof layer==='number'?layer:null,key,id:s.id,name:String(s.liveLabel||(media&&media.name)||s.id),
      /* A muted or transport-paused source is still assigned to the active
         Layer and must not disappear from the mixer when its gain reaches zero. */
      active:s.audioEnabled!==false && (s.liveStream?s.liveStream.active!==false:true),
      playing:!s.audio.paused,audioEnabled:s.audioEnabled!==false,
      levels});
  }
  /* Meter-only inputs are intentionally absent from sources/sourceCount: the
     Audio Mixer lists routes that reach programme output, and a microphone
     observer is never one of those routes. Exact compact meters can still ask
     for it by key without waking any other analyser. */
  for(const [key,input] of state.audioRuntime.inputMeters){
    if(meterKeys.has(String(key))) meters[String(key)]=readMeter(input);
  }
  sources.sort((a,b)=>a.layer-b.layer);
  return {contextState:ctx ? ctx.state : 'idle',sampleRate:ctx&&Number.isFinite(+ctx.sampleRate)?+ctx.sampleRate:0,
    output:state.audioRuntime.outputRoute?.status() || null,
    channelCount,sourceCount,inputCount:state.audioRuntime.inputMeters.size,
    master:includeMaster&&composition?readMeter(composition):silentMeterReading(channelCount),sources,meters};
}

function attachAudioDecoder(s, m, opts){
  const audioSource = !(opts && opts.silent)
    ? (m.audio || (m.hasAudio && m.video ? m.video : null)) : null;
  const url = audioSource ? encodeURI(audioSource) : null;
  if(s.audio && s.audioUrl === url) return s.audio;
  if(s.audio){
    s.audio.pause(); destroyAudioGraph(s);
    s.audio.removeAttribute('src');try{s.audio.load();}catch(error){}
    s.audio = null;
  }
  s.audioPlayPending=null;delete s.seekTargets.audio;delete s.forwardSync.audio;
  s.audioGraphFailed = false;
  s.audioUrl = url;
  if(!url){ s.audioSource = null; return null; }
  const a = new Audio(url);
  a.loop = true; a.volume = 0;
  s.audio = a;
  s.audioSource = m.audio ? 'sidecar' : 'container';
  return a;
}

/* Original presentation views own embedded media decoders. Attachments borrow
   the drawable; they do not restart its transport or dispose the document.
   Embedded audio stays muted until it has a route into the composition mixer,
   rather than bypassing programme gain, monitoring and streaming audio. */
function gatePresentationAudio(media){
  const player=media?.presentation?.player;
  if(!player?.mediaState)return;
  const value=player.mediaState(),items=value?.items||[];
  const embedded=items.length||player.slides?.some(slide=>slide.media?.some(item=>item.embedded));
  if(embedded){
    media.embeddedAudioUnavailable=true;
    media.presentation.embeddedAudioUnavailable='Embedded PowerPoint audio is muted because it is not routed into the composition mixer.';
  }
  if(items.some(item=>item.muted===false))player.setMuted?.(true);
}
function hasOpenPresentationAttachment(player,except){
  return [...state.pool.values()].some(slot=>slot!==except&&slot.id!=null&&
    slot.media?.presentation?.player===player&&slot.videoEnabled!==false);
}
function pauseBorrowedPresentation(slot){
  const media=slot?.media,player=media?.presentation?.player;
  if(!player||hasOpenPresentationAttachment(player,slot))return;
  gatePresentationAudio(media);
  if(player.mediaState?.().playing)player.pauseMedia?.();
}

/* Point a layer's decoder at a clip. Called when the engine triggers. */
function attach(layer, ref, opts){
  const m = find(ref);
  const s = slot(layer);
  if(!m){ detach(layer); return null; }
  /* Native records carry a lazy browser-File preparation hook. Start it on first
     preview/trigger; a later attach observes the resulting cache URL. */
  if(m.requiresPrepare && !m.video && m.playable !== false && typeof m.ensurePlayable === 'function')
    m.ensurePlayable().catch(()=>{});
  const desiredUrl=m.video ? encodeURI(m.video) : null;
  const nativeRecord=m.nativeRecord||m.dxvRecord;
  const direct=!!(nativeRecord && nativeRecord.transport==='raw-rgba');
  const still=!!(m.mediaKind==='image' && desiredUrl && !direct);
  const pdfPlayer=m.presentation?.player;
  const sourceToken=pdfPlayer ? 'presentation:'+m.id
    : direct
    ? 'native:'+nativeRecord.source+':'+String(m.sourceRevision||0)
    : still ? 'image:'+desiredUrl+':'+String(m.sourceRevision||0)
    : desiredUrl || 'native-pending:'+String(m.prepareState||'none')+':'
      +String(m.sourceRevision||0)+':'+(m.playable===false?'blocked':'open');
  /* A conservative metadata probe can discover embedded audio after the Video
     decoder is already attached. Reconcile the Audio decoder even when the
     Clip identity did not change, otherwise that late positive signal would
     remain silent until a different Clip was triggered. */
  if(s.id === m.id && s.sourceToken === sourceToken&&s.media===m){ gatePresentationAudio(m);attachAudioDecoder(s,m,opts); return m; }

  pauseBorrowedPresentation(s);

  const dxv=window.OpenLiveDXV;
  if(dxv && dxv.detach) dxv.detach(s.video);
  s.generation++;
  s.videoPlayPending=null;s.seekTargets={};s.forwardSync={};s.seekCount=0;
  s.video.pause();
  if(s.videoUrl) s.video.removeAttribute('src');
  s.video.onerror=null; s.video.oncanplay=null; s.videoDecodeFallback=null;
  releaseStillDrawable(s);
  s.id = m.id; s.media=m; s.videoUrl=desiredUrl; s.sourceToken=sourceToken; s.failed = false;
  if(pdfPlayer){
    // The original document player owns its stable canvas. A pool attachment borrows that
    // drawable without serializing it to PNG or opening a video decoder.
    s.video.removeAttribute('src');
    gatePresentationAudio(m);
  }else if(still){
    /* Stills are full-resolution programme sources, not video elements and not
       their 320 px operator posters. Decode only when a Slot/Preview attaches
       this media; releasing the slot drops the sole retained Image reference. */
    s.video.removeAttribute('src');
    acquireStillDrawable(s,m,sourceToken,desiredUrl);
  } else if(direct && dxv && dxv.attach){
    s.video.removeAttribute('src');
    const generation=s.generation;
    const directOpts=Object.assign({},opts||{}, {onError:reason=>{
      if(s.generation!==generation || s.id!==m.id) return;
      s.failed=true;
      m.unplayableReason=reason||'Native media playback failed.'; state.dirty++;
    },onReady:()=>{
      if(s.generation!==generation || s.id!==m.id) return;
      s.failed=false; m.unplayableReason=null; state.dirty++;
    }});
    const decoder=dxv.attach(s.video,nativeRecord,directOpts);
    if(decoder && decoder.failed){
      s.failed=true; m.playable=false;
      m.unplayableReason=decoder.failed; state.dirty++;
    }
  } else if(m.video){
    const generation=s.generation;
    const originalURL=m.video;
    let fallbackStarted=false;
    const ownsBrowser=()=>s.generation===generation && s.media===m && s.videoUrl===desiredUrl;
    s.videoDecodeFallback=reason=>{
      if(!ownsBrowser() || fallbackStarted) return;
      s.failed=true; state.dirty++;
      const files=window.ArenaFiles;
      if(find(m.id)!==m || m.video!==originalURL && !(m.requiresPrepare && !m.video) ||
         typeof files?.fallbackToNative!=='function') return;
      fallbackStarted=true;
      /* Metadata and a successful poster do not guarantee that the actual
         playback decoder supports this stream. Open the retained original
         once, without letting an old decoder replace a newly triggered Clip. */
      let recoveryGeneration=generation;
      const ownsRecovery=()=>s.generation===recoveryGeneration && s.media===m && find(m.id)===m;
      const refresh=()=>{
        if(!ownsRecovery() || m.video) return;
        if(s.videoUrl){
          s.video.onerror=null; s.video.oncanplay=null;
          s.video.pause(); s.video.removeAttribute('src');
          try{ s.video.load(); }catch(error){}
        }
        attach(layer,m,opts);
        recoveryGeneration=s.generation;
        state.dirty++;
      };
      const failed=()=>{
        if(ownsRecovery()){ s.failed=true; state.dirty++; }
      };
      try{
        const pending=files.fallbackToNative(m,reason,{expectedURL:originalURL});
        /* Also release the failed browser/audio elements while preparation is
           pending. Free-running previews have no engine tick to do this. */
        refresh();
        Promise.resolve(pending).then(refresh,failed);
      }catch(error){ failed(); }
    };
    s.video.onerror = () => {
      if(!ownsBrowser()) return;
      const code=s.video.error?.code;
      if(code===3 || code===4){
        s.videoDecodeFallback(code===3
          ? 'The browser could not decode this video during playback.'
          : 'The browser does not support this video stream.');
      }else{ s.failed=true; state.dirty++; }
    };
    s.video.src = desiredUrl;
    s.video.load();
    /* Engine-owned layers start only when sync() says Playing. A paused
       outgoing transition must not briefly decode forwards on attachment. */
    if(opts && opts.free) playDecoder(s,'video');
    /* A preview decoder is never sync()'d — nothing drives its playhead — so it
       has to run itself. Kick it again once there are frames, in case the first
       play() landed before the source was ready. */
    if(opts && opts.free) s.video.oncanplay = () => {
      if(s.generation!==generation) return;
      playDecoder(s,'video');
    };
  } else {
    s.video.removeAttribute('src');
    s.failed = m.playable === false;
  }

  /* clips.htm — an AV Clip has one shared transport even when its Audio and
     Video tracks are backed by separate browser decoder elements. Prepared
     media normally points at an extracted .wav. User-imported MP4/WebM files
     can instead carry audio in the same container, so a positive metadata
     signal (`hasAudio`) uses that container as the audio decoder source. The
     Video element stays muted in both cases: only this Audio element reaches
     the WebAudio graph. */
  attachAudioDecoder(s,m,opts);
  return m;
}
function detach(layer){
  const s = state.pool.get(layer); if(!s) return;
  /* syncMedia visits empty Layers and outgoing transition slots every tick.
     Once this slot is retired there is no decoder left to reset. Repeating
     load() on an empty HTMLMediaElement queues abort/emptied work at show-clock
     cadence, and used to keep happening for the lifetime of an ejected Layer. */
  if(s.id==null && !s.sourceToken && !s.videoUrl && !s.audio &&
     !s.audioGraph && !s.liveStream && !s.image && !s.imageEntry) return;
  pauseBorrowedPresentation(s);
  if(window.OpenLiveDXV && OpenLiveDXV.detach){
    try { OpenLiveDXV.detach(s.video); } catch(error){ state.errors.push('DXV detach: '+String(error)); }
  }
  s.generation++;
  s.videoPlayPending=s.audioPlayPending=null;s.seekTargets={};s.forwardSync={};
  try { s.video.pause(); } catch(error){}
  try { s.video.removeAttribute('src'); } catch(error){}
  try { s.video.load(); } catch(error){}
  s.video.onerror=null; s.video.oncanplay=null; s.videoDecodeFallback=null; s.id = null; s.media=null; s.videoUrl=null; s.sourceToken=null;
  releaseStillDrawable(s);
  if(s.audio){
    try { s.audio.pause(); } catch(error){}
    try { s.audio.removeAttribute('src'); s.audio.load(); } catch(error){}
    try { destroyAudioGraph(s); }
    catch(error){ state.errors.push('Audio graph detach: '+String(error)); }
    finally { s.audio = null; }
  }
  s.audioGraphFailed = false; s.audioUrl = null; s.audioSource = null;
  s.liveStream = null; s.liveLabel = null;
}

function attachLive(layer, stream, label){
  const s=slot(layer), tracks=stream&&stream.getAudioTracks ? stream.getAudioTracks() : [];
  if(!tracks.length){ if(s.id||s.audio||s.liveStream) detach(layer); return false; }
  if(s.liveStream===stream) return true;
  detach(layer);
  s.id='live:'+String(label||layer); s.liveStream=stream; s.liveLabel=String(label||'Live Input');
  s.audio={paused:false,volume:1,pause(){ this.paused=true; },play(){ this.paused=false; return Promise.resolve(); }};
  s.audioSource='capture'; s.audioGraphFailed=false; ensureAudioGraph(s);
  return true;
}

function syncLive(layer, opts){
  const s=state.pool.get(layer); if(!s||!s.liveStream||!s.audio) return false;
  opts=opts||{}; s.audioEnabled=opts.audioEnabled!==false; updateAudioGraph(s,opts);
  return true;
}

/* A Composition replacement can remove Layer indexes entirely. The normal
   per-frame sync only visits Layers that still exist, so it cannot retire a
   decoder parked on (for example) old Layer 12 or transition slot "t12".
   Tear down every allocated slot while the old document identity is still
   known, then drop the pool entries themselves. The media catalogue, decoded
   posters and the long-lived stream destination are application resources and
   deliberately survive this document-runtime reset. */
function detachAll(){
  const keys=[...state.pool.keys()];
  keys.forEach(key=>{
    try { detach(key); }
    catch(error){ state.errors.push('Media detach '+String(key)+': '+String(error)); }
    finally { state.pool.delete(key); }
  });
  return keys.length;
}

/* --------------------------------------------------------------------------
   Sync — the engine's playhead is the truth
   -------------------------------------------------------------------------- */
const DRIFT = 0.25;                 // seconds of slack before we correct

function playDecoder(s,key){
  const element=s[key];if(!element||!element.paused||s[key+'PlayPending'])return;
  const generation=s.generation;
  const rejected=error=>{
    if(key==='video' && error?.name==='NotSupportedError' &&
       s.generation===generation && s[key]===element)
      s.videoDecodeFallback?.('The browser does not support this video stream.');
  };
  try{
    const pending=element.play();
    if(pending&&typeof pending.then==='function'){
      s[key+'PlayPending']=pending;
      pending.catch(rejected).finally(()=>{
        if(s.generation===generation&&s[key]===element&&s[key+'PlayPending']===pending)
          s[key+'PlayPending']=null;
      });
    }
  }catch(error){ rejected(error); }
}
function seekDecoder(s,key,want,tolerance){
  const element=s[key];if(!element)return;
  /* currentTime changes interrupt an outstanding seek. Keep only the newest
     engine target until that decode finishes; reverse/scrub can otherwise
     keep cancelling every frame on long-GOP footage. */
  s.seekTargets[key]=want;
  if(element.seeking || Math.abs(element.currentTime-want)<=tolerance)return;
  try{element.currentTime=want;s.seekCount++;}catch(error){}
}
function decoderPlaybackRate(element,speed,transportDuration){
  const cycle=Number(transportDuration),duration=Number(element.duration);
  const scale=Number.isFinite(cycle)&&cycle>0&&Number.isFinite(duration)&&duration>0 ? duration/cycle : 1;
  return clamp((Number.isFinite(speed)?speed:1)*scale,.0625,16);
}

function syncForwardDecoder(s,key,want,rate,fullSourceLoop){
  const element=s[key],previous=s.forwardSync[key];
  const now=typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();
  const elapsed=previous?Math.max(0,now-previous.at)/1000:0;
  const duration=Number(element.duration),initial=!previous?.aligned;
  const cyclic=fullSourceLoop&&element.loop&&Number.isFinite(duration)&&duration>0;
  const cycleDifference=value=>value>duration/2?value-duration:value<-duration/2?value+duration:value;
  const delta=previous?want-previous.want:0;
  /* Forward playback only wraps from the source tail to its head. A manual
     jump from the head back to the tail is a real cue, even when those two
     positions are close on the circular clock. */
  const clockDelta=cyclic&&delta<-duration/2?delta+duration:delta;
  const jump=!!previous&&(fullSourceLoop!==previous.fullSourceLoop||Math.abs(clockDelta)>Math.max(.1,elapsed*rate*2+.05));
  /* A slow initial decode still belongs to the original cue. Let a Play-from-
     start decoder deliver that frame instead of cancelling it to chase the
     clock accumulated during startup. A later operator jump updates the cue. */
  const cueWant=!previous||jump?want:previous.cueWant;
  const target=initial?cueWant:want;
  const rawError=target-element.currentTime;
  /* A browser may naturally wrap just before the engine reaches the same
     full-source Loop boundary. Treat those neighboring end/start positions
     as one continuous clock; seeking back to the tail and then to the head
     caused a pair of decode interruptions and black programme frames. */
  const error=cyclic&&!initial&&!jump?cycleDifference(rawError):rawError,drift=Math.abs(error);
  const ready=!s[key+'PlayPending']&&element.readyState>=2;
  const aligned=ready||!!previous?.aligned;
  let observed=element.currentTime,dropped=null;
  if(key==='video')try{
    const quality=element.getVideoPlaybackQuality?.();
    if(quality&&Number.isFinite(quality.totalVideoFrames)&&Number.isFinite(quality.droppedVideoFrames)){
      observed=Math.max(0,quality.totalVideoFrames-quality.droppedVideoFrames);
      dropped=Math.max(0,quality.droppedVideoFrames);
    }else if(Number.isFinite(element.webkitDecodedFrameCount)){
      observed=Math.max(0,element.webkitDecodedFrameCount-(Number(element.webkitDroppedFrameCount)||0));
      dropped=Math.max(0,Number(element.webkitDroppedFrameCount)||0);
    }
  }catch(error){}
  const progressed=!previous||observed!==previous.observed;
  const progressAt=progressed?now:previous.progressAt;
  /* A decoder can deliver some frames while dropping most of the requested
     frames. Accelerating it or seeking a long GOP at that point increases the
     work that caused the lag. Keep the requested base speed until delivery has
     had half a second without a new dropped frame. Explicit operator cues are
     still authoritative; this only defers ordinary clock-drift correction. */
  const newDrops=dropped!==null&&previous?.dropped!==null&&previous?.dropped!==undefined&&dropped>previous.dropped;
  const pressureUntil=newDrops?now+500:previous?.pressureUntil??0;
  const deliveryHealthy=now>=pressureUntil;
  let steadySince=previous?.steadySince??now;
  if(!deliveryHealthy||element.readyState<3||element.seeking||previous&&now-previous.progressAt>250)steadySince=now;
  const stableFrames=ready&&element.readyState>=3&&now-progressAt<=250&&now-steadySince>=250;
  const lastCorrectionAt=previous?.lastCorrectionAt??-Infinity;
  const forwardState=s.forwardSync[key]={want,at:now,aligned,observed,dropped,pressureUntil,progressAt,steadySince,lastCorrectionAt,fullSourceLoop,cueWant};
  /* A slow frame can leave an otherwise healthy playing decoder a little
     behind the show clock. Hard-seeking every 250 ms made long-GOP footage
     cancel continuous playback again as soon as the previous seek finished.
     Catch up gradually for ordinary drift; transport jumps and first-frame
     positioning still seek immediately once decoding is ready. */
  /* Large ordinary lag can be caused by decoder startup starvation. Seeking
     each time that decoder briefly becomes ready cancels the recovery decode
     again. Wait for delivered-frame progress before a large-drift correction,
     and allow that correction to settle before another one. Operator cues and
     transport jumps still align immediately. */
  const hardSeek=initial||jump||drift>1&&stableFrames&&now-lastCorrectionAt>=2000;
  const correction=deliveryHealthy&&ready&&element.readyState>=3&&now-progressAt<=250&&!element.seeking&&drift>DRIFT&&!hardSeek
    ? clamp(error*.25,-.1,.1):0;
  const playbackRate=clamp(rate*(1+correction),.0625,16);
  if(Math.abs(element.playbackRate-playbackRate)>.005)
    try{element.playbackRate=playbackRate;}catch(error){}
  if(ready&&drift>DRIFT&&hardSeek){
    const before=s.seekCount;seekDecoder(s,key,target,DRIFT);
    if(s.seekCount>before)forwardState.lastCorrectionAt=now;
  }
}

function sync(layer, position, opts){
  const s = state.pool.get(layer); if(!s || !s.id) return;
  const m = s.media||state.byId.get(s.id); if(!m) return;
  opts = opts || {};
  s.lastDirection=opts.direction||'Forwards';
  s.lastScrub=!!opts.scrub;
  s.audioEnabled = opts.audioEnabled !== false;
  s.videoEnabled = opts.videoEnabled !== false;
  if(m.presentation?.player){
    gatePresentationAudio(m);
    if(s.videoEnabled===false)pauseBorrowedPresentation(s);
    else m.presentation.player.tick?.();
    return;
  }
  const v = s.video;
  const speed=opts.speed==null?1:Number(opts.speed);
  const rate=decoderPlaybackRate(v,speed,opts.transportDuration);
  const seeking = opts.direction === 'Backwards' || opts.direction === 'Paused' || opts.scrub || speed===0;
  const videoClosed = opts.videoEnabled === false;
  const direct=!!(window.OpenLiveDXV && OpenLiveDXV.isDirect && OpenLiveDXV.isDirect(v));

  if(direct && !videoClosed && OpenLiveDXV.sync) OpenLiveDXV.sync(v,position,opts);

  if(!direct && v.duration && isFinite(v.duration)){
    const want = clamp(position, 0, 1) * v.duration;
    const drift = Math.abs(v.currentTime - want);

    /* Backwards, Paused and scratching all have to be driven by seeking:
       HTMLMediaElement has no negative playbackRate. */
    if(videoClosed){
      delete s.forwardSync.video;
      if(!v.paused||s.videoPlayPending) v.pause();
      /* The engine owns the shared Clip position. Do not seek/decode a removed
         Video branch; reopening catches it up from that normalized playhead. */
    } else if(seeking){
      delete s.forwardSync.video;
      if(!v.paused||s.videoPlayPending) v.pause();
      if(drift > 1/60) seekDecoder(s,'video',want,1/60);
    } else {
      if(v.paused) playDecoder(s,'video');
      /* Seeking while play() is waiting for the first decoded frame can
         repeatedly postpone canplay on fresh sources. Let that initial decode
         complete, then catch up to the newest engine playhead once. */
      syncForwardDecoder(s,'video',want,rate,opts.fullSourceLoop===true);
    }
  }

  if(s.audio){
    updateAudioGraph(s, opts);
    const audible = effectiveAudioVolume(opts);
    if(audible <= 0.001 || seeking){ if(!s.audio.paused) s.audio.pause(); }
    else if(s.audio.paused) playDecoder(s,'audio');

    if(s.audio.duration && isFinite(s.audio.duration)){
      const aw = clamp(position, 0, 1) * s.audio.duration;
      const adrift = Math.abs(s.audio.currentTime - aw);
      if(seeking){
        delete s.forwardSync.audio;
        if(adrift > 1/60) seekDecoder(s,'audio',aw,1/60);
      } else {
        const audioRate=decoderPlaybackRate(s.audio,speed,opts.transportDuration);
        syncForwardDecoder(s,'audio',aw,audioRate,opts.fullSourceLoop===true);
      }
    }
  }
}

/* Observe a file Audio decoder without allocating a pool slot, audio graph or
   playback element. Muting or closing its output gate does not discard decoded
   readiness: operators can prepare an original audio file in silence. */
function audioState(layer, ref){
  const s=state.pool.get(layer),m=find(ref || (s&&(s.media||s.id)));
  if(!m)return {state:'absent',reason:'No media is registered for this source.'};
  const audioSource=m.audio || (m.hasAudio && m.video ? m.video : null);
  if(m.embeddedAudioUnavailable)return {state:'absent',reason:m.presentation?.embeddedAudioUnavailable||'Embedded presentation audio is not routed into the composition mixer.'};
  if(!audioSource && (m.hasAudio===false || m.mediaKind==='image' || m.presentation))
    return {state:'absent',reason:'This media has no Audio track.'};
  if(m.playable===false || m.prepareState==='error')
    return {state:'error',reason:m.unplayableReason||'This audio source could not be decoded.'};
  if(!audioSource){
    if(m.requiresPrepare && m.prepareState!=='ready')return {state:'loading',reason:
      m.prepareState==='preparing'?'Opening the original audio source.':'Audio is waiting to be prepared.'};
    return {state:'loading',reason:m.mediaKind==='audio'
      ?'Waiting for the original audio source.':'Audio track availability has not been determined.'};
  }
  let expectedUrl;try{expectedUrl=encodeURI(audioSource);}catch(_){
    return {state:'error',reason:'The original audio source has an invalid address.'};
  }
  if(!s || s.id!==m.id || !s.audio)
    return {state:'loading',reason:'The Audio decoder has not been prepared for this media.'};
  if(s.audioUrl!==expectedUrl)
    return {state:'loading',reason:'The Audio decoder is waiting for this original media source.'};
  const audio=s.audio;
  if(audio.error)return {state:'error',reason:audio.error.message||'The browser could not decode this audio source.'};
  if(audio.networkState===3)return {state:'error',reason:'The browser could not load this audio source.'};
  if(audio.seeking===true)return {state:'loading',reason:'Seeking the audio playback position.'};
  if(audio.readyState>=2)return {state:'frame',reason:null};
  return {state:'loading',reason:'Waiting for decoded audio data.'};
}

/* --------------------------------------------------------------------------
   Draw — decoded footage for programme and monitor projection
   Returns true only when it painted a decoded source frame. Posters belong to
   drawPoster()/poster() and must never leak into Composition, routed Preview,
   or any other programme surface as a low-resolution substitute for footage.
   False means no real frame is available; operator canvases may consult
   visualState() without inventing output pixels.
   -------------------------------------------------------------------------- */
function drawContained(ctx, source, w, h){
  const sw=+(source && (source.videoWidth||source.naturalWidth||source.width))||0;
  const sh=+(source && (source.videoHeight||source.naturalHeight||source.height))||0;
  if(!(sw>0 && sh>0)){ ctx.drawImage(source,0,0,w,h); return; }
  /* Media geometry is source data. Contain it without cropping or changing
     aspect; Clip/Layer Transform remains the explicit place to scale it. */
  const scale=Math.min(w/sw,h/sh), dw=sw*scale, dh=sh*scale;
  ctx.drawImage(source,(w-dw)/2,(h-dh)/2,dw,dh);
}
function draw(ctx, layer, w, h, ref){
  const s = state.pool.get(layer);
  if(s && s.videoEnabled === false) return false;
  const m=find(ref || (s&&(s.media||s.id)));
  const pdfFrame=m?.presentation?.player?.frame();
  if(pdfFrame){drawContained(ctx,pdfFrame,w,h);return true;}
  if(s && m && s.id===m.id && m.mediaKind==='image' && s.image &&
     s.image.complete && (s.image.naturalWidth||s.image.width)){
    drawContained(ctx,s.image,w,h);
    return true;
  }
  if(s && !s.failed){
    const direct=!!(window.OpenLiveDXV && OpenLiveDXV.isDirect && OpenLiveDXV.isDirect(s.video));
    const source=direct && OpenLiveDXV.drawable ? OpenLiveDXV.drawable(s.video) : s.video;
    if(direct && source){
      drawContained(ctx,source,w,h);
      return true;
    }
    if(s.video.readyState >= 2 && s.video.videoWidth){
    if(!source) return false;
    drawContained(ctx,source,w,h);
    return true;
    }
  }
  return false;
}
/* still frame, no pool involvement — the clip grid and the preview monitor */
/* Report why draw() can or cannot currently supply honest media pixels. The
   legacy boolean draw contract stays intact; newer callers can distinguish a
   decoder that is opening from a terminal failure or a genuinely absent Video
   track instead of treating all three as permission to invent artwork. */
/* Expose the current drawable and its native geometry to monitor projection.
   This is canvas/video/image identity, not a pixel readback. Preview can apply
   Fit/Fill/Stretch exactly once instead of baking letterbox bars first. */
function visualSource(layer, ref){
  const s=state.pool.get(layer);
  const m=find(ref || (s&&(s.media||s.id)));
  if(!m) return null;
  if(s?.videoEnabled===false)return null;
  const pdfFrame=m.presentation?.player?.frame();
  if(pdfFrame&&pdfFrame.width>0&&pdfFrame.height>0)return {source:pdfFrame,width:pdfFrame.width,height:pdfFrame.height};
  if(s&&s.id===m.id&&m.mediaKind==='image'&&s.image&&s.videoEnabled!==false&&
     !s.failed&&s.image.complete&&(s.image.naturalWidth||s.image.width)){
    const width=+(s.image.naturalWidth||s.image.width)||+m.width||0;
    const height=+(s.image.naturalHeight||s.image.height)||+m.height||0;
    if(width>0&&height>0) return {source:s.image,width,height};
  }
  if(s&&s.id===m.id&&!s.failed&&s.videoEnabled!==false){
    const dxv=window.OpenLiveDXV;
    const direct=!!(dxv&&dxv.isDirect&&dxv.isDirect(s.video));
    let source=null;
    if(direct&&dxv.drawable){ try { source=dxv.drawable(s.video); } catch(error){} }
    else if(s.video.readyState>=2&&s.video.videoWidth) source=s.video;
    if(source){
      const width=+(source.videoWidth||source.naturalWidth||source.width)||+m.width||0;
      const height=+(source.videoHeight||source.naturalHeight||source.height)||+m.height||0;
      if(width>0&&height>0) return {source,width,height};
    }
  }
  return null;
}
function visualState(layer, ref){
  const s=state.pool.get(layer);
  const m=find(ref || (s&&(s.media||s.id)));
  if(!m) return {state:'absent',reason:'No media is registered for this source.'};
  if(m.hasVideo===false || m.mediaKind==='audio')
    return {state:'absent',reason:'This media has no Video track.'};

  const owns=!!(s && s.id===m.id);
  if(owns && s.videoEnabled===false)
    return {state:'absent',reason:'This Clip\'s Video track is disabled.'};
  const pdfPlayer=m.presentation?.player;
  if(pdfPlayer){
    const value=pdfPlayer.state();
    const kind=pdfPlayer.kind==='powerpoint'?'PowerPoint':'PDF';
    if(value.disposed)return {state:'absent',reason:'This '+kind+' player was released.'};
    if(value.busy)return {state:'loading',reason:'Preparing the selected '+kind+' slide.'};
    if(value.error)return {state:'error',reason:value.error};
    return pdfPlayer.frame()?{state:'frame',reason:null}:{state:'loading',reason:'Preparing the '+kind+' player\'s first slide.'};
  }

  if(owns && !s.failed){
    if(m.mediaKind==='image' && s.image && s.image.complete &&
       (s.image.naturalWidth||s.image.width)) return {state:'frame',reason:null};
    const dxv=window.OpenLiveDXV;
    const direct=!!(dxv && dxv.isDirect && dxv.isDirect(s.video));
    let source=null;
    if(direct && dxv.drawable){
      try { source=dxv.drawable(s.video); } catch(error){}
      if(source) return {state:'frame',reason:null};
    } else if(s.video.readyState>=2 && s.video.videoWidth){
      return {state:'frame',reason:null};
    }
  }

  if(owns && s.failed)
    return {state:'error',reason:m.unplayableReason||'Media playback failed.'};
  if(m.playable===false || m.prepareState==='error')
    return {state:'error',reason:m.unplayableReason||'This media could not be decoded.'};

  const img=poster(m.id);
  if(img) return {state:'frame',reason:null};
  if(m.nativePosterError && !owns)
    return {state:'error',reason:'Poster unavailable: '+m.nativePosterError};
  if(m.requiresPrepare && m.prepareState!=='ready'){
    const preparing=m.prepareState==='preparing';
    return {state:'loading',reason:preparing
      ? 'Opening native media at source resolution.'
      : 'Native media is waiting to be opened.'};
  }
  if(m.nativeRecord || m.dxvRecord)
    return {state:'loading',reason:'Waiting for the native decoder\'s first frame.'};
  if(m.video)
    return {state:'loading',reason:'Waiting for the browser decoder\'s first frame.'};
  if(m.poster)
    return {state:'loading',reason:'Decoding the media poster.'};
  return {state:'absent',reason:'No visual source is available for this media.'};
}
function drawPoster(ctx, ref, w, h){
  const img = poster(ref);
  if(!img) return false;
  drawContained(ctx,img,w,h);
  return true;
}

const clamp = (v,a,b) => Math.max(a, Math.min(b, v));

/* --------------------------------------------------------------------------
   Browse — what the Files panel lists
   -------------------------------------------------------------------------- */
function folders(){ return state.index ? state.index.folders.slice() : []; }
function inFolder(f){ return state.index ? state.index.clips.filter(c => c.folder === f) : []; }
function all(){ return state.index ? state.index.clips.slice() : []; }

/* --------------------------------------------------------------------------
   Registration — media that did not come from the bundled mirror
   --------------------------------------------------------------------------
   arena-files.js walks folders the user picked off their own disk and hands the
   records here. They are the same shape as the mirror's, and every consumer
   below this line — find(), poster(), attach(), the Files panel — reads only
   `state.index` and the three lookup maps, so nothing downstream needs to know
   where a clip came from. `video` and `poster` are blob: URLs rather than
   relative paths, which is the only difference that reaches the DOM.

   The index may not have loaded yet (or may have failed entirely — a user with
   no bundled mirror is a legitimate state), so synthesise one rather than
   dropping the clips on the floor. */
function register(clips, folder){
  if(!clips || !clips.length) return 0;
  if(!state.index) state.index = { count: 0, folders: [], clips: [] };
  const idx = state.index;
  let added = 0;
  for(const c of clips){
    if(state.byId.has(c.id)) continue;             // re-scanning a root must not double it
    idx.clips.push(c);
    indexRecord(c);
    added++;
  }
  if(folder && !idx.folders.includes(folder)) idx.folders.push(folder);
  idx.count = idx.clips.length;
  state.ready = true;
  state.dirty++;                                   // repaint the grid and the browser
  return added;
}

/* Dropping a root revokes its blob: URLs — without this every rescan leaks the
   whole library, and a long session with a big folder is a real leak. */
function unregister(folder){
  if(!state.index) return 0;
  const idx = state.index;
  const gone = idx.clips.filter(c => c.folder === folder);
  if(!gone.length) return 0;
  for(const c of gone){
    if(c.presentation?.player){
      c._presentationUnsubscribe?.();c._presentationUnsubscribe=null;
      c.presentation.player.release();
    }
    for(const u of [c.video, c.poster, c.audio]){
      if(typeof u === 'string' && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch {} }
    }
    unindexRecord(c);
    state.posters.delete(c.id);
    /* A future record may reuse this id. The old task observes unregistration,
       detaches its temporary decoder, and revokes any blob produced after it
       became stale. */
    state.posterWork.delete(c.id);
  }
  idx.clips = idx.clips.filter(c => c.folder !== folder);
  idx.folders = idx.folders.filter(f => f !== folder);
  idx.count = idx.clips.length;
  /* Any layer still pointed at a clip that just went away must let go of it. */
  for(const [layer, s] of state.pool) if(s.id && !state.byId.has(s.id)) detach(layer);
  state.dirty++;
  return gone.length;
}
/* A poster that arrives after the grid has painted needs the same nudge the
   bundled ones get; arena-files.js calls this when a frame grab lands. */
function touch(){ state.dirty++; }

window.ArenaMedia = {
  load, find, all, folders, inFolder, preloadPosters,
  schedulePosterTask,
  register, unregister, touch,
  /* sync(..., opts) consumes per-slot `effects`, optional shared `group`, and a
     shared `composition`; every effect is {name,bypassed,drywet,params}. */
  hasAudioEffect,
  streamDestination,
  audioMixerSnapshot,
  audioEffects: AUDIO_EFFECTS.slice(),
  audioEffectSchemas: AUDIO_EFFECT_SCHEMAS,
  get dirty(){ return state.dirty; },
  poster, ensurePoster, drawPoster, draw, visualSource, visualState, audioState,
  attach, attachLive, attachInputMeter, detachInputMeter, detach, detachAll, sync, syncLive, slot,
  get ready(){ return state.ready; },
  get errors(){ return state.errors.slice(); },
  get count(){ return state.index ? state.index.count : 0; },
  get hasVideo(){ return !!(state.index && state.index.clips.some(c => c.video)); },
  _state: state
};
})();
