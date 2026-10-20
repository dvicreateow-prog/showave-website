/* Audience is a SHOWAVE extension. Responses are polled outside the compositor;
   Preview and Programme own independent canvases and share read-only snapshots. */
window.OpenLiveAudience=(()=>{
  'use strict';
  const catalogue=items=>Object.freeze(items.map(([id,label])=>Object.freeze({id,label})));
  const QUESTION_TYPES=catalogue([['multiple-choice','Multiple choice'],['word-cloud','Word cloud'],['open-ended','Open ended'],['scales','Scales'],['ranking','Ranking'],['q&a','Questions and answers'],['number','Number'],['points','XY plot'],['grid','2 × 2 grid'],['allocation','Allocate points'],['quiz-choice','Quiz choice'],['quiz-text','Quiz text'],['form','Form'],['pin-image','Pin on image'],['content','Content'],['chart','Data chart']]);
  const CHART_TYPES=catalogue([['bar','Bar'],['column','Column'],['pie','Pie'],['donut','Donut'],['line','Line'],['area','Area'],['radar','Radar'],['gauge','Gauge'],['scatter','Scatter'],['table','Table'],['word-cloud','Word cloud']]);
  const PRESENTATIONS=catalogue([['flat','Flat'],['broadcast','Broadcast'],['dimensional','Dimensional']]);
  const FRAMINGS=catalogue([['full','Full frame'],['left','Left panel'],['right','Right panel'],['lower-third','Lower third']]);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const object=(value,label)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Choose valid '+label+'.');return value;};
  const text=(value,fallback,limit,label,multiline=false)=>{const out=value??fallback;if(typeof out!=='string'||out.length>limit||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(out))throw Error(label+' must have at most '+limit+' characters.');return out.trim();};
  const number=(value,label,min=-1e12,max=1e12)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error('Choose a finite '+label+' between '+min+' and '+max+'.');return value;};
  const count=value=>number(value,'response count',0,1e9);
  const choice=(value,fallback,values,label)=>{const out=value??fallback;if(!values.includes(out))throw Error('Choose a supported '+label+'.');return out;};
  const bool=(value,fallback,label)=>{const out=value??fallback;if(typeof out!=='boolean')throw Error(label+' must be on or off.');return out;};
  const color=(value,fallback)=>{const out=value??fallback;if(typeof out!=='string'||!/^#[0-9a-f]{6}$/i.test(out))throw Error('Choose a six-digit color.');return out.toLowerCase();};
  const identity=(value,label,required=false)=>{const out=text(value,'',160,label);if((required&&!out)||out&&!/^[a-zA-Z0-9_-]+$/.test(out))throw Error('Choose a valid '+label+'.');return out;};
  function url(value){const out=text(value,'',4096,'URL');if(!out)return '';let parsed;try{parsed=new URL(out,'http://localhost');}catch(_){throw Error('Choose a valid audience URL.');}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||out.startsWith('//'))throw Error('Use an HTTP or HTTPS audience URL without credentials.');return out;}
  function dataRows(value=[]){if(!Array.isArray(value)||value.length>200)throw Error('Use at most 200 data rows.');return value.map((row,index)=>{object(row,'data row');return {label:text(row.label,'Row '+(index+1),120,'Data label'),value:number(row.value,'data value'),...(row.x===undefined?{}:{x:number(row.x,'X')}),...(row.y===undefined?{}:{y:number(row.y,'Y')})};});}
  function normalize(raw={}){
    object(raw,'audience settings');const mode=choice(raw.mode,'results',['results','join','leaderboard','data'],'audience view'),live=mode!=='data',
      sessionId=identity(raw.sessionId,'session id',live),viewToken=identity(raw.viewToken,'view token',live),questionId=['join','leaderboard'].includes(mode)?'':identity(raw.questionId,'question id',mode==='results'),presentation=choice(raw.presentation,'flat',PRESENTATIONS.map(row=>row.id),'presentation');
    return {sessionId,viewToken,questionId,mode,chart:choice(raw.chart,'bar',CHART_TYPES.map(row=>row.id),'chart'),title:text(raw.title,'',300,'Title',true).replace(/\s+/g,' '),
      presentation,framing:choice(raw.framing,'full',FRAMINGS.map(row=>row.id),'framing'),panelOpacity:number(raw.panelOpacity??.92,'panel opacity',0,1),depth:number(raw.depth??.55,'depth',0,1),motion:bool(raw.motion,false,'Reveal motion'),
      foreground:color(raw.foreground,presentation==='flat'?'#25272a':'#f1f3f6'),background:color(raw.background,presentation==='flat'?'#e7e7ec':'#181d24'),accent:color(raw.accent,'#0088ff'),
      transparent:bool(raw.transparent,false,'Transparent background'),showQR:bool(raw.showQR,true,'Join QR'),joinUrl:url(raw.joinUrl),data:dataRows(raw.data)};
  }
  async function clientRequest(path,{method='GET',body,signal,fetch:fetcher=window.fetch?.bind(window),timeoutMs=10000}={}){
    if(typeof path!=='string'||!path.startsWith('/api/audience/')||path.startsWith('//')||/[\u0000-\u001f]/.test(path))throw Error('Choose an Audience API path.');
    if(typeof fetcher!=='function')throw Error('The audience service is unavailable.');
    if(signal?.aborted)throw Error('Audience request cancelled.');number(timeoutMs,'request timeout',1,120000);
    const controller=typeof AbortController==='function'?new AbortController():null;let timer,abort,timedOut=false;
    const cancelled=new Promise((_,reject)=>{abort=()=>{controller?.abort();reject(Error('Audience request cancelled.'));};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{timedOut=true;controller?.abort();reject(Error('The audience service did not respond in time.'));},Math.max(1,timeoutMs));});
    const request=(async()=>{let response;try{response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller?.signal||signal});}
      catch(error){if(signal?.aborted)throw Error('Audience request cancelled.');if(timedOut)throw Error('The audience service did not respond in time.');throw Error('The audience service is offline.');}
      let result;try{result=await response.json();}catch(_){throw Error('The audience service returned an unreadable response.');}
      if(!response.ok){const error=Error(typeof result?.error==='string'?result.error.slice(0,300):'The audience request was rejected ('+response.status+').');error.status=response.status;throw error;}
      return result;})();
    try{return await Promise.race([request,cancelled]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  // Reject invalid or mismatched service data before a source becomes ready.
  function snapshot(raw,config){
    object(raw,'audience results');if(raw.sessionId!==config.sessionId)throw Error('The audience session does not match this source.');
    const revision=count(raw.revision),question=raw.question===null?null:object(raw.question,'audience question');
    if(config.mode==='results'&&question?.id!==config.questionId)throw Error('The audience question is unavailable in this session.');
    const safeQuestion=question?{id:identity(question.id,'question id',true),type:choice(question.type,undefined,QUESTION_TYPES.map(row=>row.id),'question type'),
      title:text(question.title,'',500,'Question title',true),min:question.min===undefined?0:number(question.min,'minimum'),max:question.max===undefined?100:number(question.max,'maximum'),
      text:text(question.text??question.body,'',3000,'Content',true),imageUrl:url(question.imageUrl),xLabel:text(question.xLabel,'X',120,'X label',true),yLabel:text(question.yLabel,'Y',120,'Y label',true),options:Array.isArray(question.options)?question.options.slice(0,200).map(row=>({id:identity(row.id,'option id',true),label:text(row.label,'',240,'Option label',true)})):[],
      ...(question.data?{data:dataRows(question.data)}:{}),...(question.chart?{chart:choice(question.chart,undefined,CHART_TYPES.map(row=>row.id),'chart')}:{})}:null;
    const aggregate=object(raw.aggregate,'audience aggregates'),safe={responses:count(aggregate.responses??0)};
    if(aggregate.totalParticipants!==undefined)safe.totalParticipants=count(aggregate.totalParticipants);
    for(const field of ['shownResponses','omittedResponses'])if(aggregate[field]!==undefined)safe[field]=count(aggregate[field]);
    if(aggregate.histogramBinned!==undefined)safe.histogramBinned=bool(aggregate.histogramBinned,false,'Histogram grouping');
    if(aggregate.histogramBinWidth!==undefined)safe.histogramBinWidth=number(aggregate.histogramBinWidth,'histogram interval',0);
    const arr=(field,map)=>{if(aggregate[field]!==undefined){if(!Array.isArray(aggregate[field])||aggregate[field].length>1000)throw Error('Invalid audience '+field+'.');safe[field]=aggregate[field].map(map);}};
    arr('series',row=>{object(row,'result row');return {id:text(row.id,'',160,'Result id'),label:text(row.label,'',240,'Result label',true),value:number(row.value??row.count,'result value'),...(row.count===undefined?{}:{count:count(row.count)})};});
    arr('entries',row=>{object(row,'audience response');return {id:text(row.id,'',160,'Response id'),text:text(row.text??row.label,'',16000,'Response text',true),votes:count(row.votes??0),...(row.value===undefined?{}:{value:number(row.value,'response value')})};});
    arr('words',row=>({text:text(row.text,'',120,'Word'),count:count(row.count)}));
    arr('points',row=>({x:number(row.x,'X'),y:number(row.y,'Y')}));
    const leaderboardRow=row=>({name:text(row.name,'',120,'Participant name',true),score:number(row.score,'score'),rank:count(row.rank)});arr('leaderboard',leaderboardRow);
    if(raw.leaderboard!==undefined&&(!Array.isArray(raw.leaderboard)||raw.leaderboard.length>1000))throw Error('Invalid audience leaderboard.');
    if(aggregate.average!==undefined&&aggregate.average!==null)safe.average=typeof aggregate.average==='object'?{x:number(aggregate.average.x,'average X'),y:number(aggregate.average.y,'average Y')}:number(aggregate.average,'average');
    for(const name of ['min','max'])if(aggregate[name]!==undefined&&aggregate[name]!==null)safe[name]=number(aggregate[name],name);
    return freeze({sessionId:config.sessionId,revision,title:text(raw.title,'Audience',160,'Session title'),question:safeQuestion,aggregate:safe,
      open:bool(raw.open,false,'Voting'),showResults:bool(raw.showResults,false,'Results'),code:text(raw.code,'',16,'Join code'),joinUrl:url(raw.joinUrl),
      leaderboard:raw.leaderboard===undefined?(raw.showResults?safe.leaderboard||[]:[]):raw.leaderboard.map(leaderboardRow)});
  }
  const pools=new Map();
  function poolFor(options){const owner=options.cache||options.fetch||window;let pool=pools.get(owner);if(!pool){pool=new Map();pools.set(owner,pool);}return {owner,pool};}
  function backing(config,options){
    const {owner,pool}=poolFor(options),key=[config.sessionId,config.viewToken,config.questionId].join('|');let shared=pool.get(key);
    if(!shared){
      const clock=options.clock||{setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)},subscribers=new Set();
      shared={refs:0,revision:0,status:'loading',error:'',value:null,timer:null,pending:null,controller:null,closed:false,terminal:false,subscribers};
      const notify=()=>{shared.revision++;for(const listener of subscribers)try{listener();}catch(_){}};
      const schedule=()=>{if(shared.closed||shared.terminal||!shared.refs||shared.timer!==null)return;shared.timer=clock.setTimeout(()=>{shared.timer=null;refresh().catch(()=>{});},1500);};
      const refresh=()=>{
        if(shared.closed)return Promise.reject(Error('The audience source has been released.'));
        if(shared.pending)return shared.pending;
        shared.controller=typeof AbortController==='function'?new AbortController():null;
        const path='/api/audience/results/'+encodeURIComponent(config.sessionId)+'?token='+encodeURIComponent(config.viewToken)+(config.questionId?'&questionId='+encodeURIComponent(config.questionId):'');
        shared.pending=clientRequest(path,{signal:shared.controller?.signal,fetch:options.fetch}).then(value=>{
          if(shared.closed)throw Error('The audience source has been released.');const next=snapshot(value,config);
          if(!shared.value||JSON.stringify(next)!==JSON.stringify(shared.value)||shared.status!=='ready'){shared.value=next;shared.status='ready';shared.terminal=false;shared.error='';notify();}
          return shared.value;
        }).catch(error=>{if(!shared.closed){shared.terminal=[403,404,422].includes(error.status);shared.status=shared.terminal?'unavailable':'offline';shared.error=error.message||'The audience service is unavailable.';if(shared.terminal&&shared.timer!==null){clock.clearTimeout(shared.timer);shared.timer=null;}notify();}throw error;})
          .finally(()=>{shared.pending=null;shared.controller=null;schedule();});return shared.pending;
      };
      shared.refresh=refresh;shared.release=listener=>{subscribers.delete(listener);if(--shared.refs>0)return;shared.closed=true;if(shared.timer!==null)clock.clearTimeout(shared.timer);shared.controller?.abort();pool.delete(key);if(!pool.size)pools.delete(owner);};
      pool.set(key,shared);
    }
    shared.refs++;return shared;
  }
  const compact=value=>Number.isInteger(value)?String(value):Math.abs(value)<.01?String(Number(value.toPrecision(3))):String(Math.round(value*100)/100);
  function participantURL(config,value,origin){
    if(!config.joinUrl)return value?.joinUrl||'';
    if(!value?.joinUrl)return config.joinUrl;
    const resolve=target=>new URL(target,origin||'http://localhost'),saved=resolve(config.joinUrl),current=resolve(value.joinUrl),
      local=host=>host==='localhost'||host==='::1'||host==='[::1]'||/^127\./.test(host);
    // A link captured before LAN sharing began is a placeholder. A deliberate
    // external URL/interface choice remains a pinned source setting.
    return local(saved.hostname)&&!local(current.hostname)?value.joinUrl:config.joinUrl;
  }
  function create(raw={},options={}){
    const config=freeze(normalize(raw)),doc=options.document||document,el=doc.createElement('canvas');el.width=1920;el.height=1080;
    const ctx=el.getContext('2d');if(!ctx)throw Error('The audience canvas renderer is unavailable.');
    let disposed=false,shared=null,preparation=null,lastFrame='',localError='',qr=null,qrUrl='',image=null,imageUrl='',imageSequence=0,imageError='',imagePreparation=null,cancelImage=null,fontScale=1,compactFrame=false,animationStart=null;
    const reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)'),now=options.now||(()=>window.performance?.now?.()??Date.now()),motionAllowed=()=>config.motion&&!reducedMotion?.matches&&options.reducedMotion!==true;
    const legacy=config.presentation==='flat'&&config.framing==='full',dimensional=config.presentation==='dimensional'&&config.depth>0;
    const frame=legacy?{x:0,y:0,w:1920,h:1080}:config.framing==='left'?{x:64,y:120,w:1120,h:880}:config.framing==='right'?{x:736,y:120,w:1120,h:880}:config.framing==='lower-third'?{x:64,y:710,w:1792,h:306}:{x:64,y:64,w:1792,h:952};
    const isAnimating=()=>!disposed&&motionAllowed()&&animationStart!==null&&now()-animationStart<480;
    const listener=()=>{if(!disposed){prepareImage().catch(()=>{});options.onChange?.(runtime);}};
    const status=()=>disposed?{ok:false,state:'ended',why:'The audience source has been released.'}:localError?{ok:false,state:'failed',why:localError}:config.mode==='data'?{ok:true,state:'ready'}:
      shared?.status==='ready'?config.mode==='results'&&shared.value.question?.type==='pin-image'&&shared.value.question.imageUrl&&!image?
        {ok:false,state:imageError?'failed':'loading',why:imageError||'Preparing the question image.'}:{ok:true,state:'ready'}:
        {ok:false,state:shared?.status==='unavailable'?'unavailable':shared?.status==='offline'?'offline':'loading',why:shared?.error||'Preparing the audience session and question.'};
    const write=(value,x,y,size=32,align='left',ink=config.foreground,weight=400,maxWidth)=>{
      ctx.fillStyle=ink;ctx.font=weight+' '+size*fontScale+'px Arial, sans-serif';ctx.textAlign=align;ctx.textBaseline='middle';let label=String(value).replace(/\s+/g,' ');
      if(maxWidth&&ctx.measureText(label).width>maxWidth){let low=0,high=label.length;while(low<high){const mid=Math.ceil((low+high)/2);if(ctx.measureText(label.slice(0,mid)+'…').width<=maxWidth)low=mid;else high=mid-1;}label=label.slice(0,low)+'…';}
      ctx.fillText(label,x,y);
    };
    const line=(x1,y1,x2,y2,ink=config.foreground,width=2)=>{ctx.strokeStyle=ink;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();};
    const ink=(i,n)=>{if(!i)return config.accent;const hue=(i*360/Math.max(n,3)+205)%360;return 'hsl('+hue+' 55% 48%)';};
    const polygon=(points,fill,shade=0)=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(shade){ctx.save();ctx.globalAlpha*=Math.abs(shade);ctx.fillStyle=shade>0?'#ffffff':'#000000';ctx.fill();ctx.restore();}};
    function dimensionalRect(x,y,w,h,fill,direction=1,vertical=false){
      const depth=Math.min((compactFrame?9:26)*config.depth,Math.max(0,Math.min(w,h)*.5)),dx=depth*(vertical?1:direction),dy=-depth*.65;
      if(depth>0){polygon([[x,y],[x+w,y],[x+w+dx,y+dy],[x+dx,y+dy]],fill,.23);const side=direction<0&&!vertical?x:x+w;polygon([[side,y],[side,y+h],[side+dx,y+h+dy],[side+dx,y+dy]],fill,-.3);}
      ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);
    }
    const wrap=(value,x,y,width,size=36,max=12)=>{const words=String(value).split(/\s+/);let output='',row=0;for(const word of words){const next=output?output+' '+word:word;ctx.font='400 '+size+'px Arial, sans-serif';if(output&&ctx.measureText(next).width>width){write(output,x,y+row++*size*1.35,size,'left',config.foreground,400,width);output=word;if(row>=max)return;}else output=next;}if(output)write(output,x,y+row*size*1.35,size,'left',config.foreground,400,width);};
    function prepareImage(){
      const question=shared?.value?.question,target=config.mode==='results'&&question?.type==='pin-image'?question.imageUrl:'';
      if(!target){if(imageUrl||image){cancelImage?.();cancelImage=null;imageUrl='';imageError='';imagePreparation=null;imageSequence++;if(image)image.src='';image=null;}return Promise.resolve();}
      if(target===imageUrl)return imagePreparation||Promise.resolve();
      cancelImage?.();cancelImage=null;imageUrl=target;imageError='';if(image)image.src='';image=null;const sequence=++imageSequence,ImageType=options.Image||window.Image;
      if(typeof ImageType!=='function'){imageError='The image decoder is unavailable.';return Promise.reject(Error(imageError));}
      imagePreparation=new Promise((resolve,reject)=>{const next=new ImageType();next.crossOrigin='anonymous';let timer;const detach=()=>{clearTimeout(timer);next.onload=next.onerror=null;cancelImage=null;};
        cancelImage=()=>{detach();next.src='';resolve();};next.onload=()=>{detach();if(disposed||sequence!==imageSequence){next.src='';resolve();return;}if(!(next.naturalWidth||next.width)||!(next.naturalHeight||next.height)){imageError='The question image has no decoded dimensions.';reject(Error(imageError));return;}image=next;imageSequence++;lastFrame='';listener();resolve();};
        const failed=why=>{detach();next.src='';if(!disposed&&sequence===imageSequence){imageError=why;lastFrame='';options.onChange?.(runtime);}reject(Error(imageError||'Question image cancelled.'));};
        next.onerror=()=>failed('The question image could not be loaded. Use an image that permits browser access.');timer=setTimeout(()=>failed('The question image did not load in time.'),10000);next.src=target;});return imagePreparation;
    }
    function drawQR(value,box,position){
      if(!value)return;const absolute=new URL(value,options.origin||window.location?.origin||'http://localhost').href;
      if(absolute!==qrUrl){if(typeof window.OpenLiveCommerce?.qrMatrix!=='function')throw Error('The local QR encoder is unavailable.');qr=window.OpenLiveCommerce.qrMatrix(absolute);qrUrl=absolute;}
      const quiet=4,unit=box/(qr.size+quiet*2),x=position?.x??1920-box-65,y=position?.y??1080-box-92;ctx.fillStyle='#ffffff';ctx.fillRect(x,y,box,box);ctx.fillStyle='#111111';
      for(let row=0;row<qr.size;row++)for(let col=0;col<qr.size;col++)if(qr.cells[row*qr.size+col])ctx.fillRect(x+(col+quiet)*unit,y+(row+quiet)*unit,unit+.2,unit+.2);
      write('Scan to join',x+box/2,y+box+32,24,'center');
    }
    function chart(series,kind,box,question={}){
      const {x,y,w,h}=box,limit=kind==='bar'?(compactFrame?3:7):kind==='table'?(compactFrame?4:10):kind==='radar'?12:series.length,rows=series.slice(0,limit),values=rows.map(row=>row.value),max=Math.max(0,...values),min=Math.min(0,...values),range=max-min||1;
      if(!rows.length){write('No responses yet',x+w/2,y+h/2,42,'center');return;}
      if(!['pie','donut','gauge'].includes(kind)&&series.length>rows.length)write('Showing '+rows.length+' of '+series.length+' values',x+w,y+h+(compactFrame?18:35),compactFrame?22:28,'right');
      if(kind==='table'){const step=compactFrame?36:64;rows.forEach((row,i)=>{const at=y+i*step;write(row.label,x,at+(compactFrame?step*.44:28),compactFrame?30:38,'left',config.foreground,400,w*.72);write(compact(row.value),x+w,at+(compactFrame?step*.44:28),compactFrame?32:42,'right',config.accent,700);line(x,at+step-5,x+w,at+step-5,'#b6b7bf',1);});return;}
      if(kind==='pie'||kind==='donut'){
        if(series.some(row=>row.value<0)){write('Pie charts require non-negative values',x+w/2,y+h/2,32,'center');return;}
        const total=series.reduce((sum,row)=>sum+row.value,0),positive=series.filter(row=>row.value>0),maxSlices=compactFrame?4:11,slices=positive.length>maxSlices?[...positive.slice(0,maxSlices-1),{label:'Other ('+(positive.length-maxSlices+1)+' categories)',value:positive.slice(maxSlices-1).reduce((sum,row)=>sum+row.value,0)}]:positive;
        if(!total){write('No responses yet',x+w/2,y+h/2,42,'center');return;}
        const radius=Math.min(w*.27,h*(compactFrame?.45:.4)),cx=x+w*(compactFrame?.10:.32),cy=y+h*.48,legendStep=Math.min(112,h/slices.length),labelSize=Math.round(Math.min(46,Math.max(compactFrame?23:30,legendStep*.45))),valueSize=Math.round(Math.min(34,Math.max(compactFrame?21:24,legendStep*.34))),swatch=Math.min(32,labelSize),legendHeight=(slices.length-1)*legendStep+labelSize+valueSize+4,legendTop=y+(h-legendHeight)/2;
        const angles=[];let angle=-Math.PI/2;for(const row of slices){const end=angle+row.value/total*Math.PI*2;angles.push([angle,end]);angle=end;}
        const slicePath=(start,end)=>{ctx.beginPath();if(kind==='donut'){ctx.arc(0,0,radius,start,end);ctx.arc(0,0,radius*.57,end,start,true);}else{ctx.moveTo(0,0);ctx.arc(0,0,radius,start,end);}ctx.closePath();};
        if(dimensional){const height=Math.min(compactFrame?18:55,radius*.2)*config.depth;ctx.save();ctx.translate(cx,cy);ctx.scale(1,.72);
          for(let layer=12;layer>=1;layer--){ctx.save();ctx.translate(0,height*layer/12);slices.forEach((row,i)=>{slicePath(...angles[i]);ctx.fillStyle=ink(i,slices.length);ctx.fill();ctx.save();ctx.globalAlpha*=.34;ctx.fillStyle='#000000';ctx.fill();ctx.restore();});ctx.restore();}
          slices.forEach((row,i)=>{slicePath(...angles[i]);ctx.fillStyle=ink(i,slices.length);ctx.fill();ctx.save();ctx.globalAlpha*=.17;ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();});ctx.restore();
        }else{slices.forEach((row,i)=>{ctx.fillStyle=ink(i,slices.length);ctx.beginPath();const [start,end]=angles[i];if(kind==='donut'){ctx.arc(cx,cy,radius,start,end);ctx.arc(cx,cy,radius*.57,end,start,true);}else{ctx.moveTo(cx,cy);ctx.arc(cx,cy,radius,start,end);}ctx.closePath();ctx.fill();});}
        if(compactFrame){const legendX=x+w*.23,legendW=w*.77,columns=Math.min(4,slices.length),cellW=legendW/columns;for(const [i,row] of slices.slice(0,columns).entries()){const atX=legendX+i*cellW;ctx.fillStyle=ink(i,slices.length);ctx.fillRect(atX,y+h*.22,18,18);write(row.label,atX+28,y+h*.22+9,28,'left',config.foreground,400,cellW-36);write(compact(row.value)+' ('+compact(row.value/total*100)+'%)',atX+28,y+h*.58,32,'left',config.foreground,700,cellW-36);}if(slices.length>columns)write('Showing '+columns+' of '+slices.length+' categories',x+w,y+h+18,22,'right');}
        else slices.forEach((row,i)=>{ctx.fillStyle=ink(i,slices.length);const at=legendTop+i*legendStep,labelY=at+labelSize/2;ctx.fillRect(x+w*.61,labelY-swatch/2,swatch,swatch);write(row.label,x+w*.61+swatch+13,labelY,labelSize,'left',config.foreground,400,w*.39-swatch-13);write(compact(row.value)+' ('+compact(row.value/total*100)+'%)',x+w*.61+swatch+13,at+labelSize+4+valueSize/2,valueSize);});
        if(kind==='donut')write(compact(total),cx,cy,compactFrame?35:54,'center',config.foreground,700);return;
      }
      if(kind==='gauge'){
        const value=values[0],lo=question.min??min,hi=question.max??max;if(!(hi>lo)){write('Gauge needs a maximum above its minimum',x+w/2,y+h/2,30,'center');return;}
        const cx=x+w/2,cy=y+h*.7,r=Math.min(w*.34,h*.55),angle=Math.PI+Math.min(1,Math.max(0,(value-lo)/(hi-lo)))*Math.PI;
        ctx.lineWidth=34;ctx.strokeStyle='#b6b7bf';ctx.beginPath();ctx.arc(cx,cy,r,Math.PI,Math.PI*2);ctx.stroke();ctx.strokeStyle=config.accent;ctx.beginPath();ctx.arc(cx,cy,r,Math.PI,angle);ctx.stroke();
        write(compact(value),cx,cy-(compactFrame?35:70),compactFrame?52:76,'center',config.foreground,700);write(compact(lo),cx-r,cy+35,28,'center');write(compact(hi),cx+r,cy+35,28,'center');return;
      }
      if(kind==='radar'){
        const cx=x+w/2,cy=y+h/2,r=Math.min(w,h)*(compactFrame?.25:.35),n=rows.length;if(n<3){write('Radar charts need at least three values',cx,cy,34,'center');return;}
        if(series.some(row=>row.value<0)){write('Radar charts require non-negative values',cx,cy,32,'center');return;}const scale=Math.max(1,...values);
        ctx.beginPath();rows.forEach((row,i)=>{const a=i/n*Math.PI*2-Math.PI/2;line(cx,cy,cx+Math.cos(a)*r,cy+Math.sin(a)*r,'#b6b7bf');const lx=cx+Math.cos(a)*(r+(compactFrame?26:48)),ly=cy+Math.sin(a)*(r+(compactFrame?26:48));write(row.label,lx,ly-13,25,'center',config.foreground,400,200);write(compact(row.value),lx,ly+17,25,'center',config.accent,700);});
        ctx.beginPath();rows.forEach((row,i)=>{const a=i/n*Math.PI*2-Math.PI/2,amount=Math.max(0,row.value)/scale*r,px=cx+Math.cos(a)*amount,py=cy+Math.sin(a)*amount;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});ctx.closePath();ctx.strokeStyle=config.accent;ctx.lineWidth=5;ctx.stroke();ctx.save();ctx.globalAlpha*=.2;ctx.fillStyle=config.accent;ctx.fill();ctx.restore();return;
      }
      if(kind==='bar'){
        const height=Math.min(90,h/Math.min(rows.length,7)),labelWidth=Math.min(w*.36,480),start=x+labelWidth,track=w-labelWidth-160,zero=start-min/range*track;
        line(zero,y,zero,y+rows.length*height,'#b6b7bf',1);rows.forEach((row,i)=>{const at=y+i*height;write(row.label,x,at+height/2,compactFrame?32:42,'left',config.foreground,400,labelWidth-20);const end=start+(row.value-min)/range*track,fill=ink(i,rows.length);ctx.fillStyle=fill;if(row.value!==0){if(dimensional)dimensionalRect(Math.min(zero,end),at+13,Math.abs(end-zero),height-26,fill,Math.sign(row.value));else ctx.fillRect(Math.min(zero,end),at+13,Math.abs(end-zero),height-26);}write(compact(row.value),x+w,at+height/2,compactFrame?38:46,'right',config.foreground,700);});return;
      }
      const left=x+55,bottom=y+h-85,width=w-80,height=h-110,point=(value,index)=>({x:left+(index+.5)/rows.length*width,y:bottom-(value-min)/range*height});
      line(left,y+20,left,bottom);line(left,bottom,left+width,bottom);write(compact(max),left-15,y+20,22,'right');write(compact(min),left-15,bottom,22,'right');
      const zero=bottom-(0-min)/range*height,labelEvery=Math.ceil(rows.length/8),labelPoint=(row,p,i)=>{if(i%labelEvery===0||i===rows.length-1)write(row.label,p.x,bottom+32,32,'center',config.foreground,400,width/Math.min(rows.length,9)*.95);if(rows.length<=12)write(compact(row.value),p.x,p.y-28,34,'center');};if(min<0)line(left,zero,left+width,zero,'#b6b7bf',1);
      if(kind==='column'){rows.forEach((row,i)=>{const p=point(row.value,i),bw=Math.min(100,width/rows.length*.7),fill=ink(i,rows.length);ctx.fillStyle=fill;if(row.value!==0){if(dimensional)dimensionalRect(p.x-bw/2,Math.min(p.y,zero),bw,Math.abs(zero-p.y),fill,1,true);else ctx.fillRect(p.x-bw/2,Math.min(p.y,zero),bw,Math.abs(zero-p.y));}labelPoint(row,p,i);});return;}
      if(kind==='area'){ctx.beginPath();ctx.moveTo(point(values[0],0).x,zero);rows.forEach((row,i)=>{const p=point(row.value,i);ctx.lineTo(p.x,p.y);});ctx.lineTo(point(values.at(-1),rows.length-1).x,zero);ctx.closePath();ctx.save();ctx.globalAlpha*=.18;ctx.fillStyle=config.accent;ctx.fill();ctx.restore();}
      ctx.beginPath();rows.forEach((row,i)=>{const p=point(row.value,i);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.lineWidth=5;ctx.strokeStyle=config.accent;ctx.stroke();rows.forEach((row,i)=>{const p=point(row.value,i);ctx.beginPath();ctx.arc(p.x,p.y,Math.min(7,width/rows.length*.2),0,Math.PI*2);ctx.fillStyle=config.accent;ctx.fill();labelPoint(row,p,i);});
    }
    function scatter(points,box,question={},average){
      const fixed=['points','grid'].includes(question.type),loX=fixed?0:Math.min(0,...points.map(p=>p.x)),hiX=fixed?100:Math.max(0,...points.map(p=>p.x))||(loX===0?1:0),loY=fixed?0:Math.min(0,...points.map(p=>p.y)),hiY=fixed?100:Math.max(0,...points.map(p=>p.y))||(loY===0?1:0),x=box.x+55,y=box.y+38,w=box.w-85,h=box.h-130;
      line(x,y,x,y+h);line(x,y+h,x+w,y+h);write(compact(loX),x,y+h+30,24);write(compact(hiX),x+w,y+h+30,24,'right');write(compact(loY),x-18,y+h,24,'right');write(compact(hiY),x-18,y,24,'right');
      write(question.xLabel||'X',x+w/2,y+h+65,30,'center',config.foreground,400,w);write(question.yLabel||'Y',x,y-25,30,'left',config.foreground,400,w*.6);
      if(question.type==='grid'){line(x+w/2,y,x+w/2,y+h,'#b6b7bf');line(x,y+h/2,x+w,y+h/2,'#b6b7bf');write('50',x+w/2,y+h+30,24,'center');write('50',x-18,y+h/2,24,'right');}
      if(!points.length){write('No responses yet',x+w/2,y+h/2,42,'center');return;}
      ctx.fillStyle=config.accent;for(const p of points){ctx.beginPath();ctx.arc(x+(p.x-loX)/(hiX-loX)*w,y+h-(p.y-loY)/(hiY-loY)*h,10,0,Math.PI*2);ctx.fill();}
      if(average&&typeof average==='object')write('Average · X '+compact(average.x)+' · Y '+compact(average.y),x+w,y-25,27,'right',config.foreground,400,w*.65);
    }
    function pins(points,box){
      if(!image){write(imageError||'No question image is available',box.x+box.w/2,box.y+box.h/2,35,'center');return;}
      const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height,scale=Math.min(box.w/iw,box.h/ih),w=iw*scale,h=ih*scale,x=box.x+(box.w-w)/2,y=box.y+(box.h-h)/2;
      ctx.drawImage(image,x,y,w,h);for(const point of points){ctx.beginPath();ctx.arc(x+Math.min(100,Math.max(0,point.x))/100*w,y+(100-Math.min(100,Math.max(0,point.y)))/100*h,10,0,Math.PI*2);ctx.fillStyle=config.accent;ctx.fill();ctx.strokeStyle='#ffffff';ctx.lineWidth=3;ctx.stroke();}
    }
    function renderFrame(){
      if(disposed)return false;const state=status(),value=shared?.value;if(state.ok&&animationStart===null&&motionAllowed())animationStart=now();const progress=motionAllowed()&&animationStart!==null?Math.min(1,Math.max(0,(now()-animationStart)/480)):1,step=Math.floor(progress*30),key=[config.mode,shared?.revision||0,state.state,imageSequence,imageError,step].join('|');if(key===lastFrame)return false;
      ctx.save();try{
        ctx.clearRect(0,0,1920,1080);compactFrame=!legacy&&config.framing==='lower-third';fontScale=compactFrame?.88:1;
        if(!legacy){ctx.beginPath();ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.clip();}
        if(progress<1){const ease=1-Math.pow(1-step/30,3);ctx.globalAlpha=ease;ctx.translate(0,14*(1-ease));}
        if(!config.transparent){ctx.save();ctx.globalAlpha*=legacy?1:config.panelOpacity;ctx.fillStyle=config.background;ctx.fillRect(frame.x,frame.y,frame.w,frame.h);ctx.restore();}
        const title=config.title||(config.mode==='leaderboard'?'Quiz leaderboard':config.mode==='join'?value?.title:value?.question?.title)||value?.title||'Audience';
        if(legacy){ctx.fillStyle=config.accent;ctx.fillRect(65,56,8,82);write(title,96,100,54,'left',config.foreground,700,1710);line(65,158,1855,158,'#b6b7bf',2);}
        else{ctx.fillStyle=config.accent;ctx.fillRect(frame.x,frame.y,7,frame.h);ctx.fillRect(frame.x+7,frame.y,frame.w-7,3);write(config.mode==='data'?'STATISTICS':config.mode==='leaderboard'?'QUIZ RESULTS':'AUDIENCE',frame.x+30,frame.y+(compactFrame?18:27),compactFrame?17:20,'left',config.accent,700);write(title,frame.x+30,frame.y+(compactFrame?46:72),compactFrame?36:50,'left',config.foreground,700,frame.w-60);line(frame.x+30,frame.y+(compactFrame?67:111),frame.x+frame.w-30,frame.y+(compactFrame?67:111),config.accent,1);}
        if(!state.ok){write(state.why,frame.x+frame.w/2,legacy?515:frame.y+frame.h*.52,compactFrame?30:38,'center',config.foreground,400,frame.w-80);if(value&&!compactFrame)write('Last received results are unavailable until the service reconnects.',frame.x+frame.w/2,legacy?580:frame.y+frame.h*.62,28,'center',config.foreground,400,frame.w-80);lastFrame=key;return true;}
        const joinUrl=participantURL(config,value,options.origin||window.location?.origin),hasQR=config.showQR&&!!joinUrl,qrSize=legacy?235:compactFrame?146:config.framing==='full'?205:178,box=legacy?{x:105,y:215,w:hasQR?1410:1710,h:675}:{x:frame.x+36,y:frame.y+(compactFrame?79:137),w:frame.w-72-(hasQR?qrSize+35:0),h:frame.h-(compactFrame?126:218)},question=value?.question||{},aggregate=value?.aggregate||{responses:0};let shownResponses=aggregate.shownResponses,detail='';
        if(config.mode==='join'){if(!compactFrame)write(value?.title||'Join the audience',box.x+box.w/2,legacy?360:box.y+box.h*.19,66,'center',config.foreground,700,box.w);write('Scan the code to participate',box.x+box.w/2,legacy?465:box.y+box.h*(compactFrame?.20:.38),compactFrame?30:43,'center',config.foreground,400,box.w);if(value?.code)write(value.code,box.x+box.w/2,legacy?595:box.y+box.h*(compactFrame?.56:.60),compactFrame?60:94,'center',config.accent,700);write(value?.open?'Accepting responses':'Responses are closed',box.x+box.w/2,legacy?735:box.y+box.h*(compactFrame?.90:.82),compactFrame?24:32,'center');}
        else if(config.mode==='data'){if(config.chart==='scatter')scatter(config.data.map((row,i)=>({x:row.x??i+1,y:row.y??row.value})),box);else if(config.chart==='word-cloud')words(config.data.map(row=>({text:row.label,count:row.value})),box);else chart(config.data,config.chart,box,{min:0,max:100});}
        else if(config.mode==='leaderboard'){const rows=value.leaderboard||[],limit=compactFrame?4:10,rowHeight=compactFrame?38:59;if(!rows.length)write('No revealed quiz scores yet',box.x+box.w/2,box.y+box.h/2,42,'center');rows.slice(0,limit).forEach((row,i)=>{const y=box.y+(compactFrame?18:40)+i*rowHeight;write(String(row.rank),box.x,y,33,'left',config.accent,700);write(row.name,box.x+100,y,33,'left',config.foreground,400,box.w-350);write(compact(row.score),box.x+box.w,y,33,'right',config.foreground,700);});if(rows.length>limit)write('Showing '+limit+' of '+rows.length+' participants',box.x+box.w,box.y+box.h+(compactFrame?18:35),compactFrame?22:28,'right');}
        else if(!value.showResults)write('Results are hidden by the presenter',box.x+box.w/2,box.y+box.h/2,42,'center');
        else if(question.type==='word-cloud'||config.chart==='word-cloud'&&aggregate.series)words(aggregate.words||(aggregate.series||[]).map(row=>({text:row.label,count:row.value})),box);
        else if(question.type==='pin-image')pins(aggregate.points||[],box);
        else if(['points','grid'].includes(question.type))scatter(aggregate.points||[],box,question,aggregate.average);
        else if(['open-ended','q&a','quiz-text','form'].includes(question.type)){const entries=aggregate.entries||[],limit=compactFrame?4:8;shownResponses=Math.min(limit,entries.length);if(!entries.length)write('No responses yet',box.x+box.w/2,box.y+box.h/2,42,'center');entries.slice(0,limit).forEach((row,i)=>{const y=box.y+(compactFrame?18:40)+i*(compactFrame?38:72);write(row.text,box.x,y,32,'left',config.foreground,400,box.w-100);if(question.type==='q&a')write(compact(row.votes),box.x+box.w,y,32,'right',config.accent,700);});}
        else if(question.type==='content')wrap(question.text,box.x,box.y+(compactFrame?24:70),box.w,compactFrame?30:43,compactFrame?4:10);
        else if(question.type==='number'||question.type==='scales'){
          if(aggregate.average===undefined)write('No responses yet',box.x+box.w/2,box.y+box.h/2,42,'center');
          else if(config.chart==='gauge')chart([{label:'Average',value:aggregate.average}],'gauge',box,question);
          else if(config.chart==='scatter')write('Scatter charts require XY responses or data coordinates',box.x+box.w/2,box.y+box.h/2,36,'center',config.foreground,400,box.w);
          else if(aggregate.series?.length){chart(aggregate.series,config.chart,box,question);detail='Average · '+compact(aggregate.average)+(aggregate.histogramBinned?' · Responses grouped into '+aggregate.series.length+' ranges':'');if(!compactFrame)write(detail,box.x,legacy?970:frame.y+frame.h-49,32,'left',config.accent,700,box.w);}
          else{write(compact(aggregate.average),box.x+box.w/2,box.y+box.h*.42,compactFrame?70:140,'center',config.accent,700);write('Average · '+compact(aggregate.responses)+' responses',box.x+box.w/2,box.y+box.h*(compactFrame?.8:.65),compactFrame?26:36,'center');}
        }
        else if(config.chart==='scatter'){if(aggregate.points)scatter(aggregate.points,box);else write('Scatter charts require XY responses or data coordinates',box.x+box.w/2,box.y+box.h/2,36,'center',config.foreground,400,box.w);}
        else if(config.chart==='gauge'&&question.type!=='chart')write('Gauge charts require numeric or scale responses',box.x+box.w/2,box.y+box.h/2,36,'center',config.foreground,400,box.w);
        else{chart(question.type==='chart'?question.data||[]:question.type==='ranking'?(aggregate.series||[]).slice().sort((a,b)=>b.value-a.value):aggregate.series||[],config.chart,box,question);if(question.type==='ranking'){detail='Average ranking points · Higher scores rank first';if(!compactFrame)write(detail,box.x,legacy?970:frame.y+frame.h-49,30,'left',config.foreground,400,box.w);}}
        if(hasQR)drawQR(joinUrl,qrSize,legacy?undefined:{x:frame.x+frame.w-qrSize-30,y:frame.y+frame.h-qrSize-(compactFrame?63:70)});if(config.mode!=='data')write((compactFrame&&detail?detail+' · ':'')+(config.mode==='leaderboard'?'Top '+Math.min(compactFrame?4:10,value.leaderboard.length)+' · Revealed quiz questions only':compact(aggregate.responses)+' responses'+(aggregate.totalParticipants===undefined?'':' · '+compact(aggregate.totalParticipants)+' participants')+(shownResponses!==undefined&&shownResponses<aggregate.responses?' · Showing '+compact(shownResponses)+' responses':'')),legacy?65:frame.x+30,legacy?1020:frame.y+frame.h-20,legacy?27:compactFrame?21:23,'left',config.foreground,400,legacy?1750:frame.w-60);
        lastFrame=key;return true;
      }catch(error){localError=error.message||String(error);lastFrame='';throw error;}finally{fontScale=1;compactFrame=false;ctx.restore();}
    }
    function words(rows,box){
      if(rows.some(row=>row.count<0)){write('Word clouds require non-negative values',box.x+box.w/2,box.y+box.h/2,32,'center');return;}
      rows=rows.filter(row=>row.count>0&&row.text.trim());if(!rows.length){write('No responses yet',box.x+box.w/2,box.y+box.h/2,42,'center');return;}const max=Math.max(...rows.map(row=>row.count));let x=box.x,y=box.y+60,lineHeight=0,shown=0;
      for(const [index,row] of rows.slice().sort((a,b)=>b.count-a.count).slice(0,60).entries()){const size=26+Math.sqrt(row.count/max)*70;ctx.font='700 '+size+'px Arial, sans-serif';const width=Math.min(box.w,ctx.measureText(row.text).width);if(x+width>box.x+box.w){x=box.x;y+=lineHeight+30;lineHeight=0;}if(y+size>box.y+box.h)break;write(row.text,x,y,size,'left',ink(index,rows.length),700,box.w);x+=width+42;lineHeight=Math.max(lineHeight,size);shown++;}
      if(shown<rows.length)write('Showing '+shown+' of '+rows.length+' words',box.x+box.w,box.y+box.h+35,28,'right');
    }
    const runtime={kind:'text',sourceType:'audience',label:(config.title||'Audience '+config.mode).slice(0,120),config,_sourceConfig:freeze(clone(config)),el,initialTransform:{x:0,y:0,w:1,h:1,rotation:0},renderFrame,isAnimating,runtimeStatus:status,
      get results(){return shared?.value||null;},
      prepare(){if(preparation)return preparation;preparation=Promise.resolve().then(async()=>{if(disposed)throw Error('Audience source preparation cancelled.');if(config.mode!=='data'){shared=backing(config,options);shared.subscribers.add(listener);if(shared.status!=='ready')await shared.refresh();await prepareImage();}if(disposed)throw Error('Audience source preparation cancelled.');lastFrame='';renderFrame();if(!status().ok)throw Error(status().why);return runtime;}).catch(error=>{if(!disposed&&!imageError&&!['offline','unavailable'].includes(shared?.status))localError=error.message||String(error);throw error;});return preparation;},
      async refresh(){if(disposed||!shared)throw Error('Prepare this audience source first.');if(imageError){imageError='';imageUrl='';imagePreparation=null;}const value=await shared.refresh();await prepareImage();return value;},
      forkProgramme(){if(disposed)throw Error('This audience source is unavailable.');return create(config,{...options,onChange:undefined});},
      dispose(){if(disposed)return;disposed=true;imageSequence++;cancelImage?.();cancelImage=null;shared?.release(listener);shared=null;if(image){image.src='';image=null;}el.width=el.height=1;el.remove?.();}};
    renderFrame();return runtime;
  }
  const acquire=async(config,options)=>{const source=create(config,options);try{await source.prepare();return source;}catch(error){source.dispose();throw error;}};
  return Object.freeze({QUESTION_TYPES,CHART_TYPES,PRESENTATIONS,FRAMINGS,normalize,dataRows,clientRequest,create,acquire});
})();
