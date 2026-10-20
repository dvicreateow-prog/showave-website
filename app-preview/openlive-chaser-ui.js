/* SHOWAVE Chaser / Mapper operator window. */
(function runOpenLiveChaserUI() {
  'use strict';

  const C = window.OpenLiveChaser, E = window.OpenLiveChaserExport;
  const Native = window.OpenLiveChaserNative, Files = window.OpenLiveSessionPolicy?.chaserFiles;
  const Recovery = window.OpenLiveSessionPolicy?.chaserRecoveryStore;
  const Hub = window.OpenLiveHub, Bus = window.ArenaBus;
  if (!C || !document.getElementById('chaserRoot')) return;

  const $ = selector => document.querySelector(selector);
  const operatorViewActive = () => !document.hidden || window.__showaveWorkspaceDetached === true;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const copy = value => JSON.parse(JSON.stringify(value));
  const htmlText = value => String(value).replace(/[&<>"']/g, character =>
    ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[character]);
  const localId = prefix => `${prefix}:${Date.now().toString(36)}:${
    crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  const canvas = $('#chaserCanvas'), ctx = canvas.getContext('2d');
  const reduceMotion = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : {matches:false};

  let project = C.shareableProject(Hub && Hub.get('chaser.project', null) || C.project);
  let lastSavedSignature = JSON.stringify(project);
  let saveTimer = 0, pendingSaveReason = '', paintFrame = 0, reducedPaintTimer = 0;
  let layout = null, interactionLayout = null, hoverId = null;
  let playOrigin = null, playhead = project.activeStep, currentMapLive = false;
  let sliceListSignature = '', controlsBound = false;
  let sidebarMode = 'sequences', canvasZoom = 1, canvasPanX = 0, canvasPanY = 0;
  let canvasTool = 'select', canvasGesture = null, spacePan = false, visibilityAnchor = -1;
  let altVisibilityPreview = false;
  let sequenceDrag = null, stepDrag = null, viewDrag = null, pendingLiveMap = null;
  let projectFileWriter = null, projectFileKind = 'project', fileSaveTimer = 0;
  let fileWriteQueue = Promise.resolve(), diskSignature = '', fileSaving = false;
  let documentEpoch = 0, projectSavePending = false, projectLoadRequest = 0;
  let factoryGridSelection = null, exportLogoLoadRequest = 0;
  let followResolume = false, resolumeRevision = '', resolumeChecking = false;
  let pendingResolumeMap = null;
  let envelopeGesture = null, envelopeLayout = null;
  const envelopeSelection = new Set();
  const historyPast = [], historyFuture = [];
  const stepClipboard = window.OpenLiveSessionPolicy?.shared('chaser.step-clipboard', () => ({sliceIds:null})) || {sliceIds:null};
  let stepHoldTimer = 0;
  let historyCurrent = copy(C.shareableProject(project)), historyApplying = false;

  const exportCanvas = $('#chExCanvas'), exportCtx = exportCanvas && exportCanvas.getContext('2d');
  const exportPreviewRaster = document.createElement('canvas');
  let exportOpen = false, exportBusy = false, exportFrame = 0, exportLayout = null;
  let exportSettings = E ? E.normaliseSettings(project.exportSettings, project) : null;
  let exportTarget = null, exportZoom = 1, exportOpener = null, exportFolderHandle = null;
  let exportLogoImage = null, exportLasso = null, exportLogoRevision = 0;
  const exportLogoAssets = new Map();
  if (exportSettings && exportSettings.logo && exportSettings.logo.dataUrl)
    exportLogoAssets.set(project.id, {dataUrl:exportSettings.logo.dataUrl,
      name:exportSettings.logo.name || 'Logo'});
  let exportPreviewKey = '', exportPreviewPlan = null;
  const exportSelection = new Set();

  function activeSequence() {
    return C.activeSequence(project, project.activeSequenceId) || project.sequences[0];
  }

  function activeView() {
    return C.activeView ? C.activeView(project, project.activeViewId) : null;
  }

  function visibleSliceIds() {
    return C.visibleSliceIds ? C.visibleSliceIds(project, project.activeViewId)
      : new Set(C.flatSlices(project.map).map(slice => slice.id));
  }

  function activeEnvelope() {
    return C.activeEnvelope ? C.activeEnvelope(project, project.activeEnvelopeId)
      : project.envelopes && project.envelopes[0];
  }

  function publishedLiveMap() {
    return C.liveMap || Bus && Bus.sliceTree && C.normaliseMap(Bus.sliceTree) || null;
  }

  function syncMapLinkState() {
    const live = publishedLiveMap();
    currentMapLive = !!live && C.mapSignature(project.map) === C.mapSignature(live);
    pendingLiveMap = currentMapLive ? null : live;
    return live;
  }

  function renderConnectionState(localLabel) {
    const node = $('#chConnection'); if (!node) return;
    node.textContent = currentMapLive
      ? `SHOWAVE Map live · ${C.flatSlices(project.map).length} slices`
      : pendingLiveMap ? `${localLabel || 'Local project'} · live map available to relink`
      : localLabel || 'Local Chaser project';
  }

  function activeStepIndex() {
    const sequence = activeSequence();
    return clamp(project.activeStep || 0, 0, Math.max(0, sequence.steps.length - 1));
  }

  function currentStepIndex() {
    return project.playback.playing ? playhead : activeStepIndex();
  }

  function projectSignature(value) { return JSON.stringify(value); }

  function projectContentSignature(value) {
    const comparable = copy(C.shareableProject(value));
    delete comparable.updatedAt;
    return projectSignature(comparable);
  }

  function setSaveState(state, label) {
    const node = $('#chSaveState');
    node.classList.toggle('saving', state === 'saving');
    node.classList.toggle('error', state === 'error');
    node.querySelector('span').textContent = label || (state === 'saving' ? 'Updating…'
      : projectFileWriter ? `Saved ${projectFileWriter.name}` : 'Kept for this session');
  }

  function flushPersist(reason) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = 0;
    const saveReason = reason || pendingSaveReason || 'Chaser edit';
    pendingSaveReason = '';
    try {
      /* The editor may keep playing locally, but a shared project never carries
         that window-specific flag. Store the project and its root freshness in
         one Hub commit so a stale writer in another tool cannot roll it back. */
      const saved = C.shareableProject(project);
      const root = Hub && Hub.get ? Hub.get('chaser', {}) : {};
      const savedAt = Math.max(Date.now(), Number(saved.updatedAt) || 0,
        (Number(root && root.updatedAt) || 0) + 1);
      saved.updatedAt = savedAt;
      project.updatedAt = savedAt;
      C.setProject(project);
      const previousSavedSignature = lastSavedSignature;
      lastSavedSignature = projectSignature(saved);
      try {
        if (Hub && Hub.patch) {
          Hub.patch('chaser', {schema:C.schema, project:saved, envelopes:saved.envelopes, updatedAt:savedAt}, {reason:saveReason});
        } else if (Hub && Hub.set) {
          Hub.set('chaser', Object.assign({}, root, {
            schema:C.schema, project:saved, updatedAt:savedAt
          }), {reason:saveReason});
        }
      } catch (error) {
        lastSavedSignature = previousSavedSignature;
        throw error;
      }
      setSaveState('saved');
      if (Recovery) {
        const recovered = Recovery.save({schema:'showave.chaser.document/1',
          savedAt:new Date(savedAt).toISOString(), project:saved,
          library:{envelopes:saved.envelopes}});
        if (!recovered.ok && !projectFileWriter)
          setSaveState('error', 'Recovery unavailable · Save Project');
      }
      scheduleProjectFileSave();
      return true;
    } catch (error) {
      setSaveState('error', 'Save failed');
      console.error('SHOWAVE Chaser save', error);
      return false;
    }
  }

  function persist(reason) {
    if (saveTimer) clearTimeout(saveTimer);
    pendingSaveReason = reason || pendingSaveReason || 'Chaser edit';
    setSaveState('saving');
    saveTimer = setTimeout(() => flushPersist(), 90);
  }

  function commit(reason, options) {
    project.updatedAt = Date.now();
    project = C.normaliseProject(project);
    const snapshot = copy(C.shareableProject(project));
    const navigational = /^(?:Select|Open|Chaser playback|Set Chaser (?:BPM|rate|direction)|Reset chase)/.test(reason || '');
    if (!historyApplying && !(options && options.history === false) && !navigational &&
        projectSignature(snapshot) !== projectSignature(historyCurrent)) {
      historyPast.push(historyCurrent); if (historyPast.length > 100) historyPast.shift();
      historyFuture.length = 0;
    }
    historyCurrent = snapshot;
    C.setProject(project);
    if (!(options && options.noSave)) persist(reason);
    renderAll();
  }

  function restoreHistory(snapshot, reason) {
    stopPlayback(false); historyApplying = true;
    project = C.normaliseProject(copy(snapshot)); project.updatedAt = Date.now();
    historyCurrent = copy(C.shareableProject(project)); playhead = project.activeStep;
    sliceListSignature = ''; envelopeSelection.clear();
    syncMapLinkState();
    if (E) { reconcileExportSettings(true); syncExportLogoImage(); }
    C.setProject(project); persist(reason); renderAll(); renderConnectionState(); historyApplying = false;
  }

  function undo() {
    if (!historyPast.length) return;
    historyFuture.push(copy(historyCurrent)); restoreHistory(historyPast.pop(), 'Undo Chaser edit');
  }

  function redo() {
    if (!historyFuture.length) return;
    historyPast.push(copy(historyCurrent)); restoreHistory(historyFuture.pop(), 'Redo Chaser edit');
  }

  function resetHistory() {
    historyPast.length = 0; historyFuture.length = 0;
    historyCurrent = copy(C.shareableProject(project)); renderHistoryState();
  }

  function renderHistoryState() {
    const undoButton = $('#chUndo'), redoButton = $('#chRedo');
    if (undoButton) undoButton.disabled = !historyPast.length;
    if (redoButton) redoButton.disabled = !historyFuture.length;
    document.querySelectorAll('[data-action="undo"]').forEach(node => { node.disabled = !historyPast.length; });
    document.querySelectorAll('[data-action="redo"]').forEach(node => { node.disabled = !historyFuture.length; });
  }

  function packedToHex(value) {
    const number = Number(value) >>> 0;
    return '#' + ((number >>> 16) & 255).toString(16).padStart(2, '0')
      + ((number >>> 8) & 255).toString(16).padStart(2, '0')
      + (number & 255).toString(16).padStart(2, '0');
  }

  function hexToPacked(value) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(value || ''));
    return match ? (0xff000000 | parseInt(match[1], 16)) >>> 0 : 0xff000000;
  }

  function setField(selector, value) {
    const node = $(selector);
    if (!node || document.activeElement === node) return;
    if (node.type === 'checkbox') node.checked = !!value;
    else node.value = value;
  }

  function stopPlayback(commitStep) {
    if (reducedPaintTimer) clearTimeout(reducedPaintTimer);
    reducedPaintTimer = 0;
    if (!project.playback.playing) return;
    project.playback.playing = false;
    if (commitStep) project.activeStep = playhead;
    playOrigin = null;
    $('#chPlay').classList.add('on');
    $('#chPlay').setAttribute('aria-pressed', 'false');
    $('#chPlay').setAttribute('aria-label', 'Play chase');
    $('#chPlay').innerHTML = '&#9654;';
  }

  function startPlayback() {
    const sequence = activeSequence();
    if (!sequence.steps.length) return;
    const startingStep = project.playback.playing
      ? clamp(playhead,0,sequence.steps.length - 1) : activeStepIndex();
    project.playback.playing = true;
    playhead = startingStep;
    playOrigin = {at:performance.now(), raw:project.playback.direction === 'Reverse'
      ? sequence.steps.length - 1 - playhead : playhead};
    $('#chPlay').classList.remove('on');
    $('#chPlay').setAttribute('aria-pressed', 'true');
    $('#chPlay').setAttribute('aria-label', 'Pause chase');
    $('#chPlay').innerHTML = '&#10074;&#10074;';
    requestPaint();
  }

  function togglePlayback() {
    if (project.playback.playing) stopPlayback(true);
    else startPlayback();
    commit('Chaser playback', {noSave:false});
  }

  function updatePlayhead(now) {
    if (!project.playback.playing || !playOrigin) return false;
    const sequence = activeSequence(), rate = C.stepRates[project.playback.stepsPerBeat] || 1;
    const steps = (now - playOrigin.at) / 60000 * project.playback.bpm * rate;
    const next = C.directedStep(playOrigin.raw + steps, sequence.steps.length, project.playback.direction);
    const changed = next !== playhead;
    playhead = next;
    return changed;
  }

  function setStep(index, reason) {
    stopPlayback(false);
    const sequence = activeSequence();
    project.activeStep = clamp(Math.round(index), 0, sequence.steps.length - 1);
    playhead = project.activeStep;
    commit(reason || 'Select chase step');
    requestAnimationFrame(() => {
      const button = $(`#chSteps [data-step="${project.activeStep}"]`);
      if (button) button.scrollIntoView({block:'nearest', inline:'nearest'});
    });
  }

  function selectSequence(id, reason) {
    stopPlayback(false);
    const found = project.sequences.find(sequence => sequence.id === id);
    if (!found) return;
    project.activeSequenceId = found.id;
    project.activeStep = clamp(project.activeStep, 0, found.steps.length - 1);
    playhead = project.activeStep;
    sliceListSignature = '';
    commit(reason || 'Select sequence');
  }

  function addSequence(duplicate) {
    const source = duplicate ? activeSequence() : null;
    const index = project.sequences.length;
    const sequence = source ? copy(source) : {
      name:`Sequence ${index + 1}`,
      steps:Array.from({length:16}, () => ({sliceIds:[]})),
      factory:copy(activeSequence().factory || {direction:'Horizontal', flipX:false, flipY:false,
        mirrorX:false, mirrorY:false, block:1, modulo:0})
    };
    sequence.id = localId('sequence');
    sequence.name = source ? `${source.name} Copy` : sequence.name;
    project.sequences.push(sequence);
    project.activeSequenceId = sequence.id; project.activeStep = 0; playhead = 0;
    sliceListSignature = '';
    commit(duplicate ? 'Duplicate sequence' : 'Add sequence');
  }

  function removeSequence() {
    if (project.sequences.length === 1) {
      activeSequence().steps.forEach(step => { step.sliceIds = []; });
      commit('Clear last sequence'); return;
    }
    const index = project.sequences.findIndex(sequence => sequence.id === project.activeSequenceId);
    project.sequences.splice(index, 1);
    const next = project.sequences[Math.min(index, project.sequences.length - 1)];
    project.activeSequenceId = next.id; project.activeStep = 0; playhead = 0;
    sliceListSignature = '';
    commit('Remove sequence');
  }

  function resizeSteps(value) {
    const sequence = activeSequence(), count = clamp(Math.round(Number(value) || 1), 1, 1024);
    while (sequence.steps.length < count) sequence.steps.push({sliceIds:[]});
    if (sequence.steps.length > count) sequence.steps.length = count;
    project.activeStep = clamp(project.activeStep, 0, count - 1); playhead = project.activeStep;
    sliceListSignature = '';
    commit('Resize sequence');
  }

  function clearSequence() {
    activeSequence().steps.forEach(step => { step.sliceIds = []; });
    sliceListSignature = ''; commit('Clear sequence');
  }

  function filledPrefix(sequence) {
    let last = -1;
    sequence.steps.forEach((step, index) => { if (step.sliceIds.length) last = index; });
    return last >= 0 ? sequence.steps.slice(0, last + 1).map(step => copy(step)) : [];
  }

  function fillSequence(bounce) {
    const sequence = activeSequence(), seed = filledPrefix(sequence);
    if (!seed.length) return;
    const pattern = bounce && seed.length > 1
      ? seed.concat(seed.slice(1, -1).reverse().map(step => copy(step))) : seed;
    sequence.steps = sequence.steps.map((step, index) => copy(pattern[index % pattern.length]));
    sliceListSignature = ''; commit(bounce ? 'Fill sequence ping-pong' : 'Fill sequence');
  }

  function moveSequence(sourceId, targetId, duplicate) {
    const sourceIndex = project.sequences.findIndex(item => item.id === sourceId);
    const targetIndex = project.sequences.findIndex(item => item.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceId === targetId && !duplicate) return;
    let moved;
    if (duplicate) {
      moved = copy(project.sequences[sourceIndex]); moved.id = localId('sequence');
      moved.name = `${moved.name} Copy`;
    } else moved = project.sequences.splice(sourceIndex, 1)[0];
    /* The drop target is the visual row the item should precede after removal.
       Keeping its original index makes adjacent downward moves meaningful. */
    project.sequences.splice(Math.max(0, targetIndex), 0, moved);
    project.activeSequenceId = moved.id; project.activeStep = 0; playhead = 0;
    sliceListSignature = ''; commit(duplicate ? 'Duplicate and reorder sequence' : 'Reorder sequence');
  }

  function copyStep(sourceIndex, targetIndex, multicopy) {
    const sequence = activeSequence();
    if (sourceIndex < 0 || sourceIndex >= sequence.steps.length || targetIndex < 0 ||
        targetIndex >= sequence.steps.length || sourceIndex === targetIndex) return;
    const source = copy(sequence.steps[sourceIndex]);
    if (multicopy) {
      const interval = Math.abs(targetIndex - sourceIndex);
      if (!interval) return;
      const direction = targetIndex > sourceIndex ? 1 : -1;
      for (let index = targetIndex; index >= 0 && index < sequence.steps.length; index += interval * direction)
        sequence.steps[index] = copy(source);
    } else sequence.steps[targetIndex] = source;
    project.activeStep = targetIndex; playhead = targetIndex; sliceListSignature = '';
    commit(multicopy ? 'Multicopy chase step' : 'Copy chase step');
  }

  function copyCurrentStep() {
    stopPlayback(true); stepClipboard.sliceIds = [...activeSequence().steps[activeStepIndex()].sliceIds];
    setSaveState('saved', `Copied step ${activeStepIndex() + 1}`);
  }

  function pasteCurrentStep() {
    if (!stepClipboard.sliceIds) { setSaveState('error', 'Copy a step first'); return; }
    stopPlayback(true);
    const available = new Set(C.flatSlices(project.map).map(slice => slice.id));
    activeSequence().steps[activeStepIndex()].sliceIds = stepClipboard.sliceIds.filter(id => available.has(id));
    sliceListSignature = ''; commit('Paste chase step');
  }

  function invertCurrentStep() {
    stopPlayback(true);
    const step = activeSequence().steps[activeStepIndex()], ids = new Set(step.sliceIds);
    visibleSliceIds().forEach(id => { if (ids.has(id)) ids.delete(id); else ids.add(id); });
    step.sliceIds = [...ids]; sliceListSignature = ''; commit('Invert chase step');
  }

  function clearCurrentStep() {
    stopPlayback(true); activeSequence().steps[activeStepIndex()].sliceIds = [];
    sliceListSignature = ''; commit('Clear chase step');
  }

  function clearStepHold() { if (stepHoldTimer) clearTimeout(stepHoldTimer); stepHoldTimer = 0; }

  function shuffleSequence() {
    const sequence = activeSequence();
    sequence.factory.seed = (Number(sequence.factory.seed) || 1) + 1;
    sequence.steps = C.shuffleSteps ? C.shuffleSteps(sequence.steps, sequence.factory.seed) :
      sequence.steps.map(step => copy(step)).sort(() => Math.random() - .5);
    sliceListSignature = ''; commit('Shuffle chase steps');
  }

  function selectView(id, reason) {
    const found = (project.views || []).find(view => view.id === id);
    if (!found) return;
    project.activeViewId = found.id; visibilityAnchor = -1; canvasGesture = null;
    activeSequence().viewId = activeSequence().viewId || found.id;
    commit(reason || 'Select View', {history:false});
  }

  function addView(duplicate, blank) {
    const source = activeView(), visible = blank ? [] : source
      ? (source.visibleSliceIds || []).slice() : [...visibleSliceIds()];
    const view = {
      id:localId('view'), name:duplicate && source ? `${source.name} Copy` : `View ${(project.views || []).length}`,
      builtin:false, visibleSliceIds:visible
    };
    project.views.push(view); project.activeViewId = view.id; sidebarMode = 'views';
    commit(duplicate ? 'Duplicate View' : blank ? 'Add empty View' : 'Add View');
  }

  function removeView() {
    const view = activeView();
    if (!view || view.id === 'view:all' || view.builtin) return;
    const index = project.views.findIndex(item => item.id === view.id);
    project.views.splice(index, 1); project.activeViewId = project.views[Math.max(0, index - 1)].id;
    project.sequences.forEach(sequence => {
      if (sequence.viewId === view.id) sequence.viewId = project.activeViewId;
    });
    visibilityAnchor = -1; commit('Remove View');
  }

  function moveView(sourceId, targetId) {
    const sourceIndex = project.views.findIndex(view => view.id === sourceId);
    const targetIndex = project.views.findIndex(view => view.id === targetId);
    if (sourceIndex <= 0 || targetIndex <= 0 || sourceIndex === targetIndex) return;
    const moved = project.views.splice(sourceIndex, 1)[0];
    project.views.splice(targetIndex, 0, moved);
    project.activeViewId = moved.id; commit('Reorder Views');
  }

  function setViewVisibility(ids, mode, reason, deferCommit) {
    const view = activeView(); if (!view) return false;
    const visible = new Set(view.visibleSliceIds || []); let changed = false;
    (ids || []).forEach(id => {
      const next = mode === 'on' ? true : mode === 'off' ? false : !visible.has(id);
      if (next && !visible.has(id)) { visible.add(id); changed = true; }
      if (!next && visible.delete(id)) changed = true;
    });
    if (!changed) return false;
    view.visibleSliceIds = [...visible]; sliceListSignature = '';
    if (!deferCommit) commit(reason || 'Edit View visibility');
    else { renderViews(); renderInspector(); requestPaint(); }
    return true;
  }

  function setAllViewVisibility(visible) {
    const ids = C.flatSlices(project.map).map(slice => slice.id), view = activeView();
    if (!view) return;
    view.visibleSliceIds = visible ? ids : []; visibilityAnchor = -1;
    sliceListSignature = ''; commit(visible ? 'Show all slices in View' : 'Hide all slices in View');
  }

  function factorySettingsFromControls() {
    const sequence = activeSequence(), factory = Object.assign({}, sequence.factory || {});
    const value = (selector, fallback) => {
      const node = $(selector); return node ? node.value : fallback;
    };
    factory.direction = value('#chFactoryDirection', factory.direction || 'Horizontal');
    factory.columns = Number(value('#chFactoryColumns', factory.columns || 0)) || 0;
    factory.rows = Number(value('#chFactoryRows', factory.rows || 0)) || 0;
    factory.block = Number(value('#chFactoryBlock', factory.block || 1)) || 1;
    factory.modulo = Number(value('#chFactoryModulo', factory.modulo || 0)) || 0;
    for (const [selector, key] of [['#chFactoryFlipX','flipX'],['#chFactoryFlipY','flipY'],
      ['#chFactoryMirrorX','mirrorX'],['#chFactoryMirrorY','mirrorY']]) {
      const node = $(selector); if (node) factory[key] = node.checked;
    }
    return factory;
  }

  function generateFactory(reason) {
    if (!C.factoryPattern) return;
    const sequence = activeSequence(), ids = [...visibleSliceIds()];
    if (!ids.length) {
      const status = $('#chFactoryStatus'); if (status) status.textContent = 'This View has no visible slices';
      return;
    }
    const result = C.factoryPattern(project.map, ids, factorySettingsFromControls());
    if (!result || !result.steps || !result.steps.length) return;
    sequence.steps = result.steps.map(step => ({sliceIds:[...new Set(step.sliceIds || step)]}));
    sequence.factory = result.settings || factorySettingsFromControls();
    sequence.viewId = project.activeViewId; project.activeStep = 0; playhead = 0;
    sliceListSignature = ''; commit(reason || 'Generate Factory chase');
    const status = $('#chFactoryStatus');
    if (status) status.textContent = `${result.columns} × ${result.rows} grid · ${sequence.steps.length} steps`;
  }

  function resetFactory() {
    const factory = activeSequence().factory;
    factory.rows = 0; factory.columns = 0; factory.gridX = []; factory.gridY = [];
    factory.gridXEdited = false; factory.gridYEdited = false; factoryGridSelection = null;
    renderFactoryInspector(); generateFactory('Reset Factory grid');
  }

  function defaultEnvelope(name) {
    return {id:localId('envelope'), name:name || 'Envelope', points:[
      {id:localId('anchor'), x:0, y:0, inX:0, inY:0, outX:.3, outY:0, linear:false},
      {id:localId('anchor'), x:1, y:1, inX:.7, inY:1, outX:1, outY:1, linear:false}
    ]};
  }

  function selectEnvelope(id) {
    if (!(project.envelopes || []).some(envelope => envelope.id === id)) return;
    project.activeEnvelopeId = id; envelopeSelection.clear();
    commit('Select Envelope', {history:false});
  }

  function addEnvelope(duplicate) {
    const source = duplicate ? activeEnvelope() : null;
    const envelope = source ? copy(source) : defaultEnvelope(`Envelope ${(project.envelopes || []).length + 1}`);
    envelope.id = localId('envelope'); envelope.name = source ? `${source.name} Copy` : envelope.name;
    envelope.points.forEach(point => { point.id = localId('anchor'); });
    project.envelopes.push(envelope); project.activeEnvelopeId = envelope.id;
    envelopeSelection.clear(); sidebarMode = 'envelopes'; project.mode = 'envelope';
    commit(duplicate ? 'Duplicate Envelope' : 'Add Envelope');
  }

  function removeEnvelope() {
    if (project.envelopes.length <= 1) { resetEnvelope(); return; }
    const index = project.envelopes.findIndex(envelope => envelope.id === project.activeEnvelopeId);
    project.envelopes.splice(index, 1);
    project.activeEnvelopeId = project.envelopes[Math.min(index, project.envelopes.length - 1)].id;
    envelopeSelection.clear(); commit('Remove Envelope');
  }

  function resetEnvelope() {
    const envelope = activeEnvelope(), replacement = defaultEnvelope(envelope ? envelope.name : 'Envelope');
    if (!envelope) return;
    envelope.points = replacement.points; envelopeSelection.clear(); commit('Reset Envelope');
  }

  function toggleSlice(id) {
    if (project.mode !== 'chase') return;
    stopPlayback(true);
    const step = activeSequence().steps[activeStepIndex()];
    const index = step.sliceIds.indexOf(id);
    if (index >= 0) step.sliceIds.splice(index, 1); else step.sliceIds.push(id);
    sliceListSignature = ''; commit('Toggle slice in step');
  }

  function setMode(mode) {
    stopPlayback(false);
    project.mode = mode === 'pixelmap' ? 'pixelmap' : mode === 'envelope' ? 'envelope' : 'chase';
    if (project.mode === 'envelope') sidebarMode = 'envelopes';
    else if (sidebarMode === 'envelopes') sidebarMode = 'sequences';
    canvasGesture = null; envelopeGesture = null;
    commit(project.mode === 'pixelmap' ? 'Open Pixel Map' : project.mode === 'envelope'
      ? 'Open Envelopes' : 'Open Chaser');
  }

  function setSidebarMode(mode) {
    sidebarMode = ['sequences','views','envelopes'].includes(mode) ? mode : 'sequences';
    if (sidebarMode === 'envelopes' && project.mode !== 'envelope') project.mode = 'envelope';
    else if (sidebarMode !== 'envelopes' && project.mode === 'envelope') project.mode = 'chase';
    renderAll();
  }

  function renderSequenceList() {
    const root = $('#chSequenceList'); root.innerHTML = '';
    project.sequences.forEach((sequence, index) => {
      const row = document.createElement('div'); row.tabIndex = 0; row.draggable = true;
      row.className = 'ch-sequence-row' + (sequence.id === project.activeSequenceId ? ' on' : '');
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(sequence.id === project.activeSequenceId));
      row.innerHTML = `<span class="grip" aria-hidden="true">&#8942;&#8942;</span><span class="seq-name"></span><span class="seq-steps"></span>`;
      row.querySelector('.seq-name').textContent = sequence.name;
      row.querySelector('.seq-steps').textContent = sequence.steps.length;
      row.title = `Sequence ${index + 1} · ${sequence.steps.length} steps`;
      row.addEventListener('click', event => { if (!event.target.isContentEditable) selectSequence(sequence.id); });
      row.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.isContentEditable) {
          event.preventDefault(); selectSequence(sequence.id);
        }
      });
      const nameNode = row.querySelector('.seq-name');
      nameNode.addEventListener('dblclick', event => {
        event.stopPropagation(); nameNode.contentEditable = 'true'; nameNode.focus();
        const range = document.createRange(); range.selectNodeContents(nameNode);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      nameNode.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); nameNode.blur(); }
        if (event.key === 'Escape') { nameNode.textContent = sequence.name; nameNode.blur(); }
      });
      nameNode.addEventListener('blur', () => {
        if (nameNode.contentEditable !== 'true') return;
        nameNode.contentEditable = 'false';
        const next = nameNode.textContent.trim() || sequence.name;
        if (next !== sequence.name) { sequence.name = next; commit('Rename sequence inline'); }
      });
      row.addEventListener('dragstart', event => {
        sequenceDrag = {id:sequence.id, duplicate:event.altKey}; row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('text/plain', sequence.id);
      });
      row.addEventListener('dragover', event => {
        if (!sequenceDrag) return; event.preventDefault(); row.classList.add('drop-target');
        event.dataTransfer.dropEffect = event.altKey || sequenceDrag.duplicate ? 'copy' : 'move';
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', event => {
        if (!sequenceDrag) return; event.preventDefault(); row.classList.remove('drop-target');
        moveSequence(sequenceDrag.id, sequence.id, event.altKey || sequenceDrag.duplicate); sequenceDrag = null;
      });
      row.addEventListener('dragend', () => { sequenceDrag = null; row.classList.remove('dragging','drop-target'); });
      root.appendChild(row);
    });
    $('#chSequenceCount').textContent = project.sequences.length;
    const index = $('#chSequenceIndex');
    if (index && document.activeElement !== index) {
      index.max = project.sequences.length; index.value = project.sequences.findIndex(item => item.id === project.activeSequenceId) + 1;
    }
  }

  function renderSteps() {
    const root = $('#chSteps'), sequence = activeSequence(); root.innerHTML = '';
    sequence.steps.forEach((step, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ch-step' + (index === activeStepIndex() ? ' on' : '')
        + (project.playback.playing && index === playhead ? ' playhead' : '');
      button.dataset.step = index; button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === activeStepIndex()));
      button.setAttribute('aria-label', `Step ${index + 1}, ${step.sliceIds.length} active slices`);
      button.innerHTML = `<b>${index + 1}</b><small>${step.sliceIds.length} slice${step.sliceIds.length === 1 ? '' : 's'}</small>`;
      button.addEventListener('click', () => setStep(index));
      button.draggable = true;
      button.addEventListener('dragstart', event => {
        clearStepHold(); stepDrag = {index, multicopy:event.altKey, target:null}; button.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain', String(index));
        const hint = $('#chStepCopyHint'); if (hint) hint.textContent = 'Drop to copy · hold over a step to repeat at that interval';
      });
      button.addEventListener('dragover', event => {
        if (!stepDrag) return; event.preventDefault(); button.classList.add('drop-target');
        event.dataTransfer.dropEffect = 'copy';
        if (stepDrag.target !== index) {
          clearStepHold(); stepDrag.target = index; stepDrag.held = false;
          const drag = stepDrag;
          stepHoldTimer = setTimeout(() => {
            if (stepDrag !== drag || drag.target !== index || drag.index === index) return;
            drag.held = true;
            const hint = $('#chStepCopyHint'); if (hint)
              hint.textContent = `Release to copy every ${Math.abs(index - drag.index)} steps`;
          }, 600);
        }
      });
      button.addEventListener('dragleave', event => {
        if (event.relatedTarget && button.contains(event.relatedTarget)) return;
        button.classList.remove('drop-target'); clearStepHold();
        if (stepDrag?.target === index) { stepDrag.target = null; stepDrag.held = false; }
      });
      button.addEventListener('drop', event => {
        if (!stepDrag) return; event.preventDefault(); button.classList.remove('drop-target');
        clearStepHold(); copyStep(stepDrag.index, index, event.altKey || stepDrag.multicopy || stepDrag.held); stepDrag = null;
      });
      button.addEventListener('dragend', () => {
        clearStepHold(); stepDrag = null; button.classList.remove('dragging','drop-target');
        const hint = $('#chStepCopyHint'); if (hint) hint.textContent = 'Drag a step to copy · hold Alt to repeat every interval';
      });
      root.appendChild(button);
    });
  }

  let visibilityRangeAnchor = null;

  function moveOrDuplicateView(sourceId,targetId,duplicate) {
    if (!duplicate) { moveView(sourceId,targetId); return; }
    const source = project.views.find(view => view.id === sourceId);
    const targetIndex = project.views.findIndex(view => view.id === targetId);
    if (!source || source.builtin || source.id === 'view:all' || targetIndex <= 0 || project.views.length >= 512) return;
    const view = copy(source); view.id = localId('view'); view.name = `${source.name} Copy`;
    project.views.splice(targetIndex,0,view); project.activeViewId = view.id;
    visibilityAnchor = -1; commit('Duplicate and reorder View');
  }

  function applyVisibilityRowRange(rows, rowIndex, event) {
    const row = rows[rowIndex], view = activeView();
    if (!row || !view || !row.ids.length) return;
    const visible = new Set(view.visibleSliceIds || []);
    const desired = row.ids.every(id => visible.has(id)) ? 'off' : 'on';
    const anchorRow = rows[visibilityAnchor];
    const hasAnchor = visibilityAnchor >= 0 && visibilityRangeAnchor && anchorRow &&
      visibilityRangeAnchor.viewId === view.id && visibilityRangeAnchor.rowKey === anchorRow.key;
    let ids = row.ids, mode = desired;
    if (event && event.shiftKey && hasAnchor) {
      const from = Math.min(visibilityAnchor, rowIndex), to = Math.max(visibilityAnchor, rowIndex);
      ids = [...new Set(rows.slice(from,to + 1).flatMap(item => item.ids))];
      mode = visibilityRangeAnchor.mode;
    } else {
      visibilityAnchor = rowIndex;
      visibilityRangeAnchor = {viewId:view.id,rowKey:row.key,mode:desired};
    }
    setViewVisibility(ids,mode,event && event.shiftKey && hasAnchor
      ? 'Edit View visibility range' : 'Edit View visibility');
  }

  function renderViews() {
    const list = $('#chViewList'), tree = $('#chVisibilityTree');
    if (!list || !tree) return;
    list.innerHTML = '';
    (project.views || []).forEach(view => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ch-view-row' + (view.id === project.activeViewId ? ' on' : '');
      button.setAttribute('role','option'); button.setAttribute('aria-selected', String(view.id === project.activeViewId));
      const count = (view.visibleSliceIds || []).length;
      button.innerHTML = '<span class="view-icon" aria-hidden="true">◉</span><span class="view-name"></span><span class="view-count"></span>';
      button.querySelector('.view-name').textContent = view.name;
      button.querySelector('.view-count').textContent = count;
      button.addEventListener('click', () => selectView(view.id));
      if (!view.builtin && view.id !== 'view:all') {
        button.draggable = true;
        const nameNode = button.querySelector('.view-name');
        nameNode.addEventListener('dblclick', event => {
          event.preventDefault(); event.stopPropagation(); nameNode.contentEditable = 'true'; nameNode.focus();
          const range = document.createRange(); range.selectNodeContents(nameNode);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        nameNode.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); nameNode.blur(); }
          if (event.key === 'Escape') { nameNode.textContent = view.name; nameNode.blur(); }
        });
        nameNode.addEventListener('blur', () => {
          if (nameNode.contentEditable !== 'true') return;
          nameNode.contentEditable = 'false'; const next = nameNode.textContent.trim() || view.name;
          if (next !== view.name) { view.name = next; commit('Rename View'); }
        });
        button.addEventListener('dragstart', event => {
          viewDrag = {id:view.id,duplicate:event.altKey}; button.classList.add('dragging'); event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', view.id);
        });
        button.addEventListener('dragover', event => {
          if (!viewDrag || viewDrag.id === view.id && !(event.altKey || viewDrag.duplicate)) return;
          event.preventDefault(); button.classList.add('drop-target');
          event.dataTransfer.dropEffect = event.altKey || viewDrag.duplicate ? 'copy' : 'move';
        });
        button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
        button.addEventListener('drop', event => {
          if (!viewDrag) return; event.preventDefault(); button.classList.remove('drop-target');
          moveOrDuplicateView(viewDrag.id,view.id,event.altKey || viewDrag.duplicate); viewDrag = null;
        });
        button.addEventListener('dragend', () => { viewDrag = null; button.classList.remove('dragging','drop-target'); });
      }
      list.appendChild(button);
    });
    const view = activeView(), protectedView = !view || view.id === 'view:all' || view.builtin;
    const remove = $('#chRemoveView'), duplicate = $('#chDuplicateView');
    if (remove) remove.disabled = protectedView;
    if (duplicate) duplicate.disabled = protectedView;
    const show = $('#chShowAllView'), hide = $('#chHideAllView');
    if (show) show.disabled = !view;
    if (hide) hide.disabled = !view;
    tree.innerHTML = '';
    const visible = visibleSliceIds(), visibilityRows = [];
    project.map.screens.forEach(screen => {
      const screenSliceIds = screen.slices.map(slice => slice.id), visibleCount = screenSliceIds.filter(id => visible.has(id)).length;
      const group = document.createElement('section'); group.className = 'ch-visibility-screen'; group.setAttribute('role','group');
      const header = document.createElement('button'); header.type = 'button'; header.disabled = !view;
      header.className = 'ch-visibility-row' + (visibleCount ? '' : ' is-hidden') +
        (visibleCount === screenSliceIds.length ? ' all-on' : visibleCount ? ' some-on' : '');
      header.setAttribute('role','treeitem'); header.setAttribute('aria-level','1');
      header.setAttribute('aria-checked', visibleCount === screenSliceIds.length ? 'true' : visibleCount ? 'mixed' : 'false');
      header.innerHTML = '<i class="eye" aria-hidden="true">◉</i><span></span><small></small>';
      header.querySelector('span').textContent = screen.name;
      header.querySelector('small').textContent = `${visibleCount}/${screenSliceIds.length}`;
      const screenRowIndex = visibilityRows.push({key:`screen:${screen.id}`,ids:screenSliceIds}) - 1;
      header.addEventListener('click', event => applyVisibilityRowRange(visibilityRows,screenRowIndex,event));
      group.appendChild(header);
      const children = document.createElement('div'); children.className = 'ch-visibility-slices';
      screen.slices.forEach(slice => {
        const button = document.createElement('button');
        button.type = 'button'; button.disabled = !view;
        button.className = 'ch-visibility-row slice' + (visible.has(slice.id) ? ' on' : ' is-hidden');
        button.setAttribute('role','treeitem'); button.setAttribute('aria-level','2');
        button.setAttribute('aria-checked', String(visible.has(slice.id)));
        button.innerHTML = '<i class="eye" aria-hidden="true">◉</i><span></span>';
        button.querySelector('span').textContent = slice.name;
        const sliceRowIndex = visibilityRows.push({key:`slice:${slice.id}`,ids:[slice.id]}) - 1;
        button.addEventListener('click', event => applyVisibilityRowRange(visibilityRows,sliceRowIndex,event));
        children.appendChild(button);
      });
      group.appendChild(children); tree.appendChild(group);
    });
    if (protectedView) {
      const note = document.createElement('p'); note.className = 'hint';
      note.textContent = 'All is permanent, but its visibility can be edited. New slices are shown here automatically.';
      tree.prepend(note);
    }
  }

  function renderEnvelopes() {
    const list = $('#chEnvelopeList'); if (!list) return;
    list.innerHTML = '';
    (project.envelopes || []).forEach((envelope, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ch-envelope-row' + (envelope.id === project.activeEnvelopeId ? ' on' : '');
      button.setAttribute('role','option'); button.setAttribute('aria-selected', String(envelope.id === project.activeEnvelopeId));
      button.innerHTML = '<span class="envelope-icon" aria-hidden="true">⌁</span><span class="envelope-name"></span><small></small>';
      button.querySelector('.envelope-name').textContent = envelope.name;
      button.querySelector('small').textContent = `${envelope.points.length} pts`;
      button.title = `Envelope ${index + 1}`; button.addEventListener('click', () => selectEnvelope(envelope.id));
      list.appendChild(button);
    });
  }

  function renderSidebar() {
    const modes = [['sequences','#chSidebarSequences','#chSequencePane'],
      ['views','#chSidebarViews','#chViewPane'],['envelopes','#chSidebarEnvelopes','#chEnvelopePane']];
    modes.forEach(([mode, tabSelector, paneSelector]) => {
      const tab = $(tabSelector), pane = $(paneSelector), active = sidebarMode === mode;
      if (tab) { tab.classList.toggle('on', active); tab.setAttribute('aria-selected', String(active)); }
      if (pane) { pane.hidden = !active; pane.classList.toggle('on', active); }
    });
    renderSequenceList(); renderViews(); renderEnvelopes();
  }

  function renderSliceList() {
    const step = activeSequence().steps[activeStepIndex()], allSlices = C.flatSlices(project.map), visible = visibleSliceIds();
    const slices = allSlices.filter(slice => visible.has(slice.id));
    const signature = JSON.stringify([project.activeSequenceId, project.activeViewId, activeStepIndex(),
      step.sliceIds, allSlices.map(slice => slice.id), [...visible]]);
    if (signature === sliceListSignature) return;
    sliceListSignature = signature;
    const root = $('#chSliceList'); root.innerHTML = '';
    slices.slice(0, 512).forEach(slice => {
      const active = step.sliceIds.includes(slice.id), button = document.createElement('button');
      button.type = 'button'; button.className = 'ch-slice-toggle' + (active ? ' on' : '');
      button.setAttribute('aria-pressed', String(active));
      button.innerHTML = '<i aria-hidden="true"></i><span></span>';
      button.querySelector('span').textContent = `${slice.screenName} · ${slice.name}`;
      button.addEventListener('click', () => toggleSlice(slice.id));
      root.appendChild(button);
    });
    if (slices.length > 512) {
      const note = document.createElement('div'); note.className = 'hint';
      note.textContent = `${slices.length - 512} more slices remain editable on the canvas.`; root.appendChild(note);
    }
    const hiddenActive = step.sliceIds.filter(id => !visible.has(id)).length;
    if (hiddenActive) {
      const note = document.createElement('div'); note.className = 'hint warning';
      note.textContent = `${hiddenActive} active slice${hiddenActive === 1 ? '' : 's'} hidden by ${activeView().name}; the chase remains unchanged.`;
      root.prepend(note);
    }
  }

  function renderFactoryInspector() {
    const section = $('#chFactorySection'); if (!section) return;
    const sequence = activeSequence(), factory = sequence.factory || {};
    setField('#chFactoryDirection', factory.direction || 'Horizontal');
    setField('#chFactoryColumns', factory.columns || 0);
    setField('#chFactoryRows', factory.rows || 0);
    setField('#chFactoryBlock', factory.block || 1);
    setField('#chFactoryModulo', factory.modulo || 0);
    setField('#chFactoryFlipX', factory.flipX);
    setField('#chFactoryFlipY', factory.flipY);
    setField('#chFactoryMirrorX', factory.mirrorX);
    setField('#chFactoryMirrorY', factory.mirrorY);
    const view = (project.views || []).find(item => item.id === sequence.viewId);
    const status = $('#chFactoryStatus');
    if (status && !status.dataset.transient)
      status.textContent = `${visibleSliceIds().size} visible slices · ${view ? view.name : activeView() ? activeView().name : 'All'} View`;
  }

  function selectedEnvelopePoints() {
    const envelope = activeEnvelope();
    return envelope ? envelope.points.filter(point => envelopeSelection.has(point.id)) : [];
  }

  function renderEnvelopeInspector() {
    const envelope = activeEnvelope(); if (!envelope) return;
    setField('#chEnvelopeName', envelope.name);
    const selected = selectedEnvelopePoints(), single = selected.length === 1 ? selected[0] : null;
    const x = $('#chEnvelopePointX'), y = $('#chEnvelopePointY'), linear = $('#chEnvelopeSegmentLinear');
    const ordered = envelope.points.slice().sort((a,b) => a.x - b.x);
    const endpoint = single && (single === ordered[0] || single === ordered[ordered.length - 1]);
    if (x) { x.disabled = !single || endpoint; if (single && document.activeElement !== x) x.value = Number(single.x).toFixed(3); }
    if (y) { y.disabled = !single; if (single && document.activeElement !== y) y.value = Number(single.y).toFixed(3); }
    if (linear) {
      linear.disabled = !selected.length;
      linear.classList.toggle('on', !!selected.length && selected.every(point => point.linear));
      linear.textContent = selected.length && selected.every(point => point.linear) ? 'Make Bezier' : 'Make Linear';
    }
    const info = $('#chEnvelopeSelectionInfo');
    if (info) info.textContent = !selected.length ? 'No anchor selected' : selected.length === 1
      ? `Anchor · ${Number(single.x).toFixed(3)}, ${Number(single.y).toFixed(3)}` : `${selected.length} anchors selected`;
  }

  function renderWorkspace() {
    const root = $('#chaserRoot'), envelopeMode = project.mode === 'envelope';
    if (root) {
      root.dataset.mode = project.mode; root.classList.toggle('mode-envelope', envelopeMode);
      root.classList.toggle('ch-envelope-mode', envelopeMode);
    }
    const modeControls = [['#chModeChase','chase'],['#chModeMap','pixelmap'],['#chModeEnvelope','envelope']];
    modeControls.forEach(([selector, mode]) => {
      const node = $(selector); if (!node) return;
      const on = project.mode === mode; node.classList.toggle('on', on); node.setAttribute('aria-pressed', String(on));
    });
    const factoryToggle = $('#chFactoryToggle');
    if (factoryToggle && root) root.classList.toggle('factory-open', factoryToggle.getAttribute('aria-pressed') === 'true');
    const select = $('#chToolSelect'), pan = $('#chToolPan');
    if (select) { select.classList.toggle('on', canvasTool === 'select'); select.setAttribute('aria-pressed', String(canvasTool === 'select')); }
    if (pan) { pan.classList.toggle('on', canvasTool === 'pan'); pan.setAttribute('aria-pressed', String(canvasTool === 'pan')); }
    const zoomValue = $('#chZoomValue');
    if (zoomValue && zoomValue.dataset.editing !== 'true') zoomValue.textContent = `${Math.round(canvasZoom * 100)}%`;
    const view = activeView(), badge = $('#chActiveViewBadge');
    if (badge) {
      badge.textContent = `View: ${view ? view.name : 'All'}`;
      const authored = activeSequence().viewId && activeSequence().viewId !== project.activeViewId;
      badge.classList.toggle('warning', !!authored);
      badge.title = authored ? 'This sequence was generated from another View; changing editor visibility does not alter its chase.' : 'Active editor visibility View';
    }
    const hint = $('#chGestureHint');
    if (hint) hint.textContent = envelopeMode
      ? 'Double-click to add · drag anchors and handles · Shift constrains · Alt unlinks tangents'
      : factoryIsOpen() ? 'Generate a grid, then drag its yellow boundaries to reshape the Factory pattern'
      : project.mode === 'pixelmap' ? 'Use the hand tool or hold Space to pan · wheel to zoom'
      : 'Drag to toggle · Shift enables · Ctrl disables · Alt changes View visibility';
    renderHistoryState(); renderFactoryInspector(); renderEnvelopeInspector();
  }

  function renderInspector() {
    const sequence = activeSequence(), step = sequence.steps[activeStepIndex()];
    const slices = C.flatSlices(project.map), composition = project.map.composition;
    const mapName = project.map.screens.map(screen => screen.name).join(', ') || 'Checkered starter map';
    $('#chDocumentName').textContent = project.name;
    $('#chMapName').textContent = currentMapLive ? 'Live SHOWAVE Map' : project.map.source || 'Local Input Map';
    $('#chMapSummary').textContent = `${project.map.screens.length} screen${project.map.screens.length === 1 ? '' : 's'} · ${slices.length} slices · ${composition.width} × ${composition.height}`;
    $('#chInspectorMap').textContent = mapName;
    $('#chInspectorSlices').textContent = slices.length;
    $('#chInspectorStep').textContent = `${activeStepIndex() + 1} / ${sequence.steps.length}`;
    $('#chInspectorEnabled').textContent = `${step.sliceIds.length} slice${step.sliceIds.length === 1 ? '' : 's'}`;
    $('#chCanvasResolution').textContent = project.mode === 'envelope'
      ? '0–1 time · 0–1 value' : `${composition.width} × ${composition.height} Input Map`;
    $('#chCanvasSelection').textContent = project.mode === 'envelope'
      ? `${activeEnvelope().points.length} anchor${activeEnvelope().points.length === 1 ? '' : 's'}`
      : `${step.sliceIds.length} slice${step.sliceIds.length === 1 ? '' : 's'} active`;
    $('#chCanvasMode').textContent = project.mode === 'pixelmap' ? 'Pixel Map preview' : project.mode === 'envelope' ? 'Envelope editor' : 'Chase editor';
    $('#chCanvasMode').classList.toggle('active', true);
    $('#chStageBadge').innerHTML = project.mode === 'pixelmap'
      ? '<strong>Pixel Map</strong> · Checkered raster aligned to the Input Map'
      : project.mode === 'envelope' ? `<strong>${htmlText(activeEnvelope().name)}</strong> · reusable animation curve`
      : `<strong>Step ${currentStepIndex() + 1}</strong> · drag across slices to paint them`;
    setField('#chProjectName', project.name);
    setField('#chSequenceName', sequence.name);
    setField('#chStepCount', sequence.steps.length);
    setField('#chBpm', project.playback.bpm);
    setField('#chRate', project.playback.stepsPerBeat);
    setField('#chDirection', project.playback.direction);
    setField('#chNumX', project.pixelMap.numX);
    setField('#chNumY', project.pixelMap.numY);
    setField('#chColor1', packedToHex(project.pixelMap.color1));
    setField('#chColor2', packedToHex(project.pixelMap.color2));
    setField('#chGridColor', packedToHex(project.pixelMap.gridColor));
    setField('#chShowLabels', project.pixelMap.showLabels);
    setField('#chTransparent', project.pixelMap.transparent);
    renderSliceList();
  }

  function activeLevels() {
    const sequence = activeSequence(), index = currentStepIndex();
    return C.stepLevels(sequence, index, 'Forward', 1, 1);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const density = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * density));
    const height = Math.max(1, Math.round(rect.height * density));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  }

  function envelopeCanvasPoint(point, graph) {
    return {x:graph.x + clamp(Number(point.x) || 0, 0, 1) * graph.w,
      y:graph.y + (1 - clamp(Number(point.y) || 0, 0, 1)) * graph.h};
  }

  function factoryIsOpen() {
    const button = $('#chFactoryToggle');
    return !!button && button.getAttribute('aria-pressed') === 'true' && project.mode === 'chase';
  }

  function paintFactoryGrid() {
    if (!factoryIsOpen() || !layout) return;
    const factory = activeSequence().factory || {}, density = Math.min(2, devicePixelRatio || 1);
    const top = layout.offsetY, bottom = layout.offsetY + layout.map.composition.height * layout.scale;
    const left = layout.offsetX, right = layout.offsetX + layout.map.composition.width * layout.scale;
    ctx.save(); ctx.lineWidth = 1.2 * density; ctx.setLineDash([5*density,4*density]);
    ctx.strokeStyle = 'rgba(255,184,46,.9)'; ctx.fillStyle = '#ffb82e';
    (factory.gridX || []).forEach((value, index) => {
      const x = layout.offsetX + value * layout.scale; ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x-5*density,top); ctx.lineTo(x+5*density,top); ctx.lineTo(x,top+7*density); ctx.closePath(); ctx.fill();
      ctx.fillText(String(index+1),x+6*density,top+12*density);
    });
    (factory.gridY || []).forEach((value, index) => {
      const y = layout.offsetY + value * layout.scale; ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(right,y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left,y-5*density); ctx.lineTo(left,y+5*density); ctx.lineTo(left+7*density,y); ctx.closePath(); ctx.fill();
      ctx.fillText(String(index+1),left+10*density,y-6*density);
    });
    ctx.restore();
  }

  function paintEnvelope() {
    const density = Math.min(2, devicePixelRatio || 1), envelope = activeEnvelope();
    const graph = {x:64 * density, y:52 * density,
      w:Math.max(20, canvas.width - 104 * density), h:Math.max(20, canvas.height - 100 * density)};
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    for (let index = 0; index <= 10; index++) {
      const x = graph.x + graph.w * index / 10, y = graph.y + graph.h * index / 10;
      ctx.beginPath(); ctx.moveTo(x, graph.y); ctx.lineTo(x, graph.y + graph.h);
      ctx.moveTo(graph.x, y); ctx.lineTo(graph.x + graph.w, y);
      ctx.strokeStyle = index % 5 === 0 ? '#283544' : '#14202b';
      ctx.lineWidth = density * (index % 5 === 0 ? 1 : .6); ctx.stroke();
    }
    ctx.strokeStyle = '#4a6278'; ctx.lineWidth = density; ctx.strokeRect(graph.x, graph.y, graph.w, graph.h);
    ctx.fillStyle = '#8291a0'; ctx.font = `${11 * density}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let index = 0; index <= 4; index++) ctx.fillText((index / 4).toFixed(2), graph.x + graph.w * index / 4, graph.y + graph.h + 10 * density);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let index = 0; index <= 4; index++) ctx.fillText((1 - index / 4).toFixed(2), graph.x - 10 * density, graph.y + graph.h * index / 4);
    const points = envelope.points.slice().sort((a,b) => a.x - b.x);
    ctx.beginPath();
    const samples = Math.max(128, Math.floor(graph.w / (4 * density)));
    for (let index = 0; index <= samples; index++) {
      const x = index / samples;
      const y = C.sampleEnvelope ? C.sampleEnvelope(envelope, x) : x;
      const screen = envelopeCanvasPoint({x,y}, graph);
      if (!index) ctx.moveTo(screen.x, screen.y); else ctx.lineTo(screen.x, screen.y);
    }
    ctx.strokeStyle = '#13a8ff'; ctx.shadowColor = '#008dff'; ctx.shadowBlur = 10 * density;
    ctx.lineWidth = 2.2 * density; ctx.stroke(); ctx.shadowBlur = 0;
    const anchors = points.map(point => {
      const anchor = envelopeCanvasPoint(point, graph), input = envelopeCanvasPoint({x:point.inX,y:point.inY}, graph);
      const output = envelopeCanvasPoint({x:point.outX,y:point.outY}, graph);
      return {point, anchor, input, output};
    });
    anchors.forEach((item, index) => {
      const selected = envelopeSelection.has(item.point.id);
      if (selected) {
        ctx.beginPath();
        if (index > 0) { ctx.moveTo(item.anchor.x,item.anchor.y); ctx.lineTo(item.input.x,item.input.y); }
        if (index < anchors.length - 1) { ctx.moveTo(item.anchor.x,item.anchor.y); ctx.lineTo(item.output.x,item.output.y); }
        ctx.strokeStyle = '#7f95a8'; ctx.lineWidth = density; ctx.stroke();
        [index > 0 && item.input, index < anchors.length - 1 && item.output].filter(Boolean).forEach(handle => {
          ctx.fillStyle = '#d3dce4'; ctx.fillRect(handle.x - 3 * density, handle.y - 3 * density, 6 * density, 6 * density);
          ctx.strokeStyle = '#111820'; ctx.strokeRect(handle.x - 3 * density, handle.y - 3 * density, 6 * density, 6 * density);
        });
      }
      ctx.beginPath(); ctx.arc(item.anchor.x, item.anchor.y, (selected ? 6 : 4.5) * density, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#f5fbff' : '#0f9ff4'; ctx.fill();
      ctx.strokeStyle = selected ? '#058bea' : '#bce9ff'; ctx.lineWidth = 1.5 * density; ctx.stroke();
    });
    if (envelopeGesture && envelopeGesture.type === 'lasso') {
      const a = envelopeGesture.start, b = envelopeGesture.end;
      ctx.fillStyle = 'rgba(0,145,255,.12)'; ctx.strokeStyle = '#24a9ff'; ctx.setLineDash([5*density,4*density]);
      ctx.fillRect(Math.min(a.x,b.x), Math.min(a.y,b.y), Math.abs(b.x-a.x), Math.abs(b.y-a.y));
      ctx.strokeRect(Math.min(a.x,b.x), Math.min(a.y,b.y), Math.abs(b.x-a.x), Math.abs(b.y-a.y));
    }
    ctx.restore(); envelopeLayout = {graph, anchors}; layout = null; interactionLayout = null;
  }

  function paint(now) {
    paintFrame = 0;
    const changed = updatePlayhead(now || performance.now());
    resizeCanvas();
    if (project.mode === 'envelope') {
      paintEnvelope();
      if (project.playback.playing) stopPlayback(false);
      return;
    }
    envelopeLayout = null;
    layout = C.render(ctx, project, {
      width:canvas.width, height:canvas.height, padding:28 * Math.min(2, devicePixelRatio || 1),
      levels:activeLevels(), mapMode:project.mode === 'pixelmap',
      transparent:project.mode === 'pixelmap' && project.pixelMap.transparent,
      background:'#020304', showLabels:project.pixelMap.showLabels,
      zoom:canvasZoom, panX:canvasPanX, panY:canvasPanY, visibleIds:visibleSliceIds()
    });
    interactionLayout = C.layoutMap(project.map, canvas.width, canvas.height, {
      padding:28 * Math.min(2, devicePixelRatio || 1),
      zoom:canvasZoom, panX:canvasPanX, panY:canvasPanY
    });
    if ((altVisibilityPreview || canvasGesture && canvasGesture.visibility) && interactionLayout) {
      const visible = visibleSliceIds();
      ctx.save(); ctx.strokeStyle = '#f1ae2a'; ctx.globalAlpha = .48;
      ctx.lineWidth = Math.max(1, devicePixelRatio || 1);
      ctx.setLineDash([4 * (devicePixelRatio || 1), 3 * (devicePixelRatio || 1)]);
      interactionLayout.slices.forEach(slice => {
        if (visible.has(slice.id)) return;
        ctx.beginPath(); ctx.moveTo(slice.points[0].x, slice.points[0].y);
        slice.points.slice(1).forEach(point => ctx.lineTo(point.x, point.y));
        ctx.closePath(); ctx.stroke();
      });
      ctx.restore();
    }
    if (hoverId && layout) {
      const slice = (interactionLayout || layout).slices.find(item => item.id === hoverId);
      if (slice) {
        ctx.save(); ctx.beginPath(); ctx.moveTo(slice.points[0].x, slice.points[0].y);
        slice.points.slice(1).forEach(point => ctx.lineTo(point.x, point.y)); ctx.closePath();
        ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = .9; ctx.lineWidth = Math.max(2, devicePixelRatio || 1);
        ctx.stroke(); ctx.restore();
      }
    }
    if (canvasGesture && canvasGesture.type === 'lasso') {
      const a = canvasGesture.start, b = canvasGesture.end;
      ctx.save(); ctx.fillStyle = canvasGesture.visibility ? 'rgba(241,174,42,.14)' : 'rgba(0,145,255,.12)';
      ctx.strokeStyle = canvasGesture.visibility ? '#f1ae2a' : '#24a9ff';
      ctx.setLineDash([5 * (devicePixelRatio || 1),4 * (devicePixelRatio || 1)]);
      ctx.fillRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y));
      ctx.strokeRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y)); ctx.restore();
    }
    paintFactoryGrid();
    if (changed) {
      [...document.querySelectorAll('#chSteps .ch-step')].forEach((button, index) =>
        button.classList.toggle('playhead', index === playhead));
      $('#chStageBadge').innerHTML = `<strong>Step ${playhead + 1}</strong> · playing ${htmlText(activeSequence().name)}`;
    }
    if (project.playback.playing && operatorViewActive()) {
      if (reduceMotion.matches) {
        if (!reducedPaintTimer) reducedPaintTimer = setTimeout(() => {
          reducedPaintTimer = 0; requestPaint();
        }, 100);
      } else requestPaint();
    }
  }

  function requestPaint() {
    if (!paintFrame) paintFrame = requestAnimationFrame(paint);
  }

  function renderAll() {
    if (project.mode === 'envelope') sidebarMode = 'envelopes';
    else if (sidebarMode === 'envelopes') sidebarMode = 'sequences';
    renderSidebar(); renderSteps(); renderInspector(); renderWorkspace(); requestPaint();
    if (exportOpen && E) {
      reconcileExportSettings(false); renderExportTargets(); renderExportSlices();
      syncExportControls(); renderExportChrome(); exportRequestPaint();
    }
  }

  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if (((a.y > y) !== (b.y > y)) && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || .00001) + a.x)
        inside = !inside;
    }
    return inside;
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {x:(event.clientX - rect.left) * canvas.width / rect.width,
      y:(event.clientY - rect.top) * canvas.height / rect.height};
  }

  function hitSlice(event, includeHidden) {
    const targetLayout = includeHidden ? interactionLayout : layout;
    if (!targetLayout) return null;
    const point = canvasPoint(event);
    return [...targetLayout.slices].reverse().find(slice => pointInPolygon(point.x, point.y, slice.points)) || null;
  }

  function hitSlicePoint(point, includeHidden) {
    const targetLayout = includeHidden ? interactionLayout : layout;
    if (!targetLayout) return null;
    return [...targetLayout.slices].reverse().find(slice => pointInPolygon(point.x, point.y, slice.points)) || null;
  }

  function setCanvasTool(tool) {
    canvasTool = tool === 'pan' ? 'pan' : 'select'; renderWorkspace();
    canvas.style.cursor = canvasTool === 'pan' ? 'grab' : 'crosshair';
  }

  function fitCanvas() {
    canvasZoom = 1; canvasPanX = 0; canvasPanY = 0; renderWorkspace(); requestPaint();
  }

  function setCanvasZoom(next, anchor) {
    const old = canvasZoom, zoom = clamp(next, .15, 12);
    if (Math.abs(zoom - old) < .0001) return;
    const point = anchor || {x:canvas.width / 2,y:canvas.height / 2};
    const center = {x:canvas.width / 2,y:canvas.height / 2}, ratio = zoom / old;
    canvasPanX = point.x - center.x - (point.x - center.x - canvasPanX) * ratio;
    canvasPanY = point.y - center.y - (point.y - center.y - canvasPanY) * ratio;
    canvasZoom = zoom; renderWorkspace(); requestPaint();
  }

  function bindCanvasZoomEditor() {
    const node = $('#chZoomValue'); if (!node) return;
    node.contentEditable = 'true'; node.tabIndex = 0; node.spellcheck = false;
    node.setAttribute('role','textbox'); node.setAttribute('inputmode','decimal');
    node.setAttribute('aria-label','Canvas zoom percentage'); node.setAttribute('aria-multiline','false');
    node.title = 'Enter a zoom percentage. Enter applies it; Escape cancels.';
    let cancelled = false;
    const restore = () => { node.textContent = `${Math.round(canvasZoom * 100)}%`; };
    node.addEventListener('focus', () => {
      cancelled = false; node.dataset.editing = 'true';
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    });
    node.addEventListener('blur', () => {
      node.dataset.editing = 'false';
      const value = Number(node.textContent.trim().replace(/%\s*$/,'').replace(',','.'));
      if (!cancelled && Number.isFinite(value) && value > 0) setCanvasZoom(value / 100);
      restore(); cancelled = false;
    });
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); node.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled = true; restore(); node.blur(); }
    });
  }

  function hitFactoryGrid(point) {
    if (!factoryIsOpen() || !layout) return null;
    const factory = activeSequence().factory || {}, threshold = 8 * Math.min(2, devicePixelRatio || 1);
    const xHit = (factory.gridX || []).map((value,index) => ({axis:'x',index,value,
      distance:Math.abs(point.x - (layout.offsetX + value * layout.scale))})).sort((a,b)=>a.distance-b.distance)[0];
    const yHit = (factory.gridY || []).map((value,index) => ({axis:'y',index,value,
      distance:Math.abs(point.y - (layout.offsetY + value * layout.scale))})).sort((a,b)=>a.distance-b.distance)[0];
    const hit = !xHit ? yHit : !yHit ? xHit : xHit.distance <= yHit.distance ? xHit : yHit;
    return hit && hit.distance <= threshold ? hit : null;
  }

  function moveFactoryGrid(point) {
    const gesture = canvasGesture; if (!gesture || gesture.type !== 'factory-grid' || !layout) return;
    const factory = activeSequence().factory, key = gesture.axis === 'x' ? 'gridX' : 'gridY';
    const size = gesture.axis === 'x' ? layout.map.composition.width : layout.map.composition.height;
    const origin = gesture.axis === 'x' ? layout.offsetX : layout.offsetY;
    const screenValue = gesture.axis === 'x' ? point.x : point.y;
    const values = factory[key].slice(), requested = (screenValue-origin)/layout.scale;
    if (gesture.duplicate && !gesture.duplicateInserted) {
      if (Math.abs(requested - gesture.value) < .001) return;
      if (requested > gesture.value) gesture.index++;
      values.splice(gesture.index, 0, gesture.value); gesture.duplicateInserted = true;
    }
    const previous = gesture.index ? values[gesture.index-1] : 0;
    const next = gesture.index < values.length - 1 ? values[gesture.index+1] : size;
    values[gesture.index] = clamp(requested, previous+.001, next-.001);
    factory[key] = values; factory[key === 'gridX' ? 'gridXEdited' : 'gridYEdited'] = true;
    factoryGridSelection = {axis:gesture.axis, index:gesture.index};
    gesture.changed = true; requestPaint();
  }

  function gestureMode(event) {
    return event.shiftKey ? 'on' : event.ctrlKey || event.metaKey ? 'off' : 'toggle';
  }

  function mutateStepSlice(id, mode) {
    const step = activeSequence().steps[activeStepIndex()], active = step.sliceIds.includes(id);
    const next = mode === 'on' ? true : mode === 'off' ? false : !active;
    if (next === active) return false;
    if (next) step.sliceIds.push(id); else step.sliceIds.splice(step.sliceIds.indexOf(id), 1);
    return true;
  }

  function mutateViewSlice(id, mode) {
    const view = activeView();
    if (!view) return false;
    const visible = new Set(view.visibleSliceIds || []), active = visible.has(id);
    const next = mode === 'on' ? true : mode === 'off' ? false : !active;
    if (next === active) return false;
    if (next) visible.add(id); else visible.delete(id);
    view.visibleSliceIds = [...visible]; return true;
  }

  function mutateGestureSlice(id, gesture) {
    if (!id || gesture.touched.has(id)) return false;
    gesture.touched.add(id);
    const changed = gesture.visibility ? mutateViewSlice(id, gesture.mode) : mutateStepSlice(id, gesture.mode);
    gesture.changed = gesture.changed || changed;
    if (changed) { sliceListSignature = ''; requestPaint(); }
    return changed;
  }

  function finishCanvasGesture(event) {
    const gesture = canvasGesture; if (!gesture || event && gesture.pointerId !== event.pointerId) return;
    canvasGesture = null;
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
    const gestureLayout = gesture.visibility ? interactionLayout : layout;
    if (gesture.type === 'lasso' && gestureLayout) {
      const left = Math.min(gesture.start.x, gesture.end.x), right = Math.max(gesture.start.x, gesture.end.x);
      const top = Math.min(gesture.start.y, gesture.end.y), bottom = Math.max(gesture.start.y, gesture.end.y);
      gestureLayout.slices.forEach(slice => {
        const box = slice.box || {x:Math.min(...slice.points.map(point => point.x)),
          y:Math.min(...slice.points.map(point => point.y)),
          w:Math.max(...slice.points.map(point => point.x)) - Math.min(...slice.points.map(point => point.x)),
          h:Math.max(...slice.points.map(point => point.y)) - Math.min(...slice.points.map(point => point.y))};
        if (box.x <= right && box.x + box.w >= left && box.y <= bottom && box.y + box.h >= top)
          mutateGestureSlice(slice.id, gesture);
      });
    }
    if (gesture.changed) commit(gesture.visibility ? 'Paint View visibility on canvas' : 'Paint chase step on canvas');
    else { renderAll(); requestPaint(); }
  }

  function finishPanGesture(event) {
    const gesture = canvasGesture;
    if (!gesture || gesture.type !== 'pan' || event && gesture.pointerId !== event.pointerId) return;
    canvasGesture = null;
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
    canvas.style.cursor = canvasTool === 'pan' ? 'grab' : 'crosshair';
    renderWorkspace(); requestPaint();
  }

  function finishFactoryGesture(event) {
    const gesture = canvasGesture;
    if (!gesture || gesture.type !== 'factory-grid' || event && gesture.pointerId !== event.pointerId) return;
    canvasGesture = null;
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
    if (gesture.changed) generateFactory('Edit Factory grid'); else requestPaint();
  }

  function envelopeGraphPoint(point) {
    const graph = envelopeLayout && envelopeLayout.graph;
    if (!graph) return null;
    return {x:clamp((point.x - graph.x) / graph.w, 0, 1),
      y:clamp(1 - (point.y - graph.y) / graph.h, 0, 1)};
  }

  function hitEnvelopePart(point) {
    if (!envelopeLayout) return null;
    const density = Math.min(2, devicePixelRatio || 1), threshold = 10 * density;
    for (let index = envelopeLayout.anchors.length - 1; index >= 0; index--) {
      const item = envelopeLayout.anchors[index];
      if (envelopeSelection.has(item.point.id)) {
        if (index > 0 && Math.hypot(point.x-item.input.x,point.y-item.input.y) <= threshold) return {type:'in',item};
        if (index < envelopeLayout.anchors.length - 1 && Math.hypot(point.x-item.output.x,point.y-item.output.y) <= threshold) return {type:'out',item};
      }
      if (Math.hypot(point.x-item.anchor.x,point.y-item.anchor.y) <= threshold) return {type:'anchor',item};
    }
    return null;
  }

  function beginEnvelopeGesture(event, point) {
    const hit = hitEnvelopePart(point), envelope = activeEnvelope();
    if (hit && hit.type === 'anchor') {
      const id = hit.item.point.id;
      if (event.ctrlKey || event.metaKey) {
        if (envelopeSelection.has(id)) envelopeSelection.delete(id); else envelopeSelection.add(id);
      } else if (event.shiftKey) envelopeSelection.add(id);
      else if (!envelopeSelection.has(id)) { envelopeSelection.clear(); envelopeSelection.add(id); }
      const selected = envelope.points.filter(item => envelopeSelection.has(item.id));
      envelopeGesture = {type:'anchors',pointerId:event.pointerId,start:point,changed:false,
        axis:null, points:selected.map(item => ({item,x:item.x,y:item.y,inX:item.inX,inY:item.inY,outX:item.outX,outY:item.outY}))};
    } else if (hit) {
      envelopeSelection.clear(); envelopeSelection.add(hit.item.point.id);
      envelopeGesture = {type:'handle',kind:hit.type,item:hit.item.point,pointerId:event.pointerId,changed:false};
    } else {
      if (!event.shiftKey) envelopeSelection.clear();
      envelopeGesture = {type:'lasso',pointerId:event.pointerId,start:point,end:point,additive:event.shiftKey,changed:false};
    }
    canvas.setPointerCapture(event.pointerId); renderEnvelopeInspector(); requestPaint();
  }

  function moveEnvelopeGesture(event, point) {
    const gesture = envelopeGesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.type === 'lasso') { gesture.end = point; requestPaint(); return; }
    const normalized = envelopeGraphPoint(point); if (!normalized) return;
    if (gesture.type === 'handle') {
      const anchor = gesture.item, kind = gesture.kind;
      const x = kind === 'in' ? Math.min(anchor.x, normalized.x) : Math.max(anchor.x, normalized.x);
      anchor[`${kind}X`] = x; anchor[`${kind}Y`] = normalized.y;
      if (!event.altKey) {
        const other = kind === 'in' ? 'out' : 'in';
        anchor[`${other}X`] = clamp(anchor.x + (anchor.x - x), 0, 1);
        anchor[`${other}Y`] = clamp(anchor.y + (anchor.y - normalized.y), 0, 1);
      }
      anchor.linear = false; gesture.changed = true;
    } else if (gesture.type === 'anchors') {
      const start = envelopeGraphPoint(gesture.start), current = normalized;
      let dx = current.x - start.x, dy = current.y - start.y;
      if (event.shiftKey) {
        if (!gesture.axis) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (gesture.axis === 'x') dy = 0; else dx = 0;
      } else gesture.axis = null;
      if (!event.ctrlKey && !event.metaKey) { dx = Math.round(dx * 100) / 100; dy = Math.round(dy * 100) / 100; }
      gesture.points.forEach(saved => {
        const endpoint = saved.x <= 0 || saved.x >= 1;
        const nextX = endpoint ? saved.x : clamp(saved.x + dx, .001, .999), nextY = clamp(saved.y + dy, 0, 1);
        const moveX = nextX - saved.x, moveY = nextY - saved.y;
        Object.assign(saved.item, {x:nextX,y:nextY,inX:clamp(saved.inX+moveX,0,1),
          inY:clamp(saved.inY+moveY,0,1),outX:clamp(saved.outX+moveX,0,1),outY:clamp(saved.outY+moveY,0,1)});
      });
      activeEnvelope().points.sort((a,b) => a.x - b.x); gesture.changed = true;
    }
    renderEnvelopeInspector(); requestPaint();
  }

  function finishEnvelopeGesture(event) {
    const gesture = envelopeGesture; if (!gesture || event && gesture.pointerId !== event.pointerId) return;
    envelopeGesture = null;
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
    if (gesture.type === 'lasso' && envelopeLayout) {
      const left=Math.min(gesture.start.x,gesture.end.x),right=Math.max(gesture.start.x,gesture.end.x);
      const top=Math.min(gesture.start.y,gesture.end.y),bottom=Math.max(gesture.start.y,gesture.end.y);
      envelopeLayout.anchors.forEach(item => {
        if (item.anchor.x>=left && item.anchor.x<=right && item.anchor.y>=top && item.anchor.y<=bottom)
          envelopeSelection.add(item.point.id);
      });
      renderAll(); return;
    }
    if (gesture.changed) commit('Edit animation envelope'); else renderAll();
  }

  function envelopeDoubleClick(event) {
    if (project.mode !== 'envelope' || !envelopeLayout) return;
    const point = canvasPoint(event), hit = hitEnvelopePart(point), envelope = activeEnvelope();
    if (hit && hit.type === 'anchor') {
      const anchors = envelope.points.slice().sort((a,b)=>a.x-b.x), index = anchors.indexOf(hit.item.point);
      if (index <= 0 || index >= anchors.length - 1) return;
      envelope.points.splice(envelope.points.indexOf(hit.item.point),1); envelopeSelection.delete(hit.item.point.id);
      commit('Remove envelope anchor'); return;
    }
    const value = envelopeGraphPoint(point); if (!value) return;
    const graph = envelopeLayout.graph;
    if (point.x < graph.x || point.x > graph.x+graph.w || point.y < graph.y || point.y > graph.y+graph.h) return;
    const next = {id:localId('anchor'),x:value.x,y:value.y,inX:clamp(value.x-.08,0,1),inY:value.y,
      outX:clamp(value.x+.08,0,1),outY:value.y,linear:false};
    envelope.points.push(next); envelope.points.sort((a,b)=>a.x-b.x);
    envelopeSelection.clear(); envelopeSelection.add(next.id); commit('Add envelope anchor');
  }

  function exportStatus(state, message) {
    const node = $('#chExStatus');
    if (!node) return;
    node.classList.toggle('busy', state === 'busy');
    node.classList.toggle('error', state === 'error');
    node.querySelector('span').textContent = message || 'Ready to export';
  }

  function setExportBusy(value, message) {
    exportBusy = !!value;
    const dialog = $('#chExportDialog');
    dialog.setAttribute('aria-busy', String(exportBusy));
    ['#chExChooseFolder', '#chExDownloadCurrent', '#chExSaveAll', '#chExClose', '#chExCloseFooter']
      .forEach(selector => { const node = $(selector); if (node) node.disabled = exportBusy; });
    $('#chExChooseFolder').disabled = exportBusy || !Files?.directoryAvailable;
    if (message) exportStatus(exportBusy ? 'busy' : 'ready', message);
  }

  function portableExportSettings() {
    const portable = copy(exportSettings);
    /* A logo remains fully usable for this operator session without pushing a
       multi-megabyte data URL through the cross-window Hub on every change. */
    if (portable.logo) portable.logo.dataUrl = '';
    return portable;
  }

  function persistExportSettings(reason) {
    project.exportSettings = portableExportSettings();
    commit(reason || 'Edit Pixel Map export preset');
  }

  function reconcileExportSettings(fromProject) {
    if (!E) return;
    if (exportSettings && exportSettings.logo && exportSettings.logo.dataUrl)
      exportLogoAssets.set(project.id, {dataUrl:exportSettings.logo.dataUrl,
        name:exportSettings.logo.name || 'Logo'});
    exportSettings = E.normaliseSettings(fromProject ? project.exportSettings : exportSettings, project);
    const logoReferenced = exportSettings.logo.enabled || Object.values(exportSettings.sliceStyles || {})
      .some(style => style && style.logo && style.logo.enabled);
    const asset = exportLogoAssets.get(project.id);
    if (!exportSettings.logo.dataUrl && logoReferenced && asset) {
      exportSettings.logo.dataUrl = asset.dataUrl;
      exportSettings.logo.name = asset.name;
    }
    exportTarget = E.targetById(project, exportSettings.targetId);
    const valid = new Set(exportTarget.slices.map(slice => slice.id));
    [...exportSelection].forEach(id => { if (!valid.has(id)) exportSelection.delete(id); });
  }

  function resizeExportCanvas() {
    const rect = exportCanvas.getBoundingClientRect();
    const density = Math.min(1.5, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * density));
    const height = Math.max(1, Math.round(rect.height * density));
    if (exportCanvas.width !== width || exportCanvas.height !== height) {
      exportCanvas.width = width; exportCanvas.height = height;
    }
    return density;
  }

  function exportRequestPaint() {
    if (exportOpen && !exportFrame) exportFrame = requestAnimationFrame(paintExport);
  }

  function paintExport() {
    exportFrame = 0;
    if (!exportOpen || !E || !exportCtx) return;
    const density = resizeExportCanvas();
    try {
      const actualPlan = E.exportPlan(exportTarget, exportSettings.scale);
      const previewPolicy = actualPlan.width * actualPlan.height <= 16777216 &&
        actualPlan.width <= 8192 && actualPlan.height <= 8192
        ? null : {maxEdge:4096, maxPixels:16777216};
      const rasterPlan = previewPolicy
        ? E.exportPlan(exportTarget, exportSettings.scale, previewPolicy) : actualPlan;
      const previewKey = `${project.updatedAt}|${exportTarget.id}|${rasterPlan.width}x${rasterPlan.height}|${
        exportLogoRevision}|${JSON.stringify(portableExportSettings())}`;
      if (previewKey !== exportPreviewKey || exportPreviewRaster.width !== rasterPlan.width ||
          exportPreviewRaster.height !== rasterPlan.height) {
        exportPreviewRaster.width = rasterPlan.width; exportPreviewRaster.height = rasterPlan.height;
        const rasterContext = exportPreviewRaster.getContext('2d');
        E.render(rasterContext, project, exportSettings, exportTarget.id, {
          width:rasterPlan.width, height:rasterPlan.height, padding:0, zoom:1,
          logoImage:exportLogoImage
        });
        exportPreviewKey = previewKey; exportPreviewPlan = rasterPlan;
      }
      exportLayout = E.layoutTarget(exportTarget, exportCanvas.width, exportCanvas.height, {
        padding:24 * density, zoom:exportZoom
      });
      exportCtx.save(); exportCtx.setTransform(1, 0, 0, 1, 0, 0);
      exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportCtx.imageSmoothingEnabled = true; exportCtx.imageSmoothingQuality = 'high';
      exportCtx.drawImage(exportPreviewRaster, exportLayout.stage.x, exportLayout.stage.y,
        exportLayout.stage.w, exportLayout.stage.h);
      exportCtx.beginPath(); exportCtx.rect(exportLayout.stage.x, exportLayout.stage.y,
        exportLayout.stage.w, exportLayout.stage.h); exportCtx.clip();
      exportLayout.slices.filter(slice => exportSelection.has(slice.id)).forEach(slice => {
        exportCtx.beginPath(); exportCtx.moveTo(slice.points[0].x, slice.points[0].y);
        slice.points.slice(1).forEach(point => exportCtx.lineTo(point.x, point.y)); exportCtx.closePath();
        exportCtx.strokeStyle = '#1495ff'; exportCtx.lineWidth = 2 * density;
        if (exportCtx.setLineDash) exportCtx.setLineDash([5 * density, 3 * density]);
        exportCtx.stroke();
      });
      if (exportCtx.setLineDash) exportCtx.setLineDash([]);
      exportCtx.restore();
    } catch (error) {
      exportLayout = null; exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportStatus('error', error.message || 'Preview render failed.'); return;
    }
    if (exportLasso && exportLasso.dragging) {
      const left = Math.min(exportLasso.start.x, exportLasso.end.x);
      const top = Math.min(exportLasso.start.y, exportLasso.end.y);
      const width = Math.abs(exportLasso.end.x - exportLasso.start.x);
      const height = Math.abs(exportLasso.end.y - exportLasso.start.y);
      exportCtx.save(); exportCtx.setTransform(1, 0, 0, 1, 0, 0);
      exportCtx.fillStyle = 'rgba(20,149,255,.12)'; exportCtx.fillRect(left, top, width, height);
      exportCtx.strokeStyle = '#1495ff'; exportCtx.lineWidth = 1;
      if (exportCtx.setLineDash) exportCtx.setLineDash([5, 3]);
      exportCtx.strokeRect(left, top, width, height); exportCtx.restore();
    }
  }

  function exportPoint(event) {
    const rect = exportCanvas.getBoundingClientRect();
    return {
      x:(event.clientX - rect.left) * exportCanvas.width / Math.max(1, rect.width),
      y:(event.clientY - rect.top) * exportCanvas.height / Math.max(1, rect.height)
    };
  }

  function exportHit(point) {
    if (!exportLayout) return null;
    return [...exportLayout.slices].reverse().find(slice => pointInPolygon(point.x, point.y, slice.points)) || null;
  }

  function exportSelectionChanged() {
    renderExportSlices();
    syncExportControls();
    exportRequestPaint();
  }

  function selectExportSlice(id, additive) {
    if (!additive) exportSelection.clear();
    if (id) {
      if (additive && exportSelection.has(id)) exportSelection.delete(id);
      else exportSelection.add(id);
    }
    exportSelectionChanged();
  }

  function renderExportTargets() {
    const targets = E.targets(project), root = $('#chExTargets');
    root.innerHTML = '';
    targets.forEach(target => {
      const selected = target.id === exportTarget.id, button = document.createElement('button');
      button.type = 'button'; button.className = 'ch-export-target' + (selected ? ' on' : '');
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected));
      button.innerHTML = `<i aria-hidden="true">${target.kind === 'input' ? 'IN' : 'OUT'}</i><strong></strong><small></small>`;
      button.querySelector('strong').textContent = target.name;
      button.querySelector('small').textContent = `${target.width} × ${target.height} · ${target.slices.length} slice${target.slices.length === 1 ? '' : 's'}`;
      button.addEventListener('click', () => selectExportTarget(target.id));
      root.appendChild(button);
    });
    $('#chExTargetCount').textContent = targets.length;
  }

  function renderExportSlices() {
    const root = $('#chExSlices'); root.innerHTML = '';
    exportTarget.slices.slice(0, 1024).forEach(slice => {
      const selected = exportSelection.has(slice.id), button = document.createElement('button');
      button.type = 'button'; button.className = 'ch-export-slice' + (selected ? ' on' : '');
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected));
      button.innerHTML = '<i aria-hidden="true"></i><span></span>';
      button.querySelector('span').textContent = exportTarget.kind === 'input'
        ? `${slice.screenName} · ${slice.name}` : slice.name;
      button.addEventListener('click', event => selectExportSlice(slice.id,
        event.shiftKey || event.ctrlKey || event.metaKey));
      root.appendChild(button);
    });
    if (exportTarget.slices.length > 1024) {
      const note = document.createElement('div'); note.className = 'hint';
      note.textContent = `${exportTarget.slices.length - 1024} additional slices are selectable in the preview.`;
      root.appendChild(note);
    }
  }

  function selectExportTarget(id) {
    if (exportBusy) return;
    exportSettings.targetId = id;
    exportTarget = E.targetById(project, id);
    exportSelection.clear(); exportZoom = 1;
    persistExportSettings('Select Pixel Map export target');
    renderExportTargets(); renderExportSlices(); syncExportControls(); renderExportChrome();
    exportRequestPaint();
  }

  function scopedExportSection(section) {
    return section === 'main' || section === 'panel' || section === 'info' ||
      section === 'deco' || section === 'logo';
  }

  function exportControlValues(section, key) {
    const apply = scopedExportSection(section) && exportSelection.size && $('#chExApplySelected').checked;
    if (!apply) return [exportSettings[section][key]];
    return [...exportSelection].map(id => E.mergedStyle(exportSettings, id)[section][key]);
  }

  function syncExportControls() {
    if (!exportSettings) return;
    document.querySelectorAll('[data-ex-section][data-ex-key]').forEach(node => {
      const values = exportControlValues(node.dataset.exSection, node.dataset.exKey);
      const value = values[0], mixed = values.some(item => item !== value);
      node.classList.toggle('mixed', mixed); node.title = mixed ? 'Selected slices use different values' : '';
      if (node.type === 'checkbox') {
        node.indeterminate = mixed; node.checked = !!value;
      } else if (document.activeElement !== node) node.value = value == null ? '' : value;
    });
    const count = exportSelection.size, selectedLabel = $('#chExSelectionLabel');
    selectedLabel.textContent = count ? `${count} selected` : 'all slices';
    $('#chExApplySelected').disabled = !count;
    $('#chExResetSelected').disabled = !count;
    $('#chExSliceName').disabled = count !== 1;
    $('#chExSliceName').placeholder = count === 1 ? 'Use source name' : 'Select one slice';
    const logoSizes = exportControlValues('logo', 'size');
    const logoOpacities = exportControlValues('logo', 'opacity');
    $('#chExLogoSizeValue').textContent = logoSizes.some(value => value !== logoSizes[0])
      ? 'Mixed' : `${Math.round(logoSizes[0])}%`;
    $('#chExLogoOpacityValue').textContent = logoOpacities.some(value => value !== logoOpacities[0])
      ? 'Mixed' : `${Math.round(logoOpacities[0] * 100)}%`;
    $('#chExLogoName').textContent = exportSettings.logo.dataUrl
      ? exportSettings.logo.name || 'Logo loaded' : 'No logo loaded';
    $('#chExScale').value = String(exportSettings.scale);
  }

  function cleanExportOverride(id) {
    const style = exportSettings.sliceStyles[id];
    if (!style) return;
    Object.keys(style).forEach(section => { if (!Object.keys(style[section] || {}).length) delete style[section]; });
    if (!Object.keys(style).length) delete exportSettings.sliceStyles[id];
  }

  function setExportSetting(section, key, value) {
    const apply = scopedExportSection(section) && exportSelection.size && $('#chExApplySelected').checked;
    if (section === 'main' && exportSelection.size !== 1) return;
    if (apply) exportSelection.forEach(id => {
      const style = exportSettings.sliceStyles[id] || (exportSettings.sliceStyles[id] = {});
      const group = style[section] || (style[section] = {}); group[key] = value;
      if (section === 'logo' && exportSettings.logo.dataUrl) group.enabled = true;
    });
    else exportSettings[section][key] = value;
    exportSettings = E.normaliseSettings(exportSettings, project);
    persistExportSettings('Edit Pixel Map export style');
    syncExportControls(); renderExportChrome(); exportRequestPaint();
  }

  function resetExportProperty(path) {
    const parts = path.split('.'), section = parts[0], key = parts[1];
    const base = E.defaults(project);
    if (section === 'logo' && key === 'dataUrl') { removeExportLogo(); return; }
    const apply = scopedExportSection(section) && exportSelection.size && $('#chExApplySelected').checked;
    if (apply) exportSelection.forEach(id => {
      const style = exportSettings.sliceStyles[id];
      if (style && style[section]) delete style[section][key];
      cleanExportOverride(id);
    });
    else exportSettings[section][key] = base[section][key];
    exportSettings = E.normaliseSettings(exportSettings, project);
    persistExportSettings('Reset Pixel Map export property');
    syncExportControls(); renderExportChrome(); exportRequestPaint();
  }

  function resetExportSection(section) {
    const base = E.defaults(project);
    const apply = scopedExportSection(section) && exportSelection.size && $('#chExApplySelected').checked;
    if (apply) exportSelection.forEach(id => {
      const style = exportSettings.sliceStyles[id];
      if (style) delete style[section]; cleanExportOverride(id);
    });
    else exportSettings[section] = copy(base[section]);
    exportSettings = E.normaliseSettings(exportSettings, project);
    persistExportSettings(`Reset Pixel Map ${section} settings`);
    syncExportControls(); renderExportChrome(); exportRequestPaint();
  }

  function resetSelectedExportStyles() {
    exportSelection.forEach(id => delete exportSettings.sliceStyles[id]);
    exportSettings = E.normaliseSettings(exportSettings, project);
    persistExportSettings('Reset selected slice export styles');
    syncExportControls(); exportRequestPaint();
  }

  function renderExportChrome() {
    if (!exportTarget) return;
    const plan = E.exportPlan(exportTarget, exportSettings.scale), report = E.inspectTarget(exportTarget);
    $('#chExModeBadge').textContent = exportTarget.kind.toUpperCase();
    $('#chExPreviewName').textContent = exportTarget.name;
    $('#chExPreviewDetail').textContent = `${exportTarget.slices.length} slice${exportTarget.slices.length === 1 ? '' : 's'} · ${exportTarget.kind === 'input' ? 'Composition space' : 'Processor raster'}`;
    $('#chExZoomLabel').textContent = `${Math.round(exportZoom * 100)}%`;
    $('#chExRasterSummary').textContent = plan.limited
      ? `${plan.width} × ${plan.height} PNG · safety-limited from ${plan.nativeWidth} × ${plan.nativeHeight}`
      : `${plan.width} × ${plan.height} PNG${exportSettings.project.transparent ? ' · alpha' : ''}`;
    const preflight = $('#chExPreflight');
    preflight.className = 'ch-export-preflight ' + (report.ok && !plan.limited ? 'ok' : 'warn');
    preflight.textContent = plan.limited ? 'Raster exceeds safe canvas size'
      : report.ok ? 'Preflight passed' : `${report.warnings.length} geometry warning${report.warnings.length === 1 ? '' : 's'}`;
  }

  function decodeExportLogo(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The selected image could not be decoded.'));
      image.src = dataUrl;
    });
  }

  async function loadExportLogo(dataUrl) {
    const request = ++exportLogoLoadRequest, image = await decodeExportLogo(dataUrl);
    if (request !== exportLogoLoadRequest) return null;
    exportLogoImage = image; exportLogoRevision++; exportRequestPaint(); return image;
  }

  function syncExportLogoImage() {
    const dataUrl = exportSettings && exportSettings.logo && exportSettings.logo.dataUrl || '';
    if (!dataUrl) { exportLogoImage = null; exportLogoRevision++; exportRequestPaint(); return; }
    if (exportLogoImage && exportLogoImage.src === dataUrl) return;
    loadExportLogo(dataUrl).catch(error => exportStatus('error', error.message || 'Logo load failed.'));
  }

  async function importExportLogo(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type || '') || file.size > 5 * 1024 * 1024) {
      exportStatus('error', 'Choose a PNG, JPEG or WebP logo smaller than 5 MB.'); return;
    }
    try {
      setExportBusy(true, 'Loading logo…');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Logo read failed.')); reader.readAsDataURL(file);
      });
      exportSettings.logo.dataUrl = String(dataUrl); exportSettings.logo.name = file.name;
      exportLogoAssets.set(project.id, {dataUrl:exportSettings.logo.dataUrl, name:file.name});
      const apply = exportSelection.size && $('#chExApplySelected').checked;
      exportSettings.logo.enabled = !apply;
      if (apply) exportSelection.forEach(id => {
        const style = exportSettings.sliceStyles[id] || (exportSettings.sliceStyles[id] = {});
        style.logo = Object.assign({}, style.logo || {}, {enabled:true});
      });
      await loadExportLogo(exportSettings.logo.dataUrl);
      persistExportSettings('Load Pixel Map logo'); syncExportControls();
      setExportBusy(false);
      exportStatus('ready', `${file.name} loaded for this export session`);
    } catch (error) {
      setExportBusy(false); exportStatus('error', error.message || 'Logo load failed.');
    }
    finally { $('#chExLogoFile').value = ''; }
  }

  function removeExportLogo() {
    exportSettings.logo = copy(E.defaults(project).logo); exportLogoImage = null; exportLogoRevision++;
    Object.keys(exportSettings.sliceStyles).forEach(id => {
      delete exportSettings.sliceStyles[id].logo; cleanExportOverride(id);
    });
    persistExportSettings('Remove Pixel Map logo'); syncExportControls(); exportRequestPaint();
    exportStatus('ready', 'Logo removed');
  }

  function exportFocusable() {
    return [...$('#chExportDialog').querySelectorAll(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(node => node.offsetParent !== null);
  }

  function openExportStudio() {
    if (!E || !exportCanvas) { setSaveState('error', 'Export Studio unavailable'); return; }
    exportOpener = document.activeElement;
    reconcileExportSettings(true); exportSelection.clear(); exportZoom = 1;
    const overlay = $('#chExportOverlay'); overlay.classList.add('show'); overlay.setAttribute('aria-hidden', 'false');
    $('#chaserRoot').inert = true; exportOpen = true;
    const linkDock = $('#ol-linkdock');
    if (linkDock) { linkDock.inert = true; linkDock.setAttribute('aria-hidden', 'true'); }
    renderExportTargets(); renderExportSlices(); syncExportControls(); renderExportChrome();
    const folderSupported = !!Files?.directoryAvailable;
    $('#chExChooseFolder').disabled = !folderSupported;
    if (!folderSupported) {
      $('#chExChooseFolder').textContent = 'ZIP fallback';
      $('#chExFolderHint').textContent = 'Folder access unavailable · Save All downloads a ZIP';
    } else {
      $('#chExChooseFolder').textContent = 'Set Folder…';
      $('#chExFolderHint').textContent = exportFolderHandle
        ? 'Save All writes PNGs and a manifest here' : 'Save All will create a ZIP download';
    }
    exportStatus('ready', 'Preview is downsampled from the PNG renderer');
    if (exportSettings.logo.dataUrl) loadExportLogo(exportSettings.logo.dataUrl).catch(error => exportStatus('error', error.message));
    exportRequestPaint();
    requestAnimationFrame(() => ($('#chExTargets .on') || $('#chExportDialog')).focus());
  }

  function closeExportStudio() {
    if (!exportOpen || exportBusy) return;
    const overlay = $('#chExportOverlay'); overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true');
    $('#chaserRoot').inert = false; exportOpen = false; exportLasso = null;
    const linkDock = $('#ol-linkdock');
    if (linkDock) { linkDock.inert = false; linkDock.removeAttribute('aria-hidden'); }
    if (exportFrame) cancelAnimationFrame(exportFrame); exportFrame = 0;
    if (exportOpener && typeof exportOpener.focus === 'function') exportOpener.focus();
  }

  function exportDialogKeydown(event) {
    if (!exportOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeExportStudio(); return; }
    if (event.key !== 'Tab') return;
    const focusable = exportFocusable(); if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function chooseExportFolder() {
    if (exportBusy || !Files?.directoryAvailable) return;
    try {
      const handle = await Files.chooseDirectory();
      exportFolderHandle = handle;
      $('#chExFolderName').textContent = handle.name || 'Selected folder';
      $('#chExFolderHint').textContent = 'Save All writes PNGs and a manifest here';
      exportStatus('ready', `Folder set to ${handle.name || 'selected folder'}`);
    } catch (error) {
      if (!error || error.name !== 'AbortError') exportStatus('error', `Folder access failed: ${error.message || error}`);
    }
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas.toBlob) { reject(new Error('This browser cannot encode PNG files.')); return; }
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding returned no data.')), 'image/png');
    });
  }

  function createExportJob(targetId) {
    const snapshotProject = C.shareableProject(copy(project));
    const snapshotSettings = E.normaliseSettings(exportSettings, snapshotProject);
    const targets = E.targets(snapshotProject);
    const plans = targets.map(target => E.exportPlan(target, snapshotSettings.scale));
    return {
      project:snapshotProject,
      settings:snapshotSettings,
      targets,
      plans,
      target:targets.find(target => target.id === targetId) || targets[0],
      logoImage:exportLogoImage,
      folder:exportFolderHandle
    };
  }

  async function renderExportBlob(job, target) {
    const plan = job.plans.find(item => item.targetId === target.id) ||
      E.exportPlan(target, job.settings.scale), output = document.createElement('canvas');
    output.width = plan.width; output.height = plan.height;
    E.render(output.getContext('2d'), job.project, job.settings, target.id, {
      width:plan.width, height:plan.height, padding:0, zoom:1, logoImage:job.logoImage
    });
    return {blob:await canvasBlob(output), plan};
  }

  function requestChaserFile(kind, name, download) {
    if (!Files) throw new Error('Reload Chaser to enable explicit project saves and exports.');
    return Files.request({kind, name, download:!!download});
  }

  async function exportCurrentPng() {
    if (exportBusy) return;
    try {
      const job = createExportJob(exportTarget.id), target = job.target;
      const plan = E.exportPlan(target, job.settings.scale);
      const writer = await requestChaserFile('png', plan.filename);
      setExportBusy(true, `Rendering ${target.name} at ${plan.width} × ${plan.height}…`);
      const rendered = await renderExportBlob(job, target);
      await writer.write(rendered.blob);
      setExportBusy(false); exportStatus('ready', `${writer.persistent ? 'Saved' : 'Downloaded'} ${writer.name}`);
    } catch (error) {
      setExportBusy(false);
      exportStatus(error?.name === 'AbortError' ? 'ready' : 'error',
        error?.name === 'AbortError' ? 'Export cancelled' : `Export failed: ${error.message || error}`);
    }
  }

  async function writeExportDirectoryFile(folder, name, data, index, total) {
    exportStatus('busy', `Writing ${index} of ${total}: ${name}`);
    await folder.write(name, data);
  }

  async function exportAllMaps() {
    if (exportBusy) return;
    try {
      const name = `${E.safeName(project.name, 'SHOWAVE-Chaser')}-pixelmaps.zip`;
      // Reserve the explicit download during this click before rendering begins.
      const fallbackWriter = await requestChaserFile('package', name, true);
      setExportBusy(true, 'Preparing Pixel Map package…');
      const job = createExportJob(exportTarget.id), targets = job.targets;
      const manifestName = `${E.safeName(job.project.name, 'SHOWAVE-Chaser')}-pixelmap-manifest.json`;
      const manifestBlob = new Blob([
        JSON.stringify(E.manifest(job.project, job.settings, job.plans), null, 2)
      ], {type:'application/json'});
      if (job.folder) {
        try {
          const total = targets.length + 1;
          for (let index = 0; index < targets.length; index++) {
            exportStatus('busy', `Rendering ${index + 1} of ${targets.length}: ${targets[index].name}`);
            const rendered = await renderExportBlob(job, targets[index]);
            await writeExportDirectoryFile(job.folder, rendered.plan.filename, rendered.blob, index + 1, total);
          }
          await writeExportDirectoryFile(job.folder, manifestName, manifestBlob, total, total);
          setExportBusy(false); exportStatus('ready', `Saved ${total} files to ${job.folder.name || 'selected folder'}`);
          return;
        } catch (error) {
          exportFolderHandle = null; $('#chExFolderName').textContent = 'Folder unavailable';
          $('#chExFolderHint').textContent = 'Falling back to a ZIP download';
          exportStatus('busy', `Folder write failed · building ZIP fallback`);
        }
      }
      const rawBytes = targets.reduce((sum, target) => {
        const plan = E.exportPlan(target, job.settings.scale);
        return sum + plan.width * plan.height * 4;
      }, 0);
      if (rawBytes > 256 * 1024 * 1024)
        throw new Error('This package is too large for the ZIP fallback. Set a folder or choose a lower raster scale.');
      const files = [];
      for (let index = 0; index < targets.length; index++) {
        exportStatus('busy', `Rendering ${index + 1} of ${targets.length}: ${targets[index].name}`);
        const rendered = await renderExportBlob(job, targets[index]);
        files.push({name:rendered.plan.filename, data:rendered.blob});
      }
      files.push({name:manifestName, data:manifestBlob});
      const zip = await E.zipBlob(files);
      await fallbackWriter.write(zip); setExportBusy(false);
      exportStatus('ready', `Downloaded ${name} · ${files.length} files`);
    } catch (error) {
      setExportBusy(false); exportStatus('error', `Package export failed: ${error.message || error}`);
    }
  }

  /* Both legacy entry points now open the production workspace. Keeping this
     small seam avoids breaking menu/action contracts used by the host panel. */
  function exportPixelMap() { openExportStudio(); }

  function projectDocument() {
    const saved = C.shareableProject(project);
    /* Cross-window auto-save intentionally omits large image bytes, while a
       user-authored project file must remain completely portable. */
    if (E && exportSettings && exportSettings.logo && exportSettings.logo.dataUrl)
      saved.exportSettings = copy(exportSettings);
    return {
      schema:'showave.chaser.document/1',
      savedAt:new Date().toISOString(),
      project:saved
    };
  }

  function projectFileBlob(kind) {
    if (kind === 'native') {
      if (!Native) throw new Error('Native Chaser XML support is unavailable.');
      return new Blob([Native.serializeDocument(project, project.nativeReference)], {type:'application/xml'});
    }
    return new Blob([JSON.stringify(projectDocument(), null, 2) + '\n'], {type:'application/json'});
  }

  function disconnectProjectFile() {
    if (fileSaveTimer) clearTimeout(fileSaveTimer);
    fileSaveTimer = 0; projectFileWriter = null; diskSignature = ''; projectFileKind = 'project';
    documentEpoch++;
  }

  function scheduleProjectFileSave() {
    if (!projectFileWriter?.persistent || diskSignature === projectContentSignature(project)) return;
    if (fileSaveTimer) clearTimeout(fileSaveTimer);
    fileSaveTimer = setTimeout(() => {
      fileSaveTimer = 0;
      const writer = projectFileWriter, epoch = documentEpoch;
      let blob;
      try { blob = projectFileBlob(projectFileKind); }
      catch (error) { setSaveState('error', `Save failed: ${error.message}`); return; }
      const signature = projectContentSignature(project);
      fileSaving = true; setSaveState('saving', `Saving ${writer.name}…`);
      fileWriteQueue = fileWriteQueue.catch(() => {}).then(() => {
        if (documentEpoch !== epoch || projectFileWriter !== writer) return;
        return writer.write(blob);
      }).then(() => {
        if (documentEpoch !== epoch || projectFileWriter !== writer) return;
        diskSignature = signature; setSaveState('saved', `Saved ${writer.name}`);
      }).catch(error => {
        if (projectFileWriter === writer) setSaveState('error', `Save failed: ${error.message || error}`);
      }).finally(() => { fileSaving = false; });
    }, 450);
  }

  async function saveProjectCopy(kind = 'project', saveAs = true) {
    if (projectSavePending) return;
    projectSavePending = true;
    const epoch = documentEpoch;
    try {
      const blob = projectFileBlob(kind), signature = projectContentSignature(project);
      const stem = E ? E.safeName(project.name, 'SHOWAVE-Chaser')
        : (project.name || 'SHOWAVE-Chaser').replace(/[\\/:*?\"<>|]+/g, '-');
      const filename = stem + (kind === 'native' ? '.xml' : '.showave-chaser.json');
      const writer = !saveAs && projectFileWriter && projectFileKind === kind
        ? projectFileWriter : await requestChaserFile(kind, filename);
      if (documentEpoch !== epoch) return;
      if (fileSaveTimer) clearTimeout(fileSaveTimer);
      fileSaveTimer = 0;
      setSaveState('saving', `Saving ${writer.name}…`); fileSaving = true;
      // Serialize writes to a chosen project, including an autosave already in flight.
      fileWriteQueue = fileWriteQueue.catch(() => {}).then(() => {
        if (documentEpoch !== epoch) return;
        return writer.write(blob);
      });
      await fileWriteQueue;
      if (documentEpoch !== epoch) return;
      projectFileWriter = writer.persistent ? writer : null;
      projectFileKind = kind; diskSignature = signature;
      setSaveState('saved', `${writer.persistent ? 'Saved' : 'Downloaded'} ${writer.name}`);
      if (writer.persistent && signature !== projectContentSignature(project)) scheduleProjectFileSave();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      setSaveState('error', `Project save failed: ${error.message || error}`);
      console.error('SHOWAVE Chaser project save', error);
    } finally { fileSaving = false; projectSavePending = false; }
  }

  async function loadProjectFile(file) {
    if (!file) return;
    const request = ++projectLoadRequest, epoch = documentEpoch;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('The Chaser project exceeds 32 MiB.');
      const text = await file.text();
      const native = /^\s*(?:<\?xml[^>]*>\s*)?<Chaser(?:\s|>)/i.test(text);
      const parsed = native ? Native.parseDocument(text, file.name) : JSON.parse(text);
      const value = parsed && parsed.project ? parsed.project : parsed;
      if (!value || typeof value !== 'object' || !Array.isArray(value.sequences))
        throw new Error('This file does not contain a SHOWAVE Chaser project.');
    const library = Hub?.get('chaser.envelopes', null) || project.envelopes;
    const mergedEnvelopes = new Map((library || []).map(envelope => [envelope.id,envelope]));
    (value.envelopes || []).forEach(envelope => mergedEnvelopes.set(envelope.id,envelope));
    const candidate = C.normaliseProject(Object.assign({}, value, {envelopes:[...mergedEnvelopes.values()]}));
    candidate.updatedAt = Date.now();
      if (native && parsed.reference) candidate.nativeReference = parsed.reference;
      const candidateSettings = E ? E.normaliseSettings(candidate.exportSettings, candidate) : null;
      const candidateLogo = await decodeExportLogo(candidateSettings?.logo?.dataUrl);
      if (request !== projectLoadRequest || epoch !== documentEpoch) return;
      const previous = copy(historyCurrent);
      disconnectProjectFile(); followResolume = false; syncResolumeFollowControl();
      stopPlayback(false); project = candidate; exportLogoLoadRequest++;
      if (E) {
        exportSettings = candidateSettings;
        if (exportSettings.logo && exportSettings.logo.dataUrl)
          exportLogoAssets.set(project.id, {dataUrl:exportSettings.logo.dataUrl,
            name:exportSettings.logo.name || 'Logo'});
        else exportLogoAssets.delete(project.id);
        project.exportSettings = portableExportSettings();
        exportTarget = E.targetById(project, exportSettings.targetId);
        exportLogoImage = candidateLogo; exportLogoRevision++;
      }
      currentMapLive = false; pendingLiveMap = publishedLiveMap();
      playhead = project.activeStep;
      canvasZoom = 1; canvasPanX = 0; canvasPanY = 0; envelopeSelection.clear();
      sliceListSignature = ''; historyPast.push(previous); if (historyPast.length > 100) historyPast.shift();
      historyFuture.length = 0; historyCurrent = copy(C.shareableProject(project)); C.setProject(project);
      persist(`Load Chaser project ${file.name || ''}`.trim()); renderAll();
      renderConnectionState('Local project');
      setSaveState('saved', `Loaded ${file.name || 'project'}${parsed.warnings?.length ? ` · ${parsed.warnings.length} notice(s)` : ''}`);
      if (parsed.warnings?.length) $('#chConnection').textContent = parsed.warnings.join(' · ');
    } catch (error) {
      if (request !== projectLoadRequest || epoch !== documentEpoch) return;
      setSaveState('error', error.message || 'Project load failed');
      console.error('SHOWAVE Chaser project load', error);
    } finally {
      const input = $('#chProjectFileInput'); if (input && request === projectLoadRequest) input.value = '';
    }
  }

  function reconciliationLoss(report) {
    const retired = report && (report.retiredIds || report.retired) || [];
    const unmatched = report && (report.unmatchedIds || report.unmatched) || [];
    return {retired:Array.isArray(retired) ? retired.length : Number(retired) || 0,
      unmatched:Array.isArray(unmatched) ? unmatched.length : Number(unmatched) || 0};
  }

  function applyLiveMap(nextMap, options) {
    if (!nextMap || !nextMap.screens || !nextMap.screens.length) return false;
    const reconciled = C.reconcileMap ? C.reconcileMap(project, nextMap)
      : {project:C.adoptMap(project, nextMap), report:{matchedIds:[], newIds:[], retiredIds:[], unmatchedIds:[]}};
    const loss = reconciliationLoss(reconciled.report), explicit = !!(options && options.explicit);
    if (!explicit && loss.retired) {
      pendingLiveMap = C.normaliseMap(nextMap); currentMapLive = false;
      $('#chConnection').textContent = `SHOWAVE Map changed · relink required (${loss.retired} retired)`;
      setSaveState('error', 'Live map needs relinking');
      return false;
    }
    if (explicit && loss.retired) {
      const accepted = window.confirm(`The new map retires ${loss.retired} authored slice${loss.retired === 1 ? '' : 's'}. Relink anyway? You can Undo this change.`);
      if (!accepted) return false;
    }
    const before = C.mapSignature(project.map);
    project = reconciled.project; pendingLiveMap = null; currentMapLive = true;
    sliceListSignature = '';
    const report = reconciled.report || {}, matched = (report.matchedIds || []).length;
    const fresh = (report.newIds || report.new || []).length;
    if (C.mapSignature(project.map) !== before || explicit)
      commit(options && options.reason || 'Relink SHOWAVE Map slices');
    else renderAll();
    $('#chConnection').textContent = `SHOWAVE Map live · ${C.flatSlices(project.map).length} slices${matched || fresh ? ` · ${matched} matched, ${fresh} new` : ''}`;
    return true;
  }

  function relinkLiveMap() {
    if (pendingResolumeMap) return applyPresetMap(pendingResolumeMap.map,
      pendingResolumeMap.name, {path:pendingResolumeMap.path});
    const live = pendingLiveMap || C.liveMap || Bus && Bus.sliceTree && C.normaliseMap(Bus.sliceTree);
    if (!live || !live.screens || !live.screens.length) {
      setSaveState('error', 'No live SHOWAVE Map to relink'); return false;
    }
    return applyLiveMap(live, {explicit:true, reason:'Relink SHOWAVE Map slices'});
  }

  function newCheckered() {
    disconnectProjectFile(); projectLoadRequest++; followResolume = false; syncResolumeFollowControl();
    const envelopes = copy(project.envelopes);
    stopPlayback(false); project = C.createProject(C.checkeredMap(8, 8)); currentMapLive = false;
    project.envelopes = envelopes; project.activeEnvelopeId = envelopes[0]?.id;
    pendingLiveMap = publishedLiveMap();
    playhead = 0; sliceListSignature = ''; commit('New Checkered Chaser project');
    renderConnectionState('Checkered starter project');
  }

  function newFromLiveMap() {
    const live = publishedLiveMap();
    if (!live?.screens?.length) { setSaveState('error', 'Open SHOWAVE Map or load a Resolume preset first'); return; }
    disconnectProjectFile(); projectLoadRequest++; followResolume = false; syncResolumeFollowControl();
    const envelopes = copy(project.envelopes);
    stopPlayback(false); project = C.createProject(live);
    project.envelopes = envelopes; project.activeEnvelopeId = envelopes[0]?.id;
    currentMapLive = true; pendingLiveMap = null; pendingResolumeMap = null;
    playhead = 0; sliceListSignature = ''; commit('New Chaser from SHOWAVE Map'); renderConnectionState();
  }

  function syncResolumeFollowControl() {
    const button = document.querySelector('[data-action="follow-resolume"]');
    if (button) { button.setAttribute('aria-checked', String(followResolume));
      button.textContent = followResolume ? 'Stop Following Resolume Map' : 'Follow Resolume Map Changes'; }
  }

  function applyPresetMap(map, name, options = {}) {
    if (!map?.screens?.length || !C.flatSlices(map).length) throw new Error('This preset has no video slices to chase.');
    const reconciled = C.reconcileMap(project, map), loss = reconciliationLoss(reconciled.report);
    if (loss.retired) {
      if (options.automatic) {
        pendingResolumeMap = {map, name, path:options.path}; followResolume = false; syncResolumeFollowControl();
        $('#chConnection').textContent = `Resolume Map changed · ${loss.retired} retired slices · choose Relink Map`;
        return false;
      }
      if (!window.confirm(`This map retires ${loss.retired} authored slice${loss.retired === 1 ? '' : 's'}. Relink? You can Undo this change.`)) return false;
    }
    stopPlayback(true); project = reconciled.project;
    if (options.path) project.nativeReference = Object.assign({}, project.nativeReference || {}, {assFile:options.path});
    pendingResolumeMap = null; currentMapLive = false; pendingLiveMap = publishedLiveMap();
    sliceListSignature = ''; canvasZoom = 1; canvasPanX = 0; canvasPanY = 0;
    commit(`Load Resolume map ${name || ''}`.trim());
    $('#chConnection').textContent = `${name || 'Resolume Map'} · ${C.flatSlices(project.map).length} slices${followResolume ? ' · following changes' : ''}`;
    return true;
  }

  async function importMapFile(file) {
    if (!file) return;
    const epoch = documentEpoch;
    try {
      const map = Native.parseAdvancedOutput(await file.text(), file.name);
      if (epoch !== documentEpoch) return;
      followResolume = false; syncResolumeFollowControl(); applyPresetMap(map, file.name);
    } catch (error) { if (epoch === documentEpoch) setSaveState('error', `Map import failed: ${error.message || error}`); }
    finally { $('#chMapFileInput').value = ''; }
  }

  async function loadCurrentResolumeMap(automatic = false) {
    if (resolumeChecking) return;
    resolumeChecking = true;
    const epoch = documentEpoch;
    try {
      const response = await fetch('/api/chaser/current-map', {cache:'no-store', credentials:'omit',
        signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('The current-map helper is unavailable; import an Advanced Output XML preset.');
      const result = await response.json();
      if (epoch !== documentEpoch || automatic && !followResolume) return;
      if (!result.available) throw new Error(result.message || 'Save an Advanced Output setup in Resolume first.');
      if (automatic && result.revision === resolumeRevision) return;
      const map = Native.parseAdvancedOutput(result.xml, result.name);
      if (applyPresetMap(map, result.name, {path:result.path, automatic})) resolumeRevision = result.revision;
    } catch (error) {
      if (epoch === documentEpoch && !automatic) setSaveState('error', error.message || 'Resolume map could not be loaded');
    } finally { resolumeChecking = false; }
  }

  function toggleResolumeFollow() {
    followResolume = !followResolume; syncResolumeFollowControl();
    if (followResolume) { resolumeRevision = ''; loadCurrentResolumeMap(false); }
    else renderConnectionState('Resolume map · follow paused');
  }

  async function loadStartupResolumeMap() {
    const epoch = documentEpoch, signature = projectContentSignature(project);
    try {
      const response = await fetch('/api/chaser/current-map', {cache:'no-store', credentials:'omit',
        signal:AbortSignal.timeout(10000)});
      if (!response.ok) return;
      const result = await response.json();
      if (!result.available || epoch !== documentEpoch || signature !== projectContentSignature(project) ||
          Hub?.get('chaser.project', null) || publishedLiveMap()?.screens?.length) return;
      const map = Native.parseAdvancedOutput(result.xml, result.name), envelopes = copy(project.envelopes);
      project = C.createProject(map); project.envelopes = envelopes; project.activeEnvelopeId = envelopes[0]?.id;
      project.nativeReference = {assFile:result.path};
      followResolume = true; resolumeRevision = result.revision; syncResolumeFollowControl();
      playhead = 0; sliceListSignature = ''; commit('Open current Resolume map');
      $('#chConnection').textContent = `${result.name} · ${C.flatSlices(project.map).length} slices · following changes`;
    } catch (_) { /* A standalone or disconnected browser retains the Checkered starter. */ }
  }

  function adoptLiveMap(force) {
    const live = C.liveMap || Bus && Bus.sliceTree && C.normaliseMap(Bus.sliceTree);
    if (!live || !live.screens.length) {
      $('#chConnection').textContent = 'SHOWAVE Map has not published slices';
      if (force) setSaveState('error', 'No live map yet');
      return false;
    }
    return applyLiveMap(live, {explicit:!!force, reason:'Adopt SHOWAVE Map slices'});
  }

  function openShowaveMap() {
    try {
      if (window.parent && window.parent !== window && typeof window.parent.__openliveOpenPanel === 'function') {
        window.parent.__openliveOpenPanel('advanced-output.html'); return;
      }
    } catch (_) {}
    window.open('advanced-output.html', 'showaveMap');
  }

  function bindMenus() {
    const menus = {file:$('#chMenuFile'), edit:$('#chMenuEdit'), sequence:$('#chMenuSequence'), view:$('#chMenuView')};
    const triggers = [...document.querySelectorAll('[data-ch-menu]')];
    let activeTrigger = null;
    const close = restoreFocus => {
      Object.values(menus).forEach(menu => { menu.hidden = true; });
      triggers.forEach(trigger => {
        trigger.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false');
      });
      const previous = activeTrigger; activeTrigger = null;
      if (restoreFocus && previous) previous.focus();
    };
    const open = (button, focusIndex) => {
      close(false); const menu = menus[button.dataset.chMenu];
      const rect = button.getBoundingClientRect(); activeTrigger = button;
      menu.style.left = rect.left + 'px'; menu.style.top = rect.bottom + 2 + 'px'; menu.hidden = false;
      button.classList.add('open'); button.setAttribute('aria-expanded', 'true');
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      if (items.length) items[focusIndex == null || focusIndex >= 0 ? focusIndex || 0 : items.length - 1].focus();
    };
    const adjacentTrigger = (button, delta) => triggers[(triggers.indexOf(button) + delta + triggers.length) % triggers.length];
    triggers.forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation(); const wasOpen = button === activeTrigger && !menus[button.dataset.chMenu].hidden;
        if (wasOpen) close(true); else open(button, 0);
      });
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); open(button, event.key === 'ArrowUp' ? -1 : 0); return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); adjacentTrigger(button, event.key === 'ArrowLeft' ? -1 : 1).focus();
        }
      });
    });
    Object.entries(menus).forEach(([name, menu]) => menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key === 'Home' || event.key === 'End' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        if (items[next]) items[next].focus(); return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const trigger = activeTrigger || triggers.find(node => node.dataset.chMenu === name);
        open(adjacentTrigger(trigger, event.key === 'ArrowLeft' ? -1 : 1), 0);
      }
    }));
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('.ch-menu,[data-ch-menu]')) close(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && activeTrigger) { event.preventDefault(); close(true); }
    });
    document.querySelectorAll('.ch-menu [data-action]').forEach(button => button.addEventListener('click', () => {
      const actions = {
        'new-map':newFromLiveMap, 'new-checkered':newCheckered, 'export-map':exportPixelMap,
        'current-resolume-map':() => loadCurrentResolumeMap(false),
        'import-map':() => $('#chMapFileInput').click(), 'follow-resolume':toggleResolumeFollow,
        'save-current':() => saveProjectCopy(projectFileKind, false),
        'save-project':() => saveProjectCopy('project', true),
        'save-native':() => saveProjectCopy('native', true), 'load-project':() => $('#chProjectFileInput').click(),
        'relink-map':relinkLiveMap, 'undo':undo, 'redo':redo,
        'copy-step':copyCurrentStep, 'paste-step':pasteCurrentStep,
        'invert-step':invertCurrentStep, 'clear-step':clearCurrentStep,
        'add-sequence':() => addSequence(false), 'duplicate-sequence':() => addSequence(true),
        'remove-sequence':removeSequence, 'clear-sequence':clearSequence,
        'generate-factory':generateFactory, 'shuffle-steps':shuffleSequence,
        'sidebar-sequences':() => setSidebarMode('sequences'), 'sidebar-views':() => setSidebarMode('views'),
        'mode-chase':() => setMode('chase'), 'mode-pixelmap':() => setMode('pixelmap'),
        'mode-envelope':() => setMode('envelope'), 'show-all':() => setAllViewVisibility(true),
        'hide-all':() => setAllViewVisibility(false), 'fit-map':fitCanvas
      };
      close(true); if (actions[button.dataset.action]) actions[button.dataset.action]();
    }));
  }

  function bindControls() {
    if (controlsBound) return; controlsBound = true;
    $('#chModeChase').addEventListener('click', () => setMode('chase'));
    $('#chModeMap').addEventListener('click', () => setMode('pixelmap'));
    $('#chModeEnvelope').addEventListener('click', () => setMode('envelope'));
    $('#chUndo').addEventListener('click', undo);
    $('#chRedo').addEventListener('click', redo);
    $('#chFactoryToggle').addEventListener('click', event => {
      const opened = event.currentTarget.getAttribute('aria-pressed') !== 'true';
      event.currentTarget.setAttribute('aria-pressed', String(opened));
      event.currentTarget.classList.toggle('on', opened);
      if (opened && project.mode !== 'chase') { project.mode = 'chase'; sidebarMode = 'sequences'; }
      renderAll();
      if (opened) requestAnimationFrame(() => $('#chFactorySection').scrollIntoView({block:'start'}));
    });
    $('#chPlay').addEventListener('click', togglePlayback);
    $('#chPrevious').addEventListener('click', () => setStep(activeStepIndex() - 1));
    $('#chNext').addEventListener('click', () => setStep(activeStepIndex() + 1));
    $('#chReset').addEventListener('click', () => setStep(0, 'Reset chase'));
    $('#chFit').addEventListener('click', fitCanvas);
    $('#chOpenMap').addEventListener('click', openShowaveMap);
    $('#chAddSequence').addEventListener('click', () => addSequence(false));
    $('#chDuplicateSequence').addEventListener('click', () => addSequence(true));
    $('#chRemoveSequence').addEventListener('click', removeSequence);
    $('#chSidebarSequences').addEventListener('click', () => setSidebarMode('sequences'));
    $('#chSidebarViews').addEventListener('click', () => setSidebarMode('views'));
    $('#chSidebarEnvelopes').addEventListener('click', () => setSidebarMode('envelopes'));
    $('#chAddView').addEventListener('click', event => addView(false, event.altKey));
    $('#chDuplicateView').addEventListener('click', () => addView(true, false));
    $('#chRemoveView').addEventListener('click', removeView);
    $('#chShowAllView').addEventListener('click', () => setAllViewVisibility(true));
    $('#chHideAllView').addEventListener('click', () => setAllViewVisibility(false));
    $('#chAddEnvelope').addEventListener('click', () => addEnvelope(false));
    $('#chDuplicateEnvelope').addEventListener('click', () => addEnvelope(true));
    $('#chRemoveEnvelope').addEventListener('click', removeEnvelope);
    $('#chPreviousSequence').addEventListener('click', () => {
      const index = project.sequences.findIndex(sequence => sequence.id === project.activeSequenceId);
      selectSequence(project.sequences[(index - 1 + project.sequences.length) % project.sequences.length].id);
    });
    $('#chNextSequence').addEventListener('click', () => {
      const index = project.sequences.findIndex(sequence => sequence.id === project.activeSequenceId);
      selectSequence(project.sequences[(index + 1) % project.sequences.length].id);
    });
    $('#chAddStep').addEventListener('click', () => resizeSteps(activeSequence().steps.length + 1));
    $('#chRemoveStep').addEventListener('click', () => resizeSteps(activeSequence().steps.length - 1));
    $('#chStepCount').addEventListener('change', event => resizeSteps(event.target.value));
    $('#chFillRepeat').addEventListener('click', () => fillSequence(false));
    $('#chFillBounce').addEventListener('click', () => fillSequence(true));
    $('#chClearSequence').addEventListener('click', clearSequence);
    $('#chSequenceIndex').addEventListener('change', event => {
      const index = clamp(Math.round(Number(event.target.value) || 1) - 1, 0, project.sequences.length - 1);
      selectSequence(project.sequences[index].id);
    });
    $('#chFactoryGenerate').addEventListener('click', () => generateFactory());
    $('#chFactoryShuffle').addEventListener('click', shuffleSequence);
    $('#chFactoryReset').addEventListener('click', resetFactory);
    ['#chFactoryDirection','#chFactoryColumns','#chFactoryRows','#chFactoryBlock','#chFactoryModulo',
      '#chFactoryFlipX','#chFactoryFlipY','#chFactoryMirrorX','#chFactoryMirrorY'].forEach(selector =>
      $(selector).addEventListener('change', () => {
        if (selector === '#chFactoryColumns') {
          activeSequence().factory.gridX = []; activeSequence().factory.gridXEdited = false;
        }
        if (selector === '#chFactoryRows') {
          activeSequence().factory.gridY = []; activeSequence().factory.gridYEdited = false;
        }
        generateFactory('Update Factory chase');
      }));
    $('#chEnvelopeName').addEventListener('change', event => {
      activeEnvelope().name = event.target.value.trim() || 'Envelope'; commit('Rename Envelope');
    });
    const setEnvelopeCoordinate = (key, value) => {
      const selected = selectedEnvelopePoints(); if (selected.length !== 1) return;
      const point = selected[0], ordered = activeEnvelope().points.slice().sort((a,b) => a.x - b.x);
      if (key === 'x' && (point === ordered[0] || point === ordered[ordered.length - 1])) return;
      const next = clamp(Number(value) || 0, 0, 1);
      const delta = next - point[key]; point[key] = next;
      if (key === 'x') {
        point.inX = clamp(point.inX + delta, 0, 1); point.outX = clamp(point.outX + delta, 0, 1);
        activeEnvelope().points.sort((a,b) => a.x - b.x);
      } else { point.inY = clamp(point.inY + delta, 0, 1); point.outY = clamp(point.outY + delta, 0, 1); }
      commit('Set Envelope anchor coordinate');
    };
    $('#chEnvelopePointX').addEventListener('change', event => setEnvelopeCoordinate('x', event.target.value));
    $('#chEnvelopePointY').addEventListener('change', event => setEnvelopeCoordinate('y', event.target.value));
    $('#chEnvelopeSegmentLinear').addEventListener('click', () => {
      const selected = selectedEnvelopePoints(); if (!selected.length) return;
      const next = !selected.every(point => point.linear); selected.forEach(point => { point.linear = next; });
      commit(next ? 'Make Envelope segment linear' : 'Make Envelope segment Bezier');
    });
    $('#chEnvelopeReset').addEventListener('click', resetEnvelope);
    $('#chToolSelect').addEventListener('click', () => setCanvasTool('select'));
    $('#chToolPan').addEventListener('click', () => setCanvasTool('pan'));
    $('#chZoomOut').addEventListener('click', () => setCanvasZoom(canvasZoom / 1.25));
    $('#chZoomIn').addEventListener('click', () => setCanvasZoom(canvasZoom * 1.25));
    $('#chZoomFit').addEventListener('click', fitCanvas);
    bindCanvasZoomEditor();
    $('#chProjectFileInput').addEventListener('change', event => loadProjectFile(event.target.files && event.target.files[0]));
    $('#chMapFileInput').addEventListener('change', event => importMapFile(event.target.files && event.target.files[0]));
    $('#chExportMap').addEventListener('click', exportPixelMap);
    $('#chExClose').addEventListener('click', closeExportStudio);
    $('#chExCloseFooter').addEventListener('click', closeExportStudio);
    $('#chExChooseFolder').addEventListener('click', chooseExportFolder);
    $('#chExDownloadCurrent').addEventListener('click', exportCurrentPng);
    $('#chExSaveAll').addEventListener('click', exportAllMaps);
    $('#chExClearSelection').addEventListener('click', () => {
      exportSelection.clear(); exportSelectionChanged();
    });
    $('#chExApplySelected').addEventListener('change', () => {
      syncExportControls(); exportRequestPaint();
    });
    $('#chExResetSelected').addEventListener('click', resetSelectedExportStyles);
    $('#chExZoomOut').addEventListener('click', () => {
      exportZoom = clamp(exportZoom / 1.25, .25, 8); renderExportChrome(); exportRequestPaint();
    });
    $('#chExZoomIn').addEventListener('click', () => {
      exportZoom = clamp(exportZoom * 1.25, .25, 8); renderExportChrome(); exportRequestPaint();
    });
    $('#chExZoomFit').addEventListener('click', () => {
      exportZoom = 1; renderExportChrome(); exportRequestPaint();
    });
    $('#chExScale').addEventListener('change', event => {
      exportSettings.scale = Number(event.target.value);
      exportSettings = E.normaliseSettings(exportSettings, project);
      persistExportSettings('Set Pixel Map export scale'); renderExportChrome(); exportRequestPaint();
    });
    document.querySelectorAll('[data-ex-section][data-ex-key]').forEach(node => {
      const update = () => {
        let value = node.type === 'checkbox' ? node.checked : node.value;
        if (node.type === 'number' || node.type === 'range') value = Number(value);
        setExportSetting(node.dataset.exSection, node.dataset.exKey, value);
      };
      node.addEventListener(node.type === 'range' || node.type === 'color' ? 'input' : 'change', update);
    });
    document.querySelectorAll('[data-ex-reset]').forEach(button => button.addEventListener('click', () =>
      resetExportProperty(button.dataset.exReset)));
    document.querySelectorAll('[data-ex-reset-section]').forEach(button => button.addEventListener('click', () =>
      resetExportSection(button.dataset.exResetSection)));
    $('#chExLogoFile').addEventListener('change', event => importExportLogo(event.target.files && event.target.files[0]));
    $('#chExRemoveLogo').addEventListener('click', removeExportLogo);
    $('#chExportOverlay').addEventListener('pointerdown', event => {
      if (event.target === $('#chExportOverlay')) closeExportStudio();
    });
    document.addEventListener('keydown', exportDialogKeydown);
    exportCanvas.addEventListener('pointerdown', event => {
      if (!exportOpen || exportBusy || event.button !== 0) return;
      const point = exportPoint(event);
      exportLasso = {start:point, end:point, dragging:false,
        additive:event.shiftKey || event.ctrlKey || event.metaKey, pointerId:event.pointerId};
      exportCanvas.setPointerCapture(event.pointerId); event.preventDefault();
    });
    exportCanvas.addEventListener('pointermove', event => {
      if (!exportLasso || exportLasso.pointerId !== event.pointerId) return;
      exportLasso.end = exportPoint(event);
      exportLasso.dragging = exportLasso.dragging ||
        Math.hypot(exportLasso.end.x - exportLasso.start.x, exportLasso.end.y - exportLasso.start.y) > 5;
      if (exportLasso.dragging) exportRequestPaint();
    });
    exportCanvas.addEventListener('pointerup', event => {
      if (!exportLasso || exportLasso.pointerId !== event.pointerId) return;
      const gesture = exportLasso; exportLasso = null;
      if (exportCanvas.hasPointerCapture(event.pointerId)) exportCanvas.releasePointerCapture(event.pointerId);
      if (gesture.dragging && exportLayout) {
        const left = Math.min(gesture.start.x, gesture.end.x), right = Math.max(gesture.start.x, gesture.end.x);
        const top = Math.min(gesture.start.y, gesture.end.y), bottom = Math.max(gesture.start.y, gesture.end.y);
        if (!gesture.additive) exportSelection.clear();
        exportLayout.slices.forEach(slice => {
          if (slice.box.x <= right && slice.box.x + slice.box.w >= left &&
              slice.box.y <= bottom && slice.box.y + slice.box.h >= top) exportSelection.add(slice.id);
        });
        exportSelectionChanged();
      } else {
        const hit = exportHit(gesture.end);
        selectExportSlice(hit && hit.id, gesture.additive);
      }
    });
    exportCanvas.addEventListener('pointercancel', () => { exportLasso = null; exportRequestPaint(); });
    exportCanvas.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); exportTarget.slices.forEach(slice => exportSelection.add(slice.id));
        exportSelectionChanged();
      }
    });
    $('#chProjectName').addEventListener('change', event => {
      project.name = event.target.value.trim() || 'Untitled Chase'; commit('Rename Chaser project');
    });
    $('#chSequenceName').addEventListener('change', event => {
      activeSequence().name = event.target.value.trim() || 'Sequence'; commit('Rename sequence');
    });
    $('#chBpm').addEventListener('change', event => {
      project.playback.bpm = clamp(Number(event.target.value) || 120, 20, 300); playOrigin = null;
      if (project.playback.playing) startPlayback(); commit('Set Chaser BPM');
    });
    $('#chRate').addEventListener('change', event => {
      project.playback.stepsPerBeat = event.target.value; playOrigin = null;
      if (project.playback.playing) startPlayback(); commit('Set Chaser rate');
    });
    $('#chDirection').addEventListener('change', event => {
      project.playback.direction = event.target.value; playOrigin = null;
      if (project.playback.playing) startPlayback(); commit('Set Chaser direction');
    });
    [['#chNumX','numX'],['#chNumY','numY']].forEach(([selector,key]) =>
      $(selector).addEventListener('change', event => {
        project.pixelMap[key] = clamp(Math.round(Number(event.target.value) || 8), 1, 128); commit('Edit Checkered grid');
      }));
    [['#chColor1','color1'],['#chColor2','color2'],['#chGridColor','gridColor']].forEach(([selector,key]) =>
      $(selector).addEventListener('input', event => { project.pixelMap[key] = hexToPacked(event.target.value); commit('Edit Pixel Map color'); }));
    $('#chShowLabels').addEventListener('change', event => { project.pixelMap.showLabels = event.target.checked; commit('Toggle Pixel Map labels'); });
    $('#chTransparent').addEventListener('change', event => { project.pixelMap.transparent = event.target.checked; commit('Toggle Pixel Map transparency'); });
    document.querySelectorAll('.ch-inspector .sect > h3').forEach(heading => {
      const toggle = () => {
        const folded = heading.parentElement.classList.toggle('folded');
        heading.setAttribute('aria-expanded', String(!folded));
      };
      heading.tabIndex = 0; heading.setAttribute('role','button'); heading.setAttribute('aria-expanded','true');
      heading.addEventListener('click', toggle);
      heading.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
    });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      const point = canvasPoint(event), wantsPan = event.button === 1 || canvasTool === 'pan' || spacePan;
      if (wantsPan) {
        canvasGesture = {type:'pan',pointerId:event.pointerId,start:point,panX:canvasPanX,panY:canvasPanY};
        canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; event.preventDefault(); return;
      }
      if (project.mode === 'envelope') { beginEnvelopeGesture(event, point); event.preventDefault(); return; }
      if (project.mode !== 'chase') return;
      const factoryBoundary = hitFactoryGrid(point);
      if (factoryBoundary) {
        canvasGesture = Object.assign({type:'factory-grid',pointerId:event.pointerId,changed:false,
          duplicate:event.altKey}, factoryBoundary);
        factoryGridSelection = {axis:factoryBoundary.axis, index:factoryBoundary.index};
        canvas.setPointerCapture(event.pointerId); event.preventDefault(); return;
      }
      const visibility = event.altKey;
      factoryGridSelection = null;
      if (!visibility && project.playback.playing) stopPlayback(true);
      altVisibilityPreview = visibility;
      const hit = hitSlicePoint(point, visibility);
      canvasGesture = {type:hit ? 'snake' : 'lasso',pointerId:event.pointerId,start:point,end:point,
        mode:gestureMode(event),visibility,touched:new Set(),changed:false};
      if (hit) mutateGestureSlice(hit.id, canvasGesture);
      canvas.setPointerCapture(event.pointerId); event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
      const point = canvasPoint(event);
      if (envelopeGesture && envelopeGesture.pointerId === event.pointerId) {
        moveEnvelopeGesture(event, point); event.preventDefault(); return;
      }
      if (canvasGesture && canvasGesture.pointerId === event.pointerId) {
        if (canvasGesture.type === 'pan') {
          canvasPanX = canvasGesture.panX + point.x - canvasGesture.start.x;
          canvasPanY = canvasGesture.panY + point.y - canvasGesture.start.y; requestPaint();
        } else if (canvasGesture.type === 'factory-grid') moveFactoryGrid(point);
        else if (canvasGesture.type === 'snake') {
          const hit = hitSlicePoint(point, canvasGesture.visibility);
          if (hit) mutateGestureSlice(hit.id, canvasGesture);
        } else if (canvasGesture.type === 'lasso') { canvasGesture.end = point; requestPaint(); }
        event.preventDefault(); return;
      }
      altVisibilityPreview = event.altKey;
      const next = (hitSlice(event, altVisibilityPreview) || {}).id || null;
      if (next !== hoverId) { hoverId = next; requestPaint(); }
    });
    canvas.addEventListener('pointerup', event => {
      if (envelopeGesture) finishEnvelopeGesture(event);
      else if (canvasGesture && canvasGesture.type === 'pan') finishPanGesture(event);
      else if (canvasGesture && canvasGesture.type === 'factory-grid') finishFactoryGesture(event);
      else finishCanvasGesture(event);
    });
    canvas.addEventListener('pointercancel', event => {
      if (envelopeGesture) finishEnvelopeGesture(event);
      else if (canvasGesture && canvasGesture.type === 'pan') finishPanGesture(event);
      else if (canvasGesture && canvasGesture.type === 'factory-grid') finishFactoryGesture(event);
      else finishCanvasGesture(event);
      canvas.style.cursor = canvasTool === 'pan' ? 'grab' : 'crosshair';
    });
    canvas.addEventListener('pointerleave', () => { if (!canvasGesture && !envelopeGesture) { hoverId = null; requestPaint(); } });
    canvas.addEventListener('dblclick', envelopeDoubleClick);
    canvas.addEventListener('wheel', event => {
      if (!event.ctrlKey && Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault(); setCanvasZoom(canvasZoom * Math.exp(-event.deltaY * .0015), canvasPoint(event));
    }, {passive:false});
    const isTyping = target => target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    document.addEventListener('keydown', event => {
      if (event.key === 'Alt') { altVisibilityPreview = true; requestPaint(); }
      if (!exportOpen && !event.defaultPrevented && (event.ctrlKey || event.metaKey)) {
        const command = event.key.toLowerCase();
        if (command === 's') { event.preventDefault(); saveProjectCopy(projectFileKind, event.shiftKey); return; }
        if (command === 'o') { event.preventDefault(); $('#chProjectFileInput').click(); return; }
      }
      if (exportOpen || event.defaultPrevented || isTyping(event.target)) return;
      const interactive = event.target !== canvas && event.target && event.target.closest &&
        event.target.closest('button,a,[role="menuitem"],[role="tab"],[role="treeitem"],[role="option"]');
      const authoringOption = event.target?.closest?.('#chSteps .ch-step,#chSequenceList .ch-sequence-row,#chViewList .ch-view-row');
      if (interactive && !authoringOption) return;
      const key = event.key.toLowerCase(), modified = event.ctrlKey || event.metaKey;
      if (modified && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (modified && (key === 'y')) { event.preventDefault(); redo(); return; }
      if (modified && key === 'c') { event.preventDefault(); copyCurrentStep(); return; }
      if (modified && key === 'v') { event.preventDefault(); pasteCurrentStep(); return; }
      if (modified && key === 'i') { event.preventDefault(); invertCurrentStep(); return; }
      if (factoryIsOpen() && factoryGridSelection && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        const key = factoryGridSelection.axis === 'x' ? 'gridX' : 'gridY', factory = activeSequence().factory;
        if (factory[key]?.[factoryGridSelection.index] != null) {
          factory[key].splice(factoryGridSelection.index, 1);
          factory[key === 'gridX' ? 'gridXEdited' : 'gridYEdited'] = true;
          factoryGridSelection = null; generateFactory('Remove Factory grid border');
        }
        return;
      }
      if (project.mode === 'chase' && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault(); clearCurrentStep(); return;
      }
      if (modified && (event.key === '+' || event.key === '=')) { event.preventDefault(); setCanvasZoom(canvasZoom * 1.25); return; }
      if (modified && event.key === '-') { event.preventDefault(); setCanvasZoom(canvasZoom / 1.25); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (envelopeGesture) finishEnvelopeGesture();
        else if (canvasGesture && canvasGesture.type === 'pan') finishPanGesture();
        else if (canvasGesture && canvasGesture.type === 'factory-grid') finishFactoryGesture();
        else if (canvasGesture) finishCanvasGesture();
        else requestPaint();
        return;
      }
      if (key === 'v') { setCanvasTool('select'); return; }
      if (key === 'h') { setCanvasTool('pan'); return; }
      if (event.key === ' ' && (document.activeElement === canvas || canvas.matches(':hover'))) {
        event.preventDefault(); spacePan = true; canvas.style.cursor = 'grab'; return;
      }
      if (project.mode === 'envelope' && (event.key === 'Delete' || event.key === 'Backspace')) {
        const envelope = activeEnvelope(), sorted = envelope.points.slice().sort((a,b)=>a.x-b.x);
        const removable = new Set(sorted.slice(1,-1).filter(point => envelopeSelection.has(point.id)).map(point => point.id));
        if (removable.size) {
          event.preventDefault(); envelope.points = envelope.points.filter(point => !removable.has(point.id));
          removable.forEach(id => envelopeSelection.delete(id)); commit('Remove Envelope anchors');
        }
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (event.altKey) { if (event.key === 'ArrowUp') removeSequence(); else addSequence(false); }
        else {
          const index = project.sequences.findIndex(sequence => sequence.id === project.activeSequenceId);
          const delta = event.key === 'ArrowUp' ? -1 : 1;
          selectSequence(project.sequences[(index + delta + project.sequences.length) % project.sequences.length].id);
        }
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (event.altKey) resizeSteps(activeSequence().steps.length + (event.key === 'ArrowLeft' ? -1 : 1));
        else setStep(activeStepIndex() + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    });
    document.addEventListener('keyup', event => {
      if (event.key === ' ') { spacePan = false; if (!canvasGesture) canvas.style.cursor = canvasTool === 'pan' ? 'grab' : 'crosshair'; }
      if (event.key === 'Alt') { altVisibilityPreview = false; requestPaint(); }
    });
    window.addEventListener('resize', () => { requestPaint(); exportRequestPaint(); });
    window.addEventListener('pagehide', () => {
      stopPlayback(false);
      if (saveTimer) flushPersist(pendingSaveReason || 'Close SHOWAVE Chaser');
    });
    window.addEventListener('beforeunload', event => {
      if (projectSavePending || fileSaving || fileSaveTimer || projectFileWriter && diskSignature !== projectContentSignature(project)) {
        event.preventDefault(); event.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', () => { if (operatorViewActive()) requestPaint(); });
    window.addEventListener('showave:workspace-visibility', () => { if (operatorViewActive()) requestPaint(); });
    window.addEventListener('showave:shared-view-frame', () => {
      if (!document.hidden || !window.__showaveWorkspaceDetached) return;
      if (project.playback.playing || paintFrame) {
        if (paintFrame) cancelAnimationFrame(paintFrame);
        paintFrame = 0; paint(performance.now());
      }
      if (exportOpen && exportFrame) {
        cancelAnimationFrame(exportFrame); exportFrame = 0; paintExport();
      }
    });
    window.addEventListener('openlive:appearancechange', () => { requestPaint(); exportRequestPaint(); });
    bindMenus();
  }

  if (Hub && Hub.subscribe) Hub.subscribe('chaser.project', value => {
    if (!value) return;
    const incoming = C.shareableProject(value);
    const signature = projectSignature(incoming);
    const localSignature = projectSignature(C.shareableProject(project));
    if (signature === localSignature || signature === lastSavedSignature) return;
    if (projectContentSignature(incoming) === projectContentSignature(project)) {
      project.updatedAt = Math.max(Number(project.updatedAt) || 0, Number(incoming.updatedAt) || 0);
      lastSavedSignature = signature; return;
    }
    /* A pending local edit owns an equally-newer revision. Otherwise accept
       the remote project and cancel the queued writer so it cannot echo the
       received snapshot back through the Hub. */
    if (saveTimer && Number(project.updatedAt) >= Number(incoming.updatedAt)) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = 0; pendingSaveReason = ''; lastSavedSignature = signature;
    if (incoming.id !== project.id) { disconnectProjectFile(); projectLoadRequest++; }
    stopPlayback(false); project = incoming; playhead = project.activeStep;
    if (E) { reconcileExportSettings(true); syncExportLogoImage(); }
    syncMapLinkState();
    sliceListSignature = ''; resetHistory(); renderAll();
    renderConnectionState();
    setSaveState('saved', 'Updated from SHOWAVE');
    if (Recovery) Recovery.save({schema:'showave.chaser.document/1', project:C.shareableProject(project),
      savedAt:new Date().toISOString(), library:{envelopes:project.envelopes}});
    scheduleProjectFileSave();
  }, {immediate:false});

  if (Bus && Bus.onSlices) Bus.onSlices(tree => {
    if (!tree || !tree.screens || !tree.screens.length) return;
    const live = C.normaliseMap(tree);
    if (C.mapSignature(project.map) === C.mapSignature(live)) {
      currentMapLive = true; pendingLiveMap = null; renderAll();
      $('#chConnection').textContent = `SHOWAVE Map live · ${C.flatSlices(project.map).length} slices`;
    } else applyLiveMap(live, {explicit:false, reason:'SHOWAVE Map slices changed'});
  });

  setInterval(() => {
    const now = new Date(); $('#chClock').textContent = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    if (Bus && Bus.live && currentMapLive)
      $('#chConnection').textContent = `SHOWAVE Map live · ${C.flatSlices(project.map).length} slices`;
  }, 1000);
  setInterval(() => { if (followResolume && operatorViewActive()) loadCurrentResolumeMap(true); }, 3000);

  async function initializeChaser() {
    await window.OpenLiveSessionPolicy?.ready;
    const existing = Hub?.get('chaser.project', null);
    let recovered = false;
    if (existing) {
      project = C.shareableProject(existing);
      if (E) { reconcileExportSettings(true); syncExportLogoImage(); }
      resetHistory();
    } else if (Recovery) {
      const restored = Recovery.read();
      if (restored.ok && restored.document) {
        recovered = true;
        project = C.shareableProject(restored.document.project);
        if (restored.document.library?.envelopes?.length) project.envelopes = restored.document.library.envelopes;
        C.setProject(project);
        if (E) { reconcileExportSettings(true); syncExportLogoImage(); }
        resetHistory(); flushPersist('Restore Chaser recovery');
        setSaveState('saved', 'Recovered last Chaser session');
      } else if (!restored.ok) setSaveState('error', 'Recovery unavailable · Save Project');
    }
    playhead = project.activeStep; bindControls(); renderAll();
    if (Bus?.sliceTree && !existing) adoptLiveMap(false);
    if (Bus?.hello) Bus.hello();
    if (!existing && !recovered && !publishedLiveMap()?.screens?.length) loadStartupResolumeMap();
  }
  initializeChaser().catch(error => { setSaveState('error', error.message || 'Chaser could not initialize'); console.error(error); });
})();
