/* The startup cover belongs to this browser/app profile. User images are
 * resized once and saved as a Blob, never as paths or part of a Show file. */
(function installSplashCover(global) {
  'use strict';
  if (global.OpenLiveSplashCover) return;

  const DEFAULT_URLS = Object.freeze([
    'assets/brand/showave-splash-default-1.jpg',
    'assets/brand/showave-splash-default-2.jpg'
  ]);
  const DEFAULT_URL = DEFAULT_URLS[0];
  const DEFAULT_ARTWORK = 'SHOWAVE default images';
  const DB_NAME = 'showave-splash-cover-v1';
  const STORE = 'preferences';
  const KEY = 'cover';
  const MAX_INPUT_BYTES = 25 * 1024 * 1024;
  const MAX_INPUT_PIXELS = 40 * 1000 * 1000;
  const MAX_INPUT_EDGE = 16384;
  const MAX_EDGE = 1600;
  const MAX_STORED_BYTES = 4 * 1024 * 1024;
  const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const INPUT_TYPES = new Set([...TYPES, 'image/gif']);
  const subscribers = new Set();
  const drafts = new WeakMap();
  const activeDrafts = new Set();
  let databasePromise = null;
  let loadPromise = null;
  let mutationQueue = Promise.resolve();
  let currentURL = null, currentPosterURL = null;
  let state = Object.freeze({ custom: false, url: DEFAULT_URL, name: DEFAULT_ARTWORK, width: 0, height: 0 });

  function imageError(message) { return new Error(message); }

  function checkAbort(signal) {
    if (!signal || !signal.aborted) return;
    const error = imageError('Changing the cover was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  function nativeCover() {
    const desktop = global.OpenLiveDesktop;
    if (!desktop || !desktop.splashCover) return null;
    const service = desktop.splashCover;
    if (['load', 'save', 'reset'].some(method => typeof service[method] !== 'function'))
      throw imageError('The cover preference service is unavailable. Please restart SHOWAVE.');
    return service;
  }

  function cleanName(value) {
    return String(value || 'Custom cover').split(/[\\/]/).pop()
      .replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120) || 'Custom cover';
  }

  // Read the raster dimensions before decoding. This keeps a compressed,
  // unusually large image from allocating hundreds of megabytes first.
  function rasterInfo(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const ascii = (offset, text) => text.split('').every((char, index) => bytes[offset + index] === char.charCodeAt(0));
    const orientationAt = (start, end) => {
      if (ascii(start, 'Exif\x00\x00')) start += 6;
      if (start + 8 > end) return 1;
      const little = ascii(start, 'II');
      if ((!little && !ascii(start, 'MM')) || view.getUint16(start + 2, little) !== 42) return 1;
      const directory = start + view.getUint32(start + 4, little);
      if (directory < start || directory + 2 > end) return 1;
      const count = view.getUint16(directory, little);
      for (let index = 0; index < count; index++) {
        const entry = directory + 2 + index * 12;
        if (entry + 12 > end) break;
        if (view.getUint16(entry, little) === 274 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
          const orientation = view.getUint16(entry + 8, little);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
      }
      return 1;
    };
    if (bytes.length >= 13 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return gifInfo(bytes);
    if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR')) {
      let orientation = 1;
      let offset = 8;
      let chunks = 0, animationFrames = 0;
      while (offset + 12 <= bytes.length) {
        if (++chunks > 4096) throw imageError('This PNG image could not be opened. Choose another image.');
        const size = view.getUint32(offset);
        const end = offset + 8 + size;
        if (end + 4 > bytes.length) break;
        if (ascii(offset + 4, 'eXIf')) orientation = orientationAt(offset + 8, end);
        if (ascii(offset + 4, 'acTL') && size === 8) animationFrames = view.getUint32(offset + 8);
        offset = end + 4;
      }
      return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20), orientation, animationFrames };
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2;
      let dimensions = null;
      let orientation = 1;
      let segments = 0;
      while (offset + 1 < bytes.length) {
        if (++segments > 4096) throw imageError('This JPEG image could not be opened. Choose another image.');
        if (bytes[offset++] !== 255) break;
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker === 216 || (marker >= 208 && marker <= 215)) continue;
        if (offset + 2 > bytes.length) break;
        const size = view.getUint16(offset);
        if (size < 2 || offset + size > bytes.length) break;
        if (marker === 225) orientation = orientationAt(offset + 2, offset + size);
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8) {
          dimensions = { type: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        }
        offset += size;
      }
      if (dimensions) return { ...dimensions, orientation };
    }
    if (bytes.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
      const end = view.getUint32(4, true) + 8;
      if (end > bytes.length) throw imageError('This WebP image is incomplete. Choose another image.');
      let offset = 12;
      let dimensions = null;
      let orientation = 1;
      let chunks = 0;
      while (offset + 8 <= end) {
        if (++chunks > 4096) throw imageError('This WebP image could not be opened. Choose another image.');
        const size = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (data + size > end) break;
        if (ascii(offset, 'VP8X') && size >= 10) {
          const uint24 = at => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
          dimensions = { type: 'image/webp', width: uint24(data + 4) + 1, height: uint24(data + 7) + 1 };
        }
        if (ascii(offset, 'VP8 ') && size >= 10 && bytes[data + 3] === 157 && bytes[data + 4] === 1 && bytes[data + 5] === 42) {
          if (!dimensions) dimensions = { type: 'image/webp', width: view.getUint16(data + 6, true) & 16383, height: view.getUint16(data + 8, true) & 16383 };
        }
        if (ascii(offset, 'VP8L') && size >= 5 && bytes[data] === 47) {
          const bits = view.getUint32(data + 1, true);
          if (!dimensions) dimensions = { type: 'image/webp', width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
        }
        if (ascii(offset, 'EXIF')) orientation = orientationAt(data, data + size);
        offset = data + size + (size & 1);
      }
      if (dimensions) return { ...dimensions, orientation };
    }
    throw imageError('Choose a valid JPEG, PNG, WebP or GIF image.');
  }


  // Process animation locally into an ordinary bounded APNG. The existing
  // native PNG preference store persists it without a runtime/schema change.
  const MAX_ANIMATION_FRAMES = 240;
  const MAX_ANIMATION_PIXELS = 64 * 1000 * 1000;
  const MAX_ENCODE_PIXELS = 64 * 1000 * 1000;
  function gifInfo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true), height = view.getUint16(8, true);
    let at = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0, ended = false;
    const blocks = () => { while (at < bytes.length) { const size = bytes[at++]; if (!size) return; if (at + size > bytes.length) break; at += size; } throw imageError('This GIF is incomplete. Choose another image.'); };
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 59) { ended = true; break; }
      if (marker === 33) { at++; blocks(); }
      else if (marker === 44) {
        if (at + 9 > bytes.length) break;
        const left = view.getUint16(at, true), top = view.getUint16(at + 2, true);
        const frameWidth = view.getUint16(at + 4, true), frameHeight = view.getUint16(at + 6, true);
        if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
          throw imageError('This GIF has an invalid frame size. Choose another image.');
        const flags = bytes[at + 8]; at += 9 + (flags & 128 ? 3 * (1 << ((flags & 7) + 1)) : 0);
        if (bytes[at] < 2 || bytes[at] > 8) throw imageError('This GIF has invalid image data. Choose another image.');
        at++; blocks();
        if (++frames > MAX_ANIMATION_FRAMES) throw imageError('Choose an animation with at most 240 frames.');
      } else break;
    }
    if (!ended || !frames) throw imageError('This GIF is incomplete. Choose another image.');
    return { type: 'image/gif', width, height, orientation: 1, animationFrames: frames };
  }
  function animationBudget(info) {
    if (info.animationFrames > MAX_ANIMATION_FRAMES || info.width * info.height * info.animationFrames > MAX_ANIMATION_PIXELS)
      throw imageError('Choose a shorter or smaller animation (up to 240 frames and 64 million total pixels).');
  }
  function pngChunk(tag, data) {
    const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length); bytes.set([...tag].map(char => char.charCodeAt(0)), 4); bytes.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, data.length + 8)) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0); return bytes;
  }
  function pngPoster(blob, bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts = [bytes.subarray(0, 8)];
    let at = 8;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at), end = at + length + 12;
      if (end > bytes.length) throw imageError('This animated PNG is incomplete.');
      const tag = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (!['acTL', 'fcTL', 'fdAT'].includes(tag)) parts.push(bytes.subarray(at, end));
      at = end;
    }
    return new global.Blob(parts, { type: 'image/png' });
  }
  async function animatedPoster(record) {
    if (record.blob.type !== 'image/png') return null;
    const bytes = new Uint8Array(await record.blob.arrayBuffer());
    return rasterInfo(bytes.buffer).animationFrames > 1 ? pngPoster(record.blob, bytes) : null;
  }
  async function compressedFrame(canvas, signal) {
    const width = canvas.width, height = canvas.height, stride = width * 4;
    const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const filtered = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      checkAbort(signal);
      let best, score = Infinity, filter = 0;
      for (const kind of [1, 2, 4]) {
        const row = new Uint8Array(stride); let sum = 0;
        for (let x = 0; x < stride; x++) {
          const at = y * stride + x, a = x >= 4 ? rgba[at - 4] : 0, b = y ? rgba[at - stride] : 0;
          const c = y && x >= 4 ? rgba[at - stride - 4] : 0, p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const predictor = kind === 1 ? a : kind === 2 ? b : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          const value = (rgba[at] - predictor) & 255; row[x] = value; sum += Math.min(value, 256 - value);
        }
        if (sum < score) { score = sum; best = row; filter = kind; }
      }
      filtered[y * (stride + 1)] = filter; filtered.set(best, y * (stride + 1) + 1);
    }
    return new Uint8Array(await new Response(new global.Blob([filtered]).stream().pipeThrough(new global.CompressionStream('deflate'))).arrayBuffer());
  }
  function frameDelay(duration) {
    let numerator = Math.max(0, Math.round(duration ?? 100000)), denominator = 1000000;
    let a = numerator, b = denominator; while (b) { const next = a % b; a = b; b = next; }
    numerator /= a; denominator /= a;
    if (numerator > 65535 || denominator > 65535) throw imageError('This animation uses frame timing that cannot be saved accurately.');
    return [numerator, denominator];
  }
  async function prepareAnimation(draft, transform, options) {
    const signal = options && options.signal, data = draftData(draft);
    if (typeof global.ImageDecoder !== 'function' || typeof global.CompressionStream !== 'function')
      throw imageError('Animated covers need a newer browser. Your current cover has not changed.');
    const encoded = new Uint8Array(await data.animation.arrayBuffer()); checkAbort(signal);
    const decoder = new global.ImageDecoder({ data: encoded, type: data.animation.type, preferAnimation: true });
    const canvas = global.document.createElement('canvas');
    try {
      await decoder.tracks.ready; await decoder.completed; checkAbort(signal);
      const track = decoder.tracks.selectedTrack;
      animationBudget({ ...data.animationInfo, animationFrames: track.frameCount });
      if (!track.frameCount) throw imageError('This animation has no readable frames.');
      const naturalWidth = Math.min(800, data.width, Math.floor(Math.sqrt(MAX_ENCODE_PIXELS / track.frameCount))), widths = [...new Set([naturalWidth, 640, 480, 400, 320, 240, 160].filter(width => width <= naturalWidth))];
      let processedPixels = 0;
      for (const width of widths) {
        canvas.width = width; canvas.height = Math.max(1, Math.round(width / 2));
        const header = new Uint8Array(13), headerView = new DataView(header.buffer);
        headerView.setUint32(0, canvas.width); headerView.setUint32(4, canvas.height); header[8] = 8; header[9] = 6;
        const control = new Uint8Array(8), controlView = new DataView(control.buffer);
        controlView.setUint32(0, track.frameCount); controlView.setUint32(4, track.repetitionCount === Infinity ? 0 : track.repetitionCount + 1);
        const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('acTL', control)];
        let sequence = 0, bytes = 65, oversized = false;
        for (let index = 0; index < track.frameCount; index++) {
          checkAbort(signal); draftData(draft);
          processedPixels += canvas.width * canvas.height;
          if (processedPixels > MAX_ENCODE_PIXELS) throw imageError('This animation needs too much processing. Choose a shorter or smaller animation.');
          const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
          let duration;
          try { drawDraft(draft, canvas, transform, image); duration = frameDelay(image.duration); }
          finally { image.close(); }
          const compressed = await compressedFrame(canvas, signal), frame = new Uint8Array(26), view = new DataView(frame.buffer);
          view.setUint32(0, sequence++); view.setUint32(4, canvas.width); view.setUint32(8, canvas.height);
          view.setUint16(20, duration[0]); view.setUint16(22, duration[1]); // full composited frame, SOURCE blend / NONE disposal
          const frameChunk = pngChunk('fcTL', frame); let imageChunk;
          if (index === 0) imageChunk = pngChunk('IDAT', compressed);
          else { const payload = new Uint8Array(compressed.length + 4); new DataView(payload.buffer).setUint32(0, sequence++); payload.set(compressed, 4); imageChunk = pngChunk('fdAT', payload); }
          parts.push(frameChunk, imageChunk); bytes += frameChunk.length + imageChunk.length;
          if (bytes + 12 > MAX_STORED_BYTES) { oversized = true; break; }
          // Yield between frames so the compact editor can paint its saving state.
          await new Promise(resolve => global.setTimeout(resolve, 0));
        }
        if (!oversized) {
          parts.push(pngChunk('IEND', new Uint8Array()));
          const blob = new global.Blob(parts, { type: 'image/png' });
          if (blob.size <= MAX_STORED_BYTES) return { schema: 1, blob, name: data.name, width: canvas.width, height: canvas.height };
        }
      }
      throw imageError('This animation is too detailed to save as a cover. Choose a shorter animation.');
    } finally { decoder.close(); canvas.width = canvas.height = 1; }
  }

  function database() {
    if (databasePromise) return databasePromise;
    if (!global.indexedDB) return Promise.reject(imageError('Cover storage is unavailable in this browser.'));
    databasePromise = new Promise((resolve, reject) => {
      let settled = false;
      let request;
      try { request = global.indexedDB.open(DB_NAME, 1); }
      catch (_) { reject(imageError('Cover storage could not open. Please try again.')); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        settled = true;
        reject(imageError('Cover storage could not open. Please try again.'));
      };
      request.onblocked = () => {
        settled = true;
        reject(imageError('Close another SHOWAVE tab, then try changing the cover again.'));
      };
    }).catch(error => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function read() {
    const native = nativeCover();
    if (native) {
      const record = await native.load();
      if (!record) return null;
      if (!(record.bytes instanceof global.Uint8Array) || !record.bytes.byteLength || record.bytes.byteLength > MAX_STORED_BYTES || !TYPES.has(record.type))
        throw imageError('The saved cover could not be read.');
      return { schema: record.schema, name: record.name, width: record.width, height: record.height,
        blob: new global.Blob([record.bytes], { type: record.type }) };
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(KEY);
        let value;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => reject(imageError('The saved cover could not be read.'));
      } catch (_) { reject(imageError('The saved cover could not be read.')); }
    });
  }

  async function write(record) {
    const native = nativeCover();
    if (native) {
      if (!record) { await native.reset(); return; }
      await native.save({ schema: record.schema, name: record.name, width: record.width, height: record.height,
        type: record.blob.type, bytes: new global.Uint8Array(await record.blob.arrayBuffer()) });
      return;
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction;
      const failed = () => reject(imageError('The cover could not be saved. Check available storage and try again.'));
      try {
        transaction = db.transaction(STORE, 'readwrite');
        if (record) transaction.objectStore(STORE).put(record, KEY);
        else transaction.objectStore(STORE).delete(KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = failed;
      } catch (_) {
        if (transaction) { try { transaction.abort(); } catch (_) {} }
        failed();
      }
    });
  }

  function apply(record, url, posterURL) {
    const previousURL = currentURL, previousPosterURL = currentPosterURL;
    currentPosterURL = posterURL || null;
    currentURL = record ? url : null;
    state = Object.freeze(record ? {
      custom: true, url, posterUrl: posterURL || url, animated: !!posterURL, name: cleanName(record.name), width: record.width, height: record.height
    } : { custom: false, url: DEFAULT_URL, name: DEFAULT_ARTWORK, width: 0, height: 0 });
    subscribers.forEach(listener => { try { listener(state); } catch (_) {} });
    if (previousURL && previousURL !== currentURL) global.URL.revokeObjectURL(previousURL);
    if (previousPosterURL && previousPosterURL !== currentPosterURL) global.URL.revokeObjectURL(previousPosterURL);
    return state;
  }

  async function decode(blob, options) {
    if (typeof global.createImageBitmap === 'function') {
      try { return await global.createImageBitmap(blob, options || {}); }
      catch (_) { throw imageError('This image could not be opened. Choose another JPEG, PNG, WebP or GIF image.'); }
    }
    const url = global.URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new global.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(imageError('This image could not be opened. Choose another JPEG, PNG, WebP or GIF image.'));
        image.src = url;
      });
    } finally { global.URL.revokeObjectURL(url); }
  }

  function boundedTransform(value) {
    value = value || {};
    const number = (input, fallback) => input === undefined ? fallback : Number(input);
    const zoom = number(value.zoom, 1);
    const x = number(value.x, 0.5);
    const y = number(value.y, 0.5);
    const rotation = number(value.rotation, 0);
    if (![zoom, x, y, rotation].every(Number.isFinite) || zoom < 1 || zoom > 5 || x < 0 || x > 1 || y < 0 || y > 1 || rotation % 90 !== 0)
      throw imageError('Choose a zoom from 1 to 5, an image position from 0 to 1, and a rotation in 90-degree steps.');
    return Object.freeze({ zoom, x, y, rotation: ((rotation % 360) + 360) % 360 });
  }

  function draftData(draft) {
    const data = drafts.get(draft);
    if (!data || data.disposed) throw imageError('This cover image is closed. Choose the image again.');
    return data;
  }

  function drawDraft(draft, canvas, transform, image) {
    const data = draftData(draft);
    const pose = boundedTransform(transform);
    const width = canvas && canvas.width;
    const height = canvas && canvas.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE)
      throw imageError('The cover preview size is invalid.');
    const context = canvas.getContext('2d');
    if (!context) throw imageError('The cover image could not be prepared. Please try again.');
    const swapped = pose.rotation === 90 || pose.rotation === 270;
    const rotatedWidth = swapped ? data.height : data.width;
    const rotatedHeight = swapped ? data.width : data.height;
    const scale = Math.max(width / rotatedWidth, height / rotatedHeight) * pose.zoom;
    const scaledWidth = rotatedWidth * scale;
    const scaledHeight = rotatedHeight * scale;
    const left = (width - scaledWidth) * pose.x;
    const top = (height - scaledHeight) * pose.y;
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(left + scaledWidth / 2, top + scaledHeight / 2);
      context.rotate(pose.rotation * Math.PI / 180);
      context.drawImage(image || data.image, -data.width * scale / 2, -data.height * scale / 2, data.width * scale, data.height * scale);
    } finally { context.restore(); }
    return Object.freeze({ ...pose, width, height, scaledWidth, scaledHeight, overflowX: scaledWidth - width, overflowY: scaledHeight - height });
  }

  async function openDraft(file, options) {
    const signal = options && options.signal;
    checkAbort(signal);
    if (!(file instanceof global.Blob) || !file.size) throw imageError('Choose a JPEG, PNG, WebP or GIF image.');
    if (file.size > MAX_INPUT_BYTES) throw imageError('Choose an image smaller than 25 MB.');
    if (file.type && !INPUT_TYPES.has(file.type.toLowerCase())) throw imageError('Choose a JPEG, PNG, WebP or GIF image.');
    const info = rasterInfo(await file.arrayBuffer());
    animationBudget(info);
    if (info.animationFrames > 1 && (typeof global.ImageDecoder !== 'function' || typeof global.CompressionStream !== 'function'))
      throw imageError('Animated covers need a newer browser. Your current cover has not changed.');
    checkAbort(signal);
    if (!info.width || !info.height || info.width > MAX_INPUT_EDGE || info.height > MAX_INPUT_EDGE || info.width * info.height > MAX_INPUT_PIXELS)
      throw imageError('Choose an image with at most 40 million pixels and no side larger than 16,384 pixels.');
    const scale = Math.min(1, MAX_EDGE / Math.max(info.width, info.height));
    const swapped = info.orientation >= 5 && info.orientation <= 8;
    const width = Math.max(1, Math.round((swapped ? info.height : info.width) * scale));
    const height = Math.max(1, Math.round((swapped ? info.width : info.height) * scale));
    // The browser applies EXIF orientation during decode. Dimensions from the
    // resulting bitmap, rather than the file header, keep portrait images upright.
    const bitmap = await decode(file, { imageOrientation: 'from-image', resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    const canvas = global.document.createElement('canvas');
    const decodedWidth = bitmap.width || bitmap.naturalWidth;
    const decodedHeight = bitmap.height || bitmap.naturalHeight;
    const decodedScale = Math.min(1, MAX_EDGE / Math.max(decodedWidth, decodedHeight));
    canvas.width = Math.max(1, Math.round(decodedWidth * decodedScale));
    canvas.height = Math.max(1, Math.round(decodedHeight * decodedScale));
    try {
      checkAbort(signal);
      const context = canvas.getContext('2d');
      if (!context) throw imageError('The cover image could not be prepared. Please try again.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      checkAbort(signal);
      const data = { image: canvas, name: cleanName(file.name), width: canvas.width, height: canvas.height, disposed: false, animation: info.animationFrames > 1 ? new global.Blob([file], { type: info.type }) : null, animationInfo: info };
      const draft = Object.freeze({
        name: data.name, width: data.width, height: data.height, image: canvas, animated: !!data.animation,
        get disposed() { return data.disposed; },
        draw: (target, transform) => drawDraft(draft, target, transform),
        dispose: () => {
          if (data.disposed) return;
          data.disposed = true;
          canvas.width = canvas.height = 1;
          activeDrafts.delete(draft);
        }
      });
      drafts.set(draft, data);
      activeDrafts.add(draft);
      return draft;
    } catch (error) {
      canvas.width = canvas.height = 1;
      throw error;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function prepareDraft(draft, transform, options) {
    const signal = options && options.signal;
    checkAbort(signal);
    const data = draftData(draft);
    if (data.animation) return prepareAnimation(draft, transform || {}, options);
    const canvas = global.document.createElement('canvas');
    canvas.width = transform ? MAX_EDGE : data.width;
    canvas.height = transform ? MAX_EDGE / 2 : data.height;
    try {
      if (transform) drawDraft(draft, canvas, transform);
      else {
        const context = canvas.getContext('2d');
        if (!context) throw imageError('The cover image could not be prepared. Please try again.');
        context.drawImage(data.image, 0, 0, canvas.width, canvas.height);
      }
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(imageError('The cover image could not be prepared.')), 'image/webp', 0.88);
      });
      checkAbort(signal);
      draftData(draft);
      if (!TYPES.has(blob.type) || !blob.size || blob.size > MAX_STORED_BYTES)
        throw imageError('This image could not be saved as a cover. Choose another image.');
      return { schema: 1, blob, name: data.name, width: canvas.width, height: canvas.height };
    } finally { canvas.width = canvas.height = 1; }
  }

  async function savePrepared(record, signal) {
    checkAbort(signal);
    const poster = await animatedPoster(record); checkAbort(signal);
    const url = global.URL.createObjectURL(record.blob), posterURL = poster ? global.URL.createObjectURL(poster) : null;
    try {
      // Once storage begins this is an atomic save; draft cancellation only
      // discards preparation. No source image or editing history is persisted.
      await write(record);
    } catch (error) { global.URL.revokeObjectURL(url); if (posterURL) global.URL.revokeObjectURL(posterURL); throw error; }
    return apply(record, url, posterURL);
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const record = await read();
        if (!record || record.schema !== 1 || !(record.blob instanceof global.Blob) || !TYPES.has(record.blob.type) ||
            !record.blob.size || record.blob.size > MAX_STORED_BYTES || !Number.isInteger(record.width) || !Number.isInteger(record.height) ||
            record.width < 1 || record.height < 1 || record.width > MAX_EDGE || record.height > MAX_EDGE) return state;
        const info = rasterInfo(await record.blob.arrayBuffer());
        if (info.width !== record.width || info.height !== record.height) return state;
        const bitmap = await decode(record.blob);
        if (typeof bitmap.close === 'function') bitmap.close();
        const poster = await animatedPoster(record);
        return apply(record, global.URL.createObjectURL(record.blob), poster ? global.URL.createObjectURL(poster) : null);
      } catch (_) {
        // Startup remains usable if storage is unavailable or a saved image is
        // damaged. A later explicit write still reports its storage error.
        return state;
      }
    })();
    return loadPromise;
  }

  function enqueue(action) {
    const result = mutationQueue.then(action);
    mutationQueue = result.catch(() => {});
    return result;
  }

  global.OpenLiveSplashCover = Object.freeze({
    defaultUrls: DEFAULT_URLS,
    defaultArtwork: DEFAULT_ARTWORK,
    load,
    get: () => state,
    openDraft,
    drawDraft,
    commitDraft: (draft, transform, options) => enqueue(async () => {
      const signal = options && options.signal;
      checkAbort(signal);
      await load();
      const record = await prepareDraft(draft, transform || {}, options);
      draftData(draft);
      return savePrepared(record, signal);
    }),
    setFile: (file, transform, options) => enqueue(async () => {
      const signal = options && options.signal;
      checkAbort(signal);
      await load();
      const draft = await openDraft(file, options);
      try { return await savePrepared(await prepareDraft(draft, transform, options), signal); }
      finally { draft.dispose(); }
    }),
    reset: () => enqueue(async () => {
      await load();
      if (!state.custom) return state;
      await write(null);
      return apply(null);
    }),
    subscribe: listener => {
      if (typeof listener !== 'function') throw new TypeError('A cover change listener must be a function.');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }
  });
  global.addEventListener('unload', () => {
    activeDrafts.forEach(draft => draft.dispose());
    if (currentURL) global.URL.revokeObjectURL(currentURL);
    if (currentPosterURL) global.URL.revokeObjectURL(currentPosterURL);
  }, { once: true });
})(window);
