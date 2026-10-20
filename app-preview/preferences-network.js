/* OpenLive network preferences
   -------------------------------------------------------------------------
   Shared, typed controllers for OSC, Art-Net/DMX and the Arena webserver
   client target. A browser cannot bind UDP or TCP listeners, so this module
   records configuration and exchanges explicit Hub events without claiming
   that native packets or servers exist.
   ------------------------------------------------------------------------- */
(function openLiveNetworkPreferencesBootstrap(global) {
  'use strict';

  if (global.OpenLiveNetworkPreferences) return;

  const Hub = global.OpenLiveHub;
  if (!Hub) {
    console.error('preferences-network.js requires openlive-hub.js');
    return;
  }

  const $ = id => document.getElementById(id);
  const clone = value => {
    if (value == null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const now = () => Date.now();
  const text = value => String(value == null ? '' : value).trim();
  const isArenaRuntime = () => /(?:^|\/)index\.html$/i.test(location.pathname || '') || !!$('gridTable');

  let applying = false;
  let monitorPaused = false;
  let monitorDirection = 'all';
  let monitorEntries = [];
  let monitorCounts = { in: 0, out: 0 };
  let dmxMonitorRunning = false;
  let dmxMonitorCounts = { mapped: 0, unmapped: 0, ignored: 0, frames: 0, updates: 0 };
  let dmxMonitorLastAt = 0;
  let dmxMonitorSelectedChannel = null;
  let dmxMonitorRenderHandle = 0;
  let dmxMonitorFullRender = true;
  let dmxMonitorRecentTimer = 0;
  let lastInteractedDmxInputId = null;
  let dmxAdapterRequestAt = 0;
  let dmxNodePollAt = 0;
  const dmxMonitorMessageIds = new Set();
  const dmxMonitorUniverses = new Map();
  const dmxMonitorHistory = new Map();
  const dmxMonitorDirtyChannels = new Set();
  const DMX_HISTORY_PER_CHANNEL = 24;
  const DMX_HISTORY_CHANNEL_LIMIT = 2048;
  let directoryHandle = null;

  const DEFAULT_OSC = Object.freeze({
    input: { enabled: true, port: 7000, zeroconf: true },
    output: {
      enabled: false, destination: 'Localhost', address: '127.0.0.1',
      port: 7001, bundles: true
    },
    transport: { mode: 'SHOWAVE bridge', status: 'Ready', lastError: '' },
    updatedAt: 0
  });
  const DEFAULT_DMX = Object.freeze({
    adapter: { id: 'automatic', label: 'Automatic', address: '0.0.0.0', status: 'Configuration only' },
    adapters: [{ id: 'automatic', label: 'Automatic', address: '0.0.0.0', available: null, kind: 'automatic' }],
    artnet: { nodeName: 'SHOWAVE Live', outputFramerate: 40, outputDelayMs: 40, sendArtSync: false },
    nodes: [],
    runtime: {
      bridgeStatus: 'unavailable', bound: false, receiving: false, synchronized: false,
      lastPacketAt: 0, packetCount: 0, lastError: ''
    },
    outputLumiverses: [],
    inputs: [{ id: 'dmx-input:1', name: 'DMX Input 1', channelOffset: 0, subnet: 0, universe: 0, enabled: true }],
    selectedInputId: 'dmx-input:1', updatedAt: 0
  });
  const DEFAULT_WEBSERVER = Object.freeze({
    enabled: false, listenAddress: '0.0.0.0', port: 8080,
    rootDirectory: 'Documents\\Resolume Arena\\Webserver',
    targetHost: '127.0.0.1:8080', status: 'Disabled', lastProbeAt: 0,
    lastError: '', updatedAt: 0
  });

  function bool(value, fallback) {
    if (value == null) return !!fallback;
    if (typeof value === 'string') {
      if (/^(false|0|off|no)$/i.test(value.trim())) return false;
      if (/^(true|1|on|yes)$/i.test(value.trim())) return true;
    }
    return !!value;
  }

  function integer(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
  }

  function validPort(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 65535;
  }

  function parsePort(value, label) {
    if (!validPort(value)) throw new Error(`${label || 'Port'} must be a whole number from 1 to 65535.`);
    return Number(value);
  }

  function isIPv4(value) {
    const parts = text(value).split('.');
    return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }

  function isIPv6(value) {
    const candidate = text(value).replace(/^\[|\]$/g, '').split('%')[0];
    if (!candidate.includes(':')) return false;
    try {
      const parsed = new URL(`http://[${candidate}]/`);
      return !!parsed.hostname;
    } catch (_) {
      return false;
    }
  }

  function isHostname(value) {
    const candidate = text(value).toLowerCase();
    if (candidate === 'localhost') return true;
    if (!candidate || candidate.length > 253 || /^[\d.]+$/.test(candidate)) return false;
    return candidate.split('.').every(label =>
      /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
  }

  function validNetworkAddress(value, options) {
    const candidate = text(value);
    const opts = options || {};
    if (opts.allowAny && (candidate === '0.0.0.0' || candidate === '::' || candidate === '[::]')) return true;
    return isIPv4(candidate) || isIPv6(candidate) || (opts.allowHostname && isHostname(candidate));
  }

  function status(id, message, state) {
    const node = $(id);
    if (!node) return;
    node.textContent = message || '';
    node.dataset.state = state || '';
  }

  function optionText(select) {
    return select && select.selectedOptions && select.selectedOptions[0]
      ? select.selectedOptions[0].textContent.trim() : '';
  }

  function isLoopbackAddress(value) {
    const candidate = text(value).replace(/^\[|\]$/g, '').toLowerCase();
    return candidate === 'localhost' || candidate === '::1' || /^127\./.test(candidate);
  }

  function normaliseDmxAdapter(source, index) {
    const raw = source || {};
    const address = validNetworkAddress(raw.address, { allowAny: true }) ? text(raw.address) : '';
    const id = text(raw.id) || (address ? `adapter:${address}` : `adapter:${index + 1}`);
    const rawLabel = text(raw.label || raw.name) || (address || `Adapter ${index + 1}`);
    const labelParts = rawLabel.split(/\s+\u2014\s+/).filter(Boolean);
    const label = labelParts.filter((part, partIndex) => part !== address || partIndex === labelParts.indexOf(address)).join(': ');
    return {
      id,
      label,
      address: address || (id === 'automatic' ? '0.0.0.0' : ''),
      available: raw.available == null ? null : bool(raw.available, false),
      kind: text(raw.kind) || (id === 'automatic' ? 'automatic' : isLoopbackAddress(address) ? 'loopback' : 'network'),
      status: text(raw.status),
      discoveredAt: Number(raw.discoveredAt || raw.at) || 0
    };
  }

  function normaliseDmxAdapters(source, selectedAdapter) {
    const list = Array.isArray(source) ? source : [];
    const result = [];
    const ids = new Set();
    [DEFAULT_DMX.adapters[0], ...list, selectedAdapter].filter(Boolean).forEach((item, index) => {
      const adapter = normaliseDmxAdapter(item, index);
      if (ids.has(adapter.id)) {
        const at = result.findIndex(entry => entry.id === adapter.id);
        if (at >= 0) result[at] = Object.assign({}, result[at], adapter);
        return;
      }
      ids.add(adapter.id);
      result.push(adapter);
    });
    return result;
  }

  function normaliseDmxNode(source, index) {
    const raw = source || {};
    const ip = validNetworkAddress(raw.ip || raw.address, { allowHostname: true }) ? text(raw.ip || raw.address) : '';
    const ports = Array.isArray(raw.ports) ? raw.ports.map(item => clone(item))
      : raw.ports == null ? [] : [clone(raw.ports)];
    return {
      id: text(raw.id) || (ip ? `artnet-node:${ip}` : `artnet-node:${index + 1}`),
      name: text(raw.name || raw.shortName || raw.longName) || (ip || `Art-Net Node ${index + 1}`),
      ip,
      status: text(raw.status || raw.report),
      lastSeenAt: Number(raw.lastSeenAt || raw.at) || 0,
      ports
    };
  }

  function normaliseDmxRuntime(source) {
    const raw = source || {};
    return {
      bridgeStatus: text(raw.bridgeStatus || raw.status) || DEFAULT_DMX.runtime.bridgeStatus,
      bound: bool(raw.bound, DEFAULT_DMX.runtime.bound),
      receiving: bool(raw.receiving, DEFAULT_DMX.runtime.receiving),
      synchronized: bool(raw.synchronized, DEFAULT_DMX.runtime.synchronized),
      lastPacketAt: Number(raw.lastPacketAt) || 0,
      packetCount: Math.max(0, Math.trunc(Number(raw.packetCount) || 0)),
      lastError: text(raw.lastError)
    };
  }

  function normaliseOsc(source) {
    const raw = source || {};
    const input = raw.input || {};
    const output = raw.output || {};
    const transport = raw.transport || {};
    let destination = text(output.destination);
    if (!['Localhost', 'Broadcast', 'Manual IP'].includes(destination)) {
      destination = /^(255\.255\.255\.255|broadcast)$/i.test(text(output.address))
        ? 'Broadcast' : /^(127\.|localhost|::1|\[::1\])/.test(text(output.address))
          ? 'Localhost' : 'Manual IP';
    }
    return {
      input: {
        enabled: bool(input.enabled, DEFAULT_OSC.input.enabled),
        port: integer(input.port, DEFAULT_OSC.input.port, 1, 65535),
        zeroconf: bool(input.zeroconf, DEFAULT_OSC.input.zeroconf)
      },
      output: {
        enabled: bool(output.enabled, DEFAULT_OSC.output.enabled),
        destination,
        address: validNetworkAddress(output.address) ? text(output.address) : DEFAULT_OSC.output.address,
        port: integer(output.port, DEFAULT_OSC.output.port, 1, 65535),
        bundles: bool(output.bundles, DEFAULT_OSC.output.bundles)
      },
      transport: {
        mode: text(transport.mode) === 'OpenLive bridge' ? 'SHOWAVE bridge' :
          (text(transport.mode) || DEFAULT_OSC.transport.mode),
        status: text(transport.status) || DEFAULT_OSC.transport.status,
        lastError: text(transport.lastError)
      },
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function normaliseDmx(source) {
    const raw = source || {};
    const rawAdapter = raw.adapter || DEFAULT_DMX.adapter;
    const artnet = raw.artnet || {};
    const requestedAdapterId = text(rawAdapter.id) || 'automatic';
    let adapters = normaliseDmxAdapters(raw.adapters, null);
    if (!adapters.some(item => item.id === requestedAdapterId)) {
      adapters = normaliseDmxAdapters(adapters, rawAdapter);
    }
    const selectedAdapter = adapters.find(item => item.id === requestedAdapterId) || adapters[0];
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(normaliseDmxNode);
    const runtime = normaliseDmxRuntime(raw.runtime);
    const usedOutputIds = new Set();
    const outputLumiverses = (Array.isArray(raw.outputLumiverses) ? raw.outputLumiverses : [])
      .map((item, index) => {
        const source = item || {};
        let id = text(source.id || source.screenId) || `dmx-output:${index + 1}`;
        while (usedOutputIds.has(id)) id = `${id}-${index + 1}`;
        usedOutputIds.add(id);
        const subnet = Number(source.subnet);
        const universe = Number(source.universe);
        const outputEnabled = bool(source.outputEnabled, source.enabled !== false);
        return {
          id,
          screenId: text(source.screenId || source.id) || id,
          name: text(source.name) || `Lumiverse ${index + 1}`,
          lumiverseId: text(source.lumiverseId),
          device: text(source.device || source.outputDevice) || 'SHOWAVE Map',
          targetIp: text(source.targetIp || source.targetIP || source.address),
          targetMode: text(source.targetMode),
          targetNodeName: text(source.targetNodeName || source.nodeName),
          subnet: Number.isInteger(subnet) && subnet >= 0 && subnet <= 15 ? subnet : null,
          universe: Number.isInteger(universe) && universe >= 0 && universe <= 15 ? universe : null,
          outputEnabled,
          enabled: bool(source.enabled, true),
          autoSpan: bool(source.autoSpan, true),
          alignOutput: bool(source.alignOutput, true),
          fixtureCount: integer(source.fixtureCount, 0, 0, 65535),
          channelCount: integer(source.channelCount, 0, 0, 65535),
          lastChannel: integer(source.lastChannel, 0, 0, 65535),
          patches: Array.isArray(source.patches) ? clone(source.patches) : [],
          warnings: Array.isArray(source.warnings) ? source.warnings.map(value => text(value)).filter(Boolean) : [],
          patchSummary: source.patchSummary == null ? null : clone(source.patchSummary)
        };
      });
    const usedIds = new Set();
    const inputs = (Array.isArray(raw.inputs) ? raw.inputs : DEFAULT_DMX.inputs).map((item, index) => {
      let id = text(item && item.id) || `dmx-input:${index + 1}`;
      while (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);
      return {
        id,
        name: text(item && item.name) || `DMX Input ${index + 1}`,
        channelOffset: integer(item && item.channelOffset, 0, 0, 511),
        subnet: integer(item && item.subnet, 0, 0, 15),
        universe: integer(item && item.universe, 0, 0, 15),
        enabled: bool(item && item.enabled, true)
      };
    });
    const selected = text(raw.selectedInputId);
    return {
      adapter: {
        id: selectedAdapter.id,
        label: selectedAdapter.label,
        address: selectedAdapter.address,
        status: text(rawAdapter.status || selectedAdapter.status) || 'Configuration only'
      },
      adapters,
      artnet: {
        nodeName: text(artnet.nodeName) === 'OpenLive Arena' ? 'SHOWAVE Live' :
          (text(artnet.nodeName) || DEFAULT_DMX.artnet.nodeName),
        outputFramerate: integer(artnet.outputFramerate, DEFAULT_DMX.artnet.outputFramerate, 1, 60),
        outputDelayMs: integer(artnet.outputDelayMs, DEFAULT_DMX.artnet.outputDelayMs, 0, 200),
        sendArtSync: bool(artnet.sendArtSync, DEFAULT_DMX.artnet.sendArtSync)
      },
      nodes,
      runtime,
      outputLumiverses,
      inputs,
      selectedInputId: inputs.some(item => item.id === selected) ? selected : (inputs[0] && inputs[0].id) || null,
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function normaliseWebserver(source) {
    const raw = source || {};
    let targetHost = DEFAULT_WEBSERVER.targetHost;
    try { targetHost = normaliseTargetHost(raw.targetHost || targetHost); } catch (_) { /* use canonical default */ }
    return {
      enabled: bool(raw.enabled, DEFAULT_WEBSERVER.enabled),
      listenAddress: validNetworkAddress(raw.listenAddress, { allowAny: true })
        ? text(raw.listenAddress) : DEFAULT_WEBSERVER.listenAddress,
      port: integer(raw.port, DEFAULT_WEBSERVER.port, 1, 65535),
      rootDirectory: text(raw.rootDirectory) || DEFAULT_WEBSERVER.rootDirectory,
      targetHost,
      status: text(raw.status) || DEFAULT_WEBSERVER.status,
      lastProbeAt: Number(raw.lastProbeAt) || 0,
      lastError: text(raw.lastError),
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function effectiveOscAddress(osc) {
    if (osc.output.destination === 'Localhost') return '127.0.0.1';
    if (osc.output.destination === 'Broadcast') return '255.255.255.255';
    return osc.output.address;
  }

  function oscSelfLoop(osc) {
    if (!osc.input.enabled || !osc.output.enabled || osc.input.port !== osc.output.port) return false;
    if (osc.output.destination === 'Localhost') return true;
    if (osc.output.destination === 'Broadcast') return false;
    const address = effectiveOscAddress(osc).replace(/^\[|\]$/g, '').toLowerCase();
    const localNames = new Set(['127.0.0.1', '::1', 'localhost']);
    if (location.hostname) localNames.add(location.hostname.toLowerCase());
    return localNames.has(address) || /^127\./.test(address);
  }

  function duplicateDmxPairs(dmx) {
    const pairs = new Map();
    dmx.inputs.filter(item => item.enabled).forEach(item => {
      const key = `${item.subnet}:${item.universe}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(item.name);
    });
    return [...pairs.entries()].filter(([, names]) => names.length > 1);
  }

  function duplicateDmxOutputPairs(dmx) {
    const pairs = new Map();
    dmx.outputLumiverses
      .filter(item => item.enabled && item.outputEnabled && item.subnet != null && item.universe != null)
      .forEach(item => {
        const key = `${item.subnet}:${item.universe}`;
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push(item.name);
      });
    return [...pairs.entries()].filter(([, names]) => names.length > 1);
  }

  function oscFlat(osc) {
    return {
      'osc.input.osc-input': osc.input.enabled,
      'osc.input.incoming-port': osc.input.port,
      'osc.input.announce-with-zeroconf': osc.input.zeroconf,
      'osc.output.osc-output': osc.output.enabled,
      'osc.output.destination': osc.output.destination,
      'osc.output.outgoing-address': effectiveOscAddress(osc),
      'osc.output.outgoing-port': osc.output.port,
      'osc.output.use-bundles': osc.output.bundles
    };
  }

  function dmxFlat(dmx) {
    return {
      'dmx.artnet.network-adapter': dmx.adapter.id,
      'dmx.artnet.artnet-node-name': dmx.artnet.nodeName,
      'dmx.artnet.output-framerate': dmx.artnet.outputFramerate,
      'dmx.artnet.output-delay': dmx.artnet.outputDelayMs,
      'dmx.artnet.send-artsync': dmx.artnet.sendArtSync,
      'dmx.adapters': clone(dmx.adapters),
      'dmx.nodes': clone(dmx.nodes),
      'dmx.runtime': clone(dmx.runtime),
      'dmx.outputs.lumiverses': clone(dmx.outputLumiverses),
      'dmx.inputs.lumiverses': clone(dmx.inputs)
    };
  }

  function webserverFlat(webserver) {
    return {
      'webserver.enable-webserver-rest-api.enabled': webserver.enabled,
      'webserver.enable-webserver-rest-api.listen-address': webserver.listenAddress,
      'webserver.enable-webserver-rest-api.listen-port': webserver.port,
      'webserver.enable-webserver-rest-api.root-directory': webserver.rootDirectory,
      'webserver.arena-connection.target-host': webserver.targetHost
    };
  }

  function commitPreference(section, normalise, flatProject, mutator, reason, key) {
    if (applying) return null;
    let committed;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const next = normalise(preferences[section]);
      mutator(next, snapshot);
      next.updatedAt = now();
      preferences[section] = next;
      const flat = flatProject(next);
      preferences.values = Object.assign({}, preferences.values || {}, flat);
      preferences.updatedAt = next.updatedAt;
      committed = clone(next);
    }, { changedPath: `preferences.${section}`, reason: reason || `${section}-preference-change` });
    const values = flatProject(committed);
    Hub.emit('openlive:preferences-changed', {
      section, key: key || reason, [section]: committed, values
    }, { activity: false });
    Hub.emit(`openlive:${section}-preferences-changed`, {
      [section]: committed, key: key || reason, values
    }, { activity: false });
    return committed;
  }

  const updateOsc = (mutator, reason, key) =>
    commitPreference('osc', normaliseOsc, oscFlat, mutator, reason, key);

  function updateDmx(mutator, reason, key) {
    const committed = commitPreference('dmx', normaliseDmx, dmxFlat, mutator, reason, key);
    if (committed) {
      const detail = {
        dmx: committed, key: key || reason, adapter: committed.adapter,
        adapters: committed.adapters, nodes: committed.nodes, runtime: committed.runtime,
        outputLumiverses: committed.outputLumiverses,
        inputs: committed.inputs
      };
      Hub.emit('openlive:dmx-routing-changed', detail, { activity: false });
      Hub.emit('openlive:artnet-configuration-changed', detail, { activity: false });
    }
    return committed;
  }

  const updateWebserver = (mutator, reason, key) =>
    commitPreference('webserver', normaliseWebserver, webserverFlat, mutator, reason, key);

  function setControl(id, property, value) {
    const control = $(id);
    if (control) control[property] = value;
  }

  function renderOsc(source) {
    const osc = normaliseOsc(source);
    applying = true;
    setControl('oscInputEnabled', 'checked', osc.input.enabled);
    setControl('oscInputPort', 'value', osc.input.port);
    setControl('oscZeroconf', 'checked', osc.input.zeroconf);
    setControl('oscOutputEnabled', 'checked', osc.output.enabled);
    setControl('oscOutputDestination', 'value', osc.output.destination);
    setControl('oscOutputPort', 'value', osc.output.port);
    setControl('oscBundles', 'checked', osc.output.bundles);
    const outgoing = $('oscOutputAddress');
    if (outgoing) {
      outgoing.value = effectiveOscAddress(osc);
      outgoing.disabled = osc.output.destination !== 'Manual IP';
    }
    applying = false;

    status('oscInputStatus', osc.input.enabled
      ? `Configured on UDP ${osc.input.port}${osc.input.zeroconf ? ' with ZeroConf announcement' : ''}. A native OSC bridge must own the socket.`
      : 'OSC input is disabled; incoming Hub messages are monitored but do not control Arena.',
    osc.input.enabled ? 'warning' : '');
    if (oscSelfLoop(osc)) {
      status('oscOutputStatus', 'Self-loop blocked: OSC output points back to the enabled input on the same port.', 'error');
    } else if (osc.output.enabled) {
      status('oscOutputStatus', `Configured for ${effectiveOscAddress(osc)}:${osc.output.port}. The browser queues Hub output only; a native UDP bridge is required.`, 'warning');
    } else {
      status('oscOutputStatus', 'OSC output is disabled.', '');
    }
  }

  function numberControl(value, min, max, field, id) {
    const control = document.createElement('input');
    control.type = 'number';
    control.min = String(min);
    control.max = String(max);
    control.value = String(value);
    control.dataset.field = field;
    control.dataset.inputId = id;
    return control;
  }

  function renderDmxAdapterCatalog(dmx) {
    const renderSelect = (select, selectedId, includeAll) => {
      if (!select) return;
      const previous = select.value;
      const fragment = document.createDocumentFragment();
      if (includeAll) {
        const all = document.createElement('option');
        all.value = '*';
        all.textContent = 'All reported adapters';
        fragment.appendChild(all);
      }
      dmx.adapters.forEach(adapter => {
        const option = document.createElement('option');
        option.value = adapter.id;
        const addressSuffix = adapter.address && adapter.address !== '0.0.0.0' && !adapter.label.includes(adapter.address)
          ? `: ${adapter.address}` : '';
        option.textContent = `${adapter.label}${addressSuffix}${adapter.available === false ? ' (unavailable)' : ''}`;
        fragment.appendChild(option);
      });
      select.replaceChildren(fragment);
      const wanted = includeAll && previous === '*' ? '*' : previous || selectedId;
      select.value = [...select.options].some(option => option.value === wanted) ? wanted : (includeAll ? '*' : selectedId);
    };
    renderSelect($('dmxNetworkAdapter'), dmx.adapter.id, false);
    renderSelect($('dmxMonitorAdapter'), dmx.adapter.id, true);
  }

  function renderDmxNodes(dmx) {
    const body = $('dmxNodesBody');
    if (!body) return;
    const fragment = document.createDocumentFragment();
    dmx.nodes.forEach(node => {
      const row = document.createElement('tr');
      const ports = node.ports.map(port => typeof port === 'object'
        ? text(port.name || port.port || port.address || JSON.stringify(port)) : text(port)).filter(Boolean).join(', ');
      [node.name, node.ip || 'N/A', node.status || 'Reported', ports || 'N/A', node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleTimeString() : 'N/A']
        .forEach(value => {
          const cell = document.createElement('td');
          cell.textContent = String(value);
          row.appendChild(cell);
        });
      fragment.appendChild(row);
    });
    if (!dmx.nodes.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'hint';
      cell.textContent = 'No bridge node report received.';
      row.appendChild(cell);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
    status('dmxNodeStatus', dmx.nodes.length
      ? `${dmx.nodes.length} Art-Net node${dmx.nodes.length === 1 ? '' : 's'} reported by the bridge. No browser-side network scan was performed.`
      : dmxNodePollAt ? 'Node poll requested. Waiting for a bridge report; the browser cannot send ArtPoll itself.'
        : 'No node discovery report is available. Poll Nodes requests a scan from a native bridge.', dmx.nodes.length ? 'ready' : 'warning');
  }

  function renderDmxOutputs(dmx) {
    const body = $('dmxOutputsBody');
    if (!body) return;
    const fragment = document.createDocumentFragment();
    dmx.outputLumiverses.forEach(item => {
      const row = document.createElement('tr');
      row.dataset.outputId = item.id;
      const target = /broadcast/i.test(item.targetMode)
        ? 'Broadcast'
        : /node/i.test(item.targetMode)
          ? `${item.targetNodeName || 'Named node'}${item.targetIp ? ` · ${item.targetIp}` : ''}`
          : /none/i.test(item.targetMode)
            ? 'No Output'
            : item.targetIp || item.targetMode || 'Set in SHOWAVE Map';
      const values = [
        item.name,
        item.device || 'SHOWAVE Map',
        target,
        item.subnet == null ? 'N/A' : item.subnet,
        item.universe == null ? (item.lumiverseId || 'N/A') : item.universe,
        item.enabled && item.outputEnabled ? 'On' : 'Off'
      ];
      values.forEach((value, cellIndex) => {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        if (cellIndex === 0 && item.warnings.length) {
          const warning = document.createElement('small');
          warning.className = 'dmx-route-warning';
          warning.textContent = `Warning: ${item.warnings.join(' ')}`;
          cell.appendChild(warning);
        }
        row.appendChild(cell);
      });
      const patch = item.fixtureCount
        ? ` · ${item.fixtureCount} fixture${item.fixtureCount === 1 ? '' : 's'} · ${item.channelCount} channels${item.lastChannel ? ` through ${item.lastChannel}` : ''}`
        : '';
      const warnings = item.warnings.length ? ` · ${item.warnings.join(' ')}` : '';
      row.title = `Read-only SHOWAVE Map route${item.screenId ? ` · Screen ${item.screenId}` : ''}${patch}${warnings}`;
      if (item.warnings.length) row.dataset.state = 'warning';
      fragment.appendChild(row);
    });
    if (!dmx.outputLumiverses.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'No DMX output Lumiverses are published by SHOWAVE Map.';
      cell.className = 'hint';
      row.appendChild(cell);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
  }

  function renderDmxInputs(dmx) {
    const body = $('dmxInputsBody');
    if (!body) return;
    const fragment = document.createDocumentFragment();
    const interactedExists = dmx.inputs.some(item => item.id === lastInteractedDmxInputId);
    const activeId = interactedExists ? lastInteractedDmxInputId : dmx.selectedInputId;
    dmx.inputs.forEach((item, index) => {
      const row = document.createElement('tr');
      row.dataset.inputId = item.id;
      row.classList.toggle('selected', item.id === activeId);
      row.setAttribute('aria-selected', String(item.id === activeId));

      const nameCell = document.createElement('td');
      const name = document.createElement('input');
      name.type = 'text';
      name.value = item.name;
      name.dataset.field = 'name';
      name.dataset.inputId = item.id;
      name.setAttribute('aria-label', `Input Lumiverse ${index + 1} name`);
      nameCell.appendChild(name);
      row.appendChild(nameCell);

      [
        ['channelOffset', item.channelOffset, 0, 511],
        ['subnet', item.subnet, 0, 15],
        ['universe', item.universe, 0, 15]
      ].forEach(([field, value, min, max]) => {
        const cell = document.createElement('td');
        const control = numberControl(value, min, max, field, item.id);
        control.setAttribute('aria-label', `${item.name} ${field}`);
        cell.appendChild(control);
        row.appendChild(cell);
      });

      const enabledCell = document.createElement('td');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = item.enabled;
      enabled.dataset.field = 'enabled';
      enabled.dataset.inputId = item.id;
      enabled.setAttribute('aria-label', `${item.name} enabled`);
      enabledCell.appendChild(enabled);
      row.appendChild(enabledCell);
      fragment.appendChild(row);
    });
    body.replaceChildren(fragment);
  }

  function renderDmxMonitorSelectors(dmx) {
    renderDmxAdapterCatalog(dmx);
    [['dmxMonitorSubnet', 'Subnet'], ['dmxMonitorUniverse', 'Universe']].forEach(([id, label]) => {
      const select = $(id);
      if (!select || select.options.length === 16) return;
      const fragment = document.createDocumentFragment();
      for (let value = 0; value < 16; value += 1) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${label} ${value}`;
        fragment.appendChild(option);
      }
      select.replaceChildren(fragment);
    });
  }

  const dmxMonitorKey = (adapterId, subnet, universe) => `${encodeURIComponent(adapterId)}|${subnet}|${universe}`;
  const dmxHistoryKey = (adapterId, subnet, universe, channel) => `${dmxMonitorKey(adapterId, subnet, universe)}|${channel}`;

  function dmxMonitorRecord(adapterId, subnet, universe) {
    const key = dmxMonitorKey(adapterId, subnet, universe);
    if (!dmxMonitorUniverses.has(key)) dmxMonitorUniverses.set(key, {
      adapterId, subnet, universe, values: new Uint8Array(512), seen: new Uint8Array(512),
      recentAt: new Float64Array(512), lastAt: 0, updates: 0
    });
    return dmxMonitorUniverses.get(key);
  }

  function selectedDmxMonitorView() {
    return {
      adapterId: $('dmxMonitorAdapter')?.value || '*',
      subnet: integer($('dmxMonitorSubnet')?.value, 0, 0, 15),
      universe: integer($('dmxMonitorUniverse')?.value, 0, 0, 15),
      bank: integer($('dmxMonitorBank')?.value, 0, 0, 1)
    };
  }

  function monitoredChannelState(view, channel) {
    let latest = null;
    dmxMonitorUniverses.forEach(record => {
      if ((view.adapterId === '*' || record.adapterId === view.adapterId) && record.subnet === view.subnet && record.universe === view.universe && record.seen[channel - 1]) {
        const candidate = { value: record.values[channel - 1], at: record.recentAt[channel - 1], adapterId: record.adapterId };
        if (!latest || candidate.at >= latest.at) latest = candidate;
      }
    });
    return latest;
  }

  function renderDmxMonitorActivitySelectors(view) {
    const activeSubnets = new Set(), activeUniverses = new Set();
    dmxMonitorUniverses.forEach(record => {
      if (view.adapterId !== '*' && record.adapterId !== view.adapterId) return;
      if (!record.lastAt) return;
      activeSubnets.add(record.subnet);
      if (record.subnet === view.subnet) activeUniverses.add(record.universe);
    });
    [['dmxMonitorSubnet', 'Subnet', activeSubnets], ['dmxMonitorUniverse', 'Universe', activeUniverses]]
      .forEach(([id, label, active]) => {
        const select = $(id);
        if (!select) return;
        [...select.options].forEach(option => {
          const value = Number(option.value), on = active.has(value);
          option.textContent = `${on ? '\u25cf ' : ''}${label} ${value}`;
          option.dataset.active = String(on);
        });
      });
  }

  function renderDmxChannelHistory() {
    const list = $('dmxHistoryList');
    const title = $('dmxHistoryTitle');
    if (!list || !title) return;
    if (!dmxMonitorSelectedChannel) {
      title.textContent = 'Channel history';
      const empty = document.createElement('div');
      empty.className = 'midi-log-empty';
      empty.textContent = 'Select a channel.';
      list.replaceChildren(empty);
      return;
    }
    const view = selectedDmxMonitorView();
    const events = [];
    dmxMonitorHistory.forEach((items, key) => {
      const parts = key.split('|');
      if (+parts[1] !== view.subnet || +parts[2] !== view.universe || +parts[3] !== dmxMonitorSelectedChannel) return;
      if (view.adapterId !== '*' && decodeURIComponent(parts[0]) !== view.adapterId) return;
      events.push(...items);
    });
    events.sort((a, b) => b.at - a.at);
    title.textContent = `Channel ${dmxMonitorSelectedChannel} history`;
    const fragment = document.createDocumentFragment();
    events.slice(0, DMX_HISTORY_PER_CHANNEL).forEach(event => {
      const row = document.createElement('div');
      row.className = 'dmx-history-entry';
      [new Date(event.at).toLocaleTimeString(), event.value, `${event.mapped ? `Mapped ${event.mappedChannel}` : 'Unmapped'} · ${event.adapterId}`]
        .forEach(value => {
          const span = document.createElement('span');
          span.textContent = String(value);
          row.appendChild(span);
        });
      fragment.appendChild(row);
    });
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'midi-log-empty';
      empty.textContent = 'No retained updates for this channel.';
      fragment.appendChild(empty);
    }
    list.replaceChildren(fragment);
  }

  function renderDmxMonitorStatus() {
    const view = selectedDmxMonitorView();
    const dmx = normaliseDmx(Hub.get('preferences.dmx'));
    const mappedRoute = dmx.inputs.find(item => item.enabled && item.subnet === view.subnet && item.universe === view.universe);
    status('dmxMonitorStatus', `${dmxMonitorRunning ? 'Armed' : 'Disarmed'} · Subnet ${view.subnet} / Universe ${view.universe}${mappedRoute ? ` · ${mappedRoute.name}` : ' · unmapped route'} · ${dmxMonitorCounts.mapped} mapped · ${dmxMonitorCounts.unmapped} unmapped · ${dmxMonitorCounts.frames} frames · ${dmxMonitorCounts.updates} updates${dmxMonitorLastAt ? ` · last ${new Date(dmxMonitorLastAt).toLocaleTimeString()}` : ''}`, dmxMonitorRunning ? 'warning' : '');
  }

  function renderDmxMonitorGrid() {
    dmxMonitorRenderHandle = 0;
    const grid = $('dmxChannelGrid');
    if (!grid) return;
    if (grid.children.length !== 256) {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 256; index += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'dmx-channel';
        fragment.appendChild(cell);
      }
      grid.replaceChildren(fragment);
      dmxMonitorFullRender = true;
    }
    const view = selectedDmxMonitorView();
    renderDmxMonitorActivitySelectors(view);
    const first = view.bank * 256 + 1;
    const updateCell = index => {
      const cell = grid.children[index];
      if (!cell) return;
      const channel = first + index;
      const current = monitoredChannelState(view, channel);
      const seen = !!current;
      const value = current ? current.value : 0;
      cell.dataset.channel = String(channel);
      cell.textContent = seen ? String(value) : '·';
      cell.dataset.active = String(seen && value > 0);
      cell.dataset.recent = String(seen && now() - current.at < 1500);
      cell.setAttribute('aria-selected', String(channel === dmxMonitorSelectedChannel));
      cell.title = `Channel ${channel}: ${seen ? value : 'not received'}${current ? ` · ${current.adapterId}` : ''}`;
      cell.setAttribute('aria-label', `DMX channel ${channel}, ${seen ? `value ${value}` : 'not received'}`);
    };
    if (dmxMonitorFullRender) {
      for (let index = 0; index < 256; index += 1) updateCell(index);
    } else {
      const indexes = new Set();
      dmxMonitorDirtyChannels.forEach(key => {
        const [encodedAdapterId, subnet, universe, channel] = key.split('|');
        const adapterId = decodeURIComponent(encodedAdapterId);
        const numeric = Number(channel);
        if ((view.adapterId === '*' || view.adapterId === adapterId) && +subnet === view.subnet && +universe === view.universe && numeric >= first && numeric < first + 256) indexes.add(numeric - first);
      });
      indexes.forEach(updateCell);
    }
    dmxMonitorDirtyChannels.clear();
    dmxMonitorFullRender = false;
    renderDmxChannelHistory();
    renderDmxMonitorStatus();
  }

  function scheduleDmxMonitorRender(full) {
    if (full) dmxMonitorFullRender = true;
    if (dmxMonitorRenderHandle) return;
    const request = typeof global.requestAnimationFrame === 'function'
      ? global.requestAnimationFrame.bind(global) : callback => global.setTimeout(callback, 16);
    dmxMonitorRenderHandle = request(renderDmxMonitorGrid);
  }

  function clearDmxMonitor() {
    dmxMonitorCounts = { mapped: 0, unmapped: 0, ignored: 0, frames: 0, updates: 0 };
    dmxMonitorLastAt = 0;
    dmxMonitorSelectedChannel = null;
    dmxMonitorMessageIds.clear();
    dmxMonitorUniverses.clear();
    dmxMonitorHistory.clear();
    dmxMonitorDirtyChannels.clear();
    scheduleDmxMonitorRender(true);
  }

  function appendDmxHistory(adapterId, subnet, universe, channel, entry) {
    const key = dmxHistoryKey(adapterId, subnet, universe, channel);
    if (!dmxMonitorHistory.has(key) && dmxMonitorHistory.size >= DMX_HISTORY_CHANNEL_LIMIT) {
      dmxMonitorHistory.delete(dmxMonitorHistory.keys().next().value);
    }
    const entries = dmxMonitorHistory.get(key) || [];
    entries.push(entry);
    if (entries.length > DMX_HISTORY_PER_CHANNEL) entries.splice(0, entries.length - DMX_HISTORY_PER_CHANNEL);
    dmxMonitorHistory.delete(key);
    dmxMonitorHistory.set(key, entries);
  }

  function ingestDmxMonitorUpdate(payload, channelValue, valueValue, stamp) {
    const subnet = integer(payload.subnet, -1, 0, 15);
    const universe = integer(payload.universe, -1, 0, 15);
    const channel = integer(channelValue, -1, 1, 512);
    const value = integer(valueValue, -1, 0, 255);
    if (subnet < 0 || universe < 0 || channel < 0 || value < 0) {
      dmxMonitorCounts.ignored += 1;
      return;
    }
    const dmx = normaliseDmx(Hub.get('preferences.dmx'));
    const adapterId = text(payload.adapterId) || dmx.adapter.id || 'automatic';
    const route = dmx.inputs.find(item => item.enabled && item.subnet === subnet && item.universe === universe && channel - item.channelOffset >= 1 && channel - item.channelOffset <= 512);
    const mappedChannel = route ? channel - route.channelOffset : null;
    const record = dmxMonitorRecord(adapterId, subnet, universe);
    record.values[channel - 1] = value;
    record.seen[channel - 1] = 1;
    record.recentAt[channel - 1] = stamp;
    record.lastAt = stamp;
    record.updates += 1;
    dmxMonitorDirtyChannels.add(dmxHistoryKey(adapterId, subnet, universe, channel));
    appendDmxHistory(adapterId, subnet, universe, channel, {
      at: stamp, value, adapterId, mapped: !!route, mappedChannel, inputId: route ? route.id : null,
      source: text(payload.source)
    });
    if (route) dmxMonitorCounts.mapped += 1; else dmxMonitorCounts.unmapped += 1;
    dmxMonitorCounts.updates += 1;
    dmxMonitorLastAt = stamp;
  }

  function retainDmxMonitorMessage(payload) {
    if (!dmxMonitorRunning || !payload) return;
    const direction = /^(?:out|output|tx)$/i.test(text(payload.direction)) ? 'out' : 'in';
    if (direction !== 'in') { dmxMonitorCounts.ignored += 1; scheduleDmxMonitorRender(false); return; }
    const id = text(payload.id);
    if (id && dmxMonitorMessageIds.has(id)) return;
    if (id) {
      dmxMonitorMessageIds.add(id);
      if (dmxMonitorMessageIds.size > 1024) dmxMonitorMessageIds.delete(dmxMonitorMessageIds.values().next().value);
    }
    const stamp = Number(payload.at || payload.timestamp) || now();
    const frame = Array.isArray(payload.values) ? payload.values : Array.isArray(payload.channels) ? payload.channels : null;
    if (frame) {
      const start = integer(payload.channelStart, 1, 1, 512);
      frame.slice(0, 513 - start).forEach((entry, index) => {
        if (entry && typeof entry === 'object') ingestDmxMonitorUpdate(payload, entry.channel, entry.value, stamp);
        else ingestDmxMonitorUpdate(payload, start + index, entry, stamp);
      });
      dmxMonitorCounts.frames += 1;
    } else {
      ingestDmxMonitorUpdate(payload, payload.channel, payload.value, stamp);
      dmxMonitorCounts.frames += 1;
    }
    scheduleDmxMonitorRender(false);
    if (dmxMonitorRecentTimer) global.clearTimeout(dmxMonitorRecentTimer);
    dmxMonitorRecentTimer = global.setTimeout(() => scheduleDmxMonitorRender(true), 1600);
  }

  function renderDmx(source) {
    const dmx = normaliseDmx(source);
    applying = true;
    renderDmxAdapterCatalog(dmx);
    setControl('dmxNetworkAdapter', 'value', dmx.adapter.id);
    setControl('dmxNodeName', 'value', dmx.artnet.nodeName);
    setControl('dmxOutputFramerate', 'value', dmx.artnet.outputFramerate);
    setControl('dmxOutputFramerateValue', 'value', dmx.artnet.outputFramerate);
    setControl('dmxOutputDelay', 'value', dmx.artnet.outputDelayMs);
    setControl('dmxOutputDelayValue', 'value', dmx.artnet.outputDelayMs);
    setControl('dmxSendArtSync', 'checked', dmx.artnet.sendArtSync);
    renderDmxNodes(dmx);
    renderDmxOutputs(dmx);
    renderDmxInputs(dmx);
    renderDmxMonitorSelectors(dmx);
    applying = false;

    const selectedAdapter = dmx.adapters.find(item => item.id === dmx.adapter.id) || dmx.adapter;
    if (isLoopbackAddress(selectedAdapter.address)) {
      status('dmxArtNetStatus', `${selectedAdapter.label} uses ${selectedAdapter.address}. Localhost cannot receive Art-Net from another machine; select a LAN adapter or Automatic.`, 'error');
    } else if (selectedAdapter.available === false) {
      status('dmxArtNetStatus', `${selectedAdapter.label} is saved but was reported unavailable. Refresh adapters or choose another adapter.`, 'warning');
    } else {
      status('dmxArtNetStatus', `Saved configuration · ${selectedAdapter.label} · ${dmx.artnet.outputFramerate} fps · ${dmx.artnet.outputDelayMs} ms · Send ArtSync ${dmx.artnet.sendArtSync ? 'on' : 'off'}.`, 'ready');
    }
    const runtime = dmx.runtime;
    const runtimeSuffix = `${runtime.packetCount} packet${runtime.packetCount === 1 ? '' : 's'}${runtime.lastPacketAt ? ` · last ${new Date(runtime.lastPacketAt).toLocaleTimeString()}` : ''}`;
    if (runtime.lastError) {
      status('dmxBridgeStatus', `Bridge error: ${runtime.lastError}`, 'error');
    } else if (runtime.bound) {
      status('dmxBridgeStatus', `Bridge ${runtime.bridgeStatus || 'bound'} · ${runtime.receiving ? 'receiving' : 'waiting'} · runtime sync ${runtime.synchronized ? 'active' : 'inactive'} · ${runtimeSuffix}.`, runtime.receiving ? 'ready' : 'warning');
    } else {
      status('dmxBridgeStatus', `Bridge ${runtime.bridgeStatus || 'unavailable'} · not bound. The browser saved configuration but did not open UDP 6454.`, 'warning');
    }
    const outputDuplicates = duplicateDmxOutputPairs(dmx);
    const invalidTargets = dmx.outputLumiverses.filter(item => {
      if (!item.enabled || !item.outputEnabled || /^(?:broadcast|none)$/i.test(item.targetMode)) return false;
      if (/node/i.test(item.targetMode)) return !item.targetNodeName;
      return !item.targetIp || !validNetworkAddress(item.targetIp, { allowHostname: true });
    });
    if (outputDuplicates.length) {
      const labels = outputDuplicates.map(([pair, names]) => `${pair} (${names.join(', ')})`).join('; ');
      status('dmxOutputStatus', `SHOWAVE Map has duplicate enabled Subnet/Universe routes: ${labels}. Resolve them in SHOWAVE Map.`, 'error');
    } else if (invalidTargets.length) {
      status('dmxOutputStatus', `SHOWAVE Map has invalid Art-Net target IPs for: ${invalidTargets.map(item => item.name).join(', ')}. Resolve them in SHOWAVE Map.`, 'error');
    } else {
      const configured = dmx.outputLumiverses.filter(item => item.enabled && item.outputEnabled);
      const targets = new Set(configured.map(item => item.targetIp).filter(Boolean));
      status('dmxOutputStatus', configured.length
        ? `${configured.length}/${dmx.outputLumiverses.length} SHOWAVE Map Lumiverses enabled${targets.size ? ` across ${targets.size} target${targets.size === 1 ? '' : 's'}` : ''}. Read-only here; UDP delivery is not confirmed.`
        : dmx.outputLumiverses.length
          ? `0/${dmx.outputLumiverses.length} SHOWAVE Map Lumiverses enabled. Open SHOWAVE Map to configure them.`
          : 'No DMX output Lumiverses are published. Open SHOWAVE Map to add one.', configured.length ? 'warning' : '');
    }
    const duplicates = duplicateDmxPairs(dmx);
    if (duplicates.length) {
      const labels = duplicates.map(([pair, names]) => `${pair} (${names.join(', ')})`).join('; ');
      status('dmxInputStatus', `Duplicate enabled Subnet/Universe routes: ${labels}. Each input Lumiverse must be unique.`, 'error');
    } else {
      const enabled = dmx.inputs.filter(item => item.enabled).length;
      status('dmxInputStatus', `${enabled}/${dmx.inputs.length} input Lumiverses enabled. Routes are shared with explicit Shortcuts Learn mappings.`, enabled ? 'ready' : 'warning');
    }
  }

  function apiDisplayHost(webserver) {
    let address = webserver.listenAddress;
    if (address === '0.0.0.0' || address === '::' || address === '[::]') {
      address = location.hostname && location.hostname !== '0.0.0.0' ? location.hostname : '127.0.0.1';
    }
    if (isIPv6(address) && !/^\[/.test(address)) address = `[${address}]`;
    return address;
  }

  function apiUrl(webserver) {
    return `http://${apiDisplayHost(webserver)}:${webserver.port}/api/v1`;
  }

  function rootDirectoryError(path) {
    const value = text(path);
    if (!value) return 'Root Directory is required.';
    if (value.split(/[\\/]+/).some(segment => segment.toLowerCase() === 'api')) {
      return 'Root Directory must not contain a folder named API; /api is reserved for the REST service.';
    }
    return '';
  }

  function renderWebserver(source) {
    const webserver = normaliseWebserver(source);
    applying = true;
    setControl('webserverEnabled', 'checked', webserver.enabled);
    setControl('webserverAddress', 'value', webserver.listenAddress);
    setControl('webserverPort', 'value', webserver.port);
    setControl('webserverRoot', 'value', webserver.rootDirectory);
    setControl('webserverTargetHost', 'value', webserver.targetHost);
    const link = $('webserverApiUrl');
    if (link) {
      link.textContent = apiUrl(webserver);
      link.href = apiUrl(webserver);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    applying = false;

    const rootError = rootDirectoryError(webserver.rootDirectory);
    if (rootError) status('webserverHostStatus', rootError, 'error');
    else if (webserver.enabled) {
      status('webserverHostStatus', `Native hosting is configured for ${webserver.listenAddress}:${webserver.port}, but this static page has not bound a server. Start or configure it in native Arena.`, 'warning');
    } else {
      status('webserverHostStatus', 'Native Webserver & REST API hosting is disabled in the shared configuration.', '');
    }

    const connection = Hub.get('connection', {}) || {};
    if (global.ArenaLive && global.ArenaLive.status === 'live') {
      status('webserverConnectionStatus', `Connected to ${global.ArenaLive.host()} · ${connection.product || 'Resolume Arena'}`, 'ready');
    } else if (webserver.lastError) {
      status('webserverConnectionStatus', webserver.lastError, 'error');
    } else if (webserver.lastProbeAt) {
      status('webserverConnectionStatus', `${webserver.status} · last probed ${new Date(webserver.lastProbeAt).toLocaleTimeString()}`, /reachable/i.test(webserver.status) ? 'ready' : 'warning');
    } else {
      status('webserverConnectionStatus', `Target saved as ${webserver.targetHost}. Probe it before assuming an Arena server is available.`, 'warning');
    }
  }

  function renderAll() {
    renderOsc(Hub.get('preferences.osc'));
    renderDmx(Hub.get('preferences.dmx'));
    renderWebserver(Hub.get('preferences.webserver'));
    renderOscMonitor();
  }

  function firstOscValue(message) {
    if (Array.isArray(message.args) && message.args.length) return message.args[0];
    return message.value;
  }

  function triggerValue(value) {
    if (value == null) return true;
    if (typeof value === 'string' && /^(false|0|off|no|null)$/i.test(value.trim())) return false;
    return value !== false && Number(value) !== 0;
  }

  function numericOscValue(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label || 'OSC value'} must be numeric.`);
    return number;
  }

  function routeOscAddress(address, value, message) {
    const path = text(address).replace(/\/+$/, '').toLowerCase();
    let action = null;
    let payload = { source: 'osc' };
    let match;

    if (/^\/composition\/(?:tempocontroller\/)?(?:tempo|bpm)$/.test(path)) {
      action = 'tempo.set';
      payload.bpm = clamp(numericOscValue(value, 'Tempo'), 20, 500);
    } else if (/^\/composition\/(?:tempocontroller\/)?(?:resync|tempo\/resync)$/.test(path)) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'tempo.resync';
    } else if (/^\/composition\/(?:tempocontroller\/)?(?:tap|tempo\/tap)$/.test(path)) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'tempo.tap';
    } else if (/^\/(?:composition\/tempocontroller|transport)\/(play|pause|stop)$/.test(path)) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = `transport.${path.match(/(play|pause|stop)$/)[1]}`;
    } else if ((match = path.match(/^\/composition\/columns\/(\d+)\/(?:connect|trigger)$/))) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'column.trigger';
      payload.column = Number(match[1]);
    } else if ((match = path.match(/^\/composition\/layers\/(\d+)\/clips\/(\d+)\/(?:connect|trigger)$/))) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'clip.trigger';
      payload.layer = Number(match[1]);
      payload.column = Number(match[2]);
    } else if ((match = path.match(/^\/composition\/layers\/(\d+)\/video\/opacity$/))) {
      action = 'layer.opacity';
      payload.layer = Number(match[1]);
      payload.value = clamp(numericOscValue(value, 'Layer opacity'), 0, 1);
    } else if ((match = path.match(/^\/composition\/layers\/(\d+)\/(?:clear|disconnectall|eject)$/))) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'layer.eject';
      payload.layer = Number(match[1]);
    } else if ((match = path.match(/^\/composition\/layers\/(\d+)\/select$/))) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'layer.select';
      payload.layer = Number(match[1]);
    } else if (/^\/composition\/video\/opacity$/.test(path)) {
      action = 'composition.opacity';
      payload.value = clamp(numericOscValue(value, 'Show opacity'), 0, 1);
    } else if (/^\/composition\/(?:master|masteropacity)$/.test(path)) {
      action = 'master.set';
      payload.value = clamp(numericOscValue(value, 'Show master'), 0, 1);
    } else if (/^\/composition\/(?:crossfader|crossfader\/phase)$/.test(path)) {
      action = 'crossfader.set';
      payload.value = clamp(numericOscValue(value, 'Crossfader'), 0, 1);
    } else if (/^\/composition\/(?:bypass|bypassed)$/.test(path)) {
      action = 'composition.bypass';
      payload.bypass = triggerValue(value);
    } else if (/^\/composition\/(?:disconnectall|ejectall|clear)$/.test(path)) {
      if (!triggerValue(value)) return { matched: true, triggered: false, reason: 'release ignored' };
      action = 'eject.all';
    }

    if (!action) return { matched: false, triggered: false, reason: 'No core Arena route for this address.' };
    payload.oscAddress = address;
    if (message && message.id) payload.oscMessageId = message.id;
    const commandId = Hub.command('arena', action, payload, { activity: false });
    return { matched: true, triggered: true, action, payload, commandId };
  }

  function normaliseOscMessage(payload, meta) {
    const source = payload || {};
    const rawDirection = text(source.direction || source.io || source.type).toLowerCase();
    const direction = /^(out|output|sent|tx)$/.test(rawDirection) ? 'out' : 'in';
    const address = text(source.address || source.path);
    if (!address || address[0] !== '/') return null;
    const args = Array.isArray(source.args) ? clone(source.args)
      : Object.prototype.hasOwnProperty.call(source, 'value') ? [clone(source.value)] : [];
    return {
      id: text(source.id) || (meta && meta.id) || `osc:${now()}:${Math.random().toString(36).slice(2, 8)}`,
      at: Number(source.at || source.timestamp || (meta && meta.at)) || now(),
      direction,
      address,
      args,
      source: text(source.source || (meta && meta.source)) || 'SHOWAVE Hub',
      delivered: source.delivered === true,
      routed: source.routed === true
    };
  }

  function retainOscMessage(payload, meta) {
    const message = normaliseOscMessage(payload, meta);
    if (!message) return null;
    if (monitorEntries.some(item => item.id === message.id)) return message;
    monitorEntries.push(message);
    if (monitorEntries.length > 200) monitorEntries = monitorEntries.slice(-200);
    monitorCounts[message.direction] += 1;
    if (!monitorPaused) renderOscMonitor();
    else renderOscMonitorStatus();
    return message;
  }

  function renderOscMonitorStatus() {
    const node = $('oscMonitorStatus');
    if (!node) return;
    node.textContent = `${monitorCounts.in} in · ${monitorCounts.out} out · ${monitorEntries.length}/200 retained${monitorPaused ? ' · paused' : ''}`;
  }

  function renderOscMonitor() {
    const log = $('oscLog');
    if (!log) return;
    const visible = monitorEntries.filter(item => monitorDirection === 'all' || item.direction === monitorDirection);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'midi-log-empty';
      empty.textContent = monitorEntries.length
        ? 'No retained OSC messages match this direction filter.'
        : 'No OSC traffic yet. Only real shared or bridged messages appear here.';
      log.replaceChildren(empty);
    } else {
      const rows = visible.map(item => {
        const row = document.createElement('div');
        row.className = `midi-log-row ${item.direction}`;
        const stamp = new Date(item.at).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
        const args = item.args.map(value => typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)).join(' ');
        row.textContent = `${stamp}  ${item.direction === 'in' ? 'IN ' : 'OUT'}  ${item.address}${args ? `  ${args}` : ''}  · ${item.source}`;
        return row;
      });
      log.replaceChildren(...rows);
      log.scrollTop = log.scrollHeight;
    }
    renderOscMonitorStatus();
  }

  function emitOscMessage(message) {
    Hub.emit('openlive:osc-message', message, { activity: false, source: message.source || 'preferences-network' });
    return message;
  }

  function injectOsc(address, value, options) {
    const path = text(address);
    if (!path || path[0] !== '/') throw new Error('OSC addresses must begin with /.');
    const opts = options || {};
    const args = Array.isArray(opts.args) ? clone(opts.args) : Array.isArray(value) ? clone(value) : [clone(value)];
    const message = {
      id: text(opts.id) || `osc-in:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      at: Number(opts.at) || now(), direction: 'in', address: path, args,
      value: args[0], source: text(opts.source) || 'SHOWAVE OSC injector', routed: true
    };
    emitOscMessage(message);
    const osc = normaliseOsc(Hub.get('preferences.osc'));
    let route = { matched: false, triggered: false, reason: 'OSC input is disabled.' };
    if (osc.input.enabled) {
      try { route = routeOscAddress(path, args[0], message); }
      catch (error) { route = { matched: true, triggered: false, reason: error.message || String(error) }; }
    }
    Hub.emit('openlive:osc-route-result', { messageId: message.id, address: path, route }, { activity: false });
    return { message: clone(message), route: clone(route) };
  }

  function sendOsc(address, value, options) {
    const path = text(address);
    if (!path || path[0] !== '/') throw new Error('OSC addresses must begin with /.');
    const osc = normaliseOsc(Hub.get('preferences.osc'));
    if (!osc.output.enabled) return { accepted: false, delivered: false, reason: 'OSC output is disabled.' };
    if (oscSelfLoop(osc)) return { accepted: false, delivered: false, reason: 'OSC self-loop is blocked.' };
    const opts = options || {};
    const args = Array.isArray(opts.args) ? clone(opts.args) : Array.isArray(value) ? clone(value) : [clone(value)];
    const message = {
      id: `osc-out:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      at: now(), direction: 'out', address: path, args, value: args[0],
      source: text(opts.source) || 'SHOWAVE OSC API', destination: effectiveOscAddress(osc),
      port: osc.output.port, bundles: osc.output.bundles, delivered: false, routed: true
    };
    emitOscMessage(message);
    Hub.emit('openlive:osc-send-request', clone(message), { activity: false });
    status('oscOutputStatus', `Queued ${path} for the shared bridge. No native UDP delivery has been confirmed.`, 'warning');
    return { accepted: true, delivered: false, reason: 'Native UDP bridge required.', message: clone(message) };
  }

  function parseTestValue(value) {
    const source = text(value);
    if (!source.length) return '';
    try { return JSON.parse(source); } catch (_) { /* keep text */ }
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(source)) return Number(source);
    if (/^(true|false)$/i.test(source)) return source.toLowerCase() === 'true';
    return source;
  }

  function publishDmxMessage(payload, options) {
    const source = payload || {};
    const opts = options || {};
    const direction = /^(out|output|tx)$/i.test(text(opts.direction || source.direction)) ? 'out' : 'in';
    const subnet = integer(source.subnet, -1, 0, 15);
    const universe = integer(source.universe, -1, 0, 15);
    const channel = integer(source.channel, -1, 1, 512);
    const value = integer(source.value, -1, 0, 255);
    if (subnet < 0) throw new Error('DMX Subnet must be a whole number from 0 to 15.');
    if (universe < 0) throw new Error('DMX Universe must be a whole number from 0 to 15.');
    if (channel < 0) throw new Error('DMX Channel must be a whole number from 1 to 512.');
    if (value < 0) throw new Error('DMX value must be a whole number from 0 to 255.');
    const dmx = normaliseDmx(Hub.get('preferences.dmx'));
    const route = direction === 'in' ? dmx.inputs.find(item =>
      item.enabled && item.subnet === subnet && item.universe === universe) : null;
    const localChannel = route ? channel - route.channelOffset : null;
    const input = route && localChannel >= 1 && localChannel <= 512 ? route : null;
    const message = {
      id: text(source.id) || `dmx-${direction}:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      at: Number(source.at || source.timestamp) || now(), direction,
      subnet, universe, channel, value,
      inputId: input ? input.id : null,
      routeId: route ? route.id : null,
      mappedChannel: input ? localChannel : null,
      accepted: direction === 'out' ? false : !!input,
      adapterId: text(source.adapterId) || dmx.adapter.id,
      source: text(opts.source || source.source) || 'SHOWAVE DMX bridge',
      delivered: source.delivered === true
    };
    Hub.emit('openlive:dmx-message', message, { activity: false, source: message.source });
    return clone(message);
  }

  function publishDmxBridgeInput(payload, meta) {
    const source = payload || {};
    const frame = Array.isArray(source.values) ? source.values : Array.isArray(source.channels) ? source.channels : null;
    if (!frame) return publishDmxMessage(source, {
      direction: 'in', source: text(source.source || (meta && meta.source)) || 'SHOWAVE DMX bridge'
    });
    const subnet = integer(source.subnet, -1, 0, 15);
    const universe = integer(source.universe, -1, 0, 15);
    const channelStart = integer(source.channelStart, 1, 1, 512);
    if (subnet < 0 || universe < 0) throw new Error('DMX bridge frames require Subnet and Universe values from 0 to 15.');
    const values = frame.slice(0, 513 - channelStart).map((entry, index) => {
      if (entry && typeof entry === 'object') return {
        channel: integer(entry.channel, channelStart + index, 1, 512),
        value: integer(entry.value, 0, 0, 255)
      };
      return integer(entry, 0, 0, 255);
    });
    const message = {
      id: text(source.id) || `dmx-in-frame:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      at: Number(source.at || source.timestamp) || now(), direction: 'in', subnet, universe,
      channelStart, values, adapterId: text(source.adapterId) || normaliseDmx(Hub.get('preferences.dmx')).adapter.id,
      source: text(source.source || (meta && meta.source)) || 'SHOWAVE DMX bridge'
    };
    Hub.emit('openlive:dmx-message', message, { activity: false, source: message.source });
    return clone(message);
  }

  function nextUnusedDmxPair(inputs) {
    const used = new Set((inputs || []).map(item => `${item.subnet}:${item.universe}`));
    for (let subnet = 0; subnet < 16; subnet += 1) {
      for (let universe = 0; universe < 16; universe += 1) {
        if (!used.has(`${subnet}:${universe}`)) return { subnet, universe };
      }
    }
    return null;
  }

  function addDmxInput() {
    return updateDmx(dmx => {
      const id = `dmx-input:${now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
      const route = nextUnusedDmxPair(dmx.inputs);
      if (!route) {
        status('dmxInputStatus', 'All 256 Art-Net Subnet/Universe routes are already in use.', 'error');
        return;
      }
      dmx.inputs.push({
        id, name: `DMX Input ${dmx.inputs.length + 1}`, channelOffset: 0,
        subnet: route.subnet, universe: route.universe, enabled: true
      });
      dmx.selectedInputId = id;
      lastInteractedDmxInputId = id;
    }, 'DMX input added', 'inputs');
  }

  function removeDmxInput(id) {
    const current = normaliseDmx(Hub.get('preferences.dmx'));
    const interacted = current.inputs.some(item => item.id === lastInteractedDmxInputId) ? lastInteractedDmxInputId : null;
    const target = text(id) || interacted || current.selectedInputId;
    if (!target || !current.inputs.some(item => item.id === target)) {
      status('dmxInputStatus', 'Select an input Lumiverse to remove.', 'warning');
      return false;
    }
    const maps = Hub.get('shortcuts.maps', {}) || {};
    let shortcutReferences = 0;
    Object.values(maps).forEach(record => {
      const rows = record && record.data && record.data.dmx;
      if (!Array.isArray(rows)) return;
      rows.forEach(row => {
        if (!Array.isArray(row)) return;
        const metadata = row.find(value => value && typeof value === 'object' && !Array.isArray(value));
        if (metadata && String(metadata.inputId || '') === target) shortcutReferences += 1;
      });
    });
    updateDmx(dmx => {
      const removedIndex = dmx.inputs.findIndex(item => item.id === target);
      dmx.inputs = dmx.inputs.filter(item => item.id !== target);
      const next = dmx.inputs[Math.min(Math.max(removedIndex, 0), Math.max(0, dmx.inputs.length - 1))] || null;
      dmx.selectedInputId = next ? next.id : null;
      lastInteractedDmxInputId = dmx.selectedInputId;
    }, 'DMX input removed', 'inputs');
    if (shortcutReferences) status('dmxInputStatus', `${shortcutReferences} DMX shortcut${shortcutReferences === 1 ? '' : 's'} now retain this stable ID as Missing input. Reassign them explicitly in Shortcuts; they were not silently rebound.`, 'warning');
    return true;
  }

  function selectDmxInput(id) {
    if (!id) return;
    const current = normaliseDmx(Hub.get('preferences.dmx'));
    if (!current.inputs.some(item => item.id === id)) return;
    lastInteractedDmxInputId = id;
    if (current.selectedInputId === id) return;
    updateDmx(dmx => { if (dmx.inputs.some(item => item.id === id)) dmx.selectedInputId = id; }, 'DMX input selected', 'selectedInputId');
  }

  function requestDmxAdapters() {
    dmxAdapterRequestAt = now();
    const dmx = normaliseDmx(Hub.get('preferences.dmx'));
    const request = {
      id: `dmx-adapters:${dmxAdapterRequestAt.toString(36)}`, requestedAt: dmxAdapterRequestAt,
      selectedAdapterId: dmx.adapter.id, source: 'preferences-network'
    };
    status('dmxArtNetStatus', 'Adapter refresh requested. Waiting for a native bridge report; no adapters were fabricated.', 'warning');
    Hub.emit('openlive:dmx-adapter-discovery-request', request, { activity: false, source: request.source });
    return clone(request);
  }

  function reportDmxAdapters(payload) {
    const source = Array.isArray(payload) ? { adapters: payload } : (payload || {});
    if (!Array.isArray(source.adapters)) return false;
    const current = normaliseDmx(Hub.get('preferences.dmx'));
    let reported = normaliseDmxAdapters(source.adapters, null);
    if (!reported.some(item => item.id === current.adapter.id)) {
      reported = normaliseDmxAdapters(reported, Object.assign({}, current.adapter, { available: false }));
    }
    const committed = updateDmx(dmx => {
      dmx.adapters = reported;
      const selected = reported.find(item => item.id === dmx.adapter.id) || reported[0];
      dmx.adapter = Object.assign({}, dmx.adapter, selected);
      if (source.runtime) dmx.runtime = normaliseDmxRuntime(Object.assign({}, dmx.runtime, source.runtime));
    }, 'DMX adapter catalog reported', 'adapters');
    return committed ? clone(committed.adapters) : false;
  }

  function requestArtNetNodes() {
    dmxNodePollAt = now();
    const dmx = normaliseDmx(Hub.get('preferences.dmx'));
    const request = {
      id: `artnet-poll:${dmxNodePollAt.toString(36)}`, requestedAt: dmxNodePollAt,
      adapter: clone(dmx.adapter), source: 'preferences-network'
    };
    status('dmxNodeStatus', 'Node poll requested. Waiting for a native bridge report; the browser did not send ArtPoll.', 'warning');
    Hub.emit('openlive:artnet-node-poll-request', request, { activity: false, source: request.source });
    return clone(request);
  }

  function reportArtNetNodes(payload) {
    const source = Array.isArray(payload) ? { nodes: payload } : (payload || {});
    if (!Array.isArray(source.nodes)) return false;
    const nodes = source.nodes.map(normaliseDmxNode);
    const committed = updateDmx(dmx => { dmx.nodes = nodes; }, 'Art-Net nodes reported', 'nodes');
    return committed ? clone(committed.nodes) : false;
  }

  function reportDmxRuntime(payload) {
    const source = payload && payload.runtime ? payload.runtime : payload;
    if (!source || typeof source !== 'object') return false;
    const committed = updateDmx(dmx => {
      dmx.runtime = normaliseDmxRuntime(Object.assign({}, dmx.runtime, source));
    }, 'DMX bridge runtime reported', 'runtime');
    return committed ? clone(committed.runtime) : false;
  }

  function normaliseTargetHost(value) {
    let source = text(value);
    if (!source) throw new Error('Arena Host is required.');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(source)) source = `http://${source}`;
    let parsed;
    try { parsed = new URL(source); } catch (_) { throw new Error('Arena Host must be a valid host or IP with an optional port.'); }
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) throw new Error('Arena Host must use HTTP without credentials.');
    if (!parsed.hostname || !validNetworkAddress(parsed.hostname, { allowHostname: true })) {
      throw new Error('Arena Host must contain a valid IP address or hostname.');
    }
    const port = parsed.port ? parsePort(parsed.port, 'Arena Host port') : 8080;
    let hostname = parsed.hostname;
    if (isIPv6(hostname) && !/^\[/.test(hostname)) hostname = `[${hostname}]`;
    return `${hostname}:${port}`;
  }

  async function probeWebserver(target) {
    let host;
    try { host = normaliseTargetHost(target || ($('webserverTargetHost') && $('webserverTargetHost').value)); }
    catch (error) {
      status('webserverConnectionStatus', error.message, 'error');
      throw error;
    }
    const button = $('webserverProbe');
    if (button) button.disabled = true;
    status('webserverConnectionStatus', `Probing http://${host}/api/v1/product …`, 'warning');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`http://${host}/api/v1/product`, {
        method: 'GET', mode: 'cors', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      const product = await response.json();
      const productName = text(product && (product.name || product.product || product.application));
      if (!productName) throw new Error('The endpoint returned no product identity.');
      const recognised = /(?:resolume\s*)?(arena|avenue)/i.test(productName);
      const stamp = now();
      updateWebserver(webserver => {
        webserver.targetHost = host;
        webserver.lastProbeAt = stamp;
        webserver.status = recognised ? `Reachable · ${productName}` : `Reachable, unrecognised product · ${productName}`;
        webserver.lastError = recognised ? '' : 'The endpoint responded, but it did not identify itself as Resolume Arena or Avenue.';
      }, 'Arena REST endpoint probed', 'targetHost');
      Hub.patch('connection', {
        host, product: productName, lastSeenAt: stamp,
        error: recognised ? '' : 'REST product is not Arena or Avenue'
      }, { reason: 'Arena REST product probe' });
      status('webserverConnectionStatus', recognised
        ? `REST probe reached ${productName} at ${host}. This proves HTTP reachability, not a live WebSocket connection.`
        : `HTTP responded as ${productName}, not Resolume Arena or Avenue.`, recognised ? 'ready' : 'warning');
      return { ok: recognised, reachable: true, host, product };
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? `Probe timed out after 2.5 seconds for ${host}.`
        : `Probe failed for ${host}: ${error && error.message || error}`;
      updateWebserver(webserver => {
        webserver.targetHost = host;
        webserver.lastProbeAt = now();
        webserver.status = 'Unreachable';
        webserver.lastError = message;
      }, 'Arena REST endpoint probe failed', 'targetHost');
      Hub.patch('connection', { host, error: message }, { reason: 'Arena REST product probe failed' });
      status('webserverConnectionStatus', message, 'error');
      return { ok: false, reachable: false, host, error: message };
    } finally {
      clearTimeout(timer);
      if (button) button.disabled = false;
    }
  }

  function connectArena(target) {
    let host;
    try { host = normaliseTargetHost(target || ($('webserverTargetHost') && $('webserverTargetHost').value)); }
    catch (error) {
      status('webserverConnectionStatus', error.message, 'error');
      return { connected: false, error: error.message };
    }
    updateWebserver(webserver => {
      webserver.targetHost = host;
      webserver.status = 'Connection requested';
      webserver.lastError = '';
    }, 'Arena target changed', 'targetHost');
    Hub.patch('connection', { host, status: 'connecting', error: '' }, { reason: 'Arena connection requested' });
    if (global.ArenaLive && typeof global.ArenaLive.connect === 'function') {
      try {
        global.ArenaLive.connect(host);
        status('webserverConnectionStatus', `Connecting ArenaLive to ${host} …`, 'warning');
        return { connected: false, requested: true, host };
      } catch (error) {
        const message = `ArenaLive could not start a connection to ${host}: ${error && error.message || error}`;
        updateWebserver(webserver => {
          webserver.status = 'Connection failed';
          webserver.lastError = message;
        }, 'Arena connection request failed', 'targetHost');
        Hub.patch('connection', { host, status: 'offline', error: message }, { reason: 'ArenaLive connection failed' });
        status('webserverConnectionStatus', message, 'error');
        return { connected: false, requested: false, host, error: message };
      }
    }
    Hub.patch('connection', { host, status: 'offline', error: 'ArenaLive client is not loaded on this page' }, { reason: 'ArenaLive unavailable' });
    status('webserverConnectionStatus', `Saved ${host}, but ArenaLive is not loaded on this page. No connection was claimed.`, 'warning');
    return { connected: false, requested: false, host, reason: 'ArenaLive unavailable' };
  }

  async function chooseWebRoot() {
    if (typeof global.showDirectoryPicker !== 'function') {
      status('webserverHostStatus', 'This browser does not expose a directory picker. Enter the native Arena path manually.', 'warning');
      return null;
    }
    try {
      const handle = await global.showDirectoryPicker({ mode: 'read' });
      if (!handle) return null;
      directoryHandle = handle;
      const displayName = text(handle.name);
      if (!displayName) throw new Error('The browser did not expose a directory name.');
      updateWebserver(webserver => { webserver.rootDirectory = displayName; }, 'Webserver root selected', 'rootDirectory');
      status('webserverHostStatus', `Selected “${displayName}”. Browsers conceal the absolute path; native Arena must be given the corresponding full path.`, 'warning');
      return handle;
    } catch (error) {
      if (error && error.name === 'AbortError') return null;
      status('webserverHostStatus', `Directory selection failed: ${error && error.message || error}`, 'error');
      return null;
    }
  }

  function migrateLegacyValues() {
    const values = Hub.get('preferences.values', {}) || {};
    const has = prefix => Object.keys(values).some(key => key.startsWith(prefix));
    const rawOsc = Hub.get('preferences.osc', null);
    const rawDmx = Hub.get('preferences.dmx', null);
    const rawWeb = Hub.get('preferences.webserver', null);
    const migrateOsc = has('osc.') && !(rawOsc && Number(rawOsc.updatedAt) > 0);
    const migrateDmx = has('dmx.') && !(rawDmx && Number(rawDmx.updatedAt) > 0);
    const migrateWeb = has('webserver.') && !(rawWeb && Number(rawWeb.updatedAt) > 0);
    if (!migrateOsc && !migrateDmx && !migrateWeb) return;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const migratedAt = now();
      if (migrateOsc) {
        const osc = normaliseOsc(preferences.osc);
        if ('osc.input.osc-input' in values) osc.input.enabled = bool(values['osc.input.osc-input'], osc.input.enabled);
        if ('osc.input.incoming-port' in values && validPort(values['osc.input.incoming-port'])) osc.input.port = Number(values['osc.input.incoming-port']);
        if ('osc.input.announce-with-zeroconf' in values) osc.input.zeroconf = bool(values['osc.input.announce-with-zeroconf'], osc.input.zeroconf);
        if ('osc.output.osc-output' in values) osc.output.enabled = bool(values['osc.output.osc-output'], osc.output.enabled);
        if (['Localhost', 'Broadcast', 'Manual IP'].includes(values['osc.output.destination'])) osc.output.destination = values['osc.output.destination'];
        if (values['osc.output.outgoing-address']) osc.output.address = text(values['osc.output.outgoing-address']);
        if ('osc.output.outgoing-port' in values && validPort(values['osc.output.outgoing-port'])) osc.output.port = Number(values['osc.output.outgoing-port']);
        if ('osc.output.use-bundles' in values) osc.output.bundles = bool(values['osc.output.use-bundles'], osc.output.bundles);
        osc.updatedAt = migratedAt;
        preferences.osc = osc;
      }
      if (migrateDmx) {
        const dmx = normaliseDmx(preferences.dmx);
        if (Array.isArray(values['dmx.adapters'])) dmx.adapters = normaliseDmxAdapters(values['dmx.adapters'], dmx.adapter);
        if (values['dmx.artnet.network-adapter']) {
          const adapterId = text(values['dmx.artnet.network-adapter']);
          const adapter = dmx.adapters.find(item => item.id === adapterId)
            || normaliseDmxAdapter({ id: adapterId, label: adapterId, available: null }, dmx.adapters.length);
          dmx.adapters = normaliseDmxAdapters(dmx.adapters, adapter);
          dmx.adapter = Object.assign({}, adapter, { status: 'Configuration only' });
        }
        if (values['dmx.artnet.artnet-node-name']) dmx.artnet.nodeName = text(values['dmx.artnet.artnet-node-name']);
        if ('dmx.artnet.output-framerate' in values) dmx.artnet.outputFramerate = integer(values['dmx.artnet.output-framerate'], dmx.artnet.outputFramerate, 1, 60);
        if ('dmx.artnet.output-delay' in values) dmx.artnet.outputDelayMs = integer(values['dmx.artnet.output-delay'], dmx.artnet.outputDelayMs, 0, 200);
        if ('dmx.artnet.send-artsync' in values) dmx.artnet.sendArtSync = bool(values['dmx.artnet.send-artsync'], dmx.artnet.sendArtSync);
        if (Array.isArray(values['dmx.nodes'])) dmx.nodes = values['dmx.nodes'].map(normaliseDmxNode);
        if (values['dmx.runtime'] && typeof values['dmx.runtime'] === 'object') dmx.runtime = normaliseDmxRuntime(values['dmx.runtime']);
        if (Array.isArray(values['dmx.inputs.lumiverses'])) dmx.inputs = normaliseDmx({ inputs: values['dmx.inputs.lumiverses'] }).inputs;
        dmx.updatedAt = migratedAt;
        preferences.dmx = dmx;
      }
      if (migrateWeb) {
        const webserver = normaliseWebserver(preferences.webserver);
        if ('webserver.enable-webserver-rest-api.enabled' in values) webserver.enabled = bool(values['webserver.enable-webserver-rest-api.enabled'], webserver.enabled);
        if (values['webserver.enable-webserver-rest-api.listen-address']) webserver.listenAddress = text(values['webserver.enable-webserver-rest-api.listen-address']);
        if ('webserver.enable-webserver-rest-api.listen-port' in values && validPort(values['webserver.enable-webserver-rest-api.listen-port'])) webserver.port = Number(values['webserver.enable-webserver-rest-api.listen-port']);
        if (values['webserver.enable-webserver-rest-api.root-directory']) webserver.rootDirectory = text(values['webserver.enable-webserver-rest-api.root-directory']);
        if (values['webserver.arena-connection.target-host']) webserver.targetHost = text(values['webserver.arena-connection.target-host']);
        webserver.updatedAt = migratedAt;
        preferences.webserver = webserver;
      }
      preferences.updatedAt = migratedAt;
    }, { changedPath: 'preferences', reason: 'Migrate network preference projections' });
  }

  function canonicaliseNetworkPreferences() {
    const rawOsc = Hub.get('preferences.osc', null);
    const rawDmx = Hub.get('preferences.dmx', null);
    const rawWebserver = Hub.get('preferences.webserver', null);
    const osc = normaliseOsc(rawOsc);
    const dmx = normaliseDmx(rawDmx);
    const webserver = normaliseWebserver(rawWebserver);
    const oscChanged = JSON.stringify(rawOsc || {}) !== JSON.stringify(osc);
    const dmxChanged = JSON.stringify(rawDmx || {}) !== JSON.stringify(dmx);
    const webserverChanged = JSON.stringify(rawWebserver || {}) !== JSON.stringify(webserver);
    if (!oscChanged && !dmxChanged && !webserverChanged) return;
    const updatedAt = now();
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      let values = Object.assign({}, preferences.values || {});
      if (oscChanged) {
        osc.updatedAt = updatedAt;
        preferences.osc = osc;
        values = Object.assign(values, oscFlat(osc));
      }
      if (dmxChanged) {
        dmx.updatedAt = updatedAt;
        preferences.dmx = dmx;
        values = Object.assign(values, dmxFlat(dmx));
      }
      if (webserverChanged) {
        webserver.updatedAt = updatedAt;
        preferences.webserver = webserver;
        values = Object.assign(values, webserverFlat(webserver));
      }
      preferences.values = values;
      preferences.updatedAt = updatedAt;
    }, { changedPath: 'preferences', reason: 'Canonicalise network preferences' });
  }

  function bindOscControls() {
    $('oscInputEnabled')?.addEventListener('change', event => updateOsc(osc => {
      osc.input.enabled = event.target.checked;
    }, 'OSC input changed', 'input.enabled'));
    $('oscInputPort')?.addEventListener('change', event => {
      try {
        const port = parsePort(event.target.value, 'Incoming Port');
        event.target.removeAttribute('aria-invalid');
        updateOsc(osc => { osc.input.port = port; }, 'OSC input port changed', 'input.port');
      } catch (error) {
        event.target.setAttribute('aria-invalid', 'true');
        status('oscInputStatus', error.message, 'error');
      }
    });
    $('oscZeroconf')?.addEventListener('change', event => updateOsc(osc => {
      osc.input.zeroconf = event.target.checked;
    }, 'OSC ZeroConf changed', 'input.zeroconf'));
    $('oscOutputEnabled')?.addEventListener('change', event => updateOsc(osc => {
      osc.output.enabled = event.target.checked;
    }, 'OSC output changed', 'output.enabled'));
    $('oscOutputDestination')?.addEventListener('change', event => updateOsc(osc => {
      osc.output.destination = event.target.value;
    }, 'OSC destination changed', 'output.destination'));
    $('oscOutputAddress')?.addEventListener('change', event => {
      const address = text(event.target.value);
      if (!validNetworkAddress(address)) {
        event.target.setAttribute('aria-invalid', 'true');
        status('oscOutputStatus', 'Outgoing Address must be a valid IPv4 or IPv6 address.', 'error');
        return;
      }
      event.target.removeAttribute('aria-invalid');
      updateOsc(osc => {
        osc.output.address = address;
      }, 'OSC address changed', 'output.address');
    });
    $('oscOutputPort')?.addEventListener('change', event => {
      try {
        const port = parsePort(event.target.value, 'Outgoing Port');
        event.target.removeAttribute('aria-invalid');
        updateOsc(osc => { osc.output.port = port; }, 'OSC output port changed', 'output.port');
      } catch (error) {
        event.target.setAttribute('aria-invalid', 'true');
        status('oscOutputStatus', error.message, 'error');
      }
    });
    $('oscBundles')?.addEventListener('change', event => updateOsc(osc => {
      osc.output.bundles = event.target.checked;
    }, 'OSC bundle setting changed', 'output.bundles'));

    $('oscMonitorOpen')?.addEventListener('click', () => {
      $('oscMon')?.classList.add('show');
      renderOscMonitor();
    });
    $('oscMonitorDirection')?.addEventListener('change', event => {
      monitorDirection = event.target.value;
      renderOscMonitor();
    });
    $('oscMonitorPause')?.addEventListener('click', event => {
      monitorPaused = !monitorPaused;
      event.currentTarget.textContent = monitorPaused ? 'Resume' : 'Pause';
      event.currentTarget.classList.toggle('on', monitorPaused);
      if (!monitorPaused) renderOscMonitor(); else renderOscMonitorStatus();
    });
    $('oscMonitorClear')?.addEventListener('click', () => {
      monitorEntries = [];
      monitorCounts = { in: 0, out: 0 };
      renderOscMonitor();
    });
    $('oscTestInject')?.addEventListener('click', () => {
      try {
        const result = injectOsc($('oscTestAddress')?.value, parseTestValue($('oscTestValue')?.value), { source: 'Preferences test injector' });
        const route = result.route;
        status('oscInputStatus', route.triggered
          ? `Injected and routed ${result.message.address} → ${route.action}.`
          : `Injected ${result.message.address}; ${route.reason || 'no Arena action was matched.'}`, route.triggered ? 'ready' : 'warning');
      } catch (error) {
        status('oscInputStatus', error.message || String(error), 'error');
      }
    });
  }

  function bindDmxControls() {
    $('dmxMonitorOpen')?.addEventListener('click', () => {
      $('dmxMon')?.classList.add('show');
      scheduleDmxMonitorRender(true);
    });
    $('dmxMonitorToggle')?.addEventListener('click', event => {
      dmxMonitorRunning = !dmxMonitorRunning;
      event.currentTarget.textContent = dmxMonitorRunning ? 'Disarm' : 'Arm';
      event.currentTarget.classList.toggle('on', dmxMonitorRunning);
      renderDmxMonitorStatus();
    });
    $('dmxMonitorClear')?.addEventListener('click', clearDmxMonitor);
    ['dmxMonitorAdapter', 'dmxMonitorSubnet', 'dmxMonitorUniverse', 'dmxMonitorBank'].forEach(id => {
      $(id)?.addEventListener('change', () => {
        dmxMonitorSelectedChannel = null;
        scheduleDmxMonitorRender(true);
      });
    });
    $('dmxChannelGrid')?.addEventListener('click', event => {
      const cell = event.target.closest('[data-channel]');
      if (!cell) return;
      dmxMonitorSelectedChannel = integer(cell.dataset.channel, null, 1, 512);
      scheduleDmxMonitorRender(true);
    });
    $('dmxRefreshAdapters')?.addEventListener('click', requestDmxAdapters);
    $('dmxPollNodes')?.addEventListener('click', requestArtNetNodes);
    $('dmxNetworkAdapter')?.addEventListener('change', event => {
      const selectedId = event.target.value;
      updateDmx(dmx => {
        const adapter = dmx.adapters.find(item => item.id === selectedId);
        if (adapter) dmx.adapter = Object.assign({}, adapter, { status: 'Configuration only' });
      }, 'Art-Net adapter changed', 'adapter');
    });
    $('dmxNodeName')?.addEventListener('change', event => {
      const name = text(event.target.value);
      if (!name) {
        event.target.setAttribute('aria-invalid', 'true');
        status('dmxArtNetStatus', 'Art-Net Node Name is required.', 'error');
        return;
      }
      event.target.removeAttribute('aria-invalid');
      updateDmx(dmx => { dmx.artnet.nodeName = name.slice(0, 63); }, 'Art-Net node name changed', 'artnet.nodeName');
    });
    $('dmxOutputFramerate')?.addEventListener('input', event => {
      const value = integer(event.target.value, 40, 1, 60);
      setControl('dmxOutputFramerateValue', 'value', value);
      updateDmx(dmx => { dmx.artnet.outputFramerate = value; }, 'Art-Net output framerate changed', 'artnet.outputFramerate');
    });
    $('dmxOutputDelay')?.addEventListener('input', event => {
      const value = integer(event.target.value, 40, 0, 200);
      setControl('dmxOutputDelayValue', 'value', value);
      updateDmx(dmx => { dmx.artnet.outputDelayMs = value; }, 'Art-Net output delay changed', 'artnet.outputDelayMs');
    });
    $('dmxSendArtSync')?.addEventListener('change', event => updateDmx(dmx => {
      dmx.artnet.sendArtSync = event.target.checked;
    }, 'ArtSync changed', 'artnet.sendArtSync'));
    $('dmxAddInput')?.addEventListener('click', addDmxInput);
    $('dmxRemoveInput')?.addEventListener('click', () => removeDmxInput());
    const rememberDmxInput = event => {
      const body = $('dmxInputsBody');
      const row = event.target.closest('tr[data-input-id]');
      if (!body || !row) return;
      lastInteractedDmxInputId = row.dataset.inputId;
      body.querySelectorAll('tr[data-input-id]').forEach(item => {
        const selected = item.dataset.inputId === lastInteractedDmxInputId;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-selected', String(selected));
      });
    };
    $('dmxInputsBody')?.addEventListener('pointerdown', rememberDmxInput);
    $('dmxInputsBody')?.addEventListener('focusin', rememberDmxInput);
    $('dmxInputsBody')?.addEventListener('click', event => {
      const row = event.target.closest('tr[data-input-id]');
      if (row && !event.target.closest('input, select, button')) selectDmxInput(row.dataset.inputId);
    });
    $('dmxInputsBody')?.addEventListener('change', event => {
      const control = event.target;
      const id = control.dataset && control.dataset.inputId;
      const field = control.dataset && control.dataset.field;
      if (!id || !field) return;
      lastInteractedDmxInputId = id;
      let value;
      if (field === 'enabled') value = control.checked;
      else if (field === 'name') {
        value = text(control.value);
        if (!value) {
          control.setAttribute('aria-invalid', 'true');
          status('dmxInputStatus', 'Input Lumiverse name is required.', 'error');
          return;
        }
      } else {
        const ranges = { channelOffset: [0, 511], subnet: [0, 15], universe: [0, 15] };
        const [min, max] = ranges[field];
        value = Number(control.value);
        if (!Number.isInteger(value) || value < min || value > max) {
          control.setAttribute('aria-invalid', 'true');
          status('dmxInputStatus', `${field} must be a whole number from ${min} to ${max}.`, 'error');
          return;
        }
      }
      control.removeAttribute('aria-invalid');
      updateDmx(dmx => {
        const item = dmx.inputs.find(entry => entry.id === id);
        if (item) item[field] = value;
        dmx.selectedInputId = id;
      }, 'DMX input changed', `inputs.${field}`);
    });
  }

  function bindWebserverControls() {
    $('webserverEnabled')?.addEventListener('change', event => updateWebserver(webserver => {
      webserver.enabled = event.target.checked;
      webserver.status = event.target.checked ? 'Configured only' : 'Disabled';
      webserver.lastError = '';
    }, 'Native webserver configuration changed', 'enabled'));
    $('webserverAddress')?.addEventListener('change', event => {
      const address = text(event.target.value);
      if (!validNetworkAddress(address, { allowAny: true })) {
        event.target.setAttribute('aria-invalid', 'true');
        status('webserverHostStatus', 'Listen Address must be a valid IPv4 or IPv6 address.', 'error');
        return;
      }
      event.target.removeAttribute('aria-invalid');
      updateWebserver(webserver => { webserver.listenAddress = address; }, 'Webserver listen address changed', 'listenAddress');
    });
    $('webserverPort')?.addEventListener('change', event => {
      try {
        const port = parsePort(event.target.value, 'Listen Port');
        event.target.removeAttribute('aria-invalid');
        updateWebserver(webserver => { webserver.port = port; }, 'Webserver listen port changed', 'port');
      } catch (error) {
        event.target.setAttribute('aria-invalid', 'true');
        status('webserverHostStatus', error.message, 'error');
      }
    });
    $('webserverRoot')?.addEventListener('change', event => {
      const path = text(event.target.value);
      const error = rootDirectoryError(path);
      if (error) {
        event.target.setAttribute('aria-invalid', 'true');
        status('webserverHostStatus', error, 'error');
        return;
      }
      event.target.removeAttribute('aria-invalid');
      updateWebserver(webserver => { webserver.rootDirectory = path; }, 'Webserver root changed', 'rootDirectory');
    });
    $('webserverBrowse')?.addEventListener('click', chooseWebRoot);
    $('webserverConnect')?.addEventListener('click', () => connectArena());
    $('webserverProbe')?.addEventListener('click', () => { probeWebserver().catch(() => {}); });
    $('webserverTargetHost')?.addEventListener('change', event => {
      try {
        const host = normaliseTargetHost(event.target.value);
        event.target.value = host;
        event.target.removeAttribute('aria-invalid');
        updateWebserver(webserver => {
          webserver.targetHost = host;
          webserver.lastError = '';
        }, 'Arena target saved', 'targetHost');
        Hub.patch('connection', { host }, { reason: 'Arena target saved' });
      } catch (error) {
        event.target.setAttribute('aria-invalid', 'true');
        status('webserverConnectionStatus', error.message, 'error');
      }
    });
  }

  function bindHubTraffic() {
    const ownsIncomingRouting = isArenaRuntime();
    Hub.on('openlive:osc-message', (payload, meta) => {
      const message = retainOscMessage(payload, meta);
      if (!ownsIncomingRouting || !message || message.direction !== 'in' || message.routed) return;
      const osc = normaliseOsc(Hub.get('preferences.osc'));
      if (!osc.input.enabled) return;
      try {
        const route = routeOscAddress(message.address, firstOscValue(message), message);
        Hub.emit('openlive:osc-route-result', { messageId: message.id, address: message.address, route }, { activity: false });
      } catch (error) {
        Hub.emit('openlive:osc-route-result', {
          messageId: message.id, address: message.address,
          route: { matched: true, triggered: false, reason: error.message || String(error) }
        }, { activity: false });
      }
    });
    Hub.on('osc:message', retainOscMessage);
    Hub.on('openlive:dmx-message', retainDmxMonitorMessage);
    Hub.on('openlive:dmx-adapter-discovery-result', reportDmxAdapters);
    Hub.on('openlive:dmx-adapter-catalog', reportDmxAdapters);
    Hub.on('openlive:artnet-node-poll-result', reportArtNetNodes);
    Hub.on('openlive:artnet-nodes', reportArtNetNodes);
    Hub.on('openlive:dmx-bridge-status', reportDmxRuntime);
    Hub.on('openlive:dmx-input', (payload, meta) => {
      try { publishDmxBridgeInput(payload, meta); }
      catch (_) { /* malformed bridge messages are ignored and never represented as live input */ }
    });
    Hub.on('openlive:osc-input', (payload, meta) => {
      if (!payload || !payload.address) return;
      retainOscMessage(Object.assign({ direction: 'in' }, payload), meta);
      if (!ownsIncomingRouting) return;
      try {
        injectOsc(payload.address, payload.args || payload.value, {
          args: payload.args,
          id: text(payload.id) || (meta && meta.id),
          at: payload.at || payload.timestamp || (meta && meta.at),
          source: payload.source || (meta && meta.source) || 'OSC bridge'
        });
      }
      catch (_) { /* malformed bridge messages are ignored and never faked */ }
    });
  }

  function bindArenaLiveStatus() {
    const AL = global.ArenaLive;
    if (!AL || typeof AL.on !== 'function') return;
    AL.on('status', state => {
      const host = typeof AL.host === 'function' ? AL.host() : Hub.get('preferences.webserver.targetHost', DEFAULT_WEBSERVER.targetHost);
      Hub.patch('connection', {
        host, status: state === 'live' ? 'live' : state === 'connecting' ? 'connecting' : 'offline',
        lastSeenAt: state === 'live' ? now() : Hub.get('connection.lastSeenAt', 0),
        error: state === 'live' ? '' : text(AL.error)
      }, { reason: 'ArenaLive status changed' });
      if (state === 'live') status('webserverConnectionStatus', `Connected to ${host}.`, 'ready');
      else if (state === 'connecting') status('webserverConnectionStatus', `Connecting to ${host} …`, 'warning');
      else status('webserverConnectionStatus', `ArenaLive is offline for ${host}.`, 'warning');
    });
  }

  function initialise() {
    migrateLegacyValues();
    canonicaliseNetworkPreferences();
    bindOscControls();
    bindDmxControls();
    bindWebserverControls();
    bindHubTraffic();
    bindArenaLiveStatus();
    Hub.subscribe('preferences.osc', renderOsc);
    Hub.subscribe('preferences.dmx', renderDmx);
    Hub.subscribe('preferences.webserver', renderWebserver);
    renderOscMonitor();
  }

  const oscApi = Object.freeze({
    inject: injectOsc,
    send: sendOsc,
    route: (address, value) => routeOscAddress(address, value, null),
    monitor: () => clone(monitorEntries),
    clearMonitor: () => { monitorEntries = []; monitorCounts = { in: 0, out: 0 }; renderOscMonitor(); },
    configuration: () => normaliseOsc(Hub.get('preferences.osc'))
  });
  global.OpenLiveOsc = oscApi;

  global.OpenLiveNetworkPreferences = Object.freeze({
    get: () => ({
      osc: normaliseOsc(Hub.get('preferences.osc')),
      dmx: normaliseDmx(Hub.get('preferences.dmx')),
      webserver: normaliseWebserver(Hub.get('preferences.webserver'))
    }),
    refresh: renderAll,
    osc: oscApi,
    dmx: Object.freeze({
      addInput: addDmxInput,
      removeInput: removeDmxInput,
      selectInput: selectDmxInput,
      inject: (payload, options) => publishDmxMessage(payload, Object.assign({}, options, { direction: 'in' })),
      publish: publishDmxMessage,
      ingestBridgeInput: publishDmxBridgeInput,
      refreshAdapters: requestDmxAdapters,
      reportAdapters: reportDmxAdapters,
      pollNodes: requestArtNetNodes,
      reportNodes: reportArtNetNodes,
      reportRuntime: reportDmxRuntime,
      monitor: () => ({
        armed: dmxMonitorRunning,
        counts: clone(dmxMonitorCounts),
        lastAt: dmxMonitorLastAt,
        universes: [...dmxMonitorUniverses.values()].map(record => ({
          adapterId: record.adapterId, subnet: record.subnet, universe: record.universe,
          values: Array.from(record.values), seen: Array.from(record.seen), lastAt: record.lastAt, updates: record.updates
        }))
      })
    }),
    webserver: Object.freeze({ connect: connectArena, probe: probeWebserver, chooseRoot: chooseWebRoot }),
    validate: Object.freeze({
      port: validPort,
      address: value => validNetworkAddress(value, { allowAny: true, allowHostname: true }),
      targetHost: value => { try { return normaliseTargetHost(value); } catch (_) { return false; } },
      rootDirectory: value => !rootDirectoryError(value)
    }),
    directoryHandle: () => directoryHandle
  });

  const start = () => Promise.resolve(typeof Hub.ready === 'function' ? Hub.ready() : null)
    .then(initialise)
    .catch(error => console.error('Network preferences initialisation failed', error));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window);
