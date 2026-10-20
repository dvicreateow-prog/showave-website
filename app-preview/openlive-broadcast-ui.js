/* SHOWAVE Broadcast — the transport control.
   ==========================================================================
   Arena has a Record Panel (recording.htm) and NO stream control at all:
   streaming.htm says plainly "It's not possible to directly stream from
   Resolume" — that is OBS's job, over NDI. So BROADCAST is a union name over
   one parity half (Record) and one SHOWAVE extension (Stream), and inside the
   panel every Arena control keeps its Arena name.

   The button captions RECORD / WRITING... / STOP are Arena's own strings,
   lifted from reference/docs/gui/English.txt:23-25.

   This file owns only the transport control. It does not open WHIP sessions
   and does not edit destinations — arena-data.js:612 already committed this
   codebase against two surfaces setting the same thing, and Destinations
   belong to the Broadcast screen in SHOWAVE Map. Recording is performed by
   window.OpenLiveStream.recorder, which already exists and works.

   Honesty contract (CLAUDE.md): a control that cannot do its job says so and
   names the capability it needs, rather than appearing to work.
   ========================================================================== */
window.OpenLiveBroadcastUI = (() => {
  'use strict';

  let session = null;        /* the live recorder session, or null */
  let ticking = null;        /* elapsed-time interval */
  let watchdog = null;       /* no-frames watchdog */
  let startedSilent = false; /* true if the source never produced a frame */
  let starting = false;      /* one capture/save request at a time */

  const el = id => document.getElementById(id);
  const btn = () => el('broadcastRecord');
  const readout = () => el('broadcastElapsed');

  /* The surface being recorded. Arena's Record Panel Source offers the
     composition, a layer, a group, the crossfader, or an Advanced Output
     screen. This clone can honestly offer the monitors it actually renders,
     and must state their size: #monComp is a fixed 320x180 preview
     (index.html), NOT the composition raster. */
  const SOURCES = [
    { id: 'composition', label: 'Composition', canvas: 'monComp' },
    { id: 'layer',       label: 'Layer',       canvas: 'monLayer' },
    { id: 'preview',     label: 'Preview',     canvas: 'monPreview' }
  ];
  let sourceId = 'composition';

  function sourceCanvas(){
    const s = SOURCES.find(x => x.id === sourceId) || SOURCES[0];
    return document.getElementById(s.canvas);
  }

  /* {ok:true} | {ok:false, why} — the shape destCapability() uses in
     openlive-output-editor.js, so a refusal reads the same everywhere. */
  function capability(){
    if (window.OpenLiveSessionPolicy?.sessionOnly)
      return { ok:false, why:'Recording is disabled. This session does not save files or recordings.' };
    const S = window.OpenLiveStream;
    if(!S) return { ok:false, why:'openlive-stream.js is not loaded, so nothing can record.' };
    const caps = S.capabilities();
    if(!caps.mediaRecorder)
      return { ok:false, why:'This browser has no MediaRecorder, which is what encodes the file.' };
    if(!caps.canvasCapture)
      return { ok:false, why:'This browser cannot captureStream() a canvas, so there is no picture to record.' };
    if(!caps.recorderFormats || !caps.recorderFormats.length)
      return { ok:false, why:'MediaRecorder here supports none of the containers this app can write.' };
    if(!sourceCanvas())
      return { ok:false, why:'The ' + sourceId + ' monitor is not on screen, so there is no surface to capture.' };
    return { ok:true };
  }

  function setState(state, detail){
    const b = btn(); if(!b) return;
    const LABEL = { idle:'BROADCAST', starting:'STARTING...', recording:'STOP', writing:'WRITING...',
                    failed:'FAILED', blocked:'BROADCAST' };
    b.dataset.state = state;
    const label = b.querySelector('.broadcast-label');
    if(label) label.textContent = LABEL[state] || 'BROADCAST';
    b.classList.toggle('on-red', state === 'recording' || state === 'writing' || state === 'failed');
    b.classList.toggle('unimpl', state === 'blocked');
    b.setAttribute('aria-pressed', (state === 'recording' || state === 'writing') ? 'true' : 'false');
    b.disabled = (state === 'starting' || state === 'writing' || state === 'blocked');
    if(state === 'blocked'){
      b.setAttribute('aria-disabled','true');
      if(detail) b.title = detail;
    } else {
      b.removeAttribute('aria-disabled');
      if(state === 'failed' && detail) b.title = detail;
      else b.title = state === 'recording'
        ? 'Recording. Click to stop and write the file.'
        : 'Broadcast: record the Show to disk. Click to start, click again to stop.';
    }
  }

  function showElapsed(on){
    const o = readout(); if(!o) return;
    o.hidden = !on;
    if(!on){ if(ticking) clearInterval(ticking); ticking = null; o.textContent = ''; return; }
    const tick = () => {
      if(!session) return;
      const s = Math.max(0, Math.round((Date.now() - session.startedAt)/1000));
      const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s % 60).padStart(2,'0');
      const mb = session.bytes ? ' · ' + (session.bytes/1048576).toFixed(1) + ' MB' : '';
      o.textContent = mm + ':' + ss + mb;
      if(window.OpenLiveRecordPanel) window.OpenLiveRecordPanel.readout(mm + ':' + ss);
    };
    tick();
    ticking = setInterval(tick, 1000);
  }

  function say(t){ if(typeof window.msg === 'function') window.msg(t); }

  function start(){
    if(starting||session) return;
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Recording'); }
      catch (error) { setState('blocked', error.message); say(error.message); }
      return;
    }
    const can = capability();
    if(!can.ok){ setState('blocked', can.why); say(can.why); return; }
    const S = window.OpenLiveStream;
    /* The Record Panel owns Source, Media, Preset, Start and Duration
       [recording.htm]; this control is its transport. When the panel is not
       loaded the defaults below still give a working record button. */
    const P = window.OpenLiveRecordPanel;
    let cfg,format;
    try{
      cfg = P ? P.config() : null;
      if(cfg&&cfg.startOnBeat) throw new Error('Beat-synchronised recording is not implemented. Choose Manual to start immediately.');
      const formats=S.capabilities().recorderFormats||[];
      if(cfg&&cfg.format){
        format=formats.find(item=>item.id===cfg.format);
      }else if(cfg&&cfg.mime){
        const requested=String(cfg.mime).toLowerCase();
        format=formats.find(item=>String(item.mime).toLowerCase()===requested)||
          formats.find(item=>String(item.mime).toLowerCase().split(';')[0]===requested);
      }else format=formats[0];
      if(!format) throw new Error('The selected recording codec is unavailable in this browser. Choose a supported Preset.');
    }catch(error){setState('failed',error.message);say(error.message);return;}
    if(cfg && cfg.canvasId) sourceId = cfg.sourceId;
    const c = sourceCanvas();
    if(!c){setState('failed','The selected recording Source has no monitor to capture.');say('The selected recording Source has no monitor to capture.');return;}
    let source;
    try { source = S.sources.fromCanvas(c, { fps:30, audio: cfg ? cfg.audio : false }); }
    catch(e){ setState('failed', e.message); say(e.message); return; }
    starting=true; setState('starting');
    let pending;
    try{ pending=S.recorder.start({
      source: source,
      format:format.id,
      fileName: 'SHOWAVE-' + sourceId,
      durationMs: cfg ? cfg.durationMs : 0,
      bitrate: cfg ? cfg.bitrate : undefined,
      onState: (state, err) => {
        if(state === 'recording'){ setState('recording'); showElapsed(true);
          if(window.OpenLiveRecordPanel) window.OpenLiveRecordPanel.setRecording(true); }
        else if(state === 'stopped'){
          const name = session && session.fileName;
          const empty = session && session.bytes === 0;
          if(watchdog){ clearTimeout(watchdog); watchdog = null; }
          setState('idle'); showElapsed(false);
          if(window.OpenLiveRecordPanel) window.OpenLiveRecordPanel.setRecording(false);
          say(empty
            ? 'Nothing was recorded. The ' + sourceId + ' monitor never drew a frame. ' +
              'Play a clip, then record.'
            : 'Recording written' + (name ? ': ' + name : ''));
          try { source.stop(); } catch(e){}
          session = null;
        } else if(state === 'failed'){
          if(watchdog){ clearTimeout(watchdog); watchdog = null; }
          const why = (err && err.message) || 'The recording failed.';
          setState('failed', why); showElapsed(false);
          if(window.OpenLiveRecordPanel) window.OpenLiveRecordPanel.setRecording(false);
          say(why);
          try { source.stop(); } catch(e){}
          session = null;
        }
      }
    }); }catch(error){
      starting=false;setState('failed',error.message);say(error.message);
      try{source.stop();}catch(ignore){} return;
    }
    Promise.resolve(pending).then(s => {
      starting=false;
      session = s;
      /* State the real resolution rather than implying composition raster:
         recording.htm records the actual output; this records a monitor. */
      say('Recording ' + sourceId + ' at ' + c.width + '×' + c.height + ': ' + s.fileName);
      /* A canvas only emits frames to captureStream when something DRAWS to it.
         Recording an idle monitor therefore writes a valid but empty file, and
         reporting that as a successful recording is exactly the false success
         CLAUDE.md forbids. Measured: 0 bytes idle, >0 as soon as the canvas is
         painted. So watch the byte counter and say what is actually happening. */
      startedSilent = false;
      if(watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if(session === s && s.bytes === 0){
          startedSilent = true;
          say('Recording, but the ' + sourceId + ' monitor is not drawing. ' +
              'Nothing is playing, so the file will be empty until it does.');
        }
      }, 3000);
    }).catch(e => {
      starting=false;
      const why = (e && e.message) || 'Recording could not start.';
      /* A cancelled save dialog is a choice, not a failure. */
      if(/abort/i.test(why)){ setState('idle'); say('Recording cancelled'); }
      else { setState('failed', why); say(why); }
      try { source.stop(); } catch(err){}
      session = null;
    });
  }

  function stop(){
    if(!session) return;
    setState('writing');
    try { window.OpenLiveStream.recorder.stop(session); }
    catch(e){ setState('failed', e.message); say(e.message); session = null; }
  }

  function toggle(){ if(session) stop(); else start(); }

  function openPanel(){
    const tab = document.querySelector('#brTabs .ptab[data-b="bRecord"]');
    if(tab){ tab.click(); tab.focus(); }
    const t = el('broadcastToggle');
    if(t) t.setAttribute('aria-expanded','true');
  }

  function init(){
    const b = btn(); if(!b) return;
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      // The main BROADCAST control opens streaming even when saving recordings
      // is disabled. The separate Record controls keep their no-write guard.
      const launch = () => {
        if (typeof window.__openliveOpenBroadcast === 'function') window.__openliveOpenBroadcast();
        else say('Broadcast Studio could not open. Reload SHOWAVE and try again.');
      };
      b.disabled = false;
      b.dataset.state = 'studio';
      b.classList.remove('unimpl');
      b.removeAttribute('aria-disabled');
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'Open Broadcast Studio');
      b.title = 'Open Broadcast Studio: connect channels, prepare Programme and Go Live.';
      const label = b.querySelector('.broadcast-label');
      if (label) label.textContent = 'BROADCAST';
      b.addEventListener('click', launch);
      const t = el('broadcastToggle');
      if (t) {
        t.title = 'Open Broadcast Studio';
        t.setAttribute('aria-label', 'Open Broadcast Studio');
        t.removeAttribute('aria-controls');
        t.setAttribute('aria-expanded', 'false');
        t.addEventListener('click', launch);
      }
      return;
    }
    b.addEventListener('click', toggle);
    const t = el('broadcastToggle');
    if(t) t.addEventListener('click', openPanel);
    const can = capability();
    setState(can.ok ? 'idle' : 'blocked', can.why);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    start: start, stop: stop, toggle: toggle, capability: capability,
    setSource: function(id){ sourceId = id; },
    sources: SOURCES,
    isRecording: function(){ return !!session; }
  };
})();
