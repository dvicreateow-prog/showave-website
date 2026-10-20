/* Compatibility facade for web launchers. The pinned controller owns the one
   floating iframe workspace, keyboard lease and original slide/media runtime. */
(function(root){
  'use strict';
  function attach(options={}){
    const controller=options.controller;
    if(!controller||typeof controller.openView!=='function')throw Error('The browser player needs a pinned presentation.');
    let view=null,pending=null,unsubscribe=null,generation=0,listening=false;
    let state={open:false,backend:'web',alwaysOnTop:false,clicker:{status:'automatic',keys:[]}};
    const snapshot=()=>({...state,clicker:{...state.clicker,keys:[...state.clicker.keys]}});
    const publish=()=>options.onState?.(snapshot());
    const current=()=>controller.snapshot().phase==='ready'&&(!options.isCurrent||options.isCurrent());
    function close(){
      generation++;pending=null;const own=view;view=null;unsubscribe?.();unsubscribe=null;
      if(listening){root.removeEventListener('pagehide',close);listening=false;}
      own?.close();state={...state,open:false};publish();
    }
    async function open(){
      if(!current())throw Error('Pin a ready presentation before opening its browser player.');
      if(view&&!view.closed){view.window?.focus?.();return snapshot();}
      if(pending)return pending;
      const epoch=generation,session=controller.snapshot().sessionId;
      const valid=()=>generation===epoch&&current()&&controller.snapshot().sessionId===session;
      if(!listening){root.addEventListener('pagehide',close,{once:true});listening=true;}
      const job=(async()=>{
        let opened;
        try{
          opened=await controller.openView({pictureInPicture:false,overlay:true,clicker:options.clicker,
            onState(next){
              if(generation!==epoch||next.open&&!valid())return;
              if(next.open===false&&view){close();return;}
              state={...state,...next,backend:'web',alwaysOnTop:false};publish();
            }});
          if(!valid()){opened.close();throw Error('The pinned presentation changed. Open its browser player again.');}
          view=opened;state={...state,open:!opened.closed,mode:opened.mode};publish();
          const stop=controller.subscribe(()=>{if(view===opened&&!valid())close();});
          if(view===opened)unsubscribe=stop;else stop();
          if(!valid())throw Error('The pinned presentation changed. Open its browser player again.');
          return snapshot();
        }catch(error){if(generation===epoch)close();throw error;}
      })();
      pending=job;
      try{return await job;}finally{if(pending===job)pending=null;}
    }
    return Object.freeze({open,close,snapshot,ownsKey:event=>state.open&&(options.clicker?.ownsKey?.(event)||false)});
  }
  root.OpenLivePresenterWeb=Object.freeze({attach});
})(window);
