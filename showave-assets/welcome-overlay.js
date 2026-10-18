// Compact public counterpart of the installed Home. No private app runtime or extra globe.
const ART='/showave-assets/assets/start/';
const icons={
 live:'<path d="M3 5h7v9H3zM5 5V2h5v3M12 3v5M9.5 5.5h5"/>',
 broadcast:'<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5 14h6M8 11.5V14M6.5 5l4 2-4 2z"/>',
 timeline:'<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 6h13M5 2.5V6M11 2.5V6M4 9h3M9 11h3"/>',
 forge:'<rect x="1.5" y="2" width="4" height="4" rx=".5"/><rect x="10.5" y="10" width="4" height="4" rx=".5"/><path d="M3.5 6v6h7M5.5 4h7v6"/>',
 map:'<path d="M2 3l4-1 4 2 4-1v10l-4 1-4-2-4 1zM6 2v10M10 4v10"/>',
 encode:'<path d="M3 1.5h6.5L13 5v9.5H3zM9.5 1.5V5H13M5 9h6M8.5 6.5L11 9l-2.5 2.5"/>',
 grid:'<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/>',
 chaser:'<path d="M2 4h4v8H2zM6 6h4v6H6zM10 8h4v4h-4"/>',
 gsl5:'<path d="M5 2h6v5H5zM8 7v4M3 14l5-3 5 3M3 5H1M15 5h-2"/>',
 download:'<path d="M8 2v8M5 7l3 3 3-3M2 11v3h12v-3"/>',
 manual:'<path d="M2 3h5l1 1 1-1h5v10H9l-1 1-1-1H2zM8 4v10"/>',
 news:'<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c4 4 4 8 0 12M8 2c-4 4-4 8 0 12"/>'
};
const icon=name=>`<svg class="welcome-home-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${icons[name]}</svg>`;
const workspaces=[['live','Live Show'],['broadcast','Broadcast'],['timeline','Timeline'],['forge','Forge (Preview)'],['map','Map'],['encode','Encode'],['grid','Grid Tool'],['chaser','Chaser'],['gsl5','GSL5 Lighting']];
const guide=id=>id==='broadcast'?'/manuals?article=broadcast-guide':`/manuals?article=product-family#${id}`;
const rows=list=>list.map(([id,label])=>`<a data-barba-prevent="all" href="${guide(id)}">${icon(id)}<span>${label}</span></a>`).join('');
const websiteLinks=[['/software','Software'],['/manuals','Manuals'],['/community','Community'],['/explore','Explore'],['/fund','Development fund'],['/downloads','Download']];
function websiteMenuNodes(){
 const paths=new Set(websiteLinks.map(([href])=>href));
 return [...document.querySelectorAll('.header .header-menu-list,.header .header-dropdown a.header-dropdown-link')].filter(node=>node.matches('.header-menu-list')||paths.has(new URL(node.href,location.href).pathname.replace(/\/$/,'')));
}
let dialog,previousFocus,coverTimer,savedScroll,motionObserver,heroRevealTimer;
let coverReady=false,coverFrame=0,coverPaused=false,installed=false;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
function syncPortrait(){
 clearTimeout(coverTimer);coverTimer=null;if(!dialog)return;
 const still=reduced.matches||document.body.classList.contains('motion-paused');
 const running=dialog.open&&coverReady&&!coverPaused&&!document.hidden&&!still;
 const hero=dialog.querySelector('.welcome-home-hero'),toggle=dialog.querySelector('.welcome-home-pause');
 if(still){coverFrame=0;dialog.querySelector('.welcome-home-portrait-secondary').classList.remove('is-active');}
 hero.dataset.coverSlideshow=!coverReady?'loading':still?'reduced-motion':running?'running':'paused';
 toggle.disabled=still;toggle.textContent=still?'Still':coverPaused?'Play':'Pause';
 toggle.setAttribute('aria-label',still?'Portrait animation disabled by motion preference':coverPaused?'Play portrait animation':'Pause portrait animation');
 toggle.setAttribute('aria-pressed',String(coverPaused||still));
 if(running)coverTimer=setTimeout(()=>{coverFrame=coverFrame?0:1;dialog.querySelector('.welcome-home-portrait-secondary').classList.toggle('is-active',coverFrame===1);syncPortrait();},8000);
}
async function refreshRelease(){
 try{const response=await fetch('/showave-assets/release-config.json',{cache:'no-cache'});if(!response.ok)return;
 const release=await response.json(),version=release.platforms?.windows?.version||release.version;
 if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))return;
 const label=dialog.querySelector('[data-welcome-version]');label.textContent=version;label.dataset.publishedVersion=version;label.setAttribute('aria-label',`Published Windows preview ${version}`);
 }catch{/* Release labels stay independent from the artwork. */}
}
function mount(){
 if(dialog)return;
 dialog=document.createElement('dialog');dialog.id='showave-welcome-overlay';dialog.className='showave-welcome-overlay';
 dialog.setAttribute('aria-labelledby','welcome-home-title');dialog.setAttribute('data-lenis-prevent','');
 dialog.innerHTML=`<header class="welcome-home-hero">
 <div class="welcome-home-portraits" aria-hidden="true"><img class="welcome-home-portrait" src="${ART}showave-welcome-cover.jpg" alt="" width="1080" height="1080" fetchpriority="high"><img class="welcome-home-portrait welcome-home-portrait-secondary" src="${ART}showave-welcome-cover-2.jpg" alt="" width="1080" height="1034"></div>
 <div class="welcome-home-brand"><img src="/showave-assets/assets/showave-mark.svg" alt="" width="46" height="46"><span>SHOWAVE</span></div>
 <h2 id="welcome-home-title" class="welcome-home-sr">Welcome to SHOWAVE</h2><span class="welcome-home-version" data-welcome-version>Windows preview</span>
 <button class="welcome-overlay-close" type="button" aria-label="Close welcome" title="Continue to the website"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
 <div class="welcome-home-credit"><span>Founded by</span><strong>Godrick Sakonfa</strong><span>Afro Unity Group</span></div>
 <button type="button" class="welcome-home-pause" aria-label="Pause portrait animation" aria-pressed="false">Pause</button></header>
 <div class="welcome-home-scroll"><div class="welcome-home-body">
 <section class="welcome-home-workspaces" aria-labelledby="welcome-home-workspaces-title"><h3 id="welcome-home-workspaces-title">Workspaces</h3><nav aria-label="Workspace guides">${rows(workspaces.slice(0,6))}</nav>
 <div id="welcome-home-more-workspaces" hidden><nav aria-label="More workspace guides">${rows(workspaces.slice(6))}</nav></div>
 <button class="welcome-home-more" type="button" aria-expanded="false" aria-controls="welcome-home-more-workspaces"><span>Show More</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6l3 3 3-3"/></svg></button></section>
 <section class="welcome-home-guides" aria-labelledby="welcome-home-guides-title"><div class="welcome-home-pitch"><p class="welcome-home-pitch-kicker">ONE FAMILY. ONE SHOW.</p><h3 id="welcome-home-guides-title" class="welcome-home-pitch-title">Every<br>part of<br>the show</h3><p class="welcome-home-pitch-intro">Live visuals, presentations and broadcast.<br>One creative workflow, powered by Afro Unity Group.</p></div><nav aria-label="Start creating"><a data-barba-prevent="all" class="welcome-home-start-show" href="/manuals?article=getting-started">Start your show <span aria-hidden="true">↗</span></a><a data-barba-prevent="all" href="/workflows">Production workflows <span aria-hidden="true">↗</span></a><a data-barba-prevent="all" href="/academy">Learn with SHOWAVE <span aria-hidden="true">↗</span></a></nav></section></div>
 <footer class="welcome-home-footer"><div><span class="welcome-home-site-caption">Website</span><nav class="welcome-home-site-links" aria-label="SHOWAVE website">${websiteLinks.map(([href,label])=>`<a data-barba-prevent="all" href="${href}">${label}</a>`).join('')}</nav></div><div class="welcome-home-project-links"><a data-barba-prevent="all" href="/downloads/#beta">${icon('news')}<span>What's New</span></a><a class="welcome-home-donate" data-barba-prevent="all" href="/fund" aria-label="Donate — support SHOWAVE development"><img src="${ART}showave-donate-animated.svg" alt="" width="112" height="23"></a></div></footer></div>
 <div class="welcome-home-bottom"><button type="button" class="welcome-overlay-continue"><span>Continue to website</span><span aria-hidden="true">→</span></button></div>`;
 document.body.append(dialog);
 dialog.querySelectorAll('.welcome-overlay-close,.welcome-overlay-continue').forEach(button=>button.addEventListener('click',closeWelcomeOverlay));
 dialog.querySelector('.welcome-home-pause').addEventListener('click',()=>{coverPaused=!coverPaused;syncPortrait();});
 dialog.querySelector('.welcome-home-more').addEventListener('click',event=>{const button=event.currentTarget,expanded=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(expanded));button.querySelector('span').textContent=expanded?'Show Less':'Show More';dialog.querySelector('#welcome-home-more-workspaces').hidden=!expanded;});
 // Dismiss only a complete outside gesture, never a drag out of a card control.
 let outsideStart=false;
 const outside=event=>{const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;};
 dialog.addEventListener('pointerdown',event=>{outsideStart=event.target===dialog&&outside(event);});
 dialog.addEventListener('click',event=>{if(outsideStart&&event.target===dialog&&outside(event))closeWelcomeOverlay();outsideStart=false;});
 dialog.addEventListener('cancel',event=>{event.preventDefault();closeWelcomeOverlay();});
 dialog.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const controls=[...dialog.querySelectorAll('a[href],button:not([disabled])')].filter(node=>node.getClientRects().length),first=controls[0],last=controls.at(-1);if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}});
 dialog.addEventListener('close',()=>{
  if(dialog.open)return;
  syncPortrait();document.documentElement.removeAttribute('data-welcome-overlay-open');
  document.documentElement.style.overflow=savedScroll.html;document.body.style.overflow=savedScroll.body;
  // The original hero stayed in its native layout while its globe loaded.
  // Reveal that same DOM once the compact welcome hands the visitor over.
  const revealNodes=[document.querySelector('.home-hero-text-wrap'),...websiteMenuNodes()].filter(Boolean);
  revealNodes.forEach(node=>node.classList.add('welcome-home-handoff'));clearTimeout(heroRevealTimer);
  heroRevealTimer=setTimeout(()=>revealNodes.forEach(node=>node.classList.remove('welcome-home-handoff')),700);
  const target=previousFocus&&previousFocus!==document.body&&previousFocus.isConnected?previousFocus:document.querySelector('.header-logo')||document.querySelector('a[href]');
  target?.focus({preventScroll:true});window.dispatchEvent(new CustomEvent('showave:welcome-overlay',{detail:{open:false}}));
 });
 reduced.addEventListener('change',syncPortrait);document.addEventListener('visibilitychange',syncPortrait);
 window.addEventListener('pagehide',()=>{clearTimeout(coverTimer);coverTimer=null;});
 window.addEventListener('pageshow',()=>{syncPortrait();if(dialog.open)void refreshRelease();});
 motionObserver=new MutationObserver(syncPortrait);motionObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
 Promise.all([...dialog.querySelectorAll('.welcome-home-portrait')].map(image=>image.decode())).then(()=>{coverReady=true;syncPortrait();}).catch(()=>{dialog.querySelector('.welcome-home-pause').hidden=true;});
 dialog.dataset.welcomeReady='true';void refreshRelease();
}
export function closeWelcomeOverlay(){if(!dialog?.open)return;dialog.close();syncPortrait();}
export function openWelcomeOverlay(){
 mount();if(dialog.open)return;
 // Failed or unsupported dialogs must leave the homepage visible and usable.
 if(typeof dialog.showModal!=='function')return;
 previousFocus=document.activeElement;savedScroll={html:document.documentElement.style.overflow,body:document.body.style.overflow};
 try{dialog.showModal();}catch{return;}
 clearTimeout(heroRevealTimer);document.querySelectorAll('.welcome-home-handoff').forEach(node=>node.classList.remove('welcome-home-handoff'));
 websiteMenuNodes().forEach(node=>node.classList.add('welcome-home-website-menu'));
 document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';document.documentElement.setAttribute('data-welcome-overlay-open','');
 dialog.querySelector('.welcome-overlay-close').focus({preventScroll:true});syncPortrait();window.dispatchEvent(new CustomEvent('showave:welcome-overlay',{detail:{open:true}}));
}
export function installWelcomeOverlay(){
 if(installed)return;installed=true;
 window.ShowaveWelcomeOverlay=Object.freeze({open:openWelcomeOverlay,close:closeWelcomeOverlay,state:()=>({open:!!dialog?.open,loaded:!!dialog})});
 // Each fresh visit welcomes the visitor. Dismissal never reloads or navigates;
 // ordinary Start links retain their standalone route.
 openWelcomeOverlay();
}
