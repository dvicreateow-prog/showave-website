/* SHOWAVE GSL5 native lighting bridge
   -------------------------------------------------------------------------
   The browser owns authoring and playback intent. The loopback Python tier is
   the only component allowed to open raw UDP sockets. This adapter keeps that
   boundary explicit, sends no output until the operator arms it, and keeps
   high-rate universe data out of OpenLiveHub/localStorage.
   ------------------------------------------------------------------------- */
(function installGSL5Bridge(global) {
  'use strict';

  if (global.ShowaveGSL5Bridge) return;

  const API_ROOT = '/api/lighting';
  const CHANNEL_NAME = 'showave-gsl5-runtime-v1';
  const MAX_UNIVERSES = 256;
  const MAX_CHANNELS = 512;
  const listeners = new Set();
  const commandListeners = new Set();
  const Hub = global.OpenLiveHub || null;
  let channel = null;
  let pollTimer = 0;
  let requestSerial = 0;
  let frameSending = false;
  let pendingFrame = null;
  let lastFrameSignature = '';
  let lastFrameAt = 0;
  let lastHubProjection = '';

  const state = {
    available: false,
    connected: false,
    status: 'checking',
    outputting: false,
    blackout: false,
    protocol: 'artnet',
    adapterIp: '0.0.0.0',
    destinationMode: 'manual_unicast',
    targetIp: '127.0.0.1',
    fps: 40,
    packetCount: 0,
    packetsPerSecond: 0,
    universeCount: 0,
    lastFrameAt: 0,
    lastPacketAt: 0,
    lastError: '',
    reason: '',
    adapters: [],
    nodes: [],
    checkedAt: 0
  };

  try { channel = new BroadcastChannel(CHANNEL_NAME); } catch (_) { channel = null; }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function snapshot() { return clone(state); }

  function projection() {
    return {
      status: state.status,
      connected: !!state.available,
      outputting: !!state.outputting,
      blackout: !!state.blackout,
      protocol: state.protocol,
      universeCount: state.universeCount,
      packetCount: state.packetCount,
      packetsPerSecond: state.packetsPerSecond,
      lastFrameAt: state.lastFrameAt,
      lastPacketAt: state.lastPacketAt,
      lastError: state.lastError || state.reason || ''
    };
  }

  function publish(reason) {
    const detail = snapshot();
    detail.reason = reason || detail.reason || 'status';
    listeners.forEach(listener => {
      try { listener(detail); } catch (error) { console.error(error); }
    });
    try { if (channel) channel.postMessage({kind:'status', source:'gsl5', state:detail}); } catch (_) { /* noop */ }
    if (Hub && typeof Hub.patch === 'function') {
      const compact = projection();
      const signature = JSON.stringify(compact);
      if (signature !== lastHubProjection) {
        lastHubProjection = signature;
        try {
          Hub.patch('lighting', {runtime:compact, updatedAt:Date.now()},
            {reason:`GSL5 ${reason || 'bridge status'}`});
        } catch (_) { /* A live console must not fail because persistence is full. */ }
      }
    }
  }

  function mergeStatus(value, reason) {
    const source = value && typeof value === 'object' ? value : {};
    const runtime = source.runtime && typeof source.runtime === 'object' ? source.runtime : source;
    const output = runtime.output && typeof runtime.output === 'object' ? runtime.output : runtime;
    const counters = runtime.counters && typeof runtime.counters === 'object' ? runtime.counters : runtime;
    if ('available' in runtime) state.available = !!runtime.available;
    else if ('ok' in runtime) state.available = !!runtime.ok;
    else if (!source.error) state.available = true;
    state.connected = state.available;
    if (runtime.status != null) state.status = String(runtime.status);
    else if (runtime.timedOut) state.status = 'timeout';
    else state.status = state.available ? (runtime.armed || output.enabled || output.outputting ? 'outputting' : 'ready') : 'unavailable';
    if ('enabled' in output) state.outputting = !!output.enabled;
    if ('outputting' in output) state.outputting = !!output.outputting;
    if ('armed' in runtime) state.outputting = !!runtime.armed;
    if ('blackout' in output) state.blackout = !!output.blackout;
    if (output.protocol) state.protocol = String(output.protocol).toLowerCase();
    if (output.adapterIp || output.interfaceIp) state.adapterIp = String(output.adapterIp || output.interfaceIp);
    if (output.destinationMode || output.cast) state.destinationMode = String(output.destinationMode || output.cast);
    if (output.targetIp || output.target) state.targetIp = String(output.targetIp || output.target);
    if (Number.isFinite(Number(output.fps))) state.fps = Number(output.fps);
    if (Number.isFinite(Number(counters.packetCount))) state.packetCount = Number(counters.packetCount);
    if (Number.isFinite(Number(counters.packetsPerSecond))) state.packetsPerSecond = Number(counters.packetsPerSecond);
    if (Number.isFinite(Number(counters.universeCount))) state.universeCount = Number(counters.universeCount);
    if (Array.isArray(runtime.universes)) state.universeCount = runtime.universes.length;
    if (Array.isArray(runtime.adapters)) {
      const routes = runtime.adapters;
      state.packetCount = routes.reduce((sum, route) => sum + (Number(route.packets) || 0), 0);
      const route = routes.find(item => item && item.enabled !== false) || routes[0];
      if (route) {
        if (route.protocol) state.protocol = String(route.protocol).toLowerCase();
        if (route.interface) state.adapterIp = String(route.interface);
        if (route.target) state.targetIp = String(route.target);
        if (route.fps != null) state.fps = Number(route.fps) || state.fps;
      }
    }
    if (Number.isFinite(Number(runtime.lastFrameAt))) state.lastFrameAt = Number(runtime.lastFrameAt);
    if (Number.isFinite(Number(runtime.lastPacketAt))) state.lastPacketAt = Number(runtime.lastPacketAt);
    state.lastError = String(source.error || runtime.lastError || runtime.error || '');
    state.reason = String(runtime.reason || source.reason || '');
    state.checkedAt = Date.now();
    publish(reason || 'status');
    return snapshot();
  }

  async function request(path, options) {
    const opts = Object.assign({method:'GET', cache:'no-store', credentials:'same-origin'}, options || {});
    if (opts.body != null && typeof opts.body !== 'string') {
      opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch(API_ROOT + path, opts);
    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (/json/i.test(contentType)) {
      try { payload = await response.json(); } catch (_) { payload = null; }
    } else {
      const text = await response.text();
      const message = text.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      payload = message ? {message:message.slice(0,300)} : {};
    }
    if (!response.ok) {
      const message = payload && (payload.error || payload.reason || payload.message) ||
        `Lighting bridge request failed (${response.status})`;
      const error = new Error(String(message));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload || {};
  }

  async function check() {
    const serial = ++requestSerial;
    try {
      const value = await request('/status');
      if (serial !== requestSerial) return snapshot();
      return mergeStatus(value, 'health');
    } catch (error) {
      if (serial !== requestSerial) return snapshot();
      state.available = false;
      state.connected = false;
      state.outputting = false;
      state.status = error.status === 404 ? 'unavailable' : 'error';
      state.lastError = error.status === 404
        ? 'The native GSL5 lighting bridge is not loaded. Restart devserver.py.'
        : error.message;
      state.checkedAt = Date.now();
      publish('health-error');
      return snapshot();
    }
  }

  async function adapters() {
    try {
      const value = await request('/adapters');
      const rows = Array.isArray(value) ? value : value.adapters;
      state.adapters = Array.isArray(rows) ? rows.map(row => Object.assign({}, row)) : [];
      publish('adapters');
      return clone(state.adapters);
    } catch (error) {
      state.lastError = error.message;
      publish('adapters-error');
      throw error;
    }
  }

  async function nodes() {
    try {
      const value = await request('/nodes');
      const rows = Array.isArray(value) ? value : value.nodes;
      state.nodes = Array.isArray(rows) ? rows.map(row => Object.assign({}, row)) : [];
      publish('nodes');
      return clone(state.nodes);
    } catch (error) {
      state.lastError = error.message;
      publish('nodes-error');
      throw error;
    }
  }

  async function discover(options) {
    try {
      const value = await request('/discover', {method:'POST', body:options || {}});
      const rows = Array.isArray(value) ? value : value.nodes;
      state.nodes = Array.isArray(rows) ? rows.map(row => Object.assign({}, row)) : state.nodes;
      mergeStatus(value.status || value.runtime || value, 'discovery');
      await new Promise(resolve => setTimeout(resolve, 350));
      return await nodes();
    } catch (error) {
      state.lastError = error.message;
      publish('discovery-error');
      throw error;
    }
  }

  function safeConfig(config) {
    const source = config && typeof config === 'object' ? config : {};
    const protocol = source.protocol === 'sacn' ? 'sacn' : 'artnet';
    const maximumUniverse = protocol === 'sacn' ? 63999 : 32768;
    const requestedUniverses = [...new Set((Array.isArray(source.universes) ? source.universes : [])
      .map(value => Math.round(Number(value))).filter(Number.isFinite))];
    if (requestedUniverses.some(value => value < 1 || value > maximumUniverse))
      throw new Error(`${protocol === 'sacn' ? 'sACN' : 'Art-Net'} supports GSL5 universes 1–${maximumUniverse.toLocaleString()}.`);
    if (requestedUniverses.length > 64)
      throw new Error('GSL5 network output is limited to 64 live universes per route.');
    const universes = requestedUniverses;
    return {
      protocol,
      adapterIp:String(source.adapterIp || source.interfaceIp || '0.0.0.0'),
      destinationMode:String(source.destinationMode || source.cast || 'manual_unicast'),
      targetIp:String(source.targetIp || source.target || '127.0.0.1'),
      fps:Math.max(1, Math.min(44, Number(source.fps) || 40)),
      priority:Math.max(0, Math.min(200, Math.round(Number(source.priority) || 100))),
      artSync:!!source.artSync,
      holdLastLook:!!source.holdLastLook,
      blackout:!!source.blackout,
      nodeId:source.nodeId == null ? null : String(source.nodeId),
      universes,
      sourceName:'GSL5 Lighting Library'
    };
  }

  function routeMode(config) {
    if (config.protocol === 'sacn')
      return config.destinationMode === 'manual_unicast' || config.destinationMode === 'discovered_unicast' ? 'unicast' : 'multicast';
    if (config.destinationMode === 'manual_unicast') return 'unicast';
    if (config.destinationMode === 'legacy_directed_broadcast') return 'broadcast';
    return 'discovered';
  }

  function backendConfig(config) {
    const mode = routeMode(config);
    return {
      action:'configure', sourceName:config.sourceName, holdLastLook:config.holdLastLook,
      adapters:config.universes.map(universe => ({
        id:`gsl5-${config.protocol}-u${universe}`,
        protocol:config.protocol, universe, interface:config.adapterIp, mode,
        target:mode === 'multicast' || mode === 'discovered' ? undefined : config.targetIp,
        broadcast:mode === 'broadcast' ? config.targetIp : undefined,
        fps:config.fps, priority:config.priority, enabled:true,
        sync:config.protocol === 'artnet' && config.artSync
      }))
    };
  }

  async function start(config) {
    const safe = safeConfig(config);
    try {
      if (!safe.universes.length) throw new Error('Patch at least one lighting universe before arming output.');
      await request('/output', {method:'POST', body:backendConfig(safe)});
      let value = await request('/output', {method:'POST', body:{action:'start'}});
      if (safe.blackout) value = await request('/output', {method:'POST', body:{action:'blackout',enabled:true}});
      state.protocol = safe.protocol;
      state.adapterIp = safe.adapterIp;
      state.destinationMode = safe.destinationMode;
      state.targetIp = safe.targetIp;
      state.fps = safe.fps;
      state.outputting = true;
      state.blackout = safe.blackout;
      return mergeStatus(value.status || value.runtime || value, 'output-start');
    } catch (error) {
      state.outputting = false;
      state.lastError = error.message;
      publish('output-start-error');
      throw error;
    }
  }

  async function configure(config) {
    const safe = safeConfig(config);
    if (!safe.universes.length) throw new Error('Patch at least one lighting universe before configuring output.');
    const value = await request('/output', {method:'POST', body:backendConfig(safe)});
    Object.assign(state, {
      protocol:safe.protocol, adapterIp:safe.adapterIp, destinationMode:safe.destinationMode,
      targetIp:safe.targetIp, fps:safe.fps
    });
    return mergeStatus(value.status || value.runtime || value, 'output-configure');
  }

  async function stop(options) {
    const source = options && typeof options === 'object' ? options : {};
    try {
      const value = await request('/output', {method:'POST', body:{
        action:'stop', holdLastLook:!!source.holdLastLook
      }});
      state.outputting = false;
      state.blackout = false;
      return mergeStatus(value.status || value.runtime || value, 'output-stop');
    } catch (error) {
      state.lastError = error.message;
      publish('output-stop-error');
      throw error;
    }
  }

  async function blackout(value) {
    try {
      const response = await request('/output', {method:'POST', body:{action:'blackout', enabled:value !== false}});
      state.blackout = value !== false;
      return mergeStatus(response.status || response.runtime || response, 'blackout');
    } catch (error) {
      state.lastError = error.message;
      publish('blackout-error');
      throw error;
    }
  }

  function normaliseUniverses(input, rawProtocol) {
    const protocol = String(rawProtocol || state.protocol || 'artnet').toLowerCase() === 'sacn'
      ? 'sacn' : 'artnet';
    const maximumUniverse = protocol === 'sacn' ? 63999 : 32768;
    const source = Array.isArray(input) ? input : Object.entries(input || {}).map(([universe, data]) => ({universe, data}));
    return source.slice(0, MAX_UNIVERSES).reduce((rows, row) => {
      if (!row) return rows;
      const universe = Math.round(Number(row.universe == null ? row.id : row.universe));
      if (!(universe >= 1 && universe <= maximumUniverse)) return rows;
      const raw = row.data || row.levels || row.channels || [];
      const values = Array.from(raw).slice(0, MAX_CHANNELS).map(value =>
        Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
      while (values.length < MAX_CHANNELS) values.push(0);
      rows.push({universe, data:values});
      return rows;
    }, []);
  }

  function frameSignature(rows) {
    let hash = 2166136261;
    for (const row of rows) {
      hash ^= row.universe & 255; hash = Math.imul(hash, 16777619);
      hash ^= row.universe >>> 8; hash = Math.imul(hash, 16777619);
      /* Hash every slot. Sampling every eighth channel can silently suppress a
         legitimate DMX update when only an unsampled channel changes. */
      for (let i = 0; i < row.data.length; i++) {
        hash ^= row.data[i]; hash = Math.imul(hash, 16777619);
      }
    }
    return `${rows.length}:${(hash >>> 0).toString(16)}`;
  }

  async function flushFrame() {
    if (frameSending || !pendingFrame || !state.outputting) return false;
    const frame = pendingFrame;
    pendingFrame = null;
    frameSending = true;
    try {
      const value = await request('/frame', {method:'POST', body:{universes:frame.rows}});
      lastFrameSignature = frame.signature;
      lastFrameAt = Date.now();
      state.lastFrameAt = Number(value.lastFrameAt) || lastFrameAt;
      state.universeCount = frame.rows.length;
      if (Number.isFinite(Number(value.packetCount))) state.packetCount = Number(value.packetCount);
      if (value.status || value.runtime) mergeStatus(value.status || value.runtime, 'frame');
      else publish('frame');
      return true;
    } catch (error) {
      state.lastError = error.message;
      publish('frame-error');
      return false;
    } finally {
      frameSending = false;
      if (pendingFrame) Promise.resolve().then(flushFrame);
    }
  }

  function sendUniverses(universes, options) {
    if (!state.outputting) return Promise.resolve(false);
    const rows = normaliseUniverses(universes, options && options.protocol || state.protocol);
    const signature = frameSignature(rows);
    const force = !!(options && options.force);
    if (!force && signature === lastFrameSignature && Date.now() - lastFrameAt < 900)
      return Promise.resolve(false);
    pendingFrame = {rows, signature};
    return flushFrame();
  }

  function subscribe(listener, immediate) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    if (immediate !== false) listener(snapshot());
    return () => listeners.delete(listener);
  }

  function onCommand(listener) {
    if (typeof listener !== 'function') return () => {};
    commandListeners.add(listener);
    return () => commandListeners.delete(listener);
  }

  function dispatchCommand(command, meta) {
    commandListeners.forEach(listener => {
      try { listener(clone(command), meta || {}); } catch (error) { console.error(error); }
    });
  }

  if (Hub && typeof Hub.on === 'function') {
    Hub.on('command:lighting', (command, meta) => dispatchCommand(command, meta));
  }
  if (channel) {
    channel.onmessage = event => {
      const message = event.data;
      if (!message || message.source === 'gsl5') return;
      if (message.kind === 'command') dispatchCommand(message.command, {source:'runtime-channel'});
    };
  }

  function beginPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      check();
    }, 2000);
    check();
  }

  function endPolling() {
    clearInterval(pollTimer);
    pollTimer = 0;
  }

  global.addEventListener('pagehide', endPolling);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', beginPolling, {once:true});
  else beginPolling();

  global.ShowaveGSL5Bridge = Object.freeze({
    apiRoot:API_ROOT,
    channelName:CHANNEL_NAME,
    snapshot,
    subscribe,
    onCommand,
    check,
    adapters,
    nodes,
    discover,
    start,
    configure,
    stop,
    blackout,
    sendUniverses,
    normaliseUniverses,
    beginPolling,
    endPolling
  });
})(window);
