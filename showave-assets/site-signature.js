/* Interior scenery uses the homepage's globe, routes, lighting and local assets.
   Start/Welcome and the original homepage retain their existing renderer. */
(() => {
  'use strict';
  const bootKey = Symbol.for('showave.site.signature');
  if (window[bootKey]) return;
  const scriptURL = document.currentScript?.src || location.origin + '/showave-assets/site-signature.js';
  const engineURL = new URL('africa-globe.js?v=smooth-1', scriptURL).href;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const headings = new WeakSet();
  let main, scene, stage, canvas, globe, enginePromise;
  let sizing, visibility, content, motion;
  let frame = 0, lastTime = 0, frameCount = 0, elapsed = 0;
  let inView = true, suspended = false, disposed = false, starting = false;
  let syncFrame = 0, staticTimer = 0, staticDeadline = 0, staticRefreshPending = false;
  let warmUntil = 0, warmFrames = 0, phase = 'idle';

  const motionPaused = () => document.body.classList.contains('motion-paused');
  const visible = () => !disposed && !suspended && !document.hidden && inView && scene?.isConnected;
  // site.js also sets motion-paused for the OS Reduce preference. Permit only
  // bounded zero-delta initialization in that case, never animated rotation.
  const canAnimate = () => visible() && (!motionPaused() ||
    (reduced.matches && warmFrames > 0 && performance.now() < warmUntil));
  const state = () => Object.freeze({
    phase, mounted: !!scene?.isConnected, renderer: canvas?.dataset.showaveRenderer || null,
    frameCount, elapsed, loopActive: !!frame, inView, hidden: document.hidden,
    suspended, disposed, reduced: reduced.matches, motionPaused: motionPaused(),
    warming: !!globe && warmFrames > 0 && performance.now() < warmUntil,
    pendingStaticRefresh: staticRefreshPending, loading: starting,
    scenes: document.querySelectorAll('[data-site-globe]').length,
    canvases: scene?.querySelectorAll('canvas').length || 0
  });
  const api = Object.freeze({ state });
  window[bootKey] = api;
  Object.defineProperty(window, 'ShowaveSiteSignature', { value: api, configurable: true });

  function stopFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    clearTimeout(staticTimer);
    staticTimer = 0;
    scene?.classList.add('is-motion-idle');
  }
  function warm(frames = 90, milliseconds = 3000) {
    warmFrames = Math.max(warmFrames, frames);
    warmUntil = performance.now() + milliseconds;
  }
  function draw(time) {
    frame = 0;
    if (!globe || !canAnimate()) { lastTime = 0; return; }
    const frozen = reduced.matches;
    const deltaTime = frozen || !lastTime ? 0 : Math.min(100, time - lastTime);
    try { globe.update({ deltaTime }); }
    catch { fail(); return; }
    frameCount++;
    elapsed += deltaTime;
    lastTime = time;
    if (warmFrames > 0) warmFrames--;
    if (!frozen || (warmFrames > 0 && time < warmUntil)) schedule();
    else { lastTime = 0; scene.classList.add('is-motion-idle'); }
  }
  function schedule() {
    if (!globe || !canAnimate() || frame) return;
    scene.classList.remove('is-motion-idle');
    frame = requestAnimationFrame(draw);
  }
  function armStaticRefresh() {
    clearTimeout(staticTimer);
    staticTimer = 0;
    if (!staticRefreshPending || !globe || !visible() || (motionPaused() && !reduced.matches)) return;
    // The unchanged homepage renderer has a 12s land/fallback deadline. A
    // second bounded, zero-delta paint also covers slow first loads in Reduce.
    staticTimer = setTimeout(() => {
      staticTimer = 0;
      if (!visible() || (motionPaused() && !reduced.matches)) return;
      staticRefreshPending = false;
      if (reduced.matches) { warm(40, 1600); schedule(); }
    }, Math.max(0, staticDeadline - performance.now()));
  }
  function resize() {
    if (!globe || !stage?.isConnected) return;
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) return;
    globe.resize(width, height);
    lastTime = 0;
    if (visible() && motionPaused() && !reduced.matches) {
      // A resized static scene needs one paint, without starting a frame loop.
      globe.update({ deltaTime: 0 });
      frameCount++;
    } else { if (reduced.matches) warm(40, 1600); schedule(); }
  }
  function resume() {
    if (!scene || !visible()) { stopFrame(); return; }
    if (!globe) { initialize(); return; }
    lastTime = 0;
    if (motionPaused() && !reduced.matches) { stopFrame(); return; }
    if (reduced.matches) warm(40, 1600);
    armStaticRefresh();
    schedule();
  }
  function fail() {
    phase = 'unavailable';
    stopFrame();
    staticRefreshPending = false;
    globe?.destroy();
    globe = null;
    sizing?.disconnect();
    visibility?.disconnect();
    scene?.remove();
    main?.classList.remove('showave-signature-page');
    // The optional decoration never changes content, focus or navigation.
  }
  async function initialize() {
    if (starting || globe || disposed || !visible() || phase === 'unavailable') return;
    starting = true;
    phase = 'loading';
    try {
      // One shared import promise; guide/article DOM updates do not load it again.
      enginePromise ||= import(engineURL);
      const { r: createGlobe } = await enginePromise;
      if (!visible()) return;
      const mobile = matchMedia('(max-width: 767px)').matches;
      const tablet = matchMedia('(min-width: 768px) and (max-width: 991px)').matches;
      globe = createGlobe(canvas, {
        cameraZ: mobile ? 2.7 : tablet ? 2.8 : 2.23,
        tileDeg: mobile ? 1.5 : 1.2, enableControls: false
      });
      globe.setLabelsVisible(true);
      canvas.tabIndex = -1;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.removeAttribute('role');
      canvas.removeAttribute('aria-label');
      phase = 'ready';
      scene.dataset.phase = phase;
      staticRefreshPending = true;
      staticDeadline = performance.now() + 13000;
      warm();
      resize();
      armStaticRefresh();
      schedule();
    } catch { fail(); }
    finally { starting = false; }
  }
  function animateHeadings() {
    for (const heading of main?.querySelectorAll('h1') || []) {
      if (headings.has(heading) || heading.closest('[hidden],dialog,[data-site-globe]')) continue;
      heading.classList.add('showave-signature-heading');
      headings.add(heading);
    }
  }
  function syncContent(records) {
    if (disposed || syncFrame) return;
    // Globe labels are owned by the renderer; ignore their changes entirely.
    if (records && !records.some(record => !record.target.closest?.('[data-site-globe]'))) return;
    syncFrame = requestAnimationFrame(() => { syncFrame = 0; animateHeadings(); });
  }
  function onVisibility() { document.hidden ? stopFrame() : resume(); }
  function onMotionChange() {
    if (motionPaused() && !reduced.matches) stopFrame();
    else resume();
  }
  function onPageHide(event) {
    suspended = true;
    stopFrame();
    cancelAnimationFrame(syncFrame);
    syncFrame = 0;
    if (event.persisted) return;
    disposed = true;
    phase = 'disposed';
    globe?.destroy();
    globe = null;
    sizing?.disconnect();
    visibility?.disconnect();
    content?.disconnect();
    motion?.disconnect();
    reduced.removeEventListener('change', onMotionChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
  }
  function onPageShow(event) {
    if (!event.persisted || disposed) return;
    suspended = false;
    animateHeadings();
    resize();
    resume();
  }
  function start() {
    main = document.querySelector('main');
    // These three pages already own this exact scene. Never add a second one.
    if (!main || main.matches('.start-home,.welcome-globe-page') ||
        document.querySelector('#globe,[data-welcome-globe],.welcome-homepage-scene')) {
      phase = 'existing-scene';
      return;
    }
    animateHeadings();
    main.classList.add('showave-signature-page');
    scene = document.createElement('div');
    scene.className = 'showave-site-signature is-motion-idle';
    scene.dataset.siteGlobe = '';
    scene.dataset.phase = 'loading';
    scene.setAttribute('aria-hidden', 'true');
    scene.inert = true;
    scene.innerHTML = '<div class="site-signature-stars"></div><div class="home-hero-globe site-signature-stage"><div class="home-hero-globe-shadow-grp"><div class="home-hero-globe-shadow orange"></div><div class="home-hero-globe-shadow orange-plus"></div><div class="home-hero-globe-shadow blue-plus"></div><div class="home-hero-globe-shadow blue"></div></div><div class="home-hero-globe-blur"><img src="/mirror/cdn.prod.website-files.com/6a44eec1ed1af2c4c403df6b/6a4c6cb6a5d96145b3b34612_start-blur.avif" alt="" decoding="async"></div><canvas class="home-hero-canvas" tabindex="-1" aria-hidden="true"></canvas></div>';
    main.prepend(scene);
    stage = scene.querySelector('.site-signature-stage');
    canvas = scene.querySelector('canvas');
    sizing = new ResizeObserver(resize);
    sizing.observe(stage);
    visibility = new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      inView ? resume() : stopFrame();
    });
    visibility.observe(scene);
    content = new MutationObserver(syncContent);
    content.observe(main, { childList: true, subtree: true });
    motion = new MutationObserver(onMotionChange);
    motion.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    reduced.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    initialize();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
