/* Original OOXML PowerPoint player. ZIP/XML, decoded assets and canvases live in
   RAM. No Office automation, content conversion, slide Files or saved copies. */
(function(root){
  'use strict';
  const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const EMU=9525,MAX_SLIDES=200,CACHE=3,IMAGE_CACHE=12,MAX_PACKAGE=256*1024*1024;
  const ext=name=>String(name||'').split('.').pop().toLowerCase();
  const valid=file=>!!file&&['pptx','ppsx','pptm','ppsm'].includes(ext(file.name));
  const cancelled=()=>Object.assign(Error('PowerPoint player preparation cancelled.'),{name:'AbortError'});
  const kids=(node,name)=>Array.from(node?.childNodes||[]).filter(n=>n.nodeType===1&&(!name||n.localName===name));
  const child=(node,name)=>kids(node,name)[0]||null;
  const all=(node,name)=>Array.from(node?.getElementsByTagNameNS?.('*',name)||[]);
  const first=(node,name)=>all(node,name)[0]||null;
  const attr=(node,name,fallback='')=>node?.getAttribute?.(name)||fallback;
  const rid=(node,name='id')=>node?.getAttributeNS?.(R,name)||attr(node,'r:'+name);
  const number=(node,name,fallback=0)=>{const value=Number(attr(node,name));return attr(node,name)===''||!Number.isFinite(value)?fallback:value;};
  const px=(node,name,fallback=0)=>number(node,name,fallback*EMU)/EMU;
  const truth=value=>value==='1'||value==='true';
  const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
  const safeLink=value=>/^(https?:|mailto:)/i.test(String(value||''))?String(value):'';
  function partPath(owner,target){
    if(!target||/^[a-z][a-z\d+.-]*:/i.test(target))return null;
    let decoded=target;try{decoded=decodeURIComponent(target);}catch(_){}
    const output=decoded.startsWith('/')?[]:owner.split('/').slice(0,-1);
    for(const segment of decoded.split('/')){if(!segment||segment==='.')continue;if(segment==='..'){if(!output.length)return null;output.pop();}else output.push(segment);}
    return output.join('/');
  }
  function validateZip(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;
    for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)if(view.getUint32(n,true)===0x06054b50){eocd=n;break;}
    if(eocd<0)throw Error('This is not an OOXML PowerPoint ZIP package.');
    const count=view.getUint16(eocd+10,true),offset=view.getUint32(eocd+16,true);
    if(count===65535||offset===0xffffffff)throw Error('ZIP64 PowerPoint packages are not supported.');
    if(offset>eocd)throw Error('The PowerPoint package directory is damaged.');
    let at=offset,total=0;const entries=new Map(),ranges=[];
    for(let n=0;n<count;n++){
      if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)throw Error('The PowerPoint package directory is damaged.');
      const size=view.getUint32(at+24,true),compressed=view.getUint32(at+20,true),flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),local=view.getUint32(at+42,true),nameLength=view.getUint16(at+28,true);total+=size;
      if(flags&1)throw Error('Encrypted PowerPoint packages must be unlocked before loading.');
      if(size>MAX_PACKAGE||total>MAX_PACKAGE)throw Error('This PowerPoint exceeds the 256 MB decoded package limit.');
      if(nameLength>1024||at+46+nameLength>eocd||local+30>offset||view.getUint32(local,true)!==0x04034b50)throw Error('The PowerPoint local ZIP header is damaged.');
      const localFlags=view.getUint16(local+6,true),localMethod=view.getUint16(local+8,true),localCompressed=view.getUint32(local+18,true),localSize=view.getUint32(local+22,true),localNameLength=view.getUint16(local+26,true),localExtra=view.getUint16(local+28,true);
      if(localFlags!==flags||localMethod!==method||localNameLength!==nameLength||(!(flags&8)&&(localCompressed!==compressed||localSize!==size))||((flags&8)&&((localCompressed&&localCompressed!==compressed)||(localSize&&localSize!==size))))throw Error('PowerPoint ZIP size/header declarations disagree.');
      const start=local+30+localNameLength+localExtra,end=start+compressed;if(end>offset)throw Error('The PowerPoint ZIP content range is damaged.');
      const nameBytes=bytes.subarray(at+46,at+46+nameLength),localBytes=bytes.subarray(local+30,local+30+localNameLength);
      if(nameBytes.some((value,n)=>value!==localBytes[n]))throw Error('PowerPoint ZIP filenames disagree.');
      const name=flags&2048?new TextDecoder().decode(nameBytes):String.fromCharCode(...nameBytes);if(entries.has(name))throw Error('The PowerPoint package has duplicate ZIP parts.');entries.set(name,size);ranges.push([local,end]);
      at+=46+view.getUint16(at+28,true)+view.getUint16(at+30,true)+view.getUint16(at+32,true);
    }
    if(at>eocd)throw Error('The PowerPoint package directory is damaged.');ranges.sort((a,b)=>a[0]-b[0]);for(let n=1;n<ranges.length;n++)if(ranges[n][0]<ranges[n-1][1])throw Error('The PowerPoint ZIP contains overlapping parts.');return entries;
  }
  const mimeFor=name=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp',bmp:'image/bmp',
    mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',wmv:'video/x-ms-wmv',avi:'video/x-msvideo',
    mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',opus:'audio/ogg'}[ext(name)]||'application/octet-stream');
  function multiply(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
  const point=(m,x,y)=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
  function transform(x){
    const angle=x.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),fx=x.flipH?-1:1,fy=x.flipV?-1:1;
    return [c*fx,s*fx,-s*fy,c*fy,x.x+x.w/2-c*fx*x.w/2+s*fy*x.h/2,x.y+x.h/2-s*fx*x.w/2-c*fy*x.h/2];
  }
  function box(node,fallback){
    const off=child(node,'off'),size=child(node,'ext');
    return {x:px(off,'x',fallback?.x||0),y:px(off,'y',fallback?.y||0),w:px(size,'cx',fallback?.w||0),h:px(size,'cy',fallback?.h||0),
      rotation:number(node,'rot')/60000,flipH:truth(attr(node,'flipH')),flipV:truth(attr(node,'flipV'))};
  }
  function colour(node,theme,fallback='#000000'){
    if(!node)return fallback;
    const value=['srgbClr','schemeClr','sysClr','prstClr'].includes(node.localName)?node:kids(node).find(n=>['srgbClr','schemeClr','sysClr','prstClr'].includes(n.localName));
    if(!value)return fallback;
    let raw=attr(value,'val'),hex=value.localName==='schemeClr'?theme.colors[theme.map[raw]||raw]||fallback:value.localName==='sysClr'?attr(value,'lastClr','000000'):raw;
    const named={black:'000000',white:'ffffff',red:'ff0000',green:'008000',blue:'0000ff',yellow:'ffff00',gray:'808080',orange:'ffa500',purple:'800080'};
    hex=named[hex]||hex;const rgba=hex.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if(hex.startsWith('#'))hex=hex.slice(1);if(!rgba&&!/^[a-f\d]{6}$/i.test(hex))return fallback;
    let rgb=rgba?rgba.slice(1,4).map(Number):[0,2,4].map(n=>parseInt(hex.slice(n,n+2),16)),alpha=rgba&&rgba[4]!==undefined?Number(rgba[4]):1;
    for(const effect of kids(value)){const v=number(effect,'val')/100000;
      if(effect.localName==='tint')rgb=rgb.map(c=>c+(255-c)*v);
      if(effect.localName==='shade'||effect.localName==='lumMod')rgb=rgb.map(c=>c*v);
      if(effect.localName==='lumOff')rgb=rgb.map(c=>c+255*v);
      if(effect.localName==='alpha')alpha=v;
    }
    return `rgba(${rgb.map(c=>Math.round(bounded(c,0,255))).join(',')},${bounded(alpha,0,1)})`;
  }
  function fill(node,theme,w,h){
    if(!node||child(node,'noFill'))return null;
    const solid=child(node,'solidFill');if(solid)return colour(solid,theme);
    const gradient=child(node,'gradFill');if(gradient){
      const angle=number(child(gradient,'lin'),'ang')/60000*Math.PI/180;
      return {gradient:true,angle,radial:!!child(gradient,'path'),stops:kids(child(gradient,'gsLst'),'gs').map(stop=>({offset:bounded(number(stop,'pos')/100000,0,1),color:colour(stop,theme)}))};
    }
    return null;
  }
  function paintFill(ctx,value,w,h){
    if(typeof value==='string')return value;if(!value?.gradient)return null;
    const g=value.radial?ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.max(w,h)/2):ctx.createLinearGradient(w/2-Math.cos(value.angle)*w/2,h/2-Math.sin(value.angle)*h/2,w/2+Math.cos(value.angle)*w/2,h/2+Math.sin(value.angle)*h/2);
    for(const stop of value.stops)g.addColorStop(stop.offset,stop.color);return g;
  }
  function applyTransform(ctx,x){ctx.translate(x.x+x.w/2,x.y+x.h/2);ctx.rotate(x.rotation*Math.PI/180);ctx.scale(x.flipH?-1:1,x.flipV?-1:1);ctx.translate(-x.w/2,-x.h/2);}
  function pathGeometry(ctx,node,w,h){
    ctx.beginPath();const custom=child(node,'custGeom'),preset=attr(child(node,'prstGeom'),'prst','rect');
    if(custom){
      const guides={w,h,hc:w/2,vc:h/2,wd2:w/2,hd2:h/2,wd4:w/4,hd4:h/4,l:0,t:0,r:w,b:h};
      const val=(raw,axis)=>{const n=Number(raw);return Number.isFinite(n)?n:guides[raw]??(axis==='x'?w:h);};
      for(const route of kids(child(custom,'pathLst'),'path')){
        const pw=number(route,'w',w),ph=number(route,'h',h),sx=w/(pw||w||1),sy=h/(ph||h||1);let current={x:0,y:0};
        const p=n=>({x:val(attr(n,'x'),'x')*sx,y:val(attr(n,'y'),'y')*sy});
        for(const command of kids(route)){
          const pts=kids(command,'pt').map(p);
          if(command.localName==='moveTo'&&pts[0]){ctx.moveTo(pts[0].x,pts[0].y);current=pts[0];}
          if(command.localName==='lnTo'&&pts[0]){ctx.lineTo(pts[0].x,pts[0].y);current=pts[0];}
          if(command.localName==='cubicBezTo'&&pts.length===3){ctx.bezierCurveTo(...pts.flatMap(v=>[v.x,v.y]));current=pts[2];}
          if(command.localName==='quadBezTo'&&pts.length===2){ctx.quadraticCurveTo(...pts.flatMap(v=>[v.x,v.y]));current=pts[1];}
          if(command.localName==='arcTo'){
            const rx=val(attr(command,'wR'),'x')*sx,ry=val(attr(command,'hR'),'y')*sy,start=number(command,'stAng')/60000*Math.PI/180,sweep=number(command,'swAng')/60000*Math.PI/180;
            const cx=current.x-Math.cos(start)*rx,cy=current.y-Math.sin(start)*ry;
            if(rx>0&&ry>0)ctx.ellipse(cx,cy,rx,ry,0,start,start+sweep,sweep<0);
            current={x:cx+Math.cos(start+sweep)*rx,y:cy+Math.sin(start+sweep)*ry};
          }
          if(command.localName==='close')ctx.closePath();
        }
      }return;
    }
    if(['ellipse','arc','pie','donut'].includes(preset)){ctx.ellipse(w/2,h/2,Math.max(0,w/2),Math.max(0,h/2),0,0,Math.PI*2);return;}
    if(preset==='line'){ctx.moveTo(0,0);ctx.lineTo(w,h);return;}
    if(preset==='roundRect'){const r=Math.min(w,h)*.16;ctx.moveTo(r,0);ctx.lineTo(w-r,0);ctx.quadraticCurveTo(w,0,w,r);ctx.lineTo(w,h-r);ctx.quadraticCurveTo(w,h,w-r,h);ctx.lineTo(r,h);ctx.quadraticCurveTo(0,h,0,h-r);ctx.lineTo(0,r);ctx.quadraticCurveTo(0,0,r,0);ctx.closePath();return;}
    const polygons={triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],
      parallelogram:[[.2,0],[1,0],[.8,1],[0,1]],trapezoid:[[.2,0],[.8,0],[1,1],[0,1]],chevron:[[0,0],[.7,0],[1,.5],[.7,1],[0,1],[.3,.5]],
      rightArrow:[[0,.25],[.65,.25],[.65,0],[1,.5],[.65,1],[.65,.75],[0,.75]],leftArrow:[[1,.25],[.35,.25],[.35,0],[0,.5],[.35,1],[.35,.75],[1,.75]]};
    let vertices=polygons[preset];
    if(['pentagon','hexagon','heptagon','octagon','decagon','star5','star6','star8'].includes(preset)){
      const sides={pentagon:5,hexagon:6,heptagon:7,octagon:8,decagon:10,star5:10,star6:12,star8:16}[preset],star=preset.startsWith('star');
      vertices=Array.from({length:sides},(_,i)=>{const angle=-Math.PI/2+i*Math.PI*2/sides,r=star&&i%2?.22:.5;return [.5+Math.cos(angle)*r,.5+Math.sin(angle)*r];});
    }
    if(vertices){vertices.forEach((p,n)=>ctx[n?'lineTo':'moveTo'](p[0]*w,p[1]*h));ctx.closePath();return;}
    ctx.rect(0,0,w,h);
  }
  function inheritedPlaceholder(node,layout,master){
    const ph=first(node,'ph');if(!ph)return [];
    const type=attr(ph,'type','body'),idx=attr(ph,'idx','0');
    const find=tree=>all(tree,'sp').find(shape=>{const candidate=first(shape,'ph');return candidate&&(attr(candidate,'idx','0')===idx||attr(candidate,'type','body')===type);});
    return [find(layout),find(master)].filter(Boolean);
  }
  function textStyle(node,theme,base={}){
    const latin=child(node,'latin'),size=attr(node,'sz'),face=attr(latin,'typeface');
    return {...base,...(size?{size:Number(size)/100*4/3}:{}),...(face?{face:face.startsWith('+mj')?theme.major:face.startsWith('+mn')?theme.minor:face}:{}),
      ...(attr(node,'b')!==''?{bold:truth(attr(node,'b'))}:{}),...(attr(node,'i')!==''?{italic:truth(attr(node,'i'))}:{}),
      ...(attr(node,'u')!==''?{underline:!['none','0'].includes(attr(node,'u'))}:{}),...(child(node,'solidFill')?{color:colour(child(node,'solidFill'),theme)}:{}),
      ...(attr(node,'spc')!==''?{spacing:number(node,'spc')/100*4/3}:{})};
  }
  const font=style=>`${style.italic?'italic ':''}${style.bold?'700':'400'} ${Math.max(1,style.size||24)}px "${String(style.face||'Segoe UI').replace(/["\\]/g,'')}", Arial, sans-serif`;
  function textModel(tx,theme,defaults){
    if(!tx)return null;
    const body=child(tx,'bodyPr'),fit=child(body,'normAutofit'),scale=fit?number(fit,'fontScale',100000)/100000:1;
    const paras=kids(tx,'p').map((p,index)=>{
      const ppr=child(p,'pPr'),level=number(ppr,'lvl'),fallback=defaults?.[level]||defaults?.[0],defaultRun=textStyle(child(fallback,'defRPr'),theme,{size:24,face:theme.minor,color:colour(child(child(tx,'style'),'fontRef'),theme,'#000000')});
      const styled=textStyle(child(ppr,'defRPr'),theme,defaultRun),runs=[];
      for(const run of kids(p)){
        if(run.localName==='br'){runs.push({text:'\n',...styled,size:styled.size*scale});continue;}
        if(!['r','fld'].includes(run.localName))continue;
        const style=textStyle(child(run,'rPr'),theme,styled);runs.push({text:child(run,'t')?.textContent||'',...style,size:style.size*scale});
      }
      if(!runs.length)runs.push({text:'',...styled,size:styled.size*scale});
      const choose=name=>child(ppr,name)||child(fallback,name),space=name=>{const value=choose(name);return child(value,'spcPts')?number(child(value,'spcPts'),'val')/100*4/3:0;};
      const char=choose('buChar'),auto=choose('buAutoNum'),bullet=char?attr(char,'char','•'):auto?String(number(auto,'startAt',1)+index)+'.':'';
      return {runs,align:attr(ppr,'algn',attr(fallback,'algn','l')),margin:px(ppr,'marL',px(fallback,'marL')),indent:px(ppr,'indent',px(fallback,'indent')),bullet,
        before:space('spcBef'),after:space('spcAft'),line:space('lnSpc'),lineRatio:child(choose('lnSpc'),'spcPct')?number(child(choose('lnSpc'),'spcPct'),'val')/100000:null};
    });
    return {paras,left:px(body,'lIns',9.6),right:px(body,'rIns',9.6),top:px(body,'tIns',4.8),bottom:px(body,'bIns',4.8),anchor:attr(body,'anchor','t'),wrap:attr(body,'wrap')!=='none',vertical:attr(body,'vert','horz')};
  }
  function drawText(ctx,model,w,h){
    if(!model)return;
    const lines=[];let total=0;
    for(const para of model.paras){
      let line=[],width=0,lineHeight=0;const available=Math.max(1,w-model.left-model.right-para.margin),push=()=>{
        const height=para.line||Math.max(lineHeight,para.runs[0]?.size||24)*(para.lineRatio||1.16);lines.push({items:line,width,height,para});total+=height;line=[];width=0;lineHeight=0;};
      total+=para.before;
      const tokens=para.runs.flatMap(run=>run.text.split(/(\n|\s+)/).filter(Boolean).map(text=>({...run,text})));
      if(para.bullet)tokens.unshift({...para.runs[0],text:para.bullet+' '});
      for(const token of tokens){
        if(token.text==='\n'){push();continue;}
        ctx.font=font(token);let tw=ctx.measureText(token.text).width+(token.spacing||0)*Math.max(0,token.text.length-1);
        if(model.wrap&&width>0&&width+tw>available&&!/^\s+$/.test(token.text)){push();}
        if(model.wrap&&tw>available&&Array.from(token.text).length>1){
          for(const char of Array.from(token.text)){ctx.font=font(token);const cw=ctx.measureText(char).width+(token.spacing||0);if(width+cw>available&&line.length)push();line.push({...token,text:char,width:cw});width+=cw;lineHeight=Math.max(lineHeight,token.size);}continue;
        }
        if(!line.length&&/^\s+$/.test(token.text))continue;
        line.push({...token,width:tw});width+=tw;lineHeight=Math.max(lineHeight,token.size);
      }
      push();total+=para.after;
    }
    let y=model.top+(model.anchor==='ctr'?Math.max(0,h-model.top-model.bottom-total)/2:model.anchor==='b'?Math.max(0,h-model.top-model.bottom-total):0),previous=null;
    ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();ctx.textBaseline='alphabetic';
    for(const line of lines){
      if(previous!==line.para)y+=line.para.before;
      const available=w-model.left-model.right-line.para.margin;
      let x=model.left+line.para.margin+(line.para.align==='ctr'?(available-line.width)/2:line.para.align==='r'?available-line.width:0)+line.para.indent;
      for(const token of line.items){
        ctx.font=font(token);ctx.fillStyle=token.color||'#000';const baseline=y+Math.min(line.height,token.size||24)*.82;
        if(token.spacing&&typeof ctx.letterSpacing==='string')ctx.letterSpacing=token.spacing+'px';
        ctx.fillText(token.text,x,baseline);if(typeof ctx.letterSpacing==='string')ctx.letterSpacing='0px';
        if(token.underline){ctx.save();ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=Math.max(.5,token.size/25);ctx.beginPath();ctx.moveTo(x,baseline+token.size*.08);ctx.lineTo(x+token.width,baseline+token.size*.08);ctx.stroke();ctx.restore();}x+=token.width;
      }
      y+=line.height;const next=lines[lines.indexOf(line)+1];if(next?.para!==line.para)y+=line.para.after;previous=line.para;
    }
    ctx.restore();
  }
  async function openPlayer(originalFile,options={}){
    if(!valid(originalFile))throw Error('Choose an OOXML PowerPoint (.pptx, .ppsx, .pptm or .ppsm). Legacy .ppt/.pps files are not supported by this independent player.');
    const doc=options.document||root.document,signal=options.signal,zip=options.fflate||root.fflate,parse=options.DOMParser||root.DOMParser;
    if(!zip?.unzipSync||!parse)throw Error('The independent PowerPoint ZIP/XML player is unavailable in this build.');
    if(!doc?.createElement)throw Error('PowerPoint playback needs a browser canvas.');
    const check=()=>{if(signal?.aborted)throw cancelled();},progress=value=>{try{options.onProgress?.(value);options.onImportProgress?.(value);}catch(_){}};
    const size=Number(originalFile.size);if(!Number.isSafeInteger(size)||size<1||size>MAX_PACKAGE)throw Error('Choose a PowerPoint package up to 256 MB.');
    const data=new Uint8Array(size);
    for(let offset=0;offset<size;offset+=1048576){check();const end=Math.min(size,offset+1048576),chunk=new Uint8Array(await originalFile.slice(offset,end).arrayBuffer());check();if(chunk.byteLength!==end-offset)throw Error('The original PowerPoint changed while it was being read.');data.set(chunk,offset);progress({stage:'read',loaded:end,total:size,unit:'bytes',percent:end/size*100,message:'Reading original PowerPoint'});await new Promise(resolve=>root.setTimeout(resolve,0));}
    check();const declaredParts=validateZip(data);progress({stage:'document',percent:null,message:'Reading original slide structure'});
    const parts=zip.unzipSync(data,{filter:entry=>!/(?:^|\/)vbaProject\.bin$/i.test(entry.name)}),xmls=new Map(),imageCache=new Map(),imageOwners=new Map(),fontChecks=new Map(),urls=new Map(),models=new Map(),cache=new Map(),views=new Set(),warnings=[];
    let closed=false,refs=0,tail=Promise.resolve();
    for(const [name,bytes]of Object.entries(parts))if(bytes.byteLength!==declaredParts.get(name))throw Error('Decoded PowerPoint ZIP sizes do not match the original directory.');
    const textDecoder=new TextDecoder('utf-8');
    const xml=part=>{
      if(!part||!parts[part])return null;if(xmls.has(part))return xmls.get(part);
      const text=textDecoder.decode(parts[part]);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('PowerPoint XML must not contain external entities.');
      const parsed=new parse().parseFromString(text,'application/xml');if(first(parsed,'parsererror'))throw Error('A PowerPoint XML part is damaged: '+part);
      xmls.set(part,parsed);return parsed;
    };
    const rels=part=>{const filename=part.slice(part.lastIndexOf('/')+1),directory=part.slice(0,part.lastIndexOf('/')+1),result=new Map();
      for(const node of all(xml(directory+'_rels/'+filename+'.rels'),'Relationship')){const external=attr(node,'TargetMode')==='External',target=attr(node,'Target');result.set(attr(node,'Id'),{id:attr(node,'Id'),type:attr(node,'Type'),target,external,path:external?null:partPath(part,target)});}return result;};
    const presentation=xml('ppt/presentation.xml');if(!presentation)throw Error('The package does not contain a PowerPoint presentation.');
    const presentationRels=rels('ppt/presentation.xml'),slideParts=all(presentation,'sldId').map(node=>presentationRels.get(rid(node))?.path).filter(Boolean);
    if(!slideParts.length||slideParts.length>MAX_SLIDES)throw Error('The independent player supports presentations with 1 to 200 slides.');
    const dimensions=first(presentation,'sldSz'),slideWidth=px(dimensions,'cx',1280),slideHeight=px(dimensions,'cy',720);
    if(['cx','cy'].some(name=>attr(dimensions,name)!==''&&!Number.isFinite(Number(attr(dimensions,name)))))throw Error('The PowerPoint has invalid slide dimensions.');
    if(!(Number.isFinite(slideWidth)&&Number.isFinite(slideHeight)&&slideWidth>0&&slideHeight>0&&slideWidth<=32768&&slideHeight<=32768))throw Error('The PowerPoint has invalid or excessive slide dimensions.');
    const scale=Math.min(1920/slideWidth,1080/slideHeight,2);
    const width=Math.max(1,Math.round(slideWidth*scale)),height=Math.max(1,Math.round(slideHeight*scale));
    const warn=(code,message,slide)=>{if(!warnings.some(w=>w.code===code&&w.slide===slide))warnings.push({code,message,slide});};
    if(Array.from(declaredParts.keys()).some(name=>/vbaProject\.bin$/i.test(name))||['pptm','ppsm'].includes(ext(originalFile.name)))warn('macros','Macros are never executed by the independent player.',null);
    if(first(presentation,'embeddedFontLst'))warn('embedded-fonts','PowerPoint embedded/obfuscated fonts are not loaded; installed browser fonts or fallbacks are used.',null);
    const themeFor=(masterPart,master)=>{
      const relationship=Array.from(rels(masterPart||'').values()).find(r=>r.type.endsWith('/theme')),theme=xml(relationship?.path),colors={dk1:'000000',lt1:'ffffff',dk2:'1f497d',lt2:'eeece1',accent1:'4f81bd',accent2:'c0504d',accent3:'9bbb59',accent4:'8064a2',accent5:'4bacc6',accent6:'f79646',hlink:'0000ff',folHlink:'800080'},map={tx1:'dk1',bg1:'lt1',tx2:'dk2',bg2:'lt2'};
      for(const item of kids(first(theme,'clrScheme'))){const value=kids(item)[0];colors[item.localName]=attr(value,'lastClr',attr(value,'val',colors[item.localName]));}
      const mapping=first(master,'clrMap');for(const key of ['tx1','bg1','tx2','bg2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'])if(attr(mapping,key))map[key]=attr(mapping,key);
      const fonts=first(theme,'fontScheme'),major=attr(child(child(fonts,'majorFont'),'latin'),'typeface','Segoe UI'),minor=attr(child(child(fonts,'minorFont'),'latin'),'typeface','Segoe UI');
      return {colors,map,major,minor,fillStyles:kids(first(theme,'fillStyleLst')),backgroundStyles:kids(first(theme,'bgFillStyleLst')),lineStyles:kids(first(theme,'lnStyleLst')),master};
    };
    function styleFill(node,theme){
      const explicit=fill(node,theme);if(explicit||child(node,'noFill'))return explicit;
      const ref=first(node?.parentNode,'fillRef'),idx=number(ref,'idx');if(idx>0){const item=idx>=1001?theme.backgroundStyles[idx-1001]:theme.fillStyles[idx-1];return item?fill({childNodes:[item]},{...theme,colors:{...theme.colors,phClr:colour(ref,theme)}})||colour(ref,theme):null;}return null;
    }
    function metadata(index,slidePart,slide,relationships){
      const notesRel=Array.from(relationships.values()).find(r=>r.type.endsWith('/notesSlide')),notesDoc=xml(notesRel?.path),notes=all(notesDoc,'sp').filter(sp=>attr(first(sp,'ph'),'type')==='body').map(sp=>all(sp,'t').map(t=>t.textContent).join(' ')).join('\n');
      const titleShape=all(slide,'sp').find(sp=>['title','ctrTitle'].includes(attr(first(sp,'ph'),'type')))||all(slide,'sp').filter(sp=>first(sp,'t')).sort((a,b)=>Math.max(0,...all(b,'rPr').map(r=>number(r,'sz')))-Math.max(0,...all(a,'rPr').map(r=>number(r,'sz'))))[0];
      const title=all(titleShape,'t').map(t=>t.textContent).join(' ').trim().slice(0,120)||'Slide '+(index+1);
      if(first(slide,'timing'))warn('animation','Animation/build timing is not yet supported; the slide displays its complete content.',index);
      if(first(slide,'transition'))warn('transition','PowerPoint transitions use the host Cut/Fade transition.',index);
      if(first(slide,'oleObj'))warn('ole','Embedded OLE objects are not executable; their stored picture is displayed where available.',index);
      if(first(slide,'relIds'))warn('smartart','SmartArt layout is not supported; an available stored fallback picture may be displayed.',index);
      return {index,title,notes,links:[],media:[],unsupported:[]};
    }
    function shapeModel(node,owner,relationships,theme,index,layout,master,meta){
      if(node.localName==='AlternateContent')return kids(child(node,'Fallback')||child(node,'Choice')).flatMap(n=>shapeModel(n,owner,relationships,theme,index,layout,master,meta));
      if(!['sp','pic','graphicFrame','grpSp','cxnSp'].includes(node.localName))return [];
      const inherited=inheritedPlaceholder(node,layout,master),props=child(node,'spPr')||child(node,'grpSpPr'),xfrm=child(props,'xfrm')||child(node,'xfrm')||inherited.map(sp=>first(sp,'xfrm')).find(Boolean),x=box(xfrm);
      const shape={type:node.localName,x,node,owner,relationships,theme,fill:styleFill(props,theme),line:child(props,'ln'),name:attr(first(node,'cNvPr'),'name'),children:[]};
      if(node.localName==='grpSp'){
        const off=child(xfrm,'chOff'),size=child(xfrm,'chExt');shape.childX=px(off,'x');shape.childY=px(off,'y');shape.childW=px(size,'cx',x.w||1);shape.childH=px(size,'cy',x.h||1);
        shape.children=kids(node).flatMap(childNode=>shapeModel(childNode,owner,relationships,theme,index,layout,master,meta));return [shape];
      }
      const tx=child(node,'txBody'),ph=first(node,'ph'),textType=['title','ctrTitle'].includes(attr(ph,'type'))?'titleStyle':ph?'bodyStyle':'otherStyle',masterDefaults=child(first(master,'txStyles'),textType);
      const defaults=Array.from({length:9},(_,n)=>child(child(tx,'lstStyle'),'lvl'+(n+1)+'pPr')||inherited.map(sp=>child(child(child(sp,'txBody'),'lstStyle'),'lvl'+(n+1)+'pPr')).find(Boolean)||child(masterDefaults,'lvl'+(n+1)+'pPr'));
      shape.text=textModel(tx,theme,defaults);
      if(shape.text?.vertical&&!['horz',''].includes(shape.text.vertical))warn('vertical-text','Vertical text is rendered horizontally by this player.',index);
      const blip=first(props,'blip')||first(child(node,'blipFill'),'blip'),embed=rid(blip,'embed')||rid(blip,'link');shape.image=relationships.get(embed)?.path;
      shape.imageFill=child(props,'blipFill')||child(node,'blipFill');shape.crop=child(shape.imageFill,'srcRect');
      const video=first(node,'videoFile'),audio=first(node,'audioFile'),embedded=all(node,'media').find(n=>rid(n,'embed')),mediaRel=relationships.get(rid(embedded,'embed')||rid(video,'link')||rid(audio,'link'));
      if(mediaRel){
        const type=video||mimeFor(mediaRel.path||mediaRel.target).startsWith('video')?'video':'audio',item={id:String(index)+':'+attr(first(node,'cNvPr'),'id',meta.media.length),type,mime:mimeFor(mediaRel.path||mediaRel.target),embedded:!!mediaRel.path,part:mediaRel.path||null};
        shape.media=item;meta.media.push(item);if(mediaRel.external)warn('linked-media','Linked media is not fetched automatically. Embed it in the original deck to play it here.',index);
      }
      for(const link of all(node,'hlinkClick')){
        const relation=relationships.get(rid(link)),targetIndex=relation?.path?slideParts.indexOf(relation.path):-1,href=relation?.external?safeLink(relation.target):'';
        if(href||targetIndex>=0){const item={id:String(index)+':link:'+meta.links.length,label:shape.text?.paras.flatMap(p=>p.runs.map(r=>r.text)).join('')||shape.name||'Open link',href,...(targetIndex>=0?{targetIndex}:{}),rect:{...x}};shape.links??=[];shape.links.push(item);meta.links.push(item);}
      }
      const table=first(node,'tbl');if(table)shape.table={columns:kids(child(table,'tblGrid'),'gridCol').map(c=>px(c,'w')),rows:kids(table,'tr').map(row=>({height:px(row,'h'),cells:kids(row,'tc').map(cell=>({span:Math.max(1,number(cell,'gridSpan',1)),skip:truth(attr(cell,'hMerge'))||truth(attr(cell,'vMerge')),fill:fill(child(cell,'tcPr'),theme),text:textModel(child(cell,'txBody'),theme,defaults)}))}))};
      const chart=first(node,'chart'),chartPart=relationships.get(rid(chart))?.path;if(chartPart)shape.chart=chartModel(xml(chartPart),theme,index);
      const preset=attr(child(props,'prstGeom'),'prst');if(preset&&!['rect','roundRect','ellipse','arc','pie','donut','line','triangle','rtTriangle','diamond','parallelogram','trapezoid','chevron','rightArrow','leftArrow','pentagon','hexagon','heptagon','octagon','decagon','star5','star6','star8'].includes(preset))warn('shape-'+preset,'The '+preset+' preset uses a rectangular fallback.',index);
      return [shape];
    }
    function chartModel(chart,theme,index){
      const plot=first(chart,'plotArea'),kind=kids(plot).find(n=>/Chart$/.test(n.localName)),type=kind?.localName||'';
      const values=node=>all(node,'pt').sort((a,b)=>number(a,'idx')-number(b,'idx')).map(n=>child(n,'v')?.textContent||'');
      if(!['barChart','lineChart','pieChart','doughnutChart','areaChart','scatterChart'].includes(type))warn('chart-'+type,'This chart type is not supported by the independent player.',index);
      if(['areaChart','scatterChart'].includes(type))warn('chart-layout-'+type,'The '+type.replace(/Chart$/,'')+' chart uses a simplified line layout; its authored axis positions and area fill are not reproduced.',index);
      if(type==='barChart'&&attr(child(kind,'barDir'),'val')==='bar')warn('chart-layout-horizontal','Horizontal bars use a simplified vertical column layout.',index);
      const grouping=attr(child(kind,'grouping'),'val');if(['stacked','percentStacked'].includes(grouping))warn('chart-layout-'+grouping,'Stacked chart series use a simplified unstacked layout.',index);
      if(kids(plot).filter(n=>/Chart$/.test(n.localName)).length>1)warn('chart-layout-combination','A combination chart displays only its first chart type.',index);
      return {type,title:all(first(chart,'title'),'t').map(t=>t.textContent).join(' '),horizontal:attr(child(kind,'barDir'),'val')==='bar',
        series:kids(kind,'ser').map((ser,n)=>({name:values(child(ser,'tx'))[0]||child(child(ser,'tx'),'v')?.textContent||'Series '+(n+1),categories:values(child(ser,'cat')||child(ser,'xVal')),values:values(child(ser,'val')||child(ser,'yVal')).map(Number),color:colour(child(child(ser,'spPr'),'solidFill'),theme,theme.colors['accent'+(n%6+1)]? '#'+theme.colors['accent'+(n%6+1)]:'#008cff')}))};
    }
    function model(index){
      if(models.has(index))return models.get(index);const owner=slideParts[index],slide=xml(owner);if(!slide)throw Error('The original slide part is missing: '+owner);
      const relationships=rels(owner),layoutPart=Array.from(relationships.values()).find(r=>r.type.endsWith('/slideLayout'))?.path,layout=xml(layoutPart),masterPart=Array.from(rels(layoutPart||'').values()).find(r=>r.type.endsWith('/slideMaster'))?.path,master=xml(masterPart),theme=themeFor(masterPart,master),meta=metadata(index,owner,slide,relationships);
      const shapes=[];
      if(attr(slide.documentElement,'showMasterSp')!=='0')for(const [source,part]of [[master,masterPart],[layout,layoutPart]]){
        for(const node of kids(first(source,'spTree')))if(!first(node,'ph'))shapes.push(...shapeModel(node,part,rels(part||''),theme,index,layout,master,meta));
      }
      for(const node of kids(first(slide,'spTree')))shapes.push(...shapeModel(node,owner,relationships,theme,index,layout,master,meta));
      const locate=(list,parent)=>{for(const shape of list){const matrix=multiply(parent,transform(shape.x)),corners=[[0,0],[shape.x.w,0],[shape.x.w,shape.x.h],[0,shape.x.h]].map(([x,y])=>point(matrix,x,y)),left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y)),right=Math.max(...corners.map(p=>p.x)),bottom=Math.max(...corners.map(p=>p.y)),rect={x:left*width/slideWidth,y:top*height/slideHeight,width:(right-left)*width/slideWidth,height:(bottom-top)*height/slideHeight};for(const link of shape.links||[])link.rect=rect;if(shape.media)shape.media.rect=rect;if(shape.children.length)locate(shape.children,multiply(matrix,[shape.x.w/(shape.childW||1),0,0,shape.x.h/(shape.childH||1),-shape.childX*shape.x.w/(shape.childW||1),-shape.childY*shape.x.h/(shape.childH||1)]));}};locate(shapes,[1,0,0,1,0,0]);meta.size={width,height};
      let background=null;for(const source of [slide,layout,master]){const bg=first(source,'bg');if(!bg)continue;const properties=child(bg,'bgPr'),ref=child(bg,'bgRef');background=properties?{node:properties,owner:source===slide?owner:source===layout?layoutPart:masterPart,theme}:ref?{node:{childNodes:[theme.backgroundStyles[Math.max(0,number(ref,'idx')-1001)]].filter(Boolean)},owner,theme:{...theme,colors:{...theme.colors,phClr:colour(ref,theme)}}}:null;if(background)break;}
      const value={index,owner,slide,theme,shapes,background,meta};models.set(index,value);return value;
    }
    const slides=slideParts.map((_,index)=>model(index).meta);
    for(const meta of slides)meta.unsupported=warnings.filter(w=>w.slide===null||w.slide===meta.index);
    function acquireURL(part){if(!parts[part])throw Error('An embedded content part is missing: '+part);let entry=urls.get(part);if(!entry){entry={url:root.URL.createObjectURL(new Blob([parts[part]],{type:mimeFor(part)})),refs:0};urls.set(part,entry);}entry.refs++;return entry.url;}
    function releaseURL(part){const entry=urls.get(part);if(entry&&--entry.refs<=0){root.URL.revokeObjectURL(entry.url);urls.delete(part);}}
    const closeImage=entry=>{if(entry.closed)return;entry.closed=true;entry.element.removeAttribute?.('src');imageOwners.delete(entry.element);releaseURL(entry.part);};
    async function image(part,index){
      if(!part)return null;if(imageCache.has(part)){const entry=imageCache.get(part);imageCache.delete(part);imageCache.set(part,entry);return entry.promise;}
      const url=acquireURL(part),element=doc.createElement('img');element.decoding='async';element.src=url;
      const promise=typeof element.decode==='function'?element.decode().then(()=>element):new Promise((resolve,reject)=>{element.onload=()=>resolve(element);element.onerror=()=>reject(Error('Image decoding failed.'));});
      const entry={element,promise,part,refs:0,retired:false,closed:false};imageCache.set(part,entry);imageOwners.set(element,entry);
      try{await promise;}catch(error){warn('image-'+part,'An embedded image could not be decoded: '+part,index);if(imageCache.get(part)===entry)imageCache.delete(part);closeImage(entry);throw error;}
      return element;
    }
    function pruneImages(){while(imageCache.size>IMAGE_CACHE){const key=imageCache.keys().next().value,old=imageCache.get(key);imageCache.delete(key);old.retired=true;if(!old.refs)closeImage(old);}}
    function releaseScene(scene){if(!scene)return;for(const entry of scene.entries){entry.refs--;if(entry.retired&&!entry.refs)closeImage(entry);}scene.entries.clear();}
    async function verifyFonts(shapes,index){
      if(typeof root.FontFace!=='function')return;
      const names=new Set(),visit=shape=>{for(const p of shape.text?.paras||[])for(const run of p.runs)if(run.face)names.add(run.face);for(const row of shape.table?.rows||[])for(const cell of row.cells)for(const p of cell.text?.paras||[])for(const run of p.runs)if(run.face)names.add(run.face);shape.children.forEach(visit);};shapes.forEach(visit);
      for(const name of names){if(!fontChecks.has(name)){const safe=String(name).replace(/["\\\r\n]/g,'');try{fontChecks.set(name,new root.FontFace('OpenLiveLocalFontProbe','local("'+safe+'")').load().then(()=>true,()=>false));}catch(_){fontChecks.set(name,Promise.resolve(false));}}
        if(!await fontChecks.get(name))warn('font-'+name,'The '+name+' font is not installed; a browser font fallback is used.',index);}
    }
    async function prepareScene(index){
      const m=model(index),scene={model:m,shapes:[],backgroundImage:null,entries:new Set()};
      const retainImage=async part=>{const decoded=await image(part,index),entry=imageOwners.get(decoded);if(entry&&!scene.entries.has(entry)){entry.refs++;scene.entries.add(entry);}pruneImages();return decoded;};
      const shapes=async list=>{const out=[];for(const shape of list){const copy={...shape,children:[]};if(copy.image){if(['wmf','emf','tif','tiff','heic'].includes(ext(copy.image)))warn('image-format-'+ext(copy.image),'The '+ext(copy.image).toUpperCase()+' image format is not supported by the browser; other slide content remains playable.',index);else copy.decoded=await retainImage(copy.image);}if(shape.children.length)copy.children=await shapes(shape.children);out.push(copy);}return out;};
      try{scene.shapes=await shapes(m.shapes);await verifyFonts(scene.shapes,index);if(m.background){const blip=first(m.background.node,'blip'),part=rels(m.background.owner).get(rid(blip,'embed'))?.path;if(part)scene.backgroundImage=await retainImage(part);}return scene;}
      catch(error){releaseScene(scene);throw error;}
    }
    function drawImageFill(ctx,shape){
      const img=shape.decoded;if(!img)return;const w=shape.x.w,h=shape.x.h,iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height,crop=shape.crop;
      const l=number(crop,'l')/100000,t=number(crop,'t')/100000,r=number(crop,'r')/100000,b=number(crop,'b')/100000,dest=child(child(shape.imageFill,'stretch'),'fillRect'),dl=number(dest,'l')/100000,dt=number(dest,'t')/100000,dr=number(dest,'r')/100000,db=number(dest,'b')/100000;
      if(iw>0&&ih>0)ctx.drawImage(img,l*iw,t*ih,Math.max(1,(1-l-r)*iw),Math.max(1,(1-t-b)*ih),dl*w,dt*h,Math.max(1,(1-dl-dr)*w),Math.max(1,(1-dt-db)*h));
    }
    function drawChart(ctx,chart,w,h){
      if(!chart.series.length)return;const x0=48,y0=chart.title?40:20,cw=Math.max(1,w-x0-24),ch=Math.max(1,h-y0-42),series=chart.series;
      ctx.font='18px "Segoe UI", Arial';ctx.fillStyle='#333';if(chart.title)ctx.fillText(chart.title,x0,24);
      if(['pieChart','doughnutChart'].includes(chart.type)){
        const values=series[0].values,total=values.reduce((s,v)=>s+Math.max(0,v),0)||1,radius=Math.min(cw,ch)/2,cx=x0+cw/2,cy=y0+ch/2;let start=-Math.PI/2;
        values.forEach((v,n)=>{const end=start+Math.max(0,v)/total*Math.PI*2,inner=chart.type==='doughnutChart'?radius*.5:0;ctx.fillStyle='#'+(series[0].color.startsWith('#')&&n===0?series[0].color.slice(1):['008cff','b63b8a','83b931','f5a524','7755bb','14b8a6'][n%6]);ctx.beginPath();ctx.moveTo(cx+Math.cos(start)*inner,cy+Math.sin(start)*inner);ctx.lineTo(cx+Math.cos(start)*radius,cy+Math.sin(start)*radius);ctx.arc(cx,cy,radius,start,end);if(inner){ctx.lineTo(cx+Math.cos(end)*inner,cy+Math.sin(end)*inner);ctx.arc(cx,cy,inner,end,start,true);}ctx.closePath();ctx.fill();start=end;});return;
      }
      const max=Math.max(1,...series.flatMap(s=>s.values)),count=Math.max(1,...series.map(s=>s.values.length));ctx.strokeStyle='#888';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x0,y0+ch);ctx.lineTo(x0+cw,y0+ch);ctx.stroke();
      for(let n=0;n<=4;n++){const y=y0+ch-ch*n/4;ctx.fillStyle='#555';ctx.font='12px "Segoe UI", Arial';ctx.fillText(String(Math.round(max*n/4*100)/100),3,y+4);ctx.strokeStyle='#ddd';ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x0+cw,y);ctx.stroke();}
      series.forEach((s,si)=>{ctx.fillStyle=s.color;ctx.strokeStyle=s.color;ctx.lineWidth=3;ctx.beginPath();s.values.forEach((v,n)=>{const x=x0+(n+.5)*cw/count,y=y0+ch-v/max*ch;if(chart.type==='barChart')ctx.fillRect(x0+(n+si/series.length)*cw/count+3,y,cw/count/series.length-6,y0+ch-y);else{ctx[n?'lineTo':'moveTo'](x,y);}});if(chart.type!=='barChart')ctx.stroke();});
      const labels=series[0].categories;ctx.font='12px "Segoe UI", Arial';ctx.fillStyle='#333';labels.slice(0,count).forEach((label,n)=>ctx.fillText(String(label).slice(0,18),x0+n*cw/count+4,y0+ch+20));
    }
    function drawShape(ctx,shape,activeMedia){
      const {x}=shape;if(!Number.isFinite(x.w)||!Number.isFinite(x.h))return;ctx.save();applyTransform(ctx,x);
      if(shape.type==='grpSp'){ctx.scale(x.w/(shape.childW||x.w||1),x.h/(shape.childH||x.h||1));ctx.translate(-shape.childX,-shape.childY);for(const item of shape.children)drawShape(ctx,item,activeMedia);ctx.restore();return;}
      const props=child(shape.node,'spPr'),shadow=first(props,'outerShdw');if(shadow){ctx.shadowColor=colour(shadow,shape.theme,'rgba(0,0,0,.25)');ctx.shadowBlur=px(shadow,'blurRad');const angle=number(shadow,'dir')/60000*Math.PI/180;ctx.shadowOffsetX=px(shadow,'dist')*Math.cos(angle);ctx.shadowOffsetY=px(shadow,'dist')*Math.sin(angle);}
      pathGeometry(ctx,props,x.w,x.h);const color=paintFill(ctx,shape.fill,x.w,x.h);if(color){ctx.fillStyle=color;ctx.fill();}
      if(shape.decoded){ctx.save();pathGeometry(ctx,props,x.w,x.h);ctx.clip();drawImageFill(ctx,shape);ctx.restore();}
      const media=shape.media&&activeMedia?.get(shape.media.id);if(media?.element?.tagName?.toLowerCase()==='video'&&media.element.readyState>=2){ctx.save();pathGeometry(ctx,props,x.w,x.h);ctx.clip();ctx.drawImage(media.element,0,0,x.w,x.h);ctx.restore();}
      if(shape.line&&!child(shape.line,'noFill')){ctx.strokeStyle=colour(child(shape.line,'solidFill'),shape.theme,'#000');ctx.lineWidth=px(shape.line,'w',1);const dash=attr(child(shape.line,'prstDash'),'val');ctx.setLineDash?.(dash==='dash'?[ctx.lineWidth*4,ctx.lineWidth*3]:dash==='dot'?[ctx.lineWidth,ctx.lineWidth*2]:[]);pathGeometry(ctx,props,x.w,x.h);ctx.stroke();}
      ctx.shadowColor='transparent';ctx.shadowBlur=ctx.shadowOffsetX=ctx.shadowOffsetY=0;
      if(shape.table){const tw=shape.table.columns.reduce((s,n)=>s+n,0)||x.w,th=shape.table.rows.reduce((s,row)=>s+row.height,0)||x.h;ctx.save();ctx.scale(x.w/tw,x.h/th);let cy=0;
        for(const row of shape.table.rows){let cx=0,column=0;for(const cell of row.cells){const cw=shape.table.columns.slice(column,column+cell.span).reduce((s,n)=>s+n,0)||x.w/row.cells.length;if(!cell.skip){ctx.save();ctx.translate(cx,cy);ctx.fillStyle=paintFill(ctx,cell.fill,cw,row.height)||'#ffffff';ctx.fillRect(0,0,cw,row.height);ctx.strokeStyle='#999';ctx.lineWidth=1;ctx.strokeRect(0,0,cw,row.height);drawText(ctx,cell.text,cw,row.height);ctx.restore();}cx+=cw;column+=cell.span;}cy+=row.height;}ctx.restore();}
      if(shape.chart)drawChart(ctx,shape.chart,x.w,x.h);drawText(ctx,shape.text,x.w,x.h);ctx.restore();
    }
    function paintScene(scene,canvas,activeMedia){
      const m=scene.model;
      const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('PowerPoint playback needs a canvas context.');
      if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;ctx.setTransform(width/slideWidth,0,0,height/slideHeight,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,slideWidth,slideHeight);
      if(m.background){const value=fill(m.background.node,m.background.theme||m.theme);if(value){ctx.fillStyle=paintFill(ctx,value,slideWidth,slideHeight);ctx.fillRect(0,0,slideWidth,slideHeight);}if(scene.backgroundImage)ctx.drawImage(scene.backgroundImage,0,0,slideWidth,slideHeight);}
      for(const shape of scene.shapes)drawShape(ctx,shape,activeMedia);ctx.setTransform(1,0,0,1,0,0);return canvas;
    }
    const render=(index,settings={})=>{
      if(!Number.isInteger(index)||index<0||index>=slides.length)return Promise.reject(Error('Choose a slide in this PowerPoint.'));
      const current=()=>!closed&&!settings.signal?.aborted&&(!settings.isCurrent||settings.isCurrent());
      const work=tail.catch(()=>{}).then(async()=>{if(!current())throw cancelled();if(cache.has(index)){const frame=cache.get(index);cache.delete(index);cache.set(index,frame);return frame;}
        const canvas=doc.createElement('canvas');let scene;try{scene=await prepareScene(index);paintScene(scene,canvas);if(!current())throw cancelled();cache.set(index,canvas);while(cache.size>CACHE){const key=cache.keys().next().value,old=cache.get(key);cache.delete(key);old.width=old.height=1;}return canvas;}catch(error){canvas.width=canvas.height=1;throw error;}finally{releaseScene(scene);}});tail=work;return work;
    };
    function disposeAsset(){if(closed)return;closed=true;for(const frame of cache.values())frame.width=frame.height=1;cache.clear();for(const entry of imageOwners.values())closeImage(entry);imageOwners.clear();imageCache.clear();for(const entry of urls.values())root.URL.revokeObjectURL(entry.url);urls.clear();xmls.clear();models.clear();for(const name of Object.keys(parts))delete parts[name];}
    function createView(seed){
      if(closed)throw cancelled();refs++;
      const el=doc.createElement('canvas'),listeners=new Set(),media=new Map();el.width=el.height=1;let index=seed?.index??-1,busy=false,error='',revision=0,serial=0,holds=1,released=false,ready=!!seed?.frame,muted=true,activeScene=null;
      const copy=frame=>{el.width=frame.width;el.height=frame.height;el.getContext('2d').drawImage(frame,0,0,frame.width,frame.height);};if(seed?.frame)copy(seed.frame);
      const emit=()=>{revision++;for(const listener of listeners)try{listener();}catch(_){}};
      const mediaState=()=>{const items=Array.from(media.values()).map(row=>({id:row.item.id,type:row.item.type,playing:!row.element.paused&&!row.element.ended,paused:row.element.paused,ended:row.element.ended,muted:row.element.muted,currentTime:Number(row.element.currentTime)||0,duration:Number.isFinite(row.element.duration)?row.element.duration:null,ready:row.element.readyState>=2,error:row.error||''}));return {items,playing:items.some(row=>row.playing),error:items.map(row=>row.error).filter(Boolean).join(' ')};};
      const state=()=>({index,count:slides.length,busy,error,revision,disposed:released,ready,kind:'powerpoint',media:mediaState(),unsupported:warnings.filter(w=>w.slide===null||w.slide===index)});
      const tick=()=>{if(!released&&ready&&activeScene&&Array.from(media.values()).some(row=>row.item.type==='video'&&row.element.readyState>=2)){try{paintScene(activeScene,el,media);}catch(reason){error=reason.message||String(reason);}}return !released&&ready?el:null;};
      const disposeMedia=()=>{for(const row of media.values()){row.element.pause();for(const [name,callback]of row.events)row.element.removeEventListener?.(name,callback);row.element.removeAttribute?.('src');row.element.load?.();releaseURL(row.item.part);}media.clear();};
      const setupMedia=()=>{for(const item of slides[index]?.media||[]){if(!item.embedded||!parts[item.part])continue;const element=doc.createElement(item.type),row={item,element,error:'',events:[]};element.preload='metadata';element.playsInline=true;element.muted=muted;element.src=acquireURL(item.part);
          for(const name of ['loadeddata','timeupdate','ended','error','pause','play']){const callback=()=>{if(released)return;if(name==='error')row.error='The browser cannot decode embedded '+item.type+' ('+item.mime+').';emit();};element.addEventListener?.(name,callback);row.events.push([name,callback]);}media.set(item.id,row);}};
      const owned=()=>!released;
      const player={kind:'powerpoint',originalSource:originalFile,el,count:slides.length,slides,unsupported:warnings,width,height,
        state,frame:tick,tick,getSlide:n=>slides[n]?{...slides[n],unsupported:warnings.filter(w=>w.slide===null||w.slide===n)}:null,
        async go(target,settings={}){if(released||settings.signal?.aborted||settings.isCurrent&&!settings.isCurrent())throw cancelled();if(!Number.isInteger(target)||target<0||target>=slides.length)throw Error('Choose a slide in this PowerPoint.');
          const operation=++serial,owns=()=>owned()&&serial===operation,current=()=>owns()&&!settings.signal?.aborted&&(!settings.isCurrent||settings.isCurrent());busy=true;error='';emit();
          let scene;try{const frame=await render(target,{signal:settings.signal,isCurrent:current});if(!current())throw cancelled();scene=await prepareScene(target);if(!current())throw cancelled();disposeMedia();releaseScene(activeScene);activeScene=scene;scene=null;copy(frame);index=target;ready=true;setupMedia();return state();}catch(reason){if(owns())error=reason.message||String(reason);throw reason;}finally{releaseScene(scene);if(owns()){busy=false;emit();}}},
        render:(target,settings={})=>render(target,{...settings,isCurrent:()=>owned()&&(!settings.isCurrent||settings.isCurrent())}),
        step:(delta,settings)=>player.go(bounded(index+Number(delta),0,slides.length-1),settings),first:settings=>player.go(0,settings),last:settings=>player.go(slides.length-1,settings),
        subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
        fork(){if(released)throw cancelled();const fork=createView({index,frame:player.frame(),scene:activeScene});return fork;},
        retain(){if(released)throw cancelled();holds++;return player;},
        release(){if(released)return;if(--holds>0)return;released=true;serial++;busy=false;ready=false;disposeMedia();releaseScene(activeScene);activeScene=null;el.width=el.height=1;emit();listeners.clear();views.delete(player);if(--refs===0)disposeAsset();},
        async playMedia(id,settings={}){if(released||settings.signal?.aborted||settings.isCurrent&&!settings.isCurrent())throw cancelled();const operation=serial,selected=id?Array.from(media.values()).filter(row=>row.item.id===id):Array.from(media.values());if(!selected.length)throw Error('This slide has no embedded media to play.');await Promise.all(selected.map(async row=>{try{await row.element.play();}catch(reason){row.error=reason.message||'Embedded media playback failed.';throw reason;}}));if(released||serial!==operation||settings.signal?.aborted||settings.isCurrent&&!settings.isCurrent()){for(const row of selected)row.element.pause();throw cancelled();}emit();return mediaState();},
        pauseMedia(id){for(const row of media.values())if(!id||row.item.id===id)row.element.pause();emit();return mediaState();},
        stopMedia(id){for(const row of media.values())if(!id||row.item.id===id){row.element.pause();try{row.element.currentTime=0;}catch(_){}}emit();return mediaState();},
        setMuted(value){muted=!!value;for(const row of media.values())row.element.muted=muted;emit();return mediaState();},mediaState,
        get mediaElements(){return Array.from(media.values()).map(row=>row.element);},
        diagnostics:()=>({closed,refs,holds,cacheSize:cache.size,cacheLimit:CACHE,imageCacheSize:imageCache.size,urlCount:urls.size}),get revision(){return revision;}
      };player.dispose=player.release;views.add(player);if(seed?.scene){activeScene={...seed.scene,entries:new Set(seed.scene.entries)};for(const entry of activeScene.entries)entry.refs++;}if(seed?.frame)setupMedia();return player;
    }
    check();const player=createView();progress({stage:'frame',loaded:0,total:1,unit:'frames',percent:null,message:'Preparing first original PowerPoint slide'});
    try{await player.go(0,{signal});check();progress({stage:'ready',loaded:1,total:1,unit:'frames',percent:100,message:'PowerPoint ready'});return player;}catch(error){player.release();throw error;}
  }
  root.OpenLivePowerPoint=Object.freeze({openPlayer,isSupported:valid});
})(typeof window!=='undefined'?window:globalThis);
