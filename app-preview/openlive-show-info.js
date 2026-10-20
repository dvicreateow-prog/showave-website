/* Live Show metadata transport. Composition values and edits stay in ArenaEngine.
   Provider: configure({read,patch,subscribe}); read returns {owner,title,description}
   or null, patch(changes,expectedOwner) returns a synchronous boolean, subscribe
   connects the provider's change notifications and returns an unsubscribe function.
   Clients: read(), patch({title?,description?},expectedOwner), subscribe(fn).
   Detached patch=true means queued optimistically; the authoritative receipt can
   reject it. subscribe receives corrected snapshots/null. No document is stored.
   Only the original/default Studio should use this shared channel. */
(function(root){
  'use strict';
  const channelName='openlive-show-info-v1',listeners=new Set(),pending=new Map(),retired=new Set();
  const id=root.crypto?.randomUUID?.()||'show-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let provider=null,providerOff=null,direct=null,directOff=null,authority=null,revision=-1;
  let snapshot=null,visible=null,sequence=0,closed=false,channel=null,requestTimer=null,heartbeat=null;
  const copy=value=>value?{owner:value.owner,title:value.title,description:value.description}:null;
  const clean=value=>value&&typeof value.owner==='string'&&value.owner&&typeof value.title==='string'&&typeof value.description==='string'?copy(value):null;
  const same=(a,b)=>a===b||!!a&&!!b&&a.owner===b.owner&&a.title===b.title&&a.description===b.description;
  function notify(){
    let next=copy(snapshot);
    if(next)for(const item of pending.values())if(item.owner===next.owner)Object.assign(next,item.patch);
    if(same(next,visible))return;visible=next;
    for(const fn of listeners)try{fn(copy(visible));}catch(_){}
  }
  function forgetPending(){for(const item of pending.values())if(item.timer!=null)root.clearTimeout?.(item.timer);pending.clear();}
  function clearRequest(){if(requestTimer!=null)root.clearTimeout?.(requestTimer);requestTimer=null;}
  function accept(value){value=clean(value);if(value?.owner!==snapshot?.owner)forgetPending();snapshot=value;notify();}
  function post(message){try{channel?.postMessage({v:1,from:id,...message});}catch(_){return false;}return !!channel;}
  function local(){
    let next=null;try{next=clean(provider?.read());}catch(_){}
    if(!same(next,snapshot)){snapshot=next;revision++;notify();post({type:'state',authority:id,revision,value:copy(snapshot)});}
    return copy(snapshot);
  }
  function findDirect(){
    const queue=[],seen=new Set([root]);
    try{if(root.parent&&root.parent!==root)queue.push(root.parent);if(root.opener)queue.push(root.opener);}catch(_){}
    while(queue.length){const candidate=queue.shift();if(!candidate||seen.has(candidate))continue;seen.add(candidate);
      try{const existing=candidate.OpenLiveShowInfo;
        const api=(!existing||existing.legacy===true)&&root.OpenLiveShowInfoLegacy
          ? root.OpenLiveShowInfoLegacy.connect(candidate) : existing;
        if(api&&api!==root.OpenLiveShowInfo&&api.isProvider?.())return api;
        if(candidate.parent&&candidate.parent!==candidate)queue.push(candidate.parent);if(candidate.opener)queue.push(candidate.opener);
      }catch(_){}
    }return null;
  }
  function bindDirect(){
    const next=findDirect();if(next===direct)return direct;
    directOff?.();directOff=null;direct=next;forgetPending();clearRequest();authority=null;revision=-1;
    if(direct){accept(direct.read());directOff=direct.subscribe(value=>accept(value));}
    else accept(null);
    return direct;
  }
  function read(){
    if(closed)return null;if(provider)return local();
    if(bindDirect())accept(direct.read());
    return copy(visible);
  }
  function changes(value){
    if(!value||typeof value!=='object')return null;const next={};
    for(const key of ['title','description'])if(Object.prototype.hasOwnProperty.call(value,key)){
      if(typeof value[key]!=='string')return null;next[key]=value[key];
    }return next;
  }
  function apply(value,owner){
    const current=local();if(!current||current.owner!==owner)return false;
    try{const accepted=provider.patch(value,owner)===true;local();return accepted;}catch(_){local();return false;}
  }
  function patch(value,expectedOwner){
    const next=changes(value),current=read();
    if(!next||!current||current.owner!==expectedOwner)return false;
    if(!Object.keys(next).length)return true;
    if(provider)return apply(next,expectedOwner);
    if(direct){let accepted=false;try{accepted=direct.patch(next,expectedOwner)===true;}catch(_){}accept(direct.read());return accepted;}
    if(!authority||!channel)return false;
    const command=id+':'+(++sequence),item={patch:next,owner:expectedOwner,timer:null};pending.set(command,item);notify();
    if(!post({type:'patch',to:authority,command,owner:expectedOwner,patch:next})){pending.delete(command);notify();return false;}
    // An authority can close before acknowledging. Do not retain a speculative
    // edit forever or let it conceal later imported/undone metadata.
    if(root.setTimeout)item.timer=root.setTimeout(()=>{pending.delete(command);notify();refresh();},3000);
    return true;
  }
  function refresh(){
    if(closed)return null;if(provider)return local();
    if(bindDirect())return read();post({type:'request',to:authority||undefined});
    if(authority&&requestTimer==null&&root.setTimeout)requestTimer=root.setTimeout(()=>{
      requestTimer=null;authority=null;revision=-1;forgetPending();accept(null);post({type:'request'});
    },1500);
    return copy(visible);
  }
  function receive(event){
    const message=event?.data;if(closed||!message||message.v!==1||message.from===id||message.to&&message.to!==id)return;
    if(provider){
      if(message.type==='request'){local();post({type:'state',to:message.from,authority:id,revision,value:copy(snapshot)});}
      if(message.type==='patch'){
        const next=changes(message.patch),accepted=!!next&&apply(next,message.owner);
        post({type:'state',to:message.from,authority:id,revision,value:copy(snapshot),ack:message.command,accepted});
      }return;
    }
    if(message.type!=='state'||bindDirect()||typeof message.authority!=='string'||message.from!==message.authority||!Number.isInteger(message.revision))return;
    if(retired.has(message.authority)||authority&&authority!==message.authority)return;
    if(message.released){retired.add(message.authority);clearRequest();authority=null;revision=-1;forgetPending();accept(null);post({type:'request'});return;}
    authority=message.authority;
    clearRequest();
    if(message.ack&&pending.has(message.ack)){const item=pending.get(message.ack);if(item.timer!=null)root.clearTimeout?.(item.timer);pending.delete(message.ack);}
    if(message.revision>=revision){revision=message.revision;accept(message.value);}else notify();
  }
  function configure(next){
    if(!next||typeof next.read!=='function'||typeof next.patch!=='function')throw new TypeError('Show metadata provider requires read and patch functions.');
    providerOff?.();directOff?.();directOff=null;direct=null;forgetPending();clearRequest();provider=next;authority=id;revision=-1;snapshot=null;visible=null;
    providerOff=typeof next.subscribe==='function'?next.subscribe(()=>local()):null;local();
    // Even an unavailable provider must answer discovery rather than leave a
    // client displaying an unrelated composition from a previous main window.
    post({type:'state',authority:id,revision,value:copy(snapshot)});
    return ()=>{if(provider!==next)return;providerOff?.();providerOff=null;provider=null;snapshot=null;revision++;notify();post({type:'state',authority:id,revision,value:null,released:true});authority=null;};
  }
  function subscribe(fn){if(typeof fn!=='function')return ()=>{};const value=read();listeners.add(fn);fn(value);return ()=>listeners.delete(fn);}
  function close(){if(closed)return;closed=true;if(provider){snapshot=null;revision++;notify();post({type:'state',authority:id,revision,value:null,released:true});}providerOff?.();directOff?.();forgetPending();clearRequest();if(heartbeat!=null)root.clearInterval?.(heartbeat);channel?.close();listeners.clear();}
  const api=Object.freeze({read,patch,subscribe,configure,refresh,isProvider:()=>!!provider&&!closed});root.OpenLiveShowInfo=api;
  try{if(typeof root.BroadcastChannel==='function'){channel=new root.BroadcastChannel(channelName);channel.onmessage=receive;}}catch(_){}
  root.addEventListener?.('focus',refresh);root.addEventListener?.('pageshow',refresh);root.addEventListener?.('pagehide',event=>{if(!event.persisted)close();});
  if(root.setInterval)heartbeat=root.setInterval(()=>{if(!provider)refresh();},3000);
  refresh();
})(typeof window==='object'?window:globalThis);
