import { createOceanFallback } from './ocean-fallback.js';

// Keep the original shader ocean whenever the browser can draw it. The water
// photograph remains animated while GPU resources load or cannot be restored.
const bindings = new Map();

function connect(ocean) {
  if (bindings.has(ocean)) return;
  const nativeHost = ocean.querySelector('webflow-3d[scene="OceanScene"]');
  if (!nativeHost) return;
  let nativeCanvas = null;
  let supported = false;
  let capabilityChecked = false;
  let canvasVisibility = '';
  let contextLost = false;
  let mode = '';
  let visible = false;
  let destroyed = false;
  let resizeFrame = 0;
  let videoPlayPending = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const video = ocean.querySelector('video');
  const wake = video?.closest('.home-why-ship-wave') || video;
  const fallback = createOceanFallback(ocean, { onReady: inspect });
  const fallbackCanvas = ocean.querySelector('.showave-ocean-fallback');

  function onLost(event) {
    event.preventDefault();
    contextLost = true;
    inspect();
  }

  function onRestored() {
    contextLost = false;
    capabilityChecked = false;
    inspect();
  }

  function updateVideo(ready) {
    if (!video) return;
    // Native water or an offscreen scene needs no layout read or wake playback.
    const shouldPlay = !ready && visible && !document.hidden && !motion.matches &&
      getComputedStyle(wake).display !== 'none';
    if (!shouldPlay) {
      if (!video.paused || videoPlayPending) {
        videoPlayPending = null;
        video.pause();
      }
      return;
    }
    if (!video.paused || videoPlayPending) return;
    const request = {};
    videoPlayPending = request;
    Promise.resolve(video.play()).catch(() => {}).finally(() => {
      if (videoPlayPending === request) videoPlayPending = null;
    });
  }

  function inspect() {
    if (destroyed) return;
    const nextCanvas = nativeHost.querySelector('canvas');
    if (nativeCanvas !== nextCanvas) {
      nativeCanvas?.removeEventListener('webglcontextlost', onLost);
      nativeCanvas?.removeEventListener('webglcontextrestored', onRestored);
      nativeCanvas = nextCanvas;
      capabilityChecked = false;
      supported = false;
      contextLost = false;
      nativeCanvas?.addEventListener('webglcontextlost', onLost);
      nativeCanvas?.addEventListener('webglcontextrestored', onRestored);
    }
    if (nativeCanvas && !capabilityChecked && !contextLost) {
      try {
        const context = nativeCanvas.getContext('webgl2');
        supported = !!context && !context.isContextLost() &&
          !!context.getExtension('EXT_color_buffer_float');
        capabilityChecked = !!context && !context.isContextLost();
      } catch { supported = false; capabilityChecked = true; }
    }
    canvasVisibility = nativeCanvas?.style.visibility || '';
    const ready = supported && !contextLost && canvasVisibility === 'visible';
    if (nativeCanvas && (!supported || contextLost)) nativeHost.dataset.showaveOceanPaused = 'true';
    else delete nativeHost.dataset.showaveOceanPaused;
    fallback.setActive(!ready);
    const painted = fallbackCanvas?.dataset.ready === 'true';
    const nextMode = ready ? 'native' : painted ? 'fallback' : 'loading';
    if (nextMode !== mode) {
      mode = nextMode;
      ocean.dataset.showaveWater = mode;
    }
    // The native shader creates its own wake. Keep the supplied wake video
    // above the photographic renderer when GPU water is unavailable.
    updateVideo(ready);
  }

  const nativeObserver = new MutationObserver(records => {
    // GSAP writes transforms every scrolling frame. Renderer readiness only
    // changes when its canvas is replaced or its visibility changes.
    if (records.some(record => record.type === 'childList' ||
      (record.target === nativeCanvas && nativeCanvas.style.visibility !== canvasVisibility))) inspect();
  });
  nativeObserver.observe(nativeHost, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  const viewObserver = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    inspect();
  });
  viewObserver.observe(ocean);
  document.addEventListener('visibilitychange', inspect);
  function onResize() {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      inspect();
    });
  }
  window.addEventListener('resize', onResize);
  motion.addEventListener('change', inspect);
  inspect();
  bindings.set(ocean, () => {
    destroyed = true;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    videoPlayPending = null;
    video?.pause();
    nativeObserver.disconnect();
    viewObserver.disconnect();
    nativeCanvas?.removeEventListener('webglcontextlost', onLost);
    nativeCanvas?.removeEventListener('webglcontextrestored', onRestored);
    document.removeEventListener('visibilitychange', inspect);
    window.removeEventListener('resize', onResize);
    motion.removeEventListener('change', inspect);
    fallback.destroy();
    delete ocean.dataset.showaveWater;
    delete nativeHost.dataset.showaveOceanPaused;
    bindings.delete(ocean);
  });
}

function scan(root) {
  if (root instanceof Element && root.matches('.home-why-ocean')) connect(root);
  root.querySelectorAll?.('.home-why-ocean').forEach(connect);
}

const observer = new MutationObserver(records => {
  for (const [ocean, destroy] of bindings) if (!ocean.isConnected) destroy();
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
});
observer.observe(document.body, { childList: true, subtree: true });
scan(document);
window.addEventListener('pagehide', () => { for (const destroy of [...bindings.values()]) destroy(); });
window.addEventListener('pageshow', () => scan(document));
