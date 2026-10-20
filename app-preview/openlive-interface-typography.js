/* Interface typography only. Authored CSS, media, SVG artwork and source
   configuration stay intact. Overrides and original inline values live in RAM. */
(function interfaceTypography(global) {
  'use strict';
  if (global.OpenLiveInterfaceTypography) return;
  const controllers = new WeakMap();
  const DEFAULT = Object.freeze({family:'system',scale:100,weight:'default',italic:false});
  const PROPERTIES = ['font-size','line-height','font-family','font-weight','font-style'];
  const PRESERVE = 'svg,canvas,img,video,audio,iframe,object,embed,math,code,pre,kbd,samp,' +
    '[data-preserve-typography],[data-on-air],[data-output-stage],[data-template-content],' +
    '#progStage,#previewFrame,#previewStage,#svgPiecePreviewStage,' +
    '.bc-template-preview,.template-preview,.full-template-preview,.svg-parts-preview,' +
    '.presenter-slide,.presenter-icon,.icon,.ico,[data-icon],[data-icon-font]';
  const NON_UI_PAGES = /(?:^|\/)(?:openlive-programme-output|openlive-output|audience|guest|mobile)\.html$/i;
  const specialFace = value => /(?:monospace|\bmono\b|SFMono|consolas|courier|menlo|cascadia|symbol|wingdings|webdings|font\s*awesome|material\s*(?:icons|symbols))/i.test(value || '');
  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const family = typeof source.family === 'string' && source.family.trim() === source.family && source.family.length > 0 && source.family.length <= 120 && !/[\u0000-\u001f\u007f"';{}<>\\]/.test(source.family) ? source.family : 'system';
    return {family,scale:Number.isInteger(source.scale)&&source.scale>=75&&source.scale<=150?source.scale:100,
      weight:['default','400','500','600','700'].includes(source.weight)?source.weight:'default',italic:source.italic===true};
  }
  function splitSelectors(value) {
    const result=[];let start=0,depth=0,quote='';
    for(let index=0;index<value.length;index++){
      const ch=value[index];
      if(quote){if(ch==='\\')index++;else if(ch===quote)quote='';continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}
      if(ch==='('||ch==='[')depth++;else if(ch===')'||ch===']')depth--;
      else if(ch===','&&depth===0){result.push(value.slice(start,index).trim());start=index+1;}
    }
    result.push(value.slice(start).trim());return result.filter(Boolean);
  }
  function guardSelector(selector,preserve) {
    // Guard the element before its pseudo-element; ::before:not(...) is invalid.
    const pseudo=selector.search(/::[a-z-]+|:(?:before|after|first-letter|first-line)\b/i);
    const guard=':where(:not(:is('+preserve+')):not(:is('+preserve+') *))';
    return pseudo<0?selector+guard:selector.slice(0,pseudo)+guard+selector.slice(pseudo);
  }
  function scaled(value,factor) {
    const source=String(value||'').trim();
    // Some compact chrome couples its text and geometry to this same factor.
    // Keep that authored size so it follows the interface scale only once.
    if(/var\(\s*--openlive-ui-font-scale\b/i.test(source))return '';
    const absolute=source.match(/^([\d.]+)(px|pt|rem)$/i);
    if(absolute)return String(Math.round(Number(absolute[1])*factor*10000)/10000)+absolute[2];
    if(/^(?:var|calc|min|max|clamp)\(/i.test(source))return 'calc(('+source+') * '+factor+')';
    return '';
  }
  function install(document=global.document) {
    if(!document || !document.createElement) return {apply(){},refresh(){},destroy(){}};
    if(controllers.has(document))return controllers.get(document);
    const view=document.defaultView||global;
    let state={...DEFAULT},signature='',overlay=null,overlayText='',observer=null,pending=null,destroyed=false,writing=false;
    let trees=[],extraPreserve=[],allElements=true,sheetsDirty=true,recapturePins=true;
    const pendingElements=new Set(),inline=new Map(),pinned=new Map(),listeners=[];
    const outputDocument=NON_UI_PAGES.test(view.location?.pathname||'') || document.documentElement?.hasAttribute?.('data-preserve-typography');
    const isDefault=()=>state.family==='system'&&state.scale===100&&state.weight==='default'&&!state.italic;
    function read(style,name){return style?.getPropertyValue?.(name)||'';}
    function priority(style,name){return style?.getPropertyPriority?.(name)||'';}
    function fontValue(style) {
      let value=read(style,'font');
      const token=value.match(/^var\((--[\w-]+)(?:,([\s\S]*))?\)$/);
      if(token)try{value=view.getComputedStyle(document.documentElement).getPropertyValue(token[1]).trim()||token[2]||'';}catch(_){value=token[2]||'';}
      return value;
    }
    function typographyValues(style) {
      const font=fontValue(style),clean=font.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,'');
      const shorthand=clean.match(/(?:^|\s)([\d.]+(?:px|pt|rem))(?:\s*\/\s*([^\s]+))?(?=\s|$)/i);
      return {size:read(style,'font-size')||shorthand?.[1]||'',line:read(style,'line-height')||shorthand?.[2]||'',
        family:read(style,'font-family'),font,hasFont:!!font||PROPERTIES.some(name=>!!read(style,name))};
    }
    function collectRules(sheets,visited=new Set()) {
      const result=[];
      for(const sheet of sheets||[]){
        if(!sheet||visited.has(sheet)||sheet.disabled||sheet.ownerNode===overlay)continue;visited.add(sheet);
        let rules;try{rules=sheet.cssRules;}catch(_){continue;}
        for(const rule of rules||[]){
          if(rule.styleSheet){result.push(...collectRules([rule.styleSheet],visited));continue;}
          if(rule.selectorText&&rule.style){result.push({selector:rule.selectorText,style:rule.style});continue;}
          if(rule.cssRules&&rule.type!==7){
            const header=String(rule.cssText||'').split('{')[0].trim();
            if(/^@(?:media|supports|layer|container|scope)\b/i.test(header)){
              const nested=collectRules([{cssRules:rule.cssRules}],visited);if(nested.length)result.push({header,children:nested});
            }
          }
        }
      }
      return result;
    }
    function walk(list,visit){for(const item of list){if(item.children)walk(item.children,visit);else visit(item);}}
    function preserveSelector(){return PRESERVE+(extraPreserve.length?','+extraPreserve.join(','):'');}
    function isPreserved(element){try{return !!element.closest?.(preserveSelector());}catch(_){return false;}}
    function snapshot(style){return {font:read(style,'font'),values:Object.fromEntries(PROPERTIES.map(name=>[name,{value:read(style,name),priority:priority(style,name)}])),applied:{}};}
    function write(style,name,value,rank=''){
      if(value)style.setProperty(name,value,rank);else style.removeProperty?.(name);
    }
    function restore(element,record){
      const style=element.style;let changed=false;
      for(const [name,last] of Object.entries(record.applied))if(read(style,name)!==last.value||priority(style,name)!==last.priority){
        record.values[name]={value:read(style,name),priority:priority(style,name)};changed=true;
      }
      if(changed)record.font='';
      for(const name of PROPERTIES){const old=record.values[name];write(style,name,old.value,old.priority);}
      if(record.font)style.setProperty('font',record.font,record.fontPriority||'');
      record.applied={};return changed;
    }
    function applyValues(element,record,values){
      for(const [name,value] of Object.entries(values)){
        if(!value)continue;element.style.setProperty(name,value,'important');record.applied[name]={value:read(element.style,name),priority:priority(element.style,name)};
      }
    }
    function build(list,preserve) {
      const factor=state.scale/100;let css='';
      for(const item of list){
        if(item.children){const child=build(item.children,preserve);if(child)css+=item.header+'{'+child+'}\n';continue;}
        const values=typographyValues(item.style);if(!values.hasFont||specialFace(values.family||values.font))continue;
        const declarations=[];
        if(state.scale!==100){
          const size=scaled(values.size,factor),line=scaled(values.line,factor);
          if(size)declarations.push('font-size:'+size+(priority(item.style,'font-size')||priority(item.style,'font')?'!important':'')+';');
          if(line)declarations.push('line-height:'+line+(priority(item.style,'line-height')||priority(item.style,'font')?'!important':'')+';');
        }
        if(state.family!=='system')declarations.push('font-family:"'+state.family+'",system-ui,sans-serif!important;');
        if(state.weight!=='default')declarations.push('font-weight:'+state.weight+'!important;');
        if(state.italic)declarations.push('font-style:italic!important;');
        if(!declarations.length)continue;
        const selectors=splitSelectors(item.selector).filter(selector=>!/^:root$|^html(?:\[[^\]]*\]|:[\w-]+)*$/.test(selector));
        if(selectors.length)css+=selectors.map(selector=>guardSelector(selector,preserve)).join(',')+'{'+declarations.join('')+'}\n';
      }
      return css;
    }
    function elementsIn(roots,selector){
      const result=new Set();
      for(const root of roots){if(!root||root.nodeType!==1&&root!==document)continue;
        try{if(root.matches?.(selector))result.add(root);for(const element of root.querySelectorAll?.(selector)||[])result.add(element);}catch(_){}
      }
      return result;
    }
    function live(element){return element.isConnected!==false;}
    function ensureOverlay(){
      if(!overlay){overlay=document.createElement('style');overlay.setAttribute('data-openlive-interface-typography','');}
      // Saved preferences can create this sheet before the parser reaches the
      // authored styles. Keep equal-specificity overrides after those styles
      // on the ready/load refresh, just as an interactive change would be.
      const head=document.head||document.documentElement;if(head&&(overlay.parentNode!==head||head.lastChild!==overlay))head.appendChild(overlay);
    }
    function refresh() {
      pending=null;if(destroyed||outputDocument)return;
      writing=true;
      try{
        const roots=allElements?[document]:[...pendingElements];pendingElements.clear();allElements=false;
        // Disable only our stylesheet during the one synchronous baseline read.
        if(overlay?.sheet)overlay.sheet.disabled=true;
        for(const [element,record] of inline){restore(element,record);if(!live(element))inline.delete(element);}
        for(const [element,record] of pinned){
          const changed=restore(element,record);if(!live(element)){pinned.delete(element);continue;}
          if(changed||recapturePins)try{const computed=view.getComputedStyle(element);for(const name of PROPERTIES){const value=read(computed,name);if(value)record.pin[name]=value;}}catch(_){}
        }
        if(isDefault()){
          inline.clear();pinned.clear();if(overlay&&overlayText){overlay.textContent='';overlayText='';}return;
        }
        if(sheetsDirty){
          trees=collectRules(document.styleSheets);extraPreserve=[];
          walk(trees,item=>{const values=typographyValues(item.style);if(specialFace(values.family||values.font)){
            extraPreserve.push(...splitSelectors(item.selector).map(selector=>selector.replace(/::[\s\S]*$|:(?:before|after|first-letter|first-line)\b[\s\S]*$/i,'')).filter(Boolean));
          }});extraPreserve=[...new Set(extraPreserve)];sheetsDirty=false;
        }
        const preserve=preserveSelector();
        for(const element of pinned.keys())if(!isPreserved(element))pinned.delete(element);
        for(const element of elementsIn(roots,':is('+preserve+'),:is('+preserve+') *')){
          if(!element.style||pinned.has(element)||element===overlay)continue;
          let computed;try{computed=view.getComputedStyle(element);}catch(_){continue;}
          const record=snapshot(element.style);record.fontPriority=priority(element.style,'font');record.pin={};
          for(const name of PROPERTIES){const value=read(computed,name);if(value)record.pin[name]=value;}
          pinned.set(element,record);
        }
        for(const element of elementsIn(roots,'[style]')){
          if(!element.style||isPreserved(element)||element===overlay||inline.has(element))continue;
          const values=typographyValues(element.style);if(!values.hasFont||specialFace(values.family||values.font))continue;
          const record=snapshot(element.style);record.fontPriority=priority(element.style,'font');inline.set(element,record);
        }
        let css=build(trees,preserve);
        if(state.scale!==100&&document.body)try{
          const base=read(view.getComputedStyle(document.body),'font-size'),size=scaled(base,state.scale/100);
          if(size)css+=guardSelector('body',preserve)+'{font-size:'+size+';}\n';
        }catch(_){}
        const generic=[];
        if(state.family!=='system')generic.push('font-family:"'+state.family+'",system-ui,sans-serif!important;');
        if(state.weight!=='default')generic.push('font-weight:'+state.weight+'!important;');
        if(state.italic)generic.push('font-style:italic!important;');
        if(generic.length)css+=guardSelector('body',preserve)+','+guardSelector('body *',preserve)+'{'+generic.join('')+'}\n';
        ensureOverlay();if(css!==overlayText){overlay.textContent=css;overlayText=css;}
        for(const [element,record] of inline){
          if(isPreserved(element))continue;const values=typographyValues(element.style),patch={};
          if(state.scale!==100){patch['font-size']=scaled(values.size,state.scale/100);patch['line-height']=scaled(values.line,state.scale/100);}
          if(state.family!=='system')patch['font-family']='"'+state.family+'",system-ui,sans-serif';
          if(state.weight!=='default')patch['font-weight']=state.weight;if(state.italic)patch['font-style']='italic';applyValues(element,record,patch);
        }
        for(const [element,record] of pinned)applyValues(element,record,record.pin);recapturePins=false;
      }finally{if(overlay?.sheet)overlay.sheet.disabled=false;writing=false;observer?.takeRecords?.();}
    }
    function queue(){
      if(destroyed||pending!==null||isDefault()||outputDocument)return;
      const schedule=view.requestAnimationFrame||view.setTimeout||global.setTimeout;
      if(schedule)pending=schedule.call(view,refresh);else refresh();
    }
    function added(element){
      if(!element||element.nodeType!==1||element===overlay)return;
      pendingElements.add(element);
      if(element.matches?.('style,link[rel="stylesheet"]')||element.querySelector?.('style,link[rel="stylesheet"]')){sheetsDirty=true;allElements=true;recapturePins=true;}
    }
    function observe(){
      // A host can install us on an adapter document. Its element-like objects
      // cannot be observed by a native window; native documents use their own
      // realm's Node constructor so detached windows and iframes stay valid.
      const nativeRoot=!view.Node||document.documentElement instanceof view.Node;
      if(typeof view.MutationObserver==='function'&&document.documentElement&&nativeRoot){
        observer=new view.MutationObserver(records=>{
          if(writing||destroyed)return;let relevant=false;
          for(const record of records){
            if(record.target===overlay)continue;
            if(record.type==='childList'){
              for(const node of record.addedNodes||[])if(node.nodeType===1&&node!==overlay){added(node);relevant=true;}
              if(record.target?.tagName==='STYLE'){sheetsDirty=true;allElements=true;recapturePins=true;relevant=true;}
              if([...record.removedNodes||[]].some(node=>node.nodeType===1&&node!==overlay))relevant=true;
            }else if(record.type==='attributes'){
              const target=record.target,recorded=inline.get(target)||pinned.get(target);
              if(record.attributeName==='style'){
                if(recorded&&Object.entries(recorded.applied).every(([name,last])=>read(target.style,name)===last.value&&priority(target.style,name)===last.priority))continue;
                if(!recorded&&!typographyValues(target.style).hasFont)continue;
              }else if(pinned.has(target)===isPreserved(target))continue;
              pendingElements.add(target);relevant=true;
            }
          }
          if(relevant)queue();
        });
        observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','data-preserve-typography']});
      }
      const load=event=>{if(event.target?.tagName==='LINK'){sheetsDirty=true;allElements=true;recapturePins=true;queue();}};
      document.addEventListener?.('load',load,true);listeners.push(()=>document.removeEventListener?.('load',load,true));
      const ready=()=>{allElements=true;sheetsDirty=true;queue();};
      document.addEventListener?.('DOMContentLoaded',ready,{once:true});listeners.push(()=>document.removeEventListener?.('DOMContentLoaded',ready));
      const resize=()=>{allElements=true;recapturePins=true;queue();};
      view.addEventListener?.('resize',resize,{passive:true});listeners.push(()=>view.removeEventListener?.('resize',resize));
    }
    const controller={apply(value){
      const next=normalize(value),key=JSON.stringify(next);if(key===signature)return;signature=key;state=next;
      allElements=true;sheetsDirty=true;refresh();
    },refresh(){allElements=true;sheetsDirty=true;refresh();},destroy(){
      if(destroyed)return;destroyed=true;observer?.disconnect();listeners.forEach(remove=>remove());
      if(pending!==null){if(view.cancelAnimationFrame)view.cancelAnimationFrame(pending);else(view.clearTimeout||global.clearTimeout)?.(pending);pending=null;}
      for(const [element,record] of inline)restore(element,record);for(const [element,record] of pinned)restore(element,record);
      inline.clear();pinned.clear();overlay?.remove?.();controllers.delete(document);
    },getState:()=>({...state})};
    controllers.set(document,controller);observe();return controller;
  }
  global.OpenLiveInterfaceTypography=Object.freeze({install,apply:value=>install().apply(value),refresh:()=>install().refresh(),defaults:DEFAULT});
})(typeof window==='object'?window:globalThis);
