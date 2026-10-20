/* RECORD PANEL — recording.htm, in Arena's control set and Arena's order.
   ==========================================================================
   recording.htm: "All things related to recording in Arena and Avenue happen
   in the Record Panel." Its controls, verbatim from that page:

     the big record button   — "starts and stops the recording depending on
                                your Start and Duration settings"
     Source                  — "controls which part of the composition you want
                                to record. You could be recording the entire
                                composition, a specific layer, a specific group
                                or the Crossfader. Additionally, you can record
                                screens from the Advanced Output."
     Media                   — "whether you are recording video, audio or both"
     After Recording         — "what should happen after the recording process
                                has ended. You can choose to do nothing, or
                                place the recorded movie onto an empty clip"
     Preset                  — "used to select a recording preset ... you can
                                use the cogwheel next to the preset to jump to
                                the recording preferences"
     Start / Duration        — "allow you to have full control over the
                                recording process. You can manually control the
                                recording or let time or the BPM take control."

   All seven are built here. What a browser cannot do is DISABLED WITH THE
   REASON NAMED, never hidden and never faked — the .unimpl contract this
   codebase already uses for Spout, NDI and pass-through effects.

   Arena's default preset is QuickTime + DXV3; DXV and ProRes need a native
   encoder, so those presets are offered and refused with that reason. H264 is
   offered only when MediaRecorder reports an actual H264 format. Motion JPEG
   also requires a native encoder; a WebM file is not a Motion JPEG recording.

   Styling: no new CSS approach. .prow is the same parameter-row primitive the
   inspector uses, and every colour comes from a token.
   ========================================================================== */
window.OpenLiveRecordPanel = (() => {
  'use strict';

  const el = id => document.getElementById(id);
  const SESSION_REASON='Recording is disabled. This session does not save files or recordings.';
  const sessionOnly=()=>!!window.OpenLiveSessionPolicy?.sessionOnly;

  /* ---- Arena's option sets ------------------------------------------------
     Sources: Arena offers composition / layer / group / crossfader / Advanced
     Output screens. This clone renders monitors for composition, layer and
     preview; group, crossfader and screens have no surface here, so they are
     listed and refused rather than quietly dropped. */
  const SOURCES = [
    { id:'composition', label:'Composition', canvas:'monComp' },
    { id:'layer',       label:'Layer',       canvas:'monLayer' },
    { id:'preview',     label:'Preview',     canvas:'monPreview' },
    { id:'group',       label:'Group',       why:'This clone has no Group monitor to capture. recording.htm lists Group as a Source; the surface does not exist here yet.' },
    { id:'crossfader',  label:'Crossfader',  why:'This clone has no Crossfader monitor to capture. recording.htm lists it as a Source; the surface does not exist here yet.' },
    { id:'screen',      label:'Advanced Output Screen', why:'Recording a Screen means reading the Advanced Output canvas, which lives in a separate window. Not wired yet.' }
  ];

  const MEDIA = [
    { id:'video', label:'Video' },
    { id:'both',  label:'Video + Audio' },
    { id:'audio', label:'Audio', why:'Audio-only recording would come from the Show master bus, not a canvas. Not wired yet.' }
  ];

  const AFTER = [
    { id:'nothing', label:'Do Nothing' },
    { id:'clip',    label:'Place on empty Clip', why:'Importing the finished movie back into an empty Clip Slot needs the file handed to the media pipeline. Not wired yet.' }
  ];

  /* Arena's own preset names (arena-data.js PRESETS['Render and Record']).
     Only the ones a browser can actually encode are selectable. */
  const PRESETS = [
    { id:'h264-high',   label:'H264 High Quality',   codec:'h264', bitrate:16000000 },
    { id:'h264-medium', label:'H264 Medium Quality', codec:'h264', bitrate:8000000 },
    { id:'h264-low',    label:'H264 Low Quality',    codec:'h264', bitrate:3000000 },
    { id:'mjpeg',       label:'Motion JPEG', why:'Motion JPEG recording requires a native encoder. Browser WebM formats encode VP8, VP9 or AV1, not Motion JPEG.' },
    { id:'dxv3-hq-a',   label:'DXV 3 High Quality With Alpha',   why:'DXV 3 is Resolume’s own GPU codec. Encoding it needs a native encoder; no browser API can produce it.' },
    { id:'dxv3-hq',     label:'DXV 3 High Quality No Alpha',     why:'DXV 3 is Resolume’s own GPU codec. Encoding it needs a native encoder; no browser API can produce it.' },
    { id:'dxv3-nq-a',   label:'DXV 3 Normal Quality With Alpha', why:'DXV 3 is Resolume’s own GPU codec. Encoding it needs a native encoder; no browser API can produce it.' },
    { id:'dxv3-nq',     label:'DXV 3 Normal Quality No Alpha',   why:'DXV 3 is Resolume’s own GPU codec. Encoding it needs a native encoder; no browser API can produce it.' },
    { id:'prores-hq',   label:'ProRes 422 High Quality',   why:'ProRes needs a native encoder. No browser API can produce it.' },
    { id:'prores-nq',   label:'ProRes 422 Normal Quality', why:'ProRes needs a native encoder. No browser API can produce it.' },
    { id:'prores-4444', label:'ProRes 4444',               why:'ProRes needs a native encoder. No browser API can produce it.' }
  ];

  /* "You can manually control the recording or let time or the BPM take
     control." [recording.htm] */
  const START = [
    { id:'manual', label:'Manual' },
    { id:'bpm',    label:'On next Beat', why:'Beat-synchronised recording is not implemented. Choose Manual to start immediately.' }
  ];
  const DURATION = [
    { id:'manual', label:'Manual' },
    { id:'time',   label:'Time' },
    { id:'bars',   label:'Bars' }
  ];

  const state = {
    source:'composition', media:'video', after:'nothing',
    preset:'h264-high', start:'manual', duration:'manual',
    seconds:30, bars:8
  };

  function availablePresets(){
    let formats=[];
    try { formats=window.OpenLiveStream?.capabilities().recorderFormats||[]; } catch(error) {}
    const h264=formats.find(format=>/avc1|h264/i.test(format.mime||''));
    const presets=PRESETS.map(preset=>preset.codec==='h264'?
      h264?{...preset,format:h264.id,mime:h264.mime}:
      {...preset,why:'This browser does not report a supported H264 recording format.'}:{...preset});
    for(const format of formats){
      if(/avc1|h264/i.test(format.mime||'')) continue;
      presets.push({id:'browser:'+format.id,label:format.label||format.id,
        format:format.id,mime:format.mime,bitrate:8000000});
    }
    return presets;
  }
  function optionsFor(list){ return list===PRESETS?availablePresets():list; }
  function find(list,id){ const options=optionsFor(list); return options.find(x => x.id === id) || options[0]; }

  /* One row, built on the .prow primitive the inspector panels use. */
  function selectRow(label, list, value, onChange, title){
    const row = document.createElement('div');
    row.className = 'prow record-row';
    row.innerHTML = '<div class="tw"></div><label>' + label + '</label>';
    const sel = document.createElement('select');
    sel.className = 'record-select';
    sel.setAttribute('aria-label', label);
    sel.disabled=sessionOnly();
    if(sel.disabled) sel.title=SESSION_REASON;
    else if(title) sel.title = title;
    optionsFor(list).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.label;
      if(o.why){ opt.disabled = true; opt.textContent = o.label + ': unavailable'; opt.title = o.why; }
      sel.appendChild(opt);
    });
    sel.value = value;
    sel.addEventListener('change', () => { if(!sel.disabled) onChange(sel.value, find(list, sel.value)); });
    row.appendChild(sel);
    return row;
  }

  function numberRow(label, value, min, max, unit, onChange){
    const row = document.createElement('div');
    row.className = 'prow record-row';
    row.innerHTML = '<div class="tw"></div><label>' + label + '</label>';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'record-number';
    inp.min = min; inp.max = max; inp.value = value;
    inp.setAttribute('aria-label', label);
    inp.disabled=sessionOnly(); if(inp.disabled) inp.title=SESSION_REASON;
    inp.addEventListener('change', () => { if(!inp.disabled) onChange(Math.max(min, Math.min(max, +inp.value || min))); });
    row.appendChild(inp);
    const u = document.createElement('span'); u.className = 'record-unit'; u.textContent = unit;
    row.appendChild(u);
    return row;
  }

  function note(text){ const n = el('recordNote'); if(n) n.textContent = text || ''; }

  function build(){
    const rows = el('recordRows'); if(!rows) return;
    rows.innerHTML = '';
    const presets=availablePresets();
    if(!presets.some(preset=>preset.id===state.preset&&!preset.why)){
      const supported=presets.find(preset=>!preset.why);
      if(supported) state.preset=supported.id;
    }

    rows.appendChild(selectRow('Source', SOURCES, state.source, (v, o) => {
      if(o.why){ note(o.why); return; }
      state.source = v; note(''); describe();
      if(window.OpenLiveBroadcastUI) window.OpenLiveBroadcastUI.setSource(v);
    }, 'Which part of the composition to record [recording.htm]'));

    rows.appendChild(selectRow('Media', MEDIA, state.media, (v, o) => {
      if(o.why){ note(o.why); return; }
      state.media = v; note('');
    }, 'Record video, audio or both [recording.htm]'));

    rows.appendChild(selectRow('After Recording', AFTER, state.after, (v, o) => {
      if(o.why){ note(o.why); return; }
      state.after = v; note('');
    }, 'What happens when the recording ends [recording.htm]'));

    rows.appendChild(selectRow('Preset', PRESETS, state.preset, (v, o) => {
      if(o.why){ note(o.why); return; }
      state.preset = v; note(''); describe();
    }, 'Codec and quality [recording.htm]'));

    rows.appendChild(selectRow('Start', START, state.start, (v,o) => { if(o.why){note(o.why);return;} state.start = v; note(''); },
      'Start manually or on the next beat [recording.htm]'));

    rows.appendChild(selectRow('Duration', DURATION, state.duration, v => {
      state.duration = v; note(''); build();
    }, 'Run until stopped, or for a set time [recording.htm]'));

    if(state.duration === 'time')
      rows.appendChild(numberRow('Length', state.seconds, 1, 7200, 'sec', v => { state.seconds = v; }));
    if(state.duration === 'bars')
      rows.appendChild(numberRow('Length', state.bars, 1, 512, 'bars', v => { state.bars = v; }));

    describe();
  }

  /* Say what will actually happen, in real numbers. */
  function describe(){
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      note(SESSION_REASON);
      return;
    }
    const src = find(SOURCES, state.source);
    const c = src.canvas ? document.getElementById(src.canvas) : null;
    const p = find(PRESETS, state.preset);
    if(p.why){note(p.why);return;}
    if(!c){ note(src.why || 'That Source has no surface to capture.'); return; }
    note(src.label + ': ' + c.width + '×' + c.height + ', ' + p.label +
         '. This records the monitor, not the full-resolution output.');
  }

  /* Duration in ms, from Arena's Duration control. BPM comes from the transport. */
  function durationMs(){
    if(state.duration === 'time') return state.seconds * 1000;
    if(state.duration === 'bars'){
      const bpmEl = document.getElementById('bpm');
      const bpm = bpmEl ? (parseFloat(bpmEl.value || bpmEl.textContent) || 120) : 120;
      return Math.round((state.bars * 4 * 60000) / bpm);   /* 4 beats to the bar */
    }
    return 0;   /* Manual: runs until stopped */
  }

  function config(){
    window.OpenLiveSessionPolicy?.assertCanWrite('Recording');
    const p = availablePresets().find(preset=>preset.id===state.preset);
    if(!p) throw new Error('The recording preset is unavailable. Choose a supported Preset.');
    if(p.why) throw new Error(p.why);
    if(state.start!=='manual') throw new Error(START.find(option=>option.id===state.start)?.why||'Choose Manual to start recording.');
    const source=SOURCES.find(option=>option.id===state.source),media=MEDIA.find(option=>option.id===state.media),after=AFTER.find(option=>option.id===state.after);
    if(!source||!media||!after) throw new Error('The recording settings are unavailable. Choose a supported Source, Media and After Recording option.');
    if(source.why||media.why||after.why) throw new Error(source.why||media.why||after.why);
    return {
      sourceId: state.source,
      canvasId: find(SOURCES, state.source).canvas,
      audio: state.media !== 'video',
      format:p.format, mime: p.mime, bitrate: p.bitrate,
      durationMs: durationMs(),
      startOnBeat: false,
      after: state.after
    };
  }

  function setRecording(on, text){
    const b = el('recordBig'); if(!b) return;
    b.dataset.state = on ? 'recording' : 'idle';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const l = b.querySelector('.record-big-label');
    if(l) l.textContent = text || (on ? 'STOP' : 'RECORD');
    b.classList.toggle('on-red', !!on);
  }

  function readout(t){ const o = el('recordReadout'); if(o) o.textContent = t; }

  /* ---- STREAM half -------------------------------------------------------
     Broadcast is Record AND Stream. This is the Stream half.

     It deliberately does NOT edit Destinations. arena-data.js:612 settled that
     when it retired the old Stream & Record dialog: "Two surfaces setting the
     same things is worse than one, even when one of them is familiar." The
     Destination list, its URLs and its encoder profile belong to the Broadcast
     screen in SHOWAVE Map, and the full studio is broadcast.html.

     What belongs HERE is what an operator needs while a show is running: is it
     on air, what is carrying it, and one control that stops everything. Every
     number comes from OpenLiveStream.streaming.getState(), which counts real
     sessions - nothing here is inferred. */
  let streamSub = null;
  const RELAY_CAPABILITY_CACHE_MS=15000, RELAY_CAPABILITY_TIMEOUT_MS=8000;
  let relayCapabilityRequest=null, relayCapabilitySerial=0;
  let relayCapabilityCheckedAt=0, relayCapabilityText='';

  function cancelRelayCapabilityCheck(){
    const request=relayCapabilityRequest; if(!request) return;
    relayCapabilityRequest=null; relayCapabilitySerial++;
    if(request.controller) request.controller.abort();
    clearTimeout(request.timer);
  }
  function updateRelayCapability(){
    const n=el('streamNote'); if(!n) return;
    const panel=el('recordPanel'); if(panel&&panel.hidden) return;
    if(relayCapabilityText) n.textContent=relayCapabilityText;
    if(relayCapabilityRequest||relayCapabilityCheckedAt&&Date.now()-relayCapabilityCheckedAt<RELAY_CAPABILITY_CACHE_MS) return;
    if(!relayCapabilityText) n.textContent='Checking the local RTMP relay…';
    const request={serial:++relayCapabilitySerial,controller:typeof AbortController==='function'?new AbortController():null,timer:null};
    relayCapabilityRequest=request;
    const timeout=new Promise((resolve,reject)=>{
      request.timer=setTimeout(()=>{
        if(request.controller) request.controller.abort();
        reject(new Error('Relay capability timed out.'));
      },RELAY_CAPABILITY_TIMEOUT_MS);
    });
    const fetchCapability=Promise.resolve().then(()=>fetch('/api/relay/capability', {
      cache:'no-store',...(request.controller?{signal:request.controller.signal}:{})
    })).then(response=>{
      if(!response.ok) throw new Error('Relay capability unavailable');
      return response.json();
    });
    Promise.race([fetchCapability,timeout]).then(cap=>{
      if(relayCapabilityRequest!==request||request.serial!==relayCapabilitySerial) return;
      if(!cap||typeof cap!=='object') throw new Error('Relay capability returned no status');
      relayCapabilityText=cap.ffmpeg
        ? (cap.relay
            ? 'RTMP/RTMPS relay available through the local helper. Open Broadcast Studio to check sources, audio and channels before going live.'
            : 'FFmpeg was found, but the local streaming relay is unavailable. ' +
              (cap.why || 'Check the helper before going live.'))
        : 'RTMP: ' + (cap.why || 'unavailable') +
          ' WHIP and the OBS hand-off do not need it.';
      const current=el('streamNote'); if(current) current.textContent=relayCapabilityText;
    }).catch(()=>{
      if(relayCapabilityRequest!==request||request.serial!==relayCapabilitySerial) return;
      relayCapabilityText='The local helper did not answer, so RTMP availability is unknown. ' +
        'WHIP and the OBS hand-off do not depend on it.';
      const current=el('streamNote'); if(current) current.textContent=relayCapabilityText;
    }).finally(()=>{
      clearTimeout(request.timer);
      if(relayCapabilityRequest===request){
        relayCapabilityRequest=null; relayCapabilityCheckedAt=Date.now();
      }
    });
  }

  function streamRow(label, value, title){
    const row = document.createElement('div');
    row.className = 'prow record-row';
    row.innerHTML = '<div class="tw"></div><label>' + label + '</label>';
    const v = document.createElement('span');
    v.className = 'record-readvalue';
    v.textContent = value;
    if(title) v.title = title;
    row.appendChild(v);
    return row;
  }

  function renderStream(){
    const rows = el('streamRows'); if(!rows) return;
    const S = window.OpenLiveStream;
    rows.innerHTML = '';
    if(!S||!S.streaming||typeof S.streaming.getState!=='function'){
      cancelRelayCapabilityCheck();
      rows.appendChild(streamRow('Status', 'unavailable',
        'openlive-stream.js is not loaded, so nothing can transmit.'));
      const stop=el('streamStopAll'); if(stop) stop.disabled=true;
      const n=el('streamNote'); if(n) n.textContent='The streaming runtime is unavailable. Reload the system before checking outputs.';
      return;
    }
    const st = S.streaming.getState();
    const PHASE = { live:'ON AIR', uncertain:'UNCERTAIN', connecting:'CONNECTING', off:'OFF AIR' };
    rows.appendChild(streamRow('Status', PHASE[st.phase] || 'OFF AIR',
      st.uncertain ? 'A session is reconnecting, stopping is unconfirmed, or an OBS client has not confirmed it is streaming.' : ''));
    rows.appendChild(streamRow('Carried by', st.sources.length ? st.sources.join(' + ') : 'N/A',
      'WHIP and RTMP are sessions this app opened. OBS is a client that connected to it.'));
    rows.appendChild(streamRow('WHIP sessions', String(st.whipSessions)));
    rows.appendChild(streamRow('RTMP sessions', String(st.relaySessions || 0)));
    rows.appendChild(streamRow('OBS connections', String(st.obsConnections)));

    const stop = el('streamStopAll');
    if(stop){
      const any = st.whipSessions > 0 || st.relaySessions > 0;
      const canStop=typeof S.streaming.stopAll==='function';
      stop.disabled = !any||!canStop;
      stop.classList.toggle('on-red', any&&canStop&&st.onAir);
      stop.title = any&&!canStop?'This streaming runtime cannot stop owned sessions here. Use Broadcast Studio.'
                       : any ? 'Stop the WHIP and RTMP sessions this app owns. OBS is controlled in OBS.'
                       : st.obsConnections>0?'OBS streams are controlled in OBS. This app has no WHIP or RTMP sessions to stop.'
                       : 'Nothing is open, so there is nothing to stop.';
    }

    /* RTMP is the transport an operator will ask for by name, so say where it
       stands rather than leaving them to discover it in a destination row. */
    updateRelayCapability();
  }

  function initStream(){
    const S = window.OpenLiveStream;
    const stop = el('streamStopAll');
    if(stop) stop.addEventListener('click', () => {
      if(!S || !S.streaming || typeof S.streaming.stopAll !== 'function'){
        if(typeof window.msg === 'function')
          window.msg('This build of openlive-stream.js exposes no stopAll, so sessions ' +
                     'must be stopped from the Broadcast Studio.');
        return;
      }
      const state=S.streaming.getState();
      if(!(state.whipSessions>0||state.relaySessions>0)){
        renderStream(); return;
      }
      const r = S.streaming.stopAll();
      if(typeof window.msg === 'function'){
        /* OBS is not ours to stop - it pulls from a Browser Source. Say so
           rather than reporting a clean sweep that did not happen. */
        window.msg(r.stopped
          ? 'Stop requested for ' + r.stopped + ' session' + (r.stopped === 1 ? '' : 's') +
            (r.obsLeftAlone ? '. ' + r.obsLeftAlone + ' OBS connection' +
              (r.obsLeftAlone === 1 ? '' : 's') + ' left running - stop those in OBS.' : '.')
          : r.obsLeftAlone
            ? 'Nothing of ours was open. ' + r.obsLeftAlone + ' OBS connection' +
              (r.obsLeftAlone === 1 ? '' : 's') + ' is pulling from a Browser Source; stop it in OBS.'
            : 'Nothing was open.');
      }
      renderStream();
    });
    const open = el('streamOpenStudio');
    if(open) open.addEventListener('click', () => {
      /* THIS BUTTON WAS DEAD. It tested for `window.openPanel`, then for
         `window.msg`, and app.js is one IIFE — neither name has ever existed on
         window, so both arms were false and clicking did nothing, silently.
         app.js exports its panel entry points deliberately (__openliveClosePanel
         at app.js:1601); __openliveOpenBroadcast is the matching one, and it
         opens the studio as its own window, which is the only way its camera
         Source can start at all (broadcast.html:597).
         If the export is genuinely absent the button now SAYS so instead of
         swallowing the click. */
      if(typeof window.__openliveOpenBroadcast === 'function'){ window.__openliveOpenBroadcast(); return; }
      /* streamNote, not note() — note() writes recordNote, which is the OTHER
         half of Broadcast and, since the halves became columns, the other side
         of the panel. This button is Stream's, so it reports into Stream's. */
      const n = el('streamNote');
      cancelRelayCapabilityCheck();
      if(n) n.textContent = 'SHOWAVE Live did not expose the studio entry point. Open Output > SHOWAVE Broadcast.';
    });
    if(S && S.streaming && S.streaming.subscribe && !streamSub){
      try { streamSub = S.streaming.subscribe(() => renderStream()); } catch(e){}
    }
  }

  function show(on){
    const p = el('recordPanel'); if(!p) return;
    p.hidden = !on;
    if(!on) cancelRelayCapabilityCheck();
    if(on && !p.dataset.built){ build(); initStream(); p.dataset.built = '1'; }
    if(on) renderStream();
  }

  function init(){
    const b = el('recordBig');
    if (b && window.OpenLiveSessionPolicy?.sessionOnly) {
      b.disabled = true;
      b.title = SESSION_REASON;
      b.setAttribute('aria-disabled','true');
    }
    if(b) b.addEventListener('click', () => {
      const B = window.OpenLiveBroadcastUI;
      if(!B) return;
      B.toggle();
    });
    /* Follow the browser tab strip: the panel belongs to Broadcast only. */
    const tabs = document.getElementById('brTabs');
    if(tabs) tabs.addEventListener('click', e => {
      const t = e.target.closest('.ptab'); if(!t) return;
      show(t.dataset.b === 'bRecord');
    });
    show(false);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { config: config, build: build, show: show, state: state,
           renderStream: renderStream,
           setRecording: setRecording, readout: readout,
           SOURCES: SOURCES, PRESETS: PRESETS, presets:availablePresets };
})();
