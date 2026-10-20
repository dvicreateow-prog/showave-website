/* SHOWAVE Timeline operator window. */
(function runShowaveTimelineUI(global) {
  'use strict';

  const T = global.OpenLiveTimeline;
  const Hub = global.OpenLiveHub;
  const Bus = global.ArenaBus;
  const root = document.getElementById('timelineRoot');
  if (!T || !root) return;

  /* Read-only diagnostics for a detached operator window.  A boot/runtime
     failure must remain inspectable from SHOWAVE Live instead of disappearing
     into a popup console the operator never opened. */
  global.__showaveTimelineErrors = global.__showaveTimelineErrors || [];
  global.addEventListener('error', event => {
    global.__showaveTimelineErrors.push({message:event.message,
      file:event.filename,line:event.lineno,column:event.colno,at:Date.now()});
  });
  global.addEventListener('unhandledrejection', event => {
    global.__showaveTimelineErrors.push({message:safeText(event.reason && event.reason.message || event.reason),
      unhandled:true,at:Date.now()});
  });

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const byId = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => `${prefix}:${Date.now().toString(36)}:${
    global.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const safeText = value => String(value == null ? '' : value);
  const isEditable = node => !!(node && (node.matches('input,select,textarea,[contenteditable="true"]') ||
    node.closest('input,select,textarea,[contenteditable="true"],.tl-modal-overlay.show')));

  let project = T.normaliseProject(Hub && Hub.get('timeline.project', null) ||
    T.createProject('Show Timeline'));
  let selectedTrackId = project.tracks[0] && project.tracks[0].id || null;
  const selectedTriggerIds = new Set();
  const historyPast = [], historyFuture = [];
  let historyLimit = 120;
  let pendingSaveReason = '', saveTimer = 0, lastSavedSignature = '';
  let canvasDirty = true, rulerDirty = true, overviewDirty = true;
  let graphLayout = null, overviewLayout = null, canvasGesture = null;
  let activeTool = project.view.tool || 'select';
  let viewMode = project.view.table ? 'table' : 'graph';
  let temporaryPan = false, recording = false, lastModalOpener = null;
  let runtimeState = {state:'stopped', timeMs:project.startMs, positionMs:project.startMs,
    waiting:false, source:project.options.timecodeSource, linked:project.options.linked};
  let hostSeenAt = -Infinity, lastFrameAt = performance.now();
  let previewRuntime = null, busSnapshot = Bus && Bus.snapshot || null;
  const executionStates = new Map();

  function projectSignature(value) {
    return JSON.stringify(T.shareableProject(value));
  }

  function status(message, tone) {
    const node = byId('tlStatusMessage');
    if (node) node.textContent = safeText(message || 'Ready');
    root.dataset.statusTone = tone || 'info';
  }

  function trackById(id) {
    return project.tracks.find(track => track.id === id) || null;
  }

  function triggerRecord(id) {
    return T.triggerRecords(project).find(record => record.trigger.id === id) || null;
  }

  function selectedRecords() {
    return T.triggerRecords(project).filter(record => selectedTriggerIds.has(record.trigger.id));
  }

  function ensureSelection() {
    if (selectedTrackId && !trackById(selectedTrackId)) selectedTrackId = null;
    if (!selectedTrackId && project.tracks.length) selectedTrackId = project.tracks[0].id;
    const valid = new Set(T.triggerRecords(project).map(record => record.trigger.id));
    Array.from(selectedTriggerIds).forEach(id => { if (!valid.has(id)) selectedTriggerIds.delete(id); });
  }

  function rememberHistory(previous) {
    const snapshot = T.shareableProject(previous);
    if (historyPast.length && same(historyPast[historyPast.length - 1], snapshot)) return;
    historyPast.push(snapshot);
    if (historyPast.length > historyLimit) historyPast.shift();
    historyFuture.length = 0;
  }

  function setProject(next, reason, options) {
    const opts = options || {};
    const safe = T.normaliseProject(next);
    if (same(T.shareableProject(project), T.shareableProject(safe))) return false;
    const previous = project;
    if (opts.history !== false) rememberHistory(previous);
    project = safe;
    ensureSelection();
    if (previewRuntime) previewRuntime.setProject(project, {preservePosition:true});
    markAllDirty();
    renderAll();
    if (opts.persist !== false) schedulePersist(reason || 'Timeline edited');
    return true;
  }

  function mutate(reason, change, options) {
    const draft = clone(project);
    change(draft);
    draft.updatedAt = Date.now();
    return setProject(draft, reason, options);
  }

  function undo() {
    if (!historyPast.length) return;
    historyFuture.push(T.shareableProject(project));
    project = T.normaliseProject(historyPast.pop());
    ensureSelection(); markAllDirty(); renderAll(); schedulePersist('Undo Timeline edit');
  }

  function redo() {
    if (!historyFuture.length) return;
    historyPast.push(T.shareableProject(project));
    project = T.normaliseProject(historyFuture.pop());
    ensureSelection(); markAllDirty(); renderAll(); schedulePersist('Redo Timeline edit');
  }

  function schedulePersist(reason) {
    pendingSaveReason = reason || pendingSaveReason || 'Timeline edited';
    const dot = byId('tlDirtyDot'); if (dot) dot.classList.add('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPersist, 180);
  }

  function flushPersist() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!Hub || !Hub.patch) return false;
    const shared = T.shareableProject(project);
    shared.updatedAt = Math.max(Date.now(), Number(project.updatedAt) || 0);
    project.updatedAt = shared.updatedAt;
    Hub.patch('timeline', {
      schema:T.schema,
      project:shared,
      updatedAt:shared.updatedAt
    }, {reason:pendingSaveReason || 'Timeline saved'});
    lastSavedSignature = projectSignature(shared);
    pendingSaveReason = '';
    const dot = byId('tlDirtyDot'); if (dot) dot.classList.remove('dirty');
    return true;
  }

  function markAllDirty() {
    canvasDirty = true; rulerDirty = true; overviewDirty = true;
  }

  function format(ms) { return T.formatTime(ms); }
  function parse(value, fallback) {
    const result = T.parseTime(value, project.options.fps);
    return result == null ? fallback : result;
  }

  function totalTriggerCount() {
    return project.tracks.reduce((total, track) => total + track.triggers.length, 0);
  }

  function markerCount() {
    return T.markerRecords(project).length;
  }

  function targetIndex(target, name, fallback) {
    const source = target || {};
    for (const value of [source[`${name}Index`], source[name], source.index]) {
      const number = Number(value);
      if (Number.isFinite(number)) return Math.max(0, Math.round(number));
    }
    return fallback == null ? 0 : fallback;
  }

  function structure() {
    const fromBus = busSnapshot && busSnapshot.structure || {};
    const composition = Hub && Hub.get('composition', {}) || {};
    const count = (list, fallback) => Array.isArray(list) && list.length ? list :
      Array.from({length:Math.max(0, Number(fallback) || 0)}, (_, index) => ({
        index:index + 1, name:''
      }));
    return {
      layers:count(fromBus.layers, composition.layerCount || 4),
      groups:count(fromBus.groups, (composition.groups || []).length),
      columns:count(fromBus.columns, composition.columnCount || 16),
      selectedLayer:Number(fromBus.selection && fromBus.selection.layer || composition.selectedLayer || 1),
      selectedColumn:Number(fromBus.selection && fromBus.selection.column || composition.selectedColumn || 1)
    };
  }

  function targetValue(target) {
    const source = target || {}, kind = safeText(source.kind || 'show').toLowerCase();
    if (kind === 'crossfader') return 'crossfader';
    if (kind === 'cue' || kind === 'column')
      return `cue:${targetIndex(source, 'cue', targetIndex(source, 'column', targetIndex(source, 'index', 1)))}`;
    if (kind === 'clip') return `clip:${targetIndex(source, 'layer', 1)}:${targetIndex(source, 'column', 1)}`;
    if (kind === 'layer') return `layer:${targetIndex(source, 'layer', targetIndex(source, 'index', 1))}`;
    if (kind === 'group') return `group:${targetIndex(source, 'group', targetIndex(source, 'index', 1))}`;
    return 'show';
  }

  function parseTarget(value) {
    const parts = safeText(value || 'show').split(':');
    if (parts[0] === 'crossfader') return {kind:'crossfader'};
    if (parts[0] === 'cue') return {kind:'cue', cueIndex:Math.max(0, Number(parts[1]) || 0)};
    if (parts[0] === 'clip') return {kind:'clip', layerIndex:Math.max(1, Number(parts[1]) || 1),
      columnIndex:Math.max(1, Number(parts[2]) || 1)};
    if (parts[0] === 'layer') return {kind:'layer', layerIndex:Math.max(1, Number(parts[1]) || 1)};
    if (parts[0] === 'group') return {kind:'group', groupIndex:Math.max(1, Number(parts[1]) || 1)};
    return {kind:'show'};
  }

  function targetLabel(target) {
    const model = structure(), value = targetValue(target), parts = value.split(':');
    if (parts[0] === 'show') return 'Show Master';
    if (parts[0] === 'crossfader') return 'Crossfader';
    if (parts[0] === 'cue') {
      const item = model.columns.find(column => Number(column.index) === Number(parts[1]));
      return item && item.name ? `Cue ${parts[1]} · ${item.name}` : `Cue ${parts[1]}`;
    }
    if (parts[0] === 'layer') {
      const item = model.layers.find(layer => Number(layer.index) === Number(parts[1]));
      return item && item.name ? `Layer ${parts[1]} · ${item.name}` : `Layer ${parts[1]}`;
    }
    if (parts[0] === 'group') {
      const item = model.groups.find(group => Number(group.index) === Number(parts[1]));
      return item && item.name ? `Group ${parts[1]} · ${item.name}` : `Group ${parts[1]}`;
    }
    return `Clip · Layer ${parts[1]} / Cue ${parts[2]}`;
  }

  function targetOptions(selected) {
    const model = structure(), options = [
      ['show', 'Show Master'], ['crossfader', 'Crossfader']
    ];
    model.layers.forEach(layer => options.push([`layer:${layer.index}`,
      `Layer ${layer.index}${layer.name ? ` · ${layer.name}` : ''}`]));
    model.groups.forEach(group => options.push([`group:${group.index}`,
      `Group ${group.index}${group.name ? ` · ${group.name}` : ''}`]));
    model.columns.forEach(column => options.push([`cue:${column.index}`,
      `Cue ${column.index}${column.name ? ` · ${column.name}` : ''}`]));
    const maximum = Math.min(256, model.layers.length * model.columns.length);
    let made = 0;
    for (const layer of model.layers) for (const column of model.columns) {
      if (made++ >= maximum) break;
      options.push([`clip:${layer.index}:${column.index}`,
        `Clip · Layer ${layer.index} / Cue ${column.index}`]);
    }
    const wanted = typeof selected === 'string' ? selected : targetValue(selected);
    if (wanted && !options.some(option => option[0] === wanted)) options.push([wanted, targetLabel(parseTarget(wanted))]);
    return options.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === wanted ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  }

  function escapeHtml(value) {
    return safeText(value).replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[character]);
  }

  function typeClass(type) {
    return safeText(type).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function renderTracks() {
    const list = byId('tlTrackList'); if (!list) return;
    list.innerHTML = project.tracks.length ? project.tracks.map(track => {
      const selected = track.id === selectedTrackId;
      return `<div class="tl-track${selected ? ' is-selected' : ''}${track.muted ? ' is-muted' : ''}${track.locked ? ' is-locked' : ''}${track.collapse ? ' is-collapsed' : ''}"
        data-track-id="${escapeHtml(track.id)}" role="option" aria-selected="${selected}" aria-disabled="${track.muted}" style="--track-color:${escapeHtml(track.color)}">
        <button type="button" class="tl-track-toggle tl-collapse" data-track-command="collapse" aria-label="${track.collapse ? 'Expand' : 'Collapse'} ${escapeHtml(track.name)}" aria-expanded="${track.collapse === 0}">${track.collapse ? '&#9656;' : '&#9662;'}</button>
        <span class="tl-track-grip" aria-hidden="true">&#8942;</span>
        <span class="tl-track-name">${escapeHtml(track.name)}</span>
        <span class="tl-track-meta">${track.triggers.length} trigger${track.triggers.length === 1 ? '' : 's'} · ${escapeHtml(targetLabel(track.target))}</span>
        <button type="button" class="tl-track-toggle${track.muted ? ' on' : ''}" data-track-command="mute" aria-label="Mute ${escapeHtml(track.name)}" aria-pressed="${track.muted}">M</button>
        <button type="button" class="tl-track-toggle${track.locked ? ' on' : ''}" data-track-command="lock" aria-label="Lock ${escapeHtml(track.name)}" aria-pressed="${track.locked}">L</button>
      </div>`;
    }).join('') : `<div class="tl-empty" id="tlTrackEmpty"><strong>No tracks yet</strong><span>Add a track, then place triggers at exact show times.</span><button type="button" class="btn" data-action="add-track">Add first track</button></div>`;
    byId('tlTrackCount').textContent = project.tracks.length;
    byId('tlAddTrackSelect').innerHTML = project.tracks.map(track =>
      `<option value="${escapeHtml(track.id)}"${track.id === selectedTrackId ? ' selected' : ''}>${escapeHtml(track.name)}</option>`).join('');
    byId('tlDuplicateTrack').disabled = !selectedTrackId;
    byId('tlRemoveTrack').disabled = !selectedTrackId;
  }

  function rowHeight(track) { return track.collapse === 2 ? 28 : track.collapse === 1 ? 38 : 52; }

  function layoutForCanvas(width, height) {
    const rows = [];
    let y = 0;
    project.tracks.forEach((track, index) => {
      const h = rowHeight(track);
      rows.push({track, index, y, height:h}); y += h;
    });
    const start = project.view.startMs, end = Math.max(start + 1, project.view.endMs);
    return {
      width:Math.max(1, width), height:Math.max(height, y, 1), rows,
      contentHeight:y, startMs:start, endMs:end,
      xForTime:time => (time - start) / (end - start) * Math.max(1, width),
      timeForX:x => start + clamp(x / Math.max(1, width), 0, 1) * (end - start)
    };
  }

  function fitCanvas(canvas, cssWidth, cssHeight) {
    const ratio = Math.min(2, global.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    canvas.style.width = `${cssWidth}px`; canvas.style.height = `${cssHeight}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return context;
  }

  function niceGrid(spanMs, width) {
    const wanted = spanMs / Math.max(2, width / 95);
    const steps = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000,
      15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    return steps.find(step => step >= wanted) || steps[steps.length - 1];
  }

  function renderRuler(layout) {
    if (!rulerDirty) return;
    rulerDirty = false;
    const ruler = byId('tlRuler'); if (!ruler) return;
    const step = niceGrid(layout.endMs - layout.startMs, layout.width);
    const first = Math.ceil(layout.startMs / step) * step;
    const ticks = [];
    for (let time = first, guard = 0; time <= layout.endMs && guard++ < 1000; time += step) {
      const left = layout.xForTime(time);
      ticks.push(`<span class="tl-ruler-tick" style="left:${left}px"><i></i>${escapeHtml(format(time))}</span>`);
    }
    ruler.innerHTML = ticks.join('');
  }

  function renderTimeline() {
    if (!canvasDirty) return;
    canvasDirty = false;
    const canvas = byId('tlTimelineCanvas'), viewport = byId('tlTimelineViewport');
    if (!canvas || !viewport) return;
    const width = Math.max(1, viewport.clientWidth), visibleHeight = Math.max(1, viewport.clientHeight);
    graphLayout = layoutForCanvas(width, visibleHeight);
    const context = fitCanvas(canvas, width, graphLayout.height);
    const colors = getComputedStyle(root);
    const grid = colors.getPropertyValue('--line').trim() || '#29302e';
    const textColor = colors.getPropertyValue('--n600').trim() || '#78827f';
    context.clearRect(0, 0, width, graphLayout.height);
    const step = niceGrid(graphLayout.endMs - graphLayout.startMs, width);
    const first = Math.ceil(graphLayout.startMs / step) * step;
    for (let time = first; time <= graphLayout.endMs; time += step) {
      const x = Math.round(graphLayout.xForTime(time)) + .5;
      context.strokeStyle = grid; context.lineWidth = 1;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, graphLayout.height); context.stroke();
    }
    graphLayout.hitRegions = [];
    graphLayout.rows.forEach((row, rowIndex) => {
      context.fillStyle = rowIndex % 2 ? 'rgba(255,255,255,.012)' : 'rgba(0,0,0,.08)';
      context.fillRect(0, row.y, width, row.height);
      context.strokeStyle = grid; context.beginPath();
      context.moveTo(0, row.y + row.height - .5); context.lineTo(width, row.y + row.height - .5); context.stroke();
      if (row.track.muted) {
        context.fillStyle = 'rgba(3,5,5,.46)'; context.fillRect(0, row.y, width, row.height);
      }
      row.track.triggers.forEach((trigger, triggerIndex) => {
        if (trigger.timeMs < graphLayout.startMs || trigger.timeMs > graphLayout.endMs) return;
        const x = graphLayout.xForTime(trigger.timeMs);
        const span = Math.max(10, graphLayout.xForTime(Math.min(project.endMs,
          trigger.timeMs + Math.max(trigger.durationMs, trigger.fadeMs, 0))) - x);
        const isMarker = trigger.type === 'Marker', isWait = trigger.type === 'Wait for Go';
        const h = isMarker ? 14 : Math.min(24, row.height - 10);
        const y = row.y + (row.height - h) / 2;
        context.globalAlpha = row.track.muted ? .38 : trigger.enabled ? 1 : .35;
        context.fillStyle = isWait ? '#9b5c18' : isMarker ? '#6652a5' : (trigger.color || row.track.color);
        context.strokeStyle = selectedTriggerIds.has(trigger.id) ? '#fff' : row.track.locked ? '#7a817f' : 'rgba(255,255,255,.36)';
        context.lineWidth = selectedTriggerIds.has(trigger.id) ? 2 : 1;
        if (isMarker) {
          context.beginPath(); context.moveTo(x, y); context.lineTo(x + 7, y + h / 2);
          context.lineTo(x, y + h); context.lineTo(x - 7, y + h / 2); context.closePath();
          context.fill(); context.stroke();
        } else {
          const w = Math.min(Math.max(span, 14), width - x + 4);
          context.beginPath(); context.roundRect(Math.max(-4, x - 2), y, w, h, 3); context.fill(); context.stroke();
          context.fillStyle = '#f3f7f6'; context.font = '9px system-ui, sans-serif';
          context.textBaseline = 'middle';
          context.save(); context.beginPath(); context.rect(x + 3, y, Math.max(0, w - 6), h); context.clip();
          context.fillText(trigger.label || trigger.type, x + 4, y + h / 2); context.restore();
        }
        context.globalAlpha = 1;
        graphLayout.hitRegions.push({triggerId:trigger.id, trackId:row.track.id,
          x:x - 8, y:y - 4, width:Math.max(18, span + 8), height:h + 8,
          timeMs:trigger.timeMs, triggerIndex});
      });
      if (!row.track.triggers.length) {
        context.fillStyle = textColor; context.font = '9px system-ui, sans-serif';
        context.fillText(row.track.locked ? 'Locked' : 'Double-click to add a trigger', 10, row.y + row.height / 2);
      }
    });
    renderRuler(graphLayout);
    renderRowLabels(graphLayout);
    byId('tlStageEmpty').hidden = project.tracks.length > 0;
  }

  function renderRowLabels(layout) {
    const labels = byId('tlRowLabels'); if (!labels) return;
    labels.innerHTML = layout.rows.map(row => `<div class="tl-row-label${row.track.muted ? ' is-muted' : ''}${row.track.locked ? ' is-locked' : ''}" data-track-id="${escapeHtml(row.track.id)}" style="height:${row.height}px;--track-color:${escapeHtml(row.track.color)}">
      <i style="background:${escapeHtml(row.track.color)}"></i><span class="name">${escapeHtml(row.track.name)}</span><small>${row.track.triggers.length}</small>
    </div>`).join('');
    labels.style.height = `${layout.height}px`;
  }

  function renderOverview() {
    if (!overviewDirty) return;
    overviewDirty = false;
    const canvas = byId('tlOverviewCanvas'), stage = byId('tlOverviewStage');
    if (!canvas || !stage) return;
    const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
    const context = fitCanvas(canvas, width, height);
    overviewLayout = {width, height,
      xForTime:time => (time - project.startMs) / Math.max(1, project.durationMs) * width,
      timeForX:x => project.startMs + clamp(x / width, 0, 1) * project.durationMs};
    context.clearRect(0, 0, width, height);
    project.tracks.forEach((track, trackIndex) => {
      const y = 4 + trackIndex / Math.max(1, project.tracks.length) * (height - 8);
      track.triggers.forEach(trigger => {
        const x = overviewLayout.xForTime(trigger.timeMs);
        context.strokeStyle = trigger.type === 'Marker' ? '#b69cff' : track.color;
        context.globalAlpha = track.muted ? .25 : .85;
        context.beginPath(); context.moveTo(x, y - 2); context.lineTo(x, y + 5); context.stroke();
      });
    });
    context.globalAlpha = 1;
    const left = overviewLayout.xForTime(project.view.startMs);
    const right = overviewLayout.xForTime(project.view.endMs);
    const windowNode = byId('tlOverviewWindow');
    windowNode.style.left = `${left}px`; windowNode.style.width = `${Math.max(8, right - left)}px`;
  }

  function triggerTypeOptions(selected) {
    return T.allTriggerTypes.map(type => `<option value="${escapeHtml(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>`).join('');
  }

  function renderTable() {
    const body = byId('tlTriggerTableBody'); if (!body) return;
    const filter = safeText(byId('tlTableFilter').value).trim().toLowerCase();
    const records = T.triggerRecords(project).filter(record => !filter ||
      [record.track.name, record.trigger.type, record.trigger.label, targetLabel(record.trigger.target)]
        .join(' ').toLowerCase().includes(filter));
    body.innerHTML = records.map(record => {
      const trigger = record.trigger, selected = selectedTriggerIds.has(trigger.id);
      return `<tr data-trigger-id="${escapeHtml(trigger.id)}" class="${selected ? 'is-selected' : ''}${record.track.muted ? ' is-muted' : ''}${record.track.locked ? ' is-locked' : ''}" aria-selected="${selected}">
        <td><input data-field="timeMs" aria-label="Time for ${escapeHtml(trigger.label || trigger.type)}" value="${escapeHtml(format(trigger.timeMs))}" ${record.track.locked ? 'disabled' : ''}></td>
        <td><select data-field="trackId" aria-label="Track" ${record.track.locked ? 'disabled' : ''}>${project.tracks.map(track => `<option value="${escapeHtml(track.id)}"${track.id === record.track.id ? ' selected' : ''}>${escapeHtml(track.name)}</option>`).join('')}</select></td>
        <td><span class="tl-type-cell ${typeClass(trigger.type)}">${escapeHtml(trigger.type)}</span></td>
        <td><select data-field="target" aria-label="Target" ${record.track.locked ? 'disabled' : ''}>${targetOptions(trigger.target)}</select></td>
        <td><input data-field="level" type="number" min="0" max="100" value="${Math.round(trigger.level * 100)}" aria-label="Level percent" ${record.track.locked ? 'disabled' : ''}></td>
        <td><input data-field="fadeMs" type="number" min="0" step=".01" value="${(trigger.fadeMs / 1000).toFixed(2)}" aria-label="Fade seconds" ${record.track.locked ? 'disabled' : ''}></td>
        <td><input data-field="durationMs" type="number" min="0" step=".01" value="${(trigger.durationMs / 1000).toFixed(2)}" aria-label="Duration seconds" ${record.track.locked ? 'disabled' : ''}></td>
        <td><input data-field="label" value="${escapeHtml(trigger.label)}" aria-label="Trigger label" ${record.track.locked ? 'disabled' : ''}></td>
      </tr>`;
    }).join('');
    byId('tlTableCount').textContent = `${records.length} trigger${records.length === 1 ? '' : 's'}`;
    byId('tlTableEmpty').hidden = records.length > 0;
  }

  function renderInspector() {
    const records = selectedRecords(), track = trackById(selectedTrackId);
    const projectPanel = byId('tlProjectInspector'), trackPanel = byId('tlTrackInspector');
    const triggerPanel = byId('tlTriggerInspector'), noSelection = byId('tlNoSelectionInspector');
    projectPanel.hidden = !!(records.length || track);
    trackPanel.hidden = !!records.length || !track;
    triggerPanel.hidden = !records.length;
    noSelection.hidden = !!(records.length || track);
    if (track && !records.length) {
      byId('tlTrackName').value = track.name;
      byId('tlTrackColor').value = /^#[0-9a-f]{6}$/i.test(track.color) ? track.color : '#55e4c2';
      byId('tlTrackTarget').innerHTML = targetOptions(track.target);
      byId('tlTrackMuted').checked = track.muted;
      byId('tlTrackLocked').checked = track.locked;
      byId('tlTrackCollapse').value = String(track.collapse);
      byId('tlTrackInspectorState').textContent = track.locked ? 'locked' : track.muted ? 'muted' : 'selected';
    }
    if (records.length) {
      const trigger = records[0].trigger, locked = records.some(record => record.track.locked);
      byId('tlSelectionCount').textContent = `${records.length} selected`;
      byId('tlInspectorType').innerHTML = triggerTypeOptions(trigger.type);
      byId('tlInspectorTime').value = format(trigger.timeMs);
      byId('tlInspectorTarget').innerHTML = targetOptions(trigger.target);
      byId('tlInspectorLevel').value = Math.round(trigger.level * 100);
      byId('tlInspectorFade').value = (trigger.fadeMs / 1000).toFixed(2);
      byId('tlInspectorDuration').value = (trigger.durationMs / 1000).toFixed(2);
      byId('tlInspectorLabel').value = records.length === 1 ? trigger.label : '';
      ['tlInspectorType','tlInspectorTime','tlInspectorTarget','tlInspectorLevel',
        'tlInspectorFade','tlInspectorDuration','tlInspectorLabel','tlDeleteTrigger','tlDuplicateTrigger']
        .forEach(id => { byId(id).disabled = locked; });
      updateTypeFieldVisibility(trigger.type, 'tlInspector');
    }
  }

  function renderProjectReadouts() {
    byId('tlDocumentName').textContent = project.name;
    if (document.activeElement !== byId('tlProjectName')) byId('tlProjectName').value = project.name;
    if (document.activeElement !== byId('tlProjectDuration')) byId('tlProjectDuration').value = format(project.durationMs);
    byId('tlSummaryStart').textContent = format(project.startMs);
    byId('tlSummaryEnd').textContent = format(project.endMs);
    byId('tlTriggerCount').textContent = totalTriggerCount();
    byId('tlMarkerCount').textContent = markerCount();
    byId('tlInspectorTrackCount').textContent = project.tracks.length;
    byId('tlInspectorTriggerCount').textContent = totalTriggerCount();
    byId('tlViewRange').textContent = `${format(project.view.startMs)} to ${format(project.view.endMs)}`;
    byId('tlCursorDisplay').textContent = format(project.cursorMs);
    byId('tlZoomValue').textContent = `${Math.round(project.durationMs / Math.max(1, project.view.endMs - project.view.startMs) * 100)}%`;
    byId('tlTimecodeSource').value = sourceKey(project.options.timecodeSource);
    byId('tlTimecodeLink').setAttribute('aria-pressed', String(project.options.linked));
    byId('tlLinkLabel').textContent = project.options.linked ? 'Linked' : 'Link';
    renderTimecodeState();
    byId('tlUndo').disabled = !historyPast.length;
    byId('tlRedo').disabled = !historyFuture.length;
    byId('tlRemoveTrack').disabled = !selectedTrackId;
    byId('tlDuplicateTrack').disabled = !selectedTrackId;
    byId('tlSelectionStatus').textContent = selectedTriggerIds.size
      ? `${selectedTriggerIds.size} trigger${selectedTriggerIds.size === 1 ? '' : 's'} selected`
      : selectedTrackId && trackById(selectedTrackId) ? `${trackById(selectedTrackId).name} selected` : 'Nothing selected';
  }

  function sourceKey(value) {
    const key = safeText(value).toLowerCase().replace(/\s+/g, '-');
    if (key.includes('smpte') && key.includes('2')) return 'smpte-2';
    if (key.includes('smpte')) return 'smpte-1';
    if (key.includes('midi')) return 'midi-clock';
    return 'internal';
  }

  function sourceLabel(value) {
    return {'internal':'Internal','smpte-1':'SMPTE 1','smpte-2':'SMPTE 2','midi-clock':'MIDI Clock'}[sourceKey(value)] || 'Internal';
  }

  function renderTimecodeState() {
    const key = sourceKey(project.options.timecodeSource);
    const externalLinked = project.options.linked && key !== 'internal';
    root.dataset.sourceState = externalLinked ? 'disabled' : project.options.linked ? 'linked' : 'unlinked';
    byId('tlTimecodeControl').dataset.state = root.dataset.sourceState;
    ['tlRewind','tlPlayFromCursor','tlPlayPause','tlStop'].forEach(id => {
      const button = byId(id); button.disabled = externalLinked; button.hidden = externalLinked;
    });
    const statusNode = byId('tlSourceStatus');
    statusNode.dataset.state = externalLinked ? 'disabled' : key === 'internal' ? 'ready' : 'unlinked';
    statusNode.querySelector('span').textContent = externalLinked
      ? `${sourceLabel(key)} unavailable · no input signal`
      : key === 'internal' ? 'Internal clock ready' : `${sourceLabel(key)} selected · local transport unlinked`;
  }

  function renderPlaybackState() {
    const state = runtimeState.state || 'stopped';
    const playing = state === 'playing', waiting = state === 'waiting';
    root.classList.toggle('is-playing', playing);
    root.classList.toggle('is-waiting', waiting);
    byId('tlPlayPause').setAttribute('aria-pressed', String(playing));
    byId('tlPlayPause').setAttribute('aria-label', playing ? 'Pause timeline' : 'Play timeline');
    byId('tlPlayPause').innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
    byId('tlGo').disabled = !waiting;
    byId('tlPlaybackState').textContent = waiting ? 'Waiting for Go' :
      playing ? 'Playing' : state === 'paused' ? 'Paused' : 'Stopped';
    const time = Number(runtimeState.timeMs == null ? runtimeState.positionMs : runtimeState.timeMs);
    byId('tlTimeDisplay').textContent = format(Number.isFinite(time) ? time : project.startMs);
    const next = T.triggerRecords(project, {audible:true, enabled:true})
      .find(record => record.trigger.timeMs > (Number.isFinite(time) ? time : project.startMs));
    byId('tlNextTrigger').textContent = next
      ? `${format(next.trigger.timeMs)} · ${next.trigger.label || next.trigger.type}` : 'N/A';
    byId('tlActiveTrackCount').textContent = project.tracks.filter(track => !track.muted).length;
  }

  function renderViewMode() {
    const table = viewMode === 'table';
    byId('tlGraphView').hidden = table;
    byId('tlTableView').hidden = !table;
    byId('tlGraphViewButton').classList.toggle('on', !table);
    byId('tlTableViewButton').classList.toggle('on', table);
    byId('tlGraphViewButton').setAttribute('aria-pressed', String(!table));
    byId('tlTableViewButton').setAttribute('aria-pressed', String(table));
    if (!table) markAllDirty();
  }

  function renderAll() {
    renderTracks();
    renderProjectReadouts();
    renderInspector();
    renderTable();
    renderViewMode();
    renderPlaybackState();
    updateToolButtons();
  }

  function updateToolButtons() {
    ['select','pan','add'].forEach(tool => {
      const id = tool === 'select' ? 'tlToolSelect' : tool === 'pan' ? 'tlToolPan' : 'tlToolAdd';
      const active = activeTool === tool;
      byId(id).classList.toggle('on', active); byId(id).setAttribute('aria-pressed', String(active));
    });
    root.dataset.tool = temporaryPan ? 'pan' : activeTool;
  }

  function selectTrack(id, options) {
    const track = trackById(id); if (!track) return;
    selectedTrackId = id;
    if (!(options && options.keepTriggers)) selectedTriggerIds.clear();
    renderAll();
  }

  function selectTrigger(id, options) {
    const record = triggerRecord(id); if (!record) return;
    selectedTrackId = record.track.id;
    const additive = options && options.additive;
    if (!additive) selectedTriggerIds.clear();
    if (additive && selectedTriggerIds.has(id)) selectedTriggerIds.delete(id);
    else selectedTriggerIds.add(id);
    canvasDirty = true; renderAll();
  }

  function addTrack() {
    const number = project.tracks.length + 1;
    const id = uid('track');
    const next = T.addTrack(project, {id, name:`Track ${number}`,
      color:T.trackColors[(number - 1) % T.trackColors.length], target:{kind:'show'}, triggers:[]});
    if (setProject(next, 'Add Timeline track')) selectTrack(next.tracks[next.tracks.length - 1].id);
  }

  function duplicateTrack() {
    const track = trackById(selectedTrackId); if (!track || track.locked) return;
    const copy = clone(track); copy.id = uid('track'); copy.name = `${track.name} Copy`;
    copy.triggers.forEach(trigger => { trigger.id = uid('trigger'); });
    const next = T.addTrack(project, copy);
    if (setProject(next, 'Duplicate Timeline track')) selectTrack(next.tracks[next.tracks.length - 1].id);
  }

  function removeTrack() {
    const track = trackById(selectedTrackId); if (!track) return;
    if (track.locked) return status('Unlock the track before removing it.', 'warning');
    const next = T.removeTrack(project, track.id);
    selectedTrackId = next.tracks[0] && next.tracks[0].id || null;
    selectedTriggerIds.clear(); setProject(next, 'Remove Timeline track');
  }

  function updateSelectedTrack(patch, reason) {
    const track = trackById(selectedTrackId); if (!track) return;
    if (track.locked && !Object.prototype.hasOwnProperty.call(patch, 'locked'))
      return status('This track is locked.', 'warning');
    setProject(T.updateTrack(project, track.id, patch, {force:Object.prototype.hasOwnProperty.call(patch, 'locked')}),
      reason || 'Edit Timeline track');
  }

  function deleteSelectedTriggers() {
    if (!selectedTriggerIds.size) return;
    const locked = selectedRecords().filter(record => record.track.locked);
    if (locked.length) return status('Unlock the selected track before deleting triggers.', 'warning');
    const next = T.removeTriggers(project, Array.from(selectedTriggerIds));
    selectedTriggerIds.clear(); setProject(next, 'Delete Timeline triggers');
  }

  function duplicateSelectedTriggers() {
    if (!selectedTriggerIds.size) return;
    if (selectedRecords().some(record => record.track.locked))
      return status('Unlock the selected track before duplicating triggers.', 'warning');
    const span = project.view.endMs - project.view.startMs;
    const delta = Math.max(10, Math.round(span / 100));
    const next = T.copyTriggers(project, Array.from(selectedTriggerIds), delta);
    const beforeIds = new Set(T.triggerRecords(project).map(record => record.trigger.id));
    const newIds = T.triggerRecords(next).filter(record => !beforeIds.has(record.trigger.id)).map(record => record.trigger.id);
    selectedTriggerIds.clear(); newIds.forEach(id => selectedTriggerIds.add(id));
    setProject(next, 'Duplicate Timeline triggers');
  }

  function updateSelectedTriggers(patch, reason) {
    const records = selectedRecords(); if (!records.length) return;
    if (records.some(record => record.track.locked)) return status('This track is locked.', 'warning');
    let next = project;
    records.forEach(record => { next = T.updateTrigger(next, record.trigger.id, patch); });
    setProject(next, reason || 'Edit Timeline triggers');
  }

  function updateTypeFieldVisibility(type, prefix) {
    const canonical = T.canonicalTriggerType(type);
    const level = canonical === 'Set Level';
    const duration = ['Flash','Timed Flash','Timed Flash and Go','Swop'].includes(canonical);
    const fade = level || ['Timed Flash','Timed Flash and Go','Preload'].includes(canonical);
    const marker = canonical === 'Marker' || canonical === 'Wait for Go';
    const ids = prefix === 'tlAdd'
      ? {level:'tlAddLevelRow', fade:'tlAddFadeRow', duration:'tlAddDurationRow', target:'tlAddTargetRow'}
      : {level:'tlInspectorLevelRow', fade:'tlInspectorFadeRow', duration:'tlInspectorDurationRow', target:null};
    if (ids.level) byId(ids.level).hidden = !level;
    if (ids.fade) byId(ids.fade).hidden = !fade;
    if (ids.duration) byId(ids.duration).hidden = !duration;
    if (ids.target) byId(ids.target).hidden = marker;
  }

  function openAddTrigger(timeMs, forcedType) {
    if (!project.tracks.length) addTrack();
    const track = trackById(selectedTrackId) || project.tracks[0];
    if (!track) return;
    if (track.locked) return status('Unlock the track before adding a trigger.', 'warning');
    captureModalOpener();
    byId('tlAddTrackSelect').value = track.id;
    const typeSelect = byId('tlAddType');
    const wantedType = T.canonicalTriggerType(forcedType || 'Set Level');
    const typeOption = Array.from(typeSelect.options).find(option =>
      T.canonicalTriggerType(option.value) === wantedType);
    typeSelect.value = typeOption ? typeOption.value : 'set-level';
    byId('tlAddTime').value = format(timeMs == null ? project.cursorMs : timeMs);
    byId('tlAddTarget').innerHTML = targetOptions(track.target);
    byId('tlAddLevel').value = 100; byId('tlAddFade').value = 0; byId('tlAddDuration').value = 1;
    byId('tlAddLabel').value = '';
    updateTypeFieldVisibility(byId('tlAddType').value, 'tlAdd');
    openModal('tlAddTriggerOverlay', 'tlAddTriggerModal', 'tlAddType');
  }

  function submitAddTrigger(event) {
    event.preventDefault();
    const trackId = byId('tlAddTrackSelect').value;
    const track = trackById(trackId); if (!track || track.locked) return status('The selected track is locked.', 'warning');
    const time = parse(byId('tlAddTime').value, null);
    if (time == null) return status('Enter a valid HH:MM:SS.mmm time.', 'error');
    const type = T.canonicalTriggerType(byId('tlAddType').value);
    const trigger = {
      id:uid(type === 'Marker' ? 'marker' : 'trigger'), type,
      timeMs:clamp(time, project.startMs, project.endMs),
      target:parseTarget(byId('tlAddTarget').value),
      level:clamp(Number(byId('tlAddLevel').value) / 100, 0, 1),
      fadeMs:Math.max(0, Number(byId('tlAddFade').value) || 0) * 1000,
      durationMs:Math.max(0, Number(byId('tlAddDuration').value) || 0) * 1000,
      label:byId('tlAddLabel').value || type
    };
    const next = T.addTrigger(project, trackId, trigger);
    setProject(next, `Add ${type}`);
    selectedTrackId = trackId; selectedTriggerIds.clear();
    const added = T.triggerRecords(project).find(record => record.trigger.id === trigger.id);
    if (added) selectedTriggerIds.add(added.trigger.id);
    closeModal('tlAddTriggerOverlay'); renderAll();
  }

  function addMarkerAtCursor() { openAddTrigger(project.cursorMs, 'Marker'); }

  function openModal(overlayId, modalId, firstId) {
    const overlay = byId(overlayId), modal = byId(modalId);
    overlay.classList.add('show'); overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => (byId(firstId) || modal).focus());
  }

  function captureModalOpener() {
    const active = document.activeElement;
    const menu = active && active.closest ? active.closest('.tl-menu') : null;
    lastModalOpener = menu
      ? $$('[aria-controls]').find(node => node.getAttribute('aria-controls') === menu.id) || null
      : active;
  }

  function closeModal(overlayId) {
    const overlay = byId(overlayId);
    overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true');
    if (lastModalOpener && document.contains(lastModalOpener)) lastModalOpener.focus();
    lastModalOpener = null;
  }

  function trapModal(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); closeModal(event.currentTarget.id); return;
    }
    if (event.key !== 'Tab') return;
    const focusable = $$(`#${event.currentTarget.id} button:not(:disabled),#${event.currentTarget.id} input:not(:disabled),#${event.currentTarget.id} select:not(:disabled),#${event.currentTarget.id} [tabindex="0"]`)
      .filter(node => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function openOptions() {
    captureModalOpener();
    byId('tlOptionStart').value = format(project.startMs);
    byId('tlOptionEnd').value = format(project.endMs);
    byId('tlOptionDuration').value = format(project.durationMs);
    byId('tlOptionSource').value = sourceKey(project.options.timecodeSource);
    byId('tlOptionOffset').value = format(project.options.offsetMs);
    byId('tlOptionFps').value = String(project.options.fps);
    byId('tlOptionLoop').checked = project.options.loop;
    byId('tlOptionActivateInRange').value = project.options.activateInRange === '0%' ? '0' : project.options.activateInRange === 'Off' ? 'off' : '100';
    byId('tlOptionKillOutOfRange').checked = project.options.killOutOfRange;
    byId('tlOptionFaderRaised').value = project.options.faderRaisedAction === 'Play' ? 'play' : 'none';
    byId('tlOptionFaderZero').value = safeText(project.options.faderZeroAction).toLowerCase().replace('no action','none');
    byId('tlOptionKillAtZero').checked = project.options.killAtZero;
    byId('tlOptionReleaseToHome').checked = project.options.releaseToHome;
    byId('tlOptionReleaseTime').value = (project.options.releaseTimeMs / 1000).toFixed(2);
    byId('tlOptionSnapTriggers').checked = project.options.snap.triggers;
    byId('tlOptionSnapMarkers').checked = project.options.snap.markers;
    byId('tlOptionSnapCursor').checked = project.options.snap.cursor;
    openModal('tlOptionsOverlay', 'tlOptionsModal', 'tlOptionStart');
  }

  function submitOptions(event) {
    event.preventDefault();
    const start = Math.max(0, parse(byId('tlOptionStart').value, project.startMs));
    let end = parse(byId('tlOptionEnd').value, null);
    const duration = Math.max(1, parse(byId('tlOptionDuration').value, project.durationMs));
    if (end == null || end <= start) end = start + duration;
    mutate('Update Timeline options', draft => {
      draft.startMs = start; draft.endMs = end; draft.durationMs = end - start;
      draft.cursorMs = clamp(draft.cursorMs, start, end);
      draft.options.timecodeSource = sourceLabel(byId('tlOptionSource').value);
      draft.options.offsetMs = parse(byId('tlOptionOffset').value, 0);
      draft.options.fps = Number(byId('tlOptionFps').value) || 25;
      draft.options.loop = byId('tlOptionLoop').checked;
      draft.options.activateInRange = byId('tlOptionActivateInRange').value === '0' ? '0%' :
        byId('tlOptionActivateInRange').value === 'off' ? 'Off' : '100%';
      draft.options.killOutOfRange = byId('tlOptionKillOutOfRange').checked;
      draft.options.faderRaisedAction = byId('tlOptionFaderRaised').value === 'play' ? 'Play' : 'No Action';
      const zero = byId('tlOptionFaderZero').value;
      draft.options.faderZeroAction = zero === 'stop' ? 'Stop' : zero === 'pause' ? 'Pause' : 'No Action';
      draft.options.killAtZero = byId('tlOptionKillAtZero').checked;
      draft.options.releaseToHome = byId('tlOptionReleaseToHome').checked;
      draft.options.releaseTimeMs = Math.max(0, Number(byId('tlOptionReleaseTime').value) || 0) * 1000;
      draft.options.snap = {triggers:byId('tlOptionSnapTriggers').checked,
        markers:byId('tlOptionSnapMarkers').checked,
        cursor:byId('tlOptionSnapCursor').checked,
        thresholdMs:draft.options.snap && draft.options.snap.thresholdMs || 100};
      draft.view.startMs = clamp(draft.view.startMs, start, end);
      draft.view.endMs = clamp(draft.view.endMs, draft.view.startMs + 1, end);
    });
    closeModal('tlOptionsOverlay');
  }

  function setCursor(timeMs, persist) {
    const time = clamp(Number(timeMs) || 0, project.startMs, project.endMs);
    project.cursorMs = time;
    byId('tlCursorDisplay').textContent = format(time);
    canvasDirty = true; overviewDirty = true;
    if (persist !== false) schedulePersist('Move Timeline cursor');
  }

  function setView(start, end, persist) {
    const minimum = Math.max(10, project.durationMs / 10000);
    let a = clamp(start, project.startMs, project.endMs - minimum);
    let b = clamp(end, a + minimum, project.endMs);
    if (b - a < minimum) a = Math.max(project.startMs, b - minimum);
    project.view.startMs = a; project.view.endMs = b;
    markAllDirty(); renderProjectReadouts();
    if (persist) schedulePersist('Change Timeline view');
  }

  function zoom(factor, centerMs) {
    const oldSpan = project.view.endMs - project.view.startMs;
    const span = clamp(oldSpan / factor, Math.max(100, project.durationMs / 10000), project.durationMs);
    const center = clamp(centerMs == null ? project.cursorMs : centerMs, project.startMs, project.endMs);
    const phase = oldSpan ? (center - project.view.startMs) / oldSpan : .5;
    let start = center - span * clamp(phase, 0, 1), end = start + span;
    if (start < project.startMs) { start = project.startMs; end = start + span; }
    if (end > project.endMs) { end = project.endMs; start = end - span; }
    setView(start, end, true);
  }

  function zoomFit() { setView(project.startMs, project.endMs, true); }

  function toggleSnap() {
    const any = project.options.snap.triggers || project.options.snap.markers || project.options.snap.cursor;
    mutate('Toggle Timeline snapping', draft => {
      draft.options.snap.triggers = !any; draft.options.snap.markers = !any; draft.options.snap.cursor = !any;
    });
    const on = project.options.snap.triggers || project.options.snap.markers || project.options.snap.cursor;
    byId('tlSnap').setAttribute('aria-pressed', String(on));
  }

  function snapTime(value, excludeIds) {
    const enabled = project.options.snap.triggers || project.options.snap.markers || project.options.snap.cursor;
    return enabled ? T.snapTime(value, project, {excludeIds:excludeIds || [],
      thresholdMs:(project.view.endMs - project.view.startMs) / Math.max(1, graphLayout && graphLayout.width || 1000) * 8}) : value;
  }

  function hitAt(x, y) {
    if (!graphLayout) return null;
    for (let index = graphLayout.hitRegions.length - 1; index >= 0; index--) {
      const hit = graphLayout.hitRegions[index];
      if (x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height) return hit;
    }
    return null;
  }

  function rowAt(y) {
    return graphLayout && graphLayout.rows.find(row => y >= row.y && y < row.y + row.height) || null;
  }

  function canvasPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {x:event.clientX - rect.left, y:event.clientY - rect.top};
  }

  function onTimelinePointerDown(event) {
    if (event.button !== 0) return;
    const canvas = byId('tlTimelineCanvas'), point = canvasPoint(event, canvas);
    const tool = temporaryPan ? 'pan' : activeTool;
    const hit = hitAt(point.x, point.y), row = rowAt(point.y);
    canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId);
    if (tool === 'pan') {
      canvasGesture = {type:'pan', pointerId:event.pointerId, x:point.x,
        start:project.view.startMs, end:project.view.endMs};
      return;
    }
    if (hit) {
      selectTrigger(hit.triggerId, {additive:event.shiftKey || event.ctrlKey || event.metaKey});
      const record = triggerRecord(hit.triggerId);
      if (record && !record.track.locked) canvasGesture = {type:'drag', pointerId:event.pointerId,
        x:point.x, base:T.shareableProject(project), ids:Array.from(selectedTriggerIds), moved:false};
      return;
    }
    if (row) selectTrack(row.track.id);
    setCursor(graphLayout.timeForX(point.x), false);
    if (tool === 'add') { openAddTrigger(project.cursorMs); return; }
    selectedTriggerIds.clear();
    canvasGesture = {type:'marquee', pointerId:event.pointerId, x:point.x, y:point.y, current:point};
    byId('tlMarquee').hidden = false;
    renderAll();
  }

  function onTimelinePointerMove(event) {
    if (!canvasGesture || canvasGesture.pointerId !== event.pointerId || !graphLayout) return;
    const point = canvasPoint(event, byId('tlTimelineCanvas'));
    if (canvasGesture.type === 'pan') {
      const delta = (canvasGesture.x - point.x) / graphLayout.width *
        (canvasGesture.end - canvasGesture.start);
      setView(canvasGesture.start + delta, canvasGesture.end + delta, false);
    } else if (canvasGesture.type === 'drag') {
      const delta = (point.x - canvasGesture.x) / graphLayout.width *
        (graphLayout.endMs - graphLayout.startMs);
      let next = T.moveTriggers(canvasGesture.base, canvasGesture.ids, delta,
        {snap:{thresholdMs:(graphLayout.endMs - graphLayout.startMs) / graphLayout.width * 8}});
      const row = rowAt(point.y);
      if (row && row.track.id !== (triggerRecord(canvasGesture.ids[0]) || {}).track?.id && !row.track.locked)
        next = T.moveTriggers(canvasGesture.base, canvasGesture.ids, delta,
          {targetTrackId:row.track.id,snap:{thresholdMs:(graphLayout.endMs - graphLayout.startMs) / graphLayout.width * 8}});
      project = next; canvasGesture.moved = Math.abs(point.x - canvasGesture.x) > 2;
      markAllDirty(); renderAll();
    } else if (canvasGesture.type === 'marquee') {
      canvasGesture.current = point;
      const left = Math.min(canvasGesture.x, point.x), top = Math.min(canvasGesture.y, point.y);
      const width = Math.abs(point.x - canvasGesture.x), height = Math.abs(point.y - canvasGesture.y);
      const marquee = byId('tlMarquee');
      Object.assign(marquee.style, {left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px`});
      selectedTriggerIds.clear();
      graphLayout.hitRegions.filter(hit => hit.x >= left && hit.y >= top &&
        hit.x + hit.width <= left + width && hit.y + hit.height <= top + height)
        .forEach(hit => selectedTriggerIds.add(hit.triggerId));
      canvasDirty = true;
    }
  }

  function onTimelinePointerUp(event) {
    if (!canvasGesture || canvasGesture.pointerId !== event.pointerId) return;
    const gesture = canvasGesture; canvasGesture = null;
    byId('tlMarquee').hidden = true;
    if (gesture.type === 'drag' && gesture.moved) {
      rememberHistory(gesture.base); schedulePersist('Move Timeline triggers');
    }
    if (gesture.type === 'pan') schedulePersist('Pan Timeline view');
    renderAll();
  }

  function onTimelineDoubleClick(event) {
    const point = canvasPoint(event, byId('tlTimelineCanvas'));
    if (hitAt(point.x, point.y)) return;
    const row = rowAt(point.y); if (!row || row.track.locked) return;
    selectedTrackId = row.track.id; setCursor(snapTime(graphLayout.timeForX(point.x)), false);
    openAddTrigger(project.cursorMs);
  }

  function onTimelineWheel(event) {
    if (!graphLayout) return;
    event.preventDefault();
    const point = canvasPoint(event, byId('tlTimelineCanvas'));
    if (event.ctrlKey || event.metaKey) zoom(event.deltaY < 0 ? 1.25 : .8, graphLayout.timeForX(point.x));
    else {
      const delta = event.deltaY / graphLayout.width * (graphLayout.endMs - graphLayout.startMs);
      setView(project.view.startMs + delta, project.view.endMs + delta, false);
    }
  }

  function onOverviewPointer(event) {
    if (!overviewLayout) return;
    const point = canvasPoint(event, byId('tlOverviewCanvas'));
    const span = project.view.endMs - project.view.startMs;
    const center = overviewLayout.timeForX(point.x);
    setView(center - span / 2, center + span / 2, true);
  }

  function setTool(tool) {
    if (!['select','pan','add'].includes(tool)) return;
    activeTool = tool; project.view.tool = tool; updateToolButtons(); schedulePersist('Change Timeline tool');
  }

  function setViewMode(mode) {
    viewMode = mode === 'table' ? 'table' : 'graph';
    project.view.table = viewMode === 'table'; renderViewMode(); schedulePersist('Change Timeline view');
  }

  function dispatchPreview(event) {
    if (!Bus || !Bus.send) return;
    Bus.send({op:'action', name:'timelineTrigger', args:{trigger:event}});
  }

  function ensurePreviewRuntime() {
    if (!previewRuntime) previewRuntime = new T.Runtime(project, {
      dispatch:dispatchPreview,
      onStateChange:snapshot => {
        runtimeState = Object.assign({}, snapshot, {timeMs:snapshot.positionMs, local:true});
        renderPlaybackState();
      }
    });
    return previewRuntime;
  }

  function localTransport(action, payload) {
    const runtime = ensurePreviewRuntime();
    if (action === 'play') runtime.play();
    else if (action === 'pause') runtime.pause();
    else if (action === 'play-pause') runtime.isPlaying ? runtime.pause() : runtime.play();
    else if (action === 'play-from-cursor') runtime.playFromCursor(project.cursorMs);
    else if (action === 'stop') runtime.stop();
    else if (action === 'rewind') runtime.rewind();
    else if (action === 'seek') runtime.seek(payload && payload.timeMs);
    else if (action === 'go' || action === 'continue') runtime.go();
  }

  function commitFocusedEditor() {
    const active = document.activeElement;
    if (!active || active.closest('#tlTransport') || !isEditable(active)) return;
    active.dispatchEvent(new Event('change', {bubbles:true}));
    if (saveTimer) flushPersist();
  }

  function sendTransport(action, payload) {
    /* Transport must run the exact edit currently visible in the editor.  In
       particular, a delayed project broadcast arriving while the runtime is
       sitting on Wait for Go would otherwise turn that hold into a pause. */
    if (saveTimer) flushPersist();
    const request = Object.assign({action, requestedAt:Date.now()}, payload || {});
    if (Hub && Hub.emit) Hub.emit('timeline:transport', request, {activity:false});
    if (performance.now() - hostSeenAt > 2000) {
      localTransport(action, payload);
      status('Local preview · open SHOWAVE Live for authoritative output', 'warning');
    }
  }

  function toggleRecord() {
    recording = !recording;
    root.classList.toggle('is-recording', recording);
    byId('tlRecord').setAttribute('aria-pressed', String(recording));
    byId('tlRecord').classList.toggle('on', recording);
    const menu = $('[data-action="record"][role="menuitemcheckbox"]');
    if (menu) menu.setAttribute('aria-checked', String(recording));
    status(recording ? 'Live Record armed · capture begins when timecode runs' : 'Live Record stopped');
  }

  function recordLiveAction(detail) {
    if (!recording || runtimeState.state !== 'playing') return;
    const track = trackById(selectedTrackId) || project.tracks.find(item => !item.locked);
    if (!track || track.locked) return status('Live Record needs an unlocked track.', 'warning');
    const time = clamp(Number(runtimeState.timeMs || runtimeState.positionMs || project.cursorMs),
      project.startMs, project.endMs);
    const trigger = Object.assign({id:uid('recorded'),timeMs:time,durationMs:0,fadeMs:0,level:1}, detail || {});
    trigger.type = T.canonicalTriggerType(trigger.type);
    const next = T.addTrigger(project, track.id, trigger);
    setProject(next, `Live Record ${trigger.type}`);
    status(`Recorded ${trigger.type} at ${format(time)}`, 'recording');
  }

  function simplifySelected() {
    const records = selectedRecords().filter(record => record.trigger.type === 'Set Level');
    if (records.length < 3) return status('Select at least three Set Level triggers to simplify.', 'warning');
    const byTrack = new Map();
    records.forEach(record => {
      if (!byTrack.has(record.track.id)) byTrack.set(record.track.id, []);
      byTrack.get(record.track.id).push(record.trigger);
    });
    let next = project;
    byTrack.forEach(points => {
      const keep = new Set(T.simplifyPoints(points, .015).map(point => point.id));
      const remove = points.filter(point => !keep.has(point.id)).map(point => point.id);
      next = T.removeTriggers(next, remove);
      remove.forEach(id => selectedTriggerIds.delete(id));
    });
    setProject(next, 'Simplify Timeline fader motion');
  }

  function smoothSelected() {
    const groups = new Map();
    selectedRecords().filter(record => record.trigger.type === 'Set Level').forEach(record => {
      if (!groups.has(record.track.id)) groups.set(record.track.id, []);
      groups.get(record.track.id).push(record.trigger);
    });
    let next = project;
    groups.forEach(points => points.sort((a,b) => a.timeMs - b.timeMs).forEach((point,index) => {
      if (!index) return;
      next = T.updateTrigger(next, point.id, {fadeMs:Math.max(0, point.timeMs - points[index - 1].timeMs)});
    }));
    setProject(next, 'Smooth Timeline triggers');
  }

  function importMarkers() { byId('tlMarkerCsvInput').click(); }

  async function readMarkerFile(file) {
    if (!file) return;
    try {
      const markers = T.parseMarkerCsv(await file.text(), {fps:project.options.fps});
      if (!markers.length) throw new Error('No marker rows with valid timecode were found');
      let next = project;
      let track = trackById(selectedTrackId);
      if (!track || track.locked) {
        next = T.addTrack(next, {id:uid('track'),name:'Markers',color:'#8d72d8',target:{kind:'timeline'},triggers:[]});
        track = next.tracks[next.tracks.length - 1];
      }
      const maximum = Math.max(...markers.map(marker => marker.timeMs));
      if (maximum > next.endMs) {
        const draft = clone(next); draft.endMs = maximum + 1000; draft.durationMs = draft.endMs - draft.startMs;
        draft.view.endMs = draft.endMs; next = T.normaliseProject(draft);
      }
      markers.forEach(marker => { marker.id = uid('marker'); next = T.addTrigger(next, track.id, marker); });
      selectedTrackId = track.id; setProject(next, `Import ${markers.length} Timeline markers`);
      status(`Imported ${markers.length} marker${markers.length === 1 ? '' : 's'} from ${file.name}`);
    } catch (error) { status(`Marker import failed: ${error.message}`, 'error'); }
    finally { byId('tlMarkerCsvInput').value = ''; }
  }

  function documentPayload() {
    return {format:T.schemaName,version:T.schema,project:T.shareableProject(project),
      savedAt:new Date().toISOString()};
  }

  function downloadJson(text, filename) {
    global.OpenLiveSessionPolicy?.assertCanWrite('Saving a Timeline');
    const url = URL.createObjectURL(new Blob([text], {type:'application/json'}));
    const link = Object.assign(document.createElement('a'), {href:url,download:filename});
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function saveProject() {
    if (global.OpenLiveSessionPolicy?.sessionOnly) {
      try { global.OpenLiveSessionPolicy.assertCanWrite('Saving a Timeline'); }
      catch (error) { status(error.message, 'error'); }
      return;
    }
    const text = JSON.stringify(documentPayload(), null, 2);
    const filename = `${project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Timeline'}.showave-timeline.json`;
    try {
      if (typeof global.showSaveFilePicker === 'function') {
        const handle = await global.showSaveFilePicker({suggestedName:filename,
          types:[{description:'SHOWAVE Timeline',accept:{'application/json':['.json']}}]});
        const writable = await handle.createWritable(); await writable.write(text); await writable.close();
      } else downloadJson(text, filename);
      status(`Saved ${filename}`);
    } catch (error) { if (error.name !== 'AbortError') status(`Save failed: ${error.message}`, 'error'); }
  }

  function loadProject() { byId('tlProjectFileInput').click(); }

  async function readProjectFile(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.format && parsed.format !== T.schemaName) throw new Error('This is not a SHOWAVE Timeline document');
      const incoming = T.normaliseProject(parsed.project || parsed);
      sendTransport('stop');
      selectedTriggerIds.clear(); selectedTrackId = incoming.tracks[0] && incoming.tracks[0].id || null;
      setProject(incoming, `Open Timeline ${file.name}`);
      status(`Opened ${file.name}`);
    } catch (error) { status(`Open failed: ${error.message}`, 'error'); }
    finally { byId('tlProjectFileInput').value = ''; }
  }

  function newProject() {
    const next = T.createProject('Show Timeline');
    sendTransport('stop');
    selectedTriggerIds.clear(); selectedTrackId = next.tracks[0].id;
    setProject(next, 'New Timeline'); status('New Timeline created');
  }

  function action(name) {
    const actions = {
      'new-project':newProject, 'save-project':saveProject, 'load-project':loadProject,
      'import-markers':importMarkers, undo, redo, 'select-all':() => {
        selectedTriggerIds.clear(); T.triggerRecords(project).forEach(record => selectedTriggerIds.add(record.trigger.id)); renderAll();
      },
      'duplicate-trigger':duplicateSelectedTriggers, 'delete-trigger':deleteSelectedTriggers,
      'add-track':addTrack, 'duplicate-track':duplicateTrack, 'remove-track':removeTrack,
      'add-trigger':() => openAddTrigger(), 'add-marker':addMarkerAtCursor,
      record:toggleRecord, simplify:simplifySelected, smooth:smoothSelected,
      options:openOptions, 'graph-view':() => setViewMode('graph'), 'table-view':() => setViewMode('table'),
      'zoom-fit':zoomFit, 'zoom-in':() => zoom(1.25), 'zoom-out':() => zoom(.8),
      'toggle-snap':toggleSnap, 'collapse-tracks':() => {
        const collapse = project.tracks.some(track => track.collapse < 2) ? 2 : 0;
        mutate('Collapse Timeline tracks', draft => draft.tracks.forEach(track => { if (!track.locked) track.collapse = collapse; }));
      },
      rewind:() => sendTransport('rewind'), 'play-from-cursor':() => sendTransport('play-from-cursor',{cursorMs:project.cursorMs}),
      'play-pause':() => sendTransport(runtimeState.state === 'playing' ? 'pause' : 'play'),
      stop:() => sendTransport('stop'), continue:() => sendTransport('go'),
      'link-timecode':() => mutate('Change Timeline link state', draft => { draft.options.linked = !draft.options.linked; })
    };
    const run = actions[name]; if (run) run();
    closeMenus();
  }

  function bindMenus() {
    $$('[data-tl-menu]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const menu = byId(`tlMenu${button.dataset.tlMenu[0].toUpperCase()}${button.dataset.tlMenu.slice(1)}`);
      const opening = menu.hidden;
      closeMenus();
      if (opening) {
        const rect = button.getBoundingClientRect();
        menu.hidden = false; menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom}px`;
        button.setAttribute('aria-expanded', 'true');
        const first = menu.querySelector('[role^="menuitem"]'); if (first) first.focus();
      }
    }));
    $$('.tl-menu').forEach(menu => {
      menu.addEventListener('click', event => {
        const item = event.target.closest('[data-action]');
        if (item && menu.contains(item)) action(item.dataset.action);
      });
      menu.addEventListener('keydown', event => {
        const items = Array.from(menu.querySelectorAll('[role^="menuitem"]:not(:disabled)'));
        const index = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenus(); }
      });
    });
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('.tl-menu,[data-tl-menu]')) closeMenus();
    });
  }

  function closeMenus() {
    $$('.tl-menu').forEach(menu => { menu.hidden = true; });
    $$('[data-tl-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function bindStaticControls() {
    /* Direct bindings keep every operator control independently inspectable. */
    byId('tlTransport').addEventListener('pointerdown', commitFocusedEditor, true);
    byId('tlRewind').addEventListener('click', () => action('rewind'));
    byId('tlPlayFromCursor').addEventListener('click', () => action('play-from-cursor'));
    byId('tlPlayPause').addEventListener('click', () => action('play-pause'));
    byId('tlStop').addEventListener('click', () => action('stop'));
    byId('tlRecord').addEventListener('click', () => action('record'));
    byId('tlGo').addEventListener('click', () => action('continue'));
    byId('tlTimecodeLink').addEventListener('click', () => action('link-timecode'));
    byId('tlToolSelect').addEventListener('click', () => setTool('select'));
    byId('tlToolPan').addEventListener('click', () => setTool('pan'));
    byId('tlToolAdd').addEventListener('click', () => setTool('add'));
    byId('tlSnap').addEventListener('click', () => action('toggle-snap'));
    byId('tlZoomOut').addEventListener('click', () => action('zoom-out'));
    byId('tlZoomFit').addEventListener('click', () => action('zoom-fit'));
    byId('tlZoomIn').addEventListener('click', () => action('zoom-in'));
    byId('tlAddTrack').addEventListener('click', () => action('add-track'));
    byId('tlAddTrigger').addEventListener('click', () => action('add-trigger'));
    byId('tlImportMarkers').addEventListener('click', () => action('import-markers'));
    byId('tlOptions').addEventListener('click', () => action('options'));
    byId('tlSaveProject').addEventListener('click', () => action('save-project'));
    byId('tlLoadProject').addEventListener('click', () => action('load-project'));
    byId('tlUndo').addEventListener('click', undo);
    byId('tlRedo').addEventListener('click', redo);
    byId('tlGraphViewButton').addEventListener('click', () => setViewMode('graph'));
    byId('tlTableViewButton').addEventListener('click', () => setViewMode('table'));
    byId('tlDuplicateTrack').addEventListener('click', duplicateTrack);
    byId('tlRemoveTrack').addEventListener('click', removeTrack);
    byId('tlDuplicateTrigger').addEventListener('click', duplicateSelectedTriggers);
    byId('tlDeleteTrigger').addEventListener('click', deleteSelectedTriggers);
    byId('tlCollapseTracks').addEventListener('click', () => action('collapse-tracks'));
    byId('tlTimecodeSource').addEventListener('change', event => mutate('Select Timeline timecode', draft => {
      draft.options.timecodeSource = sourceLabel(event.target.value);
    }));
    byId('tlProjectName').addEventListener('change', event => mutate('Rename Timeline', draft => {
      draft.name = event.target.value;
    }));
    byId('tlProjectDuration').addEventListener('change', event => {
      const duration = Math.max(1, parse(event.target.value, project.durationMs));
      mutate('Change Timeline duration', draft => { draft.endMs = draft.startMs + duration; draft.durationMs = duration;
        draft.view.endMs = Math.min(draft.view.endMs, draft.endMs); });
    });
    byId('tlTrackName').addEventListener('change', event => updateSelectedTrack({name:event.target.value}, 'Rename Timeline track'));
    byId('tlTrackColor').addEventListener('change', event => updateSelectedTrack({color:event.target.value}, 'Colour Timeline track'));
    byId('tlTrackTarget').addEventListener('change', event => updateSelectedTrack({target:parseTarget(event.target.value)}, 'Retarget Timeline track'));
    byId('tlTrackMuted').addEventListener('change', event => updateSelectedTrack({muted:event.target.checked}, 'Mute Timeline track'));
    byId('tlTrackLocked').addEventListener('change', event => updateSelectedTrack({locked:event.target.checked}, 'Lock Timeline track'));
    byId('tlTrackCollapse').addEventListener('change', event => updateSelectedTrack({collapse:Number(event.target.value)}, 'Collapse Timeline track'));
    byId('tlInspectorType').addEventListener('change', event => updateSelectedTriggers({type:event.target.value}, 'Change trigger type'));
    byId('tlInspectorTime').addEventListener('change', event => updateSelectedTriggers({timeMs:parse(event.target.value, project.cursorMs)}, 'Change trigger time'));
    byId('tlInspectorTarget').addEventListener('change', event => updateSelectedTriggers({target:parseTarget(event.target.value)}, 'Change trigger target'));
    byId('tlInspectorLevel').addEventListener('change', event => updateSelectedTriggers({level:clamp(Number(event.target.value) / 100, 0, 1)}, 'Change trigger level'));
    byId('tlInspectorFade').addEventListener('change', event => updateSelectedTriggers({fadeMs:Math.max(0, Number(event.target.value) || 0) * 1000}, 'Change trigger fade'));
    byId('tlInspectorDuration').addEventListener('change', event => updateSelectedTriggers({durationMs:Math.max(0, Number(event.target.value) || 0) * 1000}, 'Change trigger duration'));
    byId('tlInspectorLabel').addEventListener('change', event => updateSelectedTriggers({label:event.target.value}, 'Change trigger label'));
    byId('tlAddType').addEventListener('change', event => updateTypeFieldVisibility(event.target.value, 'tlAdd'));
    byId('tlAddAtLive').addEventListener('click', () => { byId('tlAddTime').value = format(runtimeState.timeMs || runtimeState.positionMs || project.cursorMs); });
    byId('tlAddTriggerModal').addEventListener('submit', submitAddTrigger);
    byId('tlOptionsModal').addEventListener('submit', submitOptions);
    ['tlAddTriggerClose','tlAddTriggerCancel'].forEach(id => byId(id).addEventListener('click', () => closeModal('tlAddTriggerOverlay')));
    ['tlOptionsClose','tlOptionsCancel'].forEach(id => byId(id).addEventListener('click', () => closeModal('tlOptionsOverlay')));
    byId('tlAddTriggerOverlay').addEventListener('keydown', trapModal);
    byId('tlOptionsOverlay').addEventListener('keydown', trapModal);
    byId('tlAddTriggerOverlay').addEventListener('pointerdown', event => { if (event.target === event.currentTarget) closeModal(event.currentTarget.id); });
    byId('tlOptionsOverlay').addEventListener('pointerdown', event => { if (event.target === event.currentTarget) closeModal(event.currentTarget.id); });
    byId('tlProjectFileInput').addEventListener('change', event => readProjectFile(event.target.files && event.target.files[0]));
    byId('tlMarkerCsvInput').addEventListener('change', event => readMarkerFile(event.target.files && event.target.files[0]));
    byId('tlTableFilter').addEventListener('input', renderTable);
    byId('tlTimelineCanvas').addEventListener('pointerdown', onTimelinePointerDown);
    byId('tlTimelineCanvas').addEventListener('pointermove', onTimelinePointerMove);
    byId('tlTimelineCanvas').addEventListener('pointerup', onTimelinePointerUp);
    byId('tlTimelineCanvas').addEventListener('pointercancel', onTimelinePointerUp);
    byId('tlTimelineCanvas').addEventListener('dblclick', onTimelineDoubleClick);
    byId('tlTimelineCanvas').addEventListener('wheel', onTimelineWheel, {passive:false});
    byId('tlOverviewCanvas').addEventListener('pointerdown', onOverviewPointer);

    root.addEventListener('click', event => {
      const actionNode = event.target.closest('[data-action]');
      if (actionNode && !actionNode.id) action(actionNode.dataset.action);
      const trackNode = event.target.closest('[data-track-id]');
      if (!trackNode) return;
      const command = event.target.closest('[data-track-command]');
      const track = trackById(trackNode.dataset.trackId); if (!track) return;
      if (command) {
        event.stopPropagation();
        selectedTrackId = track.id;
        if (command.dataset.trackCommand === 'mute') updateSelectedTrack({muted:!track.muted}, 'Mute Timeline track');
        if (command.dataset.trackCommand === 'lock') updateSelectedTrack({locked:!track.locked}, 'Lock Timeline track');
        if (command.dataset.trackCommand === 'collapse') updateSelectedTrack({collapse:(track.collapse + 1) % 3}, 'Collapse Timeline track');
      } else selectTrack(track.id);
    });

    byId('tlTriggerTableBody').addEventListener('click', event => {
      const row = event.target.closest('[data-trigger-id]'); if (!row) return;
      selectTrigger(row.dataset.triggerId, {additive:event.shiftKey || event.ctrlKey || event.metaKey});
    });
    byId('tlTriggerTableBody').addEventListener('change', event => {
      const row = event.target.closest('[data-trigger-id]'); if (!row) return;
      const id = row.dataset.triggerId, field = event.target.dataset.field;
      if (!field) return;
      if (field === 'trackId') {
        setProject(T.moveTriggers(project, [id], 0, {targetTrackId:event.target.value}), 'Move trigger to track');
        return;
      }
      let value = event.target.value;
      if (field === 'timeMs') value = parse(value, 0);
      if (field === 'target') value = parseTarget(value);
      if (field === 'level') value = clamp(Number(value) / 100, 0, 1);
      if (field === 'fadeMs' || field === 'durationMs') value = Math.max(0, Number(value) || 0) * 1000;
      setProject(T.updateTrigger(project, id, {[field]:value}), `Edit trigger ${field}`);
    });

    document.addEventListener('keydown', event => {
      const modified = event.ctrlKey || event.metaKey;
      if (isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if (modified && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (modified && key === 'y') { event.preventDefault(); redo(); return; }
      if (modified && key === 'a') { event.preventDefault(); action('select-all'); return; }
      if (event.key === ' ') {
        event.preventDefault();
        if (event.shiftKey) sendTransport('play-from-cursor', {cursorMs:project.cursorMs});
        else sendTransport(runtimeState.state === 'playing' ? 'pause' : 'play');
        return;
      }
      if (event.key === 'Home') { event.preventDefault(); setCursor(project.startMs); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelectedTriggers(); return; }
      if (event.key === 'Escape') { sendTransport('stop'); closeMenus(); return; }
      if (key === 'v') setTool('select');
      if (key === 'h') setTool('pan');
      if (key === 'a') setTool('add');
      if (key === 'r') toggleRecord();
      if (key === 'g') sendTransport('go');
      if (event.key === '+' || event.key === '=') zoom(1.25);
      if (event.key === '-') zoom(.8);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 1000 : 40;
        if (selectedTriggerIds.size) {
          const next = T.moveTriggers(project, Array.from(selectedTriggerIds), event.key === 'ArrowLeft' ? -step : step);
          setProject(next, 'Nudge Timeline triggers');
        } else setCursor(project.cursorMs + (event.key === 'ArrowLeft' ? -step : step));
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === ' ' && document.activeElement === byId('tlTimelineCanvas')) {
        temporaryPan = true; updateToolButtons();
      }
    });
    document.addEventListener('keyup', event => { if (event.key === ' ') { temporaryPan = false; updateToolButtons(); } });
    global.addEventListener('resize', markAllDirty);
    global.addEventListener('pagehide', () => { if (saveTimer) flushPersist(); });
    global.addEventListener('openlive:appearancechange', markAllDirty);
    bindMenus();
  }

  function bindSharedState() {
    if (Hub && Hub.subscribe) Hub.subscribe('timeline.project', (value, meta) => {
      if (!value) return;
      const incoming = T.normaliseProject(value);
      const signature = projectSignature(incoming);
      if (signature === projectSignature(project) || signature === lastSavedSignature) return;
      if (saveTimer && Number(project.updatedAt) >= Number(incoming.updatedAt)) return;
      clearTimeout(saveTimer); saveTimer = 0; pendingSaveReason = '';
      project = incoming; ensureSelection();
      if (previewRuntime) previewRuntime.setProject(project, {preservePosition:true});
      markAllDirty(); renderAll(); status(`Updated from ${meta && meta.source || 'SHOWAVE'}`);
    }, {immediate:false});
    if (Hub && Hub.on) {
      Hub.on('timeline:runtime', detail => {
        hostSeenAt = performance.now();
        runtimeState = Object.assign({}, detail || {}, {
          timeMs:Number(detail && (detail.timeMs == null ? detail.positionMs : detail.timeMs)) || project.startMs,
          waiting:detail && detail.state === 'waiting'
        });
        if (previewRuntime && previewRuntime.isPlaying) previewRuntime.pause();
        const connection = byId('tlConnectionStatus');
        connection.innerHTML = `<i aria-hidden="true"></i>${detail && detail.unavailable ? escapeHtml(detail.message || 'External timecode unavailable') :
          detail && detail.liveArena ? 'SHOWAVE Live · Arena connected' : 'SHOWAVE Live · local engine'}`;
        connection.dataset.state = detail && detail.unavailable ? 'disabled' : 'live';
        renderPlaybackState();
      });
      Hub.on('timeline:execution', detail => {
        if (detail && detail.triggerId) executionStates.set(detail.triggerId, detail);
        if (detail && detail.message) status(detail.message, detail.state === 'failed' ? 'error' : detail.state);
        canvasDirty = true;
      });
      Hub.on('timeline:recordable', recordLiveAction);
      Hub.emit('timeline:transport', {action:'status',requestedAt:Date.now()}, {activity:false});
    }
    if (Bus && Bus.onSnapshot) Bus.onSnapshot(snapshot => {
      busSnapshot = snapshot; renderAll();
    });
    if (Bus && Bus.hello) Bus.hello();
  }

  function updatePlayheadDom() {
    const time = Number(runtimeState.timeMs == null ? runtimeState.positionMs : runtimeState.timeMs);
    if (!graphLayout || !Number.isFinite(time)) return;
    const x = graphLayout.xForTime(time), cursorX = graphLayout.xForTime(project.cursorMs);
    byId('tlPlayhead').style.left = `${x}px`;
    byId('tlCursor').style.left = `${cursorX}px`;
    if (overviewLayout) {
      byId('tlOverviewLive').style.left = `${overviewLayout.xForTime(time)}px`;
      byId('tlOverviewCursor').style.left = `${overviewLayout.xForTime(project.cursorMs)}px`;
    }
  }

  function animationFrame(now) {
    const elapsed = Math.max(0, now - lastFrameAt); lastFrameAt = now;
    if (previewRuntime && previewRuntime.isPlaying && now - hostSeenAt > 2000) {
      previewRuntime.tick(now);
      const snapshot = previewRuntime.snapshot();
      runtimeState = Object.assign({}, snapshot, {timeMs:snapshot.positionMs,local:true});
    }
    renderTimeline(); renderOverview(); updatePlayheadDom();
    if (elapsed >= 0) renderPlaybackState();
    requestAnimationFrame(animationFrame);
  }

  global.__showaveTimelineBootStep = 'binding-controls';
  bindStaticControls();
  global.__showaveTimelineBootStep = 'binding-shared-state';
  bindSharedState();
  global.__showaveTimelineBootStep = 'initial-render';
  renderAll();
  global.__showaveTimelineBootStep = 'initial-persist';
  flushPersist();
  global.__showaveTimelineBootStep = 'animation';
  requestAnimationFrame(animationFrame);

  global.__showaveTimeline = {
    get project() { return clone(project); },
    get runtime() { return Object.assign({}, runtimeState); },
    get selection() { return {trackId:selectedTrackId,triggerIds:Array.from(selectedTriggerIds)}; },
    addTrack, openAddTrigger, sendTransport, flushPersist,
    setProject(value) { return setProject(T.normaliseProject(value), 'Diagnostic project replace'); }
  };
  global.__showaveTimelineBootStep = 'ready';
})(window);
