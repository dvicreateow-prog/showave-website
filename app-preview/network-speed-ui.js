/* Modeless transport Internet Speed Test window.
   Measurement lives in openlive-speed-test.js; this file owns only view state,
   focus, geometry and explicit user-triggered start/stop behavior. */
(function (global) {
  'use strict';

  const byId = id => document.getElementById(id);
  const windowEl = byId('networkSpeedWindow'), toggle = byId('networkSpeedTestToggle');
  if (!windowEl || !toggle) return;

  const titlebar = byId('networkSpeedTitlebar'), closeButton = byId('networkSpeedClose');
  const startButton = byId('networkSpeedStart'), status = byId('networkSpeedStatus');
  const compactButton = byId('networkSpeedCompactControl');
  const resultButton = byId('networkSpeedResultStart');
  const startHint = windowEl.querySelector('.network-speed-start-hint'), phaseVisual = byId('networkSpeedPhaseVisual');
  const progress = byId('networkSpeedProgress'), summary = byId('networkSpeedSummary');
  const downloadOutput = byId('networkSpeedDownload'), uploadOutput = byId('networkSpeedUpload');
  const idleOutput = byId('networkSpeedIdleLatency'), downLatencyOutput = byId('networkSpeedDownloadLatency');
  const upLatencyOutput = byId('networkSpeedUploadLatency'), jitterOutput = byId('networkSpeedJitter');
  const gauge = byId('networkSpeedGauge'), gaugeArc = byId('networkSpeedGaugeArc');
  const gaugeNeedle = byId('networkSpeedGaugeNeedle'), gaugeValue = byId('networkSpeedGaugeValue');
  const gaugeUnit = byId('networkSpeedGaugeUnit'), gaugeLabel = byId('networkSpeedGaugeLabel');
  const connectionOutput = byId('networkSpeedConnection'), serverOutput = byId('networkSpeedServer');
  const dataOutput = byId('networkSpeedData');
  const timeOutput = byId('networkSpeedMeasuredAt'), headroom = byId('networkSpeedHeadroom');
  const resultsSurface = byId('networkSpeedResultsSurface');
  const slidePanels = {
    landing: byId('networkSpeedLandingSlide'),
    download: byId('networkSpeedDownloadSlide'),
    upload: byId('networkSpeedUploadSlide'),
    results: byId('networkSpeedResultsSlide')
  };
  const slideSlots = Object.fromEntries(Array.from(windowEl.querySelectorAll('[data-speed-slide-slot]'))
    .map(slot => [slot.dataset.speedSlideSlot, slot]));
  const slideSteps = {
    download: byId('networkSpeedStepDownload'),
    upload: byId('networkSpeedStepUpload'),
    results: byId('networkSpeedStepResults')
  };
  const KEY = 'openlive.network-speed.ui.v1';
  const LAYOUT_VERSION = 2;
  let stored = {}, controller = null, runToken = 0, drag = null, lastPhase = '', liveConfirmed = false, lastResult = null;
  let lastAnnouncedSlide = '';
  let lastGaugeValue = null, lastGaugeDirection = 'download', lastGaugeMode = 'pending';

  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (error) { stored = {}; }
  if (stored.layoutVersion !== LAYOUT_VERSION) {
    const geometry = stored.geometry;
    if (geometry) {
      const priorWidth = Number(geometry.width), priorHeight = Number(geometry.height);
      stored.geometry = Object.assign({}, geometry, {
        width: Math.max(760, Number.isFinite(priorWidth) ? priorWidth : 760),
        height: Math.max(620, Number.isFinite(priorHeight) ? priorHeight : 620)
      });
    }
    stored.layoutVersion = LAYOUT_VERSION;
    try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch (error) {}
  }

  const finite = value => value !== null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
  const valueText = (value, places) => finite(value) ? Number(value).toFixed(places) : 'N/A';
  const mib = bytes => finite(bytes) ? `${(Number(bytes) / 1048576).toFixed(1)} MiB` : 'N/A';
  const gaugeStops = [0, 5, 10, 50, 100, 250, 500, 750, 1000];
  const phaseNames = {
    preparing: 'Preparing secure test path…',
    latency: 'Measuring idle latency…',
    'download-pilot': 'Sizing download test…',
    download: 'Measuring download speed…',
    'download-latency': 'Measuring latency during download…',
    'upload-pilot': 'Sizing upload test…',
    upload: 'Measuring upload speed…',
    'upload-latency': 'Measuring latency during upload…',
    complete: 'Internet speed test complete.'
  };

  const visualPhaseNames = {
    ready: 'READY FOR MANUAL TEST', cancelled: 'CANCELLED: READY AGAIN', preparing: 'PREPARING SECURE TEST PATH',
    latency: 'MEASURING IDLE PING', 'download-pilot': 'SIZING DOWNLOAD TEST', download: 'MEASURING DOWNLOAD',
    'download-latency': 'CHECKING DOWNLOAD LATENCY', 'upload-pilot': 'SIZING UPLOAD TEST', upload: 'MEASURING UPLOAD',
    'upload-latency': 'CHECKING UPLOAD LATENCY', complete: 'MEASUREMENT COMPLETE', offline: 'OFFLINE',
    partial: 'PARTIAL MEASUREMENT READY',
    unavailable: 'TEST ENGINE UNAVAILABLE', error: 'MEASUREMENT INTERRUPTED', 'live-output-warning': 'LIVE OUTPUT ACTIVE'
  };

  function qualityScore(tone) {
    return { poor: 1, limited: 2, good: 4, great: 5 }[tone] || 0;
  }

  function markQualityTesting(phase) {
    const detail = phase && phase.indexOf('upload') === 0 ? 'Upload phase in progress' :
      phase && phase.indexOf('download') === 0 ? 'Download phase in progress' : 'Measuring browser path';
    windowEl.querySelectorAll('[data-network-quality]').forEach(card => {
      card.dataset.tone = 'testing'; card.dataset.score = '0';
      card.querySelector('.network-quality-rating').textContent = 'Testing…';
      card.querySelector('.network-quality-detail').textContent = detail;
    });
    headroom.dataset.tone = 'testing'; headroom.dataset.score = '0';
    headroom.querySelector('.network-quality-rating').textContent = 'Testing…';
    headroom.querySelector('.network-quality-detail').textContent = 'Waiting for upload result';
  }

  function syncCompactControl(state) {
    if (!compactButton) return;
    const running = state === 'running';
    compactButton.hidden = !running;
    compactButton.classList.toggle('running', running);
    if (running) {
      compactButton.textContent = 'STOP';
      compactButton.setAttribute('aria-label', 'Stop Internet speed test');
      compactButton.title = 'Stop Internet speed test';
    }
  }

  function slideFor(state, phase) {
    if (state === 'result' || phase === 'complete') return 'results';
    if (state === 'running' && phase && phase.indexOf('upload') === 0) return 'upload';
    if (state === 'running') return 'download';
    return 'landing';
  }

  function refreshProgressSemantics() {
    if (!progress) return;
    const slide = windowEl.dataset.slide || 'landing';
    if (slide === 'landing') {
      progress.setAttribute('aria-valuetext', 'Ready to begin: Download, Upload, then Results');
      return;
    }
    const step = { download: 1, upload: 2, results: 3 }[slide] || 1;
    const label = { download: 'Download', upload: 'Upload', results: 'Results' }[slide] || 'Download';
    const percent = Math.max(0, Math.min(100, Number(progress.value) || 0));
    progress.setAttribute('aria-valuetext', `Step ${step} of 3: ${label}; ${Math.round(percent)}% overall`);
  }

  function setActiveSlide(slide) {
    if (!slidePanels[slide]) slide = 'landing';
    const order = ['landing', 'download', 'upload', 'results'];
    const activeIndex = order.indexOf(slide);
    windowEl.dataset.slide = slide;
    order.forEach((name, index) => {
      const panel = slidePanels[name], step = slideSteps[name];
      const active = name === slide;
      if (panel) {
        panel.hidden = !active;
        panel.inert = !active;
        panel.setAttribute('aria-hidden', String(!active));
      }
      if (step) {
        step.dataset.stepState = active ? 'current' : index < activeIndex ? 'complete' : 'pending';
        if (active) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    });
    const slot = slideSlots[slide];
    if (slot && resultsSurface && resultsSurface.parentNode !== slot) slot.appendChild(resultsSurface);
    refreshProgressSemantics();
  }

  function setViewState(state, phase) {
    const heroHadFocus = document.activeElement === startButton;
    const compactHadFocus = compactButton && document.activeElement === compactButton;
    const resultHadFocus = resultButton && document.activeElement === resultButton;
    const previousSlide = windowEl.dataset.slide || 'landing';
    const previousPhase = lastPhase;
    windowEl.dataset.state = state || 'ready';
    windowEl.dataset.phase = phase || state || 'ready';
    windowEl.setAttribute('aria-busy', String(state === 'running'));
    setActiveSlide(slideFor(state, phase));
    const activeSlide = windowEl.dataset.slide;
    if (state === 'running' && activeSlide === 'upload' && previousSlide !== 'upload') {
      paintGauge(null, 'upload', 'pending');
    } else if (phase && phase.indexOf('upload') === 0) lastGaugeDirection = 'upload';
    else if (phase && phase.indexOf('download') === 0) lastGaugeDirection = 'download';
    if (phaseVisual) phaseVisual.textContent = visualPhaseNames[phase] || visualPhaseNames[state] || String(phase || state || 'ready').toUpperCase();
    if (state === 'running' && phase !== previousPhase) markQualityTesting(phase);
    lastPhase = phase || state || 'ready';
    refreshGaugeSemantics();
    syncCompactControl(windowEl.dataset.state);
    if (state === 'running' && heroHadFocus && compactButton) compactButton.focus();
    else if (state === 'result' && compactHadFocus && resultButton) resultButton.focus();
    else if (state !== 'running' && state !== 'result' && compactHadFocus) startButton.focus();
    else if (state !== 'result' && resultHadFocus) startButton.focus();
  }

  function saveWindowState() {
    const rect = !windowEl.hidden ? windowEl.getBoundingClientRect() : null;
    const geometry = rect ? {
      left: Math.round(rect.left), top: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height)
    } : stored.geometry;
    stored = { open: !windowEl.hidden, geometry, layoutVersion: LAYOUT_VERSION };
    try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch (error) {}
  }

  function positionWindow(restore) {
    const transport = byId('transport').getBoundingClientRect();
    const geometry = restore && stored.geometry;
    if (geometry) {
      const width = Math.min(Math.max(Number(geometry.width) || 760, 320), innerWidth - 8);
      const height = Math.min(Math.max(Number(geometry.height) || 620, 340), innerHeight - 34);
      windowEl.style.width = `${width}px`; windowEl.style.height = `${height}px`;
      windowEl.style.left = `${Math.max(4, Math.min(Number(geometry.left) || 4, innerWidth - width - 4))}px`;
      windowEl.style.top = `${Math.max(24, Math.min(Number(geometry.top) || transport.bottom, innerHeight - height - 4))}px`;
    } else if (!windowEl.style.left) {
      const width = Math.min(760, innerWidth - 16);
      const availableBelowTransport = Math.max(340, innerHeight - Math.round(transport.bottom) - 4);
      const height = Math.min(620, availableBelowTransport, innerHeight - 34);
      windowEl.style.width = `${width}px`;
      windowEl.style.height = `${height}px`;
      windowEl.style.left = `${Math.max(4, innerWidth - width - 8)}px`;
      windowEl.style.top = `${Math.max(24, Math.min(Math.round(transport.bottom), innerHeight - height - 4))}px`;
    } else {
      const rect = windowEl.getBoundingClientRect();
      windowEl.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - Math.min(rect.width, innerWidth - 8) - 4))}px`;
      windowEl.style.top = `${Math.max(24, Math.min(rect.top, innerHeight - rect.height - 4))}px`;
    }
  }

  function setOpen(open, restoreFocus) {
    open = !!open;
    if (!open && controller) cancelActiveRun('Internet speed test cancelled.', 'No partial result was kept.');
    windowEl.hidden = !open;
    toggle.classList.toggle('on', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close Internet Speed Test' : 'Open Internet Speed Test');
    toggle.title = open ? 'Close Internet Speed Test' : 'Open Internet Speed Test';
    if (open) {
      positionWindow(!windowEl.style.left);
      refreshProvenance();
      const focusTarget = windowEl.dataset.state === 'result' && resultButton ? resultButton :
        compactButton && windowEl.dataset.state === 'running' && !compactButton.hidden ? compactButton : startButton;
      global.setTimeout(() => focusTarget.focus(), 0);
    } else {
      if (liveConfirmed) {
        setStartReady(!!lastResult);
        setViewState(lastResult ? 'result' : 'ready', lastResult ? 'complete' : 'ready');
      }
      liveConfirmed = false;
      if (restoreFocus) toggle.focus();
    }
    saveWindowState();
  }

  function cancelActiveRun(message, detail) {
    if (!controller) return false;
    const active = controller;
    controller = null; runToken += 1; active.abort();
    resetResults();
    setViewState('ready', 'cancelled');
    setStartReady(true);
    status.textContent = message || 'Internet speed test cancelled.';
    summary.textContent = detail || 'No partial result was kept.';
    return true;
  }

  function configuredBitrate() {
    try {
      const value = JSON.parse(localStorage.getItem('openlive.streaming.preferences.v1') || '{}');
      return finite(value.bitrate) ? Number(value.bitrate) : 6;
    } catch (error) { return 6; }
  }

  function setStartReady(again) {
    startButton.textContent = 'GO'; startButton.classList.remove('running');
    const action = again ? 'Run Internet speed test again' : 'Start Internet speed test';
    startButton.setAttribute('aria-label', action); startButton.title = action;
    if (resultButton) {
      resultButton.setAttribute('aria-label', 'Run Internet speed test again');
      resultButton.title = 'Run Internet speed test again';
    }
    if (startHint) startHint.textContent = again ? 'RUN AGAIN' : 'PRESS TO TEST';
  }

  function refreshProvenance() {
    if (connectionOutput) {
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const estimate = connection && typeof connection.effectiveType === 'string' ? connection.effectiveType.toUpperCase() : '';
      const saver = connection && connection.saveData ? ' · data saver on' : '';
      connectionOutput.textContent = `Browser HTTPS requests${estimate ? ` · ${estimate} effective type` : ''}${saver}`;
    }
    if (serverOutput) serverOutput.title = 'Cloudflare chooses the measurement edge automatically; its location is not exposed here.';
  }

  function gaugeLabelText() {
    const state = windowEl.dataset.state;
    if (state === 'error') return finite(lastGaugeValue) ? 'LAST RESULT' : 'NO RESULT';
    if (state === 'warning') return finite(lastGaugeValue) ? 'LAST RESULT' : 'READY';
    if (state === 'result') return `${lastGaugeDirection.toUpperCase()} RESULT`;
    if (state === 'running' && lastGaugeMode === 'pending') return `PREPARING ${lastGaugeDirection.toUpperCase()}`;
    if (state === 'running' && lastGaugeMode === 'estimate') return `${lastGaugeDirection.toUpperCase()} ESTIMATE`;
    if (state === 'running') return `CURRENT ${lastGaugeDirection.toUpperCase()}`;
    return 'READY';
  }

  function refreshGaugeSemantics() {
    if (!gauge || !gaugeLabel) return;
    const label = gaugeLabelText();
    gaugeLabel.textContent = label;
    const state = windowEl.dataset.state;
    let accessibleLabel = 'Current transfer speed';
    if (state === 'running') {
      if (lastGaugeMode === 'pending')
        accessibleLabel = lastGaugeDirection === 'upload' ? 'Preparing UPLOAD measurement' : 'Preparing DOWNLOAD measurement';
      else if (lastGaugeMode === 'estimate')
        accessibleLabel = lastGaugeDirection === 'upload' ? 'UPLOAD pilot estimate' : 'DOWNLOAD pilot estimate';
      else accessibleLabel = lastGaugeDirection === 'upload' ? 'Current UPLOAD speed' : 'Current DOWNLOAD speed';
    } else if (state === 'result') {
      accessibleLabel = lastGaugeDirection === 'upload' ? 'Final UPLOAD speed result' : 'Final DOWNLOAD speed result';
    } else if ((state === 'error' || state === 'warning') && finite(lastGaugeValue)) {
      accessibleLabel = lastGaugeDirection === 'upload' ? 'Last UPLOAD speed result' : 'Last DOWNLOAD speed result';
    }
    gauge.dataset.resultLabel = label.toLowerCase().replace(/\s+/g, '-');
    gauge.dataset.phase = lastGaugeDirection;
    gauge.dataset.mode = lastGaugeMode;
    windowEl.dataset.gaugeMode = lastGaugeMode;
    gauge.setAttribute('aria-label', accessibleLabel);
    gauge.setAttribute('aria-valuetext', finite(lastGaugeValue) ?
      `${label.toLowerCase()}: ${valueText(lastGaugeValue, 2)} megabits per second` : 'No speed measured');
  }

  function paintGauge(value, phase, mode) {
    const speed = finite(value) ? Math.max(0, Number(value)) : 0;
    const capped = Math.min(speed, gaugeStops[gaugeStops.length - 1]);
    let segment = 0;
    while (segment < gaugeStops.length - 2 && capped > gaugeStops[segment + 1]) segment += 1;
    const low = gaugeStops[segment], high = gaugeStops[segment + 1];
    const fraction = (segment + (high === low ? 0 : (capped - low) / (high - low))) / (gaugeStops.length - 1);
    gaugeArc.style.strokeDasharray = `${(fraction * 100).toFixed(2)} 100`;
    gaugeNeedle.style.transform = `rotate(${(-135 + fraction * 270).toFixed(1)}deg)`;
    gaugeValue.textContent = finite(value) ? valueText(value, speed >= 100 ? 0 : 2) : 'N/A';
    gaugeUnit.textContent = 'Mbps';
    lastGaugeValue = finite(value) ? speed : null;
    lastGaugeDirection = phase && phase.indexOf('upload') === 0 ? 'upload' : 'download';
    lastGaugeMode = mode || (finite(value) ? 'live' : 'pending');
    gauge.dataset.phase = lastGaugeDirection;
    gauge.setAttribute('aria-valuemax', String(Math.max(1000, Math.ceil(speed))));
    gauge.setAttribute('aria-valuenow', finite(value) ? String(roundForAria(speed)) : '0');
    refreshGaugeSemantics();
  }

  function roundForAria(value) { return Math.round(Number(value) * 100) / 100; }

  function resetResults() {
    lastResult = null;
    setViewState('ready', 'ready');
    [downloadOutput, uploadOutput, idleOutput, downLatencyOutput, upLatencyOutput, jitterOutput]
      .forEach(node => { node.textContent = 'N/A'; });
    ['browsing', 'gaming', 'streaming', 'videoCall'].forEach(key => {
      const card = windowEl.querySelector(`[data-network-quality="${key}"]`);
      card.dataset.tone = 'unknown'; card.dataset.score = '0'; card.querySelector('.network-quality-rating').textContent = 'Waiting';
      card.querySelector('.network-quality-detail').textContent = 'Run a test';
    });
    headroom.dataset.tone = 'unknown'; headroom.dataset.score = '0'; headroom.querySelector('.network-quality-rating').textContent = 'Waiting';
    headroom.querySelector('.network-quality-detail').textContent = `For ${configuredBitrate()} Mbps live output`;
    dataOutput.textContent = 'N/A'; dataOutput.title = ''; timeOutput.textContent = 'Not measured'; summary.textContent = '';
    progress.value = 0; refreshProgressSemantics(); paintGauge(null, 'download', 'pending');
  }

  function paintQuality(result) {
    const quality = result.quality || global.OpenLiveSpeedTest.assess(result);
    Object.keys(quality).forEach(key => {
      const card = windowEl.querySelector(`[data-network-quality="${key}"]`); if (!card) return;
      const value = quality[key]; card.dataset.tone = value.tone; card.dataset.score = String(qualityScore(value.tone));
      card.querySelector('.network-quality-rating').textContent = value.rating;
      card.querySelector('.network-quality-detail').textContent = value.detail;
    });
    const value = global.OpenLiveSpeedTest.assessHeadroom(result, configuredBitrate());
    headroom.dataset.tone = value.tone; headroom.dataset.score = String(qualityScore(value.tone));
    headroom.querySelector('.network-quality-rating').textContent = value.rating;
    headroom.querySelector('.network-quality-detail').textContent = value.detail;
  }

  function paintResult(result) {
    lastResult = result;
    downloadOutput.textContent = valueText(result.downloadMbps, 2);
    uploadOutput.textContent = valueText(result.uploadMbps, 2);
    idleOutput.textContent = valueText(result.latency && result.latency.idleMs, 0);
    downLatencyOutput.textContent = valueText(result.latency && result.latency.downloadMs, 0);
    upLatencyOutput.textContent = valueText(result.latency && result.latency.uploadMs, 0);
    jitterOutput.textContent = valueText(result.latency && result.latency.jitterMs, 0);
    dataOutput.textContent = `${mib(result.bytes && result.bytes.download)} down · ${mib(result.bytes && result.bytes.upload)} up`;
    const measuredTime = new Date(result.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeOutput.textContent = `${measuredTime}${finite(result.durationMs) ? ` · ${(Number(result.durationMs) / 1000).toFixed(1)} s` : ''}`;
    const uploadRequests = result.telemetry && Number(result.telemetry.uploadMainRequests);
    dataOutput.title = uploadRequests > 0 ?
      `${uploadRequests} measured sequential browser upload request${uploadRequests === 1 ? '' : 's'}; total payload is shown.` : '';
    paintQuality(result);
    paintGauge(finite(result.uploadMbps) ? result.uploadMbps : result.downloadMbps,
      finite(result.uploadMbps) ? 'upload' : 'download', 'final');
    const available = [result.downloadMbps, result.uploadMbps].filter(finite).length;
    summary.textContent = result.complete ?
      `Measured ${valueText(result.downloadMbps, 1)} Mbps down, ${valueText(result.uploadMbps, 1)} Mbps up, and ${valueText(result.latency.idleMs, 0)} ms idle ping.` :
      `Partial browser-path result: ${available} of 2 throughput phases completed. Unavailable values were not estimated.`;
    progress.value = 100;
    setViewState('result', result.complete ? 'complete' : 'partial');
    refreshProgressSemantics();
  }

  function paintUpdate(update, token) {
    if (token !== runToken || !controller) return;
    progress.value = Math.max(Number(progress.value) || 0,
      Math.round(Math.max(0, Math.min(1, Number(update.progress) || 0)) * 100));
    if (update.phase === 'complete') {
      refreshProgressSemantics();
      return;
    }
    setViewState('running', update.phase);
    refreshProgressSemantics();
    const activeSlide = windowEl.dataset.slide;
    if (activeSlide !== lastAnnouncedSlide) {
      lastAnnouncedSlide = activeSlide;
      status.textContent = activeSlide === 'upload' ? 'Step 2 of 3: measuring upload speed.' :
        'Step 1 of 3: measuring download speed.';
    }
    if (finite(update.mbps) && (update.phase === 'download' || update.phase === 'upload' || /-pilot$/.test(update.phase)))
      paintGauge(update.mbps, update.phase, /-pilot$/.test(update.phase) ? 'estimate' : 'live');
    if (update.metric === 'download') {
      downloadOutput.textContent = valueText(update.value, 2);
      paintGauge(update.value, 'download', 'measured');
    }
    if (update.metric === 'upload') {
      uploadOutput.textContent = valueText(update.value, 2);
      paintGauge(update.value, 'upload', 'measured');
    }
    if (update.metric === 'idle') idleOutput.textContent = valueText(update.value, 0);
    if (finite(update.latencyMs)) {
      if (update.phase === 'latency') idleOutput.textContent = valueText(update.latencyMs, 0);
      else if (update.phase === 'download-latency') downLatencyOutput.textContent = valueText(update.latencyMs, 0);
      else if (update.phase === 'upload-latency') upLatencyOutput.textContent = valueText(update.latencyMs, 0);
    }
  }

  async function startOrStop() {
    if (controller) { cancelActiveRun('Internet speed test cancelled.', 'No partial result was kept.'); return; }
    if (!navigator.onLine) {
      setViewState('error', 'offline');
      status.textContent = 'Offline. Connect to the Internet and try again.'; summary.textContent = 'No network traffic was started.'; return;
    }
    if (global.OpenLiveStreamUI && typeof global.OpenLiveStreamUI.isStreaming === 'function' &&
        global.OpenLiveStreamUI.isStreaming() && !liveConfirmed) {
      liveConfirmed = true;
      setViewState('warning', 'live-output-warning');
      status.textContent = 'A live output is active. This test may compete for bandwidth.';
      summary.textContent = 'Press RUN ANYWAY to confirm, or close this window.';
      startButton.textContent = 'RUN ANYWAY';
      startButton.setAttribute('aria-label', 'Run Internet speed test despite active live output');
      startButton.title = 'Run Internet speed test despite active live output';
      if (startHint) startHint.textContent = 'CONFIRM LIVE TEST';
      startButton.focus(); return;
    }
    if (!global.OpenLiveSpeedTest || typeof global.OpenLiveSpeedTest.run !== 'function') {
      setViewState('error', 'unavailable');
      status.textContent = 'Speed-test engine unavailable.'; return;
    }
    liveConfirmed = false; resetResults();
    const token = ++runToken; controller = new AbortController(); lastPhase = ''; lastAnnouncedSlide = '';
    setViewState('running', 'preparing');
    startButton.textContent = 'STOP'; startButton.classList.add('running');
    startButton.setAttribute('aria-label', 'Stop Internet speed test');
    startButton.title = 'Stop Internet speed test';
    if (startHint) startHint.textContent = 'TEST IN PROGRESS';
    status.textContent = 'Starting Internet speed test…';
    summary.textContent = 'The browser may request up to 48.4 MiB of test payload, plus protocol overhead. Closing this window stops the test.';
    try {
      const result = await global.OpenLiveSpeedTest.run({
        signal: controller.signal,
        onUpdate: update => paintUpdate(update, token)
      });
      if (token !== runToken) return;
      progress.value = 100;
      paintResult(result);
      status.textContent = result.complete ?
        'Step 3 of 3: results ready. Internet speed test complete.' :
        'Step 3 of 3: partial results ready. Internet speed test completed with partial results.';
    } catch (error) {
      if (token !== runToken) return;
      if (error && error.name === 'AbortError') {
        status.textContent = 'Internet speed test cancelled.';
        summary.textContent = 'No partial result was kept.';
      } else if (error && error.name === 'TimeoutError' && error.partialResult) {
        progress.value = 100;
        paintResult(error.partialResult);
        status.textContent = 'Step 3 of 3: partial results ready. Internet speed test timed out.';
        summary.textContent = 'Available phases are shown; missing values were not estimated.';
      } else {
        setViewState('error', 'error');
        status.textContent = error && error.name === 'TimeoutError' ? error.message : 'Internet speed test unavailable.';
        summary.textContent = `${error && error.message || error}. No result was invented.`;
      }
    } finally {
      if (token === runToken) {
        controller = null; setStartReady(true);
      }
    }
  }

  toggle.addEventListener('click', () => setOpen(windowEl.hidden, false));
  closeButton.addEventListener('click', () => setOpen(false, true));
  startButton.addEventListener('click', startOrStop);
  if (compactButton) compactButton.addEventListener('click', startOrStop);
  if (resultButton) resultButton.addEventListener('click', startOrStop);
  titlebar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = windowEl.getBoundingClientRect();
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    titlebar.classList.add('dragging');
    try { titlebar.setPointerCapture(event.pointerId); } catch (error) {}
  });
  titlebar.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = windowEl.getBoundingClientRect();
    windowEl.style.left = `${Math.max(4, Math.min(event.clientX - drag.dx, innerWidth - rect.width - 4))}px`;
    windowEl.style.top = `${Math.max(24, Math.min(event.clientY - drag.dy, innerHeight - rect.height - 4))}px`;
  });
  const finishDrag = event => {
    if (!drag || event && drag.pointerId !== event.pointerId) return;
    drag = null; titlebar.classList.remove('dragging'); saveWindowState();
  };
  titlebar.addEventListener('pointerup', finishDrag);
  titlebar.addEventListener('pointercancel', finishDrag);
  titlebar.addEventListener('lostpointercapture', finishDrag);
  titlebar.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const rect = windowEl.getBoundingClientRect(), step = event.shiftKey ? 30 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    windowEl.style.left = `${Math.max(4, Math.min(rect.left + dx, innerWidth - rect.width - 4))}px`;
    windowEl.style.top = `${Math.max(24, Math.min(rect.top + dy, innerHeight - rect.height - 4))}px`;
    saveWindowState();
  });
  addEventListener('resize', () => { if (!windowEl.hidden) positionWindow(false); });
  addEventListener('offline', () => { if (controller) cancelActiveRun('Internet connection went offline.', 'The active speed test was stopped.'); });
  addEventListener('pagehide', () => { if (controller) cancelActiveRun(); });
  addEventListener('storage', event => {
    if (event.key === 'openlive.streaming.preferences.v1' && lastResult) paintQuality(lastResult);
  });
  if (typeof ResizeObserver === 'function') {
    let resizeTimer = 0;
    new ResizeObserver(() => {
      if (windowEl.hidden) return; clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(saveWindowState, 100);
    }).observe(windowEl);
  }

  resetResults(); setStartReady(false); refreshProvenance();
  if (stored.open) setOpen(true, false);
  global.OpenLiveSpeedTestUI = Object.freeze({
    open: () => setOpen(true, false),
    close: restoreFocus => setOpen(false, restoreFocus !== false),
    isOpen: () => !windowEl.hidden,
    stop: () => { if (controller) cancelActiveRun(); }
  });
})(window);
