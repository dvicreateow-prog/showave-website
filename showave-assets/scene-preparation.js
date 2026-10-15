/* Warm compressed assets without keeping entire image sequences decoded in RAM. */
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REQUESTS = 400;
const queue = new Map();
const completed = new Set();
const requests = new Map();
const scenes = new Map();
let bytes = 0;
let count = 0;
let timer = 0;
let idle = 0;
let lastInput = 0;
let suspended = false;
const connection = navigator.connection;

function constrained() {
  return connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '');
}

export function warmAssets(urls, { priority = 10 } = {}) {
  if (constrained() || bytes >= MAX_BYTES || count >= MAX_REQUESTS) return;
  for (const candidate of urls) {
    if (!candidate) continue;
    let url;
    try { url = new URL(candidate, location.href); } catch { continue; }
    if (url.origin !== location.origin || !/\.(avif|webp|png|jpe?g|svg)(\?|$)/i.test(url.href)) continue;
    const key = url.href;
    if (completed.has(key) || requests.has(key)) continue;
    if (queue.has(key)) queue.set(key, Math.min(priority, queue.get(key)));
    else if (queue.size + count < MAX_REQUESTS) queue.set(key, priority);
  }
  schedule();
}

function schedule(delay = 0) {
  if (timer || idle || suspended || document.hidden || !queue.size || bytes >= MAX_BYTES || count >= MAX_REQUESTS) return;
  timer = window.setTimeout(() => {
    timer = 0;
    if (suspended || document.hidden) return;
    const sinceInput = performance.now() - lastInput;
    if (sinceInput < 180) { schedule(200); return; }
    if (window.requestIdleCallback) idle = window.requestIdleCallback(() => { idle = 0; pump(); }, { timeout: 2000 });
    else pump();
  }, delay);
}

function pump() {
  if (suspended || document.hidden || constrained() || bytes >= MAX_BYTES || count >= MAX_REQUESTS) return;
  if (performance.now() - lastInput < 180) { schedule(200); return; }
  while (requests.size < 2 && queue.size && bytes < MAX_BYTES && count < MAX_REQUESTS) {
    let url, best = Infinity;
    for (const [candidate, priority] of queue) if (priority < best) { url = candidate; best = priority; }
    queue.delete(url);
    const controller = new AbortController();
    requests.set(url, controller);
    count++;
    fetch(url, { cache: 'force-cache', priority: 'low', signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        // Consume the response to populate HTTP cache, without image decoding.
        const body = await response.arrayBuffer();
        bytes += body.byteLength;
        completed.add(url);
      })
      .catch(() => {})
      .finally(() => { requests.delete(url); schedule(40); });
  }
}

function imageSources(scene) {
  return [...scene.querySelectorAll('img')]
    .filter(image => image.getClientRects().length)
    .map(image => {
      image.decoding = 'async';
      return image.currentSrc || image.src;
    });
}

function connect(scene) {
  if (scenes.has(scene)) return;
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      warmAssets(imageSources(scene), { priority: 0 });
      observer.disconnect();
    }
  }, { rootMargin: '150% 0px' });
  observer.observe(scene);
  const prepare = window.setTimeout(() => {
    if (scene.isConnected) warmAssets(imageSources(scene), { priority: 5 });
  }, 2800);
  scenes.set(scene, () => { observer.disconnect(); clearTimeout(prepare); scenes.delete(scene); });
}

function scan(root) {
  const selector = '.home-about-wrap,.home-service-wrap,.home-why-wrap,.home-testi-wrap';
  if (root instanceof Element && root.matches(selector)) connect(root);
  root.querySelectorAll?.(selector).forEach(connect);
}

function onInput() { lastInput = performance.now(); }
for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) window.addEventListener(type, onInput, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
connection?.addEventListener?.('change', () => schedule());
window.addEventListener('pagehide', () => {
  suspended = true;
  clearTimeout(timer);
  if (idle) window.cancelIdleCallback(idle);
  timer = 0;
  idle = 0;
  for (const controller of requests.values()) controller.abort();
  for (const destroy of [...scenes.values()]) destroy();
});
window.addEventListener('pageshow', () => { suspended = false; scan(document); schedule(); });
const observer = new MutationObserver(records => {
  for (const [scene, destroy] of scenes) if (!scene.isConnected) destroy();
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
});
observer.observe(document.body, { childList: true, subtree: true });
scan(document);
