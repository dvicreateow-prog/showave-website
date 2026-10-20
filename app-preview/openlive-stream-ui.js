/* ===========================================================================
   openlive-stream-ui.js — the Stream dialog

   DOCS CONSULTED
     streaming.htm   the whole page. Its workflow is Resolume -> NDI/Syphon ->
                     OBS -> platform, and its first sentence is that Resolume
                     cannot stream itself. This dialog is therefore an
                     EXTENSION, and it is laid out to say so: the OBS section
                     comes first among the destinations because it is the one
                     Resolume actually documents, and the WHIP section is
                     labelled as going beyond Arena.
     recording.htm   the Record Panel's shape — Source, Media, preset, Start,
                     Duration. Source here is an Advanced Output screen, which
                     is one of the sources recording.htm itself lists.
     NDI_..._outputs a stream is screen-shaped. The source picker lists real
                     screens from the Advanced Output, never a typed-in id.

   Every number this dialog shows is measured: bitrate is a byte delta across
   two getStats() polls, dropped frames come from the encoder, OBS's figures
   come from OBS. Where a number is not available it prints an em dash, which
   is what the rest of this codebase does with CPU/RAM/VRAM.

   Publishes window.OpenLiveStreamUI. Builds its own overlay so index.html
   needs nothing but the script tag.
   =========================================================================== */
window.OpenLiveStreamUI = (() => {
  'use strict';

  const S = () => window.OpenLiveStream;
  let root = null, els = {}, poll = 0, watch = 0, lastSig = '';
  let obsGeneration = 0, whipGeneration = 0, unsubscribeStreaming = null, airEventBound = false;
  let obsBusy = false, obsConnecting = false, obsConnectController = null, whipStarting = false, recStarting = false;
  const live = { source: null, whip: null, rec: null, obs: null, obsStreaming: false, recBytes: 0 };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dash = v => (v == null || v === '' || Number.isNaN(v)) ? 'N/A' : String(v);

  function streamingState() {
    const st = S();
    if (st && st.streaming && typeof st.streaming.getState === 'function') return st.streaming.getState();
    return { phase: 'off', onAir: false, uncertain: false, connecting: false, whip: false, relay:false, obs: false, sources: [] };
  }

  function paintAirStatus(state) {
    const el = document.getElementById('streamAirStatus');
    if (!el) return;
    state = state || streamingState();
    const sources = Array.isArray(state.sources) ? state.sources : [];
    const phase = state.onAir ? 'live' : state.uncertain ? 'uncertain' : state.connecting ? 'connecting' : 'off';
    const label = phase === 'live' ? 'ON AIR' : phase === 'uncertain' ? 'AIR ?' : 'OFF AIR';
    const sourceText = sources.length ? ' via ' + sources.join(' and ') : '';
    const accessible = phase === 'live' ? 'Streaming status: On Air' + sourceText
      : phase === 'uncertain' ? 'Streaming status uncertain. A previously live output could not be confirmed.'
      : phase === 'connecting' ? 'Streaming status: Off Air. Output setup is connecting.'
      : 'Streaming status: Off Air';
    const title = phase === 'live' ? 'ON AIR' + sourceText + ': confirmed active'
      : phase === 'uncertain' ? 'AIR STATUS UNKNOWN: reconnect streaming controls to confirm the output'
      : phase === 'connecting' ? 'OFF AIR: output setup is still connecting'
      : 'OFF AIR: no confirmed RTMP, WHIP or OBS stream is active';
    if (el.dataset.state !== phase) el.dataset.state = phase;
    el.dataset.live = String(phase === 'live');
    el.setAttribute('aria-label', accessible);
    el.title = title;
    const text = el.querySelector('.stream-air-label');
    if (text && text.textContent !== label) text.textContent = label;
  }

  function initAirStatus() {
    const st = S();
    if (!airEventBound && typeof window.addEventListener === 'function') {
      window.addEventListener('openlive:streaming-state', event => {
        if (event && event.detail) paintAirStatus(event.detail);
      });
      airEventBound = true;
    }
    if (unsubscribeStreaming || !st || !st.streaming || typeof st.streaming.subscribe !== 'function') {
      paintAirStatus();
      return;
    }
    unsubscribeStreaming = st.streaming.subscribe(paintAirStatus);
  }

  /* ---- output api discovery, same rule as openlive-stream.js -------------- */
  function outputApi() {
    if (window.__openliveOutput) return window.__openliveOutput;
    /* Elements, not window.frames — see the note on outputApi() in
       openlive-stream.js. The two must agree or the dialog would offer screens
       the engine then claims are unreachable. */
    try {
      for (const el of document.querySelectorAll('iframe')) {
        let w = null;
        try { w = el.contentWindow; } catch (e) { continue; }
        if (w && w.__openliveOutput) return w.__openliveOutput;
      }
    } catch (e) {}
    return null;
  }

  /* ======================================================================
     MARKUP
     ====================================================================== */
  function build() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'overlay';
    root.id = 'dlgStream';
    root.innerHTML = `
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="olsTitle"
     style="width:min(760px,94vw);max-height:92vh;display:flex;flex-direction:column">
  <div class="fw-title" id="olsTitle">Stream &amp; Record
    <button type="button" class="x" data-ols="close" aria-label="Close">&times;</button></div>
  <div class="fw-body" style="overflow:auto;display:flex;flex-direction:column;gap:14px">

    <div id="olsCaps" class="hint" style="line-height:1.55"></div>

    <div class="hint" style="line-height:1.5">
      <b>Broadcast Studio</b> combines Programme, audio, connected channels and RTMP/RTMPS delivery.
      Use it to prepare, go live and end a complete broadcast.
      <div class="btnrow" style="justify-content:flex-start;margin-top:6px">
        <button type="button" class="btn" data-ols="studio">Open Broadcast Studio</button>
      </div>
      These advanced controls provide direct WHIP and external OBS hand-offs from SHOWAVE Map.
    </div>

    <fieldset style="border:1px solid #2b2b2b;border-radius:4px;padding:10px 12px;margin:0">
      <legend style="padding:0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a">Source</legend>
      <div class="formrow"><label for="olsScreen">Screen</label>
        <select id="olsScreen"></select></div>
      <div class="formrow"><label for="olsFps">Frame rate</label>
        <select id="olsFps"><option>60</option><option selected>30</option><option>25</option><option>24</option></select></div>
      <div id="olsSrcNote" class="hint"></div>
    </fieldset>

    <fieldset style="border:1px solid #2b2b2b;border-radius:4px;padding:10px 12px;margin:0">
      <legend style="padding:0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a">OBS</legend>
      <div class="hint" style="margin-bottom:8px">The workflow <code>streaming.htm</code> actually documents.
        Resolume hands off over NDI; a browser hands off over a Browser Source, which needs no protocol at all.</div>
      <div class="formrow"><label for="olsObsUrl">Browser Source URL</label>
        <input id="olsObsUrl" type="text" readonly></div>
      <div class="btnrow" style="justify-content:flex-start;gap:8px;margin-bottom:10px">
        <button type="button" class="btn" data-ols="copyObs">Copy URL</button>
        <span id="olsCopyNote" class="hint"></span>
      </div>
      <div class="formrow"><label for="olsObsHost">obs-websocket</label>
        <span style="display:flex;gap:6px;flex:1">
          <input id="olsObsHost" type="text" value="localhost" style="flex:2">
          <input id="olsObsPort" type="number" value="4455" style="flex:1">
          <input id="olsObsPass" type="password" placeholder="password (if set)" style="flex:2" autocomplete="off">
        </span></div>
      <div class="btnrow" style="justify-content:flex-start;gap:8px">
        <button type="button" class="btn" data-ols="obsConnect">Connect</button>
        <button type="button" class="btn" data-ols="obsStream" disabled>Start Streaming</button>
        <select id="olsObsScene" disabled style="min-width:150px"></select>
      </div>
      <div id="olsObsNote" class="hint"></div>
    </fieldset>

    <fieldset style="border:1px solid #2b2b2b;border-radius:4px;padding:10px 12px;margin:0">
      <legend style="padding:0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a">WHIP ingest</legend>
      <div class="hint" style="margin-bottom:8px">Beyond Arena: WebRTC straight to the ingest, no OBS.
        This is the one push protocol a browser tab can speak unaided. Several
        WebRTC ingest services accept it and transcode to RTMP for platforms that
        only speak RTMP; take the URL from whichever one you use.</div>
      <div class="formrow"><label for="olsWhipUrl">Ingest URL</label>
        <input id="olsWhipUrl" type="text" placeholder="https://…  the WHIP endpoint from your ingest" autocomplete="off"></div>
      <div class="formrow"><label for="olsWhipToken">Bearer token</label>
        <input id="olsWhipToken" type="password" placeholder="only if your ingest issues one; many put the key in the URL" autocomplete="off"></div>
      <div class="formrow"><label for="olsWhipCodec">Codec</label>
        <select id="olsWhipCodec"></select></div>
      <div class="formrow"><label for="olsWhipRate">Bitrate</label>
        <span style="display:flex;gap:6px;flex:1;align-items:center">
          <input id="olsWhipRate" type="number" min="0.1" max="50" step="0.1" value="4" style="width:90px"><span class="hint">Mbit/s</span></span></div>
      <div class="btnrow" style="justify-content:flex-start;gap:8px">
        <button type="button" class="btn on" data-ols="whipStart">Go Live</button>
        <button type="button" class="btn" data-ols="whipStop" disabled>Stop</button>
      </div>
      <div id="olsWhipNote" class="hint"></div>
      <div id="olsWhipStats" class="hint" style="font-family:ui-monospace,Consolas,monospace"></div>
    </fieldset>

    <fieldset style="border:1px solid #2b2b2b;border-radius:4px;padding:10px 12px;margin:0">
      <legend style="padding:0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a">Record</legend>
      <div class="formrow"><label for="olsRecFmt">Format</label><select id="olsRecFmt"></select></div>
      <div class="formrow"><label for="olsRecRate">Bitrate</label>
        <span style="display:flex;gap:6px;flex:1;align-items:center">
          <input id="olsRecRate" type="number" min="0.25" max="100" step="0.25" value="8" style="width:90px"><span class="hint">Mbit/s</span></span></div>
      <div class="btnrow" style="justify-content:flex-start;gap:8px">
        <button type="button" class="btn" data-ols="recStart">Record</button>
        <button type="button" class="btn" data-ols="recStop" disabled>Stop</button>
      </div>
      <div id="olsRecNote" class="hint"></div>
    </fieldset>
  </div>
  <div class="btnrow"><button type="button" class="btn" data-ols="close">Close</button></div>
</div>`;
    document.body.appendChild(root);

    const $ = id => root.querySelector('#' + id);
    els = {
      caps: $('olsCaps'), screen: $('olsScreen'), fps: $('olsFps'), srcNote: $('olsSrcNote'),
      obsUrl: $('olsObsUrl'), copyNote: $('olsCopyNote'), obsHost: $('olsObsHost'),
      obsPort: $('olsObsPort'), obsPass: $('olsObsPass'), obsScene: $('olsObsScene'), obsNote: $('olsObsNote'),
      whipUrl: $('olsWhipUrl'), whipToken: $('olsWhipToken'), whipCodec: $('olsWhipCodec'),
      whipRate: $('olsWhipRate'), whipNote: $('olsWhipNote'), whipStats: $('olsWhipStats'),
      recFmt: $('olsRecFmt'), recRate: $('olsRecRate'), recNote: $('olsRecNote')
    };
    root.addEventListener('click', onClick);
    root.addEventListener('change', ev => { if (ev.target === els.screen || ev.target === els.fps) rebuildSource(); });
    return root;
  }

  const btn = name => root && root.querySelector('[data-ols="' + name + '"]');

  function onClick(ev) {
    const el = ev.target.closest('[data-ols]');
    if (!el) { if (ev.target === root) close(); return; }
    const act = el.getAttribute('data-ols');
    ({
      close: close,
      copyObs: copyObs,
      obsConnect: obsConnect,
      obsStream: obsStream,
      whipStart: whipStart,
      whipStop: whipStop,
      recStart: recStart,
      recStop: recStop,
      studio: openStudio
    }[act] || (() => {}))();
  }

  function openStudio() {
    if (typeof window.__openliveOpenBroadcast === 'function') {
      window.__openliveOpenBroadcast(); close(); return;
    }
    els.caps.textContent = 'Open Output → SHOWAVE Broadcast to prepare Programme, audio and channels.';
  }

  /* ======================================================================
     CAPABILITY BANNER — the honest header

     This is the first thing in the dialog because it decides which of the
     controls below are worth touching. It is generated from live probes, so it
     cannot drift away from what the engine will actually do.
     ====================================================================== */
  function renderCaps() {
    const st = S();
    if (!st) { els.caps.innerHTML = '<b>openlive-stream.js is not loaded.</b>'; return; }
    const c = st.capabilities();
    const yes = t => '<span style="color:#8fd6a4">' + t + '</span>';
    const no  = t => '<span style="color:#e08a8a">' + t + '</span>';
    const bits = [];
    bits.push(c.whipUsable ? yes('WHIP ready') + ' (' + esc(c.whipCodecs.map(x => x.name).join(', ')) + ')'
                           : no('WHIP unavailable'));
    bits.push(c.recorderFormats.length ? yes('Record ready') + ' (' + c.recorderFormats.length + ' formats)'
                                       : no('No recordable format'));
    bits.push(c.fileSystemAccess ? yes('Writes straight to disk') : 'Falls back to a download');
    bits.push(location.protocol === 'https:' ? no('OBS control blocked over https://') : yes('OBS control reachable'));
    els.caps.innerHTML = bits.join(' · ') +
      '<br><span style="color:var(--n400)">RTMP/RTMPS uses the local helper in Broadcast Studio. ' +
      'SRT, NDI and Spout are not available from these browser controls.</span>';
  }

  /* ======================================================================
     SOURCE
     ====================================================================== */
  /* The Output menu opens the Advanced Output and this dialog in the same
     gesture, so on the first paint the iframe has not mounted and there are
     genuinely no screens yet. Re-reading on a timer is what turns that from a
     wrong answer ("not open") into a transient one, and it also picks up a
     screen that starts rendering, is hidden, or is deleted while the dialog
     sits open. The signature guard means the operator's own selection is only
     disturbed when the underlying list really changed. */
  function watchScreens() {
    if (watch) return;
    watch = setInterval(() => {
      if (!root || !root.classList.contains('show')) return;
      const api = outputApi();
      const list = api && typeof api.screens === 'function' ? api.screens() : [];
      const sig = list.map(s => s.id + ':' + s.rendering + ':' + s.width + 'x' + s.height + ':' + s.visible).join('|');
      if (sig === lastSig) return;
      const keep = els.screen.value;
      refreshScreens();
      if (keep && els.screen.querySelector('option[value="' + CSS.escape(keep) + '"]:not([disabled])')) els.screen.value = keep;
      const st = S();
      if (st) els.obsUrl.value = st.obs.browserSourceUrl(els.screen.value || null, { label: 'OBS' });
    }, 1200);
  }

  function refreshScreens() {
    const api = outputApi();
    const list = api && typeof api.screens === 'function' ? api.screens() : [];
    lastSig = list.map(s => s.id + ':' + s.rendering + ':' + s.width + 'x' + s.height + ':' + s.visible).join('|');
    els.screen.innerHTML = '';
    if (!list.length) {
      els.screen.innerHTML = '<option value="">No screen available</option>';
      els.screen.disabled = true;
      els.srcNote.innerHTML = api
        ? 'SHOWAVE Map is open but has no Screens rendering yet.'
        : '<b>SHOWAVE Map is not open.</b> A stream is a consumer of a Screen, exactly as the ' +
          'projector window is. Open <i>Output &gt; SHOWAVE Map…</i> first. SHOWAVE Live\'s own monitors are ' +
          '320×180 and are deliberately not offered as a source.';
      return;
    }
    els.screen.disabled = false;
    for (const s of list) {
      const o = document.createElement('option');
      o.value = s.id;
      /* A Lumiverse has no raster. Offering it as a capture source was a control
         that could only ever produce nothing, so it is listed with its reason
         and disabled rather than quietly dropped — the operator who went looking
         for it gets an answer instead of an absence. */
      if (s.capturable === false) {
        o.textContent = s.name + ': ' + (s.uncapturableReason || 'cannot be captured');
        o.disabled = true;
        els.screen.appendChild(o);
        continue;
      }
      /* `rendering` is whether the screen is painting RIGHT NOW, which for a
         screen with no projector on it is normally false — attaching a stream
         retains it and starts it. So idle is annotated, not disabled. Hidden is
         the genuine blocker: a hidden screen is excluded from the render set no
         matter who asks for it. */
      o.textContent = s.name + (s.width ? '  ' + s.width + '×' + s.height : '') +
                      (s.visible ? (s.rendering ? '  (live)' : '  (idle)') : '  (hidden)');
      o.disabled = !s.visible;
      els.screen.appendChild(o);
    }
    const usable = list.filter(s => s.capturable !== false);
    const first = usable.find(s => s.visible && s.rendering) || usable.find(s => s.visible);
    if (first) els.screen.value = first.id;
    els.srcNote.textContent = list.length + ' screen' + (list.length === 1 ? '' : 's') +
      ' in SHOWAVE Map. Streaming and recording take the routed, warped, soft-edged frame, the same one the projector gets.';
  }

  /* One source feeds every destination: the encoder cost is paid once whether
     you are streaming, recording, or both. Rebuilding it while something is
     live would cut that thing off, so it is refused rather than done. */
  function rebuildSource() {
    if (live.whip || live.rec || whipStarting || recStarting) {
      els.srcNote.innerHTML = '<b>Source is locked while a stream or recording is running.</b> Stop it to change screen or frame rate.';
      return null;
    }
    if (live.source) { live.source.stop(); live.source = null; }
    return null;
  }

  function ensureSource() {
    if (live.source) return live.source;
    const st = S();
    const id = els.screen.value;
    if (!id) throw new Error('Pick a Screen first. SHOWAVE Map must be open and rendering.');
    /* audio:true asks for the composition master bus. The source reports back
       whether it got it and why not, and the caller prints that reason — the
       operator is never left to infer silence from a flat meter on the
       platform side. */
    live.source = st.sources.fromScreen(id, { fps: Number(els.fps.value) || 30, audio: true });
    return live.source;
  }

  function releaseSource() {
    if (live.whip || live.rec || whipStarting || recStarting) return;
    if (live.source) { live.source.stop(); live.source = null; }
  }

  function startOperation(start) {
    try { return Promise.resolve(start()); }
    catch (error) { return Promise.reject(error); }
  }

  /* ======================================================================
     OBS
     ====================================================================== */
  function copyObs() {
    const url = els.obsUrl.value;
    if (!url) return;
    const done = ok => { els.copyNote.textContent = ok
      ? 'Copied. In OBS: Sources → + → Browser, paste as URL, set the size to your screen.'
      : 'Could not reach the clipboard. Select the field and copy manually.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
    } else { els.obsUrl.select(); done(false); }
  }

  function obsConnect() {
    if (obsConnecting) return;
    const st = S();
    if (live.obs && live.obs._openliveStreaming !== false) {
      els.obsNote.textContent = 'Stop the current OBS stream (or restore a confirmed idle status) before replacing its control connection.';
      return;
    }
    const generation = ++obsGeneration;
    let acceptedClient = null;
    els.obsNote.textContent = 'Connecting…';
    obsConnecting = true;
    btn('obsConnect').disabled = true;
    obsConnectController = typeof AbortController === 'function' ? new AbortController() : null;
    startOperation(() => st.obs.connect({
      host: els.obsHost.value.trim() || 'localhost',
      port: Number(els.obsPort.value) || 4455,
      password: els.obsPass.value,
      eventSubscriptions: 65,
      signal: obsConnectController ? obsConnectController.signal : undefined,
      onEvent: (type, data) => {
        if (!acceptedClient || live.obs !== acceptedClient || type !== 'StreamStateChanged' ||
            !data || typeof data.outputActive !== 'boolean') return;
        live.obsStreaming = data.outputActive;
        btn('obsStream').textContent = data.outputActive ? 'Stop Streaming' : 'Start Streaming';
        els.obsNote.textContent = data.outputActive ? 'OBS is streaming.' : 'OBS is not streaming.';
      },
      onClose: () => {
        if (!acceptedClient || live.obs !== acceptedClient) return;
        live.obs = null;
        live.obsStreaming = false;
        btn('obsStream').disabled = true;
        els.obsScene.disabled = true;
        els.obsNote.textContent = 'OBS control disconnected. Output state is unknown until OBS reconnects.';
      }
    })).then(client => {
      if (generation !== obsGeneration) {
        try { client.close(); } catch (e) {}
        if (st.streaming && typeof st.streaming.forgetObs === 'function') st.streaming.forgetObs(client);
        return Promise.reject(new Error('A newer OBS connection replaced this one.'));
      }
      const previous = live.obs;
      /* OBS may have started externally while the replacement handshake was in
         flight. Re-check before abandoning that authoritative controller. */
      if (previous && previous._openliveStreaming !== false) {
        try { client.close(); } catch (e) {}
        if (st.streaming && typeof st.streaming.forgetObs === 'function') st.streaming.forgetObs(client);
        return Promise.reject(new Error('The current OBS output is no longer confirmed idle, so its control connection was kept.'));
      }
      acceptedClient = client;
      live.obs = client;
      if (previous && previous !== client) {
        try { previous.close(); } catch (e) {}
        /* Closing obs-websocket does not stop OBS. Keep the retired controller
           in the engine registry: a fresh status from the same endpoint will
           supersede it, while a different endpoint must remain AIR ? until the
           operator reconnects to the old OBS and verifies that it is idle. */
      }
      btn('obsStream').disabled = false;
      els.obsNote.textContent = 'Connected to OBS.';
      return Promise.all([
        st.obs.status(client).catch(() => null),
        st.obs.scenes(client)
      ]);
    }).then(([state, res]) => {
      if (!acceptedClient || live.obs !== acceptedClient) return;
      if (state && typeof state.streaming === 'boolean') live.obsStreaming = state.streaming;
      btn('obsStream').textContent = live.obsStreaming ? 'Stop Streaming' : 'Start Streaming';
      els.obsNote.textContent = state && state.streaming === null ? 'Connected to OBS. Stream status is unavailable.'
        : live.obsStreaming ? 'OBS is streaming.' : 'Connected to OBS.';
      els.obsScene.innerHTML = '';
      (res.scenes || []).slice().reverse().forEach(s => {
        const o = document.createElement('option');
        o.value = o.textContent = s.sceneName;
        els.obsScene.appendChild(o);
      });
      if (res.currentProgramSceneName) els.obsScene.value = res.currentProgramSceneName;
      els.obsScene.disabled = false;
      els.obsScene.onchange = () => S().obs.setScene(live.obs, els.obsScene.value)
        .catch(e => { els.obsNote.textContent = e.message; });
    }).catch(err => {
      if (generation === obsGeneration && (!acceptedClient || live.obs === acceptedClient)) {
        els.obsNote.textContent = err.message;
      }
    }).finally(() => {
      obsConnecting = false;
      obsConnectController = null;
      btn('obsConnect').disabled = false;
    });
  }

  function obsStream() {
    if (!live.obs || obsBusy) return;
    const st = S();
    const client = live.obs;
    obsBusy = true; btn('obsStream').disabled = true;
    startOperation(() => st.obs.status(client)).then(s => {
      if (live.obs !== client) throw new Error('OBS disconnected.');
      if (s.streaming == null) throw new Error('OBS stream status is unavailable. Try again after reconnecting.');
      const go = s.streaming ? st.obs.stopStream(client) : st.obs.startStream(client);
      return go.then(() => st.obs.status(client));
    }).then(s => {
      if (live.obs !== client || s.streaming == null) return;
      live.obsStreaming = !!s.streaming;
      btn('obsStream').textContent = s.streaming ? 'Stop Streaming' : 'Start Streaming';
      els.obsNote.textContent = s.streaming
        ? 'OBS is streaming. ' + dash(s.streamTimecode) + ' · dropped ' + dash(s.droppedFrames) + '/' + dash(s.totalFrames)
        : 'OBS is not streaming.';
    }).catch(err => { if (live.obs === client) els.obsNote.textContent = err.message; })
      .finally(() => { obsBusy = false; btn('obsStream').disabled = !live.obs; });
  }

  /* ======================================================================
     WHIP
     ====================================================================== */
  function whipStart() {
    if (live.whip || whipStarting) return;
    const st = S();
    const generation = ++whipGeneration;
    let startedSession = null;
    els.whipNote.textContent = 'Negotiating…';
    let src;
    try { src = ensureSource(); }
    catch (e) { els.whipNote.textContent = e.message; return; }
    whipStarting = true;
    btn('whipStart').disabled = true;

    startOperation(() => st.whip.start({
      url: els.whipUrl.value.trim(),
      token: els.whipToken.value.trim(),
      source: src,
      codec: els.whipCodec.value || undefined,
      bitrate: Math.round((Number(els.whipRate.value) || 4) * 1_000_000),
      onState: (state, err, session) => {
        if (generation !== whipGeneration) {
          /* A cancelled offer can reveal its Location after End timed out. Its
             automatic cleanup still belongs to this visible Retry End row. */
          if (session && live.whip === session && state === 'stopped' && session._stopConfirmed) {
            live.whip = null;
            btn('whipStart').disabled = whipStarting;
            btn('whipStop').disabled = true;
            btn('whipStop').textContent = 'Stop';
            els.whipNote.textContent = 'Stopped.';
            releaseSource();
          }
          return;
        }
        if (session) { startedSession = session; live.whip = session; }
        /* "Live" without qualification would read as a complete stream. If the
           master bus could not be tapped this is a video-only stream and the
           status line says which, every time it says Live. */
        const aud = src.audio && src.audio.included ? ' Audio: Show master bus.'
                  : src.audio ? ' VIDEO ONLY: ' + src.audio.reason : '';
        els.whipNote.textContent = err ? err.message
          : state === 'live' ? 'Live.' + aud
          : state === 'reconnecting' ? 'Connection interrupted; WebRTC is retrying.'
          : state === 'stopped' ? 'Stopped.' : state === 'stopping' ? 'Ending…' : 'Connecting…';
        btn('whipStop').disabled = !live.whip || state === 'stopping';
        btn('whipStop').textContent = state === 'stop-failed' ? 'Retry End' : state === 'connecting' ? 'Cancel' : 'Stop';
        if (state === 'stopped' && startedSession && startedSession._stopConfirmed && live.whip === startedSession) {
          live.whip = null;
          btn('whipStart').disabled = false;
          btn('whipStop').disabled = true;
          els.whipStats.textContent = '';
          releaseSource();
        }
      }
    })).then(session => {
      whipStarting = false;
      if (generation !== whipGeneration) {
        Promise.resolve(session.stop()).catch(() => {});
        if (!live.whip) btn('whipStart').disabled = false;
        releaseSource(); return;
      }
      startedSession = session;
      live.whip = session;
      btn('whipStart').disabled = true;
      btn('whipStop').disabled = false;
      btn('whipStop').textContent = 'Stop';
      startPolling();
    }).catch(err => {
      whipStarting = false;
      if (generation !== whipGeneration) {
        if (!live.whip) btn('whipStart').disabled = false;
        releaseSource(); return;
      }
      if (err.session && !err.session._stopConfirmed) live.whip = err.session;
      else live.whip = null;
      els.whipNote.textContent = err.cleanupError ? err.message + ' ' + err.cleanupError.message : err.message;
      btn('whipStart').disabled = !!live.whip;
      btn('whipStop').disabled = !live.whip;
      btn('whipStop').textContent = live.whip ? 'Retry End' : 'Stop';
      releaseSource();
    });
  }

  function whipStop() {
    if (!live.whip) return;
    if (live.whip._uiStopPending) return;
    ++whipGeneration;
    const s = live.whip;
    s._uiStopPending = true;
    btn('whipStart').disabled = true;
    btn('whipStop').disabled = true;
    els.whipStats.textContent = '';
    els.whipNote.textContent = 'Ending… local transmission is stopped.';
    startOperation(() => S().whip.stop(s)).then(() => {
      if (live.whip !== s) return;
      live.whip = null;
      btn('whipStart').disabled = whipStarting;
      btn('whipStop').disabled = true;
      btn('whipStop').textContent = 'Stop';
      els.whipNote.textContent = 'Stopped.';
      releaseSource();
    }).catch(err => {
      if (live.whip !== s) return;
      els.whipNote.textContent = err.message;
      btn('whipStart').disabled = true;
      btn('whipStop').disabled = false;
      btn('whipStop').textContent = 'Retry End';
    }).finally(() => { s._uiStopPending = false; });
  }

  function startPolling() {
    if (poll) return;
    poll = setInterval(() => {
      if (!live.whip) { if (!live.rec) { clearInterval(poll); poll = 0; } return; }
      S().whip.stats(live.whip).then(s => {
        if (!s) { els.whipStats.textContent = 'no encoder stats yet'; return; }
        const f = live.source ? live.source.stats() : null;
        els.whipStats.textContent =
          dash(s.kbps) + ' kbit/s · ' + dash(s.fps) + ' fps · sent ' + dash(s.framesSent) +
          ' · dropped ' + dash(s.framesDropped) + ' · lost ' + dash(s.packetsLost) +
          ' · rtt ' + dash(s.rttMs) + ' ms' +
          (s.quality && s.quality !== 'none' ? ' · limited by ' + s.quality : '') +
          (s.encoder ? '\n' + s.encoder : '') +
          (f ? '\nsource: ' + f.framesDrawn + ' drawn, ' + f.framesMissed + ' missed' : '');
      });
    }, 1000);
  }

  /* ======================================================================
     RECORD
     ====================================================================== */
  function recStart() {
    if (live.rec || recStarting) return;
    const st = S();
    let src;
    try { src = ensureSource(); }
    catch (e) { els.recNote.textContent = e.message; return; }
    recStarting = true;
    btn('recStart').disabled = true;
    els.recNote.textContent = 'Choose where to save…';
    startOperation(() => st.recorder.start({
      source: src,
      format: els.recFmt.value,
      bitrate: Math.round((Number(els.recRate.value) || 8) * 1_000_000),
      onState: (state, err) => {
        if (state === 'failed') {
          els.recNote.textContent = 'Recording failed: ' + (err && err.message);
          btn('recStop').disabled = false;
        }
        else if (state === 'stopped') {
          els.recNote.textContent = 'Saved ' + live.recName + ': ' +
            (live.recBytes / 1_048_576).toFixed(1) + ' MB' + (live.recTarget === 'download' ? ' (downloaded)' : '');
          live.rec = null;
          btn('recStart').disabled = false;
          btn('recStop').disabled = true;
          releaseSource();
        }
      }
    })).then(session => {
      recStarting = false;
      live.rec = session; live.recName = session.fileName; live.recTarget = session.sink.target;
      btn('recStart').disabled = true;
      btn('recStop').disabled = false;
      /* The format names carry an audio codec ("H.264 High + AAC"), so a
         recording that turned out video-only has to say so at the moment it
         starts — not leave the operator to discover it on playback. */
      const silent = src.audio && !src.audio.included ? '; VIDEO ONLY: ' + src.audio.reason : '';
      els.recNote.textContent = 'Recording to ' + session.fileName + '…' + silent;
      const tick = setInterval(() => {
        if (!live.rec) { clearInterval(tick); return; }
        live.recBytes = session.bytes;
        els.recNote.textContent = 'Recording ' + session.fileName + ': ' +
          ((Date.now() - session.startedAt) / 1000).toFixed(0) + ' s, ' +
          (session.bytes / 1_048_576).toFixed(1) + ' MB' +
          (src.audio && src.audio.included ? ' + audio' : ', video only');
      }, 500);
    }).catch(err => {
      recStarting = false; btn('recStart').disabled = false; btn('recStop').disabled = true;
      els.recNote.textContent = err.message; releaseSource();
    });
  }

  function recStop() { if (live.rec) { live.recBytes = live.rec.bytes; S().recorder.stop(live.rec); } }

  /* ======================================================================
     OPEN / CLOSE
     ====================================================================== */
  function open() {
    build();
    const st = S();
    if (!st) { root.classList.add('show'); return; }
    renderCaps();
    refreshScreens();

    const caps = st.capabilities();
    els.whipCodec.innerHTML = '';
    caps.whipCodecs.filter(c => /^(H264|VP8|VP9|AV1)$/.test(c.name)).forEach(c => {
      const o = document.createElement('option');
      o.value = c.name.toLowerCase(); o.textContent = c.name;
      els.whipCodec.appendChild(o);
    });
    if (els.whipCodec.querySelector('option[value="h264"]')) els.whipCodec.value = 'h264';

    els.recFmt.innerHTML = '';
    caps.recorderFormats.forEach(f => {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.label;
      els.recFmt.appendChild(o);
    });

    const id = els.screen.value;
    els.obsUrl.value = st.obs.browserSourceUrl(id || null, { label: 'OBS' });

    root.classList.add('show');
    watchScreens();
  }

  function close() {
    /* Closing the dialog must not kill a live stream — an operator will close
       this to get back to the deck mid-show. Only the polling stops. */
    if (root) root.classList.remove('show');
    /* A pending control handshake has not taken ownership of an OBS output.
       Cancel only that negotiation; an identified OBS keeps streaming. */
    if (obsConnecting && obsConnectController) obsConnectController.abort();
    if (watch) { clearInterval(watch); watch = 0; }
    if (poll && !live.whip && !live.rec) { clearInterval(poll); poll = 0; }
  }

  initAirStatus();
  return {
    open: open,
    close: close,
    getStreamingState: streamingState,
    isOnAir: () => !!streamingState().onAir,
    /* Safety callers also treat connecting/reconnecting/unknown as active: a
       bandwidth test must not start just because confirmation was interrupted. */
    isStreaming: () => streamingState().phase !== 'off',
    isRecording: () => !!live.rec
  };
})();
