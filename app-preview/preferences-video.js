/* OpenLive Video Preferences
   -------------------------------------------------------------------------
   Resolume-inspired FFGL startup roots and DMA texture preferences. Browser
   folder scans update OpenLive's shared Effects/Sources registry; native
   Resolume still validates and loads 64-bit FFGL binaries at startup.
   ------------------------------------------------------------------------- */
(() => {
  'use strict';

  const Hub = window.OpenLiveHub;
  if (!Hub || !document.querySelector('[data-video-managed]')) return;

  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const EXTRA_EFFECTS_ID = 'ffgl:extra-effects';
  const EXTRA_EFFECTS_PATH = 'Documents\\Resolume Arena\\Extra Effects';
  const TEMPORARY_MEDIA_ENDPOINT = '/api/dxv/temporary-media';
  const TEMPORARY_MEDIA_CATEGORIES = new Set(['staged', 'legacy']);
  const directoryHandles = new Map();
  let applying = false;
  const temporaryMediaState = {
    preview: null,
    current: false,
    selected: new Set(),
    loading: false,
    cleaning: false,
    changed: false,
    dialogOpen: false,
    opener: null,
    controller: null,
    requestSerial: 0,
    message: 'Temporary media has not been checked yet.',
    tone: 'warning'
  };

  function hash(value) {
    let result = 2166136261;
    String(value).toLowerCase().split('').forEach(character => {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    });
    return (result >>> 0).toString(36);
  }

  function cleanPath(path) {
    return String(path || '').trim().replace(/[\\/]+$/, '');
  }

  function directoryId(path) {
    return `ffgl:${hash(cleanPath(path))}`;
  }

  function defaultVideo() {
    return {
      ffgl: {
        directories: [{
          id: EXTRA_EFFECTS_ID, path: EXTRA_EFFECTS_PATH, automatic: true,
          removable: false, pluginCount: 0, scannedAt: 0, access: 'Always checked at startup'
        }],
        selectedId: EXTRA_EFFECTS_ID, selectedPluginId: null, plugins: [],
        needsRestart: false, lastScanAt: 0,
        baselineSignature: EXTRA_EFFECTS_PATH.toLowerCase()
      },
      dma: {
        mode: 'Force ON', effectiveMode: 'Force ON', customNvidiaProfile: false,
        gpuVendor: '', gpuRenderer: '', webglAvailable: false, isNvidia: false,
        needsRestart: false, baselineSignature: 'force on|0', profileStatus: 'Disabled'
      },
      updatedAt: 0
    };
  }

  function directorySignature(directories) {
    return (directories || []).map(item => cleanPath(item.path).toLowerCase())
      .filter(Boolean).sort().join('|');
  }

  function dmaSignature(dma) {
    return `${String(dma && dma.mode || 'Force ON').toLowerCase()}|${dma && dma.customNvidiaProfile ? 1 : 0}`;
  }

  function effectiveMode(mode, webglAvailable) {
    if (mode === 'Force OFF') return 'Force OFF';
    if (mode === 'Autodetect') return webglAvailable ? 'Detected ON' : 'Detected OFF';
    return 'Force ON';
  }

  function normaliseVideo(value) {
    const base = defaultVideo();
    const source = value || {};
    const video = Object.assign({}, base, source);
    video.ffgl = Object.assign({}, base.ffgl, source.ffgl || {});
    video.dma = Object.assign({}, base.dma, source.dma || {});
    video.ffgl.directories = Array.isArray(video.ffgl.directories) ? video.ffgl.directories : [];
    video.ffgl.plugins = Array.isArray(video.ffgl.plugins) ? video.ffgl.plugins : [];

    let automatic = video.ffgl.directories.find(item => item && (
      item.id === EXTRA_EFFECTS_ID || cleanPath(item.path).toLowerCase() === EXTRA_EFFECTS_PATH.toLowerCase()));
    if (!automatic) {
      automatic = clone(base.ffgl.directories[0]);
      video.ffgl.directories.unshift(automatic);
    }
    automatic.id = EXTRA_EFFECTS_ID;
    automatic.path = EXTRA_EFFECTS_PATH;
    automatic.automatic = true;
    automatic.removable = false;
    automatic.access = automatic.access || 'Always checked at startup';
    video.ffgl.directories = [automatic, ...video.ffgl.directories.filter(item => item !== automatic && item && item.id !== EXTRA_EFFECTS_ID)];

    if (!video.ffgl.directories.some(item => item.id === video.ffgl.selectedId)) video.ffgl.selectedId = EXTRA_EFFECTS_ID;
    if (!video.ffgl.plugins.some(item => item.id === video.ffgl.selectedPluginId)) video.ffgl.selectedPluginId = video.ffgl.plugins[0] && video.ffgl.plugins[0].id || null;
    if (!video.ffgl.baselineSignature) video.ffgl.baselineSignature = directorySignature(video.ffgl.directories);
    const rootsChanged = directorySignature(video.ffgl.directories) !== video.ffgl.baselineSignature;
    video.ffgl.needsRestart = !rootsChanged && !video.ffgl.lastScanAt && !video.ffgl.plugins.length
      ? false : rootsChanged || !!video.ffgl.needsRestart;

    if (!['Force ON', 'Force OFF', 'Autodetect'].includes(video.dma.mode)) video.dma.mode = 'Force ON';
    video.dma.customNvidiaProfile = !!video.dma.customNvidiaProfile;
    video.dma.webglAvailable = !!video.dma.webglAvailable;
    video.dma.isNvidia = !!video.dma.isNvidia;
    video.dma.effectiveMode = effectiveMode(video.dma.mode, video.dma.webglAvailable);
    if (!video.dma.baselineSignature) video.dma.baselineSignature = dmaSignature(video.dma);
    video.dma.needsRestart = dmaSignature(video.dma) !== video.dma.baselineSignature || !!video.dma.needsRestart;
    return video;
  }

  function flatProjection(video) {
    const selected = video.ffgl.directories.find(item => item.id === video.ffgl.selectedId);
    return {
      'video.freeframe-ffgl-plugin-directories.directory': selected && selected.path || EXTRA_EFFECTS_PATH,
      'video.freeframe-ffgl-plugin-directories.directories': video.ffgl.directories.map(item => item.path),
      'video.dma-textures.mode': video.dma.mode,
      'video.dma-textures.use-custom-nvidia-profile': !!video.dma.customNvidiaProfile
    };
  }

  function updateVideo(mutator, reason, key, options) {
    if (applying) return;
    let committed;
    Hub.transaction(snapshot => {
      const preferences = snapshot.preferences || (snapshot.preferences = {});
      const video = normaliseVideo(preferences.video);
      mutator(video);
      video.ffgl.needsRestart = directorySignature(video.ffgl.directories) !== video.ffgl.baselineSignature ||
        (!!video.ffgl.needsRestart && !(options && options.recalculateRestart));
      video.dma.effectiveMode = effectiveMode(video.dma.mode, video.dma.webglAvailable);
      video.dma.needsRestart = dmaSignature(video.dma) !== video.dma.baselineSignature;
      video.updatedAt = Date.now();
      preferences.video = video;
      preferences.values = Object.assign({}, preferences.values || {}, flatProjection(video));
      preferences.updatedAt = video.updatedAt;
      committed = clone(video);
    }, { changedPath: 'preferences.video', reason: reason || 'video-preference-change' });
    Hub.emit('openlive:preferences-changed', {
      section: 'video', key: key || reason, video: committed, values: flatProjection(committed)
    }, { activity: false });
    Hub.emit('openlive:video-preferences-changed', { video: committed, key: key || reason }, { activity: false });
  }

  function replaceOptions(control, items, value, labelOf, valueOf) {
    const wanted = String(value == null ? '' : value);
    control.replaceChildren(...items.map(item => new Option(
      labelOf ? labelOf(item) : String(item), valueOf ? valueOf(item) : String(item))));
    if ([...control.options].some(option => option.value === wanted)) control.value = wanted;
    else if (control.options.length) control.selectedIndex = 0;
  }

  function ffglStatus(video) {
    const node = $('ffglStatus');
    const enabled = video.ffgl.plugins.filter(plugin => plugin.enabled !== false);
    const effects = enabled.filter(plugin => plugin.kind !== 'source').length;
    const sources = enabled.filter(plugin => plugin.kind === 'source').length;
    const failed = video.ffgl.directories.filter(item => item.lastError).length;
    node.dataset.state = failed ? 'error' : video.ffgl.needsRestart ? 'warning' : 'ready';
    node.innerHTML = `<strong>${video.ffgl.directories.length} startup ${video.ffgl.directories.length === 1 ? 'root' : 'roots'} · ` +
      `${effects} custom ${effects === 1 ? 'effect' : 'effects'} · ${sources} custom ${sources === 1 ? 'source' : 'sources'}.</strong> ` +
      (video.ffgl.needsRestart
        ? '<span class="audio-restart">Restart native Resolume to validate and load 64-bit FFGL changes.</span> '
        : 'The Documents Extra Effects root is always checked at startup. ') +
      'Browser Rescan updates SHOWAVE’s Effects/Sources registry; it does not hot-load binaries into native Resolume.' +
      (failed ? `<br>${failed} folder ${failed === 1 ? 'scan needs' : 'scans need'} attention.` : '');
  }

  function dmaStatus(video) {
    const node = $('dmaStatus');
    const dma = video.dma;
    const fallback = dma.mode === 'Force OFF';
    const legacy = dma.mode === 'Autodetect';
    const profileWarning = dma.customNvidiaProfile && !dma.isNvidia;
    node.dataset.state = dma.needsRestart || fallback || legacy || profileWarning ? 'warning' : 'ready';
    const recommendation = fallback
      ? 'Force OFF is intended only for performance problems on older or lower-end GPUs.'
      : legacy ? 'Autodetect is a legacy mode and can choose incorrectly; Force ON is recommended.'
        : 'Force ON is Resolume’s recommended default.';
    const gpu = dma.gpuRenderer || dma.gpuVendor || 'Renderer identity unavailable';
    const profile = dma.customNvidiaProfile
      ? dma.isNvidia ? 'Custom NVIDIA profile requested.' : 'Custom NVIDIA profile requested, but this browser did not identify an NVIDIA renderer.'
      : 'Custom NVIDIA profile off.';
    node.innerHTML = `<strong>${esc(dma.mode)} · effective clone hint ${esc(dma.effectiveMode)}.</strong> ${esc(recommendation)}<br>` +
      `${esc(gpu)} · ${esc(profile)} ` +
      (dma.needsRestart
        ? '<span class="audio-restart">Restart native Resolume for the native DMA/profile preference to take effect.</span>'
        : 'Browser pages share this preference, but cannot alter native DMA transfers or driver profiles.');
  }

  function render(value) {
    const video = normaliseVideo(value || Hub.get('preferences.video'));
    applying = true;
    replaceOptions($('ffglDirectoryList'), video.ffgl.directories, video.ffgl.selectedId,
      item => `${item.automatic ? '◆ ' : ''}${item.path}${item.pluginCount ? ` (${item.pluginCount})` : ''}`,
      item => item.id);
    const selected = video.ffgl.directories.find(item => item.id === video.ffgl.selectedId) || video.ffgl.directories[0];
    if (selected && document.activeElement !== $('ffglDirectoryPath')) $('ffglDirectoryPath').value = selected.path;
    $('ffglRemoveDirectory').disabled = !selected || selected.automatic || selected.removable === false;
    $('ffglRescan').disabled = !selected;

    const plugins = video.ffgl.plugins.slice().sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.name).localeCompare(String(b.name)));
    if (plugins.length) {
      replaceOptions($('ffglPluginList'), plugins, video.ffgl.selectedPluginId,
        item => `${item.enabled === false ? '○' : '●'} ${item.kind === 'source' ? 'SOURCE' : 'EFFECT'} · ${item.name}`,
        item => item.id);
    } else {
      $('ffglPluginList').replaceChildren(new Option('No browser-discovered custom plugins', ''));
      $('ffglPluginList').selectedIndex = 0;
    }
    const selectedPlugin = plugins.find(item => item.id === (video.ffgl.selectedPluginId || $('ffglPluginList').value));
    $('ffglPluginKind').disabled = !selectedPlugin;
    $('ffglPluginKind').value = selectedPlugin && selectedPlugin.kind === 'source' ? 'source' : 'effect';
    $('ffglTogglePlugin').disabled = !selectedPlugin;
    $('ffglTogglePlugin').textContent = selectedPlugin && selectedPlugin.enabled === false ? 'Enable Plugin' : 'Disable Plugin';
    ffglStatus(video);

    $('dmaTextureMode').value = video.dma.mode;
    $('dmaNvidiaProfile').checked = !!video.dma.customNvidiaProfile;
    $('dmaNvidiaProfile').title = video.dma.isNvidia
      ? 'Requests native Resolume’s NVIDIA application profile on next startup.'
      : 'Only native Resolume on an NVIDIA system can create or repair this driver profile.';
    dmaStatus(video);
    document.documentElement.dataset.olDmaTextures = video.dma.mode.toLowerCase().replace(/\s+/g, '-');
    document.documentElement.dataset.olNvidiaProfile = video.dma.customNvidiaProfile ? 'requested' : 'off';
    applying = false;
  }

  function addDirectoryPath(path, metadata) {
    const cleaned = cleanPath(path);
    if (!cleaned) return;
    const id = cleaned.toLowerCase() === EXTRA_EFFECTS_PATH.toLowerCase() ? EXTRA_EFFECTS_ID : directoryId(cleaned);
    updateVideo(video => {
      const current = video.ffgl.directories.find(item => item.id === id);
      const record = Object.assign(current || {
        id, path: cleaned, automatic: id === EXTRA_EFFECTS_ID,
        removable: id !== EXTRA_EFFECTS_ID, pluginCount: 0, scannedAt: 0
      }, metadata || {}, { path: id === EXTRA_EFFECTS_ID ? EXTRA_EFFECTS_PATH : cleaned });
      if (!current) video.ffgl.directories.push(record);
      else Object.assign(current, record);
      video.ffgl.selectedId = id;
      video.ffgl.needsRestart = true;
    }, 'ffgl-directory-add', 'video.ffgl.directories');
  }

  function classifyPlugin(name) {
    return /(source|generator|synth|texture|input|capture|camera)/i.test(name) ? 'source' : 'effect';
  }

  async function scanHandle(handle, id) {
    const candidates = [];
    let inspected = 0;
    async function walk(directory, prefix, depth) {
      if (depth > 4 || inspected >= 1000) return;
      for await (const [name, entry] of directory.entries()) {
        inspected += 1;
        if (inspected > 1000) break;
        if (entry.kind === 'directory') {
          if (/\.bundle$/i.test(name)) candidates.push({ name: name.replace(/\.bundle$/i, ''), file: `${prefix}${name}`, extension: 'bundle' });
          else await walk(entry, `${prefix}${name}/`, depth + 1);
        } else if (/\.(dll|dylib)$/i.test(name)) {
          candidates.push({ name: name.replace(/\.(dll|dylib)$/i, ''), file: `${prefix}${name}`, extension: name.split('.').pop().toLowerCase() });
        }
      }
    }
    try {
      await walk(handle, '', 0);
      const records = candidates.map(candidate => ({
        id: `${id}:${hash(candidate.file)}`, name: candidate.name, label: candidate.name,
        kind: classifyPlugin(candidate.name), track: 'video', directoryId: id,
        file: candidate.file, extension: candidate.extension, enabled: true,
        compatibility: '64-bit architecture not verified by browser'
      }));
      updateVideo(video => {
        video.ffgl.plugins = video.ffgl.plugins.filter(plugin => plugin.directoryId !== id).concat(records);
        const directory = video.ffgl.directories.find(item => item.id === id);
        if (directory) Object.assign(directory, {
          pluginCount: records.length, scannedAt: Date.now(), lastError: '',
          access: 'Browser folder permission; native path may still need manual entry'
        });
        video.ffgl.lastScanAt = Date.now();
        video.ffgl.selectedPluginId = records[0] && records[0].id || video.ffgl.selectedPluginId;
        video.ffgl.needsRestart = true;
      }, 'ffgl-directory-scan', 'video.ffgl.plugins');
    } catch (error) {
      updateVideo(video => {
        const directory = video.ffgl.directories.find(item => item.id === id);
        if (directory) directory.lastError = error && error.message || 'Folder scan failed';
      }, 'ffgl-directory-scan-error', 'video.ffgl.directories');
    }
  }

  async function chooseDirectory() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const path = handle.name;
        const id = directoryId(path);
        directoryHandles.set(id, handle);
        addDirectoryPath(path, { id, access: 'Browser folder permission; enter the full native path if required' });
        await scanHandle(handle, id);
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    const path = window.prompt('FFGL startup directory path', $('ffglDirectoryPath').value || EXTRA_EFFECTS_PATH);
    if (path) addDirectoryPath(path);
  }

  async function rescanSelected() {
    const video = normaliseVideo(Hub.get('preferences.video'));
    const selected = video.ffgl.directories.find(item => item.id === video.ffgl.selectedId);
    if (!selected) return;
    const handle = directoryHandles.get(selected.id);
    if (handle) return scanHandle(handle, selected.id);
    if (window.showDirectoryPicker) {
      try {
        const replacement = await window.showDirectoryPicker({ mode: 'read' });
        directoryHandles.set(selected.id, replacement);
        return scanHandle(replacement, selected.id);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    updateVideo(state => {
      const directory = state.ffgl.directories.find(item => item.id === selected.id);
      if (directory) directory.lastError = 'Folder permission is required to inspect plugin candidates in this browser.';
      state.ffgl.needsRestart = true;
    }, 'ffgl-rescan-pending', 'video.ffgl.directories');
  }

  function detectGpu() {
    const result = { vendor: '', renderer: '', webglAvailable: false, isNvidia: false };
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' }) || canvas.getContext('webgl');
      if (!gl) return result;
      result.webglAvailable = true;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      result.vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      result.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      result.isNvidia = /nvidia|geforce|quadro|rtx|gtx/i.test(`${result.vendor} ${result.renderer}`);
    } catch (_) {}
    return result;
  }

  function temporaryCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function formatTemporaryBytes(value) {
    let bytes = temporaryCount(value);
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; }
    const digits = unit && bytes < 10 ? 1 : 0;
    return `${bytes.toFixed(digits)} ${units[unit]}`;
  }

  function temporaryFilesLabel(value) {
    const files = temporaryCount(value);
    return `${files} ${files === 1 ? 'file' : 'files'}`;
  }

  function normaliseTemporaryMediaPreview(value) {
    const source = value && typeof value === 'object' ? value : {};
    if (source.available !== true)
      throw new Error(source.error || 'SHOWAVE temporary media cleanup is unavailable.');
    const snapshot = String(source.snapshot || '').trim();
    if (!snapshot) throw new Error('The temporary media preview did not include a snapshot token.');
    const seen = new Set();
    const categories = (Array.isArray(source.categories) ? source.categories : []).reduce((records, item) => {
      const id = String(item && item.id || '');
      if (!TEMPORARY_MEDIA_CATEGORIES.has(id) || seen.has(id)) return records;
      seen.add(id);
      records.push({
        id,
        label: String(item.label || (id === 'staged' ? 'SHOWAVE staged media' : 'Legacy SHOWAVE media')),
        files: temporaryCount(item.files),
        bytes: temporaryCount(item.bytes)
      });
      return records;
    }, []);
    const total = source.total && typeof source.total === 'object' ? source.total : {};
    const protectedValue = source.protected && typeof source.protected === 'object' ? source.protected : {};
    return {
      available: true,
      snapshot,
      total: { files: temporaryCount(total.files), bytes: temporaryCount(total.bytes) },
      categories,
      protected: {
        files: temporaryCount(protectedValue.files),
        bytes: temporaryCount(protectedValue.bytes),
        activeFiles: temporaryCount(protectedValue.activeFiles),
        recentFiles: temporaryCount(protectedValue.recentFiles),
        sources: temporaryCount(protectedValue.sources),
        sessions: temporaryCount(protectedValue.sessions),
        sourceBytes: temporaryCount(protectedValue.sourceBytes)
      }
    };
  }

  async function temporaryMediaJSON(response) {
    let value;
    try { value = await response.json(); }
    catch (_) { throw new Error(`Temporary media service returned an unreadable response (${response.status}).`); }
    if (!value || typeof value !== 'object')
      throw new Error(`Temporary media service returned an invalid response (${response.status}).`);
    return value;
  }

  async function requestTemporaryMediaPreview(signal) {
    const response = await fetch(TEMPORARY_MEDIA_ENDPOINT, {
      method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal
    });
    const value = await temporaryMediaJSON(response);
    if (!response.ok) throw new Error(value.error || `Temporary media preview failed (${response.status}).`);
    return normaliseTemporaryMediaPreview(value);
  }

  function selectedTemporaryMedia() {
    const preview = temporaryMediaState.preview;
    const categories = preview ? preview.categories.filter(category =>
      category.files > 0 && temporaryMediaState.selected.has(category.id)) : [];
    return {
      categories: categories.map(category => category.id),
      files: categories.reduce((total, category) => total + category.files, 0),
      bytes: categories.reduce((total, category) => total + category.bytes, 0)
    };
  }

  function renderTemporaryMediaSummary() {
    const preview = temporaryMediaState.preview;
    const summary = $('temporaryMediaSummary');
    const status = $('temporaryMediaStatus');
    const refresh = $('temporaryMediaRefresh');
    const review = $('temporaryMediaReview');
    if (!summary || !status || !refresh || !review) return;
    if (temporaryMediaState.loading) summary.textContent = 'Checking local temporary media…';
    else if (preview) summary.textContent = preview.total.files
      ? `${temporaryFilesLabel(preview.total.files)} · ${formatTemporaryBytes(preview.total.bytes)}`
      : 'No removable temporary media';
    else summary.textContent = 'Preview unavailable';
    status.textContent = temporaryMediaState.message;
    status.dataset.state = temporaryMediaState.tone === 'error' ? 'error'
      : temporaryMediaState.tone === 'ready' ? 'ready' : 'warning';
    refresh.disabled = temporaryMediaState.loading || temporaryMediaState.cleaning;
    review.disabled = temporaryMediaState.loading || temporaryMediaState.cleaning;
    review.textContent = preview && preview.total.files
      ? `Review & Clean ${temporaryFilesLabel(preview.total.files)}…` : 'Review & Clean…';
  }

  function setTemporaryMediaDialogStatus(message, state) {
    const status = $('temporaryMediaDialogStatus');
    const dialog = $('temporaryMediaCleanupDialog');
    if (status) { status.textContent = message; status.dataset.state = state || 'ready'; }
    if (dialog) dialog.dataset.state = state || 'ready';
  }

  function renderTemporaryMediaDialog(resetSelections) {
    const preview = temporaryMediaState.preview;
    const categories = $('temporaryMediaCategories');
    const total = $('temporaryMediaDialogTotal');
    const protectedNode = $('temporaryMediaProtected');
    const confirm = $('temporaryMediaConfirm');
    const cancel = $('temporaryMediaCancel');
    const close = $('temporaryMediaClose');
    const dialog = $('temporaryMediaCleanupDialog');
    if (!categories || !total || !protectedNode || !confirm || !cancel || !close || !dialog) return;

    if (preview && resetSelections) {
      temporaryMediaState.selected.clear();
      preview.categories.forEach(category => { if (category.files > 0) temporaryMediaState.selected.add(category.id); });
    } else if (preview) {
      const present = new Set(preview.categories.map(category => category.id));
      [...temporaryMediaState.selected].forEach(id => { if (!present.has(id)) temporaryMediaState.selected.delete(id); });
    }

    const legend = document.createElement('legend');
    legend.textContent = 'Select categories';
    const nodes = [legend];
    if (!preview || !preview.categories.length) {
      const empty = document.createElement('div');
      empty.className = 'temporary-media-empty';
      empty.textContent = temporaryMediaState.loading
        ? 'Checking temporary media…' : 'No removable SHOWAVE category was reported.';
      nodes.push(empty);
    } else preview.categories.forEach(category => {
      const label = document.createElement('label');
      label.className = 'temporary-media-category';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'temporaryMediaCategories';
      input.value = category.id;
      input.checked = temporaryMediaState.selected.has(category.id);
      input.disabled = category.files === 0 || temporaryMediaState.loading || temporaryMediaState.cleaning;
      input.addEventListener('change', () => {
        if (input.checked) temporaryMediaState.selected.add(category.id);
        else temporaryMediaState.selected.delete(category.id);
        renderTemporaryMediaDialog(false);
      });
      const name = document.createElement('span');
      name.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'temporary-media-category-count';
      count.textContent = `${temporaryFilesLabel(category.files)} · ${formatTemporaryBytes(category.bytes)}`;
      label.append(input, name, count);
      nodes.push(label);
    });
    categories.replaceChildren(...nodes);

    const selected = selectedTemporaryMedia();
    total.textContent = `${temporaryFilesLabel(selected.files)} · ${formatTemporaryBytes(selected.bytes)}`;
    const protectedMedia = preview && preview.protected;
    protectedNode.textContent = protectedMedia
      ? `Protected from cleanup: ${temporaryFilesLabel(protectedMedia.files)} · ${formatTemporaryBytes(protectedMedia.bytes)}. ` +
        `${protectedMedia.activeFiles} active, ${protectedMedia.recentFiles} recent, ${protectedMedia.sources} ` +
        `${protectedMedia.sources === 1 ? 'source' : 'sources'} across ${protectedMedia.sessions} ` +
        `${protectedMedia.sessions === 1 ? 'session' : 'sessions'} · ${formatTemporaryBytes(protectedMedia.sourceBytes)} source media.`
      : 'Protected working media will be reported separately.';

    const busy = temporaryMediaState.loading || temporaryMediaState.cleaning;
    confirm.textContent = `Clean ${temporaryFilesLabel(selected.files)}`;
    confirm.dataset.fileCount = String(selected.files);
    confirm.disabled = busy || !temporaryMediaState.current || !preview || !preview.snapshot || selected.files === 0;
    cancel.disabled = temporaryMediaState.cleaning;
    close.disabled = temporaryMediaState.cleaning;
    categories.disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
  }

  function previewTemporaryMediaMessage(preview) {
    if (!preview.total.files)
      return `No removable SHOWAVE temporary media was found. ${temporaryFilesLabel(preview.protected.files)} remain protected.`;
    return `${temporaryFilesLabel(preview.total.files)} (${formatTemporaryBytes(preview.total.bytes)}) can be removed. ` +
      `${temporaryFilesLabel(preview.protected.files)} remain protected.`;
  }

  async function refreshTemporaryMedia(options) {
    options = options || {};
    if (temporaryMediaState.cleaning) return null;
    if (temporaryMediaState.controller) temporaryMediaState.controller.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const serial = ++temporaryMediaState.requestSerial;
    temporaryMediaState.controller = controller;
    temporaryMediaState.loading = true;
    temporaryMediaState.current = false;
    temporaryMediaState.message = 'Checking SHOWAVE-owned temporary media…';
    temporaryMediaState.tone = 'warning';
    renderTemporaryMediaSummary();
    if (temporaryMediaState.dialogOpen) {
      renderTemporaryMediaDialog(false);
      setTemporaryMediaDialogStatus('Checking SHOWAVE-owned temporary media…', 'busy');
    }
    try {
      const preview = await requestTemporaryMediaPreview(controller && controller.signal);
      if (serial !== temporaryMediaState.requestSerial) return null;
      temporaryMediaState.preview = preview;
      temporaryMediaState.current = true;
      temporaryMediaState.changed = false;
      temporaryMediaState.message = previewTemporaryMediaMessage(preview);
      temporaryMediaState.tone = 'ready';
      temporaryMediaState.loading = false;
      renderTemporaryMediaSummary();
      if (temporaryMediaState.dialogOpen) {
        renderTemporaryMediaDialog(options.resetSelections !== false);
        setTemporaryMediaDialogStatus(preview.total.files
          ? 'Preview current. Choose the categories to remove, then confirm the exact file count shown.'
          : 'No removable SHOWAVE temporary media was found.', 'ready');
      }
      return preview;
    } catch (error) {
      if (serial !== temporaryMediaState.requestSerial || (error && error.name === 'AbortError')) return null;
      const message = error && error.message || String(error);
      temporaryMediaState.loading = false;
      temporaryMediaState.current = false;
      temporaryMediaState.message = `Temporary media preview failed: ${message}`;
      temporaryMediaState.tone = 'error';
      renderTemporaryMediaSummary();
      if (temporaryMediaState.dialogOpen) {
        renderTemporaryMediaDialog(false);
        setTemporaryMediaDialogStatus(`Preview failed: ${message}`, 'error');
      }
      return null;
    } finally {
      if (temporaryMediaState.controller === controller) temporaryMediaState.controller = null;
    }
  }

  function openTemporaryMediaCleanup(event) {
    const overlay = $('temporaryMediaCleanupOverlay');
    const dialog = $('temporaryMediaCleanupDialog');
    if (!overlay || !dialog || temporaryMediaState.cleaning) return;
    temporaryMediaState.opener = event && event.currentTarget || document.activeElement;
    temporaryMediaState.dialogOpen = true;
    temporaryMediaState.changed = false;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    renderTemporaryMediaDialog(true);
    setTemporaryMediaDialogStatus('Checking SHOWAVE-owned temporary media…', 'busy');
    $('temporaryMediaCancel').focus({ preventScroll: true });
    refreshTemporaryMedia({ resetSelections: true });
  }

  function closeTemporaryMediaCleanup() {
    if (temporaryMediaState.cleaning) return false;
    const overlay = $('temporaryMediaCleanupOverlay');
    if (!overlay || !temporaryMediaState.dialogOpen) return false;
    if (temporaryMediaState.controller) temporaryMediaState.controller.abort();
    temporaryMediaState.requestSerial += 1;
    temporaryMediaState.controller = null;
    temporaryMediaState.loading = false;
    temporaryMediaState.current = false;
    temporaryMediaState.dialogOpen = false;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    temporaryMediaState.message = temporaryMediaState.preview
      ? 'Preview refresh was cancelled. Open Review & Clean to check again before cleaning.'
      : 'Temporary media preview was cancelled.';
    temporaryMediaState.tone = 'warning';
    renderTemporaryMediaSummary();
    const opener = temporaryMediaState.opener;
    temporaryMediaState.opener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    return true;
  }

  async function cleanTemporaryMedia() {
    const preview = temporaryMediaState.preview;
    const selected = selectedTemporaryMedia();
    if (!preview || !temporaryMediaState.current || temporaryMediaState.loading || temporaryMediaState.cleaning || !selected.files) return false;
    if (temporaryMediaState.controller) temporaryMediaState.controller.abort();
    temporaryMediaState.requestSerial += 1;
    temporaryMediaState.controller = null;
    temporaryMediaState.loading = false;
    temporaryMediaState.cleaning = true;
    temporaryMediaState.changed = false;
    temporaryMediaState.message = `Cleaning ${temporaryFilesLabel(selected.files)} of SHOWAVE-owned temporary media…`;
    temporaryMediaState.tone = 'warning';
    renderTemporaryMediaSummary();
    renderTemporaryMediaDialog(false);
    setTemporaryMediaDialogStatus(`Cleaning ${temporaryFilesLabel(selected.files)}…`, 'busy');

    let finalMessage = '';
    let finalState = 'ready';
    try {
      const response = await fetch(`${TEMPORARY_MEDIA_ENDPOINT}/cleanup`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: preview.snapshot, categories: selected.categories })
      });
      const value = await temporaryMediaJSON(response);
      if (response.status === 409) {
        if (!value.preview) throw new Error(value.error || 'The cleanup preview changed. Refresh and try again.');
        const changedPreview = normaliseTemporaryMediaPreview(value.preview);
        temporaryMediaState.preview = changedPreview;
        temporaryMediaState.current = true;
        temporaryMediaState.changed = true;
        const present = new Set(changedPreview.categories.map(category => category.id));
        [...temporaryMediaState.selected].forEach(id => { if (!present.has(id)) temporaryMediaState.selected.delete(id); });
        finalMessage = `${value.error || 'Temporary media changed while this dialog was open.'} ` +
          'Review the updated counts, then confirm again.';
        finalState = 'changed';
        temporaryMediaState.message = finalMessage;
        temporaryMediaState.tone = 'warning';
        return false;
      }
      if (!response.ok) throw new Error(value.error || `Temporary media cleanup failed (${response.status}).`);

      let responsePreview = null;
      if (value.preview) responsePreview = normaliseTemporaryMediaPreview(value.preview);
      temporaryMediaState.current = !!responsePreview;
      if (responsePreview) temporaryMediaState.preview = responsePreview;
      const removed = value.removed && typeof value.removed === 'object' ? value.removed : {};
      const removedFiles = temporaryCount(removed.files);
      const removedBytes = temporaryCount(removed.bytes);
      const failed = (Array.isArray(value.failed) ? value.failed : []).map(item => ({
        category: String(item && item.category || ''), name: String(item && item.name || '')
      }));

      let refreshError = '';
      try {
        /* The POST preview is useful immediately, but a new GET is authoritative:
           it also catches files created while cleanup itself was running. */
        temporaryMediaState.preview = await requestTemporaryMediaPreview();
        temporaryMediaState.current = true;
      } catch (error) {
        refreshError = error && error.message || String(error);
      }
      temporaryMediaState.selected.clear();
      if (temporaryMediaState.preview)
        temporaryMediaState.preview.categories.forEach(category => {
          if (category.files > 0) temporaryMediaState.selected.add(category.id);
        });

      const removedText = removedFiles
        ? `Removed ${temporaryFilesLabel(removedFiles)} (${formatTemporaryBytes(removedBytes)}).`
        : 'No temporary media was removed.';
      const failureNames = failed.map(item => item.name || item.category || 'unknown item').slice(0, 3).join(', ');
      const failedText = failed.length
        ? ` ${temporaryFilesLabel(failed.length)} could not be removed${failureNames ? `: ${failureNames}` : ''}.`
        : '';
      const refreshText = refreshError ? ` The refreshed preview failed: ${refreshError}` : '';
      finalMessage = removedText + failedText + refreshText;
      finalState = failed.length || refreshError ? 'error' : 'ready';
      temporaryMediaState.message = finalMessage;
      temporaryMediaState.tone = finalState === 'ready' ? 'ready' : 'error';
      return failed.length === 0;
    } catch (error) {
      temporaryMediaState.current = false;
      finalMessage = `Cleanup failed: ${error && error.message || String(error)}`;
      finalState = 'error';
      temporaryMediaState.message = finalMessage;
      temporaryMediaState.tone = 'error';
      return false;
    } finally {
      temporaryMediaState.cleaning = false;
      renderTemporaryMediaSummary();
      if (temporaryMediaState.dialogOpen) {
        renderTemporaryMediaDialog(false);
        setTemporaryMediaDialogStatus(finalMessage || temporaryMediaState.message, finalState);
      }
    }
  }

  function trapTemporaryMediaDialog(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTemporaryMediaCleanup();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = $('temporaryMediaCleanupDialog');
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
      .filter(node => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function migrateLegacyValues() {
    const source = Hub.get('preferences.video', null);
    const values = Hub.get('preferences.values', {}) || {};
    if (source && Number(source.updatedAt) > 0) return;
    const oldPath = values['video.freeframe-ffgl-plugin-directories.directory'];
    const oldMode = values['video.dma-textures.mode'];
    const oldProfile = values['video.dma-textures.use-custom-nvidia-profile'];
    if (oldPath == null && oldMode == null && oldProfile == null) return;
    updateVideo(video => {
      if (oldPath && cleanPath(oldPath).toLowerCase() !== EXTRA_EFFECTS_PATH.toLowerCase()) {
        const id = directoryId(oldPath);
        video.ffgl.directories.push({ id, path: cleanPath(oldPath), removable: true, pluginCount: 0, scannedAt: 0 });
        video.ffgl.selectedId = id;
      }
      if (['Force ON', 'Force OFF', 'Autodetect'].includes(oldMode)) video.dma.mode = oldMode;
      if (oldProfile != null) video.dma.customNvidiaProfile = !!oldProfile;
    }, 'video-preferences-migrate', 'video');
  }

  function ensureBaselineAndGpu() {
    const current = normaliseVideo(Hub.get('preferences.video'));
    const gpu = detectGpu();
    const changed = current.dma.gpuVendor !== gpu.vendor || current.dma.gpuRenderer !== gpu.renderer ||
      current.dma.webglAvailable !== gpu.webglAvailable || current.dma.isNvidia !== gpu.isNvidia ||
      !current.ffgl.baselineSignature || !current.dma.baselineSignature;
    if (!changed) return render(current);
    updateVideo(video => {
      if (!video.ffgl.baselineSignature) video.ffgl.baselineSignature = directorySignature(video.ffgl.directories);
      if (!video.dma.baselineSignature) video.dma.baselineSignature = dmaSignature(video.dma);
      Object.assign(video.dma, {
        gpuVendor: gpu.vendor, gpuRenderer: gpu.renderer,
        webglAvailable: gpu.webglAvailable, isNvidia: gpu.isNvidia,
        profileStatus: video.dma.customNvidiaProfile ? 'Requested for native startup' : 'Disabled'
      });
    }, 'video-gpu-detect', 'video.dma.gpu');
  }

  migrateLegacyValues();
  ensureBaselineAndGpu();

  $('ffglDirectoryList').addEventListener('change', event => updateVideo(video => {
    video.ffgl.selectedId = event.target.value;
  }, 'ffgl-directory-select', 'video.ffgl.selectedId'));
  $('ffglDirectoryPath').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addDirectoryPath(event.target.value); }
  });
  $('ffglAddPath').addEventListener('click', () => addDirectoryPath($('ffglDirectoryPath').value));
  $('ffglAddDirectory').addEventListener('click', chooseDirectory);
  $('ffglRemoveDirectory').addEventListener('click', () => updateVideo(video => {
    const id = video.ffgl.selectedId;
    const selected = video.ffgl.directories.find(item => item.id === id);
    if (!selected || selected.automatic || selected.removable === false) return;
    video.ffgl.directories = video.ffgl.directories.filter(item => item.id !== id);
    video.ffgl.plugins = video.ffgl.plugins.filter(plugin => plugin.directoryId !== id);
    video.ffgl.selectedId = EXTRA_EFFECTS_ID;
    video.ffgl.selectedPluginId = video.ffgl.plugins[0] && video.ffgl.plugins[0].id || null;
    video.ffgl.needsRestart = directorySignature(video.ffgl.directories) !== video.ffgl.baselineSignature;
    directoryHandles.delete(id);
  }, 'ffgl-directory-remove', 'video.ffgl.directories'));
  $('ffglRescan').addEventListener('click', rescanSelected);
  $('ffglPluginList').addEventListener('change', event => updateVideo(video => {
    video.ffgl.selectedPluginId = event.target.value || null;
  }, 'ffgl-plugin-select', 'video.ffgl.selectedPluginId'));
  $('ffglPluginKind').addEventListener('change', event => updateVideo(video => {
    const plugin = video.ffgl.plugins.find(item => item.id === video.ffgl.selectedPluginId);
    if (plugin) plugin.kind = event.target.value === 'source' ? 'source' : 'effect';
  }, 'ffgl-plugin-kind', 'video.ffgl.plugins'));
  $('ffglTogglePlugin').addEventListener('click', () => updateVideo(video => {
    const plugin = video.ffgl.plugins.find(item => item.id === video.ffgl.selectedPluginId);
    if (plugin) plugin.enabled = plugin.enabled === false;
  }, 'ffgl-plugin-toggle', 'video.ffgl.plugins'));

  $('dmaTextureMode').addEventListener('change', event => updateVideo(video => {
    video.dma.mode = event.target.value;
  }, 'dma-texture-mode', 'video.dma.mode'));
  $('dmaNvidiaProfile').addEventListener('change', event => updateVideo(video => {
    video.dma.customNvidiaProfile = event.target.checked;
    video.dma.profileStatus = event.target.checked ? 'Requested for native startup' : 'Disabled';
  }, 'nvidia-profile', 'video.dma.customNvidiaProfile'));
  $('dmaResetRecommended').addEventListener('click', () => updateVideo(video => {
    video.dma.mode = 'Force ON';
    video.dma.customNvidiaProfile = false;
    video.dma.profileStatus = 'Disabled';
  }, 'video-recommended-reset', 'video.dma'));

  $('temporaryMediaRefresh').addEventListener('click', () => refreshTemporaryMedia());
  $('temporaryMediaReview').addEventListener('click', openTemporaryMediaCleanup);
  $('temporaryMediaCancel').addEventListener('click', closeTemporaryMediaCleanup);
  $('temporaryMediaClose').addEventListener('click', closeTemporaryMediaCleanup);
  $('temporaryMediaConfirm').addEventListener('click', cleanTemporaryMedia);
  $('temporaryMediaCleanupDialog').addEventListener('keydown', trapTemporaryMediaDialog);
  /* preferences.html has a generic click-the-scrim-to-close listener.  A
     destructive alertdialog deliberately closes only through Cancel/Escape;
     capture wins before that generic bubble listener can hide it. */
  $('temporaryMediaCleanupOverlay').addEventListener('mousedown', event => {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  Hub.subscribe('preferences.video', video => render(video));
  window.OpenLiveVideoPreferences = Object.freeze({
    get: () => normaliseVideo(Hub.get('preferences.video')),
    rescan: rescanSelected,
    addDirectory: addDirectoryPath,
    refreshTemporaryMedia,
    openTemporaryMediaCleanup
  });
  refreshTemporaryMedia();
})();
