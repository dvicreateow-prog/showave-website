/* Shared player bindings for Studio's existing source runtimes. Studio owns the
   decoders, original file references and Programme forks; this control lease
   neither copies content nor releases a source when its inspector is closed. */
window.OpenLiveBroadcastPlayer=(()=>{
  'use strict';
  const callable=(object,key)=>typeof object?.[key]==='function';
  const native=runtime=>runtime?.config?.mode==='powerpoint-live';
  function create(runtime,{owner,guard=()=>true}={}){
    const contract=window.OpenLiveContentPlayer;
    if(!contract?.create)throw Error('The content player infrastructure is unavailable.');
    const transport=runtime?.transport,slides=runtime?.presentationControls,element=runtime?.el;
    const leaseOwner=owner||{};
    const current=()=>{
      try{return !!runtime&&guard()!==false&&runtime.el===element&&
        runtime.transport===transport&&runtime.presentationControls===slides;}catch(_){return false;}
    };
    const slideState=()=>native(runtime)?slides.snapshot():slides.state();
    const health=()=>{
      try{return callable(runtime,'runtimeStatus')?runtime.runtimeStatus():null;}catch(error){return {ok:false,state:'failed',why:error.message};}
    };
    const commands={};
    if(transport){
      for(const name of ['play','pause','stop','seek','direction','loop','mode'])
        if(callable(transport,name))commands[name]=value=>transport[name](value);
      if(callable(transport,'setRate'))commands.rate=value=>transport.setRate(value);
      if(callable(transport,'pause')&&callable(transport,'seek')&&callable(transport,'bounds'))
        commands.cue=()=>{transport.pause();return transport.seek(transport.bounds().start);};
      if(callable(transport,'trim'))commands.trim=value=>transport.trim(value?.start,value?.end);
      if(callable(transport,'transition'))commands.transition=value=>transport.transition(value?.type,value?.durationMs);
    }else if(slides){
      if(native(runtime)){
        if(callable(slides,'command'))for(const name of ['first','previous','next','last','play','pause','end'])
          commands[name]=()=>slides.command(name);
        if(callable(slides,'refresh'))commands.refresh=()=>slides.refresh();
      }else{
        if(callable(slides,'go')){
          const settings=context=>({signal:context.signal,isCurrent:context.isCurrent});
          commands.first=(_,context)=>slides.go(0,settings(context));
          commands.last=(_,context)=>slides.go(slides.state().count-1,settings(context));
          commands.previous=(_,context)=>slides.go(Math.max(0,slides.state().index-1),settings(context));
          commands.next=(_,context)=>slides.go(Math.min(slides.state().count-1,slides.state().index+1),settings(context));
          commands.goto=(value,context)=>slides.go(value,settings(context));
        }else{
          if(callable(slides,'first'))commands.first=()=>slides.first();
          if(callable(slides,'last'))commands.last=()=>slides.last();
          if(callable(slides,'step')){commands.previous=()=>slides.step(-1);commands.next=()=>slides.step(1);}
        }
        if(callable(slides,'playMedia'))commands.play=(value,context)=>slides.playMedia(value,{signal:context.signal,isCurrent:context.isCurrent});
        if(callable(slides,'pauseMedia'))commands.pause=value=>slides.pauseMedia(value);
        if(callable(slides,'stopMedia'))commands.stop=value=>slides.stopMedia(value);
      }
    }
    const capabilities=()=>{
      if(!current())return {};
      const result={visual:!!element&&!runtime.audioOnly,
        audio:runtime.audioOnly===true||runtime.stream?.getAudioTracks?.().some(track=>track.readyState==='live')===true};
      for(const name of Object.keys(commands))result[name]=true;
      if(transport){
        if(runtime.audioOnly)result.transition=false;
        if(transport.state?.()==='Released')return {};
      }else if(slides){
        let state;try{state=slideState();}catch(_){return {};}
        if(state.disposed)return {};
        if(native(runtime)){
          const connected=state.connected===true&&!state.protectedView&&!state.targetClosed;
          const live=connected&&state.running===true&&health()?.ok===true;
          for(const name of ['first','previous','next','last','pause','end'])result[name]=!!commands[name]&&live&&!state.busy;
          result.play=!!commands.play&&connected&&!state.busy;result.refresh=!!commands.refresh&&!state.busy;
        }else{
          const media=callable(slides,'mediaState')?slides.mediaState()?.items||[]:[];
          for(const name of ['play','pause','stop'])if(commands[name])result[name]=media.length>0;
          if(state.busy||!state.count)for(const name of Object.keys(result))result[name]=false;
        }
      }
      return result;
    };
    const getState=()=>{
      if(!current())return {phase:'released',ready:false,error:'The selected content changed.'};
      const status=health();
      if(transport){
        const bounds=transport.bounds(),detail=transport.details?.()||{},state=transport.state();
        const error=detail.error||element?.error?.message||'';
        const decoded=element?.readyState>=2;
        const ready=state!=='Released'&&bounds.duration>0&&decoded&&!element?.error&&(status?.ok!==false);
        return {phase:state==='Released'?'released':error?'error':ready?'ready':'loading',ready,
          position:Number(element.currentTime)||0,duration:bounds.duration,transport:detail.playing?'playing':'paused',
          error:error||status?.why||'',frameReady:ready};
      }
      if(slides){
        const state=slideState(),live=native(runtime),count=Number(live?state.slideCount:state.count)||0,
          page=live?Math.max(0,(Number(state.slide)||1)-1):Number(state.index),
          error=state.error||status?.why||'',ready=!state.disposed&&page>=0&&count>0&&status?.ok===true;
        return {phase:state.disposed?'released':error&&!ready?'error':ready?'ready':'loading',ready,
          page,pageCount:count,busy:!!state.busy,error,frameReady:ready,
          transport:live?(state.playback==='running'?'playing':'paused'):slides.mediaState?.().playing?'playing':'paused'};
      }
      const ready=status?.ok===true||status===null&&!!element&&
        ((element.complete===true&&Number(element.naturalWidth)>0)||(Number(element.width)>1&&Number(element.height)>1));
      return {phase:ready?'ready':status?.state==='failed'?'error':'loading',ready,frameReady:ready,error:status?.why||''};
    };
    const reference={id:runtime?.id||null,name:runtime?.label||runtime?.name||runtime?.config?.fileName||'Content',
      kind:transport?(runtime.audioOnly?'audio':'video'):slides?(native(runtime)||runtime.config?.mode==='powerpoint'?'powerpoint':'pdf'):
        runtime?.stream?'live':runtime?.sourceType==='image'||runtime?.kind==='image'?'image':runtime?.sourceType||runtime?.kind||'source',
      original:runtime?._sourceFile||runtime?.originalSource||runtime?._sourceConfig?.file||null};
    return contract.create({reference,owner:leaseOwner,isCurrent:current,adapter:{getState,capabilities,
      command(name,value,context){
        if(!current()||!context.isCurrent())throw Error('The selected content changed.');
        if(!capabilities()[name]||!commands[name])throw Error('This content does not support '+name+'.');
        if(runtime.audioOnly&&(name==='direction'&&value==='reverse'||name==='mode'&&value==='pingpong'))
          throw Error('Audio-only sources support forward playback.');
        return commands[name](value,context);
      },drawable:()=>current()?element:null,
      subscribe(notify){
        const controls=slides||transport;
        if(!callable(controls,'subscribe'))return ()=>{};
        return controls.subscribe(()=>{Promise.resolve().then(()=>{if(current())notify();});});
      },
      // The mount owns only its controls, never the reusable Studio source.
      dispose(){}}});
  }
  return Object.freeze({create});
})();
