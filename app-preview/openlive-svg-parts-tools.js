/* Parts-first native SVG library. Browsing never changes a scene; Studio owns
 * every persisted transaction, asset preparation, undo/redo and source binding. */
window.OpenLiveSvgPartsTools = (() => {
  'use strict';
  const mounts = new WeakMap(), clone = value => JSON.parse(JSON.stringify(value));
  let inspectorSequence=0;
  const transforms=['visible','x','y','scale','scaleX','scaleY','rotation','flipX','flipY','opacity'];
  const textFields=['text','textColor','fontSize','fontFamily','fontWeight','fontStyle','textAlign','overflow','overflowSpeed'];
  const fonts=window.OpenLiveFullTemplates && Array.isArray(window.OpenLiveFullTemplates.textFonts)
    ? window.OpenLiveFullTemplates.textFonts.slice() : ['Arial','Verdana','Georgia','Times New Roman','Courier New','League Spartan'];
  const fits=[['contain','Fit · whole image'],['cover','Fill · crop edges'],['stretch','Stretch · change proportions']];
  // Match applyPartPose: scale around native bounds, rotate in pixel space,
  // then translate in artboard-relative coordinates (not square coordinates).
  function alignmentStyle(template,component,style,align) {
    const b=component?.bounds,W=template?.width,H=template?.height;
    if(!b||![W,H,b.x,b.y,b.w,b.h].every(Number.isFinite)||W<=0||H<=0||b.w<=0||b.h<=0)throw Error('This layer has no valid page bounds.');
    const next=clone(style||{}),p=next.components?.[component.id]||{},s=p.scale??1;
    const angle=(p.rotation||0)*Math.PI/180,c=Math.abs(Math.cos(angle)),n=Math.abs(Math.sin(angle));
    const w=b.w*W*s*(p.scaleX??1)/2,h=b.h*H*s*(p.scaleY??1)/2;
    const rx=(c*w+n*h)/W,ry=(n*w+c*h)/H;
    if(['left','center','right'].includes(align))p.x=({left:rx,center:.5,right:1-rx})[align]-(b.x+b.w/2);
    else if(['top','middle','bottom'].includes(align))p.y=({top:ry,middle:.5,bottom:1-ry})[align]-(b.y+b.h/2);
    else throw Error('Choose a valid page alignment.');
    next.components={...(next.components||{}),[component.id]:p};return next;
  }
  const imageEligible=component=>!component.virtual&&!Number.isInteger(component.frameIndex)&&!component.editableText&&!component.editableQr;
  const categories = [
    ['all','All',()=>true], ['backgrounds','Backgrounds',p=>p.type==='background'],
    ['feeds','Feeds',p=>Number.isInteger(p.frameIndex)], ['lower-thirds','Lower thirds',p=>p.type==='lower-third'],
    ['logos','Logos',p=>p.type==='logo'], ['headlines','Headlines',p=>p.type==='headline'||p.id==='headline'],
    ['live-badges','LIVE badges',p=>p.type==='badge'||p.type==='live-badge'||p.id==='live-badge'],
    ['qr','QR',p=>p.type==='qr'||p.editableQr===true], ['text','Text',p=>p.editableText===true]
  ];
  function mount(options = {}) {
    const doc = options.document || document, studio = options.studio || window.OpenLiveStudio;
    const templates = options.templates || window.OpenLiveFullTemplates;
    const target = typeof options.target === 'string' ? doc.querySelector(options.target) : options.target;
    if (!target) throw new Error('Choose a target for the SVG parts library.');
    if (mounts.has(target)) return mounts.get(target);
    if (!studio || !templates || typeof templates.list !== 'function') throw new Error('The native SVG parts library is unavailable.');
    const catalog = templates.list(), parts = catalog.flatMap(template => (template.components || []).map(component => ({template,component})));
    const disposers = {static:[],grid:[],layers:[],editor:[],removal:[],folders:[],menu:[]}, drafts = new Map(), draftEpochs = new Map(), controls = new Map(), layerVisibilityControls = new Set();
    const libraryVisibilityControls = new Set(), layerDeleteControls = new Set(), templatePreviews = new Map(), sectionStates = new Map(), editorEditingControls = new Set();
    const inspectorId='svg-inspector-'+(++inspectorSequence);
    let destroyed = false, serial = 0, busy = false, category = 'all', page = '', selected = null, draft = null;
    let editorSceneId = null, lastSceneId = null, layerBaseline = '', publishedPreviewState = null, readyPreviewStamp = '';
    let previewFrame = null, lastPaintedKey = '', lastCompositeSignature = '';
    let search='', uploadTarget=null, layerRender=0, removalChoice=null;
    let layerMenu=null, inspectorTarget=null, inspectorSelection=false, layerListDirty=false, editorEpoch=0;
    const autoPending=new Map(),autoErrors=new Map();let autoTail=null;
    const images=options.images||window.OpenLiveSvgImages, managedFolders=typeof images?.listLibrary==='function';
    let library={folders:[],assets:[]}, libraryBusy=false, libraryRequest=0, gridGeneration=0, thumbnailTail=Promise.resolve();
    const uploadFolder=()=>library.folders.find(folder=>folder.id===page)||library.folders.find(folder=>folder.id==='uploads');
    const dragType='application/x-showave-template-piece';
    const node = (tag,className,text) => { const item = doc.createElement(tag); if(className)item.className=className;if(text!==undefined)item.textContent=text;return item; };
    const append = (parent,...items) => items.forEach(item=>parent.appendChild(item));
    const on = (item,type,callback,scope='static') => {item.addEventListener(type,callback);disposers[scope].push(()=>item.removeEventListener(type,callback));};
    const clear = scope => {disposers[scope].splice(0).forEach(dispose=>dispose());};
    const scene = () => typeof options.controlScene==='function' ? options.controlScene() : null;
    const label = () => typeof options.targetLabel==='function' ? String(options.targetLabel()) : 'Editing scene';
    const sceneStamp = value => value ? JSON.stringify({id:value.id,layout:value.layout,fullTemplateId:value.fullTemplateId,
      fullTemplateStyle:value.fullTemplateStyle,fullTemplateExtras:value.fullTemplateExtras,svgParts:value.svgParts,
      svgPartsMode:value.svgPartsMode,svgPartsExtras:value.svgPartsExtras,slots:value.slots,freeOrder:value.freeOrder}) : '';
    const selectedKey = () => selected ? editorSceneId+'|'+selected.mode+'|'+(selected.asset?.id || selected.layerId || selected.template.id+'/'+selected.component.id) : '';
    function rememberDraft(){if(!draft||!selected)return;const key=selectedKey();drafts.set(key,clone(draft));draftEpochs.set(key,editorEpoch);}
    const templateKey = (part,sceneId=scene()?.id) => sceneId+'|part|'+part.template.id+'/'+part.component.id;
    const previewKey = () => selected?.mode==='part' ? editorSceneId+'|templates' : selectedKey();
    const previewEntries = () => parts.map(part=>templatePreviews.get(templateKey(part,editorSceneId))).filter(entry=>entry?.visible)
      // Backgrounds must stay behind lettering/badges, regardless of click order.
      .sort((a,b)=>Number(b.part.component.type==='background')-Number(a.part.component.type==='background'));
    function templateEntry(part,sceneId=scene()?.id) {
      const key=templateKey(part,sceneId);
      if(!templatePreviews.has(key))templatePreviews.set(key,{key,part,visible:false,style:{},asset:null,lastGood:null});
      return templatePreviews.get(key);
    }
    const selectionExists = () => selected && selected.mode==='layer' ? (scene()?.svgParts || []).some(part=>part.id===selected.layerId) : !!selected;
    const inspectionEditAllowed = () => {try{return typeof options.canInspectEdit!=='function'||options.canInspectEdit()===true;}catch(_){return false;}};
    const inspectionEditingBlocked = () => !!inspectorTarget&&inspectorSelection&&!inspectionEditAllowed();
    const editorReadOnly = () => inspectionEditingBlocked() || selected?.mode==='layer' && (editorSceneId!==scene()?.id || !scene()?.id || !studio.scenes().includes(scene()) || scene()?.layoutPending || !currentLayer() || !!currentLayer().locked);
    function say(message,error=false) {if(destroyed)return;status.textContent=message;status.classList.toggle('error',error);}
    function publishPreview(state,message='',canvas=null) {
      publishedPreviewState=state;
      if(state==='ready')readyPreviewStamp=formStamp();
      // A monitor receives only a completed preview canvas, never a staged
      // scene or a compositor target. Browsing cannot reach Programme.
      const entries=selected?.mode==='part'?previewEntries():null;
      try{options.onPreviewChange?.(state&&selected?{state,message,canvas,
        sceneId:editorSceneId,mode:selected.mode,label:entries ? (entries.length===1?entries[0].part.component.label:entries.length+' template pieces') : selected.asset?.name || selected.component.label,
        templateId:selected.template.id,componentId:selected.component.id,
        surface:(entries?.find(entry=>entry.part.component.thumbnailSurface==='dark')?.part.component.thumbnailSurface)||selected.component.thumbnailSurface||'light',
        keepFrame:!!lastPaintedKey&&lastPaintedKey===previewKey()}:null);}catch(_){/* A monitor must not break the editor. */}
    }
    function clearPreviewFrame() {
      if(previewFrame!==null){window.cancelAnimationFrame?.(previewFrame);previewFrame=null;}
    }
    function cancel({quiet=false}={}) {
      closeLayerMenu();closeRemovalChoices();clearPreviewFrame();serial++;busy=false;updateActions();
      if(!quiet&&['loading','updating'].includes(publishedPreviewState))publishPreview('stale','Preview cancelled. Select a piece or refresh its preview.');
    }
    function queuePreview() {
      if(destroyed||!selected||inspectorSelection||previewFrame!==null)return;
      if(typeof window.requestAnimationFrame!=='function'){void previewSelected(true);return;}
      previewFrame=window.requestAnimationFrame(()=>{previewFrame=null;if(!destroyed)void previewSelected(true);});
    }
    function autoSaveLayer(){
      if(!options.autoSaveLayers||destroyed||selected?.mode!=='layer'||editorSceneId!==scene()?.id||editorReadOnly())return;
      const key=editorSceneId+'|'+selected.layerId;
      try{
        const owner=scene(),part=currentLayer();if(!part)return;
        if(JSON.stringify(part)!==layerBaseline&&!autoPending.has(key))throw new Error('This layer changed outside the editor. Reload the saved layer before editing.');
        const value=readForm(),patch={style:value.style,...(value.sourceSlot===undefined?{}:{sourceSlot:value.sourceSlot})};
        if(JSON.stringify(part.style||{})===JSON.stringify(patch.style)&&part.sourceSlot===value.sourceSlot&&!autoPending.has(key)){draft.cleanForm=formStamp();autoErrors.delete(key);reportAutoSave();return;}
        autoPending.set(key,{owner,id:part.id,patch,form:formStamp(),epoch:editorEpoch,inspection:!!inspectorTarget&&inspectorSelection});autoErrors.delete(key);
        if(!autoTail)autoTail=Promise.resolve().then(drainAutoSave);
        reportAutoSave();
      }catch(error){autoErrors.set(key,error);say('Not saved: '+(error.message||String(error)),true);reportAutoSave();}
    }
    function reportAutoSave(){
      for(const key of autoErrors.keys())if(!studio.scenes().some(owner=>(owner.svgParts||[]).some(part=>key===owner.id+'|'+part.id)))autoErrors.delete(key);
      updateActions();
      options.onAutoSaveState?.({saving:!!autoTail||autoPending.size>0,error:autoErrors.values().next().value?.message||''});
    }
    async function drainAutoSave(){
      try{
        while(autoPending.size&&!destroyed){
          const [key,entry]=autoPending.entries().next().value;
          const isCurrent=()=>!destroyed&&autoPending.get(key)===entry&&studio.scenes().includes(entry.owner)&&entry.owner.svgParts?.some(part=>part.id===entry.id)&&(!entry.inspection||inspectionEditAllowed());
          try{
            const saved=await studio.updateSceneSvgPart(entry.owner.id,entry.id,entry.patch,{isCurrent});
            if(!saved)throw new Error('Scene changes could not be saved.');
            if(autoPending.get(key)===entry)autoPending.delete(key);
            const savedBaseline=JSON.stringify(saved),cacheKey=entry.owner.id+'|layer|'+entry.id,cached=drafts.get(cacheKey);
            // A deselected draft still owns its typed fields. Advance only the
            // cache from this captured editor, rather than treating our save as
            // an unrelated external edit when the operator reselects the layer.
            if(cached&&draftEpochs.get(cacheKey)===entry.epoch){cached.baseline=savedBaseline;cached.cleanForm=entry.form;}
            if(selected?.mode==='layer'&&editorSceneId===entry.owner.id&&selected.layerId===entry.id){
              const sameEditor=editorEpoch===entry.epoch,visibleForm=formStamp();
              if(sameEditor||visibleForm===entry.form){
                layerBaseline=savedBaseline;draft.baseline=layerBaseline;draft.cleanForm=entry.form;rememberDraft();
              }else if(visibleForm===draft.cleanForm){
                // The new inspector shows an intermediate saved version and
                // has no new typing. Let canonical reconciliation refresh it;
                // do not stamp the old editor's form as this form's clean state.
                if(inspectorSelection)reconcileInspectorLayer();
                else if(!autoPending.has(key))choose(selected,'layer',saved,true);
              }else{
                // New edits in the reselected inspector must retain their DOM
                // and caret while the previously captured save completes.
                layerBaseline=savedBaseline;draft.baseline=layerBaseline;rememberDraft();
              }
              renderLayers();say('Scene changes kept for this session. Programme is unchanged.');
            }
            notify(saved,'auto-save',entry.owner.id);
          }catch(error){
            if(autoPending.get(key)!==entry)continue;
            autoPending.delete(key);autoErrors.set(key,error);
            if(!studio.scenes().includes(entry.owner)||!entry.owner.svgParts?.some(part=>part.id===entry.id)){autoErrors.delete(key);continue;}
            say('Not saved: '+(error.message||String(error))+'. Retry save before leaving.',true);
          }
        }
      }finally{autoTail=null;reportAutoSave();}
    }
    async function flushAutoSave(){
      if(options.autoSaveLayers&&selected?.mode==='layer'&&editorSceneId===scene()?.id&&!editorReadOnly()){readForm();autoSaveLayer();}
      if(autoTail)await autoTail;
      for(const [key,error] of autoErrors)if(key.startsWith(scene()?.id+'|'))throw error;
    }
    function sourceLabel(slot,index) {return 'Slot '+(index+1)+(slot.sourceId?' · '+slot.sourceId:' · empty');}
    function currentLayer() {return selected?.mode==='layer' ? (scene()?.svgParts || []).find(part=>part.id===selected.layerId) : null;}
    function formStamp() {return JSON.stringify([...controls].map(([name,field])=>[name,field.input.type==='checkbox'?field.input.checked:field.input.value]));}
    function stash() {
      if(!draft||!selected)return;
      draft.raw={};for(const [name,field] of controls)draft.raw[name]=field.input.type==='checkbox'?field.input.checked:field.input.value;
      rememberDraft();
      if(selected.mode==='part'){
        const entry=templateEntry(selected,editorSceneId);entry.visible=!!controls.get('visible')?.input.checked;
        try{const value=readForm();entry.style=value.style;entry.sourceSlot=value.sourceSlot;entry.formError=null;}
        catch(error){entry.formError=error.message;/* Keep the last valid preview, never save invalid fields. */}
      }
    }
    function requireCurrentScene() {
      const value=scene();if(!value?.id)throw new Error('Choose an editing scene first.');
      if(value.layoutPending)throw new Error('Choose this scene’s layout before adding sources or artwork.');
      if(selected&&value.id!==editorSceneId)throw new Error('The editing scene changed. Select a part or layer for this scene before applying.');
      return value;
    }
    function readForm() {
      if(!selected||!draft)throw new Error('Preview a native SVG piece first.');
      const style=clone(draft.style||{}), change=clone(style.components?.[selected.component.id]||{});
      const get=name=>controls.get(name)?.input;
      const number=(name,min,max,multiplier=1)=>{
        const input=get(name),text=String(input.value).trim(),value=Number(text);
        if(!text||!Number.isFinite(value)||value<min||value>max)throw new Error(input.getAttribute('aria-label')+' must be between '+min+' and '+max+'.');
        return value/multiplier;
      };
      const choice=(name,allowed)=>{const value=get(name).value;if(!allowed.includes(value))throw new Error('Choose a valid '+get(name).getAttribute('aria-label')+'.');return value;};
      change.visible=!!get('visible').checked;
      change.x=number('x',-200,200,100);change.y=number('y',-200,200,100);
      change.scale=number('scale',10,400,100);change.opacity=number('opacity',0,100,100);
      change.scaleX=number('scaleX',10,400,100);change.scaleY=number('scaleY',10,400,100);
      change.rotation=number('rotation',-180,180);change.flipX=!!get('flipX').checked;change.flipY=!!get('flipY').checked;
      for(const entry of selected.template.palette||[]) {
        const input=get('palette:'+entry.key);if(!input)continue;const colour=input.value;
        if(!/^#[\da-f]{6}$/i.test(colour))throw new Error(entry.label+' must be a six-digit hexadecimal colour.');
        style[entry.key]=colour;
      }
      if(get('backgroundHue'))style.backgroundHue=number('backgroundHue',-180,180);
      if(selected.component.editableText) {
        const touched=name=>draft.touched?.includes(name)||get(name).value!==controls.get(name).initial;
        if(textFields.some(name=>change[name]!==undefined||touched(name))) {
          if(typeof selected.component.defaultText!=='string'&&change.text===undefined&&!touched('text')&&!get('text').value)
            throw new Error('Enter replacement text before changing its font, colour, size or alignment.');
          change.text=get('text').value;
          if(change.text.length>500)throw new Error('Replacement text must contain at most 500 characters.');
          if(change.textColor!==undefined||touched('textColor'))change.textColor=get('textColor').value;
          if(change.fontSize!==undefined||touched('fontSize'))change.fontSize=number('fontSize',4,120);
          if(change.overflowSpeed!==undefined||touched('overflowSpeed'))change.overflowSpeed=number('overflowSpeed',1,600);
          for(const [name,allowed] of [['fontFamily',fonts],['fontWeight',['400','700']],['fontStyle',['normal','italic']],['textAlign',['left','center','right']],['overflow',['scroll','clip']]])
            if(change[name]!==undefined||touched(name))change[name]=choice(name,allowed);
        }
      }
      if(selected.component.editableQr) {
        const value=get('target').value, field=controls.get('target');
        if(change.target!==undefined||draft.touched?.includes('target')||value!==field.initial)change.target=value;
      }
      if(Number.isInteger(selected.component.frameIndex))change.feedFit=choice('feedFit',['contain','cover','stretch']);
      if(imageEligible(selected.component)&&change.imageId)change.imageFit=choice('imageFit',['contain','cover','stretch']);
      style.components={[selected.component.id]:change};
      if(typeof templates.normalizePartStyle!=='function')throw new Error('The independent SVG part renderer is unavailable.');
      const canonical=templates.normalizePartStyle(selected.template.id,selected.component.id,style);
      const input=get('sourceSlot'), sourceSlot=input&&input.value!==''?Number(input.value):undefined;
      if(input&&input.value!==''&&(!Number.isInteger(sourceSlot)||sourceSlot<0||sourceSlot>31))throw new Error('Choose a valid existing source slot.');
      return {style:clone(canonical),...(sourceSlot!==undefined?{sourceSlot}:{})};
    }
    function updateActions() {
      if(destroyed)return;
      const value=scene(), hasScene=!!value?.id&&!value.layoutPending, same=selected&&editorSceneId===value?.id, isLayer=selected?.mode==='layer';
      addButton.hidden=!!isLayer;applyButton.hidden=!isLayer;
      if(options.autoSaveLayers){applyButton.textContent='Retry scene save';applyButton.hidden=!isLayer||!autoErrors.has(value?.id+'|'+selected?.layerId);}
      addButton.disabled=busy||!same||!hasScene;applyButton.disabled=busy||!same||!selectionExists();
      previewButton.disabled=busy||!selected;previewButton.hidden=inspectorSelection;
      removeButton.hidden=backButton.hidden=forwardButton.hidden=reloadButton.hidden=!isLayer;
      layerSettings.hidden=!isLayer;
      const index=isLayer?(value?.svgParts||[]).findIndex(part=>part.id===selected.layerId):-1;
      const locked=index>=0&&!!value.svgParts[index].locked;
      const readOnly=editorReadOnly();
      for(const control of editorEditingControls)control.disabled=busy||readOnly;
      for(const control of controls.values())if(control.slider)control.slider.disabled=busy||readOnly||control.input.getAttribute('aria-invalid')==='true';
      editor.setAttribute('aria-readonly',String(!!readOnly));lockNote.hidden=!locked&&!inspectionEditingBlocked();
      lockNote.textContent=locked?'Locked layer · unlock it in Sources to edit.':'Inspection only · use Scene preview in Studio mode to edit.';
      if(isLayer)identityMode.textContent=locked?'Locked · Scene copy':'Scene copy';
      applyButton.disabled=applyButton.disabled||readOnly;
      removeButton.disabled=busy||!same||index<0||readOnly;reloadButton.disabled=busy||!same||index<0;
      clipDelete.hidden=!isLayer;clipDelete.disabled=busy||!same||index<0||readOnly;
      clipDelete.title=locked?'Unlock this artwork layer before removing it.':'Delete this saved clip from the editing scene. Undo restores it; original templates stay unchanged.';
      backButton.disabled=busy||!same||index<=0||readOnly;forwardButton.disabled=busy||!same||index<0||index>=(value?.svgParts||[]).length-1||readOnly;
      for(const control of layerVisibilityControls)control.disabled=busy||!hasScene;
      for(const control of layerDeleteControls)control.disabled=busy||!hasScene||!!value.svgParts?.find(part=>part.id===control.getAttribute('data-layer-id'))?.locked;
      splitButton.hidden=!value?.fullTemplateId;splitButton.disabled=busy||typeof studio.splitSceneTemplate!=='function';
      let history={};try{history=typeof studio.svgPartsHistory==='function'?studio.svgPartsHistory(value?.id)||{}:{ };}catch(_){}
      undoButton.disabled=busy||!hasScene||!history.canUndo||inspectionEditingBlocked();redoButton.disabled=busy||!hasScene||!history.canRedo||inspectionEditingBlocked();
      undoButton.title=history.undoLabel||'Undo the last saved SVG-layer change';redoButton.title=history.redoLabel||'Redo the saved SVG-layer change';
      syncLibraryVisibility();
      const mixed=previewEntries().length;
      mixCount.textContent=mixed+' shown';addMixButton.disabled=busy||!hasScene||!mixed;
      uploadButton.disabled=managedFolders?libraryBusy||!uploadFolder():busy||!hasScene;
      const availableTools=sceneToolEntries();
      const embeddedSources=availableTools.length>0&&typeof options.openSources==='function';
      for(const control of sourceControls){
        control.disabled=busy||openingSources||!hasScene;
        control.hidden=typeof options.openSources!=='function'||embeddedSources&&['image','text'].includes(control.getAttribute('data-source-shortcut-type'));
      }
      for(const control of templateSourceControls){
        control.hidden=!embeddedSources;control.disabled=busy||openingSources||!hasScene||!embeddedSources;
      }
      sceneSourceShelf.hidden=!availableTools.length;
      for(const control of sceneToolControls)control.disabled=busy||openingSources||!hasScene||!availableTools.some(tool=>tool.id===control.getAttribute('data-scene-tool'));
      sourceHint.textContent=hasScene?availableTools.length?'Add or customize '+(value.name||'this scene')+' · Preview only; Cut/Fade publishes.':'Add to '+(value.name||'this scene')+' · independent source layers; artwork is kept.':'Choose a scene and layout to add sources.';
      if(managedFolders){uploadButton.title='Upload PNG, JPEG or WebP to '+(uploadFolder()?.name||'Uploads')+'. This does not add to a scene.';newFolderButton.disabled=libraryBusy;createFolderButton.disabled=libraryBusy;}
      dropZone.setAttribute('aria-disabled',String(busy||!hasScene));
      dropZone.textContent=value?.layoutPending?'Choose this scene’s layout before adding artwork.':'Drop pieces or an image to add · '+label();
    }
    const root=node('section','svg-parts-tools production-section');
    const heading=node('h3','',managedFolders?'Assets':'Template library'), targetNote=node('p','production-note'), intro=node('p','production-note svg-parts-intro');
    const tabs=node('div','svg-parts-tabs');tabs.setAttribute('aria-label','SVG part categories');
    const filters=node('div','svg-parts-filters'), pageSelect=node('select');pageSelect.setAttribute('aria-label',managedFolders?'Filter assets by folder':'Filter SVG parts by original page');
    const allPages=node('option','','All '+catalog.length+' original pages');allPages.value='';pageSelect.appendChild(allPages);
    for(const template of catalog){const option=node('option','',template.name);option.value=template.id;pageSelect.appendChild(option);}
    pageSelect.value='';const count=node('span','production-note');append(filters,pageSelect,count);
    const grid=node('div','svg-parts-grid');grid.setAttribute('aria-label',managedFolders?'Assets in selected folder':'Independent native SVG pieces');
    const editor=node('section','svg-parts-editor'), editorTitle=node('h4','','Clip inspector'), editorNote=node('span','svg-parts-clip-origin'), editorWarnings=node('div','svg-parts-warnings');
    editor.setAttribute('aria-label','SVG clip inspector');
    const editorBody=node('div','svg-parts-editor-body pbody'), editingNotes=node('details','svg-parts-help');
    const identity=node('div','svg-parts-clip-card'), identityImage=node('img','svg-parts-clip-thumb'),identityCopy=node('div','svg-parts-clip-copy');
    const identityName=node('strong','svg-parts-clip-name'),identityKind=node('span','svg-parts-clip-kind'),identityMode=node('span','svg-parts-clip-mode');
    identityImage.alt='';identity.hidden=true;
    append(identityCopy,identityName,editorNote,identityKind);append(identity,identityImage,identityCopy,identityMode);
    const clipDelete=node('button','svg-parts-icon-button svg-parts-delete svg-parts-clip-delete');clipDelete.type='button';clipDelete.hidden=true;
    clipDelete.setAttribute('aria-label','Delete selected scene clip');clipDelete.title='Delete this saved clip from the editing scene. Undo restores it; original templates stay unchanged.';
    const clipTrash=node('span','svg-parts-trash-icon');clipTrash.setAttribute('aria-hidden','true');clipDelete.appendChild(clipTrash);identity.appendChild(clipDelete);
    on(clipDelete,'click',()=>{if(selected?.mode==='layer'&&editorSceneId===scene()?.id)return removeSceneLayer(selected.layerId);});
    const emptyPreview=node('div','svg-parts-placeholder');
    append(emptyPreview,node('strong','','Choose a template'),node('p','','Preview and customize a template, then Add a copy to your scene. The original template stays unchanged.'));
    editingNotes.hidden=true;
    editingNotes.appendChild(node('summary','','Editing notes'));
    const cropped=node('img','svg-parts-selected-image');cropped.hidden=true;cropped.alt='';
    const preview=node('canvas','svg-parts-board');preview.width=640;preview.height=360;preview.hidden=true;preview.setAttribute('aria-label','Selected SVG piece on its original board');
    // Broadcast supplies the master monitor as the render target. The small
    // inspector preview is a same-frame copy, not the source of the master.
    const previewCanvas=options.previewCanvas||preview;
    const previewNote=node('p','production-note svg-parts-preview-state');
    const previewGroup=node('details','svg-parts-section svg-parts-preview-group');previewGroup.hidden=true;
    // The master monitor is already visible in Broadcast. Keep the duplicate
    // monitor available on demand and give the inspector's space to editing.
    previewGroup.open=!options.previewCanvas;
    append(previewGroup,node('summary','','Preview monitor'),cropped,preview,previewNote);
    const originalLink=node('a','','Open original piece SVG');originalLink.target='_blank';originalLink.rel='noopener';originalLink.hidden=true;
    const fields=node('div','svg-parts-fields'), actions=node('div','svg-parts-actions');
    let fieldTarget=fields,imageSummary=null;
    const button=(text,callback)=>{const item=node('button','production-button',text);item.type='button';on(item,'click',callback);return item;};
    function sceneToolEntries() {
      const entries=typeof options.sceneTools==='function'?options.sceneTools():options.sceneTools,ids=new Set();
      return (Array.isArray(entries)?entries:[]).filter(tool=>tool&&typeof tool.id==='string'&&tool.id&&typeof tool.label==='string'&&tool.label.trim()&&!ids.has(tool.id)&&
        (typeof tool.open==='function'||typeof options.onOpenSceneTool==='function')&&(ids.add(tool.id),true));
    }
    const sourceToolbar=node('div','svg-parts-source-toolbar');sourceToolbar.hidden=typeof options.openSources!=='function'&&!sceneToolEntries().length;
    sourceToolbar.setAttribute('role','group');sourceToolbar.setAttribute('aria-label','Add scene sources from Assets');
    const sourceControls=[],sceneToolControls=[],templateSourceControls=[];let openingSources=false;
    async function openSources(settings={},embedded=false) {
      const opener=doc.activeElement,owner=scene();if(destroyed||busy||openingSources||!owner?.id||owner.layoutPending||typeof options.openSources!=='function')return;
      const request=serial;
      openingSources=true;updateActions();
      try{
        stash();await flushAutoSave();
        if(destroyed)return;
        if(request!==serial||scene()!==owner||!studio.scenes().includes(owner)||owner.layoutPending)throw Error('The editing scene changed. Open Add source again.');
        if(embedded&&!sceneToolEntries().length)throw Error('This template source is unavailable.');
        closeLayerMenu();
        if(await options.openSources({...settings,scene:owner,independent:true,opener})===false)throw Error('Add Source is unavailable for this scene.');
      }catch(error){if(!destroyed)say(error.message||String(error),true);}
      finally{openingSources=false;if(!destroyed)updateActions();}
    }
    for(const [title,icon,settings] of [
      ['Add source','plus',{}],['Add existing source','scene',{existing:true}],
      ['Video Capture Device','camera',{type:'camera'}],['Display Capture','screen',{type:'screen'}],
      ['Image','image',{type:'image'}],['Media','media',{type:'media'}],
      ['Text','text',{type:'text'}],['Audio Input Capture','audio-input',{type:'audio-input'}]
    ]){
      const control=button(title,()=>openSources(settings));control.className='btn svg-parts-source-button';
      control.setAttribute('aria-label',title);control.title=title;control.setAttribute('aria-haspopup','dialog');
      if(settings.type)control.setAttribute('data-source-shortcut-type',settings.type);
      if(window.OpenLiveSourceIcons){
        if(settings.type)control.textContent='';
        window.OpenLiveSourceIcons.prepend(control,icon);
      }
      sourceControls.push(control);sourceToolbar.appendChild(control);
      control.hidden=typeof options.openSources!=='function';
    }
    const sceneSourceShelf=node('section','svg-parts-scene-sources');sceneSourceShelf.hidden=!sceneToolEntries().length;
    sceneSourceShelf.setAttribute('role','group');sceneSourceShelf.setAttribute('aria-label','Template sources');
    const sceneSourceHeading=node('h4','','Template sources'),sceneSourceChoices=node('div','svg-parts-scene-source-choices');
    append(sceneSourceShelf,sceneSourceHeading,sceneSourceChoices);sourceToolbar.appendChild(sceneSourceShelf);
    for(const [type,title] of [['color','Color'],['image','Image'],['slideshow','Image Slide Show'],['text','Text']]){
      const control=button(title,()=>openSources({type},true));control.className='btn svg-parts-source-button';
      control.setAttribute('aria-label',title);control.setAttribute('data-template-source-type',type);control.setAttribute('aria-haspopup','dialog');
      window.OpenLiveSourceIcons?.prepend(control,type);templateSourceControls.push(control);sceneSourceChoices.appendChild(control);
    }
    async function openSceneTool(id,opener) {
      const owner=scene();if(destroyed||busy||openingSources||!owner?.id||owner.layoutPending)return;
      const request=serial;
      openingSources=true;updateActions();
      try{
        stash();await flushAutoSave();
        if(destroyed)return;
        if(request!==serial||scene()!==owner||!studio.scenes().includes(owner)||owner.layoutPending)
          throw Error('The editing scene changed. Open this template source again.');
        const tool=sceneToolEntries().find(entry=>entry.id===id);
        if(!tool)throw Error('This template source is unavailable.');
        closeLayerMenu();
        const context={scene:owner,opener},result=await (typeof tool.open==='function'?tool.open(context):options.onOpenSceneTool(tool,context));
        if(result===false)throw Error('This template source editor is unavailable.');
      }catch(error){if(!destroyed)say(error.message||String(error),true);}
      finally{openingSources=false;if(!destroyed)updateActions();}
    }
    for(const tool of sceneToolEntries()){
      const control=button(tool.label,()=>openSceneTool(tool.id,control));control.className='btn svg-parts-source-button';
      control.setAttribute('aria-label',tool.label);control.setAttribute('data-scene-tool',tool.id);control.setAttribute('aria-haspopup','dialog');
      if(tool.help){control.title=tool.help;control.setAttribute('aria-description',tool.help);}
      window.OpenLiveSourceIcons?.prepend(control,tool.icon||'artwork');
      sceneToolControls.push(control);sceneSourceChoices.appendChild(control);
    }
    const sourceHint=node('span','production-note svg-parts-source-hint');sourceToolbar.appendChild(sourceHint);
    const previewButton=button('Preview staged piece',()=>previewSelected());
    const addButton=button('Add copy to scene',()=>saveSelected(false));
    addButton.title='Create an independent scene copy using this preview. The reusable template stays unchanged.';
    const applyButton=button('Apply staged layer edits',()=>saveSelected(true));
    const reloadButton=button('Reload saved layer',()=>{if(selected?.mode==='layer')(inspectorSelection?inspectLayer:selectLayer)(selected.layerId,true);});
    const removeButton=button('Remove selected layer',()=>changeStack('remove'));
    const backButton=button('Move layer backward',()=>changeStack('back'));
    const forwardButton=button('Move layer forward',()=>changeStack('forward'));
    const layerSettings=node('details','svg-parts-section svg-parts-layer-settings'),layerSettingsBody=node('div','svg-parts-layer-settings-body');
    layerSettings.hidden=true;
    append(layerSettingsBody,node('p','production-note',options.autoSaveLayers?'Scene copy · valid property edits are kept for this session. Programme changes only with Cut/Fade.':'Saved scene copy · ordering and removal save immediately; other property edits require Apply.'),reloadButton,backButton,forwardButton,removeButton);
    append(layerSettings,node('summary','','Layer settings'),layerSettingsBody);
    const editHint=node('p','production-note svg-parts-edit-hint','Edits preview live. Add or Apply saves only the selected piece.');editHint.hidden=true;
    const lockNote=node('p','production-note svg-parts-lock-note','Locked layer · unlock it in Sources to edit.');lockNote.hidden=true;
    append(actions,previewButton,addButton,applyButton);
    append(editorBody,emptyPreview,identity,lockNote,previewGroup,fields,layerSettings,editorWarnings,editingNotes);
    append(editor,editorTitle,editorBody,editHint,actions);
    const layersHeading=node('h4','','Scene layers · bottom → top'), layerNote=node('p','production-note'), layers=node('div','svg-parts-layers');
    layers.setAttribute('aria-label','Scene SVG layer stack in bottom to top order');
    const stackActions=node('div','svg-parts-actions');
    const splitButton=button('Break current template into layers',()=>historyAction('split'));
    const undoButton=button('Undo layer change',()=>historyAction('undo')),redoButton=button('Redo layer change',()=>historyAction('redo'));
    append(stackActions,splitButton,undoButton,redoButton);
    const status=node('p','production-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const libraryBody=node('div','svg-parts-browser');
    const assetToolbar=node('div','svg-parts-asset-toolbar');
    const folderToggle=button('Folders',()=>{if(folders.hidden)openFolders();else{folders.hidden=true;folderToggle.setAttribute('aria-expanded','false');}});
    folderToggle.classList.toggle('svg-parts-folder-toggle',true);folderToggle.setAttribute('aria-label','Browse template folders');folderToggle.setAttribute('aria-expanded','false');
    const uploadButton=button(managedFolders?'Upload to folder':'Upload & add',()=>{uploadTarget=managedFolders?uploadFolder():{value:scene(),stamp:sceneStamp(scene())};uploadInput.click();});
    uploadButton.title='Choose one PNG, JPEG or WebP image and add it as a new scene layer.';
    const uploadInput=node('input');uploadInput.type='file';uploadInput.accept='.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';uploadInput.hidden=true;
    uploadInput.multiple=managedFolders;uploadInput.setAttribute('aria-label',managedFolders?'Upload images to selected folder':'Upload image as a new scene layer');
    const searchInput=node('input','svg-parts-search');searchInput.type='search';searchInput.placeholder='Search elements';searchInput.setAttribute('aria-label','Search template assets');
    const folders=node('div','svg-parts-folders');folders.hidden=true;folders.setAttribute('aria-label','Template asset folders');
    const revealFoldersForDrag=event=>{
      if(!managedFolders||!Array.from(event.dataTransfer?.types||[]).some(type=>type===dragType||type==='Files'))return;
      event.preventDefault();folders.hidden=false;folderToggle.setAttribute('aria-expanded','true');
      // Do not refresh the grid here: replacing the dragged row cancels native drag-and-drop.
    };
    on(folderToggle,'dragenter',revealFoldersForDrag);on(folderToggle,'dragover',revealFoldersForDrag);
    const newFolderButton=button('+ Folder',()=>{folderForm.hidden=false;folders.hidden=true;folderToggle.setAttribute('aria-expanded','false');folderName.focus?.();});newFolderButton.hidden=!managedFolders;newFolderButton.setAttribute('aria-label','Create asset folder');
    const folderForm=node('div','svg-parts-folder-form');folderForm.hidden=true;
    const folderName=node('input');folderName.type='text';folderName.maxLength=60;folderName.placeholder='Folder name';folderName.setAttribute('aria-label','New folder name');
    const createFolderButton=button('Create folder',createAssetFolder),cancelFolderButton=button('Cancel folder',()=>{folderForm.hidden=true;newFolderButton.focus?.();});
    append(folderForm,folderName,createFolderButton,cancelFolderButton);
    on(folderName,'keydown',event=>{if(event.key==='Enter'){event.preventDefault();void createAssetFolder();}else if(event.key==='Escape'){event.preventDefault();folderForm.hidden=true;}});
    const folderContext=node('div','svg-parts-folder-context');folderContext.hidden=!managedFolders;
    folderContext.setAttribute('role','region');folderContext.setAttribute('aria-label','Upload to selected folder');
    const allFolder=button('',()=>openFolder(''));allFolder.setAttribute('aria-label','All templates');allFolder.classList.toggle('svg-parts-folder',true);
    append(allFolder,node('span','svg-parts-folder-icon'),node('strong','','All templates'),node('small','',parts.length+' assets'));folders.appendChild(allFolder);
    for(const template of catalog){
      const folder=button('',()=>openFolder(template.id));folder.classList.toggle('svg-parts-folder',true);
      folder.setAttribute('aria-label','Open folder '+template.name);
      append(folder,node('span','svg-parts-folder-icon'),node('strong','',template.name.replace(/^Template \d+ · /,'')),node('small','',(template.components||[]).length+' assets'));
      folders.appendChild(folder);
    }
    const mixBar=node('div','svg-parts-mixbar'),mixCount=node('span','production-note','0 shown');
    const addMixButton=button('Add mix to scene',()=>saveMix());addMixButton.title='Add an independent copy of every piece whose preview eye is on, in one undoable action.';
    const dropZone=node('div','svg-parts-dropzone');dropZone.setAttribute('role','region');dropZone.setAttribute('aria-label','Add assets to editing scene');dropZone.tabIndex=0;
    append(assetToolbar,folderToggle,newFolderButton,uploadButton,uploadInput);append(mixBar,mixCount,addMixButton);
    append(libraryBody,assetToolbar,folderForm,searchInput,folderContext,folders,grid,mixBar,dropZone,layersHeading,layerNote,layers,stackActions);
    append(root,heading,targetNote,intro,sourceToolbar,tabs,filters,libraryBody,editor,status);target.appendChild(root);
    const tabButtons=new Map();
    for(const [id,title] of categories){const item=button(title,()=>selectCategory(id));item.setAttribute('aria-pressed',String(id===category));tabButtons.set(id,item);tabs.appendChild(item);}
    on(pageSelect,'change',()=>{page=pageSelect.value;renderGrid();say('Library filtered. No scene layers changed.');});
    on(searchInput,'input',()=>{search=searchInput.value.trim().toLowerCase();renderGrid();});
    on(uploadInput,'change',()=>{const owner=uploadTarget||(managedFolders?uploadFolder():{value:scene(),stamp:sceneStamp(scene())});uploadTarget=null;const files=Array.from(uploadInput.files||[]);uploadInput.value='';if(files.length)return managedFolders?uploadFiles(files,owner):importContent(files,owner);});
    if(managedFolders){bindFolderDrop(folderContext,()=>uploadFolder());if(images.subscribe)disposers.static.push(images.subscribe(()=>{if(!libraryBusy)void refreshLibrary();}));}
    const acceptSceneDrag=event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';dropZone.classList.toggle('drag-over',true);};
    on(dropZone,'dragenter',acceptSceneDrag);on(dropZone,'dragover',acceptSceneDrag);
    on(dropZone,'dragleave',()=>dropZone.classList.toggle('drag-over',false));
    on(dropZone,'drop',event=>receiveDrop(event,false));
    // Stable parent: Sources rows are rebuilt on selection. Leave reorder drags alone.
    if(options.sourceDropTarget){
      const surface=options.sourceDropTarget;
      const accepts=event=>!surface.hidden&&scene()?.layout==='free'&&options.canDropToSources?.()!==false&&
        Array.from(event.dataTransfer?.types||[]).some(type=>type===dragType||type==='Files'&&!options.externalFileSources);
      const highlight=event=>{if(!accepts(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';surface.classList.toggle('svg-parts-scene-drop',true);};
      on(surface,'dragenter',highlight);on(surface,'dragover',highlight);
      on(surface,'dragleave',event=>{if(!surface.contains?.(event.relatedTarget))surface.classList.toggle('svg-parts-scene-drop',false);});
      on(surface,'drop',event=>{surface.classList.toggle('svg-parts-scene-drop',false);if(accepts(event))return receiveDrop(event,false);});
      disposers.static.push(()=>surface.classList.toggle('svg-parts-scene-drop',false));
    }
    if(options.previewDropTarget){
      const surface=options.previewDropTarget;
      const acceptPreviewDrag=event=>{if(Array.from(event.dataTransfer?.types||[]).includes(dragType)){event.preventDefault();event.dataTransfer.dropEffect='copy';surface.classList.toggle('svg-parts-preview-drop',true);}};
      on(surface,'dragenter',acceptPreviewDrag);on(surface,'dragover',acceptPreviewDrag);
      on(surface,'dragleave',()=>surface.classList.toggle('svg-parts-preview-drop',false));
      on(surface,'drop',event=>{
        if(options.externalFileSources&&!Array.from(event.dataTransfer?.types||[]).includes(dragType))return;
        return receiveDrop(event,true);
      });
    }
    // Launchers (including numbered Preview slots) must reveal folders, never
    // toggle an already-open browser closed or reset the current draft/mix.
    function openFolders() {
      if(destroyed)return false;
      folders.hidden=false;folderToggle.setAttribute('aria-expanded','true');
      folders.scrollIntoView?.({block:'nearest'});
      folderToggle.focus?.({preventScroll:true});
      if(managedFolders)void refreshLibrary();
      return true;
    }
    function openFolder(id){page=id;pageSelect.value=id;category='all';search='';searchInput.value='';folders.hidden=true;folderToggle.setAttribute('aria-expanded','false');renderGrid();say('Folder opened. Your preview mix is unchanged.');}
    async function refreshLibrary() {
      const request=++libraryRequest;
      try {
        const next=await images.listLibrary();if(destroyed||request!==libraryRequest)return;
        library=next;
        if(page&&!catalog.some(template=>template.id===page)&&!library.folders.some(folder=>folder.id===page))page='uploads';
        pageSelect.textContent='';allPages.textContent='All templates & uploads';pageSelect.appendChild(allPages);
        for(const row of [...catalog,...library.folders]){const option=node('option','',row.name);option.value=row.id;pageSelect.appendChild(option);}pageSelect.value=page;
        renderFolders();renderGrid();updateActions();
      }catch(error){if(!destroyed&&request===libraryRequest)say('Folders unavailable: '+(error.message||String(error)),true);}
    }
    function renderFolders() {
      clear('folders');folders.textContent='';
      const addFolderTile=(id,name,count,custom=false)=>{
        const row=node('div','svg-parts-folder-row'),item=node('button','svg-parts-folder');item.type='button';item.setAttribute('aria-label',id?'Open folder '+name:'All templates');
        append(item,node('span','svg-parts-folder-icon'),node('strong','',name),node('small','',count+' asset'+(count===1?'':'s')));on(item,'click',()=>openFolder(id),'folders');row.appendChild(item);
        if(custom){bindFolderDrop(row,()=>library.folders.find(folder=>folder.id===id),'folders');
          if(id!=='uploads'){const remove=node('button','svg-parts-icon-button svg-parts-delete');remove.type='button';remove.disabled=libraryBusy;remove.setAttribute('aria-label','Remove folder '+name);remove.title='Move its images to Uploads. Scene copies and image files are preserved.';const icon=node('span','svg-parts-trash-icon');icon.setAttribute('aria-hidden','true');remove.appendChild(icon);on(remove,'click',()=>removeAssetFolder(id,name),'folders');row.appendChild(remove);}
        }else item.title='Built-in template folder · read-only';
        folders.appendChild(row);
      };
      folders.appendChild(node('strong','svg-parts-folder-section','Your folders'));
      for(const folder of library.folders)addFolderTile(folder.id,folder.name,library.assets.filter(asset=>asset.folderId===folder.id).length,true);
      folders.appendChild(node('p','svg-parts-folder-section production-note','Drop images on a folder to upload. To move an asset, drag over Folders, then into your folder. Removing a folder keeps its images in Uploads.'));
      folders.appendChild(node('strong','svg-parts-folder-section','Built-in templates · read-only'));addFolderTile('','All templates & uploads',parts.length+library.assets.length);
      for(const template of catalog)addFolderTile(template.id,template.name,(template.components||[]).length);
    }
    async function createAssetFolder() {
      if(destroyed||libraryBusy)return;
      libraryBusy=true;updateActions();
      try {const folder=await images.createFolder(folderName.value);if(destroyed)return;await refreshLibrary();if(destroyed)return;openFolder(folder.id);folderName.value='';folderForm.hidden=true;say('Created '+folder.name+'. Upload files here, then drag them to the scene drop area.');}
      catch(error){say(error.message||String(error),true);}finally{libraryBusy=false;if(!destroyed){renderFolders();updateActions();}}
    }
    async function removeAssetFolder(id,name) {
      if(destroyed||libraryBusy)return;libraryBusy=true;updateActions();
      try {await images.removeFolder(id);if(destroyed)return;await refreshLibrary();say('Removed folder '+name+'. Its images are in Uploads; existing scenes and Programme are unchanged.');}
      catch(error){say(error.message||String(error),true);}finally{libraryBusy=false;if(!destroyed){renderFolders();updateActions();}}
    }
    async function uploadFiles(files,folder) {
      if(destroyed||libraryBusy)return;libraryBusy=true;updateActions();let added=0;
      try {
        if(!folder?.id)throw new Error('Choose an upload folder first.');
        if(files.length>20)throw new Error('Upload up to 20 images at a time.');
        for(const file of files){if(destroyed)break;say('Uploading '+file.name+' to '+folder.name+'…');await images.importFile(file,{folderId:folder.id});added++;}
        if(!destroyed){await refreshLibrary();say('Uploaded '+added+' image'+(added===1?'':'s')+' to '+folder.name+'. Drag to the scene drop area or use +. Nothing was added to Programme.');}
      }catch(error){if(!destroyed){await refreshLibrary();say((added?added+' image'+(added===1?'':'s')+' saved. ':'')+(error.message||String(error)),true);}}
      finally{libraryBusy=false;if(!destroyed){renderFolders();updateActions();}}
    }
    function bindFolderDrop(target,getFolder,scope='static') {
      on(target,'dragover',event=>{const types=Array.from(event.dataTransfer?.types||[]);if(types.includes('Files')||types.includes(dragType)){event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';target.classList.toggle('drag-over',true);}},scope);
      on(target,'dragleave',()=>target.classList.toggle('drag-over',false),scope);
      on(target,'drop',async event=>{
        event.preventDefault();event.stopPropagation();target.classList.toggle('drag-over',false);if(destroyed||libraryBusy)return;
        const folder=getFolder(),transfer=event.dataTransfer,files=Array.from(transfer?.files||[]);
        if(files.length)return uploadFiles(files,folder);
        try {const raw=transfer?.getData(dragType);if(!raw||raw.length>2048)throw new Error('Drop local images or an uploaded asset into your folder.');const data=JSON.parse(raw);
          if(data.owner!==inspectorId||!library.assets.some(asset=>asset.id===data.imageId)||!folder)throw new Error('Only uploaded assets can be moved into your folders. Built-in templates stay in their original folders.');
          libraryBusy=true;updateActions();await images.moveImage(data.imageId,folder.id);if(!destroyed){await refreshLibrary();say('Moved the image to '+folder.name+'. Scene copies and Programme are unchanged.');}
        }catch(error){say(error.message||String(error),true);}finally{libraryBusy=false;if(!destroyed){renderFolders();updateActions();}}
      },scope);
    }
    function renderGrid() {
      closeLayerMenu();closeRemovalChoices();clear('grid');libraryVisibilityControls.clear();grid.textContent='';const generation=++gridGeneration,test=categories.find(row=>row[0]===category)[2];
      if(managedFolders)folderContext.textContent='Upload to '+(uploadFolder()?.name||'Uploads')+' · drop PNG, JPEG or WebP here';
      const tag=category==='text'?'texts':category;
      const visible=parts.filter(part=>(!page||part.template.id===page)&&(!search||(part.component.label+' '+part.template.name+' '+part.component.type).toLowerCase().includes(search))&&
        (part.component.category===tag||part.component.categories?.includes(tag)||test(part.component)));count.textContent=visible.length+' template pieces';
      for(const part of visible){
        const row=node('div','svg-parts-tile-row');
        const item=node('button','svg-parts-tile');item.type='button';item.setAttribute('aria-label','Preview '+part.component.label+' · '+part.template.name);
        item.setAttribute('aria-pressed',String(selected?.mode==='part'&&selected.template.id===part.template.id&&selected.component.id===part.component.id));
        const thumbnail=part.component.thumbnail||part.component.artwork;
        if(thumbnail){const image=node('img');image.src=templates.assetUrl(thumbnail);image.alt='';image.loading='lazy';image.setAttribute('data-surface',part.component.thumbnailSurface||'light');item.appendChild(image);}
        else item.appendChild(node('span','svg-parts-empty-thumb','Feed area'));
        item.title=part.component.label+' · '+part.template.name;
        item.draggable=true;
        on(item,'dragstart',event=>{
          if(busy||!scene()?.id){event.preventDefault();return;}
          stash();event.dataTransfer?.setData(dragType,JSON.stringify({owner:inspectorId,sceneId:scene().id,templateId:part.template.id,componentId:part.component.id}));
          if(event.dataTransfer)event.dataTransfer.effectAllowed='copy';
        },'grid');
        on(item,'dragend',()=>{dropZone.classList.toggle('drag-over',false);options.previewDropTarget?.classList.toggle('svg-parts-preview-drop',false);options.sourceDropTarget?.classList.toggle('svg-parts-scene-drop',false);},'grid');
        append(item,node('strong','',part.component.label),node('small','',part.template.name),node('span','svg-parts-kind',part.component.editableText?'Editable text':part.component.virtual?'Source area':part.component.type));
        const eye=node('button','svg-parts-visibility');eye.type='button';
        const icon=node('span','svg-parts-eye-icon');icon.setAttribute('aria-hidden','true');
        const scope=node('span','svg-parts-visibility-scope');append(eye,icon,scope);
        const add=node('button','svg-parts-icon-button svg-parts-add');add.type='button';
        const plus=node('span','svg-parts-add-icon');plus.setAttribute('aria-hidden','true');add.appendChild(plus);
        const copiesBadge=node('small','svg-parts-copy-count');copiesBadge.setAttribute('aria-hidden','true');copiesBadge.hidden=true;add.appendChild(copiesBadge);
        const record={part,item,row,eye,scope,add,plus,copiesBadge};libraryVisibilityControls.add(record);
        on(item,'click',()=>selectPart(part.template.id,part.component.id),'grid');
        on(eye,'click',()=>toggleLibraryVisibility(record),'grid');
        on(add,'click',()=>toggleLibrarySceneCopy(record),'grid');
        append(row,item,eye,add,layerMenuTrigger(row,{record},'Actions for '+part.component.label+' · '+part.template.name,'grid'));grid.appendChild(row);
      }
      const uploaded=managedFolders&&category==='all'?library.assets.filter(asset=>(!page||asset.folderId===page)&&(!search||asset.name.toLowerCase().includes(search))):[];
      for(const asset of uploaded)renderUpload(asset,generation);
      if(managedFolders){const total=visible.length+uploaded.length;count.textContent=total+' asset'+(total===1?'':'s');}
      if(!visible.length&&!uploaded.length)grid.appendChild(node('p','production-note',library.folders.some(folder=>folder.id===page)?'No matching images. Upload to this folder, then drag an image to the scene drop area.':'No pieces in this category on the selected page.'));
      for(const [id,item] of tabButtons)item.setAttribute('aria-pressed',String(id===category));
      syncLibraryVisibility();
    }
    function imagePart(asset){const base=parts.find(part=>part.component.type==='background'&&imageEligible(part.component));return base&&{...base,asset};}
    function selectLibraryPart(part){return part.asset?choose(part,'asset'):selectPart(part.template.id,part.component.id);}
    function renderUpload(asset,generation) {
      const part=imagePart(asset);if(!part)return;
      const row=node('div','svg-parts-tile-row svg-parts-upload-row'),item=node('button','svg-parts-tile');item.type='button';item.draggable=true;
      item.setAttribute('aria-label','Preview uploaded image '+asset.name);
      const thumb=node('canvas');thumb.width=112;thumb.height=80;thumb.setAttribute('aria-hidden','true');
      append(item,thumb,node('strong','',asset.name),node('small','',library.folders.find(folder=>folder.id===asset.folderId)?.name||'Uploads'),node('span','svg-parts-kind',asset.width+' × '+asset.height+' · Image'));
      const add=node('button','svg-parts-icon-button svg-parts-add');add.type='button';const plus=node('span','svg-parts-add-icon');plus.setAttribute('aria-hidden','true');const copiesBadge=node('small','svg-parts-copy-count');copiesBadge.hidden=true;append(add,plus,copiesBadge);
      const record={part,row,item,add,plus,copiesBadge};libraryVisibilityControls.add(record);
      on(item,'click',()=>selectLibraryPart(part),'grid');on(add,'click',()=>toggleLibrarySceneCopy(record),'grid');
      on(item,'dragstart',event=>{if(busy){event.preventDefault();return;}event.dataTransfer?.setData(dragType,JSON.stringify({owner:inspectorId,sceneId:scene()?.id,imageId:asset.id}));if(event.dataTransfer)event.dataTransfer.effectAllowed='copyMove';},'grid');
      on(item,'dragend',()=>options.sourceDropTarget?.classList.toggle('svg-parts-scene-drop',false),'grid');
      append(row,item,add,layerMenuTrigger(row,{record},'Actions for '+asset.name,'grid'));grid.appendChild(row);
      // Load thumbnails serially: the image decoder has a bounded shared cache.
      thumbnailTail=thumbnailTail.then(async()=>{if(destroyed||generation!==gridGeneration)return;try{const decoded=await images.load(asset.id);if(destroyed||generation!==gridGeneration)return;const scale=Math.min(thumb.width/decoded.width,thumb.height/decoded.height);thumb.getContext('2d').drawImage(decoded.image,(thumb.width-decoded.width*scale)/2,(thumb.height-decoded.height*scale)/2,decoded.width*scale,decoded.height*scale);}catch(_){item.title='Image unavailable. Re-upload the original file to restore it.';}});
    }
    const isSelectedPart = part => editorSceneId===scene()?.id&&(part.asset?selected?.mode==='asset'&&selected.asset.id===part.asset.id:selected?.mode==='part'&&selected.template.id===part.template.id&&selected.component.id===part.component.id);
    const sceneCopies=(part,value=scene())=>(value?.svgParts||[]).filter(copy=>part.asset?copy.style?.components?.[copy.componentId]?.imageId===part.asset.id:copy.templateId===part.template.id&&copy.componentId===part.component.id&&!copy.style?.components?.[copy.componentId]?.imageId);
    const nativeSceneCopy=(part,value=scene(),rows)=>!part.asset&&value?.fullTemplateId===part.template.id&&typeof studio.sceneContents==='function'
      ?(rows||studio.sceneContents(value)).find(row=>row.kind==='template'&&row.templateId===part.template.id&&row.componentId===part.component.id)||null:null;
    function selectNativeCopy(part,value=scene(),opener=doc.activeElement){
      const row=nativeSceneCopy(part,value);if(!row)return null;
      cancel({quiet:true});publishPreview(null);
      options.onSelectNativeSource?.(row,{scene:value,opener});
      say('This piece is already in the scene template. Selected its existing source; no copy was added.');return row;
    }
    function layerMenuTrigger(row,target,name,scope) {
      const trigger=node('button','svg-parts-icon-button svg-parts-more');trigger.type='button';
      trigger.setAttribute('aria-label',name);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
      trigger.title='More actions · layer order and page alignment';
      trigger.setAttribute('data-menu-target',target.id?'layer:'+target.id:target.record.part.asset?'asset:'+target.record.part.asset.id:'template:'+templateKey(target.record.part));
      const dots=node('span','svg-parts-more-dots','•••');dots.setAttribute('aria-hidden','true');trigger.appendChild(dots);
      on(trigger,'click',event=>{event.stopPropagation?.();if(layerMenu?.opener===trigger)closeLayerMenu(true);else openLayerMenu(trigger,target);},scope);
      on(row,'contextmenu',event=>{event.preventDefault?.();event.stopPropagation?.();openLayerMenu(trigger,target,event);},scope);
      on(row,'keydown',event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault?.();openLayerMenu(trigger,target);}},scope);
      return trigger;
    }
    function closeLayerMenu(restore=false) {
      if(!layerMenu)return;const old=layerMenu;layerMenu=null;clear('menu');old.panel.remove();old.opener.setAttribute('aria-expanded','false');
      if(restore)restoreMenuFocus(old);
    }
    function restoreMenuFocus(state) {
      const key=state.opener.getAttribute('data-menu-target'),opener=state.opener.isConnected!==false?state.opener:
        Array.from(root.querySelectorAll?.('.svg-parts-more')||[]).find(n=>n.getAttribute('data-menu-target')===key);
      if(opener)opener.focus?.();else{root.setAttribute('tabindex','-1');root.focus?.();}
    }
    function openLayerMenu(opener,target,event) {
      closeLayerMenu();if(destroyed)return;
      const owner=scene(),copies=target.id?(owner?.svgParts||[]).filter(p=>p.id===target.id):sceneCopies(target.record.part,owner);
      const panel=node('div','svg-parts-context-menu');panel.setAttribute('role','menu');panel.setAttribute('aria-label','Scene layer actions');
      const state={opener,panel,owner,stamp:sceneStamp(owner),id:copies.length===1?copies[0].id:null,target,copies,items:[],x:event?.clientX,y:event?.clientY};layerMenu=state;
      (doc.body||root).appendChild(panel);opener.setAttribute('aria-expanded','true');
      const alive=()=>layerMenu===state&&scene()===owner&&sceneStamp(owner)===state.stamp;
      function show(page='home') {
        if(!alive()){closeLayerMenu();return;}clear('menu');panel.textContent='';state.items=[];
        const title=node('div','svg-parts-menu-title',page==='align'?'Align to page':page==='order'?'Layer':copies.length>1&&!state.id?'Choose scene copy':'Scene copy actions');panel.appendChild(title);
        const add=(label,callback,disabled=false,submenu=false)=>{
          const b=node('button','svg-parts-menu-item',label);b.type='button';b.disabled=disabled;b.setAttribute('role','menuitem');b.tabIndex=-1;
          if(submenu)b.setAttribute('aria-haspopup','menu');on(b,'click',()=>{if(!b.disabled&&alive())return callback();else if(!alive())closeLayerMenu();},'menu');panel.appendChild(b);state.items.push(b);return b;
        };
        const part=owner?.svgParts?.find(p=>p.id===state.id),ready=!!part&&!owner.layoutPending&&!busy&&!autoTail&&!autoPending.size;
        if(page!=='home')add('‹ Back',()=>show());
        if(page==='home'&&copies.length>1&&!state.id){
          for(const p of copies){const i=owner.svgParts.indexOf(p),name=p.style?.components?.[p.componentId]?.text||p.componentId;add('Layer '+(i+1)+' · '+name,()=>{state.id=p.id;show();});}
        }else if(page==='home'){
          add('Layer ›',()=>show('order'),!ready,true);add('Align to page ›',()=>show('align'),!ready,true);
          add('Show layers',()=>{closeLayerMenu(true);layers.scrollIntoView?.({block:'nearest'});layers.setAttribute('tabindex','-1');layers.focus?.();});
          if(target.record&&nativeSceneCopy(target.record.part,owner))add('Edit existing template source',()=>{closeLayerMenu();return selectNativeCopy(target.record.part,owner,opener);},!owner?.id||!!owner?.layoutPending||busy);
          else if(!copies.length&&target.record)add('Add copy to scene',()=>{closeLayerMenu();selectLibraryPart(target.record.part);return saveSelected(false);},!owner?.id||!!owner?.layoutPending||busy);
          panel.appendChild(node('p','svg-parts-menu-note',copies.length?'Edits this scene copy only. Cut/Fade updates Programme.':'Add a scene copy before arranging it. The folder original stays unchanged.'));
        }else if(page==='order'){
          const stack=owner.layout==='free'&&studio.freeLayers?studio.freeLayers(owner):null;
          const index=stack?stack.findIndex(row=>row.part?.id===part.id):owner.svgParts.indexOf(part),last=stack?stack.length-1:owner.svgParts.length-1;
          for(const [action,label,disabled] of [['front','Bring to front',index===last],['forward','Bring forward',index===last],['back','Send backward',index===0],['bottom','Send to back',index===0]])add(label,()=>runLayerMenu(state,action),!ready||disabled);
        }else{
          for(const [action,label] of [['left','Left'],['center','Center horizontally'],['right','Right'],['top','Top'],['middle','Center vertically'],['bottom','Bottom']])add(label,()=>runLayerMenu(state,'align-'+action),!ready);
          panel.appendChild(node('p','svg-parts-menu-note','Aligns the transformed layer box to its native page.'));
        }
        on(panel,'keydown',e=>{
          const enabled=state.items.filter(b=>!b.disabled),index=enabled.indexOf(doc.activeElement);
          if(['Escape','Tab'].includes(e.key)){if(e.key==='Escape'){e.preventDefault?.();e.stopPropagation?.();}closeLayerMenu(true);return;}
          if(e.key==='ArrowLeft'&&page!=='home'){e.preventDefault?.();show();return;}
          if(e.key==='ArrowRight'&&doc.activeElement?.getAttribute('aria-haspopup')==='menu'){e.preventDefault?.();doc.activeElement.click();return;}
          if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault?.();const i=e.key==='Home'?0:e.key==='End'?enabled.length-1:(index+(e.key==='ArrowUp'?-1:1)+enabled.length)%enabled.length;for(const b of state.items)b.tabIndex=b===enabled[i]?0:-1;enabled[i]?.focus?.();}
        },'menu');
        if(doc.addEventListener)on(doc,'pointerdown',e=>{if(!panel.contains(e.target)&&!opener.contains(e.target))closeLayerMenu();},'menu');
        if(window.addEventListener){on(window,'resize',()=>closeLayerMenu(),'menu');}
        const rect=opener.getBoundingClientRect?.()||{left:0,bottom:0};
        const width=panel.offsetWidth||232,height=panel.offsetHeight||280,vw=window.innerWidth||1024,vh=window.innerHeight||768;
        panel.style&&(panel.style.left=Math.max(8,Math.min(state.x??rect.left,vw-width-8))+'px',panel.style.top=Math.max(8,Math.min(state.y??rect.bottom,vh-height-8))+'px');
        const first=state.items.find(b=>!b.disabled);if(first){first.tabIndex=0;first.focus?.();}
      }
      show();
    }
    async function runLayerMenu(state,action) {
      if(destroyed||busy||autoTail||autoPending.size)return;let request;
      try{
        const owner=state.owner,part=owner?.svgParts?.find(p=>p.id===state.id);
        if(scene()!==owner||sceneStamp(owner)!==state.stamp||!part||owner.layoutPending)throw Error('The scene changed. Open the layer menu again.');
        const editing=selected?.mode==='layer'&&editorSceneId===owner.id&&selected.layerId===part.id;
        if(editing&&JSON.stringify(readForm().style)!==JSON.stringify(part.style||{}))throw Error('Save or reload the staged layer edits before arranging it.');
        const form=formStamp();closeLayerMenu();root.setAttribute('tabindex','-1');root.focus?.();clearPreviewFrame();request=++serial;busy=true;updateActions();let result;
        const isCurrent=()=>!destroyed&&request===serial&&scene()===owner&&sceneStamp(owner)===state.stamp&&formStamp()===form;
        if(action.startsWith('align-')){
          const template=catalog.find(t=>t.id===part.templateId),component=template?.components.find(c=>c.id===part.componentId);
          const style=alignmentStyle(template,component,part.style,action.slice(6));
          result=await studio.updateSceneSvgPart(owner.id,part.id,{style},{isCurrent});
        }else{
          const ids=owner.svgParts.map(p=>p.id),index=ids.indexOf(part.id),to={front:ids.length-1,forward:Math.min(ids.length-1,index+1),back:Math.max(0,index-1),bottom:0}[action];
          if(to===undefined)throw Error('Unknown layer action.');
          if(owner.layout==='free'&&studio.moveFreeLayer)result=studio.moveFreeLayer(owner.id,'part:'+part.id,{front:'front',forward:'forward',back:'backward',bottom:'back'}[action]);
          else{ids.splice(index,1);ids.splice(to,0,part.id);result=studio.reorderSceneSvgParts(owner.id,ids);}
        }
        if(!result)throw Error('The layer change could not be saved.');
        if(destroyed||request!==serial)return;
        busy=false;if(editing&&action.startsWith('align-'))selectLayer(part.id,true);else renderLayers();
        notify(result,action,owner.id);say('Layer arrangement saved. Undo layer change restores it. Programme is unchanged.');
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);}
      finally{if(request===serial){busy=false;updateActions();}if(!destroyed&&scene()===state.owner&&!layerMenu&&doc.activeElement===root)restoreMenuFocus(state);}
    }
    function syncLibraryVisibility() {
      const value=scene();
      if(layerMenu&&(scene()!==layerMenu.owner||sceneStamp(value)!==layerMenu.stamp))closeLayerMenu();
      if(removalChoice&&(busy||value!==removalChoice.owner||sceneStamp(value)!==removalChoice.stamp))closeRemovalChoices();
      const mixed=parts.filter(part=>templatePreviews.get(templateKey(part))?.visible).length;
      mixCount.textContent=mixed+' shown';addMixButton.disabled=busy||!value?.id||!!value.layoutPending||!mixed;
      const nativeRows=value?.fullTemplateId&&typeof studio.sceneContents==='function'?studio.sceneContents(value):[];
      for(const record of libraryVisibilityControls){
        const {part,item,row,eye,scope,add,plus,copiesBadge}=record;
        const shown=templatePreviews.get(templateKey(part))?.visible===true;
        const selectedPart=isSelectedPart(part),disabled=busy||!value?.id||!!value.layoutPending;
        const copies=sceneCopies(part,value),copyIds=copies.map(copy=>copy.id),native=nativeSceneCopy(part,value,nativeRows);
        const uiState=JSON.stringify([shown,selectedPart,disabled,value?.id,copyIds,native?.key]);
        // Typing and dragging do not change 72 library rows. Avoid rewriting
        // their accessibility/text DOM on every live-preview notification.
        if(record.uiState===uiState)continue;
        record.uiState=uiState;
        record.owner=value;record.copyIds=copyIds;
        const state=shown?'shown':'hidden';
        row.setAttribute('data-visibility',state);eye?.setAttribute('data-visibility',state);
        if(eye){eye.setAttribute('data-scope','preview');eye.disabled=disabled;}add.disabled=disabled;
        item.setAttribute('aria-pressed',String(selectedPart));
        if(scope)scope.textContent='Preview';
        const name=part.asset?part.asset.name:part.component.label+' · '+part.template.name;
        const hasCopies=copies.length>0;
        if(native){
          add.setAttribute('data-action','edit-native');add.setAttribute('aria-label','Edit '+name+' already in scene template');
          add.title='This piece is already part of '+label()+'. Edit its existing template source without adding another copy.';
          plus.className='svg-parts-native-edit-icon';plus.textContent='✎';copiesBadge.hidden=true;copiesBadge.textContent='';add.removeAttribute('aria-expanded');
        }else{
        add.setAttribute('data-action',hasCopies?'remove':'add');
        add.setAttribute('aria-label',copies.length>1?'Choose a copy of '+name+' to remove from scene':(hasCopies?'Remove ':'Add ')+name+(hasCopies?' from scene':' to scene'));
        add.title=hasCopies?(copies.length>1?'Choose exactly one of '+copies.length+' saved copies to delete.':'Delete this saved scene copy.')+' Target: '+label()+'. Undo restores it; the template and preview mix stay unchanged.':
          'Add one editable copy to '+label()+'. Uses staged settings; originals and other preview eyes stay unchanged.';
        plus.className=hasCopies?'svg-parts-trash-icon':'svg-parts-add-icon';plus.textContent='';
        copiesBadge.hidden=copies.length<2;copiesBadge.textContent=copies.length>1?String(copies.length):'';
        if(copies.length>1)add.setAttribute('aria-expanded',String(removalChoice?.record===record));else add.removeAttribute('aria-expanded');
        }
        if(eye){eye.setAttribute('aria-pressed',String(shown));
          eye.setAttribute('aria-label',(shown?'Hide ':'Show ')+name+' in preview');
          eye.title='Template preview only. The original and any saved scene copies stay unchanged. Manage saved copies under Scene layers.';}
      }
    }
    function closeRemovalChoices() {
      if(!removalChoice)return;
      const {record,panel}=removalChoice;removalChoice=null;clear('removal');panel.remove();record.add.setAttribute('aria-expanded','false');record.add.removeAttribute('aria-controls');
    }
    function toggleLibrarySceneCopy(record) {
      if(destroyed||busy||!scene()?.id)return null;
      const {part}=record,value=scene(),copies=sceneCopies(part,value);
      if(record.owner!==value||JSON.stringify(copies.map(copy=>copy.id))!==JSON.stringify(record.copyIds)){
        syncLibraryVisibility();say('The scene changed. Review the updated Add/Remove button and try again.',true);return null;
      }
      if(nativeSceneCopy(part,value))return selectNativeCopy(part,value,record.add);
      if(!copies.length){
        if(!isSelectedPart(part))selectLibraryPart(part);
        return saveSelected(false,true);
      }
      if(copies.length===1)return removeSceneLayer(copies[0].id,value);
      if(removalChoice?.record===record){closeRemovalChoices();return null;}
      closeRemovalChoices();
      const panel=node('section','svg-parts-remove-choices');panel.id=inspectorId+'-remove-copy';panel.setAttribute('role','region');panel.setAttribute('aria-label','Choose a scene copy to remove');
      const heading=node('strong','','Delete a scene copy'),note=node('p','',copies.length+' copies in '+label()+'. Choose one; the asset stays in your library.');
      const select=node('select');select.setAttribute('aria-label','Scene copy to delete');
      const placeholder=node('option','','Choose a copy…');placeholder.value='';select.appendChild(placeholder);
      for(const copy of copies){
        const index=value.svgParts.indexOf(copy),style=copy.style?.components?.[copy.componentId]||{};
        const detail=style.imageId?'Custom image':typeof style.text==='string'?'“'+style.text.slice(0,40)+'”':part.component.label;
        const option=node('option','','Layer '+(index+1)+' · '+detail+' · '+(style.visible===false?'hidden':'shown'));option.value=copy.id;select.appendChild(option);
      }
      select.value='';
      const remove=node('button','production-button','Delete selected copy'),close=node('button','production-button','Cancel');remove.type=close.type='button';remove.disabled=true;
      const actions=node('div','svg-parts-remove-actions');append(actions,close,remove);append(panel,heading,note,select,actions);
      const choice={record,panel,owner:value,stamp:sceneStamp(value)};removalChoice=choice;
      record.row.appendChild(panel);record.add.setAttribute('aria-expanded','true');record.add.setAttribute('aria-controls',panel.id);
      on(select,'change',()=>{remove.disabled=busy||!copies.some(copy=>copy.id===select.value);},'removal');
      on(close,'click',()=>{closeRemovalChoices();record.add.focus?.();},'removal');
      on(panel,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRemovalChoices();record.add.focus?.();}},'removal');
      on(remove,'click',()=>{
        if(busy||destroyed||removalChoice!==choice)return null;
        if(scene()!==value||sceneStamp(value)!==choice.stamp){closeRemovalChoices();syncLibraryVisibility();say('The scene changed. Choose the copy again before deleting.',true);return null;}
        if(!copies.some(copy=>copy.id===select.value))return null;
        const result=removeSceneLayer(select.value,value);if(result){closeRemovalChoices();record.add.focus?.();}return result;
      },'removal');
      select.focus?.();say('Choose the exact saved copy to delete. Nothing has been removed.');return null;
    }
    async function toggleLibraryVisibility(record) {
      if(destroyed||busy||!scene()?.id)return;
      // A reusable catalogue entry must never become a saved-layer switch,
      // even when one or several scene copies originate from this template.
      const {part}=record;
      const entry=templateEntry(part),show=!entry.visible;
      // Eyes change only their own entry. Selecting an editor is separate.
      if(!selected||selected.mode!=='part'||editorSceneId!==scene()?.id)selectPart(part.template.id,part.component.id);
      if(isSelectedPart(part)){
        controls.get('visible').input.checked=show;
        draft.touched=[...new Set([...(draft.touched||[]),'visible'])];stash();
      }else{
        const cached=drafts.get(entry.key);
        if(cached){cached.raw.visible=show;cached.touched=[...new Set([...(cached.touched||[]),'visible'])];}
      }
      entry.visible=show;
      entry.style={...entry.style,components:{[part.component.id]:{...entry.style.components?.[part.component.id],visible:show}}};
      if(show&&entry.asset?.error)entry.asset=null;
      cancel({quiet:true});
      markPreviewStale(true);queuePreview();syncLibraryVisibility();
      say((show?'Shown':'Hidden')+' in preview only. No scene layers changed.');
    }
    function renderLayers() {
      if(inspectorTarget){layerListDirty=true;updateActions();return;}
      layerListDirty=false;
      clear('layers');layers.textContent='';const generation=++layerRender,value=scene(), rows=value?.svgParts||[];
      targetNote.textContent=label();layersHeading.textContent='Scene layers · bottom → top · '+rows.length;
      intro.textContent='Eyes mix visible pieces in Preview. Drag to the master preview to mix, or to the drop area to add. Add mix saves all shown pieces; originals stay unchanged.'+
        (value?.fullTemplateId?' Adding a piece will first break the current full template into independent layers, preserving its artwork and source bindings.':'');
      if(managedFolders)intro.textContent='Folder assets are reusable. Upload stores only; drag or + adds a scene copy. Template eyes mix Preview. Only Cut/Fade changes Programme.';
      layerNote.textContent=value?.svgPartsMode==='parts-only'?'Independent layers form this scene. Source-slot bindings stay scene-local.':
        'Your scene copies · Show/Hide affects this scene, never the original template.';
      if(!rows.length)layers.appendChild(node('p','production-note','No independent SVG layers in this scene yet.'));
      layerVisibilityControls.clear();layerDeleteControls.clear();
      rows.forEach((part,index)=>{
        const template=catalog.find(item=>item.id===part.templateId),component=template?.components?.find(item=>item.id===part.componentId);
        const row=node('div','svg-parts-layer-row');row.setAttribute('role','group');
        const item=node('button','svg-parts-layer');item.type='button';item.setAttribute('aria-label','Edit SVG layer '+(index+1)+': '+(component?.label||part.componentId));
        item.setAttribute('aria-pressed',String(selected?.mode==='layer'&&editorSceneId===value.id&&selected.layerId===part.id));
        const imageId=part.style?.components?.[part.componentId]?.imageId;
        const thumbnail=component?.thumbnail||component?.artwork;
        let imageThumb=null;
        if(imageId){imageThumb=node('canvas');imageThumb.width=84;imageThumb.height=60;imageThumb.setAttribute('aria-hidden','true');item.appendChild(imageThumb);}
        else if(thumbnail){const image=node('img');image.src=templates.assetUrl(thumbnail);image.alt='';image.loading='lazy';image.setAttribute('data-surface',component.thumbnailSurface||'light');item.appendChild(image);}
        const hidden=part.style?.components?.[part.componentId]?.visible===false;
        const title=node('span','',(index+1)+' · '+(component?.label||'Unavailable piece')+(hidden?' · hidden':''));
        append(item,title,node('small','',imageId?'Local image · scene copy':template?.name||part.templateId));
        on(item,'click',()=>selectLayer(part.id),'layers');
        const shown=!hidden;
        const visibility=node('button','svg-parts-layer-visibility',shown?'Hide':'Show');visibility.type='button';
        visibility.setAttribute('aria-pressed',String(shown));
        visibility.setAttribute('aria-label',(shown?'Hide ':'Show ')+(component?.label||part.componentId)+' in editing scene');
        visibility.title='Save visibility only. '+(shown?'Hide':'Show')+' this layer without deleting it or changing sources or audio.';
        const remove=node('button','svg-parts-icon-button svg-parts-delete');remove.type='button';
        remove.setAttribute('data-layer-id',part.id);
        remove.setAttribute('aria-label','Delete scene layer '+(index+1)+': '+(component?.label||part.componentId));
        remove.title=part.locked?'Unlock this artwork layer before removing it.':'Remove only this scene copy. Original templates, other copies and source bindings stay unchanged. Undo layer change restores it.';
        const trash=node('span','svg-parts-trash-icon');trash.setAttribute('aria-hidden','true');remove.appendChild(trash);
        if(imageId){
          const nameLayer=name=>{
            title.textContent=(index+1)+' · '+name+(hidden?' · hidden':'');
            item.setAttribute('aria-label','Edit SVG layer '+(index+1)+': '+name);
            visibility.setAttribute('aria-label',(shown?'Hide ':'Show ')+name+' in editing scene');
            remove.setAttribute('aria-label','Delete scene layer '+(index+1)+': '+name);
          };
          nameLayer('Uploaded image');
          const imageLibrary=options.images||window.OpenLiveSvgImages;
          if(imageLibrary?.load)void imageLibrary.load(imageId).then(asset=>{
            if(destroyed||generation!==layerRender)return;
            nameLayer(asset.name||'Uploaded image');
            const scale=Math.min(imageThumb.width/asset.width,imageThumb.height/asset.height);
            imageThumb.getContext('2d').drawImage(asset.image,(imageThumb.width-asset.width*scale)/2,(imageThumb.height-asset.height*scale)/2,asset.width*scale,asset.height*scale);
          }).catch(()=>{if(!destroyed&&generation===layerRender)nameLayer('Uploaded image · unavailable');});
        }
        layerVisibilityControls.add(visibility);
        layerDeleteControls.add(remove);
        on(visibility,'click',()=>toggleLayerVisibility(part.id,!shown),'layers');
        on(remove,'click',()=>removeSceneLayer(part.id,value),'layers');
        append(row,item,visibility,remove,layerMenuTrigger(row,{id:part.id},'Actions for scene layer '+(index+1),'layers'));layers.appendChild(row);
      });
      updateActions();
    }
    function addField(name,title,type,value,extras={}) {
      const wrap=node('div','svg-parts-field prow'+(type==='textarea'?' text-row':'')),input=node(type==='textarea'?'textarea':type==='select'?'select':'input');
      if(!['textarea','select'].includes(type))input.type=type;
      input.id=inspectorId+'-'+name.replace(/[^a-zA-Z0-9-]/g,'-');
      input.setAttribute('aria-label',title);Object.assign(input,extras);
      if(type==='select')for(const [key,text] of value){const option=node('option','',text);option.value=key;input.appendChild(option);}
      const initial=type==='select'?extras.initial:value;
      const current=Object.prototype.hasOwnProperty.call(draft.raw||{},name)?draft.raw[name]:initial;
      if(type==='checkbox')input.checked=!!current;else input.value=String(current??'');
      const control={input,initial:String(initial??'')};controls.set(name,control);editorEditingControls.add(input);
      // Match the main inspector's stable label rail without dropping the
      // full accessible name (including units) used by operators and tests.
      const shortLabels={x:'Position X (%)',y:'Position Y (%)',scale:'Scale (%)',scaleX:'Width (%)',scaleY:'Height (%)',
        rotation:'Rotation (°)',flipX:'Flip horizontal',flipY:'Flip vertical',text:'Text',textColor:'Colour',
        fontSize:'Size',fontFamily:'Font',fontWeight:'Weight',fontStyle:'Style',textAlign:'Alignment',overflow:'Overflow',overflowSpeed:'Scroll speed',target:'Destination'};
      const fieldLabel=node('label','',shortLabels[name]||title);fieldLabel.htmlFor=input.id;
      fieldLabel.title=title+': right-click to restore original';input.title=title;
      const gutter=node('span','tw');gutter.setAttribute('aria-hidden','true');
      input.className=type==='number'?'svg-parts-value val':'svg-parts-wide wide';
      append(wrap,gutter,fieldLabel,input);fieldTarget.appendChild(wrap);
      const sync=()=>{
        if(!control.slider)return;
        const text=String(input.value).trim(),number=Number(text),valid=text!==''&&Number.isFinite(number)&&number>=Number(input.min)&&number<=Number(input.max);
        control.slider.disabled=!valid||editorReadOnly();
        input.setAttribute('aria-invalid',String(!valid));
        if(valid){control.slider.value=String(number);control.slider.setAttribute('aria-valuetext',String(number));}
      };
      const changed=()=>{if(editorReadOnly()){updateActions();return;}sync();draft.touched=[...new Set([...(draft.touched||[]),name])];stash();cancel({quiet:true});markPreviewStale(true);queuePreview();say(options.autoSaveLayers&&selected?.mode==='layer'?'Saving scene changes…':'Live preview updating. Add or Apply explicitly to save.');autoSaveLayer();};
      on(fieldLabel,'contextmenu',event=>{event.preventDefault?.();resetFields([name]);},'editor');
      if(type==='number'){
        const down=node('button','svg-parts-step stp','−'),up=node('button','svg-parts-step stp','+'),slider=node('input','svg-parts-slider');
        down.type=up.type='button';slider.type='range';slider.min=extras.min;slider.max=extras.max;
        slider.step=name==='fontSize'?'0.01':'0.1';
        slider.setAttribute('aria-label',title+' slider');slider.title=title;control.slider=slider;
        for(const [button,direction] of [[down,-1],[up,1]]){
          editorEditingControls.add(button);
          button.setAttribute('aria-label',(direction<0?'Decrease ':'Increase ')+title);
          button.title=(direction<0?'Decrease ':'Increase ')+title+' · Shift for ×10';
          on(button,'click',event=>{
            if(editorReadOnly())return;
            const text=String(input.value).trim(),number=Number(text);
            if(!text||!Number.isFinite(number)||number<Number(input.min)||number>Number(input.max)){say('Enter a valid '+title+' before stepping.',true);return;}
            const step=(name==='fontSize'?.1:1)*(event.shiftKey?10:1);
            input.value=String(Math.max(Number(input.min),Math.min(Number(input.max),Math.round((number+direction*step)*100)/100)));changed();
          },'editor');
        }
        editorEditingControls.add(slider);
        on(slider,'input',()=>{input.value=slider.value;changed();},'editor');
        on(slider,'change',()=>{input.value=slider.value;changed();},'editor');
        append(wrap,down,up,slider);sync();
      }
      on(input,'input',changed,'editor');on(input,'change',changed,'editor');return input;
    }
    function addFontField(initial) {
      const wrap=node('div','svg-parts-field prow'),search=node('input');search.type='search';
      search.id=inspectorId+'-font-search';search.className='svg-parts-wide wide';
      search.setAttribute('aria-label','Find a font');search.placeholder='Search fonts, style or language';
      search.title='Find an available font. Only the chosen font is loaded for the preview.';
      const label=node('label','','Find font');label.htmlFor=search.id;
      const gutter=node('span','tw');gutter.setAttribute('aria-hidden','true');append(wrap,gutter,label,search);fieldTarget.appendChild(wrap);
      editorEditingControls.add(search);
      const input=addField('fontFamily','Font family','select',[[initial,initial]],{initial});
      const results=node('p','production-note svg-parts-font-results');results.setAttribute('aria-live','polite');fieldTarget.appendChild(results);
      const filter=()=>{
        const query=search.value.trim().toLowerCase(),selected=input.value||initial;
        const matching=fonts.filter(font=>font.toLowerCase().includes(query));
        const service=window.OpenLiveFontAssets;
        const online=service?.search?.(query,{limit:60}) || [];
        const names=[...new Set([...matching.slice(0,60),...online.map(font=>font.name)])].slice(0,60);
        // Browsing never changes the draft. Keep the current family selectable
        // when its name is outside the search, with a bounded result list.
        if(!names.includes(selected))names.unshift(selected);
        input.textContent='';
        for(const family of names){const option=node('option','',family);option.value=family;input.appendChild(option);}
        input.value=selected;
        results.textContent=query?(matching.length>60?'Showing the first 60 name matches. Narrow the search.':matching.length+' name matches.'):
          fonts.length+' font families · search to find more. Online fonts need a connection on first use.';
      };
      on(search,'input',filter,'editor');filter();return input;
    }
    function markPreviewStale(live=false) {
      if(inspectorSelection)return;
      preview.hidden=!(live&&lastPaintedKey===previewKey());cropped.hidden=true;
      previewNote.textContent=live?'Updating live preview…':'Preview is out of date. Refresh the preview to render your changes.';
      publishPreview(live?'updating':'stale',previewNote.textContent);
    }
    function fieldSection(title,help) {
      const section=node('details','svg-parts-section'),summary=node('summary','',title);
      section.open=sectionStates.has(title)?sectionStates.get(title):['Appearance','Transform','Replacement typography','Feed source and fitting','QR destination'].includes(title);
      on(section,'toggle',()=>sectionStates.set(title,section.open),'editor');
      if(help){summary.title=help;summary.setAttribute('aria-description',help);}
      section.appendChild(summary);fieldTarget=node('div','svg-parts-section-fields');section.appendChild(fieldTarget);fields.appendChild(section);
    }
    function editorAction(title,callback) {const item=node('button','production-button svg-parts-section-action',title);item.type='button';fieldTarget.appendChild(item);editorEditingControls.add(item);on(item,'click',()=>{if(!editorReadOnly())return callback();},'editor');return item;}
    function renderEditor(quiet=false) {
      clear('editor');controls.clear();editorEditingControls.clear();fields.textContent='';fieldTarget=fields;imageSummary=null;
      if(!selected){
        emptyPreview.hidden=false;identity.hidden=previewGroup.hidden=editingNotes.hidden=editHint.hidden=true;
        editorWarnings.textContent='';editorTitle.textContent='Clip inspector';editorTitle.title='';
        updateActions();return;
      }
      emptyPreview.hidden=true;editingNotes.hidden=false;identity.hidden=false;previewGroup.hidden=inspectorSelection;editHint.hidden=false;
      editHint.textContent=options.autoSaveLayers&&selected.mode==='layer'?'Scene changes are kept for this session. Cut/Fade publishes the complete scene.':'Edits preview live. Add saves an independent scene copy.';
      const component=selected.component,template=selected.template,style=draft.style||{},change=style.components?.[component.id]||{};
      const displayAsset=library.assets.find(asset=>asset.id===change.imageId)||selected.asset;
      const displayName=displayAsset?.name||(change.imageId?draft.imageName||'Uploaded image':component.label);
      editorTitle.textContent=(selected.mode==='layer'?'Layer inspector · ':selected.asset?'Asset inspector · ':'Template inspector · ')+displayName;
      editorTitle.title=editorTitle.textContent;
      identityName.textContent=displayName;identityName.title=identityName.textContent;
      identityKind.textContent=change.imageId?'Uploaded image'+(displayAsset?' · '+displayAsset.width+' × '+displayAsset.height:''):'Native SVG · '+(component.editableText?'Editable text':component.virtual?'Source area':component.type);
      identityMode.textContent=selected.mode==='layer'?'Scene copy':selected.asset?'Asset':'Template';
      identityMode.title=selected.mode==='layer'?(options.autoSaveLayers?'Editing this scene copy only. Valid edits are kept for this session.':'Editing this scene copy only. Apply saves property edits.'):'Reusable original. Add creates an independent scene copy.';
      identityImage.hidden=!!change.imageId||!!selected.asset||!(component.thumbnail||component.artwork);
      if(!identityImage.hidden)identityImage.src=templates.assetUrl(component.thumbnail||component.artwork);
      identityImage.setAttribute('data-surface',component.thumbnailSurface||'light');
      editorNote.textContent=displayAsset?(library.folders.find(folder=>folder.id===displayAsset.folderId)?.name||'Uploads'):template.name;
      editorNote.title=selected.mode==='layer'?(options.autoSaveLayers?'Editing a scene copy. Valid edits are kept for this session; Cut/Fade updates Programme.':'Editing a scene copy. Changes remain staged until Apply.'):'Add creates a copy of this template piece, not the full page. The original stays unchanged.';
      editingNotes.textContent='';editingNotes.appendChild(node('summary','','Editing notes'));
      editingNotes.appendChild(node('p','production-note',(selected.mode==='layer'?'Changes remain staged until Apply.':'Only this piece will be added, not the full page.')+
        (component.virtual?' This feed area has no decorative artwork; bind a source slot.':'')));
      editorWarnings.textContent='';
      if(component.editableText)editingNotes.appendChild(node('p','production-note','Text keeps the template font size until you change it. Overflowing text scrolls within its original box, or clips at your chosen fixed size. Original lettering and outlines stay intact until you edit wording or typography.'));
      editingNotes.appendChild(node('p','production-note','Use the value, − / + or slider to adjust a parameter. Shift-click steps by ten. Right-click a parameter label to restore its original value. Only controls supported by this SVG piece are shown.'));
      editingNotes.appendChild(originalLink);
      if(component.editableQr)editorWarnings.appendChild(node('p','production-note','Use a short HTTP(S) destination, then phone-scan the QR at its final output size before going live.'));
      if(component.paintedStatus||component.type==='badge'||component.type==='live-badge'||component.id==='live-badge')
        editorWarnings.appendChild(node('p','production-note','This painted LIVE artwork is not an indication that a stream is running.'));
      const thumb=selected.asset?null:component.thumbnail||component.artwork;cropped.hidden=!thumb;if(thumb){cropped.src=templates.assetUrl(thumb);cropped.alt=component.label+' original native reference, not a staged preview';}
      cropped.setAttribute('data-surface',component.thumbnailSurface||'light');preview.setAttribute('data-surface',component.thumbnailSurface||'light');
      preview.hidden=true;
      originalLink.hidden=!!selected.asset||!component.artwork||!!component.virtual;if(!originalLink.hidden)originalLink.href=templates.assetUrl(component.artwork);
      fieldSection('Appearance','Show/Hide and opacity affect only this selected piece. Other enabled preview pieces stay unchanged.');
      addField('visible','Show piece','checkbox',change.visible!==false);
      addField('opacity','Opacity (%)','number',(change.opacity??1)*100,{min:0,max:100,step:'any'});
      if(Number.isInteger(component.frameIndex)){
        fieldSection('Feed source and fitting','Fit keeps the whole source; Fill crops its edges; Stretch changes its proportions. The source and frame transform together.');
        const slots=scene()?.slots||[],values=slots.map((slot,index)=>[String(index),sourceLabel(slot,index)]);
        if(selected.mode==='part')values.unshift(['','New empty source slot']);
        addField('sourceSlot','Feed source slot','select',values,{initial:draft.sourceSlot===undefined?'':String(draft.sourceSlot)});
        addField('feedFit','Feed fitting','select',fits,{initial:change.feedFit||'contain'});
      }
      if(component.editableText){
        fieldSection('Replacement typography','Changes use live text in the chosen font. Restore original lettering to recover the supplied outlines or texture.');
        addField('text','Replacement text','textarea',change.text??component.defaultText??'',{maxLength:500,rows:3,placeholder:'Enter replacement wording; original lettering stays unchanged until you edit.'});
        addField('textColor','Replacement text colour','color',change.textColor||component.defaultTextColor||'#ffffff');
        addField('fontSize','Font size (template units)','number',change.fontSize||Math.min(120,Math.max(4,component.defaultFontSize||32)),{min:4,max:120,step:'0.01'});
        addFontField(change.fontFamily||component.defaultFontFamily||'Arial');
        addField('fontWeight','Font weight','select',[['400','Regular'],['700','Bold']],{initial:change.fontWeight||'700'});
        addField('fontStyle','Font style','select',[['normal','Normal'],['italic','Italic']],{initial:change.fontStyle||'normal'});
        addField('textAlign','Text alignment','select',[['left','Left'],['center','Centre'],['right','Right']],{initial:change.textAlign||'left'});
        addField('overflow','Text overflow','select',[['scroll','Scroll overflowing text'],['clip','Clip at fixed size']],{initial:change.overflow||'scroll'});
        addField('overflowSpeed','Scroll speed (px/s)','number',change.overflowSpeed||80,{min:1,max:600,step:'1'});
        editorAction('Restore template text size',()=>resetFields(['fontSize']));
        editorAction('Restore original lettering',()=>resetFields(textFields));
      }
      if(component.editableQr){
        fieldSection('QR destination','Generate a new local code, or restore the supplied reference QR. Test every changed code with a phone.');
        addField('target','QR destination (HTTP or HTTPS)','url',change.target||'',{maxLength:1024,placeholder:'Original QR until a new destination is entered'});
        editorAction('Restore original QR',()=>resetFields(['target']));
      }
      if(imageEligible(component)) {
        fieldSection(selected.asset?'Image':'Replace '+component.label+' with an image','PNG, JPEG or WebP, up to 10 MB; normalized within 1920 × 1080. Imported images are saved only in this browser profile. Original SVG artwork is preserved.');
        const input=node('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.setAttribute('aria-label','Replacement image file (PNG, JPEG or WebP)');
        editorEditingControls.add(input);
        input.title='Choose a local image. No SVG or remote URL is accepted.';fieldTarget.appendChild(input);
        on(input,'change',()=>importImage(input.files?.[0]),'editor');
        editorAction('Import selected image',()=>importImage(input.files?.[0]));
        imageSummary=node('p','production-note svg-parts-image-summary',change.imageId?'Locally saved replacement: '+(draft.imageName||change.imageId):'Using original SVG artwork. Uploading does not save a scene change.');fieldTarget.appendChild(imageSummary);
        addField('imageFit','Replacement image fitting','select',fits,{initial:change.imageFit||'contain'});
        if(!selected.asset)editorAction('Restore original artwork',()=>resetFields(['imageId','imageFit']));
      }
      fieldSection('Transform','Width and height multiply overall Scale. Offsets use the original board; rotation and flips act around the piece centre.');
      addField('x','Horizontal offset (%)','number',(change.x||0)*100,{min:-200,max:200,step:'any'});
      addField('y','Vertical offset (%)','number',(change.y||0)*100,{min:-200,max:200,step:'any'});
      addField('scale','Scale (%)','number',(change.scale??1)*100,{min:10,max:400,step:'any'});
      addField('scaleX','Width scale (%)','number',(change.scaleX??1)*100,{min:10,max:400,step:'any'});
      addField('scaleY','Height scale (%)','number',(change.scaleY??1)*100,{min:10,max:400,step:'any'});
      addField('rotation','Rotation (degrees)','number',change.rotation||0,{min:-180,max:180,step:'any'});
      addField('flipX','Flip horizontally','checkbox',change.flipX===true);
      addField('flipY','Flip vertically','checkbox',change.flipY===true);
      editorAction('Reset transforms',()=>resetFields(transforms));
      const palette=selected.asset?[]:(template.palette||[]).filter(entry=>!Array.isArray(component.paletteKeys)||component.paletteKeys.includes(entry.key));
      if(palette.length||!selected.asset&&component.type==='background'&&template.backgroundImageIds?.length)
        fieldSection('Original SVG colours','These controls recolour the native artwork, not a replacement image or replacement text.');
      for(const entry of palette)
        addField('palette:'+entry.key,entry.label,'color',style[entry.key]||entry.defaultColor);
      if(!selected.asset&&component.type==='background'&&template.backgroundImageIds?.length)addField('backgroundHue','Backdrop hue (degrees)','number',style.backgroundHue||0,{min:-180,max:180,step:'any'});
      fieldSection('Reset','Restore the selected draft only. Original templates and saved scene copies remain unchanged until Add or Apply.');
      editorAction('Restore all original customization',restoreAll);
      if(draft.cleanForm===undefined)draft.cleanForm=formStamp();
      updateActions();
      if(!quiet)say(options.autoSaveLayers&&selected.mode==='layer'?'Editing a saved scene copy. Valid changes are kept for this session.':'Preview only. The editing scene has not changed.');
      previewSelected(true);
    }
    function resetFields(names) {
      if(editorReadOnly())return;
      stash();cancel();for(const name of names){
        delete draft.raw[name];draft.touched=(draft.touched||[]).filter(item=>item!==name);
        if(name.startsWith('palette:'))delete draft.style[name.slice(8)];
        else if(name==='backgroundHue')delete draft.style.backgroundHue;
        else delete draft.style.components?.[selected.component.id]?.[name];
      }
      if(names.includes('imageId'))delete draft.imageName;
      rememberDraft();renderEditor(true);say('Original artwork restored in the draft. Apply to save the layer.');
      autoSaveLayer();
    }
    function restoreAll() {
      if(!selected||destroyed||editorReadOnly())return;stash();cancel();const sourceSlot=draft.raw.sourceSlot;
      draft.style=assetStyle(selected);draft.raw=sourceSlot===undefined?{}:{sourceSlot};draft.touched=[];delete draft.imageName;
      rememberDraft();renderEditor(true);say('All customization restored in the draft. Source binding is unchanged; Apply to save.');
      autoSaveLayer();
    }
    async function importImage(file) {
      if(destroyed||editorReadOnly())return null;let request;
      try{
        if(!selected||!imageEligible(selected.component))throw new Error('This piece does not support image replacement.');
        requireCurrentScene();
        if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a local PNG, JPEG or WebP image; SVG files and URLs are not accepted.');
        if(!Number.isFinite(file.size)||file.size<=0||file.size>10*1024*1024)throw new Error('Choose an image larger than 0 bytes and no larger than 10 MB.');
        const images=options.images||window.OpenLiveSvgImages;
        if(!images||typeof images.importFile!=='function'||typeof images.load!=='function')throw new Error('Local image storage is unavailable. Your original artwork and draft are unchanged.');
        clearPreviewFrame();stash();const key=selectedKey(),snapshot=sceneStamp(scene()),form=formStamp(),styleStamp=JSON.stringify(draft.style),part=selected;
        request=++serial;busy=true;updateActions();
        const isCurrent=()=>!destroyed&&request===serial&&selectedKey()===key&&sceneStamp(scene())===snapshot&&formStamp()===form&&JSON.stringify(draft.style)===styleStamp;
        const stillCurrent=()=>{const current=isCurrent();if(!current&&!destroyed&&request===serial)say('Imported locally, but the scene or draft changed. No replacement was staged.',true);return current;};
        say('Importing the image into this browser profile…');
        const asset=await images.importFile(file);if(!stillCurrent())return null;
        await images.load(asset.id,{retry:true});if(!stillCurrent())return null;
        const style=clone(draft.style),change={...style.components?.[part.component.id],imageId:asset.id,imageFit:controls.get('imageFit').input.value};
        style.components={[part.component.id]:change};
        const canonical=templates.normalizePartStyle(part.template.id,part.component.id,style);
        draft.style=clone(canonical);draft.imageName=String(asset.name||file.name||asset.id);rememberDraft();
        if(imageSummary)imageSummary.textContent='Locally saved replacement: '+draft.imageName;
        busy=false;updateActions();markPreviewStale(true);
        try{readForm();previewSelected(true);}catch(_){/* Preserve incomplete form fields until the operator fixes them. */}
        say('Imported locally; Apply saves to layer. The original artwork remains available.');autoSaveLayer();return asset;
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    function choose(part,mode,layer,reset=false,inspection=false) {
      if(destroyed)return false;stash();cancel();const value=scene();
      ++editorEpoch;
      inspectorSelection=inspection;
      if(inspection)publishPreview(null);
      selected={...part,mode,...(layer?{layerId:layer.id}:{})};editorSceneId=value?.id||null;
      layerBaseline=layer?JSON.stringify(layer):'';
      const cached=!reset&&drafts.get(selectedKey());
      draft=cached&&(!layer||cached.baseline===layerBaseline)?clone(cached):{style:clone(layer?.style||assetStyle(part)),sourceSlot:layer?.sourceSlot,raw:{},touched:[],baseline:layerBaseline};
      if(mode==='part'){
        const existing=templatePreviews.get(selectedKey()),entry=templateEntry(part,editorSceneId);
        entry.visible=existing?existing.visible:draft.raw.visible!==false;
        draft.raw.visible=entry.visible;
      }
      syncLibraryVisibility();renderLayers();renderEditor();return true;
    }
    function selectPart(templateId,componentId) {const part=parts.find(row=>row.template.id===templateId&&row.component.id===componentId);return !!part&&choose(part,'part');}
    function assetStyle(part){return part?.asset?{components:{[part.component.id]:{imageId:part.asset.id,imageFit:'contain'}}}:{};}
    function selectLayer(id,reset=false) {
      const layer=(scene()?.svgParts||[]).find(part=>part.id===id);if(!layer)return false;
      const part=parts.find(row=>row.template.id===layer.templateId&&row.component.id===layer.componentId);
      if(!part){say('This scene layer refers to an unavailable native SVG piece.',true);return false;}
      if(reset&&options.autoSaveLayers){const key=scene().id+'|'+id;autoPending.delete(key);autoErrors.delete(key);}
      const result=choose(part,'layer',layer,reset);if(options.autoSaveLayers)reportAutoSave();if(result)options.onLayerSelect?.(id,scene()?.id);return result;
    }
    function reconcileInspectorLayer() {
      const layer=currentLayer();if(!layer||!selected||editorSceneId!==scene()?.id)return false;
      if(JSON.stringify(layer)===layerBaseline)return false;
      const key=editorSceneId+'|'+selected.layerId;
      // Pending saves already capture their scene and form. A newer typed value
      // must retain its DOM/caret while those saves finish, even across refreshes.
      if(autoPending.has(key)||autoErrors.has(key)||formStamp()!==draft?.cleanForm){
        say('The selected layer changed. Your staged draft is retained; reload its saved state before applying.',true);return false;
      }
      const part=parts.find(row=>row.template.id===layer.templateId&&row.component.id===layer.componentId);
      return !!part&&choose(part,'layer',layer,true,true);
    }
    function inspectLayer(id,reset=false) {
      const value=scene(),layer=(value?.svgParts||[]).find(part=>part.id===id);
      if(destroyed||!value?.id||!studio.scenes().includes(value)||!layer)return false;
      const part=parts.find(row=>row.template.id===layer.templateId&&row.component.id===layer.componentId);
      if(!part){say('This scene layer refers to an unavailable native SVG piece.',true);return false;}
      if(reset&&options.autoSaveLayers){const key=value.id+'|'+id;autoPending.delete(key);autoErrors.delete(key);}
      if(!reset&&selected?.mode==='layer'&&editorSceneId===value.id&&selected.layerId===id){
        if(!inspectorSelection){cancel({quiet:true});inspectorSelection=true;publishPreview(null);previewGroup.hidden=true;}
        reconcileInspectorLayer();updateActions();return true;
      }
      const result=choose(part,'layer',layer,reset,true);if(options.autoSaveLayers)reportAutoSave();return result;
    }
    function clearInspector() {
      if(destroyed)return false;
      stash();cancel({quiet:true});++editorEpoch;selected=null;draft=null;editorSceneId=null;layerBaseline='';inspectorSelection=true;
      publishPreview(null);renderEditor();say('Select a layer to inspect.');return true;
    }
    function setInspectorTarget(host=null) {
      if(destroyed)return false;
      if(host&&typeof host.appendChild!=='function')throw new Error('Choose a valid layer inspector target.');
      if(host===editor||host===status||editor.contains?.(host))throw new Error('The inspector target cannot be inside its editor.');
      if(host===inspectorTarget)return true;
      inspectorTarget=host;append(host||root,editor,status);append(host?actions:stackActions,undoButton,redoButton);
      if(!host&&layerListDirty)renderLayers();updateActions();return true;
    }
    function selectCategory(id, {allPages=false,showPieces=false} = {}) {
      const aliases={background:'backgrounds',frame:'feeds','feed-frame':'feeds','lower-third':'lower-thirds',logo:'logos',headline:'headlines','live-badge':'live-badges',badge:'live-badges',texts:'text'};
      id=aliases[id]||id;if(!categories.some(row=>row[0]===id)||destroyed)return false;category=id;
      if(allPages){page='';pageSelect.value='';}
      if(showPieces){folders.hidden=true;folderToggle.setAttribute('aria-expanded','false');}
      renderGrid();return true;
    }
    function prepareTemplatePreview(entry,retry=false) {
      const {template,component}=entry.part,style=clone(entry.style),stamp=JSON.stringify(style);
      const status=templates.partStatus?.(template.id,component.id,style);
      if(status?.state==='ready')entry.asset={stamp,style,ready:true};
      else if(status&&entry.asset?.ready)entry.asset=null; // The renderer may have evicted an older decoded asset.
      if(entry.asset?.stamp===stamp&&!(retry&&entry.asset.error))return entry.asset;
      const asset={stamp,style,ready:false,error:null};entry.asset=asset;
      asset.promise=Promise.resolve(templates.loadPart(template.id,component.id,{style,retry:true}))
        .then(()=>{asset.ready=true;},error=>{asset.error=error;});
      return asset;
    }
    async function previewTemplates(request,quiet) {
      requireCurrentScene();
      let formError=null;
      const entry=templateEntry(selected,editorSceneId),form=formStamp();
      entry.visible=!!controls.get('visible').input.checked;
      try{const value=readForm();entry.style=value.style;entry.sourceSlot=value.sourceSlot;entry.formError=null;}catch(error){formError=error;entry.formError=error.message;}
      syncLibraryVisibility();
      const key=previewKey(),entries=previewEntries(),assets=entries.map(item=>prepareTemplatePreview(item,!quiet));
      const current=()=>!destroyed&&request===serial&&previewKey()===key&&scene()?.id===editorSceneId&&formStamp()===form;
      const paint=()=>{
        if(!current())return;
        const renderable=entries.map((item,index)=>({item,style:assets[index].ready?assets[index].style:item.lastGood})).filter(row=>row.style);
        const signature=JSON.stringify(renderable.map(row=>[row.item.key,row.style]));
        // Keep the last valid composite during loading; hiding is immediate,
        // including the final eye (an intentionally empty transparent canvas).
        if(lastPaintedKey===key&&lastCompositeSignature===signature)return;
        if(!renderable.length&&entries.length&&!lastPaintedKey)return;
        const context=previewCanvas.getContext('2d');context.clearRect(0,0,previewCanvas.width,previewCanvas.height);
        try{
          for(const row of renderable){
            const {template,component}=row.item.part;
            const result=templates.drawPart(template.id,component.id,context,previewCanvas,row.style);
            if(!result||result.state!=='drawn')throw new Error(result?.error||'This native piece could not be previewed.');
          }
        }catch(error){
          if(previewCanvas!==preview&&lastPaintedKey===key){context.clearRect(0,0,previewCanvas.width,previewCanvas.height);context.drawImage(preview,0,0,previewCanvas.width,previewCanvas.height);}
          else lastPaintedKey='';
          throw error;
        }
        for(const row of renderable)row.item.lastGood=clone(row.style);
        if(previewCanvas!==preview){const small=preview.getContext('2d');small.clearRect(0,0,preview.width,preview.height);small.drawImage(previewCanvas,0,0,preview.width,preview.height);}
        lastPaintedKey=key;lastCompositeSignature=signature;preview.hidden=false;cropped.hidden=true;
      };
      const report=()=>{
        if(!current())return;
        paint();
        const error=formError||assets.find(asset=>asset.error)?.error;
        if(error){
          previewNote.textContent=(lastPaintedKey===key?'Last valid preview · ':'Preview unavailable · ')+(error.message||String(error));
          publishPreview('error',previewNote.textContent);say(error.message||String(error),true);return;
        }
        const loading=assets.some(asset=>!asset.ready);
        previewNote.textContent=loading?'Updating live preview…':entries.length+' template piece'+(entries.length===1?'':'s')+' in preview · Add mix saves all shown pieces.';
        preview.setAttribute('aria-label','Combined template preview');
        // Only previewSelected's initial loading event claims the monitor.
        // Late progress must not reopen it after "Scene preview" was chosen.
        publishPreview(loading?'updating':'ready',previewNote.textContent,loading?null:previewCanvas);
        if(!loading)say('Live preview updated. No scene layers changed.');
      };
      report();
      const pending=assets.filter(asset=>asset.promise&&!asset.ready&&!asset.error);
      if(pending.length)await Promise.all(pending.map(asset=>asset.promise.then(report)));
      return current()?{state:'drawn'}:null;
    }
    async function previewSelected(quiet=false) {
      if(!selected||destroyed||inspectorSelection)return null;clearPreviewFrame();const request=++serial;busy=false;updateActions();
      preview.hidden=lastPaintedKey!==previewKey();
      previewNote.textContent='Updating live preview…';
      publishPreview('loading',preview.hidden?'Loading piece preview…':'Updating live preview…');
      try{
        if(selected.mode==='part')return await previewTemplates(request,quiet);
        const value=readForm(),key=selectedKey(),part=selected;
        if(typeof templates.loadPart!=='function'||typeof templates.drawPart!=='function')throw new Error('The independent SVG part renderer is unavailable.');
        if(!quiet)say('Loading this native piece preview…');
        // Pose/opacity/visibility use the decoded asset immediately. Text,
        // palette and newly selected artwork load only when their cache is cold.
        if(templates.partStatus?.(part.template.id,part.component.id,value.style)?.state!=='ready')
          await templates.loadPart(part.template.id,part.component.id,{style:value.style,retry:true});
        if(destroyed||request!==serial||key!==selectedKey())return null;
        if(JSON.stringify(value)!==JSON.stringify(readForm())){markPreviewStale();return null;}
        const context=previewCanvas.getContext('2d');context.clearRect(0,0,previewCanvas.width,previewCanvas.height);
        let result;
        try{
          result=templates.drawPart(part.template.id,part.component.id,context,previewCanvas,value.style);
          if(!result||result.state!=='drawn')throw new Error(result?.error||'This native piece could not be previewed.');
        }catch(error){
          // The inspector still holds the last valid frame if drawing fails.
          if(previewCanvas!==preview&&lastPaintedKey===key){context.clearRect(0,0,previewCanvas.width,previewCanvas.height);context.drawImage(preview,0,0,previewCanvas.width,previewCanvas.height);}
          else lastPaintedKey='';
          throw error;
        }
        if(previewCanvas!==preview){const small=preview.getContext('2d');small.clearRect(0,0,preview.width,preview.height);small.drawImage(previewCanvas,0,0,preview.width,preview.height);}
        const automatic=options.autoSaveLayers&&selected.mode==='layer';
        lastPaintedKey=key;preview.hidden=false;cropped.hidden=true;previewNote.textContent=automatic?'Scene copy · valid edits are kept for this session. Cut/Fade updates Programme.':'Live preview · changes are not saved until Add or Apply.';
        publishPreview('ready',previewNote.textContent,previewCanvas);
        if(!automatic)say(quiet?'Live preview updated. No scene layers changed.':'Preview only. No scene layers changed.');
        return result;
      }catch(error){if(!destroyed&&request===serial){previewNote.textContent=(lastPaintedKey===previewKey()?'Last valid preview · ':'Preview unavailable · ')+(error.message||String(error));publishPreview('error',previewNote.textContent);say(error.message||String(error),true);}return null;}
    }
    function notify(result,action,sceneId=scene()?.id) {
      try{if(typeof options.onChanged==='function')options.onChanged(result,{action,sceneId});}
      catch(error){say('Saved, but the view could not refresh: '+(error.message||String(error)),true);}
      if(options.autoSaveLayers)reportAutoSave();
    }
    function mixStamp(){return JSON.stringify(previewEntries().map(entry=>[entry.key,entry.style,entry.sourceSlot,entry.formError]));}
    async function saveMix(){
      if(destroyed||busy)return null;let request;
      try{
        const value=requireCurrentScene();stash();const allEntries=previewEntries(),entries=allEntries.filter(entry=>!nativeSceneCopy(entry.part,value));
        if(allEntries.length&&!entries.length)return selectNativeCopy(allEntries[0].part,value);
        if(!entries.length)throw new Error('Show at least one piece with its preview eye.');
        const invalid=entries.find(entry=>entry.formError);if(invalid)throw new Error(invalid.part.component.label+': '+invalid.formError);
        if(typeof studio.addSceneSvgParts!=='function')throw new Error('Adding a preview mix is unavailable.');
        clearPreviewFrame();const snapshot=sceneStamp(value),form=formStamp(),mix=mixStamp();request=++serial;busy=true;updateActions();
        const isCurrent=()=>!destroyed&&request===serial&&scene()===value&&sceneStamp(value)===snapshot&&formStamp()===form&&mixStamp()===mix;
        const items=entries.map(entry=>({templateId:entry.part.template.id,componentId:entry.part.component.id,style:clone(entry.style),...(entry.sourceSlot===undefined?{}:{sourceSlot:entry.sourceSlot})}));
        say('Preparing '+items.length+' pieces as one scene mix…');
        const result=await studio.addSceneSvgParts(value.id,items,{isCurrent});
        if(!result)throw new Error('The mix could not be saved. The previous scene has not changed.');
        if(destroyed||request!==serial)return result;
        busy=false;
        if(value.layout==='free'&&result.at(-1)?.id)selectLayer(result.at(-1).id,true);else renderLayers();
        say('Added '+items.length+' independent copies. Original templates and Programme are unchanged.');notify(result,'add-mix');return result;
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    async function importContent(files,owner={value:scene(),stamp:sceneStamp(scene())}){
      if(destroyed||busy)return null;let request;
      try{
        if(files.length!==1)throw new Error('Add one image at a time: PNG, JPEG or WebP.');
        const file=files[0];if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type)||!Number.isFinite(file.size)||file.size<=0||file.size>10*1024*1024)
          throw new Error('Choose one PNG, JPEG or WebP image up to 10 MiB. SVG, video and URLs are not accepted here.');
        if(!owner.value?.id||scene()!==owner.value||sceneStamp(scene())!==owner.stamp)throw new Error('The editing scene changed. Choose the image again for this scene.');
        if(owner.value.layoutPending)throw new Error('Choose this scene’s layout before adding artwork.');
        const images=options.images||window.OpenLiveSvgImages,part=parts.find(p=>p.component.type==='background'&&imageEligible(p.component));
        if(!images?.importFile||!part)throw new Error('Local artwork imports are unavailable.');
        clearPreviewFrame();stash();const form=formStamp();request=++serial;busy=true;updateActions();
        const isCurrent=()=>!destroyed&&request===serial&&scene()===owner.value&&sceneStamp(scene())===owner.stamp&&formStamp()===form;
        say('Importing artwork for '+label()+'…');const asset=await images.importFile(file);
        if(!isCurrent()){if(!destroyed&&request===serial)say('Scene or selection changed. The image was kept for this session but no layer was added.',true);return null;}
        const style={components:{[part.component.id]:{imageId:asset.id,imageFit:'contain'}}};
        const result=await studio.addSceneSvgPart(owner.value.id,part.template.id,part.component.id,style,{isCurrent});
        if(!result)throw new Error('The image layer could not be saved.');
        if(destroyed||request!==serial)return result;
        busy=false;if(owner.value.layout==='free'&&result.id)selectLayer(result.id,true);else renderLayers();
        say('Added '+(asset.name||file.name)+' as an independent image layer. Programme is unchanged.');notify(result,'add-image');return result;
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    async function receiveDrop(event,previewOnly){
      event.preventDefault();event.stopPropagation();dropZone.classList.toggle('drag-over',false);options.previewDropTarget?.classList.toggle('svg-parts-preview-drop',false);
      if(destroyed||busy)return null;
      const transfer=event.dataTransfer,files=Array.from(transfer?.files||[]);
      if(files.length){if(previewOnly){say('Drop image files on “Add assets to editing scene”, or use Upload & add.',true);return null;}return importContent(files);}
      try{
        const raw=transfer?.getData(dragType);if(!raw||raw.length>2048)throw new Error('Drag a piece from this template library.');
        const data=JSON.parse(raw);
        if(data.owner!==inspectorId||data.sceneId!==scene()?.id)throw new Error('The drag belongs to another scene or library. Drag the piece again.');
        const asset=data.imageId&&library.assets.find(asset=>asset.id===data.imageId);
        const part=asset?imagePart(asset):parts.find(p=>p.template.id===data.templateId&&p.component.id===data.componentId);
        if(!part)throw new Error('This template piece is unavailable.');
        selectLibraryPart(part);
        controls.get('visible').input.checked=true;stash();
        if(previewOnly){cancel({quiet:true});markPreviewStale(true);queuePreview();syncLibraryVisibility();say(asset?'Image preview only. Drag to the scene drop area to add a copy.':'Added to the preview mix only. Other eyes are unchanged.');return true;}
        return saveSelected(false);
      }catch(error){say(error.message||String(error),true);return null;}
    }
    async function saveSelected(edit,keepTemplatePreview=false) {
      if(destroyed||busy||editorReadOnly())return null;let request;
      try{
        if(edit&&options.autoSaveLayers){await flushAutoSave();return currentLayer();}
        clearPreviewFrame();
        const value=readForm(),targetScene=requireCurrentScene(),key=selectedKey(),part=selected;
        if(!edit&&nativeSceneCopy(part,targetScene))return selectNativeCopy(part,targetScene);
        const sourceMix=!edit&&targetScene.layout==='free';
        // Audition visibility is not the visibility of a newly added source layer.
        const savedStyle=clone(value.style);
        if(sourceMix){
          keepTemplatePreview=false;
          savedStyle.components={...savedStyle.components,[part.component.id]:{...savedStyle.components?.[part.component.id],visible:true}};
        }
        if(edit&&(!currentLayer()||JSON.stringify(currentLayer())!==layerBaseline))throw new Error('This layer changed outside the editor. Reload the saved layer before applying.');
        const snapshot=sceneStamp(targetScene),valueStamp=JSON.stringify(value);request=++serial;busy=true;updateActions();
        const isCurrent=()=>{try{return !destroyed&&request===serial&&key===selectedKey()&&sceneStamp(scene())===snapshot&&JSON.stringify(readForm())===valueStamp;}catch(_){return false;}};
        say(edit?'Preparing staged layer edits…':'Preparing this independent piece…');
        await templates.loadPart(part.template.id,part.component.id,{style:savedStyle,retry:true});
        if(!isCurrent()){if(request===serial)say('The scene or staged edit changed. Nothing was applied.',true);return null;}
        const method=edit?'updateSceneSvgPart':'addSceneSvgPart';if(typeof studio[method]!=='function')throw new Error('Independent scene-layer editing is unavailable.');
        const result=edit?await studio[method](targetScene.id,part.layerId,value,{isCurrent}):
          await studio[method](targetScene.id,part.template.id,part.component.id,savedStyle,{...(value.sourceSlot!==undefined?{sourceSlot:value.sourceSlot}:{}),isCurrent});
        if(!result)throw new Error('The piece could not be saved. The previous scene has not changed.');
        if(destroyed||request!==serial)return result;
        busy=false;if(keepTemplatePreview)renderLayers();else if(result.id)selectLayer(result.id,true);else renderLayers();
        // Selecting the saved copy stashes the previous editor. Clear that
        // consumed template draft afterwards so the next use starts original.
        if(!keepTemplatePreview){drafts.delete(key);if(!edit)templatePreviews.delete(key);}syncLibraryVisibility();
        if(keepTemplatePreview)queuePreview();
        say(edit?'Saved the staged layer edits.':'Added one independent piece to the editing scene.');notify(result,edit?'update':'add');return result;
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    async function toggleLayerVisibility(layerId,visible) {
      if(destroyed||busy)return null;
      const value=scene(),part=(value?.svgParts||[]).find(item=>item.id===layerId),template=part&&catalog.find(item=>item.id===part.templateId),component=template?.components?.find(item=>item.id===part.componentId);
      if(!value?.id||!part||!component){say('This SVG layer is no longer available. Refresh the scene and try again.',true);return null;}
      if(typeof studio.updateSceneSvgPart!=='function'){say('Saving SVG layer visibility is unavailable.',true);return null;}
      clearPreviewFrame();stash();const key=selectedKey(),snapshot=sceneStamp(value),form=formStamp(),style=clone(part.style||{});
      style.components={...(style.components||{}),[part.componentId]:{...(style.components?.[part.componentId]||{}),visible:!!visible}};
      const request=++serial;busy=true;updateActions();say((visible?'Showing ':'Hiding ')+(component.label||part.componentId)+' in editing scene…');
      try{
        const result=await studio.updateSceneSvgPart(value.id,layerId,{style},{isCurrent:()=>!destroyed&&request===serial&&scene()===value&&sceneStamp(value)===snapshot&&selectedKey()===key&&formStamp()===form});
        if(!result||result.id!==layerId)throw new Error('The layer visibility could not be saved. The previous scene has not changed.');
        if(destroyed||request!==serial)return result;
        if(selected?.mode==='layer'&&selected.layerId===layerId){
          // A quick eye action commits visibility, not other staged edits.
          draft.style.components={...(draft.style.components||{}),[part.componentId]:{...(draft.style.components?.[part.componentId]||{}),visible:!!visible}};
          draft.raw.visible=!!visible;layerBaseline=JSON.stringify(result);draft.baseline=layerBaseline;rememberDraft();
          const field=controls.get('visible')?.input;if(field)field.checked=!!visible;
          queuePreview();
        }
        renderLayers();say((visible?'Shown ':'Hidden ')+(component.label||part.componentId)+' '+(visible?'in':'from')+' editing scene. Sources and audio were not changed.');notify(result,'visibility');return result;
      }catch(error){if(!destroyed&&request===serial)say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    function removeSceneLayer(layerId,owner=scene()) {
      if(destroyed||busy||inspectionEditingBlocked())return null;
      try{
        if(!owner?.id||scene()!==owner)throw new Error('The editing scene changed. Use the delete icon on the current scene layer.');
        const part=(owner.svgParts||[]).find(item=>item.id===layerId);
        if(!part)throw new Error('This scene layer no longer exists.');
        stash();
        const result=studio.removeSceneSvgPart(owner.id,part.id);
        if(!result)throw new Error('The layer could not be removed. The previous scene has not changed.');
        if(selected?.mode==='layer'&&editorSceneId===owner.id&&selected.layerId===part.id){
          cancel({quiet:true});publishPreview(null);selected=null;draft=null;layerBaseline='';lastPaintedKey='';renderEditor();
        }
        renderLayers();notify(result,'remove');
        say('Removed one scene copy. Undo layer change restores it; the original template, other copies and sources are unchanged.');
        return result;
      }catch(error){say(error.message||String(error),true);return null;}
    }
    async function changeStack(action) {
      if(destroyed||busy||editorReadOnly())return null;try{
        const value=requireCurrentScene(),part=currentLayer();if(!part)throw new Error('Select a saved scene layer first.');
        if(action==='remove')return removeSceneLayer(part.id,value);
        stash();cancel();let result;
        {const ids=(value.svgParts||[]).map(item=>item.id),index=ids.indexOf(part.id),next=index+(action==='back'?-1:1);
          if(next<0||next>=ids.length)return null;[ids[index],ids[next]]=[ids[next],ids[index]];result=studio.reorderSceneSvgParts(value.id,ids);}
        if(!result)throw new Error('The layer change could not be saved. The previous scene has not changed.');
        renderLayers();say(action==='remove'?'Removed the selected SVG layer.':'Saved the SVG layer order.');notify(result,action);return result;
      }catch(error){say(error.message||String(error),true);return null;}
    }
    async function historyAction(action) {
      if(destroyed||inspectionEditingBlocked())return null;let request;
      try{
        const value=scene();if(!value?.id)throw new Error('Choose an editing scene first.');
        clearPreviewFrame();stash();request=++serial;busy=true;updateActions();const snapshot=sceneStamp(value),form=formStamp();
        const inspection=!!inspectorTarget&&inspectorSelection;
        const isCurrent=()=>!destroyed&&request===serial&&sceneStamp(scene())===snapshot&&formStamp()===form&&(!inspection||inspectionEditAllowed());
        const method={split:'splitSceneTemplate',undo:'undoSceneSvgParts',redo:'redoSceneSvgParts'}[action];
        if(typeof studio[method]!=='function')throw new Error('This scene-layer action is unavailable.');
        say(action==='split'?'Preparing the current template as independent layers…':'Preparing saved layer history…');
        const result=await studio[method](value.id,{isCurrent});
        if(!result)throw new Error('The layer change could not be saved. The previous scene has not changed.');
        if(destroyed||request!==serial)return result;
        renderLayers();say(action==='split'?'The current template is now independent scene layers.':action==='undo'?'Undid the saved layer change.':'Redid the saved layer change.');notify(result,action);return result;
      }catch(error){if(!destroyed&&(request===undefined||request===serial))say(error.message||String(error),true);return null;}
      finally{if(request===serial){busy=false;updateActions();}}
    }
    function refresh() {
      if(destroyed)return;const id=scene()?.id||null;
      if(id!==lastSceneId){cancel();publishPreview(null);lastSceneId=id;if(selected&&id!==editorSceneId){if(inspectorSelection)clearInspector();else say('Editing scene changed. Your staged draft is retained; select a piece or layer for this scene.',true);}}
      renderLayers();
      if(inspectorSelection&&selected?.mode==='layer'&&editorSceneId===id){
        if(!studio.scenes().includes(scene())||!currentLayer()){clearInspector();return;}
        reconcileInspectorLayer();updateActions();return;
      }
      if(selected?.mode==='layer'&&editorSceneId===id&&JSON.stringify(currentLayer())!==layerBaseline)
        say('The selected layer changed. Your staged draft is retained; reload its saved state before applying.',true);
    }
    function capturePreview() {
      if (destroyed || busy || publishedPreviewState !== 'ready' || !selected || scene()?.id !== editorSceneId || formStamp()!==readyPreviewStamp)
        throw new Error('Wait for a valid, fully rendered Preview before pressing Cut/Fade.');
      const request=serial,owner=scene(),form=formStamp(),mix=mixStamp(),key=selectedKey();
      const rows=selected.mode==='part' ? previewEntries().map(entry=>{
        if(entry.formError)throw new Error(entry.formError);
        return {templateId:entry.part.template.id,componentId:entry.part.component.id,style:clone(entry.style)};
      }) : [{templateId:selected.template.id,componentId:selected.component.id,style:readForm().style}];
      // This monitor auditions artwork, not bound source slots. Take precisely
      // that composition; Scene preview is the source-backed scene surface.
      return {parts:rows,sceneId:editorSceneId,isCurrent:()=>!destroyed&&!busy&&request===serial&&scene()===owner&&
        publishedPreviewState==='ready'&&formStamp()===form&&mixStamp()===mix&&selectedKey()===key};
    }
    const api={refresh,openFolders,selectPart,selectLayer,inspectLayer,clearInspector,setInspectorTarget,selectCategory,cancel,capturePreview,isBusy:()=>busy,
      flushAutoSave,isSaving:()=>!!autoTail||autoPending.size>0,hasUnsaved:()=>autoErrors.size>0||!!autoTail||autoPending.size>0,
      getSelection:()=>{
        if(!selected)return null;const currentDraft=clone(draft);
        currentDraft.raw={};for(const [name,field] of controls)currentDraft.raw[name]=field.input.type==='checkbox'?field.input.checked:field.input.value;
        return {mode:selected.mode,templateId:selected.template.id,componentId:selected.component.id,layerId:selected.layerId,sceneId:editorSceneId,draft:currentDraft};
      },
      destroy(){if(destroyed)return;closeLayerMenu();clearPreviewFrame();publishPreview(null);destroyed=true;serial++;Object.keys(disposers).forEach(clear);controls.clear();editorEditingControls.clear();drafts.clear();draftEpochs.clear();templatePreviews.clear();sectionStates.clear();editor.remove();status.remove();root.remove();if(mounts.get(target)===api)mounts.delete(target);}};
    mounts.set(target,api);lastSceneId=scene()?.id||null;renderGrid();renderLayers();say('Choose an independent piece to preview.');if(managedFolders)void refreshLibrary();return api;
  }
  return Object.freeze({mount,alignmentStyle});
})();
