/* OpenLive MIDI Preferences
   -------------------------------------------------------------------------
   Resolume-inspired MIDI input, clock input, output feedback and monitoring.
   Web MIDI port objects stay local; serialisable routing intent is shared by
   every OpenLive window through OpenLiveHub.
   ------------------------------------------------------------------------- */
(() => {
  'use strict';

  const Hub = window.OpenLiveHub;
  if (!Hub || !document.querySelector('[data-midi-managed]')) return;
  const Runtime = window.OpenLiveMidiRuntime || null;

  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAX_MONITOR_ENTRIES = 200;
  const DEMO_DEVICES = [
    {
      id: 'midi:apc40-mkii', name: 'APC40 mkII', manufacturer: 'Akai', demo: true,
      connected: false, hasInput: true, hasOutput: true, inputPortId: null, outputPortId: null,
      inputEnabled: true, clockInputEnabled: false, outputEnabled: true
    },
    {
      id: 'midi:launchpad-pro-mk3', name: 'Launchpad Pro MK3', manufacturer: 'Novation', demo: true,
      connected: false, hasInput: true, hasOutput: true, inputPortId: null, outputPortId: null,
      inputEnabled: false, clockInputEnabled: false, outputEnabled: false
    },
    {
      id: 'midi:loopmidi-port', name: 'loopMIDI Port', manufacturer: 'Tobias Erichsen', demo: true,
      connected: false, hasInput: true, hasOutput: true, inputPortId: null, outputPortId: null,
      inputEnabled: true, clockInputEnabled: true, outputEnabled: false
    }
  ];

  let midiAccess = null;
  let applying = false;
  let messageSequence = 0;
  let monitorPaused = false;
  let monitorDirection = 'all';
  let monitorEntries = [];
  let monitorInCount = 0;
  let monitorOutCount = 0;
  let clockIntervals = [];
  let lastClockTickAt = 0;
  let lastClockPublishAt = 0;
  let accessRefreshBusy = false;
  let renderedTopology = '';
  const inputHandlers = new Map();
  const recentOutputSources = new Map();

  function hash(value) {
    let result = 2166136261;
    String(value).toLowerCase().split('').forEach(character => {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    });
    return (result >>> 0).toString(36);
  }

  function slug(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'device';
  }

  function defaultMidi() {
    return {
      access: { supported: null, requested: false, permission: 'idle', lastError: '', refreshedAt: 0 },
      devices: clone(DEMO_DEVICES),
      middleC: 'C4',
      clock: {
        sourceDeviceId: 'midi:loopmidi-port', stopMode: 'Start/Stop',
        state: 'Waiting for Start', running: false, bpm: 120,
        lastTickAt: 0, lastStartAt: 0
      },
      updatedAt: 0
    };
  }

  function normaliseMidi(value) {
    const base = defaultMidi();
    const source = value || {};
    const midi = Object.assign({}, base, source);
    midi.access = Object.assign({}, base.access, source.access || {});
    midi.clock = Object.assign({}, base.clock, source.clock || {});
    midi.devices = (Array.isArray(source.devices) ? source.devices : base.devices).filter(Boolean).map(device => ({
      id: device.id || `midi:${hash(`${device.manufacturer || ''}|${device.name || 'MIDI Device'}`)}`,
      name: device.name || 'MIDI Device', manufacturer: device.manufacturer || '',
      fingerprint: device.fingerprint || '', occurrence: Number(device.occurrence) || 1,
      connected: !!device.connected, demo: !!device.demo,
      hasInput: device.hasInput === true || !!device.inputPortId,
      hasOutput: device.hasOutput === true || !!device.outputPortId,
      inputPortId: device.inputPortId || null, outputPortId: device.outputPortId || null,
      inputEnabled: !!device.inputEnabled, clockInputEnabled: !!device.clockInputEnabled,
      outputEnabled: !!device.outputEnabled, state: device.state || (device.connected ? 'connected' : 'unavailable'),
      inputState: device.inputState || device.portState && device.portState.input || '',
      outputState: device.outputState || device.portState && device.portState.output || '',
      portState: Object.assign({ input: 'unavailable', output: 'unavailable' }, device.portState || {}),
      portErrors: Object.assign({ input: '', output: '' }, device.portErrors || {}),
      lastError: device.lastError || '', detectionIndex: Number(device.detectionIndex) || 0
    }));
    if (!midi.devices.length) midi.devices = clone(DEMO_DEVICES);
    if (!['Legacy', 'C3', 'C4'].includes(midi.middleC)) midi.middleC = 'C4';
    if (!['Start/Stop', 'Switch to Manual'].includes(midi.clock.stopMode)) midi.clock.stopMode = 'Start/Stop';

    const clockDevices = midi.devices.filter(device => device.clockInputEnabled);
    const preferred = midi.devices.find(device => device.id === midi.clock.sourceDeviceId && device.clockInputEnabled) || clockDevices[0];
    midi.devices.forEach(device => { device.clockInputEnabled = !!preferred && device.id === preferred.id; });
    midi.clock.sourceDeviceId = preferred && preferred.id || null;
    return midi;
  }

  function flatProjection(midi) {
    const values = {
      'midi.midi-middle-c.middle-c-note-60': midi.middleC,
      'midi.midi-clock.on-clock-stop': midi.clock.stopMode
    };
    midi.devices.forEach(device => {
      const key = slug(device.name);
      values[`midi.devices.${key}.input`] = !!device.inputEnabled;
      values[`midi.devices.${key}.clock-input`] = !!device.clockInputEnabled;
      values[`midi.devices.${key}.output`] = !!device.outputEnabled;
    });
    return values;
  }

  function updateMidi(mutator, reason, key, silent) {
    if (applying) return;
    let committed;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const midi = normaliseMidi(preferences.midi);
      mutator(midi, snapshot);
      midi.updatedAt = Date.now();
      preferences.midi = midi;
      preferences.values = Object.assign({}, preferences.values || {}, flatProjection(midi));
      preferences.updatedAt = midi.updatedAt;
      committed = clone(midi);
    }, { changedPath: 'preferences.midi', reason: reason || 'midi-preference-change' });
    if (!silent) {
      Hub.emit('openlive:preferences-changed', {
        section: 'midi', key: key || reason, midi: committed, values: flatProjection(committed)
      }, { activity: false });
      Hub.emit('openlive:midi-preferences-changed', { midi: committed, key: key || reason }, { activity: false });
    }
    return committed;
  }

  function noteName(number, middleC) {
    const numeric = Math.max(0, Math.min(127, Number(number) || 0));
    if (middleC === 'Legacy') return `${NOTES[numeric % 12]}${Math.floor(numeric / 12) - 1}`;
    const base = middleC === 'C3' ? 3 : 4;
    return `${NOTES[numeric % 12]}${base + Math.floor((numeric - 60) / 12)}`;
  }

  function portBase(port) {
    const manufacturer = String(port.manufacturer || '').trim().toLowerCase();
    const name = String(port.name || 'MIDI Device').trim()
      .replace(/^midi(?:in|out)\d*\s*\((.+)\)$/i, '$1')
      .replace(/\b(midi\s*)?(input|output|in|out)\b/ig, '').replace(/[\s_-]+/g, ' ').trim().toLowerCase();
    return `${manufacturer}|${name || String(port.name || '').trim().toLowerCase()}`;
  }

  function enumeratePorts(access) {
    const groups = new Map();
    const append = (port, type) => {
      const key = portBase(port);
      if (!groups.has(key)) groups.set(key, { inputs: [], outputs: [] });
      groups.get(key)[type === 'input' ? 'inputs' : 'outputs'].push(port);
    };
    access.inputs.forEach(port => append(port, 'input'));
    access.outputs.forEach(port => append(port, 'output'));
    const records = [];
    let detectionIndex = 0;
    groups.forEach((ports, fingerprint) => {
      const count = Math.max(ports.inputs.length, ports.outputs.length);
      for (let index = 0; index < count; index += 1) {
        const input = ports.inputs[index] || null;
        const output = ports.outputs[index] || null;
        const port = input || output;
        const occurrence = index + 1;
        records.push({
          id: `midi:${hash(`${fingerprint}|${occurrence}`)}`,
          name: port.name || 'MIDI Device', manufacturer: port.manufacturer || '',
          fingerprint, occurrence, detectionIndex: ++detectionIndex,
          connected: [input, output].some(item => item && item.state === 'connected'),
          demo: false, hasInput: !!input, hasOutput: !!output,
          inputPortId: input && input.id || null, outputPortId: output && output.id || null,
          state: [input, output].some(item => item && item.state === 'connected') ? 'connected' : 'disconnected',
          inputEnabled: false, clockInputEnabled: false, outputEnabled: false,
          lastError: ''
        });
      }
    });
    return records;
  }

  function mergeDiscovered(saved, discovered) {
    const unmatched = saved.slice();
    const result = discovered.map(record => {
      let index = unmatched.findIndex(item => item.id === record.id);
      if (index < 0) index = unmatched.findIndex(item => item.fingerprint && item.fingerprint === record.fingerprint &&
        Number(item.occurrence || 1) === Number(record.occurrence || 1));
      if (index < 0) index = unmatched.findIndex(item => String(item.name).toLowerCase() === String(record.name).toLowerCase() &&
        String(item.manufacturer || '').toLowerCase() === String(record.manufacturer || '').toLowerCase());
      const previous = index >= 0 ? unmatched.splice(index, 1)[0] : null;
      return Object.assign(record, previous ? {
        inputEnabled: !!previous.inputEnabled,
        clockInputEnabled: !!previous.clockInputEnabled,
        outputEnabled: !!previous.outputEnabled
      } : {});
    });
    unmatched.forEach(device => result.push(Object.assign({}, device, {
      connected: false, inputPortId: null, outputPortId: null,
      state: 'unavailable', lastError: device.lastError || ''
    })));
    return result;
  }

  function deviceMeta(device) {
    if (device.lastError) return device.lastError;
    if (device.connected) {
      const inputOnline = device.inputState ? /^(?:open|connected)$/.test(device.inputState) : device.hasInput;
      const outputOnline = device.outputState ? /^(?:open|connected)$/.test(device.outputState) : device.hasOutput;
      const ports = [inputOnline && 'Input online', outputOnline && 'Output online'].filter(Boolean).join(' + ');
      return `${device.manufacturer ? `${device.manufacturer} · ` : ''}${ports || 'Connected'} · detection ${device.detectionIndex || 1}`;
    }
    return `${device.demo ? 'Saved demo configuration' : 'Saved configuration'} · device unavailable`;
  }

  function renderDevices(midi) {
    const body = $('midiDevicesBody');
    body.innerHTML = '';
    midi.devices.forEach(device => {
      const row = document.createElement('tr');
      row.dataset.deviceId = device.id;
      row.innerHTML = `<td><span class="midi-device-name">${esc(device.name)}</span><span class="midi-device-meta">${esc(deviceMeta(device))}</span></td>` +
        `<td><input type="checkbox" data-midi-route="input" aria-label="${esc(device.name)} input"></td>` +
        `<td><input type="checkbox" data-midi-route="clock" aria-label="${esc(device.name)} clock input"></td>` +
        `<td><input type="checkbox" data-midi-route="output" aria-label="${esc(device.name)} output"></td>`;
      const input = row.querySelector('[data-midi-route="input"]');
      const clock = row.querySelector('[data-midi-route="clock"]');
      const output = row.querySelector('[data-midi-route="output"]');
      input.checked = !!device.inputEnabled;
      clock.checked = !!device.clockInputEnabled;
      output.checked = !!device.outputEnabled;
      input.disabled = !device.hasInput;
      clock.disabled = !device.hasInput;
      output.disabled = !device.hasOutput;
      body.appendChild(row);
    });

    const status = $('midiDevicesStatus');
    const connected = midi.devices.filter(device => device.connected).length;
    const inputs = midi.devices.filter(device => device.inputEnabled).length;
    const outputs = midi.devices.filter(device => device.outputEnabled).length;
    const activeInputs = midi.devices.filter(device => device.inputEnabled && device.inputPortId &&
      (!device.inputState || /^(?:open|connected)$/.test(device.inputState))).length;
    const activeOutputs = midi.devices.filter(device => device.outputEnabled && device.outputPortId &&
      (!device.outputState || /^(?:open|connected)$/.test(device.outputState))).length;
    const permission = String(midi.access.permission || 'idle');
    status.dataset.state = midi.access.lastError ? 'error' : connected ? 'ready' : 'warning';
    status.innerHTML = `<strong>${connected} connected · ${activeInputs}/${inputs} active shortcut inputs · ${activeOutputs}/${outputs} active feedback outputs.</strong> ` +
      (midi.access.lastError ? `${esc(midi.access.lastError)} ` : '') +
      (permission === 'granted'
        ? 'Refresh after connecting hardware. Detection order distinguishes identical controllers.'
        : permission === 'denied'
          ? 'MIDI permission was denied; use Enable / Refresh to retry.'
          : 'Enable / Refresh requests Web MIDI access. Saved offline rows keep their routing intent until hardware reconnects.');
    $('midiRefresh').textContent = accessRefreshBusy ? 'Refreshing…' : permission === 'granted' ? 'Refresh Devices' : 'Enable / Refresh';
    $('midiRefresh').disabled = accessRefreshBusy;
  }

  function renderClock(midi) {
    const source = midi.devices.find(device => device.id === midi.clock.sourceDeviceId);
    const status = $('midiClockStatus');
    const connected = source && source.connected;
    status.dataset.state = midi.clock.running && connected ? 'ready' : source ? 'warning' : 'warning';
    const state = source
      ? `${esc(midi.clock.state || 'Waiting for Start')} · ${Number(midi.clock.bpm || Hub.get('transport.bpm', 120)).toFixed(2)} BPM`
      : 'No Clock Input device selected.';
    status.innerHTML = `<strong>${source ? esc(source.name) : 'Manual clock'}.</strong> ${state}. ` +
      (connected
        ? 'MIDI Clock uses 24 timing ticks per quarter note.'
        : source ? 'The route is saved, but the device is unavailable. ' : '') +
      'MIDI Clock can be wavy; Ableton Link is tighter when available.';
  }

  function renderMiddleC(midi) {
    $('midiMiddleC').value = midi.middleC;
    const node = $('midiMiddleCStatus');
    node.dataset.state = 'ready';
    const example = noteName(60, midi.middleC);
    node.innerHTML = `<strong>Numeric note 60 displays as ${esc(example)}.</strong> ` +
      (midi.middleC === 'C3' ? 'Matches Ableton Live and most applications.' :
        midi.middleC === 'C4' ? 'Matches Traktor.' : 'Uses Resolume’s legacy octave notation.') +
      ' Incoming bytes and stored shortcut numbers are never transposed.';
  }

  function render(value) {
    const midi = normaliseMidi(value || Hub.get('preferences.midi'));
    applying = true;
    renderDevices(midi);
    renderMiddleC(midi);
    $('midiClockStopMode').value = midi.clock.stopMode;
    renderClock(midi);
    document.documentElement.dataset.olMidiPermission = midi.access.permission;
    document.documentElement.dataset.olMidiInputs = String(midi.devices.filter(device => device.inputEnabled).length);
    document.documentElement.dataset.olMidiOutputs = String(midi.devices.filter(device => device.outputEnabled).length);
    document.documentElement.dataset.olMidiClock = midi.clock.sourceDeviceId || 'manual';
    applying = false;
  }

  function uiTopology(value) {
    const midi = normaliseMidi(value);
    return JSON.stringify({
      access: midi.access,
      middleC: midi.middleC,
      stopMode: midi.clock.stopMode,
      sourceDeviceId: midi.clock.sourceDeviceId,
      devices: midi.devices.map(device => [
        device.id, device.name, device.connected, device.hasInput, device.hasOutput,
        device.inputPortId, device.outputPortId, device.inputEnabled,
        device.clockInputEnabled, device.outputEnabled, device.lastError,
        device.inputState, device.outputState, device.portState, device.portErrors
      ])
    });
  }

  function parseMessage(event, device) {
    const raw = [...(event.data || [])];
    const status = raw[0] || 0;
    const command = status & 0xf0;
    const channel = status < 0xf0 ? (status & 0x0f) + 1 : null;
    const number = raw[1] == null ? null : raw[1];
    const value = raw[2] == null ? null : raw[2];
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
    else if (status === 0xfe) type = 'activesensing';
    const id = `midi-${Date.now().toString(36)}-${(++messageSequence).toString(36)}`;
    return {
      id, at: Number(event.receivedTime || performance.now()) + (Date.now() - performance.now()),
      direction: 'in', deviceId: device.id, deviceName: device.name,
      type, channel, number, value, velocity: /note/.test(type) ? value : null,
      raw, target: '', source: 'web-midi'
    };
  }

  function messageKind(message) {
    return ['clock', 'start', 'continue', 'stop', 'songposition', 'activesensing'].includes(message.type) ? 'clock' : 'message';
  }

  function messageText(message, middleC) {
    if (message.type === 'noteon' || message.type === 'noteoff') {
      return `${message.type === 'noteon' ? 'Note On' : 'Note Off'} ${noteName(message.number, middleC)} (${message.number}) · velocity ${message.velocity ?? 0}`;
    }
    if (message.type === 'cc') return `CC ${message.number} · value ${message.value}`;
    if (message.type === 'pitchbend') return `Pitch Bend · ${(Number(message.value || 0) << 7) + Number(message.number || 0)}`;
    if (message.type === 'clock') return 'Clock Tick';
    if (message.type === 'start') return 'Clock Start';
    if (message.type === 'continue') return 'Clock Continue';
    if (message.type === 'stop') return 'Clock Stop';
    if (message.type === 'songposition') return 'Song Position';
    if (message.type === 'activesensing') return 'Active Sensing';
    return `Raw ${message.raw.map(value => value.toString(16).padStart(2, '0')).join(' ')}`;
  }

  function monitorMatches(message) {
    if (monitorDirection === 'all') return true;
    if (monitorDirection === 'clock') return messageKind(message) === 'clock';
    return message.direction === monitorDirection;
  }

  function renderMonitor() {
    const log = $('midiLog');
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    const visible = monitorEntries.filter(monitorMatches);
    if (!visible.length) {
      log.innerHTML = '<div class="midi-log-empty">No matching MIDI traffic. If the device is moving but this stays empty, check permission and the enabled port.</div>';
    } else {
      log.innerHTML = visible.map(message => {
        const time = new Date(message.at || Date.now()).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 });
        return `<div class="midi-log-entry" data-direction="${esc(message.direction)}" data-kind="${messageKind(message)}">` +
          `<span>${esc(time)}</span><b>${message.direction === 'out' ? 'OUT' : 'IN'}</b>` +
          `<span>${esc(message.deviceName || message.deviceId || 'MIDI')}</span>` +
          `<span>${message.channel ? `Ch ${message.channel}` : 'System'}</span>` +
          `<span>${esc(messageText(message, midi.middleC))}${message.target ? ` → ${esc(message.target)}` : ''}</span></div>`;
      }).join('');
      log.scrollTop = log.scrollHeight;
    }
    $('midiMonitorStatus').textContent = `${monitorInCount} in · ${monitorOutCount} out · ${monitorEntries.length}/${MAX_MONITOR_ENTRIES} retained`;
    $('midiMonitorPause').textContent = monitorPaused ? 'Resume' : 'Pause';
  }

  function recordMonitor(message) {
    if (!message || !message.id) return;
    const existing = monitorEntries.find(item => item.id === message.id);
    if (existing) Object.assign(existing, message);
    else {
      monitorEntries.push(clone(message));
      if (message.direction === 'out') monitorOutCount += 1;
      else monitorInCount += 1;
      if (monitorEntries.length > MAX_MONITOR_ENTRIES) monitorEntries.splice(0, monitorEntries.length - MAX_MONITOR_ENTRIES);
    }
    if (!monitorPaused) renderMonitor();
  }

  function annotateMonitor(detail) {
    if (!detail || !detail.sourceMessageId) return;
    const entry = monitorEntries.find(item => item.id === detail.sourceMessageId);
    if (!entry) return;
    entry.target = detail.target || 'Unmapped';
    entry.action = detail.action || '';
    if (!monitorPaused) renderMonitor();
  }

  function clockSourceEnabled(deviceId) {
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    return midi.devices.some(device => device.id === deviceId && device.clockInputEnabled);
  }

  function publishClock(message, bpm, state) {
    updateMidi((midi, snapshot) => {
      midi.clock.sourceDeviceId = message.deviceId;
      midi.clock.bpm = Number(bpm || midi.clock.bpm || snapshot.transport.bpm || 120);
      midi.clock.state = state || midi.clock.state;
      midi.clock.running = !/Stopped|Manual/i.test(midi.clock.state);
      midi.clock.lastTickAt = message.type === 'clock' ? Date.now() : midi.clock.lastTickAt;
      if (message.type === 'start' || message.type === 'continue') midi.clock.lastStartAt = Date.now();
      if (message.type === 'start' || message.type === 'continue') snapshot.transport.playState = 'Play';
      if (message.type === 'stop' && midi.clock.stopMode === 'Start/Stop') snapshot.transport.playState = 'Pause';
      if (Number.isFinite(Number(bpm))) snapshot.transport.bpm = Number(Number(bpm).toFixed(2));
    }, `midi-clock-${message.type}`, 'midi.clock', true);
  }

  function handleClock(message) {
    if (!clockSourceEnabled(message.deviceId)) return;
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    if (message.type === 'start' || message.type === 'continue') {
      clockIntervals = [];
      lastClockTickAt = 0;
      publishClock(message, midi.clock.bpm, `Following ${message.deviceName}`);
      return;
    }
    if (message.type === 'stop') {
      const state = midi.clock.stopMode === 'Start/Stop' ? 'Stopped by MIDI master' : 'Manual after MIDI Stop';
      publishClock(message, midi.clock.bpm, state);
      return;
    }
    if (message.type !== 'clock' || !midi.clock.running) return;
    const now = Number(message.at || Date.now());
    if (lastClockTickAt) {
      const interval = now - lastClockTickAt;
      if (interval > 2 && interval < 1000) {
        clockIntervals.push(interval);
        if (clockIntervals.length > 96) clockIntervals.shift();
      }
    }
    lastClockTickAt = now;
    if (clockIntervals.length < 12 || Date.now() - lastClockPublishAt < 450) return;
    lastClockPublishAt = Date.now();
    const sorted = clockIntervals.slice().sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * .12);
    const core = sorted.slice(trim, sorted.length - trim || sorted.length);
    const average = core.reduce((sum, value) => sum + value, 0) / core.length;
    const bpm = Math.max(20, Math.min(300, 60000 / (average * 24)));
    publishClock(message, bpm, `Following ${message.deviceName}`);
  }

  function handleInput(event, deviceId) {
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    const device = midi.devices.find(item => item.id === deviceId);
    if (!device) return;
    const message = parseMessage(event, device);
    const clockMessage = messageKind(message) === 'clock';
    if (clockMessage) {
      if (!device.clockInputEnabled) return;
      handleClock(message);
    } else if (!device.inputEnabled) return;
    Hub.emit('openlive:midi-message', message, { activity: false });
  }

  async function attachInputs() {
    if (!midiAccess) return;
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    for (const input of midiAccess.inputs.values()) {
      const device = midi.devices.find(item => item.inputPortId === input.id);
      const enabled = !!device && (device.inputEnabled || device.clockInputEnabled);
      if (!enabled) {
        input.onmidimessage = null;
        inputHandlers.delete(input.id);
        try { await input.close(); } catch (_) {}
        continue;
      }
      try {
        await input.open();
        const handler = event => handleInput(event, device.id);
        input.onmidimessage = handler;
        inputHandlers.set(input.id, handler);
      } catch (error) {
        updateMidi(state => {
          const failed = state.devices.find(item => item.id === device.id);
          if (failed) {
            failed.inputEnabled = false;
            failed.clockInputEnabled = false;
            failed.lastError = `Could not open MIDI input: ${error && error.message || 'port unavailable'}`;
          }
          if (state.clock.sourceDeviceId === device.id) state.clock.sourceDeviceId = null;
        }, 'midi-input-open-error', 'midi.devices');
      }
    }
  }

  async function refreshFromAccess(reason) {
    if (!midiAccess) return;
    const current = normaliseMidi(Hub.get('preferences.midi'));
    const discovered = enumeratePorts(midiAccess);
    updateMidi(midi => {
      midi.devices = mergeDiscovered(current.devices, discovered);
      midi.access.supported = true;
      midi.access.requested = true;
      midi.access.permission = 'granted';
      midi.access.lastError = '';
      midi.access.refreshedAt = Date.now();
    }, reason || 'midi-device-refresh', 'midi.devices');
    await attachInputs();
  }

  async function requestAccess() {
    if (accessRefreshBusy) return;
    if (Runtime && typeof Runtime.requestAccess === 'function') {
      accessRefreshBusy = true;
      render(Hub.get('preferences.midi'));
      try { await Runtime.requestAccess(); }
      catch (_) { /* Runtime already publishes the permission/port error. */ }
      finally { accessRefreshBusy = false; render(Hub.get('preferences.midi')); }
      return;
    }
    if (!navigator.requestMIDIAccess) {
      updateMidi(midi => {
        midi.access.supported = false;
        midi.access.requested = true;
        midi.access.permission = 'unsupported';
        midi.access.lastError = 'Web MIDI is unavailable in this browser.';
      }, 'midi-access-unsupported', 'midi.access');
      return;
    }
    accessRefreshBusy = true;
    render(Hub.get('preferences.midi'));
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false, software: true });
      midiAccess.onstatechange = () => refreshFromAccess('midi-device-hotplug');
      await refreshFromAccess('midi-access-granted');
    } catch (error) {
      updateMidi(midi => {
        midi.access.supported = true;
        midi.access.requested = true;
        midi.access.permission = error && (error.name === 'SecurityError' || error.name === 'NotAllowedError') ? 'denied' : 'error';
        midi.access.lastError = error && error.message || 'Could not access MIDI devices.';
      }, 'midi-access-error', 'midi.access');
    } finally {
      accessRefreshBusy = false;
      render(Hub.get('preferences.midi'));
    }
  }

  function bytesForOutput(payload) {
    if (Array.isArray(payload.raw) && payload.raw.length) return payload.raw.map(value => Number(value) & 0xff);
    const channel = Math.max(1, Math.min(16, Number(payload.channel) || 1)) - 1;
    const number = Math.max(0, Math.min(127, Number(payload.number) || 0));
    const value = Math.max(0, Math.min(127, Number(payload.value ?? payload.velocity ?? 0) || 0));
    if (payload.type === 'cc') return [0xb0 | channel, number, value];
    if (payload.type === 'noteoff' || (payload.type === 'note' && value === 0)) return [0x80 | channel, number, value];
    if (payload.type === 'note' || payload.type === 'noteon') return [0x90 | channel, number, value];
    return null;
  }

  async function sendOutput(payload) {
    if (!midiAccess || !payload) return;
    if (payload.sourceMessageId && recentOutputSources.has(payload.sourceMessageId)) return;
    const bytes = bytesForOutput(payload);
    if (!bytes) return;
    const midi = normaliseMidi(Hub.get('preferences.midi'));
    const targets = midi.devices.filter(device => device.outputEnabled && device.outputPortId &&
      (!payload.deviceId || payload.deviceId === 'all-enabled' || payload.deviceId === device.id));
    if (payload.sourceMessageId) {
      recentOutputSources.set(payload.sourceMessageId, Date.now());
      setTimeout(() => recentOutputSources.delete(payload.sourceMessageId), 1200);
    }
    for (const device of targets) {
      const output = midiAccess.outputs.get(device.outputPortId);
      if (!output) continue;
      try {
        await output.open();
        output.send(bytes);
        Hub.emit('openlive:midi-message', {
          id: `midi-out-${Date.now().toString(36)}-${(++messageSequence).toString(36)}`,
          at: Date.now(), direction: 'out', deviceId: device.id, deviceName: device.name,
          type: payload.type || 'note', channel: payload.channel || 1,
          number: payload.number, value: payload.value ?? payload.velocity ?? 0,
          velocity: payload.velocity ?? payload.value ?? 0, raw: bytes,
          target: payload.target || '', sourceMessageId: payload.sourceMessageId || null,
          source: 'openlive-feedback'
        }, { activity: false });
      } catch (error) {
        updateMidi(state => {
          const failed = state.devices.find(item => item.id === device.id);
          if (failed) {
            failed.outputEnabled = false;
            failed.lastError = `Could not open MIDI output: ${error && error.message || 'port unavailable'}`;
          }
        }, 'midi-output-open-error', 'midi.devices');
      }
    }
  }

  function migrateLegacyValues() {
    const current = Hub.get('preferences.midi', null);
    const values = Hub.get('preferences.values', {}) || {};
    if (current && Number(current.updatedAt) > 0) return;
    const relevant = Object.keys(values).some(key => key.startsWith('midi.'));
    if (!relevant) return;
    updateMidi(midi => {
      midi.devices.forEach(device => {
        const key = slug(device.name);
        const prefix = `midi.devices-monitor.${key}`;
        if (`${prefix}-input` in values) device.inputEnabled = !!values[`${prefix}-input`];
        if (`${prefix}-clock-in` in values) device.clockInputEnabled = !!values[`${prefix}-clock-in`];
        if (`${prefix}-output` in values) device.outputEnabled = !!values[`${prefix}-output`];
      });
      const middle = values['midi.midi-middle-c.middle-c-note-60'];
      if (['Legacy', 'C3', 'C4'].includes(middle)) midi.middleC = middle;
    }, 'midi-preferences-migrate', 'midi');
  }

  migrateLegacyValues();
  render(Hub.get('preferences.midi'));
  renderedTopology = uiTopology(Hub.get('preferences.midi'));

  $('midiRefresh').addEventListener('click', requestAccess);
  $('midiMonitorOpen').addEventListener('click', () => {
    $('midiMon').classList.add('show');
    renderMonitor();
  });
  $('midiDevicesBody').addEventListener('change', event => {
    const checkbox = event.target.closest('[data-midi-route]');
    const row = event.target.closest('tr[data-device-id]');
    if (!checkbox || !row) return;
    const route = checkbox.dataset.midiRoute;
    const deviceId = row.dataset.deviceId;
    const requestedEnabled = checkbox.checked;
    updateMidi(midi => {
      const device = midi.devices.find(item => item.id === deviceId);
      if (!device) return;
      device.lastError = '';
      if (route === 'input') device.inputEnabled = checkbox.checked;
      if (route === 'output') device.outputEnabled = checkbox.checked;
      if (route === 'clock') {
        midi.devices.forEach(item => { item.clockInputEnabled = item.id === device.id && checkbox.checked; });
        midi.clock.sourceDeviceId = checkbox.checked ? device.id : null;
        midi.clock.state = checkbox.checked ? 'Waiting for Start' : 'Manual';
        midi.clock.running = false;
        clockIntervals = [];
        lastClockTickAt = 0;
      }
    }, `midi-${route}-route`, `midi.devices.${deviceId}.${route}`);
    if (Runtime && typeof Runtime.sync === 'function') {
      Promise.resolve(Runtime.sync()).then(synced => {
        if (!synced || !requestedEnabled) return;
        const latest = normaliseMidi(Hub.get('preferences.midi')).devices.find(item => item.id === deviceId);
        const direction = route === 'output' ? 'output' : 'input';
        if (!latest || !latest.connected || latest.portState[direction] !== 'error') return;
        updateMidi(midi => {
          const failed = midi.devices.find(item => item.id === deviceId); if (!failed) return;
          if (route === 'input') failed.inputEnabled = false;
          if (route === 'output') failed.outputEnabled = false;
          if (route === 'clock') {
            failed.clockInputEnabled = false; midi.clock.sourceDeviceId = null;
            midi.clock.state = 'Manual'; midi.clock.running = false;
          }
        }, `midi-${route}-open-rollback`, `midi.devices.${deviceId}.${route}`);
      }).catch(() => {});
    }
    else attachInputs();
  });
  $('midiMiddleC').addEventListener('change', event => updateMidi(midi => {
    midi.middleC = event.target.value;
  }, 'midi-middle-c', 'midi.middleC'));
  $('midiClockStopMode').addEventListener('change', event => updateMidi(midi => {
    midi.clock.stopMode = event.target.value;
  }, 'midi-clock-stop-mode', 'midi.clock.stopMode'));
  $('midiMonitorDirection').addEventListener('change', event => {
    monitorDirection = event.target.value;
    renderMonitor();
  });
  $('midiMonitorPause').addEventListener('click', () => {
    monitorPaused = !monitorPaused;
    renderMonitor();
  });
  $('midiMonitorClear').addEventListener('click', () => {
    monitorEntries = [];
    monitorInCount = 0;
    monitorOutCount = 0;
    renderMonitor();
  });

  Hub.on('openlive:midi-message', recordMonitor);
  Hub.on('openlive:midi-mapped', annotateMonitor);
  if (!Runtime) Hub.on('openlive:midi-output', sendOutput);
  Hub.subscribe('preferences.midi', midi => {
    const nextTopology = uiTopology(midi);
    if (nextTopology !== renderedTopology) {
      render(midi);
      renderedTopology = nextTopology;
    } else renderClock(normaliseMidi(midi));
    if (!monitorPaused && $('midiMon').classList.contains('show')) renderMonitor();
    if (!Runtime && midiAccess) attachInputs();
  });

  const savedMidi = normaliseMidi(Hub.get('preferences.midi'));
  if (savedMidi.access.requested && savedMidi.access.permission === 'granted') {
    if (Runtime && typeof Runtime.sync === 'function') Runtime.sync();
    else requestAccess();
  }

  addEventListener('pagehide', () => {
    if (Runtime || !midiAccess) return;
    midiAccess.inputs.forEach(input => { input.onmidimessage = null; });
  });

  window.OpenLiveMidi = Object.freeze({
    get: () => normaliseMidi(Hub.get('preferences.midi')),
    requestAccess,
    noteName: number => noteName(number, normaliseMidi(Hub.get('preferences.midi')).middleC),
    send: payload => Runtime && typeof Runtime.send === 'function' ? Runtime.send(payload) : sendOutput(payload)
  });
})();
