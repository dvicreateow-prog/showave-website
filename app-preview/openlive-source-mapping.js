/* Source mapping stages. Styling belongs to the Broadcast inspector stylesheet. */
(function(global){
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const sameRect=(a,b)=>!!a&&!!b&&['x','y','w','h','rotation'].every(key=>Math.abs((a[key]||0)-(b[key]||0))<1e-9);
  const corners=[['nw','top left',-1,-1],['ne','top right',1,-1],['se','bottom right',1,1],['sw','bottom left',-1,1]];

  /**
   * mount({root, stage, getRect, render, commit, enabled, report, getAspect, getKey})
   * Rectangles use normalized source (input) or composition (output) coordinates.
   * render(canvas, draftRect) paints the entire stage, with no letterboxing inside
   * the canvas. getAspect() sets the source aspect for input; output is 16:9.
   * render may return {ready:false,message}, a status string, false, or nothing.
   * enabled is a boolean or function. getKey() identifies the current scene/slot;
   * callers must also guard that identity in asynchronous commit operations.
   * refresh() updates geometry and paints at most ten times a second. No timers
   * are installed. destroy() cancels interaction and removes this mounted view.
   */
  function mount(options){
    const {root,getRect,render,commit,report}=options;
    if(!root||typeof getRect!=='function'||typeof commit!=='function')throw Error('Source mapping needs a root, a rectangle and a commit callback.');
    const input=options.stage==='input',name=input?'Input selection':'Output transformation';
    const doc=root.ownerDocument,view=doc.defaultView||global;
    const element=doc.createElement('div');element.className='bc-source-map';element.dataset.stage=input?'input':'output';
    const frame=doc.createElement('div');frame.className='bc-source-map-frame';
    const canvas=doc.createElement('canvas');canvas.className='bc-source-map-picture';canvas.setAttribute('aria-label',name+' preview');
    const selection=doc.createElement('div');selection.className='bc-source-map-selection';selection.tabIndex=0;selection.setAttribute('role','group');selection.setAttribute('aria-label',name+': drag or use arrow keys to move');
    const handles=corners.map(([corner,label])=>{
      const button=doc.createElement('button');button.type='button';button.className='bc-source-map-handle';button.dataset.corner=corner;button.setAttribute('aria-label',name+': resize '+label);button.title='Drag to resize; arrow keys adjust this corner';selection.appendChild(button);return button;
    });
    const status=doc.createElement('span');status.className='bc-source-map-status';status.setAttribute('role','status');status.hidden=true;
    const hint=doc.createElement('div');hint.className='bc-source-map-hint';hint.textContent='Drag to move · Corners to resize · Shift + arrows for larger steps';
    frame.append(canvas,selection,status);element.append(frame,hint);root.appendChild(element);
    let destroyed=false,gesture=null,pending=false,paintPending=false,lastPaint=-Infinity,lastRefresh=-Infinity,lastError='',epoch=0;
    let placedRect,placedEnabled,placedPending,lastAspect,lastKey,pendingRect=null,pendingKey=null;
    let observedRect,observedEnabled,observedPending;
    const now=()=>view.performance?view.performance.now():Date.now();
    const isEnabled=()=>!destroyed&&!pending&&(typeof options.enabled==='function'?options.enabled():options.enabled!==false);
    const key=()=>typeof options.getKey==='function'?options.getKey():null;
    const notify=message=>{if(message&&message!==lastError){lastError=message;if(typeof report==='function')report(message);}};
    function readRect(){
      const raw=getRect();
      if(!raw||!['x','y','w','h'].every(k=>Number.isFinite(raw[k]))||raw.w<=0||raw.h<=0)return null;
      return {x:raw.x,y:raw.y,w:raw.w,h:raw.h,rotation:input?0:(Number.isFinite(raw.rotation)?raw.rotation:0)};
    }
    function setStatus(message){message=message||'';if(status.textContent!==message){status.textContent=message;status.hidden=!message;}}
    function setEnabled(value){
      if(placedEnabled===value&&placedPending===pending)return;
      placedEnabled=value;placedPending=pending;
      selection.setAttribute('aria-disabled',String(!value));selection.tabIndex=value?0:-1;
      handles.forEach(handle=>{handle.disabled=!value;});element.classList.toggle('is-disabled',!value);element.classList.toggle('is-pending',pending);
    }
    function place(rect){
      if((rect===null&&placedRect===null)||sameRect(rect,placedRect))return;
      placedRect=rect?{...rect}:null;
      selection.hidden=!rect;
      if(!rect)return;
      selection.style.left=(rect.x*100)+'%';selection.style.top=(rect.y*100)+'%';
      selection.style.width=(rect.w*100)+'%';selection.style.height=(rect.h*100)+'%';
      selection.style.transform='rotate('+rect.rotation+'deg)';
      selection.setAttribute('aria-description','X '+(rect.x*100).toFixed(1)+'%, Y '+(rect.y*100).toFixed(1)+'%, width '+(rect.w*100).toFixed(1)+'%, height '+(rect.h*100).toFixed(1)+'%.');
    }
    function paintResult(result,revision){
      if(destroyed||revision!==epoch)return;
      if(typeof result==='string')setStatus(result);
      else if(result===false)setStatus('Preview unavailable');
      else if(result&&result.state==='failed')setStatus(result.error||'Preview unavailable');
      else if(result&&result.ok===false)setStatus(result.why||'Preview unavailable');
      else if(result&&result.ready===false)setStatus(result.message||'Preview unavailable');
      else setStatus('');
    }
    function refresh(){
      if(destroyed)return;
      let current;
      try{current=readRect();}catch(error){setStatus(error.message||'Source unavailable');setEnabled(false);return;}
      const identity=key(),active=!!current&&isEnabled();
      if(gesture&&(!active||identity!==gesture.key||!sameRect(current,gesture.before)))cancelGesture();
      const rect=gesture?gesture.draft:pendingRect&&identity===pendingKey?pendingRect:current;
      const stamp=now(),unchanged=((rect===null&&observedRect===null)||sameRect(rect,observedRect))&&active===observedEnabled&&pending===observedPending&&identity===lastKey;
      // Runtime callers may refresh every frame; avoid all layout reads and DOM
      // writes between thumbnail ticks unless selection or edit state changed.
      if(unchanged&&stamp-lastRefresh<100)return;
      lastRefresh=stamp;if(identity!==lastKey)epoch++;lastKey=identity;
      observedRect=rect?{...rect}:null;observedEnabled=active;observedPending=pending;
      if(!element.isConnected)return;
      let bounds=canvas.getBoundingClientRect();
      if(!bounds.width||!bounds.height)return;
      const requestedAspect=input&&typeof options.getAspect==='function'?Number(options.getAspect()):16/9;
      const aspect=Number.isFinite(requestedAspect)&&requestedAspect>0?requestedAspect:16/9;
      if(lastAspect!==aspect){frame.style.aspectRatio=String(aspect);frame.style.maxWidth=(108*aspect)+'px';lastAspect=aspect;bounds=canvas.getBoundingClientRect();}
      place(rect);setEnabled(active);
      if(!current||!bounds.width||!bounds.height)return;
      if(paintPending||stamp-lastPaint<100||typeof render!=='function')return;
      const ratio=Math.min(view.devicePixelRatio||1,2),width=Math.max(1,Math.round(bounds.width*ratio)),height=Math.max(1,Math.round(bounds.height*ratio));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      lastPaint=stamp;const revision=epoch;
      try{
        const result=render(canvas,{...rect});
        if(result&&typeof result.then==='function'){
          paintPending=true;
          Promise.resolve(result).then(value=>paintResult(value,revision),error=>{if(!destroyed&&revision===epoch)setStatus(error.message||'Preview unavailable');}).finally(()=>{paintPending=false;});
        }else paintResult(result,revision);
      }catch(error){setStatus(error.message||'Preview unavailable');}
    }
    function cancelGesture(){
      if(!gesture)return;
      const pointer=gesture.pointer;gesture=null;element.classList.remove('is-dragging');
      try{if(selection.hasPointerCapture(pointer))selection.releasePointerCapture(pointer);}catch(_){}
      place(readRect());
    }
    function moveRect(before,dx,dy){
      return {...before,x:clamp(before.x+dx,input?0:-10,input?Math.max(0,1-before.w):10),y:clamp(before.y+dy,input?0:-10,input?Math.max(0,1-before.h):10)};
    }
    function resizeRect(before,corner,dx,dy,bounds){
      const [, ,sx,sy]=corners.find(item=>item[0]===corner);
      if(input){
        const left=sx<0?clamp(before.x+dx,0,before.x+before.w-.001):before.x;
        const top=sy<0?clamp(before.y+dy,0,before.y+before.h-.001):before.y;
        const right=sx>0?clamp(before.x+before.w+dx,before.x+.001,1):before.x+before.w;
        const bottom=sy>0?clamp(before.y+before.h+dy,before.y+.001,1):before.y+before.h;
        return {x:left,y:top,w:right-left,h:bottom-top,rotation:0};
      }
      // Rotation acts in physical canvas pixels, not normalized coordinates.
      // Hold the opposite corner fixed while projecting the drag onto local axes.
      const angle=before.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),W=bounds.width,H=bounds.height;
      const localX=dx*W*c+dy*H*s,localY=-dx*W*s+dy*H*c;
      const w=clamp(before.w+sx*localX/W,.01,10),h=clamp(before.h+sy*localY/H,.01,10);
      const shiftX=sx*(w-before.w)*W/2,shiftY=sy*(h-before.h)*H/2;
      const centerX=(before.x+before.w/2)*W+shiftX*c-shiftY*s;
      const centerY=(before.y+before.h/2)*H+shiftX*s+shiftY*c;
      return {x:clamp(centerX/W-w/2,-10,10),y:clamp(centerY/H-h/2,-10,10),w,h,rotation:before.rotation};
    }
    async function apply(next,before,identity){
      if(destroyed||!isEnabled()||key()!==identity||!sameRect(readRect(),before)||sameRect(next,before)){refresh();return;}
      pending=true;pendingRect=next;pendingKey=identity;setEnabled(false);place(next);
      try{
        // This callback is the only write in the helper. It runs once per gesture.
        await commit(input?{x:next.x,y:next.y,w:next.w,h:next.h}:{...next});lastError='';
      }catch(error){if(!destroyed)notify(error.message||'Could not update source mapping.');}
      finally{pending=false;pendingRect=null;pendingKey=null;if(!destroyed){lastPaint=-Infinity;lastRefresh=-Infinity;refresh();}}
    }
    function pointerDown(event){
      if(event.button!==0||gesture||!isEnabled())return;
      const before=readRect(),bounds=canvas.getBoundingClientRect();
      if(!before||!bounds.width||!bounds.height)return;
      const handle=event.target.closest('[data-corner]');
      gesture={pointer:event.pointerId,startX:event.clientX,startY:event.clientY,bounds,before,draft:{...before},corner:handle&&handle.dataset.corner,key:key()};
      event.preventDefault();event.stopPropagation();(handle||selection).focus({preventScroll:true});
      try{selection.setPointerCapture(event.pointerId);}catch(_){}element.classList.add('is-dragging');
    }
    function pointerMove(event){
      if(!gesture||gesture.pointer!==event.pointerId)return;
      if(!isEnabled()||key()!==gesture.key||!sameRect(readRect(),gesture.before)){cancelGesture();refresh();return;}
      const dx=(event.clientX-gesture.startX)/gesture.bounds.width,dy=(event.clientY-gesture.startY)/gesture.bounds.height;
      gesture.draft=gesture.corner?resizeRect(gesture.before,gesture.corner,dx,dy,gesture.bounds):moveRect(gesture.before,dx,dy);
      event.preventDefault();event.stopPropagation();place(gesture.draft);refresh();
    }
    function pointerUp(event){
      if(!gesture||gesture.pointer!==event.pointerId)return;
      pointerMove(event);
      if(!gesture)return;
      const finished=gesture;gesture=null;element.classList.remove('is-dragging');
      try{selection.releasePointerCapture(event.pointerId);}catch(_){}
      event.preventDefault();event.stopPropagation();void apply(finished.draft,finished.before,finished.key);
    }
    function pointerCancel(event){if(gesture&&gesture.pointer===event.pointerId){cancelGesture();refresh();}}
    function keyDown(event){
      if(event.key==='Escape'&&gesture){event.preventDefault();event.stopPropagation();cancelGesture();refresh();return;}
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey)return;
      // Keep mapping keyboard commands out of the global studio shortcuts.
      event.preventDefault();event.stopPropagation();
      if(gesture||!isEnabled())return;
      const before=readRect();if(!before)return;
      const step=event.shiftKey?.01:.001,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
      const handle=event.target.closest('[data-corner]'),bounds=canvas.getBoundingClientRect();
      if(!bounds.width||!bounds.height)return;
      const next=handle?resizeRect(before,handle.dataset.corner,dx,dy,bounds):moveRect(before,dx,dy);
      void apply(next,before,key());
    }
    selection.addEventListener('pointerdown',pointerDown);selection.addEventListener('pointermove',pointerMove);
    selection.addEventListener('pointerup',pointerUp);selection.addEventListener('pointercancel',pointerCancel);selection.addEventListener('lostpointercapture',pointerCancel);
    selection.addEventListener('keydown',keyDown);
    refresh();
    return {refresh,destroy(){
      if(destroyed)return;cancelGesture();destroyed=true;epoch++;
      selection.removeEventListener('pointerdown',pointerDown);selection.removeEventListener('pointermove',pointerMove);
      selection.removeEventListener('pointerup',pointerUp);selection.removeEventListener('pointercancel',pointerCancel);selection.removeEventListener('lostpointercapture',pointerCancel);
      selection.removeEventListener('keydown',keyDown);element.remove();
    }};
  }
  global.OpenLiveSourceMapping=Object.freeze({mount});
})(window);
