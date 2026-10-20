/* OpenLive utility-window adapters
   -------------------------------------------------------------------------
   Keeps the existing utility UIs intact while making their editable state
   durable and visible to the other OpenLive windows through OpenLiveHub.
   Native file copying, codecs and hardware I/O are intentionally not faked.
   ------------------------------------------------------------------------- */
(function utilityHubAdapters(global) {
  'use strict';

  const Hub = global.OpenLiveHub;
  if (!Hub) return;

  const page = (location.pathname.split('/').pop() || '').toLowerCase();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const text = node => (node && node.textContent || '').replace(/\s+/g, ' ').trim();
  const slug = value => String(value || 'value').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'value';
  const uid = prefix => `${prefix || 'item'}:${Date.now().toString(36)}:${
    global.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

  function valueOf(control) {
    if (control.type === 'checkbox') return !!control.checked;
    if (control.type === 'number' || control.type === 'range') return Number(control.value);
    return control.value;
  }

  function writeValue(control, value) {
    if (value === undefined) return;
    if (control.type === 'checkbox') control.checked = !!value;
    else control.value = value;
    if (control.type === 'range') {
      const output = control.parentElement && control.parentElement.querySelector('output');
      if (output) output.value = control.value;
    }
  }

  function controlForLabel(root, label) {
    return [...root.querySelectorAll('.formrow, .prow')]
      .find(row => text(row.querySelector('label')) === label)
      ?.querySelector('input, select, textarea') || null;
  }

  /* --------------------------------------------------------------------- */
  function initPreferences() {
    const controls = [...document.querySelectorAll('[data-tab] input, [data-tab] select, [data-tab] textarea')]
      .filter(control => !control.closest('[data-audio-managed],[data-video-managed],[data-midi-managed],[data-system-managed],[data-appearance-managed]'));
    let applying = false;
    let rangeTimer = 0;

    controls.forEach((control, index) => {
      const pane = control.closest('[data-tab]');
      const group = control.closest('.formgroup');
      const row = control.closest('.formrow');
      const tr = control.closest('tr');
      let label = text(row && row.querySelector('label'));
      if (!label && tr) {
        const column = [...tr.children].indexOf(control.closest('td'));
        const heading = tr.closest('table')?.querySelectorAll('th')[column];
        label = `${text(tr.children[0])}-${text(heading)}`;
      }
      if (!label) label = `${control.tagName}-${control.type || 'value'}-${index}`;
      control.dataset.hubPreference = [pane?.dataset.tab || 'general', text(group?.querySelector('h3')), label]
        .filter(Boolean).map(slug).join('.');
    });

    function currentValues() {
      const values = {};
      controls.forEach(control => { values[control.dataset.hubPreference] = valueOf(control); });
      return values;
    }

    function apply(values) {
      if (!values) return;
      applying = true;
      controls.forEach(control => writeValue(control, values[control.dataset.hubPreference]));
      applying = false;
    }

    function commit(control, reason) {
      if (applying) return;
      let values;
      Hub.transaction(snapshot => {
        const preferences = snapshot.preferences || (snapshot.preferences = {});
        values = Object.assign({}, preferences.values || {});
        values[control.dataset.hubPreference] = valueOf(control);
        preferences.values = values;
        preferences.updatedAt = Date.now();
      }, { changedPath: 'preferences.values', reason: reason || 'preference-change' });
      const detail = {
        key: control.dataset.hubPreference, value: valueOf(control), values,
        section: control.closest('[data-tab]')?.dataset.tab || 'general'
      };
      Hub.emit('openlive:preferences-changed', detail, { activity: false });
    }

    controls.forEach(control => {
      control.addEventListener('change', () => commit(control, 'preference-change'));
      control.addEventListener('input', () => {
        if (control.type !== 'range') { commit(control, 'preference-input'); return; }
        clearTimeout(rangeTimer);
        rangeTimer = setTimeout(() => commit(control, 'preference-range'), 100);
      });
    });

    Hub.subscribe('preferences.values', apply);
    if (!Object.keys(Hub.get('preferences.values', {})).length) {
      Hub.patch('preferences', { values: currentValues(), updatedAt: Date.now() }, { reason: 'seed-preferences' });
    }
  }

  /* --------------------------------------------------------------------- */
  function initFixtureEditor() {
    const editor = global.OpenLiveFixtureEditor;
    if (editor && typeof editor.snapshot === 'function' &&
        typeof editor.restore === 'function' && typeof editor.subscribe === 'function') {

    const signature = value => JSON.stringify({
      items: value && Array.isArray(value.items) ? value.items : [],
      selectedId: value && value.selectedId || null
    });
    let appliedSignature = '';

    function commitFixtureState(detail) {
      const current = editor.snapshot();
      const operation = detail && detail.operation || 'update';
      const ids = detail && detail.ids || (current.selectedId ? [current.selectedId] : []);
      appliedSignature = signature(current);
      Hub.transaction(state => {
        state.fixtures = Object.assign({}, state.fixtures || {}, current, { updatedAt: Date.now() });
      }, { changedPath: 'fixtures', reason: `fixture-${operation}` });
      Hub.emit('openlive:fixtures-changed', {
        operation, ids, items: current.items, selectedId: current.selectedId,
        revision: Date.now()
      }, { activity: operation !== 'select', label: `Fixture ${operation}` });
    }

    const stored = Hub.get('fixtures', { items: [], selectedId: null }) || {};
    if (Array.isArray(stored.items) && stored.items.length) {
      editor.restore(stored);
      appliedSignature = signature(editor.snapshot());
    } else {
      commitFixtureState({ operation: 'seed' });
    }

    editor.subscribe(commitFixtureState);
    Hub.subscribe('fixtures', value => {
      if (!value || !Array.isArray(value.items) || !value.items.length) return;
      const nextSignature = signature(value);
      if (nextSignature === appliedSignature) return;
      editor.restore(value);
      appliedSignature = signature(editor.snapshot());
    }, { immediate: false });
    return;
    }

    /* Pre-contract fallback retained for older standalone fixture pages. The
       current fixture-editor.html always supplies OpenLiveFixtureEditor. */
    const byId = id => document.getElementById(id);
    const nameInput = byId('fName');
    let selectedId = Hub.get('fixtures.selectedId', null);
    let applying = false;
    let fixtureInputTimer = 0;

    function fixtureChannelsPerPixel(colorSpace) {
      const token = String(colorSpace || 'RGB').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (token === 'RGB3') return 3;
      return Math.max(1, (token.match(/[A-Z]/g) || ['R', 'G', 'B']).length);
    }

    function defaultFixtureParameters() {
      return [
        { id: uid('fixture-param'), order: 0, name: 'Dimmer', type: 'dummy', channelCount: 1, defaultValue: 0 },
        { id: uid('fixture-param'), order: 1, name: 'Chase preset', type: 'dummy', channelCount: 1, defaultValue: 0 },
        { id: uid('fixture-param'), order: 2, name: 'Pixel data', type: 'pixel', channelCount: 0, defaultValue: 0 }
      ];
    }

    function fixtureContract(width, height, colorSpace, bitDepth, rawParameters) {
      const w = Math.max(1, Math.round(Number(width) || 1));
      const h = Math.max(1, Math.round(Number(height) || 1));
      const depth = Number(bitDepth) === 16 ? 16 : 8;
      const channelsPerPixel = fixtureChannelsPerPixel(colorSpace) * (depth === 16 ? 2 : 1);
      const pixelCount = w * h, pixelChannelCount = pixelCount * channelsPerPixel;
      const source = Array.isArray(rawParameters) && rawParameters.length ? rawParameters : defaultFixtureParameters();
      let pixelSeen = false;
      const parameters = source.map((parameter, index) => {
        const item = parameter || {}, name = text(item.name) || `Parameter ${index + 1}`;
        let type = /dummy/i.test(name) ? 'dummy' : /pixel/i.test(name) ? 'pixel' : item.type;
        if (type === 'pixel' && !pixelSeen) pixelSeen = true;
        else type = 'dummy';
        return {
          id: item.id || uid('fixture-param'), order: index,
          name: name.replace(/\s*\(dummy\)\s*$/i, ''), type,
          channelCount: type === 'pixel' ? pixelChannelCount : Math.max(1, Math.round(Number(item.channelCount) || 1)),
          defaultValue: Number.isFinite(Number(item.defaultValue)) ? Number(item.defaultValue) : 0
        };
      });
      if (!pixelSeen) parameters.push({
        id: uid('fixture-param'), order: parameters.length, name: 'Pixel data', type: 'pixel',
        channelCount: pixelChannelCount, defaultValue: 0
      });
      parameters.forEach((parameter, index) => { parameter.order = index; });
      const dummyChannelCount = parameters.filter(parameter => parameter.type === 'dummy')
        .reduce((total, parameter) => total + parameter.channelCount, 0);
      const channelCount = parameters.reduce((total, parameter) => total + parameter.channelCount, 0);
      return { parameters, channelsPerPixel, pixelCount, pixelChannelCount, dummyChannelCount, channelCount };
    }

    function inferred(name, category) {
      const dimensions = /(\d+)\s*[x×]\s*(\d+)/i.exec(name);
      const fixture = {
        id: uid('fixture'), uuid: uid('fixture-uuid'), name,
        category: category || 'Custom', width: dimensions ? +dimensions[1] : 1,
        height: dimensions ? +dimensions[2] : 1,
        colorSpace: /rgbw/i.test(name) ? 'RGBW' : 'RGB', bitDepth: 8,
        invert: false, gamma: '2.2', distribution: 'Left→Right, Top→Bottom',
        parameters: defaultFixtureParameters(), updatedAt: Date.now()
      };
      return Object.assign(fixture, fixtureContract(
        fixture.width, fixture.height, fixture.colorSpace, fixture.bitDepth, fixture.parameters));
    }

    function seedItems() {
      const seeded = [];
      if (typeof FIXTURES !== 'undefined') FIXTURES.forEach(group => {
        group.items.forEach(name => seeded.push(inferred(name, group.g)));
      });
      return seeded;
    }

    function items() { return Hub.get('fixtures.items', []); }

    function syncLegacy(list) {
      if (typeof FIXTURES === 'undefined') return;
      const grouped = new Map();
      list.forEach(item => {
        const key = item.category || 'Custom';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item.name);
      });
      FIXTURES.splice(0, FIXTURES.length, ...[...grouped].map(([g, names]) => ({ g, items: names })));
    }

    function selected(list) {
      return list.find(item => item.id === selectedId || item.uuid === selectedId)
        || list.find(item => item.name === nameInput.value) || list[0] || null;
    }

    function parametersFromUI() {
      return [...document.querySelectorAll('#chanList .chan-row')].map((row, index) => {
        const nameControl = row.querySelector('.nm, [data-parameter-name]');
        const name = String(nameControl && nameControl.value || text(nameControl) || `Parameter ${index + 1}`);
        const inferredType = /dummy/i.test(name) ? 'dummy' : /pixel/i.test(name) ? 'pixel' : '';
        return {
          id: row.dataset.parameterId || uid('fixture-param'), order: index, name,
          type: row.dataset.parameterType === 'pixel' || inferredType === 'pixel' ? 'pixel' : 'dummy',
          channelCount: Math.max(1, Math.round(Number(row.dataset.channelCount) || 1)),
          defaultValue: Number.isFinite(Number(row.querySelector('.dv')?.value))
            ? Number(row.querySelector('.dv').value) : 0
        };
      });
    }

    function recordFromUI(base) {
      const invert = controlForLabel(document, 'Invert value');
      const gamma = controlForLabel(document, 'Gamma correction');
      const distribution = controlForLabel(document, 'Order');
      const width = Math.max(1, +byId('fW').value || 1), height = Math.max(1, +byId('fH').value || 1);
      const colorSpace = byId('fColor').value || 'RGB', bitDepth = byId('f16').checked ? 16 : 8;
      const contract = fixtureContract(width, height, colorSpace, bitDepth, parametersFromUI());
      return Object.assign({}, base || inferred(nameInput.value, 'Custom'), {
        name: nameInput.value.trim() || 'New Fixture',
        width, height, colorSpace, bitDepth,
        invert: !!invert?.checked, gamma: gamma?.value || '2.2',
        distribution: distribution?.value || 'Left→Right, Top→Bottom',
        updatedAt: Date.now()
      }, contract);
    }

    function apply(item) {
      if (!item) return;
      applying = true;
      selectedId = item.id;
      nameInput.value = item.name;
      byId('fixTitle').textContent = item.name;
      byId('fW').value = item.width || 1;
      byId('fH').value = item.height || 1;
      byId('fColor').value = item.colorSpace || 'RGB';
      byId('f16').checked = +item.bitDepth === 16;
      writeValue(controlForLabel(document, 'Invert value'), item.invert);
      writeValue(controlForLabel(document, 'Gamma correction'), item.gamma);
      writeValue(controlForLabel(document, 'Order'), item.distribution);
      const contract = fixtureContract(item.width, item.height, item.colorSpace, item.bitDepth, item.parameters);
      if (typeof global.setFixtureParameterRows === 'function') global.setFixtureParameterRows(contract.parameters);
      applying = false;
      if (typeof drawPrev === 'function') drawPrev();
    }

    function commit(list, operation, ids) {
      list = clone(list);
      const selectedItem = selected(list);
      selectedId = selectedItem && selectedItem.id;
      Hub.transaction(state => {
        state.fixtures.items = list;
        state.fixtures.selectedId = selectedId;
        state.fixtures.updatedAt = Date.now();
      }, { changedPath: 'fixtures', reason: `fixture-${operation}` });
      Hub.emit('openlive:fixtures-changed', {
        operation, ids: ids || (selectedId ? [selectedId] : []), items: list,
        selectedId, revision: Date.now()
      }, { activity: operation !== 'select', label: `Fixture ${operation}` });
      syncLegacy(list);
      if (typeof renderList === 'function') renderList();
    }

    function saveCurrent(reason) {
      if (applying) return;
      const list = items();
      const current = selected(list);
      if (!current) return;
      const saved = recordFromUI(current);
      const index = list.findIndex(item => item.id === current.id);
      list[index] = saved;
      commit(list, reason || 'update', [saved.id]);
    }

    let list = items();
    if (!list.length) {
      list = seedItems();
      selectedId = list.find(item => item.name === nameInput.value)?.id || list[0]?.id || null;
      commit(list, 'seed', list.map(item => item.id));
    } else {
      const migrated = list.map(item => Object.assign({}, item,
        fixtureContract(item.width, item.height, item.colorSpace, item.bitDepth, item.parameters)));
      if (JSON.stringify(migrated) !== JSON.stringify(list)) {
        list = migrated;
        commit(list, 'contract-migrate', list.map(item => item.id));
      }
      syncLegacy(list);
      apply(selected(list));
      if (typeof renderList === 'function') renderList();
    }

    byId('fixList').addEventListener('click', event => {
      const row = event.target.closest('.titem');
      if (!row) return;
      const item = items().find(entry => entry.name === text(row));
      if (!item) return;
      selectedId = item.id;
      apply(item);
      commit(items(), 'select', [item.id]);
    });

    byId('newFix').addEventListener('click', () => {
      const listNow = items();
      let name = 'New Fixture', suffix = 2;
      while (listNow.some(item => item.name === name)) name = `New Fixture ${suffix++}`;
      const made = recordFromUI(inferred(name, 'Custom'));
      made.name = name;
      listNow.push(made); selectedId = made.id;
      commit(listNow, 'create', [made.id]); apply(made);
    });

    byId('delFix').addEventListener('click', () => {
      const removed = selectedId;
      const listNow = items().filter(item => item.id !== removed);
      selectedId = listNow[0]?.id || null;
      commit(listNow, 'remove', removed ? [removed] : []);
      apply(selected(listNow));
    });

    ['fName', 'fW', 'fH', 'fColor', 'f16'].forEach(id => {
      byId(id).addEventListener('change', () => saveCurrent('update'));
    });
    ['fW', 'fH'].forEach(id => byId(id).addEventListener('input', () => {
      clearTimeout(fixtureInputTimer);
      fixtureInputTimer = setTimeout(() => saveCurrent('update'), 90);
    }));
    [controlForLabel(document, 'Invert value'), controlForLabel(document, 'Gamma correction'),
      controlForLabel(document, 'Order')].filter(Boolean)
      .forEach(control => control.addEventListener('change', () => saveCurrent('update')));
    document.addEventListener('openlive:fixture-parameters-edited', event => {
      saveCurrent(event.detail && event.detail.reason || 'parameters');
    });

    Hub.subscribe('fixtures', value => {
      if (!value || !value.items || applying) return;
      const changed = value.items;
      selectedId = value.selectedId || selectedId;
      syncLegacy(changed);
      apply(selected(changed));
      if (typeof renderList === 'function') renderList();
    }, { immediate: false });
  }

  /* --------------------------------------------------------------------- */
  function initMediaManager() {
    let applying = false;
    let activeName = '';

    function record(row, index) {
      if (Array.isArray(row)) return {
        id: `media:${slug(row[4] || row[0])}`, name: row[0], type: row[1], size: row[2],
        uses: row[3], path: row[4], missing: !!row[5], order: index
      };
      return {
        id: row.id || `media:${slug(row.path || row.name || index)}`,
        name: row.name || (row.path || '').split(/[\\/]/).pop() || `File ${index + 1}`,
        type: row.type || row.format || '', size: row.size || row.file_size || '',
        uses: row.uses || row.used || '1×', path: row.path || '',
        missing: row.missing != null ? !!row.missing : row.exists === false, order: index
      };
    }

    function toLegacy(item) {
      return [item.name, item.type, item.size, item.uses, item.path, !!item.missing];
    }

    function hubFiles() { return (Hub.get('composition.files', []) || []).map(record); }

    function apply(list) {
      if (typeof FILES === 'undefined' || !Array.isArray(list)) return;
      applying = true;
      FILES.splice(0, FILES.length, ...list.map(toLegacy));
      if (typeof render === 'function') render();
      applying = false;
    }

    function commit(reason, extra) {
      if (applying || typeof FILES === 'undefined') return;
      const list = FILES.map(record);
      Hub.transaction(state => {
        state.composition.files = list;
        state.composition.dirty = true;
        state.composition.updatedAt = Date.now();
        state.media.files = list;
        state.media.updatedAt = Date.now();
      }, { changedPath: 'composition.files', reason });
      Hub.emit('openlive:composition-media-changed', Object.assign({
        operation: reason, files: list, dirty: true, at: Date.now()
      }, extra || {}), { activity: true, label: `Media Manager: ${reason}` });
    }

    let initial = hubFiles();
    if (!initial.length && typeof FILES !== 'undefined') {
      initial = FILES.map(record);
      Hub.transaction(state => {
        state.composition.files = initial;
        state.media.files = initial;
        state.media.updatedAt = Date.now();
      }, { changedPath: 'composition.files', reason: 'seed-composition-media' });
    } else apply(initial);

    document.getElementById('tbl').addEventListener('click', event => {
      const button = event.target.closest('.mm-path-action');
      if (!button) return;
      const row = button.closest('tr');
      activeName = text(row?.children[0]);
      if (text(button) !== 'Set Path') return;
      event.preventDefault();
      const item = FILES.find(entry => entry[0] === activeName);
      if (!item) return;
      const next = prompt(`Set a replacement path for ${item[0]}`, item[4]);
      if (!next || next === item[4]) return;
      const oldPath = item[4]; item[4] = next.trim(); item[5] = false;
      render();
      commit('set-path', { replacements: [{ oldPath, newPath: item[4], name: item[0] }] });
    });

    const originalFixOne = global.fixOne;
    if (typeof originalFixOne === 'function') global.fixOne = function durableFixOne() {
      originalFixOne();
      commit('relocate-one', { name: activeName, simulatedSearch: true });
    };
    const originalFixAll = global.fixAll;
    if (typeof originalFixAll === 'function') global.fixAll = function durableFixAll() {
      originalFixAll();
      commit('relocate-all', { name: activeName, simulatedSearch: true });
    };

    const collectConfirm = [...document.querySelectorAll('#dlgCollect .btnrow button')]
      .find(button => text(button) === 'Collect');
    const clearCollect = document.createElement('button');
    clearCollect.className = 'tb-btn'; clearCollect.type = 'button';
    const paintCollectRecords = () => {
      const count = Hub.get('media.queue', []).filter(item => item.kind === 'collect-media' && item.simulated).length;
      clearCollect.textContent = `Clear ${count} Record${count === 1 ? '' : 's'}`;
      clearCollect.disabled = count === 0;
    };
    document.querySelector('#dlgCollect .btnrow')?.prepend(clearCollect);
    clearCollect.addEventListener('click', () => {
      const queue = Hub.get('media.queue', []).filter(item => !(item.kind === 'collect-media' && item.simulated));
      Hub.patch('media', { queue, updatedAt: Date.now() }, { reason: 'clear-collect-simulations' });
      Hub.emit('openlive:media-collect-records-cleared', { remaining: queue.length },
        { activity: true, label: 'Collect Media records cleared' });
      paintCollectRecords();
    });
    collectConfirm?.addEventListener('click', () => {
      const destination = document.querySelector('#dlgCollect input')?.value || '';
      const job = {
        id: uid('collect'), kind: 'collect-media', destination,
        fileCount: FILES.length, status: 'simulation-recorded', simulated: true,
        message: 'No files were copied; native file access is not connected.', createdAt: Date.now()
      };
      const queue = Hub.get('media.queue', []); queue.push(job);
      Hub.patch('media', { queue, updatedAt: Date.now() }, { reason: 'collect-simulation' });
      Hub.emit('openlive:media-collect-simulated', job, { activity: true, label: 'Collect Media simulation' });
      paintCollectRecords();
      const totals = document.getElementById('totals');
      if (totals) totals.textContent += ' · collect simulation recorded (no files copied)';
    });

    paintCollectRecords();
    document.querySelector('.mm-close')?.addEventListener('click', () => commit('close'));
    Hub.subscribe('composition.files', (list, meta) => {
      if (meta.external && Array.isArray(list)) apply(list.map(record));
    }, { immediate: false });
  }

  /* --------------------------------------------------------------------- */
  function initAlley() {
    let applying = false;
    let jobTimer = 0;
    let lastJobSerial = '';
    const controls = {
      preset: document.getElementById('preset'), dxv: document.getElementById('dxv'),
      size: document.getElementById('size'), outputFolder: document.getElementById('outFolder'),
      outputName: document.getElementById('outName'), audio: document.getElementById('audioOn'),
      width: controlForLabel(document, 'Width'), height: controlForLabel(document, 'Height'),
      scaling: controlForLabel(document, 'Scaling'), sampleRate: controlForLabel(document, 'Sample Rate'),
      bitDepth: controlForLabel(document, 'Bit Depth')
    };

    function settings() {
      const out = {};
      Object.entries(controls).forEach(([key, control]) => { if (control) out[key] = valueOf(control); });
      return out;
    }

    function applySettings(values) {
      if (!values) return;
      applying = true;
      Object.entries(controls).forEach(([key, control]) => { if (control) writeValue(control, values[key]); });
      applying = false;
      if (typeof syncResult === 'function') syncResult();
    }

    function serialJobs() {
      if (typeof queue === 'undefined') return [];
      return queue.map((item, index) => Object.assign({}, item, {
        id: item.id || `alley-job:${slug(item.name)}:${index}`, simulated: true,
        status: item.pct >= 100 ? 'simulation-complete' : item.pct > 0 ? 'simulating' : 'pending-simulation'
      }));
    }

    function persist(reason) {
      if (applying) return;
      const jobs = serialJobs();
      const serial = JSON.stringify(jobs);
      if (reason === 'simulation-progress' && serial === lastJobSerial) return;
      lastJobSerial = serial;
      const alleyState = Hub.get('alley', {});
      alleyState.preset = controls.preset?.value || alleyState.preset;
      alleyState.settings = settings();
      alleyState.queue = jobs;
      alleyState.jobs = jobs;
      alleyState.updatedAt = Date.now();
      Hub.set('alley', alleyState, { reason: reason || 'alley-change' });
      Hub.patch('media', { conversionQueue: jobs, updatedAt: Date.now() }, { reason: 'alley-queue' });
      Hub.emit('openlive:alley-queue-changed', {
        operation: reason || 'change', jobs, settings: alleyState.settings, simulated: true
      }, { activity: false });
    }

    const savedSettings = Hub.get('alley.settings', {});
    if (Object.keys(savedSettings).length) applySettings(savedSettings);
    else Hub.patch('alley', { settings: settings(), updatedAt: Date.now() }, { reason: 'seed-alley-settings' });

    const storedJobs = Hub.get('alley.jobs', []);
    if (typeof queue !== 'undefined' && !queue.length && storedJobs.length) {
      storedJobs.forEach(item => queue.push(Object.assign({}, item)));
    }

    const storedPresets = Hub.get('alley.presets', []);
    if (!storedPresets.length && typeof ALLEY_PRESETS !== 'undefined') {
      Hub.patch('alley', { presets: ALLEY_PRESETS.filter(name => name !== 'Custom').map(name => ({
        id: `alley-preset:${slug(name)}`, name, settings: {}, builtIn: true
      })) }, { reason: 'seed-alley-presets' });
    } else storedPresets.forEach(record => {
      if (controls.preset && ![...controls.preset.options].some(option => option.value === record.name)) {
        controls.preset.appendChild(new Option(record.name, record.name));
      }
    });

    Object.values(controls).filter(Boolean).forEach(control => {
      control.addEventListener('change', () => persist('settings-change'));
    });
    document.getElementById('actionBtn')?.addEventListener('click', () => {
      setTimeout(() => persist('queue-action'), 0);
    });

    const savePreset = [...document.querySelectorAll('.button-pair button')]
      .find(button => text(button).startsWith('Save'));
    savePreset?.addEventListener('click', () => {
      const name = prompt('Save conversion preset as', controls.preset?.value === 'Custom' ? '' : controls.preset?.value || '');
      if (!name || !name.trim()) return;
      const record = { id: `alley-preset:${slug(name)}`, name: name.trim(), settings: settings(), builtIn: false, updatedAt: Date.now() };
      const presets = Hub.get('alley.presets', []);
      const at = presets.findIndex(item => item.id === record.id);
      if (at >= 0) presets[at] = record; else presets.push(record);
      Hub.patch('alley', { presets, preset: record.name, updatedAt: Date.now() }, { reason: 'save-alley-preset' });
      if (controls.preset && ![...controls.preset.options].some(option => option.value === record.name)) {
        controls.preset.appendChild(new Option(record.name, record.name));
      }
      controls.preset.value = record.name;
      Hub.emit('openlive:alley-presets-changed', { operation: 'save', preset: record, presets },
        { activity: true, label: `Saved SHOWAVE Encode preset ${record.name}` });
    });

    /* Keep the existing progress demonstration, but make its nature explicit. */
    const originalRenderQueue = global.renderQueue;
    if (typeof originalRenderQueue === 'function') global.renderQueue = function honestRenderQueue() {
      originalRenderQueue();
      document.querySelectorAll('#queueBody tr').forEach((row, index) => {
        const item = typeof queue !== 'undefined' ? queue[index] : null;
        const status = row.children[3];
        if (status && item) status.textContent = item.pct >= 100 ? 'Simulation complete'
          : item.pct > 0 ? 'Simulating' : 'Pending simulation';
      });
    };
    const originalSyncAction = global.syncAction;
    if (typeof originalSyncAction === 'function') global.syncAction = function honestSyncAction() {
      originalSyncAction();
      const active = document.querySelector('#mainTabs .ptab.active')?.dataset.pane;
      const button = document.getElementById('actionBtn');
      if (button && active === 'tQueue') button.textContent = `Simulate ${typeof queue === 'undefined' ? 0 : queue.length} File${queue?.length === 1 ? '' : 's'}`;
    };
    if (typeof renderQueue === 'function') renderQueue();
    if (typeof syncAction === 'function') syncAction();

    const cores = document.getElementById('cores');
    if (cores && !/simulation/i.test(cores.textContent)) cores.textContent += ' · conversion is a browser simulation';
    jobTimer = setInterval(() => {
      if (typeof queue !== 'undefined' && queue.length) persist('simulation-progress');
    }, 750);
    addEventListener('beforeunload', () => { clearInterval(jobTimer); persist('close'); });

    Hub.subscribe('alley.settings', (values, meta) => {
      if (meta.external) applySettings(values);
    }, { immediate: false });
  }

  Hub.ready().then(() => {
    if (page === 'preferences.html') initPreferences();
    else if (page === 'fixture-editor.html') initFixtureEditor();
    else if (page === 'media-manager.html') initMediaManager();
    else if (page === 'alley.html') initAlley();
    document.documentElement.dataset.olUtility = 'ready';
  });
})(window);
