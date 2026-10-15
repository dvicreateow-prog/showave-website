/* Keep the native scene, with a worker-free Canvas2D renderer when graphics fail. */
import { r as createNativeGlobe, i as preloadLand } from '/mirror/united-carriers.netlify.app/chunks/my-flights-DRrlP7HY.js?showave-native=4';
import { createFallbackGlobe } from './globe-fallback.js?v=perf-1';
import { createGlobeInteraction } from './globe-interaction.js';
import { ORIGIN, AFRICA_PHI, airportsData, flightsData } from './globe-routes.js';

export { airportsData as n, flightsData as t, preloadLand as i };

// Sample immediately after rendering, without retaining a full frame.
function hasDrawnPixels(context) {
  if (!context || context.isContextLost()) return false;
  const width = context.drawingBufferWidth, height = context.drawingBufferHeight;
  if (!width || !height) return false;
  const size = Math.min(32, width, height), pixels = new Uint8Array(size * size * 4);
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 5; col++) {
      const x = Math.max(0, Math.min(width - size, Math.round(width * col / 6 - size / 2)));
      const y = Math.max(0, Math.min(height - size, Math.round(height * row / 6 - size / 2)));
      context.readPixels(x, y, size, size, context.RGBA, context.UNSIGNED_BYTE, pixels);
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) return true;
    }
  }
  return false;
}

export function r(canvas, options = {}) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let source = canvas, native = null, fallback = null, context = null;
  let destroyed = false, attached = true, contextLost = false, landReady = false;
  let labelsVisible = true, originBranded = false, elapsed = 0;
  let readyFrames = 0, checkedPixels = false, recovering = false;
  const originalMask = canvas.style.getPropertyValue('mask-image');
  const originalMaskPriority = canvas.style.getPropertyPriority('mask-image');

  function useFallback(reason) {
    if (destroyed) return;
    recovering = false;
    if (!fallback) fallback = createFallbackGlobe(source, options);
    fallback.setLabelsVisible(labelsVisible);
    native?.setLabelsVisible(false);
    // Hide stale GPU pixels without changing the geometry or GSAP opacity
    // that the separate Canvas2D layer follows.
    source.style.setProperty('mask-image', 'linear-gradient(transparent, transparent)');
    source.dataset.showaveRenderer = 'canvas2d';
    source.dataset.showaveGlobeReason = reason;
  }

  function useNative() {
    fallback?.destroy();
    fallback = null;
    native?.setLabelsVisible(labelsVisible);
    if (originalMask) source.style.setProperty('mask-image', originalMask, originalMaskPriority);
    else source.style.removeProperty('mask-image');
    source.dataset.showaveRenderer = 'webgl';
    delete source.dataset.showaveGlobeReason;
    recovering = false;
  }

  function onLost(event) {
    event.preventDefault();
    contextLost = true;
    useFallback('context-lost');
  }

  function onRestored() {
    contextLost = false;
    recovering = true;
    readyFrames = 0;
    checkedPixels = false;
  }

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  canvas.setAttribute('aria-label', 'SHOWAVE connections from Kampala, Uganda, to the world. Illustrative routes.');
  try {
    native = createNativeGlobe(canvas, {
      ...options, airportsData, flightsData, showArcs: true, enableControls: false,
      pinDotColor: '#ff8a45', arcColor: '#ff783c', arcThickness: 0.0016,
      arcAltBase: 0.035, arcAltMultiplier: 0.09,
      onLandReady() {
        if (destroyed) return;
        landReady = true;
        readyFrames = 0;
        checkedPixels = false;
        recovering = !!fallback;
      },
      onLandError() { useFallback('land-processing'); }
    });
    context = canvas.getContext('webgl2');
    if (!context || context.isContextLost()) useFallback('webgl-unavailable');
    else source.dataset.showaveRenderer = 'webgl';
  } catch {
    useFallback('webgl-unavailable');
  }
  const interaction = createGlobeInteraction(canvas);

  // A failed or blocked worker must not leave the hero empty indefinitely.
  const landTimeout = window.setTimeout(() => {
    if (!destroyed && !landReady && !fallback) useFallback('land-timeout');
  }, 12000);

  function identifyOrigin() {
    if (originBranded) return;
    const labels = source.parentElement?.querySelectorAll('.globe-label-text') || [];
    const originLabel = [...labels].find(label => label.textContent === ORIGIN.label);
    if (!originLabel) return;
    originLabel.parentElement.classList.add('showave-origin-label');
    originLabel.setAttribute('title', 'SHOWAVE · Powered by Afro Unity Group. From Africa to the world.');
    const caption = document.createElement('span');
    caption.className = 'showave-origin-caption';
    caption.textContent = 'AFRO UNITY GROUP';
    originLabel.appendChild(caption);
    originBranded = true;
  }

  return {
    update({ deltaTime = 0 } = {}) {
      if (destroyed || !attached || document.hidden) return;
      const manual = interaction.getState();
      if (!motion.matches && !manual.isInteracting) elapsed += Math.min(100, Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0));
      const frame = {
        // One full turn in about 70 seconds makes the sphere's depth visible.
        phi: AFRICA_PHI + manual.yaw + (motion.matches ? 0 : (elapsed * 0.00009) % (Math.PI * 2)),
        theta: 0.15 + manual.pitch,
        deltaTime: motion.matches ? 0 : deltaTime
      };
      if (native && !contextLost && (!fallback || recovering)) {
        try {
          native.update(frame);
          identifyOrigin();
          if (landReady && !checkedPixels && ++readyFrames >= 30 && source.clientWidth > 0) {
            checkedPixels = true;
            if (!hasDrawnPixels(context)) useFallback('empty-frame');
            else if (recovering) useNative();
          }
        } catch { useFallback('render-error'); }
      }
      fallback?.update(frame);
    },
    resize(width, height) {
      if (destroyed) return;
      try { native?.resize(width, height); } catch { useFallback('resize-error'); }
      fallback?.resize(width, height);
    },
    isInteracting() { return interaction.getState().isInteracting; },
    setLabelsVisible(visible) {
      labelsVisible = visible;
      native?.setLabelsVisible(visible && !fallback);
      fallback?.setLabelsVisible(visible);
    },
    attach(nextCanvas) {
      source = native ? native.attach(nextCanvas) : fallback.attach(nextCanvas);
      if (native && fallback) fallback.attach(source);
      interaction.attach(source);
      attached = true;
      return source;
    },
    detach() {
      attached = false;
      interaction.detach();
      native?.detach();
      fallback?.detach();
    },
    destroy() {
      destroyed = true;
      attached = false;
      clearTimeout(landTimeout);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      fallback?.destroy();
      native?.destroy();
      interaction.destroy();
      if (originalMask) source.style.setProperty('mask-image', originalMask, originalMaskPriority);
      else source.style.removeProperty('mask-image');
      delete source.dataset.showaveRenderer;
      delete source.dataset.showaveGlobeReason;
    }
  };
}
