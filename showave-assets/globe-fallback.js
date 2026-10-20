/* Canvas 2D keeps the Kampala globe visible when a browser cannot use WebGL. */
import { AFRICA_PHI, ORIGIN, DESTINATIONS } from './globe-routes.js';
import { denseWorldLandPointsDesktop } from './globe-land-dense.js?v=africa-mark-9';
import * as afroUnityArtwork from './afro-unity-land.js?v=africa-mark-9';
import { createRouteSparkField, ROUTE_SPARK_PALETTE, ROUTE_PULSE_TAIL } from './globe-route-sparks.js?v=africa-mark-9';

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const FRAME_MS = 1000 / 60;
const FRAME_TOLERANCE = FRAME_MS / 4;
const MAX_PIXELS = 1000000;
const MIN_PIXELS = 600000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const projectedPoint = () => ({ x: 0, y: 0, front: false, depth: 0, radius: 0 });

function vector(longitude, latitude) {
  const cos = Math.cos(latitude * RAD);
  return [cos * Math.cos(longitude * RAD), Math.sin(latitude * RAD), -cos * Math.sin(longitude * RAD)];
}

const { afroUnityLandPoints } = afroUnityArtwork;
const hasArtworkColors = Array.isArray(afroUnityArtwork.afroUnityLandPalette) &&
  afroUnityArtwork.afroUnityLandPalette.length > 0 &&
  afroUnityArtwork.afroUnityLandPalette.every(color => /^#[0-9a-f]{6}$/i.test(color)) &&
  afroUnityArtwork.afroUnityLandColorIndices?.length === afroUnityLandPoints.length &&
  afroUnityArtwork.afroUnityLandColorIndices.every(index => Number.isInteger(index) && index >= 0 && index < afroUnityArtwork.afroUnityLandPalette.length);
const artworkPalette = hasArtworkColors ? afroUnityArtwork.afroUnityLandPalette : ['#f5d58b'];
const artworkColorIndices = hasArtworkColors ? afroUnityArtwork.afroUnityLandColorIndices : null;
// Resolve the current artwork's halo once; the bundled world table may predate it.
// Native and compatibility renderers use the same canonical 0.6-degree world key.
const logoClearanceKeys = new Set(afroUnityArtwork.afroUnityClearanceKeys || []);
function worldCellKey(longitude, latitude) {
  const canonicalLongitude = ((longitude + 540) % 360) - 180;
  return Math.round((latitude + 90) / 0.6) * 601 +
    Math.round((canonicalLongitude + 180) / 0.6);
}
// The logo is drawn in the world's own dots: same size, colour and depth shading as land.
const land = denseWorldLandPointsDesktop
  .filter(([longitude, latitude]) => !logoClearanceKeys.has(worldCellKey(longitude, latitude)))
  .concat(afroUnityLandPoints)
  .map(([longitude, latitude]) => vector(longitude, latitude));
const brandedLand = [];
function gridNeighbors(point) {
  const longitude = Math.atan2(-point[2], point[0]) / RAD;
  const latitude = Math.asin(clamp(point[1], -1, 1)) / RAD;
  return [vector(longitude + 0.6, latitude), vector(longitude, latitude + 0.6)];
}
const landNeighbors = land.map(gridNeighbors);
const brandedNeighbors = brandedLand.map(gridNeighbors);
const origin = vector(ORIGIN.lng, ORIGIN.lat);
const destinations = DESTINATIONS.map(point => ({ ...point, vector: vector(point.lng, point.lat) }));
const routes = destinations.map((point, index) => {
  const distance = 1.002 * Math.hypot(...point.vector.map((value, axis) => value - origin[axis]));
  const altitude = 0.025 + Math.min(0.5, distance * 0.045);
  return {
    phase: index * 0.6180339887 % 1,
    points: Array.from({ length: 65 }, (_, step) => {
      const t = step / 64;
      const mixed = origin.map((value, axis) => value * (1 - t) + point.vector[axis] * t);
      const radius = (1.002 + 4 * altitude * t * (1 - t)) / Math.hypot(...mixed);
      return mixed.map(value => value * radius);
    })
  };
});

export function createFallbackGlobe(sourceCanvas, options = {}) {
  const landSpacingDegrees = 0.6;
  let source = sourceCanvas;
  let destroyed = false;
  let attached = true;
  let labelsVisible = true;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let elapsed = 0;
  let motionEnabled = options.motionEnabled !== false;
  let lastDraw = -Infinity;
  let phi = AFRICA_PHI;
  let needsDraw = true;
  let pixelBudget = MAX_PIXELS;
  let averageCost = 0, costlyFrames = 0, easyFrames = 0;
  let paintedPhi = NaN, paintedTilt = NaN, paintedTime = NaN;
  let labelFontSize = 8, drawingFont = '';
  const labelMetrics = new Map();
  const cameraZ = Math.max(1.2, Number(options.cameraZ) || 2.9);
  const scale = clamp(Number(options.globeScale) || 1, 0.1, cameraZ - 0.1);
  const offsetX = Number(options.globeOffsetX) || 0;
  const offsetY = Number(options.globeOffsetY) || 0;
  let tiltX = Number.isFinite(options.globeRotationX) ? options.globeRotationX : 0.15;
  const tiltZ = Number.isFinite(options.globeRotationZ) ? options.globeRotationZ : 0.05;
  let xCos = 1, xSin = 0, zCos = 1, zSin = 0;
  const projectedLand = land.map(projectedPoint);
  const projectedBrandedLand = brandedLand.map(projectedPoint);
  const neighborProjection = [projectedPoint(), projectedPoint()];
  const projectedRoutes = routes.map(route => ({ ...route, projected: route.points.map(projectedPoint) }));
  const pins = destinations.map((point, index) => ({ ...point, projected: projectedPoint(), index }));
  pins.push({ ...ORIGIN, vector: origin, projected: projectedPoint(), index: -1 });
  const landHeads = new Int32Array(4);
  const landNext = new Int32Array(land.length);
  const landColors = ['rgba(237,244,255,.126)', 'rgba(237,244,255,.216)',
    'rgba(237,244,255,.306)', 'rgba(237,244,255,.396)'];
  const brandedHeads = new Int32Array(artworkPalette.length * 4);
  const brandedNext = new Int32Array(brandedLand.length);
  const brandedColors = artworkPalette.flatMap(color => {
    const rgb = Number.parseInt(color.slice(1), 16);
    return [0.34, 0.54, 0.74, 0.94].map(alpha => `rgba(${rgb >> 16 & 255},${rgb >> 8 & 255},${rgb & 255},${alpha})`);
  });
  const sparkCurves = routes.map(route => new Float32Array(route.points.flat()));
  const sparkField = createRouteSparkField(sparkCurves);
  const projectedSparks = Array.from({ length: sparkField.count }, projectedPoint);
  const sparkVector = new Float32Array(3);
  const sparkHeads = new Int32Array(ROUTE_SPARK_PALETTE.length * 8);
  const sparkNext = new Int32Array(sparkField.count);
  const sparkColors = ROUTE_SPARK_PALETTE.flatMap(color => {
    const rgb = Number.parseInt(color.slice(1), 16);
    return Array.from({ length: 8 }, (_, index) =>
      `rgba(${rgb >> 16 & 255},${rgb >> 8 & 255},${rgb & 255},${(index + 1) / 8})`);
  });
  const pulseGlowColors = Array.from({ length: 16 }, (_, index) => `rgba(255,155,48,${(index + 1) / 16 * 0.24})`);
  const pulseCoreColors = Array.from({ length: 16 }, (_, index) => `rgba(255,188,88,${(index + 1) / 16 * 0.95})`);
  const pulseWhiteColors = Array.from({ length: 16 }, (_, index) => `rgba(255,244,215,${(index + 1) / 16 * 0.9})`);
  const overlay = document.createElement('canvas');
  overlay.className = 'showave-globe-fallback';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.dataset.showaveRenderer = 'canvas2d';
  Object.assign(overlay.style, { position: 'absolute', pointerEvents: 'none', margin: '0', padding: '0', border: '0' });
  const ctx = overlay.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const sphere = document.createElement('canvas');
  const sphereContext = sphere.getContext('2d', { alpha: true });
  let focal = 1;
  let radius = 1;
  let centerX = 0;
  let centerY = 0;

  // Match the native renderer's XYZ Euler rotation and perspective camera.
  function project(point, sine, cosine, projected) {
    const x0 = point[0] * zCos - point[1] * zSin;
    const y0 = point[0] * zSin + point[1] * zCos;
    const x1 = x0 * cosine + point[2] * sine;
    const z1 = -x0 * sine + point[2] * cosine;
    const y = y0 * xCos - z1 * xSin;
    const z = y0 * xSin + z1 * xCos;
    const perspective = focal / Math.max(0.1, cameraZ - z * scale);
    projected.x = width / 2 + (x1 * scale + offsetX) * perspective;
    projected.y = height / 2 - (y * scale + offsetY) * perspective;
    projected.front = z * cameraZ > scale;
    projected.depth = z;
    return projected;
  }

  function outlinedRadius(point, neighbors, sine, cosine, baseRadius) {
    const longitude = project(neighbors[0], sine, cosine, neighborProjection[0]);
    const latitude = project(neighbors[1], sine, cosine, neighborProjection[1]);
    const spacing = Math.min(Math.hypot(longitude.x - point.x, longitude.y - point.y),
      Math.hypot(latitude.x - point.x, latitude.y - point.y));
    // Add the same source-colored one-pixel edge, capped before circles merge.
    return Math.max(0.05, Math.min(baseRadius + 1, spacing * 0.4));
  }

  function makeSphere() {
    if (!sphereContext) return;
    sphere.width = overlay.width;
    sphere.height = overlay.height;
    const c = sphereContext;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);
    const body = c.createRadialGradient(centerX - radius * 0.2, centerY - radius * 0.35, radius * 0.1, centerX, centerY, radius);
    body.addColorStop(0, '#030508');
    body.addColorStop(0.83, '#010307');
    body.addColorStop(1, '#07132b');
    c.fillStyle = body;
    c.beginPath();
    c.arc(centerX, centerY, radius, 0, TAU);
    c.fill();
    const rim = c.createLinearGradient(0, centerY - radius, 0, centerY + radius);
    rim.addColorStop(0, '#ff974c');
    rim.addColorStop(0.22, 'rgba(255,109,46,.35)');
    rim.addColorStop(0.52, 'rgba(30,90,220,.12)');
    rim.addColorStop(0.78, 'rgba(30,82,255,.6)');
    rim.addColorStop(1, '#4d91ff');
    c.strokeStyle = rim;
    c.lineWidth = Math.max(1, radius * 0.007);
    c.shadowColor = '#2370ff';
    c.shadowBlur = radius * 0.025;
    c.stroke();
    c.shadowBlur = 0;
    const glow = c.createRadialGradient(centerX, centerY, radius * 0.9, centerX, centerY, radius);
    glow.addColorStop(0, 'rgba(20,60,200,0)');
    glow.addColorStop(0.85, 'rgba(20,60,200,.08)');
    glow.addColorStop(1, 'rgba(60,120,255,.25)');
    c.fillStyle = glow;
    c.fill();
  }

  function resize(nextWidth, nextHeight) {
    if (destroyed) return;
    const w = Math.max(1, Math.round(nextWidth || source.clientWidth || source.offsetWidth || 800));
    const h = Math.max(1, Math.round(nextHeight || source.clientHeight || source.offsetHeight || w));
    // Keep the same CSS size and geometry without allocating huge 4K buffers.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(pixelBudget / (w * h)));
    if (w === width && h === height && ratio === dpr) return;
    width = w;
    height = h;
    dpr = ratio;
    overlay.width = Math.max(1, Math.floor(width * dpr));
    overlay.height = Math.max(1, Math.floor(height * dpr));
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    focal = height / (2 * Math.tan(27.5 * RAD));
    radius = focal * scale / Math.sqrt(cameraZ * cameraZ - scale * scale);
    centerX = width / 2 + offsetX * focal / cameraZ;
    centerY = height / 2 - offsetY * focal / cameraZ;
    labelFontSize = clamp(width / 115, 8, 11);
    labelMetrics.clear();
    drawingFont = '';
    makeSphere();
    needsDraw = true;
  }

  function syncSource() {
    if (!attached || !source.isConnected || !source.parentElement) {
      overlay.style.display = 'none';
      return false;
    }
    if (overlay.parentElement !== source.parentElement) source.parentElement.appendChild(overlay);
    const computed = getComputedStyle(source);
    const styles = {
      left: `${source.offsetLeft}px`, top: `${source.offsetTop}px`,
      transform: computed.transform, transformOrigin: computed.transformOrigin,
      opacity: computed.opacity, visibility: computed.visibility,
      display: computed.display, filter: computed.filter, clipPath: computed.clipPath,
      borderRadius: computed.borderRadius, zIndex: computed.zIndex === 'auto' ? '1' : computed.zIndex
    };
    for (const [property, value] of Object.entries(styles)) {
      if (overlay.style[property] !== value) overlay.style[property] = value;
    }
    resize(source.clientWidth, source.clientHeight);
    return computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) > 0;
  }

  function drawLabel(point, text, isOrigin = false) {
    if (!labelsVisible || !point.front) return;
    const fontSize = labelFontSize;
    const padding = isOrigin ? 10 : 5;
    const font = `bold ${fontSize}px "Courier New", monospace`;
    if (drawingFont !== font) { ctx.font = font; drawingFont = font; }
    let metrics = labelMetrics.get(text);
    if (!metrics || metrics.isOrigin !== isOrigin) {
      metrics = { width: ctx.measureText(text).width + padding * 2,
        height: fontSize * (isOrigin ? 3.4 : 1.8), isOrigin };
      labelMetrics.set(text, metrics);
    }
    const labelWidth = metrics.width;
    const labelHeight = metrics.height;
    const x = point.x - labelWidth / 2;
    const y = point.y - labelHeight - (isOrigin ? 21 : 12);
    ctx.fillStyle = isOrigin ? 'rgba(8,12,19,.94)' : 'rgba(7,10,15,.84)';
    ctx.fillRect(x, y, labelWidth, labelHeight);
    if (isOrigin) {
      ctx.strokeStyle = 'rgba(255,145,76,.8)';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(x, y, labelWidth, labelHeight);
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, point.x, y + fontSize * (isOrigin ? 1.1 : 0.9));
    if (isOrigin) {
      drawingFont = `bold ${fontSize * 0.72}px "Courier New", monospace`;
      ctx.font = drawingFont;
      ctx.fillStyle = '#ffac76';
      ctx.fillText('AFRO UNITY GROUP', point.x, y + fontSize * 2.35);
    }
  }

  function draw() {
    const sine = Math.sin(phi), cosine = Math.cos(phi);
    xCos = Math.cos(tiltX); xSin = Math.sin(tiltX);
    zCos = Math.cos(tiltZ); zSin = Math.sin(tiltZ);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(sphere, 0, 0, width, height);
    const pointRadius = clamp(radius * 0.0015, 0.5, 1);
    landHeads.fill(-1);
    for (let index = 0; index < land.length; index++) {
      const p = project(land[index], sine, cosine, projectedLand[index]);
      if (p.front) {
        p.radius = outlinedRadius(p, landNeighbors[index], sine, cosine, pointRadius);
        const bucket = clamp(Math.floor((p.depth - scale / cameraZ) * 6), 0, 3);
        landNext[index] = landHeads[bucket];
        landHeads[bucket] = index;
      }
    }
    for (let index = 0; index < landHeads.length; index++) {
      ctx.fillStyle = landColors[index];
      ctx.beginPath();
      for (let pointIndex = landHeads[index]; pointIndex !== -1; pointIndex = landNext[pointIndex]) {
        const point = projectedLand[pointIndex];
        ctx.moveTo(point.x + point.radius, point.y);
        ctx.arc(point.x, point.y, point.radius, 0, TAU);
      }
      ctx.fill();
    }
    // The artwork is another geographic point set on the same sphere. Reuse
    // projected records and depth buckets without extra animation or vectors.
    const brandedRadius = pointRadius;
    brandedHeads.fill(-1);
    for (let index = 0; index < brandedLand.length; index++) {
      const point = project(brandedLand[index], sine, cosine, projectedBrandedLand[index]);
      if (point.front) {
        point.radius = outlinedRadius(point, brandedNeighbors[index], sine, cosine, brandedRadius);
        const depth = clamp(Math.floor((point.depth - scale / cameraZ) * 6), 0, 3);
        const bucket = (artworkColorIndices ? artworkColorIndices[index] : 0) * 4 + depth;
        brandedNext[index] = brandedHeads[bucket];
        brandedHeads[bucket] = index;
      }
    }
    for (let index = 0; index < brandedHeads.length; index++) {
      ctx.fillStyle = brandedColors[index];
      ctx.beginPath();
      for (let pointIndex = brandedHeads[index]; pointIndex !== -1; pointIndex = brandedNext[pointIndex]) {
        const point = projectedBrandedLand[pointIndex];
        ctx.moveTo(point.x + point.radius, point.y);
        ctx.arc(point.x, point.y, point.radius, 0, TAU);
      }
      ctx.fill();
    }
    sparkField.update(elapsed, motionEnabled);
    ctx.lineCap = 'round';
    for (let routeIndex = 0; routeIndex < projectedRoutes.length; routeIndex++) {
      const route = projectedRoutes[routeIndex];
      const points = route.projected;
      for (let index = 0; index < points.length; index++) project(route.points[index], sine, cosine, points[index]);
      ctx.lineWidth = Math.max(0.5, radius * 0.001);
      ctx.strokeStyle = 'rgba(255,170,78,.14)';
      ctx.beginPath();
      for (let index = 1; index < points.length; index++) {
        if (!routeVisible(points[index - 1]) || !routeVisible(points[index])) continue;
        ctx.moveTo(points[index - 1].x, points[index - 1].y);
        ctx.lineTo(points[index].x, points[index].y);
      }
      ctx.stroke();
      const head = sparkField.pulseStates[routeIndex * 4];
      const fade = sparkField.pulseStates[routeIndex * 4 + 1];
      if (fade <= 0) continue;
      for (let index = 1; index < points.length; index++) {
        if (!points[index - 1].front || !points[index].front) continue;
        const behind = head - (index - 0.5) / 64;
        if (behind < 0 || behind > ROUTE_PULSE_TAIL) continue;
        const strength = (1 - behind / ROUTE_PULSE_TAIL) ** 1.6 * fade;
        const bucket = Math.min(15, Math.floor(strength * 16));
        ctx.beginPath();
        ctx.moveTo(points[index - 1].x, points[index - 1].y);
        ctx.lineTo(points[index].x, points[index].y);
        ctx.lineWidth = clamp(radius * 0.012, 3, 5);
        ctx.strokeStyle = pulseGlowColors[bucket];
        ctx.stroke();
        ctx.lineWidth = clamp(radius * 0.004, 1.2, 1.8);
        ctx.strokeStyle = pulseCoreColors[bucket];
        ctx.stroke();
        if (behind < 0.038) {
          const core = (1 - behind / 0.038) ** 2 * fade;
          ctx.lineWidth = 0.65;
          ctx.strokeStyle = pulseWhiteColors[Math.min(15, Math.floor(core * 16))];
          ctx.stroke();
        }
      }
    }
    sparkHeads.fill(-1);
    for (let index = 0; index < sparkField.count; index++) {
      const alpha = sparkField.alphas[index];
      if (alpha <= 0.015) continue;
      const offset = index * 3;
      // Reuse one vector record rather than allocate a point per particle/frame.
      sparkVector[0] = sparkField.positions[offset];
      sparkVector[1] = sparkField.positions[offset + 1];
      sparkVector[2] = sparkField.positions[offset + 2];
      const point = project(sparkVector, sine, cosine, projectedSparks[index]);
      if (!point.front) continue;
      const bucket = sparkField.colorIndices[index] * 8 + Math.min(7, Math.floor(alpha * 8));
      sparkNext[index] = sparkHeads[bucket];
      sparkHeads[bucket] = index;
    }
    const sparkRadius = clamp(radius * 0.0038, 1, 1.8);
    for (let bucket = 0; bucket < sparkHeads.length; bucket++) {
      ctx.fillStyle = sparkColors[bucket];
      ctx.beginPath();
      for (let index = sparkHeads[bucket]; index !== -1; index = sparkNext[index]) {
        const point = projectedSparks[index];
        ctx.moveTo(point.x + sparkRadius, point.y);
        ctx.arc(point.x, point.y, sparkRadius, 0, TAU);
      }
      ctx.fill();
    }
    for (const pin of pins) {
      const point = project(pin.vector, sine, cosine, pin.projected);
      if (!point.front) continue;
      const isOrigin = pin.index === -1;
      const dotRadius = clamp(radius * (isOrigin ? 0.012 : 0.005), isOrigin ? 4 : 2, isOrigin ? 8 : 4);
      ctx.fillStyle = '#ff924c';
      ctx.beginPath();
      ctx.arc(point.x, point.y, dotRadius, 0, TAU);
      ctx.fill();
      drawLabel(point, isOrigin ? ORIGIN.label : pin.country, isOrigin);
    }
    paintedPhi = phi;
    paintedTilt = tiltX;
    paintedTime = elapsed;
    needsDraw = false;
  }

  function adaptQuality(cost) {
    averageCost = averageCost ? averageCost * 0.9 + cost * 0.1 : cost;
    costlyFrames = averageCost > 8 ? costlyFrames + 1 : 0;
    easyFrames = averageCost < 4 ? easyFrames + 1 : 0;
    let nextBudget = pixelBudget;
    if (costlyFrames >= 30) nextBudget = Math.max(MIN_PIXELS, Math.floor(pixelBudget * 0.8));
    else if (easyFrames >= 180) nextBudget = Math.min(MAX_PIXELS, Math.ceil(pixelBudget * 1.2));
    if (nextBudget !== pixelBudget) {
      pixelBudget = nextBudget;
      // Resize before the next paint, keeping every land point and route.
      needsDraw = true;
      costlyFrames = easyFrames = 0;
    }
  }

  function routeVisible(point) {
    const dx = point.x - centerX, dy = point.y - centerY;
    return point.front || dx * dx + dy * dy > radius * radius * 1.004004;
  }

  function update({ phi: nextPhi, theta, deltaTime = 0, elapsedTime,
    motionEnabled: nextMotionEnabled = motionEnabled, forceDraw = false } = {}) {
    if (destroyed || !attached || document.hidden) return;
    if (forceDraw || motionEnabled !== nextMotionEnabled) needsDraw = true;
    motionEnabled = nextMotionEnabled;
    if (Number.isFinite(nextPhi)) phi = nextPhi;
    if (Number.isFinite(theta)) tiltX = theta;
    if (Number.isFinite(elapsedTime)) elapsed = elapsedTime;
    else elapsed += clamp(Number.isFinite(deltaTime) ? deltaTime : 0, 0, 100);
    const now = performance.now();
    const sinceDraw = now - lastDraw;
    // The GSAP callback may arrive a few milliseconds before its ideal phase.
    // Allow that jitter without accidentally reducing a 60 Hz ticker to 30 Hz.
    if (!needsDraw && sinceDraw < FRAME_MS - FRAME_TOLERANCE) return;
    // Native GSAP controls the source canvas. Mirror it so reveals and page
    // transitions keep exactly the same visibility and transform ownership.
    const visible = syncSource();
    if (!visible) return;
    if (!needsDraw && phi === paintedPhi && tiltX === paintedTilt && elapsed === paintedTime) return;
    const forced = needsDraw;
    const started = performance.now();
    draw();
    adaptQuality(Math.max(0, performance.now() - started));
    lastDraw = forced || !Number.isFinite(sinceDraw) ? now :
      lastDraw + Math.max(1, Math.floor((sinceDraw + FRAME_TOLERANCE) / FRAME_MS)) * FRAME_MS;
  }

  function attach(newSourceCanvas) {
    if (destroyed || !newSourceCanvas?.parentNode) return source;
    const parent = newSourceCanvas.parentNode;
    if (newSourceCanvas !== source) parent.replaceChild(source, newSourceCanvas);
    parent.appendChild(overlay);
    attached = true;
    resize(source.clientWidth, source.clientHeight);
    needsDraw = true;
    update();
    return source;
  }

  if (source.parentElement) source.parentElement.appendChild(overlay);
  resize(source.clientWidth, source.clientHeight);
  update();
  return {
    update, resize, attach,
    landPointCount: land.length, landSpacingDegrees, sourceColors: hasArtworkColors,
    routeEffectPointCount: sparkField.count,
    setLabelsVisible(visible) {
      const nextVisible = Boolean(visible);
      if (labelsVisible === nextVisible) return;
      labelsVisible = nextVisible;
      needsDraw = true;
    },
    isInteracting() { return false; },
    detach() { attached = false; source.remove(); overlay.remove(); },
    destroy() {
      destroyed = true;
      attached = false;
      overlay.remove();
      overlay.width = overlay.height = sphere.width = sphere.height = 0;
    }
  };
}
