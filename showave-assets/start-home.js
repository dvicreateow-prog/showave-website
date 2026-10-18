import { STORAGE_KEY, readWelcomeStore, serializeWelcomeStore } from './welcome-model.js';

// Match the installed Home's two original portraits and 8s / 1.8s crossfade.
const cover = document.querySelector('.start-window-cover');
const firstCover = cover?.querySelector('.start-cover-art');
if (cover && firstCover && !cover.dataset.coverInitialized) {
  cover.dataset.coverInitialized = 'true';
  const secondCover = new Image();
  secondCover.className = 'start-cover-art start-cover-art-secondary';
  secondCover.src = '/showave-assets/assets/start/showave-welcome-cover-2.jpg';
  secondCover.alt = '';
  secondCover.setAttribute('aria-hidden', 'true');
  secondCover.width = 1080;
  secondCover.height = 1034;
  secondCover.decoding = 'async';
  secondCover.sizes = '(min-width: 1200px) 400px, (min-width: 980px) 37vw, 100vw';
  firstCover.after(secondCover);
  const toggle = document.createElement('button');
  toggle.className = 'start-cover-toggle';
  toggle.type = 'button';
  toggle.hidden = true;
  cover.append(toggle);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, timer = null, ready = false, paused = false;
  let visible = !('IntersectionObserver' in window);
  function stopCover() { clearTimeout(timer); timer = null; }
  function selectCover(index) {
    frame = index;
    secondCover.classList.toggle('is-active', index === 1);
    cover.dataset.coverFrame = String(index);
  }
  function syncCover() {
    stopCover();
    const sitePaused = document.body.classList.contains('motion-paused');
    const motionDisabled = reducedMotion.matches || sitePaused;
    toggle.textContent = motionDisabled ? 'Still' : paused ? 'Play' : 'Pause';
    toggle.disabled = motionDisabled;
    toggle.setAttribute('aria-pressed', String(paused || motionDisabled));
    toggle.setAttribute('aria-label', motionDisabled ? 'Cover animation disabled by motion preference' : paused ? 'Play cover slideshow' : 'Pause cover slideshow');
    if (!ready) { cover.dataset.coverSlideshow = 'loading'; return; }
    if (motionDisabled) { selectCover(0); cover.dataset.coverSlideshow = 'reduced-motion'; return; }
    if (paused || !visible || document.hidden) { cover.dataset.coverSlideshow = 'paused'; return; }
    cover.dataset.coverSlideshow = 'running';
    timer = setTimeout(() => { timer = null; selectCover(frame ? 0 : 1); syncCover(); }, 8000);
  }
  toggle.addEventListener('click', () => { paused = !paused; syncCover(); });
  reducedMotion.addEventListener('change', syncCover);
  new MutationObserver(syncCover).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', syncCover);
  window.addEventListener('pagehide', stopCover);
  window.addEventListener('pageshow', syncCover);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncCover(); }, { threshold: .15 }).observe(cover);
  }
  selectCover(0);
  syncCover();
  Promise.all([firstCover.decode(), secondCover.decode()]).then(() => {
    firstCover.width = secondCover.width = firstCover.naturalWidth;
    firstCover.height = secondCover.height = firstCover.naturalHeight;
    ready = true;
    cover.dataset.coverReady = 'true';
    toggle.hidden = false;
    syncCover();
  }).catch(() => { stopCover(); cover.dataset.coverSlideshow = 'paused'; });
}

// This website welcome links to guides. Desktop file history stays inside the app.
const startup = document.querySelector('[data-start-startup]');
const storageStatus = document.querySelector('[data-start-storage]');
if (startup) {
  try {
    const stored = readWelcomeStore(localStorage.getItem(STORAGE_KEY));
    startup.checked = stored.preferences.welcomeOnStart;
    sessionStorage.setItem('showave.welcome.seen.v1', '1');
  } catch {
    storageStatus.textContent = 'Browser preferences are unavailable for this visit.';
  }
  startup.addEventListener('change', () => {
    try {
      const stored = readWelcomeStore(localStorage.getItem(STORAGE_KEY));
      stored.preferences.welcomeOnStart = startup.checked;
      localStorage.setItem(STORAGE_KEY, serializeWelcomeStore(stored));
      storageStatus.textContent = '';
    } catch {
      storageStatus.textContent = 'This preference could not be saved in this browser.';
    }
  });
}

// Keep release text independent from the artwork and in step with downloads.
let releaseRequest = null;
let releaseCheckedAt = 0;
async function refreshPublishedRelease() {
  if (releaseRequest) return releaseRequest;
  releaseCheckedAt = Date.now();
  releaseRequest = updatePublishedRelease().finally(() => { releaseRequest = null; });
  return releaseRequest;
}
async function updatePublishedRelease() {
 try {
  const response = await fetch('/showave-assets/release-config.json', { cache: 'no-cache' });
  if (response.ok) {
    const release = await response.json();
    const version = release.platforms?.windows?.version || release.version;
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
      document.querySelectorAll('[data-start-version]').forEach(label => {
        label.textContent = version;
        label.dataset.publishedVersion = version;
        label.title = 'Published Windows preview';
        label.setAttribute('aria-label', `Published Windows preview ${version}`);
      });
    }
  }
 } catch { /* Keep the neutral preview label when release metadata is unavailable. */ }
}
void refreshPublishedRelease();
// A welcome tab may remain open across a release. Recheck when it is revisited.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - releaseCheckedAt > 60000) void refreshPublishedRelease();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) void refreshPublishedRelease();
});
