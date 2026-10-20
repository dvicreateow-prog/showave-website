// Fetch the original entry through its existing modulepreload, then execute it
// once the welcome hands over. Its software loader must remain visible to see.
import { installWelcomeOverlay } from './welcome-overlay.js?v=original-home-4';

const ENTRY = '/mirror/united-carriers.netlify.app/main.js?showave-performance=1';
let started = false;

function startWebsite() {
  if (started) return;
  started = true;
  window.removeEventListener('showave:welcome-overlay', welcomeChanged);
  // This belongs only to the original intro, not to saved appearance or app
  // preferences. A new welcome visit gets the complete software reveal.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    try { sessionStorage.removeItem('isLoaded'); } catch { /* Storage is optional. */ }
  }
  document.documentElement.dataset.showaveWebsiteStartup = 'launching';
  import(ENTRY).then(() => {
    document.documentElement.dataset.showaveWebsiteStartup = 'started';
  }).catch(() => {
    // A missing entry must leave useful website links and a recovery action.
    document.documentElement.dataset.showaveWebsiteStartup = 'unavailable';
    const loader = document.querySelector('.loader');
    if (loader) { loader.style.opacity = '0'; loader.style.pointerEvents = 'none'; }
    const notice = document.createElement('div');
    notice.className = 'showave-startup-recovery';
    notice.setAttribute('role', 'status');
    const message = document.createElement('span');
    message.textContent = 'The website could not finish loading.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reload website';
    retry.addEventListener('click', () => location.reload());
    notice.append(message, retry);
    document.body.append(notice);
  });
}

function welcomeChanged(event) {
  if (event.detail?.open === false) startWebsite();
}

function install() {
  window.addEventListener('showave:welcome-overlay', welcomeChanged);
  document.documentElement.dataset.showaveWebsiteStartup = 'welcome';
  try { installWelcomeOverlay(); }
  catch {
    // A partial welcome failure should hand over to the regular website too.
    document.querySelector('#showave-welcome-overlay[open]')?.close();
  } finally {
    // Unsupported dialogs or a failed initial open must not gate the website.
    if (!document.querySelector('#showave-welcome-overlay[open]')) startWebsite();
  }
}

if (location.pathname === '/' || location.pathname === '/index.html') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}
