// Reuse the homepage's native globe, routes and graphics fallback unchanged.
import { r as createGlobe } from './africa-globe.js?v=smooth-1';

const scene = document.querySelector('[data-welcome-globe]');
const canvas = scene?.querySelector('canvas');
if (scene && canvas) {
  const host = canvas.parentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let globe, frame = 0, lastTime = 0, inView = true, disposed = false;
  let warmingUntil = 0;
  const paused = () => reduced.matches || document.body.classList.contains('motion-paused');

  function resize() {
    if (!globe) return;
    const { width, height } = host.getBoundingClientRect();
    globe.resize(width, height);
    lastTime = 0;
    schedule();
  }
  function draw(time) {
    frame = 0;
    if (disposed || !globe || document.hidden || !inView) { lastTime = 0; return; }
    const freeze = paused();
    globe.update({ deltaTime: freeze || !lastTime ? 0 : Math.min(100, time - lastTime) });
    lastTime = time;
    // The shared renderer loads land asynchronously and checks its initial
    // frames. Finish those checks even for a visitor who disables movement.
    if (!freeze || time < warmingUntil) schedule();
  }
  function schedule() {
    if (!disposed && globe && !document.hidden && inView && !frame) frame = requestAnimationFrame(draw);
  }
  function start() {
    if (globe) return;
    disposed = false;
    const mobile = matchMedia('(max-width: 767px)').matches;
    const tablet = matchMedia('(min-width: 768px) and (max-width: 991px)').matches;
    globe = createGlobe(canvas, { cameraZ: mobile ? 2.7 : tablet ? 2.8 : 2.23, tileDeg: mobile ? 1.5 : 1.2, enableControls: false });
    globe.setLabelsVisible(true);
    // This is scenery behind the welcome, rather than an extra keyboard stop.
    canvas.tabIndex = -1;
    canvas.setAttribute('aria-hidden', 'true');
    warmingUntil = performance.now() + 14000;
    resize();
    schedule();
  }
  function stop() {
    disposed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    globe?.destroy();
    globe = null;
    lastTime = 0;
  }
  const sizing = new ResizeObserver(resize);
  sizing.observe(host);
  const visibility = new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    if (!inView) { cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
    else schedule();
  });
  visibility.observe(host);
  const motion = new MutationObserver(() => { lastTime = 0; schedule(); });
  motion.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  reduced.addEventListener('change', () => { lastTime = 0; schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
    else { warmingUntil = performance.now() + 1000; schedule(); }
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) {
      // Browser Back/Forward retains this document and its renderer. Releasing
      // the GPU context here would leave that retained canvas unusable.
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
    } else {
      stop();
      sizing.disconnect();
      visibility.disconnect();
      motion.disconnect();
    }
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && globe) {
      warmingUntil = performance.now() + 14000;
      resize();
    } else start();
  });
  start();
}
