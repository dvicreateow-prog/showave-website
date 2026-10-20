/* Shared rectangular editors. Original controls and renderers remain in their
 * owning document; secondary views forward to those controls rather than
 * starting another show engine. Layout changes are confined to this session. */
(function installAreas(global) {
  'use strict';
  if (global.OpenLiveAreas) return;
  const doc=global.document, managers=new Map();
  let sequence=0, active=null, menu=null, drag=null, focusedManager=null;
  const uid=()=> 'area-'+(++sequence);
  const element=(tag,cls,text,d=doc)=>{const e=d.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
  const areaIconPaths={add:'M8 3v10M3 8h10',undock:'M6 3H3v10h10v-3M9 3h4v4M13 3 7 9',dock:'M6 3H3v10h10v-3M13 3 7 9M7 5v4h4',hide:'m4 4 8 8m0-8-8 8',options:'M3 8h.01M8 8h.01M13 8h.01',reset:'M3 5.5A5.5 5.5 0 1 1 2.5 9M2.5 2.5v3.5H6'};
  function areaIcon(name,d=doc){
    if(global.OpenLiveControlIcons?.has(name)){const icon=global.OpenLiveControlIcons.create(name,d);icon.classList.add("ol-area-icon");return icon;}
    const svg=d.createElementNS('http://www.w3.org/2000/svg','svg'),path=d.createElementNS('http://www.w3.org/2000/svg','path');
    svg.setAttribute('class','ol-area-icon');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width','12');svg.setAttribute('height','12');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
    path.setAttribute('d',areaIconPaths[name]||areaIconPaths.options);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width',name==='options'?'2.5':'1.5');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');svg.append(path);return svg;
  }
  const controlIcon=(name,d=doc)=>areaIcon(({plus:'add',close:'hide'}[name]||name),d);
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const copy=value=>JSON.parse(JSON.stringify(value));
  const leaf=id=>({id});
  const branch=(axis,children,ratio=.5)=>({axis,children,ratio});
  function closeMenu(restoreFocus=true){const closing=menu;menu=null;closing?._dispose?.();closing?.remove();if(restoreFocus&&closing?._returnFocus?.isConnected)closing._returnFocus.focus?.({preventScroll:true});}
  function notice(text){const e=element('div','ol-area-status',text);doc.body.append(e);setTimeout(()=>e.remove(),3000);}
  function watchMenu(surface){const owner=surface.ownerDocument;const outside=event=>{if(surface.role==='dialog'&&surface._returnFocus?.contains(event.target))return;if(menu===surface&&!surface.contains(event.target))closeMenu(false);};const key=event=>{if(menu!==surface)return;if(event.key==='Escape'){event.preventDefault();closeMenu();}else if(surface.role==='menu'&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=[...surface.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(owner.activeElement);buttons[(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};owner.addEventListener('pointerdown',outside,true);if(owner!==doc)owner.addEventListener('keydown',key,true);surface._dispose=()=>{owner.removeEventListener('pointerdown',outside,true);owner.removeEventListener('keydown',key,true);};}
  function showMenu(manager,id,x,y,d=doc,anchor=null,adjacent=null){
    closeMenu();const record=manager.records.get(id);if(!record)return;
    menu=element('div','ol-area-menu',null,d);menu.setAttribute('role','menu');menu._returnFocus=anchor;
    const add=(label,fn,disabled=false)=>{const b=element('button','',label,d);b.type='button';b.role='menuitem';b.disabled=disabled;b.addEventListener('click',()=>{closeMenu();fn();});menu.append(b);};
    const placed=manager.panels().find(panel=>panel.id===id)?.state==='docked';
    if(!placed&&!record.popup)add('Show panel',()=>manager.reopen(id));
    add('Split vertically',()=>manager.beginSplit(id,'row'),!placed);
    add('Split horizontally',()=>manager.beginSplit(id,'column'),!placed);
    add('Join adjacent area',()=>manager.beginJoin(id,adjacent),!manager.canJoin(id,adjacent));
    add('Swap with adjacent area',()=>manager.swap(id,adjacent),!placed||!manager.neighbors(id).length);
    menu.append(element('hr','',null,d));
    add('Duplicate area',()=>manager.duplicate(id));
    add('Duplicate into new window',()=>manager.duplicateWindow(id));
    add(record.popup?'Dock back into workspace':'Undock into new window',()=>record.popup?manager.redock(id):manager.undock(id));
    add('Hide panel · reopen from Panels',()=>manager.hide(id),!manager.canHide(id));
    add(manager.maximized===id?'Restore area':'Maximize area · Ctrl+Space',()=>manager.maximize(id),!placed);
    add(manager.focused===id?'Leave focus mode':'Focus mode · Ctrl+Alt+Space',()=>manager.focus(id),!placed);
    menu.append(element('hr','',null,d));
    manager.types.forEach(type=>add('New '+type.title,()=>manager.create(type.id,placed?id:undefined)));
    menu.append(element('hr','',null,d));add('Reset area layout',()=>manager.reset());
    d.body.append(menu);watchMenu(menu);menu.style.left=clamp(x,0,Math.max(0,d.defaultView.innerWidth-menu.offsetWidth))+'px';menu.style.top=clamp(y,0,Math.max(0,d.defaultView.innerHeight-menu.offsetHeight))+'px';menu.querySelector('button:not(:disabled)')?.focus();
  }
  doc.addEventListener('pointerdown',e=>{if(menu?.role==='dialog'&&menu._returnFocus?.contains(e.target))return;if(menu&&!menu.contains(e.target))closeMenu(false);},true);
  doc.addEventListener('keydown',e=>{
    if(e.key==='Escape')closeMenu();
    if(menu?.getAttribute('role')==='menu'&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(doc.activeElement);buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    if(e.ctrlKey&&e.code==='Space'&&active&&!e.target.closest('input,textarea,select,[contenteditable=true]')){e.preventDefault();e.stopImmediatePropagation();active.manager[e.altKey?'focus':'maximize'](active.id);}
  },true);
  global.addEventListener('showave:workspace-changed',()=>focusedManager?.exitFocus());
  global.addEventListener('showave:area-focus-ended',()=>focusedManager?.exitFocus());

  /* Incremental secondary DOM: ids live in a separate document. Forwarding
   * targets actual controls so all existing listeners and engine state apply. */
  function sharedStyles(sourceDoc,target){
    const copies=new Map(),loads=[],pendingLoads=new Map(),marker=target.createComment('Shared workspace styles');
    // Target-owned base sheets precede the live source appearance. Mirror-only
    // layout resets are appended later and keep their intentional precedence.
    target.head.append(marker);
    const ownedLinks=new Map([...target.head.querySelectorAll('link[rel=stylesheet]')].map(link=>[link.href,link]));
    function sync(){
      const originals=[...sourceDoc.querySelectorAll('link[rel=stylesheet],style')];
      for(const [original,twin] of copies)if(!originals.includes(original)){pendingLoads.get(original)?.();twin.remove();copies.delete(original);}
      const ordered=[];
      originals.forEach(original=>{
        // Keep owned base sheets in the source cascade order too. Otherwise a
        // copied typography override precedes the popup's base 11px header rule.
        if(original.tagName==='LINK'&&ownedLinks.has(original.href)){pendingLoads.get(original)?.();copies.get(original)?.remove();copies.delete(original);const twin=ownedLinks.get(original.href);twin.disabled=original.disabled;ordered.push(twin);return;}
        let twin=copies.get(original);
        if(!twin){twin=original.cloneNode(true);copies.set(original,twin);
          if(twin.tagName==='LINK')loads.push(new Promise(resolve=>{const finish=()=>{pendingLoads.delete(original);resolve();};pendingLoads.set(original,finish);twin.addEventListener('load',finish,{once:true});twin.addEventListener('error',finish,{once:true});}));
        }
        [...twin.attributes].forEach(attr=>{if(!original.hasAttribute(attr.name))twin.removeAttribute(attr.name);});
        [...original.attributes].forEach(attr=>{if(twin.getAttribute(attr.name)!==attr.value)twin.setAttribute(attr.name,attr.value);});
        if(twin.tagName==='LINK'){if(twin.href!==original.href)twin.href=original.href;twin.disabled=original.disabled;}
        else if(twin.textContent!==original.textContent)twin.textContent=original.textContent;
        ordered.push(twin);
      });
      let next=marker;for(let i=ordered.length-1;i>=0;i--){const twin=ordered[i];if(twin.nextSibling!==next)target.head.insertBefore(twin,next);next=twin;}
    }
    sync();const ready=Promise.all(loads);
    const containsSheet=node=>node.nodeType===1&&(node.matches('style,link')||node.querySelector('style,link[rel=stylesheet]'));
    const observer=new MutationObserver(changes=>{
      // Broadcast also appends styles in its body. Only stylesheet mutations
      // rescan the cascade; meters, frame counters and control updates do not.
      if(changes.some(change=>(change.target.nodeType===1?change.target:change.target.parentElement)?.closest('style,link')||
        change.type==='childList'&&[...change.addedNodes,...change.removedNodes].some(containsSheet)))sync();
    });
    observer.observe(sourceDoc.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    return {ready,dispose(){observer.disconnect();pendingLoads.forEach(finish=>finish());pendingLoads.clear();copies.forEach(twin=>twin.remove());copies.clear();marker.remove();}};
  }
  const retainedBroadcastRoots=new WeakMap();
  function retainBroadcastOwnerLayout(root){
    let state=retainedBroadcastRoots.get(root);
    if(!state){
      state={count:0,width:root.style.getPropertyValue('--ol-detached-width'),height:root.style.getPropertyValue('--ol-detached-height')};
      const size=()=>{const bounds=root.getBoundingClientRect();if(bounds.width>0&&bounds.height>0){root.style.setProperty('--ol-detached-width',bounds.width+'px');root.style.setProperty('--ol-detached-height',bounds.height+'px');}};
      size();root.classList.add('ol-area-detached-owner');state.observer=new ResizeObserver(size);state.observer.observe(root);retainedBroadcastRoots.set(root,state);
    }
    state.count++;
    return ()=>{if(--state.count)return;state.observer.disconnect();root.classList.remove('ol-area-detached-owner');for(const [name,value] of [['--ol-detached-width',state.width],['--ol-detached-height',state.height]])value?root.style.setProperty(name,value):root.style.removeProperty(name);retainedBroadcastRoots.delete(root);};
  }
  function mirror(source,host,options={}){
    if(!source?.ownerDocument?.defaultView||!host?.ownerDocument)throw new Error('A live workspace is required.');
    const doc=source.ownerDocument,owner=doc.defaultView;
    const excluded=options.excludeSelectors?.join(',')||'';
    const ignored=new Set((options.ignoreAttributes||[]).filter(name=>name!=='inert'&&name!=='aria-hidden'));
    const nested=new Map(),captures=new Map();
    const frame=element('iframe','',null,host.ownerDocument);frame.title='Shared '+(source.getAttribute('aria-label')||'area');frame.style.cssText='visibility:hidden;border:0;width:100%;height:100%;flex:1;min-height:0';host.append(frame);
    const broadcastRoot=source.closest('#workspaceStudio');
    const releaseBroadcastLayout=broadcastRoot&&frame.ownerDocument!==doc?retainBroadcastOwnerLayout(broadcastRoot):null;
    const targetDoc=frame.contentDocument;targetDoc.open();targetDoc.write('<!doctype html><html><head></head><body style="margin:0;height:100vh;overflow:hidden;display:flex;flex-direction:column"></body></html>');targetDoc.close();
    const styleLayer=sharedStyles(doc,targetDoc);
    const bodyVariables=new Set();
    function syncAppearance(){
      if(!targetDoc.defaultView)return;
      function attributes(from,to,skip=[]){
        [...to.attributes].forEach(attr=>{if(!skip.includes(attr.name)&&!from.hasAttribute(attr.name))to.removeAttribute(attr.name);});
        [...from.attributes].forEach(attr=>{if(!skip.includes(attr.name))to.setAttribute(attr.name,attr.value);});
      }
      attributes(doc.documentElement,targetDoc.documentElement,['id','data-openlive-window-state']);
      attributes(doc.body,targetDoc.body,['style','id']);
      const variables=[...doc.body.style].filter(name=>name.startsWith('--'));
      for(const name of bodyVariables)if(!variables.includes(name)){targetDoc.body.style.removeProperty(name);bodyVariables.delete(name);}
      variables.forEach(name=>{targetDoc.body.style.setProperty(name,doc.body.style.getPropertyValue(name),doc.body.style.getPropertyPriority(name));bodyVariables.add(name);});
    }
    syncAppearance();
    const appearanceObserver=new MutationObserver(syncAppearance);
    appearanceObserver.observe(doc.documentElement,{attributes:true});appearanceObserver.observe(doc.body,{attributes:true});
    const reset=element('style','',null,targetDoc);reset.textContent=options.workspace?'.ol-mirror-source{display:contents!important}#workspaceStudio.ol-area-detached-owner[hidden]{display:none!important}': 'body> :first-child,.ol-mirror-source{display:flex!important;flex-direction:column;position:relative!important;inset:auto!important;width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;flex:1!important;margin:0!important}.ol-mirror-source.mon>.mon-head{display:none}';targetDoc.head.append(reset);
    const forward=new WeakMap(),back=new WeakMap();let stopped=false;
    const gestures=owner.OpenLiveSessionPolicy?.sharedViewGestures?.create(targetDoc,node=>back.get(node),node=>forward.get(node));
    styleLayer.ready.then(()=>{if(!stopped&&targetDoc.defaultView){frame.style.visibility='';frame.dataset.areaReady='true';}});
    const ownerKey=Symbol.for('showave.area-mirror-menu-owner'),token={},menus=new Map();
    const menuSelector='.dropdown,.context-menu,.ctx-menu,[role="menu"]';
    let pointer={x:8,y:8},lastTarget=null;
    function skipAttribute(original,name){
      return /^on/i.test(name)||ignored.has(name)||original.hasAttribute?.('data-showave-workspace-suspended')&&['inert','aria-hidden'].includes(name)||
        original.tagName==='IFRAME'&&['src','srcdoc'].includes(name)||original.tagName==='VIDEO'&&name==='src';
    }
    function mountNested(original,twin){
      let dispose=null;
      const mount=()=>{dispose?.();dispose=null;if(stopped||!twin.isConnected)return;
        try{const body=original.contentDocument?.body,host=twin.contentDocument?.body;if(body&&host){host.style.cssText='margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden';dispose=mirror(body,host,{workspace:true});}}catch(_){}
      };
      // Keep the view blank: copying a URL would start another editor/session.
      original.addEventListener('load',mount);nested.set(original,()=>{original.removeEventListener('load',mount);dispose?.();});queueMicrotask(mount);
    }
    function make(original){
      let twin=forward.get(original);if(twin)return twin;
      if(original.nodeType===1&&(original.matches('script,style,link[rel=stylesheet]')||excluded&&original.matches(excluded))){twin=targetDoc.createComment('Shared view: retained by owner');forward.set(original,twin);return twin;}
      if(original.nodeType===1&&original.tagName==='IFRAME'){
        twin=targetDoc.createElement('iframe');[...original.attributes].forEach(attr=>{if(!skipAttribute(original,attr.name))twin.setAttribute(attr.name,attr.value);});
        forward.set(original,twin);back.set(twin,original);mountNested(original,twin);return twin;
      }
      twin=original===doc.body?targetDoc.createElement('div'):original.tagName==='VIDEO'?targetDoc.createElement('canvas'):targetDoc.importNode(original,false);
      if(original===doc.body||original.tagName==='VIDEO')[...original.attributes].forEach(attr=>{if(!skipAttribute(original,attr.name))twin.setAttribute(attr.name,attr.value);});
      forward.set(original,twin);back.set(twin,original);
      if(original.nodeType===1)[...twin.attributes].forEach(attr=>{if(skipAttribute(original,attr.name))twin.removeAttribute(attr.name);});
      if(original.tagName==='VIDEO')return twin;
      original.childNodes.forEach(child=>twin.append(make(child)));return twin;
    }
    const twin=make(source);twin.classList.add('ol-mirror-source');
    const shell=source.closest('#timelineRoot,#wireRoot,#aoHost,#alleyRoot');
    if(shell&&shell!==source){const wrapper=targetDoc.importNode(shell,false);wrapper.removeAttribute('hidden');wrapper.append(twin);targetDoc.body.append(wrapper);forward.set(shell,wrapper);}
    else targetDoc.body.append(twin);
    function syncChanges(changes){
      if(stopped||!targetDoc.defaultView)return;
      for(const change of changes){const dest=forward.get(change.target);if(!dest)continue;
        if(change.type==='attributes'){if(dest.nodeType!==1)continue;const name=change.attributeName,value=change.target.getAttribute(name);if(value===null||skipAttribute(change.target,name))dest.removeAttribute(name);else dest.setAttribute(name,value);if(change.target===source&&name==='class')dest.classList.add('ol-mirror-source');if(name==='data-showave-workspace-suspended'){for(const attr of ['inert','aria-hidden']){if(skipAttribute(change.target,attr)||!change.target.hasAttribute(attr))dest.removeAttribute(attr);else dest.setAttribute(attr,change.target.getAttribute(attr));}}}
        else if(change.type==='characterData')dest.data=change.target.data;
        else {if(dest.nodeType!==1)continue;if(change.target.isContentEditable&&targetDoc.activeElement===dest&&dest.textContent===change.target.textContent)continue;const children=[...change.target.childNodes].map(make);children.forEach((child,i)=>{if(dest.childNodes[i]!==child)dest.insertBefore(child,dest.childNodes[i]||null);});while(dest.childNodes.length>children.length)dest.lastChild.remove();}
      }
    }
    const observer=new MutationObserver(syncChanges);observer.observe(source,{subtree:true,childList:true,characterData:true,attributes:true});if(shell&&shell!==source)observer.observe(shell,{attributes:true});
    function removeMenu(original){
      const entry=menus.get(original);if(!entry)return;
      entry.observer.disconnect();entry.twin.remove();menus.delete(original);
      original.style.opacity=entry.opacity;original.style.pointerEvents=entry.pointerEvents;
      const forget=node=>{const copied=forward.get(node);if(copied)back.delete(copied);forward.delete(node);node.childNodes.forEach(forget);};forget(original);
    }
    function clearMenus(){[...menus.keys()].forEach(removeMenu);}
    function positionMenu(original,entry){
      const view=targetDoc.defaultView;if(stopped||!view)return;
      const parent=original._opener?.closest?.(menuSelector)||entry.opener?.closest?.(menuSelector);
      const anchor=parent&&menus.has(parent)?forward.get(original._opener||entry.opener.closest('[role^="menuitem"],.dd-item')||entry.opener):null;
      const bounds=anchor?.getBoundingClientRect();
      const width=entry.twin.offsetWidth,height=entry.twin.offsetHeight;
      let x=bounds?bounds.right-2:entry.pointer.x,y=bounds?bounds.top-3:entry.pointer.y;
      if(bounds&&x+width>view.innerWidth-4)x=bounds.left-width+2;
      Object.assign(entry.twin.style,{position:'fixed',left:clamp(x,4,Math.max(4,view.innerWidth-width-4))+'px',top:clamp(y,4,Math.max(4,view.innerHeight-height-4))+'px',opacity:'1',pointerEvents:'auto'});
    }
    function syncFocus(){
      if(stopped||!targetDoc.defaultView||doc[ownerKey]!==token)return;
      const original=doc.activeElement,copy=forward.get(original);
      if(copy?.isConnected&&(source.contains(original)||[...menus.keys()].some(menu=>menu.contains(original))))copy.focus?.({preventScroll:true});
    }
    function syncMenus(){
      if(stopped||!targetDoc.defaultView||!owner||owner.closed||doc[ownerKey]!==token){clearMenus();return;}
      for(const original of [...menus.keys()])if(!original.isConnected||original.hidden||owner.getComputedStyle(original).display==='none')removeMenu(original);
      // Restrict external copies to transient menu surfaces. Dialogs and their
      // embedded browsing contexts continue to belong to the owning document.
      for(const original of [...doc.body.children]){
        if(source.contains(original))continue;
        if(!original.matches(menuSelector)||original.classList.contains('ol-area-menu')||original.hidden||original.querySelector('iframe,object,embed')||owner.getComputedStyle(original).display==='none')continue;
        let entry=menus.get(original);
        if(!entry){
          const twin=make(original);entry={twin,pointer:{...pointer},opener:lastTarget,opacity:original.style.opacity,pointerEvents:original.style.pointerEvents};menus.set(original,entry);targetDoc.body.append(twin);
          // Keep the original laid out and focusable for the application's
          // menu handlers, while showing its pixels in the initiating view.
          original.style.opacity='0';original.style.pointerEvents='none';
          entry.observer=new MutationObserver(changes=>{syncChanges(changes);if(stopped||!targetDoc.defaultView||!owner||owner.closed||doc[ownerKey]!==token||!original.isConnected||original.hidden||owner.getComputedStyle(original).display==='none')removeMenu(original);else positionMenu(original,entry);});
          entry.observer.observe(original,{subtree:true,childList:true,characterData:true,attributes:true});
        }
        positionMenu(original,entry);
      }
      syncFocus();
    }
    const broadcastView=source.matches('.ol-broadcast-panel,.bc-rail,.bc-inspector');
    const viewportPointers=new Map(),ownerDialogs=new Map();
    let ownerDialogNotice=null,ownerDialogTimer=0;
    function cancelViewportPointers(){
      const pending=[...viewportPointers];viewportPointers.clear();
      pending.forEach(([id,gesture])=>{const event=new owner.PointerEvent('pointercancel',{bubbles:true,pointerId:id,pointerType:gesture.pointerType,isPrimary:true});Object.defineProperty(event,'__showaveMirror',{value:true});gesture.original.dispatchEvent(event);});
      releaseCaptures();
    }
    const escapeViewport=event=>{if(event.key==='Escape'&&viewportPointers.size){event.preventDefault();cancelViewportPointers();}};
    targetDoc.addEventListener('keydown',escapeViewport,true);frame.ownerDocument.addEventListener('keydown',escapeViewport,true);
    const ownerDialogSelector='dialog.bc-source-dialog,dialog.bc-arrange-dialog,dialog.bc-scene-dialog,section.ol-design-library[role="dialog"]';
    function ownerDialogVisible(node){
      if(node.parentNode!==doc.body||node.hidden||node.getAttribute('aria-hidden')==='true'||node.tagName==='DIALOG'&&!node.open)return false;
      const style=owner.getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden';
    }
    function dialogNotice(text){
      ownerDialogNotice?.remove();clearTimeout(ownerDialogTimer);
      ownerDialogNotice=element('div','ol-area-status',text,frame.ownerDocument);ownerDialogNotice.role='status';frame.ownerDocument.body.append(ownerDialogNotice);
      ownerDialogTimer=setTimeout(()=>{ownerDialogNotice?.remove();ownerDialogNotice=null;},3500);
    }
    function revealOwnerDialog(node){
      if(stopped||!ownerDialogVisible(node))return;cancelViewportPointers();
      let main=owner,activation;
      try{if(owner.parent!==owner&&owner.parent.OpenLiveWorkspaceHost){main=owner.parent;activation=main.OpenLiveWorkspaceHost.activate('broadcast');}}
      catch(error){activation=Promise.reject(error);}
      Promise.resolve(activation).then(async result=>{
        if(stopped||!ownerDialogVisible(node))return;
        if(result?.detached){main.OpenLiveWorkspaceHost.getWindow?.('broadcast')?.focus();dialogNotice('Opened in Broadcast workspace');return;}
        if(typeof main.OpenLiveDesktop?.windowAction==='function')await main.OpenLiveDesktop.windowAction('restore');
        if(stopped||!ownerDialogVisible(node))return;
        main.focus?.();owner.focus?.();
        const focus=node.contains(doc.activeElement)?doc.activeElement:node.querySelector('[autofocus],input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||node;
        focus.focus?.({preventScroll:true});dialogNotice('Opened in Broadcast workspace');
      }).catch(()=>{if(!stopped)dialogNotice('Open the Broadcast workspace to continue.');});
    }
    function watchOwnerDialogs(initial=false){
      if(!broadcastView)return;
      ownerDialogs.forEach((state,node)=>{if(node.parentNode!==doc.body){state.observer.disconnect();ownerDialogs.delete(node);}});
      [...doc.body.children].filter(node=>node.matches(ownerDialogSelector)).forEach(node=>{
        if(ownerDialogs.has(node))return;
        const state={visible:initial&&ownerDialogVisible(node),observer:null};
        const check=()=>{const visible=ownerDialogVisible(node);if(visible&&!state.visible&&doc[ownerKey]===token)revealOwnerDialog(node);state.visible=visible;};
        state.observer=new MutationObserver(check);state.observer.observe(node,{attributes:true,attributeFilter:['open','hidden','class','style','aria-hidden']});ownerDialogs.set(node,state);check();
      });
    }
    watchOwnerDialogs(true);
    const bodyObserver=new MutationObserver(()=>{syncMenus();watchOwnerDialogs();});bodyObserver.observe(doc.body,{childList:true});
    const changedOwner=()=>{if(doc[ownerKey]!==token)clearMenus();};doc.addEventListener('showave:mirror-menu-owner',changedOwner);
    const originalInteraction=event=>{if(event.isTrusted&&doc[ownerKey]){doc[ownerKey]=null;doc.dispatchEvent(new owner.Event('showave:mirror-menu-owner'));}};
    doc.addEventListener('pointerdown',originalInteraction,true);doc.addEventListener('keydown',originalInteraction,true);
    const focusChanged=()=>queueMicrotask(syncFocus);doc.addEventListener('focusin',focusChanged);
    targetDoc.addEventListener('focusin',event=>{const original=back.get(event.target);if(original&&[...menus.keys()].some(menu=>menu.contains(original)))original.focus?.({preventScroll:true});});
    function releaseCaptures(){captures.forEach((entry,original)=>{for(const name of ['setPointerCapture','releasePointerCapture','hasPointerCapture']){if(entry.saved[name])Object.defineProperty(original,name,entry.saved[name]);else delete original[name];}});captures.clear();}
    ['click','dblclick','input','change','focus','blur','focusin','focusout','pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','mousedown','mousemove','mouseup','mouseover','mouseout','mouseenter','mouseleave','keydown','keyup','contextmenu','wheel','dragstart','dragover','dragenter','dragleave','drop','dragend'].forEach(type=>targetDoc.addEventListener(type,event=>{
      if(gestures?.inputDelegated(event))return;
      const gesture=viewportPointers.get(event.pointerId),original=gesture?.original||back.get(event.target);if(!original?.dispatchEvent||original.nodeType!==1)return;
      if(['click','dblclick','pointerdown','mousedown','keydown','contextmenu'].includes(type)){
        if(doc[ownerKey]!==token){doc[ownerKey]=token;doc.dispatchEvent(new owner.Event('showave:mirror-menu-owner'));}
        const dialog=broadcastView&&[...ownerDialogs.keys()].find(node=>ownerDialogVisible(node)&&node.tagName==='DIALOG'&&node.matches(':modal'));
        if(dialog){event.preventDefault();revealOwnerDialog(dialog);return;}
      }
      if(Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)){pointer={x:event.clientX,y:event.clientY};lastTarget=original;}
      if(type==='input'||type==='change'){if(original.tagName==='INPUT'&&original.type==='file'){if(event.target.files)original.files=event.target.files;}else if('value'in original)original.value=event.target.value;if('checked'in original)original.checked=event.target.checked;}
      if(original.isContentEditable&&['input','change','keydown','blur','focusout'].includes(type)&&original.textContent!==event.target.textContent)original.textContent=event.target.textContent;
      if(type==='click'&&original.tagName==='INPUT'&&['file','checkbox','radio'].includes(original.type)){event.preventDefault();const deliver=()=>original.click();if(gestures)gestures.forward(event,deliver);else deliver();return;}
      if(type==='click'&&broadcastView&&original.closest('summary')){event.preventDefault();const deliver=()=>original.closest('summary').click();if(gestures)gestures.forward(event,deliver);else deliver();return;}
      const viewport=original.closest('.ol-broadcast-preview')&&original.closest('#previewFrame')||original.closest('.bc-source-map-frame,.bc-media-track');
      const viewportView=viewport&&forward.get(viewport);
      const bounds=gesture?.bounds||(viewport||original).getBoundingClientRect(),view=gesture?.view||(viewportView||event.target).getBoundingClientRect();
      const init={bubbles:!['mouseenter','mouseleave','focus','blur'].includes(type),cancelable:true,button:event.button,buttons:event.buttons,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,metaKey:event.metaKey,key:event.key,code:event.code,pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,screenX:event.screenX,screenY:event.screenY,deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,dataTransfer:event.dataTransfer,relatedTarget:back.get(event.relatedTarget)||null,
        clientX:bounds.left+(event.clientX-view.left)*(bounds.width/(view.width||1)),clientY:bounds.top+(event.clientY-view.top)*(bounds.height/(view.height||1))};
      if(type==='pointerdown'){
        releaseCaptures();for(let node=original;node&&node.nodeType===1;node=node.parentElement){const dest=forward.get(node);if(!dest?.setPointerCapture)continue;const saved={};for(const name of ['setPointerCapture','releasePointerCapture','hasPointerCapture']){saved[name]=Object.getOwnPropertyDescriptor(node,name);Object.defineProperty(node,name,{configurable:true,value:id=>{try{return dest[name](id);}catch(_){return name==='hasPointerCapture'?false:undefined;}}});}captures.set(node,{saved});}
      }
      const Constructor=type.startsWith('pointer')||type==='lostpointercapture'?owner.PointerEvent:type.startsWith('key')?owner.KeyboardEvent:/focus|blur/.test(type)?owner.FocusEvent:type==='wheel'?owner.WheelEvent:/^drag|^drop/.test(type)?owner.DragEvent:/click|mouse|contextmenu/.test(type)?owner.MouseEvent:owner.Event;
      if(type.startsWith('key')&&menus.size)original.focus?.({preventScroll:true});
      const forwarded=new Constructor(type,init);Object.defineProperty(forwarded,'__showaveMirror',{value:true});
      // Pointer capture retains the dragged header as event.target. Resolve
      // the actual surface beneath the pointer in its displayed view before
      // forwarding: the original Show may be hidden behind another workspace.
      if(type.startsWith('pointer')||type==='lostpointercapture')Object.defineProperty(forwarded,'__showaveMirrorHit',{
        value:back.get(targetDoc.elementFromPoint(event.clientX,event.clientY))||null
      });
      const deliver=()=>original.dispatchEvent(forwarded);
      const accepted=gestures?gestures.forward(event,deliver):deliver();
      if(!accepted)event.preventDefault();
      if(type==='pointerdown'&&viewport&&viewportView&&viewport.__openliveScenePointer===event.pointerId){
        viewportPointers.set(event.pointerId,{original:viewport,bounds,view,pointerType:event.pointerType});
        try{viewportView.setPointerCapture(event.pointerId);}catch(_){}
      }
      if(gesture){event.preventDefault();if(['pointerup','pointercancel','lostpointercapture'].includes(type))viewportPointers.delete(event.pointerId);}
      if(['pointerup','pointercancel','lostpointercapture'].includes(type))releaseCaptures();
      queueMicrotask(syncMenus);
      if(type==='click'&&original.closest('a[href]'))event.preventDefault();
    },true));
    targetDoc.addEventListener('pointerdown',event=>{
      if(!menus.size||back.has(event.target))return;
      doc.body.dispatchEvent(new owner.MouseEvent('mousedown',{bubbles:true,cancelable:true}));queueMicrotask(syncMenus);
    },true);
    targetDoc.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&menus.size&&!back.has(event.target)){doc.body.dispatchEvent(new owner.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));queueMicrotask(syncMenus);}
    },true);
    const scrollWrites=new WeakMap();
    const gridScrollers=source.matches('.ol-show-grid,.ol-show-layers')?[...source.querySelectorAll('#layers,#gridCol')]:[];
    const ownedScrollers=source.matches('.ol-show-grid,.ol-show-layers')?
      [source,...gridScrollers,...source.querySelectorAll('#topArea,#xfRow,#transport,#deckRow')]:[];
    // Broadcast lists rebuild as selection changes. Each view owns those
    // scroll positions too, including newly created Inspector/Source controls.
    const ownsScroll=node=>ownedScrollers.includes(node)||broadcastView&&(node===source||source.contains(node));
    const gridColumn=gridScrollers.find(node=>node.id==='gridCol'),gridView=gridColumn&&forward.get(gridColumn);
    const gridStrip=gridScrollers.length&&twin.querySelector('#leftCol');
    let gridGutterObserver=null,gridGutterStyle=null,gridGutter=-1;
    function syncGridGutter(){
      if(stopped||!gridView||!gridStrip||!targetDoc.defaultView)return;
      const style=targetDoc.defaultView.getComputedStyle(gridView);
      const gutter=Math.max(0,gridView.offsetHeight-gridView.clientHeight-
        (parseFloat(style.borderTopWidth)||0)-(parseFloat(style.borderBottomWidth)||0));
      if(gutter===gridGutter)return;gridGutter=gutter;
      // Reserve the Grid's horizontal scrollbar below the Layer strip too.
      // Their row viewports then reach the same last row at the same scrollTop.
      // This local rule survives source style synchronization and adds no rows.
      gridGutterStyle.textContent='.ol-mirror-source #leftCol{box-sizing:border-box;padding-bottom:'+gutter+'px!important}';
    }
    if(gridView&&gridStrip){
      gridGutterStyle=element('style','',null,targetDoc);targetDoc.head.append(gridGutterStyle);
      gridGutterObserver=new ResizeObserver(syncGridGutter);gridGutterObserver.observe(gridView);
    }
    function writeScroll(node,top,left){
      const beforeTop=node.scrollTop,beforeLeft=node.scrollLeft;
      if(beforeTop!==top)node.scrollTop=top;
      if(beforeLeft!==left)node.scrollLeft=left;
      if(node.scrollTop!==beforeTop||node.scrollLeft!==beforeLeft)
        scrollWrites.set(node,{top:node.scrollTop,left:node.scrollLeft});
    }
    function scrollEcho(node){
      const expected=scrollWrites.get(node);scrollWrites.delete(node);
      return expected&&node.scrollTop===expected.top&&node.scrollLeft===expected.left;
    }
    function syncScroll(original){const dest=forward.get(original);if(stopped||!dest||original.nodeType!==1)return;writeScroll(dest,original.scrollTop,original.scrollLeft);}
    const sourceScrolled=event=>{
      if(scrollEcho(event.target)||ownsScroll(event.target))return;
      syncScroll(event.target);
    };
    source.addEventListener('scroll',sourceScrolled,true);
    targetDoc.addEventListener('scroll',event=>{
      if(stopped||scrollEcho(event.target))return;
      const original=back.get(event.target);if(!original)return;
      /* Each Grid or Layers view owns its viewport. A short popup can scroll farther
         than its parked 960x640 original: never echo that original's clamped
         position back into the popup. Seed from it once, then pair local rows.
         Echo suppression also keeps a slightly shorter peer's range from
         pulling the actively scrolled side backwards. Horizontal stays local. */
      if(gridScrollers.includes(original))gridScrollers.forEach(peer=>{
        const dest=forward.get(peer);if(peer!==original&&dest)
          writeScroll(dest,event.target.scrollTop,dest.scrollLeft);
      });
      // A duplicate must not scroll its visible original, linked or otherwise.
      // Parked originals can retain a best-effort position for redocking.
      if(ownsScroll(original)&&
        (original.closest('.ol-area')?.dataset.areaState==='docked'||original.dataset.showaveRowScrollLinked==='true'))return;
      writeScroll(original,event.target.scrollTop,event.target.scrollLeft);
    },true);
    styleLayer.ready.then(()=>{if(!stopped){syncGridGutter();[source,...source.querySelectorAll('*')].forEach(syncScroll);}});
    function syncPixels(){
      // Native window Close destroys its browsing context before the redock
      // poll runs; connected nodes can still belong to that closed document.
      const frameWindow=frame.ownerDocument.defaultView;
      if(stopped||!frame.isConnected||!frameWindow||frameWindow.closed||!targetDoc.defaultView||frameWindow.getComputedStyle(frame).visibility==='hidden')return;
      if(options.workspace)owner.dispatchEvent(new owner.CustomEvent('showave:shared-view-frame'));
      [source,...menus.keys()].flatMap(surface=>[...surface.querySelectorAll('input,select,textarea,canvas,video')]).forEach(original=>{const dest=forward.get(original);if(!dest)return;
        if(original.tagName==='CANVAS'){if(dest.width!==original.width)dest.width=original.width;if(dest.height!==original.height)dest.height=original.height;try{dest.getContext('2d')?.drawImage(original,0,0);}catch(_){}}
        else if(original.tagName==='VIDEO'){if(original.readyState<2)return;if(dest.width!==original.videoWidth)dest.width=original.videoWidth;if(dest.height!==original.videoHeight)dest.height=original.videoHeight;try{dest.getContext('2d')?.drawImage(original,0,0);}catch(_){}}
        else {if(targetDoc.activeElement!==dest&&dest.value!==original.value&&(original.type!=='file'||original.value===''))dest.value=original.value;if('checked'in original)dest.checked=original.checked;}
      });
    }
    let animation=null;const tick=()=>{if(stopped)return;syncPixels();animation=targetDoc.defaultView?.requestAnimationFrame(tick);};
    const timer=options.workspace?null:setInterval(syncPixels,100);if(options.workspace)tick();
    return ()=>{stopped=true;cancelViewportPointers();targetDoc.removeEventListener('keydown',escapeViewport,true);frame.ownerDocument.removeEventListener('keydown',escapeViewport,true);ownerDialogs.forEach(state=>state.observer.disconnect());ownerDialogs.clear();ownerDialogNotice?.remove();clearTimeout(ownerDialogTimer);gestures?.dispose();releaseCaptures();releaseBroadcastLayout?.();nested.forEach(dispose=>dispose());nested.clear();observer.disconnect();bodyObserver.disconnect();appearanceObserver.disconnect();gridGutterObserver?.disconnect();source.removeEventListener('scroll',sourceScrolled,true);styleLayer.dispose();clearMenus();doc.removeEventListener('showave:mirror-menu-owner',changedOwner);doc.removeEventListener('pointerdown',originalInteraction,true);doc.removeEventListener('keydown',originalInteraction,true);doc.removeEventListener('focusin',focusChanged);if(doc[ownerKey]===token)doc[ownerKey]=null;clearInterval(timer);if(animation!=null)targetDoc.defaultView?.cancelAnimationFrame(animation);frame.remove();};
  }

  function windowAppearance(popup){
    const target=popup.document,styleLayer=sharedStyles(doc,target),bodyVariables=new Set();
    function attributes(from,to,skip){
      [...to.attributes].forEach(attr=>{if(!skip.includes(attr.name)&&!from.hasAttribute(attr.name))to.removeAttribute(attr.name);});
      [...from.attributes].forEach(attr=>{if(!skip.includes(attr.name))to.setAttribute(attr.name,attr.value);});
    }
    const sync=()=>{
      if(popup.closed||!target.defaultView)return;
      attributes(doc.documentElement,target.documentElement,['id','data-openlive-window-state']);
      attributes(doc.body,target.body,['id','style','class']);
      target.body.className=doc.body.className;target.body.classList.add('ol-area-popup');
      const variables=[...doc.body.style].filter(name=>name.startsWith('--'));
      for(const name of bodyVariables)if(!variables.includes(name)){target.body.style.removeProperty(name);bodyVariables.delete(name);}
      variables.forEach(name=>{target.body.style.setProperty(name,doc.body.style.getPropertyValue(name),doc.body.style.getPropertyPriority(name));bodyVariables.add(name);});
    };
    sync();const observer=new MutationObserver(sync);
    observer.observe(doc.documentElement,{attributes:true});observer.observe(doc.body,{attributes:true});
    return ()=>{observer.disconnect();styleLayer.dispose();};
  }

  function install(options){
    if(managers.has(options.id))return managers.get(options.id);
    const root=options.root;root.classList.add('ol-area-root');
    const types=new Map(options.types.map(type=>[type.id,type])),records=new Map();
    const parking=element('div','ol-area-parking');parking.setAttribute('aria-hidden','true');doc.body.append(parking);
    const manager={id:options.id,root,records,types,tree:null,maximized:null,focused:null},dividers=new Map();
    const focusExit=element('button','ol-area-focus-exit','Return to workspace');focusExit.type='button';focusExit.hidden=true;focusExit.title='Leave focus mode · Ctrl+Alt+Space';root.append(focusExit);
    focusExit.addEventListener('click',()=>manager.exitFocus());
    managers.set(manager.id,manager);
    function makeRecord(typeId,source=null){
      const type=types.get(typeId);if(!type)return null;
      const record={id:uid(),type:typeId,source:source||type.element||null,element:null,dispose:null,popup:null,popupSize:null,home:null};
      record.element=element('section','ol-area');record.element.dataset.areaId=record.id;
      record.element.dataset.areaType=typeId;
      record.content=element('div','ol-area-content');records.set(record.id,record);
      header(record,record.element);record.element.append(record.content);root.append(record.element);loadContent(record);
      for(const location of ['tl','tr','bl','br']){const corner=element('button','ol-area-corner');corner.type='button';corner.dataset.corner=location;corner.title='Drag to split or join. Click for panel options.';corner.setAttribute('aria-label','Split or join area');corner.append(controlIcon('plus'));record.element.append(corner);
        corner.addEventListener('pointerdown',event=>cornerDrag(record,event));
        corner.addEventListener('click',event=>{if(event.detail===0){const r=corner.getBoundingClientRect();showMenu(manager,record.id,r.left,r.bottom,doc,corner);}});}
      record.element.addEventListener('pointerenter',()=>{active={manager,id:record.id};});
      record.element.addEventListener('dragover',event=>{
        if(!drag||drag.manager!==manager||drag.id===record.id)return;event.preventDefault();event.stopPropagation();const edge=edgeAt(record.element,event);record.element.querySelector('.ol-area-drop')?.remove();const preview=element('div','ol-area-drop',edge==='center'?'Swap areas':'Dock '+edge);preview.dataset.edge=edge;record.element.append(preview);
      });
      record.element.addEventListener('dragleave',event=>{if(!record.element.contains(event.relatedTarget))record.element.querySelector('.ol-area-drop')?.remove();});
      record.element.addEventListener('drop',event=>{record.element.querySelector('.ol-area-drop')?.remove();if(!drag||drag.manager!==manager)return;event.preventDefault();event.stopPropagation();manager.dock(drag.id,record.id,edgeAt(record.element,event));drag=null;});
      return record;
    }
    function loadContent(record){
      record.dispose?.();record.content.replaceChildren();
      const type=types.get(record.type);
      if(record.source){
        const occupied=[...records.values()].some(other=>other!==record&&other.source===record.source&&other.original);
        if(!occupied&&!record.mirrored){record.original=true;record.content.append(record.source);}
        else {record.original=false;record.dispose=mirror(record.source,record.content);}
      }else if(type.build){const result=type.build(record.content);record.dispose=typeof result==='function'?result:()=>result?.destroy?.();}
    }
    function header(record,box,d=doc,popup=false){
      const head=element('header','ol-area-header',null,d),select=element('select','',null,d);head.dataset.areaType=record.type;select.setAttribute('aria-label','Editor type');
      types.forEach(type=>{const opt=element('option','',type.title,d);opt.value=type.id;select.append(opt);});select.value=record.type;
      select.addEventListener('change',()=>{if(popup){manager.redock(record.id);manager.changeType(record.id,select.value);}else manager.changeType(record.id,select.value);});head.append(select,element('span','ol-area-spacer',null,d));
      const addButton=(label,icon,fn,action)=>{const b=element('button','',null,d);b.append(controlIcon(icon,d));b.type='button';b.title=label;b.setAttribute('aria-label',label);if(action)b.dataset.areaAction=action;b.addEventListener('click',fn);head.append(b);return b;};
      const options=event=>{
        if(!popup)return showMenu(manager,record.id,event.clientX,event.clientY);
        d.querySelector('.ol-area-menu')?.remove();const local=element('div','ol-area-menu',null,d);local.role='menu';
        const action=(label,fn,icon)=>{const button=element('button','ol-area-menu-action',null,d);button.append(controlIcon(icon,d),element('span','',label,d));button.type='button';button.role='menuitem';button.addEventListener('click',()=>{local.remove();fn();});local.append(button);};
        action('Dock back into workspace',()=>manager.redock(record.id),'dock');action('Duplicate into new window',()=>manager.duplicateWindow(record.id),'undock');
        action('Hide panel · reopen from Panels',()=>manager.hide(record.id),'hide');
        types.forEach(type=>action('New '+type.title+' window',()=>{const id=manager.create(type.id);if(id)manager.undock(id);},'plus'));
        d.body.append(local);local.style.left=clamp(event.clientX,0,d.defaultView.innerWidth-local.offsetWidth)+'px';local.style.top=clamp(event.clientY,0,d.defaultView.innerHeight-local.offsetHeight)+'px';local.querySelector('button')?.focus();
        const dismiss=e=>{if(!local.isConnected){d.removeEventListener('pointerdown',dismiss,true);return;}if(!local.contains(e.target)){local.remove();d.removeEventListener('pointerdown',dismiss,true);}};d.addEventListener('pointerdown',dismiss,true);
        local.addEventListener('keydown',e=>{if(e.key==='Escape')local.remove();});
      };
      addButton('Add or reopen a panel','plus',event=>popup?options(event):manager.openPanelPicker(event.currentTarget),'add');
      const windowButton=addButton(popup?'Dock back into workspace':'Undock panel into a window',popup?'dock':'undock',()=>popup?manager.redock(record.id):manager.undock(record.id),popup?'dock':'undock');
      const windowLabel=element('span','ol-area-window-label',popup?'Dock':'Undock',d);windowLabel.setAttribute('aria-hidden','true');windowButton.append(windowLabel);
      addButton('Hide panel · reopen from Panels','close',()=>manager.hide(record.id),'hide');
      addButton('Area options','options',options,'options');
      head.draggable=popup;
      if(!popup)head.addEventListener('pointerdown',event=>{
        if(event.button!==0||event.target.closest('button,select'))return;
        event.preventDefault();const start={x:event.clientX,y:event.clientY};let target=null,edge=null,moved=false,last=event;
        head.setPointerCapture?.(event.pointerId);
        const clear=()=>root.querySelectorAll('.ol-area-drop').forEach(e=>e.remove());
        const move=e=>{last=e;if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<6&&!moved)return;moved=true;clear();const hit=Object.prototype.hasOwnProperty.call(e,'__showaveMirrorHit')?e.__showaveMirrorHit:doc.elementFromPoint(e.clientX,e.clientY);const box=hit?.ownerDocument===doc&&root.contains(hit)?hit.closest('.ol-area'):null;target=box&&box!==record.element&&root.contains(box)?box:null;if(!target)return;edge=edgeAt(target,e);const overlay=element('div','ol-area-drop',edge==='center'?'Swap areas':'Dock '+edge);overlay.dataset.edge=edge;target.append(overlay);};
        const finish=cancel=>{clear();global.removeEventListener('pointermove',move);global.removeEventListener('pointerup',up);global.removeEventListener('pointercancel',abort);global.removeEventListener('keydown',key);global.removeEventListener('contextmenu',context,true);if(head.hasPointerCapture?.(event.pointerId))head.releasePointerCapture(event.pointerId);if(cancel||!moved)return;if(target)manager.dock(record.id,target.dataset.areaId,edge);else{const r=root.getBoundingClientRect();if(last.clientX<r.left-12||last.clientX>r.right+12||last.clientY<r.top-12||last.clientY>r.bottom+12)manager.undock(record.id);}};
        const up=e=>{move(e);finish(false);},abort=()=>finish(true),key=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}},context=e=>{e.preventDefault();e.stopImmediatePropagation();finish(true);};global.addEventListener('pointermove',move);global.addEventListener('pointerup',up,{once:true});global.addEventListener('pointercancel',abort,{once:true});global.addEventListener('keydown',key);global.addEventListener('contextmenu',context,true);
      });
      head.addEventListener('dragstart',event=>{drag={manager,id:record.id};event.dataTransfer.setData('text/plain',JSON.stringify({showaveArea:record.id,manager:manager.id}));event.dataTransfer.effectAllowed='move';});
      head.addEventListener('dragend',()=>{drag=null;root.querySelectorAll('.ol-area-drop').forEach(e=>e.remove());});
      head.addEventListener('dblclick',event=>{if(!event.target.closest('button,select'))manager.maximize(record.id);});
      head.addEventListener('contextmenu',event=>{event.preventDefault();options(event);});box.append(head);
    }
    function walk(tree,fn,parent=null){if(!tree)return;fn(tree,parent);tree.children?.forEach(child=>walk(child,fn,tree));}
    function find(id){let result=null;walk(manager.tree,(node,parent)=>{if(node.id===id)result={node,parent};});return result;}
    manager.parentOf=id=>find(id)?.parent||null;
    manager.neighbors=id=>{const rows=areaRectangles(),source=rows.find(row=>row.id===id);return rows.filter(row=>row.id!==id&&adjacency(source,row)).map(row=>row.id);};
    manager.canJoin=(id,target)=>!!joinPlan(id,target);
    function replace(old,next){const found=find(old.id);if(!found)return false;if(found.parent)found.parent.children[found.parent.children.indexOf(old)]=next;else manager.tree=next;return true;}
    function remove(id){const found=find(id);if(!found)return null;if(!found.parent){manager.tree=null;return found.node;}const survivor=found.parent.children.find(child=>child!==found.node);const grand=findBranchParent(found.parent);if(grand)grand.children[grand.children.indexOf(found.parent)]=survivor;else manager.tree=survivor;return found.node;}
    function findBranchParent(branchNode){let parent=null;walk(manager.tree,(n,p)=>{if(n===branchNode)parent=p;});return parent;}
    function firstId(tree=manager.tree){if(!tree)return null;return tree.id||firstId(tree.children[0]);}
    function areaRectangles(){return [...root.querySelectorAll('.ol-area-slot')].map(slot=>({id:slot.dataset.areaId,rect:slot.getBoundingClientRect()})).filter(row=>row.rect.width>0&&row.rect.height>0);}
    function adjacency(a,b,complete=false){
      if(!a||!b)return false;const x=a.rect,y=b.rect,near=(u,v)=>Math.abs(u-v)<=1;
      const vertical=Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1,horizontal=Math.min(x.right,y.right)-Math.max(x.left,y.left)>1;
      const gap=(axis,u,v)=>v-u>=-1&&(v-u<=4||[...dividers.values()].some(({node,bar})=>{if(node.axis!==axis)return false;const r=bar.getBoundingClientRect();return near(r[axis==='row'?'left':'top'],u)&&near(r[axis==='row'?'right':'bottom'],v);}));
      if(vertical&&(gap('row',x.right,y.left)||gap('row',y.right,x.left))&&(!complete||near(x.top,y.top)&&near(x.bottom,y.bottom)))return 'row';
      if(horizontal&&(gap('column',x.bottom,y.top)||gap('column',y.bottom,x.top))&&(!complete||near(x.left,y.left)&&near(x.right,y.right)))return 'column';
      return false;
    }
    function rectangleTree(rows){
      if(rows.length===1)return leaf(rows[0].id);
      for(const axis of ['row','column']){const low=axis==='row'?'left':'top',high=axis==='row'?'right':'bottom';
        for(const cut of [...new Set(rows.map(row=>row.rect[high]))].sort((a,b)=>a-b)){
          const before=rows.filter(row=>row.rect[high]<=cut+.5),after=rows.filter(row=>row.rect[low]>cut+.5);
          if(!before.length||!after.length||before.length+after.length!==rows.length)continue;
          const end=Math.max(...before.map(row=>row.rect[high])),start=Math.min(...after.map(row=>row.rect[low]));
          if(start-end>4&&![...dividers.values()].some(({node,bar})=>{const r=bar.getBoundingClientRect();return node.axis===axis&&Math.abs(r[low]-end)<=1&&Math.abs(r[high]-start)<=1;}))continue;
          const first=rectangleTree(before),second=rectangleTree(after);if(!first||!second)continue;
          const a=end-Math.min(...before.map(row=>row.rect[low])),b=Math.max(...after.map(row=>row.rect[high]))-start;
          return branch(axis,[first,second],a/(a+b));
        }
      }return null;
    }
    function joinPlan(id,target){
      if(!find(id)||id===target)return null;const rows=areaRectangles(),source=rows.find(row=>row.id===id);if(!source)return null;
      const candidates=target?rows.filter(row=>row.id===target):rows.filter(row=>row.id!==id);
      for(const closing of candidates){if(!adjacency(source,closing,true))continue;const a=source.rect,b=closing.rect;
        const rect={left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)};
        const tree=rectangleTree(rows.filter(row=>row.id!==id&&row.id!==closing.id).concat({id,rect}));if(tree)return {tree,target:closing.id};
      }return null;
    }
    function areaAt(event){return areaRectangles().find(({rect:r})=>event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom);}
    function boundaryAreas(node,event){
      const rows=areaRectangles(),cross=node.axis==='row'?event.clientY:event.clientX,low=node.axis==='row'?'top':'left',high=node.axis==='row'?'bottom':'right';
      const choose=(child,edge)=>{const ids=treeIds(child);return rows.filter(row=>ids.has(row.id)).sort((a,b)=>{
        const distance=row=>Math.max(row.rect[low]-cross,0,cross-row.rect[high])*10000+(edge==='right'?-row.rect[node.axis==='row'?'right':'bottom']:row.rect[node.axis==='row'?'left':'top']);
        return distance(a)-distance(b);
      })[0]?.id;};
      const a=choose(node.children[0],'right'),b=choose(node.children[1],'left');return a&&b?[a,b]:null;
    }
    function interactionShield(){const shield=element('div','ol-area-interaction-shield');root.append(shield);return shield;}
    function splitGuide(shield,row,axis,ratio){shield.replaceChildren();if(!row)return;const bounds=root.getBoundingClientRect(),r=row.rect,guide=element('div','ol-area-guide');
      Object.assign(guide.style,axis==='row'?{left:(r.left-bounds.left+r.width*ratio)+'px',top:(r.top-bounds.top)+'px',width:'2px',height:r.height+'px'}:
        {left:(r.left-bounds.left)+'px',top:(r.top-bounds.top+r.height*ratio)+'px',width:r.width+'px',height:'2px'});shield.append(guide);}
    function joinGuide(shield,id,label){shield.replaceChildren();const row=areaRectangles().find(row=>row.id===id);if(!row)return;const bounds=root.getBoundingClientRect(),r=row.rect,guide=element('div','ol-area-join-preview',label||'Close this area');
      Object.assign(guide.style,{left:(r.left-bounds.left)+'px',top:(r.top-bounds.top)+'px',width:r.width+'px',height:r.height+'px'});shield.append(guide);}
    function positioning(shield,move,commit,keyAction){
      manager.cancelGesture?.();let done=false;
      const finish=cancel=>{if(done)return;done=true;shield.remove();global.removeEventListener('pointermove',move,true);global.removeEventListener('pointerdown',down,true);global.removeEventListener('keydown',key,true);global.removeEventListener('contextmenu',context,true);manager.cancelGesture=null;if(!cancel)commit();};
      const down=e=>{e.preventDefault();e.stopImmediatePropagation();if(e.button===0){move(e);finish(false);}else if(e.button===2)finish(true);};
      const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish(true);}else if(keyAction?.(e)){e.preventDefault();e.stopImmediatePropagation();}};
      const context=e=>{e.preventDefault();e.stopImmediatePropagation();finish(true);};
      manager.cancelGesture=()=>finish(true);global.addEventListener('pointermove',move,true);global.addEventListener('pointerdown',down,true);global.addEventListener('keydown',key,true);global.addEventListener('contextmenu',context,true);
    }
    manager.beginSplit=(id,axis='row')=>{if(!find(id)||manager.maximized)return false;let row=areaRectangles().find(row=>row.id===id),ratio=.5,last=null;const shield=interactionShield();
      const move=e=>{last=e;row=areaAt(e)||row;const r=row.rect;ratio=clamp(axis==='row'?(e.clientX-r.left)/r.width:(e.clientY-r.top)/r.height,.1,.9);splitGuide(shield,row,axis,ratio);};
      splitGuide(shield,row,axis,ratio);positioning(shield,move,()=>manager.split(row.id,axis,ratio),e=>{if(e.key!=='Tab')return false;axis=axis==='row'?'column':'row';if(last)move(last);else splitGuide(shield,row,axis,ratio);return true;});return true;};
    manager.beginJoin=(id,target)=>{const plan=joinPlan(id,target);if(!plan||manager.maximized)return false;const pair=[id,plan.target];let keep=id,close=plan.target;const shield=interactionShield();
      const move=e=>{const row=areaAt(e);if(row&&pair.includes(row.id)){close=row.id;keep=pair.find(item=>item!==close);}joinGuide(shield,close);};
      joinGuide(shield,close);positioning(shield,move,()=>manager.join(keep,close));return true;};
    // Keep panel browsing contexts attached at a stable place. Reparenting an
    // iframe reloads it in Chromium, so only the lightweight split tree moves.
    function position(){
      const bounds=root.getBoundingClientRect(),shown=new Set();
      root.querySelectorAll('.ol-area-slot').forEach(slot=>{const record=records.get(slot.dataset.areaId);if(!record)return;const r=slot.getBoundingClientRect();shown.add(record.id);Object.assign(record.element.style,{position:'absolute',left:(r.left-bounds.left)+'px',top:(r.top-bounds.top)+'px',width:r.width+'px',height:r.height+'px',visibility:'visible',pointerEvents:''});});
      records.forEach(record=>{record.element.style.opacity='';if(!shown.has(record.id))Object.assign(record.element.style,{position:'absolute',left:record.popup?'0':'-20000px',top:'0',width:'960px',height:'640px',visibility:record.popup?'visible':'hidden',opacity:record.popup?'.0001':'',pointerEvents:'none'});});
      records.forEach(record=>{record.element.inert=!shown.has(record.id)||!!manager.maximized&&record.id!==manager.maximized;});
      if(manager.maximized){records.forEach(record=>{if(record.id!==manager.maximized)record.element.style.visibility='hidden';});const record=records.get(manager.maximized);if(record)Object.assign(record.element.style,{left:'0',top:'0',width:'100%',height:'100%'});}
      manager.onPosition?.();
    }
    manager.refreshGeometry=position;
    manager.setMinimumHeight=(typeId,height)=>{const type=types.get(typeId);if(!type||type.minHeight===height)return false;type.minHeight=height;
      if(options.constrainMinHeight){root.querySelectorAll('.ol-area-slot').forEach(slot=>slot.style.minHeight=minimum(leaf(slot.dataset.areaId),'column')+'px');dividers.forEach(({node,box})=>box.style.minHeight=minimum(node,'column')+'px');}return true;};
    function paint(){
      if(manager.focused&&manager.maximized!==manager.focused)clearFocus();
      manager.splitTree?.remove();
      dividers.clear();
      records.forEach(record=>{if(record.element.parentNode!==root)root.append(record.element);record.element.classList.toggle('ol-area-primary-grid',record.defaultType==='show-grid'&&record.type==='show-grid');record.element.dataset.areaState=record.popup?'window':find(record.id)?'docked':'hidden';});
      function build(node){if(node.id){const slot=element('div','ol-area-slot');slot.dataset.areaId=node.id;const minWidth=types.get(records.get(node.id)?.type)?.minWidth;if(minWidth)slot.style.minWidth=minWidth+'px';if(options.constrainMinHeight)slot.style.minHeight=minimum(node,'column')+'px';return slot;}const box=element('div','ol-area-branch');box.style.flexDirection=node.axis;if(options.constrainMinHeight)box.style.minHeight=minimum(node,'column')+'px';const left=build(node.children[0]),right=build(node.children[1]);left.style.flex=node.ratio+' 1 0';right.style.flex=(1-node.ratio)+' 1 0';const bar=element('div','ol-area-split');bar.dataset.axis=node.axis;bar.tabIndex=0;bar.role='separator';bar.setAttribute('aria-label','Resize areas');bar.setAttribute('aria-orientation',node.axis==='row'?'vertical':'horizontal');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',Math.round(node.ratio*100));
        dividers.set(node,{node,box,left,right,bar});bar.addEventListener('pointerdown',event=>resize(node,box,left,right,bar,event));
        bar.addEventListener('keydown',event=>{const keys=node.axis==='row'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];if(!keys.includes(event.key))return;event.preventDefault();const bounds=box.getBoundingClientRect(),divider=bar.getBoundingClientRect(),size=node.axis==='row'?bounds.width-divider.width:bounds.height-divider.height;if(size<=0)return;node.ratio=clamp(node.ratio+(event.key===keys[0]?-.025:.025),Math.min(.45,minimum(node.children[0],node.axis)/size),1-Math.min(.45,minimum(node.children[1],node.axis)/size));paint();});
        bar.addEventListener('contextmenu',event=>{event.preventDefault();const pair=boundaryAreas(node,event);if(pair)showMenu(manager,pair[0],event.clientX,event.clientY,doc,null,pair[1]);});box.append(left,bar,right);return box;}
      manager.splitTree=element('div','ol-area-tree');
      if(manager.tree)manager.splitTree.append(build(manager.tree));else {const empty=element('div','ol-area-empty'),label=element('span','','Panels are in separate windows.'),button=element('button','','Add or dock a panel');button.type='button';button.addEventListener('click',event=>manager.openPanelPicker(event.currentTarget));empty.append(label,button);manager.splitTree.append(empty);}root.prepend(manager.splitTree);
      root.classList.toggle('ol-area-max',!!manager.maximized);records.forEach(record=>record.element.classList.toggle('ol-area-maximized',record.id===manager.maximized));
      root.classList.toggle('ol-area-focus-root',!!manager.focused);focusExit.hidden=!manager.focused;records.forEach(record=>record.element.classList.toggle('ol-area-focused',record.id===manager.focused));
      position();
      global.dispatchEvent(new CustomEvent('showave:areas-changed',{detail:{id:manager.id}}));
    }
    function minimum(node,axis){if(node.id){const type=types.get(records.get(node.id)?.type);return axis==='row'?(type?.minWidth||90):(type?.minHeight||65);}const divider=dividers.get(node)?.bar.getBoundingClientRect(),gap=divider?divider[axis==='row'?'width':'height']:2;return node.axis===axis?minimum(node.children[0],axis)+minimum(node.children[1],axis)+gap:Math.max(minimum(node.children[0],axis),minimum(node.children[1],axis));}
    function resize(node,box,left,right,bar,event){
      if(event.button!==0)return;event.preventDefault();manager.cancelGesture?.();const coordinate=e=>node.axis==='row'?e.clientX:e.clientY,start=coordinate(event),primary=bar.getBoundingClientRect(),crossLow=node.axis==='row'?'top':'left',crossHigh=node.axis==='row'?'bottom':'right';
      const center=r=>node.axis==='row'?(r.left+r.right)/2:(r.top+r.bottom)/2;
      const candidates=[...dividers.values()].filter(row=>row.node.axis===node.axis).map(row=>{const bounds=row.box.getBoundingClientRect(),r=row.bar.getBoundingClientRect(),size=(node.axis==='row'?bounds.width-r.width:bounds.height-r.height);
        return {...row,bounds: r,size,original:row.node.ratio,lo:Math.min(.45,minimum(row.node.children[0],node.axis)/size),hi:1-Math.min(.45,minimum(row.node.children[1],node.axis)/size)};});
      const group=candidates.filter(row=>Math.abs(center(row.bounds)-center(primary))<=4),rows=[group.find(row=>row.node===node)];
      for(let i=0;i<rows.length;i++)for(const candidate of group)if(!rows.includes(candidate)&&candidate.bounds[crossLow]<=rows[i].bounds[crossHigh]+8&&candidate.bounds[crossHigh]>=rows[i].bounds[crossLow]-8)rows.push(candidate);
      bar.setPointerCapture?.(event.pointerId);
      let finished=false;const move=e=>{const moving=e.shiftKey?rows:[rows[0]],first=rows[0];let delta=coordinate(e)-start;if(e.ctrlKey)delta=(Math.round((first.original+delta/first.size)*10)/10-first.original)*first.size;
        delta=clamp(delta,Math.max(...moving.map(row=>(row.lo-row.original)*row.size)),Math.min(...moving.map(row=>(row.hi-row.original)*row.size)));
        for(const row of moving){row.node.ratio=row.original+delta/row.size;row.left.style.flex=row.node.ratio+' 1 0';row.right.style.flex=(1-row.node.ratio)+' 1 0';row.bar.setAttribute('aria-valuenow',Math.round(row.node.ratio*100));}position();};
      const finish=cancel=>{if(finished)return;finished=true;global.removeEventListener('pointermove',move);global.removeEventListener('pointerup',up);global.removeEventListener('pointercancel',abort);global.removeEventListener('keydown',key);global.removeEventListener('contextmenu',context,true);if(bar.hasPointerCapture?.(event.pointerId))bar.releasePointerCapture(event.pointerId);if(cancel)for(const row of rows)row.node.ratio=row.original;manager.cancelGesture=null;paint();};
      const up=e=>{move(e);finish(false);},abort=()=>finish(true),key=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}},context=e=>{e.preventDefault();e.stopImmediatePropagation();finish(true);};manager.cancelGesture=()=>finish(true);
      global.addEventListener('pointermove',move);global.addEventListener('pointerup',up,{once:true});global.addEventListener('pointercancel',abort,{once:true});global.addEventListener('keydown',key);global.addEventListener('contextmenu',context,true);
    }
    function cornerDrag(record,event){
      if(event.button!==0||manager.maximized)return;event.preventDefault();manager.cancelGesture?.();const handle=event.currentTarget;handle.setPointerCapture?.(event.pointerId);const origin={x:event.clientX,y:event.clientY},row=areaRectangles().find(row=>row.id===record.id),rect=row.rect,shield=interactionShield();let direction='row',ratio=.5,target=null,moved=false,finished=false;
      const move=e=>{moved=Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>12;target=areaAt(e);shield.replaceChildren();if(!moved)return;
        direction=Math.abs(e.clientX-origin.x)>Math.abs(e.clientY-origin.y)?'row':'column';ratio=clamp(direction==='row'?(e.clientX-rect.left)/rect.width:(e.clientY-rect.top)/rect.height,.1,.9);
        if(event.shiftKey){joinGuide(shield,record.id,'Duplicate into new window');return;}
        if(target&&target.id!==record.id){if(event.ctrlKey)joinGuide(shield,target.id,'Swap editor contents');else if(manager.canJoin(record.id,target.id))joinGuide(shield,target.id);}
        else if(target?.id===record.id&&!event.ctrlKey)splitGuide(shield,row,direction,ratio);
      };
      const finish=cancel=>{if(finished)return;finished=true;shield.remove();global.removeEventListener('pointermove',move);global.removeEventListener('pointerup',up);global.removeEventListener('keydown',key);global.removeEventListener('pointercancel',abort);global.removeEventListener('contextmenu',context);if(handle.hasPointerCapture?.(event.pointerId))handle.releasePointerCapture(event.pointerId);manager.cancelGesture=null;if(cancel)return;if(!moved){showMenu(manager,record.id,origin.x,origin.y,doc,handle);return;}
        if(event.shiftKey)manager.duplicateWindow(record.id);else if(target&&target.id!==record.id){if(event.ctrlKey)manager.dock(record.id,target.id,'center');else manager.join(record.id,target.id);}else if(target?.id===record.id&&!event.ctrlKey)manager.split(record.id,direction,ratio);};
      const up=e=>{move(e);finish(false);},abort=()=>finish(true),key=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}},context=e=>{e.preventDefault();finish(true);};manager.cancelGesture=()=>finish(true);
      global.addEventListener('pointermove',move);global.addEventListener('pointerup',up,{once:true});global.addEventListener('pointercancel',abort,{once:true});global.addEventListener('keydown',key);global.addEventListener('contextmenu',context);
    }
    function edgeAt(box,event){const r=box.getBoundingClientRect(),x=(event.clientX-r.left)/r.width,y=(event.clientY-r.top)/r.height;if(x>.25&&x<.75&&y>.25&&y<.75)return 'center';const distances={left:x,right:1-x,top:y,bottom:1-y};return Object.keys(distances).sort((a,b)=>distances[a]-distances[b])[0];}
    function insert(id,target,edge='right',ratio=.5){if(!manager.tree){manager.tree=leaf(id);return true;}const hit=find(target||firstId());if(!hit)return false;const axis=['left','right'].includes(edge)?'row':'column';const leading=['left','top'].includes(edge);return replace(hit.node,branch(axis,leading?[leaf(id),hit.node]:[hit.node,leaf(id)],ratio));}
    // Keep the complete split tree while panels are away. A sibling reference
    // alone loses nested splits when several siblings leave and return in a
    // different order. Project this tree onto the panels currently docked.
    // Deliberate layout edits retire it and retain each panel's local home.
    let returnTree=null;
    function treeIds(tree){const ids=new Set();walk(tree,node=>{if(node.id)ids.add(node.id);});return ids;}
    function projectTree(tree,ids,links){
      if(!tree)return null;if(tree.id)return ids.has(tree.id)?leaf(tree.id):null;
      const children=tree.children.map(child=>projectTree(child,ids,links));
      if(!children[0]||!children[1])return children[0]||children[1];
      const projected=branch(tree.axis,children,tree.ratio);links?.set(projected,tree);return projected;
    }
    function rememberReturnRatios(){
      if(!returnTree)return;const links=new Map(),projected=projectTree(returnTree,treeIds(manager.tree),links);
      const sync=(saved,current)=>{if(!saved||!current||saved.id||current.id||saved.axis!==current.axis)return;links.get(saved).ratio=current.ratio;sync(saved.children[0],current.children[0]);sync(saved.children[1],current.children[1]);};
      sync(projected,manager.tree);
    }
    function rememberHome(record){const hit=find(record.id);if(!hit)return;rememberReturnRatios();if(!returnTree)returnTree=copy(manager.tree);const parent=hit.parent,sibling=parent?.children.find(child=>child!==hit.node),leading=parent?.children[0]===hit.node;record.home={target:sibling?firstId(sibling):null,sibling,axis:parent?.axis,ratio:parent?.ratio,edge:parent?(parent.axis==='row'?(leading?'left':'right'):(leading?'top':'bottom')):'right'};}
    function restoreHome(record,target,edge){
      if(!target&&!edge&&returnTree){
        rememberReturnRatios();const shown=treeIds(manager.tree),saved=treeIds(returnTree);shown.add(record.id);
        if([...shown].every(id=>saved.has(id))){manager.tree=projectTree(returnTree,shown);if(shown.size===saved.size)returnTree=null;return true;}
        returnTree=null;
      }else if(target||edge)returnTree=null;
      const home=record.home,sibling=home?.sibling;let present=false;walk(manager.tree,node=>{if(node===sibling)present=true;});
      if(!target&&!edge&&present){const leading=['left','top'].includes(home.edge),restored=branch(home.axis,leading?[leaf(record.id),sibling]:[sibling,leaf(record.id)],home.ratio),parent=findBranchParent(sibling);if(parent)parent.children[parent.children.indexOf(sibling)]=restored;else manager.tree=restored;return true;}
      return insert(record.id,find(target)?.node.id||find(home?.target)?.node.id||firstId(),edge||(target?'right':home?.edge)||'right',!target?home?.ratio??.5:.5);
    }
    function completePopupReturn(record,pending){
      if(pending.popup.closed){pending.dispose?.();pending.dispose=null;if(record.returningPopup===pending)record.returningPopup=null;return;}
      if(pending.promise)return;
      pending.promise=Promise.resolve().then(()=>pending.returnToOwner({manager:manager.id,area:record.id})).then(()=>{
        pending.dispose?.();if(record.returningPopup===pending)record.returningPopup=null;
        try{if(!pending.popup.closed)pending.popup.close();}catch(_){}
      },error=>{
        pending.promise=null;const message=error?.message||'The main workspace window could not be restored. Choose Dock again to retry.';
        notice(message);
        try{const view=element('p','ol-area-status',message,pending.popup.document);view.role='status';pending.popup.document.body.append(view);setTimeout(()=>view.remove(),6000);}catch(_){}
      });
    }
    function retirePopup(record){
      clearInterval(record.poll);record.poll=null;const dispose=record.popupDispose;record.popupDispose=null;
      const popup=record.popup;record.popup=null;
      if(!popup||popup.closed){dispose?.();return;}
      let returnToOwner;
      try{returnToOwner=popup.OpenLiveDesktop?.panelWindows?.returnToOwner||global.OpenLiveDesktop?.panelWindows?.returnToOwner;}catch(_){}
      if(typeof returnToOwner==='function'){
        record.returningPopup={popup,dispose,returnToOwner,promise:null};completePopupReturn(record,record.returningPopup);
      }else{dispose?.();popup.close();}
    }
    manager.panels=()=>[...records.values()].map(record=>({id:record.id,type:record.type,title:types.get(record.type).title,state:record.popup?'window':find(record.id)?'docked':'hidden',default:!!record.defaultType}));
    manager.canHide=id=>{const record=records.get(id);return !!record&&(!!record.popup||!!find(id)?.parent);};
    manager.hide=id=>{const record=records.get(id);if(!record)return false;if(!find(id)&&!record.popup)return true;if(!manager.canHide(id)){notice('Keep one panel in the workspace. Add another panel before hiding this one.');return false;}rememberHome(record);if(record.popup)retirePopup(record);remove(id);manager.maximized=null;paint();return true;};
    manager.reopen=(id,target,edge)=>{const record=records.get(id);if(!record)return false;if(record.popup){if(record.popup.closed)return manager.redock(id,target,edge);record.popup.focus();return true;}if(find(id))return true;if(!restoreHome(record,target,edge))return false;manager.maximized=null;paint();return true;};
    manager.openPanelPicker=anchor=>{
      closeMenu(false);const owner=anchor?.ownerDocument||doc,view=owner.defaultView,picker=element('div','ol-area-menu ol-area-panel-picker',null,owner);menu=picker;picker.role='dialog';picker.setAttribute('aria-label','Workspace panels');picker._returnFocus=anchor;anchor?.setAttribute('aria-expanded','true');
      const heading=element('div','ol-area-picker-heading',null,owner),title=element('strong','','Panels',owner),close=element('button','',null,owner);close.append(controlIcon('close',owner));close.type='button';close.title='Close panel picker';close.setAttribute('aria-label','Close panel picker');close.addEventListener('click',()=>closeMenu());heading.append(title,close);
      const search=element('input','ol-area-picker-search',null,owner);search.type='search';search.placeholder='Find a panel…';search.setAttribute('aria-label','Find a panel');
      const bulk=element('div','ol-area-picker-bulk',null,owner),undockAll=element('button','','Undock all panels',owner),dockAll=element('button','','Dock all panels',owner),bulkStatus=element('p','ol-area-picker-help',null,owner);
      undockAll.prepend(controlIcon('undock',owner));dockAll.prepend(controlIcon('dock',owner));
      undockAll.type=dockAll.type='button';undockAll.dataset.areaAction='undock-all';dockAll.dataset.areaAction='dock-all';bulkStatus.setAttribute('role','status');bulkStatus.hidden=true;bulk.append(undockAll,dockAll);
      undockAll.addEventListener('click',()=>{
        const panels=manager.panels().filter(panel=>panel.state==='docked');let opened=0;
        for(const panel of panels){if(!manager.undock(panel.id))break;opened++;}
        bulkStatus.hidden=false;bulkStatus.textContent=opened===panels.length?'Opened '+opened+' panel'+(opened===1?'':'s')+' in separate windows.':
          'Opened '+opened+' of '+panels.length+' panels. The browser blocked a window; remaining panels stayed in the workspace. Allow popups, then try again.';
        refresh();
      });
      dockAll.addEventListener('click',()=>{
        const panels=manager.panels().filter(panel=>panel.state==='window');let docked=0;
        for(const panel of panels)if(manager.redock(panel.id))docked++;
        bulkStatus.hidden=false;bulkStatus.textContent='Docked '+docked+' panel'+(docked===1?'':'s')+' into this workspace.';refresh();
      });
      const help=element('p','ol-area-picker-help','Hide keeps your work. Show or Dock brings it back.',owner),list=element('div','ol-area-picker-list',null,owner);list.role='list';
      const action=(row,label,text,fn,id,disabled=false)=>{const b=element('button','',id==='show'?text:null,owner);if(id!=='show')b.append(controlIcon(id,owner));b.type='button';b.title=label;b.setAttribute('aria-label',label);b.dataset.areaAction=id;b.disabled=disabled;b.addEventListener('click',()=>{const recordId=row.dataset.areaId;fn();const next=picker.querySelector('[data-area-id="'+recordId+'"] button:not(:disabled)');(next||search).focus({preventScroll:true});});row.append(b);};
      const refresh=()=>{if(menu!==picker)return;const panels=manager.panels();undockAll.disabled=!panels.some(panel=>panel.state==='docked');dockAll.disabled=!panels.some(panel=>panel.state==='window');list.replaceChildren();const query=search.value.trim().toLocaleLowerCase();panels.filter(panel=>panel.title.toLocaleLowerCase().includes(query)).forEach(panel=>{const row=element('div','ol-area-picker-row',null,owner);row.role='listitem';row.dataset.areaId=panel.id;row.dataset.areaState=panel.state;const label=element('div','ol-area-picker-label',null,owner),name=element('span','',panel.title,owner),state=element('small','',panel.state==='docked'?'In workspace':panel.state==='window'?'Separate window':'Hidden',owner);label.append(name,state);row.append(label);
        if(panel.state==='hidden')action(row,'Show '+panel.title,'Show',()=>manager.reopen(panel.id),'show');
        else if(panel.state==='window')action(row,'Dock '+panel.title+' into workspace','↙',()=>manager.redock(panel.id),'dock');
        else action(row,'Undock '+panel.title+' into a window','↗',()=>manager.undock(panel.id),'undock');
        if(panel.state!=='hidden')action(row,'Hide '+panel.title,'×',()=>manager.hide(panel.id),'hide',!manager.canHide(panel.id));
        action(row,panel.title+' options','⋮',()=>{const b=row.querySelector('[data-area-action=options]'),r=b.getBoundingClientRect();showMenu(manager,panel.id,r.left,r.bottom,owner,anchor);},'options');list.append(row);
      });if(!list.childElementCount)list.append(element('p','ol-area-picker-help','No matching panels.',owner));};
      search.addEventListener('input',refresh);
      const add=element('div','ol-area-picker-add',null,owner),select=element('select','',null,owner),addButton=element('button','','Add',owner);addButton.prepend(controlIcon('plus',owner));select.setAttribute('aria-label','New panel type');types.forEach(type=>{const option=element('option','',type.title,owner);option.value=type.id;select.append(option);});addButton.type='button';addButton.setAttribute('aria-label','Add selected panel');addButton.addEventListener('click',()=>{manager.create(select.value,active?.manager===manager&&find(active.id)?active.id:undefined);search.value='';refresh();search.focus();});add.append(select,addButton);
      const reset=element('button','ol-area-picker-reset','Reset layout · removes added panels',owner);reset.prepend(controlIcon('reset',owner));reset.type='button';reset.addEventListener('click',()=>{closeMenu();manager.reset();});picker.append(heading,bulk,bulkStatus,search,help,list,add,reset);owner.body.append(picker);watchMenu(picker);const dispose=picker._dispose,changed=event=>{if(event.detail?.id===manager.id)refresh();},routeChanged=()=>{if(menu===picker)closeMenu(false);};global.addEventListener('showave:areas-changed',changed);view.addEventListener('showave:workspace-changed',routeChanged);picker._dispose=()=>{dispose();global.removeEventListener('showave:areas-changed',changed);view.removeEventListener('showave:workspace-changed',routeChanged);anchor?.setAttribute('aria-expanded','false');};refresh();
      const bounds=anchor?.getBoundingClientRect()||{left:16,bottom:36};picker.style.left=clamp(bounds.left,4,Math.max(4,view.innerWidth-picker.offsetWidth-4))+'px';picker.style.top=clamp(bounds.bottom+4,4,Math.max(4,view.innerHeight-picker.offsetHeight-4))+'px';search.focus({preventScroll:true});return picker;
    };
    manager.create=(type,target,edge='right')=>{const record=makeRecord(type);if(!record)return null;if(!insert(record.id,target,edge)){record.dispose?.();record.element.remove();records.delete(record.id);return null;}returnTree=null;paint();return record.id;};
    function copyEditorState(record,fresh){if(record.type==='notes'){const original=record.content.querySelector('textarea'),duplicate=fresh.content.querySelector('textarea');if(original&&duplicate)duplicate.value=original.value;}}
    manager.duplicate=id=>{const record=records.get(id);if(!record)return null;const fresh=makeRecord(record.type,record.source);copyEditorState(record,fresh);if(record.source&&!fresh.original)fresh.mirrored=true;if(!insert(fresh.id,find(id)?id:firstId()))return null;returnTree=null;paint();return fresh.id;};
    manager.split=(id,axis='row',ratio=.5)=>{const record=records.get(id);if(!record||!find(id))return null;const fresh=makeRecord(record.type,record.source);copyEditorState(record,fresh);if(!replace(find(id).node,branch(axis,[leaf(id),leaf(fresh.id)],clamp(ratio,.1,.9))))return null;returnTree=null;paint();return fresh.id;};
    function release(record){
      if(!record)return;
      if(record.popup)manager.redock(record.id);
      record.dispose?.();record.dispose=null;
      if(record.original&&record.source)parking.append(record.source);
      record.element.remove();records.delete(record.id);
    }
    manager.join=(id,target)=>{const plan=joinPlan(id,target);if(!plan)return false;
      // A join changes rectangles, never the original editor/control owners.
      // Rebuild only valid rectangular partitions; hidden editors remain restorable.
      rememberHome(records.get(plan.target));manager.tree=plan.tree;manager.maximized=null;paint();return true;};
    manager.swap=(id,target)=>{const hit=find(id),sibling=hit?.parent?.children.find(child=>child!==hit.node);target=target||sibling?.id||manager.neighbors(id)[0];return target?manager.dock(id,target,'center'):false;};
    manager.dock=(id,target,edge='right')=>{if(id===target||!records.has(id)||!find(target))return false;if(records.get(id).popup)return manager.redock(id,target,edge);const source=find(id);if(!source)return false;returnTree=null;if(edge==='center'){const dest=find(target);source.node.id=target;dest.node.id=id;}else{remove(id);insert(id,target,edge);}manager.maximized=null;paint();return true;};
    manager.changeType=(id,type)=>{const record=records.get(id);if(!record||!types.has(type))return false;if(record.original&&record.source)parking.append(record.source);record.type=type;record.element.dataset.areaType=type;record.element.querySelector('.ol-area-header').dataset.areaType=type;record.source=types.get(type).element||null;record.original=false;record.mirrored=false;loadContent(record);record.element.querySelector('select').value=type;paint();return true;};
    function clearFocus(){if(!manager.focused)return;manager.focused=null;if(focusedManager===manager)focusedManager=null;root.classList.remove('ol-area-focus-root');focusExit.hidden=true;
      try{if(global.frameElement)global.OpenLiveWorkspaceHost?.setAreaFocus?.(false);}catch(_){} }
    manager.exitFocus=()=>{if(!manager.focused)return false;const previous=manager.beforeFocus;clearFocus();manager.maximized=previous&&find(previous)?previous:null;paint();return true;};
    manager.focus=id=>{if(!find(id))return false;manager.cancelGesture?.();if(manager.focused===id)return manager.exitFocus();focusedManager?.exitFocus();manager.beforeFocus=manager.maximized;manager.focused=id;manager.maximized=id;focusedManager=manager;
      try{if(global.frameElement)global.OpenLiveWorkspaceHost?.setAreaFocus?.(true);}catch(_){}paint();return true;};
    manager.maximize=id=>{if(!find(id))return false;if(manager.focused)clearFocus();manager.maximized=manager.maximized===id?null:id;paint();return true;};
    manager.undock=id=>{const record=records.get(id);if(!record)return null;if(record.returningPopup){if(!record.returningPopup.popup.closed){record.returningPopup.popup.focus();completePopupReturn(record,record.returningPopup);return record.returningPopup.popup;}completePopupReturn(record,record.returningPopup);}if(record.popup&&!record.popup.closed){record.popup.focus();return record.popup;}const rect=record.element.getBoundingClientRect(),size=record.popupSize||rect;
      const width=Math.max(320,Math.round(size.width)),height=Math.max(240,Math.round(size.height));
      const popup=global.open('area-window.html?manager='+encodeURIComponent(manager.id)+'&area='+encodeURIComponent(id),'showave_'+manager.id+'_'+id,`popup=yes,width=${width},height=${height}`);if(!popup){notice('The browser blocked the area window. Allow popups to undock.');return null;}
      record.popup=popup;rememberHome(record);remove(id);manager.maximized=null;paint();record.poll=setInterval(()=>{if(popup.closed)manager.redock(id);},400);return popup;};
    function contains(node,id){return node.id===id||node.children?.some(child=>contains(child,id));}
    manager.redock=(id,target,edge)=>{const record=records.get(id);if(record?.returningPopup){completePopupReturn(record,record.returningPopup);return true;}if(!record?.popup)return false;retirePopup(record);if(!find(id))restoreHome(record,target,edge);paint();return true;};
    manager.duplicateWindow=id=>{const duplicate=manager.duplicate(id);return duplicate?manager.undock(duplicate):null;};
    manager.mountWindow=(id,popup)=>{const record=records.get(id);if(!record||record.popup!==popup)return false;record.popupDispose?.();record.popupDispose=null;
      const disposeAppearance=windowAppearance(popup),rememberSize=()=>{
        if(popup.closed)return;const width=popup.innerWidth,height=popup.innerHeight;
        if(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0)record.popupSize={width,height};
      };
      rememberSize();popup.addEventListener('resize',rememberSize);
      popup.document.title='SHOWAVE: '+types.get(record.type).title;const box=element('section','ol-area',null,popup.document);header(record,box,popup.document,true);const content=element('div','ol-area-content',null,popup.document);box.append(content);popup.document.body.replaceChildren(box);
      let disposeContent;
      if(record.type==='phone-mirror'&&global.OpenLivePhoneMirror){const style=element('link','',null,popup.document);style.rel='stylesheet';style.href=new URL('openlive-phone-mirror.css',global.location.href).href;popup.document.head.append(style);const handle=global.OpenLivePhoneMirror.build(content);disposeContent=()=>{handle.destroy();style.remove();};}
      else disposeContent=mirror(record.source||record.content,content);
      record.popupDispose=()=>{rememberSize();popup.removeEventListener('resize',rememberSize);disposeContent?.();disposeAppearance();};return true;};
    manager.snapshot=()=>({tree:copy(manager.tree),maximized:manager.maximized});
    manager.restore=snapshot=>{let valid=!!snapshot?.tree;const seen=new Set();walk(snapshot?.tree,node=>{if(node.id){if(!records.has(node.id)||seen.has(node.id)||records.get(node.id).popup)valid=false;seen.add(node.id);}else if(!['row','column'].includes(node.axis)||node.children?.length!==2||!Number.isFinite(node.ratio)||node.ratio<=0||node.ratio>=1)valid=false;});if(!valid)return false;clearFocus();returnTree=null;manager.tree=copy(snapshot.tree);manager.maximized=seen.has(snapshot.maximized)?snapshot.maximized:null;paint();return true;};
    const defaultIds=new Map();types.forEach(type=>{if(type.element){const record=makeRecord(type.id);record.defaultType=type.id;defaultIds.set(type.id,record.id);}});
    function initial(node){if(typeof node==='string')return leaf(defaultIds.get(node));return branch(node.axis,node.children.map(initial),node.ratio??.5);}
    manager.tree=options.tree?initial(options.tree):[...defaultIds.values()].map(leaf).reduce((a,b)=>a?branch('row',[a,b]):b,null);
    const originalTree=copy(manager.tree);
    manager.reset=()=>{[...records.values()].forEach(record=>{if(record.popup)manager.redock(record.id);if(!record.defaultType)release(record);else if(record.type!==record.defaultType)manager.changeType(record.id,record.defaultType);});returnTree=null;manager.tree=copy(originalTree);manager.maximized=null;paint();};
    new ResizeObserver(position).observe(root);global.addEventListener('resize',position);paint();return manager;
  }

  function phoneType(){return {id:'phone-mirror',title:'Phone Mirror',build:host=>global.OpenLivePhoneMirror?.build(host)||(()=>{host.append(element('p','','Phone Mirror is loading.'));})()};}
  function notesType(){return {id:'notes',title:'Notes',build:host=>{const text=element('textarea','ol-area-notes');text.setAttribute('aria-label','Area notes');text.placeholder='Show notes…';host.append(text);}};}
  function installShowRowAlignment(manager){
    const layers=doc.getElementById('layers'),grid=doc.getElementById('gridCol');
    if(!layers||!grid)return;
    let pending=0,insetHost=null,linked=false,stopped=false;
    const flag=value=>[layers,grid].forEach(node=>{const text=String(value);if(node.dataset.showaveRowScrollLinked!==text)node.dataset.showaveRowScrollLinked=text;});
    flag(false);
    function originalPanel(node,type){
      const box=node.closest('.ol-area'),record=box&&manager.records.get(box.dataset.areaId);
      return record?.original&&record.type===type&&box.dataset.areaState==='docked'&&manager.root.contains(box)?record:null;
    }
    function update(){
      pending=0;if(stopped)return;
      const left=originalPanel(layers,'layers'),right=originalPanel(grid,'show-grid');
      let aligned=false;
      let sharedHeader=null;
      if(left&&right&&!manager.maximized){
        const a=left.element.getBoundingClientRect(),b=right.element.getBoundingClientRect();
        const gap=Math.max(a.left,b.left)-Math.min(a.right,b.right);
        // A shared row view is meaningful only for adjacent, equally tall
        // visible originals. Arbitrarily moved panels and popups scroll alone.
        aligned=a.width>0&&a.height>0&&b.width>0&&b.height>0&&gap>=-1&&gap<=7&&
          Math.abs(a.top-b.top)<=1&&Math.abs(a.bottom-b.bottom)<=1;
        if(aligned&&right.element.classList.contains('ol-area-primary-grid'))sharedHeader=left.element;
      }
      manager.records.forEach(record=>record.element.classList.toggle('ol-area-shared-layer-row',record.element===sharedHeader));
      if(left&&right&&aligned){
        const ah=left.element.querySelector(':scope>.ol-area-header').getBoundingClientRect(),bh=right.element.querySelector(':scope>.ol-area-header').getBoundingClientRect();
        aligned=Math.abs(ah.top-bh.top)<=1&&Math.abs(ah.bottom-bh.bottom)<=1;
        // Below the shared header there must be room for real rows. Otherwise
        // a zero-height Layers viewport cannot absorb another inset, and
        // repeated measurements would add the same deficit indefinitely.
        const rowOffset=layers.getBoundingClientRect().top-grid.getBoundingClientRect().top;
        aligned=aligned&&grid.clientHeight>Math.max(0,rowOffset)+1;
      }
      const host=aligned?left.content:null;
      if(insetHost&&insetHost!==host)insetHost.style.removeProperty('--ol-layers-bottom-inset');
      insetHost=host;
      let insetChanged=false;
      if(host){
        const old=parseFloat(host.style.getPropertyValue('--ol-layers-bottom-inset'))||0;
        const footer=left.source.querySelector('.ol-show-layer-footer');
        const reserved=footer?.getBoundingClientRect().height||0;
        const leftBounds=layers.getBoundingClientRect(),rightBounds=grid.getBoundingClientRect();
        const leftBottom=leftBounds.top+layers.clientTop+layers.clientHeight;
        const rightBottom=rightBounds.top+grid.clientTop+grid.clientHeight;
        // Let useful footer controls occupy the alignment space. Measure its
        // actual height, including the natural minimum, to avoid counting the
        // same deficit repeatedly. The original-only property stays outside
        // the source so independent windows use their natural footer height.
        const inset=Math.max(0,Math.round(leftBottom+reserved-rightBottom));
        insetChanged=Math.abs(old-inset)>.5;
        if(insetChanged)host.style.setProperty('--ol-layers-bottom-inset',inset+'px');
      }
      flag(aligned);
      if(aligned&&(!linked||insetChanged))layers.scrollTop=grid.scrollTop;
      linked=aligned;
    }
    const schedule=()=>{if(!stopped&&!pending)pending=global.requestAnimationFrame(update);};
    const changed=event=>{if(event.detail?.id===manager.id)update();};
    const observer=new ResizeObserver(schedule);
    [manager.root,layers,grid].forEach(node=>observer.observe(node));
    global.addEventListener('showave:areas-changed',changed);
    global.addEventListener('resize',schedule);
    const dispose=()=>{stopped=true;observer.disconnect();if(pending)global.cancelAnimationFrame(pending);global.removeEventListener('showave:areas-changed',changed);global.removeEventListener('resize',schedule);insetHost?.style.removeProperty('--ol-layers-bottom-inset');flag(false);};
    global.addEventListener('pagehide',dispose,{once:true});
    update();return dispose;
  }
  function installShow(){
    const top=doc.getElementById('topArea'),bottom=doc.getElementById('bottom'),left=doc.getElementById('leftCol');if(!top||!bottom||!left)return;
    // The source rail mounts after the areas. Reserve its declared width now
    // so the default Layers panel fits every control when the rail appears.
    const railWidth=parseFloat(global.getComputedStyle(doc.body).getPropertyValue('--showave-rail-width'))||0;
    const layersRatio=Math.max(.15,Math.min(.7,left.getBoundingClientRect().width/Math.max(1,top.getBoundingClientRect().width-railWidth-5)));
    const layers=element('div','ol-show-layers');layers.append(left);
    const footer=element('div','ol-show-layer-footer'),crossfader=doc.querySelector('#xfRow>.xf-left');
    footer.setAttribute('role','group');footer.setAttribute('aria-label','Show crossfader and history');
    if(crossfader)footer.append(crossfader);
    const history=element('div','ol-show-layer-actions'),historyLabel=element('span','','Show history');history.append(historyLabel);
    ['bUndo','bRedo'].forEach(id=>{const button=doc.getElementById(id);if(button){button.setAttribute('aria-label',id==='bUndo'?'Undo':'Redo');history.append(button);}});
    footer.append(history);layers.append(footer);
    const root=element('div','');root.id='showave-areas-show';top.before(root);const grid=element('div','ol-show-grid');grid.append(top);['xfRow','transport'].forEach(id=>{const node=doc.getElementById(id);if(node)grid.append(node);});
    const monitors=[...bottom.querySelectorAll(':scope>.mon')];const types=[{id:'show-grid',title:'Show Grid',element:grid},{id:'layers',title:'Layers',element:layers},...monitors.map((node,i)=>({id:['preview','show-monitor','layer-monitor'][i],title:node.querySelector('.mon-head').textContent.trim(),element:node})),{id:'inspector',title:'Properties',element:doc.getElementById('props')},{id:'library',title:'Files & Assets',element:doc.getElementById('rightCol')},phoneType(),notesType()].filter(type=>type.element||type.build);
    const manager=install({id:'show',root,types,tree:{axis:'column',ratio:.46,children:[{axis:'row',ratio:layersRatio,children:['layers','show-grid']},{axis:'row',ratio:.50,children:[{axis:'row',ratio:.333,children:['preview',{axis:'row',ratio:.5,children:['show-monitor','layer-monitor']}]},{axis:'row',ratio:.50,children:['inspector','library']}]}]}});bottom.hidden=true;bottom.style.display='none';installShowRowAlignment(manager);return manager;
  }
  function installBroadcastToolExpansion(manager,tools){
    let expanded=null,pending=0,wasOpen=false;
    const update=()=>{
      pending=0;
      const record=[...manager.records.values()].find(item=>item.original&&item.source===tools);
      if(!record||record.popup||manager.maximized)return;
      const parent=manager.parentOf(record.id),slot=manager.splitTree.querySelector('[data-area-id="'+record.id+'"]');
      if(parent?.axis!=='row'||!slot||parent.children.some(child=>!child.id))return;
      const key=parent.children.map(child=>child.id).join('|'),open=!!tools.querySelector('#sourceToolsDock>details[open]:not([hidden])');
      if(expanded&&expanded.key!==key)expanded=null;
      if(!open){
        wasOpen=false;
        if(expanded&&Math.abs(parent.ratio-expanded.after)<.001){parent.ratio=expanded.before;expanded=null;manager.restore(manager.snapshot());}
        else expanded=null;
        return;
      }
      // Expand only when a drawer opens; later manual resizing is intentional.
      if(wasOpen)return;wasOpen=true;
      const available=slot.parentElement.getBoundingClientRect().width-5,desired=Math.min(300,available-120);
      if(desired<=0||slot.getBoundingClientRect().width>=desired-1)return;
      const before=parent.ratio,share=clamp(desired/available,.15,.85),after=parent.children[0].id===record.id?share:1-share;
      expanded={key,before:expanded?.before??before,after};parent.ratio=after;manager.restore(manager.snapshot());
    };
    const schedule=()=>{if(!pending)pending=global.requestAnimationFrame(update);};
    const changed=event=>{if(event.detail?.id===manager.id)schedule();};
    tools.addEventListener('toggle',schedule,true);global.addEventListener('showave:areas-changed',changed);
    global.addEventListener('pagehide',()=>{if(pending)global.cancelAnimationFrame(pending);tools.removeEventListener('toggle',schedule,true);global.removeEventListener('showave:areas-changed',changed);},{once:true});
    schedule();
  }
  function installBroadcast(){
    const root=doc.getElementById('workspaceStudio');if(!root)return;
    const existing=managers.get('broadcast');if(existing)return existing;
    const rail=root.querySelector(':scope>.bc-rail'),center=root.querySelector(':scope>.bc-center'),production=root.querySelector(':scope>.bc-inspector');
    const preview=doc.getElementById('monitorGrid'),programmeMonitor=doc.getElementById('programmeMonitor'),sourcesDock=doc.getElementById('sourcesDock'),tools=doc.getElementById('layerDocks'),layerInspector=doc.getElementById('layerInspector');
    if(!rail||!center||!production||!preview||!programmeMonitor||!sourcesDock||!tools||!layerInspector)return;
    // Move the original controls, canvases and component hosts. The Studio
    // runtime continues to own the scene; panel windows only mirror its UI.
    const panel=(name,layerDock=false)=>element('div','bc-center ol-broadcast-panel ol-broadcast-'+name+(layerDock?' bc-layer-docks':''));
    const programme=panel('programme'),transitions=panel('transitions'),crossfader=panel('crossfader'),sources=panel('sources',true),inspector=panel('inspector',true);
    preview.classList.add('bc-center','ol-broadcast-panel','ol-broadcast-preview');
    tools.classList.add('bc-center','ol-broadcast-panel','ol-broadcast-tools');
    programme.append(programmeMonitor);
    const transition=center.querySelector('.bc-transitionbar');if(transition)transitions.append(transition);
    const fader=transition?.querySelector('#broadcastCrossfader'),help=transition?.querySelector('#transitionTbarHelp');
    if(fader){
      const console=element('div','bc-transition-console');
      for(const [bus,label,host] of [['preview','PVW',preview],['programme','PGM',programme]]){
        const audio=host.querySelector('[data-monitor-audio="'+bus+'"]');
        if(!audio)continue;
        const name=element('span','bc-console-bus-name',label);
        name.title=bus==='preview'?'Preview audio':'Programme audio';name.setAttribute('aria-hidden','true');
        audio.prepend(name);audio.setAttribute('role','group');console.append(audio);
        audio.querySelectorAll('[role=meter]').forEach(meter=>meter.setAttribute('aria-orientation','vertical'));
        const listening=audio.querySelector('.bc-audio-listening'),button=audio.querySelector('.bc-listen-button'),bed=listening?.querySelector('.bc-fader-bed'),value=listening?.querySelector('.bc-volume-value'),reading=audio.querySelector('.bc-audio-readout');
        if(listening&&button&&bed&&value){
          const controls=element('div','bc-console-listen-controls'),level=element('details','bc-console-level'),summary=element('summary'),popup=element('div','bc-console-level-controls');
          const fullName=bus==='preview'?'Preview':'Programme';
          level.setAttribute('name','broadcast-monitor-level');summary.title='Adjust '+fullName+' listening volume';
          summary.append(element('span','bc-volume-help',fullName+' listening volume '),value);
          popup.append(element('span','bc-console-level-title',fullName+' listening'),bed);if(reading)popup.append(reading);
          level.append(summary,popup);listening.append(level);controls.append(button,listening);audio.append(controls);
          level.addEventListener('keydown',event=>{if(event.key==='Escape'&&level.open){event.preventDefault();event.stopPropagation();level.open=false;summary.focus();}});
        }
      }
      console.insertBefore(fader,console.querySelector('[data-monitor-audio=programme]'));crossfader.append(console);fader.classList.add('bc-crossfader-centred');
      const input=fader.querySelector('#transitionTbar');input?.setAttribute('aria-orientation','vertical');input?.setAttribute('aria-describedby','transitionTbarHelp');
      const reset=fader.querySelector('#resetTransition');if(reset){reset.title='Reset manual transition';reset.setAttribute('aria-label','Reset manual transition');reset.append(controlIcon('reset'));}
    }
    if(help)crossfader.append(help);
    const workflow=center.querySelector('.bc-scene-workflow');if(workflow)sources.append(workflow);
    sources.append(sourcesDock);
    ['sourceAudioControls'].forEach(id=>{const node=doc.getElementById(id);if(node)sources.append(node);});
    const legacy=center.querySelector('.bc-controlbar');if(legacy)sources.append(legacy);
    inspector.append(layerInspector);
    [preview.querySelector('#previewFrame'),programme.querySelector('#progStage')].forEach(frame=>{if(!frame)return;const viewport=element('div','ol-broadcast-viewport');frame.before(viewport);viewport.append(frame);});
    const previewEmpty=element('p','ol-broadcast-empty','Select a scene in Studio Mode to edit Preview.');preview.append(previewEmpty);
    const inspectorEmpty=element('p','ol-broadcast-empty','Select a scene and a source to edit its properties.');inspector.append(inspectorEmpty);
    const manager=install({id:'broadcast',root,constrainMinHeight:true,types:[
      {id:'scenes',title:'Scenes',element:rail},
      {id:'preview',title:'Preview',element:preview},
      {id:'programme',title:'Programme',element:programme},
      {id:'transitions',title:'Transitions',element:transitions,minHeight:96},
      {id:'crossfader',title:'T-fader',element:crossfader,minWidth:124,minHeight:270},
      {id:'sources',title:'Sources',element:sources},
      {id:'source-tools',title:'Source Tools',element:tools},
      {id:'layer-inspector',title:'Layer Inspector',element:inspector},
      {id:'production',title:'Production',element:production},phoneType(),notesType()
    ],tree:{axis:'row',ratio:.18,children:['scenes',{axis:'row',ratio:.75,children:[
      // The central console owns both listening buses and the manual T-bar.
      // Existing operator layouts and manually resized docks remain authoritative.
      {axis:'column',ratio:.64,children:[{axis:'column',ratio:.84,children:[{axis:'row',ratio:.43,children:['preview',{axis:'row',ratio:.24,children:['crossfader','programme']}]},'transitions']},
        {axis:'row',ratio:.44,children:['sources',{axis:'row',ratio:.28,children:['source-tools','layer-inspector']}]}]},'production'
    ]}]}});
    center.hidden=true;center.style.display='none';installBroadcastToolExpansion(manager,tools);return manager;
  }
  function openPhoneMirror(){
    let manager=null;
    const route=global.OpenLiveWorkspaceHost?.current();
    if(route&&route!=='show'){try{manager=global.OpenLiveWorkspaceHost.getFrame?.(route)?.contentWindow.OpenLiveAreas?.get(route);}catch(_){}}
    manager=manager||managers.get('show')||managers.values().next().value;if(!manager)return null;
    const visible=new Set();(function walk(node){if(!node)return;if(node.id)visible.add(node.id);node.children?.forEach(walk);})(manager.tree);
    const current=[...manager.records.values()].find(record=>record.type==='phone-mirror'&&visible.has(record.id));
    const id=current?.id||manager.create('phone-mirror',active?.manager===manager?active.id:undefined);const record=manager.records.get(id);record?.content.querySelector('button')?.focus();return id;
  }
  global.OpenLiveAreas=Object.freeze({createSharedView:mirror,install,get:id=>managers.get(id||'show')||null,mountWindow:(manager,id,popup)=>managers.get(manager)?.mountWindow(id,popup)||false,openPanelPicker:(managerId,anchor)=>managers.get(managerId||'show')?.openPanelPicker(anchor)||null,closePanelPicker:()=>closeMenu(false),installShow,installBroadcast,openPhoneMirror});
  if(doc.getElementById('topArea'))installShow();
  if(doc.getElementById('workspaceStudio'))installBroadcast();
  if(managers.has('show')){const bar=doc.querySelector('#menubar .mb-right')||doc.getElementById('menubar');if(bar){const button=element('button','btn','Mirror Phone');button.id='showavePhoneMirrorButton';button.type='button';button.title='Open the Phone Mirror editor area';button.addEventListener('click',openPhoneMirror);bar.prepend(button);}}
  global.addEventListener('pagehide',()=>{closeMenu(false);managers.forEach(manager=>{manager.cancelGesture?.();manager.exitFocus?.();manager.records.forEach(record=>{clearInterval(record.poll);record.dispose?.();record.popupDispose?.();record.returningPopup?.dispose?.();if(record.popup&&!record.popup.closed)record.popup.close();if(record.returningPopup&&!record.returningPopup.popup.closed)record.returningPopup.popup.close();});});});
})(window);
