/* Local, immutable replacement artwork for SVG pieces. No network or scene writes.
 * UNDOCUMENTED — inferring: application asset storage, not Arena composition semantics.
 * Session policy keeps imported artwork and folders in RAM without opening an
 * existing IndexedDB library. Related windows share those live Blob references.
 */
(function (root) {
  'use strict';
  var SESSION_ONLY = root.OpenLiveSessionPolicy && root.OpenLiveSessionPolicy.sessionOnly === true;
  var MEMORY_ONLY = SESSION_ONLY || root.__SHOWAVE_SVG_IMAGE_MEMORY_ONLY__ === true;
  var DB_NAME = 'showave-svg-images', DB_VERSION = 1;
  var MAX_INPUT = 10 * 1024 * 1024, MAX_BLOB = 4 * 1024 * 1024;
  var MAX_BYTES = 64 * 1024 * 1024, MAX_ASSETS = 128, MAX_CACHE = 32;
  var IO_TIMEOUT = 15000, DB_TIMEOUT = 10000;
  var ID_RE = /^svgimg-[a-f0-9]{64}$/;
  var sessionAssets = SESSION_ONLY ? root.OpenLiveSessionPolicy.shared('svg-images',
    function () { return {images:new Map(),bytes:0,library:null,listeners:new Set()}; })
    : {images:new Map(),bytes:0,library:null,listeners:new Set()};
  var memory = sessionAssets.images, cache = new Map();
  var dbPromise = null, dbHandle = null, importTail = Promise.resolve(), importCount = 0;
  var listeners = sessionAssets.listeners;
  function changed() { listeners.forEach(function (fn) { try { fn(); } catch (_) {} }); }
  function libraryState(raw) {
    if (raw === undefined || raw === null) return { key:'library', version:1, nextId:0, folders:[], placements:{} };
    if (raw.key !== 'library' || raw.version !== 1 || !Number.isSafeInteger(raw.nextId) || raw.nextId < 0 ||
        !Array.isArray(raw.folders) || raw.folders.length > 50 || !raw.placements || typeof raw.placements !== 'object' || Array.isArray(raw.placements))
      throw failure('Local folder metadata is invalid. Nothing was changed.');
    var ids = new Set(), names = new Set();
    raw.folders.forEach(function (folder) {
      if (!folder || !/^folder-[1-9][0-9]*$/.test(folder.id) || ids.has(folder.id) || typeof folder.name !== 'string' ||
          folder.name !== folderName(folder.name) || names.has(folder.name.toLowerCase()) || Number(folder.id.slice(7)) > raw.nextId)
        throw failure('Local folder metadata is invalid. Nothing was changed.');
      ids.add(folder.id); names.add(folder.name.toLowerCase());
    });
    if (Object.keys(raw.placements).length > MAX_ASSETS || Object.entries(raw.placements).some(function (entry) { return !ID_RE.test(entry[0]) || !ids.has(entry[1]); }))
      throw failure('Local folder assignments are invalid. Nothing was changed.');
    return JSON.parse(JSON.stringify(raw));
  }
  function folderName(value) {
    if (typeof value !== 'string') throw failure('Enter a folder name.');
    var name = value.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60 || /[\\/<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name))
      throw failure('Use a folder name of 1–60 characters without slashes or control characters.');
    if (name.toLowerCase() === 'uploads') throw failure('Uploads is reserved for unfiled images.');
    return name;
  }
  function requireFolder(state, id) {
    if (id !== 'uploads' && !state.folders.some(function (folder) { return folder.id === id; }))
      throw failure('This folder no longer exists. Choose another folder and retry.');
  }
  function assignFolder(state, imageId, folderId) {
    requireFolder(state, folderId);
    if (folderId === 'uploads') delete state.placements[imageId]; else state.placements[imageId] = folderId;
  }
  async function editLibrary(work) {
    var result;
    if (MEMORY_ONLY) {
      var next = libraryState(sessionAssets.library); result = work(next, function (id) { return memory.has(id); }); sessionAssets.library = next;
    } else result = await transaction(await openDb(), 'readwrite', function (tx, done, abort) {
      var request = tx.objectStore('meta').get('library'), images = tx.objectStore('images').getAll(), ready = 0;
      function complete() {
        if (++ready !== 2) return;
        try {
          var next = libraryState(request.result), ids = new Set(images.result.map(function (image) { return image.id; }));
          var value = work(next, function (id) { return ids.has(id); });
          tx.objectStore('meta').put(next); done(value);
        } catch (error) { abort(error); }
      }
      request.onsuccess = images.onsuccess = complete;
      request.onerror = images.onerror = function () { abort(storageError(request.error || images.error)); };
    });
    changed(); return result;
  }
  function createFolder(name) {
    return editLibrary(function (state) {
      name = folderName(name);
      if (state.folders.length >= 50) throw failure('You can create up to 50 folders.');
      if (state.folders.some(function (folder) { return folder.name.toLowerCase() === name.toLowerCase(); })) throw failure('A folder with this name already exists.');
      var folder = {id:'folder-' + (++state.nextId), name:name}; state.folders.push(folder); return Object.freeze({...folder});
    });
  }
  function removeFolder(id) {
    return editLibrary(function (state) {
      if (id === 'uploads') throw failure('The Uploads folder cannot be removed.');
      requireFolder(state,id); state.folders = state.folders.filter(function (folder) { return folder.id !== id; });
      Object.keys(state.placements).forEach(function (imageId) { if (state.placements[imageId] === id) delete state.placements[imageId]; });
      return true;
    });
  }
  function moveImage(id, folderId) {
    return editLibrary(function (state, has) {
      if (!ID_RE.test(id) || !has(id)) throw failure('This local image is unavailable.');
      assignFolder(state,id,folderId); return true;
    });
  }
  async function listLibrary() {
    var data = MEMORY_ONLY ? {library:sessionAssets.library, images:Array.from(memory.values())} : await transaction(await openDb(), 'readonly', function (tx, done, abort) {
      var library = tx.objectStore('meta').get('library'), images = tx.objectStore('images').getAll(), ready = 0;
      function complete() { if (++ready === 2) done({library:library.result,images:images.result}); }
      library.onsuccess = images.onsuccess = complete;
      library.onerror = images.onerror = function () { abort(storageError(library.error || images.error)); };
    });
    var state = libraryState(data.library);
    return {folders:[{id:'uploads',name:'Uploads'},...state.folders],assets:data.images.map(function (record) {
      return {id:record.id,name:safeName(record.name),width:record.width,height:record.height,folderId:state.placements[record.id] || 'uploads'};
    })};
  }

  function failure(message, cause) {
    var error = new Error(message);
    if (cause) error.cause = cause;
    return error;
  }
  function storageError(error) {
    if (error && error.name === 'QuotaExceededError') return failure('Local image storage quota is full. No image was saved.', error);
    return failure('Durable local image storage is unavailable or failed. No temporary fallback was used.', error);
  }
  function timed(promise, message, delay) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(failure(message)); }, delay || IO_TIMEOUT);
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });
    });
  }
  function dimensions(width, height, stored) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > (stored ? 1920 : 8192) || height > (stored ? 1080 : 8192) || width * height > 32000000) {
      throw failure(stored ? 'Stored image dimensions are invalid.' : 'Image dimensions exceed 8192 pixels per side or 32 megapixels.');
    }
    return { width: width, height: height };
  }
  function word(bytes, index) { return String.fromCharCode.apply(null, bytes.subarray(index, index + 4)); }
  function pngInfo(bytes) {
    var signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every(function (v, i) { return bytes[i] === v; })) throw failure('The file does not have a valid PNG signature.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), info = null, data = false, ended = false;
    for (var offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw failure('PNG data is truncated.');
      var length = view.getUint32(offset), type = word(bytes, offset + 4), next = offset + 12 + length;
      if (next > bytes.length) throw failure('PNG chunk data is truncated.');
      if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw failure('PNG image header is invalid.');
      if (type === 'IHDR') {
        if (info || length !== 13) throw failure('PNG image header is invalid.');
        info = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      }
      if (type === 'acTL') throw failure('Animated PNG is not supported. Choose a still PNG, JPEG, or WebP image.');
      if (type === 'IDAT') data = true;
      if (type === 'IEND') {
        if (length || next !== bytes.length) throw failure('PNG ending is invalid.');
        ended = true; break;
      }
      offset = next;
    }
    if (!info || !data || !ended) throw failure('PNG image data is incomplete.');
    return info;
  }
  function jpegInfo(bytes) {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw failure('The file does not have a valid JPEG signature.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var sof = [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207];
    for (var offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 255) throw failure('JPEG marker data is invalid.');
      while (bytes[offset] === 255) offset++;
      var marker = bytes[offset++];
      if (marker === 218 || marker === 217 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      var length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw failure('JPEG segment data is truncated.');
      if (sof.indexOf(marker) !== -1) {
        if (length < 8) throw failure('JPEG image header is invalid.');
        return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    throw failure('JPEG dimensions could not be safely read.');
  }
  function webpInfo(bytes) {
    if (bytes.length < 20 || word(bytes, 0) !== 'RIFF' || word(bytes, 8) !== 'WEBP') throw failure('The file does not have a valid WebP signature.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), canvas = null, info = null;
    if (view.getUint32(4, true) + 8 !== bytes.length) throw failure('WebP container length is invalid.');
    for (var offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw failure('WebP chunk data is truncated.');
      var type = word(bytes, offset), length = view.getUint32(offset + 4, true), start = offset + 8;
      var next = start + length + (length & 1), current = null;
      if (next > bytes.length) throw failure('WebP chunk data is truncated.');
      if (type === 'ANIM' || type === 'ANMF') throw failure('Animated WebP is not supported. Choose a still image.');
      if (type === 'VP8X') {
        if (canvas || length !== 10) throw failure('WebP extended header is invalid.');
        if (bytes[start] & 2) throw failure('Animated WebP is not supported. Choose a still image.');
        canvas = dimensions(1 + bytes[start + 4] + bytes[start + 5] * 256 + bytes[start + 6] * 65536,
          1 + bytes[start + 7] + bytes[start + 8] * 256 + bytes[start + 9] * 65536);
      } else if (type === 'VP8 ') {
        if (length < 10 || bytes[start + 3] !== 157 || bytes[start + 4] !== 1 || bytes[start + 5] !== 42) throw failure('WebP image header is invalid.');
        current = dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383);
      } else if (type === 'VP8L') {
        if (length < 5 || bytes[start] !== 47) throw failure('WebP lossless header is invalid.');
        var bits = view.getUint32(start + 1, true);
        current = dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
      }
      if (current) {
        if (info) throw failure('WebP contains multiple images.');
        info = current;
      }
      offset = next;
    }
    if (!info || (canvas && (canvas.width !== info.width || canvas.height !== info.height))) throw failure('WebP dimensions are invalid or inconsistent.');
    return info;
  }
  function inspect(bytes, type) {
    if (type === 'image/png') return pngInfo(bytes);
    if (type === 'image/jpeg') return jpegInfo(bytes);
    if (type === 'image/webp') return webpInfo(bytes);
    throw failure('Choose a local PNG, JPEG, or WebP file. SVG and remote URLs are not supported.');
  }
  async function bytesOf(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') throw failure('This browser cannot safely read local image files.');
    return new Uint8Array(await timed(blob.arrayBuffer(), 'Reading the image timed out.'));
  }
  async function digest(bytes) {
    if (!root.crypto || !root.crypto.subtle) throw failure('Secure browser hashing is unavailable. Use a secure or local app address.');
    var hash = await timed(root.crypto.subtle.digest('SHA-256', bytes), 'Image hashing timed out.');
    return 'svgimg-' + Array.from(new Uint8Array(hash), function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }
  function safeName(name) {
    return (String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Imported image');
  }
  function decode(blob) {
    return new Promise(function (resolve, reject) {
      if (typeof root.Image !== 'function' || !root.URL || typeof root.URL.createObjectURL !== 'function') return reject(failure('Local image decoding is unavailable in this browser.'));
      var image, url, timer, finished = false;
      function finish(error) {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (image) image.onload = image.onerror = null;
        if (url) root.URL.revokeObjectURL(url);
        if (error) { if (image) image.src = ''; reject(error); }
        else resolve(image);
      }
      try {
        image = new root.Image();
        url = root.URL.createObjectURL(blob);
        image.onload = function () { finish(); };
        image.onerror = function () { finish(failure('The image could not be decoded. It may be damaged or unsupported.')); };
        timer = setTimeout(function () { finish(failure('Image decoding timed out.')); }, IO_TIMEOUT);
        image.src = url;
      } catch (error) { finish(failure('Local image decoding failed.', error)); }
    });
  }
  function encode(canvas) {
    return timed(new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob !== 'function') return reject(failure('PNG image encoding is unavailable in this browser.'));
      canvas.toBlob(function (blob) {
        if (!blob || blob.type !== 'image/png' || !blob.size) reject(failure('The browser could not encode a PNG image.'));
        else resolve(blob);
      }, 'image/png');
    }), 'PNG image encoding timed out.');
  }
  async function normalize(file) {
    if (typeof root.Blob !== 'function' || !(file instanceof root.Blob) || typeof file.name !== 'string' ||
        ['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) === -1) throw failure('Choose a local PNG, JPEG, or WebP file. SVG and remote URLs are not supported.');
    if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_INPUT) throw failure('Choose an image no larger than 10 MiB.');
    var bytes = await bytesOf(file);
    if (bytes.byteLength !== file.size || bytes.byteLength > MAX_INPUT) throw failure('The image file size is invalid.');
    var header = inspect(bytes, file.type), image = await decode(file), canvas;
    try {
      var width = image.naturalWidth, height = image.naturalHeight;
      dimensions(width, height);
      var matches = width === header.width && height === header.height;
      if (!matches && !(file.type === 'image/jpeg' && width === header.height && height === header.width)) throw failure('Decoded image dimensions do not match the file header.');
      if (!root.document || typeof root.document.createElement !== 'function') throw failure('Image normalization is unavailable in this browser.');
      canvas = root.document.createElement('canvas');
      var scale = Math.min(1, 1920 / width, 1080 / height), blob;
      // A bounded second reduction allows photographic PNGs to fit the durable byte cap.
      for (var attempt = 0; attempt < 5; attempt++) {
        canvas.width = Math.max(1, Math.floor(width * scale));
        canvas.height = Math.max(1, Math.floor(height * scale));
        var context = canvas.getContext('2d', { alpha: true });
        if (!context) throw failure('A transparent image canvas is unavailable.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        blob = await encode(canvas);
        if (blob.size <= MAX_BLOB) break;
        scale *= 0.75;
      }
      if (blob.size > MAX_BLOB) throw failure('Normalized PNG exceeds the 4 MiB storage limit. Choose a smaller image.');
      bytes = await bytesOf(blob);
      var encoded = pngInfo(bytes);
      dimensions(encoded.width, encoded.height, true);
      if (encoded.width !== canvas.width || encoded.height !== canvas.height || bytes.byteLength !== blob.size) throw failure('Encoded PNG dimensions or size are inconsistent.');
      return { id: await digest(bytes), name: safeName(file.name), width: canvas.width, height: canvas.height, bytes: blob.size, mime: 'image/png', blob: blob };
    } finally {
      image.src = '';
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB || typeof root.indexedDB.open !== 'function') return reject(storageError());
      var request, timer, settled = false;
      function fail(error) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      }
      timer = setTimeout(function () { fail(failure('Opening durable image storage timed out.')); }, DB_TIMEOUT);
      try { request = root.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (error) { fail(storageError(error)); return; }
      request.onerror = function () { fail(storageError(request.error)); };
      request.onblocked = function () { fail(failure('Local image storage is blocked by another app tab. Close older tabs and retry.')); };
      request.onupgradeneeded = function (event) {
        try {
          if (settled || event.oldVersion !== 0) { request.transaction.abort(); return; }
          request.result.createObjectStore('images', { keyPath: 'id' });
          request.result.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'usage', bytes: 0, count: 0 });
        } catch (error) { try { request.transaction.abort(); } catch (_) {} fail(storageError(error)); }
      };
      request.onsuccess = function () {
        var db = request.result;
        if (settled) { db.close(); return; }
        if (!db.objectStoreNames.contains('images') || !db.objectStoreNames.contains('meta')) { db.close(); fail(failure('Local image storage has an incompatible schema.')); return; }
        settled = true; clearTimeout(timer); dbHandle = db;
        function release() { if (dbHandle === db) { dbHandle = null; dbPromise = null; } }
        db.onversionchange = function () { db.close(); release(); };
        db.onclose = release;
        resolve(db);
      };
    });
    var pending = dbPromise;
    pending.catch(function () { if (dbPromise === pending) dbPromise = null; });
    return pending;
  }
  function transaction(db, mode, work) {
    return new Promise(function (resolve, reject) {
      var tx, timer, result, reason, settled = false;
      function finish(error) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      }
      function abort(error) {
        reason = error;
        try { tx.abort(); } catch (_) {}
        finish(error);
      }
      try {
        // Strict durability is advisory where supported; older implementations ignore options.
        tx = db.transaction(['images', 'meta'], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
        tx.oncomplete = function () { finish(reason); };
        tx.onabort = function () { finish(reason || storageError(tx.error)); };
        tx.onerror = function () { abort(reason || storageError(tx.error)); };
        timer = setTimeout(function () { abort(failure('The durable image storage transaction timed out.')); }, DB_TIMEOUT);
        work(tx, function (value) { result = value; }, abort);
      } catch (error) { if (tx) abort(storageError(error)); else finish(storageError(error)); }
    });
  }
  function validUsage(usage) {
    return usage && usage.key === 'usage' && Number.isInteger(usage.bytes) && usage.bytes >= 0 && usage.bytes <= MAX_BYTES &&
      Number.isInteger(usage.count) && usage.count >= 0 && usage.count <= MAX_ASSETS;
  }
  function cap(bytes, count, addition) {
    if (count >= MAX_ASSETS || bytes + addition > MAX_BYTES) throw failure('Local image library is full (128 images or 64 MiB). No existing images were deleted.');
  }
  async function save(record, folderId) {
    if (MEMORY_ONLY) {
      var next = libraryState(sessionAssets.library);
      if (folderId !== undefined) assignFolder(next,record.id,folderId);
      if (!memory.has(record.id)) { cap(sessionAssets.bytes, memory.size, record.bytes); memory.set(record.id, record); sessionAssets.bytes += record.bytes; }
      sessionAssets.library = next; return memory.get(record.id);
    }
    return transaction(await openDb(), 'readwrite', function (tx, done, abort) {
      var images = tx.objectStore('images'), meta = tx.objectStore('meta');
      var found = images.get(record.id), usage = meta.get('usage'), library = meta.get('library'), ready = 0;
      function complete() {
        if (++ready !== 3) return;
        try {
          if (!validUsage(usage.result)) throw failure('Local image storage accounting is invalid. Nothing was saved.');
          if (folderId !== undefined) { var next = libraryState(library.result); assignFolder(next,record.id,folderId); meta.put(next); }
          if (found.result) { done(found.result); return; }
          cap(usage.result.bytes, usage.result.count, record.bytes);
          images.add(record);
          meta.put({ key: 'usage', bytes: usage.result.bytes + record.bytes, count: usage.result.count + 1 });
          done(record);
        } catch (error) { abort(error); }
      }
      found.onsuccess = usage.onsuccess = library.onsuccess = complete;
      found.onerror = usage.onerror = library.onerror = function () { abort(storageError(found.error || usage.error || library.error)); };
    });
  }
  async function read(id) {
    if (MEMORY_ONLY) return memory.get(id);
    return transaction(await openDb(), 'readonly', function (tx, done, abort) {
      var request = tx.objectStore('images').get(id);
      request.onsuccess = function () { done(request.result); };
      request.onerror = function () { abort(storageError(request.error)); };
    });
  }
  async function validateRecord(record, id) {
    if (!record) throw failure('This local image is missing from this browser. Import the original image again.');
    if (record.id !== id || typeof record.name !== 'string' || record.name !== safeName(record.name) || record.mime !== 'image/png' ||
        !(record.blob instanceof root.Blob || (SESSION_ONLY && Object.prototype.toString.call(record.blob) === '[object Blob]')) || record.blob.type !== 'image/png' || !Number.isInteger(record.bytes) ||
        record.bytes < 1 || record.bytes > MAX_BLOB || record.blob.size !== record.bytes) throw failure('Stored image metadata or data is corrupt.');
    dimensions(record.width, record.height, true);
    var bytes = await bytesOf(record.blob), info = pngInfo(bytes);
    if (bytes.byteLength !== record.bytes || info.width !== record.width || info.height !== record.height || await digest(bytes) !== id) throw failure('Stored image content failed its integrity check.');
    return record;
  }
  function room() {
    if (cache.size < MAX_CACHE) return;
    for (var pair of cache) {
      if (pair[1].state !== 'loading') { cache.delete(pair[0]); return; }
    }
    throw failure('Too many local images are loading. Wait for them to finish and retry.');
  }
  function load(id, options) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.reject(failure('Invalid local image reference.'));
    var existing = cache.get(id);
    if (existing && !(existing.state === 'failed' && options && options.retry === true)) {
      cache.delete(id); cache.set(id, existing); return existing.promise;
    }
    if (existing) cache.delete(id);
    try { room(); } catch (error) { return Promise.reject(error); }
    var entry = { state: 'loading', error: null, promise: null };
    cache.set(id, entry);
    entry.promise = (async function () {
      var record = await validateRecord(await read(id), id), image = await decode(record.blob);
      if (image.naturalWidth !== record.width || image.naturalHeight !== record.height) { image.src = ''; throw failure('Stored image decoded to inconsistent dimensions.'); }
      entry.state = 'ready';
      return Object.freeze({ id: id, name: record.name, image: image, width: record.width, height: record.height });
    })().catch(function (error) { entry.state = 'failed'; entry.error = error.message || 'Local image loading failed.'; throw error; });
    // Consumers still receive the rejection; the shared pending promise is never unhandled.
    entry.promise.catch(function () {});
    return entry.promise;
  }
  function importFile(file, options) {
    var folderId = options && options.folderId;
    if (importCount >= 4) return Promise.reject(failure('Four image imports are already queued. Wait for them to finish.'));
    importCount++;
    var task = importTail.then(async function () {
      var candidate = await normalize(file), record = await validateRecord(await save(candidate,folderId), candidate.id);
      // A previously missing reference can become available after re-import.
      var old = cache.get(record.id);
      // Also detach an earlier pending missing-asset read: its callers still receive
      // their result, but it cannot leave a failed cache entry after this import.
      if (old && old.state !== 'ready') cache.delete(record.id);
      changed(); return Object.freeze({ id: record.id, name: record.name, width: record.width, height: record.height });
    });
    importTail = task.catch(function () {}).then(function () { importCount--; });
    return task;
  }
  function status(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return Object.freeze({ state: 'failed', error: 'Invalid local image reference.' });
    var entry = cache.get(id);
    return Object.freeze({ state: entry ? entry.state : 'idle', error: entry ? entry.error : null });
  }
  root.OpenLiveSvgImages = Object.freeze({ importFile: importFile, load: load, status: status,
    listLibrary:listLibrary, createFolder:createFolder, removeFolder:removeFolder, moveImage:moveImage,
    subscribe:function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; } });
})(window);
