/* SHOWAVE Presenter: pinned, session-only presentation control.
   Browsing prepares a draft. Player navigation and Take commit the pinned Clip.
   File/Clip lifetimes and actual feed drawing remain with the host application. */
(function(root){
  'use strict';
  const PROTOCOL='showave.presenter/1',MAX_SLIDES=200,MAX_NOTES=8000;
  const MAX_INK_STROKES=64,MAX_INK_POINTS=512,MAX_SESSION_INK_POINTS=16384;
  const ACTIONS=new Set(['browse','first','previous','next','last','take','play','pause','stop','media','pointer','zoom','notes','timing','ink','inkUndo','inkClear']);
  const confidenceReaders=new Map();
  const decodedSlides=new Map();
  // A review page may live below /tools; player assets live beside this script.
  // Use only a same-origin script base because the view carries a session lease.
  const scriptURL=root.document?.currentScript?.src;
  function assetURL(name,hostWindow){
    const page=new URL(hostWindow.location.href),script=scriptURL?new URL(scriptURL,page):null;
    return new URL(name,script?.origin===page.origin?script:page);
  }
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
  const token=()=>root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():
    Math.random().toString(36).slice(2)+Date.now().toString(36)+Math.random().toString(36).slice(2);
  function text(value,max=256){return String(value==null?'':value).slice(0,max);}
  function index(value,length){
    if(!Number.isInteger(value)||value<0||value>=length) throw Error('Choose a slide in this presentation.');
    return value;
  }
  function slideURL(value){
    if(!value) return '';
    const raw=String(value);if(raw.length>4096) throw Error('The slide image address is too long.');
    const url=new URL(raw,root.location&&root.location.href||'http://localhost/');
    const origin=root.location&&root.location.origin;
    if(url.protocol==='blob:'&&(!origin||url.origin===origin)) return raw;
    if(['http:','https:'].includes(url.protocol)&&(!origin||url.origin===origin)) return url.href;
    throw Error('Presenter slides must use images from this SHOWAVE session.');
  }
  function slide(raw,n){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw Error('Invalid presentation slide.');
    return {id:text(raw.id||'slide-'+n),title:text(raw.title||raw.name||'Slide '+(n+1)),
      url:slideURL(raw.url),notes:text(raw.notes,MAX_NOTES),
      media:(Array.isArray(raw.media)?raw.media:[]).filter(item=>item&&['video','audio'].includes(item.type)).slice(0,32)
        .map(item=>({type:item.type,embedded:item.embedded===true}))};
  }
  function pointer(raw){
    if(!raw||typeof raw!=='object'||typeof raw.enabled!=='boolean'||!Number.isFinite(raw.x)||!Number.isFinite(raw.y))
      throw Error('Invalid presenter pointer.');
    return {enabled:raw.enabled,x:bounded(raw.x,0,1),y:bounded(raw.y,0,1)};
  }
  function zoom(raw){
    if(typeof raw==='number') raw={mode:raw>1?'area':'off',scale:raw,x:.5,y:.5};
    if(!raw||!Number.isFinite(raw.scale)||!Number.isFinite(raw.x)||!Number.isFinite(raw.y)) throw Error('Invalid presenter zoom.');
    const mode=raw.mode|| (raw.scale>1?'area':'off');if(!['off','lens','area'].includes(mode))throw Error('Choose Off, Lens or Area zoom.');
    return {mode,scale:bounded(raw.scale,1,4),x:bounded(raw.x,0,1),y:bounded(raw.y,0,1),radius:bounded(Number(raw.radius)||.18,.05,.4)};
  }
  function inkStroke(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.points)||!raw.points.length||raw.points.length>MAX_INK_POINTS)
      throw Error('A drawing stroke must contain 1 to 512 points.');
    if(typeof raw.color!=='string'||!/^#[0-9a-f]{6}$/i.test(raw.color)||!Number.isFinite(raw.width)||raw.width<.001||raw.width>.025)
      throw Error('Choose a drawing color and a width between 0.1% and 2.5% of the slide.');
    const points=raw.points.map(point=>{
      if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)
        throw Error('Drawing points must remain inside the slide.');
      return {x:point.x,y:point.y};
    });
    return {points,color:raw.color.toLowerCase(),width:raw.width};
  }
  /* Normalized source coordinates keep strokes attached to the slide when a
     presenter magnifies an area or moves a lens. No pixels are read back. */
  function mapFramePoint(x,y,width,height,state={}){
    if(!Number.isFinite(x)||!Number.isFinite(y)||!(width>0&&height>0))throw Error('Invalid drawing position.');
    x=bounded(x,0,1);y=bounded(y,0,1);const z=zoom(state.zoom||1);
    if(z.mode==='area'){
      const size=1/z.scale;return {x:bounded(z.x-size/2,0,1-size)+x*size,y:bounded(z.y-size/2,0,1-size)+y*size};
    }
    if(z.mode==='lens'){
      const radius=Math.min(width,height)*z.radius,dx=(x-z.x)*width,dy=(y-z.y)*height;
      if(dx*dx+dy*dy<=radius*radius){
        const rw=radius*2/width/z.scale,rh=radius*2/height/z.scale;
        return {x:bounded(z.x-rw/2,0,1-rw)+(dx+radius)/(radius*2)*rw,
          y:bounded(z.y-rh/2,0,1-rh)+(dy+radius)/(radius*2)*rh};
      }
    }
    return {x,y};
  }
  function hasFrameTools(state){return !!(state&&((state.pointer&&state.pointer.enabled)||(state.zoom&&state.zoom.mode&&state.zoom.mode!=='off')||(Array.isArray(state.ink)&&state.ink.length)));}
  function paintInk(ctx,strokes,sw,sh,crop,left,top,width,height){
    if(!Array.isArray(strokes)||!strokes.length)return;
    ctx.save();
    try{
      ctx.lineCap='round';ctx.lineJoin='round';
      const xScale=sw/crop.w*width,yScale=sh/crop.h*height,xOffset=left-crop.x/crop.w*width,yOffset=top-crop.y/crop.h*height;
      for(let s=0;s<Math.min(strokes.length,MAX_INK_STROKES);s++){
        const stroke=strokes[s];
        if(!stroke||!Array.isArray(stroke.points)||!stroke.points.length)continue;
        const points=stroke.points,count=Math.min(points.length,MAX_INK_POINTS),size=stroke.width*Math.min(sw,sh)*Math.min(width/crop.w,height/crop.h);
        ctx.strokeStyle=ctx.fillStyle=stroke.color;ctx.lineWidth=size;
        const first=points[0];ctx.beginPath();
        if(count===1){ctx.arc(xOffset+first.x*xScale,yOffset+first.y*yScale,size/2,0,Math.PI*2);ctx.fill();}
        else {ctx.moveTo(xOffset+first.x*xScale,yOffset+first.y*yScale);for(let n=1;n<count;n++){const point=points[n];ctx.lineTo(xOffset+point.x*xScale,yOffset+point.y*yScale);}ctx.stroke();}
      }
    }finally{ctx.restore();}
  }
  function paintFrame(ctx,source,width,height,state={}){
    const sw=Number(source&&(source.videoWidth||source.naturalWidth||source.width)),sh=Number(source&&(source.videoHeight||source.naturalHeight||source.height));
    if(!ctx||!source||!(sw>0&&sh>0&&width>0&&height>0))return false;
    const z=zoom(state.zoom||1),p=state.pointer?pointer(state.pointer):{enabled:false,x:.5,y:.5};
    let crop={x:0,y:0,w:sw,h:sh};
    ctx.save();
    try{
      ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      if(z.mode==='area'){
        crop.w=sw/z.scale;crop.h=sh/z.scale;crop.x=bounded(z.x*sw-crop.w/2,0,sw-crop.w);crop.y=bounded(z.y*sh-crop.h/2,0,sh-crop.h);
        ctx.drawImage(source,crop.x,crop.y,crop.w,crop.h,0,0,width,height);
      }else ctx.drawImage(source,0,0,width,height);
      paintInk(ctx,state.ink,sw,sh,crop,0,0,width,height);
      if(z.mode==='lens'){
        const radius=Math.min(width,height)*z.radius,cx=z.x*width,cy=z.y*height,
          rw=(radius*2/width)*sw/z.scale,rh=(radius*2/height)*sh/z.scale,
          left=bounded(z.x*sw-rw/2,0,sw-rw),top=bounded(z.y*sh-rh/2,0,sh-rh);
        ctx.save();ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.clip();
        ctx.drawImage(source,left,top,rw,rh,cx-radius,cy-radius,radius*2,radius*2);
        paintInk(ctx,state.ink,sw,sh,{x:left,y:top,w:rw,h:rh},cx-radius,cy-radius,radius*2,radius*2);ctx.restore();
        ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,Math.min(width,height)/540);ctx.stroke();
      }
      if(p.enabled){
        const px=(p.x*sw-crop.x)/crop.w*width,py=(p.y*sh-crop.y)/crop.h*height;
        if(px>=0&&px<=width&&py>=0&&py<=height){
          ctx.beginPath();ctx.arc(px,py,Math.max(3,Math.min(width,height)/90),0,Math.PI*2);ctx.fillStyle='#d04a3f';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,Math.min(width,height)/540);ctx.stroke();
        }
      }
      return true;
    }finally{ctx.restore();}
  }
  function editable(event){
    const target=event&&event.target;
    return !!(target&&(target.isContentEditable||target.closest&&target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')));
  }
  function keyboard(controller,event){
    if(!event||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||editable(event)) return false;
    const target=event.target;
    if(['Enter',' ','Spacebar'].includes(event.key)&&target?.closest&&target.closest('button,a[href],[role="button"]')){
      /* Keep the browser's button/link activation, but never dispatch it to the
         application's unrelated Show shortcuts through event bubbling. */
      event.stopPropagation();return true;
    }
    const action=({ArrowLeft:'previous',PageUp:'previous',ArrowRight:'next',PageDown:'next',Home:'first',End:'last',Enter:'take'})[event.key];
    if(!action) return false;
    event.preventDefault();event.stopPropagation();
    const state=controller.snapshot();if(!state||state.phase!=='ready'||state.busy)return true;
    Promise.resolve(controller[action]()).catch(()=>{});return true;
  }
  function copyTheme(sourceWindow,targetDocument,typographyController=null){
    try{
      if(!sourceWindow||!targetDocument||!sourceWindow.getComputedStyle)return false;
      const source=sourceWindow.document.body,style=sourceWindow.getComputedStyle(source),target=targetDocument.body;
      const targetWindow=targetDocument.defaultView,typography=typographyController||targetWindow?.OpenLiveInterfaceTypography;
      const managed=!!targetWindow?.OpenLiveAppearance||!!typography;
      for(const key of ['--bg','--panel','--panel2','--head','--inset','--line','--line2','--btn','--btn-hi','--txt','--txt-dim','--txt-hi','--mint','--red','--appearance-on-accent','--mint-t','--theme-focus','--font']){
        if(managed&&key==='--font')continue;
        const value=style.getPropertyValue(key).trim();if(value)target.style.setProperty(key,value);
      }
      if(!managed)for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight'])if(style[key])target.style[key]=style[key];
      const preferred=sourceWindow.OpenLiveAppearance?.getState?.().typography;
      if(typography&&preferred)typography.apply(preferred);
      return true;
    }catch(error){return false;}
  }
  /* Same-origin detached views draw the host's existing Show canvas directly.
     No pixels, URLs or files travel through BroadcastChannel or storage. */
  function readConfidence(sessionId,capability,hostId){
    if(typeof sessionId!=='string'||typeof capability!=='string'||typeof hostId!=='string')return null;
    const entry=confidenceReaders.get(sessionId);
    if(!entry||entry.capability!==capability||entry.hostId!==hostId)return null;
    return entry.read();
  }
  function readSlideFrame(sessionId,capability,hostId,n){
    const entry=confidenceReaders.get(sessionId);
    if(!entry||entry.capability!==capability||entry.hostId!==hostId||!Number.isInteger(n))return null;
    return entry.frame?.(n)||null;
  }
  function readSlideThumbnail(sessionId,capability,hostId,n){
    const entry=confidenceReaders.get(sessionId);
    if(!entry||entry.capability!==capability||entry.hostId!==hostId||!Number.isInteger(n))return null;
    return entry.thumbnail?.(n)||null;
  }

  function create(options={}){
    const adapter=options.adapter||{},listeners=new Set(),views=new Set(),clients=new Set(),requests=new Map(),activeCalls=new Map();
    const now=options.now||(()=>Date.now()),schedule=options.setTimeout||root.setTimeout.bind(root),
      unschedule=options.clearTimeout||root.clearTimeout.bind(root);
    const makeChannel=options.channelFactory||(name=>new root.BroadcastChannel(name));
    let state={phase:'empty',binding:null,title:'No presentation pinned',slides:[],draftIndex:0,onAirIndex:null,
      pointer:{enabled:false,x:.5,y:.5},zoom:zoom(1),onAirPointer:null,onAirZoom:null,onAirInk:[],
      transport:'stopped',secondsPerSlide:8,busy:false,error:'',pendingIndex:null,revision:0};
    let sessionId='',capability='',channel=null,epoch=0,operation=0,detachedGeneration=0,detachedOpening=null,heartbeat=null,advance=null,closed=false;
    const hostId='host-'+token();let inkPages=[],inkPoints=0;
    const slideInk=n=>inkPages[n]||{strokes:[],revision:0};
    function snapshot(){
      const value=clone(state);value.sessionId=sessionId;
      value.current=clone(state.slides[state.draftIndex]||null);
      value.next=clone(state.slides[state.draftIndex+1]||null);
      value.onAir=state.onAirIndex==null?null:clone(state.slides[state.onAirIndex]||null);
      value.ink=clone(slideInk(state.draftIndex).strokes);value.inkRevision=slideInk(state.draftIndex).revision;
      value.nextInk=clone(slideInk(state.draftIndex+1).strokes);
      value.feedNextInk=clone(slideInk((state.onAirIndex==null?state.draftIndex:state.onAirIndex)+1).strokes);
      value.media=mediaState();
      return value;
    }
    function send(kind,payload={},to){
      if(!channel) return;
      try{channel.postMessage({protocol:PROTOCOL,sessionId,capability,sender:hostId,kind,...payload,...(to?{to}:{})});}catch(error){}
    }
    function emit(){
      state.revision++;
      const value=snapshot();for(const fn of listeners) try{fn(value);}catch(error){}
      send('state',{state:value});
    }
    function clearAdvance(){if(advance!=null){unschedule(advance);advance=null;}}
    function isCurrent(){
      if(closed||state.phase==='empty'||state.phase==='stale'||!state.binding) return false;
      try{return adapter.isCurrent?adapter.isCurrent(clone(state.binding))===true:true;}catch(error){return false;}
    }
    function validate(){
      if(!isCurrent()){
        if(!closed&&state.phase!=='empty'&&state.phase!=='stale'){
          state.phase='stale';state.busy=false;state.pendingIndex=null;state.transport='paused';state.error='The pinned presentation was removed or replaced. Pin it again.';
          epoch++;clearAdvance();emit();
        }
        throw Error(closed?'Presenter session is closed.':state.error||'Pin a presentation first.');
      }
      return true;
    }
    function transportTick(){
      clearAdvance();if(closed||state.transport!=='playing'||state.phase!=='ready') return;
      advance=schedule(()=>{
        advance=null;
        if(closed||state.transport!=='playing') return;
        if(state.busy){transportTick();return;}
        if(feedIndex()>=state.slides.length-1){state.transport='paused';emit();return;}
        navigate(feedIndex()+1).then(transportTick,()=>{state.transport='paused';emit();});
      },state.secondsPerSlide*1000);
    }
    async function run(kind,requested,follow=false,mediaAction){
      validate();if(state.busy) throw Error('Wait for the current Presenter action to finish.');
      requested=index(requested,state.slides.length);
      const capturedEpoch=epoch,serial=++operation,capturedBinding=clone(state.binding),
        guard=()=>capturedEpoch===epoch&&serial===operation&&isCurrent();
      const context={binding:capturedBinding,sessionId,slide:clone(state.slides[requested]),
        pointer:clone(state.pointer),zoom:clone(state.zoom),ink:clone(slideInk(requested).strokes),isCurrent:guard};
      state.busy=true;state.pendingIndex=requested;state.error='';emit();
      let timer;
      try{
        const cancelled=new Promise((resolve,reject)=>{activeCalls.set(serial,{reject,timer:null});});
        const timeout=new Promise((resolve,reject)=>{timer=schedule(()=>{
          operation++;reject(Error('Presenter did not finish within 10 seconds. Check the current slide before trying again.'));
        },10000);activeCalls.get(serial).timer=timer;});
        const callback=adapter[kind];
        const result=await Promise.race([Promise.resolve().then(()=>callback?callback(kind==='media'?mediaAction:requested,context):true),timeout,cancelled]);
        if(!guard()) throw Error('The pinned presentation changed while this slide was preparing.');
        if(result===false) throw Error(kind==='take'?'The slide could not be taken to the pinned feed.':'The slide could not be prepared in Preview.');
        if(result&&typeof result==='object'&&result.url) state.slides[requested].url=slideURL(result.url);
        if(kind==='browse') state.draftIndex=requested;
        else if(kind==='take'){state.onAirIndex=requested;if(follow)state.draftIndex=requested;state.onAirPointer=clone(context.pointer);state.onAirZoom=clone(context.zoom);state.onAirInk=clone(slideInk(requested).strokes);}
        return snapshot();
      }catch(error){
        if(capturedEpoch===epoch&&!closed){
          if(!isCurrent()) validate();
          state.error=text(error&&error.message||error,1000);
        }
        throw error;
      }finally{
        activeCalls.delete(serial);
        if(timer!=null) unschedule(timer);
        if(capturedEpoch===epoch&&!closed){state.busy=false;state.pendingIndex=null;emit();}
      }
    }
    function browse(n){return run('browse',n);}
    function take(){return run('take',state.draftIndex);}
    /* Playback follows the committed Feed, independently of a slide staged in
       the rundown. A single guarded commit updates both views only after the
       host has decoded and installed the pinned Clip's next page. */
    function feedIndex(){return state.onAirIndex==null?state.draftIndex:state.onAirIndex;}
    function navigate(n){return run('take',n,true);}
    function play(){validate();state.transport='playing';state.error='';emit();transportTick();return snapshot();}
    function pause(){validate();state.transport='paused';clearAdvance();emit();return snapshot();}
    function media(action){
      validate();if(!['play','pause','stop'].includes(action))throw Error('Choose Play, Pause or Stop media.');
      if(typeof adapter.media!=='function'||!mediaState().items.length)throw Error('This Feed slide has no embedded media.');
      if(state.busy)throw Error('Wait for the current Presenter action to finish.');
      // Explicit video playback holds this slide instead of advancing on its slideshow timer.
      if(action==='play'){state.transport='paused';clearAdvance();}
      return run('media',feedIndex(),false,action);
    }
    async function stop(){validate();state.transport='stopped';clearAdvance();emit();return navigate(0);}
    function setTiming(seconds){
      validate();seconds=Number(seconds);if(!Number.isFinite(seconds)||seconds<.25||seconds>3600)throw Error('Slide time must be between 0.25 and 3600 seconds.');
      state.secondsPerSlide=seconds;emit();if(state.transport==='playing')transportTick();return snapshot();
    }
    function setPointer(raw){validate();state.pointer=pointer(raw);if(state.draftIndex===state.onAirIndex)state.onAirPointer=clone(state.pointer);emit();return snapshot();}
    function setZoom(raw){validate();state.zoom=zoom(raw);if(state.draftIndex===state.onAirIndex)state.onAirZoom=clone(state.zoom);emit();return snapshot();}
    function inkTarget(payload){
      validate();if(state.busy)throw Error('Wait for the current Presenter action to finish.');
      if(!payload||payload.sessionId!==sessionId||payload.index!==state.draftIndex)
        throw Error('The drawing slide changed. Draw again on the current Preview.');
      const page=slideInk(index(payload.index,state.slides.length));
      if(!Number.isInteger(payload.revision)||payload.revision!==page.revision)
        throw Error('The drawing changed in another Presenter view. Try again.');
      return page;
    }
    function publishInk(n,page){
      page.revision++;inkPages[n]=page;
      if(n===state.onAirIndex)state.onAirInk=clone(page.strokes);
      emit();return snapshot();
    }
    function appendInk(payload){
      const page=inkTarget(payload),stroke=inkStroke(payload.stroke);
      if(page.strokes.length>=MAX_INK_STROKES)throw Error('This slide has 64 drawing strokes. Undo or clear its drawing before adding more.');
      if(inkPoints+stroke.points.length>MAX_SESSION_INK_POINTS)throw Error('This presentation reached its drawing limit. Clear drawings before adding more.');
      page.strokes.push(stroke);inkPoints+=stroke.points.length;return publishInk(payload.index,page);
    }
    function undoInk(payload){const page=inkTarget(payload),last=page.strokes.pop();if(last)inkPoints-=last.points.length;return publishInk(payload.index,page);}
    function clearInk(payload){const page=inkTarget(payload);for(const stroke of page.strokes)inkPoints-=stroke.points.length;page.strokes=[];return publishInk(payload.index,page);}
    function setNotes(n,value){validate();index(n,state.slides.length);state.slides[n].notes=text(value,MAX_NOTES);emit();return snapshot();}
    function updateSlides(changes){
      validate();if(!Array.isArray(changes)) throw Error('Invalid slide updates.');
      const updates=changes.map(item=>({index:index(item.index,state.slides.length),
        ...(item.url!==undefined?{url:slideURL(item.url)}:{}),...(item.notes!==undefined?{notes:text(item.notes,MAX_NOTES)}:{})}));
      updates.forEach(item=>{Object.assign(state.slides[item.index],item);delete state.slides[item.index].index;});emit();return snapshot();
    }
    function sync(patch={}){
      validate();if(patch.onAirIndex!==undefined) state.onAirIndex=patch.onAirIndex===null?null:index(patch.onAirIndex,state.slides.length);
      if(patch.onAirIndex!==undefined)state.onAirInk=clone(slideInk(state.onAirIndex).strokes);
      if(patch.onAirPointer!==undefined) state.onAirPointer=patch.onAirPointer===null?null:pointer(patch.onAirPointer);
      if(patch.onAirZoom!==undefined) state.onAirZoom=patch.onAirZoom===null?null:zoom(patch.onAirZoom);
      emit();return snapshot();
    }
    function action(name,payload={}){
      if(!ACTIONS.has(name)) throw Error('Unknown Presenter action.');
      if(name==='browse') return browse(payload.index);
      if(name==='pointer') return setPointer(payload);
      if(name==='zoom') return setZoom(payload);
      if(name==='ink') return appendInk(payload);
      if(name==='inkUndo') return undoInk(payload);
      if(name==='inkClear') return clearInk(payload);
      if(name==='notes') return setNotes(payload.index,payload.notes);
      if(name==='timing') return setTiming(payload.seconds);
      if(name==='media') return media(payload.action);
      return controller[name]();
    }
    async function receive(event){
      const message=event&&event.data;
      if(!message||message.protocol!==PROTOCOL||message.sessionId!==sessionId||message.capability!==capability||
        typeof message.sender!=='string'||message.sender===hostId||message.sender.length>128) return;
      if(message.kind==='hello'){clients.add(message.sender);send('state',{state:snapshot()},message.sender);return;}
      if(message.kind==='leave'){clients.delete(message.sender);requests.delete(message.sender);return;}
      if(message.kind!=='request'||!clients.has(message.sender)||!ACTIONS.has(message.action)||
        typeof message.requestId!=='string'||message.requestId.length>128||!message.requestId) return;
      const ids=requests.get(message.sender)||new Set();if(ids.has(message.requestId)) return;
      ids.add(message.requestId);if(ids.size>128) ids.delete(ids.values().next().value);requests.set(message.sender,ids);
      try{await action(message.action,message.payload||{});send('result',{requestId:message.requestId,ok:true,state:snapshot()},message.sender);}
      catch(error){send('result',{requestId:message.requestId,ok:false,error:text(error&&error.message||error,1000),state:snapshot()},message.sender);}
    }
    function pulse(){
      heartbeat=null;if(closed||!channel) return;
      if(state.phase==='ready'&&!isCurrent()) try{validate();}catch(error){}
      send('pulse',{revision:state.revision,at:now()});heartbeat=schedule(pulse,1000);
    }
    function closeViews(){
      detachedGeneration++;
      detachedOpening=null;
      for(const view of views){try{if(view.close)view.close();else {view.cleanup();if(view.window&&!view.window.closed)view.window.close();}}catch(error){}}
      views.clear();
    }
    function retire(){
      confidenceReaders.delete(sessionId);
      clearAdvance();if(heartbeat!=null) unschedule(heartbeat);heartbeat=null;
      for(const call of activeCalls.values()){if(call.timer!=null)unschedule(call.timer);call.reject(Error('The Presenter session changed.'));}activeCalls.clear();
      if(channel){send('closed');channel.onmessage=null;channel.close();channel=null;}
      clients.clear();requests.clear();closeViews();
    }
    function pin(raw){
      if(closed) throw Error('Presenter session is closed.');
      if(!raw||!raw.clipId||!raw.mediaId||!Array.isArray(raw.slides)||!raw.slides.length||raw.slides.length>MAX_SLIDES)
        throw Error('Pin a presentation Clip with 1 to 200 prepared slides.');
      const slides=raw.slides.map(slide),draftIndex=index(raw.draftIndex==null?0:raw.draftIndex,slides.length),
        onAirIndex=raw.onAirIndex==null?null:index(raw.onAirIndex,slides.length);
      const seconds=raw.secondsPerSlide==null?8:Number(raw.secondsPerSlide);
      if(!Number.isFinite(seconds)||seconds<.25||seconds>3600) throw Error('Slide time must be between 0.25 and 3600 seconds.');
      retire();epoch++;operation++;sessionId=token();capability=token()+token();inkPages=[];inkPoints=0;
      state={phase:'ready',binding:{clipId:text(raw.clipId),mediaId:text(raw.mediaId)},title:text(raw.title||'Presentation'),slides,
        draftIndex,onAirIndex,pointer:{enabled:false,x:.5,y:.5},zoom:zoom(1),onAirPointer:null,onAirZoom:null,onAirInk:[],
        transport:'stopped',secondsPerSlide:seconds,busy:false,error:'',pendingIndex:null,revision:0};
      confidenceReaders.set(sessionId,{capability,hostId,frame:frameAt,thumbnail:thumbnailAt,read(){
        if(!isCurrent())return null;
        let frame=null,status='No Show monitor connected.';
        try{
          const candidate=adapter.getConfidenceFrame&&adapter.getConfidenceFrame();
          if(candidate&&String(candidate.tagName).toLowerCase()==='canvas'&&typeof candidate.getContext==='function'&&candidate.width>0&&candidate.height>0&&
            (!root.location?.origin||candidate.ownerDocument?.defaultView?.location?.origin===root.location.origin))frame=candidate;
          status=adapter.getConfidenceStatus?text(adapter.getConfidenceStatus(),500):frame?'Show monitor':'No Show monitor connected.';
        }catch(error){status='Show confidence is temporarily unavailable.';}
        return Object.freeze({frame,status});
      }});
      try{channel=makeChannel('openlive.presenter.'+sessionId);channel.onmessage=receive;heartbeat=schedule(pulse,1000);}catch(error){channel=null;}
      emit();return snapshot();
    }
    async function openDetached(settings={}){
      validate();if(!channel) throw Error('Detached Presenter needs BroadcastChannel support in this browser.');
      for(const view of views){
        if(!view.closed&&view.window&&!view.window.closed){
          try{view.window.focus?.();}catch(error){}
          if(settings.onState)view.observe?.(settings.onState);
          return view;
        }
        view.close?.();
        views.delete(view);
      }
      if(detachedOpening)return detachedOpening;
      const session=sessionId,key=capability,generation=detachedGeneration,hostWindow=options.window||root;
      const track=(win,mode,alwaysOnTop,url='',cleanup=()=>{})=>{
        const observers=new Set(),view={window:win,mode,alwaysOnTop,url,closed:false,
          observe(fn){if(typeof fn!=='function')return;observers.add(fn);try{fn({open:!view.closed,opening:false,mode,alwaysOnTop,error:''});}catch(error){}},
          close(){if(view.closed)return;view.closed=true;views.delete(view);try{cleanup();}catch(error){}
            try{if(mode!=='overlay'&&!win.closed)win.close();}catch(error){}
            for(const fn of observers)try{fn({open:false,opening:false,mode,alwaysOnTop:false,error:''});}catch(error){}observers.clear();},
          cleanup(){view.close();}};
        views.add(view);view.observe(settings.onState);return view;
      };
      const opening=(async()=>{
      if(settings.pictureInPicture!==false&&hostWindow.documentPictureInPicture&&hostWindow.documentPictureInPicture.requestWindow){
        try{
          const pip=await hostWindow.documentPictureInPicture.requestWindow({width:1000,height:700});
          if(session!==sessionId||closed||generation!==detachedGeneration){pip.close();throw Error('The Presenter session changed before its window opened.');}
          pip.document.title='SHOWAVE Presenter: '+state.title;
          pip.document.body.classList.add('presenter-page');
          const typography=hostWindow.OpenLiveInterfaceTypography?.install(pip.document);
          const updateTheme=()=>copyTheme(hostWindow,pip.document,typography);updateTheme();
          const stopTheme=hostWindow.OpenLiveAppearance?.subscribe(updateTheme);
          const css=pip.document.createElement('link');css.rel='stylesheet';css.href=assetURL('presenter.css',hostWindow).href;pip.document.head.appendChild(css);
          const surface=pip.document.createElement('main');surface.id='presenter';pip.document.body.appendChild(surface);
          const remote=connect({sessionId:session,capability:key,hostId,channelFactory:makeChannel,now,setTimeout:schedule,clearTimeout:unschedule,
            readFrame:n=>readSlideFrame(session,key,hostId,n)});
          const mounted=mount(surface,remote,{detached:true,readConfidence:()=>readConfidence(session,key,hostId)});
          const view=track(pip,'picture-in-picture',true,'',()=>{stopTheme?.();typography?.destroy();settings.clicker?.close?.();mounted.destroy();remote.close();});pip.addEventListener('pagehide',()=>view.close(),{once:true});
          return view;
        }catch(error){if(session!==sessionId||closed||generation!==detachedGeneration) throw error;}
      }
      const url=assetURL('presenter.html',hostWindow);url.hash=new URLSearchParams({session,key,host:hostId}).toString();
      const doc=hostWindow.document;let dialog=settings.overlay===true?doc?.createElement?.('dialog'):null;
      const popup=dialog&&typeof dialog.showModal==='function'?null:hostWindow.open?.(url.href,'showave-presenter-'+session,'popup,width=760,height=560');
      if(popup){
        let watcher=null;
        const view=track(popup,'window',false,url.href,()=>{settings.clicker?.close?.();if(watcher!==null)unschedule(watcher);watcher=null;});
        const checkClosed=()=>{watcher=null;if(view.closed)return;if(popup.closed){view.close();return;}watcher=schedule(checkClosed,500);};
        watcher=schedule(checkClosed,500);
        return view;
      }
      // Every size floats without blocking Show controls. One owned iframe
      // preserves the control lease and deck while the operator keeps working.
      if(!dialog)dialog=doc?.createElement?.('dialog');
      if(!dialog||typeof dialog.showModal!=='function')throw Error('The Presenter window was blocked. Allow popups for this SHOWAVE page and try again.');
      dialog.className='presenter-web-dialog presenter-web-floating';dialog.classList.add('presenter-web-floating');dialog.setAttribute('aria-label','SHOWAVE web presentation player');
      dialog.dataset.layout='workspace';
      const frame=doc.createElement('iframe');frame.className='presenter-web-frame';frame.title='SHOWAVE web presentation player';
      frame.setAttribute('allow','fullscreen');frame.setAttribute('referrerpolicy','no-referrer');frame.src=url.href;
      dialog.appendChild(frame);doc.body.appendChild(dialog);
      let view,layout='workspace',floatingPosition=null,workspacePosition=null,drag=null,unsubscribeClicker=null;
      const layouts=new Set(['workspace','compact','mini']),nudges=new Set([-40,-10,0,10,40]);
      const acknowledge=()=>{try{frame.contentWindow?.postMessage?.({protocol:'showave.presenter.view/1',kind:'layout',layout,sessionId:session},url.origin);}catch(error){}};
      const clickerState=()=>{
        const value=settings.clicker?.snapshot?.()||{},device=value.clicker||{};
        return {available:!!settings.clicker,status:String(device.status||'automatic'),deviceLabel:text(device.deviceLabel,160),
          keys:Array.isArray(device.keys)?device.keys.slice(0,16).map(key=>text(key,32)):[],reason:text(value.error||device.reason,500)};
      };
      const sendClicker=()=>{if(view?.closed)return;try{frame.contentWindow?.postMessage?.({protocol:'showave.presenter.view/1',kind:'clicker',sessionId:session,state:clickerState()},url.origin);}catch(error){}};
      const placeFloating=(x,y)=>{
        const box=dialog.getBoundingClientRect(),width=hostWindow.innerWidth||doc.documentElement?.clientWidth||box.width,
          height=hostWindow.innerHeight||doc.documentElement?.clientHeight||box.height;
        const position={x:bounded(x,8,Math.max(8,width-box.width-8)),y:bounded(y,8,Math.max(8,height-box.height-8))};
        if(layout==='workspace')workspacePosition=position;else floatingPosition=position;
        dialog.style.left=position.x+'px';dialog.style.top=position.y+'px';
        dialog.style.right=dialog.style.bottom='auto';
      };
      const clampFloating=()=>{
        if(view?.closed)return;
        const box=dialog.getBoundingClientRect(),width=hostWindow.innerWidth||doc.documentElement?.clientWidth||box.width,
          height=hostWindow.innerHeight||doc.documentElement?.clientHeight||box.height;
        const position=layout==='workspace'?workspacePosition:floatingPosition;
        placeFloating(position?.x??(layout==='workspace'?(width-box.width)/2:width-box.width-16),position?.y??(layout==='workspace'?(height-box.height)/2:height-box.height-16));
      };
      const setLayout=next=>{
        if(!layouts.has(next)||next!=='workspace'&&typeof dialog.show!=='function')return;
        if(next!==layout){
          const focused=doc.activeElement===frame||dialog.contains?.(doc.activeElement);
          drag=null;dialog.close();layout=next;dialog.dataset.layout=next;
          for(const property of ['left','top','right','bottom'])dialog.style[property]='';
          dialog.show();clampFloating();
          if(focused)try{frame.contentWindow?.focus?.();}catch(error){}
        }
        acknowledge();
      };
      const message=event=>{
        const data=event.data;
        if(event.origin!==url.origin||event.source!==frame.contentWindow||data?.protocol!=='showave.presenter.view/1'||data.sessionId!==session||view?.closed)return;
        if(data.kind==='close'){view.close();return;}
        if(data.kind==='ready'){acknowledge();sendClicker();return;}
        if(data.kind==='layout'){setLayout(data.layout);return;}
        if(data.kind==='clicker'){
          const action=data.action==='pair'?'pair':data.action==='release'?'release':null;
          if(action&&settings.clicker?.[action])Promise.resolve().then(()=>settings.clicker[action]()).catch(()=>{}).finally(sendClicker);
          return;
        }
        if(data.kind==='nudge'){
          if(!Number.isInteger(data.dx)||!Number.isInteger(data.dy)||!nudges.has(data.dx)||!nudges.has(data.dy))return;
          drag=null;const box=dialog.getBoundingClientRect();placeFloating(box.left+data.dx,box.top+data.dy);return;
        }
        if(data.kind!=='move'||!['start','update','end'].includes(data.phase))return;
        if(data.phase==='end'){drag=null;return;}
        if(!Number.isFinite(data.x)||!Number.isFinite(data.y))return;
        if(data.phase==='start'){const box=dialog.getBoundingClientRect();drag={x:data.x,y:data.y,left:box.left,top:box.top};return;}
        if(!drag)return;
        placeFloating(drag.left+data.x-drag.x,drag.top+data.y-drag.y);
      };
      // UNDOCUMENTED — inferring: standard clicker navigation belongs to the
      // pinned player while its web view is open, including cue/layer focus.
      const hostKey=event=>{
        if(view?.closed||session!==sessionId||!isCurrent())return;
        if(settings.clicker?.ownsKey?.(event)){event.preventDefault();event.stopImmediatePropagation();return;}
        if(event.defaultPrevented||event.repeat||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||editable(event))return;
        if(!['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(event.key))return;
        if(event.target?.closest?.('.presenter,[role="slider"],[role="spinbutton"],[role="menu"],[role="menuitem"],[role="tablist"],[role="tab"],[role="tree"],[role="grid"]'))return;
        if(keyboard(controller,event))event.stopImmediatePropagation();
      };
      const cancel=event=>{event.preventDefault();view.close();};
      view=track(frame.contentWindow,'overlay',false,url.href,()=>{drag=null;unsubscribeClicker?.();settings.clicker?.close?.();hostWindow.removeEventListener('keydown',hostKey,true);hostWindow.removeEventListener('message',message);hostWindow.removeEventListener('resize',clampFloating);dialog.removeEventListener('cancel',cancel);dialog.close();frame.removeAttribute('src');dialog.remove();});
      hostWindow.addEventListener('keydown',hostKey,true);hostWindow.addEventListener('message',message);hostWindow.addEventListener('resize',clampFloating);dialog.addEventListener('cancel',cancel);
      unsubscribeClicker=settings.clicker?.subscribe?.(sendClicker);
      try{dialog.show();clampFloating();}catch(error){view.close();throw error;}
      return view;
      })();
      detachedOpening=opening;
      try{return await opening;}finally{if(detachedOpening===opening)detachedOpening=null;}
    }
    function close(){
      if(closed) return;closed=true;epoch++;operation++;state.phase='closed';state.busy=false;state.transport='stopped';
      inkPages=[];inkPoints=0;state.onAirInk=[];emit();retire();listeners.clear();if(adapter.onClose)try{adapter.onClose(clone(state.binding));}catch(error){}
    }
    function mediaState(){
      if(!isCurrent())return {items:[],playing:false,error:''};
      try{
        const raw=adapter.getMediaState?.(),items=(Array.isArray(raw?.items)?raw.items:[]).slice(0,32).map(item=>({
          type:item.type==='audio'?'audio':'video',playing:item.playing===true,ended:item.ended===true,muted:item.muted===true,
          currentTime:Math.max(0,Number(item.currentTime)||0),duration:Number.isFinite(item.duration)?Math.max(0,item.duration):null,error:text(item.error||'',500)}));
        return {items,playing:items.some(item=>item.playing),error:text(raw?.error||'',1000)};
      }catch(_){return {items:[],playing:false,error:''};}
    }
    function frameAt(n,thumbnail=false){
      if(!isCurrent()||!Number.isInteger(n)||n<0||n>=state.slides.length)return null;
      try{const frame=thumbnail?adapter.getSlideThumbnail?.(n):adapter.getSlideFrame?.(n);
        return frame&&String(frame.tagName).toLowerCase()==='canvas'&&frame.width>1&&frame.height>1&&
          (!root.location?.origin||frame.ownerDocument?.defaultView?.location?.origin===root.location.origin)?frame:null;
      }catch(_){return null;}
    }
    const thumbnailAt=n=>frameAt(n,true);
    const controller={pin,snapshot,frame:frameAt,thumbnail:thumbnailAt,subscribe(fn){listeners.add(fn);fn(snapshot());return()=>listeners.delete(fn);},browse,
      first:()=>navigate(0),previous:()=>navigate(Math.max(0,feedIndex()-1)),
      next:()=>navigate(Math.min(state.slides.length-1,feedIndex()+1)),last:()=>navigate(state.slides.length-1),
      take,play,pause,stop,media,setPointer,setZoom,appendInk,undoInk,clearInk,setNotes,setTiming,updateSlides,sync,openDetached,
      openView:settings=>openDetached({pictureInPicture:false,...settings}),close,
      key:event=>keyboard(controller,event)};
    return Object.freeze(controller);
  }

  function connect(options){
    const sessionId=text(options&&options.sessionId,128),capability=text(options&&options.capability,256);
    if(!sessionId||!capability) throw Error('Open Presenter from the pinned presentation in SHOWAVE.');
    const now=options.now||(()=>Date.now()),schedule=options.setTimeout||root.setTimeout.bind(root),unschedule=options.clearTimeout||root.clearTimeout.bind(root),
      makeChannel=options.channelFactory||(name=>new root.BroadcastChannel(name)),clientId='view-'+token(),listeners=new Set(),pending=new Map();
    const channel=makeChannel('openlive.presenter.'+sessionId);let serial=0,closed=false,lastSeen=now(),lastHello=-Infinity,timer=null,expectedHost=options.hostId||null;
    let state={phase:'connecting',title:'Connecting to SHOWAVE Presenter',slides:[],draftIndex:0,onAirIndex:null,busy:true,error:''};
    function emit(){for(const fn of listeners)try{fn(clone(state));}catch(error){}}
    function send(kind,payload={}){if(!closed)channel.postMessage({protocol:PROTOCOL,sessionId,capability,sender:clientId,kind,...payload});}
    function rejectPending(reason){for(const request of pending.values()){unschedule(request.timer);request.reject(Error(reason));}pending.clear();}
    function handshake(){if(state.phase!=='closed'&&now()-lastHello>=2000){lastHello=now();send('hello');}}
    channel.onmessage=event=>{
      const message=event&&event.data;
      if(closed||!message||message.protocol!==PROTOCOL||message.sessionId!==sessionId||message.capability!==capability||
        typeof message.sender!=='string'||!message.sender.startsWith('host-')||expectedHost&&message.sender!==expectedHost||message.to&&message.to!==clientId) return;
      if(!expectedHost)expectedHost=message.sender;
      lastSeen=now();
      if(message.kind==='pulse'&&['connecting','disconnected'].includes(state.phase))handshake();
      if(message.kind==='closed'){
        state={...state,phase:'closed',busy:false,error:'The pinned Presenter session closed. Open it again from SHOWAVE.'};rejectPending(state.error);emit();return;
      }
      if(['state','result'].includes(message.kind)&&message.state&&typeof message.state==='object'){
        if(message.state.sessionId!==sessionId||!Array.isArray(message.state.slides)||message.state.slides.length>MAX_SLIDES) return;
        state=clone(message.state);emit();
      }
      if(message.kind==='result'&&typeof message.requestId==='string'){
        const request=pending.get(message.requestId);if(!request)return;
        pending.delete(message.requestId);unschedule(request.timer);
        if(message.ok===true)request.resolve(clone(state));else request.reject(Error(text(message.error||'Presenter action failed.',1000)));
      }
    };
    function watch(){
      timer=null;if(closed)return;
      if(now()-lastSeen>5000&&!['closed','disconnected'].includes(state.phase)){
        state={...state,phase:'disconnected',busy:false,error:'Reconnecting to the pinned presentation…'};rejectPending(state.error);emit();
      }
      if(['connecting','disconnected'].includes(state.phase))handshake();
      timer=schedule(watch,1000);
    }
    function request(action,payload={}){
      if(closed||state.phase!=='ready')return Promise.reject(Error(state.error||'Presenter is not connected.'));
      if(state.busy)return Promise.reject(Error('Wait for the current Presenter action to finish.'));
      const requestId=clientId+':'+(++serial);
      return new Promise((resolve,reject)=>{
        const timeout=schedule(()=>{pending.delete(requestId);reject(Error('Presenter did not respond within 10 seconds. Check its current slide before trying again.'));},10000);
        pending.set(requestId,{resolve,reject,timer:timeout});send('request',{requestId,action,payload});
      });
    }
    function close(){if(closed)return;send('leave');closed=true;if(timer!=null)unschedule(timer);rejectPending('Presenter view closed.');channel.onmessage=null;channel.close();listeners.clear();}
    const controller={snapshot:()=>clone(state),frame:n=>state.phase==='ready'?options.readFrame?.(n)||null:null,
      thumbnail:n=>state.phase==='ready'?options.readThumbnail?.(n)||null:null,subscribe(fn){listeners.add(fn);fn(clone(state));return()=>listeners.delete(fn);},
      browse:n=>request('browse',{index:n}),first:()=>request('first'),previous:()=>request('previous'),next:()=>request('next'),last:()=>request('last'),
      take:()=>request('take'),play:()=>request('play'),pause:()=>request('pause'),stop:()=>request('stop'),media:action=>request('media',{action}),
      setPointer:value=>request('pointer',value),setZoom:value=>request('zoom',typeof value==='number'?zoom(value):value),
      appendInk:value=>request('ink',value),undoInk:value=>request('inkUndo',value),clearInk:value=>request('inkClear',value),
      setNotes:(n,value)=>request('notes',{index:n,notes:value}),setTiming:seconds=>request('timing',{seconds}),close,key:event=>keyboard(controller,event)};
    handshake();timer=schedule(watch,1000);return Object.freeze(controller);
  }

  function mount(surface,controller,options={}){
    if(!surface||!controller)throw Error('Presenter needs a view surface and controller.');
    const doc=surface.ownerDocument,win=doc.defaultView||root,created=[],listen=(node,type,fn,settings)=>{node.addEventListener(type,fn,settings);created.push(()=>node.removeEventListener(type,fn,settings));};
    const el=(tag,className,value)=>{const node=doc.createElement(tag);if(className)node.className=className;if(value!=null)node.textContent=value;return node;};
    const compact=options.compact!==undefined?options.compact:surface.id==='presentationSessionHost';
    surface.classList.add('presenter');surface.classList.toggle('presenter-compact',!!compact);surface.classList.toggle('presenter-detached',!!options.detached);surface.tabIndex=0;surface.setAttribute('aria-label','SHOWAVE Presenter');
    surface.classList.toggle('presenter-web',!!options.web);
    const head=el('header','presenter-head'),title=el('strong','presenter-title','Presenter'),status=el('span','presenter-status'),close=el('button','presenter-button','Close view');
    const viewButtons={},canResize=options.web&&typeof options.setViewLayout==='function';
    let viewLayout='workspace',moveHandle=null,movingPointer=null,clickerPanel=null,clickerButton=null,clickerDescription=null,clickerPair=null,clickerRelease=null;
    close.type='button';close.setAttribute('aria-label','Close presentation view');close.title='Close view · presentation stays loaded';
    if(options.web){
      const brand=el('div','presenter-brand'),mark=el('span','presenter-brand-mark'),identity=el('div','presenter-identity');mark.setAttribute('aria-hidden','true');
      brand.append(mark,el('span','','Present'));identity.append(el('span','presenter-eyebrow','Presentation player'),title);
      if(canResize){
        moveHandle=el('button','presenter-button presenter-move-handle');moveHandle.type='button';
        moveHandle.setAttribute('aria-label','Move presentation player');moveHandle.title='Drag to move · arrow keys move 10 px · Shift moves 40 px';head.appendChild(moveHandle);
      }
      head.append(brand,identity,status);
      if(typeof options.clickerAction==='function'){
        clickerButton=el('button','presenter-button presenter-clicker');clickerButton.type='button';clickerButton.setAttribute('aria-label','Clicker setup');clickerButton.setAttribute('aria-expanded','false');
        const icon=el('span','presenter-clicker-icon');icon.setAttribute('aria-hidden','true');clickerButton.append(icon,el('span','presenter-clicker-label','Clicker'));
        clickerButton.title='Clicker: automatic in SHOWAVE · pair for other applications';head.appendChild(clickerButton);
      }
      if(canResize){
        const sizes=el('div','presenter-view-sizes');sizes.setAttribute('role','group');sizes.setAttribute('aria-label','Presentation player size');
        for(const [layout,label] of [['workspace','Workspace'],['compact','Compact'],['mini','Mini']]){
          const button=el('button','presenter-button presenter-view-size'),icon=el('span','presenter-window-icon');button.type='button';button.dataset.presenterView=layout;
          icon.setAttribute('aria-hidden','true');button.append(icon,el('span','presenter-size-label',label));
          button.setAttribute('aria-label',label==='Mini'?'Mini player':label+' view');button.setAttribute('aria-pressed',String(layout==='workspace'));
          button.title=layout==='workspace'?'Full presentation workspace':layout==='compact'?'Compact view · keep working in SHOWAVE':'Mini player · floating Feed and slide controls';
          sizes.appendChild(button);viewButtons[layout]=button;
        }
        head.appendChild(sizes);
      }
      close.classList.add('presenter-close');close.textContent='';close.appendChild(el('span','presenter-close-icon'));head.appendChild(close);
    }else head.append(title,status,close);
    surface.appendChild(head);
    if(clickerButton){
      clickerPanel=el('section','presenter-clicker-panel');clickerPanel.hidden=true;clickerPanel.id='presenter-clicker-'+token();clickerPanel.setAttribute('aria-label','Clicker setup');clickerButton.setAttribute('aria-controls',clickerPanel.id);
      const row=el('div','presenter-clicker-head'),dismiss=el('button','presenter-button','×');dismiss.type='button';dismiss.setAttribute('aria-label','Close clicker setup');row.append(el('strong','','Clicker control'),dismiss);
      clickerDescription=el('p','presenter-clicker-description','Page Up / Page Down and left / right arrows automatically follow this deck while you use SHOWAVE. Text fields keep their own keys.');
      const explanation=el('p','presenter-muted','Working in another application? Pair your USB clicker once for this session. Press its Next button when prompted. The Windows helper runs in the background.');
      const actions=el('div','presenter-clicker-actions');clickerPair=el('button','presenter-button','Pair background clicker');clickerRelease=el('button','presenter-button','Release clicker');clickerPair.type=clickerRelease.type='button';clickerRelease.hidden=true;
      actions.append(clickerPair,clickerRelease);clickerPanel.append(row,clickerDescription,explanation,actions);surface.appendChild(clickerPanel);
      const toggle=shown=>{clickerPanel.hidden=!shown;clickerButton.setAttribute('aria-expanded',String(shown));};
      listen(clickerButton,'click',()=>toggle(clickerPanel.hidden));listen(dismiss,'click',()=>{toggle(false);clickerButton.focus();});
      listen(clickerPanel,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();toggle(false);clickerButton.focus();}});
      listen(clickerPair,'click',()=>options.clickerAction('pair'));listen(clickerRelease,'click',()=>options.clickerAction('release'));
    }
    const setClickerState=value=>{
      if(!clickerButton)return;
      const state=value||{},paired=state.status==='paired',pairing=state.status==='pairing';
      clickerButton.dataset.state=state.status||'automatic';
      clickerButton.title=paired?'Background clicker linked'+(state.deviceLabel?' · '+state.deviceLabel:''):pairing?'Press Next on your clicker to link it':'Clicker: automatic in SHOWAVE · pair for other applications';
      clickerDescription.textContent=paired?'Linked'+(state.deviceLabel?' · '+state.deviceLabel:'')+'. This clicker controls the pinned deck while you work in other applications.':pairing?'Press Next on your USB clicker now. That press links the device; it will not advance the slide.':state.reason||'Page Up / Page Down and left / right arrows automatically follow this deck while you use SHOWAVE. Text fields keep their own keys.';
      clickerPair.disabled=!state.available||pairing;clickerPair.textContent=paired?'Pair another clicker':'Pair background clicker';clickerRelease.hidden=!paired&&!pairing;
    };
    const tools=el('div','presenter-tools'),buttons={};
    const addButton=(key,label)=>{const button=el('button','presenter-button',label);button.type='button';button.dataset.presenterAction=key;tools.appendChild(button);buttons[key]=button;return button;};
    for(const [key,label]of [['first','First slide to Feed'],['previous','Previous slide to Feed'],['next','Next slide to Feed'],['last','Last slide to Feed'],['play','Play presentation'],['pause','Pause presentation'],['stop','Stop presentation; reset Feed to first slide']]){
      const button=addButton(key,'');button.classList.add('presenter-transport');
      const icon=el('span','presenter-icon');icon.setAttribute('aria-hidden','true');button.appendChild(icon);
      button.title=label;button.setAttribute('aria-label',label);
      if(options.web&&['previous','next'].includes(key)){
        button.classList.add('presenter-step');button.appendChild(el('span','presenter-step-label',key==='previous'?'Previous':'Next'));
      }
    }
    const jump=el('select','presenter-jump');jump.setAttribute('aria-label','Browse slide');tools.appendChild(jump);
    const miniCount=el('span','presenter-mini-count');miniCount.setAttribute('aria-label','Current Feed slide');tools.appendChild(miniCount);
    const timing=el('input','presenter-timing');timing.type='number';timing.min='.25';timing.max='3600';timing.step='.25';timing.title='Seconds per presentation slide';timing.setAttribute('aria-label','Seconds per presentation slide');
    const take=addButton('take','Take slide');take.setAttribute('aria-label','Take slide');take.title='Update the pinned Clip feed with the Preview slide. Show output follows the Clip playback state.';take.classList.add('presenter-take');surface.appendChild(tools);
    const progressRow=el('div','presenter-progress-row'),progress=el('input','presenter-progress'),progressCount=el('span','presenter-progress-count');
    progress.type='range';progress.min='1';progress.max='1';progress.step='1';progress.setAttribute('aria-label','Browse presentation progress');progress.title='Prepare a slide in Preview. Take slide updates Feed.';progressRow.append(progress,progressCount);surface.appendChild(progressRow);
    const layout=el('div','presenter-layout');
    const frame=(name,kind)=>{
      const panel=el('section','presenter-frame presenter-'+kind),heading=el('div','presenter-section-head'),label=el('span','',name),count=el('span'),stage=el('div','presenter-slide'),canvas=el('canvas','presenter-image'),placeholder=el('span','presenter-placeholder','N/A'),image=el('img');
      count.className='presenter-frame-count';heading.append(label,count);panel.appendChild(heading);canvas.setAttribute('aria-label',name+' slide');canvas.setAttribute('role','img');image.draggable=false;image.alt='';canvas.hidden=true;stage.append(canvas,placeholder);panel.appendChild(stage);layout.appendChild(panel);
      return {panel,count,stage,canvas,placeholder,image,url:'',tools:null};
    };
    const draft=frame('Preview','draft'),next=frame('Next','next'),feed=frame('Feed','feed');
    const mediaBar=el('div','presenter-media-bar'),mediaLabel=el('span','presenter-media-label'),mediaButtons={};
    mediaBar.hidden=true;mediaBar.setAttribute('role','group');mediaBar.setAttribute('aria-label','Embedded media on Feed');mediaBar.appendChild(mediaLabel);
    for(const [action,label]of [['play','Play media'],['pause','Pause media'],['stop','Restart media']]){
      const button=el('button','presenter-button presenter-media-button',label);button.type='button';button.dataset.presenterMedia=action;
      button.setAttribute('aria-label',label+' on Feed');button.title=action==='stop'?'Return embedded media to its first frame':label+' on the current Feed slide';
      mediaBar.appendChild(button);mediaButtons[action]=button;listen(button,'click',()=>perform('media',action));
    }
    feed.panel.appendChild(mediaBar);
    const notesPanel=el('details','presenter-note-panel'),notesHeading=el('summary','presenter-section-head','Speaker notes'),notes=el('textarea','presenter-notes');notes.rows=3;notes.maxLength=MAX_NOTES;notes.setAttribute('aria-label','Speaker notes for Preview slide');notesPanel.open=!compact&&!options.detached;notesPanel.append(notesHeading,notes,el('div','presenter-muted','Session only · never sent to the feed'));layout.appendChild(notesPanel);surface.appendChild(layout);
    let confidence=null;
    if(!compact&&typeof options.readConfidence==='function'){
      const panel=el('section','presenter-frame presenter-confidence'),heading=el('div','presenter-section-head'),label=el('span','','Show confidence'),status=el('span','presenter-confidence-status','Connecting…'),stage=el('div','presenter-slide'),canvas=el('canvas','presenter-image'),placeholder=el('span','presenter-placeholder','Connecting to the Show monitor…');
      canvas.setAttribute('aria-label','Actual Show output confidence');canvas.setAttribute('role','img');canvas.hidden=true;heading.append(label,status);stage.append(canvas,placeholder);panel.append(heading,stage);layout.appendChild(panel);confidence={canvas,placeholder,status,panel};panel.hidden=!!options.web;
    }
    const adjustments=el('div','presenter-tools presenter-adjustments presenter-utilities'),utilityButtons={},menuButtons={},viewId='presenter-view-'+token();
    adjustments.setAttribute('role','group');adjustments.setAttribute('aria-label','Presentation tools');
    const iconButton=(key,label,parent=adjustments)=>{
      const button=el('button','presenter-button presenter-tool-button'),icon=el('span','presenter-icon');button.type='button';button.dataset.presenterTool=key;button.title=label;button.setAttribute('aria-label',label);icon.setAttribute('aria-hidden','true');button.appendChild(icon);parent.appendChild(button);utilityButtons[key]=button;return button;
    };
    const overviewButton=iconButton('overview','Slide overview'),pointerButton=iconButton('laser','Laser pointer'),drawButton=iconButton('draw','Draw on slide'),zoomButton=iconButton('zoom','Zoom controls');
    const notesToggle=options.web?iconButton('notes','Show speaker notes'):null,confidenceToggle=options.web&&confidence?iconButton('confidence','Show monitor'):null;
    if(notesToggle){notesToggle.setAttribute('aria-pressed',String(notesPanel.open));notesPanel.id='presenter-notes-'+token();notesToggle.setAttribute('aria-controls',notesPanel.id);}
    if(confidenceToggle)confidenceToggle.setAttribute('aria-pressed','false');
    for(const button of [overviewButton,pointerButton,drawButton])button.setAttribute('aria-pressed','false');
    pointerButton.title='Move the laser over Preview. Tools update Feed while viewing its current slide.';
    const divider=el('span','presenter-tool-divider');divider.setAttribute('aria-hidden','true');adjustments.appendChild(divider);
    const presenterButton=iconButton('presenter','Open presenter view');presenterButton.hidden=typeof options.openPresenterView!=='function';
    const fullscreenButton=iconButton('fullscreen','Full screen presenter');fullscreenButton.disabled=typeof surface.requestFullscreen!=='function'||doc.fullscreenEnabled===false;fullscreenButton.title=fullscreenButton.disabled?'Full screen is unavailable in this browser.':'Full screen presenter';
    adjustments.appendChild(el('span','presenter-tools-spacer'));
    const menuAnchor=el('div','presenter-menu-anchor'),moreButton=iconButton('more','More presentation options',menuAnchor),moreMenu=el('div','presenter-more-menu');moreMenu.id=viewId+'-more';moreMenu.hidden=true;moreMenu.setAttribute('role','menu');moreMenu.setAttribute('aria-label','More presentation options');moreButton.setAttribute('aria-haspopup','menu');moreButton.setAttribute('aria-expanded','false');moreButton.setAttribute('aria-controls',moreMenu.id);
    const menuItem=(key,label)=>{const button=el('button','presenter-menu-item'),icon=el('span','presenter-icon');button.type='button';button.dataset.presenterMenuAction=key;button.setAttribute('role','menuitem');icon.setAttribute('aria-hidden','true');button.append(icon,el('span','',label));moreMenu.appendChild(button);menuButtons[key]=button;return button;};
    const notesButton=menuItem('notes','Speaker notes'),timingButton=menuItem('timing','Slide timing');
    const menuDivider=el('div','presenter-menu-separator');menuDivider.setAttribute('role','separator');moreMenu.appendChild(menuDivider);
    const undoInk=menuItem('undo-ink','Undo last drawing'),clearInk=menuItem('clear-ink','Clear slide drawings'),resetTools=menuItem('reset-tools','Reset laser and zoom');
    menuAnchor.appendChild(moreMenu);adjustments.appendChild(menuAnchor);surface.appendChild(adjustments);
    const optionsBody=el('div','presenter-tools presenter-options-body'),zoomSettings=el('div','presenter-setting-group'),timingSettings=el('div','presenter-setting-group'),zoomMode=el('select','presenter-zoom-mode'),zoomSelect=el('select','presenter-zoom');optionsBody.hidden=true;zoomSettings.hidden=timingSettings.hidden=true;zoomSettings.id=viewId+'-zoom';zoomButton.setAttribute('aria-expanded','false');zoomButton.setAttribute('aria-controls',zoomSettings.id);zoomMode.setAttribute('aria-label','Zoom mode');zoomSelect.setAttribute('aria-label','Zoom magnification');
    for(const [value,label]of [['off','Zoom off'],['lens','Lens'],['area','Area']]){const option=el('option','',label);option.value=value;zoomMode.appendChild(option);}
    for(const value of [1.25,1.5,2,3,4]){const option=el('option','',Math.round(value*100)+'%');option.value=String(value);zoomSelect.appendChild(option);}
    zoomSettings.append(el('span','presenter-muted','Zoom'),zoomMode,zoomSelect);timingSettings.append(el('span','presenter-muted','Slide time'),timing,el('span','presenter-muted','s'));optionsBody.append(zoomSettings,timingSettings);surface.appendChild(optionsBody);
    const inkSettings=el('div','presenter-tools presenter-ink-settings'),inkColor=el('select','presenter-ink-color'),inkWidth=el('select','presenter-ink-width');inkSettings.hidden=true;inkColor.setAttribute('aria-label','Drawing color');inkWidth.setAttribute('aria-label','Drawing width');
    for(const [value,label]of [['#d04a3f','Red'],['#008cff','Blue'],['#ffffff','White'],['#f0bc42','Gold']]){const option=el('option','',label);option.value=value;inkColor.appendChild(option);}
    for(const [value,label]of [['.003','Fine'],['.006','Medium'],['.012','Bold']]){const option=el('option','',label);option.value=value;inkWidth.appendChild(option);}inkColor.value='#d04a3f';inkWidth.value='.006';inkSettings.append(el('span','presenter-muted','Pen'),inkColor,inkWidth);surface.appendChild(inkSettings);
    const strip=el('div','presenter-strip');strip.setAttribute('aria-label','Slide rundown');surface.appendChild(strip);
    strip.id=viewId+'-overview';overviewButton.setAttribute('aria-controls',strip.id);overviewButton.setAttribute('aria-pressed','true');
    const foot=el('footer','presenter-foot'),notice=el('span','presenter-notice'),clock=el('span','presenter-muted');notice.setAttribute('role','status');foot.append(notice,clock);surface.appendChild(foot);
    let current=null,slideIdentity='',noteIndex=0,noteSession=null,rundown=[],pointerFrame=null,pendingPointer=null,confidenceTimer=null,mediaTimer=null,destroyed=false,drawing=false,stroke=null,inkFrame=null,viewError='';
    const report=error=>{if(!destroyed){viewError=error.message||String(error);notice.textContent=viewError;surface.dataset.error='true';}};
    const perform=(name,...args)=>{viewError='';return Promise.resolve().then(()=>controller[name](...args)).catch(report);};
    // UNDOCUMENTED — inferring: operator-requested floating views extend the
    // movable panels in manual/layouts.htm without changing the pinned feed.
    const endMove=()=>{
      if(movingPointer===null)return;const pointer=movingPointer;movingPointer=null;
      try{moveHandle?.releasePointerCapture?.(pointer);}catch(_){}
      options.moveView?.({phase:'end'});
    };
    const setViewLayout=layout=>{
      if(!['workspace','compact','mini'].includes(layout)||destroyed)return false;
      endMove();cancelStroke();viewLayout=layout;surface.dataset.view=layout;
      for(const [name,button] of Object.entries(viewButtons))button.setAttribute('aria-pressed',String(name===layout));
      if(moveHandle)moveHandle.hidden=false;setMenu(false);updateConfidence();
      return true;
    };
    for(const [layout,button] of Object.entries(viewButtons))listen(button,'click',()=>{
      try{
        const request=()=>options.setViewLayout(layout);
        if(doc.fullscreenElement===surface)Promise.resolve(doc.exitFullscreen()).then(request).catch(report);else request();
      }catch(error){report(error);}
    });
    if(moveHandle){
      listen(moveHandle,'pointerdown',event=>{
        if(event.button!==0)return;event.preventDefault();event.stopPropagation();
        movingPointer=event.pointerId;moveHandle.focus();try{moveHandle.setPointerCapture?.(event.pointerId);}catch(_){}
        options.moveView?.({phase:'start',x:event.screenX,y:event.screenY});
      });
      listen(moveHandle,'pointermove',event=>{if(movingPointer===event.pointerId)options.moveView?.({phase:'update',x:event.screenX,y:event.screenY});});
      for(const name of ['pointerup','pointercancel','lostpointercapture'])listen(moveHandle,name,endMove);
      listen(win,'blur',endMove);
      listen(moveHandle,'keydown',event=>{
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
        if(!delta)return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?40:10;
        options.nudgeView?.({dx:delta[0]*step,dy:delta[1]*step});
      });
    }
    const stopConfidence=()=>{if(confidenceTimer!==null){win.clearTimeout(confidenceTimer);confidenceTimer=null;}};
    const confidenceTick=()=>{
      confidenceTimer=null;if(destroyed||!confidence||confidence.panel.hidden||viewLayout!=='workspace'||current?.phase!=='ready'||doc.visibilityState==='hidden')return;
      let value=null;try{value=options.readConfidence();}catch(error){}
      const source=value&&value.frame,ready=source&&source.width>0&&source.height>0;
      confidence.status.textContent=value?.status||'Session unavailable';confidence.canvas.hidden=!ready;confidence.placeholder.hidden=!!ready;
      if(ready){
        const scale=Math.min(1,960/source.width,540/source.height),width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
        if(confidence.canvas.width!==width||confidence.canvas.height!==height){confidence.canvas.width=width;confidence.canvas.height=height;}
        const ctx=confidence.canvas.getContext('2d');
        try{ctx.clearRect(0,0,width,height);ctx.drawImage(source,0,0,width,height);}catch(error){confidence.canvas.hidden=true;confidence.placeholder.hidden=false;confidence.placeholder.textContent='The Show monitor is temporarily unavailable.';}
      }else confidence.placeholder.textContent=value?.status||'Reconnect Presenter from the main system.';
      confidenceTimer=win.setTimeout(confidenceTick,200);
    };
    const updateConfidence=()=>{
      if(!confidence)return;
      if(destroyed||confidence.panel.hidden||viewLayout!=='workspace'||current?.phase!=='ready'||doc.visibilityState==='hidden'){
        stopConfidence();if(current?.phase!=='ready'){confidence.canvas.hidden=true;confidence.placeholder.hidden=false;confidence.status.textContent=current?.phase||'Disconnected';confidence.placeholder.textContent='The Show confidence connection is unavailable.';}return;
      }
      if(confidenceTimer===null)confidenceTick();
    };
    if(confidence)listen(doc,'visibilitychange',updateConfidence);
    const paint=row=>{
      if(destroyed)return;
      const source=row.direct||row.image,w=source.naturalWidth||source.width,h=source.naturalHeight||source.height;
      if((!row.direct&&!row.url)||!(w>0&&h>0)){row.canvas.hidden=true;row.placeholder.hidden=false;return;}
      const scale=Math.min(1,960/w,540/h),width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
      if(row.canvas.width!==width)row.canvas.width=width;if(row.canvas.height!==height)row.canvas.height=height;
      const ctx=row.canvas.getContext('2d');if(!ctx)return;ctx.clearRect(0,0,row.canvas.width,row.canvas.height);
      const toolState=row===draft&&stroke?{...row.tools,ink:[...(row.tools?.ink||[]),stroke.stroke]}:row.tools||{};
      paintFrame(ctx,source,row.canvas.width,row.canvas.height,toolState);row.canvas.hidden=false;row.placeholder.hidden=true;
    };
    const showFrame=(row,url,toolState,empty,n)=>{
      row.tools=toolState;row.placeholder.textContent=empty;
      row.direct=Number.isInteger(n)&&typeof controller.frame==='function'?controller.frame(n):null;
      if(row.direct){paint(row);return;}
      if(row.url!==url){if(decodedSlides.get(row.url)===row.image)decodedSlides.delete(row.url);row.url=url;row.canvas.hidden=true;row.placeholder.hidden=false;if(url)row.image.src=url;else row.image.removeAttribute('src');}
      else paint(row);
    };
    const stopMediaPaint=()=>{if(mediaTimer!==null){win.clearTimeout(mediaTimer);mediaTimer=null;}};
    const mediaTick=()=>{
      mediaTimer=null;
      if(destroyed||doc.visibilityState==='hidden'||current?.phase!=='ready'||!current.media?.playing)return;
      const source=controller.frame?.(current.onAirIndex);
      if(source){
        feed.direct=source;paint(feed);
        if(current.draftIndex===current.onAirIndex&&viewLayout!=='mini'){draft.direct=source;paint(draft);}
        const row=rundown[current.onAirIndex],ctx=row?.canvas?.getContext('2d');
        if(ctx){paintFrame(ctx,source,128,72);row.canvas.hidden=false;row.image.hidden=true;}
      }
      mediaTimer=win.setTimeout(mediaTick,33);
    };
    const updateMediaPaint=()=>{stopMediaPaint();if(current?.media?.playing)mediaTick();};
    listen(doc,'visibilitychange',updateMediaPaint);
    for(const row of [draft,next,feed]){listen(row.image,'load',()=>{if(row.url&&row.image.naturalWidth>0){decodedSlides.set(row.url,row.image);while(decodedSlides.size>32)decodedSlides.delete(decodedSlides.keys().next().value);}paint(row);});listen(row.image,'error',()=>{if(decodedSlides.get(row.url)===row.image)decodedSlides.delete(row.url);row.canvas.hidden=true;row.placeholder.hidden=false;row.placeholder.textContent='Slide image is unavailable. Browse it again.';});}
    for(const [key,button]of Object.entries(buttons))listen(button,'click',()=>perform(key));
    listen(jump,'change',()=>perform('browse',Number(jump.value)));
    listen(progress,'change',()=>perform('browse',Number(progress.value)-1));
    listen(timing,'change',()=>perform('setTiming',Number(timing.value)));
    const setMenu=(open,focus=false)=>{
      moreMenu.hidden=!open;moreButton.setAttribute('aria-expanded',String(open));
      if(focus){if(open)Object.values(menuButtons).find(button=>!button.disabled)?.focus();else moreButton.focus();}
    };
    const showOptions=()=>{optionsBody.hidden=zoomSettings.hidden&&timingSettings.hidden;zoomButton.setAttribute('aria-expanded',String(!zoomSettings.hidden));};
    listen(moreButton,'click',()=>setMenu(moreMenu.hidden,true));
    listen(moreButton,'keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopPropagation();setMenu(true,true);if(event.key==='ArrowUp')Object.values(menuButtons).filter(button=>!button.disabled).at(-1)?.focus();}});
    listen(moreMenu,'keydown',event=>{
      event.stopPropagation();
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();event.stopPropagation();const enabled=Object.values(menuButtons).filter(button=>!button.disabled),position=enabled.indexOf(doc.activeElement);
        const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(position+(event.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length;enabled[next]?.focus();
      }else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(false,true);}
      else if(event.key==='Tab'){event.stopPropagation();setMenu(false,true);}
      else if(['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(event.key))event.preventDefault();
    });
    listen(doc,'pointerdown',event=>{if(!moreMenu.hidden&&!menuAnchor.contains(event.target))setMenu(false);});
    listen(overviewButton,'click',()=>{strip.hidden=!strip.hidden;overviewButton.setAttribute('aria-pressed',String(!strip.hidden));});
    listen(zoomButton,'click',()=>{zoomSettings.hidden=!zoomSettings.hidden;showOptions();if(!zoomSettings.hidden)zoomMode.focus();});
    listen(notesButton,'click',()=>{setMenu(false);notesPanel.open=!notesPanel.open;if(notesPanel.open)notes.focus();else moreButton.focus();});
    if(notesToggle){listen(notesToggle,'click',()=>{notesPanel.open=!notesPanel.open;if(notesPanel.open)notes.focus();});listen(notesPanel,'toggle',()=>notesToggle.setAttribute('aria-pressed',String(notesPanel.open)));}
    if(confidenceToggle)listen(confidenceToggle,'click',()=>{confidence.panel.hidden=!confidence.panel.hidden;confidenceToggle.setAttribute('aria-pressed',String(!confidence.panel.hidden));updateConfidence();});
    listen(timingButton,'click',()=>{setMenu(false);timingSettings.hidden=!timingSettings.hidden;showOptions();if(!timingSettings.hidden)timing.focus();else moreButton.focus();});
    const inkTarget=()=>({sessionId:current.sessionId,index:current.draftIndex,revision:current.inkRevision});
    listen(undoInk,'click',()=>{setMenu(false,true);if(current)perform('undoInk',inkTarget());});
    listen(clearInk,'click',()=>{setMenu(false,true);if(current)perform('clearInk',inkTarget());});
    listen(drawButton,'click',()=>{
      drawing=!drawing;drawButton.setAttribute('aria-pressed',String(drawing));inkSettings.hidden=!drawing;draft.stage.classList.toggle('presenter-drawing',drawing);cancelStroke();
      if(drawing&&current?.pointer?.enabled)perform('setPointer',{...current.pointer,enabled:false});
    });
    listen(pointerButton,'click',()=>{if(!current)return;drawing=false;drawButton.setAttribute('aria-pressed','false');inkSettings.hidden=true;draft.stage.classList.toggle('presenter-drawing',false);cancelStroke();perform('setPointer',{...current.pointer,enabled:!current.pointer.enabled});});
    listen(presenterButton,'click',()=>{viewError='';try{Promise.resolve(options.openPresenterView()).catch(report);}catch(error){report(error);}});
    const syncFullscreen=()=>{const active=doc.fullscreenElement===surface;surface.classList.toggle('presenter-fullscreen',active);fullscreenButton.setAttribute('aria-pressed',String(active));fullscreenButton.setAttribute('aria-label',active?'Exit full screen presenter':'Full screen presenter');fullscreenButton.title=active?'Exit full screen presenter':'Full screen presenter';};
    listen(doc,'fullscreenchange',syncFullscreen);syncFullscreen();
    listen(fullscreenButton,'click',()=>{viewError='';try{const result=doc.fullscreenElement===surface?doc.exitFullscreen():surface.requestFullscreen();Promise.resolve(result).then(syncFullscreen,report);}catch(error){report(error);}});
    const changeZoom=()=>current&&perform('setZoom',{...current.zoom,mode:zoomMode.value,scale:zoomMode.value==='off'?1:Number(zoomSelect.value)});
    listen(zoomMode,'change',changeZoom);listen(zoomSelect,'change',changeZoom);
    listen(resetTools,'click',()=>{setMenu(false,true);if(!current)return;perform('setPointer',{enabled:false,x:.5,y:.5});perform('setZoom',{mode:'off',scale:1,x:.5,y:.5});});
    // Commit this exact session before a Close/repin can retire the editor.
    // Deferred generic actions must not carry a note into a replacement deck.
    const flushNotes=()=>{
      const state=controller.snapshot();
      if(destroyed||state.phase!=='ready'||state.sessionId!==noteSession||!state.slides?.[noteIndex]||state.slides[noteIndex].notes===notes.value)return;
      try{Promise.resolve(controller.setNotes(noteIndex,notes.value)).catch(report);}catch(error){report(error);}
    };
    listen(notes,'change',flushNotes);
    // Paired device keys are consumed before slider/menu/drag-handle handlers;
    // the native broker already owns the one authoritative Feed command.
    listen(doc,'keydown',event=>{
      if(options.ownsClickerKey?.(event)){event.preventDefault();event.stopImmediatePropagation();}
    },true);
    // Detached documents also catch ordinary keys with body focus. The host
    // separately routes navigation while the operator uses cues and layers.
    listen(options.detached?doc:surface,'keydown',event=>{
      if(options.ownsClickerKey?.(event)){event.preventDefault();event.stopImmediatePropagation();return;}
      if(!event.repeat&&!event.isComposing)controller.key(event);
    });
    if(options.detached){
      const keyboardHint=el('span','presenter-muted',canResize?'Clicker auto · SHOWAVE keys follow this deck':'Keyboard clicker: arrows advance Feed · Enter takes Preview');
      keyboardHint.classList.add('presenter-keyboard-hint');foot.appendChild(keyboardHint);
      try{surface.focus?.({preventScroll:true});}catch(error){}
    }
    listen(close,'click',()=>{if(options.closeView)options.closeView();else if(win&&(options.detached||win!==root))win.close();else controller.close();});
    function cancelStroke(){
      if(!stroke)return;const cancelled=stroke;stroke=null;
      try{draft.stage.releasePointerCapture?.(cancelled.pointerId);}catch(error){}
      if(!destroyed)paint(draft);
    }
    const inkPoint=event=>{
      const box=draft.canvas.getBoundingClientRect();if(!(box.width>0&&box.height>0))return null;
      const x=bounded((event.clientX-box.left)/box.width,0,1),y=bounded((event.clientY-box.top)/box.height,0,1);
      return mapFramePoint(x,y,draft.canvas.width,draft.canvas.height,{zoom:current.zoom});
    };
    const extendStroke=event=>{
      const point=inkPoint(event);if(!point||!stroke)return;
      const points=stroke.stroke.points,last=points.at(-1);if(last&&Math.hypot(point.x-last.x,point.y-last.y)<.001)return;
      points.push(point);if(points.length>512)stroke.stroke.points=points.filter((value,n)=>n===0||n===points.length-1||n%2===0);
      if(inkFrame!==null)return;const schedule=win.requestAnimationFrame?fn=>win.requestAnimationFrame(fn):fn=>win.setTimeout(fn,16);
      inkFrame=schedule(()=>{inkFrame=null;if(!destroyed&&stroke)paint(draft);});
    };
    listen(draft.stage,'pointerdown',event=>{
      if(!drawing||!current||current.phase!=='ready'||current.busy||draft.canvas.hidden||event.button!==0)return;
      const point=inkPoint(event);if(!point)return;event.preventDefault();event.stopPropagation();
      stroke={...inkTarget(),zoom:JSON.stringify(current.zoom),pointerId:event.pointerId,stroke:{points:[point],color:inkColor.value,width:Number(inkWidth.value)}};
      try{draft.stage.setPointerCapture?.(event.pointerId);}catch(error){}paint(draft);
    });
    listen(draft.stage,'pointerup',event=>{
      if(!stroke||stroke.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();extendStroke(event);
      const completed=stroke;stroke=null;try{draft.stage.releasePointerCapture?.(event.pointerId);}catch(error){}paint(draft);
      perform('appendInk',{sessionId:completed.sessionId,index:completed.index,revision:completed.revision,stroke:completed.stroke});
    });
    listen(draft.stage,'pointercancel',cancelStroke);listen(draft.stage,'lostpointercapture',cancelStroke);listen(win,'blur',cancelStroke);
    listen(draft.stage,'pointermove',event=>{
      if(stroke&&event.pointerId===stroke.pointerId){extendStroke(event);return;}
      if(drawing)return;
      if(!current||current.busy||current.phase!=='ready'||draft.canvas.hidden||!(current.pointer?.enabled||current.zoom?.mode==='lens'||current.zoom?.mode==='area'&&(event.buttons&1)))return;
      const box=draft.canvas.getBoundingClientRect();if(!(box.width>0&&box.height>0))return;
      let x=(event.clientX-box.left)/box.width,y=(event.clientY-box.top)/box.height;if(x<0||x>1||y<0||y>1)return;
      const z=current.zoom;
      if(z?.mode==='area'){
        const extent=1/z.scale,left=bounded(z.x-extent/2,0,1-extent),top=bounded(z.y-extent/2,0,1-extent);
        x=left+x*extent;y=top+y*extent;
      }
      pendingPointer={x,y,moveZoom:current.zoom?.mode==='lens'||current.zoom?.mode==='area'&&(event.buttons&1),sessionId:current.sessionId,index:current.draftIndex};
      if(pointerFrame!==null)return;
      const schedule=win.requestAnimationFrame?fn=>win.requestAnimationFrame(fn):fn=>win.setTimeout(fn,16);
      pointerFrame=schedule(()=>{
        pointerFrame=null;const value=pendingPointer;pendingPointer=null;
        if(destroyed||!value||!current||current.phase!=='ready'||current.busy||value.sessionId!==current.sessionId||value.index!==current.draftIndex)return;
        const actions=[];
        if(current.pointer?.enabled)actions.push(()=>perform('setPointer',{enabled:true,x:value.x,y:value.y}));
        if(value.moveZoom)actions.push(()=>perform('setZoom',{...current.zoom,x:value.x,y:value.y}));
        actions.reduce((previous,act)=>previous.then(act),Promise.resolve());
      });
    });
    const render=state=>{
      if(stroke&&(state.phase!=='ready'||state.busy||state.sessionId!==stroke.sessionId||state.draftIndex!==stroke.index||state.inkRevision!==stroke.revision||JSON.stringify(state.zoom)!==stroke.zoom))cancelStroke();
      current=state;const ready=state.phase==='ready',busy=!!state.busy,slides=state.slides||[];
      title.textContent=state.title||'Presenter';title.title=state.title||'Presenter';status.textContent=state.phase==='ready'?(busy?'Preparing…':'Pinned'):state.phase;
      surface.dataset.transport=state.transport||'stopped';surface.dataset.phase=state.phase;
      const media=state.media||{items:[],playing:false},hasMedia=!!media.items?.length;
      mediaBar.hidden=!hasMedia;mediaBar.title=media.error||'';
      mediaLabel.textContent=hasMedia?(media.error?'Media unavailable':media.playing?'Playing':media.items.every(item=>item.ended)?'Ended':'Media')+(media.items.every(item=>item.muted)?' · muted':''):'';
      for(const [action,button]of Object.entries(mediaButtons))button.disabled=!ready||busy||!hasMedia||
        (action==='play'&&media.playing)||(action==='pause'&&!media.playing);
      miniCount.textContent=state.onAirIndex==null?'No Feed':`${state.onAirIndex+1} / ${slides.length}`;
      draft.count.textContent=slides.length?`${state.draftIndex+1} / ${slides.length}`:'N/A';next.count.textContent=state.next?String(state.draftIndex+2):'N/A';feed.count.textContent=state.onAirIndex==null?'N/A':`${state.onAirIndex+1} / ${slides.length}`;
      const playingIndex=state.onAirIndex==null?state.draftIndex:state.onAirIndex;
      for(const [key,button]of Object.entries(buttons))button.disabled=!ready||busy||
        (['first','previous'].includes(key)&&playingIndex===0)||(['next','last'].includes(key)&&playingIndex>=slides.length-1)||
        (key==='play'&&state.transport==='playing')||(key==='pause'&&state.transport!=='playing');
      jump.disabled=timing.disabled=!ready||busy;pointerButton.disabled=zoomMode.disabled=resetTools.disabled=!ready||busy;zoomSelect.disabled=!ready||busy||state.zoom?.mode==='off';notes.disabled=!ready||busy;
      progress.disabled=!ready||busy;progress.max=String(Math.max(1,slides.length));progress.value=String(state.draftIndex+1);progress.setAttribute('aria-valuetext',`Preview slide ${state.draftIndex+1} of ${slides.length}; Feed ${state.onAirIndex==null?'off':state.onAirIndex+1}`);
      progressCount.textContent=slides.length?`Preview ${state.draftIndex+1}/${slides.length} · Feed ${state.onAirIndex==null?'N/A':state.onAirIndex+1}`:'No slides';
      drawButton.disabled=!ready||busy||typeof controller.appendInk!=='function';inkColor.disabled=inkWidth.disabled=!ready||busy;
      undoInk.disabled=clearInk.disabled=!ready||busy||!(state.ink?.length);presenterButton.disabled=!ready||busy;
      if(!ready)setMenu(false);zoomButton.setAttribute('aria-pressed',String(!!state.zoom&&state.zoom.mode!=='off'));
      if(doc.activeElement!==timing)timing.value=String(state.secondsPerSlide||8);
      pointerButton.setAttribute('aria-pressed',String(!!state.pointer?.enabled));
      showFrame(draft,state.current?.url||'',{pointer:state.pointer,zoom:state.zoom,ink:state.ink},slides.length?'Browse this slide to prepare its image.':'Pin a presentation from SHOWAVE.',state.draftIndex);
      showFrame(next,state.next?.url||'',{ink:state.nextInk},state.next?.title||(slides.length?'End of presentation':'N/A'),state.draftIndex+1);
      showFrame(feed,state.onAir?.url||'',{pointer:state.onAirPointer,zoom:state.onAirZoom,ink:state.onAirInk},state.onAirIndex==null?'No slide taken to the feed.':'Feed image is preparing.',state.onAirIndex);
      zoomMode.value=state.zoom?.mode||'off';zoomSelect.value=String(state.zoom?.mode==='off'?2:state.zoom?.scale||2);
      draft.stage.classList.toggle('presenter-tool-active',!!state.pointer?.enabled||state.zoom?.mode==='lens'||state.zoom?.mode==='area');
      const identity=state.sessionId+':'+slides.length;
      if(identity!==slideIdentity){
        slideIdentity=identity;strip.replaceChildren();jump.replaceChildren();rundown=[];
        slides.forEach((item,n)=>{
          const option=el('option','',`${n+1} · ${item.title}`);option.value=String(n);jump.appendChild(option);
          const button=el('button','presenter-thumbnail'),thumbnail=el('img'),label=el('span','',String(n+1)),thumbnailCanvas=el('canvas','presenter-thumbnail-canvas');
          button.type='button';button.title=item.title;button.setAttribute('aria-label','Browse slide '+(n+1)+': '+item.title);thumbnail.alt='';thumbnail.loading='lazy';thumbnail.draggable=false;
          if(thumbnailCanvas){thumbnailCanvas.width=128;thumbnailCanvas.height=72;thumbnailCanvas.hidden=true;thumbnailCanvas.setAttribute('aria-hidden','true');button.appendChild(thumbnailCanvas);button.appendChild(el('div','presenter-thumbnail-title',item.title));}
          if(item.media?.some(media=>media.type==='video')){const badge=el('span','presenter-media-badge','▶');badge.title='Video on this slide';badge.setAttribute('aria-hidden','true');button.appendChild(badge);}
          button.append(thumbnail,label);button.addEventListener('click',()=>perform('browse',n));strip.appendChild(button);rundown.push({button,image:thumbnail,canvas:thumbnailCanvas});
        });
      }
      rundown.forEach((row,n)=>{row.button.disabled=!ready||busy;row.button.classList.toggle('selected',n===state.draftIndex);row.button.classList.toggle('on-air',n===state.onAirIndex);
        row.button.setAttribute('aria-pressed',String(n===state.draftIndex));const url=slides[n]?.url||'';row.image.hidden=!url;if(url&&row.image.getAttribute('src')!==url)row.image.src=url;
        if(row.canvas){const frame=ready?(controller.thumbnail?.(n)||controller.frame?.(n)):null;
          if(frame&&row.source!==frame){const ctx=row.canvas.getContext('2d');if(ctx)try{ctx.clearRect(0,0,128,72);paintFrame(ctx,frame,128,72);row.source=frame;row.canvas.hidden=false;}catch(error){row.canvas.hidden=true;}}
          if(!row.canvas.hidden)row.image.hidden=true;
        }});
      jump.value=String(state.draftIndex||0);
      if(noteSession!==state.sessionId||noteIndex!==state.draftIndex||doc.activeElement!==notes){noteSession=state.sessionId;noteIndex=state.draftIndex||0;notes.value=state.current?.notes||'';}
      notice.textContent=viewError||state.error||(drawing?'Draw on Preview · drawings stay with this slide.':state.draftIndex===state.onAirIndex?'Player controls update Feed. Browse prepares a slide.':'Browse stages Preview; Take updates Feed.');
      surface.dataset.error=String(!!(viewError||state.error));
      clock.textContent=state.transport==='playing'?`Playing · ${state.secondsPerSlide}s`:(state.transport||'stopped');
      updateConfidence();
      updateMediaPaint();
    };
    const unsubscribe=controller.subscribe(render);
    surface.dataset.view='workspace';
    return {setViewLayout,setClickerState,destroy(){if(destroyed)return;flushNotes();endMove();destroyed=true;cancelStroke();unsubscribe();stopConfidence();stopMediaPaint();for(const row of rundown)if(row.canvas){row.canvas.width=row.canvas.height=1;}for(const row of [draft,next,feed])if(decodedSlides.get(row.url)===row.image)decodedSlides.delete(row.url);for(const frame of [pointerFrame,inkFrame])if(frame!==null){if(win.cancelAnimationFrame)win.cancelAnimationFrame(frame);else win.clearTimeout(frame);}if(doc.fullscreenElement===surface)try{Promise.resolve(doc.exitFullscreen()).catch(()=>{});}catch(error){}created.forEach(remove=>remove());surface.replaceChildren();}};
  }
  root.OpenLivePresenter=Object.freeze({create,connect,mount,keyboard,paintFrame,mapFramePoint,hasFrameTools,readConfidence,readSlideFrame,readSlideThumbnail,
    readSlideImage:url=>decodedSlides.get(String(url))||null,
    inheritTheme:(doc,source=root)=>copyTheme(source,doc),protocol:PROTOCOL});
})(window);
