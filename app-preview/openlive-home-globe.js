/* Home-only host for the unchanged website globe. Importing starts no renderer. */
const assetRoot = new URL('./assets/home-globe/', import.meta.url);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let enginePromise = null, engineModule = null;
let panel = null, scene = null, stage = null, canvas = null, globe = null;
let requested = false, generation = 0, loadingGeneration = 0;
let frameRequest = 0, lastTime = 0, updates = 0, created = 0, disposed = 0;
let warmingUntil = 0, warmFrames = 0, sizing = null, visibility = null;
let inView = true, listenersBound = false, lastError = null;
let createdAt = 0, settleTimer = 0, settled = false;

function panelVisible() {
  return !!(requested && panel?.isConnected && scene?.isConnected && !scene.hidden &&
    !panel.closest('[hidden]') && panel.offsetWidth && panel.offsetHeight && inView);
}
function drawable() { return panelVisible() && !document.hidden; }
function stopFrame() {
  if (frameRequest) window.cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  lastTime = 0;
}
function isWarming(time = performance.now()) { return warmFrames > 0 && time < warmingUntil; }
function schedule() {
  if (!frameRequest && globe && drawable() && (!reducedMotion.matches || isWarming()))
    frameRequest = window.requestAnimationFrame(draw);
}
function draw(time) {
  frameRequest = 0;
  if (!globe || !drawable()) { lastTime = 0; return; }
  const deltaTime = reducedMotion.matches || !lastTime ? 0 : Math.min(100, Math.max(0, time - lastTime));
  globe.update({ deltaTime });
  updates++;
  lastTime = time;
  if (warmFrames > 0) warmFrames--;
  schedule();
}
function warm(frames = 90, duration = 3000) {
  // Finish async native land setup and the renderer's initial pixel checks,
  // then leave no continuous RAF in reduced-motion mode.
  warmFrames = frames;
  warmingUntil = performance.now() + duration;
}
function stopSettling() { clearTimeout(settleTimer); settleTimer = 0; }
function scheduleSettling() {
  if (settleTimer || settled || !globe || !reducedMotion.matches || !drawable()) return;
  const remaining = createdAt + 13000 - performance.now();
  if (remaining <= 0) { settled = true; return; }
  // The unchanged engine's land/fallback window is 12s. One short static
  // refresh after it settles handles slow first loads without a 14s RAF loop.
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    if (!globe || !drawable() || !reducedMotion.matches) return;
    settled = true;
    warm(40, 1600);
    schedule();
  }, remaining);
}
function resize() {
  if (!globe || !drawable()) return;
  const bounds = stage.getBoundingClientRect();
  if (bounds.width > 0 && bounds.height > 0) globe.resize(bounds.width, bounds.height);
  lastTime = 0;
  if (reducedMotion.matches) warm();
  schedule();
}
function visibilityChanged() {
  if (!drawable()) { stopFrame(); stopSettling(); }
  else if (!globe && !loadingGeneration && panel) { void show(panel); }
  else { lastTime = 0; if (reducedMotion.matches) warm(); resize(); schedule(); scheduleSettling(); }
}
function motionChanged() { stopFrame(); stopSettling(); warm(); resize(); schedule(); scheduleSettling(); }
function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('visibilitychange', visibilityChanged);
  reducedMotion.addEventListener('change', motionChanged);
  window.addEventListener('pagehide', hide);
}
function unbindListeners() {
  if (!listenersBound) return;
  listenersBound = false;
  document.removeEventListener('visibilitychange', visibilityChanged);
  reducedMotion.removeEventListener('change', motionChanged);
  window.removeEventListener('pagehide', hide);
}
function mount(nextPanel) {
  panel = nextPanel;
  scene = document.createElement('div');
  scene.className = 'showave-home-globe-scene';
  scene.setAttribute('aria-hidden', 'true');
  scene.setAttribute('inert', '');
  const stars = document.createElement('div');
  stars.className = 'showave-home-globe-stars';
  stars.style.backgroundImage = `url("${new URL('star.avif', assetRoot).href}")`;
  stage = document.createElement('div');
  stage.className = 'showave-home-globe-stage home-hero-globe';
  canvas = document.createElement('canvas');
  canvas.className = 'home-hero-canvas';
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-hidden', 'true');
  const lighting = document.createElement('div');
  lighting.className = 'home-hero-globe-shadow-grp';
  for (const variant of ['orange', 'blue', 'blue-plus', 'orange-plus']) {
    const layer = document.createElement('div');
    layer.className = 'home-hero-globe-shadow ' + variant;
    lighting.append(layer);
  }
  const glow = document.createElement('div');
  glow.className = 'home-hero-globe-blur';
  const image = new Image();
  image.src = new URL('start-blur.avif', assetRoot).href;
  image.alt = '';
  image.decoding = 'async';
  glow.append(image);
  lighting.append(glow);
  stage.append(canvas, lighting);
  scene.append(stars, stage);
  panel.prepend(scene);
  sizing = new ResizeObserver(resize);
  sizing.observe(stage);
  if ('IntersectionObserver' in window) {
    visibility = new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      visibilityChanged();
    });
    visibility.observe(panel);
  }
  bindListeners();
}

export async function show(nextPanel) {
  if (!(nextPanel instanceof HTMLElement) || nextPanel.id !== 'showave-start-panel') return state();
  if (panel && panel !== nextPanel) destroy();
  requested = true;
  const request = ++generation;
  if (!scene) mount(nextPanel);
  scene.hidden = false;
  if (globe) { warm(); resize(); schedule(); scheduleSettling(); return state(); }
  if (!drawable()) return state();
  loadingGeneration = request;
  try {
    enginePromise ||= import(new URL('africa-globe.js', assetRoot).href);
    engineModule = await enginePromise;
    // A workspace can open before an import completes. That old show request
    // cannot construct a renderer or enqueue a frame after hide().
    if (request !== generation || !requested || !drawable()) return state();
    if (!globe) {
      globe = engineModule.r(canvas, { cameraZ: 2.35, tileDeg: 1.2, enableControls: false });
      created++;
      createdAt = performance.now();
      settled = false;
      globe.setLabelsVisible(true);
      canvas.tabIndex = -1;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.setAttribute('role', 'presentation');
      canvas.removeAttribute('aria-keyshortcuts');
      canvas.removeAttribute('aria-roledescription');
      lastError = null;
    }
    warm();
    resize();
    schedule();
    scheduleSettling();
  } catch (error) {
    lastError = error?.message || String(error);
    stopFrame();
    // The existing cover and every Home control remain independent.
  } finally {
    if (loadingGeneration === request) loadingGeneration = 0;
  }
  return state();
}

export function hide() {
  requested = false;
  generation++;
  stopFrame();
  stopSettling();
  if (scene) scene.hidden = true;
  return state();
}

export function destroy() {
  hide();
  sizing?.disconnect();
  visibility?.disconnect();
  sizing = visibility = null;
  unbindListeners();
  if (globe) { globe.destroy(); disposed++; }
  globe = null;
  scene?.remove();
  panel = scene = stage = canvas = null;
  inView = true;
  warmFrames = 0;
  warmingUntil = 0;
  createdAt = 0;
  settled = false;
  return state();
}

export function state() {
  return Object.freeze({
    requested, visible: panelVisible(), documentHidden: document.hidden,
    activeFrameRequest: !!frameRequest, reducedMotion: reducedMotion.matches,
    warming: !!globe && drawable() && isWarming(), pendingImport: !!loadingGeneration,
    pendingStaticRefresh: !!settleTimer, settled,
    imported: !!engineModule, renderer: canvas?.dataset.showaveRenderer || null,
    canvasCount: scene?.querySelectorAll('canvas').length || 0,
    labelCount: scene?.querySelectorAll('.globe-label').length || 0,
    updates, created, disposed, connected: !!scene?.isConnected,
    error: lastError
  });
}

window.ShowaveHomeGlobe = Object.freeze({ show, hide, destroy, state });
