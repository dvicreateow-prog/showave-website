/* Local files enter Broadcast through the same prepared source transaction as
   Add Source. Original documents and decoded media stay in this session.
   UNDOCUMENTED — inferring: Broadcast's independent Preview source stack is an
   operator-requested extension to manual/sources.htm and preparing-media.htm. */
window.OpenLiveSourceFileDrop=(()=>{
  'use strict';
  const MAX_FILES=20;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  // Keep each picture's actual aspect ratio in output space. The point is the
  // centre of the new element; backgrounds deliberately use the whole output.
  function imagePlacement({width,height,canvasWidth=1920,canvasHeight=1080,point=null,offset=0,mode='element'}={}){
    if(mode==='background')return {x:0,y:0,w:1,h:1,rotation:0};
    if(!(width>0&&height>0&&canvasWidth>0&&canvasHeight>0))throw Error('This image has no decoded picture size.');
    const ratio=(width/height)/(canvasWidth/canvasHeight);
    let w=.38,h=w/ratio;if(h>.44){h=.44;w=h*ratio;}
    // Very narrow images still retain their ratio; the compositor supports a
    // minimum 1% box, so refuse a misleading pose rather than stretching them.
    if(w<.01||h<.01)throw Error('This image is too narrow for a canvas element. Use a cropped image.');
    const step=(offset%6)*.045,cx=point?.x??(.38+step),cy=point?.y??(.38+step);
    if(!Number.isFinite(cx)||!Number.isFinite(cy))throw Error('Choose a valid canvas position.');
    return {x:clamp(cx-w/2,0,1-w),y:clamp(cy-h/2,0,1-h),w,h,rotation:0};
  }
  const imageExt=/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico|apng|tiff?)$/i;
  const videoExt=/\.(?:mp4|m4v|webm|mov|avi|mkv|ogv|ogg|mpg|mpeg|m2ts|mts|ts|3gp|flv|wmv)$/i;
  const audioExt=/\.(?:mp3|wav|wave|aac|m4a|flac|oga|opus|aiff?|wma)$/i;
  const presentationExt=/\.(?:pptx|pptm|ppsx|ppsm)$/i;
  const displayName=file=>String(file?.name||'Local file').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120)||'Local file';
  function classify(file){
    if(!file||typeof file.name!=='string')return {error:'Drop local image, video, audio, PowerPoint or PDF files.'};
    const name=file.name,mime=String(file.type||'').toLowerCase(),unknown=!mime||mime==='application/octet-stream';
    if(/\.(?:ppt|pps|pot|potx|potm)$/i.test(name))
      return {error:'Save this PowerPoint as .pptx, then drop that file into Preview.'};
    if(presentationExt.test(name))return {type:'present',config:{file,mode:'powerpoint'}};
    if(/\.pdf$/i.test(name))return {type:'present',config:{file,mode:'pdf'}};
    if(mime==='application/pdf')return {error:'Use a PDF file with a .pdf filename.'};
    if(/(?:powerpoint|presentationml)/.test(mime))
      return {error:'Save this PowerPoint as .pptx, then drop that file into Preview.'};
    if(mime.startsWith('image/')||unknown&&imageExt.test(name))return {type:'image',config:{file}};
    if(mime.startsWith('video/')||mime.startsWith('audio/')||unknown&&(videoExt.test(name)||audioExt.test(name)))
      return {type:'media',config:{file,loop:true}};
    return {error:'Unsupported file. Drop an image, video, audio, .pptx/.ppsx/.pptm/.ppsm or PDF file.'};
  }
  // Compare editable scene content, excluding runtime clocks and private caches.
  // The captured identity and refresh generation also reject switching away and
  // back while a browser decoder or original document is still preparing.
  const sceneStamp=scene=>JSON.stringify([scene?.layout,scene?.layoutPending,scene?.sourceWorkflow,scene?.slots,
    scene?.fullTemplateId,scene?.fullTemplateStyle,scene?.fullTemplateExtras,scene?.svgParts,
    scene?.svgPartsMode,scene?.svgPartsExtras,scene?.freeOrder]);
  function mount({studio,root,statusRoot=root,previewRoot,placementCanvas,getScene,enabled=()=>true,acquire,onCommitted,onStatus,
    document:doc=root?.ownerDocument||document}){
    if(!studio||!root||typeof getScene!=='function')throw Error('A Studio source drop target is required.');
    const intake=acquire||window.OpenLiveSourceAcquisition?.create({document:doc});
    const picker=window.OpenLiveSourcePicker;
    if(typeof intake!=='function'||typeof picker?.session!=='function')throw Error('Local source preparation is unavailable.');
    let destroyed=false,active=null,generation=0;
    const listeners=[];
    const panel=doc.createElement('div');panel.className='bc-source-file-drop';
    const hint=doc.createElement('div');hint.className='bc-source-file-drop-hint';
    hint.textContent='Drop images, video, audio, PowerPoint or PDF here or on Preview.';
    const status=doc.createElement('div');status.className='bc-source-file-drop-status';
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const progress=doc.createElement('progress');progress.className='bc-source-file-drop-progress';
    progress.max=100;progress.hidden=true;progress.setAttribute('aria-label','Local source preparation');
    const cancelButton=doc.createElement('button');cancelButton.type='button';cancelButton.className='btn';cancelButton.textContent='Cancel import';cancelButton.hidden=true;
    cancelButton.addEventListener('click',()=>cancel(active,'Import cancelled. Sources already added remain in Preview.'));
    panel.appendChild(hint);panel.appendChild(status);panel.appendChild(progress);panel.appendChild(cancelButton);
    function allowed(){try{return enabled()!==false;}catch(_){return false;}}
    function attach(){if(!destroyed&&!statusRoot.contains(panel))statusRoot.appendChild(panel);}
    function tell(state,message,details={}){
      if(destroyed)return;
      attach();panel.dataset.state=state;status.textContent=message;
      progress.hidden=state!=='loading';
      cancelButton.hidden=!active||active.cancelled;
      if(state==='loading'){
        const percent=details.progress?.percent;
        if(typeof percent==='number'&&Number.isFinite(percent))progress.value=Math.max(0,Math.min(100,percent));
        else progress.removeAttribute('value');
      }
      try{onStatus?.({state,message,...details});}catch(_){/* UI reporting does not own a prepared source. */}
    }
    const sourceStamp=scene=>[...new Set((scene.slots||[]).map(slot=>slot.sourceId).filter(Boolean))].map(id=>{
      const owner=studio.sources.get(id);
      return {id,owner,signature:JSON.stringify([owner?.label,owner?.sourceType,owner?.config])};
    });
    const sourcesCurrent=job=>job.sources.every(({id,owner,signature})=>{
      const current=studio.sources.get(id);
      return current===owner&&JSON.stringify([current?.label,current?.sourceType,current?.config])===signature;
    });
    const owns=job=>!destroyed&&active===job&&job.generation===generation&&!job.cancelled&&allowed()&&
      getScene()===job.scene&&studio.scenes().includes(job.scene)&&!job.scene.layoutPending&&sceneStamp(job.scene)===job.stamp&&sourcesCurrent(job);
    function clearHighlights(){for(const surface of [root,previewRoot])surface?.classList.toggle('bc-source-file-drag',false);}
    function cancel(job,message){
      if(!job||job.cancelled)return;
      job.cancelled=true;job.reason=message;generation++;job.flow?.cancel();clearHighlights();
      tell('cancelled',message,{loaded:job.records.length,total:job.files.length});
    }
    function refresh(){
      if(destroyed)return;
      attach();panel.setAttribute('aria-disabled',String(!allowed()));
      if(active&&!owns(active))cancel(active,'The Preview scene or layout changed. Pending files were released; drop them again into the selected scene.');
      if(!active&&!status.textContent)tell('idle',allowed()?'Files are added to Preview. Take with Cut/Fade when ready.':'Enable Studio Mode to add local files to Preview.');
    }
    async function importFiles(input,options={}){
      const files=Array.from(input||[]),records=[],errors=[];
      const fail=message=>{errors.push({file:null,message});tell('error',message,{loaded:0,total:files.length});return {records,errors,cancelled:false};};
      if(destroyed)return {records,errors:[{file:null,message:'This source drop target has closed.'}],cancelled:true};
      if(active){
        const message='Files are still preparing. Wait for this drop to finish, then add more.';
        tell('busy',message,{loaded:active.records.length,total:active.files.length});
        return {records,errors:[{file:null,message}],cancelled:false};
      }
      if(!files.length)return fail('No local files were received. Drop files from your device.');
      if(files.length>MAX_FILES)return fail('Drop up to '+MAX_FILES+' files at a time.');
      if(!allowed())return fail('Enable Studio Mode to add local files to Preview.');
      if(options.signal?.aborted)return {records,errors:[],cancelled:true};
      if(options.mode!==undefined&&!['element','background'].includes(options.mode))return fail('Choose Element or Background placement.');
      const scene=getScene();
      if(!scene||!studio.scenes().includes(scene)||scene.layoutPending)return fail('Choose a Preview scene and layout before dropping files.');
      const job={scene,stamp:sceneStamp(scene),sources:sourceStamp(scene),generation,files,records,errors,flow:null,cancelled:false,reason:''};active=job;
      const abort=()=>cancel(job,'Import cancelled. Sources already added remain in Preview.');
      options.signal?.addEventListener('abort',abort,{once:true});
      try{
        for(const [index,file] of files.entries()){
          if(!owns(job)){cancel(job,'The Preview scene or layout changed. Remaining files were not added.');break;}
          const choice=classify(file),fileLabel=displayName(file);
          if(choice.error){errors.push({file,message:choice.error});tell('error',fileLabel+': '+choice.error,{file,loaded:records.length,total:files.length});continue;}
          const name=picker.uniqueName(studio,fileLabel);
          const position=(index+1)+' / '+files.length;
          const report=event=>{
            if(!owns(job))return;
            const detail=String(event?.message||'Preparing source');
            tell('loading',position+' · '+fileLabel+' · '+detail,{file,loaded:records.length,total:files.length,progress:event});
          };
          tell('loading',position+' · Opening '+fileLabel+'…',{file,loaded:records.length,total:files.length});
          let flow=null;
          try{
            // Dropped/library images are independent canvas objects. Keep
            // existing template/feed layers when converting a fixed scene.
            flow=picker.session({studio,scene,isCurrent:()=>owns(job),acquire:intake,independent:choice.type==='image'||scene.sourceWorkflow!=='obs'});job.flow=flow;
            const prepared=await flow.prepare(choice.type,{...choice.config,_onProgress:report},name);
            if(!owns(job)){cancel(job,'The Preview scene or layout changed. Pending files were released.');break;}
            if(choice.type==='image'){
              const canvas=placementCanvas||previewRoot?.querySelector('canvas'),size=studio.sizeOf?.(prepared)||{};
              const point=options.point?{x:options.point.x+(index%6)*.025,y:options.point.y+(index%6)*.025}:null;
              prepared.initialTransform=imagePlacement({width:size.w||prepared.el?.naturalWidth,height:size.h||prepared.el?.naturalHeight,
                canvasWidth:canvas?.width||1920,canvasHeight:canvas?.height||1080,point,offset:scene.slots.length,mode:options.mode||'element'});
              prepared.initialOutputFit=options.mode==='background'?'cover':'contain';
              if(options.mode==='background')prepared.initialLayer='background';
              if(options.designAsset&&prepared.config)prepared.config.designAsset=options.designAsset;
            }
            const added=await flow.commitNew(name);
            records.push(...added);
            // The successful placement is our own mutation, so advance the
            // expected content before Broadcast repaints and calls refresh().
            job.stamp=sceneStamp(scene);job.sources=sourceStamp(scene);
            try{await onCommitted?.(added,{scene});}catch(error){
              errors.push({file,message:'The source was added, but its controls could not refresh: '+(error.message||String(error))});
            }
          }catch(error){
            if(!owns(job)){cancel(job,'The Preview scene or layout changed. Pending files were released; already added sources stay in their original scene.');break;}
            errors.push({file,message:error.message||String(error)});
            tell('error',fileLabel+': '+(error.message||String(error)),{file,loaded:records.length,total:files.length});
          }finally{flow?.cancel();if(job.flow===flow)job.flow=null;}
        }
        if(!job.cancelled){
          const summary=records.length+' source'+(records.length===1?'':'s')+' added to Preview'+(errors.length?'; '+errors.length+' file'+(errors.length===1?'':'s')+' could not be added. '+displayName(errors[0].file)+': '+errors[0].message:'. Take with Cut/Fade when ready.');
          tell(errors.length?'error':'ready',summary,{loaded:records.length,total:files.length});
        }
        return {records,errors,cancelled:job.cancelled};
      }finally{options.signal?.removeEventListener('abort',abort);if(active===job)active=null;cancelButton.hidden=true;clearHighlights();}
    }
    // OS file drags may reveal no files until drop. Never claim the app's
    // artwork/source MIME or text/URL drags, which have separate owners.
    const external=event=>{
      const types=Array.from(event.dataTransfer?.types||[]);
      if(types.includes('application/x-showave-source')||types.includes('application/x-showave-template-piece')||types.includes('application/x-showave-design-element'))return false;
      return types.includes('Files')||Array.from(event.dataTransfer?.files||[]).length>0;
    };
    function listen(surface,type,fn){surface.addEventListener(type,fn);listeners.push(()=>surface.removeEventListener(type,fn));}
    for(const surface of [...new Set([root,previewRoot].filter(Boolean))]){
      const highlight=event=>{
        if(!external(event))return;
        event.preventDefault();event.stopPropagation();
        if(event.dataTransfer)event.dataTransfer.dropEffect=allowed()&&!active?'copy':'none';
        surface.classList.toggle('bc-source-file-drag',allowed()&&!active);
      };
      listen(surface,'dragenter',highlight);listen(surface,'dragover',highlight);
      listen(surface,'dragleave',event=>{if(!surface.contains(event.relatedTarget))surface.classList.toggle('bc-source-file-drag',false);});
      listen(surface,'drop',event=>{
        if(!external(event))return;
        event.preventDefault();event.stopPropagation();clearHighlights();
        const canvas=placementCanvas||previewRoot?.querySelector('canvas'),box=canvas?.getBoundingClientRect();
        const point=surface===previewRoot&&box?.width>0&&box?.height>0?{x:clamp((event.clientX-box.left)/box.width,0,1),y:clamp((event.clientY-box.top)/box.height,0,1)}:null;
        return importFiles(Array.from(event.dataTransfer?.files||[]),{point});
      });
    }
    refresh();
    return {importFiles,refresh,isBusy:()=>!!active,cancel(){cancel(active,'Import cancelled. Sources already added remain in Preview.');},destroy(){
      if(destroyed)return;
      cancel(active,'Local source preparation cancelled.');destroyed=true;generation++;
      listeners.forEach(dispose=>dispose());clearHighlights();panel.remove();
    }};
  }
  return Object.freeze({classify,mount,imagePlacement,MAX_FILES});
})();
