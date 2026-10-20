/* OpenLive Audio Preferences
   -------------------------------------------------------------------------
   Resolume-inspired device routing with honest browser capability boundaries.
   The selected output/input, FFT gain, SMPTE routes and VST registry are
   durable OpenLiveHub state shared by Arena, Workspace and utility windows.

   EVERY DEVICE NAME ON THIS TAB USED TO BE INVENTED. The lists were four
   hardcoded outputs and four hardcoded inputs — "Speakers (Realtek HD)",
   "ASIO — Focusrite USB", "Microphone (USB)", "Line In", "Focusrite USB Input" —
   and not one of them had ever been enumerated. They are now built from
   openlive-audio.js, which asks the operating system, folds the default /
   communications aliases into the devices they alias, and says plainly when the
   browser is withholding names rather than manufacturing "Audio Input 1".

   The meter is stereo and the ballistics are real (instant attack, 11.8 dB/s
   decay, peak hold, clip latch, a -60..0 dBFS scale), and a mono source is drawn
   as mono instead of as two identical bars that assert a stereo image the device
   does not have.

   The Sound Test is the Zoom check: a known sound out, a user-chosen short take
   in, then that same take back through the same output — with the L/R bars live
   the whole way, because those bars are what make the verdict decidable.
   ------------------------------------------------------------------------- */
(() => {
  'use strict';

  const Hub = window.OpenLiveHub;
  if (!Hub || !document.querySelector('[data-audio-managed]')) return;
  /* Optional on purpose: an old cached page without the module must still show
     its stored settings rather than throwing on load. Everything that touches OA
     is guarded, and the status lines say when it is missing. */
  const OA = window.OpenLiveAudio || null;

  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
  const FPS = ['23.976', '24', '25', '29.97', '30'];
  const RATES = [44100, 48000];
  const TEST_RECORD_MIN_SECONDS = 1;
  const TEST_RECORD_MAX_SECONDS = 60;
  const TEST_RECORD_DEFAULT_SECONDS = 3;
  /* WebAudio's render quantum is fixed at 128 frames and there is no settable
     buffer size — measured baseLatency was 10.0 ms for 'interactive' and
     'balanced' alike and 20.0 ms for 'playback'. The select is kept because the
     stored preference is shared state, but the latency line no longer computes a
     plausible-looking number from it; it reports ctx.baseLatency, which is
     measured. See outputStatus(). */
  const BUFFERS = [256, 512, 1024, 2048];

  /* The last-resort lists, used only when openlive-audio.js is missing or has
     not answered yet. Two entries, both of which are true of every machine that
     can play audio at all: there is a system default sink, and "None" is always
     a choice. Nothing here names hardware. */
  const DEFAULT_OUTPUTS = [
    { id: 'output:default', label: 'System Default Output', driver: 'WebAudio', channels: 2,
      sampleRates: RATES, buffers: BUFFERS, available: true, complete: false },
    { id: 'none', label: 'None', driver: 'None', channels: 0, sampleRates: [44100], buffers: [512], available: true }
  ];
  const DEFAULT_INPUTS = [
    { id: 'none', label: 'None', channels: 0, available: true },
    { id: 'input:default', label: 'System Default (name hidden)', channels: 2, available: true, complete: false }
  ];
  /* Stored state from before the lists were real still points at devices that
     were never there. Rewriting it is the whole point — leaving it would have
     ensureSelectedDevice() faithfully re-add "Speakers (Realtek HD)" as a row. */
  const RETIRED_OUTPUTS = { 'output:realtek': 'output:default', 'output:focusrite': 'output:default' };
  const RETIRED_INPUTS = { 'input:microphone': 'none', 'input:line': 'none', 'input:focusrite': 'none' };

  let outputDevices = clone(DEFAULT_OUTPUTS);
  let inputDevices = clone(DEFAULT_INPUTS);
  let applying = false;
  let levelStateAt = 0;
  let levelEventAt = 0;
  let armedDeviceId = null;
  /* SLIDER COMMITS. Three separate things were losing a slider's value and all
     three had to go:

     1. ONE TIMER FOR TWO SLIDERS. Moving the master delay and then the FFT gain
        inside the same settling window let the second clearTimeout cancel the
        first slider's commit. Now keyed per slider.
     2. A DEFERRED READ OF THE DOM. The commit read event.target.value when the
        TIMER fired, not when the event happened. Committing slider A re-renders
        the page, and render() writes every slider's value from stored state — so
        slider B's element was reset to its OLD value before B's own timer read
        it, and B then dutifully committed the value it had just been reset to.
        The value is now captured at event time and closed over.
     3. render() CLOBBERING A SLIDER MID-DRAG. Even with the value captured, the
        thumb visibly jumped back under the user's finger. A slider with a commit
        still pending is now left alone; the pending value IS the truth until it
        lands. */
  const rangeTimers = Object.create(null);
  function rangePending(key) { return !!rangeTimers[key]; }
  function commitRange(key, ms, fn) {
    clearTimeout(rangeTimers[key]);
    rangeTimers[key] = setTimeout(() => { rangeTimers[key] = 0; fn(); }, ms);
  }
  let refreshSummary = '';
  let outputChoice = 0;
  let deviceNote = '';
  let unlisten = null;          /* the level subscription, while armed */
  let testBusy = '';            /* '' | 'speakers' | 'record' | 'play' */
  let recordFacts = null;
  const directoryHandles = new Map();
  const armed = () => !!(OA && OA.armed());

  const defaultAudio = () => clone(Hub.get('preferences.audio', {
    /* The default is the system default sink — the one device a browser can
       always route to, measured working with no permission at all — not a named
       card nobody enumerated. latencyMs starts at 0 because it is MEASURED from
       the context once the engine starts, not computed from the buffer select. */
    output: { deviceId: 'output:default', deviceLabel: 'System Default Output', driver: 'WebAudio',
      channelCount: 2, masterChannels: '1 / 2', previewChannels: 'None', delayMs: 0,
      sampleRate: 48000, bufferSize: 512, active: true, latencyMs: 0 },
    input: { deviceId: 'none', deviceLabel: 'None', channelCount: 0, fftChannels: 'None',
      fftGain: 50, armed: false, permission: 'idle', level: 0 },
    soundTest: { recordingSeconds: TEST_RECORD_DEFAULT_SECONDS },
    smpte: { inputs: [
      { channel: 'None', frameRate: '25', signal: 'No input', timecode: '--:--:--:--' },
      { channel: 'None', frameRate: '25', signal: 'No input', timecode: '--:--:--:--' }
    ], outputChannels: 'None', outputFrameRate: '25', oscEnabled: false },
    vst: { directories: [], selectedId: null, plugins: [], needsRestart: false, lastScanAt: 0, baselineSignature: '' },
    updatedAt: 0
  }));

  function normaliseAudio(value) {
    const base = defaultAudio();
    const source = value || {};
    const audio = Object.assign(base, source);
    audio.output = Object.assign(base.output || {}, source.output || {});
    audio.input = Object.assign(base.input || {}, source.input || {});
    audio.soundTest = Object.assign(
      { recordingSeconds: TEST_RECORD_DEFAULT_SECONDS }, source.soundTest || {});
    audio.soundTest.recordingSeconds = normaliseRecordingSeconds(audio.soundTest.recordingSeconds);
    audio.smpte = Object.assign(base.smpte || {}, source.smpte || {});
    audio.smpte.inputs = [0, 1].map(index => Object.assign(
      { channel: 'None', frameRate: '25', signal: 'No input', timecode: '--:--:--:--' },
      source.smpte && source.smpte.inputs && source.smpte.inputs[index] || {}));
    audio.vst = Object.assign(base.vst || {}, source.vst || {});
    audio.vst.directories = Array.isArray(audio.vst.directories) ? audio.vst.directories : [];
    audio.vst.plugins = Array.isArray(audio.vst.plugins) ? audio.vst.plugins : [];
    if (!audio.vst.lastScanAt && !audio.vst.plugins.length && audio.vst.baselineSignature &&
        vstSignature(audio.vst.directories) === audio.vst.baselineSignature) audio.vst.needsRestart = false;
    return audio;
  }

  function flatProjection(audio) {
    return {
      'audio.output.audio-output-device': audio.output.deviceLabel,
      'audio.output.master-output-channels': audio.output.masterChannels,
      'audio.output.preview-output-channels': audio.output.previewChannels,
      'audio.output.master-output-delay': audio.output.delayMs,
      'audio.output.sample-rate': audio.output.sampleRate,
      'audio.output.buffer-size': audio.output.bufferSize,
      'audio.input.audio-input-device': audio.input.deviceLabel,
      'audio.input.external-audio-fft-input': audio.input.fftChannels,
      'audio.input.audio-fft-input-gain': audio.input.fftGain,
      'audio.sound-test.microphone-recording-time': audio.soundTest.recordingSeconds,
      'audio.smpte-timecode-input.smpte-timecode-input-1': audio.smpte.inputs[0].channel,
      'audio.smpte-timecode-input.smpte-timecode-framerate-1': audio.smpte.inputs[0].frameRate,
      'audio.smpte-timecode-input.smpte-timecode-input-2': audio.smpte.inputs[1].channel,
      'audio.smpte-timecode-input.smpte-timecode-framerate-2': audio.smpte.inputs[1].frameRate,
      'audio.smpte-timecode-input.smpte-timecode-output': audio.smpte.outputChannels,
      'audio.smpte-timecode-input.smpte-timecode-output-framerate': audio.smpte.outputFrameRate,
      'audio.smpte-timecode-input.enable-smpte-out-via-osc': audio.smpte.oscEnabled,
      'audio.vst-plugin-directories.directories': audio.vst.directories.map(item => item.path)
    };
  }

  function updateAudio(mutator, reason, key) {
    if (applying) return;
    let committed;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const audio = normaliseAudio(preferences.audio);
      mutator(audio);
      audio.updatedAt = Date.now();
      preferences.audio = audio;
      preferences.values = Object.assign({}, preferences.values || {}, flatProjection(audio));
      preferences.updatedAt = audio.updatedAt;
      committed = clone(audio);
    }, { changedPath: 'preferences.audio', reason: reason || 'audio-preference-change' });
    Hub.emit('openlive:preferences-changed', {
      section: 'audio', key: key || reason, audio: committed, values: flatProjection(committed)
    }, { activity: false });
  }

  function selectOptions(control, items, value, labelOf, valueOf) {
    const selected = String(value == null ? '' : value);
    control.replaceChildren(...items.map(item => new Option(
      labelOf ? labelOf(item) : String(item), valueOf ? valueOf(item) : String(item))));
    if ([...control.options].some(option => option.value === selected)) control.value = selected;
    else if (control.options.length) control.selectedIndex = 0;
  }

  function deviceById(list, id, fallback) {
    return list.find(device => device.id === id) || fallback || list[0];
  }

  function channelPairs(count, includeNone) {
    const out = includeNone ? ['None'] : [];
    for (let channel = 1; channel <= count; channel += 2) {
      out.push(channel + 1 <= count ? `${channel} / ${channel + 1}` : `${channel}`);
    }
    return out;
  }

  function inputChannels(count, includePairs) {
    const out = ['None'];
    if (includePairs) channelPairs(count, false).forEach(pair => out.push(pair));
    for (let channel = 1; channel <= count; channel += 1) out.push(`Input ${channel}`);
    return [...new Set(out)];
  }

  /* A stored device that is no longer in the list is NOT re-added as a normal
     row. It is added disabled and labelled as gone, because a selectable entry
     for hardware that is not attached is the defect this whole change exists to
     remove. */
  function ensureSelectedDevice(list, stateDevice, type) {
    if (!stateDevice || list.some(device => device.id === stateDevice.deviceId)) return;
    if (!stateDevice.deviceId || stateDevice.deviceId === 'none') return;
    list.splice(Math.max(0, list.length - 1), 0, {
      id: stateDevice.deviceId,
      label: `${stateDevice.deviceLabel || 'Remembered device'}: not attached`,
      driver: stateDevice.driver || (type === 'output' ? 'Unavailable' : undefined),
      channels: Math.min(2, Number(stateDevice.channelCount) || 2),
      sampleRates: RATES, buffers: BUFFERS,
      available: false,
      reason: 'This device was selected in an earlier session and is not attached now.'
    });
  }

  /* Read the real lists out of openlive-audio.js and reshape them for the
     selects. `channels` is clamped to 2 everywhere because AudioContext
     .destination.maxChannelCount measured 2 at every sample rate from 44.1k to
     192k — master output is stereo or nothing, so the old 8-channel Focusrite
     and every routing option built from it described something no browser can
     do. */
  function syncDeviceLists() {
    if (!OA) { deviceNote = 'openlive-audio.js is not loaded, so devices cannot be enumerated.'; return; }
    let list;
    try { list = OA.devices(); } catch (error) { deviceNote = `Device list unavailable: ${error.message}`; return; }
    inputDevices = (list.inputs || []).map(item => ({
      id: item.id, label: item.label, channels: item.isNone ? 0 : 2,
      available: item.available !== false, complete: item.complete !== false, reason: item.reason || ''
    }));
    outputDevices = (list.outputs || []).map(item => ({
      id: item.id, label: item.label, driver: item.isNone ? 'None' : 'WebAudio',
      channels: item.isNone ? 0 : 2,
      sampleRates: item.isNone ? [44100] : RATES, buffers: item.isNone ? [512] : BUFFERS,
      available: item.available !== false, complete: item.complete !== false, reason: item.reason || ''
    }));
    if (!inputDevices.length) inputDevices = clone(DEFAULT_INPUTS);
    if (!outputDevices.length) outputDevices = clone(DEFAULT_OUTPUTS);
    deviceNote = list.reason || '';
  }

  function outputStatus(audio, device) {
    const node = $('audioOutputStatus');
    if (!audio.output.active || device.id === 'none') {
      node.dataset.state = 'warning';
      node.innerHTML = '<strong>Local audio output off.</strong> Show and Studio listening are muted. Encoder audio is unchanged.';
      return;
    }
    node.dataset.state = device.available === false ? 'error' : 'ready';
    /* The old line printed bufferSize / sampleRate as "estimated engine + output
       delay" — a plausible number computed from a control that changes nothing.
       ctx.baseLatency is the real figure and it only exists once the engine has
       started, so say that instead of guessing. */
    const l = OA ? OA.latency() : { ok: false, reason: 'openlive-audio.js is not loaded.' };
    const routing = l.ok
      ? `Sound-test engine at ${l.sampleRate} Hz · measured output latency ${l.baseMs.toFixed(1)} ms` +
        (Number(audio.output.delayMs) ? ` · ${esc(audio.output.delayMs)} ms Programme delay in Show and Studio` : '') +
        ` · ${l.maxChannels} output channels.`
      : `Output latency is measured from the audio engine and it has not started yet. Press Test Speakers or Arm Input. ${esc(l.reason || '')}`;
    node.innerHTML = `<strong>${esc(device.label)}.</strong> Master ${esc(audio.output.masterChannels)}. ${routing}` +
      (device.reason ? `<br>${esc(device.reason)}` : '');
  }

  /* Two meters, L and R, the way OBS shows a capture. `level` may arrive as a
     single number (a caller that has not been updated) or as the full meter
     object from openlive-audio.js: {l, r, rmsL, rmsR, peakL, peakR,
     inputPeakL, inputPeakR, mono, clipL, clipR, dbL, dbR}. A
     single number lights BOTH meters rather than leaving R dead, because a dark
     right meter has to mean "no signal on the right", not "nobody told me about
     the right".

     THE BARS ARE dBFS, NOT PERCENT. openlive-audio maps the RMS to a -60..0 dB
     scale before it gets here, so the readout is labelled in dB — the unit an
     operator reads, and honest at both ends. A percentage of a linear amplitude
     sits at 70% while the converter is hard-clipping.

     MONO IS DRAWN. On a duplicated-mono source the two bars are bit-identical
     and the spread is exactly zero, so a spread warning would never fire and the
     operator could read two matching bars as working stereo. The readout says
     Mono while both channels retain the same pure signal colours. */
  function meterLevelFromAmplitude(value) {
    const amplitude = Math.max(0, Number(value) || 0);
    if (!(amplitude > 0)) return 0;
    return clamp((20 * Math.log10(amplitude) + 60) / 60, 0, 1);
  }

  function meterInputZone(db, active) {
    if (!active) return 'silent';
    if (db < -50) return 'dark-green';
    if (db < -20) return 'green';
    if (db < -9) return 'yellow';
    if (db < -0.5) return 'red';
    return 'white';
  }

  function paintInputMeter(side, pair, obj) {
    const suffix = side === 'l' ? 'L' : 'R';
    const fillLevel = pair[side];
    const vuLevel = obj && Number.isFinite(Number(obj['rms' + suffix]))
      ? meterLevelFromAmplitude(obj['rms' + suffix]) : fillLevel;
    const peakLevel = obj && Number.isFinite(Number(obj['peak' + suffix]))
      ? meterLevelFromAmplitude(obj['peak' + suffix]) : fillLevel;
    const inputLevel = obj && Number.isFinite(Number(obj['inputPeak' + suffix]))
      ? meterLevelFromAmplitude(obj['inputPeak' + suffix]) : peakLevel;
    const shell = $('audioInputMeterShell' + suffix);
    const fill = $('audioInputMeter' + suffix), vu = $('audioInputVu' + suffix);
    const peak = $('audioInputPeak' + suffix), input = $('audioInputInstant' + suffix);
    if (fill) fill.style.width = `${(fillLevel * 100).toFixed(1)}%`;
    if (vu) vu.style.left = `${(vuLevel * 100).toFixed(1)}%`;
    if (peak) peak.style.left = `${(peakLevel * 100).toFixed(1)}%`;
    if (input) {
      const inputDb = inputLevel > 0 ? -60 + inputLevel * 60 : -Infinity;
      input.style.left = `${(inputLevel * 100).toFixed(1)}%`;
      input.dataset.zone = meterInputZone(inputDb, inputLevel > 0);
      input.hidden = inputLevel <= 0;
    }
    if (shell) {
      const measuredDb = obj && Number.isFinite(Number(obj['db' + suffix]))
        ? Math.max(-60, Number(obj['db' + suffix])) : -60 + fillLevel * 60;
      shell.classList.toggle('clipping', !!(obj && obj['clip' + suffix]));
      shell.setAttribute('aria-valuenow', Math.max(-60, measuredDb).toFixed(1));
      shell.setAttribute('aria-valuetext', measuredDb <= -60
        ? 'minus infinity decibels' : `${measuredDb.toFixed(1)} decibels`);
    }
  }

  function applyLevel(level, isArmed) {
    const obj = level && typeof level === 'object' ? level : null;
    const pair = obj
      ? { l: clamp(obj.l, 0, 1), r: clamp(obj.r == null ? obj.l : obj.r, 0, 1) }
      : { l: clamp(level, 0, 1), r: clamp(level, 0, 1) };
    paintInputMeter('l', pair, obj);
    paintInputMeter('r', pair, obj);
    /* Older markup had one bar; keep it fed so a stale page still shows life. */
    const legacy = $('audioInputMeter');
    if (legacy) legacy.style.width = `${Math.round(Math.max(pair.l, pair.r) * 100)}%`;
    const meters = $('audioInputMeters');
    if (meters) {
      meters.dataset.mono = obj && obj.mono ? '1' : '0';
      meters.dataset.clip = obj && (obj.clipL || obj.clipR) ? '1' : '0';
    }
    const db = obj && Number.isFinite(obj.dbL) ? Math.max(obj.dbL, obj.dbR) : null;
    const spread = Math.abs(pair.l - pair.r);
    $('audioInputLevel').value =
      !isArmed ? 'No signal' :
      obj && obj.muted ? 'Muted' :
      obj && obj.mono ? (db === null ? 'Mono' : `Mono ${db.toFixed(1)} dB`) :
      db !== null ? (spread > 0.08 ? `L ${obj.dbL.toFixed(0)} · R ${obj.dbR.toFixed(0)} dB` : `${db.toFixed(1)} dB`) :
      (spread > 0.08 ? `L ${Math.round(pair.l * 100)}% · R ${Math.round(pair.r * 100)}%`
                     : `${Math.round(Math.max(pair.l, pair.r) * 100)}%`);
  }

  /* The states this line has to be able to say, all of them measured:
       prompt + placeholder  devices exist, names withheld, Arm still works
       denied                the page cannot ask again
       granted + muted       readyState 'live' and exact digital silence — a
                             granted permission is NOT a working microphone, and
                             an unexplained empty meter makes the operator blame
                             the app
       granted + no signal   opened, not muted, and still exactly zero
       mono                  the right bar is a copy, not a channel */
  function inputStatus(audio) {
    const node = $('audioInputStatus');
    const status = OA ? OA.status() : null;
    const levels = OA ? OA.levels() : null;
    if (audio.input.deviceId === 'none') {
      node.dataset.state = 'warning';
      node.innerHTML = '<strong>No input device selected.</strong> External FFT and both SMPTE inputs are unavailable, ' +
        'and every audio-reactive parameter holds its last value rather than dropping to zero.' +
        (deviceNote ? `<br>${esc(deviceNote)}` : '') +
        (refreshSummary ? `<br>${esc(refreshSummary)}` : '');
      return;
    }
    const isArmed = armed() || (audio.input.armed && !OA);
    const permission = status ? status.permission : audio.input.permission;
    let state = 'Choose Arm Input to start browser audio capture.';
    if (permission === 'denied') state = 'Microphone access was denied. The page cannot ask again. Re-allow it in the browser’s site settings.';
    else if (permission === 'unsupported') state = 'This browser cannot capture audio input.';
    else if (isArmed && status && status.muted) state = `Armed on “${esc(status.armedLabel)}” but the device is MUTED at the operating system, so both channels read exact silence.`;
    else if (isArmed && status && status.signal === 'silent') state = `Armed on “${esc(status.armedLabel)}” and not muted, but no signal has arrived. Check that something is actually producing audio into it.`;
    else if (isArmed && status) state = `Armed on “${esc(status.armedLabel)}” and feeding the external FFT bus.`;
    else if (isArmed) state = 'Input is armed and feeding the shared analyser.';
    node.dataset.state = permission === 'denied' || permission === 'unsupported' ? 'error'
      : isArmed && status && (status.muted || status.signal === 'silent') ? 'warning'
      : isArmed ? 'ready' : 'warning';

    const bins = OA && OA.spectrum('external') ? OA.spectrum('external').length : 512;
    const rate = OA && OA.latency().ok ? OA.latency().sampleRate : Number(audio.output.sampleRate || 48000);
    const binHz = rate / 2 / bins;
    const mono = levels && levels.mono
      ? ' The two channels are identical, so this source is MONO. The right bar is a copy, not a second channel.'
      : '';
    node.innerHTML = `<strong>${esc(audio.input.deviceLabel)}.</strong> ${state}${mono} ` +
      `FFT source ${esc(audio.input.fftChannels)} · ${bins} bins at ${binHz.toFixed(2)} Hz each. ` +
      `Meter scale −60 to 0 dBFS, RMS bar, 11.8 dB/s decay.` +
      (deviceNote ? `<br>${esc(deviceNote)}` : '') +
      (refreshSummary ? `<br>${esc(refreshSummary)}` : '');
  }

  /* ---- Sound Test --------------------------------------------------------
     Three steps in the order that makes each half of the verdict decidable, and
     a plain sentence at the end saying which half failed. */
  function testStatus(message, state) {
    const node = $('audioTestStatus');
    if (!node) return;
    node.dataset.state = state || 'warning';
    node.innerHTML = message;
  }
  function testProgress(fraction, label) {
    const percent = Math.round(clamp(fraction, 0, 1) * 100);
    const bar = $('audioTestProgress');
    if (bar) bar.style.width = `${percent}%`;
    const progress = $('audioTestProgressBar');
    if (progress) {
      progress.setAttribute('aria-valuenow', String(percent));
      progress.setAttribute('aria-valuetext', `${label}, ${percent}%`);
    }
    const stage = $('audioTestStage');
    if (stage) stage.value = label;
  }
  function normaliseRecordingSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return TEST_RECORD_DEFAULT_SECONDS;
    return Math.round(Math.max(TEST_RECORD_MIN_SECONDS, Math.min(TEST_RECORD_MAX_SECONDS, parsed)));
  }
  function selectedRecordingSeconds() {
    const control = $('audioTestDuration');
    if (control && control.value !== '') return normaliseRecordingSeconds(control.value);
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    return audio.soundTest.recordingSeconds;
  }
  function recordingDurationLabel(seconds) {
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  }
  function testButtons() {
    const speakers = $('audioTestSpeakers'), record = $('audioTestRecord'), play = $('audioTestPlay');
    const duration = $('audioTestDuration');
    if (!speakers) return;
    const hasRecording = !!(OA && OA.status().hasRecording);
    const seconds = selectedRecordingSeconds();
    speakers.disabled = !OA || !!testBusy;
    speakers.textContent = testBusy === 'speakers' ? 'Playing…' : 'Test Speakers';
    /* Recording needs a live stream; the speaker test needs nothing at all, which
       is why it is the first control on the tab that works. */
    record.disabled = !OA || !armed() || (!!testBusy && testBusy !== 'record');
    record.textContent = testBusy === 'record' ? 'Stop' : `Record ${seconds} s`;
    play.disabled = !OA || !hasRecording || !!testBusy;
    play.textContent = testBusy === 'play' ? 'Playing…' : 'Play Back';
    if (duration) duration.disabled = !!testBusy;
  }
  function verdict() {
    return '<br>You should have heard the recording, never the live microphone. If the meters moved but playback was silent, the OUTPUT device is wrong; ' +
      'if the meters did not move, the INPUT device is wrong or muted.';
  }

  function smpteStatus(audio) {
    const node = $('smpteStatus');
    const routed = audio.smpte.inputs.filter(item => item.channel !== 'None').length;
    const oscOutput = !!Hub.get('preferences.values.osc.output.osc-output', false);
    const oscWarning = audio.smpte.oscEnabled && !oscOutput;
    node.dataset.state = oscWarning ? 'warning' : routed ? 'ready' : 'warning';
    node.innerHTML = `<strong>${routed} of 2 SMPTE inputs routed.</strong> Framerate belongs to the incoming LTC signal. ` +
      (oscWarning ? '<span class="audio-restart">OSC output is disabled on the OSC Preferences tab.</span>' :
        audio.smpte.oscEnabled ? 'SMPTE OSC sharing is enabled.' : 'OSC sharing is off.');
  }

  function vstStatus(audio) {
    const node = $('vstStatus');
    const directories = audio.vst.directories.length;
    const plugins = audio.vst.plugins.filter(plugin => plugin.enabled !== false).length;
    node.dataset.state = audio.vst.needsRestart ? 'warning' : 'ready';
    node.innerHTML = `<strong>${directories} ${directories === 1 ? 'directory' : 'directories'} · ${plugins} discovered ${plugins === 1 ? 'plugin' : 'plugins'}.</strong> ` +
      (audio.vst.needsRestart ? '<span class="audio-restart">Native Resolume scans custom VST directories at startup; restart it to load changes.</span>' :
        'Use Rescan to grant folder access and update the SHOWAVE Audio Effects/Sources browser.');
  }

  function render(value) {
    const audio = normaliseAudio(value || Hub.get('preferences.audio'));
    applying = true;
    ensureSelectedDevice(outputDevices, audio.output, 'output');
    ensureSelectedDevice(inputDevices, audio.input, 'input');

    selectOptions($('audioOutputDevice'), outputDevices, audio.output.deviceId, item => item.label, item => item.id);
    const output = deviceById(outputDevices, audio.output.deviceId, DEFAULT_OUTPUTS[0]);
    const outputPairs = channelPairs(output.channels, false);
    selectOptions($('masterOutputChannels'), output.id === 'none' ? ['None'] : outputPairs,
      output.id === 'none' ? 'None' : audio.output.masterChannels);
    selectOptions($('previewOutputChannels'), output.channels > 2 ? ['None', ...outputPairs] : ['None'], audio.output.previewChannels);
    $('masterOutputChannels').disabled = output.id === 'none';
    $('previewOutputChannels').disabled = output.channels <= 2;
    $('asioSettings').hidden = output.driver !== 'ASIO';
    selectOptions($('audioSampleRate'), output.sampleRates || [44100], String(audio.output.sampleRate));
    selectOptions($('audioBufferSize'), output.buffers || [512], String(audio.output.bufferSize));
    $('audioSampleRate').disabled = output.id === 'none';
    $('audioBufferSize').disabled = output.id === 'none';
    if (!rangePending('outputDelay')) {
      $('masterOutputDelay').value = clamp(audio.output.delayMs, 0, 500);
      $('masterOutputDelayValue').value = `${$('masterOutputDelay').value} ms`;
    }
    $('masterOutputDelay').disabled = output.id === 'none';
    outputStatus(audio, output);

    selectOptions($('audioInputDevice'), inputDevices, audio.input.deviceId, item => item.label, item => item.id);
    const input = deviceById(inputDevices, audio.input.deviceId, DEFAULT_INPUTS[0]);
    const fftChoices = inputChannels(input.channels, true);
    selectOptions($('externalFftChannels'), fftChoices, audio.input.fftChannels);
    $('externalFftChannels').disabled = input.id === 'none';
    /* Arm stays ENABLED in the pre-permission state. Arming is the thing that
       GRANTS the permission, so disabling it there would leave the operator with
       an anonymous device list and no way to fill it in. It is only disabled
       where the click can genuinely do nothing: no device, a denied permission
       that cannot be re-prompted, or a remembered device that is gone. */
    const permission = OA ? OA.status().permission : audio.input.permission;
    $('audioInputArm').disabled = input.id === 'none' || input.available === false ||
      permission === 'denied' || permission === 'unsupported';
    $('audioInputArm').textContent = armed() ? 'Stop Input'
      : (!OA && audio.input.armed) ? 'Input Armed Elsewhere' : 'Arm Input';
    $('audioInputArm').setAttribute('aria-pressed', String(armed()));
    if (!rangePending('fftGain')) {
      $('audioFftGain').value = clamp(audio.input.fftGain, 0, 200);
      $('audioFftGainValue').value = `${$('audioFftGain').value}%`;
    }
    if (!armed()) applyLevel(OA ? 0 : audio.input.level, !OA && !!audio.input.armed);
    inputStatus(audio);
    if (document.activeElement !== $('audioTestDuration')) {
      $('audioTestDuration').value = String(audio.soundTest.recordingSeconds);
    }
    testButtons();

    const smpteChoices = inputChannels(input.channels, false);
    [0, 1].forEach(index => {
      selectOptions($(`smpteInput${index + 1}`), smpteChoices, audio.smpte.inputs[index].channel);
      selectOptions($(`smpteFps${index + 1}`), FPS, audio.smpte.inputs[index].frameRate);
      $(`smpteInput${index + 1}`).disabled = input.id === 'none';
      $(`smpteFps${index + 1}`).disabled = input.id === 'none' || audio.smpte.inputs[index].channel === 'None';
      const status = audio.smpte.inputs[index];
      $(`smpteStatus${index + 1}`).textContent = status.channel === 'None' ? 'No input' :
        `${status.signal || 'Waiting for signal'} · ${status.timecode || '--:--:--:--'} @ ${status.frameRate} fps`;
    });
    selectOptions($('smpteOutput'), output.id === 'none' ? ['None'] : ['None', ...outputPairs.map(pair => `Output ${pair}`)], audio.smpte.outputChannels);
    selectOptions($('smpteOutputFps'), FPS, audio.smpte.outputFrameRate);
    $('smpteOutput').disabled = output.id === 'none';
    $('smpteOutputFps').disabled = output.id === 'none' || audio.smpte.outputChannels === 'None';
    $('smpteOsc').checked = !!audio.smpte.oscEnabled;
    smpteStatus(audio);

    const directories = audio.vst.directories;
    selectOptions($('vstDirectoryList'), directories, audio.vst.selectedId,
      item => `${item.path}${item.pluginCount ? ` (${item.pluginCount})` : ''}`, item => item.id);
    $('vstRemoveDirectory').disabled = !directories.length;
    $('vstRescan').disabled = !directories.length;
    const selectedDirectory = directories.find(item => item.id === audio.vst.selectedId) || directories[0];
    if (selectedDirectory && document.activeElement !== $('vstDirectoryPath')) $('vstDirectoryPath').value = selectedDirectory.path;
    vstStatus(audio);
    applying = false;
    publishMeasuredLatency(audio);
  }

  /* The status line has been honest since it started reading ctx.baseLatency, but
     preferences.audio.output.latencyMs was still whatever the old
     bufferSize/sampleRate arithmetic left behind (512/44100 = 11.61 ms) — and any
     OTHER window reading shared state got that fiction. Write the measured figure
     through, once, when it actually differs. Deliberately AFTER applying=false,
     because updateAudio() early-returns while a render is in flight. */
  function publishMeasuredLatency(audio) {
    if (!OA) return;
    const l = OA.latency();
    /* 0 means "not measured yet", which is what the fresh-install seed uses. A
       non-zero value with no running engine can only be residue from the old
       arithmetic or from a previous session's hardware, so it is cleared rather
       than left standing as a current figure. */
    const measured = l.ok && typeof l.baseMs === 'number'
      ? Math.round(l.baseMs * 100) / 100
      : 0;
    if (Math.abs(Number(audio.output.latencyMs) - measured) < 0.01) return;
    updateAudio(next => { next.output.latencyMs = measured; },
      'audio-output-latency-measured', 'audio.output.latencyMs');
  }

  function outputChanged() {
    const choice = ++outputChoice;
    const selected = deviceById(outputDevices, $('audioOutputDevice').value, DEFAULT_OUTPUTS[0]);
    updateAudio(audio => {
      const pairs = channelPairs(selected.channels, false);
      audio.output = Object.assign(audio.output, {
        deviceId: selected.id, deviceLabel: selected.label, driver: selected.driver,
        channelCount: selected.channels, active: selected.id !== 'none',
        masterChannels: selected.id === 'none' ? 'None' : pairs[0] || 'None',
        previewChannels: 'None',
        bufferSize: selected.buffers.includes(512) ? 512 : selected.buffers[0]
      });
      if (selected.id === 'none') audio.smpte.outputChannels = 'None';
    }, 'audio-output-device', 'audio.output.device');
    /* Actually route it. setSinkId is real on both AudioContext and media
       elements here. Shared output routing applies the same choice to the
       sound test, Show and Studio speaker branches without muting encoder audio. */
    if (!OA) return;
    OA.setOutputDevice(selected.id).then(result => {
      if(choice !== outputChoice || result.superseded || result.disposed) return;
      refreshSummary = result.ok ? ''
        : result.supported === false
          ? 'Output routing is unavailable in this browser: everything plays to the system default sink.'
          : result.reason;
      updateAudio(audio => { audio.output.sinkId = result.sinkId; audio.output.routed = !!result.ok; },
        'audio-output-sink', 'audio.output.sinkId');
      render();
    });
  }

  /* The meter is fed by openlive-audio.js, which owns the graph
     (source -> 2-channel gain -> ChannelSplitter -> two analysers) and the
     ballistics. This page only draws and republishes. */
  function watchLevels() {
    if (unlisten || !OA) return;
    unlisten = OA.onLevel(publishLevel);
  }
  function unwatchLevels() {
    if (!unlisten) return;
    unlisten();
    unlisten = null;
  }

  /* THE SOUND TEST HAS TO DRIVE THE BARS TOO. watchLevels() was reached only
     from armInput(), so during Test Speakers and Play Back — neither of which
     needs an armed input — nothing was subscribed, openlive-audio's loopWanted()
     stayed false, its loop never ran, and both meters sat at "0%" for the whole
     sweep. Every one of the three status lines tells the operator to watch those
     meters ("Watch the L/R meters above", "The same L/R meters are driven by the
     playback"), which made the page assert something it was not doing — and it
     breaks the one thing the test exists for: telling "I hear nothing because the
     app makes no sound" apart from "I hear nothing because my speakers are off".
     Only the LEFT bar moving during "Playing LEFT" answers that.

     The subscription is reference-counted against arming: a test that starts it
     releases it, but a test run while armed must not tear the armed meter down. */
  function withLevels(run) {
    const borrowed = !unlisten;
    if (borrowed) watchLevels();
    return Promise.resolve()
      .then(run)
      .finally(() => {
        if (!borrowed || armed()) return;
        unwatchLevels();
        /* Releasing the subscription stops the loop, which freezes the bars
           wherever the last frame left them — measured L 51% / R 63% still
           showing a minute after a sweep had finished. A held bar with no audio
           behind it is a reading the operator will believe. Clear it. */
        applyLevel(0, false);
      });
  }

  function stopInput(commitState) {
    const sharedOwner = Hub.get('preferences.audio.input.captureOwner', null);
    const ownsShared = !sharedOwner || sharedOwner === Hub.clientId;
    unwatchLevels();
    if (OA) OA.disarm();
    armedDeviceId = null;
    applyLevel(0, false);
    if (ownsShared) Hub.emit('openlive:external-fft-level', { level: 0, armed: false, at: Date.now() }, { activity: false });
    if (commitState && ownsShared) updateAudio(audio => {
      audio.input.armed = false;
      audio.input.level = 0;
      audio.input.captureOwner = null;
      audio.smpte.inputs.forEach(item => {
        item.signal = item.channel === 'None' ? 'No input' : 'Waiting for input';
        item.timecode = '--:--:--:--';
      });
    }, 'audio-input-stop', 'audio.input.armed');
    testButtons();
  }

  /* Keep the scalar `level` for old consumers, and carry the complete visual
     meter state so a second Preferences window paints the same PPM, VU, held
     peak, input marker and clipping state instead of falling back to one bar. */
  function publishOwnedInputStopped(reason) {
    if (armedDeviceId === null) return false;
    armedDeviceId = null;
    const sharedOwner = Hub.get('preferences.audio.input.captureOwner', null);
    if (sharedOwner && sharedOwner !== Hub.clientId) return false;
    Hub.emit('openlive:external-fft-level', { level: 0, armed: false, at: Date.now() }, { activity: false });
    Hub.patch('preferences.audio.input', { armed: false, level: 0, captureOwner: null }, { reason });
    return true;
  }
  function publishLevel(meter) {
    const at = performance.now();
    const inputArmed = armed();
    const level = Math.max(meter.l || 0, meter.r || 0);
    applyLevel(meter, inputArmed || meter.source === 'test' || meter.source === 'playback');
    if (!inputArmed) {
      // Input shutdown may notify before this page's own pagehide listener.
      // Speaker tests still paint their meters, but never claim an FFT input.
      publishOwnedInputStopped('audio-input-ended');
      return;
    }
    const sharedOwner = Hub.get('preferences.audio.input.captureOwner', null);
    if (sharedOwner && sharedOwner !== Hub.clientId) return;
    if (at - levelEventAt > 80) {
      levelEventAt = at;
      Hub.emit('openlive:external-fft-level',
        { level, l: meter.l, r: meter.r, rmsL: meter.rmsL, rmsR: meter.rmsR,
          peakL: meter.peakL, peakR: meter.peakR,
          inputPeakL: meter.inputPeakL, inputPeakR: meter.inputPeakR,
          dbL: meter.dbL, dbR: meter.dbR, clipL: !!meter.clipL, clipR: !!meter.clipR,
          mono: !!meter.mono, muted: !!meter.muted, armed: true, at: Date.now() },
        { activity: false });
    }
    if (at - levelStateAt > 650) {
      levelStateAt = at;
      Hub.patch('preferences.audio.input', { level, armed: true, permission: 'granted' }, { reason: 'audio-input-level' });
    }
  }

  async function armInput() {
    if (armed()) return stopInput(true);
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    if (audio.input.deviceId === 'none') return;
    if (!OA || !OA.supported()) {
      updateAudio(state => {
        state.input.armed = false;
        state.input.permission = 'unsupported';
      }, 'audio-input-unsupported', 'audio.input.permission');
      return;
    }
    $('audioInputArm').disabled = true;
    $('audioInputArm').textContent = 'Requesting…';
    try {
      /* This click IS the permission prompt in the pre-permission state, which
         is why the button is not disabled there. */
      const status = await OA.arm(audio.input.deviceId);
      armedDeviceId = audio.input.deviceId;
      /* Arming an input in order to drive the FFT and then leaving the source on
         "None" would mean the bus is fed but the label says it is not. Default
         it to the pair, which is what the operator asked for by arming. */
      const fftChannels = audio.input.fftChannels === 'None' ? '1 / 2' : audio.input.fftChannels;
      OA.setFftSource(fftChannels);
      OA.setFftGain(audio.input.fftGain);
      watchLevels();
      syncDeviceLists();
      /* The device that actually opened is not always the one that was asked
         for: 4 of 8 real inputs on this machine answer OverconstrainedError and
         the module retries unconstrained. Say which one it really is. */
      refreshSummary = status.requested !== status.id && status.label
        ? `That device refused an exact match, so the system default opened instead: “${status.label}”.` : '';
      updateAudio(state => {
        state.input.armed = true;
        state.input.captureOwner = Hub.clientId;
        state.input.permission = 'granted';
        state.input.level = 0;
        state.input.error = '';
        state.input.fftChannels = fftChannels;
        if (status.label) state.input.deviceLabel = state.input.deviceId === 'input:default'
          ? `System Default: ${status.label}` : state.input.deviceLabel;
        state.smpte.inputs.forEach(item => {
          item.signal = item.channel === 'None' ? 'No input' : 'Listening: no decoded LTC';
          item.timecode = '--:--:--:--';
        });
      }, 'audio-input-arm', 'audio.input.armed');
      const seconds = selectedRecordingSeconds();
      testStatus('<strong>Input meter armed.</strong> The L/R bars are live, but the microphone is not routed to Audio Output. ' +
        `If they do not move, the microphone is muted or the wrong device is selected. To hear-test it, Record ${recordingDurationLabel(seconds)} and then choose Play Back.`, 'ready');
    } catch (error) {
      updateAudio(state => {
        state.input.armed = false;
        state.input.permission = error && error.name === 'NotAllowedError' ? 'denied' : 'error';
        state.input.error = error && error.message || 'Could not open audio input';
      }, 'audio-input-error', 'audio.input.permission');
      refreshSummary = error && error.message || 'Could not open audio input.';
    } finally {
      render();
    }
  }

  async function refreshDevices() {
    const button = $('audioInputRefresh');
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      if (!OA) throw new Error('openlive-audio.js is not loaded');
      const list = await OA.refresh();
      syncDeviceLists();
      const namedIn = (list.inputs || []).filter(item => item.complete && !item.isNone).length;
      const namedOut = (list.outputs || []).filter(item => item.complete && !item.isNone).length;
      /* The honest count, which is a range and not a number before permission:
         enumeration returns ONE anonymous placeholder per kind, so "1 input" is
         Chrome's privacy answer, not this machine's hardware. */
      refreshSummary = list.state === 'placeholder'
        ? 'At least one audio input and one audio output are attached. How many, and what they are called, is hidden until microphone access is allowed.'
        : `${namedIn} named input ${namedIn === 1 ? 'device' : 'devices'} and ${namedOut} named output ${namedOut === 1 ? 'device' : 'devices'} enumerated, aliases folded in.`;
      render();
    } catch (error) {
      refreshSummary = `Refresh failed: ${error.message}`;
      render();
    } finally {
      button.disabled = false;
      button.textContent = 'Refresh';
    }
  }

  /* ---- the three Sound Test steps ---- */
  async function runSpeakerTest() {
    if (!OA || testBusy) return;
    testBusy = 'speakers';
    testButtons();
    $('audioTestSpeakersValue').value = 'Playing';
    testStatus('<strong>Playing a 420 → 900 Hz sweep, left then right.</strong> Watch the L/R meters above and listen for the side named below. ' +
      'A sweep rather than a tone because a tone cannot reveal a swapped pair or a rolled-off side, and left-then-right because a simultaneous test cannot either.', 'warning');
    try {
      const result = await withLevels(() => OA.testSpeakers({
        onStage: info => {
          const fraction = info.total ? info.at / info.total : 0;
          if (info.stage === 'left') testProgress(0.05, 'Playing LEFT');
          else if (info.stage === 'right') testProgress(Math.max(0.5, fraction), 'Playing RIGHT');
          else testProgress(1, 'Done');
        }
      }));
      $('audioTestSpeakersValue').value = 'Done';
      testStatus(`<strong>Sweep finished on sink “${esc(result.sinkId)}”.</strong> ` +
        'Left then right, ' + result.durationMs + ' ms total. If you heard only one side, that side is the only one connected; ' +
        'if you heard right before left, the pair is swapped; if you heard nothing at all but both meters moved, the output device is wrong.', 'ready');
    } catch (error) {
      $('audioTestSpeakersValue').value = 'Failed';
      testStatus(`<strong>The speaker test could not run.</strong> ${esc(error.message || error)}`, 'error');
    } finally {
      testBusy = '';
      testProgress(0, 'Idle');
      testButtons();
    }
  }

  async function runRecord() {
    if (!OA) return;
    if (testBusy === 'record') { await OA.stopRecording(); return; }
    if (testBusy) return;
    if (!armed()) { testStatus('<strong>Arm an input first.</strong> Recording needs a live capture stream.', 'warning'); return; }
    const seconds = selectedRecordingSeconds();
    const recordingMs = seconds * 1000;
    testBusy = 'record';
    testButtons();
    $('audioTestRecordValue').value = '0.0 s';
    testStatus(`<strong>Recording ${recordingDurationLabel(seconds)} without live monitoring.</strong> Say a short sentence. ` +
      'The L/R meters above are the live input; only this recording can be played to Audio Output after you choose Play Back.', 'warning');
    try {
      /* Progress comes from the recorder's own timeslice ticks, not a timer
         guessing alongside it. */
      const started = await OA.startRecording({
        ms: recordingMs,
        onTick: info => {
          testProgress(info.at / info.total, 'Recording');
          $('audioTestRecordValue').value = `${(info.at / 1000).toFixed(1)} s`;
        }
      });
      /* `done`, not stopRecording() — stopRecording ENDS the take, so awaiting it
         here would stop the recorder the instant it started. */
      const blob = await started.done;
      recordFacts = await OA.describeRecording();
      const facts = recordFacts && recordFacts.ok
        ? `${recordFacts.duration.toFixed(2)} s, ${recordFacts.channels} ch, ${recordFacts.sampleRate} Hz, ${blob.size} bytes`
        : (recordFacts && recordFacts.reason) || `${blob.size} bytes`;
      $('audioTestRecordValue').value = recordFacts && recordFacts.ok ? `${recordFacts.duration.toFixed(1)} s` : 'Unreadable';
      testStatus(`<strong>Recorded ${esc(facts)}</strong> as ${esc(started.mimeType || blob.type)}. Choose Play Back to hear it on the selected output.` +
        (OA.levels().muted ? '<br><span class="audio-restart">The device reported itself MUTED for the whole take, so this recording is digital silence.</span>' : ''),
        recordFacts && recordFacts.ok ? 'ready' : 'error');
    } catch (error) {
      testStatus(`<strong>Recording failed.</strong> ${esc(error.message || error)}`, 'error');
    } finally {
      testBusy = '';
      testProgress(0, 'Idle');
      testButtons();
    }
  }

  async function runPlayback() {
    if (!OA || testBusy) return;
    testBusy = 'play';
    testButtons();
    testProgress(0.5, 'Playing back');
    testStatus('<strong>Playing the saved recording through the selected output.</strong> This is the only microphone-test audio sent to speakers; the live microphone remains input-only.', 'warning');
    try {
      const facts = await withLevels(() => OA.playRecording());
      testProgress(1, 'Done');
      testStatus(`<strong>Played back ${facts.ok ? `${facts.duration.toFixed(2)} s, ${facts.channels} ch, ${facts.sampleRate} Hz` : 'the recording'}.</strong>` + verdict(), 'ready');
    } catch (error) {
      testStatus(`<strong>Playback failed.</strong> ${esc(error.message || error)}`, 'error');
    } finally {
      testBusy = '';
      testProgress(0, 'Idle');
      testButtons();
    }
  }

  function directoryId(path) {
    let hash = 2166136261;
    String(path).toLowerCase().split('').forEach(character => {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return `vst:${(hash >>> 0).toString(36)}`;
  }

  function vstSignature(directories) {
    return (directories || []).map(item => String(item.path || '').trim().replace(/[\\/]+$/, '').toLowerCase())
      .filter(Boolean).sort().join('|');
  }

  function addDirectoryPath(path, metadata) {
    const cleaned = String(path || '').trim().replace(/[\\/]+$/, '');
    if (!cleaned) return;
    updateAudio(audio => {
      const id = directoryId(cleaned);
      const current = audio.vst.directories.find(item => item.id === id);
      const record = Object.assign(current || { id, path: cleaned, pluginCount: 0, scannedAt: 0 }, metadata || {}, { path: cleaned });
      if (!current) audio.vst.directories.push(record);
      else Object.assign(current, record);
      audio.vst.selectedId = id;
      audio.vst.needsRestart = vstSignature(audio.vst.directories) !== audio.vst.baselineSignature;
    }, 'vst-directory-add', 'audio.vst.directories');
  }

  async function scanHandle(handle, directoryIdValue) {
    const plugins = [];
    let inspected = 0;
    async function walk(directory, prefix, depth) {
      if (depth > 3 || inspected > 600) return;
      for await (const [name, entry] of directory.entries()) {
        inspected += 1;
        if (inspected > 600) break;
        if (entry.kind === 'directory') {
          if (/\.vst3$/i.test(name)) plugins.push({ name: name.replace(/\.vst3$/i, ''), file: `${prefix}${name}`, extension: 'vst3' });
          else await walk(entry, `${prefix}${name}/`, depth + 1);
        } else if (/\.(dll|vst3|vst)$/i.test(name)) {
          plugins.push({ name: name.replace(/\.(dll|vst3|vst)$/i, ''), file: `${prefix}${name}`, extension: name.split('.').pop().toLowerCase() });
        }
      }
    }
    await walk(handle, '', 0);
    const records = plugins.map(plugin => ({
      id: `${directoryIdValue}:${plugin.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: plugin.name, label: plugin.name,
      kind: /(synth|instrument|generator|source)/i.test(plugin.name) ? 'source' : 'effect',
      track: 'audio', directoryId: directoryIdValue, file: plugin.file,
      extension: plugin.extension, enabled: true
    }));
    updateAudio(audio => {
      audio.vst.plugins = audio.vst.plugins.filter(plugin => plugin.directoryId !== directoryIdValue).concat(records);
      const directory = audio.vst.directories.find(item => item.id === directoryIdValue);
      if (directory) {
        directory.pluginCount = records.length;
        directory.scannedAt = Date.now();
        directory.access = 'Browser folder permission';
      }
      audio.vst.lastScanAt = Date.now();
      audio.vst.needsRestart = true;
    }, 'vst-directory-scan', 'audio.vst.plugins');
  }

  async function chooseDirectory() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const path = handle.name;
        const id = directoryId(path);
        directoryHandles.set(id, handle);
        addDirectoryPath(path, { id, access: 'Browser folder permission' });
        await scanHandle(handle, id);
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    const path = window.prompt('VST plugin directory path', $('vstDirectoryPath').value || 'C:\\Program Files\\VSTPlugins');
    if (path) addDirectoryPath(path);
  }

  async function rescanSelectedDirectory() {
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    const selected = audio.vst.directories.find(item => item.id === audio.vst.selectedId);
    if (!selected) return;
    const handle = directoryHandles.get(selected.id);
    if (handle) return scanHandle(handle, selected.id);
    if (window.showDirectoryPicker) {
      try {
        const replacement = await window.showDirectoryPicker({ mode: 'read' });
        directoryHandles.set(selected.id, replacement);
        updateAudio(state => {
          const directory = state.vst.directories.find(item => item.id === selected.id);
          if (directory) directory.folderName = replacement.name;
        }, 'vst-directory-permission', 'audio.vst.directories');
        return scanHandle(replacement, selected.id);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    updateAudio(state => { state.vst.needsRestart = true; }, 'vst-rescan-pending', 'audio.vst.needsRestart');
  }

  function migrateLegacyValues() {
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    const values = Hub.get('preferences.values', {}) || {};
    if (Number(audio.updatedAt) > 0 || !Object.keys(values).some(key => key.startsWith('audio.'))) return;
    updateAudio(state => {
      const outputLabel = values['audio.output.audio-output-device'];
      const output = outputDevices.find(device => device.label === outputLabel);
      if (output) Object.assign(state.output, {
        deviceId: output.id, deviceLabel: output.label, driver: output.driver,
        channelCount: output.channels, active: output.id !== 'none'
      });
      const inputLabel = values['audio.input.audio-input-device'];
      const input = inputDevices.find(device => device.label === inputLabel);
      if (input) Object.assign(state.input, {
        deviceId: input.id, deviceLabel: input.label, channelCount: input.channels
      });
      state.output.masterChannels = values['audio.output.master-output-channels'] || state.output.masterChannels;
      state.output.previewChannels = values['audio.output.preview-output-channels'] || state.output.previewChannels;
      state.output.delayMs = Number(values['audio.output.master-output-delay'] ?? state.output.delayMs);
      state.output.sampleRate = Number(values['audio.output.sample-rate'] ?? state.output.sampleRate);
      state.output.bufferSize = Number(values['audio.output.buffer-size'] ?? state.output.bufferSize);
      state.input.fftChannels = values['audio.input.external-audio-fft-input'] || state.input.fftChannels;
      state.input.fftGain = Number(values['audio.input.audio-fft-input-gain'] ?? state.input.fftGain);
      state.smpte.inputs[0].channel = values['audio.smpte-timecode-input.smpte-timecode-input-1'] || state.smpte.inputs[0].channel;
      state.smpte.inputs[1].channel = values['audio.smpte-timecode-input.smpte-timecode-input-2'] || state.smpte.inputs[1].channel;
      const oldFrameRate = values['audio.smpte-timecode-input.smpte-timecode-framerate'];
      if (oldFrameRate) state.smpte.inputs.forEach(item => { item.frameRate = String(oldFrameRate); });
      state.smpte.outputChannels = values['audio.smpte-timecode-input.smpte-timecode-output'] || state.smpte.outputChannels;
      state.smpte.oscEnabled = !!(values['audio.smpte-timecode-input.enable-smpte-out-via-osc'] ?? state.smpte.oscEnabled);
      const oldDirectory = values['audio.vst-plugin-directories.directory'];
      if (oldDirectory && !state.vst.directories.some(item => item.path === oldDirectory)) {
        const id = directoryId(oldDirectory);
        state.vst.directories.push({ id, path: oldDirectory, pluginCount: 0, scannedAt: 0 });
        state.vst.selectedId = id;
      }
    }, 'audio-preferences-migrate', 'audio');
  }

  function ensureVstBaseline() {
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    if (audio.vst.baselineSignature) return;
    updateAudio(state => {
      state.vst.baselineSignature = vstSignature(state.vst.directories);
      state.vst.needsRestart = false;
    }, 'vst-baseline', 'audio.vst.baselineSignature');
  }

  /* Stored state can still point at "Speakers (Realtek HD)" or "Focusrite USB
     Input" — devices that were never attached because they were never real.
     They are rewritten to the system default (output) or None (input) rather
     than left to be re-added as rows, and the channel count is clamped to the 2
     a browser can actually address. Runs once: the marker stops it fighting a
     deliberate later choice. */
  function retireInventedDevices() {
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    const needsOutput = Object.prototype.hasOwnProperty.call(RETIRED_OUTPUTS, audio.output.deviceId);
    const needsInput = Object.prototype.hasOwnProperty.call(RETIRED_INPUTS, audio.input.deviceId);
    if (!needsOutput && !needsInput && audio.output.channelCount <= 2) return;
    updateAudio(state => {
      if (needsOutput) {
        state.output.deviceId = RETIRED_OUTPUTS[audio.output.deviceId];
        state.output.deviceLabel = 'System Default Output';
        state.output.driver = 'WebAudio';
        state.output.active = true;
      }
      if (needsInput) {
        state.input.deviceId = RETIRED_INPUTS[audio.input.deviceId];
        state.input.deviceLabel = 'None';
        state.input.channelCount = 0;
        state.input.armed = false;
        state.input.fftChannels = 'None';
        state.smpte.inputs.forEach(item => Object.assign(item, { channel: 'None', signal: 'No input', timecode: '--:--:--:--' }));
      }
      /* maxChannelCount measured 2 at every sample rate: an 8-channel master and
         a "Preview Output Channels 3 / 4" describe something no browser can do. */
      state.output.channelCount = Math.min(2, Number(state.output.channelCount) || 2);
      state.output.masterChannels = state.output.deviceId === 'none' ? 'None' : '1 / 2';
      state.output.previewChannels = 'None';
      if (!/^(Output )?1 \/ 2$|^None$/.test(String(state.smpte.outputChannels))) state.smpte.outputChannels = 'None';
    }, 'audio-retire-invented-devices', 'audio.devices');
  }

  /* Hand the stored settings to the engine BEFORE anything can start it, so the
     first context is built at the chosen sample rate and on the chosen sink.
     None of these open a device or construct a context — they record intent;
     openlive-audio applies them when the engine actually starts. Without this the
     Sample Rate select would show 44100 while the engine ran at 48000. */
  function restorePreferences() {
    if (!OA) return;
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    OA.setSampleRate(Number(audio.output.sampleRate) || 0);
    OA.setOutputDevice(audio.output.deviceId);
    OA.setFftGain(audio.input.fftGain);
    OA.setFftSource(audio.input.fftChannels);
  }

  migrateLegacyValues();
  retireInventedDevices();
  ensureVstBaseline();
  restorePreferences();
  syncDeviceLists();
  /* Hot-plug is observable — ondevicechange exists and binds — so the list
     refreshes itself instead of waiting for the Refresh button. */
  if (OA) OA.onChange(() => { syncDeviceLists(); render(); });
  $('audioOutputDevice').addEventListener('change', outputChanged);
  $('audioTestSpeakers').addEventListener('click', runSpeakerTest);
  $('audioTestRecord').addEventListener('click', runRecord);
  $('audioTestPlay').addEventListener('click', runPlayback);
  $('audioTestDuration').addEventListener('input', testButtons);
  $('audioTestDuration').addEventListener('change', event => {
    const seconds = normaliseRecordingSeconds(event.target.value);
    event.target.value = String(seconds);
    updateAudio(audio => { audio.soundTest.recordingSeconds = seconds; },
      'audio-sound-test-duration', 'audio.soundTest.recordingSeconds');
    testButtons();
  });
  testStatus(OA
    ? '<strong>Three steps, in this order.</strong> Test Speakers needs no permission at all. Routing to the system default sink was measured working before anything is granted. ' +
      'Arm Input asks for the microphone and shows its meters without live monitoring. Recording uses your chosen time. Only Play Back sends that saved recording through the selected output device.'
    : '<strong>openlive-audio.js is not loaded,</strong> so the sound test cannot run.', OA ? 'warning' : 'error');
  testProgress(0, 'Idle');
  $('masterOutputChannels').addEventListener('change', event => updateAudio(audio => {
    audio.output.masterChannels = event.target.value;
  }, 'audio-master-channels', 'audio.output.masterChannels'));
  $('previewOutputChannels').addEventListener('change', event => updateAudio(audio => {
    audio.output.previewChannels = event.target.value;
  }, 'audio-preview-channels', 'audio.output.previewChannels'));
  $('masterOutputDelay').addEventListener('input', event => {
    const value = Number(event.target.value);
    $('masterOutputDelayValue').value = `${value} ms`;
    commitRange('outputDelay', 80, () => updateAudio(audio => {
      audio.output.delayMs = value;
    }, 'audio-output-delay', 'audio.output.delayMs'));
  });
  /* Sample rate is the one output control that is genuinely real:
     new AudioContext({sampleRate:N}) reported exactly N for every rate tested,
     so it is honoured by rebuilding the context at it. A context's rate is fixed
     for its life, so the change is refused — out loud — while something is
     using it, rather than being stored and quietly ignored. */
  $('audioSampleRate').addEventListener('change', event => {
    const rate = Number(event.target.value);
    const result = OA ? OA.setSampleRate(rate) : { ok: false, reason: 'openlive-audio.js is not loaded.' };
    if (!result.ok) {
      refreshSummary = result.reason;
      render();
      return;
    }
    refreshSummary = 'New Show and Studio windows use this sample rate. Running players keep their current rate until reopened.';
    updateAudio(audio => { audio.output.sampleRate = rate; }, 'audio-sample-rate', 'audio.output.sampleRate');
  });
  $('audioBufferSize').addEventListener('change', event => {
    /* Kept because the value is shared, durable state — but it changes nothing
       audible and the status line no longer pretends otherwise. WebAudio's
       render quantum is fixed at 128 frames; the only lever is latencyHint. */
    refreshSummary = 'Buffer size is a stored preference only: WebAudio has a fixed 128-frame render quantum and no settable buffer. ' +
      'The Output status line shows the latency the engine actually reports.';
    updateAudio(audio => { audio.output.bufferSize = Number(event.target.value); },
      'audio-buffer-size', 'audio.output.bufferSize');
  });

  $('audioInputDevice').addEventListener('change', event => {
    if (armed()) stopInput(false);
    const selected = deviceById(inputDevices, event.target.value, DEFAULT_INPUTS[0]);
    updateAudio(audio => {
      audio.input.deviceId = selected.id;
      audio.input.deviceLabel = selected.label;
      audio.input.channelCount = selected.channels;
      audio.input.fftChannels = 'None';
      audio.input.armed = false;
      audio.input.level = 0;
      audio.input.captureOwner = null;
      audio.input.permission = 'idle';
      audio.smpte.inputs.forEach(item => Object.assign(item, { channel: 'None', signal: 'No input', timecode: '--:--:--:--' }));
    }, 'audio-input-device', 'audio.input.device');
  });
  $('audioInputRefresh').addEventListener('click', refreshDevices);
  $('audioInputArm').addEventListener('click', armInput);
  /* Honoured rather than merely stored: Input 1 taps splitter output 0, Input 2
     taps output 1, and "1 / 2" sums them through an explicit mono node. Silently
     analysing L only when the user asked for the pair is the kind of quiet lie
     this whole change is about. */
  $('externalFftChannels').addEventListener('change', event => {
    if (OA) OA.setFftSource(event.target.value);
    updateAudio(audio => { audio.input.fftChannels = event.target.value; },
      'audio-fft-channels', 'audio.input.fftChannels');
  });
  $('audioFftGain').addEventListener('input', event => {
    const value = Number(event.target.value);
    $('audioFftGainValue').value = `${value}%`;
    /* Applied live to the bus as dB — 20*log10(pct/100), which is what
       openlive-phase adds on top of each driver's own Gain — so the slider moves
       audio-reactive parameters while it is being dragged. */
    if (OA) OA.setFftGain(value);
    commitRange('fftGain', 60, () => updateAudio(audio => {
      audio.input.fftGain = value;
    }, 'audio-fft-gain', 'audio.input.fftGain'));
  });

  [0, 1].forEach(index => {
    $(`smpteInput${index + 1}`).addEventListener('change', event => updateAudio(audio => {
      const entry = audio.smpte.inputs[index];
      entry.channel = event.target.value;
      entry.signal = entry.channel === 'None' ? 'No input' : audio.input.armed ? 'Listening: no decoded LTC' : 'Waiting for armed input';
      entry.timecode = '--:--:--:--';
    }, `smpte-input-${index + 1}`, `audio.smpte.inputs.${index}.channel`));
    $(`smpteFps${index + 1}`).addEventListener('change', event => updateAudio(audio => {
      audio.smpte.inputs[index].frameRate = event.target.value;
    }, `smpte-framerate-${index + 1}`, `audio.smpte.inputs.${index}.frameRate`));
  });
  $('smpteOutput').addEventListener('change', event => updateAudio(audio => {
    audio.smpte.outputChannels = event.target.value;
  }, 'smpte-output', 'audio.smpte.outputChannels'));
  $('smpteOutputFps').addEventListener('change', event => updateAudio(audio => {
    audio.smpte.outputFrameRate = event.target.value;
  }, 'smpte-output-framerate', 'audio.smpte.outputFrameRate'));
  $('smpteOsc').addEventListener('change', event => updateAudio(audio => {
    audio.smpte.oscEnabled = event.target.checked;
  }, 'smpte-osc-output', 'audio.smpte.oscEnabled'));

  $('vstDirectoryList').addEventListener('change', event => updateAudio(audio => {
    audio.vst.selectedId = event.target.value;
  }, 'vst-directory-select', 'audio.vst.selectedId'));
  $('vstAddPath').addEventListener('click', () => addDirectoryPath($('vstDirectoryPath').value));
  $('vstDirectoryPath').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addDirectoryPath(event.target.value); }
  });
  $('vstAddDirectory').addEventListener('click', chooseDirectory);
  $('vstRemoveDirectory').addEventListener('click', () => updateAudio(audio => {
    const id = audio.vst.selectedId;
    audio.vst.directories = audio.vst.directories.filter(item => item.id !== id);
    audio.vst.plugins = audio.vst.plugins.filter(plugin => plugin.directoryId !== id);
    audio.vst.selectedId = audio.vst.directories[0] && audio.vst.directories[0].id || null;
    audio.vst.needsRestart = vstSignature(audio.vst.directories) !== audio.vst.baselineSignature;
    directoryHandles.delete(id);
  }, 'vst-directory-remove', 'audio.vst.directories'));
  $('vstRescan').addEventListener('click', rescanSelectedDirectory);

  $('asioSettings').addEventListener('click', () => {
    const audio = normaliseAudio(Hub.get('preferences.audio'));
    const device = deviceById(outputDevices, audio.output.deviceId, DEFAULT_OUTPUTS[1]);
    $('asioDriverName').textContent = device.label.replace(/^ASIO\s*[—-]\s*/i, '') + ' ASIO';
    selectOptions($('asioSampleRate'), device.sampleRates || [44100, 48000], String(audio.output.sampleRate));
    selectOptions($('asioBufferSize'), device.buffers || [256, 512, 1024], String(audio.output.bufferSize));
    $('asioDialog').classList.add('show');
  });
  $('asioApply').addEventListener('click', () => {
    if (OA) OA.setSampleRate(Number($('asioSampleRate').value));
    updateAudio(audio => {
      audio.output.sampleRate = Number($('asioSampleRate').value);
      audio.output.bufferSize = Number($('asioBufferSize').value);
    }, 'asio-settings', 'audio.output.driverSettings');
    $('asioDialog').classList.remove('show');
  });
  document.querySelectorAll('[data-close-overlay]').forEach(button => button.addEventListener('click', () => {
    $(button.dataset.closeOverlay).classList.remove('show');
  }));
  $('asioDialog').addEventListener('mousedown', event => {
    if (event.target === $('asioDialog')) $('asioDialog').classList.remove('show');
  });

  Hub.subscribe('preferences.audio', (audio, meta) => {
    /* While this page owns the capture, the meter comes from the local graph and
       not from a 650 ms state echo — repainting from the echo would make the
       bars step instead of move. */
    if (meta && meta.reason === 'audio-input-level') {
      if (!armed()) applyLevel(audio && audio.input && audio.input.level, true);
      return;
    }
    if (armed() && audio && audio.input && (audio.input.deviceId !== armedDeviceId ||
      audio.input.captureOwner && audio.input.captureOwner !== Hub.clientId)) stopInput(false);
    render(audio);
  });
  Hub.on('openlive:external-fft-level', payload => {
    /* Another window may be the one armed. Its payload now carries l/r, so a
       remote capture drives both bars instead of only the summed one. */
    if (payload && !armed()) applyLevel(payload.l == null ? payload.level : payload, payload.armed);
  });
  Hub.subscribe('preferences.values', () => smpteStatus(normaliseAudio(Hub.get('preferences.audio'))), { immediate: false });

  window.addEventListener('pagehide', () => {
    /* openlive-audio.js has its own pagehide that stops the tracks, the recorder
       and the object URL; this only has to settle the shared state so another
       window does not read a stale "armed". */
    unwatchLevels();
    publishOwnedInputStopped('audio-input-pagehide');
  });
})();
