import { readWelcomeStore } from './welcome-model.js';
// Opt-in website welcome, once per browser session. Existing home motion stays intact.
if (location.pathname === '/' || location.pathname === '/index.html') {
  try {
    if (readWelcomeStore(localStorage.getItem('showave.welcome.v1')).preferences.welcomeOnStart && !sessionStorage.getItem('showave.welcome.seen.v1')) {
      sessionStorage.setItem('showave.welcome.seen.v1', '1');
      location.replace('/start');
    }
  } catch { /* Storage can be disabled; ordinary landing-page access remains available. */ }
}
