/* Canvas 2D keeps the Kampala globe visible when a browser cannot use WebGL. */
import { AFRICA_PHI, ORIGIN, DESTINATIONS } from './globe-routes.js';
import { landPoints } from './globe-land-points.js';

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function vector(longitude, latitude) {
  const cos = Math.cos(latitude * RAD);
  return [cos * Math.cos(longitude * RAD), Math.sin(latitude * RAD), -cos * Math.sin(longitude * RAD)];
}

const land = landPoints.map(([longitude, latitude]) => vector(longitude, latitude));
const origin = vector(ORIGIN.lng, ORIGIN.lat);
const destinations = DESTINATIONS.map(point => ({ ...point, vector: vector(point.lng, point.lat) }));
const routes = destinations.map((point, index) => {
  const distance = Math.hypot(...point.vector.map((value, axis) => value - origin[axis]));
  const altitude = 0.035 + Math.min(0.5, distance * 0.09);
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
  let source = sourceCanvas;
  let destroyed = false;
  let attached = true;
  let labelsVisible = true;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let elapsed = 0;
  let lastDraw = -Infinity;
  let phi = AFRICA_PHI;
  let needsDraw = true;
  const cameraZ = Math.max(1.2, Number(options.cameraZ) || 2.9);
  const scale = clamp(Number(options.globeScale) || 1, 0.1, cameraZ - 0.1);
  const offsetX = Number(options.globeOffsetX) || 0;
  const offsetY = Number(options.globeOffsetY) || 0;
  const tiltX = Number.isFinite(options.globeRotationX) ? options.globeRotationX : 0.15;
  const tiltZ = Number.isFinite(options.globeRotationZ) ? options.globeRotationZ : 0.05;
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
  function project(point, sine, cosine) {
    const zCos = Math.cos(tiltZ), zSin = Math.sin(tiltZ);
    const xCos = Math.cos(tiltX), xSin = Math.sin(tiltX);
    const x0 = point[0] * zCos - point[1] * zSin;
    const y0 = point[0] * zSin + point[1] * zCos;
    const x1 = x0 * cosine + point[2] * sine;
    const z1 = -x0 * sine + point[2] * cosine;
    const y = y0 * xCos - z1 * xSin;
    const z = y0 * xSin + z1 * xCos;
    const perspective = focal / Math.max(0.1, cameraZ - z * scale);
    return {
      x: width / 2 + (x1 * scale + offsetX) * perspective,
      y: height / 2 - (y * scale + offsetY) * perspective,
      front: z * cameraZ > scale,
      depth: z
    };
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
    const ratio = clamp(window.devicePixelRatio || 1, 1, 1.5);
    if (w === width && h === height && ratio === dpr) return;
    width = w;
    height = h;
    dpr = ratio;
    overlay.width = Math.round(width * dpr);
    overlay.height = Math.round(height * dpr);
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    focal = height / (2 * Math.tan(27.5 * RAD));
    radius = focal * scale / Math.sqrt(cameraZ * cameraZ - scale * scale);
    centerX = width / 2 + offsetX * focal / cameraZ;
    centerY = height / 2 - offsetY * focal / cameraZ;
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
    const fontSize = clamp(width / 115, 8, 11);
    const padding = isOrigin ? 10 : 5;
    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    const labelWidth = ctx.measureText(text).width + padding * 2;
    const labelHeight = fontSize * (isOrigin ? 3.4 : 1.8);
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
      ctx.font = `bold ${fontSize * 0.72}px "Courier New", monospace`;
      ctx.fillStyle = '#ffac76';
      ctx.fillText('AFRO UNITY GROUP', point.x, y + fontSize * 2.35);
    }
  }

  function draw() {
    const sine = Math.sin(phi), cosine = Math.cos(phi);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(sphere, 0, 0, width, height);
    const pointRadius = clamp(radius * 0.0015, 0.5, 1);
    const buckets = [[], [], [], []];
    for (const point of land) {
      const p = project(point, sine, cosine);
      if (p.front) buckets[clamp(Math.floor((p.depth - scale / cameraZ) * 6), 0, 3)].push(p);
    }
    for (let index = 0; index < buckets.length; index++) {
      ctx.fillStyle = `rgba(237,244,255,${0.28 + index * 0.2})`;
      ctx.beginPath();
      for (const point of buckets[index]) {
        ctx.moveTo(point.x + pointRadius, point.y);
        ctx.arc(point.x, point.y, pointRadius, 0, TAU);
      }
      ctx.fill();
    }
    for (const route of routes) {
      const points = route.points.map(point => project(point, sine, cosine));
      const visible = point => point.front || Math.hypot(point.x - centerX, point.y - centerY) > radius * 1.002;
      const head = (elapsed / 6500 + route.phase) % 1.5;
      const tail = head - 0.55;
      ctx.lineWidth = Math.max(0.7, radius * 0.0018);
      for (let index = 1; index < points.length; index++) {
        const progress = index / 64;
        if (progress > head || progress < tail || !visible(points[index - 1]) || !visible(points[index])) continue;
        ctx.strokeStyle = `rgba(255,${150 + Math.round(55 * progress)},70,${clamp((progress - tail) / 0.55, 0, 1) * 0.95})`;
        ctx.beginPath();
        ctx.moveTo(points[index - 1].x, points[index - 1].y);
        ctx.lineTo(points[index].x, points[index].y);
        ctx.stroke();
      }
    }
    const pins = destinations.map((point, index) => ({ ...point, projected: project(point.vector, sine, cosine), index }));
    pins.push({ ...ORIGIN, projected: project(origin, sine, cosine), index: -1 });
    for (const pin of pins) {
      const point = pin.projected;
      if (!point.front) continue;
      const isOrigin = pin.index === -1;
      const dotRadius = clamp(radius * (isOrigin ? 0.012 : 0.005), isOrigin ? 4 : 2, isOrigin ? 8 : 4);
      const pulse = (elapsed / 2200 + Math.max(0, pin.index) * 0.31) % 1;
      ctx.strokeStyle = `rgba(255,140,64,${(1 - pulse) * (isOrigin ? 0.65 : 0.3)})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(point.x, point.y, dotRadius + pulse * dotRadius * 3, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#ff924c';
      ctx.beginPath();
      ctx.arc(point.x, point.y, dotRadius, 0, TAU);
      ctx.fill();
      drawLabel(point, isOrigin ? ORIGIN.label : pin.country, isOrigin);
    }
    needsDraw = false;
  }

  function update({ phi: nextPhi, deltaTime = 0 } = {}) {
    if (destroyed) return;
    if (Number.isFinite(nextPhi)) phi = nextPhi;
    elapsed += clamp(Number.isFinite(deltaTime) ? deltaTime : 0, 0, 100);
    const now = performance.now();
    if (!needsDraw && now - lastDraw < 1000 / 30) return;
    // Native GSAP controls the source canvas. Mirror it so reveals and page
    // transitions keep exactly the same visibility and transform ownership.
    const visible = syncSource();
    if (!visible) return;
    draw();
    lastDraw = now;
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
    setLabelsVisible(visible) {
      const nextVisible = Boolean(visible);
      if (labelsVisible === nextVisible) return;
      labelsVisible = nextVisible;
      needsDraw = true;
    },
    isInteracting() { return false; },
    detach() { attached = false; source.remove(); overlay.remove(); },
    destroy() { destroyed = true; attached = false; overlay.remove(); sphere.width = sphere.height = 0; }
  };
}
