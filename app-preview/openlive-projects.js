/* Explicit SHOWAVE Show files and recovery. Runtime state, media capabilities,
 * Web Storage and unrelated downloads remain under OpenLiveSessionPolicy. */
(function installOpenLiveProjects(global) {
  'use strict';
  if (global.OpenLiveProjects) return;

  const DB_NAME = 'showave-projects-v1';
  const PROJECTS = 'projects';
  const RECOVERY = 'recovery';
  const SUFFIX = '.openlive.json';
  const MAX_RECENTS = 20;
  const runtimeRecords = new Map();
  let databasePromise = null;
  let recoveryOwnerId = null;

  function desktop(method, arg) {
    if (!global.OpenLiveDesktop) return undefined;
    const service = global.OpenLiveDesktop.projects;
    if (!service || typeof service[method] !== 'function')
      throw new Error('The desktop project service is unavailable.');
    return service[method](arg);
  }

  function policy() {
    const files = global.OpenLiveSessionPolicy && global.OpenLiveSessionPolicy.projectFiles;
    if (!files || typeof files.validate !== 'function')
      throw new Error('The SHOWAVE Show-file policy is unavailable.');
    return files;
  }

  function filename(value) {
    let name = String(value || 'Untitled').trim().replace(/[\\/\x00-\x1f<>:"|?*]/g, '_');
    name = name.replace(/\.openlive\.json$/i, '').replace(/\.json$/i, '').trim();
    if (!name || name === '.' || name === '..') name = 'Untitled';
    return name.slice(0, 160 - SUFFIX.length) + SUFFIX;
  }

  function newId() {
    const crypto = global.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return 'show-' + crypto.randomUUID();
    if (!crypto || typeof crypto.getRandomValues !== 'function')
      throw new Error('Secure project identities are unavailable.');
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'show-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function ownerRecoveryKey() {
    if (!recoveryOwnerId) recoveryOwnerId = 'owner:' + newId();
    return recoveryOwnerId;
  }

  function validRecoveryId(value) {
    return typeof value === 'string' && /^show-(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value);
  }

  function database() {
    if (databasePromise) return databasePromise;
    if (!global.indexedDB) return Promise.reject(new Error('Project recovery storage is unavailable.'));
    databasePromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Project recovery storage could not open.'));
      request.onblocked = () => reject(new Error('Close another SHOWAVE tab to update project storage.'));
    }).catch(error => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function read(store, key) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly');
      const request = key === undefined ? transaction.objectStore(store).getAll() : transaction.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Project storage could not be read.'));
      transaction.onerror = () => reject(transaction.error || new Error('Project storage could not be read.'));
    });
  }

  async function change(store, action, value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      try { transaction.objectStore(store)[action](value); }
      catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Project storage could not be updated.'));
      transaction.onabort = () => reject(transaction.error || new Error('Project storage update was cancelled.'));
    });
  }

  async function trimRecents() {
    const records = await read(PROJECTS);
    records.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    await Promise.all(records.slice(MAX_RECENTS).map(record => change(PROJECTS, 'delete', record.id)));
  }

  async function recentRecord(id) {
    if (runtimeRecords.has(id)) return runtimeRecords.get(id);
    try { return await read(PROJECTS, id); } catch (_) { return null; }
  }

  async function remember(record) {
    // A Recent is durable only after IndexedDB confirms the transaction.
    // Keep the current page's copy available if that write fails.
    runtimeRecords.set(record.id, { ...record, recentSaved: false });
    try {
      await change(PROJECTS, 'put', record);
      await trimRecents();
      runtimeRecords.set(record.id, { ...record, recentSaved: true });
      return true;
    } catch (_) {
      // Some browsers cannot structured-clone a file handle. Keep an honest
      // saved copy for Recent rather than claiming it can reopen the original.
      if (record.handle && record.text) {
        const copy = { id: record.id, name: record.name, updatedAt: record.updatedAt,
          copyOnly: true, text: record.text };
        try {
          await change(PROJECTS, 'put', copy);
          await trimRecents();
          runtimeRecords.set(copy.id, { ...copy, recentSaved: true });
          return true;
        }
        catch (_) {}
      }
      return false;
    }
  }

  function recentSummary(record) {
    return { id: record.id, name: record.name, updatedAt: record.updatedAt,
      copyOnly: record.copyOnly === true, recentSaved: record.recentSaved !== false };
  }

  async function list() {
    const native = desktop('list');
    if (native !== undefined) return native;
    let records = [], loaded = false;
    try { records = await read(PROJECTS); loaded = true; } catch (_) {}
    const byId = new Map(records.map(record => [record.id, record]));
    runtimeRecords.forEach((record, id) => {
      const persisted = byId.get(id);
      if (!loaded || record.recentSaved === false ||
          persisted && Number(record.updatedAt) >= Number(persisted.updatedAt))
        byId.set(id, record);
      else if (persisted) runtimeRecords.set(id, persisted);
      else runtimeRecords.delete(id); // Another window may have cleared Recent.
    });
    return [...byId.values()].filter(record => record && typeof record.id === 'string' &&
      typeof record.name === 'string' && Number.isFinite(record.updatedAt))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECENTS).map(recentSummary);
  }

  async function chooseBrowserFile() {
    if (typeof global.showOpenFilePicker === 'function') {
      const handles = await global.showOpenFilePicker({ multiple: false, types: [
        { description: 'SHOWAVE Show', accept: { 'application/json': [SUFFIX] } }
      ] });
      const handle = handles && handles[0];
      return handle ? { handle, file: await handle.getFile() } : null;
    }
    return new Promise(resolve => {
      const input = global.document.createElement('input');
      input.type = 'file'; input.accept = SUFFIX + ',application/json'; input.hidden = true;
      global.document.body.appendChild(input);
      const finish = file => { input.remove(); resolve(file ? { handle: null, file } : null); };
      input.addEventListener('change', () => finish(input.files && input.files[0]), { once: true });
      input.addEventListener('cancel', () => finish(null), { once: true });
      input.click();
    });
  }

  async function fileText(file) {
    if (!file || typeof file.name !== 'string' || !file.name.toLowerCase().endsWith(SUFFIX))
      throw new Error('Choose a .openlive.json Show file.');
    if (Number(file.size) > 8 * 1024 * 1024)
      throw new Error('The SHOWAVE Show exceeds the 8 MiB limit.');
    const text = await file.text();
    policy().validate(text);
    return text;
  }

  async function open() {
    const native = desktop('open');
    if (native !== undefined) return native;
    let chosen;
    try { chosen = await chooseBrowserFile(); }
    catch (error) { if (error && error.name === 'AbortError') return null; throw error; }
    if (!chosen) return null;
    const text = await fileText(chosen.file);
    const record = { id: newId(), name: chosen.file.name, updatedAt: Date.now(),
      handle: chosen.handle || undefined, copyOnly: !chosen.handle, text };
    const recentSaved = await remember(record);
    return { id: record.id, name: record.name, text, handle: chosen.handle || null,
      copyOnly: record.copyOnly, recentSaved };
  }

  async function openRecent(id) {
    const native = desktop('openRecent', id);
    if (native !== undefined) return native;
    if (typeof id !== 'string' || !id) return null;
    let record = await recentRecord(id);
    if (!record) return null;
    let text = record.text;
    let readableHandle = null;
    if (record.handle) {
      try {
        const handle = record.handle;
        let status = typeof handle.queryPermission === 'function'
          ? await handle.queryPermission({ mode: 'read' }) : 'granted';
        // Startup recovery may run without a click. In that case use the
        // validated saved copy rather than trying to open a permission prompt
        // that Chromium will reject for lack of transient activation.
        const canPrompt = !global.navigator || !global.navigator.userActivation ||
          global.navigator.userActivation.isActive === true;
        if (status !== 'granted' && canPrompt && typeof handle.requestPermission === 'function')
          status = await handle.requestPermission({ mode: 'read' });
        if (status === 'granted') {
          text = await fileText(await handle.getFile());
          readableHandle = handle;
        }
      } catch (_) { /* The saved copy remains an explicit recovery option. */ }
    }
    if (!readableHandle) {
      // A different Show window may have saved this project since this page
      // cached it. Refresh the saved copy after any permission prompt.
      try {
        const persisted = await read(PROJECTS, id);
        if (persisted && Number(persisted.updatedAt) > Number(record.updatedAt) &&
            typeof persisted.text === 'string') {
          policy().validate(persisted.text);
          record = persisted;
          text = persisted.text;
        }
      } catch (_) {}
    }
    if (typeof text !== 'string') return null;
    policy().validate(text);
    const updated = { ...record, text, updatedAt: Date.now(),
      // Keep the capability in Recent so a later click can regain read
      // permission. This opening remains a saved copy and Save cannot write
      // through the inaccessible handle.
      handle: readableHandle || record.handle || undefined, copyOnly: !readableHandle };
    const recentSaved = await remember(updated);
    return { id: record.id, name: record.name, text, handle: readableHandle,
      copyOnly: updated.copyOnly, recentSaved };
  }

  async function save(input) {
    const native = desktop('save', input);
    if (native !== undefined) return native;
    const options = input && typeof input === 'object' ? input : {};
    const text = options.text;
    policy().validate(text);
    // The native picker requires the original click's transient activation.
    // Do not await IndexedDB before invoking it; Open/Open Recent already put
    // the selected record in this page's runtime map.
    const previous = !options.saveAs && typeof options.id === 'string'
      ? runtimeRecords.get(options.id) || null : null;
    const desiredName = filename(options.name || previous && previous.name || 'Untitled');
    const offeredHandle = !options.saveAs && options.handle || null;
    const previousHandle = !options.saveAs && previous && !previous.copyOnly && previous.handle || null;
    let selected = null;
    try {
      if (policy().available) selected = await policy().write({ text, name: desiredName,
        handle: offeredHandle || previousHandle, saveAs: options.saveAs === true });
      else policy().download({ text, name: desiredName });
    } catch (error) { if (error && error.name === 'AbortError') return null; throw error; }
    const record = { id: options.saveAs || !options.id ? newId() : options.id,
      name: selected ? selected.name : desiredName, updatedAt: Date.now(),
      handle: selected && selected.handle || undefined, copyOnly: !selected, text };
    const recentSaved = await remember(record);
    return { ...recentSummary(record), handle: record.handle || null, recentSaved };
  }

  async function getRecovery() {
    const native = desktop('getRecovery');
    if (native !== undefined) return native;
    for (let attempt = 0; attempt < 3; attempt++) {
      let records;
      try { records = await read(RECOVERY); } catch (_) { return null; }
      const candidates = records.filter(record => record && typeof record.text === 'string' &&
        Number.isFinite(record.savedAt) &&
        (record.key === 'active' || typeof record.key === 'string' && record.key.startsWith('owner:')))
        .sort((a, b) => b.savedAt - a.savedAt);
      let changed = false;
      for (const record of candidates) {
        try { policy().validate(record.text); }
        catch (_) { continue; /* Ignore a damaged recovery record. */ }
        const recoveryId = validRecoveryId(record.snapshotId) ? record.snapshotId
          : await identifyRecovery(record);
        if (!recoveryId) { changed = true; break; }
        const current = await read(RECOVERY, record.key);
        if (!current || current.snapshotId !== recoveryId ||
            current.savedAt !== record.savedAt || current.text !== record.text) {
          changed = true; break;
        }
        return { text: record.text, savedAt: record.savedAt, recoveryId };
      }
      if (!changed) return null;
    }
    throw new Error('Recovery changed while it was being opened. Try again.');
  }

  async function identifyRecovery(record) {
    // Older releases used the shared `active` key without a receipt. Migrate
    // only the exact bytes read above; a concurrent newer snapshot is safe.
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(RECOVERY, 'readwrite');
      const store = transaction.objectStore(RECOVERY);
      let snapshotId = null;
      const request = store.get(record.key);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.savedAt !== record.savedAt || current.text !== record.text) return;
        if (validRecoveryId(current.snapshotId)) { snapshotId = current.snapshotId; return; }
        snapshotId = newId();
        store.put({ ...current, snapshotId });
      };
      transaction.oncomplete = () => resolve(snapshotId);
      transaction.onerror = () => reject(transaction.error || new Error('Recovery identity could not be saved.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery identity was cancelled.'));
    });
  }

  async function saveRecovery(text) {
    const native = desktop('saveRecovery', text);
    if (native !== undefined) return native;
    policy().validate(text);
    const savedAt = Date.now();
    const recoveryId = newId();
    await change(RECOVERY, 'put', { key: ownerRecoveryKey(), text, savedAt, snapshotId: recoveryId });
    return { savedAt, recoveryId };
  }

  async function acknowledgeRecovered(recoveryId) {
    const native = desktop('acknowledgeRecovered', recoveryId);
    if (native !== undefined) return native;
    if (!validRecoveryId(recoveryId)) return false;
    const records = await read(RECOVERY);
    const candidate = records.find(record => record && record.snapshotId === recoveryId &&
      (record.key === 'active' || typeof record.key === 'string' && record.key.startsWith('owner:')));
    if (!candidate) return false;
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(RECOVERY, 'readwrite');
      const store = transaction.objectStore(RECOVERY);
      let removed = false;
      const request = store.get(candidate.key);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.snapshotId !== recoveryId) return;
        store.delete(candidate.key);
        removed = true;
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error || new Error('Recovery could not be acknowledged.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery acknowledgement was cancelled.'));
    });
  }

  async function clearRecovery() {
    const native = desktop('clearRecovery');
    if (native !== undefined) return native;
    await change(RECOVERY, 'delete', ownerRecoveryKey());
    return true;
  }

  async function clearRecent() {
    const native = desktop('clearRecent');
    if (native !== undefined) return native;
    const records = await read(PROJECTS);
    await Promise.all(records.map(record => change(PROJECTS, 'delete', record.id)));
    runtimeRecords.clear();
    return true;
  }

  Object.defineProperty(global, 'OpenLiveProjects', { value: Object.freeze({
    list, open, openRecent, save, getRecovery, saveRecovery, clearRecovery, acknowledgeRecovered, clearRecent
  }) });
})(window);
