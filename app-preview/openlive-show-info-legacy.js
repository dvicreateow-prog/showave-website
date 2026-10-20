/* Compatibility for an already-running main window whose application script
   predates OpenLiveShowInfo. This never reloads, initializes or restores its
   engine. The main's explicit local-mode gate must pass before installation
   and before every write. Modern providers are always reused unchanged. */
(function(root){
  'use strict';
  const same=(a,b)=>a===b||!!a&&!!b&&a.owner===b.owner&&a.title===b.title&&a.description===b.description;
  const copy=value=>value?{owner:value.owner,title:value.title,description:value.description}:null;
  const version=4,scriptURL=root.document?.currentScript?.src||null;
  function requestHostScript(host){
    const doc=host.document;if(!doc?.createElement||!scriptURL)return;
    let script=doc.getElementById?.('openlive-show-info-legacy-host');
    if(script&&script.__openliveShowInfoHostVersion!==version&&host.OpenLiveShowInfoLegacy?.ownsHost?.(host)&&host.OpenLiveShowInfoLegacy.version!==version){script.remove();script=null;}
    if(!script){
      const url=new URL(scriptURL);url.searchParams.set('hostRevision',String(version));
      script=doc.createElement('script');script.id='openlive-show-info-legacy-host';script.__openliveShowInfoHostVersion=version;script.src=url.href;
      // The script itself activates in the persistent main realm. This client
      // callback only helps an active client discover that asynchronous result.
      script.addEventListener('load',()=>root.OpenLiveShowInfo?.refresh?.(),{once:true});
      script.addEventListener('error',()=>script.remove(),{once:true});
      (doc.head||doc.body||doc.documentElement).appendChild(script);
    }
  }
  function maintainInitialAdapter(host,api){
    // The first hot-installed adapter had no teardown hook. Keep its handlers
    // and frozen API intact. Its existing overlay observer is the supported
    // way to refresh the private form owner after a reconnect-only transition.
    if(api?.legacy!==true||api.legacyVersion!=null)return;
    const marker='__openliveShowInfoLegacyReconnectRepair';
    try{
      if(host[marker]?.api===api&&host[marker].version===version&&host[marker].hostOwned)return;
      if(host[marker]?.api===api)host[marker].dispose?.();
      const engine=host.ArenaEngine,live=host.ArenaLive,doc=host.document,overlay=doc?.querySelector?.('#dlgSettings');
      if(!engine?.comp||!live?.on||!overlay||typeof host.MutationObserver!=='function')return;
      // The private v0 form owner is unknowable for a form already open when
      // this repair arrives. Establish its document only from a subsequent
      // observed close/open lifecycle, never from the currently displayed form.
      let formComp=null,disposed=false,formSession=0,repairOpenings=0,unsubscribe=null;
      const queued=new Map(),composing=new Map(),tails=new Map(),removers=[],fields={title:doc.querySelector('#setName'),description:doc.querySelector('#setDescription')};
      const open=()=>overlay.classList.contains('show');
      const observer=new host.MutationObserver(records=>{
        for(const record of records)if(record.attributeName==='class'&&!String(record.oldValue||'').split(/\s+/).includes('show')){
          if(repairOpenings){repairOpenings--;continue;}
          if(open()){formComp=engine.comp();formSession++;composing.clear();tails.clear();}
        }
        if(open())mirror(api.read());
      });
      const stop=()=>{if(disposed)return;disposed=true;observer.disconnect();unsubscribe?.();live.off?.('status',onStatus);host.removeEventListener?.('pagehide',onHide);for(const remove of removers)remove();queued.clear();composing.clear();if(host[marker]?.api===api)delete host[marker];};
      const onHide=event=>{if(!event.persisted)stop();};
      const canCapture=node=>!disposed&&host.OpenLiveShowInfo===api&&api.isProvider?.()&&host.ArenaEngine===engine&&engine.comp()===formComp&&open()&&!node.disabled;
      function setText(node,text){
        if(!node||node.value===text)return;
        const active=doc.activeElement===node,start=node.selectionStart,end=node.selectionEnd,direction=node.selectionDirection;
        node.value=text;if(active&&typeof start==='number')try{node.setSelectionRange(Math.min(start,text.length),Math.min(end,text.length),direction||'none');}catch(_){}
      }
      function mirror(current,force=false){
        if(!open())return;
        for(const [key,node] of Object.entries(fields)){
          const edit=composing.get(key),pending=queued.get(key);
          if(!force&&edit&&edit.comp===engine.comp()&&edit.session===formSession&&live.status!=='live')setText(node,edit.value);
          else if(!force&&pending&&pending.comp===engine.comp()&&live.status==='connecting')setText(node,pending.value);
          else if(current)setText(node,current[key]);
        }
        const note=doc.querySelector('.composition-settings-owner');if(note)note.textContent='Name and Description save as you type across linked views. Apply saves Size and FrameRate; closing keeps live metadata changes.';
      }
      function reject(){mirror(api.read(),true);const note=doc.querySelector('#compositionSettingsStatus');if(note)note.textContent='The active Show changed. Reopen Show Settings before editing.';}
      function commit(key,text){
        const node=fields[key];if(!canCapture(node)||!['offline','connecting'].includes(live.status)){reject();return false;}
        if(live.status==='connecting'){
          const old=queued.get(key),settings=engine.compositionSettings();
          queued.set(key,{comp:formComp,value:text,baseline:old?.comp===formComp?old.baseline:String(settings[key==='title'?'name':'description']??'')});return true;
        }
        queued.delete(key);
        // read() can run the old adapter's mirror. Retain the actual user text
        // and its selection before calling it, then restore after the write.
        const start=node.selectionStart,end=node.selectionEnd,direction=node.selectionDirection,current=api.read();
        const accepted=!!current&&api.patch({[key]:text},current.owner);
        if(accepted){setText(node,text);if(doc.activeElement===node&&typeof start==='number')try{node.setSelectionRange(start,end,direction||'none');}catch(_){}}
        else reject();return accepted;
      }
      for(const [key,selector] of [['title','#setName'],['description','#setDescription']]){
        const node=doc.querySelector(selector);if(!node?.addEventListener)continue;
        const onInput=event=>{
          if(!['offline','connecting'].includes(live.status))return;
          event.stopImmediatePropagation();
          const edit=composing.get(key);if(edit){edit.value=node.value;return;}
          if(event.isComposing)return;
          const tail=tails.get(key);tails.delete(key);
          if(tail&&(event.inputType==='insertCompositionText'||event.inputType==='insertFromComposition'||tail.data!=null&&event.data===tail.data)){reject();return;}
          commit(key,node.value);
        };
        const onStart=event=>{if(!['offline','connecting'].includes(live.status))return;event.stopImmediatePropagation();tails.delete(key);if(canCapture(node))composing.set(key,{comp:engine.comp(),session:formSession,value:node.value});};
        const onEnd=event=>{
          if(!['offline','connecting'].includes(live.status))return;
          event.stopImmediatePropagation();
          const edit=composing.get(key);composing.delete(key);
          if(edit&&canCapture(node)&&edit.comp===engine.comp()&&edit.session===formSession&&live.status!=='live')commit(key,node.value);
          else {tails.set(key,{data:event.data});reject();}
        };
        for(const [type,fn] of [['input',onInput],['compositionstart',onStart],['compositionend',onEnd]]){
          const target=doc.addEventListener?doc:node,listener=event=>{if(event.target===node)fn(event);};
          target.addEventListener(type,listener,true);removers.push(()=>target.removeEventListener?.(type,listener,true));
        }
      }
      const form=doc.querySelector('#compositionSettingsForm');
      const onSubmit=event=>{
        if(event.target!==form||!['offline','connecting'].includes(live.status))return;
        if(!canCapture(fields.title)||composing.size){event.preventDefault();event.stopImmediatePropagation();reject();return;}
        // The original native Apply handler keeps its raster/rate workflow.
        // Supply only current canonical metadata so an old baseline cannot
        // replay a stale title or description over a linked view's update.
        mirror(api.read(),true);
      };
      // An ancestor capture precedes the initial adapter's form capture.
      doc.addEventListener?.('submit',onSubmit,true);removers.push(()=>doc.removeEventListener?.('submit',onSubmit,true));
      const onStatus=status=>{
        if(disposed)return;
        if(host.OpenLiveShowInfo!==api||!api.isProvider?.()){stop();return;}
        api.refresh?.();
        if(status==='live'){queued.clear();for(const key of composing.keys())tails.set(key,{});composing.clear();return;}
        if(status!=='offline'||live.status!=='offline'||host.ArenaEngine!==engine)return;
        // V0 refused input while Arena was probing, although the main still
        // used its local Show. Capture user input before its old handler can
        // drop it, then replay only that same document's latest field values
        // through its existing API once the conservative v0 gate is open.
        const patch={},settings=engine.compositionSettings();for(const [key,item] of queued)if(item.comp===engine.comp()&&String(settings[key==='title'?'name':'description']??'')===item.baseline)patch[key]=item.value;queued.clear();
        if(Object.keys(patch).length){const current=api.read();if(current)api.patch(patch,current.owner);}
        mirror(api.read());
        if(engine.comp()!==formComp||!open())return;
        // No close/open application callback, hydration or event is invoked.
        // The class is restored before paint, retaining the exact nodes,
        // unsaved raster/rate values and the native Apply baseline. The old
        // observer runs in the next microtask and invalidates old IME sessions.
        repairOpenings++;overlay.classList.remove('show');overlay.classList.add('show');
      };
      observer.observe(overlay,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
      host[marker]={api,version,hostOwned:true,dispose:stop};unsubscribe=api.subscribe(mirror);live.on('status',onStatus);host.addEventListener?.('pagehide',onHide);
    }catch(_){}
  }
  function connect(host){
    try{
      if(!host||host.closed)return null;
      const existing=host.OpenLiveShowInfo;if(existing&&!existing.legacy)return existing;
      if(host!==root){
        const helper=host.OpenLiveShowInfoLegacy;
        if(helper?.ownsHost?.(host)&&helper.version===version)return helper.connect(host);
        requestHostScript(host);return existing||null;
      }
      if(existing){maintainInitialAdapter(host,existing);return existing;}
    }catch(_){return null;}
    let engine,doc,gate;
    try{
      engine=host.ArenaEngine;doc=host.document;
      if(!engine||!['comp','compositionSettings','setCompositionSettings','subscribe'].every(key=>typeof engine[key]==='function'))return null;
      if(typeof host.compositionSettingsSource==='function')gate=()=>{try{return host.compositionSettingsSource()?.live===false;}catch(_){return false;}};
      else {
        // Older main scripts keep their state inside an IIFE. ArenaLive.status
        // is the exported source of that script's S.live status callback.
        // Offline and connecting both use the local Show; live does not. The real
        // main settings DOM distinguishes this from an idle engine in a tool.
        if(!doc?.querySelector?.('#compositionSettingsForm')||!doc.querySelector('#dlgSettings')||!doc.querySelector('#setName')||!doc.querySelector('#setDescription'))return null;
        gate=()=>{try{return ['offline','connecting'].includes(host.ArenaLive?.status);}catch(_){return false;}};
      }
      if(!gate()||!engine.comp()||!engine.compositionSettings())return null;
    }catch(_){return null;}
    const listeners=new Set(),composing=new Map(),tails=new Map(),removers=[];
    const prefix='legacy-'+(host.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
    let currentComp=null,generation=0,snapshot=null,closed=false,observer=null,engineOff=null,liveListener=null;
    let form=null,overlay=null,fields=null,session=0,wasOpen=false,formOwner=null,formComp=null,initialDraft=null;
    const open=()=>!!overlay?.classList?.contains('show');
    function value(){
      const comp=!closed&&gate()?engine.comp():null;
      if(comp!==currentComp){currentComp=comp;generation++;}
      if(!comp)return null;
      const settings=engine.compositionSettings();
      return settings?{owner:prefix+':'+generation,title:String(settings.name??''),description:String(settings.description??'')}:null;
    }
    function formSession(){
      const visible=open();if(visible&&!wasOpen){session++;formOwner=value()?.owner||null;formComp=engine.comp();initialDraft=null;}
      wasOpen=visible;return visible;
    }
    function reconcileFormOwner(next){
      // Arena's reconnect probe can briefly make the conservative transport
      // gate unavailable without replacing the local Show. Give the still-open
      // form the new token only when its exact document object is unchanged.
      // IME sessions retain their separately captured owner and remain guarded.
      if(next&&formComp&&formComp===engine.comp())formOwner=next.owner;
    }
    function setText(node,text){
      if(!node||node.value===text)return;
      const focused=doc.activeElement===node,start=node.selectionStart,end=node.selectionEnd,direction=node.selectionDirection;
      node.value=text;
      if(focused&&typeof start==='number')try{node.setSelectionRange(Math.min(start,text.length),Math.min(end,text.length),direction||'none');}catch(_){}
    }
    function mirror(next,force=false){
      if(!fields||!formSession()||!next)return;
      reconcileFormOwner(next);
      for(const key of ['title','description']){
        if(composing.has(key)&&!force)continue;
        // Connecting must not erase a draft typed into the old, Apply-based
        // form before this adapter arrived. New remote edits retire that draft.
        if(initialDraft?.[key]&&next[key]===initialDraft[key].baseline&&!force)continue;
        if(initialDraft)delete initialDraft[key];setText(fields[key],next[key]);
      }
      const note=form.querySelector?.('.composition-settings-owner');
      if(note)note.textContent='Name and Description save as you type across linked views. Apply saves Size and FrameRate; closing keeps live metadata changes.';
    }
    function refresh(){
      if(closed)return null;const next=value(),changed=!same(next,snapshot);snapshot=next;if(changed)mirror(next);
      if(changed)for(const fn of listeners)try{fn(copy(next));}catch(_){}
      return copy(snapshot);
    }
    function read(){return refresh();}
    function patch(next,expectedOwner){
      const current=read();if(!current||current.owner!==expectedOwner||!next||typeof next!=='object')return false;
      const changes={};
      for(const [key,setting] of [['title','name'],['description','description']])if(Object.prototype.hasOwnProperty.call(next,key)){
        if(typeof next[key]!=='string')return false;changes[setting]=next[key];
      }
      if(!Object.keys(changes).length)return true;
      // Recheck immediately at the engine boundary; local mode may change
      // during a subscriber callback fired by read(). No REST route exists here.
      if(!gate()||engine.comp()!==currentComp||value()?.owner!==expectedOwner)return false;
      try{engine.setCompositionSettings(changes,{label:'Show information'});refresh();return true;}catch(_){refresh();return false;}
    }
    function subscribe(fn){if(typeof fn!=='function')return ()=>{};const current=read();listeners.add(fn);fn(current);return ()=>listeners.delete(fn);}
    function listen(node,type,fn,capture=false){if(!node?.addEventListener)return;node.addEventListener(type,fn,capture);removers.push(()=>node.removeEventListener?.(type,fn,capture));}
    function feedback(message){const node=doc.querySelector?.('#compositionSettingsStatus');if(node)node.textContent=message;}
    function commit(key,owner){
      if(closed||!formSession()||!gate()||fields[key].disabled)return false;
      const current=value();reconcileFormOwner(current);if(owner===undefined)owner=formOwner;
      if(!current||current.owner!==owner||formOwner!==owner){mirror(current,true);feedback('The active Show changed. Reopen Show Settings before editing.');return false;}
      if(initialDraft)delete initialDraft[key];
      const accepted=patch({[key]:fields[key].value},owner);
      if(!accepted){mirror(value(),true);feedback('Show information could not be saved. Reopen Show Settings to review the current Show.');}
      return accepted;
    }
    function bindForm(){
      form=doc?.querySelector?.('#compositionSettingsForm');overlay=doc?.querySelector?.('#dlgSettings');
      const title=doc?.querySelector?.('#setName'),description=doc?.querySelector?.('#setDescription');
      if(!form||!overlay||!title||!description)return;
      fields={title,description};wasOpen=open();if(wasOpen){session++;formOwner=value()?.owner||null;formComp=engine.comp();initialDraft={};
        const current=value();if(current)for(const key of ['title','description'])if(fields[key].value!==current[key])initialDraft[key]={baseline:current[key],draft:fields[key].value};
      }
      for(const key of ['title','description']){
        const node=fields[key];
        listen(node,'compositionstart',event=>{if(!gate())return;event.stopImmediatePropagation();formSession();tails.delete(key);composing.set(key,{owner:value()?.owner,session});},true);
        listen(node,'input',event=>{
          if(!gate())return;
          event.stopImmediatePropagation();
          if(event.isComposing||composing.has(key))return;
          const tail=tails.get(key);tails.delete(key);
          if(tail&&(event.inputType==='insertCompositionText'||event.inputType==='insertFromComposition'||tail.data!=null&&event.data===tail.data)){mirror(value(),true);return;}
          commit(key);
        },true);
        listen(node,'compositionend',event=>{
          if(!gate())return;
          event.stopImmediatePropagation();
          const edit=composing.get(key);composing.delete(key);formSession();if(!edit)return;
          const current=value();if(!current||edit.owner!==current.owner||edit.session!==session||!open()){
            tails.set(key,{data:event.data});mirror(current,true);return;
          }commit(key,edit.owner);
        },true);
      }
      listen(form,'submit',event=>{
        if(!gate()||closed)return;
        formSession();const current=value();reconcileFormOwner(current);
        if(!current||current.owner!==formOwner){event.preventDefault();event.stopImmediatePropagation();mirror(current,true);feedback('The active Show changed. Reopen Show Settings before applying.');return;}
        if(composing.size){event.preventDefault();event.stopImmediatePropagation();feedback('Finish entering Name or Description before applying output settings.');return;}
        // Preserve drafts that predated activation, only while their original
        // canonical field is unchanged. No Size/FrameRate draft is inspected.
        const adopt={};for(const key of ['title','description'])if(initialDraft?.[key]&&current[key]===initialDraft[key].baseline)adopt[key]=fields[key].value;
        initialDraft=null;if(Object.keys(adopt).length&&!patch(adopt,current.owner)){event.preventDefault();event.stopImmediatePropagation();return;}
        // The old handler now reads draft===current for metadata. Its own
        // conflict/Apply logic skips those fields without a private-baseline
        // write, while keeping the complete existing output-settings workflow.
        mirror(value(),true);
      },true);
      listen(form,'focusin',()=>{formSession();mirror(refresh());});
      if(typeof host.MutationObserver==='function'){
        observer=new host.MutationObserver(records=>{
          if(open()&&records.some(record=>record.attributeName==='class'&&!String(record.oldValue||'').split(/\s+/).includes('show'))){session++;formOwner=value()?.owner||null;formComp=engine.comp();initialDraft=null;wasOpen=true;}
          else formSession();mirror(refresh());
        });observer.observe(overlay,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
      }
    }
    function close(event){if(event?.persisted||closed)return;closed=true;observer?.disconnect();engineOff?.();
      if(liveListener)host.ArenaLive?.off?.('status',liveListener);for(const remove of removers)remove();snapshot=null;
      for(const fn of listeners)try{fn(null);}catch(_){}listeners.clear();
    }
    const api=Object.freeze({read,patch,subscribe,refresh,isProvider:()=>!closed,legacy:true,legacyVersion:3,dispose:()=>close()});
    try{if(host.OpenLiveShowInfo)return host.OpenLiveShowInfo;host.OpenLiveShowInfo=api;}catch(_){return null;}
    bindForm();engineOff=engine.subscribe(refresh);
    if(typeof host.ArenaLive?.on==='function'){liveListener=()=>refresh();host.ArenaLive.on('status',liveListener);}
    listen(host,'pagehide',close);listen(host,'focus',refresh);refresh();return api;
  }
  root.OpenLiveShowInfoLegacy=Object.freeze({connect,version,ownsHost:host=>host===root});
  // Runs in the main document even when requested by a short-lived child.
  if(root.ArenaEngine&&root.document?.querySelector?.('#compositionSettingsForm'))connect(root);
})(typeof window==='object'?window:globalThis);
