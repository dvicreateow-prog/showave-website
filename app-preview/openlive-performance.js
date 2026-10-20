/* Operator diagnostics and background decode budgets. The browser/native
   decoder still chooses its supported hardware path; no source is resized,
   converted, or opened merely to inspect the machine. */
(() => {
'use strict';
const GiB=1024*1024*1024, tracked=new Map();
let hardware={schema:1,platform:'browser',cpu:{model:null,logicalProcessors:Number(navigator.hardwareConcurrency)||null},
  memory:{totalBytes:Number(navigator.deviceMemory)>0?Number(navigator.deviceMemory)*GiB:null,availableBytes:null,estimated:true},
  gpu:{hardwareAccelerationEnabled:null,informationAvailable:false,devices:[],featureStatus:{}}};
let hardwarePending=null, lastRefresh=0, timer=0, button=null, panel=null, ui=null, decoderSignature='';
let pressureUntil=0;
let live={at:0,activeVideos:0,activeNative:0,droppedFrames:0,stalledVideos:0,pressure:false,decoders:[]};
function currentDecoderCounts(){
  const pool=window.ArenaMedia?._state?.pool;
  if(!pool)return {active:live.activeVideos+live.activeNative,
    programme:live.decoders.filter(row=>row.expectsFrames&&row.layer!=='preview').length};
  let active=0,programme=0;
  /* Allocation runs between the once/second diagnostic scans. Include play()
     requests awaiting their first frame so triggering several Layers releases
     an optional UI Preview before it competes with the new decoders. */
  for(const [key,slot]of pool){
    if(!slot.id||!slot.video||slot.image||slot.liveStream||slot.media?.presentation)continue;
    const video=slot.video,native=window.OpenLiveDXV?.compositorFor?.(video);
    if(!native&&!slot.videoUrl)continue;
    const seekDriven=slot.videoEnabled!==false&&(slot.lastDirection==='Backwards'||slot.lastScrub);
    const running=native?!!(native.free||slot.videoEnabled!==false&&slot.lastDirection&&slot.lastDirection!=='Paused'):
      !video.paused||!!slot.videoPlayPending||seekDriven;
    if(!running)continue;
    active++;if(key!=='preview')programme++;
  }
  return {active,programme};
}
function backgroundConcurrency(){
  const cores=hardware.cpu?.logicalProcessors, memory=hardware.memory?.totalBytes,free=hardware.memory?.availableBytes;
  const decode=hardware.gpu?.featureStatus?.video_decode;
  const playing=currentDecoderCounts().active;
  if(live.stalledVideos>0||(free!==null&&free!==undefined&&free<.5*GiB))return 0;
  if(playing>=4&&(live.pressure||(free!==null&&free!==undefined&&free<.5*GiB)))return 0;
  const limited=(cores&&cores<4)||(memory&&memory<8*GiB)||(free!==null&&free!==undefined&&free<2*GiB)||
    hardware.gpu?.hardwareAccelerationEnabled===false||(decode&&!decode.startsWith('enabled'));
  return limited||live.pressure||playing>=4?1:2;
}
function preferSharedPreview(){
  const free=hardware.memory?.availableBytes;
  /* Preview must not count towards its own allocation decision. Two playing
     Layers plus an independent Preview used to cross the threshold, detach
     Preview, then fall below it and recreate that decoder on the next scan. */
  const programmeDecoders=currentDecoderCounts().programme;
  return live.pressure||programmeDecoders>=2||
    (free!==null&&free!==undefined&&free<2*GiB);
}
function refreshHardware(){
  if(hardwarePending)return hardwarePending;
  const read=window.OpenLiveDesktop?.getHardwareProfile;
  if(typeof read!=='function')return Promise.resolve(hardware);
  hardwarePending=Promise.resolve().then(()=>read()).then(value=>{
    if(value?.schema===1&&value.cpu&&value.memory&&value.gpu)hardware=value;
    return hardware;
  },()=>hardware).finally(()=>{hardwarePending=null;lastRefresh=performance.now();});
  return hardwarePending;
}
function scan(){
  const now=performance.now(),pool=window.ArenaMedia?._state?.pool,seen=new Set(),rows=[];
  let activeVideos=0,activeNative=0,droppedFrames=0,stalledVideos=0;
  if(pool)for(const [key,slot]of pool){
    if(!slot.id||!slot.video||slot.image||slot.liveStream||slot.media?.presentation)continue;
    const video=slot.video, native=window.OpenLiveDXV?.compositorFor?.(video),token=slot.sourceToken;
    if(!native&&!slot.videoUrl)continue;
    seen.add(key);
    let previous=tracked.get(key), initial=false;
    if(!previous||previous.token!==token||previous.video!==video){
      initial=true;
      previous={token,video,at:now,total:0,dropped:0,lastProgressAt:now,nativeFrame:null};tracked.set(key,previous);
    }
    let total=0,dropped=0,qualityAvailable=false;
    if(!native)try{
      const q=video.getVideoPlaybackQuality?.();
      if(q){total=Number(q.totalVideoFrames)||0;dropped=Number(q.droppedVideoFrames)||0;qualityAvailable=true;}
      else if(Number.isFinite(video.webkitDecodedFrameCount)){
        total=video.webkitDecodedFrameCount;dropped=Number(video.webkitDroppedFrameCount)||0;qualityAvailable=true;
      }
    }catch(error){}
    const elapsed=Math.max(1,now-previous.at)/1000;
    const delta=initial?0:Math.max(0,total-previous.total),lost=initial?0:Math.max(0,dropped-previous.dropped);
    const progressing=native?native.lastFrame!==previous.nativeFrame&&native.lastFrame>=0:delta>lost;
    if(progressing)previous.lastProgressAt=now;
    const seekDriven=slot.videoEnabled!==false&&(slot.lastDirection==='Backwards'||slot.lastScrub);
    const running=native?!!(native.free||slot.videoEnabled!==false&&slot.lastDirection&&slot.lastDirection!=='Paused'):!video.paused||seekDriven;
    const waiting=native?native.lastFrame<0:video.readyState<2;
    const stalled=running&&!waiting&&now-previous.lastProgressAt>=2000;
    if(running){if(native)activeNative++;else activeVideos++;}
    if(stalled)stalledVideos++;
    droppedFrames+=lost;
    const dropRatio=delta>0?lost/delta:0;
    rows.push({layer:String(key),name:String(slot.media?.name||slot.id),kind:native?'native':'browser',
      state:slot.failed||native?.failed?'error':waiting?'loading':stalled?'stalled':slot.lastScrub?'scrubbing':slot.lastDirection==='Backwards'?'reverse':video.seeking?'seeking':running?'playing':'paused',
      expectsFrames:running,
      width:Number(native?.width||video.videoWidth||slot.media?.width)||null,
      height:Number(native?.height||video.videoHeight||slot.media?.height)||null,
      presentedFps:!initial&&!native&&qualityAvailable&&running?Math.max(0,delta-lost)/elapsed:null,
      totalFrames:!native&&qualityAvailable?total:null,droppedFrames:!native&&qualityAvailable?dropped:null,
      recentDroppedFrames:lost,dropRatio,seekCount:slot.seekCount||0});
    previous.at=now;previous.total=total;previous.dropped=dropped;previous.nativeFrame=native?.lastFrame;
    if(!running)previous.lastProgressAt=now;
  }
  for(const key of tracked.keys())if(!seen.has(key))tracked.delete(key);
  if(stalledVideos>0||rows.some(row=>row.expectsFrames&&row.dropRatio>.05&&row.recentDroppedFrames>=3))pressureUntil=now+3000;
  const lowMemory=hardware.memory?.availableBytes!==null&&hardware.memory?.availableBytes!==undefined&&hardware.memory.availableBytes<.5*GiB;
  live={at:now,activeVideos,activeNative,droppedFrames,stalledVideos,
    pressure:now<pressureUntil||lowMemory,decoders:rows};
  if(now-lastRefresh>=10000)void refreshHardware();
  render();return snapshot();
}
function snapshot(){
  const media=window.ArenaMedia?._state;
  return {hardware,live:{...live,decoders:live.decoders.map(row=>({...row}))},
    budget:{backgroundPosterConcurrency:backgroundConcurrency(),posterActive:media?.posterActive||0,
      postersQueued:(media?.posterQueue?.length||0)+(window.ArenaFiles?._state?.posterQueue?.length||0)}};
}
const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node;};
const memoryText=value=>Number.isFinite(value)?(value/GiB).toFixed(1)+' GB':'unavailable';
function accelerationText(feature){
  const value=hardware.gpu?.featureStatus?.[feature];
  return value?value.startsWith('enabled')?'available':value.includes('software')?'software':'unavailable':'unreported';
}
function render(){
  if(!button)return;
  const count=live.activeVideos+live.activeNative;
  const state=live.stalledVideos?'Stalled':live.pressure?'Busy':count?'Playing':'Idle';
  const summary=live.stalledVideos?live.stalledVideos+' stalled':live.pressure?'Playback under pressure':count?count+' video'+(count===1?'':'s')+' playing':'No video playing';
  setText(ui.toggleState,state);
  button.setAttribute('aria-label','Performance · '+summary);
  button.title='Show playback performance · '+summary;
  button.dataset.pressure=live.pressure?'true':'false';
  button.dataset.state=state.toLowerCase();
  if(panel.hidden)return;
  const active=(hardware.gpu?.devices||[]).find(device=>device.active)||(hardware.gpu?.devices||[])[0];
  const cpu=hardware.cpu||{},memory=hardware.memory||{},budget=snapshot().budget;
  panel.dataset.pressure=String(live.pressure);
  setText(ui.summary,summary);setText(ui.active,String(count));
  setText(ui.stalled,String(live.stalledVideos));setText(ui.dropped,String(live.droppedFrames));
  setText(ui.cpu,cpu.model||'Processor name unavailable');
  setText(ui.cores,cpu.logicalProcessors?cpu.logicalProcessors+' logical processors':'Processor count unavailable');
  setText(ui.memory,memoryText(memory.totalBytes)+(memory.estimated?' · browser estimate':''));
  setText(ui.available,Number.isFinite(memory.availableBytes)?memoryText(memory.availableBytes)+' available':'Available memory unreported');
  setText(ui.gpu,active?.deviceString||hardware.gpu?.renderer||'GPU details unavailable in this browser');
  setText(ui.acceleration,'Video decoding '+accelerationText('video_decode')+' · Canvas '+accelerationText('2d_canvas'));
  setText(ui.posters,budget.posterActive+' active / '+budget.backgroundPosterConcurrency+' allowed · '+budget.postersQueued+' queued');
  // Keep the panel and Close button mounted while diagnostics update.
  const signature=JSON.stringify(live.decoders);
  if(signature!==decoderSignature){
    decoderSignature=signature;ui.decoders.replaceChildren();
    for(const row of live.decoders){
      const entry=document.createElement('div');entry.className='ol-perf-decoder';
      const title=text('strong',row.name),state=text('span',row.state);
      state.className='ol-perf-decoder-state';entry.dataset.state=row.state;
      const detail=text('small',(row.width||'N/A')+' × '+(row.height||'N/A')+' · '+(row.presentedFps===null?'FPS unreported':row.presentedFps.toFixed(1)+' fps')+' · '+(row.droppedFrames===null?'Dropped frames unreported':row.droppedFrames+' dropped'));
      entry.append(title,state,detail);ui.decoders.append(entry);
    }
    if(!live.decoders.length){
      const empty=text('p','Your video playback details will appear here when a video is loaded.');empty.className='ol-perf-empty';ui.decoders.append(empty);
    }
  }
  setText(ui.note,budget.backgroundPosterConcurrency===0?'Background thumbnails are waiting for playback capacity or available RAM.':live.pressure?'Background thumbnail work is reduced while playback is under pressure.':'Original media and output resolution are preserved.');
}
function setText(node,value){if(node.textContent!==value)node.textContent=value;}
function closePanel(restoreFocus=false){
  if(!panel||panel.hidden)return;
  panel.hidden=true;button.setAttribute('aria-expanded','false');
  if(restoreFocus)button.focus();
}
function positionPanel(){
  if(!panel||panel.hidden)return;
  const rect=button.getBoundingClientRect();
  panel.style.bottom=Math.max(8,window.innerHeight-rect.top+8)+'px';
  const maxRight=Math.max(12,window.innerWidth-panel.getBoundingClientRect().width-12);
  panel.style.right=Math.min(maxRight,Math.max(12,window.innerWidth-rect.right))+'px';
  panel.style.maxHeight=Math.max(100,rect.top-20)+'px';
}
function mount(){
  if(button||!document.body)return;
  button=text('button','');button.id='openlive-performance-toggle';button.type='button';
  button.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 11h4l2-6 4 10 2-6h4"/></svg><span class="ol-perf-label">Performance</span><span class="ol-perf-toggle-state">Idle</span><svg class="ol-perf-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 7 3-3 3 3"/></svg>';
  button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','openlive-performance-panel');
  panel=document.createElement('section');panel.id='openlive-performance-panel';panel.hidden=true;
  // A status-bar disclosure follows the workspace palette, rather than the
  // separate utility-window skin used by modal editors.
  panel.setAttribute('role','region');panel.setAttribute('aria-labelledby','openlive-performance-title');
  panel.innerHTML=`<header class="ol-perf-header"><div><span class="ol-perf-eyebrow">Show playback</span><h2 id="openlive-performance-title">Performance</h2></div><button type="button" class="ol-perf-close" aria-label="Close performance details"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></header>
    <div class="ol-perf-summary"><i aria-hidden="true"></i><span data-perf="summary"></span><small>Live diagnostics</small></div>
    <div class="ol-perf-metrics"><div><strong data-perf="active">0</strong><span>Playing videos</span></div><div><strong data-perf="stalled">0</strong><span>Stalled videos</span></div><div><strong data-perf="dropped">0</strong><span>Dropped · last scan</span></div></div>
    <section class="ol-perf-section"><h3>Playback activity</h3><div data-perf="decoders" class="openlive-performance-decoders"></div></section>
    <section class="ol-perf-section"><h3>This computer</h3><dl class="ol-perf-hardware"><div><dt>Processor</dt><dd><span data-perf="cpu"></span><small data-perf="cores"></small></dd></div><div><dt>Memory</dt><dd><span data-perf="memory"></span><small data-perf="available"></small></dd></div><div><dt>Graphics</dt><dd><span data-perf="gpu"></span><small data-perf="acceleration"></small></dd></div><div><dt>Thumbnails</dt><dd data-perf="posters"></dd></div></dl></section>
    <footer class="ol-perf-footer"><p data-perf="note"></p><span>Session only · refreshed every second</span></footer>`;
  ui={toggleState:button.querySelector('.ol-perf-toggle-state')};
  panel.querySelectorAll('[data-perf]').forEach(node=>{ui[node.dataset.perf]=node;});
  const close=panel.querySelector('.ol-perf-close');close.addEventListener('click',()=>closePanel(true));
  button.addEventListener('click',()=>{
    if(!panel.hidden){closePanel();return;}
    panel.hidden=false;button.setAttribute('aria-expanded','true');render();positionPanel();close.focus();
    void refreshHardware().then(render);
  });
  const status=document.getElementById('status'),clock=document.getElementById('clock');
  if(status){status.classList.add('ol-performance-status');status.insertBefore(button,clock?.parentElement===status?clock:null);}else document.body.append(button);
  document.body.append(panel);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();closePanel(true);}});
  document.addEventListener('pointerdown',event=>{if(!panel.hidden&&!panel.contains(event.target)&&!button.contains(event.target))closePanel();});
  window.addEventListener('showave:workspace-changed',event=>{if(event.detail?.id!=='show')closePanel();});
  window.addEventListener('resize',positionPanel);
  if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(positionPanel);observer.observe(button);window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});}
  render();
}
window.OpenLivePerformance={snapshot,backgroundConcurrency,preferSharedPreview,refreshHardware,scan};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
void refreshHardware();timer=setInterval(scan,1000);
window.addEventListener('pagehide',()=>{clearInterval(timer);tracked.clear();},{once:true});
})();
