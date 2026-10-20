/* OpenLive browser-path Internet measurement.
   This deliberately has no UI and never starts itself. Both the transport
   utility window and Streaming Preferences call the same runner so byte math,
   cancellation, loaded-latency semantics and quality labels cannot drift. */
(function (global) {
  'use strict';

  const ENDPOINT = 'https://speed.cloudflare.com';
  const DEFAULT_PLAN = Object.freeze({
    idleSamples: 5,
    loadedSamples: 3,
    pilotDownloadBytes: 256 * 1024,
    minDownloadBytes: 1024 * 1024,
    maxDownloadBytes: 32 * 1024 * 1024,
    pilotUploadBytes: 128 * 1024,
    minUploadBytes: 512 * 1024,
    maxUploadBytes: 16 * 1024 * 1024,
    uploadChunks: 4,
    minUploadChunkBytes: 128 * 1024,
    targetTransferMs: 3000,
    timeoutMs: 45000
  });

  const finite = value => value !== null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round = (value, places) => finite(value) ? Number(Number(value).toFixed(places)) : null;
  const median = values => {
    const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const at = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2;
  };
  const jitter = values => {
    const samples = values.filter(finite).map(Number);
    if (samples.length < 2) return null;
    let total = 0;
    for (let at = 1; at < samples.length; at++) total += Math.abs(samples[at] - samples[at - 1]);
    return total / (samples.length - 1);
  };
  const abortError = message => {
    if (typeof global.DOMException === 'function') return new global.DOMException(message || 'Speed test cancelled.', 'AbortError');
    const error = new Error(message || 'Speed test cancelled.'); error.name = 'AbortError'; return error;
  };
  const isAbort = (error, signal) => !!(signal && signal.aborted) || !!(error && error.name === 'AbortError');
  const normalError = error => error && error.message ? error.message : String(error || 'Unknown network error');
  const makeToken = (() => { let value = 0; return () => `${Date.now()}-${++value}`; })();

  function planFrom(value) {
    const source = value || {};
    const bytes = (name, fallback, max) => Math.round(clamp(finite(source[name]) ? Number(source[name]) : fallback, 1, max));
    const count = (name, fallback) => Math.round(clamp(finite(source[name]) ? Number(source[name]) : fallback, 1, 12));
    const maxDownloadBytes = bytes('maxDownloadBytes', DEFAULT_PLAN.maxDownloadBytes, DEFAULT_PLAN.maxDownloadBytes);
    const maxUploadBytes = bytes('maxUploadBytes', DEFAULT_PLAN.maxUploadBytes, DEFAULT_PLAN.maxUploadBytes);
    return {
      idleSamples: count('idleSamples', DEFAULT_PLAN.idleSamples),
      loadedSamples: count('loadedSamples', DEFAULT_PLAN.loadedSamples),
      pilotDownloadBytes: Math.min(bytes('pilotDownloadBytes', DEFAULT_PLAN.pilotDownloadBytes, DEFAULT_PLAN.maxDownloadBytes), maxDownloadBytes),
      minDownloadBytes: Math.min(bytes('minDownloadBytes', DEFAULT_PLAN.minDownloadBytes, DEFAULT_PLAN.maxDownloadBytes), maxDownloadBytes),
      maxDownloadBytes,
      pilotUploadBytes: Math.min(bytes('pilotUploadBytes', DEFAULT_PLAN.pilotUploadBytes, DEFAULT_PLAN.maxUploadBytes), maxUploadBytes),
      minUploadBytes: Math.min(bytes('minUploadBytes', DEFAULT_PLAN.minUploadBytes, DEFAULT_PLAN.maxUploadBytes), maxUploadBytes),
      maxUploadBytes,
      uploadChunks: count('uploadChunks', DEFAULT_PLAN.uploadChunks),
      minUploadChunkBytes: Math.min(bytes('minUploadChunkBytes', DEFAULT_PLAN.minUploadChunkBytes,
        DEFAULT_PLAN.maxUploadBytes), maxUploadBytes),
      targetTransferMs: Math.round(clamp(finite(source.targetTransferMs) ? Number(source.targetTransferMs) : DEFAULT_PLAN.targetTransferMs, 100, 8000)),
      timeoutMs: Math.round(clamp(finite(source.timeoutMs) ? Number(source.timeoutMs) : DEFAULT_PLAN.timeoutMs, 1000, 120000))
    };
  }

  function gradeHigh(value, great, good, limited) {
    if (!finite(value)) return 0;
    return value >= great ? 4 : value >= good ? 3 : value >= limited ? 2 : 1;
  }
  function gradeLow(value, great, good, limited) {
    if (!finite(value)) return 0;
    return value <= great ? 4 : value <= good ? 3 : value <= limited ? 2 : 1;
  }
  const ratingName = score => score === 4 ? 'Great' : score === 3 ? 'Good' : score === 2 ? 'Limited' : score === 1 ? 'Poor' : 'Unknown';
  const metricText = (name, value, unit) => finite(value) ? `${name} ${Number(value).toFixed(unit === 'Mbps' ? 1 : 0)} ${unit}` : `${name} unavailable`;

  function workload(checks) {
    const missing = checks.find(check => !finite(check.value));
    if (missing) return { rating: 'Unknown', tone: 'unknown', detail: `${missing.name} unavailable` };
    const score = Math.min(...checks.map(check => check.score));
    const weakest = checks.find(check => check.score === score) || checks[0];
    return {
      rating: ratingName(score),
      tone: ratingName(score).toLowerCase().replace(/\s+/g, '-'),
      detail: metricText(weakest.name, weakest.value, weakest.unit)
    };
  }

  function assess(result) {
    const latency = result && result.latency || {};
    const down = result && result.downloadMbps, up = result && result.uploadMbps;
    const idle = latency.idleMs, loadedDown = latency.downloadMs, loadedUp = latency.uploadMs;
    return {
      browsing: workload([
        { name: 'Download', value: down, unit: 'Mbps', score: gradeHigh(down, 25, 10, 3) },
        { name: 'Idle ping', value: idle, unit: 'ms', score: gradeLow(idle, 80, 150, 300) },
        { name: 'Download ping', value: loadedDown, unit: 'ms', score: gradeLow(loadedDown, 200, 350, 500) }
      ]),
      gaming: workload([
        { name: 'Download', value: down, unit: 'Mbps', score: gradeHigh(down, 10, 5, 1) },
        { name: 'Upload', value: up, unit: 'Mbps', score: gradeHigh(up, 3, 1, 0.5) },
        { name: 'Idle ping', value: idle, unit: 'ms', score: gradeLow(idle, 40, 80, 150) },
        { name: 'Download ping', value: loadedDown, unit: 'ms', score: gradeLow(loadedDown, 100, 180, 350) },
        { name: 'Upload ping', value: loadedUp, unit: 'ms', score: gradeLow(loadedUp, 100, 180, 350) }
      ]),
      streaming: workload([
        { name: 'Download', value: down, unit: 'Mbps', score: gradeHigh(down, 25, 10, 5) },
        { name: 'Download ping', value: loadedDown, unit: 'ms', score: gradeLow(loadedDown, 150, 250, 400) }
      ]),
      videoCall: workload([
        { name: 'Download', value: down, unit: 'Mbps', score: gradeHigh(down, 10, 5, 2) },
        { name: 'Upload', value: up, unit: 'Mbps', score: gradeHigh(up, 5, 2, 1) },
        { name: 'Idle ping', value: idle, unit: 'ms', score: gradeLow(idle, 80, 150, 250) },
        { name: 'Download ping', value: loadedDown, unit: 'ms', score: gradeLow(loadedDown, 150, 250, 400) },
        { name: 'Upload ping', value: loadedUp, unit: 'ms', score: gradeLow(loadedUp, 150, 250, 400) }
      ])
    };
  }

  function assessHeadroom(result, bitrateMbps) {
    const upload = result && result.uploadMbps;
    const loaded = result && result.latency && result.latency.uploadMs;
    const bitrate = clamp(finite(bitrateMbps) ? Number(bitrateMbps) : 6, 0.1, 200);
    const target = Math.max(10, bitrate * 1.7);
    if (!finite(upload)) return { rating: 'Unknown', tone: 'unknown', detail: 'Upload unavailable', targetMbps: round(target, 1) };
    if (!finite(loaded)) return { rating: 'Unknown', tone: 'unknown', detail: 'Upload-loaded ping unavailable', targetMbps: round(target, 1) };
    if (upload >= Math.max(target, bitrate * 2) && loaded <= 150)
      return { rating: 'Strong', tone: 'great', detail: `${Number(upload).toFixed(1)} Mbps upload for ${bitrate} Mbps output`, targetMbps: round(target, 1) };
    if (upload >= target && loaded <= 250)
      return { rating: 'Ready', tone: 'good', detail: `Clears ${target.toFixed(1)} Mbps target`, targetMbps: round(target, 1) };
    if (upload >= target)
      return { rating: loaded <= 400 ? 'Latency limited' : 'High latency', tone: loaded <= 400 ? 'limited' : 'poor',
        detail: `Upload-loaded ping ${Number(loaded).toFixed(0)} ms`, targetMbps: round(target, 1) };
    if (upload >= bitrate * 1.2)
      return { rating: 'Marginal', tone: 'limited', detail: `${Number(upload).toFixed(1)} Mbps upload; ${target.toFixed(1)} Mbps preferred`, targetMbps: round(target, 1) };
    return { rating: 'Below target', tone: 'poor', detail: `${Number(upload).toFixed(1)} Mbps upload; ${target.toFixed(1)} Mbps needed`, targetMbps: round(target, 1) };
  }

  function fillPayload(size, cryptoApi) {
    const payload = new Uint8Array(size);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      for (let at = 0; at < payload.length; at += 65536)
        cryptoApi.getRandomValues(payload.subarray(at, Math.min(payload.length, at + 65536)));
    } else {
      let value = 0x6d2b79f5;
      for (let at = 0; at < payload.length; at++) {
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5; payload[at] = value & 255;
      }
    }
    return payload;
  }

  async function run(options) {
    options = options || {};
    const lockManager = global.navigator && global.navigator.locks;
    if (lockManager && typeof lockManager.request === 'function') {
      return lockManager.request('openlive-internet-speed-test', { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) {
          const error = new Error('Another Internet speed test is already running.');
          error.name = 'BusyError'; throw error;
        }
        return runUnlocked(options);
      });
    }
    return runUnlocked(options);
  }

  async function runUnlocked(options) {
    options = options || {};
    const fetchFn = options.fetch || (typeof global.fetch === 'function' && global.fetch.bind(global));
    if (!fetchFn) throw new Error('This browser does not provide Fetch, so the speed test cannot run.');
    const now = options.now || (() => global.performance && global.performance.now ? global.performance.now() : Date.now());
    const emit = update => { try { if (typeof options.onUpdate === 'function') options.onUpdate(update); } catch (error) {} };
    const plan = planFrom(options.plan);
    const externalSignal = options.signal;
    const Controller = global.AbortController;
    if (typeof Controller !== 'function') throw new Error('This browser cannot cancel network requests safely.');
    const controller = new Controller();
    let timedOut = false;
    const copyAbort = () => controller.abort(externalSignal && externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) copyAbort();
      else externalSignal.addEventListener('abort', copyAbort, { once: true });
    }
    const timeout = global.setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true; controller.abort();
    }, plan.timeoutMs);
    const signal = controller.signal;
    const startedAt = now();
    const result = {
      downloadMbps: null,
      uploadMbps: null,
      latency: { idleMs: null, downloadMs: null, uploadMs: null, jitterMs: null },
      bytes: { download: 0, upload: 0 },
      durationMs: null,
      measuredAt: new Date().toISOString(),
      endpoint: ENDPOINT,
      provider: 'Cloudflare public measurement endpoint',
      telemetry: {
        uploadPilotRequests: 0,
        uploadMainRequests: 0,
        uploadMode: 'sequential-browser-https'
      },
      errors: {}
    };
    const finishResult = () => {
      result.durationMs = round(now() - startedAt, 0);
      result.quality = assess(result);
      result.complete = finite(result.downloadMbps) && finite(result.uploadMbps) &&
        finite(result.latency.idleMs) && finite(result.latency.downloadMs) && finite(result.latency.uploadMs);
      return result;
    };

    const request = async (path, init) => {
      if (signal.aborted) throw abortError();
      const response = await fetchFn(ENDPOINT + path,
        Object.assign({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal }, init || {}));
      if (!response || !response.ok) throw new Error(`HTTP ${response && response.status || 'error'}`);
      return response;
    };
    const consume = async response => {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader(); let total = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break; total += part.value ? part.value.byteLength : 0;
        }
        return total;
      }
      return (await response.arrayBuffer()).byteLength;
    };
    const pings = async (count, phase, progressStart, progressSpan, activeWindow) => {
      const samples = [];
      for (let at = 0; at < count; at++) {
        if (activeWindow && activeWindow.endedAt !== null) break;
        const activeAtStart = !activeWindow || activeWindow.active !== false;
        const start = now();
        const response = await request(`/__down?bytes=0&cache=${makeToken()}`);
        await consume(response);
        const elapsed = Math.max(0, now() - start);
        const overlapsTransfer = !activeWindow || (activeAtStart &&
          (activeWindow.endedAt === null || start < activeWindow.endedAt));
        if (overlapsTransfer) {
          samples.push(elapsed);
          emit({ phase, progress: progressStart + progressSpan * ((at + 1) / count), latencyMs: round(elapsed, 1) });
        }
      }
      return samples;
    };
    const download = async (bytes, phase, progressStart, progressSpan) => {
      const start = now(), response = await request(`/__down?bytes=${bytes}&cache=${makeToken()}`);
      let loaded = 0;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          const received = part.value ? part.value.byteLength : 0;
          loaded += Math.min(received, Math.max(0, bytes - loaded));
          const elapsed = Math.max(1, now() - start);
          emit({ phase, progress: progressStart + progressSpan * clamp(loaded / bytes, 0, 1), loaded, total: bytes, mbps: loaded * 8 / elapsed / 1000 });
          if (loaded >= bytes) {
            try { await reader.cancel(); } catch (error) {}
            break;
          }
        }
      } else loaded = Math.min((await response.arrayBuffer()).byteLength, bytes);
      const durationMs = Math.max(1, now() - start);
      return { bytes: loaded, durationMs, mbps: loaded * 8 / durationMs / 1000 };
    };
    const uploadRequest = async payload => {
      const start = now();
      const response = await request('/__up', { method: 'POST', body: payload });
      await consume(response);
      const durationMs = Math.max(1, now() - start), mbps = payload.byteLength * 8 / durationMs / 1000;
      return { bytes: payload.byteLength, durationMs, mbps };
    };
    const upload = async (bytes, phase, progressStart, progressSpan) => {
      const payload = fillPayload(bytes, options.crypto || global.crypto);
      const measured = await uploadRequest(payload);
      emit({
        phase,
        progress: progressStart + progressSpan,
        loaded: measured.bytes,
        total: measured.bytes,
        mbps: measured.mbps,
        sampleKind: 'pilot',
        provisional: true,
        completedChunks: 1,
        totalChunks: 1
      });
      return measured;
    };
    const uploadInChunks = async (bytes, phase, progressStart, progressSpan, requestedChunks,
                                  minChunkBytes, activeWindow) => {
      const chunkCapacity = Math.max(1, Math.floor(bytes / Math.max(1, minChunkBytes)));
      const chunkCount = Math.max(1, Math.min(Math.round(requestedChunks) || 1, chunkCapacity));
      const payload = fillPayload(bytes, options.crypto || global.crypto);
      const baseSize = Math.floor(bytes / chunkCount), remainder = bytes % chunkCount;
      const started = now();
      let loaded = 0, offset = 0;
      for (let at = 0; at < chunkCount; at++) {
        const chunkSize = baseSize + (at < remainder ? 1 : 0);
        const body = payload.subarray(offset, offset + chunkSize);
        if (activeWindow) activeWindow.active = true;
        try {
          await uploadRequest(body);
        } catch (error) {
          if (!isAbort(error, signal)) {
            error.completedUploadBytes = loaded;
            error.completedUploadChunks = at;
          }
          throw error;
        } finally {
          if (activeWindow) activeWindow.active = false;
        }
        offset += chunkSize;
        loaded += chunkSize;
        const durationMs = Math.max(1, now() - started);
        emit({
          phase,
          progress: progressStart + progressSpan * (loaded / bytes),
          loaded,
          total: bytes,
          mbps: loaded * 8 / durationMs / 1000,
          sampleKind: 'completed-upload-chunk',
          provisional: loaded < bytes,
          completedChunks: at + 1,
          totalChunks: chunkCount
        });
      }
      const durationMs = Math.max(1, now() - started);
      return { bytes: loaded, durationMs, mbps: loaded * 8 / durationMs / 1000, chunks: chunkCount };
    };

    try {
      emit({ phase: 'preparing', progress: 0, plan });
      try {
        await request(`/__down?bytes=0&cache=${makeToken()}`).then(consume);
        const samples = await pings(plan.idleSamples, 'latency', 0.03, 0.12);
        result.latency.idleMs = round(median(samples), 1);
        result.latency.jitterMs = round(jitter(samples), 1);
        emit({ phase: 'latency', progress: 0.15, metric: 'idle', value: result.latency.idleMs });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        result.errors.latency = normalError(error);
      }

      let downBytes = plan.minDownloadBytes;
      try {
        emit({ phase: 'download-pilot', progress: 0.16 });
        const pilot = await download(plan.pilotDownloadBytes, 'download-pilot', 0.16, 0.04);
        result.bytes.download += pilot.bytes;
        downBytes = Math.round(clamp(pilot.bytes / pilot.durationMs * plan.targetTransferMs, plan.minDownloadBytes, plan.maxDownloadBytes));
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        result.errors.downloadPilot = normalError(error);
      }
      try {
        emit({ phase: 'download', progress: 0.20, total: downBytes });
        const transferWindow = { endedAt: null };
        const transferPromise = download(downBytes, 'download', 0.20, 0.34)
          .finally(() => { transferWindow.endedAt = now(); });
        const latencyPromise = pings(plan.loadedSamples, 'download-latency', 0.22, 0.25, transferWindow).catch(error => {
          if (isAbort(error, signal)) throw error; result.errors.downloadLatency = normalError(error); return [];
        });
        const measured = await Promise.allSettled([transferPromise, latencyPromise]);
        if (measured[0].status === 'rejected') throw measured[0].reason;
        if (measured[1].status === 'rejected') throw measured[1].reason;
        result.downloadMbps = round(measured[0].value.mbps, 2);
        result.bytes.download += measured[0].value.bytes;
        const minimumSamples = Math.min(2, plan.loadedSamples);
        result.latency.downloadMs = measured[1].value.length >= minimumSamples ? round(median(measured[1].value), 1) : null;
        if (measured[1].value.length < minimumSamples)
          result.errors.downloadLatency = result.errors.downloadLatency ||
            `Only ${measured[1].value.length} of ${minimumSamples} required pings overlapped the download transfer.`;
        emit({ phase: 'download', progress: 0.55, metric: 'download', value: result.downloadMbps });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        result.errors.download = normalError(error);
      }

      let upBytes = plan.minUploadBytes;
      try {
        emit({ phase: 'upload-pilot', progress: 0.56 });
        const pilot = await upload(plan.pilotUploadBytes, 'upload-pilot', 0.56, 0.04);
        result.bytes.upload += pilot.bytes;
        result.telemetry.uploadPilotRequests = 1;
        upBytes = Math.round(clamp(pilot.bytes / pilot.durationMs * plan.targetTransferMs, plan.minUploadBytes, plan.maxUploadBytes));
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        result.errors.uploadPilot = normalError(error);
      }
      try {
        emit({ phase: 'upload', progress: 0.60, total: upBytes });
        const transferWindow = { endedAt: null, active: false };
        const transferPromise = uploadInChunks(upBytes, 'upload', 0.60, 0.34, plan.uploadChunks,
          plan.minUploadChunkBytes, transferWindow)
          .finally(() => { transferWindow.endedAt = now(); });
        const latencyPromise = pings(plan.loadedSamples, 'upload-latency', 0.62, 0.25, transferWindow).catch(error => {
          if (isAbort(error, signal)) throw error; result.errors.uploadLatency = normalError(error); return [];
        });
        const measured = await Promise.allSettled([transferPromise, latencyPromise]);
        if (measured[0].status === 'rejected') throw measured[0].reason;
        if (measured[1].status === 'rejected') throw measured[1].reason;
        result.uploadMbps = round(measured[0].value.mbps, 2);
        result.bytes.upload += measured[0].value.bytes;
        result.telemetry.uploadMainRequests = measured[0].value.chunks;
        const minimumSamples = Math.min(2, plan.loadedSamples);
        result.latency.uploadMs = measured[1].value.length >= minimumSamples ? round(median(measured[1].value), 1) : null;
        if (measured[1].value.length < minimumSamples)
          result.errors.uploadLatency = result.errors.uploadLatency ||
            `Only ${measured[1].value.length} of ${minimumSamples} required pings overlapped the upload transfer.`;
        emit({ phase: 'upload', progress: 0.95, metric: 'upload', value: result.uploadMbps });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (finite(error && error.completedUploadBytes)) {
          result.bytes.upload += Number(error.completedUploadBytes);
          result.telemetry.uploadMainRequests = Number(error.completedUploadChunks) || 0;
        }
        result.errors.upload = normalError(error);
      }

      if (!finite(result.downloadMbps) && !finite(result.uploadMbps)) {
        const error = new Error(result.errors.download || result.errors.upload || result.errors.latency || 'The public measurement path did not return a usable result.');
        error.partialResult = finishResult(); throw error;
      }
      finishResult();
      emit({ phase: 'complete', progress: 1, result });
      return result;
    } catch (error) {
      if (isAbort(error, signal)) {
        if (timedOut) {
          const timeoutError = new Error('The Internet speed test timed out.'); timeoutError.name = 'TimeoutError';
          if (finite(result.downloadMbps) || finite(result.uploadMbps)) timeoutError.partialResult = finishResult();
          throw timeoutError;
        }
        throw abortError('Internet speed test cancelled.');
      }
      throw error;
    } finally {
      global.clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener('abort', copyAbort);
    }
  }

  global.OpenLiveSpeedTest = Object.freeze({
    run,
    assess,
    assessHeadroom,
    endpoint: ENDPOINT,
    maxTransferBytes: DEFAULT_PLAN.maxDownloadBytes + DEFAULT_PLAN.maxUploadBytes +
      DEFAULT_PLAN.pilotDownloadBytes + DEFAULT_PLAN.pilotUploadBytes
  });
})(typeof window !== 'undefined' ? window : globalThis);
