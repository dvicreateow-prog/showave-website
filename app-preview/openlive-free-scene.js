/* Complete scene contents with Preview-only controls for editable layers. */
window.OpenLiveFreeScene=(()=>{
  'use strict';
  let nextTransformHint=0;
  const resizeCorners=[['nw','top left',-1,-1],['ne','top right',1,-1],['se','bottom right',1,1],['sw','bottom left',-1,1]];
  const autoSizeModes=[['off','Off','Keep the selected source at its native pixel size.'],['contain','Fit','Show the entire picture with its proportions preserved.'],['cover','Fill','Fill the output area; crop any excess picture.'],['stretch','Stretch','Match the output width and height independently.']];
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const mediaIconPaths={play:'obs-icons/media/media_play',pause:'obs-icons/media/media_pause',stop:'obs-icons/media/media_stop',
    cue:'obs-icons/media/media_previous',reset:'obs-icons/media/media_restart',video:'obs-icons/sources/media',edit:'obs-icons/cogs'};
  const mediaMask=asset=>'--media-icon:url("assets/'+(mediaIconPaths[asset]||'media-icons/'+asset)+'.svg")';

  // File analysis is independent of either player. Only its playhead/trim CSS
  // follows the selected bus, so inspecting audio never starts or seeks media.
  function mountMediaWaveform(track,source){
    const analyzer=window.OpenLiveMediaWaveform;if(!analyzer?.load)return null;
    const doc=track.ownerDocument,namespace='http://www.w3.org/2000/svg';
    let disposed=false,result=null,lastWidth=0;
    const abort=typeof AbortController==='function'?new AbortController():null;
    track.classList.add('has-waveform');track.dataset.waveform='loading';
    const views=['base','selected','played'].map(kind=>{
      const svg=doc.createElementNS(namespace,'svg');svg.setAttribute('viewBox','0 0 1000 40');
      svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
      svg.setAttribute('class','bc-media-waveform bc-media-waveform-'+kind);
      const path=doc.createElementNS(namespace,'path');svg.appendChild(path);track.appendChild(svg);return {svg,path};
    });
    const status=doc.createElement('span');status.className='bc-media-waveform-status';
    status.textContent='Reading audio…';status.setAttribute('role','status');track.appendChild(status);
    function draw(){
      if(disposed||!result?.peaks?.length)return;
      const width=Math.round(track.getBoundingClientRect().width)||300;if(width===lastWidth)return;lastWidth=width;
      const peaks=result.peaks,count=Math.min(peaks.length,512,Math.max(24,Math.floor(width/4))),step=1000/count;
      const duration=Number.isFinite(source?.el?.duration)&&source.el.duration>0?source.el.duration:result.duration;
      const span=result.duration>0?duration/result.duration:1;
      const commands=[];
      for(let index=0;index<count;index++){
        const start=Math.floor(index*peaks.length/count*span),end=Math.min(peaks.length,Math.max(start+1,Math.floor((index+1)*peaks.length/count*span)));
        let amplitude=0;for(let sample=start;sample<end;sample++)amplitude=Math.max(amplitude,Number(peaks[sample])||0);
        if(amplitude<=0)continue;
        const half=Math.max(.6,Math.sqrt(Math.min(1,amplitude))*17),x=(index+.5)*step;
        commands.push('M'+x.toFixed(2)+' '+(20-half).toFixed(2)+'v'+(half*2).toFixed(2));
      }
      for(const {path} of views){path.setAttribute('d',commands.join(''));path.setAttribute('stroke-width',String(step*.58));}
    }
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(draw):null;observer?.observe(track);
    const unavailable=reason=>{if(disposed)return;track.dataset.waveform='unavailable';status.hidden=false;
      status.textContent='Waveform unavailable';status.title=String(reason||'The browser could not read audio from this file.');};
    Promise.resolve().then(()=>analyzer.load(source,{signal:abort?.signal})).then(value=>{
      if(disposed)return;result=value;
      if(value?.state==='absent'){track.dataset.waveform='absent';status.hidden=false;status.textContent='No audio track';status.title=value.reason||'';return;}
      if(!['ready','silent'].includes(value?.state)){unavailable(value?.reason);return;}
      track.dataset.waveform=value.state;status.hidden=value.state==='ready';
      status.textContent=value.state==='silent'?'Silent audio':'';status.title=value.reason||'';
      track.title='Audio waveform · drag to seek; In and Out set the playback range';draw();
    },error=>unavailable(error?.message));
    return {destroy(){disposed=true;abort?.abort();observer?.disconnect();}};
  }

  // Thumbnail decoding has its own paused player; the selected Preview and
  // Programme decoders are never scrubbed to manufacture a filmstrip.
  function mountMediaFilmstrip(track,source){
    const analyzer=window.OpenLiveMediaWaveform;
    if(source?.audioOnly||!analyzer?.filmstrip)return null;
    const doc=track.ownerDocument,strip=doc.createElement('div');strip.className='bc-media-filmstrip';
    strip.setAttribute('role','img');strip.setAttribute('aria-label','Video frames along the media timeline');
    strip.textContent='Reading video frames…';track.appendChild(strip);track.classList.add('has-filmstrip');
    const abort=typeof AbortController==='function'?new AbortController():null;let disposed=false,result=null;
    const onProgress=value=>{if(disposed)return;strip.textContent='Video frames '+value.completed+'/'+value.total+' · '+({metadata:'reading',seek:'seeking',encode:'preparing',frame:'prepared',ready:'ready'}[value.phase]||'preparing');};
    // Acquire the replacement view's lease in this turn, before the old view's
    // last-owner retirement microtask. Buffering rebuilds must reuse decoding.
    let preparation;try{preparation=analyzer.filmstrip(source,{signal:abort?.signal,count:8,width:112,height:63,onProgress});}catch(error){preparation=Promise.reject(error);}
    Promise.resolve(preparation).then(value=>{
      if(disposed){value?.dispose?.();return;}result=value;
      if(value?.state!=='ready'){strip.textContent='Video frames unavailable';strip.title=value?.reason||'The browser could not inspect this video.';return;}
      strip.replaceChildren();strip.title='Sampled video frames · the ruler shows their position in the full file';
      for(const frame of value.frames){const image=doc.createElement('img');image.src=frame.url;image.alt='';image.setAttribute('aria-hidden','true');strip.appendChild(image);}
    },error=>{if(!disposed){strip.textContent='Video frames unavailable';strip.title=error?.message||'';}});
    return {destroy(){disposed=true;abort?.abort();result?.dispose?.();}};
  }

  function alignRect(rect,edge,aspect=16/9){
    const next={...rect},a=rect.rotation*Math.PI/180;
    const halfW=(Math.abs(Math.cos(a))*rect.w+Math.abs(Math.sin(a))*rect.h/aspect)/2;
    const halfH=(Math.abs(Math.sin(a))*rect.w*aspect+Math.abs(Math.cos(a))*rect.h)/2;
    if(edge==='left')next.x=halfW-rect.w/2;
    if(edge==='right')next.x=1-halfW-rect.w/2;
    if(edge==='center')next.x=(1-rect.w)/2;
    if(edge==='top')next.y=halfH-rect.h/2;
    if(edge==='bottom')next.y=1-halfH-rect.h/2;
    if(edge==='middle')next.y=(1-rect.h)/2;
    return next;
  }
  function gestureRect(base,mode,dx,dy,aspect,shift=false,corner='se'){
    if(mode==='move')return {...base,x:clamp(base.x+dx,-10,10),y:clamp(base.y+dy,-10,10)};
    const a=(base.rotation||0)*Math.PI/180,[,,sx,sy]=resizeCorners.find(item=>item[0]===corner)||resizeCorners[2];
    const localX=Math.cos(a)*dx+Math.sin(a)*dy/aspect,localY=-Math.sin(a)*dx*aspect+Math.cos(a)*dy;
    let w=clamp(base.w+sx*localX,.01,10),h=clamp(base.h+sy*localY,.01,10);
    if(shift){
      const deltaW=sx*localX/base.w,deltaH=sy*localY/base.h;
      const scale=clamp(1+(Math.abs(deltaW)>=Math.abs(deltaH)?deltaW:deltaH),Math.max(.01/base.w,.01/base.h),Math.min(10/base.w,10/base.h));
      w=base.w*scale;h=base.h*scale;
    }
    const dw=w-base.w,dh=h-base.h;
    return {...base,w,h,x:clamp(base.x+(sx*Math.cos(a)*dw-sy*Math.sin(a)*dh/aspect-dw)/2,-10,10),
      y:clamp(base.y+(sx*Math.sin(a)*dw*aspect+sy*Math.cos(a)*dh-dh)/2,-10,10)};
  }
  // Pointer geometry uses the same local clipping space as Creative.paint.
  // This never reads monitor pixels or changes a scene to discover its layers.
  function hitPoint(rect,x,y,aspect=16/9,creative={},pictureAspect=0,timeMs=0,pictureBounds=null){
    if(!rect||![x,y,aspect,rect.x,rect.y,rect.w,rect.h,rect.rotation||0].every(Number.isFinite)||aspect<=0||rect.w<=0||rect.h<=0||creative.opacity===0)return false;
    const angle=-(rect.rotation||0)*Math.PI/180,dx=(x-rect.x-rect.w/2)*aspect,dy=y-rect.y-rect.h/2;
    const w=rect.w*aspect,h=rect.h,phase=2*Math.PI*timeMs/(1000*(creative.animation?.seconds||3));
    let px=dx*Math.cos(angle)-dy*Math.sin(angle),py=dx*Math.sin(angle)+dy*Math.cos(angle);
    if(creative.animation?.preset==='float')py-=.035*h*Math.sin(phase);
    if(creative.animation?.preset==='breathe'){const scale=1+.04*Math.sin(phase);px/=scale;py/=scale;}
    if(creative.flipX)px=-px;if(creative.flipY)py=-py;
    const crop=creative.crop||{};let left=-w/2+(crop.left||0)*w,right=w/2-(crop.right||0)*w,
      top=-h/2+(crop.top||0)*h,bottom=h/2-(crop.bottom||0)*h;
    if(pictureBounds){
      const pictureX=(pictureBounds.x-rect.x-rect.w/2)*aspect,pictureY=pictureBounds.y-rect.y-rect.h/2;
      left=Math.max(left,pictureX);right=Math.min(right,pictureX+pictureBounds.w*aspect);
      top=Math.max(top,pictureY);bottom=Math.min(bottom,pictureY+pictureBounds.h);
    }
    if(right<=left||bottom<=top)return false;
    if(px<left||px>right||py<top||py>bottom)return false;
    const radius=Math.min((creative.radius||0)*Math.min(right-left,bottom-top),(right-left)/2,(bottom-top)/2);
    if(radius>0){const cx=Math.max(left+radius,Math.min(right-radius,px)),cy=Math.max(top+radius,Math.min(bottom-radius,py));if((px-cx)**2+(py-cy)**2>radius**2)return false;}
    if(!pictureBounds&&pictureAspect>0){const fitW=Math.min(w,h*pictureAspect),fitH=Math.min(h,w/pictureAspect);if(Math.abs(px)>fitW/2||Math.abs(py)>fitH/2)return false;}
    return true;
  }
  function mount({studio,root,stage,getScene,enabled,add,openSources,openMediaControls,editSource,editPart,editContent,editTransform,canTransform,onChange,onSelection,externalInspector=false,inspectSelection,mediaTarget,gesturesEnabled=()=>true}){
    let selected=null,signature='',owner=null,drag=null,itemDrag=null,transformOpen=false,menu=null,itemModal=null,transformInputs=null,transformOwner=null,playerRefresh=null,playerDispose=null,healthRefresh=null,mediaBus='preview',presentBus='preview',presentProgrammeId=null,sizeBusy=false,destroyed=false;
    const transformHintId='bc-source-transform-hint-'+(++nextTransformHint);
    const doc=root.ownerDocument,overlay=doc.createElement('div');overlay.className='bc-free-handles';stage.appendChild(overlay);
    const make=(tag,parent,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;parent.appendChild(node);return node;};
    const button=(parent,text,fn)=>{const b=make('button',parent,text,'btn');b.type='button';if(typeof fn==='function')b.addEventListener('click',()=>run(fn));return b;};
    const tell=text=>{const out=root.querySelector('[role="status"]');if(out)out.textContent=text;};
    function run(fn){try{const result=fn();if(typeof result?.catch==='function')result.catch(error=>tell(error.message||String(error)));}catch(error){tell(error.message||String(error));}}
    const freeCanvas=scene=>scene?.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only';
    const contents=scene=>typeof studio.sceneContents==='function'?studio.sceneContents(scene):studio.freeLayers(scene);
    const movable=(scene,row)=>freeCanvas(scene)&&!!row&&(!!row.slot||!!row.part)&&studio.freeLayers(scene).some(item=>item.key===row.key);
    function current(scene){return !destroyed&&getScene()===scene&&studio.scenes().includes(scene);}
    const itemIdentities=new WeakMap(),mediaHealthHistory=new WeakMap();let nextItemIdentity=0;
    const itemIdentity=value=>{if(!value||typeof value!=='object')return null;if(!itemIdentities.has(value))itemIdentities.set(value,++nextItemIdentity);return itemIdentities.get(value);};
    // Scene graphics can carry large image data URLs. Inventory stamps describe
    // controls and paint inclusion without serializing those bytes every frame.
    const sourceSlot=row=>row?.boundSlot||row?.slot;
    const sourceFor=row=>sourceSlot(row)&&studio.sources.get(sourceSlot(row).sourceId)||row?.boundSource||null;
    function rowStamp(row){return JSON.stringify([row.key,row.kind,row.label,row.hidden,row.locked,row.included,row.why,row.boundHidden,row.boundLabel,row.type,row.index,row.templateId,row.componentId,row.assetId,row.sourceId,
      itemIdentity(row.slot),itemIdentity(row.boundSlot),itemIdentity(row.part),itemIdentity(row.widget),itemIdentity(row.overlay),itemIdentity(row.component),
      row.asset?.id,row.asset?.name,row.info?.state,row.info?.error,row.slot,row.boundSlot,row.part?.style,row.part?.creative,row.part?.locked,row.widget,
      row.overlay&&[row.overlay.on,!!row.overlay.dataUrl,row.overlay.corner,row.overlay.line1,row.overlay.line2,row.overlay.endsAt]]);}
    function editable(scene,row){
      if(!enabled()||!current(scene))throw Error('The editing scene changed.');
      const live=row&&contents(scene).find(r=>r.key===row.key);
      if(row&&(!live||live.slot!==row.slot||live.boundSlot!==row.boundSlot||live.part!==row.part||live.widget!==row.widget||live.overlay!==row.overlay||live.component!==row.component||rowStamp(live)!==rowStamp(row)))throw Error('The source item changed. Select it again.');
    }
    function capabilities(scene,row){
      if(row&&typeof studio.sceneContentCapabilities==='function')return studio.sceneContentCapabilities(scene,row.key);
      const locked=!!row?.part?.locked||!!sourceSlot(row)?.locked,free=movable(scene,row),slot=sourceSlot(row);
      return {edit:!!row,hide:!!row?.part||free&&!!slot,lock:!!row?.part||free&&!!slot&&scene.sourceWorkflow==='obs',
        remove:!!row&&(row.part?typeof studio.removeSceneSvgPart==='function':!!slot&&free),
        autosize:!!row?.slot&&free&&typeof studio.editCreativeLayer==='function',reorder:free&&!locked,locked,reasons:{}};
    }
    function rowControlReason(scene,row,action){
      const caps=capabilities(scene,row);
      return !enabled()||!current(scene)?'Source controls are available in Scene Preview.':
        caps?.[action]===false?caps.reasons?.[action]||'This item does not support this operation.':
        caps.locked&&['edit','remove','autosize','reorder'].includes(action)?'Unlock this layer before '+({edit:'editing it',remove:'removing it',autosize:'changing its size',reorder:'rearranging it'})[action]+'.':'';
    }
    function changeItem(scene,row,patch){
      editable(scene,row);
      if(typeof studio.updateSceneContent==='function')return Promise.resolve(studio.updateSceneContent(scene.id,row.key,patch,{expected:row,isCurrent:()=>current(scene)&&enabled()})).then(()=>changed());
      if(row.part){studio.updateSceneSvgPartItem(scene.id,row.part.id,patch);changed();return;}
      editableLayer(scene,row);
      if(Object.hasOwn(patch,'locked')||Object.hasOwn(patch,'label'))studio.updateSourceItem(scene.id,row.index,patch);
      else studio.updateFreeSource(scene.id,row.index,patch);
      changed();
    }
    function editableLayer(scene,row){editable(scene,row);if(!movable(scene,row))throw Error('This item keeps its scene paint order. Open its editor to make changes.');}
    const icon=(node,type)=>window.OpenLiveSourceIcons?.prepend(node,type);
    function iconButton(parent,label,type,fn){const b=button(parent,'',fn);b.title=label;b.setAttribute('aria-label',label);icon(b,type);return b;}
    function sourceHealth(source){return studio.sourceStatus(source);}
    function sourceHealthStamp(source){
      const health=sourceHealth(source);
      if(source?.sourceType==='media'&&source.transport&&source.el&&!source.el.srcObject){
        // Keep controls and analysis leases mounted through retained loop/reverse
        // frames. The real health is painted separately; errors and sources that
        // have never decoded still change the inventory signature immediately.
        const el=source.el,transport=source.transport,now=typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();
        let record=mediaHealthHistory.get(source);
        if(!record||record.el!==el||record.transport!==transport){record={el,transport,decoded:false,seekingAt:null};mediaHealthHistory.set(source,record);}
        const seeking=el.seeking===true,released=transport.state?.()==='Released',available={ok:true,state:'available',element:itemIdentity(el),transport:itemIdentity(transport)};
        if(!seeking)record.seekingAt=null;else if(record.seekingAt===null)record.seekingAt=now;
        if(health.ok&&!released){
          if(!seeking&&Number(el.readyState)>=2&&!el.error)record.decoded=true;
          return available;
        }
        // A Cut wrap temporarily loses its decoded frame. Preserve the existing
        // controls for a bounded native seek, while their row honestly says
        // Loading. A failed, replaced or never-decoded runtime gets no grace.
        if(health.state==='loading'&&seeking&&record.decoded&&!el.error&&!released&&now-record.seekingAt<2000)
          return available;
        record.decoded=false;
      }
      return health;
    }
    function updateButtonText(button,text){
      const node=Array.from(button.childNodes||[]).find(child=>child.nodeType===3);
      if(node){if(node.nodeValue!==text)node.nodeValue=text;}else if(button.textContent!==text)button.textContent=text;
    }
    function healthLabel(health){return ({ready:'Ready',held:'Held',disabled:'Disabled',loading:'Loading',waiting:'Waiting',ended:'Ended',disconnected:'Disconnected',missing:'Disconnected',error:'Error',failed:'Failed',hidden:'Hidden',suppressed:'Suppressed',inactive:'Inactive'})[health.state]||(health.ok?'Ready':'Unavailable');}
    function properties(row){
      const source=sourceFor(row),types=window.OpenLiveSourcePicker?.types;
      if(typeof editSource!=='function'||!source?.sourceType||!source.config||!['generator','sports','audience'].includes(source.sourceType)&&types&&!types.some(type=>type.id===source.sourceType&&!type.unavailable))return null;
      const health=sourceHealth(source);
      return {source,health,label:health.ok||['loading','waiting'].includes(health.state)?'Properties':'Reconnect'};
    }
    function openProperties(scene,row,source){
      editable(scene,row);
      if(studio.sources.get(sourceSlot(row)?.sourceId)!==source||!properties(row))throw Error('The source changed. Select it again.');
      const why=rowControlReason(scene,row,'edit');if(why)throw Error(why);
      editSource(row.index);
    }
    function canEditContent(row){return !!row&&((!!row.part&&typeof editPart==='function')||((!row.slot||!freeCanvas(getScene()))&&typeof editContent==='function'));}
    function openContent(scene,row){
      editable(scene,row);const why=rowControlReason(scene,row,'edit');if(why)throw Error(why);
      // A native feed owns both artwork and an input. Its Edit icon opens the
      // bound input's settings first, including sports and replay controls.
      const bound=row.boundSlot&&properties(row);if(bound)return openProperties(scene,row,bound.source);
      if(row.part&&editPart)editPart(row.part.id);else if((!row.slot||!freeCanvas(scene))&&editContent)editContent(row);
    }
    const partHidden=row=>row.part?.style?.components?.[row.part.componentId]?.visible===false;
    function transformInfo(scene,row){
      const mode=row?.slot&&movable(scene,row)?'source':row?.part&&typeof editPart==='function'?'part':
        row&&typeof editTransform==='function'&&(typeof canTransform==='function'?canTransform(row):['source','template','widget'].includes(row.kind))?'editor':null;
      const why=!enabled()?'Transform controls are available in Scene Preview.':!row?
        contents(scene).length?'Select a source or artwork to edit its transform.':'This scene is empty. Add a source or artwork first.':
        capabilities(scene,row).locked?'Unlock this layer before editing its transform.':sourceFor(row)?.audioOnly?'Audio-only sources have no canvas transform.':
        !mode?'This item has fixed placement. Open its editor for available settings.':'';
      return {mode,why};
    }
    function openTransform(scene,row,toggle=false){
      editable(scene,row);if(selected!==row?.key)throw Error('The selected item changed. Select it again.');
      const info=transformInfo(scene,row);if(info.why)throw Error(info.why);
      if(inspectSelection?.(scene,row))return;
      if(info.mode==='part')return openContent(scene,row);
      if(info.mode==='editor'){const result=editTransform(row);if(result===false)throw Error('The transform editor is unavailable.');return result;}
      transformOpen=toggle?!transformOpen:true;changed();
      if(transformOpen){root.querySelector('.bc-free-inspector')?.scrollIntoView?.({block:'nearest'});root.querySelector('[aria-label="X (%)"]')?.focus({preventScroll:true});}
    }
    function closeMenu(){if(menu){menu.remove();menu=null;doc.removeEventListener('pointerdown',dismissMenu);root.querySelectorAll('.bc-source-autosize,.bc-source-more').forEach(node=>node.setAttribute('aria-expanded','false'));}}
    function dismissMenu(event){if(menu&&!menu.contains(event.target))closeMenu();}
    function autoSizeReason(scene,row){
      const source=sourceFor(row),why=rowControlReason(scene,row,'autosize');
      return why||(!sourceSlot(row)?'This artwork has no source picture to resize.':
        source?.audioOnly?'Audio-only sources have no picture size.':!source?'The source is no longer available.':sizeBusy?'Finishing the previous size change.':'');
    }
    const outputFit=(scene,row)=>typeof studio.sourceOutputFit==='function'&&sourceSlot(row)?studio.sourceOutputFit(scene,row.index):sourceSlot(row)?.outputFit||'contain';
    function resetSourcePose(row){
      const source=studio.sources.get(row.slot.sourceId);
      if(source?.sourceType==='image'&&source.initialTransform)return studio.freeTransform(source.initialTransform);
      if(['lower-third','ticker','countdown','qr','product-card'].includes(source?.sourceType)&&source.initialTransform&&typeof window.OpenLiveTemplateSources?.resolveCreative==='function'){
        try{window.OpenLiveTemplateSources.resolveCreative(source.sourceType,source.config?.templateId);return studio.freeTransform(source.initialTransform);}catch(_){}
      }
      return studio.freeTransform();
    }
    function focusAutoSize(row){
      [...root.querySelectorAll('.bc-source-autosize')].find(node=>node.getAttribute('data-layer-key')===row.key)?.focus({preventScroll:true});
    }
    async function applyAutoSize(scene,row,source,mode){
      editable(scene,row);const slot=sourceSlot(row);
      if(selected!==row.key||studio.sources.get(slot?.sourceId)!==source)throw Error('The selected source changed. Select it again.');
      const why=autoSizeReason(scene,row);if(why)throw Error(why);
      const free=movable(scene,row)&&!!row.slot,patch=mode==='reset'?{...(free?{transform:resetSourcePose(row)}:{}),outputFit:'contain'}:{outputFit:mode};
      if(outputFit(scene,row)===patch.outputFit&&(!patch.transform||Object.keys(patch.transform).every(key=>patch.transform[key]===studio.sourceRectNormalized(scene,row.index)[key]))){focusAutoSize(row);return;}
      sizeBusy=true;let message='';
      try{
        const guard=()=>current(scene)&&enabled()&&selected===row.key&&studio.sources.get(sourceSlot(row)?.sourceId)===source&&!source.audioOnly;
        if(free)await studio.editCreativeLayer(scene.id,row.key,patch,{expected:slot,isCurrent:guard});
        else await studio.updateSceneContent(scene.id,row.key,patch,{expected:row,isCurrent:guard});
        message=mode==='reset'?(free?'Reset size and position; Auto Size is Fit.':'Reset picture sizing; Auto Size is Fit. Native frame placement is kept.'):'Auto Size: '+autoSizeModes.find(item=>item[0]===mode)[1]+'.';
      }finally{sizeBusy=false;changed();if(message){tell(message);focusAutoSize(row);}}
    }
    function autoSizeMenu(scene,row,anchor){
      editable(scene,row);const why=autoSizeReason(scene,row);if(why)throw Error(why);
      const slot=sourceSlot(row),bounds=anchor.getBoundingClientRect(),source=studio.sources.get(slot.sourceId),label=row.label||slot.label||source?.label||'Source';
      closeMenu();selected=row.key;signature='';refresh();
      const opener=[...root.querySelectorAll('.bc-source-autosize')].find(node=>node.getAttribute('data-layer-key')===row.key);opener?.setAttribute('aria-expanded','true');
      menu=make('div',doc.body,undefined,'bc-source-context bc-source-autosize-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Auto Size for '+label);
      const mode=outputFit(scene,row);
      for(const [value,text,description] of autoSizeModes){
        const item=button(menu,text,()=>{closeMenu();return applyAutoSize(scene,row,source,value);});item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked',String(value===mode));item.title=description;
      }
      const reset=button(menu,movable(scene,row)&&row.slot?'Reset transform':'Reset picture sizing',()=>{closeMenu();return applyAutoSize(scene,row,source,'reset');});reset.setAttribute('role','menuitem');reset.classList.add('bc-source-autosize-reset');reset.title='Return Auto Size to Fit. Input selection, styling and native frame artwork are kept.';
      menu.style.left=Math.max(4,Math.min(bounds.left,doc.documentElement.clientWidth-menu.offsetWidth-4))+'px';
      menu.style.top=Math.max(4,Math.min(bounds.bottom,doc.documentElement.clientHeight-menu.offsetHeight-4))+'px';
      menu.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();opener?.focus({preventScroll:true});return;}
        if(event.key==='Tab'){closeMenu();return;}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();event.stopPropagation();const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(doc.activeElement);
        items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
      });
      menu.querySelector('[aria-checked="true"]')?.focus();doc.addEventListener('pointerdown',dismissMenu);
    }
    const removable=(scene,row)=>!!row&&!!capabilities(scene,row)?.remove;
    function requireRemoval(scene,row){
      editable(scene,row);const why=rowControlReason(scene,row,'remove');if(why)throw Error(why);
      if(!removable(scene,row))throw Error('This item has no independent scene copy to remove.');
    }
    function requireRename(scene,row){
      editableLayer(scene,row);const why=rowControlReason(scene,row,'edit');if(why)throw Error(why);
    }
    function itemDialog(scene,row,action){
      if(action==='remove')requireRemoval(scene,row);else requireRename(scene,row);
      closeMenu();if(itemModal)itemModal.remove();
      const dialog=make('dialog',doc.body,undefined,'bc-source-dialog bc-source-item-dialog');itemModal=dialog;
      const bound=!!row.boundSlot&&!!row.boundSlot.sourceId;
      const title=action==='rename'?'Rename source item':bound?'Remove source from frame':row.part||row.kind==='template'?'Remove artwork layer':'Remove source item';
      dialog.setAttribute('aria-label',title);make('h2',dialog,title+(action==='remove'?'?':''));
      const label=row.label||sourceSlot(row)?.label||sourceFor(row)?.label||'Artwork';let input;
      const form=make('form',dialog);
      if(action==='rename'){make('p',form,'Changes this scene’s item name. Other scenes and the shared capture keep their names.');const field=make('label',form,'Item name');input=make('input',field);input.value=label;input.maxLength=120;input.required=true;input.setAttribute('aria-label','Item name');}
      else make('p',form,'Remove “'+label+'” from '+scene.name+'? '+(bound?
        'The native frame, reusable source and Programme are kept.':row.part||row.kind==='template'?
        'The original artwork and Programme are kept.'+(Number.isInteger(row.part?.sourceSlot)?' Its bound input stays in this scene.':''):
        'The reusable source and Programme are kept.'));
      const status=make('p',form);status.setAttribute('role','status');
      const footer=make('footer',form),opener=doc.activeElement;
      const close=(restore=true)=>{dialog.close();dialog.remove();if(itemModal===dialog)itemModal=null;if(restore&&opener?.isConnected)opener.focus();};
      button(footer,'Cancel',()=>close());const submit=make('button',footer,action==='rename'?'Save name':'Remove');submit.type='submit';
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      form.addEventListener('submit',async event=>{event.preventDefault();try{
        if(action==='rename'){requireRename(scene,row);await changeItem(scene,row,{label:input.value});close();}
        else{requireRemoval(scene,row);const removed=typeof studio.removeSceneContent==='function'?
          await studio.removeSceneContent(scene.id,row.key,{expected:row,isCurrent:()=>current(scene)&&enabled()}):
          row.part?studio.removeSceneSvgPart(scene.id,row.part.id):studio.removeFreeSource(scene.id,row.index);
          if(!removed)throw Error('The item could not be removed. Select it again.');
          selected=null;transformOpen=false;close(false);changed();root.querySelector('.bc-source-name')?.focus({preventScroll:true});tell('Removed “'+label+'” from Preview.');}
      }catch(error){status.textContent=error.message;}});
      dialog.showModal();(input||footer.querySelector('button')).focus();input?.select();
    }
    function itemMenu(scene,row,anchor,event){
      const bounds=anchor?.getBoundingClientRect(),x=event?.clientX??bounds?.left??0,y=event?.clientY??bounds?.bottom??0;
      closeMenu();selected=row.key;signature='';refresh();
      const opener=[...root.querySelectorAll('.bc-source-more')].find(node=>node.getAttribute('data-layer-key')===row.key);opener?.setAttribute('aria-expanded','true');
      menu=make('div',doc.body,undefined,'bc-source-context');menu.setAttribute('role','menu');menu.setAttribute('aria-label','Source actions');
      const addItem=(label,fn,disabled=false)=>{const b=button(menu,label,()=>{closeMenu();editable(scene,row);return fn();});b.setAttribute('role','menuitem');b.disabled=disabled;return b;};
      if(sourceSlot(row)){
        const info=properties(row);if(info){const why=rowControlReason(scene,row,'edit'),control=addItem(info.label,()=>openProperties(scene,row,info.source),!!why);if(why)control.title=why;}
      }
      if(canEditContent(row)){const why=rowControlReason(scene,row,'edit'),edit=addItem(row.part?'Edit overlay':'Open editor',()=>openContent(scene,row),!!why);if(why)edit.title=why;}
      const caps=capabilities(scene,row),hidden=row.boundSlot?!!row.boundSlot.hidden:row.part?partHidden(row):!!row.hidden;
      if(caps.hide)addItem(hidden?'Show item':'Hide item',()=>changeItem(scene,row,{hidden:!hidden}));
      if(caps.lock)addItem(caps.locked?'Unlock item':'Lock item',()=>changeItem(scene,row,{locked:!caps.locked}));
      if(movable(scene,row)&&row.slot){
        const obs=scene.sourceWorkflow==='obs';
        if(obs){
        const why=rowControlReason(scene,row,'edit'),rename=addItem('Rename item',()=>itemDialog(scene,row,'rename'),!!why);if(why)rename.title=why;
        addItem('Duplicate reference',()=>{selected='source:'+studio.duplicateSourceItem(scene.id,row.index);changed();});
        }
      }
      if(movable(scene,row)){
      for(const [label,direction] of [['Bring to front','front'],['Bring forward','forward'],['Send backward','backward'],['Send to back','back']]){
        const stack=studio.freeLayers(scene),index=stack.findIndex(r=>r.key===row.key);
        const why=rowControlReason(scene,row,'reorder'),control=addItem(label,()=>{editableLayer(scene,row);if(why)throw Error(why);studio.moveFreeLayer(scene.id,row.key,direction);changed();},!!why||(['front','forward'].includes(direction)?index===stack.length-1:index===0));if(why)control.title=why;
      }
      }
      if(removable(scene,row)){const why=rowControlReason(scene,row,'remove'),remove=addItem('Remove from scene',()=>itemDialog(scene,row,'remove'),!!why);if(why)remove.title=why;}
      if(caps.autosize){const why=autoSizeReason(scene,row),size=addItem('Auto Size',()=>autoSizeMenu(scene,row,[...root.querySelectorAll('.bc-source-autosize')].find(node=>node.getAttribute('data-layer-key')===row.key)||anchor),!!why);size.title=why||'Fit, Fill, Stretch or keep native picture size';}
      const transform=transformInfo(scene,row);if(transform.mode){const control=addItem('Edit transform',()=>openTransform(scene,row),!!transform.why);control.title=transform.why||'Edit this item’s placement in Preview.';}
      if(!menu.children.length)make('p',menu,'This item keeps its scene paint order.');
      menu.style.left=Math.max(4,Math.min(x,doc.documentElement.clientWidth-menu.offsetWidth-4))+'px';
      menu.style.top=Math.max(4,Math.min(y,doc.documentElement.clientHeight-menu.offsetHeight-4))+'px';
      menu.addEventListener('keydown',e=>{
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu();opener?.focus({preventScroll:true});return;}
        if(e.key==='Tab'){closeMenu();return;}
        const items=[...menu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(doc.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
      });
      menu.querySelector('button:not(:disabled)')?.focus();doc.addEventListener('pointerdown',dismissMenu);
    }
    function changed(){signature='';refresh();onChange?.();}
    const stackStamp=scene=>JSON.stringify(studio.freeLayers(scene).map(row=>[row.key,row.slot,row.part]));
    function requireReorder(scene,row){editableLayer(scene,row);const why=rowControlReason(scene,row,'reorder');if(why)throw Error(why);}
    function clearItemDrag(){itemDrag=null;root.querySelectorAll('.bc-source-row').forEach(line=>{for(const cls of ['is-dragging','bc-drop-before','bc-drop-after'])line.classList.toggle(cls,false);});}
    function validItemDrag(scene){
      try{if(!itemDrag||itemDrag.scene!==scene||itemDrag.stamp!==stackStamp(scene))return false;requireReorder(scene,itemDrag.row);return true;}catch(_){return false;}
    }
    function moveItem(scene,row,direction,label){requireReorder(scene,row);selected=row.key;studio.moveFreeLayer(scene.id,row.key,direction);changed();[...root.querySelectorAll('.bc-source-grip')].find(node=>node.getAttribute('aria-label')==='Drag to reorder '+label)?.focus({preventScroll:true});}
    function update(scene,index,transform,row){
      if(!enabled()||!current(scene)||!freeCanvas(scene))throw Error('The selected scene changed.');
      if(row){if(selected!==row.key)throw Error('The selected source changed. Select it again.');editableLayer(scene,row);}
      studio.updateFreeSource(scene.id,index,{transform});transformInputs=null;transformOwner=null;changed();
    }
    function visualBounds(scene,row){
      if(typeof studio.sceneContentBounds==='function')return studio.sceneContentBounds(scene,row.key);
      if(!movable(scene,row)||!row.slot||studio.sources.get(row.slot.sourceId)?.audioOnly)return null;
      return {rect:studio.sourceRectNormalized(scene,row.index),locked:!!row.slot.locked,hidden:!!row.slot.hidden,editable:true};
    }
    function canGesture(scene,row,info=visualBounds(scene,row)){
      return enabled()&&gesturesEnabled()&&movable(scene,row)&&!!info?.editable&&!info.locked&&!info.hidden&&(!row.slot||sourceHealth(studio.sources.get(row.slot.sourceId)).ok);
    }
    function validDrag(d){
      try{editable(d.scene,d.row);return selected===d.row.key&&canGesture(d.scene,d.row);}catch(_){return false;}
    }
    async function updateVisual(scene,row,transform){
      if(selected!==row.key)throw Error('The selected layer changed. Select it again.');
      editableLayer(scene,row);if(!canGesture(scene,row))throw Error('This layer cannot be moved. Check its visibility, lock and source status.');
      if(row.slot){
        if(typeof studio.editCreativeLayer!=='function'){update(scene,row.index,transform,row);return;}
        await studio.editCreativeLayer(scene.id,row.key,{transform},{expected:row.slot,isCurrent:()=>current(scene)&&enabled()&&selected===row.key&&canGesture(scene,row)});
        transformInputs=null;transformOwner=null;changed();return;
      }
      await studio.editCreativeLayer(scene.id,row.key,{transform},{expected:row.part,history:'svg',isCurrent:()=>current(scene)&&enabled()&&selected===row.key});
      changed();
    }
    function boxStyle(node,rect){Object.assign(node.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.w*100+'%',height:rect.h*100+'%',transform:'rotate('+rect.rotation+'deg)'});}
    function hitsAt(scene,event){
      const bounds=overlay.getBoundingClientRect();if(!(bounds.width>0&&bounds.height>0))return [];
      const x=(event.clientX-bounds.left)/bounds.width,y=(event.clientY-bounds.top)/bounds.height;
      if(x<0||x>1||y<0||y>1)return [];
      const templates=window.OpenLiveFullTemplates,time=typeof performance==='object'?performance.now():0;
      return contents(scene).slice().reverse().filter(row=>{
        const info=visualBounds(scene,row);if(!info||info.hidden||row.included===false)return false;
        const source=row.slot&&studio.sources.get(row.slot.sourceId),feed=row.boundSource;
        if(row.slot&&(!sourceHealth(source).ok||source?.audioOnly))return false;
        if(row.component?.virtual&&(!feed||feed.audioOnly||row.boundHidden||!sourceHealth(feed).ok||scene.slots?.[row.index]?.creative?.opacity===0))return false;
        if(row.component?.editableText&&(row.part?.style||scene.fullTemplateStyle)?.components?.[row.componentId]?.text==='')return false;
        if(row.part||row.kind==='template'){
          const template=templates?.get(row.templateId),board=template&&templates?.board?.(row.templateId,{width:1920,height:1080});
          if(board&&(x<board.x/1920||x>(board.x+board.width)/1920||y<board.y/1080||y>(board.y+board.height)/1080))return false;
          if(row.part&&typeof templates?.partStatus==='function'&&templates.partStatus(row.templateId,row.componentId,row.part.style).state!=='ready')return false;
        }
        const creative=row.slot?.creative||row.part?.creative||{},size=source&&studio.sizeOf?.(source),input=row.slot?.inputSelection,
          pictureBounds=row.slot&&!scene.fullTemplateId&&!scene.svgParts?.some(part=>part.sourceSlot===row.index)&&studio.sourcePictureRectNormalized?.(scene,row.index),
          pictureAspect=!['cover','stretch'].includes(row.slot?.outputFit)&&size?.w>0&&size?.h>0?size.w*(input?.w??1)/(size.h*(input?.h??1)):0;
        if(!hitPoint(info.rect,x,y,bounds.width/bounds.height,creative,pictureAspect,time,pictureBounds))return false;
        const feedCreative=row.part&&Number.isInteger(row.part.sourceSlot)&&scene.slots[row.part.sourceSlot]?.creative;
        return !feedCreative||hitPoint(info.rect,x,y,bounds.width/bounds.height,feedCreative,0,time);
      });
    }
    function pickPointer(event){
      const scene=getScene();if(event.button!==0||!scene||!enabled()||!current(scene)||drag||itemDrag||overlay.hidden)return;
      // The selected object's explicit handles keep their resize/rotate action.
      if(event.target?.closest?.('.bc-free-resize,.bc-free-rotate'))return;
      const hits=hitsAt(scene,event),index=event.altKey?hits.findIndex(row=>row.key===selected):-1,
        row=hits[event.altKey&&index>=0?(index+1)%hits.length:0];
      event.preventDefault();event.stopPropagation();closeMenu();selected=row?.key||null;signature='';
      if(!row)transformOpen=false;
      refresh();
      if(row){
        const box=[...overlay.querySelectorAll('.bc-free-box')].find(node=>node.getAttribute('data-layer-key')===row.key);
        box?.focus({preventScroll:true});
        if(box&&!event.altKey&&canGesture(scene,row))start(event,scene,row,'move',box);
      }
    }
    stage.addEventListener('pointerdown',pickPointer);
    function start(event,scene,row,mode,node,corner='se'){
      if(event.button!==0||drag||!current(scene)||!canGesture(scene,row))return;
      try{editableLayer(scene,row);}catch(_){return;}
      event.preventDefault();event.stopPropagation();selected=row.key;
      const bounds=overlay.getBoundingClientRect(),base=visualBounds(scene,row).rect;
      if(!(bounds.width>0&&bounds.height>0))return;
      const cx=bounds.left+(base.x+base.w/2)*bounds.width,cy=bounds.top+(base.y+base.h/2)*bounds.height;
      drag={node,pointer:event.pointerId,scene,row,base,next:base,bounds,mode,corner,x:event.clientX,y:event.clientY,
        angle:Math.atan2(event.clientY-cy,event.clientX-cx),cx,cy};
      node.classList.add('selected');stage.__openliveScenePointer=event.pointerId;
      // The selected box may be rebuilt by selection. Capture its stable
      // viewport; a forwarded pointer belongs to another document, where the
      // mirror takes native capture instead.
      try{stage.setPointerCapture?.(event.pointerId);}catch(_){}
    }
    function cancel(){if(!drag)return;const old=drag;drag=null;delete stage.__openliveScenePointer;try{stage.releasePointerCapture?.(old.pointer);}catch(_){}signature='';refresh();}
    function movePointer(event){
      const d=drag;if(!d||event.pointerId!==d.pointer)return;
      if(!validDrag(d)){cancel();return;}
      // A click with a little pointer tremor only selects; it is not an edit.
      if(!d.moved&&Math.hypot(event.clientX-d.x,event.clientY-d.y)<3)return;
      d.moved=true;
      if(d.mode==='rotate'){
        let rotation=d.base.rotation+(Math.atan2(event.clientY-d.cy,event.clientX-d.cx)-d.angle)*180/Math.PI;
        if(event.shiftKey)rotation=Math.round(rotation/15)*15;
        d.next={...d.base,rotation};
      }else d.next=gestureRect(d.base,d.mode,(event.clientX-d.x)/d.bounds.width,(event.clientY-d.y)/d.bounds.height,d.bounds.width/d.bounds.height,event.shiftKey,d.corner);
      boxStyle(d.node,d.next);
    }
    stage.addEventListener('pointermove',movePointer);
    function finishPointer(event){
      if(!drag||event.pointerId!==drag.pointer)return;movePointer(event);
      const d=drag;if(!d)return;drag=null;
      delete stage.__openliveScenePointer;try{stage.releasePointerCapture?.(d.pointer);}catch(_){}
      if(Object.keys(d.base).every(key=>d.base[key]===d.next[key])){signature='';refresh();return;}
      run(async()=>{try{if(!validDrag(d))throw Error('The layer changed; gesture cancelled.');await updateVisual(d.scene,d.row,d.next);}finally{signature='';refresh();}});
    }
    const cancelPointer=event=>{if(drag&&event.pointerId===drag.pointer)cancel();};
    stage.addEventListener('pointerup',finishPointer);
    stage.addEventListener('pointercancel',cancelPointer);stage.addEventListener('lostpointercapture',cancelPointer);
    const escape=event=>{if(event.key==='Escape'&&menu){event.preventDefault();closeMenu();root.querySelector('.bc-source-row.selected .bc-source-name')?.focus();}if(event.key==='Escape'&&drag){event.preventDefault();cancel();}if(event.key==='Escape'&&itemDrag){clearItemDrag();signature='';refresh();}};doc.addEventListener('keydown',escape);
    function refresh(){
      if(destroyed)return;
      const scene=getScene(),free=freeCanvas(scene);
      root.hidden=!scene;overlay.hidden=!scene||!enabled();
      if(drag){if(!validDrag(drag))cancel();else return;}
      if(itemDrag){if(!validItemDrag(scene))clearItemDrag();else{healthRefresh?.();playerRefresh?.();return;}}
      if(!scene){playerDispose?.();playerDispose=null;playerRefresh=null;healthRefresh=null;owner=null;signature='';transformInputs=null;transformOwner=null;root.replaceChildren();overlay.replaceChildren();if(mediaTarget){mediaTarget.replaceChildren();mediaTarget.hidden=true;}onSelection?.(null);return;}
      const layers=contents(scene),stack=free?studio.freeLayers(scene):[];
      const sig=JSON.stringify([scene.id,scene.name,scene.layout,scene.fullTemplateId,scene.sourceWorkflow,scene.freeOrder,layers.map(rowStamp),studio.sceneContentHistory?.(scene.id),selected,enabled(),gesturesEnabled(),mediaBus,studio.programmeMedia?.(sourceSlot(layers.find(row=>row.key===selected))?.sourceId)?._programmeGeneration,Array.from(studio.sources.values(),s=>[s.id,itemIdentity(s),s.label,s.sourceType,!!s.config,sourceHealthStamp(s)])]);
      const scrollTop=owner===scene?(root.querySelector('.bc-free-list')?.scrollTop||0):0;
      if(sig===signature){healthRefresh?.();playerRefresh?.();return;}playerDispose?.();playerDispose=null;playerRefresh=null;healthRefresh=null;signature=sig;if(owner!==scene){owner=scene;selected=null;transformOpen=false;closeMenu();if(itemModal){itemModal.remove();itemModal=null;}}
      const focused=(root.contains(doc.activeElement)||overlay.contains(doc.activeElement))?doc.activeElement.getAttribute('aria-label'):null;
      const choice=layers.find(row=>row.key===selected),choiceMovable=movable(scene,choice),obs=scene.sourceWorkflow==='obs';
      const inline=!externalInspector&&transformOpen&&choiceMovable&&!!choice?.slot,pose=inline?JSON.stringify(studio.sourceRectNormalized(scene,choice.index)):null;
      const draft=inline&&transformInputs&&transformOwner?.scene===scene&&transformOwner.key===choice.key&&
        transformOwner.slot===choice.slot&&transformOwner.sourceId===choice.slot.sourceId&&transformOwner.pose===pose?
        Object.fromEntries(Object.entries(transformInputs).map(([key,input])=>[key,input.value])):null;
      transformInputs=null;transformOwner=null;
      onSelection?.(choice?{scene,key:selected,row:choice}:null);
      root.classList.add('bc-obs-dock');root.classList.toggle('bc-obs-transform-open',inline);
      root.setAttribute('aria-label','Sources · '+scene.name);
      root.replaceChildren();overlay.replaceChildren();
      if(mediaTarget){mediaTarget.replaceChildren();mediaTarget.hidden=true;}
      const head=make('header',root,undefined,'bc-free-head mon-head');make('strong',head,'Sources');
      head.title='Top = front · Preview only';
      make('span',head,scene.name+' · '+layers.length+' items');
      const content=make('div',root,undefined,'bc-free-content'),list=make('div',content,undefined,'bc-free-list');list.setAttribute('aria-label','Scene source and overlay stack');
      const healthPainters=[];healthRefresh=()=>{for(const paint of healthPainters)paint();};
      if(!layers.length)make('p',list,'This scene is empty. Add a source or artwork to begin.','bc-source-empty');
      for(const row of [...layers].reverse()){
        const source=sourceFor(row),slot=sourceSlot(row),caps=capabilities(scene,row);
        const label=row.label||(row.slot?(row.slot.label||source?.label||'Unbound source'):
          row.part?(window.OpenLiveFullTemplates?.get(row.part.templateId)?.components?.find(c=>c.id===row.part.componentId)?.label||row.part.componentId):row.key);
        const health=slot?sourceHealth(source):row.boundSource?sourceHealth(row.boundSource):null;
        const hidden=row.hidden??row.slot?.hidden,statusLabel=hidden?'Hidden':row.boundHidden?'Source hidden':health?healthLabel(health):row.included===false?'Excluded':'';
        const line=make('div',list,undefined,'bc-source-row'),isMovable=movable(scene,row);
        const grip=iconButton(line,'Drag to reorder '+label,'grip',()=>{selected=row.key;signature='';refresh();});grip.classList.add('bc-source-grip');
        const reorderWhy=rowControlReason(scene,row,'reorder')||(!isMovable?'This item keeps its native frame and paint order. Use Arrange to change the scene layout.':!obs?'Use the layer-order controls for this legacy scene.':'');
        grip.disabled=!!reorderWhy;grip.draggable=enabled()&&!grip.disabled;grip.title=reorderWhy||'Drag to change layer order · Arrow Up/Down also move this item';
        grip.setAttribute('aria-description',grip.title);
        const displayLabel=row.boundSlot&&source?(slot.label||source.label)+(row.component?.label?' · '+row.component.label:''):label;
        const b=button(line,displayLabel+(statusLabel?' · '+statusLabel:''),()=>{selected=row.key;signature='';refresh();});b.classList.toggle('selected',row.key===selected);b.classList.toggle('on',row.key===selected);b.setAttribute('aria-pressed',String(row.key===selected));b.title=label+((row.why||health?.why||health?.warning||statusLabel)?' · '+(row.why||health?.why||health?.warning||statusLabel):'');
          if(source||row.boundSource)healthPainters.push(()=>{const current=sourceHealth(source||row.boundSource),status=hidden?'Hidden':row.boundHidden?'Source hidden':healthLabel(current);
            updateButtonText(b,displayLabel+(status?' · '+status:''));b.title=label+((row.why||current.why||current.warning||status)?' · '+(row.why||current.why||current.warning||status):'');});
          b.classList.add('bc-source-name');b.setAttribute('aria-label','Select '+label);icon(b,source?.sourceType||source?.kind||(row.part||row.kind==='template'?'artwork':row.kind||'default'));
          line.classList.toggle('selected',row.key===selected);line.classList.toggle('is-hidden',!!hidden||row.included===false);
          if(openMediaControls&&(source?.transport||source?.presentationControls)){const playback=iconButton(line,(source.sourceType==='present'?'Open presentation controls for ':'Open playback controls for ')+label,source.sourceType==='present'?'present':'playback',()=>{
            editable(scene,row);if(studio.sources.get(sourceSlot(row)?.sourceId)!==source||!(source.transport||source.presentationControls))throw Error('The selected media changed.');
            selected=row.key;signature='';refresh();openMediaControls(scene,row);
          });playback.title=(source.sourceType==='present'?'Open slide controls for ':'Open playback and trim controls for ')+label;}
          const rowProperties=properties(row);
          const editWhy=rowControlReason(scene,row,'edit')||(!(canEditContent(row)||rowProperties)?'No properties editor is available for this item.':'');
          const edit=iconButton(line,'Edit '+label,'edit',()=>{editable(scene,row);selected=row.key;signature='';refresh();if(canEditContent(row))openContent(scene,row);else if(rowProperties)openProperties(scene,row,rowProperties.source);});
          edit.disabled=!!editWhy;edit.title=editWhy||(row.component?.editableText?'Customize text, font, colour and placement':row.part?'Customize artwork, colours, image and placement':'Open this item’s editor');
          const itemHidden=row.boundSlot?!!row.boundSlot.hidden:row.part?partHidden(row):!!row.hidden;
          const eye=iconButton(line,(itemHidden?'Show ':'Hide ')+label,itemHidden?'invisible':'visible',()=>changeItem(scene,row,{hidden:!itemHidden}));eye.setAttribute('aria-pressed',String(!itemHidden));
          const hideWhy=rowControlReason(scene,row,'hide');eye.disabled=!!hideWhy;eye.title=hideWhy||(itemHidden?'Show ':'Hide ')+label+' in Preview';
          const lock=iconButton(line,(caps.locked?'Unlock ':'Lock ')+label,caps.locked?'locked':'unlocked',()=>changeItem(scene,row,{locked:!caps.locked}));lock.setAttribute('aria-pressed',String(!!caps.locked));
          const lockWhy=rowControlReason(scene,row,'lock');lock.disabled=!!lockWhy;lock.title=lockWhy||(caps.locked?'Unlock ':'Lock ')+label;
          const remove=iconButton(line,'Remove '+label+' from scene','remove',()=>itemDialog(scene,row,'remove')),removeWhy=rowControlReason(scene,row,'remove');remove.disabled=!!removeWhy;
          remove.title=removeWhy||(row.boundSlot&&row.boundSlot.sourceId?'Remove this source from its frame; keep the native artwork':'Remove this '+(row.part||row.kind==='template'?'artwork copy':'source item')+' from Preview');
          {
            const autoSize=iconButton(line,'Auto Size for '+label,'autosize',()=>autoSizeMenu(scene,row,autoSize)),why=autoSizeReason(scene,row);
            autoSize.classList.add('bc-source-autosize');autoSize.setAttribute('data-layer-key',row.key);autoSize.setAttribute('aria-haspopup','menu');autoSize.setAttribute('aria-expanded','false');autoSize.disabled=!!why;
            autoSize.title=why||'Auto Size: '+(autoSizeModes.find(mode=>mode[0]===outputFit(scene,row))?.[1]||'Fit')+' · Fit, Fill, Stretch or keep native size';
          }
          const more=iconButton(line,'More options for '+label,'dots',()=>itemMenu(scene,row,more));
          more.classList.add('bc-source-more');more.setAttribute('data-layer-key',row.key);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');
          line.addEventListener('contextmenu',e=>{e.preventDefault();if(enabled())itemMenu(scene,row,line,e);});
          b.addEventListener('dblclick',()=>run(()=>{editable(scene,row);if(canEditContent(row))openContent(scene,row);else if(properties(row))openProperties(scene,row,properties(row).source);else if(isMovable){transformOpen=true;selected=row.key;changed();}}));
          grip.addEventListener('dragstart',e=>{try{if(!grip.draggable||drag)throw Error('This row cannot be rearranged.');requireReorder(scene,row);
            itemDrag={scene,row,key:row.key,stamp:stackStamp(scene)};line.classList.add('is-dragging');e.dataTransfer.setData('application/x-showave-source',JSON.stringify({scene:scene.id,key:row.key}));e.dataTransfer.effectAllowed='move';e.stopPropagation();
          }catch(error){e.preventDefault();clearItemDrag();tell(error.message);}});
          grip.addEventListener('dragend',()=>{clearItemDrag();signature='';refresh();});
          grip.addEventListener('keydown',e=>{const direction={ArrowUp:'forward',ArrowDown:'backward',Home:'front',End:'back'}[e.key];if(direction&&!grip.disabled){e.preventDefault();run(()=>moveItem(scene,row,direction,label));}});
          line.addEventListener('dragover',e=>{if(isMovable&&obs&&validItemDrag(scene)&&Array.from(e.dataTransfer?.types||[]).includes('application/x-showave-source')){e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';
            root.querySelectorAll('.bc-source-row').forEach(n=>{n.classList.toggle('bc-drop-before',false);n.classList.toggle('bc-drop-after',false);});const rect=line.getBoundingClientRect();line.classList.add(e.clientY>rect.top+rect.height/2?'bc-drop-after':'bc-drop-before');}});
          line.addEventListener('dragleave',()=>{line.classList.toggle('bc-drop-before',false);line.classList.toggle('bc-drop-after',false);});
          line.addEventListener('drop',e=>{if(!isMovable||!obs||!Array.from(e.dataTransfer?.types||[]).includes('application/x-showave-source'))return;e.preventDefault();e.stopPropagation();
            run(()=>{try{if(!validItemDrag(scene))throw Error('The source stack changed. Drag the item again.');requireReorder(scene,row);const data=JSON.parse(e.dataTransfer.getData('application/x-showave-source'));
              if(data.scene!==scene.id||data.key!==itemDrag.key)throw Error('The dragged source changed. Try again.');selected=data.key;if(data.key===row.key)return;
              const top=studio.freeLayers(scene).map(r=>r.key).reverse();if(!top.includes(data.key))throw Error('The dragged source is no longer available.');const before=top.slice();top.splice(top.indexOf(data.key),1);
              const rect=line.getBoundingClientRect(),to=top.indexOf(row.key)+(e.clientY>rect.top+rect.height/2?1:0);top.splice(to,0,data.key);if(top.every((key,i)=>key===before[i]))return;
              studio.reorderSourceItems(scene.id,top.reverse());selected=data.key;
            }finally{clearItemDrag();changed();}});});
          b.addEventListener('keydown',e=>{
            if(e.ctrlKey&&e.key.toLowerCase()==='e'){e.preventDefault();run(()=>{editable(scene,row);selected=row.key;openTransform(scene,row);});}
            if(e.ctrlKey&&e.key.toLowerCase()==='d'&&row.slot&&isMovable&&obs){e.preventDefault();run(()=>{editableLayer(scene,row);selected='source:'+studio.duplicateSourceItem(scene.id,row.index);changed();});}
            if(e.key==='F2'&&row.slot&&isMovable&&obs){e.preventDefault();run(()=>itemDialog(scene,row,'rename'));}
            if(e.key==='Delete'&&removable(scene,row)){e.preventDefault();run(()=>itemDialog(scene,row,'remove'));}
            if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();itemMenu(scene,row,b);}
            if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){if(e.ctrlKey&&(!isMovable||!['ArrowUp','ArrowDown'].includes(e.key)))return;e.preventDefault();run(()=>{if(e.ctrlKey){requireReorder(scene,row);studio.moveFreeLayer(scene.id,row.key,e.key==='ArrowUp'?'forward':'backward');changed();return;}const names=[...list.querySelectorAll('.bc-source-name')],i=names.indexOf(b);names[e.key==='Home'?0:e.key==='End'?names.length-1:Math.max(0,Math.min(names.length-1,i+(e.key==='ArrowUp'?-1:1)))]?.click();root.querySelector('.bc-source-row.selected .bc-source-name')?.focus();});}
          });
        const geometry=visualBounds(scene,row),isSelected=row.key===selected;
        if(geometry&&(isSelected||isMovable&&row.slot&&!geometry.hidden)){
          const box=make('div',overlay,undefined,'bc-free-box'+(isSelected?' selected':''));boxStyle(box,geometry.rect);
          box.style.zIndex=String(row.key===selected?layers.length+1:layers.indexOf(row));
          box.setAttribute('role','group');box.setAttribute('aria-label','Transform '+label);box.setAttribute('data-layer-key',row.key);box.tabIndex=0;
          const interactive=canGesture(scene,row,geometry),unavailable=!!row.slot&&!health?.ok;
          if(geometry.locked)box.classList.add('locked');if(geometry.hidden)box.classList.add('is-hidden');if(!interactive)box.classList.add('is-readonly');if(unavailable)box.classList.add('is-unavailable');
          const states=[geometry.hidden?'Hidden':'',geometry.locked?'Locked':'',unavailable?healthLabel(health):'',!isMovable?'Fixed placement':''].filter(Boolean);
          box.setAttribute('aria-description',states.join(' · ')||'Drag to move. Use handles to resize or rotate.');
          if(isSelected){const caption=make('span',overlay,label+(states.length?' · '+states.join(' · '):''),'bc-free-selection-label');caption.title=caption.textContent;caption.setAttribute('aria-hidden','true');if(geometry.locked)icon(caption,'locked');}
          box.addEventListener('contextmenu',e=>{e.preventDefault();if(enabled())itemMenu(scene,row,box,e);});
          box.addEventListener('keydown',e=>{
            if(e.target!==box)return;
            if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=row.key;signature='';refresh();}
            const delta={'ArrowLeft':[-1,0],'ArrowRight':[1,0],'ArrowUp':[0,-1],'ArrowDown':[0,1]}[e.key];
            if(delta){e.preventDefault();run(()=>{selected=row.key;const r=visualBounds(scene,row).rect,step=e.shiftKey?10:1;return updateVisual(scene,row,{...r,x:r.x+delta[0]*step/1920,y:r.y+delta[1]*step/1080});});}
          });
          if(!interactive)continue;
          for(const [corner,cornerLabel] of resizeCorners){
            const resize=button(box,'','');resize.className='bc-free-resize';resize.setAttribute('data-corner',corner);resize.setAttribute('aria-label','Resize '+label+' from '+cornerLabel);
            resize.title='Drag to scale · Shift keeps proportions · Arrow keys adjust this corner';
            resize.addEventListener('pointerdown',e=>{resize.focus({preventScroll:true});start(e,scene,row,'resize',box,corner);});
            resize.addEventListener('keydown',e=>{
              const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;
              e.preventDefault();e.stopPropagation();run(()=>{selected=row.key;const rect=visualBounds(scene,row).rect,bounds=overlay.getBoundingClientRect(),step=e.shiftKey?10:1;
                return updateVisual(scene,row,gestureRect(rect,'resize',delta[0]*step/1920,delta[1]*step/1080,bounds.width/bounds.height,e.shiftKey,corner));});
            });
          }
          const rotate=button(box,'↻','');rotate.className='bc-free-rotate';rotate.setAttribute('aria-label','Rotate '+label);
          rotate.title='Drag to rotate · Shift snaps to 15° · Arrow keys rotate';
          const stageBounds=overlay.getBoundingClientRect(),angle=geometry.rect.rotation*Math.PI/180,localY=-geometry.rect.h*stageBounds.height/2-22,
            rotateX=(geometry.rect.x+geometry.rect.w/2)*stageBounds.width-Math.sin(angle)*localY,rotateY=(geometry.rect.y+geometry.rect.h/2)*stageBounds.height+Math.cos(angle)*localY;
          rotate.classList.toggle('is-inside',rotateX<12||rotateX>stageBounds.width-12||rotateY<12||rotateY>stageBounds.height-12);
          rotate.addEventListener('pointerdown',e=>{rotate.focus({preventScroll:true});start(e,scene,row,'rotate',box);});
          rotate.addEventListener('keydown',e=>{
            const direction={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[e.key];if(!direction)return;
            e.preventDefault();e.stopPropagation();run(()=>{selected=row.key;const rect=visualBounds(scene,row).rect;return updateVisual(scene,row,{...rect,rotation:rect.rotation+direction*(e.shiftKey?15:1)});});
          });
        }
      }
      const previewMedia=sourceFor(choice),liveMedia=studio.programmeMedia?.(previewMedia?.id);
      if(mediaBus==='programme'&&!liveMedia)mediaBus='preview';
      const programmeMode=mediaBus==='programme',mediaSource=programmeMode?liveMedia:previewMedia,transport=mediaSource?.transport;let mediaDeck=null;
      if(previewMedia?.presentationControls&&window.OpenLivePresentationSource?.mountControls){
        const player=make('section',mediaTarget||content,undefined,'bc-present-player');player.setAttribute('aria-label','Selected presentation player');mediaDeck=player;
        if(mediaTarget)mediaTarget.hidden=false;
        const controls=window.OpenLivePresentationSource.mountControls(player,{source:previewMedia,document:doc,
          getProgramme:()=>studio.programmeMedia?.(previewMedia.id),
          getProgrammeSources:()=>window.OpenLivePresentationSource.programmeSources(studio),
          initialBus:presentBus,initialProgrammeId:presentProgrammeId,
          onBusChange:bus=>{presentBus=bus;},onProgrammeChange:id=>{presentProgrammeId=id;},
          guard:()=>{try{editable(scene,choice);return selected===choice.key&&studio.sources.get(sourceSlot(choice)?.sourceId)===previewMedia;}catch(_){return false;}},
          onError:error=>tell(error.message||String(error))});
        playerRefresh=()=>controls.refresh();playerDispose=()=>controls.destroy();
      }
      if(transport){
        const player=make('section',mediaTarget||content,undefined,'bc-media-player');player.setAttribute('aria-label','Selected media player');player.classList.toggle('is-docked',!!mediaTarget);mediaDeck=player;if(mediaTarget)mediaTarget.hidden=false;
        const format=value=>{const tenths=Math.round(Math.max(0,value||0)*10);return Math.floor(tenths/600)+':'+String(Math.floor(tenths/10)%60).padStart(2,'0')+'.'+tenths%10;};
        const guard=()=>{editable(scene,choice);if(studio.sources.get(sourceSlot(choice)?.sourceId)!==previewMedia||(programmeMode&&studio.programmeMedia?.(previewMedia.id)!==mediaSource))throw Error('The selected media changed.');};
        const playerOwner={},contentPlayer=window.OpenLiveBroadcastPlayer?.create(mediaSource,{owner:playerOwner,
          guard:()=>{try{guard();return true;}catch(_){return false;}}});
        if(contentPlayer)player.setAttribute('data-content-player',contentPlayer.reference.kind);
        const command=(name,value)=>{
          guard();
          if(contentPlayer)return contentPlayer.command(name,value);
          // Compatibility for older embedded pages which omit the shared module.
          if(name==='rate')return transport.setRate(value);
          if(name==='trim')return transport.trim(value.start,value.end);
          if(name==='transition')return transport.transition(value.type,value.durationMs);
          if(name==='cue'){transport.pause();return transport.seek(transport.bounds().start);}
          return transport[name](value);
        };
        const action=fn=>{guard();tell('');const result=fn();playerRefresh?.();if(result?.then)return result.then(()=>playerRefresh?.());return result;};
        const persist=()=>{Object.assign(mediaSource._sourceConfig||{},mediaSource.config);if(!programmeMode&&studio.save()===false)throw Error('Media settings could not be saved.');};
        const tool=(parent,label,asset,fn)=>{const node=button(parent,'',fn);make('span',node,label,'bc-media-button-label');node.setAttribute('aria-label',label);node.title=label;
          const glyph=make('span',node,undefined,'bc-media-icon');glyph.setAttribute('aria-hidden','true');glyph.style.cssText=mediaMask(asset);return node;};
        const head=make('div',player,undefined,'bc-media-heading mon-head'),identity=make('div',head,undefined,'bc-media-identity');
        const kind=make('span',identity,undefined,'bc-media-kind bc-media-icon');kind.setAttribute('role','img');kind.setAttribute('aria-label',mediaSource.audioOnly?'Audio file':'Video file');kind.title=mediaSource.audioOnly?'Audio file':'Video file';kind.style.cssText=mediaMask(mediaSource.audioOnly?'audio':'video');make('strong',identity,mediaSource.label||'Media');
        const buses=make('div',head,undefined,'bc-media-buses');buses.setAttribute('role','group');buses.setAttribute('aria-label','Media transport bus');
        const previewTab=tool(buses,'Preview','monitor-preview',()=>{mediaBus='preview';signature='';refresh();}),programmeTab=tool(buses,'Programme','monitor-programme',()=>{if(!studio.programmeMedia?.(previewMedia.id))return;mediaBus='programme';signature='';refresh();});
        previewTab.setAttribute('aria-label','Control Preview media');programmeTab.setAttribute('aria-label','Control Programme media');
        previewTab.setAttribute('aria-pressed',String(!programmeMode));programmeTab.setAttribute('aria-pressed',String(programmeMode));previewTab.classList.toggle('on',!programmeMode);programmeTab.classList.toggle('on',programmeMode);
        previewTab.title='Control Preview · independent from Programme';programmeTab.title=liveMedia?'Control the independent live Programme player':'Cut/Fade this media to Programme first';player.classList.toggle('is-programme',programmeMode);
        const state=make('span',head,undefined,'bc-media-state');
        const clock=make('div',head,undefined,'bc-media-clock'),time=make('output',clock),total=make('span',clock);time.setAttribute('aria-live','off');
        const body=mediaTarget?make('div',player,undefined,'bc-media-workbench'):player;
        const timelinePane=mediaTarget?make('div',body,undefined,'bc-media-timeline'):player;
        const track=make('div',timelinePane,undefined,'bc-media-track');
        make('div',track,undefined,'bc-media-selection');make('div',track,undefined,'bc-media-progress');
        const waveform=mountMediaWaveform(track,previewMedia);
        const filmstrip=mountMediaFilmstrip(track,previewMedia);
        const timeline=make('input',track);timeline.type='range';timeline.step='.01';timeline.setAttribute('aria-label','Media playback position');
        timeline.addEventListener('input',()=>run(()=>action(()=>command('seek',Number(timeline.value)))));
        const trimHandles={},fields={};let trimDrag=null;
        const syncFields=()=>{const {start,end}=transport.bounds();fields.In.value=start.toFixed(2);fields.Out.value=end.toFixed(2);};
        const setTrim=(key,time,save=true)=>{const {start,end,duration}=transport.bounds();
          const value=key==='In'?Math.max(0,Math.min(end-.02,time)):Math.max(start+.02,Math.min(duration,time));
          command('trim',{start:key==='In'?value:start,end:key==='Out'?value:end});syncFields();if(save)persist();};
        const finishTrim=()=>{if(!trimDrag)return;trimDrag=null;run(()=>{if(programmeMode?studio.programmeMedia?.(previewMedia.id)===mediaSource:studio.sources.get(mediaSource.id)===mediaSource)persist();});};
        playerDispose=()=>{waveform?.destroy();filmstrip?.destroy();finishTrim();contentPlayer?.release(playerOwner);};
        for(const key of ['In','Out']){
          const handle=button(track,key,()=>{});handle.classList.add('on','bc-media-handle','bc-media-handle-'+key.toLowerCase());handle.setAttribute('role','slider');
          handle.setAttribute('aria-label','Trim '+key.toLowerCase()+' point');handle.title='Drag '+key+' point · arrow keys adjust by 0.1 seconds';trimHandles[key]=handle;
          const position=event=>{const rect=track.getBoundingClientRect();return (event.clientX-rect.left)/rect.width*transport.bounds().duration;};
          handle.addEventListener('pointerdown',event=>{if(event.button!==0||handle.disabled||trimDrag)return;run(()=>{guard();event.preventDefault();event.stopPropagation();try{handle.setPointerCapture(event.pointerId);}catch(_){}trimDrag={handle,pointerId:event.pointerId};});});
          handle.addEventListener('pointermove',event=>{if(trimDrag?.handle!==handle||trimDrag.pointerId!==event.pointerId)return;run(()=>action(()=>setTrim(key,position(event),false)));});
          const finish=event=>{if(trimDrag?.handle!==handle||trimDrag.pointerId!==event.pointerId)return;finishTrim();try{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);}catch(_){}};
          handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish);
          handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();run(()=>action(()=>{
            const {start,end,duration}=transport.bounds(),current=key==='In'?start:end;
            setTrim(key,event.key==='Home'?0:event.key==='End'?duration:current+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?1:.1));}));});
        }
        const ruler=make('div',timelinePane,undefined,'bc-media-ruler');const ticks=Array.from({length:5},()=>make('span',ruler));
        const controls=make('div',timelinePane,undefined,'bc-media-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label','Media playback controls');
        const transportDetails=()=>transport.details?.()||{playing:!mediaSource.el.paused,direction:'forward',mode:mediaSource.config.loop===false?'hold':'loop',rate:mediaSource.config.rate||1,cycles:0};
        const toggle=tool(controls,'Play','play',()=>action(()=>command(transportDetails().playing?'pause':'play')));toggle.classList.add('bc-media-play');
        tool(controls,'Stop','stop',()=>action(()=>command('stop'))).title='Stop and return to playback start';
        tool(controls,'Cue In','cue',()=>action(()=>command('cue'))).title='Pause and cue to In';
        for(const [label,asset,seconds] of [['Skip back 5 seconds','back',-5],['Skip forward 5 seconds','forward',5]]){
          const skip=tool(controls,label,asset,()=>action(()=>command('seek',mediaSource.el.currentTime+seconds)));skip.classList.add('bc-media-skip');
        }
        const loop=tool(controls,'Loop','loop',()=>action(()=>{command('loop',!['loop','pingpong'].includes(transportDetails().mode));persist();}));loop.setAttribute('aria-label','Loop selected media');loop.title='Switch between Loop and Play Once and Hold';
        const remaining=make('output',controls,undefined,'bc-media-remaining');remaining.setAttribute('aria-live','off');
        const options=make('div',timelinePane,undefined,'bc-media-options');
        const directionGroup=make('div',options,undefined,'bc-media-direction');directionGroup.setAttribute('role','group');directionGroup.setAttribute('aria-label','Media playback direction');
        const directions={};
        for(const [value,label,asset] of [['reverse','Reverse','back'],['forward','Forward','forward']]){
          const control=tool(directionGroup,label,asset,()=>action(()=>{command('direction',value);persist();}));
          control.setAttribute('aria-label','Play media '+value);control.title=label+(value==='reverse'?' · video seeking; audio is muted':'');directions[value]=control;
        }
        const modeLabel=make('label',options),mode=make('select',modeLabel);modeLabel.title='Playmode';mode.setAttribute('aria-label','Media playmode');
        for(const [value,label] of [['loop','Loop'],['pingpong','Ping Pong'],['hold','Play Once and Hold'],['clear','Play Once and Eject']])make('option',mode,label).value=value;
        mode.addEventListener('change',()=>run(()=>action(()=>{command('mode',mode.value);persist();})));
        const rateLabel=make('label',options,'Speed'),rate=make('input',rateLabel);rate.type='number';rate.min='.25';rate.max='2';rate.step='.05';rate.setAttribute('aria-label','Media playback speed');rate.title='Playback speed · 0.25× to 2×';
        rate.addEventListener('change',()=>run(()=>action(()=>{command('rate',Number(rate.value));persist();})));
        const wrapOptions=make('div',timelinePane,undefined,'bc-media-options bc-media-loop-options');
        const transitionLabel=make('label',wrapOptions,'Loop transition'),transition=make('select',transitionLabel);transition.setAttribute('aria-label','Media loop transition');
        for(const [value,label] of [['cut','Cut'],['dissolve','Video dissolve']])make('option',transition,label).value=value;
        const transitionTimeLabel=make('label',wrapOptions,'ms'),transitionTime=make('input',transitionTimeLabel);transitionTime.type='number';transitionTime.min='0';transitionTime.max='2000';transitionTime.step='10';transitionTime.setAttribute('aria-label','Media loop dissolve duration');
        const updateTransition=()=>{command('transition',{type:transition.value,durationMs:Number(transitionTime.value)});persist();};
        transition.addEventListener('change',()=>run(()=>action(updateTransition)));transitionTime.addEventListener('change',()=>run(()=>action(updateTransition)));
        transition.title='Blend the outgoing video frame over the start of the next loop. Audio restarts at In.';
        const motion=make('output',timelinePane,undefined,'bc-media-motion');motion.setAttribute('aria-live','off');
        const meter=make('div',timelinePane,undefined,'bc-media-level');meter.setAttribute('aria-label','Selected media audio level');
        const meterLabel=make('span',meter,'Audio level'),meterChannels={};
        for(const channel of ['left','right']){const group=make('div',meter,undefined,'bc-media-level-channel');make('span',group,channel==='left'?'L':'R');const bar=make('span',group,undefined,'bc-media-level-track'),fill=make('span',bar,undefined,'bc-media-level-fill'),peak=make('span',bar,undefined,'bc-media-level-peak');meterChannels[channel]={bar,fill,peak};}
        const meterValue=make('output',meter,'N/A','bc-media-level-value');meterValue.setAttribute('aria-live','off');
        const bottom=make('div',timelinePane,undefined,'bc-media-bottom'),marks=make('div',bottom,undefined,'bc-media-marks');
        const inButton=tool(marks,'Mark In','mark-in',()=>action(()=>setTrim('In',mediaSource.el.currentTime))),outButton=tool(marks,'Mark Out','mark-out',()=>action(()=>setTrim('Out',mediaSource.el.currentTime)));
        const selectionTime=make('span',marks,undefined,'bc-media-range-label');
        tool(marks,'Reset','reset',()=>action(()=>{command('trim',{start:0,end:transport.bounds().duration});mediaSource.config.trimOut=null;syncFields();persist();})).setAttribute('aria-label','Reset trim');
        const fine=make('details',bottom,undefined,'bc-media-fine'),summary=make('summary',fine,'Fine trim');summary.title='Edit exact In and Out times';
        const fineIcon=make('span',summary,undefined,'bc-media-icon');fineIcon.setAttribute('aria-hidden','true');fineIcon.style.cssText=mediaMask('edit');
        const trim=make('form',fine,undefined,'bc-media-trim');
        for(const key of ['In','Out']){const label=make('label',trim,key+' (s)'),input=make('input',label);input.type='number';input.step='.01';input.min='0';input.required=true;input.setAttribute('aria-label','Media trim '+key.toLowerCase());fields[key]=input;}
        syncFields();const apply=make('button',trim,'Apply trim','btn');apply.type='submit';
        trim.addEventListener('submit',event=>{event.preventDefault();run(()=>action(()=>{command('trim',{start:Number(fields.In.value),end:Number(fields.Out.value)});syncFields();persist();}));});
        const note=make('p',timelinePane,undefined,'bc-media-note');make('span',note,programmeMode?'Changes affect live output':'Take with Cut/Fade','bc-media-note-text');note.title=programmeMode?'This is the independent live Programme player.':'Cue, seek and trim in Preview without changing Programme. Cut/Fade cues the selected direction. Local file bytes are preserved.';
        make('span',note,programmeMode?'ON PROGRAMME':'PREVIEW ONLY','bc-media-shared');
        playerRefresh=()=>{contentPlayer?.refresh();const {start,end,duration}=transport.bounds(),current=mediaSource.el.currentTime||0,detail=transportDetails(),playing=detail.playing;
          timeline.min=0;timeline.max=duration;timeline.value=current;
          const status=transport.state();state.textContent=status;state.classList.toggle('is-playing',playing);
          time.textContent=format(current);total.textContent='/ '+format(duration);remaining.textContent='−'+format(Math.max(0,detail.direction==='reverse'?current-start:end-current))+' left';
          toggle.querySelector('.bc-media-button-label').textContent=playing?'Pause':'Play';
          toggle.classList.toggle('on',playing);toggle.setAttribute('aria-label',playing?'Pause':'Play');toggle.title=playing?'Pause playback':'Play selected range';
          toggle.querySelector('.bc-media-icon').style.cssText=mediaMask(playing?'pause':'play');
          const repeats=['loop','pingpong'].includes(detail.mode);loop.setAttribute('aria-pressed',String(repeats));loop.classList.toggle('on',repeats);
          for(const [value,control] of Object.entries(directions)){const active=detail.direction===value;control.setAttribute('aria-pressed',String(active));control.classList.toggle('on',active);}
          mode.value=detail.mode;
          if(doc.activeElement!==rate)rate.value=String(detail.rate);
          transition.value=mediaSource.config.loopTransition||'cut';
          if(doc.activeElement!==transitionTime)transitionTime.value=String(mediaSource.config.loopTransitionMs??250);
          const modeNames={loop:'Loop',pingpong:'Ping Pong',hold:'Play Once and Hold',clear:'Play Once and Eject'};
          motion.textContent=(detail.direction==='reverse'?'← Reverse':'→ Forward')+' · '+modeNames[detail.mode]+(repeats?' · '+(detail.cycles||0)+(detail.cycles===1?' cycle':' cycles'):'')+(detail.direction==='reverse'?' · Audio muted':'');
          motion.title=detail.error||'Direction and boundary action for the selected playback range';
          if(detail.error)motion.textContent=detail.error;
          const audio=studio.sourceAudioMeter?.(previewMedia.id,{bus:mediaBus}),percentage=db=>Number.isFinite(db)?clamp((db+60)/60*100,0,100):0;
          for(const channel of ['left','right']){const value=audio?.[channel],view=meterChannels[channel];view.fill.style.width=percentage(value?.db)+'%';view.peak.style.left=percentage(value?.peakDb)+'%';view.peak.hidden=!value||value.peak<=0;view.bar.title=value?channel+' · '+(Number.isFinite(value.db)?value.db.toFixed(1):'−∞')+' dBFS RMS · peak '+(Number.isFinite(value.peakDb)?value.peakDb.toFixed(1):'−∞')+' dBFS':'No measured audio available';}
          meterValue.textContent=audio?(Number.isFinite(audio.peakDb)?audio.peakDb.toFixed(1):'−∞')+' dBFS':'N/A';meterLabel.title='Measured source audio after its mixer gain, before local speaker mute';
          selectionTime.textContent=format(start)+' to '+format(end)+' · '+format(end-start);
          inButton.title='Set In to '+format(current);outButton.title='Set Out to '+format(current);
          for(const [key,value] of [['In',start],['Out',end]]){const handle=trimHandles[key];handle.style.left=(duration?value/duration*100:0)+'%';handle.setAttribute('aria-valuemin',key==='In'?0:start+.02);handle.setAttribute('aria-valuemax',key==='In'?end-.02:duration);handle.setAttribute('aria-valuenow',value);handle.setAttribute('aria-valuetext',format(value));}
          track.style.cssText='--trim-in:'+(duration?start/duration*100:0)+'%;--trim-out:'+(duration?end/duration*100:100)+'%;--playhead:'+(duration?current/duration*100:0)+'%';
          ticks.forEach((node,index)=>node.textContent=format(duration*index/4));
          player.querySelectorAll('button,input,select').forEach(input=>input.disabled=!enabled()||!duration);programmeTab.disabled=!enabled()||!liveMedia;
          if(contentPlayer){timeline.disabled=timeline.disabled||!contentPlayer.supports('seek');
            toggle.disabled=toggle.disabled||!contentPlayer.supports(playing?'pause':'play');
            loop.disabled=loop.disabled||!contentPlayer.supports('loop');
            for(const input of Object.values(fields))input.disabled=input.disabled||!contentPlayer.supports('trim');}
          for(const [value,control] of Object.entries(directions))control.disabled=control.disabled||!transport.direction||value==='reverse'&&!!mediaSource.audioOnly;
          mode.disabled=mode.disabled||!transport.mode||contentPlayer&&!contentPlayer.supports('mode');for(const option of mode.querySelectorAll('option'))option.disabled=option.value==='pingpong'&&!!mediaSource.audioOnly;rate.disabled=rate.disabled||!transport.setRate||contentPlayer&&!contentPlayer.supports('rate');
          transition.disabled=transition.disabled||!transport.transition||detail.mode!=='loop'||!!mediaSource.audioOnly||contentPlayer&&!contentPlayer.supports('transition');
          transitionTime.disabled=transition.disabled||transition.value!=='dissolve';
        };playerRefresh();
      }
      const inspector=make('div',content,undefined,'bc-free-inspector');if(mediaDeck&&!mediaTarget)content.appendChild(mediaDeck);
      inspector.hidden=!inline;
      if(!choice)make('p',inspector,'Select a source or overlay to edit its position and stacking order.');
      else if(!choiceMovable){if(canEditContent(choice)){const control=button(inspector,'Open editor',()=>openContent(scene,choice)),why=rowControlReason(scene,choice,'edit');control.disabled=!!why;if(why)control.title=why;}make('p',inspector,'This item keeps its scene paint order.');}
      else{
        const order=make('div',inspector,undefined,'bc-free-actions');
        for(const [text,dir] of [['Bring to front','front'],['Bring forward','forward'],['Send backward','backward'],['Send to back','back']]){
          const b=button(order,text,()=>{requireReorder(scene,choice);studio.moveFreeLayer(scene.id,choice.key,dir);changed();});
          const index=stack.findIndex(row=>row.key===choice.key),why=rowControlReason(scene,choice,'reorder');b.disabled=!!why||(['front','forward'].includes(dir)&&index===stack.length-1)||(['back','backward'].includes(dir)&&index===0);if(why)b.title=why;
        }
        if(choice.part){const control=button(inspector,'Edit overlay · scale, position, rotate & align',()=>openContent(scene,choice)),why=rowControlReason(scene,choice,'edit');control.disabled=!!why;if(why)control.title=why;}
        else{
          const editWhy=rowControlReason(scene,choice,'edit'),info=properties(choice);if(info){const control=button(inspector,info.label,()=>openProperties(scene,choice,info.source));control.disabled=!!editWhy;if(editWhy)control.title=editWhy;}
          const binding=make('label',inspector,'Source binding'),bindSelect=make('select',binding);bindSelect.setAttribute('aria-label','Selected source binding');
          make('option',bindSelect,'Unbound: reconnect a source').value='';
          for(const source of studio.sources.values()){const option=make('option',bindSelect,source.label);option.value=source.id;}
          bindSelect.value=choice.slot.sourceId||'';
          bindSelect.disabled=!!editWhy;if(editWhy)bindSelect.title=editWhy;
          bindSelect.addEventListener('change',()=>run(()=>{if(selected!==choice.key)throw Error('The selected source changed. Select it again.');editableLayer(scene,choice);const why=rowControlReason(scene,choice,'edit');if(why)throw Error(why);if(scene.slots[choice.index]!==choice.slot)throw Error('The source changed.');if(!studio.bind(scene.id,choice.index,bindSelect.value||null))throw Error('Source binding could not be saved.');changed();}));
          const rect=studio.sourceRectNormalized(scene,choice.index),form=make('form',inspector),inputs={};form.className='bc-free-transform';
          for(const [key,label] of [['x','X (%)'],['y','Y (%)'],['w','Width (%)'],['h','Height (%)'],['rotation','Rotation (°)']]){
            const field=make('label',form,label),input=make('input',field);input.type='number';input.step='0.01';input.required=true;input.setAttribute('aria-label',label);
            input.value=draft?.[key]??String(Math.round(rect[key]*(key==='rotation'?1:100)*100)/100);inputs[key]=input;
          }
          transformInputs=inputs;transformOwner={scene,key:choice.key,slot:choice.slot,sourceId:choice.slot.sourceId,pose};
          const submit=make('button',form,'Apply transform','btn');submit.type='submit';
          form.addEventListener('submit',event=>{event.preventDefault();run(()=>{const next={};for(const [key,input] of Object.entries(inputs))next[key]=input.value===''?NaN:Number(input.value)/(key==='rotation'?1:100);update(scene,choice.index,next,choice);});});
          const align=make('div',inspector,undefined,'bc-free-actions');
          for(const [label,edge] of [['Left','left'],['Center','center'],['Right','right'],['Top','top'],['Middle','middle'],['Bottom','bottom']])button(align,'Align '+label.toLowerCase(),()=>update(scene,choice.index,alignRect(studio.sourceRectNormalized(scene,choice.index),edge),choice));
          const reset=button(inspector,'Reset transform',()=>update(scene,choice.index,resetSourcePose(choice),choice));
          button(inspector,choice.slot.hidden?'Show source':'Hide source',()=>changeItem(scene,choice,{hidden:!choice.slot.hidden}));
          button(inspector,choice.slot.mute?'Unmute source':'Mute source',()=>{editableLayer(scene,choice);studio.updateFreeSource(scene.id,choice.index,{mute:!choice.slot.mute});changed();});
          const remove=button(inspector,'Remove from scene',()=>itemDialog(scene,choice,'remove')),removeWhy=rowControlReason(scene,choice,'remove');remove.disabled=!!removeWhy;if(removeWhy)remove.title=removeWhy;
          if(choice.slot.locked||studio.sources.get(choice.slot.sourceId)?.audioOnly){
            form.querySelectorAll('input,button').forEach(n=>n.disabled=true);align.querySelectorAll('button').forEach(n=>n.disabled=true);
            reset.disabled=true;
            make('p',inspector,choice.slot.locked?'Unlock this item to edit its transform.':'Audio-only sources have no canvas transform.');
          }
        }
      }
      {
        const toolbar=make('div',root,undefined,'bc-source-toolbar');toolbar.setAttribute('aria-label','Source controls');
        if(openSources)iconButton(toolbar,'Add source','plus',()=>{editable(scene);openSources();});
        const removeWhy=rowControlReason(scene,choice,'remove'),remove=iconButton(toolbar,'Remove source item','minus',()=>{if(removable(scene,choice))itemDialog(scene,choice,'remove');});remove.disabled=!removable(scene,choice)||!!removeWhy;
        remove.title=removeWhy||(choice?.part||choice?.kind==='template'?'Remove selected item from Preview':'Remove selected source item from Preview');
        const info=properties(choice);if(info){const props=button(toolbar,externalInspector?'':info.label,()=>openProperties(scene,choice,info.source));props.classList.add('bc-source-artwork');props.setAttribute('aria-label',info.label+' for selected source');const why=rowControlReason(scene,choice,'edit');props.disabled=!!why;props.title=why||(externalInspector?info.label+' · ':'')+(info.health.why||'Edit this Preview source’s properties.');if(externalInspector)icon(props,'edit');}
        if(canEditContent(choice)){const edit=button(toolbar,externalInspector?'':'Open editor',()=>openContent(scene,choice));edit.classList.add('bc-source-artwork');edit.setAttribute('aria-label','Open editor for selected item');edit.title='Open editor for selected item';if(externalInspector)icon(edit,'edit');const why=rowControlReason(scene,choice,'edit');edit.disabled=!!why;if(why)edit.title=why;}
        const transform=transformInfo(scene,choice),transformButton=iconButton(toolbar,'Edit transform','cogs',()=>openTransform(scene,choice,true));
        transformButton.disabled=!!transform.why;transformButton.title=transform.why||'Edit this item’s position, size and placement in Preview.';
        if(transform.mode==='source')transformButton.setAttribute('aria-expanded',String(inline));
        if(transform.why){transformButton.setAttribute('aria-describedby',transformHintId);const hint=make('p',root,transform.why,'bc-free-transform-hint');hint.id=transformHintId;}
        const position=choiceMovable?stack.findIndex(row=>row.key===choice.key):-1;
        const reorderWhy=rowControlReason(scene,choice,'reorder');
        iconButton(toolbar,'Move source up','up',()=>{requireReorder(scene,choice);studio.moveFreeLayer(scene.id,choice.key,'forward');changed();}).disabled=!!reorderWhy||position<0||position===stack.length-1;
        iconButton(toolbar,'Move source down','down',()=>{requireReorder(scene,choice);studio.moveFreeLayer(scene.id,choice.key,'backward');changed();}).disabled=!!reorderWhy||position<=0;
        if(typeof studio.sceneContentHistory==='function'){
          const history=studio.sceneContentHistory(scene.id);
          for(const [text,action,available,label] of [['Undo','undoSceneContent',history.canUndo,history.undoLabel],['Redo','redoSceneContent',history.canRedo,history.redoLabel]]){
            const control=button(toolbar,'',async()=>{editable(scene);await studio[action](scene.id,{isCurrent:()=>current(scene)&&enabled()});changed();tell(text+' · '+(label||'scene item change')+'.');});
            control.classList.add('bc-source-history-'+text.toLowerCase());control.setAttribute('aria-label',text+' source item change');control.title=text+' · '+(label||'scene item change');control.disabled=!available;
            const glyph=make('span',control,undefined,'bc-source-icon');glyph.setAttribute('aria-hidden','true');
          }
        }
        make('span',toolbar,'Top = front · Preview only','bc-source-stack-note');
        if(!enabled())root.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);
      }
      make('p',root,'','bc-free-status').setAttribute('role','status');
      list.scrollTop=scrollTop;
      if(focused)[...root.querySelectorAll('[aria-label]'),...overlay.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focused)?.focus({preventScroll:true});
    }
    function selectContent(key){const scene=getScene();if(!destroyed&&scene&&contents(scene).some(row=>row.key===key)){selected=key;owner=scene;signature='';refresh();return true;}return false;}
    return {refresh,selection(){const scene=getScene();return scene===owner&&movable(scene,contents(scene).find(row=>row.key===selected))?{scene,key:selected}:null;},contentSelection(){const scene=getScene(),row=scene===owner&&contents(scene).find(item=>item.key===selected);return row?{scene,row,key:selected}:null;},selectContent,selectLayer(id){return selectContent('part:'+id);},selectSource(index){return selectContent('source:'+index);},destroy(){if(destroyed)return;destroyed=true;owner=null;selected=null;playerDispose?.();playerDispose=null;playerRefresh=null;healthRefresh=null;clearItemDrag();cancel();closeMenu();itemModal?.remove();doc.removeEventListener('keydown',escape);stage.removeEventListener?.('pointerdown',pickPointer);stage.removeEventListener?.('pointermove',movePointer);stage.removeEventListener?.('pointerup',finishPointer);stage.removeEventListener?.('pointercancel',cancelPointer);stage.removeEventListener?.('lostpointercapture',cancelPointer);overlay.remove();root.replaceChildren();if(mediaTarget){mediaTarget.replaceChildren();mediaTarget.hidden=true;}}};
  }
  return Object.freeze({mount,alignRect,gestureRect,hitPoint});
})();
