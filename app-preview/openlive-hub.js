/* OpenLive shared application hub
   -------------------------------------------------------------------------
   A small, dependency-free state, event, and command service shared by every
   OpenLive window. It deliberately stores compact application intent rather
   than Resolume's full composition JSON; ArenaLive remains the authority for
   a connected Resolume instance.

   Synchronisation uses BroadcastChannel and storage events on http(s). A
   canonical hidden relay is also mounted so direct file:// pages (whose
   localStorage buckets can be URL-scoped) still share the same snapshot.
   ------------------------------------------------------------------------- */
(function openLiveHubBootstrap(global) {
  'use strict';

  if (global.OpenLiveHub) return;

  const SCHEMA = 1;
  const STORAGE_KEY = 'openlive.hub.state.v1';
  const EVENT_KEY = 'openlive.hub.event.v1';
  const CHANNEL_NAME = 'openlive-hub-v1';
  const RELAY_FILE = 'openlive-relay.html';
  const page = ((location.pathname.split('/').pop() || 'index.html').split('?')[0] || 'index.html').toLowerCase();
  const clientId = `${page}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  let sequence = 0;
  let logicalTime = 0;
  const seenEvents = new Map();
  const acceptedSnapshotRevisions = new Set();
  const listeners = new Map();
  const subscriptionPaths = new WeakMap();
  let relay = null;
  let relayReady = false;
  let readySettled = false;
  let readyResolve;
  const readyPromise = new Promise(resolve => { readyResolve = resolve; });

  const defaults = {
    meta: { schema: SCHEMA, revision: '0', updatedAt: 0, source: 'defaults' },
    connection: {
      status: 'offline', host: '127.0.0.1:8080', product: 'Resolume Arena',
      lastSeenAt: 0, updatedAt: 0, error: ''
    },
    composition: {
      name: 'Untitled Show', width: 1920, height: 1080,
      activeDeck: 0, activeDeckName: 'Deck 1', selectedLayer: 2,
      selectedColumn: 1, selectedClip: null, layerCount: 3, columnCount: 9,
      files: [], layers: [], groups: [], preview: null
    },
    transport: {
      bpm: 120, playState: 'Play', beat: 0, activeColumn: 1,
      master: 1, bypass: false, crossfader: 0
    },
    preferences: {
      values: {},
      general: {
        updateClipPanelOnExternalTriggers: true,
        clipStartOffsetMs: 0,
        scrollSelection: true,
        unicodeFont: false,
        checkUpdates: true,
        releaseChannel: 'Stable',
        lastUpdateCheckAt: 0,
        updateStatus: 'Never checked',
        startupScreen: true,
        quitConfirmation: true,
        pioneerInterface: 'Automatic',
        updatedAt: 0
      },
      audio: {
        /* The seed for a fresh install. It used to be "Speakers (Realtek HD)" on
           a "WASAPI" driver at 11.61 ms — a device nobody enumerated and a
           latency computed from a buffer size a browser cannot set. The system
           default sink is the one output every machine that can play audio has,
           and latencyMs is measured from the audio context once it starts
           (openlive-audio.js latency()), not seeded with a plausible number. */
        output: {
          deviceId: 'output:default', deviceLabel: 'System Default Output', driver: 'WebAudio',
          channelCount: 2, masterChannels: '1 / 2', previewChannels: 'None', delayMs: 0,
          sampleRate: 48000, bufferSize: 512, active: true, latencyMs: 0
        },
        input: {
          deviceId: 'none', deviceLabel: 'None', channelCount: 0,
          fftChannels: 'None', fftGain: 50, armed: false, permission: 'idle', level: 0
        },
        soundTest: { recordingSeconds: 3 },
        smpte: {
          inputs: [
            { channel: 'None', frameRate: '25', signal: 'No input', timecode: '--:--:--:--' },
            { channel: 'None', frameRate: '25', signal: 'No input', timecode: '--:--:--:--' }
          ],
          outputChannels: 'None', outputFrameRate: '25', oscEnabled: false
        },
        vst: {
          directories: [{ id: 'vst:default', path: 'C:\\Program Files\\VSTPlugins', pluginCount: 0, scannedAt: 0 }],
          selectedId: 'vst:default', plugins: [], needsRestart: false, lastScanAt: 0,
          baselineSignature: 'c:\\program files\\vstplugins'
        },
        updatedAt: 0
      },
      video: {
        ffgl: {
          directories: [{
            id: 'ffgl:extra-effects', path: 'Documents\\Resolume Arena\\Extra Effects',
            automatic: true, removable: false, pluginCount: 0, scannedAt: 0,
            access: 'Always checked at startup'
          }],
          selectedId: 'ffgl:extra-effects', selectedPluginId: null, plugins: [],
          needsRestart: false, lastScanAt: 0,
          baselineSignature: 'documents\\resolume arena\\extra effects'
        },
        dma: {
          mode: 'Force ON', effectiveMode: 'Force ON', customNvidiaProfile: false,
          gpuVendor: '', gpuRenderer: '', webglAvailable: false, isNvidia: false,
          needsRestart: false, baselineSignature: 'force on|0', profileStatus: 'Disabled'
        },
        updatedAt: 0
      },
      midi: {
        access: {
          supported: null, requested: false, permission: 'idle',
          lastError: '', refreshedAt: 0
        },
        devices: [
          {
            id: 'midi:apc40-mkii', name: 'APC40 mkII', manufacturer: 'Akai',
            connected: false, demo: true, inputPortId: null, outputPortId: null,
            inputEnabled: true, clockInputEnabled: false, outputEnabled: true
          },
          {
            id: 'midi:launchpad-pro-mk3', name: 'Launchpad Pro MK3', manufacturer: 'Novation',
            connected: false, demo: true, inputPortId: null, outputPortId: null,
            inputEnabled: false, clockInputEnabled: false, outputEnabled: false
          },
          {
            id: 'midi:loopmidi-port', name: 'loopMIDI Port', manufacturer: 'Tobias Erichsen',
            connected: false, demo: true, inputPortId: null, outputPortId: null,
            inputEnabled: true, clockInputEnabled: true, outputEnabled: false
          }
        ],
        middleC: 'C4',
        clock: {
          sourceDeviceId: 'midi:loopmidi-port', stopMode: 'Start/Stop',
          state: 'Waiting for Start', running: false, bpm: 120,
          lastTickAt: 0, lastStartAt: 0
        },
        updatedAt: 0
      },
      osc: {
        input: { enabled: true, port: 7000, zeroconf: true },
        output: { enabled: false, destination: 'Localhost', address: '127.0.0.1', port: 7001, bundles: true },
        transport: { mode: 'SHOWAVE bridge', status: 'Ready', lastError: '' },
        updatedAt: 0
      },
      dmx: {
        adapter: { id: 'automatic', label: 'Automatic', address: '0.0.0.0', status: 'Configuration only' },
        /* Adapter and node inventories are supplied by an optional native
           Art-Net bridge. Keep them in shared state so Preferences,
           Shortcuts and Advanced Output resolve the same stable IDs. */
        adapters: [
          { id: 'automatic', label: 'Automatic', address: '0.0.0.0', available: null, kind: 'automatic' },
          { id: 'localhost', label: 'Localhost', address: '127.0.0.1', available: null, kind: 'loopback', status: 'Configuration only' }
        ],
        nodes: [],
        runtime: {
          bridgeStatus: 'Not connected', bound: false, receiving: false,
          synchronized: false, lastPacketAt: 0, packetCount: 0, lastError: ''
        },
        artnet: {
          nodeName: 'SHOWAVE Live', outputFramerate: 40, outputDelayMs: 40,
          sendArtSync: false
        },
        /* Advanced Output is the sole editor for output Lumiverses. This is
           its read-only cross-window projection for Preferences/status UIs. */
        outputLumiverses: [],
        selectedOutputLumiverseId: null,
        inputs: [
          { id: 'dmx-input:1', name: 'DMX Input 1', channelOffset: 0, subnet: 0, universe: 0, enabled: true }
        ],
        selectedInputId: 'dmx-input:1',
        updatedAt: 0
      },
      recording: {
        snapshotDirectory: 'Documents\\Resolume Arena\\Recorded',
        recordingDirectory: 'Documents\\Resolume Arena\\Recorded',
        fileNameTemplate: 'Resolume_{date}_{time}',
        folderMode: 'Single Folder',
        recordVideo: true,
        recordAudio: true,
        preset: 'DXV 3 Normal Quality No Alpha',
        container: 'QuickTime (.mov)',
        codec: 'DXV 3',
        quality: 'Normal',
        alpha: false,
        format: 'Normal Quality, No Alpha',
        frameRate: 'Composition',
        videoBitrateMbps: 35,
        audioCodec: 'PCM (WAV)',
        audioSampleRate: 48000,
        audioBitDepth: 24,
        audioChannels: 'Stereo',
        afterRecording: 'Do Nothing',
        customPresets: [],
        updatedAt: 0
      },
      clipRendering: {
        directory: 'Documents\\Resolume Arena\\Renders',
        preset: 'DXV 3 Normal Quality',
        codec: 'DXV 3',
        format: 'Normal Quality, No Alpha',
        includeAudio: true,
        sampleRate: 48000,
        bitDepth: 24,
        updatedAt: 0
      },
      defaults: {
        videoTransport: 'Timeline', videoPlayMode: 'Loop', videoPlayModeAway: 'Restart',
        audioTransport: 'Timeline', audioPlayMode: 'Loop', audioPlayModeAway: 'Restart',
        layerBlendMode: 'Add', tempoNudgeRange: 10,
        updatedAt: 0
      },
      feedback: {
        name: '', email: '', rememberContact: false, includeLog: false,
        lastSubmittedAt: 0, updatedAt: 0
      },
      webserver: {
        enabled: false, listenAddress: '0.0.0.0', port: 8080,
        rootDirectory: 'Documents\\Resolume Arena\\Webserver',
        targetHost: '127.0.0.1:8080', status: 'Disabled', lastProbeAt: 0,
        lastError: '', updatedAt: 0
      }
    },
    shortcuts: {
      activeMap: 'Keyboard', maps: {}, updatedAt: 0
    },
    media: {
      files: [], queue: [], conversionQueue: [], recordingArtifacts: [],
      outputFolder: 'Same as source', updatedAt: 0
    },
    /* Recording preferences describe how the next job should be made. The
       mutable lifecycle lives here instead, so starting/stopping a capture
       never rewrites Preferences or a job's immutable settings snapshot. */
    recording: {
      schemaVersion: 2,
      active: false, armed: false, available: false,
      phase: 'idle', state: 'unavailable', status: 'Arena recording window unavailable',
      authorityClientId: null, authorityPage: null, authorityLeaseAt: 0,
      ownerClientId: null, ownerLeaseAt: 0,
      sessionId: null, jobId: null, source: 'Composition',
      startedAt: null, stoppedAt: null, scheduledFor: null,
      elapsedMs: 0, durationMs: 0, frames: 0, droppedFrames: 0, bytes: 0,
      controls: {
        source: 'Composition', media: 'Both', afterRecording: 'Do Nothing',
        preset: 'DXV 3 Normal Quality No Alpha', startMode: 'Manual', startValue: 0,
        durationMode: 'Manual', durationValue: 10
      },
      preferencesSnapshot: null,
      output: { directory: '', requestedName: '', requestedPath: '' },
      outputPath: '', lastArtifactId: null, lastError: '',
      simulated: true, nativeArenaRequest: false, nativeFileCreated: false,
      limitation: 'Browser simulation records lifecycle and artifact metadata only; it does not encode media or write a native file.',
      updatedAt: 0
    },
    recordingCommands: { entries: {}, gcThrough: '', updatedAt: 0 },
    recordings: {
      items: [], selectedId: null, updatedAt: 0
    },
    fixtures: {
      items: [], selectedId: null, updatedAt: 0
    },
    /* GSL5 owns its complete lighting document and high-rate DMX runtime.
       The Hub carries only the durable project plus a compact cross-window
       projection; universe frames must never enter localStorage. */
    lighting: {
      schema: 1, project: null, selectedCueId: null, activeCueId: null,
      runtime: {
        status: 'unavailable', connected: false, outputting: false,
        lastFrameAt: 0, lastError: ''
      },
      updatedAt: 0
    },
    chaser: {
      schema: 1, project: null, updatedAt: 0
    },
    /* Authored timecode automation is durable; live playhead/record state is
       intentionally broadcast as events by the main SHOWAVE window and never
       stored here.  That keeps a reopened editor stopped while preserving the
       tracks, triggers, markers and options it is meant to edit. */
    timeline: {
      schema: 1, project: null, updatedAt: 0
    },
    wire: {
      activePatchId: null, patches: [], settings: {}, compiled: [], isf: [], updatedAt: 0
    },
    presets: {
      items: [], selectedId: null, updatedAt: 0
    },
    envelope: {
      target: { scope: 'Composition', parameter: 'Opacity', parameterId: null },
      interpolation: 'Smooth', loop: 'Loop', duration: 4, durationUnit: 'Beats',
      keyframes: [{ t: 0, v: 0.5 }, { t: 0.25, v: 1 }, { t: 0.5, v: 0.5 },
        { t: 0.75, v: 0 }, { t: 1, v: 0.5 }],
      previewing: false, updatedAt: 0
    },
    workspace: {
      activeLayout: 'Arena', layout: null, panels: {}, updatedAt: 0
    },
    output: {
      model: null, setup: 'Default', setups: [], draft: null, savedAt: 0, updatedAt: 0,
      selectedScreenId: null, selectedSliceId: null, selectedSliceIds: [],
      view: 'input', activePane: 'input', tool: 'Transform'
    },
    alley: {
      preset: 'DXV 3 HQ', settings: {}, queue: [], jobs: [], updatedAt: 0
    },
    activity: []
  };

  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { throw new TypeError(`OpenLiveHub only accepts serialisable values: ${error.message}`); }
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function withDefaults(base, fallback) {
    const source = isObject(base) ? base : {};
    const result = {};
    Object.keys(fallback).forEach(key => {
      if (isObject(fallback[key])) result[key] = withDefaults(source[key], fallback[key]);
      else result[key] = source[key] === undefined ? clone(fallback[key]) : clone(source[key]);
    });
    Object.keys(source).forEach(key => {
      if (!(key in result)) result[key] = clone(source[key]);
    });
    return result;
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : null;
    } catch (_) { return null; }
  }

  /* Hub commits replace a complete snapshot so every window can stay simple.
     A window that was suspended or loaded from another URL can, however,
     resume with an older Preferences object and then commit an unrelated
     composition/transport change. Preserve the newer Preferences revision in
     that case so an unrelated writer cannot roll back shared controls. */
  function preferencesUpdatedAt(snapshot) {
    return Number(snapshot && snapshot.preferences && snapshot.preferences.updatedAt) || 0;
  }

  function preserveNewerPreferences(candidate, baseline) {
    if (!isObject(candidate) || !isObject(baseline)) return candidate;
    if (preferencesUpdatedAt(baseline) > preferencesUpdatedAt(candidate) && isObject(baseline.preferences)) {
      candidate.preferences = clone(baseline.preferences);
    }
    return candidate;
  }

  /* A background window may edit one Preferences domain after missing a
     broadcast from another. Keep the edited domain from `candidate`, but
     carry newer sibling domains and their flat projections forward from the
     latest persisted snapshot. This prevents an Advanced Output DMX-route
     publish from rolling back unrelated Audio, MIDI or General settings. */
  function mergeConcurrentPreferenceDomain(candidate, baseline, changedPath) {
    if (!isObject(candidate) || !isObject(baseline)) return candidate;
    const parts = pathParts(changedPath);
    if (parts[0] !== 'preferences' || !parts[1] || !isObject(baseline.preferences)) return candidate;
    const domain = parts[1];
    const nextPreferences = isObject(candidate.preferences) ? candidate.preferences : (candidate.preferences = {});
    const basePreferences = baseline.preferences;
    Object.keys(basePreferences).forEach(key => {
      if (key === domain || key === 'values' || key === 'updatedAt') return;
      const baseValue = basePreferences[key], nextValue = nextPreferences[key];
      if (isObject(baseValue) && Number(baseValue.updatedAt) > Number(nextValue && nextValue.updatedAt || 0)) {
        nextPreferences[key] = clone(baseValue);
      }
    });
    const prefix = `${domain}.`;
    const mergedValues = Object.assign({}, nextPreferences.values || {});
    Object.keys(basePreferences.values || {}).forEach(key => {
      if (!key.startsWith(prefix)) mergedValues[key] = clone(basePreferences.values[key]);
    });
    nextPreferences.values = mergedValues;
    nextPreferences.updatedAt = Math.max(
      Number(nextPreferences.updatedAt) || 0,
      Number(basePreferences.updatedAt) || 0,
      Number(nextPreferences[domain] && nextPreferences[domain].updatedAt) || 0
    );
    return candidate;
  }

  function topLevelFreshness(value) {
    if (!isObject(value)) return 0;
    return Math.max(0,
      Number(value.updatedAt) || 0,
      Number(value.leaseAt) || 0,
      Number(value.lastSeenAt) || 0,
      Number(value.authorityLeaseAt) || 0,
      Number(value.ownerLeaseAt) || 0,
      Number(value.requestedAt) || 0,
      Number(value.startedAt) || 0,
      Number(value.stoppedAt) || 0
    );
  }

  function recordingCommandJournalSignature(snapshot) {
    const journal = snapshot && snapshot.recordingCommands || {}, entries = journal.entries || {};
    return `${journal.gcThrough || ''}|${Object.keys(entries).sort().map(id => `${id}:${JSON.stringify(entries[id])}`).join('|')}`;
  }

  function snapshotHasFresherDomain(candidate, baseline) {
    if (!isObject(candidate) || !isObject(baseline)) return false;
    if (preferencesUpdatedAt(candidate) > preferencesUpdatedAt(baseline)) return true;
    if (recordingCommandJournalSignature(candidate) !== recordingCommandJournalSignature(baseline)) return true;
    return Object.keys(candidate).some(key => {
      if (key === 'meta' || key === 'preferences' || key === 'activity') return false;
      return topLevelFreshness(candidate[key]) > topLevelFreshness(baseline[key]);
    });
  }

  function recordingCommandStatusRank(status) {
    if (status === 'completed' || status === 'failed') return 3;
    if (status === 'executing') return 2;
    return 1;
  }

  function recordingCommandOrderKey(id, entry) {
    const createdAt = Math.max(0, Number(entry && entry.createdAt || 0));
    return `${String(createdAt).padStart(16, '0')}:${String(id || '')}`;
  }

  function mergeRecordingCommandJournal(candidate, baseline) {
    if (!isObject(candidate) || !isObject(baseline)) return candidate;
    const nextJournal = isObject(candidate.recordingCommands) ? candidate.recordingCommands : {};
    const baseJournal = isObject(baseline.recordingCommands) ? baseline.recordingCommands : {};
    let gcThrough = [String(nextJournal.gcThrough || ''), String(baseJournal.gcThrough || '')].sort().pop() || '';
    const merged = {};
    const mergeEntries = entries => Object.entries(isObject(entries) ? entries : {}).forEach(([id, entry]) => {
      if (recordingCommandOrderKey(id, entry) <= gcThrough) return;
      const current = merged[id];
      if (!isObject(current)) { merged[id] = clone(entry); return; }
      const currentRank = recordingCommandStatusRank(current.status);
      const entryRank = recordingCommandStatusRank(entry && entry.status);
      const currentAt = Number(current.updatedAt || 0), entryAt = Number(entry && entry.updatedAt || 0);
      if (entryRank > currentRank || (entryRank === currentRank && entryAt > currentAt)) merged[id] = clone(entry);
    });
    mergeEntries(baseJournal.entries);
    mergeEntries(nextJournal.entries);

    /* Keep a bounded terminal history. GC advances only through a contiguous
       terminal prefix, so an older pending/executing command can never be
       skipped. The shared watermark makes deletion converge and prevents an
       old relay snapshot from resurrecting a removed terminal command. */
    const ordered = Object.entries(merged).sort((left, right) =>
      recordingCommandOrderKey(left[0], left[1]).localeCompare(recordingCommandOrderKey(right[0], right[1])));
    let terminalCount = ordered.filter(([, entry]) => recordingCommandStatusRank(entry && entry.status) === 3).length;
    for (const [id, entry] of ordered) {
      if (terminalCount <= 160 || recordingCommandStatusRank(entry && entry.status) !== 3) break;
      gcThrough = recordingCommandOrderKey(id, entry);
      delete merged[id];
      terminalCount -= 1;
    }
    const entryUpdatedAt = Object.values(merged).reduce((latest, entry) =>
      Math.max(latest, Number(entry && entry.updatedAt || 0)), 0);
    candidate.recordingCommands = Object.assign({}, nextJournal, {
      entries: merged, gcThrough,
      updatedAt: Math.max(Number(nextJournal.updatedAt || 0), Number(baseJournal.updatedAt || 0), entryUpdatedAt)
    });
    return candidate;
  }

  /* Editors such as Shortcuts, Fixtures and Advanced Output can remain open
     for a whole show. A later commit from one of those tabs must not roll
     back a newer sibling domain that arrived while the tab was suspended.
     Most domains use updatedAt, while live connection/controller and recorder
     ownership use explicit leases. Whole-state transactions are merged too:
     each root keeps the freshest clock so a controller heartbeat cannot roll
     back a newer recorder heartbeat (or vice versa). */
  function mergeNewerTopLevelDomains(candidate, baseline, changedPath) {
    if (!isObject(candidate) || !isObject(baseline)) return candidate;
    const editedRoot = pathParts(changedPath)[0] || '';
    if (!editedRoot) return candidate;
    Object.keys(baseline).forEach(key => {
      if ((editedRoot !== '*' && key === editedRoot) || key === 'meta' || key === 'preferences' || key === 'activity') return;
      const baseValue = baseline[key], nextValue = candidate[key];
      if (isObject(baseValue) && topLevelFreshness(baseValue) > topLevelFreshness(nextValue)) {
        candidate[key] = clone(baseValue);
      }
    });
    return candidate;
  }

  /* Recording controls are editable from detached panels while runtime and
     ownership continue changing in Arena. A nested controls edit must be
     applied onto the freshest persisted runtime instead of replacing that
     runtime with the panel's older copy. */
  function mergeConcurrentRecordingField(candidate, baseline, changedPath) {
    const parts = pathParts(changedPath);
    if (parts[0] !== 'recording' || parts.length < 2 || !isObject(baseline && baseline.recording)) return candidate;
    const editedValue = clone(valueAt(candidate, parts));
    if (topLevelFreshness(baseline.recording) > topLevelFreshness(candidate.recording)) {
      candidate.recording = clone(baseline.recording);
      assignAt(candidate, parts, editedValue);
    }
    candidate.recording.updatedAt = Math.max(Number(candidate.recording.updatedAt) || 0, Date.now());
    return candidate;
  }

  let state = withDefaults(readLocal(), defaults);
  logicalTime = Number(state.meta && state.meta.updatedAt) || 0;

  function pathParts(path) {
    if (Array.isArray(path)) return path.map(String).filter(Boolean);
    return String(path || '').split('.').map(part => part.trim()).filter(Boolean);
  }

  function valueAt(root, path) {
    return pathParts(path).reduce((value, key) => value == null ? undefined : value[key], root);
  }

  function assignAt(root, path, value) {
    const parts = pathParts(path);
    if (!parts.length) return clone(value);
    let cursor = root;
    parts.slice(0, -1).forEach(key => {
      if (!isObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    });
    cursor[parts[parts.length - 1]] = clone(value);
    return root;
  }

  function revision() {
    logicalTime = Math.max(Date.now(), logicalTime + 1);
    return {
      schema: SCHEMA,
      revision: `${logicalTime.toString(36)}-${clientId}-${(++sequence).toString(36)}`,
      updatedAt: logicalTime,
      source: clientId
    };
  }

  function notify(name, detail, meta) {
    const calls = [...(listeners.get(name) || []), ...(listeners.get('*') || [])];
    calls.forEach(fn => {
      try {
        let value;
        if (name === 'state' && subscriptionPaths.has(fn)) {
          const path = subscriptionPaths.get(fn), changed = detail.changedPath || '*';
          if (path && changed !== '*' && changed !== path && !changed.startsWith(`${path}.`) && !path.startsWith(`${changed}.`)) return;
          /* A path subscriber needs only its value. Cloning the full before/
             after Show for every unrelated control made heartbeat delivery
             scale with both project size and the number of open panels. */
          value = get(path);
        } else value = clone(detail);
        fn(value, Object.assign({ type: name, source: clientId, external: false }, meta || {}));
      }
      catch (error) { setTimeout(() => { throw error; }, 0); }
    });
  }

  function rememberEvent(id) {
    if (!id || seenEvents.has(id)) return false;
    seenEvents.set(id, Date.now());
    if (seenEvents.size > 160) {
      [...seenEvents.keys()].slice(0, 60).forEach(key => seenEvents.delete(key));
    }
    return true;
  }

  let channel = null;
  try { channel = 'BroadcastChannel' in global ? new BroadcastChannel(CHANNEL_NAME) : null; }
  catch (_) { channel = null; }

  function postRelay(message) {
    if (!relay || !relay.contentWindow) return;
    try { relay.contentWindow.postMessage(Object.assign({ __openliveRelay: true }, message), '*'); }
    catch (_) { /* relay is best effort */ }
  }

  function postEverywhere(message) {
    try { if (channel) channel.postMessage(message); } catch (_) { /* noop */ }
    postRelay(message);
  }

  function persist(snapshot, requireLocalPersistence) {
    let stored = false;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); stored = true; } catch (_) { /* private mode */ }
    if (stored || !requireLocalPersistence) {
      postEverywhere({ __openliveHub: true, kind: 'snapshot', source: clientId, state: snapshot });
    }
    return stored;
  }

  function commit(next, changedPath, reason, options) {
    const opts = options || {};
    const previous = state;
    next = withDefaults(next, defaults);
    const persisted = readLocal();
    next = mergeRecordingCommandJournal(next, persisted || {});
    next = mergeNewerTopLevelDomains(next, persisted, changedPath);
    next = mergeConcurrentRecordingField(next, persisted, changedPath);
    if (String(changedPath || '').startsWith('preferences.')) {
      next = mergeConcurrentPreferenceDomain(next, persisted, changedPath);
    } else if (!String(changedPath || '').startsWith('preferences')) {
      next = preserveNewerPreferences(next, persisted);
    }
    next.meta = revision();
    state = next;
    if (!opts.noPersist) {
      const stored = persist(state, !!opts.requireLocalPersistence);
      if (opts.requireLocalPersistence && !stored) {
        state = previous;
        throw new Error('Durable OpenLive storage is unavailable; the command was not emitted.');
      }
    }
    const detail = {
      changedPath: changedPath || '*', reason: reason || 'update',
      value: changedPath && changedPath !== '*' ? valueAt(state, changedPath) : state,
      previous: changedPath && changedPath !== '*' ? valueAt(previous, changedPath) : previous,
      state
    };
    notify('state', detail, { source: state.meta.source, external: false });
    if (changedPath && changedPath !== '*') {
      notify(`change:${changedPath}`, detail.value, { source: state.meta.source, external: false, reason });
    }
    return detail.value;
  }

  function acceptSnapshot(snapshot, source, force) {
    if (!isObject(snapshot)) return false;
    const meta = snapshot.meta;
    const snapshotKey = isObject(meta) && typeof meta.revision === 'string' && meta.revision &&
      typeof meta.source === 'string' && meta.source
      ? JSON.stringify([meta.source, meta.revision, Number(meta.updatedAt) || 0]) : '';
    /* BroadcastChannel, storage and the file:// relay can deliver one revision
       several times. Each committed revision is immutable; ignore repeats
       before cloning large Timeline/Lighting projects for domain merging. */
    if (!force && snapshotKey && acceptedSnapshotRevisions.has(snapshotKey)) return false;
    const hydrated = mergeRecordingCommandJournal(withDefaults(snapshot, defaults), state);
    const hasFresherDomain = snapshotHasFresherDomain(hydrated, state);
    let incoming = preserveNewerPreferences(hydrated, state);
    incoming = mergeNewerTopLevelDomains(incoming, state, '*');
    const incomingTime = Number(incoming.meta && incoming.meta.updatedAt) || 0;
    const currentTime = Number(state.meta && state.meta.updatedAt) || 0;
    const incomingRevision = String(incoming.meta && incoming.meta.revision || '');
    const currentRevision = String(state.meta && state.meta.revision || '');
    const metadataWins = incomingTime > currentTime ||
      (incomingTime === currentTime && incomingRevision > currentRevision);
    if (!force && !metadataWins && !hasFresherDomain) return false;
    const previous = state;
    /* A snapshot can carry a fresher recorder/controller lease even when an
       unrelated writer already advanced the global revision. Publish the
       merged result under a new revision so that contribution converges in
       every tab instead of being merged locally and then discarded. */
    const synthesisedMerge = !force && !metadataWins && hasFresherDomain;
    if (synthesisedMerge) incoming.meta = revision();
    state = incoming;
    if (snapshotKey) {
      acceptedSnapshotRevisions.add(snapshotKey);
      if (acceptedSnapshotRevisions.size > 128)
        acceptedSnapshotRevisions.delete(acceptedSnapshotRevisions.values().next().value);
    }
    logicalTime = Math.max(logicalTime, Number(state.meta && state.meta.updatedAt) || incomingTime);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* noop */ }
    if (synthesisedMerge) {
      postEverywhere({ __openliveHub: true, kind: 'snapshot', source: clientId, state });
    }
    notify('state', { changedPath: '*', reason: 'synchronise', value: state, previous, state }, {
      source: source || (incoming.meta && incoming.meta.source) || 'external', external: true
    });
    return true;
  }

  function dispatchEnvelope(envelope, external) {
    if (!envelope || envelope.kind !== 'event' || !rememberEvent(envelope.id)) return;
    const meta = { source: envelope.source || 'external', at: envelope.at, id: envelope.id, external: !!external };
    notify(envelope.name, envelope.payload, meta);
    if (envelope.name === 'command' && envelope.payload && envelope.payload.target) {
      notify(`command:${envelope.payload.target}`, envelope.payload, meta);
    }
  }

  function receive(message, source) {
    if (!message || !message.__openliveHub || message.source === clientId) return;
    if (message.kind === 'snapshot') acceptSnapshot(message.state, message.source || source, false);
    if (message.kind === 'event') dispatchEnvelope(message, true);
  }

  if (channel) channel.onmessage = event => receive(event.data, 'broadcast');

  global.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try { acceptSnapshot(JSON.parse(event.newValue), 'storage', false); } catch (_) { /* noop */ }
    }
    if (event.key === EVENT_KEY && event.newValue) {
      try { receive(JSON.parse(event.newValue), 'storage'); } catch (_) { /* noop */ }
    }
  });

  global.addEventListener('message', event => {
    const message = event.data;
    if (!message || !message.__openliveRelay) return;
    if (message.kind === 'ready') {
      relayReady = true;
      if (message.state) acceptSnapshot(message.state, 'relay', false);
      // A ready reply completes the handshake. Only iframe load sends hello;
      // replying here would make the relay answer ready again indefinitely.
      settleReady();
      return;
    }
    if (message.kind === 'snapshot') acceptSnapshot(message.state, message.source || 'relay', false);
    if (message.kind === 'event') receive(Object.assign({ __openliveHub: true }, message), 'relay');
  });

  function settleReady() {
    if (readySettled) return;
    readySettled = true;
    readyResolve(api);
    notify('ready', { relay: relayReady, page }, { source: 'hub' });
  }

  function mountRelay() {
    if (global.OpenLiveWebsitePreview) { queueMicrotask(settleReady); return; }
    if (document.getElementById('openlive-relay')) return;
    relay = document.createElement('iframe');
    relay.id = 'openlive-relay';
    relay.title = 'SHOWAVE shared state relay';
    relay.setAttribute('aria-hidden', 'true');
    relay.tabIndex = -1;
    relay.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;border:0;opacity:0;pointer-events:none';
    relay.src = new URL(RELAY_FILE, location.href).href;
    relay.addEventListener('load', () => postRelay({ kind: 'hello', source: clientId }));
    (document.body || document.documentElement).appendChild(relay);
    setTimeout(settleReady, 350);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountRelay, { once: true });
  else mountRelay();

  function get(path, fallback) {
    const value = path ? valueAt(state, path) : state;
    return clone(value === undefined ? fallback : value);
  }

  function set(path, value, options) {
    const next = clone(state);
    assignAt(next, path, value);
    return commit(next, path || '*', options && options.reason || 'set', options);
  }

  function patch(path, values, options) {
    const existing = get(path, {});
    const merged = Object.assign(isObject(existing) ? existing : {}, clone(values || {}));
    return set(path, merged, Object.assign({ reason: 'patch' }, options || {}));
  }

  function transaction(mutator, options) {
    if (typeof mutator !== 'function') throw new TypeError('OpenLiveHub.transaction requires a function');
    const next = clone(state);
    const result = mutator(next);
    commit(next, options && options.changedPath || '*', options && options.reason || 'transaction', options);
    return result;
  }

  function synchronise() {
    const persisted = readLocal();
    if (persisted) acceptSnapshot(persisted, 'local-storage-refresh', true);
    return get();
  }

  function on(name, listener) {
    if (typeof listener !== 'function') return function noop() {};
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return () => {
      const set = listeners.get(name);
      if (set) set.delete(listener);
    };
  }

  function subscribe(path, listener, options) {
    const opts = options || {};
    if (opts.immediate !== false) listener(get(path), { type: 'initial', source: clientId, external: false });
    const receive = (value, meta) => listener(value, meta);
    subscriptionPaths.set(receive, path);
    return on('state', receive);
  }

  function addActivity(label, payload, source) {
    const item = {
      id: `activity:${Date.now().toString(36)}:${(++sequence).toString(36)}`,
      at: Date.now(), source: source || page, label: String(label || 'Activity'),
      payload: clone(payload == null ? {} : payload)
    };
    const next = clone(state);
    next.activity = [item, ...(next.activity || [])].slice(0, 80);
    commit(next, 'activity', 'activity');
    return item;
  }

  function emit(name, payload, options) {
    const opts = options || {};
    const envelope = {
      __openliveHub: true, kind: 'event',
      id: `event:${Date.now().toString(36)}:${clientId}:${(++sequence).toString(36)}`,
      name: String(name), payload: clone(payload == null ? {} : payload),
      source: opts.source || clientId, at: Date.now()
    };
    rememberEvent(envelope.id);
    notify(envelope.name, envelope.payload, { source: envelope.source, at: envelope.at, id: envelope.id, external: false });
    if (envelope.name === 'command' && envelope.payload && envelope.payload.target) {
      notify(`command:${envelope.payload.target}`, envelope.payload, { source: envelope.source, at: envelope.at, id: envelope.id, external: false });
    }
    try { localStorage.setItem(EVENT_KEY, JSON.stringify(envelope)); } catch (_) { /* noop */ }
    postEverywhere(envelope);
    if (opts.activity) addActivity(opts.label || name, payload, opts.source || page);
    return envelope.id;
  }

  function command(target, action, payload, options) {
    const body = {
      id: `command:${Date.now().toString(36)}:${clientId}:${(++sequence).toString(36)}`,
      target: String(target || 'arena'), action: String(action || ''),
      payload: clone(payload == null ? {} : payload), requestedBy: page, requestedAt: Date.now()
    };
    if (/^recording-(?:configure|start|stop)$/.test(body.action)) {
      body.durable = true;
      const entry = {
        version: 2, id: body.id, status: 'pending', command: clone(body),
        createdAt: body.requestedAt, updatedAt: body.requestedAt, attempts: 0
      };
      const next = clone(state);
      next.recordingCommands = isObject(next.recordingCommands) ? next.recordingCommands : { entries: {}, updatedAt: 0 };
      next.recordingCommands.entries = isObject(next.recordingCommands.entries) ? next.recordingCommands.entries : {};
      next.recordingCommands.entries[body.id] = entry;
      next.recordingCommands.updatedAt = body.requestedAt;
      commit(next, 'recordingCommands', 'Durable recording command queued', { requireLocalPersistence: true });
      body.durableJournaled = true;
    }
    emit('command', body, Object.assign({ activity: true, label: `${body.target}: ${body.action}` }, options || {}));
    return body.id;
  }

  function upsert(path, item, idKey, options) {
    const key = idKey || 'id';
    const list = get(path, []);
    const id = item && item[key];
    const index = list.findIndex(entry => entry && entry[key] === id);
    if (index >= 0) list[index] = Object.assign({}, list[index], clone(item));
    else list.push(clone(item));
    set(path, list, Object.assign({ reason: 'upsert' }, options || {}));
    return clone(index >= 0 ? list[index] : list[list.length - 1]);
  }

  function remove(path, id, idKey, options) {
    const key = idKey || 'id';
    const list = get(path, []);
    const next = list.filter(item => !item || item[key] !== id);
    set(path, next, Object.assign({ reason: 'remove' }, options || {}));
    return next.length !== list.length;
  }

  const api = Object.freeze({
    schema: SCHEMA, page, clientId,
    ready: () => readyPromise,
    get, set, patch, transaction, synchronise, on, subscribe, emit, command,
    activity: addActivity, upsert, remove,
    snapshot: () => get(),
    isRelayReady: () => relayReady
  });

  global.OpenLiveHub = api;
})(window);
