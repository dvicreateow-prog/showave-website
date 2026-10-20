/* Imported replay clips use the existing local-file decoder. This does not
   record, download, retain a rolling buffer or send anything to Programme. */
window.OpenLiveSportsReplay=(()=>{
  'use strict';
  async function acquire(file,{rate=.5,loop=false,trimIn=0,trimOut=null,document:doc=window.document,isCurrent=()=>true,signal}={}){
    const provider=window.OpenLiveSourceAcquisition;
    if(!provider?.create||!provider.savedConfig)throw Error('The local media source renderer is unavailable.');
    if(!doc?.createElement)throw Error('The replay video decoder is unavailable.');
    if(!file||typeof file.name!=='string'||typeof file.arrayBuffer!=='function')throw Error('Choose a local video file for replay.');
    const current=()=>{try{return !signal?.aborted&&isCurrent()!==false;}catch(_){return false;}};
    const cancelled=()=>Object.assign(Error('Replay preparation cancelled because the selected scene changed or the import was closed.'),{name:'AbortError'});
    if(!current())throw cancelled();
    const config={file,loop,trimIn,trimOut,rate,replay:true};
    provider.savedConfig('media',config); // Reject an invalid rate before opening a file URL.
    const controller=new AbortController(),abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    // A selection callback cannot notify us by itself. Watch only while the
    // bounded decoder preparation is pending, then release this check.
    const watch=setInterval(()=>{if(!current())abort();},100);
    let runtime=null;
    try{
      const load=provider.create({document:doc,mediaDevices:{}});
      runtime=await load('media',config,controller.signal);
      if(!current()||controller.signal.aborted)throw cancelled();
      if(runtime.audioOnly||!runtime.el||!(runtime.el.videoWidth>0&&runtime.el.videoHeight>0))
        throw Error('Choose a replay clip with a decoded video picture. Audio-only files cannot be replayed here.');
      if(!runtime.transport||!Number.isFinite(runtime.el.duration)||runtime.el.duration<=0)
        throw Error('This replay clip has no usable duration. Choose a seekable local video file.');
      const start=runtime.transport.bounds().start,el=runtime.el;
      // Seeking can temporarily remove HAVE_CURRENT_DATA even for a decoded
      // first frame. Do not hand Studio a source until its cued picture exists.
      await new Promise((resolve,reject)=>{
        let settled=false,timer;
        const events=['seeked','loadeddata','canplay'],cleanup=()=>{
          clearTimeout(timer);for(const event of events)el.removeEventListener(event,ready);
          el.removeEventListener('error',failed);controller.signal.removeEventListener('abort',aborted);
        },finish=error=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve();},
          ready=()=>{if(!current()||controller.signal.aborted)return finish(cancelled());
            if(el.readyState>=2&&!el.seeking&&Math.abs(el.currentTime-start)<.001)finish();},
          failed=()=>finish(Error('The replay clip could not decode its opening picture.')),
          aborted=()=>finish(cancelled());
        for(const event of events)el.addEventListener(event,ready);
        el.addEventListener('error',failed);controller.signal.addEventListener('abort',aborted,{once:true});
        timer=setTimeout(()=>finish(Error('The replay clip did not prepare its opening picture within 20 seconds.')),20000);
        try{runtime.transport.pause();runtime.transport.seek(start);ready();}catch(error){finish(error);}
      });
      runtime.el.muted=true;
      runtime.label=('Replay · '+file.name.replace(/[\u0000-\u001f]/g,' ')).slice(0,120);
      runtime._sportsReplay=true;
      runtime.audio={included:false,reason:'Replay clips are video-only; audio is muted.'};
      return runtime;
    }catch(error){
      runtime?.dispose?.();
      if(!current()||controller.signal.aborted)throw cancelled();
      throw error;
    }finally{
      clearInterval(watch);signal?.removeEventListener('abort',abort);
    }
  }
  return Object.freeze({acquire});
})();
