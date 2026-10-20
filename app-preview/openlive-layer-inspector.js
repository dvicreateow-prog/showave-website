/* Persistent scene-source controls. Native artwork keeps its existing editor. */
window.OpenLiveLayerInspector=(()=>{
  'use strict';
  const fields=[['x','X (%)',100],['y','Y (%)',100],['w','Width (%)',100],['h','Height (%)',100],['rotation','Rotation (°)',1],['opacity','Opacity (%)',100]];
  const inputFields=[['x','Input X (%)'],['y','Input Y (%)'],['w','Input width (%)'],['h','Input height (%)']];
  const creativeTypes={'lower-third':'Lower third',ticker:'Ticker',countdown:'Countdown timer',qr:'QR code','product-card':'Product card'};
  function creativeDescription(source){
    const config=source.config||{};
    if(source.sourceType==='lower-third')return [config.line1,config.line2].filter(Boolean).join(' · ');
    if(source.sourceType==='ticker')return config.text||'';
    if(source.sourceType==='qr')return [config.label,config.url].filter(Boolean).join(' · ');
    if(source.sourceType==='product-card')return [config.title,config.price].filter(Boolean).join(' · ');
    return 'Edit duration and appearance in Properties.';
  }
  function align(rect,edge){
    if(typeof window.OpenLiveFreeScene?.alignRect==='function')return window.OpenLiveFreeScene.alignRect(rect,edge);
    const next={...rect},angle=rect.rotation*Math.PI/180,aspect=16/9;
    const halfW=(Math.abs(Math.cos(angle))*rect.w+Math.abs(Math.sin(angle))*rect.h/aspect)/2;
    const halfH=(Math.abs(Math.sin(angle))*rect.w*aspect+Math.abs(Math.cos(angle))*rect.h)/2;
    if(edge==='left')next.x=halfW-rect.w/2;if(edge==='right')next.x=1-halfW-rect.w/2;if(edge==='center')next.x=(1-rect.w)/2;
    if(edge==='top')next.y=halfH-rect.h/2;if(edge==='bottom')next.y=1-halfH-rect.h/2;if(edge==='middle')next.y=(1-rect.h)/2;
    return next;
  }
  function mount({studio,root,getSelection,enabled=()=>true,onChange,openProperties,openContent,openEffects}){
    const doc=root.ownerDocument;let state=null,timer=null,destroyed=false,stage='input';
    const make=(tag,parent,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;parent.appendChild(node);return node;};
    const cancelTimer=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
    const selection=()=>{try{return getSelection?.()||null;}catch(_){return null;}};
    const rowItem=row=>row?.slot||row?.boundSlot;
    const editKey=target=>target.bound?'source:'+target.index:target.key;
    const current=target=>{const next=selection();return !destroyed&&state===target&&!!next&&next.scene===target.scene&&next.key===target.key&&rowItem(next.row)===target.item&&rowItem(next.row)?.sourceId===target.sourceId&&
      next.row?.part===target.part&&next.row?.widget===target.widget&&next.row?.overlay===target.overlay&&next.row?.component===target.component&&studio.scenes().includes(target.scene);};
    const free=scene=>scene.layout==='free'&&!scene.fullTemplateId&&scene.svgPartsMode!=='parts-only';
    function reason(target){
      if(!enabled())return 'Controls are available in Scene Preview.';
      if(target.scene.layoutPending)return 'Choose this scene’s layout before editing sources.';
      if(!target.item)return 'Open this artwork’s editor to customise it.';
      if(!target.bound&&!free(target.scene))return 'This source keeps its template placement. Open its editor for available settings.';
      if(target.item.locked||target.part?.locked||selection()?.row?.locked)return 'Unlock this layer before editing it.';
      if(studio.sources.get(target.item.sourceId)?.audioOnly)return 'Audio-only sources have no picture to edit.';
      if(target.bound&&!studio.sources.get(target.sourceId))return 'Choose a picture source for this template frame.';
      return '';
    }
    const outputReason=target=>reason(target)||(target.bound?'The output frame keeps its native template placement. Use Auto Size to fit the source inside it.':'');
    function say(target,text){if(state===target&&target.status)target.status.textContent=text;}
    function check(target){if(!current(target))throw Error('The selected layer changed. Select it again.');const why=reason(target);if(why)throw Error(why);}
    const opacity=target=>target.item?.creative?.opacity??1;
    const pose=target=>target.bound?(studio.sceneContentBounds?.(target.scene,target.key)?.rect||studio.sourceRectNormalized(target.scene,target.index)):studio.sourceRectNormalized(target.scene,target.index);
    const inputPose=target=>studio.sourceInputSelection?.(target.scene,target.index)||{x:0,y:0,w:1,h:1};
    const sourceFit=target=>studio.sourceOutputFit?.(target.scene,target.index)||target.item.outputFit||'contain';
    const sourceAspect=target=>{const el=studio.sources.get(target.sourceId)?.el;return (el?.videoWidth||el?.naturalWidth||el?.width||16)/(el?.videoHeight||el?.naturalHeight||el?.height||9);};
    function defaultPose(target){
      const source=studio.sources.get(target.sourceId);
      // Generated artwork declares its authored size and placement. Resetting
      // that layer must restore the native rectangle rather than stretching it
      // over the whole programme frame. Ordinary sources keep their old reset.
      if(creativeTypes[source?.sourceType]&&source?.initialTransform&&typeof window.OpenLiveTemplateSources?.resolveCreative==='function'){
        try{window.OpenLiveTemplateSources.resolveCreative(source.sourceType,source.config?.templateId);return studio.freeTransform(source.initialTransform);}catch(_){}
      }
      return studio.freeTransform();
    }
    function syncCountdown(target,why){
      if(!target.clockHost)return;
      const hidden=!enabled();if(target.clockHost.hidden!==hidden)target.clockHost.hidden=hidden;
      const source=studio.sources.get(target.sourceId),controls=source?.creativeControls;
      let value;try{if(source===target.runtimeSource&&controls===target.clock&&studio.sourceStatus(source).ok)value=controls.state();}catch(_){}
      const unavailable=!!why||!value;
      const disable=(action,value)=>{if(action.disabled!==value)action.disabled=value;};
      if(value){
        const remaining=Math.max(0,Math.ceil(Number(value.remainingSeconds)||0));
        const text=(value.state==='running'?'Running':value.state==='finished'?'Finished':'Paused')+' · '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0')+' remaining';
        if(target.clockValue.textContent!==text)target.clockValue.textContent=text;
        disable(target.clockActions.start,unavailable||value.state==='running'||value.state==='finished');
        disable(target.clockActions.pause,unavailable||value.state!=='running');disable(target.clockActions.reset,unavailable);
      }else{
        for(const action of Object.values(target.clockActions))disable(action,true);
        if(target.clockValue.textContent!=='This countdown is unavailable.')target.clockValue.textContent='This countdown is unavailable.';
      }
    }
    function effectsReason(target){
      if(!enabled())return 'Controls are available in Scene Preview.';
      if(target.scene.layoutPending)return 'Choose this scene’s layout before editing effects.';
      if(!target.item)return 'Select an independent picture source to edit effects.';
      if(target.item.locked||target.part?.locked||selection()?.row?.locked)return 'Unlock this layer before editing effects.';
      const source=studio.sources.get(target.sourceId);
      if(!source)return 'This source is no longer available.';
      if(source.audioOnly)return 'Audio-only sources have no picture effects.';
      if(!target.bound&&(target.scene.fullTemplateId||target.scene.svgPartsMode==='parts-only'||target.scene.svgParts?.some(part=>part.sourceSlot===target.index)))return 'This source belongs to native artwork. Select an independent picture source.';
      return '';
    }
    function effectNotice(target,message){if(state===target&&target.effectsNotice)target.effectsNotice.textContent=message||'';}
    function effectCurrent(target,item,source){return current(target)&&target.item===item&&studio.sources.get(target.sourceId)===source&&!effectsReason(target);}
    function effectCheck(target,item,source){
      if(!current(target)||target.item!==item||studio.sources.get(target.sourceId)!==source)throw Error('The selected source changed. Select it again.');
      const why=effectsReason(target);if(why)throw Error(why);
      if(target.busy||target.dirty)throw Error('Finish the current mapping edit before editing effects.');
    }
    function effectButton(parent,label,target,run,cls){
      const node=make('button',parent,label,'btn '+cls);node.type='button';node.addEventListener('click',()=>{
        try{if(!root.contains(node))throw Error('The selected effect changed. Select it again.');const result=run();result?.catch?.(error=>effectNotice(target,error.message||String(error)));}
        catch(error){effectNotice(target,error.message||String(error));}
      });return node;
    }
    async function editEffect(target,item,source,effect,action){
      effectCheck(target,item,source);
      if(!item.effects?.includes(effect))throw Error('The selected effect changed. Select it again.');
      const label=effect.name,sourceLabel=effectSourceLabel(target);target.busy=true;target.effectsBusy=true;effectNotice(target,'');sync(target);
      try{
        const options={expected:item,isCurrent:()=>effectCurrent(target,item,source)};
        if(action==='remove')await studio.removeSourceEffect(target.scene.id,target.index,effect.id,options);
        else await studio.updateSourceEffect(target.scene.id,target.index,effect.id,{bypassed:!effect.bypassed},options);
        if(destroyed||state!==target)return;adopt(target);onChange?.();
        effectNotice(target,action==='remove'?'Removed '+label+' from '+sourceLabel+' in Preview.':(effect.bypassed?'Enabled ':'Bypassed ')+label+' in Preview.');
      }finally{target.busy=false;target.effectsBusy=false;if(state===target&&!destroyed){sync(target);if(target.queued){target.queued=false;void apply(target);}}}
    }
    async function undoEffectEdit(target){
      const item=target.effectsItem,source=target.effectsSource;effectCheck(target,item,source);
      target.busy=true;target.effectsBusy=true;effectNotice(target,'');sync(target);
      try{
        const changed=await studio.stepCreativeHistory(target.scene.id,false,{isCurrent:()=>effectCurrent(target,item,source)});
        if(!changed)throw Error('No scene edit is available to undo.');
        if(destroyed||state!==target)return;adopt(target);onChange?.();effectNotice(target,'Undid the latest scene edit in Preview.');
      }finally{target.busy=false;target.effectsBusy=false;if(state===target&&!destroyed){sync(target);if(target.queued){target.queued=false;void apply(target);}}}
    }
    function effectSourceLabel(target){return selection()?.row?.label||target.item?.label||studio.sources.get(target.sourceId)?.label||'Source';}
    function openEffectEditor(target,effectId){effectCheck(target,target.effectsItem,target.effectsSource);return openEffects?.(selection(),effectId);}
    function buildEffects(target){
      if(typeof studio.removeSourceEffect!=='function'||typeof studio.updateSourceEffect!=='function')return;
      const host=make('section',root,undefined,'bc-layer-effects');host.setAttribute('aria-label','Applied effects');target.effectsHost=host;
      const head=make('header',host,undefined,'bc-layer-effects-head');make('strong',head,'Applied effects');target.effectsCount=make('span',head,'0','bc-layer-effects-count');
      if(typeof openEffects==='function'){target.effectsAdd=effectButton(head,'Add',target,()=>openEffectEditor(target),'bc-layer-effects-add');target.effectsAdd.setAttribute('aria-label','Add effect to selected source');}
      target.effectsList=make('div',host,undefined,'bc-layer-effects-list');
      const footer=make('div',host,undefined,'bc-layer-effects-footer');target.effectsNotice=make('span',footer,'','bc-layer-effects-notice');target.effectsNotice.setAttribute('aria-live','polite');
      if(typeof studio.creativeHistory==='function'&&typeof studio.stepCreativeHistory==='function'){
        target.effectsUndo=effectButton(footer,'Undo',target,()=>undoEffectEdit(target),'bc-layer-effects-undo');target.effectsUndo.setAttribute('aria-label','Undo last scene edit');target.effectsUndo.title='Undo last scene edit · the latest creative edit anywhere in this Preview scene';
      }
    }
    function syncEffects(target){
      if(!target.effectsHost)return;
      const source=studio.sources.get(target.sourceId),chain=target.item?.effects||[],why=effectsReason(target);
      target.effectsHost.hidden=!target.item||!source||!!source.audioOnly||!target.bound&&(!!target.scene.fullTemplateId||target.scene.svgPartsMode==='parts-only'||!!target.scene.svgParts?.some(part=>part.sourceSlot===target.index));
      const blocked=!!why||target.busy||target.dirty,sourceLabel=effectSourceLabel(target),stamp=JSON.stringify([sourceLabel,chain]);
      if(target.effectsItem!==target.item||target.effectsSource!==source||target.effectsStamp!==stamp){
        target.effectsItem=target.item;target.effectsSource=source;target.effectsStamp=stamp;target.effectsList.replaceChildren();target.effectControls=[];
        target.effectsCount.textContent=String(chain.length);target.effectsCount.setAttribute('aria-label',chain.length+' applied effects');
        if(!chain.length)make('span',target.effectsList,'No effects applied.','bc-layer-effects-empty');
        for(const effect of chain){
          const item=target.item,row=make('div',target.effectsList,undefined,'bc-layer-effects-row');row.classList.toggle('is-bypassed',!!effect.bypassed);
          const bypass=effectButton(row,effect.bypassed?'Off':'On',target,()=>editEffect(target,item,source,effect,'bypass'),'bc-layer-effects-bypass');
          bypass.setAttribute('aria-label',(effect.bypassed?'Enable ':'Bypass ')+effect.name+' on '+sourceLabel);bypass.setAttribute('aria-pressed',String(!effect.bypassed));bypass.title=effect.bypassed?'Enable '+effect.name:'Bypass '+effect.name;target.effectControls.push(bypass);
          if(typeof openEffects==='function'){
            const edit=effectButton(row,effect.name,target,()=>{effectCheck(target,item,source);return openEffects(selection(),effect.id);},'bc-layer-effects-name');edit.setAttribute('aria-label','Edit '+effect.name+' on '+sourceLabel);edit.title='Edit '+effect.name;target.effectControls.push(edit);
          }else make('span',row,effect.name,'bc-layer-effects-name');
          const remove=effectButton(row,'Remove',target,()=>editEffect(target,item,source,effect,'remove'),'bc-layer-effects-remove');remove.setAttribute('aria-label','Remove '+effect.name+' from '+sourceLabel);remove.title='Remove '+effect.name+' from this source in Preview';target.effectControls.push(remove);
        }
      }
      for(const node of target.effectControls||[])node.disabled=blocked;
      if(target.effectsAdd){target.effectsAdd.disabled=blocked;target.effectsAdd.title=why||'Add an effect to '+sourceLabel;}
      if(target.effectsUndo)target.effectsUndo.disabled=blocked||!studio.creativeHistory(target.scene.id).canUndo;
    }
    function sync(target){
      if(!current(target))return;
      const why=reason(target),outputWhy=outputReason(target);for(const input of Object.values(target.inputs))input.disabled=!!outputWhy||!!target.effectsBusy;
      for(const input of Object.values(target.inputInputs||{}))input.disabled=!!why||!!target.effectsBusy;
      for(const action of target.actions)action.disabled=!!(target.outputActions?.includes(action)?outputWhy:why)||!!target.effectsBusy;
      syncCountdown(target,why);
      syncEffects(target);
      if(target.hint){target.hint.textContent=why||(target.bound?outputWhy:'Changes update Preview. Programme changes only with Cut/Fade.');target.hint.hidden=!!target.panels&&!why&&!target.bound;}
      if(target.item&&!target.dirty&&!target.busy){let rect;try{rect=pose(target);}catch(_){return;}
        for(const [key,,scale] of fields){const input=target.inputs[key];if(input&&doc.activeElement!==input){input.value=String(Math.round((key==='opacity'?opacity(target):rect[key])*scale*100)/100);target.rendered[key]=input.value;delete target.forced[key];}}
        const sourceRect=inputPose(target);
        for(const [key] of inputFields){const input=target.inputInputs?.[key];if(input&&doc.activeElement!==input){input.value=String(Math.round(sourceRect[key]*10000)/100);target.inputRendered[key]=input.value;delete target.inputForced[key];}}
        for(const key of ['flipX','flipY'])if(target.flips?.[key])target.flips[key].setAttribute('aria-pressed',String(!!target.item.creative?.[key]));
        if(target.scaling&&doc.activeElement!==target.scaling)target.scaling.value=sourceFit(target);
      }
      for(const map of target.maps||[])map.refresh();
    }
    function values(target){
      const rect={},base=pose(target);let alpha;
      for(const [key,,scale] of fields){const raw=target.inputs[key].value;if(raw===''||!Number.isFinite(Number(raw)))throw Error('Enter finite numbers for position, size, rotation and opacity.');
        // Inspector formatting is a display choice. An untouched rounded field
        // must never quantize another axis while editing opacity or position.
        const forced=target.forced[key],number=forced&&forced.raw===raw?forced.value:raw===target.rendered[key]?(key==='opacity'?opacity(target):base[key]):Number(raw)/scale;
        if(key==='opacity')alpha=number;else rect[key]=number;}
      if(alpha<0||alpha>1)throw Error('Opacity must be between 0 and 100%.');
      const selected={},sourceRect=inputPose(target);
      for(const [key] of inputFields){const input=target.inputInputs?.[key];if(!input){selected[key]=sourceRect[key];continue;}const raw=input.value;
        if(raw===''||!Number.isFinite(Number(raw)))throw Error('Enter finite numbers for the input selection.');
        const forced=target.inputForced[key];selected[key]=forced&&forced.raw===raw?forced.value:raw===target.inputRendered[key]?sourceRect[key]:Number(raw)/100;}
      if(selected.x<0||selected.y<0||selected.w<=0||selected.h<=0||selected.x+selected.w>1+1e-10||selected.y+selected.h>1+1e-10)throw Error('Keep the input selection inside the source, with positive width and height.');
      return {rect:target.bound?base:studio.freeTransform(rect),alpha:target.bound?opacity(target):alpha,inputSelection:selected};
    }
    function adopt(target){target.item=target.scene.slots[target.index];target.sourceId=target.item?.sourceId;}
    async function apply(target){
      if(target.busy){target.queued=true;return;}
      let next;try{check(target);next=values(target);}catch(error){say(target,error.message);return;}
      const revision=target.revision,base=pose(target),poseChanged=Object.keys(base).some(key=>base[key]!==next.rect[key]),alphaChanged=opacity(target)!==next.alpha,
        inputChanged=Object.keys(next.inputSelection).some(key=>inputPose(target)[key]!==next.inputSelection[key]);
      if(!poseChanged&&!alphaChanged&&!inputChanged){target.dirty=false;say(target,'');sync(target);return;}
      target.busy=true;target.queued=false;say(target,'');
      try{
        if(poseChanged&&!alphaChanged&&!inputChanged){check(target);if(studio.updateFreeSource(target.scene.id,target.index,{transform:next.rect})===false)throw Error('The transform could not be saved.');adopt(target);onChange?.();}
        if(alphaChanged||inputChanged){check(target);const expected=target.item;
          await studio.editCreativeLayer(target.scene.id,editKey(target),{...(poseChanged?{transform:next.rect}:{}),...(alphaChanged?{creative:{opacity:next.alpha}}:{}),...(inputChanged?{inputSelection:next.inputSelection}:{})},{expected,isCurrent:()=>current(target)&&!reason(target)});
          // An async opacity edit can finish after the inspector is destroyed or
          // switched. The model guard owns cancellation; never adopt another row.
          if(destroyed||state!==target)return;adopt(target);onChange?.();
        }
        if(target.revision===revision)target.dirty=false;
      }catch(error){say(target,error.message||String(error));}
      finally{target.busy=false;if(!destroyed&&state===target){sync(target);if(target.queued){target.queued=false;void apply(target);}}}
    }
    function change(target,immediate,key){
      if(destroyed||state!==target)return;delete target.forced[key];target.revision++;target.dirty=true;cancelTimer();
      syncEffects(target);
      if(immediate)void apply(target);else timer=setTimeout(()=>{timer=null;void apply(target);},180);
    }
    function button(parent,label,target,run,guard=true){const node=make('button',parent,label,'btn');node.type='button';node.addEventListener('click',()=>{
      try{if(!current(target)||!enabled())throw Error('The selected layer changed. Select it again.');if(guard)check(target);const result=run();result?.catch?.(error=>say(target,error.message));}catch(error){say(target,error.message);}
    });return node;}
    function action(target,label,transform){const node=button(target.actionHost,label,target,()=>{
      const why=outputReason(target);if(why)throw Error(why);
      cancelTimer();const base=pose(target),rect=transform(base);for(const [key,,scale] of fields)if(key!=='opacity'){
        const input=target.inputs[key];input.value=String(rect[key]*scale);
        if(rect[key]!==base[key])target.forced[key]={raw:input.value,value:rect[key]};else{target.rendered[key]=input.value;delete target.forced[key];}
      }target.revision++;target.dirty=true;return apply(target);
    });target.actions.push(node);target.outputActions.push(node);}
    function setInput(target,rect){
      cancelTimer();for(const [key] of inputFields){const input=target.inputInputs[key];input.value=String(rect[key]*100);target.inputForced[key]={raw:input.value,value:rect[key]};}
      target.revision++;target.dirty=true;return apply(target);
    }
    async function flip(target,key){
      check(target);const why=outputReason(target);if(why)throw Error(why);if(target.busy||target.dirty)throw Error('Finish the current edit before flipping the output.');
      say(target,'');target.busy=true;try{await studio.editCreativeLayer(target.scene.id,target.key,{creative:{[key]:!target.item.creative?.[key]}},{expected:target.item,isCurrent:()=>current(target)&&!reason(target)});
        if(destroyed||state!==target)return;adopt(target);onChange?.();
      }finally{target.busy=false;if(state===target){sync(target);if(target.queued){target.queued=false;void apply(target);}}}
    }
    async function setScaling(target,value){
      check(target);if(target.busy||target.dirty)throw Error('Finish the current edit before changing scaling.');
      say(target,'');if(value===sourceFit(target))return;
      target.busy=true;try{await studio.editCreativeLayer(target.scene.id,editKey(target),{outputFit:value},{expected:target.item,isCurrent:()=>current(target)&&!reason(target)});
        if(destroyed||state!==target)return;adopt(target);onChange?.();
      }finally{target.busy=false;if(state===target){target.scaling.value=sourceFit(target);sync(target);if(target.queued){target.queued=false;void apply(target);}}}
    }
    function chooseStage(target,value){stage=value;for(const name of ['input','output']){target.panels[name].hidden=name!==stage;target.tabs[name].setAttribute('aria-selected',String(name===stage));target.tabs[name].tabIndex=name===stage?0:-1;}for(const map of target.maps)map.refresh();}
    function buildMapping(target){
      target.toolbar=make('div',root,undefined,'bc-source-map-toolbar');const tabs=make('div',target.toolbar,undefined,'bc-source-map-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Source mapping stages');target.tabs={};target.panels={};target.maps=[];
      for(const [name,label] of [['input','Input Selection'],['output','Output Transformation']]){
        const tab=button(tabs,label,target,()=>chooseStage(target,name),false);tab.setAttribute('role','tab');tab.id='source-mapping-tab-'+name;tab.setAttribute('aria-controls','source-mapping-panel-'+name);target.tabs[name]=tab;
        tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'input':event.key==='End'?'output':name==='input'?'output':'input';chooseStage(target,next);target.tabs[next].focus();});
        const panel=make('section',root,undefined,'bc-source-map-panel');panel.id='source-mapping-panel-'+name;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);target.panels[name]=panel;
      }
      return target.panels.output;
    }
    function attachMap(target,name,parent){
      const host=make('div',parent,undefined,'bc-source-map-host');
      if(!window.OpenLiveSourceMapping)return host;
      const map=window.OpenLiveSourceMapping.mount({root:host,stage:name,getAspect:()=>name==='input'?sourceAspect(target):16/9,
        getKey:()=>current(target)?target.item:null,getRect:()=>name==='input'?inputPose(target):pose(target),
        enabled:()=>current(target)&&!(name==='output'?outputReason(target):reason(target))&&stage===name&&!target.busy&&!target.dirty,
        render:(canvas,draftRect)=>{if(!current(target)||stage!==name)return false;return name==='input'?studio.renderSourceInput(canvas,target.scene.id,target.index):studio.renderCreativeLayer(canvas,target.scene.id,editKey(target),{}, {timeMs:doc.defaultView?.performance?.now()||0,...(target.bound?{}:{transform:draftRect})});},
        commit:async rect=>{check(target);const why=name==='output'?outputReason(target):reason(target);if(why)throw Error(why);if(target.busy||target.dirty)throw Error('Finish the current edit before dragging.');
          say(target,'');target.busy=true;try{await studio.editCreativeLayer(target.scene.id,editKey(target),name==='input'?{inputSelection:rect}:{transform:rect},{expected:target.item,isCurrent:()=>current(target)&&!(name==='output'?outputReason(target):reason(target))});
            if(destroyed||state!==target)return;adopt(target);onChange?.();
          }finally{target.busy=false;if(state===target)sync(target);}},report:message=>say(target,message)});target.maps.push(map);return host;
    }
    function buildInput(target){
      const panel=target.panels.input,body=make('div',panel,undefined,'bc-source-map-body');attachMap(target,'input',body);
      const form=make('form',body,undefined,'bc-source-input-fields'),rect=inputPose(target);target.inputInputs={};target.inputRendered={};target.inputForced={};
      for(const [key,label] of inputFields){const short=label.replace('Input ','');const wrap=make('label',form,short[0].toUpperCase()+short.slice(1)),input=make('input',wrap);input.type='number';input.step='0.1';input.min=key==='w'||key==='h'?'0.1':'0';input.max='100';input.setAttribute('aria-label',label);input.value=String(Math.round(rect[key]*10000)/100);target.inputInputs[key]=input;target.inputRendered[key]=input.value;
        const edited=immediate=>{delete target.inputForced[key];change(target,immediate,'input-'+key);};input.addEventListener('input',()=>edited(false));input.addEventListener('change',()=>edited(true));}
      form.addEventListener('submit',event=>{event.preventDefault();cancelTimer();void apply(target);});
      const actions=make('div',panel,undefined,'bc-source-map-presets');
      for(const [label,rect] of [['Whole source',{x:0,y:0,w:1,h:1}],['Center crop',{x:.25,y:.25,w:.5,h:.5}],['Left half',{x:0,y:0,w:.5,h:1}],['Right half',{x:.5,y:0,w:.5,h:1}],['Top half',{x:0,y:0,w:1,h:.5}],['Bottom half',{x:0,y:.5,w:1,h:.5}]])target.actions.push(button(actions,label,target,()=>setInput(target,rect)));
      make('p',panel,'Drag frame or corners · Arrow keys nudge · Shift for larger steps','bc-source-map-caption');
      chooseStage(target,stage);
    }
    function build(next){
      cancelTimer();for(const map of state?.maps||[])map.destroy();root.replaceChildren();state=null;
      if(!next?.scene||!next.row||!studio.scenes().includes(next.scene))return;
      const row=next.row,item=rowItem(row),target={scene:next.scene,key:next.key,index:row.index,item,bound:!row.slot&&!!row.boundSlot,part:row.part,widget:row.widget,overlay:row.overlay,component:row.component,
        sourceId:item?.sourceId,free:free(next.scene),inputs:{},rendered:{},forced:{},actions:[],outputActions:[],dirty:false,busy:false,queued:false,revision:0};state=target;
      root.classList.add('bc-layer-source-controls');
      target.hint=make('p',root,'','bc-layer-inspector-hint');
      if(target.item){
        buildEffects(target);
        const runtime=studio.sources.get(target.sourceId),type=creativeTypes[runtime?.sourceType];
        if(type){
          make('strong',root,type);make('p',root,creativeDescription(runtime),'bc-layer-inspector-hint');
          const controls=runtime.creativeControls;
          if(runtime.sourceType==='countdown'&&controls&&['state','start','pause','reset'].every(name=>typeof controls[name]==='function')){
            target.runtimeSource=runtime;target.clock=controls;
            target.clockHost=make('div',root,undefined,'bc-layer-inspector-actions');target.clockHost.setAttribute('role','group');target.clockHost.setAttribute('aria-label','Countdown controls');
            target.clockValue=make('output',target.clockHost);target.clockValue.setAttribute('aria-label','Countdown remaining');target.clockValue.style.gridColumn='1 / -1';
            target.clockActions={};
            for(const [action,label] of [['start','Start'],['pause','Pause'],['reset','Reset']]){
              target.clockActions[action]=button(target.clockHost,label,target,()=>{
                if(studio.sources.get(target.sourceId)!==runtime||runtime.creativeControls!==controls)throw Error('The countdown source changed. Select it again.');
                if(!studio.sourceStatus(runtime).ok||controls[action]()===false)throw Error('The countdown source is unavailable.');
                syncCountdown(target,reason(target));onChange?.();
              });
              target.clockActions[action].setAttribute('aria-label',label+' countdown');
            }
            make('p',root,'Controls affect this reusable source in Preview. Cut/Fade publishes its current clock.','bc-layer-inspector-hint');
          }
        }
        const output=buildMapping(target),body=make('div',output,undefined,'bc-source-map-body'),mapHost=attachMap(target,'output',body);
        const scalingLabel=make('label',mapHost,'Auto Size','bc-source-map-scaling'),scaling=make('select',scalingLabel);target.scaling=scaling;scaling.setAttribute('aria-label','Output auto size');
        scaling.title='Off: native size · Fit: whole picture · Fill: crop to frame · Stretch: match frame';
        for(const [value,label] of [['off','Off'],['contain','Fit'],['cover','Fill'],['stretch','Stretch']]){const option=make('option',scaling,label);option.value=value;}
        scaling.value=sourceFit(target);target.actions.push(scaling);scaling.addEventListener('change',()=>{void setScaling(target,scaling.value).catch(error=>{say(target,error.message);if(state===target)scaling.value=sourceFit(target);});});
        const form=make('form',body,undefined,'bc-layer-inspector-fields');let rect;try{rect=pose(target);}catch(_){rect={x:0,y:0,w:1,h:1,rotation:0};}
        for(const [key,label,scale] of fields){const wrap=make('label',form,label),input=make('input',wrap);input.type='number';input.step='0.01';input.setAttribute('aria-label',label);
          if(key==='w'||key==='h')input.min='1';if(key==='opacity'){input.min='0';input.max='100';}
          input.value=String(Math.round((key==='opacity'?opacity(target):rect[key])*scale*100)/100);target.inputs[key]=input;target.rendered[key]=input.value;
          input.addEventListener('input',()=>change(target,false,key));input.addEventListener('change',()=>change(target,true,key));
        }
        form.addEventListener('submit',event=>{event.preventDefault();cancelTimer();void apply(target);});
        target.actionHost=make('div',output,undefined,'bc-layer-inspector-actions');
        action(target,'Reset transform',()=>defaultPose(target));
        for(const edge of ['left','center','right','top','middle','bottom'])action(target,'Align '+edge,rect=>align(rect,edge));
        const flips=make('div',output,undefined,'bc-source-map-flips');target.flips={};for(const [key,label] of [['flipX','Flip horizontal'],['flipY','Flip vertical']]){const node=button(flips,label,target,()=>flip(target,key));node.setAttribute('aria-pressed','false');target.flips[key]=node;target.actions.push(node);target.outputActions.push(node);}
        buildInput(target);
        const sourceProperties=target.bound||free(target.scene),properties=sourceProperties?openProperties:openContent;
        if(typeof properties==='function'){const label=sourceProperties?'Properties':'Open editor',edit=button(target.toolbar,label,target,()=>properties(selection()),false);edit.classList.add('bc-source-map-properties');edit.title=label;}
      }else if(typeof openContent==='function')button(root,'Open editor',target,()=>openContent(selection()),false);
      target.status=make('p',root,'','bc-layer-inspector-status');target.status.setAttribute('role','status');target.status.setAttribute('aria-live','polite');sync(target);
    }
    function refresh(){
      if(destroyed)return;const next=selection();
      if(!state&&!next)return;
      // Effect chains own their controls. Adopting an effect-only slot change
      // keeps a focused mapping field and any uncommitted numeric draft intact.
      if(state&&next?.scene===state.scene&&next.key===state.key&&rowItem(next.row)!==state.item&&rowItem(next.row)?.sourceId===state.sourceId&&free(next.scene)===state.free){
        const withoutEffects=item=>{if(!item)return null;const {effects,...rest}=item;return JSON.stringify(rest);};
        if(withoutEffects(rowItem(next.row))===withoutEffects(state.item))adopt(state);
      }
      if(!state||!next||next.scene!==state.scene||next.key!==state.key||free(next.scene)!==state.free||rowItem(next.row)!==state.item||next.row?.part!==state.part||next.row?.widget!==state.widget||next.row?.overlay!==state.overlay||next.row?.component!==state.component||rowItem(next.row)?.sourceId!==state.sourceId||state.runtimeSource&&studio.sources.get(state.sourceId)!==state.runtimeSource)build(next);
      else sync(state);
    }
    return {refresh,refreshRuntime(){if(!destroyed&&state&&current(state)){if(state.clockHost)syncCountdown(state,reason(state));for(const map of state.maps||[])map.refresh();}},destroy(){destroyed=true;cancelTimer();for(const map of state?.maps||[])map.destroy();state=null;root.replaceChildren();}};
  }
  return Object.freeze({mount});
})();
