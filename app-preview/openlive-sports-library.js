/* Original broadcast graphics, authored as ordinary isolated Preview sources. */
window.OpenLiveSportsLibrary=(()=>{
  'use strict';
  function mount({studio,root,getScene,getSelection,enabled=()=>true,onChange,onSelectSource,onSelectScene,editorOnly=false,initialView='templates'}){
    const doc=root.ownerDocument,make=(tag,parent,text,cls)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;parent.appendChild(el);return el;};
    const shell=make('section',root,undefined,'bc-sports-library'+(editorOnly?' bc-sports-inspector':''));shell.setAttribute('aria-label',editorOnly?'Library source settings':'Production library');
    const body=make('div',shell),status=make('p',shell,'','bc-sports-status');status.setAttribute('role','status');
    let draft=window.OpenLiveSportsSources.normalize({preset:'scoreboard'}),mode='browse',target=null,busy=false,destroyed=false,lastScene,lastSource,lastSlot,proof=null,proofCanvas=null,cueState=null,rate=.5;
    let templateId='svg-5',graphicFrame=0,bindings=[],proofSerial=0,viewSerial=0,compositionProof=null,dialog=null,libraryView=initialView==='cues'?'cues':'templates',packName='Matchday';
    const tileProofs=new Set();
    const live=()=>!destroyed&&(typeof enabled==='function'?enabled():enabled!==false);
    const sceneCurrent=scene=>live()&&getScene()===scene&&studio.scenes().includes(scene)&&!scene.layoutPending;
    const selection=()=>{const value=getSelection?.(),scene=getScene(),index=value?.row?.index??Number(value?.key?.slice(7)),slot=scene?.slots?.[index],bound=value?.row?.boundSlot||value?.row?.slot,source=slot&&studio.sources.get(slot.sourceId);return value?.scene===scene&&Number.isInteger(index)&&slot&&(!bound||bound===slot)?{scene,index,slot,source,key:value.key}:null;};
    const targetCurrent=value=>{const current=selection();return sceneCurrent(value.scene)&&current?.scene===value.scene&&current.index===value.index&&current.slot===value.slot&&current.source===value.source;};
    const copy=value=>JSON.parse(JSON.stringify(value)),say=value=>{status.textContent=value||'';};
    function icon(parent,key){
      const paths={scoreboard:'M2 3h12v10H2z M6 3v10 M10 3v10 M3.5 7h1 M11.5 7h1',lineup:'M2 2h12v12H2z M8 2v12 M2 8h12 M5 5h1 M10 5h1 M5 11h1 M10 11h1',goal:'M2 5h12v8H2z M2 8h12 M6 5v8 M10 5v8 M6 2h4',substitution:'M2 5h11l-3-3 M14 11H3l3 3',stats:'M3 13V8 M8 13V3 M13 13V6 M1 14h14',replay:'M5 4l7 4-7 4z M2 3v10'};
      const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','bc-sports-icon');
      const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[key]||paths.replay);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.4');path.setAttribute('stroke-linejoin','round');path.setAttribute('stroke-linecap','round');svg.append(path);parent.append(svg);
    }
    function button(parent,label,fn,cls='btn'){
      const el=make('button',parent,label,cls);el.type='button';el.disabled=busy||!live();el.addEventListener('click',()=>{if(!el.disabled&&(shell.contains(el)||dialog?.contains(el)))try{fn();}catch(error){say(error.message);}});return el;
    }
    function heading(label,action){const head=make('header',body,undefined,'bc-effects-section-head mon-head');make('strong',head,label);if(editorOnly)return;if(action)button(head,'Library',()=>{mode='browse';target=null;draw();});else if(dialog)make('span',head,'Coordinated templates');else button(head,'Open workspace',openWorkspace);}
    function field(parent,label,value,kind,change,options){
      const row=make('label',parent,undefined,'bc-sports-field');make('span',row,label);
      const el=make(kind==='select'?'select':kind==='textarea'?'textarea':'input',row);el.setAttribute('aria-label',label);el.disabled=busy||!live();
      if(kind==='select'){for(const item of options){const [key,text]=Array.isArray(item)?item:[item,item],option=make('option',el,text);option.value=String(key);}el.value=String(value);}
      else if(kind==='textarea'){el.value=value;el.rows=4;el.maxLength=2000;}
      else{el.type=kind||'text';el.value=value;if(el.type==='text')el.maxLength=80;if(el.type==='number'){el.min='0';el.max='86400';el.step='1';}}
      el.addEventListener('input',()=>{if(el.disabled||!shell.contains(el))return;try{change(el.type==='number'?(el.value.trim()?Number(el.value):NaN):el.value);paintProof();}catch(error){say(error.message);}});
      return el;
    }
    function normalizeDraft(){return window.OpenLiveSportsSources.normalize(draft);}
    function clearProof(){proofSerial++;viewSerial++;proof?.dispose?.();proof=null;compositionProof?.cancel?.();compositionProof=null;for(const value of tileProofs)value.cancel?.();tileProofs.clear();proofCanvas=null;cueState=null;}
    const proofTime=()=>['goal','substitution','replay-title'].includes(draft.preset)?Math.min(1200,draft.duration*350):1800;
    async function paintProof(){
      if(!proofCanvas)return;
      const serial=++proofSerial,canvas=proofCanvas;proof?.dispose?.();proof=null;compositionProof?.cancel?.();compositionProof=null;
      try{
        const config=normalizeDraft();
        if(config.templateId&&studio.prepareSportsTemplateScene){
          const staged=await studio.prepareSportsTemplateScene({templateId:config.templateId,config,preset:config.preset,graphicFrame:config.frameIndex,bindings:bindingsFor(config.templateId)},{isCurrent:()=>!destroyed&&serial===proofSerial});
          if(destroyed||serial!==proofSerial){staged.cancel();return;}compositionProof=staged;staged.render(canvas,proofTime());
        }else{
          const value=window.OpenLiveSportsSources.create(config,{document:doc,now:()=>0});await value.prepare?.();
          if(destroyed||serial!==proofSerial){value.dispose?.();return;}proof=value;value.renderFrame(proofTime());const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(value.el,0,0,canvas.width,canvas.height);
        }
      }catch(error){if(serial===proofSerial&&!destroyed){compositionProof?.cancel?.();compositionProof=null;proof?.dispose?.();proof=null;say(error.message);}}
    }
    async function perform(operation,message){
      if(busy||!live())return;busy=true;say('');setBusy();
      try{await operation();if(destroyed)return;onChange?.();say(message);refresh();}
      catch(error){if(!destroyed)say(error.message||String(error));}
      finally{busy=false;if(!destroyed)setBusy();}
    }
    function setBusy(){for(const el of shell.querySelectorAll('button,input,select,textarea'))el.disabled=busy||!live()||!!target?.slot.locked||el.dataset.blocked==='true';}
    async function add(config){
      const scene=getScene();if(!sceneCurrent(scene))throw Error('Choose an editable Preview scene.');
      const info=studio.sportsTemplateInfo?.(scene);
      if(config.templateId&&studio.createSportsTemplateScene){
        const label=window.OpenLiveSportsSources.catalogue.find(item=>item.id===config.preset)?.label||'Graphic';
        const created=await studio.createSportsTemplateScene({templateId:config.templateId,name:(packName+' · '+label).slice(0,80),config,preset:config.preset,graphicFrame:config.frameIndex,bindings:bindingsFor(config.templateId),...(info?.templateId===config.templateId&&info.packId?{packId:info.packId}:{})},{isCurrent:()=>!destroyed&&sceneCurrent(scene)});
        onSelectScene?.(created);const index=created.slots.findIndex(slot=>studio.sources.get(slot.sourceId)?.sourceType==='sports');if(index>=0)onSelectSource?.(index);lastSource=null;refresh();return index;
      }
      const runtime=window.OpenLiveSportsSources.create(config,{document:doc});
      const index=await studio.addLibrarySource(scene.id,runtime,{isCurrent:()=>!destroyed&&sceneCurrent(scene)});
      onSelectSource?.(index);lastSource=null;refresh();return index;
    }
    async function apply(config){
      const value=target;if(!value||!targetCurrent(value))throw Error('The selected match graphic changed. Select it again.');
      if(value.slot.locked)throw Error('Unlock this match graphic before editing.');
      await studio.updateSportsSource(value.scene.id,value.index,config,{expected:value.slot,isCurrent:()=>!destroyed&&targetCurrent(value)});
      lastSource=null;onSelectSource?.(value.index);refresh();
    }
    function quick(change,message){return perform(async()=>{change();const config=normalizeDraft();if(target)await apply(config);else{draft=copy(config);paintProof();draw();}},message);}
    const templates=()=>window.OpenLiveSportsSources.templateDefinitions?.()||[];
    const selectedTemplate=()=>templates().find(item=>item.id===templateId);
    const shortName=item=>({'svg-1':'News desk','svg-2':'Idea Hub','svg-3':'Smart Move','svg-4':'Programme + QR','svg-5':'Live match','svg-6':'Presenter + match','svg-7':'Match + commentary','svg-8':'Four-feed analysis','svg-9':'Six-feed analysis'}[item.id]||item.name);
    const assetUrl=path=>window.OpenLiveFullTemplates?.assetUrl?.(path)||path;
    function pictureReady(source){try{return !!source?.id&&!source.audioOnly&&source.sourceType!=='sports'&&(studio.sourceStatus?studio.sourceStatus(source).ok:!source.runtimeStatus||source.runtimeStatus().state==='ready');}catch(_){return false;}}
    function bindingsFor(id=templateId){
      if(id===templateId&&bindings.length)return bindings.slice();
      const scene=getScene(),info=studio.sportsTemplateInfo?.(scene);
      if(info?.templateId===id)return info.bindings.map(value=>pictureReady(studio.sources.get(value))?value:null);
      const count=templates().find(item=>item.id===id)?.frameCount||1;
      return Array.from({length:count},(_,index)=>{const source=studio.sources.get(scene?.slots?.[index]?.sourceId);return pictureReady(source)?source.id:null;});
    }
    function chooseTemplate(id){
      const item=templates().find(value=>value.id===id);if(!item)return;
      const previous=bindingsFor();templateId=id;graphicFrame=item.mainFrameIndex||0;bindings=Array.from({length:item.frameCount},(_,index)=>previous[index]||null);
      draft=copy(window.OpenLiveSportsSources.normalize({...draft,templateId,frameIndex:graphicFrame,templateStyle:undefined}));draw();
    }
    function closeWorkspace(){if(!dialog)return;const value=dialog;dialog=null;root.append(shell);value.close();value.remove();draw();}
    function openWorkspace(){
      if(dialog||!live())return;dialog=doc.createElement('dialog');dialog.className='bc-source-dialog bc-sports-dialog';dialog.setAttribute('aria-label','Football production workspace');
      const head=make('header',dialog,undefined,'mon-head');make('strong',head,'Production library · Football');button(head,'×',closeWorkspace).setAttribute('aria-label','Close production workspace');
      doc.body.append(dialog);dialog.append(shell);dialog.addEventListener('cancel',event=>{event.preventDefault();closeWorkspace();});dialog.showModal();draw();
    }
    function sectionHead(parent,label,detail){const head=make('header',parent,undefined,'mon-head bc-sports-section-head');make('span',head,label);if(detail)make('span',head,detail);}
    async function tilePreview(canvas,preset){
      if(!studio.prepareSportsTemplateScene)return;
      const id=templateId,serial=viewSerial;let staged;
      try{
        staged=await studio.prepareSportsTemplateScene({templateId:id,preset,graphicFrame,bindings:bindingsFor(),config:normalizeDraft()},{isCurrent:()=>!destroyed&&serial===viewSerial});tileProofs.add(staged);
        if(destroyed||serial!==viewSerial||!shell.contains(canvas))return;staged.render(canvas,['goal','substitution','replay-title'].includes(preset)?Math.min(1000,draft.duration*350):1800);
      }catch(error){if(!destroyed&&serial===viewSerial)canvas.title=error.message;}
      finally{if(staged){staged.cancel();tileProofs.delete(staged);}}
    }
    function matchingGraphics(parent){
      sectionHead(parent,'Matching graphics',selectedTemplate()?shortName(selectedTemplate()):'Football');
      const rows=make('div',parent,undefined,'bc-sports-catalog bc-sports-cue-grid');
      for(const item of window.OpenLiveSportsSources.catalogue){
        const el=button(rows,'',()=>show(item.id),'btn bc-sports-entry bc-sports-cue');el.setAttribute('aria-label','Configure '+item.label);el.title=item.description;
        if(selectedTemplate()){const canvas=make('canvas',el);canvas.width=240;canvas.height=135;canvas.setAttribute('aria-hidden','true');void tilePreview(canvas,item.id);}
        const label=make('span',el,undefined,'bc-sports-cue-label');icon(label,item.icon);make('span',label,item.label);
      }
      const replay=button(parent,'',()=>{mode='replay';target=null;draw();},'btn bc-sports-entry');replay.setAttribute('aria-label','Configure slow-motion replay');icon(replay,'replay');make('span',replay,'Slow-motion replay · import clip');make('span',replay,'›','bc-sports-entry-end');
    }
    function packScenes(parent){
      const scene=getScene();if(!scene?.sportsPackId)return;
      const members=studio.scenes().filter(value=>value.sportsPackId===scene.sportsPackId);sectionHead(parent,'Match sequence',members.length+' scenes');
      const list=make('div',parent,undefined,'bc-sports-sequence');
      for(const member of members){const el=button(list,member.name,()=>{if(onSelectScene)onSelectScene(member);},'btn bc-sports-entry');el.classList.toggle('selected',member===scene);el.setAttribute('aria-label','Preview '+member.name);}
    }
    function browse(){
      heading('Football production');
      const nav=make('div',body,undefined,'ptabs bc-sports-nav');nav.setAttribute('role','group');nav.setAttribute('aria-label','Football library sections');
      for(const [key,label] of [['templates','Templates'],['cues','Match control']]){const el=button(nav,label,()=>{libraryView=key;draw();},'ptab');el.classList.toggle('active',libraryView===key);el.setAttribute('aria-pressed',String(libraryView===key));}
      if(!templates().length){make('p',body,'No bundled sample designs are included. The football graphics below can be added to your own scenes.','bc-sports-note');matchingGraphics(body);return;}
      if(!selectedTemplate()){templateId=templates()[0].id;graphicFrame=templates()[0].mainFrameIndex||0;bindings=[];}
      const workspace=make('div',body,undefined,'bc-sports-browse'),gallery=make('section',workspace,undefined,'bc-sports-layouts'),detail=make('section',workspace,undefined,'bc-sports-layout-detail');
      packScenes(gallery);
      if(libraryView==='cues'){matchingGraphics(gallery);make('p',gallery,'One match configuration across the pack. Cue in Preview, then Cut/Fade.','bc-sports-note');}
      else{
        sectionHead(gallery,'Template collection',templates().length+' native designs');const cards=make('div',gallery,undefined,'bc-sports-template-grid');cards.setAttribute('aria-label','Native football layout templates');
        for(const item of templates()){
          const card=button(cards,'',()=>chooseTemplate(item.id),'btn bc-sports-template');card.setAttribute('aria-label','Choose '+item.name);card.setAttribute('aria-pressed',String(item.id===templateId));card.classList.toggle('selected',item.id===templateId);card.title=item.name;
          const image=make('img',card);image.src=assetUrl(item.thumbnail);image.alt='';image.loading='lazy';image.decoding='async';make('span',card,shortName(item));make('small',card,item.frameCount+' feed'+(item.frameCount===1?'':'s'));
        }
      }
      const item=selectedTemplate();sectionHead(detail,shortName(item),'Template '+templateId.slice(4));
      proofCanvas=make('canvas',detail,undefined,'bc-sports-composition-proof');proofCanvas.width=480;proofCanvas.height=270;proofCanvas.setAttribute('aria-label','Staged '+item.name+' football composition');
      make('p',detail,item.name,'bc-sports-note');
      const fields=make('div',detail,undefined,'bc-sports-fields');
      field(fields,'Match name',packName,'text',value=>packName=value);
      field(fields,'Competition',draft.competition,'text',value=>draft.competition=value);
      for(const [team,label] of [['home','Home'],['away','Away']]){
        field(fields,label+' team',draft[team].name,'text',value=>draft[team].name=value);
        field(fields,label+' short',draft[team].short,'text',value=>draft[team].short=value);
      }
      const readySources=[...studio.sources.values()].filter(pictureReady);
      const current=bindingsFor();bindings=Array.from({length:item.frameCount},(_,index)=>current[index]||null);
      for(let index=0;index<item.frameCount;index++)field(fields,'Feed '+(index+1),bindings[index]||'','select',value=>{bindings[index]=value||null;},[['','Choose source later'],...readySources.map(source=>[source.id,source.label||'Picture source'])]);
      if(item.frameCount>1)field(fields,'Graphics frame',graphicFrame,'select',value=>{graphicFrame=Number(value);draft.frameIndex=graphicFrame;},Array.from({length:item.frameCount},(_,index)=>[index,'Feed '+(index+1)]));
      const actions=make('div',detail,undefined,'bc-sports-actions bc-sports-footer');
      const install=all=>perform(async()=>{
        const scene=getScene();if(!sceneCurrent(scene))throw Error('Choose an editable Preview scene.');const config=window.OpenLiveSportsSources.normalize({...draft,templateId,frameIndex:graphicFrame});
        const options={templateId,graphicFrame,name:packName||'Matchday',config,preset:'scoreboard',bindings:bindingsFor()},guard={isCurrent:()=>!destroyed&&sceneCurrent(scene)};
        const result=all?await studio.createSportsTemplatePack(options,guard):await studio.createSportsTemplateScene(options,guard),first=Array.isArray(result)?result[0]:result;
        if(first&&onSelectScene)onSelectScene(first);libraryView='cues';lastScene=null;refresh();
      },all?'Four matching scenes prepared in Preview.':'Match scene prepared in Preview.');
      button(actions,'Create match scene',()=>install(false));button(actions,'Create 4-scene pack',()=>install(true));
      const available=!!studio.createSportsTemplateScene&&!!studio.createSportsTemplatePack;
      if(!available)for(const el of actions.querySelectorAll('button')){el.dataset.blocked='true';el.disabled=true;}
      make('p',detail,'Live match · starting lineup · statistics · replay. Original artwork and frame borders are preserved.','bc-sports-note');
      if(libraryView==='templates')button(detail,'Open matching graphics',()=>{libraryView='cues';draw();});
      draft=copy(window.OpenLiveSportsSources.normalize({...draft,templateId,frameIndex:graphicFrame,preset:'scoreboard'}));void paintProof();
    }
    function editor(){
      const descriptor=window.OpenLiveSportsSources.catalogue.find(item=>item.id===draft.preset);
      heading(descriptor?.label||'Match graphic',true);
      const proofRow=make('div',body,undefined,editorOnly?'bc-sports-inspector-actions':'bc-sports-proof-row');if(!editorOnly){proofCanvas=make('canvas',proofRow);proofCanvas.width=320;proofCanvas.height=180;proofCanvas.setAttribute('aria-label',(descriptor?.label||'Graphic')+' sample');}
      const actions=make('div',proofRow,undefined,editorOnly?'bc-sports-actions':'bc-sports-proof-actions');
      button(actions,target?'Apply to Preview':'Add to Preview',()=>perform(async()=>{const config=normalizeDraft();if(target)await apply(config);else await add(config);},target?'Match graphics updated in Preview.':'Graphic added to Preview.'));
      if(target&&!editorOnly)button(actions,'Add another',()=>{target=null;draw();});
      if(['lineup','goal','substitution','replay-title'].includes(draft.preset))button(actions,'Cue again',()=>perform(async()=>{if(target)await apply(normalizeDraft());else await add(normalizeDraft());},'Graphic cued in Preview.'));
      make('span',actions,target?(getScene()?.sportsPackId?'Match settings update the whole pack.':'Match settings update this scene.'):(draft.templateId?'Matches the selected native template.':'Transparent match graphic.'),'bc-sports-note');
      if(['goal','substitution','replay-title'].includes(draft.preset)){cueState=make('p',body,'Cue in Preview, then Cut/Fade before the graphic finishes.','bc-sports-note');}
      const match=make('div',body,undefined,'bc-sports-fields');
      if(draft.templateId)make('p',match,(templates().find(item=>item.id===draft.templateId)?.name||draft.templateId)+' · coordinated artwork','bc-sports-note');
      else field(match,'Style',draft.style,'select',value=>draft.style=value,[['broadcast','Broadcast'],['minimal','Minimal']]);
      field(match,'Competition',draft.competition,'text',value=>draft.competition=value);
      for(const [team,label] of [['home','Home'],['away','Away']]){
        const row=make('div',match,undefined,'bc-sports-team');
        field(row,label+' team',draft[team].name,'text',value=>draft[team].name=value);
        const sub=make('div',row,undefined,'bc-sports-team-meta');field(sub,label+' short',draft[team].short,'text',value=>draft[team].short=value);field(sub,label+' color',draft[team].color,'color',value=>draft[team].color=value);
      }
      const scores=make('div',match,undefined,'bc-sports-pair');
      for(const [key,label] of [['homeScore','Home score'],['awayScore','Away score']]){const input=field(scores,label,draft[key],'number',value=>draft[key]=value);input.max='99';}
      const scoreActions=make('div',match,undefined,'bc-sports-actions');
      button(scoreActions,'Home +1',()=>quick(()=>draft.homeScore++,'Score updated in Preview.'));
      button(scoreActions,'Away +1',()=>quick(()=>draft.awayScore++,'Score updated in Preview.'));
      button(scoreActions,'Reset score',()=>quick(()=>{draft.homeScore=0;draft.awayScore=0;},'Score reset in Preview.'));
      field(match,'Period',draft.period,'select',value=>draft.period=value,['1st half','2nd half','Extra time','Half-time','Full-time']);
      const clockInput=field(match,'Clock (seconds)',draft.clock.elapsed,'number',value=>{draft.clock.elapsed=value;draft.clock.startedAt=draft.clock.running?Date.now():0;});clockInput.step='1';
      const clockActions=make('div',match,undefined,'bc-sports-actions');
      button(clockActions,draft.clock.running?'Pause clock':'Start clock',()=>quick(()=>{if(draft.clock.running){draft.clock.elapsed+=Math.max(0,(Date.now()-draft.clock.startedAt)/1000);draft.clock.running=false;draft.clock.startedAt=0;}else{draft.clock.running=true;draft.clock.startedAt=Date.now();}},'Match clock updated in Preview.'));
      button(clockActions,'Reset clock',()=>quick(()=>draft.clock={elapsed:0,running:false,startedAt:0},'Match clock reset in Preview.'));
      if(['lineup','goal','substitution'].includes(draft.preset))field(match,'Team',draft.team,'select',value=>{draft.team=value;draw();},[['home','Home'],['away','Away']]);
      if(draft.preset==='lineup'){
        field(match,'Formation',draft.formation,'select',value=>draft.formation=value,['4-3-3','4-4-2','3-5-2']);
        const help=make('p',match,'One player per line: shirt number, then name. Up to 11 players.','bc-sports-note');
        field(match,'Players',draft[draft.team].players.map(player=>player.number+' '+player.name).join('\n'),'textarea',value=>{draft[draft.team].players=value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const parsed=line.trim().match(/^(\d{1,3})\s+(.+)$/);return parsed?{number:parsed[1],name:parsed[2]}:{number:'',name:line};});});
        help.id='bc-sports-players-help';
      }
      if(draft.preset==='goal'){
        field(match,'Scorer',draft.player,'text',value=>draft.player=value);
        const goals=make('div',match,undefined,'bc-sports-actions');
        for(const [team,label] of [['home','Cue home goal'],['away','Cue away goal']])button(goals,label,()=>perform(async()=>{draft.team=team;if(target)await apply(normalizeDraft());else await add(normalizeDraft());},'Goal graphic cued in Preview.'));
        make('p',match,'Cue shows the goal graphic. Use +1 to update the score.','bc-sports-note');
      }
      if(draft.preset==='substitution'){field(match,'Player off',draft.playerOut,'text',value=>draft.playerOut=value);field(match,'Player on',draft.playerIn,'text',value=>draft.playerIn=value);}
      if(['goal','substitution'].includes(draft.preset))field(match,'Minute',draft.minute,'text',value=>draft.minute=value);
      if(['goal','substitution','replay-title'].includes(draft.preset)){field(match,'Headline',draft.headline,'text',value=>draft.headline=value);const duration=field(match,'Duration (seconds)',draft.duration,'number',value=>draft.duration=value);duration.min='1';duration.max='30';}
      if(draft.preset==='match-stats'){
        draft.stats.forEach((stat,index)=>{const fields=make('div',match,undefined,'bc-sports-stat');field(fields,'Stat '+(index+1),stat.label,'text',value=>stat.label=value);field(fields,'Home '+(index+1),stat.home,'text',value=>stat.home=value);field(fields,'Away '+(index+1),stat.away,'text',value=>stat.away=value);});
      }
      const footer=make('div',body,undefined,'bc-sports-actions bc-sports-footer');button(footer,target?'Apply match settings':'Add graphic',()=>perform(async()=>{if(target)await apply(normalizeDraft());else await add(normalizeDraft());},'Match graphic ready in Preview.'));
      if(target&&!editorOnly){const hide=button(footer,target.slot.hidden?'Show graphic':'Hide graphic',()=>perform(async()=>{const value=target;if(!targetCurrent(value)||value.slot.locked)throw Error('Select an unlocked match graphic.');if(studio.updateSceneContent)await studio.updateSceneContent(value.scene.id,value.key,{hidden:!value.slot.hidden},{expected:value.slot,isCurrent:()=>targetCurrent(value)});else studio.updateFreeSource(value.scene.id,value.index,{hidden:!value.slot.hidden});lastSlot=null;},'Graphic visibility updated in Preview.'));hide.dataset.blocked=String(!studio.updateSceneContent&&target.scene.layout!=='free'||!!target.slot.locked);hide.disabled=hide.dataset.blocked==='true';}
      paintProof();
    }
    function replayEditor(){
      heading('Slow-motion replay',true);
      make('p',body,editorOnly?'Control the selected replay clip in Preview. Replay audio is excluded.':'Import a recorded video clip. Replay audio is excluded.','bc-sports-note');
      const currentScene=getScene(),replayScene=!editorOnly&&currentScene?.sportsPackId?studio.scenes().find(item=>item.sportsPackId===currentScene.sportsPackId&&studio.sportsTemplateInfo?.(item)?.preset==='replay-title'):null;
      if(replayScene)make('p',body,'Clip destination: '+replayScene.name+' · native replay frame.','bc-sports-note');
      const fields=make('div',body,undefined,'bc-sports-fields');
      let file;if(!editorOnly){const fileLabel=make('label',fields,undefined,'bc-sports-file');make('span',fileLabel,'Replay clip');file=make('input',fileLabel);file.type='file';file.accept='video/*,.webm,.mp4,.mov';file.setAttribute('aria-label','Replay video file');file.disabled=busy||!live();}
      field(fields,'Playback speed',rate,'select',value=>rate=Number(value),[[.25,'0.25×'],[.5,'0.5×'],[.75,'0.75×'],[1,'1×'],[1.25,'1.25×'],[1.5,'1.5×'],[2,'2×']]);
      const load=!editorOnly&&button(fields,replayScene?'Load clip into replay frame':'Add replay to Preview',()=>perform(async()=>{
        const chosen=file.files?.[0];if(!chosen)throw Error('Choose a video clip first.');if(!sceneCurrent(currentScene))throw Error('Choose the current Preview scene.');
        const scene=replayScene||currentScene;
        if(replayScene&&scene!==currentScene){if(!onSelectScene)throw Error('Select the pack’s Replay scene before importing.');onSelectScene(scene);}
        if(!sceneCurrent(scene))throw Error('Choose the current Preview scene.');
        const info=studio.sportsTemplateInfo?.(scene),slotIndex=info?.preset==='replay-title'?info.frameSlots?.[info.graphicFrame]:undefined;
        if(Number.isInteger(slotIndex)&&scene.slots[slotIndex]?.sourceId)throw Error('The replay frame already contains a clip. Edit that source or clear the frame before importing another.');
        const runtime=await window.OpenLiveSportsReplay.acquire(chosen,{rate,document:doc,isCurrent:()=>!destroyed&&sceneCurrent(scene)});
        const index=await studio.addLibrarySource(scene.id,runtime,{...(Number.isInteger(slotIndex)?{slotIndex}:{}),isCurrent:()=>!destroyed&&sceneCurrent(scene)});onSelectSource?.(index);lastSource=null;refresh();
      },'Replay prepared in Preview. Cut/Fade starts its independent Programme playback.'));
      if(load&&!window.OpenLiveSportsReplay){load.disabled=true;load.dataset.blocked='true';}
      make('p',body,'Use the source’s media controls to set In/Out, play, pause and cue. Local video files must be selected again after reopening the studio.','bc-sports-note');
      make('p',body,'Live replay capture is not available in this session.','bc-sports-note');
      if(target?.source?.config?.replay){
        const controls=make('div',body,undefined,'bc-sports-actions');
        const selectedReplay=()=>{if(!target||!targetCurrent(target)||target.slot.locked)throw Error('Select the current unlocked replay clip.');return target;};
        button(controls,'Apply speed',()=>perform(async()=>{
          const value=selectedReplay(),file=value.source._sourceConfig?.file;if(!file)throw Error('Choose the replay file again to change its playback speed.');
          const runtime=await window.OpenLiveSportsReplay.acquire(file,{rate,loop:value.source.config.loop,trimIn:value.source.config.trimIn,trimOut:value.source.config.trimOut,document:doc,isCurrent:()=>!destroyed&&targetCurrent(value)});
          runtime.label=value.source.label;studio.replaceSceneSource(value.scene,value.index,runtime,{expected:value.slot,isCurrent:()=>!destroyed&&targetCurrent(value)});lastSource=null;refresh();
        },'Replay speed updated in Preview.'));
        button(controls,'Play Preview',()=>perform(()=>selectedReplay().source.transport.play(),'Replay playing in Preview.'));
        button(controls,'Pause Preview',()=>perform(()=>selectedReplay().source.transport.pause(),'Replay paused in Preview.'));
        button(controls,'Cue Preview',()=>perform(()=>{const value=selectedReplay();value.source.transport.seek(value.source.config.trimIn||0);value.source.transport.pause();},'Replay cued in Preview.'));
        make('p',body,target.source.label+' · '+target.source.config.rate+'×','bc-sports-note');
      }
    }
    function draw(){clearProof();body.replaceChildren();if(mode==='browse'){if(!editorOnly)browse();}else if(mode==='replay')replayEditor();else editor();setBusy();}
    function refresh(){
      if(destroyed)return;const scene=getScene(),value=selection(),source=value?.source,slot=value?.slot,changedScene=scene!==lastScene;
      if(changedScene){lastScene=scene;target=null;mode='browse';const info=studio.sportsTemplateInfo?.(scene);if(info?.templateId){templateId=info.templateId;graphicFrame=info.graphicFrame;bindings=info.bindings.map(value=>pictureReady(studio.sources.get(value))?value:null);}else bindings=[];
        const match=scene?.slots?.map(slot=>studio.sources.get(slot.sourceId)).find(source=>source?.sourceType==='sports');if(match)draft=copy(match.config);
      }
      if(source!==lastSource||slot!==lastSlot||changedScene){lastSource=source;lastSlot=slot;
        if(source?.sourceType==='sports'){target=value;draft=copy(source.config);mode='editor';}
        else if(source?.config?.replay){target=value;rate=source.config.rate||.5;mode='replay';}
        else if(target){target=null;mode='browse';}
        draw();
      }else setBusy();
      if(proof&&proofCanvas){proof.renderFrame(proofTime());const ctx=proofCanvas.getContext('2d');ctx.clearRect(0,0,proofCanvas.width,proofCanvas.height);ctx.drawImage(proof.el,0,0,proofCanvas.width,proofCanvas.height);}
      if(compositionProof&&proofCanvas)try{compositionProof.render(proofCanvas,proofTime());}catch(error){compositionProof.cancel();compositionProof=null;say(error.message);}
      if(cueState&&target?.source?.animationElapsed)cueState.textContent=target.source.animationElapsed()>=target.source.config.duration?'Preview cue finished. Use Cue again before Cut/Fade.':'Graphic cued in Preview · Cut/Fade sends it to Programme.';
    }
    function show(preset){
      if(preset){
        const scene=getScene(),members=scene?.sportsPackId?studio.scenes().filter(value=>value.sportsPackId===scene.sportsPackId):[scene];
        for(const member of members){const index=member?.slots.findIndex(slot=>{const source=studio.sources.get(slot.sourceId);return source?.sourceType==='sports'&&source.config.preset===preset;});
          if(index>=0&&onSelectSource&&(member===scene||onSelectScene)){if(member!==scene)onSelectScene(member);onSelectSource(index);lastSource=null;refresh();return;}}
        draft=copy(window.OpenLiveSportsSources.normalize({...draft,preset,...(selectedTemplate()?{templateId,frameIndex:graphicFrame,placement:'overlay'}:{}),...(draft.preset!==preset?{headline:undefined}:{})}));target=null;mode='editor';draw();
      }
      else{refresh();draw();}
    }
    draw();refresh();
    return {refresh,show,destroy(){if(destroyed)return;destroyed=true;clearProof();if(dialog){dialog.close();dialog.remove();dialog=null;}shell.remove();}};
  }
  return Object.freeze({mount});
})();
