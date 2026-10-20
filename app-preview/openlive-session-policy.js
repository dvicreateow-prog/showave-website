/* SHOWAVE keeps general application state in this running browser session.
 * Explicit Appearance Save, startup-cover and Show-file operations persist
 * the user's chosen preferences or files. The Chaser editor also retains one
 * bounded recovery document for its authored chase and shared envelopes.
 * Explicit Upload to My Images uses
 * its bounded browser image catalogue; ordinary media selections stay local
 * to the running session and are never copied into that catalogue.
 * Load before every application script. Other existing browser data is never
 * read, overwritten or removed. Same-origin frames/popups share a synchronous store;
 * other open tabs exchange changes through BroadcastChannel without disk IO.
 */
(function installSessionPolicy(global) {
  'use strict';
  if (global.OpenLiveSessionPolicy) return;

  const APPEARANCE_KEY = 'openlive.appearance.saved.v1';
  const PROJECT_BYTES_LIMIT = 8 * 1024 * 1024;
  const PROJECT_SUFFIX = '.openlive.json';
  // Keep the native write capabilities private before installing the general
  // session-only guards. Only the explicit, validated Show-file operation below
  // may use them; arbitrary downloads and recordings remain blocked.
  const nativeProjectPicker = typeof global.showSaveFilePicker === 'function'
    ? global.showSaveFilePicker.bind(global) : null;
  const nativeOpenPicker = typeof global.showOpenFilePicker === 'function'
    ? global.showOpenFilePicker.bind(global) : null;
  const nativeDirectoryPicker = typeof global.showDirectoryPicker === 'function'
    ? global.showDirectoryPicker.bind(global) : null;
  const nativeProjectWritable = global.FileSystemFileHandle &&
    global.FileSystemFileHandle.prototype &&
    typeof global.FileSystemFileHandle.prototype.createWritable === 'function'
      ? global.FileSystemFileHandle.prototype.createWritable : null;
  const chaserPage = !!(global.document && global.document.currentScript &&
    global.document.currentScript.hasAttribute('data-openlive-chaser'));
  const nativeAnchorClick = global.HTMLAnchorElement && global.HTMLAnchorElement.prototype &&
    typeof global.HTMLAnchorElement.prototype.click === 'function'
      ? global.HTMLAnchorElement.prototype.click : null;
  const allowedProjectDownloads = new WeakSet();
  let sharedGestureScope = null, lastSharedGesture = null;
  const sharedGestureTypes = new Set(['click','dblclick','pointerdown','pointerup','mousedown','mouseup','keydown','keyup','contextmenu']);
  function liveSharedGesture(context, synchronous = false) {
    try {
      if (!context || context.denied || context.controller.stopped || context.view.closed ||
          context.document.defaultView !== context.view || !context.original.isConnected ||
          context.original.ownerDocument !== global.document || !context.target.isConnected ||
          context.target.ownerDocument !== context.document ||
          context.controller.originalFor(context.target) !== context.original || Date.now() - context.at > 5000)
        return null;
      const activation = context.view.navigator && context.view.navigator.userActivation;
      return activation ? activation.isActive === true ? context : null : synchronous ? context : null;
    } catch (_) { return null; }
  }
  function initiatingSharedGesture() {
    if (sharedGestureScope) return liveSharedGesture(sharedGestureScope, true);
    return liveSharedGesture(lastSharedGesture, false);
  }
  function fileRealm() {
    const gesture = initiatingSharedGesture();
    return gesture ? gesture.realm : {view:global, document:global.document, picker:nativeProjectPicker,
      writable:nativeProjectWritable, directory:nativeDirectoryPicker, anchorClick:nativeAnchorClick};
  }
  const sharedViewGestures = Object.freeze({
    create(targetDocument, originalFor, viewFor) {
      const view = targetDocument && targetDocument.defaultView;
      if (!view || targetDocument === global.document || typeof originalFor !== 'function' ||
          view.top.location.origin !== global.location.origin)
        throw new Error('A same-origin live shared-view document is required.');
      const realm = {view, document:targetDocument,
        picker:typeof view.showSaveFilePicker === 'function' ? view.showSaveFilePicker.bind(view) : null,
        openPicker:typeof view.showOpenFilePicker === 'function' ? view.showOpenFilePicker.bind(view) : null,
        directory:typeof view.showDirectoryPicker === 'function' ? view.showDirectoryPicker.bind(view) : null,
        writable:nativeProjectWritable || view.FileSystemFileHandle && view.FileSystemFileHandle.prototype.createWritable,
        anchorClick:view.HTMLAnchorElement && view.HTMLAnchorElement.prototype.click,
        inputClick:view.HTMLInputElement && view.HTMLInputElement.prototype.click};
      const controller = {stopped:false, originalFor, viewFor, realm, delegatedInputs:new WeakSet(), temporaryInputs:new Set()};
      return Object.freeze({
        forward(event, callback) {
          if (typeof callback !== 'function') throw new TypeError('A shared-view forwarding callback is required.');
          const previous = sharedGestureScope;
          let context = null;
          try {
            const target = event && event.target, original = target && originalFor(target);
            const recent = !view.performance || !Number.isFinite(event.timeStamp) ||
              Math.abs(view.performance.now() - event.timeStamp) <= 1000;
            if (!controller.stopped && event instanceof view.Event && event.isTrusted === true && recent &&
                sharedGestureTypes.has(event.type) && target && target.ownerDocument === targetDocument &&
                original && original.ownerDocument === global.document) {
              context = {controller, view, document:targetDocument, target, original, realm, at:Date.now()};
              context = liveSharedGesture(context, true);
            }
          } catch (_) {}
          sharedGestureScope = context || {denied:true};
          if (context) lastSharedGesture = context;
          try { return callback(); }
          finally { sharedGestureScope = previous; }
        },
        inputDelegated(event) {
          return !!(event && event.type === 'click' && event.target && event.target.ownerDocument === targetDocument &&
            controller.delegatedInputs.has(event.target));
        },
        dispose() {
          controller.stopped = true;
          controller.temporaryInputs.forEach(input => input.remove()); controller.temporaryInputs.clear();
          if (lastSharedGesture && lastSharedGesture.controller === controller) lastSharedGesture = null;
        }
      });
    }
  });
  function delegatedInputClick(original, gesture) {
    const controller = gesture.controller, realm = gesture.realm;
    if (!realm.inputClick || !realm.document.body) return false;
    let input = typeof controller.viewFor === 'function' ? controller.viewFor(original) : null;
    if (!input || input.ownerDocument !== realm.document || input.tagName !== 'INPUT' || input.type !== 'file' || !input.isConnected) {
      input = realm.document.createElement('input'); input.type = 'file'; input.hidden = true;
      for (const name of ['accept','multiple','capture','webkitdirectory'])
        if (original.hasAttribute(name)) input.setAttribute(name, original.getAttribute(name));
      realm.document.body.appendChild(input); controller.temporaryInputs.add(input);
      const finish = type => {
        if (controller.stopped || !original.isConnected) { input.remove(); controller.temporaryInputs.delete(input); return; }
        if (type === 'change') original.files = input.files;
        original.dispatchEvent(new global.Event(type, {bubbles:true}));
        input.remove(); controller.temporaryInputs.delete(input);
      };
      input.addEventListener('change', () => finish('change'), {once:true});
      input.addEventListener('cancel', () => finish('cancel'), {once:true});
    }
    input.value = '';
    controller.delegatedInputs.add(input);
    try { realm.inputClick.call(input); }
    finally { controller.delegatedInputs.delete(input); }
    return true;
  }
  const nativeInputClick = global.HTMLInputElement && global.HTMLInputElement.prototype.click;
  if (typeof nativeInputClick === 'function') Object.defineProperty(global.HTMLInputElement.prototype, 'click', {
    configurable:true, writable:true, value:function () {
      const gesture = initiatingSharedGesture();
      if (gesture && this.ownerDocument === global.document && this.tagName === 'INPUT' && this.type === 'file' &&
          this.isConnected && delegatedInputClick(this, gesture)) return;
      return nativeInputClick.call(this);
    }
  });
  if (nativeOpenPicker) Object.defineProperty(global, 'showOpenFilePicker', {
    configurable:true, writable:true, value:function (options) {
      const gesture = initiatingSharedGesture();
      return gesture && gesture.realm.openPicker ? gesture.realm.openPicker(options) : nativeOpenPicker(options);
    }
  });
  if (nativeDirectoryPicker) Object.defineProperty(global, 'showDirectoryPicker', {
    configurable:true, writable:true, value:function (options) {
      const gesture = initiatingSharedGesture();
      // Media folders are opened read-only in the initiating shared view.
      return gesture && gesture.realm.directory && (!options || !options.mode || options.mode === 'read')
        ? gesture.realm.directory(options) : nativeDirectoryPicker(options);
    }
  });
  function validProjectName(value) {
    return typeof value === 'string' && value.length > PROJECT_SUFFIX.length && value.length <= 160 &&
      value.toLowerCase().endsWith(PROJECT_SUFFIX) && !/[\\/\x00-\x1f<>:"|?*]/.test(value);
  }
  function validateProjectText(value) {
    if (typeof value !== 'string') throw new TypeError('A SHOWAVE Show must be JSON text.');
    const size = global.TextEncoder ? new global.TextEncoder().encode(value).byteLength
      : global.Blob ? new global.Blob([value]).size : value.length * 3;
    if (!size || size > PROJECT_BYTES_LIMIT) throw new Error('The SHOWAVE Show exceeds the 8 MiB limit.');
    let data;
    try { data = JSON.parse(value); } catch (_) { throw new Error('The SHOWAVE Show contains invalid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        data.format !== 'openlive-composition' || ![1, 2].includes(data.version) ||
        !data.composition || typeof data.composition !== 'object' ||
        !['groups', 'layers', 'columns', 'decks'].every(key => Array.isArray(data[key])))
      throw new Error('Choose a valid SHOWAVE Show document.');
    return size;
  }
  function requireProjectGesture() {
    if (global.navigator && global.navigator.userActivation &&
        global.navigator.userActivation.isActive !== true && !initiatingSharedGesture())
      throw new Error('Choose Save from the SHOWAVE window to write a Show file.');
  }
  const projectFiles = Object.freeze({
    available: !!(nativeProjectPicker && nativeProjectWritable),
    validate: validateProjectText,
    async write({ text, name, handle = null, saveAs = false }) {
      validateProjectText(text);
      if (!validProjectName(name)) throw new Error('The Show filename must end in .openlive.json.');
      requireProjectGesture();
      const realm = fileRealm();
      if (!realm.picker || !realm.writable) throw new Error('This browser has no Show file picker.');
      const selected = !saveAs && handle ? handle : await realm.picker({
        suggestedName: name,
        types: [{ description: 'SHOWAVE Show', accept: { 'application/json': [PROJECT_SUFFIX] } }]
      });
      if (!selected || !validProjectName(selected.name))
        throw new Error('The selected Show filename must end in .openlive.json.');
      const writable = await realm.writable.call(selected);
      try { await writable.write(text); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
      return { handle: selected, name: selected.name };
    },
    download({ text, name }) {
      validateProjectText(text);
      if (!validProjectName(name)) throw new Error('The Show filename must end in .openlive.json.');
      requireProjectGesture();
      const realm = fileRealm(), target = realm.view;
      if (!realm.document || !realm.anchorClick || !target.Blob || !target.URL ||
          typeof target.URL.createObjectURL !== 'function')
        throw new Error('This browser cannot download a Show file.');
      const url = target.URL.createObjectURL(new target.Blob([text], { type: 'application/json' }));
      const link = realm.document.createElement('a');
      link.href = url; link.download = name; link.hidden = true;
      realm.document.body.appendChild(link);
      allowedProjectDownloads.add(link);
      try { realm.anchorClick.call(link); }
      finally {
        allowedProjectDownloads.delete(link);
        link.remove();
        global.setTimeout(() => target.URL.revokeObjectURL(url), 1000);
      }
      return { name, copyOnly: true };
    }
  });
  // Explicit Chaser files use their own bounded capability. General storage,
  // recording and download guards remain session-only in every workspace.
  const chaserFileKinds = Object.freeze({
    project: { suffix: '.showave-chaser.json', mime: 'application/json', limit: 32 * 1024 * 1024, label: 'SHOWAVE Chaser project' },
    native: { suffix: '.xml', mime: 'application/xml', limit: 32 * 1024 * 1024, label: 'Chaser 3 XML project' },
    png: { suffix: '.png', mime: 'image/png', limit: 256 * 1024 * 1024, label: 'Pixel Map PNG' },
    package: { suffix: '.zip', mime: 'application/zip', limit: 320 * 1024 * 1024, label: 'Pixel Map package' },
    manifest: { suffix: '.json', mime: 'application/json', limit: 32 * 1024 * 1024, label: 'Pixel Map manifest' }
  });
  function requireChaserPage() {
    if (!chaserPage) throw new Error('Chaser file operations are available from the Chaser editor.');
  }
  function chaserFileName(kind, name) {
    const spec = chaserFileKinds[kind];
    if (!spec || typeof name !== 'string' || !name.length || name.length > 180 ||
        !name.toLowerCase().endsWith(spec.suffix) || /[\\/\x00-\x1f<>:"|?*]/.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
      throw new Error('Choose a valid Chaser filename.');
    return spec;
  }
  async function validateChaserBlob(kind, name, blob) {
    const spec = chaserFileName(kind, name);
    if (!blob || typeof blob.arrayBuffer !== 'function' || typeof blob.text !== 'function' ||
        !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > spec.limit)
      throw new Error('The Chaser file is empty or exceeds the export limit.');
    if (kind === 'project' || kind === 'manifest') {
      let record;
      try { record = JSON.parse(await blob.text()); } catch (_) { throw new Error('The Chaser file contains invalid JSON.'); }
      if (kind === 'project' ? !record || record.schema !== 'showave.chaser.document/1' ||
          !record.project || !Array.isArray(record.project.sequences) :
          !record || record.schema !== 'showave.chaser.pixelmap-export/1')
        throw new Error('Choose a valid Chaser document.');
    } else if (kind === 'native') {
      const xml = await blob.text();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Native Chaser files cannot contain XML document types or entities.');
      const doc = new global.DOMParser().parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length || !doc.documentElement ||
          doc.documentElement.nodeName !== 'Chaser') throw new Error('Choose a valid native Chaser XML document.');
    } else {
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      const valid = kind === 'png' ? [137,80,78,71,13,10,26,10].every((byte, index) => head[index] === byte)
        : head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4;
      if (!valid) throw new Error('The Pixel Map export has an invalid file header.');
    }
  }
  function downloadChaserBlob(blob, name, realm) {
    if (realm.view !== global && !realm.document.defaultView || realm.view.closed)
      throw new Error('The initiating export window has closed.');
    const url = realm.view.URL.createObjectURL(blob), link = realm.document.createElement('a');
    link.href = url; link.download = name; link.hidden = true;
    realm.document.body.appendChild(link); allowedProjectDownloads.add(link);
    try { realm.anchorClick.call(link); }
    finally {
      allowedProjectDownloads.delete(link); link.remove();
      global.setTimeout(() => realm.view.URL.revokeObjectURL(url), 30000);
    }
  }
  const chaserFiles = Object.freeze({
    available: chaserPage && !!(nativeProjectPicker && nativeProjectWritable),
    directoryAvailable: chaserPage && !!(nativeDirectoryPicker && nativeProjectWritable),
    async request({ kind, name, download = false }) {
      requireChaserPage(); requireProjectGesture();
      const spec = chaserFileName(kind, name);
      const realm = fileRealm();
      const handle = !download && realm.picker && realm.writable
        ? await realm.picker({ suggestedName: name,
          types: [{ description: spec.label, accept: { [spec.mime]: [spec.suffix] } }] }) : null;
      const selectedName = handle ? handle.name : name;
      chaserFileName(kind, selectedName);
      let used = false;
      return Object.freeze({ name: selectedName, persistent: !!handle,
        async write(blob) {
          if (!handle && used) throw new Error('Choose Export again to download another file.');
          await validateChaserBlob(kind, selectedName, blob);
          if (handle) {
            const writable = await realm.writable.call(handle);
            try { await writable.write(blob); await writable.close(); }
            catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
          } else { downloadChaserBlob(blob, selectedName, realm); used = true; }
          return { name: selectedName, copyOnly: !handle };
        }
      });
    },
    async chooseDirectory() {
      requireChaserPage(); requireProjectGesture();
      const realm = fileRealm();
      if (!realm.directory || !realm.writable)
        throw new Error('This browser supports Save All as a ZIP download.');
      const folder = await realm.directory({ id: 'showave-chaser-pixelmaps', mode: 'readwrite' });
      return Object.freeze({ name: folder.name,
        async write(name, blob) {
          const kind = name.toLowerCase().endsWith('.png') ? 'png' : 'manifest';
          await validateChaserBlob(kind, name, blob);
          const handle = await folder.getFileHandle(name, { create: true });
          const writable = await realm.writable.call(handle);
          try { await writable.write(blob); await writable.close(); }
          catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
        }
      });
    }
  });
  const APPEARANCE_THEMES = new Set(['gx-classic','ultraviolet','sub-zero','frutti-di-mare','purple-haze','vaporwave','rose-quartz','coming-soon','hackerman','lambda','after-eight','pay-to-win','white-wolf','underwave','drive-by','custom']);
  // Capture the browser accessor without calling it. The only capability that
  // may invoke it is the narrow appearance reader/saver below.
  let nativeLocalStorage;
  for (let owner = global; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'localStorage');
    if (descriptor) { nativeLocalStorage = descriptor; break; }
  }
  function appearanceStorage() {
    const storage = nativeLocalStorage && (nativeLocalStorage.get
      ? nativeLocalStorage.get.call(global) : nativeLocalStorage.value);
    if (!storage) throw new Error('Browser storage is unavailable.');
    return storage;
  }
  function appearanceRecord(value) {
    // Both shipped versions use the same approved key. Read the older state
    // envelope without migrating any unrelated storage or saving implicitly.
    if (value && value.version === 1 && value.state !== undefined) {
      const prior = value.state;
      if (!prior || prior.version !== 2 || !Number.isInteger(prior.fontScale) ||
          prior.fontScale < 100 || prior.fontScale > 150 ||
          !Number.isSafeInteger(prior.updatedAt) || prior.updatedAt < 0 ||
          typeof prior.revision !== 'string' || !/^[a-z0-9:._-]{1,160}$/i.test(prior.revision))
        throw new Error('Saved appearance is invalid.');
      value = Object.assign({}, prior, { version: 1 });
    }
    if (!value || value.version !== 1 || !APPEARANCE_THEMES.has(value.theme) || !['dark','light'].includes(value.mode))
      throw new Error('Choose a valid appearance before saving.');
    const custom = {};
    for (const mode of ['dark','light']) {
      const pair = value.custom && value.custom[mode];
      if (!pair || !/^#[0-9a-f]{6}$/i.test(pair.accent) || !/^#[0-9a-f]{6}$/i.test(pair.base))
        throw new Error('Appearance colors must use six-digit hex values.');
      custom[mode] = { accent: pair.accent.toUpperCase(), base: pair.base.toUpperCase() };
    }
    const typography = value.typography === undefined
      ? { family: 'system', scale: Number.isInteger(value.fontScale) && value.fontScale >= 100 && value.fontScale <= 150 ? value.fontScale : 100, weight: 'default', italic: false } : value.typography;
    if (!typography || typeof typography !== 'object' || Array.isArray(typography)
      || typeof typography.family !== 'string' || typography.family.trim() !== typography.family
      || !typography.family.length || typography.family.length > 120 || /[\u0000-\u001f\u007f"';{}<>\\]/.test(typography.family)
      || !Number.isInteger(typography.scale) || typography.scale < 75 || typography.scale > 150
      || !['default','400','500','600','700'].includes(typography.weight) || typeof typography.italic !== 'boolean')
      throw new Error('Choose a valid interface font, scale and style before saving.');
    return { version: 1, theme: value.theme, mode: value.mode, custom,
      typography: { family: typography.family, scale: typography.scale, weight: typography.weight, italic: typography.italic } };
  }
  function readSavedAppearance() {
    try {
      const raw = appearanceStorage().getItem(APPEARANCE_KEY);
      if (raw && (typeof raw !== 'string' || raw.length > 4096)) return null;
      return raw ? appearanceRecord(JSON.parse(raw)) : null;
    } catch (_) { return null; }
  }
  function saveAppearance(value) {
    const record = appearanceRecord(value), bytes = JSON.stringify(record);
    const storage = appearanceStorage();
    storage.setItem(APPEARANCE_KEY, bytes);
    if (storage.getItem(APPEARANCE_KEY) !== bytes) throw new Error('The browser did not retain this appearance.');
    return record;
  }

  function legacySnapshot(record, source = {}) {
    const typography = Object.freeze(Object.assign({}, record.typography));
    const custom = Object.freeze({dark:Object.freeze(Object.assign({},record.custom.dark)),light:Object.freeze(Object.assign({},record.custom.light))});
    return Object.freeze({version:2,theme:record.theme,mode:record.mode,custom,typography,fontScale:typography.scale,
      updatedAt:Number.isSafeInteger(source.updatedAt)&&source.updatedAt>=0?source.updatedAt:0,
      revision:typeof source.revision==='string'&&/^[a-z0-9:._-]{1,160}$/i.test(source.revision)?source.revision:'default'});
  }
  // Compatibility for existing Preferences windows; both APIs share exactly
  // one validated durable record and cannot select a different storage key.
  const appearanceStore = Object.freeze({key:APPEARANCE_KEY,
    readSaved(){const record=readSavedAppearance();return Object.freeze({ok:true,state:record?legacySnapshot(record):null});},
    saveSaved(value){try{
      if(!value||value.version!==2)throw new Error('Saved appearance is invalid.');
      const record=saveAppearance(Object.assign({},value,{version:1}));
      return Object.freeze({ok:true,state:legacySnapshot(record,value)});
    }catch(error){return Object.freeze({ok:false,state:null,error:String(error.message||error)});}}
  });

  const CHASER_RECOVERY_KEY = 'showave.chaser.recovery.v1';
  const CHASER_RECOVERY_LIMIT = 4 * 1024 * 1024;
  function recoveryBytes(value) {
    return global.TextEncoder ? new global.TextEncoder().encode(value).byteLength
      : global.Blob ? new global.Blob([value]).size : value.length * 3;
  }
  function recoveryObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function recoveryId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
  }
  function recoveryDimensions(value) {
    return recoveryObject(value) && ['width', 'height'].every(key =>
      Number.isSafeInteger(value[key]) && value[key] >= 1 && value[key] <= 32768);
  }
  function recoveryIds(value, limit) {
    return Array.isArray(value) && value.length <= limit && value.every(recoveryId);
  }
  function recoveryGeometry(value) {
    if (!recoveryObject(value)) return false;
    if (value.vertices !== undefined)
      return Array.isArray(value.vertices) && value.vertices.length >= 3 && value.vertices.length <= 128 &&
        value.vertices.every(point => recoveryObject(point) && Number.isFinite(point.x) && Number.isFinite(point.y));
    return ['x', 'y', 'w', 'h'].every(key => Number.isFinite(value[key])) && value.w > 0 && value.h > 0;
  }
  function recoveryEnvelopes(value) {
    return Array.isArray(value) && value.length <= 512 && value.every(envelope =>
      recoveryObject(envelope) && recoveryId(envelope.id) && typeof envelope.name === 'string' &&
      envelope.name.length <= 256 && Array.isArray(envelope.points) && envelope.points.length >= 1 &&
      envelope.points.length <= 1024 && envelope.points.every(point => recoveryObject(point) &&
        ['x', 'y'].every(key => Number.isFinite(point[key]) && point[key] >= 0 && point[key] <= 1) &&
        ['inX', 'inY', 'outX', 'outY'].every(key => point[key] === undefined ||
          Number.isFinite(point[key]) && point[key] >= 0 && point[key] <= 1)));
  }
  function validateRecoveryDocument(value) {
    const invalid = () => { throw new Error('Saved Chaser recovery is not a valid Chaser document.'); };
    if (!recoveryObject(value) || value.schema !== 'showave.chaser.document/1' ||
        !recoveryObject(value.project)) invalid();
    const project = value.project, map = project.map;
    if (!recoveryObject(map) || !recoveryDimensions(map.composition) || !Array.isArray(map.screens) ||
        !map.screens.length || map.screens.length > 256 || !Array.isArray(project.sequences) ||
        !project.sequences.length || project.sequences.length > 128) invalid();
    let sliceCount = 0;
    if (!map.screens.every(screen => {
      if (!recoveryObject(screen) || !recoveryId(screen.id) || !Array.isArray(screen.slices) ||
          !screen.slices.length || screen.slices.length > 4096 ||
          screen.raster !== undefined && !recoveryDimensions(screen.raster)) return false;
      sliceCount += screen.slices.length;
      return screen.slices.every(slice => recoveryObject(slice) && recoveryId(slice.id) &&
        recoveryGeometry(slice.input || slice) &&
        (slice.output === undefined || recoveryGeometry(slice.output)));
    }) || sliceCount > 4096) invalid();
    if (!project.sequences.every(sequence => recoveryObject(sequence) && recoveryId(sequence.id) &&
        Array.isArray(sequence.steps) && sequence.steps.length >= 1 && sequence.steps.length <= 1024 &&
        sequence.steps.every(step => recoveryObject(step) && recoveryIds(step.sliceIds, 4096)))) invalid();
    if (project.envelopes !== undefined && !recoveryEnvelopes(project.envelopes)) invalid();
    if (project.views !== undefined && (!Array.isArray(project.views) || project.views.length > 512 ||
        !project.views.every(view => recoveryObject(view) && recoveryId(view.id) && recoveryIds(view.visibleSliceIds, 4096)))) invalid();
    if (value.library !== undefined && (!recoveryObject(value.library) ||
        value.library.envelopes !== undefined && !recoveryEnvelopes(value.library.envelopes))) invalid();
    if (project.nativeReference !== undefined) {
      const reference = project.nativeReference;
      if (!recoveryObject(reference) || reference.format !== 'chaser-3' || typeof reference.xml !== 'string' ||
          reference.xml.length > 8 * 1024 * 1024 || recoveryBytes(reference.xml) > 8 * 1024 * 1024) invalid();
    }
    return value;
  }
  function recoveryText(value) {
    if (typeof value !== 'string' || !value.length)
      throw new Error('Saved Chaser recovery contains invalid JSON.');
    if (value.length > CHASER_RECOVERY_LIMIT ||
        recoveryBytes(value) > CHASER_RECOVERY_LIMIT)
      throw new Error('Local Chaser recovery exceeds the 4 MiB limit. Save a project file to retain this document.');
    let parsed;
    try { parsed = JSON.parse(value); }
    catch (_) { throw new Error('Saved Chaser recovery contains invalid JSON.'); }
    return validateRecoveryDocument(parsed);
  }
  const chaserRecoveryStore = chaserPage ? Object.freeze({
    key: CHASER_RECOVERY_KEY,
    limit: CHASER_RECOVERY_LIMIT,
    read() {
      try {
        requireChaserPage();
        const raw = appearanceStorage().getItem(CHASER_RECOVERY_KEY);
        return Object.freeze({ok:true, document:raw === null ? null : recoveryText(raw)});
      } catch (error) {
        return Object.freeze({ok:false, document:null,
          error:String(error && error.message || error || 'Local Chaser recovery could not be read.')});
      }
    },
    save(document) {
      try {
        requireChaserPage();
        const raw = JSON.stringify(document);
        recoveryText(raw);
        const storage = appearanceStorage();
        storage.setItem(CHASER_RECOVERY_KEY, raw);
        if (storage.getItem(CHASER_RECOVERY_KEY) !== raw)
          throw new Error('Browser storage did not retain the local Chaser recovery document.');
        return Object.freeze({ok:true});
      } catch (error) {
        return Object.freeze({ok:false,
          error:String(error && error.message || error || 'Local Chaser recovery could not be saved.')});
      }
    }
  }) : null;
  const REGISTRY = '__openliveSessionRegistryV1__';
  const CHANNEL = 'openlive-session-memory-v1';
  const participantPage = !!(global.document && global.document.currentScript &&
    global.document.currentScript.hasAttribute('data-openlive-participant'));
  const origin = global.location && global.location.origin;
  const clientId = Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
  function sharedRegistry(candidate) {
    try {
      if (candidate && candidate.location.origin === origin && candidate[REGISTRY]) return candidate[REGISTRY];
    } catch (_) { /* Cross-origin opener or a closed window. */ }
    return null;
  }
  let registry = sharedRegistry(global.top) || sharedRegistry(global.opener);
  let awaitingSnapshot = !registry;
  if (!registry) registry = {
    clock: 0, clients: new Set(), objects: new Map(),
    local: { entries: new Map(), cleared: [0, ''] },
    session: { entries: new Map(), cleared: [0, ''] }
  };
  Object.defineProperty(global, REGISTRY, { value: registry });
  const client = { global, storage: {}, alive: true };
  registry.clients.add(client);
  let channel = null;
  let pulseTimer = null;
  let hydrateTimer = null;
  let blockedNotice = null;
  let resolveReady;
  // An independent tab cannot synchronously read another tab's memory. App
  // loaders must wait for this handshake before reading their initial document;
  // otherwise a starter document can replace the restored session on its first
  // save. Same-origin frames/opener windows already have the shared registry.
  const ready = new global.Promise(resolve => { resolveReady = resolve; });

  function assertCanWrite(action) {
    const message = (action || 'Saving') + ' is disabled for show files and recordings in this session. Appearance can be saved in Preferences.';
    if (global.document && global.document.body) {
      if (!blockedNotice) {
        blockedNotice = global.document.createElement('div');
        blockedNotice.setAttribute('role', 'alert');
        blockedNotice.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;padding:12px 16px;background:#20252b;color:#fff;border:1px solid #708090;font:14px system-ui;pointer-events:none';
        global.document.body.appendChild(blockedNotice);
      }
      blockedNotice.textContent = message;
    }
    const error = new Error(message);
    error.name = 'NotAllowedError'; error.code = 'OPENLIVE_SESSION_ONLY';
    throw error;
  }

  function compare(a, b) {
    return a[0] - b[0] || (a[1] > b[1] ? 1 : a[1] < b[1] ? -1 : 0);
  }
  function validVersion(value) {
    return Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) &&
      value[0] >= 0 && typeof value[1] === 'string';
  }
  function version() { return [++registry.clock, clientId]; }
  function liveEntries(area) {
    return Array.from(area.entries).filter(pair => pair[1].value !== null && compare(pair[1].version, area.cleared) > 0);
  }
  function get(area, key) {
    const entry = area.entries.get(key);
    return entry && compare(entry.version, area.cleared) > 0 ? entry.value : null;
  }
  function dispatch(receiver, areaName, key, oldValue, newValue, url) {
    if (!receiver.alive) return;
    // StorageEvent requires a native Storage as storageArea. A normal Event with
    // the same fields lets existing listeners use this memory-only Storage.
    const schedule = receiver.global.queueMicrotask || (fn => Promise.resolve().then(fn));
    schedule(() => {
      if (!receiver.alive) return;
      const event = new receiver.global.Event('storage');
      Object.defineProperties(event, {
        key: { value: key }, oldValue: { value: oldValue }, newValue: { value: newValue },
        url: { value: url || '' }, storageArea: { value: receiver.storage[areaName] }
      });
      receiver.global.dispatchEvent(event);
    });
  }
  function notify(areaName, key, oldValue, newValue, source, url) {
    registry.clients.forEach(receiver => {
      if (receiver !== source) dispatch(receiver, areaName, key, oldValue, newValue, url);
    });
  }
  function post(message) {
    try { if (channel) channel.postMessage(message); } catch (_) { /* Memory remains usable without a channel. */ }
  }
  function apply(message, source) {
    const area = registry[message.area];
    if (!area || !['local', 'session'].includes(message.area) || !validVersion(message.version)) return;
    registry.clock = Math.max(registry.clock, message.version[0]);
    if (message.kind === 'clear') {
      if (compare(message.version, area.cleared) <= 0) return;
      const previous = liveEntries(area);
      area.cleared = message.version;
      if (previous.some(pair => compare(pair[1].version, message.version) <= 0))
        notify(message.area, null, null, null, source, message.url);
      return;
    }
    if (message.kind !== 'set' || typeof message.key !== 'string' ||
        (message.value !== null && typeof message.value !== 'string')) return;
    const previous = area.entries.get(message.key);
    // Another newly opened tab's startup defaults cannot replace a value that
    // is already present, even during our own brief initialization period.
    if (!source && message.provisional && previous) return;
    if (compare(message.version, area.cleared) <= 0 ||
        (previous && !previous.provisional && compare(message.version, previous.version) <= 0)) return;
    const oldValue = get(area, message.key);
    area.entries.set(message.key, { value: message.value, version: message.version,
      provisional: !!message.provisional && !(source && previous && !previous.provisional) });
    if (oldValue !== message.value)
      notify(message.area, message.key, oldValue, message.value, source, message.url);
  }
  function mutate(areaName, key, value, clear) {
    const area = registry[areaName];
    if (clear ? liveEntries(area).length === 0 : get(area, key) === value) return;
    const message = { kind: clear ? 'clear' : 'set', area: areaName, key, value,
      provisional: awaitingSnapshot && !(global.navigator && global.navigator.userActivation && global.navigator.userActivation.isActive),
      version: version(), url: String(global.location && global.location.href || '') };
    apply(message, client);
    post(message);
  }
  function createStorage(areaName) {
    const area = registry[areaName], api = Object.create(null);
    Object.defineProperties(api, {
      length: { get: () => liveEntries(area).length, configurable: true },
      key: { value: index => {
        const keys = liveEntries(area); return keys[Number(index) >>> 0]?.[0] ?? null;
      }, configurable: true },
      getItem: { value: key => get(area, String(key)), configurable: true },
      setItem: { value: (key, value) => mutate(areaName, String(key), String(value), false), configurable: true },
      removeItem: { value: key => mutate(areaName, String(key), null, false), configurable: true },
      clear: { value: () => mutate(areaName, null, null, true), configurable: true },
      [Symbol.toStringTag]: { value: 'Storage', configurable: true }
    });
    return new Proxy(api, {
      get: (target, key) => typeof key === 'symbol' || key in target ? target[key] : get(area, key) ?? undefined,
      set: (target, key, value) => { if (typeof key === 'string') mutate(areaName, key, String(value), false); return true; },
      deleteProperty: (target, key) => { if (typeof key === 'string') mutate(areaName, key, null, false); return true; },
      ownKeys: () => [...Reflect.ownKeys(api), ...liveEntries(area).map(pair => pair[0]).filter(key => !(key in api))],
      getOwnPropertyDescriptor: (target, key) => Object.getOwnPropertyDescriptor(target, key) ||
        (get(area, key) !== null ? { value: get(area, key), writable: true, enumerable: true, configurable: true } : undefined)
    });
  }
  client.storage.local = createStorage('local');
  client.storage.session = createStorage('session');
  // Do not invoke the native getters, including during installation. This also
  // works when browser storage is denied and those getters would throw.
  Object.defineProperties(global, {
    localStorage: { get: () => client.storage.local, configurable: false },
    sessionStorage: { get: () => client.storage.session, configurable: false }
  });
  function snapshot() {
    return ['local', 'session'].map(name => ({ area: name, cleared: registry[name].cleared,
      entries: Array.from(registry[name].entries) }));
  }
  function receive(event) {
    const message = event && event.data;
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'hello') { post({ kind: 'snapshot', to: message.from, areas: snapshot() }); return; }
    if (message.kind === 'snapshot' && message.to === clientId && Array.isArray(message.areas)) {
      message.areas.forEach(area => {
        if (!area || !['local', 'session'].includes(area.area) || !Array.isArray(area.entries)) return;
        apply({ kind: 'clear', area: area.area, version: area.cleared }, null);
        area.entries.forEach(pair => {
          if (!Array.isArray(pair) || !pair[1]) return;
          apply({ kind: 'set', area: area.area, key: pair[0], value: pair[1].value, version: pair[1].version }, null);
        });
      });
      finishHydration();
      return;
    }
    apply(message, null);
  }
  function finishHydration() {
    awaitingSnapshot = false;
    for (const name of ['local', 'session']) registry[name].entries.forEach(entry => {
      if (entry.version[1] === clientId) entry.provisional = false;
    });
    if (hydrateTimer !== null) { global.clearTimeout(hydrateTimer); hydrateTimer = null; }
    resolveReady();
  }
  function connect() {
    try { channel = new global.BroadcastChannel(CHANNEL); channel.onmessage = receive; }
    catch (_) { channel = null; }
    if (!channel || !awaitingSnapshot) finishHydration();
    else if (awaitingSnapshot && global.setTimeout) hydrateTimer = global.setTimeout(() => {
      finishHydration();
    }, 100);
    post({ kind: 'hello', from: clientId });
  }
  const policy = Object.freeze({
    sessionOnly: true, persistentStorage: false, persistentExceptions: Object.freeze(chaserPage ? ['appearance','chaser-recovery'] : ['appearance']),
    appearanceStorageKey: APPEARANCE_KEY, readSavedAppearance, saveAppearance, appearanceStore,
    clientId, assertCanWrite, ready, projectFiles, chaserFiles, chaserRecoveryStore, sharedViewGestures,
    get hydrating() { return awaitingSnapshot; },
    shared(name, factory) {
      const key = String(name);
      if (!registry.objects.has(key)) registry.objects.set(key, factory());
      return registry.objects.get(key);
    }
  });
  Object.defineProperty(global, 'OpenLiveSessionPolicy', { value: policy });
  // Guard explicit file writes as well as automatic browser persistence. Read
  // pickers and existing-file handles are left available.
  Object.defineProperty(global, 'showSaveFilePicker', {
    value: () => Promise.resolve().then(() => assertCanWrite('Saving')), configurable: false
  });
  if (global.FileSystemFileHandle && global.FileSystemFileHandle.prototype) {
    Object.defineProperty(global.FileSystemFileHandle.prototype, 'createWritable', {
      value: () => Promise.resolve().then(() => assertCanWrite('Writing a file')), configurable: false
    });
  }
  function downloadAnchor(node) {
    return node && node.tagName === 'A' && node.hasAttribute('download');
  }
  if (global.HTMLAnchorElement && global.HTMLAnchorElement.prototype) {
    global.HTMLAnchorElement.prototype.click = function () {
      if (downloadAnchor(this)) assertCanWrite('Downloading');
      return nativeAnchorClick.call(this);
    };
  }
  if (global.document) global.document.addEventListener('click', event => {
    const anchor = event.target && event.target.closest && event.target.closest('a[download]');
    if (!anchor) return;
    if (allowedProjectDownloads.has(anchor)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try { assertCanWrite('Downloading'); } catch (_) { /* The notice explains the blocked action. */ }
  }, true);
  function pulse() {
    if (participantPage || !global.fetch || !/^https?:$/.test(global.location && global.location.protocol || '')) return;
    try {
      Promise.resolve(global.fetch('/api/session/pulse', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }),
        cache: 'no-store', credentials: 'omit', keepalive: true })).catch(() => {});
    } catch (_) { /* The browser session policy does not depend on the native tier. */ }
  }
  function startPulse() {
    // Public voting pages are participants, not owners of native Studio media
    // resources. Their presence must not extend the host's lifecycle lease.
    if (participantPage) return;
    pulse();
    if (global.setInterval && pulseTimer === null) pulseTimer = global.setInterval(pulse, 5000);
  }
  connect();
  startPulse();
  global.addEventListener('focus', pulse);
  if (global.document) global.document.addEventListener('visibilitychange', () => {
    if (!global.document.hidden) pulse();
  });
  global.addEventListener('pagehide', event => {
    if (hydrateTimer !== null) { global.clearTimeout(hydrateTimer); hydrateTimer = null; }
    if (pulseTimer !== null) { global.clearInterval(pulseTimer); pulseTimer = null; }
    try {
      if (!participantPage && global.navigator && global.navigator.sendBeacon && /^https?:$/.test(global.location.protocol))
        global.navigator.sendBeacon('/api/session/release', JSON.stringify({ clientId }));
    } catch (_) { /* The native tier also expires abandoned clients. */ }
    if (event.persisted) return;
    client.alive = false; registry.clients.delete(client);
    if (channel) { channel.close(); channel = null; }
  });
  global.addEventListener('pageshow', event => { if (event.persisted) startPulse(); });
})(window);
