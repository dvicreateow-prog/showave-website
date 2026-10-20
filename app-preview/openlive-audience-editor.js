/* Audience production: local sessions, live participation and isolated chart sources. */
window.OpenLiveAudienceEditor=(()=>{
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  const memoryBackups=[];
  const draftArchive=new Map();let editorSerial=0;
  const FALLBACK_TYPES=[['multiple-choice','Multiple choice'],['word-cloud','Word cloud'],['open-ended','Open ended'],['scales','Scales'],['ranking','Ranking'],['q&a','Questions & answers'],['number','Number'],['points','XY plot'],['grid','2 × 2 grid'],['allocation','Allocate points'],['quiz-choice','Quiz choice'],['quiz-text','Quiz answer'],['form','Form'],['pin-image','Pin on image'],['content','Content'],['chart','Chart']];
  const FALLBACK_CHARTS=[['bar','Bar'],['column','Column'],['pie','Pie'],['donut','Donut'],['line','Line'],['area','Area'],['radar','Radar'],['gauge','Gauge'],['scatter','Scatter'],['table','Table']];
  function parseData(text){
    const trimmed=String(text||'').trim();if(!trimmed)throw Error('Enter at least one label and value.');
    if(trimmed.startsWith('[')){const value=JSON.parse(trimmed);if(!Array.isArray(value))throw Error('Chart data must be an array.');return value;}
    const delimiter=trimmed.includes('\t')?'\t':',',rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<=trimmed.length;i++){
      const char=trimmed[i]??'\n';
      if(char==='"'){if(quoted&&trimmed[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(char===delimiter||char==='\n'||char==='\r')){row.push(cell.trim());cell='';if(char!==delimiter){if(char==='\r'&&trimmed[i+1]==='\n')i++;if(row.some(value=>value))rows.push(row);row=[];}}
      else cell+=char;
    }
    if(quoted)throw Error('Close the quoted cell in the chart data.');
    if(rows[0]?.[0].toLowerCase()==='label'&&rows[0]?.[1].toLowerCase()==='value')rows.shift();
    return rows.map((cells,index)=>{if(cells.length<2||cells.length>4)throw Error('Row '+(index+1)+' needs label, value and optional x, y.');const [label,value,x,y]=cells;if(!label||value===''||!Number.isFinite(Number(value)))throw Error('Row '+(index+1)+' needs a label and numeric value.');const item={label,value:Number(value)};if(x!==undefined&&x!==''){if(!Number.isFinite(Number(x)))throw Error('Invalid x in row '+(index+1)+'.');item.x=Number(x);}if(y!==undefined&&y!==''){if(!Number.isFinite(Number(y)))throw Error('Invalid y in row '+(index+1)+'.');item.y=Number(y);}return item;});
  }
  function mount({studio,root,getScene,getSelection,enabled=()=>true,onChange,onSelectSource,onSelectScene,editorOnly=false}){
    const doc=root.ownerDocument,A=window.OpenLiveAudience;
    if(!A)throw Error('The Audience runtime did not load.');
    const make=(tag,parent,text,cls)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;parent.appendChild(el);return el;};
    const shell=make('section',root,undefined,'bc-audience-editor'+(editorOnly?' bc-audience-inspector':''));shell.setAttribute('aria-label',editorOnly?'Audience source settings':'Audience production');
    const body=make('div',shell),status=make('p',shell,'','bc-audience-status');status.setAttribute('role','status');
    let sessions=[],session=null,sessionId='',questionId='',questionDraft=null,dirty=false,undo=[],redo=[],tab='live',newType='multiple-choice';
    let busy=false,destroyed=false,requestSerial=0,controller=null,dialog=null,proof=null,proofCanvas=null,proofSerial=0,lastSource=null,lastSlot=null,lastScene=null;
    let target=null,sourceDraft=null,chartText='label,value\nCategory A,12\nCategory B,8\nCategory C,5',chartDraft={mode:'data',chart:'bar',title:'Statistics',data:[{label:'Category A',value:12},{label:'Category B',value:8},{label:'Category C',value:5}],transparent:false,showQR:false};
    let backupDialog=null,backupResolve=null,pasteDraft='',sessionToolsOpen=false,questionBase='',questionRawData='',sourceRawData='',liveChart='bar',liveShowQR=true,liveQuestionKey='';
    let liveDesign={presentation:'flat',framing:'full'},backgroundSourceId='',backgroundFile=null,proofFrame=null;
    const questionDrafts=draftArchive,editorId='bc-audience-'+(++editorSerial);
    const sessionOnly=window.OpenLiveSessionPolicy?.sessionOnly===true;
    const backups=window.OpenLiveSessionPolicy?.shared?.('openlive-audience-backups-v1',()=>[])||memoryBackups;
    const backupLocation=()=>sessionOnly?'kept in memory':'downloaded';
    let counts=null,liveTitle=null,liveState=null,moderationRoot=null,lastModerationSignature='',nextPoll=0,questionError='',sourceError='',sessionTitleDraft='',sessionTitleDirty=false,structureSignature='',pendingStructuralDraw=false,missingSessionId='';
    const types=(A.QUESTION_TYPES||FALLBACK_TYPES).map(item=>Array.isArray(item)?{id:item[0],label:item[1]}:item),charts=(A.CHART_TYPES||FALLBACK_CHARTS).map(item=>Array.isArray(item)?{id:item[0],label:item[1]}:item);
    const joinNetworks=new Map();
    const live=()=>!destroyed&&(typeof enabled==='function'?enabled():enabled!==false);
    const sceneCurrent=scene=>live()&&getScene()===scene&&studio.scenes().includes(scene)&&!scene.layoutPending;
    const selected=()=>{const value=getSelection?.(),scene=getScene(),index=value?.row?.index??(value?.key?.startsWith('source:')?Number(value.key.slice(7)):NaN),slot=scene?.slots?.[index],bound=value?.row?.boundSlot||value?.row?.slot,source=slot&&studio.sources.get(slot.sourceId);return value?.scene===scene&&Number.isInteger(index)&&slot&&(!bound||bound===slot)&&source?.sourceType==='audience'?{scene,index,slot,source,key:value.key}:null;};
    const targetCurrent=value=>{const current=selected();return !!value&&sceneCurrent(value.scene)&&current?.scene===value.scene&&current.index===value.index&&current.slot===value.slot&&current.source===value.source;};
    const say=value=>{if(!destroyed)status.textContent=value||'';};
    const named=(el,label)=>{el.setAttribute('aria-label',label);return el;};
    const currentQuestion=()=>session?.questions?.find(item=>item.id===questionId)||session?.questions?.find(item=>item.id===session.activeQuestionId)||null;
    const activeQuestion=()=>session?.questions?.find(item=>item.id===session.activeQuestionId)||null;
    const isSession=id=>!destroyed&&sessionId===id;
    const absoluteJoin=url=>url?new URL(url,window.location?.href||'http://127.0.0.1:8090/broadcast.html').href:'';
    const joinUrls=value=>(value?.sharing?.active&&value.sharing.joinUrls?.length?value.sharing.joinUrls:[value?.joinUrl].filter(Boolean)).map(absoluteJoin);
    const chosenJoin=value=>{const urls=joinUrls(value),chosen=joinNetworks.get(value?.id);if(chosen&&urls.includes(chosen))return chosen;const first=urls[0]||'';if(value?.id)joinNetworks.set(value.id,first);return first;};
    const shouldSync=()=>live()&&(!editorOnly||!!target&&sourceDraft?.mode!=='data')&&(editorOnly||tab!=='charts');
    function setBusy(){for(const el of shell.querySelectorAll('button,input,select,textarea'))el.disabled=busy||!live()||el.dataset.blocked==='true'||el.getAttribute('aria-label')==='Apply audience source settings'&&!!target?.slot.locked;}
    function button(parent,label,fn,{aria=label,blocked=false,title='',cls='btn'}={}){
      const el=named(make('button',parent,label,cls),aria);el.type='button';el.dataset.blocked=String(!!blocked);el.disabled=busy||!live()||blocked;el.title=title||aria;
      el.addEventListener('click',()=>{if(el.disabled||destroyed||!shell.contains(el)&&!dialog?.contains(el))return;try{const value=fn();value?.catch?.(error=>say(error.message||String(error)));}catch(error){say(error.message||String(error));}});return el;
    }
    function field(parent,label,value,kind,change,options=[],{min,max,step='1',readOnly=false}={}){
      const row=make('label',parent,undefined,'bc-audience-field');make('span',row,label);
      const el=named(make(kind==='select'?'select':kind==='textarea'?'textarea':'input',row),label);el.disabled=busy||!live()||readOnly&&kind==='select';el.dataset.blocked=String(readOnly&&kind==='select');
      if(kind==='select'){for(const option of options){const item=Array.isArray(option)?option:[option.id,option.label];const node=make('option',el,item[1]);node.value=String(item[0]);}el.value=String(value??'');}
      else if(kind==='textarea'){el.value=String(value??'');el.rows=4;el.maxLength=20000;}
      else{el.type=kind||'text';if(kind==='checkbox')el.checked=!!value;else el.value=String(value??'');if(kind==='text')el.maxLength=2000;if(min!==undefined)el.min=String(min);if(max!==undefined)el.max=String(max);if(kind==='number')el.step=String(step);}
      el.readOnly=readOnly;
      el.addEventListener(kind==='select'||kind==='checkbox'?'change':'input',()=>{if(el.disabled||readOnly||destroyed||!shell.contains(el))return;try{change(kind==='checkbox'?el.checked:kind==='number'?(el.value.trim()?Number(el.value):NaN):el.value);}catch(error){say(error.message);}});return el;
    }
    function heading(parent,title,detail){const head=make('header',parent,undefined,'mon-head bc-audience-head');make('span',head,title);if(detail)make('span',head,detail);return head;}
    function note(parent,text){return make('p',parent,text,'bc-audience-note');}
    function actions(parent){return make('div',parent,undefined,'bc-audience-actions');}
    async function request(path,options={}){if(destroyed)throw Error('Audience editor is closed.');return A.clientRequest(path,options);}
    async function action(actionName,fields={},expectedId=sessionId){
      if(!live())throw Error('Audience controls are available in Preview.');
      if(actionName!=='create'&&actionName!=='import'&&!expectedId)throw Error('Create or choose an audience session.');
      if(expectedId&&!isSession(expectedId))throw Error('The audience session changed.');
      const lifecycle=['open','close','reveal','hide-results','share','unshare','export'].includes(actionName);
      const revision=!lifecycle&&session?.id===expectedId?(Number.isFinite(session.adminRevision)?{expectedAdminRevision:session.adminRevision}:Number.isFinite(session.revision)?{expectedRevision:session.revision}:{}):{};
      const payload={action:actionName,...(expectedId?{sessionId:expectedId}:{}),...revision,...(lifecycle&&session?.activeQuestionId?{expectedQuestionId:session.activeQuestionId}:{}),...fields};
      const result=await request('/api/audience/admin/action',{method:'POST',body:payload});
      if(destroyed)return result;
      if(result.session&&(!expectedId||isSession(expectedId)))applySession(result.session,true);
      return result;
    }
    async function perform(fn,message){
      if(busy||!live())return;requestSerial++;controller?.abort?.();busy=true;setBusy();say('');
      try{await fn();if(!destroyed){say(message||'');onChange?.();draw();}}
      catch(error){say(error.message||String(error));}
      finally{busy=false;if(!destroyed)setBusy();}
    }
    function updateSessions(value){sessions=value||[];}
    function rememberQuestion(){if(dirty&&questionDraft&&sessionId&&questionId){questionDrafts.set(sessionId+':'+questionId,{question:copy(questionDraft),base:questionBase,error:questionError,rawData:questionRawData,undo:copy(undo),redo:copy(redo)});if(questionDrafts.size>100)questionDrafts.delete(questionDrafts.keys().next().value);}}
    function loadQuestion(){const key=sessionId+':'+questionId,saved=questionDrafts.get(key),current=currentQuestion();questionDraft=saved?copy(saved.question):current?copy(current):null;questionBase=saved?.base||JSON.stringify(current||null);questionRawData=saved?.rawData??JSON.stringify(questionDraft?.data||[],null,2);dirty=!!saved;questionError=saved?.error||'';undo=saved?copy(saved.undo):[];redo=saved?copy(saved.redo):[];if(liveQuestionKey!==key){liveQuestionKey=key;liveChart=current?.chart||'bar';}}
    function applySession(value,keepDraft){
      const changed=sessionId!==value.id;if(changed){rememberQuestion();questionId='';dirty=false;}
      const nextQuestionId=value.questions?.some(item=>item.id===questionId)?questionId:value.activeQuestionId||value.questions?.[0]?.id||'',selectionChanged=questionId!==nextQuestionId;
      if(selectionChanged)rememberQuestion();
      if(session?.id!==value.id||!sessionTitleDirty){sessionTitleDraft=value.title;sessionTitleDirty=false;}
      session=value;sessionId=value.id;const index=sessions.findIndex(item=>item.id===value.id);if(index<0)sessions.push(value);else sessions[index]=value;
      missingSessionId='';
      questionId=nextQuestionId;
      if(changed||selectionChanged||!keepDraft||!dirty)loadQuestion();
      updateLive();
    }
    async function sync({list=false,redraw=false}={}){
      if(!shouldSync()||busy)return;const serial=++requestSerial;
      let listUpdated=false;
      controller?.abort?.();controller=typeof AbortController==='function'?new AbortController():null;
      try{
        if(list||!sessions.length||missingSessionId){const result=await request('/api/audience/admin/sessions',{signal:controller?.signal});if(destroyed||serial!==requestSerial)return;updateSessions(result.sessions);listUpdated=true;if(!sessionId&&sessions.length)sessionId=sessions[0].id;
          if(sessionId&&!sessions.some(item=>item.id===sessionId)){missingSessionId=sessionId;session=null;questionDraft=null;dirty=false;undo=[];redo=[];draw();say('The previous audience session is unavailable. Choose an available session to reconnect this source.');return;}
        }
        const next=sessionId;if(next){const result=await request('/api/audience/admin/session/'+encodeURIComponent(next),{signal:controller?.signal});if(destroyed||serial!==requestSerial||next!==sessionId)return;const nextSignature=JSON.stringify([result.session.id,result.session.questions,result.session.activeQuestionId,result.session.sharing]);if(nextSignature!==structureSignature)pendingStructuralDraw=true;structureSignature=nextSignature;applySession(result.session,true);const focusedInput=shell.contains(doc.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(String(doc.activeElement.tagName).toUpperCase());if(pendingStructuralDraw&&!dirty&&!focusedInput){redraw=true;pendingStructuralDraw=false;}}
        if(redraw&&!destroyed&&serial===requestSerial)draw();else updateLive();
      }catch(error){if(!destroyed&&serial===requestSerial&&error.name!=='AbortError'){
        if(error.status===404){missingSessionId=sessionId;session=null;questionDraft=null;dirty=false;undo=[];redo=[];sessions=sessions.filter(item=>item.id!==sessionId);draw();say('The previous audience session is unavailable. Choose an available session to reconnect this source.');}
        else{if(listUpdated)draw();say(error.message||String(error));}
      }}
    }
    function chooseSession(id){rememberQuestion();requestSerial++;controller?.abort?.();sessionId=id;session=null;missingSessionId='';sessionTitleDirty=false;questionId='';questionDraft=null;dirty=false;questionError='';undo=[];redo=[];draw();sync({redraw:true});}
    function chooseQuestion(id){if(!session?.questions?.some(item=>item.id===id))return;rememberQuestion();questionId=id;loadQuestion();draw();}
    async function activateQuestion(id,expectedId=sessionId){rememberQuestion();await action('activate',{questionId:id},expectedId);if(isSession(expectedId)&&session?.activeQuestionId===id){questionId=id;loadQuestion();}}
    function editQuestion(patch){if(!questionDraft)return;undo.push(copy(questionDraft));if(undo.length>100)undo.shift();redo=[];Object.assign(questionDraft,patch);dirty=true;say('Question draft · Save question to apply.');for(const [label,count] of [['Undo audience question draft',undo.length],['Redo audience question draft',redo.length]]){const control=shell.querySelector('[aria-label="'+label+'"]');if(control){control.dataset.blocked=String(!count);control.disabled=busy||!live()||!count;}}}
    function defaultQuestion(type){
      const question={type,title:types.find(item=>item.id===type)?.label||'Question'};
      if(['multiple-choice','ranking','allocation','quiz-choice'].includes(type))question.options=[{id:'a',label:'Option A'},{id:'b',label:'Option B'},{id:'c',label:'Option C'}];
      if(['scales','number'].includes(type)){question.min=type==='number'?0:1;question.max=type==='number'?100:5;question.step=1;}
      if(type==='allocation')question.total=100;
      if(['points','grid','pin-image'].includes(type)){question.xLabel='X';question.yLabel='Y';}
      if(type==='word-cloud')question.maxWords=3;
      if(type==='quiz-choice'){question.correctAnswer='a';question.points=1000;}
      if(type==='quiz-text'){question.correctAnswer='Answer';question.points=1000;}
      if(type==='form')question.fields=[{id:'name',label:'Name',type:'text',required:true},{id:'feedback',label:'Feedback',type:'text',required:false}];
      if(type==='chart'){question.chart='bar';question.data=copy(chartDraft.data);}
      if(type==='content')question.body='Presentation content';
      return question;
    }
    function download(value,filename){
      if(typeof Blob!=='function'||!window.URL?.createObjectURL)throw Error('This browser cannot export a file. Answers have been kept.');
      const url=window.URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),anchor=make('a',doc.body);anchor.href=url;anchor.download=filename;try{anchor.click();}finally{anchor.remove();window.setTimeout(()=>window.URL.revokeObjectURL(url),1000);}
    }
    function closeBackup(continueAction=false){if(!backupDialog)return;const old=backupDialog,resolve=backupResolve;backupDialog=null;backupResolve=null;old.remove();resolve?.(continueAction);}
    function saveMemoryBackup(id,document){const record={id:String(Date.now())+'_'+backups.length,sessionId:id,title:document.title||'Audience session',createdAt:new Date().toISOString(),document:copy(document)};backups.push(record);if(backups.length>12)backups.splice(0,backups.length-12);return record;}
    function showBackup(record,{continueAction=false,archive=false}={}){
      closeBackup(false);backupDialog=make('dialog',doc.body,undefined,'bc-source-dialog bc-audience-dialog bc-audience-backup');named(backupDialog,'Audience JSON backup');
      const panel=make('section',backupDialog,undefined,'bc-audience-editor'),head=heading(panel,'Audience backup',record.title),content=make('div',panel,undefined,'bc-audience-backup-body');
      note(content,'The 12 most recent backups stay in this browser session only. Copy JSON to keep it elsewhere. Closing all app windows loses these in-memory backups.');
      note(content,'Questions can be restored as a new session. Results are preserved for inspection; importing does not restore participant answers.');
      const text=named(make('textarea',content,undefined,'bc-audience-backup-json'),'Audience backup JSON');text.value=JSON.stringify(record.document,null,2);text.readOnly=true;text.spellcheck=false;
      const message=make('p',content,'','bc-audience-status');message.setAttribute('role','status');const controls=actions(content);
      const rawButton=(label,fn,aria=label)=>{const el=named(make('button',controls,label,'btn'),aria);el.type='button';el.title=aria;el.addEventListener('click',()=>{if(destroyed||!backupDialog?.contains(el)||el.disabled)return;try{const result=fn();if(result?.then){el.disabled=true;Promise.resolve(result).catch(error=>{message.textContent=error.message;}).finally(()=>{el.disabled=false;});}}catch(error){message.textContent=error.message;}});return el;};
      rawButton('Copy JSON',async()=>{if(!window.navigator?.clipboard?.writeText)throw Error('Select the JSON text and copy it.');await window.navigator.clipboard.writeText(text.value);message.textContent='Backup JSON copied.';},'Copy audience backup JSON');
      if(continueAction){rawButton('Keep backup & continue',()=>closeBackup(true),'Keep audience backup and continue');rawButton('Cancel action',()=>closeBackup(false),'Cancel audience destructive action');}
      else{
        rawButton('Restore questions',async()=>{const result=await action('import',{document:copy(record.document)},'');if(destroyed)return;if(result.session)applySession(result.session,false);onChange?.();draw();closeBackup(true);say('Questions restored as a new session. Archived results remain in the backup.');},'Restore audience questions from backup');
        if(archive&&backups.length>1){const select=named(make('select',head),'Choose audience backup');for(const value of backups.slice().reverse()){const option=make('option',select,value.title+' · '+value.createdAt);option.value=value.id;}select.value=record.id;select.addEventListener('change',()=>{const selected=backups.find(item=>item.id===select.value);if(selected)showBackup(selected,{archive:true});});}
        rawButton('Close',()=>closeBackup(true),'Close audience backup');
      }
      backupDialog.addEventListener('cancel',event=>{event.preventDefault();closeBackup(!continueAction);});backupDialog.showModal();text.focus?.();
      return new Promise(resolve=>{backupResolve=resolve;});
    }
    async function exportSession(id=sessionId,{beforeDestructive=false}={}){
      const result=await action('export',{},id);if(destroyed||!isSession(id))throw Error('The audience session changed.');const document=result.document||result;
      if(sessionOnly){const record=saveMemoryBackup(id,document),accepted=await showBackup(record,{continueAction:beforeDestructive});if(destroyed||!accepted)throw Error('Action cancelled. The backup was kept in memory.');}
      else download(document,'openlive-audience-'+id+'.json');
      return result;
    }
    async function resetAnswers(){const id=sessionId,q=currentQuestion();if(!q)return;await exportSession(id,{beforeDestructive:true});if(destroyed||!isSession(id)||currentQuestion()?.id!==q.id)throw Error('The audience question changed. Answers were kept.');await action('reset',{questionId:q.id},id);}
    function sessionControls(parent){
      const strip=make('div',parent,undefined,'bc-audience-session-strip');
      field(strip,'Session',sessionId,'select',chooseSession,[['','Choose a session'],...sessions.map(item=>[item.id,item.title])]);
      button(strip,'+ New',()=>perform(async()=>{rememberQuestion();const result=await action('create',{title:'Audience session',questions:[]},'');if(result.session)applySession(result.session,false);await sync({list:true});},'Session created.'),{aria:'Create audience session'});
      const tools=make('details',parent,undefined,'bc-audience-session-tools');tools.open=sessionToolsOpen;const summary=make('summary',tools,'Session tools','mon-head');summary.title='Rename, duplicate, import and back up sessions';tools.addEventListener('toggle',()=>{sessionToolsOpen=tools.open;});
      const fields=make('div',tools,undefined,'bc-audience-fields'),row=actions(fields);
      button(row,'Duplicate',()=>perform(async()=>{const result=await action('duplicate');if(result.session)applySession(result.session,false);},'Session duplicated.'),{blocked:!session,aria:'Duplicate audience session'});
      button(row,'Export',()=>perform(()=>exportSession(),'Session backup '+backupLocation()+'.'),{blocked:!session,aria:'Export audience session'});
      if(sessionOnly)button(row,'Backups',()=>{const record=backups.at(-1);if(record)showBackup(record,{archive:true});else say('No in-memory backups yet. Export this session to keep one.');},{aria:'Open audience memory backups'});
      const importLabel=make('label',fields,undefined,'bc-audience-file');make('span',importLabel,'Import session JSON');const input=named(make('input',importLabel),'Import audience session JSON');input.type='file';input.accept='.json,application/json';
      input.addEventListener('change',()=>{const file=input.files?.[0];if(!file||input.disabled||!shell.contains(input))return;perform(async()=>{if(file.size>4*1024*1024)throw Error('Session files are limited to 4 MB.');const document=JSON.parse(await file.text());if(destroyed)return;const result=await action('import',{document},'');if(result.session)applySession(result.session,false);await sync({list:true});},'Session imported.');});
      const pasted=make('details',fields,undefined,'bc-audience-paste-import');make('summary',pasted,'Paste session JSON','mon-head');const pasteField=field(pasted,'Session JSON',pasteDraft,'textarea',text=>{pasteDraft=text;});pasteField.maxLength=4*1024*1024;
      button(pasted,'Import pasted JSON',()=>perform(async()=>{if(!pasteDraft.trim())throw Error('Paste an Audience session JSON backup.');const document=JSON.parse(pasteDraft);const result=await action('import',{document},'');if(result.session)applySession(result.session,false);pasteDraft='';},'Questions imported as a new session.'),{aria:'Import pasted audience JSON'});
      note(fields,'Sessions stay in the running service. Export keeps questions/results '+(sessionOnly?'in memory':'in a file')+'; Import starts a new session.');
      if(session){
        field(fields,'Session name',sessionTitleDraft,'text',value=>{sessionTitleDraft=value;sessionTitleDirty=true;});
        const manage=actions(fields);button(manage,'Rename',()=>perform(async()=>{await action('update',{title:sessionTitleDraft});sessionTitleDirty=false;sessionTitleDraft=session.title;},'Session renamed.'),{aria:'Rename audience session'});
        button(manage,'Delete session',()=>perform(async()=>{const id=sessionId;await exportSession(id,{beforeDestructive:true});if(!isSession(id))throw Error('The session changed.');await action('delete',{},id);sessions=sessions.filter(item=>item.id!==id);session=null;sessionId='';questionId='';questionDraft=null;dirty=false;await sync({list:true});},'Session deleted; its backup was '+backupLocation()+'.'),{aria:'Delete audience session'});
      }
    }
    function participation(parent){
      if(!session)return;heading(parent,'Participation',session.code?'Code '+session.code:'');const fields=make('div',parent,undefined,'bc-audience-fields');
      const urls=joinUrls(session),joinUrl=chosenJoin(session);
      if(urls.length>1)field(fields,'Join network',joinUrl,'select',value=>{joinNetworks.set(session.id,value);if(sourceDraft?.sessionId===session.id)sourceDraft.joinUrl=value;draw();},urls.map(url=>[url,new URL(url).hostname+':'+new URL(url).port]));
      field(fields,'Join URL',joinUrl,'text',()=>{},[],{readOnly:true});
      const row=actions(fields);button(row,'Copy link',async()=>{if(!window.navigator?.clipboard?.writeText)throw Error('Select and copy the Join URL field.');await window.navigator.clipboard.writeText(joinUrl);say('Participant link copied.');},{blocked:!joinUrl,aria:'Copy participant link'});
      if(joinUrl){const link=named(make('a',row,'Open page','btn'),'Open participant page');link.href=joinUrl;link.target='_blank';link.rel='noopener';}
      button(row,session.sharing?.active?'Stop sharing':'Start LAN sharing',()=>perform(()=>action(session.sharing?.active?'unshare':'share'),session.sharing?.active?'LAN sharing stopped.':'Audience sharing started.'),{aria:session.sharing?.active?'Stop audience LAN sharing':'Start audience LAN sharing'});
      if(!session.sharing?.active)note(parent,'Local only · Start LAN sharing so phones on the same network can join.');else note(parent,'Same network · '+urls.join(' · '));
      if(joinUrl&&window.OpenLiveCommerce?.qrMatrix){try{const matrix=window.OpenLiveCommerce.qrMatrix(joinUrl),canvas=named(make('canvas',fields,undefined,'bc-audience-qr'),'Participant QR code'),size=matrix.size||matrix.length,cells=matrix.cells||matrix;canvas.width=canvas.height=(size+8)*4;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(cells[y]?.[x]??cells[y*size+x])ctx.fillRect((x+4)*4,(y+4)*4,4,4);}catch(error){note(fields,error.message);}}
    }
    function addSource(config){
      return perform(async()=>{const scene=getScene();if(!sceneCurrent(scene))throw Error('Choose an editable Preview scene.');const normalized=A.normalize(config),runtime=A.create(normalized,{document:doc});let inserted=false;try{const index=await studio.addLibrarySource(scene.id,runtime,{isCurrent:()=>!destroyed&&sceneCurrent(scene)});inserted=true;if(!destroyed){onSelectSource?.(index);lastSource=null;refresh();}}finally{if(!inserted)runtime.dispose?.();}},'Audience source added to Preview.');
    }
    function liveSourceConfig(mode='results'){
      const q=currentQuestion();if(!session||!q&&mode!=='join')throw Error('Choose a session and question.');
      const joinUrl=chosenJoin(session);
      return {...liveDesign,mode,sessionId:session.id,viewToken:session.viewToken,questionId:mode==='join'||mode==='leaderboard'?'':q.id,title:'',chart:liveChart||q?.chart||'bar',joinUrl,showQR:mode==='join'||mode==='results'&&liveShowQR,transparent:liveDesign.transparent??false};
    }
    function changePresentation(draft,value){
      const wasFlat=!draft.presentation||draft.presentation==='flat';
      if(!draft.foreground||draft.foreground===(wasFlat?'#25272a':'#f1f3f6'))delete draft.foreground;
      if(!draft.background||draft.background===(wasFlat?'#e7e7ec':'#181d24'))delete draft.background;
      draft.presentation=value;
    }
    function graphicDesign(parent,draft,repaint){
      const design=make('details',parent,undefined,'bc-audience-design');
      const presentations=A.PRESENTATIONS||[{id:'flat',label:'Flat'},{id:'broadcast',label:'Broadcast'},{id:'dimensional',label:'Dimensional'}];
      const framings=A.FRAMINGS||[{id:'full',label:'Full frame'},{id:'left',label:'Left panel'},{id:'right',label:'Right panel'},{id:'lower-third',label:'Lower third'}];
      make('summary',design,'Graphic design · '+(presentations.find(item=>item.id===(draft.presentation||'flat'))?.label||'Flat'),'mon-head');
      const fields=make('div',design,undefined,'bc-audience-fields');
      field(fields,'Presentation',draft.presentation||'flat','select',value=>{changePresentation(draft,value);repaint();draw();},presentations);
      field(fields,'Placement',draft.framing||'full','select',value=>{draft.framing=value;repaint();draw();},framings);
      const opacity=field(fields,'Panel opacity (%)',Math.round((draft.panelOpacity??.92)*100),'number',value=>{draft.panelOpacity=value/100;repaint();},[],{min:0,max:100});
      const depth=field(fields,'Depth (%)',Math.round((draft.depth??.55)*100),'number',value=>{draft.depth=value/100;repaint();},[],{min:0,max:100});
      if((draft.presentation||'flat')==='flat'&&(draft.framing||'full')==='full'){opacity.dataset.blocked='true';opacity.title='Choose a broadcast presentation or panel placement to adjust panel opacity.';}
      if(draft.presentation!=='dimensional'){depth.dataset.blocked='true';depth.title='Choose Dimensional to adjust chart depth.';}
      field(fields,'Entrance motion',draft.motion??false,'checkbox',value=>{draft.motion=value;repaint();});
      field(fields,'Accent',draft.accent||'#0088ff','color',value=>{draft.accent=value;repaint();});
      note(design,'Place graphics above an image or video. Dimensional charts add depth; values and labels stay exact.');
      design.open=!!draft.presentation&&draft.presentation!=='flat'||!!draft.framing&&draft.framing!=='full';
    }
    function backgroundCandidates(){return [...(studio.sources?.values?.()||[])].filter(source=>!source.disconnected&&source.el&&!source.audioOnly&&(source.sourceType==='image'||source.kind==='image'||(source.sourceType==='media'||source._mediaAudio===true)&&!source.el.srcObject)&&(!studio.sourceStatus||studio.sourceStatus(source).ok));}
    function graphicSceneControls(parent,getConfig,design){
      const section=make('details',parent,undefined,'bc-audience-design bc-audience-backdrop');make('summary',section,'Background image / video','mon-head');
      const fields=make('div',section,undefined,'bc-audience-fields');
      const overlay=()=>{if(!design.presentation||design.presentation==='flat'){changePresentation(design,'dimensional');design.framing='right';design.transparent=false;}};
      const candidates=backgroundCandidates();
      field(fields,'Existing source',backgroundSourceId,'select',value=>{backgroundSourceId=value;backgroundFile=null;if(value)overlay();draw();},[['','Choose a background'],...candidates.map(source=>[source.id,source.label||source.id])]);
      const label=make('label',fields,undefined,'bc-audience-file');make('span',label,'Choose image / video');const file=named(make('input',label),'Graphic background file');file.type='file';file.accept='image/*,video/*';
      file.addEventListener('change',()=>{if(file.disabled||destroyed||!shell.contains(file))return;const chosen=file.files?.[0];if(!chosen)return;backgroundFile=chosen;backgroundSourceId='';overlay();draw();});
      if(backgroundFile)note(fields,backgroundFile.name+' · Ready to create a graphic scene.');
      const create=button(fields,'Create graphic scene',()=>perform(async()=>{
        if(typeof studio.createAudienceGraphicScene!=='function')throw Error('The graphic scene builder is unavailable. Reload Studio.');
        const scene=getScene(),config=A.normalize(getConfig());if(!sceneCurrent(scene))throw Error('Choose the current Preview scene.');
        if(!backgroundFile&&!backgroundSourceId)throw Error('Choose a background image or video.');
        const result=await studio.createAudienceGraphicScene(config,{...(backgroundFile?{backgroundFile}:{backgroundSourceId}),name:(config.title||'Audience graphic').slice(0,80),isCurrent:()=>!destroyed&&sceneCurrent(scene)});
        if(!destroyed){if(Number.isInteger(result.backgroundIndex)){backgroundSourceId=result.scene.slots[result.backgroundIndex]?.sourceId||'';backgroundFile=null;}lastScene=null;onSelectScene?.(result.scene);onSelectSource?.(result.sourceIndex);onChange?.();refresh();}
      },'Graphic scene created in Preview. Use Cut/Fade when ready.'),{blocked:!backgroundFile&&!candidates.some(source=>source.id===backgroundSourceId),aria:'Create graphic scene in Preview'});
      if(typeof studio.createAudienceGraphicScene!=='function'){create.dataset.blocked='true';create.disabled=true;}
      note(fields,'Creates a new Preview scene with separate background and graphics layers. The current Programme stays on air.');
      section.open=!!backgroundFile||!!backgroundSourceId;
    }
    function sourceButtons(parent){const row=actions(parent);for(const [mode,label] of [['results','Add results'],['join','Add join / QR'],['leaderboard','Add leaderboard']])button(row,label,()=>addSource(liveSourceConfig(mode)),{blocked:!session||mode!=='join'&&!currentQuestion(),aria:label+' to Preview'});}
    function liveControls(parent){
      heading(parent,'Live control');
      const section=make('div',parent,undefined,'bc-audience-fields');liveTitle=make('div',section,'','bc-audience-live-title');liveState=make('div',section,'','bc-audience-live-state');counts=make('div',section,'','bc-audience-counts');counts.setAttribute('aria-live','polite');
      const controls=actions(section),id=sessionId;
      button(controls,'Activate',()=>perform(()=>activateQuestion(currentQuestion()?.id,id),'Question activated.'),{blocked:!currentQuestion(),aria:'Activate selected question'});
      button(controls,'Open',()=>perform(()=>action('open',{},id),'Responses are open.'),{blocked:!activeQuestion(),aria:'Open audience responses'});
      button(controls,'Close',()=>perform(()=>action('close',{},id),'Responses are closed.'),{blocked:!activeQuestion(),aria:'Close audience responses'});
      const results=controls;button(results,'Show results',()=>perform(()=>action('reveal',{},id),'Results shown.'),{blocked:!activeQuestion(),aria:'Show audience results'});button(results,'Hide results',()=>perform(()=>action('hide-results',{},id),'Results hidden.'),{blocked:!activeQuestion(),aria:'Hide audience results'});
      const navigation=controls;for(const [delta,label] of [[-1,'Previous'],[1,'Next']]){const index=session?.questions?.findIndex(q=>q.id===session.activeQuestionId)??-1;button(navigation,label,()=>perform(()=>{const current=session?.questions?.findIndex(q=>q.id===session.activeQuestionId)??-1,next=current<0?null:session.questions[current+delta];if(!next)throw Error('There is no '+label.toLowerCase()+' question.');return activateQuestion(next.id,id);},'Question activated.'),{blocked:index<0||!session?.questions?.[index+delta],aria:label+' audience question'});}
      button(navigation,'Reset',()=>perform(resetAnswers,'Answers reset; the backup was '+backupLocation()+'.'),{blocked:!currentQuestion(),aria:'Export and reset audience answers'});
      updateLive();
    }
    function updateLive(){
      const q=activeQuestion(),aggregate=session?.aggregates?.[q?.id]||session?.results?.[q?.id]||{};
      if(liveTitle)liveTitle.textContent=q?'Active · '+q.title:'No active question';
      if(liveState)liveState.textContent=session?(session.open?'Responses open':'Responses closed')+' · '+(session.showResults?'Results visible':'Results hidden'):'';
      if(counts)counts.textContent=session?'Responses '+(aggregate.responses??session.responseCount??'N/A')+' · Participants '+(aggregate.totalParticipants??session.totalParticipants??session.participantCount??'N/A'):'';
      const state=session?.questionStates?.[q?.id],canOpen=!!q&&!['content','chart'].includes(q.type)&&state?.canOpen!==false;
      for(const [label,blocked,pressed,reason] of [
        ['Open audience responses',!canOpen||!!session?.open,!!session?.open,state?.reopenReason||(!canOpen?'This slide does not accept responses.':'Open responses to the active question')],
        ['Close audience responses',!q||!session?.open,!!q&&!session?.open,'Close responses to the active question'],
        ['Show audience results',!q||!!session?.showResults,!!session?.showResults,'Reveal results for the active question'],
        ['Hide audience results',!q||!session?.showResults,!!q&&!session?.showResults,'Hide results for the active question']]){
        const el=shell.querySelector('[aria-label="'+label+'"]');if(el){el.dataset.blocked=String(blocked);el.disabled=busy||!live()||blocked;el.setAttribute('aria-pressed',String(pressed));el.title=reason;}
      }
      for(const [delta,label] of [[-1,'Previous'],[1,'Next']]){const el=shell.querySelector('[aria-label="'+label+' audience question"]'),index=session?.questions?.findIndex(item=>item.id===session.activeQuestionId)??-1,blocked=index<0||!session?.questions?.[index+delta];if(el){el.dataset.blocked=String(blocked);el.disabled=busy||!live()||blocked;}}
      renderProof();
      updateModeration();
    }
    function resultCharts(q){if(!q)return [];if(q.type==='chart')return charts;if(['multiple-choice','ranking','allocation','quiz-choice'].includes(q.type))return charts.filter(item=>!['gauge','scatter','word-cloud'].includes(item.id));if(['number','scales'].includes(q.type))return charts.filter(item=>!['scatter','word-cloud'].includes(item.id));return [];}
    function livePresentation(parent){
      const q=currentQuestion();heading(parent,'Selected question',q?.id===session?.activeQuestionId?'Active':'Preview');
      if(!q){note(parent,'Add a question to prepare your audience presentation.');return;}
      note(parent,q.title);
      const choices=resultCharts(q),fields=make('div',parent,undefined,'bc-audience-fields');
      if(choices.length){if(!choices.some(item=>item.id===liveChart))liveChart=choices[0].id;field(fields,'Results layout',liveChart,'select',value=>{liveChart=value;paintProof(liveSourceConfig());},choices);}
      field(fields,'Include join QR',liveShowQR,'checkbox',value=>{liveShowQR=value;paintProof(liveSourceConfig());});
      graphicDesign(parent,liveDesign,()=>paintProof(liveSourceConfig()));
      graphicSceneControls(parent,()=>liveSourceConfig(),liveDesign);
      sourceButtons(parent);
      proofCanvas=named(make('canvas',parent,undefined,'bc-audience-proof'),'Live audience output preview');proofCanvas.width=640;proofCanvas.height=360;paintProof(liveSourceConfig());
      note(parent,'Add the selected question to Preview, then use Cut/Fade. Existing on-air sources keep their pinned question.');
    }
    function livePanel(parent){
      const controls=make('section',parent,undefined,'bc-audience-live-controls');liveControls(controls);
      const grid=make('div',parent,undefined,'bc-audience-onair-grid'),stage=make('section',grid,undefined,'bc-audience-stage');livePresentation(stage);
      const join=make('section',grid,undefined,'bc-audience-join');participation(join);
      if(['q&a','open-ended','word-cloud'].includes(currentQuestion()?.type))moderation(parent);
    }
    function questionList(parent){
      const list=make('section',parent,undefined,'bc-audience-question-list');heading(list,'Question rundown',String(session?.questions?.length||0));
      const add=make('div',list,undefined,'bc-audience-fields');field(add,'New question type',newType,'select',value=>{newType=value;},types);
      button(add,'+ Add question',()=>perform(async()=>{const result=await action('add-question',{question:defaultQuestion(newType)});const next=result.question?.id||result.questionId||result.session?.questions?.at(-1)?.id;if(next)chooseQuestion(next);},'Question added.'),{blocked:!session,aria:'Add audience question'});
      const rows=make('div',list,undefined,'bc-audience-question-rows');
      for(const [index,q] of (session?.questions||[]).entries()){
        const row=make('div',rows,undefined,'bc-audience-question-row'+(q.id===questionId?' selected':'')+(q.id===session.activeQuestionId?' current':''));
        const label=button(row,'',()=>chooseQuestion(q.id),{aria:'Select question '+q.title,cls:'btn bc-audience-question-label'});
        make('span',label,String(index+1)+' · '+q.title);make('small',label,(types.find(item=>item.id===q.type)?.label||q.type)+(q.id===session.activeQuestionId?' · Active':'')+(questionDrafts.has(sessionId+':'+q.id)||q.id===questionId&&dirty?' · Draft':''));
        for(const [delta,label,symbol] of [[-1,'up','↑'],[1,'down','↓']])button(row,symbol,()=>perform(async()=>{const next=copy(session.questions),current=next.findIndex(item=>item.id===q.id);if(current<0||current+delta<0||current+delta>=next.length)throw Error('The question order changed. Select it again before moving.');next.splice(current+delta,0,next.splice(current,1)[0]);await action('update',{questions:next});},'Question order updated.'),{blocked:index+delta<0||index+delta>=session.questions.length,aria:'Move question '+q.title+' '+label});
      }
    }
    function questionFields(parent){
      const q=questionDraft;if(!q){note(parent,'Create a session and add a question. Participants answer the active question.');return;}
      heading(parent,'Question settings',types.find(item=>item.id===q.type)?.label||q.type);const fields=make('div',parent,undefined,'bc-audience-fields');
      field(fields,'Question title',q.title,'text',value=>editQuestion({title:value}));
      field(fields,'Question type',q.type,'select',value=>{questionError='';editQuestion({...defaultQuestion(value),id:q.id,title:q.title});questionRawData=JSON.stringify(questionDraft?.data||[],null,2);draw();},types);
      field(fields,'Question description',q.description||'','textarea',value=>editQuestion({description:value}));
      if(['multiple-choice','ranking','allocation','quiz-choice'].includes(q.type)){
        field(fields,'Options · one per line',(q.options||[]).map(item=>item.label).join('\n'),'textarea',value=>{const old=questionDraft.options||[];editQuestion({options:value.split(/\r?\n/).filter(value=>value.trim()).map((label,index)=>({id:old[index]?.id||'option-'+(index+1),label:label.trim()}))});});
        if(q.type==='multiple-choice')field(fields,'Multiple answers',q.multiple,'checkbox',value=>editQuestion({multiple:value}));
      }
      if(['scales','number'].includes(q.type)){field(fields,'Minimum',q.min??1,'number',value=>editQuestion({min:value}),[],{min:-1000000,max:1000000,step:'any'});field(fields,'Maximum',q.max??5,'number',value=>editQuestion({max:value}),[],{min:-1000000,max:1000000,step:'any'});field(fields,'Step',q.step??1,'number',value=>editQuestion({step:value}),[],{min:.000001,max:1000000,step:'any'});field(fields,'Minimum label',q.minLabel||'','text',value=>editQuestion({minLabel:value}));field(fields,'Maximum label',q.maxLabel||'','text',value=>editQuestion({maxLabel:value}));}
      if(q.type==='word-cloud')field(fields,'Words per response',q.maxWords??3,'number',value=>editQuestion({maxWords:value}),[],{min:1,max:10});
      if(['open-ended','q&a','quiz-text'].includes(q.type))field(fields,'Answer length',q.maxLength??500,'number',value=>editQuestion({maxLength:value}),[],{min:1,max:1000});
      if(q.type==='allocation')field(fields,'Points to allocate',q.total??100,'number',value=>editQuestion({total:value}),[],{min:1,max:10000});
      if(['points','grid','pin-image'].includes(q.type)){field(fields,'X axis label',q.xLabel||'X','text',value=>editQuestion({xLabel:value}));field(fields,'Y axis label',q.yLabel||'Y','text',value=>editQuestion({yLabel:value}));}
      if(q.type==='quiz-choice')field(fields,'Correct option',q.correctAnswer||q.options?.[0]?.id||'','select',value=>editQuestion({correctAnswer:value}),(q.options||[]).map(item=>[item.id,item.label]));
      if(q.type==='quiz-text')field(fields,'Correct answer',q.correctAnswer||'','text',value=>editQuestion({correctAnswer:value}));
      if(['quiz-choice','quiz-text'].includes(q.type))field(fields,'Score',q.points??1000,'number',value=>editQuestion({points:value}),[],{min:0,max:10000});
      if(q.type==='quiz-text')field(fields,'Case sensitive',q.caseSensitive,'checkbox',value=>editQuestion({caseSensitive:value}));
      if(q.type==='form'){
        const form=make('div',fields,undefined,'bc-audience-form-fields');
        for(const [index,item] of (q.fields||[]).entries()){
          const row=make('div',form,undefined,'bc-audience-form-field');
          const patch=(key,value)=>{const next=copy(questionDraft.fields);next[index][key]=value;editQuestion({fields:next});};
          field(row,'Field '+(index+1)+' label',item.label,'text',value=>patch('label',value));
          field(row,'Field '+(index+1)+' type',item.type||'text','select',value=>patch('type',value),[['text','Text'],['number','Number'],['email','Email']]);
          field(row,'Field '+(index+1)+' required',item.required,'checkbox',value=>patch('required',value));
          button(row,'−',()=>{const next=copy(questionDraft.fields);next.splice(index,1);editQuestion({fields:next});draw();},{blocked:q.fields.length<=1,aria:'Remove form field '+(index+1)});
        }
        button(form,'+ Add field',()=>{const next=copy(questionDraft.fields||[]);let n=next.length+1;while(next.some(item=>item.id==='field_'+n))n++;next.push({id:'field_'+n,label:'Field '+n,type:'text',required:false});editQuestion({fields:next});draw();},{blocked:(q.fields?.length||0)>=12,aria:'Add audience form field'});
      }
      if(q.type==='pin-image')field(fields,'Image URL',q.imageUrl||'','url',value=>editQuestion({imageUrl:value}));
      if(q.type==='content')field(fields,'Content',q.body||'','textarea',value=>editQuestion({body:value}));
      if(q.type==='chart'){field(fields,'Question chart',q.chart||'bar','select',value=>editQuestion({chart:value}),charts);field(fields,'Question chart data',questionRawData,'textarea',value=>{editQuestion({});questionRawData=value;try{questionDraft.data=parseData(value);questionError='';}catch(error){questionError=error.message;throw error;}});}
      const row=actions(fields),id=sessionId,qid=q.id;
      button(row,'Save question',()=>perform(async()=>{if(questionError)throw Error(questionError);if(!isSession(id)||currentQuestion()?.id!==qid)throw Error('The question changed.');if(dirty&&questionBase!==JSON.stringify(currentQuestion()))throw Error('This question changed in another editor. Your draft is kept. Copy any needed text, then Discard to load the current question.');const next=copy(questionDraft);await action('update-question',{questionId:qid,question:next},id);questionDrafts.delete(id+':'+qid);dirty=false;loadQuestion();},'Question saved.'),{aria:'Save audience question'});
      button(row,'Discard',()=>{questionDrafts.delete(sessionId+':'+questionId);dirty=false;loadQuestion();draw();},{aria:'Discard question draft'});
      const history=actions(fields);button(history,'Undo draft',()=>{if(!undo.length)return;redo.push(copy(questionDraft));questionDraft=undo.pop();questionRawData=JSON.stringify(questionDraft.data||[],null,2);dirty=true;questionError='';draw();},{blocked:!undo.length,aria:'Undo audience question draft'});button(history,'Redo draft',()=>{if(!redo.length)return;undo.push(copy(questionDraft));questionDraft=redo.pop();questionRawData=JSON.stringify(questionDraft.data||[],null,2);dirty=true;questionError='';draw();},{blocked:!redo.length,aria:'Redo audience question draft'});
      const tools=actions(fields);button(tools,'Duplicate question',()=>perform(async()=>{const next=copy(questionDraft);delete next.id;next.title+=' copy';const result=await action('add-question',{question:next},id);const added=result.question?.id||result.questionId||result.session?.questions?.at(-1)?.id;if(added)chooseQuestion(added);},'Question duplicated.'),{aria:'Duplicate selected audience question'});
      button(tools,'Delete question',()=>perform(async()=>{await exportSession(id,{beforeDestructive:true});if(!isSession(id)||currentQuestion()?.id!==qid)throw Error('The question changed.');await action('remove-question',{questionId:qid},id);dirty=false;questionDraft=currentQuestion()?copy(currentQuestion()):null;},'Question removed; the backup was '+backupLocation()+'.'),{aria:'Delete selected audience question'});
    }
    function moderation(parent){heading(parent,'Moderation');moderationRoot=make('div',parent,undefined,'bc-audience-moderation');lastModerationSignature='';updateModeration();}
    function updateModeration(){
      if(!moderationRoot)return;const q=currentQuestion();const entries=session?.responses?.[q?.id]||session?.responseEntries?.[q?.id]||session?.aggregates?.[q?.id]?.entries||[];
      const signature=JSON.stringify([q?.id,entries]);if(signature===lastModerationSignature)return;lastModerationSignature=signature;moderationRoot.replaceChildren();
      if(!['q&a','open-ended','word-cloud'].includes(q?.type)){note(moderationRoot,'Text responses, word clouds and Q&A can be hidden or restored here.');return;}
      if(!entries.length){note(moderationRoot,'No responses yet.');return;}
      const id=sessionId,qid=q.id;for(const entry of entries){const row=make('div',moderationRoot,undefined,'bc-audience-response-row');make('span',row,String(entry.text??entry.answer??entry.value??entry.response??'Response'));button(row,entry.hidden?'Show':'Hide',()=>perform(()=>action('moderate',{questionId:qid,responseId:entry.id,hidden:!entry.hidden},id),'Response moderation updated.'),{aria:(entry.hidden?'Restore':'Hide')+' response '+entry.id});}
    }
    function clearProof(){proofSerial++;if(proofFrame!==null)window.cancelAnimationFrame?.(proofFrame);proofFrame=null;proof?.dispose?.();proof=null;proofCanvas=null;}
    function renderProof(){
      if(!proof||!proofCanvas||!live()||typeof shell.getClientRects==='function'&&!shell.getClientRects().length)return;proof.renderFrame?.();const ctx=proofCanvas.getContext('2d'),w=proofCanvas.width,h=proofCanvas.height;ctx.clearRect(0,0,w,h);
      const background=!editorOnly&&backgroundCandidates().find(source=>source.id===backgroundSourceId),el=background?.el;
      if(el){const sw=el.videoWidth||el.naturalWidth||el.width,sh=el.videoHeight||el.naturalHeight||el.height;if(sw>0&&sh>0){const scale=Math.max(w/sw,h/sh);ctx.drawImage(el,(w-sw*scale)/2,(h-sh*scale)/2,sw*scale,sh*scale);}}
      ctx.drawImage(proof.el,0,0,w,h);
      if(proofFrame===null&&window.requestAnimationFrame&&(proof.isAnimating?.()||background?.kind==='video'))proofFrame=window.requestAnimationFrame(()=>{proofFrame=null;renderProof();});
    }
    function invalidProof(message){proofSerial++;proof?.dispose?.();proof=null;if(proofCanvas){const ctx=proofCanvas.getContext('2d');ctx.clearRect(0,0,proofCanvas.width,proofCanvas.height);ctx.fillStyle='#e7e7ec';ctx.fillRect(0,0,proofCanvas.width,proofCanvas.height);ctx.fillStyle='#25272a';ctx.font='16px Arial';ctx.fillText('Correct the dataset to preview this chart.',20,40);}say(message);}
    async function paintProof(config){
      if(!proofCanvas||destroyed)return;const serial=++proofSerial,canvas=proofCanvas;proof?.dispose?.();proof=null;
      try{const runtime=A.create(A.normalize(config),{document:doc});proof=runtime;await runtime.prepare?.();if(destroyed||serial!==proofSerial||canvas!==proofCanvas){runtime.dispose?.();if(proof===runtime)proof=null;return;}renderProof();}
      catch(error){if(!destroyed&&serial===proofSerial)say(error.message||String(error));}
    }
    function chartConfig(){return A.normalize({...chartDraft,data:parseData(chartText)});}
    function chartsPanel(parent){
      heading(parent,'Charts & statistics','Manual data');const workspace=make('div',parent,undefined,'bc-audience-chart-workspace'),controls=make('div',workspace,undefined,'bc-audience-chart-controls'),preview=make('div',workspace,undefined,'bc-audience-chart-preview');const fields=make('div',controls,undefined,'bc-audience-fields');
      field(fields,'Chart title',chartDraft.title,'text',value=>{chartDraft.title=value;paintProof(chartConfig());});field(fields,'Chart type',chartDraft.chart,'select',value=>{chartDraft.chart=value;paintProof(chartConfig());},charts);
      field(fields,'Transparent',chartDraft.transparent,'checkbox',value=>{chartDraft.transparent=value;paintProof(chartConfig());});
      graphicDesign(controls,chartDraft,()=>paintProof(chartConfig()));
      graphicSceneControls(controls,chartConfig,chartDraft);
      const data=make('section',controls,undefined,'bc-audience-data-editor');heading(data,'Data table','Your labels and values');
      const table=make('div',data,undefined,'bc-audience-data-table');let rows=[],dataValid=true;
      try{rows=parseData(chartText).map(item=>({...item,value:String(item.value),...(item.x!==undefined?{x:String(item.x)}:{}),...(item.y!==undefined?{y:String(item.y)}:{})}));}catch(error){dataValid=false;note(data,'Correct the imported dataset below to edit its rows.');}
      const writeRows=()=>{const csv=value=>'"'+String(value??'').replace(/"/g,'""')+'"';chartText=rows.map(row=>[row.label,row.value,row.x??'',row.y??''].map(csv).join(',')).join('\n');const raw=shell.querySelector('[aria-label="Chart dataset"]');if(raw)raw.value=chartText;try{paintProof(chartConfig());say('');}catch(error){invalidProof(error.message);}};
      const drawRows=()=>{table.replaceChildren();const labels=make('div',table,undefined,'bc-audience-data-row');for(const name of ['Label','Value','X','Y',''])make('span',labels,name);for(const [index,row] of rows.entries()){const tr=make('div',table,undefined,'bc-audience-data-row');for(const key of ['label','value','x','y']){const input=named(make('input',tr),'Data '+key+' '+(index+1));input.type='text';input.value=row[key]??'';input.inputMode=key==='label'?'text':'decimal';input.maxLength=key==='label'?120:24;input.addEventListener('input',()=>{if(input.disabled||!shell.contains(input))return;row[key]=input.value;writeRows();});}button(tr,'×',()=>{rows.splice(index,1);writeRows();drawRows();},{blocked:rows.length<=1,aria:'Remove data row '+(index+1)});}};drawRows();
      const addRow=button(data,'+ Add data row',()=>{if(rows.length>=200)throw Error('Use up to 200 chart rows.');rows.push({label:'Category '+(rows.length+1),value:'0'});writeRows();drawRows();},{aria:'Add chart data row',blocked:!dataValid});
      const imported=make('details',data,undefined,'bc-audience-data-import');imported.open=!dataValid;make('summary',imported,'Import / paste data','mon-head');
      field(imported,'Chart dataset',chartText,'textarea',value=>{chartText=value;try{const config=chartConfig();rows=config.data.map(item=>({...item,value:String(item.value)}));dataValid=true;addRow.dataset.blocked='false';drawRows();paintProof(config);say('');}catch(error){dataValid=false;rows=[];drawRows();addRow.dataset.blocked='true';invalidProof(error.message);}setBusy();});
      note(imported,'CSV / tab-separated: label, value, optional x, y. JSON arrays are also accepted. X and Y are used for scatter plots.');
      heading(preview,'Output preview','16:9');const row=actions(preview);button(row,'Add chart to Preview',()=>addSource(chartConfig()),{aria:'Add chart to Preview'});
      proofCanvas=named(make('canvas',preview,undefined,'bc-audience-proof'),'Chart source preview');proofCanvas.width=640;proofCanvas.height=360;try{paintProof(chartConfig());}catch(error){invalidProof(error.message);}
      note(preview,'Edit labels and values in the table. Add to Preview, then use Cut/Fade when ready.');
    }
    function sourceSettings(parent){
      const value=target;if(!value||!sourceDraft)return;heading(parent,'Audience source',sourceDraft.mode==='data'?'Statistics':'Live session');const fields=make('div',parent,undefined,'bc-audience-fields');
      const locked=!!value.slot.locked;if(locked)note(fields,'Unlock this source before applying settings.');
      field(fields,'Source title',sourceDraft.title||'','text',text=>{sourceDraft.title=text;});
      if(sourceDraft.mode!=='data')note(fields,'Leave Source title empty to follow the question title.');
      field(fields,'Source view',sourceDraft.mode||'results','select',mode=>{sourceDraft.mode=mode;sourceError='';draw();},[['results','Question results'],['join','Join / QR'],['leaderboard','Leaderboard'],['data','Manual chart']]);
      const pinned=session?.id===sourceDraft.sessionId?session.questions?.find(item=>item.id===sourceDraft.questionId):null;
      const categorical=['multiple-choice','ranking','allocation','quiz-choice'].includes(pinned?.type),numeric=['number','scales'].includes(pinned?.type);
      const applicable=sourceDraft.mode==='data'||sourceDraft.mode==='results'&&(categorical||numeric||pinned?.type==='chart');
      let available=[];
      if(applicable){
        available=charts.filter(item=>{if(sourceDraft.mode==='data'||pinned?.type==='chart')return true;return !(numeric?['scatter','word-cloud']:['scatter','gauge']).includes(item.id);});
        const selectedChart=available.some(item=>item.id===sourceDraft.chart)?sourceDraft.chart:'';
        field(fields,'Result chart',selectedChart,'select',chart=>{sourceDraft.chart=chart;},selectedChart?available:[{id:'',label:'Choose a supported chart'},...available]);
        if(selectedChart!==sourceDraft.chart)note(fields,'The saved chart is incompatible with this question. Choose a supported chart before applying.');
      }else if(sourceDraft.mode==='results')note(fields,pinned?'This question uses its '+(types.find(item=>item.id===pinned.type)?.label||pinned.type)+' layout.':'Choose a session and pinned question to configure its results.');
      field(fields,'Transparent',sourceDraft.transparent,'checkbox',transparent=>{sourceDraft.transparent=transparent;});field(fields,'Show QR',sourceDraft.showQR,'checkbox',showQR=>{sourceDraft.showQR=showQR;});
      graphicDesign(fields,sourceDraft,()=>{if(!sourceError)paintProof(sourceDraft);});
      if(sourceDraft.mode==='data')field(fields,'Source chart dataset',sourceRawData,'textarea',text=>{sourceRawData=text;try{sourceDraft.data=parseData(text);sourceError='';paintProof(sourceDraft);}catch(error){sourceError=error.message;invalidProof(error.message);}});
      else{
        field(fields,'Source session',sourceDraft.sessionId||'','select',id=>{sourceDraft.sessionId=id;const known=sessions.find(item=>item.id===id);if(known){sourceDraft.viewToken=known.viewToken;sourceDraft.joinUrl=chosenJoin(known);}sourceDraft.questionId='';chooseSession(id);},[['','Choose a session'],...sessions.map(item=>[item.id,item.title])]);
        if(sourceDraft.mode==='results')field(fields,'Pinned question',sourceDraft.questionId||'','select',id=>{sourceDraft.questionId=id;draw();},[['','Select a question'],...(session?.id===sourceDraft.sessionId?session.questions||[]:[]).map(item=>[item.id,item.title])]);
      }
      const row=actions(fields);button(row,'Apply settings',()=>perform(async()=>{if(sourceError)throw Error(sourceError);if(applicable&&!available.some(item=>item.id===sourceDraft.chart))throw Error('Choose a supported chart for this question.');if(!targetCurrent(value))throw Error('The selected source changed.');if(value.slot.locked)throw Error('Unlock this source before editing.');const config=A.normalize(sourceDraft);await studio.updateAudienceSource(value.scene.id,value.index,config,{expected:value.slot,isCurrent:()=>!destroyed&&targetCurrent(value)});lastSource=null;onSelectSource?.(value.index);refresh();},'Audience source settings applied in Preview.'),{blocked:locked,aria:'Apply audience source settings',title:'Apply audience source settings'});
      button(row,'Reload settings',()=>{if(!targetCurrent(value))throw Error('The selected source changed.');sourceDraft=copy(value.source.config||value.source._sourceConfig);sourceRawData=JSON.stringify(sourceDraft.data||[],null,2);sourceError='';draw();},{aria:'Reload audience source settings',title:'Reload audience source settings'});
      if(sourceDraft.mode==='results')button(fields,'Edit pinned question',()=>{rememberQuestion();questionId=sourceDraft.questionId||session?.activeQuestionId||'';loadQuestion();tab='questions';openWorkspace();},{blocked:!session||session.id!==sourceDraft.sessionId||!session.questions?.some(item=>item.id===sourceDraft.questionId),aria:'Edit pinned audience question'});
      if(sourceDraft.mode!=='data'&&session?.id===sourceDraft.sessionId){liveControls(parent);participation(parent);moderation(parent);}else if(sourceDraft.mode==='data'){proofCanvas=named(make('canvas',parent,undefined,'bc-audience-proof'),'Audience source preview');proofCanvas.width=640;proofCanvas.height=360;if(sourceError)invalidProof(sourceError);else paintProof(sourceDraft);}
    }
    function draw(){
      if(destroyed)return;clearProof();body.replaceChildren();counts=null;liveTitle=null;liveState=null;moderationRoot=null;
      if(editorOnly&&!dialog){if(target)sourceSettings(body);else note(body,'Select an Audience or statistics source in Sources.');setBusy();return;}
      const head=heading(body,'Audience production');if(!dialog)button(head,'Open workspace',openWorkspace,{aria:'Open audience workspace'});
      const tabs=[['live','Live'],['questions','Questions'],['charts','Charts']],nav=make('div',body,undefined,'bc-audience-nav');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Audience views');
      for(const [id,label] of tabs){const el=button(nav,label,()=>{tab=id;draw();},{cls:'ptab'+(tab===id?' active':''),aria:'Audience '+label});el.id=editorId+'-'+id;el.setAttribute('role','tab');el.setAttribute('aria-selected',String(tab===id));el.setAttribute('aria-controls',editorId+'-panel');el.tabIndex=tab===id?0:-1;el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=tabs.findIndex(item=>item[0]===tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;tab=tabs[next][0];draw();shell.querySelector('[aria-label="Audience '+tabs[next][1]+'"]')?.focus();});}
      const panel=make('div',body,undefined,'bc-audience-panel');panel.id=editorId+'-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',editorId+'-'+tab);
      if(tab==='charts'){chartsPanel(panel);setBusy();return;}
      sessionControls(panel);
      if(!session)note(panel,'Create or choose a session, then add your questions. You can prepare chart sources independently in Charts.');
      const split=make('div',panel,undefined,'bc-audience-split');questionList(split);const detail=make('section',split,undefined,'bc-audience-detail');
      if(tab==='questions')questionFields(detail);else livePanel(detail);
      setBusy();
    }
    function closeWorkspace(){if(!dialog)return;root.appendChild(shell);const old=dialog;dialog=null;old.remove();draw();}
    function openWorkspace(){
      if(dialog)return;dialog=make('dialog',doc.body,undefined,'bc-source-dialog bc-audience-dialog');named(dialog,'Audience production workspace');const head=make('header',dialog);make('span',head,'Audience production');const close=make('button',head,'×','btn');close.type='button';named(close,'Close audience workspace');close.addEventListener('click',closeWorkspace);dialog.addEventListener('cancel',event=>{event.preventDefault();closeWorkspace();});dialog.appendChild(shell);draw();dialog.showModal();
    }
    function refresh(){
      if(destroyed)return;const value=selected(),scene=getScene();
      if((value?.source||null)!==lastSource||(value?.slot||null)!==lastSlot||scene!==lastScene){target=value;lastSource=value?.source||null;lastSlot=value?.slot||null;lastScene=scene;sourceDraft=value?copy(value.source.config||value.source._sourceConfig):null;sourceRawData=JSON.stringify(sourceDraft?.data||[],null,2);
        sourceError='';if(editorOnly&&sourceDraft?.sessionId){questionId=sourceDraft.questionId||'';if(sessionId!==sourceDraft.sessionId){sessionId=sourceDraft.sessionId;session=null;sync({redraw:true});}else{questionDraft=currentQuestion()?copy(currentQuestion()):null;dirty=false;questionError='';undo=[];redo=[];}}draw();
      }else setBusy();
      const now=Date.now();if(shouldSync()&&now>=nextPoll){nextPoll=now+2000;sync({list:!sessions.length});}
    }
    const timer=window.setInterval?.(()=>{if(shouldSync())sync();},2000);
    draw();if(!editorOnly)sync({list:true,redraw:true});
    return {refresh,show(value='live'){if(destroyed)return;if(['live','questions','charts'].includes(value))tab=value;refresh();draw();},destroy(){if(destroyed)return;rememberQuestion();destroyed=true;requestSerial++;controller?.abort?.();if(timer!==undefined)window.clearInterval?.(timer);clearProof();closeBackup(false);dialog?.remove();dialog=null;shell.remove();}};
  }
  return {mount,parseData};
})();
