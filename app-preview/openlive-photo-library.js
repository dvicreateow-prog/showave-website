/* Real images for SHOWAVE canvas elements. Commons API responses are metadata,
   never markup to execute. Downloaded pictures become validated local Files.
   https://www.mediawiki.org/wiki/API:Imageinfo
   https://www.mediawiki.org/wiki/API:Cross-site_requests
   https://commons.wikimedia.org/wiki/Commons:Machine-readable_data */
(function (global) {
  'use strict';
  const API = 'https://commons.wikimedia.org/w/api.php';
  const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_IMAGES = 60, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
  const TYPES = Object.freeze({'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'});
  const trustedPhotos = new WeakSet(), trustedImages = typeof global.OpenLiveSessionPolicy?.shared === 'function'
    ? global.OpenLiveSessionPolicy.shared('showave-canvas-image-trust-v1', () => new WeakSet()) : new WeakSet();
  const cancelled = () => Object.assign(Error('Image request cancelled.'), {name: 'AbortError'});
  function check(signal) { if (signal?.aborted) throw cancelled(); }
  function text(value, doc = global.document) {
    const raw = String(value ?? '').slice(0, 8000);
    if (!raw.trim()) return '';
    if (global.DOMParser) {
      const parsed = new global.DOMParser().parseFromString('<html><body>' + raw + '</body></html>', 'text/html');
      parsed.querySelectorAll?.('script,style').forEach(node => node.remove());
      return String(parsed.body?.textContent || parsed.documentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  function uploadURL(value) {
    let url; try { url = new global.URL(value); } catch (_) { throw Error('The photo has an invalid download address.'); }
    if (url.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/wikipedia/commons/'))
      throw Error('Photos must come from Wikimedia Commons image storage.');
    return url.href;
  }
  function thumbnailURL(value) {
    let url; try { url = new global.URL(value); } catch (_) { throw Error('The photo has an invalid thumbnail address.'); }
    if (url.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/wikipedia/commons/'))
      throw Error('Photo previews must come from Wikimedia Commons image storage.');
    return url.href;
  }
  function licenseURL(value) {
    try {
      const url = new global.URL(String(value));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !['creativecommons.org', 'commons.wikimedia.org'].includes(url.hostname)) return '';
      url.protocol = 'https:'; return url.href;
    } catch (_) { return ''; }
  }
  async function request(url, {signal, fetch: fetcher = global.fetch, timeout = 12000} = {}, consume) {
    check(signal);
    const controller = new global.AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = global.setTimeout(abort, timeout);
    try {
      const response = await fetcher(url, {signal: controller.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'});
      if (!response.ok) throw Error('The photo service is unavailable (' + response.status + '). Try again or use My Images.');
      const result = await consume(response, controller.signal); check(signal); return result;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (controller.signal.aborted || error?.name === 'AbortError') throw Error('The photo service took too long. Try again or use My Images.');
      throw error;
    } finally { global.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function bytes(response, limit, signal) {
    const advertised = Number(response.headers?.get?.('content-length'));
    if (advertised > limit) throw Error('This image is too large. Choose a picture under 16 MB.');
    if (!response.body?.getReader) {
      const buffer = await response.arrayBuffer(); check(signal);
      if (buffer.byteLength > limit) throw Error('The image service returned too much data.');
      return new Uint8Array(buffer);
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        check(signal); const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw Error('The image service returned too much data.');
        chunks.push(next.value);
      }
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } catch (error) { try { await reader.cancel(); } catch (_) {} throw error; }
    finally { reader.releaseLock?.(); }
  }
  function photoRecord(page) {
    const info = page?.imageinfo?.[0], title = String(page?.title || ''), metadata = info?.extmetadata;
    if (!title.startsWith('File:') || title.length > 300 || !info || !Object.hasOwn(TYPES, info.mime) || !metadata) return null;
    const get = key => text(metadata[key]?.value), license = get('LicenseShortName') || get('UsageTerms');
    // Unsupported or incomplete rights metadata is not guessed. Public-domain
    // and CC BY/BY-SA/CC0 records retain their own source page and conditions.
    if (!/^(?:CC BY(?:-SA)?(?: \d(?:\.\d)?)?|CC0(?: \d(?:\.\d)?)?|Public domain|PDM|PD)$/i.test(license)) return null;
    const rights = licenseURL(metadata.LicenseUrl?.value);
    if (/^CC BY/i.test(license) && !rights) return null;
    const author = get('Artist') || get('Credit'); if (!author) return null;
    let thumb, download;
    try { thumb = thumbnailURL(info.thumburl || info.url); download = uploadURL(info.thumburl || info.url); } catch (_) { return null; }
    const width = Number(info.thumbwidth || info.width), height = Number(info.thumbheight || info.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32000000) return null;
    const sourceUrl = 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(title);
    const record = Object.freeze({id: 'commons:' + String(page.pageid || title), kind: 'photo', commonsTitle: title, name: title.slice(5).replace(/\.(?:jpe?g|png|webp)$/i, '').replace(/_/g, ' '),
      category: 'Photos', source: 'Wikimedia Commons', author, sourceUrl, thumbnail: thumb, downloadUrl: download,
      width, height, mime: info.mime, license: Object.freeze({title: license, url: rights || sourceUrl,
        notice: [title.slice(5), author, license, sourceUrl, rights, get('Restrictions')].filter(Boolean).join('\n')})});
    trustedPhotos.add(record); return record;
  }
  async function search(query, {signal, fetch: fetcher, offset = 0, limit = 20} = {}) {
    const term = String(query || '').trim().slice(0, 80); if (term.length < 2) return {records: [], more: false, offset: 0};
    const count = Math.max(1, Math.min(20, Number(limit) || 20)), start = Math.max(0, Math.min(60, Math.floor(Number(offset) || 0)));
    const params = new global.URLSearchParams({action: 'query', format: 'json', formatversion: '2', origin: '*', generator: 'search',
      gsrsearch: term + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: String(count), gsroffset: String(start),
      prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '640', iiurlheight: '640',
      iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|AttributionRequired|Restrictions'});
    const data = await request(API + '?' + params, {signal, fetch: fetcher}, async (response, ownSignal) => {
      const body = await bytes(response, 2 * 1024 * 1024, ownSignal);
      return JSON.parse(new global.TextDecoder().decode(body));
    });
    if (data.error) throw Error(text(data.error.info) || 'The photo search could not be completed.');
    if (data.query && !Array.isArray(data.query.pages)) throw Error('The photo service returned an invalid result.');
    const records = (data.query?.pages || []).slice(0, count).map(photoRecord).filter(Boolean);
    const next = Number(data.continue?.gsroffset);
    return {records, more: Number.isFinite(next) && next > start && next <= 60, offset: Number.isFinite(next) ? next : start + count};
  }
  async function decodeFile(file, {signal, document: doc = global.document} = {}) {
    check(signal);
    if (!file || typeof file.arrayBuffer !== 'function' || !Object.hasOwn(TYPES, file.type) || file.size < 1 || file.size > MAX_FILE_BYTES)
      throw Error('Choose a PNG, JPEG or WebP image under 16 MB. Transparent PNG and WebP are supported.');
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer()); check(signal);
    const match = file.type === 'image/png' ? head.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => head[i] === v) :
      file.type === 'image/jpeg' ? head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255 :
      head.length >= 12 && String.fromCharCode(...head.slice(0,4)) === 'RIFF' && String.fromCharCode(...head.slice(8,12)) === 'WEBP';
    if (!match) throw Error('The image contents do not match its PNG, JPEG or WebP format.');
    if (!doc?.createElement) throw Error('The local image decoder is unavailable.');
    const image = doc.createElement('img'), url = global.URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return; settled = true; global.clearTimeout(timer); image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort);
          if (error) { reject(error); return; }
          const width = image.naturalWidth, height = image.naturalHeight;
          if (!(width > 0 && height > 0) || width > 8192 || height > 8192 || width * height > 32000000) reject(Error('Use an image up to 8192 pixels per side and 32 megapixels.'));
          else resolve({width, height});
        };
        const abort = () => finish(cancelled()), timer = global.setTimeout(() => finish(Error('This image did not decode within 10 seconds. Try another file.')), 10000);
        image.onload = () => finish(); image.onerror = () => finish(Error('This image could not be decoded. Try another PNG, JPEG or WebP.'));
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort(); else image.src = url;
      });
    } finally { image.removeAttribute('src'); image.remove?.(); global.URL.revokeObjectURL(url); }
  }
  async function createAsset(record, {signal, fetch: fetcher, document: doc} = {}) {
    check(signal);
    if (trustedImages.has(record)) { const dimensions = await decodeFile(record.file, {signal, document: doc}); return {...record, ...dimensions}; }
    if (!trustedPhotos.has(record)) throw Error('Choose a photo or image from the library.');
    // Ask the API for the insertion rendition. Thumbnail sizes are returned by
    // Commons, never manufactured by rewriting a storage URL.
    const params = new global.URLSearchParams({action: 'query', format: 'json', formatversion: '2', origin: '*', titles: record.commonsTitle,
      prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '1600', iiurlheight: '1600'});
    const data = await request(API + '?' + params, {signal, fetch: fetcher}, async (response, ownSignal) => {
      const body = await bytes(response, 512 * 1024, ownSignal); return JSON.parse(new global.TextDecoder().decode(body));
    });
    const page = data.query?.pages?.find(page => page.title === record.commonsTitle), rendition = page?.imageinfo?.[0];
    if (!rendition || !Object.hasOwn(TYPES, rendition.mime)) throw Error('This Commons photo is no longer available. Search again.');
    const url = uploadURL(rendition.thumburl || rendition.url);
    const file = await request(url, {signal, fetch: fetcher, timeout: 20000}, async (response, ownSignal) => {
      if (response.url && uploadURL(response.url) !== url) throw Error('The photo download address changed. Search again.');
      const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!Object.hasOwn(TYPES, mime)) throw Error('The photo service did not return a PNG, JPEG or WebP image.');
      const data = await bytes(response, MAX_FILE_BYTES, ownSignal);
      const name = record.name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').trim().slice(0, 100) || 'Commons photo';
      return new global.File([data], name + '.' + TYPES[mime], {type: mime});
    });
    const dimensions = await decodeFile(file, {signal, document: doc}); check(signal); return {...record, ...dimensions, downloadUrl: url, file};
  }
  function createSearchSession() {
    let revision = 0, controller = null;
    return {cancel() { revision++; controller?.abort(); controller = null; }, async run(query, options = {}) {
      const own = ++revision; controller?.abort(); controller = new global.AbortController();
      try { const result = await search(query, {...options, signal: controller.signal}); return own === revision ? {...result, stale: false} : {stale: true}; }
      catch (error) { if (own !== revision) return {stale: true}; throw error; }
    }};
  }
  function createCatalogue({indexedDB = global.indexedDB, document: doc = global.document,
    sessionOnly = false} = {}) {
    const items = new Map(), subscribers = new Set(); let db = null, closed = false, persistent = false, reason = '', serial = Promise.resolve();
    const status = () => ({persistent, sessionOnly: !persistent, reason, count: items.size, bytes: [...items.values()].reduce((n, r) => n + r.file.size, 0)});
    const notify = () => { for (const fn of subscribers) try { fn(status()); } catch (_) {} };
    const fallback = message => { persistent = false; reason = message; try { db?.close(); } catch (_) {} db = null; notify(); };
    const record = data => {
      if (!data || !/^user:[a-z0-9-]{8,80}$/i.test(data.id) || !data.blob || !Object.hasOwn(TYPES, data.mime) || data.blob.size > MAX_FILE_BYTES || !data.blob.size) return null;
      const name = String(data.name || data.fileName || 'My image').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
      const file = new global.File([data.blob], String(data.fileName || name).slice(0, 160), {type: data.mime, lastModified: Number(data.lastModified) || Date.now()});
      const item = Object.freeze({id: data.id, kind: 'image', category: 'My Images', name, file, width: Number(data.width), height: Number(data.height),
        tags: String(data.tags || '').slice(0, 300), source: 'My Images', author: 'Your image', sourceUrl: '', license: Object.freeze({title: 'User supplied', url: '', notice: 'User supplied image. Its original rights apply.'})});
      trustedImages.add(item); return item;
    };
    function transaction(mode, operation, signal) {
      return new Promise((resolve, reject) => {
        if (!db || closed) { reject(Error('Image storage is unavailable.')); return; }
        let tx, result, settled = false;
        const abort = () => { try { tx?.abort(); } catch (_) {} finish(cancelled()); };
        const finish = error => { if (settled) return; settled = true; global.clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
        const timer = global.setTimeout(() => { try { tx?.abort(); } catch (_) {} finish(Error('Image storage timed out.')); }, 5000);
        try {
          signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) { abort(); return; }
          tx = db.transaction('images', mode); tx.oncomplete = () => finish(); tx.onerror = () => finish(tx.error || Error('Image storage failed.')); tx.onabort = () => finish(tx.error || Error('Image storage was cancelled.'));
          const request = operation(tx.objectStore('images')); request.onsuccess = () => { result = request.result; }; request.onerror = () => finish(request.error || Error('Image storage failed.'));
        } catch (error) { finish(error); }
      });
    }
    const ready = (async () => {
      if (sessionOnly || !indexedDB) { reason = sessionOnly ? 'Images stay in this session.' : 'Device storage is unavailable; images stay in this session.'; return status(); }
      try {
        db = await new Promise((resolve, reject) => {
          let settled = false; const finish = (error, value) => { if (settled) { value?.close(); return; } settled = true; global.clearTimeout(timer); error ? reject(error) : resolve(value); };
          const timer = global.setTimeout(() => finish(Error('Device image storage could not open.')), 5000), request = indexedDB.open('showave-canvas-assets', 1);
          request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images', {keyPath: 'id'}); };
          request.onsuccess = () => finish(null, request.result); request.onerror = () => finish(request.error); request.onblocked = () => finish(Error('Device image storage is in use by another window.'));
        });
        if (closed) { db.close(); db = null; return status(); }
        db.onversionchange = () => fallback('Device storage changed; new images stay in this session.');
        const stored = await transaction('readonly', store => store.getAll(null, MAX_IMAGES)); let total = 0;
        for (const data of stored || []) { const item = record(data); if (item && total + item.file.size <= MAX_TOTAL_BYTES) { items.set(item.id, item); total += item.file.size; } }
        persistent = true;
      } catch (_) { fallback('Device storage is unavailable; images stay in this session.'); }
      notify(); return status();
    })();
    const enqueue = job => { const pending = serial.then(job); serial = pending.catch(() => {}); return pending; };
    return {ready, status, list(query = '') { const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean); return [...items.values()].filter(item => words.every(word => (item.name + ' ' + item.tags).toLowerCase().includes(word))); },
      importFile(file, {signal} = {}) { return enqueue(async () => {
        await ready; check(signal); if (closed) throw Error('The image catalogue has closed.');
        const dimensions = await decodeFile(file, {signal, document: doc}); check(signal);
        if (items.size >= MAX_IMAGES || status().bytes + file.size > MAX_TOTAL_BYTES) throw Error('My Images holds up to 60 images or 128 MB. Remove an image before adding more.');
        const uuid = global.crypto?.randomUUID?.() || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        const data = {id: 'user:' + uuid, name: String(file.name || 'My image').replace(/\.(?:jpe?g|png|webp)$/i, ''), fileName: file.name, mime: file.type,
          lastModified: file.lastModified, blob: file, ...dimensions};
        if (closed) throw Error('The image catalogue has closed.');
        if (persistent) try { await transaction('readwrite', store => store.put(data), signal); } catch (error) { if (signal?.aborted) throw cancelled(); fallback('Image storage is full or unavailable; new images stay in this session.'); }
        check(signal); if (closed) throw Error('The image catalogue has closed.');
        const item = record(data); items.set(item.id, item); notify(); return item;
      }); },
      remove(id) { return enqueue(async () => { await ready; if (closed || !items.has(id)) return false;
        if (persistent) try { await transaction('readwrite', store => store.delete(id)); } catch (_) { fallback('Device storage could not update. This removal applies to the current session.'); }
        items.delete(id); notify(); return true;
      }); },
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
      dispose() { closed = true; subscribers.clear(); try { db?.close(); } catch (_) {} db = null; }
    };
  }
  let catalogue;
  global.OpenLivePhotoLibrary = Object.freeze({search, createAsset, createSearchSession, createCatalogue,
    getCatalogue() { return catalogue || (catalogue = typeof global.OpenLiveSessionPolicy?.shared === 'function'
      ? global.OpenLiveSessionPolicy.shared('showave-canvas-image-catalogue-v1', () => createCatalogue()) : createCatalogue()); }, decodeFile, validateUploadURL: uploadURL,
    limits: Object.freeze({fileBytes: MAX_FILE_BYTES, images: MAX_IMAGES, totalBytes: MAX_TOTAL_BYTES})});
})(typeof window !== 'undefined' ? window : globalThis);
