/* Programme output controls. The menu never starts a stream or changes the mix. */
(function(root){
  'use strict';
  function mount({controller,displays=root.OpenLiveDisplays,document:doc=root.document}={}){
    const button=doc.getElementById('programmeOutputButton'),menu=doc.getElementById('programmeOutputMenu'),monitor=doc.getElementById('programmeMonitor');
    if(!button||!menu||!monitor)return null;
    let disposed=false,anchor=null,origin=button,pending=false,inventoryKey='',unwatch=()=>{};
    const removers=[];
    function listen(node,type,handler){node.addEventListener(type,handler);removers.push(()=>node.removeEventListener(type,handler));}
    function element(tag,classes,text){const node=doc.createElement(tag);if(classes)node.className=classes;if(text)node.textContent=text;return node;}
    menu.replaceChildren();menu.classList.add('bc-projector-menu');menu.hidden=true;
    menu.setAttribute('role','menu');menu.setAttribute('aria-label','Programme projector');
    const title=element('div','bc-projector-title','Programme projector');title.setAttribute('role','presentation');menu.append(title);
    function item(label,action){const node=element('button','bc-projector-item',label);node.type='button';node.setAttribute('role','menuitem');node.tabIndex=-1;listen(node,'click',action);return node;}
    function position(){
      if(menu.hidden)return;
      const rect=button.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
      const x=anchor?anchor.x:rect.right-width,y=anchor?anchor.y:rect.bottom+4;
      menu.style.left=Math.max(6,Math.min(x,root.innerWidth-width-6))+'px';
      menu.style.top=Math.max(6,Math.min(y,root.innerHeight-height-6))+'px';
    }
    function hide(restore=false){menu.hidden=true;button.setAttribute('aria-expanded','false');if(restore)origin?.focus();}
    function message(text){status.textContent=text||'';status.hidden=!text;position();}
    function openResult(result){refresh();if(result?.ok){message('');hide(true);}else message(result?.error||'The Programme projector could not be opened.');}
    const windowItem=item('Open windowed projector',()=>openResult(controller?.openWindow()));menu.append(windowItem);
    const screens=element('div','bc-projector-displays');screens.setAttribute('role','group');screens.setAttribute('aria-label','Connected displays');menu.append(screens);
    const detect=item('Detect displays…',async()=>{
      if(pending)return;pending=true;refresh();message('Checking connected displays…');
      try{await displays.request();if(!disposed){refresh();message(displays.enumerated?.()?'Choose a display above.':displayHint());}}
      catch(error){if(!disposed)message(error.message||'Display detection is unavailable. Open a windowed projector and move it to your display.');}
      finally{pending=false;if(!disposed)refresh();}
    });menu.append(detect);
    const closeItem=item('Close projector',()=>{controller?.close();refresh();hide(true);});menu.append(closeItem);
    const status=element('div','bc-projector-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;menu.append(status);
    const hint=element('p','bc-projector-hint');menu.append(hint);
    function displayHint(){
      if(!displays?.supported?.())return 'Display selection is unavailable in this browser. Move the projector window to your display.';
      if(displays.permission?.()==='denied')return 'Display access is blocked. Allow Window management in site settings, or move the window manually.';
      return 'Detect displays to choose an output screen, or move the window manually.';
    }
    function refresh(){
      if(disposed)return;
      const open=!!controller?.isOpen();button.classList.toggle('has-projector',open);
      button.title=open?'Programme projector · window open':'Programme projector';
      windowItem.disabled=!controller;
      closeItem.disabled=!open;detect.disabled=!controller||!displays?.supported?.();detect.setAttribute('aria-disabled',String(detect.disabled||pending));detect.textContent=pending?'Checking displays…':'Detect displays…';
      const enumerated=!!displays?.enumerated?.();
      const list=enumerated?(displays.list?.()||[]):[];
      const key=JSON.stringify(list.map(d=>[d.id,d.label,d.blocked]));
      if(key!==inventoryKey){
        inventoryKey=key;screens.replaceChildren();
        for(const display of list){
          const row=element('button','bc-projector-item bc-projector-display',display.label);row.type='button';row.tabIndex=-1;row.setAttribute('role','menuitem');row.disabled=!!display.blocked;
          row.title=display.blocked?display.reason:'Open Programme on this display; press F in the output window for fullscreen.';
          row.addEventListener('click',()=>openResult(controller?.openDisplay(display.id)));screens.append(row);
        }
      }
      screens.hidden=!list.length;
      hint.textContent=(enumerated?'Open on a display or in a movable window.':displayHint())+' Press F in the output window for fullscreen. Video only.';
      if(!controller)message('Programme output is unavailable. Reload Broadcast to load the projector controls.');
      position();
    }
    function items(){return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(n=>!n.disabled&&!n.hidden);}
    function show(point,source){
      anchor=point||null;origin=source||button;message('');menu.hidden=false;button.setAttribute('aria-expanded','true');refresh();items()[0]?.focus();
      Promise.resolve(displays?.prime?.()).then(()=>{if(!disposed&&!menu.hidden)refresh();}).catch(()=>{});
    }
    listen(button,'click',()=>menu.hidden?show(null,button):hide(true));
    listen(monitor,'contextmenu',event=>{
      if(!event.target.closest('.bc-monitorhead,#progStage')||event.target.closest('.bc-monitor-audio'))return;
      event.preventDefault();show(event.clientX||event.clientY?{x:event.clientX,y:event.clientY}:null,doc.getElementById('progStage')||button);
    });
    listen(menu,'keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();hide(true);return;}
      if(event.key==='Tab'){hide();return;}
      const list=items(),at=list.indexOf(doc.activeElement);let next;
      if(event.key==='ArrowDown')next=(at+1)%list.length;
      if(event.key==='ArrowUp')next=(at-1+list.length)%list.length;
      if(event.key==='Home')next=0;
      if(event.key==='End')next=list.length-1;
      if(next!==undefined){event.preventDefault();list[next]?.focus();}
    });
    listen(doc,'pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!button.contains(event.target))hide();});
    listen(root,'resize',position);
    unwatch=displays?.onChange?.(()=>refresh())||unwatch;
    refresh();
    return {refresh,message,dispose(){if(disposed)return;hide();disposed=true;unwatch();removers.forEach(remove=>remove());}};
  }
  root.OpenLiveProgrammeProjectorUI=Object.freeze({mount});
})(typeof window==='object'?window:globalThis);
