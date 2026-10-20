/* Keep the native scene, with a worker-free Canvas2D renderer when graphics fail. */
import { r as createNativeGlobe, i as preloadLand } from '/mirror/united-carriers.netlify.app/chunks/my-flights-DRrlP7HY.js?showave-native=africa-mark-9';
import { createFallbackGlobe } from './globe-fallback.js?v=africa-mark-9';
import * as afroUnityArtwork from './afro-unity-land.js?v=africa-mark-9';
import { createGlobeInteraction } from './globe-interaction.js';
import { ORIGIN, AFRICA_PHI, airportsData, flightsData } from './globe-routes.js';

export { airportsData as n, flightsData as t, preloadLand as i };

const { afroUnityLandPoints } = afroUnityArtwork;
const WORLD_SPACING = 0.6;
const UNIFORM_POINT_SIZE = 0.003;
const clearanceKeys = new Set(afroUnityArtwork.afroUnityClearanceKeys || []);
function worldCellKey(longitude, latitude) {
  const canonicalLongitude = ((longitude + 540) % 360) - 180;
  return Math.round((latitude + 90) / WORLD_SPACING) * 601 +
    Math.round((canonicalLongitude + 180) / WORLD_SPACING);
}
// Applied once to the native worker's immutable output, before its geometry.
// The logo is drawn in the world's own dots: its cells join the land fill, so they share the
// land material, size, colour and opacity exactly.
function filterWorldLandPositions(positions) {
  const filtered = new Float32Array(positions.length + brandedLandPositions.length);
  let offset = 0;
  for (let index = 0; index < positions.length; index += 3) {
    const longitude = Math.atan2(-positions[index + 2], positions[index]) * 180 / Math.PI;
    const latitude = Math.asin(Math.max(-1, Math.min(1, positions[index + 1]))) * 180 / Math.PI;
    if (clearanceKeys.has(worldCellKey(longitude, latitude))) continue;
    filtered[offset++] = positions[index];
    filtered[offset++] = positions[index + 1];
    filtered[offset++] = positions[index + 2];
  }
  filtered.set(brandedLandPositions, offset);
  offset += brandedLandPositions.length;
  return filtered.subarray(0, offset);
}
const hasArtworkColors = Array.isArray(afroUnityArtwork.afroUnityLandPalette) &&
  afroUnityArtwork.afroUnityLandPalette.length > 0 &&
  afroUnityArtwork.afroUnityLandPalette.every(color => /^#[0-9a-f]{6}$/i.test(color)) &&
  afroUnityArtwork.afroUnityLandColorIndices?.length === afroUnityLandPoints.length &&
  afroUnityArtwork.afroUnityLandColorIndices.every(index => Number.isInteger(index) && index >= 0 && index < afroUnityArtwork.afroUnityLandPalette.length);
const linearChannel = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const linearPalette = hasArtworkColors ? afroUnityArtwork.afroUnityLandPalette.map(color => {
  const rgb = Number.parseInt(color.slice(1), 16);
  return [linearChannel((rgb >> 16 & 255) / 255), linearChannel((rgb >> 8 & 255) / 255), linearChannel((rgb & 255) / 255)];
}) : null;
const brandedLandColors = hasArtworkColors ? new Float32Array(afroUnityLandPoints.length * 3) : null;

// The correct Afro Unity logo's cells on the world grid. Convert once, then share the
// immutable unit-sphere positions between scenes; they are rendered as ordinary land.
const brandedLandPositions = new Float32Array(afroUnityLandPoints.length * 3);
for (let index = 0; index < afroUnityLandPoints.length; index++) {
  const [longitude, latitude] = afroUnityLandPoints[index];
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
  const cosine = Math.cos(lat), offset = index * 3;
  brandedLandPositions[offset] = cosine * Math.cos(lon);
  brandedLandPositions[offset + 1] = Math.sin(lat);
  brandedLandPositions[offset + 2] = -cosine * Math.sin(lon);
  if (brandedLandColors) brandedLandColors.set(linearPalette[afroUnityArtwork.afroUnityLandColorIndices[index]], offset);
}

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
  const requestedCameraZ = Number(options.cameraZ);
  options = { ...options, cameraZ: Math.max(2.7,
    Number.isFinite(requestedCameraZ) ? requestedCameraZ : 2.7) };
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let source = canvas, native = null, fallback = null, context = null;
  let destroyed = false, attached = true, contextLost = false, landReady = false;
  let labelsVisible = true, originBranded = false, elapsed = 0;
  let readyFrames = 0, checkedPixels = false, recovering = false;
  let lastNativePhi = NaN, lastNativeTilt = NaN, nativeDirty = true;
  let lastNativeMotion = null;
  let api = null;
  const originalMask = canvas.style.getPropertyValue('mask-image');
  const originalMaskPriority = canvas.style.getPropertyPriority('mask-image');
  const originalAfricaFeature = canvas.getAttribute('data-showave-africa-land');
  const originalAfricaCount = canvas.getAttribute('data-showave-africa-points');
  const worldAttributes = ['data-showave-world-points', 'data-showave-world-fill-points',
    'data-showave-world-edge-points', 'data-showave-world-spacing', 'data-showave-brand-palette-size',
    'data-showave-land-point-size', 'data-showave-logo-clearance-cells',
    'data-showave-land-outline-css-pixels', 'data-showave-route-effect-points',
    'data-showave-route-effect'];
  const originalWorldAttributes = worldAttributes.map(name => [name, canvas.getAttribute(name)]);
  const worldSpacing = WORLD_SPACING;
  let nativeLandInfo = null;

  function identifyAfrica(pointCount) {
    source.dataset.showaveAfricaLand = pointCount > 0 ? 'afro-unity-full-logo' : 'unavailable';
    source.dataset.showaveAfricaPoints = String(pointCount);
  }
  function identifyWorld(fillPoints, edgePoints, spacing, sourceColors) {
    source.dataset.showaveWorldPoints = String(fillPoints + edgePoints);
    source.dataset.showaveWorldFillPoints = String(fillPoints);
    source.dataset.showaveWorldEdgePoints = String(edgePoints);
    source.dataset.showaveWorldSpacing = String(spacing);
    source.dataset.showaveBrandPaletteSize = String(sourceColors && hasArtworkColors ? linearPalette.length : 1);
    source.dataset.showaveLandPointSize = String(UNIFORM_POINT_SIZE);
    source.dataset.showaveLogoClearanceCells = String(clearanceKeys.size);
    source.dataset.showaveLandOutlineCssPixels = '1';
    source.dataset.showaveRouteEffectPoints = '224';
    source.dataset.showaveRouteEffect = 'electric-pulses';
  }

  function useFallback(reason) {
    if (destroyed) return;
    recovering = false;
    if (!fallback) fallback = createFallbackGlobe(source, { ...options, tileDeg: worldSpacing,
      motionEnabled: !motion.matches && !document.body.classList.contains('motion-paused') });
    identifyAfrica(afroUnityLandPoints.length);
    identifyWorld(fallback.landPointCount, 0, fallback.landSpacingDegrees, fallback.sourceColors);
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
    nativeDirty = true;
    if (nativeLandInfo) identifyWorld(nativeLandInfo.fillPointCount, nativeLandInfo.edgePointCount, nativeLandInfo.tileDeg, nativeLandInfo.brandedVertexColors);
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
    api?.update({ deltaTime: 0, forceDraw: true });
  }

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  canvas.setAttribute('aria-label', 'SHOWAVE connections from Kampala, Uganda, to the world. Illustrative routes.');
  try {
    native = createNativeGlobe(canvas, {
      ...options, airportsData, flightsData, showArcs: true, enableControls: false,
      tileDeg: worldSpacing,
      uniformLandPointSize: UNIFORM_POINT_SIZE, worldLandOpacity: 0.45,
      landOutlineCssPixels: 1, routeSparks: true,
      omitCoastPoints: true, worldLandFilter: filterWorldLandPositions,
      pinDotColor: '#ff8a45', arcColor: '#ff783c', arcThickness: 0.0016,
      arcAltBase: 0.025, arcAltMultiplier: 0.045,
      // No separate branded layer: worldLandFilter adds the logo cells to the land itself.
      onLandReady(info = {}) {
        if (destroyed) return;
        const { fillPointCount = 0, edgePointCount = 0, tileDeg = worldSpacing } = info;
        nativeLandInfo = { fillPointCount, edgePointCount, tileDeg, brandedVertexColors: false };
        identifyAfrica(afroUnityLandPoints.length);
        if (!fallback) identifyWorld(fillPointCount, edgePointCount, tileDeg, false);
        landReady = true;
        readyFrames = 0;
        checkedPixels = false;
        recovering = !!fallback;
        api?.update({ deltaTime: 0, forceDraw: true });
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

  api = {
    update({ deltaTime = 0, forceDraw = false } = {}) {
      if (destroyed || !attached || document.hidden) return;
      if (forceDraw) nativeDirty = true;
      const manual = interaction.getState();
      const canAnimate = !motion.matches && !document.body.classList.contains('motion-paused');
      if (canAnimate && !manual.isInteracting) elapsed += Math.min(100, Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0));
      const frame = {
        // Sweep slowly between Africa and the end of the UNITY GROUP lettering (about 127E),
        // which is wider than one face of the globe; manual orbit still reaches the world.
        phi: AFRICA_PHI + manual.yaw + (motion.matches ? 0 : options.keepOriginInView === false ?
          (elapsed * 0.00009) % (Math.PI * 2) : -0.15 + 0.25 * Math.sin(elapsed * Math.PI * 2 / 70000)),
        theta: 0.15 + manual.pitch,
        deltaTime: canAnimate ? deltaTime : 0,
        elapsedTime: elapsed, forceDraw,
        motionEnabled: canAnimate
      };
      const nativeNeedsFrame = nativeDirty || canAnimate || !checkedPixels || recovering ||
        frame.motionEnabled !== lastNativeMotion ||
        frame.phi !== lastNativePhi || frame.theta !== lastNativeTilt;
      if (native && !contextLost && (!fallback || recovering) && nativeNeedsFrame) {
        try {
          native.update(frame);
          lastNativePhi = frame.phi;
          lastNativeTilt = frame.theta;
          lastNativeMotion = frame.motionEnabled;
          nativeDirty = false;
          identifyOrigin();
          if (landReady && !checkedPixels && (forceDraw || ++readyFrames >= 30) && source.clientWidth > 0) {
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
      nativeDirty = true;
      try { native?.resize(width, height); } catch { useFallback('resize-error'); }
      fallback?.resize(width, height);
      // Resizing clears a backing bitmap even when the host's motion is paused.
      // Repaint the current frame once; do not advance orientation or route time.
      api.update({ deltaTime: 0, forceDraw: true });
    },
    isInteracting() { return interaction.getState().isInteracting; },
    setLabelsVisible(visible) {
      nativeDirty = true;
      labelsVisible = visible;
      native?.setLabelsVisible(visible && !fallback);
      fallback?.setLabelsVisible(visible);
    },
    attach(nextCanvas) {
      source = native ? native.attach(nextCanvas) : fallback.attach(nextCanvas);
      if (native && fallback) fallback.attach(source);
      interaction.attach(source);
      attached = true;
      nativeDirty = true;
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
      if (originalAfricaFeature === null) source.removeAttribute('data-showave-africa-land');
      else source.setAttribute('data-showave-africa-land', originalAfricaFeature);
      if (originalAfricaCount === null) source.removeAttribute('data-showave-africa-points');
      else source.setAttribute('data-showave-africa-points', originalAfricaCount);
      for (const [name, value] of originalWorldAttributes) {
        if (value === null) source.removeAttribute(name);
        else source.setAttribute(name, value);
      }
    }
  };
  return api;
}
