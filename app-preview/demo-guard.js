/* The actual SHOWAVE frontend runs inside an opaque, website-only sandbox.
 * This boundary is loaded before every original app script. No account, device,
 * local file, recovery database or production output is available here. */
(function websitePreviewBoundary(global) {
  'use strict';
  if (global.OpenLiveWebsitePreview) return;
  const routes = Object.freeze({live:'live.html',broadcast:'broadcast.html',map:'advanced-output.html',grid:'grid-tool.html',gsl5:'gsl5.html',timeline:'timeline.html',forge:'wire.html',chaser:'chaser.html',encode:'alley.html'});
  const parameters = new URLSearchParams(global.location.search);
  const currentFile = global.location.pathname.split('/').pop();
  const requested = parameters.get('workspace');
  const previewToken = parameters.get('previewToken') || '';
  const workspace = routes[requested] ? requested : Object.keys(routes).find(key => routes[key] === currentFile) || 'live';
  const status = { workspace, version:'0.1.0-preview.14', limitedActions:true, source:'actual-installed-frontend', blocked:0 };
  // A direct top-level request must never run this package outside its sandbox.
  if (global.parent === global || global.origin !== 'null') {
    global.stop();
    global.document.open();
    global.document.write('<!doctype html><title>SHOWAVE preview</title><p>Open this interface preview from the <a href="/">SHOWAVE website</a>.</p>');
    global.document.close();
    return;
  }
  if (currentFile === 'index.html' || !currentFile) {
    const target=new URL(routes[workspace],global.location.href);target.searchParams.set('workspace',workspace);if(previewToken)target.searchParams.set('previewToken',previewToken);global.location.replace(target.href);
    return;
  }
  Object.defineProperty(global, 'OpenLiveWebsitePreview', { value:Object.freeze({...status}) });
  const message = 'This is the actual SHOWAVE interface in a website preview. Files, devices, accounts and physical outputs are available in the installed app.';
  let noticeTimer;
  function notice(text = message) {
    status.blocked++;
    let node = document.getElementById('showave-preview-notice');
    if (!node && document.body) { node=document.createElement('div'); node.id='showave-preview-notice'; node.setAttribute('role','status'); document.body.append(node); }
    if (node) { node.textContent=text; node.hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>{node.hidden=true;},6000); }
    try { global.parent.postMessage({type:'showave-preview-action-limited',workspace,previewToken,text}, '*'); } catch (_) {}
  }
  const denial = () => new DOMException('Unavailable in the SHOWAVE website preview.', 'NotAllowedError');
  const reject = () => { notice(); return Promise.reject(denial()); };
  function define(target, key, value) { try { Object.defineProperty(target,key,{value,writable:false,configurable:true}); } catch (_) {} }
  function memoryStorage() {
    const values = new Map();
    const api = { get length(){return values.size;}, key(index){return [...values.keys()][index] ?? null;}, getItem(key){return values.get(String(key)) ?? null;}, setItem(key,value){values.set(String(key),String(value));}, removeItem(key){values.delete(String(key));}, clear(){values.clear();} };
    return new Proxy(api,{get(target,key){return key in target ? target[key] : values.get(String(key));},set(target,key,value){values.set(String(key),String(value));return true;}});
  }
  // Configurable: the unchanged original session policy installs its own RAM store next.
  for (const name of ['localStorage','sessionStorage']) { const storage=memoryStorage(); try { Object.defineProperty(global,name,{get:()=>storage,configurable:true}); } catch (_) {} }
  define(global,'indexedDB',undefined); define(global,'caches',undefined);
  define(global,'OpenLiveDesktop',undefined);
  class LocalChannel extends EventTarget { constructor(){super();this.onmessage=null;} postMessage(){} close(){} }
  define(global,'BroadcastChannel',LocalChannel);
  // Fetch resolves only the static, public catalogs copied from the verified release.
  // CSP connect-src none independently prevents all real fetch/XHR/socket traffic.
  define(global,'fetch',async function previewFetch(input) {
    let url;
    try { url=new URL(typeof input==='string'||input instanceof URL ? input : input.url,global.location.href); } catch (_) { throw denial(); }
    const prefix=new URL('.',global.location.href).pathname;
    const relative=url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : '';
    const content=global.__SHOWAVE_PREVIEW_DATA__?.[relative];
    if (url.origin===global.location.origin && typeof content==='string') return new Response(content,{status:200,headers:{'Content-Type':relative.endsWith('.json')?'application/json':relative.endsWith('.svg')?'image/svg+xml':'application/xml'}});
    return new Response(JSON.stringify({ok:false,available:false,connected:false,enabled:false,active:false,error:'Unavailable in website preview',reason:'Website preview has no production backend.'}),{status:503,headers:{'Content-Type':'application/json'}});
  });
  class ClosedConnection extends EventTarget {
    constructor(){super();this.readyState=3;this.bufferedAmount=0;this.protocol='';this.extensions='';queueMicrotask(()=>{const event=new Event('close');this.onclose?.(event);this.dispatchEvent(event);});}
    send(){throw denial();} close(){this.readyState=3;} static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
  }
  define(global,'WebSocket',ClosedConnection); define(global,'EventSource',ClosedConnection);
  define(global,'RTCPeerConnection',class {constructor(){throw denial();}});
  define(global,'webkitRTCPeerConnection',global.RTCPeerConnection);
  define(global,'AudioContext',class {constructor(){throw denial();}});define(global,'webkitAudioContext',global.AudioContext);
  define(global,'OfflineAudioContext',class {constructor(){throw denial();}});define(global,'webkitOfflineAudioContext',global.OfflineAudioContext);
  if(global.HTMLMediaElement?.prototype.play)define(global.HTMLMediaElement.prototype,'play',function(){this.muted=true;this.volume=0;return Promise.reject(denial());});
  define(global,'Worker',class {constructor(){throw denial();}}); define(global,'SharedWorker',global.Worker);
  define(global,'XMLHttpRequest',class extends EventTarget {open(){throw denial();}send(){throw denial();}abort(){}setRequestHeader(){}});
  for (const name of ['showOpenFilePicker','showSaveFilePicker','showDirectoryPicker','getScreenDetails']) define(global,name,reject);
  define(global,'open',function previewOpen(url) {
    try { const name=new URL(url,global.location.href).pathname.split('/').pop();const target=name==='index.html'?'live':Object.keys(routes).find(id=>routes[id]===name);if(target)global.parent.postMessage({type:'showave-preview-workspace',workspace:target,previewToken},'*');else notice(); } catch (_) { notice(); }
    return null;
  });
  define(global,'print',()=>notice());
  const nav=global.navigator;
  define(nav,'mediaDevices',Object.freeze({enumerateDevices:async()=>[],getUserMedia:reject,getDisplayMedia:reject,addEventListener(){},removeEventListener(){}}));
  define(nav,'getUserMedia',(_constraints,_success,failure)=>failure?.(denial()));
  define(nav,'webkitGetUserMedia',nav.getUserMedia);
  define(nav,'requestMIDIAccess',reject); define(nav,'sendBeacon',()=>false);
  define(nav,'serviceWorker',undefined); define(nav,'clipboard',Object.freeze({read:reject,readText:reject,write:reject,writeText:reject}));
  define(nav,'serial',Object.freeze({getPorts:async()=>[],requestPort:reject}));
  define(nav,'usb',Object.freeze({getDevices:async()=>[],requestDevice:reject}));
  define(nav,'hid',Object.freeze({getDevices:async()=>[],requestDevice:reject}));
  define(nav,'bluetooth',Object.freeze({getAvailability:async()=>false,requestDevice:reject}));
  define(nav,'share',reject); define(nav,'canShare',()=>false); define(nav,'wakeLock',Object.freeze({request:reject}));
  define(nav,'permissions',Object.freeze({query:async()=>({state:'denied',addEventListener(){},removeEventListener(){}})}));
  define(document,'requestStorageAccess',reject);
  for(const name of ['requestFullscreen','webkitRequestFullscreen','requestPointerLock']) if(global.Element?.prototype[name])define(global.Element.prototype,name,reject);
  const inputClick=global.HTMLInputElement?.prototype.click;
  if(inputClick)define(global.HTMLInputElement.prototype,'click',function(){if(this.type==='file'){notice();return;}return inputClick.call(this);});
  if(global.HTMLInputElement?.prototype.showPicker)define(global.HTMLInputElement.prototype,'showPicker',function(){if(this.type==='file'){notice();return;}throw denial();});
  // The shipped preview logo is a local image. Do not opt it into CORS when
  // its containing iframe deliberately has an opaque origin.
  const imageCORS=Object.getOwnPropertyDescriptor(global.HTMLImageElement.prototype,'crossOrigin');
  if(imageCORS)try{Object.defineProperty(global.HTMLImageElement.prototype,'crossOrigin',{get(){return null;},set(){this.removeAttribute('crossorigin');},configurable:true});}catch(_){}
  const imageSetAttribute=global.HTMLImageElement.prototype.setAttribute;
  define(global.HTMLImageElement.prototype,'setAttribute',function(name,value){if(String(name).toLowerCase()==='crossorigin')return;return imageSetAttribute.call(this,name,value);});
  // CSS masks require CORS even for local SVGs. Supply the exact shipped SVG
  // bytes as data URLs instead of relaxing the iframe's opaque origin.
  const svgURLs=new Map(),styleSetProperty=global.CSSStyleDeclaration.prototype.setProperty;
  function inlineSVG(value){return String(value).replace(/url\(\s*(["']?)([^)'"\s]+\.svg)(#[^)'"\s]*)?\1\s*\)/gi,(match,quote,asset,fragment)=>{
    if(asset.startsWith('data:'))return match;
    let relative;try{const url=new URL(asset,global.location.href),prefix=new URL('.',global.location.href).pathname;if(url.origin!==global.location.origin||!url.pathname.startsWith(prefix))return match;relative=decodeURIComponent(url.pathname.slice(prefix.length));}catch(_){return match;}
    const content=global.__SHOWAVE_PREVIEW_DATA__?.[relative];if(typeof content!=='string')return match;
    if(!svgURLs.has(relative))svgURLs.set(relative,'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(content))));
    return 'url('+svgURLs.get(relative)+(fragment||'')+')';
  });}
  define(global.CSSStyleDeclaration.prototype,'setProperty',function(name,value,priority){return styleSetProperty.call(this,name,inlineSVG(value),priority);});
  for(const property of ['cssText','maskImage','webkitMaskImage','mask','webkitMask','backgroundImage']){
    const descriptor=Object.getOwnPropertyDescriptor(global.CSSStyleDeclaration.prototype,property);
    if(descriptor?.set)try{Object.defineProperty(global.CSSStyleDeclaration.prototype,property,{get:descriptor.get,set(value){return descriptor.set.call(this,inlineSVG(value));},configurable:true,enumerable:descriptor.enumerable});}catch(_){}
  }
  const nodeText=Object.getOwnPropertyDescriptor(global.Node.prototype,'textContent');
  if(nodeText?.set)try{Object.defineProperty(global.HTMLStyleElement.prototype,'textContent',{get:nodeText.get,set(value){return nodeText.set.call(this,inlineSVG(value));},configurable:true});}catch(_){}
  for(const method of ['insertRule','replaceSync','replace']){
    const original=global.CSSStyleSheet?.prototype[method];
    if(original)define(global.CSSStyleSheet.prototype,method,function(value,...rest){return original.call(this,inlineSVG(value),...rest);});
  }
  const elementSetAttribute=global.Element.prototype.setAttribute;
  define(global.Element.prototype,'setAttribute',function(name,value){return elementSetAttribute.call(this,name,String(name).toLowerCase()==='style'?inlineSVG(value):value);});
  const elementHTML=Object.getOwnPropertyDescriptor(global.Element.prototype,'innerHTML');
  if(elementHTML?.set)try{Object.defineProperty(global.Element.prototype,'innerHTML',{get:elementHTML.get,set(value){return elementHTML.set.call(this,inlineSVG(value));},configurable:true,enumerable:elementHTML.enumerable});}catch(_){}
  const adjacentHTML=global.Element.prototype.insertAdjacentHTML;
  if(adjacentHTML)define(global.Element.prototype,'insertAdjacentHTML',function(position,value){return adjacentHTML.call(this,position,inlineSVG(value));});
  document.addEventListener('click',event=>{
    const target=event.target.closest?.('input[type=file],a,button,[role=button]'); if(!target)return;
    if(target.matches('input[type=file]')){event.preventDefault();event.stopImmediatePropagation();notice();return;}
    const workspaceTab=target.closest('#showave-workspace-tabs [data-workspace]');
    if(workspaceTab){const next=workspaceTab.dataset.workspace==='show'?'live':workspaceTab.dataset.workspace;if(routes[next]){event.preventDefault();event.stopImmediatePropagation();global.parent.postMessage({type:'showave-preview-workspace',workspace:next,previewToken},'*');return;}}
    if(target.tagName==='A'){
      const href=target.getAttribute('href')||'';
      if(!href||href.startsWith('#'))return;
      event.preventDefault();event.stopImmediatePropagation();global.open(href);return;
    }
    const text=(target.textContent||target.getAttribute('aria-label')||'').trim();
    if(/^(?:ARM OUTPUT|Start streaming|Go live|Start recording|Upload|Connect account|Connect platform|Sign in|Log in|Authorize|Open file|Open…|Save as|Export)(?:\b|…)/i.test(text)){
      event.preventDefault();event.stopImmediatePropagation();notice();
    }
  },true);
  // Keep original RAM-only form handlers (for example New scene) working.
  // Native form navigation is independently denied by CSP form-action none.
  document.addEventListener('submit',event=>{event.preventDefault();},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();global.parent.postMessage({type:'showave-preview-close',workspace,previewToken},'*');}},true);
  document.addEventListener('drop',event=>{if(event.dataTransfer?.files?.length){event.preventDefault();event.stopImmediatePropagation();notice();}},true);
  document.addEventListener('change',event=>{if(event.target?.type==='file'){event.preventDefault();event.stopImmediatePropagation();event.target.value='';notice();}},true);
  document.addEventListener('paste',event=>{if(event.clipboardData?.files?.length){event.preventDefault();event.stopImmediatePropagation();notice();}},true);
  function ready() {
    document.documentElement.dataset.showaveWebsitePreview=workspace;
    // The visitor entered an app picture, so show that actual workspace, not its Home cover.
    const hideHome=()=>{global.OpenLiveStartSplash?.hideSplash?.();document.querySelector('[data-wclose]')?.click();};
    const boundary=document.createElement('div');boundary.id='showave-preview-boundary';boundary.textContent='ACTUAL SHOWAVE INTERFACE · WEBSITE PREVIEW · '+status.version;document.body.append(boundary);
    const send=()=>global.parent.postMessage({type:'showave-preview-ready',workspace,version:status.version,previewToken,limitedActions:true,actualFrontend:true},'*');
    let checks=0;
    function seedLive(){
      if(workspace!=='live'||!global.ArenaSources||!global.ArenaEngine)return;
      const engine=global.ArenaEngine,sources=global.ArenaSources,layer=engine.layers().at(-1),columns=engine.columns().slice(0,3);
      if(!layer||columns.length<3)return;
      engine.transaction('Website sample generators',()=>['Gradient','Lines','Checkered'].forEach((name,index)=>{
        const clip=engine.clip(layer.index,columns[index].index);if(!clip||clip.filled||!sources.has(name))return;
        const specs=sources.params(name),source={name,specs,params:engine.makeParams(clip.home+'/source',specs)};
        engine.replaceClipSource(clip,source,{name:name+' / Sample',duration:8,beats:16,info:{codec:'Source',fps:60,keyed:false,hasAudio:false,hasVideo:true},noUndo:true,label:'Website sample generator'});
      }));
    }
    const complete=()=>{
      const loaded=workspace!=='live'||(global.ArenaEngine?.layers?.().length&&global.OpenLiveStartSplash);
      if(!loaded){if(checks++<300){setTimeout(complete,100);return;}notice('The actual interface could not finish opening. View the real interface image or try again.');return;}
      hideHome();seedLive();send();setTimeout(hideHome,250);
    };
    complete();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})(window);
