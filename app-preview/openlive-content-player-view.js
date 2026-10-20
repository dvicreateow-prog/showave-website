/* Compact view of an existing content player. The renderer and host clock stay
   with the adapter; closing this window only releases this view's ownership. */
(function(root){
  'use strict';
  function mount(player,options={}){
    const doc=options.document||root.document,owner={},dialog=doc.createElement('dialog');
    dialog.className='original-file-dialog content-player-dialog';dialog.setAttribute('aria-label','Content player');
    const make=(tag,className,text)=>{const el=doc.createElement(tag);if(className)el.className=className;if(text)el.textContent=text;return el;};
    const head=make('header','',player.snapshot().title),close=make('button','tb-btn small','×');
    close.type='button';close.setAttribute('aria-label','Close content player');head.appendChild(close);dialog.appendChild(head);
    const canvas=make('canvas','content-player-picture');canvas.width=640;canvas.height=360;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Content player picture');
    const status=make('p','content-player-status');status.setAttribute('role','status');dialog.append(canvas,status);
    const tools=make('div','content-player-controls'),buttons={};
    const labels={first:'First',previous:'Previous',play:'Play',pause:'Pause',stop:'Stop',next:'Next',last:'Last'};
    for(const [name,label]of Object.entries(labels)){
      const button=make('button','tb-btn small');button.type='button';button.title=label;button.setAttribute('aria-label',label);
      const icon=make('img');icon.src='assets/obs-icons/media/media_'+({first:'previous',last:'next'}[name]||name)+'.svg';icon.alt='';
      button.appendChild(icon);button.addEventListener('click',()=>perform(name));tools.appendChild(button);buttons[name]=button;
    }
    dialog.appendChild(tools);
    const seek=make('input','content-player-seek');seek.type='range';seek.min='0';seek.step='.01';seek.setAttribute('aria-label','Content playback position');
    seek.addEventListener('change',()=>perform('seek',Number(seek.value)));dialog.appendChild(seek);
    const footer=make('footer'),scope=make('span','',options.scope||'Show feed'),done=make('button','','Close');done.type='button';done.addEventListener('click',destroy);footer.append(scope,done);dialog.appendChild(footer);
    let closed=false,frame=null,error='';player.retain(owner);
    function perform(name,value){
      error='';try{Promise.resolve(player.command(name,value)).catch(failure=>{if(!closed){error=failure.message||String(failure);paint();}});}catch(failure){error=failure.message||String(failure);paint();}
    }
    function paint(){
      if(closed)return;const state=player.snapshot();
      for(const [name,button]of Object.entries(buttons)){
        button.hidden=!state.capabilities[name];button.disabled=state.busy||!state.capabilities[name];
      }
      seek.hidden=!state.capabilities.seek;seek.disabled=state.busy||!state.ready;
      seek.max=String(state.duration||0);if(doc.activeElement!==seek)seek.value=String(state.position||0);
      status.textContent=error||state.error||(state.busy?'Preparing…':state.pageCount?`${(state.page||0)+1} / ${state.pageCount} · ${state.transport}`:
        state.ready?state.duration!=null?`${(state.position||0).toFixed(1)} / ${state.duration.toFixed(1)} s · ${state.transport}`:state.transport:state.phase);
      const ctx=canvas.getContext('2d');if(!ctx)return;ctx.clearRect(0,0,canvas.width,canvas.height);
      const drawable=player.drawable(),source=drawable?.source||drawable,w=drawable?.width||source?.videoWidth||source?.naturalWidth||source?.width,h=drawable?.height||source?.videoHeight||source?.naturalHeight||source?.height;
      if(source&&w>0&&h>0){const scale=Math.min(canvas.width/w,canvas.height/h);ctx.drawImage(source,(canvas.width-w*scale)/2,(canvas.height-h*scale)/2,w*scale,h*scale);}
      else{ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#ccc';ctx.font='12px Segoe UI';ctx.textAlign='center';ctx.fillText(state.kind==='audio'?'Audio player':state.error||'Waiting for content picture',canvas.width/2,canvas.height/2);}
    }
    function tick(){if(closed)return;paint();frame=root.requestAnimationFrame(tick);}
    function destroy(){if(closed)return;closed=true;if(frame!=null)root.cancelAnimationFrame(frame);unsubscribe();player.release(owner);try{dialog.close();}catch(_){}dialog.remove();options.onClose?.();}
    const unsubscribe=player.subscribe(paint);close.addEventListener('click',destroy);dialog.addEventListener('close',destroy);dialog.addEventListener('cancel',event=>{event.preventDefault();destroy();});
    doc.body.appendChild(dialog);try{dialog.showModal();tick();}catch(failure){destroy();throw failure;}
    Promise.resolve().then(()=>{if(!closed)return player.prepare();}).catch(failure=>{if(!closed){error=failure.message||String(failure);paint();}});
    return {close:destroy,dialog};
  }
  root.OpenLiveContentPlayerView=Object.freeze({mount});
})(window);
