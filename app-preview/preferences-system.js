/* OpenLive Preferences System
   -------------------------------------------------------------------------
   Canonical controllers for General, Recording, Clip Rendering, Defaults,
   Feedback and Registration. Native Arena services remain an explicit bridge
   boundary: this browser module stores intent, never invents native results.
   ------------------------------------------------------------------------- */
(function openLivePreferencesSystem(global) {
  'use strict';

  const Hub = global.OpenLiveHub;
  const document = global.document;
  if (!Hub || !document || !document.querySelector('[data-tab="general"]')) return;

  const VERSION = '2.3.0';
  const byId = id => document.getElementById(id);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
  };
  const integer = (value, min, max, fallback) => Math.round(clamp(value, min, max, fallback));
  const boolean = (value, fallback) => value === undefined ? !!fallback : !!value;
  const timestamp = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  };
  const cleanText = (value, limit = 1024) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  const cleanPath = (value, fallback) => {
    const path = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1024);
    return path || fallback;
  };
  const cleanMessage = value => String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim().slice(0, 5000);
  const choice = (value, allowed, fallback) => allowed.includes(String(value)) ? String(value) : fallback;
  const setStatus = (node, state, message) => {
    if (!node) return;
    node.dataset.state = state || 'warning';
    node.textContent = String(message || '');
  };
  const setSelect = (node, value) => {
    if (!node) return;
    const wanted = String(value == null ? '' : value);
    const option = [...node.options].find(item => item.value === wanted);
    if (option) node.value = option.value;
  };
  const optionChoice = (node, value, fallback) => {
    const values = node ? [...node.options].map(option => option.value) : [];
    return values.includes(String(value)) ? String(value) : fallback;
  };

  const controls = {
    general: {
      panelUpdates: byId('generalPanelUpdates'), clipStartOffset: byId('generalClipStartOffset'),
      scrollSelection: byId('generalScrollSelection'), unicodeFont: byId('generalUnicodeFont'),
      checkUpdates: byId('generalCheckUpdates'), releaseChannel: byId('generalReleaseChannel'),
      checkNow: byId('generalCheckNow'), startupScreen: byId('generalStartupScreen'),
      quitConfirmation: byId('generalQuitConfirmation'), pioneerInterface: byId('generalPioneerInterface'),
      triggerStatus: byId('generalTriggerStatus'), fontStatus: byId('generalFontStatus'),
      updateStatus: byId('generalUpdateStatus'), quitStatus: byId('generalQuitStatus')
    },
    recording: {
      snapshotDirectory: byId('snapshotDirectory'), snapshotBrowse: byId('snapshotBrowse'),
      recordingDirectory: byId('recordingDirectory'), recordingBrowse: byId('recordingBrowse'),
      fileNameTemplate: byId('recordingFileName'), folderMode: byId('recordingFolderMode'),
      extension: byId('recordingExtension'),
      recordVideo: byId('recordVideo'), recordAudio: byId('recordAudio'), preset: byId('recordingPreset'),
      presetSave: byId('recordingPresetSave'), presetDelete: byId('recordingPresetDelete'),
      container: byId('recordingContainer'), codec: byId('recordingCodec'), quality: byId('recordingQuality'),
      alpha: byId('recordingAlpha'), frameRate: byId('recordingFrameRate'),
      videoBitrate: byId('recordingVideoBitrate'), videoBitrateValue: byId('recordingVideoBitrateValue'),
      audioCodec: byId('recordingAudioCodec'), audioSampleRate: byId('recordingAudioSampleRate'),
      audioBitDepth: byId('recordingAudioBitDepth'), audioChannels: byId('recordingAudioChannels'),
      afterRecording: byId('recordingAfter'), videoGroup: byId('recordingVideoGroup'), audioGroup: byId('recordingAudioGroup'),
      status: byId('recordingStatus'), reset: byId('recordingReset'), restore: byId('recordingRestore'),
      runtimeState: byId('recordingRuntimeState'), runtimeMetrics: byId('recordingRuntimeMetrics'),
      historyBody: byId('recordingHistoryBody'), historyClear: byId('recordingHistoryClear')
    },
    clipRendering: {
      directory: byId('clipRenderDirectory'), browse: byId('clipRenderBrowse'),
      preset: byId('clipRenderPreset'), codec: byId('clipRenderCodec'), format: byId('clipRenderFormat'),
      includeAudio: byId('clipRenderAudio'), sampleRate: byId('clipRenderSampleRate'),
      bitDepth: byId('clipRenderBitDepth'), status: byId('clipRenderStatus')
    },
    defaults: {
      videoTransport: byId('defaultVideoTransport'), videoPlayMode: byId('defaultVideoPlayMode'),
      videoPlayModeAway: byId('defaultVideoPlayAway'), audioTransport: byId('defaultAudioTransport'),
      audioPlayMode: byId('defaultAudioPlayMode'), audioPlayModeAway: byId('defaultAudioPlayAway'),
      layerBlendMode: byId('defBlend'), tempoNudgeRange: byId('defaultTempoNudge'),
      tempoNudgeValue: byId('defaultTempoNudgeValue'), status: byId('defaultsStatus')
    },
    feedback: {
      name: byId('feedbackName'), email: byId('feedbackEmail'), remember: byId('feedbackRemember'),
      message: byId('feedbackMessage'), includeLog: byId('feedbackIncludeLog'),
      viewLog: byId('feedbackViewLog'), send: byId('feedbackSend'), clear: byId('feedbackClear'),
      status: byId('feedbackStatus')
    },
    registration: {
      statusText: byId('registrationStatusText'), check: byId('registrationCheck'),
      deactivate: byId('registrationDeactivate'), status: byId('registrationStatus')
    }
  };

  const RECORDING_CODEC_RULES = Object.freeze({
    'DXV 3': Object.freeze({ containers: ['QuickTime (.mov)'], qualities: ['Normal', 'High'], defaultContainer: 'QuickTime (.mov)', defaultQuality: 'Normal' }),
    'H.264': Object.freeze({ containers: ['MPEG-4 (.mp4)', 'QuickTime (.mov)'], qualities: ['Low', 'Medium', 'High'], defaultContainer: 'MPEG-4 (.mp4)', defaultQuality: 'High' }),
    'Motion JPEG': Object.freeze({ containers: ['QuickTime (.mov)', 'AVI (.avi)'], qualities: ['Normal', 'High'], defaultContainer: 'QuickTime (.mov)', defaultQuality: 'Normal' }),
    'ProRes': Object.freeze({ containers: ['QuickTime (.mov)'], qualities: ['422 Normal Quality', '422 High Quality', '4444'], defaultContainer: 'QuickTime (.mov)', defaultQuality: '422 Normal Quality' })
  });
  const RECORDING_PRESETS = Object.freeze({
    'DXV 3 High Quality No Alpha': Object.freeze({ codec: 'DXV 3', container: 'QuickTime (.mov)', quality: 'High', alpha: false }),
    'DXV 3 High Quality With Alpha': Object.freeze({ codec: 'DXV 3', container: 'QuickTime (.mov)', quality: 'High', alpha: true }),
    'DXV 3 Normal Quality No Alpha': Object.freeze({ codec: 'DXV 3', container: 'QuickTime (.mov)', quality: 'Normal', alpha: false }),
    'DXV 3 Normal Quality With Alpha': Object.freeze({ codec: 'DXV 3', container: 'QuickTime (.mov)', quality: 'Normal', alpha: true }),
    'H264 High Quality': Object.freeze({ codec: 'H.264', container: 'MPEG-4 (.mp4)', quality: 'High', alpha: false, videoBitrateMbps: 35 }),
    'H264 Medium Quality': Object.freeze({ codec: 'H.264', container: 'MPEG-4 (.mp4)', quality: 'Medium', alpha: false, videoBitrateMbps: 20 }),
    'H264 Low Quality': Object.freeze({ codec: 'H.264', container: 'MPEG-4 (.mp4)', quality: 'Low', alpha: false, videoBitrateMbps: 10 }),
    'Motion JPEG': Object.freeze({ codec: 'Motion JPEG', container: 'QuickTime (.mov)', quality: 'Normal', alpha: false }),
    'ProRes 422 High Quality': Object.freeze({ codec: 'ProRes', container: 'QuickTime (.mov)', quality: '422 High Quality', alpha: false }),
    'ProRes 422 Normal Quality': Object.freeze({ codec: 'ProRes', container: 'QuickTime (.mov)', quality: '422 Normal Quality', alpha: false }),
    'ProRes 4444': Object.freeze({ codec: 'ProRes', container: 'QuickTime (.mov)', quality: '4444', alpha: true })
  });
  const RECORDING_PRESET_NAMES = Object.freeze([
    'DXV 3 Normal Quality No Alpha', 'DXV 3 Normal Quality With Alpha',
    'DXV 3 High Quality No Alpha', 'DXV 3 High Quality With Alpha',
    'H264 High Quality', 'H264 Medium Quality', 'H264 Low Quality', 'Motion JPEG',
    'ProRes 422 Normal Quality', 'ProRes 422 High Quality', 'ProRes 4444'
  ]);
  const LEGACY_RECORDING_PRESETS = Object.freeze({
    'DXV 3 Normal Quality': 'DXV 3 Normal Quality No Alpha',
    'DXV 3 High Quality': 'DXV 3 High Quality No Alpha',
    'DXV 3 Normal + Alpha': 'DXV 3 Normal Quality With Alpha',
    'H.264 High Quality': 'H264 High Quality',
    'ProRes 422': 'ProRes 422 Normal Quality',
    'ProRes 422 HQ': 'ProRes 422 High Quality',
    'ProRes 4444 Alpha': 'ProRes 4444',
    'Apple ProRes 422 Proxy': 'ProRes 422 Normal Quality',
    'Apple ProRes 422 LT': 'ProRes 422 Normal Quality',
    'Apple ProRes 422': 'ProRes 422 Normal Quality',
    'Apple ProRes 422 HQ': 'ProRes 422 High Quality',
    'Apple ProRes 4444': 'ProRes 4444'
  });
  const RENDER_PRESETS = Object.freeze({
    'DXV 3 Normal Quality': ['DXV 3', 'Normal Quality, No Alpha'],
    'DXV 3 High Quality': ['DXV 3', 'High Quality, No Alpha'],
    'Motion JPEG': ['Motion JPEG', 'Normal Quality, No Alpha'],
    'ProRes 422': ['ProRes', 'High Quality, No Alpha']
  });
  const FORMATS = ['Normal Quality, No Alpha', 'Normal Quality, With Alpha',
    'High Quality, No Alpha', 'High Quality, With Alpha'];
  const PLAY_MODES = ['Loop', 'Bounce', 'Play Once & Hold', 'Play Once & Clear', 'Restart', 'Random'];
  const TRANSPORTS = ['Timeline', 'BPM Sync', 'SMPTE'];
  const PLAY_AWAY = ['Restart', 'Continue', 'Relative'];

  function alphaCompatibleFormat(codec, format) {
    const selected = choice(format, FORMATS, 'Normal Quality, No Alpha');
    if (codec === 'DXV 3' || codec === 'PNG Sequence') return selected;
    return selected.replace('With Alpha', 'No Alpha');
  }

  function recordingExtension(container) {
    if (container === 'MPEG-4 (.mp4)') return '.mp4';
    if (container === 'AVI (.avi)') return '.avi';
    return '.mov';
  }

  function recordingQualityFromLegacy(value, codec) {
    const rule = RECORDING_CODEC_RULES[codec] || RECORDING_CODEC_RULES['DXV 3'];
    const explicit = String(value.quality == null ? '' : value.quality);
    if (rule.qualities.includes(explicit)) return explicit;
    const format = cleanText(value.format, 80);
    if (codec === 'ProRes') {
      if (explicit === '422' || /422 normal/i.test(format)) return '422 Normal Quality';
      if (explicit === '422 HQ' || explicit === 'High' || /(?:422 )?(?:hq|high)/i.test(format)) return '422 High Quality';
      if (explicit === 'Normal' || /(?:422 )?normal/i.test(format)) return '422 Normal Quality';
      const profile = rule.qualities.find(item => format.toLowerCase().includes(item.toLowerCase()));
      if (profile) return profile;
    }
    if (/high/i.test(format) && rule.qualities.includes('High')) return 'High';
    if (/medium/i.test(format) && rule.qualities.includes('Medium')) return 'Medium';
    if (/low/i.test(format) && rule.qualities.includes('Low')) return 'Low';
    return rule.defaultQuality;
  }

  function recordingAllowsAlpha(codec, quality) {
    return codec === 'DXV 3' || (codec === 'ProRes' && quality === '4444');
  }

  function recordingLegacyFormat(codec, quality, alpha) {
    if (codec === 'DXV 3') return `${quality} Quality, ${alpha ? 'With' : 'No'} Alpha`;
    if (codec === 'H.264' || codec === 'Motion JPEG') return `${quality} Quality`;
    return quality;
  }

  function normaliseRecordingProfile(source) {
    const value = isObject(source) ? source : {};
    const codec = choice(value.codec, Object.keys(RECORDING_CODEC_RULES), 'DXV 3');
    const rule = RECORDING_CODEC_RULES[codec];
    const container = choice(value.container, rule.containers, rule.defaultContainer);
    const quality = choice(recordingQualityFromLegacy(value, codec), rule.qualities, rule.defaultQuality);
    const alpha = recordingAllowsAlpha(codec, quality)
      && boolean(value.alpha, /with alpha/i.test(String(value.format || '')));
    return {
      container, codec, quality, alpha,
      format: recordingLegacyFormat(codec, quality, alpha),
      frameRate: choice(String(value.frameRate), ['Composition', '24', '25', '29.97', '30', '50', '59.94', '60'], 'Composition'),
      videoBitrateMbps: integer(value.videoBitrateMbps, 5, 120, 35),
      audioCodec: 'PCM (WAV)',
      audioSampleRate: choice(String(value.audioSampleRate), ['44100', '48000', '96000'], '48000') * 1,
      audioBitDepth: choice(String(value.audioBitDepth), ['16', '24', '32'], '24') * 1,
      audioChannels: choice(value.audioChannels, ['Stereo', 'Mono', 'Master Output'], 'Stereo')
    };
  }

  function normaliseCustomRecordingPresets(source) {
    const entries = Array.isArray(source) ? source.slice(0, 64) : [];
    const usedIds = new Set();
    const usedNames = new Set();
    const presets = [];
    entries.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const profile = normaliseRecordingProfile(entry);
      let id = cleanText(entry.id, 160);
      if (!id || id === 'Custom' || RECORDING_PRESET_NAMES.includes(id)) id = `recording-preset:legacy-${index + 1}`;
      const idBase = id;
      let idSuffix = 2;
      while (usedIds.has(id)) id = `${idBase}-${idSuffix++}`;
      usedIds.add(id);
      const baseName = cleanText(entry.name, 80) || `Custom Preset ${index + 1}`;
      let name = baseName;
      let nameSuffix = 2;
      while (usedNames.has(name.toLowerCase())) name = `${baseName} (${nameSuffix++})`;
      usedNames.add(name.toLowerCase());
      presets.push({
        id, name,
        container: profile.container,
        codec: profile.codec,
        quality: profile.quality,
        alpha: profile.alpha,
        format: profile.format,
        frameRate: profile.frameRate,
        videoBitrateMbps: profile.videoBitrateMbps,
        audioCodec: profile.audioCodec,
        audioSampleRate: profile.audioSampleRate,
        audioBitDepth: profile.audioBitDepth,
        audioChannels: profile.audioChannels,
        updatedAt: timestamp(entry.updatedAt)
      });
    });
    return presets;
  }

  function normaliseGeneral(source) {
    const value = isObject(source) ? source : {};
    return {
      updateClipPanelOnExternalTriggers: boolean(value.updateClipPanelOnExternalTriggers, true),
      clipStartOffsetMs: integer(value.clipStartOffsetMs, 0, 10000, 0),
      scrollSelection: boolean(value.scrollSelection, true),
      unicodeFont: boolean(value.unicodeFont, false),
      checkUpdates: boolean(value.checkUpdates, true),
      releaseChannel: choice(value.releaseChannel, ['Stable', 'Beta'], 'Stable'),
      lastUpdateCheckAt: timestamp(value.lastUpdateCheckAt),
      updateStatus: cleanText(value.updateStatus, 360) || 'Never checked',
      startupScreen: boolean(value.startupScreen, true),
      quitConfirmation: boolean(value.quitConfirmation, true),
      pioneerInterface: optionChoice(controls.general.pioneerInterface, value.pioneerInterface, 'Automatic'),
      updatedAt: timestamp(value.updatedAt)
    };
  }

  function normaliseRecording(source) {
    const value = isObject(source) ? source : {};
    const customPresets = normaliseCustomRecordingPresets(value.customPresets);
    const migratedPreset = LEGACY_RECORDING_PRESETS[String(value.preset || '')] || value.preset;
    const wantedPreset = String(migratedPreset == null ? '' : migratedPreset);
    const customPreset = customPresets.find(item => item.id === wantedPreset)
      || (wantedPreset !== 'Custom' && !RECORDING_PRESET_NAMES.includes(wantedPreset)
        ? customPresets.find(item => item.name.toLowerCase() === wantedPreset.toLowerCase()) : null);
    const preset = customPreset
      ? customPreset.id
      : choice(migratedPreset, [...RECORDING_PRESET_NAMES, 'Custom'], 'DXV 3 Normal Quality No Alpha');
    let profile = normaliseRecordingProfile(value);
    if (RECORDING_PRESETS[preset]) {
      profile = normaliseRecordingProfile(Object.assign({}, value, RECORDING_PRESETS[preset]));
    } else if (customPreset) {
      profile = normaliseRecordingProfile(customPreset);
    }
    const fileNameTemplate = cleanText(value.fileNameTemplate, 120) || 'Resolume_{date}_{time}';
    return {
      snapshotDirectory: cleanPath(value.snapshotDirectory, 'Documents\\Resolume Arena\\Recorded'),
      recordingDirectory: cleanPath(value.recordingDirectory, 'Documents\\Resolume Arena\\Recorded'),
      fileNameTemplate: recordingFileNameError(fileNameTemplate) ? 'Resolume_{date}_{time}' : fileNameTemplate,
      folderMode: choice(value.folderMode, ['Single Folder', 'Daily Subfolder', 'Session Subfolder'], 'Single Folder'),
      recordVideo: boolean(value.recordVideo, true),
      recordAudio: boolean(value.recordAudio, true),
      preset,
      customPresets,
      container: profile.container,
      codec: profile.codec,
      quality: profile.quality,
      alpha: profile.alpha,
      format: profile.format,
      frameRate: profile.frameRate,
      videoBitrateMbps: profile.videoBitrateMbps,
      audioCodec: profile.audioCodec,
      audioSampleRate: profile.audioSampleRate,
      audioBitDepth: profile.audioBitDepth,
      audioChannels: profile.audioChannels,
      afterRecording: choice(value.afterRecording, ['Do Nothing', 'Place in Empty Clip', 'Reveal in File Browser', 'Place in Empty Clip and Reveal'], 'Do Nothing'),
      updatedAt: timestamp(value.updatedAt)
    };
  }

  function normaliseRecorderRuntime(source) {
    const value = isObject(source) ? source : {};
    let state = cleanText(value.state || value.status, 32).toLowerCase();
    const allowed = ['unavailable', 'idle', 'starting', 'recording', 'stopping', 'completed', 'cancelled', 'error'];
    if (!allowed.includes(state)) state = boolean(value.active, false) ? 'recording' : 'unavailable';
    const available = boolean(value.available, state !== 'unavailable');
    if (!available && state !== 'error') state = 'unavailable';
    return {
      state,
      available,
      active: state !== 'unavailable' && boolean(value.active, state === 'starting' || state === 'recording' || state === 'stopping'),
      mode: boolean(value.simulated, false) ? 'Browser simulation' : (cleanText(value.mode || value.runtimeMode, 60) || 'Native bridge'),
      simulated: boolean(value.simulated, false),
      nativeFileCreated: value.nativeFileCreated === true,
      jobId: cleanText(value.jobId || value.id, 160),
      source: cleanText(value.sourceName || value.captureSource || value.source, 160),
      startedAt: timestamp(value.startedAt),
      updatedAt: timestamp(value.updatedAt || value.at),
      durationMs: Math.max(0, Math.round(Number(value.durationMs || value.elapsedMs) || 0)),
      frames: Math.max(0, Math.round(Number(value.frames || value.frameCount) || 0)),
      droppedFrames: Math.max(0, Math.round(Number(value.droppedFrames) || 0)),
      bytes: Math.max(0, Math.round(Number(value.bytes || value.bytesWritten) || 0)),
      outputPath: String(value.outputPath || value.path || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1024),
      lastError: cleanText(value.lastError || value.error, 360),
      limitation: cleanText(value.limitation, 360)
    };
  }

  function normaliseRecordingHistory(source) {
    const items = Array.isArray(source) ? source : [];
    const used = new Set();
    return items.slice(-40).map((entry, index) => {
      const value = isObject(entry) ? entry : { name: String(entry || '') };
      let id = cleanText(value.id || value.jobId, 160) || `recording:${timestamp(value.endedAt || value.createdAt) || index}`;
      while (used.has(id)) id = `${id}:${index}`;
      used.add(id);
      const rawState = String(value.state || value.status || value.result).toLowerCase();
      let state = ({ complete: 'completed', failed: 'error', canceled: 'cancelled',
        'browser-download-requested': 'requested', 'browser-download-error': 'error',
        'metadata-only': 'metadata' })[rawState] || rawState;
      if (value.kind === 'snapshot') {
        if (value.browserDownloadError || rawState.includes('error')) state = 'error';
        else if (value.nativeFileCreated === true && value.exists === true || value.browserDownloadConfirmed === true) state = 'saved';
        else if (value.browserDownloadRequested === true) state = 'requested';
      }
      state = choice(state, ['completed', 'saved', 'requested', 'metadata', 'cancelled', 'error'], 'metadata');
      return {
        id,
        kind: cleanText(value.kind, 40) || 'recording',
        name: cleanText(value.name || value.fileName, 240) || 'Recording',
        path: String(value.path || value.outputPath || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1024),
        state,
        startedAt: timestamp(value.startedAt),
        endedAt: timestamp(value.endedAt || value.completedAt || value.createdAt || value.at),
        durationMs: Math.max(0, Math.round(Number(value.durationMs) || 0)),
        droppedFrames: Math.max(0, Math.round(Number(value.droppedFrames) || 0)),
        bytes: Math.max(0, Math.round(Number(value.bytes || value.fileSize) || 0)),
        media: cleanText(value.media, 40),
        preset: cleanText(value.preset, 120),
        mode: boolean(value.simulated, false) ? 'Browser simulation' : cleanText(value.mode || value.runtimeMode, 60),
        simulated: boolean(value.simulated, false),
        nativeFileCreated: value.nativeFileCreated === true,
        exists: value.exists === true,
        browserDownloadRequested: value.browserDownloadRequested === true,
        browserDownloadConfirmed: value.browserDownloadConfirmed === true,
        browserDownloadError: cleanText(value.browserDownloadError, 240),
        availability: cleanText(value.availability, 80)
      };
    });
  }

  function normaliseClipRendering(source) {
    const value = isObject(source) ? source : {};
    let preset = choice(value.preset, [...Object.keys(RENDER_PRESETS), 'Custom'], 'DXV 3 Normal Quality');
    let codec = choice(value.codec, ['DXV 3', 'Motion JPEG', 'ProRes', 'PNG Sequence'], 'DXV 3');
    let format = choice(value.format, FORMATS, 'Normal Quality, No Alpha');
    if (preset !== 'Custom') [codec, format] = RENDER_PRESETS[preset];
    format = codec === 'PNG Sequence' ? 'Normal Quality, With Alpha' : alphaCompatibleFormat(codec, format);
    const includeAudio = codec === 'PNG Sequence' ? false : boolean(value.includeAudio, true);
    return {
      directory: cleanPath(value.directory, 'Documents\\Resolume Arena\\Renders'),
      preset, codec, format, includeAudio,
      sampleRate: choice(String(value.sampleRate), ['44100', '48000', '96000'], '48000') * 1,
      bitDepth: choice(String(value.bitDepth), ['16', '24', '32'], '24') * 1,
      updatedAt: timestamp(value.updatedAt)
    };
  }

  function normaliseDefaults(source) {
    const value = isObject(source) ? source : {};
    const blendOptions = controls.defaults.layerBlendMode
      ? [...controls.defaults.layerBlendMode.options].map(option => option.value) : ['Add'];
    return {
      videoTransport: choice(value.videoTransport, TRANSPORTS, 'Timeline'),
      videoPlayMode: choice(value.videoPlayMode, PLAY_MODES, 'Loop'),
      videoPlayModeAway: choice(value.videoPlayModeAway, PLAY_AWAY, 'Restart'),
      audioTransport: choice(value.audioTransport, TRANSPORTS, 'Timeline'),
      audioPlayMode: choice(value.audioPlayMode, PLAY_MODES, 'Loop'),
      audioPlayModeAway: choice(value.audioPlayModeAway, PLAY_AWAY, 'Restart'),
      layerBlendMode: choice(value.layerBlendMode, blendOptions, 'Add'),
      tempoNudgeRange: integer(value.tempoNudgeRange, 1, 100, 10),
      updatedAt: timestamp(value.updatedAt)
    };
  }

  function normaliseFeedback(source) {
    const value = isObject(source) ? source : {};
    const rememberContact = boolean(value.rememberContact, false);
    return {
      name: rememberContact ? cleanText(value.name, 120) : '',
      email: rememberContact ? cleanText(value.email, 254) : '',
      rememberContact,
      includeLog: boolean(value.includeLog, false),
      lastSubmittedAt: timestamp(value.lastSubmittedAt),
      updatedAt: timestamp(value.updatedAt)
    };
  }

  const normalisers = Object.freeze({
    general: normaliseGeneral, recording: normaliseRecording,
    clipRendering: normaliseClipRendering, defaults: normaliseDefaults, feedback: normaliseFeedback
  });

  function generalProjection(value) {
    return {
      'general.panel-updates.update-clip-panel-on-external-triggers': value.updateClipPanelOnExternalTriggers,
      'general.panel-updates.clip-start-offset-ms': value.clipStartOffsetMs,
      'general.scrolling.scroll-layers-and-clips-into-view': value.scrollSelection,
      'general.font.use-arial-unicode-ms': value.unicodeFont,
      'general.software-updates.check-for-updates-once-a-day': value.checkUpdates,
      'general.software-updates.release-channel': value.releaseChannel,
      'general.software-updates.last-local-check-at': value.lastUpdateCheckAt,
      'general.software-updates.local-check-status': value.updateStatus,
      'general.startup-screen.show-splash-screen-on-startup': value.startupScreen,
      'general.quit-confirmation.display-quit-confirmation-on-close': value.quitConfirmation,
      'general.pioneer-dj-network-interface.interface': value.pioneerInterface
    };
  }

  function recordingProjection(value) {
    return {
      'recording.destination.snapshot-output-directory': value.snapshotDirectory,
      'recording.destination.recording-output-directory': value.recordingDirectory,
      'recording.destination.file-name-template': value.fileNameTemplate,
      'recording.destination.folder-mode': value.folderMode,
      'recording.media-preset.record-video': value.recordVideo,
      'recording.media-preset.record-audio': value.recordAudio,
      'recording.media-preset.preset': value.preset,
      'recording.media-preset.custom-presets': clone(value.customPresets),
      'recording.media-preset.container': value.container,
      'recording.media-preset.video-codec': value.codec,
      'recording.media-preset.quality': value.quality,
      'recording.media-preset.alpha': value.alpha,
      'recording.media-preset.format': value.format,
      'recording.media-preset.frame-rate': value.frameRate,
      'recording.media-preset.video-bitrate-mbps': value.videoBitrateMbps,
      'recording.media-preset.audio-codec': value.audioCodec,
      'recording.media-preset.audio-sample-rate': value.audioSampleRate,
      'recording.media-preset.audio-bit-depth': value.audioBitDepth,
      'recording.media-preset.audio-channels': value.audioChannels,
      'recording.media-preset.after-recording': value.afterRecording
    };
  }

  function clipRenderingProjection(value) {
    return {
      'cliprender.destination.file-output-directory': value.directory,
      'cliprender.preset-codec.preset': value.preset,
      'cliprender.preset-codec.video-codec': value.codec,
      'cliprender.preset-codec.format': value.format,
      'cliprender.preset-codec.include-audio': value.includeAudio,
      'cliprender.preset-codec.audio-sample-rate': value.sampleRate,
      'cliprender.preset-codec.audio-bit-depth': value.bitDepth
    };
  }

  function defaultsProjection(value) {
    return {
      'defaults.video-clips.default-video-clip-transport': value.videoTransport,
      'defaults.video-clips.default-video-clip-play-mode': value.videoPlayMode,
      'defaults.video-clips.default-video-play-mode-away': value.videoPlayModeAway,
      'defaults.audio-clips.default-audio-clip-transport': value.audioTransport,
      'defaults.audio-clips.default-audio-clip-play-mode': value.audioPlayMode,
      'defaults.audio-clips.default-audio-play-mode-away': value.audioPlayModeAway,
      'defaults.layers.default-layer-blend-mode': value.layerBlendMode,
      'defaults.tempo.tempo-nudge-range': value.tempoNudgeRange
    };
  }

  function feedbackProjection(value) {
    const projection = {
      'feedback.tell-us-what-you-think.remember-contact-on-this-computer': value.rememberContact,
      'feedback.tell-us-what-you-think.include-diagnostic-log': value.includeLog,
      'feedback.tell-us-what-you-think.last-package-copied-at': value.lastSubmittedAt
    };
    if (value.rememberContact) {
      projection['feedback.tell-us-what-you-think.your-name'] = value.name;
      projection['feedback.tell-us-what-you-think.email-address'] = value.email;
    }
    return projection;
  }

  const projectors = Object.freeze({
    general: generalProjection, recording: recordingProjection,
    clipRendering: clipRenderingProjection, defaults: defaultsProjection, feedback: feedbackProjection
  });
  const projectionPrefixes = Object.freeze({
    general: 'general.', recording: 'recording.', clipRendering: 'cliprender.',
    defaults: 'defaults.', feedback: 'feedback.'
  });

  function replaceProjection(values, domain, projection) {
    const next = Object.assign({}, isObject(values) ? values : {});
    const prefix = projectionPrefixes[domain];
    Object.keys(next).forEach(key => { if (prefix && key.startsWith(prefix)) delete next[key]; });
    Object.entries(projection || {}).forEach(([key, value]) => { next[key] = clone(value); });
    return next;
  }

  const models = {
    general: normaliseGeneral(Hub.get('preferences.general', {})),
    recording: normaliseRecording(Hub.get('preferences.recording', {})),
    clipRendering: normaliseClipRendering(Hub.get('preferences.clipRendering', {})),
    defaults: normaliseDefaults(Hub.get('preferences.defaults', {})),
    feedback: normaliseFeedback(Hub.get('preferences.feedback', {}))
  };
  const recordingSessionBaseline = clone(models.recording);
  let recorderRuntime = normaliseRecorderRuntime(Hub.get('recording', {}));
  let recordingHistory = normaliseRecordingHistory(Hub.get('recordings.items', []));
  const sessionContact = {
    name: models.feedback.rememberContact ? models.feedback.name : '',
    email: models.feedback.rememberContact ? models.feedback.email : ''
  };
  let applying = false;
  let feedbackTimer = 0;
  let defaultsTimer = 0;
  let recorderClearTimer = 0;
  let recorderClearRequestId = '';

  function commitDomain(domain, candidate, reason, key) {
    const normalise = normalisers[domain];
    const next = normalise(Object.assign({}, candidate, { updatedAt: Date.now() }));
    models[domain] = next;
    const projection = projectors[domain](next);
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      preferences[domain] = clone(next);
      preferences.values = replaceProjection(preferences.values, domain, projection);
      preferences.updatedAt = next.updatedAt;
    }, { changedPath: `preferences.${domain}`, reason: reason || `${domain}-preference-change` });
    Hub.emit('openlive:preferences-changed', {
      section: domain === 'clipRendering' ? 'cliprender' : domain,
      key: key || reason || `${domain}-preference-change`,
      value: clone(next), values: clone(projection)
    }, { activity: false });
    if (domain === 'recording') {
      Hub.emit('openlive:recording-preferences-changed', {
        recording: clone(next), key: key || reason || 'recording-preference-change', values: clone(projection)
      }, { activity: false });
    }
    return next;
  }

  function updateDomain(domain, patch, reason, key) {
    return commitDomain(domain, Object.assign({}, models[domain], patch), reason, key);
  }

  function renderGeneral(source) {
    const value = normaliseGeneral(source);
    models.general = value;
    applying = true;
    controls.general.panelUpdates.checked = value.updateClipPanelOnExternalTriggers;
    controls.general.clipStartOffset.value = String(value.clipStartOffsetMs);
    controls.general.scrollSelection.checked = value.scrollSelection;
    controls.general.unicodeFont.checked = value.unicodeFont;
    controls.general.checkUpdates.checked = value.checkUpdates;
    setSelect(controls.general.releaseChannel, value.releaseChannel);
    controls.general.startupScreen.checked = value.startupScreen;
    controls.general.quitConfirmation.checked = value.quitConfirmation;
    setSelect(controls.general.pioneerInterface, value.pioneerInterface);
    applying = false;
    document.documentElement.dataset.olUnicodeFont = value.unicodeFont ? 'on' : 'off';
    setStatus(controls.general.triggerStatus, value.updateClipPanelOnExternalTriggers ? 'ready' : 'warning',
      value.updateClipPanelOnExternalTriggers
        ? `External clip triggers update the shared selection after ${value.clipStartOffsetMs} ms.`
        : 'External clip triggers do not change the clip-panel selection.');
    setStatus(controls.general.fontStatus, value.unicodeFont ? 'warning' : 'ready', value.unicodeFont
      ? 'Arial Unicode MS is requested. The browser uses its fallback font when that face is not installed.'
      : 'The shared Arena-style interface font is active.');
    const updateMessage = value.lastUpdateCheckAt
      ? value.updateStatus
      : 'Never checked. Check now inspects this local clone only; no remote release catalogue is queried.';
    setStatus(controls.general.updateStatus, value.lastUpdateCheckAt ? 'ready' : 'warning', updateMessage);
    setStatus(controls.general.quitStatus, value.quitConfirmation ? 'ready' : 'warning', value.quitConfirmation
      ? 'The main window requests browser close confirmation. The browser controls the final wording.'
      : 'Close confirmation is disabled for the main window.');
  }

  function replaceSelectOptions(node, values, selected) {
    if (!node) return;
    const fragment = document.createDocumentFragment();
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      fragment.appendChild(option);
    });
    node.replaceChildren(fragment);
    setSelect(node, selected);
  }

  function renderRecordingPresetOptions(value) {
    const node = controls.recording.preset;
    if (!node) return;
    const fragment = document.createDocumentFragment();
    RECORDING_PRESET_NAMES.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      fragment.appendChild(option);
    });
    value.customPresets.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `Named · ${item.name}`;
      option.title = `Saved custom profile: ${item.name}`;
      fragment.appendChild(option);
    });
    const custom = document.createElement('option');
    custom.value = 'Custom';
    custom.textContent = 'Custom (unsaved)';
    fragment.appendChild(custom);
    node.replaceChildren(fragment);
    setSelect(node, value.preset);
  }

  function recordingFileNameError(value) {
    const template = String(value == null ? '' : value).trim();
    if (!template) return 'File Name Template is required.';
    if (/[<>:"/\\|?*]/.test(template)) return 'File Name Template cannot contain < > : " / \\ | ? or *.';
    if (/[. ]$/.test(template)) return 'File Name Template cannot end in a period or space.';
    return '';
  }

  function comparableRecording(value) {
    const copy = clone(normaliseRecording(value));
    delete copy.updatedAt;
    delete copy.customPresets;
    return JSON.stringify(copy);
  }

  function recordingCustomPresetFromConfiguration(value, id, name, updatedAt) {
    const profile = normaliseRecordingProfile(value);
    return {
      id: cleanText(id, 160),
      name: cleanText(name, 80),
      container: profile.container,
      codec: profile.codec,
      quality: profile.quality,
      alpha: profile.alpha,
      format: profile.format,
      frameRate: profile.frameRate,
      videoBitrateMbps: profile.videoBitrateMbps,
      audioCodec: profile.audioCodec,
      audioSampleRate: profile.audioSampleRate,
      audioBitDepth: profile.audioBitDepth,
      audioChannels: profile.audioChannels,
      updatedAt: timestamp(updatedAt)
    };
  }

  function formatRecorderBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatRecorderDuration(value) {
    const total = Math.max(0, Math.round((Number(value) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function renderRecorderRuntime(source) {
    recorderRuntime = normaliseRecorderRuntime(source);
    const runtime = recorderRuntime;
    if (!controls.recording.runtimeState || !controls.recording.runtimeMetrics) return;
    controls.recording.runtimeState.dataset.state = runtime.state;
    /* A state readout, not a transport button. Resolume's own equivalents are
       Title Case -- "Not available", "Link Unavailable", "No Device" -- and its
       25 shipped all-caps strings are buttons, acronyms and one alarm. This was
       shouting twice: toUpperCase() here and a text-transform in the sheet. */
    controls.recording.runtimeState.textContent = runtime.state === 'unavailable'
      ? 'Bridge unavailable'
      : runtime.state.charAt(0).toUpperCase() + runtime.state.slice(1);
    if (runtime.state === 'unavailable') {
      controls.recording.runtimeMetrics.textContent = 'No recorder runtime report received.\nArena simulation or a native bridge may publish one.';
      return;
    }
    const metrics = [
      `Mode       ${runtime.mode}`,
      runtime.source ? `Source     ${runtime.source}` : '',
      runtime.jobId ? `Job        ${runtime.jobId}` : '',
      `Duration   ${formatRecorderDuration(runtime.durationMs)}`,
      `Frames     ${runtime.frames}`,
      `Dropped    ${runtime.droppedFrames}`,
      `Written    ${formatRecorderBytes(runtime.bytes)}`,
      runtime.outputPath ? `${runtime.simulated && !runtime.nativeFileCreated ? 'Requested  ' : 'Output     '}${runtime.outputPath}` : '',
      runtime.simulated ? `Native file ${runtime.nativeFileCreated ? 'confirmed' : 'not created'}` : '',
      runtime.lastError ? `Error      ${runtime.lastError}` : ''
    ].filter(Boolean);
    controls.recording.runtimeMetrics.textContent = metrics.join('\n') || 'Recorder bridge is available and idle.';
  }

  function renderRecordingHistory(source) {
    recordingHistory = normaliseRecordingHistory(source);
    const body = controls.recording.historyBody;
    if (!body) return;
    const fragment = document.createDocumentFragment();
    [...recordingHistory].sort((a, b) => b.endedAt - a.endedAt).slice(0, 12).forEach(item => {
      const row = document.createElement('tr');
      row.dataset.recordingId = item.id;
      const snapshotResult = item.kind === 'snapshot'
        ? (item.state === 'error' ? 'download error' : item.nativeFileCreated && item.exists || item.browserDownloadConfirmed ? 'saved' : 'download requested')
        : '';
      row.title = `${item.mode ? `${item.mode} · ` : ''}${item.preset || item.media || 'Recording'} · ${formatRecorderBytes(item.bytes)}${item.kind === 'snapshot'
        ? ` · ${snapshotResult}; browser-managed final path may be unobservable`
        : item.simulated && !item.nativeFileCreated ? ' · metadata only; no native file' : ''}${item.path ? ` · ${item.path}` : ''}`;
      const values = [
        item.endedAt ? new Date(item.endedAt).toLocaleTimeString() : 'N/A',
        item.kind === 'snapshot' ? snapshotResult : item.simulated && !item.nativeFileCreated ? 'metadata' : item.state,
        item.name,
        formatRecorderDuration(item.durationMs),
        item.droppedFrames
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        if (index === 2) cell.title = item.path || item.name;
        row.appendChild(cell);
      });
      fragment.appendChild(row);
    });
    if (!recordingHistory.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'hint';
      cell.textContent = 'No completed recording or snapshot has been reported.';
      row.appendChild(cell);
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
    if (controls.recording.historyClear) controls.recording.historyClear.disabled = !recordingHistory.some(item => item.kind === 'recording' && item.simulated);
  }

  function renderRecording(source, transientMessage) {
    const value = normaliseRecording(source);
    const rule = RECORDING_CODEC_RULES[value.codec];
    models.recording = value;
    applying = true;
    controls.recording.snapshotDirectory.value = value.snapshotDirectory;
    controls.recording.recordingDirectory.value = value.recordingDirectory;
    controls.recording.fileNameTemplate.value = value.fileNameTemplate;
    setSelect(controls.recording.folderMode, value.folderMode);
    controls.recording.recordVideo.checked = value.recordVideo;
    controls.recording.recordAudio.checked = value.recordAudio;
    setSelect(controls.recording.afterRecording, value.afterRecording);
    renderRecordingPresetOptions(value);
    setSelect(controls.recording.codec, value.codec);
    replaceSelectOptions(controls.recording.container, rule.containers, value.container);
    replaceSelectOptions(controls.recording.quality, rule.qualities, value.quality);
    controls.recording.alpha.checked = value.alpha;
    setSelect(controls.recording.frameRate, value.frameRate);
    controls.recording.videoBitrate.value = String(value.videoBitrateMbps);
    controls.recording.videoBitrateValue.value = `${value.videoBitrateMbps} Mbps`;
    controls.recording.videoBitrateValue.textContent = `${value.videoBitrateMbps} Mbps`;
    setSelect(controls.recording.audioCodec, value.audioCodec);
    setSelect(controls.recording.audioSampleRate, String(value.audioSampleRate));
    setSelect(controls.recording.audioBitDepth, String(value.audioBitDepth));
    setSelect(controls.recording.audioChannels, value.audioChannels);
    controls.recording.extension.textContent = value.recordVideo
      ? `${recordingExtension(value.container)}${value.recordAudio ? ' + .wav' : ''}` : '.wav';
    controls.recording.videoGroup.setAttribute('aria-disabled', String(!value.recordVideo));
    controls.recording.audioGroup.setAttribute('aria-disabled', String(!value.recordAudio));
    controls.recording.preset.disabled = !value.recordVideo && !value.recordAudio;
    [controls.recording.container, controls.recording.codec,
      controls.recording.quality, controls.recording.frameRate].forEach(node => { node.disabled = !value.recordVideo; });
    controls.recording.alpha.disabled = !value.recordVideo || !recordingAllowsAlpha(value.codec, value.quality);
    controls.recording.alpha.title = recordingAllowsAlpha(value.codec, value.quality)
      ? 'DXV 3 and ProRes 4444 can retain an alpha channel.' : `${value.codec} ${value.quality} does not support alpha in this recorder profile.`;
    controls.recording.videoBitrate.disabled = !value.recordVideo || value.codec !== 'H.264';
    controls.recording.videoBitrate.title = value.codec === 'H.264'
      ? 'Target bitrate for H.264 recording.' : 'Target bitrate applies only to H.264.';
    [controls.recording.audioCodec, controls.recording.audioSampleRate,
      controls.recording.audioBitDepth, controls.recording.audioChannels].forEach(node => { node.disabled = !value.recordAudio; });
    const selectedCustomPreset = value.customPresets.find(item => item.id === value.preset);
    controls.recording.presetSave.disabled = !value.recordVideo && !value.recordAudio;
    controls.recording.presetSave.title = value.recordVideo || value.recordAudio
      ? 'Save the current video and audio encoding settings as a named preset.'
      : 'Enable video or audio before saving a named preset.';
    controls.recording.presetDelete.disabled = !selectedCustomPreset;
    controls.recording.presetDelete.title = selectedCustomPreset
      ? `Delete the named preset “${selectedCustomPreset.name}”.`
      : 'Factory presets and the unsaved Custom state cannot be deleted.';
    controls.recording.reset.disabled = comparableRecording(value) === comparableRecording({});
    controls.recording.restore.disabled = comparableRecording(value) === comparableRecording(recordingSessionBaseline);
    applying = false;
    let state = 'ready';
    let message = transientMessage || `${value.recordVideo ? `${value.container} · ${value.codec} · ${value.quality}${value.alpha ? ' · alpha' : ''}` : 'Video off'}; ${value.recordAudio ? `${value.audioCodec} · ${value.audioSampleRate} Hz · ${value.audioBitDepth} bit · ${value.audioChannels}` : 'audio off'}. Settings are snapshotted by each reported recording job.`;
    const nameError = recordingFileNameError(value.fileNameTemplate);
    if (!value.recordVideo && !value.recordAudio) {
      state = 'error';
      message = 'Enable video or audio before starting a recording. No native recording command is sent by this browser page.';
    } else if (!value.recordingDirectory) {
      state = 'error'; message = 'Choose a recording output directory.';
    } else if (nameError) {
      state = 'error'; message = nameError;
    } else if (value.afterRecording !== 'Do Nothing') {
      state = 'warning';
      message += ' The runtime may simulate this action explicitly, but native file placement or reveal is not claimed until a native bridge confirms it.';
    }
    setStatus(controls.recording.status, state, message);
  }

  function renderClipRendering(source, transientMessage) {
    const value = normaliseClipRendering(source);
    models.clipRendering = value;
    applying = true;
    controls.clipRendering.directory.value = value.directory;
    setSelect(controls.clipRendering.preset, value.preset);
    setSelect(controls.clipRendering.codec, value.codec);
    setSelect(controls.clipRendering.format, value.format);
    controls.clipRendering.includeAudio.checked = value.includeAudio;
    setSelect(controls.clipRendering.sampleRate, String(value.sampleRate));
    setSelect(controls.clipRendering.bitDepth, String(value.bitDepth));
    const sequence = value.codec === 'PNG Sequence';
    controls.clipRendering.includeAudio.disabled = sequence;
    controls.clipRendering.sampleRate.disabled = sequence || !value.includeAudio;
    controls.clipRendering.bitDepth.disabled = sequence || !value.includeAudio;
    applying = false;
    const message = transientMessage || 'Each render Job receives a snapshot of these settings when it enters the Queue; later changes do not rewrite queued Jobs. The SHOWAVE browser runtime queues conversion intent only; native codecs require a desktop bridge.';
    setStatus(controls.clipRendering.status, value.directory ? 'ready' : 'error',
      value.directory ? message : 'Choose a clip-render output directory. No native render was started.');
  }

  function renderDefaults(source, changed) {
    const value = normaliseDefaults(source);
    models.defaults = value;
    applying = true;
    setSelect(controls.defaults.videoTransport, value.videoTransport);
    setSelect(controls.defaults.videoPlayMode, value.videoPlayMode);
    setSelect(controls.defaults.videoPlayModeAway, value.videoPlayModeAway);
    setSelect(controls.defaults.audioTransport, value.audioTransport);
    setSelect(controls.defaults.audioPlayMode, value.audioPlayMode);
    setSelect(controls.defaults.audioPlayModeAway, value.audioPlayModeAway);
    setSelect(controls.defaults.layerBlendMode, value.layerBlendMode);
    controls.defaults.tempoNudgeRange.value = String(value.tempoNudgeRange);
    controls.defaults.tempoNudgeValue.value = String(value.tempoNudgeRange);
    controls.defaults.tempoNudgeValue.textContent = String(value.tempoNudgeRange);
    applying = false;
    setStatus(controls.defaults.status, 'ready', `${changed ? 'Saved. ' : ''}Clip defaults apply only to new imports and the blend default only to new layers; existing clips and layers are unchanged. Tempo nudge range is live.`);
  }

  function renderFeedback(source) {
    const value = normaliseFeedback(source);
    models.feedback = value;
    applying = true;
    controls.feedback.remember.checked = value.rememberContact;
    controls.feedback.includeLog.checked = value.includeLog;
    if (value.rememberContact) {
      sessionContact.name = value.name;
      sessionContact.email = value.email;
      controls.feedback.name.value = value.name;
      controls.feedback.email.value = value.email;
    }
    applying = false;
    if (!controls.feedback.status.textContent) setStatus(controls.feedback.status, 'warning',
      'Draft text stays in this page only. Copy Feedback Package uses the clipboard; nothing is sent to a server.');
  }

  function readGeneral() {
    return normaliseGeneral(Object.assign({}, models.general, {
      updateClipPanelOnExternalTriggers: controls.general.panelUpdates.checked,
      clipStartOffsetMs: controls.general.clipStartOffset.value,
      scrollSelection: controls.general.scrollSelection.checked,
      unicodeFont: controls.general.unicodeFont.checked,
      checkUpdates: controls.general.checkUpdates.checked,
      releaseChannel: controls.general.releaseChannel.value,
      startupScreen: controls.general.startupScreen.checked,
      quitConfirmation: controls.general.quitConfirmation.checked,
      pioneerInterface: controls.general.pioneerInterface.value
    }));
  }

  function readRecording(options) {
    const manual = options && options.manualCodec;
    const selectedPreset = controls.recording.preset.value;
    return normaliseRecording(Object.assign({}, models.recording, {
      snapshotDirectory: controls.recording.snapshotDirectory.value,
      recordingDirectory: controls.recording.recordingDirectory.value,
      fileNameTemplate: controls.recording.fileNameTemplate.value,
      folderMode: controls.recording.folderMode.value,
      recordVideo: controls.recording.recordVideo.checked,
      recordAudio: controls.recording.recordAudio.checked,
      preset: manual ? 'Custom' : selectedPreset,
      container: controls.recording.container.value,
      codec: controls.recording.codec.value,
      quality: controls.recording.quality.value,
      alpha: controls.recording.alpha.checked,
      frameRate: controls.recording.frameRate.value,
      videoBitrateMbps: controls.recording.videoBitrate.value,
      audioCodec: controls.recording.audioCodec.value,
      audioSampleRate: controls.recording.audioSampleRate.value,
      audioBitDepth: controls.recording.audioBitDepth.value,
      audioChannels: controls.recording.audioChannels.value,
      afterRecording: controls.recording.afterRecording.value
    }));
  }

  function readClipRendering(options) {
    const manual = options && options.manualCodec;
    return normaliseClipRendering(Object.assign({}, models.clipRendering, {
      directory: controls.clipRendering.directory.value,
      preset: manual ? 'Custom' : controls.clipRendering.preset.value,
      codec: controls.clipRendering.codec.value,
      format: controls.clipRendering.format.value,
      includeAudio: controls.clipRendering.includeAudio.checked,
      sampleRate: controls.clipRendering.sampleRate.value,
      bitDepth: controls.clipRendering.bitDepth.value
    }));
  }

  function readDefaults() {
    return normaliseDefaults(Object.assign({}, models.defaults, {
      videoTransport: controls.defaults.videoTransport.value,
      videoPlayMode: controls.defaults.videoPlayMode.value,
      videoPlayModeAway: controls.defaults.videoPlayModeAway.value,
      audioTransport: controls.defaults.audioTransport.value,
      audioPlayMode: controls.defaults.audioPlayMode.value,
      audioPlayModeAway: controls.defaults.audioPlayModeAway.value,
      layerBlendMode: controls.defaults.layerBlendMode.value,
      tempoNudgeRange: controls.defaults.tempoNudgeRange.value
    }));
  }

  function on(node, eventName, listener) {
    if (node) node.addEventListener(eventName, listener);
  }

  function bindGeneral() {
    const save = (reason, key) => {
      if (applying) return;
      renderGeneral(commitDomain('general', readGeneral(), reason, key));
    };
    on(controls.general.panelUpdates, 'change', () => save('general-panel-update-change', 'updateClipPanelOnExternalTriggers'));
    on(controls.general.clipStartOffset, 'change', () => save('general-clip-offset-change', 'clipStartOffsetMs'));
    on(controls.general.scrollSelection, 'change', () => save('general-scroll-change', 'scrollSelection'));
    on(controls.general.unicodeFont, 'change', () => save('general-font-change', 'unicodeFont'));
    on(controls.general.checkUpdates, 'change', () => save('general-update-policy-change', 'checkUpdates'));
    on(controls.general.releaseChannel, 'change', () => save('general-release-channel-change', 'releaseChannel'));
    on(controls.general.startupScreen, 'change', () => save('general-startup-change', 'startupScreen'));
    on(controls.general.quitConfirmation, 'change', () => save('general-quit-confirmation-change', 'quitConfirmation'));
    on(controls.general.pioneerInterface, 'change', () => save('general-pioneer-interface-change', 'pioneerInterface'));
    on(controls.general.checkNow, 'click', () => {
      const checkedAt = Date.now();
      const checked = new Date(checkedAt).toLocaleString();
      const message = `Local clone checked ${checked}. Preferences System ${VERSION}; Hub schema ${Hub.schema}. No remote release catalogue was queried.`;
      renderGeneral(updateDomain('general', {
        lastUpdateCheckAt: checkedAt, updateStatus: message
      }, 'general-local-version-check', 'lastUpdateCheckAt'));
    });
  }

  const directoryHandles = new Map();
  async function chooseDirectory(input, commit, statusNode, label) {
    if (!input) return;
    if (typeof global.showDirectoryPicker === 'function') {
      try {
        const handle = await global.showDirectoryPicker({ mode: 'readwrite' });
        if (!handle) return;
        directoryHandles.set(input.id, handle);
        input.value = cleanPath(handle.name, input.value);
        commit(input.value);
        setStatus(statusNode, 'warning', `${label} “${input.value}” is available through a session-only browser folder handle. The shared preference stores its label, not the handle or a hidden native path.`);
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        setStatus(statusNode, 'warning', `The browser folder picker was unavailable (${cleanText(error && error.message, 120) || 'unknown error'}). Enter a directory label or path manually.`);
      }
    }
    const selected = global.prompt ? global.prompt(`${label} path or folder label`, input.value) : null;
    if (selected == null) return;
    input.value = cleanPath(selected, input.value);
    commit(input.value);
    setStatus(statusNode, 'warning', `${label} was saved as configuration. Native filesystem access still requires the desktop bridge.`);
  }

  function bindRecording() {
    const destinationError = () => {
      controls.recording.snapshotDirectory.removeAttribute('aria-invalid');
      controls.recording.recordingDirectory.removeAttribute('aria-invalid');
      controls.recording.fileNameTemplate.removeAttribute('aria-invalid');
      if (!String(controls.recording.snapshotDirectory.value || '').trim()) {
        controls.recording.snapshotDirectory.setAttribute('aria-invalid', 'true');
        return 'Snapshot Output Directory is required.';
      }
      if (!String(controls.recording.recordingDirectory.value || '').trim()) {
        controls.recording.recordingDirectory.setAttribute('aria-invalid', 'true');
        return 'Recording Output Directory is required.';
      }
      const nameError = recordingFileNameError(controls.recording.fileNameTemplate.value);
      if (nameError) controls.recording.fileNameTemplate.setAttribute('aria-invalid', 'true');
      return nameError;
    };
    const save = (reason, key, options) => {
      if (applying) return;
      const error = destinationError();
      if (error) {
        setStatus(controls.recording.status, 'error', `${error} The previous shared value was kept.`);
        return;
      }
      renderRecording(commitDomain('recording', readRecording(options), reason, key));
    };
    on(controls.recording.snapshotDirectory, 'change', () => save('recording-snapshot-directory-change', 'snapshotDirectory'));
    on(controls.recording.recordingDirectory, 'change', () => save('recording-directory-change', 'recordingDirectory'));
    on(controls.recording.fileNameTemplate, 'change', () => save('recording-file-name-change', 'fileNameTemplate'));
    on(controls.recording.folderMode, 'change', () => save('recording-folder-mode-change', 'folderMode'));
    on(controls.recording.recordVideo, 'change', () => save('recording-video-change', 'recordVideo'));
    on(controls.recording.recordAudio, 'change', () => save('recording-audio-change', 'recordAudio'));
    on(controls.recording.preset, 'change', () => save('recording-preset-change', 'preset'));
    on(controls.recording.presetSave, 'click', () => {
      if (applying) return;
      if (!controls.recording.recordVideo.checked && !controls.recording.recordAudio.checked) {
        setStatus(controls.recording.status, 'error', 'Enable video or audio before saving a named recording preset.');
        return;
      }
      if (typeof global.prompt !== 'function') {
        setStatus(controls.recording.status, 'warning', 'This browser cannot request a preset name. Current settings were not changed.');
        return;
      }
      const selected = models.recording.customPresets.find(item => item.id === models.recording.preset);
      const suggested = selected ? selected.name : `Custom Preset ${models.recording.customPresets.length + 1}`;
      const entered = global.prompt('Name this recording preset', suggested);
      if (entered == null) return;
      const name = cleanText(entered, 80);
      if (!name) {
        setStatus(controls.recording.status, 'error', 'A named recording preset needs a non-empty name.');
        return;
      }
      const reserved = [...RECORDING_PRESET_NAMES, 'Custom'].find(item => item.toLowerCase() === name.toLowerCase());
      if (reserved) {
        setStatus(controls.recording.status, 'error', `“${reserved}” is an immutable factory preset name. Choose another name.`);
        return;
      }
      const duplicate = models.recording.customPresets.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (duplicate && (!selected || duplicate.id !== selected.id)
        && typeof global.confirm === 'function'
        && !global.confirm(`Replace the saved recording preset “${duplicate.name}” with the current settings?`)) return;
      let id = duplicate ? duplicate.id : selected && selected.id;
      if (!id) {
        do {
          id = `recording-preset:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        } while (models.recording.customPresets.some(item => item.id === id));
      }
      const current = readRecording({ manualCodec: true });
      const now = Date.now();
      const namedPreset = recordingCustomPresetFromConfiguration(current, id, name, now);
      const replacedIds = new Set([id]);
      if (selected && duplicate && selected.id !== duplicate.id) replacedIds.add(selected.id);
      const customPresets = models.recording.customPresets
        .filter(item => !replacedIds.has(item.id)).concat(namedPreset);
      const candidate = Object.assign({}, current, { customPresets, preset: id });
      renderRecording(commitDomain('recording', candidate, 'recording-custom-preset-saved', 'customPresets'),
        `Saved named recording preset “${name}”. Factory presets were not changed.`);
    });
    on(controls.recording.presetDelete, 'click', () => {
      if (applying) return;
      const selected = models.recording.customPresets.find(item => item.id === models.recording.preset);
      if (!selected) {
        setStatus(controls.recording.status, 'warning', 'Only named custom recording presets can be deleted. Factory presets and the unsaved Custom state are immutable.');
        return;
      }
      if (typeof global.confirm === 'function'
        && !global.confirm(`Delete the named recording preset “${selected.name}”? Current encoding values will remain as unsaved Custom settings.`)) return;
      const current = readRecording({ manualCodec: true });
      const customPresets = models.recording.customPresets.filter(item => item.id !== selected.id);
      const candidate = Object.assign({}, current, { customPresets, preset: 'Custom' });
      renderRecording(commitDomain('recording', candidate, 'recording-custom-preset-deleted', 'customPresets'),
        `Deleted named recording preset “${selected.name}”. Its current values remain in Custom; no recording files or history were changed.`);
    });
    on(controls.recording.container, 'change', () => save('recording-container-change', 'container', { manualCodec: true }));
    on(controls.recording.codec, 'change', () => {
      const rule = RECORDING_CODEC_RULES[controls.recording.codec.value] || RECORDING_CODEC_RULES['DXV 3'];
      replaceSelectOptions(controls.recording.container, rule.containers, rule.defaultContainer);
      replaceSelectOptions(controls.recording.quality, rule.qualities, rule.defaultQuality);
      controls.recording.alpha.checked = false;
      save('recording-codec-change', 'codec', { manualCodec: true });
    });
    on(controls.recording.quality, 'change', () => save('recording-quality-change', 'quality', { manualCodec: true }));
    on(controls.recording.alpha, 'change', () => save('recording-alpha-change', 'alpha', { manualCodec: true }));
    on(controls.recording.frameRate, 'change', () => save('recording-frame-rate-change', 'frameRate', { manualCodec: true }));
    on(controls.recording.videoBitrate, 'input', () => {
      const bitrate = integer(controls.recording.videoBitrate.value, 5, 120, 35);
      controls.recording.videoBitrateValue.value = `${bitrate} Mbps`;
      controls.recording.videoBitrateValue.textContent = `${bitrate} Mbps`;
    });
    on(controls.recording.videoBitrate, 'change', () => save('recording-video-bitrate-change', 'videoBitrateMbps', { manualCodec: true }));
    on(controls.recording.audioCodec, 'change', () => save('recording-audio-codec-change', 'audioCodec', { manualCodec: true }));
    on(controls.recording.audioSampleRate, 'change', () => save('recording-audio-sample-rate-change', 'audioSampleRate', { manualCodec: true }));
    on(controls.recording.audioBitDepth, 'change', () => save('recording-bit-depth-change', 'audioBitDepth', { manualCodec: true }));
    on(controls.recording.audioChannels, 'change', () => save('recording-audio-channels-change', 'audioChannels', { manualCodec: true }));
    on(controls.recording.afterRecording, 'change', () => save('recording-after-change', 'afterRecording'));
    on(controls.recording.snapshotBrowse, 'click', () => chooseDirectory(
      controls.recording.snapshotDirectory,
      value => renderRecording(updateDomain('recording', { snapshotDirectory: value }, 'recording-snapshot-directory-picked', 'snapshotDirectory')),
      controls.recording.status, 'Snapshot folder'));
    on(controls.recording.recordingBrowse, 'click', () => chooseDirectory(
      controls.recording.recordingDirectory,
      value => renderRecording(updateDomain('recording', { recordingDirectory: value }, 'recording-directory-picked', 'recordingDirectory')),
      controls.recording.status, 'Recording folder'));
    on(controls.recording.reset, 'click', () => {
      const defaults = normaliseRecording({ customPresets: models.recording.customPresets });
      renderRecording(commitDomain('recording', defaults, 'recording-reset-defaults', 'reset'), 'Recording preferences were reset to factory defaults. Named presets, runtime and job history were not changed.');
    });
    on(controls.recording.restore, 'click', () => {
      const source = Object.assign({}, recordingSessionBaseline, { customPresets: models.recording.customPresets });
      if (!RECORDING_PRESETS[source.preset] && source.preset !== 'Custom'
        && !source.customPresets.some(item => item.id === source.preset)) source.preset = 'Custom';
      renderRecording(commitDomain('recording', source, 'recording-restore-at-open', 'restore'), 'Recording preferences were restored to the values present when this page opened. Named presets, runtime and job history were not changed.');
    });
    on(controls.recording.historyClear, 'click', () => {
      const rawItems = Hub.get('recordings.items', []);
      const ids = (Array.isArray(rawItems) ? rawItems : [])
        .filter(item => isObject(item) && item.kind === 'recording' && item.simulated === true)
        .map(item => cleanText(item.id, 160)).filter(Boolean);
      if (!ids.length) {
        setStatus(controls.recording.status, 'warning', 'There is no simulated recording metadata to clean up. Preferences does not remove snapshots or native recording entries.');
        return;
      }
      if (typeof global.confirm === 'function' && !global.confirm(`Ask Arena to clear ${ids.length} simulated recording metadata entr${ids.length === 1 ? 'y' : 'ies'} and any linked demo placeholders? Native files will not be deleted.`)) return;
      const requestId = `preferences-clear:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
      recorderClearRequestId = requestId;
      clearTimeout(recorderClearTimer);
      recorderClearTimer = global.setTimeout(() => {
        if (recorderClearRequestId !== requestId) return;
        recorderClearRequestId = '';
        setStatus(controls.recording.status, 'error',
          'Arena did not answer the cleanup request. Open the Arena main window and try again. No shared metadata or native files were changed by Preferences.');
      }, 5000);
      Hub.emit('openlive:recording-metadata-clear-request', {
        requestId,
        ids, scope: 'simulated-recording-metadata', nativeFilesMayBeDeleted: false,
        requestedAt: Date.now(), source: 'preferences-system'
      }, { activity: false });
      setStatus(controls.recording.status, 'warning', 'Cleanup was requested from Arena. This list stays unchanged until Arena updates the shared artifacts and linked placeholders. No native file deletion was requested.');
    });
  }

  function bindClipRendering() {
    const save = (reason, key, options) => {
      if (applying) return;
      renderClipRendering(commitDomain('clipRendering', readClipRendering(options), reason, key));
    };
    on(controls.clipRendering.directory, 'change', () => save('clip-render-directory-change', 'directory'));
    on(controls.clipRendering.preset, 'change', () => save('clip-render-preset-change', 'preset'));
    on(controls.clipRendering.codec, 'change', () => save('clip-render-codec-change', 'codec', { manualCodec: true }));
    on(controls.clipRendering.format, 'change', () => save('clip-render-format-change', 'format', { manualCodec: true }));
    on(controls.clipRendering.includeAudio, 'change', () => save('clip-render-audio-change', 'includeAudio'));
    on(controls.clipRendering.sampleRate, 'change', () => save('clip-render-sample-rate-change', 'sampleRate'));
    on(controls.clipRendering.bitDepth, 'change', () => save('clip-render-bit-depth-change', 'bitDepth'));
    on(controls.clipRendering.browse, 'click', () => chooseDirectory(
      controls.clipRendering.directory,
      value => renderClipRendering(updateDomain('clipRendering', { directory: value }, 'clip-render-directory-picked', 'directory')),
      controls.clipRendering.status, 'Clip-render folder'));
  }

  function bindDefaults() {
    const save = (reason, key) => {
      if (applying) return;
      renderDefaults(commitDomain('defaults', readDefaults(), reason, key), true);
    };
    [
      [controls.defaults.videoTransport, 'videoTransport'],
      [controls.defaults.videoPlayMode, 'videoPlayMode'],
      [controls.defaults.videoPlayModeAway, 'videoPlayModeAway'],
      [controls.defaults.audioTransport, 'audioTransport'],
      [controls.defaults.audioPlayMode, 'audioPlayMode'],
      [controls.defaults.audioPlayModeAway, 'audioPlayModeAway'],
      [controls.defaults.layerBlendMode, 'layerBlendMode']
    ].forEach(([node, key]) => on(node, 'change', () => save('defaults-change', key)));
    on(controls.defaults.tempoNudgeRange, 'input', () => {
      if (applying) return;
      const value = integer(controls.defaults.tempoNudgeRange.value, 1, 100, 10);
      controls.defaults.tempoNudgeValue.value = String(value);
      controls.defaults.tempoNudgeValue.textContent = String(value);
      clearTimeout(defaultsTimer);
      defaultsTimer = global.setTimeout(() => save('defaults-tempo-nudge-change', 'tempoNudgeRange'), 120);
    });
    on(controls.defaults.tempoNudgeRange, 'change', () => {
      clearTimeout(defaultsTimer);
      save('defaults-tempo-nudge-change', 'tempoNudgeRange');
    });
  }

  function safeDiagnostic() {
    const snapshot = Hub.snapshot();
    const composition = isObject(snapshot.composition) ? snapshot.composition : {};
    const transport = isObject(snapshot.transport) ? snapshot.transport : {};
    const connection = isObject(snapshot.connection) ? snapshot.connection : {};
    return {
      generatedAt: new Date().toISOString(),
      application: 'SHOWAVE Live',
      preferencesSystemVersion: VERSION,
      hubSchema: Hub.schema,
      page: 'preferences.html',
      secureContext: !!global.isSecureContext,
      capabilities: {
        clipboardWrite: !!(global.navigator && navigator.clipboard && navigator.clipboard.writeText),
        directoryPicker: typeof global.showDirectoryPicker === 'function',
        broadcastChannel: typeof global.BroadcastChannel === 'function'
      },
      connection: { status: cleanText(connection.status, 32) || 'unknown' },
      composition: {
        width: integer(composition.width, 1, 16384, 1920),
        height: integer(composition.height, 1, 16384, 1080),
        layerCount: integer(composition.layerCount, 0, 10000, 0),
        columnCount: integer(composition.columnCount, 0, 10000, 0)
      },
      transport: {
        playState: cleanText(transport.playState, 32) || 'unknown',
        bpm: clamp(transport.bpm, 1, 1000, 120)
      },
      sharedCounts: {
        mediaFiles: Array.isArray(snapshot.media && snapshot.media.files) ? snapshot.media.files.length : 0,
        renderJobs: Array.isArray(snapshot.render && snapshot.render.queue) ? snapshot.render.queue.length : 0,
        fixtures: Array.isArray(snapshot.fixtures && snapshot.fixtures.items) ? snapshot.fixtures.items.length : 0,
        wirePatches: Array.isArray(snapshot.wire && snapshot.wire.patches) ? snapshot.wire.patches.length : 0
      },
      privacy: 'Generated summary only: no message, contact, raw activity, paths, device labels, routes, network addresses or registration data.'
    };
  }

  function showDiagnostic() {
    let overlay = byId('feedbackDiagnosticDialog');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'feedbackDiagnosticDialog';
      overlay.className = 'overlay';
      overlay.innerHTML = '<div class="dialog" style="width:min(720px,calc(100vw - 40px))">' +
        '<div class="fw-title">Safe Diagnostic Preview <button class="tb-btn" type="button" data-feedback-log-close>Close</button></div>' +
        '<div class="fw-body"><pre data-feedback-log style="white-space:pre-wrap;max-height:440px;overflow:auto;user-select:text"></pre></div>' +
        '<div class="statusline">Generated on demand · never saved to the SHOWAVE shared state</div></div>';
      document.body.appendChild(overlay);
      on(overlay.querySelector('[data-feedback-log-close]'), 'click', () => overlay.classList.remove('show'));
      on(overlay, 'mousedown', event => { if (event.target === overlay) overlay.classList.remove('show'); });
    }
    overlay.querySelector('[data-feedback-log]').textContent = JSON.stringify(safeDiagnostic(), null, 2);
    overlay.classList.add('show');
    setStatus(controls.feedback.status, 'ready', 'Safe diagnostic generated for preview. It was not stored or sent.');
  }

  function validEmail(email) {
    return !email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  async function copyText(value) {
    if (global.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return;
    }
    const temporary = document.createElement('textarea');
    temporary.value = value;
    temporary.setAttribute('readonly', '');
    temporary.style.cssText = 'position:fixed;left:-10000px;top:-10000px;opacity:0';
    document.body.appendChild(temporary);
    temporary.select();
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    temporary.remove();
    if (!copied) throw new Error('Clipboard access is not available in this browser context.');
  }

  function feedbackCandidate() {
    sessionContact.name = cleanText(controls.feedback.name.value, 120);
    sessionContact.email = cleanText(controls.feedback.email.value, 254);
    return normaliseFeedback(Object.assign({}, models.feedback, {
      name: sessionContact.name, email: sessionContact.email,
      rememberContact: controls.feedback.remember.checked,
      includeLog: controls.feedback.includeLog.checked
    }));
  }

  function saveFeedback(reason, key) {
    if (applying) return models.feedback;
    return commitDomain('feedback', feedbackCandidate(), reason, key);
  }

  function bindFeedback() {
    controls.feedback.send.textContent = 'Copy Feedback Package';
    controls.feedback.send.title = 'Validate and copy a package; no network delivery is performed';
    const contactInput = (key) => {
      if (applying) return;
      sessionContact[key] = cleanText(controls.feedback[key].value, key === 'email' ? 254 : 120);
      if (controls.feedback.remember.checked) {
        clearTimeout(feedbackTimer);
        feedbackTimer = global.setTimeout(() => saveFeedback('feedback-contact-change', key), 180);
      }
      setStatus(controls.feedback.status, 'warning', controls.feedback.remember.checked
        ? 'Remembered contact is saved locally in shared preferences. The feedback draft is never stored there.'
        : 'Contact and draft remain in this page session only. Nothing has been sent.');
    };
    on(controls.feedback.name, 'input', () => contactInput('name'));
    on(controls.feedback.email, 'input', () => contactInput('email'));
    on(controls.feedback.name, 'change', () => saveFeedback('feedback-contact-change', 'name'));
    on(controls.feedback.email, 'change', () => saveFeedback('feedback-contact-change', 'email'));
    on(controls.feedback.remember, 'change', () => {
      clearTimeout(feedbackTimer);
      saveFeedback('feedback-remember-change', 'rememberContact');
      setStatus(controls.feedback.status, controls.feedback.remember.checked ? 'ready' : 'warning',
        controls.feedback.remember.checked
          ? 'Contact is remembered in shared local preferences. Draft text is still page-only.'
          : 'Remembered contact was removed from shared preferences. The visible draft remains page-only.');
    });
    on(controls.feedback.includeLog, 'change', () => {
      saveFeedback('feedback-diagnostic-choice-change', 'includeLog');
      setStatus(controls.feedback.status, 'warning', controls.feedback.includeLog.checked
        ? 'A newly generated safe diagnostic will be included in the copied package; no raw log is stored.'
        : 'The copied package will not include a diagnostic.');
    });
    on(controls.feedback.message, 'input', () => setStatus(controls.feedback.status, 'warning',
      `Draft stays in this page only (${cleanMessage(controls.feedback.message.value).length}/5000 characters).`));
    on(controls.feedback.viewLog, 'click', showDiagnostic);
    on(controls.feedback.clear, 'click', () => {
      clearTimeout(feedbackTimer);
      sessionContact.name = '';
      sessionContact.email = '';
      controls.feedback.name.value = '';
      controls.feedback.email.value = '';
      controls.feedback.message.value = '';
      controls.feedback.remember.checked = false;
      controls.feedback.includeLog.checked = false;
      commitDomain('feedback', {
        name: '', email: '', rememberContact: false, includeLog: false,
        lastSubmittedAt: models.feedback.lastSubmittedAt
      }, 'feedback-draft-cleared', 'clear');
      setStatus(controls.feedback.status, 'ready', 'Draft and remembered contact were cleared locally. Nothing was sent.');
    });
    on(controls.feedback.send, 'click', async () => {
      clearTimeout(feedbackTimer);
      const feedback = feedbackCandidate();
      const message = cleanMessage(controls.feedback.message.value);
      if (!validEmail(sessionContact.email)) {
        setStatus(controls.feedback.status, 'error', 'Enter a valid email address or leave it blank. Nothing was copied or sent.');
        controls.feedback.email.focus();
        return;
      }
      if (message.length < 10) {
        setStatus(controls.feedback.status, 'error', 'Enter at least 10 characters of feedback. Nothing was copied or sent.');
        controls.feedback.message.focus();
        return;
      }
      const lines = [
        'SHOWAVE Feedback Package',
        `Generated: ${new Date().toISOString()}`,
        `Name: ${sessionContact.name || '(not provided)'}`,
        `Email: ${sessionContact.email || '(not provided)'}`,
        '', 'Message:', message
      ];
      if (feedback.includeLog) lines.push('', 'Safe diagnostic:', JSON.stringify(safeDiagnostic(), null, 2));
      controls.feedback.send.disabled = true;
      try {
        await copyText(lines.join('\n'));
        controls.feedback.message.value = '';
        const copiedAt = Date.now();
        const committed = commitDomain('feedback', Object.assign({}, feedback, {
          lastSubmittedAt: copiedAt
        }), 'feedback-package-copied', 'lastSubmittedAt');
        renderFeedback(committed);
        setStatus(controls.feedback.status, 'ready',
          `Feedback package copied at ${new Date(copiedAt).toLocaleTimeString()}. The draft was cleared. Nothing was delivered over the network.`);
      } catch (error) {
        setStatus(controls.feedback.status, 'error',
          `Clipboard copy failed: ${cleanText(error && error.message, 180) || 'permission denied'}. The draft was kept and nothing was sent.`);
      } finally {
        controls.feedback.send.disabled = false;
      }
    });
  }

  function scrubRegistrationState(snapshot) {
    const preferences = snapshot.preferences || (snapshot.preferences = {});
    delete preferences.registration;
    const values = Object.assign({}, isObject(preferences.values) ? preferences.values : {});
    Object.keys(values).forEach(key => { if (key.startsWith('registration.')) delete values[key]; });
    preferences.values = values;
  }

  function bindRegistration() {
    controls.registration.statusText.textContent = 'Native Resolume registration unavailable';
    controls.registration.deactivate.disabled = true;
    controls.registration.deactivate.setAttribute('aria-disabled', 'true');
    controls.registration.deactivate.title = 'Use the installed Resolume Arena application for registration changes';
    setStatus(controls.registration.status, 'warning',
      'Capability display only. SHOWAVE never reads, stores, displays, activates or deactivates native Resolume registration credentials.');
    on(controls.registration.check, 'click', () => {
      const bridgeDetected = 'OpenLiveNativeRegistration' in global;
      controls.registration.statusText.textContent = bridgeDetected
        ? 'Native bridge detected · registration deliberately not accessed'
        : 'Native Resolume registration unavailable';
      setStatus(controls.registration.status, bridgeDetected ? 'warning' : 'ready',
        `${bridgeDetected ? 'A native bridge marker exists, but this page did not call it.' : 'No native registration capability is exposed to this browser.'} No credentials were accessed. Use the installed Resolume Arena application for licensing operations.`);
    });
    on(controls.registration.deactivate, 'click', () => setStatus(controls.registration.status, 'warning',
      'Native deactivation is intentionally disabled here. No license operation was attempted.'));
  }

  function reportRecorderRuntime(payload) {
    if (!isObject(payload)) return false;
    const merged = Object.assign({}, Hub.get('recording', {}), recorderRuntime, clone(payload));
    const runtime = normaliseRecorderRuntime(merged);
    recorderRuntime = runtime;
    const preserved = Object.assign({}, merged, runtime);
    Hub.patch('recording', preserved, { reason: 'native-recorder-runtime-reported' });
    return clone(preserved);
  }

  function reportRecordingCompleted(payload) {
    if (!isObject(payload) || !cleanText(payload.id || payload.jobId || payload.name || payload.fileName || payload.path || payload.outputPath, 1024)) return null;
    const incoming = clone(payload);
    const id = cleanText(incoming.id || incoming.jobId, 160) || `recording:${Date.now().toString(36)}`;
    const current = Hub.get('recordings.items', []);
    const existing = (Array.isArray(current) ? current : []).find(entry => isObject(entry) && cleanText(entry.id || entry.jobId, 160) === id);
    const item = Object.assign({}, isObject(existing) ? existing : {}, incoming, { id });
    item.id = id;
    const preserved = (Array.isArray(current) ? current : []).filter(entry => !isObject(entry) || cleanText(entry.id || entry.jobId, 160) !== id);
    const items = [...preserved, item].slice(-100);
    Hub.patch('recordings', { items }, { reason: 'native-recording-job-completed' });
    return clone(item);
  }

  function reportRecordingHistory(payload) {
    const source = Array.isArray(payload) ? payload : payload && payload.items;
    if (!Array.isArray(source)) return false;
    const current = Hub.get('recordings.items', []);
    const items = Array.isArray(current) ? clone(current) : [];
    clone(source).forEach((incoming, index) => {
      if (!isObject(incoming)) { items.push(incoming); return; }
      const id = cleanText(incoming.id || incoming.jobId, 160) || `recording-report:${index}`;
      const at = items.findIndex(entry => isObject(entry) && cleanText(entry.id || entry.jobId, 160) === id);
      if (at >= 0) items[at] = Object.assign({}, items[at], incoming, { id });
      else items.push(Object.assign({}, incoming, { id }));
    });
    const bounded = items.slice(-100);
    Hub.patch('recordings', { items: bounded }, { reason: 'native-recording-history-reported' });
    return clone(bounded);
  }

  function bindRecorderBridge() {
    if (typeof Hub.on !== 'function') return;
    Hub.on('openlive:recording-status', reportRecorderRuntime);
    Hub.on('openlive:recording-runtime', reportRecorderRuntime);
    Hub.on('openlive:recording-job-completed', reportRecordingCompleted);
    Hub.on('openlive:recording-completed', reportRecordingCompleted);
    Hub.on('openlive:recording-history-result', reportRecordingHistory);
    Hub.on('openlive:recording-metadata-clear-completed', report => {
      if (recorderClearRequestId && report?.requestId && report.requestId !== recorderClearRequestId) return;
      clearTimeout(recorderClearTimer); recorderClearTimer = 0; recorderClearRequestId = '';
      const count = Array.isArray(report && report.clearedIds) ? report.clearedIds.length : 0;
      setStatus(controls.recording.status, count ? 'ok' : 'warning', count
        ? `${count} simulated recording metadata entr${count === 1 ? 'y was' : 'ies were'} cleared by Arena. Linked demo placeholders were removed and no native files were touched.`
        : 'Arena completed the cleanup request, but no matching simulated recording metadata was found. No native files were touched.');
    });
    Hub.on('openlive:recording-metadata-clear-failed', report => {
      if (recorderClearRequestId && report?.requestId && report.requestId !== recorderClearRequestId) return;
      clearTimeout(recorderClearTimer); recorderClearTimer = 0; recorderClearRequestId = '';
      const message = cleanText(report && report.message, 240) || 'Arena could not complete the cleanup request.';
      setStatus(controls.recording.status, 'error', `${message} No native files were touched.`);
    });
    const at = Date.now();
    Hub.emit('openlive:recording-state-request', { at, source: 'preferences-system' }, { activity: false });
    Hub.emit('openlive:recording-history-request', { at, source: 'preferences-system' }, { activity: false });
  }

  function canonicaliseInitialState() {
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      Object.keys(models).forEach(domain => {
        preferences[domain] = clone(models[domain]);
        preferences.values = replaceProjection(preferences.values, domain, projectors[domain](models[domain]));
      });
      scrubRegistrationState(snapshot);
    }, { changedPath: 'preferences', reason: 'canonicalise-system-preferences' });
  }

  function subscribe() {
    Hub.subscribe('preferences.general', renderGeneral, { immediate: false });
    Hub.subscribe('preferences.recording', value => renderRecording(value), { immediate: false });
    Hub.subscribe('preferences.clipRendering', value => renderClipRendering(value), { immediate: false });
    Hub.subscribe('preferences.defaults', value => renderDefaults(value, false), { immediate: false });
    Hub.subscribe('preferences.feedback', renderFeedback, { immediate: false });
    Hub.subscribe('recording', value => renderRecorderRuntime(value), { immediate: false });
    Hub.subscribe('recordings.items', value => renderRecordingHistory(value), { immediate: false });
  }

  canonicaliseInitialState();
  renderGeneral(models.general);
  renderRecording(models.recording);
  renderRecorderRuntime(recorderRuntime);
  renderRecordingHistory(recordingHistory);
  renderClipRendering(models.clipRendering);
  renderDefaults(models.defaults, false);
  renderFeedback(models.feedback);
  bindGeneral();
  bindRecording();
  subscribe();
  bindRecorderBridge();
  bindClipRendering();
  bindDefaults();
  bindFeedback();
  bindRegistration();

  global.OpenLivePreferencesSystem = Object.freeze({
    version: VERSION,
    normalisers,
    normalizers: normalisers,
    projections: projectors,
    snapshot: () => clone(models),
    recording: Object.freeze({
      presets: () => clone(RECORDING_PRESETS),
      customPresets: () => clone(models.recording.customPresets),
      rules: () => clone(RECORDING_CODEC_RULES),
      configuration: () => clone(models.recording),
      runtime: () => clone(recorderRuntime),
      history: () => clone(recordingHistory),
      reportRuntime: reportRecorderRuntime,
      reportCompleted: reportRecordingCompleted,
      reportHistory: reportRecordingHistory
    }),
    safeDiagnostic: () => clone(safeDiagnostic()),
    hasSessionDirectoryHandle: id => directoryHandles.has(String(id || ''))
  });
})(window);
