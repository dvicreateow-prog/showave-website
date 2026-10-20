/* Shared SHOWAVE elements browser. UNDOCUMENTED — inferring: this operator-
   requested library extends manual/sources.htm and stills.htm; selected SVGs
   enter the existing still-media transaction, never bypass Preview admission.
   Iconify API: https://iconify.design/docs/api/search.html and /api/svg.html. */
(function (global) {
  'use strict';
  const NS='http://www.w3.org/2000/svg',API='https://api.iconify.design';
  const MIT='Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
  const COLLECTIONS=Object.freeze({
    tabler:Object.freeze({name:'Tabler',author:'Paweł Kuna',copyright:'Copyright (c) 2020-2026 Paweł Kuna',url:'https://github.com/tabler/tabler-icons/blob/main/LICENSE'}),
    ph:Object.freeze({name:'Phosphor',author:'Phosphor Icons',copyright:'Copyright (c) 2023 Phosphor Icons',url:'https://github.com/phosphor-icons/core/blob/main/LICENSE'}),
    heroicons:Object.freeze({name:'Heroicons',author:'Tailwind Labs',copyright:'Copyright (c) Tailwind Labs, Inc.',url:'https://github.com/tailwindlabs/heroicons/blob/master/LICENSE'})
  });
  const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
  const colorValue=value=>/^#[\da-f]{6}$/i.test(String(value))?String(value):'#32A6FF';
  const records=[];
  function shape(id,name,category,body,tags=''){records.push(Object.freeze({id:'showave:'+id,name,category,body,tags,source:'SHOWAVE',author:'SHOWAVE',license:Object.freeze({title:'Original SHOWAVE element',url:''}),sourceUrl:'',width:512,height:512}));}
  const path=(d,extra='')=>'<path d="'+d+'" '+extra+'/>';
  const outline='fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';
  const polygon=(sides,rotation=-Math.PI/2,inner=0)=>Array.from({length:inner?sides*2:sides},(_,i)=>{const a=rotation+i*Math.PI*2/(inner?sides*2:sides),r=inner&&i%2?inner:39;return (50+Math.cos(a)*r).toFixed(2)+','+(50+Math.sin(a)*r).toFixed(2);}).join(' ');
  shape('circle','Circle','Shapes','<circle cx="50" cy="50" r="39"/>','round dot');
  shape('square','Square','Shapes','<rect x="12" y="12" width="76" height="76"/>','block');
  shape('rounded-square','Rounded square','Shapes','<rect x="12" y="12" width="76" height="76" rx="16"/>','rectangle');
  shape('rectangle','Wide rectangle','Shapes','<rect x="6" y="27" width="88" height="46" rx="3"/>','lower third bar');
  shape('pill','Pill','Shapes','<rect x="6" y="28" width="88" height="44" rx="22"/>','capsule');
  for(const [n,name] of [[3,'Triangle'],[5,'Pentagon'],[6,'Hexagon'],[8,'Octagon']])shape(name.toLowerCase(),name,'Shapes','<polygon points="'+polygon(n)+'"/>');
  shape('diamond','Diamond','Shapes','<polygon points="50,8 91,50 50,92 9,50"/>','rhombus');
  shape('heart','Heart','Shapes',path('M50 85C37 74 10 55 10 34C10 11 39 8 50 28C61 8 90 11 90 34C90 55 63 74 50 85Z'),'love');
  shape('cloud','Cloud','Shapes',path('M26 77C4 77 4 45 24 43C20 18 61 10 69 38C94 33 101 77 75 77Z'),'weather');
  shape('speech','Speech bubble','Shapes',path('M10 15H90V71H45L23 88V71H10Z'),'quote talk');
  shape('quote','Quotation marks','Shapes',path('M12 24H42V53H28C28 67 36 68 42 70V81C19 77 12 66 12 49ZM57 24H87V53H73C73 67 81 68 87 70V81C64 77 57 66 57 49Z'),'text speech');
  shape('cross','Plus','Shapes',path('M40 10H60V40H90V60H60V90H40V60H10V40H40Z'),'add cross');
  shape('crescent','Crescent','Shapes',path('M78 14C32 3 7 49 32 78C48 97 76 91 88 74C48 83 28 33 78 14Z'),'moon');
  shape('right-arrow','Arrow right','Arrows',path('M10 37H56V15L92 50L56 85V63H10Z'),'direction next');
  shape('left-arrow','Arrow left','Arrows','<g transform="rotate(180 50 50)">'+path('M10 37H56V15L92 50L56 85V63H10Z')+'</g>','direction previous');
  shape('up-arrow','Arrow up','Arrows','<g transform="rotate(-90 50 50)">'+path('M10 37H56V15L92 50L56 85V63H10Z')+'</g>','direction');
  shape('down-arrow','Arrow down','Arrows','<g transform="rotate(90 50 50)">'+path('M10 37H56V15L92 50L56 85V63H10Z')+'</g>','direction');
  shape('thin-arrow','Fine arrow','Arrows',path('M10 50H87M65 28L87 50L65 72',outline),'line direction');
  shape('double-arrow','Two-way arrow','Arrows',path('M12 50H88M30 32L12 50L30 68M70 32L88 50L70 68',outline),'line direction');
  shape('chevron','Chevron','Arrows',path('M25 15L63 50L25 85H48L86 50L48 15Z'),'next');
  shape('double-chevron','Double chevron','Arrows',path('M12 22L40 50L12 78M52 22L80 50L52 78',outline),'next');
  shape('turn-arrow','Turn arrow','Arrows',path('M16 84V44Q16 22 40 22H82M64 6L83 22L64 39',outline),'curve');
  shape('line','Fine line','Lines',path('M8 50H92',outline),'divider horizontal');
  shape('double-line','Double line','Lines',path('M8 44H92M8 56H92',outline),'divider');
  shape('dashed-line','Dashed line','Lines',path('M8 50H92',outline+' stroke-dasharray="8 7"'),'divider dash');
  shape('dotted-line','Dotted line','Lines',path('M8 50H92',outline+' stroke-dasharray="0 9"'),'divider dots');
  shape('wave','Wave','Lines',path('M5 50Q16 24 28 50T51 50T74 50T97 50',outline),'wavy');
  shape('zigzag','Zigzag','Lines',path('M5 65L20 35L35 65L50 35L65 65L80 35L95 65',outline),'lightning');
  shape('arc','Arc','Lines',path('M10 76A40 40 0 0 1 80 23',outline),'curve');
  for(const [n,name,inner] of [[4,'Sparkle',10],[5,'Star',18],[8,'Starburst',26],[12,'Seal',32]])shape(name.toLowerCase(),name,'Badges','<polygon points="'+polygon(n,-Math.PI/2,inner)+'"/>','award celebration');
  shape('shield','Shield','Badges',path('M50 9L85 23V52C85 70 65 82 50 92C35 82 15 70 15 52V23Z'),'trust award');
  shape('ribbon','Ribbon','Badges',path('M7 30H93L79 50L93 70H7L21 50Z'),'banner label');
  shape('bookmark','Bookmark','Badges',path('M25 10H75V91L50 74L25 91Z'),'ribbon');
  shape('medal','Medal','Badges','<circle cx="50" cy="35" r="25"/>'+path('M31 55L20 91L44 79L50 63L56 79L80 91L69 55Z'),'award');
  shape('check','Check mark','Badges',path('M16 52L39 75L85 23','fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"'),'tick success');
  shape('circle-frame','Circle frame','Frames','<circle cx="50" cy="50" r="39" '+outline+'/>','border round');
  shape('square-frame','Square frame','Frames','<rect x="12" y="12" width="76" height="76" '+outline+'/>','border');
  shape('rounded-frame','Rounded frame','Frames','<rect x="12" y="12" width="76" height="76" rx="16" '+outline+'/>','border');
  shape('wide-frame','Wide frame','Frames','<rect x="6" y="25" width="88" height="50" rx="3" '+outline+'/>','border lower third');
  shape('corners','Corner brackets','Frames',path('M10 35V10H35M65 10H90V35M90 65V90H65M35 90H10V65',outline),'border crop');
  shape('double-frame','Double frame','Frames','<rect x="9" y="21" width="82" height="58" '+outline+'/><rect x="16" y="28" width="68" height="44" fill="none" stroke="currentColor" stroke-width="1"/>','border');
  shape('sun-rays','Sun rays','Decorations','<circle cx="50" cy="50" r="17"/>'+path('M50 8V23M50 77V92M8 50H23M77 50H92M20 20L30 30M70 70L80 80M20 80L30 70M70 30L80 20',outline),'light');
  shape('confetti','Confetti','Decorations',path('M15 18L24 28M77 18L69 28M14 75L23 68M81 76L72 66M47 8V20M9 47H23M77 48H91',outline)+'<circle cx="49" cy="50" r="7"/><circle cx="48" cy="81" r="4"/><circle cx="82" cy="31" r="3"/>','party celebration');
  shape('dots','Dot grid','Decorations',Array.from({length:16},(_,i)=>'<circle cx="'+(20+i%4*20)+'" cy="'+(20+Math.floor(i/4)*20)+'" r="4"/>').join(''),'pattern');
  shape('signal','Signal bars','Decorations',Array.from({length:7},(_,i)=>{const h=[20,44,62,80,62,44,20][i];return '<rect x="'+(10+i*12)+'" y="'+(50-h/2)+'" width="7" height="'+h+'" rx="3"/>';}).join(''),'audio sound music');
  shape('play','Play','Decorations','<circle cx="50" cy="50" r="39" '+outline+'/>'+path('M40 28L73 50L40 72Z'),'video media');
  const OFFLINE=Object.freeze(records);
  const byId=new Map(OFFLINE.map(record=>[record.id,record]));
  function local(query='',category='All'){
    const words=String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
    return OFFLINE.filter(r=>(category==='All'||category===r.category)&&words.every(word=>(r.name+' '+r.tags+' '+r.category).toLowerCase().includes(word)));
  }
  function onlineRecord(id){
    const match=/^([a-z0-9-]+):([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(id));
    if(!match||!Object.hasOwn(COLLECTIONS,match[1]))throw Error('This element collection is not supported.');
    const collection=COLLECTIONS[match[1]];
    return Object.freeze({id,name:match[2].replace(/-/g,' '),category:'Online',source:collection.name,author:collection.author,sourceUrl:'https://icon-sets.iconify.design/'+match[1]+'/'+match[2]+'/',license:Object.freeze({title:'MIT',url:collection.url,notice:collection.copyright+'\n\n'+MIT}),width:512,height:512});
  }
  function svgUrl(record,color){const verified=onlineRecord(record.id),parts=verified.id.split(':');return API+'/'+parts[0]+'/'+parts[1]+'.svg?color='+encodeURIComponent(colorValue(color))+'&height=512';}
  function originalSVG(record,color){const verified=byId.get(record.id);if(!verified)throw Error('Unknown SHOWAVE element.');return '<svg xmlns="'+NS+'" width="512" height="512" viewBox="0 0 100 100" fill="'+colorValue(color)+'" color="'+colorValue(color)+'">'+verified.body+'</svg>';}
  const ELEMENTS=new Set(['svg','g','path','circle','ellipse','rect','line','polyline','polygon','defs','clipPath','mask','linearGradient','radialGradient','stop']);
  const ATTRS=new Set(['viewBox','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','d','points','transform','fill','fill-rule','fill-opacity','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-dasharray','stroke-dashoffset','stroke-opacity','opacity','color','clip-path','clip-rule','mask','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','spreadMethod','fx','fy','fr','clipPathUnits','maskUnits','maskContentUnits']);
  function sanitizeSVG(input,color='#32A6FF'){
    const source=String(input||'');
    if(!source||source.length>256000||/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('The element contains unsupported SVG data.');
    const parser=new global.DOMParser(),doc=parser.parseFromString(source,'image/svg+xml');
    if(doc.getElementsByTagName('parsererror').length||!doc.documentElement||doc.documentElement.localName!=='svg')throw Error('The element is not a valid SVG image.');
    const root=doc.documentElement,view=(root.getAttribute('viewBox')||'').trim().split(/[ ,]+/).map(Number);
    if(view.length!==4||view.some(n=>!Number.isFinite(n))||view[2]<=0||view[3]<=0||view[2]/view[3]>20||view[3]/view[2]>20)throw Error('The element has unsupported dimensions.');
    let count=0;
    function clean(node){
      if(++count>3000)throw Error('The element is too complex.');
      if(!ELEMENTS.has(node.localName)||node.namespaceURI&&node.namespaceURI!==NS)throw Error('The element contains unsupported SVG content.');
      const attrs=[];
      for(const attribute of Array.from(node.attributes||[])){
        const name=attribute.name,value=attribute.value;
        if(name==='xmlns')continue;
        if(!ATTRS.has(name)||attribute.namespaceURI)throw Error('The element contains unsupported SVG attributes.');
        if(value.length>128000||/[<>\u0000-\u0008]/.test(value)||/javascript:|data:|https?:|@import|expression\s*\(/i.test(value))throw Error('External content is not allowed in an element.');
        if(/url\s*\(/i.test(value)&&!/^url\(#[a-zA-Z_][\w.-]*\)$/.test(value))throw Error('External SVG references are not allowed.');
        attrs.push(name+'="'+escape(value.replace(/currentColor/g,colorValue(color)))+'"');
      }
      const children=[];
      for(const child of Array.from(node.childNodes||[])){
        if(child.nodeType===1)children.push(clean(child));
        else if(child.nodeType!==8&&String(child.nodeValue||'').trim())throw Error('The element contains unsupported text.');
      }
      return '<'+node.localName+(attrs.length?' '+attrs.join(' '):'')+'>'+children.join('')+'</'+node.localName+'>';
    }
    // Root size is normalized only after the same allowlist as every child.
    clean(root);root.setAttribute('width',String(Math.round(512*view[2]/Math.max(view[2],view[3]))));root.setAttribute('height',String(Math.round(512*view[3]/Math.max(view[2],view[3]))));root.setAttribute('fill',root.getAttribute('fill')||colorValue(color));
    count=0;
    const svg=clean(root).replace('<svg','<svg xmlns="'+NS+'"');
    return {svg,width:Number(root.getAttribute('width')),height:Number(root.getAttribute('height'))};
  }
  function abortError(){const error=Error('The element request was cancelled.');error.name='AbortError';return error;}
  async function request(url,{signal,fetch:fetcher=global.fetch}={}){
    if(signal?.aborted)throw abortError();
    const ctrl=new global.AbortController(),abort=()=>ctrl.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=global.setTimeout(abort,12000);
    try{
      const response=await fetcher(url,{signal:ctrl.signal,mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok)throw Error('The online library is unavailable ('+response.status+'). Try again or use Built-in.');
      const text=await response.text();
      if(text.length>1000000)throw Error('The online library returned too much data.');
      if(signal?.aborted)throw abortError();
      return text;
    }catch(error){if(signal?.aborted)throw abortError();if(error?.name==='AbortError')throw Error('The online library took too long to respond. Try again.');throw error;}
    finally{global.clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async function search(query,{signal,limit=64,fetch:fetcher}={}){
    const term=String(query||'').trim().slice(0,80);
    if(term.length<2)return {records:[],more:false};
    const count=limit===999?999:64;
    const data=JSON.parse(await request(API+'/search?'+new URLSearchParams({query:term,prefixes:Object.keys(COLLECTIONS).join(','),limit:String(count)}),{signal,fetch:fetcher}));
    if(!Array.isArray(data.icons))throw Error('The online library returned an invalid search result.');
    const found=[];
    for(const id of new Set(data.icons.slice(0,count))){try{found.push(onlineRecord(id));}catch(_){/* The remote response cannot expand the collection allowlist. */}}
    return {records:found,more:count===64&&data.icons.length>=64};
  }
  async function createAsset(record,{color='#32A6FF',signal,fetch:fetcher}={}){
    if(signal?.aborted)throw abortError();
    if(record?.kind==='photo'||record?.kind==='image'){
      if(!global.OpenLivePhotoLibrary)throw Error('The photo and image library is unavailable.');
      return global.OpenLivePhotoLibrary.createAsset(record,{signal,fetch:fetcher});
    }
    const localRecord=byId.get(record?.id),item=localRecord||onlineRecord(record?.id);
    const raw=localRecord?originalSVG(item,color):await request(svgUrl(item,color),{signal,fetch:fetcher});
    const parsed=sanitizeSVG(raw,color);
    const notice=item.name+' — '+item.source+'\n'+(item.sourceUrl?item.sourceUrl+'\n':'')+(item.license.notice||'Original SHOWAVE artwork. Free to use in SHOWAVE compositions.');
    const svg=parsed.svg.replace(/(<svg\b[^>]*>)/,'$1<metadata>'+escape(notice)+'</metadata>');
    const file=new global.File([svg],item.id.replace(':','-')+'.svg',{type:'image/svg+xml'});
    return {...item,...parsed,svg,file};
  }
  function createSearchSession(){
    let generation=0,controller=null;
    return {cancel(){generation++;controller?.abort();controller=null;},async run(query,options={}){
      const own=++generation;controller?.abort();controller=new global.AbortController();
      try{const result=await search(query,{...options,signal:controller.signal});return own===generation?{...result,stale:false}:{stale:true};}
      catch(error){if(own!==generation)return {stale:true};throw error;}
    }};
  }
  let active=null;
  function open(options={}){
    if(typeof options.onInsert!=='function')throw Error('An element insertion target is required.');
    active?.close();
    const doc=options.document||global.document,searchSession=createSearchSession(),photos=global.OpenLivePhotoLibrary,
      photoSearch=photos?.createSearchSession(),catalogue=options.catalogue||photos?.getCatalogue();
    let closed=false,selected=null,source='builtin',category='All',online=[],photoResults=[],hasMore=false,photoOffset=0,
      assetGeneration=0,searchGeneration=0,previewURL=null,selectedAsset=null,prepareController=null,operationController=null,uploadController=null,searching=false;
    const urls=new Set(),listeners=[],tokens=new Map();let dragToken=null;
    const element=(tag,className,text)=>{const el=doc.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
    const listen=(node,type,callback,config)=>{node.addEventListener(type,callback,config);listeners.push(()=>node.removeEventListener(type,callback,config));};
    const button=(text,className='')=>{const el=element('button',className,text);el.type='button';return el;};
    const panel=element('section','ol-design-library');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-label',options.title||'Elements library');
    const header=element('div','ol-design-library-header'),coverImage=element('img','ol-design-library-cover'),brand=element('img','ol-design-library-brand'),heading=element('div','ol-design-library-heading'),title=element('strong','',options.title||'Elements');
    coverImage.alt='';coverImage.src='assets/brand/showave-splash-default-1.jpg';brand.alt='SHOWAVE';brand.src='assets/brand/showave-lockup.svg';
    heading.append(title,element('span','','Shapes, photos & your own images'));header.append(coverImage,brand,heading);
    const close=button('','ol-design-library-close');close.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';close.setAttribute('aria-label','Close elements library');header.append(close);
    const coverToggle=button('','ol-design-library-cover-toggle');coverToggle.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>';coverToggle.setAttribute('aria-label','Hide cover');coverToggle.setAttribute('aria-expanded','true');coverToggle.title='Hide cover to make more room for elements';header.append(coverToggle);
    function collapseCover(collapsed=true){panel.dataset.coverCollapsed=String(collapsed);coverToggle.setAttribute('aria-expanded',String(!collapsed));coverToggle.setAttribute('aria-label',collapsed?'Show cover':'Hide cover');coverToggle.title=collapsed?'Show cover':'Hide cover to make more room for elements';}
    listen(coverToggle,'click',()=>collapseCover(panel.dataset.coverCollapsed!=='true'));
    // Use the same saved cover in Show and in the retained Broadcast iframe.
    // The cover service owns its URL; this view only subscribes while open.
    let homeCover=global.OpenLiveSplashCover;
    try{homeCover=homeCover||global.parent?.OpenLiveSplashCover;}catch(_){}
    if(homeCover?.get){const updateCover=value=>{if(!closed)coverImage.src=value?.custom&&value.url?value.url:'assets/brand/showave-splash-default-1.jpg';};updateCover(homeCover.get());if(homeCover.subscribe)listeners.push(homeCover.subscribe(updateCover));}
    const body=element('div','ol-design-library-body');
    const tabs=element('div','ol-design-library-tabs'),tabButtons=new Map();tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Element libraries');
    for(const [key,label] of [['builtin','Shapes'],['online','Online icons'],['photos','Photos'],['images','My Images']]){
      const tab=button(label);tab.dataset.librarySource=key;tab.setAttribute('role','tab');tabButtons.set(key,tab);tabs.append(tab);
    }
    const form=element('form','ol-design-library-search'),input=element('input');input.type='search';input.placeholder='Search elements';input.maxLength=80;input.setAttribute('aria-label','Search elements');
    const searchButton=button('Search');searchButton.type='submit';form.append(input,searchButton);
    const upload=element('div','ol-design-library-upload'),uploadButton=button('＋ Upload images'),uploadInput=element('input');
    uploadInput.type='file';uploadInput.accept='image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';uploadInput.multiple=true;uploadInput.hidden=true;
    uploadInput.setAttribute('aria-label','Upload your images');
    const storageNote=element('span','','Only images you choose are added.');upload.append(uploadButton,uploadInput,storageNote);upload.hidden=true;
    const suggestions=element('div','ol-design-library-suggestions');suggestions.setAttribute('aria-label','Photo search ideas');
    for(const term of ['People','People clapping','Stage lighting','Portrait']){const chip=button(term);listen(chip,'click',()=>{input.value=term;runSearch();});suggestions.append(chip);}suggestions.hidden=true;
    const filters=element('div','ol-design-library-filters'),filterButtons=[];
    for(const name of ['All','Shapes','Arrows','Lines','Badges','Frames','Decorations']){const b=button(name);b.setAttribute('aria-pressed',String(name==='All'));listen(b,'click',()=>{category=name;refresh();});filterButtons.push([name,b]);filters.append(b);}
    const grid=element('div','ol-design-library-grid');grid.setAttribute('aria-label','Available elements');
    const more=button('Show more results','ol-design-library-more');more.hidden=true;
    const details=element('div','ol-design-library-details'),preview=element('div','ol-design-library-preview'),image=element('img');image.alt='';preview.append(image);
    const info=element('div','ol-design-library-info'),name=element('strong','','Choose an element'),credit=element('span','','Shapes work offline.'),rights=element('div','ol-design-library-rights'),license=element('a'),sourceLink=element('a');
    for(const link of [license,sourceLink]){link.target='_blank';link.rel='noopener noreferrer';link.hidden=true;rights.append(link);}sourceLink.textContent='Source & attribution';
    info.append(name,credit,rights);
    const colorLabel=element('label','ol-design-library-color','Color'),color=element('input');color.type='color';color.value=colorValue(options.color);color.setAttribute('aria-label','Element color');colorLabel.append(color);
    const remove=button('Remove','ol-design-library-remove');remove.dataset.designAction='remove';remove.title='Remove this image from My Images. Sources already added stay in the scene.';remove.hidden=true;
    details.append(preview,info,colorLabel,remove);
    const guidance=element('p','ol-design-library-guidance',options.dropTarget?'Drag to canvas or click Add. Resize with the handles. Use Sources to select overlapping layers; Alt-click cycles them.':'Click Add to Files, then drag the image to a Clip Slot.');
    const imageHint=element('p','ol-design-library-image-hint','PNG / JPEG / WebP · under 16 MB. Transparent PNG and WebP keep transparency. Photos retain their background.');imageHint.hidden=true;
    const footer=element('footer','ol-design-library-footer'),status=element('div','ol-design-library-status','Choose an element to add.'),actions=element('div','ol-design-library-actions'),insert=button(options.insertLabel||'Add element','ol-design-library-insert'),background=button('Add as background'),cancel=button('Cancel');
    insert.dataset.designAction='insert';background.dataset.designAction='background';cancel.dataset.designAction='cancel';background.title='Fill the canvas behind the other layers';background.hidden=options.supportsBackground===false;cancel.hidden=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');actions.append(cancel,insert,background);footer.append(status,actions);
    body.append(tabs,form,upload,suggestions,filters,grid,more,imageHint,guidance);details.hidden=true;footer.replaceChildren(details,status,actions);
    panel.append(header,body,footer);doc.body.append(panel);
    function report(message,error=false){if(closed)return;status.textContent=message;status.dataset.error=String(error);}
    const busy=()=>!!operationController||!!uploadController;
    function sync(){
      if(closed)return;
      const working=busy(),preparing=!!prepareController;panel.setAttribute('aria-busy',String(working||preparing||searching));
      insert.disabled=background.disabled=working||preparing||!selectedAsset;
      cancel.hidden=!working&&!preparing&&!searching;remove.disabled=working||!selected||selected.kind!=='image';
      uploadButton.disabled=working;input.disabled=working;searchButton.disabled=working||searching;color.disabled=working;
      for(const tab of tabButtons.values())tab.disabled=working;
      for(const child of filters.children)child.disabled=working;
      for(const child of suggestions.children)child.disabled=working||searching;
      more.disabled=working||searching;
    }
    function objectURL(value){const blob=typeof value==='string'?new global.Blob([value],{type:'image/svg+xml'}):value;const url=global.URL.createObjectURL(blob);urls.add(url);return url;}
    function releaseURL(url){if(url){global.URL.revokeObjectURL(url);urls.delete(url);}}
    function thumbnail(item){return item.kind==='photo'?item.thumbnail:item.kind==='image'?objectURL(item.file):byId.has(item.id)?objectURL(originalSVG(item,color.value)):svgUrl(item,color.value);}
    function setSelected(item){
      if(busy()||closed)return;
      prepareController?.abort();prepareController=null;
      selected=item;selectedAsset=null;const own=++assetGeneration;
      details.hidden=!item;if(item)collapseCover();
      for(const tile of grid.children)tile.setAttribute('aria-pressed',String(tile.dataset.id===item?.id));
      image.removeAttribute('src');releaseURL(previewURL);previewURL=null;
      name.textContent=item?.name||'Choose an element';name.title=item?.name||'';credit.textContent=item?item.source+' · '+item.author:'Shapes work offline.';credit.title=credit.textContent;
      license.hidden=!item?.license.url;license.textContent=item?.license.title||'';
      if(item?.license.url)license.href=item.license.url;else license.removeAttribute('href');
      sourceLink.hidden=!item?.sourceUrl;if(item?.sourceUrl)sourceLink.href=item.sourceUrl;else sourceLink.removeAttribute('href');
      colorLabel.hidden=!!item?.kind;remove.hidden=item?.kind!=='image';imageHint.hidden=!item?.kind;sync();
      if(!item)return Promise.resolve(null);
      const controller=new global.AbortController();prepareController=controller;sync();
      report('Preparing '+item.name+'…');
      return createAsset(item,{color:color.value,signal:controller.signal,fetch:options.fetch}).then(asset=>{
        if(closed||own!==assetGeneration)return;
        selectedAsset=asset;previewURL=objectURL(asset.file);image.src=previewURL;
        report(item.name+' · '+item.license.title);
        return asset;
      }).catch(error=>{if(!closed&&own===assetGeneration)report(error?.name==='AbortError'?'Preparation cancelled. Select the image to try again.':error.message||'This element could not be prepared.',error?.name!=='AbortError');})
        .finally(()=>{if(prepareController===controller){prepareController=null;sync();}});
    }
    const MIME='application/x-showave-design-element';
    function render(items){
      for(const child of grid.children){const img=child.querySelector('img');if(img?.src?.startsWith('blob:'))releaseURL(img.src);}
      grid.replaceChildren();
      if(!items.length)grid.append(element('div','ol-design-library-empty',source==='online'?'Search icons such as camera, music or celebration.':source==='photos'?'Search real photos from Wikimedia Commons, such as people clapping or stage lighting.':source==='images'?'Upload your own images, then search them by filename.':'No matching elements. Try a shorter search.'));
      for(const item of items){
        const tile=button('','ol-design-library-item'),img=element('img'),label=element('span','',item.name);tile.dataset.id=item.id;tile.title=item.name+' · '+item.source;tile.setAttribute('aria-label',item.name+' · '+item.source);tile.setAttribute('aria-pressed',String(selected?.id===item.id));
        img.alt='';img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.src=thumbnail(item);tile.append(img,label);
        if(item.kind)tile.classList.add('ol-design-library-image-item');
        tile.addEventListener('click',()=>setSelected(item));
        tile.draggable=!!options.dropTarget;
        tile.addEventListener('dragstart',event=>{
          if(busy()||closed||!options.dropTarget?.isConnected){event.preventDefault();return;}
          tokens.clear();dragToken=global.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now();tokens.set(dragToken,item);
          event.dataTransfer.setData(MIME,dragToken);event.dataTransfer.effectAllowed='copy';
        });
        tile.addEventListener('dragend',()=>{tokens.clear();dragToken=null;options.dropTarget?.classList.remove('ol-design-drop-active');});grid.append(tile);
      }
      grid.classList.toggle('has-images',source==='photos'||source==='images');
      more.hidden=!['online','photos'].includes(source)||!hasMore;sync();
    }
    function refresh(){
      for(const [key,tab] of tabButtons){tab.setAttribute('aria-selected',String(source===key));tab.tabIndex=source===key?0:-1;}
      filters.hidden=source!=='builtin';searchButton.hidden=!['online','photos'].includes(source);upload.hidden=source!=='images';suggestions.hidden=source!=='photos';
      colorLabel.hidden=source==='photos'||source==='images'||!!selected?.kind;imageHint.hidden=!['photos','images'].includes(source)&&!selected?.kind;
      input.placeholder=source==='photos'?'Search real photos (people, stage lights…)':source==='images'?'Search your images by filename':'Search elements';
      if(catalogue){const saved=catalogue.status();storageNote.textContent=saved.persistent?'Saved in this browser · '+saved.count+' / 60 images':saved.reason||'Images stay in this session.';storageNote.title=storageNote.textContent;}
      for(const [value,b] of filterButtons)b.setAttribute('aria-pressed',String(value===category));
      render(source==='builtin'?local(input.value,category):source==='online'?online:source==='photos'?photoResults:catalogue?.list(input.value)||[]);
    }
    async function runSearch(expanded=false){
      if(!['online','photos'].includes(source)||busy())return;
      const library=source,session=library==='online'?searchSession:photoSearch,own=++searchGeneration;
      if(!session){report('The photo library is unavailable. Use My Images or Shapes.',true);return;}
      if(input.value.trim().length<2){session.cancel();online=[];photoResults=[];hasMore=false;refresh();report('Type at least two letters to search.');return;}
      searching=true;report(library==='online'?'Searching online icons…':'Searching Wikimedia Commons photos…');sync();
      try{
        const result=await session.run(input.value,{fetch:options.fetch,...(library==='online'?{limit:expanded?999:64}:{offset:expanded?photoOffset:0})});
        if(closed||result.stale||source!==library||own!==searchGeneration)return;
        if(library==='online')online=result.records;
        else{photoResults=expanded?[...new Map([...photoResults,...result.records].map(item=>[item.id,item])).values()]:result.records;photoOffset=result.offset;}
        hasMore=result.more;refresh();
        const count=library==='online'?online.length:photoResults.length;
        report(count?(library==='online'?count+' icons · MIT collections via Iconify':count+' photos · creator and license shown below. Keep the attribution with your production.'):'No matching '+(library==='online'?'icons':'photos with supported rights metadata')+'. Try another search.');
      }catch(error){if(!closed&&source===library&&own===searchGeneration){hasMore=false;refresh();report(error.message||'Cannot reach the library. Shapes and My Images remain available.',true);}}
      finally{if(own===searchGeneration){searching=false;sync();}}
    }
    function changeSource(value){
      if(busy()||closed)return;collapseCover();source=value;searchGeneration++;searchSession.cancel();photoSearch?.cancel();searching=false;setSelected(null);hasMore=false;refresh();
      report(value==='builtin'?'Original shapes · available offline':value==='online'?'Search Tabler, Phosphor and Heroicons · requires internet':value==='photos'?'Real photos from Wikimedia Commons · select to view creator, license and source.':'Upload only the images you choose. PNG and WebP transparency is preserved.');
      if(['online','photos'].includes(value)&&input.value.trim().length>=2)runSearch();
    }
    for(const [key,tab] of tabButtons)listen(tab,'click',()=>changeSource(key));
    listen(tabs,'keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||busy())return;event.preventDefault();const keys=[...tabButtons.keys()],at=keys.indexOf(source),key=keys[event.key==='Home'?0:event.key==='End'?keys.length-1:(at+(event.key==='ArrowRight'?1:-1)+keys.length)%keys.length];changeSource(key);tabButtons.get(key).focus();});
    listen(input,'input',()=>{collapseCover();if(source==='builtin'||source==='images')refresh();else{searchGeneration++;searchSession.cancel();photoSearch?.cancel();searching=false;online=[];photoResults=[];hasMore=false;refresh();report('Press Search or Enter to find '+(source==='photos'?'photos':'icons')+'.');}});
    listen(form,'submit',event=>{event.preventDefault();if(['online','photos'].includes(source))runSearch();else refresh();});
    listen(more,'click',()=>runSearch(true));
    listen(color,'input',()=>{refresh();if(selected)setSelected(selected);});
    function cancelTask(){
      searchGeneration++;searchSession.cancel();photoSearch?.cancel();searching=false;assetGeneration++;
      prepareController?.abort();prepareController=null;operationController?.abort();uploadController?.abort();
      if(!busy())sync();report('Cancelled. Already added images and layers are kept.');
    }
    async function add(item=selected,mode='element',point=null){
      if(closed||busy()||!item||mode==='background'&&options.supportsBackground===false)return;
      const cached=selected?.id===item.id?selectedAsset:null;prepareController?.abort();prepareController=null;assetGeneration++;
      const controller=new global.AbortController();operationController=controller;sync();report('Adding '+item.name+'…');
      try{
        const asset=cached||await createAsset(item,{color:color.value,signal:controller.signal,fetch:options.fetch});
        if(controller.signal.aborted||closed)throw abortError();
        const result=await options.onInsert(asset,{mode,point,signal:controller.signal});
        if(controller.signal.aborted||closed)throw abortError();
        if(result===false)throw Error('The element was not added. Choose a target and try again.');
        report(asset.name+(mode==='background'?' added as a background.':' added.'));
      }catch(error){if(!closed)report(controller.signal.aborted||error?.name==='AbortError'?'Adding cancelled. Already committed layers are kept.':error.message||'The element could not be added. Please try again.',!controller.signal.aborted&&error?.name!=='AbortError');}
      finally{if(operationController===controller){operationController=null;sync();}}
    }
    listen(insert,'click',()=>add());listen(background,'click',()=>add(selected,'background'));listen(cancel,'click',cancelTask);
    listen(uploadButton,'click',()=>uploadInput.click());
    listen(uploadInput,'change',async()=>{
      const files=Array.from(uploadInput.files||[]);uploadInput.value='';if(!files.length||busy()||closed)return;
      if(!catalogue){report('My Images is unavailable. Add a local Image source instead.',true);return;}
      if(files.length>20){report('Choose up to 20 images at a time.',true);return;}
      prepareController?.abort();prepareController=null;assetGeneration++;
      const controller=new global.AbortController();uploadController=controller;sync();let count=0,last=null;const errors=[];
      try{
        for(const [index,file] of files.entries()){
          if(controller.signal.aborted||closed)break;report((index+1)+' / '+files.length+' · Preparing '+file.name+'…');
          try{last=await catalogue.importFile(file,{signal:controller.signal});count++;}
          catch(error){if(controller.signal.aborted||error?.name==='AbortError')break;errors.push(file.name+': '+(error.message||String(error)));}
        }
      }finally{
        if(uploadController===controller)uploadController=null;refresh();
        if(!closed){
          const summary=controller.signal.aborted?'Upload cancelled. '+count+' already added image(s) kept.':count+' image(s) added.'+(errors.length?' '+errors.length+' could not be added. '+errors[0]:'');
          if(last&&!controller.signal.aborted){const preparation=setSelected(last),own=assetGeneration;await preparation;if(!closed&&own===assetGeneration)report(summary,!!errors.length);}
          else report(summary,!!errors.length);sync();
        }
      }
    });
    listen(remove,'click',async()=>{
      if(busy()||!selected||selected.kind!=='image'||!catalogue)return;
      const item=selected;setSelected(null);await catalogue.remove(item.id);if(!closed){refresh();report(item.name+' removed from My Images. Existing scene sources are kept.');}
    });
    if(catalogue){listeners.push(catalogue.subscribe(()=>{if(!closed&&source==='images')refresh();}));catalogue.ready.then(()=>{if(!closed&&source==='images')refresh();});}
    if(options.dropTarget){
      const target=options.dropTarget;
      const isOwned=event=>!!dragToken&&tokens.has(dragToken)&&Array.from(event.dataTransfer?.types||[]).includes(MIME);
      listen(target,'dragover',event=>{if(!isOwned(event)||busy())return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';target.classList.add('ol-design-drop-active');},true);
      listen(target,'dragleave',event=>{if(!target.contains(event.relatedTarget))target.classList.remove('ol-design-drop-active');},true);
      listen(target,'drop',event=>{
        const token=event.dataTransfer?.getData(MIME),item=tokens.get(token);if(!item||token!==dragToken||closed||busy())return;
        event.preventDefault();event.stopImmediatePropagation();target.classList.remove('ol-design-drop-active');tokens.delete(token);dragToken=null;
        const bounds=target.getBoundingClientRect();if(!(bounds.width>0&&bounds.height>0)){report('The canvas is not visible. Use Add or select Preview.',true);return;}
        add(item,'element',{x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))});
      },true);
    }
    let drag=null;
    listen(header,'pointerdown',event=>{if(event.button!==0||event.target.closest('button'))return;const box=panel.getBoundingClientRect();drag={x:event.clientX,y:event.clientY,left:box.left,top:box.top};header.setPointerCapture?.(event.pointerId);event.preventDefault();});
    listen(header,'pointermove',event=>{if(!drag)return;const box=panel.getBoundingClientRect();panel.style.right='auto';panel.style.left=Math.max(4,Math.min(global.innerWidth-box.width-4,drag.left+event.clientX-drag.x))+'px';panel.style.top=Math.max(4,Math.min(global.innerHeight-42,drag.top+event.clientY-drag.y))+'px';});
    listen(header,'pointerup',()=>{drag=null;});listen(header,'pointercancel',()=>{drag=null;});
    const api={close(){if(closed)return;cancelTask();closed=true;tokens.clear();dragToken=null;options.dropTarget?.classList.remove('ol-design-drop-active');listeners.forEach(fn=>fn());for(const url of urls)global.URL.revokeObjectURL(url);urls.clear();panel.remove();if(active===api)active=null;},cancel:cancelTask,element:panel};
    listen(close,'click',api.close);listen(panel,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();api.close();}});
    active=api;refresh();input.focus({preventScroll:true});return api;
  }
  global.OpenLiveDesignLibrary=Object.freeze({open,local,search,createAsset,sanitizeSVG,createSearchSession,collections:COLLECTIONS});
})(typeof window!=='undefined'?window:globalThis);
