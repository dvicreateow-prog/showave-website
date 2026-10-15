import { i as gsap } from './vendor-gsap-GRoENYFU.js';
import { warmAssets } from '/showave-assets/scene-preparation.js?v=perf-1';

const cache = new Map();
const pending = new Map();
const loadQueue = [];
const instances = new Set();
const canvasPainter = new WeakMap();
const MAX_LOADS = 2;
const MAX_PIXELS = 1000000;
let activeLoads = 0;
let decodedBytes = 0;

function cacheBudget() {
  return (window.matchMedia('(max-width: 767px)').matches ? 32 : 64) * 1024 * 1024;
}
function closeImage(image) {
  if (!image) return;
  if (typeof image.close === 'function') image.close();
  else { image.onload = image.onerror = null; image.removeAttribute?.('src'); }
}
function touch(entry) {
  if (!cache.has(entry.key)) return;
  cache.delete(entry.key);
  cache.set(entry.key, entry);
}
function releaseIndex(owner, index) {
  const entry = owner.images[index];
  if (!entry) return;
  owner.images[index] = null;
  owner.loadedSet.delete(index);
  const indexes = entry.owners.get(owner);
  indexes?.delete(index);
  if (!indexes?.size) entry.owners.delete(owner);
}
function evict(entry) {
  if (!cache.has(entry.key)) return;
  for (const [owner, indexes] of [...entry.owners]) {
    for (const index of [...indexes]) releaseIndex(owner, index);
  }
  cache.delete(entry.key);
  decodedBytes -= entry.bytes;
  closeImage(entry.image);
  entry.image = null;
}
function trimCache() {
  const limit = cacheBudget();
  for (const entry of cache.values()) {
    if (decodedBytes <= limit) break;
    const displayed = [...entry.owners].some(([owner]) =>
      !owner._destroyed && owner._near && owner._displayedKey === entry.key);
    if (!displayed) evict(entry);
  }
  // Already painted canvas pixels survive bitmap disposal. Even many active
  // sequences must not turn the byte budget into an unbounded soft limit.
  for (const entry of cache.values()) {
    if (decodedBytes <= limit) break;
    evict(entry);
  }
}
function cancelConsumer(owner, index) {
  for (const job of pending.values()) {
    const indexes = job.consumers.get(owner);
    if (!indexes?.has(index)) continue;
    indexes.delete(index);
    if (!indexes.size) job.consumers.delete(owner);
    if (!job.consumers.size) {
      job.cancelled = true;
      job.controller.abort();
      if (pending.get(job.key) === job) pending.delete(job.key);
    }
  }
}
function abortError() {
  return new DOMException('Frame preparation cancelled', 'AbortError');
}
function imageFromBlob(blob, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    const url = URL.createObjectURL(blob);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
      URL.revokeObjectURL(url);
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve(image);
    }
    function abort() { finish(abortError()); }
    signal.addEventListener('abort', abort, { once: true });
    image.onload = async () => {
      try {
        if (image.decode) await image.decode();
        if (signal.aborted) throw abortError();
        if (!image.naturalWidth) throw new Error('Empty sequence image');
        finish();
      } catch (error) { finish(error); }
    };
    image.onerror = () => finish(new Error('Sequence image decode failed'));
    if (signal.aborted) abort();
    else image.src = url;
  });
}
async function decodeFrame(job) {
  const response = await fetch(job.url, {
    signal: job.controller.signal, cache: 'force-cache', credentials: 'same-origin'
  });
  if (!response.ok) throw new Error(`Sequence image ${response.status}`);
  const blob = await response.blob();
  if (job.controller.signal.aborted) throw abortError();
  let original;
  let result;
  try {
    if (typeof createImageBitmap === 'function') {
      try { original = await createImageBitmap(blob); }
      catch (error) {
        if (job.controller.signal.aborted) throw error;
        original = await imageFromBlob(blob, job.controller.signal);
      }
    } else original = await imageFromBlob(blob, job.controller.signal);
    if (job.controller.signal.aborted) throw abortError();
    const sourceWidth = original.width || original.naturalWidth;
    const sourceHeight = original.height || original.naturalHeight;
    const fitScale = job.fit === 'cover'
      ? Math.max(job.width / sourceWidth, job.height / sourceHeight)
      : Math.min(job.width / sourceWidth, job.height / sourceHeight);
    const scale = Math.min(1, fitScale, Math.sqrt(MAX_PIXELS / (sourceWidth * sourceHeight)));
    const width = Math.max(1, Math.floor(sourceWidth * scale));
    const height = Math.max(1, Math.floor(sourceHeight * scale));
    if (width === sourceWidth && height === sourceHeight) {
      result = original;
      original = null;
    } else if (typeof createImageBitmap === 'function') {
      try { result = await createImageBitmap(original, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }); }
      catch { /* A bounded canvas also supports older bitmap decoders. */ }
    }
    if (!result) {
      const reduced = document.createElement('canvas');
      reduced.width = width;
      reduced.height = height;
      const context = reduced.getContext('2d');
      if (!context) throw new Error('Sequence canvas is unavailable');
      context.drawImage(original, 0, 0, width, height);
      reduced.close = () => { reduced.width = reduced.height = 0; };
      result = reduced;
    }
    if (job.controller.signal.aborted) throw abortError();
    const drawable = { image: result, width, height, bytes: width * height * 4 };
    result = null;
    return drawable;
  } finally {
    closeImage(original);
    closeImage(result);
  }
}
function pumpLoads() {
  while (activeLoads < MAX_LOADS && loadQueue.length) {
    const job = loadQueue.shift();
    if (job.cancelled || !job.consumers.size) continue;
    activeLoads++;
    job.started = true;
    const timeout = setTimeout(() => job.controller.abort(), job.timeout);
    decodeFrame(job).then(drawable => {
      if (job.cancelled || !job.consumers.size) { closeImage(drawable.image); return; }
      const entry = { ...drawable, key: job.key, owners: new Map() };
      cache.set(entry.key, entry);
      decodedBytes += entry.bytes;
      for (const [owner, indexes] of job.consumers) {
        for (const index of indexes) owner._acceptFrame(index, entry);
      }
      trimCache();
    }).catch(error => {
      if (error.name !== 'AbortError') {
        for (const [owner, indexes] of job.consumers) {
          for (const index of indexes) owner._failedFrames.set(index, performance.now());
        }
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (pending.get(job.key) === job) pending.delete(job.key);
      activeLoads--;
      pumpLoads();
    });
  }
}
function requestFrame(owner, index, priority = false) {
  if (owner._destroyed || document.hidden || !owner._wanted.has(index)) return;
  const url = owner.frameURLs[index];
  if (!url || !owner._pixelWidth || !owner._pixelHeight) return;
  const key = `${url}|${owner._pixelWidth}x${owner._pixelHeight}|${owner.fit}`;
  const cached = cache.get(key);
  if (cached) { touch(cached); owner._acceptFrame(index, cached); return; }
  if (performance.now() - (owner._failedFrames.get(index) ?? -Infinity) < 2000) return;
  let job = pending.get(key);
  if (!job) {
    job = { key, url, fit: owner.fit, width: owner._pixelWidth, height: owner._pixelHeight,
      timeout: owner.loadTimeout, controller: new AbortController(), consumers: new Map(), cancelled: false };
    pending.set(key, job);
    if (priority) loadQueue.unshift(job);
    else loadQueue.push(job);
  }
  if (!job.consumers.has(owner)) job.consumers.set(owner, new Set());
  job.consumers.get(owner).add(index);
  pumpLoads();
}
function clearFrameSequenceCache() {
  for (const job of pending.values()) { job.cancelled = true; job.controller.abort(); }
  pending.clear();
  loadQueue.length = 0;
  for (const entry of [...cache.values()]) evict(entry);
}
function getFrameSequenceCacheStats() {
  return { cachedCount: cache.size, pendingCount: pending.size, decodedBytes,
    budgetBytes: cacheBudget(), activeLoads, queuedCount: loadQueue.filter(job => !job.cancelled).length };
}
function generateFrameURLs(prefix, count, extension = '.webp', digits = 3, start = 0) {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + start).padStart(digits, '0')}${extension}`);
}
function getFrameUrls(frames, directory, options = {}) {
  if (!Array.isArray(frames)) return [];
  const config = typeof options === 'boolean' ? { skipOdd: options } : options || {};
  const step = config.step > 1 ? config.step : config.skipOdd || config.skipOddFrames ? 2 : 1;
  const dev = typeof localStorage !== 'undefined' && localStorage.getItem('dev') === 'true';
  return frames.filter((frame, index) => {
    const match = frame?.frame?.match(/\d+$/);
    return (match ? parseInt(match[0], 10) : index) % step === 0;
  }).map(frame => dev && frame.hostedUrl
    ? `${import.meta.url.split('/src/')[0]}/local-frames/${directory}/${frame.hostedUrl.split('/').pop()}`
    : frame.hostedUrl);
}

class FrameSequence {
  static getCacheStats() { return getFrameSequenceCacheStats(); }
  static clearCache() { clearFrameSequenceCache(); }
  constructor(options) {
    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext('2d');
    const skipAttribute = this.canvas.getAttribute('data-skip-odd');
    const skip = options.skipOdd || options.skipOddFrames || (skipAttribute !== null && skipAttribute !== 'false');
    const attributeStep = parseInt(this.canvas.getAttribute('data-step'), 10);
    const step = options.step > 1 ? options.step : attributeStep > 1 ? attributeStep : skip ? 2 : 1;
    this.frameURLs = (options.frames || []).filter((_, index) => index % step === 0);
    this.totalFrames = this.frameURLs.length;
    this.images = new Array(this.totalFrames);
    this.loadedSet = new Set();
    this._wanted = new Set();
    this._failedFrames = new Map();
    this._completedFrames = new Set();
    this.scrollTriggerVars = options.scrollTrigger || {};
    this.fit = options.fit || 'cover';
    this.clear = options.clear || false;
    this.lerpFactor = options.lerp || 0.15;
    this.concurrency = 2;
    this.loadTimeout = options.loadTimeout || 10000;
    this.autoResize = options.autoResize !== false;
    this.onReady = options.onReady || null;
    this.onProgress = options.onProgress || null;
    this.windowed = true;
    this.progressive = true;
    this.playhead = { frame: 0 };
    this._targetFrame = this._displayFrame = 0;
    this.currentFrame = this._lastRenderedRawFrame = -1;
    this._displayedKey = null;
    this.isReady = false;
    this._destroyed = false;
    this._near = false;
    this._isLerping = false;
    this._boundTick = this._tick.bind(this);
    this._visibility = () => {
      if (document.hidden) this._pausePreparation();
      else { this._ensureFramesAround(this._targetFrame); this._render(); }
    };
    instances.add(this);
    this._updateCanvasSize();
    this._initScrollAnimation();
    this._observeScene();
    if (this.autoResize) {
      this._resizeObserver = new ResizeObserver(() => {
        if (!this._updateCanvasSize()) return;
        this._ensureFramesAround(this._targetFrame);
        this._render();
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this._st?.refresh(), 200);
      });
      this._resizeObserver.observe(this.canvas);
    }
    document.addEventListener('visibilitychange', this._visibility);
    // Prepare one useful frame while distant. Further decoding follows the scene.
    this._ensureFramesAround(0);
  }
  _observeScene() {
    this._sceneObserver?.disconnect();
    let trigger = this.scrollTriggerVars.trigger;
    if (typeof trigger === 'string') trigger = document.querySelector(trigger);
    if (!trigger?.nodeType) trigger = this.canvas;
    if (typeof IntersectionObserver !== 'function') { this._near = true; return; }
    this._sceneObserver = new IntersectionObserver(entries => {
      if (this._destroyed) return;
      this._near = entries[0].isIntersecting;
      if (this._near) {
        this._displayFrame = this._targetFrame;
        this._ensureFramesAround(this._targetFrame);
        this._lastRenderedRawFrame = -1;
        this._render();
      } else this._pausePreparation();
    }, { rootMargin: `${Math.round((window.innerHeight || 800) * 1.5)}px 0px` });
    this._sceneObserver.observe(trigger);
  }
  _updateCanvasSize() {
    if (this._destroyed || !this.ctx) return false;
    // GSAP scales/translates these canvases. Layout size avoids reallocating a
    // huge back buffer for a transient transform on every scroll/resize.
    const width = this.canvas.clientWidth || this.canvas.offsetWidth || 0;
    const height = this.canvas.clientHeight || this.canvas.offsetHeight || 0;
    if (!width || !height) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (width * height)));
    const pixelWidth = Math.max(1, Math.floor(width * ratio));
    const pixelHeight = Math.max(1, Math.floor(height * ratio));
    if (pixelWidth === this._pixelWidth && pixelHeight === this._pixelHeight && width === this._displayWidth && height === this._displayHeight) return false;
    for (let index = 0; index < this.images.length; index++) { releaseIndex(this, index); cancelConsumer(this, index); }
    this._pixelWidth = pixelWidth;
    this._pixelHeight = pixelHeight;
    this._displayWidth = width;
    this._displayHeight = height;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    this._lastRenderedRawFrame = -1;
    this._displayedKey = null;
    return true;
  }
  _ensureFramesAround(frame) {
    if (this._destroyed || !this.totalFrames || document.hidden) return;
    const target = Math.max(0, Math.min(Math.round(frame), this.totalFrames - 1));
    const direction = frame >= (this._previousTarget ?? frame) ? 1 : -1;
    const speed = Math.abs(frame - (this._previousTarget ?? frame));
    this._previousTarget = frame;
    const ahead = this._near ? Math.min(10, 6 + Math.round(speed)) : 0;
    const behind = this._near ? 3 : 0;
    const wanted = new Set([target]);
    for (let distance = 1; distance <= ahead; distance++) wanted.add(target + distance * direction);
    for (let distance = 1; distance <= behind; distance++) wanted.add(target - distance * direction);
    this._wanted = new Set([...wanted].filter(index => index >= 0 && index < this.totalFrames));
    for (let index = 0; index < this.images.length; index++) {
      if (!this._wanted.has(index)) { releaseIndex(this, index); cancelConsumer(this, index); }
    }
    requestFrame(this, target, true);
    for (const index of this._wanted) if (index !== target) requestFrame(this, index);
    trimCache();
  }
  _acceptFrame(index, entry) {
    if (this._destroyed || !entry.image || !this._wanted.has(index)) return;
    const key = `${this.frameURLs[index]}|${this._pixelWidth}x${this._pixelHeight}|${this.fit}`;
    if (entry.key !== key) return;
    if (this.images[index] !== entry) {
      releaseIndex(this, index);
      this.images[index] = entry;
      this.loadedSet.add(index);
      if (!entry.owners.has(this)) entry.owners.set(this, new Set());
      entry.owners.get(this).add(index);
      this._completedFrames.add(index);
      this.onProgress?.(this.loadedSet.size, this.totalFrames);
    }
    if (!this.isReady) {
      this.isReady = true;
      this._warmTimer = setTimeout(() => {
        if (!this._destroyed) warmAssets(this.frameURLs, { priority: 15 });
      }, 1500);
      this.onReady?.();
    }
    if (this._lastRenderedRawFrame < 0 || index === Math.floor(this._displayFrame)) this._render();
  }
  _pausePreparation() {
    if (this._isLerping) { gsap.ticker.remove(this._boundTick); this._isLerping = false; }
    const current = Math.max(0, Math.min(Math.round(this._targetFrame), this.totalFrames - 1));
    this._wanted = document.hidden ? new Set() : new Set([current]);
    for (let index = 0; index < this.images.length; index++) {
      if (!this._wanted.has(index)) releaseIndex(this, index);
      cancelConsumer(this, index);
    }
    trimCache();
  }
  _initScrollAnimation() {
    this._tween = gsap.to(this.playhead, {
      frame: this.totalFrames - 1, ease: 'none',
      scrollTrigger: { ...this.scrollTriggerVars, onUpdate: () => {
        this._targetFrame = this.playhead.frame;
        this._ensureFramesAround(this._targetFrame);
        if (!document.hidden && this._near && !this._isLerping) {
          this._isLerping = true;
          gsap.ticker.add(this._boundTick);
        }
      } }
    });
    this._st = this._tween.scrollTrigger;
  }
  _tick() {
    if (this._destroyed || document.hidden || !this._near) { this._pausePreparation(); return; }
    const delta = this._targetFrame - this._displayFrame;
    if (Math.abs(delta) < 0.05) {
      this._displayFrame = this._targetFrame;
      this._render();
      this._isLerping = false;
      gsap.ticker.remove(this._boundTick);
      return;
    }
    const factor = this.lerpFactor + (1 - this.lerpFactor) * Math.min(1, Math.abs(delta) / 1.5);
    this._displayFrame += delta * factor;
    this._render();
  }
  _render() { this._renderFrame(this._displayFrame); }
  _ownsCanvas() {
    const owners = [...instances].filter(owner => !owner._destroyed && owner.canvas === this.canvas);
    if (owners.length < 2) return true;
    const active = owners.filter(owner => owner._st?.isActive);
    if (active.length) return active.sort((a, b) => (b._st.start || 0) - (a._st.start || 0))[0] === this;
    const ranged = owners.filter(owner => Number.isFinite(owner._st?.start));
    if (ranged.length === owners.length) {
      ranged.sort((a, b) => a._st.start - b._st.start);
      const scroll = window.smoothScroll?.lenis?.scroll ?? window.scrollY ?? 0;
      return (ranged.filter(owner => owner._st.start <= scroll).at(-1) || ranged[0]) === this;
    }
    return (owners.filter(owner => owner._targetFrame > 0).at(-1) || owners[0]) === this;
  }
  _renderFrame(frame) {
    if (this._destroyed || !this.ctx || !this.totalFrames || !this._displayWidth || !this._ownsCanvas()) return;
    if (canvasPainter.get(this.canvas) !== this) {
      this._lastRenderedRawFrame = -1;
      this._displayedKey = null;
    }
    const index = Math.max(0, Math.min(Math.floor(frame), this.totalFrames - 1));
    if (this._lastRenderedRawFrame === index) return;
    let chosen = index;
    if (!this.images[chosen]?.image) {
      let distance = Infinity;
      for (const candidate of this.loadedSet) {
        if (this.images[candidate]?.image && Math.abs(candidate - index) < distance) {
          chosen = candidate; distance = Math.abs(candidate - index);
        }
      }
      if (!this.images[chosen]?.image) return;
    }
    const entry = this.images[chosen];
    if (this._displayedKey === entry.key && this._lastDrawnRequestedIndex === index) return;
    touch(entry);
    const width = this._displayWidth, height = this._displayHeight;
    const params = this._computeDrawParams(entry.width, entry.height, width, height);
    if (this.clear) this.ctx.clearRect(0, 0, width, height);
    this.ctx.globalAlpha = 1;
    this.ctx.drawImage(entry.image, params.sx, params.sy, params.sw, params.sh, params.dx, params.dy, params.dw, params.dh);
    this._displayedKey = entry.key;
    canvasPainter.set(this.canvas, this);
    this._lastDrawnRequestedIndex = index;
    // A nearby substitute is useful immediately, but must not suppress the
    // exact frame when its asynchronous decode completes.
    this._lastRenderedRawFrame = chosen === index ? index : -1;
    this.currentFrame = chosen;
  }
  _computeDrawParams(sourceWidth, sourceHeight, width, height) {
    const sourceRatio = sourceWidth / sourceHeight, targetRatio = width / height;
    if (this.fit === 'cover') {
      if (sourceRatio > targetRatio) {
        const cropWidth = sourceHeight * targetRatio;
        return { sx: (sourceWidth - cropWidth) / 2, sy: 0, sw: cropWidth, sh: sourceHeight, dx: 0, dy: 0, dw: width, dh: height };
      }
      const cropHeight = sourceWidth / targetRatio;
      return { sx: 0, sy: (sourceHeight - cropHeight) / 2, sw: sourceWidth, sh: cropHeight, dx: 0, dy: 0, dw: width, dh: height };
    }
    if (sourceRatio > targetRatio) {
      const drawHeight = width / sourceRatio;
      return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: 0, dy: (height - drawHeight) / 2, dw: width, dh: drawHeight };
    }
    const drawWidth = height * sourceRatio;
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - drawWidth) / 2, dy: 0, dw: drawWidth, dh: height };
  }
  goToFrame(frame) {
    this.playhead.frame = Math.max(0, Math.min(frame, this.totalFrames - 1));
    this._targetFrame = this._displayFrame = this.playhead.frame;
    this._ensureFramesAround(this._targetFrame);
    this._render();
  }
  get progress() { return this.totalFrames > 1 ? this.playhead.frame / (this.totalFrames - 1) : 0; }
  get loadedCount() { return this.loadedSet.size; }
  refresh(scrollTrigger = null) {
    if (this._destroyed) return;
    if (scrollTrigger) {
      this._tween?.revert(); this._tween?.kill(); this._st?.kill();
      this.scrollTriggerVars = scrollTrigger;
      this._initScrollAnimation(); this._observeScene();
    } else this._st?.refresh();
    this._updateCanvasSize();
    this._ensureFramesAround(this._targetFrame);
    this._render();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._pausePreparation();
    this._tween?.kill(); this._st?.kill();
    clearTimeout(this._resizeTimer); clearTimeout(this._warmTimer);
    this._resizeObserver?.disconnect(); this._sceneObserver?.disconnect();
    document.removeEventListener('visibilitychange', this._visibility);
    for (let index = 0; index < this.images.length; index++) releaseIndex(this, index);
    this.images = []; this.loadedSet.clear(); this._wanted.clear();
    this.isReady = false; this.currentFrame = -1;
    instances.delete(this);
    if (canvasPainter.get(this.canvas) === this) {
      canvasPainter.delete(this.canvas);
      const successor = [...instances].find(owner => owner.canvas === this.canvas && !owner._destroyed && owner._ownsCanvas());
      if (successor) successor._render();
      else this.ctx?.clearRect(0, 0, this._displayWidth || 0, this._displayHeight || 0);
    }
    trimCache();
  }
}
if (typeof window !== 'undefined') {
  window.__getFrameCacheStats = getFrameSequenceCacheStats;
  window.__clearFrameCache = clearFrameSequenceCache;
}
export { FrameSequence, clearFrameSequenceCache, generateFrameURLs, getFrameSequenceCacheStats, getFrameUrls };
