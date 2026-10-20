/* Native PowerPoint control and chooser-owned audience capture for Present.
 * UNDOCUMENTED — inferring: the user requested the native deck workflow in
 * Broadcast. Only the original deck is opened; this adapter exports no slides.
 */
window.OpenLivePowerPointSource=(()=>{
  'use strict';
  const SESSION=/^[A-Za-z0-9_-]{1,128}$/;
  const CANCEL='Presentation preparation cancelled.';
  const iconPaths={first:'assets/obs-icons/media/media_previous.svg',previous:'assets/media-icons/previous.svg',
    next:'assets/media-icons/next.svg',last:'assets/obs-icons/media/media_next.svg',play:'assets/obs-icons/media/media_play.svg',
    pause:'assets/obs-icons/media/media_pause.svg',end:'assets/obs-icons/media/media_stop.svg',presenter:'assets/presenter-icons/presenter.svg'};
  const activeSignal=signal=>{if(signal?.aborted)throw Error(CANCEL);};
  const safeSession=value=>typeof value==='string'&&SESSION.test(value)?value:null;
  const text=value=>typeof value==='string'?value.slice(0,512):'';
  const copyState=state=>({...state,current:state?.current?{...state.current}:null,next:state?.next?{...state.next}:null});
  function savedConfig(config={}){
    return {mode:'powerpoint-live',fileName:text(config.fileName||config.title),audio:config.audio===true};
  }
  async function request(operation,{session,action,signal,fetch:fetcher=window.fetch?.bind(window)||globalThis.fetch}={}){
    if(typeof fetcher!=='function')throw Error('The native PowerPoint service is unavailable.');
    if(session&&!safeSession(session))throw Error('The pinned PowerPoint session is invalid. Import the original again.');
    activeSignal(signal);
    const query=new URLSearchParams();if(session)query.set('session',session);if(action)query.set('name',action);
    const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
    const timeout=setTimeout(cancel,operation==='import'?300000:operation==='connect'?30000:10000);
    try{
      const response=await fetcher('/api/powerpoint-live/'+operation+(query.size?'?'+query:''),{
        method:operation==='status'?'GET':'POST',cache:'no-store',credentials:'same-origin',signal:controller.signal});
      activeSignal(signal);let result;
      try{result=await response.json();}catch(error){activeSignal(signal);throw Error('PowerPoint returned no slide status. Refresh status and try again.');}
      if(!response.ok)throw Error(result?.error||'Native PowerPoint control failed.');
      if(!result||typeof result!=='object')throw Error('PowerPoint returned no slide status. Refresh status and try again.');
      if(session&&result.sessionId!==session)throw Error('The pinned PowerPoint session changed. No other deck will be controlled.');
      return result;
    }catch(error){
      activeSignal(signal);
      if(controller.signal.aborted)throw Error('PowerPoint did not respond. Refresh status before another command.');
      throw error;
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
  }
  function requireDeck(state,session,{running=false}={}){
    if(state.sessionId!==session)throw Error('The pinned PowerPoint changed. Import the original again.');
    if(state.protectedView)throw Error('This original is in Protected View. Enable Editing in PowerPoint, then refresh status.');
    if(state.targetClosed||!state.connected)throw Error('The pinned PowerPoint was closed. Import or connect the original again.');
    if(running&&!state.running)throw Error('Start the pinned PowerPoint slideshow before preparing its capture.');
  }
  function statusText(state,error=''){
    if(error)return error;
    if(state?.protectedView)return (state.title||'PowerPoint')+' · Protected View. Enable Editing in PowerPoint, then refresh status.';
    if(state?.targetClosed)return 'The pinned PowerPoint was closed. Import its original again.';
    if(!state?.connected)return 'Import an original PowerPoint or connect an open deck.';
    return (state.title||'PowerPoint')+' · '+(state.running?'Slide '+(state.slide||'N/A')+' / '+(state.slideCount||'N/A')+' · '+(state.playback||'running'):
      (state.slideCount||'N/A')+' slides · slideshow stopped');
  }
  function node(doc,tag,parent,label){const el=doc.createElement(tag);if(label!==undefined)el.textContent=label;parent?.append(el);return el;}
  function button(doc,parent,label,handler,icon){
    const el=node(doc,'button',parent,icon?'':label);el.type='button';el.className='btn';el.title=label;el.setAttribute('aria-label',label);
    if(icon){const glyph=node(doc,'span',el);glyph.setAttribute('aria-hidden','true');
      Object.assign(glyph.style,{display:'block',width:'13px',height:'13px',background:'currentColor',
        mask:'url("'+iconPaths[icon]+'") center / contain no-repeat',webkitMask:'url("'+iconPaths[icon]+'") center / contain no-repeat'});
      Object.assign(el.style,{width:'24px',minWidth:'24px',height:'21px',padding:'2px 4px'});}
    el.addEventListener('click',handler);return el;
  }
  function mountProperties(root,{config={},isCurrent=()=>true,onChange=()=>{},onError=()=>{},document:doc=document,fetch:fetcher}={}){
    let destroyed=false,busy=false,state=null,error='',revision=0,abort=new AbortController(),cfg={...config,mode:'powerpoint-live',audio:config.audio===true};
    const container=node(doc,'section',root);container.className='bc-presentation-native-properties bc-present-native-properties';
    const heading=node(doc,'header',container,'PowerPoint Live');heading.className='mon-head';
    const buttons=node(doc,'div',container);buttons.className='bc-present-actions';Object.assign(buttons.style,{display:'flex',flexWrap:'wrap',gap:'2px',margin:'4px 0'});
    const note=node(doc,'p',container);note.setAttribute('role','status');
    const hint=node(doc,'p',container,'PowerPoint keeps its original media, animations and links. Start its slideshow, then Prepare preview and choose that Slide Show window. Verify the picture before adding.');
    const audioLabel=node(doc,'label',container),audio=node(doc,'input',audioLabel);audio.type='checkbox';audio.checked=cfg.audio===true;
    node(doc,'span',audioLabel,' Share presentation audio when offered by the chooser');
    node(doc,'p',container,'Native slide controls update this live capture in both Preview and Programme. Cut/Fade controls when the source enters Programme.');
    const current=()=>!destroyed&&container.isConnected!==false&&isCurrent();
    const paint=()=>{if(!current())return;note.textContent=busy?'Waiting for PowerPoint…':statusText(state,error);
      for(const el of [importButton,connectButton,refreshButton])el.disabled=busy;
      startButton.disabled=busy||!safeSession(cfg.sessionId)||!!state?.protectedView||!state?.connected;
      audio.disabled=busy;container.setAttribute('aria-busy',String(busy));};
    async function run(operation,{unpin=false}={}){
      if(!current()||busy)return null;
      const ticket=++revision,session=unpin?null:safeSession(cfg.sessionId);busy=true;error='';paint();
      try{
        const result=await request(operation,{session,signal:abort.signal,fetch:fetcher});
        if(!current()||ticket!==revision)return null;
        if(result.cancelled){error='PowerPoint import cancelled.';return result;}
        state=result;
        const token=safeSession(result.sessionId);
        if(token&&(operation==='import'||operation==='connect'||session)){
          cfg={...cfg,sessionId:token,title:text(result.title),fileName:text(result.title)};
          onChange({...cfg});
        }
        return result;
      }catch(failure){if(current()&&ticket===revision){error=failure.message||String(failure);onError(failure);}return null;
      }finally{if(current()&&ticket===revision){busy=false;paint();}}
    }
    const importButton=button(doc,buttons,'Import original PowerPoint',()=>run('import',{unpin:true}));
    const connectButton=button(doc,buttons,'Connect open PowerPoint',()=>run('connect',{unpin:true}));
    const refreshButton=button(doc,buttons,'Refresh status',()=>run('status'));
    const startButton=button(doc,buttons,'Start slideshow',()=>run('connect'));
    audio.addEventListener('change',()=>{if(!current()||busy)return;cfg={...cfg,audio:audio.checked===true};onChange({...cfg});});
    paint();if(safeSession(cfg.sessionId))run('status');
    return {refresh:()=>run('status'),destroy(){if(destroyed)return;destroyed=true;revision++;abort.abort();container.remove();}};
  }
  async function prepareVideo(stream,signal,doc){
    activeSignal(signal);const video=doc.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;
    try{
      await new Promise((resolve,reject)=>{
        let done=false,timer=null,frame=null;
        const finish=failure=>{if(done)return;done=true;clearTimeout(timer);
          video.removeEventListener('loadeddata',loaded);video.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);
          if(frame!==null)video.cancelVideoFrameCallback?.(frame);failure?reject(failure):resolve();};
        const decoded=()=>video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0;
        const loaded=()=>{if(!decoded())return;
          if(typeof video.requestVideoFrameCallback==='function'){
            if(frame===null)frame=video.requestVideoFrameCallback(()=>{frame=null;decoded()?finish():finish(Error('PowerPoint capture has no decoded picture.'));});
          }else finish();};
        const failed=()=>finish(Error('The selected PowerPoint capture could not be decoded. Share the Slide Show window again.'));
        const cancel=()=>finish(Error(CANCEL));
        video.addEventListener('loadeddata',loaded);video.addEventListener('error',failed);signal?.addEventListener('abort',cancel,{once:true});
        timer=setTimeout(()=>finish(Error('No picture received in 20 seconds. Verify the shared PowerPoint Slide Show window.')),20000);
        try{video.srcObject=stream;Promise.resolve(video.play()).then(loaded,failure=>finish(Error('PowerPoint capture playback failed: '+failure.message)));loaded();}
        catch(failure){finish(failure);}
      });
      activeSignal(signal);return video;
    }catch(error){releaseVideo(video);throw error;}
  }
  function releaseVideo(video){try{video.pause?.();video.srcObject=null;video.removeAttribute?.('src');video.load?.();video.remove?.();}catch(_){} }
  const captureHealthy=stream=>stream?.getVideoTracks?.().some(track=>track.readyState==='live')===true;
  function sharedRuntime(stream,session,config,initial,{fetch:fetcher,clock}={}){
    clock={setTimeout:clock?.setTimeout||setTimeout,clearTimeout:clock?.clearTimeout||clearTimeout};
    const lifetime=new AbortController(),listeners=new Set();
    let state=copyState(initial),error='',busy=false,revision=0,refs=0,poll=null,closed=false;
    const notify=()=>listeners.forEach(listener=>{try{listener();}catch(_){}});
    const setState=next=>{const changed=['connected','running','slide','slideCount','playback','protectedView','targetClosed','title'].some(key=>state[key]!==next[key]);
      state=copyState(next);if(changed){revision++;notify();}};
    const schedule=()=>{if(!closed&&refs&&poll===null)poll=clock.setTimeout(()=>{poll=null;if(!busy)run('status').catch(()=>{});else schedule();},2000);};
    async function run(operation,action){
      if(closed||!refs)throw Error('This presentation capture has been released.');
      if(busy)throw Error('A PowerPoint command is still running. Wait for its status.');
      if(operation!=='status'){
        requireDeck(state,session,{running:action!=='play'});
        if(!captureHealthy(stream))throw Error('PowerPoint window sharing ended. Share the Slide Show window again.');
      }
      busy=true;error='';notify();
      try{
        const result=await request(operation,{session,action,signal:lifetime.signal,fetch:fetcher});
        if(closed)throw Error('This presentation capture has been released.');
        setState(result);return copyState(state);
      }catch(failure){if(!closed){error=failure.message||String(failure);revision++;notify();}throw failure;
      }finally{busy=false;if(!closed){notify();schedule();}}
    }
    return {stream,session,config,
      retain(){if(closed)throw Error('This presentation capture has been released.');refs++;schedule();},
      release(){if(!refs)return;refs--;if(refs)return;closed=true;lifetime.abort();if(poll!==null)clock.clearTimeout(poll);poll=null;
        stream?.getTracks?.().forEach(track=>{try{track.stop();}catch(_){}});listeners.clear();},
      snapshot:()=>({...copyState(state),error,busy,revision}),
      get revision(){return revision;},
      subscribe(listener){if(closed)return ()=>{};listeners.add(listener);return ()=>listeners.delete(listener);},
      refresh:()=>run('status'),
      command(name){if(!['first','previous','next','last','play','pause','end'].includes(name))return Promise.reject(Error('Unsupported presentation command.'));
        return run('action',name);},
      status(){if(closed||!captureHealthy(stream))return {ok:false,state:'ended',why:'PowerPoint window sharing ended. Share its Slide Show window again.'};
        if(error)return {ok:false,state:'failed',why:error};
        if(state.protectedView)return {ok:false,state:'protected',why:'The pinned PowerPoint is in Protected View.'};
        if(!state.connected||state.targetClosed)return {ok:false,state:'ended',why:'The pinned PowerPoint was closed.'};
        if(!state.running)return {ok:false,state:'stopped',why:'The pinned PowerPoint slideshow has ended. Start it again.'};
        return {ok:true,state:'ready'};}
    };
  }
  function lease(shared,video){
    let disposed=false;shared.retain();
    const check=()=>{if(disposed)throw Error('This presentation source has been released.');};
    const controls={snapshot(){check();return shared.snapshot();},get revision(){return shared.revision;},
      refresh(){check();return shared.refresh();},command(name){check();return shared.command(name);},subscribe(listener){check();return shared.subscribe(listener);}};
    return {kind:'presentation',sourceType:'present',config:savedConfig(shared.config),_sourceConfig:{...shared.config},nativeSession:shared.session,
      el:video,stream:shared.stream,presentationControls:controls,_powerpointShared:shared,_managedStreamLifetime:true,
      runtimeStatus:()=>disposed?{ok:false,state:'released',why:'This presentation source has been released.'}:
        video.error||video.readyState<2||!video.videoWidth||!video.videoHeight?{ok:false,state:'loading',why:'PowerPoint capture has no decoded picture.'}:shared.status(),
      dispose(){if(disposed)return;disposed=true;releaseVideo(video);shared.release();}};
  }
  async function acquire(config={},signal,{document:doc=document,mediaDevices=navigator.mediaDevices,fetch:fetcher,clock}={}){
    activeSignal(signal);const session=safeSession(config.sessionId);
    if(!session)throw Error('Import or connect the original PowerPoint first.');
    if(!mediaDevices?.getDisplayMedia)throw Error('PowerPoint window capture is unavailable in this browser.');
    let stream=null,video=null;
    try{
      // Consume the caller's Prepare preview gesture before awaiting native status.
      stream=await mediaDevices.getDisplayMedia({video:{displaySurface:'window',frameRate:{ideal:30}},audio:config.audio===true,
        selfBrowserSurface:'exclude',...(config.audio===true?{systemAudio:'include'}:{})});
      activeSignal(signal);
      if(!captureHealthy(stream))throw Error('The selected window did not provide a live video track.');
      if(config.audio===true&&!stream.getAudioTracks?.().some(track=>track.readyState==='live'))
        throw Error('No shared PowerPoint audio was provided. Enable Share audio in the chooser when available, or prepare with presentation audio off.');
      const state=await request('status',{session,signal,fetch:fetcher});activeSignal(signal);requireDeck(state,session,{running:true});
      video=await prepareVideo(stream,signal,doc);activeSignal(signal);
      const prepared={...savedConfig(config),sessionId:session,title:text(state.title)};
      return lease(sharedRuntime(stream,session,prepared,state,{fetch:fetcher,clock}),video);
    }catch(error){if(video)releaseVideo(video);stream?.getTracks?.().forEach(track=>{try{track.stop();}catch(_){}});throw error;}
  }
  async function fork(source,{document:doc=document,signal}={}){
    activeSignal(signal);const shared=source?._powerpointShared;
    if(!shared)throw Error('The native PowerPoint source is unavailable.');
    const status=source.runtimeStatus?.();if(!status?.ok)throw Error(status?.why||'PowerPoint capture is not ready.');
    shared.retain();let video;
    try{video=await prepareVideo(shared.stream,signal,doc);activeSignal(signal);return lease(shared,video);}
    catch(error){if(video)releaseVideo(video);throw error;}
    finally{shared.release();}
  }
  function mountControls(root,{source,getProgramme=()=>null,guard=()=>true,onError=()=>{},document:doc=document}={}){
    const controls=source?.presentationControls;if(!controls)throw Error('Native presentation controls are unavailable.');
    let destroyed=false,busy=false;const container=node(doc,'section',root);container.className='bc-presentation-native-controls bc-present-player';
    node(doc,'header',container,'PowerPoint Live').className='mon-head';
    const note=node(doc,'p',container);note.setAttribute('role','status');
    const bar=node(doc,'div',container);bar.className='bc-present-actions';Object.assign(bar.style,{display:'flex',gap:'2px',margin:'4px 0'});
    const buttons=new Map(),current=()=>!destroyed&&container.isConnected!==false&&guard();
    const playerOwner={},contentPlayer=window.OpenLiveBroadcastPlayer?.create(source,{owner:playerOwner,guard:current});
    if(contentPlayer)container.setAttribute('data-content-player',contentPlayer.reference.kind);
    const refreshButton=button(doc,container,'Refresh status',()=>run('refresh'));
    const warning=node(doc,'p',container);
    const paint=()=>{if(!current())return;
      contentPlayer?.refresh();
      let state;try{state=controls.snapshot();}catch(error){note.textContent=error.message;for(const el of buttons.values())el.disabled=true;refreshButton.disabled=true;return;}
      note.textContent=statusText(state,state.error);const healthy=source.runtimeStatus?.().ok===true;
      for(const [name,el] of buttons)el.disabled=busy||state.busy||!healthy&&name!=='play'||!state.connected||!!state.protectedView||name!=='play'&&!state.running||contentPlayer&&!contentPlayer.supports(name);
      refreshButton.disabled=busy||state.busy||contentPlayer&&!contentPlayer.supports('refresh');
      const programme=getProgramme(source);warning.textContent=programme?'On Programme · native slide commands change the live capture immediately.':'Live capture · native slide commands also change Programme whenever this source is on air.';
      container.setAttribute('aria-busy',String(busy||state.busy));
    };
    async function run(name){if(!current()||busy)return;busy=true;paint();try{
        await (contentPlayer?contentPlayer.command(name):name==='refresh'?controls.refresh():controls.command(name));
      }catch(error){if(current())onError(error);}finally{busy=false;paint();}}
    for(const [name,label] of [['first','First slide'],['previous','Previous slide'],['next','Next slide'],['last','Last slide'],['play','Start or resume slideshow'],['pause','Pause slideshow'],['end','End slideshow']]){
      const el=button(doc,bar,label,()=>run(name),name);el.setAttribute('data-presentation-native-action',name);buttons.set(name,el);
    }
    const unsubscribe=controls.subscribe?.(paint)||(()=>{});paint();
    return {refresh:paint,destroy(){if(destroyed)return;destroyed=true;unsubscribe();contentPlayer?.release(playerOwner);container.remove();}};
  }
  return Object.freeze({savedConfig,mountProperties,acquire,fork,mountControls});
})();
