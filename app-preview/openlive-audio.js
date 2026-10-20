/* ===========================================================================
   openlive-audio.js — the machine's real audio devices, a true stereo meter,
   a Zoom-style sound test, and the one FFT bus this app can honestly feed.
   ---------------------------------------------------------------------------
   WHY THIS EXISTS

   preferences.html hardcoded four output devices and four input devices —
   "Speakers (Realtek HD)", "ASIO — Focusrite USB", "Microphone (USB)",
   "Line In", "Focusrite USB Input". None of them were ever enumerated. The
   Audio tab therefore offered hardware that is not attached and omitted the
   hardware that is, which is the same defect that was just fixed for DISPLAYS
   in openlive-displays.js. This module is the audio half of that fix, and it
   keeps the same contract: supported() / permission() / devices() / request() /
   onChange(), a synchronous list that is never empty, and a `complete` flag
   whenever the list may be short.

   WHAT ENUMERATION ACTUALLY RETURNS — MEASURED, IN TWO ENGINES

   Edge 151 (real Windows device stack) and the Chrome 148 shell, both on
   http://localhost (isSecureContext true), give three distinct states:

     NEVER ASKED  permissions.query({name:'microphone'}).state === 'prompt'
                  enumerateDevices() returns EXACTLY 3 entries — one audioinput,
                  one videoinput, one audiooutput — and every field of every
                  entry is the empty string: deviceId '', label '', groupId ''.
     DENIED       identical: the same three anonymous placeholders.
     GRANTED      18 entries — 8 audioinput, 5 videoinput, 5 audiooutput — with
                  64-hex deviceId and groupId and real labels.

   So "audioinput: 1" IS NOT A DEVICE COUNT. It is Chrome's pre-permission
   privacy placeholder: at most one anonymous row per KIND that exists, purely
   to say "at least one device of this kind is attached". The real machine has
   eight inputs. Rendering a row per placeholder — which preferences-audio.js
   used to do, as `label: item.label || ('Audio Input ' + (index+1))` — invents
   a name for a device that cannot be identified and cannot be opened, because
   getUserMedia({deviceId:{exact:''}}) is meaningless. Swapping the fictional
   Realtek/Focusrite list for a fictional "Audio Input 1" list would trade one
   lie for another. openlive-capture.js already writes this reasoning down for
   the video side; this file is the same model applied to audio.

   ALIASES. 'default' and 'communications' are ALIAS rows for a physical device,
   not extra hardware — measured: default + communications + "Microphone (Senary
   Audio)" all carry groupId f8bbe3ca11d45aad..., and the three Headphones rows
   all share 787463150b96f6d7.... We dedupe by groupId, keep the non-alias label,
   and keep "System Default" as its own explicit choice, which is what Arena's
   device menu means.

   A LISTED DEVICE IS NOT NECESSARILY OPENABLE. getUserMedia with an exact
   deviceId returned OverconstrainedError on 4 of the 8 real inputs. Enumeration
   is a catalogue, not a guarantee, so arm() catches that specific error, retries
   without the constraint, and reports the device it ACTUALLY opened.

   TWO HARD CEILINGS THE UI HAS TO RESPECT
     * AudioContext.destination.maxChannelCount === 2 at every sample rate
       tested (44.1k .. 192k). Master output is stereo or nothing. The 8-channel
       "ASIO — Focusrite USB" device and every routing option built from it
       described something a browser cannot do.
     * There is no settable buffer size. The WebAudio render quantum is fixed at
       128 frames. The only lever is latencyHint, measured at 10.0 ms
       ('interactive'/'balanced') and 20.0 ms ('playback'). latency() therefore
       reports ctx.baseLatency, which is measured, instead of bufferSize/rate,
       which is arithmetic on a control that changes nothing.
   Sample rate, by contrast, IS real: new AudioContext({sampleRate:N}) reported
   exactly N for 44100/48000/88200/96000/192000, and a 44.1k context accepts a
   48k getUserMedia stream (Chrome resamples), so choosing 44.1k cannot break
   input. setSampleRate() honours it by constructing the context at that rate.

   OUTPUT ROUTING IS REAL. 'setSinkId' exists on both HTMLMediaElement and
   AudioContext here; ctx.setSinkId('default') and ctx.setSinkId(<real id>) both
   resolved. Because everything audible in this module goes through
   ctx.destination, setting the sink on the CONTEXT routes the speaker test, the
   playback and any future program audio with one call. setSinkId('default')
   worked in a NEVER-PROMPTED profile, so the speaker test is the first thing on
   the Audio tab that works — only the output PICKER needs the mic permission,
   because output names are gated behind it. navigator.mediaDevices
   .selectAudioOutput does not exist, and permissions.query({name:
   'speaker-selection'}) throws, so there is nothing to pre-flight: try
   setSinkId, catch NotFoundError, fall back to 'default', and say so.

   THE METER GRAPH, PROVEN WITH A KNOWN SIGNAL

     source -> meterIn (GainNode, 2ch explicit/speakers)
            -> ChannelSplitterNode(2) -> analyser L (output 0)
                                      -> analyser R (output 1)

   Validated by pushing a deliberately asymmetric stereo signal (L 0.9 @ 220 Hz,
   R 0.3 @ 880 Hz) through the identical path: peakL 0.9000 exact, peakR 0.3000
   exact, rms 0.6318 / 0.2119 against a theoretical 0.6364 / 0.2121. No
   cross-talk, no scaling error. Confirmed again on shipped content: media/AV/
   Beat 001.wav read peakL 0.223984 / peakR 0.213810 with only 1 of 96 frames
   bit-identical, i.e. the two bars move independently on real material.

   MONO IS THE TRAP, NOT SILENCE. Feeding a genuinely mono signal in produced
   peakL 0.7000 / peakR 0.7000 on every frame — R DUPLICATES L rather than going
   dead, because Chromium up-mixes before the splitter (the source node reports
   channelCount 2 and the track's own getSettings() reports 2 even when the
   producer was forced to 1). Two identical bars assert a stereo image that does
   not exist, so mono is DETECTED — by track.getSettings().channelCount, by
   bit-identity across MONO_FRAMES consecutive frames above the noise floor, and
   by the inferred dead-R signature — and reported as mono rather than drawn as
   working stereo.

   BALLISTICS ARE WRITTEN IN JS BECAUSE THE ANALYSER'S ARE INERT.
   getFloatTimeDomainData COMPLETELY IGNORES smoothingTimeConstant — measured, an
   analyser at 0.9 stepped 0 -> 0.8 and 0.8 -> 0 in a single frame each way. So
   the meter analysers run smoothing 0 and every millisecond of attack and decay
   is ours: instant attack, then linear-in-dB decay at 11.8 dB/s (OBS's 20 dB per
   1.7 s), a 1000 ms peak hold, and a 1500 ms clip latch so one clipped frame
   cannot be invisible. dt comes from the frame clock, never assumed to be 16.7,
   because the hidden path runs slower and a constant would change the decay rate
   with visibility.

   fftSize 1024 IS WINDOW-vs-FRAME ARITHMETIC, not taste. Measured window
   durations at 48 kHz: 512 -> 10.67 ms, 1024 -> 21.33 ms, 2048 -> 42.67 ms. A
   60 fps frame is 16.67 ms. At 512 roughly 36% of the signal is never examined
   and transients vanish; at 1024 consecutive reads overlap by 4.7 ms so nothing
   is missed; at 2048 the same audio is counted across 2.5 frames and attacks
   smear. 1024 is the smallest size with no gap. The FFT FEED is the exception:
   metering while hidden is pointless but the feed still matters, so it steps up
   to 2048 when OpenLiveClock reports its 30 fps timer mode.

   ONE BUS IS REAL AND TWO ARE NOT — AND THAT IS DELIBERATE.
   openlive-phase.js implements compositionFft, externalFft and entityFft and
   they are verified against a synthetic spectrum. Only `external` can be
   honestly sourced today: the application produces NO program audio at all —
   zero createMediaElementSource, zero `new Audio(`, zero <audio>/<video>
   elements anywhere in the project, clips are DXV decoded to canvas with no
   audio path, and openlive-capture.js requests audio:false. A composition bus
   today would be an analyser wired to silence, which is the same class of lie as
   the invented device list. So composition and entity are ABSENT, not zeroed.
   That distinction is load-bearing: fftPhase HOLDS the last phase on a missing
   bus and raises _degraded, whereas a bus present and reading zero decays over
   Fallback and slams every audio-reactive parameter to its in point.

   COST, MEASURED, AGAINST A 16,700 us BUDGET: one FFT bus 112 us (0.67%), two
   buses 169 us, the whole stereo meter frame 22 us (0.13%). This is free next to
   the 100-600 ms pixel-class effects already documented in this project.

   RULES THIS FILE KEEPS
     * Nothing at load. No enumerate, no getUserMedia, no AudioContext until
       something asks — and getUserMedia only ever from a user gesture.
     * Nothing throws at a caller. devices(), levels(), spectrum() and buses()
       are synchronous, total, and wrapped; the async entry points reject with a
       NAMED reason. A denied permission costs metering, not the page.
     * ONE AudioContext, shared with openlive-clock.js. See ensureContext().

   Classic script, no libraries, no ESM. Publishes window.OpenLiveAudio.
   Depends on nothing; cooperates with openlive-clock.js when it is present.
   =========================================================================== */
window.OpenLiveAudio = (() => {
  'use strict';

  /* ================= constants, all of them measured ================= */
  const METER_FFT = 1024;      /* 21.33 ms at 48k — the smallest window with no frame gap */
  const FEED_FFT = 1024;       /* 512 bins, 46.875 Hz each at 48 kHz */
  const FEED_FFT_HIDDEN = 2048;/* 33.3 ms frames on the clock's timer path need 42.67 ms */
  const FEED_SMOOTH = 0.7;     /* smoothing DOES apply to getByteFrequencyData; free fast-attack/slow-decay */
  const DECAY_DB_S = 11.8;     /* OBS: 20 dB per 1.7 s */
  const PEAK_HOLD_MS = 1000;
  const CLIP_LATCH_MS = 1500;
  const CLIP_AT = 0.99;
  const FLOOR_DB = -60;        /* the meter scale: -60..0 dBFS, what an operator reads */
  const NOISE_FLOOR = 0.0005;  /* below this, "identical channels" means nothing */
  const MONO_FRAMES = 30;      /* consecutive bit-identical frames before we call it mono */
  const SILENT_MS = 2500;      /* armed, not muted, and still exactly zero */
  const REC_MS = 3000;         /* long enough for a short sentence; 2 s felt clipped */
  const REC_SLICE = 250;       /* real ondataavailable ticks ~300 ms apart — progress from the recorder itself */

  /* ================= tiny helpers ================= */
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const str = v => String(v == null ? '' : v);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const mediaDevices = () => {
    try { return (typeof navigator !== 'undefined' && navigator.mediaDevices) || null; }
    catch (e) { return null; }
  };
  const canGUM = () => { const m = mediaDevices(); return !!(m && typeof m.getUserMedia === 'function'); };
  const canEnum = () => { const m = mediaDevices(); return !!(m && typeof m.enumerateDevices === 'function'); };
  const Ctx = () => window.AudioContext || window.webkitAudioContext;

  /* A level in linear amplitude drawn on a -60..0 dBFS scale. RMS never reaches
     1.0 on real material, so a linear bar sits at 70% while the converter is
     hard-clipping; dBFS is honest at both ends. */
  function toDisplay(v) {
    if (!(v > 0)) return 0;
    return clamp01((20 * Math.log10(v) - FLOOR_DB) / -FLOOR_DB);
  }
  function toDb(v) { return v > 0 ? 20 * Math.log10(v) : -Infinity; }

  /* ================= module state ================= */
  let ctx = null;              /* THE AudioContext. One. See ensureContext(). */
  let wantRate = 0;            /* 0 = let the device choose; otherwise 44100 | 48000 */
  let meterIn = null;          /* everything metered lands here; never reaches destination */
  let splitter = null, anL = null, anR = null;
  let timeL = null, timeR = null;

  let stream = null, micSrc = null, micTrack = null;
  let armedId = null, armedLabel = '', armedRequested = null;

  let feedTap = null;          /* L | R | summed, per the External FFT Input selector */
  let feedAnalyser = null, feedData = null;
  let fftGainPct = 100;
  let fftSourceWhich = 'sum';

  let testNodes = null, testTimer = 0;
  let recorder = null, recChunks = null, recStopped = null, recTimer = 0, recStartedAt = 0, recTicks = 0;
  let lastBlob = null, lastBlobFacts = null, lastBlobUrl = '';
  let playEl = null, playSrc = null;   /* createMediaElementSource is once-per-element: build once, swap src */

  let outputId = 'output:default', appliedSink = '', outputRoute = null;
  let testPreparing = false, testRequest = 0, cancelSpeakerTest = null;

  let deviceCache = null;      /* last enumerate result, normalised */
  let deviceState = 'idle';    /* idle | pending | placeholder | named | unsupported | error */
  let deviceReason = '';
  let permState = 'unknown';   /* unknown | prompt | granted | denied | unsupported */
  let unopenable = Object.create(null);  /* deviceIds that answered OverconstrainedError */
  let devicechangeBound = false;

  const changeSubs = [];
  const levelSubs = [];
  let loopStop = null, loopRaf = 0, looping = false;

  /* meter ballistics — held in LINEAR amplitude and mapped to dB only at read
     time, because a dB-normalised value decayed by a linear factor would fall
     far faster at the top of the scale than at the bottom. */
  const meter = {
    l: 0, r: 0, mono: false, armed: false,
    rmsL: 0, rmsR: 0, peakL: 0, peakR: 0, inputPeakL: 0, inputPeakR: 0,
    dbL: -Infinity, dbR: -Infinity,
    clipL: false, clipR: false,
    source: 'none', muted: false, signal: 'idle', reason: ''
  };
  let holdL = 0, holdR = 0, pkL = 0, pkR = 0, pkAtL = 0, pkAtR = 0, clipAtL = 0, clipAtR = 0;
  let sampledAt = 0, identicalRun = 0, deadRRun = 0, declaredMono = false, lastSignalAt = 0;

  function notify(list, payload) {
    for (let i = 0; i < list.length; i++) {
      /* One subscriber throwing must never take metering down with it — that is
         exactly how a bad status line freezes a projector feed. */
      try { list[i](payload); } catch (err) {
        if (window.console && console.error) console.error('OpenLiveAudio subscriber failed', err);
      }
    }
  }

  /* ================= the context =================
     ONE context for the whole app. openlive-clock.js also needs a running
     AudioContext — it is what keeps background timers out of Chrome's 1 Hz idle
     bucket so the frame clock survives the window being backgrounded — and two
     competing contexts would mean two output devices to route, two sample rates
     to reconcile and two things to resume from one gesture. So this module owns
     the context and DONATES it: OpenLiveClock.useContext() adopts it and closes
     whatever silent one it had made. If that method is missing (an older cached
     clock) we do not force the issue; the clock keeps its own and the only cost
     is one extra silent context, which is stated in support().reason rather than
     hidden.

     Not created at load: browsers start a context outside a user gesture in the
     'suspended' state and print a console warning, so it is built on the first
     arm/test/playback — all of which are clicks — and resume() is called there. */
  function ensureContext() {
    if (ctx) return ctx;
    const C = Ctx();
    if (!C) return null;
    try {
      ctx = wantRate ? new C({ sampleRate: wantRate, latencyHint: 'interactive' })
                     : new C(window.OpenLiveAudioOutput?.contextOptions() || { latencyHint: 'interactive' });
    } catch (err) {
      /* An unsupported explicit rate must not cost the whole audio engine. */
      try { ctx = new C(); } catch (err2) { ctx = null; return null; }
    }
    outputRoute = window.OpenLiveAudioOutput?.create(ctx) || null;
    buildMeterGraph();
    try {
      const K = window.OpenLiveClock;
      if (K && typeof K.useContext === 'function') K.useContext(ctx);
    } catch (err) {}
    /* A remembered output device is re-applied to the new context, or the sink
       silently reverts to the system default every time the rate changes. */
    if (appliedSink) {
      if(outputRoute) outputRoute.configure(Object.assign({},window.OpenLiveAudioOutput.settings(),{deviceId:outputId}));
      else applySink(appliedSink);
    }
    return ctx;
  }

  function resumeContext() {
    const c = ensureContext();
    if (!c) return Promise.reject(new Error('WebAudio is unavailable in this browser'));
    if (c.state === 'suspended') { try { return c.resume().then(() => c); } catch (err) {} }
    return Promise.resolve(c);
  }

  function resumeOutput() {
    return resumeContext().then(async c => {
      const route = outputRoute;
      if(route){
        await route.ready();
        if(ctx!==c || outputRoute!==route)throw namedError('OutputChanged','The audio player changed while selecting its output. Try playback again.');
        const status=route.status();
        if(!status.enabled)throw namedError('OutputUnavailable',status.reason || 'Local audio output is disabled. Choose an output in Audio Preferences.');
      }
      return c;
    });
  }

  /* meterIn is an explicit 2-channel speakers-interpretation gain node, and it
     exists because ChannelSplitterNode.channelInterpretation is IMMUTABLE:
     assigning 'speakers' throws InvalidStateError, its mode is 'discrete', so a
     1-channel input reaching the splitter directly would leave output 1 dead
     silent. Up-mixing here makes mono duplicate — which is what Chromium does
     anyway — and mono is then DETECTED rather than drawn as stereo. */
  function buildMeterGraph() {
    if (!ctx || meterIn) return;
    meterIn = ctx.createGain();
    meterIn.gain.value = 1;
    meterIn.channelCount = 2;
    meterIn.channelCountMode = 'explicit';
    meterIn.channelInterpretation = 'speakers';
    splitter = ctx.createChannelSplitter(2);
    anL = ctx.createAnalyser();
    anR = ctx.createAnalyser();
    [anL, anR].forEach(a => {
      a.fftSize = METER_FFT;
      a.smoothingTimeConstant = 0;   /* inert for time-domain data anyway; see header */
    });
    meterIn.connect(splitter);
    splitter.connect(anL, 0);
    splitter.connect(anR, 1);
    timeL = new Float32Array(METER_FFT);
    timeR = new Float32Array(METER_FFT);
  }

  function readTime(a, out) {
    if (!a) return false;
    try {
      if (typeof a.getFloatTimeDomainData === 'function') { a.getFloatTimeDomainData(out); return true; }
    } catch (err) {}
    /* Byte fallback only for engines without the float read; 8-bit resolution is
       a worse meter but an honest one. */
    try {
      const b = new Uint8Array(a.fftSize);
      a.getByteTimeDomainData(b);
      for (let i = 0; i < b.length; i++) out[i] = (b[i] - 128) / 128;
      return true;
    } catch (err) { return false; }
  }

  /* ================= sampling and ballistics =================
     Pull-based on purpose. index.html builds its phase clock once per frame and
     asks for buses(); preferences.html subscribes to onLevel and gets a loop.
     Both routes land here, and the guard makes a second call in the same frame
     free instead of double-decaying the meter. */
  function sample(force) {
    const t = nowMs();
    if (!force && sampledAt && t - sampledAt < 3) return meter;
    /* dt from the real clock, never assumed: the hidden path runs at 30 fps and
       a hardcoded 16.7 would change the decay RATE with window visibility. */
    let dt = sampledAt ? t - sampledAt : 16.7;
    if (!(dt > 0)) dt = 16.7;
    if (dt > 500) dt = 500;
    sampledAt = t;

    const live = !!(anL && anR && (stream || testNodes || (playEl && !playEl.paused)));
    let rmsL = 0, rmsR = 0, peakL = 0, peakR = 0, identical = true;

    if (live && readTime(anL, timeL) && readTime(anR, timeR)) {
      const n = timeL.length;
      let sL = 0, sR = 0;
      for (let i = 0; i < n; i++) {
        const a = timeL[i], b = timeR[i];
        sL += a * a; sR += b * b;
        const aa = a < 0 ? -a : a, ab = b < 0 ? -b : b;
        if (aa > peakL) peakL = aa;
        if (ab > peakR) peakR = ab;
        if (identical && a !== b) identical = false;
      }
      rmsL = Math.sqrt(sL / n);
      rmsR = Math.sqrt(sR / n);
    } else {
      identical = false;
    }

    /* Instant attack, linear-in-dB decay. 10^(-11.8*dt/20000) is 0.9776 at
       16.7 ms, and 0.9776^60 = 0.2566 = -11.8 dB over one second. */
    const fall = Math.pow(10, (-DECAY_DB_S * dt) / 20000);
    holdL = Math.max(rmsL, holdL * fall);
    holdR = Math.max(rmsR, holdR * fall);

    /* Peak marker: true sample peak, held then decayed at the same rate. The gap
       between it and the bar is the crest factor — 0.7071 for a sine, ~1.0 for
       something clipped — and a marker pinned far above the bar is a compressed
       or clipped source. */
    if (peakL >= pkL) { pkL = peakL; pkAtL = t; } else if (t - pkAtL > PEAK_HOLD_MS) pkL *= fall;
    if (peakR >= pkR) { pkR = peakR; pkAtR = t; } else if (t - pkAtR > PEAK_HOLD_MS) pkR *= fall;
    if (peakL >= CLIP_AT) clipAtL = t;
    if (peakR >= CLIP_AT) clipAtR = t;

    /* MONO. track.getSettings() lied here — it reported channelCount 2 on a
       device constrained to exactly 1 — so the claim is only ever a hint and the
       buffers are compared as well. Also covers the inferred discrete-up-mix
       case where R would read exactly 0 forever. */
    const loud = Math.max(peakL, peakR) > NOISE_FLOOR;
    if (loud) identicalRun = identical ? identicalRun + 1 : 0;
    /* The inferred discrete-up-mix signature: L clearly above the floor while R
       reads EXACTLY zero, frame after frame. A single silent frame on a stereo
       track is not mono, so it has to be a run. */
    if (loud) deadRRun = (peakL > NOISE_FLOOR && peakR === 0) ? deadRRun + 1 : 0;
    meter.mono = declaredMono || identicalRun >= MONO_FRAMES || deadRRun >= MONO_FRAMES;

    meter.rmsL = rmsL; meter.rmsR = rmsR;
    meter.inputPeakL = peakL; meter.inputPeakR = peakR;
    meter.peakL = pkL; meter.peakR = pkR;
    meter.l = toDisplay(holdL);
    meter.r = toDisplay(holdR);
    meter.dbL = toDb(holdL); meter.dbR = toDb(holdR);
    meter.clipL = t - clipAtL < CLIP_LATCH_MS;
    meter.clipR = t - clipAtR < CLIP_LATCH_MS;
    meter.armed = !!stream;
    meter.source = testNodes ? 'test' : (playEl && !playEl.paused) ? 'playback' : stream ? 'input' : 'none';
    meter.muted = !!(micTrack && micTrack.muted);
    if (loud) lastSignalAt = t;

    /* A granted permission is not a working microphone. Measured on this
       machine: readyState 'live', muted TRUE, and exactly 0.000000 across 134
       consecutive frames on both channels. An empty meter with no explanation
       makes the operator blame the app. */
    if (!stream && !testNodes && meter.source !== 'playback') meter.signal = 'idle';
    else if (meter.muted) meter.signal = 'muted';
    else if (loud) meter.signal = 'signal';
    else if (lastSignalAt && t - lastSignalAt < SILENT_MS) meter.signal = 'signal';
    else meter.signal = 'silent';

    refreshFeed();
    return meter;
  }

  /* The feed analyser's byte array is refreshed here, once per sample, so that
     whatever reads buses() during the frame sees the CURRENT spectrum. The array
     is allocated once per size and reused forever: a fresh allocation per read
     measured +5.6 us per call plus GC pressure, and openlive-phase reads it
     synchronously, so reuse is safe. */
  function refreshFeed() {
    if (!feedAnalyser) return;
    const want = hiddenFeed() ? FEED_FFT_HIDDEN : FEED_FFT;
    if (feedAnalyser.fftSize !== want) {
      try { feedAnalyser.fftSize = want; feedData = new Uint8Array(feedAnalyser.frequencyBinCount); }
      catch (err) {}
    }
    if (!feedData || feedData.length !== feedAnalyser.frequencyBinCount) {
      feedData = new Uint8Array(feedAnalyser.frequencyBinCount);
    }
    try { feedAnalyser.getByteFrequencyData(feedData); } catch (err) {}
  }
  function hiddenFeed() {
    try {
      const K = window.OpenLiveClock;
      return !!(K && typeof K.mode === 'function' && K.mode() === 'timer');
    } catch (err) { return false; }
  }

  /* The loop exists only while something needs it. index.html never subscribes —
     it pulls from its own frame — so a page that only feeds the phase engine
     pays for no extra rAF at all. */
  function loopWanted() { return !!(levelSubs.length && (stream || testNodes || (playEl && !playEl.paused))); }
  /* Wrapped, and the rearm happens whatever the outcome. An unwrapped throw here
     would not merely drop one frame: it would leave the rAF id set with no
     callback scheduled, so startLoop() would take its early return forever and
     metering would be dead for the life of the page. */
  function tick() {
    try { sample(true); } catch (err) {
      if (window.console && console.error) console.error('OpenLiveAudio sample failed', err);
    }
    notify(levelSubs, meter);
  }
  function startLoop() {
    if (loopStop || looping) return;
    looping = true;
    const K = window.OpenLiveClock;
    if (K && typeof K.onFrame === 'function') { loopStop = K.onFrame(tick); return; }
    const step = () => {
      if (!looping) return;
      try { tick(); } finally { if (looping) loopRaf = requestAnimationFrame(step); }
    };
    loopRaf = requestAnimationFrame(step);
  }
  function stopLoop() {
    looping = false;
    if (loopStop) { try { loopStop(); } catch (err) {} loopStop = null; }
    if (loopRaf) { cancelAnimationFrame(loopRaf); loopRaf = 0; }
  }
  function syncLoop() { if (loopWanted()) startLoop(); else stopLoop(); }

  /* ================= permission ================= */
  function permissionState() {
    if (!canGUM()) { permState = 'unsupported'; return Promise.resolve(permState); }
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve(permState);
    /* Some engines THROW synchronously on an unrecognised permission name rather
       than rejecting — measured for 'speaker-selection' here — so the call is
       wrapped as well as caught. */
    let q;
    try { q = navigator.permissions.query({ name: 'microphone' }); }
    catch (err) { return Promise.resolve(permState); }
    if (!q || typeof q.then !== 'function') return Promise.resolve(permState);
    return q
      .then(p => {
        permState = p.state;
        /* The user can flip this in site settings while the page is open, and a
           list that stays anonymous after they allow it looks broken. */
        try { p.onchange = () => { permState = p.state; refresh(); }; } catch (err) {}
        return permState;
      })
      .catch(() => permState);
  }

  /* ================= devices =================
     enumerateDevices is async and devices() must be synchronous and total, so
     the cache is what devices() returns and a refresh is kicked off behind it —
     the same shape as openlive-displays.list(). */
  function fallbackDevices(reason) {
    return {
      state: deviceState,
      permission: permState,
      complete: false,
      reason: reason || deviceReason,
      inputs: [
        { id: 'none', label: 'None', available: true, complete: true, kind: 'audioinput', isNone: true },
        { id: 'input:default', label: 'System Default (name hidden)', available: canGUM(),
          complete: false, kind: 'audioinput', isDefault: true,
          reason: 'The browser will not name audio devices until microphone access is allowed.' }
      ],
      outputs: [
        { id: 'output:default', label: 'System Default Output', available: true, complete: false,
          kind: 'audiooutput', isDefault: true,
          reason: 'Routing to the default sink needs no permission; naming the other outputs does.' }
      ]
    };
  }

  /* Dedupe by groupId, keeping the non-alias label. 'default' and
     'communications' share a groupId with the physical row they alias, so
     without this the 8 measured inputs read as 8 devices when there are 3. */
  function collapse(rows, kind, prefix) {
    const byGroup = Object.create(null);
    const out = [];
    rows.forEach(item => {
      const id = str(item.deviceId);
      if (!id) return;                       /* the anonymous placeholder — not openable */
      if (id === 'default' || id === 'communications') return;  /* handled as the explicit default row */
      const g = str(item.groupId) || ('g:' + id);
      if (byGroup[g]) return;
      byGroup[g] = true;
      out.push({
        id: prefix + id,
        deviceId: id,
        groupId: str(item.groupId),
        kind: kind,
        label: str(item.label) || 'Unnamed device',
        available: !unopenable[id],
        complete: true,
        reason: unopenable[id]
          ? 'This device is listed but refused to open (OverconstrainedError). Enumeration is a catalogue, not a guarantee.'
          : ''
      });
    });
    return out;
  }

  function buildDevices(list) {
    const ins = list.filter(d => d.kind === 'audioinput');
    const outs = list.filter(d => d.kind === 'audiooutput');
    const named = ins.some(d => d.deviceId) || outs.some(d => d.deviceId);
    deviceState = named ? 'named' : (ins.length || outs.length) ? 'placeholder' : 'named';

    const inputs = [{ id: 'none', label: 'None', available: true, complete: true, kind: 'audioinput', isNone: true }];
    const outputs = [];

    if (ins.length) {
      inputs.push({
        id: 'input:default',
        label: named ? 'System Default Input' : 'System Default (name hidden)',
        available: canGUM(), complete: named, kind: 'audioinput', isDefault: true,
        reason: named ? '' : 'Audio input devices are present but the browser will not name them until microphone access is allowed.'
      });
      collapse(ins, 'audioinput', 'media:input:').forEach(d => inputs.push(d));
    }

    outputs.push({
      id: 'output:default',
      label: named ? 'System Default Output' : 'System Default Output (other outputs hidden)',
      available: true, complete: named, kind: 'audiooutput', isDefault: true,
      reason: named ? '' : 'Output names are gated behind the microphone permission; routing to the default sink is not.'
    });
    collapse(outs, 'audiooutput', 'media:output:').forEach(d => outputs.push(d));
    outputs.push({ id: 'none', label: 'None', available: true, complete: true, kind: 'audiooutput', isNone: true });

    deviceReason =
      deviceState === 'placeholder'
        ? (permState === 'denied'
            ? 'Microphone access was denied. The page cannot ask again. Re-allow it in the browser’s site settings. Until then the device names, ids and the true device COUNT are all hidden; the one row per kind that enumeration returns is a placeholder, not a device.'
            : 'Audio devices are present but the browser will not name them until you allow microphone access. Choose Arm Input to ask.')
        : deviceState === 'named'
          ? (inputs.length > 1 || outputs.length > 2
              ? 'Enumerated from the operating system. Aliases (default / communications) are folded into the device they alias.'
              : 'No audio devices of this kind were enumerated.')
          : '';

    return {
      state: deviceState,
      permission: permState,
      complete: deviceState === 'named',
      reason: deviceReason,
      inputs: inputs,
      outputs: outputs
    };
  }

  function bindDeviceChange() {
    if (devicechangeBound) return;
    const m = mediaDevices();
    if (!m || typeof m.addEventListener !== 'function') return;
    devicechangeBound = true;
    /* Measured present: ondevicechange exists and the listener binds. Hot-plug is
       observable, so the list refreshes itself rather than needing the button. */
    try { m.addEventListener('devicechange', () => refresh()); } catch (err) { devicechangeBound = false; }
  }

  let refreshing = null;
  function refresh() {
    if (!canEnum()) {
      deviceState = 'unsupported';
      deviceReason = 'This browser cannot enumerate media devices.';
      deviceCache = fallbackDevices();
      notify(changeSubs, deviceCache);
      return Promise.resolve(deviceCache);
    }
    if (refreshing) return refreshing;
    if (deviceState === 'idle') deviceState = 'pending';
    bindDeviceChange();
    refreshing = permissionState()
      .then(() => navigator.mediaDevices.enumerateDevices())
      .then(list => {
        deviceCache = buildDevices(list || []);
        notify(changeSubs, deviceCache);
        return deviceCache;
      })
      .catch(err => {
        deviceState = 'error';
        deviceReason = 'Device enumeration failed: ' + (err && err.message || err);
        deviceCache = fallbackDevices();
        notify(changeSubs, deviceCache);
        return deviceCache;
      })
      .then(result => { refreshing = null; return result; });
    return refreshing;
  }

  function devices() {
    try {
      if (deviceCache) return deviceCache;
      if (deviceState === 'idle') { deviceState = 'pending'; refresh(); }
      return fallbackDevices('Enumerating… the list will fill in a moment.');
    } catch (err) {
      return fallbackDevices('Device list unavailable: ' + (err && err.message || err));
    }
  }

  /* ================= arming ================= */
  function constraintFor(id) {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const raw = str(id);
    if (!raw || raw === 'none' || raw === 'input:default') return base;   /* {audio:base} opens the system default */
    if (raw.indexOf('media:input:') === 0) {
      const dev = raw.slice(12);
      if (dev) return Object.assign({ deviceId: { exact: dev } }, base);
    }
    return base;
  }

  function wireInput() {
    if (!ctx || !stream) return;
    micSrc = ctx.createMediaStreamSource(stream);
    micSrc.connect(meterIn);

    /* The External FFT Input selector is honoured rather than ignored:
       Input 1 -> splitter output 0, Input 2 -> output 1, "1 / 2" -> an explicit
       summing node. A bare AnalyserNode's implicit down-mix was not measured, so
       the sum is made explicitly instead of assumed. */
    feedAnalyser = ctx.createAnalyser();
    feedAnalyser.fftSize = FEED_FFT;
    feedAnalyser.smoothingTimeConstant = FEED_SMOOTH;
    feedData = new Uint8Array(feedAnalyser.frequencyBinCount);
    feedTap = ctx.createGain();
    feedTap.gain.value = 1;
    feedTap.channelCount = 1;
    feedTap.channelCountMode = 'explicit';
    feedTap.channelInterpretation = 'speakers';
    feedTap.connect(feedAnalyser);
    connectFeedSource();
  }

  function connectFeedSource() {
    if (!splitter || !feedTap) return;
    try { splitter.disconnect(feedTap); } catch (err) {}
    try {
      if (fftSourceWhich === 'l') splitter.connect(feedTap, 0);
      else if (fftSourceWhich === 'r') splitter.connect(feedTap, 1);
      else { splitter.connect(feedTap, 0); splitter.connect(feedTap, 1); }
    } catch (err) {}
  }

  function watchTrack(track) {
    if (!track) return;
    const bump = () => notify(changeSubs, devices());
    try {
      track.addEventListener('mute', bump);
      track.addEventListener('unmute', bump);
      /* The armed device disappearing mid-show is a device change, not a bug. */
      track.addEventListener('ended', () => { disarm(); refresh(); });
    } catch (err) {}
  }

  function arm(deviceId, opts) {
    const o = opts || {};
    const requested = str(deviceId || 'input:default');
    if (requested === 'none') return Promise.reject(namedError('NoDevice', 'No input device is selected.'));
    if (!canGUM()) return Promise.reject(namedError('Unsupported', 'This browser cannot capture audio input.'));
    if (stream && armedRequested === requested) return Promise.resolve(armedStatus());

    return (stream ? Promise.resolve(disarm()) : Promise.resolve())
      .then(() => resumeContext())
      .then(() => navigator.mediaDevices.getUserMedia({ audio: constraintFor(requested), video: false })
        .catch(err => {
          /* Measured on 4 of 8 real inputs: listed, and still refuses an exact
             deviceId. Retry unconstrained and report what actually opened rather
             than leaving the select claiming a device we are not on. */
          if (err && err.name === 'OverconstrainedError' && requested.indexOf('media:input:') === 0) {
            unopenable[requested.slice(12)] = true;
            return navigator.mediaDevices.getUserMedia({ audio: constraintFor('input:default'), video: false });
          }
          throw err;
        }))
      .then(s => {
        stream = s;
        micTrack = (s.getAudioTracks && s.getAudioTracks()[0]) || null;
        armedRequested = requested;
        armedLabel = micTrack ? (micTrack.label || 'Unnamed input') : 'Unnamed input';
        armedId = micTrack && micTrack.getSettings ? ('media:input:' + str(micTrack.getSettings().deviceId)) : requested;
        /* getSettings() reported channelCount 2 on a device constrained to
           exactly 1, so this is a HINT that starts the mono case — never the
           whole answer. sample() keeps checking the buffers. */
        let claimed = 0;
        try { claimed = num(micTrack && micTrack.getSettings && micTrack.getSettings().channelCount, 0); } catch (err) {}
        declaredMono = claimed === 1;
        identicalRun = 0; deadRRun = 0; lastSignalAt = 0;
        wireInput();
        watchTrack(micTrack);
        syncLoop();
        /* Names become readable the moment the permission lands. */
        refresh();
        if (o.silent !== true) notify(changeSubs, devices());
        return armedStatus();
      })
      .catch(err => {
        stream = null; micTrack = null; armedRequested = null;
        permState = (err && err.name === 'NotAllowedError') ? 'denied' : permState;
        throw namedError(err && err.name || 'Error', errorText(err));
      });
  }

  function errorText(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError') return 'Microphone access was denied. The page cannot ask again. Re-allow it in the browser’s site settings.';
    if (n === 'NotFoundError') return 'No audio input device is attached.';
    if (n === 'NotReadableError') return 'The audio device is in use by another application.';
    if (n === 'OverconstrainedError') return 'That device is listed but refused to open.';
    return (err && err.message) || 'Could not open the audio input.';
  }
  function namedError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  function armedStatus() {
    return {
      armed: !!stream,
      id: armedId,
      requested: armedRequested,
      label: armedLabel,
      muted: !!(micTrack && micTrack.muted),
      readyState: micTrack ? micTrack.readyState : 'ended',
      channelCount: (() => { try { return num(micTrack.getSettings().channelCount, 0); } catch (e) { return 0; } })(),
      sampleRate: ctx ? ctx.sampleRate : 0,
      declaredMono: declaredMono
    };
  }

  function disarm() {
    try {
      if (micSrc) { try { micSrc.disconnect(); } catch (err) {} micSrc = null; }
      if (feedTap) { try { feedTap.disconnect(); } catch (err) {} feedTap = null; }
      feedAnalyser = null; feedData = null;
      if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch (err) {} }
      if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (err) {} });
    } catch (err) {}
    stream = null; micTrack = null; armedId = null; armedRequested = null; armedLabel = '';
    declaredMono = false; identicalRun = 0; deadRRun = 0;
    holdL = holdR = pkL = pkR = 0;
    meter.l = meter.r = 0; meter.rmsL = meter.rmsR = 0;
    meter.peakL = meter.peakR = meter.inputPeakL = meter.inputPeakR = 0;
    meter.mono = false; meter.armed = false;
    meter.signal = 'idle'; meter.muted = false; meter.source = testNodes ? 'test' : 'none';
    syncLoop();
    notify(levelSubs, meter);
    return armedStatus();
  }

  /* ================= the FFT feed =================
     Buses are ABSENT when there is nothing real to put in them. openlive-phase
     holds the last phase on a missing bus and raises _degraded; a bus present
     and reading zero decays over Fallback and pins every audio-reactive
     parameter to its in point. Handing over an analyser wired to silence would
     defeat that logic, so composition and entity are simply not there. */
  const externalBus = { spectrum: null, sampleRate: 48000, minDecibels: -100, maxDecibels: -30, gain: 0 };
  const busSet = { external: null };

  /* 0% .. 200% on the preferences slider expressed as the dB the phase engine
     wants. 0% is floored rather than -Infinity, which would be NaN downstream. */
  function gainDb() {
    const pct = num(fftGainPct, 100);
    if (pct <= 0.5) return -60;
    return 20 * Math.log10(pct / 100);
  }

  function buses() {
    try {
      if (!feedAnalyser || !stream) return null;   /* ABSENT, never zeroed */
      sample(false);
      if (!feedData) return null;
      externalBus.spectrum = feedData;
      externalBus.sampleRate = ctx ? ctx.sampleRate : 48000;
      externalBus.minDecibels = feedAnalyser.minDecibels;
      externalBus.maxDecibels = feedAnalyser.maxDecibels;
      externalBus.gain = gainDb();
      busSet.external = externalBus;
      return busSet;
    } catch (err) { return null; }
  }

  function spectrum(bus) {
    try {
      const which = str(bus || 'external').toLowerCase();
      if (which === 'external') {
        if (!feedAnalyser || !stream) return null;
        sample(false);
        return feedData || null;
      }
      /* Not a missing analyser — a missing SOURCE. This application produces no
         program audio and no clip audio at all: clips are DXV decoded to canvas,
         capture requests audio:false, and the only sound it makes is the
         metronome click. There is literally nothing to analyse, so null is the
         true answer and a zeroed array would be a lie the phase engine would act
         on. Each .mov ships with a paired .wav (18 files, all verified playable
         and genuinely stereo), so both buses become real the day clip audio does. */
      return null;
    } catch (err) { return null; }
  }

  /* ================= output routing ================= */
  function sinkFor(id) {
    const raw = str(id || 'output:default');
    if (raw === 'output:default' || raw === 'none' || !raw) return 'default';
    if (raw.indexOf('media:output:') === 0) return raw.slice(13);
    return 'default';
  }

  function applySink(sinkId) {
    if (!ctx || typeof ctx.setSinkId !== 'function') return Promise.resolve(false);
    return ctx.setSinkId(sinkId).then(() => true).catch(() => false);
  }

  function setOutputDevice(id) {
    const target = str(id || 'output:default');
    const sink = sinkFor(target);
    /* Recording the choice must not START the engine. A page restoring a stored
       preference at load would otherwise construct an AudioContext outside a
       user gesture, which browsers start suspended and warn about. The intent is
       kept and ensureContext() applies it when the engine really does start. */
    if (!ctx) {
      outputId = target; appliedSink = sink;
      return Promise.resolve({ ok: true, applied: false, deferred: true, supported: true,
        sinkId: sink, requested: target,
        reason: 'Recorded. It is applied to the audio engine the first time it starts.' });
    }
    const c = ctx;
    if(outputRoute){
      const route=outputRoute;
      return route.configure(Object.assign({},window.OpenLiveAudioOutput.settings(),{deviceId:target}),{retry:true}).then(result=>{
        if(ctx===c&&outputRoute===route&&!result.superseded&&!result.disposed){outputId=target;appliedSink=result.sinkId;}
        return result;
      });
    }
    if (typeof c.setSinkId !== 'function') {
      /* Honest false: the choice is remembered so the UI can still show it, but
         nothing is claimed to have moved. */
      outputId = target;
      return Promise.resolve({ ok: false, supported: false, sinkId: str(c.sinkId), requested: target,
        reason: 'This browser cannot route WebAudio to a chosen output device. Everything plays to the system default.' });
    }
    return c.setSinkId(sink)
      .then(() => {
        outputId = target; appliedSink = sink;
        return { ok: true, applied: true, supported: true, sinkId: sink, requested: target, reason: '' };
      })
      .catch(err => {
        /* Measured: a stale id rejects NotFoundError. A remembered device from a
           previous session does exactly this, so fall back to the default sink,
           re-enumerate, and say which device it actually used. */
        const why = err && err.name === 'NotFoundError'
          ? 'That output device is no longer attached.'
          : (err && err.message) || 'The output device could not be selected.';
        refresh();
        return c.setSinkId('default')
          .then(() => { outputId = 'output:default'; appliedSink = 'default';
            return { ok: false, supported: true, sinkId: 'default', requested: target,
              reason: why + ' Fell back to the system default output.' }; })
          .catch(() => ({ ok: false, supported: true, sinkId: str(c.sinkId), requested: target, reason: why }));
      });
  }

  /* ================= speaker test =================
     A short exponential sine SWEEP, left then right, through a ChannelMerger so
     each side lands on exactly one channel. Measured separation with the same
     splitter tapping the merger: left phase maxL 0.200 / maxR 0.000, right phase
     maxL 0.000 / maxR 0.200. No bleed at all.

     A sweep rather than a tone, and sequenced rather than simultaneous, because
     the failures worth catching are a SWAPPED pair and a DEAD side, and a steady
     tone detects neither — both a working system and a reversed one play a tone.
     A fixed sine also excites room modes, so it can be inaudible at one seat and
     painful at another; a rise averages across them. 420 -> 900 Hz sits above
     where laptop speakers roll off and below the harsh 2-5 kHz band, and it is
     obviously a test noise rather than something mistakable for programme audio.
     The 30 ms attack and 60 ms release exist because a hard gate on a 0.2
     amplitude sine clicks louder than the sweep itself.

     It is metered through the same splitter and drives the same L/R bars, which
     is what separates "the app is making no sound" from "my speakers are off" —
     the single most common support question. */
  function testSpeakers(opts) {
    const o = opts || {};
    const sideMs = num(o.sideMs, 500);
    const gapMs = num(o.gapMs, 120);
    const fromHz = num(o.fromHz, 420);
    const toHz = num(o.toHz, 900);
    const g = num(o.gain, 0.2);
    const stage = typeof o.onStage === 'function' ? o.onStage : () => {};

    if (testNodes || testPreparing) return Promise.reject(namedError('Busy', 'A speaker test is already running.'));
    const request=++testRequest;testPreparing=true;
    const cancelled=new Promise((_resolve,reject)=>{cancelSpeakerTest=()=>reject(namedError('Cancelled','The speaker test was cancelled.'));});
    const played=resumeOutput().then(c => {
      if(request!==testRequest)throw namedError('Cancelled','The speaker test was cancelled before its output was ready.');
      testPreparing=false;
      return new Promise((resolve, reject) => {
      let merger;
      try {
        merger = c.createChannelMerger(2);
        const made = [];
        [0, 1].forEach(side => {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = 'sine';
          const t0 = c.currentTime + 0.05 + side * ((sideMs + gapMs) / 1000);
          const t1 = t0 + sideMs / 1000;
          osc.frequency.setValueAtTime(fromHz, t0);
          osc.frequency.exponentialRampToValueAtTime(toHz, t1);
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(g, t0 + 0.03);
          gain.gain.setValueAtTime(g, t1 - 0.06);
          gain.gain.linearRampToValueAtTime(0, t1);
          osc.connect(gain);
          gain.connect(merger, 0, side);      /* input `side` of the merger IS that channel */
          osc.start(t0);
          osc.stop(t1 + 0.02);
          made.push(osc, gain);
        });
        merger.connect(outputRoute?.speaker || c.destination);
        if (meterIn) merger.connect(meterIn);
        testNodes = { merger: merger, made: made };
      } catch (err) { testNodes = null; return reject(namedError('TestFailed', (err && err.message) || 'The speaker test could not be started.')); }

      syncLoop();
      /* The side label has to be printed in sync with the audio or the user has
         no reference for which side SHOULD be sounding, and a swap is invisible. */
      const total = 100 + sideMs + gapMs + sideMs;
      try { stage({ stage: 'left', at: 0, total: total }); } catch (err) {}
      const rightAt = setTimeout(() => { try { stage({ stage: 'right', at: sideMs + gapMs, total: total }); } catch (err) {} }, 50 + sideMs + gapMs);
      testTimer = setTimeout(() => {
        clearTimeout(rightAt);
        stopTest(true);
        try { stage({ stage: 'done', at: total, total: total }); } catch (err) {}
        resolve({ ok: true, sinkId: str(ctx && ctx.sinkId) || 'default', durationMs: total,
                  fromHz: fromHz, toHz: toHz });
      }, total + 120);
      });
    });
    return Promise.race([played,cancelled]).finally(()=>{if(request===testRequest){testPreparing=false;cancelSpeakerTest=null;}});
  }

  function stopTest(completed=false) {
    const cancel=cancelSpeakerTest;cancelSpeakerTest=null;
    testRequest++;testPreparing=false;
    if(!completed)cancel?.();
    if (testTimer) { clearTimeout(testTimer); testTimer = 0; }
    if (!testNodes) return;
    try { testNodes.merger.disconnect(); } catch (err) {}
    (testNodes.made || []).forEach(n => { try { n.disconnect(); } catch (err) {} });
    testNodes = null;
    syncLoop();
  }

  /* ================= recording =================
     Measured mimeType support, identical in both engines:
       SUPPORTED  audio/webm, audio/webm;codecs=opus, audio/webm;codecs=pcm,
                  audio/mp4, audio/mp4;codecs=opus, audio/mp4;codecs=mp4a.40.2
       NOT        audio/ogg (any), audio/mpeg, audio/wav, audio/x-wav
     The list is filtered at runtime rather than hardcoded, because it differs
     across browsers and a bare constructor throw is a poor failure. */
  const REC_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=opus', 'audio/mp4', ''];
  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (let i = 0; i < REC_TYPES.length; i++) {
      const t = REC_TYPES[i];
      if (!t) return '';                    /* let the recorder choose */
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (err) {}
    }
    return null;
  }

  function startRecording(opts) {
    const o = opts || {};
    const maxMs = num(o.ms, REC_MS);
    const onTick = typeof o.onTick === 'function' ? o.onTick : () => {};
    if (typeof MediaRecorder === 'undefined') return Promise.reject(namedError('Unsupported', 'This browser cannot record audio.'));
    if (!stream) return Promise.reject(namedError('NotArmed', 'Arm an input before recording.'));
    if (recorder && recorder.state === 'recording') return Promise.reject(namedError('Busy', 'A recording is already running.'));
    const mime = pickMime();
    if (mime === null) return Promise.reject(namedError('Unsupported', 'No supported audio recording format is available.'));

    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
                      : new MediaRecorder(stream);
    } catch (err) { recorder = null; return Promise.reject(namedError('RecorderFailed', (err && err.message) || 'The recorder could not be created.')); }

    recChunks = [];
    recTicks = 0;
    recStartedAt = nowMs();
    let settle;
    recStopped = new Promise(res => { settle = res; });

    recorder.ondataavailable = e => {
      if (e.data && e.data.size) recChunks.push(e.data);
      recTicks++;
      /* Progress comes from the recorder's own timeslice, not a setInterval
         guessing alongside it — measured ticks at 302/601/902/1201/1501/1801 ms. */
      const at = nowMs() - recStartedAt;
      try { onTick({ at: at, total: maxMs, ticks: recTicks, bytes: recChunks.reduce((s, c) => s + c.size, 0) }); } catch (err) {}
    };
    recorder.onstop = () => {
      const type = recorder && recorder.mimeType || mime || 'audio/webm';
      lastBlob = new Blob(recChunks, { type: type });
      recChunks = null;
      if (recTimer) { clearTimeout(recTimer); recTimer = 0; }
      describeBlob(lastBlob).then(f => { lastBlobFacts = f; });
      settle(lastBlob);
    };
    recorder.onerror = () => { if (recTimer) { clearTimeout(recTimer); recTimer = 0; } settle(new Blob([], { type: 'audio/webm' })); };

    try { recorder.start(REC_SLICE); }
    catch (err) { recorder = null; return Promise.reject(namedError('RecorderFailed', (err && err.message) || 'The recorder refused to start.')); }

    recTimer = setTimeout(() => { try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (err) {} }, maxMs);
    /* `done` is how a caller waits for the take to FINISH. It has to be separate
       from stopRecording(), which STOPS it — awaiting stopRecording() to get the
       blob would end the recording the instant it began. */
    return Promise.resolve({ mimeType: recorder.mimeType || mime, maxMs: maxMs, startedAt: recStartedAt, done: recStopped });
  }

  /* Ends the take early, which is what a Stop button means. Resolves with the
     same blob `done` resolves with. */
  function stopRecording() {
    if (!recorder) return Promise.resolve(lastBlob);
    try { if (recorder.state === 'recording') recorder.stop(); } catch (err) {}
    return recStopped || Promise.resolve(lastBlob);
  }

  /* Decode facts rather than a spinner: "1.98 s, 2 ch, 48 kHz, 719 bytes" is
     checkable; a progress ring on a silent recording is not. A decode failure is
     reported as unreadable instead of playing nothing and looking fine. */
  function describeBlob(blob) {
    if (!blob || !blob.size) return Promise.resolve({ ok: false, reason: 'The recording is empty.' });
    const c = ensureContext();
    if (!c || typeof blob.arrayBuffer !== 'function') {
      return Promise.resolve({ ok: true, bytes: blob.size, type: blob.type, duration: 0, channels: 0, sampleRate: 0 });
    }
    return blob.arrayBuffer()
      .then(buf => c.decodeAudioData(buf))
      .then(b => ({ ok: true, bytes: blob.size, type: blob.type, duration: b.duration,
                    channels: b.numberOfChannels, sampleRate: b.sampleRate, samples: b.length }))
      .catch(err => ({ ok: false, bytes: blob.size, type: blob.type,
                       reason: 'The recording could not be decoded: ' + (err && err.message || err) }));
  }

  /* ================= playback =================
     TWO TRAPS, BOTH REAL AND BOTH MEASURED:
     1. createMediaElementSource REROUTES the element. The moment it is called
        the <audio> no longer reaches the speakers by itself, so the source node
        MUST also be connected to ctx.destination or playback is silent while
        every API call reports success. That is the classic way this ships broken.
     2. createMediaElementSource may be called ONCE per element; a second call
        throws InvalidStateError. So the element and its source node are built
        once and only el.src is swapped.
     The element's own sink is bypassed once it is inside the graph, so routing is
     done on the CONTEXT — one setSinkId moves the test, the playback and any
     future programme audio together. */
  function ensurePlayer() {
    const c = ensureContext();
    if (!c) return null;
    if (playEl) return playEl;
    playEl = new Audio();
    playEl.preload = 'auto';
    try {
      playSrc = c.createMediaElementSource(playEl);
      playSrc.connect(outputRoute?.speaker || c.destination);
      if (meterIn) playSrc.connect(meterIn);
    } catch (err) { playSrc = null; }
    return playEl;
  }

  function playRecording(opts) {
    const o = opts || {};
    const blob = o.blob || lastBlob;
    if (!blob || !blob.size) return Promise.reject(namedError('NoRecording', 'There is nothing recorded to play back.'));
    return resumeOutput().then(() => {
      const el = ensurePlayer();
      if (!el) return Promise.reject(namedError('Unsupported', 'Playback is unavailable in this browser.'));
      if (lastBlobUrl) { try { URL.revokeObjectURL(lastBlobUrl); } catch (err) {} }
      lastBlobUrl = URL.createObjectURL(blob);
      el.src = lastBlobUrl;
      return (lastBlobFacts ? Promise.resolve(lastBlobFacts) : describeBlob(blob)).then(facts => {
        lastBlobFacts = facts;
        return new Promise((resolve, reject) => {
          /* A promise that only ever settles on 'ended' is a promise that can
             hang: a blocked autoplay, a zero-length decode or a stalled element
             all leave it pending forever, and a caller that disabled its buttons
             while awaiting never gets them back. The watchdog is the decoded
             duration plus slack, so it is generous when the length is known and
             still bounded when it is not. */
          let settled = false;
          const stop = () => {
            settled = true;
            clearTimeout(guard);
            el.removeEventListener('ended', done);
            el.removeEventListener('error', fail);
            try { el.pause(); } catch (err) {}
            syncLoop();
          };
          const done = () => { if (settled) return; stop(); resolve(Object.assign({ ok: true }, facts)); };
          const fail = why => {
            if (settled) return;
            stop();
            reject(namedError('PlaybackFailed', why || 'The recording could not be played back.'));
          };
          const budget = (num(facts && facts.duration, 0) * 1000) + 3000;
          const guard = setTimeout(() => fail(
            'Playback did not finish. The element never reported the end of the clip. This usually indicates a blocked autoplay policy or an output device that is gone.'
          ), Math.max(5000, budget));
          el.addEventListener('ended', done);
          el.addEventListener('error', fail);
          const p = el.play();
          syncLoop();
          if (p && p.catch) p.catch(err => fail('The browser refused to start playback: ' + (err && err.message || err)));
        });
      });
    });
  }

  /* ================= lifecycle ================= */
  function shutdown() {
    stopTest();
    try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (err) {}
    if (recTimer) { clearTimeout(recTimer); recTimer = 0; }
    if (playEl) { try { playEl.pause(); } catch (err) {} }
    if (lastBlobUrl) { try { URL.revokeObjectURL(lastBlobUrl); } catch (err) {} lastBlobUrl = ''; }
    disarm();
    stopLoop();
  }
  window.addEventListener('pagehide', shutdown);

  /* ================= public surface ================= */
  return {
    version: 1,

    supported: function () { return !!(Ctx() && (canGUM() || canEnum())); },
    support: function () {
      let secure = true;
      try { secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : true; } catch (e) {}
      const K = window.OpenLiveClock;
      return {
        webaudio: !!Ctx(),
        getUserMedia: canGUM(),
        enumerate: canEnum(),
        record: typeof MediaRecorder !== 'undefined',
        setSinkIdContext: !!(Ctx() && Ctx().prototype && 'setSinkId' in Ctx().prototype),
        setSinkIdElement: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
        maxOutputChannels: ctx ? ctx.destination.maxChannelCount : 2,
        secureContext: secure,
        sharedClockContext: !!(K && typeof K.useContext === 'function'),
        reason: (K && typeof K.useContext !== 'function')
          ? 'openlive-clock.js has no useContext(); it keeps its own silent context, so two exist.'
          : ''
      };
    },

    permission: function () { return permState; },
    permissionState: permissionState,

    /* Synchronous, total, never empty. `complete:false` on an entry means the
       list may be short and unnamed — the same contract openlive-displays uses. */
    devices: devices,
    refresh: refresh,
    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      changeSubs.push(cb);
      bindDeviceChange();
      return function () { const i = changeSubs.indexOf(cb); if (i >= 0) changeSubs.splice(i, 1); };
    },

    /* Prompts once. MUST be called from a user gesture or the prompt is
       suppressed. Arming is what grants the permission, so the Arm button stays
       enabled in the 'prompt' state — it is the device LIST that is degraded,
       not the capability. */
    request: function () {
      if (!canGUM()) { permState = 'unsupported'; return Promise.resolve(devices()); }
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(s => {
          s.getTracks().forEach(t => { try { t.stop(); } catch (err) {} });
          permState = 'granted';
          return refresh();
        })
        .catch(err => {
          permState = (err && err.name === 'NotAllowedError') ? 'denied' : permState;
          return refresh();
        });
    },

    arm: arm,
    disarm: disarm,
    armed: function () { return !!stream; },
    armedStatus: armedStatus,

    /* {l, r, mono} plus instantaneous RMS/input peaks, held peak markers, clip
       latches and dB readings the bars and status line need. Never throws. */
    levels: function () { try { return sample(false); } catch (err) { return meter; } },
    onLevel: function (cb) {
      if (typeof cb !== 'function') return function () {};
      levelSubs.push(cb);
      syncLoop();
      return function () {
        const i = levelSubs.indexOf(cb);
        if (i >= 0) levelSubs.splice(i, 1);
        syncLoop();
      };
    },
    meterScale: function () { return { minDb: FLOOR_DB, maxDb: 0, fftSize: METER_FFT, decayDbPerSec: DECAY_DB_S }; },

    spectrum: spectrum,
    /* What app.js hands to PH.clock as `fft`. null when nothing is armed — the
       engine HOLDS on an absent bus and would SLAM on a zeroed one. */
    buses: buses,
    setFftGain: function (pct) { fftGainPct = Math.max(0, Math.min(200, num(pct, 100))); return fftGainPct; },
    fftGain: function () { return { percent: fftGainPct, db: gainDb() }; },
    /* 'l' | 'r' | 'sum', from the External Audio FFT Input selector. */
    setFftSource: function (which) {
      const w = str(which).toLowerCase();
      fftSourceWhich = w === 'l' || w === 'left' || w === 'input 1' ? 'l'
                     : w === 'r' || w === 'right' || w === 'input 2' ? 'r' : 'sum';
      connectFeedSource();
      return fftSourceWhich;
    },

    testSpeakers: testSpeakers,
    stopTest: stopTest,
    testing: function () { return !!testNodes || testPreparing; },

    startRecording: startRecording,
    stopRecording: stopRecording,
    /* The in-flight take's completion, for a caller that did not keep `done`. */
    recorded: function () { return recStopped || Promise.resolve(lastBlob); },
    recording: function () { return !!(recorder && recorder.state === 'recording'); },
    lastRecording: function () { return lastBlob ? { blob: lastBlob, facts: lastBlobFacts } : null; },
    describeRecording: function () { return lastBlob ? describeBlob(lastBlob) : Promise.resolve(null); },
    playRecording: playRecording,

    setOutputDevice: setOutputDevice,
    outputDevice: function () { return { id: outputId, sinkId: ctx ? str(ctx.sinkId) : appliedSink }; },

    /* Real, and the only one of the three output controls that is: an explicit
       rate is honoured by CONSTRUCTING the context at it. Refused while armed
       rather than silently ignored, because a context cannot change rate. */
    setSampleRate: function (rate) {
      const r = num(rate, 0);
      if (r === wantRate) return { ok: true, applied: ctx ? ctx.sampleRate : r, reason: '' };
      if (stream || testNodes || testPreparing) return { ok: false, applied: ctx ? ctx.sampleRate : 0,
        reason: 'The sample rate is fixed for the life of an audio context. Stop the input and the sound test first.' };
      /* Same rule as setOutputDevice: recording the preference must not build a
         context. With none open there is nothing to rebuild — the next one is
         constructed at this rate. */
      if (!ctx) { wantRate = r; return { ok: true, applied: r, deferred: true, reason: '' }; }
      wantRate = r;
      if (ctx) {
        if (playEl) { try { playEl.pause(); } catch (err) {} }
        outputRoute?.destroy(); outputRoute=null;
        try { ctx.close(); } catch (err) {}
        ctx = null; meterIn = null; splitter = null; anL = null; anR = null; playEl = null; playSrc = null;
      }
      const c = ensureContext();
      return { ok: !!c, applied: c ? c.sampleRate : 0, reason: c ? '' : 'WebAudio is unavailable.' };
    },
    context: function () { return ctx; },
    /* ctx.baseLatency is MEASURED. bufferSize/sampleRate is arithmetic on a
       control that changes nothing — the render quantum is fixed at 128 frames. */
    latency: function () {
      if (!ctx) return { ok: false, baseMs: 0, outputMs: 0, sampleRate: 0,
        reason: 'Not measurable until the audio engine starts.' };
      return {
        ok: true,
        baseMs: num(ctx.baseLatency, 0) * 1000,
        outputMs: num(ctx.outputLatency, 0) * 1000,
        sampleRate: ctx.sampleRate,
        maxChannels: ctx.destination.maxChannelCount,
        state: ctx.state,
        output: outputRoute?.status() || null,
        reason: ''
      };
    },

    status: function () {
      const d = devices();
      return {
        permission: permState,
        deviceState: d.state,
        reason: d.reason,
        armed: !!stream,
        armedLabel: armedLabel,
        muted: !!(micTrack && micTrack.muted),
        signal: meter.signal,
        mono: meter.mono,
        testing: !!testNodes || testPreparing,
        recording: !!(recorder && recorder.state === 'recording'),
        hasRecording: !!(lastBlob && lastBlob.size),
        buses: { composition: false, external: !!(feedAnalyser && stream), entity: false }
      };
    },

    shutdown: shutdown
  };
})();
