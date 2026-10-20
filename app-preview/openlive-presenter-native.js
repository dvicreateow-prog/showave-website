/* The local Windows broker owns a clicker device, optionally with its own
   player window. Input-only sessions keep the interface in the browser and
   send navigation state only. Native player sessions use bounded thumbnails
   and notes in RAM; no original media bytes, files or recordings are written. */
(function(root){
  'use strict';
  const BASE='/api/presenter-controller/',MAX_IMAGE=250*1024;
  const ACTIONS=new Set(['advance','back','first','last','take','play','pause','stop']);
  const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const token=()=>root.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now().toString(36);
  const browserKey=value=>['Space','Spacebar'].includes(String(value))?' ':String(value||'');
  function attach(options={}){
    const controller=options.controller||null,powerpointSession=options.powerpointSession||null;
    if(options.inputOnly!==undefined&&typeof options.inputOnly!=='boolean')throw Error('inputOnly must be a boolean.');
    const inputOnly=options.inputOnly===true;
    if(inputOnly&&(!controller||powerpointSession))throw Error('Background clicker input requires a pinned web presentation.');
    if(!controller&&!powerpointSession)throw Error('Pin a presentation before opening its player.');
    const captured=controller?.snapshot(),pinnedSession=captured?.sessionId;
    if(controller&&(!pinnedSession||captured.phase!=='ready'))throw Error('Pin a ready presentation before opening its player.');
    const sessionId='presenter-'+token(),key=token()+token(),listeners=new Set(),requests=new Set(),images=new Map(),imageWaits=new Set();
    let closed=false,opened=false,opening=null,polling=null,publishing=null,unsubscribe=null,
      dirty=true,ack=0,cursor=0,revision=-1,lastPublish=0,commandTail=Promise.resolve(),localError='';
    let mutationTail=Promise.resolve(),wireRevision=0;
    let state={sessionId,inputOnly,open:false,opening:false,alwaysOnTop:false,error:'',
      clicker:{status:'unpaired',deviceLabel:'',keys:[],reason:'Select and pair a USB clicker in the presentation player.'}};
    function snapshot(){return copy(state);}
    function emit(){const value=snapshot();for(const fn of listeners)try{fn(value);}catch(error){}try{options.onState?.(value);}catch(error){}}
    function current(){
      if(closed)return false;
      try{
        if(options.isCurrent&&options.isCurrent()===false)return false;
        if(controller){const value=controller.snapshot();return value.sessionId===pinnedSession&&value.phase==='ready';}
        return !!powerpointSession;
      }catch(error){return false;}
    }
    function guard(){if(!current())throw Error('The pinned presentation changed. Open its player again.');}
    function accept(reply){
      if(closed)return;
      if(reply.sessionId&&reply.sessionId!==sessionId)throw Error('The presentation player returned a different session.');
      if(inputOnly&&reply.inputOnly!==true)throw Error('The local presenter service does not support web background clicker input. Restart the SHOWAVE web server.');
      if(reply.inputOnly!==undefined&&reply.inputOnly!==inputOnly)throw Error('The presentation player returned a different input mode.');
      const clicker=reply.clicker&&typeof reply.clicker==='object'?reply.clicker:state.clicker;
      state={...state,open:reply.open===true,opening:reply.opening===true,alwaysOnTop:reply.alwaysOnTop===true,
        error:String(reply.error||localError||''),clicker:{status:String(clicker.status||'unpaired'),
          deviceLabel:String(clicker.deviceLabel||''),keys:Array.isArray(clicker.keys)?clicker.keys.map(String):[],
          reason:String(clicker.reason||'')}};
      emit();
    }
    async function request(route,body){
      guard();const abort=new root.AbortController();requests.add(abort);
      const timer=root.setTimeout(()=>abort.abort(),route.startsWith('poll')?5000:10000);
      try{
        const response=await root.fetch(BASE+route,{method:body===undefined?'GET':'POST',cache:'no-store',
          headers:body===undefined?undefined:{'Content-Type':'application/json'},
          body:body===undefined?undefined:JSON.stringify(body),signal:abort.signal});
        let reply;try{reply=await response.json();}catch(error){throw Error('The local presentation player did not return a status.');}
        guard();if(!response.ok)throw Error(reply?.error||'The local presentation player is unavailable.');
        if(!reply||typeof reply!=='object')throw Error('The local presentation player did not return a status.');
        if(reply.sessionId&&reply.sessionId!==sessionId)throw Error('The presentation player returned a different session.');
        return reply;
      }catch(error){
        if(abort.signal.aborted&&!closed)throw Error('The local presentation player did not respond. Reopen its window.');
        throw error;
      }finally{root.clearTimeout(timer);requests.delete(abort);}
    }
    function post(route,body){
      // State and repeated Open requests must reach the helper in order. An
      // older image-preparation request cannot roll back a newer model revision.
      const task=mutationTail.then(()=>request(route,{...body,model:{...body.model,revision:++wireRevision}}));
      mutationTail=task.catch(()=>{});return task;
    }
    async function thumbnail(slide,toolState=null){
      if(slide?.frame)return frameThumbnail(slide.frame,toolState);
      if(typeof slide?.image==='string'&&slide.image.startsWith('data:image/png;base64,')&&slide.image.length<=MAX_IMAGE)return slide.image;
      const url=slide?.url;if(!url||!root.Image||!root.document)return '';
      try{const checked=new root.URL(url,root.location.href);if(checked.origin!==root.location.origin||!['http:','https:','blob:'].includes(checked.protocol))return '';}catch(error){return '';}
      // A laser, magnified area or drawing can change without changing the
      // original slide URL. Cache the bounded thumbnail for those exact tools.
      const cacheKey=JSON.stringify([url,toolState]);
      if(images.has(cacheKey))return images.get(cacheKey);
      const job=(async()=>{
        const decoded=root.OpenLivePresenter?.readSlideImage?.(url);
        const image=decoded||new root.Image();
        try{
          if(!decoded){
            const loading=typeof image.decode==='function'
              ? (image.src=url,image.decode())
              : new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Slide image unavailable.'));image.src=url;});
            const ready=await new Promise(resolve=>{
              let done=false,timer;
              const finish=value=>{if(done)return;done=true;root.clearTimeout(timer);imageWaits.delete(wait);resolve(value);};
              const wait={cancel:()=>finish(false)};imageWaits.add(wait);
              timer=root.setTimeout(()=>finish(false),2000);
              Promise.resolve(loading).then(()=>finish(true),()=>finish(false));
            });
            if(!ready)return '';
          }
          guard();return frameThumbnail(image,toolState);
        }catch(error){return '';}finally{if(!decoded)image.removeAttribute?.('src');}
      })();
      images.set(cacheKey,job);while(images.size>6)images.delete(images.keys().next().value);
      return job;
    }
    function frameThumbnail(source,toolState){
      if(!source||!root.document)return '';
      let canvas;
      try{
        const w=source.videoWidth||source.naturalWidth||source.width,h=source.videoHeight||source.naturalHeight||source.height;
        if(!(w>0&&h>0))return '';
        let scale=Math.min(1,960/w,540/h);canvas=root.document.createElement('canvas');
        // Large/noisy slides may exceed the strict wire budget even at 960×540.
        // Reduce this RAM-only preview until it fits; never copy the original.
        for(let attempt=0;attempt<6;attempt++,scale*=.75){
          canvas.width=Math.max(1,Math.floor(w*scale));canvas.height=Math.max(1,Math.floor(h*scale));
          const context=canvas.getContext('2d');if(!context)return '';
          if(toolState){
            const paint=root.OpenLivePresenter?.paintFrame;
            if(typeof paint!=='function'||paint(context,source,canvas.width,canvas.height,toolState)!==true)return '';
          }else context.drawImage(source,0,0,canvas.width,canvas.height);
          const data=canvas.toDataURL('image/png');
          if(data.startsWith('data:image/png;base64,')&&data.length<=MAX_IMAGE)return data;
        }
        return '';
      }catch(error){return '';}finally{if(canvas)canvas.width=canvas.height=1;}
    }
    async function model(){
      if(inputOnly){
        // The browser retains all slides, pixels and private notes. The local
        // broker needs only readiness and indices for this exact pinned deck.
        const value=controller.snapshot();guard();
        return {revision:Number(value.revision)||0,title:String(value.title||'Presentation').slice(0,1024),
          phase:String(value.phase||'ready'),busy:!!value.busy,slideCount:value.slides?.length||0,
          draftIndex:Number.isInteger(value.draftIndex)?value.draftIndex:0,
          onAirIndex:Number.isInteger(value.onAirIndex)?value.onAirIndex:null,error:String(value.error||'').slice(0,1000)};
      }
      if(!controller){
        const value=options.getModel?.()||{},current=value.current||{},next=value.next||{},preview=value.preview||current;
        const images=await Promise.all([thumbnail(current),thumbnail(next),thumbnail(preview)]);guard();
        return {revision:Math.max(0,Math.floor(Number(value.revision)||0)),title:String(value.title||'PowerPoint').slice(0,1024),
          phase:String(value.phase||'ready'),busy:!!value.busy,slideCount:Math.max(0,Math.floor(Number(value.slideCount)||0)),
          draftIndex:Number.isInteger(value.draftIndex)?value.draftIndex:0,onAirIndex:Number.isInteger(value.onAirIndex)?value.onAirIndex:null,
          current:{title:String(current.title||'').slice(0,1024),notes:String(current.notes||'').slice(0,8000),image:images[0],
            caption:String(current.caption||(!images[0]?'Capture Slide Show for pixels':'')).slice(0,1024)},
          next:{title:String(next.title||'').slice(0,1024),image:images[1]},
          preview:{title:String(preview.title||'').slice(0,1024),image:images[2]},error:String(value.error||'').slice(0,1000)};
      }
      const value=controller.snapshot(),withFrame=(slide,index)=>slide&&controller.frame?{...slide,frame:controller.frame(index)}:slide,
        sourceCurrent=withFrame(value.onAir||value.current,value.onAirIndex==null?value.draftIndex:value.onAirIndex),
        nextIndex=value.onAirIndex==null?value.draftIndex+1:value.onAirIndex+1,
        sourceNext=withFrame(value.slides?.[nextIndex]||null,nextIndex),sourcePreview=withFrame(value.current,value.draftIndex);
      const draftTools={pointer:value.pointer,zoom:value.zoom,ink:value.ink},
        currentTools=value.onAirIndex==null?draftTools:{pointer:value.onAirPointer,zoom:value.onAirZoom,ink:value.onAirInk};
      const [currentImage,nextImage,previewImage]=await Promise.all([
        thumbnail(sourceCurrent,currentTools),thumbnail(sourceNext,{ink:value.feedNextInk}),thumbnail(sourcePreview,draftTools)]);
      guard();
      // Publish one consistent captured snapshot. When a revision arrived while
      // the images decoded, the next poll catches it up instead of advertising
      // those older pixels with the newer slide/tool metadata.
      const latest=controller.snapshot();if(latest.revision!==value.revision)dirty=true;
      return {revision:Number(value.revision)||0,title:String(value.title||'Presentation'),phase:value.phase,
        busy:!!value.busy,slideCount:value.slides?.length||0,draftIndex:value.draftIndex,onAirIndex:value.onAirIndex,
        current:{title:String(sourceCurrent?.title||''),notes:String(sourceCurrent?.notes||'').slice(0,8000),image:currentImage},
        next:{title:String(sourceNext?.title||''),image:nextImage},
        preview:{title:String(sourcePreview?.title||''),image:previewImage},error:String(value.error||'')};
    }
    async function publish(force=false){
      if(!opened||closed)return;
      if(publishing){dirty=true;return publishing;}
      if(!force&&!dirty&&Date.now()-lastPublish<2000)return;
      const job=(async()=>{
        dirty=false;const value=await model();guard();
        const reply=await post('state',{sessionId,key,model:value,ack});
        revision=value.revision;lastPublish=Date.now();accept(reply);
      })();publishing=job;
      try{await job;}finally{if(publishing===job)publishing=null;}
    }
    async function command(item){
      guard();if(!controller)return; // Native PowerPoint commands are applied by the helper.
      const action=item.action;if(!ACTIONS.has(action))throw Error('Unknown presentation player command.');
      const before=controller.snapshot();if(before.busy)throw Error('Wait for the current slide to finish preparing.');
      if(['advance','back','first','last'].includes(action)){
        /* The controller owns one atomic pinned-Feed step. Splitting this into
           Browse then Take exposed an unrelated staging window between them. */
        const method=action==='advance'?'next':action==='back'?'previous':action;
        await controller[method]();guard();
      }else{await controller[action]();guard();}
    }
    async function poll(){
      try{
        while(opened&&!closed){
          guard();
          const query=new root.URLSearchParams({session:sessionId,key,after:String(cursor),wait:'1000'});
          const reply=await request('poll?'+query);accept(reply);
          if(!state.open&&!state.opening){await close();return;}
          const commands=Array.isArray(reply.commands)?reply.commands:[];
          if(commands.length>64)throw Error('The presentation player returned too many commands.');
          for(const item of commands){
            if(!Number.isSafeInteger(item.id)||item.id<1)throw Error('Invalid presentation player command sequence.');
            if(item.id<=cursor)continue;
            cursor=item.id;
            // Keep polling/heartbeats alive while a slide decode is pending.
            // Commands themselves stay strictly ordered and acknowledge once.
            commandTail=commandTail.then(async()=>{
              guard();
              try{await command(item);localError='';}catch(error){
                if(!current())throw error;
                localError=String(error.message||error);state.error=localError;emit();
              }
              guard();ack=item.id;dirty=true;await publish(true);
            }).catch(error=>{if(!closed){state.error=String(error.message||error);emit();close(state.error);}});
          }
          if(controller&&controller.snapshot().revision!==revision)dirty=true;
          await publish();
        }
      }catch(error){
        if(closed)return;
        state.error=String(error.message||error);state.open=false;state.opening=false;emit();await close(state.error);
      }
    }
    async function open(){
      guard();if(opening)return opening;
      state.opening=true;emit();
      const job=(async()=>{
        try{
          const value=await model();guard();
          const body={sessionId,key,appearance:options.getAppearance?.()==='dark'?'dark':'light',model:value};
          if(inputOnly)body.inputOnly=true;
          if(powerpointSession)body.powerpointSession=powerpointSession;
          const reply=await post('open',body);accept(reply);guard();
          if(!reply.open&&!reply.opening)throw Error(reply.error||'The local presentation player could not open.');
          opened=true;lastPublish=Date.now();revision=value.revision;
          if(!polling)polling=poll();
          return snapshot();
        }catch(error){
          if(!closed){state.open=false;state.opening=false;state.error=String(error.message||error);emit();
            // An older server may have ignored inputOnly and opened a player.
            // Retire that owned session immediately, including failed opens.
            if(inputOnly)await close(state.error);
          }
          throw error;
        }
      })();opening=job;
      try{return await job;}finally{if(opening===job)opening=null;}
    }
    unsubscribe=controller?.subscribe(value=>{
      if(closed)return;
      if(value.sessionId!==pinnedSession||value.phase!=='ready'){close('The pinned presentation changed.');return;}
      dirty=true;
    });
    async function clickerControl(route){
      guard();
      if(!opened){if(route==='release')return snapshot();await open();}
      guard();
      const task=mutationTail.then(()=>request(route,{sessionId,key}));
      mutationTail=task.catch(()=>{});
      const reply=await task;guard();accept(reply);return snapshot();
    }
    async function close(reason=''){
      if(closed)return;closed=true;opened=false;
      unsubscribe?.();for(const abort of requests)abort.abort();requests.clear();for(const wait of imageWaits)wait.cancel();imageWaits.clear();images.clear();
      state={...state,open:false,opening:false,alwaysOnTop:false,error:reason||state.error,
        clicker:{...state.clicker,status:'closed',keys:[]}};emit();listeners.clear();
      try{await root.fetch(BASE+'close',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId,key})});}catch(error){}
    }
    return Object.freeze({open,close,snapshot,pairClicker:()=>clickerControl('pair'),releaseClicker:()=>clickerControl('release'),
      subscribe(fn){listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},
      ownsKey(event){return !closed&&['paired','pairing'].includes(state.clicker.status)&&
        (state.clicker.status==='pairing'?['PageDown','PageUp','ArrowRight','ArrowLeft']:state.clicker.keys)
          .some(key=>browserKey(key)===browserKey(event?.key));}});
  }
  root.OpenLivePresenterNative=Object.freeze({attach});
})(window);
