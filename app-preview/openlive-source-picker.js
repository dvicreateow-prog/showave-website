/* Add Source workflow. Legacy scenes opt in only through the Assets layer action. */
window.OpenLiveSourcePicker=(()=>{
  'use strict';
  const types=Object.freeze([
    {id:'application-audio',label:'Application Audio Capture',unavailable:'Requires a native audio-capture integration. Use shared-tab audio in Display Capture where the browser offers it.'},
    {id:'audio-input',label:'Audio Input Capture',help:'A standalone microphone or audio interface, routed through SHOWAVE’s own Programme mixer. No OBS connection is used.'},
    {id:'audio-output',label:'Audio Output Capture · shared audio',help:'Choose a tab or screen and enable Share audio. Availability depends on this browser/OS. This is shared audio, not a native output-device selector. No audio track means preparation fails.'},
    {id:'browser',label:'Browser / widget',help:'A website or browser widget as a video-only source. Public HTTP(S) URLs only; browser audio and local/private pages are not supported.'},
    {id:'color',label:'Color',help:'A solid-color source, useful for backgrounds and panels.'},
    {id:'screen',label:'Display Capture',help:'The browser asks which display, window or tab to share. Audio depends on the selected surface.'},
    {id:'game',label:'Game Capture',unavailable:'Native game hooking requires a desktop capture integration. Use Window or Display Capture instead.'},
    {id:'image',label:'Image / graphic / logo',help:'Choose a local image, graphic or logo. It stays on this computer; no upload is required.'},
    {id:'slideshow',label:'Image Slide Show',help:'Play local images in selection order, with configurable timing and looping. Rendered directly by SHOWAVE.'},
    {id:'media',label:'Media',help:'Choose a local video or audio file. Decode support depends on this browser’s codecs. Audio uses the Programme mixer.'},
    {id:'present',label:'Present · PowerPoint / PDF',help:'Open an original PowerPoint or PDF in OpenLive. No Office installation or window capture is required. Present controls navigate independent Preview and Programme slides through the usual effects and transforms.'},
    {id:'ndi',label:'NDI® Source · Webcam Input',help:'Capture NDI video like a capture card, using an installed NDI Webcam Input device. Select the network feed in NDI Webcam Input first. No OBS connection; direct network discovery and PTZ are not implemented here.'},
    {id:'scene',label:'Scene',unavailable:'Nested scenes are not supported by this compositor yet. Reuse individual existing sources instead.'},
    {id:'text',label:'Text',help:'Create a transparent text layer and customise its wording, colour and size.'},
    {id:'lower-third',label:'Lower third / captions',help:'A name and title card. Add, move and edit it like any other source.'},
    {id:'ticker',label:'Ticker',help:'A scrolling text source with its own wording, colours and speed.'},
    {id:'countdown',label:'Countdown timer',help:'A timer source. Start, pause and reset it from its source controls.'},
    {id:'qr',label:'QR code',help:'A scannable link with an optional label, rendered locally.'},
    {id:'product-card',label:'Product / live sales',help:'A product card with a price, description and scannable link.'},
    {id:'camera',label:'Video Capture Device',help:'Select a camera and requested resolution. Camera permission is requested only when you prepare the preview.'},
    {id:'window',label:'Window Capture',help:'Uses the browser’s sharing chooser. Select a window there; the browser makes the final surface choice.'},
    {id:'live',label:'SHOWAVE Live',help:'Choose one connected Show, Layer or Map output. Other live inputs remain unchanged.'}
  ]);
  const categories=Object.freeze([['all','All sources'],['capture','Capture'],['media','Media'],['graphics','Graphics']]);
  const graphicIds=new Set(['color','image','slideshow','text','lower-third','ticker','countdown','qr','product-card','scene']);
  const catalog=Object.freeze(types.map(type=>Object.freeze({...type,category:graphicIds.has(type.id)?'graphics':['media','present'].includes(type.id)?'media':'capture',sourceType:type.id,icon:['lower-third','ticker','countdown'].includes(type.id)?'text':['qr','product-card'].includes(type.id)?'image':type.id})).concat([
    Object.freeze({id:'artwork-pieces',label:'Artwork pieces',category:'graphics',artworkView:'pieces',icon:'artwork',help:'Choose native artwork, customise it and add it as an independent layer.'})
  ]));
  const creativeIds=new Set(['lower-third','ticker','countdown','qr','product-card']);
  function nativeCandidates(studio,scene,type){
    if(!['lower-third','ticker','qr'].includes(type)||typeof studio.sceneContents!=='function')return [];
    return studio.sceneContents(scene).filter(row=>{
      const component=row.component;if(!['part','template'].includes(row.kind)||!component)return false;
      if(type==='qr')return component.editableQr===true;
      if(component.category==='qr'||component.categories?.includes('qr'))return false;
      return component.editableText===true&&(type==='ticker'?component.type==='ticker':['headline','lower-third'].includes(component.type));
    });
  }
  function preferredNative(rows,scene,getSelection){
    const selection=getSelection?.();return rows.find(row=>selection?.scene===scene&&selection.key===row.key)||(rows.length===1?rows[0]:null);
  }
  const unavailable=entry=>entry.unavailable||(entry.sourceType==='browser'&&window.OpenLiveSessionPolicy?.sessionOnly
    ?'Browser sources are unavailable in this session because their renderer needs files. Open the page in a browser, then use Window Capture.':
    ['lower-third','ticker','qr'].includes(entry.sourceType)&&typeof window.OpenLiveTemplateSources?.creativeDefinitions==='function'&&
      !window.OpenLiveTemplateSources.creativeDefinitions(entry.sourceType).length
      ?'No bundled sample designs are included for this source type. Use Text or import your own artwork.':'');
  const compositionSignature=scene=>JSON.stringify([scene?.slots,scene?.fullTemplateId,scene?.fullTemplateStyle,scene?.fullTemplateExtras,scene?.svgParts,scene?.svgPartsMode,scene?.svgPartsExtras,scene?.freeOrder,scene?.sourceWorkflow,scene?.layoutPending]);
  function renderCatalog({doc,parent,category='all',query='',artwork=false,active=true,isCurrent,onFilter,onChoose,onError}){
    const node=(tag,owner,text)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;owner.append(element);return element;};
    const controls=node('div',parent);controls.className='bc-source-filters';
    const categoryLabel=node('label',controls,'Category'),categoryInput=node('select',categoryLabel);categoryInput.setAttribute('aria-label','Source category');
    for(const [value,label] of categories){const option=node('option',categoryInput,label);option.value=value;}categoryInput.value=category;categoryInput.disabled=!active;
    const searchLabel=node('label',controls,'Search'),search=node('input',searchLabel);search.type='search';search.value=query;search.placeholder='Search sources';search.setAttribute('aria-label','Search sources');search.disabled=!active;
    const list=node('div',parent);list.className='bc-source-types';list.setAttribute('role','group');list.setAttribute('aria-label','Source types');
    function current(){if(isCurrent())return true;onError('The editing scene changed. Choose a source again.');return false;}
    function paint(){
      list.replaceChildren();
      const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),entries=catalog.filter(entry=>(artwork||!entry.artworkView)&&(category==='all'||entry.category===category)&&words.every(word=>(entry.label+' '+entry.help+' '+entry.sourceType).toLocaleLowerCase().includes(word)));
      for(const entry of entries){
        const reason=unavailable(entry),button=node('button',list,entry.label+(reason?' · unavailable':''));button.type='button';button.className='btn';button.disabled=!active;
        button.setAttribute('data-source-choice',entry.id);if(entry.sourceType)button.setAttribute('data-source-type',entry.sourceType);if(entry.artworkView)button.setAttribute('data-artwork-view',entry.artworkView);
        button.title=reason||entry.help||'';button.setAttribute('aria-description',button.title);if(reason)button.setAttribute('aria-disabled','true');window.OpenLiveSourceIcons?.prepend(button,entry.icon);
        button.onclick=()=>{if(!current())return false;if(!list.contains(button)){onError('The source choices changed. Choose a source again.');return false;}const why=unavailable(entry);if(why){onError(why);return false;}return onChoose(entry,button);};
      }
      if(!entries.length)node('p',list,'No sources match. Try another search or category.').className='bc-source-empty';
    }
    const filter=()=>{if(!current())return;category=categoryInput.value;query=search.value;onFilter({category,query});paint();};
    categoryInput.onchange=filter;search.oninput=filter;paint();return {categoryInput,search,list};
  }
  const enabled=scene=>scene?.sourceWorkflow==='obs';
  const nameKey=name=>name.trim().toLocaleLowerCase();
  function validateName(studio,name){
    if(typeof name!=='string'||!name.trim()||name.trim().length>120||/[\u0000-\u001f]/.test(name))throw Error('Use a source name of 1–120 characters.');
    if([...studio.sources.values()].some(s=>nameKey(s.label)===nameKey(name)))throw Error('That name is already in use. Choose Add existing or use a different name.');
    return name.trim();
  }
  function uniqueName(studio,base){base=String(base).slice(0,120);let name=base,n=2;while([...studio.sources.values()].some(s=>nameKey(s.label)===nameKey(name))){const suffix=' '+n++;name=base.slice(0,120-suffix.length)+suffix;}return name;}
  function session({studio,scene,isCurrent=()=>true,acquire,slotIndex,independent=false,editIndex}){
    if(!enabled(scene)&&!independent)throw Error('The new source workflow applies only to new blank scenes.');
    if(!scene||scene.layoutPending)throw Error('Choose a scene and layout before adding sources.');
    const editing=editIndex!==undefined,originalSlot=editing?scene.slots[editIndex]:null;
    if(editing&&(!Number.isInteger(editIndex)||!originalSlot||!studio.sources.get(originalSlot.sourceId)?.sourceType))throw Error('Select an editable source.');
    let ended=false,revision=0,prepared=null,preparedPlayback=null,abort=null;
    const layout=scene.layout,slots=JSON.stringify(scene.slots);
    const composition=()=>compositionSignature(scene);
    const originalComposition=composition();
    const valid=()=>!ended&&isCurrent()&&studio.scenes().includes(scene)&&scene.layout===layout&&JSON.stringify(scene.slots)===slots&&composition()===originalComposition;
    const check=()=>{if(!valid())throw Error('The target scene changed. Cancel and open Add Source again.');};
    function release(){abort?.abort();abort=null;preparedPlayback=null;if(prepared){prepared.dispose?.();prepared=null;}}
    function reset(){revision++;release();}
    function waitForMediaFrame(result,signal,ticket){
      return new Promise((resolve,reject)=>{
        let timer=null,poll=null,settled=false;const el=result.el;
        const events=['seeked','loadeddata','canplay','error','emptied'];
        const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);
          for(const event of events)el.removeEventListener(event,sample);signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
        const cancel=()=>finish(Error('Source preparation cancelled. Nothing was added.'));
        const sample=()=>{if(ticket!==revision||prepared!==result||signal.aborted||!valid()){cancel();return;}
          const health=studio.sourceStatus(result);if(health.ok&&!el.seeking){finish();return;}
          if(!health.ok&&health.state!=='loading')finish(Error(health.why||'This media source could not be decoded.'));};
        for(const event of events)el.addEventListener(event,sample);signal.addEventListener('abort',cancel,{once:true});
        timer=setTimeout(()=>finish(Error('A decoded media frame did not become ready within 5 seconds. Choose the file again or try another format.')),5000);
        poll=setInterval(sample,50);sample();
      });
    }
    function resumeCommittedMedia(spec){
      const playback=preparedPlayback;preparedPlayback=null;
      if(playback?.spec===spec&&playback.playing)try{Promise.resolve(spec.transport.play()).catch(()=>{});}catch(_){}
      // A failed browser Play remains visible in the transport's real status;
      // it must not undo a successfully admitted and saved source placement.
    }
    async function prepare(type,config,name){
      check();validateName(studio,name);reset();const ticket=revision;abort=new AbortController();const signal=abort.signal;
      const result=await acquire(type,config,signal);
      if(ticket!==revision||!valid()){result.dispose?.();throw Error('Source preparation cancelled. Nothing was added.');}
      prepared=result;
      try{
        // A short loop can be seeking exactly when Add/Save is pressed. Freeze
        // the dialog-owned decoder, finish that seek, and retain a stable real
        // frame until commit. Only a successfully committed Preview resumes it.
        if(result.sourceType==='media'&&!result.el?.srcObject&&typeof result.transport?.pause==='function'&&typeof result.transport?.play==='function'){
          preparedPlayback={spec:result,playing:result.transport.details?.().playing??!result.el.paused};result.transport.pause();
          const health=studio.sourceStatus(result);
          if(result.el.seeking||!health.ok&&health.state==='loading')await waitForMediaFrame(result,signal,ticket);
          else if(!health.ok)throw Error(health.why||'This media source could not be decoded.');
        }
        if(ticket!==revision||prepared!==result||!valid())throw Error('Source preparation cancelled. Nothing was added.');
        return result;
      }catch(error){if(prepared===result)release();throw error;}
    }
    function finishNew(name,visible,place){
      check();name=validateName(studio,name);if(!prepared)throw Error('Prepare the source preview first.');
      const health=studio.sourceStatus(prepared);if(!health.ok)throw Error(health.why||'This source is no longer ready. Prepare it again.');
      const spec=prepared;let record;
      try{
        record=spec.kind==='video'?studio.addMediaSource({...spec,label:name}):studio.addSource({...spec,label:name});
        place([record.id],{visible,slotIndex});
      }catch(error){if(record){studio.discardUnplacedSource(record.id);prepared=null;}throw error;}
      prepared=null;ended=true;resumeCommittedMedia(spec);return [record];
    }
    function commitNew(name,visible=true){
      check();
      if(editing){
        name=validateName(studio,name);if(!prepared)throw Error('Prepare the source preview first.');
        const health=studio.sourceStatus(prepared);if(!health.ok)throw Error(health.why||'This source is no longer ready. Prepare it again.');
        const spec=prepared;prepared=null;
        const record=studio.replaceSceneSource(scene,editIndex,{...spec,label:name},{expected:originalSlot,isCurrent:valid});
        ended=true;resumeCommittedMedia(spec);return [record];
      }
      if(!independent)return finishNew(name,visible,(ids,options)=>studio.insertSceneSources(scene,ids,options));
      const ticket=revision;
      return studio.prepareSourceLayerPlacement(scene,{isCurrent:()=>valid()&&revision===ticket})
        .then(place=>finishNew(name,visible,place));
    }
    function commitExisting(ids,visible=true){
      check();if(editing)throw Error('Use source properties to update this placement.');
      if(new Set(ids).size!==ids.length)throw Error('Choose each existing source once.');
      if(independent){const ticket=revision;return studio.prepareSourceLayerPlacement(scene,{isCurrent:()=>valid()&&revision===ticket}).then(place=>{
        check();place(ids,{visible});ended=true;release();return ids.map(id=>studio.sources.get(id));
      });}
      studio.insertSceneSources(scene,ids,{visible,slotIndex});ended=true;release();return ids.map(id=>studio.sources.get(id));
    }
    return {prepare,commitNew,commitExisting,reset,cancel(){ended=true;reset();},valid};
  }
  function mount({studio,getScene,acquire,devices=async()=>[],liveInputs=()=>[],requestDeviceAccess,onCommitted,openArtwork,onSelectTemplateSource,getSelection,onOpenChange,document:doc=document}){
    const dialog=doc.createElement('dialog');dialog.className='bc-source-dialog';dialog.setAttribute('aria-label','Add Source');doc.body.append(dialog);
    const hasArtwork=typeof openArtwork==='function';
    let flow=null,owner=null,opener=null,step=0,type='',mode='new',preferExisting=false,name='',visible=true,chosen=[],config={},ready=null,busy=false,status='',serial=0,independent=false,editing=false,editingSource=null,category='all',query='',embeddedTarget=null,nativeChoices=[],propertiesView=null;
    const node=(tag,parent,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;};
    const button=(parent,text,fn)=>{const b=node('button',parent,text);b.className='btn';b.type='button';b.onclick=fn;return b;};
    const close=({focus=true}={})=>{
      const wasOpen=!!dialog.open;serial++;propertiesView?.destroy();propertiesView=null;flow?.cancel();flow=null;ready=null;busy=false;
      if(dialog.open)dialog.close();
      if(embeddedTarget){doc.body.append(dialog);embeddedTarget=null;dialog.classList.toggle('bc-source-embedded',false);}
      if(wasOpen)onOpenChange?.(false,{scene:owner,embedded:false,opener,focus});
      if(focus&&opener?.isConnected&&!opener.closest?.('[hidden]'))opener.focus();
    };
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    const embeddedEscape=event=>{
      if(event.key!=='Escape'||event.defaultPrevented||!dialog.open||!embeddedTarget||!dialog.contains(doc.activeElement))return;
      event.preventDefault();event.stopPropagation();close();
    };
    dialog.addEventListener('keydown',embeddedEscape);
    const tell=error=>{status=error.message||String(error);render();};
    function attempt(fn){try{return fn();}catch(error){tell(error);}}
    function launchArtwork(view){
      if(!flow?.valid()||getScene()!==owner)throw Error('The target scene changed. Open Add Source again.');
      if(!hasArtwork||view!=='pieces')throw Error('This artwork view is unavailable.');
      const context={scene:owner,opener};close();return openArtwork(view,context);
    }
    function launchNative(row){
      if(!flow?.valid()||getScene()!==owner)throw Error('The target scene changed. Open Add Source again.');
      const current=nativeCandidates(studio,owner,type).find(candidate=>candidate.key===row.key);
      if(!current||row.kind==='part'&&current.part!==row.part)throw Error('This template source changed. Choose its current layer again.');
      const context={scene:owner,opener};close({focus:false});return onSelectTemplateSource(current,context);
    }
    function chooseType(value,label,{forceNew=false}={}){
      type=value;name=uniqueName(studio,label);config={};chosen=[];nativeChoices=typeof onSelectTemplateSource==='function'?nativeCandidates(studio,owner,type):[];
      if(!forceNew){const target=preferredNative(nativeChoices,owner,getSelection);if(target)return launchNative(target);}
      const placed=creativeIds.has(type)?[...new Set(owner.slots.map(slot=>slot.sourceId).filter(id=>studio.sources.get(id)?.sourceType===type))]:[];
      const selection=getSelection?.(),selectedSource=selection?.scene===owner?studio.sceneContents?.(owner).find(row=>row.key===selection.key&&row.kind==='source')?.sourceId:null;
      mode=forceNew?'new':nativeChoices.length?'native':preferExisting||placed.length?'existing':'new';
      chosen=forceNew?[]:placed.includes(selectedSource)?[selectedSource]:placed.length===1?placed:[];step=1;status='';render();return true;
    }
    function commit(fn){
      if(busy)return;const request=serial;
      const done=records=>{if(request!==serial)return;const updated=editing;close();onCommitted?.(records,{updated});};
      const fail=error=>{if(request!==serial)return;busy=false;flow.reset();ready=null;tell(error);};
      try{
        const result=fn();
        if(!result?.then){done(result);return;}
        busy=true;status='Preparing scene layers…';render();return result.then(done,fail);
      }catch(error){fail(error);}
    }
    function field(parent,label,key,kind='text',value=''){
      const wrap=node('label',parent,label),input=node(kind==='textarea'?'textarea':'input',wrap);if(kind!=='textarea')input.type=kind;input.setAttribute('aria-label',label);
      // A browser file input cannot be repopulated with its displayed path.
      // Keep the chosen File in config.file/files and leave this control empty.
      if(kind==='file')return input;
      input.value=config[key]??value;
      if(kind==='checkbox')input.checked=config[key]??value;
      config[key]=kind==='checkbox'?input.checked:input.value;
      input.oninput=()=>{config[key]=kind==='checkbox'?input.checked:input.value;};return input;
    }
    function select(parent,label,key,options){
      const wrap=node('label',parent,label),input=node('select',wrap);input.setAttribute('aria-label',label);
      for(const [value,text] of options){const opt=node('option',input,text);opt.value=value;}
      const value=config[key]??options[0]?.[0]??'';input.value=value;
      // Device options arrive asynchronously. Keep the saved exact device id
      // instead of silently replacing it with the default while they load.
      config[key]=String(value);input.onchange=()=>config[key]=input.value;return input;
    }
    function overflowControls(parent){
      const overflow=select(parent,'Overflow','overflow',[['scroll','Scroll'],['clip','Clip at fixed size']]);
      overflow.onchange=()=>{config.overflow=overflow.value;render();};
      if(config.overflow==='scroll'){
        const speed=field(parent,'Scroll speed (HD px/sec)','overflowSpeed','number',config.speed??80);speed.min='1';speed.max='600';
      }
      node('p',parent,'Scroll moves text that exceeds its box. Clip keeps the chosen font size and hides text outside the box.');
    }
    function matching(source){return source.sourceType?source.sourceType===type:({camera:['camera'],screen:['screen'],window:['screen'],image:['image'],media:['video'],live:['showave'],color:['color'],text:['text'],slideshow:['slideshow'],'audio-input':['audio']}[type]||[]).includes(source.kind);}
    function render(){
      const hadFocus=dialog.contains(doc.activeElement);propertiesView?.destroy();propertiesView=null;dialog.replaceChildren();
      const title=editing?'Source properties':'Add Source';dialog.setAttribute('aria-label',title);
      const head=node('header',dialog);head.className='mon-head';node('h2',head,title);button(head,'×',close).setAttribute('aria-label','Close '+title);
      node('p',dialog,(owner?.name||'Scene')+' · Preview only. Programme changes only with Cut/Fade.');
      if(editing)node('p',dialog,'Editing '+(owner.slots[flow.editIndex]?.label||editingSource.label)+'. Save replaces this Preview placement; reuse the updated source in other scenes with Add existing.');
      if(independent&&step>0&&mode!=='native')node('p',dialog,owner?.layout!=='free'||owner?.fullTemplateId||owner?.svgPartsMode==='parts-only'
        ?'Add creates a free canvas with the template artwork and bound frames kept as layers, starting a new layer undo history. The new source goes on top; move it in Sources. Cancel keeps the current layout.'
        :'Adds an independent layer above the artwork. Move, resize, rotate or reorder it in Sources. Folder uploads stay separate.');
      node('p',dialog,editing?'Properties & preview':['1 · Choose what to add','2 · Create / reuse','3 · Properties & preview'][step]).className='bc-source-step mon-head';
      let firstChoice=null;
      const body=node('div',dialog);body.className='bc-source-body';
      body.inert=busy;
      if(step===0){
        const shortcuts=node('div',body);shortcuts.className='bc-source-shortcuts';
        const reuse=button(shortcuts,'Reuse existing source',()=>attempt(()=>{
          if(!flow?.valid())throw Error('The target scene changed. Open Add Source again.');
          preferExisting=!preferExisting;status='';render();
        }));reuse.setAttribute('aria-pressed',String(preferExisting));reuse.classList.toggle('on',preferExisting);
        window.OpenLiveSourceIcons?.prepend(reuse,'plus');
        if(preferExisting)node('p',body,'Reuse mode · choose a source type below, then select a source from this session.');
        const chooser=renderCatalog({doc,parent:body,category,query,artwork:hasArtwork,
          isCurrent:()=>!!flow?.valid()&&getScene()===owner,
          onFilter:state=>{category=state.category;query=state.query;},onError:error=>tell(error),
          onChoose:entry=>attempt(()=>{
            if(entry.artworkView)return launchArtwork(entry.artworkView);
            return chooseType(entry.sourceType,entry.label);
          })});
        firstChoice=chooser.search;
      }else{
        const t=types.find(t=>t.id===type);node('h3',body,t.label).className='mon-head';node('p',body,t.help);
        if(step===1){
          const modes=node('div',body);modes.className='bc-source-modes';
          for(const [key,label] of [...(nativeChoices.length?[['native','Existing template']]:[]),['new','Create new'],['existing','Add existing']]){const b=button(modes,label,()=>{mode=key;status='';render();});b.setAttribute('aria-pressed',String(mode===key));b.classList.toggle('on',mode===key);}
          if(mode==='native'){
            node('p',body,'These template sources are already in this scene. Choose the exact layer to edit.');
            const list=node('div',body);list.className='bc-source-types';list.setAttribute('aria-label','Existing template sources');
            for(const [index,row] of nativeChoices.entries()){
              const entry=button(list,row.label+' · '+(index+1),()=>attempt(()=>launchNative(row)));entry.setAttribute('data-native-source-key',row.key);
              entry.setAttribute('aria-label','Edit '+row.label+' · '+row.key);
            }
          }else if(mode==='new'){
            const label=node('label',body,'Source name'),input=node('input',label);input.setAttribute('aria-label','Source name');input.maxLength=120;input.value=name;input.oninput=()=>name=input.value;
          }else{
            const items=[...studio.sources.values()].filter(matching);node('p',body,'Reuses the same capture. Visibility, position and layer order belong to this scene.');
            if(!items.length)node('p',body,'No existing sources of this type. Choose Create new.');
            for(const source of items){
              const health=studio.sourceStatus(source),label=node('label',body,source.label+(!health.ok?' · '+health.state:'')),input=node('input',label);
              input.type='checkbox';input.checked=chosen.includes(source.id);input.setAttribute('aria-label','Reuse '+source.label);
              input.onchange=()=>{chosen=input.checked?[...chosen,source.id]:chosen.filter(id=>id!==source.id);};
              if(studio.removeUnusedSource){
                const remove=button(body,'Remove unused source',()=>attempt(()=>{studio.removeUnusedSource(source.id);chosen=chosen.filter(id=>id!==source.id);status='Removed unused source: '+source.label;render();}));
                remove.setAttribute('aria-label','Remove unused '+source.label);remove.disabled=studio.sourceInUse(source.id);
                remove.title=remove.disabled?'Used by a scene, Programme or undo history. Remove its placements first.':'Releases this unused capture and its saved source settings.';
              }
            }
          }
          if(mode!=='native'){const label=node('label',body,'Make source visible'),input=node('input',label);input.type='checkbox';input.checked=visible;input.setAttribute('aria-label','Make source visible');input.onchange=()=>visible=input.checked;}
        }else if(ready){
          const preview=node('div',body);preview.className='bc-source-preview';
          if(ready.audioOnly){node('p',preview,'Audio capture is ready. Local monitoring is off to prevent feedback.');}
          else preview.append(ready.el);
          if(type==='ndi'){
            const actual=ready.stream?.getVideoTracks?.()[0]?.getSettings?.()||{};
            node('p',body,'NDI capture device frames received. Verify the intended feed in this preview; a device picture alone does not confirm a live NDI sender.');
            if(actual.width&&actual.height)node('p',body,'Device format: '+actual.width+' × '+actual.height+(actual.frameRate?' · '+Math.round(actual.frameRate*100)/100+' fps':''));
          }
          if(ready.sourceType==='media')node('p',body,'Media preview is paused here to keep a decoded frame ready. Add or Save restores its playback in Preview.');
          node('p',body,editing?'Prepared changes. Save to Preview keeps the placement and layer settings for this session. Preview audio is muted.':'Prepared, not added yet. Preview audio is muted. Add to scene places this layer in Preview for this session; Cancel releases only this new source.');
        }else{
          const props=node('fieldset',body);props.disabled=busy;node('legend',props,'Properties').className='mon-head';
          const definitions=creativeIds.has(type)&&typeof window.OpenLiveTemplateSources?.creativeDefinitions==='function'?window.OpenLiveTemplateSources.creativeDefinitions(type):[];
          let definition=null;
          if(definitions.length){
            const definitionId=item=>item.templateId||item.id;
            if(typeof window.OpenLiveCreativeSources?.normalize==='function')config=window.OpenLiveCreativeSources.normalize(type,config);
            if(!config.templateId)config.templateId=definitionId(definitions.find(item=>item.templateId==='svg-4')||definitions[0]);
            const template=select(props,'Template','templateId',definitions.map(item=>[definitionId(item),item.label]));
            definition=definitions.find(item=>definitionId(item)===config.templateId)||definitions[0];
            template.onchange=()=>{
              const next=definitions.find(item=>definitionId(item)===template.value);
              if(next&&Number(config.size)===Number(definition.defaultFontSize))config.size=next.defaultFontSize;
              if(next&&config.color===definition.defaultTextColor)config.color=next.defaultTextColor;
              config.templateId=template.value;render();
            };
            node('p',props,'Uses this template’s original artwork, size and placement. Text and links change in Preview.');
          }
          if(type==='ndi'){
            const camera=select(props,'NDI video device','device',[['','Select NDI video device…']]);
            const audio=select(props,'NDI audio device','audioDevice',[['','Video only']]);
            const deviceNote=node('p',props,'Checking installed NDI capture devices…');deviceNote.setAttribute('role','status');
            let scan=0;
            const refresh=async()=>{
              const request=serial,ticket=++scan;
              deviceNote.textContent='Checking installed NDI capture devices…';
              try{
                const items=await devices();if(request!==serial||ticket!==scan||!camera.isConnected)return;
                const found=items.filter(d=>window.OpenLiveSourceAcquisition?.isNDIDevice(d));
                for(const [input,key,kind,placeholder] of [[camera,'device','videoinput','Select NDI video device…'],[audio,'audioDevice','audioinput','Video only']]){
                  input.replaceChildren();const empty=node('option',input,placeholder);empty.value='';
                  const matches=found.filter(d=>d.kind===kind);
                  for(const d of matches){const option=node('option',input,d.label);option.value=d.deviceId;}
                  if(!matches.some(d=>d.deviceId===config[key]))config[key]='';
                  input.value=config[key]||'';
                }
                deviceNote.textContent=found.some(d=>d.kind==='videoinput')
                  ?'Select a video device and its matching audio device, or Video only. Preview audio stays muted.'
                  :'No named NDI video device is visible. Start NDI Webcam Input and allow camera access for SHOWAVE in browser site settings, then Refresh devices. Device names can stay hidden until permission is granted.';
              }catch(error){if(request===serial&&ticket===scan&&camera.isConnected)deviceNote.textContent='Could not list capture devices: '+(error.message||String(error));}
            };
            button(props,'Refresh devices',refresh);void refresh();
            if(requestDeviceAccess){
              const allow=async kind=>{const request=serial;let capture;try{deviceNote.textContent='Allow '+(kind==='video'?'camera':'microphone')+' access in the browser prompt to show device names.';capture=await requestDeviceAccess(kind);}
                catch(error){if(request===serial&&deviceNote.isConnected)deviceNote.textContent='Device access was not granted: '+(error.message||String(error));return;}
                finally{capture?.getTracks?.().forEach(track=>track.stop());}
                if(request===serial&&deviceNote.isConnected)await refresh();};
              button(props,'Allow camera device names',()=>allow('video'));button(props,'Allow audio device names',()=>allow('audio'));
              node('p',props,'Device-name access briefly opens a camera or microphone and releases it. Prepare then opens your selected NDI devices.');
            }
            select(props,'Requested resolution','resolution',[['1920x1080','1920 × 1080'],['1280x720','1280 × 720'],['640x480','640 × 480']]);
            select(props,'Requested frame rate','fps',[[30,'30 fps'],[60,'60 fps'],[25,'25 fps'],[50,'50 fps']]);
            node('p',props,'Prepare opens only the selected NDI devices. Requested formats depend on the device. Cancel releases only this new capture. Reconnect after reload.');
          }else if(type==='browser'){
            const pageUrl=field(props,'Page URL','url','text','');pageUrl.inputMode='url';pageUrl.placeholder='example.com/page';pageUrl.spellcheck=false;pageUrl.autocapitalize='none';
            pageUrl.addEventListener('blur',()=>{try{
              if(window.OpenLiveWidgets&&pageUrl.value.trim())config.url=pageUrl.value=window.OpenLiveWidgets.cleanUrl(pageUrl.value);
            }catch(_){/* Prepare reports an invalid address. */}});
            node('p',props,'Enter a website or widget page address. HTTPS is added automatically when omitted.');
            for(const [key,label,value] of [['width','Viewport width',1280],['height','Viewport height',720]]){const input=field(props,label,key,'number',value);input.min='160';input.max='1920';input.step='1';}
            node('p',props,'Video only, at the local renderer’s refresh rate; 30/60 fps is not guaranteed. Preparation waits for the first decoded page frame. Cancel closes only this renderer; Add existing reuses it. Browser sources must be reconnected after reload.');
          }else if(type==='audio-output'){
            node('p',props,'Prepare opens the browser sharing chooser. Select Share audio. The shared picture is not added to your scene. Stop sharing to end capture. Audio enters Programme only on Cut/Fade.');
          }else if(type==='audio-input'){
            const audio=select(props,'Audio device','device',[['','Default audio input']]);
            const request=serial;Promise.resolve(devices()).then(items=>{if(request!==serial||!audio.isConnected)return;for(const d of items.filter(d=>d.kind==='audioinput')){const o=node('option',audio,d.label||'Audio input '+audio.options.length);o.value=d.deviceId;}
              if(config.device&&!items.some(d=>d.kind==='audioinput'&&d.deviceId===config.device)){const o=node('option',audio,'Saved audio device · unavailable');o.value=config.device;}
              audio.value=config.device||'';}).catch(()=>{});
            field(props,'Echo cancellation','echoCancellation','checkbox',false);field(props,'Noise suppression','noiseSuppression','checkbox',false);field(props,'Automatic gain','autoGainControl','checkbox',false);
            node('p',props,'Permission is requested when you prepare. Audio reaches Programme only after Cut/Fade; it is never played through local speakers here.');
          }else if(type==='present'){
            config.mode=['powerpoint','pdf'].includes(config.mode)?config.mode:
              /\.pdf$/i.test(String(config.file?.name||config.fileName||''))?'pdf':'powerpoint';
            const path=select(props,'Presentation input','mode',[['powerpoint','Imported PowerPoint'],['pdf','Imported PDF']]);
            path.onchange=()=>{flow.reset();config={mode:path.value};status='';render();};
            const input=field(props,config.mode==='pdf'?'PDF file':'PowerPoint file','fileInput','file');
            input.accept=config.mode==='pdf'?'application/pdf,.pdf':'.pptx,.pptm,.ppsx,.ppsm,application/vnd.openxmlformats-officedocument.presentationml.presentation';
            input.onchange=()=>{config.file=input.files[0];};
            if(config.file||config.fileName)node('p',props,(config.file?'Selected: ':'Reconnect file: ')+(config.file?.name||config.fileName));
            node('p',props,'OpenLive plays the original file in memory without an Office installation or saved document copy. Preview and Programme slide positions remain separate.');
            if(config.mode==='powerpoint')node('p',props,'Supported slide content is rendered by OpenLive. Unsupported PowerPoint features are reported by the player. For an external running slideshow, use Window Capture as a separate live source.');
          }else if(type==='slideshow'){
            const input=field(props,'Image files','fileInput','file');input.accept='image/*';input.multiple=true;input.onchange=()=>{config.files=Array.from(input.files);};
            if(config.files)node('p',props,config.files.length+' images selected');
            else if(config.fileNames?.length)node('p',props,'Reconnect images: '+config.fileNames.join(', '));
            const duration=field(props,'Seconds per slide','seconds','number',5);duration.min='1';duration.max='3600';
            field(props,'Loop slide show','loop','checkbox',true);
            node('p',props,'1–32 images in selection order. Playback starts on preparation and continues when reused. Reconnect local files after reloading.');
          }else if(type==='camera'){
            const camera=select(props,'Camera','device',[['','Default camera']]);
            const request=serial;Promise.resolve(devices()).then(items=>{if(request!==serial||!camera.isConnected)return;for(const d of items.filter(d=>d.kind==='videoinput')){const o=node('option',camera,d.label||'Camera '+(camera.options.length));o.value=d.deviceId;}
              if(config.device&&!items.some(d=>d.kind==='videoinput'&&d.deviceId===config.device)){const o=node('option',camera,'Saved camera · unavailable');o.value=config.device;}
              camera.value=config.device||'';}).catch(()=>{});
            select(props,'Requested resolution','resolution',[['1920x1080','1920 × 1080'],['1280x720','1280 × 720'],['640x480','640 × 480']]);
            select(props,'Requested frame rate','fps',[[30,'30 fps'],[60,'60 fps'],[25,'25 fps'],[50,'50 fps']]);
            field(props,'Include microphone audio','audio','checkbox',false);
            node('p',props,'Actual device capabilities may differ. If permission is denied, change the browser permission and retry.');
          }else if(type==='screen'||type==='window'){
            field(props,'Request shared audio','audio','checkbox',true);node('p',props,'Choose the surface and audio in the browser prompt. A website cannot bypass that chooser.');
          }else if(type==='image'||type==='media'){
            const input=field(props,'Local file','fileInput','file');input.accept=type==='image'?'image/*':'video/*,audio/*,.mp4,.mov,.webm,.mkv,.mp3,.wav,.m4a,.ogg,.flac';input.onchange=()=>{config.file=input.files[0];};
            if(config.file)node('p',props,'Selected: '+config.file.name);
            else if(config.fileName)node('p',props,'Reconnect file: '+config.fileName);
            if(type==='media'){
              config.mode=config.mode??(config.loop===false?'hold':'loop');
              const playmode=select(props,'Media playmode','mode',[['loop','Loop'],['pingpong','Ping Pong'],['hold','Play Once and Hold'],['clear','Play Once and Eject']]);
              playmode.onchange=()=>{config.mode=playmode.value;config.loop=['loop','pingpong'].includes(config.mode);};
              select(props,'Playback direction','direction',[['forward','Forward'],['reverse','Reverse · video only, audio muted']]);
              const speed=field(props,'Playback speed','rate','number',1);speed.min='.25';speed.max='2';speed.step='.05';
              node('p',props,'Use Media controls for In/Out points and video loop transitions. Reverse playback seeks video frames and mutes audio.');
            }
            node('p',props,'This is a session-local source, not an Assets-folder upload. Reconnect local files after reloading.');
          }else if(type==='live'){
            const inputs=liveInputs();select(props,'SHOWAVE output','input',inputs.map(i=>[i.id,i.label]));if(!inputs.length)node('p',props,'No SHOWAVE outputs connected. Open SHOWAVE Live, then retry.');
          }else if(type==='color')field(props,'Color','color','color','#164a8a');
          else if(type==='text'){
            const text=field(props,'Text','text','textarea','Your text');text.maxLength=1000;text.rows=3;field(props,'Text color','color','color','#ffffff');field(props,'Font size (px)','size','number',96);
            const searchLabel=node('label',props,'Find a font'),search=node('input',searchLabel);search.type='search';search.placeholder='Search font families';search.setAttribute('aria-label','Find a text font');
            const fonts=select(props,'Font family','fontFamily',[[config.fontFamily||'sans-serif',config.fontFamily||'Default · sans-serif']]);
            const note=node('p',props,'Default preserves the current text style. Online fonts load when you prepare Preview; device fonts use fonts installed on this computer.');
            const renderFonts=()=>{
              const selected=config.fontFamily||'sans-serif',provider=window.OpenLiveSourceAcquisition;
              if(typeof provider?.textFonts!=='function'){search.disabled=true;return;}
              const choices=provider.textFonts(search.value,selected);fonts.replaceChildren();
              for(const item of choices){const option=node('option',fonts,item.label+(item.source==='fontsource'?' · online':item.source==='bundled'?' · bundled':''));option.value=item.name;option.style.fontFamily=item.family;}
              fonts.value=selected;note.textContent=choices.length+' fonts shown. Search to find more. Online fonts load before Preview; device fonts depend on this computer.';
            };
            search.oninput=renderFonts;renderFonts();
          }else if(type==='lower-third'||type==='ticker'){
            if(type==='lower-third'){
              const line1=field(props,'Name / headline','line1','text','Your name');line1.maxLength=160;
              const line2=field(props,'Title / subtitle','line2','text','Your title');line2.maxLength=200;
              if(!definition||definition.authoredExtension)field(props,'Accent color','accent','color','#38bdf8');
            }else{
              const text=field(props,'Ticker text','text','textarea','Your ticker text');text.maxLength=definition&&!definition.authoredExtension?500:1000;text.rows=3;
            }
            field(props,'Text color','color','color',definition?.defaultTextColor||'#ffffff');
            if(type!=='lower-third'||!definition||definition.authoredExtension)field(props,'Background color','background','color','#15325b');
            const native=definition&&!definition.authoredExtension,size=field(props,native?'Font size (template units)':'Font size (px)','size','number',definition?.defaultFontSize||64);size.min=native?'4':'12';size.max=native?'120':'180';size.step='0.01';
            if(native){
              const restore=button(props,'Restore template size',()=>{config.size=definition.defaultFontSize;size.value=String(config.size);});
              restore.title='Use the original template font size: '+definition.defaultFontSize;
              node('p',props,'Template size: '+definition.defaultFontSize+'. Reduce the size manually when needed. Long text never shrinks automatically.');
            }
            overflowControls(props);
          }else if(type==='countdown'){
            const duration=field(props,'Duration (seconds)','duration','number',300);duration.min='1';duration.max='3600';duration.step='1';
            field(props,'Text color','color','color','#ffffff');const size=field(props,'Font size (px)','size','number',150);size.min='36';size.max='200';
            const stored=config.background??'transparent',transparentLabel=node('label',props,'Transparent background'),transparent=node('input',transparentLabel);
            transparent.type='checkbox';transparent.checked=stored==='transparent';transparent.setAttribute('aria-label','Transparent background');
            config.background=transparent.checked?'#15325b':stored;const background=field(props,'Background color','background','color','#15325b');config.background=stored;background.disabled=transparent.checked;
            transparent.onchange=()=>{background.disabled=transparent.checked;config.background=transparent.checked?'transparent':background.value;};
            background.oninput=()=>{if(!transparent.checked)config.background=background.value;};
            node('p',props,'Starts paused. After adding, use this source’s Start, Pause and Reset controls.');
          }else if(type==='qr'||type==='product-card'){
            if(type==='product-card'){
              const title=field(props,'Product title','title','text','Product name');title.maxLength=160;
              const price=field(props,'Price','price','text','');price.maxLength=80;
              const description=field(props,'Description','description','textarea','');description.maxLength=600;description.rows=3;
              field(props,'Accent color','accent','color','#38bdf8');
            }else{const label=field(props,'Label','label','text','Scan to open');label.maxLength=120;}
            const url=field(props,'Link URL','url','text','https://example.com');url.inputMode='url';url.maxLength=1024;
            field(props,type==='qr'?(definition&&!definition.authoredExtension?'Lettering color':'QR color'):'Text color','foreground','color',type==='qr'?'#111827':'#ffffff');
            field(props,type==='qr'&&definition&&!definition.authoredExtension?'Frame color':'Background color','background','color',type==='qr'?'#ffffff':'#15325b');
            if(type==='qr')overflowControls(props);
            node('p',props,'Use an HTTP or HTTPS link. Check the prepared code with a phone before taking the scene live.');
          }
        }
      }
      const message=node('p',dialog,status);message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.className='bc-source-status';
      if(busy&&type==='present'){const progress=node('progress',dialog);progress.className='bc-source-progress';progress.max=100;progress.setAttribute('aria-label','Presentation preparation progress');}
      const foot=node('footer',dialog);
      if(step>0&&(!editing||ready)){const wasReady=!!ready;const back=button(foot,ready?'Change properties':'Back',()=>{flow.reset();ready=null;status='';if(!wasReady)step--;render();});back.disabled=busy;}
      button(foot,'Cancel',close);
      if(step===1&&mode!=='native'){const next=button(foot,mode==='new'?'Next · Properties':'Add to scene',()=>attempt(()=>{
        if(mode==='new'){validateName(studio,name);step=2;status='';render();}
        else return commit(()=>flow.commitExisting(chosen,visible));
      }));next.className='btn on primary';next.disabled=busy;}
      if(step===2){
        const primary=button(foot,ready?(editing?'Save to Preview':'Add to scene'):busy?'Preparing…':'Prepare preview',async()=>{
          if(busy)return;
          if(ready)return commit(()=>flow.commitNew(name,visible));
          busy=true;status='Preparing source…';const request=++serial;
          // Acquire before rendering/awaiting: Display Capture must retain this user gesture.
          const report=value=>{
            if(request!==serial||!dialog.open)return;
            const percent=Number.isFinite(value.percent)?Math.round(value.percent):null;
            status=(value.message||'Preparing presentation')+(percent===null?'…':' · '+percent+'%');
            const message=dialog.querySelector('.bc-source-status');if(message)message.textContent=status;
            const progress=dialog.querySelector('.bc-source-progress');if(progress){if(percent===null)progress.removeAttribute('value');else progress.value=percent;}
          };
          const pending=flow.prepare(type,{...config,...(type==='present'?{_onProgress:report}:{})},name);render();
          try{const result=await pending;if(request!==serial)return;ready=result;status='Ready to add.';}
          catch(error){if(request!==serial)return;status=error.name==='NotAllowedError'?'Permission refused or sharing cancelled. Nothing was added. You can retry.':error.message||String(error);}
          finally{if(request===serial){busy=false;render();}}
        });primary.classList.add('on','primary');primary.disabled=busy;
      }
      if(hadFocus||dialog.open)(step===0?firstChoice:dialog.querySelector('input:not([type=checkbox]), textarea, footer button:not(:disabled)')||dialog)?.focus();
    }
    function open({type:initial='',existing=false,forceNew=false,slotIndex,independent:asLayer=false,editIndex,opener:requestOpener=doc.activeElement,target:requestTarget=null,scene:requestScene}={}){
      close();owner=getScene();independent=asLayer;
      if(!owner||requestScene&&requestScene!==owner||owner.layoutPending||!enabled(owner)&&!independent)return false;
      if(requestTarget&&(!requestTarget.append||requestTarget.isConnected===false))return false;opener=requestOpener;
      editing=editIndex!==undefined;editingSource=editing?studio.sources.get(owner.slots[editIndex]?.sourceId):null;
      if(editing&&!types.some(t=>t.id===editingSource?.sourceType&&!unavailable({...t,sourceType:t.id})))return false;
      flow=session({studio,scene:owner,isCurrent:()=>getScene()===owner,acquire,slotIndex,independent,editIndex});flow.editIndex=editIndex;
      if(initial==='graphic-logo')initial='image';
      type=editing?editingSource.sourceType:types.some(t=>t.id===initial&&!unavailable({...t,sourceType:t.id}))?initial:'';
      step=editing?2:type?1:0;category='all';query='';preferExisting=existing;mode=existing?'existing':'new';
      name=uniqueName(studio,editing?editingSource.label:types.find(t=>t.id===type)?.label||'Source');
      config=editing?{...(editingSource._sourceConfig||editingSource.config||{})}:{};chosen=[];visible=true;nativeChoices=[];
      status=editing&&editingSource.disconnected?(studio.sourceStatus(editingSource).why||'Reconnect this source and prepare its preview.') : '';
      ready=null;
      if(type&&!editing){const selected=chooseType(type,types.find(t=>t.id===type).label,{forceNew});if(!flow)return selected!==false;}
      else render();
      if(requestTarget){embeddedTarget=requestTarget;requestTarget.append(dialog);dialog.classList.toggle('bc-source-embedded',true);dialog.show();}
      else dialog.showModal();
      dialog.querySelector('input, textarea, .bc-source-types button:not([aria-disabled])')?.focus();
      onOpenChange?.(true,{scene:owner,embedded:!!embeddedTarget});return true;
    }
    return {open,close,isOpen:()=>!!dialog.open,isEmbedded:()=>!!dialog.open&&!!embeddedTarget,owner:()=>dialog.open?owner:null,destroy(){close();dialog.removeEventListener?.('keydown',embeddedEscape);dialog.remove();}};
  }
  function mountLauncher({studio,root,getScene,enabled:canEdit=()=>true,openPicker,openArtwork,onSelectTemplateSource,getSelection,document:doc=root.ownerDocument||document}){
    let owner=null,signature='',category='all',query='',reuse=false,generation=0,destroyed=false,message=null;
    root.classList.add('bc-source-launcher');
    const node=(tag,parent,text)=>{const item=doc.createElement(tag);if(text!==undefined)item.textContent=text;parent.append(item);return item;};
    const ready=scene=>!!scene&&!scene.layoutPending&&studio.scenes().includes(scene)&&!!canEdit();
    const stateSignature=scene=>JSON.stringify([scene?.id,scene?.layout,compositionSignature(scene),ready(scene),category,query,reuse,typeof openArtwork,typeof openPicker,!!window.OpenLiveSessionPolicy?.sessionOnly]);
    function tell(error){if(message)message.textContent=error?.message||String(error);}
    function refresh(){
      if(destroyed)return;
      const scene=getScene(),active=ready(scene),next=stateSignature(scene);
      if(scene===owner&&next===signature)return;
      if(scene!==owner){reuse=false;owner=scene;}
      signature=stateSignature(scene);
      const ticket=++generation,layout=scene?.layout,composition=compositionSignature(scene);
      const current=item=>!destroyed&&root.isConnected!==false&&ticket===generation&&getScene()===scene&&scene?.layout===layout&&compositionSignature(scene)===composition&&ready(scene)&&(!item||root.contains(item));
      const run=(item,action)=>{
        if(!current(item)){tell('The editing scene changed. Choose a source again.');return false;}
        try{const result=action();if(result?.then)return result.then(value=>{if(value===false&&current(item))tell('This source is unavailable for the current scene.');return value;},error=>{if(current(item))tell(error);});if(result===false&&current(item))tell('This source is unavailable for the current scene.');return result;}
        catch(error){if(current(item))tell(error);return false;}
      };
      root.replaceChildren();
      renderCatalog({doc,parent:root,category,query,artwork:typeof openArtwork==='function',active,
        isCurrent:()=>current(),onError:tell,onFilter:state=>{category=state.category;query=state.query;signature=stateSignature(scene);},
        onChoose:(entry,item)=>run(item,()=>{
          if(entry.artworkView)return openArtwork(entry.artworkView,{scene,opener:item});
          const target=typeof onSelectTemplateSource==='function'?preferredNative(nativeCandidates(studio,scene,entry.sourceType),scene,getSelection):null;
          return target?onSelectTemplateSource(target,{scene,opener:item}):openPicker?.({type:entry.sourceType,existing:reuse,scene,opener:item});
        })});
      const reuseButton=node('button',root,'Reuse existing source');reuseButton.type='button';reuseButton.className='btn';
      reuseButton.onclick=()=>run(reuseButton,()=>{reuse=!reuse;refresh();root.querySelector('[data-source-reuse]')?.focus({preventScroll:true});});
      reuseButton.setAttribute('data-source-reuse','');reuseButton.setAttribute('aria-pressed',String(reuse));reuseButton.classList.toggle('on',reuse);reuseButton.disabled=!active;window.OpenLiveSourceIcons?.prepend(reuseButton,'plus');
      message=node('p',root,active?'':'Choose an editable Preview scene to add sources.');message.className='bc-source-status';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    }
    refresh();
    return {refresh,destroy(){destroyed=true;generation++;root.replaceChildren();}};
  }
  return Object.freeze({types,catalog,categories,nativeCandidates,enabled,uniqueName,validateName,session,mount,mountLauncher});
})();
