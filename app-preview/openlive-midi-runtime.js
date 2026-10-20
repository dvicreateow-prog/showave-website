/* OpenLive shared Web MIDI runtime
   -------------------------------------------------------------------------
   Owns physical MIDI ports in exactly one OpenLive tab. Routing intent lives
   in OpenLiveHub, while MIDIAccess and MIDIPort objects remain tab-local.
   ------------------------------------------------------------------------- */
(function openLiveMidiRuntimeBootstrap(global) {
  'use strict';

  if (global.OpenLiveMidiRuntime) return;

  const Hub = global.OpenLiveHub;
  if (!Hub) return;

  const LOCK_NAME = 'openlive-midi-runtime';
  const LEASE_MS = 5000;
  const LEASE_HEARTBEAT_MS = 1800;
  const ELECTION_RETRY_MS = 2200;
  const CLOCK_PUBLISH_MS = 500;
  const MAX_CLOCK_INTERVALS = 96;
  const ownerId = `${Hub.clientId || 'openlive'}:midi:${Math.random().toString(36).slice(2, 9)}`;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  let access = null;
  let accessPromise = null;
  let accessAutoAttempted = false;
  let stopped = false;
  let owner = false;
  let ownershipMode = '';
  let lockRelease = null;
  let electionTimer = 0;
  let electionBusy = false;
  let leaseTimer = 0;
  let hotplugTimer = 0;
  let topologySignature = '';
  let syncPromise = Promise.resolve();
  let messageSequence = 0;
  let clockSourceId = null;
  let clockStarted = false;
  let lastClockTickAt = 0;
  let lastClockPublishAt = 0;
  let clockIntervals = [];
  const inputHandlers = new Map();
  const recentOutputSources = new Map();

  function now() {
    return Date.now();
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function hash(value) {
    let result = 2166136261;
    String(value).toLowerCase().split('').forEach(character => {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    });
    return (result >>> 0).toString(36);
  }

  function normaliseManufacturer(value) {
    return text(value).toLowerCase().replace(/\s+/g, ' ');
  }

  function cleanPortName(value) {
    let name = text(value) || 'MIDI Device';
    name = name.replace(/^\s*(?:midi(?:in|out)\d*|midi\s+(?:input|output)\s*\d*|(?:in|out)\s*\d+)\s*[:_\-]?\s*/i, '');
    if (/^\(.+\)$/.test(name)) name = name.slice(1, -1).trim();
    name = name.replace(/\s+(?:midi\s*)?(?:input|output|in|out)(?:\s*\d+)?\s*$/i, '').trim();
    return name || text(value) || 'MIDI Device';
  }

  function portFingerprint(port) {
    return `${normaliseManufacturer(port && port.manufacturer)}|${cleanPortName(port && port.name).toLowerCase()}`;
  }

  function deviceMatchName(device) {
    return `${normaliseManufacturer(device && device.manufacturer)}|${cleanPortName(device && device.name).toLowerCase()}`;
  }

  function defaultAccess() {
    return { supported: null, requested: false, permission: 'idle', lastError: '', refreshedAt: 0 };
  }

  function normaliseMidi(value) {
    const source = value && typeof value === 'object' ? value : {};
    const midi = Object.assign({}, source);
    midi.access = Object.assign(defaultAccess(), source.access || {});
    midi.devices = (Array.isArray(source.devices) ? source.devices : []).filter(Boolean).map(device => ({
      id: device.id || `midi:${hash(deviceMatchName(device))}`,
      name: device.name || 'MIDI Device',
      manufacturer: device.manufacturer || '',
      fingerprint: device.fingerprint || '',
      occurrence: Math.max(1, Number(device.occurrence) || 1),
      detectionIndex: Math.max(0, Number(device.detectionIndex) || 0),
      connected: !!device.connected,
      demo: !!device.demo,
      hasInput: device.hasInput !== false,
      hasOutput: device.hasOutput !== false,
      inputPortId: device.inputPortId || null,
      outputPortId: device.outputPortId || null,
      inputEnabled: !!device.inputEnabled,
      clockInputEnabled: !!device.clockInputEnabled,
      outputEnabled: !!device.outputEnabled,
      state: device.state || (device.connected ? 'connected' : 'unavailable'),
      portState: Object.assign({ input: 'unavailable', output: 'unavailable' }, device.portState || {}),
      portErrors: Object.assign({ input: '', output: '' }, device.portErrors || {}),
      lastError: device.lastError || ''
    }));
    midi.clock = Object.assign({
      sourceDeviceId: null, stopMode: 'Start/Stop', state: 'Waiting for Start',
      running: false, bpm: Number(Hub.get('transport.bpm', 120)) || 120,
      lastTickAt: 0, lastStartAt: 0
    }, source.clock || {});
    if (!['Start/Stop', 'Switch to Manual'].includes(midi.clock.stopMode)) midi.clock.stopMode = 'Start/Stop';

    const selected = midi.devices.find(device => device.clockInputEnabled && device.id === midi.clock.sourceDeviceId) ||
      midi.devices.find(device => device.clockInputEnabled);
    midi.devices.forEach(device => { device.clockInputEnabled = !!selected && device.id === selected.id; });
    midi.clock.sourceDeviceId = selected ? selected.id : null;
    return midi;
  }

  function topologyOf(value) {
    const midi = normaliseMidi(value);
    return JSON.stringify({
      permission: midi.access.permission,
      devices: midi.devices.map(device => [
        device.id, device.inputPortId, device.outputPortId,
        device.inputEnabled ? 1 : 0, device.clockInputEnabled ? 1 : 0,
        device.outputEnabled ? 1 : 0, device.hasInput ? 1 : 0,
        device.hasOutput ? 1 : 0, device.connected ? 1 : 0
      ])
    });
  }

  function enumeratePorts(midiAccess) {
    const groups = new Map();
    const append = (port, direction) => {
      const fingerprint = portFingerprint(port);
      if (!groups.has(fingerprint)) groups.set(fingerprint, { inputs: [], outputs: [] });
      groups.get(fingerprint)[direction].push(port);
    };
    midiAccess.inputs.forEach(port => append(port, 'inputs'));
    midiAccess.outputs.forEach(port => append(port, 'outputs'));

    const records = [];
    let detectionIndex = 0;
    groups.forEach((ports, fingerprint) => {
      const count = Math.max(ports.inputs.length, ports.outputs.length);
      for (let index = 0; index < count; index += 1) {
        const input = ports.inputs[index] || null;
        const output = ports.outputs[index] || null;
        const port = input || output;
        const occurrence = index + 1;
        const connected = [input, output].some(item => item && item.state === 'connected');
        records.push({
          id: `midi:${hash(`${fingerprint}|${occurrence}`)}`,
          name: cleanPortName(port && port.name),
          manufacturer: text(port && port.manufacturer),
          fingerprint,
          occurrence,
          detectionIndex: ++detectionIndex,
          connected,
          demo: false,
          hasInput: !!input,
          hasOutput: !!output,
          inputPortId: input ? input.id : null,
          outputPortId: output ? output.id : null,
          inputEnabled: false,
          clockInputEnabled: false,
          outputEnabled: false,
          state: connected ? 'connected' : 'disconnected',
          portState: {
            input: input ? (input.connection === 'open' ? 'open' : 'closed') : 'unavailable',
            output: output ? (output.connection === 'open' ? 'open' : 'closed') : 'unavailable'
          },
          portErrors: { input: '', output: '' },
          lastError: ''
        });
      }
    });
    return records;
  }

  function mergeDiscovered(savedDevices, discoveredDevices) {
    const unmatched = normaliseMidi({ devices: savedDevices }).devices.slice();
    const merged = discoveredDevices.map(record => {
      let index = unmatched.findIndex(device => device.id === record.id);
      if (index < 0) index = unmatched.findIndex(device =>
        device.fingerprint && device.fingerprint === record.fingerprint &&
        Number(device.occurrence || 1) === Number(record.occurrence || 1));
      if (index < 0) index = unmatched.findIndex(device =>
        deviceMatchName(device) === `${normaliseManufacturer(record.manufacturer)}|${cleanPortName(record.name).toLowerCase()}` &&
        Number(device.occurrence || 1) === Number(record.occurrence || 1));
      if (index < 0) index = unmatched.findIndex(device =>
        cleanPortName(device.name).toLowerCase() === cleanPortName(record.name).toLowerCase() &&
        Number(device.occurrence || 1) === Number(record.occurrence || 1));
      const saved = index >= 0 ? unmatched.splice(index, 1)[0] : null;
      if (!saved) return record;
      return Object.assign({}, record, {
        id: saved.id || record.id,
        inputEnabled: !!saved.inputEnabled,
        clockInputEnabled: !!saved.clockInputEnabled,
        outputEnabled: !!saved.outputEnabled,
        portErrors: Object.assign({ input: '', output: '' }, saved.portErrors || {}),
        lastError: saved.lastError || ''
      });
    });
    unmatched.forEach(saved => merged.push(Object.assign({}, saved, {
      connected: false,
      inputPortId: null,
      outputPortId: null,
      state: 'unavailable',
      portState: { input: 'unavailable', output: 'unavailable' }
    })));
    return merged;
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function updateAccess(patch, reason) {
    const current = Object.assign(defaultAccess(), Hub.get('preferences.midi.access', {}) || {});
    const next = Object.assign({}, current, patch || {});
    if (sameValue(current, next)) return;
    Hub.set('preferences.midi.access', next, { reason: reason || 'midi-runtime-access' });
  }

  function updateDevicePortState(deviceId, direction, state, error) {
    const devices = Hub.get('preferences.midi.devices', []) || [];
    const device = devices.find(item => item && item.id === deviceId);
    if (!device) return;
    const portState = Object.assign({ input: 'unavailable', output: 'unavailable' }, device.portState || {});
    const portErrors = Object.assign({ input: '', output: '' }, device.portErrors || {});
    portState[direction] = state;
    portErrors[direction] = error ? String(error) : '';
    const lastError = [portErrors.input, portErrors.output].filter(Boolean).join(' ');
    if (sameValue(device.portState || {}, portState) &&
        sameValue(device.portErrors || {}, portErrors) &&
        String(device.lastError || '') === lastError) return;
    Hub.transaction(snapshot => {
      const list = snapshot.preferences && snapshot.preferences.midi && snapshot.preferences.midi.devices;
      const target = Array.isArray(list) ? list.find(item => item && item.id === deviceId) : null;
      if (!target) return;
      target.portState = portState;
      target.portErrors = portErrors;
      target.lastError = lastError;
    }, { changedPath: `preferences.midi.devices.${deviceId}.portState`, reason: 'midi-port-state' });
  }

  function portError(prefix, error) {
    const detail = error && error.message ? error.message : 'port unavailable';
    return `${prefix}: ${detail}`;
  }

  async function refresh(reason) {
    if (!access) return [];
    const current = normaliseMidi(Hub.get('preferences.midi', {}));
    const merged = mergeDiscovered(current.devices, enumeratePorts(access));
    const nextTopology = topologyOf(Object.assign({}, current, { devices: merged, access: Object.assign({}, current.access, { permission: 'granted' }) }));
    const currentTopology = topologyOf(current);
    const shouldCommit = nextTopology !== currentTopology || current.access.permission !== 'granted' ||
      current.access.lastError || !current.access.requested;
    if (shouldCommit) {
      Hub.transaction(snapshot => {
        const preferences = snapshot.preferences || (snapshot.preferences = {});
        const midi = preferences.midi || (preferences.midi = {});
        midi.devices = clone(merged);
        midi.access = Object.assign(defaultAccess(), midi.access || {}, {
          supported: true,
          requested: true,
          permission: 'granted',
          lastError: '',
          refreshedAt: now()
        });
        midi.updatedAt = now();
      }, { changedPath: 'preferences.midi', reason: reason || 'midi-runtime-refresh' });
    } else {
      updateAccess({ refreshedAt: now() }, reason || 'midi-runtime-refresh-time');
    }
    if (isOwner()) await sync();
    return clone(merged);
  }

  function scheduleHotplugRefresh() {
    clearTimeout(hotplugTimer);
    hotplugTimer = setTimeout(() => {
      hotplugTimer = 0;
      refresh('midi-runtime-hotplug').catch(() => {});
    }, 160);
  }

  async function requestAccess(options) {
    if (access) {
      access.onstatechange = scheduleHotplugRefresh;
      await refresh(options && options.reason || 'midi-runtime-refresh');
      return access;
    }
    if (accessPromise) return accessPromise;
    if (!global.navigator || typeof global.navigator.requestMIDIAccess !== 'function') {
      updateAccess({
        supported: false,
        requested: true,
        permission: 'unsupported',
        lastError: 'Web MIDI is unavailable in this browser.'
      }, 'midi-runtime-unsupported');
      throw new Error('Web MIDI is unavailable in this browser.');
    }

    accessPromise = global.navigator.requestMIDIAccess({ sysex: false, software: true }).then(async midiAccess => {
      access = midiAccess;
      access.onstatechange = scheduleHotplugRefresh;
      await refresh(options && options.reason || 'midi-runtime-access-granted');
      return access;
    }).catch(error => {
      const denied = error && (error.name === 'SecurityError' || error.name === 'NotAllowedError');
      updateAccess({
        supported: true,
        requested: true,
        permission: denied ? 'denied' : 'error',
        lastError: error && error.message || 'Could not access MIDI devices.'
      }, 'midi-runtime-access-error');
      throw error;
    }).finally(() => {
      accessPromise = null;
    });
    return accessPromise;
  }

  function messageId(direction) {
    return `midi-${direction}-${now().toString(36)}-${(++messageSequence).toString(36)}-${hash(ownerId).slice(0, 5)}`;
  }

  function eventTime(event) {
    const received = Number(event && event.receivedTime);
    if (!Number.isFinite(received) || !global.performance) return now();
    return Math.round(received + (now() - global.performance.now()));
  }

  function parseInputMessage(event, device) {
    const raw = Array.from(event && event.data || [], value => Number(value) & 0xff);
    if (!raw.length || raw[0] === 0xfe) return null;
    const status = raw[0];
    const command = status & 0xf0;
    const channel = status < 0xf0 ? (status & 0x0f) + 1 : null;
    const number = raw.length > 1 ? raw[1] : null;
    const value = raw.length > 2 ? raw[2] : null;
    let type = 'unknown';
    if (command === 0x80 || (command === 0x90 && value === 0)) type = 'noteoff';
    else if (command === 0x90) type = 'noteon';
    else if (command === 0xb0) type = 'cc';
    else if (command === 0xe0) type = 'pitchbend';
    else if (status === 0xf8) type = 'clock';
    else if (status === 0xfa) type = 'start';
    else if (status === 0xfb) type = 'continue';
    else if (status === 0xfc) type = 'stop';
    else if (status === 0xf2) type = 'songposition';
    else if (status === 0xf0) type = 'sysex';
    return {
      id: messageId('in'),
      at: eventTime(event),
      direction: 'in',
      deviceId: device.id,
      deviceName: device.name,
      type,
      channel,
      number,
      value,
      velocity: type === 'noteon' || type === 'noteoff' ? value : null,
      raw
    };
  }

  function isClockType(type) {
    return ['clock', 'start', 'stop', 'continue', 'songposition'].includes(type);
  }

  function publishClock(message, state, bpm) {
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    const nextBpm = Number.isFinite(Number(bpm)) ? Number(Number(bpm).toFixed(2)) : Number(midi.clock.bpm) || 120;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const currentMidi = preferences.midi || (preferences.midi = {});
      const clock = currentMidi.clock || (currentMidi.clock = {});
      clock.sourceDeviceId = message.deviceId;
      clock.state = state;
      clock.running = clockStarted;
      clock.bpm = nextBpm;
      if (message.type === 'clock') clock.lastTickAt = now();
      if (message.type === 'start' || message.type === 'continue') clock.lastStartAt = now();
      const transport = snapshot.transport || (snapshot.transport = {});
      if (message.type === 'start' || message.type === 'continue') transport.playState = 'Play';
      if (message.type === 'stop' && midi.clock.stopMode === 'Start/Stop') transport.playState = 'Pause';
      if (Number.isFinite(nextBpm) && message.type === 'clock') transport.bpm = nextBpm;
    }, { changedPath: 'preferences.midi.clock', reason: `midi-runtime-clock-${message.type}` });
  }

  function resetClock(sourceId) {
    clockSourceId = sourceId || null;
    clockStarted = false;
    lastClockTickAt = 0;
    lastClockPublishAt = 0;
    clockIntervals = [];
  }

  function markClockWaiting(sourceId) {
    const current = normaliseMidi(Hub.get('preferences.midi', {}));
    const state = sourceId ? 'Waiting for Start' : 'Manual';
    if (current.clock.sourceDeviceId === (sourceId || null) &&
        current.clock.state === state && !current.clock.running) return;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const midi = preferences.midi || (preferences.midi = {});
      const clock = midi.clock || (midi.clock = {});
      clock.sourceDeviceId = sourceId || null;
      clock.state = state;
      clock.running = false;
    }, { changedPath: 'preferences.midi.clock', reason: 'midi-runtime-waiting-for-start' });
  }

  function handleClock(message) {
    if (message.deviceId !== clockSourceId) return;
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    if (message.type === 'start' || message.type === 'continue') {
      resetClock(message.deviceId);
      clockStarted = true;
      publishClock(message, `Following ${message.deviceName}`, midi.clock.bpm);
      return;
    }
    if (message.type === 'stop') {
      clockStarted = false;
      lastClockTickAt = 0;
      clockIntervals = [];
      const state = midi.clock.stopMode === 'Switch to Manual' ? 'Manual after MIDI Stop' : 'Stopped by MIDI master';
      publishClock(message, state, midi.clock.bpm);
      return;
    }
    if (message.type !== 'clock' || !clockStarted) return;
    const tickAt = Number(message.at) || now();
    if (lastClockTickAt) {
      const interval = tickAt - lastClockTickAt;
      if (interval > 2 && interval < 1000) {
        clockIntervals.push(interval);
        if (clockIntervals.length > MAX_CLOCK_INTERVALS) clockIntervals.shift();
      }
    }
    lastClockTickAt = tickAt;
    if (clockIntervals.length < 12 || now() - lastClockPublishAt < CLOCK_PUBLISH_MS) return;
    const sorted = clockIntervals.slice().sort((left, right) => left - right);
    const trim = Math.floor(sorted.length * 0.12);
    const core = sorted.slice(trim, sorted.length - trim || sorted.length);
    const average = core.reduce((sum, interval) => sum + interval, 0) / Math.max(1, core.length);
    const bpm = Math.max(20, Math.min(300, 60000 / (average * 24)));
    lastClockPublishAt = now();
    publishClock(message, `Following ${message.deviceName}`, bpm);
  }

  function handleInput(event, deviceId) {
    if (!isOwner()) return;
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    const device = midi.devices.find(item => item.id === deviceId);
    if (!device) return;
    const message = parseInputMessage(event, device);
    if (!message) return;
    if (isClockType(message.type)) {
      if (!device.clockInputEnabled) return;
      Hub.emit('openlive:midi-message', message, { activity: false });
      handleClock(message);
      return;
    }
    if (!device.inputEnabled) return;
    Hub.emit('openlive:midi-message', message, { activity: false });
  }

  async function closeInput(input, state) {
    if (!input) return;
    input.onmidimessage = null;
    inputHandlers.delete(input.id);
    try { await input.close(); } catch (_) { /* already unavailable */ }
    if (state) updateDevicePortState(state.id, 'input', state.connected ? 'closed' : 'unavailable', '');
  }

  async function attachInputs(midi) {
    if (!access || !isOwner()) return;
    const devicesByPort = new Map(midi.devices.filter(device => device.inputPortId).map(device => [device.inputPortId, device]));
    for (const input of access.inputs.values()) {
      const device = devicesByPort.get(input.id);
      const enabled = !!device && (device.inputEnabled || device.clockInputEnabled);
      if (!enabled) {
        await closeInput(input, device);
        continue;
      }
      const existing = inputHandlers.get(input.id);
      if (existing && existing.deviceId === device.id && input.connection === 'open') continue;
      try {
        await input.open();
        const handler = event => handleInput(event, device.id);
        input.onmidimessage = handler;
        inputHandlers.set(input.id, { deviceId: device.id, handler });
        updateDevicePortState(device.id, 'input', 'open', '');
      } catch (error) {
        input.onmidimessage = null;
        inputHandlers.delete(input.id);
        updateDevicePortState(device.id, 'input', 'error', portError('Could not open MIDI input', error));
      }
    }
  }

  async function validateOutputs(midi) {
    if (!access || !isOwner()) return;
    const devicesByPort = new Map(midi.devices.filter(device => device.outputPortId).map(device => [device.outputPortId, device]));
    for (const output of access.outputs.values()) {
      const device = devicesByPort.get(output.id);
      if (!device || !device.outputEnabled) {
        try { await output.close(); } catch (_) { /* already unavailable */ }
        if (device) updateDevicePortState(device.id, 'output', device.connected ? 'closed' : 'unavailable', '');
        continue;
      }
      try {
        await output.open();
        updateDevicePortState(device.id, 'output', 'open', '');
      } catch (error) {
        updateDevicePortState(device.id, 'output', 'error', portError('Could not open MIDI output', error));
      }
    }
  }

  function sync() {
    syncPromise = syncPromise.catch(() => {}).then(async () => {
      if (!access || !isOwner()) return false;
      const midi = normaliseMidi(Hub.get('preferences.midi', {}));
      const selectedClock = midi.devices.find(device => device.clockInputEnabled);
      if ((selectedClock && selectedClock.id || null) !== clockSourceId) {
        resetClock(selectedClock && selectedClock.id);
        markClockWaiting(selectedClock && selectedClock.id);
      }
      await attachInputs(midi);
      await validateOutputs(midi);
      return true;
    });
    return syncPromise;
  }

  function normaliseOutput(payload) {
    if (!payload || typeof payload !== 'object') return null;
    let type = String(payload.type || '').toLowerCase();
    const channel = Math.max(1, Math.min(16, Number(payload.channel) || 1));
    if (type === 'pitchbend') {
      const bend = Math.max(0, Math.min(16383, Math.round(Number(payload.value) || 0)));
      return { type, channel, number: bend & 0x7f, value: (bend >> 7) & 0x7f,
        bend, velocity: null, raw: [0xe0 | (channel - 1), bend & 0x7f, (bend >> 7) & 0x7f] };
    }
    const number = Math.max(0, Math.min(127, Number(payload.number != null ? payload.number : payload.note) || 0));
    const value = Math.max(0, Math.min(127, Number(payload.value != null ? payload.value : payload.velocity) || 0));
    if (type === 'note') type = payload.on === false || value === 0 ? 'noteoff' : 'noteon';
    if (!['noteon', 'noteoff', 'cc'].includes(type)) return null;
    const status = type === 'cc' ? 0xb0 : type === 'noteoff' ? 0x80 : 0x90;
    const bytes = [status | (channel - 1), number, value];
    return { type, channel, number, value, velocity: /^note/.test(type) ? value : null, raw: bytes };
  }

  async function sendOutput(payload) {
    if (!access || !isOwner()) return false;
    const message = normaliseOutput(payload);
    if (!message) return false;
    const sourceMessageId = payload && payload.sourceMessageId ? String(payload.sourceMessageId) : '';
    if (sourceMessageId && recentOutputSources.has(sourceMessageId)) return false;
    if (sourceMessageId) {
      recentOutputSources.set(sourceMessageId, now());
      setTimeout(() => recentOutputSources.delete(sourceMessageId), 1400);
    }
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    let targets = midi.devices.filter(device => device.outputEnabled && device.outputPortId);
    if (payload.deviceId && payload.deviceId !== 'all-enabled') {
      targets = targets.filter(device => device.id === payload.deviceId);
    }
    let sent = false;
    for (const device of targets) {
      const output = access.outputs.get(device.outputPortId);
      if (!output) {
        updateDevicePortState(device.id, 'output', 'unavailable', 'MIDI output is disconnected.');
        continue;
      }
      try {
        if (output.connection !== 'open') await output.open();
        output.send(message.raw);
        updateDevicePortState(device.id, 'output', 'open', '');
        Hub.emit('openlive:midi-message', Object.assign({
          id: messageId('out'),
          at: now(),
          direction: 'out',
          deviceId: device.id,
          deviceName: device.name
        }, message), { activity: false });
        sent = true;
      } catch (error) {
        updateDevicePortState(device.id, 'output', 'error', portError('Could not send MIDI output', error));
      }
    }
    return sent;
  }

  function send(payload) {
    Hub.emit('openlive:midi-output', clone(payload || {}), { activity: false });
    return true;
  }

  function leaseValue() {
    return Hub.get('preferences.midi.runtimeLease', {}) || {};
  }

  function writeLease(mode) {
    const lease = leaseValue();
    if (lease.ownerId && lease.ownerId !== ownerId && Number(lease.expiresAt) > now() && mode === 'lease') return false;
    Hub.set('preferences.midi.runtimeLease', {
      ownerId,
      mode,
      claimedAt: lease.ownerId === ownerId ? Number(lease.claimedAt) || now() : now(),
      heartbeatAt: now(),
      expiresAt: now() + LEASE_MS
    }, { reason: 'midi-runtime-lease' });
    return true;
  }

  function clearLease() {
    const lease = leaseValue();
    if (lease.ownerId !== ownerId) return;
    Hub.set('preferences.midi.runtimeLease', {
      ownerId: '', mode: '', claimedAt: 0, heartbeatAt: now(), expiresAt: 0
    }, { reason: 'midi-runtime-release' });
  }

  function isOwner() {
    if (!owner || stopped) return false;
    if (ownershipMode !== 'lease') return true;
    const lease = leaseValue();
    if (lease.ownerId === ownerId && Number(lease.expiresAt) > now()) return true;
    loseOwnership().catch(() => {});
    return false;
  }

  function startLeaseHeartbeat() {
    clearInterval(leaseTimer);
    writeLease(ownershipMode || 'lease');
    leaseTimer = setInterval(() => {
      if (!owner || stopped) return;
      if (ownershipMode === 'lease') {
        const lease = leaseValue();
        if (lease.ownerId && lease.ownerId !== ownerId && Number(lease.expiresAt) > now()) {
          loseOwnership().catch(() => {});
          return;
        }
      }
      writeLease(ownershipMode || 'lease');
    }, LEASE_HEARTBEAT_MS);
  }

  async function becomeOwner(mode) {
    if (stopped || owner) return;
    owner = true;
    ownershipMode = mode;
    startLeaseHeartbeat();
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    resetClock(midi.clock.sourceDeviceId);
    markClockWaiting(midi.clock.sourceDeviceId);
    if (!access && midi.access.permission === 'granted') {
      accessAutoAttempted = true;
      try { await requestAccess({ reason: 'midi-runtime-owner-access' }); } catch (_) { /* reflected in Hub */ }
    } else if (access) {
      access.onstatechange = scheduleHotplugRefresh;
      await sync();
    }
  }

  async function closeAllPorts() {
    if (!access) return;
    access.onstatechange = null;
    const midi = normaliseMidi(Hub.get('preferences.midi', {}));
    const byInputPort = new Map(midi.devices.filter(device => device.inputPortId).map(device => [device.inputPortId, device]));
    const byOutputPort = new Map(midi.devices.filter(device => device.outputPortId).map(device => [device.outputPortId, device]));
    for (const input of access.inputs.values()) {
      input.onmidimessage = null;
      try { await input.close(); } catch (_) { /* disconnected */ }
      const device = byInputPort.get(input.id);
      if (device) updateDevicePortState(device.id, 'input', device.connected ? 'closed' : 'unavailable', '');
    }
    for (const output of access.outputs.values()) {
      try { await output.close(); } catch (_) { /* disconnected */ }
      const device = byOutputPort.get(output.id);
      if (device) updateDevicePortState(device.id, 'output', device.connected ? 'closed' : 'unavailable', '');
    }
    inputHandlers.clear();
  }

  async function loseOwnership() {
    if (!owner) return;
    owner = false;
    const previousMode = ownershipMode;
    ownershipMode = '';
    clearInterval(leaseTimer);
    leaseTimer = 0;
    await closeAllPorts();
    if (previousMode === 'lease') clearLease();
    resetClock(null);
    if (!stopped) scheduleElection(ELECTION_RETRY_MS);
  }

  function scheduleElection(delay) {
    if (stopped || owner || electionTimer) return;
    electionTimer = setTimeout(() => {
      electionTimer = 0;
      electOwner().catch(() => scheduleElection(ELECTION_RETRY_MS));
    }, Math.max(0, Number(delay) || 0));
  }

  async function claimFallbackLease() {
    const first = leaseValue();
    if (first.ownerId && first.ownerId !== ownerId && Number(first.expiresAt) > now()) return false;
    await new Promise(resolve => setTimeout(resolve, 90 + Math.floor(Math.random() * 130)));
    const second = leaseValue();
    if (second.ownerId && second.ownerId !== ownerId && Number(second.expiresAt) > now()) return false;
    if (!writeLease('lease')) return false;
    await new Promise(resolve => setTimeout(resolve, 90));
    const confirmed = leaseValue();
    return confirmed.ownerId === ownerId && Number(confirmed.expiresAt) > now();
  }

  async function electWithWebLock() {
    const locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== 'function') return false;
    await locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock || stopped) return;
      const lease = leaseValue();
      if (lease.ownerId && lease.ownerId !== ownerId && Number(lease.expiresAt) > now()) return;
      await becomeOwner('web-lock');
      await new Promise(resolve => { lockRelease = resolve; });
      lockRelease = null;
      await loseOwnership();
    });
    return true;
  }

  async function electOwner() {
    if (stopped || owner || electionBusy) return;
    electionBusy = true;
    try {
      const hasLocks = !!(global.navigator && global.navigator.locks && typeof global.navigator.locks.request === 'function');
      if (hasLocks) {
        await electWithWebLock();
      } else if (await claimFallbackLease()) {
        await becomeOwner('lease');
      }
    } catch (_) {
      if (await claimFallbackLease()) await becomeOwner('lease');
    } finally {
      electionBusy = false;
      if (!stopped && !owner) scheduleElection(ELECTION_RETRY_MS);
    }
  }

  function handlePreferenceChange(value) {
    if (stopped) return;
    const nextSignature = topologyOf(value);
    if (nextSignature !== topologySignature) {
      topologySignature = nextSignature;
      if (isOwner() && access) sync().catch(() => {});
    }
    const midi = normaliseMidi(value);
    if (isOwner() && !access && !accessAutoAttempted && midi.access.permission === 'granted') {
      accessAutoAttempted = true;
      requestAccess({ reason: 'midi-runtime-auto-access' }).catch(() => {});
    }
  }

  async function teardown() {
    if (stopped) return;
    stopped = true;
    clearTimeout(electionTimer);
    clearTimeout(hotplugTimer);
    clearInterval(leaseTimer);
    electionTimer = 0;
    hotplugTimer = 0;
    leaseTimer = 0;
    if (lockRelease) lockRelease();
    await closeAllPorts();
    clearLease();
    owner = false;
    ownershipMode = '';
  }

  Hub.on('openlive:midi-output', payload => {
    if (isOwner()) sendOutput(payload).catch(() => {});
  });
  Hub.subscribe('preferences.midi', handlePreferenceChange);

  global.addEventListener('pagehide', () => { teardown().catch(() => {}); }, { once: true });
  global.addEventListener('beforeunload', () => { teardown().catch(() => {}); }, { once: true });

  global.OpenLiveMidiRuntime = Object.freeze({
    requestAccess,
    refresh,
    sync,
    send,
    isOwner,
    getAccess: () => access
  });

  Promise.resolve(typeof Hub.ready === 'function' ? Hub.ready() : null)
    .catch(() => null)
    .then(() => scheduleElection(Math.floor(Math.random() * 180)));
})(window);
