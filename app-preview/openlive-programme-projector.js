/* A Programme projector presents the Studio's finished canvas. It owns only
   its popup: no source capture, mixer, encoder or composition state lives here.
   Window/display placement stays with OpenLiveDisplays (output-setup.htm). */
(function(root){
  'use strict';
  if(root.OpenLiveProgrammeProjector)return;
  const scriptURL=root.document?.currentScript?.src||root.location?.href;
  let controller=null,sequence=0;
  const token=()=>root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+(++sequence)+'-'+Math.random().toString(36).slice(2);

  function create(options={}){
    controller?.dispose();
    const displays=options.displays||root.OpenLiveDisplays;
    const scope=token(),name='showave-programme-'+scope;
    let current=null,timer=null,disposed=false;
    const snapshot=()=>({open:!!current,session:current?.session||null,mode:current?.mode||null,displayId:current?.displayId||null});
    const notify=()=>{try{options.onChange?.(snapshot());}catch(_){}};
    const fail=message=>{const error=String(message||'The Programme projector could not be opened.');try{options.onError?.(error);}catch(_){}return {ok:false,error};};
    const closed=win=>{try{return !win||win.closed;}catch(_){return true;}};
    function stopPoll(){if(timer!==null){root.clearInterval(timer);timer=null;}}
    function forget(){if(!current)return;current=null;stopPoll();notify();}
    function isOpen(){if(current&&closed(current.win))forget();return !!current;}
    function canvas(){
      try{const value=options.getFrame?.();return value&&Number(value.width)>0&&Number(value.height)>0?value:null;}catch(_){return null;}
    }
    const bridge=Object.freeze({
      get session(){return !disposed&&current?.session||null;},
      frame(session){
        if(disposed||root.__openliveProgrammeOutput!==bridge||!current||session!==current.session||!isOpen())return null;
        return canvas();
      },
      frameInfo(session){
        if(disposed||root.__openliveProgrammeOutput!==bridge||!current||session!==current.session||!isOpen())return null;
        try{
          if(typeof options.getFrameInfo==='function'){
            const value=options.getFrameInfo(),cv=value?.canvas;
            return cv&&Number(cv.width)>0&&Number(cv.height)>0?value:null;
          }
          // Older producers expose mutable canvases without a revision. The
          // display must continue copying them rather than guess freshness.
          const cv=canvas();return cv?{canvas:cv}:null;
        }catch(_){return null;}
      },
      surfaceClosed(session,child){
        if(!disposed&&current&&session===current.session&&child===current.win)forget();
      }
    });
    root.__openliveProgrammeOutput=bridge;

    function open(mode,displayId){
      if(disposed)return fail('This Programme projector controller has closed.');
      const frame=canvas();if(!frame)return fail('Programme is unavailable. Open a Studio Programme before opening its projector.');
      if(!displays)return fail('Display controls are unavailable. Reload Broadcast before opening its projector.');
      let display=null,index=-1;
      if(mode==='display'){
        if(displays.permission?.()!=='granted'||displays.enumerated?.()!==true)return fail('Detect displays before choosing a projector screen, or open a windowed projector and move it manually.');
        let list;try{list=displays.list();}catch(error){return fail(error.message||error);}
        index=Array.isArray(list)?list.findIndex(item=>item.id===displayId):-1;
        if(index<0)return fail('That display is no longer available. Open the projector menu again.');
        display=list[index];
        if(display.blocked||!(Number(display.width)>0)||!(Number(display.height)>0)||!Number.isFinite(display.left)||!Number.isFinite(display.top))return fail(display.reason||'This display cannot be targeted. Open a windowed projector and move it to the display.');
        if(typeof displays.openOn!=='function')return fail('This browser cannot place the projector on a display.');
      }else if(typeof displays.openWindow!=='function')return fail('Windowed projector controls are unavailable.');
      if(isOpen()&&current.mode===mode&&current.displayId===(display?.id||null)){
        try{current.win.focus?.();}catch(_){}
        return {ok:true,...snapshot()};
      }
      const session=token();
      const url=new URL('openlive-programme-output.html',scriptURL||root.location.href);
      url.searchParams.set('session',session);url.searchParams.set('mode',mode);
      let win;
      try{
        if(display)win=displays.openOn(index,url.href,{name,display});
        else {
          const scale=Math.min(1,1280/frame.width,720/frame.height);
          win=displays.openWindow(url.href,{name,width:Math.max(1,Math.round(frame.width*scale)),height:Math.max(1,Math.round(frame.height*scale))});
        }
      }catch(error){return fail(error.message||error);}
      // A denied popup or stale display must not claim an active projector or
      // invalidate a previously open window that still has its current feed.
      if(closed(win))return fail(!displays.lastError||displays.lastError==='popup blocked'?'The browser blocked the projector window. Allow popups for this site and try again.':displays.lastError);
      const previous=current;
      current={win,session,mode,displayId:display?.id||null};
      if(previous&&previous.win!==win&&!closed(previous.win))try{previous.win.close();}catch(_){}
      if(timer===null)timer=root.setInterval(isOpen,500);
      notify();
      return {ok:true,...snapshot()};
    }
    function close(){
      if(!current)return false;
      const win=current.win;forget();
      try{if(!closed(win))win.close();}catch(error){fail(error.message||error);}
      return true;
    }
    function onPageHide(event){if(!event.persisted)dispose();}
    function dispose(){
      if(disposed)return;disposed=true;close();stopPoll();
      root.removeEventListener?.('pagehide',onPageHide);
      if(root.__openliveProgrammeOutput===bridge)delete root.__openliveProgrammeOutput;
      if(controller===api)controller=null;
    }
    const api=Object.freeze({openWindow:()=>open('windowed',null),openDisplay:id=>open('display',id),close,isOpen,dispose,
      get session(){return !disposed&&current?.session||null;}});
    controller=api;root.addEventListener?.('pagehide',onPageHide);return api;
  }
  root.OpenLiveProgrammeProjector=Object.freeze({create});
})(typeof window==='object'?window:globalThis);
