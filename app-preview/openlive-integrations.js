/* Cross-window adapters and shared controls for the OpenLive system. */
(function openLiveIntegrations(global) {
  'use strict';

  const HUB = global.OpenLiveHub;
  if (!HUB) return;

  const page = HUB.page;
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const slug = value => String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'value';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const LIVE_AUTHORITY_TTL = 15000;
  const CONTROLLER_AUTHORITY_TTL = 5000;
  const RECORDER_AUTHORITY_TTL = 5000;
  const finiteNumber = value => value !== null && value !== '' && Number.isFinite(Number(value));
  const booleanValue = (value, fallback) => {
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
    if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
    return !!fallback;
  };
  const connectedState = value => /^connected(?:\b|$)/i.test(String(value || '').trim());
  const canonicalArenaKey = key => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const arenaMember = (object, key) => {
    if (!object || typeof object !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
    const wanted = canonicalArenaKey(key);
    const actual = Object.keys(object).find(candidate => canonicalArenaKey(candidate) === wanted);
    return actual == null ? undefined : object[actual];
  };
  const arenaPath = (object, path) => String(path || '').split('.').reduce((node, key) =>
    node == null ? undefined : arenaMember(node, key), object);
  const arenaAlias = (object, aliases) => {
    for (const alias of aliases || []) {
      const item = arenaPath(object, alias);
      if (item !== undefined && item !== null) return item;
    }
    return undefined;
  };
  const liveConnectionFresh = connection => {
    const item = connection || HUB.get('connection', {});
    return String(item.status || '').toLowerCase() === 'live' &&
      Date.now() - Number(item.lastSeenAt || 0) <= LIVE_AUTHORITY_TTL;
  };
  const offlineControllerAuthority = () => {
    if (liveConnectionFresh(HUB.get('connection', {}))) return null;
    const authority = HUB.get('arenaController', {}) || {};
    return authority.clientId && authority.snapshot &&
      Date.now() - Number(authority.leaseAt || 0) <= CONTROLLER_AUTHORITY_TTL ? authority : null;
  };
  const nativeRecordingOwned = recording => {
    const item = recording || {};
    return item.simulated === false && (item.nativeBridge === true || item.provider === 'native' ||
      item.nativeArenaRequest === true || item.nativeFileCreated === true);
  };
  const recordingCommandAuthority = () => {
    const recording = HUB.get('recording', {}) || {}, now = Date.now();
    if (nativeRecordingOwned(recording)) return null;
    const busy = !!(recording.active || recording.armed), ownerClientId = recording.ownerClientId || null;
    const ownerFresh = !!(busy && ownerClientId && Number(recording.ownerLeaseAt || 0) > 0 &&
      now - Number(recording.ownerLeaseAt) <= RECORDER_AUTHORITY_TTL * 2);
    if (ownerFresh) return ownerClientId;
    if (recording.authorityClientId &&
        (!busy || recording.authorityClientId !== ownerClientId) &&
        now - Number(recording.authorityLeaseAt || 0) <= RECORDER_AUTHORITY_TTL) {
      return recording.authorityClientId;
    }
    const connection = HUB.get('connection', {}) || {};
    if (liveConnectionFresh(connection) && connection.authorityPage === 'index.html') {
      return connection.authorityClientId || null;
    }
    const controller = offlineControllerAuthority();
    if (controller && controller.clientId) return controller.clientId;
    /* A stale busy owner has no valid recipient. Every surviving index window
       may contend for the durable command claim; exactly one will reconcile
       the orphaned job instead of silently dropping Stop. */
    if (busy && ownerClientId && !ownerFresh && page === 'index.html' &&
        global.OpenLiveArenaController && typeof global.OpenLiveArenaController.execute === 'function') {
      return HUB.clientId;
    }
    return null;
  };
  function applyBrowserRecordingAuthority(state, clientId, authorityPage, now) {
    const current = state.recording || {};
    if (nativeRecordingOwned(current)) return false;
    const busy = !!(current.active || current.armed), ownerClientId = current.ownerClientId || null;
    const ownerLeaseAt = Number(current.ownerLeaseAt || 0);
    const ownerFresh = !!(busy && ownerClientId && ownerLeaseAt > 0 &&
      now - ownerLeaseAt <= RECORDER_AUTHORITY_TTL * 2);

    /* A scheduled or active simulation must stay with the tab that owns its
       timers. Controller focus may move to another Arena window without
       interrupting that job. Once its explicit heartbeat expires, fail closed
       and let the elected controller expose the error. */
    if (busy && ownerClientId && ownerClientId !== clientId && ownerFresh) return false;

    let next;
    if (busy && (!ownerClientId || !ownerFresh)) {
      next = Object.assign({}, current, {
        active: false, armed: false, available: true,
        phase: 'error', state: 'error', status: 'Error · simulated owner missing/reloaded',
        stoppedAt: now, ownerClientId: null, ownerLeaseAt: 0,
        authorityClientId: clientId, authorityPage, authorityLeaseAt: now,
        lastError: 'The Arena page that owned this browser-simulated recording stopped heartbeating; no native file was created.',
        updatedAt: now
      });
    } else {
      const wasUnavailable = current.phase === 'unavailable' || current.state === 'unavailable';
      next = Object.assign({}, current, {
        active: !!current.active, armed: !!current.armed, available: true,
        phase: wasUnavailable ? 'idle' : (current.phase || 'idle'),
        state: wasUnavailable ? 'idle' : (current.state || 'idle'),
        status: wasUnavailable ? 'Idle · browser simulation' : (current.status || 'Idle · browser simulation'),
        authorityClientId: clientId, authorityPage, authorityLeaseAt: now,
        ownerClientId: busy ? (ownerClientId || clientId) : null,
        updatedAt: now
      });
      if (!busy) next.ownerLeaseAt = 0;
    }
    if (same(next, current)) return false;
    state.recording = next;
    return true;
  }
  const durableRecordingCommandsInFlight = new Set();
  function readRecordingJournalEntry(id) {
    const entries = HUB.get('recordingCommands.entries', {}) || {}, entry = entries[String(id || '')];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? clone(entry) : null;
  }
  function writeRecordingJournalEntry(entry) {
    try {
      HUB.transaction(state => {
        state.recordingCommands = state.recordingCommands || { entries: {}, updatedAt: 0 };
        state.recordingCommands.entries = state.recordingCommands.entries || {};
        state.recordingCommands.entries[entry.id] = clone(entry);
        state.recordingCommands.updatedAt = Math.max(Number(state.recordingCommands.updatedAt || 0), Number(entry.updatedAt || 0));
      }, { changedPath: 'recordingCommands', reason: `Recording command ${entry.status}` });
      const confirmed = readRecordingJournalEntry(entry.id);
      if (!confirmed || confirmed.status !== entry.status || Number(confirmed.updatedAt) !== Number(entry.updatedAt)) {
        throw new Error('journal confirmation did not match');
      }
      return confirmed;
    } catch (error) {
      throw new Error(`Recording command journal could not be persisted: ${error.message || error}`);
    }
  }
  function pendingRecordingJournalEntries() {
    const entries = Object.values(HUB.get('recordingCommands.entries', {}) || {});
    return entries.filter(entry => entry && (entry.status === 'pending' || entry.status === 'executing') && entry.command)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  }
  function reportRecordingCommandFailure(command, error) {
    const failure = error instanceof Error ? error : new Error(String(error || 'Arena recording command failed'));
    HUB.emit('arena:command:failed', {
      id: command && command.id, action: command && command.action, executor: page,
      executorClientId: HUB.clientId, message: failure.message
    });
    toast(failure.message, 'error');
  }
  async function executeDurableRecordingCommand(command) {
    const id = String(command && command.id || '');
    if (!id || durableRecordingCommandsInFlight.has(id)) return false;
    if (page !== 'index.html' || !global.OpenLiveArenaController ||
        typeof global.OpenLiveArenaController.execute !== 'function') return false;
    if (!global.navigator || !global.navigator.locks || typeof global.navigator.locks.request !== 'function') {
      const failure = new Error('Cross-window recording command arbitration is unavailable; the command was not executed.');
      const at = Date.now(), entry = readRecordingJournalEntry(id) || {
        version: 2, id, command: clone(command), createdAt: Number(command.requestedAt || at), attempts: 0
      };
      if (entry.status !== 'completed' && entry.status !== 'failed') {
        writeRecordingJournalEntry(Object.assign({}, entry,
          { status: 'failed', failedAt: at, updatedAt: at, outcome: 'rejected', error: failure.message }));
        reportRecordingCommandFailure(command, failure);
      }
      return false;
    }
    durableRecordingCommandsInFlight.add(id);
    try {
      return await global.navigator.locks.request('openlive-recording-lifecycle-execution', { mode: 'exclusive' }, async () => {
        if (typeof HUB.synchronise === 'function') HUB.synchronise();
        let entry = readRecordingJournalEntry(id) || {
          version: 2, id, status: 'pending', command: clone(command),
          createdAt: Number(command.requestedAt || Date.now()), updatedAt: Date.now(), attempts: 0
        };
        if (entry.status === 'completed' || entry.status === 'failed') return false;
        if (nativeRecordingOwned(HUB.get('recording', {}) || {})) {
          const failedAt = Date.now();
          const failure = new Error('A native recording provider owns this lifecycle; the browser simulator did not execute the command.');
          writeRecordingJournalEntry(Object.assign({}, entry,
            { status: 'failed', failedAt, updatedAt: failedAt, outcome: 'rejected', error: failure.message }));
          reportRecordingCommandFailure(command, failure);
          return false;
        }
        const authorityClientId = recordingCommandAuthority();
        if (!authorityClientId || authorityClientId !== HUB.clientId) return false;
        const now = Date.now();
        entry = Object.assign({}, entry, {
          status: 'executing', executorClientId: HUB.clientId, executorPage: page,
          attempts: Number(entry.attempts || 0) + 1, startedAt: entry.startedAt || now,
          lastAttemptAt: now, updatedAt: now
        });
        writeRecordingJournalEntry(entry);
        try {
          const controller = global.OpenLiveArenaController;
          const payload = Object.assign({}, command.payload || {}, { __recordingCommandId: id });
          const result = await Promise.resolve(controller.execute(command.action, payload));
          if (result === false) throw new Error(`Arena did not apply ${command.action}.`);
          const completedAt = Date.now();
          writeRecordingJournalEntry(Object.assign({}, entry, {
            status: 'completed', completedAt, updatedAt: completedAt, outcome: 'applied', error: null
          }));
          HUB.emit('arena:command:completed', {
            id, action: command.action, executor: page, executorClientId: HUB.clientId
          });
          return true;
        } catch (error) {
          const failedAt = Date.now(), failure = error instanceof Error ? error : new Error(String(error));
          writeRecordingJournalEntry(Object.assign({}, entry, {
            status: 'failed', failedAt, updatedAt: failedAt, outcome: 'rejected', error: failure.message
          }));
          reportRecordingCommandFailure(command, failure);
          return false;
        }
      });
    } finally {
      durableRecordingCommandsInFlight.delete(id);
    }
  }
  function scanPendingRecordingCommands() {
    if (page !== 'index.html' || !global.OpenLiveArenaController) return;
    pendingRecordingJournalEntries().forEach(entry => executeDurableRecordingCommand(entry.command));
  }
  const linkedState = (key, fallback) => {
    const authority = offlineControllerAuthority();
    const value = authority && authority.snapshot && authority.snapshot[key];
    return value == null ? HUB.get(key, fallback) : value;
  };
  const wrapColumn = (value, count) => {
    const total = Math.max(0, Number(count) || 0);
    if (!total) return 0;
    const column = finiteNumber(value) ? Math.trunc(Number(value)) : 1;
    return ((column - 1) % total + total) % total + 1;
  };
  const relativeColumn = (delta, transport, composition) => {
    const total = Math.max(0, Number(composition && composition.columnCount) || 0);
    const current = finiteNumber(transport && transport.activeColumn)
      ? Number(transport.activeColumn) : 1;
    return total ? wrapColumn(current + delta, total) : Math.max(1, Math.trunc(current + delta));
  };
  const TOOLS = [
    ['SHOWAVE Live', 'index.html'], ['Live Workspace', 'workspace.html'], ['Panel', 'panel.html'],
    ['SHOWAVE Map', 'advanced-output.html'], ['Media Manager', 'media-manager.html'],
    ['Fixture Editor', 'fixture-editor.html'], ['Preferences', 'preferences.html'],
    ['Shortcuts', 'shortcuts.html'], ['Presets', 'presets.html'],
    ['Envelope', 'envelope-editor.html'], ['SHOWAVE Forge', 'wire.html'],
    ['Forge Settings', 'wire-settings.html'], ['SHOWAVE Encode', 'alley.html'],
    ['GSL5 Lighting Library', 'gsl5.html'],
    ['SHOWAVE Chaser', 'chaser.html'],
    ['SHOWAVE Timeline', 'timeline.html'],
    ['SHOWAVE Grid Tool', 'grid-tool.html'],
    ['Reference', 'reference.html']
  ];

  document.documentElement.dataset.openlivePage = page;
  document.body && (document.body.dataset.olPage = page);

  function toast(message, tone) {
    let node = $('#ol-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'ol-toast';
      node.className = 'ol-toast';
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.dataset.tone = tone || 'info';
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 2300);
  }

  function setTransport(values, reason) {
    const next = Object.assign(HUB.get('transport', {}), values || {});
    if (!same(next, HUB.get('transport', {}))) HUB.set('transport', next, { reason: reason || 'shared control' });
  }

  function arenaCommand(action, payload) {
    const controller = global.OpenLiveArenaController;
    const localLive = !!(global.ArenaLive && global.ArenaLive.status === 'live');
    const connection = HUB.get('connection', {});
    const sharedLive = liveConnectionFresh(connection);
    const offlineAuthority = offlineControllerAuthority();
    let executor = 'index.html', executorClientId = null;

    /* Prefer a real local Arena bridge, then the elected live bridge. A demo
       index controller must never steal commands from a connected window. */
    if (localLive) {
      executor = page; executorClientId = HUB.clientId;
    } else if (sharedLive && connection.authorityClientId) {
      executor = connection.authorityPage || 'index.html';
      executorClientId = connection.authorityClientId;
    } else if (controller && typeof controller.execute === 'function') {
      executor = page; executorClientId = HUB.clientId;
    } else if (offlineAuthority) {
      executor = offlineAuthority.page || 'index.html';
      executorClientId = offlineAuthority.clientId;
    } else if (sharedLive && connection.authorityPage) {
      executor = connection.authorityPage;
    }
    const body = Object.assign({}, payload || {}, { executor });
    if (executorClientId) body.executorClientId = executorClientId;
    HUB.command('arena', action, body);
  }

  function mountSharedControls() {
    if ($('#ol-linkdock')) return;
    const dock = document.createElement('section');
    dock.id = 'ol-linkdock';
    dock.className = 'ol-linkdock';
    dock.setAttribute('aria-label', 'SHOWAVE linked controls');
    dock.innerHTML = `
      <button class="ol-link-toggle" type="button" aria-expanded="false" title="Linked controls · Ctrl+Shift+Space">
        <i class="ol-link-led"></i><span class="ol-link-label">LINKED</span><b class="ol-link-bpm">120</b>
      </button>
      <div class="ol-link-panel" hidden>
        <header><span><i class="ol-link-led"></i> SHOWAVE LINK</span><button type="button" data-ol="close">×</button></header>
        <div class="ol-link-context">
          <strong data-ol="composition">Untitled Show</strong>
          <span data-ol="connection">OFFLINE · DEMO</span>
        </div>
        <div class="ol-link-row ol-transport" role="group" aria-label="Transport">
          <button type="button" data-ol="stop" title="Stop">■</button>
          <button type="button" data-ol="pause" title="Pause">Ⅱ</button>
          <button type="button" data-ol="play" title="Play">▶</button>
          <button type="button" data-ol="previous" title="Previous cue">‹</button>
          <button type="button" data-ol="next" title="Next cue">›</button>
          <button type="button" data-ol="eject" title="Eject all">EJECT</button>
        </div>
        <div class="ol-link-row ol-tempo" role="group" aria-label="Tempo">
          <button type="button" data-ol="bpm-minus">−</button>
          <button type="button" data-ol="bpm" title="Double-click to set BPM"><b>120</b><small>BPM</small></button>
          <button type="button" data-ol="bpm-plus">+</button>
          <button type="button" data-ol="tap">TAP</button>
          <button type="button" data-ol="resync">RESYNC</button>
          <button type="button" data-ol="bypass">BYPASS</button>
        </div>
        <div class="ol-link-nav">
          <select aria-label="Open SHOWAVE tool">${TOOLS.map(([name, file]) =>
            `<option value="${file}"${file === page ? ' selected' : ''}>${name}</option>`).join('')}</select>
          <button type="button" data-ol="navigate">OPEN</button>
          <button type="button" data-ol="popup" title="Open in linked window">↗</button>
        </div>
        <footer><span data-ol="selection">Layer 2 · Cue 1</span><button type="button" data-ol="clear-activity" title="Clear shared activity log">CLR LOG</button><span data-ol="activity">Ready</span></footer>
      </div>`;
    const settingsFooter = document.querySelector('#prefStatus .pref-help-t');
    (settingsFooter || document.body).appendChild(dock);
    if (settingsFooter) $('.ol-link-label', dock).textContent = 'Linked';

    const toggle = $('.ol-link-toggle', dock);
    const panel = $('.ol-link-panel', dock);
    const openPanel = force => {
      const open = force === undefined ? panel.hidden : !!force;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      dock.classList.toggle('open', !panel.hidden);
    };
    toggle.addEventListener('click', () => openPanel());
    $('[data-ol="close"]', dock).addEventListener('click', () => openPanel(false));
    document.addEventListener('keydown', event => {
      if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
        event.preventDefault(); openPanel();
      }
      if (event.key === 'Escape' && !panel.hidden) openPanel(false);
    });

    dock.addEventListener('click', event => {
      const button = event.target.closest('button[data-ol]');
      if (!button) return;
      const action = button.dataset.ol;
      const transport = linkedState('transport', {});
      const composition = linkedState('composition', {});
      const liveOwnsState = !!(global.ArenaLive && global.ArenaLive.status === 'live') ||
        liveConnectionFresh(HUB.get('connection', {}));
      if (action === 'play' || action === 'pause' || action === 'stop') {
        const state = action[0].toUpperCase() + action.slice(1);
        if (!liveOwnsState) setTransport({ playState: state }, 'shared transport');
        arenaCommand(`transport.${action}`);
      }
      if (action === 'previous' || action === 'next') {
        const delta = action === 'previous' ? -1 : 1;
        const column = relativeColumn(delta, transport, composition);
        if (!liveOwnsState) {
          setTransport({ activeColumn: column }, 'shared column');
          HUB.patch('composition', { selectedColumn: column }, { reason: 'shared column' });
        }
        arenaCommand(`column.${action}`, { column });
      }
      if (action === 'eject') arenaCommand('eject.all');
      if (action === 'bpm-minus' || action === 'bpm-plus') {
        const bpm = clamp(Number(transport.bpm || 120) + (action === 'bpm-minus' ? -1 : 1), 20, 500);
        if (!liveOwnsState) setTransport({ bpm }, 'shared tempo');
        arenaCommand('tempo.set', { bpm });
      }
      if (action === 'tap') arenaCommand('tempo.tap');
      if (action === 'resync') arenaCommand('tempo.resync');
      if (action === 'bypass') {
        const bypass = !transport.bypass;
        if (!liveOwnsState) setTransport({ bypass }, 'shared bypass');
        arenaCommand('composition.bypass', { bypass });
      }
      if (action === 'clear-activity') HUB.set('activity', [], { reason: 'Activity log cleared' });
      if (action === 'navigate') location.href = $('select', dock).value;
      if (action === 'popup') {
        const file = $('select', dock).value;
        global.open(file, `openlive_${file.replace(/\W/g, '_')}`, 'popup=yes,width=1280,height=800');
      }
    });
    $('[data-ol="bpm"]', dock).addEventListener('dblclick', () => {
      const value = global.prompt('Set BPM', linkedState('transport', {}).bpm || 120);
      if (value == null || value === '') return;
      const bpm = clamp(Number(value), 20, 500);
      if (!Number.isFinite(bpm)) return;
      const liveOwnsState = !!(global.ArenaLive && global.ArenaLive.status === 'live') ||
        liveConnectionFresh(HUB.get('connection', {}));
      if (!liveOwnsState) setTransport({ bpm }, 'shared tempo');
      arenaCommand('tempo.set', { bpm });
    });

    function paint(snapshot) {
      const connection = snapshot.connection || {};
      const composition = linkedState('composition', snapshot.composition || {});
      const transport = linkedState('transport', snapshot.transport || {});
      const status = String(connection.status || 'offline').toLowerCase();
      dock.dataset.status = status;
      $$('.ol-link-led', dock).forEach(led => led.dataset.status = status);
      $$('.ol-link-bpm', dock).forEach(node => { node.textContent = Math.round(Number(transport.bpm || 120)); });
      $('[data-ol="bpm"] b', dock).textContent = Number(transport.bpm || 120).toFixed(Number(transport.bpm || 120) % 1 ? 1 : 0);
      $('[data-ol="composition"]', dock).textContent = !composition.name || composition.name === 'OpenLive Composition'
        ? 'Untitled Show' : composition.name;
      $('[data-ol="connection"]', dock).textContent = status === 'live'
        ? `LIVE · ${connection.host || 'Arena'}` : status === 'connecting' ? 'CONNECTING…' : 'OFFLINE · SHARED MODEL';
      $('[data-ol="selection"]', dock).textContent = `Layer ${composition.selectedLayer || 1} · Cue ${composition.selectedColumn || transport.activeColumn || 1}`;
      ['play', 'pause', 'stop'].forEach(name => {
        const expected = name[0].toUpperCase() + name.slice(1);
        $(`[data-ol="${name}"]`, dock).classList.toggle('on', transport.playState === expected);
      });
      $('[data-ol="bypass"]', dock).classList.toggle('danger', !!transport.bypass);
      const latest = snapshot.activity && snapshot.activity[0];
      $('[data-ol="activity"]', dock).textContent = latest ? latest.label : 'Ready';
    }
    HUB.subscribe('', paint);
  }

  function compactCompositionFromArena(AL) {
    const comp = AL && AL.comp;
    if (!comp) return null;
    const value = item => AL.val(item);
    const previous = HUB.get('composition', {}) || {};
    const decks = AL.decks ? AL.decks() : [];
    const selectedDeckIndex = decks.findIndex(deck => booleanValue(value(deck.selected), false));
    const deckIndex = selectedDeckIndex >= 0 ? selectedDeckIndex : (AL.activeDeckIndex ? AL.activeDeckIndex() : 0);
    const deck = decks[deckIndex];
    const layers = AL.layers ? AL.layers() : [];
    const columns = AL.columns ? AL.columns() : [];
    const selectedLayerIndex = layers.findIndex(layer => booleanValue(value(layer.selected), false));
    const selectedColumnIndex = columns.findIndex(column => booleanValue(value(column.selected), false));
    const compactEffects = (items,track='video') => (items||[]).map((effect,index)=>{
      effect=effect||{};
      const mixer=arenaAlias(effect,['mixer'])||{};
      const rawOpacity=value(arenaAlias(mixer,['Opacity','opacity']));
      const params=Object.fromEntries(Object.entries(arenaAlias(effect,['params','parameters'])||{})
        .map(([name,parameter])=>[name,value(parameter)]));
      return {id:effect.id??null,index,name:value(effect.name)||effect.display_name||effect.name||`Effect ${index+1}`,track,
        bypassed:booleanValue(value(arenaAlias(effect,['bypassed','bypass'])),false),
        opacity:(finiteNumber(rawOpacity)?Number(rawOpacity):1)*100,
        blend:value(arenaAlias(mixer,['Blend Mode','blend_mode','blendmode','blend']))||'Alpha',params};
    });
    const compactTransform = effects => {
      const fx=(effects||[]).find(effect=>canonicalArenaKey(value(effect&&effect.name)||effect&&effect.display_name||effect&&effect.name)==='transform');
      const params=fx&&(arenaAlias(fx,['params','parameters'])||{})||{};
      if(!fx)return null;
      const number=(aliases,fallback)=>{const raw=value(arenaAlias(params,aliases));return finiteNumber(raw)?Number(raw):fallback;};
      const anchorX=number(['Anchor X','anchor_x','anchorx'],0),anchorY=number(['Anchor Y','anchor_y','anchory'],0);
      return {x:number(['Position X','position_x','positionx','x'],0),y:number(['Position Y','position_y','positiony','y'],0),
        scale:number(['Scale','scale'],100),rotation:number(['Rotation Z','rotation_z','rotation','rotationz'],0),
        anchor:anchorX,anchorX,anchorY};
    };
    const compactClip = (clip,layer,column) => {
      if(!clip)return null;const video=clip.video||{},transport=clip.transport||{},controls=transport.controls||{};
      const rawPosition=Number(value(transport.position)),min=Number(transport.position&&transport.position.min),max=Number(transport.position&&transport.position.max);
      const position=Number.isFinite(rawPosition)?clamp(Number.isFinite(min)&&Number.isFinite(max)&&max!==min?(rawPosition-min)/(max-min):rawPosition,0,1):0;
      const effects=compactEffects(video.effects,'video').concat(compactEffects(clip.audio&&clip.audio.effects,'audio'));
      const transform=compactTransform(video.effects);
      return {kind:'clip',layer,column,name:value(clip.name)||'',opacity:finiteNumber(value(video.opacity))?Number(value(video.opacity)):1,
        videoOpacity:finiteNumber(value(video.opacity))?Number(value(video.opacity)):1,
        blend:value(video.mixer&&video.mixer['Blend Mode'])||'Alpha',
        transform,effects,videoEffects:effects.filter(effect=>effect.track==='video'),
        transport:{position,duration:(Number(value(controls.duration))||0)*1000,speed:Number(value(controls.speed))||0,
          direction:value(controls.playdirection)||'>',playMode:value(controls.playmode)||'Loop',playing:connectedState(value(clip.connected))}};
    };
    let selectedClip = null;
    layers.some((layer, layerIndex) => ((layer && layer.clips) || []).some((clip, clipIndex) => {
      if (!booleanValue(value(clip.selected), false)) return false;
      selectedClip = compactClip(clip,layerIndex+1,clipIndex+1);
      return true;
    }));
    const layerFeeds = layers.map((layer, layerIndex) => {
      const clips = (layer && layer.clips) || [];
      const active = clips.findIndex((clip, clipIndex) => AL.isPlaying
        ? AL.isPlaying(layerIndex + 1, clipIndex + 1)
        : value(clip.playing) === true);
      /* A playing Clip survives a Deck switch in Arena through active_clip,
         even though it is no longer present in the visible Deck's clips list.
         Keep that proxy as the Layer feed so Advanced Output does not briefly
         report EMPTY merely because another Deck is selected. */
      const activeProxy = layer && layer.active_clip;
      const proxyConnected = value(activeProxy && activeProxy.connected);
      const activeProxyPlaying = !!activeProxy && (connectedState(proxyConnected) ||
        (proxyConnected == null && !!value(activeProxy.name)));
      const clip = active >= 0 ? clips[active] : (activeProxyPlaying ? activeProxy : null);
      const clipColumn = active >= 0 ? active + 1 : null;
      const opacity = value(layer.video && layer.video.opacity);
      const master = value(layer.master);
      const descriptor=clip?compactClip(clip,layerIndex+1,clipColumn):null;
      const layerEffects=compactEffects(layer.video&&layer.video.effects,'video').concat(compactEffects(layer.audio&&layer.audio.effects,'audio'));
      const configuredBlend=value(layer.video&&layer.video.mixer&&layer.video.mixer['Blend Mode'])||'Alpha';
      const effectiveBlend=descriptor?.blend&&descriptor.blend!=='Layer Determined'?descriptor.blend:configuredBlend;
      const arenaId=layer&&layer.id!=null?layer.id:null,legacyRouteId=`layer:${layerIndex+1}`;
      return {
        id: legacyRouteId, arenaId, routeId:arenaId==null?legacyRouteId:`layer-id:${arenaId}`,
        legacyRouteId, index: layerIndex + 1,
        name: value(layer.name) || `Layer ${layerIndex + 1}`,
        playing: active >= 0 || activeProxyPlaying,
        clip: descriptor,
        master:finiteNumber(master)?Number(master):1,
        video:{opacity:finiteNumber(opacity)?Number(opacity):1,blend:configuredBlend,
          width:Number(value(layer.video&&layer.video.width))||1920,height:Number(value(layer.video&&layer.video.height))||1080,
          autoSize:value(layer.video&&layer.video.autosize)||'Off',effects:layerEffects.filter(effect=>effect.track==='video')},
        audio:{volumeDb:Number(value(layer.audio&&layer.audio.volume))||0,pan:Number(value(layer.audio&&layer.audio.pan))||0,
          effects:layerEffects.filter(effect=>effect.track==='audio')},
        transform:compactTransform(layer.video&&layer.video.effects),effects:layerEffects,effectiveBlend,
        transition:{active:false,phase:1,duration:(Number(value(layer.transition&&layer.transition.duration))||0)*1000,
          blend:value(layer.transition&&layer.transition.blend_mode)||'Alpha'},
        opacity: (finiteNumber(opacity) ? Number(opacity) : 1) * (finiteNumber(master) ? Number(master) : 1) * (descriptor?.opacity??1),
        bypass: booleanValue(value(layer.bypassed), false), solo: booleanValue(value(layer.solo), false),
        blend: effectiveBlend,
        crossfaderGroup:value(layer.crossfadergroup)||'None'
      };
    });
    const layerIndexById = new Map(layers.map((layer, index) =>
      [layer && layer.id != null ? String(layer.id) : '', index + 1]).filter(([id]) => id));
    const groups = (AL.groups ? AL.groups() : []).map((group, index) => {
      group = group || {};
      const members = [...new Set((group.layers || []).map(member => {
        if (member && member.id != null && layerIndexById.has(String(member.id))) {
          return layerIndexById.get(String(member.id));
        }
        const at = layers.indexOf(member);
        return at >= 0 ? at + 1 : 0;
      }).filter(Boolean))];
      const rawMaster = value(group.master);
      const rawOpacity = value(group.video && group.video.opacity);
      const master=finiteNumber(rawMaster)?Number(rawMaster):1;
      const videoOpacity=finiteNumber(rawOpacity)?Number(rawOpacity):1;
      const effects=compactEffects(group.video&&group.video.effects,'video');
      const arenaId=group.id??null,legacyRouteId=`group:${index+1}`;
      return {id:legacyRouteId,arenaId,routeId:arenaId==null?legacyRouteId:`group-id:${arenaId}`,
        legacyRouteId,index:index+1,name:value(group.name)||`Group ${index+1}`,
        playing:members.some(n=>layerFeeds[n-1]&&layerFeeds[n-1].playing),layers:members,
        master,video:{opacity:videoOpacity,effects},opacity:videoOpacity*master,
        transform:compactTransform(group.video&&group.video.effects),effects,
        bypass:booleanValue(value(group.bypassed),false), solo:booleanValue(value(group.solo),false)};
    });
    const compAudio=arenaAlias(comp,['audio'])||{},compVideo=arenaAlias(comp,['video'])||{};
    const audioEffectItems=arenaAlias(compAudio,['effects'])||arenaAlias(comp,['audioeffects','audio_effects']);
    const videoEffectItems=arenaAlias(compVideo,['effects'])||arenaAlias(comp,['videoeffects','video_effects']);
    const audioEffects=Array.isArray(audioEffectItems)?compactEffects(audioEffectItems,'audio'):(previous.audio&&previous.audio.effects||[]);
    const videoEffects=Array.isArray(videoEffectItems)?compactEffects(videoEffectItems,'video'):(previous.video&&previous.video.effects||[]);
    const compositionEffects=videoEffects.concat(audioEffects);
    const compositionTransform=Array.isArray(videoEffectItems)?compactTransform(videoEffectItems):(previous.transform??null);
    const compMaster=value(arenaAlias(comp,['master','masterlevel']));
    const compSpeed=value(arenaAlias(comp,['speed','masterspeed','global_speed']));
    const compBypass=value(arenaAlias(comp,['bypassed','bypass']));
    const compVolume=value(arenaAlias(compAudio,['volume','level','gain'])??arenaAlias(comp,['volume']));
    const compPan=value(arenaAlias(compAudio,['pan','balance'])??arenaAlias(comp,['pan']));
    const compOpacity=value(arenaAlias(compVideo,['opacity','alpha'])??arenaAlias(comp,['opacity']));
    const compWidth=value(arenaAlias(compVideo,['width','texturewidth'])??arenaAlias(comp,['width']));
    const compHeight=value(arenaAlias(compVideo,['height','textureheight'])??arenaAlias(comp,['height']));

    const crossfaderNode=arenaAlias(comp,['crossfader','cross_fader'])||{};
    const crossfaderMixer=arenaAlias(crossfaderNode,['mixer'])||{};
    const rawCrossfader=value(arenaAlias(crossfaderNode,['phase','position','value']));
    const previousCrossfaderPhase=previous.crossfader&&previous.crossfader.phase;
    const crossfaderPhase=finiteNumber(rawCrossfader)?clamp((Number(rawCrossfader)+1)/2,0,1):
      clamp(Number(previousCrossfaderPhase??HUB.get('transport.crossfader',0)),0,1);
    const crossfader={...(previous.crossfader||{}),
      phase:crossfaderPhase,
      behaviour:value(arenaAlias(crossfaderNode,['behaviour','behavior']))||previous.crossfader?.behaviour||'Cut',
      curve:value(arenaAlias(crossfaderNode,['curve']))||previous.crossfader?.curve||'Linear',
      blend:value(arenaAlias(crossfaderMixer,['Blend Mode','blend_mode','blendmode','blend']))||
        value(arenaAlias(crossfaderNode,['Blend Mode','blend_mode','blendmode','blend']))||previous.crossfader?.blend||'Alpha'};

    const triggerNode=arenaAlias(comp,['trigger','triggerdefaults','cliptriggerdefaults'])||{};
    const triggerParameter=aliases=>arenaAlias(triggerNode,aliases)??arenaAlias(comp,aliases);
    const triggerValue=aliases=>value(triggerParameter(aliases));
    const trigger={...(previous.trigger||{})};
    const clipTarget=triggerValue(['cliptarget','clip_target','target']);
    const triggerStyle=triggerValue(['cliptriggerstyle','clip_trigger_style','triggerstyle','style']);
    const beatSnap=triggerValue(['clipbeatsnap','clip_beat_snap','beatsnap','beat_snap']);
    const globalTransport=triggerValue(['globaltransport','global_transport','tempocontroller.globaltransport','tempocontroller.global_transport']);
    if(clipTarget!=null)trigger.clipTarget=clipTarget;
    if(triggerStyle!=null)trigger.triggerStyle=triggerStyle;
    if(beatSnap!=null)trigger.beatSnap=beatSnap;
    if(globalTransport!=null)trigger.globalTransport=globalTransport;

    const dashboardNode=arenaAlias(comp,['dashboard','dashboards']);
    let dashboard=previous.dashboard||{dials:[]};
    if(dashboardNode&&typeof dashboardNode==='object'){
      const priorDials=Array.isArray(dashboard.dials)?dashboard.dials:[];
      const entries=Array.isArray(dashboardNode)?dashboardNode.map((item,index)=>[String(index+1),item]):Object.entries(dashboardNode);
      dashboard={dials:entries.filter(([,parameter])=>parameter&&typeof parameter==='object'&&
        (parameter.id!=null||Object.prototype.hasOwnProperty.call(parameter,'value'))).map(([key,parameter],index)=>{
          const prior=priorDials.find(item=>item&&((parameter.id!=null&&String(item.id)===String(parameter.id))||item.key===key));
          return {key,id:parameter.id??null,index:index+1,name:value(parameter.name)||parameter.display_name||parameter.displayname||key,
            value:value(parameter),min:finiteNumber(parameter.min)?Number(parameter.min):0,max:finiteNumber(parameter.max)?Number(parameter.max):1,
            mappings:clone(prior&&prior.mappings||[])};
        })};
    }

    const autopilotNode=arenaAlias(comp,['autopilot','columnautopilot','column_autopilot']);
    let autopilot=previous.autopilot;
    if(autopilotNode&&typeof autopilotNode==='object'){
      const apValue=aliases=>value(arenaAlias(autopilotNode,aliases));
      const parameters=Object.fromEntries(Object.entries(autopilotNode).filter(([,parameter])=>parameter&&typeof parameter==='object'&&
        (parameter.id!=null||Object.prototype.hasOwnProperty.call(parameter,'value'))).map(([key,parameter])=>[key,value(parameter)]));
      const enabled=apValue(['enabled','on','active']),direction=apValue(['direction']),action=apValue(['action']),random=apValue(['random','randommode']),
        duration=apValue(['duration','durationmode']),durationValue=apValue(['durationvalue','duration_value','time','value']),
        loop=apValue(['loop','loops']),masterLayer=apValue(['masterlayer','master_layer','layer']);
      autopilot={...(previous.autopilot||{}),parameters};
      if(enabled!=null)autopilot.enabled=booleanValue(enabled,false);
      if(direction!=null)autopilot.direction=direction;
      if(action!=null)autopilot.action=action;
      if(random!=null)autopilot.random=random;
      if(duration!=null)autopilot.duration=duration;
      if(durationValue!=null)autopilot.durationValue=durationValue;
      if(loop!=null)autopilot.loop=loop;
      if(masterLayer!=null)autopilot.masterLayer=masterLayer;
    }

    const tempoNode=arenaAlias(comp,['tempocontroller','tempo_controller'])||{};
    const rawTempo=value(arenaAlias(tempoNode,['tempo','bpm'])),rawPlayState=value(arenaAlias(tempoNode,['play_state','playstate']));
    const rawDirection=value(arenaAlias(tempoNode,['playdirection','play_direction','direction'])??arenaAlias(comp,['playdirection','direction']));
    const tempo={...(previous.tempo||{})};
    if(finiteNumber(rawTempo))tempo.bpm=Number(rawTempo);
    if(rawPlayState!=null)tempo.playState=rawPlayState;
    if(rawDirection!=null)tempo.direction=rawDirection;

    const previousPreview=HUB.get('composition.preview',null);
    const preview=previousPreview&&previousPreview.kind&&previousPreview.kind!=='clip'
      ? previousPreview : (selectedClip||previousPreview);
    const result={
      name: value(comp.name) || 'Untitled',
      width: finiteNumber(compWidth)?Number(compWidth):(previous.width||1920),
      height: finiteNumber(compHeight)?Number(compHeight):(previous.height||1080),
      master:finiteNumber(compMaster)?Number(compMaster):(finiteNumber(previous.master)?Number(previous.master):1),
      speed:finiteNumber(compSpeed)?Number(compSpeed):(finiteNumber(previous.speed)?Number(previous.speed):1),
      bypass:compBypass==null?!!previous.bypass:booleanValue(compBypass,false),
      audio:{...(previous.audio||{}),volumeDb:finiteNumber(compVolume)?Number(compVolume):(previous.audio?.volumeDb??0),
        pan:finiteNumber(compPan)?Number(compPan):(previous.audio?.pan??0),effects:audioEffects},
      video:{...(previous.video||{}),opacity:finiteNumber(compOpacity)?Number(compOpacity):(previous.video?.opacity??1),
        width:finiteNumber(compWidth)?Number(compWidth):(previous.width||1920),height:finiteNumber(compHeight)?Number(compHeight):(previous.height||1080),
        effects:videoEffects},
      transform:compositionTransform,effects:compositionEffects,crossfader,trigger,tempo,dashboard,
      layerCount: layers.length, columnCount: columns.length,
      activeDeck: deckIndex,
      activeDeckName: deck ? (value(deck.name) || `Deck ${deckIndex + 1}`) : `Deck ${deckIndex + 1}`,
      selectedLayer: selectedLayerIndex >= 0 ? selectedLayerIndex + 1 : HUB.get('composition.selectedLayer', 1),
      selectedColumn: selectedColumnIndex >= 0 ? selectedColumnIndex + 1 : HUB.get('composition.selectedColumn', 1),
      selectedClip: selectedClip || HUB.get('composition.selectedClip', null),
      layers: layerFeeds,
      groups,
      preview
    };
    if(autopilot)result.autopilot=autopilot;
    return result;
  }

  function compactTransportFromArena(AL) {
    const comp = AL && AL.comp; if (!comp) return null;
    const value = item => AL.val(item);
    const columns = AL.columns ? AL.columns() : [];
    const connected = columns.findIndex(column => connectedState(value(column.connected)));
    const tempoController=arenaAlias(comp,['tempocontroller','tempo_controller'])||{};
    const crossfader=arenaAlias(comp,['crossfader','cross_fader'])||{};
    const tempo = value(arenaAlias(tempoController,['tempo','bpm']));
    const playState = value(arenaAlias(tempoController,['play_state','playstate']));
    const master = value(arenaAlias(comp,['master','masterlevel'])), bypass = value(arenaAlias(comp,['bypassed','bypass']));
    const speed=value(arenaAlias(comp,['speed','masterspeed','global_speed']));
    const direction=value(arenaAlias(tempoController,['playdirection','play_direction','direction'])??arenaAlias(comp,['playdirection','direction']));
    const phase = value(arenaAlias(crossfader,['phase','position','value']));
    const sharedCrossfader = HUB.get('transport.crossfader', 0);
    const fallbackColumn = columns.length
      ? wrapColumn(HUB.get('transport.activeColumn', 1), columns.length)
      : Math.max(1, Number(HUB.get('transport.activeColumn', 1)) || 1);
    return {
      bpm: finiteNumber(tempo) ? Number(tempo) : HUB.get('transport.bpm', 120),
      playState: playState || HUB.get('transport.playState', 'Play'),
      activeColumn: connected >= 0 ? connected + 1 : fallbackColumn,
      master: finiteNumber(master) ? Number(master) : HUB.get('transport.master', 1),
      speed: finiteNumber(speed) ? Number(speed) : HUB.get('transport.speed', 1),
      direction: direction == null ? HUB.get('transport.direction', '>') : direction,
      bypass: bypass == null ? HUB.get('transport.bypass', false) : booleanValue(bypass, false),
      /* Shared contract is a normalised A→B position (0..1). Arena's native
         phase is -1..1; converting here keeps every window on one unit. */
      crossfader: finiteNumber(phase) ? clamp((Number(phase) + 1) / 2, 0, 1)
        : (finiteNumber(sharedCrossfader) ? clamp(Number(sharedCrossfader), 0, 1) : 0)
    };
  }

  function attachArenaBridge() {
    const AL = global.ArenaLive;
    if (!AL || AL.__openliveHubAttached) return;
    AL.__openliveHubAttached = true;

    function paintConnection(status) {
      const current = HUB.get('connection', {});
      const nextStatus = String(status || AL.status || 'offline').toLowerCase();
      const foreignAuthority = current.authorityClientId && current.authorityClientId !== HUB.clientId;

      /* An offline or connecting window cannot demote a fresh live bridge.
         Once that bridge stops heartbeating, any surviving bridge may replace
         it, and a live standby claims authority before publishing state. */
      if (nextStatus !== 'live' && String(current.status).toLowerCase() === 'live' &&
          liveConnectionFresh(current) && (!current.authorityClientId || foreignAuthority)) return;
      if (nextStatus === 'live' && liveConnectionFresh(current) && foreignAuthority) return;

      const at = Date.now();
      const next = Object.assign({}, current, {
        status: nextStatus,
        host: AL.host ? AL.host() : current.host,
        product: 'Resolume Arena',
        lastSeenAt: nextStatus === 'live' ? at : 0,
        authorityClientId: nextStatus === 'live' ? HUB.clientId : null,
        authorityPage: nextStatus === 'live' ? page : null,
        error: nextStatus === 'live' ? '' : String(AL.error || ''),
        updatedAt: at
      });
      if (!same(next, current)) HUB.set('connection', next, { reason: 'Arena connection authority' });
    }

    let compositionParamIds = new Set(), transportParamIds = new Set(), bridgeSubscribedParamIds = new Set();
    const addParamId = (set, parameter) => {
      if (parameter && parameter.id != null) set.add(String(parameter.id));
    };
    const addParamTree = (set, node, seen) => {
      if (!node || typeof node !== 'object') return;
      seen=seen||new WeakSet();if(seen.has(node))return;seen.add(node);
      if (node.id != null && (node.valuetype || Object.prototype.hasOwnProperty.call(node,'value'))) {
        addParamId(set,node);return;
      }
      if(Array.isArray(node))node.forEach(item=>addParamTree(set,item,seen));
      else Object.values(node).forEach(item=>addParamTree(set,item,seen));
    };
    function rebuildCompactParamIds() {
      const comp = AL.comp || {}, composition = new Set(), transport = new Set(), bridge = new Set();
      const compositionRoot=parameter=>{addParamId(composition,parameter);addParamId(bridge,parameter);};
      const transportRoot=parameter=>{addParamId(transport,parameter);addParamId(bridge,parameter);};
      const sharedRoot=parameter=>{compositionRoot(parameter);transportRoot(parameter);};
      const compositionTree=node=>{addParamTree(composition,node);addParamTree(bridge,node);};
      const transportTree=node=>{addParamTree(transport,node);addParamTree(bridge,node);};
      compositionRoot(arenaAlias(comp,['name']));
      compositionRoot(arenaAlias(comp,['selected']));
      [arenaAlias(comp,['master','masterlevel']),arenaAlias(comp,['bypassed','bypass']),arenaAlias(comp,['speed','masterspeed','global_speed'])]
        .forEach(sharedRoot);
      const compositionAudio=arenaAlias(comp,['audio']);
      const compositionVideo=arenaAlias(comp,['video']);
      const dashboard=arenaAlias(comp,['dashboard','dashboards']);
      const autopilot=arenaAlias(comp,['autopilot','columnautopilot','column_autopilot']);
      const triggerDefaults=arenaAlias(comp,['trigger','triggerdefaults','cliptriggerdefaults']);
      const tempoController=arenaAlias(comp,['tempocontroller','tempo_controller']);
      const crossfader=arenaAlias(comp,['crossfader','cross_fader']);
      [compositionAudio,compositionVideo,dashboard,autopilot,triggerDefaults].forEach(compositionTree);
      [arenaAlias(comp,['cliptarget','clip_target']),arenaAlias(comp,['cliptriggerstyle','clip_trigger_style']),
        arenaAlias(comp,['clipbeatsnap','clip_beat_snap']),arenaAlias(comp,['globaltransport','global_transport'])]
        .forEach(compositionRoot);
      if(tempoController){transportTree(tempoController);compositionTree(tempoController);}
      if(crossfader){
        const phase=arenaAlias(crossfader,['phase','position','value']);
        sharedRoot(phase);
        Object.entries(crossfader).forEach(([key,parameter])=>{
          if(canonicalArenaKey(key)!=='phase')compositionTree(parameter);
        });
      }
      (comp.decks || []).forEach(deck => { addParamId(composition, deck.name); addParamId(composition, deck.selected); });
      (comp.columns || []).forEach(column => {
        addParamId(composition, column.selected);
        addParamId(transport, column.connected);
      });
      (comp.layers || []).forEach(layer => {
        [layer.name, layer.master, layer.bypassed, layer.solo, layer.selected, layer.crossfadergroup]
          .forEach(parameter => addParamId(composition, parameter));
        if (layer.video) {
          addParamId(composition, layer.video.opacity);
          addParamId(composition, layer.video.mixer && layer.video.mixer['Blend Mode']);
          [layer.video.width,layer.video.height,layer.video.autosize].forEach(parameter=>addParamId(composition,parameter));
          (layer.video.effects||[]).forEach(effect=>{addParamId(composition,effect.bypassed);
            Object.values(effect.params||{}).forEach(parameter=>addParamId(composition,parameter));
            Object.values(effect.mixer||{}).forEach(parameter=>addParamId(composition,parameter));});
        }
        if(layer.audio){[layer.audio.volume,layer.audio.pan].forEach(parameter=>addParamId(composition,parameter));
          (layer.audio.effects||[]).forEach(effect=>{addParamId(composition,effect.bypassed);
            Object.values(effect.params||{}).forEach(parameter=>addParamId(composition,parameter));
            Object.values(effect.mixer||{}).forEach(parameter=>addParamId(composition,parameter));});}
        if(layer.transition){addParamId(composition,layer.transition.duration);addParamId(composition,layer.transition.blend_mode);}
        const addClipParameters = clip => {
          if (!clip) return;
          [clip.name, clip.connected, clip.selected,clip.video&&clip.video.opacity,
            clip.video&&clip.video.mixer&&clip.video.mixer['Blend Mode'],clip.transport&&clip.transport.position]
            .forEach(parameter => addParamId(composition, parameter));
          const controls=clip.transport&&clip.transport.controls||{};Object.values(controls).forEach(parameter=>addParamId(composition,parameter));
          (clip.video&&clip.video.effects||[]).forEach(effect=>{addParamId(composition,effect.bypassed);
            Object.values(effect.params||{}).forEach(parameter=>addParamId(composition,parameter));
            Object.values(effect.mixer||{}).forEach(parameter=>addParamId(composition,parameter));});
        };
        (layer.clips || []).forEach(addClipParameters);
        /* active_clip is a stable proxy for playback from another Deck. Its
           parameters must trigger compact-state updates as playback changes. */
        addClipParameters(layer.active_clip);
      });
      (comp.layergroups || []).forEach(group => {
        [group.name, group.master, group.bypassed, group.solo]
          .forEach(parameter => addParamId(composition, parameter));
        addParamId(composition, group.video && group.video.opacity);
      });
      compositionParamIds = composition; transportParamIds = transport;
      bridgeSubscribedParamIds=bridge;
      if(typeof AL.subscribe==='function')bridge.forEach(id=>{
        const numeric=Number(id),parameter=typeof AL.paramById==='function'?
          (AL.paramById(id)||(Number.isFinite(numeric)?AL.paramById(numeric):null)):null;
        AL.subscribe(parameter&&parameter.id!=null?parameter.id:id);
      });
    }

    function paintArenaState(includeComposition, includeTransport) {
      if (AL.status !== 'live') return;
      const authority = HUB.get('connection', {});
      if (authority.authorityClientId && authority.authorityClientId !== HUB.clientId) return;
      const currentComposition = HUB.get('composition', {});
      const currentTransport = HUB.get('transport', {});
      const compactComposition = includeComposition ? compactCompositionFromArena(AL) : null;
      const compactTransport = includeTransport ? compactTransportFromArena(AL) : null;
      const nextComposition = compactComposition
        ? Object.assign({}, currentComposition, compactComposition) : currentComposition;
      const nextTransport = compactTransport
        ? Object.assign({}, currentTransport, compactTransport) : currentTransport;
      const compositionChanged = !!compactComposition && !same(nextComposition, currentComposition);
      const transportChanged = !!compactTransport && !same(nextTransport, currentTransport);
      if (!compositionChanged && !transportChanged) return;
      if (compositionChanged && transportChanged) {
        HUB.transaction(next => {
          next.composition = nextComposition; next.transport = nextTransport;
        }, { changedPath: '*', reason: 'Arena live state' });
      } else if (compositionChanged) {
        HUB.set('composition', nextComposition, { reason: 'Arena live composition' });
      } else {
        HUB.set('transport', nextTransport, { reason: 'Arena live transport' });
      }
    }

    let paintQueued = false, pendingComposition = false, pendingTransport = false;
    function scheduleArenaPaint(includeComposition, includeTransport) {
      pendingComposition = pendingComposition || !!includeComposition;
      pendingTransport = pendingTransport || !!includeTransport;
      if (paintQueued) return;
      paintQueued = true;
      queueMicrotask(() => {
        const composition = pendingComposition, transport = pendingTransport;
        paintQueued = pendingComposition = pendingTransport = false;
        paintArenaState(composition, transport);
      });
    }

    function maintainAuthority() {
      const current = HUB.get('connection', {});
      if (AL.status === 'live') {
        if (current.authorityClientId === HUB.clientId || !liveConnectionFresh(current)) {
          const wasAuthority = current.authorityClientId === HUB.clientId;
          paintConnection('live');
          if (!wasAuthority && HUB.get('connection.authorityClientId') === HUB.clientId) {
            rebuildCompactParamIds(); scheduleArenaPaint(true, true);
          }
        }
      } else if (String(current.status).toLowerCase() === 'live' && !liveConnectionFresh(current)) {
        paintConnection(AL.status);
      }
    }

    AL.on('status', status => {
      paintConnection(status);
      if (status === 'live') { rebuildCompactParamIds(); scheduleArenaPaint(true, true); }
    });
    AL.on('comp', () => { rebuildCompactParamIds(); scheduleArenaPaint(true, true); });
    AL.on('param', detail => {
      const id = detail && detail.id != null ? String(detail.id) : '';
      const compositionChanged = compositionParamIds.has(id);
      const transportChanged = transportParamIds.has(id);
      if (compositionChanged || transportChanged) scheduleArenaPaint(compositionChanged, transportChanged);
    });
    HUB.on('state', () => {
      if (AL.status === 'live' && String(HUB.get('connection.status', '')).toLowerCase() !== 'live') {
        paintConnection('live');
        if (HUB.get('connection.authorityClientId') === HUB.clientId) {
          rebuildCompactParamIds(); scheduleArenaPaint(true, true);
        }
      }
    });
    HUB.on('arena:state:request', () => {
      maintainAuthority();
      if (AL.status === 'live') scheduleArenaPaint(true, true);
    });
    setInterval(maintainAuthority, 5000);
    paintConnection(AL.status);
    rebuildCompactParamIds();
    scheduleArenaPaint(true, true);
  }

  async function selectLiveDeckFallback(AL, rawDeck) {
    const decks=AL.decks?AL.decks():[],numeric=Number(rawDeck),index=Math.trunc(numeric);
    if(rawDeck==null||rawDeck===''||typeof rawDeck==='boolean'||
       !Number.isFinite(numeric)||index!==numeric||index<0||index>=decks.length)
      throw new Error('A valid zero-based Bank index is required');
    const deck=decks[index];
    if(!deck||deck.closed)throw new Error(`Bank ${index+1} is closed or unavailable`);
    const identity=deck.id!=null?`id:${deck.id}`:
      deck.selected&&deck.selected.id!=null?`selected:${deck.selected.id}`:`index:${index}`;
    /* The REST acknowledgement says the command was accepted; the refresh and
       identity check say which Deck Arena actually made authoritative. */
    const accepted=await AL.cmd.selectDeck(deck);
    if(accepted===false)throw new Error('The live host rejected Bank selection');
    await AL.refresh();
    const current=AL.decks?AL.decks():[];
    const active=current.findIndex(candidate=>candidate&&AL.val(candidate.selected)===true);
    const selected=current[active];
    const selectedIdentity=selected&&selected.id!=null?`id:${selected.id}`:
      selected&&selected.selected&&selected.selected.id!=null?`selected:${selected.selected.id}`:`index:${active}`;
    if(active<0||selectedIdentity!==identity)
      throw new Error(`The live host did not confirm Bank ${index+1} as selected`);
    return true;
  }

  function executeArenaCommand(command) {
    if (!command || !command.action) return;
    const payload = Object.assign({}, command.payload || {});
    const executor = payload.executor;
    const executorClientId = payload.executorClientId;
    const recordingCommand = /^recording-(?:configure|start|stop)$/.test(command.action);
    if (payload.handledLocally && command.requestedBy === page) return;
    if (recordingCommand) {
      /* Recording uses its own durable journal and per-command Web Lock. The
         lock stays held through controller execution and the terminal journal
         write; a surviving Arena tab scans unfinished entries after reload. */
      executeDurableRecordingCommand(command).catch(error => reportRecordingCommandFailure(command, error));
      return;
    }
    if (executorClientId && executorClientId !== HUB.clientId) return;
    if (executor && executor !== page) return;
    if (!executor) {
      const connection = HUB.get('connection', {});
      if (liveConnectionFresh(connection) && connection.authorityClientId) {
        if (connection.authorityClientId !== HUB.clientId) return;
      } else if (page !== 'index.html') return;
    }
    if (!executorClientId && executor) {
      const connection = HUB.get('connection', {});
      if (liveConnectionFresh(connection) && connection.authorityPage === executor &&
          connection.authorityClientId && connection.authorityClientId !== HUB.clientId) return;
    }

    if (command.action === 'column.previous' || command.action === 'column.next') {
      const delta = command.action.endsWith('previous') ? -1 : 1;
      const composition = linkedState('composition', {}), transport = linkedState('transport', {});
      if (!finiteNumber(payload.column)) payload.column = relativeColumn(delta, transport, composition);
      else if (Number(composition.columnCount) > 0) payload.column = wrapColumn(payload.column, composition.columnCount);
    }
    if (command.action === 'composition.bypass' && payload.bypass == null) {
      payload.bypass = !booleanValue(linkedState('transport', {}).bypass, false);
    }

    const completed = () => HUB.emit('arena:command:completed', {
      id: command.id, action: command.action, executor: page, executorClientId: HUB.clientId
    });
    const failed = error => {
      const failure = error instanceof Error ? error : new Error(String(error || 'Arena command failed'));
      HUB.emit('arena:command:failed', {
        id: command.id, action: command.action, executor: page,
        executorClientId: HUB.clientId, message: failure.message
      });
      toast(failure.message, 'error');
    };

    if (command.action === 'connection.connect') {
      const host = String(payload.host || '').trim();
      if (!host) { failed(new Error('Arena host is required')); return; }
      HUB.patch('connection', { host, status: 'connecting', error: '', lastSeenAt: 0,
        authorityClientId: null, authorityPage: null, updatedAt: Date.now() }, { reason: 'Arena endpoint preference' });
      if (global.ArenaLive && typeof global.ArenaLive.connect === 'function') {
        try { global.ArenaLive.connect(host); completed(); } catch (error) { failed(error); }
      } else {
        completed();
      }
      return;
    }
    if (command.action === 'connection.disconnect') {
      if (global.ArenaLive && typeof global.ArenaLive.disconnect === 'function') global.ArenaLive.disconnect(true);
      HUB.patch('connection', { status: 'offline', error: '', lastSeenAt: 0,
        authorityClientId: null, authorityPage: null, updatedAt: Date.now() }, { reason: 'Arena endpoint disabled' });
      completed();
      return;
    }

    const controller = global.OpenLiveArenaController;
    if (controller && typeof controller.execute === 'function') {
      let result;
      try { result = controller.execute(command.action, payload); }
      catch (error) { failed(error); return; }
      Promise.resolve(result).then(value => {
        if (value === false) throw new Error(`Arena did not apply ${command.action}.`);
        completed();
      }).catch(failed);
      return;
    }
    const AL = global.ArenaLive;
    if (!AL || AL.status !== 'live') { failed(new Error('No live Arena executor is available')); return; }
    const liveParameter=(aliases)=>arenaAlias(AL.comp,aliases);
    const writeLiveParameter=(aliases,next,label)=>{
      const parameter=liveParameter(aliases);
      if(!parameter||parameter.id==null)throw new Error(`The live host exposed no writable ${label||'Show parameter'}`);
      return AL.setParam(parameter.id,next);
    };
    const indexedEntity=(kind,rawIndex,rawId)=>{
      const entities=kind==='Layer'?(AL.layers?AL.layers():[]):(AL.groups?AL.groups():[]);
      let index=Math.trunc(Number(rawIndex));
      if(rawId!=null&&rawId!==''){
        const at=entities.findIndex(entity=>entity&&entity.id!=null&&String(entity.id)===String(rawId));
        if(at<0)throw new Error(`${kind} source ${rawId} is no longer available`);index=at+1;
      }
      if(!Number.isFinite(index)||index<1)throw new Error(`A valid ${kind} index is required`);
      const entity=entities[index-1]||(kind==='Layer'&&AL.layer&&AL.layer(index));
      if(!entity)throw new Error(`${kind} ${index} is not available`);
      return {entity,index};
    };
    const writeEntityParameter=(kind,rawIndex,rawId,aliases,next,label)=>{
      const {entity}=indexedEntity(kind,rawIndex,rawId);
      const parameter=arenaAlias(entity,aliases);
      if(!parameter||parameter.id==null)throw new Error(`Arena exposed no writable ${label||kind+' parameter'}`);
      return AL.setParam(parameter.id,next);
    };
    const commandUnit=(raw,label)=>{
      if(!finiteNumber(raw))throw new Error(`A numeric ${label} value is required`);
      const value=Number(raw),normalised=Math.abs(value)>1?value/100:value;
      return clamp(normalised,0,1);
    };
    let result;
    try {
      if (command.action === 'transport.play' || command.action === 'transport.pause' || command.action === 'transport.stop') {
        const state = command.action.split('.')[1];
        result=writeLiveParameter(['tempocontroller.play_state','tempo_controller.play_state','tempocontroller.playstate'],
          state[0].toUpperCase()+state.slice(1),'play-state parameter');
      } else if (command.action === 'tempo.set') {
        if(!finiteNumber(payload.bpm))throw new Error('A numeric tempo is required');
        result=writeLiveParameter(['tempocontroller.tempo','tempo_controller.tempo','tempocontroller.bpm'],
          Number(payload.bpm),'tempo');
      } else if (command.action === 'tempo.tap') result = AL.cmd.tempoTap();
      else if (command.action === 'tempo.resync') result = AL.cmd.tempoResync();
      else if (command.action === 'column.previous' || command.action === 'column.next') {
        const columns = AL.columns(), count = columns.length;
        if (!count) throw new Error('The Show has no Cues');
        const connected = columns.findIndex(column => connectedState(AL.val(column.connected)));
        const delta = command.action.endsWith('previous') ? -1 : 1;
        const target = connected >= 0
          ? wrapColumn(connected + 1 + delta, count)
          : wrapColumn(payload.column || relativeColumn(delta, linkedState('transport', {}), { columnCount: count }), count);
        result = AL.cmd.triggerColumn(target);
      } else if (command.action === 'column.trigger') {
        const count = AL.columns().length;
        const target = count ? wrapColumn(payload.column, count) : 0;
        if (!target) throw new Error('The Show has no target Cue');
        result = AL.cmd.triggerColumn(target);
      } else if (command.action === 'clip.trigger') result = AL.cmd.triggerClip(Number(payload.layer), Number(payload.column));
      else if (command.action === 'clip.select') result = AL.cmd.selectClip(Number(payload.layer), Number(payload.column));
      else if (command.action === 'layer.select') {
        const {index}=indexedEntity('Layer',payload.layer,payload.layerId);result=AL.cmd.selectLayer(index);
      }
      else if(command.action==='layer.master')result=writeEntityParameter('Layer',payload.layer,payload.layerId,
        ['master','masterlevel'],commandUnit(payload.value,'Layer master'),'Layer master parameter');
      else if(command.action==='layer.opacity')result=writeEntityParameter('Layer',payload.layer,payload.layerId,
        ['video.opacity','opacity'],commandUnit(payload.value,'Layer opacity'),'Layer video opacity parameter');
      else if(command.action==='layer.bypass')result=writeEntityParameter('Layer',payload.layer,payload.layerId,
        ['bypassed','bypass'],booleanValue(payload.value,false),'Layer bypass parameter');
      else if(command.action==='layer.solo')result=writeEntityParameter('Layer',payload.layer,payload.layerId,
        ['solo'],booleanValue(payload.value,false),'Layer solo parameter');
      else if(command.action==='group.select'){
        const {index}=indexedEntity('Group',payload.group,payload.groupId);result=AL.cmd.selectGroup(index);
      }
      else if(command.action==='group.master')result=writeEntityParameter('Group',payload.group,payload.groupId,
        ['master','masterlevel'],commandUnit(payload.value,'Group master'),'Group master parameter');
      else if(command.action==='group.opacity')result=writeEntityParameter('Group',payload.group,payload.groupId,
        ['video.opacity','opacity'],commandUnit(payload.value,'Group opacity'),'Group video opacity parameter');
      else if(command.action==='group.bypass')result=writeEntityParameter('Group',payload.group,payload.groupId,
        ['bypassed','bypass'],booleanValue(payload.value,false),'Group bypass parameter');
      else if(command.action==='group.solo')result=writeEntityParameter('Group',payload.group,payload.groupId,
        ['solo'],booleanValue(payload.value,false),'Group solo parameter');
      else if (command.action === 'deck.select') result=selectLiveDeckFallback(AL,payload.deck);
      else if (command.action === 'eject.all') result = AL.cmd.ejectAll();
      else if (command.action === 'composition.bypass') {
        result=writeLiveParameter(['bypassed','bypass'],booleanValue(payload.bypass,false),'Show bypass parameter');
      } else if(command.action==='master.set'){
        if(!finiteNumber(payload.value))throw new Error('A numeric Show master value is required');
        const next=Math.abs(Number(payload.value))>1?Number(payload.value)/100:Number(payload.value);
        result=writeLiveParameter(['master','masterlevel'],clamp(next,0,1),'Show master parameter');
      } else if(command.action==='composition.speed'){
        if(!finiteNumber(payload.value))throw new Error('A numeric Show speed is required');
        result=writeLiveParameter(['speed','masterspeed','global_speed'],clamp(Number(payload.value),0,10),'Show speed parameter');
      } else if(command.action==='composition.direction'){
        result=writeLiveParameter(['tempocontroller.playdirection','tempo_controller.play_direction','playdirection','direction'],
          payload.value,'Show direction parameter');
      } else if(command.action==='composition.opacity'){
        if(!finiteNumber(payload.value))throw new Error('A numeric Show opacity is required');
        const next=Math.abs(Number(payload.value))>1?Number(payload.value)/100:Number(payload.value);
        result=writeLiveParameter(['video.opacity','opacity'],clamp(next,0,1),'Show video opacity parameter');
      } else if(command.action==='composition.volume'){
        if(!finiteNumber(payload.value))throw new Error('A numeric Show volume is required');
        result=writeLiveParameter(['audio.volume','volume','audio.level'],Number(payload.value),'Show audio volume parameter');
      } else if(command.action==='composition.pan'){
        if(!finiteNumber(payload.value))throw new Error('A numeric Show pan is required');
        result=writeLiveParameter(['audio.pan','pan','audio.balance'],clamp(Number(payload.value),-1,1),'Show audio pan parameter');
      } else if(command.action==='composition.property'){
        const key=String(payload.key||'');
        const aliases={name:['name'],master:['master','masterlevel'],speed:['speed','masterspeed','global_speed'],
          bypass:['bypassed','bypass'],audioDb:['audio.volume','volume','audio.level'],pan:['audio.pan','pan','audio.balance'],
          'video.opacity':['video.opacity','opacity'],'crossfader.blend':['crossfader.mixer.Blend Mode','cross_fader.mixer.blend_mode'],
          'crossfader.behaviour':['crossfader.behaviour','crossfader.behavior','cross_fader.behaviour'],
          'crossfader.curve':['crossfader.curve','cross_fader.curve'],'crossfader.phase':['crossfader.phase','cross_fader.phase'],
          'trigger.beatSnap':['clipbeatsnap','clip_beat_snap','trigger.beatsnap'],
          'trigger.clipTarget':['cliptarget','clip_target','trigger.target'],
          'trigger.triggerStyle':['cliptriggerstyle','clip_trigger_style','trigger.triggerstyle'],
          'trigger.globalTransport':['globaltransport','global_transport','tempocontroller.globaltransport'],
          'tempo.bpm':['tempocontroller.tempo','tempo_controller.tempo'],'tempo.playState':['tempocontroller.play_state','tempo_controller.play_state']};
        const paths=aliases[key]||(key.startsWith('dashboard.')||key.startsWith('autopilot.')?[key]:null);
        if(!paths)throw new Error(`Unsupported Show property: ${key}`);
        let next=payload.value;
        if(key==='master'||key==='video.opacity'){
          if(!finiteNumber(next))throw new Error(`A numeric ${key} value is required`);
          next=Math.abs(Number(next))>1?Number(next)/100:Number(next);next=clamp(next,0,1);
        }else if(key==='crossfader.phase'){
          if(!finiteNumber(next))throw new Error('A numeric crossfader phase is required');
          next=Number(next)<0?clamp(Number(next),-1,1):clamp(Number(next),0,1)*2-1;
        }else if(key==='bypass')next=booleanValue(next,false);
        result=writeLiveParameter(paths,next,`${key} parameter`);
      } else if (command.action === 'crossfader.set') {
        if(!finiteNumber(payload.value))throw new Error('A numeric crossfader phase is required');
        result=writeLiveParameter(['crossfader.phase','cross_fader.phase'],
          clamp(Number(payload.value),0,1)*2-1,'crossfader phase');
      } else {
        throw new Error(`Unsupported Arena command: ${command.action}`);
      }
      if (result === false) throw new Error(`Arena could not dispatch ${command.action}`);
    } catch (error) { failed(error); return; }
    Promise.resolve(result).then(value => {
      if (value === false) throw new Error(`Arena could not apply ${command.action}`);
      completed();
    }).catch(failed);
  }

  function controllerSnapshotLoop() {
    let previous = '';
    let lastLeaseAt = 0;
    let lastRecordingLeaseAt = 0;
    let localPriorityUntil = 0;
    const update = force => {
      const controller = global.OpenLiveArenaController;
      if (!controller || typeof controller.snapshot !== 'function') return;
      const now = Date.now(), forceClaim = force === true || now < localPriorityUntil;
      /* While Arena is live, attachArenaBridge() is authoritative. Letting the
         demo controller overwrite it caused selection, deck, groups and
         crossfader units to oscillate every 650 ms. */
      if ((global.ArenaLive && global.ArenaLive.status === 'live') ||
          String(HUB.get('connection.status', '')).toLowerCase() === 'live') {
        previous = '';
        const recording = HUB.get('recording', {}) || {}, connection = HUB.get('connection', {}) || {};
        const busyForeignOwner = (recording.active || recording.armed) && recording.ownerClientId &&
          recording.ownerClientId !== HUB.clientId &&
          Number(recording.ownerLeaseAt || 0) > 0 &&
          now - Number(recording.ownerLeaseAt) <= RECORDER_AUTHORITY_TTL * 2;
        const preferredLiveRecorder = liveConnectionFresh(connection) && connection.authorityPage === 'index.html'
          ? connection.authorityClientId : null;
        const foreignRecorderFresh = recording.authorityClientId && recording.authorityClientId !== HUB.clientId &&
          now - Number(recording.authorityLeaseAt || 0) <= RECORDER_AUTHORITY_TTL;
        if (!busyForeignOwner && (!preferredLiveRecorder || preferredLiveRecorder === HUB.clientId) &&
            (!foreignRecorderFresh || forceClaim) &&
            (forceClaim || recording.authorityClientId !== HUB.clientId ||
              now - lastRecordingLeaseAt >= RECORDER_AUTHORITY_TTL / 2)) {
          lastRecordingLeaseAt = now;
          HUB.transaction(next => {
            applyBrowserRecordingAuthority(next, HUB.clientId, page, now);
          }, { changedPath: 'recording', reason: 'Arena live recording authority' });
        }
        return;
      }
      const currentAuthority = HUB.get('arenaController', {}) || {};
      const foreignFresh = currentAuthority.clientId && currentAuthority.clientId !== HUB.clientId &&
        now - Number(currentAuthority.leaseAt || 0) <= CONTROLLER_AUTHORITY_TTL;
      if (foreignFresh && !forceClaim) {
        document.documentElement.dataset.olControllerRole = 'standby';
        return;
      }
      const raw = controller.snapshot();
      if (!raw) return;
      const snapshot = Object.assign({}, raw, {
        transport: Object.assign({}, raw.transport || {})
      });
      /* Beat is purely local animation state and has no consumer in the shared
         model. Omitting it prevents a full persisted snapshot every beat. */
      delete snapshot.transport.beat;
      const serial = JSON.stringify(snapshot);
      if (serial === previous && now - lastLeaseAt < CONTROLLER_AUTHORITY_TTL / 2) return;
      previous = serial;
      lastLeaseAt = now;
      document.documentElement.dataset.olControllerRole = 'authority';
      document.documentElement.dataset.olControllerColumn = String(snapshot.composition?.selectedColumn || 0);
      HUB.transaction(next => {
        next.arenaController = { clientId: HUB.clientId, page, leaseAt: now, snapshot: clone(snapshot) };
        if (snapshot.connection) next.connection = Object.assign(next.connection || {}, snapshot.connection);
        if (snapshot.composition) next.composition = Object.assign(next.composition || {}, snapshot.composition);
        if (snapshot.transport) next.transport = Object.assign(next.transport || {}, snapshot.transport);
        applyBrowserRecordingAuthority(next, HUB.clientId, page, now);
      }, { changedPath: '*', reason: 'Arena controller' });
    };
    update();
    setInterval(update, 650);
    HUB.on('arena:state:request', () => update(false));
    document.addEventListener('pointerdown', () => {
      localPriorityUntil = Date.now() + CONTROLLER_AUTHORITY_TTL * 2;
      update(true);
    }, { capture: true });
  }

  function humanFieldValue(row) {
    const input = row && row.querySelector('input,select,textarea');
    if (!input) return null;
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number' || input.type === 'range') return Number(input.value);
    return input.value;
  }

  function setHumanFieldValue(input, value) {
    if (!input || value === undefined) return;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
    if (input.type === 'range') {
      const output = input.parentElement && input.parentElement.querySelector('output');
      if (output) output.value = input.value;
    }
  }

  function initWireSettings() {
    if (page !== 'wire-settings.html') return;
    const root = $('#settings');
    const saved = HUB.get('wire.settings', {});
    const arenaAudio = HUB.get('preferences.audio', {}) || {};
    const controls = $$('input,select,textarea', root);
    const keys = new Map();
    const occurrences = {};
    const seeded = {};
    const arenaSeedFor = key => {
      const map = {
        'audio.output.audio-output-device.1': arenaAudio.output && arenaAudio.output.deviceLabel,
        'audio.output.sample-rate.1': arenaAudio.output && arenaAudio.output.sampleRate,
        'audio.output.buffer-size.1': arenaAudio.output && arenaAudio.output.bufferSize,
        'audio.input.audio-input-device.1': arenaAudio.input && arenaAudio.input.deviceLabel
      };
      return map[key];
    };
    controls.forEach(control => {
      const row = control.closest('.formrow, tr') || control.parentElement;
      const tab = control.closest('[data-tab]');
      const section = control.closest('.formgroup');
      const label = (row && row.querySelector('label,td') || {}).textContent || control.id || control.name || control.type;
      const base = [tab && tab.dataset.tab, section && $('h3', section) && $('h3', section).textContent, label]
        .filter(Boolean).map(slug).join('.');
      occurrences[base] = (occurrences[base] || 0) + 1;
      const key = `${base}.${occurrences[base]}`;
      keys.set(control, key);
      const seed = arenaSeedFor(key);
      const initial = saved[key] === undefined && seed !== undefined ? seed : saved[key];
      setHumanFieldValue(control, initial);
      if (saved[key] === undefined && seed !== undefined) seeded[key] = String(seed);
    });
    if (Object.keys(seeded).length) {
      HUB.set('wire.settings', Object.assign({}, saved, seeded), { reason: 'Seed Wire audio settings from Arena' });
    }
    const wireAudio = $('[data-tab="audio"]', root);
    if (wireAudio && !wireAudio.querySelector('[data-arena-audio-seed]')) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.dataset.arenaAudioSeed = 'true';
      hint.textContent = 'Missing SHOWAVE Forge audio values are seeded once from Arena Audio Preferences. Later changes here remain Forge-specific.';
      wireAudio.appendChild(hint);
    }
    const wireMidiBody = $('[data-wire-midi-devices]', root);
    let wireMidiSignature = '';
    function renderWireMidi(value) {
      if (!wireMidiBody) return;
      const midi = value || {}, devices = Array.isArray(midi.devices) ? midi.devices : [];
      const signature = JSON.stringify(devices.map(device => [device.id, device.name, device.connected,
        device.hasInput, device.hasOutput, device.inputEnabled, device.clockInputEnabled, device.outputEnabled,
        device.lastError, device.portState]));
      if (signature === wireMidiSignature) return;
      wireMidiSignature = signature;
      wireMidiBody.innerHTML = devices.map(device => `<tr data-wire-midi-device="${escapeHtml(device.id || '')}">
        <td><b>${escapeHtml(device.name || 'MIDI Device')}</b><div class="hint">${escapeHtml(device.connected ? 'Connected' : 'Saved · unavailable')}</div></td>
        <td><input type="checkbox" data-wire-midi-route="input" ${device.inputEnabled ? 'checked' : ''} ${device.hasInput === false ? 'disabled' : ''}></td>
        <td><input type="checkbox" data-wire-midi-route="clock" ${device.clockInputEnabled ? 'checked' : ''} ${device.hasInput === false ? 'disabled' : ''}></td>
        <td><input type="checkbox" data-wire-midi-route="output" ${device.outputEnabled ? 'checked' : ''} ${device.hasOutput === false ? 'disabled' : ''}></td>
      </tr>`).join('') || '<tr><td colspan="4">No saved MIDI devices. Enable MIDI from Arena Preferences first.</td></tr>';
      const status = $('#wireMidiStatus');
      if (status) status.textContent = `${devices.filter(device => device.inputEnabled).length} shortcut inputs · ${devices.filter(device => device.clockInputEnabled).length ? 'external Clock In' : 'manual clock'} · ${devices.filter(device => device.outputEnabled).length} feedback outputs. Shared with Arena, Shortcuts, and the MIDI monitor.`;
    }
    renderWireMidi(HUB.get('preferences.midi', {}));
    HUB.subscribe('preferences.midi', renderWireMidi, { immediate: false });
    if (wireMidiBody) wireMidiBody.addEventListener('change', event => {
      const control = event.target.closest('[data-wire-midi-route]'), row = event.target.closest('[data-wire-midi-device]');
      if (!control || !row) return;
      HUB.transaction(snapshot => {
        const midi = snapshot.preferences && snapshot.preferences.midi;
        const devices = midi && Array.isArray(midi.devices) ? midi.devices : [];
        const device = devices.find(item => item && item.id === row.dataset.wireMidiDevice); if (!device) return;
        if (control.dataset.wireMidiRoute === 'input') device.inputEnabled = control.checked;
        if (control.dataset.wireMidiRoute === 'output') device.outputEnabled = control.checked;
        if (control.dataset.wireMidiRoute === 'clock') {
          devices.forEach(item => { item.clockInputEnabled = item === device && control.checked; });
          midi.clock = Object.assign({}, midi.clock || {}, {
            sourceDeviceId: control.checked ? device.id : null,
            state: control.checked ? 'Waiting for Start' : 'Manual', running: false
          });
        }
        midi.updatedAt = Date.now();
      }, { changedPath: 'preferences.midi', reason: `Wire MIDI ${control.dataset.wireMidiRoute}` });
      HUB.emit('openlive:midi-preferences-changed', { source: 'wire-settings', deviceId: row.dataset.wireMidiDevice, route: control.dataset.wireMidiRoute, enabled: control.checked });
    });
    let settingsTimer = 0;
    function saveSettings() {
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(() => {
        const next = {};
        keys.forEach((key, control) => { next[key] = control.type === 'checkbox' ? control.checked : control.value; });
        HUB.set('wire.settings', next, { reason: 'Wire settings changed' });
        HUB.emit('wire:settings:changed', { keys: Object.keys(next), page });
      }, 90);
    }
    root.addEventListener('input', saveSettings);
    root.addEventListener('change', saveSettings);

    const compileRows = $$('#compile .formrow');
    const compileValue = label => {
      const row = compileRows.find(item => (($('label', item) || {}).textContent || '').trim() === label);
      return humanFieldValue(row);
    };
    function activePatch() {
      const wire = HUB.get('wire', {});
      return (wire.patches || []).find(item => item.id === wire.activePatchId) || (wire.patches || [])[0] || {
        id: 'patch:untitled', name: 'Untitled', revision: 1, nodes: [], connections: [], inputs: [], resources: [], presets: []
      };
    }
    function compiledArtifact() {
      const patch = activePatch();
      const category = String(compileValue('Category') || patch.category || 'Effect').toLowerCase();
      const locked = !!compileValue('Lock patch (hide nodes)');
      let output = String(compileValue('Output file') || `${patch.name || 'Untitled'}.wired`).trim();
      output = output.replace(/\.(c?wired)$/i, '') + (locked ? '.cwired' : '.wired');
      const revision = patch.revision || patch.updatedAt || Date.now();
      return {
        id: `wire:${slug(patch.id || patch.name)}:${String(revision)}:${locked ? 'locked' : 'editable'}`,
        patchId: patch.id, revision, name: patch.name || output.replace(/\.(c?wired)$/i, ''),
        category, description: patch.description || '', output,
        destination: String(compileValue('Destination') || ''),
        editable: !locked, extension: locked ? '.cwired' : '.wired',
        resolution: patch.resolution || 'Host Determined', bitDepth: patch.bitDepth || '8 bit',
        inputs: clone(patch.inputs || patch.dashboard || []), presets: clone(patch.presets || []),
        resources: clone(patch.resources || []), credits: patch.credits || '', license: patch.license || '',
        patchSnapshot: clone(patch), installedAt: Date.now(), nativeBinary: false
      };
    }
    function renderCompiledRegistry() {
      let section = $('#wireCompiledRegistry');
      if (!section) {
        section = document.createElement('div'); section.id = 'wireCompiledRegistry'; section.className = 'formgroup';
        section.innerHTML = '<h3>Installed SHOWAVE Forge Snapshots</h3><div data-wire-artifacts></div>';
        $('#compile .compile-scroll').appendChild(section);
      }
      const artifacts = HUB.get('wire.compiled', []);
      $('[data-wire-artifacts]', section).innerHTML = artifacts.length ? artifacts.map(item => `
        <div class="formrow" data-artifact-id="${escapeHtml(item.id)}">
          <label>${escapeHtml(item.name)}</label><span>${escapeHtml(item.category)} · rev ${escapeHtml(item.revision)}</span>
          <button class="tb-btn" type="button" data-remove-artifact="${escapeHtml(item.id)}">Remove</button>
        </div>`).join('') : '<div class="hint">No compiled snapshots installed in the SHOWAVE Forge catalog.</div>';
    }
    $('#compile').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-artifact]'); if (!button) return;
      const artifact = HUB.get('wire.compiled', []).find(item => item.id === button.dataset.removeArtifact);
      HUB.remove('wire.compiled', button.dataset.removeArtifact);
      HUB.set('presets.items', HUB.get('presets.items', []).filter(item => item.artifactId !== button.dataset.removeArtifact),
        { reason: 'Wire artifact removed' });
      HUB.emit('wire:artifact:removed', { id: button.dataset.removeArtifact, name: artifact && artifact.name },
        { activity: true, label: `Compiled registry removed · ${artifact && artifact.name || 'artifact'}` });
      renderCompiledRegistry();
    });
    $('#wireCompileFinal') && $('#wireCompileFinal').addEventListener('click', () => {
      const artifact = compiledArtifact();
      HUB.upsert('wire.compiled', artifact);
      (artifact.presets || []).forEach(preset => HUB.upsert('presets.items', {
        id: `wire-preset:${artifact.id}:${slug(preset.name || 'preset')}`,
        name: preset.name || 'Preset', kind: artifact.category === 'source' ? 'Sources' : 'Video Effects',
        group: artifact.name, origin: 'wire', editable: true, artifactId: artifact.id,
        values: clone(preset.values || preset)
      }));
      HUB.emit('wire:artifact:installed', artifact, { activity: true, label: `Compiled registry · ${artifact.name}` });
      toast(`${artifact.name} registered for ${artifact.category}. Native .wired output needs the Wire compiler helper.`);
      renderCompiledRegistry();
    });
    $('#wireCompileCancel') && $('#wireCompileCancel').addEventListener('click', () => { location.hash = ''; $('[data-pane="settings"]') && $('[data-pane="settings"]').click(); });
    $('#wireConsolidate') && $('#wireConsolidate').addEventListener('click', () => {
      const patch = activePatch();
      const resources = (patch.resources || []).map(item => Object.assign({}, item, { consolidated: true }));
      HUB.upsert('wire.patches', Object.assign({}, patch, { resources, consolidatedAt: Date.now(), dirty: true }));
      HUB.emit('wire:resources:consolidated', { patchId: patch.id, count: resources.length }, { activity: true, label: `SHOWAVE Forge resources · ${resources.length} staged` });
      toast('Resource paths consolidated in the shared patch model.');
    });
    $('#wireCopyPatch') && $('#wireCopyPatch').addEventListener('click', async () => {
      const text = JSON.stringify(activePatch(), null, 2);
      try { await navigator.clipboard.writeText(text); toast('Patch JSON copied.'); }
      catch (_) { global.prompt('Copy patch JSON', text); }
    });
    $('#compileBtn') && $('#compileBtn').addEventListener('click', () => {
      setTimeout(() => {
        if ($('#isfStatus') && /Compiled OK/i.test($('#isfStatus').textContent)) {
          const record = {
            id: `isf:${slug($('#isfFile').value)}`, name: $('#isfFile').value,
            source: $('#code').value, compiledAt: Date.now(), status: 'validated-header'
          };
          HUB.upsert('wire.isf', record);
          HUB.emit('wire:isf:compiled', record, { activity: true, label: `ISF validated · ${record.name}` });
        }
      }, 0);
    });
    renderCompiledRegistry();
    HUB.subscribe('wire.compiled', renderCompiledRegistry, { immediate: false });
  }

  function initEnvelope() {
    if (page !== 'envelope-editor.html') return;
    const canvas = $('#env');
    if (!canvas) return;
    let applying = false;
    function capture() {
      try {
        return {
          name: typeof name !== 'undefined' ? name : 'Envelope',
          target: HUB.get('envelope.target'), interpolation: $('#interp').value,
          loop: $('#loop').value, phase: $('#phase').value,
          duration: Number(($$('.prow input[type="number"]')[0] || {}).value || 4),
          durationUnit: (($$('.prow input[type="number"]')[0] || {}).nextElementSibling || {}).value || 'Beats',
          keyframes: (typeof pts !== 'undefined' ? pts : []).map(point => ({ t: +point[0], v: +point[1] })),
          previewing: typeof playing !== 'undefined' ? !!playing : false, updatedAt: Date.now()
        };
      } catch (_) { return null; }
    }
    let saveTimer = 0;
    function saveEnvelope() {
      if (applying) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const envelope = capture();
        if (!envelope) return;
        HUB.set('envelope', envelope, { reason: 'Envelope edited' });
        HUB.emit('envelope:changed', { target: envelope.target, keyframes: envelope.keyframes.length });
      }, 70);
    }
    function applyEnvelope(envelope) {
      if (!envelope || !Array.isArray(envelope.keyframes) || envelope.keyframes.length < 2) return;
      try {
        applying = true;
        pts = envelope.keyframes.map(point => [Number(point.t), Number(point.v)]);
        if (envelope.name) name = envelope.name;
        if (envelope.interpolation) $('#interp').value = envelope.interpolation;
        if (envelope.loop) $('#loop').value = envelope.loop;
        if (envelope.phase) $('#phase').value = envelope.phase;
        const duration = $$('.prow input[type="number"]')[0]; if (duration && envelope.duration != null) duration.value = envelope.duration;
        $('#envTitle').textContent = `${envelope.name || 'Shared Envelope'}`;
        if (typeof draw === 'function') draw();
      } catch (_) { /* page implementation may use module scope */ }
      finally { applying = false; }
    }
    HUB.ready().then(() => applyEnvelope(HUB.get('envelope')));
    ['mouseup', 'dblclick'].forEach(type => canvas.addEventListener(type, saveEnvelope));
    document.addEventListener('change', saveEnvelope);
    document.addEventListener('keyup', event => { if (/Arrow|Delete/.test(event.key)) saveEnvelope(); });
    ['addKf', 'delKf', 'resetKf', 'playBtn'].forEach(id => $(`#${id}`) && $(`#${id}`).addEventListener('click', saveEnvelope));

    const saveButton = document.createElement('button');
    saveButton.type = 'button'; saveButton.className = 'tb-btn'; saveButton.textContent = 'Save Preset…';
    saveButton.addEventListener('click', () => {
      const envelope = capture(); if (!envelope) return;
      const presetName = global.prompt('Envelope preset name', envelope.name || 'My Envelope');
      if (!presetName) return;
      const item = {
        id: `preset:envelope:${slug(presetName)}:${Date.now().toString(36)}`, name: presetName,
        kind: 'Envelopes', group: 'SHOWAVE User', origin: 'envelope-editor', editable: true,
        values: { envelope: Object.assign({}, envelope, { name: presetName }) }, updatedAt: Date.now()
      };
      HUB.upsert('presets.items', item);
      HUB.emit('preset:saved', item, { activity: true, label: `Envelope preset · ${presetName}` });
      toast(`Saved envelope preset “${presetName}”.`);
    });
    $('#playBtn').parentElement.appendChild(saveButton);
    HUB.on('preset:apply', item => {
      if (item && item.values && item.values.envelope) applyEnvelope(item.values.envelope);
    });
    setInterval(() => {
      try {
        if (typeof playing !== 'undefined' && playing && typeof valueAt === 'function') {
          const phase = ((performance.now() - t0) / Math.max(100, Number(HUB.get('envelope.duration', 4)) * 500)) % 1;
          HUB.emit('envelope:value', { target: HUB.get('envelope.target'), phase, value: valueAt(phase) });
        }
      } catch (_) { /* noop */ }
    }, 100);
  }

  function initShortcutEditor() {
    if (page !== 'shortcuts.html') return;
    if (typeof DATA === 'undefined' || typeof render !== 'function') return;
    const mapSelect = $('#inputMap');
    let active = HUB.get('shortcuts.activeMap', 'Keyboard');
    let loading = false;

    const readData = () => Object.fromEntries(Object.keys(DATA).map(key => [key, clone(DATA[key])]));
    function writeData(data) {
      loading = true;
      Object.keys(DATA).forEach(key => {
        DATA[key].splice(0, DATA[key].length, ...clone((data && data[key]) || []));
      });
      render(); loading = false;
    }
    function maps() { return HUB.get('shortcuts.maps', {}); }
    function paintMapSelect() {
      const names = Object.keys(maps());
      mapSelect.innerHTML = '';
      names.forEach(name => mapSelect.appendChild(new Option(name, name)));
      mapSelect.value = names.includes(active) ? active : names[0] || '';
    }
    function saveMap(reason) {
      if (loading) return;
      const all = maps();
      all[active] = { id: slug(active), name: active, data: readData(), updatedAt: Date.now() };
      HUB.transaction(next => {
        next.shortcuts.maps = all; next.shortcuts.activeMap = active; next.shortcuts.updatedAt = Date.now();
      }, { changedPath: 'shortcuts', reason: reason || 'Shortcut map changed' });
      HUB.emit('shortcuts:changed', { activeMap: active, counts: Object.fromEntries(Object.keys(DATA).map(k => [k, DATA[k].length])) });
      paintMapSelect();
    }
    function loadMap(nameToLoad) {
      const record = maps()[nameToLoad];
      if (!record) return false;
      active = nameToLoad; writeData(record.data); paintMapSelect();
      HUB.patch('shortcuts', { activeMap: active }, { reason: 'Shortcut map opened' });
      return true;
    }
    if (!Object.keys(maps()).length) saveMap('Seed shortcut map');
    else if (!loadMap(active)) loadMap(Object.keys(maps())[0]);
    paintMapSelect();

    /* A second Shortcuts window is a legitimate editor, not a stale copy.
       Reload externally committed maps atomically so this tab cannot later
       overwrite a newer learn/edit session with its suspended DATA arrays. */
    HUB.subscribe('shortcuts', (shared, meta) => {
      if (!meta || !meta.external || loading || !shared) return;
      const all = shared.maps && typeof shared.maps === 'object' ? shared.maps : {};
      const names = Object.keys(all);
      const requested = String(shared.activeMap || active || '');
      const nextActive = names.includes(requested) ? requested
        : names.includes(active) ? active : names[0] || '';
      if (!nextActive || !all[nextActive]) { paintMapSelect(); return; }
      active = nextActive;
      writeData(all[nextActive].data);
      paintMapSelect();
    }, { immediate: false });

    mapSelect.addEventListener('change', () => loadMap(mapSelect.value));
    $('#mapNew').addEventListener('click', () => {
      const value = global.prompt('New shortcut map name', 'Untitled Map'); if (!value) return;
      active = value.trim(); Object.keys(DATA).forEach(key => DATA[key].splice(0)); render(); saveMap('New shortcut map');
    });
    $('#mapOpen').addEventListener('click', () => {
      const names = Object.keys(maps());
      const value = global.prompt(`Open shortcut map:\n${names.join('\n')}`, active); if (value) loadMap(value.trim());
    });
    $('#mapSaveAs').addEventListener('click', () => {
      const value = global.prompt('Save shortcut map as', `${active} Copy`); if (!value) return;
      active = value.trim(); saveMap('Shortcut map saved as');
    });
    $('#mapClearOne').addEventListener('click', () => {
      const row = $('#rows tr.selected'); if (!row) return;
      const index = [...row.parentElement.children].indexOf(row); DATA[current].splice(index, 1); render(); saveMap('Shortcut cleared');
    });
    $('#mapClearAll').addEventListener('click', () => {
      if (!global.confirm(`Clear all ${DATA[current].length} shortcuts in this section?`)) return;
      DATA[current].splice(0); render(); saveMap('Shortcuts cleared');
    });
    $('#mapDuplicate').addEventListener('click', () => {
      const row = $('#rows tr.selected'); if (!row) return;
      const index = [...row.parentElement.children].indexOf(row);
      if (DATA[current][index]) DATA[current].splice(index + 1, 0, clone(DATA[current][index]));
      render(); saveMap('Shortcut duplicated');
    });
    document.addEventListener('click', event => {
      if (event.target.closest('#rows button') || event.target.closest('#learnStop')) setTimeout(() => saveMap('Shortcut edited'), 0);
    });
    document.addEventListener('openlive:shortcut-edited', () => saveMap('MIDI shortcut edited'));
    addEventListener('keydown', () => {
      if ($('#learnBar').classList.contains('on')) setTimeout(() => saveMap('Shortcut learned'), 0);
    });

    /* MIDI learn is fed by the preferences window's single Web MIDI owner.
       Keep the stored assignment numeric so changing the Middle C naming
       preference never changes which physical note fires the shortcut. */
    const midiMessageType = message => {
      const type = String(message && message.type || '').toLowerCase().replace(/[\s_-]+/g, '');
      if (type === 'controller' || type === 'controlchange') return 'cc';
      return type;
    };
    const midiMiddleC = () => {
      const value = HUB.get('preferences.midi.middleC', 'C4');
      return ['Legacy', 'C3', 'C4'].includes(value) ? value : 'C4';
    };
    const midiNoteName = (number, convention) => {
      const note = clamp(Math.round(Number(number) || 0), 0, 127);
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      if (convention === 'Legacy') return `${names[note % 12]}${Math.floor(note / 12) - 1}`;
      const middleOctave = convention === 'C3' ? 3 : 4;
      return `${names[note % 12]}${middleOctave + Math.floor((note - 60) / 12)}`;
    };
    const storedMidiNote = assignment => {
      const match = String(assignment || '').trim().match(/^Note\s+(\d{1,3})$/i);
      if (!match) return null;
      const number = Number(match[1]);
      return number >= 0 && number <= 127 ? number : null;
    };
    function decorateMidiNoteRows() {
      if (!String(current || '').startsWith('midi')) return;
      const convention = midiMiddleC();
      $$('#rows tr').forEach((row, index) => {
        const binding = DATA[current] && DATA[current][index];
        if (!binding || String(binding[1]).toLowerCase() !== 'note') return;
        const note = storedMidiNote(binding[3]);
        const cell = row.children[3];
        if (note == null || !cell) return;
        cell.textContent = `${midiNoteName(note, convention)} · Note ${note}`;
        cell.title = `MIDI note ${note}; displayed with Middle C = ${convention}`;
      });
    }
    function midiLearnRow(message) {
      const type = midiMessageType(message);
      const channel = String(clamp(Math.round(Number(message.channel) || 1), 1, 16));
      if (type === 'noteon') {
        const rawNumber = Number(message.number);
        if (!Number.isFinite(rawNumber)) return null;
        const number = clamp(Math.round(rawNumber), 0, 127);
        return ['Note', channel, `Note ${number}`, 'N/A'];
      }
      if (type === 'cc') {
        const rawNumber = Number(message.number);
        if (!Number.isFinite(rawNumber)) return null;
        const number = clamp(Math.round(rawNumber), 0, 127);
        return ['Controller', channel, `CC ${number}`, '0 – 127'];
      }
      if (type === 'pitchbend') return ['PitchBend', channel, 'Pitch Bend', '−8192 – 8191'];
      return null;
    }
    function describeMidiLearn(row) {
      if (row[0] === 'Note') {
        const note = storedMidiNote(row[2]);
        return `${midiNoteName(note, midiMiddleC())} (Note ${note}) · channel ${row[1]}`;
      }
      return `${row[2]} · channel ${row[1]}`;
    }
    const midiBindingMetadata = binding => {
      const candidate = Array.isArray(binding) ? binding[binding.length - 1] : null;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
    };
    function learnedMidiMetadata(message, previousBinding) {
      const previous = midiBindingMetadata(previousBinding);
      const deviceId = String(message && message.deviceId || '').trim();
      const deviceName = String(message && message.deviceName || '').trim();
      const sameDevice = deviceId && deviceId === String(previous.deviceId || '').trim();
      const hasIncomingIdentity = !!(deviceId || deviceName);
      return {
        deviceId: deviceId || (!hasIncomingIdentity ? String(previous.deviceId || '') : ''),
        deviceName: deviceName || (sameDevice || !hasIncomingIdentity ? String(previous.deviceName || '') : ''),
        triggerStyle: String(previous.triggerStyle || 'Normal'),
        outputFeedback: previous.outputFeedback !== false
      };
    }
    HUB.on('openlive:midi-message', message => {
      const learnBar = $('#learnBar');
      if (!learnBar || !learnBar.classList.contains('on') || !['midiApp', 'midiComp'].includes(current)) return;
      if (!message || message.direction !== 'in') return;
      const type = midiMessageType(message);
      if (!['noteon', 'cc', 'pitchbend'].includes(type)) return;
      if (type === 'noteon' && Number(message.velocity ?? message.value) === 0) return;
      const target = String($('#iTarget') && $('#iTarget').textContent || '').trim();
      if (!target || target === 'N/A' || /^(?:—|–|-)+$/.test(target)) {
        $('#learnMsg').textContent = 'Select a target before moving a MIDI control.';
        toast('Select a shortcut target first.', 'warning');
        return;
      }
      const learned = midiLearnRow(message);
      if (!learned) return;
      const existing = DATA[current].findIndex(binding => String(binding && binding[0] || '') === target);
      const previousBinding = existing >= 0 ? DATA[current][existing] : null;
      const metadata = learnedMidiMetadata(message, previousBinding);
      const row = [target, ...learned, metadata];
      const index = existing >= 0 ? existing : DATA[current].length;
      if (existing >= 0) DATA[current].splice(existing, 1, row);
      else DATA[current].push(row);
      render();
      decorateMidiNoteRows();
      const selected = $$('#rows tr')[index];
      if (selected) selected.classList.add('selected');
      $('#iTarget').textContent = target;
      $('#iAssign').textContent = describeMidiLearn(learned);
      if ($('#iMidiDevice')) {
        $('#iMidiDevice').textContent = metadata.deviceName || 'Any enabled device';
        $('#iMidiDevice').title = metadata.deviceId ? `MIDI device ID: ${metadata.deviceId}` : 'Matches any device enabled for MIDI input';
      }
      if ($('#iMidiTriggerStyle')) $('#iMidiTriggerStyle').value = metadata.triggerStyle;
      if ($('#iMidiOutputFeedback')) $('#iMidiOutputFeedback').checked = metadata.outputFeedback;
      $('#learnMsg').textContent = `Learned ${describeMidiLearn(learned)} for ${target}.`;
      learnBar.classList.remove('on');
      saveMap('MIDI shortcut learned');
      HUB.emit('shortcut:learned', {
        map: active, section: current, target, type: learned[0], channel: Number(learned[1]),
        assignment: learned[2], deviceId: metadata.deviceId, deviceName: metadata.deviceName,
        triggerStyle: metadata.triggerStyle, outputFeedback: metadata.outputFeedback
      }, { activity: true, label: `MIDI learned · ${target}` });
      toast(`${existing >= 0 ? 'Updated' : 'Learned'} MIDI shortcut for ${target}.`);
    });
    HUB.subscribe('preferences.midi', () => {
      decorateMidiNoteRows();
      const selected = $('#rows tr.selected');
      if (!selected || !String(current || '').startsWith('midi')) return;
      const index = [...selected.parentElement.children].indexOf(selected);
      const binding = DATA[current] && DATA[current][index];
      const note = binding && storedMidiNote(binding[3]);
      if (note != null) $('#iAssign').textContent = `${midiNoteName(note, midiMiddleC())} (Note ${note}) · channel ${binding[2]}`;
    }, { immediate: true });
    document.addEventListener('click', event => {
      if (event.target.closest('#mapTabs, #rows, #mapOpen, #mapClearOne, #mapClearAll, #mapDuplicate')) {
        setTimeout(decorateMidiNoteRows, 0);
      }
    });
    mapSelect.addEventListener('change', () => setTimeout(decorateMidiNoteRows, 0));
  }

  function currentUserPreset() {
    const id = $('#plist .titem.selected[data-preset-id]') && $('#plist .titem.selected[data-preset-id]').dataset.presetId;
    return id ? HUB.get('presets.items', []).find(item => item.id === id) : null;
  }

  function initPresets() {
    if (page !== 'presets.html') return;
    if (typeof buildList !== 'function' || typeof detail !== 'function') return;
    function kindMatches(item) {
      return String(item.kind || '').toLowerCase() === String(kind || '').toLowerCase();
    }
    function renderUserPresets() {
      const list = $('#plist'); if (!list) return;
      list.querySelectorAll('[data-openlive-user]').forEach(node => node.remove());
      const items = HUB.get('presets.items', []).filter(kindMatches)
        .filter(item => !$('#pSearch').value || `${item.group || ''} ${item.name}`.toLowerCase().includes($('#pSearch').value.toLowerCase()));
      if (!items.length) return;
      const heading = document.createElement('div'); heading.className = 'tgroup'; heading.dataset.openliveUser = '1';
      heading.textContent = `SHOWAVE User (${items.length})`; list.appendChild(heading);
      items.forEach(item => {
        const node = document.createElement('div'); node.className = 'titem'; node.dataset.openliveUser = '1';
        node.dataset.presetId = item.id; node.textContent = item.name; list.appendChild(node);
        node.addEventListener('click', () => {
          $$('#plist .titem').forEach(other => other.classList.toggle('selected', other === node));
          try { sel = null; } catch (_) {}
          renderPresetDetail(item);
        });
      });
    }
    function renderPresetDetail(item) {
      const values = item.values || {};
      const summary = Object.entries(values).slice(0, 16).map(([key, value]) =>
        `<div class="formrow"><label>${key.replace(/([A-Z])/g, ' $1')}</label><span>${typeof value === 'object' ? 'Linked snapshot' : String(value)}</span></div>`).join('');
      $('#detail').innerHTML = `<h2>${item.group ? `${item.group}: ` : ''}${item.name}</h2>
        <div class="formgroup"><h3>Shared Preset</h3>
          <div class="formrow"><label>Origin</label><span>${item.origin || 'SHOWAVE'}</span></div>
          <div class="formrow"><label>Editable</label><span>${item.editable === false ? 'No' : 'Yes'}</span></div>
          ${summary || '<div class="hint">No stored parameters.</div>'}
        </div>
        <div class="formrow"><button class="tb-btn on" data-preset-action="apply" type="button">Apply To Selection</button>
          <button class="tb-btn" data-preset-action="update" type="button">Update From Selection</button></div>`;
    }
    function selectionSnapshot() {
      const values = {};
      $$('#detail .formrow').forEach(row => {
        const label = ($('label', row) || {}).textContent;
        const control = $('input,select,textarea', row);
        if (label && control) values[slug(label)] = control.type === 'checkbox' ? control.checked : control.value;
      });
      if (!Object.keys(values).length) {
        values.composition = linkedState('composition'); values.transport = linkedState('transport');
      }
      return values;
    }
    function savePreset(copyOf) {
      const defaultName = copyOf ? `${copyOf.name} Copy` : (typeof sel !== 'undefined' && sel ? `${sel.i} Copy` : 'New Preset');
      const presetName = global.prompt('Preset name', defaultName); if (!presetName) return null;
      const item = {
        id: `preset:${slug(kind)}:${slug(presetName)}:${Date.now().toString(36)}`,
        name: presetName.trim(), kind, group: copyOf && copyOf.group || (typeof sel !== 'undefined' && sel ? sel.g : 'SHOWAVE User'),
        origin: copyOf && copyOf.origin || 'presets', editable: true,
        values: clone(copyOf && copyOf.values || selectionSnapshot()), updatedAt: Date.now()
      };
      HUB.upsert('presets.items', item); HUB.emit('preset:saved', item, { activity: true, label: `Preset saved · ${item.name}` });
      renderUserPresets(); return item;
    }
    function applyPreset(item) {
      if (!item) {
        item = { id: `factory:${slug(kind)}:${slug(sel && sel.i)}`, name: sel && sel.i, kind, group: sel && sel.g, origin: 'factory', editable: false, values: selectionSnapshot() };
      }
      HUB.patch('presets', { selectedId: item.id, lastApplied: clone(item), updatedAt: Date.now() }, { reason: 'Preset applied' });
      if (item.values && item.values.envelope) HUB.set('envelope', item.values.envelope, { reason: 'Envelope preset applied' });
      if (kind === 'Color Palettes') HUB.patch('composition', { palette: clone(item.values && item.values.colors || item.values) }, { reason: 'Palette applied' });
      HUB.emit('preset:apply', item, { activity: true, label: `Preset applied · ${item.name || 'Preset'}` });
      toast(`Applied “${item.name || 'Preset'}” to the shared selection.`);
    }
    $('#presetSave').addEventListener('click', () => savePreset(currentUserPreset()));
    $('#presetDuplicate').addEventListener('click', () => savePreset(currentUserPreset()));
    $('#presetRename').addEventListener('click', () => {
      const item = currentUserPreset();
      if (!item) { savePreset(null); return; }
      const value = global.prompt('Rename preset', item.name); if (!value) return;
      HUB.upsert('presets.items', Object.assign({}, item, { name: value.trim(), updatedAt: Date.now() })); renderUserPresets();
    });
    $('#presetDelete').addEventListener('click', () => {
      const item = currentUserPreset(); if (!item) { toast('Factory presets are read-only; duplicate one first.'); return; }
      if (global.confirm(`Delete “${item.name}”?`)) { HUB.remove('presets.items', item.id); $('#detail').innerHTML = '<div class="hint">Select a preset.</div>'; renderUserPresets(); }
    });
    document.addEventListener('click', event => {
      const action = event.target.closest('[data-preset-action]');
      if (action) {
        const item = currentUserPreset();
        if (action.dataset.presetAction === 'apply') applyPreset(item);
        else if (item) HUB.upsert('presets.items', Object.assign({}, item, { values: selectionSnapshot(), updatedAt: Date.now() }));
      } else if (event.target.closest('#detail button') && /Apply To Selection/.test(event.target.textContent)) applyPreset(currentUserPreset());
      if (event.target.closest('#kindTabs .ptab') || event.target === $('#pSearch')) setTimeout(renderUserPresets, 0);
      if (event.target.closest('#plist .titem:not([data-preset-id])')) setTimeout(() => {}, 0);
    });
    $('#pSearch').addEventListener('input', () => setTimeout(renderUserPresets, 0));
    HUB.subscribe('presets.items', renderUserPresets, { immediate: true });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function initReferenceLinkView() {
    if (page !== 'reference.html') return;
    const referenceNav = $('#rnav');
    if (!referenceNav) return;
    let active = false;
    function ensureLink() {
      const nav = $('#rnav'); if (!nav || $('[data-openlive-system]', nav)) return;
      const section = document.createElement('div'); section.className = 'navsec'; section.dataset.openliveSystem = '1'; section.textContent = 'SHOWAVE';
      const item = document.createElement('div'); item.className = `navitem${active ? ' on' : ''}`; item.dataset.openliveSystem = '1';
      item.innerHTML = `<span>Linked system</span><span class="n">LIVE</span>`;
      item.addEventListener('click', () => { active = true; $$('#rnav .navitem').forEach(node => node.classList.toggle('on', node === item)); drawLink(); });
      nav.prepend(item); nav.prepend(section);
    }
    function rows(items, cells) {
      return `<table class="datatable"><tbody>${items.map(item => `<tr>${cells(item).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    function drawLink() {
      if (!active) return;
      const s = HUB.snapshot();
      const preferences = s.preferences || {};
      const midi = preferences.midi || {}, midiDevices = Array.isArray(midi.devices) ? midi.devices : [];
      const midiClock = midiDevices.find(device => device && device.clockInputEnabled);
      const osc = preferences.osc || {}, dmx = preferences.dmx || {};
      const dmxInputs = Array.isArray(dmx.inputs) ? dmx.inputs : [];
      const dmxOutputs = Array.isArray(dmx.outputLumiverses) ? dmx.outputLumiverses : [];
      const dmxNodes = Array.isArray(dmx.nodes) ? dmx.nodes : [];
      const dmxRuntime = dmx.runtime || {};
      const recording = preferences.recording || {}, rendering = preferences.clipRendering || {};
      const webserver = preferences.webserver || {};
      const domains = [
        ['Live connection', `${s.connection.status} · ${s.connection.host}`],
        ['Show', `${s.composition.name} · ${s.composition.width}×${s.composition.height}`],
        ['Transport', `${s.transport.playState} · ${s.transport.bpm} BPM · cue ${s.transport.activeColumn}`],
        ['Media catalog', `${(s.media.files || []).length} files`], ['Fixtures', `${(s.fixtures.items || []).length} definitions`],
        ['SHOWAVE Forge', `${(s.wire.patches || []).length} patches · ${(s.wire.compiled || []).length} compiled snapshots`],
        ['Presets', `${(s.presets.items || []).length} shared presets`], ['Shortcut maps', `${Object.keys(s.shortcuts.maps || {}).length} maps`],
        ['MIDI', `${midi.access && midi.access.permission || 'idle'} · ${midiDevices.filter(device => device.inputEnabled).length} input · ${midiDevices.filter(device => device.outputEnabled).length} output · Clock In ${midiClock ? midiClock.name : 'manual'}`],
        ['OSC', `${osc.input && osc.input.enabled ? `input ${osc.input.port}` : 'input off'} · ${osc.output && osc.output.enabled ? `output ${osc.output.address}:${osc.output.port}` : 'output off'}`],
        ['DMX', `${dmx.adapter && dmx.adapter.label || 'Automatic'} · ${dmxInputs.filter(input => input && input.enabled !== false).length} input · ${dmxOutputs.filter(output => output && output.outputEnabled !== false && output.enabled !== false).length} Advanced Output Lumiverse(s) · ${dmxNodes.length} detected node(s) · ${dmxRuntime.bound ? (dmxRuntime.receiving ? 'receiving' : 'bound') : 'bridge offline'}`],
        ['Recording', `${recording.recordVideo === false ? 'no video' : recording.codec || 'DXV 3'} · ${recording.recordAudio === false ? 'no audio' : 'audio'}`],
        ['Clip rendering', `${rendering.codec || 'DXV 3'} · ${rendering.format || 'Normal Quality, No Alpha'}`],
        ['Webserver', `${webserver.enabled ? 'configured' : 'off'} · Arena target ${webserver.targetHost || s.connection.host}`],
        ['SHOWAVE Map', s.output.savedAt ? `saved ${new Date(s.output.savedAt).toLocaleString()}` : 'not committed']
      ];
      $('#rbody').innerHTML = `<h2 class="sec">Linked SHOWAVE system</h2>
        <p class="lede">This view is the live relationship map shared by all fourteen windows. Changes arrive through the same persisted state and command channel.</p>
        <div class="grp">Domains and consumers<span>${domains.length}</span></div>
        ${rows(domains, item => [`<b>${escapeHtml(item[0])}</b>`, escapeHtml(item[1])])}
        <div class="grp">Recent shared activity<span>${(s.activity || []).length}</span></div>
        ${rows((s.activity || []).slice(0, 30), item => [escapeHtml(new Date(item.at).toLocaleTimeString()), `<b>${escapeHtml(item.label)}</b>`, escapeHtml(item.source)])}`;
      $('#fcount').textContent = `Linked system · revision ${s.meta.revision}`;
    }
    ensureLink();
    referenceNav.addEventListener('click', () => setTimeout(ensureLink, 0));
    HUB.subscribe('', drawLink);
  }

  function shortcutTargetAction(target) {
    const text = String(target || '').replace(/â€”/g, '—');
    let match;
    if (/(?:Composition|Show)\s*[·.]\s*Tap/i.test(text)) return ['tempo.tap', {}];
    if (/(?:Composition|Show)\s*[·.]\s*Resync/i.test(text)) return ['tempo.resync', {}];
    if (/Eject All/i.test(text)) return ['eject.all', {}];
    if (/Previous (?:Column|Cue)/i.test(text)) return ['column.previous', {
      column: relativeColumn(-1, linkedState('transport', {}), linkedState('composition', {}))
    }];
    if (/Next (?:Column|Cue)/i.test(text)) return ['column.next', {
      column: relativeColumn(1, linkedState('transport', {}), linkedState('composition', {}))
    }];
    if ((match = text.match(/^(?:Column|Cue)\s+(\d+)/i))) return ['column.trigger', { column: Number(match[1]) }];
    if ((match = text.match(/Clips?\s*[^\d]*Layer\s+(\d+).*Clip\s+(\d+)/i))) return ['clip.trigger', { layer: Number(match[1]), column: Number(match[2]) }];
    if (/(?:Composition|Show)\s*[·.]\s*Bypass/i.test(text)) return ['composition.bypass', { bypass: !linkedState('transport', {}).bypass }];
    return null;
  }

  function attachSharedKeyboardMap() {
    global.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.metaKey) return;
      const target = event.target;
      if (target && (target.matches('input,textarea,select') || target.isContentEditable)) return;
      if (page === 'shortcuts.html' && $('#learnBar') && $('#learnBar').classList.contains('on')) return;
      const active = HUB.get('shortcuts.activeMap');
      const mapSet = HUB.get('shortcuts.maps', {});
      const record = mapSet[active];
      const rows = record && record.data && record.data.key;
      if (!Array.isArray(rows)) return;
      const key = event.key === 'Escape' ? 'Esc' : event.key === ' ' ? 'Space' : event.key;
      const modifiers = [event.ctrlKey && 'Ctrl', event.shiftKey && 'Shift', event.altKey && 'Alt'].filter(Boolean).join('+') || '—';
      const row = rows.find(binding => String(binding[1]).toLowerCase() === key.toLowerCase() &&
        String(binding[2] || '—').replace(/â€”/g, '—') === modifiers);
      if (!row) return;
      const action = shortcutTargetAction(row[0]);
      if (!action) return;
      event.preventDefault();
      arenaCommand(action[0], action[1]);
      HUB.emit('shortcut:fired', { map: active, target: row[0], key, action: action[0] }, { activity: true, label: `Shortcut · ${row[0]}` });
    });
  }

  function attachHubRefreshes() {
    HUB.on('state', detail => {
      if (page !== 'index.html' || !global.OpenLiveArenaController) return;
      if (/^(wire(?:\.compiled)?|media(?:\.files)?|presets(?:\.items)?)/.test(detail.changedPath || '')) {
        try { global.OpenLiveArenaController.execute('browser.refresh'); } catch (_) {}
      }
    });
  }

  function initSharedVideoPreferenceProjection() {
    const apply = value => {
      const video = value || {};
      const dma = video.dma || {};
      const ffgl = video.ffgl || {};
      const mode = String(dma.mode || 'Force ON').trim();
      document.documentElement.dataset.olDmaTextures = slug(mode);
      document.documentElement.dataset.olNvidiaProfile = dma.customNvidiaProfile ? 'requested' : 'off';
      document.documentElement.dataset.olFfglPlugins = String((Array.isArray(ffgl.plugins) ? ffgl.plugins : [])
        .filter(plugin => plugin && plugin.enabled !== false).length);
      document.documentElement.style.setProperty('--ol-dma-texture-mode', `"${mode.replace(/"/g, '')}"`);
    };
    apply(HUB.get('preferences.video', {}));
    HUB.subscribe('preferences.video', apply, { immediate: false });
  }

  function initSharedMidiPreferenceProjection() {
    const apply = value => {
      const midi = value || {};
      const devices = Array.isArray(midi.devices) ? midi.devices : [];
      const access = midi.access || {};
      const inputs = devices.filter(device => device && device.inputEnabled).length;
      const outputs = devices.filter(device => device && device.outputEnabled).length;
      const clock = devices.find(device => device && device.clockInputEnabled);
      const permission = String(access.supported === false ? 'unsupported' : (access.permission || 'idle')).trim();
      const middleC = ['Legacy', 'C3', 'C4'].includes(midi.middleC) ? midi.middleC : 'C4';
      document.documentElement.dataset.olMidiAccess = slug(permission);
      document.documentElement.dataset.olMidiInput = String(inputs);
      document.documentElement.dataset.olMidiOutput = String(outputs);
      document.documentElement.dataset.olMidiClockIn = clock ? String(clock.id || clock.name || 'enabled') : 'manual';
      document.documentElement.dataset.olMidiMiddleC = middleC;
    };
    apply(HUB.get('preferences.midi', {}));
    HUB.subscribe('preferences.midi', apply, { immediate: false });
  }

  function initSharedSystemPreferenceProjection() {
    const style = document.createElement('style');
    style.id = 'ol-shared-preference-style';
    style.textContent = `html[data-ol-unicode-font="on"] body,
      html[data-ol-unicode-font="on"] :is(button,input,select,textarea){
        font-family:"Arial Unicode MS",Arial,"Segoe UI",sans-serif !important;
      }`;
    document.head.appendChild(style);
    let confirmOnClose = false;
    if (page === 'index.html') global.addEventListener('beforeunload', event => {
      if (!confirmOnClose) return;
      event.preventDefault();
      event.returnValue = '';
    });

    const apply = () => {
      const preferences = HUB.get('preferences', {}) || {};
      const general = preferences.general || {};
      const osc = preferences.osc || {}, oscInput = osc.input || {}, oscOutput = osc.output || {};
      const dmx = preferences.dmx || {}, dmxInputs = Array.isArray(dmx.inputs) ? dmx.inputs : [];
      const dmxOutputs = Array.isArray(dmx.outputLumiverses) ? dmx.outputLumiverses : [];
      const dmxNodes = Array.isArray(dmx.nodes) ? dmx.nodes : [];
      const dmxRuntime = dmx.runtime || {};
      const recording = preferences.recording || {}, rendering = preferences.clipRendering || {};
      const defaults = preferences.defaults || {}, webserver = preferences.webserver || {};
      confirmOnClose = general.quitConfirmation !== false;
      document.documentElement.dataset.olUnicodeFont = general.unicodeFont ? 'on' : 'off';
      document.documentElement.dataset.olExternalPanelUpdates = general.updateClipPanelOnExternalTriggers === false ? 'off' : 'on';
      document.documentElement.dataset.olScrollSelection = general.scrollSelection === false ? 'off' : 'on';
      document.documentElement.dataset.olClipStartOffset = String(Math.max(0, Number(general.clipStartOffsetMs) || 0));
      document.documentElement.dataset.olOscInput = oscInput.enabled ? `udp-${oscInput.port || 7000}` : 'off';
      document.documentElement.dataset.olOscOutput = oscOutput.enabled ? `${oscOutput.address || '127.0.0.1'}-${oscOutput.port || 7001}` : 'off';
      document.documentElement.dataset.olDmxAdapter = slug(dmx.adapter && (dmx.adapter.id || dmx.adapter.label) || 'automatic');
      document.documentElement.dataset.olDmxInputs = String(dmxInputs.filter(input => input && input.enabled !== false).length);
      document.documentElement.dataset.olDmxOutputs = String(dmxOutputs.filter(output => output && output.outputEnabled !== false && output.enabled !== false).length);
      document.documentElement.dataset.olDmxNodes = String(dmxNodes.length);
      document.documentElement.dataset.olDmxBridge = dmxRuntime.bound ? (dmxRuntime.receiving ? 'receiving' : 'bound') : 'offline';
      document.documentElement.dataset.olRecordingMedia = recording.recordVideo === false
        ? (recording.recordAudio === false ? 'none' : 'audio') : (recording.recordAudio === false ? 'video' : 'video-audio');
      document.documentElement.dataset.olRenderCodec = slug(rendering.codec || 'DXV 3');
      document.documentElement.dataset.olDefaultBlend = slug(defaults.layerBlendMode || 'Add');
      document.documentElement.dataset.olTempoNudgeRange = String(Math.max(1, Number(defaults.tempoNudgeRange) || 10));
      document.documentElement.dataset.olWebserver = webserver.enabled ? 'configured' : 'off';
      document.documentElement.dataset.olArenaTarget = String(webserver.targetHost || HUB.get('connection.host', '127.0.0.1:8080'));
    };
    apply();
    ['general','osc','dmx','recording','clipRendering','defaults','webserver'].forEach(domain =>
      HUB.subscribe(`preferences.${domain}`, apply, { immediate: false }));
  }

  function startAdapter(name, adapter) {
    try {
      adapter();
      document.documentElement.dataset[`ol${name.replace(/(^.|-.)/g, value => value.replace('-', '').toUpperCase())}`] = 'ready';
    } catch (error) {
      console.error(`OpenLive ${name} adapter`, error);
      HUB.emit('adapter:error', { page, adapter: name, message: error.message });
    }
  }

  function init() {
    mountSharedControls();
    startAdapter('video-preferences', initSharedVideoPreferenceProjection);
    startAdapter('midi-preferences', initSharedMidiPreferenceProjection);
    startAdapter('system-preferences', initSharedSystemPreferenceProjection);
    startAdapter('wire-settings', initWireSettings);
    startAdapter('envelope', initEnvelope);
    startAdapter('shortcuts', initShortcutEditor);
    startAdapter('presets', initPresets);
    startAdapter('reference', initReferenceLinkView);
    attachSharedKeyboardMap();
    attachHubRefreshes();
    HUB.ready().then(() => {
      /* Authority election and command execution begin only after the relay
         snapshot has converged. Starting earlier lets two freshly opened
         Arena tabs both believe they own the recorder. */
      attachArenaBridge();
      HUB.on('command:arena', executeArenaCommand);
      controllerSnapshotLoop();
      scanPendingRecordingCommands();
      if (page === 'index.html' && global.OpenLiveArenaController) {
        setInterval(scanPendingRecordingCommands, 1500);
      }
      /* Some tools mount before this late page adapter. Re-request the Arena
         snapshot after every adapter is listening so Input Selection never
         opens with a stale Layer/Group catalog merely because of script
         order or a fresh popup. */
      HUB.emit('arena:state:request', { source: `integration:${page}` });
      HUB.emit('window:ready', { page, title: document.title });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
