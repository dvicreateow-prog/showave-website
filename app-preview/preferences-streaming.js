/* OpenLive streaming preferences: local operator intent and measured browser
   readiness. Secrets intentionally never enter this document. */
(() => {
  'use strict';
  const root=document.querySelector('[data-tab="streaming"]');
  if(!root) return;
  const $=id=>document.getElementById(id), KEY='openlive.streaming.preferences.v1';
  const defaults={transport:'WHIP',quality:'1080p30',bitrate:6,replaySeconds:0,autoImportClips:true};
  let settings={...defaults};
  try { settings={...settings,...JSON.parse(localStorage.getItem(KEY)||'{}')}; } catch(error){}
  const controls={transport:$('streamTransport'),quality:$('streamQuality'),bitrate:$('streamBitrate'),
    bitrateValue:$('streamBitrateValue'),replay:$('streamReplaySeconds'),autoImport:$('streamAutoImportClips'),
    estimate:$('streamNetworkEstimate'),headroom:$('streamHeadroom'),speed:$('streamSpeedTest'),
    accountStatus:$('streamAccountStatus'),accountsList:$('streamAccountsList'),setupStatus:$('streamSetupStatus'),speedStatus:$('streamSpeedStatus'),
    clipStatus:$('streamClipStatus')};
  const status=(node,state,text)=>{ node.dataset.state=state; node.textContent=text; };
  let speedController=null,speedRun=0,lastSpeedPhase='',lastSpeedResult=null,
    lastSpeedResultMode='complete',speedLiveConfirmed=false;

  const measured=value=>value!==null&&value!==''&&typeof value!=='boolean'&&Number.isFinite(Number(value))
    ? Number(value).toFixed(1)+' Mbps':'unavailable';
  const baselineHeadroom=()=>{
    const needed=Math.max(10,Math.ceil(settings.bitrate*1.7));
    controls.headroom.textContent=`At least ${needed} Mbps upload for this ${settings.bitrate} Mbps profile`;
  };

  const liveOutputActive=()=>{
    const owners=[window];
    try { if(window.parent&&window.parent!==window) owners.push(window.parent); } catch(error){}
    try { if(window.opener) owners.push(window.opener); } catch(error){}
    return [...new Set(owners)].some(owner=>{
      try {
        return !!(owner&&owner.OpenLiveStreamUI&&typeof owner.OpenLiveStreamUI.isStreaming==='function'&&
          owner.OpenLiveStreamUI.isStreaming());
      } catch(error){ return false; }
    });
  };

  function paintSpeedReadiness(result,mode=lastSpeedResultMode){
    if(!result||!window.OpenLiveSpeedTest) return;
    controls.estimate.textContent=`${measured(result.downloadMbps)} down · ${measured(result.uploadMbps)} up`;
    const headroom=OpenLiveSpeedTest.assessHeadroom(result,settings.bitrate);
    controls.headroom.textContent=`${headroom.rating}: ${headroom.detail}`;
    const partial=mode!=='complete'||result.complete===false;
    const prefix=mode==='partial-timeout'
      ? 'The test timed out after producing a partial result. '
      : partial?'Partial browser-path result. ':'';
    status(controls.speedStatus,!partial&&['Strong','Ready'].includes(headroom.rating)?'ok':'warning',
      `${prefix}${headroom.rating}: ${headroom.detail}. `+
      (partial?'Unavailable values were not inferred. ':'')+'This is not the final ingest path.');
  }

  function clearSpeedResult(estimate='Unavailable'){
    lastSpeedResult=null; lastSpeedResultMode='complete';
    controls.estimate.textContent=estimate; baselineHeadroom();
  }

  const save=()=>{
    settings={transport:controls.transport.value,
      quality:controls.quality.value,bitrate:Number(controls.bitrate.value)||6,
      replaySeconds:Number(controls.replay.value)||0,autoImportClips:controls.autoImport.checked};
    localStorage.setItem(KEY,JSON.stringify(settings)); paint();
  };

  function paint(){
    controls.bitrateValue.textContent=settings.bitrate+' Mbps';
    baselineHeadroom();
    const caps=window.RTCRtpSender&&RTCRtpSender.getCapabilities?RTCRtpSender.getCapabilities('video'):null;
    const codecs=caps&&caps.codecs?[...new Set(caps.codecs.map(c=>String(c.mimeType||'').split('/')[1]).filter(Boolean))]:[];
    status(controls.setupStatus,codecs.length?'ok':'warning',`${settings.transport} · ${settings.quality} · ${settings.bitrate} Mbps`+
      (codecs.length?` · browser RTP codecs: ${codecs.join(', ')}`:' · no WebRTC sender capability detected'));
    status(controls.clipStatus,settings.replaySeconds?'warning':'idle',settings.replaySeconds
      ? `${settings.replaySeconds}s rolling clips requested. The native rolling encoder is not connected yet; no buffer is being claimed.`
      : 'Rolling clip buffer is off.');
    if(lastSpeedResult&&!speedController&&!speedLiveConfirmed) paintSpeedReadiness(lastSpeedResult,lastSpeedResultMode);
  }

  controls.transport.value=settings.transport;
  controls.quality.value=settings.quality; controls.bitrate.value=settings.bitrate;
  controls.replay.value=String(settings.replaySeconds); controls.autoImport.checked=settings.autoImportClips;
  /* What is actually connected, read from the helper. Never invents a count. */
  (async () => {
    if(!controls.accountsList) return;
    try {
      const r = await fetch('/api/accounts/destinations', {cache:'no-store'});
      const d = await r.json();
      const ch = (d.destinations||[]).filter(x=>x.kind==='channel');
      controls.accountsList.textContent = ch.length
        ? ch.map(c=>`${c.platform}: ${c.displayName}`).join(', ')
        : 'No channel connected yet.';
      status(controls.accountStatus, ch.length?'ok':'idle', ch.length
        ? `${ch.length} channel${ch.length===1?'':'s'} connected. Add more in SHOWAVE Map or Broadcast ▸ + Add Channel.`
        : 'Connect a channel in SHOWAVE Map or Broadcast ▸ + Add Channel. No stream key is typed.');
    } catch(error){
      controls.accountsList.textContent = 'N/A';
      status(controls.accountStatus,'warning','The local helper did not answer, so this cannot say what is connected.');
    }
  })();
  [controls.transport,controls.quality,controls.bitrate,controls.replay,controls.autoImport]
    .forEach(control=>control.addEventListener(control.type==='range'?'input':'change',save));
  const phaseText={preparing:'Preparing test path',latency:'Measuring idle ping','download-pilot':'Sizing download test',
    download:'Measuring download','download-latency':'Measuring download latency','upload-pilot':'Sizing upload test',
    upload:'Measuring upload','upload-latency':'Measuring upload latency'};

  controls.speed.onclick=async()=>{
    if(speedController){
      const controller=speedController; speedController=null; speedRun+=1; controller.abort();
      speedLiveConfirmed=false; lastSpeedPhase=''; controls.speed.textContent='Run Speed Test';
      clearSpeedResult();
      status(controls.speedStatus,'warning','Internet speed test cancelled. No partial result was kept.');
      return;
    }
    if(!window.OpenLiveSpeedTest){
      status(controls.speedStatus,'warning','The shared Internet speed-test engine is unavailable.'); return;
    }
    if(liveOutputActive()&&!speedLiveConfirmed){
      speedLiveConfirmed=true; controls.speed.textContent='Run Anyway';
      status(controls.speedStatus,'warning',
        'A live output is active. This test may compete for bandwidth. Press Run Anyway to confirm.');
      return;
    }

    speedLiveConfirmed=false;
    const run=++speedRun,controller=new AbortController(); speedController=controller; lastSpeedPhase='';
    clearSpeedResult('Measuring…'); controls.speed.textContent='Stop Speed Test';
    status(controls.speedStatus,'working','Measuring the public Cloudflare browser path…');
    try {
      const result=await OpenLiveSpeedTest.run({signal:controller.signal,onUpdate:update=>{
        const phase=update.phase==='download-latency'?'download':update.phase==='upload-latency'?'upload':update.phase;
        if(run!==speedRun||phase===lastSpeedPhase) return; lastSpeedPhase=phase;
        if(phaseText[phase]) status(controls.speedStatus,'working',phaseText[phase]+'…');
      }});
      if(run!==speedRun) return;
      lastSpeedResult=result; lastSpeedResultMode=result.complete===false?'partial':'complete';
      paintSpeedReadiness(result,lastSpeedResultMode);
    } catch(error){
      if(run!==speedRun) return;
      if(error&&error.name==='TimeoutError'&&error.partialResult){
        lastSpeedResult=error.partialResult; lastSpeedResultMode='partial-timeout';
        paintSpeedReadiness(lastSpeedResult,lastSpeedResultMode);
      } else {
        clearSpeedResult();
        status(controls.speedStatus,'warning',error&&error.name==='AbortError'
          ? 'Internet speed test cancelled. No partial result was kept.'
          : 'Public speed test unavailable: '+(error.message||error)+'. No result was invented.');
      }
    } finally {
      if(run===speedRun){ speedController=null; speedLiveConfirmed=false; controls.speed.textContent='Run Speed Test'; }
    }
  };

  addEventListener('pagehide',()=>{
    if(!speedController) return;
    const controller=speedController; speedController=null; speedRun+=1; controller.abort();
  });
  paint();
})();
