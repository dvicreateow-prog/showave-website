/* ===========================================================================
   openlive-tools-ui.js — the Tools pane inside Alley.

   Renders window.OpenLiveTools as a card grid. A tool a browser cannot do is
   shown greyed WITH ITS REASON rather than hidden, so the list stays a true
   map of the suite instead of a shorter list that looks complete.
   =========================================================================== */
(() => {
  'use strict';
  const T = window.OpenLiveTools;
  const grid = document.getElementById('toolsGrid');
  const panel = document.getElementById('toolPanel');
  if (!T || !grid || !panel) return;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let live = null;                                   // a running mic/camera test, so it can be stopped
  let liveEpoch = 0;                                 // invalidates a permission request after the user leaves

  const setStatus = (element, message, state) => {
    element.textContent = message;
    if (state) element.dataset.state = state;
    else delete element.dataset.state;
  };

  const categoryLabel = category => ({
    media:'Media preparation', capture:'Device check', script:'Local builder', adapter:'Adapter required'
  }[category] || 'Utility');
  const readiness = T.TOOLS.map(tool => ({tool, state:T.stateOf(tool)}));
  const usable = readiness.filter(record => record.state.ok);
  const blocked = readiness.length - usable.length;
  const readyCount = document.getElementById('toolsReadyCount');
  const blockedCount = document.getElementById('toolsBlockedCount');
  const totalCount = document.getElementById('toolsTotalCount');
  const visibleCount = document.getElementById('toolVisibleCount');
  const noResults = document.getElementById('toolsNoResults');
  const search = document.getElementById('toolSearch');
  const filters = [...document.querySelectorAll('.tool-filter[data-filter]')];
  let activeFilter = 'all';

  if (readyCount) readyCount.textContent = usable.length;
  if (blockedCount) blockedCount.textContent = blocked;
  if (totalCount) totalCount.textContent = readiness.length;

  grid.innerHTML = readiness.map(({tool:t, state:st}) => {
    const stateLabel = st.ok ? (t.category === 'capture' ? 'Can test' : 'Ready') : 'Needs setup';
    const searchText = [t.name,t.blurb,t.note,st.why,t.category,t.out].filter(Boolean).join(' ').toLowerCase();
    const output = t.out || (t.kind === 'script' ? 'Local outline' : t.category === 'capture' ? 'Live check' : 'Details');
    const aria = st.ok
      ? `${t.name}. ${t.category === 'capture' ? 'Browser API available; Start checks the device and permission' : 'Ready'}. ${t.blurb}${t.out ? `. Output ${t.out}` : ''}`
      : `${t.name}. Needs setup. ${st.why}`;
    return `<button class="tool-card" type="button" data-tool="${esc(t.id)}"
        data-category="${esc(t.category || 'media')}" data-available="${st.ok ? 'true' : 'false'}"
        data-search="${esc(searchText)}" aria-controls="toolPanel" aria-pressed="false"
        data-selected="false" aria-label="${esc(aria)}">
      <span class="olt-card-head">
        <span class="olt-tool-mark">${esc(t.mark || 'TOOL')}</span>
        <span class="olt-availability" data-state="${st.ok ? 'success' : 'error'}">${stateLabel}</span>
      </span>
      <span class="olt-card-title">${esc(t.name)}</span>
      <span class="olt-summary">${esc(t.blurb)}</span>
      <span class="olt-card-foot"><span>${esc(categoryLabel(t.category))}</span><span class="olt-card-output">${esc(output)}</span></span>
    </button>`;
  }).join('');

  const applyFilter = () => {
    const query = String(search && search.value || '').trim().toLowerCase();
    let shown = 0;
    for (const card of grid.querySelectorAll('[data-tool]')) {
      const categoryMatch = activeFilter === 'all'
        || (activeFilter === 'blocked' && card.dataset.available === 'false')
        || card.dataset.category === activeFilter;
      const searchMatch = !query || card.dataset.search.includes(query);
      card.hidden = !(categoryMatch && searchMatch);
      if (!card.hidden) shown += 1;
    }
    if (visibleCount) visibleCount.textContent = `${shown} shown`;
    if (noResults) noResults.hidden = shown !== 0;
  };

  for (const filter of filters) filter.addEventListener('click', () => {
    activeFilter = filter.dataset.filter;
    for (const item of filters) {
      const on = item === filter;
      item.classList.toggle('active', on);
      item.setAttribute('aria-pressed', String(on));
    }
    applyFilter();
  });
  if (search) search.addEventListener('input', applyFilter);
  applyFilter();

  const auditData = document.getElementById('alleyToolsAuditData');
  if (auditData) auditData.textContent = JSON.stringify({
    ready:true, total:readiness.length, available:usable.length, blocked,
    tools:readiness.map(({tool,state}) => ({id:tool.id, name:tool.name, category:tool.category, ok:state.ok, why:state.why}))
  });

  const activateCard = card => {
    if (!card) return;
    const tool = T.TOOLS.find(x => x.id === card.getAttribute('data-tool'));
    if (!tool) return;
    for (const c of grid.querySelectorAll('[data-tool]')) {
      c.dataset.selected = 'false';
      c.setAttribute('aria-pressed', 'false');
    }
    card.dataset.selected = 'true';
    card.setAttribute('aria-pressed', 'true');
    openTool(tool);
  };

  grid.addEventListener('click', ev => {
    activateCard(ev.target.closest('[data-tool]'));
  });
  grid.addEventListener('keydown', ev => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(ev.key)) return;
    const cards = [...grid.querySelectorAll('[data-tool]:not([hidden])')];
    const card = ev.target.closest('[data-tool]');
    const at = cards.indexOf(card);
    if (at < 0) return;
    ev.preventDefault();
    const columns = Math.max(1, Math.round(grid.clientWidth / Math.max(1, card.getBoundingClientRect().width)));
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? cards.length - 1
      : ev.key === 'ArrowLeft' ? Math.max(0, at - 1)
      : ev.key === 'ArrowRight' ? Math.min(cards.length - 1, at + 1)
      : ev.key === 'ArrowUp' ? Math.max(0, at - columns)
      : Math.min(cards.length - 1, at + columns);
    cards[next].focus();
  });

  function stopLive() {
    liveEpoch += 1;
    if (live && live.stop) { try { live.stop(); } catch (e) {} }
    live = null;
  }

  window.addEventListener('pagehide', stopLive);
  window.addEventListener('beforeunload', stopLive);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); });
  const mainTabs = document.getElementById('mainTabs');
  if (mainTabs) mainTabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-pane]');
    if (tab && tab.getAttribute('data-pane') !== 'tTools') stopLive();
  });
  window.addEventListener('openlive:alleytabchange', event => {
    if (!event.detail || event.detail.pane !== 'tTools') stopLive();
  });

  const toolIntro = (t, output) => `<div class="olt-panel-eyebrow">${esc(categoryLabel(t.category))}</div>
    <h3 class="olt-panel-title">${esc(t.name)}</h3>
    <div class="olt-panel-note">${esc(t.note || t.blurb)}</div>
    <div class="olt-panel-meta"><b>Status</b><span>${t.category === 'capture' ? 'API available. Start checks device and permission' : 'Ready in this browser'}</span>
      <b>Output</b><span>${esc(output || t.out || 'Live diagnostic')}</span></div>`;

  function unavailableUI(t, state) {
    panel.innerHTML = `<div class="olt-panel-eyebrow">${esc(categoryLabel(t.category))}</div>
      <h3 class="olt-panel-title">${esc(t.name)}</h3>
      <div class="olt-panel-note">${esc(t.blurb)}</div>
      <div class="olt-blocked"><strong>Not runnable in this build</strong><span>${esc(state.why)}</span></div>
      <div class="olt-panel-meta"><b>Status</b><span>Needs setup</span>
        <b>Required</b><span>File-capable local transcription adapter</span></div>`;
  }

  function openTool(t) {
    stopLive();
    const state = T.stateOf(t);
    if (!state.ok) return unavailableUI(t, state);
    if (t.id === 'camera-test') return cameraUI(t);
    if (t.id === 'mic-test')    return micUI(t);
    if (t.kind === 'script')    return scriptUI(t);
    if (t.kind === 'document')  return documentUI(t);
    return fileUI(t);
  }

  function documentUI(t) {
    panel.innerHTML = `${toolIntro(t, 'Original presentation')}
      <input type="file" id="documentFile" accept="${esc(t.accept)}">
      <div class="olt-actions"><button class="tb-btn on" id="documentPrepare" type="button">Open original</button>
      <button class="tb-btn" id="documentSend" type="button" disabled>Add to SHOWAVE Live Files</button></div>
      <div class="hint olt-status olt-document-status" id="documentStatus" aria-live="polite" aria-atomic="true"></div>
      <div class="olt-actions"><button class="tb-btn" id="documentPrevious" type="button" disabled>Previous</button>
      <output class="hint" id="documentPosition">N/A</output>
      <button class="tb-btn" id="documentNext" type="button" disabled>Next</button></div>
      <div class="olt-document-pages" id="documentPages"></div>`;
    const input=panel.querySelector('#documentFile'), status=panel.querySelector('#documentStatus');
    const send=panel.querySelector('#documentSend'),prepare=panel.querySelector('#documentPrepare');
    const pagesEl=panel.querySelector('#documentPages'),position=panel.querySelector('#documentPosition');
    const previous=panel.querySelector('#documentPrevious'),next=panel.querySelector('#documentNext');
    let original=null,player=null,preparing=false,unsubscribe=null;
    const paint=()=>{
      const state=player?.state();position.textContent=state?`${state.index+1} / ${state.count}`:'N/A';
      previous.disabled=!state||state.busy||state.index<=0;
      next.disabled=!state||state.busy||state.index>=state.count-1;
    };
    input.onchange=()=>{stopLive();original=null;player=null;preparing=false;prepare.disabled=false;send.disabled=true;pagesEl.replaceChildren();paint();};
    prepare.onclick=async()=>{
      const file=input.files[0];
      if(!file){ setStatus(status,'Choose a PDF or PowerPoint file first.','error'); return; }
      if(preparing)return;
      stopLive();original=null;player=null;send.disabled=true;pagesEl.replaceChildren();paint();
      const epoch=liveEpoch,controller=new AbortController();preparing=true;prepare.disabled=true;
      live={stop(){
        controller.abort();unsubscribe?.();unsubscribe=null;
        const retired=player;player=null;original=null;preparing=false;
        retired?.release();prepare.disabled=false;send.disabled=true;
        pagesEl.replaceChildren();paint();
        setStatus(status,'Presentation closed. Open the original file to resume.');
      }};
      try {
        {
          const opened=await window.OpenLiveDocuments.openPlayer(file,{signal:controller.signal,onProgress:value=>{
            if(epoch!==liveEpoch)return;
            setStatus(status,value.message+(value.percent===null?'':` · ${Math.round(value.percent)}%`),'pending');
          }});
          if(epoch!==liveEpoch||input.files[0]!==file){opened.release();return;}
          player=opened;original=file;player.el.className='olt-content-well';
          player.el.setAttribute('aria-label','Original presentation slide');pagesEl.appendChild(player.el);
          unsubscribe=player.subscribe(paint);paint();
          const warnings=player.unsupported||[];
          setStatus(status,`${file.name} · ${player.count} slides · independent player ready.${warnings.length?' Some deck features are unsupported; review before sending to Show.':''}`,'success');
        }
        send.disabled=false;
      } catch(error){if(epoch===liveEpoch)setStatus(status,error.message||String(error),'error');}
      finally{if(epoch===liveEpoch){preparing=false;prepare.disabled=false;}}
    };
    const step=async delta=>{
      const own=player,epoch=liveEpoch;if(!own||own.state().busy)return;
      try{await own.step(delta);if(player===own&&epoch===liveEpoch)paint();}
      catch(error){if(player===own&&epoch===liveEpoch)setStatus(status,error.message||String(error),'error');}
    };
    previous.onclick=()=>step(-1);next.onclick=()=>step(1);
    send.onclick=()=>{
      if(!original) return;
      if(typeof BroadcastChannel!=='function'){
        setStatus(status,'This browser cannot pass an original file reference between SHOWAVE Encode and SHOWAVE Live.','error'); return;
      }
      const channel=new BroadcastChannel('openlive-documents');
      channel.postMessage({type:'original-document',file:original});
      channel.close();setStatus(status,`${original.name} reference sent to SHOWAVE Live Files. Original content stays unchanged.`,'success');
    };
  }

  function scriptUI(t) {
    panel.innerHTML = `${toolIntro(t, 'Editable text outline')}
      <div class="formrow"><label for="scriptTopic">Topic / offer</label><input id="scriptTopic" type="text"></div>
      <div class="formrow"><label for="scriptAudience">Audience</label><input id="scriptAudience" type="text" placeholder="who should care"></div>
      <div class="formrow"><label for="scriptGoal">Call to action</label><input id="scriptGoal" type="text" placeholder="what should they do next"></div>
      <div class="formrow"><label for="scriptTone">Tone</label><select id="scriptTone"><option>clear</option><option>energetic</option><option>conversational</option><option>direct</option><option>calm</option></select></div>
      <div class="olt-actions"><button class="tb-btn on" id="scriptBuild" type="button">Build script</button><button class="tb-btn" id="scriptCopy" type="button" disabled>Copy</button><button class="tb-btn" id="scriptSave" type="button" disabled>Save .txt</button></div>
      <textarea class="olt-script-output" id="scriptOutput" readonly></textarea>
      <div class="hint olt-status" id="scriptStatus" aria-live="polite" aria-atomic="true"></div>`;
    const output = panel.querySelector('#scriptOutput'), info = panel.querySelector('#scriptStatus');
    const copy = panel.querySelector('#scriptCopy'), save = panel.querySelector('#scriptSave');
    panel.querySelector('#scriptBuild').onclick = () => {
      try {
        output.value = T.generateScript(t.scriptType, {
          topic:panel.querySelector('#scriptTopic').value,
          audience:panel.querySelector('#scriptAudience').value,
          goal:panel.querySelector('#scriptGoal').value,
          tone:panel.querySelector('#scriptTone').value
        });
        copy.disabled = save.disabled = false;
        setStatus(info,'Built locally. Replace every evidence placeholder with verified facts before publishing.','success');
      } catch (error) { setStatus(info,error.message,'error'); }
    };
    copy.onclick = () => {
      const request = navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
        ? navigator.clipboard.writeText(output.value) : Promise.reject(new Error('Clipboard API unavailable'));
      request.then(() => { setStatus(info,'Copied.','success'); })
        .catch(() => { output.focus(); output.select(); setStatus(info,'Select and copy the highlighted script.','pending'); });
    };
    save.onclick = () => T.save(new Blob([output.value], { type:'text/plain;charset=utf-8' }), t.scriptType + '-script.txt')
      .then(() => { setStatus(info,'Script saved.','success'); }).catch(error => { setStatus(info,error.message,'error'); });
  }

  /* ---- file-in / file-out tools ------------------------------------------ */
  function fileUI(t) {
    const isVideoConvert = t.id === 'video-convert';
    panel.innerHTML = `${toolIntro(t)}
      <div class="olt-drop-zone" id="toolDrop" data-dragover="false">
        <div class="olt-drop-inner">
          <input type="file" id="toolFile" accept="${esc(t.accept || '*/*')}">
          ${isVideoConvert ? `<select id="toolContainer"><option value="mp4">MP4 (H.264)</option><option value="webm">WebM (VP9)</option></select>` : ''}
          <button class="tb-btn on" id="toolRun" type="button">Run</button>
        </div>
        <div class="hint olt-drop-hint">…or drop a file here.</div>
      </div>
      <div class="hint olt-status" id="toolStatus" aria-live="polite" aria-atomic="true"></div>`;

    const status = (message, state) => {
      const el = panel.querySelector('#toolStatus');
      setStatus(el,message,state);
    };

    /* Alley's window-level drop handler adds files to the CONVERT queue, which
       from the Tools tab reads as the drop being ignored — it silently switched
       panes. Claim the drop here and stop it before it reaches that handler. */
    const drop = panel.querySelector('#toolDrop');
    let dropped = null;
    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
      event.preventDefault(); event.stopPropagation();
      drop.dataset.dragover = 'true';
    }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => {
      event.preventDefault(); event.stopPropagation();
      drop.dataset.dragover = 'false';
    }));
    drop.addEventListener('drop', event => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      dropped = file;
      status('Ready: ' + file.name + ' (' + (file.size / 1048576).toFixed(2) + ' MB). Press Run.','success');
    });
    panel.querySelector('#toolFile').addEventListener('change', () => { dropped = null; });

    panel.querySelector('#toolRun').onclick = () => {
      const f = panel.querySelector('#toolFile').files[0] || dropped;
      if (!f) { status('Choose or drop a file first.','error'); return; }

      const done = res => T.save(res.blob, res.name)
        .then(where => status(`Done: ${res.name} (${(res.blob.size/1048576).toFixed(2)} MB, ${res.info}) ` +
                              (where === 'disk' ? 'written to disk.' : 'downloaded.'),'success'))
        .catch(e => status(e.message,'error'));
      const fail = e => status(e.message,'error');

      if (t.id === 'audio-extract' || t.id === 'audio-convert') {
        status('Decoding. This holds the whole file in memory, so a long one takes a moment…','pending');
        T.extractAudio(f, s => status(s + '…','pending')).then(done).catch(fail);
        return;
      }
      if (t.id === 'audio-remove') {
        status('Re-encoding without audio. This runs in REAL TIME: a 5 minute clip takes 5 minutes.','pending');
        T.removeAudio(f, p => status(`Re-encoding… ${Math.round(p*100)}%`,'pending')).then(done).catch(fail);
        return;
      }
      if (isVideoConvert) {
        const container = panel.querySelector('#toolContainer').value;
        status('Re-encoding. This runs in REAL TIME and costs a generation of quality; it is not a remux.','pending');
        T.reencodeVideo(f, { container }, p => status(`Re-encoding to ${container.toUpperCase()}… ${Math.round(p*100)}%`,'pending'))
          .then(done).catch(fail);
      }
    };
  }

  /* ---- camera ------------------------------------------------------------ */
  function cameraUI(t) {
    panel.innerHTML = `${toolIntro(t, 'Live camera diagnostic')}
      <div class="olt-panel-note">Shows what the camera actually delivers: resolution and frame rate
        as negotiated, not as requested.</div>
      <div class="olt-media-row">
        <video class="olt-camera-preview olt-content-well" id="camPreview" autoplay playsinline muted></video>
        <div><button class="tb-btn on" id="camStart" type="button">Start</button>
             <button class="tb-btn" id="camStop" type="button">Stop</button>
             <div class="hint olt-status olt-mono-status" id="camInfo" aria-live="polite" aria-atomic="true"></div></div></div>`;
    const info = panel.querySelector('#camInfo'), preview = panel.querySelector('#camPreview');
    panel.querySelector('#camStart').onclick = () => {
      stopLive();
      const request = liveEpoch;
      setStatus(info,'Requesting camera…','pending');
      T.cameraTest().then(stream => {
        if (request !== liveEpoch || !preview.isConnected) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        live = { stop: () => {
          stream.getTracks().forEach(track => track.stop());
          preview.srcObject = null;
        } };
        preview.srcObject = stream;
        const s = stream.getVideoTracks()[0].getSettings();
        setStatus(info,`${s.width}×${s.height} @ ${s.frameRate ? s.frameRate.toFixed(0) : 'N/A'} fps\n${stream.getVideoTracks()[0].label || 'unnamed device'}`,'success');
      }).catch(e => {
        if (request === liveEpoch && info.isConnected) setStatus(info,e.message,'error');
      });
    };
    panel.querySelector('#camStop').onclick = () => { stopLive(); setStatus(info,'Stopped.'); };
  }

  /* ---- microphone -------------------------------------------------------- */
  function micUI(t) {
    panel.innerHTML = `${toolIntro(t, 'Live level and recording check')}
      <div class="olt-panel-note">RMS level in dBFS. A peak meter only moves when you clip, which
        tells you nothing about the failure you are usually testing for: a mic that is too quiet.
        Record a few seconds and play it back: the level meter proves the mic is connected, hearing yourself
        proves it sounds right.</div>
      <button class="tb-btn on" id="micStart" type="button">Start</button>
      <button class="tb-btn" id="micStop" type="button">Stop</button>
      <button class="tb-btn" id="micRec" type="button" disabled>Record</button>
      <div class="olt-meter"><i class="olt-meter-fill" id="micBar"></i></div>
      <div class="hint olt-status olt-mono-status" id="micInfo" aria-live="polite" aria-atomic="true"></div>
      <audio class="olt-playback olt-empty" id="micPlayback" controls></audio>`;
    const bar = panel.querySelector('#micBar'), info = panel.querySelector('#micInfo');
    const rec = panel.querySelector('#micRec'), playback = panel.querySelector('#micPlayback');
    let raf = 0, recorder = null, recUrl = '';
    panel.querySelector('#micStart').onclick = () => {
      stopLive();
      const request = liveEpoch;
      setStatus(info,'Requesting microphone…','pending');
      T.micTest().then(m => {
        if (request !== liveEpoch || !info.isConnected) {
          m.stop();
          return;
        }
        live = { stop: () => {
          cancelAnimationFrame(raf);
          try {
            if (recorder && recorder.state !== 'inactive') {
              recorder.onstop = null;
              recorder.stop();
            }
          } catch (e) {}
          recorder = null; rec.disabled = true; rec.textContent = 'Record';
          if (recUrl) URL.revokeObjectURL(recUrl);
          recUrl = ''; playback.removeAttribute('src'); playback.classList.add('olt-empty');
          m.stop();
        } };
        rec.disabled = !T.has.mediaRecorder;
        rec.title = T.has.mediaRecorder ? '' : 'This browser has no MediaRecorder.';
        rec.onclick = () => {
          if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
          const parts = [];
          try { recorder = new MediaRecorder(m.stream); }
          catch (error) { setStatus(info,'Recording unavailable: ' + error.message,'error'); return; }
          recorder.ondataavailable = event => { if (event.data && event.data.size) parts.push(event.data); };
          recorder.onstop = () => {
            recorder = null; rec.textContent = 'Record';
            if (!parts.length) { setStatus(info,'Nothing was captured.','error'); return; }
            if (recUrl) URL.revokeObjectURL(recUrl);
            recUrl = URL.createObjectURL(new Blob(parts, { type:parts[0].type || 'audio/webm' }));
            playback.src = recUrl; playback.classList.remove('olt-empty'); playback.play().catch(() => {});
          };
          recorder.start(); rec.textContent = 'Stop recording';
        };
        let peak = -Infinity;
        const tick = () => {
          if (request !== liveEpoch) return;
          const l = m.level();
          if (l.db > peak) peak = l.db;
          bar.style.width = Math.max(0, Math.min(100, (l.db + 60) / 60 * 100)) + '%';
          setStatus(info,`${l.db === -Infinity ? 'N/A' : l.db.toFixed(1)} dBFS   peak ${peak === -Infinity ? 'N/A' : peak.toFixed(1)} dBFS`,'success');
          raf = requestAnimationFrame(tick);
        };
        tick();
      }).catch(e => {
        if (request === liveEpoch && info.isConnected) setStatus(info,e.message,'error');
      });
    };
    panel.querySelector('#micStop').onclick = () => { stopLive(); setStatus(info,'Stopped.'); };
  }

  /* The neutral detail state explains readiness before the operator commits to
     a workflow. Blocked cards remain inspectable, so their missing dependency
     is discoverable without pretending the operation can run. */
  panel.innerHTML = `<div class="olt-panel-overview">
    <span class="olt-tool-mark">LAB</span>
    <div class="olt-panel-eyebrow">Capability checked</div>
    <h3 class="olt-panel-title">Choose a tool to begin</h3>
    <div class="olt-panel-note">${usable.length} tools are runnable in this browser. Camera and microphone checks verify hardware only after permission; ${blocked} transcription tools require a file-capable adapter.</div>
    <div class="olt-panel-meta"><b>Privacy</b><span>Runnable tools work locally</span>
      <b>Availability</b><span>${usable.length} runnable · ${blocked} need setup</span>
      <b>Selection</b><span>Use the catalogue or filter by workflow</span></div>
  </div>`;
})();
