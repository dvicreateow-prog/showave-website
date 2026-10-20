/* Editable artwork sources. Canvases and clocks are runtime-only; the Studio
   render loop supplies dynamic frames. This module never opens files, uploads,
   stores assets, or starts background intervals. */
window.OpenLiveCreativeSources=(()=>{
  'use strict';
  const TYPES=Object.freeze(['lower-third','ticker','countdown','qr','product-card','sports','audience']);
  const isCreative=type=>TYPES.includes(type);
  const color=(value,fallback,transparent=false)=>{
    const result=value??fallback;
    if(transparent&&result==='transparent')return result;
    if(typeof result!=='string'||!/^#[0-9a-f]{6}$/i.test(result))throw Error('Choose a valid six-digit color.');
    return result;
  };
  const text=(value,fallback,limit,required=false,multiline=false)=>{
    const result=value??fallback;
    if(typeof result!=='string'||result.length>limit||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/:/[\u0000-\u001f]/).test(result)||required&&!result.trim())
      throw Error('Enter '+(required?'1–':'at most ')+limit+' characters.');
    return result;
  };
  const number=(value,fallback,min,max,integer=false)=>{
    const result=Number(value??fallback);
    if(!Number.isFinite(result)||result<min||result>max||integer&&!Number.isInteger(result))throw Error('Enter '+(integer?'a whole number':'a number')+' between '+min+' and '+max+'.');
    return result;
  };
  function destination(value){
    const result=text(value,'https://example.com',1024,true).trim();
    let url;try{url=new URL(result);}catch(_){throw Error('Enter a complete HTTP or HTTPS destination.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Use an HTTP or HTTPS destination without credentials.');
    return result;
  }
  function normalize(type,raw={}){
    if(type==='audience'){
      if(!window.OpenLiveAudience?.normalize)throw Error('The Audience source renderer is unavailable.');
      return window.OpenLiveAudience.normalize(raw);
    }
    if(type==='sports'){
      if(!window.OpenLiveSportsSources?.normalize)throw Error('The sports source renderer is unavailable.');
      return window.OpenLiveSportsSources.normalize(raw);
    }
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid source settings.');
    const definition=window.OpenLiveTemplateSources?.resolveCreative(type,raw.templateId);
    if(!definition)throw Error('The shared template source definitions are unavailable.');
    const defaults=definition.defaults,native=definition.authoredExtension!==true,
      template=native?{templateId:definition.templateId}:{},legacy=native&&!raw.templateId,
      font=legacy&&raw.size===64?defaults.size:raw.size,
      ink=legacy&&raw.color==='#ffffff'?defaults.color:raw.color;
    const overflow=()=>{const mode=raw.overflow??(type==='ticker'&&raw.speed===0?'clip':defaults.overflow);
      if(!['scroll','clip'].includes(mode))throw Error('Choose Scroll or Clip for text overflow.');
      return {overflow:mode,overflowSpeed:number(raw.overflowSpeed??(type==='ticker'&&raw.speed!==0?raw.speed:undefined),defaults.overflowSpeed,1,600)};};
    switch(type){
      case 'lower-third':return {...template,line1:text(raw.line1,defaults.line1,160,true),line2:text(raw.line2,defaults.line2,200),
        color:color(ink,defaults.color),size:number(font,defaults.size,4,120),...overflow()};
      case 'ticker':return {...template,text:text(raw.text,defaults.text,500,true,true),color:color(ink,defaults.color),
        background:color(legacy&&raw.background==='#15325b'?undefined:raw.background,defaults.background),size:number(font,defaults.size,4,120),...overflow()};
      case 'countdown':return {duration:number(raw.duration,defaults.duration,1,3600,true),color:color(raw.color,defaults.color),
        background:color(raw.background,defaults.background,true),size:number(raw.size,defaults.size,36,200)};
      case 'qr':return {...template,url:destination(raw.url),label:text(raw.label,defaults.label,120),
        foreground:color(legacy&&raw.foreground==='#111827'?undefined:raw.foreground,defaults.foreground),background:color(legacy&&raw.background==='#ffffff'?undefined:raw.background,defaults.background),...overflow()};
      case 'product-card':return {title:text(raw.title,defaults.title,160,true),price:text(raw.price,defaults.price,80),description:text(raw.description,defaults.description,600,false,true),
        url:destination(raw.url),foreground:color(raw.foreground,defaults.foreground),background:color(raw.background,defaults.background),accent:color(raw.accent,defaults.accent)};
      default:throw Error('This creative source type is unavailable.');
    }
  }
  function fixedText(ctx,value,box,size,weight=600,align='left'){
    ctx.save();try{
      ctx.beginPath();ctx.rect(box.x,box.y-box.h/2,box.w,box.h);ctx.clip();
      ctx.font=weight+' '+size+'px sans-serif';ctx.textAlign=align;
      ctx.fillText(value,box.x+(align==='center'?box.w/2:0),box.y);
    }finally{ctx.restore();}
  }
  function wrapped(ctx,value,x,y,width,lineHeight,maxLines){
    const words=value.split(/\s+/),lines=[];let line='';
    for(const word of words){const next=line?line+' '+word:word;if(line&&ctx.measureText(next).width>width){lines.push(line);line=word;}else line=next;}
    if(line)lines.push(line);
    ctx.save();try{
      ctx.beginPath();ctx.rect(x,y-lineHeight/2,width,lineHeight*maxLines);ctx.clip();
      lines.slice(0,maxLines).forEach((row,index)=>ctx.fillText(row,x,y+index*lineHeight));
    }finally{ctx.restore();}
  }
  function matrixFor(config){
    const encode=window.OpenLiveCommerce?.qrMatrix;
    if(typeof encode!=='function')throw Error('The local QR encoder is unavailable.');
    const matrix=encode(config.url);
    if(!matrix||!Number.isInteger(matrix.size)||matrix.size<1||matrix.size>177||matrix.cells?.length!==matrix.size*matrix.size)
      throw Error('The QR encoder returned an invalid matrix.');
    return matrix;
  }
  function drawMatrix(ctx,matrix,x,y,extent,foreground,background){
    const quiet=4,cell=Math.floor(extent/(matrix.size+quiet*2)),total=cell*(matrix.size+quiet*2);
    if(cell<1)throw Error('The QR destination is too detailed for this source.');
    x=Math.round(x+(extent-total)/2);y=Math.round(y+(extent-total)/2);
    ctx.fillStyle=background;ctx.fillRect(x,y,total,total);ctx.fillStyle=foreground;
    for(let row=0;row<matrix.size;row++)for(let col=0;col<matrix.size;col++)if(matrix.cells[row*matrix.size+col])
      ctx.fillRect(x+(col+quiet)*cell,y+(row+quiet)*cell,cell,cell);
  }
  function nativeRenderer(type,config,definition,doc,el,ctx){
    const module=window.OpenLiveFullTemplates;
    if(!module?.get||!module?.loadPart||!module?.drawPart||!module?.normalizePartStyle)
      throw Error('The native SVG part renderer is unavailable.');
    const template=module.get(definition.templateId),board={width:template.width,height:template.height},bounds=definition.bounds,
      crop={x:Math.floor(bounds.x*board.width+1e-6),y:Math.floor(bounds.y*board.height+1e-6)};
    crop.w=Math.ceil((bounds.x+bounds.w)*board.width-1e-6)-crop.x;
    crop.h=Math.ceil((bounds.y+bounds.h)*board.height-1e-6)-crop.y;
    el.width=crop.w;el.height=crop.h;
    const component=id=>template.components.find(item=>item.id===id),parts=definition.componentIds.map(id=>{
      const item=component(id),style={},change={};
      if(type==='lower-third'&&id===definition.primaryComponentId){
        const value=[config.line1,config.line2].filter(Boolean).join(' · ');
        if(value!==item.defaultText)change.text=value;
        if(config.color!==item.defaultTextColor)change.textColor=config.color;
        if(config.size!==item.defaultFontSize)change.fontSize=config.size;
      }else if(type==='ticker'){
        if(id==='ticker-text')Object.assign(change,{text:config.text.replace(/\s+/g,' '),textColor:config.color,fontSize:config.size});
        if(id==='ticker-backplate'&&config.background!==definition.defaults.background)style.ticker=config.background;
      }else if(type==='qr'){
        if(id==='qr')change.target=config.url;
        if(id==='qr-label'&&config.label!==item.defaultText)Object.assign(change,{text:config.label,textColor:config.foreground});
        if(['qr-label','qr-instruction'].includes(id)&&config.foreground!==definition.defaults.foreground)style.foreground=config.foreground;
        if(id==='qr-frame'&&config.background!==definition.defaults.background)style.accent=config.background;
      }
      if(change.text!==undefined||change.fontSize!==undefined||change.textColor!==undefined)
        Object.assign(change,{overflow:config.overflow,overflowSpeed:config.overflowSpeed});
      if(Object.keys(change).length)style.components={[id]:change};
      return {id,style:module.normalizePartStyle(template.id,id,style)};
    });
    const dynamicParts=parts.filter(part=>part.style.components?.[part.id]?.text!==undefined);
    let baseCanvas=null,ready=false,pending=null,released=false,animated=false;
    function draw(part,targetCtx,renderOptions){const result=module.drawPart(template.id,part.id,targetCtx,board,part.style,undefined,renderOptions);if(result?.state!=='drawn')throw Error(result?.error||'The native template source has not been prepared.');}
    function prepare(){
      if(released)throw Error('Source preparation cancelled.');
      if(pending)return pending;
      pending=Promise.all(parts.map(part=>module.loadPart(template.id,part.id,{style:part.style}))).then(()=>{
        if(released)throw Error('Source preparation cancelled.');
        if(dynamicParts.length){
          baseCanvas=doc.createElement('canvas');baseCanvas.width=crop.w;baseCanvas.height=crop.h;
          const baseCtx=baseCanvas.getContext('2d');baseCtx.save();try{baseCtx.translate(-crop.x,-crop.y);
            parts.filter(part=>!dynamicParts.includes(part)).forEach(part=>draw(part,baseCtx));}finally{baseCtx.restore();}
          animated=dynamicParts.some(part=>part.style.components[part.id].overflow==='scroll'&&
            (typeof module.textLayout!=='function'||module.textLayout(template.id,part.id,part.style).overflows));
        }
        ready=true;
      });return pending;
    }
    function paint(at,anchor){
      if(!ready)return false;
      ctx.clearRect(0,0,el.width,el.height);ctx.save();try{
        if(baseCanvas)ctx.drawImage(baseCanvas,0,0);
        ctx.translate(-crop.x,-crop.y);
        if(!baseCanvas)parts.forEach(part=>draw(part,ctx));
        else dynamicParts.forEach(part=>draw(part,ctx,{timeMs:at,anchorMs:anchor}));
      }finally{ctx.restore();}return true;
    }
    return {prepare,paint,dispose(){released=true;if(baseCanvas)baseCanvas.width=baseCanvas.height=1;baseCanvas=null;},get ready(){return ready;},get dynamic(){return animated;}};
  }
  function create(type,raw={},options={}){
    if(type==='audience'){
      if(!window.OpenLiveAudience?.create)throw Error('The Audience source renderer is unavailable.');
      return window.OpenLiveAudience.create(raw,options);
    }
    if(type==='sports'){
      if(!window.OpenLiveSportsSources?.create)throw Error('The sports source renderer is unavailable.');
      return window.OpenLiveSportsSources.create(raw,options);
    }
    const config=Object.freeze(normalize(type,raw)),doc=options.document||document,
      definition=window.OpenLiveTemplateSources.resolveCreative(type,config.templateId),native=definition.authoredExtension!==true,
      now=options.now||(()=>performance.now()),el=doc.createElement('canvas');
    el.width=definition.width;el.height=definition.height;
    const ctx=el.getContext('2d');if(!ctx)throw Error('The creative source canvas is unavailable.');
    const renderer=native?nativeRenderer(type,config,definition,doc,el,ctx):null,width=el.width,height=el.height,
      matrix=type==='product-card'?matrixFor(config):null;
    let disposed=false,lastFrame=null,anchor=options.anchor??now(),revision=0,preparation=null,preparationError='';
    let remainingMs=options.countdownState?.remainingMs??(config.duration||0)*1000,
      timerMode=options.countdownState?.mode||'paused',runningSince=now();
    const remaining=at=>timerMode==='running'?Math.max(0,remainingMs-Math.max(0,at-runningSince)):remainingMs;
    const timerState=()=>{
      const value=remaining(now());if(timerMode==='running'&&value===0){timerMode='finished';remainingMs=0;}
      return {state:timerMode,remainingSeconds:value/1000,durationSeconds:config.duration};
    };
    function renderFrame(timeMs=now()){
      if(disposed)return false;
      if(renderer&&!renderer.ready)return false;
      const at=Number.isFinite(timeMs)&&timeMs>=0?timeMs:now(),value=type==='countdown'?remaining(at):0;
      const frame=renderer?.dynamic?Math.floor(at/definition.motion.frameMs):type==='countdown'?Math.ceil(value/1000):'static';
      if(frame===lastFrame)return false;
      if(renderer){try{const painted=renderer.paint(at,anchor);if(painted)lastFrame=frame;return painted;}
        catch(error){preparationError=error.message||String(error);throw error;}}
      ctx.clearRect(0,0,width,height);
      const background=config.background;
      if(background!=='transparent'){ctx.fillStyle=background;ctx.fillRect(0,0,width,height);}
      ctx.textAlign='left';ctx.textBaseline='middle';
      if(type==='countdown'){
        const seconds=Math.ceil(value/1000),label=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
        const box=definition.textBox;ctx.fillStyle=config.color;fixedText(ctx,label,box,config.size,700,'center');
      }else{
        const accent=definition.accentRect,title=definition.titleBox,price=definition.priceBox,description=definition.descriptionBox,qr=definition.qrBox;
        ctx.fillStyle=config.accent;ctx.fillRect(accent.x,accent.y,accent.w,accent.h);ctx.fillStyle=config.foreground;
        fixedText(ctx,config.title,title,title.size,700);
        if(config.price){ctx.fillStyle=config.accent;fixedText(ctx,config.price,price,price.size,700);}
        ctx.fillStyle=config.foreground;ctx.font='400 '+description.size+'px sans-serif';wrapped(ctx,config.description,description.x,config.price?description.priceY:description.y,description.w,description.lineHeight,description.maxLines);
        drawMatrix(ctx,matrix,qr.x,qr.y,qr.w,qr.foreground,qr.background);
      }
      lastFrame=frame;return true;
    }
    const controls=type==='countdown'?{
      state:timerState,
      get revision(){return revision;},
      start(){if(disposed)return false;const value=remaining(now());remainingMs=value>0?value:config.duration*1000;runningSince=now();timerMode='running';revision++;lastFrame=null;renderFrame();return true;},
      pause(){if(disposed)return false;remainingMs=remaining(now());timerMode=remainingMs>0?'paused':'finished';revision++;lastFrame=null;renderFrame();return true;},
      reset(){if(disposed)return false;remainingMs=config.duration*1000;timerMode='paused';revision++;lastFrame=null;renderFrame();return true;}
    }:null;
    const runtime={kind:'text',sourceType:type,config,_sourceConfig:{...config},el,templateDefinition:definition,
      initialTransform:{...definition.bounds,rotation:0},renderFrame,
      runtimeStatus:()=>disposed?{ok:false,state:'ended',why:'The creative source has been released.'}:preparationError?{ok:false,state:'failed',why:preparationError}:
        renderer&&!renderer.ready?{ok:false,state:'loading',why:'Preparing the native template source.'}:{ok:true,state:'ready'},
      prepare(){if(preparation)return preparation;preparation=Promise.resolve().then(()=>renderer?.prepare()).then(()=>{if(disposed)throw Error('Source preparation cancelled.');lastFrame=null;renderFrame();return runtime;}).catch(error=>{preparationError=error.message||String(error);throw error;});return preparation;},
      ...(controls?{creativeControls:controls}:{}),
      forkProgramme(){if(disposed)throw Error('This creative source is unavailable.');return create(type,config,{document:doc,now,anchor,
        ...(controls?{countdownState:{mode:timerState().state,remainingMs:remaining(now())}}:{})});},
      dispose(){if(disposed)return;disposed=true;renderer?.dispose();el.width=el.height=1;el.remove?.();}};
    renderFrame();return runtime;
  }
  const fork=async runtime=>{if(typeof runtime?.forkProgramme!=='function')throw Error('The creative source cannot be prepared for Programme.');const next=runtime.forkProgramme();try{await next.prepare();return next;}catch(error){next.dispose();throw error;}};
  return Object.freeze({TYPES,isCreative,normalize,create,fork});
})();
