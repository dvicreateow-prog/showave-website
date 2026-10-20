/* Present in Broadcast. Original presentations and decoded frames stay in session.
   A Programme take owns its canvas and slide cursor; it shares the original
   PDF/PowerPoint document with Preview, never its controls. Imported PowerPoint
   uses OpenLive's independent OOXML player and does not require Office.
   UNDOCUMENTED — inferring: document presentation is an operator-requested
   extension to the source/live-input workflow documented in manual/sources.htm. */
window.OpenLivePresentationSource=(()=>{
  'use strict';
  const cancelled=message=>Object.assign(new Error(message||'Presentation preparation cancelled.'),{name:'AbortError'});
  const checkSignal=signal=>{if(signal?.aborted)throw cancelled();};
  const isLive=source=>source?.config?.mode==='powerpoint-live';
  const powerpointFile=file=>/\.(pptx|pptm|ppsx|ppsm)$/i.test(String(file?.name||''));
  const cleanConfig=(file,config={})=>({mode:file?(powerpointFile(file)?'powerpoint':'pdf'):config.mode==='powerpoint'?'powerpoint':'pdf',
    fileName:String(file?.name||config.fileName||'Presentation').slice(0,512)});

  async function acquire(config={},signal,options={}){
    checkSignal(signal);
    const file=config.file,doc=options.document||document;
    if(config.mode==='powerpoint-live'&&!file)throw new Error('Choose the original PowerPoint file to reconnect it with OpenLive\'s independent player. External slideshows use a separate Window Capture source.');
    if(!file)throw new Error('Choose an original PowerPoint or PDF file for this presentation.');
    const mode=powerpointFile(file)?'powerpoint':/\.pdf$/i.test(String(file.name||''))?'pdf':null;
    if(!mode)throw new Error('Choose a PDF or a PowerPoint OOXML file (.pptx, .pptm, .ppsx or .ppsm).');
    const provider=mode==='powerpoint'?window.OpenLivePowerPoint:window.OpenLiveDocuments;
    if(typeof provider?.openPlayer!=='function')throw new Error('The original '+(mode==='powerpoint'?'PowerPoint':'PDF')+' player is unavailable in this build.');
    const player=await provider.openPlayer(file,{...options,signal,document:doc});
    try{checkSignal(signal);return originalPresentationRuntime(player,cleanConfig(file,config));}
    catch(error){player.release?.();throw error;}
  }

  async function fork(source,options={}){
    if(isLive(source)){
      if(!window.OpenLivePowerPointSource?.fork)throw new Error('PowerPoint Live is unavailable in this build.');
      return window.OpenLivePowerPointSource.fork(source,options);
    }
    if(source?._presentationPlayer){
      checkSignal(options.signal);const player=source._presentationPlayer,state=player.state();
      if(state.disposed)throw new Error('This presentation is unavailable. Choose its original file again.');
      if(state.busy)throw new Error('Wait for the presentation slide to finish preparing before taking it.');
      const copy=player.fork();
      try{checkSignal(options.signal);return originalPresentationRuntime(copy,cleanConfig(null,source.config));}
      catch(error){copy.release?.();throw error;}
    }
    throw new Error('This presentation is unavailable. Choose its original file again.');
  }

  function originalPresentationRuntime(player,config){
    let released=false,unsubscribe=null;
    const captures=new Map(),listeners=new Map();let audioStream=null;
    if(config.mode==='powerpoint'&&typeof window.MediaStream==='function'){
      try{audioStream=new window.MediaStream();}catch(_){/* Audio support cannot prevent the original slide picture from loading. */}
    }
    const audio={included:false,reason:'This presentation has no active embedded audio track.'};
    const announce=type=>{if(audioStream&&typeof audioStream.dispatchEvent==='function'&&typeof window.Event==='function')audioStream.dispatchEvent(new window.Event(type));};
    // Media belongs to this player view. Capture its existing decoder, keep
    // local element monitoring silent, and leave gain/monitoring to Studio's
    // established bus mixer. A Programme fork never borrows Preview tracks.
    function syncAudio(){
      if(released||config.mode!=='powerpoint')return;
      const elements=Array.from(player.mediaElements||[]),wanted=new Set();let failure='';
      for(const element of elements){
        element.muted=true;
        if(!listeners.has(element)){
          const fn=()=>syncAudio();for(const event of ['loadedmetadata','canplay','playing'])element.addEventListener?.(event,fn);
          listeners.set(element,fn);
        }
        if(!audioStream){failure='This browser cannot route embedded presentation audio through Studio.';continue;}
        if(!captures.has(element)&&element.readyState>=2){
          const capture=element.captureStream||element.mozCaptureStream;
          if(typeof capture!=='function'){failure='This browser cannot capture embedded media audio for Studio.';continue;}
          try{const stream=capture.call(element),fn=()=>syncAudio();stream.addEventListener?.('addtrack',fn);stream.addEventListener?.('removetrack',fn);captures.set(element,{stream,fn});}
          catch(error){failure='Embedded media audio capture failed: '+(error.message||String(error));continue;}
        }
        for(const track of captures.get(element)?.stream?.getAudioTracks?.()||[])if(track.readyState!=='ended')wanted.add(track);
      }
      for(const [element,fn] of listeners)if(!elements.includes(element)){
        for(const event of ['loadedmetadata','canplay','playing'])element.removeEventListener?.(event,fn);listeners.delete(element);
      }
      for(const [element,capture] of captures)if(!elements.includes(element)){
        capture.stream.removeEventListener?.('addtrack',capture.fn);capture.stream.removeEventListener?.('removetrack',capture.fn);
        captures.delete(element);for(const track of capture.stream.getTracks?.()||[])try{if(track.readyState!=='ended')track.stop();}catch(_){}
      }
      if(audioStream){
        for(const track of audioStream.getAudioTracks())if(!wanted.has(track)){audioStream.removeTrack(track);announce('removetrack');}
        for(const track of wanted)if(!audioStream.getAudioTracks().includes(track)){audioStream.addTrack(track);announce('addtrack');}
      }
      audio.included=wanted.size>0;audio.reason=audio.included?'Embedded media audio is routed through the Studio mixer.':failure||'This presentation has no active embedded audio track.';
    }
    const source={kind:'presentation',sourceType:'present',config:{...config},_sourceConfig:{...config},
      el:player.el,presentationControls:player,originalSource:player.originalSource,stream:audioStream,audio,_managedStreamLifetime:!!audioStream,
      renderFrame(){if(!released){player.frame();syncAudio();}},
      dispose(){if(released)return;released=true;unsubscribe?.();
        for(const [element,fn] of listeners)for(const event of ['loadedmetadata','canplay','playing'])element.removeEventListener?.(event,fn);
        listeners.clear();for(const {stream,fn} of captures.values()){stream.removeEventListener?.('addtrack',fn);stream.removeEventListener?.('removetrack',fn);for(const track of stream.getTracks?.()||[])try{if(track.readyState!=='ended')track.stop();}catch(_){}}
        captures.clear();for(const track of audioStream?.getTracks?.()||[])try{if(track.readyState!=='ended')track.stop();}catch(_){}return player.release();},
      runtimeStatus(){syncAudio();const state=player.state(),ready=!state.disposed&&state.ready===true&&!!player.frame();
        return {ok:ready,state:state.disposed?'ended':ready?'ready':state.error?'failed':'loading',
          why:state.disposed?'The presentation source was removed.':ready?null:state.error||'Preparing presentation.',
          warnings:player.unsupported||[]};}};
    // RAM lease survives Studio's shallow source records; metadata serializers
    // never include this original File or renderer handle.
    Object.defineProperty(source,'_presentationPlayer',{value:player,enumerable:true});
    player.setMuted?.(true);syncAudio();unsubscribe=player.subscribe?.(syncAudio)||null;
    return source;
  }

  const shapes={first:'M5 3v10M13 3 6 8l7 5Z',previous:'m11 3-7 5 7 5Z',next:'m5 3 7 5-7 5Z',last:'M11 3v10M3 3l7 5-7 5Z',
    play:'m5 3 7 5-7 5Z',pause:'M5 3v10M11 3v10',stop:'M4 4h8v8H4Z'};
  function programmeSources(studio){
    const seen=new Set(),result=[];
    for(const slot of studio?.active?.()?.slots||[]){
      if(!slot.sourceId||seen.has(slot.sourceId))continue;seen.add(slot.sourceId);
      const runtime=studio.programmeMedia?.(slot.sourceId);
      if(runtime?.sourceType==='present'&&runtime.presentationControls)result.push(runtime);
    }
    return result;
  }
  function presentationState(runtime){
    try{
      if(typeof runtime?.presentationControls?.state==='function')return runtime.presentationControls.state();
      const state=runtime?.presentationControls?.snapshot?.();
      return state?{index:Math.max(0,(Number(state.slide)||1)-1),count:Number(state.slideCount)||0,
        busy:!!state.busy,error:state.error||'',disposed:false}:null;
    }catch(_){return null;}
  }
  function mountControls(root,{source,getProgramme=()=>null,getProgrammeSources,guard=()=>true,onError=()=>{},
    initialBus='preview',initialProgrammeId=null,onBusChange=()=>{},onProgrammeChange=()=>{},document:doc=document}={}){
    const section=doc.createElement('section');section.className='bc-present-player bc-present-workbench';
    const make=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    const header=make('header','mon-head bc-present-head','Present');section.appendChild(header);
    const title=make('div','bc-present-title',source?.label||source?.name||source?.config?.fileName||'Presentation');section.appendChild(title);
    const buses=make('div','bc-present-buses'),preview=make('button','btn on','Preview'),programme=make('button','btn','Programme');
    for(const [button,label] of [[preview,'Control presentation in Preview'],[programme,'Control presentation in Programme']]){
      button.type='button';button.setAttribute('aria-label',label);buses.appendChild(button);
    }
    section.appendChild(buses);
    const liveChooser=make('select','bc-present-live-source');liveChooser.setAttribute('aria-label','Programme presentation');liveChooser.hidden=true;section.appendChild(liveChooser);
    const overview=make('div','bc-present-bus-status');overview.setAttribute('aria-live','polite');section.appendChild(overview);
    const toolbar=make('div','bc-present-controls bc-present-transport');toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','Presentation slide navigation');
    const actions=new Map();
    for(const [name,label] of [['first','First slide'],['previous','Previous slide'],['next','Next slide'],['last','Last slide']]){
      const button=make('button','btn bc-present-action');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.setAttribute('data-present-action',name);
      button.innerHTML='<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="'+shapes[name]+'" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      actions.set(name,button);toolbar.appendChild(button);
    }
    const count=make('span','bc-present-count','N/A');count.setAttribute('aria-live','polite');toolbar.appendChild(count);section.appendChild(toolbar);
    const chooser=make('select','bc-present-slides');chooser.setAttribute('aria-label','Presentation slide');section.appendChild(chooser);
    const progress=make('input','bc-present-progress');progress.type='range';progress.min='0';progress.step='1';progress.setAttribute('aria-label','Presentation slide position');section.appendChild(progress);
    const mediaToolbar=make('div','bc-present-controls bc-present-media');mediaToolbar.hidden=true;mediaToolbar.setAttribute('role','group');mediaToolbar.setAttribute('aria-label','Embedded slide media');
    const mediaActions=new Map();
    for(const [name,label] of [['play','Play slide media'],['pause','Pause slide media'],['stop','Stop slide media']]){
      const button=make('button','btn bc-present-action');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.setAttribute('data-present-media-action',name);
      button.innerHTML='<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="'+shapes[name]+'" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      mediaActions.set(name,button);mediaToolbar.appendChild(button);
    }
    const mediaStatus=make('span','bc-present-media-status');mediaStatus.setAttribute('aria-live','polite');mediaToolbar.appendChild(mediaStatus);section.appendChild(mediaToolbar);
    const links=make('div','bc-present-links');links.hidden=true;section.appendChild(links);
    const notes=make('details','bc-present-private-notes');notes.hidden=true;notes.appendChild(make('summary','','Speaker notes · private'));
    const notesBody=make('p','bc-present-note');notes.appendChild(notesBody);section.appendChild(notes);
    const nativeHost=make('div','bc-present-native-host');nativeHost.hidden=true;section.appendChild(nativeHost);
    const status=make('div','bc-present-status');status.setAttribute('role','status');section.appendChild(status);
    const note=make('p','bc-present-note');section.appendChild(note);root.appendChild(section);
    let bus=initialBus==='programme'?'programme':'preview',programmeId=initialProgrammeId,
      destroyed=false,viewError='',watched=null,unsubscribe=null,nativeView=null,nativeRuntime=null,liveSignature='',
      contentPlayer=null,playerOwner=null,linksSignature='',linksRuntime=null;
    const candidates=()=>{
      const values=typeof getProgrammeSources==='function'?getProgrammeSources():[getProgramme(source)];
      return (values||[]).filter(runtime=>runtime?.presentationControls&&!presentationState(runtime)?.disposed);
    };
    const programmeSource=()=>{
      const values=candidates();return values.find(runtime=>String(runtime.id)===String(programmeId))||
        values.find(runtime=>runtime.id&&runtime.id===source.id)||values[0]||null;
    };
    const current=()=>bus==='programme'?programmeSource():source;
    const safe=runtime=>!destroyed&&guard()&&runtime&&current()===runtime&&!presentationState(runtime)?.disposed;
    const label=runtime=>runtime?.label||runtime?.name||runtime?.config?.fileName||'Presentation';
    const slideCount=runtime=>{const state=presentationState(runtime);return state?.count?`${state.index+1} / ${state.count}`:'N/A';};
    function refresh(){
      if(destroyed)return;
      const liveSources=candidates(),live=programmeSource(),runtime=current(),state=presentationState(runtime),native=isLive(runtime);
      const valid=safe(runtime)&&!!state&&state.count>0,busy=!!state?.busy;
      if(runtime!==watched){
        unsubscribe?.();contentPlayer?.release(playerOwner);contentPlayer=null;playerOwner=null;watched=runtime;
        if(runtime&&window.OpenLiveBroadcastPlayer?.create){playerOwner={};contentPlayer=window.OpenLiveBroadcastPlayer.create(runtime,{owner:playerOwner,guard:()=>safe(runtime)});}
        unsubscribe=runtime?.presentationControls?.subscribe?.(refresh)||null;
      }
      contentPlayer?.refresh();
      if(contentPlayer)section.setAttribute('data-content-player',contentPlayer.reference.kind);
      preview.classList.toggle('on',bus==='preview');programme.classList.toggle('on',bus==='programme');
      preview.setAttribute('aria-pressed',String(bus==='preview'));programme.setAttribute('aria-pressed',String(bus==='programme'));
      preview.disabled=!guard();programme.disabled=!guard()||!live;
      preview.title='Control the selected presentation in Preview';programme.title=live?'Control the presentation already in Programme':'Cut/Fade a presentation to Programme first';
      title.textContent=bus==='programme'?'Programme · '+(runtime?label(runtime):'No presentation'):'Preview · '+label(source);
      overview.textContent='Preview '+slideCount(source)+' · Programme '+slideCount(live);
      const signature=JSON.stringify(liveSources.map((item,index)=>[item.id||String(index),label(item)]));
      if(signature!==liveSignature){
        liveSignature=signature;liveChooser.replaceChildren();
        liveSources.forEach((item,index)=>{const option=make('option','',label(item));option.value=String(item.id||index);liveChooser.appendChild(option);});
      }
      liveChooser.hidden=bus!=='programme'||liveSources.length<2;liveChooser.disabled=!guard()||!live;
      liveChooser.value=live?String(live.id||liveSources.indexOf(live)):'';
      section.classList.toggle('is-programme',bus==='programme');section.setAttribute('data-presentation-bus',bus);
      toolbar.hidden=chooser.hidden=progress.hidden=native;nativeHost.hidden=!native;
      if(nativeRuntime!==runtime||!native){
        nativeView?.destroy();nativeView=null;nativeRuntime=native?runtime:null;
        if(native&&window.OpenLivePowerPointSource?.mountControls)nativeView=window.OpenLivePowerPointSource.mountControls(nativeHost,{
          source:runtime,getProgramme:()=>candidates().find(candidate=>candidate===runtime||runtime.id&&candidate.id===runtime.id)||null,
          guard:()=>safe(runtime),onError,document:doc});
      }
      nativeView?.refresh();
      if(chooser.options.length!==(valid?state.count:0)){
        chooser.replaceChildren();if(valid)for(let n=0;n<state.count;n++){const option=make('option','',`Slide ${n+1}`);option.value=String(n);chooser.appendChild(option);}
      }
      chooser.disabled=progress.disabled=!valid||busy;
      chooser.value=valid?String(state.index):'';progress.max=String(valid?state.count-1:0);progress.value=String(valid?state.index:0);
      progress.setAttribute('aria-valuetext',valid?`Slide ${state.index+1} of ${state.count}`:'No presentation available');
      count.textContent=valid?`${state.index+1} / ${state.count}`:'N/A';
      for(const [name,button] of actions){button.disabled=!valid||busy||contentPlayer&&!contentPlayer.supports(name)||((name==='first'||name==='previous')?state.index<=0:state.index>=state.count-1);}
      const slide=!native&&valid?runtime.presentationControls.getSlide?.(state.index):null,
        media=!native&&valid?runtime.presentationControls.mediaState?.():null;
      mediaToolbar.hidden=!slide?.media?.length;
      for(const [name,button] of mediaActions)button.disabled=!valid||busy||!contentPlayer?.supports(name);
      mediaStatus.textContent=media?.error||((media?.items||[]).some(item=>item.error)?'Media needs attention':media?.playing?'Playing':(media?.items||[]).some(item=>!item.ready)?'Preparing media…':'Paused');
      if(slide?.media?.some(item=>item.type==='audio'||item.type==='video')&&runtime.audio?.included===false)mediaStatus.title=runtime.audio.reason||'';
      else mediaStatus.title='';
      notes.hidden=!slide?.notes;notesBody.textContent=slide?.notes||'';
      const nextLinksSignature=JSON.stringify([state?.index,busy,slide?.links||[]]);
      if(nextLinksSignature!==linksSignature||runtime!==linksRuntime){
        linksSignature=nextLinksSignature;linksRuntime=runtime;links.replaceChildren();
        for(const link of slide?.links||[]){
          if(Number.isInteger(link.targetIndex)&&link.targetIndex>=0&&link.targetIndex<state.count){
            const button=make('button','btn',link.label||'Slide '+(link.targetIndex+1));button.type='button';button.disabled=busy;
            button.addEventListener('click',()=>{if(safe(runtime))perform('goto',link.targetIndex);});links.appendChild(button);
          }else{
            let href;try{const url=new URL(link.href,doc.baseURI);if(['http:','https:','mailto:'].includes(url.protocol))href=url.href;}catch(_){}
            if(!href)continue;const anchor=make('a','btn',link.label||href);anchor.href=href;anchor.target='_blank';anchor.rel='noopener noreferrer';links.appendChild(anchor);
          }
        }
      }
      links.hidden=!links.children.length;
      const warnings=slide?.unsupported||[];
      status.textContent=viewError||state?.error||(native&&!nativeView?'External PowerPoint controls are unavailable in this build.':busy?'Preparing slide…':!valid?(bus==='programme'?'Programme has no presentation. Use Cut/Fade to take a presentation from Preview.':'This presentation is unavailable.'):warnings.length?'Unsupported content: '+warnings.map(item=>item.message||item.code).join('; '):'');
      note.textContent=native?'PowerPoint is a live capture. Native slide commands change every bus using this captured slideshow.':bus==='programme'?'Programme controls change the live presentation shown above.':'Preview controls prepare slides. Use Programme to advance its live feed; Cut/Fade takes the Preview scene.';
    }
    async function perform(command,value){
      const runtime=current();if(!safe(runtime)||isLive(runtime)||presentationState(runtime)?.busy)return;
      if(runtime!==watched){refresh();return;}
      viewError='';
      try{
        if(contentPlayer)await contentPlayer.command(command,value);
        else{
          const controls=runtime.presentationControls;
          await (command==='first'?controls.first():command==='last'?controls.last():command==='goto'?controls.go(value):command==='play'?controls.playMedia?.():command==='pause'?controls.pauseMedia?.():command==='stop'?controls.stopMedia?.():controls.step(command==='previous'?-1:1));
        }
        if(!safe(runtime))return;
      }
      catch(reason){if(!safe(runtime)||reason.name==='AbortError')return;viewError=reason.message||String(reason);onError(reason);}
      finally{if(!destroyed)refresh();}
    }
    const events=[];const listen=(node,event,fn)=>{node.addEventListener(event,fn);events.push([node,event,fn]);};
    listen(preview,'click',()=>{if(!guard()||destroyed)return;bus='preview';onBusChange(bus);viewError='';refresh();});
    listen(programme,'click',()=>{if(!guard()||destroyed||programme.disabled)return;bus='programme';onBusChange(bus);viewError='';refresh();});
    listen(liveChooser,'change',()=>{if(!guard()||destroyed)return;programmeId=liveChooser.value;onProgrammeChange(programmeId);viewError='';refresh();});
    for(const [name,button] of actions)listen(button,'click',()=>perform(name));
    for(const [name,button] of mediaActions)listen(button,'click',()=>perform(name));
    listen(chooser,'change',()=>{const target=Number(chooser.value);perform('goto',target);});
    listen(progress,'change',()=>{const target=Number(progress.value);perform('goto',target);});
    refresh();
    return {refresh,destroy(){if(destroyed)return;destroyed=true;unsubscribe?.();contentPlayer?.release(playerOwner);nativeView?.destroy();for(const [node,event,fn] of events)node.removeEventListener(event,fn);section.remove();}};
  }
  return Object.freeze({acquire,fork,mountControls,programmeSources});
})();
