/* Small, local demonstrations opened from the site's real workspace pictures. */
(() => {
  'use strict';
  const boot = Symbol.for('showave.app.demos');
  if (window[boot]) return;
  window[boot] = true;
  const base = new URL('.', document.currentScript?.src || location.origin + '/showave-assets/app-demos.js');
  const ids = ['live','broadcast','map','grid','gsl5','timeline','forge','chaser','encode'];
  const names = {live:'SHOWAVE Live',broadcast:'SHOWAVE Broadcast',map:'SHOWAVE Map',grid:'SHOWAVE Grid Tool',gsl5:'GSL5 Lighting Library',timeline:'SHOWAVE Timeline',forge:'SHOWAVE Forge',chaser:'SHOWAVE Chaser',encode:'SHOWAVE Encode'};
  const descriptions = {live:'Build your picture with layers, clips and cues.',broadcast:'Arrange a scene and bring it to Programme.',map:'Shape your picture for the space.',grid:'Plan your LED wall, one pixel at a time.',gsl5:'Explore fixtures and shape the light.',timeline:'Put the moments of your show in order.',forge:'Connect nodes and follow the signal.',chaser:'Give your slices a rhythm.',encode:'Prepare your media for the show.'};
  const guides = {live:'media-present#load',broadcast:'broadcast-guide#start-with-an-empty-canvas',map:'mapping-output#map',grid:'mapping-output#grid',gsl5:'creative-control#lighting',timeline:'creative-control#timeline',forge:'creative-control#forge',chaser:'mapping-output#chaser',encode:'creative-control#encode'};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mobileButtons = new Map();
  let dialog, modulePromise, renderer, module, opener, scrollState, current = 'live', tour = false, screenshot = false, ticket = 0;
  let mobileFrame = 0;
  function stylesheet(name) {
    const href = new URL(name + '?v=welcome-shell-2', base).href;
    if ([...document.querySelectorAll('link[rel=stylesheet]')].some(link => link.href === href)) return;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link);
  }
  stylesheet('app-demo-shell.css');
  function toolOf(image) {
    const match = image?.getAttribute('src')?.match(/workspace-screens\/([a-z0-9]+)(?:-light)?\.png(?:[?#]|$)/);
    return match && ids.includes(match[1]) ? match[1] : null;
  }
  function button(id, extra = '') {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'showave-demo-launch ' + extra;
    el.dataset.demoLaunch = id; el.setAttribute('aria-haspopup','dialog');
    el.setAttribute('aria-label', 'Try ' + names[id] + ' interactive preview');
    el.innerHTML = '<span aria-hidden="true">▷</span><span>Try interactive preview</span>';
    return el;
  }
  function scheduleMobile() {
    if (mobileFrame) return;
    mobileFrame = requestAnimationFrame(() => {
      mobileFrame = 0;
      for (const [image, launch] of mobileButtons) {
        if (!image.isConnected) { sizes?.unobserve(image); launch.remove(); mobileButtons.delete(image); continue; }
        launch.hidden = !image.getClientRects().length || image.getBoundingClientRect().width === 0;
      }
    });
  }
  const sizes = 'ResizeObserver' in window ? new ResizeObserver(scheduleMobile) : null;
  function bindImages() {
    document.querySelectorAll('img.showave-app-preview').forEach(image => {
      if (image.dataset.demoImage) return;
      const id = toolOf(image); if (!id) return;
      image.dataset.demoImage = id;
      image.title = 'Try ' + names[id] + ' interactive preview';
      const anchor = image.closest('a');
      if (anchor) {
        // The picture's pointer action and an adjacent keyboard button open the
        // preview; the original article/title link retains its destination.
        const launch = button(id, 'showave-demo-mobile'); launch.hidden = true;
        anchor.after(launch); mobileButtons.set(image, launch); sizes?.observe(image);
      } else {
        const parent = image.parentElement;
        parent.classList.add('showave-demo-picture'); parent.append(button(id, 'showave-demo-image-button'));
      }
    });
    document.querySelectorAll('[data-workspace-showcase]').forEach(stage => {
      if (stage.dataset.demoBound) return; stage.dataset.demoBound = 'true';
      const frame = stage.querySelector('.workspace-stage'); if (!frame) return;
      const launch = button('live', 'showave-demo-image-button'); frame.append(launch);
      const refresh = () => {
        const id = stage.querySelector('.workspace-shot.is-active')?.dataset.workspaceSlide || 'live';
        launch.dataset.demoLaunch = id; launch.setAttribute('aria-label','Try ' + names[id] + ' interactive preview');
        const enlarge = stage.querySelector('[data-workspace-enlarge]');
        if (enlarge) { enlarge.dataset.demoLaunch = id; enlarge.textContent = 'Try preview ↗'; enlarge.setAttribute('aria-label','Try ' + names[id] + ' interactive preview'); enlarge.setAttribute('aria-haspopup','dialog'); }
      };
      refresh(); new MutationObserver(refresh).observe(frame,{subtree:true,attributes:true,attributeFilter:['class']});
    });
    scheduleMobile();
  }
  function createDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'showave-app-demo'; dialog.className = 'showave-app-demo';
    dialog.setAttribute('aria-labelledby','app-demo-title'); dialog.setAttribute('aria-describedby','app-demo-description');
    dialog.innerHTML = `<header class="app-demo-heading"><div class="app-demo-brand"><span class="app-demo-brand-mark" role="img" aria-label="SHOWAVE"></span><span class="app-demo-brand-caption">Every part of the show.</span></div><button type="button" class="app-demo-close" data-demo-close aria-label="Close app preview"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
      <div class="app-demo-layout"><aside class="app-demo-sidebar"><p class="app-demo-nav-label">Workspaces</p><nav class="app-demo-tools" aria-label="Choose an app preview">${ids.map(id=>`<button type="button" data-demo-tool="${id}" aria-pressed="false"><img src="${new URL('assets/app-icons/'+id+'.svg',base)}" alt="" width="23" height="23"><span>${names[id].replace('SHOWAVE ','').replace(' Lighting Library',' Lighting')}</span><span class="app-demo-tool-arrow" aria-hidden="true">↗</span></button>`).join('')}</nav><p class="app-demo-family-note">One family.<br>One show.</p></aside><div class="app-demo-content">
      <div class="app-demo-intro"><div class="app-demo-current"><img data-demo-icon alt="" width="30" height="30"><h2 id="app-demo-title">Explore SHOWAVE</h2></div><p id="app-demo-description">Choose a workspace. Make it your own.</p></div>
      <div class="app-demo-toolbar"><div class="app-demo-views" role="group" aria-label="Preview view"><button type="button" data-demo-interact aria-pressed="true">Preview</button><button type="button" data-demo-screenshot aria-pressed="false"><span class="app-demo-label-wide">Screenshot</span><span class="app-demo-label-short">Image</span></button></div><div class="app-demo-playback"><button type="button" data-demo-tour aria-pressed="false">▷ Watch walkthrough</button><button type="button" data-demo-reset aria-label="Reset sample session" title="Reset sample session"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.1 6.4A6.5 6.5 0 1 1 3.5 11M3.5 3.5v4h4"/></svg><span>Start again</span></button></div></div>
      <section class="app-demo-workbench" data-demo-host aria-label="Interactive app demonstration"></section>
      <figure class="app-demo-original" data-demo-original hidden><img data-demo-screen alt=""><figcaption>SHOWAVE · Interface screenshot</figcaption></figure>
      <div class="app-demo-guidance"><p data-demo-status role="status" aria-live="polite">Choose a control to begin.</p><span data-demo-motion-note hidden>Walkthrough motion is paused for your appearance preference.</span></div>
      <footer class="app-demo-footer"><p>Sample session · Live outputs and account connections are unavailable.</p><a data-demo-guide data-barba-prevent="all">Read the guide <span aria-hidden="true">↗</span></a></footer></div></div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-demo-close]').addEventListener('click',close);
    let downOutside = false;
    dialog.addEventListener('pointerdown', event => { downOutside = event.target === dialog && outside(event); });
    dialog.addEventListener('click', event => { if (downOutside && event.target === dialog && outside(event)) close(); downOutside = false; });
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',cleanUp);
    dialog.addEventListener('keydown',event=>{
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('button,a[href],input,select,iframe,[tabindex="0"]')].filter(el=>!el.disabled && el.getClientRects().length && !el.closest('[hidden]'));
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {event.preventDefault();items.at(-1).focus();}
      else if (!event.shiftKey && document.activeElement === items.at(-1)) {event.preventDefault();items[0].focus();}
    });
    dialog.querySelectorAll('[data-demo-tool]').forEach(el=>el.addEventListener('click',()=>selectTool(el.dataset.demoTool)));
    dialog.querySelector('[data-demo-tour]').addEventListener('click',()=>setTour(!tour));
    dialog.querySelector('[data-demo-reset]').addEventListener('click',()=>{setTour(false);renderer?.reset();});
    dialog.querySelector('[data-demo-screenshot]').addEventListener('click',()=>setView(true));
    dialog.querySelector('[data-demo-interact]').addEventListener('click',()=>setView(false));
    dialog.querySelector('[data-demo-host]').addEventListener('pointerdown',()=>{if(tour)setTour(false);},true);
    dialog.querySelector('[data-demo-host]').addEventListener('keydown',()=>{if(tour)setTour(false);},true);
    document.addEventListener('visibilitychange',()=>{if(document.hidden){setTour(false);renderer?.suspend?.();}else if(dialog.open&&!screenshot){renderer?.resume?.();}});
    document.addEventListener('showave:motion',motionChanged);
    reduce.addEventListener('change',motionChanged);
    motionChanged();
  }
  function outside(event) {const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;}
  function motionAllowed() {return !reduce.matches&&!document.body.classList.contains('motion-paused');}
  function motionChanged() {
    if (!dialog) return;
    const allowed = motionAllowed();
    dialog.querySelector('[data-demo-tour]').disabled = !allowed || screenshot || !renderer;
    dialog.querySelector('[data-demo-motion-note]').hidden = allowed;
    if (!allowed) setTour(false);
  }
  function setTour(playing) {
    tour = Boolean(playing && !screenshot && motionAllowed() && dialog?.open);
    renderer?.setTourPlaying(tour);
    if (!dialog) return;
    dialog.dataset.tourPlaying = String(tour);
    const control=dialog.querySelector('[data-demo-tour]'); control.setAttribute('aria-pressed',String(tour));
    control.textContent=tour?'Ⅱ Pause walkthrough':'▷ Watch walkthrough';
    // Auto-play narration is visible but does not repeatedly interrupt a screen reader.
    dialog.querySelector('[data-demo-status]').setAttribute('aria-live',tour?'off':'polite');
  }
  function setView(original) {
    setTour(false); screenshot=original;
    dialog.querySelector('[data-demo-host]').hidden=original;
    dialog.querySelector('[data-demo-original]').hidden=!original;
    if(original)renderer?.suspend?.();else renderer?.resume?.();
    dialog.querySelector('[data-demo-screenshot]').setAttribute('aria-pressed',String(original));
    dialog.querySelector('[data-demo-interact]').setAttribute('aria-pressed',String(!original));
    dialog.querySelector('[data-demo-tour]').disabled=original||!motionAllowed()||!renderer;
    dialog.querySelector('[data-demo-reset]').disabled=original||!renderer;
  }
  function metadata(id, tool) {
    current=id;dialog.dataset.demoTool=id;
    dialog.querySelector('#app-demo-title').textContent=tool?.name||names[id];
    dialog.querySelector('#app-demo-description').textContent=descriptions[id]||'Choose a workspace. Make it your own.';
    dialog.querySelector('[data-demo-icon]').src=new URL('assets/app-icons/'+id+'.svg',base).href;
    const screen=dialog.querySelector('[data-demo-screen]');screen.src=new URL('assets/workspace-screens/'+id+'.png',base).href;screen.alt='Actual '+names[id]+' interface';
    dialog.querySelector('[data-demo-original] figcaption').textContent=names[id]+' · Interface screenshot';
    dialog.querySelector('[data-demo-guide]').href=tool?.guide||'/manuals?article='+guides[id];
    dialog.querySelectorAll('[data-demo-tool]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.demoTool===id)));
  }
  function selectTool(id) {
    if (!module || !ids.includes(id)) return;
    setTour(false); renderer?.destroy(); current=id;
    const tool=module.demoTools.find(t=>t.id===id); if(!tool)return;
    metadata(id,tool);dialog.style.setProperty('--demo-accent',tool.accent);
    const host=dialog.querySelector('[data-demo-host]');host.replaceChildren();
    renderer=module.mountWorkspace(host,id,{onStep:text=>{dialog.querySelector('[data-demo-status]').textContent=text;},onClose:close,onWorkspace:selectTool});
    dialog.querySelector('[data-demo-status]').textContent=tool.steps[0];
    setView(false);
  }
  async function open(id, trigger) {
    createDialog();
    if (dialog.open) {if(module)selectTool(id);return;}
    opener=trigger;const request=++ticket;
    scrollState={body:document.body.style.overflow,html:document.documentElement.style.overflow};
    document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';
    document.body.classList.add('showave-demo-open');
    dialog.showModal();dialog.scrollTop=0;dialog.querySelector('[data-demo-close]').focus({preventScroll:true});
    metadata(id);setView(false);
    dialog.dataset.loading='true';dialog.querySelector('[data-demo-host]').textContent='Opening preview…';
    document.dispatchEvent(new CustomEvent('showave:demo-open'));
    stylesheet('app-demo-workspaces.css');
    try {
      modulePromise ||= import(new URL('app-demo-workspaces.js?v=welcome-shell-2',base).href);
      module=await modulePromise;
      if(request!==ticket||!dialog.open)return;
      dialog.querySelector('[data-demo-tour]').hidden=module.supportsWalkthrough===false;
      selectTool(id);
    } catch {
      modulePromise=null;
      if(request===ticket&&dialog.open){dialog.querySelector('[data-demo-host]').textContent='The interactive preview could not open. You can still view the real interface or read the guide.';dialog.querySelector('[data-demo-status]').textContent='Close this window and try again.';dialog.querySelector('[data-demo-tour]').disabled=true;dialog.querySelector('[data-demo-reset]').disabled=true;}
    } finally {if(request===ticket)delete dialog.dataset.loading;}
  }
  function cleanUp() {
    ++ticket;setTour(false);renderer?.destroy();renderer=null;
    dialog.querySelector('[data-demo-host]').replaceChildren();
    document.body.classList.remove('showave-demo-open');
    if(scrollState){document.body.style.overflow=scrollState.body;document.documentElement.style.overflow=scrollState.html;scrollState=null;}
    if(opener?.isConnected)opener.focus({preventScroll:true});opener=null;
    document.dispatchEvent(new CustomEvent('showave:demo-close'));
  }
  function close(){if(dialog?.open)dialog.close();}
  document.addEventListener('click',event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const trigger=event.target.closest('[data-demo-launch]');
    const image=event.target.closest('img[data-demo-image]');
    if(!trigger&&!image)return;
    const id=trigger?.dataset.demoLaunch||image.dataset.demoImage;
    if(!ids.includes(id))return;
    event.preventDefault();event.stopImmediatePropagation();
    // A linked journal picture restores focus to its adjacent preview button.
    open(id,trigger||mobileButtons.get(image)||image.closest('a'));
  },true);
  window.addEventListener('pagehide',()=>{close();});
  window.addEventListener('resize',scheduleMobile,{passive:true});
  function start(){bindImages();new MutationObserver(records=>{
    if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&!n.closest('#showave-app-demo')&&(n.matches?.('img.showave-app-preview,[data-workspace-showcase]')||n.querySelector?.('img.showave-app-preview,[data-workspace-showcase]')))))bindImages();
  }).observe(document.body,{childList:true,subtree:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
