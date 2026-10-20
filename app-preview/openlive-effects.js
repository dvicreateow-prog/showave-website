/* Broadcast adapter for the same pixel effects and generators used by Live.
   Serialisable scene settings stay separate from per-placement render buffers. */
window.OpenLiveEffects=(()=>{
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value)),own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const blends=()=>['Alpha'];
  const fx=()=>window.ArenaFX,gen=()=>window.ArenaSources;
  const contexts={Feedback:'Needs the Live composition feedback buffer.', 'Video Router':'Needs Live layer/composition routing.', 'Slice Outline':'Needs Live Advanced Output slices.'};
  const schemas=new Map(),catalogs=new Map(),frames=new WeakMap();let serial=0,clock=0,diagnostic=null;
  function object(raw,label){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid '+label+'.');}
  function finite(value,min,max,label){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(label+' must be between '+min+' and '+max+'.');return value;}
  function specs(role,name){
    const key=role+':'+name;if(schemas.has(key))return schemas.get(key);
    const raw=(role==='effect'?fx():gen())?.params(name);if(!Array.isArray(raw))return [];
    const result=raw.map(s=>{
      const kind=s.kind==='string'||s.node==='ParamText'?'text':s.kind||({ParamColor:'color',ParamChoice:'choice',Param:'bool'}[s.node])||'range',
        options=Array.isArray(s.options)?s.options.slice():undefined;
      let value=s.d==null?(kind==='color'?0xffffffff:kind==='text'?'':kind==='bool'||kind==='event'?false:kind==='choice'?options?.[0]:s.min??0):s.d;
      if(kind==='bool'||kind==='event')value=!!value;
      if(['text','image','resource'].includes(kind))value=String(value??'');
      if(kind==='choice'&&s.optionValues&&!options?.includes(value)){const i=s.optionValues.findIndex(v=>String(v)===String(value));if(i>=0)value=options[i];}
      return {key:s.path||s.n,label:s.n,group:s.group||null,kind,min:s.min??0,max:s.max??1,default:value,
        ...(options?{options,optionLabels:s.optionLabels||options.map(String)}:{}),unwired:s.unwired||null,
        multiplier:s.multiplier||1,suffix:s.suffix||'',precision:s.precision,defFrom:s.defFrom||null};
    });schemas.set(key,result);return result;
  }
  function catalog(role){
    if(catalogs.has(role))return catalogs.get(role);
    const engine=role==='effect'?fx():gen(),table=window.ArenaCatalog?.[role==='effect'?'videoEffects':'videoSources']||{},
      names=[...new Set([...Object.keys(table),...(role==='effect'?engine?.implemented?.():engine?.allImplemented?.())||[]])].sort();
    const result=names.map(name=>{
      const params=specs(role,name),resource=params.find(p=>['image','resource'].includes(p.kind));
      const reason=!engine?.has?.(name)?'This Live plug-in has no browser renderer.':
        (role==='generator'&&contexts[name]||role==='effect'&&engine.needs?.(name)||
        (resource?'Needs an image or LUT resource from the Live resource editor.':''));
      const cost=role==='effect'?engine?.cost?.(name):null;
      return {name,label:name,description:table[name]?.d||'',available:!reason,reason,
        warning:cost?'Performance intensive. May reduce frame rate at HD; use fewer effects or a lower output resolution if playback slows.':'',params:clone(params)};
    });catalogs.set(role,result);return result;
  }
  const effectCatalog=()=>clone(catalog('effect')),generatorCatalog=()=>clone(catalog('generator'));
  function record(role,name,available=false){const row=catalog(role).find(item=>item.name===name);if(!row)throw Error('Choose a known '+role+'.');if(available&&!row.available)throw Error(row.reason);return row;}
  function values(role,name,raw={}){
    object(raw,'parameter values');const schema=specs(role,name),keys=new Set(schema.map(s=>s.key));
    if(Object.keys(raw).some(key=>!keys.has(key)))throw Error('Unknown '+role+' parameter.');
    return Object.fromEntries(schema.map(s=>{
      const v=own(raw,s.key)?raw[s.key]:s.default;
      if(s.kind==='bool'||s.kind==='event'){if(typeof v!=='boolean')throw Error(s.label+' must be on or off.');}
      else if(s.kind==='color')finite(v,0,0xffffffff,s.label);
      else if(s.kind==='choice'){if(!s.options?.includes(v))throw Error('Choose an available '+s.label+' value.');}
      else if(['text','image','resource'].includes(s.kind)){if(typeof v!=='string'||v.length>4096)throw Error('Invalid '+s.label+'.');}
      else finite(v,s.min,s.max,s.label);
      return [s.key,v];
    }));
  }
  function defaultsEffect(name){record('effect',name,true);return {id:'bfx-'+Date.now().toString(36)+'-'+(++serial),name,bypassed:false,opacity:1,blend:'Alpha',params:values('effect',name)};}
  function normalizeEffects(raw=[]){
    if(!Array.isArray(raw)||raw.length>16)throw Error('A source supports up to 16 effects.');const ids=new Set();
    return raw.map(item=>{object(item,'effect');if(Object.keys(item).some(k=>!['id','name','bypassed','opacity','blend','params'].includes(k)))throw Error('Unknown effect setting.');
      record('effect',item.name);if(typeof item.id!=='string'||!item.id||item.id.length>100||ids.has(item.id))throw Error('Each effect needs an independent identity.');ids.add(item.id);
      if(typeof item.bypassed!=='boolean')throw Error('Invalid effect bypass.');if(item.blend!=='Alpha')throw Error('Only Alpha effect blending is available in Broadcast.');
      return {id:item.id,name:item.name,bypassed:item.bypassed,opacity:finite(item.opacity,0,1,'Effect opacity'),blend:'Alpha',params:values('effect',item.name,item.params)};
    });
  }
  function defaultsGenerator(name){record('generator',name,true);return {name,params:values('generator',name),width:1920,height:1080,duration:10,bpm:120};}
  function normalizeGenerator(raw){object(raw,'generator');if(Object.keys(raw).some(k=>!['name','params','width','height','duration','bpm'].includes(k)))throw Error('Unknown generator setting.');record('generator',raw.name);
    return {name:raw.name,params:values('generator',raw.name,raw.params),width:finite(raw.width??1920,16,4096,'Generator width'),height:finite(raw.height??1080,16,4096,'Generator height'),duration:finite(raw.duration??10,.1,3600,'Generator duration'),bpm:finite(raw.bpm??120,1,1000,'Generator BPM')};}
  function validateParameterPatch(role,name,patch){object(patch,'parameter patch');for(const s of specs(role,name))if(own(patch,s.key)&&s.unwired)throw Error(s.unwired);return true;}
  function compile(chain){return chain.map(item=>({name:item.name,bypassed:{value:item.bypassed},opacity:{value:item.opacity},blend:{value:'Alpha'},
    params:specs('effect',item.name).map(s=>({name:s.label,value:item.params[s.key]}))}));}
  function canvas(width,height){const c=document.createElement('canvas');c.width=Math.round(width);c.height=Math.round(height);return c;}
  function drawGenerator(cv,config,timeMs){const ctx=cv.getContext('2d');ctx.clearRect(0,0,cv.width,cv.height);
    const seconds=Math.max(0,timeMs)/1000,drawn=gen().draw(ctx,config.name,cv.width,cv.height,(seconds%config.duration)/config.duration,seconds*config.bpm/60,
      specs('generator',config.name).map(s=>config.params[s.key]),config.name);
    if(drawn===false){const status=gen().drawStatus?.(ctx,config.name);throw Error(config.name+': '+(status?.reason||'Generator failed to render.'));}
    return drawn;}
  function createGeneratorSource(raw){const config=normalizeGenerator(raw);record('generator',config.name,true);const el=canvas(config.width,config.height);drawGenerator(el,config,performance.now());
    return {kind:'generator',sourceType:'generator',label:config.name,config,el,audioOnly:false,audio:{included:false,reason:'Visual generator; no audio.'},dispose(){el.width=el.height=1;}};}
  function status(slot){
    if(slot.generator){const row=record('generator',slot.generator.name);if(!row.available)return {ok:false,reason:row.reason};}
    for(const effect of slot.effects||[])if(!effect.bypassed&&effect.opacity>0){const row=record('effect',effect.name);if(!row.available)return {ok:false,reason:row.reason};}
    const error=frames.get(slot)?.error;return {ok:!error,reason:error||''};
  }
  function render(slot,source,timeMs=performance.now(),{reuseFrame=false}={}){
    const active=(slot.effects||[]).some(effect=>!effect.bypassed&&effect.opacity>0);if(!slot.generator&&!active)return source;
    const state=status(slot);if(!state.ok&& !frames.get(slot)?.error)throw Error(state.reason);
    const w=slot.generator?.width||source.el.videoWidth||source.el.naturalWidth||source.el.width,
      h=slot.generator?.height||source.el.videoHeight||source.el.naturalHeight||source.el.height;if(!w||!h)return source;
    let runtime=frames.get(slot);if(!runtime){runtime={canvas:canvas(w,h),chain:compile(slot.effects||[]),error:null};frames.set(slot,runtime);}
    if(runtime.source===source.el&&runtime.canvas.width===w&&runtime.canvas.height===h&&runtime.time!==undefined&&(reuseFrame||runtime.time===timeMs)){
      if(runtime.error)throw Error(runtime.error);return {...source,el:runtime.canvas};
    }
    const cv=runtime.canvas;if(cv.width!==w)cv.width=w;if(cv.height!==h)cv.height=h;const ctx=cv.getContext('2d');
    runtime.source=source.el;runtime.time=timeMs;
    try{ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.filter='none';ctx.clearRect(0,0,w,h);
      if(slot.generator)drawGenerator(cv,slot.generator,timeMs);else ctx.drawImage(source.el,0,0,w,h);
      runtime.error=null;
      if(active){clock=timeMs/1000;diagnostic=null;fx().setClockProvider(()=>clock);fx().setDiagnosticObserver(record=>{if(record.kind==='draw-error')diagnostic=record.effect+': '+record.message;});
        fx().apply(ctx,runtime.chain,w,h,(clock%10)/10,clock*2,param=>param.value);runtime.error=diagnostic;
        if(diagnostic)throw Error(diagnostic);}
    }catch(error){runtime.error=error.message||String(error);throw error;}
    return {...source,el:cv};
  }
  return Object.freeze({effectCatalog,generatorCatalog,blends,blendModes:Object.freeze(blends()),defaultsEffect,normalizeEffects,defaultsGenerator,normalizeGenerator,validateParameterPatch,createGeneratorSource,render,status});
})();
