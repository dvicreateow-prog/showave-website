/* Browser source adapters. Prepared resources are owned by the dialog until commit. */
window.OpenLiveSourceAcquisition=(()=>{
  'use strict';
  const isNDIDevice=device=>!!device?.deviceId&&/\bNDI\b/i.test(device.label||'');
  const resolutions=['1920x1080','1280x720','640x480'],frameRates=[25,30,50,60];
  const textValue=(value,fallback='')=>typeof value==='string'?value:fallback;
  const numberValue=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
  const textSystemFonts=Object.freeze(['sans-serif','system-ui','Arial','Arial Unicode MS','Verdana','Georgia','Times New Roman','Courier New','Avenir','Baskerville','Century Gothic','Franklin Gothic','Futura','Garamond','Gill Sans','Helvetica','Impact','Lucida Sans','Optima','Palatino','Rockwell','Segoe UI','Tahoma','Trebuchet MS']);
  function textFont(value='sans-serif'){
    const name=value===undefined||value===''?'sans-serif':value,asset=window.OpenLiveFontAssets?.record(name);
    if(asset)return {name:asset.name,family:asset.family,label:asset.label,source:asset.source};
    if(!textSystemFonts.includes(name))throw Error('Choose a font from the SHOWAVE font catalog.');
    return {name,family:name==='sans-serif'||name==='system-ui'?name:'"'+name+'", sans-serif',label:name==='sans-serif'?'Default · sans-serif':name,source:'system'};
  }
  function textFonts(query='',selected='sans-serif'){
    const term=String(query).trim().toLowerCase(),fonts=[],seen=new Set();
    const add=item=>{if(!seen.has(item.name)&&fonts.length<80){seen.add(item.name);fonts.push(item);}};
    // Keep an existing selection visible while filtering; searching alone must
    // never replace a source's chosen family.
    try{add(textFont(selected));}catch(_){add(textFont());}
    textSystemFonts.filter(name=>!term||name.toLowerCase().includes(term)).forEach(name=>add(textFont(name)));
    for(const item of window.OpenLiveFontAssets?.search(query,{limit:80})||[])add(textFont(item.id));
    return fonts;
  }
  async function ensureTextFont(config){
    const chosen=textFont(config.fontFamily);
    if(chosen.name==='sans-serif')return;
    if(typeof window.OpenLiveFontAssets?.ensure!=='function')throw Error('The shared font loader is unavailable.');
    await window.OpenLiveFontAssets.ensure(chosen.name,400,{style:'normal',text:config.text});
  }
  function mediaRate(value=1){
    const rate=Number(value);
    if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(rate)||rate<.25||rate>2)
      throw Error('Playback speed must be between 0.25 and 2.');
    return rate;
  }
  function mediaDirection(value='forward'){
    if(!['forward','reverse'].includes(value))throw Error('Choose forward or reverse playback.');
    return value;
  }
  function mediaMode(config){
    const mode=config.mode??(config.loop===false?'hold':'loop');
    if(!['loop','pingpong','hold','clear'].includes(mode))throw Error('Choose Loop, Ping Pong, Play Once and Hold, or Play Once and Eject.');
    return mode;
  }
  function mediaTransition(value='cut'){
    if(!['cut','dissolve'].includes(value))throw Error('Choose Cut or Dissolve for the loop transition.');
    return value;
  }
  function mediaTransitionMs(value=250){
    const ms=Number(value);
    if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(ms)||ms<0||ms>2000)
      throw Error('Loop transition must be between 0 and 2000 ms.');
    return ms;
  }
  function checkMediaAudioOnly(config){
    if(mediaDirection(config.direction)==='reverse'||mediaMode(config)==='pingpong')
      throw Error('Reverse and Ping Pong require video. Audio-only media supports forward playback.');
  }
  // Only user-editable scalar properties enter a saved scene. Device streams,
  // object URLs and File handles remain private to this browser session.
  function savedConfig(type,config={}){
    if(type==='audience'){
      if(!window.OpenLiveAudience?.normalize)throw Error('The Audience source renderer is unavailable.');
      return window.OpenLiveAudience.normalize(config);
    }
    if(window.OpenLiveCreativeSources?.isCreative(type))
      return window.OpenLiveCreativeSources.normalize(type,config);
    const device=()=>textValue(config.device),resolution=()=>resolutions.includes(config.resolution)?config.resolution:'1920x1080';
    switch(type){
      case 'camera':return {device:device(),resolution:resolution(),fps:frameRates.includes(Number(config.fps))?Number(config.fps):30,audio:config.audio===true};
      case 'ndi':return {device:device(),audioDevice:textValue(config.audioDevice),resolution:resolution(),fps:frameRates.includes(Number(config.fps))?Number(config.fps):30};
      case 'screen':case 'window':return {audio:config.audio!==false,fps:frameRates.includes(Number(config.fps))?Number(config.fps):30};
      case 'audio-input':return {device:device(),echoCancellation:config.echoCancellation===true,noiseSuppression:config.noiseSuppression===true,autoGainControl:config.autoGainControl===true};
      case 'audio-output':return {};
      case 'browser':return {url:textValue(config.url),width:numberValue(config.width,1280),height:numberValue(config.height,720)};
      case 'live':return {input:textValue(config.input)};
      case 'image':return {fileName:textValue(config.file?.name,textValue(config.fileName))};
      case 'present':{
        const mode=config.mode||(/\.pdf$/i.test(String(config.file?.name||config.fileName||''))?'pdf':'powerpoint');
        if(!['pdf','powerpoint','powerpoint-live'].includes(mode))throw Error('Choose Imported PowerPoint or Imported PDF.');
        return {mode,fileName:textValue(config.file?.name,textValue(config.fileName)),...(mode==='powerpoint-live'?{audio:config.audio===true}:{})};
      }
      case 'media':
        if(config.replay!==undefined&&typeof config.replay!=='boolean')throw Error('Invalid replay clip setting.');
        return {fileName:textValue(config.file?.name,textValue(config.fileName)),loop:['loop','pingpong'].includes(mediaMode(config)),mode:mediaMode(config),direction:mediaDirection(config.direction),trimIn:Math.max(0,numberValue(config.trimIn,0)),trimOut:config.trimOut==null?null:numberValue(config.trimOut,null),rate:mediaRate(config.rate),loopTransition:mediaTransition(config.loopTransition),loopTransitionMs:mediaTransitionMs(config.loopTransitionMs),...(config.replay===true?{replay:true}:{})};
      case 'slideshow':return {fileNames:Array.from(config.files||config.fileNames||[],file=>typeof file==='string'?file:textValue(file?.name)),seconds:numberValue(config.seconds,5),loop:config.loop!==false};
      case 'color':return {color:textValue(config.color,'#164a8a')};
      case 'text':{
        const font=textFont(config.fontFamily);
        return {text:textValue(config.text,'Your text'),color:textValue(config.color,'#ffffff'),size:numberValue(config.size,96),...(font.name==='sans-serif'?{}:{fontFamily:font.name})};
      }
      default:throw Error('This source type is not available in the browser.');
    }
  }
  // One transport owns the same decoded element used by picture and audio.
  function mediaTransport(el,config,clock={setInterval:(fn,ms)=>setInterval(fn,ms),clearInterval:id=>clearInterval(id)}){
    let disposed=false,stopped=false,held=false,cleared=false,running=el.paused!==true&&!el.ended,error='',cycles=0,serial=0,
      direction=mediaDirection(config.direction),mode=mediaMode(config),virtualTime=Number(el.currentTime)||0;
    const listeners=new Set(),now=typeof clock.now==='function'?()=>clock.now():()=>typeof performance!=='undefined'?performance.now():Date.now();
    let previousTime=now(),pendingPlay=null;
    const playCancelled=()=>Object.assign(Error('Media playback start cancelled.'),{name:'AbortError'});
    const cancelPlay=()=>{pendingPlay?.finish(playCancelled());};
    const check=()=>{if(disposed)throw Error('This media player has been released.');};
    // Config records the requested direction. Ping Pong's current leg is runtime
    // state so a later Programme take still starts with the user's chosen leg.
    config.direction=direction;config.mode=mode;config.loop=mode==='loop'||mode==='pingpong';
    config.loopTransition=mediaTransition(config.loopTransition);config.loopTransitionMs=mediaTransitionMs(config.loopTransitionMs);
    const setRate=value=>{
      check();
      const rate=mediaRate(value),previous=el.playbackRate;
      try{el.playbackRate=rate;if(Math.abs(el.playbackRate-rate)>.001)throw Error('The browser did not accept this playback speed.');}
      catch(error){try{el.playbackRate=previous;}catch(_){}throw error;}
      config.rate=rate;previousTime=now();return rate;
    };
    // Speed is part of the saved transport, including every Programme fork.
    // Validate before installing listeners or the boundary timer.
    setRate(config.rate);
    const bounds=()=>{const duration=Number.isFinite(el.duration)?Math.max(0,el.duration):0;
      const start=Math.min(Math.max(0,Number(config.trimIn)||0),Math.max(0,duration-.01));
      const end=config.trimOut==null?duration:Math.min(duration,Math.max(start+.01,Number(config.trimOut)||duration));
      return {start,end,duration};};
    const assign=time=>{virtualTime=time;el.currentTime=time;};
    const position=(time,notify)=>{check();const {start,end,duration}=bounds();if(!duration)throw Error('Media duration is not available yet.');
      if(!Number.isFinite(time))throw Error('Enter a valid position.');if(notify)emit('reset',el.currentTime,Math.max(start,Math.min(end,time)));held=false;cleared=false;stopped=false;error='';
      assign(Math.max(start,Math.min(end,time)));previousTime=now();};
    const seek=time=>position(time,true);
    const cue=()=>{seek(direction==='reverse'?bounds().end:bounds().start);return el.currentTime;};
    const details=()=>{const {start,end,duration}=bounds();return {direction,mode,rate:config.rate,playing:!disposed&&!stopped&&!held&&!cleared&&(direction==='reverse'?running:el.paused!==true&&!el.ended),cleared,cycles,transition:config.loopTransition,transitionMs:config.loopTransitionMs,in:start,out:end,duration,error,
      audioReason:direction==='reverse'?'Reverse playback uses decoded frame seeking; audio is silent.':''};};
    // A wrap is announced before changing the decoder position. The compositor
    // can retain one outgoing frame in RAM for a bounded video-only dissolve.
    const emit=(type,from,to)=>{const {start,end}=bounds(),event={type,from,to,direction,transition:config.loopTransition,
      durationMs:Math.min(config.loopTransitionMs,Math.max(0,(end-start)/config.rate*500))};
      for(const fn of listeners)try{fn(event);}catch(_){};};
    const retireLatePlay=()=>{if(disposed||direction==='reverse'||!running||stopped||held||cleared)el.pause();};
    // Chromium can leave play() pending while a decoder is stalled. Bound that
    // wait, and settle callers immediately when their transport is cancelled.
    // A late browser resolution must never resurrect a stopped/released bus.
    const startForward=(own,{signal,timeoutMs=12000}={})=>new Promise((resolve,reject)=>{
      cancelPlay();let timer,settled=false;
      const cancel=()=>finish(playCancelled());
      const finish=failure=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        if(pendingPlay?.finish===finish)pendingPlay=null;
        failure?reject(failure):resolve();};
      pendingPlay={finish};signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted){cancel();return;}
      const limit=Math.max(50,Math.min(20000,Number(timeoutMs)||12000));
      timer=setTimeout(()=>finish(Error('Media playback did not start. Retry playback or choose another clip.')),limit);
      try{Promise.resolve(el.play()).then(()=>{
        if(disposed||own!==serial||direction==='reverse'||!running)retireLatePlay();
        finish();
      },finish);}catch(failure){finish(failure);}
    });
    const resume=()=>{const own=++serial;try{startForward(own).then(()=>{if(disposed||own!==serial||direction==='reverse'||!running)retireLatePlay();},failure=>{
      if(disposed||own!==serial)return;error=failure?.message||'Media playback could not resume.';running=false;el.pause();});}
      catch(failure){error=failure.message||String(failure);running=false;el.pause();}};
    const endpoint=from=>{
      const {start,end}=bounds(),limit=direction==='reverse'?start:end;
      cycles++;
      if(mode==='loop'){
        const target=direction==='reverse'?end:start;emit('wrap',from,target);assign(target);previousTime=now();
        if(direction==='forward'&&el.paused){running=true;resume();}
      }else if(mode==='pingpong'){
        const was=direction;emit('bounce',from,limit);assign(limit);direction=was==='forward'?'reverse':'forward';previousTime=now();
        if(direction==='reverse')el.pause();else if(running)resume();
      }else{
        running=false;serial++;held=mode==='hold';cleared=mode==='clear';el.pause();assign(limit);emit(cleared?'clear':'hold',from,limit);
      }
    };
    const boundary=()=>{
      if(disposed||stopped||held||cleared)return;
      const {start,end,duration}=bounds();if(!duration)return;
      // Browsers do not provide negative playbackRate. A reverse leg uses one
      // decoder, at most 25 seeks/second, and never stacks a seek while decoding.
      // No media files, frame arrays or reverse audio are generated or saved.
      if(direction==='reverse')return;
      if(el.paused&&!el.ended)return;
      if(el.currentTime<start)assign(start);
      if(el.currentTime>=end){running=true;endpoint(Number(el.currentTime)||end);}
    };
    const tick=()=>{
      if(disposed)return;
      const stamp=now(),elapsed=Math.max(0,stamp-previousTime)/1000;previousTime=stamp;
      if(direction!=='reverse'){boundary();return;}
      if(!running||stopped||held||cleared)return;
      const {start,end,duration}=bounds();if(!duration)return;
      virtualTime=Math.min(end,virtualTime)-elapsed*config.rate;
      if(el.seeking)return;
      if(virtualTime<=start){endpoint(Number(el.currentTime)||start);return;}
      assign(Math.max(start,virtualTime));
    };
    const onPlay=()=>{if(disposed)return;if(direction==='reverse'||!running||stopped||held||cleared){el.pause();return;}},
      // Native EOF queues a pause event. A wrap may already have invoked
      // play() before that older event is delivered, making paused=false.
      // Preserve the restarted intent; explicit Pause/Stop already invalidate
      // it synchronously and real current pauses still clear it here.
      onPause=()=>{if(direction==='forward'&&el.paused===true)running=false;};
    el.loop=false;el.addEventListener('timeupdate',boundary);el.addEventListener('ended',boundary);el.addEventListener('play',onPlay);el.addEventListener('pause',onPause);
    const timer=clock.setInterval(tick,40);
    // Test trim boundaries when decoded video frames arrive as well as on the
    // bounded fallback timer. This avoids waiting for the browser's much slower
    // timeupdate event, without reading pixels or scheduling extra decoders.
    let videoFrame=null;
    const nextFrame=()=>{if(disposed||typeof el.requestVideoFrameCallback!=='function')return;
      try{videoFrame=el.requestVideoFrameCallback(()=>{videoFrame=null;boundary();nextFrame();});}catch(_){videoFrame=null;}};
    nextFrame();
    if(direction==='reverse'){el.pause();running=false;}
    return {bounds,seek,cue,setRate,speed:setRate,details,state(){const {start,end,duration}=bounds(),atEnd=direction==='reverse'?el.currentTime<=start:el.currentTime>=end;return disposed?'Released':stopped?'Stopped':!duration?'Loading':cleared?'Cleared':held&&atEnd?'Ended':error?'Playback blocked':direction==='reverse'?(running?'Playing':'Paused'):el.ended||atEnd?'Ended':el.paused?'Paused':'Playing';},
      async play(options={}){check();if(options.signal?.aborted)throw playCancelled();const {start,end,duration}=bounds();if(!duration)throw Error('Media duration is not available yet.');
        if(cleared||held||el.currentTime<start||el.currentTime>end||direction==='reverse'&&el.currentTime<=start||direction==='forward'&&el.currentTime>=end)cue();
        stopped=false;held=false;cleared=false;error='';running=true;virtualTime=el.currentTime;previousTime=now();const own=++serial;
        if(direction==='reverse'){cancelPlay();el.pause();return;}
        try{await startForward(own,options);if(disposed||own!==serial){retireLatePlay();throw playCancelled();}running=true;}
        catch(failure){if(disposed||own!==serial)throw failure;running=false;error=failure.name==='AbortError'?'':failure.message||String(failure);el.pause();throw failure;}},
      pause(){check();emit('reset',el.currentTime,el.currentTime);serial++;running=false;cancelPlay();el.pause();stopped=false;previousTime=now();},
      stop(){check();emit('reset',el.currentTime,direction==='reverse'?bounds().end:bounds().start);serial++;running=false;cancelPlay();el.pause();position(direction==='reverse'?bounds().end:bounds().start,false);stopped=true;},
      direction(value){check();if(value===undefined)return direction;const next=mediaDirection(value),playing=details().playing;serial++;cancelPlay();
        emit('reset',el.currentTime,el.currentTime);
        direction=next;config.direction=next;error='';virtualTime=el.currentTime;previousTime=now();running=playing;
        if(next==='reverse')el.pause();else if(playing)resume();return direction;},
      mode(value){check();if(value===undefined)return mode;const next=mediaMode({mode:value});emit('reset',el.currentTime,el.currentTime);mode=next;config.mode=mode;config.loop=mode==='loop'||mode==='pingpong';return mode;},
      loop(value){check();if(value===undefined)return mode==='loop';emit('reset',el.currentTime,el.currentTime);mode=value?'loop':'hold';config.mode=mode;config.loop=!!value;},
      transition(value,ms=config.loopTransitionMs){check();const next=mediaTransition(value),duration=mediaTransitionMs(ms);emit('reset',el.currentTime,el.currentTime);config.loopTransition=next;config.loopTransitionMs=duration;return {transition:next,durationMs:duration};},
      subscribe(fn){check();if(typeof fn!=='function')throw Error('A media transport listener is required.');listeners.add(fn);return ()=>listeners.delete(fn);},
      trim(start,end){const {duration}=bounds();
        // The editor displays seconds to two decimal places. Clamp a rounded
        // full-length Out point to the decoded duration, preserving precision.
        if(Number.isFinite(end)&&end>duration&&end-duration<=.005+Number.EPSILON*Math.max(1,duration))end=duration;
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration||end-start<.01)throw Error('Trim must have 0 ≤ In < Out ≤ duration.');
        check();emit('reset',el.currentTime,el.currentTime);config.trimIn=start;config.trimOut=end;if(el.currentTime<start||el.currentTime>end)position(direction==='reverse'?end:start,false);virtualTime=el.currentTime;previousTime=now();},
      dispose(){if(disposed)return;disposed=true;serial++;running=false;cancelPlay();listeners.clear();clock.clearInterval(timer);if(videoFrame!==null)try{el.cancelVideoFrameCallback?.(videoFrame);}catch(_){}videoFrame=null;el.removeEventListener('timeupdate',boundary);el.removeEventListener('ended',boundary);el.removeEventListener('play',onPlay);el.removeEventListener('pause',onPause);}};
  }
  // Programme owns a decoder and transport of its own. Only the already-loaded
  // file URL is shared; preview seeks, trim edits and playback never touch it.
  async function forkMedia(source,{signal}={}){
    let element=null,stream=null,transport=null,disposed=false;
    const cancelled=()=>Object.assign(Error('Programme media preparation cancelled.'),{name:'AbortError'});
    const dispose=()=>{
      if(disposed)return;disposed=true;signal?.removeEventListener('abort',dispose);
      transport?.dispose();
      try{stream?.getTracks().forEach(track=>{try{track.stop();}catch(_){}});}catch(_){}
      try{element?.pause();}catch(_){}
      try{if(element){element.srcObject=null;element.removeAttribute('src');element.load?.();element.remove?.();}}catch(_){}
      // The source owns this URL. Releasing a Programme copy must leave Preview
      // and later takes able to decode the same file.
    };
    const check=()=>{if(signal?.aborted)throw cancelled();};
    // Each preparation phase owns and removes its timeout and event listeners.
    const waitFor=(event,ready,start,message)=>new Promise((resolve,reject)=>{
      let timer,settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);
        element.removeEventListener(event,loaded);element.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);
        error?reject(error):resolve();};
      const loaded=event=>{if(ready(event))finish();},failed=()=>finish(Error('The Programme media copy could not be decoded.')),
        cancel=()=>finish(cancelled());
      element.addEventListener(event,loaded);element.addEventListener('error',failed);signal?.addEventListener('abort',cancel,{once:true});
      timer=setTimeout(()=>finish(Error(message)),20000);
      if(signal?.aborted){cancel();return;}
      try{start(finish,loaded);loaded();}catch(error){finish(error);}
    });
    try{
      check();
      const preview=source?.el,url=preview?.currentSrc||preview?.src;
      if(!preview||preview.srcObject||!url)throw Error('The media source is unavailable. Choose its local file again.');
      const doc=preview.ownerDocument||(typeof document!=='undefined'?document:null);
      if(!doc?.createElement)throw Error('The media decoder is unavailable.');
      const config=savedConfig('media',source.config||source._sourceConfig||{loop:preview.loop!==false});
      const audioOnly=source.audioOnly===true||String(preview.tagName||preview.localName).toLowerCase()==='audio';
      if(audioOnly)checkMediaAudioOnly(config);
      element=doc.createElement(audioOnly?'audio':'video');
      element.muted=true;element.playsInline=true;element.autoplay=false;element.preload='auto';element.loop=false;
      signal?.addEventListener('abort',dispose,{once:true});
      let playing=false,decoded=false;
      // Priming muted playback makes captureStream expose this decoder's audio
      // tracks. It is paused and cued before the caller can put it on Programme.
      await waitFor('loadeddata',event=>{
        decoded=decoded||event?.type==='loadeddata'||element.readyState>=2;
        return decoded&&playing;
      },(finish,loaded)=>{
        element.src=url;element.load?.();
        Promise.resolve(element.play()).then(()=>{if(disposed||signal?.aborted){element.pause();return;}playing=true;loaded();},error=>finish(Error('Programme media playback could not start: '+(error.message||String(error)))));
      },'Programme media decoding timed out.');
      check();
      let reason=config.replay?'Replay clips are video-only; audio is muted.':'This media file has no audio track.';
      const capture=element.captureStream||element.mozCaptureStream;
      if(config.replay){/* Imported replays deliberately contribute no Programme audio. */}
      else if(typeof capture==='function'){
        try{stream=capture.call(element);if(stream?.getAudioTracks().some(track=>track.readyState==='live'))reason='From the prepared media file.';}
        catch(error){reason='Media audio capture failed: '+(error.message||String(error));}
      }else reason='This browser cannot capture media-file audio. Use a browser with media capture support.';
      check();element.pause();transport=mediaTransport(element,config);
      const start=config.direction==='reverse'?transport.bounds().end:transport.bounds().start;
      await waitFor('seeked',()=>!element.seeking&&Math.abs(element.currentTime-start)<.001,
        ()=>transport.cue(),'Programme media cueing timed out.');
      check();
      return {kind:'video',sourceType:'media',config,_sourceConfig:{...config},el:element,stream,transport,dispose,
        _mediaAudio:true,audio:{included:false,reason},...(audioOnly?{audioOnly:true}:{})};
    }catch(error){dispose();throw error;}
  }
  function generatedProperties(type,config){
    const color=config.color||(type==='color'?'#164a8a':'#ffffff');if(!/^#[0-9a-f]{6}$/i.test(color))throw Error('Choose a valid color.');
    if(type==='color')return {color};
    const text=String(config.text??'Your text'),size=Number(config.size??96);
    if(!text.trim()||text.length>1000)throw Error('Enter 1–1000 characters of text.');
    if(!Number.isFinite(size)||size<12||size>500)throw Error('Use a font size between 12 and 500 px.');
    return {color,text,size};
  }
  function generatedElement(type,config,doc,target){
    const {color,text,size}=generatedProperties(type,config);
    const element=target||doc.createElement('canvas');element.width=1920;element.height=1080;
    const ctx=element.getContext('2d');if(!ctx)throw Error('The canvas renderer is unavailable.');ctx.fillStyle=color;
    if(type==='color')ctx.fillRect(0,0,1920,1080);
    else{
      ctx.font=size+'px '+textFont(config.fontFamily).family;ctx.textBaseline='top';
      // A line break is an intentional new line, rather than a missing glyph.
      text.split(/\r?\n/).forEach((line,index)=>ctx.fillText(line,40,40+index*size*1.2,1840));
    }
    return element;
  }
  function restoreGenerated(type,config={},doc=document){
    if(type==='audience'){
      if(!window.OpenLiveAudience?.create)throw Error('The Audience source renderer is unavailable.');
      return window.OpenLiveAudience.create(config,{document:doc});
    }
    if(window.OpenLiveCreativeSources?.isCreative(type))
      return window.OpenLiveCreativeSources.create(type,config,{document:doc});
    if(type!=='color'&&type!=='text')throw Error('Only color and text sources can be restored without a device or local file.');
    const normalized=savedConfig(type,config);
    if(type==='text'&&normalized.fontFamily){
      // A restored web font is a loading source until the selected face and
      // required glyph subsets are ready. Never paint fallback text as Ready.
      generatedProperties(type,normalized);
      const el=doc.createElement('canvas');el.width=1920;el.height=1080;
      let disposed=false,state='loading',error='',pending=null;
      const runtime={kind:type,sourceType:type,config:normalized,_sourceConfig:{...normalized},el,
        runtimeStatus:()=>({ok:state==='ready',state,why:error|| (state==='loading'?'Loading '+normalized.fontFamily+'…':'')}),
        prepare(){
          if(disposed)return Promise.reject(Error('Source preparation cancelled.'));
          if(pending)return pending;
          pending=ensureTextFont(normalized).then(()=>{if(disposed)throw Error('Source preparation cancelled.');generatedElement(type,normalized,doc,el);state='ready';return runtime;})
            .catch(reason=>{if(!disposed){state='failed';error=reason.message||String(reason);}throw reason;});
          return pending;
        },
        dispose(){if(disposed)return;disposed=true;state='ended';el.width=el.height=1;el.remove?.();}
      };
      return runtime;
    }
    const el=generatedElement(type,normalized,doc);let disposed=false;
    return {kind:type,sourceType:type,config:normalized,_sourceConfig:{...normalized},el,dispose(){if(disposed)return;disposed=true;el.remove?.();}};
  }
  function fileKind(file,type){
    const mime=String(file?.type||'').toLowerCase(),name=String(file?.name||''),unknown=!mime||mime==='application/octet-stream';
    const image=/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico|apng|tiff?)$/i.test(name);
    if(type==='image')return /^image\//.test(mime)||unknown&&image?'image':null;
    if(/^audio\//.test(mime))return 'audio';
    if(/^video\//.test(mime))return 'video';
    if(unknown&&/\.(?:mp3|wav|wave|aac|m4a|flac|oga|opus|aiff?|wma)$/i.test(name))return 'audio';
    return unknown&&/\.(?:mp4|m4v|webm|mov|avi|mkv|ogv|ogg|mpg|mpeg|m2ts|mts|ts|3gp|flv|wmv)$/i.test(name)?'video':null;
  }
  function create({document:doc=document,mediaDevices=navigator.mediaDevices,liveInputs=()=>[],openLive,openBrowser,urls=URL,now,clock={setInterval:(fn,ms)=>setInterval(fn,ms),clearInterval:id=>clearInterval(id)}}={}){
    return async function acquire(type,config={},signal){
      let stream=null,element=null,url=null,live=null,disposed=false,slideTimer=null,mediaKind=null,transport=null;
      const slideUrls=[],slides=[];
      const describe=result=>({...result,sourceType:type,config:savedConfig(type,config),_sourceConfig:{...config}});
      const dispose=()=>{
        if(disposed)return;disposed=true;transport?.dispose();
        if(slideTimer!==null)clock.clearInterval(slideTimer);
        slides.forEach(img=>{img.removeAttribute('src');img.remove();});
        slideUrls.forEach(value=>urls.revokeObjectURL(value));
        try{stream?.getTracks().forEach(t=>t.stop());}catch(_){}
        try{live?.stop?.();}catch(_){}
        try{element?.pause?.();if(element){element.srcObject=null;element.removeAttribute('src');element.load?.();element.remove();}}catch(_){}
        if(url)urls.revokeObjectURL(url);
      };
      const check=()=>{if(signal?.aborted){dispose();throw Error('Source preparation cancelled.');}};
      try{
        check();
        if(type==='present'){
          if(!window.OpenLivePresentationSource?.acquire)throw Error('The Present source renderer is unavailable.');
          const {_onProgress,...properties}=config;
          return await window.OpenLivePresentationSource.acquire(properties,signal,{document:doc,mediaDevices,urls,onProgress:_onProgress});
        }else if(type==='audience'){
          if(!window.OpenLiveAudience?.create)throw Error('The Audience source renderer is unavailable.');
          const generated=window.OpenLiveAudience.create(config,{document:doc}),cancel=()=>generated.dispose();
          signal?.addEventListener?.('abort',cancel,{once:true});
          try{if(signal?.aborted)throw Error('Source preparation cancelled.');await generated.prepare();if(signal?.aborted)throw Error('Source preparation cancelled.');return generated;}
          catch(error){generated.dispose();throw error;}finally{signal?.removeEventListener?.('abort',cancel);}
        }else if(window.OpenLiveCreativeSources?.isCreative(type)){
          const generated=window.OpenLiveCreativeSources.create(type,config,{document:doc,...(now?{now}:{})});
          try{
            if(signal?.aborted)throw Error('Source preparation cancelled.');
            await generated.prepare?.();
            if(signal?.aborted)throw Error('Source preparation cancelled.');
            return generated;
          }catch(error){generated.dispose();throw error;}
        }else if(type==='browser'){
          if(!openBrowser)throw Error('The browser source provider is unavailable.');
          const result=await openBrowser(config,signal);if(signal?.aborted){result?.dispose?.();throw Error('Source preparation cancelled.');}return describe(result);
        }else if(type==='ndi'){
          if(!mediaDevices?.getUserMedia||!mediaDevices?.enumerateDevices)throw Error('NDI Webcam capture is unavailable in this browser.');
          if(!config.device)throw Error('Select an NDI video device. Start NDI Webcam Input, select its network feed, then refresh devices.');
          const devices=await mediaDevices.enumerateDevices();check();
          const hasDevice=(id,kind)=>devices.some(d=>d.deviceId===id&&d.kind===kind&&isNDIDevice(d));
          if(!hasDevice(config.device,'videoinput'))throw Error('The selected NDI video device is not visible. Allow camera access for SHOWAVE and refresh devices. No other camera was opened.');
          if(config.audioDevice&&!hasDevice(config.audioDevice,'audioinput'))throw Error('The selected NDI audio device is not visible. Allow microphone access for SHOWAVE and refresh devices, or choose Video only. No other microphone was opened.');
          const resolution=String(config.resolution||'1920x1080'),fps=Number(config.fps??30);
          if(!['1920x1080','1280x720','640x480'].includes(resolution)||![25,30,50,60].includes(fps))throw Error('Choose a supported requested resolution and frame rate.');
          const [width,height]=resolution.split('x').map(Number);
          stream=await mediaDevices.getUserMedia({
            video:{deviceId:{exact:config.device},width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps}},
            audio:config.audioDevice?{deviceId:{exact:config.audioDevice},echoCancellation:false,noiseSuppression:false,autoGainControl:false}:false
          });check();
          if(!stream.getVideoTracks().some(t=>t.readyState==='live'))throw Error('The NDI capture device did not provide a live video track. Check NDI Webcam Input.');
          if(config.audioDevice&&!stream.getAudioTracks().some(t=>t.readyState==='live'))throw Error('The selected NDI audio device did not provide a live audio track. Choose Video only or reconnect its audio device.');
        }else if(type==='audio-output'){
          if(!mediaDevices?.getDisplayMedia)throw Error('Shared desktop/tab audio is unavailable in this browser.');
          stream=await mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'});
          check();
          if(!stream.getAudioTracks().some(track=>track.readyState==='live'))throw Error('No shared audio was provided. Choose a tab or screen offering Share audio and enable it. This browser/OS may not support system audio.');
          // Keep the chooser-owned video track for the sharing lifetime, but do
          // not decode/display it. Only audio tracks enter the Programme bus.
          return describe({kind:'audio',audioOnly:true,el:null,stream,dispose});
        }else if(type==='audio-input'){
          if(!mediaDevices?.getUserMedia)throw Error('Audio input capture is unavailable in this browser.');
          stream=await mediaDevices.getUserMedia({video:false,audio:{...(config.device?{deviceId:{exact:config.device}}:{}),
            echoCancellation:config.echoCancellation===true,noiseSuppression:config.noiseSuppression===true,autoGainControl:config.autoGainControl===true}});
          check();
          if(!stream.getAudioTracks().some(track=>track.readyState==='live'))throw Error('The device did not provide a live audio track.');
          return describe({kind:'audio',audioOnly:true,el:null,stream,dispose});
        }else if(type==='slideshow'){
          const files=Array.from(config.files||[]),seconds=Number(config.seconds??5);
          if(!files.length||files.length>32||files.some(file=>!fileKind(file,'image')))throw Error('Choose 1–32 image files for the slide show.');
          if(files.some(f=>f.size>25*1024*1024)||files.reduce((n,f)=>n+(f.size||0),0)>128*1024*1024)throw Error('Use images under 25 MB each and 128 MB total.');
          if(!Number.isFinite(seconds)||seconds<1||seconds>3600)throw Error('Slide duration must be between 1 and 3600 seconds.');
          for(const file of files){
            check();const img=doc.createElement('img'),src=urls.createObjectURL(file);slides.push(img);slideUrls.push(src);
            await new Promise((resolve,reject)=>{
              let timer,settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);img.removeEventListener('load',loaded);img.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
              const loaded=()=>finish(),failed=()=>finish(Error('Could not decode slide: '+(file.name||'image'))),cancel=()=>finish(Error('Source preparation cancelled.'));
              img.addEventListener('load',loaded,{once:true});img.addEventListener('error',failed,{once:true});signal?.addEventListener('abort',cancel,{once:true});
              timer=setTimeout(()=>finish(Error('Slide decoding timed out.')),20000);
              try{img.src=src;}catch(error){finish(error);}
            });
            check();
          }
          element=doc.createElement('canvas');element.width=1920;element.height=1080;
          const ctx=element.getContext('2d');if(!ctx)throw Error('The canvas renderer is unavailable.');
          let index=0;
          const draw=()=>{const img=slides[index],w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
            if(!w||!h)throw Error('The slide has no decoded image dimensions.');
            const scale=Math.min(1920/w,1080/h);ctx.clearRect(0,0,1920,1080);ctx.drawImage(img,(1920-w*scale)/2,(1080-h*scale)/2,w*scale,h*scale);};
          draw();if(slides.length>1)slideTimer=clock.setInterval(()=>{
            if(disposed)return;
            if(index===slides.length-1&&config.loop===false){clock.clearInterval(slideTimer);slideTimer=null;return;}
            index=(index+1)%slides.length;draw();
          },seconds*1000);
          return describe({kind:'slideshow',el:element,dispose});
        }else if(type==='camera'){
          if(!mediaDevices?.getUserMedia)throw Error('Camera capture is unavailable in this browser.');
          const resolution=String(config.resolution||'1920x1080'),fps=Number(config.fps??30);
          if(!resolutions.includes(resolution)||!frameRates.includes(fps))throw Error('Choose a supported requested resolution and frame rate.');
          const [width,height]=resolution.split('x').map(Number);
          stream=await mediaDevices.getUserMedia({video:{width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps},...(config.device?{deviceId:{exact:config.device}}:{})},audio:config.audio===true});
          check();
          if(!stream.getVideoTracks().some(track=>track.readyState==='live'))throw Error('The selected camera did not provide a live video track. Reconnect the device.');
        }else if(type==='screen'||type==='window'){
          if(!mediaDevices?.getDisplayMedia)throw Error('Display capture is unavailable in this browser.');
          const fps=Number(config.fps??30);if(!frameRates.includes(fps))throw Error('Choose a supported requested frame rate.');
          stream=await mediaDevices.getDisplayMedia({video:{frameRate:{ideal:fps},...(type==='window'?{displaySurface:'window'}:{})},audio:config.audio!==false});
          check();
          if(!stream.getVideoTracks().some(track=>track.readyState==='live'))throw Error('The selected display or window did not provide a live video track. Share it again.');
        }else if(type==='live'){
          const input=liveInputs().find(i=>i.id===config.input);if(!input||!openLive)throw Error('Select an available SHOWAVE output.');
          live=await openLive(input);stream=live?.stream;if(!stream)throw Error('The SHOWAVE output did not provide a capture stream.');
        }else if(type==='image'||type==='media'){
          const file=config.file;if(!file)throw Error('Choose a local file first.');
          mediaKind=fileKind(file,type);
          if(!mediaKind)throw Error(type==='image'?'Choose an image file.':'Choose an audio or video file.');
          if(type==='media'&&mediaKind==='audio')checkMediaAudioOnly(config);
          url=urls.createObjectURL(file);
        }else if(type==='color'||type==='text'){
          const generated=restoreGenerated(type,config,doc);generated._sourceConfig={...config,...generated.config};let cancel;
          try{
            check();
            if(generated.prepare)await new Promise((resolve,reject)=>{
              cancel=()=>{generated.dispose();reject(Error('Source preparation cancelled.'));};
              signal?.addEventListener('abort',cancel,{once:true});
              if(signal?.aborted){cancel();return;}
              generated.prepare().then(resolve,reject);
            });
            check();return generated;
          }catch(error){generated.dispose();throw error;}
          finally{if(cancel)signal?.removeEventListener('abort',cancel);}
        }else throw Error('This source type is not available in the browser.');
        check();element=doc.createElement(type==='image'?'img':mediaKind==='audio'?'audio':'video');
        if(type!=='image'){element.muted=true;element.playsInline=true;element.autoplay=true;element.loop=type==='media'&&config.loop!==false;}
        await new Promise((resolve,reject)=>{
          const event=type==='image'?'load':'loadeddata',waitForPlayback=type==='media'&&config.replay===true;let timer,settled=false,decoded=false,playing=false;
          const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);element.removeEventListener(event,loaded);element.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
          const loaded=()=>{decoded=true;if(!waitForPlayback||playing)finish();},failed=()=>finish(Error('This file or capture could not be decoded. Try another format or source.')),cancel=()=>finish(Error('Source preparation cancelled.'));
          element.addEventListener(event,loaded,{once:true});element.addEventListener('error',failed,{once:true});signal?.addEventListener('abort',cancel,{once:true});
          timer=setTimeout(()=>finish(Error('No picture received within 20 seconds. Check the device/file and retry.')),20000);
          try{
            if(stream)element.srcObject=stream;else element.src=url;
            if(type!=='image')element.play().then(()=>{if(disposed||signal?.aborted){element.pause();return;}playing=true;if(waitForPlayback&&decoded)finish();},error=>finish(Error('Playback could not start: '+error.message)));
          }catch(error){finish(error);}
        });
        check();
        // Containers such as Ogg and MP4 can hold audio without a video track.
        // The decoded dimensions and real captured tracks decide that case;
        // an extension alone cannot distinguish the container's contents.
        if(mediaKind==='audio'||type==='media'&&'videoWidth' in element&&element.videoWidth===0&&element.videoHeight===0){
          if(type==='media')checkMediaAudioOnly(config);
          const capture=element.captureStream||element.mozCaptureStream;
          if(typeof capture!=='function')throw Error('This browser cannot capture media-file audio. Use a browser with media capture support.');
          stream=capture.call(element);check();
          if(!stream.getAudioTracks().some(track=>track.readyState==='live'))throw Error('The selected media file did not provide a live audio track.');
          mediaKind='audio';
        }
        const result=describe({kind:type==='media'?'video':type==='window'?'screen':type==='live'?'showave':type,el:element,stream,dispose,
          ...(mediaKind==='audio'?{audioOnly:true}:{}),...(type==='live'?{_showaveId:config.input}:{})});
        if(type==='media'){transport=mediaTransport(element,result.config,clock);result.transport=transport;if(transport.bounds().duration){transport.cue();if(result.config.direction==='reverse')await transport.play();}}
        return result;
      }catch(error){dispose();throw error;}
    };
  }
  return Object.freeze({create,isNDIDevice,savedConfig,restoreGenerated,mediaTransport,forkMedia,textFonts});
})();
