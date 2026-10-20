/* Broadcast uses SHOWAVE Live's real effect and procedural-source registries. */
window.OpenLiveEffectsDrawer=(()=>{
  'use strict';
  let nextDrawer=0;
  const number=value=>typeof value==='number'&&Number.isFinite(value);
  function categoryFor(entry,tab){
    if(entry.category)return entry.category;
    const name=entry.name||entry.label||'';
    if(tab==='generators')return /Text|Type/i.test(name)?'Text':/Color|Gradient|Static|Noise/i.test(name)?'Color & texture':/Shape|Ring|Meta|Spiral/i.test(name)?'Shapes':/Router|Feedback|Slice|Blank|Test/i.test(name)?'Utility':'Patterns';
    return /Color|Colour|Hue|Saturat|Bright|Contrast|Exposure|Invert|Key|Mask|Threshold|Levels|LUT|RGB/i.test(name)?'Color & key':/Blur|Bloom|Sharpen|Glow|Edge|LoRez|Pixel|Detail/i.test(name)?'Blur & detail':/Delay|Trail|Echo|Strob|Stop|Time|Freeze/i.test(name)?'Time & motion':/Transform|Crop|Mirror|Flip|Kaleid|Rotate|Zoom|Slide|Tile|Warp|Displace|Distort|Tunnel/i.test(name)?'Geometry':'Other effects';
  }
  function mount({studio,root,getScene,getSelection,enabled=()=>true,onChange,onSelectSource,onSelectScene,onSelectTemplate}){
    const doc=root.ownerDocument,create=(tag,parent,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;parent.appendChild(node);return node;};
    const shell=create('section',root,undefined,'bc-effects-library');shell.setAttribute('aria-label','Effects and generators');
    const drawerId=++nextDrawer,tabs=create('div',shell,undefined,'bc-effects-tabs ptabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Effects and generators');
    const historyRow=create('div',shell,undefined,'bc-effects-history');
    const targetLine=create('div',shell,undefined,'bc-effects-target');
    const workspace=create('div',shell,undefined,'bc-effects-workspace');workspace.setAttribute('role','tabpanel');workspace.id='bc-effects-panel-'+drawerId;
    const status=create('p',shell,'','bc-effects-status');status.setAttribute('role','status');
    let tab='effects',busy=false,destroyed=false,signature='',nextIdentity=0,expanded=new Set(),cache={};
    let sportsHost=null,sportsLibrary=null,childTab=null;
    function clearChild(){sportsLibrary?.destroy();sportsLibrary=null;sportsHost=null;childTab=null;}
    const identities=new WeakMap(),filters={effects:{query:'',category:'all'},generators:{query:'',category:'all'}};
    const identity=value=>{if(!value||typeof value!=='object')return null;if(!identities.has(value))identities.set(value,++nextIdentity);return identities.get(value);};
    const adapter=()=>window.OpenLiveEffects;
    const say=message=>{if(!destroyed)status.textContent=message||'';};
    const live=()=>typeof enabled==='function'?enabled():enabled!==false;
    const sceneValid=scene=>!!scene&&getScene()===scene&&studio.scenes().includes(scene)&&live();
    const btn=(parent,label,fn,cls='btn')=>{const node=create('button',parent,label,cls);node.type='button';if(fn)node.addEventListener('click',()=>{if(node.disabled||!shell.contains(node))return;try{fn();}catch(error){say(error.message||String(error));}});return node;};
    const iconBtn=(parent,label,type,fn)=>{const node=btn(parent,'',fn);node.setAttribute('aria-label',label);node.title=label;window.OpenLiveSourceIcons?.prepend(node,type);return node;};
    const tabButtons={};
    const tabValues=['effects','generators','library','audience'];
    for(const [value,label] of [['effects','Effects'],['generators','Generators'],['library','Library'],['audience','Audience']]){
      const button=btn(tabs,label,()=>show(value),'ptab');button.id='bc-effects-tab-'+drawerId+'-'+value;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(value===tab));button.setAttribute('aria-controls',workspace.id);tabButtons[value]=button;
      button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=tabValues.indexOf(tab);show(event.key==='Home'?tabValues[0]:event.key==='End'?tabValues.at(-1):tabValues[(index+(event.key==='ArrowLeft'?-1:1)+tabValues.length)%tabValues.length]);tabButtons[tab].focus();});
    }
    const historyButtons=[false,true].map(redo=>{
      const button=btn(historyRow,redo?'Redo':'Undo',()=>{
        const scene=getScene();return perform(null,async()=>{if(!sceneValid(scene))throw Error('The editing scene changed.');const changed=await studio.stepCreativeHistory(scene.id,redo,{isCurrent:()=>!destroyed&&sceneValid(scene)});if(!changed)throw Error('No '+(redo?'redo':'undo')+' is available.');return changed;},redo?'Redid the last scene edit.':'Undid the last scene edit.');
      });button.setAttribute('aria-label',(redo?'Redo':'Undo')+' effect or generator edit');button.title=(redo?'Redo':'Undo')+' the latest source edit in this Preview scene';return button;
    });
    function selection(){
      const scene=getScene(),value=getSelection?.(),row=value?.row,index=row?.index??(value?.key?.startsWith('source:')?Number(value.key.slice(7)):null),slot=Number.isInteger(index)?scene?.slots?.[index]:null;
      if(row&&!row.slot)return null;
      if(value?.scene!==scene||!slot||row?.slot&&row.slot!==slot)return null;
      return {scene,index,slot,key:'source:'+index,source:studio.sources.get(slot.sourceId),label:row?.label||slot.label||studio.sources.get(slot.sourceId)?.label||'Source'};
    }
    function targetCurrent(target){
      const current=selection();return !destroyed&&sceneValid(target.scene)&&current?.index===target.index&&current.slot===target.slot&&current.source===target.source;
    }
    function targetReason(target){
      if(!live())return 'Open Scene Preview to edit effects and generators.';
      if(!target)return 'Select a picture source in Preview to edit its effects.';
      if(target.slot.locked)return 'Unlock this source to edit its effects and generator.';
      if(!target.source)return 'This source is no longer available.';
      if(target.source.audioOnly)return 'Audio-only sources have no video effects.';
      if(target.scene.fullTemplateId||target.scene.svgParts?.some(part=>part.sourceSlot===target.index))return 'This source belongs to native artwork. Select an independent picture source.';
      return '';
    }
    function editOptions(target){return {expected:target.slot,isCurrent:()=>targetCurrent(target)};}
    async function perform(target,operation,message,after){
      if(busy||destroyed)return;
      try{
        if(target){if(!targetCurrent(target))throw Error('The selected source changed. Select it again.');const why=targetReason(target);if(why)throw Error(why);}
        busy=true;say('');refresh();const result=await operation();
        if(destroyed)return;
        after?.(result);onChange?.();say(message);
      }catch(error){say(error.message||String(error));}
      finally{busy=false;if(!destroyed){signature='';refresh();}}
    }
    function catalog(){
      if(!cache[tab]){const list=tab==='effects'?adapter()?.effectCatalog?.():adapter()?.generatorCatalog?.();if(list)cache[tab]=list;}
      return cache[tab]||[];
    }
    function entry(name,type=tab){const entries=cache[type]||(type==='effects'?adapter()?.effectCatalog?.():adapter()?.generatorCatalog?.())||[];return entries.find(item=>item.name===name);}
    function effectEdit(target,id,patch,message='Effect updated in Preview.'){
      const effect=target?.slot.effects?.find(item=>item.id===id);
      if(effect&&Object.entries(patch).every(([key,value])=>key==='params'?Object.entries(value).every(([name,next])=>effect.params?.[name]===next):effect[key]===value))return;
      return perform(target,()=>studio.updateSourceEffect(target.scene.id,target.index,id,patch,editOptions(target)),message);
    }
    function generatorEdit(target,key,value){
      if(target.slot.generator?.params?.[key]===value)return;
      return perform(target,()=>studio.updateGeneratorSource(target.scene.id,target.index,{params:{[key]:value}},editOptions(target)),'Generator updated in Preview.');
    }
    function renderStatus(target){try{return target&&(typeof studio.sourceEffectStatus==='function'?studio.sourceEffectStatus(target.scene.id,target.index):adapter()?.status?.(target.slot));}catch(error){return {ok:false,reason:error.message};}}
    function field(parent,spec,value,commit,disabled,prefix){
      const row=create('label',parent,undefined,'bc-effects-param'),label=create('span',row,spec.label||spec.key),holder=create('span',row,undefined,'bc-effects-value');
      const kind=spec.kind||'range',key=spec.key||spec.label,aria=prefix+' '+(spec.label||key),reason=spec.unwired||spec.reason||(kind==='event'?'Momentary triggers are not available in this drawer.':'');
      if(reason){row.classList.add('is-unavailable');row.title=reason;label.title=reason;}
      const blocked=disabled||!!reason,bind=(node,read)=>{node.disabled=blocked;node.setAttribute('aria-label',aria);node.addEventListener('change',()=>{if(node.disabled||!workspace.contains(node))return;try{commit(read());}catch(error){say(error.message);}});return node;};
      if(Object.prototype.hasOwnProperty.call(spec,'default')&&['range','number','bool','choice','text','string','color'].includes(kind)){
        if(!reason)row.title='Right-click to reset '+(spec.label||key)+' to its default. Shift + F10 also resets.';
        const reset=event=>{if(blocked||!workspace.contains(row))return;event.preventDefault();event.stopPropagation();commit(spec.default);};
        row.addEventListener('contextmenu',reset);row.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')reset(event);});
      }
      if(kind==='bool'){
        const input=create('input',holder);input.type='checkbox';input.checked=!!value;bind(input,()=>input.checked);
      }else if(kind==='choice'){
        const select=create('select',holder),values=spec.options||[];
        values.forEach((option,index)=>{const item=create('option',select,spec.optionLabels?.[index]??String(option));item.value=String(index);});
        select.value=String(Math.max(0,values.findIndex(option=>option===value)));bind(select,()=>values[Number(select.value)]);
        if(!values.length){select.disabled=true;row.title=reason||'No supported choices are available.';}
      }else if(kind==='text'||kind==='string'){
        const input=create('input',holder);input.type='text';input.value=String(value??'');input.maxLength=4096;bind(input,()=>input.value);
      }else if(kind==='color'){
        const packed=Number(value??0xffffffff)>>>0,color=create('input',holder),alpha=create('input',holder);color.type='color';color.value='#'+(packed&0xffffff).toString(16).padStart(6,'0');
        alpha.type='number';alpha.min='0';alpha.max='100';alpha.step='1';alpha.value=String(Math.round((packed>>>24)/255*100));alpha.title='Color opacity (%)';
        const read=()=>{const opacity=Number(alpha.value);if(!number(opacity)||opacity<0||opacity>100)throw Error('Color opacity must be between 0 and 100%.');return ((Math.round(opacity/100*255)<<24)|parseInt(color.value.slice(1),16))>>>0;};
        bind(color,read);bind(alpha,read);alpha.setAttribute('aria-label',aria+' opacity (%)');
      }else if(kind==='range'||kind==='number'){
        const multiplier=number(spec.multiplier)&&spec.multiplier!==0?spec.multiplier:1,min=spec.min,max=spec.max,input=create('input',holder);input.type='number';input.step=spec.step?String(spec.step*multiplier):'any';
        if(number(min))input.min=String(min*multiplier);if(number(max))input.max=String(max*multiplier);input.value=String(number(value)?Number((value*multiplier).toFixed(6)):spec.default??0);
        if(spec.suffix)label.textContent+=' ('+spec.suffix+')';
        const read=()=>{if(!input.value.trim())throw Error('Enter a value for '+(spec.label||key)+'.');const result=Number(input.value)/multiplier;if(!number(result))throw Error('Enter a valid number.');return result;};
        bind(input,read);
        if(number(min)&&number(max)&&max>min){
          // A range-derived step can quantize valid factory values (e.g.
          // Checkered's 32 within 1..100000). Only the schema defines a step.
          const slider=create('input',holder);slider.type='range';slider.min=String(min);slider.max=String(max);slider.step=number(spec.step)&&spec.step>0?String(spec.step):'any';slider.value=String(number(value)?value:spec.default??min);
          slider.disabled=blocked;slider.setAttribute('aria-label',aria+' slider');slider.addEventListener('input',()=>{input.value=String(Number((Number(slider.value)*multiplier).toFixed(6)));});slider.addEventListener('change',()=>{if(!slider.disabled&&workspace.contains(slider))commit(Number(slider.value));});input.addEventListener('input',()=>{if(number(Number(input.value)))slider.value=String(Number(input.value)/multiplier);});
        }
      }else{
        create('span',holder,'Unavailable','bc-effects-param-unavailable');row.title=reason||'This parameter needs a resource picker that is not available here.';
      }
      if(reason)create('small',row,reason,'bc-effects-param-reason');
    }
    function params(parent,specs,values,commit,disabled,prefix){
      const host=create('div',parent,undefined,'bc-effects-params');let group='';
      for(const spec of specs||[]){if(spec.group&&spec.group!==group){group=spec.group;create('h4',host,group,'bc-effects-param-group');}field(host,spec,values?.[spec.key]??spec.default,value=>commit(spec.key,value),disabled,prefix);}
      return host;
    }
    function drawEffects(target){
      const chain=create('section',workspace,undefined,'bc-effects-chain'),head=create('header',chain,undefined,'bc-effects-section-head mon-head'),effects=target?.slot.effects||[],why=targetReason(target);
      create('strong',head,'Source effects');create('span',head,String(effects.length));
      if(why)create('p',chain,why,'bc-effects-empty');else if(!effects.length)create('p',chain,'Add an effect below. Effects process from top to bottom.','bc-effects-empty');
      const health=renderStatus(target);if(health?.ok===false)create('p',chain,health.reason||'An effect could not render.','bc-effects-notice');
      effects.forEach((effect,index)=>{
        const descriptor=entry(effect.name,'effects'),card=create('section',chain,undefined,'bc-effect-card fx'),heading=create('header',card,undefined,'bc-effect-head fxhead');card.classList.toggle('is-bypassed',!!effect.bypassed);card.setAttribute('data-effect-id',effect.id);
        const bypass=iconBtn(heading,(effect.bypassed?'Enable ':'Bypass ')+effect.name,effect.bypassed?'invisible':'visible',()=>effectEdit(target,effect.id,{bypassed:!effect.bypassed}));bypass.setAttribute('aria-pressed',String(!effect.bypassed));bypass.disabled=busy||!!why;
        const name=btn(heading,effect.name,()=>{expanded.has(effect.id)?expanded.delete(effect.id):expanded.add(effect.id);signature='';refresh();},'btn bc-effect-name');name.setAttribute('aria-expanded',String(expanded.has(effect.id)));
        const up=iconBtn(heading,'Move '+effect.name+' up','up',()=>perform(target,()=>studio.moveSourceEffect(target.scene.id,target.index,effect.id,-1,editOptions(target)),'Effect order updated.'));up.disabled=busy||!!why||index===0;
        const down=iconBtn(heading,'Move '+effect.name+' down','down',()=>perform(target,()=>studio.moveSourceEffect(target.scene.id,target.index,effect.id,1,editOptions(target)),'Effect order updated.'));down.disabled=busy||!!why||index===effects.length-1;
        const remove=iconBtn(heading,'Remove '+effect.name,'remove',()=>perform(target,()=>studio.removeSourceEffect(target.scene.id,target.index,effect.id,editOptions(target)),'Effect removed from Preview.'));remove.disabled=busy||!!why;
        if(!expanded.has(effect.id))return;
        const unavailable=descriptor?.available===false;
        if(unavailable)create('p',card,descriptor.reason||'This effect is unavailable.','bc-effects-notice');else if(descriptor?.warning)create('p',card,descriptor.warning,'bc-effects-notice');
        field(card,{key:'opacity',label:'Opacity',kind:'range',min:0,max:1,default:1,multiplier:100,suffix:'%'},effect.opacity??1,value=>effectEdit(target,effect.id,{opacity:value}),busy||!!why||unavailable,effect.name);
        const blends=adapter()?.blends?.()||adapter()?.blendModes||['Alpha'];
        if(blends.length>1)field(card,{key:'blend',label:'Blend',kind:'choice',options:blends},effect.blend||'Alpha',value=>effectEdit(target,effect.id,{blend:value}),busy||!!why||unavailable,effect.name);
        params(card,descriptor?.params||[],effect.params,(key,value)=>effectEdit(target,effect.id,{params:{[key]:value}}),busy||!!why||unavailable,effect.name);
      });
    }
    function drawGenerator(target){
      const generator=target?.slot.generator;if(!generator)return;
      const descriptor=entry(generator.name,'generators'),section=create('section',workspace,undefined,'bc-effects-generator');
      const head=create('header',section,undefined,'bc-effects-section-head mon-head');create('strong',head,generator.name);create('span',head,'Selected source');
      const why=targetReason(target);if(why)create('p',section,why,'bc-effects-notice');if(descriptor?.warning)create('p',section,descriptor.warning,'bc-effects-notice');
      const health=renderStatus(target);if(health?.ok===false)create('p',section,health.reason||'This generator could not render.','bc-effects-notice');
      params(section,descriptor?.params||[],generator.params,(key,value)=>generatorEdit(target,key,value),busy||!!why||descriptor?.available===false,generator.name);
    }
    function drawBrowser(target){
      const browser=create('section',workspace,undefined,'bc-effects-browser'),heading=create('header',browser,undefined,'bc-effects-section-head mon-head');create('strong',heading,tab==='effects'?'Add effect':'Add generator');
      const all=catalog(),filter=filters[tab],controls=create('div',browser,undefined,'bc-effects-filters'),search=create('input',controls);search.type='search';search.value=filter.query;search.placeholder=tab==='effects'?'Search effects':'Search generators';search.setAttribute('aria-label',search.placeholder);
      const category=create('select',controls);category.setAttribute('aria-label',tab==='effects'?'Effect category':'Generator category');
      const categories=[['all','All categories'],...[...new Set(all.map(item=>categoryFor(item,tab)))].sort().map(name=>[name,name]),['unavailable','Unavailable']];
      for(const [value,label] of categories){const option=create('option',category,label);option.value=value;}category.value=filter.category;
      const list=create('div',browser,undefined,'bc-effects-results');list.setAttribute('aria-label',tab==='effects'?'Effect library':'Generator library');
      function paint(){
        list.replaceChildren();const words=filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean),entries=all.filter(item=>(filter.category==='all'||filter.category==='unavailable'&&!item.available||categoryFor(item,tab)===filter.category)&&words.every(word=>String(item.label+' '+item.name+' '+item.description+' '+categoryFor(item,tab)).toLowerCase().includes(word))).sort((a,b)=>Number(!!b.available)-Number(!!a.available)||a.label.localeCompare(b.label));
        for(const item of entries){
          const row=create('div',list,undefined,'bc-effects-entry');row.classList.toggle('is-unavailable',!item.available);
          const text=create('div',row,undefined,'bc-effects-entry-copy');create('strong',text,item.label||item.name);create('span',text,item.available?categoryFor(item,tab):'Unavailable','bc-effects-entry-meta');
          const description=item.available?item.description:item.reason||'This item is unavailable in Broadcast.';if(description)create('p',text,description);
          if(item.available&&item.warning)create('small',text,item.warning,'bc-effects-entry-warning');
          row.title=[item.label||item.name,description,item.available&&item.warning].filter(Boolean).join('\n');
          const reason=tab==='effects'?targetReason(target)||((target?.slot.effects?.length||0)>=16?'A source supports up to 16 effects.':''):!sceneValid(getScene())?'Choose an editable Preview scene.':getScene()?.layoutPending?'Choose a scene layout first.':'';
          const add=iconBtn(row,'Add '+(item.label||item.name),'plus',()=>{
            if(tab==='effects'){
              const before=new Set((target?.slot.effects||[]).map(effect=>effect.id));
              return perform(target,()=>studio.addSourceEffect(target.scene.id,target.index,item.name,editOptions(target)),'Added '+item.label+' to Preview.',()=>{for(const effect of target.scene.slots[target.index]?.effects||[])if(!before.has(effect.id))expanded.add(effect.id);});
            }
            const scene=getScene();return perform(null,()=>{if(!sceneValid(scene))throw Error('The editing scene changed.');return studio.addGeneratorSource(scene.id,item.name,{isCurrent:()=>!destroyed&&sceneValid(scene)});},'Added '+item.label+' to Preview.',index=>{if(sceneValid(scene))onSelectSource?.(index);});
          });
          add.disabled=busy||!item.available||!!reason;add.title=!item.available?description:reason||['Add '+item.label+' to Preview',description,item.warning].filter(Boolean).join('\n');row.setAttribute('aria-disabled',String(!item.available));
        }
        if(!entries.length)create('p',list,all.length?'No matches. Try another search or category.':'The SHOWAVE Live library is unavailable.','bc-effects-empty');
      }
      search.addEventListener('input',()=>{filter.query=search.value;paint();});category.addEventListener('change',()=>{filter.category=category.value;paint();});paint();
    }
    function refresh(){
      if(destroyed)return;const target=selection(),scene=getScene();
      const history=scene&&studio.creativeHistory?.(scene.id)||{canUndo:false,canRedo:false};
      if(tab==='library'||tab==='audience'){
        historyButtons.forEach((button,index)=>{button.setAttribute('aria-label',(index?'Redo':'Undo')+' library source edit');button.disabled=busy||!sceneValid(scene)||!(index?history.canRedo:history.canUndo);});
        targetLine.textContent='Preview · '+(scene?.name||'Choose a scene');
        if(childTab!==tab){clearChild();workspace.replaceChildren();sportsHost=create('div',workspace);childTab=tab;
          const module=tab==='audience'?window.OpenLiveAudienceEditor:window.OpenLiveProductionLibrary||window.OpenLiveSportsLibrary;
          sportsLibrary=module?.mount({studio,root:sportsHost,getScene,getSelection,enabled:()=>live()&&tab===childTab&&(!root.closest('details')||root.closest('details').open),onChange,onSelectSource,onSelectScene,onSelectTemplate});
          if(!sportsLibrary)create('p',sportsHost,'This workspace is unavailable. Reload the updated application.','bc-effects-status');
        }
        sportsLibrary?.refresh();return;
      }
      const next=JSON.stringify([tab,busy,live(),identity(scene),identity(target?.slot),identity(target?.source),target?.slot.effects,target?.slot.generator,target?.slot.locked,target?.source?.audioOnly,target?.label,scene?.layoutPending,renderStatus(target),history,[...expanded]]);
      if(next===signature)return;signature=next;
      historyButtons.forEach((button,index)=>{button.setAttribute('aria-label',(index?'Redo':'Undo')+' effect or generator edit');button.disabled=busy||!sceneValid(scene)||typeof studio.stepCreativeHistory!=='function'||!(index?history.canRedo:history.canUndo);});
      const focused=workspace.contains(doc.activeElement)?doc.activeElement.getAttribute('aria-label'):null,scroll=workspace.scrollTop||0;
      clearChild();
      workspace.replaceChildren();targetLine.textContent=target?'Preview · '+target.label:tab==='effects'?'Select a source to shape its picture':'Add a procedural source to Preview';
      if(tab==='effects')drawEffects(target);else drawGenerator(target);drawBrowser(target);workspace.scrollTop=scroll;
      if(focused)[...workspace.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focused)?.focus({preventScroll:true});
    }
    function show(next,effectId){
      if(!tabValues.includes(next)||destroyed)return;
      if(next==='effects'&&effectId&&selection()?.slot.effects?.some(effect=>effect.id===effectId))expanded.add(effectId);
      tab=next;for(const [value,button] of Object.entries(tabButtons)){button.setAttribute('aria-selected',String(value===tab));button.classList.toggle('on',value===tab);button.tabIndex=value===tab?0:-1;}workspace.setAttribute('aria-labelledby',tabButtons[tab].id);say('');signature='';refresh();
      if(next==='effects'&&effectId){const card=[...workspace.querySelectorAll('[data-effect-id]')].find(node=>node.getAttribute('data-effect-id')===effectId);card?.scrollIntoView?.({block:'nearest'});card?.querySelector('input:not(:disabled),select:not(:disabled)')?.focus({preventScroll:true});}
      else if(next==='effects')workspace.querySelector('input[type="search"]')?.focus({preventScroll:true});
    }
    show('effects');
    return {refresh,show,destroy(){if(destroyed)return;destroyed=true;clearChild();shell.remove();cache={};expanded.clear();}};
  }
  return Object.freeze({mount,categoryFor});
})();
