/* Animate the site's original ocean photograph when WebGL water cannot render. */
const OCEAN_IMAGE = '/mirror/cdn.prod.website-files.com/6a44eec1ed1af2c4c403df6b/6a44eec1ed1af2c4c403e981_a44825c5ffe02b6cfe7c994f6b46794b_ocean%20%281%29.jpg';
const FRAME_MS = 1000 / 24;
const MAX_PIXELS = 600000;
const TAU = Math.PI * 2;

export function createOceanFallback(host, { onReady } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'showave-ocean-fallback';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.state = 'loading';
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    display: 'none', pointerEvents: 'none', zIndex: '1'
  });
  host.appendChild(canvas);
  const context = canvas.getContext('2d', { alpha: false });
  const texture = document.createElement('canvas');
  const textureContext = texture.getContext('2d', { alpha: false });
  const image = new Image();
  image.decoding = 'async';
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active = false;
  let destroyed = false;
  let ready = false;
  let reportedReady = false;
  let failed = !context || !textureContext;
  let intersecting = typeof IntersectionObserver !== 'function';
  let animationFrame = 0;
  let previousTick = 0;
  let lastRender = 0;
  let elapsed = 0;
  let width = 0;
  let height = 0;
  let margin = 20;
  let resizeObserver;
  let intersectionObserver;

  function stop() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    previousTick = 0;
  }

  function canDraw() {
    return !destroyed && !failed && active && ready && intersecting &&
      !document.hidden && host.isConnected && width > 0 && height > 0;
  }

  function prepareTexture() {
    if (!ready || failed || !width || !height) return;
    margin = Math.max(20, Math.ceil(width * 0.035));
    texture.width = width + margin * 2;
    texture.height = height + margin * 2;
    const cover = Math.max(texture.width / image.naturalWidth, texture.height / image.naturalHeight);
    const imageWidth = image.naturalWidth * cover;
    const imageHeight = image.naturalHeight * cover;
    textureContext.drawImage(image, (texture.width - imageWidth) / 2, (texture.height - imageHeight) / 2, imageWidth, imageHeight);
  }

  function draw() {
    if (!canDraw()) return;
    const seconds = elapsed / 1000;
    const amplitude = Math.max(1.2, width * 0.0038);
    const rowHeight = Math.max(2, Math.round(height / 240));
    // Each small strip moves differently: the photograph's ripples compress,
    // expand and shear instead of moving as one flat image.
    for (let y = 0; y < height; y += rowHeight) {
      const row = Math.min(rowHeight + 1, height - y);
      const phase = y / Math.max(1, height);
      const horizontal = Math.sin(phase * 34 + seconds * 1.12) * amplitude +
        Math.sin(phase * 83 - seconds * 0.74) * amplitude * 0.38;
      const vertical = Math.sin(phase * 43 + seconds * 0.82) * 1.5 +
        Math.cos(phase * 19 - seconds * 0.47) * 1.2;
      const driftX = Math.sin(seconds * 0.13) * amplitude * 0.6;
      const driftY = Math.sin(seconds * 0.17) * 4;
      context.drawImage(texture, margin + horizontal + driftX, margin + y + vertical + driftY,
        width, row, 0, y, width, row);
    }
    // Faint travelling reflections add changing light to the original water.
    context.lineCap = 'round';
    for (let index = 0; index < 30; index++) {
      const seedX = (index * 0.61803398875 + 0.13) % 1;
      const seedY = (index * 0.41421356237 + 0.07) % 1;
      const x = seedX * width;
      const y = ((seedY + seconds * 0.012) % 1) * height;
      const shimmer = Math.pow(Math.max(0, Math.sin(seconds * 0.8 + index * 2.17)), 3);
      const edgeFade = Math.min(1, y / 25, (height - y) / 25);
      const alpha = (0.012 + shimmer * 0.04) * Math.max(0, edgeFade);
      const length = Math.max(9, width * (0.014 + (index % 5) * 0.006));
      context.strokeStyle = `rgba(150,204,226,${alpha})`;
      context.lineWidth = 0.55 + (index % 3) * 0.2;
      context.beginPath();
      for (let step = 0; step <= 8; step++) {
        const progress = step / 8;
        const px = x + (progress - 0.5) * length;
        const py = y + Math.sin(progress * TAU + seconds * 0.9 + index) * 1.1;
        if (step === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.stroke();
    }
    if (!reportedReady) {
      reportedReady = true;
      canvas.dataset.state = 'ready';
      canvas.dataset.ready = 'true';
      // Defer notification until the caller has received this controller.
      if (typeof onReady === 'function') queueMicrotask(() => { if (!destroyed) onReady(); });
    }
  }

  function tick(now) {
    animationFrame = 0;
    if (!canDraw() || motion.matches) {
      previousTick = 0;
      return;
    }
    if (previousTick) elapsed += Math.min(100, Math.max(0, now - previousTick));
    previousTick = now;
    const sinceRender = now - lastRender;
    if (sinceRender >= FRAME_MS) {
      draw();
      lastRender = now - sinceRender % FRAME_MS;
    }
    animationFrame = requestAnimationFrame(tick);
  }

  function refresh() {
    if (destroyed) return;
    canvas.style.display = active && ready && !failed ? 'block' : 'none';
    if (!canDraw()) { stop(); return; }
    draw();
    lastRender = performance.now();
    if (motion.matches) { stop(); return; }
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  }

  function resize() {
    if (destroyed || failed) return;
    const cssWidth = Math.max(0, host.clientWidth);
    const cssHeight = Math.max(0, host.clientHeight);
    if (!cssWidth || !cssHeight) { width = height = 0; stop(); return; }
    const pixelRatio = Math.min(1, window.devicePixelRatio || 1,
      Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)));
    const nextWidth = Math.max(1, Math.floor(cssWidth * pixelRatio));
    const nextHeight = Math.max(1, Math.floor(cssHeight * pixelRatio));
    if (width === nextWidth && height === nextHeight) return;
    width = nextWidth;
    height = nextHeight;
    canvas.width = width;
    canvas.height = height;
    prepareTexture();
    refresh();
  }

  function onVisibilityChange() { refresh(); }
  function onMotionChange() { refresh(); }

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
  } else {
    window.addEventListener('resize', resize, { passive: true });
  }
  if (typeof IntersectionObserver === 'function') {
    intersectionObserver = new IntersectionObserver(entries => {
      if (destroyed) return;
      const entry = entries.find(item => item.target === host);
      if (!entry || entry.isIntersecting === intersecting) return;
      intersecting = entry.isIntersecting;
      refresh();
    });
    intersectionObserver.observe(host);
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
  else motion.addListener(onMotionChange);

  image.onload = () => {
    if (destroyed || failed) return;
    if (!image.naturalWidth || !image.naturalHeight) { image.onerror(); return; }
    ready = true;
    prepareTexture();
    refresh();
  };
  image.onerror = () => {
    if (destroyed) return;
    failed = true;
    ready = false;
    canvas.dataset.state = 'failed';
    canvas.style.display = 'none';
    stop();
    image.onload = image.onerror = null;
  };
  resize();
  if (failed) canvas.dataset.state = 'failed';
  else image.src = OCEAN_IMAGE;

  return {
    setActive(value) {
      if (destroyed || active === Boolean(value)) return;
      active = Boolean(value);
      refresh();
    },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
      else motion.removeListener(onMotionChange);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      canvas.remove();
      canvas.width = canvas.height = texture.width = texture.height = 0;
    }
  };
}
