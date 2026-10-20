/* SHOWAVE-authored football graphics. Source semantics follow manual/sources.htm:
   ordinary generated pictures with editable properties and normal transforms.
   These presets are an application extension, not Arena factory content.
   Rendering is driven by Studio; no timers, network calls or pixel readbacks. */
window.OpenLiveSportsSources=(()=>{
  'use strict';
  const WIDTH=1920,HEIGHT=1080;
  const catalogue=Object.freeze([
    {id:'scoreboard',label:'Scoreboard',description:'Team colors, score, period and a controllable match clock.',icon:'scoreboard'},
    {id:'lineup',label:'Starting lineup',description:'An animated starting eleven with player names and formation.',icon:'lineup'},
    {id:'goal',label:'Goal',description:'A timed goal announcement with scorer, minute and score.',icon:'goal'},
    {id:'substitution',label:'Substitution',description:'A timed player-on and player-off lower third.',icon:'substitution'},
    {id:'match-stats',label:'Match statistics',description:'A comparison board for your manually entered match statistics.',icon:'stats'},
    {id:'replay-title',label:'Replay title',description:'A timed replay title graphic. It does not record or replay video.',icon:'replay'}
  ].map(Object.freeze));
  const record=(value,label)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid '+label+' settings.');
    return value;
  };
  const text=(value,fallback,limit,label)=>{
    const result=value??fallback;
    if(typeof result!=='string'||result.length>limit||/[\u0000-\u001f\u007f]/.test(result))
      throw Error(label+' must contain at most '+limit+' characters on one line.');
    return result.trim();
  };
  const numeric=(value,fallback,min,max,label,integer=false)=>{
    const item=value??fallback;
    if(typeof item!=='number'&&typeof item!=='string'||typeof item==='string'&&!item.trim())
      throw Error('Enter a number for '+label+'.');
    const result=Number(item);
    if(!Number.isFinite(result)||result<min||result>max||integer&&!Number.isInteger(result))
      throw Error(label+' must be '+(integer?'a whole number ':'')+'between '+min+' and '+max+'.');
    return result;
  };
  const choice=(value,fallback,values,label)=>{
    const result=value??fallback;if(!values.includes(result))throw Error('Choose a supported '+label+'.');return result;
  };
  const color=(value,fallback)=>{
    const result=value??fallback;
    if(typeof result!=='string'||!/^#[0-9a-f]{6}$/i.test(result))throw Error('Use a six-digit team color.');
    return result.toLowerCase();
  };
  const statValue=value=>{
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Enter a finite statistic.');value=String(value);}
    return text(value,'N/A',16,'Statistic');
  };
  const clone=value=>JSON.parse(JSON.stringify(value));
  function freeze(value){Object.values(value).forEach(item=>{if(item&&typeof item==='object')freeze(item);});return Object.freeze(value);}
  const nativeCatalog=()=>window.OpenLiveFullTemplates?.list?.()||window.OpenLiveFullTemplateCatalog||[];
  function templateDefinitions(){
    return freeze(nativeCatalog().filter(item=>/^svg-[1-9]$/.test(item.id)).map(item=>({
      id:item.id,name:item.name,thumbnail:item.thumbnail,mainFrameIndex:item.id==='svg-6'?1:0,frameCount:item.frames?.length||0
    })));
  }
  function templateStyle(id,raw={}){
    record(raw,'template');const module=window.OpenLiveFullTemplates,copy=clone(raw),components=copy.components;delete copy.components;
    if(typeof module?.normalizeStyle!=='function'){
      if(Object.keys(raw).length)throw Error('The native template style validator is unavailable.');
      return {};
    }
    const base=clone(module.normalizeStyle(id,copy)),result={...base};
    if(components!==undefined){
      record(components,'template components');
      if(typeof module.normalizePartStyle!=='function')throw Error('The native component style validator is unavailable.');
      for(const [key,settings] of Object.entries(components)){
        const normalized=module.normalizePartStyle(id,key,{...base,components:{[key]:settings}});
        if(normalized.components?.[key])(result.components||(result.components={}))[key]=clone(normalized.components[key]);
      }
    }
    return result;
  }
  function resolveTemplate(id,index,rawStyle={}){
    const template=nativeCatalog().find(item=>item.id===id),definition=templateDefinitions().find(item=>item.id===id);
    if(!template||!definition)throw Error('Choose one of the nine native production templates.');
    const frameIndex=numeric(index,definition.mainFrameIndex,0,definition.frameCount-1,'Template feed',true),style=templateStyle(id,rawStyle),
      component=template.components?.find(item=>item.frameIndex===frameIndex),module=window.OpenLiveFullTemplates,
      partStyle=component?{...style,components:style.components?.[component.id]?{[component.id]:style.components[component.id]}:{}}:{};
    const mapped=component&&module?.partFrameRect?module.partFrameRect(id,component.id,{width:WIDTH,height:HEIGHT},partStyle):null,
      rawFrame=mapped||template.frames[frameIndex],frame={x:rawFrame.x,y:rawFrame.y,w:rawFrame.w,h:rawFrame.h,radius:rawFrame.radius||0};
    if(![frame.x,frame.y,frame.w,frame.h].every(Number.isFinite)||frame.w<=0||frame.h<=0)throw Error('This native template has no usable feed area.');
    const framePixels={x:frame.x*WIDTH,y:frame.y*HEIGHT,w:frame.w*WIDTH,h:frame.h*HEIGHT},margin=Math.min(framePixels.w,framePixels.h)*.035,
      safeRect={x:framePixels.x+margin,y:framePixels.y+margin,w:framePixels.w-margin*2,h:framePixels.h-margin*2},
      paints=Object.fromEntries((template.palette||[]).map(item=>[item.key,style[item.key]||item.defaultColor||item.paints?.[0]])),
      primary=template.components?.find(item=>item.id==='headline')||template.components?.find(item=>item.id==='ticker-text'),
      change=primary&&style.components?.[primary.id]||{},sizeSource=change.fontSize||primary?.defaultFontSize||18,
      textPalette=primary?.paletteKeys?.find(key=>['headlineInk','foreground'].includes(key)),
      typography={family:change.fontFamily||primary?.defaultFontFamily||'Arial',weight:change.fontWeight||'700',
        sizeSource,sizeHD:sizeSource*(template.sourceToHd?.scaleY||1),color:change.textColor||(textPalette&&paints[textPalette])||primary?.defaultTextColor||paints.foreground||'#ffffff'},
      eventComponents=['lower-third-backplate','headline'].every(key=>template.components?.some(item=>item.id===key))?['lower-third-backplate','headline']:[];
    return freeze({...definition,templateId:id,frameIndex,templateStyle:style,frame,framePixels,safeRect,palette:paints,typography,eventComponents,
      provenance:eventComponents.length?'Native component artwork with authored football data.':'Authored football data layout coordinated with native frame geometry and palette.'});
  }
  function team(raw,side){
    record(raw,side+' team');
    const players=raw.players??Array.from({length:11},(_,i)=>({number:String(i+1),name:'Player '+(i+1)}));
    if(!Array.isArray(players)||players.length>11)throw Error('Enter up to eleven starting players.');
    return {
      name:text(raw.name,side==='home'?'Home team':'Away team',64,'Team name'),
      short:text(raw.short,side==='home'?'HOME':'AWAY',8,'Short team name'),
      color:color(raw.color,side==='home'?'#00a6d6':'#f08a45'),
      players:players.map(item=>{
        record(item,'player');
        const number=text(typeof item.number==='number'?String(item.number):item.number,'',3,'Shirt number');
        if(number&&!/^\d{1,3}$/.test(number))throw Error('Shirt numbers must contain up to three digits.');
        return {number,name:text(item.name,'',48,'Player name')};
      })
    };
  }
  function normalize(raw={}){
    record(raw,'sports source');
    const preset=choice(raw.preset,'scoreboard',catalogue.map(item=>item.id),'sports preset'),clock=record(raw.clock??{},'match clock'),
      running=clock.running??false;
    if(typeof running!=='boolean')throw Error('The match clock running state must be true or false.');
    const startedAt=numeric(clock.startedAt,0,0,8640000000000000,'Clock start time');
    if(running&&startedAt===0)throw Error('A running match clock needs its start time.');
    const stats=raw.stats??['Possession','Shots','Shots on target','Corners'].map(label=>({label,home:'N/A',away:'N/A'}));
    if(!Array.isArray(stats)||stats.length>8)throw Error('Enter up to eight match statistics.');
    if(raw.templateStyle!==undefined)record(raw.templateStyle,'template');
    const templateId=text(raw.templateId,'',32,'Template id'),resolved=templateId?resolveTemplate(templateId,raw.frameIndex,raw.templateStyle??{}):null;
    if(!resolved&&(raw.frameIndex!==undefined&&raw.frameIndex!==0||raw.templateStyle&&Object.keys(raw.templateStyle).length))
      throw Error('Choose a native template before setting its feed or style.');
    const placement=choice(raw.placement,'overlay',['frame','overlay'],'graphic placement');
    return {
      preset,style:choice(raw.style,'broadcast',['broadcast','minimal'],'graphic style'),
      ...(resolved?{templateId,frameIndex:resolved.frameIndex,templateStyle:clone(resolved.templateStyle),placement}:{}),
      home:team(raw.home??{},'home'),away:team(raw.away??{},'away'),
      homeScore:numeric(raw.homeScore,0,0,99,'Home score',true),awayScore:numeric(raw.awayScore,0,0,99,'Away score',true),
      competition:text(raw.competition,'MATCHDAY',80,'Competition'),period:text(raw.period,'1st half',24,'Period'),
      clock:{elapsed:numeric(clock.elapsed,0,0,86400,'Match clock'),running,startedAt},
      team:choice(raw.team,'home',['home','away'],'team'),formation:choice(raw.formation,'4-3-3',['4-3-3','4-4-2','3-5-2'],'formation'),
      headline:text(raw.headline,preset==='replay-title'?'REPLAY':preset==='goal'?'GOAL':preset==='substitution'?'SUBSTITUTION':preset==='lineup'?'STARTING XI':'MATCH STATISTICS',64,'Headline'),
      player:text(raw.player,'',80,'Scorer'),playerOut:text(raw.playerOut,'',80,'Player off'),playerIn:text(raw.playerIn,'',80,'Player on'),
      minute:text(typeof raw.minute==='number'?String(raw.minute):raw.minute,'',12,'Match minute'),
      duration:numeric(raw.duration,6,1,30,'Graphic duration'),
      stats:stats.map(item=>{record(item,'statistic');return {label:text(item.label,'',36,'Statistic label'),home:statValue(item.home),away:statValue(item.away)};})
    };
  }
  const clamp=value=>Math.max(0,Math.min(1,value));
  const ease=value=>1-Math.pow(1-clamp(value),3);
  const teamInk=color=>{
    const channels=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)/255).map(value=>value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4));
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722>.2?'#0e1c2a':'#ffffff';
  };
  const palette=style=>style==='minimal'?
    {panel:'#f4f6f8',raised:'#ffffff',ink:'#112437',muted:'#566675',line:'#ced6dc',field:'#e5ecef',pitch:'#a6b9c1'}:
    {panel:'#101e2c',raised:'#1c2f40',ink:'#ffffff',muted:'#b1c3d0',line:'#354d60',field:'#142c38',pitch:'#496570'};
  function rect(ctx,x,y,w,h,fill){ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);}
  function label(ctx,value,x,y,w,size,fill,weight=600,align='left'){
    if(!value)return;
    size*=ctx._sportsTypeScale||1;
    ctx.save();try{
      const family=ctx._sportsFont||'"Segoe UI",Arial,sans-serif';
      ctx.font=weight+' '+size+'px '+family;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillStyle=fill;
      const measured=ctx.measureText(value).width;
      if(measured>w&&!ctx._sportsFixedSize)ctx.font=weight+' '+Math.max(size*.58,size*w/measured)+'px '+family;
      ctx.beginPath();ctx.rect(x,y-size*.8,w,size*1.6);ctx.clip();
      ctx.fillText(value,x+(align==='center'?w/2:align==='right'?w:0),y);
    }finally{ctx.restore();}
  }
  function rule(ctx,x,y,w,fill,h=2){rect(ctx,x,y,w,h,fill);}
  function stamp(ctx,value,x,y,w,p){rect(ctx,x,y,w,34,p.raised);label(ctx,value,x+14,y+17,w-28,16,p.muted,700);}
  function score(ctx,config,x,y,w,h,p){
    rect(ctx,x,y,w,h,p.raised);label(ctx,config.homeScore+'  :  '+config.awayScore,x+12,y+h/2,w-24,h*.51,p.ink,700,'center');
  }
  function clockText(seconds){const value=Math.floor(Math.max(0,seconds));return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
  function scoreboard(ctx,c,p,seconds){
    const x=96,y=100,h=82;
    stamp(ctx,c.competition.toUpperCase(),x,60,450,p);
    rect(ctx,x,y,762,h,p.panel);
    label(ctx,c.home.short.toUpperCase(),x+18,y+h/2,140,31,p.ink,700,'center');
    score(ctx,c,x+178,y,152,h,p);
    label(ctx,c.away.short.toUpperCase(),x+348,y+h/2,140,31,p.ink,700,'center');
    rect(ctx,x+510,y,140,h,p.raised);label(ctx,clockText(seconds),x+519,y+h/2,122,31,p.ink,650,'center');
    label(ctx,c.period.toUpperCase(),x+664,y+h/2,84,18,p.muted,650,'center');
    rule(ctx,x,y+h,178,c.home.color,7);rule(ctx,x+330,y+h,180,c.away.color,7);
    rule(ctx,x+510,y+h,252,p.line,7);
  }
  function header(ctx,c,t,p,title,sub){
    rect(ctx,96,76,1728,156,p.panel);rect(ctx,96,76,12,156,t.color);
    label(ctx,c.competition.toUpperCase(),132,110,1280,20,p.muted,600);
    label(ctx,title,132,166,1340,48,p.ink,700);
    label(ctx,sub,1490,166,294,32,p.muted,600,'right');
  }
  function lineup(ctx,c,p,age){
    const t=c[c.team];header(ctx,c,t,p,t.name.toUpperCase(),c.formation);
    rect(ctx,96,244,652,758,p.panel);rect(ctx,760,244,1064,758,p.panel);
    label(ctx,c.headline,132,283,570,22,p.muted,600);rule(ctx,132,316,580,p.line);
    t.players.forEach((player,i)=>{
      const reveal=ease((age-i*.065)/.3);ctx.save();ctx.globalAlpha*=reveal;
      const y=350+i*55,x=132+(1-reveal)*22;
      rect(ctx,x,y-19,56,38,t.color);label(ctx,player.number,x,y,56,24,teamInk(t.color),700,'center');
      label(ctx,player.name,x+78,y,493,27,p.ink,600);if(i<10)rule(ctx,132,y+27,580,p.line,1);ctx.restore();
    });
    const field={x:848,y:290,w:888,h:636};
    rect(ctx,field.x,field.y,field.w,field.h,p.field);
    ctx.save();ctx.strokeStyle=p.pitch;ctx.lineWidth=2;ctx.strokeRect(field.x+20,field.y+20,field.w-40,field.h-40);
    ctx.beginPath();ctx.moveTo(field.x+20,field.y+field.h/2);ctx.lineTo(field.x+field.w-20,field.y+field.h/2);ctx.stroke();
    ctx.beginPath();ctx.arc(field.x+field.w/2,field.y+field.h/2,66,0,Math.PI*2);ctx.stroke();
    ctx.strokeRect(field.x+field.w/2-144,field.y+20,288,90);ctx.strokeRect(field.x+field.w/2-144,field.y+field.h-110,288,90);
    ctx.restore();
    const rows=[1,...c.formation.split('-').map(Number)];let index=0;
    rows.forEach((count,row)=>{
      for(let n=0;n<count;n++,index++){
        const player=t.players[index];if(!player)continue;
        const reveal=ease((age-.15-index*.075)/.35),x=field.x+field.w*(n+1)/(count+1),y=field.y+field.h-76-row*153;
        ctx.save();ctx.globalAlpha*=reveal;
        rect(ctx,x-31,y-32+(1-reveal)*16,62,48,t.color);label(ctx,player.number,x-30,y-8+(1-reveal)*16,60,26,teamInk(t.color),700,'center');
        const name=player.name.trim().split(/\s+/).pop()||'';
        rect(ctx,x-76,y+21,152,33,p.panel);label(ctx,name,x-70,y+38,140,17,p.ink,600,'center');ctx.restore();
      }
    });
    label(ctx,'STARTING ELEVEN',848,966,888,16,p.muted,600,'center');
  }
  function goal(ctx,c,p,age){
    const t=c[c.team],x=96,y=686,w=1728;
    rect(ctx,x,y,w,288,p.panel);rule(ctx,x,y,w,t.color,10);
    rect(ctx,x,y+10,440,278,t.color);
    label(ctx,c.headline,x+30,y+108,380,86,teamInk(t.color),800);
    label(ctx,t.short.toUpperCase(),x+34,y+227,358,24,teamInk(t.color),600);
    label(ctx,t.name.toUpperCase(),x+484,y+69,876,26,p.muted,600);
    label(ctx,c.player||t.name,x+484,y+146,870,57,p.ink,700);
    label(ctx,c.minute?c.minute+'′  ·  '+c.competition:c.competition,x+484,y+228,870,24,p.muted,500);
    score(ctx,c,x+w-280,y+54,238,160,p);
    // A single accent sweep settles; it never loops or animates match data.
    rule(ctx,x+484,y+262,Math.min(866,866*ease(age/1.1)),t.color,4);
  }
  function arrow(ctx,x,y,direction,fill){
    ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(x,y-12*direction);ctx.lineTo(x+12,y+4*direction);ctx.lineTo(x+5,y+4*direction);
    ctx.lineTo(x+5,y+15*direction);ctx.lineTo(x-5,y+15*direction);ctx.lineTo(x-5,y+4*direction);ctx.lineTo(x-12,y+4*direction);ctx.closePath();ctx.fill();
  }
  function substitution(ctx,c,p){
    const t=c[c.team],x=96,y=714,w=1460;
    rect(ctx,x,y,w,258,p.panel);rect(ctx,x,y,390,258,t.color);
    label(ctx,c.headline,x+26,y+57,340,29,teamInk(t.color),700);
    label(ctx,t.name,x+26,y+132,340,31,teamInk(t.color),700);
    label(ctx,c.minute?c.minute+'′':c.competition,x+26,y+204,340,23,teamInk(t.color),500);
    arrow(ctx,x+434,y+68,1,'#36c59a');label(ctx,'ON',x+458,y+68,64,17,p.muted,700);
    label(ctx,c.playerIn||'Player on',x+556,y+68,850,43,p.ink,650);
    rule(ctx,x+424,y+130,w-458,p.line);
    arrow(ctx,x+434,y+192,-1,'#f18879');label(ctx,'OFF',x+458,y+192,64,17,p.muted,700);
    label(ctx,c.playerOut||'Player off',x+556,y+192,850,43,p.ink,650);
  }
  function stats(ctx,c,p){
    const x=236,y=118,w=1448;rect(ctx,x,y,w,850,p.panel);
    label(ctx,c.competition.toUpperCase(),x+44,y+38,w-88,19,p.muted,600);
    label(ctx,c.headline,x+44,y+97,w-88,45,p.ink,700);
    rule(ctx,x,y,Math.floor(w/2),c.home.color,8);rule(ctx,x+w/2,y,w/2,c.away.color,8);
    rect(ctx,x+32,y+154,w-64,110,p.raised);
    label(ctx,c.home.name.toUpperCase(),x+58,y+208,495,30,p.ink,700);
    label(ctx,c.away.name.toUpperCase(),x+w-553,y+208,495,30,p.ink,700,'right');
    score(ctx,c,x+w/2-135,y+154,270,110,p);
    c.stats.forEach((item,i)=>{
      const rowY=y+310+i*62;
      label(ctx,item.home,x+64,rowY,260,31,p.ink,650,'center');
      label(ctx,item.label.toUpperCase(),x+352,rowY,w-704,21,p.muted,600,'center');
      label(ctx,item.away,x+w-324,rowY,260,31,p.ink,650,'center');
      const read=value=>/^\d+(\.\d+)?%?$/.test(value)?Number(value.replace('%','')):NaN,a=read(item.home),b=read(item.away);
      if(Number.isFinite(a)&&Number.isFinite(b)&&a+b>0){
        const total=320,share=a/(a+b);rule(ctx,x+w/2-total,rowY+24,total*share,c.home.color,3);
        rule(ctx,x+w/2+total-total*(1-share),rowY+24,total*(1-share),c.away.color,3);
      }
      rule(ctx,x+48,rowY+33,w-96,p.line,1);
    });
  }
  function replay(ctx,c,p,age){
    const x=456,y=378,w=1008,h=324,t=c[c.team];
    rect(ctx,x,y,w,h,p.panel);rule(ctx,x,y,w,t.color,10);
    label(ctx,c.competition.toUpperCase(),x+46,y+61,w-92,21,p.muted,600,'center');
    label(ctx,c.headline,x+46,y+159,w-92,90,p.ink,750,'center');
    label(ctx,c.home.short.toUpperCase()+'  /  '+c.away.short.toUpperCase(),x+46,y+257,w-92,27,p.muted,500,'center');
    rule(ctx,x+46,y+h-27,(w-92)*ease(age/.9),t.color,4);
  }
  const tint=(value,amount)=>'#'+[1,3,5].map(start=>Math.round(parseInt(value.slice(start,start+2),16)*amount).toString(16).padStart(2,'0')).join('');
  function nativePalette(definition){
    const colors=definition.palette,news=!!colors.headlineInk,base=colors.ticker||colors.labelBackground||tint(colors.frameEnd||'#94b9ff',.15),
      ink=news?definition.typography.color:colors.foreground||colors.frameStart||'#ffffff';
    return {panel:news?colors.foreground:base,raised:news?'#e9e9e9':tint(colors.frameEnd||colors.foreground||'#ffffff',.23),
      ink,muted:news?'#4f4f4f':colors.frameEnd||'#d0d0d0',line:news?'#bebebe':tint(colors.frameEnd||'#ffffff',.48),
      accent:colors.accent||colors.frameStart||'#ffffff',field:base,pitch:colors.frameEnd||'#7c8b8f'};
  }
  function templateEventText(c){
    const minute=c.minute?' · '+c.minute+'′':'';
    if(c.preset==='goal')return c.headline+' · '+(c.player||c[c.team].name)+minute+' · '+c.home.short+' '+c.homeScore+'–'+c.awayScore+' '+c.away.short;
    if(c.preset==='substitution')return c.headline+' · ON '+(c.playerIn||'Player on')+' · OFF '+(c.playerOut||'Player off')+minute;
    return c.headline+' · '+c.home.short+' / '+c.away.short;
  }
  function nativeEventParts(config,definition){
    if(config.placement!=='overlay'||!['goal','substitution','replay-title'].includes(config.preset)||!definition.eventComponents.length)return [];
    const module=window.OpenLiveFullTemplates;
    if(!module?.loadPart||!module?.drawPart||!module?.normalizePartStyle)throw Error('The native sports component renderer is unavailable.');
    const base={...config.templateStyle};delete base.components;
    return definition.eventComponents.map(id=>{
      const change={...config.templateStyle.components?.[id]};
      if(id==='headline')Object.assign(change,{text:templateEventText(config),textColor:definition.typography.color,overflow:'scroll',overflowSpeed:80});
      return {id,style:module.normalizePartStyle(config.templateId,id,{...base,...(Object.keys(change).length?{components:{[id]:change}}:{})})};
    });
  }
  function templateScoreboard(ctx,c,p,box,seconds,asFrame){
    const {x,y,w,h}=box;
    if(asFrame){
      rect(ctx,x,y,w,h,p.panel);rule(ctx,x,y,w,p.accent,Math.max(4,h*.012));
      const portrait=w<h,fs=Math.max(18,Math.min(42,w*.067));
      label(ctx,c.competition.toUpperCase(),x+w*.06,y+h*.1,w*.88,fs*.58,p.muted,650,'center');
      if(portrait){
        label(ctx,c.home.name.toUpperCase(),x+w*.07,y+h*.27,w*.86,fs,p.ink,700,'center');
        score(ctx,c,x+w*.12,y+h*.36,w*.76,h*.2,p);
        label(ctx,c.away.name.toUpperCase(),x+w*.07,y+h*.66,w*.86,fs,p.ink,700,'center');
      }else{
        label(ctx,c.home.name.toUpperCase(),x+w*.04,y+h*.42,w*.31,fs,p.ink,700,'center');
        score(ctx,c,x+w*.37,y+h*.3,w*.26,h*.28,p);
        label(ctx,c.away.name.toUpperCase(),x+w*.65,y+h*.42,w*.31,fs,p.ink,700,'center');
      }
      label(ctx,c.period.toUpperCase()+' · '+clockText(seconds),x+w*.06,y+h*.83,w*.88,fs*.8,p.ink,600,'center');
      rule(ctx,x+w*.04,y+h*.94,w*.45,c.home.color,Math.max(4,h*.015));rule(ctx,x+w*.51,y+h*.94,w*.45,c.away.color,Math.max(4,h*.015));return;
    }
    const bw=Math.min(w,Math.max(420,w*.66)),bh=Math.max(32,Math.min(72,h*.15)),unit=bw/10;
    rect(ctx,x,y,bw,bh,p.panel);label(ctx,c.home.short.toUpperCase(),x+unit*.15,y+bh/2,unit*2.05,bh*.37,p.ink,700,'center');
    score(ctx,c,x+unit*2.4,y,unit*2.1,bh,p);label(ctx,c.away.short.toUpperCase(),x+unit*4.7,y+bh/2,unit*2.05,bh*.37,p.ink,700,'center');
    rect(ctx,x+unit*7,y,unit*3,bh,p.raised);label(ctx,clockText(seconds),x+unit*7.1,y+bh/2,unit*2.8,bh*.37,p.ink,650,'center');
    rule(ctx,x,y+bh,unit*2.4,c.home.color,4);rule(ctx,x+unit*4.5,y+bh,unit*2.5,c.away.color,4);
    const tagH=Math.max(20,bh*.39);rect(ctx,x,y+bh+4,bw,tagH,p.panel);
    label(ctx,c.period.toUpperCase()+' · '+c.competition,x+10,y+bh+4+tagH/2,bw-20,tagH*.59,p.muted,600);
  }
  function templateLineup(ctx,c,p,box,age){
    const {x,y,w,h}=box,t=c[c.team],margin=Math.max(12,Math.min(w,h)*.045),header=Math.min(104,Math.max(64,h*.16)),hasPitch=w>=720&&h>=420,
      columns=!hasPitch&&h<450&&w>=440?2:1,tableW=hasPitch?w*.4:w,rows=Math.ceil(11/columns),rowH=(h-header-margin)/rows,
      size=Math.min(30,Math.max(14,rowH*.49));
    rect(ctx,x,y,w,h,p.panel);rule(ctx,x,y,w,p.accent,5);
    label(ctx,t.name.toUpperCase(),x+margin,y+header*.38,w-margin*2,Math.min(40,header*.4),p.ink,700);
    label(ctx,c.headline+' · '+c.formation,x+margin,y+header*.77,w-margin*2,Math.max(14,header*.21),p.muted,600);
    t.players.forEach((player,i)=>{
      const col=Math.floor(i/rows),row=i%rows,cw=tableW/columns,reveal=ease((age-i*.065)/.3),px=x+margin+col*cw,py=y+header+rowH*(row+.5),badge=Math.min(44,rowH*.73);
      ctx.save();ctx.globalAlpha*=reveal;rect(ctx,px,py-badge/2,badge,badge,t.color);label(ctx,player.number,px,py,badge,size,teamInk(t.color),700,'center');
      label(ctx,player.name,px+badge+12,py,cw-margin*2-badge-12,size,p.ink,600);ctx.restore();
    });
    if(!hasPitch)return;
    const field={x:x+tableW+margin,y:y+header,w:w-tableW-margin*2,h:h-header-margin};rect(ctx,field.x,field.y,field.w,field.h,p.field);
    ctx.save();ctx.strokeStyle=p.pitch;ctx.lineWidth=1.5;ctx.strokeRect(field.x+10,field.y+10,field.w-20,field.h-20);
    ctx.beginPath();ctx.moveTo(field.x+10,field.y+field.h/2);ctx.lineTo(field.x+field.w-10,field.y+field.h/2);ctx.stroke();
    ctx.beginPath();ctx.arc(field.x+field.w/2,field.y+field.h/2,field.h*.12,0,Math.PI*2);ctx.stroke();ctx.restore();
    let index=0;[1,...c.formation.split('-').map(Number)].forEach((count,row)=>{
      for(let n=0;n<count;n++,index++){
        const player=t.players[index];if(!player)continue;
        const px=field.x+field.w*(n+1)/(count+1),py=field.y+field.h*(.86-row*.235),badge=Math.max(25,Math.min(44,field.h*.1)),reveal=ease((age-.15-index*.075)/.35);
        ctx.save();ctx.globalAlpha*=reveal;rect(ctx,px-badge/2,py-badge/2,badge,badge,t.color);
        label(ctx,player.number,px-badge/2,py,badge,badge*.63,teamInk(t.color),700,'center');
        label(ctx,player.name.trim().split(/\s+/).pop()||'',px-field.w/(count+1)*.45,py+badge*.91,field.w/(count+1)*.9,Math.max(12,badge*.38),p.ink,600,'center');ctx.restore();
      }
    });
  }
  function templateStats(ctx,c,p,box){
    const {x,y,w,h}=box,margin=Math.max(12,Math.min(w,h)*.04),header=Math.min(156,Math.max(76,h*.27)),size=Math.min(33,Math.max(17,w*.04)),
      rowH=(h-header-margin)/Math.max(1,c.stats.length);
    rect(ctx,x,y,w,h,p.panel);rule(ctx,x,y,w/2,c.home.color,5);rule(ctx,x+w/2,y,w/2,c.away.color,5);
    label(ctx,c.headline,x+margin,y+header*.27,w-margin*2,size,p.ink,700,'center');
    label(ctx,c.home.short.toUpperCase(),x+margin,y+header*.7,w*.28,size*.8,p.ink,700,'center');
    score(ctx,c,x+w*.37,y+header*.49,w*.26,header*.43,p);label(ctx,c.away.short.toUpperCase(),x+w*.72-margin,y+header*.7,w*.28,size*.8,p.ink,700,'center');
    c.stats.forEach((item,i)=>{
      const py=y+header+rowH*(i+.5),font=Math.min(29,Math.max(13,rowH*.43));
      label(ctx,item.home,x+margin,py,w*.22,font,p.ink,700,'center');label(ctx,item.label,x+w*.26,py,w*.48,font*.77,p.muted,600,'center');
      label(ctx,item.away,x+w*.78-margin,py,w*.22,font,p.ink,700,'center');rule(ctx,x+margin,py+rowH*.46,w-margin*2,p.line,1);
    });
  }
  function templateEvent(ctx,c,p,box){
    const {x,y,w,h}=box,t=c[c.team],eventH=Math.min(h,Math.max(110,h*.32)),py=y+h-eventH,margin=Math.max(12,w*.035),size=Math.min(52,Math.max(21,w*.06));
    rect(ctx,x,py,w,eventH,p.panel);rule(ctx,x,py,w,p.accent,5);
    label(ctx,c.headline,x+margin,py+eventH*.22,w-margin*2,size,p.ink,750);
    if(c.preset==='substitution'){
      label(ctx,'ON  '+(c.playerIn||'Player on'),x+margin,py+eventH*.52,w-margin*2,size*.61,p.ink,600);
      label(ctx,'OFF  '+(c.playerOut||'Player off'),x+margin,py+eventH*.81,w-margin*2,size*.61,p.muted,600);
    }else{
      label(ctx,c.preset==='goal'?(c.player||t.name):c.home.name+' / '+c.away.name,x+margin,py+eventH*.54,w-margin*2,size*.68,p.ink,650);
      label(ctx,(c.minute?c.minute+'′ · ':'')+c.home.short+' '+c.homeScore+'–'+c.awayScore+' '+c.away.short,x+margin,py+eventH*.83,w-margin*2,size*.51,p.muted,600);
    }
  }
  function paintTemplate(ctx,c,definition,canvas,age,seconds,parts,timeMs,anchor){
    ctx._sportsFont='"'+definition.typography.family+'",Arial,sans-serif';
    ctx._sportsTypeScale=Math.max(.85,Math.min(1.5,definition.typography.sizeHD/43.2));
    ctx._sportsFixedSize=true;
    if(parts.length){
      for(const part of parts){const result=window.OpenLiveFullTemplates.drawPart(c.templateId,part.id,ctx,{width:WIDTH,height:HEIGHT},part.style,undefined,
        {timeMs:anchor+Math.min(10000,Math.max(0,timeMs-anchor)),anchorMs:anchor});
        if(result?.state!=='drawn')throw Error(result?.error||'The native sports component has not been prepared.');}
      return;
    }
    const p=nativePalette(definition),isFrame=c.placement==='frame',margin=isFrame?Math.min(canvas.width,canvas.height)*.035:0,
      box=isFrame?{x:margin,y:margin,w:canvas.width-margin*2,h:canvas.height-margin*2}:definition.safeRect;
    ctx.save();try{
      ctx.beginPath();ctx.rect(box.x,box.y,box.w,box.h);ctx.clip();
      if(c.preset==='scoreboard')templateScoreboard(ctx,c,p,box,seconds,isFrame);
      else if(c.preset==='lineup')templateLineup(ctx,c,p,box,age);
      else if(c.preset==='match-stats')templateStats(ctx,c,p,box);
      else templateEvent(ctx,c,p,box);
    }finally{ctx.restore();}
  }
  function create(raw={},options={}){
    const config=freeze(normalize(raw)),doc=options.document||document,now=options.now||(()=>performance.now()),
      definition=config.templateId?resolveTemplate(config.templateId,config.frameIndex,config.templateStyle):null,el=doc.createElement('canvas');
    el.width=definition&&config.placement==='frame'?Math.max(1,Math.round(definition.framePixels.w)):WIDTH;
    el.height=definition&&config.placement==='frame'?Math.max(1,Math.round(definition.framePixels.h)):HEIGHT;
    const ctx=el.getContext('2d');if(!ctx)throw Error('The sports source canvas is unavailable.');
    const createdAt=now(),carriedAge=numeric(options.animationElapsed,0,0,Number.MAX_SAFE_INTEGER,'Animation age'),
      epochAnchor=Date.now(),p=palette(config.style),timed=['goal','substitution','replay-title'].includes(config.preset),parts=definition?nativeEventParts(config,definition):[],
      animationElapsed=()=>Math.max(0,(now()-anchor)/1000);
    let anchor=createdAt-carriedAge*1000,disposed=false,lastFrame=null,preparation=null,failure='',ready=!definition;
    function renderFrame(timeMs=now()){
      if(disposed||!ready)return false;
      const at=typeof timeMs==='number'&&Number.isFinite(timeMs)?timeMs:now(),age=Math.max(0,(at-anchor)/1000),
        seconds=config.clock.elapsed+(config.clock.running?Math.max(0,(epochAnchor+at-createdAt-config.clock.startedAt)/1000):0),
        hidden=timed&&age>=config.duration,animating=age<1.5||parts.length&&age<10||timed&&age>config.duration-.45,
        frame=hidden?'hidden':animating?Math.floor(age*60):config.preset==='scoreboard'&&config.clock.running?'clock:'+Math.floor(seconds):'static';
      if(frame===lastFrame)return false;
      try{
        ctx.clearRect(0,0,el.width,el.height);
        if(!hidden){
          ctx.save();try{
            // 96px horizontal safety margin; only the panel moves on entrance.
            const entrance=ease(.18+age/.55),exit=timed?clamp((config.duration-age)/.45):1;
            ctx.globalAlpha=entrance*exit;ctx.translate(0,(1-entrance)*24);
            if(definition)paintTemplate(ctx,config,definition,el,age,seconds,parts,at,anchor);
            else if(config.preset==='scoreboard')scoreboard(ctx,config,p,seconds);
            else if(config.preset==='lineup')lineup(ctx,config,p,age);
            else if(config.preset==='goal')goal(ctx,config,p,age);
            else if(config.preset==='substitution')substitution(ctx,config,p);
            else if(config.preset==='match-stats')stats(ctx,config,p);
            else replay(ctx,config,p,age);
          }finally{ctx.restore();}
        }
        lastFrame=frame;return true;
      }catch(error){failure=error.message||String(error);throw error;}
    }
    const runtime={kind:'text',sourceType:'sports',label:'Football · '+catalogue.find(item=>item.id===config.preset).label,
      config,_sourceConfig:freeze(clone(config)),el,
      ...(definition?{sportsTemplateDefinition:definition}:{}),
      initialTransform:{x:0,y:0,w:1,h:1,rotation:0},renderFrame,animationElapsed,
      runtimeStatus:()=>disposed?{ok:false,state:'ended',why:'The sports source has been released.'}:
        failure?{ok:false,state:'failed',why:failure}:!ready?{ok:false,state:'loading',why:'Preparing native template components and typography.'}:{ok:true,state:'ready'},
      prepare(){
        if(preparation)return preparation;
        if(!definition){preparation=Promise.resolve().then(()=>{if(disposed)throw Error('Source preparation cancelled.');renderFrame();return runtime;});return preparation;}
        preparation=Promise.resolve().then(async()=>{
          if(disposed)throw Error('Source preparation cancelled.');
          if(definition){
            const fonts=window.OpenLiveFontAssets;
            await Promise.all([
              ...parts.map(part=>window.OpenLiveFullTemplates.loadPart(config.templateId,part.id,{style:part.style})),
              ...(fonts?.ensure?[fonts.ensure(definition.typography.family,definition.typography.weight)]:
                doc.fonts?.load?[doc.fonts.load(definition.typography.weight+' 20px "'+definition.typography.family+'"','SHOWAVE FOOTBALL')]:[])
            ]);
          }
          if(disposed)throw Error('Source preparation cancelled.');
          if(definition&&carriedAge===0)anchor=now();
          ready=true;lastFrame=null;renderFrame();return runtime;
        }).catch(error=>{failure=error.message||String(error);throw error;});
        return preparation;
      },
      forkProgramme(){if(disposed)throw Error('This sports source is unavailable.');return create(config,{document:doc,now,
        animationElapsed:timed&&animationElapsed()>=config.duration?config.duration:0});},
      dispose(){if(disposed)return;disposed=true;el.width=el.height=1;el.remove?.();}
    };
    renderFrame();return runtime;
  }
  return Object.freeze({catalogue,templateDefinitions,resolveTemplate,normalize,create});
})();
