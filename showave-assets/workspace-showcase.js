/* Rotate real screenshots only while the intro is visible. No player or app runs here. */
(() => {
  'use strict';
  function initialise() {
    document.querySelectorAll('[data-workspace-showcase]').forEach(stage => {
      if(stage.dataset.workspaceReady)return;
      stage.dataset.workspaceReady='true';
      const slides=[...stage.querySelectorAll('[data-workspace-slide]')];
      const pickers=[...stage.querySelectorAll('[data-workspace-pick]')];
      const toggle=stage.querySelector('[data-workspace-toggle]');
      const reduce=matchMedia('(prefers-reduced-motion: reduce)');
      let index=0,timer=0,visible=false,paused=reduce.matches,hovered=false,focused=false;
      function schedule() {
        clearTimeout(timer);timer=0;
        if(!stage.isConnected)return;
        if(!paused&&!reduce.matches&&visible&&!document.hidden&&!hovered&&!focused&&!document.body.classList.contains('showave-demo-open'))
          timer=setTimeout(()=>show(index+1),5500);
      }
      function updateToggle() {
        const playing=!paused&&!reduce.matches;
        toggle.disabled=reduce.matches;
        toggle.textContent=reduce.matches?'Still':playing?'Pause':'Play';
        toggle.setAttribute('aria-label',reduce.matches?'Autoplay disabled by reduced motion preference':playing?'Pause workspace slideshow':'Play workspace slideshow');
        toggle.setAttribute('aria-pressed',String(!playing));
      }
      function show(next,manual=false) {
        index=(next+slides.length)%slides.length;
        const current=slides[index];
        slides.forEach((slide,n)=>{slide.classList.toggle('is-active',n===index);slide.setAttribute('aria-hidden',String(n!==index));});
        pickers.forEach((button,n)=>button.setAttribute('aria-pressed',String(n===index)));
        stage.style.setProperty('--workspace-accent',current.dataset.accent);
        stage.querySelector('[data-workspace-name]').textContent=current.dataset.name;
        stage.querySelector('[data-workspace-description]').textContent=current.dataset.description;
        stage.querySelector('[data-workspace-icon]').src='/showave-assets/assets/app-icons/'+current.dataset.workspaceSlide+'.svg';
        stage.querySelector('[data-workspace-count]').textContent=String(index+1).padStart(2,'0')+' / '+String(slides.length).padStart(2,'0');
        stage.querySelector('[data-workspace-guide]').href='/manuals?article=product-family#'+current.dataset.workspaceSlide;
        const enlarge=stage.querySelector('[data-workspace-enlarge]');
        enlarge.href=current.querySelector('img').src;
        enlarge.setAttribute('aria-label','View full-size '+current.dataset.name+' screenshot');
        if(manual){paused=true;stage.querySelector('[data-workspace-status]').textContent=current.dataset.name+'. '+current.dataset.description;updateToggle();}
        schedule();
      }
      pickers.forEach((button,n)=>button.addEventListener('click',()=>show(n,true)));
      stage.querySelector('[data-workspace-previous]').addEventListener('click',()=>show(index-1,true));
      stage.querySelector('[data-workspace-next]').addEventListener('click',()=>show(index+1,true));
      toggle.addEventListener('click',()=>{paused=!paused;updateToggle();schedule();});
      stage.addEventListener('mouseenter',()=>{hovered=true;schedule();});
      stage.addEventListener('mouseleave',()=>{hovered=false;schedule();});
      stage.addEventListener('focusin',()=>{focused=true;schedule();});
      stage.addEventListener('focusout',()=>setTimeout(()=>{focused=stage.contains(document.activeElement);schedule();},0));
      document.addEventListener('visibilitychange',schedule);
      document.addEventListener('showave:demo-open',schedule);
      document.addEventListener('showave:demo-close',schedule);
      reduce.addEventListener('change',()=>{paused=reduce.matches;updateToggle();schedule();});
      if('IntersectionObserver'in window){
        const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;schedule();},{threshold:.15});
        observer.observe(stage);
      }else{visible=true;}
      updateToggle();show(0);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialise,{once:true});else initialise();
  document.addEventListener('barba:after',initialise);
  // The original site replaces its page container during navigation.
  new MutationObserver(records=>{
    if(records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches('[data-workspace-showcase]')||node.querySelector('[data-workspace-showcase]')))))initialise();
  }).observe(document.documentElement,{childList:true,subtree:true});
})();
