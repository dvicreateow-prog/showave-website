/* ===========================================================================
   openlive-graphics.js — reusable programme graphics for SHOWAVE Studio.

   The asset browser and the programme output deliberately have separate state.
   Selecting another folder only changes what the operator is browsing; it never
   replaces or hides a logo, overlay, or background that is already on air.

   Classic script. Publishes window.OpenLiveGraphics. No network or libraries.
   =========================================================================== */
window.OpenLiveGraphics = (() => {
  'use strict';

  const version = 3;
  const STORE = 'showave.studio.graphics.v1';
  const DEFAULT_SCOPE = 'standalone:default';
  const SYNC_CHANNEL = 'showave-studio-graphics-v1';
  const TYPES = Object.freeze(['logo', 'overlay', 'background']);
  const CORNERS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  const MAX_FOLDERS = 10;
  const MAX_ASSETS_PER_TYPE = 50;
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024;
  const MAX_NAME = 80;
  const MAX_FILE_NAME = 255;
  const MAX_ALT_TEXT = 240;
  const MAX_DIMENSION = 32768;
  const MAX_PROGRAMME_SCOPES = 128;
  const DEFAULT_LOGO_SCALE = .18;
  const MIN_LOGO_SCALE = .05;
  const MAX_LOGO_SCALE = .5;
  const listeners = new Set();
  const imageCache = new Map();
  let state = emptyState();
  let currentScope = DEFAULT_SCOPE;
  let lastEncoded = '';
  let syncChannel = null;
  let lastError = '';

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const copy = value => JSON.parse(JSON.stringify(value));
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  function emptyState() {
    return {
      version,
      folders: [],
      assets: [],
      selectedFolderId: null,
      showDefaultGraphics: true,
      activeAssetIdsByScope: {},
      sceneAssetIdsByScope: {}
    };
  }

  function blankActiveIds() {
    return { logo:null, overlay:null, background:null };
  }

  function newId(kind) {
    try {
      if (crypto && crypto.randomUUID) return 'graphics-' + kind + '-' + crypto.randomUUID();
    } catch (_) {}
    return 'graphics-' + kind + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  function safeId(value) {
    const id = clean(value, 128);
    return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : '';
  }

  /* Scope names may originate in a saved Broadcast Screen id or a standalone
     Stream Card id. Keep them stable and safe as object keys without silently
     collapsing punctuation-heavy ids onto the default programme. */
  function sanitizeScope(value) {
    const raw = clean(value, 128);
    if (!raw) return DEFAULT_SCOPE;
    let scope = '';
    for (const character of raw) {
      scope += /^[A-Za-z0-9_.:-]$/.test(character)
        ? character : '_' + character.codePointAt(0).toString(16) + '_';
      if (scope.length >= 192) break;
    }
    scope = scope.slice(0, 192);
    if (!scope) return DEFAULT_SCOPE;
    if (scope === '__proto__' || scope === 'prototype' || scope === 'constructor')
      scope = 'scope-' + scope;
    return scope;
  }

  const syncSource = newId('client');

  function validText(value, label, maximum, required) {
    const raw = String(value == null ? '' : value);
    if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw))
      throw new Error(label + ' contains unsupported control characters.');
    const text = raw.trim();
    if (required && !text) throw new Error('Enter ' + label.toLowerCase() + '.');
    if (text.length > maximum)
      throw new Error(label + ' must be ' + maximum.toLocaleString() + ' characters or fewer.');
    return text;
  }

  function canonicalMime(value) {
    const mime = String(value == null ? '' : value).trim().toLowerCase();
    if (mime === 'image/jpg') return 'image/jpeg';
    return mime;
  }

  function imageData(value) {
    const source = String(value == null ? '' : value).trim();
    const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
    if (!match || match[2].length % 4 !== 0)
      throw new Error('Choose a PNG, JPEG, WebP, or GIF image data URL.');
    const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0;
    const byteLength = match[2].length * 3 / 4 - padding;
    if (!byteLength) throw new Error('The image data URL is empty.');
    if (byteLength > MAX_IMAGE_BYTES)
      throw new Error('The image must be 25 MB or smaller.');
    return {
      dataUrl:source,
      mimeType:canonicalMime(match[1]),
      byteLength
    };
  }

  function dimension(value, label) {
    if (value == null || value === '') return 0;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > MAX_DIMENSION)
      throw new Error(label + ' must be a whole number from 1 to ' + MAX_DIMENSION.toLocaleString() + '.');
    return number;
  }

  function logoScale(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < MIN_LOGO_SCALE || number > MAX_LOGO_SCALE)
      throw new Error('Logo scale must be between ' + MIN_LOGO_SCALE + ' and ' + MAX_LOGO_SCALE + '.');
    return number;
  }

  function normalizeFolder(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      id:safeId(source.id) || newId('folder'),
      name:clean(source.name, MAX_NAME) || 'Untitled folder',
      createdAt:finite(source.createdAt) || Date.now(),
      updatedAt:finite(source.updatedAt) || finite(source.createdAt) || Date.now()
    };
  }

  function normalizeAsset(raw, folderIds) {
    const source = raw && typeof raw === 'object' ? raw : {};
    if (!TYPES.includes(source.type)) return null;
    const folderId = safeId(source.folderId);
    if (!folderIds.has(folderId)) return null;
    let data;
    try { data = imageData(source.imageDataUrl); } catch (_) { return null; }
    let width = 0, height = 0;
    try {
      width = dimension(source.width, 'Image width');
      height = dimension(source.height, 'Image height');
    } catch (_) {}
    if (!width || !height) { width = 0; height = 0; }
    const corner = source.type === 'logo' && CORNERS.includes(source.corner)
      ? source.corner : source.type === 'logo' ? 'top-right' : '';
    const suppliedScale = Number(source.scale);
    const scale = source.type === 'logo' && Number.isFinite(suppliedScale)
      ? Math.max(MIN_LOGO_SCALE, Math.min(MAX_LOGO_SCALE, suppliedScale))
      : source.type === 'logo' ? DEFAULT_LOGO_SCALE : 0;
    return {
      id:safeId(source.id) || newId('asset'),
      folderId,
      type:source.type,
      name:clean(source.name, MAX_NAME) || source.type[0].toUpperCase() + source.type.slice(1),
      fileName:clean(source.fileName, MAX_FILE_NAME),
      altText:clean(source.altText, MAX_ALT_TEXT),
      imageDataUrl:data.dataUrl,
      mimeType:data.mimeType,
      byteLength:data.byteLength,
      width,
      height,
      corner,
      scale,
      createdAt:finite(source.createdAt) || Date.now(),
      updatedAt:finite(source.updatedAt) || finite(source.createdAt) || Date.now()
    };
  }

  function normalizeActiveIds(raw, assets) {
    const next = blankActiveIds();
    const source = raw && typeof raw === 'object' ? raw : {};
    TYPES.forEach(type => {
      const id = safeId(source[type]);
      const builtin = preset(id);
      next[type] = assets.some(asset => asset.id === id && asset.type === type) ||
        (builtin && builtin.type === type) ? id : null;
    });
    return next;
  }

  function hasActiveIds(ids) {
    return TYPES.some(type => ids && ids[type]);
  }

  function preset(id) {
    const catalog = window.OpenLiveGraphicsPresets;
    return catalog && catalog.get(String(id || '')) || null;
  }

  function sceneKey(options) {
    const id = options && options.sceneId;
    return id == null || String(id) === '' ? null : sanitizeScope(id);
  }

  function activeIdsIn(source, scope, options) {
    const sceneId = sceneKey(options), scopeId = sanitizeScope(scope);
    const scenes = source && source.sceneAssetIdsByScope && source.sceneAssetIdsByScope[scopeId];
    if (sceneId && scenes && own(scenes, sceneId)) return scenes[sceneId];
    const rows = source && source.activeAssetIdsByScope;
    const found = rows && typeof rows === 'object' ? rows[scopeId] : null;
    return found && typeof found === 'object' ? found : blankActiveIds();
  }

  function draftState() { return copy(state); }

  function setDraftActive(next, type, id, options, scope = currentScope) {
    const sceneId = sceneKey(options);
    if (sceneId) {
      const ids = Object.assign(blankActiveIds(), activeIdsIn(next, scope, options));
      ids[type] = id || null;
      if (!next.sceneAssetIdsByScope) next.sceneAssetIdsByScope = {};
      const scopes = Object.keys(next.sceneAssetIdsByScope);
      if (!own(next.sceneAssetIdsByScope, scope) && scopes.length >= MAX_PROGRAMME_SCOPES)
        throw new Error('The saved graphics scene limit is reached. Remove unused show graphics first.');
      const scenes = next.sceneAssetIdsByScope[scope] || {};
      if (!own(scenes, sceneId) && Object.keys(scenes).length >= MAX_PROGRAMME_SCOPES)
        throw new Error('The saved graphics scene limit is reached. Remove an unused scene first.');
      scenes[sceneId] = ids;
      next.sceneAssetIdsByScope[scope] = scenes;
      return;
    }
    if (!next.activeAssetIdsByScope || typeof next.activeAssetIdsByScope !== 'object')
      next.activeAssetIdsByScope = {};
    const ids = Object.assign(blankActiveIds(), activeIdsIn(next, currentScope));
    ids[type] = id || null;
    if (hasActiveIds(ids)) {
      if (!own(next.activeAssetIdsByScope, currentScope)) {
        const scopes = Object.keys(next.activeAssetIdsByScope);
        if (scopes.length >= MAX_PROGRAMME_SCOPES) {
          const stale = scopes.find(scope => scope !== DEFAULT_SCOPE) || scopes[0];
          if (stale) delete next.activeAssetIdsByScope[stale];
        }
      }
      next.activeAssetIdsByScope[currentScope] = ids;
    }
    else delete next.activeAssetIdsByScope[currentScope];
  }

  function normalizeState(raw) {
    const next = emptyState();
    if (!raw || typeof raw !== 'object') return next;
    next.showDefaultGraphics = raw.showDefaultGraphics !== false;

    const folderIds = new Set();
    if (Array.isArray(raw.folders)) raw.folders.slice(0, MAX_FOLDERS).forEach(item => {
      const folder = normalizeFolder(item);
      if (folderIds.has(folder.id)) folder.id = newId('folder');
      folderIds.add(folder.id);
      next.folders.push(folder);
    });

    const assetIds = new Set();
    const counts = { logo:0, overlay:0, background:0 };
    if (Array.isArray(raw.assets)) raw.assets.forEach(item => {
      const asset = normalizeAsset(item, folderIds);
      if (!asset || counts[asset.type] >= MAX_ASSETS_PER_TYPE) return;
      if (assetIds.has(asset.id)) asset.id = newId('asset');
      assetIds.add(asset.id);
      counts[asset.type]++;
      next.assets.push(asset);
    });

    const selected = safeId(raw.selectedFolderId);
    next.selectedFolderId = folderIds.has(selected)
      ? selected : next.folders.length ? next.folders[0].id : null;

    const persistedScopes = raw.activeAssetIdsByScope &&
      typeof raw.activeAssetIdsByScope === 'object' && !Array.isArray(raw.activeAssetIdsByScope)
      ? raw.activeAssetIdsByScope : null;
    if (persistedScopes) {
      Object.keys(persistedScopes).slice(0, MAX_PROGRAMME_SCOPES).forEach(rawScope => {
        const scope = sanitizeScope(rawScope);
        if (own(next.activeAssetIdsByScope, scope)) return;
        const ids = normalizeActiveIds(persistedScopes[rawScope], next.assets);
        if (hasActiveIds(ids)) next.activeAssetIdsByScope[scope] = ids;
      });
    } else {
      /* Version 1 had one global programme selection. It belongs only to the
         legacy standalone card; a Map-linked card must start clean instead of
         unexpectedly inheriting another show's on-air brand. */
      const legacy = normalizeActiveIds(raw.activeAssetIds, next.assets);
      if (hasActiveIds(legacy)) next.activeAssetIdsByScope[DEFAULT_SCOPE] = legacy;
    }
    const sceneScopes = raw.sceneAssetIdsByScope;
    if (sceneScopes && typeof sceneScopes === 'object' && !Array.isArray(sceneScopes)) {
      Object.keys(sceneScopes).slice(0, MAX_PROGRAMME_SCOPES).forEach(scope => {
        const rows = sceneScopes[scope];
        if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return;
        const scenes = {};
        Object.keys(rows).slice(0, MAX_PROGRAMME_SCOPES).forEach(id => {
          // Explicit empty selections mask legacy show-wide graphics in this scene.
          scenes[sanitizeScope(id)] = normalizeActiveIds(rows[id], next.assets);
        });
        next.sceneAssetIdsByScope[sanitizeScope(scope)] = scenes;
      });
    }
    return next;
  }

  function load() {
    try { state = normalizeState(JSON.parse(localStorage.getItem(STORE) || 'null')); }
    catch (_) { state = normalizeState(null); }
    lastEncoded = JSON.stringify(state);
    clearImageCache();
  }

  function getState(options) {
    const snapshot = copy(state);
    snapshot.scope = currentScope;
    snapshot.activeAssetIds = copy(activeIdsIn(state, currentScope, options));
    return snapshot;
  }
  function getFolder(id) {
    const folder = state.folders.find(item => item.id === String(id || '')) || null;
    return folder ? copy(folder) : null;
  }
  function getAsset(id) {
    const asset = findAsset(id);
    return asset ? copy(asset) : null;
  }
  function findAsset(id) {
    return state.assets.find(item => item.id === String(id || '')) || preset(id);
  }

  function reconcileImageCache(next) {
    Array.from(imageCache.keys()).forEach(id => {
      const cached = imageCache.get(id);
      const asset = next.assets.find(item => item.id === id);
      if (!asset || !cached || cached.src !== asset.imageDataUrl) evictImage(id);
    });
  }

  function acceptExternal(raw, reason) {
    const next = normalizeState(raw);
    const encoded = JSON.stringify(next);
    if (encoded === lastEncoded) return false;
    reconcileImageCache(next);
    state = next;
    lastEncoded = encoded;
    lastError = '';
    announce(reason || 'external-sync');
    return true;
  }

  function syncFromStorage(reason) {
    try {
      const encoded = localStorage.getItem(STORE);
      return acceptExternal(encoded ? JSON.parse(encoded) : null, reason);
    } catch (_) { return false; }
  }

  /* BroadcastChannel carries only an invalidation signal. Copying a library of
     embedded image data through the channel would double its peak memory; the
     receiver instead reads the already-durable localStorage value. */
  function publishSync() {
    if (!syncChannel) return;
    try { syncChannel.postMessage({ kind:'refresh', source:syncSource }); } catch (_) {}
  }

  function installSync() {
    try {
      if (window && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', event => {
          if (event && event.key === STORE) syncFromStorage('storage-sync');
        });
      }
    } catch (_) {}
    try {
      if (typeof BroadcastChannel === 'function') {
        syncChannel = new BroadcastChannel(SYNC_CHANNEL);
        /* Node's implementation keeps its event loop alive; browsers do not
           expose unref(), so this is inert in production and keeps VM/static
           contract tests deterministic. */
        if (typeof syncChannel.unref === 'function') syncChannel.unref();
        syncChannel.onmessage = event => {
          const message = event && event.data;
          if (message && message.kind === 'refresh' && message.source !== syncSource)
            syncFromStorage('broadcast-sync');
        };
      }
    } catch (_) { syncChannel = null; }
  }

  function announce(reason) {
    const snapshot = getState();
    listeners.forEach(listener => { try { listener(snapshot, reason); } catch (_) {} });
  }

  function commit(next, reason, afterPersist) {
    const normalized = normalizeState(next);
    const encoded = JSON.stringify(normalized);
    if (encoded.length > MAX_DOCUMENT_CHARS)
      throw new Error('My Assets is full. Remove a graphic before adding another.');
    try { localStorage.setItem(STORE, encoded); }
    catch (_) { throw new Error('SHOWAVE could not save graphic assets in this browser.'); }
    state = normalized;
    lastEncoded = encoded;
    if (typeof afterPersist === 'function') afterPersist();
    lastError = '';
    announce(reason || 'change');
    publishSync();
    return getState();
  }

  function listFolders() { return copy(state.folders); }

  function listAssets(folderOrOptions, maybeType) {
    let folderId = null, type = null, filterFolder = false;
    if (folderOrOptions && typeof folderOrOptions === 'object') {
      if (own(folderOrOptions, 'folderId')) {
        folderId = String(folderOrOptions.folderId || '');
        filterFolder = true;
      }
      type = folderOrOptions.type;
    } else if (TYPES.includes(folderOrOptions) && maybeType == null) {
      type = folderOrOptions;
    } else if (folderOrOptions != null) {
      folderId = String(folderOrOptions || '');
      filterFolder = true;
      type = maybeType;
    }
    let rows = state.assets;
    if (filterFolder) rows = rows.filter(asset => asset.folderId === folderId);
    if (TYPES.includes(type)) rows = rows.filter(asset => asset.type === type);
    return copy(rows);
  }

  function createFolder(input) {
    if (state.folders.length >= MAX_FOLDERS)
      throw new Error('You can create up to ' + MAX_FOLDERS + ' graphic folders.');
    const name = validText(typeof input === 'string' ? input : input && input.name,
      'Folder name', MAX_NAME, true);
    const now = Date.now();
    const folder = { id:newId('folder'), name, createdAt:now, updatedAt:now };
    const next = draftState();
    next.folders.push(folder);
    if (!next.selectedFolderId) next.selectedFolderId = folder.id;
    commit(next, 'folder-create');
    return copy(folder);
  }

  function updateFolder(id, patch) {
    const current = state.folders.find(item => item.id === String(id || ''));
    if (!current) throw new Error('That graphic folder no longer exists.');
    const name = validText(patch && patch.name, 'Folder name', MAX_NAME, true);
    const updated = Object.assign({}, current, { name, updatedAt:Date.now() });
    const next = draftState();
    next.folders = next.folders.map(item => item.id === current.id ? updated : item);
    commit(next, 'folder-update');
    return copy(updated);
  }

  function removeFolder(id) {
    const folderId = String(id || '');
    if (!state.folders.some(item => item.id === folderId)) return false;
    const removedIds = new Set(state.assets.filter(asset => asset.folderId === folderId)
      .map(asset => asset.id));
    const next = draftState();
    next.folders = next.folders.filter(item => item.id !== folderId);
    next.assets = next.assets.filter(asset => asset.folderId !== folderId);
    if (next.selectedFolderId === folderId)
      next.selectedFolderId = next.folders.length ? next.folders[0].id : null;
    commit(next, 'folder-remove', () => removedIds.forEach(evictImage));
    return true;
  }

  function selectFolder(id) {
    if (id == null && !state.folders.length) return null;
    const folderId = String(id || '');
    if (!state.folders.some(folder => folder.id === folderId))
      throw new Error('That graphic folder no longer exists.');
    if (state.selectedFolderId === folderId) return folderId;
    const next = draftState();
    next.selectedFolderId = folderId;
    commit(next, 'folder-select');
    return folderId;
  }

  function setShowDefaultGraphics(visible) {
    const next = draftState();
    next.showDefaultGraphics = visible !== false;
    // Library filtering is deliberately independent of programme visibility.
    commit(next, 'default-graphics');
    return state.showDefaultGraphics;
  }

  function validateAssetDraft(raw, current, explicit) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const type = source.type;
    if (!TYPES.includes(type)) throw new Error('Choose Logo, Overlay, or Background.');
    if (current && type !== current.type) throw new Error('A graphic asset type cannot be changed.');
    const folderId = String(source.folderId || state.selectedFolderId || '');
    if (!state.folders.some(folder => folder.id === folderId))
      throw new Error('Choose a graphic folder.');
    const name = validText(source.name, 'Asset name', MAX_NAME, true);
    const fileName = validText(source.fileName, 'File name', MAX_FILE_NAME, false);
    const altText = validText(source.altText, 'Alt text', MAX_ALT_TEXT, false);
    const data = imageData(source.imageDataUrl);
    if (own(explicit, 'mimeType') && canonicalMime(explicit.mimeType) !== data.mimeType)
      throw new Error('Image MIME type does not match its data URL.');
    /* Zero is the persisted sentinel for "read dimensions from the decoded
       image". It is accepted from an existing record, but never as caller
       supplied metadata. */
    const width = source.width === 0 && !own(explicit, 'width')
      ? 0 : dimension(source.width, 'Image width');
    const height = source.height === 0 && !own(explicit, 'height')
      ? 0 : dimension(source.height, 'Image height');
    if (!!width !== !!height) throw new Error('Provide both image width and image height.');
    let corner = '', scale = 0;
    if (type === 'logo') {
      // Theme defaults apply only when creating an asset. Loading, editing or
      // rendering an existing logo must not move or resize the user's mark.
      let newsDefault = false;
      if (!current) {
        const theme = window.OpenLiveTheme;
        try { newsDefault = !!(theme && typeof theme.profile === 'function' && theme.profile().id === 'news'); }
        catch (_) { /* An unavailable theme keeps the existing general default. */ }
      }
      corner = source.corner == null || source.corner === ''
        ? newsDefault ? 'top-left' : 'top-right' : String(source.corner);
      if (!CORNERS.includes(corner)) throw new Error('Choose a valid logo corner.');
      scale = source.scale == null || source.scale === ''
        ? newsDefault ? .12 : DEFAULT_LOGO_SCALE : logoScale(source.scale);
    }
    const now = Date.now();
    return {
      id:current ? current.id : newId('asset'),
      folderId,
      type,
      name,
      fileName,
      altText,
      imageDataUrl:data.dataUrl,
      mimeType:data.mimeType,
      byteLength:data.byteLength,
      width,
      height,
      corner,
      scale,
      createdAt:current ? current.createdAt : now,
      updatedAt:now
    };
  }

  function createAsset(spec) {
    const input = spec && typeof spec === 'object' ? spec : {};
    if (!TYPES.includes(input.type)) throw new Error('Choose Logo, Overlay, or Background.');
    if (state.assets.filter(asset => asset.type === input.type).length >= MAX_ASSETS_PER_TYPE)
      throw new Error('You can save up to ' + MAX_ASSETS_PER_TYPE + ' ' + input.type + ' assets.');
    const asset = validateAssetDraft(input, null, input);
    const next = draftState();
    next.assets.push(asset);
    commit(next, 'asset-create');
    return copy(asset);
  }

  function updateAsset(id, patch) {
    const current = findAsset(id);
    if (!current) throw new Error('That graphic asset no longer exists.');
    if (current.builtin) throw new Error('Default graphics cannot be edited. Upload your own graphic instead.');
    const changes = patch && typeof patch === 'object' ? patch : {};
    if (own(changes, 'type') && changes.type !== current.type)
      throw new Error('A graphic asset type cannot be changed.');
    const draft = Object.assign({}, current, changes, { id:current.id, type:current.type });
    const asset = validateAssetDraft(draft, current, changes);
    const next = draftState();
    next.assets = next.assets.map(item => item.id === current.id ? asset : item);
    commit(next, 'asset-update', asset.imageDataUrl !== current.imageDataUrl
      ? () => evictImage(current.id) : null);
    return copy(asset);
  }

  function removeAsset(id) {
    const current = findAsset(id);
    if (!current) return false;
    if (current.builtin) return false;
    const next = draftState();
    next.assets = next.assets.filter(asset => asset.id !== current.id);
    commit(next, 'asset-remove', () => evictImage(current.id));
    return true;
  }

  function setScope(scope) {
    const next = sanitizeScope(scope);
    if (next === currentScope) return currentScope;
    currentScope = next;
    announce('scope');
    return currentScope;
  }

  function active(type, options) {
    if (!TYPES.includes(type)) return null;
    const asset = renderAsset(type, options);
    return asset && asset.type === type ? copy(asset) : null;
  }

  // Programme owns a copy of the chosen records, not a pointer into My Assets.
  // Keep decoded images with that copy so editing/deleting the library asset
  // cannot evict the picture already on air.
  function captureRenderState(options) {
    const result = Object.fromEntries(TYPES.map(type => [type, active(type, options)]));
    result._images = {};
    for (const type of TYPES) if (result[type] && !result[type].builtin)
      result._images[type] = pinnedImage(result[type]);
    return result;
  }
  async function prepareRenderState(saved) {
    if(!saved)return;
    saved._images=saved._images||{};
    for(const type of TYPES)if(saved[type]&&!saved[type].builtin&&!saved._images[type])saved._images[type]=pinnedImage(saved[type]);
    await Promise.all(Object.values(saved._images).map(image=>image.ready));
    if(Object.values(saved._images).some(image=>image.state!=='ready'))throw new Error('A saved scene graphic could not be loaded.');
  }
  function recallSceneState(saved,options) {
    if(!saved)return;
    const next=draftState();
    for(const type of TYPES){
      const asset=saved[type];
      if(asset&&!asset.builtin){
        // Only the working editor copy is recalled. Shared storage is untouched.
        if(!next.folders.some(folder=>folder.id===asset.folderId))next.folders.push({id:asset.folderId,name:'Scene assets'});
        next.assets=next.assets.filter(row=>row.id!==asset.id);next.assets.push(copy(asset));
      }
      setDraftActive(next,type,asset?.id||null,options);
    }
    state=normalizeState(next);
  }
  function renderAsset(type, options) {
    return options?.graphicsState ? options.graphicsState[type] : findAsset(activeIdsIn(state, currentScope, options)[type]);
  }
  function renderImage(asset, options, prepare = true) {
    if (!options?.graphicsState) return prepare ? ensureImage(asset) : imageCache.get(asset.id);
    const images = options.graphicsState._images || (options.graphicsState._images = {});
    if (!images[asset.type] && prepare) images[asset.type] = pinnedImage(asset);
    return images[asset.type];
  }
  function pinnedImage(asset) {
    const cached = imageCache.get(asset.id);
    return cached?.state === 'ready' && cached.src === asset.imageDataUrl ? cached : ensureImage(asset,new Map());
  }

  function activeStatus(options) {
    return {
      scope:currentScope,
      selectedFolderId:state.selectedFolderId,
      activeAssetIds:copy(activeIdsIn(state, currentScope, options)),
      logo:active('logo', options),
      overlay:active('overlay', options),
      background:active('background', options)
    };
  }

  /* The compositor asks about the active logo on every video frame.  Returning
     activeStatus() there would JSON-clone each complete asset, including its
     potentially 25 MB data URL, up to 60 times a second.  This deliberately
     small view contains only render metadata and never exposes mutable state. */
  function activeRenderInfo(type, options) {
    if (!TYPES.includes(type)) return null;
    const asset = renderAsset(type, options);
    if (!asset || asset.type !== type) return null;
    const record = asset.builtin ? null : renderImage(asset, options, !!options?.graphicsState);
    return {
      id:asset.id,
      type:asset.type,
      name:asset.name,
      corner:asset.corner,
      scale:asset.scale,
      state:asset.builtin ? 'ready' : record ? record.state : 'idle',
      error:record ? record.error : ''
    };
  }

  function show(id, options) {
    const asset = findAsset(id);
    if (!asset) throw new Error('That graphic asset no longer exists.');
    if (activeIdsIn(state, currentScope, options)[asset.type] === asset.id) return copy(asset);
    const next = draftState();
    setDraftActive(next, asset.type, asset.id, options);
    commit(next, 'visibility');
    return copy(asset);
  }

  function hide(typeOrId, options) {
    const token = String(typeOrId || '');
    const activeIds = activeIdsIn(state, currentScope, options);
    let type = TYPES.includes(token) ? token : null;
    if (!type) {
      const asset = findAsset(token);
      if (asset) type = asset.type;
      else type = TYPES.find(item => activeIds[item] === token) || null;
    }
    if (!type || !activeIds[type]) return false;
    if (!TYPES.includes(token) && activeIds[type] !== token) return false;
    const next = draftState();
    setDraftActive(next, type, null, options);
    commit(next, 'visibility');
    return true;
  }

  function setVisible(id, visible, options) {
    return visible === false ? hide(id, options) : show(id, options);
  }

  function hideAll(options) {
    if (!hasActiveIds(activeIdsIn(state, currentScope, options))) return false;
    const next = draftState();
    TYPES.forEach(type => setDraftActive(next, type, null, options));
    commit(next, 'visibility');
    return true;
  }

  function copyScene(sourceId, targetId, options) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const next = draftState();
    // Studio's scene document is currently origin-wide. Its explicit allScopes
    // operation copies relationships without temporarily changing the output scope.
    const scopes = options && options.allScopes
      ? new Set([currentScope, ...Object.keys(state.activeAssetIdsByScope), ...Object.keys(state.sceneAssetIdsByScope)])
      : new Set([currentScope]);
    scopes.forEach(scope => {
      const ids = activeIdsIn(state, scope, { sceneId:sourceId });
      TYPES.forEach(type => setDraftActive(next, type, ids[type], { sceneId:targetId }, scope));
    });
    commit(next, 'scene-copy');
    return true;
  }

  function removeScene(sceneId, options) {
    const key = sceneKey({ sceneId });
    if (!key) return false;
    const scopes = options && options.allScopes ? Object.keys(state.sceneAssetIdsByScope) : [currentScope];
    if (!scopes.some(scope => state.sceneAssetIdsByScope[scope] && own(state.sceneAssetIdsByScope[scope], key))) return false;
    const next = draftState();
    scopes.forEach(scope => {
      if (!next.sceneAssetIdsByScope[scope]) return;
      delete next.sceneAssetIdsByScope[scope][key];
      if (!Object.keys(next.sceneAssetIdsByScope[scope]).length) delete next.sceneAssetIdsByScope[scope];
    });
    commit(next, 'scene-remove');
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function evictImage(id) {
    const record = imageCache.get(String(id || ''));
    if (record) {
      record.discarded = true;
      try { record.image.onload = null; record.image.onerror = null; } catch (_) {}
      if (!record.settled) {
        record.state = 'cancelled';
        record.error = 'Image decoding was cancelled.';
        record.settled = true;
        record.settle(record);
      }
    }
    imageCache.delete(String(id || ''));
  }

  function clearImageCache() {
    Array.from(imageCache.keys()).forEach(evictImage);
    imageCache.clear();
  }

  function ensureImage(asset, cache = imageCache) {
    const cached = cache.get(asset.id);
    if (cached && cached.src === asset.imageDataUrl) return cached;
    if (cached) evictImage(asset.id);

    let settle;
    const ready = new Promise(resolve => { settle = resolve; });
    const record = {
      id:asset.id,
      src:asset.imageDataUrl,
      image:null,
      state:'loading',
      error:'',
      width:asset.width || 0,
      height:asset.height || 0,
      discarded:false,
      settled:false,
      settle,
      ready
    };
    cache.set(asset.id, record);

    const finish = (status, error) => {
      if (record.discarded || record.state !== 'loading') return;
      record.state = status;
      record.error = error ? String(error && error.message || error) : '';
      if (status === 'ready') {
        record.width = Number(record.image.naturalWidth || record.image.width || asset.width) || 0;
        record.height = Number(record.image.naturalHeight || record.image.height || asset.height) || 0;
        if (!record.width || !record.height) {
          record.state = 'error';
          record.error = 'The image decoded without usable dimensions.';
        }
      }
      record.settled = true;
      record.settle(record);
      announce(record.state === 'ready' ? 'image-ready' : 'image-error');
    };

    try {
      if (typeof Image !== 'function') throw new Error('Image decoding is not available.');
      const image = new Image();
      record.image = image;
      try { image.decoding = 'async'; } catch (_) {}
      image.onload = () => finish('ready');
      image.onerror = () => finish('error', 'The image could not be decoded.');
      image.src = asset.imageDataUrl;
      if (image.complete && (image.naturalWidth || image.width)) finish('ready');
      if (typeof image.decode === 'function') {
        try {
          const decoded = image.decode();
          if (decoded && typeof decoded.then === 'function')
            decoded.then(() => finish('ready'), error => finish('error', error));
        } catch (error) { finish('error', error); }
      }
    } catch (error) {
      record.image = record.image || {};
      finish('error', error);
    }
    return record;
  }

  function decode(id) {
    const asset = findAsset(id);
    if (!asset) return Promise.resolve({ state:'missing', error:'That graphic asset no longer exists.' });
    if (asset.builtin) return Promise.resolve(imageStatus(id));
    const record = ensureImage(asset);
    return record.ready.then(result => ({
      state:result.state,
      error:result.error,
      width:result.width,
      height:result.height
    }));
  }

  function imageStatus(id) {
    const asset = findAsset(id);
    if (!asset) return { state:'missing', error:'That graphic asset no longer exists.', width:0, height:0 };
    if (asset.builtin) return { state:'ready', error:'', width:asset.width, height:asset.height };
    const record = imageCache.get(asset.id);
    if (!record) return { state:'idle', error:'', width:asset.width, height:asset.height };
    return { state:record.state, error:record.error, width:record.width, height:record.height };
  }

  function canvasSize(canvas) {
    const width = Number(canvas && canvas.width);
    const height = Number(canvas && canvas.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error('Programme canvas dimensions must be positive numbers.');
    return { width, height };
  }

  function drawRecord(type, ctx, canvas, options) {
    const asset = renderAsset(type, options);
    if (!asset || asset.type !== type)
      return { state:'hidden', type, assetId:null, geometry:null, error:'' };
    if (!ctx || typeof ctx.drawImage !== 'function')
      return { state:'error', type, assetId:asset.id, geometry:null,
        error:'A 2D programme context is required.' };
    let size;
    try { size = canvasSize(canvas); }
    catch (error) {
      return { state:'error', type, assetId:asset.id, geometry:null, error:error.message };
    }
    if (asset.builtin) {
      try {
        if (!window.OpenLiveGraphicsPresets.draw(asset.id, ctx, canvas, options && options.timeMs))
          throw new Error('Default graphic could not be drawn.');
        lastError = '';
        return { state:'drawn', type, assetId:asset.id,
          geometry:{ mode:'procedural', destination:{x:0,y:0,width:size.width,height:size.height} }, error:'' };
      } catch (error) {
        lastError = error && error.message || String(error);
        return { state:'error', type, assetId:asset.id, geometry:null, error:lastError };
      }
    }
    const image = renderImage(asset, options);
    if (image.state !== 'ready')
      return { state:image.state, type, assetId:asset.id, geometry:null, error:image.error };
    return { state:'ready', type, asset, image, size, geometry:null, error:'' };
  }

  function paint(record, geometry, args) {
    if (record.state !== 'ready') return record;
    try {
      if (typeof record.ctxSave === 'function') record.ctxSave();
      record.ctx.drawImage.apply(record.ctx, [record.image.image].concat(args));
      if (typeof record.ctxRestore === 'function') record.ctxRestore();
      lastError = '';
      return {
        state:'drawn', type:record.type, assetId:record.asset.id,
        geometry, error:''
      };
    } catch (error) {
      try { if (typeof record.ctxRestore === 'function') record.ctxRestore(); } catch (_) {}
      lastError = error && error.message || String(error);
      return {
        state:'error', type:record.type, assetId:record.asset.id,
        geometry, error:lastError
      };
    }
  }

  function readyRecord(type, ctx, canvas, options) {
    const record = drawRecord(type, ctx, canvas, options);
    if (record.state === 'ready') {
      record.ctx = ctx;
      record.ctxSave = typeof ctx.save === 'function' ? () => ctx.save() : null;
      record.ctxRestore = typeof ctx.restore === 'function' ? () => ctx.restore() : null;
    }
    return record;
  }

  function drawBackground(ctx, canvas, options) {
    const record = readyRecord('background', ctx, canvas, options);
    if (record.state !== 'ready') return record;
    const sourceWidth = record.image.width;
    const sourceHeight = record.image.height;
    const targetRatio = record.size.width / record.size.height;
    const sourceRatio = sourceWidth / sourceHeight;
    let sourceX = 0, sourceY = 0, cropWidth = sourceWidth, cropHeight = sourceHeight;
    if (sourceRatio > targetRatio) {
      cropWidth = sourceHeight * targetRatio;
      sourceX = (sourceWidth - cropWidth) / 2;
    } else if (sourceRatio < targetRatio) {
      cropHeight = sourceWidth / targetRatio;
      sourceY = (sourceHeight - cropHeight) / 2;
    }
    const geometry = {
      mode:'cover',
      source:{ x:sourceX, y:sourceY, width:cropWidth, height:cropHeight },
      destination:{ x:0, y:0, width:record.size.width, height:record.size.height }
    };
    return paint(record, geometry, [sourceX, sourceY, cropWidth, cropHeight,
      0, 0, record.size.width, record.size.height]);
  }

  function drawOverlay(ctx, canvas, options) {
    const record = readyRecord('overlay', ctx, canvas, options);
    if (record.state !== 'ready') return record;
    const geometry = {
      mode:'full-frame',
      destination:{ x:0, y:0, width:record.size.width, height:record.size.height }
    };
    return paint(record, geometry, [0, 0, record.size.width, record.size.height]);
  }

  function logoGeometry(asset, image, size, options) {
    const requestedCorner = options && options.corner;
    const corner = CORNERS.includes(requestedCorner) ? requestedCorner : asset.corner;
    const suppliedScale = options && options.scale != null && options.scale !== ''
      ? Number(options.scale) : NaN;
    const scale = Number.isFinite(suppliedScale)
      ? Math.max(MIN_LOGO_SCALE, Math.min(MAX_LOGO_SCALE, suppliedScale))
      : asset.scale;
    const unit = Math.min(size.width, size.height);
    const boxSize = unit * scale;
    const imageRatio = image.width / image.height;
    const width = imageRatio >= 1 ? boxSize : boxSize * imageRatio;
    const height = imageRatio >= 1 ? boxSize / imageRatio : boxSize;
    const margin = unit * .035;
    const shared = window.OpenLiveBroadcastLayout;
    const area = shared && typeof shared.safeArea === 'function'
      ? shared.safeArea(size, options)
      : { x:margin, y:margin, right:size.width - margin, bottom:size.height - margin };
    const x = corner.endsWith('left') ? area.x : area.right - width;
    const y = corner.startsWith('top') ? area.y : area.bottom - height;
    return {
      mode:'contain', corner,
      box:{ x:corner.endsWith('left') ? area.x : area.right - boxSize,
        y:corner.startsWith('top') ? area.y : area.bottom - boxSize,
        width:boxSize, height:boxSize },
      destination:{ x, y, width, height }
    };
  }

  /* Measurement must not trigger decoding, painting, event dispatch or storage
     writes. It resolves exactly the same scene-scoped mark and cached image as
     drawLogo, allowing other overlays to reserve its actual painted rectangle. */
  function logoLayout(canvas, options) {
    const asset = renderAsset('logo', options);
    if (!asset || asset.type !== 'logo') return null;
    const image = renderImage(asset, options, false);
    if (!image || image.state !== 'ready' || !image.image || !(image.width > 0 && image.height > 0))
      return null;
    try { return logoGeometry(asset, image, canvasSize(canvas), options); }
    catch (_) { return null; }
  }

  function drawLogo(ctx, canvas, options) {
    const record = readyRecord('logo', ctx, canvas, options);
    if (record.state !== 'ready') return record;
    const geometry = logoGeometry(record.asset, record.image, record.size, options);
    const box = geometry.destination;
    return paint(record, geometry, [box.x, box.y, box.width, box.height]);
  }

  function reloadForTest() {
    load();
    return getState();
  }

  function resetForTests(seed) {
    clearImageCache();
    currentScope = DEFAULT_SCOPE;
    if (arguments.length) {
      state = normalizeState(seed);
      lastEncoded = JSON.stringify(state);
      try { localStorage.setItem(STORE, lastEncoded); } catch (_) {}
    } else {
      state = emptyState();
      lastEncoded = JSON.stringify(state);
      try { localStorage.removeItem(STORE); } catch (_) {
        try { localStorage.setItem(STORE, lastEncoded); } catch (_) {}
      }
    }
    lastError = '';
    announce('reset');
    return getState();
  }

  load();
  installSync();

  return {
    version, STORE, DEFAULT_SCOPE, TYPES, CORNERS, MAX_FOLDERS, MAX_ASSETS_PER_TYPE, MAX_IMAGE_BYTES,
    getState, listFolders, getFolder, createFolder, updateFolder, removeFolder, selectFolder,
    listAssets, getAsset, createAsset, updateAsset, removeAsset,
    setScope, show, hide, setVisible, hideAll, active, activeStatus, activeRenderInfo,
    copyScene, removeScene, setShowDefaultGraphics, captureRenderState, prepareRenderState, recallSceneState,
    decode, imageStatus, drawBackground, drawOverlay, drawLogo, logoLayout, subscribe,
    _reloadForTest:reloadForTest, _resetForTests:resetForTests,
    get scope() { return currentScope; },
    get lastError() { return lastError; }
  };
})();
