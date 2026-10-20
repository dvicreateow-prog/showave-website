/* Participant capability client. Text is always rendered as text, never HTML. */
(()=>{
  'use strict';
  const byId=id=>document.getElementById(id),joinPanel=byId('joinPanel'),sessionPanel=byId('sessionPanel'),
    questionPanel=byId('questionPanel'),resultsPanel=byId('resultsPanel'),status=byId('voteStatus');
  let identity=null,session=null,questionKey='',answerReader=null,answerForm=null,pollTimer=null,busy=false,stopped=false,edited=false,
    generation=0,connected=false,joining=false,pollController=null,writeController=null,joinController=null,errorKind='';
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;};
  function say(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
  const policy=window.OpenLiveSessionPolicy;
  if(!policy?.sessionOnly){say('The session privacy policy did not load. Reload the participant page.',true);byId('joinForm').querySelector('button').disabled=true;return;}
  async function request(path,data,signal){
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},10000);
    try{const response=await fetch(path,{signal:controller.signal,cache:'no-store',referrerPolicy:'no-referrer',...(data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
      let value;try{value=await response.json();}catch{throw Error('The audience service returned an unreadable response.');}
      if(!response.ok)throw Object.assign(Error(value.error||'Audience service is unavailable'),{status:response.status});return value;
    }catch(error){if(timedOut)throw Error('The audience service did not respond. Check the connection and try again.');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  function remembered(code){try{return JSON.parse(localStorage.getItem('openlive.audience.participant.'+code)||'null');}catch{return null;}}
  function remember(value){try{localStorage.setItem('openlive.audience.participant.'+value.session.code,JSON.stringify({sessionId:value.sessionId,participantId:value.participantId,token:value.token,name:value.name}));}catch{/* Private browsing can disable storage; voting still works. */}}
  function forget(code,token){try{if(!token||remembered(code)?.token===token)localStorage.removeItem('openlive.audience.participant.'+code);}catch{}}
  function markEdited(){edited=true;errorKind='';}
  function label(name,input){const node=el('label',name);node.append(input);return node;}
  function input(type,value){const node=el('input');node.type=type;if(value!==undefined)node.value=String(value);return node;}
  function readNumber(node){const value=Number(node.value);if(!node.value.trim()||!Number.isFinite(value))throw Error('Enter a valid number');return value;}
  function disableForm(){if(!answerForm)return;const available=session?.open&&connected&&!busy;for(const node of answerForm.elements)node.disabled=!available||node.dataset.blocked==='true';
    const submit=answerForm.querySelector('[type=submit]');if(submit)submit.textContent=busy?'Sending…':session?.answered?'Update response':'Submit response';
    const quiz=session?.question?.type?.startsWith('quiz-');if(quiz&&session?.answered){for(const node of answerForm.elements)node.disabled=true;if(submit)submit.textContent='Answer submitted';}
  }
  function ranking(question,value){
    let order=Array.isArray(value)?value.slice():question.options.map(option=>option.id);const list=el('ol',undefined,'aud-ranking');
    function paint(){list.replaceChildren();order.forEach((id,index)=>{const row=el('li'),name=question.options.find(option=>option.id===id)?.label||id;
      row.append(el('span',(index+1)+' · '+name));for(const [delta,title,glyph]of[[-1,'Move up','↑'],[1,'Move down','↓']]){const button=el('button',glyph);button.type='button';button.setAttribute('aria-label',title+' '+name);button.disabled=index+delta<0||index+delta>=order.length;button.dataset.blocked=String(button.disabled);button.addEventListener('click',()=>{const to=index+delta;if(to<0||to>=order.length)return;[order[index],order[to]]=[order[to],order[index]];markEdited();paint();disableForm();});row.append(button);}list.append(row);});}
    paint();return{node:list,read:()=>order.slice()};
  }
  function coordinate(question,value){
    const wrapper=el('div'),area=el('div',undefined,'aud-coordinate'),pin=el('span',undefined,'aud-pin');
    area.setAttribute('aria-label','Select a position');
    if(question.imageUrl){const image=el('img');image.src=question.imageUrl;image.alt='Question image';image.referrerPolicy='no-referrer';image.addEventListener('load',()=>{if(image.naturalWidth&&image.naturalHeight){area.style.height='auto';area.style.aspectRatio=image.naturalWidth+'/'+image.naturalHeight;}});image.addEventListener('error',()=>{if(questionPanel.contains(wrapper)&&session?.question?.id===question.id){errorKind='image';say('The question image could not load. Use the X and Y fields to answer.',true);}});area.append(image);}
    area.append(pin);const fields=el('div',undefined,'aud-coordinate-fields'),x=input('number',value?.x??50),y=input('number',value?.y??50);
    for(const node of[x,y]){node.min='0';node.max='100';node.step='0.1';node.required=true;}
    fields.append(label((question.xLabel||'X')+' (%)',x),label((question.yLabel||'Y')+' (%)',y));
    function paint(){pin.style.left=Math.max(0,Math.min(100,Number(x.value)))+'%';pin.style.top=(100-Math.max(0,Math.min(100,Number(y.value))))+'%';}
    for(const node of[x,y])node.addEventListener('input',paint);
    area.addEventListener('pointerdown',event=>{if(!session?.open||!connected||busy)return;const rect=area.getBoundingClientRect();x.value=(100*Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width))).toFixed(1);y.value=(100*(1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height)))).toFixed(1);markEdited();paint();});
    paint();wrapper.append(area,fields);return{node:wrapper,read:()=>({x:readNumber(x),y:readNumber(y)})};
  }
  function renderQuestion(draft){
    const question=session.question;questionPanel.replaceChildren();answerForm=null;answerReader=null;edited=false;
    if(!question){questionPanel.append(el('p','The presenter has not selected a question yet.','aud-closed'));return;}
    questionPanel.append(el('h1',question.title));if(question.description)questionPanel.append(el('p',question.description,'aud-description'));
    const value=draft===undefined?session.answer:draft,kind=question.type;
    if(kind==='content'){questionPanel.append(el('div',question.body||question.description||'','aud-content'));return;}
    if(kind==='chart'){questionPanel.append(el('p','Presenter data','aud-closed'));return;}
    answerForm=el('form',undefined,'aud-answer-form');
    if(kind.startsWith('quiz-')){const name=input('text',identity.name||'');name.maxLength=60;name.required=true;name.autocomplete='nickname';name.dataset.quizName='true';answerForm.append(label('Display name for the leaderboard',name));}
    if(kind==='multiple-choice'||kind==='quiz-choice'){
      const values=new Set(Array.isArray(value)?value:[value]);const inputs=question.options.map(option=>{const node=input(question.multiple?'checkbox':'radio',option.id);node.name='choice';node.checked=values.has(option.id);const row=el('label',undefined,'aud-choice');row.append(node,el('span',option.label));answerForm.append(row);return node;});
      answerReader=()=>{const selected=inputs.filter(node=>node.checked).map(node=>node.value);if(!selected.length)throw Error('Choose an answer');return question.multiple?selected:selected[0];};
    }else if(kind==='ranking'){const control=ranking(question,value);answerForm.append(control.node);answerReader=control.read;
    }else if(kind==='allocation'){
      const fields=el('div',undefined,'aud-allocation'),total=el('div',undefined,'aud-muted'),inputs=question.options.map(option=>{const node=input('number',value?.[option.id]??0);node.min='0';node.max=String(question.total);node.step='any';node.required=true;fields.append(label(option.label,node));return{node,id:option.id};});
      const update=()=>{const sum=inputs.reduce((sum,item)=>sum+(Number(item.node.value)||0),0);total.textContent=sum+' of '+question.total+' points allocated';};inputs.forEach(item=>item.node.addEventListener('input',update));update();answerForm.append(fields,total);answerReader=()=>{const result=Object.fromEntries(inputs.map(item=>[item.id,readNumber(item.node)]));if(Math.abs(Object.values(result).reduce((sum,item)=>sum+item,0)-question.total)>.00001)throw Error('Allocate exactly '+question.total+' points');return result;};
    }else if(kind==='word-cloud'||kind==='open-ended'||kind==='q&a'||kind==='quiz-text'){
      const node=kind==='quiz-text'?input('text',value||''):el('textarea');if(kind!=='quiz-text')node.value=Array.isArray(value)?value.join(', '):(value||'');node.required=true;node.maxLength=kind==='word-cloud'?500:(question.maxLength||1000);
      node.placeholder=kind==='word-cloud'?'Enter up to '+question.maxWords+' words or short phrases, separated by commas':kind==='q&a'?'Ask the presenter a question':'Your answer';answerForm.append(label(kind==='word-cloud'?'Words or phrases':'Your response',node));answerReader=()=>kind==='word-cloud'?node.value.split(/[,\n]+/).map(word=>word.trim()).filter(Boolean):node.value;
    }else if(kind==='scales'){
      const wrapper=el('div',undefined,'aud-scale'),node=input('range',value??question.min),output=el('output',node.value,'aud-scale-value'),ends=el('div',undefined,'aud-scale-ends');node.min=question.min;node.max=question.max;node.step=question.step;node.setAttribute('aria-label','Your rating');node.addEventListener('input',()=>output.textContent=node.value);ends.append(el('span',question.minLabel||question.min),el('span',question.maxLabel||question.max));wrapper.append(output,node,ends);answerForm.append(wrapper);answerReader=()=>readNumber(node);
    }else if(kind==='number'){const node=input('number',value??'');node.min=question.min;node.max=question.max;node.step='any';node.required=true;answerForm.append(label('Your number',node));answerReader=()=>readNumber(node);
    }else if(['points','grid','pin-image'].includes(kind)){const control=coordinate(question,value);answerForm.append(control.node);answerReader=control.read;
    }else if(kind==='form'){
      const nodes=question.fields.map(field=>{const node=input(field.type==='number'?'number':field.type==='email'?'email':'text',value?.[field.id]??'');node.required=field.required;node.maxLength=1000;if(field.type==='number')node.step='any';answerForm.append(label(field.label,node));return{field,node};});answerReader=()=>Object.fromEntries(nodes.map(({field,node})=>[field.id,field.type==='number'&&node.value?readNumber(node):node.value]));
    }else{questionPanel.append(el('p','This question type is not supported by this participant page.','aud-closed'));return;}
    const submit=el('button','Submit response','aud-primary');submit.type='submit';answerForm.append(submit);answerForm.addEventListener('input',markEdited);answerForm.addEventListener('submit',submitVote);questionPanel.append(answerForm);disableForm();
  }
  function renderResults(){
    resultsPanel.replaceChildren();resultsPanel.hidden=!session.showResults&&session.question?.type!=='chart';if(resultsPanel.hidden)return;
    const aggregate=session.aggregate||{};resultsPanel.append(el('div','Results','aud-section-head'));
    if(aggregate.words){const cloud=el('div',undefined,'aud-word-cloud'),max=Math.max(1,...aggregate.words.map(word=>word.count));for(const word of aggregate.words){const node=el('span',word.text);node.style.fontSize=(12+24*word.count/max)+'px';node.title=word.count+' responses';cloud.append(node);}resultsPanel.append(cloud);
    }else if(aggregate.series){const list=el('ul',undefined,'aud-chart-list'),max=Math.max(1,...aggregate.series.map(row=>Math.abs(row.value)));for(const row of aggregate.series){const item=el('li',undefined,'aud-result-row'),bar=el('div',undefined,'aud-bar'),fill=el('span');fill.style.width=100*Math.abs(row.value)/max+'%';bar.append(fill);item.append(el('span',row.label),bar,el('span',Number(row.value.toFixed(2))));list.append(item);}resultsPanel.append(list);}
    if(typeof aggregate.average==='number')resultsPanel.append(el('p','Average · '+Number(aggregate.average.toFixed(2))));
    if(aggregate.points){const table=el('table',undefined,'aud-table'),head=el('tr');head.append(el('th',session.question?.xLabel||'X'),el('th',session.question?.yLabel||'Y'));table.append(head);for(const point of aggregate.points.slice(0,30)){const row=el('tr');row.append(el('td',Number(point.x.toFixed(1))),el('td',Number(point.y.toFixed(1))));table.append(row);}resultsPanel.append(table);}
    if(aggregate.entries){for(const entry of aggregate.entries){const row=el('div',entry.text,'aud-result-entry');if(session.question?.type==='q&a'){const button=el('button','↑ '+entry.votes+' · Vote for this question');button.type='button';button.disabled=!session.open||!connected||busy;button.addEventListener('click',()=>sendAnswer({upvote:entry.id}));row.append(el('br'),button);}resultsPanel.append(row);}}
    if(aggregate.leaderboard){const table=el('table',undefined,'aud-table'),head=el('tr');head.append(el('th','Rank'),el('th','Participant'),el('th','Points'));table.append(head);for(const item of aggregate.leaderboard){const row=el('tr');row.append(el('td',item.rank),el('td',item.name),el('td',item.score));table.append(row);}resultsPanel.append(table);}
    const summary=el('div',undefined,'aud-result-summary');summary.append(el('span',(aggregate.responses||0)+' responses'),el('span',(aggregate.totalParticipants||session.totalParticipants||0)+' participants'));resultsPanel.append(summary);
    if(aggregate.histogramBinned)resultsPanel.append(el('p','Responses grouped into equal numeric ranges.','aud-muted'));
    if(aggregate.omittedResponses)resultsPanel.append(el('p','Showing '+aggregate.shownResponses+' of '+aggregate.responses+' responses.','aud-muted'));
  }
  function shape(question){if(!question)return '';const copy={...question};for(const key of['title','description','correctAnswer','caseSensitive'])delete copy[key];return JSON.stringify(copy);}
  function update(value){
    if(!identity||value.id!==identity.sessionId)return false;
    if(session?.id===value.id&&Number.isFinite(session.revision)&&Number.isFinite(value.revision)&&value.revision<session.revision)return false;
    const previous=session,reset=previous?.question?.id===value.question?.id&&previous?.answered&&!value.answered;
    let draft;const preserve=edited&&!reset&&previous?.question?.id===value.question?.id&&shape(previous?.question)===shape(value.question);
    const quizName=answerForm?.querySelector('[data-quiz-name]')?.value;
    if(preserve&&answerReader){try{draft=answerReader();}catch{/* Invalid drafts remain in the existing form during ordinary polls. */}}
    session=value;connected=true;if(errorKind==='network'||previous?.question?.id!==value.question?.id||previous?.responseEpoch!==value.responseEpoch)errorKind='';
    byId('sessionTitle').textContent=session.title;byId('sessionState').textContent=session.open?'Responses open':'Responses closed';
    const key=session.question?JSON.stringify(session.question):'none',answerChanged=JSON.stringify(previous?.answer)!==JSON.stringify(value.answer);
    if(key!==questionKey||reset||(!edited&&!busy&&answerChanged)){questionKey=key;renderQuestion(preserve?draft:undefined);if(preserve){edited=true;const name=answerForm?.querySelector('[data-quiz-name]');if(name&&quizName!==undefined)name.value=quizName;}}
    disableForm();renderResults();if(!busy&&!errorKind)say(session.question?(session.answered?'Response received. '+(session.question.type.startsWith('quiz-')?'Quiz answers are final.':session.open?'You can update your response.':''):(session.open?'The presenter is accepting responses.':'Waiting for the presenter to open responses.')):'Waiting for a question.');return true;
  }
  function leave(message){generation++;stopped=true;connected=false;joining=false;clearTimeout(pollTimer);pollTimer=null;for(const controller of[pollController,writeController,joinController])controller?.abort();pollController=writeController=joinController=null;busy=false;identity=null;session=null;questionKey='';joinPanel.hidden=false;sessionPanel.hidden=true;byId('leaveButton').hidden=true;byId('joinForm').querySelector('button').disabled=false;say(message||'You have left the session. Your submitted responses remain with the presenter.');}
  async function join(code,name){
    if(joining)return;joining=true;stopped=false;const current=++generation,controller=new AbortController();joinController=controller;byId('joinForm').querySelector('button').disabled=true;byId('leaveButton').hidden=false;byId('leaveButton').textContent='Cancel';say('Joining the audience session…');
    try{await policy.ready;if(current!==generation)return;
      const saved=remembered(code),value=await request('/api/audience/join',{code,name,...(saved&&typeof saved.participantId==='string'&&typeof saved.token==='string'?{participantId:saved.participantId,token:saved.token}:{})},controller.signal);
      if(current!==generation||stopped)return;identity={sessionId:value.sessionId,participantId:value.participantId,token:value.token,name:value.name};remember(value);session=null;questionKey='';errorKind='';joinPanel.hidden=true;sessionPanel.hidden=false;byId('leaveButton').textContent='Leave';update(value.session);poll();
    }catch(error){if(current!==generation||error.name==='AbortError')return;if(error.status===403)forget(code);byId('leaveButton').hidden=true;throw error;}
    finally{if(current===generation){joining=false;joinController=null;byId('joinForm').querySelector('button').disabled=false;}}
  }
  async function poll(){
    clearTimeout(pollTimer);pollTimer=null;if(stopped||!identity||pollController)return;
    const current=generation,owner={...identity},controller=new AbortController();pollController=controller;
    try{const value=await request('/api/audience/participant/'+encodeURIComponent(owner.sessionId)+'?token='+encodeURIComponent(owner.token),undefined,controller.signal);if(current===generation&&!stopped)update(value.session);}
    catch(error){if(current===generation&&!stopped&&error.name!=='AbortError'){if(error.status===403||error.status===404){forget(session?.code,owner.token);leave(error.message+' Join the presenter’s current session again.');say(status.textContent,true);}else{connected=false;errorKind='network';disableForm();renderResults();say(error.message,true);}}}
    finally{if(pollController===controller)pollController=null;if(current===generation&&!stopped&&identity)pollTimer=setTimeout(poll,1500);}
  }
  async function submitVote(event){event.preventDefault();if(busy||!session?.open||!connected||!answerReader)return;try{const answer=answerReader(),name=answerForm.querySelector('[data-quiz-name]')?.value;await sendAnswer(answer,name);}catch(error){errorKind='answer';say(error.message,true);}}
  async function sendAnswer(answer,displayName){
    if(busy||!session?.open||!connected)return;const current=generation,owner={...identity},context={sessionId:session.id,questionId:session.question.id,code:session.code,responseEpoch:session.responseEpoch},controller=new AbortController();writeController=controller;busy=true;disableForm();renderResults();
    try{if(displayName!==undefined&&displayName.trim()!==owner.name){const named=await request('/api/audience/join',{code:context.code,participantId:owner.participantId,token:owner.token,name:displayName},controller.signal);if(current!==generation)return;identity.name=named.name;remember(named);}
      if(current!==generation)return;
      const value=await request('/api/audience/vote',{sessionId:owner.sessionId,token:owner.token,questionId:context.questionId,expectedResponseEpoch:context.responseEpoch,answer},controller.signal);
      if(current!==generation)return;edited=false;errorKind='';update(value.session);say(value.updated?'Response updated.':'Response received.');
    }catch(error){if(current!==generation||error.name==='AbortError')return;errorKind=error.status?'answer':'network';if(!error.status)connected=false;say(error.message,true);}
    finally{if(writeController===controller)writeController=null;if(current===generation){busy=false;disableForm();renderResults();if(!stopped)poll();}}
  }
  byId('joinForm').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{await join(byId('sessionCode').value.replace(/[\s-]/g,''),byId('participantName').value);}catch(error){say(error.message,true);}finally{button.disabled=joining;}});
  byId('leaveButton').addEventListener('click',()=>leave());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&identity&&!busy)poll();});
  const code=new URL(location.href).searchParams.get('code');if(code){byId('sessionCode').value=code;policy.ready.then(()=>{const saved=remembered(code);if(saved&&!stopped&&!identity){byId('participantName').value=saved.name||'';join(code,saved.name||'').catch(error=>say(error.message,true));}});}
})();
