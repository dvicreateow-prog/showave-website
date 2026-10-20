/* ===========================================================================
   openlive-stream.js — live streaming, recording and OBS control

   DOCS CONSULTED
     streaming.htm            the governing page, and it is blunt: "It's not
                              possible to directly stream from Resolume." Arena
                              has no encoder, no stream key, no RTMP. The whole
                              documented workflow is a HANDOFF — enable NDI (or
                              Syphon on Mac) in the Output menu, OBS picks it up
                              as a source, OBS streams. Restream is never named;
                              it is just another RTMP destination behind OBS.
     NDI_inputs_and_outputs   "NDI outputs can also be treated like a separate
                              physical screen... every NDI screen created in the
                              Advanced Output will be a separate NDI Source."
     syphonspout.htm          same screen-shaped model, one machine instead of a
                              network.
     recording.htm            the Record Panel: Source (composition / layer /
                              group / crossfader / an Advanced Output screen),
                              Media (video / audio / both), preset, Start and
                              Duration. "Recording does not interrupt your
                              mixing or the video output."

   THIS MODULE IS AN EXTENSION, NOT PARITY. Arena cannot do what is below. It is
   here because a browser can, and because the thing Arena's handoff exists to
   reach — an encoder that talks to a streaming platform — is one HTTP POST away
   in a page and three installs away on the desktop. It is deliberately shaped
   like Arena's handoff so it lands where an operator already looks: a stream is
   a SCREEN OUTPUT DEVICE, exactly as NDI is, and composition-level sharing sits
   in the Output menu next to the (correctly greyed) Spout and NDI entries.

   WHAT IS REAL HERE, MEASURED RATHER THAN ASSERTED
     WHIP           RTCPeerConnection + one POST of an SDP offer. Real WebRTC
                    ingest. Restream, Cloudflare Stream, Dolby/Millicast,
                    Livepeer, Dacast and Amazon IVS all accept it. Restream then
                    transcodes to RTMP for platforms that need it, which is why
                    no local ffmpeg relay is shipped: it would buy one redundant
                    path at the cost of a second process.
     MediaRecorder  a real file on disk. H.264/MP4 where the browser has it,
                    VP8/VP9/AV1 WebM otherwise. Streamed to disk through the
                    File System Access API so a long record does not sit in RAM.
     obs-websocket  v5 over ws://, which an http:// origin may open. Gives
                    MEASURED bitrate and dropped frames, so the status panel
                    never has to invent a number.

   WHAT IS BLOCKED IN THE TAB, WITH THE CAPABILITY NAMED
     RTMP / RTMPS   raw client TCP socket. window.TCPSocket is undefined; Direct
                    Sockets is gated behind Isolated Web Apps. NOT blocked for
                    OpenLive as a whole — devserver.py holds sockets and is the
                    egress tier. Not implemented there yet; until it is, this
                    says so rather than offering a control that cannot connect.
     SRT            general-purpose UDP datagram socket. window.UDPSocket is
                    undefined today. (The page does send UDP — WebRTC does, at
                    :394 — but only to ICE-validated peers behind DTLS/SRTP, with
                    no seam for an SRT handshake.) Also needs libsrt, which is a
                    code dependency rather than a native one. Same egress tier.
     NDI / Spout    already refused honestly at app.js:1930. Unchanged.

   Publishes window.OpenLiveStream. Classic script, no libraries, no ESM —
   the same contract as every other file here.
   =========================================================================== */
window.OpenLiveStream = (() => {
  'use strict';

  /* ------------------------------------------------------------------------
     STREAMING STATE

     A retained session object is not proof that an output is on air. WHIP can
     be connecting, reconnecting or failed, and an OBS control socket can close
     while OBS itself keeps streaming. Keep one engine-owned registry so every
     surface (the Stream dialog, transport status and safety guards) reads the
     same confirmed state instead of inferring it from its own buttons.
     ---------------------------------------------------------------------- */
  const streamingListeners = new Set();
  const streamingWhipSessions = new Set();
  const streamingRelaySessions = new Set();
  const streamingObsClients = new Set();
  let lastStreamingSignature = '';

  /* One kill switch. The session registries live here, so this belongs here
     rather than in a UI that would otherwise have to keep its own copy of them.
     Returns how many were actually stopped, so a caller can report the real
     number instead of assuming it worked. OBS clients are NOT stopped: this app
     does not own them - OBS pulls from a Browser Source and is stopped in OBS.
     Saying so is the point; silently doing nothing about them would not be. */
  function stopAllStreaming() {
    let stopped = 0;
    Array.from(streamingWhipSessions).forEach(session => {
      try { Promise.resolve(stopWhip(session)).catch(() => {}); stopped++; } catch (e) {}
    });
    Array.from(streamingRelaySessions).forEach(session => {
      try { Promise.resolve(stopRelay(session)).catch(() => {}); stopped++; } catch (e) {}
    });
    return {
      stopped: stopped,
      obsLeftAlone: Array.from(streamingObsClients).filter(c => c && c._openliveConnected).length
    };
  }

  function streamingSnapshot() {
    const whips = Array.from(streamingWhipSessions);
    const relays = Array.from(streamingRelaySessions);
    const obs = Array.from(streamingObsClients);
    const whipLive = whips.filter(session => session && session.state === 'live');
    const relayLive = relays.filter(session => session && session.state === 'live');
    const obsLive = obs.filter(client => client && client._openliveConnected && client._openliveStreaming === true);
    const reconnecting = whips.some(session => session && session.state === 'reconnecting') ||
      relays.some(session => session && session.state === 'reconnecting');
    const connecting = whips.some(session => session && session.state === 'connecting') ||
      relays.some(session => session && session.state === 'connecting');
    const obsUncertain = obs.some(client => client &&
      ((client._openliveConnected && client._openliveStreaming == null) ||
       !client._openliveConnected));
    const whipUncertain = whips.some(session => session &&
      session.state === 'stop-failed' && !session._stopConfirmed);
    const relayUncertain = relays.some(session => session &&
      ((session.state === 'failed' && (session._failureCleanup || session._failureCleanupPending)) ||
       (session.state === 'stop-failed' && !session._stopConfirmed)));
    const sources = [];
    if (whipLive.length) sources.push('WHIP');
    if (relayLive.length) sources.push('RTMP');
    if (obsLive.length) sources.push('OBS');
    const onAir = sources.length > 0;
    const uncertain = !onAir && (reconnecting || obsUncertain || whipUncertain || relayUncertain);
    return Object.freeze({
      phase: onAir ? 'live' : uncertain ? 'uncertain' : connecting ? 'connecting' : 'off',
      onAir: onAir,
      uncertain: uncertain,
      connecting: !onAir && connecting,
      whip: whipLive.length > 0,
      relay: relayLive.length > 0,
      obs: obsLive.length > 0,
      sources: Object.freeze(sources),
      whipSessions: whips.length,
      relaySessions: relays.length,
      obsConnections: obs.filter(client => client && client._openliveConnected).length
    });
  }

  function publishStreamingState(force) {
    const state = streamingSnapshot();
    const signature = [state.phase, state.whip, state.relay, state.obs, state.sources.join(','),
      state.whipSessions, state.relaySessions, state.obsConnections].join('|');
    if (!force && signature === lastStreamingSignature) return state;
    lastStreamingSignature = signature;
    streamingListeners.forEach(listener => { try { listener(state); } catch (e) {} });
    try {
      if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('openlive:streaming-state', { detail: state }));
      }
    } catch (e) {}
    return state;
  }

  function subscribeStreaming(listener) {
    if (typeof listener !== 'function') return () => {};
    streamingListeners.add(listener);
    try { listener(streamingSnapshot()); } catch (e) {}
    return () => streamingListeners.delete(listener);
  }

  function updateObsStreaming(client, active) {
    if (!client || !client._openliveConnected || !streamingObsClients.has(client)) return;
    if (active === true || active === false) {
      client._openliveStreaming = active;
      client._openliveStreamRevision = (client._openliveStreamRevision || 0) + 1;
      /* A fresh status from the same OBS endpoint supersedes a disconnected
         client's last-known value, otherwise reconnecting after OBS stopped
         would leave the transport stuck at AIR ?. */
      streamingObsClients.forEach(previous => {
        if (previous !== client && previous.url === client.url) {
          streamingObsClients.delete(previous);
        }
      });
    }
    publishStreamingState();
  }

  function forgetObsStreaming(client) {
    if (!client) return;
    streamingObsClients.delete(client);
    publishStreamingState();
  }

  /* ------------------------------------------------------------------------
     CAPABILITIES

     Measured, never declared. The rule this codebase holds is that a control
     which cannot do its job says so; that rule is only worth anything if the
     capability report is taken from the engine rather than from a table someone
     wrote once. Codec probes are measured and briefly reused across UI polls;
     context and API availability are checked on every call.
     ---------------------------------------------------------------------- */
  const VIDEO_MIMES = [
    { id: 'h264-mp4',  mime: 'video/mp4;codecs="avc1.640028,mp4a.40.2"', label: 'MP4 · H.264 High + AAC', ext: 'mp4' },
    { id: 'h264-base', mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', label: 'MP4 · H.264 Baseline + AAC', ext: 'mp4' },
    { id: 'vp9-webm',  mime: 'video/webm;codecs="vp9,opus"',             label: 'WebM · VP9 + Opus', ext: 'webm' },
    { id: 'vp8-webm',  mime: 'video/webm;codecs="vp8,opus"',             label: 'WebM · VP8 + Opus', ext: 'webm' },
    { id: 'av1-webm',  mime: 'video/webm;codecs="av01.0.05M.08,opus"',   label: 'WebM · AV1 + Opus', ext: 'webm' }
  ];

  const CODEC_PROBE_TTL_MS = 5000;
  let recorderProbe = null, whipProbe = null;
  function codecProbeCurrent(probe, owner, method, now) {
    return probe && probe.owner === owner && probe.method === method &&
      now >= probe.at && now - probe.at < CODEC_PROBE_TTL_MS;
  }

  function recorderFormats() {
    if (typeof MediaRecorder === 'undefined') return [];
    const now = Date.now(), method = MediaRecorder.isTypeSupported;
    if (!codecProbeCurrent(recorderProbe, MediaRecorder, method, now)) {
      const formats = VIDEO_MIMES.filter(f => {
        try { return method.call(MediaRecorder, f.mime); } catch (e) { return false; }
      });
      recorderProbe = { owner: MediaRecorder, method, at: now, formats };
    }
    return recorderProbe.formats.map(format => Object.assign({}, format));
  }

  /* WHIP negotiates its codec in SDP, so what matters is what the RTP sender can
     actually offer — a different question from what MediaRecorder can mux, and
     one only RTCRtpSender.getCapabilities can answer. */
  function whipCodecs() {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return [];
    const now = Date.now(), method = RTCRtpSender.getCapabilities;
    if (codecProbeCurrent(whipProbe, RTCRtpSender, method, now))
      return whipProbe.codecs.map(codec => Object.assign({}, codec));
    let caps = null;
    try { caps = method.call(RTCRtpSender, 'video'); } catch (e) {}
    const seen = new Set(), out = [];
    for (const c of caps && caps.codecs || []) {
      const name = String(c.mimeType || '').split('/')[1];
      if (!name || seen.has(name.toLowerCase())) continue;
      if (/^(rtx|red|ulpfec|flexfec)/i.test(name)) continue;   // repair formats, not pictures
      seen.add(name.toLowerCase());
      out.push({ name: name.toUpperCase(), mimeType: c.mimeType });
    }
    whipProbe = { owner: RTCRtpSender, method, at: now, codecs: out };
    return out.map(codec => Object.assign({}, codec));
  }

  function capabilities() {
    let secure = true;
    try { secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : true; } catch (e) {}
    const rec = recorderFormats(), whip = whipCodecs();
    /* WHIP ingests in practice accept H.264, VP8 and VP9 for video. If the
       sender cannot offer one of those three the connection will negotiate to
       nothing, and it is far better to say that here than to watch ICE succeed
       and no picture arrive. Named for the codec set, not for any one vendor. */
    const whipNegotiable = whip.some(c => /^(H264|VP8|VP9)$/.test(c.name));
    return {
      secureContext: secure,
      canvasCapture: typeof HTMLCanvasElement !== 'undefined' &&
                     typeof HTMLCanvasElement.prototype.captureStream === 'function',
      webrtc: typeof RTCPeerConnection !== 'undefined',
      whipCodecs: whip,
      whipUsable: secure && typeof RTCPeerConnection !== 'undefined' && whipNegotiable,
      mediaRecorder: typeof MediaRecorder !== 'undefined',
      recorderFormats: rec,
      fileSystemAccess: typeof window.showSaveFilePicker === 'function',
      webSocket: typeof WebSocket !== 'undefined',
      subtleCrypto: !!(window.crypto && window.crypto.subtle),
      /* Named so the UI can print the reason rather than a shrug. */
      blocked: {
        rtmp: 'RTMP needs a raw TCP socket, which this tab does not have. ' +
              'SHOWAVE sends RTMP/RTMPS through its local FFmpeg helper. ' +
              'Open Broadcast Studio to check helper availability and channel readiness.',
        srt:  'SRT needs a UDP socket, which this tab does not have. Same local ' +
              'helper, and it additionally needs libsrt. Not built yet.',
        ndi:  'NDI needs mDNS discovery and raw UDP. Needs the native tier.',
        spout:'Spout/Syphon share a GPU texture handle between processes. No web API exposes one.'
      }
    };
  }

  /* ------------------------------------------------------------------------
     SOURCES

     A stream, like a projector window, is a consumer of an Advanced Output
     screen. openlive-output.html already established the shape at its line 178:
     pull the canvas off the renderer each frame and do exactly one drawImage —
     no ImageBitmap clone, no BroadcastChannel hop, no second compositor.

     The main deck window is deliberately NOT a source. Its three monitors are
     320x180 (app.js:7707) and there is no full-resolution composition surface
     in index.html at all, because the renderer is only loaded on
     advanced-output.html. Capturing a monitor would produce a 320x180 stream
     that looked like it worked.
     ---------------------------------------------------------------------- */

  function outputApi() {
    /* Same-origin, so a direct reference. The deck holds this page in a
       retained iframe; a detached Advanced Output window reaches it via opener. */
    if (window.__openliveOutput) return window.__openliveOutput;
    try { if (window.opener && window.opener.__openliveOutput) return window.opener.__openliveOutput; } catch (e) {}
    /* Iterate the iframe ELEMENTS, not window.frames. window.frames is window
       itself and only behaves as an array-like by virtue of `length`, which
       made it an unreliable lookup — it resolved the Advanced Output in one
       context and returned nothing in another, with the failure swallowed by
       the catch and surfaced as the misleading "Advanced Output is not open".
       contentWindow off a real element has no such ambiguity. */
    try {
      for (const el of document.querySelectorAll('iframe')) {
        let w = null;
        try { w = el.contentWindow; } catch (e) { continue; }
        if (w && w.__openliveOutput) return w.__openliveOutput;
      }
    } catch (e) {}
    return null;
  }

  function describeFrames() {
    const bits = [];
    if (window.__openliveOutput) bits.push('this window exposes __openliveOutput');
    let els = [];
    try { els = Array.from(document.querySelectorAll('iframe')); } catch (e) { return 'the document could not be read'; }
    if (!els.length) return 'no iframes in this document';
    for (const el of els) {
      let state;
      try {
        const w = el.contentWindow;
        state = !w ? 'no contentWindow'
              : w.__openliveOutput ? 'renderer present'
              : ((w.document && w.document.readyState) || 'unknown') + ', no renderer';
      } catch (e) { state = 'unreadable (' + e.name + ')'; }
      bits.push((el.id || el.getAttribute('src') || 'iframe') + ' → ' + state);
    }
    return bits.join('; ');
  }

  /* A source is a live MediaStream plus the honest story of where it came from
     and what it could not include. Nothing here silently substitutes. */
  function fromScreen(screenId, opts) {
    opts = opts || {};
    const api = outputApi();
    if (!api || typeof api.frame !== 'function') {
      /* "Not open" is a diagnosis, and stating one without the evidence sends
         the operator to the wrong place — the window may well be open and still
         not expose the renderer, if it is mid-load or an older build. Report
         what was actually looked at. */
      throw new Error('The SHOWAVE Map renderer could not be reached, so no Screen is being rendered. ' +
                      'A stream is a consumer of a Screen. Open SHOWAVE Map first. ' +
                      'Looked at: ' + describeFrames() + '.');
    }
    /* The renderer paints on DEMAND, and until this call there was none: demand
       used to mean "a projector window is open", so frame() returned null for
       every screen that was merely configured. Retaining registers this stream
       as a consumer, which puts the screen in the render set and ticks once
       synchronously — so a frame exists by the next line rather than a
       frame-time later. Released in stop(); reference counted on the far side,
       so a projector already showing this screen is unaffected either way. */
    let retained = false;
    if (typeof api.retainScreen === 'function') retained = !!api.retainScreen(screenId);

    const probe = api.frame(screenId);
    if (!probe) {
      if (retained && typeof api.releaseScreen === 'function') api.releaseScreen(screenId);
      throw new Error('Screen "' + screenId + '" produced no frame even after being retained for output. ' +
                      (retained ? 'It is probably hidden, or has no slices routed to a source.'
                                : 'This SHOWAVE Map build has no retainScreen(), so a Screen only renders ' +
                                  'while a projector window is open on it. Open one, or update advanced-output.html.'));
    }

    const fps = clamp(num(opts.fps, 30), 1, 60);
    const cv = document.createElement('canvas');
    cv.width  = Math.max(2, num(opts.width,  probe.width)  || probe.width);
    cv.height = Math.max(2, num(opts.height, probe.height) || probe.height);
    const ctx = cv.getContext('2d', { alpha: false, desynchronized: true });

    let raf = 0, stopped = false, drawn = 0, missed = 0;
    let presented = null, contextLost = false;
    const loseContext = () => { contextLost = true; presented = null; };
    const restoreContext = () => { contextLost = false; presented = null; };
    cv.addEventListener?.('contextlost', loseContext);
    cv.addEventListener?.('contextrestored', restoreContext);

    /* Two drivers plus a renderer running at its own rate means frames arrive
       faster than the operator asked for. Without this gate the Frame rate
       control was decorative — measured 45.7 fps with 30 selected. Capture is
       capped here rather than at the encoder so the cost of the copy is not
       paid either. */
    const cadence = captureCadence(fps);

    const paint = () => {
      if (stopped || contextLost) return;
      const nowMs = performance.now();
      if (!cadence.due(nowMs)) return;
      let src = null, stamp = -1;
      try {
        const info = api.frameInfo ? api.frameInfo(screenId) : null;
        if (info && info.canvas) { src = info.canvas; stamp = info.stamp; }
        else src = api.frame(screenId);
      } catch (e) { src = null; }
      if (!src) { missed++; return; }
      /* frameInfo carries a stamp precisely so a consumer can avoid re-encoding
         a frame the renderer has not repainted. Skipping is not dropping: the
         capture track holds the last frame, which is what a held output does. */
      const stamped = Number.isSafeInteger(stamp) && stamp >= 0;
      if (stamped && presented && presented.source === src && presented.stamp === stamp &&
          presented.width === src.width && presented.height === src.height) return;
      try {
        if (src.width === cv.width && src.height === cv.height) ctx.drawImage(src, 0, 0);
        else ctx.drawImage(src, 0, 0, cv.width, cv.height);
        if (track && typeof track.requestFrame === 'function') track.requestFrame();
        drawn++;
        presented = stamped ? {source:src, stamp, width:src.width, height:src.height} : null;
      } catch (e) { presented = null; missed++; }
    };

    /* Driving the track by hand is frame-exact: one captured frame per repaint
       the renderer actually produced, no duplicates and no encoder guessing.
       That needs CanvasCaptureMediaStreamTrack.requestFrame, so probe for it and
       fall back to a timed capture rather than opening a stream that would sit
       on frame zero forever. */
    let stream = cv.captureStream(0);
    let track  = stream.getVideoTracks()[0] || null;
    let driven = !!(track && typeof track.requestFrame === 'function');
    if (!driven) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      stream = cv.captureStream(fps);
      track  = stream.getVideoTracks()[0] || null;
    }

    /* TWO DRIVERS, for the reason advanced-output.html gives at its own tick
       loop: rAF covers the visible case at display rate, and a Worker covers
       the case where this window is hidden, backgrounded or simply not being
       composited — where rAF drops to about once a second and setInterval is
       clamped to 1 Hz. Measured here before this was added: the deck's rAF
       fired ONCE in two seconds while the renderer's stamp advanced 42 times a
       second, so a stream driven by rAF alone sent a single frozen frame.
       Both call the same paint(), which is idempotent: the stamp check means
       whichever driver arrives second does nothing. */
    const rafLoop = () => { if (stopped) return; raf = requestAnimationFrame(rafLoop); paint(); };
    raf = requestAnimationFrame(rafLoop);

    let worker = null, workerUrl = null;
    try {
      workerUrl = URL.createObjectURL(new Blob(
        ['let h=0;onmessage=e=>{clearInterval(h);if(e.data>0)h=setInterval(()=>postMessage(0),e.data);};'],
        { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = paint;
      worker.postMessage(Math.max(4, Math.round(1000 / fps)));
    } catch (e) { worker = null; }

    /* Audio is a separate, explicitly reported branch. arena-media.js taps the
       composition master bus post-fader; when there is no context yet there is
       nothing to tap. A silent audio track would be worse than none: the
       platform would show an audio meter at zero and the operator would debug
       their mixer. Either way `audio.reason` says which happened. */
    const audio = attachAudio(stream, opts.audio);

    return {
      kind: 'screen',
      screenId: screenId,
      stream: stream,
      width: cv.width, height: cv.height, fps: fps,
      audio: audio,
      /* `timerDriven` is reported because it changes what a low frame count
         means: without the Worker, a hidden window explains it; with it, the
         renderer does. */
      stats() { return { framesDrawn: drawn, framesMissed: missed, timerDriven: !!worker, frameExact: driven }; },
      stop() {
        if (stopped) return;                 // releasing twice would blank a screen someone else holds
        stopped = true;
        cv.removeEventListener?.('contextlost', loseContext);
        cv.removeEventListener?.('contextrestored', restoreContext);
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (worker) { try { worker.postMessage(0); worker.terminate(); } catch (e) {} worker = null; }
        if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (e) {} workerUrl = null; }
        stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
        if (retained && typeof api.releaseScreen === 'function') {
          try { api.releaseScreen(screenId); } catch (e) {}
        }
      }
    };
  }

  /* Own an absolute capture phase. Measuring from the previous paint aliases
     24/25 fps to 20 fps on a 60 Hz display and lets two drivers accumulate
     drift. A late callback paints once and skips its missed deadlines; it
     never bursts stale frames to catch up after a busy or hidden window. */
  function captureCadence(fps) {
    const interval = 1000 / fps, epsilon = .5;
    let nextAt = NaN, lastAt = NaN;
    return {
      due(now) {
        if (!Number.isFinite(now)) return false;
        if (!Number.isFinite(nextAt) || now + epsilon < lastAt) nextAt = now;
        lastAt = now;
        if (now + epsilon < nextAt) return false;
        nextAt += (Math.floor((now + epsilon - nextAt) / interval) + 1) * interval;
        return true;
      }
    };
  }

  function fromCanvas(canvas, opts) {
    opts = opts || {};
    if (!canvas || typeof canvas.captureStream !== 'function') {
      throw new Error('fromCanvas needs a canvas that supports captureStream().');
    }
    const fps = clamp(num(opts.fps, 30), 1, 60);
    const width = Math.max(2, Math.round(num(opts.width, canvas.width) || canvas.width));
    const height = Math.max(2, Math.round(num(opts.height, canvas.height) || canvas.height));
    const frameDriven = opts.frameDriven === true;

    /* Capture the compositor directly when its raster is already right.  When
       a broadcast profile asks for another raster, capture a dedicated scaler
       instead: changing the Studio canvas itself would resize the operator's
       programme and every other consumer. */
    if (width === canvas.width && height === canvas.height) {
      let stream = canvas.captureStream(frameDriven ? 0 : fps);
      let track = stream.getVideoTracks()[0] || null;
      const frameExact = frameDriven && !!(track && typeof track.requestFrame === 'function');
      if (frameDriven && !frameExact) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        stream = canvas.captureStream(fps);
        track = stream.getVideoTracks()[0] || null;
      }
      let stopped = false, framesRequested = 0, framesMissed = 0;
      const cadence = captureCadence(fps);
      const audio = attachAudio(stream, opts.audio);
      return {
        kind: 'canvas', screenId: null, stream: stream,
        width: canvas.width, height: canvas.height, fps: fps, audio: audio,
        // The owning compositor calls this only after its complete frame. A
        // separate capture timer can otherwise alias its 30 fps paint cadence.
        requestFrame: frameExact ? now => {
          if (stopped || !cadence.due(Number.isFinite(now) ? now : performance.now())) return false;
          try { track.requestFrame(); framesRequested++; return true; }
          catch (_) { framesMissed++; return false; }
        } : undefined,
        stats() { return { framesDrawn: -1, framesMissed, scaled: false,
                           frameDriven: frameExact, frameExact, framesRequested }; },
        stop() {
          if (stopped) return;
          stopped = true;
          stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
        }
      };
    }

    const output = document.createElement('canvas');
    output.width = width; output.height = height;
    const ctx = output.getContext('2d', { alpha: false, desynchronized: true });
    let stream = output.captureStream(0);
    let track = stream.getVideoTracks()[0] || null;
    const frameExact = !!(track && typeof track.requestFrame === 'function');
    if (!frameExact) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      stream = output.captureStream(fps);
      track = stream.getVideoTracks()[0] || null;
    }
    let stopped = false, raf = 0, worker = null, workerUrl = null;
    let framesDrawn = 0, framesMissed = 0, framesRequested = 0;
    const cadence = captureCadence(fps);
    const paint = now => {
      if (stopped) return false;
      if (!cadence.due(Number.isFinite(now) ? now : performance.now())) return false;
      try {
        ctx.drawImage(canvas, 0, 0, width, height);
        framesDrawn++;
        if (frameExact) { track.requestFrame(); framesRequested++; }
        return true;
      } catch (_) { framesMissed++; return false; }
    };
    const rafLoop = () => { if (stopped) return; raf = requestAnimationFrame(rafLoop); paint(); };
    if (!frameDriven) {
      raf = requestAnimationFrame(rafLoop);
      try {
        workerUrl = URL.createObjectURL(new Blob(
          ['let h=0;onmessage=e=>{clearInterval(h);if(e.data>0)h=setInterval(()=>postMessage(0),e.data);};'],
          { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        worker.onmessage = paint;
        worker.postMessage(Math.max(4, Math.round(1000 / fps)));
      } catch (_) { worker = null; }
    }
    const audio = attachAudio(stream, opts.audio);
    return {
      kind: 'canvas', screenId: null, stream: stream,
      width: width, height: height, fps: fps, audio: audio,
      requestFrame: frameDriven ? paint : undefined,
      stats() { return { framesDrawn, framesMissed, timerDriven: !!worker,
                         frameExact, frameDriven, framesRequested, scaled: true }; },
      stop() {
        if (stopped) return;
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        if (worker) { try { worker.postMessage(0); worker.terminate(); } catch (_) {} }
        if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) {} }
        stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      }
    };
  }

  /* Returns {included, reason} — never a silent outcome either way. */
  function attachAudio(stream, request) {
    if (!request) return { included: false, reason: 'Audio was not requested; this is a video-only stream.' };
    const A = window.OpenLiveAudio;
    // The shared engine may live in the Show window while Studio owns the
    // mixer. A native MediaStream from another same-origin window fails this
    // realm's instanceof check; falling through would tap the wrong audio bus.
    if (request instanceof MediaStream ||
        typeof request.getAudioTracks === 'function' && typeof request.getTracks === 'function' &&
        typeof request.getVideoTracks === 'function') {
      const t = request.getAudioTracks();
      if (!t.length) return { included: false, reason: 'The supplied MediaStream carries no audio track.' };
      t.forEach(track => stream.addTrack(track));
      window.OpenLiveAudioOutput?.inheritMasterDelay(stream,request);
      return { included: true, reason: 'Audio supplied by the caller.' };
    }
    /* arena-media.js owns the composition's one AudioContext and its master bus,
       and is loaded on index.html. openlive-audio.js is the Preferences-only
       device/meter module and is NOT loaded here — an earlier version of this
       function named it as the owner, which sent anyone debugging a silent
       stream to a file the page never loads. Try the real owner first, keep the
       other as a fallback for surfaces that do load it. */
    const owners = [window.ArenaMedia, A];
    for (const owner of owners) {
      if (!owner || typeof owner.streamDestination !== 'function') continue;
      try {
        const dest = owner.streamDestination();
        if (dest && dest.stream && dest.stream.getAudioTracks().length) {
          const live=dest.stream.getAudioTracks().filter(track=>track.readyState !== 'ended');
          if(!live.length)return {included:false,reason:'The Show audio bus offers no live audio track. This capture is video-only.'};
          // The persistent Show bus belongs to ArenaMedia. Each screen/canvas
          // capture owns clones so closing a source cannot end another capture
          // or make the next Go Live silently reuse an ended master track.
          const owned=[];
          try {
            for(const track of live){const clone=track.clone();owned.push(clone);stream.addTrack(clone);}
          } catch(error) {
            for(const track of owned){try{stream.removeTrack?.(track);}catch(_){}try{track.stop();}catch(_){}}
            return {included:false,reason:'The Show audio bus could not be cloned: '+String(error?.message || error)+'. This capture is video-only.'};
          }
          window.OpenLiveAudioOutput?.inheritMasterDelay(stream,dest.stream);
          return { included: true, reason: 'Tapped from the Show master bus, post-fader.' };
        }
      } catch (e) {}
    }
    return {
      included: false,
      reason: 'The Show has no AudioContext yet. WebAudio starts on the first ' +
              'user gesture, and nothing with audio has played. Trigger a clip that has ' +
              'audio, then start the stream. Streaming video-only rather than sending a ' +
              'silent track and calling it audio.'
    };
  }

  /* ------------------------------------------------------------------------
     WHIP — WebRTC-HTTP Ingestion Protocol (RFC 9725)

     The whole protocol: POST an SDP offer as text/sdp, receive 201 Created with
     the answer in the body and a Location header naming the session resource,
     DELETE that resource to stop. Everything else is ordinary WebRTC.
     ---------------------------------------------------------------------- */
  function startWhip(cfg) {
    cfg = cfg || {};
    const caps = capabilities();
    if (!caps.webrtc)  return Promise.reject(new Error('This browser has no RTCPeerConnection.'));
    if (!caps.secureContext) {
      return Promise.reject(new Error('WebRTC ingest needs a secure context. Serve the app over https:// ' +
                                      'or from http://localhost.'));
    }
    const url = String(cfg.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return Promise.reject(new Error('Enter the WHIP ingest URL from your streaming platform ' +
                                      '(Restream: the Stream URL on the WHIP tab). It must be http(s).'));
    }
    try {
      const endpoint = new URL(url);
      if (endpoint.username || endpoint.password) throw new Error('URL credentials');
    } catch (e) {
      return Promise.reject(new Error('Enter a valid WHIP HTTP(S) URL without username/password credentials. Use the bearer token field for authentication.'));
    }
    const source = cfg.source;
    if (!source || !source.stream) return Promise.reject(new Error('startWhip needs a source from fromScreen()/fromCanvas().'));

    const pc = new RTCPeerConnection({
      iceServers: cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      bundlePolicy: 'max-bundle'
    });

    const senders = [];
    for (const track of source.stream.getVideoTracks()) {
      senders.push(pc.addTransceiver(track, {
        direction: 'sendonly',
        sendEncodings: [{ maxBitrate: clamp(num(cfg.bitrate, 4_000_000), 100_000, 50_000_000) }]
      }));
    }
    for (const track of source.stream.getAudioTracks()) {
      senders.push(pc.addTransceiver(track, { direction: 'sendonly' }));
    }
    if (!senders.length) { pc.close(); return Promise.reject(new Error('The source carries no tracks.')); }

    /* Codec preference is a request, not a guarantee — the answer decides. It is
       still worth stating, because a server that supports both will otherwise
       pick by its own order and an operator who chose H.264 deserves H.264. */
    if (cfg.codec) preferCodec(senders[0], String(cfg.codec));

    const session = {
      kind: 'whip', pc: pc, source: source, url: url, resource: null,
      state: 'connecting', error: null,
      startedAt: null, _lastBytes: 0, _lastAt: 0,
      _cancelled: false, _offerSent: false, _offerSettled: false,
      _offerRejected: false, _stopConfirmed: false, stopComplete: false,
      _authorization: cfg.token ? 'Bearer ' + String(cfg.token).trim() : null,
      _stopTimeoutMs: clamp(num(cfg.stopTimeoutMs, 3000), 250, 15000),
      onState: typeof cfg.onState === 'function' ? cfg.onState : null
    };
    const setState = (s, err) => {
      if (session.state === s && !err && !session.error) return;
      session.state = s;
      session.error = err || null;
      if (s === 'stopped' && session._stopConfirmed) streamingWhipSessions.delete(session);
      else streamingWhipSessions.add(session);
      publishStreamingState();
      if (session.onState) { try { session.onState(s, err || null, session); } catch (e) {} }
    };
    session._setState = setState;
    session.stop = () => stopWhip(session);
    pc.addEventListener('connectionstatechange', () => {
      if (session._cancelled) return;
      const s = pc.connectionState;
      if (s === 'connected' && session.state !== 'live') { session.startedAt = Date.now(); setState('live'); }
      else if (s === 'failed') {
        setState('failed', new Error('The peer connection failed. Usually a firewall or a NAT that needs a TURN server.'));
        stopWhip(session).catch(() => {});
      }
      else if (s === 'disconnected') setState('reconnecting');
      else if (s === 'closed') stopWhip(session).catch(() => {});
    });

    const cancelledError = () => new Error('WHIP setup was cancelled.');
    const assertActive = () => {
      if (session._cancelled || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        throw session.error || cancelledError();
      }
    };
    let cancelStartup;
    const cancellation = new Promise((resolve, reject) => { cancelStartup = reject; });
    session._cancelStartup = () => cancelStartup(session.error || cancelledError());
    const handshake = Promise.resolve().then(() => { assertActive(); return pc.createOffer(); })
      .then(offer => pc.setLocalDescription(offer))
      .then(() => iceSettled(pc, num(cfg.iceTimeoutMs, 4000)))
      .then(() => {
        assertActive();
        const headers = { 'Content-Type': 'application/sdp' };
        /* Restream's own instructions say to leave the bearer token empty
           because the key is already inside the Stream URL. Other platforms
           (Cloudflare, Dolby) do use one. Send it only when given. */
        if (session._authorization) headers['Authorization'] = session._authorization;
        session._offerSent = true;
        /* Do not abort an allocating POST: a late Location is our only proof
           of which remote resource belongs to this attempt. Retain the reply
           independently of the startup deadline and cancel its exact resource. */
        session._offerResponsePromise = Promise.resolve().then(() => fetch(url, {
          method: 'POST', headers: headers, body: pc.localDescription.sdp, mode: 'cors'
        })).then(res => {
          session._offerSettled = true;
          if (!res.ok) {
            session._offerRejected = true;
            throw new Error('WHIP ingest refused: HTTP ' + res.status + '.');
          }
          const loc = res.headers && res.headers.get('Location');
          if (loc) {
            try {
              const resource = new URL(loc, res.url || url);
              if (/^https?:$/.test(resource.protocol) && !resource.username && !resource.password) session.resource = resource.href;
            } catch (e) {}
          }
          if (session._cancelled) stopWhip(session).catch(() => {});
          if (!session.resource) {
            throw new Error('WHIP returned no readable session Location. The provider must expose Location to this origin so End can release the session.');
          }
          return res;
        }).catch(err => {
          session._offerSettled = true;
          if (session._cancelled && session._offerRejected) stopWhip(session).catch(() => {});
          throw err;
        });
        return session._offerResponsePromise;
      }).then(res => {
        assertActive();
        return res.text();
      })
      .then(answer => {
        assertActive();
        if (!answer || !/^v=0/m.test(answer)) throw new Error('The platform returned no SDP answer.');
        return pc.setRemoteDescription({ type: 'answer', sdp: answer });
      })
      .then(() => {
        /* A terminal connectionstatechange can arrive while the SDP promise is
           still settling. Never resurrect that dead peer as "connecting". */
        if (session._cancelled || session.state === 'failed' || pc.connectionState === 'failed') {
          throw session.error || new Error('The peer connection failed before going live.');
        }
        if (session.state === 'stopped' || pc.connectionState === 'closed') {
          throw new Error('The peer connection closed before going live.');
        }
        setState(pc.connectionState === 'connected' ? 'live'
          : pc.connectionState === 'disconnected' ? 'reconnecting' : 'connecting');
        return session;
      });
    const startup = relayDeadline(Promise.race([handshake, cancellation]),
      clamp(num(cfg.startTimeoutMs, 15000), 250, 30000), 'WHIP setup timed out. End this attempt before retrying.')
      .catch(async err => {
        session._cancelled = true;
        try { pc.close(); } catch (e) {}
        if (!session._stopConfirmed && session.state !== 'stop-failed' && session.state !== 'stopping') setState('failed', err);
        try { await stopWhip(session); } catch (cleanupError) { err.cleanupError = cleanupError; }
        err.session = session;
        throw err;
      }).finally(() => { session._cancelStartup = null; });
    /* The owner is delivered before asynchronous SDP work, so Cancel can close
       this peer even when its first offer or network reply has not settled. */
    streamingWhipSessions.add(session);
    publishStreamingState();
    if (session.onState) { try { session.onState('connecting', null, session); } catch (e) {} }
    return startup;
  }

  /* Real numbers off getStats(), or nothing. bitrate is a delta between calls,
     so the first call reports null rather than a fabricated zero. */
  function whipStats(session) {
    if (!session || !session.pc) return Promise.resolve(null);
    return session.pc.getStats().then(report => {
      let out = null, remote = null, cand = null;
      report.forEach(s => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
        else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remote = s;
        else if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) cand = s;
      });
      if (!out) return null;
      const now = num(out.timestamp, 0), bytes = num(out.bytesSent, 0);
      let kbps = null;
      if (session._lastAt && now > session._lastAt) {
        kbps = Math.round(((bytes - session._lastBytes) * 8) / ((now - session._lastAt) / 1000) / 1000);
      }
      session._lastBytes = bytes; session._lastAt = now;
      return {
        kbps: kbps,
        fps: out.framesPerSecond != null ? Math.round(out.framesPerSecond) : null,
        framesSent: num(out.framesSent, null),
        framesDropped: num(out.framesDropped, null),
        packetsLost: remote ? num(remote.packetsLost, null) : null,
        jitter: remote && remote.jitter != null ? +(remote.jitter * 1000).toFixed(1) : null,
        rttMs: remote && remote.roundTripTime != null ? Math.round(remote.roundTripTime * 1000)
             : cand && cand.currentRoundTripTime != null ? Math.round(cand.currentRoundTripTime * 1000) : null,
        encoder: out.encoderImplementation || null,
        quality: out.qualityLimitationReason || null,
        state: session.state
      };
    }).catch(() => null);
  }

  function stopWhip(session) {
    if (!session) return Promise.resolve();
    if (session._stopConfirmed) return Promise.resolve(session);
    if (session._stopPromise) return session._stopPromise;
    session._cancelled = true;
    if (session._cancelStartup) session._cancelStartup();
    /* Stop local transmission first. A slow or unreachable WHIP DELETE must not
       leave packets flowing while every OpenLive surface already says OFF AIR. */
    try { session.pc.close(); } catch (e) {}
    session._setState('stopping');
    const work = Promise.resolve().then(async () => {
      if (!session.resource && session._offerSent && !session._offerSettled) {
        await relayDeadline(session._offerResponsePromise.catch(() => null), session._stopTimeoutMs,
          'WHIP offer reply is still pending. Local transmission is stopped; remote cleanup is not confirmed. Retry End.');
      }
      const resource = session.resource;
      if (!resource && session._offerSent && !session._offerRejected) {
        throw new Error('The WHIP offer reply did not identify its session. Local transmission is stopped; remote cleanup cannot be verified. Check the provider before retrying.');
      }
      if (resource) {
        let controller = null;
        try { if (typeof AbortController === 'function') controller = new AbortController(); } catch (e) {}
        const headers = {};
        if (session._authorization) headers.Authorization = session._authorization;
        const response = await relayDeadline(Promise.resolve().then(() => fetch(resource, {
          method: 'DELETE', mode: 'cors', headers: headers,
          ...(controller ? { signal: controller.signal } : {})
        })), session._stopTimeoutMs, 'WHIP End timed out. Local transmission is stopped; retry End to release the remote session.',
        () => { if (controller) controller.abort(); });
        if (!response || (!response.ok && response.status !== 404 && response.status !== 410)) {
          throw new Error('WHIP End was not confirmed' + (response ? ' (HTTP ' + response.status + ')' : '') + '. Retry End.');
        }
      }
      session.resource = null;
      session._stopConfirmed = true;
      session.stopComplete = true;
      session._authorization = null;
      session._setState('stopped');
      return session;
    });
    session._stopPromise = work.catch(err => {
      err.session = session;
      session.stopComplete = false;
      session._setState('stop-failed', err);
      throw err;
    }).finally(() => { session._stopPromise = null; });
    return session._stopPromise;
  }

  function preferCodec(transceiver, wanted) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return false;
    let caps = null;
    try { caps = RTCRtpSender.getCapabilities('video'); } catch (e) { return false; }
    if (!caps) return false;
    const want = wanted.toLowerCase();
    const hit  = caps.codecs.filter(c => String(c.mimeType).toLowerCase().endsWith('/' + want));
    if (!hit.length) return false;
    const rest = caps.codecs.filter(c => !String(c.mimeType).toLowerCase().endsWith('/' + want));
    try { transceiver.setCodecPreferences(hit.concat(rest)); return true; } catch (e) { return false; }
  }

  /* Non-trickle: gather, then POST once. WHIP servers accept trickle over PATCH
     but not all implement it, and a single POST is the interoperable path. The
     timeout exists because a host behind a stubborn network can gather for a
     long time, and half the candidates connect fine. */
  function iceSettled(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, Math.max(500, timeoutMs));
      pc.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  /* ------------------------------------------------------------------------
     RECORDER

     recording.htm: the recorder writes a file and "does not interrupt your
     mixing or the video output". MediaRecorder satisfies both. What it cannot
     satisfy is the default preset — Quicktime with DXV3 — because DXV has no
     encoder outside Arena. That stays refused; it does not get quietly swapped
     for H.264 while the preset menu still says DXV.

     Chunks go straight to disk through a FileSystemWritableFileStream. A 4K
     show recorded to a Blob array would be several GB of tab memory.
     ---------------------------------------------------------------------- */
  function startRecording(cfg) {
    try { window.OpenLiveSessionPolicy?.assertCanWrite('Recording'); }
    catch (error) { return Promise.reject(error); }
    cfg = cfg || {};
    const caps = capabilities();
    if (!caps.mediaRecorder) return Promise.reject(new Error('This browser has no MediaRecorder.'));
    const source = cfg.source;
    if (!source || !source.stream) return Promise.reject(new Error('startRecording needs a source from fromScreen()/fromCanvas().'));

    const formats = caps.recorderFormats;
    if (!formats.length) return Promise.reject(new Error('MediaRecorder supports none of the muxes this app offers.'));
    const fmt = formats.find(f => f.id === cfg.format) || formats[0];

    const name = (cfg.fileName || defaultRecordingName()) + '.' + fmt.ext;
    const bits = clamp(num(cfg.bitrate, 8_000_000), 250_000, 100_000_000);

    return openWritable(name, fmt, cfg).then(sink => {
      const rec = new MediaRecorder(source.stream, {
        mimeType: fmt.mime,
        videoBitsPerSecond: bits,
        audioBitsPerSecond: clamp(num(cfg.audioBitrate, 160_000), 32_000, 512_000)
      });
      const session = {
        recorder: rec, source: source, format: fmt, fileName: name,
        state: 'recording', startedAt: Date.now(), bytes: 0, error: null,
        sink: sink,
        onState: typeof cfg.onState === 'function' ? cfg.onState : null
      };
      let resolveDone;
      session.done = new Promise(resolve => { resolveDone = resolve; });
      const emit = (s, e) => { session.state = s; session.error = e || null;
        if (session.onState) { try { session.onState(s, e || null); } catch (err) {} } };

      /* Writes are serialised: FileSystemWritableFileStream.write() must not be
         re-entered, and dataavailable can fire faster than the disk drains. */
      let chain = Promise.resolve();
      rec.ondataavailable = ev => {
        if (!ev.data || !ev.data.size) return;
        session.bytes += ev.data.size;
        chain = chain.then(() => sink.write(ev.data)).catch(err => { emit('failed', err); });
      };
      rec.onerror = ev => emit('failed', (ev && ev.error) || new Error('MediaRecorder failed.'));
      rec.onstop = () => {
        chain = chain.then(() => sink.close()).then(() => emit('stopped'))
          .catch(err => emit('failed', err)).finally(() => resolveDone(session));
      };

      rec.start(1000);   // one chunk a second: bounded memory, bounded loss on a crash
      emit('recording');

      if (cfg.durationMs > 0) setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} }, cfg.durationMs);
      return session;
    });
  }

  function stopRecording(session) {
    if (!session || !session.recorder) return Promise.resolve(session || null);
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch (e) {}
    return session.done || Promise.resolve(session);
  }

  /* Two sinks with the same interface. The picker is the good one — a real file,
     chosen by the user, written as it arrives. The fallback accumulates and
     downloads, which is what a browser without the File System Access API can
     honestly offer. */
  function openWritable(name, fmt, cfg) {
    try { window.OpenLiveSessionPolicy?.assertCanWrite('Recording'); }
    catch (error) { return Promise.reject(error); }
    if (cfg && cfg.forceDownload) return Promise.resolve(blobSink(name));
    if (typeof window.showSaveFilePicker !== 'function') return Promise.resolve(blobSink(name));
    return window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: fmt.label, accept: { [fmt.mime.split(';')[0]]: ['.' + fmt.ext] } }]
    }).then(handle => handle.createWritable()).then(w => ({
      target: 'disk',
      write: chunk => w.write(chunk),
      close: () => w.close()
    })).catch(err => {
      if (err && err.name === 'AbortError') throw new Error('Recording cancelled; no file was chosen.');
      return blobSink(name);
    });
  }

  function blobSink(name) {
    const parts = [];
    return {
      target: 'download',
      write: chunk => { parts.push(chunk); return Promise.resolve(); },
      close: () => {
        const url = URL.createObjectURL(new Blob(parts));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return Promise.resolve();
      }
    };
  }

  function defaultRecordingName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return 'SHOWAVE-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* ------------------------------------------------------------------------
     LIVE CLIPPING

     One bounded MediaRecorder retains the most recent clusters in memory. The
     first WebM chunk is kept because it owns the container header; old media
     chunks roll out by time and by a hard byte ceiling. Saving a clip creates
     a browser download and leaves the rolling recorder armed.
     ---------------------------------------------------------------------- */
  function startClipBuffer(cfg) {
    cfg = cfg || {};
    const caps = capabilities();
    if (!caps.mediaRecorder) return Promise.reject(new Error('This browser has no MediaRecorder.'));
    const source = cfg.source;
    if (!source || !source.stream) return Promise.reject(new Error('Live clipping needs a programme source.'));
    const fmt = caps.recorderFormats.find(f => /webm/i.test(f.mime)) || caps.recorderFormats[0];
    if (!fmt) return Promise.reject(new Error('This browser has no recordable format for live clipping.'));
    const seconds = clamp(num(cfg.seconds, 30), 5, 300);
    const maxBytes = clamp(num(cfg.maxBytes, 256 << 20), 8 << 20, 512 << 20);
    const rec = new MediaRecorder(source.stream, {
      mimeType: fmt.mime,
      videoBitsPerSecond: clamp(num(cfg.bitrate, 6_000_000), 250_000, 100_000_000),
      audioBitsPerSecond: clamp(num(cfg.audioBitrate, 160_000), 32_000, 512_000)
    });
    const session = {
      recorder: rec, source, format: fmt, seconds, maxBytes,
      state: 'recording', startedAt: Date.now(), header: null, chunks: [], bytes: 0,
      onState: typeof cfg.onState === 'function' ? cfg.onState : null
    };
    const emit = (state, error) => {
      session.state = state; session.error = error || null;
      if (session.onState) { try { session.onState(state, error || null); } catch (_) {} }
    };
    rec.ondataavailable = ev => {
      if (!ev.data || !ev.data.size) return;
      const at = Date.now();
      if (!session.header) session.header = ev.data;
      else session.chunks.push({ at, blob: ev.data });
      session.bytes += ev.data.size;
      const cutoff = at - seconds * 1000;
      while (session.chunks.length &&
             (session.chunks[0].at < cutoff || session.bytes > maxBytes)) {
        session.bytes -= session.chunks.shift().blob.size;
      }
    };
    rec.onerror = ev => emit('failed', (ev && ev.error) || new Error('Live clipping failed.'));
    rec.onstop = () => emit('stopped');
    rec.start(1000);
    emit('recording');
    return Promise.resolve(session);
  }

  async function saveClipBuffer(session, cfg) {
    window.OpenLiveSessionPolicy?.assertCanWrite('Saving a clip');
    cfg = cfg || {};
    if (!session || !session.recorder || session.state === 'failed')
      throw new Error('Live clipping is not active.');
    if (session.recorder.state === 'recording') {
      try { session.recorder.requestData(); } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const parts = [];
    if (session.header) parts.push(session.header);
    session.chunks.forEach(row => parts.push(row.blob));
    if (!parts.length) throw new Error('The rolling buffer has not received a media chunk yet.');
    const blob = new Blob(parts, { type: session.format.mime });
    const name = String(cfg.fileName || defaultRecordingName() + '-clip') + '.' + session.format.ext;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return {
      fileName: name, bytes: blob.size,
      durationSeconds: Math.min(session.seconds,
        Math.max(1, Math.round((Date.now() - session.startedAt) / 1000)))
    };
  }

  function stopClipBuffer(session) {
    if (!session || !session.recorder) return;
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch (_) {}
  }

  /* ------------------------------------------------------------------------
     OBS — obs-websocket v5

     streaming.htm's actual prescription is "get Resolume into OBS, let OBS
     stream". The NDI half of that is blocked here, but the other half is not:
     OBS's Browser Source will happily load an output page from this dev server,
     and obs-websocket lets the deck drive OBS from inside the app.

     ws:// from an http:// origin is allowed; it is only https:// pages that are
     blocked from ws://. This app is served over http://localhost, so this works
     — and stops working the moment the app is served over TLS, which is worth
     saying out loud rather than discovering during a show.
     ---------------------------------------------------------------------- */
  function connectObs(cfg) {
    cfg = cfg || {};
    if (cfg.signal && cfg.signal.aborted) return Promise.reject(new Error('OBS connection was cancelled.'));
    const host = cfg.host || 'localhost', port = num(cfg.port, 4455);
    const url = cfg.url || ('ws://' + host + ':' + port);
    if (typeof WebSocket === 'undefined') return Promise.reject(new Error('This browser has no WebSocket.'));
    if (location.protocol === 'https:' && url.startsWith('ws://')) {
      return Promise.reject(new Error('This page is served over https://, and a secure page may not open an ' +
                                      'insecure ws:// socket. Serve the app over http://localhost to control OBS, ' +
                                      'or put a wss:// proxy in front of obs-websocket.'));
    }

    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      const pending = new Map();
      let reqId = 0, settled = false, disconnectPublished = false, handshakeTimer = 0, abortHandshake = null;
      const finishHandshake = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = 0;
        if (abortHandshake && cfg.signal) cfg.signal.removeEventListener('abort', abortHandshake);
        abortHandshake = null;
      };
      const client = {
        ws: ws, url: url, identified: false,
        _openliveConnected: false, _openliveStreaming: null, _openliveStreamRevision: 0,
        onEvent: typeof cfg.onEvent === 'function' ? cfg.onEvent : null,
        onClose: typeof cfg.onClose === 'function' ? cfg.onClose : null,
        request: (type, data) => new Promise((res, rej) => {
          if (ws.readyState !== 1 || !client.identified || !client._openliveConnected) { rej(new Error('OBS socket is not connected.')); return; }
          const id = 'ol-' + (++reqId);
          const timer = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error('OBS did not answer ' + type + '.')); }
          }, clamp(num(cfg.requestTimeoutMs, 10000), 250, 30000));
          pending.set(id, { res, rej, timer });
          try { ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } })); }
          catch (err) { pending.delete(id); clearTimeout(timer); rej(err); }
        }),
        close: () => {
          /* WebSocket.close() is asynchronous. Stop treating this controller
             as authoritative before the close event so the transport can
             never flash a false OFF AIR during an OBS handoff. */
          markDisconnected();
          try { ws.close(); } catch (e) {}
        }
      };

      function markDisconnected() {
        if (disconnectPublished) return;
        disconnectPublished = true;
        client.identified = false;
        const wasConnected = client._openliveConnected;
        client._openliveConnected = false;
        if (wasConnected) client._openliveStreamRevision++;
        pending.forEach(request => {
          clearTimeout(request.timer);
          request.rej(new Error('OBS disconnected before answering.'));
        });
        pending.clear();
        publishStreamingState();
      }

      const fail = err => {
        if (settled) return;
        settled = true;
        finishHandshake();
        /* close() may not emit onclose immediately. Retire the handshake now,
           so a late Identified message cannot register an abandoned client. */
        markDisconnected();
        try { ws.close(); } catch (e) {}
        reject(err);
      };

      ws.onerror = () => {
        const err = new Error('Could not reach obs-websocket at ' + url + '. Is OBS running, and is ' +
                              'Tools → WebSocket Server Settings → Enable WebSocket server ticked?');
        /* After Identify, an error already makes this controller
           non-authoritative; do not keep displaying its last ON/OFF value
           while waiting for the browser's later close event. */
        if (settled) { markDisconnected(); return; }
        fail(err);
      };
      ws.onclose = ev => {
        if (!settled) { fail(new Error('obs-websocket closed the connection (code ' + ev.code + ').')); return; }
        markDisconnected();
        pending.forEach(request => {
          clearTimeout(request.timer);
          request.rej(new Error('OBS disconnected before answering.'));
        });
        pending.clear();
        /* OBS keeps streaming independently of its control socket. A control
           disconnect proves neither ON nor OFF, even when the last status was
           idle, so retain this endpoint as uncertain until a replacement
           connection supplies a fresh status. */
        publishStreamingState();
        if (client.onClose) { try { client.onClose(ev); } catch (e) {} }
      };
      ws.onmessage = ev => {
        if (disconnectPublished) return;
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const op = msg.op, d = msg.d || {};

        if (op === 0) {                                    // Hello
          const auth = d.authentication;
          if (auth && !cfg.password) {
            fail(new Error('OBS requires a WebSocket password. Copy it from Tools → WebSocket Server Settings ' +
                           '→ Show Connect Info.'));
            return;
          }
          /* Outputs (64) supplies StreamStateChanged, including changes made in
             OBS itself rather than from an OpenLive button. */
          const ident = { rpcVersion: d.rpcVersion || 1, eventSubscriptions: num(cfg.eventSubscriptions, 33) | 64 };
          const go = auth
            ? obsAuth(String(cfg.password), auth.salt, auth.challenge).then(a => { ident.authentication = a; })
            : Promise.resolve();
          go.then(() => {
            if (disconnectPublished || settled || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ op: 1, d: ident }));
          })
            .catch(err => fail(err));
          return;
        }
        if (op === 2) {                                    // Identified
          if (settled) return;
          client.identified = true;
          client._openliveConnected = true;
          /* Do not evict a confirmed client merely because another connection
             reached Identified. The caller may reject that replacement (for
             example, a newer attempt won). A fresh status/event from either
             tracked client retires older same-endpoint entries atomically. */
          streamingObsClients.add(client);
          publishStreamingState();
          settled = true;
          finishHandshake();
          resolve(client);
          return;
        }
        if (op === 5) {                                    // Event
          if (d.eventType === 'StreamStateChanged' && d.eventData &&
              typeof d.eventData.outputActive === 'boolean') {
            updateObsStreaming(client, d.eventData.outputActive);
          }
          if (client.onEvent) { try { client.onEvent(d.eventType, d.eventData || {}); } catch (e) {} }
          return;
        }
        if (op === 7) {                                    // RequestResponse
          const p = pending.get(d.requestId);
          if (!p) return;
          pending.delete(d.requestId);
          clearTimeout(p.timer);
          if (d.requestStatus && d.requestStatus.result) p.res(d.responseData || {});
          else p.rej(new Error('OBS refused ' + (d.requestType || 'the request') + ': ' +
                               ((d.requestStatus && d.requestStatus.comment) || 'no reason given')));
        }
      };
      handshakeTimer = setTimeout(() => fail(new Error('OBS connection timed out before Identify. Check its WebSocket server and try Connect again.')),
        clamp(num(cfg.connectTimeoutMs, 10000), 250, 30000));
      if (cfg.signal) {
        abortHandshake = () => fail(new Error('OBS connection was cancelled.'));
        cfg.signal.addEventListener('abort', abortHandshake, { once: true });
        if (cfg.signal.aborted) abortHandshake();
      }
    });
  }

  /* v5 auth: base64(sha256(password + salt)) is the secret,
              base64(sha256(secret + challenge)) is what goes on the wire. */
  function obsAuth(password, salt, challenge) {
    if (!window.crypto || !window.crypto.subtle) {
      return Promise.reject(new Error('OBS authentication needs SubtleCrypto, which is only available in a ' +
                                      'secure context. Use http://localhost rather than a LAN IP, or set no password.'));
    }
    const sha = text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(b64);
    return sha(password + salt).then(secret => sha(secret + challenge));
  }
  function b64(buf) {
    let s = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }

  /* The four things an operator actually wants from OBS mid-show, plus the one
     that supplies measured numbers. Anything else goes through client.request. */
  function obsStatus(c) {
    const streamRevision = c._openliveStreamRevision || 0;
    return Promise.all([
      c.request('GetStreamStatus').catch(() => null),
      c.request('GetRecordStatus').catch(() => null)
    ]).then(([s, r]) => {
      let streaming = s && typeof s.outputActive === 'boolean' ? !!s.outputActive : null;
      if (streaming != null) {
        if (c._openliveConnected && streamingObsClients.has(c) &&
            (c._openliveStreamRevision || 0) === streamRevision) {
          updateObsStreaming(c, streaming);
        } else if (c._openliveConnected && streamingObsClients.has(c)) {
          /* StreamStateChanged is newer than this request (or the client was
             updated while this request was in flight). Return that newer value
             so callers do not repaint their controls from a stale reply. */
          streaming = typeof c._openliveStreaming === 'boolean' ? c._openliveStreaming : null;
        } else {
          /* A superseded/disconnected client is no longer authoritative. */
          streaming = null;
        }
      }
      return {
        streaming:      streaming,
        streamTimecode: s ? s.outputTimecode : null,
        bytes:          s ? num(s.outputBytes, null) : null,
        droppedFrames:  s ? num(s.outputSkippedFrames, null) : null,
        totalFrames:    s ? num(s.outputTotalFrames, null) : null,
        congestion:     s && s.outputCongestion != null ? +s.outputCongestion.toFixed(3) : null,
        recording:      r ? !!r.outputActive : null,
        recordTimecode: r ? r.outputTimecode : null
      };
    });
  }

  const obs = {
    connect: connectObs,
    scenes:      c => c.request('GetSceneList'),
    setScene:    (c, name) => c.request('SetCurrentProgramScene', { sceneName: name }),
    startStream: c => c.request('StartStream'),
    stopStream:  c => c.request('StopStream'),
    startRecord: c => c.request('StartRecord'),
    stopRecord:  c => c.request('StopRecord'),
    /* GetStreamStatus is the honest source for the numbers a status panel would
       otherwise invent: OBS measures them, we relay them. */
    status: obsStatus,
    /* The other direction, and the one streaming.htm actually documents: get
       this app INTO OBS. No protocol needed — OBS's Browser Source is Chromium. */
    browserSourceUrl(screenId, opts) {
      opts = opts || {};
      const u = new URL('openlive-output.html', location.href);
      if (screenId) u.searchParams.set('screen', screenId);
      u.searchParams.set('chrome', '0');
      if (opts.label) u.searchParams.set('label', opts.label);
      return u.href;
    }
  };

  /* ------------------------------------------------------------------------
     RTMP/RTMPS RELAY — the helper transport

     WHIP is one RTCPeerConnection per destination, and browsers do not share an
     encoder between peer connections, so N WHIP destinations is N encodes. This
     is the opposite shape and the reason it exists: ONE MediaRecorder, one
     bitstream over one WebSocket, and devserver.py's ffmpeg tees it to N RTMP
     sockets. That is why a relay session takes an ARRAY of destinations while
     startWhip() takes a single url — the twentieth destination really does cost
     a socket rather than another encode.

     The video is copied end to end when this browser can encode H.264, which is
     what every RTMP platform wants anyway. When it cannot, the helper has to
     re-encode; that is a real CPU cost, so it is reported as videoPolicy
     'transcode' rather than hidden.
     ---------------------------------------------------------------------- */
  const RELAY_BASE = '/api/relay';

  /* PREFERENCE ORDER, AND WHY MP4 IS FIRST.

     H.264 in WebM first, because it is what MediaRecorder actually streams
     reliably here. Fragmented MP4 was tried above it and is NOT viable: Chrome
     emitted a 1,254-byte init segment and then essentially nothing for twenty
     seconds, so the session never left `connecting`.

     A warning for anyone tempted to blame the container again. WebM looked
     guilty — a 57-second broadcast delivered 49% of its bytes and 403 of ~1710
     frames, with ffmpeg reporting "Unknown element 9F ... considered as invalid
     data" and "Seek to desired resync point failed". The container was
     innocent. The WebSocket ingest was dropping every RFC 6455 CONTINUATION
     frame (opcode 0x0), so large MediaRecorder chunks arrived with holes in
     them and the demuxer complained about the holes. Fixed in devserver.py.

     The helper is still TOLD which container and audio codec it is getting
     rather than guessing, because a wrong guess there is silent corruption of a
     different kind. */
  const RELAY_MIMES = [
    'video/webm;codecs=h264,opus',
    'video/x-matroska;codecs=avc1,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus'
  ];

  /* What the helper needs in order to demux correctly. */
  function relayContainer(mime) { return /mp4/i.test(mime || '') ? 'mp4' : 'matroska'; }
  function relayAudioCodec(mime) { return /mp4a|aac/i.test(mime || '') ? 'aac' : 'opus'; }

  function relayMime(helper) {
    if (!window.MediaRecorder) return null;
    for (const m of RELAY_MIMES) {
      if (helper && (relayIsH264(m) ? helper.h264Copy === false : helper.videoTranscode === false)) continue;
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* older UA */ }
    }
    return null;
  }

  function relayIsH264(mime) { return /h264|avc1/i.test(mime || ''); }

  function relayDeadline(promise, timeoutMs, message, onTimeout) {
    let timer = 0;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (onTimeout) onTimeout(); } catch (_) {}
        reject(new Error(message));
      }, timeoutMs);
    })]).finally(() => clearTimeout(timer));
  }

  async function relayCapability(force, timeoutMs) {
    const waitMs = Math.max(250, Math.min(20000, num(timeoutMs, 8000)));
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return relayDeadline((async () => {
      const r = await fetch(`${RELAY_BASE}/capability${force ? '?force=1' : ''}`,
        { cache: 'no-store', signal:controller ? controller.signal : undefined });
      if (!r.ok) throw new Error(`relay capability: HTTP ${r.status}`);
      return r.json();
    })(), waitMs, 'The local streaming helper check timed out. Refresh channels and try again.',
    () => { if (controller) controller.abort(); });
  }

  /* A start POST can allocate a helper process before its response arrives.
     Its response must remain owned after the visible deadline: aborting fetch
     would lose the only session id available for exact cleanup. */
  function relayAllocationIdentity() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function')
      throw new Error('Secure relay setup identity is unavailable in this browser.');
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function relayCancelAllocation(session) {
    const waitMs = session.stopTimeoutMs || 8000;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const data = await relayDeadline((async () => {
      const response = await fetch(`${RELAY_BASE}/cancel`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({clientRequestId:session.clientRequestId}),
        signal:controller ? controller.signal : undefined
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error('The helper could not acknowledge this relay setup cancellation. Retry End.');
      return payload;
    })(), waitMs, 'Relay setup cancellation timed out. Retry End to verify cleanup.',
    () => { if (controller) controller.abort(); });
    if (!data || data.clientRequestId !== session.clientRequestId || data.cancelled !== true ||
        data.pending !== false || data.stopComplete !== true ||
        !['cancelled','stopped','ended','failed'].includes(String(data.state || '')))
      throw new Error('Relay setup cancellation is not yet confirmed. Retry End when the helper finishes allocating.');
    const snapshot = data.session || data;
    if (data.session && (snapshot.stopComplete !== true ||
        !['stopped','ended','failed'].includes(String(snapshot.state || ''))))
      throw new Error('The helper has not confirmed the allocated relay session stopped. Retry End.');
    const id = typeof snapshot.id === 'string' ? snapshot.id : data.id;
    if (data.id && id && data.id !== id)
      throw new Error('The helper cancellation returned conflicting relay identities. Retry End.');
    if (id && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || session.id && session.id !== id))
      throw new Error('The helper cancellation did not match this relay session. Retry End.');
    if (id) session.id = id;
    session._stopConfirmed = true; session._stopSnapshot = snapshot;
    if (snapshot.recording) session.recording = snapshot.recording;
  }

  function stopRelayAllocation(session) {
    if (session._stopPromise) return session._stopPromise;
    session._allocationAbandoned = true;
    session._stopping = true;
    const operation = (async () => {
      if (session.clientRequestId && !session._stopConfirmed) {
        // The helper can cancel by stable request identity even if the start
        // response was lost, or the cancellation arrived before the POST.
        await relayCancelAllocation(session);
      } else if (!session._stopConfirmed) {
        try {
          await relayDeadline(session._allocationPromise, session.stopTimeoutMs || 8000,
            'Relay setup is still awaiting its allocation response. Retry End when the helper responds.');
        } catch (error) {
          if (!session._allocationRejected) {
            session.state = 'stop-failed'; session.stopError = error.message || String(error);
            streamingRelaySessions.add(session); publishStreamingState();
            throw error;
          }
        }
      }
      if (!session._allocationRejected && !session._stopConfirmed) {
        const stopped = await relayStopRequest(session, session.stopTimeoutMs);
        session._stopSnapshot = stopped; session._stopConfirmed = true;
        if (stopped.recording) session.recording = stopped.recording;
      }
      session.stopAcknowledged = true; session.stopError = null; session.state = 'stopped';
      streamingRelaySessions.delete(session); publishStreamingState();
      return true;
    })();
    session._stopPromise = operation.catch(error => {
      session._stopPromise = null;
      session.state = 'stop-failed'; session.stopError = error.message || String(error);
      streamingRelaySessions.add(session); publishStreamingState();
      throw error;
    });
    return session._stopPromise;
  }

  async function relayStatus() {
    const r = await fetch(`${RELAY_BASE}/status`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`relay status: HTTP ${r.status}`);
    return r.json();
  }

  async function relayStopRequest(session, timeoutMs) {
    const waitMs = Math.max(250, Math.min(15000, num(timeoutMs, 8000)));
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (controller) controller.abort(); } catch (_) {}
        reject(new Error('The relay helper did not acknowledge Stop within ' +
          Math.round(waitMs / 1000) + ' seconds.'));
      }, waitMs);
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetch(`${RELAY_BASE}/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: session.id }),
          signal: controller ? controller.signal : undefined
        });
        let data = null;
        try { data = await response.json(); } catch (_) {}
        if (!response.ok || (data && data.error)) {
          throw new Error(data && data.error || 'Relay Stop returned HTTP ' + response.status + '.');
        }
        if (!relayStopSnapshot(session, data)) {
          throw new Error('The relay helper did not confirm this session has stopped.');
        }
        return data;
      })(), timeout]);
    } finally { clearTimeout(timer); }
  }

  function relayStopSnapshot(session, snapshot) {
    return !!snapshot && String(snapshot.id || '') === String(session.id) &&
      snapshot.stopComplete !== false &&
      ['stopped', 'ended', 'failed'].includes(String(snapshot.state || ''));
  }

  function releaseRelayCapture(session) {
    if (!session._ownedRecorderStream || session._captureStopped) return false;
    const tracks = session._ownedRecorderStream.getTracks();
    let error = null;
    tracks.forEach(track => { try { track.stop(); } catch (reason) { error = error || reason; } });
    if (error) throw error;
    session._captureStopped = true;
    return true;
  }

  function relayWait(promise, timeoutMs) {
    let timer = 0;
    return Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })]).finally(() => clearTimeout(timer));
  }

  /* Hardware video encoders can briefly starve the Programme decoder when
     several orientations initialize together. Only startup shares this lane:
     an actual nonempty recorder chunk releases it, then both encodes continue.
     The session is returned while queued so Stop still owns exact cleanup. */
  const relayEncoderStartQueue = [];
  let relayEncoderStarting = null;
  function queueRelayEncoderStart(session, activate, fail, timeoutMs) {
    let resolveStart;
    const started = new Promise(resolve => { resolveStart = resolve; });
    const job = { session, activate, fail, resolveStart, timeoutMs, timer:0, begun:false, done:false, cancelled:false };
    const finish = () => {
      if (job.done) return;
      job.done = true; clearTimeout(job.timer);
      const index = relayEncoderStartQueue.indexOf(job);
      if (index >= 0) relayEncoderStartQueue.splice(index, 1);
      if (relayEncoderStarting === job) relayEncoderStarting = null;
      if (!job.begun) resolveStart(null);
      Promise.resolve().then(advanceRelayEncoderStart);
    };
    job.finish = finish;
    session._finishEncoderStartup = finish;
    session._cancelEncoderStartup = () => {
      job.cancelled = true;
      // An active encoder releases after its owned media has been stopped.
      if (!job.begun) finish();
    };
    session._encoderStartPromise = started;
    relayEncoderStartQueue.push(job);
    if (!relayEncoderStarting) advanceRelayEncoderStart(true);
    else Promise.resolve().then(() => advanceRelayEncoderStart(false));
    return started;
    function advanceRelayEncoderStart(synchronous) {
      if (relayEncoderStarting) return;
      let next;
      while ((next = relayEncoderStartQueue.shift())) {
        if (next.done) continue;
        if (next.cancelled || next.session._stopping || next.session._failureCleanupPending ||
            ['failed','stopped','ended'].includes(next.session.state)) {
          next.finish(); continue;
        }
        relayEncoderStarting = next; next.begun = true;
        next.timer = setTimeout(() => {
          if (next.done) return;
          // Fail closed: a silent encoder must not hold every later output.
          // Failure owns the active recorder until its stop event or bounded
          // capture release. Starting the next encoder immediately can overlap
          // that teardown and recreate the hardware startup contention.
          Promise.resolve(next.fail(new Error('The browser encoder produced no media during startup. End this output and retry.'), true))
            .finally(next.finish).catch(() => {});
        }, next.timeoutMs);
        try {
          next.activate(); next.resolveStart(next.session);
        } catch (error) {
          next.session._encoderStartError = error;
          if (!synchronous) void next.fail(error, true);
          next.finish(); next.resolveStart(null);
        }
        return;
      }
    }
  }

  async function relaySocketDrain(ws, timeoutMs) {
    const deadline = Date.now() + num(timeoutMs, 8000);
    while (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 0 &&
           Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return !!ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0;
  }

  /* Start ONE session covering every RTMP destination handed in.
     cfg = { destinations:[{name,url,platform}], source, encoder, onState } */
  async function startRelay(cfg) {
    if (cfg?.recording?.enabled) window.OpenLiveSessionPolicy?.assertCanWrite('Recording');
    cfg = cfg || {};
    const source = cfg.source;
    if (!source || !source.stream) {
      throw new Error('startRelay needs a source from fromScreen()/fromCanvas().');
    }
    /* A destination may carry a URL (session-only, or provisioned by an
       account) OR an endpointRef the helper resolves. Either is enough. */
    const suppliedDestinations = Array.isArray(cfg.destinations) ? cfg.destinations : [];
    const acceptedDestinations = [];
    const inputRejections = [];
    suppliedDestinations.forEach((destination, index) => {
      if (destination && (/^rtmps?:\/\//i.test(destination.url || '') || destination.endpointRef)) {
        acceptedDestinations.push({ destination, originalIndex:index });
        return;
      }
      inputRejections.push({
        index,
        id:destination && destination.id,
        name:destination && destination.name,
        reason:'The destination needs an rtmp:// or rtmps:// ingest URL, or a saved endpoint reference.'
      });
    });
    const dests = acceptedDestinations.map(row => row.destination);
    const recording = cfg.recording && cfg.recording.enabled
      ? { enabled: true, name: String(cfg.recording.name || '') }
      : null;
    if (!dests.length && !recording) {
      throw new Error('startRelay needs an RTMP destination, a saved endpoint, or server recording.');
    }

    const cap = await relayCapability(false, cfg.capabilityTimeoutMs);
    if (!cap.relay) {
      throw new Error(cap.error || cap.reason || cap.why ||
        'The local helper cannot relay: ffmpeg was not found on this machine.');
    }
    const mime = relayMime(cap);
    if (!mime) {
      throw new Error(cap.videoTranscode === false
        ? 'This streaming helper requires browser H.264 encoding. This browser cannot supply it; use a browser with H.264 MediaRecorder support.'
        : 'This browser has no MediaRecorder codec the relay can carry. MediaRecorder with a WebM or Matroska profile is the required capability.');
    }
    const copyable = relayIsH264(mime);

    const allocation = {
      kind:'relay', id:null, state:'connecting', destinations:[], recordingRequested:!!recording,
      clientRequestId:cap.allocationCancellation === true ? relayAllocationIdentity() : null,
      startedAt:Date.now(), _allocationPending:true,
      stopTimeoutMs:Math.max(250, Math.min(15000, num(cfg.stopTimeoutMs, 8000)))
    };
    streamingRelaySessions.add(allocation); publishStreamingState();
    allocation._allocationPromise = (async () => {
      const startRes = await fetch(`${RELAY_BASE}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId:allocation.clientRequestId || undefined,
          destinations: dests.map(d => ({
            id: d.id, name: d.name, platform: d.platform || null,
            url: d.url || undefined, endpointRef: d.endpointRef || undefined
          })),
          encoder: {
            /* Tell the helper what it is receiving so it can copy rather than
               re-encode, and so it demuxes with the right parser. Never let it
               guess: a wrong videoCodec is a silent CPU cliff, and a wrong
               container is silent CORRUPTION - a hardcoded `-f matroska` against
               live WebM lost three quarters of the frames while every readout
               still said live. */
            container: relayContainer(mime),
            audioCodec: relayAudioCodec(mime),
            videoCodec: copyable ? 'h264' : 'vpx',
            keyframeSeconds: num(cfg.keyframeSeconds, 2),
            framerate: num(cfg.framerate, 30),
            videoBitrate: num(cfg.videoBitrate, 6_000_000),
            audioBitrate: cfg.audioBitrate || '160k'
          },
          recording: recording || undefined
        })
      });
      const started = await startRes.json();
      const validId = started && typeof started.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(started.id);
      if (validId) {
        allocation.id = started.id; allocation.destinations = started.destinations || [];
        allocation.recording = started.recording || null;
      }
      if (!startRes.ok) {
        // A cancellation can return HTTP 409 after allocating a process. Its
        // failed stop still owns that id; HTTP failure alone is not cleanup.
        allocation._allocationRejected = !validId;
        if (validId && started.stopComplete === true && ['stopped','ended','failed'].includes(String(started.state || '')))
          allocation._stopConfirmed = true;
        throw new Error(started.error || `relay start: HTTP ${startRes.status}`);
      }
      if (!validId)
        throw new Error('The helper returned no valid relay session identity. Setup cleanup cannot be confirmed.');
      return started;
    })().finally(() => { allocation._allocationPending = false; });
    // Consume late outcomes even after the controller has received its error.
    // A late allocation is stopped without opening a socket or an encoder.
    allocation._allocationPromise.then(() => {
      if (allocation._allocationAbandoned && !allocation._stopPromise)
        void stopRelayAllocation(allocation).catch(() => {});
    }, () => {
      if (allocation._allocationRejected) {
        streamingRelaySessions.delete(allocation); publishStreamingState();
      } else if (allocation._allocationAbandoned && !allocation._stopPromise)
        void stopRelayAllocation(allocation).catch(() => {});
    });
    let started;
    try {
      const waitMs = Math.max(250, Math.min(30000, num(cfg.startTimeoutMs, 15000)));
      started = await relayDeadline(allocation._allocationPromise, waitMs,
        'The relay setup response timed out. Use Retry End; any late allocation will be stopped before media starts.');
      if (allocation._allocationAbandoned) {
        await stopRelayAllocation(allocation);
        throw new Error('Relay setup was cancelled before media started.');
      }
    } catch (error) {
      allocation._allocationAbandoned = true;
      if (!allocation._allocationRejected && !allocation._stopConfirmed) {
        allocation.state = 'stop-failed'; allocation.reason = error.message || String(error);
        allocation.stopError = allocation.reason; error.session = allocation;
        streamingRelaySessions.add(allocation);
      } else streamingRelaySessions.delete(allocation);
      publishStreamingState();
      if (allocation.clientRequestId && !allocation._allocationRejected && !allocation._stopConfirmed)
        void stopRelayAllocation(allocation).catch(() => {});
      throw error;
    }

    const mapHelperIndex = row => {
      const helperIndex = Number(row && row.index);
      const accepted = Number.isInteger(helperIndex) ? acceptedDestinations[helperIndex] : null;
      return Object.assign({}, row, { index:accepted ? accepted.originalIndex : helperIndex });
    };
    const session = Object.assign(allocation, {
      kind: 'relay', id: started.id, mime: mime,
      videoPolicy: copyable ? 'copy' : 'transcode',
      destinations: started.destinations || [],
      /* The helper indexes the filtered POST payload.  Callers supplied the
         original array and use those indexes to update per-platform rows, so
         translate helper indexes back and report locally invalid entries too. */
      rejected: inputRejections.concat((started.rejected || []).map(mapHelperIndex)),
      recording: started.recording || null, recordingRequested: !!recording,
      state: 'connecting', reason: '', bytesSent: 0,
      ws: null, recorder: null, startedAt: Date.now(),
      stopTimeoutMs: Math.max(250, Math.min(15000, num(cfg.stopTimeoutMs, 8000)))
    });
    session._allocationPromise = null;
    streamingRelaySessions.add(session);
    publishStreamingState();
    let resolveStopAck, resolveDrainAck;
    session._stopAck = new Promise(resolve => { resolveStopAck = resolve; });
    session._drainAck = new Promise(resolve => { resolveDrainAck = resolve; });

    const emit = (state, reason) => {
      const terminal = state === 'stopped' || state === 'failed' || state === 'ended';
      if (!terminal && (session._stopping || failureCleanupStarted ||
          session.state === 'stopped' || session.state === 'failed')) return;
      session.state = state;
      if (reason != null) session.reason = reason;
      if (state === 'stopped' || state === 'ended' || (state === 'failed' && !failureCleanupStarted))
        streamingRelaySessions.delete(session);
      else streamingRelaySessions.add(session);
      publishStreamingState();
      if (typeof cfg.onState === 'function') {
        try { cfg.onState(state, reason, session); } catch (_) { /* a UI throw must not kill egress */ }
      }
    };
    session._setState = emit;

    /* Any fatal browser-side error owns a compensating stop. Merely changing a
       badge to Failed is not cleanup: MediaRecorder would keep encoding and the
       helper would keep an ffmpeg slot. This path is idempotent because socket,
       recorder and message errors can all describe the same failure. */
    let failureCleanupStarted = false;
    let failureCleanupPromise = null;
    const failRelay = (error, notify) => {
      if (failureCleanupStarted) return failureCleanupPromise || Promise.resolve();
      if (session._stopping || session._stopPromise)
        return session._stopPromise ? session._stopPromise.catch(() => {}) : Promise.resolve();
      failureCleanupStarted = true;
      session._failureCleanupPending = true;
      session._cancelEncoderStartup?.();
      const reason = error && error.message || String(error || 'the relay failed');
      if (notify) emit('failed', reason);
      else {
        session.state = 'failed'; session.reason = reason;
        streamingRelaySessions.add(session); publishStreamingState();
      }
      failureCleanupPromise = (async () => {
        try { if (session.ws) session.ws.close(); } catch (_) {}
        try {
          if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
          if (session._recorderStopped) await relayWait(session._recorderStopped, 3000);
        } catch (_) {}
        try { releaseRelayCapture(session); } catch (_) {}
        session._finishEncoderStartup?.();
        try {
          const stopped = await relayStopRequest(session, session.stopTimeoutMs);
          session._stopConfirmed = true;
          session._stopSnapshot = stopped;
          if (stopped.recording) session.recording = stopped.recording;
        } catch (error) {
          session.stopError = error && error.message || String(error);
          session._stopConfirmed = relayStopSnapshot(session, session._stopSnapshot);
        }
        session._failureCleanupPending = false;
        if (session._stopConfirmed) streamingRelaySessions.delete(session);
        publishStreamingState();
      })();
      session._failureCleanup = failureCleanupPromise;
      return failureCleanupPromise;
    };
    session._failRelay = failRelay;
    const abandonStart = async error => {
      await failRelay(error, false);
      const reason = error instanceof Error ? error : new Error(String(error || 'Relay startup failed.'));
      // A failed start can still own a helper process. Keep its exact handle
      // available to the controller until Retry End obtains an acknowledgement.
      if (!session._stopConfirmed) reason.session = session;
      return reason;
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}${RELAY_BASE}/ingest?session=${encodeURIComponent(session.id)}`);
    } catch (error) {
      throw await abandonStart(error);
    }
    ws.binaryType = 'arraybuffer';
    session.ws = ws;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeoutMs = Math.max(1000, Math.min(30000, num(cfg.openTimeoutMs, 10000)));
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          finish(reject, new Error('The relay ingest socket did not open within ' +
            Math.round(timeoutMs / 1000) + ' seconds.'));
          try { ws.close(); } catch (_) {}
        }, timeoutMs);
        ws.onopen = () => finish(resolve);
        ws.onerror = () => finish(reject,
          new Error('The relay ingest socket would not open.'));
      });
    } catch (error) {
      /* POST /start already owns an ffmpeg session.  A WebSocket failure must
         compensate that remote half or it can consume an encoder slot forever
         even though the browser correctly reports that startup failed. */
      throw await abandonStart(error);
    }

    /* The helper answers on this socket only to report a problem. Surface it;
       never let a text frame pass silently. */
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return;
      let msg = {}; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.op === 'drained') {
        session.stopDrained = true;
        resolveDrainAck(msg);
        return;
      }
      if (msg.op === 'stopped') {
        const snapshot = msg.session || {};
        if (snapshot.recording) session.recording = snapshot.recording;
        if (snapshot.destinations) session.destinations = snapshot.destinations;
        if (relayStopSnapshot(session, snapshot)) {
          session._stopSnapshot = snapshot;
          resolveStopAck(snapshot);
        }
        if (session._stopping) { /* stopRelay verifies completion before publishing it */ }
        else void failRelay(snapshot.reason || 'the helper stopped unexpectedly', true);
        return;
      }
      if (msg.error || msg.state === 'failed' || msg.state === 'ended')
        void failRelay(msg.error || msg.reason || 'the relay failed', true);
      else if (msg.state === 'stopped' && !session._stopping)
        void failRelay(msg.reason || 'the relay stopped unexpectedly', true);
      else if (msg.state) emit(msg.state, msg.reason || '');
    };
    ws.onclose = () => {
      if (!session._stopping && session.state !== 'stopped' && session.state !== 'failed')
        void failRelay(session.reason || 'the relay ingest socket closed unexpectedly', true);
    };
    ws.onerror = () => {
      if (!session._stopping && session.state !== 'stopped' && session.state !== 'failed')
        void failRelay('the relay ingest socket failed', true);
    };

    let rec;
    // Neither a MediaRecorder timeslice nor WebSocket.send applies backpressure.
    // Bound both unsent Blobs and the socket's actual outgoing queue. Holding
    // or dropping container chunks would corrupt the stream; saturation ends
    // this exact owned session instead of accumulating memory and latency.
    const helperQueue = Number(cap.limits && cap.limits.queueBytes);
    const helperCeiling = Number.isFinite(helperQueue) && helperQueue > 0
      ? Math.min(32 * 1024 * 1024, helperQueue) : 32 * 1024 * 1024;
    const bitsPerSecond = Math.max(0, num(cfg.videoBitrate, 6000000)) +
      Math.max(0, num(cfg.audioBitrateBps, 160000));
    const queueLimit = Math.min(helperCeiling, Math.max(1024 * 1024, Math.ceil(bitsPerSecond * 5 / 8)));
    let pendingBytes = 0;
    session.clientQueueLimitBytes = queueLimit;
    session.clientQueuedBytes = () => pendingBytes + Math.max(0, Number(ws.bufferedAmount) || 0);
    let writeChain = Promise.resolve();
    const pendingWrites = new Set();
    const markTailLost = (entry, reason) => {
      if (entry.sent || entry.lost) return;
      entry.lost = true;
      session.mediaTailLostBytes = (session.mediaTailLostBytes || 0) + entry.bytes;
      const error = new Error('The relay stopped with an incomplete media tail: ' +
        session.mediaTailLostBytes + ' final media bytes could not be delivered. ' + reason);
      error.mediaTailLost = true;
      session._finalIngestError = error;
    };
    // A bounded End may close the socket while Blob conversion is still pending.
    // Account for accepted unsent bytes before closure; a late continuation must
    // retain that evidence and must never retransmit into another session.
    session._markPendingTailLoss = () => pendingWrites.forEach(entry =>
      markTailLost(entry, 'The ingest socket closed before the queued media was sent.'));
    const onRecorderData = ev => {
      if (!ev.data || !ev.data.size || failureCleanupStarted) return;
      if (!session.encoderReadyAt && !session._stopping) {
        session.encoderReadyAt = Date.now();
        session._finishEncoderStartup?.();
      }
      if (session.clientQueuedBytes() + ev.data.size > queueLimit) {
        const error = new Error('The streaming output cannot keep up. Its media queue reached the bounded latency limit. Check the connection or choose a lower bitrate before restarting.');
        // Stop owns the final recorder chunk too. If that tail cannot be sent,
        // still finalize the exact helper, but never report a clean media End.
        if (session._stopping) session._finalIngestError = error;
        else void failRelay(error, true);
        return;
      }
      pendingBytes += ev.data.size;
      const entry = { bytes:ev.data.size, sent:false, lost:false };
      pendingWrites.add(entry);
      writeChain = writeChain.then(async () => {
        if (entry.lost || failureCleanupStarted || ws.readyState !== WebSocket.OPEN) {
          markTailLost(entry, 'The ingest socket closed before the queued media was sent.');
          return;
        }
        const buf = await ev.data.arrayBuffer();
        if (entry.lost || failureCleanupStarted || ws.readyState !== WebSocket.OPEN) {
          markTailLost(entry, 'The ingest socket closed before the queued media was sent.');
          return;
        }
        ws.send(buf);
        entry.sent = true;
        session.bytesSent += buf.byteLength;
      }).finally(() => {
        pendingBytes -= ev.data.size;
        pendingWrites.delete(entry);
      }).catch(error => {
        const reason = new Error(`ingest write failed: ${error && error.message ? error.message : error}`);
        if (session._stopping) markTailLost(entry, reason.message);
        else void failRelay(reason, true);
      });
    };
    session._drain = () => writeChain;
    queueRelayEncoderStart(session, () => {
      // Each encoder owns cloned tracks, never the shared programme capture.
      // Queued sessions have no clone or encoder until their turn arrives.
      const recorderStream = typeof source.stream.clone === 'function'
        ? source.stream.clone() : source.stream;
      if (recorderStream !== source.stream) session._ownedRecorderStream = recorderStream;
      rec = new MediaRecorder(recorderStream, {
        mimeType: mime,
        videoBitsPerSecond: num(cfg.videoBitrate, 6000000),
        audioBitsPerSecond: num(cfg.audioBitrateBps, 160000)
      });
      session.recorder = rec;
      rec.ondataavailable = onRecorderData;
      let resolveRecorderStopped;
      session._recorderStopped = new Promise(resolve => {
        resolveRecorderStopped = resolve;
        rec.onstop = () => { session._finishEncoderStartup?.(); writeChain.finally(resolve); };
      });
      rec.onerror = ev => void failRelay(
        `MediaRecorder: ${(ev && ev.error && ev.error.message) || 'encoder error'}`, true);
      /* A timeslice is required: without one MediaRecorder holds everything
         until stop(), which is a recording, not a stream. */
      try { rec.start(num(cfg.chunkMs, 250)); }
      catch (error) {
        // A rejected start leaves an inactive recorder with no stop event to
        // join. Retry End must still be able to finish its owned helper.
        if (rec.state === 'inactive') writeChain.finally(resolveRecorderStopped);
        throw error;
      }
    }, failRelay, Math.max(1000, Math.min(15000, num(cfg.encoderStartupTimeoutMs, 8000))));
    if (session._encoderStartError) {
      throw await abandonStart(session._encoderStartError);
    }
    emit('connecting');
    return session;
  }

  /* Live numbers come from the helper's ffmpeg, never from a guess here.
     Returns null fields rather than zeros when nothing has been measured. */
  async function relayStats(session) {
    if (!session || !session.id) return null;
    const status = await relayStatus();
    const ses = (status.sessions || []).find(s => s.id === session.id) || null;
    const cleanupStarted = !!(session._stopping || session._stopPromise || session._failureCleanup ||
      session.state === 'stopped' || session.state === 'failed' || session.state === 'ended');
    if (!ses) {
      /* Losing the helper record is terminal unless this browser deliberately
         owns Stop. Do not let a missed socket-close frame leave MediaRecorder
         encoding forever behind an OFF AIR badge. */
      if (!cleanupStarted && typeof session._failRelay === 'function')
        void session._failRelay('the helper no longer reports this relay session', true);
      return null;
    }
    if ((ses.state === 'stopped' || ses.state === 'failed' || ses.state === 'ended') && !cleanupStarted &&
        typeof session._failRelay === 'function') {
      session.destinations = ses.destinations || [];
      session.recording = ses.recording || session.recording || null;
      void session._failRelay(ses.reason || 'the helper reported that the relay ended', true);
    } else if (!cleanupStarted) {
      session.state = ses.state;
      session.reason = ses.reason || '';
      if (ses.state === 'stopped' || ses.state === 'failed' || ses.state === 'ended')
        streamingRelaySessions.delete(session);
      else streamingRelaySessions.add(session);
      publishStreamingState();
    }
    session.destinations = ses.destinations || [];
    session.recording = ses.recording || session.recording || null;
    return {
      state: ses.state,
      reason: ses.reason || '',
      /* A stalled session is still "live" or "connecting" — it may recover the
         moment the sick destination starts reading — so this travels beside
         the state rather than replacing it. null means measured and healthy,
         which is a different answer from absent. */
      stalledSeconds: ses.stalledSeconds != null ? ses.stalledSeconds : null,
      stalledReason: ses.stalledReason || '',
      kbps: ses.kbps,                       // null until ffmpeg reports one
      uptimeSeconds: ses.uptimeSeconds,
      bytesIn: ses.bytesIn,
      bytesSent: session.bytesSent,
      liveDestinations: ses.liveDestinations,
      aggregateUplinkMbps: ses.aggregateUplinkMbps,
      droppedFrames: ses.droppedFrames,
      speed: ses.speed,
      videoPolicy: session.videoPolicy,
      recording: session.recording,
      destinations: ses.destinations || [],
      log: ses.log || []
    };
  }

  function stopRelay(session) {
    if (!session) return Promise.resolve(false);
    if (session._allocationPromise) return stopRelayAllocation(session);
    if (session._stopPromise) return session._stopPromise;
    session._stopping = true;
    session._cancelEncoderStartup?.();
    /* Keep the last confirmed live/connecting state in the registry until the
       recorder, ordered socket drain and helper finalizer have settled. Bytes
       can still reach a platform during that tail; OFF AIR before then would
       be a comforting but false statement. */
    streamingRelaySessions.add(session);
    const operation = (async () => {
      if (session._failureCleanup) await session._failureCleanup;
      let browserError = null;
      try {
        if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
        // stop() makes state inactive before its final data/stop events arrive.
        // Always join that event and its ordered writes, including a recorder
        // already stopped by another owner. A timeout still stops the helper,
        // but cannot certify that its final media drained.
        if (session._recorderStopped) await relayDeadline(session._recorderStopped, 3000,
          'The browser encoder did not finish draining its final media. Retry End after it settles.');
        else if (session._drain) await relayDeadline(session._drain(), 3000,
          'The browser encoder did not finish draining its final media. Retry End after it settles.');
      } catch (error) { browserError = error; }
      try {
        releaseRelayCapture(session);
      } catch (error) { browserError = browserError || error; }
      session._finishEncoderStartup?.();
      if (!browserError && session.recorder && session.recorder.state !== 'inactive' && !session._captureStopped)
        browserError = new Error('The browser encoder did not stop.');
      if (session._finalIngestError) browserError = session._finalIngestError;

      let completion = session._stopSnapshot || null, helperError = null;
      try {
        const waitMs = session.stopTimeoutMs || 8000;
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          /* WebSocket preserves message order. The helper acknowledges only
             after it has consumed every preceding media frame; the HTTP call
             then waits for its serialized ffmpeg finalizer. Closing first can
             truncate the queued tail of the programme on a busy machine. */
          session.networkDrained = await relaySocketDrain(session.ws, waitMs);
          session.ws.send(JSON.stringify({ op: 'stop' }));
          // 'drained' proves ordered bytes, not ffmpeg finalization. Keep the
          // socket open for its separate stopped snapshot while HTTP joins the
          // helper's serialized finalizer. Either terminal reply is sufficient.
          await relayWait(session._drainAck, waitMs);
        }
      } catch (_) { /* HTTP below is also the recovery path for a broken socket. */ }
      try {
        const outcomes = await Promise.allSettled([
          relayStopRequest(session, session.stopTimeoutMs),
          session.ws && session.ws.readyState === WebSocket.OPEN
            ? relayWait(session._stopAck, session.stopTimeoutMs || 8000) : Promise.resolve(completion)
        ]);
        outcomes.forEach(result => {
          if (result.status === 'fulfilled' && relayStopSnapshot(session, result.value)) {
            // Prefer a ready recording if the other finalized reply observed
            // the file before the final size became visible.
            if (!completion || !(completion.recording && completion.recording.ready)) completion = result.value;
          } else if (result.status === 'rejected') helperError = helperError || result.reason;
        });
      } finally {
        session._markPendingTailLoss?.();
        try { if (session.ws) session.ws.close(); } catch (_) {}
      }
      const confirmed = relayStopSnapshot(session, completion);
      session._stopConfirmed = confirmed;
      session.stopAcknowledged = confirmed;
      if (confirmed) {
        session._stopSnapshot = completion;
        if (completion.recording) session.recording = completion.recording;
      }
      const recordingFailed = (session.recordingRequested || session.recording && session.recording.enabled) &&
        !(completion && completion.recording && completion.recording.ready === true);
      if (session._finalIngestError) browserError = session._finalIngestError;
      // The lost tail cannot be recovered by Retry End. For live-only output,
      // confirmed termination frees the next run while returning its degraded
      // result explicitly. Recording finalization keeps its existing failure
      // contract. Clean live shutdown still returns true for existing callers.
      if (confirmed && browserError && browserError.mediaTailLost &&
          (session._captureStopped || session.recorder?.state === 'inactive') &&
          !session.recordingRequested && !(session.recording && session.recording.enabled)) {
        const result = { stopped:true, drained:false, truncated:true,
          droppedBytes:session.mediaTailLostBytes || 0, reason:browserError.message };
        session.stopResult = result;
        session.stopDrained = false;
        session.stopError = null;
        if (typeof session._setState === 'function') session._setState('stopped', result.reason);
        else {
          session.state = 'stopped'; session.reason = result.reason;
          streamingRelaySessions.delete(session); publishStreamingState();
        }
        return result;
      }
      if (!confirmed || browserError || recordingFailed) {
        const error = browserError || (!confirmed
          ? helperError || new Error('The relay helper did not confirm Stop. Retry End.')
          : new Error('The relay stopped, but its recording is not ready. Retry finalization.'));
        if (confirmed && completion.stopComplete === true && completion.state === 'failed' && recordingFailed) {
          error.recordingFailed = true;
          error.message = 'The helper has stopped, but this recording could not be finalized successfully.';
          session._recordingFailed = true;
        }
        session.state = 'stop-failed';
        session.stopError = error && error.message || String(error);
        session.reason = session.stopError;
        if (confirmed) streamingRelaySessions.delete(session);
        else streamingRelaySessions.add(session);
        publishStreamingState();
        throw error;
      }
      session.stopError = null;
      session.stopResult = { stopped:true, drained:true, truncated:false, droppedBytes:0,
        reason:'stopped by operator' };
      if (typeof session._setState === 'function') session._setState('stopped', 'stopped by operator');
      else {
        session.state = 'stopped';
        streamingRelaySessions.delete(session);
        publishStreamingState();
      }
      return true;
    })();
    session._stopPromise = operation.catch(error => {
      // Local media stays stopped; only the idempotent helper finalization is
      // retried. A rejected cached promise would make Retry End a dead button.
      session._stopPromise = null;
      throw error;
    });
    return session._stopPromise;
  }

  function startCloudRecording(cfg) {
    try { window.OpenLiveSessionPolicy?.assertCanWrite('Recording'); }
    catch (error) { return Promise.reject(error); }
    cfg = cfg || {};
    return startRelay({
      source: cfg.source,
      destinations: [],
      recording: { enabled: true, name: cfg.fileName || cfg.name || '' },
      videoBitrate: cfg.bitrate,
      audioBitrateBps: cfg.audioBitrate,
      framerate: cfg.framerate,
      keyframeSeconds: cfg.keyframeSeconds,
      onState: cfg.onState
    });
  }

  /* ------------------------------------------------------------------------
     PLATFORM ACCOUNTS — "pick a channel", not "paste a key"

     This is the half of Restream that is not video. The helper owns the OAuth:
     it holds the refresh tokens (encrypted, never in this tab), provisions the
     ingest, and hands back an rtmps:// URL that goes straight into relay.start.

     The consent screen opens in the user's REAL browser at the platform's own
     origin. Not an iframe, not a popup we render: Google returns
     `disallowed_useragent` for embedded user-agents, and a tab cannot read
     another origin's cookies anyway. Nothing here "captures" a login — the user
     clicks Allow once per channel and the refresh token that comes back IS the
     channel from then on.
     ---------------------------------------------------------------------- */
  const ACCT_BASE = '/api/accounts';

  // A failed provision may have created remote objects whose deletion failed.
  // Keep only their identities, never the provider body, tokens or ingest URL.
  function pendingProvisionCleanup(data, accountId) {
    const cleanup = data && data.cleanup;
    if (!cleanup || cleanup.ok !== false) return null;
    const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
    const identity = key => {
      const top = id(data[key]), nested = id(cleanup[key]);
      return top && nested && top !== nested ? null : top || nested;
    };
    return Object.freeze({ accountId: String(accountId || ''),
      broadcastId: identity('broadcastId'), streamId: identity('streamId') });
  }

  function retainProvisionCleanup(record, error, accountId) {
    const cleanup = error && error.provisionCleanup;
    if (!record || !cleanup || cleanup.accountId !== String(accountId || '')) return false;
    record.provisionCleanupPending = true;
    record.finalized = false;
    // Existing identities belong to this attempt and are never replaced.
    if (!record.broadcastId) record.broadcastId = cleanup.broadcastId;
    if (!record.streamId) record.streamId = cleanup.streamId;
    return true;
  }

  async function acctJSON(path, body, signal) {
    const opts = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) };
    if (signal) opts.signal = signal;
    const r = await fetch(ACCT_BASE + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = new Error(data.error || `accounts ${path}: HTTP ${r.status}`);
      error.status = r.status;
      error.code = data.apiReason || data.code || null;
      error.eligibility = data.eligibility && typeof data.eligibility === 'object'
        ? data.eligibility : null;
      if (path === '/ingest') {
        const cleanup = pendingProvisionCleanup(data, body && body.id);
        if (cleanup) error.provisionCleanup = cleanup;
      }
      throw error;
    }
    return data;
  }

  /* SAVED INGESTS — connect once, stream forever.

     An ingest URL is entered one time and stored by the helper, encrypted.
     From then on only its id (`endpointRef`) travels: the destination record
     carries the id, relay.start sends the id, and the helper substitutes the
     URL it holds. list() never returns a URL — host and label only. This is
     what makes the fifty-destination show a fifty-click setup once, not every
     session. */
  const EP_BASE = '/api/endpoints';
  async function epJSON(path, body) {
    const opts = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) };
    const r = await fetch(EP_BASE + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `endpoints ${path}: HTTP ${r.status}`);
    return data;
  }
  const endpointsList = () => epJSON('');
  const endpointAdd = (url, platformId, label) => epJSON('/add', { url, platformId, label });
  const endpointRemove = id => epJSON('/remove', { id });

  const accountsStatus = () => acctJSON('/status');
  const accountsProviders = () => acctJSON('/providers');
  /* The picker's data. Services first, protocols last: a destination row should
     read "YouTube - Afro Unity Group", never "RTMP (helper)". Every row carries
     `kind` (channel | connect | key | whip | blocked) and a `note` saying what
     it needs, so no row can look available when it is not. */
  const accountsCatalogue = () => acctJSON('/catalogue');
  const accountsDestinations = () => acctJSON('/destinations');
  const accountsMetadataCapability = provider => acctJSON('/metadata-capability' +
    (provider ? '?provider=' + encodeURIComponent(provider) : ''));
  const accountsApplyNow = (accountIds, info) => acctJSON('/apply-now', {
    accountIds: Array.isArray(accountIds) ? accountIds : [accountIds],
    info: info || {}
  });
  const accountsResolveCategory = (accountId, name) =>
    acctJSON('/resolve-category', { accountId, name });
  const accountsCategories = (accountId, region = 'US') =>
    acctJSON('/categories?accountId=' + encodeURIComponent(accountId) +
      '&region=' + encodeURIComponent(region));
  const setClientId = (provider, clientId) => acctJSON('/client-id', { provider, clientId });
  const disconnectAccount = id => acctJSON('/disconnect', { id });
  const accountChannels = id => acctJSON('/channels', { id });

  /* Provision an ingest for one channel. The returned url CONTAINS the stream
     key — hand it to relay.start and let it go out of scope. Do not store it,
     do not put it in a destination record, do not log it. */
  const provisionIngest = (id, opts) =>
    acctJSON('/ingest', Object.assign({}, opts || {}, { id }));
  /* Close the platform-side object created by provisionIngest().  `complete`
     preserves the finished broadcast/VOD; `abort` removes a setup that never
     reached viewers.  Provider access tokens stay in the helper. */
  function confirmedPlatformFinish(request, result) {
    const broadcastId = String(request.broadcastId || '').trim();
    const streamId = String(request.streamId || '').trim();
    let valid = !!result && typeof result === 'object' && !Array.isArray(result) &&
      !result.error && result.ok !== false;
    if (valid && result.state === 'complete') {
      valid = !!broadcastId && String(result.broadcastId || '') === broadcastId &&
        !(result.transition && (result.transition.ok === false ||
          result.transition.state && result.transition.state !== 'complete'));
    } else if (valid && result.state === 'aborted') {
      valid = !!(broadcastId || streamId) &&
        (!broadcastId || String(result.broadcastId || '') === broadcastId) &&
        (!streamId || String(result.streamId || '') === streamId) &&
        !!result.cleanup && result.cleanup.ok === true;
    } else if (valid && result.state === 'media-stopped') {
      valid = !broadcastId && !streamId;
    } else valid = false;
    if (!valid) {
      const error = new Error('The helper did not confirm the end of the requested platform broadcast. ' +
        'Retry End; completion has not been confirmed.');
      error.code = 'finish_unconfirmed';
      error.unconfirmed = true;
      throw error;
    }
    return result;
  }

  function finishBroadcast(id, opts) {
    const request = Object.assign({}, opts || {}, { id });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('The platform end request was not confirmed within 30 seconds. ' +
          'The helper may still finish it; Retry End to check the same broadcast.');
        error.code = 'finish_timeout';
        error.unconfirmed = true;
        // Reject with the actionable uncertainty message before AbortError can
        // replace it. Aborting the browser request does not undo server work.
        reject(error);
        try { if (controller) controller.abort(); } catch (_) {}
      }, 30000);
    });
    return Promise.race([
      acctJSON('/finish', request, controller && controller.signal)
        .then(result => confirmedPlatformFinish(request, result)),
      timeout
    ]).finally(() => clearTimeout(timer));
  }

  function broadcastStatus(id, opts) {
    const request = Object.assign({}, opts || {}, { id });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Platform delivery status could not be checked in time.');
        error.code = 'delivery_status_timeout';
        reject(error);
        try { if (controller) controller.abort(); } catch (_) {}
      }, 15000);
    });
    return Promise.race([
      acctJSON('/broadcast-status', request, controller && controller.signal).then(result => {
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.error ||
            String(result.broadcastId || '') !== String(request.broadcastId || '') ||
            request.streamId && String(result.streamId || '') !== String(request.streamId))
          throw new Error('The platform status did not match this stream attempt.');
        if (result.provider !== 'youtube' || typeof result.live !== 'boolean' || typeof result.receiving !== 'boolean' ||
            !['live','receiving','starting','waiting','complete','ending','error','missing','unknown'].includes(result.state) ||
            result.live !== (result.lifeCycleStatus === 'live') || (result.state === 'live') !== result.live)
          throw new Error('The platform returned inconsistent delivery evidence.');
        return result;
      }), timeout
    ]).finally(() => clearTimeout(timer));
  }

  /* Consent-only requests have their own deadline: ordinary metadata/finish
     callers retain their existing request contracts. Race the entire JSON
     operation, not just response headers; abort is best-effort and cannot undo
     a consent flow which the helper has already started. */
  const CONSENT_REQUEST_TIMEOUT = 15000;
  function consentError(message, code, unconfirmed) {
    const error = new Error(message);
    error.code = code;
    if (unconfirmed) error.unconfirmed = true;
    return error;
  }
  function safeConsentError(error, flowState) {
    let message = String(error && error.message || error || 'Platform sign-in failed.');
    // A fetch failure or helper error may echo the poll URL or authorize URL.
    // Neither the query nor the opaque flow state belongs in a visible error.
    message = message.replace(/https?:\/\/[^\s<>"']+/gi, '[address omitted]')
      .replace(/[?&][^\s<>"']+/g, '[query omitted]');
    if (flowState) message = message.split(flowState).join('[flow omitted]');
    const safe = new Error(message.slice(0, 800));
    if (error && Number.isInteger(error.status)) safe.status = error.status;
    if (error && typeof error.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code) &&
        (!flowState || !error.code.includes(flowState))) safe.code = error.code;
    if (error && error.unconfirmed) safe.unconfirmed = true;
    return safe;
  }
  function consentJSON(path, body, timeoutMs, flowState) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(consentError('The accounts helper did not respond in time. SHOWAVE stopped waiting; ' +
          'this does not cancel a consent flow already running in the helper. ' +
          'Refresh channels before trying again.', 'consent_request_timeout', true));
        try { if (controller) controller.abort(); } catch (_) {}
      }, timeoutMs);
    });
    return Promise.race([acctJSON(path, body, controller && controller.signal), timeout])
      .catch(error => { throw safeConsentError(error, flowState); })
      .finally(() => clearTimeout(timer));
  }
  function consentExpired() {
    return consentError('The consent waiting period expired without a confirmed connection. ' +
      'Stopping this wait does not cancel helper consent. Refresh channels before trying again.',
      'consent_timeout', true);
  }

  /* Run one consent flow to completion. With browser:'caller', onPrompt receives
     the unchanged URL for a normal top-level browser outside SHOWAVE. The
     helper's default system-browser behavior remains available to other callers.
     Neither mode certifies browser support or bypasses provider restrictions.
     Resolves with the connection outcome (including
     alreadyConnected when the same provider channel was authorised again), or
     throws with the real reason.

     Two flows share this function. A provider the helper reports as
     flow:'device' uses the RFC 8628 device-code grant - no redirect, no
     loopback - and the prompt then carries a userCode the operator may need to
     type on the platform's page. The polling is identical. */
  async function connectAccount(provider, opts) {
    opts = opts || {};
    const browser = opts.browser === undefined ? 'system' : opts.browser;
    if (browser !== 'system' && browser !== 'caller')
      throw consentError('Sign-in browser must be system or caller.', 'invalid_browser_handoff');
    if (browser === 'caller' && typeof opts.onPrompt !== 'function')
      throw consentError('Caller browser handoff requires an onPrompt handler.', 'missing_browser_handoff');
    if (browser === 'caller') {
      // An old helper ignores unknown request fields and would open the OS
      // browser. Negotiate BEFORE begin: never silently downgrade user choice.
      const status = await consentJSON('/status', undefined, CONSENT_REQUEST_TIMEOUT);
      if (!status || !Array.isArray(status.browserHandoffModes) ||
          !status.browserHandoffModes.includes('caller'))
        throw consentError('This accounts helper cannot hand sign-in to the chosen browser. ' +
          'Restart the local helper with the updated build, then try again. No sign-in was started.',
          'helper_restart_required');
    }
    const route = opts.flow === 'device' ? '/device' : '/connect';
    const requestedAt = Date.now();
    const begun = await consentJSON(route, browser === 'caller' ? { provider, browser } : { provider },
      CONSENT_REQUEST_TIMEOUT);
    if (browser === 'caller' && (!begun || begun.browserHandoff !== 'caller' ||
        begun.openedSystemBrowser !== false))
      throw consentError('The helper did not confirm the requested browser handoff. ' +
        'No sign-in address was opened by this page. The helper may have started consent; ' +
        'refresh channels and restart the updated helper before trying again.',
        'browser_handoff_unconfirmed', true);
    if (!begun || typeof begun.state !== 'string' || !begun.state.trim() || begun.state.length > 512)
      throw consentError('The helper did not return a usable sign-in flow. ' +
        'Refresh channels before trying again.', 'consent_begin_invalid', true);
    /* A normal browser may reuse its own existing platform session. That is
       browser-dependent, not exclusive to the OS default browser. Never embed
       the consent page inside SHOWAVE or claim the provider approved this host. */
    if (typeof opts.onPrompt === 'function') {
      try { opts.onPrompt(begun); }
      catch (error) { throw safeConsentError(error, begun.state); }
    }
    else if (!begun.openedSystemBrowser) {
      try { window.open(begun.authorizeUrl || begun.verificationUri, '_blank', 'noopener'); }
      catch (_) { /* legacy callers may display their own browser-open guidance */ }
    }

    const seconds = Number(begun.expiresInSeconds);
    const deadline = requestedAt + (Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds, 1800) : 300) * 1000;
    for (;;) {
      let remaining = deadline - Date.now();
      if (remaining <= 0) throw consentExpired();
      await new Promise(r => setTimeout(r, Math.min(1200, remaining)));
      remaining = deadline - Date.now();
      if (remaining <= 0) throw consentExpired();
      const state = await consentJSON('/poll?state=' + encodeURIComponent(begun.state), undefined,
        Math.min(CONSENT_REQUEST_TIMEOUT, remaining), begun.state);
      if (!state || typeof state !== 'object' || Array.isArray(state))
        throw consentError('The helper returned an invalid consent status. Refresh channels before trying again.',
          'consent_poll_invalid', true);
      if (state.error) throw safeConsentError(new Error(state.error), begun.state);
      if (typeof state.pending !== 'boolean')
        throw consentError('The helper did not confirm a consent status. Refresh channels before trying again.',
          'consent_poll_invalid', true);
      if (!state.pending) return state;
      if (Date.now() >= deadline) throw consentExpired();
    }
  }

  /* ---- small shared helpers ---------------------------------------------- */
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  return {
    version: 1,
    capabilities: capabilities,
    sources: { fromScreen: fromScreen, fromCanvas: fromCanvas },
    whip: { start: startWhip, stats: whipStats, stop: stopWhip },
    /* One session, N RTMP destinations. See the RELAY block above for why the
       shape differs from whip's one-url-per-session. */
    relay: {
      start: startRelay, stats: relayStats, stop: stopRelay,
      capability: relayCapability, status: relayStatus, mime: relayMime
    },
    /* Connect once, pick a channel, never see a key. provisionIngest() returns
       the rtmps:// URL that relay.start() consumes directly. */
    /* Saved ingests. add() takes the URL once; list() never gives it back. */
    endpoints: { list: endpointsList, add: endpointAdd, remove: endpointRemove },
    accounts: {
      status: accountsStatus, providers: accountsProviders,
      catalogue: accountsCatalogue, destinations: accountsDestinations,
      metadataCapability: accountsMetadataCapability,
      applyNow: accountsApplyNow, resolveCategory: accountsResolveCategory,
      categories: accountsCategories,
      setClientId: setClientId, connect: connectAccount,
      disconnect: disconnectAccount, channels: accountChannels,
      provisionIngest: provisionIngest, retainProvisionCleanup: retainProvisionCleanup, finishBroadcast: finishBroadcast,
      broadcastStatus: broadcastStatus
    },
    recorder: { start: startRecording, stop: stopRecording, formats: recorderFormats },
    cloudRecorder: { start: startCloudRecording, stats: relayStats, stop: stopRelay },
    clipBuffer: { start: startClipBuffer, save: saveClipBuffer, stop: stopClipBuffer },
    obs: obs,
    streaming: {
      getState: streamingSnapshot,
      subscribe: subscribeStreaming,
      forgetObs: forgetObsStreaming,
      stopAll: stopAllStreaming
    }
  };
})();
