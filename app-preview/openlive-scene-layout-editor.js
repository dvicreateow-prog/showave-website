/* Scene-owned arrangement drafts. Pixels come from the Studio compositor;
   guides and editing controls remain outside the captured video surface. */
window.OpenLiveSceneLayoutEditor=(()=>{
  'use strict';
  let mounts=0;
  const fields=['x','y','w','h'],labels={x:'X (%)',y:'Y (%)',w:'Width (%)',h:'Height (%)'};
  function appearance(raw={}){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose valid zone appearance.');
    const opacity=raw.opacity===undefined?1:raw.opacity,radius=raw.radius===undefined?0:raw.radius,stroke=raw.stroke===undefined?{}:raw.stroke;
    if(typeof opacity!=='number'||!Number.isFinite(opacity)||opacity<0||opacity>1||typeof radius!=='number'||!Number.isFinite(radius)||radius<0||radius>.5||!stroke||typeof stroke!=='object'||Array.isArray(stroke))throw Error('Choose valid zone opacity and corner rounding.');
    const width=stroke.width===undefined?0:stroke.width,color=stroke.color===undefined?'#ffffff':stroke.color,style=stroke.style===undefined?'solid':stroke.style;
    if(typeof width!=='number'||!Number.isFinite(width)||width<0||width>64||typeof color!=='string'||!/^#[\da-f]{6}$/i.test(color)||!['solid','dashed','dotted'].includes(style))throw Error('Choose valid stroke weight, colour and style.');
    return {opacity,radius,stroke:{width,color,style}};
  }
  const mergeAppearance=(previous,patch)=>appearance({...appearance(previous),...patch,stroke:{...appearance(previous).stroke,...patch.stroke}});
  function geometry(value){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Choose valid layout geometry.');
    const result={};
    for(const key of [...fields,'rotation']){
      const number=value[key]===undefined&&key==='rotation'?0:value[key];
      if(typeof number!=='number'||!Number.isFinite(number)||Math.abs(number)>(key==='rotation'?36000:10)||(['w','h'].includes(key)&&number<.01))throw Error('Choose valid layout geometry.');
      result[key]=key==='rotation'?((number%360)+360)%360:number;
    }
    return result;
  }
  function savedLayout(value){
    if(!value||typeof value!=='object'||typeof value.id!=='string'||!/^layout-[\w-]{1,80}$/.test(value.id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>60||/[\u0000-\u001f]/.test(value.name)||!Array.isArray(value.rectangles)||!value.rectangles.length||value.rectangles.length>32)throw Error('A saved layout is invalid.');
    // Project reusable geometry/appearance only: no scene, source, device or asset IDs.
    const rectangles=value.rectangles.map(raw=>({...geometry(raw),...(Object.prototype.hasOwnProperty.call(raw,'appearance')?{appearance:appearance(raw.appearance)}:{})}));
    if(rectangles.some(r=>r.x<0||r.y<0||r.w>1||r.h>1||r.x+r.w>1.0000001||r.y+r.h>1.0000001))throw Error('Saved layout zones must fit within the canvas.');
    return {id:value.id,name:value.name.trim(),rectangles};
  }
  function mount({studio,getScene,document:doc=document,root=doc.body,onApplied,onClose,onArtwork,storageKey='showave.scene-layouts.v1',storage}={}){
    const id='scene-arrangement-'+(++mounts),dialog=doc.createElement('dialog');
    dialog.className='bc-arrange-dialog';dialog.setAttribute('aria-labelledby',id+'-title');
    const make=(tag,className,text,parent)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;if(parent)parent.appendChild(node);return node;};
    const button=(text,parent,action,className='')=>{const node=make('button',className,text,parent);node.type='button';if(action)node.addEventListener('click',action);return node;};
    const header=make('header','bc-arrange-head',undefined,dialog),title=make('h2','', 'Arrange scene',header);title.id=id+'-title';
    const heading=make('div','bc-arrange-heading',undefined,header),sceneName=make('strong','',undefined,heading),dirtyLabel=make('span','bc-arrange-dirty',undefined,heading);
    const closeButton=button('×',header,()=>close());closeButton.setAttribute('aria-label','Close Arrange scene');
    const intro=make('p','bc-arrange-intro','Arrange sources around your artwork. Apply saves this draft to Preview; Cut/Fade publishes it to Programme. Apply a layout, then use Add Source to fill its empty zones.',dialog);
    const body=make('div','bc-arrange-body',undefined,dialog),library=make('section','bc-arrange-library',undefined,body);
    make('h3','','Layouts',library);
    const filter=make('select','bc-arrange-filter',undefined,library);filter.setAttribute('aria-label','Filter scene layouts');
    for(const [value,label] of [['all','All layouts'],['simple','Simple'],['pip','Picture in picture'],['panel','Panels']]){const option=make('option','',label,filter);option.value=value;}
    const presets=make('div','bc-arrange-presets',undefined,library);presets.setAttribute('aria-label','Built-in source layouts');
    make('h3','','My layouts',library);const favorites=make('div','bc-arrange-favorites',undefined,library);
    const favoriteNameLabel=make('label','bc-arrange-save-name','Layout name',library),favoriteName=make('input','',undefined,favoriteNameLabel);favoriteName.type='text';favoriteName.maxLength=60;favoriteName.placeholder='My preferred layout';favoriteName.setAttribute('aria-label','Scene layout name');
    const saveButton=button('Save layout',library,()=>saveFavorite(),'bc-arrange-save');
    const center=make('section','bc-arrange-center',undefined,body),previewHead=make('div','bc-arrange-preview-head',undefined,center);
    const previewLabel=make('strong','','Draft · 1920 × 1080',previewHead);make('span','','Live scene pixels',previewHead);
    const stage=make('div','bc-arrange-stage',undefined,center),canvas=make('canvas','',undefined,stage);canvas.width=1920;canvas.height=1080;canvas.setAttribute('aria-label','Live scene layout draft');
    const guides=make('div','bc-arrange-guides',undefined,stage);guides.setAttribute('aria-label','Source zones');
    const hint=make('p','bc-arrange-hint','Drag a zone to move it; drag its corner to resize. Arrow keys move; Alt + arrow keys resize. Shift uses larger steps.',center);
    const sources=make('div','bc-arrange-source-chips',undefined,center);sources.setAttribute('aria-label','Scene source placements');
    const report=make('p','bc-arrange-report',undefined,center);
    const inspector=make('section','bc-arrange-inspector',undefined,body);make('h3','','Selected zone',inspector);
    const selectedLabel=make('strong','bc-arrange-selected',undefined,inspector),assignmentLabel=make('label','bc-arrange-assignment','Source for this zone',inspector),assignment=make('select','',undefined,assignmentLabel);assignment.setAttribute('aria-label','Source for selected zone');
    const swapHint=make('p','bc-arrange-hint','Choosing a source swaps its position with this zone. Source audio and settings travel with the source.',inspector);
    const numbers=make('div','bc-arrange-numbers',undefined,inspector),inputs={};
    for(const key of fields){const label=make('label','',labels[key],numbers),input=make('input','',undefined,label);input.type='number';input.step='0.1';input.min=['w','h'].includes(key)?'1':'0';input.max='100';input.setAttribute('aria-label',labels[key]);input.addEventListener('change',()=>setNumber(key,input.value));inputs[key]=input;}
    const appearanceGroup=make('fieldset','bc-arrange-appearance',undefined,inspector);make('legend','','Appearance',appearanceGroup);
    const appearanceInputs={},appearanceRanges={},appearanceErrors=new Map();
    const paired=(key,label,min,max)=>{const wrap=make('label','bc-arrange-appearance-pair',undefined,appearanceGroup);make('span','',label,wrap);
      const input=make('input','',undefined,wrap);input.type='number';input.min=String(min);input.max=String(max);input.step='1';input.setAttribute('aria-label',label);for(const event of ['input','change'])input.addEventListener(event,()=>setAppearanceValue(key,input.value,input));appearanceInputs[key]=input;
      const slider=make('input','',undefined,wrap);slider.type='range';slider.min=String(min);slider.max=String(max);slider.step='1';slider.setAttribute('aria-label',label+' slider');slider.addEventListener('input',()=>setAppearanceValue(key,slider.value,slider));appearanceRanges[key]=slider;
      for(const control of [input,slider])control.addEventListener('contextmenu',event=>{event.preventDefault();setAppearanceValue(key,key==='opacity'?100:0,control);});
    };
    const strokeOptions=make('div','bc-arrange-stroke-options',undefined,appearanceGroup);
    for(const [key,label,type] of [['style','Stroke style','select'],['color','Stroke colour','color']]){const wrap=make('label','',label,strokeOptions),control=make(type==='select'?'select':'input','',undefined,wrap);control.setAttribute('aria-label',label);if(type==='color')control.type='color';else for(const style of ['solid','dashed','dotted']){const option=make('option','',style[0].toUpperCase()+style.slice(1),control);option.value=style;}
      appearanceInputs[key]=control;control.addEventListener('change',()=>setAppearanceValue(key,control.value,control));control.addEventListener('contextmenu',event=>{event.preventDefault();setAppearanceValue(key,key==='color'?'#ffffff':'solid',control);});}
    paired('width','Stroke weight (HD px)',0,64);paired('radius','Corner rounding (%)',0,50);paired('opacity','Opacity (%)',0,100);paired('transparency','Transparency (%)',0,100);
    const appearanceHint=make('p','bc-arrange-hint','Stroke weight 0 removes the frame. Transparency: 0% opaque · 100% invisible. Audio is unchanged. Right-click a parameter to reset it.',appearanceGroup);
    const resetAppearance=button('Reset appearance',appearanceGroup,()=>{if(!valid()||busy)return;appearanceErrors.clear();status('Appearance defaults restored in this draft.');return queueAppearance(appearance(),resetAppearance);});
    const addZone=button('Add empty zone',inspector,()=>change(async()=>{await controller.addEmptyPlacement({x:.25,y:.25,w:.5,h:.5,rotation:0});selected=zones().at(-1)?.slotIndex;},'Empty zone added to draft.'));
    const artworkButton=onArtwork?button('Artwork & overlays',inspector,()=>{if(!valid())return;const scene=owner,origin=opener;close();onArtwork(scene,origin);},'bc-arrange-artwork'):null;
    make('p','bc-arrange-hint','Artwork keeps its existing position and styling. Sources not used by a preset keep their current placement.',inspector);
    const statusNode=make('p','bc-arrange-status',undefined,dialog);statusNode.setAttribute('role','status');statusNode.setAttribute('aria-live','polite');
    const footer=make('footer','bc-arrange-footer',undefined,dialog),undoButton=button('Undo applied layout',footer,()=>historyAction('undo')),redoButton=button('Redo applied layout',footer,()=>historyAction('redo')),resetButton=button('Reset draft',footer,()=>prepare(owner));make('span','','',footer);
    const cancelButton=button('Cancel',footer,()=>close()),applyButton=button('Apply to Preview',footer,()=>apply(),'bc-arrange-apply');
    root.appendChild(dialog);
    let owner=null,opener=null,controller=null,serial=0,busy=false,selected=null,selectionUnavailable=false,currentPreset='current',baseline='',initialRects=[],favoriteList=[],frame=0,lastFrame=0,drag=null,pendingDrag=null,dragRunning=false,pendingAppearance=null,appearanceRunning=false,appearanceActive=null,destroyed=false;
    const raf=typeof window.requestAnimationFrame==='function'?fn=>window.requestAnimationFrame(fn):null,caf=typeof window.cancelAnimationFrame==='function'?n=>window.cancelAnimationFrame(n):()=>{};
    const status=(message,error=false)=>{statusNode.textContent=message;statusNode.classList.toggle('error',error);};
    const exists=()=>owner&&(!studio.scenes||studio.scenes().includes(owner))&&(!getScene||getScene()===owner);
    const valid=()=>{if(dialog.open&&exists()&&controller)return true;status('The selected scene changed. Reopen Arrange scene to edit it.',true);return false;};
    const zones=()=>controller?.placements||controller?.zones||[];
    const pictures=()=>controller?.pictureSlots||zones();
    const rect=row=>geometry(row.transform||row);
    const editable=row=>row&&row.editable!==false&&!row.locked;
    const stamp=()=>JSON.stringify({layout:controller?.draft?.layout,template:controller?.draft?.fullTemplateId||'',placements:zones().map(row=>[row.slotIndex,row.sourceId||null,rect(row),appearance(row.creative)])});
    const dirty=()=>!!controller&&(typeof controller.dirty==='boolean'?controller.dirty:stamp()!==baseline);
    const appearanceError=()=>[...appearanceErrors.values()].find(error=>error.serial===serial&&error.slotIndex===selected);
    function controls(){
      const row=zones().find(item=>item.slotIndex===selected),canEdit=editable(row);
      applyButton.disabled=busy||!controller||!dirty()||!!appearanceError();resetButton.disabled=busy||!controller;
      const history=owner&&studio.arrangementHistory?.(owner.id)||{};
      undoButton.disabled=busy||!controller||dirty()||!history.canUndo||typeof studio.undoSceneArrangement!=='function';redoButton.disabled=busy||!controller||dirty()||!history.canRedo||typeof studio.redoSceneArrangement!=='function';
      undoButton.title=dirty()?'Apply or reset this draft before undoing an applied Preview layout.':history.undoLabel||'Undo the last applied Preview layout.';
      redoButton.title=dirty()?'Apply or reset this draft before redoing an applied Preview layout.':history.redoLabel||'Redo the last applied Preview layout.';
      saveButton.disabled=busy||!controller||!!appearanceError()||!zones().some(row=>editable(row)&&!row.unplaced);favoriteName.disabled=busy;
      assignment.disabled=busy||!canEdit;addZone.disabled=busy||!controller||typeof controller.addEmptyPlacement!=='function'||(controller.draft?.slots?.length||0)>=32;
      for(const input of Object.values(inputs))input.disabled=busy||!canEdit;
      const canStyle=canEdit&&typeof controller?.setAppearance==='function';
      for(const control of [...Object.values(appearanceInputs),...Object.values(appearanceRanges)])control.disabled=!canStyle||busy&&!(appearanceRunning&&control===appearanceActive);
      resetAppearance.disabled=busy||!canStyle;appearanceHint.textContent=!controller?.setAppearance?'Appearance tools are unavailable for this draft.':row?.locked?'Unlock this source in Sources before changing its appearance.':'Stroke weight 0 removes the frame. Transparency: 0% opaque · 100% invisible. Audio is unchanged. Right-click a parameter to reset it.';
      filter.disabled=busy;for(const control of [...presets.querySelectorAll('button'),...favorites.querySelectorAll('button'),...sources.querySelectorAll('button')])control.disabled=busy;
      dirtyLabel.textContent=dirty()?'Unsaved changes':'Current arrangement';dialog.setAttribute('aria-busy',String(busy));
    }
    function layoutGroup(key){return key.includes('pip')?'pip':key.includes('grid')||key.includes('panel')||key==='thirds'||key==='focus-three'?'panel':'simple';}
    function thumbnail(parent,rectangles){
      const thumb=make('span','bc-arrange-thumb',undefined,parent);thumb.setAttribute('aria-hidden','true');
      for(const raw of rectangles){const h=raw.h??raw.w??1,r={x:raw.x??0,y:raw.y??(1-h)/2,w:raw.w??1,h},box=make('i','',undefined,thumb);Object.assign(box.style,{left:r.x*100+'%',top:r.y*100+'%',width:r.w*100+'%',height:r.h*100+'%'});}
    }
    function tile(parent,key,label,rectangles,action){const tile=button('',parent,action,'bc-arrange-tile');tile.setAttribute('aria-label',label);tile.setAttribute('data-layout-key',key);tile.setAttribute('aria-pressed',String(currentPreset===key));thumbnail(tile,rectangles);make('span','',label,tile);return tile;}
    function renderLibrary(){
      presets.replaceChildren();tile(presets,'current','Current layout',initialRects,()=>prepare(owner));
      if(filter.value==='all'||filter.value==='simple')tile(presets,'free','Free canvas',zones().filter(row=>!row.unplaced).map(rect),()=>change(()=>controller.choosePreset('free'),'Free canvas draft. Move and resize each source.','free'));
      for(const [key,layout] of Object.entries(studio.LAYOUTS||{})){
        if(key==='free'||key.startsWith('svg-')||!Array.isArray(layout['16x9'])||filter.value!=='all'&&layoutGroup(key)!==filter.value)continue;
        tile(presets,key,layout.label,layout['16x9'],()=>change(()=>controller.choosePreset(key),layout.label+' draft ready.',key));
      }
      favorites.replaceChildren();if(!favoriteList.length)make('p','bc-arrange-hint','Save an arrangement to use it again with other scene sources.',favorites);
      for(const saved of favoriteList){const item=make('div','bc-arrange-favorite',undefined,favorites);tile(item,saved.id,saved.name,saved.rectangles,()=>useFavorite(saved));const remove=button('×',item,()=>removeFavorite(saved.id),'bc-arrange-remove');remove.setAttribute('aria-label','Delete saved layout '+saved.name);}
    }
    function renderZones(){
      guides.replaceChildren();sources.replaceChildren();
      zones().forEach((row,i)=>{
        if(row.unplaced&&row.slotIndex!==selected)return;
        const r=rect(row),label=row.label||(row.sourceId?'Source '+(row.slotIndex+1):'Empty'),zone=button('',guides,()=>select(row.slotIndex),'bc-arrange-zone');
        zone.setAttribute('aria-label','Select zone '+(i+1)+': '+label);zone.setAttribute('aria-pressed',String(row.slotIndex===selected));zone.setAttribute('data-slot-index',String(row.slotIndex));zone.classList.toggle('locked',!editable(row));zone.classList.toggle('selected',row.slotIndex===selected);
        Object.assign(zone.style,{left:r.x*100+'%',top:r.y*100+'%',width:r.w*100+'%',height:r.h*100+'%',transform:r.rotation?'rotate('+r.rotation+'deg)':''});
        make('span','bc-arrange-zone-label',(i+1)+' · '+label+(row.unplaced?' · Not placed':row.hidden?' · Hidden':'')+(!editable(row)?' · Locked':''),zone);
        if(editable(row)){const handle=make('span','bc-arrange-resize',undefined,zone);handle.setAttribute('aria-hidden','true');handle.addEventListener('pointerdown',event=>beginDrag(event,row,'resize'));zone.addEventListener('pointerdown',event=>{if(event.target!==handle)beginDrag(event,row,'move');});zone.addEventListener('keydown',event=>zoneKey(event,row));}
        zone.addEventListener('dragover',event=>{if(editable(row)&&valid()&&!busy)event.preventDefault();});zone.addEventListener('drop',event=>{event.preventDefault();const index=Number(event.dataTransfer?.getData('application/x-showave-scene-slot'));if(Number.isInteger(index))swap(row.slotIndex,index);});
      });
      for(const row of pictures()){
        const label=row.label||(row.sourceId?'Source '+(row.slotIndex+1):'Empty zone '+(row.slotIndex+1)),chip=button(label+(row.unplaced?' · Not placed':'')+(row.locked?' · Locked':''),sources,()=>select(row.slotIndex),'bc-arrange-chip');
        chip.setAttribute('aria-label','Select source placement '+label);chip.setAttribute('aria-pressed',String(row.slotIndex===selected));chip.draggable=editable(row);if(chip.draggable)chip.addEventListener('dragstart',event=>{if(!valid()||busy){event.preventDefault();return;}event.dataTransfer?.setData('application/x-showave-scene-slot',String(row.slotIndex));});
      }
    }
    function renderSelection(){
      let discarded=false;for(const [control,error] of appearanceErrors)if(error.serial!==serial||error.slotIndex!==selected){appearanceErrors.delete(control);discarded=true;}
      if(discarded)status('Source zone changed. Invalid appearance text was discarded; draft values are shown.');
      const row=zones().find(item=>item.slotIndex===selected);selectedLabel.textContent=row?(row.label||'Empty zone')+(row.unplaced?' · Not placed':'')+(row.locked?' · Locked':''):'Select a source zone';
      assignment.replaceChildren();for(const item of pictures().filter(editable)){const option=make('option','',item.label||(item.sourceId?'Source '+(item.slotIndex+1):'Empty zone '+(item.slotIndex+1)),assignment);option.value=String(item.slotIndex);}
      assignment.value=row?String(row.slotIndex):'';for(const key of fields)inputs[key].value=row?String(Math.round(rect(row)[key]*1000)/10):'';
      renderAppearance(row);
    }
    function render(){
      if(!controller)return;const all=zones();if(!all.some(row=>row.slotIndex===selected))selected=selectionUnavailable?null:all.find(row=>editable(row)&&!row.unplaced)?.slotIndex??all.find(editable)?.slotIndex??all[0]?.slotIndex??null;
      const presetLabel=currentPreset==='current'?(studio.LAYOUTS?.[owner.layout]?.label||'Current layout'):currentPreset==='custom'?'Custom arrangement':favoriteList.find(layout=>layout.id===currentPreset)?.name||studio.LAYOUTS?.[currentPreset]?.label||'Custom arrangement';
      sceneName.textContent=owner.name||'Scene';previewLabel.textContent='Draft · '+presetLabel;
      renderLibrary();renderZones();renderSelection();
      const details=controller.report;report.textContent=typeof details==='string'?details:Array.isArray(details?.messages)?details.messages.join(' '):details?.warning||details?.message||'';
      controls();paint();
    }
    function select(index){if(!valid()||busy||!zones().some(row=>row.slotIndex===index))return;const unavailable=selectionUnavailable,discarded=!!appearanceError();appearanceErrors.clear();selected=index;selectionUnavailable=false;if(discarded)status('Source zone selected. Invalid appearance text was discarded; draft values are shown.');else if(unavailable)status('Source zone selected. Changes stay in this draft.');renderZones();renderSelection();controls();guides.querySelector('[data-slot-index="'+index+'"]')?.focus();}
    function paint(time){if(!controller||!dialog.open||!exists())return;try{const proof=controller.render(canvas,time);if(proof?.ok===false)status(proof.why||'The layout artwork could not be drawn.',true);}catch(error){status(error.message||String(error),true);}}
    function animate(time){frame=0;if(!dialog.open||destroyed)return;if(time-lastFrame>=1000/30){lastFrame=time;paint(time);}if(raf)frame=raf(animate);}
    async function change(operation,message,preset='custom'){
      if(!valid()||busy)return;const token=serial,plan=controller,focusLayout=presets.contains(doc.activeElement)||favorites.contains(doc.activeElement);let restoreFocus=false;busy=true;controls();status('Preparing draft…');
      try{await operation();if(token!==serial||!dialog.open||plan!==controller||!exists())return;currentPreset=preset;const error=appearanceError();status(error?.message||message,!!error);render();restoreFocus=true;}
      catch(error){if(token===serial&&dialog.open)status(error.message||String(error),true);}
      finally{if(token===serial){busy=false;controls();if(restoreFocus&&focusLayout)dialog.querySelector('[data-layout-key="'+preset+'"]')?.focus();}}
    }
    function setNumber(key,value){
      if(!valid()||busy)return;const row=zones().find(item=>item.slotIndex===selected);if(!editable(row))return;
      const n=Number(value);if(value.trim()===''||!Number.isFinite(n)||n<0||n>100||(['w','h'].includes(key)&&n<1)){status('Use 0–100%; width and height must be at least 1%.',true);return;}
      const transform={...rect(row),[key]:n/100};
      if(transform.x+transform.w>1.0000001||transform.y+transform.h>1.0000001||transform.x<0||transform.y<0){status('Keep the zone inside the canvas: X + Width and Y + Height must be at most 100%.',true);return;}
      change(()=>controller.setPlacements([{slotIndex:row.slotIndex,transform}]),'Custom arrangement draft.');
    }
    function renderAppearance(row){
      let value=row?appearance(row.creative):null;
      if(value&&pendingAppearance?.serial===serial&&pendingAppearance.slotIndex===row.slotIndex)value=mergeAppearance(value,pendingAppearance.patch);
      const values=value?{width:value.stroke.width,color:value.stroke.color,style:value.stroke.style,radius:value.radius*100,opacity:value.opacity*100,transparency:(1-value.opacity)*100}:{};
      for(const [key,input] of Object.entries(appearanceInputs)){if(appearanceErrors.has(input)||input===appearanceActive&&input.type==='number'&&(appearanceRunning||pendingAppearance))continue;input.value=value?typeof values[key]==='number'?String(Math.round(values[key]*1000)/1000):values[key]:'';}
      for(const [key,input] of Object.entries(appearanceRanges))if(!appearanceErrors.has(input))input.value=value?String(Math.round(values[key]*1000)/1000):'';
    }
    function invalidAppearance(control,message){appearanceErrors.set(control,{serial,slotIndex:selected,message});status(message,true);controls();}
    function setAppearanceValue(key,value,control){
      if(!valid()||busy&&!appearanceRunning)return;
      let patch;
      if(key==='color'||key==='style'){
        if(key==='color'&&!/^#[\da-f]{6}$/i.test(String(value))||key==='style'&&!['solid','dashed','dotted'].includes(value)){invalidAppearance(control,'Use a six-digit stroke colour and Solid, Dashed or Dotted style.');return;}
        patch={stroke:{[key]:value}};
      }else{
        const text=String(value).trim(),number=Number(text),max=key==='width'?64:key==='radius'?50:100;
        if(!text||!Number.isFinite(number)||number<0||number>max){invalidAppearance(control,'Use '+(key==='width'?'0–64 HD pixels':key==='radius'?'0–50% corner rounding':'0–100% opacity or transparency')+'.');return;}
        patch=key==='width'?{stroke:{width:number}}:key==='radius'?{radius:number/100}:{opacity:key==='transparency'?1-number/100:number/100};
      }
      for(const field of ['opacity','transparency'].includes(key)?['opacity','transparency']:[key]){appearanceErrors.delete(appearanceInputs[field]);appearanceErrors.delete(appearanceRanges[field]);}
      if(control)control.value=String(value);
      return queueAppearance(patch,control);
    }
    function queueAppearance(patch,control){
      if(!valid()||busy&&!appearanceRunning)return;const row=zones().find(item=>item.slotIndex===selected);
      if(!editable(row)||typeof controller.setAppearance!=='function')return;
      if(!appearanceRunning&&JSON.stringify(mergeAppearance(row.creative,patch))===JSON.stringify(appearance(row.creative))){renderAppearance(row);const error=appearanceError();status(error?.message||'Appearance matches this draft.',!!error);controls();return;}
      const previous=pendingAppearance?.slotIndex===row.slotIndex&&pendingAppearance.serial===serial?pendingAppearance.patch:null;
      pendingAppearance={slotIndex:row.slotIndex,serial,patch:previous?{...previous,...patch,...(previous.stroke||patch.stroke?{stroke:{...previous.stroke,...patch.stroke}}:{})}:patch};
      appearanceActive=control;renderAppearance(row);return pumpAppearance();
    }
    async function pumpAppearance(){
      if(appearanceRunning||!pendingAppearance)return;appearanceRunning=true;const plan=controller,token=serial;busy=true;controls();
      let failed=false;
      try{while(pendingAppearance&&token===serial&&dialog.open&&exists()&&plan===controller){const next=pendingAppearance;pendingAppearance=null;await plan.setAppearance(next.slotIndex,next.patch);
          if(token===serial&&dialog.open&&exists()&&plan===controller){currentPreset='custom';render();}}
      }catch(error){failed=true;if(token===serial&&dialog.open){pendingAppearance=null;appearanceRunning=false;renderSelection();status(appearanceError()?.message||error.message||String(error),true);}}
      finally{if(token===serial){appearanceRunning=false;busy=false;controls();if(!failed&&dialog.open&&exists()){const error=appearanceError();status(error?.message||'Appearance updated in this draft. Apply saves to Preview.',!!error);if(appearanceActive?.isConnected&&[appearanceActive,dialog,doc.body].includes(doc.activeElement))appearanceActive.focus({preventScroll:true});}appearanceActive=null;}}
    }
    function swap(destination,index){
      if(!valid()||busy||destination===index)return;const a=pictures().find(row=>row.slotIndex===destination),b=pictures().find(row=>row.slotIndex===index);if(!editable(a)||!editable(b))return;
      change(async()=>{await controller.swapSlots(destination,index);selected=index;},'Source positions swapped in draft.');
    }
    assignment.addEventListener('change',()=>swap(selected,Number(assignment.value)));
    filter.addEventListener('change',()=>{if(!valid())return;renderLibrary();controls();});
    function withinCanvas(r){const result={...r,w:Math.max(.01,Math.min(1,r.w)),h:Math.max(.01,Math.min(1,r.h))};result.x=Math.max(0,Math.min(1-result.w,r.x));result.y=Math.max(0,Math.min(1-result.h,r.y));return result;}
    function zoneKey(event,row){
      const direction={ArrowLeft:['x',-1],ArrowRight:['x',1],ArrowUp:['y',-1],ArrowDown:['y',1]}[event.key];if(!direction||!editable(row)||!valid()||busy)return;event.preventDefault();selected=row.slotIndex;
      const key=event.altKey?(direction[0]==='x'?'w':'h'):direction[0],transform=withinCanvas(rect(row));transform[key]+=direction[1]*(event.shiftKey?.05:.01);
      if(key==='w')transform.w=Math.max(.01,Math.min(1-transform.x,transform.w));else if(key==='h')transform.h=Math.max(.01,Math.min(1-transform.y,transform.h));else if(key==='x')transform.x=Math.max(0,Math.min(1-transform.w,transform.x));else transform.y=Math.max(0,Math.min(1-transform.h,transform.y));
      change(()=>controller.setPlacements([{slotIndex:row.slotIndex,transform}]),'Custom arrangement draft.').then(()=>guides.querySelector('[data-slot-index="'+row.slotIndex+'"]')?.focus());
    }
    function beginDrag(event,row,mode){
      if(event.button!==undefined&&event.button!==0||!valid()||busy||!editable(row))return;event.preventDefault();event.stopPropagation?.();selected=row.slotIndex;
      drag={slotIndex:row.slotIndex,mode,x:event.clientX,y:event.clientY,rect:withinCanvas(rect(row)),stage:stage.getBoundingClientRect(),serial};renderSelection();controls();guides.querySelector('[data-slot-index="'+row.slotIndex+'"]')?.focus();
    }
    function dragMove(event){
      if(!drag||drag.serial!==serial||!valid())return;const r={...drag.rect},dx=(event.clientX-drag.x)/Math.max(1,drag.stage.width),dy=(event.clientY-drag.y)/Math.max(1,drag.stage.height);
      if(drag.mode==='move'){r.x=Math.max(0,Math.min(1-r.w,r.x+dx));r.y=Math.max(0,Math.min(1-r.h,r.y+dy));}else{r.w=Math.max(.01,Math.min(1-r.x,r.w+dx));r.h=Math.max(.01,Math.min(1-r.y,r.h+dy));}
      pendingDrag={slotIndex:drag.slotIndex,transform:r,serial:drag.serial};pumpDrag();
    }
    async function pumpDrag(){
      if(dragRunning||!pendingDrag)return;dragRunning=true;const plan=controller,token=serial;busy=true;controls();
      let failed=false;
      try{while(pendingDrag&&token===serial&&valid()&&plan===controller){const next=pendingDrag;pendingDrag=null;await plan.setPlacements([{slotIndex:next.slotIndex,transform:next.transform}]);if(token===serial&&dialog.open&&exists()){currentPreset='custom';render();}}}
      catch(error){failed=true;if(token===serial)status(error.message||String(error),true);}
      finally{dragRunning=false;if(token===serial){busy=false;controls();if(!failed&&exists()){const error=appearanceError();status(error?.message||'Custom arrangement draft.',!!error);if(!drag)guides.querySelector('[data-slot-index="'+selected+'"]')?.focus();}}if(pendingDrag&&dialog.open)void pumpDrag();}
    }
    function dragEnd(){drag=null;}
    doc.addEventListener('pointermove',dragMove);doc.addEventListener('pointerup',dragEnd);doc.addEventListener('pointercancel',dragEnd);
    function browserStorage(){return storage===undefined?window.localStorage:storage;}
    function loadFavorites(){
      favoriteList=[];try{const raw=browserStorage()?.getItem(storageKey);if(!raw)return;const value=JSON.parse(raw);if(value.version!==1||!Array.isArray(value.layouts)||value.layouts.length>40)throw Error('Saved layouts could not be read.');favoriteList=value.layouts.map(savedLayout);}
      catch(error){status('Saved layouts are unavailable: '+(error.message||String(error)),true);}
    }
    function writeFavorites(next){const target=browserStorage();if(!target?.setItem)throw Error('Browser layout storage is unavailable.');target.setItem(storageKey,JSON.stringify({version:1,layouts:next}));favoriteList=next;renderLibrary();controls();}
    function saveFavorite(){
      if(!valid()||busy||appearanceError())return;try{const name=favoriteName.value.trim();if(!name||name.length>60)throw Error('Enter a layout name of 1–60 characters.');
        const rectangles=zones().filter(row=>editable(row)&&!row.unplaced).map(row=>({...rect(row),appearance:appearance(row.creative)}));const saved=savedLayout({id:'layout-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9),name,rectangles});
        if(favoriteList.length>=40)throw Error('Delete a saved layout before adding another.');writeFavorites([...favoriteList,saved]);favoriteName.value='';status('Layout saved on this browser. Only zone geometry and appearance are stored.');
      }catch(error){status('Layout was not saved: '+(error.message||String(error)),true);}
    }
    function removeFavorite(layoutId){if(!valid()||busy)return;try{writeFavorites(favoriteList.filter(layout=>layout.id!==layoutId));status('Saved layout deleted.');}catch(error){status('Layout was not deleted: '+(error.message||String(error)),true);}}
    function useFavorite(saved){
      return change(async()=>{const plan=controller,token=serial;if(saved.rectangles.some(row=>row.appearance)&&typeof plan.setAppearance!=='function')throw Error('Appearance tools are unavailable for this saved layout.');
        const current=()=>token===serial&&dialog.open&&exists()&&plan===controller;let slots=pictures().filter(editable);while(slots.length<saved.rectangles.length){await plan.addEmptyPlacement(geometry(saved.rectangles[slots.length]));if(!current())return;slots=pictures().filter(editable);}
        await plan.setPlacements(saved.rectangles.map((raw,i)=>({slotIndex:slots[i].slotIndex,transform:geometry(raw)})));if(!current())return;
        for(let i=0;i<saved.rectangles.length;i++)if(saved.rectangles[i].appearance){await plan.setAppearance(slots[i].slotIndex,saved.rectangles[i].appearance);if(!current())return;}},saved.name+' draft ready.',saved.id);
    }
    async function prepare(scene,options={}){
      if(!scene||scene!==owner||!exists()){status('The selected scene changed. Reopen Arrange scene.',true);return;}
      const {presetId}=options,explicitSelection=Object.prototype.hasOwnProperty.call(options,'slotIndex'),requestedSelection=explicitSelection?options.slotIndex:selected,hasSelection=explicitSelection||selected!==null||selectionUnavailable;
      const focusLayout=presets.contains(doc.activeElement)||favorites.contains(doc.activeElement),token=++serial;controller?.cancel();controller=null;drag=null;pendingDrag=null;pendingAppearance=null;appearanceRunning=false;appearanceActive=null;appearanceErrors.clear();busy=true;controls();status('Preparing scene draft…');
      guides.replaceChildren();sources.replaceChildren();presets.replaceChildren();assignment.replaceChildren();selectedLabel.textContent='Preparing scene…';previewLabel.textContent='Draft · Preparing scene…';report.textContent='';for(const input of [...Object.values(inputs),...Object.values(appearanceInputs),...Object.values(appearanceRanges)])input.value='';
      const ctx=canvas.getContext?.('2d');ctx?.clearRect?.(0,0,canvas.width,canvas.height);
      try{const plan=await studio.prepareSceneArrangement(scene,{isCurrent:()=>token===serial&&dialog.open&&exists()});
        if(token!==serial||!dialog.open||!exists()){plan.cancel();return;}controller=plan;currentPreset='current';baseline=stamp();initialRects=zones().filter(row=>!row.unplaced).map(rect);
        if(presetId){await plan.choosePreset(presetId);if(token!==serial||!dialog.open||!exists())return;currentPreset=presetId;}
        selected=Number.isInteger(requestedSelection)&&requestedSelection>=0&&zones().some(row=>row.slotIndex===requestedSelection)?requestedSelection:null;selectionUnavailable=hasSelection&&selected===null;
        status(selectionUnavailable?'The selected source zone is unavailable. Select another zone to edit it.':'Choose a layout or arrange a source zone. Changes stay in this draft.',selectionUnavailable);loadFavorites();render();
      }catch(error){if(token===serial&&dialog.open)status(error.message||String(error),true);}
      finally{if(token===serial){busy=false;controls();if(controller&&explicitSelection&&selected!==null)guides.querySelector('[data-slot-index="'+selected+'"]')?.focus();else if(controller&&focusLayout)dialog.querySelector('[data-layout-key="'+currentPreset+'"]')?.focus();}}
    }
    async function apply(){
      if(!valid()||busy||!dirty()||appearanceError())return;const plan=controller,token=serial;busy=true;controls();status('Saving arrangement to Preview…');
      try{
        let result;try{result=await plan.commit();}catch(error){if(token===serial&&dialog.open)status(error.message||String(error),true);return;}
        if(token!==serial||!dialog.open)return;const scene=result?.scene||owner,details=result?.report||plan.report;
        try{onApplied?.(scene,details);}catch(error){await prepare(scene);status('Layout saved to Preview. Studio refresh failed: '+(error.message||String(error)),true);return;}
        close({applied:true});
      }
      finally{if(token===serial){busy=false;controls();}}
    }
    async function historyAction(direction){
      if(!valid()||busy||dirty())return;const history=studio.arrangementHistory?.(owner.id)||{},method=direction==='undo'?'undoSceneArrangement':'redoSceneArrangement';
      if(!(direction==='undo'?history.canUndo:history.canRedo)||typeof studio[method]!=='function')return;
      const token=serial,scene=owner;busy=true;controls();status(direction==='undo'?'Undoing applied Preview layout…':'Redoing applied Preview layout…');
      try{const changed=await studio[method](scene.id,{isCurrent:()=>token===serial&&dialog.open&&exists()});if(token!==serial||!dialog.open||!exists())return;
        if(changed){let refreshError;try{onApplied?.(scene,{history:direction});}catch(error){refreshError=error;}await prepare(scene);status(refreshError?'Preview layout changed. Studio refresh failed: '+(refreshError.message||String(refreshError)):direction==='undo'?'Applied Preview layout undone.':'Applied Preview layout restored.',!!refreshError);}
        else status('No applied layout history is available.');
      }catch(error){if(token===serial&&dialog.open)status(error.message||String(error),true);}
      finally{if(token===serial){busy=false;controls();}}
    }
    function close({applied=false}={}){
      const wasOpen=dialog.open,context={scene:owner,opener,applied};serial++;controller?.cancel();controller=null;drag=null;pendingDrag=null;pendingAppearance=null;appearanceRunning=false;appearanceActive=null;appearanceErrors.clear();busy=false;if(frame){caf(frame);frame=0;}if(wasOpen)dialog.close();
      if(wasOpen){if(opener?.isConnected)opener.focus();onClose?.(context);}
    }
    function open(scene,origin=doc.activeElement,options={}){
      if(destroyed)return;if(dialog.open)close();owner=scene||getScene?.();opener=origin;selected=null;selectionUnavailable=false;favoriteName.value='';filter.value='all';library.scrollTop=0;sceneName.textContent=owner?.name||'Scene';dirtyLabel.textContent='Current arrangement';status('');dialog.showModal();cancelButton.focus();lastFrame=0;if(raf)frame=raf(animate);return prepare(owner,options);
    }
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    return {open,close,destroy(){if(destroyed)return;close();destroyed=true;doc.removeEventListener('pointermove',dragMove);doc.removeEventListener('pointerup',dragEnd);doc.removeEventListener('pointercancel',dragEnd);dialog.remove();}};
  }
  return Object.freeze({mount});
})();
