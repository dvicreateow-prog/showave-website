import { STORAGE_KEY, readWelcomeStore, serializeWelcomeStore } from './welcome-model.js';

const SEEN = 'showave.welcome.seen.v1';
let dialog,content,preference,status,previousFocus,loadPromise;
let installed=false,loaded=false,storageAvailable=true,visitPreference;

function preferred() {
  if(typeof visitPreference==='boolean')return visitPreference;
  try {
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw||raw.length>32768)return true;
    const parsed=JSON.parse(raw);
    // The historical model defaults missing/invalid data to false. Only a
    // persisted, explicit false is an opt-out from this new default welcome.
    return !(parsed?.version===1&&parsed.preferences?.welcomeOnStart===false);
  } catch {return true;}
}
function seen(){try{return !!sessionStorage.getItem(SEEN);}catch{return false;}}
function markSeen(){try{sessionStorage.setItem(SEEN,'1');}catch{}}
function savePreference() {
  visitPreference=preference.checked;
  try {
    const saved=readWelcomeStore(localStorage.getItem(STORAGE_KEY));
    saved.preferences.welcomeOnStart=preference.checked;
    localStorage.setItem(STORAGE_KEY,serializeWelcomeStore(saved));
    storageAvailable=true;
  } catch {storageAvailable=false;status.textContent='Your choice applies to this visit. Browser storage is unavailable.';}
}
function stylesheet(href) {
  const existing=[...document.querySelectorAll('link[rel="stylesheet"]')].find(link=>new URL(link.href,location.href).pathname===new URL(href,location.href).pathname);
  if(existing)return Promise.resolve();
  return new Promise(resolve=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;
    link.addEventListener('load',resolve,{once:true});link.addEventListener('error',resolve,{once:true});
    const appearance=document.querySelector('link[href*="/appearance.css"]');
    if(appearance)appearance.before(link);else document.head.append(link);
    // The dismiss control remains usable even if styles are unavailable.
    setTimeout(resolve,1500);
  });
}
function mount() {
  if(dialog)return;
  previousFocus=document.activeElement;
  dialog=document.createElement('dialog');dialog.id='showave-welcome-overlay';dialog.className='showave-welcome-overlay';
  dialog.setAttribute('aria-labelledby','showave-welcome-overlay-title');dialog.setAttribute('data-lenis-prevent','');
  dialog.innerHTML='<div class="welcome-overlay-heading"><h2 id="showave-welcome-overlay-title">Welcome to SHOWAVE.</h2><button type="button" class="welcome-overlay-close" aria-label="Close welcome">×</button></div><div class="welcome-overlay-content" aria-busy="true"><p class="welcome-overlay-loading" role="status">Your creative workspace is opening.</p></div><footer class="welcome-overlay-footer"><label><input type="checkbox" data-welcome-overlay-startup> Show this welcome when I visit</label><button type="button" class="welcome-overlay-continue">Continue to website <span aria-hidden="true">→</span></button><p class="welcome-overlay-status" role="status"></p></footer>';
  document.body.append(dialog);content=dialog.querySelector('.welcome-overlay-content');preference=dialog.querySelector('input');status=dialog.querySelector('.welcome-overlay-status');preference.checked=preferred();
  dialog.querySelectorAll('.welcome-overlay-close,.welcome-overlay-continue').forEach(button=>button.addEventListener('click',closeWelcomeOverlay));
  preference.addEventListener('change',savePreference);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeWelcomeOverlay();});
  dialog.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(node=>node.getClientRects().length>0);
    const first=controls[0],last=controls[controls.length-1];
    if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  });
  dialog.addEventListener('close',()=>{
    document.documentElement.removeAttribute('data-welcome-overlay-open');
    const target=previousFocus&&previousFocus!==document.body&&previousFocus.isConnected?previousFocus:
      document.querySelector('.header-logo')||document.querySelector('.home-hero-btn')||document.querySelector('a[href]');
    target?.focus({preventScroll:true});
    window.dispatchEvent(new CustomEvent('showave:welcome-overlay',{detail:{open:false}}));
  });
  // Existing download handling remains the single download dialog. Close the
  // welcome first so focus and keyboard controls never sit under another modal.
  dialog.addEventListener('click',event=>{if(event.target.closest?.('[data-download]'))closeWelcomeOverlay();});
}
async function loadCard() {
  if(loadPromise)return loadPromise;
  loadPromise=(async()=>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetch('/start/',{signal:controller.signal});if(!response.ok)throw Error('Welcome unavailable');
      const parsed=new DOMParser().parseFromString(await response.text(),'text/html');
      const card=parsed.querySelector('section.start-window');if(!card)throw Error('Welcome card unavailable');
      card.querySelectorAll('script,iframe,object,embed').forEach(node=>node.remove());
      card.querySelectorAll('*').forEach(node=>{[...node.attributes].forEach(attribute=>{if(/^on/i.test(attribute.name))node.removeAttribute(attribute.name);});});
      card.querySelectorAll('a').forEach(link=>link.setAttribute('data-barba-prevent','all'));
      content.replaceChildren(document.importNode(card,true));content.setAttribute('aria-busy','false');loaded=true;
      // This module owns the same two portraits and published version labels.
      // The standalone Start globe module is deliberately never imported here.
      await import('./start-home.js?v=app-cover-4');
      dialog.dataset.welcomeReady='true';
    } catch {
      content.setAttribute('aria-busy','false');
      content.innerHTML='<p class="welcome-overlay-loading">Welcome to SHOWAVE. Explore the software, follow a guide, or continue to the website.</p><nav class="welcome-overlay-fallback" aria-label="Welcome links"><a data-barba-prevent="all" href="/software">Software family ↗</a><a data-barba-prevent="all" href="/manuals">Manuals ↗</a><a data-barba-prevent="all" href="/start/">Open the welcome page ↗</a></nav>';
      dialog.dataset.welcomeReady='fallback';
    } finally {clearTimeout(timer);}
  })();return loadPromise;
}
export function closeWelcomeOverlay() {
  if(!dialog?.open)return;
  savePreference();markSeen();dialog.close();
}
export async function openWelcomeOverlay() {
  mount();
  await Promise.all([stylesheet('/showave-assets/start-home.css?v=app-cover-4'),stylesheet('/showave-assets/welcome-overlay.css?v=1')]);
  if(!dialog.open){previousFocus=document.activeElement;preference.checked=preferred();dialog.showModal();document.documentElement.setAttribute('data-welcome-overlay-open','');markSeen();dialog.querySelector('.welcome-overlay-continue').focus({preventScroll:true});window.dispatchEvent(new CustomEvent('showave:welcome-overlay',{detail:{open:true}}));}
  void loadCard();
}
export function installWelcomeOverlay() {
  if(installed)return;installed=true;
  // A homepage Start link reopens this same welcome. Other pages and direct
  // visits to /start/ retain the standalone welcome route.
  window.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]');if(!link||event.defaultPrevented||(event.button??0)!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.target==='_blank')return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin||!['/start','/start/'].includes(url.pathname)||link.closest('#showave-welcome-overlay'))return;
    event.preventDefault();event.stopImmediatePropagation();void openWelcomeOverlay();
  },true);
  window.ShowaveWelcomeOverlay=Object.freeze({open:openWelcomeOverlay,close:closeWelcomeOverlay,state:()=>({open:!!dialog?.open,loaded,storageAvailable})});
  if(preferred()&&!seen())void openWelcomeOverlay();
}
