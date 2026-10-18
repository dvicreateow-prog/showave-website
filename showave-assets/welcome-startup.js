// A fresh visit to the main homepage opens its compact Home welcome.
import { installWelcomeOverlay } from './welcome-overlay.js?v=original-home-2';
if(location.pathname==='/'||location.pathname==='/index.html'){
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installWelcomeOverlay,{once:true});
 else installWelcomeOverlay();
}
