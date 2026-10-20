/* Shared control contract for original OpenLive content.
   Adapters keep their native renderer and the host keeps its engine clock.
   This facade never reads/copies a File, converts a document, creates a URL,
   exports frames, persists content, or advances a second playback clock.

   create({reference:{kind,title,original,identity,bus}, owner, isCurrent,
     adapter:{capabilities, getState, prepare, command|commands, drawable,
       subscribe, dispose}})

   Capabilities are explicit booleans and require a real command handler.
   getState returns actual readiness, transport and position. Connecting Office
   alone does not make a picture ready. Async adapters must test context.isCurrent
   before changing their host; context.publish does this for facade state.
   Resources acquired asynchronously can register context.onRelease(cleanup),
   which also releases a resource arriving after its session was retired.
   Each renderer resource must have an owner; the last release retires it.
   Preview and Programme can use distinct references/buses without being merged.
*/
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.OpenLiveContentPlayer=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  const KINDS=Object.freeze(['powerpoint','pdf','video','audio','image','live','generator','unknown']);
  const COMMANDS=Object.freeze(['play','pause','stop','end','first','previous','next','last','goto',
    'seek','cue','trim','loop','mode','transition','rate','speed','direction','volume','mute','take',
    'pointer','zoom','timing','notes','ink','inkUndo','inkClear','open','openDetached',
    'connect','reconnect','refresh']);
  const phases=new Set(['empty','loading','ready','error','released']);
  const transports=new Set(['playing','paused','stopped','ended','unknown']);
  let serial=0;
  const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const message=error=>String(error&&error.message||error||'').slice(0,2000);
  function fault(code,text){const error=new Error(text);error.code=code;return error;}

  function classify(input){
    if(!input)return 'unknown';
    const data=typeof input==='object'?input:{name:input},original=data.original||data;
    const supplied=String(data.kind||data.type||'').toLowerCase();
    if(KINDS.includes(supplied))return supplied;
    if(supplied==='presentation-native'||data.nativePresentation||data.live?.nativePresentation)return 'powerpoint';
    const format=String(data.documentFormat||data.presentation?.format||'').toLowerCase();
    if(format==='pdf')return 'pdf';
    if(format==='powerpoint')return 'powerpoint';
    const mime=String(data.mime||original.type||'').toLowerCase();
    if(mime==='application/pdf')return 'pdf';
    if(mime.includes('presentationml')||mime==='application/vnd.ms-powerpoint')return 'powerpoint';
    for(const kind of ['video','audio','image'])if(mime.startsWith(kind+'/'))return kind;
    const name=String(data.name||original.name||data.filename||data.title||data.path||'');
    const extension=name.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
    if(['ppt','pptx','pptm','pps','ppsx','ppsm'].includes(extension))return 'powerpoint';
    if(extension==='pdf')return 'pdf';
    if(['mp4','m4v','mov','webm','mkv','avi','mpg','mpeg','wmv','ogv','dxv'].includes(extension))return 'video';
    if(['mp3','wav','m4a','aac','flac','ogg','opus','aiff','aif','wma'].includes(extension))return 'audio';
    if(['png','jpg','jpeg','gif','webp','bmp','svg','avif','tif','tiff'].includes(extension))return 'image';
    if(data.live||data.stream||supplied==='source'||supplied==='capture')return 'live';
    return 'unknown';
  }

  function create(options={}){
    const adapter=options.adapter||{},input=options.reference||{},original=input.original||input;
    const reference=Object.freeze({kind:classify(input),title:String(input.title||input.name||original.name||'Content'),
      original,identity:input.identity??input.id??original,bus:input.bus??null});
    const id='content-player-'+(++serial),defaultOwner=options.owner??Symbol(id),owners=new Set([defaultOwner]);
    const listeners=new Set(),cleanups=new Set();
    let closed=false,revision=0,pendingPrepare=null,prepareController=null,commandController=null;
    let commandSerial=0,pendingCommand=false,unsubscribe=null;
    let state={phase:'empty',ready:false,transport:'unknown',position:null,duration:null,
      page:null,pageCount:null,progress:null,error:'',code:''};
    const owned=()=>{
      if(closed)return false;
      try{return (typeof options.isCurrent!=='function'||options.isCurrent(reference)===true)&&
        (typeof adapter.isCurrent!=='function'||adapter.isCurrent(reference)===true);}catch(_){return false;}
    };
    function assertOwned(){
      if(closed)throw fault('CONTENT_PLAYER_RELEASED','This content player has been released.');
      if(!owned())throw fault('CONTENT_PLAYER_STALE','The content binding changed. Use its current player.');
    }
    function handler(name){
      if(typeof adapter.commands?.[name]==='function')return adapter.commands[name];
      if(typeof adapter[name]==='function')return adapter[name];
      return typeof adapter.command==='function'?adapter.command:null;
    }
    function capabilityMap(){
      let raw={};
      try{raw=typeof adapter.capabilities==='function'?adapter.capabilities(reference):adapter.capabilities||{};}catch(_){}
      if(!raw||typeof raw!=='object')raw={};
      const result=Object.create(null);
      for(const name of new Set([...COMMANDS,...Object.keys(raw)])){
        if(name==='visual'||name==='audio')continue;
        result[name]=owned()&&Object.hasOwn(raw,name)&&raw[name]===true&&!!handler(name);
      }
      // Visual/audio capability facts describe the real adapter, not controls.
      result.visual=raw.visual===true;result.audio=raw.audio===true;
      return Object.freeze(result);
    }
    function readState(){
      let raw={...state};
      if(!closed&&typeof adapter.getState==='function'){
        try{raw={...raw,...adapter.getState(reference)};}catch(error){raw={...raw,phase:'error',ready:false,error:message(error),code:error.code||'CONTENT_STATE_FAILED'};}
      }
      // A quiet renderer status poll cannot hide a failed user action. A new
      // command/preparation (or an explicit guarded publish) clears that error.
      if(state.error&&!raw.error){raw.error=state.error;raw.code=state.code;}
      if(closed)raw={...raw,phase:'released',ready:false,error:'',code:''};
      else if(!owned())raw={...raw,phase:'error',ready:false,error:'The content binding changed.',code:'CONTENT_PLAYER_STALE'};
      const phase=closed?'released':raw.error?'error':phases.has(raw.phase)?raw.phase:raw.ready===true?'ready':'empty';
      // Explicit false frame/ready flags win over an optimistic phase label.
      const ready=!closed&&owned()&&!raw.error&&raw.frameReady!==false&&
        (raw.ready===true||(raw.ready===undefined&&phase==='ready'));
      const progress=typeof raw.progress==='number'?finite(raw.progress):finite(raw.progress?.percent);
      return Object.freeze({id,reference,kind:reference.kind,title:reference.title,
        phase:phase==='ready'&&!ready?(raw.error?'error':'loading'):phase,ready,
        transport:transports.has(raw.transport)?raw.transport:'unknown',
        position:finite(raw.position),duration:finite(raw.duration),page:finite(raw.page),pageCount:finite(raw.pageCount),
        progress:progress===null?null:Math.max(0,Math.min(100,progress)),
        error:message(raw.error),code:String(raw.code||''),frameRevision:raw.frameRevision??null,
        busy:!closed&&(!!pendingPrepare||pendingCommand||raw.busy===true),ownerCount:owners.size,
        clock:'host',sessionOnly:true,revision,capabilities:capabilityMap()});
    }
    function emit(){
      revision++;const value=readState();
      for(const listener of [...listeners])try{listener(value);}catch(_){}
      return value;
    }
    function context(controller,current){
      return Object.freeze({reference,signal:controller.signal,isCurrent:current,
        publish(patch){if(!current()||!patch||typeof patch!=='object')return false;state={...state,...patch};emit();return true;},
        onRelease(cleanup){
          if(typeof cleanup!=='function')throw TypeError('A player resource needs a cleanup function.');
          if(closed){try{cleanup();}catch(_){}return()=>{};}
          cleanups.add(cleanup);return()=>cleanups.delete(cleanup);
        }});
    }
    function controller(){return new root.AbortController();}
    function prepare(){
      assertOwned();
      if(pendingPrepare)return pendingPrepare;
      if(typeof adapter.prepare!=='function')return emit();
      prepareController=controller();const own=prepareController,ctx=context(own,()=>owned()&&prepareController===own);
      state={...state,phase:'loading',ready:false,error:'',code:''};
      let result;
      try{result=adapter.prepare(ctx);}catch(error){
        prepareController=null;state={...state,phase:'error',ready:false,error:message(error),code:error.code||'CONTENT_PREPARE_FAILED'};emit();throw error;
      }
      if(!result||typeof result.then!=='function'){
        if(ctx.isCurrent()&&result&&typeof result==='object')state={...state,...result};
        prepareController=null;return owned()?emit():null;
      }
      const work=Promise.resolve(result).then(value=>{
        if(!ctx.isCurrent())return null;
        if(value&&typeof value==='object')state={...state,...value};
        return value;
      },error=>{
        if(!ctx.isCurrent())return null;
        state={...state,phase:'error',ready:false,error:message(error),code:error.code||'CONTENT_PREPARE_FAILED'};throw error;
      }).finally(()=>{
        if(prepareController===own){prepareController=null;pendingPrepare=null;if(!closed)emit();}
      });
      pendingPrepare=work;emit();return work;
    }
    function command(name,value){
      assertOwned();
      if(typeof name!=='string'||name==='visual'||name==='audio'||!capabilityMap()[name])
        throw fault('UNSUPPORTED_CONTENT_CONTROL','This content does not support '+String(name)+'.');
      const call=++commandSerial;
      commandController?.abort();commandController=controller();const own=commandController;
      const ctx=context(own,()=>owned()&&commandSerial===call&&commandController===own);
      state={...state,error:'',code:''};
      let result;
      try{
        if(typeof adapter.commands?.[name]==='function')result=adapter.commands[name](value,ctx);
        else if(typeof adapter[name]==='function')result=adapter[name](value,ctx);
        else result=adapter.command(name,value,ctx);
      }catch(error){
        if(!ctx.isCurrent())return null;
        commandController=null;pendingCommand=false;
        state={...state,error:message(error),code:error.code||'CONTENT_CONTROL_FAILED'};emit();throw error;
      }
      if(!result||typeof result.then!=='function'){
        const current=ctx.isCurrent();if(current){commandController=null;pendingCommand=false;emit();}
        return current?result:null;
      }
      pendingCommand=true;emit();
      return Promise.resolve(result).then(answer=>ctx.isCurrent()?answer:null,error=>{
        if(!ctx.isCurrent())return null;
        state={...state,error:message(error),code:error.code||'CONTENT_CONTROL_FAILED'};throw error;
      }).finally(()=>{
        if(commandController===own){commandController=null;pendingCommand=false;if(!closed)emit();}
      });
    }
    function release(owner=defaultOwner){
      if(closed||!owners.delete(owner))return false;
      if(owners.size){emit();return true;}
      closed=true;commandSerial++;prepareController?.abort();commandController?.abort();
      pendingPrepare=null;prepareController=null;commandController=null;pendingCommand=false;
      if(unsubscribe)try{unsubscribe();}catch(_){}unsubscribe=null;
      for(const cleanup of cleanups)try{cleanup();}catch(_){}cleanups.clear();
      if(typeof adapter.dispose==='function')try{const answer=adapter.dispose({reference});if(answer?.catch)answer.catch(()=>{});}catch(_){}
      emit();listeners.clear();return true;
    }
    const player=Object.freeze({reference,snapshot:readState,prepare,command,
      supports:name=>typeof name==='string'&&name!=='visual'&&name!=='audio'&&capabilityMap()[name]===true,
      refresh:()=>closed?readState():emit(),
      drawable(){if(!owned()||typeof adapter.drawable!=='function')return null;return adapter.drawable(reference)||null;},
      retain(owner=defaultOwner){assertOwned();if(owners.has(owner))return false;owners.add(owner);emit();return true;},
      release,subscribe(listener){
        if(typeof listener!=='function')throw TypeError('A player subscriber must be a function.');
        listener(readState());if(closed)return()=>{};
        listeners.add(listener);return()=>listeners.delete(listener);
      }});
    if(typeof adapter.subscribe==='function'){
      const off=adapter.subscribe(()=>{if(!closed)emit();},reference);
      if(typeof off==='function')unsubscribe=off;
    }
    return player;
  }
  return Object.freeze({create,classify,KINDS,COMMANDS});
});
