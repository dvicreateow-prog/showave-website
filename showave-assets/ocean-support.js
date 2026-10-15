import { createOceanFallback } from './ocean-fallback.js';

// Keep the original shader ocean whenever the browser can draw it. The water
// photograph remains animated while GPU resources load or cannot be restored.
const bindings = new Map();

function connect(ocean) {
  if (bindings.has(ocean)) return;
  const nativeHost = ocean.querySelector('webflow-3d[scene="OceanScene"]');
  if (!nativeHost) return;
  let nativeCanvas = null;
  let contextLost = false;
  let mode = '';
  let visible = false;
  let destroyed = false;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const video = ocean.querySelector('video');
  const fallback = createOceanFallback(ocean, { onReady: inspect });

  function onLost(event) {
    event.preventDefault();
    contextLost = true;
    inspect();
  }

  function onRestored() {
    contextLost = false;
    inspect();
  }

  function inspect() {
    if (destroyed) return;
    const nextCanvas = nativeHost.querySelector('canvas');
    if (nativeCanvas !== nextCanvas) {
      nativeCanvas?.removeEventListener('webglcontextlost', onLost);
      nativeCanvas?.removeEventListener('webglcontextrestored', onRestored);
      nativeCanvas = nextCanvas;
      contextLost = false;
      nativeCanvas?.addEventListener('webglcontextlost', onLost);
      nativeCanvas?.addEventListener('webglcontextrestored', onRestored);
    }
    let supported = false;
    try {
      const context = nativeCanvas?.getContext('webgl2');
      supported = !!context && !context.isContextLost() &&
        !!context.getExtension('EXT_color_buffer_float');
    } catch { /* The moving photographic surface covers unavailable graphics. */ }
    const ready = supported && !contextLost && nativeCanvas.style.visibility === 'visible';
    if (nativeCanvas && (!supported || contextLost)) nativeHost.dataset.showaveOceanPaused = 'true';
    else delete nativeHost.dataset.showaveOceanPaused;
    fallback.setActive(!ready);
    const painted = ocean.querySelector('.showave-ocean-fallback')?.dataset.ready === 'true';
    const nextMode = ready ? 'native' : painted ? 'fallback' : 'loading';
    if (nextMode !== mode) {
      mode = nextMode;
      ocean.dataset.showaveWater = mode;
    }
    // The native shader creates its own wake. Keep the supplied wake video
    // above the photographic renderer when GPU water is unavailable.
    if (video) {
      const wakeVisible = getComputedStyle(video.closest('.home-why-ship-wave') || video).display !== 'none';
      if (ready || !visible || !wakeVisible || document.hidden || motion.matches) video.pause();
      else video.play().catch(() => {});
    }
  }

  const nativeObserver = new MutationObserver(inspect);
  nativeObserver.observe(nativeHost, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  const viewObserver = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    inspect();
  });
  viewObserver.observe(ocean);
  document.addEventListener('visibilitychange', inspect);
  window.addEventListener('resize', inspect);
  motion.addEventListener('change', inspect);
  inspect();
  bindings.set(ocean, () => {
    destroyed = true;
    video?.pause();
    nativeObserver.disconnect();
    viewObserver.disconnect();
    nativeCanvas?.removeEventListener('webglcontextlost', onLost);
    nativeCanvas?.removeEventListener('webglcontextrestored', onRestored);
    document.removeEventListener('visibilitychange', inspect);
    window.removeEventListener('resize', inspect);
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
