(function(root){
  'use strict';
  function mount({controller,document:doc=root.document}={}){
    const button=doc.getElementById('programmeCameraButton'),menu=doc.getElementById('programmeCameraMenu');if(!button||!menu||!controller)return null;
    const drawer=doc.getElementById('outputControlDrawer'),indicator=doc.getElementById('programmeCameraIndicator');
    menu.className=drawer?'bc-camera-panel':'bc-projector-menu bc-camera-menu';menu.setAttribute('role',drawer?'region':'dialog');menu.setAttribute('aria-label','Programme virtual camera');menu.hidden=!drawer;
    menu.innerHTML='<div class="bc-projector-title">Programme virtual camera</div><div class="bc-camera-state" role="status" aria-live="polite"></div><div class="bc-camera-device"></div><div class="bc-camera-format">Programme · 720p · 30 fps</div><button type="button" class="bc-camera-action">Start virtual camera</button><p class="bc-projector-hint"></p>';
    const state=menu.querySelector('.bc-camera-state'),device=menu.querySelector('.bc-camera-device'),action=menu.querySelector('.bc-camera-action'),hint=menu.querySelector('.bc-projector-hint');
    const remove=[];let disposed=false;
    function on(node,type,fn){node.addEventListener(type,fn);remove.push(()=>node.removeEventListener(type,fn));}
    function position(){if(drawer||menu.hidden)return;const r=button.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(r.right-menu.offsetWidth,root.innerWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,Math.min(r.bottom+4,root.innerHeight-menu.offsetHeight-6))+'px';}
    function refresh(){
      if(disposed)return;const value=controller.snapshot(),active=value.state==='live',starting=value.state==='connecting',stopping=value.state==='stopping';
      button.classList.toggle('has-projector',active);button.classList.toggle('camera-connecting',starting);button.title=active?'Virtual camera · '+value.device:starting?'Virtual camera · connecting':'Virtual camera';
      if(drawer){
        drawer.dataset.state=value.state;
        button.setAttribute('aria-label','Output'+(active?' · Camera on':starting?' · Camera connecting':stopping?' · Camera stopping':value.state==='error'?' · Camera error':''));
        if(indicator){indicator.hidden=!active&&!starting&&!stopping&&value.state!=='error';indicator.textContent=active?'On':value.state==='error'?'!':'…';}
      }
      state.dataset.state=value.state;
      state.textContent=active?'Camera on':starting?'Connecting Programme…':stopping?'Stopping camera…':value.reason|| (value.available===null?'Checking camera support…':value.available?'Ready to connect':'Virtual camera unavailable');
      device.textContent=value.device||'';device.hidden=!value.device;
      action.textContent=active?'Stop virtual camera':starting?'Cancel':stopping?'Stopping…':'Start virtual camera';
      action.disabled=stopping||(!active&&!starting&&value.available!==true);
      hint.textContent=value.device?'Select '+value.device+' as the camera in Zoom, Teams or Resolume. Audio uses your app’s microphone selection.':'A native virtual-camera driver is required before other apps can receive Programme.';
      position();
    }
    function hide(focus=false){if(drawer)drawer.open=false;else{menu.hidden=true;button.setAttribute('aria-expanded','false');}if(focus)button.focus();}
    function check(){if(!['connecting','live','stopping'].includes(controller.snapshot().state))void controller.check();}
    if(drawer)on(drawer,'toggle',()=>{if(drawer.open){refresh();check();}});
    else on(button,'click',()=>{if(!menu.hidden){hide(true);return;}menu.hidden=false;button.setAttribute('aria-expanded','true');refresh();if(!action.disabled)action.focus();check();});
    on(action,'click',()=>{const v=controller.snapshot();void (['live','connecting'].includes(v.state)?controller.stop():controller.start());});
    on(menu,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();hide(true);}});
    if(!drawer){
      on(doc,'pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!button.contains(event.target))hide();});
      on(doc,'focusin',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!button.contains(event.target))hide();});
      on(root,'resize',position);
    }
    refresh();
    return {refresh,dispose(){if(disposed)return;hide();disposed=true;remove.forEach(fn=>fn());}};
  }
  root.OpenLiveVirtualCameraUI=Object.freeze({mount});
})(window);
