/* Shared production font catalog and selected-face loader. Bundled fonts work
 * offline. Online font metadata and binaries are fetched only after selection;
 * an unavailable font rejects before a preview can claim it has rendered it.
 * Fontsource metadata/licensing and refresh: FONT-CATALOG.md. */
window.OpenLiveFontAssets = (() => {
  'use strict';
  const scriptUrl = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  const assets = Object.freeze({
    'League Spartan': scriptUrl ? new URL('assets/fonts/league-spartan-latin.woff2', scriptUrl).href : 'assets/fonts/league-spartan-latin.woff2'
  });
  const licenses = new Set(['OFL-1.1','Apache-2.0','UFL-1.0','CC0-1.0','mit','Unlicense']);
  const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 100 && !/[\x00-\x1f"'\\;{}]/.test(name);
  const fallback = category => category === 'serif' ? 'serif' : category === 'monospace' ? 'monospace' : 'sans-serif';
  const freezeRecord = value => Object.freeze({...value,
    weights:Object.freeze(value.weights.slice()), styles:Object.freeze(value.styles.slice()), subsets:Object.freeze(value.subsets.slice())});
  const local = freezeRecord({id:'league-spartan',name:'League Spartan',label:'League Spartan',family:'"League Spartan", Arial, sans-serif',
    source:'bundled',category:'sans-serif',license:'OFL-1.1',weights:[100,200,300,400,500,600,700,800,900],styles:['normal'],subsets:['latin'],variable:true});
  const online = (window.OpenLiveFontCatalog?.rows || []).filter(row => Array.isArray(row) && /^[a-z0-9-]+$/.test(row[0]) && safeName(row[1]) && licenses.has(row[3]))
    .map(row => freezeRecord({id:'fontsource:'+row[0],providerId:row[0],name:row[1],label:row[1],family:'"'+row[1]+'", '+fallback(row[2]),source:'fontsource',
      category:row[2],license:row[3],weights:row[4],styles:row[5],subsets:row[6],defaultSubset:row[7],variable:!!row[8]}));
  const records = Object.freeze([local,...online]);
  const byId = new Map(records.map(record => [record.id,record]));
  const byName = new Map(online.map(record => [record.name,record])); byName.set(local.name,local);
  const system = new Set(['system-ui','Arial','Arial Unicode MS','Verdana','Georgia','Times New Roman','Courier New','Avenir','Baskerville',
    'Century Gothic','Franklin Gothic','Futura','Garamond','Gill Sans','Helvetica','Impact','Lucida Sans','Optima','Palatino','Rockwell','Segoe UI','Tahoma','Trebuchet MS']);
  const metadata = new Map(), variants = new Map(), statuses = new Map();
  const DEFAULT_TEXT = 'SHOWAVE QR CODE 0123456789';
  function record(value) { return byId.get(value) || byName.get(value) || null; }
  function catalog() { return records; }
  function search(query = '', options = {}) {
    const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Number.isInteger(options.limit) ? Math.max(1,Math.min(200,options.limit)) : 80;
    return records.filter(item => (!options.category || item.category === options.category) &&
      words.every(word => (item.name+' '+item.category+' '+item.subsets.join(' ')).toLowerCase().includes(word))).slice(0,limit);
  }
  function status(value) {
    const item = record(value), key = item?.id || value;
    return {...(statuses.get(key) || {state:system.has(value)?'system':'idle',family:item?.name || value,error:''})};
  }
  // Callers cannot inject a CSS family or a URL. Families always come from the
  // checked-in catalog and URL components from validated provider metadata.
  function request(value, weight, options) {
    const item = record(value);
    if (!item && !system.has(value)) throw Error('That font is not in the SHOWAVE font catalog.');
    const number = Number(weight);
    if (!Number.isFinite(number) || number < 1 || number > 1000) throw RangeError('Font weight must be between 1 and 1000.');
    const style = options.style || 'normal';
    if (!['normal','italic'].includes(style)) throw Error('Font style must be normal or italic.');
    const text = options.text === undefined ? DEFAULT_TEXT : String(options.text);
    if (text.length > 10000) throw Error('Font readiness text is too long.');
    const timeout = options.timeout === undefined ? 12000 : options.timeout;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) throw RangeError('Font timeout must be between 1 and 60000 ms.');
    return {item,name:item?.name || value,weight:number,style,text,timeout,active:true};
  }
  function bounded(work, milliseconds, message) {
    return new Promise((resolve,reject) => {
      let finished=false;
      const timer=setTimeout(()=>{if(!finished){finished=true;reject(Error(message));}},milliseconds);
      Promise.resolve(work).then(value=>{if(!finished){finished=true;clearTimeout(timer);resolve(value);}},error=>{
        if(!finished){finished=true;clearTimeout(timer);reject(error);}
      });
    });
  }
  function fontMetadata(item) {
    if (metadata.has(item.id)) return metadata.get(item.id);
    if (typeof fetch !== 'function') return Promise.reject(Error('Online fonts are unavailable in this browser.'));
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(()=>abort?.abort(),12000);
    const pending = bounded(fetch('https://api.fontsource.org/v1/fonts/'+item.providerId,{credentials:'omit',referrerPolicy:'no-referrer',...(abort?{signal:abort.signal}:{})})
      .then(response=>{if(!response.ok)throw Error('Font metadata HTTP '+response.status);return response.json();})
      .then(data=>{
        if (!data || data.id !== item.providerId || data.family !== item.name || !licenses.has(data.license) ||
          !/^\d+\.\d+\.\d+$/.test(data.npmVersion) || !data.variants || typeof data.variants !== 'object')
          throw Error('The font provider returned invalid font metadata.');
        return data;
      }),12000,'The online font metadata request timed out.').finally(()=>clearTimeout(timer));
    metadata.set(item.id,pending);
    pending.catch(()=>{if(metadata.get(item.id)===pending)metadata.delete(item.id);});
    return pending;
  }
  function nearestWeight(weights, wanted) {
    // CSS Fonts weight matching: 400..500 first searches towards 500; below
    // 400 first searches lighter; above 500 first searches heavier.
    const values=weights.slice().sort((a,b)=>a-b);
    if(wanted>=400&&wanted<=500)return values.find(value=>value>=wanted&&value<=500) ?? values.slice().reverse().find(value=>value<wanted) ?? values.find(value=>value>500);
    return wanted<400 ? values.slice().reverse().find(value=>value<=wanted) ?? values.find(value=>value>wanted)
      : values.find(value=>value>=wanted) ?? values.slice().reverse().find(value=>value<wanted);
  }
  function safeRange(value) { return typeof value==='string' && /^U\+[0-9A-F?]+(?:-[0-9A-F]+)?(?:,\s*U\+[0-9A-F?]+(?:-[0-9A-F]+)?)*$/i.test(value); }
  function refreshFaces(selected, fonts) {
    for(const entry of selected.faces) {
      if(entry.face && entry.face.status !== 'error')continue;
      if(entry.face)fonts.delete?.(entry.face);
      entry.face=new FontFace(selected.family,entry.source,entry.descriptors);fonts.add(entry.face);
    }
    selected.defaultFace=selected.faces.find(entry=>entry.subset===selected.defaultSubset)?.face || selected.faces[0].face;
    return selected;
  }
  function discardFailedFaces(selected,fonts) {
    for(const entry of selected.faces)if(entry.face?.status==='error'){fonts.delete?.(entry.face);entry.face=null;}
  }
  function ownedFaces(req, data, fonts) {
    const available = Object.keys(data.variants).map(Number).filter(value=>Number.isInteger(value)&&value>=1&&value<=1000);
    const weight = nearestWeight(available,req.weight);
    const variantsAtWeight=data.variants[weight];
    const style=variantsAtWeight?.[req.style]?req.style:variantsAtWeight?.normal?'normal':variantsAtWeight?.italic?'italic':'';
    const subsets=variantsAtWeight?.[style];
    if(!subsets || typeof subsets !== 'object') throw Error('That font has no usable regular face.');
    const key=req.item.id+':'+weight+':'+style;
    if(variants.has(key))return refreshFaces(variants.get(key),fonts);
    const faces=[];
    for(const subset of Object.keys(subsets)) {
      if(!/^[a-z0-9-]+$/.test(subset))throw Error('Invalid font subset.');
      // Never follow a metadata-supplied URL. An exact package version makes
      // selected face URLs immutable and reusable from the browser cache.
      const url='https://cdn.jsdelivr.net/fontsource/fonts/'+req.item.providerId+'@'+data.npmVersion+'/'+subset+'-'+weight+'-'+style+'.woff2';
      const range=data.unicodeRange?.[subset];
      if(range !== undefined && !safeRange(range))throw Error('Invalid font Unicode range.');
      const source='url("'+url+'") format("woff2")',descriptors={style,weight:String(weight),display:'block',...(range?{unicodeRange:range}:{})};
      const face=new FontFace(req.name,source,descriptors);
      fonts.add(face);faces.push({face,subset,source,descriptors});
    }
    if(!faces.length)throw Error('The selected font has no available subsets.');
    const result={faces,weight,style,version:data.npmVersion,family:req.name,defaultSubset:data.defSubset||req.item.defaultSubset,
      defaultFace:(faces.find(entry=>entry.subset===(data.defSubset||req.item.defaultSubset))||faces[0]).face};
    variants.set(key,result);return result;
  }
  function localFaces(req, fonts) {
    const key='bundled:'+req.name;
    if(variants.has(key))return refreshFaces(variants.get(key),fonts);
    const source='url("'+assets[req.name]+'") format("woff2")',descriptors={style:'normal',weight:'100 900',display:'block'};
    const face=new FontFace(req.name,source,descriptors);
    fonts.add(face);const result={faces:[{face,subset:'latin',source,descriptors}],defaultFace:face,weight:req.weight,style:'normal',version:'bundled',family:req.name,defaultSubset:'latin'};
    variants.set(key,result);return result;
  }
  async function load(req) {
    if(!req.item)return {family:req.name,state:'system',source:'system',error:''};
    const fonts=typeof document !== 'undefined' && document.fonts;
    if(!fonts || typeof fonts.load !== 'function' || typeof fonts.add !== 'function' || typeof FontFace !== 'function')
      throw Error('This browser cannot load a selected font before rendering.');
    const data=req.item.source==='bundled'?null:await fontMetadata(req.item);
    if(!req.active)throw Error('The font request was cancelled after timing out.');
    const selected=req.item.source==='bundled'?localFaces(req,fonts):ownedFaces(req,data,fonts);
    // defaultFace.load proves the requested family really loaded; check() can
    // report true when all missing glyphs would merely use a system fallback.
    try {
      await selected.defaultFace.load();
      if(!req.active)throw Error('The font request was cancelled after timing out.');
      await fonts.load(req.style+' '+req.weight+' 20px "'+req.name+'"',req.text);
      if(selected.defaultFace.status && selected.defaultFace.status !== 'loaded')throw Error('The selected font did not finish loading.');
    } catch(error) { discardFailedFaces(selected,fonts);throw error; }
    return {family:req.name,state:'ready',source:req.item.source,error:'',weight:req.item.source==='bundled'?Math.max(100,Math.min(900,req.weight)):selected.weight,
      style:selected.style,version:selected.version};
  }
  function ensure(value, weight='700', options={}) {
    let req;try { req=request(value,weight,options||{}); } catch(error) { return Promise.reject(error); }
    const key=req.item?.id || value;
    if(req.item)statuses.set(key,{family:req.name,state:'loading',source:req.item.source,error:''});
    return bounded(load(req),req.timeout,'The '+req.name+' font timed out. Check the connection and retry.').then(result=>{
      statuses.set(key,result);return {...result};
    },error=>{
      req.active=false;
      const detail='The '+req.name+' font could not be loaded'+(req.item?.source==='fontsource'?' online':'')+': '+(error.message||error);
      statuses.set(key,{family:req.name,state:'failed',source:req.item?.source||'system',error:detail});throw Error(detail);
    });
  }
  return Object.freeze({assets,catalog,search,record,status,ensure});
})();
