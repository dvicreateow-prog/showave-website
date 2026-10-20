/* SHOWAVE Timeline
   -------------------------------------------------------------------------
   Dependency-free timeline document and playback contract. The editor and
   the Arena host share this module so persisted documents, preview playback
   and live playback all use the same ordering and crossing rules.

   A Timeline automates SHOWAVE controls; it does not synthesize SMPTE, MIDI
   clock, LTC or any other external timecode signal. Linked external time is
   supplied to Runtime.tick()/setLinkedTime() by the host integration.
   ------------------------------------------------------------------------- */
(function installOpenLiveTimeline(global) {
  'use strict';

  if (global.OpenLiveTimeline) return;

  const SCHEMA = 1;
  const SCHEMA_NAME = 'showave.timeline.document/1';
  const DEFAULT_DURATION_MS = 5 * 60 * 1000;
  const MAX_TIME_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_TRACKS = 512;
  const MAX_TRIGGERS = 100000;
  const DEFAULT_FPS = 25;
  const EPSILON = 0.000001;

  /* These names intentionally match the Avolites Timeline trigger names.
     Trigger Clip and Lighting Cue are SHOWAVE extensions kept separate from
     the official set. */
  const TRIGGER_TYPES = Object.freeze([
    'Set Level',
    'Go to cue',
    'Flash',
    'Timed Flash',
    'Timed Flash and Go',
    'Swop',
    'Preload',
    'Marker',
    'Wait for Go'
  ]);
  const EXTENSION_TRIGGER_TYPES = Object.freeze(['Trigger Clip', 'Lighting Cue']);
  const ALL_TRIGGER_TYPES = Object.freeze(TRIGGER_TYPES.concat(EXTENSION_TRIGGER_TYPES));
  const TRACK_COLORS = Object.freeze([
    '#4ea1ff', '#38c997', '#ffb547', '#a980ff', '#ff6b78', '#43c7d8',
    '#d6d85a', '#ea7ed5', '#7898ff', '#82c46c', '#ff8d58', '#a9b2bf'
  ]);

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const text = (value, limit) => String(value == null ? '' : value)
    .normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    .slice(0, limit == null ? 512 : limit);
  const keyText = value => text(value, 128).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const now = () => Date.now();
  const uid = prefix => `${prefix || 'timeline'}:${now().toString(36)}:${
    global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

  function integer(value, fallback, min, max) {
    return clamp(Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback, min, max);
  }

  function uniqueId(value, fallback, used) {
    const base = text(value, 256) || fallback;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}:${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  function fpsValue(value) {
    const number = finite(value, DEFAULT_FPS);
    return clamp(number > 0 ? number : DEFAULT_FPS, 1, 120);
  }

  function parseTime(value, fps) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    let source = String(value).trim();
    if (!source) return null;
    let sign = 1;
    if (source[0] === '-' || source[0] === '+') {
      sign = source[0] === '-' ? -1 : 1;
      source = source.slice(1).trim();
    }
    const unit = source.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)$/i);
    if (unit) {
      const scale = {ms:1, s:1000, m:60000, h:3600000}[unit[2].toLowerCase()];
      return sign * Number(unit[1]) * scale;
    }
    /* A bare string is operator-entered time and follows console convention:
       seconds, including fractional seconds. Numeric API values are already
       milliseconds and are returned unchanged above. */
    if (/^\d+(?:\.\d+)?$/.test(source)) return sign * Number(source) * 1000;

    /* Frame notation is HH:MM:SS:FF (or MM:SS:FF). Dot notation uses
       milliseconds. A decimal seconds field remains legal in either form. */
    const frameMatch = source.match(/^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,3})$/);
    if (frameMatch) {
      const rate = fpsValue(fps);
      const hours = Number(frameMatch[1]);
      const minutes = Number(frameMatch[2]);
      const seconds = Number(frameMatch[3]);
      const frames = Number(frameMatch[4]);
      if (minutes > 59 || seconds > 59 || frames >= Math.ceil(rate)) return null;
      return sign * (((hours * 60 + minutes) * 60 + seconds) * 1000 +
        frames * 1000 / rate);
    }
    const clockMatch = source.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,6}))?$/);
    if (!clockMatch) return null;
    const hours = Number(clockMatch[1] || 0);
    const minutes = Number(clockMatch[2]);
    const seconds = Number(clockMatch[3]);
    if (minutes > 59 || seconds > 59) return null;
    const fraction = clockMatch[4]
      ? Number(`0.${clockMatch[4]}`) * 1000 : 0;
    return sign * (((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction);
  }

  function timeValue(value, fallback, min, max, fps) {
    const parsed = parseTime(value, fps);
    return clamp(parsed == null ? fallback : parsed, min, max);
  }

  function formatTime(value, options) {
    const opts = typeof options === 'number' ? {fps:options, frames:true} : (options || {});
    const negative = finite(value, 0) < 0;
    let milliseconds = Math.abs(finite(value, 0));
    const rate = fpsValue(opts.fps);
    let totalSeconds = Math.floor(milliseconds / 1000);
    let remainder = milliseconds - totalSeconds * 1000;
    let frames = Math.floor((remainder / 1000) * rate + EPSILON);
    if (frames >= Math.ceil(rate)) {
      totalSeconds += 1;
      frames = 0;
      remainder = 0;
    }
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    const pad = (number, width) => String(number).padStart(width, '0');
    const prefix = negative ? '-' : '';
    if (opts.frames || opts.format === 'frames')
      return `${prefix}${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(frames, 2)}`;
    const millis = Math.floor(remainder + EPSILON);
    return `${prefix}${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
  }

  function canonicalTriggerType(value) {
    const wanted = keyText(value);
    const aliases = {
      setlevel:'Set Level', level:'Set Level', fader:'Set Level',
      gotocue:'Go to cue', go:'Go to cue', cue:'Go to cue',
      flash:'Flash', timedflash:'Timed Flash',
      timedflashandgo:'Timed Flash and Go', flashandgo:'Timed Flash and Go',
      swop:'Swop', swap:'Swop', preload:'Preload', marker:'Marker',
      waitforgo:'Wait for Go', wait:'Wait for Go', triggerclip:'Trigger Clip',
      clip:'Trigger Clip', lightingcue:'Lighting Cue', lightcue:'Lighting Cue',
      gsl5cue:'Lighting Cue', fixturecue:'Lighting Cue'
    };
    return aliases[wanted] || ALL_TRIGGER_TYPES.find(type => keyText(type) === wanted) || 'Set Level';
  }

  function normaliseColor(value, fallback) {
    const safe = text(value, 64);
    return safe && (/^#[0-9a-f]{3,8}$/i.test(safe) ||
      /^(rgb|hsl)a?\([^)]{1,50}\)$/i.test(safe)) ? safe : fallback;
  }

  function normaliseTarget(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const kind = text(source.kind || source.type, 64).toLowerCase() || 'show';
    const target = {kind};
    ['id', 'name', 'layerId', 'groupId', 'clipId', 'cueId', 'cueNumber',
      'lightingCueId', 'deckId', 'columnId', 'fixtureId', 'cueListId', 'executorId']
      .forEach(property => {
        const value = text(source[property], 256);
        if (value) target[property] = value;
      });
    ['index', 'layerIndex', 'groupIndex', 'clipIndex', 'cueIndex', 'deckIndex', 'columnIndex',
      'fixtureIndex', 'cueListIndex', 'executorIndex']
      .forEach(property => {
        if (Number.isFinite(Number(source[property]))) target[property] = Math.max(0,
          Math.round(Number(source[property])));
      });
    ['layer', 'group', 'clip', 'cue', 'deck', 'column', 'fixture', 'cueList', 'executor'].forEach(alias => {
      if (source[alias] == null || source[alias] === '') return;
      if (Number.isFinite(Number(source[alias])))
        target[`${alias}Index`] = Math.max(0, Math.round(Number(source[alias])));
      else {
        const value = text(source[alias], 256);
        if (value) target[`${alias}Id`] = value;
      }
    });
    return target;
  }

  function normaliseLevel(value, fallback) {
    if (typeof value === 'string' && /%\s*$/.test(value))
      return clamp(finite(value.replace(/%\s*$/, ''), fallback * 100) / 100, 0, 1);
    const number = finite(value, fallback);
    return clamp(number > 1 && number <= 100 ? number / 100 : number, 0, 1);
  }

  function normaliseTrigger(raw, index, used, trackId, fps) {
    index = integer(index, 0, 0, MAX_TRIGGERS);
    used = used instanceof Set ? used : new Set();
    trackId = text(trackId, 256) || 'track:1';
    fps = fpsValue(fps);
    const source = raw && typeof raw === 'object' ? raw : {};
    const type = canonicalTriggerType(source.type || source.kind);
    const fallbackDuration = type === 'Timed Flash' || type === 'Timed Flash and Go' ? 1000 : 0;
    const trigger = {
      id:uniqueId(source.id, `${trackId}:trigger:${index + 1}`, used),
      type,
      timeMs:timeValue(source.timeMs == null ? source.time : source.timeMs,
        0, 0, MAX_TIME_MS, fps),
      durationMs:timeValue(source.durationMs == null ? source.duration : source.durationMs,
        fallbackDuration, 0, MAX_TIME_MS, fps),
      fadeMs:timeValue(source.fadeMs == null ? source.fade : source.fadeMs,
        0, 0, MAX_TIME_MS, fps),
      level:normaliseLevel(source.level, 1),
      enabled:source.enabled !== false,
      label:text(source.label || source.legend || source.name, 512),
      color:normaliseColor(source.color, ''),
      /* A missing target inherits the Track target at dispatch time.  Keep it
         distinct from an explicitly authored Show Master target. */
      target:source.target && typeof source.target === 'object'
        ? normaliseTarget(source.target) : null,
      payload:source.payload && typeof source.payload === 'object' ? clone(source.payload) : {},
      action:source.action && typeof source.action === 'object' ? clone(source.action) : null,
      metadata:source.metadata && typeof source.metadata === 'object' ? clone(source.metadata) : {}
    };
    if (!trigger.label && type === 'Marker') trigger.label = `Marker ${index + 1}`;
    return trigger;
  }

  function collapseValue(value) {
    if (typeof value === 'string') {
      const key = keyText(value);
      if (key === 'collapsed' || key === 'closed') return 2;
      if (key === 'compact' || key === 'summary') return 1;
      return 0;
    }
    return integer(value, 0, 0, 2);
  }

  function normaliseTrack(raw, index, trackIds, triggerIds, count, fps) {
    index = integer(index, 0, 0, MAX_TRACKS);
    trackIds = trackIds instanceof Set ? trackIds : new Set();
    triggerIds = triggerIds instanceof Set ? triggerIds : new Set();
    count = count && Number.isFinite(Number(count.value)) ? count : {value:0};
    fps = fpsValue(fps);
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = uniqueId(source.id, `track:${index + 1}`, trackIds);
    const limit = Math.max(0, MAX_TRIGGERS - count.value);
    const triggers = (Array.isArray(source.triggers) ? source.triggers : [])
      .slice(0, limit)
      .map((trigger, triggerIndex) => normaliseTrigger(trigger, triggerIndex,
        triggerIds, id, fps))
      /* Array.prototype.sort is stable in supported runtimes. Preserve the
         authored order for same-time triggers so a deliberately placed Wait
         for Go can gate actions which follow it at the same timestamp. */
      .sort((left, right) => left.timeMs - right.timeMs);
    count.value += triggers.length;
    return {
      id,
      name:text(source.name, 256) || `Track ${index + 1}`,
      color:normaliseColor(source.color, TRACK_COLORS[index % TRACK_COLORS.length]),
      muted:!!source.muted,
      locked:!!source.locked,
      collapse:collapseValue(source.collapse == null ? source.collapsed : source.collapse),
      target:normaliseTarget(source.target),
      triggers
    };
  }

  function normaliseSnap(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      triggers:source.triggers !== false,
      markers:source.markers !== false,
      cursor:source.cursor !== false,
      gridMs:timeValue(source.gridMs, 0, 0, 60 * 60 * 1000, DEFAULT_FPS),
      thresholdMs:timeValue(source.thresholdMs, 100, 0, 60 * 1000, DEFAULT_FPS)
    };
  }

  function normaliseOptions(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const fps = fpsValue(source.fps);
    const timecodeSource = text(source.timecodeSource || source.source, 64) || 'Internal';
    const activate = text(source.activateInRange, 32);
    const raised = text(source.faderRaisedAction, 32);
    const zero = text(source.faderZeroAction, 32);
    return {
      timecodeSource,
      linked:!!source.linked,
      offsetMs:timeValue(source.offsetMs == null ? source.timeOffsetMs : source.offsetMs,
        0, -MAX_TIME_MS, MAX_TIME_MS, fps),
      fps,
      loop:!!source.loop,
      activateInRange:['100%', '0%', 'Off'].includes(activate) ? activate : '100%',
      killOutOfRange:source.killOutOfRange !== false,
      faderRaisedAction:['No Action', 'Play'].includes(raised) ? raised : 'No Action',
      faderZeroAction:['No Action', 'Stop', 'Pause'].includes(zero) ? zero : 'No Action',
      killAtZero:!!source.killAtZero,
      releaseToHome:!!source.releaseToHome,
      releaseTimeMs:timeValue(source.releaseTimeMs, 2000, 0, 60 * 60 * 1000, fps),
      snap:normaliseSnap(source.snap)
    };
  }

  function normaliseView(raw, startMs, endMs) {
    const source = raw && typeof raw === 'object' ? raw : {};
    let viewStart = timeValue(source.startMs, startMs, startMs, endMs, DEFAULT_FPS);
    let viewEnd = timeValue(source.endMs, endMs, startMs, endMs, DEFAULT_FPS);
    if (viewEnd <= viewStart) {
      viewStart = startMs;
      viewEnd = endMs;
    }
    return {
      startMs:viewStart,
      endMs:viewEnd,
      tool:keyText(source.tool) === 'pan' ? 'pan' : 'select',
      table:!!source.table,
      zoom:clamp(finite(source.zoom, 1), 0.01, 10000),
      scrollTrack:Math.max(0, integer(source.scrollTrack, 0, 0, MAX_TRACKS))
    };
  }

  function normaliseRuntime(raw, cursorMs, startMs, endMs) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const validStates = ['stopped', 'paused', 'playing', 'waiting'];
    return {
      state:validStates.includes(source.state) ? source.state : 'stopped',
      positionMs:timeValue(source.positionMs, cursorMs, startMs, endMs, DEFAULT_FPS),
      selectedTrackIds:[...new Set((Array.isArray(source.selectedTrackIds)
        ? source.selectedTrackIds : []).map(id => text(id, 256)).filter(Boolean))],
      selectedTriggerIds:[...new Set((Array.isArray(source.selectedTriggerIds)
        ? source.selectedTriggerIds : []).map(id => text(id, 256)).filter(Boolean))]
    };
  }

  function normaliseProject(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const options = normaliseOptions(source.options);
    const startMs = timeValue(source.startMs == null ? source.start : source.startMs,
      0, 0, MAX_TIME_MS - 1, options.fps);
    const suppliedDuration = timeValue(source.durationMs == null ? source.duration : source.durationMs,
      DEFAULT_DURATION_MS, 1, MAX_TIME_MS, options.fps);
    let endMs = source.endMs == null && source.end == null
      ? startMs + suppliedDuration
      : timeValue(source.endMs == null ? source.end : source.endMs,
        startMs + suppliedDuration, startMs + 1, MAX_TIME_MS, options.fps);
    endMs = clamp(endMs, startMs + 1, MAX_TIME_MS);
    const trackIds = new Set();
    const triggerIds = new Set();
    const count = {value:0};
    const tracks = (Array.isArray(source.tracks) ? source.tracks : [])
      .slice(0, MAX_TRACKS)
      .map((track, index) => normaliseTrack(track, index, trackIds,
        triggerIds, count, options.fps));
    tracks.forEach(track => {
      track.triggers.forEach(trigger => {
        trigger.timeMs = clamp(trigger.timeMs, startMs, endMs);
        const remaining = Math.max(0, endMs - trigger.timeMs);
        trigger.durationMs = clamp(trigger.durationMs, 0, remaining);
        trigger.fadeMs = clamp(trigger.fadeMs, 0, remaining);
      });
      track.triggers.sort((left, right) => left.timeMs - right.timeMs);
    });
    const cursorMs = timeValue(source.cursorMs == null ? source.cursor : source.cursorMs,
      startMs, startMs, endMs, options.fps);
    const project = {
      schema:SCHEMA_NAME,
      schemaVersion:SCHEMA,
      id:text(source.id, 256) || 'timeline:document',
      name:text(source.name, 256) || 'Timeline 1',
      startMs,
      endMs,
      durationMs:endMs - startMs,
      cursorMs,
      options,
      tracks,
      view:normaliseView(source.view, startMs, endMs),
      runtime:normaliseRuntime(source.runtime, cursorMs, startMs, endMs),
      updatedAt:Math.max(0, finite(source.updatedAt, 0))
    };
    project.runtime.selectedTrackIds = project.runtime.selectedTrackIds
      .filter(id => trackIds.has(id));
    project.runtime.selectedTriggerIds = project.runtime.selectedTriggerIds
      .filter(id => triggerIds.has(id));
    return project;
  }

  function createProject(name, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const id = text(opts.id, 256) || uid('timeline');
    return normaliseProject({
      schema:SCHEMA_NAME,
      id,
      name:text(name, 256) || text(opts.name, 256) || 'Timeline 1',
      startMs:opts.startMs,
      endMs:opts.endMs,
      durationMs:opts.durationMs,
      cursorMs:opts.cursorMs,
      options:opts.options || opts,
      tracks:Array.isArray(opts.tracks) ? opts.tracks : [{
        id:`${id}:track:1`, name:'Track 1', color:TRACK_COLORS[0], triggers:[]
      }],
      view:opts.view,
      updatedAt:opts.updatedAt == null ? now() : opts.updatedAt
    });
  }

  function shareableProject(project) {
    const output = clone(normaliseProject(project));
    delete output.runtime;
    /* Defensive cleanup for documents imported from experimental builds. */
    Object.keys(output).forEach(key => {
      if (key[0] === '_' || /^(playing|playhead|selection|lastTick|waiting)/i.test(key))
        delete output[key];
    });
    output.tracks.forEach(track => {
      Object.keys(track).forEach(key => { if (key[0] === '_') delete track[key]; });
      track.triggers.forEach(trigger => {
        Object.keys(trigger).forEach(key => { if (key[0] === '_') delete trigger[key]; });
      });
    });
    return output;
  }

  function triggerRecords(project, options) {
    const safe = normaliseProject(project);
    const opts = options || {};
    const records = [];
    safe.tracks.forEach((track, trackIndex) => {
      if (opts.audible && track.muted) return;
      track.triggers.forEach((trigger, triggerIndex) => {
        if (opts.enabled && !trigger.enabled) return;
        records.push({track, trigger, trackIndex, triggerIndex});
      });
    });
    return records.sort((left, right) => left.trigger.timeMs - right.trigger.timeMs ||
      left.trackIndex - right.trackIndex || left.triggerIndex - right.triggerIndex ||
      left.trigger.id.localeCompare(right.trigger.id));
  }

  function markerRecords(project) {
    return triggerRecords(project).filter(record => record.trigger.type === 'Marker');
  }

  function findTrack(project, id) {
    const wanted = text(id, 256);
    return normaliseProject(project).tracks.find(track => track.id === wanted) || null;
  }

  function findTrigger(project, id) {
    const wanted = text(id, 256);
    return triggerRecords(project).find(record => record.trigger.id === wanted) || null;
  }

  function touch(project, change, at) {
    const draft = clone(normaliseProject(project));
    change(draft);
    draft.updatedAt = at == null ? now() : Math.max(0, finite(at, draft.updatedAt));
    return normaliseProject(draft);
  }

  function addTrack(project, track, options) {
    return touch(project, draft => {
      if (draft.tracks.length < MAX_TRACKS) draft.tracks.push(track || {});
    }, options && options.at);
  }

  function updateTrack(project, trackId, patch, options) {
    const wanted = text(trackId, 256);
    return touch(project, draft => {
      const index = draft.tracks.findIndex(track => track.id === wanted);
      if (index < 0 || (draft.tracks[index].locked && !(options && options.force))) return;
      const value = typeof patch === 'function' ? patch(clone(draft.tracks[index])) :
        Object.assign({}, draft.tracks[index], patch || {});
      draft.tracks[index] = value || draft.tracks[index];
    }, options && options.at);
  }

  function removeTrack(project, trackId, options) {
    const wanted = text(trackId, 256);
    return touch(project, draft => {
      draft.tracks = draft.tracks.filter(track => track.id !== wanted ||
        (track.locked && !(options && options.force)));
    }, options && options.at);
  }

  function addTrigger(project, trackId, trigger, options) {
    const wanted = text(trackId, 256);
    return touch(project, draft => {
      const track = draft.tracks.find(item => item.id === wanted);
      if (!track || (track.locked && !(options && options.force))) return;
      const count = draft.tracks.reduce((sum, item) => sum + item.triggers.length, 0);
      if (count < MAX_TRIGGERS) track.triggers.push(trigger || {});
    }, options && options.at);
  }

  function updateTrigger(project, triggerId, patch, options) {
    const wanted = text(triggerId, 256);
    return touch(project, draft => {
      for (const track of draft.tracks) {
        const index = track.triggers.findIndex(trigger => trigger.id === wanted);
        if (index < 0) continue;
        if (track.locked && !(options && options.force)) return;
        const value = typeof patch === 'function' ? patch(clone(track.triggers[index])) :
          Object.assign({}, track.triggers[index], patch || {});
        track.triggers[index] = value || track.triggers[index];
        return;
      }
    }, options && options.at);
  }

  function selectedIds(selection) {
    if (selection instanceof Set) selection = [...selection];
    if (!Array.isArray(selection)) selection = selection == null ? [] : [selection];
    return new Set(selection.map(item => text(item && typeof item === 'object'
      ? item.triggerId || item.id : item, 256)).filter(Boolean));
  }

  function removeTriggers(project, selection, options) {
    const ids = selectedIds(selection);
    return touch(project, draft => {
      draft.tracks.forEach(track => {
        if (track.locked && !(options && options.force)) return;
        track.triggers = track.triggers.filter(trigger => !ids.has(trigger.id));
      });
    }, options && options.at);
  }

  function mutationRecords(project, selection, options) {
    const ids = selectedIds(selection);
    return triggerRecords(project).filter(record => ids.has(record.trigger.id) &&
      (!(record.track.locked) || options && options.force));
  }

  function blockDelta(records, deltaMs, project, options) {
    if (!records.length) return 0;
    const earliest = Math.min(...records.map(record => record.trigger.timeMs));
    const latest = Math.max(...records.map(record => record.trigger.timeMs));
    let delta = finite(deltaMs, 0);
    if (options && options.absoluteTimeMs != null)
      delta = finite(options.absoluteTimeMs, earliest) - earliest;
    delta = clamp(delta, project.startMs - earliest, project.endMs - latest);
    if (options && options.snap) {
      const detail = snapTimeDetailed(earliest + delta, project,
        Object.assign({}, options.snap, {excludeIds:records.map(record => record.trigger.id)}));
      delta += detail.timeMs - (earliest + delta);
      delta = clamp(delta, project.startMs - earliest, project.endMs - latest);
    }
    return delta;
  }

  function moveTriggers(project, selection, deltaMs, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const safe = normaliseProject(project);
    const records = mutationRecords(safe, selection, opts);
    if (!records.length) return safe;
    const delta = blockDelta(records, deltaMs, safe, opts);
    const targetId = text(opts.targetTrackId || opts.trackId, 256);
    if (targetId) {
      const destination = safe.tracks.find(track => track.id === targetId);
      if (!destination || (destination.locked && !opts.force)) return safe;
    }
    const ids = new Set(records.map(record => record.trigger.id));
    return touch(safe, draft => {
      const moved = [];
      draft.tracks.forEach(track => {
        const retained = [];
        track.triggers.forEach(trigger => {
          if (!ids.has(trigger.id)) return retained.push(trigger);
          trigger.timeMs += delta;
          if (targetId) moved.push(trigger);
          else retained.push(trigger);
        });
        track.triggers = retained;
      });
      if (targetId) {
        const destination = draft.tracks.find(track => track.id === targetId);
        destination.triggers.push(...moved);
      }
    }, opts.at);
  }

  function copyTriggers(project, selection, deltaMs, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const safe = normaliseProject(project);
    const records = mutationRecords(safe, selection, opts);
    if (!records.length) return safe;
    const delta = blockDelta(records, deltaMs, safe, opts);
    const targetId = text(opts.targetTrackId || opts.trackId, 256);
    if (targetId) {
      const destination = safe.tracks.find(track => track.id === targetId);
      if (!destination || (destination.locked && !opts.force)) return safe;
    }
    const used = new Set(triggerRecords(safe).map(record => record.trigger.id));
    const copies = records.map((record, index) => {
      const copy = clone(record.trigger);
      const requested = typeof opts.idFactory === 'function'
        ? opts.idFactory(record.trigger, index) : uid('trigger');
      copy.id = uniqueId(requested, `trigger:copy:${index + 1}`, used);
      copy.timeMs += delta;
      return {sourceTrackId:record.track.id, trigger:copy};
    });
    return touch(safe, draft => {
      copies.forEach(copy => {
        const track = draft.tracks.find(item => item.id === (targetId || copy.sourceTrackId));
        if (track) track.triggers.push(copy.trigger);
      });
    }, opts.at);
  }

  function parseCsvRows(source) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const input = String(source == null ? '' : source).replace(/^\uFEFF/, '');
    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quoted) {
        if (character === '"' && input[index + 1] === '"') {
          field += '"'; index++;
        } else if (character === '"') quoted = false;
        else field += character;
      } else if (character === '"') quoted = true;
      else if (character === ',') { row.push(field.trim()); field = ''; }
      else if (character === '\n' || character === '\r') {
        if (character === '\r' && input[index + 1] === '\n') index++;
        row.push(field.trim()); field = '';
        if (row.some(value => value !== '')) rows.push(row);
        row = [];
      } else field += character;
    }
    row.push(field.trim());
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
  }

  function likelyTime(value) {
    return /^[-+]?\d{1,4}:\d{1,2}:\d{1,2}(?:[:.,]\d{1,6})?$/.test(String(value).trim()) ||
      /^[-+]?\d{1,3}:\d{1,2}(?:[.,]\d{1,6})?$/.test(String(value).trim()) ||
      /^\d+(?:\.\d+)?\s*(?:ms|s|m|h)$/i.test(String(value).trim()) ||
      /^\d+(?:\.\d+)?$/.test(String(value).trim());
  }

  function parseMarkerCsv(source, options) {
    const opts = typeof options === 'number' ? {fps:options} : (options || {});
    const fps = fpsValue(opts.fps);
    const rows = parseCsvRows(source);
    if (!rows.length) return [];
    const headerKeys = rows[0].map(keyText);
    const timeNames = ['time', 'timecode', 'position', 'start', 'starttime'];
    const labelNames = ['name', 'marker', 'label', 'description', 'title'];
    const colorNames = ['color', 'colour'];
    const indexOf = names => headerKeys.findIndex(key => names.includes(key));
    let timeIndex = indexOf(timeNames);
    let labelIndex = indexOf(labelNames);
    let colorIndex = indexOf(colorNames);
    const hasHeader = timeIndex >= 0 || labelIndex >= 0 || colorIndex >= 0 ||
      headerKeys.some(key => key === 'id' || key === 'number' || key === 'region');
    const output = [];
    rows.slice(hasHeader ? 1 : 0).forEach((row, rowIndex) => {
      let selectedTime = timeIndex >= 0 ? row[timeIndex] : '';
      if (!likelyTime(selectedTime)) {
        const found = row.findIndex(likelyTime);
        if (found < 0) return;
        selectedTime = row[found];
        if (timeIndex < 0) timeIndex = found;
      }
      const parsed = parseTime(selectedTime, fps);
      if (parsed == null) return;
      let label = labelIndex >= 0 ? text(row[labelIndex], 512) : '';
      if (!label) {
        label = text(row.find((value, index) => index !== timeIndex && value &&
          !/^\d+$/.test(value)), 512);
      }
      const markerNumber = output.length + 1;
      output.push({
        id:`marker:import:${markerNumber}`,
        type:'Marker',
        timeMs:clamp(parsed + finite(opts.offsetMs, 0), 0, MAX_TIME_MS),
        durationMs:0,
        fadeMs:0,
        level:1,
        enabled:true,
        label:label || `${text(opts.labelPrefix, 128) || 'Marker'} ${markerNumber}`,
        color:normaliseColor(colorIndex >= 0 ? row[colorIndex] : opts.color, ''),
        target:{kind:'timeline'},
        payload:{importRow:(hasHeader ? 2 : 1) + rowIndex},
        action:null,
        metadata:{imported:true}
      });
    });
    return output.sort((left, right) => left.timeMs - right.timeMs ||
      left.id.localeCompare(right.id));
  }

  function snapCandidates(project, options) {
    const opts = options || {};
    const values = [];
    const exclude = selectedIds(opts.excludeIds);
    if (Array.isArray(project)) {
      project.forEach((value, index) => {
        const time = typeof value === 'object' ? parseTime(value.timeMs) : parseTime(value);
        if (time != null) values.push({timeMs:time, kind:'point', id:text(value && value.id) || String(index)});
      });
      return values;
    }
    const safe = normaliseProject(project);
    const useTriggers = opts.triggers == null ? safe.options.snap.triggers : !!opts.triggers;
    const useMarkers = opts.markers == null ? safe.options.snap.markers : !!opts.markers;
    if (useTriggers || useMarkers) triggerRecords(safe).forEach(record => {
      if (exclude.has(record.trigger.id)) return;
      const marker = record.trigger.type === 'Marker';
      if ((marker && useMarkers) || (!marker && useTriggers)) values.push({
        timeMs:record.trigger.timeMs,
        kind:marker ? 'marker' : 'trigger',
        id:record.trigger.id
      });
    });
    if (opts.cursor == null ? safe.options.snap.cursor : !!opts.cursor)
      values.push({timeMs:safe.cursorMs, kind:'cursor', id:'cursor'});
    const gridMs = finite(opts.gridMs, safe.options.snap.gridMs);
    if (gridMs > 0) {
      const target = finite(opts.valueMs, safe.cursorMs);
      const nearest = Math.round((target - safe.startMs) / gridMs) * gridMs + safe.startMs;
      values.push({timeMs:clamp(nearest, safe.startMs, safe.endMs), kind:'grid', id:'grid'});
    }
    return values;
  }

  function snapTimeDetailed(value, project, options) {
    const opts = typeof options === 'number' ? {thresholdMs:options} : (options || {});
    const safeValue = finite(value, 0);
    const defaults = Array.isArray(project) ? 100 : normaliseProject(project).options.snap.thresholdMs;
    const threshold = Math.max(0, finite(opts.thresholdMs, defaults));
    const candidates = snapCandidates(project, Object.assign({}, opts, {valueMs:safeValue}));
    let best = null;
    candidates.forEach(candidate => {
      const distanceMs = Math.abs(candidate.timeMs - safeValue);
      if (distanceMs > threshold + EPSILON) return;
      if (!best || distanceMs < best.distanceMs - EPSILON ||
          (Math.abs(distanceMs - best.distanceMs) <= EPSILON &&
            (candidate.timeMs < best.timeMs || (candidate.timeMs === best.timeMs &&
              `${candidate.kind}:${candidate.id}` < `${best.kind}:${best.id}`))))
        best = Object.assign({}, candidate, {distanceMs});
    });
    return best ? Object.assign({snapped:true}, best) : {
      timeMs:safeValue, snapped:false, kind:null, id:null, distanceMs:null
    };
  }

  function snapTime(value, project, options) {
    return snapTimeDetailed(value, project, options).timeMs;
  }

  function pointValues(raw, index) {
    if (Array.isArray(raw)) return {source:raw, index, timeMs:finite(raw[0], index), level:finite(raw[1], 0)};
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      source,
      index,
      timeMs:finite(source.timeMs == null ? source.time : source.timeMs, index),
      level:finite(source.level == null ? source.value : source.level, 0)
    };
  }

  function simplifyPoints(rawPoints, tolerance, options) {
    const opts = typeof tolerance === 'object' ? tolerance : (options || {});
    const levelTolerance = Math.max(0, finite(typeof tolerance === 'number'
      ? tolerance : opts.levelTolerance, 0.01));
    const points = (Array.isArray(rawPoints) ? rawPoints : [])
      .map(pointValues)
      .filter(point => Number.isFinite(point.timeMs) && Number.isFinite(point.level))
      .sort((left, right) => left.timeMs - right.timeMs || left.index - right.index);
    const unique = [];
    points.forEach(point => {
      if (unique.length && Math.abs(unique[unique.length - 1].timeMs - point.timeMs) <= EPSILON)
        unique[unique.length - 1] = point;
      else unique.push(point);
    });
    if (unique.length <= 2) return unique.map(point => clone(point.source));
    const keep = new Set([0, unique.length - 1]);
    const visit = (first, last) => {
      const left = unique[first], right = unique[last];
      const span = right.timeMs - left.timeMs;
      let maximum = -1, selected = -1;
      for (let index = first + 1; index < last; index++) {
        const phase = span <= EPSILON ? 0 : (unique[index].timeMs - left.timeMs) / span;
        const expected = left.level + (right.level - left.level) * phase;
        const error = Math.abs(unique[index].level - expected);
        if (error > maximum + EPSILON) { maximum = error; selected = index; }
      }
      if (selected >= 0 && maximum > levelTolerance) {
        keep.add(selected); visit(first, selected); visit(selected, last);
      }
    };
    visit(0, unique.length - 1);
    let simplified = unique.filter((point, index) => keep.has(index));
    const minInterval = Math.max(0, finite(opts.minIntervalMs, 0));
    if (minInterval > 0 && simplified.length > 2) simplified = simplified.filter((point, index) =>
      index === 0 || index === simplified.length - 1 ||
      point.timeMs - simplified[index - 1].timeMs >= minInterval);
    return simplified.map(point => clone(point.source));
  }

  function runtimeClock(options) {
    if (options && typeof options.now === 'function') return options.now;
    if (options && options.clock && typeof options.clock.now === 'function')
      return () => options.clock.now();
    if (global.performance && typeof global.performance.now === 'function')
      return () => global.performance.now();
    return () => Date.now();
  }

  function internalSource(project) {
    return keyText(project.options.timecodeSource) === 'internal';
  }

  class Runtime {
    constructor(project, options) {
      if (project && typeof project === 'object' && project.project && options == null) {
        options = project;
        project = options.project;
      }
      this.options = options && typeof options === 'object' ? options : {};
      this.project = normaliseProject(project);
      this.dispatch = typeof this.options.dispatch === 'function' ? this.options.dispatch : function () {};
      this.onStateChange = typeof this.options.onStateChange === 'function'
        ? this.options.onStateChange : function () {};
      this.onError = typeof this.options.onError === 'function' ? this.options.onError : function () {};
      this.now = runtimeClock(this.options);
      this.rate = clamp(finite(this.options.rate, 1), 0.01, 100);
      this.state = 'stopped';
      this.positionMs = clamp(finite(this.options.positionMs, this.project.cursorMs),
        this.project.startMs, this.project.endMs);
      this.waitTriggerId = null;
      this.loopCount = 0;
      this._lastClockMs = this.now();
      this._includeStart = true;
      this._resumeAfter = null;
      this._destroyed = false;
      this.lastError = null;
    }

    get isPlaying() { return this.state === 'playing'; }
    get isWaiting() { return this.state === 'waiting'; }
    get isInternal() { return internalSource(this.project); }
    get isLinkedExternal() { return !this.isInternal && this.project.options.linked; }

    snapshot() {
      return Object.freeze({
        state:this.state,
        positionMs:this.positionMs,
        waitTriggerId:this.waitTriggerId,
        loopCount:this.loopCount,
        source:this.project.options.timecodeSource,
        linked:this.project.options.linked,
        internal:this.isInternal
      });
    }

    _notify(reason) {
      const snapshot = this.snapshot();
      try { this.onStateChange(snapshot, reason || 'state'); }
      catch (error) { this._error(error); }
      return snapshot;
    }

    _error(error) {
      this.lastError = error;
      try { this.onError(error, this.snapshot()); } catch (_) {}
      if (this.options.strictDispatch) throw error;
    }

    _emit(record, reason) {
      const event = Object.freeze({
        kind:'timeline-trigger',
        reason:reason || 'crossing',
        timeMs:record.trigger.timeMs,
        positionMs:this.positionMs,
        track:Object.freeze({
          id:record.track.id,
          name:record.track.name,
          color:record.track.color,
          target:clone(record.track.target)
        }),
        trigger:clone(record.trigger)
      });
      try { this.dispatch(event); } catch (error) { this._error(error); }
    }

    _entryKey(record) {
      return `${String(record.trackIndex).padStart(6, '0')}:${
        String(record.triggerIndex).padStart(9, '0')}:${record.trigger.id}`;
    }

    _entries(fromMs, toMs) {
      const includeStart = this._includeStart;
      const resume = this._resumeAfter;
      return triggerRecords(this.project, {audible:true, enabled:true}).filter(record => {
        const time = record.trigger.timeMs;
        if (time < fromMs - EPSILON || time > toMs + EPSILON) return false;
        if (time > fromMs + EPSILON) return true;
        if (!includeStart) return false;
        if (!resume || Math.abs(resume.timeMs - time) > EPSILON) return true;
        return this._entryKey(record) > resume.key;
      });
    }

    _advanceForward(targetMs, reason) {
      const fromMs = this.positionMs;
      const target = clamp(targetMs, this.project.startMs, this.project.endMs);
      const entries = this._entries(fromMs, target);
      for (const record of entries) {
        this.positionMs = record.trigger.timeMs;
        this._emit(record, reason);
        this._includeStart = false;
        this._resumeAfter = null;
        if (record.trigger.type === 'Wait for Go' && this.isInternal) {
          this.state = 'waiting';
          this.waitTriggerId = record.trigger.id;
          this._resumeAfter = {timeMs:record.trigger.timeMs, key:this._entryKey(record)};
          this._includeStart = true;
          this._notify('wait-for-go');
          return false;
        }
      }
      this.positionMs = target;
      this._includeStart = false;
      this._resumeAfter = null;
      return true;
    }

    setProject(project, options) {
      const opts = options || {};
      const previous = this.positionMs;
      const wasWaiting = this.state === 'waiting';
      const previousWaitId = wasWaiting ? this.waitTriggerId : null;
      const previousIncludeStart = this._includeStart;
      this.project = normaliseProject(project);
      this.positionMs = clamp(opts.preservePosition === false ? this.project.cursorMs : previous,
        this.project.startMs, this.project.endMs);
      const preservedWait = previousWaitId && this.isInternal
        ? triggerRecords(this.project, {audible:true, enabled:true}).find(record =>
          record.trigger.id === previousWaitId && record.trigger.type === 'Wait for Go' &&
          Math.abs(record.trigger.timeMs - this.positionMs) <= EPSILON)
        : null;
      this.waitTriggerId = preservedWait ? previousWaitId : null;
      this._resumeAfter = preservedWait ? {
        timeMs:preservedWait.trigger.timeMs,
        key:this._entryKey(preservedWait)
      } : null;
      /* A document edit must not make an already-crossed trigger fire twice.
         Preserve the boundary rule of the running/paused transport. A newly
         loaded project (preservePosition:false) intentionally starts fresh,
         while a surviving Wait barrier must include its timestamp so Go can
         finish later same-time triggers. */
      this._includeStart = preservedWait ? true : opts.preservePosition === false
        ? true : (wasWaiting ? false : previousIncludeStart);
      this._lastClockMs = this.now();
      if (wasWaiting && !preservedWait) this.state = 'paused';
      return this._notify('project');
    }

    play() {
      if (this._destroyed) return this.snapshot();
      if (this.state === 'waiting') return this.go();
      const wasPaused = this.state === 'paused';
      this.state = 'playing';
      this.waitTriggerId = null;
      this._lastClockMs = this.now();
      if (!wasPaused && this._includeStart) this._advanceForward(this.positionMs, 'play');
      return this._notify('play');
    }

    pause() {
      if (this._destroyed) return this.snapshot();
      this.state = 'paused';
      this.waitTriggerId = null;
      this._resumeAfter = null;
      this._includeStart = false;
      return this._notify('pause');
    }

    stop() {
      if (this._destroyed) return this.snapshot();
      this.state = 'stopped';
      this.positionMs = this.project.startMs;
      this.waitTriggerId = null;
      this._resumeAfter = null;
      this._includeStart = true;
      this._lastClockMs = this.now();
      return this._notify('stop');
    }

    rewind() {
      if (this._destroyed) return this.snapshot();
      this.state = 'stopped';
      this.positionMs = this.project.startMs;
      this.waitTriggerId = null;
      this._resumeAfter = null;
      this._includeStart = true;
      this._lastClockMs = this.now();
      return this._notify('rewind');
    }

    seek(value, options) {
      if (this._destroyed) return this.snapshot();
      const opts = options || {};
      const parsed = parseTime(value, this.project.options.fps);
      this.positionMs = clamp(parsed == null ? this.positionMs : parsed,
        this.project.startMs, this.project.endMs);
      this.waitTriggerId = null;
      this._resumeAfter = null;
      this._includeStart = opts.includeStart !== false;
      this._lastClockMs = this.now();
      if (this.state === 'waiting') this.state = 'paused';
      return this._notify('seek');
    }

    playFromCursor(value) {
      const cursor = value == null ? this.project.cursorMs : value;
      this.seek(cursor, {includeStart:true});
      return this.play();
    }

    go() {
      if (this._destroyed) return this.snapshot();
      if (this.state !== 'waiting') return this.play();
      this.state = 'playing';
      this.waitTriggerId = null;
      this._lastClockMs = this.now();
      this._includeStart = true;
      /* Finish other triggers at the Wait timestamp before time advances. */
      this._advanceForward(this.positionMs, 'go');
      return this._notify(this.state === 'waiting' ? 'wait-for-go' : 'go');
    }

    _tickInternal(clockMs) {
      const currentClock = finite(clockMs, this.now());
      if (this.state !== 'playing') {
        this._lastClockMs = currentClock;
        return this.snapshot();
      }
      let remaining = Math.max(0, currentClock - this._lastClockMs) * this.rate;
      this._lastClockMs = currentClock;
      if (this._includeStart && !this._advanceForward(this.positionMs, 'crossing'))
        return this.snapshot();
      const canLoop = this.isInternal && this.project.options.loop;
      let guard = 0;
      while (remaining > EPSILON && guard++ < 10000) {
        const distance = this.project.endMs - this.positionMs;
        if (!canLoop || remaining < distance - EPSILON) {
          const destination = Math.min(this.project.endMs, this.positionMs + remaining);
          const completed = this._advanceForward(destination, 'crossing');
          remaining = 0;
          if (!completed) return this.snapshot();
          if (!canLoop && this.positionMs >= this.project.endMs - EPSILON) {
            this.positionMs = this.project.endMs;
            this.state = 'stopped';
            this._notify('end');
          }
          break;
        }
        if (distance > EPSILON) {
          if (!this._advanceForward(this.project.endMs, 'crossing')) return this.snapshot();
          remaining -= distance;
        }
        this.positionMs = this.project.startMs;
        this.loopCount += 1;
        this._includeStart = true;
        this._resumeAfter = null;
        this._notify('loop');
        if (!this._advanceForward(this.positionMs, 'loop')) return this.snapshot();
        if (distance <= EPSILON && remaining <= EPSILON) break;
      }
      return this.snapshot();
    }

    setLinkedTime(value) {
      if (this._destroyed) return this.snapshot();
      const parsed = parseTime(value, this.project.options.fps);
      if (parsed == null) return this.snapshot();
      const target = clamp(parsed + this.project.options.offsetMs,
        this.project.startMs, this.project.endMs);
      const previous = this.positionMs;
      this.state = 'playing';
      this.waitTriggerId = null;
      if (target < previous - EPSILON) {
        this.positionMs = target;
        this._includeStart = true;
        this._resumeAfter = null;
      } else this._advanceForward(target, 'external');
      if (target >= this.project.endMs - EPSILON) this.state = 'stopped';
      return this.snapshot();
    }

    tick(value) {
      if (this._destroyed) return this.snapshot();
      if (this.isLinkedExternal) return this.setLinkedTime(value && typeof value === 'object'
        ? value.timeMs : value);
      const clock = value && typeof value === 'object' ? value.now : value;
      return this._tickInternal(clock);
    }

    destroy() {
      this._destroyed = true;
      this.state = 'stopped';
      this.waitTriggerId = null;
      this._resumeAfter = null;
      return this.snapshot();
    }
  }

  const api = {
    schema:SCHEMA,
    schemaName:SCHEMA_NAME,
    SCHEMA,
    SCHEMA_NAME,
    TRIGGER_TYPES,
    triggerTypes:TRIGGER_TYPES,
    extensionTriggerTypes:EXTENSION_TRIGGER_TYPES,
    allTriggerTypes:ALL_TRIGGER_TYPES,
    trackColors:TRACK_COLORS,
    limits:Object.freeze({maxTimeMs:MAX_TIME_MS, maxTracks:MAX_TRACKS,
      maxTriggers:MAX_TRIGGERS}),
    canonicalTriggerType,
    parseTime,
    parseTimecode:parseTime,
    formatTime,
    formatTimecode:formatTime,
    createProject,
    normaliseProject,
    normalizeProject:normaliseProject,
    shareableProject,
    normaliseTrack,
    normalizeTrack:normaliseTrack,
    normaliseTrigger,
    normalizeTrigger:normaliseTrigger,
    triggerRecords,
    markerRecords,
    findTrack,
    findTrigger,
    addTrack,
    updateTrack,
    removeTrack,
    addTrigger,
    updateTrigger,
    removeTriggers,
    moveTriggers,
    moveTriggerBlock:moveTriggers,
    copyTriggers,
    copyTriggerBlock:copyTriggers,
    parseMarkerCsv,
    snapTime,
    snapTimeDetailed,
    simplifyPoints,
    simplifyLevelPoints:simplifyPoints,
    Runtime
  };

  /* Public API summary
     - Documents: createProject, normaliseProject, shareableProject.
     - Editing: add/update/remove Track or Trigger, move/copy trigger blocks.
       Editing helpers are immutable and return a freshly normalised project.
     - Time: parseTime/parseTimecode return milliseconds; formatTime supports
       HH:MM:SS.mmm or {frames:true,fps}. parseMarkerCsv returns Marker triggers.
     - Assistance: snapTime (number), snapTimeDetailed (snap metadata), and
       simplifyPoints for recorded level automation.
     - Playback: new Runtime(project, {dispatch, clock|now, onStateChange}).
       Runtime dispatches {kind, reason, timeMs, track, trigger} in stable order.
       Use play/pause/stop/rewind/seek/playFromCursor/go/tick. For a linked
       external source, tick(timeMs) or setLinkedTime(timeMs) supplies timecode.
       Wait for Go and Loop deliberately operate only with Internal timecode. */
  global.OpenLiveTimeline = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
