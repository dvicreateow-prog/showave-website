/* SHOWAVE Shortcut editor controller
   -------------------------------------------------------------------------
   The editor is a view onto the host Composition's Parameter registry. It
   never owns a second mapping database: ArenaEngine owns identity, Undo/Redo
   and save/reload, while this page only projects and edits those records. */
(function shortcutEditor(global){
  'use strict';

  const $=selector=>document.querySelector(selector);
  const $$=selector=>[...document.querySelectorAll(selector)];
  const host=global.parent!==global && global.parent.ArenaEngine ? global.parent :
    (global.opener && global.opener.ArenaEngine ? global.opener : null);
  const EN=host && host.ArenaEngine;
  const Hub=host && host.OpenLiveHub;
  const Brand=global.ShowaveBrand;
  const query=new URLSearchParams(global.location.search);
  const KIND_TO_TAB={keyboard:'key',key:'key',midi:'midi',osc:'osc',dmx:'dmx'};
  const TAB_TO_KIND={key:'keyboard',midi:'midi',osc:'osc',dmx:'dmx'};
  const MODE_LABEL={absolute:'Absolute',button:'Button',toggle:'Toggle',value:'Value',
    relative:'Relative',increment:'Select Next Item',decrement:'Select Previous Item',
    'select-next':'Select Next Item','select-previous':'Select Previous Item',random:'Random Item'};
  const LABEL_MODE=Object.fromEntries(Object.entries(MODE_LABEL).map(([key,value])=>[value,key]));
  const MAPS={
    key:{menu:'Edit Keyboard',key:'Shift+Ctrl+K',
      learn:'Press a key on your keyboard.',
      columns:[['name','Name'],['keyLabel','Key'],['modeLabel','Shortcut Mode'],['targetMode','Shortcut Target']],
      modes:['Toggle','Value','Button','Select Next Item','Select Previous Item','Random Item']},
    midi:{menu:'Edit MIDI',key:'Shift+Ctrl+M',
      learn:'Press a MIDI note or move a controller.',
      columns:[['name','Name'],['deviceLabel','Device'],['channel','Channel'],['messageLabel','MIDI Message'],
        ['modeLabel','Shortcut Mode'],['targetMode','Shortcut Target']],
      modes:['Absolute','Button','Relative','Toggle','Value','Select Next Item','Select Previous Item','Random Item']},
    osc:{menu:'Edit OSC',key:'Shift+Ctrl+O',
      learn:'OSC uses an exact Parameter address; select a target.',
      columns:[['name','Name'],['address','OSC Path'],['tag','OSC Type Tag'],['scope','Scope']],modes:[]},
    dmx:{menu:'Edit DMX',key:'Shift+Ctrl+X',
      learn:'Send a DMX value through the SHOWAVE bridge, or enter its Universe and Channel.',
      columns:[['name','Name'],['universeLabel','Universe'],['channel','Channel'],
        ['modeLabel','Shortcut Mode'],['targetMode','Shortcut Target']],
      modes:['Absolute','Select Next Item','Select Previous Item','Random Item']}
  };

  let current=KIND_TO_TAB[String(query.get('kind')||'keyboard').toLowerCase()]||'key';
  let selectedId='';
  let selectedTargetHome=String(query.get('target')||'');
  let editing=true;
  let learning=false;
  let learnRecordId='';
  let records=[];
  let targets=[];
  let sortField={key:'name',midi:'name',osc:'name',dmx:'name'};
  let mappingSignature='';
  let renderTimer=0;
  let painting=false;
  const dd=[];

  function text(value){ return String(value==null?'':value); }
  function uiText(value){ return Brand&&Brand.label ? Brand.label(value) : text(value); }
  function uiTerm(value){ return Brand&&Brand.term ? Brand.term(value) : text(value); }
  const SHOW_LABEL=uiText('Composition');
  const MAPPING_HINT=`Mappings use exact Parameter addresses and save with the ${SHOW_LABEL}.`;
  function clamp(value,min,max){ return Math.max(min,Math.min(max,Number(value)||0)); }
  function kind(){ return TAB_TO_KIND[current]; }
  function selected(){ return records.find(record=>record.id===selectedId)||null; }
  function target(home){ return targets.find(item=>item.home===home)||null; }
  function shortHome(home){
    return text(home).replace(/^\/composition\/?/,'').replace(/\/(video|audio)\/effects\//,'/$1 fx/');
  }
  function groupFor(home){
    const path=text(home);
    let match,base;
    if((match=/\/decks\/(\d+)\/layers\/(\d+)\/clips\/(\d+)/.exec(path)))
      base=`Clips: Layer ${match[2]} \u00b7 Deck ${match[1]}`;
    else if((match=/\/layers\/(\d+)/.exec(path))) base=`Layer ${match[1]}`;
    else if((match=/\/groups\/(\d+)/.exec(path))) base=`Group ${match[1]}`;
    else if(/\/columns\//.test(path)) base='Columns';
    else if(/\/decks\//.test(path)) base='Decks';
    else base='Composition';
    const section=/\/dashboard(?:\/|$)/.test(path) ? uiText('Dashboard') :
      /\/autopilot(?:\/|$)/.test(path) ? uiText('Autopilot') : '';
    return uiText(base)+(section?` \u00b7 ${section}`:'');
  }
  function targetName(home){
    const item=target(home);
    return item ? `${groupFor(home)} \u00b7 ${uiTerm(item.name)}` : shortHome(home)||'Missing Parameter';
  }
  function keyLabel(record){
    const parts=[];
    if(record.ctrl) parts.push('Ctrl');
    if(record.shift) parts.push('Shift');
    if(record.alt) parts.push('Alt');
    if(record.meta) parts.push('Cmd');
    let base=record.key||record.code||'Unassigned';
    if(/^Key[A-Z]$/.test(base)) base=base.slice(3);
    if(/^Digit\d$/.test(base)) base=base.slice(5);
    if(base===' ') base='Space';
    parts.push(base.length===1?base.toUpperCase():base);
    return parts.join(' + ');
  }
  function messageLabel(record){
    if(record.message==='pitchbend') return 'PitchBend';
    return `${record.message==='note'?'Note':'CC'} ${record.number}`;
  }
  function tagFor(home){
    const item=target(home);
    if(!item) return 'Float 0.0 \u2013 1.0';
    if(item.type==='bool'||item.type==='event') return 'Int 0 \u2013 1';
    if(item.type==='choice') return 'Int choice index';
    return 'Float 0.0 \u2013 1.0';
  }
  function view(record){
    return Object.assign({},record,{
      name:targetName(record.targetHome), keyLabel:keyLabel(record),
      modeLabel:MODE_LABEL[record.mode]||record.mode, targetMode:'By Position',
      deviceLabel:record.deviceName||record.deviceId||'Any Device',
      messageLabel:messageLabel(record), universeLabel:`Universe ${record.universe||1}`,
      tag:tagFor(record.targetHome), scope:'Exact Address'
    });
  }
  function exactInput(record){
    if(record.kind==='keyboard') return [record.code,record.key,record.ctrl,record.shift,record.alt,record.meta].join('|');
    if(record.kind==='midi') return [record.deviceId,record.channel,record.message,record.number].join('|');
    if(record.kind==='osc') return record.address;
    return [record.universe,record.channel,record.width16].join('|');
  }

  function closeDD(){ while(dd.length) dd.pop().remove(); $$('.menu-top.open').forEach(node=>node.classList.remove('open')); }
  function buildDD(items,x,y){
    closeDD();
    const menu=document.createElement('div'); menu.className='dropdown'; menu.setAttribute('role','menu');
    items.forEach(item=>{
      if(item.sep){ const sep=document.createElement('div'); sep.className='dd-sep'; menu.appendChild(sep); return; }
      const row=document.createElement('div'); row.className='dd-item'+(item.disabled?' disabled':'');
      row.tabIndex=item.disabled?-1:0; row.setAttribute('role','menuitem');
      row.innerHTML=`<span class="chk">${item.on?'\u2713':''}</span><span></span>${item.key?'<span class="kbd"></span>':''}`;
      row.children[1].textContent=item.label;
      if(item.key) row.querySelector('.kbd').textContent=item.key;
      const run=()=>{ if(item.disabled) return; closeDD(); if(item.run) item.run(); };
      row.addEventListener('click',run);
      row.addEventListener('keydown',event=>{ if(event.key==='Enter'||event.key===' '){ event.preventDefault(); run(); } });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    const rect=menu.getBoundingClientRect();
    menu.style.left=Math.max(2,Math.min(x,innerWidth-rect.width-4))+'px';
    menu.style.top=Math.max(2,Math.min(y,innerHeight-rect.height-4))+'px';
    dd.push(menu);
  }
  addEventListener('mousedown',event=>{ if(!event.target.closest('.dropdown,.menu-top,#presetBtn')) closeDD(); });

  function hostUnavailable(){
    $('#winStatus').innerHTML='<span class="v">No Show host.</span><span>Open Shortcuts from the main SHOWAVE Live window.</span>';
    $('#learnBtn').disabled=true; $('#clearOne').disabled=true; $('#clearAll').disabled=true; $('#dupBtn').disabled=true;
    $('#targets').innerHTML='<div class="hint">This detached page has no SHOWAVE Live host with an active Parameter registry.</div>';
    $('#rows').innerHTML=''; $('#countLabel').textContent='0 shortcuts';
  }
  function reload(force){
    if(!EN) return hostUnavailable();
    const all=EN.listControlMappings();
    const selectedClipHome=EN.selection && EN.selection.clip && EN.selection.clip.home || '';
    const signature=JSON.stringify(all)+'|'+selectedClipHome;
    if(!force && signature===mappingSignature) return;
    mappingSignature=signature;
    const pinned=new Set(all.map(record=>record.targetHome).filter(Boolean));
    if(selectedTargetHome) pinned.add(selectedTargetHome);
    /* A seeded 3 x 9 Composition registers more than nine thousand Clip
       Parameters across every Deck. Rendering all of them made the editor
       allocate thousands of DOM rows on every mapping edit. Resolume edits the
       selected Clip while keeping existing assignments addressable, so retain
       Composition/Layer/Group/Column targets plus the selected Clip and any
       mapped or explicitly requested target. */
    targets=EN.controlTargets().filter(item=>{
      const isClip=/\/clips\/\d+\//.test(item.home);
      return !isClip || pinned.has(item.home) ||
        (!!selectedClipHome && item.home.startsWith(selectedClipHome+'/'));
    });
    records=all.filter(record=>record.kind===kind()).map(view);
    if(selectedId&&!records.some(record=>record.id===selectedId)) selectedId='';
    if(selectedTargetHome&&!target(selectedTargetHome)) selectedTargetHome='';
    if(!selectedTargetHome&&targets.length) selectedTargetHome=targets[0].home;
    renderTargets(); renderList(); paintMode();
  }
  function scheduleReload(){
    clearTimeout(renderTimer); renderTimer=setTimeout(()=>reload(false),60);
  }
  function mutate(fn){
    if(!EN) return null;
    try { const result=fn(); reload(true); return result; }
    catch(error){ $('#listHint').textContent=error.message||String(error); return null; }
  }

  function paintMode(){
    const map=MAPS[current];
    $$('#mapTabs .win-tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.map===current));
    $('#modeChip').textContent=editing?`Shortcut Mode \u00b7 ${map.menu.replace('Edit ','')}`:'Shortcut Mode \u00b7 off';
    $('#modeChip').classList.toggle('on',editing);
    $('#learnBar').classList.toggle('on',editing);
    $('#learnTitle').textContent=map.menu;
    $('#learnMsg').textContent=learning?map.learn:'Select a registered Parameter to create or inspect its shortcut.';
    let note='';
    if(current==='midi'&&!Hub) note='Web MIDI runtime unavailable in the host; enter the assignment manually.';
    if(current==='osc'||current==='dmx') note='Raw UDP is unavailable to browser JavaScript; use the SHOWAVE desktop bridge or a same-origin bridge.';
    $('#learnNote').textContent=note;
    $('#learnBtn').classList.toggle('on',learning);
    $('#learnBtn').disabled=!EN||current==='osc';
  }
  function startMode(tab){
    current=tab; editing=true; learning=false; learnRecordId=''; selectedId='';
    reload(true);
  }
  function stopMode(){ editing=false; learning=false; learnRecordId=''; paintMode(); }

  function renderTargets(){
    const root=$('#targets'); root.innerHTML='';
    const q=$('#tSearch').value.trim().toLowerCase();
    const groups=new Map();
    targets.forEach(item=>{
      const label=targetName(item.home);
      if(q&&!`${label} ${item.home}`.toLowerCase().includes(q)) return;
      const group=groupFor(item.home);
      if(!groups.has(group)) groups.set(group,[]);
      groups.get(group).push(item);
    });
    groups.forEach((items,group)=>{
      const heading=document.createElement('div'); heading.className='tgroup'; heading.textContent=group; root.appendChild(heading);
      const children=[];
      items.forEach(item=>{
        const row=document.createElement('div'); row.className='titem'+(item.home===selectedTargetHome?' sel':'');
        row.textContent=uiTerm(item.name); row.title=item.home; row.tabIndex=0; row.dataset.home=item.home;
        const choose=()=>{ selectedTargetHome=item.home; $('#iTarget').textContent=targetName(item.home); renderTargets(); };
        row.addEventListener('click',choose);
        row.addEventListener('keydown',event=>{ if(event.key==='Enter'||event.key===' '){ event.preventDefault(); choose(); } });
        row.addEventListener('contextmenu',event=>{
          event.preventDefault(); choose();
          buildDD([{label:targetName(item.home),disabled:true},{sep:true},
            {label:current==='key'?'Learn Keyboard Shortcut':`Create ${MAPS[current].menu.replace('Edit ','')} Shortcut`,
              run:()=>createDefault(item.home)},
            {label:'Clear Shortcut for Parameter',run:()=>clearTarget(item.home)},
            {label:`Clear All ${MAPS[current].menu.replace('Edit ','')} Shortcuts`,run:clearAll}],event.clientX,event.clientY);
        });
        root.appendChild(row); children.push(row);
      });
      heading.addEventListener('click',()=>children.forEach(row=>row.hidden=!row.hidden));
    });
    if(!root.children.length) root.innerHTML='<div class="hint">No registered Parameters match this search.</div>';
  }

  function sortedRecords(){
    const field=sortField[current];
    return records.slice().sort((a,b)=>text(a[field]).localeCompare(text(b[field]),undefined,{numeric:true}));
  }
  function renderList(){
    const map=MAPS[current], header=$('#hdr'), body=$('#rows');
    header.innerHTML='';
    map.columns.forEach(([field,label])=>{ const th=document.createElement('th'); th.textContent=label; if(field==='channel') th.className='num'; header.appendChild(th); });
    header.appendChild(document.createElement('th'));
    const list=sortedRecords(), duplicates=new Map();
    list.forEach(record=>duplicates.set(exactInput(record),(duplicates.get(exactInput(record))||0)+1));
    body.innerHTML='';
    list.forEach(record=>{
      const tr=document.createElement('tr'); tr.dataset.mappingId=record.id;
      if(record.id===selectedId) tr.classList.add('sel');
      if(duplicates.get(exactInput(record))>1) tr.classList.add('missing');
      map.columns.forEach(([field])=>{
        const td=document.createElement('td'); td.textContent=record[field]==null?'N/A':record[field];
        if(field==='channel') td.className='num';
        if(field==='address'){ td.className='path'; td.title='Click to copy exact OSC address'; }
        tr.appendChild(td);
      });
      const action=document.createElement('td'), clear=document.createElement('button');
      clear.className='tb-btn small'; clear.type='button'; clear.textContent='\u00d7'; clear.title='Clear Shortcut';
      clear.addEventListener('click',event=>{ event.stopPropagation(); remove(record.id); });
      action.appendChild(clear); tr.appendChild(action);
      tr.addEventListener('click',event=>{
        selectRecord(record.id);
        if(event.target.classList.contains('path')) copyAddress(record.address);
      });
      tr.addEventListener('contextmenu',event=>{ event.preventDefault(); selectRecord(record.id); rowMenu(record,event); });
      body.appendChild(tr);
    });
    $('#countLabel').textContent=`${records.length} shortcuts`;
    $('#stPreset').textContent=SHOW_LABEL;
    paintOptions();
  }
  function copyAddress(address){
    if(navigator.clipboard) navigator.clipboard.writeText(address).catch(()=>{});
    $('#listHint').textContent=`Copied ${address}`;
    setTimeout(()=>$('#listHint').textContent=MAPPING_HINT,1800);
  }
  function selectRecord(id){
    selectedId=id;
    const record=selected();
    if(record){ selectedTargetHome=record.targetHome; $('#iTarget').textContent=record.name; }
    renderList(); renderTargets();
  }
  function rowMenu(record,event){
    buildDD([{label:record.name,disabled:true},{sep:true},
      {label:'Duplicate Shortcut',run:()=>duplicate(record.id)},
      {label:'Delete',key:'Backspace',run:()=>remove(record.id)},
      {sep:true},{label:`Clear All ${MAPS[current].menu.replace('Edit ','')} Shortcuts`,run:clearAll},
      {sep:true},{label:'Sorted by name',on:sortField[current]==='name',run:()=>{ sortField[current]='name'; renderList(); }},
      {label:current==='osc'?'Sorted by OSC path':'Sorted by control',on:sortField[current]!=='name',
        run:()=>{ sortField[current]=current==='osc'?'address':current==='key'?'keyLabel':current==='midi'?'messageLabel':'channel'; renderList(); }}],
      event.clientX,event.clientY);
  }

  function nextFree(field,max){
    const used=new Set(records.map(record=>+record[field]).filter(Number.isFinite));
    for(let value=1;value<=max;value++) if(!used.has(value)) return value;
    return max;
  }
  function createDefault(home,subtype){
    if(!EN||!target(home)) return;
    selectedTargetHome=home;
    if(current==='key'){ learning=true; learnRecordId=''; paintMode(); return; }
    let spec={kind:kind(),targetHome:home};
    if(current==='midi'){
      const message=subtype||'cc';
      spec=Object.assign(spec,{message,channel:+$('#chSel').value||1,
        number:message==='pitchbend'?0:nextFree('number',127),mode:message==='cc'?'absolute':'toggle'});
    } else if(current==='osc') spec=Object.assign(spec,{address:home,outputAddress:home,output:true});
    else spec=Object.assign(spec,{universe:+$('#uniSel').value||1,channel:nextFree('channel',512),mode:'absolute'});
    const created=mutate(()=>EN.addControlMapping(spec));
    if(created){ selectedId=created.id; reload(true); }
  }
  function remove(id){ mutate(()=>EN.removeControlMapping(id)); if(selectedId===id) selectedId=''; reload(true); }
  function duplicate(id){ const copy=mutate(()=>EN.duplicateControlMapping(id)); if(copy){ selectedId=copy.id; reload(true); } }
  function clearTarget(home){ mutate(()=>EN.clearControlMappings({kind:kind(),targetHome:home})); selectedId=''; }
  function clearAll(){
    if(!records.length) return;
    if(confirm(`Are you sure you want to remove all ${records.length} ${MAPS[current].menu.replace('Edit ','')} shortcuts?`)){
      mutate(()=>EN.clearControlMappings({kind:kind()})); selectedId='';
    }
  }
  function update(patch){
    const record=selected(); if(!record||painting) return;
    const result=mutate(()=>EN.updateControlMapping(record.id,patch));
    if(result) selectedId=result.id;
  }

  function show(selector,on){ const element=$(selector); if(element) element.style.display=on?'':'none'; }
  function setSelect(select,value){ if([...select.options].some(option=>String(option.value)===String(value))) select.value=value; }
  function paintOptions(){
    painting=true;
    const record=selected(), map=MAPS[current], mode=$('#modeSel');
    mode.innerHTML=''; map.modes.forEach(label=>mode.appendChild(new Option(label,LABEL_MODE[label]||'absolute')));
    show('#rowMode',!!map.modes.length); show('#rowTarget',current!=='osc');
    show('#rowPiano',false); show('#rowPianoInv',false); show('#rowMouseDir',false);
    show('#grpKey',current==='key'); show('#grpMidi',current==='midi');
    show('#grpOsc',current==='osc'); show('#grpDmx',current==='dmx');
    show('#rowRel',current==='midi'&&record&&record.mode==='relative');
    show('#rowRel2',current==='midi'&&record&&record.mode==='relative'); show('#rowLoop',false);
    $('#opts').classList.toggle('disabled',!record);
    if(!record){ $('#iTarget').textContent=selectedTargetHome?targetName(selectedTargetHome):'N/A'; painting=false; return; }
    $('#iTarget').textContent=record.name; setSelect(mode,record.mode); $('#targetSel').value='By Position'; $('#targetSel').disabled=true;
    const ranges=$$('#grpRange input[type=range][data-out]');
    if(ranges[0]) ranges[0].value=Math.round((record.min==null?0:record.min)*100);
    if(ranges[1]) ranges[1].value=Math.round((record.max==null?1:record.max)*100);
    ranges.forEach(input=>{ const unit=input.parentElement.querySelector('.unit'); if(unit) unit.textContent=(+input.value/100).toFixed(2); });
    $('#rangeInv').checked=!!record.invert;
    if(current==='key'){
      $('#keyCap').textContent=(record.key||record.code||'N/A').replace(/^Key/,'').replace(/^Digit/,'');
      const values={Ctrl:record.ctrl,Shift:record.shift,Alt:record.alt};
      $$('#grpKey input[data-mod]').forEach(box=>box.checked=!!values[box.dataset.mod]);
    }
    if(current==='midi'){
      ensureMidiDevices(); setSelect($('#midiIn'),record.deviceId||''); setSelect($('#chSel'),record.channel||1);
      setSelect($('#midiType'),record.message==='pitchbend'?'PitchBend':record.message==='note'?'Note':'CC');
      $('#midiNum').value=record.number||0; $('#midiStepSize').value=Math.max(1,Math.round((record.step||1/127)*127));
      setSelect($('#midiOut'),record.feedback===false?'disabled':(record.outputDeviceId||''));
      $('#velOff').value=record.velocityOff==null?0:record.velocityOff;
      $('#velOn').value=record.velocityOn==null?127:record.velocityOn;
    }
    if(current==='osc'){
      $('#oscIn').value=record.address||record.targetHome; $('#oscOut').value=record.outputAddress||record.address||record.targetHome;
      $('#oscTag').textContent=record.tag; $('#oscOutEnable').checked=!!record.output; $('#oscScope').value='Exact Address';
    }
    if(current==='dmx'){
      setSelect($('#uniSel'),record.universe||1); $('#dmxCh').value=record.channel||1; $('#dmxOff').value=0;
      $('#dmxUseOff').checked=false; $('#dmx16').checked=!!record.width16; $('#dmxInv').checked=!!record.invert; calcDmx();
    }
    painting=false;
  }

  function ensureMidiDevices(){
    const input=$('#midiIn'), output=$('#midiOut');
    const devices=Hub&&Hub.get ? (Hub.get('preferences.midi.devices',[])||[]) : [];
    const currentIn=input.value,currentOut=output.value;
    input.innerHTML=''; input.appendChild(new Option('Any Device',''));
    output.innerHTML=''; output.appendChild(new Option('Disabled','disabled'));
    output.appendChild(new Option('All enabled outputs',''));
    devices.forEach(device=>{
      if(device.hasInput!==false) input.appendChild(new Option(device.name||device.id,device.id));
      if(device.hasOutput!==false) output.appendChild(new Option(device.name||device.id,device.id));
    });
    setSelect(input,currentIn); setSelect(output,currentOut);
  }
  function midiPatch(){
    const input=$('#midiIn'), type=$('#midiType').value;
    const outputDeviceId=$('#midiOut').value;
    const message=type==='PitchBend'?'pitchbend':type==='Note'?'note':'cc';
    return {deviceId:input.value,deviceName:input.selectedOptions[0]&&input.selectedOptions[0].textContent||'',
      channel:+$('#chSel').value||1,message,number:clamp($('#midiNum').value,0,127),
      step:clamp($('#midiStepSize').value,1,127)/127,
      outputDeviceId:outputDeviceId==='disabled'?'':outputDeviceId,feedback:outputDeviceId!=='disabled',
      velocityOff:clamp($('#velOff').value,0,127),velocityOn:clamp($('#velOn').value,0,127)};
  }
  function calcDmx(){
    const base=clamp($('#dmxCh').value,1,512), offset=$('#dmxUseOff').checked?clamp($('#dmxOff').value,0,511):0;
    const channel=base+offset; $('#dmxCalc').textContent=channel;
    $('#dmxWarn').textContent=channel>512?'Channel plus offset exceeds 512.':
      'DMX input requires the SHOWAVE desktop/same-origin bridge; the mapping itself survives device disconnects.';
    return channel;
  }

  function learnKeyboard(event){
    if(!learning||current!=='key'||/^(Control|Shift|Alt|Meta)$/.test(event.key)) return false;
    event.preventDefault(); event.stopPropagation();
    const patch={code:event.code,key:event.key,ctrl:event.ctrlKey,shift:event.shiftKey,alt:event.altKey,meta:event.metaKey};
    let result;
    if(learnRecordId) result=mutate(()=>EN.updateControlMapping(learnRecordId,patch));
    else result=mutate(()=>EN.addControlMapping(Object.assign({kind:'keyboard',targetHome:selectedTargetHome,mode:'toggle'},patch)));
    learning=false; learnRecordId=''; if(result) selectedId=result.id; reload(true); return true;
  }
  function learnMidi(message){
    if(!learning||current!=='midi'||!message||message.direction==='out'||!['noteon','noteoff','cc','pitchbend'].includes(message.type)) return;
    const patch={deviceId:message.deviceId||'',deviceName:message.deviceName||'',channel:message.channel||1,
      message:message.type==='cc'?'cc':message.type==='pitchbend'?'pitchbend':'note',number:message.number||0};
    const result=learnRecordId?mutate(()=>EN.updateControlMapping(learnRecordId,patch)):
      mutate(()=>EN.addControlMapping(Object.assign({kind:'midi',targetHome:selectedTargetHome,
        mode:patch.message==='cc'?'absolute':'toggle'},patch)));
    learning=false; learnRecordId=''; if(result) selectedId=result.id; reload(true);
  }
  function learnDmx(detail){
    if(!learning||current!=='dmx'||!detail||detail.kind!=='dmx') return;
    const payload=detail.payload||detail;
    if(!payload.universe||!payload.channel) return;
    const patch={universe:payload.universe,channel:payload.channel,width16:+payload.value>255};
    const result=learnRecordId?mutate(()=>EN.updateControlMapping(learnRecordId,patch)):
      mutate(()=>EN.addControlMapping(Object.assign({kind:'dmx',targetHome:selectedTargetHome,mode:'absolute'},patch)));
    learning=false; learnRecordId=''; if(result) selectedId=result.id; reload(true);
  }

  $('#mShortcuts').addEventListener('mousedown',event=>{
    event.stopPropagation(); const rect=event.currentTarget.getBoundingClientRect();
    buildDD(Object.keys(MAPS).map(tab=>({label:MAPS[tab].menu,key:MAPS[tab].key,on:editing&&current===tab,run:()=>startMode(tab)}))
      .concat([{sep:true},{label:'Stop Shortcut Editing',key:'Esc',disabled:!editing,run:stopMode}]),rect.left,rect.bottom);
  });
  $('#mapTabs').addEventListener('click',event=>{ const tab=event.target.closest('.win-tab'); if(tab) startMode(tab.dataset.map); });
  $('#tSearch').addEventListener('input',renderTargets);
  $('#learnBtn').addEventListener('click',()=>{
    if(learning){ learning=false; learnRecordId=''; paintMode(); return; }
    if(!selectedTargetHome){ $('#learnMsg').textContent='Select a Parameter first.'; return; }
    learning=true; learnRecordId=selectedId; editing=true; paintMode();
  });
  $('#learnStop').addEventListener('click',stopMode);
  $('#reassignBtn').addEventListener('click',()=>{ if(selected()){ learning=true; learnRecordId=selectedId; editing=true; paintMode(); } });
  $('#clearOne').addEventListener('click',()=>{ if(selectedId) remove(selectedId); });
  $('#clearAll').addEventListener('click',clearAll);
  $('#dupBtn').addEventListener('click',()=>{ if(selectedId) duplicate(selectedId); });
  $('#presetBtn').textContent=SHOW_LABEL+' \u25be';
  $('#presetBtn').addEventListener('mousedown',event=>{
    event.stopPropagation(); const rect=event.currentTarget.getBoundingClientRect();
    buildDD([{label:SHOW_LABEL,on:true,disabled:true},{sep:true},
      {label:MAPPING_HINT,disabled:true},
      {label:'Resolume XML preset import needs the native codec',disabled:true}],rect.left,rect.bottom);
  });

  $('#modeSel').addEventListener('change',()=>update({mode:$('#modeSel').value}));
  $('#rangeInv').addEventListener('change',()=>update({invert:$('#rangeInv').checked}));
  $$('#grpRange input[type=range][data-out]').forEach(input=>{
    input.addEventListener('input',()=>{ const unit=input.parentElement.querySelector('.unit'); if(unit) unit.textContent=(+input.value/100).toFixed(2); });
    input.addEventListener('change',()=>{ const range=$$('#grpRange input[type=range][data-out]'); update({min:+range[0].value/100,max:+range[1].value/100}); });
  });
  $$('#grpKey input[data-mod]').forEach(box=>box.addEventListener('change',()=>update({
    ctrl:$('#grpKey input[data-mod="Ctrl"]').checked,shift:$('#grpKey input[data-mod="Shift"]').checked,
    alt:$('#grpKey input[data-mod="Alt"]').checked})));
  ['midiIn','chSel','midiType','midiNum','midiStepSize','midiOut','velOff','velOn']
    .forEach(id=>$('#'+id).addEventListener('change',()=>update(midiPatch())));
  ['oscIn','oscOut','oscOutEnable'].forEach(id=>$('#'+id).addEventListener('change',()=>update({
    address:$('#oscIn').value,outputAddress:$('#oscOut').value,output:$('#oscOutEnable').checked})));
  ['uniSel','dmxCh','dmxOff','dmxUseOff','dmx16','dmxInv'].forEach(id=>{
    const element=$('#'+id);
    element.addEventListener('input',()=>{ if(/^dmx(Ch|Off|UseOff)$/.test(id)) calcDmx(); });
    element.addEventListener('change',()=>update({universe:+$('#uniSel').value||1,channel:calcDmx(),
      width16:$('#dmx16').checked,invert:$('#dmxInv').checked}));
  });
  $$('#opts .formgroup > h3').forEach(heading=>heading.addEventListener('click',()=>{
    heading.parentElement.dataset.folded=heading.parentElement.dataset.folded==='1'?'0':'1';
  }));

  addEventListener('keydown',event=>{
    if(event.shiftKey&&event.ctrlKey){
      const tab={k:'key',m:'midi',o:'osc',x:'dmx'}[event.key.toLowerCase()];
      if(tab){ event.preventDefault(); startMode(tab); return; }
    }
    if(event.key==='Escape'){ closeDD(); stopMode(); return; }
    const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement&&document.activeElement.tagName||'');
    if(event.key==='Backspace'&&!typing&&selectedId){ event.preventDefault(); remove(selectedId); return; }
    if(!typing) learnKeyboard(event);
  });
  addEventListener('message',event=>{
    if(event.origin!==location.origin||!event.data) return;
    if(event.data.type==='openlive-stop-shortcut-editing') stopMode();
  });
  addEventListener('focus',()=>reload(true));
  if(Hub&&Hub.on) Hub.on('openlive:midi-message',learnMidi);
  if(host&&host.addEventListener) host.addEventListener('openlive:control-input',event=>learnDmx(event.detail));

  for(let channel=1;channel<=16;channel++) $('#chSel').appendChild(new Option(channel,channel));
  for(let universe=1;universe<=16;universe++) $('#uniSel').appendChild(new Option(`Universe ${universe}`,universe));
  $('#oscScope').appendChild(new Option('Exact Address','Exact Address'));
  $('#dropZone').remove();
  $('#listHint').textContent=MAPPING_HINT;
  ensureMidiDevices();

  if(EN){
    EN.subscribe(scheduleReload);
    reload(true);
    if(selectedTargetHome){ $('#iTarget').textContent=targetName(selectedTargetHome); renderTargets(); }
  } else hostUnavailable();
  paintMode();
})(window);
