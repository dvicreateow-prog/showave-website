/* ===========================================================================
   openlive-studio.js — scenes, layouts and the compositor behind OpenLive
   Broadcast's Studio.

   THE ONE IDEA. A SCENE owns its LAYOUT. A layout is a list of rectangles in
   normalised canvas space; a scene binds a real local source to each. Switching
   scene therefore cuts a genuinely different look, which is the thing a scene is
   for — hold the layout globally instead and every scene shows the same
   arrangement with different content, which is not a scene at all.

   WHAT IS REAL HERE. Every source is a MediaStream or a media element this tab
   owns: a screen capture, a camera, a video or image file, an Advanced Output
   screen from the Arena clone, or an isolated browser-source frame supplied by
   openlive-widgets.js. The compositor draws them to a canvas and
   openlive-stream.js captures that canvas — so what the operator sees in the
   programme pane is the same pixels the encoder receives, not an approximation
   of them.

   Guest media supplied by openlive-guests.js enters as ordinary sources through
   openlive-guest-host.js; only host scene bindings put it on Programme. The
   local guest service also carries private studio chat, never a visual source.
   WHAT IS NOT HERE, AND WHY NOT. There is no audience chat: that
   needs each platform's live-chat API under OAuth. There are no automatic
   speech-to-text subtitles: that needs a trustworthy transcription engine.
   Operator-authored lower thirds and tickers are supplied by
   openlive-captions.js and share the persistent visual profile from
   openlive-theme.js. There is no virtual background: that needs a segmentation model.
   None of those ship as decorative controls — a slot that cannot be filled from
   this machine simply is not offered.

   Sources default to aspect-preserving Fit. Operators can explicitly choose
   Auto Size Off, Fill or Stretch for an individual scene placement.

   Classic script. Publishes window.OpenLiveStudio. No libraries.
   =========================================================================== */
window.OpenLiveStudio = (() => {
  'use strict';

  const STORE_BASE = 'openlive.studio.v1';
  const draftContext = window.OpenLiveStudioDraftContext || null;
  /* A malformed `?studio=` link must never fall back to the legacy show. The
     Broadcast shell covers that state with a fatal recovery dialog; this
     module stays memory-only until a valid context is opened. */
  const STORE = draftContext && draftContext.error ? ''
    : draftContext && typeof draftContext.key === 'function' ? draftContext.key(STORE_BASE)
    : STORE_BASE;

  /* ------------------------------------------------------------------------
     LAYOUTS — normalised rectangles, x/y = top-left, all 0..1 of the canvas.
       y:null  vertically centred
       h:null  derived from w and the SOURCE's own aspect, so a 4:3 camera in a
               16:9 rect is not silently stretched
     A layout is a LIST, so slot count is a property of the layout. A scene that
     binds more sources than its layout places does not silently drop them — the
     UI is told, and says so.
     ------------------------------------------------------------------------ */
  const panelRects = (columns, rows) => Array.from({length:columns * rows}, (_, i) => ({
    x:.02 + (i % columns) * .96 / columns, y:.02 + Math.floor(i / columns) * .96 / rows,
    w:.96 / columns - .012, h:.96 / rows - .012
  }));
  const LAYOUTS = {
    free: {label:'Free canvas',slots:0,'16x9':[],'9x16':[]},
    solo:    { label: 'Solo',    slots: 1,
      '16x9': [{ x: .00, y: .00, w: 1, h: 1 }],
      '9x16': [{ x: .00, y: .00, w: 1, h: 1 }] },
    split:   { label: 'Split',   slots: 2,
      '16x9': [{ x: .02, y: null, w: .47, h: null }, { x: .51, y: null, w: .47, h: null }],
      '9x16': [{ x: .02, y: .06,  w: .96, h: .44 },  { x: .02, y: .52,  w: .96, h: .42 }] },
    pip:     { label: 'PiP',     slots: 2,
      '16x9': [{ x: .00, y: .00, w: 1, h: 1 }, { x: .70, y: .66, w: .28, h: .31 }],
      '9x16': [{ x: .00, y: .00, w: 1, h: 1 }, { x: .58, y: .78, w: .40, h: .19 }] },
    speaker: { label: 'Speaker', slots: 2,
      '16x9': [{ x: .02, y: null, w: .66, h: null }, { x: .70, y: null, w: .28, h: null }],
      '9x16': [{ x: .02, y: .04,  w: .96, h: .60 },  { x: .02, y: .66,  w: .96, h: .30 }] },
    grid:    { label: 'Grid',    slots: 4,
      '16x9': [{ x: .01, y: .02, w: .48, h: .47 }, { x: .51, y: .02, w: .48, h: .47 },
               { x: .01, y: .51, w: .48, h: .47 }, { x: .51, y: .51, w: .48, h: .47 }],
      '9x16': [{ x: .02, y: .015, w: .96, h: .235 }, { x: .02, y: .255, w: .96, h: .235 },
               { x: .02, y: .505, w: .96, h: .235 }, { x: .02, y: .755, w: .96, h: .23 }] },
    thirds:  { label: 'Thirds',  slots: 3,
      '16x9': [{ x: .01, y: null, w: .32, h: null }, { x: .34, y: null, w: .32, h: null },
                { x: .67, y: null, w: .32, h: null }],
      '9x16': [{ x: .02, y: .02, w: .96, h: .30 }, { x: .02, y: .35, w: .96, h: .30 },
                { x: .02, y: .68, w: .96, h: .30 }] },
    stacked: { label:'Stacked', slots:2,
      '16x9':[{x:.02,y:.02,w:.96,h:.47},{x:.02,y:.51,w:.96,h:.47}],
      '9x16':[{x:.02,y:.02,w:.96,h:.47},{x:.02,y:.51,w:.96,h:.47}] },
    'pip-left': { label:'PiP left', slots:2,
      '16x9':[{x:0,y:0,w:1,h:1},{x:.02,y:.66,w:.28,h:.31}],
      '9x16':[{x:0,y:0,w:1,h:1},{x:.02,y:.78,w:.40,h:.19}] },
    'pip-top': { label:'PiP upper', slots:2,
      '16x9':[{x:0,y:0,w:1,h:1},{x:.70,y:.03,w:.28,h:.31}],
      '9x16':[{x:0,y:0,w:1,h:1},{x:.58,y:.03,w:.40,h:.19}] },
    'speaker-right': { label:'Speaker right', slots:2,
      '16x9':[{x:.32,y:null,w:.66,h:null},{x:.02,y:null,w:.28,h:null}],
      '9x16':[{x:.02,y:.36,w:.96,h:.60},{x:.02,y:.04,w:.96,h:.30}] },
    'focus-three': { label:'Focus + two', slots:3,
      '16x9':[{x:.02,y:.02,w:.64,h:.96},{x:.68,y:.02,w:.30,h:.47},{x:.68,y:.51,w:.30,h:.47}],
      '9x16':[{x:.02,y:.02,w:.96,h:.64},{x:.02,y:.68,w:.47,h:.30},{x:.51,y:.68,w:.47,h:.30}] },
    'panel-six': { label:'Six-person', slots:6, '16x9':panelRects(3,2), '9x16':panelRects(2,3) },
    'grid-nine': { label:'Nine-person', slots:9, '16x9':panelRects(3,3), '9x16':panelRects(3,3) },
    'grid-twelve': { label:'Twelve-person', slots:12, '16x9':panelRects(4,3), '9x16':panelRects(3,4) },
    /* SHOWAVE production presets: explicit source bounds leave the bottom 22%
       clear for lower thirds/tickers. The ordinary contain-fit renderer keeps
       the complete source visible even when its aspect differs from the slot.
       These do not turn on captions or graphics; the ordinary slot-count and
       released-binding rules apply when selecting a different layout. */
    'interview-safe': { label: 'Interview + captions', slots: 2,
      '16x9': [{ x: .03, y: .08, w: .455, h: .68 }, { x: .515, y: .08, w: .455, h: .68 }],
      '9x16': [{ x: .05, y: .04, w: .90, h: .34 }, { x: .05, y: .40, w: .90, h: .34 }] },
    'presentation-safe': { label: 'Presentation + captions', slots: 2,
      '16x9': [{ x: .27, y: .10, w: .70, h: .68 }, { x: .03, y: .10, w: .21, h: .68 }],
      '9x16': [{ x: .04, y: .04, w: .92, h: .46 }, { x: .30, y: .53, w: .40, h: .23 }] },
    'showcase-safe': { label: 'Showcase + captions', slots: 2,
      '16x9': [{ x: .04, y: .04, w: .59, h: .70 }, { x: .67, y: .17, w: .29, h: .50 }],
      '9x16': [{ x: .04, y: .04, w: .92, h: .44 }, { x: .54, y: .52, w: .42, h: .24 }] },
    'panel-six-safe': { label: 'Six-person panel + captions', slots: 6,
      '16x9': [{ x: .03, y: .06, w: .30, h: .30 }, { x: .35, y: .06, w: .30, h: .30 },
               { x: .67, y: .06, w: .30, h: .30 }, { x: .03, y: .42, w: .30, h: .30 },
               { x: .35, y: .42, w: .30, h: .30 }, { x: .67, y: .42, w: .30, h: .30 }],
      '9x16': [{ x: .04, y: .04, w: .44, h: .225 }, { x: .52, y: .04, w: .44, h: .225 },
               { x: .04, y: .285, w: .44, h: .225 }, { x: .52, y: .285, w: .44, h: .225 },
               { x: .04, y: .53, w: .44, h: .225 }, { x: .52, y: .53, w: .44, h: .225 }] }
  };
  /* Every shipped layout has both rasters. The fallback protects imported
     future layout ids; it is no longer the normal portrait path. */
  const rects = (key, aspect) => {
    const L = LAYOUTS[key] || LAYOUTS.solo;
    return L[aspect] || L['16x9'];
  };

  const ASPECTS = { '16x9': { w: 1920, h: 1080 }, '9x16': { w: 1080, h: 1920 } };

  /* A full native-art template and its source frames are a scene-owned choice,
     not a Graphics/Theme/Captions transaction. The board is contain-mapped as a
     unit so portrait sources cannot drift away from the landscape artwork. */
  const fullTemplateRenderErrors = new Map();
  function validFullTemplate(record) {
    return !!(record && /^svg-[1-9][0-9]*$/.test(String(record.id || '')) &&
      Number.isFinite(record.width) && record.width > 0 && Number.isFinite(record.height) && record.height > 0 &&
      Array.isArray(record.frames) && record.frames.length <= 12 && record.frames.every(validFullFrame));
  }
  function validFullFrame(frame) {
    return !!(frame && ['x','y','w','h'].every(key => Number.isFinite(frame[key])) &&
      frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0 &&
      frame.x + frame.w <= 1 + 1e-9 && frame.y + frame.h <= 1 + 1e-9 &&
      (frame.radius == null || Number.isFinite(frame.radius) && frame.radius >= 0 && frame.radius <= 1));
  }
  function fullTemplateFrames(id, cv,style) {
    const module = window.OpenLiveFullTemplates;
    const record = module && typeof module.get === 'function' && module.get(id);
    if (!validFullTemplate(record) || typeof module.frameRects !== 'function')
      throw new Error('The selected full template has no valid source-frame geometry.');
    const frames = module.frameRects(id, cv,style);
    const validOutput = frame => style && style.components
      ? frame && ['x','y','w','h'].every(key => Number.isFinite(frame[key])) && frame.w > 0 && frame.h > 0 && frame.w <= 8 && frame.h <= 8 &&
        (frame.radius == null || Number.isFinite(frame.radius) && frame.radius >= 0) &&
        (frame.opacity == null || Number.isFinite(frame.opacity) && frame.opacity >= 0 && frame.opacity <= 1)
      : validFullFrame(frame);
    if (!Array.isArray(frames) || frames.length !== record.frames.length || !frames.every(validOutput))
      throw new Error('The selected full template has invalid output-frame geometry.');
    return frames.map(frame => ({ ...frame }));
  }
  function registerFullTemplateLayouts() {
    const module = window.OpenLiveFullTemplates;
    if (!module || typeof module.list !== 'function') return;
    for (const record of module.list()) {
      if (!validFullTemplate(record)) continue;
      try {
        LAYOUTS[record.id] = { label:String(record.name || record.id) + ' layout', slots:record.frames.length,
          '16x9':fullTemplateFrames(record.id, {width:1920,height:1080}),
          '9x16':fullTemplateFrames(record.id, {width:1080,height:1920}) };
      } catch (_) { /* Invalid catalogue geometry cannot become a source layout. */ }
    }
  }
  function fullTemplateStyle(id, style) {
    const module = window.OpenLiveFullTemplates;
    return module && typeof module.normalizeStyle === 'function'
      ? {...module.normalizeStyle(id,style === undefined ? {} : style)} : {};
  }
  function fullTemplateKey(id, style) {
    const module = window.OpenLiveFullTemplates;
    if (module && typeof module.key === 'function') return module.key(id,style);
    return id + ':' + JSON.stringify(Object.keys(style || {}).sort().map(key => [key,style[key]]));
  }
  function fullTemplateStatus(scene, prepare = false) {
    if (!scene || !scene.fullTemplateId) return null;
    const id = scene.fullTemplateId, module = window.OpenLiveFullTemplates;
    try {
      if (!module || typeof module.get !== 'function' || !validFullTemplate(module.get(id)) ||
          !LAYOUTS[id] || typeof module.status !== 'function' || typeof module.draw !== 'function')
        return {state:'failed',error:'The selected full template is unavailable. Choose another template or remove its artwork.'};
      const style = fullTemplateStyle(id,scene.fullTemplateStyle), key = fullTemplateKey(id,style);
      const status = module.status(id,style) || {state:'idle'};
      if (status.state === 'idle' && prepare && typeof module.load === 'function') {
        try { const pending = module.load(id,{style}); if (pending && pending.catch) pending.catch(() => {}); } catch (_) {}
      }
      if (status.state === 'ready' && fullTemplateRenderErrors.has(key))
        return {state:'failed',error:fullTemplateRenderErrors.get(key)};
      return status;
    } catch (_) { return {state:'failed',error:'The selected full template could not be prepared.'}; }
  }
  registerFullTemplateLayouts();

  /* ---- sources ----------------------------------------------------------- */
  const sources = new Map();
  // captureStream may replace its tracks at a file loop boundary. Remember
  // only observed audio, scoped to this runtime stream rather than a filename
  // or saved source definition, so its controls need not blink between loops.
  const audioStreamsWithEvidence = new WeakSet();
  let sourceSeq = 0;

  // Persist source descriptions, never browser handles. A restored capture is
  // a disconnected reusable source until the operator prepares it again.
  const sourceKinds = Object.freeze({camera:'camera',screen:'screen',window:'screen',live:'showave',image:'image',media:'video',
    color:'color',text:'text',present:'presentation',slideshow:'slideshow',browser:'browser',ndi:'ndi','audio-input':'audio','audio-output':'audio',
    'lower-third':'text',ticker:'text',countdown:'text',qr:'text','product-card':'text',generator:'generator',sports:'text',audience:'text'});
  const sourceConfigKeys = Object.freeze({camera:['device','resolution','fps','audio'],screen:['audio','fps'],window:['audio','fps'],live:['input'],
    image:['fileName'],media:['fileName','loop','trimIn','trimOut','rate','replay','direction','mode','loopTransition','loopTransitionMs'],color:['color'],text:['text','color','size','fontFamily'],slideshow:['fileNames','seconds','loop'],
    present:['mode','fileName','audio'],browser:['url','width','height'],ndi:['device','audioDevice','resolution','fps'],
    'audio-input':['device','echoCancellation','noiseSuppression','autoGainControl'],'audio-output':[],
    'lower-third':['templateId','line1','line2','color','background','accent','size','overflow','overflowSpeed'],ticker:['templateId','text','color','background','size','speed','overflow','overflowSpeed'],
    countdown:['duration','color','background','size'],qr:['templateId','url','label','foreground','background','overflow','overflowSpeed'],
    'product-card':['title','price','description','url','foreground','background','accent']});
  function savedSourceConfig(type,raw={}) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved source properties.');
    if(type==='generator')return effectsModule().normalizeGenerator(raw);
    if(type==='sports')return window.OpenLiveSportsSources.normalize(raw);
    if(type==='audience')return window.OpenLiveAudience.normalize(raw);
    const allowed=sourceConfigKeys[type];if(!allowed)throw Error('Unknown saved source type.');
    const config={};
    for(const key of allowed){const value=raw[key];if(value===undefined)continue;
      if(key==='trimOut'&&value===null){config[key]=null;continue;}
      if(key==='trimIn'||key==='trimOut'){const seconds=Number(value);if(!Number.isFinite(seconds)||seconds<0)throw Error('Invalid saved trim point.');config[key]=seconds;continue;}
      if(key==='rate'){const rate=Number(value);if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(rate)||rate<.25||rate>2)throw Error('Playback speed must be between 0.25 and 2.');config[key]=rate;continue;}
      if(key==='direction'||key==='mode'||key==='loopTransition'){
        const choices=key==='direction'?['forward','reverse']:key==='mode'?(type==='present'?['pdf','powerpoint','powerpoint-live']:['loop','pingpong','hold','clear']):['cut','dissolve'];
        if(!choices.includes(value))throw Error('Invalid saved media playback option.');config[key]=value;continue;
      }
      if(key==='loopTransitionMs'){
        const ms=Number(value);if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(ms)||ms<0||ms>2000)throw Error('Loop transition must be between 0 and 2000 ms.');config[key]=ms;continue;
      }
      if(key==='fileNames'){
        if(!Array.isArray(value)||value.length>32||value.some(name=>typeof name!=='string'||name.length>1024||/[\u0000-\u001f]/.test(name)))throw Error('Invalid saved slide show.');
        config[key]=value.slice();continue;
      }
      if(['audio','loop','replay','echoCancellation','noiseSuppression','autoGainControl'].includes(key)){
        if(typeof value!=='boolean')throw Error('Invalid saved source option.');config[key]=value;continue;
      }
      if(['size','seconds','width','height','fps','duration','speed','overflowSpeed'].includes(key)){
        const number=Number(value);if(!Number.isFinite(number)||key==='overflowSpeed'&&(number<1||number>600))throw Error('Invalid saved source number.');config[key]=number;continue;
      }
      if(key==='overflow'){if(!['scroll','clip'].includes(value))throw Error('Invalid saved text overflow mode.');config[key]=value;continue;}
      if(typeof value!=='string'||value.length>(key==='url'?4096:2048)||(['text','description'].includes(key)?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/:/[\u0000-\u001f]/).test(value))throw Error('Invalid saved source text.');config[key]=value;
    }
    return config;
  }
  function sourceDefinition(source) {
    if(!Object.hasOwn(sourceKinds,source?.sourceType))return null;
    if(typeof source.id!=='string'||!/^src[1-9]\d{0,8}$/.test(source.id)||typeof source.label!=='string'||
       !source.label.trim()||source.label.length>120||/[\u0000-\u001f]/.test(source.label))throw Error('Invalid saved source.');
    return {id:source.id,sourceType:source.sourceType,kind:sourceKinds[source.sourceType],label:source.label,
      audioOnly:source.audioOnly===true||['audio-input','audio-output'].includes(source.sourceType),config:savedSourceConfig(source.sourceType,source.config||{})};
  }
  function restoreSourceDefinitions(definitions) {
    for(const raw of Array.isArray(definitions)?definitions:[]){
      try{const spec=sourceDefinition(raw);if(!spec||sources.has(spec.id))continue;
        sources.set(spec.id,{...spec,el:null,stream:null,disconnected:true,
          audio:{included:false,reason:'Reconnect this source to receive audio.'}});
        sourceSeq=Math.max(sourceSeq,Number(spec.id.slice(3)));
      }catch(_){} // One damaged description cannot discard the operator's scene.
    }
  }
  function restoreSourceRuntimes() {
    const provider=window.OpenLiveSourceAcquisition;
    let restored=0;
    for(const source of sources.values())if(source.disconnected&&source.sourceType==='generator'){
      try{Object.assign(source,effectsModule().createGeneratorSource(source.config),{id:source.id,label:source.label,disconnected:false});restored++;}
      catch(error){source.reconnectReason=error.message;}
    }
    if(typeof provider?.restoreGenerated!=='function')return restored;
    for(const source of sources.values())if(source.disconnected&&(['color','text'].includes(source.sourceType)||window.OpenLiveCreativeSources?.isCreative(source.sourceType))){
      try{
        if(['color','text'].includes(source.sourceType)&&(typeof source.config.color!=='string'||source.sourceType==='text'&&
           (typeof source.config.text!=='string'||!Number.isFinite(source.config.size)))
           )
          throw Error('This older source has no saved appearance settings');
        const runtime=provider.restoreGenerated(source.sourceType,source.config);
        if(runtime?.then)throw Error('Generated source restoration must be synchronous.');
        const health=sourceStatus(runtime),pending=health.state==='loading'&&typeof runtime.prepare==='function';
        if(!runtime?.el||!health.ok&&!pending){runtime?.dispose?.();throw Error('The saved source could not be rendered.');}
        Object.assign(source,runtime,{id:source.id,label:source.label,config:runtime.config||source.config,disconnected:false});restored++;
        runtime.prepare?.().catch(()=>{});
      }catch(error){source.reconnectReason='Could not restore '+source.label+': '+(error.message||String(error))+'. Open Properties to prepare it again.';}
    }
    return restored;
  }

  function addSource(spec) {
    const id = 'src' + (++sourceSeq);
    const s = Object.assign({
      id, kind: 'screen', label: 'Source', el: null, stream: null,
      width: 0, height: 0, mirror: false,
      audio: { included: false, reason: 'Not checked.' }
    }, spec || {});
    if (s.stream) {
      const a = s.stream.getAudioTracks();
      if (a.length) audioStreamsWithEvidence.add(s.stream);
      s.audio = a.length
        ? { included: true, reason: 'From the captured source.' }
        : { included: false, reason: 'This source offers no audio track.' };
    }
    sources.set(id, s);
    if (s.stream && typeof s.stream.addEventListener === 'function') {
      const refresh = () => {
        if (!sources.has(id)) return;
        syncMix();
        if (typeof s.onAudioChange === 'function') s.onAudioChange(s);
      };
      s.stream.addEventListener('addtrack', refresh);
      s.stream.addEventListener('removetrack', refresh);
      s._detachAudioEvents = () => {
        s.stream.removeEventListener('addtrack', refresh);
        s.stream.removeEventListener('removetrack', refresh);
      };
    }
    attachMediaTransition(s);
    return s;
  }
  /* Capture the file element's real tracks, not a second independent player.
     Element mute only disables speaker monitoring; captured audio is unaffected
     (Media Capture from DOM Elements). The ordinary Studio gain/mute graph owns
     what reaches Programme. Browsers without this API stay honestly video-only. */
  function addMediaSource(spec) {
    const options = Object.assign({}, spec || {});
    const media = options.el;
    if(media&&!options.transport&&window.OpenLiveSourceAcquisition?.mediaTransport){
      options.sourceType=options.sourceType||'media';
      options.config=options.config||{fileName:options.label||'Media',loop:media.loop!==false,trimIn:0,trimOut:null};
      options.transport=window.OpenLiveSourceAcquisition.mediaTransport(media,options.config);
      const release=options.dispose;
      options.dispose=()=>{options.transport.dispose();if(release)release();else media.pause();};
    }
    let reason = 'This media file has no audio track.';
    if (options.config?.replay===true) {
      // Element mute controls monitoring, not captureStream audio. Replay
      // sources contribute picture only on both Preview and Programme.
      if(media)media.muted=true;
      options.stream=null;
      reason='Replay clips are video-only; audio is muted.';
    } else if (media) {
      media.muted = true;
      const capture = media.captureStream || media.mozCaptureStream;
      if (options.stream) {
        reason = options.stream.getAudioTracks?.().length ? 'From the prepared media file.' : reason;
      } else if (typeof capture === 'function') {
        try { options.stream = capture.call(media); }
        catch (error) { reason = 'Media audio capture failed: ' + (error.message || String(error)); }
      } else reason = 'This browser cannot capture media-file audio. Use a browser with media capture support.';
    }
    options.audio = { included:false, reason };
    const source = addSource(options);
    if (!source.stream || !source.stream.getAudioTracks().length) source.audio = { included:false, reason };
    source._mediaAudio = true;
    return source;
  }
  function removeSource(id) {
    const s = sources.get(id);
    if (!s) return false;
    try { if (s._detachAudioEvents) s._detachAudioEvents(); } catch (_) {}
    try { if (s.stream&&!s._managedStreamLifetime) s.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    if (s._mediaAudio && s.el) { try { s.el.pause(); } catch (_) {} }
    try { if (typeof s.dispose === 'function') s.dispose(); } catch (_) {}
    sources.delete(id);
    /* Unbind it everywhere rather than leaving scenes pointing at a corpse. */
    doc.scenes.forEach(sc => sc.slots.forEach(sl => { if (sl.sourceId === id) sl.sourceId = null; }));
    save(); syncMix();
    return true;
  }
  function sourceUsage(id) {
    const references=value=>{
      const pending=[value],seen=new WeakSet();
      while(pending.length){const next=pending.pop();if(!next||typeof next!=='object'||seen.has(next))continue;seen.add(next);
        for(const [key,item] of Object.entries(next)){
          if(key==='sourceId'&&item===id)return true;
          if(!key.startsWith('_')&&item&&typeof item==='object')pending.push(item);
        }
      }
      return false;
    };
    const sceneIds=doc.scenes.filter(references).map(scene=>scene.id),programme=references(doc.programmeSnapshot),
      fading=references(transition),history=references([...svgPartHistories.values(),...creativeHistories.values(),...sceneContentHistories.values(),doc.sceneArrangementHistories]);
    return {inUse:!!(sceneIds.length||programme||fading||history),sceneIds,programme,transition:fading,history};
  }
  const sourceInUse=id=>sourceUsage(id).inUse;
  // Reusable sources can outlive their last placement. Release them explicitly
  // only after every Programme, scene, transition and undo reference is gone.
  function removeUnusedSource(id) {
    const source=sources.get(id);if(!source)return false;
    if(sourceInUse(id))throw Error('This source is still used by a scene, Programme, transition or undo history.');
    const previous=[...sources];sources.delete(id);
    if(!save()){sources.clear();for(const [key,value] of previous)sources.set(key,value);
      throw Error('The unused source could not be removed from saved settings. Its resources are still running.');}
    try{source._detachAudioEvents?.();}catch(_){}
    try{source.dispose?.();}catch(_){}
    // Provider disposal owns its captures; media-element audio captured by the
    // Studio may be separate. Stop only tracks still live after disposal.
    try{if(!source._managedStreamLifetime)source.stream?.getTracks().forEach(track=>{if(track.readyState!=='ended')track.stop();});}catch(_){}
    if(!source.dispose&&source._mediaAudio)try{source.el?.pause?.();}catch(_){}
    syncMix();return true;
  }
  /* Real dimensions, or zero. A <video> reports 0 until metadata lands, which is
     the honest "not yet" rather than a guessed 1920x1080. */
  function sizeOf(s) {
    if (!s || !s.el) return { w: 0, h: 0 };
    /* Three element kinds, three different accessors, and a canvas has NEITHER
       of the first two — it reports its size on .width/.height. Reading only
       videoWidth/naturalWidth gave a canvas source 0x0, so fit() bailed and it
       silently never drew. */
    const video = 'videoWidth' in s.el, image = 'naturalWidth' in s.el;
    const w = video ? s.el.videoWidth : image ? s.el.naturalWidth : s.el.width;
    const h = video ? s.el.videoHeight : image ? s.el.naturalHeight : s.el.height;
    if(video&&!(w>0&&h>0)){
      const record=mediaTransitions.get(s),held=reverseHeldPicture(s)||loopHeldPicture(s);
      const measured=held&&(record?.decodedSize||record?.outgoingSize);
      if(measured)return {w:measured.w,h:measured.h};
    }
    return { w:w || 0, h:h || 0 };
  }

  /* UNDOCUMENTED — browser readiness is inferred from decoded dimensions and
     track state, not registration or a CSS width. A deliberately disabled live
     track is black by intent; an ended/muted capture is not a fresh picture. */
  function sourceStatus(source) {
    const s = typeof source === 'string' ? sources.get(source) : source;
    if(sourceCleared(s))return {ok:false,state:'cleared',why:'Playback finished and ejected this source. Play it again to restore its picture and audio.'};
    if(s?.disconnected)return {ok:false,state:'disconnected',why:s.reconnectReason||
      'Reconnect “'+s.label+'” using Properties. Saved settings are kept; local files and captures need to be prepared again.'};
    if(typeof s?.runtimeStatus==='function'){
      try { const health=s.runtimeStatus();if(!health.ok)return health; }
      catch(error){return {ok:false,state:'failed',why:error.message||'The source provider failed.'};}
    }
    if (s?.audioOnly) {
      const tracks=s.stream?.getAudioTracks?.()||[];
      if(s.stream?.active===false||!tracks.some(t=>t.readyState==='live'))return {ok:false,state:'ended',why:'The audio input has ended. Reconnect the device.'};
      return {ok:true,state:'ready',audioOnly:true};
    }
    if (!s || !s.el) return { ok:false, state:'missing', why:'The source has no drawable element.' };
    const el = s.el, size = sizeOf(s);
    const heldMedia=s.sourceType==='media'&&el.ended===true;
    const tracks = s.stream && typeof s.stream.getVideoTracks === 'function'
      ? s.stream.getVideoTracks() : [];
    if (!heldMedia&&((tracks.length && !tracks.some(track => track.readyState === 'live')) ||
        (s.stream && 'videoWidth' in el && !s._mediaAudio && !tracks.length) ||
        // Original presentation pictures use a stable canvas. Their optional
        // embedded-audio stream can be empty on a silent slide without ending
        // that still-valid picture. Live capture video tracks remain checked.
        (s.stream && s.stream.active === false && !s._mediaAudio && s.sourceType!=='present') || el.ended === true))
      return { ok:false, state:'ended', why:'The source has ended. Choose or restart a source.' };
    if (el.error) {const record=mediaTransitions.get(s);resetMediaTransition(record);resetDecodedPicture(record);
      return { ok:false, state:'error', why:'The source could not be decoded.' };}
    if('videoWidth' in el&&!nativePictureReady(s)&&loopHeldPicture(s))
      return {ok:true,state:'held',warning:'Loop playback is seeking; retaining the outgoing decoded frame.'};
    if('videoWidth' in el&&Number(el.readyState)<2&&reverseHeldPicture(s))
      return {ok:true,state:'held',warning:'Reverse playback is seeking; retaining the last decoded frame.'};
    if (!(size.w > 0 && size.h > 0) || !Number.isFinite(size.w) || !Number.isFinite(size.h) ||
        ('videoWidth' in el && Number(el.readyState) < 2) ||
        ('naturalWidth' in el && el.complete === false))
      return { ok:false, state:'loading', why:'Waiting for a decoded source frame.' };
    if(heldMedia)return {ok:true,state:'held',warning:'Playback finished. Holding the final decoded frame.'};
    const live = tracks.filter(track => track.readyState === 'live');
    if (live.length && live.every(track => track.enabled === false))
      return { ok:true, state:'disabled', warning:'A visible video source is intentionally disabled; its Programme picture is black.' };
    if (live.length && !live.some(track => track.enabled !== false && track.muted !== true))
      return { ok:false, state:'waiting', why:'The video capture is temporarily not providing frames.' };
    return { ok:true, state:'ready' };
  }

  /* ---- document ---------------------------------------------------------- */
  const uid = p => p + Math.random().toString(36).slice(2, 8);
  const clamp = (value, low, high, fallback) => {
    const n = Number(value);
    return Math.max(low, Math.min(high, Number.isFinite(n) ? n : fallback));
  };
  function normalizeWidgetLayer(value) {
    if (!value || typeof value !== 'object' || !String(value.assetId || '').trim()) return null;
    const w = clamp(value.w, .04, 1, 1);
    const h = clamp(value.h, .04, 1, 1);
    return {
      id: String(value.id || uid('wl')).slice(0, 128),
      assetId: String(value.assetId).slice(0, 128),
      x: clamp(value.x, 0, 1 - w, 0), y: clamp(value.y, 0, 1 - h, 0),
      w, h, opacity: clamp(value.opacity, 0, 1, 1), visible: value.visible !== false
    };
  }
  function blankScene(name, layout) {
    const key = layout || 'solo';
    return {
      id: uid('s'), name: name || 'Scene', layout: key,
      slots: Array.from({ length: (LAYOUTS[key] || LAYOUTS.solo).slots },
                        () => ({ sourceId: null, mute: false, hidden: false, gain: 1 })),
      widgets: [],
      overlays: { logo: { on: false, dataUrl: null, corner: 'tr' },
                  lower: { on: false, line1: '', line2: '' },
                  countdown: { on: false, endsAt: null } }
    };
  }
  let doc = { version: 2, scenes: [], activeId: null, defaultSceneId: null, title: '' };
  let previewWorkflow = false, takingPreview = false, programmePreparation = null;
  const PROGRAMME_PREPARE_MS = 12000;
  function transitionState() {
    if(programmePreparation&&!programmePreparation.signal.aborted)return {state:'preparing',manual:programmePreparation.manual,progress:0};
    if(!transition)return {state:'idle',manual:false,progress:0};
    return {state:transition.manual?'manual':'fade',manual:!!transition.manual,progress:transition.manual?transition.progress:
      Math.max(0,Math.min(1,(performance.now()-transition.startedAt)/transition.duration)),fromId:transition.fromId,toId:transition.toId};
  }
  function notifyTransition(){if(typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent('showave:studio-transition',{detail:transitionState()}));}
  function createProgrammePreparation(options,manual){
    if(options.signal?.aborted)throw options.signal.reason||new Error('Transition cancelled. Programme is unchanged.');
    const controller=new AbortController(),signal=controller.signal;
    let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
    // Always consume cancellation, including a cancellation between awaits.
    aborted.catch(()=>{});
    const reason=()=>signal.reason||new Error('Transition cancelled. Programme is unchanged.');
    signal.addEventListener('abort',()=>rejectAbort(reason()),{once:true});
    const externalAbort=()=>controller.abort(options.signal.reason||new Error('Transition cancelled. Programme is unchanged.'));
    options.signal?.addEventListener('abort',externalAbort,{once:true});
    const timeoutMs=Math.max(50,Math.min(30000,Number(options.timeoutMs)||PROGRAMME_PREPARE_MS));
    const timer=setTimeout(()=>controller.abort(new Error('Preparing Preview timed out. Programme is unchanged; retry or choose another source.')),timeoutMs);
    const request={signal,manual,abort:message=>controller.abort(message||new Error('Transition cancelled. Programme is unchanged.')),
      check(){if(signal.aborted||programmePreparation!==request)throw reason();},
      wait(value,disposeLate){
        // The operation is already started when passed here. Always observe it
        // so a synchronous cancellation still disposes a late owned runtime.
        return Promise.race([Promise.resolve(value).then(result=>{
          if(signal.aborted||programmePreparation!==request){disposeLate?.(result);throw reason();}
          return result;
        }),aborted]);
      },
      finish(){clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort);
        if(programmePreparation===request){programmePreparation=null;takingPreview=false;notifyTransition();}}
    };
    programmePreparation=request;takingPreview=true;notifyTransition();return request;
  }
  function restoreDefaultScene() {
    // The starter scene has a stable identity, separate from Programme and
    // from the shared template catalogue. Never recreate or replace its layers.
    const existing=doc.scenes.find(scene=>scene.id===doc.defaultSceneId);
    const starter=existing||doc.scenes[0];
    doc.defaultSceneId=starter.id;
    if(!existing&&starter.name==='Scene 1')starter.name='Default';
    if(!doc.scenes.some(scene=>scene.id===doc.activeId))doc.activeId=starter.id;
  }

  function load() {
    try {
      if (!STORE) throw new Error('The Studio draft context is invalid.');
      const j = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (j && Array.isArray(j.scenes) && j.scenes.length) {
        doc = j;
        doc.version = 2;
        restoreDefaultScene();
        restoreSourceDefinitions(doc.sourceDefinitions);
        // Typed source descriptions retain their bindings. Legacy captures have
        // no saved description and still start unbound after reload.
        [...doc.scenes, ...(doc.programmeSnapshot ? [doc.programmeSnapshot] : [])].forEach(sc => {
          if (!Array.isArray(sc.slots)) sc.slots = [];
          // Retain a missing art id for honest preflight recovery, but keep the
          // ordinary layout picker usable when its optional catalogue is absent.
          if (sc.fullTemplateId && !LAYOUTS[sc.layout]) sc.layout = 'solo';
          // Legacy complete-template scenes also begin with the supplied art
          // alone. Extra layers remain saved and can be explicitly included.
          if (sc.fullTemplateId) sc.fullTemplateExtras = sc.fullTemplateExtras === true;
          const wanted = (LAYOUTS[sc.layout] || LAYOUTS.solo).slots;
          while (sc.slots.length < wanted) {
            sc.slots.push({ sourceId: null, mute: false, hidden: false, gain: 1 });
          }
          sc.widgets = (Array.isArray(sc.widgets) ? sc.widgets : [])
            .map(normalizeWidgetLayer).filter(Boolean).slice(0, 5);
          sc.slots.forEach(sl => {
          if(!sources.has(sl.sourceId))sl.sourceId = null;
          if (!Number.isFinite(sl.gain)) sl.gain = 1;
          });
        });
        return;
      }
    } catch (e) {}
    doc = { version: 2, scenes: [blankScene('Default', 'solo')], activeId: null, defaultSceneId: null, title: '' };
    restoreDefaultScene();
  }
  function save() {
    /* Runtime image objects (legacy logo._img, decoded browser frames, etc.)
       must never be serialized into the show document. */
    if (!STORE) return false;
    try {
      const sourceDefinitions=[...sources.values()].map(sourceDefinition).filter(Boolean);
      localStorage.setItem(STORE, JSON.stringify({...doc,sourceDefinitions},
        (key, value) => key && key[0] === '_' ? undefined : value));
      doc.sourceDefinitions=sourceDefinitions;
      return true;
    } catch (e) { return false; }
  }

  const scenes = () => doc.scenes;
  const defaultScene = () => doc.scenes.find(s => s.id === doc.defaultSceneId) || doc.scenes[0] || null;
  const active = () => previewWorkflow && doc.programmeSnapshot || doc.scenes.find(s => s.id === doc.activeId) || defaultScene();
  function setActive(id) { if (!previewWorkflow && doc.scenes.some(s => s.id === id)) { doc.activeId = id; save(); } }

  // Media has private clocks on each bus; capture devices remain shared live feeds.
  let programmeMediaSequence=0;
  const isFileMedia=source=>!!source&&(source.sourceType==='media'||source._mediaAudio===true)&&!source.el?.srcObject;
  const mediaTransitions=new WeakMap(),MAX_LOOP_FRAME_EDGE=1920,MAX_LOOP_FRAME_PIXELS=1920*1080,MAX_LOOP_DECODE_MS=2000;
  function sourceCleared(source){try{return source?.transport?.details?.().cleared===true;}catch(_){return false;}}
  function mediaPlaying(source){try{const state=source?.transport?.details?.();return state?.playing===true&&!state.cleared;}catch(_){return false;}}
  function nativePictureReady(source){return !!source?.el&&!source.el.error&&(!('videoWidth' in source.el)||Number(source.el.readyState)>=2&&source.el.seeking!==true);}
  function reversePlaying(source){try{const state=source?.transport?.details?.();return state?.direction==='reverse'&&state.playing===true&&!state.cleared;}catch(_){return false;}}
  function reverseHeldPicture(source){const record=source&&mediaTransitions.get(source);return reversePlaying(source)&&record?.decoded||null;}
  function loopHeldPicture(source,timeMs=performance.now()){
    const record=source&&mediaTransitions.get(source);
    if(!record?.outgoing||record.created===null)return null;
    if(record.disposed||source.el?.error||!mediaPlaying(source)||timeMs-record.created>=MAX_LOOP_DECODE_MS){resetMediaTransition(record);return null;}
    if(!nativePictureReady(source)){record.waiting=true;record.incomingReady=false;}
    return record.outgoing;
  }
  function resetDecodedPicture(record){if(record?.decoded){record.decoded.width=record.decoded.height=1;record.decoded=null;}if(record){record.decodedTime=null;record.decodedSize=null;}}
  function boundedMediaPicture(size){const scale=Math.min(1,MAX_LOOP_FRAME_EDGE/Math.max(size.w,size.h),Math.sqrt(MAX_LOOP_FRAME_PIXELS/(size.w*size.h)));
    return {width:Math.max(1,Math.round(size.w*scale)),height:Math.max(1,Math.round(size.h*scale))};}
  // A paused video seeks for reverse playback. Chromium temporarily drops its
  // readiness during each seek, so retain the last genuinely decoded picture
  // rather than replacing the source with black. One RAM canvas is reused;
  // native transport, geometry, audio and private Programme clocks stay intact.
  function captureDecodedPicture(source,record,force=false){
    if(!record||record.disposed||source.audioOnly||source.el?.error||!('videoWidth' in source.el)||
       Number(source.el.readyState)<2||source.el.seeking===true)return false;
    const size=sizeOf(source),stamp=Number(source.el.currentTime)||0;
    if(!size.w||!size.h)return false;
    if(!force&&record.decoded&&record.decodedTime===stamp&&record.decodedSize?.w===size.w&&record.decodedSize?.h===size.h)return true;
    try{const {width,height}=boundedMediaPicture(size),cv=record.decoded||document.createElement('canvas');
      if(cv.width!==width)cv.width=width;if(cv.height!==height)cv.height=height;
      const ctx=cv.getContext('2d');ctx.clearRect(0,0,width,height);ctx.drawImage(source.el,0,0,width,height);
      record.decoded=cv;record.decodedTime=stamp;record.decodedSize=size;return true;
    }catch(_){return false;}
  }
  function resetMediaTransition(record){
    if(!record)return;record.started=record.created=null;record.duration=0;record.lastTime=null;record.waiting=false;record.incomingReady=false;record.outgoingSize=null;
    for(const cv of [record.outgoing,record.picture])if(cv){cv.width=cv.height=1;}
    record.outgoing=record.picture=null;
  }
  /* Every video loop keeps one decoded outgoing picture through the native
     seek. Cut replaces it as soon as incoming pixels arrive; Dissolve blends
     before source effects, input crop and placement. There is no readback or
     second playback element. Audio continues through the ordinary cut. */
  function attachMediaTransition(source){
    if(!source?.el||typeof source.transport?.subscribe!=='function'||mediaTransitions.has(source))return;
    const record={outgoing:null,picture:null,started:null,created:null,duration:0,lastTime:null,waiting:false,incomingReady:false,outgoingSize:null,disposed:false,decoded:null,decodedTime:null,decodedSize:null};
    mediaTransitions.set(source,record);
    const decoded=()=>{if(reversePlaying(source))captureDecodedPicture(source,record,true);};
    const decodeEvents=['seeked','loadeddata','canplay'];
    for(const name of decodeEvents)source.el.addEventListener?.(name,decoded);
    if(source.transport.details?.().direction==='reverse')captureDecodedPicture(source,record,true);
    const unsubscribe=source.transport.subscribe(event=>{
      if(record.disposed)return;
      if(event?.type!=='wrap'){
        if(['wrap','clear','stop','seek','cue','bounce','reset'].includes(event?.type))resetMediaTransition(record);
        if(event?.type==='clear')resetDecodedPicture(record);
        else if(['stop','seek','cue','bounce','reset'].includes(event?.type)){
          resetDecodedPicture(record);captureDecodedPicture(source,record,true);
          // Commands emit before changing state. Release an inactive seed after
          // that synchronous mutation, and do not resurrect it on late decode.
          Promise.resolve().then(()=>{if(!record.disposed&&!reversePlaying(source))resetDecodedPicture(record);});
        }
        if(event?.type==='clear')syncMix();return;
      }
      const size=sizeOf(source),details=source.transport.details?.()||{},
        range=Number(details.out)-Number(details.in),rate=Number(details.rate)||1,
        duration=Math.min(2000,Math.max(0,Number(event.durationMs)||0),Number.isFinite(range)&&range>0?range/rate*500:2000);
      resetMediaTransition(record);
      if(source.audioOnly||!size.w||!size.h||!sourceStatus(source).ok)return;
      const {width,height}=boundedMediaPicture(size),held=reverseHeldPicture(source);
      try{
        const outgoing=document.createElement('canvas');outgoing.width=width;outgoing.height=height;
        outgoing.getContext('2d').drawImage(Number(source.el.readyState)<2&&held?held:source.el,0,0,width,height);
        const picture=event.transition==='dissolve'&&duration>0?document.createElement('canvas'):null;
        if(picture){picture.width=width;picture.height=height;}
        record.outgoing=outgoing;record.picture=picture;record.started=record.created=performance.now();record.duration=duration;record.outgoingSize=size;
      }catch(_){resetMediaTransition(record);}
    });
    const dispose=source.dispose;
    source.dispose=()=>{if(record.disposed)return;record.disposed=true;try{unsubscribe?.();}catch(_){}
      for(const name of decodeEvents)source.el.removeEventListener?.(name,decoded);
      resetMediaTransition(record);resetDecodedPicture(record);mediaTransitions.delete(source);if(typeof dispose==='function')dispose();};
  }
  function sourceVisualFrame(source,timeMs){
    const record=source&&mediaTransitions.get(source);
    if(!record)return source;
    if(sourceCleared(source)||source.el?.error){resetMediaTransition(record);resetDecodedPicture(record);return source;}
    let incoming=source.el,logical=sizeOf(source);
    if(reversePlaying(source)){
      captureDecodedPicture(source,record);
      if(record.decoded){incoming=record.decoded;logical=record.decodedSize;}
    }else if(source.transport.details?.().direction!=='reverse')resetDecodedPicture(record);
    const visual=incoming===source.el?source:{...source,el:incoming,_sourcePictureSize:logical};
    const outgoing=loopHeldPicture(source,timeMs);
    if(!outgoing||record.started===null)return visual;
    // The wrap is emitted before native seeking. Keep its decoded outgoing
    // pixels while Chromium waits for the incoming frame, then begin the saved
    // video dissolve. The entire hold/blend expires within two seconds; a
    // stalled or failed decoder cannot leave an indefinitely stale picture.
    if(!nativePictureReady(source))return {...source,el:outgoing,_sourcePictureSize:record.outgoingSize};
    if(!record.picture){resetMediaTransition(record);return visual;}
    if(!record.incomingReady){
      record.incomingReady=true;
      if(record.waiting){record.started=timeMs;record.duration=Math.min(record.duration,MAX_LOOP_DECODE_MS-(timeMs-record.created));}
    }
    const elapsed=Math.max(0,timeMs-record.started);
    if(elapsed>=record.duration){resetMediaTransition(record);return visual;}
    if(record.lastTime!==timeMs){
      const cv=record.picture,ctx=cv.getContext('2d');
      try{ctx.save();ctx.globalAlpha=1;ctx.clearRect(0,0,cv.width,cv.height);ctx.drawImage(incoming,0,0,cv.width,cv.height);
        ctx.globalAlpha=1-elapsed/record.duration;ctx.drawImage(record.outgoing,0,0,cv.width,cv.height);record.lastTime=timeMs;}
      catch(_){resetMediaTransition(record);return visual;}
      finally{ctx.restore();}
    }
    return {...source,el:record.picture,_sourcePictureSize:logical};
  }
  const isCreativeSource=source=>!!source&&window.OpenLiveCreativeSources?.isCreative(source.sourceType);
  const needsProgrammeFork=source=>isFileMedia(source)||isCreativeSource(source)||source?.sourceType==='present';
  const sourceControlRevision=source=>source?.sourceType==='present'?source.presentationControls?.revision:source?.creativeControls?.revision;
  // Library proofs resolve private prepared runtimes without registering them,
  // changing the document, or borrowing Programme's independently owned clocks.
  const preparedSceneSources=new WeakMap();
  function sceneSource(scene,id){const prepared=scene&&preparedSceneSources.get(scene);return prepared?.has(id)?prepared.get(id):scene?._programmeSources?.has(id)?scene._programmeSources.get(id):sources.get(id);}
  function programmeMedia(id){return active()?._programmeSources?.get(id)||null;}
  function releaseSceneMedia(scene){
    if(!scene?._programmeSources)return;
    for(const [id,source] of scene._programmeSources){try{source?.dispose?.();}catch(_){}scene._programmeSources.set(id,null);}
  }
  function finishProgrammeTransition(){const old=transition;transition=null;clearTimeout(old?.timer);
    if(old?.from&&old.from!==active())releaseSceneMedia(old.from);
    if(old?.to&&old.to!==active())releaseSceneMedia(old.to);
    reconcileWidgets();syncMix();notifyTransition();}
  function cancelTransition(){
    if(programmePreparation){const request=programmePreparation;request.abort();request.finish();}
    // A timed Fade already published its target. Only a manual mix can return
    // to the previous Programme; a committed Fade must finish normally.
    if(transition?.manual)finishProgrammeTransition();
    return transitionState();
  }
  async function prepareProgrammeMedia(scene,request){
    const map=new Map();scene._programmeSources=map;
    for(const id of new Set((scene.slots||[]).map(slot=>slot.sourceId).filter(Boolean))){
      const source=sources.get(id);if(!needsProgrammeFork(source))continue;
      map.set(id,null);if(!source.el||source.disconnected)continue;
      const fork=source.sourceType==='present'?window.OpenLivePresentationSource?.fork:isCreativeSource(source)?window.OpenLiveCreativeSources?.fork:window.OpenLiveSourceAcquisition?.forkMedia;
      if(typeof fork!=='function')throw Error('The independent source renderer is unavailable. Programme is unchanged.');
      const fingerprint=svgPartFingerprint(source.config||{}),url=source.el.currentSrc||source.el.src,
        controlRevision=sourceControlRevision(source);
      const runtime=await request.wait(fork(source,{signal:request.signal}),late=>late?.dispose?.());map.set(id,runtime);request.check();
      Object.assign(runtime,{id,label:source.label,mirror:source.mirror,_programmeGeneration:++programmeMediaSequence});map.set(id,runtime);
      attachMediaTransition(runtime);
      runtime._previewOwner=source;runtime._previewConfigFingerprint=fingerprint;runtime._previewUrl=url;
      runtime._previewControlRevision=controlRevision;
      if(runtime.stream?.addEventListener){const update=()=>syncMix(),dispose=runtime.dispose;
        runtime.stream.addEventListener('addtrack',update);runtime.stream.addEventListener('removetrack',update);
        runtime.dispose=()=>{runtime.stream.removeEventListener('addtrack',update);runtime.stream.removeEventListener('removetrack',update);dispose();};}
    }
  }
  function programmeMediaCurrent(scene){
    for(const [id,runtime] of scene._programmeSources||[]){if(!runtime)continue;const source=sources.get(id);
      if(source!==runtime._previewOwner||svgPartFingerprint(source.config||{})!==runtime._previewConfigFingerprint||
        (source.el.currentSrc||source.el.src)!==runtime._previewUrl||
        sourceControlRevision(source)!==runtime._previewControlRevision)return false;}
    return true;
  }
  function snapshotScene(scene, capture = true, extras = sceneExtrasEnabled(scene)) {
    const result = JSON.parse(svgPartFingerprint(scene));
    if (capture && !scene.renderState) result.renderState = captureSceneRenderState(scene,extras);
    if (result.renderState?.theme) result.renderState.theme=semanticTheme(result.renderState.theme);
    if (result.renderState?.graphics && scene.renderState?.graphics?._images)
      result.renderState.graphics._images = {...scene.renderState.graphics._images};
    const logo = result.overlays?.logo;
    if (logo?.dataUrl) {
      if (scene.overlays.logo._img) logo._img = scene.overlays.logo._img;
      else if (typeof Image === 'function') { logo._img = new Image(); logo._img.src = logo.dataUrl; }
    }
    return result;
  }
  function captureSceneRenderState(scene, extras = true) {
    const liveWidgets=window.OpenLiveWidgets?.captureRenderState?.(scene.widgets || [])||{};
    return {
      theme:currentTheme(),
      graphics:extras && window.OpenLiveGraphics?.captureRenderState?.({sceneId:scene.id}) || {},
      captions:extras && window.OpenLiveCaptions?.activeStatus?.() || {lowerThird:null,ticker:null,tickerSpeed:1},
      commerce:{status:extras && window.OpenLiveCommerce?.activeStatus?.() || {state:'hidden'},
        salesStyle:extras && window.OpenLiveCommerce?.getState?.().salesStyle || 'compact'},
      widgets:extras ? Object.fromEntries((scene.widgets||[]).map(layer=>[layer.assetId,liveWidgets[layer.assetId]||scene.renderState?.widgets?.[layer.assetId]]).filter(([,asset])=>asset)) : {}
    };
  }
  function saveSceneRenderState(sceneId, state) {
    const scene=svgPartScene(sceneId),previous=scene.renderState;
    scene.renderState=JSON.parse(svgPartFingerprint(state));
    if(!save()){if(previous===undefined)delete scene.renderState;else scene.renderState=previous;throw new Error('The scene configuration could not be saved. Previous settings and Programme are unchanged.');}
    return scene;
  }
  function enablePreviewWorkflow() {
    if (previewWorkflow) return;
    // Persisted Programme survives reload separately from the editable scenes.
    doc.programmeSnapshot = snapshotScene(doc.programmeSnapshot || active());
    // Restored local files need a deliberate Take before acquiring a Programme clock.
    doc.programmeSnapshot._programmeSources=new Map((doc.programmeSnapshot.slots||[]).map(slot=>slot.sourceId).filter(id=>needsProgrammeFork(sources.get(id))).map(id=>[id,null]));
    previewWorkflow = true;
  }
  function renderOptions(scene) {
    return {sceneId:scene?.id, graphicsState:scene?.renderState?.graphics};
  }
  async function preparePreviewTake(sceneId, options = {}, manual = false) {
    if (!previewWorkflow || takingPreview) throw new Error('A Preview transition is already being prepared or is unavailable.');
    if(transition?.manual)throw new Error('Finish or reset the manual transition before taking another Preview.');
    if (transition && performance.now() < transition.startedAt + transition.duration) throw new Error('Wait for the current transition to finish.');
    if(transition)finishProgrammeTransition();
    const source = doc.scenes.find(scene => scene.id === sceneId);
    if (!source) throw new Error('Choose an existing Preview scene.');
    if (source.layoutPending) throw new Error('Choose this scene’s layout before taking it to Programme.');
    const fingerprint = svgPartFingerprint(source), next = snapshotScene(source,true,options.parts===undefined&&sceneExtrasEnabled(source));
    const renderFingerprint = svgPartFingerprint(next.renderState);
    if (options.parts !== undefined) {
      if (!Array.isArray(options.parts) || options.parts.length > MAX_SVG_PARTS) throw new Error('A preview mix supports up to 32 pieces.');
      delete next.fullTemplateId; delete next.fullTemplateStyle; delete next.fullTemplateExtras;
      next.svgParts = options.parts.map((part, index) => normalizeSceneSvgPart({...part,id:'preview-'+index},next.slots));
      next.svgPartsMode = 'parts-only'; next.svgPartsExtras = false;
      next.programmeLabel = String(options.label || 'Preview mix');
    }
    const request=createProgrammePreparation(options,manual);let published=false;
    try {
      await request.wait(prepareProgrammeMedia(next,request));
      if (next.fullTemplateId) await request.wait(window.OpenLiveFullTemplates.load(next.fullTemplateId,{style:next.fullTemplateStyle || {},retry:true}));
      if (next.svgParts) await request.wait(prepareSvgParts(next));
      if (sceneExtrasEnabled(next)) {
        await request.wait(prepareSceneThemeFont(next));
        await request.wait(window.OpenLiveGraphics?.prepareRenderState?.(next.renderState?.graphics));
        const images = Object.values(next.renderState?.graphics?._images || {});
        await request.wait(Promise.all(images.map(image => image.ready)));
        if (images.some(image => image.state !== 'ready')) throw new Error('A Preview graphic could not be prepared. Programme is unchanged.');
        const widgets = window.OpenLiveWidgets;
        if (widgets && (next.widgets || []).some(layer=>layer.visible!==false&&Number(layer.opacity)!==0&&widgets.runtimeStatus(layer.assetId,next.renderState?.widgets).state!=='ready'))
          throw new Error('Wait for the visible Preview widgets to finish loading. Programme is unchanged.');
      }
      if (!programmeMediaCurrent(next) || doc.scenes.find(scene => scene.id === sceneId) !== source || svgPartFingerprint(source) !== fingerprint ||
          sceneExtrasEnabled(next) && svgPartFingerprint(snapshotScene(source).renderState) !== renderFingerprint || options.isCurrent && !options.isCurrent())
        throw new Error('Preview changed while preparing the transition. Programme is unchanged; press Cut/Fade again.');
      // Validate native composition before publishing either bus or storage.
      const check = document.createElement('canvas'); check.width=640; check.height=360;
      paint(check,'16x9',next,performance.now());
      const artStatus = next.svgParts ? svgPartsStatus(next) : next.fullTemplateId ? fullTemplateStatus(next) : null;
      if (artStatus && artStatus.state !== 'ready') throw new Error(artStatus.error || 'Preview artwork is not ready. Programme is unchanged.');
      await request.wait(Promise.all([...next._programmeSources.values()].filter(runtime=>typeof runtime?.transport?.play==='function').map(runtime=>runtime.transport.play({signal:request.signal}))));
      request.check();
      if(!programmeMediaCurrent(next)||doc.scenes.find(scene=>scene.id===sceneId)!==source||svgPartFingerprint(source)!==fingerprint||sceneExtrasEnabled(next)&&svgPartFingerprint(snapshotScene(source).renderState)!==renderFingerprint||options.isCurrent&&!options.isCurrent())throw Error('Preview media changed while preparing the transition. Programme is unchanged.');
      const previous = active(), previousSnapshot = doc.programmeSnapshot, previousId = doc.activeId;
      if(manual){
        transition={manual:true,progress:0,from:previous,to:next,fromId:previous.id,toId:next.id,
          isCurrent:()=>programmeMediaCurrent(next)&&doc.scenes.find(scene=>scene.id===sceneId)===source&&
            svgPartFingerprint(source)===fingerprint&&(!sceneExtrasEnabled(next)||svgPartFingerprint(snapshotScene(source).renderState)===renderFingerprint)&&
            (!options.isCurrent||options.isCurrent())};
        published=true;reconcileWidgets();syncMix();request.finish();return transitionState();
      }
      doc.programmeSnapshot = next; doc.activeId = sceneId;
      if (!save()) { doc.programmeSnapshot = previousSnapshot; doc.activeId = previousId;
        throw new Error('The transition could not be saved. Programme is unchanged.'); }
      const duration = Math.max(0,Math.min(5000,Number(options.duration) || 0));
      transition = duration ? {from:previous,to:next,fromId:previous.id,toId:next.id,startedAt:performance.now(),duration} : null;
      if(transition){const current=transition;current.timer=setTimeout(()=>{if(transition===current)finishProgrammeTransition();},duration+16);}
      published=true;reconcileWidgets(); syncMix();
      if(!duration&&previous!==next)releaseSceneMedia(previous);
      return next;
    } finally { if(!published){request.abort();releaseSceneMedia(next);}request.finish(); }
  }
  function takePreviewScene(sceneId,options={}){return preparePreviewTake(sceneId,options,false);}
  function beginManualTransition(sceneId,options={}){return preparePreviewTake(sceneId,options,true);}
  function setManualTransition(value){
    const progress=Number(value);
    if(!Number.isFinite(progress)||progress<0||progress>1)throw new RangeError('Manual transition must be between 0 and 1.');
    if(!transition?.manual)throw new Error('Prepare the manual transition before moving the T-bar.');
    if(!progress){cancelTransition();return transitionState();}
    if(progress===1){
      const current=transition;
      if(!current.isCurrent()){cancelTransition();throw new Error('Preview changed. Programme is unchanged; reset the T-bar and try again.');}
      const previousSnapshot=doc.programmeSnapshot,previousId=doc.activeId;
      doc.programmeSnapshot=current.to;doc.activeId=current.toId;
      if(!save()){doc.programmeSnapshot=previousSnapshot;doc.activeId=previousId;cancelTransition();throw new Error('The transition could not be saved. Programme is unchanged.');}
      finishProgrammeTransition();return transitionState();
    }
    transition.progress=progress;syncMix();notifyTransition();return transitionState();
  }
  function addScene(name) {
    const s = blankScene(name || ('Scene ' + (doc.scenes.length + 1)), 'solo');
    doc.scenes.push(s); if (!previewWorkflow) doc.activeId = s.id; save(); return s;
  }
  function duplicateScene(id) {
    const index = doc.scenes.findIndex(scene => scene.id === id);
    if (index < 0) return null;
    const source = doc.scenes[index];
    const clone = JSON.parse(JSON.stringify(source,
      (key, value) => key && key[0] === '_' ? undefined : value));
    clone.id = uid('s');
    clone.name = String(source.name || 'Scene') + ' copy';
    clone.slots = (Array.isArray(clone.slots) ? clone.slots : []).map(slot => {
      if (slot && Object.prototype.hasOwnProperty.call(slot, 'id')) slot.id = uid('sl');
      return slot;
    });
    clone.svgParts = Array.isArray(clone.svgParts) ? clone.svgParts.map(layer=>({...layer,id:uid('sp')})) : clone.svgParts;
    if(clone.freeOrder)clone.freeOrder=clone.freeOrder.map(key=>key.startsWith('part:')?'part:'+clone.svgParts?.[source.svgParts?.findIndex(p=>'part:'+p.id===key)]?.id:key);
    if(clone.arrangementOverlayBefore)clone.arrangementOverlayBefore=clone.svgParts?.[source.svgParts?.findIndex(part=>part.id===clone.arrangementOverlayBefore)]?.id;
    clone.widgets = (Array.isArray(clone.widgets) ? clone.widgets : []).map(layer =>
      Object.assign({}, layer, { id:uid('wl') }));
    const legacyLogo = clone.overlays && clone.overlays.logo;
    const sourceLogo = source.overlays && source.overlays.logo;
    if (legacyLogo && legacyLogo.dataUrl && sourceLogo && sourceLogo._img && typeof Image === 'function') {
      const image = new Image(); image.src = legacyLogo.dataUrl; legacyLogo._img = image;
    }
    /* Copy the scene's Graphics relationships before exposing the duplicate.
       If durable Graphics storage rejects the copy, the Studio document is
       untouched instead of presenting a clone with silently different branding. */
    const graphics = window.OpenLiveGraphics;
    if (graphics && typeof graphics.copyScene === 'function')
      graphics.copyScene(source.id, clone.id, { allScopes:true });
    doc.scenes.splice(index + 1, 0, clone);
    if(!save()){doc.scenes.splice(index+1,1);throw new Error('The duplicate scene could not be saved. The original and Programme are unchanged.');}
    return clone;
  }
  function removeScene(id) {
    if (doc.scenes.length <= 1) return false;      /* never leave the Studio with none */
    const i = doc.scenes.findIndex(s => s.id === id);
    if (i < 0) return false;
    /* Retire the Graphics relationships first. A durable-storage failure must
       not delete the Studio scene while leaving a half-deleted visual state. */
    const graphics = window.OpenLiveGraphics;
    if (graphics && typeof graphics.removeScene === 'function')
      graphics.removeScene(id, { allScopes:true });
    doc.scenes.splice(i, 1);
    if(doc.sceneArrangementHistories)delete doc.sceneArrangementHistories[id];
    if (doc.defaultSceneId === id) doc.defaultSceneId = doc.scenes[0].id;
    if (doc.activeId === id) doc.activeId = defaultScene().id;
    save();
    svgPartHistories.delete(id);creativeHistories.delete(id);sceneContentHistories.delete(id);svgPartRenderErrors.delete(id);
    return true;
  }
  function renameScene(id, name) {
    const s = doc.scenes.find(x => x.id === id);
    if (!s) return false;
    const previous=s.name;s.name=String(name||'Scene').trim().slice(0,80)||'Scene';
    if(!save()){s.name=previous;return false;}return true;
  }
  // A scene-settings file is deliberately data-only: catalogue references and
  // layout/layer settings, never arbitrary code, URLs, devices or destinations.
  const sceneSettingKeys=['name','layout','layoutPending','sourceWorkflow','slots','freeOrder','fullTemplateId','fullTemplateStyle','fullTemplateExtras','svgParts','svgPartsMode','svgPartsExtras','arrangementOverlayBefore','contentItems'];
  function sceneSettingsObject(value,keys,label){
    if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
       Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Invalid '+label+' settings.');
  }
  function newSceneDraft(settings){
    sceneSettingsObject(settings,sceneSettingKeys,'scene');registerFullTemplateLayouts();
    const name=settings.name===undefined?'Scene '+(doc.scenes.length+1):settings.name;
    if(typeof name!=='string'||!name.trim()||name.length>80||/[\u0000-\u001f]/.test(name))throw new Error('Use a scene name of 1–80 characters.');
    const layout=settings.layout||settings.fullTemplateId||'solo';
    if(typeof layout!=='string'||!Object.hasOwn(LAYOUTS,layout))throw new Error('Choose an available scene layout.');
    const scene=blankScene(name.trim(),layout);
    if(settings.sourceWorkflow!==undefined){
      if(settings.sourceWorkflow!=='obs')throw Error('Invalid source workflow.');
      scene.sourceWorkflow='obs';
    }
    if(settings.layoutPending!==undefined){
      if(typeof settings.layoutPending!=='boolean')throw new Error('Invalid scene setup state.');
      if(settings.layoutPending)scene.layoutPending=true;
    }
    if(settings.slots!==undefined){
      if(!Array.isArray(settings.slots)||settings.slots.length>32||settings.slots.length<scene.slots.length)throw new Error('The scene needs a valid source-slot list (up to 32).');
      scene.slots=settings.slots.map(slot=>{
        sceneSettingsObject(slot,['mute','hidden','locked','gain','transform','inputSelection','outputFit','effects','generator','label','creative','arrangementUnplaced'],'source slot');
        if(['mute','hidden','locked','arrangementUnplaced'].some(key=>slot[key]!==undefined&&typeof slot[key]!=='boolean')||
           slot.gain!==undefined&&(typeof slot.gain!=='number'||!Number.isFinite(slot.gain)||slot.gain<0||slot.gain>2))throw new Error('Invalid source-slot audio or visibility settings.');
        return {sourceId:null,mute:slot.mute===true,hidden:slot.hidden===true,gain:slot.gain===undefined?1:slot.gain,
          ...(slot.effects!==undefined?{effects:effectsModule().normalizeEffects(slot.effects)}:{}),...(slot.generator!==undefined?{generator:effectsModule().normalizeGenerator(slot.generator)}:{}),
          ...(slot.locked!==undefined?{locked:slot.locked}:{}),...(slot.arrangementUnplaced!==undefined?{arrangementUnplaced:slot.arrangementUnplaced}:{}),...(slot.transform?{transform:freeTransform(slot.transform)}:{}),...(slot.inputSelection!==undefined?{inputSelection:normalizeInputSelection(slot.inputSelection)}:{}),...(slot.outputFit!==undefined?{outputFit:normalizeOutputFit(slot.outputFit)}:{}),...(slot.label?{label:String(slot.label).slice(0,120)}:{}),...(slot.creative?{creative:creativeModule().normalize(slot.creative)}:{})};
      });
    }
    for(const key of ['fullTemplateExtras','svgPartsExtras'])if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw new Error('Invalid scene overlay setting.');
    if(settings.fullTemplateId!==undefined){
      const module=window.OpenLiveFullTemplates,template=module?.get(settings.fullTemplateId);
      if(!validFullTemplate(template)||settings.fullTemplateId!==layout||settings.svgParts!==undefined||settings.svgPartsMode!==undefined||settings.svgPartsExtras!==undefined)
        throw new Error('Choose one complete template or an independent layer stack.');
      scene.fullTemplateId=template.id;scene.fullTemplateStyle=fullTemplateStyle(template.id,settings.fullTemplateStyle||{});
      scene.fullTemplateExtras=settings.fullTemplateExtras===true;
      if(settings.contentItems!==undefined){
        scene.contentItems=normalizeContentItems(settings.contentItems,template);
        const components={...(scene.fullTemplateStyle.components||{})};
        for(const [key,item] of Object.entries(scene.contentItems))if(item.removed){const id=key.slice(9);components[id]={...(components[id]||{}),visible:false};}
        if(Object.keys(components).length)scene.fullTemplateStyle=fullTemplateStyle(template.id,{...scene.fullTemplateStyle,components});
      }
    }else if(settings.fullTemplateStyle!==undefined||settings.fullTemplateExtras!==undefined||settings.contentItems!==undefined)throw new Error('Complete-template settings need a template.');
    if(settings.svgParts!==undefined){
      if(!Array.isArray(settings.svgParts)||settings.svgParts.length>32)throw new Error('A scene supports up to 32 SVG layers.');
      scene.svgPartsMode=settings.svgPartsMode||'overlay';
      if(settings.svgPartsExtras!==undefined)scene.svgPartsExtras=settings.svgPartsExtras;
      scene.svgParts=settings.svgParts.map(part=>{
        sceneSettingsObject(part,['id','templateId','componentId','style','sourceSlot','creative','arrangement','locked'],'SVG layer');
        return normalizeSceneSvgPart({...part,id:uid('sp')},scene.slots);
      });
      scene.svgParts=Object.freeze(validatedSvgParts(scene));
    }else if(settings.svgPartsMode!==undefined||settings.svgPartsExtras!==undefined)throw new Error('Layer settings need an SVG layer stack.');
    if(settings.freeOrder!==undefined){
      if(!Array.isArray(settings.freeOrder)||settings.freeOrder.length>64||settings.freeOrder.some(key=>typeof key!=='string'))throw Error('Invalid scene layer order.');
      // Imported SVG layers receive fresh identities; remap their stack keys.
      scene.freeOrder=settings.freeOrder.map(key=>key.startsWith('part:')?'part:'+scene.svgParts?.[settings.svgParts?.findIndex(p=>'part:'+p.id===key)]?.id:key);
      scene.freeOrder=freeLayers(scene).map(layer=>layer.key);
    }
    if(settings.arrangementOverlayBefore!==undefined){
      const index=settings.svgParts?.findIndex(part=>part.id===settings.arrangementOverlayBefore);
      if(typeof settings.arrangementOverlayBefore!=='string'||!(index>=0)||!scene.svgParts?.[index])throw Error('Choose an existing artwork layer for the overlay order.');
      scene.arrangementOverlayBefore=scene.svgParts[index].id;
    }
    return scene;
  }
  async function createScene(settings={},options={}){
    const candidate=newSceneDraft(settings);
    if(candidate.fullTemplateId)await window.OpenLiveFullTemplates.load(candidate.fullTemplateId,{style:candidate.fullTemplateStyle,retry:true});
    if(candidate.svgParts)await prepareSvgParts(candidate);
    if(options.isCurrent&&!options.isCurrent())throw new Error('Scene creation cancelled. Nothing was added.');
    // Publish only a fully prepared scene, in a single durable write. Creation
    // does not change the default identity, Programme, captures or other scenes.
    const generated=[];
    try{for(const slot of candidate.slots)if(slot.generator){const source=addSource(effectsModule().createGeneratorSource(slot.generator));generated.push(source.id);slot.sourceId=source.id;}}
    catch(error){generated.forEach(discardUnplacedSource);throw error;}
    doc.scenes.push(candidate);
    if(!save()){doc.scenes.pop();generated.forEach(discardUnplacedSource);throw new Error('The new scene could not be saved. Existing scenes are unchanged.');}
    return candidate;
  }
  async function importSceneFile(file,options={}){
    sceneSettingsObject(file,['format','version','scene'],'scene file');
    if(file.format!=='showave-scene-settings'||file.version!==1)throw new Error('Choose a SHOWAVE scene-settings file (version 1).');
    return createScene(file.scene,options);
  }
  function exportSceneSettings(id){
    const scene=scenes().find(scene=>scene.id===id);if(!scene)throw new Error('Choose an existing scene.');
    const settings={name:scene.name,layout:scene.layout,slots:scene.slots.map(slot=>({mute:slot.mute===true,hidden:slot.hidden===true,gain:slot.gain===undefined?1:slot.gain,
      ...(slot.effects?{effects:slot.effects}:{}),...(slot.generator?{generator:slot.generator}:{}),
      ...(slot.locked!==undefined?{locked:slot.locked}:{}),...(slot.arrangementUnplaced!==undefined?{arrangementUnplaced:slot.arrangementUnplaced}:{}),...(slot.transform?{transform:slot.transform}:{}),...(slot.inputSelection!==undefined?{inputSelection:slot.inputSelection}:{}),...(slot.outputFit!==undefined?{outputFit:slot.outputFit}:{}),...(slot.label?{label:slot.label}:{}),...(slot.creative?{creative:slot.creative}:{})}))};
    for(const key of sceneSettingKeys.filter(key=>!['name','layout','slots'].includes(key)))if(scene[key]!==undefined)settings[key]=scene[key];
    // Validate before exporting; imported content receives new scene/layer IDs.
    newSceneDraft(settings);
    return JSON.parse(JSON.stringify({format:'showave-scene-settings',version:1,scene:settings}));
  }
  /* Changing layout resizes the slot list, keeping the bindings that still fit
     and reporting the ones that no longer do rather than dropping them silently. */
  function commitSceneLayout(s, key, fullTemplateId, style = {}) {
    const referenced = !fullTemplateId && Array.isArray(s.svgParts) ? Math.max(0,...s.svgParts.map(part=>Number.isInteger(part.sourceSlot)?part.sourceSlot+1:0)) : 0;
    const pendingBlank=s.layoutPending&&!s.slots.some(slot=>slot.sourceId)&&!s.svgParts?.length&&!s.fullTemplateId;
    const want = key==='free'?(pendingBlank?0:s.slots.length):Math.max(LAYOUTS[key].slots,referenced), had = s.slots.length;
    const dropped = s.slots.slice(want).filter(sl => sl.sourceId).length;
    const previous = {layout:s.layout,layoutPending:s.layoutPending,slots:s.slots,fullTemplateId:s.fullTemplateId,style:s.fullTemplateStyle,extras:s.fullTemplateExtras,
      hadTemplate:Object.prototype.hasOwnProperty.call(s,'fullTemplateId'),
      hadStyle:Object.prototype.hasOwnProperty.call(s,'fullTemplateStyle'),
      hadExtras:Object.prototype.hasOwnProperty.call(s,'fullTemplateExtras'),
      parts:svgPartSnapshot(s)};
    const slots = key==='free'?s.slots.slice(0,want).map((slot,i)=>({...slot,transform:slot.transform||freeTransform(sourceRectNormalized(s,i))})):want === had ? s.slots : s.slots.slice(0,want);
    while (slots.length < want) slots.push({sourceId:null,mute:false,hidden:false,gain:1});
    s.slots = slots; s.layout = key; delete s.layoutPending;
    if (fullTemplateId) s.fullTemplateId = fullTemplateId; else delete s.fullTemplateId;
    if (fullTemplateId && Object.keys(style).length) s.fullTemplateStyle = {...style}; else delete s.fullTemplateStyle;
    if (fullTemplateId) s.fullTemplateExtras = !!previous.fullTemplateId && previous.extras === true;
    else delete s.fullTemplateExtras;
    if(fullTemplateId){delete s.svgParts;delete s.svgPartsMode;delete s.svgPartsExtras;delete s.arrangementOverlayBefore;delete s.contentItems;}
    else if(Array.isArray(s.svgParts)){s.svgPartsMode='overlay';delete s.svgPartsExtras;}
    if (!save()) {
      s.layout = previous.layout; s.slots = previous.slots;
      if(previous.layoutPending!==undefined)s.layoutPending=previous.layoutPending;
      if (previous.hadTemplate) s.fullTemplateId = previous.fullTemplateId; else delete s.fullTemplateId;
      if (previous.hadStyle) s.fullTemplateStyle = previous.style; else delete s.fullTemplateStyle;
      if (previous.hadExtras) s.fullTemplateExtras = previous.extras; else delete s.fullTemplateExtras;
      for(const field of ['svgParts','svgPartsMode','svgPartsExtras','arrangementOverlayBefore','contentItems']){if(Object.prototype.hasOwnProperty.call(previous.parts,field))s[field]=previous.parts[field];else delete s[field];}
      return null;
    }
    svgPartHistories.delete(s.id);svgPartRenderErrors.delete(s.id);
    return { dropped, slots: want };
  }
  function setLayout(id, key) {
    const s = doc.scenes.find(x => x.id === id); if (!s || !LAYOUTS[key]) return null;
    return commitSceneLayout(s, key, null);
  }
  function applySceneTemplate(sceneId, templateId, style = {}) {
    const scene = doc.scenes.find(item => item.id === sceneId);
    if (!scene) return null;
    registerFullTemplateLayouts();
    const module = window.OpenLiveFullTemplates;
    const record = module && typeof module.get === 'function' && module.get(templateId);
    if (!validFullTemplate(record) || !LAYOUTS[templateId] || !module || typeof module.status !== 'function')
      throw new Error('Choose an available full SHOWAVE template.');
    if((scene.fullTemplateId!==templateId||scene.layout!==templateId)&&scene.slots.some(slot=>
      ['lower-third','ticker','countdown','qr','product-card','sports','audience'].includes(sources.get(slot.sourceId)?.sourceType)))
      throw new Error('This scene has creative source layers. Applying a full template would replace or rebind them. Use native artwork pieces or apply the template in a separate scene.');
    const canonicalStyle = fullTemplateStyle(templateId,style), key = fullTemplateKey(templateId,canonicalStyle);
    if ((module.status(templateId,canonicalStyle) || {}).state !== 'ready')
      throw new Error('Wait for the full template artwork to finish loading before applying it.');
    const result = commitSceneLayout(scene, templateId, templateId, canonicalStyle);
    if (!result) throw new Error('The full template could not be saved. The previous scene has not changed.');
    fullTemplateRenderErrors.delete(key);
    return {...result,templateId};
  }
  function clearSceneTemplate(sceneId) {
    const scene = doc.scenes.find(item => item.id === sceneId);
    if (!scene || !scene.fullTemplateId) return false;
    const previous = {id:scene.fullTemplateId,style:scene.fullTemplateStyle,extras:scene.fullTemplateExtras,
      hadStyle:Object.prototype.hasOwnProperty.call(scene,'fullTemplateStyle'),
      hadExtras:Object.prototype.hasOwnProperty.call(scene,'fullTemplateExtras')};
    delete scene.fullTemplateId; delete scene.fullTemplateStyle; delete scene.fullTemplateExtras;
    if (!save()) {
      scene.fullTemplateId = previous.id;
      if (previous.hadStyle) scene.fullTemplateStyle = previous.style;
      if (previous.hadExtras) scene.fullTemplateExtras = previous.extras;
      return false;
    }
    return true;
  }
  function setSceneTemplateExtras(sceneId, enabled) {
    const scene = doc.scenes.find(item => item.id === sceneId);
    const field=scene&&(scene.fullTemplateId?'fullTemplateExtras':scene.svgPartsMode==='parts-only'||scene.layout==='free'&&scene.svgPartsExtras!==undefined?'svgPartsExtras':null);
    if (!field || typeof enabled !== 'boolean') return false;
    const hadExtras = Object.prototype.hasOwnProperty.call(scene,field);
    const previous = scene[field];
    if (hadExtras && previous === enabled) return true;
    scene[field] = enabled;
    if (!save()) {
      if (hadExtras) scene[field] = previous; else delete scene[field];
      return false;
    }
    return true;
  }
  // Scene-owned rendering choice, never a change to reusable assets or their
  // visibility settings. Ordinary layouts automatically regain those layers.
  function sceneExtrasEnabled(scene) {
    if(scene && scene.svgPartsMode==='parts-only')return scene.svgPartsExtras===true;
    if(scene?.layout==='free'&&scene.svgPartsExtras!==undefined)return scene.svgPartsExtras===true;
    return !scene || !scene.fullTemplateId || scene.fullTemplateExtras === true;
  }
  /* Scene-owned SVG layers are an OpenLive extension, not Arena composition
     layers. Native alpha order, source/audio ownership and undo remain local
     to this Studio document. No catalogue record or global model is mutated. */
  const svgPartHistories=new Map(),svgPartRenderErrors=new Map(),MAX_SVG_PARTS=32;
  const svgPartFields=['layout','freeOrder','fullTemplateId','fullTemplateStyle','fullTemplateExtras','svgParts','svgPartsMode','svgPartsExtras','arrangementOverlayBefore','contentItems'];
  function svgPartSnapshot(scene){return Object.fromEntries(svgPartFields.filter(key=>Object.prototype.hasOwnProperty.call(scene,key)).map(key=>[key,scene[key]]));}
  function svgPartFingerprint(scene){return JSON.stringify(scene,(key,value)=>key&&key[0]==='_'?undefined:value);}
  function svgPartModule(){const module=window.OpenLiveFullTemplates;if(!module||typeof module.loadPart!=='function')throw new Error('The independent SVG parts renderer is unavailable.');return module;}
  function normalizeSceneSvgPart(raw,slots){
    const module=svgPartModule();
    if(!raw||typeof raw.id!=='string'||!raw.id||raw.id.length>100)throw new Error('The SVG layer has no valid scene identity.');
    const template=module.get(raw.templateId),component=template&&(template.components||[]).find(item=>item.id===raw.componentId);
    if(!component)throw new Error('The SVG layer refers to an unavailable native part.');
    const part={id:raw.id,templateId:template.id,componentId:component.id,style:module.normalizePartStyle(template.id,component.id,raw.style===undefined?{}:raw.style)};
    if(raw.locked!==undefined){if(typeof raw.locked!=='boolean')throw Error('Invalid artwork layer lock setting.');part.locked=raw.locked;}
    if(raw.creative!==undefined)part.creative=creativeModule().normalize(raw.creative);
    if(raw.arrangement!==undefined){
      sceneSettingsObject(raw.arrangement,['from','to'],'artwork arrangement');
      if(!raw.arrangement.from||!raw.arrangement.to)throw Error('An artwork arrangement needs both transforms.');
      part.arrangement=Object.freeze({from:Object.freeze(freeTransform(raw.arrangement.from)),to:Object.freeze(freeTransform(raw.arrangement.to))});
    }
    if(raw.sourceSlot!==undefined){
      if(!Number.isInteger(component.frameIndex)||!Number.isInteger(raw.sourceSlot)||raw.sourceSlot<0||raw.sourceSlot>=slots.length||raw.sourceSlot>=32)
        throw new Error('Choose an existing source slot for this feed frame.');
      part.sourceSlot=raw.sourceSlot;
    }
    return Object.freeze(part);
  }
  function validatedSvgParts(scene){
    if(!Array.isArray(scene.svgParts)||scene.svgParts.length>MAX_SVG_PARTS)throw new Error('A scene can contain at most 32 independent SVG layers.');
    if(scene.svgPartsMode!=='overlay'&&scene.svgPartsMode!=='parts-only')throw new Error('The SVG layer rendering mode is invalid.');
    if(scene.fullTemplateId)throw new Error('Split the complete template before combining independent SVG layers.');
    const parts=scene.svgParts.map(part=>normalizeSceneSvgPart(part,scene.slots||[]));
    if(new Set(parts.map(part=>part.id)).size!==parts.length)throw new Error('SVG layer identities must be unique within the scene.');
    return parts;
  }
  function svgPartsStatus(scene,prepare=false){
    if(!scene || scene.svgParts===undefined)return null;
    try{
      const parts=validatedSvgParts(scene),module=svgPartModule();let visible=0,waiting=false;
      for(const part of parts){
        const change=part.style.components&&part.style.components[part.componentId]||{};
        if(change.visible===false||change.opacity===0)continue;
        const component=module.get(part.templateId).components.find(item=>item.id===part.componentId);
        if(!component.virtual||(Number.isInteger(part.sourceSlot)&&scene.slots[part.sourceSlot]&&!scene.slots[part.sourceSlot].hidden&&!sceneSource(scene,scene.slots[part.sourceSlot].sourceId)?.audioOnly&&sourceStatus(sceneSource(scene,scene.slots[part.sourceSlot].sourceId)).ok))visible++;
        const status=module.partStatus(part.templateId,part.componentId,part.style);
        if(status.state==='failed')return status;
        if(status.state!=='ready'){waiting=true;if(prepare&&status.state==='idle')module.loadPart(part.templateId,part.componentId,{style:part.style}).catch(()=>{});}
      }
      const renderError=svgPartRenderErrors.get(scene.id);
      if(renderError?.parts===scene.svgParts)return {state:'failed',error:renderError.error};
      return {state:waiting?'loading':'ready',error:'',visible};
    }catch(error){return {state:'failed',error:error.message||String(error)};}
  }
  async function prepareSvgParts(scene){
    const parts=validatedSvgParts(scene),module=svgPartModule();
    await Promise.all(parts.filter(part=>{const change=part.style.components&&part.style.components[part.componentId]||{};
      return change.visible!==false&&change.opacity!==0;}).map(part=>module.loadPart(part.templateId,part.componentId,{style:part.style,retry:true})));
  }
  function svgPartsHistory(sceneId){const h=svgPartHistories.get(sceneId)||{undo:[],redo:[]};return {canUndo:!!h.undo.length,canRedo:!!h.redo.length,
    undoLabel:h.undo.length?h.undo[h.undo.length-1].label:'',redoLabel:h.redo.length?h.redo[h.redo.length-1].label:''};}
  function commitSvgParts(scene,next,label,recordHistory=true){
    const previous=svgPartSnapshot(scene),previousSlots=scene.slots;
    if(next.arrangementOverlayBefore&&!next.svgParts?.some(part=>part.id===next.arrangementOverlayBefore))delete next.arrangementOverlayBefore;
    if(next.svgParts)next.svgParts=Object.freeze(next.svgParts.slice());
    for(const field of svgPartFields){if(Object.prototype.hasOwnProperty.call(next,field))scene[field]=next[field];else delete scene[field];}
    if(next.slots)scene.slots=next.slots;
    if(!save()){
      for(const field of svgPartFields){if(Object.prototype.hasOwnProperty.call(previous,field))scene[field]=previous[field];else delete scene[field];}
      scene.slots=previousSlots;throw new Error('The SVG layers could not be saved. The previous scene has not changed.');
    }
    svgPartRenderErrors.delete(scene.id);
    if(recordHistory){const history=svgPartHistories.get(scene.id)||{undo:[],redo:[]};history.undo.push({before:previous,after:svgPartSnapshot(scene),label});
      if(history.undo.length>20)history.undo.shift();history.redo=[];svgPartHistories.set(scene.id,history);}
    return scene;
  }
  function svgPartScene(sceneId){const scene=doc.scenes.find(item=>item.id===sceneId);if(!scene)throw new Error('The target scene is no longer available.');return scene;}
  function verifySvgPartCommit(scene,fingerprint,options){
    if(doc.scenes.find(item=>item.id===scene.id)!==scene||svgPartFingerprint(scene)!==fingerprint||(options&&typeof options.isCurrent==='function'&&!options.isCurrent()))
      throw new Error('The SVG layer edit was cancelled because its scene or selection changed.');
  }
  function splitSvgPartDraft(scene){
    const next={...svgPartSnapshot(scene),slots:scene.slots.slice()};
    if(scene.fullTemplateId){
      const module=svgPartModule(),template=module.get(scene.fullTemplateId),style=module.normalizeStyle(template.id,scene.fullTemplateStyle||{});
      const colours={...style};delete colours.components;
      next.svgParts=template.components.slice().sort((a,b)=>a.order-b.order).filter(component=>!scene.contentItems?.['template:'+component.id]?.removed).map(component=>normalizeSceneSvgPart({id:uid('sp'),templateId:template.id,componentId:component.id,
        style:{...colours,...(style.components&&style.components[component.id]?{components:{[component.id]:style.components[component.id]}}:{})},
        ...(scene.contentItems?.['template:'+component.id]?.locked?{locked:true}:{}),
        ...(Number.isInteger(component.frameIndex)?{sourceSlot:component.frameIndex}:{})},next.slots));
      next.svgPartsMode='parts-only';next.svgPartsExtras=scene.fullTemplateExtras===true;
      delete next.fullTemplateId;delete next.fullTemplateStyle;delete next.fullTemplateExtras;delete next.contentItems;
    }else{next.svgParts=(scene.svgParts||[]).slice();next.svgPartsMode=scene.svgPartsMode||'overlay';}
    return next;
  }
  async function splitSceneTemplate(sceneId,options={}){
    const scene=svgPartScene(sceneId);if(!scene.fullTemplateId)return scene;
    const fingerprint=svgPartFingerprint(scene),next=splitSvgPartDraft(scene);await prepareSvgParts(next);
    verifySvgPartCommit(scene,fingerprint,options);return commitSvgParts(scene,next,'Split complete SVG template');
  }
  async function addSceneSvgPart(sceneId,templateId,componentId,style={},options={}){
    const added=await addSceneSvgParts(sceneId,[{templateId,componentId,style,...(options.sourceSlot===undefined?{}:{sourceSlot:options.sourceSlot})}],options);
    return added[0];
  }
  async function addSceneSvgParts(sceneId,items,options={}){
    const scene=svgPartScene(sceneId),fingerprint=svgPartFingerprint(scene),next=splitSvgPartDraft(scene),module=svgPartModule();
    if(scene.layoutPending)throw new Error('Choose this scene’s layout before adding sources or artwork.');
    if(!Array.isArray(items)||!items.length)throw new Error('Choose at least one SVG piece.');
    if(next.svgParts.length+items.length>MAX_SVG_PARTS)throw new Error('A scene can contain at most 32 independent SVG layers.');
    const added=[],backgrounds=[],overlays=[];let label='Add preview mix';
    for(const raw of items){
      if(!raw||typeof raw!=='object'||Object.keys(raw).some(key=>!['templateId','componentId','style','sourceSlot'].includes(key)))throw new Error('Invalid SVG piece settings.');
      const {templateId,componentId,style={}}=raw,template=module.get(templateId),component=template?.components?.find(item=>item.id===componentId);
      if(!component)throw new Error('Choose an available native SVG part.');
      let sourceSlot=raw.sourceSlot;
      if(Number.isInteger(component.frameIndex)&&sourceSlot===undefined){
        if(next.slots.length>=32)throw new Error('This scene already has 32 source slots. Choose an existing slot.');
        sourceSlot=next.slots.length;next.slots.push({sourceId:null,mute:false,hidden:false,gain:1});
      }
      const part=normalizeSceneSvgPart({id:uid('sp'),templateId,componentId,style,...(sourceSlot===undefined?{}:{sourceSlot})},next.slots);
      added.push(part);(component.type==='background'?backgrounds:overlays).push(part);
      if(items.length===1)label='Add '+component.label;
    }
    next.svgParts=Object.freeze([...backgrounds,...next.svgParts,...overlays]);await prepareSvgParts(next);verifySvgPartCommit(scene,fingerprint,options);
    commitSvgParts(scene,next,label);return added;
  }
  async function updateSceneSvgPart(sceneId,partId,patch={},options={}){
    const scene=svgPartScene(sceneId),fingerprint=svgPartFingerprint(scene),parts=validatedSvgParts(scene),index=parts.findIndex(part=>part.id===partId);
    if(index<0)throw new Error('That SVG layer is no longer in this scene.');
    if(parts[index].locked)throw Error('Unlock this artwork layer before editing it.');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['style','sourceSlot'].includes(key)))throw new Error('Only SVG layer settings and source-slot relationships can be updated.');
    const part=normalizeSceneSvgPart({...parts[index],...patch},scene.slots);parts[index]=part;
    const next={...svgPartSnapshot(scene),slots:scene.slots,svgParts:Object.freeze(parts)};await prepareSvgParts(next);
    verifySvgPartCommit(scene,fingerprint,options);commitSvgParts(scene,next,'Edit SVG layer');return part;
  }
  // Visibility and locking belong to this scene item, including native artwork.
  // They stay available while locked and do not become content undo entries.
  function updateSceneSvgPartItem(sceneId,partId,patch){
    const scene=svgPartScene(sceneId),index=scene.svgParts?.findIndex(part=>part.id===partId);
    if(index===undefined||index<0)throw Error('That SVG layer is no longer in this scene.');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['hidden','locked'].includes(key))||
      Object.values(patch).some(value=>typeof value!=='boolean'))throw Error('Use boolean artwork visibility and lock settings.');
    const current=scene.svgParts[index],next={...current},hidden=current.style.components?.[current.componentId]?.visible===false;
    if(Object.hasOwn(patch,'hidden')&&patch.hidden!==hidden)next.style={...current.style,components:{...(current.style.components||{}),
      [current.componentId]:{...(current.style.components?.[current.componentId]||{}),visible:!patch.hidden}}};
    if(Object.hasOwn(patch,'locked')&&patch.locked!==!!current.locked)next.locked=patch.locked;
    const part=normalizeSceneSvgPart(next,scene.slots);
    if(svgPartFingerprint(part)===svgPartFingerprint(current))return current;
    const parts=scene.svgParts.slice();parts[index]=part;
    commitFree(scene,{svgParts:Object.freeze(parts)});svgPartRenderErrors.delete(scene.id);return part;
  }
  function removeSceneSvgPart(sceneId,partId){
    const scene=svgPartScene(sceneId),parts=scene.svgParts;
    if(!Array.isArray(parts))throw new Error('This scene has no SVG layer list.');
    if(parts.find(part=>part?.id===partId)?.locked)throw Error('Unlock this artwork layer before removing it.');
    const next=parts.filter(part=>part&&part.id!==partId);if(parts.length===next.length)return false;
    commitSvgParts(scene,{...svgPartSnapshot(scene),svgParts:Object.freeze(next)},'Remove SVG layer');return true;
  }
  function reorderSceneSvgParts(sceneId,orderedIds){
    const scene=svgPartScene(sceneId),parts=validatedSvgParts(scene);
    if(!Array.isArray(orderedIds)||orderedIds.length!==parts.length||new Set(orderedIds).size!==parts.length||orderedIds.some(id=>!parts.some(part=>part.id===id)))throw new Error('Provide every SVG layer exactly once in bottom-to-top order.');
    let freeOrder;
    if(scene.layout==='free'){let i=0;freeOrder=freeLayers(scene).map(row=>row.part?'part:'+orderedIds[i++]:row.key);}
    commitSvgParts(scene,{...svgPartSnapshot(scene),...(freeOrder?{freeOrder}:{}),svgParts:Object.freeze(orderedIds.map(id=>parts.find(part=>part.id===id)))},'Reorder SVG layers');return true;
  }
  async function stepSvgPartHistory(sceneId,redo,options={}){
    const scene=svgPartScene(sceneId),history=svgPartHistories.get(sceneId),from=history&&(redo?history.redo:history.undo);if(!from||!from.length)return false;
    const entry=from[from.length-1],fingerprint=svgPartFingerprint(scene),next={...(redo?entry.after:entry.before),slots:scene.slots};
    const currentParts=new Map((scene.svgParts||[]).map(part=>[part.id,part])),restoredParts=new Map((next.svgParts||[]).map(part=>[part.id,part]));
    const contentStamp=part=>{const content={...part};delete content.locked;return svgPartFingerprint(content);};
    for(const part of currentParts.values())if(part.locked&&(!restoredParts.has(part.id)||contentStamp(part)!==contentStamp(restoredParts.get(part.id))))
      throw Error('Unlock this artwork layer before undoing or redoing its edit.');
    if(next.svgParts)next.svgParts=next.svgParts.map(part=>{
      const current=currentParts.get(part.id);if(!current)return part;
      const restored={...part};if(Object.hasOwn(current,'locked'))restored.locked=current.locked;else delete restored.locked;
      return normalizeSceneSvgPart(restored,scene.slots);
    });
    // SVG undo changes the SVG stack, not later audio or extra-overlay edits.
    if(scene.fullTemplateId||scene.svgPartsMode==='parts-only'||scene.layout==='free'&&scene.svgPartsExtras!==undefined){
      if(next.fullTemplateId)next.fullTemplateExtras=sceneExtrasEnabled(scene);
      if(next.svgPartsMode==='parts-only'||next.layout==='free'&&next.svgParts!==undefined)next.svgPartsExtras=sceneExtrasEnabled(scene);
    }
    if(next.svgParts)await prepareSvgParts(next);
    else if(next.fullTemplateId)await svgPartModule().load(next.fullTemplateId,{style:next.fullTemplateStyle,retry:true});
    verifySvgPartCommit(scene,fingerprint,options);if(from[from.length-1]!==entry)throw new Error('The SVG undo history changed while preparing.');
    commitSvgParts(scene,next,entry.label,false);from.pop();(redo?history.undo:history.redo).push(entry);return true;
  }
  const undoSceneSvgParts=(sceneId,options)=>stepSvgPartHistory(sceneId,false,options);
  const redoSceneSvgParts=(sceneId,options)=>stepSvgPartHistory(sceneId,true,options);
  // Free-canvas sources are scene placements, not properties on shared captures.
  // The same capture can have a different pose in every scene and held Programme.
  function freeTransform(raw={}) {
    const defaults={x:0,y:0,w:1,h:1,rotation:0},next={};
    for(const key of Object.keys(defaults)){
      const value=raw[key]===undefined?defaults[key]:raw[key];
      if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>(key==='rotation'?36000:10)||(['w','h'].includes(key)&&value<.01))throw Error('Invalid source transform.');
      next[key]=key==='rotation'?((value%360)+360)%360:value;
    }
    return next;
  }
  // Input Selection chooses pixels before fitting them into the independent
  // output transform. Creative crop remains an output-space clipping effect.
  // Coordinates refer to the full visible input, including a capture's mirror.
  function normalizeInputSelection(raw={}) {
    const defaults={x:0,y:0,w:1,h:1},next={};
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!Object.hasOwn(defaults,key)))throw Error('Invalid Input Selection.');
    for(const key of Object.keys(defaults)){
      const value=raw[key]===undefined?defaults[key]:raw[key];
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1||(['w','h'].includes(key)&&value===0))throw Error('Input Selection must stay inside the source with a positive width and height.');
      next[key]=value;
    }
    if(next.x+next.w>1+1e-9||next.y+next.h>1+1e-9)throw Error('Input Selection must stay inside the source.');
    next.w=Math.min(next.w,1-next.x);next.h=Math.min(next.h,1-next.y);
    if(next.w<=0||next.h<=0)throw Error('Input Selection needs a positive width and height.');
    return next;
  }
  function sourceInputSelection(scene,index) {
    const slot=scene?.slots?.[index];if(!slot)throw Error('Select an existing source.');
    return normalizeInputSelection(slot.inputSelection);
  }
  function sourceOutputFit(scene,index){
    const slot=scene?.slots?.[index];if(!slot)throw Error('Select an existing source.');
    if(slot.outputFit!==undefined)return normalizeOutputFit(slot.outputFit);
    const row=sceneContents(scene).find(item=>item.index===index&&item.boundSlot),style=row?.part?.style||scene.fullTemplateStyle;
    return normalizeOutputFit(style?.components?.[row?.componentId]?.feedFit||'contain');
  }
  function updateSourceInputSelection(sceneId,index,rect,options={}) {
    return editCreativeLayer(sceneId,'source:'+index,{inputSelection:rect},options);
  }
  function normalizeOutputFit(value) {
    if(!['off','contain','cover','stretch'].includes(value))throw Error('Choose Off, Fit, Fill, or Stretch for output scaling.');
    return value;
  }
  function sourceRectNormalized(scene,index,aspect='16x9') {
    if(scene.layout==='free')return freeTransform(scene.slots[index]?.transform);
    const size=ASPECTS[aspect]||ASPECTS['16x9'],cv={width:size.w,height:size.h};
    const box=sourceRect(rects(scene.layout,aspect)[index]||{x:0,y:0,w:1,h:1},cv,sceneSource(scene,scene.slots[index]?.sourceId));
    return {x:box.x/size.w,y:box.y/size.h,w:box.w/size.w,h:box.h/size.h,rotation:0};
  }
  const sceneRects=(scene,aspect)=>scene.layout==='free'?scene.slots.map((slot,i)=>sourceRectNormalized(scene,i,aspect)):rects(scene.layout,aspect);
  function placedImageOrder(keys,slots,parts=[]){
    const backgrounds=[],foregrounds=[];
    for(const key of keys){
      const slot=key.startsWith('source:')?slots[Number(key.slice(7))]:null;
      const part=key.startsWith('part:')?parts.find(item=>item.id===key.slice(5)):null;
      const component=part&&svgPartModule().get(part.templateId)?.components?.find(item=>item.id===part.componentId);
      const source=slot&&sources.get(slot.sourceId);
      (source&&(source.initialLayer==='background'||source.config?.designAsset?.placement==='background')||component?.type==='background'?backgrounds:foregrounds).push(key);
    }
    return [...backgrounds,...foregrounds];
  }
  function freeLayers(scene) {
    if(!scene)return [];
    const owned=new Set((scene.svgParts||[]).map(part=>part.sourceSlot));
    const rows=[...scene.slots.flatMap((slot,index)=>owned.has(index)?[]:[{key:'source:'+index,index,slot}]),
      ...(scene.svgParts||[]).map(part=>({key:'part:'+part.id,part}))];
    const keys=new Set(rows.map(row=>row.key)),ordered=[...new Set((scene.freeOrder||[]).filter(key=>keys.has(key)))];
    for(const row of rows)if(!ordered.includes(row.key))ordered.push(row.key);
    return ordered.map(key=>rows.find(row=>row.key===key));
  }
  /* Read-only inventory for the Sources dock. The compositor keeps its original
     freeLayers contract; selecting template/overlay rows never splits artwork,
     starts a renderer, recalls shared assets or changes the held Programme.
     Rows are bottom-to-top. `included` describes configured compositing, not
     whether a live source or image has decoded its next frame. */
  function sceneContents(scene) {
    if(!scene)return [];
    const templates=window.OpenLiveFullTemplates,extras=sceneExtrasEnabled(scene),rows=[];
    const read=(object,name,...args)=>{try{return typeof object?.[name]==='function'?object[name](...args):null;}catch(_){return null;}};
    const template=id=>read(templates,'get',id);
    const content=(row,hidden=false,why='')=>({...row,hidden:!!hidden,included:!hidden&&!why,why:why||(hidden?'Hidden in this scene.':'')});
    const extra=(row,hidden=false,why='')=>content(row,hidden,!extras?'Additional scene layers are disabled for this artwork.'+(why?' '+why:''):why);
    const binding=index=>{const slot=scene.slots?.[index],boundSource=sceneSource(scene,slot?.sourceId)||null;
      return {index,boundSlot:slot||null,sourceId:slot?.sourceId||null,boundSource,boundLabel:slot?.label||boundSource?.label||'Empty',boundHidden:!!slot?.hidden};};
    const source=(slot,index,why='')=>content({key:'source:'+index,kind:'source',index,slot,sourceId:slot.sourceId||null,
      label:slot.label||sceneSource(scene,slot.sourceId)?.label||'Empty source '+(index+1)},slot.hidden||slot.creative?.opacity===0,why||(slot.arrangementUnplaced?'This source keeps its binding outside the current arrangement.':''));
    const part=item=>{const record=template(item.templateId),component=record?.components?.find(c=>c.id===item.componentId),
      change=item.style?.components?.[item.componentId]||{},feed=Number.isInteger(item.sourceSlot)?binding(item.sourceSlot):null;
      return content({key:'part:'+item.id,kind:'part',part:item,templateId:item.templateId,componentId:item.componentId,component,
        label:(component?.label||'Missing artwork layer')+(feed?' · '+feed.boundLabel:''),...(feed||{})},
        change.visible===false||change.opacity===0||item.creative?.opacity===0,component?'':'The native artwork component is unavailable.');};
    // A checkpoint is authoritative, including explicit empty selections. Never
    // call activeRenderInfo with graphicsState: that accessor can begin decoding.
    const graphics=window.OpenLiveGraphics,graphicRows={};
    for(const type of ['background','overlay','logo']){
      let asset,info;
      if(scene.renderState?.graphics){
        asset=scene.renderState.graphics[type];
        if(asset){const image=scene.renderState.graphics._images?.[type];info={id:asset.id,type,name:asset.name,
          state:asset.builtin?'ready':image?.state||'idle',error:image?.error||''};}
      }else{
        info=read(graphics,'activeRenderInfo',type,{sceneId:scene.id});
        asset=info;
        // The small render metadata is sufficient for selection. Avoid copying
        // an uploaded image's data URL each time the dock refreshes.
        if(typeof graphics?.activeRenderInfo!=='function'){
          asset=read(graphics,'activeStatus',{sceneId:scene.id})?.[type];if(asset)info={id:asset.id,type,name:asset.name,state:'idle'};
        }
      }
      if(asset)graphicRows[type]=extra({key:'graphics:'+type,kind:'graphics',type,assetId:asset.id,asset,info,
        label:asset.name||({background:'Background',overlay:'Graphic overlay',logo:'Logo'})[type]},false,!graphics?'The graphics renderer is unavailable.':'');
    }
    const captions=window.OpenLiveCaptions,captionStatus=scene.renderState?.captions||read(captions,'activeStatus')||{},
      commerce=window.OpenLiveCommerce,commerceStatus=scene.renderState?.commerce?.status||read(commerce,'activeStatus')||{},
      overlays=scene.overlays||{};
    const overlayRows=[];
    for(const widget of scene.widgets||[]){
      const asset=scene.renderState?.widgets?scene.renderState.widgets[widget.assetId]:read(window.OpenLiveWidgets,'get',widget.assetId);
      overlayRows.push(extra({key:'widget:'+widget.id,kind:'widget',widget,assetId:widget.assetId,asset,
        label:asset?.name||'Missing browser widget'},widget.visible===false||Number(widget.opacity)===0,
        !window.OpenLiveWidgets?'The widget renderer is unavailable.':!asset?'The browser widget definition is unavailable.':''));
    }
    if(graphicRows.overlay)overlayRows.push(graphicRows.overlay);
    const lower=overlays.lower;
    if(lower&&(lower.on||lower.line1||lower.line2))overlayRows.push(extra({key:'native:lower',kind:'native',type:'lower',overlay:lower,
      label:'Lower third'+(lower.line1?' · '+lower.line1:'')},!lower.on,
      captions&&typeof captions.activeStatus==='function'&&captionStatus.lowerThird?'Superseded by the selected caption lower third.':
        !lower.line1&&!lower.line2?'Enter lower third text.':''));
    const logo=overlays.logo,graphicsLogo=graphics&&graphicRows.logo?.info;
    if(logo&&(logo.on||logo.dataUrl))overlayRows.push(extra({key:'native:logo',kind:'native',type:'logo',overlay:logo,label:'Scene logo'},!logo.on,
      graphicsLogo&&graphicsLogo.state!=='error'?'Superseded by the selected graphic logo.':!logo.dataUrl&&!logo._img?'Choose a logo image.':''));
    const countdown=overlays.countdown;
    if(countdown&&(countdown.on||countdown.endsAt))overlayRows.push(extra({key:'native:countdown',kind:'native',type:'countdown',overlay:countdown,label:'Countdown'},
      !countdown.on,!countdown.endsAt?'Set the countdown end time.':''));
    for(const type of ['lowerThird','ticker']){
      const asset=captionStatus[type];
      if(asset)overlayRows.push(extra({key:'caption:'+type,kind:'caption',type,assetId:asset.id,asset,
        label:asset.name||(type==='ticker'?'Ticker':'Caption lower third')},false,!captions?'The captions renderer is unavailable.':''));
    }
    if(commerceStatus.asset||commerceStatus.type||commerceStatus.state==='armed'||commerceStatus.state==='visible'){
      const asset=commerceStatus.asset,type=asset?.type||commerceStatus.type||'active';
      overlayRows.push(extra({key:'commerce:'+type,kind:'commerce',type,assetId:asset?.id,asset,info:commerceStatus,
        label:asset?.name||(type==='product'?'Live sales':'QR card')},commerceStatus.state==='hidden',
        !commerce?'The commerce renderer is unavailable.':commerceStatus.state==='armed'?'Waiting for a commerce target.':''));
    }
    if(graphicRows.logo)overlayRows.push(graphicRows.logo);
    if(graphicRows.background)rows.push(graphicRows.background);
    const slots=scene.slots||[],parts=scene.svgParts||[];
    if(scene.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only'){
      rows.push(...freeLayers(scene).map(row=>row.slot?source(row.slot,row.index):part(row.part)),...overlayRows);
    }else if(scene.svgParts!==undefined){
      const owned=new Set(parts.map(item=>item.sourceSlot)),ordinary=slots.flatMap((slot,index)=>owned.has(index)?[]:[source(slot,index,
        scene.svgPartsMode==='parts-only'?'Sources outside SVG feed frames are not drawn in this scene.':
          index>=rects(scene.layout,'16x9').length?'This source is outside the current layout.':'')]);
      let prefix=0;
      if(scene.svgPartsMode==='overlay'){
        while(prefix<parts.length&&template(parts[prefix].templateId)?.components?.find(c=>c.id===parts[prefix].componentId)?.type==='background')rows.push(part(parts[prefix++]));
        rows.push(...ordinary,...overlayRows,...parts.slice(prefix).map(part));
      }else rows.push(...ordinary,...parts.map(part),...overlayRows);
    }else if(scene.fullTemplateId){
      const record=template(scene.fullTemplateId),components=record?.components,
        canonical=read(templates,'normalizeStyle',scene.fullTemplateId,scene.fullTemplateStyle||{}),componentMode=!!canonical?.components;
      if(!components?.length)rows.push(content({key:'template:missing',kind:'template',templateId:scene.fullTemplateId,
        label:record?.name||'Missing template · '+scene.fullTemplateId},false,'The native template component catalogue is unavailable.'));
      // The component compositor interleaves feeds at native catalogue order.
      // Legacy whole-art rendering paints all authored artwork first, then
      // media/frame groups in frame-index order. Listing must reflect that
      // existing distinction without converting or repainting the scene.
      const nativeOrder=[...(components||[])].sort((a,b)=>a.order-b.order),paintOrder=componentMode?nativeOrder:
        [...nativeOrder.filter(component=>!Number.isInteger(component.frameIndex)),
          ...nativeOrder.filter(component=>Number.isInteger(component.frameIndex)).sort((a,b)=>a.frameIndex-b.frameIndex)];
      for(const component of paintOrder){
        const item=scene.contentItems?.['template:'+component.id];if(item?.removed)continue;
        const change=scene.fullTemplateStyle?.components?.[component.id]||{},feed=Number.isInteger(component.frameIndex)?binding(component.frameIndex):null;
        const row=content({key:'template:'+component.id,kind:'template',templateId:record.id,componentId:component.id,component,
          label:(item?.label||component.label)+(feed?' · '+feed.boundLabel:''),...(feed||{}),locked:!!item?.locked},change.visible===false||change.opacity===0);
        if(feed&&!componentMode&&row.included)row.why='The feed and restored native frame border are drawn above the original artwork.';
        rows.push(row);
      }
      const owned=new Set((components||[]).filter(c=>Number.isInteger(c.frameIndex)).map(c=>c.frameIndex));
      rows.push(...slots.flatMap((slot,index)=>owned.has(index)?[]:[source(slot,index,'This source has no native template feed frame.')]),...overlayRows);
    }else rows.push(...slots.map((slot,index)=>source(slot,index,index>=rects(scene.layout,'16x9').length?'This source is outside the current layout.':'')),...overlayRows);
    return rows;
  }
  // Studio content is a scene placement. A native feed keeps its authored frame
  // when cleared, and a removed artwork component is suppressed only in this
  // scene; the reusable SVG catalogue and held Programme are never edited.
  const sceneContentHistories=new Map(),sceneContentFields=['slots',...svgPartFields];
  function normalizeContentItems(raw,template){
    sceneSettingsObject(raw,Object.keys(raw||{}),'scene content items');
    if(Object.keys(raw).length>32)throw Error('A template supports up to 32 content item settings.');
    const next={};
    for(const [key,item] of Object.entries(raw)){
      if(!key.startsWith('template:')||!template?.components?.some(component=>'template:'+component.id===key))throw Error('Choose an existing native template component.');
      sceneSettingsObject(item,['locked','removed','label'],'scene content item');
      if(['locked','removed'].some(name=>item[name]!==undefined&&typeof item[name]!=='boolean'))throw Error('Invalid scene content state.');
      if(item.label!==undefined&&(typeof item.label!=='string'||!item.label.trim()||item.label.trim().length>120||/[\u0000-\u001f]/.test(item.label)))throw Error('Use an item name of 1–120 characters.');
      next[key]={...item,...(item.label!==undefined?{label:item.label.trim()}:{})};
    }
    return next;
  }
  const sceneContentState=scene=>JSON.parse(svgPartFingerprint(Object.fromEntries(sceneContentFields.filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]]))));
  function sceneContentCapabilities(scene,key){
    const row=sceneContents(scene).find(item=>item.key===key),slot=row?.slot||row?.boundSlot,
      native=!!row?.boundSlot,locked=!!slot?.locked||!!row?.part?.locked||!!row?.locked,
      supported=!!row&&(!!slot||!!row.part||row.kind==='template'&&!!row.component),
      audio=!!sceneSource(scene,slot?.sourceId)?.audioOnly,free=scene?.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only',
      reorder=free&&!!row&&freeLayers(scene).some(item=>item.key===key)&&!locked,
      reasons={},result={edit:!!row&&!locked,hide:supported,lock:supported,remove:supported&&!locked&&(!native||!!slot?.sourceId),
        autosize:!!slot&&!audio&&!locked,reorder,locked,native,fixed:!free||native,reasons};
    if(!supported)for(const action of ['hide','lock','remove','autosize','reorder'])reasons[action]='This item is managed by its existing editor.';
    if(locked)for(const action of ['edit','remove','autosize','reorder'])reasons[action]='Unlock this item before changing it.';
    if(native&&!slot.sourceId)reasons.remove='This native frame is empty. Its artwork remains available for a new source.';
    if(!slot)reasons.autosize='Auto Size applies to picture sources.';else if(audio)reasons.autosize='Audio-only sources have no picture to resize.';
    if(!reorder&&!locked)reasons.reorder='This item uses the template’s authored paint order. Use Arrange to create an editable layer stack.';
    return result;
  }
  function sceneContentTarget(sceneId,key,{expected,isCurrent=()=>true}={}){
    const scene=svgPartScene(sceneId),row=sceneContents(scene).find(item=>item.key===key);
    if(!row||scene.layoutPending||!isCurrent())throw Error('The selected scene item changed. Select it again.');
    const item=row.slot||row.boundSlot||row.part||row.component;
    if(expected){
      if(expected.key!==undefined){
        if(expected.key!==row.key||expected.slot!==row.slot||expected.boundSlot!==row.boundSlot||expected.part!==row.part||expected.component!==row.component||
          expected.hidden!==row.hidden||expected.locked!==row.locked||expected.sourceId!==row.sourceId)throw Error('The selected scene item changed. Select it again.');
      }else if(expected!==item)throw Error('The selected scene item changed. Select it again.');
    }
    return {scene,row,item,capabilities:sceneContentCapabilities(scene,key),fingerprint:svgPartFingerprint(scene),isCurrent};
  }
  function commitSceneContent(target,next,label){
    verifySvgPartCommit(target.scene,target.fingerprint,{isCurrent:target.isCurrent});
    const before=sceneContentState(target.scene),after=sceneContentState(next);
    if(svgPartFingerprint(before)===svgPartFingerprint(after))return true;
    const patch=Object.fromEntries(sceneContentFields.map(key=>[key,Object.hasOwn(next,key)?next[key]:undefined]));
    commitFree(target.scene,patch);
    const history=sceneContentHistories.get(target.scene.id)||{undo:[],redo:[]};history.undo.push({before,after,label});
    history.undo=history.undo.slice(-20);history.redo=[];sceneContentHistories.set(target.scene.id,history);
    svgPartRenderErrors.delete(target.scene.id);return true;
  }
  async function updateSceneContent(sceneId,key,patch,options={}){
    const target=sceneContentTarget(sceneId,key,options),{scene,row,capabilities}=target;
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(name=>!['hidden','locked','label','outputFit','inputSelection'].includes(name)))throw Error('Unsupported scene item setting.');
    if(['hidden','locked'].some(name=>patch[name]!==undefined&&typeof patch[name]!=='boolean'))throw Error('Invalid scene item state.');
    if(patch.label!==undefined&&(typeof patch.label!=='string'||!patch.label.trim()||patch.label.trim().length>120||/[\u0000-\u001f]/.test(patch.label)))throw Error('Use an item name of 1–120 characters.');
    if(Object.hasOwn(patch,'hidden')&&!capabilities.hide||Object.hasOwn(patch,'locked')&&!capabilities.lock)throw Error('This item must be changed in its existing editor.');
    if(Object.keys(patch).some(name=>!['hidden','locked'].includes(name))&&capabilities.locked)throw Error('Unlock this item before changing it.');
    const next={...scene,slots:scene.slots.slice()},slot=row.slot||row.boundSlot;
    if(slot){
      const updated={...slot};
      for(const name of ['hidden','locked','label'])if(patch[name]!==undefined)updated[name]=name==='label'?patch[name].trim():patch[name];
      if(Object.hasOwn(patch,'outputFit')){if(!capabilities.autosize)throw Error(capabilities.reasons.autosize);updated.outputFit=normalizeOutputFit(patch.outputFit);}
      if(Object.hasOwn(patch,'inputSelection')){if(sceneSource(scene,slot.sourceId)?.audioOnly)throw Error('Audio-only sources have no Input Selection.');updated.inputSelection=normalizeInputSelection(patch.inputSelection);}
      next.slots[row.index]=updated;
      if(patch.locked!==undefined&&row.part)next.svgParts=scene.svgParts.map(part=>part.id===row.part.id?normalizeSceneSvgPart({...part,locked:patch.locked},next.slots):part);
      if(patch.locked!==undefined&&row.kind==='template'&&scene.contentItems?.[key])next.contentItems={...scene.contentItems,[key]:{...scene.contentItems[key],locked:patch.locked}};
    }else if(row.part){
      if(Object.hasOwn(patch,'outputFit')||Object.hasOwn(patch,'inputSelection')||Object.hasOwn(patch,'label'))throw Error('These settings apply to picture sources.');
      const change={...(row.part.style.components?.[row.part.componentId]||{})};if(Object.hasOwn(patch,'hidden'))change.visible=!patch.hidden;
      const part=normalizeSceneSvgPart({...row.part,...(patch.locked!==undefined?{locked:patch.locked}:{}),style:{...row.part.style,components:{[row.part.componentId]:change}}},next.slots);
      next.svgParts=scene.svgParts.map(item=>item.id===part.id?part:item);await prepareSvgParts(next);
    }else if(row.kind==='template'&&row.component){
      if(Object.hasOwn(patch,'outputFit')||Object.hasOwn(patch,'inputSelection'))throw Error('These settings apply to picture sources.');
      const items={...(scene.contentItems||{})},item={...(items[key]||{})};
      if(patch.locked!==undefined)item.locked=patch.locked;if(patch.label!==undefined)item.label=patch.label.trim();items[key]=item;
      next.contentItems=normalizeContentItems(items,svgPartModule().get(row.templateId));
      if(Object.hasOwn(patch,'hidden')){
        next.fullTemplateStyle=fullTemplateStyle(row.templateId,{...(scene.fullTemplateStyle||{}),components:{...(scene.fullTemplateStyle?.components||{}),[row.componentId]:{...(scene.fullTemplateStyle?.components?.[row.componentId]||{}),visible:!patch.hidden}}});
        await svgPartModule().load(row.templateId,{style:next.fullTemplateStyle,retry:true});
      }
    }else throw Error('This item must be changed in its existing editor.');
    return commitSceneContent(target,next,'Update scene item');
  }
  async function removeSceneContent(sceneId,key,options={}){
    const target=sceneContentTarget(sceneId,key,options),{scene,row,capabilities}=target;
    if(!capabilities.remove)throw Error(capabilities.reasons.remove||'This item cannot be removed.');
    const next={...scene,slots:scene.slots.slice()};
    if(row.boundSlot){
      const slot={...row.boundSlot,sourceId:null};for(const name of ['label','effects','generator','inputSelection'])delete slot[name];next.slots[row.index]=slot;
    }else if(row.slot&&scene.layout!=='free'){
      const slot={...row.slot,sourceId:null};for(const name of ['label','effects','generator','inputSelection'])delete slot[name];next.slots[row.index]=slot;
    }else if(row.slot){
      const index=row.index;next.slots=scene.slots.filter((_,i)=>i!==index);
      next.freeOrder=freeLayers(scene).map(item=>item.key).filter(item=>item!==key).map(item=>item.startsWith('source:')&&Number(item.slice(7))>index?'source:'+(Number(item.slice(7))-1):item);
      if(scene.svgParts)next.svgParts=scene.svgParts.map(part=>Number.isInteger(part.sourceSlot)&&part.sourceSlot>index?normalizeSceneSvgPart({...part,sourceSlot:part.sourceSlot-1},next.slots):part);
    }else if(row.part){next.svgParts=scene.svgParts.filter(part=>part.id!==row.part.id);if(scene.freeOrder)next.freeOrder=scene.freeOrder.filter(item=>item!==key);}
    else if(row.kind==='template'&&row.component){
      next.contentItems=normalizeContentItems({...scene.contentItems,[key]:{...(scene.contentItems?.[key]||{}),removed:true}},svgPartModule().get(row.templateId));
      next.fullTemplateStyle=fullTemplateStyle(row.templateId,{...(scene.fullTemplateStyle||{}),components:{...(scene.fullTemplateStyle?.components||{}),[row.componentId]:{...(scene.fullTemplateStyle?.components?.[row.componentId]||{}),visible:false}}});
      await svgPartModule().load(row.templateId,{style:next.fullTemplateStyle,retry:true});
    }else throw Error('This item must be removed in its existing editor.');
    return commitSceneContent(target,next,row.boundSlot?'Clear source from native frame':'Remove scene item');
  }
  function sceneContentHistory(sceneId){const history=sceneContentHistories.get(sceneId);return {canUndo:!!history?.undo.length,canRedo:!!history?.redo.length,
    undoLabel:history?.undo.at(-1)?.label||'',redoLabel:history?.redo.at(-1)?.label||''};}
  async function stepSceneContentHistory(sceneId,redo=false,{isCurrent=()=>true}={}){
    const scene=svgPartScene(sceneId),history=sceneContentHistories.get(sceneId),from=history?.[redo?'redo':'undo'],entry=from?.at(-1);if(!entry)return false;
    const expected=redo?entry.before:entry.after,next=JSON.parse(svgPartFingerprint(redo?entry.after:entry.before)),fingerprint=svgPartFingerprint(scene);
    const check=()=>{if(!isCurrent()||svgPartFingerprint(sceneContentState(scene))!==svgPartFingerprint(expected)||from.at(-1)!==entry)throw Error('The scene items changed after that edit. Undo was not applied.');};check();
    if(next.slots.some(slot=>slot.sourceId&&!sources.has(slot.sourceId)))throw Error('A previous source is no longer available.');
    if(next.svgParts)await prepareSvgParts({...scene,...next});else if(next.fullTemplateId)await svgPartModule().load(next.fullTemplateId,{style:next.fullTemplateStyle||{},retry:true});
    check();verifySvgPartCommit(scene,fingerprint,{isCurrent});
    commitFree(scene,Object.fromEntries(sceneContentFields.map(key=>[key,Object.hasOwn(next,key)?next[key]:undefined])));
    svgPartRenderErrors.delete(scene.id);from.pop();history[redo?'undo':'redo'].push(entry);return true;
  }
  const undoSceneContent=(sceneId,options)=>stepSceneContentHistory(sceneId,false,options),redoSceneContent=(sceneId,options)=>stepSceneContentHistory(sceneId,true,options);
  const creativeHistories=new Map();
  function recordCreativeHistory(scene,key,before,after){
    // History must not share mutable slots with Preview: bind/gain/mute can
    // change an existing slot in place, and must remain detectable as stale.
    const history=creativeHistories.get(scene.id)||{undo:[],redo:[]};
    history.undo.push({key,before:JSON.parse(svgPartFingerprint(before)),after:JSON.parse(svgPartFingerprint(after))});
    history.undo=history.undo.slice(-20);history.redo=[];creativeHistories.set(scene.id,history);
  }
  function creativeModule(){if(!window.OpenLiveCreative)throw Error('Creative controls did not load. Reload while off air.');return window.OpenLiveCreative;}
  function effectsModule(){if(!window.OpenLiveEffects)throw Error('The shared Effects & Generators renderer did not load.');return window.OpenLiveEffects;}
  function nativePartRectNormalized(part,cv={width:1920,height:1080}){
    const template=svgPartModule().get(part.templateId),bounds=template.components.find(c=>c.id===part.componentId).bounds;
    const change=part.style.components?.[part.componentId]||{},scale=change.scale??1;
    const fitScale=Math.min(cv.width/template.width,cv.height/template.height),bw=template.width*fitScale/cv.width,bh=template.height*fitScale/cv.height;
    const w=bounds.w*scale*(change.scaleX??1)*bw,h=bounds.h*scale*(change.scaleY??1)*bh;
    return {x:(1-bw)/2+(bounds.x+bounds.w/2+(change.x||0))*bw-w/2,y:(1-bh)/2+(bounds.y+bounds.h/2+(change.y||0))*bh-h/2,w,h,rotation:change.rotation||0};
  }
  function mappedArrangementRect(rect,from,to){
    const angle=(to.rotation||0)-(from.rotation||0),dx=rect.x+rect.w/2-from.x-from.w/2,dy=rect.y+rect.h/2-from.y-from.h/2,
      radians=-(from.rotation||0)*Math.PI/180,sx=to.w/from.w,sy=to.h/from.h,
      px=(dx*Math.cos(radians)-dy*Math.sin(radians))*sx,py=(dx*Math.sin(radians)+dy*Math.cos(radians))*sy,rotate=(to.rotation||0)*Math.PI/180,
      w=rect.w*sx,h=rect.h*sy;
    return {x:to.x+to.w/2+px*Math.cos(rotate)-py*Math.sin(rotate)-w/2,
      y:to.y+to.h/2+px*Math.sin(rotate)+py*Math.cos(rotate)-h/2,w,h,rotation:(rect.rotation||0)+angle};
  }
  function partRectNormalized(part,cv={width:1920,height:1080}){
    const rect=nativePartRectNormalized(part,cv),pose=part.arrangement;return pose?mappedArrangementRect(rect,arrangementPartFrom(part,cv),pose.to):rect;
  }
  // Selection guides share the compositor's scene-owned geometry. This is a
  // read-only query: selecting native artwork must never split it, load its
  // pixels, save a scene, or replace a held Programme runtime.
  function sceneContentBounds(scene,key,aspect='16x9'){
    if(!scene||typeof key!=='string')return null;
    const row=sceneContents(scene).find(item=>item.key===key);if(!row)return null;
    const size=ASPECTS[aspect]||ASPECTS['16x9'],cv={width:size.w,height:size.h};
    let rect,item,editable=false;
    try{
      if(row.slot){
        const source=sceneSource(scene,row.slot.sourceId);
        if(source?.audioOnly||row.slot.arrangementUnplaced||scene.fullTemplateId||scene.svgPartsMode==='parts-only'||
          scene.layout!=='free'&&row.index>=rects(scene.layout,aspect).length)return null;
        item=row.slot;rect=sourceRectNormalized(scene,row.index,aspect);editable=scene.layout==='free';
      }else if(row.part){
        if(!row.component)return null;
        item=row.part;rect=partRectNormalized(item,cv);
        editable=scene.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only';
      }else if(row.kind==='template'&&row.component){
        // Complete-template pieces use the same contained board and component
        // pose as independent pieces, while their original identity stays intact.
        rect=nativePartRectNormalized({templateId:row.templateId,componentId:row.componentId,
          style:fullTemplateStyle(row.templateId,scene.fullTemplateStyle)},cv);
      }else return null;
    }catch(_){return null;}
    if(!['x','y','w','h','rotation'].every(name=>Number.isFinite(rect[name]))||rect.w<=0||rect.h<=0)return null;
    const locked=!!item?.locked||!!row.boundSlot?.locked||!!row.locked;
    return {rect:{...rect},locked,hidden:!!row.hidden,label:row.label,editable:editable&&!locked};
  }
  function arrangementPartFrom(part,cv){
    const from=part.arrangement.from,template=svgPartModule().get(part.templateId),board=canvas=>{
      const scale=Math.min(canvas.width/template.width,canvas.height/template.height),w=template.width*scale/canvas.width,h=template.height*scale/canvas.height;
      return {x:(1-w)/2,y:(1-h)/2,w,h};
    },reference=board({width:1920,height:1080}),output=board(cv);
    return {...from,x:output.x+(from.x-reference.x)*output.w/reference.w,y:output.y+(from.y-reference.y)*output.h/reference.h,
      w:from.w*output.w/reference.w,h:from.h*output.h/reference.h};
  }
  function drawSceneSvgPart(part,ctx,cv,scene,timeMs=0,rawSlotCreative=false){
    const slot=Number.isInteger(part.sourceSlot)&&scene.slots[part.sourceSlot];
    // Style the completed native feed and its authored frame in output space.
    // The inner feed bypasses this same style; its fitting and native clips stay.
    if(slot?.creative&&!rawSlotCreative)return creativeModule().paint(ctx,cv,partRectNormalized(part,cv),slot.creative,timeMs,
      layer=>drawSceneSvgPart(part,layer,cv,scene,timeMs,true));
    const pose=part.arrangement,from=pose?arrangementPartFrom(part,cv):null,sx=pose?pose.to.w/from.w:1,sy=pose?pose.to.h/from.h:1,
      change=part.style.components?.[part.componentId]||{};
    if(pose){const {to}=pose;ctx.save();ctx.translate((to.x+to.w/2)*cv.width,(to.y+to.h/2)*cv.height);
      ctx.rotate((to.rotation||0)*Math.PI/180);ctx.scale(sx,sy);ctx.rotate(-(from.rotation||0)*Math.PI/180);
      ctx.translate(-(from.x+from.w/2)*cv.width,-(from.y+from.h/2)*cv.height);}
    try{return svgPartModule().drawPart(part.templateId,part.componentId,ctx,cv,part.style,
      (_index,feedContext,frame)=>Number.isInteger(part.sourceSlot)&&paintSource(feedContext,cv,scene,
        {...frame,...(pose?{postScaleX:sx*(frame.unposed?(change.scale??1)*(change.scaleX??1):1),
          postScaleY:sy*(frame.unposed?(change.scale??1)*(change.scaleY??1):1)}:{})},part.sourceSlot,part.templateId,timeMs,rawSlotCreative),{timeMs});}
    finally{if(pose)ctx.restore();}
  }
  function creativeLayer(sceneId,key){
    const scene=svgPartScene(sceneId);let row=freeLayers(scene).find(r=>r.key===key),nativeRow;
    if(key.startsWith('source:')){
      const index=Number(key.slice(7));nativeRow=sceneContents(scene).find(item=>item.index===index&&item.boundSlot);
      if(nativeRow)row={key,index,slot:nativeRow.boundSlot};
    }
    if(!row)throw Error('Select an existing scene layer.');
    const item=row.slot||row.part,source=row.slot&&sources.get(row.slot.sourceId),creative=creativeModule().normalize(item.creative);
    if(row.part){const change=row.part.style.components?.[row.part.componentId]||{};creative.opacity*=change.opacity??1;creative.flipX=!!change.flipX!==creative.flipX;creative.flipY=!!change.flipY!==creative.flipY;}
    return {scene,key,row,item,creative,source,nativeRow,rect:nativeRow?sceneContentBounds(scene,nativeRow.key)?.rect:row.slot?sourceRectNormalized(scene,row.index):partRectNormalized(row.part),
      label:row.slot?(row.slot.label||source?.label||'Source'):svgPartModule().get(row.part.templateId).components.find(c=>c.id===row.part.componentId).label,
      locked:!!item.locked||sceneContents(scene).some(entry=>entry.index===row.index&&(entry.part?.locked||entry.locked)),audioOnly:!!source?.audioOnly,native:!!nativeRow};
  }
  async function editCreativeLayer(sceneId,key,patch,{isCurrent=()=>true,expected,history='creative'}={}){
    const target=creativeLayer(sceneId,key),{scene,row,item}=target;
    if(history!=='creative'&&(history!=='svg'||!row.part))throw Error('Choose creative history for sources or SVG history for native artwork.');
    if(target.locked)throw Error('Unlock this layer before editing it.');
    if(target.audioOnly)throw Error('Audio-only sources have no picture to edit.');
    if(row.slot&&(scene.layout!=='free'||target.native)&&Object.keys(patch||{}).some(key=>!(target.native?['effects','generator','inputSelection','outputFit','sourceId']:['effects','generator']).includes(key)))throw Error('Use Free canvas to edit this source layer.');
    if(expected&&expected!==item||!isCurrent())throw Error('The selected layer changed. Open the tool again.');
    if(!patch||Object.keys(patch).some(k=>!['creative','transform','inputSelection','outputFit','effects','generator','sourceId'].includes(k)))throw Error('Unsupported creative edit.');
    let next={...item};
    if(Object.hasOwn(patch,'effects')){if(!row.slot)throw Error('Select a picture source to apply effects.');next.effects=effectsModule().normalizeEffects(patch.effects);}
    if(Object.hasOwn(patch,'generator')){if(!row.slot||target.source?.sourceType!=='generator')throw Error('Select a generator source.');next.generator=effectsModule().normalizeGenerator(patch.generator);}
    if(Object.hasOwn(patch,'inputSelection')){
      if(!row.slot)throw Error('Input Selection applies to picture sources.');
      const selection=normalizeInputSelection(patch.inputSelection);
      if(selection.x===0&&selection.y===0&&selection.w===1&&selection.h===1)delete next.inputSelection;
      else next.inputSelection=selection;
    }
    if(Object.hasOwn(patch,'outputFit')){
      if(!row.slot)throw Error('Output scaling applies to picture sources.');
      const mode=normalizeOutputFit(patch.outputFit);
      if(mode==='contain'&&!target.native)delete next.outputFit;else next.outputFit=mode;
    }
    if(patch.creative){
      const changes={...patch.creative};
      if(row.part){
        const component={...(item.style.components?.[item.componentId]||{})};
        for(const name of ['opacity','flipX','flipY'])if(changes[name]!==undefined){component[name]=changes[name];changes[name]=name==='opacity'?1:false;}
        next.style={...item.style,components:{[item.componentId]:component}};
      }
      next.creative=creativeModule().merge(item.creative,changes);
    }
    if(patch.transform){
      const r=freeTransform(patch.transform);
      if(row.slot)next.transform=r;
      else if(item.arrangement)next.arrangement={from:nativePartRectNormalized(next),to:r};
      else{const component=svgPartModule().get(item.templateId).components.find(c=>c.id===item.componentId),b=component.bounds;
        next.style={...next.style,components:{[item.componentId]:{...(next.style.components?.[item.componentId]||{}),
          x:r.x+r.w/2-b.x-b.w/2,y:r.y+r.h/2-b.y-b.h/2,scale:1,scaleX:r.w/b.w,scaleY:r.h/b.h,rotation:r.rotation>180?r.rotation-360:r.rotation}}};
      }
    }
    if(patch.sourceId!==undefined){if(!row.slot||!sources.has(patch.sourceId)||sources.get(patch.sourceId).audioOnly)throw Error('Choose an available picture source.');next.sourceId=patch.sourceId;
      if(sources.get(patch.sourceId).sourceType==='generator')next.generator=effectsModule().normalizeGenerator(sources.get(patch.sourceId).config);else delete next.generator;}
    const fingerprint=svgPartFingerprint(item);
    if(row.part){next=normalizeSceneSvgPart(next,scene.slots);await prepareSvgParts({...scene,svgParts:[next]});}
    const current=creativeLayer(sceneId,key);
    if(!isCurrent()||current.item!==item||svgPartFingerprint(current.item)!==fingerprint)throw Error('The selected layer changed. Nothing was applied.');
    if(history==='svg')commitSvgParts(scene,{...svgPartSnapshot(scene),svgParts:Object.freeze(scene.svgParts.map(p=>p.id===item.id?next:p))},'Edit SVG layer');
    else commitFree(scene,row.slot?{slots:scene.slots.map((s,i)=>i===row.index?next:s)}:{svgParts:scene.svgParts.map(p=>p.id===item.id?next:p)});
    svgPartRenderErrors.delete(scene.id);
    if(history!=='svg')recordCreativeHistory(scene,key,item,next);return next;
  }
  function creativeHistory(sceneId){const h=creativeHistories.get(sceneId);return {canUndo:!!h?.undo.length,canRedo:!!h?.redo.length};}
  function sourceEffectTarget(sceneId,index){const target=creativeLayer(sceneId,'source:'+index);if(!target.source||target.audioOnly)throw Error('Select an available picture source.');return target;}
  async function addSourceEffect(sceneId,index,name,options={}){
    const target=sourceEffectTarget(sceneId,index),effect=effectsModule().defaultsEffect(name);
    await editCreativeLayer(sceneId,target.key,{effects:[...(target.item.effects||[]),effect]},options);return effect;
  }
  async function updateSourceEffect(sceneId,index,id,patch,options={}){
    const target=sourceEffectTarget(sceneId,index),chain=target.item.effects||[],effect=chain.find(item=>item.id===id);
    if(!effect)throw Error('This effect is no longer available.');
    if(!patch||Object.keys(patch).some(key=>!['bypassed','opacity','blend','params'].includes(key)))throw Error('Unsupported effect setting.');
    if(patch.params)effectsModule().validateParameterPatch('effect',effect.name,patch.params);
    const next={...effect,...patch,params:{...effect.params,...patch.params}};
    return editCreativeLayer(sceneId,target.key,{effects:chain.map(item=>item.id===id?next:item)},options);
  }
  async function removeSourceEffect(sceneId,index,id,options={}){
    const target=sourceEffectTarget(sceneId,index),chain=target.item.effects||[];if(!chain.some(item=>item.id===id))throw Error('This effect is no longer available.');
    return editCreativeLayer(sceneId,target.key,{effects:chain.filter(item=>item.id!==id)},options);
  }
  async function moveSourceEffect(sceneId,index,id,delta,options={}){
    const target=sourceEffectTarget(sceneId,index),chain=(target.item.effects||[]).slice(),at=chain.findIndex(item=>item.id===id);
    if(at<0||![-1,1].includes(delta))throw Error('Choose an adjacent effect position.');
    const to=at+delta;if(to<0||to>=chain.length)return false;[chain[at],chain[to]]=[chain[to],chain[at]];
    return editCreativeLayer(sceneId,target.key,{effects:chain},options);
  }
  async function updateGeneratorSource(sceneId,index,patch,options={}){
    const target=sourceEffectTarget(sceneId,index),previous=target.item.generator||target.source.config;
    if(target.source.sourceType!=='generator')throw Error('Select a generator source.');
    if(!patch||Object.keys(patch).some(key=>!['params','duration','bpm'].includes(key)))throw Error('Unsupported generator setting.');
    if(patch.params)effectsModule().validateParameterPatch('generator',previous.name,patch.params);
    return editCreativeLayer(sceneId,target.key,{generator:{...previous,...patch,params:{...previous.params,...patch.params}}},options);
  }
  async function addGeneratorSource(sceneId,name,{isCurrent=()=>true,slotIndex}={}){
    const scene=svgPartScene(sceneId);if(scene.layoutPending||!isCurrent())throw Error('Choose the current scene before adding a generator.');
    const config=effectsModule().defaultsGenerator(name),fingerprint=svgPartFingerprint(scene);
    let empty=slotIndex===undefined?scene.slots.findIndex(slot=>!slot.sourceId&&!slot.locked):slotIndex;
    if(empty>=0&&(!scene.slots[empty]||scene.slots[empty].sourceId||scene.slots[empty].locked))throw Error('Choose an unlocked empty source slot.');
    const place=empty>=0&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only'?null:await prepareSourceLayerPlacement(scene,{isCurrent});
    if(!isCurrent()||svgPartFingerprint(scene)!==fingerprint)throw Error('The selected scene changed. Nothing was added.');
    const source=addSource(effectsModule().createGeneratorSource(config));
    try{return place?place([source.id])[0]:insertSceneSources(scene,[source.id],{slotIndex:empty})[0];}
    catch(error){discardUnplacedSource(source.id);throw error;}
  }
  // Library sources enter Preview through the same checked placement transaction.
  async function addLibrarySource(sceneId,runtime,{isCurrent=()=>true,slotIndex}={}){
    let record;
    try{
      const scene=svgPartScene(sceneId),fingerprint=svgPartFingerprint(scene);
      if(scene.layoutPending||!isCurrent())throw Error('Choose the current Preview scene.');
      if(slotIndex!==undefined&&(!Number.isInteger(slotIndex)||!scene.slots[slotIndex]||scene.slots[slotIndex].sourceId||scene.slots[slotIndex].locked||
        scene.svgParts?.some(part=>part.sourceSlot===slotIndex&&part.locked)))throw Error('Choose an unlocked empty picture frame.');
      await runtime.prepare?.();
      if(!sourceStatus(runtime).ok)throw Error('The library source is not ready.');
      if(slotIndex!==undefined&&runtime.audioOnly)throw Error('Choose a video or picture source for this frame.');
      const empty=slotIndex??scene.slots.findIndex(slot=>!slot.sourceId&&!slot.locked),place=slotIndex!==undefined||empty>=0&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only'?null:await prepareSourceLayerPlacement(scene,{isCurrent});
      if(!isCurrent()||svgPartFingerprint(scene)!==fingerprint)throw Error('The selected scene changed. Nothing was added.');
      record=runtime.kind==='video'?addMediaSource(runtime):addSource(runtime);
      return place?place([record.id])[0]:insertSceneSources(scene,[record.id],{slotIndex:empty,sourceLabels:true})[0];
    }catch(error){if(record)discardUnplacedSource(record.id);else runtime?.dispose?.();throw error;}
  }
  // Replace only the selected Preview placement. Programme retains its own
  // configured question and canvas while both receive live read-only results.
  async function updateAudienceSource(sceneId,index,config,{expected,isCurrent=()=>true}={}){
    const scene=svgPartScene(sceneId),slot=scene.slots[index],owner=slot&&sources.get(slot.sourceId);
    if(!slot||expected&&slot!==expected||!isCurrent()||owner?.sourceType!=='audience')throw Error('Select the current Audience source.');
    const module=window.OpenLiveAudience;if(!module?.create)throw Error('The Audience source renderer is unavailable.');
    const normalized=module.normalize(config),fingerprint=svgPartFingerprint(slot);let runtime,registered;
    const check=()=>{
      if(!isCurrent()||!scenes().includes(scene)||scene.slots[index]!==slot||sources.get(owner.id)!==owner||svgPartFingerprint(slot)!==fingerprint)
        throw Error('The selected Audience source changed. Nothing was applied.');
      if(scene.layoutPending)throw Error('Choose the current Preview scene.');
      if(slot.locked||sceneContents(scene).some(row=>row.index===index&&(row.locked||row.part?.locked)))
        throw Error('Unlock this Audience layer before editing it.');
    };
    try{
      check();runtime=module.create(normalized);await runtime.prepare();check();
      if(!sourceStatus(runtime).ok)throw Error('The Audience source could not be prepared.');
      runtime.label=(normalized.title||owner.label).slice(0,120);registered=addSource(runtime);check();
      const next={...slot,sourceId:registered.id};commitFree(scene,{slots:scene.slots.map((item,i)=>i===index?next:item)});
      recordCreativeHistory(scene,'source:'+index,slot,next);return registered;
    }catch(error){if(registered)discardUnplacedSource(registered.id);else runtime?.dispose?.();throw error;}
  }
  // UNDOCUMENTED — Audience compositions are a browser-specific workflow.
  // Prepare owned media privately, then publish an ordinary editable layer stack
  // in one durable write. Preview selection remains owned by the Studio UI.
  async function createAudienceGraphicScene(config,{backgroundSourceId,backgroundFile,name,isCurrent=()=>true,signal}={}){
    const module=window.OpenLiveAudience;
    if(!module?.create||!module.normalize)throw Error('The Audience source renderer is unavailable.');
    if(typeof isCurrent!=='function')throw Error('Provide a current scene-creation selection.');
    if(backgroundSourceId!=null&&(typeof backgroundSourceId!=='string'||!backgroundSourceId))throw Error('Choose an existing image or video background.');
    if(backgroundSourceId!=null&&backgroundFile!=null)throw Error('Choose an existing background or a local file, not both.');
    const settings=module.normalize(config),framed=settings.presentation&&settings.presentation!=='flat'||settings.framing&&settings.framing!=='full',
      normalized=framed?settings:module.normalize({...settings,transparent:true}),
      scene=newSceneDraft({name:name??(normalized.title||'Audience graphic').slice(0,80),layout:'free',sourceWorkflow:'obs'}),
      existing=backgroundSourceId==null?null:sources.get(backgroundSourceId),
      isBackground=source=>!!source&&!source.audioOnly&&(source.sourceType==='image'||source.kind==='image'||isFileMedia(source))&&sourceStatus(source).ok;
    if(backgroundSourceId!=null&&!isBackground(existing))throw Error('Choose a ready image or file-video source for the background.');
    let acquire=null,fileType=null;
    if(backgroundFile!=null){
      const mime=String(backgroundFile.type||'').toLowerCase(),unknown=!mime||mime==='application/octet-stream';
      if(mime.startsWith('audio/'))throw Error('Choose an image or video file for the background. Audio-only files cannot be used.');
      fileType=mime.startsWith('image/')||unknown&&/\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|apng|tiff?)$/i.test(String(backgroundFile.name||''))?'image':'media';
      if(!window.OpenLiveSourceAcquisition?.create)throw Error('Local image and video preparation is unavailable.');
      acquire=window.OpenLiveSourceAcquisition.create({document,mediaDevices:null});
    }
    const owned=[],registered=[],released=new Set();let background=existing,runtime,previous=null;
    const release=value=>{if(!value||released.has(value))return;released.add(value);try{value.dispose?.();}catch(_){}};
    const check=()=>{
      if(signal?.aborted||!isCurrent())throw Error('Graphic scene creation cancelled. Nothing was added.');
      if(existing&&(sources.get(backgroundSourceId)!==existing||!isBackground(existing)))throw Error('The selected background changed while the graphic scene was preparing.');
    };
    // Acquisition decodes the file, then its transport seeks to the trim start.
    // That seek can temporarily discard HAVE_CURRENT_DATA. Wait for its actual
    // new frame, without relaxing source readiness or moving a shared player.
    const waitForBackgroundFrame=()=>{
      if(!acquire||background?.kind!=='video'||background.audioOnly)return Promise.resolve();
      const el=background.el;
      return new Promise((resolve,reject)=>{
        let settled=false,deadline,poll;
        const finish=error=>{if(settled)return;settled=true;clearTimeout(deadline);clearInterval(poll);
          for(const event of ['loadeddata','canplay','seeked'])el.removeEventListener(event,probe);
          el.removeEventListener('error',failed);signal?.removeEventListener('abort',probe);error?reject(error):resolve();};
        const probe=()=>{try{check();const status=sourceStatus(background);
          if(status.ok&&!el.seeking)finish();else if(!status.ok&&status.state!=='loading')finish(Error(status.why||'The background video could not be decoded.'));
        }catch(error){finish(error);}};
        const failed=()=>finish(Error('The background video could not be decoded. Try another file.'));
        for(const event of ['loadeddata','canplay','seeked'])el.addEventListener(event,probe);
        el.addEventListener('error',failed);signal?.addEventListener('abort',probe,{once:true});
        deadline=setTimeout(()=>{try{check();finish(Error('No decoded background video frame arrived within 20 seconds. Try another file.'));}catch(error){finish(error);}},20000);
        poll=setInterval(probe,100);probe();
      });
    };
    const cancel=()=>release(runtime);
    try{
      check();
      if(acquire){background=await acquire(fileType,{file:backgroundFile,loop:true},signal);owned.push(background);check();
        await waitForBackgroundFrame();check();
        if(!isBackground(background))throw Error('Choose a decoded image or video file for the background. Audio-only files cannot be used.');
        background.label=String(backgroundFile.name||'Background').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120)||'Background';}
      runtime=module.create(normalized);owned.push(runtime);signal?.addEventListener('abort',cancel,{once:true});
      check();await runtime.prepare();check();
      if(!sourceStatus(runtime).ok)throw Error('The Audience graphic could not be prepared.');
      await waitForBackgroundFrame();check();
      if(background&&!isBackground(background))throw Error('The background picture is no longer ready.');
      let backgroundId=existing?.id||null;
      if(background&&!existing){const record=background.kind==='video'?addMediaSource(background):addSource(background);registered.push({record,runtime:background});backgroundId=record.id;}
      const graphic=addSource(runtime);registered.push({record:graphic,runtime});check();
      const slot=(sourceId,label,outputFit)=>({sourceId,label,mute:true,hidden:false,locked:false,gain:1,transform:freeTransform(),outputFit});
      scene.slots=[...(backgroundId?[slot(backgroundId,background.label||'Background','cover')]:[]),slot(graphic.id,graphic.label,'contain')];
      scene.freeOrder=scene.slots.map((_slot,index)=>'source:'+index);
      previous=doc.scenes;doc.scenes=[...previous,scene];
      if(!save())throw Error('The graphic scene could not be saved. Existing scenes and Programme are unchanged.');
      return {scene,sourceIndex:scene.slots.length-1,backgroundIndex:backgroundId?0:null};
    }catch(error){
      if(previous)doc.scenes=previous;
      for(const entry of registered){discardUnplacedSource(entry.record.id);released.add(entry.runtime);}
      owned.forEach(release);throw error;
    }finally{signal?.removeEventListener('abort',cancel);}
  }
  const sportsFramePresets=new Set(['lineup','match-stats']);
  const sportsCuePresets=new Set(['goal','substitution','replay-title']);
  function sportsTemplateInfo(value){
    const scene=typeof value==='string'?scenes().find(item=>item.id===value):value;if(!scene)return null;
    const templateId=scene.sportsTemplateId||scene.fullTemplateId||scene.svgParts?.find(part=>Number.isInteger(part.sourceSlot))?.templateId,
      template=window.OpenLiveFullTemplates?.get(templateId);if(!validFullTemplate(template))return null;
    const frameSlots=template.frames.map((_frame,index)=>{
      const part=scene.svgParts?.find(item=>item.templateId===templateId&&template.components?.find(component=>component.id===item.componentId)?.frameIndex===index),
        slot=scene.fullTemplateId===templateId?index:part?.sourceSlot;
      return Number.isInteger(slot)?slot:null;
    });
    const bindings=frameSlots.map((slot,index)=>{
      const id=Number.isInteger(slot)?scene.slots[slot]?.sourceId||null:null;
      if(sceneSource(scene,id)?.sourceType!=='sports')return id;
      const intended=scene.sportsTemplateBindings?.[index];return intended&&sources.has(intended)&&sources.get(intended)?.sourceType!=='sports'?intended:null;
    });
    const sourceIndex=scene.slots.findIndex(slot=>{const source=sceneSource(scene,slot.sourceId);return source?.sourceType==='sports'&&source.config?.templateId===templateId&&(!scene.sportsPreset||source.config.preset===scene.sportsPreset);});
    return {templateId,bindings,frameSlots,graphicFrame:scene.sportsGraphicFrame??(templateId==='svg-6'?1:0),packId:scene.sportsPackId||null,preset:scene.sportsPreset||null,sourceIndex:sourceIndex<0?null:sourceIndex};
  }
  // Only identified native lettering is replaced; all geometry, font sizes,
  // frame rings, identities and QR artwork remain owned by the supplied design.
  function sportsSceneTemplateStyle(templateId,config,preset,raw={}){
    const module=svgPartModule(),template=module.get(templateId),style=JSON.parse(JSON.stringify(module.normalizeStyle(templateId,raw))),
      score=config.home.short+' '+config.homeScore+' – '+config.awayScore+' '+config.away.short,
      matchup=config.home.name+' v '+config.away.name,
      headline=preset==='lineup'?config[config.team].name+' · Starting lineup':preset==='match-stats'?matchup+' · Match statistics':
        preset==='goal'?'GOAL · '+(config.player||config[config.team].name):preset==='substitution'?'SUBSTITUTION · '+config.playerOut+' → '+config.playerIn:
        preset==='replay-title'?'REPLAY · '+matchup:matchup+' · '+score,
      text={headline,'ticker-text':config.competition+' · '+score+' · '+config.period,'ticker-label':'MATCHDAY'};
    const components={...(style.components||{})};
    for(const [id,value] of Object.entries(text))if(template.components?.some(component=>component.id===id&&component.editableText))
      components[id]={...(components[id]||{}),text:value,overflow:'scroll',overflowSpeed:80};
    // The cue source renders these exact native pieces itself. Hiding their
    // scene copies avoids painting the old headline beneath the animated cue.
    if(sportsCuePresets.has(preset))for(const id of ['lower-third-backplate','headline'])if(template.components?.some(component=>component.id===id))
      components[id]={...(components[id]||{}),visible:false};
    if(Object.keys(components).length)style.components=components;
    return module.normalizeStyle(templateId,style);
  }
  async function prepareSportsTemplateScenes(options={},presets,{isCurrent=()=>true,pack=false}={}){
    const module=window.OpenLiveSportsSources,templates=svgPartModule();
    if(!module?.create||!module.normalize)throw Error('The sports source renderer is unavailable.');
    if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Choose a sports template composition.');
    registerFullTemplateLayouts();
    const templateId=options.templateId||options.config?.templateId,template=templates.get(templateId);
    if(!validFullTemplate(template)||!template.frames.length||!Array.isArray(template.components)||!LAYOUTS[templateId])throw Error('Choose an available native template with picture frames.');
    const graphicFrame=options.graphicFrame??options.config?.frameIndex??(templateId==='svg-6'?1:0);
    if(!Number.isInteger(graphicFrame)||graphicFrame<0||graphicFrame>=template.frames.length)throw Error('Choose an existing native picture frame.');
    const rawBindings=options.bindings??[];
    if(!Array.isArray(rawBindings)||rawBindings.length>template.frames.length||rawBindings.some(id=>id!==null&&(typeof id!=='string'||!id)))throw Error('Provide a source or an empty choice for each native frame.');
    const bindings=Array.from({length:template.frames.length},(_,index)=>rawBindings[index]??null),owners=new Map();
    for(const id of bindings.filter(Boolean)){
      const source=sources.get(id);if(!source||source.audioOnly||!sourceStatus(source).ok)throw Error('Choose available picture sources for the native frames.');owners.set(id,source);
    }
    const baseName=options.name??('Football · '+template.name);
    if(typeof baseName!=='string'||!baseName.trim()||baseName.length>80||/[\u0000-\u001f\u007f]/.test(baseName))throw Error('Use a scene name of 1–80 characters.');
    const joining=options.packId===undefined?[]:scenes().filter(scene=>scene.sportsPackId===options.packId);
    if(options.packId!==undefined&&(pack||typeof options.packId!=='string'||!options.packId||!joining.length||joining.some(scene=>scene.sportsTemplateId!==templateId)))
      throw Error('Choose an existing sports pack using this native template.');
    const packConfig=joining.flatMap(scene=>scene.slots.map(slot=>sources.get(slot.sourceId))).find(source=>source?.sourceType==='sports')?.config;
    if(joining.length&&!packConfig)throw Error('This sports pack no longer has shared match settings.');
    const shared=packConfig?Object.fromEntries(['style','home','away','homeScore','awayScore','competition','period','clock','templateStyle'].filter(key=>packConfig[key]!==undefined).map(key=>[key,packConfig[key]])):{},
      inputConfig={...options.config,...shared},joiningState=joining.map(scene=>[scene,svgPartFingerprint(scene)]),
      templateStyle=templates.normalizeStyle(templateId,inputConfig.templateStyle||{}),packId=pack?uid('sports-pack-'):options.packId||null,
      entries=[];let cancelled=false,committed=false,committing=false,pending=null;
    const check=()=>{
      if(cancelled||committed||!isCurrent())throw Error('The sports composition was cancelled because its scene or selection changed.');
      for(const [id,source] of owners)if(sources.get(id)!==source||source.audioOnly||!sourceStatus(source).ok)throw Error('A selected picture source changed while the composition was preparing.');
      if(joiningState.some(([scene,fingerprint])=>!scenes().includes(scene)||svgPartFingerprint(scene)!==fingerprint)||
        joining.length&&scenes().filter(scene=>scene.sportsPackId===packId).some(scene=>!joining.includes(scene)))throw Error('The shared match changed while the cue was preparing.');
    };
    const release=()=>{for(const entry of entries){preparedSceneSources.delete(entry.scene);try{entry.runtime.dispose?.();}catch(_){}}try{pending?.dispose?.();}catch(_){}pending=null;};
    try{
      check();
      for(const [preset,label] of presets){
        const placement=sportsFramePresets.has(preset)?'frame':'overlay',config=module.normalize({...inputConfig,...(inputConfig.preset&&inputConfig.preset!==preset?{headline:undefined}:{}),preset,templateId,frameIndex:graphicFrame,templateStyle,placement}),
          style=sportsSceneTemplateStyle(templateId,config,preset,templateStyle),name=pack?(baseName.trim()+' · '+label).slice(0,80):baseName.trim(),
          scene=newSceneDraft({name,layout:templateId,fullTemplateId:templateId,fullTemplateStyle:style});
        scene.sportsTemplateId=templateId;scene.sportsGraphicFrame=graphicFrame;scene.sportsPreset=preset;if(packId)scene.sportsPackId=packId;
        scene.slots=scene.slots.map((slot,index)=>({...slot,sourceId:bindings[index],label:template.frames[index].name||'Picture '+(index+1)}));
        // A camera is never presented as recorded replay footage. Other native
        // frames may keep commentator/live sources while the replay frame waits.
        if((pack||options.packId)&&preset==='replay-title'&&!isFileMedia(sources.get(scene.slots[graphicFrame].sourceId)))
          scene.slots[graphicFrame]={...scene.slots[graphicFrame],sourceId:null,label:'Replay clip'};
        scene.sportsTemplateBindings=scene.slots.map(slot=>slot.sourceId);
        const runtime=pending=module.create(config,{now:()=>0});await runtime.prepare?.();check();
        if(!sourceStatus(runtime).ok)throw Error('The sports graphic could not be prepared.');
        const token=uid('sports-proof-');let index=graphicFrame;
        if(placement==='frame')scene.slots[index]={...scene.slots[index],sourceId:token,mute:true,label:runtime.label};
        else{
          Object.assign(scene,splitSvgPartDraft(scene));delete scene.fullTemplateId;delete scene.fullTemplateStyle;delete scene.fullTemplateExtras;
          scene.layout='free';scene.sourceWorkflow='obs';scene.svgPartsMode='overlay';scene.svgPartsExtras=false;
          index=scene.slots.length;scene.slots.push({sourceId:token,mute:true,hidden:false,gain:1,label:runtime.label,transform:freeTransform(runtime.initialTransform)});
          scene.freeOrder=[...scene.svgParts.map(part=>'part:'+part.id),'source:'+index];
        }
        const entry={scene,runtime,index,token};entries.push(entry);pending=null;
        // Proof time is relative for the staged cue, but any shared generated
        // feed keeps its actual compositor clock instead of being rewound.
        const proofSources=new Map([...owners].map(([id,source])=>[id,{...source,renderFrame:()=>source.renderFrame?.(performance.now())}]));
        proofSources.set(token,runtime);preparedSceneSources.set(scene,proofSources);
        if(scene.fullTemplateId)await templates.load(templateId,{style:scene.fullTemplateStyle,retry:true});else await prepareSvgParts(scene);check();
        const proof=document.createElement('canvas');proof.width=480;proof.height=270;const result=renderSceneDraft(proof,scene,1200);
        if(!result.ok||!sourceStatus(runtime).ok)throw Error(result.why||'The native sports composition could not be drawn.');
      }
      check();
    }catch(error){release();throw error;}
    return {
      get draft(){return snapshotScene(entries[0].scene,false);},
      render(canvas,timeMs=1200){check();return renderSceneDraft(canvas,entries[0].scene,timeMs);},
      async commit(){
        if(committing)throw Error('This sports composition is already being added.');committing=true;
        const records=[],fresh=[];let previous=null;
        try{
          check();
          // A proof's relative clock must never become the live source clock.
          // Prepare fresh cues privately, then publish their complete batch.
          for(const entry of entries){const runtime=module.create(entry.runtime.config);fresh.push(runtime);await runtime.prepare?.();check();
            if(!sourceStatus(runtime).ok)throw Error('The sports graphic could not be prepared for Preview.');}
          // Every asynchronous preparation has completed. Registration and the
          // publication of all scenes form one synchronous document transaction.
          entries.forEach((entry,index)=>{check();const record=addSource(fresh[index]);records.push(record);entry.scene.slots[entry.index]={...entry.scene.slots[entry.index],sourceId:record.id};});
          check();previous=doc.scenes;doc.scenes=[...previous,...entries.map(entry=>entry.scene)];
          if(!save()){doc.scenes=previous;throw Error('The sports scenes could not be saved. Existing scenes and Programme are unchanged.');}
          committed=true;release();
          return entries.map(entry=>entry.scene);
        }catch(error){
          if(previous)doc.scenes=previous;records.forEach(record=>discardUnplacedSource(record.id));
          fresh.slice(records.length).forEach(runtime=>runtime.dispose?.());release();cancelled=true;throw error;
        }finally{committing=false;}
      },
      cancel(){if(cancelled||committed)return;cancelled=true;release();}
    };
  }
  async function prepareSportsTemplateScene(options={},controls={}){
    const controller=await prepareSportsTemplateScenes(options,[[options.preset||'scoreboard','']],controls);
    return {get draft(){return controller.draft;},render:controller.render,cancel:controller.cancel,async commit(){return (await controller.commit())[0];}};
  }
  async function createSportsTemplateScene(options={},controls={}){const controller=await prepareSportsTemplateScene(options,controls);return controller.commit();}
  async function createSportsTemplatePack(options={},controls={}){
    const controller=await prepareSportsTemplateScenes(options,[['scoreboard','Live match'],['lineup','Starting lineup'],['match-stats','Match statistics'],['replay-title','Replay']],{...controls,pack:true});
    return controller.commit();
  }
  const sportsEditFields=['slots','layout','sourceWorkflow','fullTemplateId','fullTemplateStyle','fullTemplateExtras','svgParts','svgPartsMode','svgPartsExtras','freeOrder','arrangementOverlayBefore',
    'sportsPackId','sportsTemplateId','sportsGraphicFrame','sportsTemplateBindings','sportsPreset','contentItems'];
  const sportsEditState=scene=>JSON.parse(svgPartFingerprint(Object.fromEntries(sportsEditFields.filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]]))));
  function checkSportsLocks(scene){
    const indices=new Set(scene.slots.flatMap((slot,index)=>sources.get(slot.sourceId)?.sourceType==='sports'?[index]:[]));
    if([...indices].some(index=>scene.slots[index].locked)||scene.svgParts?.some(part=>part.locked&&indices.has(part.sourceSlot)))
      throw Error('Unlock the match graphics before updating match settings.');
  }
  function commitSportsStates(changes){
    const previous=changes.map(({scene})=>({scene,values:Object.fromEntries(sportsEditFields.filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]]))}));
    for(const {scene,next} of changes)for(const key of sportsEditFields){if(Object.hasOwn(next,key))scene[key]=next[key];else delete scene[key];}
    if(!save()){
      for(const {scene,values} of previous)for(const key of sportsEditFields){if(Object.hasOwn(values,key))scene[key]=values[key];else delete scene[key];}
      throw Error('The match settings could not be saved. All scenes and Programme are unchanged.');
    }
    for(const {scene} of changes)svgPartRenderErrors.delete(scene.id);
  }
  async function prepareSportsSceneArtwork(scene){
    if(scene.svgParts)await prepareSvgParts(scene);
    else if(scene.fullTemplateId)await svgPartModule().load(scene.fullTemplateId,{style:scene.fullTemplateStyle||{},retry:true});
  }
  function refreshSportsNativeText(draft,config){
    if(!draft.sportsTemplateId)return;
    const style=sportsSceneTemplateStyle(draft.sportsTemplateId,config,draft.sportsPreset||config.preset,config.templateStyle||{});
    if(draft.fullTemplateId===draft.sportsTemplateId){
      const components={...(style.components||{})};
      for(const [id,value] of Object.entries(draft.fullTemplateStyle?.components||{})){
        const previous={...value};delete previous.text;
        if(Object.keys(previous).length)components[id]={...(components[id]||{}),...previous};
        if(draft.contentItems?.['template:'+id]?.removed)components[id]={...(components[id]||{}),visible:false};
      }
      draft.fullTemplateStyle=fullTemplateStyle(draft.fullTemplateId,{...style,...(Object.keys(components).length?{components}:{})});return;
    }
    if(!draft.svgParts)return;
    const colours={...style};delete colours.components;
    draft.svgParts=draft.svgParts.map(part=>{
      if(part.templateId!==draft.sportsTemplateId)return part;
      const change={...(part.style.components?.[part.componentId]||{}),...(style.components?.[part.componentId]||{})},
        next=normalizeSceneSvgPart({...part,style:{...part.style,...colours,...(Object.keys(change).length?{components:{[part.componentId]:change}}:{})}},draft.slots);
      if(part.locked&&svgPartFingerprint(part)!==svgPartFingerprint(next))throw Error('Unlock the native match captions before updating match settings.');
      return next;
    });
  }
  async function updateSportsSource(sceneId,index,config,{expected,isCurrent=()=>true}={}){
    const scene=svgPartScene(sceneId),slot=scene.slots[index];
    if(!slot||expected&&slot!==expected||!isCurrent()||sources.get(slot.sourceId)?.sourceType!=='sports')throw Error('Select the current match graphic.');
    const module=window.OpenLiveSportsSources,normalized=module.normalize(config),packId=scene.sportsPackId||null,
      owners=packId?scenes().filter(item=>item.sportsPackId===packId):[scene],
      states=owners.map(owner=>({scene:owner,fingerprint:svgPartFingerprint(owner),before:sportsEditState(owner),draft:{...owner,slots:owner.slots.slice()}})),
      matchKeys=['style','home','away','homeScore','awayScore','competition','period','clock',...(normalized.templateStyle?['templateStyle']:[])],prepared=[],registered=[];
    if(scene.sportsTemplateId&&(normalized.templateId!==scene.sportsTemplateId||normalized.frameIndex!==scene.sportsGraphicFrame||normalized.preset!==sources.get(slot.sourceId).config.preset||normalized.placement!==sources.get(slot.sourceId).config.placement))
      throw Error('Choose a new sports composition to change its native template, frame or preset.');
    const check=()=>{
      if(!isCurrent()||states.some(item=>!scenes().includes(item.scene)||svgPartFingerprint(item.scene)!==item.fingerprint)||
        packId&&scenes().filter(item=>item.sportsPackId===packId).some(item=>!owners.includes(item))||
        prepared.some(item=>sources.get(item.owner.id)!==item.owner))throw Error('The selected match changed. Nothing was applied.');
      states.forEach(item=>checkSportsLocks(item.scene));
    };
    let pending=null;
    try{
      check();
      for(const state of states){
        const proofSources=new Map();preparedSceneSources.set(state.draft,proofSources);let captionConfig=null;
        for(let i=0;i<state.scene.slots.length;i++){
          const owner=sources.get(state.scene.slots[i].sourceId);if(owner?.sourceType!=='sports')continue;
          const selected=state.scene===scene&&i===index,next=selected?normalized:module.normalize({...owner.config,...Object.fromEntries(matchKeys.map(key=>[key,normalized[key]]))}),
            runtime=pending=module.create(next,{animationElapsed:selected?0:owner.animationElapsed?.()||0});await runtime.prepare?.();check();
          if(!sourceStatus(runtime).ok)throw Error('A match graphic could not be prepared.');runtime.label=owner.label;
          const token=uid('sports-edit-');prepared.push({state,index:i,owner,runtime,token});pending=null;
          proofSources.set(token,runtime);state.draft.slots[i]={...state.draft.slots[i],sourceId:token};
          if(!captionConfig||next.preset===state.scene.sportsPreset)captionConfig=next;
        }
        refreshSportsNativeText(state.draft,captionConfig||normalized);await prepareSportsSceneArtwork(state.draft);check();
        const proof=document.createElement('canvas');proof.width=480;proof.height=270;const status=renderSceneDraft(proof,state.draft);
        if(!status.ok||prepared.some(item=>item.state===state&&!sourceStatus(item.runtime).ok))throw Error(status.why||'The updated match artwork could not be drawn.');
      }
      check();
      for(const item of prepared){const record=addSource(item.runtime);registered.push(record);item.state.draft.slots[item.index]={...item.state.draft.slots[item.index],sourceId:record.id};}
      check();const changes=states.map(item=>({scene:item.scene,next:sportsEditState(item.draft)}));commitSportsStates(changes);
      const entry={sportsBatch:true,packId,sportsScenes:states.map((item,i)=>({sceneId:item.scene.id,before:item.before,after:changes[i].next}))};
      for(const {scene:owner} of states){const history=creativeHistories.get(owner.id)||{undo:[],redo:[]};history.undo=[...history.undo.slice(-19),entry];history.redo=[];creativeHistories.set(owner.id,history);}
      return sources.get(scene.slots[index].sourceId);
    }catch(error){pending?.dispose?.();registered.forEach(record=>discardUnplacedSource(record.id));prepared.slice(registered.length).forEach(item=>item.runtime.dispose?.());throw error;}
    finally{states.forEach(item=>preparedSceneSources.delete(item.draft));}
  }
  function sourceEffectStatus(sceneId,index){const scene=scenes().find(s=>s.id===sceneId),slot=scene?.slots[index];return slot?effectsModule().status(slot):{ok:false,reason:'Select a source.'};}
  // Isolated editing proof: never mutates a scene, takes Programme, or captures a device.
  function renderCreativeLayer(cv,sceneId,key,override={},options={}){
    const target=creativeLayer(sceneId,key),{scene,row,item}=target,ctx=cv.getContext('2d');
    // Legacy eraser proofs stay still. Live mapping proofs use the same
    // performance-clock milliseconds as paint()/renderSceneMonitor(), so a
    // shared generated source is never repainted at its initial frame.
    const live=options.timeMs!==undefined,timeMs=live?options.timeMs:0;
    if(typeof timeMs!=='number'||!Number.isFinite(timeMs))throw Error('Choose a finite preview time.');
    if(options.transform!==undefined&&!row.slot)throw Error('Draft output transforms apply to picture sources.');
    const transform=options.transform===undefined?null:freeTransform(options.transform);
    const settings=creativeModule().merge(item.creative,{...override,...(live?{}:{animation:{preset:'none',seconds:3}})});
    ctx.clearRect(0,0,cv.width,cv.height);
    if(row.slot){const draft={...scene,slots:scene.slots.map((s,i)=>i===row.index?{...s,hidden:false,creative:settings,...(transform?{transform}: {})}:s)};
      if(target.nativeRow?.part)return drawSceneSvgPart(target.nativeRow.part,ctx,cv,draft,timeMs);
      let prepared=null;
      if(item.generator||item.effects?.length){const source=sceneSource(scene,item.sourceId);if(source){source.renderFrame?.(timeMs);prepared=effectsModule().render(item,sourceVisualFrame(source,timeMs),timeMs,{reuseFrame:true});}}
      const native=target.nativeRow,rect=native?fullTemplateFrames(native.templateId,cv,fullTemplateStyle(native.templateId,scene.fullTemplateStyle))[row.index]:sourceRectNormalized(draft,row.index);
      return paintSource(ctx,cv,draft,rect,row.index,native?.templateId||null,timeMs,false,prepared);}
    return creativeModule().paint(ctx,cv,partRectNormalized(item,cv),settings,timeMs,layer=>drawSceneSvgPart(item,layer,cv,scene,timeMs));
  }
  // Input proof includes this placement's effects, before crop or output placement.
  // It never commits; the caller sizes the canvas to the source's intrinsic aspect.
  function renderSourceInput(cv,sceneId,index) {
    const scene=svgPartScene(sceneId),slot=scene.slots[index],ctx=cv.getContext('2d');let src=slot&&sceneSource(scene,slot.sourceId);
    ctx.clearRect(0,0,cv.width,cv.height);
    if(!src||src.audioOnly)return false;
    try{const now=performance.now();src.renderFrame?.(now);src=sourceVisualFrame(src,now);if(slot.generator||slot.effects?.length)src=effectsModule().render(slot,src,now,{reuseFrame:true});}catch(_){return false;}
    if(!sourceStatus(src).ok)return false;
    ctx.save();
    try{
      if(src.mirror){ctx.translate(cv.width,0);ctx.scale(-1,1);}
      ctx.drawImage(src.el,0,0,cv.width,cv.height);return true;
    }catch(_){return false;}
    finally{ctx.restore();}
  }
  async function stepCreativeHistory(sceneId,redo=false,{isCurrent=()=>true}={}){
    const history=creativeHistories.get(sceneId),from=history?.[redo?'redo':'undo'],entry=from?.at(-1);if(!entry)return false;
    if(entry.sportsScenes){
      const states=entry.sportsScenes.map(item=>{const scene=svgPartScene(item.sceneId);return {scene,item,expected:redo?item.before:item.after,next:JSON.parse(svgPartFingerprint(redo?item.after:item.before)),
        history:creativeHistories.get(item.sceneId)};});
      const check=()=>{
        if(!isCurrent()||states.some(state=>!scenes().includes(state.scene)||state.history!==creativeHistories.get(state.scene.id)||
          state.history?.[redo?'redo':'undo']?.at(-1)!==entry||svgPartFingerprint(sportsEditState(state.scene))!==svgPartFingerprint(state.expected))||
          entry.packId&&scenes().filter(scene=>scene.sportsPackId===entry.packId).some(scene=>!states.some(state=>state.scene===scene)))
          throw Error('The match changed after that edit. Undo was not applied.');
        for(const state of states){checkSportsLocks(state.scene);
          if(state.next.slots.some(slot=>slot.sourceId&&!sources.has(slot.sourceId)))throw Error('A previous match source is no longer available.');}
      };
      check();
      for(const state of states){const draft={...state.scene};for(const key of sportsEditFields){if(Object.hasOwn(state.next,key))draft[key]=state.next[key];else delete draft[key];}
        await prepareSportsSceneArtwork(draft);check();
        const proof=document.createElement('canvas');proof.width=480;proof.height=270;const result=renderSceneDraft(proof,draft);
        if(!result.ok)throw Error(result.why||'The previous match artwork could not be drawn.');}
      check();commitSportsStates(states.map(state=>({scene:state.scene,next:state.next})));
      for(const state of states){state.history[redo?'redo':'undo'].pop();state.history[redo?'undo':'redo'].push(entry);}return true;
    }
    if(entry.sportsBatch){
      const scene=svgPartScene(sceneId),expected=redo?entry.before:entry.after,next=JSON.parse(svgPartFingerprint(redo?entry.after:entry.before));
      if(!isCurrent()||svgPartFingerprint(scene.slots)!==svgPartFingerprint(expected))throw Error('The match changed after that edit. Undo was not applied.');
      if(scene.slots.some(slot=>slot.locked&&sources.get(slot.sourceId)?.sourceType==='sports'))throw Error('Unlock the match graphics before undoing their settings.');
      if(next.some(slot=>slot.sourceId&&!sources.has(slot.sourceId)))throw Error('A previous match source is no longer available.');
      commitFree(scene,{slots:next});from.pop();history[redo?'undo':'redo'].push(entry);return true;
    }
    const target=creativeLayer(sceneId,entry.key),{scene,row,item}=target,expected=redo?entry.before:entry.after,
      restored=JSON.parse(svgPartFingerprint(redo?entry.after:entry.before)),next=row.part?normalizeSceneSvgPart(restored,scene.slots):restored;
    if(target.locked)throw Error('Unlock this layer before undoing or redoing its edit.');
    if(target.audioOnly||row.slot&&sources.get(next.sourceId)?.audioOnly)throw Error('Audio-only sources have no picture edit to undo or redo.');
    if(svgPartFingerprint(item)!==svgPartFingerprint(expected)||!isCurrent())throw Error('This layer changed after that edit. Undo was not applied.');
    if(row.part)await prepareSvgParts({...scene,svgParts:[next]});
    if(!isCurrent()||from.at(-1)!==entry||creativeLayer(sceneId,entry.key).item!==item)throw Error('The selected layer changed. Undo was not applied.');
    if(next.sourceId&&!sources.has(next.sourceId))throw Error('The previous capture is no longer available. Reconnect it before undoing.');
    commitFree(scene,row.slot?{slots:scene.slots.map((s,i)=>i===row.index?next:s)}:{svgParts:scene.svgParts.map(p=>p.id===item.id?next:p)});
    svgPartRenderErrors.delete(scene.id);from.pop();history[redo?'undo':'redo'].push(entry);return true;
  }
  function commitFree(scene,patch) {
    const previous={};for(const key of Object.keys(patch)){previous[key]=scene[key];scene[key]=patch[key];}
    if(!save()){for(const key of Object.keys(patch)){if(previous[key]===undefined)delete scene[key];else scene[key]=previous[key];}throw Error('The scene could not be saved. Previous settings are unchanged.');}
    return true;
  }
  /* Preview-only scene layout drafts. This is a SHOWAVE authoring extension:
     source placements keep their original slot identity/audio settings, native
     feed artwork moves with its source, and Apply is one durable transaction. */
  const arrangementFields=[...svgPartFields,'slots','layoutPending','sourceWorkflow'];
  const arrangementSnapshot=scene=>JSON.parse(svgPartFingerprint(Object.fromEntries(arrangementFields
    .filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]]))));
  function arrangementTransform(raw){
    sceneSettingsObject(raw,['x','y','w','h','rotation'],'picture zone');
    if(!['x','y','w','h'].every(key=>Number.isFinite(raw[key])))throw Error('Each picture zone needs finite X, Y, width and height.');
    const next=freeTransform(raw);
    if(next.x<0||next.y<0||next.x+next.w>1+1e-9||next.y+next.h>1+1e-9)throw Error('Picture zones must fit inside the canvas.');
    return next;
  }
  function arrangementDraft(scene){
    const next=snapshotScene(scene,false),artworkOnly=!!scene.fullTemplateId||scene.svgPartsMode==='parts-only';
    if(scene.fullTemplateId||scene.svgParts!==undefined)Object.assign(next,splitSvgPartDraft(scene));
    const owned=new Set((next.svgParts||[]).map(part=>part.sourceSlot)),originalRects=rects(scene.layout,'16x9');
    next.slots=scene.slots.map((slot,index)=>{
      if(sources.get(slot.sourceId)?.audioOnly)return JSON.parse(svgPartFingerprint(slot));
      const unplaced=scene.layout!=='free'&&!owned.has(index)&&(artworkOnly||index>=originalRects.length),
        part=next.svgParts?.find(layer=>layer.sourceSlot===index),transform=part?partRectNormalized(part):unplaced&&slot.transform?freeTransform(slot.transform):sourceRectNormalized(scene,index);
      return {...JSON.parse(svgPartFingerprint(slot)),transform:freeTransform(transform),
        ...(unplaced?{arrangementUnplaced:true}:{})};
    });
    const parts=next.svgParts||[],sourceKeys=next.slots.flatMap((slot,index)=>owned.has(index)?[]:['source:'+index]);
    let prefix=0;
    while(prefix<parts.length&&svgPartModule().get(parts[prefix].templateId).components
      .find(component=>component.id===parts[prefix].componentId).type==='background')prefix++;
    next.freeOrder=scene.layout==='free'&&!artworkOnly?freeLayers(scene).map(row=>row.key):[
      ...parts.slice(0,prefix).map(part=>'part:'+part.id),...sourceKeys,...parts.slice(prefix).map(part=>'part:'+part.id)];
    if(scene.layout!=='free'&&scene.svgPartsMode==='overlay'&&parts[prefix])next.arrangementOverlayBefore=parts[prefix].id;
    next.layout='free';next.sourceWorkflow='obs';delete next.layoutPending;
    delete next.fullTemplateId;delete next.fullTemplateStyle;delete next.fullTemplateExtras;
    if(next.svgParts){next.svgPartsMode='overlay';next.svgPartsExtras=sceneExtrasEnabled(scene);}
    return next;
  }
  function arrangementPlacements(draft){
    return draft.slots.flatMap((slot,index)=>{
      const source=sources.get(slot.sourceId);if(source?.audioOnly)return [];
      const linked=(draft.svgParts||[]).filter(part=>part.sourceSlot===index),transform=freeTransform(linked.length?partRectNormalized(linked[0]):slot.transform),locked=!!slot.locked||linked.some(part=>part.locked);
      return [Object.freeze({slotIndex:index,index,sourceId:slot.sourceId||null,label:slot.label||source?.label||'Empty picture '+(index+1),
        locked,hidden:!!slot.hidden,unplaced:!!slot.arrangementUnplaced,editable:!locked,
        transform:Object.freeze(transform),...transform,creative:creativeModule().normalize(slot.creative),linkedPartIds:Object.freeze(linked.map(part=>part.id))})];
    });
  }
  function setArrangementPlacement(draft,index,transform){
    const slot=draft.slots[index];if(!Number.isInteger(index)||!slot)throw Error('Choose an existing picture slot.');
    if(slot.locked||draft.svgParts?.some(part=>part.sourceSlot===index&&part.locked)||sources.get(slot.sourceId)?.audioOnly)throw Error('Locked pictures and audio-only slots cannot be rearranged.');
    const next=arrangementTransform(transform),linked=(draft.svgParts||[]).filter(part=>part.sourceSlot===index),previous=linked.length?partRectNormalized(linked[0]):freeTransform(slot.transform);
    draft.slots[index]={...slot,transform:next};delete draft.slots[index].arrangementUnplaced;
    if(draft.svgParts)draft.svgParts=draft.svgParts.map(part=>part.sourceSlot===index?normalizeSceneSvgPart({...part,
      arrangement:{from:nativePartRectNormalized(part),to:mappedArrangementRect(partRectNormalized(part),previous,next)}},draft.slots):part);
  }
  function insertArrangementSourceKey(draft,index){
    const order=draft.freeOrder.slice(),parts=new Map((draft.svgParts||[]).map(part=>['part:'+part.id,part]));let after=-1;
    order.forEach((key,position)=>{
      const slotIndex=key.startsWith('source:')?Number(key.slice(7)):parts.get(key)?.sourceSlot;
      if(Number.isInteger(slotIndex)&&!sources.get(draft.slots[slotIndex]?.sourceId)?.audioOnly)after=position;
    });
    if(after<0)while(after+1<order.length){const part=parts.get(order[after+1]);
      if(!part||svgPartModule().get(part.templateId).components.find(component=>component.id===part.componentId).type!=='background')break;after++;}
    order.splice(after+1,0,'source:'+index);draft.freeOrder=order;
  }
  function renderSceneDraft(cv,draft,timeMs=performance.now()){
    if(!cv?.getContext||!Number.isFinite(cv.width)||!Number.isFinite(cv.height)||cv.width<=0||cv.height<=0)throw Error('Choose a valid Preview canvas.');
    const ctx=cv.getContext('2d'),size=ASPECTS['16x9'];ctx.save();
    try{ctx.scale(cv.width/size.w,cv.height/size.h);paint({width:size.w,height:size.h,getContext:()=>ctx},'16x9',draft,timeMs);}
    finally{ctx.restore();}
    const status=draft.svgParts?svgPartsStatus(draft):draft.fullTemplateId?fullTemplateStatus(draft):null;
    return {ok:!status||status.state==='ready',state:status?.state||'ready',why:status?.error||''};
  }
  function arrangementHistory(sceneId){
    const history=doc.sceneArrangementHistories?.[sceneId];return {canUndo:!!history?.undo?.length,canRedo:!!history?.redo?.length,
      undoLabel:history?.undo?.at(-1)?.label||'',redoLabel:history?.redo?.at(-1)?.label||''};
  }
  function commitArrangement(scene,next,history){
    const previous=Object.fromEntries(arrangementFields.filter(key=>Object.hasOwn(scene,key)).map(key=>[key,scene[key]])),
      histories=doc.sceneArrangementHistories;
    for(const key of arrangementFields){if(Object.hasOwn(next,key))scene[key]=next[key];else delete scene[key];}
    doc.sceneArrangementHistories={...(histories||{}),[scene.id]:history};
    if(!save()){
      for(const key of arrangementFields){if(Object.hasOwn(previous,key))scene[key]=previous[key];else delete scene[key];}
      if(histories===undefined)delete doc.sceneArrangementHistories;else doc.sceneArrangementHistories=histories;
      throw Error('The layout could not be saved. Previous Preview, Programme and undo history are unchanged.');
    }
    svgPartRenderErrors.delete(scene.id);return scene;
  }
  async function prepareSceneArrangement(scene,{isCurrent=()=>true}={}){
    if(!scene||!doc.scenes.includes(scene)||!Array.isArray(scene.slots)||scene.slots.length>32)throw Error('Choose an existing scene with up to 32 source slots.');
    const fingerprint=svgPartFingerprint(scene),before=arrangementSnapshot(scene);let cancelled=false,committed=false,busy=false,revision=0,changed=false,
      draft=arrangementDraft(scene),presetKey='current',report={preset:'current',placed:0,added:0,untouched:[],locked:[],audioOnly:[],warning:''};
    const check=(content=true)=>{if(cancelled||committed||!isCurrent()||doc.scenes.find(item=>item.id===scene.id)!==scene||content&&svgPartFingerprint(scene)!==fingerprint)
      throw Error('The layout edit was cancelled because its scene or selection changed.');};
    if(draft.svgParts)await prepareSvgParts(draft);check();
    async function update(change,key='custom'){
      check();if(busy)throw Error('Wait for Apply to finish.');const request=++revision,next=snapshotScene(draft,false),nextReport=change(next);
      if(next.svgParts)await prepareSvgParts(next);check();
      if(request!==revision)throw Error('A newer layout draft replaced this edit.');
      draft=next;presetKey=key;report={...report,...nextReport,preset:key};changed=true;return report;
    }
    const controller={
      get draft(){return snapshotScene(draft,false);},get placements(){return arrangementPlacements(draft);},
      get zones(){return arrangementPlacements(draft);},get pictureSlots(){return arrangementPlacements(draft);},
      get report(){return JSON.parse(JSON.stringify(report));},get presetKey(){return presetKey;},get dirty(){return changed;},
      async choosePreset(key){
        if(typeof key!=='string'||!Object.hasOwn(LAYOUTS,key)||key.startsWith('svg-'))throw Error('Choose a built-in picture layout.');
        if(key==='free')return update(()=>({placed:0,added:0,untouched:[],warning:''}),key);
        return update(next=>{
          const eligible=arrangementPlacements(next).filter(placement=>placement.editable),zones=rects(key,'16x9'),added=Math.max(0,zones.length-eligible.length);
          if(next.slots.length+added>32)throw Error('A scene supports up to 32 source slots.');
          while(eligible.length<zones.length){const index=next.slots.length;next.slots.push({sourceId:null,mute:false,hidden:false,gain:1,transform:freeTransform()});
            insertArrangementSourceKey(next,index);eligible.push({slotIndex:index});}
          zones.forEach((rect,index)=>{
            const slotIndex=eligible[index].slotIndex,box=sourceRect(rect,{width:1920,height:1080},sources.get(next.slots[slotIndex].sourceId));
            const w=Math.max(.01,Math.min(1,box.w/1920)),h=Math.max(.01,Math.min(1,box.h/1080)),
              x=Math.max(0,Math.min(1-w,box.x/1920)),y=rect.y==null?(1-h)/2:Math.max(0,Math.min(1-h,box.y/1080));
            setArrangementPlacement(next,slotIndex,{x,y,w,h,rotation:0});
          });
          const untouched=eligible.slice(zones.length).map(placement=>placement.slotIndex),locked=arrangementPlacements(next).filter(placement=>placement.locked).map(placement=>placement.slotIndex),
            audioOnly=next.slots.flatMap((slot,index)=>sources.get(slot.sourceId)?.audioOnly?[index]:[]);
          return {placed:zones.length,added,untouched,locked,audioOnly,warning:untouched.length?untouched.length+' extra picture slot(s) keep their existing placement.':''};
        },key);
      },
      async setPlacements(items){return update(next=>{
        if(!Array.isArray(items)||items.length>32||new Set(items.map(item=>item?.slotIndex)).size!==items.length)throw Error('Provide each picture slot at most once (up to 32).');
        for(const item of items){sceneSettingsObject(item,['slotIndex','transform'],'picture placement');setArrangementPlacement(next,item.slotIndex,item.transform);}
        const untouched=arrangementPlacements(next).filter(row=>row.editable&&!items.some(item=>item.slotIndex===row.slotIndex)).map(row=>row.slotIndex);
        return {placed:items.length,added:0,untouched,warning:untouched.length?untouched.length+' extra picture slot(s) keep their existing placement.':''};
      });},
      async setAppearance(slotIndex,patch){return update(next=>{
        const slot=next.slots[slotIndex];if(!Number.isInteger(slotIndex)||slotIndex<0||!slot)throw Error('Choose an existing picture slot.');
        if(slot.locked||next.svgParts?.some(part=>part.sourceSlot===slotIndex&&part.locked)||sources.get(slot.sourceId)?.audioOnly)throw Error('Locked pictures and audio-only slots cannot be styled.');
        sceneSettingsObject(patch,['opacity','radius','stroke'],'picture appearance');
        const previous=creativeModule().normalize(slot.creative),changes={...patch};
        if(Object.hasOwn(patch,'stroke')){sceneSettingsObject(patch.stroke,['width','color','style'],'stroke');changes.stroke={...previous.stroke,...patch.stroke};}
        next.slots[slotIndex]={...slot,creative:creativeModule().merge(previous,changes)};
        return {placed:0,added:0,warning:''};
      });},
      async swapSlots(first,second){return update(next=>{
        if(first===second)throw Error('Choose two different picture slots.');const rows=arrangementPlacements(next),a=rows.find(row=>row.slotIndex===first),b=rows.find(row=>row.slotIndex===second);
        if(!a?.editable||!b?.editable)throw Error('Choose two unlocked picture slots.');
        setArrangementPlacement(next,first,b.transform);setArrangementPlacement(next,second,a.transform);return {placed:2,added:0,warning:''};
      });},
      async addEmptyPlacement(transform){let index;await update(next=>{
        if(next.slots.length>=32)throw Error('A scene supports up to 32 source slots.');index=next.slots.length;
        next.slots.push({sourceId:null,mute:false,hidden:false,gain:1,transform:arrangementTransform(transform)});insertArrangementSourceKey(next,index);
        return {placed:1,added:1,warning:''};
      });return index;},
      render(canvas,timeMs){check(false);return renderSceneDraft(canvas,draft,timeMs);},
      async commit(){
        check();if(busy)throw Error('A layout Apply is already being prepared.');busy=true;const request=revision;
        try{
          if(!changed){committed=true;return {scene,report:controller.report,unchanged:true};}
          if(draft.svgParts)await prepareSvgParts(draft);check();if(request!==revision)throw Error('The layout changed while Apply was preparing.');
          const proof=document.createElement('canvas');proof.width=640;proof.height=360;
          const status=renderSceneDraft(proof,draft);if(!status.ok)throw Error(status.why||'Layout artwork could not be drawn.');check();
          const existing=doc.sceneArrangementHistories?.[scene.id]||{undo:[],redo:[]},after=arrangementSnapshot(draft),
            entry={before,after,label:'Arrange scene layout'},history={undo:[...(existing.undo||[]).slice(-19),entry],redo:[]};
          commitArrangement(scene,after,history);committed=true;return {scene,report:controller.report};
        }finally{busy=false;}
      },
      cancel(){cancelled=true;revision++;}
    };
    return controller;
  }
  async function stepSceneArrangement(sceneId,redo=false,{isCurrent=()=>true}={}){
    const scene=svgPartScene(sceneId),history=doc.sceneArrangementHistories?.[sceneId],from=history?.[redo?'redo':'undo'],entry=from?.at(-1);if(!entry)return false;
    const fingerprint=svgPartFingerprint(scene),expected=redo?entry.before:entry.after,next=JSON.parse(svgPartFingerprint(redo?entry.after:entry.before));
    if(svgPartFingerprint(arrangementSnapshot(scene))!==svgPartFingerprint(expected)||!isCurrent())throw Error('This scene changed after that arrangement. Undo was not applied.');
    if(!next||!Object.hasOwn(LAYOUTS,next.layout)||!Array.isArray(next.slots)||next.slots.length>32)throw Error('The saved layout history is invalid.');
    for(const slot of next.slots)if(slot.sourceId&&!sources.has(slot.sourceId))throw Error('A previous source is no longer available. Reconnect it before undoing.');
    const candidate={...snapshotScene(scene,false),...next};
    for(const key of arrangementFields)if(!Object.hasOwn(next,key))delete candidate[key];
    if(candidate.svgParts)await prepareSvgParts(candidate);else if(candidate.fullTemplateId)await svgPartModule().load(candidate.fullTemplateId,{style:candidate.fullTemplateStyle,retry:true});
    if(!isCurrent()||doc.scenes.find(item=>item.id===sceneId)!==scene||svgPartFingerprint(scene)!==fingerprint||doc.sceneArrangementHistories?.[sceneId]!==history||from.at(-1)!==entry)
      throw Error('The selected scene changed while undo was preparing.');
    const proof=document.createElement('canvas');proof.width=640;proof.height=360;const status=renderSceneDraft(proof,candidate);if(!status.ok)throw Error(status.why||'The previous layout could not be drawn.');
    const replacement={undo:[...(history.undo||[])],redo:[...(history.redo||[])]};replacement[redo?'redo':'undo'].pop();replacement[redo?'undo':'redo'].push(entry);
    commitArrangement(scene,next,replacement);return true;
  }
  const undoSceneArrangement=(id,options)=>stepSceneArrangement(id,false,options),redoSceneArrangement=(id,options)=>stepSceneArrangement(id,true,options);
  function addFreeSource(sceneId,sourceId=null) {
    const scene=svgPartScene(sceneId);
    if(scene.layout!=='free'||scene.slots.length>=32)throw Error('Free canvas supports up to 32 source placements.');
    if(sourceId&&!sources.has(sourceId))throw Error('This source is no longer available.');
    const index=scene.slots.length,source=sources.get(sourceId),slot={sourceId,mute:false,hidden:false,gain:1,transform:freeTransform(source?.initialTransform),label:source?.label||'Source '+(index+1),
      ...(source?.sourceType==='generator'?{generator:effectsModule().normalizeGenerator(source.config)}:{})};
    commitFree(scene,{slots:[...scene.slots,slot],freeOrder:[...freeLayers(scene).map(row=>row.key),'source:'+index]});return index;
  }
  // Add Source and generator insertion share a placement transaction, including
  // empty fixed-layout slots. Commit once without touching held Programme.
  function insertSceneSources(scene,ids,{visible=true,slotIndex,sourceLabels=false}={}) {
    if(!doc.scenes.includes(scene)||scene.layoutPending)throw Error('This scene is not available for the new source workflow.');
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>!sources.has(id)))throw Error('Choose available sources.');
    const slots=scene.slots.slice(),indices=[],free=scene.layout==='free',order=free?freeLayers(scene).map(row=>row.key):null;let usedRequested=false;
    if(free&&slotIndex!==undefined&&ids.some(id=>!sources.get(id).audioOnly)&&(!Number.isInteger(slotIndex)||!slots[slotIndex]||slots[slotIndex].sourceId!=null||slots[slotIndex].locked))
      throw Error('Choose an unlocked empty picture slot.');
    for(const id of ids){
      const audioOnly=sources.get(id).audioOnly;let index;
      if(free){index=audioOnly?-1:!usedRequested&&slotIndex!==undefined?slotIndex:slots.findIndex(slot=>slot.sourceId==null&&!slot.locked&&!slot.arrangementUnplaced);
        if(!audioOnly&&slotIndex!==undefined&&!usedRequested)usedRequested=true;
        if(index<0){if(slots.length>=32)throw Error('A free canvas supports up to 32 source placements.');index=slots.length;
          slots.push({mute:false,hidden:false,gain:1,transform:freeTransform(sources.get(id).initialTransform)});order.push('source:'+index);}
      }else index=indices.length===0&&slotIndex!==undefined?slotIndex:slots.findIndex(slot=>slot.sourceId==null);
      if(index<0||!slots[index]||slots[index].sourceId!=null)throw Error('No empty source slot. Choose another slot or switch to Free canvas.');
      slots[index]={...slots[index],sourceId:id,hidden:!visible||free&&slots[index].hidden===true,label:sourceLabels&&(!slots[index].label||/^(Empty source|Source) \d+$/.test(slots[index].label))?sources.get(id).label:slots[index].label||sources.get(id).label,
        ...(sources.get(id).sourceType==='generator'?{generator:effectsModule().normalizeGenerator(sources.get(id).config)}:{}),
        ...(free&&slotIndex===undefined&&sources.get(id).initialTransform?{transform:freeTransform(sources.get(id).initialTransform)}:{})};delete slots[index].arrangementUnplaced;
      if(free&&slotIndex===undefined&&sources.get(id).initialOutputFit)slots[index].outputFit=normalizeOutputFit(sources.get(id).initialOutputFit);
      indices.push(index);
    }
    commitFree(scene,{slots,...(free?{freeOrder:ids.some(id=>sources.get(id).initialLayer==='background')?placedImageOrder(order,slots,scene.svgParts):order}:{})});
    return indices;
  }
  // Assets explicitly offers independent source layers, even on a full template.
  // Prepare a private editable copy first; opening/cancelling the picker never
  // converts the scene. Keep native feed parts so their crop, fit and art survive.
  async function prepareSourceLayerPlacement(scene,{isCurrent=()=>true}={}) {
    if(!doc.scenes.includes(scene)||scene.layoutPending)throw Error('Choose a scene and layout before adding sources.');
    const fingerprint=svgPartFingerprint(scene),check=()=>verifySvgPartCommit(scene,fingerprint,{isCurrent});
    const converting=scene.layout!=='free'||!!scene.fullTemplateId||scene.svgPartsMode==='parts-only';
    const next=scene.fullTemplateId||scene.svgParts!==undefined?splitSvgPartDraft(scene):{slots:scene.slots.slice()};
    const owned=new Set((next.svgParts||[]).map(part=>part.sourceSlot));
    const artworkOnly=!!scene.fullTemplateId||scene.svgPartsMode==='parts-only';
    next.slots=next.slots.map((slot,index)=>({...slot,transform:sourceRectNormalized(scene,index),
      // These placements were not rendered in a template-only mix. Retain them
      // for reuse without unexpectedly showing them when adding a new layer.
      ...(artworkOnly&&!owned.has(index)?{hidden:true}:{})}));
    const parts=next.svgParts||[],sourcesInOrder=next.slots.flatMap((slot,index)=>owned.has(index)?[]:['source:'+index]);
    let prefix=0;
    if(!artworkOnly)while(prefix<parts.length&&svgPartModule().get(parts[prefix].templateId).components.find(c=>c.id===parts[prefix].componentId).type==='background')prefix++;
    next.freeOrder=scene.layout==='free'&&!artworkOnly?freeLayers(scene).map(row=>row.key):[
      ...parts.slice(0,prefix).map(part=>'part:'+part.id),...sourcesInOrder,...parts.slice(prefix).map(part=>'part:'+part.id)];
    next.layout='free';next.sourceWorkflow='obs';
    if(next.svgParts){next.svgPartsMode='overlay';next.svgPartsExtras=sceneExtrasEnabled(scene);await prepareSvgParts(next);}
    check();let committed=false;
    return (ids,{visible=true}={})=>{
      check();if(committed)throw Error('This source placement was already committed.');
      if(!Array.isArray(ids)||!ids.length||ids.some(id=>!sources.has(id)))throw Error('Choose available sources.');
      if(next.slots.length+ids.length>32)throw Error('A free canvas supports up to 32 source placements.');
      const indices=ids.map((id,index)=>next.slots.length+index);
      const slots=[...next.slots,...ids.map(id=>({sourceId:id,mute:false,hidden:!visible,gain:1,transform:freeTransform(sources.get(id).initialTransform),label:sources.get(id).label,
        ...(sources.get(id).initialOutputFit?{outputFit:normalizeOutputFit(sources.get(id).initialOutputFit)}:{}),
        ...(sources.get(id).sourceType==='generator'?{generator:effectsModule().normalizeGenerator(sources.get(id).config)}:{})}))];
      const order=[...next.freeOrder,...indices.map(index=>'source:'+index)];
      commitFree(scene,{...next,slots,freeOrder:ids.some(id=>sources.get(id).initialLayer==='background')?placedImageOrder(order,slots,next.svgParts):order,
        fullTemplateId:undefined,fullTemplateStyle:undefined,fullTemplateExtras:undefined});
      // Old stack history could restore the template-only renderer and hide the
      // new source. Subsequent layer edits build history in the editable canvas.
      if(converting)svgPartHistories.delete(scene.id);
      svgPartRenderErrors.delete(scene.id);committed=true;return indices;
    };
  }
  // Rollback of an uncommitted registration must not write or unbind another scene.
  function discardUnplacedSource(id) {
    const record=sources.get(id);if(!record)return;
    if([...doc.scenes,...(doc.programmeSnapshot?[doc.programmeSnapshot]:[])].some(s=>s.slots.some(slot=>slot.sourceId===id)))throw Error('Cannot discard a placed source.');
    sources.delete(id);try{record._detachAudioEvents?.();}catch(_){}
    try{if(!record._managedStreamLifetime)record.stream?.getTracks().forEach(track=>track.stop());}catch(_){}
    try{record.dispose?.();}catch(_){}
  }
  // Preparing new properties never changes a shared runtime. Replace only this
  // Preview placement; held Programme and other references retain the old ID.
  function replaceSceneSource(scene,index,spec,{expected=scene?.slots?.[index],isCurrent=()=>true}={}) {
    let record;
    try{
      if(!doc.scenes.includes(scene)||scene.layoutPending||!Number.isInteger(index)||!scene.slots[index]||
         scene.slots[index]!==expected||!isCurrent())throw Error('The selected source changed. Open Properties again.');
      const health=sourceStatus(spec);if(!spec||!health.ok)throw Error(health.why||'Prepare a ready source before applying its properties.');
      record=spec.kind==='video'?addMediaSource(spec):addSource(spec);
      if(scene.slots[index]!==expected||!isCurrent())throw Error('The selected source changed. Nothing was applied.');
      commitFree(scene,{slots:scene.slots.map((slot,i)=>{if(i!==index)return slot;const next={...slot,sourceId:record.id};
        if(record.sourceType==='generator')next.generator=effectsModule().normalizeGenerator(record.config);else delete next.generator;return next;})});
      return record;
    }catch(error){if(record)discardUnplacedSource(record.id);else try{spec?.dispose?.();}catch(_){}throw error;}
  }
  function updateFreeSource(sceneId,index,patch) {
    const scene=svgPartScene(sceneId),slot=scene.slots[index];
    if(scene.layout!=='free'||!slot)throw Error('Select a source in a free-canvas scene.');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['transform','hidden','mute'].includes(key)))throw Error('Unsupported source setting.');
    const hasTransform=Object.hasOwn(patch,'transform');
    if(hasTransform&&(!patch.transform||typeof patch.transform!=='object'||Array.isArray(patch.transform)))throw Error('Invalid source transform.');
    if(scene.sourceWorkflow==='obs'&&slot.locked&&hasTransform)throw Error('Unlock this source before changing its transform.');
    if(scene.sourceWorkflow==='obs'&&sources.get(slot.sourceId)?.audioOnly&&hasTransform)throw Error('Audio-only sources have no canvas transform.');
    const next={...slot,...patch};let poseChanged=false;
    if(hasTransform){
      next.transform=freeTransform(patch.transform);const before=freeTransform(slot.transform);
      poseChanged=Object.keys(before).some(key=>before[key]!==next.transform[key]);
      if(!poseChanged){if(Object.hasOwn(slot,'transform'))next.transform=slot.transform;else delete next.transform;}
    }
    for(const key of ['hidden','mute'])if(typeof next[key]!=='boolean')throw Error('Invalid source visibility or audio setting.');
    if(svgPartFingerprint(next)===svgPartFingerprint(slot))return true;
    const result=commitFree(scene,{slots:scene.slots.map((value,i)=>i===index?next:value)});
    if(poseChanged)recordCreativeHistory(scene,'source:'+index,slot,next);return result;
  }
  // New-scene item operations never mutate a shared capture or held Programme.
  function obsSceneItem(sceneId,index) {
    const scene=svgPartScene(sceneId);
    if(scene.sourceWorkflow!=='obs'||scene.layout!=='free')throw Error('These source controls apply only to new blank scenes.');
    if(index!==undefined&&!scene.slots[index])throw Error('The source item is no longer available.');
    return scene;
  }
  function updateSourceItem(sceneId,index,patch) {
    const scene=obsSceneItem(sceneId,index),slot=scene.slots[index];
    if(!patch||Object.keys(patch).some(k=>!['label','locked'].includes(k)))throw Error('Unsupported source item setting.');
    if(patch.locked!==undefined&&typeof patch.locked!=='boolean')throw Error('Invalid source lock setting.');
    if(patch.label!==undefined&&(typeof patch.label!=='string'||!patch.label.trim()||patch.label.trim().length>120||/[\u0000-\u001f]/.test(patch.label)))throw Error('Use an item name of 1–120 characters.');
    const next={...slot,...patch,...(patch.label!==undefined?{label:patch.label.trim()}:{})};
    return commitFree(scene,{slots:scene.slots.map((s,i)=>i===index?next:s)});
  }
  function duplicateSourceItem(sceneId,index) {
    const scene=obsSceneItem(sceneId,index);
    if(scene.slots.length>=32)throw Error('A free canvas supports up to 32 source placements.');
    const next=scene.slots.length,slot=JSON.parse(JSON.stringify(scene.slots[index]));
    slot.label=(slot.label||sources.get(slot.sourceId)?.label||'Source').slice(0,113)+' (copy)';
    const order=freeLayers(scene).map(row=>row.key);order.splice(order.indexOf('source:'+index)+1,0,'source:'+next);
    commitFree(scene,{slots:[...scene.slots,slot],freeOrder:order});return next;
  }
  function reorderSourceItems(sceneId,keys) {
    const scene=obsSceneItem(sceneId),existing=freeLayers(scene).map(row=>row.key);
    if(!Array.isArray(keys)||keys.length!==existing.length||new Set(keys).size!==keys.length||keys.some(key=>!existing.includes(key)))throw Error('The source stack changed. Try again.');
    for(const row of freeLayers(scene))if((row.slot?.locked||row.part?.locked)&&keys.indexOf(row.key)!==existing.indexOf(row.key))throw Error('Unlock this item before rearranging it.');
    commitSvgParts(scene,{...svgPartSnapshot(scene),freeOrder:[...keys]},'Reorder scene layers');return true;
  }
  function moveFreeLayer(sceneId,key,direction) {
    const scene=svgPartScene(sceneId);if(scene.layout!=='free')throw Error('Choose Free canvas first.');
    const order=freeLayers(scene).map(row=>row.key),from=order.indexOf(key);
    if(from<0||!['front','forward','backward','back'].includes(direction))throw Error('Select a scene layer.');
    const to=direction==='front'?order.length-1:direction==='back'?0:Math.max(0,Math.min(order.length-1,from+(direction==='forward'?1:-1)));
    const rows=freeLayers(scene);if(rows.some(row=>(row.slot?.locked||row.part?.locked)&&order.indexOf(row.key)>=Math.min(from,to)&&order.indexOf(row.key)<=Math.max(from,to))&&from!==to)throw Error('Unlock the affected items before rearranging them.');
    order.splice(from,1);order.splice(to,0,key);
    commitSvgParts(scene,{...svgPartSnapshot(scene),freeOrder:order},'Reorder scene layers');return true;
  }
  function removeFreeSource(sceneId,index) {
    const scene=svgPartScene(sceneId);if(scene.layout!=='free'||!scene.slots[index])return false;
    if(scene.svgParts?.some(part=>part.sourceSlot===index))throw Error('Remove the source frame artwork first.');
    const freeOrder=freeLayers(scene).map(row=>row.key).filter(key=>key!=='source:'+index).map(key=>key.startsWith('source:')&&Number(key.slice(7))>index?'source:'+(Number(key.slice(7))-1):key);
    const patch={slots:scene.slots.filter((_,i)=>i!==index),freeOrder};
    if(scene.svgParts)patch.svgParts=scene.svgParts.map(part=>Number.isInteger(part.sourceSlot)&&part.sourceSlot>index?{...part,sourceSlot:part.sourceSlot-1}:part);
    commitFree(scene,patch);svgPartHistories.delete(scene.id);creativeHistories.delete(scene.id);return true;
  }
  function bind(sceneId, slotIndex, sourceId) {
    const s = doc.scenes.find(x => x.id === sceneId); if (!s || s.layoutPending) return false;
    const sl = s.slots[slotIndex]; if (!sl) return false;
    const previous=sl.sourceId,previousGenerator=sl.generator;sl.sourceId=sourceId||null;
    if(sources.get(sourceId)?.sourceType==='generator')sl.generator=effectsModule().normalizeGenerator(sources.get(sourceId).config);else delete sl.generator;
    if(!save()){sl.sourceId=previous;if(previousGenerator===undefined)delete sl.generator;else sl.generator=previousGenerator;return false;}return true;
  }
  function setSlotGain(sceneId, slotIndex, value) {
    const s = doc.scenes.find(x => x.id === sceneId); if (!s) return false;
    const sl = s.slots[slotIndex]; if (!sl) return false;
    sl.gain = Math.max(0, Math.min(2, Number(value) || 0));
    save(); syncMix(); return true;
  }
  function setSlotMute(sceneId, slotIndex, muted) {
    const s = doc.scenes.find(x => x.id === sceneId); if (!s) return false;
    const sl = s.slots[slotIndex]; if (!sl) return false;
    sl.mute = !!muted; save(); syncMix(); return true;
  }

  /* ---- browser-source scene relationships -----------------------------
     The widget library is show-wide; these records are scene-owned
     placements. Deleting a saved widget therefore cascades through every
     scene, while hiding/reordering/resizing affects only this scene. */
  function addWidget(sceneId, assetId) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    const widgets = window.OpenLiveWidgets;
    if (!scene || !widgets || !widgets.has(assetId)) return null;
    if (!Array.isArray(scene.widgets)) scene.widgets = [];
    const existing = scene.widgets.find(layer => layer.assetId === assetId);
    if (existing) return existing;
    const limit = Number(widgets.MAX_SCENE) || 5;
    if (scene.widgets.length >= limit) return null;
    const layer = normalizeWidgetLayer({
      id: uid('wl'), assetId, x: 0, y: 0, w: 1, h: 1,
      opacity: 1, visible: true
    });
    scene.widgets.push(layer); save(); return layer;
  }
  function removeWidget(sceneId, layerId) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    if (!scene || !Array.isArray(scene.widgets)) return false;
    const index = scene.widgets.findIndex(layer => layer.id === layerId);
    if (index < 0) return false;
    scene.widgets.splice(index, 1); save(); return true;
  }
  function removeWidgetAssetEverywhere(assetId) {
    let removed = 0;
    doc.scenes.forEach(scene => {
      const before = Array.isArray(scene.widgets) ? scene.widgets.length : 0;
      scene.widgets = (scene.widgets || []).filter(layer => layer.assetId !== assetId);
      removed += before - scene.widgets.length;
    });
    if (removed) save();
    return removed;
  }
  function setWidgetVisible(sceneId, layerId, visible) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    const layer = scene && (scene.widgets || []).find(row => row.id === layerId);
    if (!layer) return false;
    layer.visible = !!visible; save(); return true;
  }
  function setWidgetRect(sceneId, layerId, rect, commit = true) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    const layer = scene && (scene.widgets || []).find(row => row.id === layerId);
    if (!layer) return false;
    const w = clamp(rect && rect.w, .04, 1, layer.w);
    const h = clamp(rect && rect.h, .04, 1, layer.h);
    const next = { w, h,
      x:clamp(rect && rect.x, 0, 1 - w, layer.x),
      y:clamp(rect && rect.y, 0, 1 - h, layer.y) };
    if (rect && Object.prototype.hasOwnProperty.call(rect, 'opacity')) {
      next.opacity = clamp(rect.opacity, 0, 1, layer.opacity);
    }
    const previous = { ...layer };
    Object.assign(layer, next);
    if (commit && !save()) {
      // Keep the existing scene/layer objects alive for drag handles and callers.
      // A failed durable placement must not claim success or remain on Programme.
      for (const key of Object.keys(next)) {
        if (Object.prototype.hasOwnProperty.call(previous, key)) layer[key] = previous[key];
        else delete layer[key];
      }
      return false;
    }
    return true;
  }
  function moveWidget(sceneId, layerId, direction) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    if (!scene || !Array.isArray(scene.widgets)) return false;
    const from = scene.widgets.findIndex(layer => layer.id === layerId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(scene.widgets.length - 1,
      from + (Number(direction) < 0 ? -1 : 1)));
    if (to === from) return false;
    const layer = scene.widgets.splice(from, 1)[0];
    scene.widgets.splice(to, 0, layer); save(); return true;
  }
  function widgetLayer(sceneId, layerId) {
    const scene = doc.scenes.find(x => x.id === sceneId);
    return scene && (scene.widgets || []).find(layer => layer.id === layerId) || null;
  }
  function visibleEffectFailure(scene,aspect='16x9'){
    if(!scene)return null;
    const count=sceneRects(scene,aspect).length;
    for(const [index,slot] of (scene.slots||[]).entries()){
      if(!slot||slot.hidden||slot.arrangementUnplaced||!slot.sourceId||!slot.generator&&!slot.effects?.length)continue;
      const source=sceneSource(scene,slot.sourceId);if(!source||source.audioOnly)continue;
      const linked=(scene.svgParts||[]).filter(part=>part.sourceSlot===index);
      if(linked.length?!linked.some(part=>{const style=part.style?.components?.[part.componentId]||{};return style.visible!==false&&style.opacity!==0;}):scene.svgPartsMode==='parts-only'||index>=count)continue;
      try{const state=effectsModule().status(slot);if(!state.ok)return state.reason;}
      catch(error){return error.message||String(error);}
    }
    return null;
  }
  function hasVisual(scene, aspect) {
    if (!scene) return false;
    if(visibleEffectFailure(scene,aspect))return false;
    const parts=svgPartsStatus(scene,true);
    if(parts&&parts.state!=='ready')return false;
    if(parts&&parts.visible)return true;
    const fullTemplate = fullTemplateStatus(scene, true);
    if (fullTemplate) return fullTemplate.state === 'ready';
    const usedParts=new Set((scene.svgParts||[]).map(part=>part.sourceSlot));
    const local = scene.svgPartsMode!=='parts-only'&&(scene.slots || []).slice(0, sceneRects(scene, aspect).length)
      .some((slot,index) => !usedParts.has(index)&&slot && !slot.hidden && !slot.arrangementUnplaced && !sceneSource(scene,slot.sourceId)?.audioOnly && sourceStatus(sceneSource(scene,slot.sourceId)).ok);
    if (local || hasOverlay(scene)) return true;
    const graphics = sceneExtrasEnabled(scene)&&window.OpenLiveGraphics;
    if (graphics) {
      const options = renderOptions(scene);
      const activeGraphics = typeof graphics.activeRenderInfo === 'function'
        ? ['background', 'overlay', 'logo'].map(type =>
            graphics.activeRenderInfo(type, options)).filter(Boolean)
        : typeof graphics.activeStatus === 'function'
          ? (() => { const status = graphics.activeStatus(options); return status
            ? [status.background, status.overlay, status.logo].filter(Boolean) : []; })()
          : [];
      for (const asset of activeGraphics) {
        const image = asset.state
          ? asset
          : typeof graphics.imageStatus === 'function'
            ? graphics.imageStatus(asset.id) : { state:'ready' };
        if (image.state === 'ready') return true;
        if (image.state === 'idle' && typeof graphics.decode === 'function') {
          try { const pending = graphics.decode(asset.id); if (pending && pending.catch) pending.catch(() => {}); } catch (_) {}
        }
      }
    }
    if (aspect === '9x16') return false;
    const widgets = sceneExtrasEnabled(scene)&&window.OpenLiveWidgets;
    return !!(widgets && (scene.widgets || []).some(layer =>
      layer.visible !== false && Number(layer.opacity) !== 0 && (scene.renderState?.widgets?.[layer.assetId] || widgets.has(layer.assetId))));
  }

  function hasOverlay(scene) {
    if (!scene || !sceneExtrasEnabled(scene)) return false;
    const o = scene.overlays || {}, captions = window.OpenLiveCaptions;
    const caption = captions && typeof captions.draw === 'function' &&
      typeof captions.activeStatus === 'function' ? scene.renderState?.captions || captions.activeStatus() : {};
    if (caption.lowerThird || caption.ticker ||
        (!caption.lowerThird && o.lower && o.lower.on && (o.lower.line1 || o.lower.line2)) ||
        (o.countdown && o.countdown.on && o.countdown.endsAt)) return true;
    if (o.logo && o.logo.on && o.logo._img && sourceStatus({el:o.logo._img}).ok) {
      const graphics = window.OpenLiveGraphics;
      const mark = graphics && typeof graphics.activeRenderInfo === 'function'
        ? graphics.activeRenderInfo('logo', renderOptions(scene)) : null;
      if (!mark || mark.state === 'error') return true;
    }
    const commerce = window.OpenLiveCommerce;
    return !!(commerce && typeof commerce.draw === 'function' && typeof window.qrcode === 'function' &&
      typeof commerce.activeRenderInfo === 'function' && (scene.renderState?.commerce?.status || commerce.activeRenderInfo()).state === 'visible');
  }

  // Readiness belongs to the requested face and visible wording, rather than
  // the saved scene. A restored caption must not silently paint a fallback.
  const themeFontPreparations=new WeakMap();
  function sceneThemeFontRequest(scene) {
    if(!scene||!sceneExtrasEnabled(scene))return null;
    const module=window.OpenLiveTheme,profile=scene.renderState?.theme||currentTheme();
    if(!profile.fontId||typeof module?.fontStatus!=='function')return null;
    const text=[],o=scene.overlays||{},captions=window.OpenLiveCaptions;
    const caption=typeof captions?.draw==='function'&&typeof captions.activeStatus==='function'
      ? scene.renderState?.captions||captions.activeStatus():{};
    if(caption.lowerThird)text.push(caption.lowerThird.line1||'',caption.lowerThird.line2||'');
    else if(o.lower?.on&&(o.lower.line1||o.lower.line2))text.push(o.lower.line1||'',o.lower.line2||'');
    if(caption.ticker)text.push(caption.ticker.text||'',profile.id==='news'?profile.tickerLabel||'':'');
    if(o.countdown?.on&&o.countdown.endsAt)text.push('0123456789:');
    const commerce=window.OpenLiveCommerce;
    if(typeof commerce?.draw==='function'&&typeof window.qrcode==='function'){
      const status=scene.renderState?.commerce?.status||commerce.activeTypography?.()||commerce.activeStatus?.();
      if(status?.state==='visible'){const asset=status.asset||status;
        text.push(asset.title||'',asset.callToAction||'');
        if(asset.type==='product')text.push(asset.price||'');
        else if(profile.id!=='news'){
          let target=String(status.target||'');
          try{const url=new URL(target);if(url.protocol==='http:'||url.protocol==='https:')target=url.hostname+(url.pathname==='/'?'':url.pathname);}catch(_){}
          text.push(target.slice(0,58));
        }
      }
    }
    if(!text.length)return null;
    // Only glyph coverage matters to the loader. Keep long QR destinations or
    // repeated tickers from expanding its bounded sample unnecessarily.
    const sample=[...new Set(Array.from(text.join(' ')))].join('');
    return {module,profile,fontId:profile.fontId,text:sample};
  }
  function startSceneThemeFont(request, retry=false) {
    const {module,profile,fontId,text}=request;
    let pending=themeFontPreparations.get(module);
    if(!pending){pending=new Map();themeFontPreparations.set(module,pending);}
    const key=JSON.stringify([fontId,[...new Set(Array.from(text).filter(char=>char.codePointAt(0)>255))].sort().join('')]);
    const existing=pending.get(key);if(existing)return existing;
    const status=module.fontStatus(fontId,{text});
    if(!retry&&status.state==='failed')return Promise.reject(Error(status.error||'The requested Theme font could not be loaded.'));
    const promise=Promise.resolve().then(()=>{
      if(typeof module.prepareProfile!=='function')throw Error('The Theme font loader is unavailable.');
      return module.prepareProfile(profile,{text});
    });
    pending.set(key,promise);
    // A frame never retries failures. An explicit Cut/Fade may retry once.
    promise.then(()=>pending.delete(key),()=>pending.delete(key));
    return promise;
  }
  function sceneThemeFontStatus(scene) {
    const request=sceneThemeFontRequest(scene);
    if(!request)return {ok:true,state:'unneeded',required:false,why:''};
    const {module,fontId,text}=request;
    let status;try{status=module.fontStatus(fontId,{text});}
    catch(error){status={state:'failed',error:error.message||String(error)};}
    if(status.state==='idle'){
      if(typeof module.prepareProfile!=='function')status={state:'failed',error:'The Theme font loader is unavailable.'};
      else {startSceneThemeFont(request).catch(()=>{});status={...status,state:'loading'};}
    }
    const ok=status.state==='ready'||status.state==='system';
    return {ok,state:status.state,required:true,fontId,why:ok?'':status.state==='failed'
      ? 'The Theme font could not be loaded: '+(status.error||'font preparation failed')+'. Programme is unchanged.'
      : 'Waiting for the Theme font to finish loading before taking its text to Programme.'};
  }
  async function prepareSceneThemeFont(scene) {
    const request=sceneThemeFontRequest(scene);if(!request)return;
    try{await startSceneThemeFont(request,true);}
    catch(error){throw Error('The Theme font could not be loaded: '+(error.message||String(error))+'. Programme is unchanged.');}
    const status=sceneThemeFontStatus(scene);if(!status.ok)throw Error(status.why);
  }

  /* Authoritative preflight for the surface actually rendered by Studio.
     Pending visible widgets still block landscape, even when a camera is ready. */
  function visualStatus(scene, aspect) {
    const raster = aspect === '9x16' ? '9x16' : '16x9';
    if (!scene) return {ok:false, why:'There is no active Studio scene.'};
    const themeFont=sceneThemeFontStatus(scene);if(!themeFont.ok)return themeFont;
    const effectError=visibleEffectFailure(scene,raster);if(effectError)return {ok:false,why:'A source effect or generator cannot be drawn: '+effectError};
    const parts=svgPartsStatus(scene,true);
    if(parts&&parts.state!=='ready')return {ok:false,why:parts.state==='failed'?'An SVG layer cannot be drawn: '+parts.error:'Waiting for the independent SVG layers to finish preparing before Go Live.'};
    const fullTemplate = fullTemplateStatus(scene, true);
    if (fullTemplate && fullTemplate.state !== 'ready') return {ok:false, why:fullTemplate.state === 'failed'
      ? 'The full template cannot be drawn: ' + (fullTemplate.error || 'artwork preparation failed')
      : 'Waiting for the full template artwork to finish preparing before Go Live.'};
    const templateReady = !!fullTemplate||!!(parts&&parts.visible);
    const usedParts=new Set((scene.svgParts||[]).map(part=>part.sourceSlot));
    const sourceStates = (scene.svgPartsMode==='parts-only'?[]:(scene.slots || []).slice(0, sceneRects(scene, raster).length))
      .filter((slot,index) => !usedParts.has(index)&&slot && !slot.hidden && !slot.arrangementUnplaced && slot.sourceId && !sceneSource(scene,slot.sourceId)?.audioOnly).map(slot => sourceStatus(sceneSource(scene,slot.sourceId)));
    const local = sourceStates.some(status => status.ok), overlay = hasOverlay(scene);
    const extras = sceneExtrasEnabled(scene), graphics = window.OpenLiveGraphics;
    const assets = extras && graphics && typeof graphics.activeRenderInfo === 'function'
      ? ['background','overlay','logo'].map(type => graphics.activeRenderInfo(type, renderOptions(scene))).filter(Boolean) : [];
    assets.forEach(asset => {
      if (asset.state === 'idle' && typeof graphics.decode === 'function') {
        try { const pending = graphics.decode(asset.id); if (pending && pending.catch) pending.catch(() => {}); } catch (_) {}
      }
    });
    const ready = assets.some(asset => asset.state === 'ready');
    const pending = assets.filter(asset => asset.state === 'idle' || asset.state === 'loading');
    const failed = assets.find(asset => asset.state === 'error');
    const widgets = window.OpenLiveWidgets;
    const layers = extras && widgets ? (scene.widgets || []).filter(layer => layer.visible !== false &&
      Number(layer.opacity) !== 0 && Number(layer.x || 0) < 1 && Number(layer.y || 0) < 1 && (scene.renderState?.widgets?.[layer.assetId] || widgets.has(layer.assetId))) : [];
    const warning = sourceStates.find(status => status.warning);
    if (layers.length && raster === '9x16') {
      if (local || overlay || ready || templateReady) return {ok:true, via:'studio', warning:
        'Browser widgets appear on landscape only.' + (warning ? ' ' + warning.warning : '')};
      if (!pending.length) return {ok:false, why:'This scene contains only browser widgets, which are landscape-only. Add a portrait source or turn this destination Off.'};
    } else if (layers.length) {
      const waiting = layers.map(layer => widgets.runtimeStatus(layer.assetId,scene.renderState?.widgets)).filter(status => status.state !== 'ready');
      if (waiting.length) {
        const error = waiting.find(status => status.state === 'failed');
        return {ok:false, why:error ? 'A visible widget failed to render: ' + (error.reason || 'unknown renderer error')
          : 'Waiting for ' + waiting.length + ' visible widget' + (waiting.length === 1 ? '' : 's') + ' to render before Go Live.'};
      }
    }
    if (local || overlay || ready || templateReady || (layers.length && raster === '16x9'))
      return Object.assign({ok:true, via:'studio'}, warning ? {warning:warning.warning} : {});
    if (pending.length) return {ok:false, why:'Waiting for ' + pending.length + ' visible graphic' +
      (pending.length === 1 ? '' : 's') + ' to finish preparing before Go Live.'};
    if (failed) return {ok:false, why:'A visible graphic cannot be drawn: ' + (failed.error || 'image decode failed')};
    const unavailable = sourceStates.find(status => !status.ok);
    return {ok:false, why:unavailable ? unavailable.why :
      'Nothing to encode yet. Bind a source, add a browser widget, or show a graphic, caption or QR card.'};
  }

  /* ---- compositor -------------------------------------------------------- */
  const canvases = new Map();          /* aspect -> programme canvas */
  const frameRevisions = new Map();    /* completed paints, independent of driver callbacks */
  const transitionCanvases = new Map();
  let transition = null;
  let widgetPreviewSceneId = null;
  let sceneMonitorIds = new Set();
  let raf = 0, running = false, drawn = 0, lastAt = 0, fps = 0;

  function setWidgetPreviewScene(id) {
    widgetPreviewSceneId = doc.scenes.some(scene => scene.id === id) ? id : null;
  }
  function setSceneMonitorScenes(ids) {
    sceneMonitorIds = new Set((ids || []).filter(id => doc.scenes.some(scene => scene.id === id)));
  }
  function reconcileWidgets() {
    const widgets = window.OpenLiveWidgets;
    if (!widgets || typeof widgets.reconcile !== 'function') return;
    const ids = new Set();
    const sceneIds = new Set([previewWorkflow ? null : doc.activeId, widgetPreviewSceneId, ...sceneMonitorIds]);
    if (transition) { sceneIds.add(transition.fromId); sceneIds.add(transition.toId); }
    doc.scenes.forEach(scene => {
      if (!sceneIds.has(scene.id) || !sceneExtrasEnabled(scene) || previewWorkflow&&scene.renderState?.widgets) return;
      (scene.widgets || []).forEach(layer => {
        if (layer.visible !== false) ids.add(layer.assetId);
      });
    });
    // Programme and transition runtimes keep priority over the rail multiview.
    const snapshots = previewWorkflow ? [active(),transition?.from,transition?.to,doc.scenes.find(scene=>scene.id===widgetPreviewSceneId),
      ...doc.scenes.filter(scene=>sceneMonitorIds.has(scene.id)&&scene.id!==widgetPreviewSceneId)]
      .filter(scene=>scene&&sceneExtrasEnabled(scene)).map(scene=>Object.fromEntries((scene.widgets||[])
        .filter(layer=>layer.visible!==false&&Number(layer.opacity)!==0)
        .map(layer=>[layer.assetId,scene.renderState?.widgets?.[layer.assetId]]).filter(([,asset])=>asset))) : [];
    widgets.reconcile([...ids],snapshots);
  }

  function canvas(aspect) {
    const a = ASPECTS[aspect] ? aspect : '16x9';
    if (!canvases.has(a)) {
      const cv = document.createElement('canvas');
      cv.width = ASPECTS[a].w; cv.height = ASPECTS[a].h;
      // Programme frames always have an opaque black backdrop. Declare that
      // when creating the context so capture and display avoid alpha handling.
      cv.getContext('2d', {alpha:false});
      canvases.set(a, cv);
      frameRevisions.set(a, 0);
    }
    return canvases.get(a);
  }

  function frameInfo(aspect) {
    const a = ASPECTS[aspect] ? aspect : '16x9', cv = canvas(a);
    return {canvas:cv, aspect:a, stamp:frameRevisions.get(a), width:cv.width, height:cv.height};
  }

  /* Source output scaling and native SVG feed parts can fit, fill (crop), or
     stretch. Existing source placements default to contain. */
  function fit(sw, sh, rx, ry, rw, rh, mode = 'contain') {
    if (!sw || !sh) return null;
    if (mode === 'stretch') return {x:rx,y:ry,w:rw,h:rh};
    const sa = sw / sh, ra = rw / rh;
    let w = rw, h = rh;
    if ((sa > ra) !== (mode === 'cover')) h = rw / sa; else w = rh * sa;
    return { x: rx + (rw - w) / 2, y: ry + (rh - h) / 2, w, h };
  }
  function sourcePictureGeometry(slot,src,r,cv,native=null) {
    const sz=sizeOf(src),output=sourceRect(r,cv,src),input=slot.inputSelection,
      sw=sz.w*(input?.w??1),sh=sz.h*(input?.h??1),requestedFit=slot.outputFit??(native?r.fit:undefined),
      mode=['off','cover','stretch'].includes(requestedFit)?requestedFit:'contain';
    let box;
    if(mode==='off'){
      // Auto Size Off keeps selected media at native dimensions at 100%
      // manual scale. The logical Programme raster, not thumbnail resolution,
      // determines what one source pixel means. Width/height remain manual
      // X/Y scale controls around the authored output center.
      const reference=cv.width>=cv.height?ASPECTS['16x9']:ASPECTS['9x16'],logical=src._sourcePictureSize||sz,
        w=logical.w*(input?.w??1)*output.w/reference.w,h=logical.h*(input?.h??1)*output.h/reference.h;
      box=sw&&sh?{x:output.x+(output.w-w)/2,y:output.y+(output.h-h)/2,w,h}:null;
    }else box=fit(sw/(r.postScaleX||1),sh/(r.postScaleY||1),output.x,output.y,output.w,output.h,mode);
    const x=box?Math.max(output.x,box.x):output.x,y=box?Math.max(output.y,box.y):output.y;
    const picture=box?{x,y,w:Math.max(0,Math.min(output.x+output.w,box.x+box.w)-x),h:Math.max(0,Math.min(output.y+output.h,box.y+box.h)-y)}:output;
    return {sz,input,sw,sh,output,mode,box,picture,native};
  }
  // Picture bounds are independent of creative crop/flip/animation. Keeping
  // this query pure lets guides and picking use the compositor's exact fit.
  function sourcePictureRectNormalized(scene,index,aspect='16x9') {
    const slot=scene?.slots?.[index];if(!slot)throw Error('Select an existing source.');
    const size=ASPECTS[aspect]||ASPECTS['16x9'],cv={width:size.w,height:size.h},r=sourceRectNormalized(scene,index,aspect),
      src=sceneSource(scene,slot.sourceId),box=sourcePictureGeometry(slot,src,r,cv).picture;
    return {x:box.x/cv.width,y:box.y/cv.height,w:box.w/cv.width,h:box.h/cv.height,rotation:r.rotation||0};
  }

  // Both the compositor and the Preview-only DOM guides use these exact bounds.
  function sourceRect(r, cv, src) {
    const sz = sizeOf(src), w = r.w * cv.width;
    const h = r.h == null ? w / (sz.w && sz.h ? sz.w / sz.h : cv.width / cv.height) : r.h * cv.height;
    return {x:r.x * cv.width, y:r.y == null ? (cv.height-h)/2 : r.y * cv.height, w, h};
  }
  function layoutSlots(scene, aspect = '16x9') {
    if (!scene || scene.fullTemplateId || scene.svgPartsMode === 'parts-only') return [];
    const size = ASPECTS[aspect] || ASPECTS['16x9'], cv = {width:size.w,height:size.h};
    const owned = new Set((scene.svgParts || []).map(part => part.sourceSlot));
    return sceneRects(scene,aspect).flatMap((r,index) => {
      if (owned.has(index)) return [];
      const slot = scene.slots[index], src = slot && sceneSource(scene,slot.sourceId), box = sourceRect(r,cv,src);
      const status = src ? sourceStatus(src) : {state:'empty',ok:false};
      return [{index,x:box.x/cv.width,y:box.y/cv.height,w:box.w/cv.width,h:box.h/cv.height,
        state:slot?.arrangementUnplaced?'unplaced':slot?.hidden ? 'hidden' : status.state, ready:!!status.ok && !slot?.hidden&&!slot?.arrangementUnplaced, label:src?.label || ''}];
    });
  }
  function paintSource(ctx,cv,scene,r,index,nativeTemplateId=null,timeMs=0,raw=false,preparedSource=null) {
    const slot = scene.slots[index];let src=preparedSource||(slot&&slot.sourceId?sceneSource(scene,slot.sourceId):null);
    if (!slot || r.hidden || slot.hidden || slot.arrangementUnplaced) return false;
    if(!src){
      // A configured empty zone is real frame artwork, without a pretend source
      // or operator placeholder. Binding a picture later retains this appearance.
      if(slot.sourceId==null&&!raw&&slot.creative?.stroke?.width){const box=sourceRect(r,cv,null);
        creativeModule().paint(ctx,cv,{x:box.x/cv.width,y:box.y/cv.height,w:box.w/cv.width,h:box.h/cv.height,rotation:r.rotation||0},
          {...slot.creative,erase:[]},timeMs,()=>false);}
      return false;
    }
    if(!preparedSource&&typeof src.renderFrame==='function'){
      try{src.renderFrame(timeMs);}catch(_){return false;}
    }
    if (src.audioOnly || !sourceStatus(src).ok) return false;
    if(!preparedSource)src=sourceVisualFrame(src,timeMs);
    if(!preparedSource&&(slot.generator||slot.effects?.length)){try{src=effectsModule().render(slot,src,timeMs);}catch(_){return false;}}
    const {sz,input,sw,sh,output,mode,box,picture,native}=sourcePictureGeometry(slot,src,r,cv,scene.fullTemplateId||nativeTemplateId);
    if(!box)return false;
    if(slot.creative&&!raw)return creativeModule().paint(ctx,cv,{x:output.x/cv.width,y:output.y/cv.height,w:output.w/cv.width,h:output.h/cv.height,rotation:r.rotation||0},slot.creative,timeMs,
      layer=>paintSource(layer,cv,scene,r,index,nativeTemplateId,timeMs,true,src),native?undefined:{pictureBounds:{x:picture.x/cv.width,y:picture.y/cv.height,w:picture.w/cv.width,h:picture.h/cv.height}});
    const {x:rx,y:ry,w:rw,h:rh}=output;
    // Height-less ordinary slots derive their height from the real source's
    // aspect; native SVG frame heights are always explicit.
    const radius = native && Number(r.radius) > 0
      ? Math.min(Number(r.radius)*Math.min(cv.width,cv.height),rw/2,rh/2) : 0;
    const scoped = !!(src.mirror || radius || native || r.rotation || mode==='cover' || mode==='off');
    if (scoped) ctx.save();
    try {
      if(r.rotation){ctx.translate(rx+rw/2,ry+rh/2);ctx.rotate(r.rotation*Math.PI/180);ctx.translate(-rx-rw/2,-ry-rh/2);}
      if (native && typeof window.OpenLiveFullTemplates.board === 'function') {
        const board = window.OpenLiveFullTemplates.board(native,cv);
        ctx.beginPath(); ctx.rect(board.x,board.y,board.width,board.height); ctx.clip();
      }
      if (radius || mode === 'cover' || mode === 'off') {
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(rx,ry,rw,rh,radius); else ctx.rect(rx,ry,rw,rh);
        ctx.clip();
      }
      const dx=src.mirror?0:box.x,dy=src.mirror?0:box.y;
      if(src.mirror){ctx.translate(box.x+box.w,box.y);ctx.scale(-1,1);}
      if(input)ctx.drawImage(src.el,(src.mirror?1-input.x-input.w:input.x)*sz.w,input.y*sz.h,sw,sh,dx,dy,box.w,box.h);
      else ctx.drawImage(src.el,dx,dy,box.w,box.h);
    } catch (_) { /* A not-yet-decodable frame is skipped, never fabricated. */ }
    finally { if (scoped) ctx.restore(); }
    return true;
  }

  function paint(cv, aspect, scene, timeMs) {
    const ctx = cv.getContext('2d');
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const graphics = window.OpenLiveGraphics;
    if (sceneExtrasEnabled(scene) && graphics && typeof graphics.drawBackground === 'function')
      graphics.drawBackground(ctx, cv, {
        aspect, ...renderOptions(scene), timeMs:Number(timeMs) || 0
      });
    if (!scene) { ctx.restore(); return; }
    if(scene.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only'){
      const status=svgPartsStatus(scene,true);
      if(status&&status.state!=='ready'){ctx.restore();return;}
      try{
        let overlaysDrawn=false;
        for(const row of freeLayers(scene)){
          if(!overlaysDrawn&&scene.arrangementOverlayBefore&&row.part?.id===scene.arrangementOverlayBefore&&sceneExtrasEnabled(scene)){
            drawOverlays(ctx,cv,scene,aspect,timeMs);overlaysDrawn=true;}
          if(row.slot){paintSource(ctx,cv,scene,sourceRectNormalized(scene,row.index,aspect),row.index,null,timeMs);continue;}
          const part=row.part,change=part.style.components?.[part.componentId]||{};
          if(change.visible===false||change.opacity===0)continue;
          const draw=layer=>drawSceneSvgPart(part,layer,cv,scene,timeMs);
          const result=part.creative?creativeModule().paint(ctx,cv,partRectNormalized(part,cv),part.creative,timeMs,draw):draw(ctx);
          if(result?.state!=='drawn')throw Error(result?.error||'The layer could not be drawn.');
        }
        if(!overlaysDrawn&&sceneExtrasEnabled(scene))drawOverlays(ctx,cv,scene,aspect,timeMs);
      }catch(error){svgPartRenderErrors.set(scene.id,{parts:scene.svgParts,error:error.message});}
      ctx.restore();return;
    }
    if(scene.svgParts!==undefined){
      const status=svgPartsStatus(scene,true);
      if(!status||status.state!=='ready'){ctx.restore();return;}
      try{
        const parts=validatedSvgParts(scene),module=svgPartModule(),used=new Set(parts.map(part=>part.sourceSlot));
        const drawLayer=part=>{
          const change=part.style.components&&part.style.components[part.componentId]||{};
          if(change.visible===false||change.opacity===0)return;
          const draw=layer=>drawSceneSvgPart(part,layer,cv,scene,timeMs);
          const result=part.creative?creativeModule().paint(ctx,cv,partRectNormalized(part,cv),part.creative,timeMs,draw):draw(ctx);
          if(!result||result.state!=='drawn')throw new Error(result&&result.error||'The SVG layer could not be drawn.');
        };
        let prefix=0;
        // Overlay mode inserts the ordinary scene below foreground parts but
        // above the leading native backgrounds. Feed parts own their slots'
        // video placement; that slot is not painted a second time underneath.
        if(scene.svgPartsMode==='overlay'){
          while(prefix<parts.length&&module.get(parts[prefix].templateId).components.find(item=>item.id===parts[prefix].componentId).type==='background')drawLayer(parts[prefix++]);
          rects(scene.layout,aspect).forEach((rect,index)=>{if(!used.has(index))paintSource(ctx,cv,scene,rect,index,null,timeMs);});
          if(sceneExtrasEnabled(scene))drawOverlays(ctx,cv,scene,aspect,timeMs);
        }
        parts.slice(prefix).forEach(drawLayer);
        if(scene.svgPartsMode==='parts-only'&&sceneExtrasEnabled(scene))drawOverlays(ctx,cv,scene,aspect,timeMs);
      }catch(error){svgPartRenderErrors.set(scene.id,{parts:scene.svgParts,error:error.message||String(error)});}
      ctx.restore();return;
    }
    let R = rects(scene.layout, aspect), templateStyle = {}, templateKey = null, nativeFrames = null;
    if (scene.fullTemplateId) {
      const status = fullTemplateStatus(scene, true);
      if (!status || status.state !== 'ready') { ctx.restore(); return; }
      try {
        templateStyle = fullTemplateStyle(scene.fullTemplateId,scene.fullTemplateStyle);
        templateKey = fullTemplateKey(scene.fullTemplateId,templateStyle);
        if (templateStyle.components) {
          const module = window.OpenLiveFullTemplates;
          if (typeof module.renderComponents !== 'function') throw new Error('The native component compositor is unavailable.');
          R = fullTemplateFrames(scene.fullTemplateId,cv,templateStyle);
          const result = module.renderComponents(scene.fullTemplateId,ctx,cv,templateStyle,
            (index,feedContext) => paintSource(feedContext,cv,scene,R[index],index,null,timeMs),{timeMs});
          if (!result || result.state !== 'drawn') throw new Error(result && result.error || 'The native components could not be drawn.');
          if (sceneExtrasEnabled(scene)) drawOverlays(ctx,cv,scene,aspect,timeMs);
          ctx.restore(); return;
        }
        const result = window.OpenLiveFullTemplates.draw(scene.fullTemplateId, ctx, cv, templateStyle,{timeMs});
        if (!result || result.state !== 'drawn') {
          if (result && result.state === 'failed') fullTemplateRenderErrors.set(templateKey,
            String(result.error || 'The full template artwork could not be drawn.'));
          ctx.restore(); return;
        }
        R = fullTemplateFrames(scene.fullTemplateId, cv);
        nativeFrames = window.OpenLiveFullTemplates.get(scene.fullTemplateId).frames;
      } catch (error) {
        if (templateKey) fullTemplateRenderErrors.set(templateKey,String(error && error.message || 'Full template rendering failed.'));
        ctx.restore(); return;
      }
    }
    const paintedNativeMedia=[];
    const nativeTemplate=nativeFrames&&window.OpenLiveFullTemplates.get(scene.fullTemplateId);
    const nativeScale=nativeTemplate?Math.min(cv.width/nativeTemplate.width,cv.height/nativeTemplate.height):1;
    const nativeBoard=nativeTemplate?{x:(cv.width-nativeTemplate.width*nativeScale)/2,y:(cv.height-nativeTemplate.height*nativeScale)/2,
      w:nativeTemplate.width*nativeScale,h:nativeTemplate.height*nativeScale}:null;
    R.forEach((r, i) => {
      const slot = scene.slots[i];
      const src = slot && slot.sourceId ? sceneSource(scene,slot.sourceId) : null;
      const outer = nativeFrames && nativeFrames[i] && nativeFrames[i].outer;
      // Native frame order is foreground order. Restore a later frame's whole
      // rounded region only when earlier media actually covered it (Template 7's PiP),
      // before any empty/hidden/unready-source return or contain-fit painting.
      // This also restores the artwork visible beside a letterboxed PiP source.
      // Redrawing an already-correct unbound frame would composite its native
      // antialiased edge twice. Contained portrait media may not reach it either.
      const foreground=outer&&{x:nativeBoard.x+outer.x*nativeBoard.w,y:nativeBoard.y+outer.y*nativeBoard.h,
        w:outer.w*nativeBoard.w,h:outer.h*nativeBoard.h};
      if (foreground && paintedNativeMedia.some(box=>foreground.x<box.x+box.w&&foreground.x+foreground.w>box.x&&
          foreground.y<box.y+box.h&&foreground.y+foreground.h>box.y)) {
        try {
          const module = window.OpenLiveFullTemplates;
          if (typeof module.drawFrame !== 'function' ||
              !module.drawFrame(scene.fullTemplateId,i,ctx,cv,templateStyle,{interior:true}))
            throw new Error('The full template foreground frame could not be drawn.');
        } catch (error) {
          fullTemplateRenderErrors.set(templateKey,
            String(error && error.message || 'The full template foreground frame could not be drawn.'));
          return;
        }
      }
      const {x:rx,y:ry,w:rw,h:rh} = sourceRect(r,cv,src);
      /* h:null means the slot is as tall as its CONTENT needs, and the layout
         table's own note says that height is "derived from w and the SOURCE's
         own aspect, so a 4:3 camera in a 16:9 rect is not silently stretched".
         It was being derived from the CANVAS instead: r.w * (cv.width/cv.height)
         then multiplied by cv.height reduces to r.w * cv.width — pixel height
         equal to pixel width, a SQUARE. Split's .47 slot came out 902x902 on a
         1920x1080 programme instead of 902x508.
         A 16:9 source hid it, because fit() contains such a source to the very
         same rectangle either way. What it did not hide: the empty-slot outline,
         drawn at the raw rect, stood nearly twice as tall as the content that
         would fill it; and a 4:3 camera was laid out 676px tall where the layout
         intends 508. Now it asks the source, and falls back to the composition's
         own aspect only when the slot is empty or metadata has not arrived. */
      /* The programme canvas is the exact surface captured by recorders and
         every destination.  Missing-slot guides therefore cannot be painted
         here: doing so would transmit the dashed operator aid and the word
         "empty".  The surrounding Studio controls expose missing bindings. */
      if (!src || src.audioOnly || (slot && slot.hidden) || !sourceStatus(src).ok) return;
      const box = sourcePictureGeometry(slot,src,r,cv,scene.fullTemplateId).box;
      if (!box) return;                      /* metadata not in yet: draw nothing */
      // Generated pictures must advance on the compositor clock even in the
      // unchanged native-template path. Drawing only their initial canvas
      // would freeze lineups, match clocks and other animated source content.
      if(typeof src.renderFrame==='function'||src.transport||slot.creative||slot.inputSelection||slot.outputFit||slot.effects?.length||slot.generator){
        paintSource(ctx,cv,scene,r,i,null,timeMs);
        if(nativeFrames)paintedNativeMedia.push(box);
        if(scene.fullTemplateId&&typeof window.OpenLiveFullTemplates.drawFrame==='function')window.OpenLiveFullTemplates.drawFrame(scene.fullTemplateId,i,ctx,cv,templateStyle);
        return;
      }
      const radius = scene.fullTemplateId && Number(r.radius) > 0
        ? Math.min(Number(r.radius) * Math.min(cv.width,cv.height),rw / 2,rh / 2) : 0;
      const scoped = !!(src.mirror || radius);
      if (scoped) ctx.save();
      try {
        if (radius) {
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(rx,ry,rw,rh,radius);
          else ctx.rect(rx,ry,rw,rh);
          ctx.clip();
        }
        if (src.mirror) {
          ctx.translate(box.x + box.w, box.y); ctx.scale(-1, 1);
          ctx.drawImage(src.el, 0, 0, box.w, box.h);
        } else {
          ctx.drawImage(src.el, box.x, box.y, box.w, box.h);
        }
        if(nativeFrames)paintedNativeMedia.push(box);
      } catch (e) { /* a not-yet-decodable frame is skipped, not faked */ }
      finally {
        if (scoped) ctx.restore();
        /* Full SVG templates keep the actual authored frame pixels. Restore
           them after every media slot, outside its mirrored/rounded clip, so
           later overlapping presenter frames retain their own border artwork. */
        if (scene.fullTemplateId && typeof window.OpenLiveFullTemplates.drawFrame === 'function') {
          try { window.OpenLiveFullTemplates.drawFrame(scene.fullTemplateId,i,ctx,cv,templateStyle); }
          catch (error) { fullTemplateRenderErrors.set(templateKey,
            String(error && error.message || 'The full template frame could not be drawn.')); }
        }
      }
    });
    if (sceneExtrasEnabled(scene)) drawOverlays(ctx, cv, scene, aspect, timeMs);
    ctx.restore();
  }

  function transitionPair(aspect, target) {
    let pair = transitionCanvases.get(aspect);
    if (!pair || pair[0].width !== target.width || pair[0].height !== target.height) {
      pair = [document.createElement('canvas'), document.createElement('canvas')];
      pair.forEach(cv => { cv.width = target.width; cv.height = target.height; });
      transitionCanvases.set(aspect, pair);
    }
    return pair;
  }
  function paintProgramme(cv, aspect, now) {
    if (!transition) { paint(cv, aspect, active(), now); return; }
    const from = transition.from || doc.scenes.find(s => s.id === transition.fromId);
    const to = transition.to || doc.scenes.find(s => s.id === transition.toId) || active();
    const t = transition.manual?transition.progress:Math.max(0, Math.min(1, (now - transition.startedAt) / transition.duration));
    if(t<=0){paint(cv,aspect,from,now);return;}
    if(t>=1){paint(cv,aspect,to,now);if(!transition?.manual)finishProgrammeTransition();return;}
    const pair = transitionPair(aspect, cv);
    paint(pair[0], aspect, from, now); paint(pair[1], aspect, to, now);
    const ctx = cv.getContext('2d');
    ctx.save(); ctx.globalAlpha = 1; ctx.drawImage(pair[0], 0, 0);
    ctx.globalAlpha = t; ctx.drawImage(pair[1], 0, 0); ctx.restore();
  }

  function transitionTo(id, duration) {
    if (previewWorkflow) return false; // Only the explicit, prepared Preview Take may publish.
    if (!doc.scenes.some(s => s.id === id)) return false;
    const fromId = active() && active().id;
    const ms = Math.max(0, Math.min(5000, Number(duration) || 0));
    if (!fromId || fromId === id || !ms) { transition = null; setActive(id); syncMix(); return true; }
    doc.activeId = id; save(); syncMix();
    transition = { fromId, toId: id, startedAt: performance.now(), duration: ms };
    return true;
  }

  function semanticTheme(profile) {
    const {fontReady,fontStatus,fontError,...semantic}=profile;
    return semantic;
  }
  function currentTheme() {
    const theme = window.OpenLiveTheme;
    if (theme && typeof theme.profile === 'function') return semanticTheme(theme.profile());
    return {
      id:'base', family:'system-ui, sans-serif', primary:'#3FDDAA', accent:'#3FDDAA',
      surface:'rgba(10,12,20,.78)', foreground:'#FFFFFF', muted:'rgba(255,255,255,.72)',
      radiusScale:0, shadow:false
    };
  }

  function fittedOverlayFont(ctx, text, weight, wanted, minimum, maxWidth, theme) {
    let px = Math.max(minimum, Math.round(wanted));
    const value = String(text || '');
    while (px > minimum) {
      ctx.font = weight + ' ' + px + 'px ' + (theme && theme.family || 'system-ui, sans-serif');
      if (ctx.measureText(value).width <= maxWidth) break;
      px--;
    }
    return weight + ' ' + px + 'px ' + (theme && theme.family || 'system-ui, sans-serif');
  }

  function fillOverlayBox(ctx, x, y, width, height, radius, colour) {
    ctx.fillStyle = colour;
    if (radius > 0 && typeof ctx.roundRect === 'function' && typeof ctx.fill === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2)); ctx.fill();
    } else ctx.fillRect(x, y, width, height);
  }

  function drawOverlays(ctx, cv, scene, aspect, timeMs) {
    const o = scene.overlays || {};
    const theme = scene.renderState?.theme || currentTheme();
    const themeFontReady=sceneThemeFontStatus(scene).ok;
    const alignment = window.OpenLiveBroadcastLayout;
    const templateLogo = alignment && typeof alignment.template === 'function' &&
      theme.id === 'news' && theme.templateLogo ? alignment.template(theme.broadcastTemplate) : null;
    /* Browser sources are real scene layers. Their decoded same-origin frames
       are drawn above cameras/screens and below SHOWAVE captions, logos and QR
       overlays, so every destination receives the same composed pixels. */
    const widgets = window.OpenLiveWidgets;
    if (widgets && typeof widgets.draw === 'function') {
      widgets.draw(ctx, cv, scene.widgets || [], { aspect, widgetsState:scene.renderState?.widgets });
    }
    /* Reusable My Assets graphics are burned into the programme, never placed
       only in the operator preview.  The background is drawn below sources in
       paint(); a full-frame overlay belongs above sources/widgets. */
    const graphics = window.OpenLiveGraphics;
    const graphicsOptions = { aspect, ...renderOptions(scene), timeMs:Number(timeMs) || 0, theme };
    // Template placement is a rendering override; the reusable logo keeps its
    // saved corner/scale and immediately regains them when this option is off.
    if (templateLogo) Object.assign(graphicsOptions, {corner:templateLogo.logoCorner,scale:templateLogo.logoScale});
    if (graphics && typeof graphics.drawOverlay === 'function')
      graphics.drawOverlay(ctx, cv, graphicsOptions);
    const graphicsLogoInfo = graphics && typeof graphics.activeRenderInfo === 'function'
      ? graphics.activeRenderInfo('logo', graphicsOptions)
      : graphics && typeof graphics.activeStatus === 'function'
        ? graphics.activeStatus(graphicsOptions).logo : null;
    const graphicsLogo = graphicsLogoInfo && graphicsLogoInfo.state !== 'error'
      ? graphicsLogoInfo : null;
    const programmeLogoCorner = graphicsLogo
      ? ({ 'top-left':'tl', 'top-right':'tr', 'bottom-left':'bl', 'bottom-right':'br' }[
          graphicsOptions.corner || graphicsLogo.corner] || 'tr')
      : o.logo && o.logo.on ? templateLogo
        ? ({'top-left':'tl','top-right':'tr','bottom-left':'bl','bottom-right':'br'}[templateLogo.logoCorner])
        : String(o.logo.corner || 'tr') : '';
    const captions = window.OpenLiveCaptions;
    const captionStatus = captions && typeof captions.activeStatus === 'function'
      ? scene.renderState?.captions || captions.activeStatus() : { lowerThird: null, ticker: null };
    /* Saved show-level captions take the lower-third programme slot. The old
       scene field remains a compatibility fallback for documents created before
       My Assets existed, but two lower thirds are never painted over each other. */
    const captionProgrammeOwnsLower = !!captionStatus.lowerThird;
    const legacyLower = !captionProgrammeOwnsLower &&
      o.lower && o.lower.on && (o.lower.line1 || o.lower.line2);
    const commerce = window.OpenLiveCommerce;
    const sharedNewsLayout = alignment && theme.id === 'news';
    const commerceStatus = sharedNewsLayout && commerce
      ? scene.renderState?.commerce?.status || (typeof commerce.activeRenderInfo === 'function' ? commerce.activeRenderInfo()
        : typeof commerce.activeStatus === 'function' ? commerce.activeStatus() : null)
      : null;
    // A cached browser Image can become ready synchronously on its first src
    // assignment. Prepare an idle mark before measuring, so it cannot first
    // appear later in this frame over a layout that reserved no logo space.
    // Loading/ready marks take no new decode promise on subsequent frames.
    if (sharedNewsLayout && graphicsLogo && graphicsLogo.id &&
        (graphicsLogo.state === 'idle' || graphicsLogo.state == null) &&
        typeof graphics.decode === 'function') {
      try {
        const preparation = graphics.decode(graphicsLogo.id);
        if (preparation && typeof preparation.catch === 'function') preparation.catch(() => {});
      } catch (_) { /* The normal graphics draw reports a decode failure. */ }
    }
    const measuredLogo = graphics && typeof graphics.logoLayout === 'function'
      ? graphics.logoLayout(cv, graphicsOptions) : null;
    let legacyLogoRect = null;
    if (!graphicsLogo && o.logo && o.logo.on && o.logo._img) {
      const img = o.logo._img, safe = alignment && theme.id === 'news' ? alignment.safeArea(cv, {theme}) : null;
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const bound = safe ? safe.unit * (templateLogo ? templateLogo.logoScale : .12) : cv.width * .12;
      const w = safe ? Math.min(bound, bound * ratio) : bound;
      const h = w / ratio, px = safe ? safe.x : cv.width * .025, py = safe ? safe.y : px;
      legacyLogoRect = {x:/l$/.test(programmeLogoCorner) ? px : cv.width - w - px,
        y:/^t/.test(programmeLogoCorner) ? py : cv.height - h - py, width:w, height:h};
    }
    const logoRect = measuredLogo ? measuredLogo.destination : legacyLogoRect;
    const broadcastLayout = sharedNewsLayout ? alignment.plan(cv, {
      theme, logoRect, hasLower:!!(legacyLower || captionStatus.lowerThird), hasTicker:!!captionStatus.ticker,
      commerceKind:commerceStatus && commerceStatus.state === 'visible'
        ? commerceStatus.type || commerceStatus.asset && commerceStatus.asset.type : ''
    }) : null;
    if (legacyLower&&themeFontReady) {
      if (captions && typeof captions.drawLowerThird === 'function' && typeof captions.layout === 'function') {
        const legacyOptions = {
          logoCorner:programmeLogoCorner, theme, logoRect, broadcastLayout, captionState:scene.renderState?.captions
        };
        captions.drawLowerThird(ctx, cv, {
          type:'lower-third', line1:String(o.lower.line1 || ''), line2:String(o.lower.line2 || '')
        }, captions.layout(cv, legacyOptions), legacyOptions);
      } else {
      /* Size type from BOTH axes and measure it before drawing the plate. The
         old plate was 42% of canvas width while type was sized from height; on
         a 9:16 raster the text overflowed by hundreds of pixels. */
      const pad = cv.width * .04;
      const h = Math.min(cv.height * .12, cv.width * .23);
      const y = cv.height - h - pad;
      const accent = Math.max(4, cv.width * .006);
      const inset = cv.width * .025;
      const maxTextWidth = cv.width - pad * 2 - inset * 2 - accent;
      const line1 = String(o.lower.line1 || '');
      const line2 = String(o.lower.line2 || '');
      const font1 = fittedOverlayFont(ctx, line1, '600', Math.min(h * .34, cv.width * .055),
        Math.max(16, cv.width * .017), maxTextWidth, theme);
      ctx.font = font1;
      const width1 = ctx.measureText(line1).width;
      const font2 = fittedOverlayFont(ctx, line2, '400', Math.min(h * .24, cv.width * .038),
        Math.max(13, cv.width * .014), maxTextWidth, theme);
      ctx.font = font2;
      const width2 = ctx.measureText(line2).width;
      const plateW = Math.min(cv.width - pad * 2,
        Math.max(cv.width * .34, Math.max(width1, width2) + inset * 2 + accent));
      ctx.fillStyle = theme.surface;
      ctx.fillRect(pad, y, plateW, h);
      ctx.fillStyle = theme.primary;
      ctx.fillRect(pad, y, accent, h);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = theme.foreground;
      ctx.font = font1;
      ctx.fillText(line1, pad + inset + accent, y + h * .42);
      ctx.fillStyle = theme.muted;
      ctx.font = font2;
      ctx.fillText(line2, pad + inset + accent, y + h * .76);
      }
    }
    if (legacyLogoRect) {
      const r = legacyLogoRect;
      try { ctx.drawImage(o.logo._img, r.x, r.y, r.width, r.height); } catch (e) {}
    }
    if (themeFontReady&&o.countdown && o.countdown.on && o.countdown.endsAt) {
      const left = Math.max(0, o.countdown.endsAt - Date.now());
      const s = Math.floor(left / 1000);
      const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      const size = Math.round(cv.height * .16);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 ' + size + 'px ' + theme.family;
      const width = ctx.measureText(txt).width + size * .62;
      const height = size * 1.22;
      const x = (cv.width - width) / 2, y = (cv.height - height) / 2;
      const radius = theme.id === 'round' ? height / 2 : theme.id === 'air' ? height * .16 : 0;
      ctx.save();
      if (theme.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,.36)'; ctx.shadowBlur = Math.min(cv.width, cv.height) * .025;
        ctx.shadowOffsetY = Math.min(cv.width, cv.height) * .007;
      }
      fillOverlayBox(ctx, x, y, width, height, radius, theme.surface);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      if (theme.id === 'base') {
        ctx.fillStyle = theme.primary; ctx.fillRect(x, y, Math.max(5, size * .07), height);
      } else if (theme.id === 'news') {
        ctx.fillStyle = theme.primary; ctx.fillRect(x, y, width, Math.max(5, height * .07));
      }
      ctx.fillStyle = theme.foreground;
      ctx.fillText(txt, cv.width / 2, cv.height / 2);
      ctx.restore();
    }
    /* Lower thirds and tickers are show-level overlays. Drawing them after the
       scene-owned logo/countdown keeps scene cuts from changing their state and
       burns the result into the same canvas every encoder captures. */
    if (themeFontReady&&captions && typeof captions.draw === 'function') captions.draw(ctx, cv, {
      logoCorner:programmeLogoCorner, theme, logoRect, broadcastLayout, captionState:scene.renderState?.captions, nowMs:timeMs
    });

    /* QR and live-sales assets belong to the show, rather than to one scene.
       Drawing them here makes them part of the exact canvas captured by every
       destination, recorder and clip. Placement avoids the scene-owned lower
       third and logo instead of letting two independently useful controls
       silently cover each other. */
    if (themeFontReady&&commerce && typeof commerce.draw === 'function') commerce.draw(ctx, cv, {
      avoidLower: !!(legacyLower || captionStatus.lowerThird || captionStatus.ticker),
      logoCorner:programmeLogoCorner, theme, logoRect, broadcastLayout, commerceState:scene.renderState?.commerce
    });
    /* The rendered scene's resolved logo is the final brand mark. Folder
       browsing never changes programme relationships; a scene cut may select a
       different logo, and the same scene id is used for every output raster. */
    if (graphics && typeof graphics.drawLogo === 'function')
      graphics.drawLogo(ctx, cv, graphicsOptions);
  }

  /* TWO DRIVERS, ONE FRAME. requestAnimationFrame stops in a hidden tab, and
     this canvas is not a preview — it IS the surface the encoder captures, so
     rAF alone means the programme freezes the moment the operator switches
     window and the stream sends one still frame to every destination.
     openlive-stream.js:392-406 already measured exactly that ("fired ONCE in two
     seconds while the renderer's stamp advanced 42 times a second") and fixed it
     with a Worker interval. The desktop shell must also keep owned windows'
     background clocks enabled; a worker cannot bypass an Electron policy that
     throttles the whole hidden WebContents.
     Keep the compositor on an absolute phase, at the highest active encoder
     capture rate. Painting both native rasters 60-70 times a second for 30 fps
     captures needlessly competes with those captures and their encoders. With
     no encoder capture the operator's Programme still refreshes at 60 fps.
     Neither the canvas raster nor a consumer's requested rate is reduced. */
  let nextPaintAt = NaN, lastPaintRate = 0, lastClockAt = NaN;
  function programmeFrameRate() {
    let rate = 0;
    programs.forEach(source => {
      const requested = Number(source.fps || source._fps);
      if (Number.isFinite(requested) && requested > 0) rate = Math.max(rate,requested);
    });
    return rate ? Math.min(60,Math.max(1,rate)) : 60;
  }
  function renderFrame() {
    if (!running) return;
    const now = performance.now(), rate = programmeFrameRate(), interval = 1000 / rate;
    if (rate !== lastPaintRate || !Number.isFinite(nextPaintAt) || now + .5 < lastClockAt) {
      nextPaintAt = now; lastPaintRate = rate;
      if (ticker) ticker.postMessage(Math.max(4,Math.round(interval)));
    }
    lastClockAt = now;
    if (now + .5 < nextPaintAt) return;
    // A busy callback paints once; it never bursts old frames to catch up.
    nextPaintAt += (Math.floor((now + .5 - nextPaintAt) / interval) + 1) * interval;
    reconcileWidgets();
    if(transition && !transition.manual)syncMix();
    canvases.forEach((cv, a) => {
      paintProgramme(cv, a, now);
      // Publish a revision only after the complete native raster was painted.
      // Keep it monotonic across driver restarts for existing projector owners.
      frameRevisions.set(a, frameRevisions.get(a) + 1);
      programs.forEach(source => {
        if (source._aspect === a && typeof source.requestFrame === 'function') source.requestFrame(now);
      });
    });
    drawn++;
    if (now - lastAt >= 1000) { fps = drawn; drawn = 0; lastAt = now; }
  }
  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    renderFrame();
  }
  let ticker = null, tickerUrl = null;
  function startTicker() {
    try {
      tickerUrl = URL.createObjectURL(new Blob(
        ['let h=0;onmessage=e=>{clearInterval(h);if(e.data>0)h=setInterval(()=>postMessage(0),e.data);};'],
        { type: 'text/javascript' }));
      ticker = new Worker(tickerUrl);
      ticker.onmessage = renderFrame;
      ticker.postMessage(Math.max(4,Math.round(1000 / programmeFrameRate())));
    } catch (e) { ticker = null; }        /* rAF still drives a visible tab */
  }
  function stopTicker() {
    if (ticker) { try { ticker.postMessage(0); ticker.terminate(); } catch (e) {} ticker = null; }
    if (tickerUrl) { try { URL.revokeObjectURL(tickerUrl); } catch (e) {} tickerUrl = null; }
  }
  function start(aspects) {
    (aspects && aspects.length ? aspects : ['16x9']).forEach(canvas);
    if (running) return;
    running = true; lastAt = performance.now(); drawn = 0;
    nextPaintAt = NaN; lastPaintRate = 0; lastClockAt = NaN;
    raf = requestAnimationFrame(tick);
    startTicker();
  }
  function stop() {
    running = false; if (raf) cancelAnimationFrame(raf); raf = 0; stopTicker();
    const widgets = window.OpenLiveWidgets;
    if (widgets && typeof widgets.reconcile === 'function') widgets.reconcile([]);
  }

  /* Legacy callers can render their own raster. Monitors below instead keep
     the Programme's logical dimensions: font floors and pixel-sized borders
     must not become disproportionately large in a small scene card. */
  function miniature(cv, sceneId, timeMs = performance.now()) {
    const sc = doc.scenes.find(s => s.id === sceneId);
    paint(cv, '16x9', sc, timeMs);
  }
  function renderSceneMonitor(cv, sceneId, timeMs = performance.now()) {
    const ctx = cv.getContext('2d'), size = ASPECTS['16x9'];
    ctx.save();
    try {
      ctx.scale(cv.width / size.w, cv.height / size.h);
      paint({width:size.w,height:size.h,getContext:()=>ctx}, '16x9', doc.scenes.find(s=>s.id===sceneId), timeMs);
    } finally { ctx.restore(); }
  }

  /* ---- audio mix ---------------------------------------------------------
     One AudioContext, one MediaStreamAudioDestinationNode, one GainNode per
     source. Slot mute sets that gain to 0, so what is muted in the Studio is
     muted in the stream — not merely in the operator's monitor.

     Programme listening starts open at unity; Preview starts muted at half
     volume. Each local listening gain follows its own mix, independently of
     mute, and never changes a source gain, encoder bus or meter. Audio Output
     Preferences and browser autoplay still govern the shared speaker route.

     Sources with no audio track contribute nothing and say so. Contributor
     reporting and metering never invent audio. Encoder captures reserve their
     own clone of the silent mixer bus from startup, explicitly reported as a
     reserved track, so later live inputs do not change a recorder's track set. */
  let actx = null, mixDest = null, analyser = null, mixBuf = null, resumePending = null, outputRoute = null;
  let monitoringEnabled = true, monitorVolume = 1, monitorGain = null, monitoringError = null;
  let previewAudioSceneId = null, previewMonitoringEnabled = false, previewMonitorGain = null, previewMonitoringError = null;
  let previewMonitorVolume = .5;
  let programmeMeter = null, previewMeter = null;
  const mixNodes = new Map();       /* source id -> {node, gain} */
  const previewMixNodes = new Map(); /* never connected to mixDest or a Programme gain */

  // A stereo tap measures the mix before local listening mute. Explicit
  // speaker upmix repeats a mono input in both channels; stereo stays separate.
  // Do not substitute a mono reading when the browser cannot split channels.
  function createStereoMeter(ctx) {
    const nodes = [];
    try {
      const input = ctx.createGain(); nodes.push(input);
      input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
      const splitter = ctx.createChannelSplitter(2); nodes.push(splitter); input.connect(splitter);
      const channels = [0,1].map(channel => {
        const tap = ctx.createAnalyser(); nodes.push(tap); tap.fftSize = 2048;
        splitter.connect(tap,channel);
        return {tap,buffer:new Float32Array(tap.fftSize)};
      });
      return {input,channels,nodes};
    } catch (_) { nodes.forEach(node => { try { node.disconnect(); } catch (_) {} }); return null; }
  }
  const decibels = value => value > 0 ? 20 * Math.log10(value) : -Infinity;
  function readStereoMeter(meter,nodes) {
    if (!meter || !nodes.size || !actx || actx.state && actx.state !== 'running') return null;
    const values = meter.channels.map(({tap,buffer}) => {
      tap.getFloatTimeDomainData(buffer);
      let square = 0, peak = 0;
      for (const sample of buffer) { square += sample * sample; peak = Math.max(peak,Math.abs(sample)); }
      const rms = Math.sqrt(square / buffer.length);
      return {rms,peak,db:decibels(rms),peakDb:decibels(peak)};
    });
    const [left,right] = values, rms = Math.sqrt((left.rms * left.rms + right.rms * right.rms) / 2), peak = Math.max(left.peak,right.peak);
    return {left,right,rms,peak,db:decibels(rms),peakDb:decibels(peak)};
  }
  function audioMeter() { return readStereoMeter(programmeMeter,mixNodes); }
  function previewAudioMeter() { return readStereoMeter(previewMeter,previewMixNodes); }
  // The selected source is tapped after its bus-owned Slot gain. Reading this
  // never creates a player, requests a device, enables speakers or resumes audio.
  function sourceAudioMeter(sourceId,{bus='preview'}={}){
    if(!['preview','programme'].includes(bus))return null;
    const nodes=bus==='preview'?previewMixNodes:mixNodes,rec=nodes.get(sourceId),
      scene=bus==='preview'?previewAudioScene():active(),source=scene&&sceneSource(scene,sourceId);
    if(!rec?.meter||!source||rec.stream!==source.stream||sourceCleared(source)||
       isFileMedia(source)&&(source.el?.paused===true||source.el?.ended===true))return null;
    const tracks=rec.stream.getAudioTracks?.().filter(track=>track.readyState!=='ended')||[];
    if(!tracks.length||tracks.map(track=>track.id).join('|')!==rec.trackKey)return null;
    return readStereoMeter(rec.meter,nodes);
  }
  const previewAudioScene = () => doc.scenes.find(scene => scene.id === previewAudioSceneId) || null;

  function previewAudioMonitoringStatus() {
    const status = (state,reason) => ({enabled:previewMonitoringEnabled,volume:previewMonitorVolume,state,reason});
    if (!previewMonitoringEnabled) return status('off','Preview speaker monitoring is off. Preview meters still show the source audio.');
    if (previewMonitoringError || !actx || !previewMonitorGain)
      return status('unavailable',previewMonitoringError || 'Preview speaker monitoring requires Web Audio and a system audio output.');
    const route=outputRoute?.status();
    if(route&&!route.enabled)return status(route.pending?'waiting':'muted',route.reason || 'Local listening is disabled by Audio Preferences. Preview metering is unchanged.');
    const state = actx.state || 'running';
    if (state === 'suspended') return status('suspended','Preview speaker monitoring is suspended. Interact with Broadcast to resume audio.');
    if (state !== 'running') return status('unavailable','Preview speaker monitoring is unavailable (' + state + ').');
    if (previewMonitorVolume === 0) return status('muted','Preview listening volume is at zero. Preview meters and Programme are unchanged.');
    return status('running',route?.reason || 'Preview listening is on through the selected audio output. It does not enter Programme.');
  }
  async function setPreviewAudioMonitoring(enabled) {
    previewMonitoringEnabled = !!enabled;
    if (!previewMonitoringEnabled) {
      if (previewMonitorGain) previewMonitorGain.gain.value = 0;
      return previewAudioMonitoringStatus();
    }
    const ctx = audioContext();
    if (!ctx || ctx.state === 'closed') return previewAudioMonitoringStatus();
    previewMonitoringError = null; syncPreviewMix();
    try {
      if (!previewMonitorGain) {
        const gain = ctx.createGain(); gain.gain.value = 0;
        try { gain.connect(outputRoute?.speaker || ctx.destination); }
        catch (error) { try { gain.disconnect(); } catch (_) {} throw error; }
        previewMonitorGain = gain;
      }
      previewMixNodes.forEach(rec => rec.gain.connect(previewMonitorGain));
      previewMonitorGain.gain.value = previewMonitorVolume;
    } catch (error) {
      if (previewMonitorGain) previewMonitorGain.gain.value = 0;
      previewMonitoringError = 'Preview speaker monitoring could not connect: ' + (error.message || String(error));
      return previewAudioMonitoringStatus();
    }
    resumeAudio(true); await Promise.resolve();
    return previewAudioMonitoringStatus();
  }
  function normalizedMonitorVolume(value) {
    if (!['number','string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)))
      throw new RangeError('Listening volume must be a finite number between 0 and 1.');
    return Math.max(0,Math.min(1,Number(value)));
  }
  function setPreviewAudioMonitorVolume(value) {
    previewMonitorVolume = normalizedMonitorVolume(value);
    if (previewMonitorGain && !previewMonitoringError) previewMonitorGain.gain.value = previewMonitoringEnabled ? previewMonitorVolume : 0;
    if (previewMonitoringEnabled && actx) resumeAudio(true);
    return previewAudioMonitoringStatus();
  }
  function setPreviewAudioScene(sceneId) {
    previewAudioSceneId = doc.scenes.some(scene => scene.id === sceneId) ? sceneId : null;
    syncPreviewMix();
    // Metering needs a running context even when both speakers are muted.
    if (previewMixNodes.size) resumeAudio();
    return previewAudioStatus();
  }

  /* Read-only local output inspection; enabled is the operator's request,
     while state reports whether that route can currently run. */
  function audioMonitoringStatus() {
    const status = (state,reason) => ({enabled:monitoringEnabled,volume:monitorVolume,state,reason});
    if (!monitoringEnabled) return status('off','Programme speaker monitoring is off.');
    if (monitoringError || !actx || !monitorGain)
      return status('unavailable',monitoringError || 'Programme speaker monitoring requires Web Audio and a system audio output.');
    const route=outputRoute?.status();
    if(route&&!route.enabled)return status(route.pending?'waiting':'muted',route.reason || 'Local listening is disabled by Audio Preferences. Programme audio still reaches the stream.');
    const state = actx.state || 'running';
    if (state === 'suspended') return status('suspended','Programme speaker monitoring is suspended. Interact with Broadcast to resume audio.');
    if (state !== 'running') return status('unavailable','Programme speaker monitoring is unavailable (' + state + ').');
    if (monitorVolume === 0) return status('muted','Programme listening volume is at zero. Source gains and stream audio are unchanged.');
    return status('running',route?.reason || 'Programme audio monitoring is on through the selected audio output.');
  }

  function connectAudioMonitor() {
    if (!actx || actx.state === 'closed' || !monitoringEnabled) return;
    try {
      if (!monitorGain) {
        const gain = actx.createGain(); gain.gain.value = 0;
        try { gain.connect(outputRoute?.speaker || actx.destination); }
        catch (error) { try { gain.disconnect(); } catch (_) {} throw error; }
        monitorGain = gain;
      }
      // Reconnecting the same nodes is idempotent, including when a failed
      // output route is retried. This branch never touches the encoder bus.
      mixNodes.forEach(rec => (rec.programmeInput || rec.gain).connect(monitorGain));
      monitorGain.gain.value = monitorVolume;
    } catch (error) {
      if (monitorGain) monitorGain.gain.value = 0;
      monitoringError = 'Programme speaker monitoring could not connect: ' + (error.message || String(error));
    }
  }
  function setAudioMonitorVolume(value) {
    monitorVolume = normalizedMonitorVolume(value);
    if (monitorGain && !monitoringError) monitorGain.gain.value = monitoringEnabled ? monitorVolume : 0;
    if (monitoringEnabled && actx) resumeAudio(true);
    return audioMonitoringStatus();
  }

  async function setAudioMonitoring(enabled) {
    monitoringEnabled = !!enabled;
    if (!monitoringEnabled) {
      if (monitorGain) monitorGain.gain.value = 0;
      return audioMonitoringStatus();
    }
    const ctx = audioContext();
    if (!ctx || ctx.state === 'closed') return audioMonitoringStatus();
    monitoringError = null;
    // Monitoring can start before an encoder capture exists. Route the active
    // Programme sources through the same existing bus first.
    syncMix();
    connectAudioMonitor();
    if (monitoringError) return audioMonitoringStatus();
    // Autoplay can hold resume() pending until another gesture. Return current
    // status promptly; a late resume cannot turn a subsequently disabled route
    // back on, because it never changes monitorGain or monitoringEnabled.
    resumeAudio(true);
    await Promise.resolve();
    return audioMonitoringStatus();
  }

  /* Read-only inspection: never creates/resumes WebAudio or captures a device.
     Ready means a live contributor is routed, not that sound was measured. */
  function audioStatus(scene) {
    return busAudioStatus(scene || active(),mixNodes,'Programme',transition&&(!scene||scene===active())?programmeContributors():null);
  }
  function previewAudioStatus() {
    return busAudioStatus(previewAudioScene(),previewMixNodes,'Preview');
  }
  function busAudioStatus(sc,nodes,bus,expected=null) {
    const wanted = new Map();
    if(expected)expected.forEach(({source,gain},key)=>wanted.set(key,{sourceId:source.id,gain}));
    else (sc && sc.slots || []).forEach(slot => { if (slot.sourceId) wanted.set(slot.sourceId, slot); });
    let liveSources = 0, eligible = 0, contributors = 0, pausedSources = 0, knownSources = 0, pausedKnown = 0, endedKnown = 0;
    wanted.forEach((slot, id) => {
      const s = expected?expected.get(id)?.source:sceneSource(sc,id);
      if (!s || !s.stream || typeof s.stream.getAudioTracks !== 'function') return;
      if(sourceCleared(s))return;
      if (isFileMedia(s) && audioStreamsWithEvidence.has(s.stream)) {
        knownSources++;
        if (s.el?.ended === true) endedKnown++;
        else if (s.el?.paused === true) pausedKnown++;
      }
      const tracks = s.stream.getAudioTracks().filter(track => track.readyState !== 'ended');
      if (!tracks.length) return;
      liveSources++;
      if (slot.mute || (Number.isFinite(slot.gain) && slot.gain <= 0)) return;
      if (isFileMedia(s) && s.el?.paused === true) { pausedSources++; return; }
      if (!tracks.some(track => track.enabled !== false && track.muted !== true)) return;
      eligible++;
      const rec = nodes.get(id);
      if (rec && rec.stream === s.stream && rec.gain.gain.value > 0 &&
          rec.trackKey === tracks.map(track => track.id).join('|')) contributors++;
    });
    const contextState = actx && (actx.state || 'running') || 'unavailable';
    const staleRouting = [...nodes].some(([id, rec]) => {
      const slot = wanted.get(id);
      return (!slot || slot.mute || (Number.isFinite(slot.gain) && slot.gain <= 0)) &&
        rec.gain.gain.value > 0 && rec.stream.getAudioTracks().some(track =>
          track.readyState !== 'ended' && track.enabled !== false && track.muted !== true);
    });
    let state, label, reason;
    if (staleRouting && contextState === 'running') {
      state = 'waiting'; label = 'Waiting'; reason = bus + ' audio routing has not caught up with the active scene. Previous audio is still connected.';
    } else if (!liveSources && knownSources) {
      if (endedKnown === knownSources) {
        state = 'ended'; label = 'Ended'; reason = bus + ' media has ended. Play or restart the source to measure its sound.';
      } else if (pausedKnown + endedKnown === knownSources) {
        state = 'paused'; label = 'Paused'; reason = bus + ' media is paused. Play the source to measure its sound.';
      } else {
        state = 'waiting'; label = 'Waiting'; reason = bus + ' media contains audio, but its current captured audio track is not available yet.';
      }
    } else if (!liveSources) {
      state = 'silent'; label = 'Silent'; reason = bus === 'Programme' ? 'No live audio sources are bound to the active Programme. A silent show is allowed.' : 'No live audio sources are bound to the selected Preview scene.';
    } else if (!eligible && pausedSources) {
      state = 'paused'; label = 'Paused'; reason = bus + ' media is paused. Play the source to measure its sound.';
    } else if (!eligible) {
      state = 'muted'; label = 'Muted'; reason = bus + ' audio sources are muted, disabled, temporarily unavailable, or at zero gain.';
    } else if (contextState === 'suspended') {
      state = 'suspended'; label = 'Suspended'; reason = 'Studio audio is suspended. Interact with Studio to resume the ' + bus + ' mix.';
    } else if (contextState !== 'running') {
      state = 'unavailable'; label = 'Unavailable'; reason = 'The ' + bus + ' audio mixer is not running (' + contextState + ').';
    } else if (!contributors) {
      state = 'waiting'; label = 'Waiting'; reason = 'Live audio exists, but is not yet connected to the active ' + bus + ' mix.';
    } else {
      state = 'ready'; label = 'Ready'; reason = contributors + ' live audio source' +
        (contributors === 1 ? '' : 's') + ' routed through the ' + bus + ' mix. This is not a measured sound level.';
    }
    return {state, label, reason, included:state === 'ready', contributors, liveSources, knownSources, eligible, pausedSources, contextState};
  }

  function audioContext() {
    if (actx) return actx;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try {
      actx = new C(window.OpenLiveAudioOutput?.contextOptions());
      outputRoute = window.OpenLiveAudioOutput?.create(actx) || null;
      mixDest = actx.createMediaStreamDestination();
      if(outputRoute)window.OpenLiveAudioOutput.markMasterDelay(mixDest.stream);
      analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      mixBuf = new Float32Array(analyser.fftSize);
      programmeMeter = createStereoMeter(actx); previewMeter = createStereoMeter(actx);
      if (typeof actx.addEventListener === 'function')
        actx.addEventListener('statechange', updateProgrammeAudio);
      connectAudioMonitor();
    } catch (e) { outputRoute?.destroy();outputRoute=null;try{actx?.close?.();}catch(_){}actx = null; }
    return actx;
  }

  function updateProgrammeAudio() {
    const contextState = actx && actx.state || (actx ? 'running' : 'unavailable');
    const contributors = [...mixNodes.values()].filter(rec =>
      rec.gain.gain.value > 0 && rec.stream.getAudioTracks().some(track =>
        track.readyState !== 'ended' && track.enabled !== false && track.muted !== true)).length;
    programs.forEach(src => {
      const trackIncluded = !!(src._programmeAudioTracks && src._programmeAudioTracks.some(track =>
        track.readyState !== 'ended'));
      const included = trackIncluded && contextState === 'running' && contributors > 0;
      let reason;
      if (!trackIncluded) reason = src._programmeAudioError ||
        'Studio audio is unavailable in this capture; this output is video-only.';
      else if (contextState !== 'running') reason = contextState === 'suspended'
        ? 'Studio audio is suspended. Interact with the studio to resume it; the fixed audio track is currently silent.'
        : 'Studio audio is not running (' + contextState + '); the fixed audio track cannot carry sound.';
      else if (!contributors) reason = 'A silent studio mix track is reserved for later sources; no unmuted audio contributors are routed.';
      else reason = contributors + ' audio source' + (contributors === 1 ? '' : 's') + ' routed through the studio mix.';
      Object.assign(src.audio || (src.audio = {}), { included, reason, trackIncluded,
        contributors, contextState, fixedTopology:true });
    });
  }

  function resumeAudio(fromGesture) {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') {
      updateProgrammeAudio(); return Promise.resolve(!!ctx && ctx.state !== 'closed');
    }
    if (resumePending && !fromGesture) return resumePending;
    // Never block recording startup on browser autoplay policy. A later user
    // interaction can resume this same bus without changing encoder tracks.
    let resumed;
    try { resumed = ctx.resume(); } catch (_) { updateProgrammeAudio(); return Promise.resolve(false); }
    const pending = Promise.resolve(resumed).then(() => {
      updateProgrammeAudio(); return ctx.state === 'running';
    }, () => { updateProgrammeAudio(); return false; }).finally(() => { if (resumePending === pending) resumePending = null; });
    resumePending = pending;
    return pending;
  }

  function disconnectAudioRecord(rec) {
    try { rec.node.disconnect(); } catch (_) {}
    try { rec.gain.disconnect(); } catch (_) {}
    if(rec.programmeInput)outputRoute?.releaseInput(rec.programmeInput);
    for(const node of rec.meter?.nodes||[])try{node.disconnect();}catch(_){}
  }
  function syncPreviewMix() {
    const scene = previewAudioScene(), wanted = new Set();
    for (const slot of scene?.slots || []) {
      const source = sources.get(slot.sourceId), stream = source?.stream;
      if (!stream || typeof stream.getAudioTracks !== 'function'||sourceCleared(source)) continue;
      const captured = stream.getAudioTracks();
      if (captured.length) audioStreamsWithEvidence.add(stream);
      const tracks = captured.filter(track => track.readyState !== 'ended');
      if (!tracks.length) continue;
      const ctx = audioContext(); if (!ctx || ctx.state === 'closed') continue;
      wanted.add(source.id);
      const trackKey = tracks.map(track => track.id).join('|');
      let rec = previewMixNodes.get(source.id);
      if (rec && (rec.stream !== stream || rec.trackKey !== trackKey)) {
        disconnectAudioRecord(rec); previewMixNodes.delete(source.id); rec = null;
      }
      if (!rec) {
        let node, gain;
        try {
          // Captured media tracks are shared safely. Do not create a
          // MediaElementAudioSource or alter the original player's mute.
          node = ctx.createMediaStreamSource(stream); gain = ctx.createGain(); node.connect(gain);
          if (previewMeter) gain.connect(previewMeter.input);
          const meter=createStereoMeter(ctx);if(meter)gain.connect(meter.input);
          rec = {node,gain,stream,trackKey,meter}; previewMixNodes.set(source.id,rec);
        } catch (_) { if (node) try { node.disconnect(); } catch (_) {} if (gain) try { gain.disconnect(); } catch (_) {} continue; }
        if (previewMonitorGain) {
          try { gain.connect(previewMonitorGain); }
          catch (error) {
            previewMonitorGain.gain.value = 0;
            previewMonitoringError = 'Preview speaker monitoring could not connect: ' + (error.message || String(error));
          }
        }
      }
      rec.gain.gain.value = slot.mute ? 0 : Math.max(0,Math.min(2,Number.isFinite(slot.gain) ? slot.gain : 1));
    }
    for (const [id,rec] of previewMixNodes) {
      if (wanted.has(id)) continue;
      disconnectAudioRecord(rec); previewMixNodes.delete(id);
    }
  }

  function programmeContributors() {
    const sc = active(),progress=transition?(transition.manual?transition.progress:
      Math.max(0,Math.min(1,(performance.now()-transition.startedAt)/transition.duration))):0;
    const buses=transition?[[transition.from||doc.scenes.find(scene=>scene.id===transition.fromId),1-progress],
      [transition.to||doc.scenes.find(scene=>scene.id===transition.toId),progress]]:[[sc,1]];
    const contributors=new Map();
    for(const [scene,weight] of buses){
      const slots=new Map((scene?.slots||[]).filter(slot=>slot.sourceId).map(slot=>[slot.sourceId,slot]));
      for(const sl of slots.values()){
        const s=sceneSource(scene,sl.sourceId);if(!s?.stream||sourceCleared(s))continue;
        const primary=sc&&sceneSource(sc,sl.sourceId),key=primary?.stream===s.stream?s.id:s.id+'@'+(s._programmeGeneration||'outgoing');
        const gain=(sl.mute?0:Math.max(0,Math.min(2,Number.isFinite(sl.gain)?sl.gain:1)))*weight;
        const previous=contributors.get(key);
        if(previous&&previous.source.stream===s.stream)previous.gain+=gain;
        else contributors.set(key,{source:s,gain});
      }
    }
    return contributors;
  }
  function syncMix() {
    const ctx = audioContext();
    if (!ctx) return null;
    const contributors=programmeContributors(),wanted = new Set();
    contributors.forEach(({source:s,gain:level},key) => {
      if (!s || !s.stream||sourceCleared(s)) return;
      const captured = s.stream.getAudioTracks();
      if (captured.length) audioStreamsWithEvidence.add(s.stream);
      const audioTracks = captured.filter(track => track.readyState !== 'ended');
      s.audio = { included:audioTracks.length > 0, reason:audioTracks.length
        ? (s._mediaAudio ? 'Media-file audio is routed through the Studio mixer.' : 'From the captured source.')
        : (s._mediaAudio ? 'This media file offers no live audio track.' : 'This source offers no live audio track.') };
      if (!s.audio.included) return;
      wanted.add(key);
      let rec = mixNodes.get(key);
      const trackKey = audioTracks.map(track => track.id).join('|');
      if (rec && (rec.stream !== s.stream || rec.trackKey !== trackKey)) {
        disconnectAudioRecord(rec);
        mixNodes.delete(key); rec = null;
      }
      if (!rec) {
        try {
          const node = ctx.createMediaStreamSource(s.stream);
          const gain = ctx.createGain();
          const programmeInput=outputRoute?.programmeInput(s.stream) || null;
          node.connect(gain); gain.connect(programmeInput || mixDest);
          if(programmeInput)programmeInput.connect(mixDest);
          gain.connect(analyser);
          if (programmeMeter) gain.connect(programmeMeter.input);
          const meter=createStereoMeter(ctx);if(meter)gain.connect(meter.input);
          rec = { node, gain, stream:s.stream, trackKey,meter,programmeInput };
          mixNodes.set(key, rec);
          if (monitorGain) {
            try { (programmeInput || gain).connect(monitorGain); }
            catch (error) {
              monitorGain.gain.value = 0;
              monitoringError = 'Programme speaker monitoring could not connect: ' + (error.message || String(error));
            }
          }
        } catch (e) { return; }
      }
      rec.gain.gain.value = level;
    });
    /* Anything no longer in the active scene is disconnected, so a source left
       bound in another scene cannot keep leaking into the mix. */
    [...mixNodes.keys()].forEach(id => {
      if (wanted.has(id)) return;
      const rec = mixNodes.get(id);
      disconnectAudioRecord(rec);
      mixNodes.delete(id);
    });
    syncPreviewMix();
    updateProgrammeAudio();
    /* Preserve the contributor-oriented mixer contract: callers still receive
       null when no source is routed. Programme captures separately reserve a
       fixed silent bus track so a microphone added later can enter an existing
       MediaRecorder without illegally changing its track set. Their audio
       metadata explicitly distinguishes the reserved track from contributors. */
    return mixNodes.size ? mixDest.stream : null;
  }

  /* Measured RMS of the mix, or null. Never a decorative idle bar. */
  function audioLevel() {
    if (!analyser || !mixNodes.size) return null;
    if (actx && actx.state && actx.state !== 'running') return null;
    analyser.getFloatTimeDomainData(mixBuf);
    let sum = 0;
    for (let i = 0; i < mixBuf.length; i++) sum += mixBuf[i] * mixBuf[i];
    return Math.sqrt(sum / mixBuf.length);
  }

  /* ---- the programme sources ---------------------------------------------
     One capture is shared by every destination in the SAME orientation. A
     second orientation deliberately has its own capture and encoder; replacing
     the landscape capture when portrait starts would stop the live stream. */
  const programs = new Map();
  function programSource(S, aspect, fps, size) {
    const a = ASPECTS[aspect] ? aspect : '16x9';
    const rate = Math.max(1, Number(fps) || 30);
    const cv = canvas(a);
    const width = Math.max(2, Math.round(Number(size && size.width) || cv.width));
    const height = Math.max(2, Math.round(Number(size && size.height) || cv.height));
    const key = a + ':' + width + 'x' + height + ':' + rate;
    const existing = programs.get(key);
    if (existing) {
      /* Keep the same capture; only refresh the audio routing. */
      syncMix();
      return existing;
    }
    /* Do not replace an older capture of this raster at another frame rate.
       It may already be feeding a destination that was opened individually.
       Both captures draw from the same compositor canvas and are released
       together once no live destination uses this aspect. */
    syncMix();
    const ownedAudio = [];
    let audioStream = null, audioError = null, src;
    try {
      if (!mixDest || !actx || actx.state === 'closed') throw new Error('WebAudio mixer is unavailable.');
      mixDest.stream.getAudioTracks().forEach(track => {
        if (track.readyState !== 'ended') ownedAudio.push(track.clone());
      });
      if (!ownedAudio.length) throw new Error('The studio mixer returned no live audio track.');
      audioStream = new MediaStream(ownedAudio);
      if(outputRoute)window.OpenLiveAudioOutput.markMasterDelay(audioStream);
    } catch (error) {
      ownedAudio.forEach(track => { try { track.stop(); } catch (_) {} });
      ownedAudio.length = 0;
      audioError = 'This capture is video-only: ' + (error.message || String(error)) +
        ' Audio cannot be added after the recording or destination starts.';
    }
    try {
      src = S.sources.fromCanvas(cv, {
        fps: rate, width: width, height: height, audio: audioStream || undefined, frameDriven: true
      });
    } catch (error) {
      ownedAudio.forEach(track => { try { track.stop(); } catch (_) {} });
      throw error;
    }
    // fromCanvas attaches the supplied tracks directly and stops them with the
    // source. Never hand it mixDest's original track: closing portrait must not
    // stop landscape, a recording, or the persistent mixer for the next run.
    src._programmeAudioTracks = ownedAudio;
    src._programmeAudioError = audioError;
    const originalStop = src.stop;
    src.stop = function() {
      try { if (typeof originalStop === 'function') return originalStop.call(src); }
      finally {
        ownedAudio.forEach(track => { try { if (track.readyState !== 'ended') track.stop(); } catch (_) {} });
        updateProgrammeAudio();
      }
    };
    src._aspect = a; src._fps = rate; src._width = width; src._height = height;
    src.label = a === '9x16' ? 'Studio programme · portrait' : 'Studio programme · landscape';
    programs.set(key, src);
    updateProgrammeAudio(); resumeAudio();
    return src;
  }
  function releaseProgram(aspect) {
    const a = aspect && ASPECTS[aspect] ? aspect : null;
    programs.forEach((src, key) => {
      if (a && src._aspect !== a) return;
      try { src.stop(); } catch (e) {}
      programs.delete(key);
    });
  }

  // Browsers may suspend a context created before a user gesture. Only resume
  // an existing programme bus; these listeners never request devices or start
  // any destination/recording. Keeping the same track preserves live outputs.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide',event=>{if(event.persisted)return;
      if(programmePreparation){const request=programmePreparation;request.abort(new Error('The Studio closed before Preview was ready.'));request.finish();}
      clearTimeout(transition?.timer);
      releaseSceneMedia(doc.programmeSnapshot);releaseSceneMedia(transition?.from);releaseSceneMedia(transition?.to);transition=null;
    });
    const resumeProgrammeAudio = () => { if ((programs.size || monitoringEnabled || previewMixNodes.size || previewMonitoringEnabled) && actx && actx.state === 'suspended') resumeAudio(true); };
    window.addEventListener('pointerdown', resumeProgrammeAudio, { passive:true });
    window.addEventListener('keydown', resumeProgrammeAudio);
  }

  load();

  return {
    syncMix, audioLevel, audioStatus, audioMonitoringStatus, setAudioMonitoring, setAudioMonitorVolume, audioMeter,sourceAudioMeter,
    audioOutputStatus:()=>outputRoute?.status() || null,
    setPreviewAudioScene, previewAudioStatus, previewAudioMeter, previewAudioMonitoringStatus, setPreviewAudioMonitoring, setPreviewAudioMonitorVolume,
    programSource, releaseProgram, resumeAudio,
    get program() {
      return [...programs.values()].find(src => src._aspect === '16x9') ||
             programs.values().next().value || null;
    },
    get programs() { return programs; },
    get audioSources() { return mixNodes.size; },
    version: 2,
    LAYOUTS, ASPECTS, rects, layoutSlots,
    freeTransform,freeLayers,sceneContents,sceneContentBounds,sceneContentCapabilities,updateSceneContent,removeSceneContent,sceneContentHistory,undoSceneContent,redoSceneContent,sourceRectNormalized,sourcePictureRectNormalized,sourceInputSelection,sourceOutputFit,updateSourceInputSelection,renderSourceInput,addFreeSource,updateFreeSource,moveFreeLayer,removeFreeSource,insertSceneSources,prepareSourceLayerPlacement,discardUnplacedSource,
    prepareSceneArrangement,renderSceneDraft,arrangementHistory,undoSceneArrangement,redoSceneArrangement,
    updateSourceItem,duplicateSourceItem,reorderSourceItems,
    creativeLayer,editCreativeLayer,creativeHistory,stepCreativeHistory,renderCreativeLayer,
    addSourceEffect,updateSourceEffect,removeSourceEffect,moveSourceEffect,sourceEffectStatus,addGeneratorSource,updateGeneratorSource,addLibrarySource,updateSportsSource,updateAudienceSource,createAudienceGraphicScene,
    sources, programmeMedia, addSource, addMediaSource, removeSource, sizeOf, sourceStatus, restoreSourceRuntimes, replaceSceneSource,
    sourceUsage, sourceInUse, removeUnusedSource,
    doc: () => doc, scenes, active, defaultScene, setActive, transitionTo, enablePreviewWorkflow, takePreviewScene,
    beginManualTransition,setManualTransition,cancelTransition,transitionState,
    captureSceneRenderState, saveSceneRenderState,
    addScene, createScene, prepareSportsTemplateScene,createSportsTemplateScene,createSportsTemplatePack,sportsTemplateInfo, importSceneFile, exportSceneSettings, duplicateScene, removeScene, renameScene, setLayout, applySceneTemplate, clearSceneTemplate, setSceneTemplateExtras, bind, setSlotGain, setSlotMute, save,
    addSceneSvgPart,addSceneSvgParts,updateSceneSvgPart,updateSceneSvgPartItem,removeSceneSvgPart,reorderSceneSvgParts,splitSceneTemplate,
    svgPartsHistory,undoSceneSvgParts,redoSceneSvgParts,svgPartsStatus,sceneExtrasEnabled,
    addWidget, removeWidget, removeWidgetAssetEverywhere, setWidgetVisible,
    setWidgetRect, moveWidget, widgetLayer, hasVisual, visualStatus, sceneThemeFontStatus, setWidgetPreviewScene, setSceneMonitorScenes,
    canvas, frameInfo, start, stop, miniature, renderSceneMonitor,
    get running() { return running; },
    get previewWorkflow() { return previewWorkflow; },
    get compositorFps() { return fps; }
  };
})();
