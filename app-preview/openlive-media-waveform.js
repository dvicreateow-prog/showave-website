/* Full-file audio envelopes for the media timeline.
   Docs: manual/preferences.htm (audio/preview scope), clip-time-panel.htm
   (clip duration). UNDOCUMENTED — this browser waveform is inferred from the
   requested timeline: each bin is the largest decoded absolute sample from
   any channel. Filmstrip frames come from a separate muted, paused decoder.
   Neither analysis changes a playing source or the output bus. No media or
   thumbnails are written to storage. Web APIs: W3C Web Audio decodeAudioData;
   WHATWG HTML media seeking and Fetch bounded response-body streaming. */
window.OpenLiveMediaWaveform = (() => {
  'use strict';
  const limits = Object.freeze({maxFileBytes:128 * 1024 * 1024,maxDuration:20 * 60,
    maxChannels:8,maxDecodedSamples:64 * 1024 * 1024,maxPeaks:1200,samplesPerYield:262144,
    maxFrames:8,maxFrameWidth:160,maxFrameHeight:90,maxFrameBytes:32 * 1024,frameTimeout:10000});
  const cache = new WeakMap();
  const stripCache = new WeakMap();
  let decodeQueue = Promise.resolve();
  const durationValue = value => Number.isFinite(value) && value > 0 ? value : 0;
  const unavailable = (reason,duration=0) => ({state:'unavailable',peaks:new Float32Array(0),duration:durationValue(duration),reason});
  const yieldFrame = () => new Promise(resolve => setTimeout(resolve,0));
  const cancelled = () => Object.assign(Error('Media analysis cancelled.'),{name:'AbortError'});
  const check = signal => { if(signal?.aborted) throw cancelled(); };
  function localFile(source) {
    const BlobType = window.Blob || (typeof Blob === 'function' ? Blob : null);
    if (!BlobType) return null;
    for (const file of [source?._sourceConfig?.file,source?.file]) {
      if (!file || typeof file.arrayBuffer !== 'function') continue;
      // Native brand validation also accepts Blobs from another window. URLs,
      // file-looking config objects and saved filenames are not local bytes.
      try { BlobType.prototype.slice.call(file,0,0); return file; } catch (_) {}
    }
    return null;
  }
  // Native original-file capabilities are intentionally not Blobs. Their URL
  // reads the user's original through the session-only helper. Other URLs must
  // already belong to the selected local media element; arbitrary URL fields,
  // remote hosts, credentials and redirects are never followed for analysis.
  function inputOf(source) {
    const file=localFile(source);
    if(file)return {key:file,file,size:file.size};
    const configFile=source?._sourceConfig?.file||source?.file,el=source?.el;
    const reference=configFile?._openliveURL;
    if(!reference&&(!el||el.srcObject||!['audio','video'].includes(String(el.tagName||el.localName||'').toLowerCase())))return null;
    const value=reference||el.currentSrc||el.src;
    if(typeof value!=='string'||!value||!window.location?.href||typeof URL!=='function')return null;
    try{
      const url=new URL(value,window.location.href),origin=new URL(window.location.href).origin;
      if(url.username||url.password)return null;
      const allowed=url.protocol==='blob:'?url.origin===origin:
        ['http:','https:'].includes(url.protocol)&&url.origin===origin&&
        (!reference||/^\/api\/media\/source\/[A-Za-z0-9_-]+$/.test(url.pathname));
      if(!allowed)return null;
      return {key:reference?configFile:el,url:url.href,size:reference?Number(configFile.size):null};
    }catch(_){return null;}
  }
  async function readInput(input,signal){
    check(signal);
    if(input.file){const bytes=await input.file.arrayBuffer();check(signal);return bytes;}
    const response=await fetch(input.url,{cache:'no-store',credentials:'same-origin',redirect:'error',signal});check(signal);
    if(!response.ok)throw Error('The original media is no longer available.');
    const lengthText=response.headers?.get?.('Content-Length'),length=lengthText==null?null:Number(lengthText);
    if(length!=null&&(!Number.isSafeInteger(length)||length<0||length>limits.maxFileBytes)){
      await response.body?.cancel?.();throw Error('Waveform analysis is limited to local files of 128 MiB or less.');
    }
    // Streaming enforces the cap even with absent or inaccurate Content-Length.
    // Without a reader require a bounded Content-Length before arrayBuffer().
    const reader=response.body?.getReader?.();
    if(!reader){
      if(length==null)throw Error('This browser cannot safely read a waveform without the original file size.');
      const bytes=await response.arrayBuffer();check(signal);return bytes;
    }
    let total=0,chunks=[];
    try{
      for(;;){check(signal);const {done,value}=await reader.read();check(signal);if(done)break;
        if(!value?.byteLength)continue;total+=value.byteLength;
        if(total>limits.maxFileBytes)throw Error('Waveform analysis is limited to local files of 128 MiB or less.');
        chunks.push(value);
      }
      if(length!=null&&length!==total)throw Error('The original media was not read completely.');
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      chunks=null;return bytes.buffer;
    }catch(error){try{await reader.cancel();}catch(_){}throw error;}
    finally{chunks=null;try{reader.releaseLock?.();}catch(_){}}
  }

  // Pure with respect to the AudioBuffer: no copies of channel-sized arrays,
  // no mutation and no phase cancellation between opposite stereo channels.
  // Only the small envelope survives when this promise settles.
  async function summarize(buffer,{signal}={}) {
    check(signal);
    const length = buffer?.length, channels = buffer?.numberOfChannels, rate = buffer?.sampleRate;
    const duration = Number.isFinite(length) && Number.isFinite(rate) && rate > 0 ? length / rate : 0;
    if (!Number.isSafeInteger(length) || length <= 0 || !Number.isInteger(channels) || channels < 1 ||
        !Number.isFinite(rate) || rate <= 0 || typeof buffer.getChannelData !== 'function')
      return unavailable('The file did not provide a usable decoded audio track.',duration);
    if (duration > limits.maxDuration) return unavailable('Waveform analysis is limited to media of 20 minutes or less.',duration);
    if (channels > limits.maxChannels) return unavailable('Waveform analysis supports up to 8 audio channels.',duration);
    if (length * channels > limits.maxDecodedSamples)
      return unavailable('The decoded audio exceeds the waveform memory limit.',duration);
    const peaks = new Float32Array(Math.min(limits.maxPeaks,length));
    let maximum = 0;
    try {
      await yieldFrame();
      for (let channel = 0; channel < channels; channel++) {
        check(signal);
        const samples = buffer.getChannelData(channel);
        if (!samples || samples.length < length) return unavailable('The decoded audio channel is incomplete.',duration);
        for (let offset = 0; offset < length; offset += limits.samplesPerYield) {
          check(signal);
          const end = Math.min(length,offset + limits.samplesPerYield);
          for (let index = offset; index < end; index++) {
            const value = Math.abs(samples[index]);
            if (!Number.isFinite(value)) return unavailable('The decoded audio contains invalid sample values.',duration);
            const bin = Math.floor(index * peaks.length / length);
            if (value > peaks[bin]) peaks[bin] = value;
            if (value > maximum) maximum = value;
          }
          if (end < length || channel + 1 < channels) await yieldFrame();
        }
      }
      return {state:maximum > 0 ? 'ready' : 'silent',peaks,duration,
        reason:maximum > 0 ? 'Measured audio peaks across the full local media file.' : 'The decoded audio track contains only zero-valued samples.'};
    } catch (error) { if(error?.name==='AbortError')throw error;return unavailable('The decoded audio could not be inspected for a waveform.',duration); }
  }

  async function decodeFile(input,knownDuration,signal) {
    let bytes = null, decoded = null, decoder = null;
    try {
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) return unavailable('This browser cannot decode an offline audio waveform.',knownDuration);
      check(signal);bytes = await readInput(input,signal);
      if (!bytes?.byteLength) return unavailable('The local file has no readable audio data.',knownDuration);
      if (bytes.byteLength > limits.maxFileBytes) return unavailable('Waveform analysis is limited to local files of 128 MiB or less.',knownDuration);
      // No AudioContext, destination connection or startRendering: decoding
      // cannot play sound, seek a player, capture a stream or start an encoder.
      decoder = new OfflineContext(1,1,44100);
      decoded = await decoder.decodeAudioData(bytes);
      check(signal);
      bytes = null; decoder = null;
      return await summarize(decoded,{signal});
    } catch (error) {
      if(signal?.aborted||error?.name==='AbortError')throw cancelled();
      const detail = String(error?.message || error || 'Unsupported audio data').slice(0,180);
      return unavailable('Audio waveform unavailable: ' + detail,knownDuration);
    } finally { bytes = null; decoded = null; decoder = null; }
  }
  function load(source,{signal}={}) {
    const input=inputOf(source),knownDuration=durationValue(source?.el?.duration);
    if(signal?.aborted)return Promise.reject(cancelled());
    if(!input)return Promise.resolve(unavailable('Choose the original local media file to inspect its audio waveform.',knownDuration));
    let entry=cache.get(input.key);
    // Reusing a media element for another original must not display the old
    // envelope. Existing consumers keep their own promise; the new URL gets a
    // distinct queued analysis without cancelling another view's work.
    if(entry&&entry.url!==input.url){cache.delete(input.key);entry=null;}
    if(entry?.controller?.signal.aborted){cache.delete(input.key);entry=null;}
    if(!entry){
      const controller=typeof AbortController==='function'?new AbortController():null;
      entry={controller,subscribers:new Set(),persistent:false,settled:false,promise:null,url:input.url};
      let pending;
      if(input.size!=null&&(!Number.isFinite(input.size)||input.size<=0))
        pending=Promise.resolve(unavailable('The local file has no readable audio data.',knownDuration));
      else if(input.size>limits.maxFileBytes)
        pending=Promise.resolve(unavailable('Waveform analysis is limited to local files of 128 MiB or less.',knownDuration));
      else if(knownDuration>limits.maxDuration)
        pending=Promise.resolve(unavailable('Waveform analysis is limited to media of 20 minutes or less.',knownDuration));
      else if(source?.el?.readyState>=2&&source.el.audioTracks&&source.el.audioTracks.length===0)
        pending=Promise.resolve({...unavailable('This decoded media contains no audio track.',knownDuration),state:'absent'});
      else {
      // Read and decode only after the previous decoded buffer was summarized
      // and released. Multiple source/monitor requests share the same promise.
        pending=decodeQueue.then(()=>decodeFile(input,knownDuration,controller?.signal));
        decodeQueue=pending.then(()=>undefined,()=>undefined);
      }
      entry.promise=pending;cache.set(input.key,entry);
      pending.then(()=>{entry.settled=true;},()=>{entry.settled=true;if(cache.get(input.key)===entry)cache.delete(input.key);});
    }
    if(!signal){entry.persistent=true;return entry.promise;}
    return new Promise((resolve,reject)=>{
      const owner={};entry.subscribers.add(owner);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);entry.subscribers.delete(owner);error?reject(error):resolve(value);};
      const abort=()=>{finish(cancelled());if(!entry.persistent&&!entry.subscribers.size&&!entry.settled)entry.controller?.abort();};
      signal.addEventListener('abort',abort,{once:true});
      entry.promise.then(value=>finish(null,value),error=>finish(error));
      if(signal.aborted)abort();
    });
  }

  // A tiny disposable strip of real pictures. Only this separate decoder seeks;
  // Preview/Programme audio, playback state, mute and position remain untouched.
  async function buildFilmstrip(source,{signal,count=8,width=112,height=63,onProgress}={}){
    const duration=durationValue(source?.el?.duration),input=inputOf(source);
    const frames=[],urls=window.URL||(typeof URL==='function'?URL:null);
    let video=null,canvas=null,ownedURL=null,disposed=false;
    const dispose=()=>{if(disposed)return;disposed=true;
      for(const frame of frames)try{urls.revokeObjectURL(frame.url);}catch(_){}frames.length=0;
      try{video?.pause();if(video){video.removeAttribute('src');video.load?.();video.remove?.();}}catch(_){}
      if(ownedURL)try{urls.revokeObjectURL(ownedURL);}catch(_){}ownedURL=null;video=null;canvas=null;
      signal?.removeEventListener('abort',dispose);
    };
    const unavailableStrip=reason=>({state:'unavailable',frames,duration,reason,dispose});
    const progress=(phase,completed)=>{if(disposed)return;try{onProgress?.({phase,completed,total:count});}catch(_){}};
    const doc=source?.el?.ownerDocument||window.document;
    try{
      check(signal);
      if(!input||!doc?.createElement||!urls?.createObjectURL)return unavailableStrip('Video thumbnails require an available original local media source.');
      if(source?.audioOnly===true||String(source?.el?.tagName||source?.el?.localName).toLowerCase()==='audio')return unavailableStrip('Audio-only media has no video pictures.');
      count=Math.max(1,Math.min(limits.maxFrames,Math.floor(Number(count)||8)));
      width=Math.max(16,Math.min(limits.maxFrameWidth,Math.floor(Number(width)||112)));
      height=Math.max(16,Math.min(limits.maxFrameHeight,Math.floor(Number(height)||63)));
      // The strip never reads full file bytes. Size and duration can be large:
      // only metadata and at most eight independently seeked frames are needed.
      video=doc.createElement('video');video.muted=true;video.autoplay=false;video.loop=false;video.playsInline=true;video.preload='metadata';
      canvas=doc.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('The thumbnail canvas is unavailable.');
      signal?.addEventListener('abort',dispose,{once:true});
      const waitFor=(events,ready,start,phase)=>new Promise((resolve,reject)=>{
        events=Array.isArray(events)?events:[events];
        let timer,settled=false;const element=video;
        const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);events.forEach(event=>element.removeEventListener(event,loaded));element.removeEventListener('error',failed);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
        const loaded=()=>{if(ready(element))finish();},failed=()=>finish(Error('The browser could not decode video thumbnails.')),abort=()=>finish(cancelled());
        events.forEach(event=>element.addEventListener(event,loaded));element.addEventListener('error',failed);signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>finish(Error('Video thumbnail '+phase+' timed out.')),limits.frameTimeout);
        try{check(signal);start(element);loaded();}catch(error){finish(error);}
      });
      const encode=()=>new Promise((resolve,reject)=>{
        const target=canvas;let timer,settled=false;
        const finish=(error,blob)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(blob);};
        const abort=()=>finish(cancelled());signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>finish(Error('Video thumbnail encoding timed out.')),limits.frameTimeout);
        try{check(signal);target.toBlob(blob=>finish(null,blob),'image/jpeg',.65);}catch(error){finish(error);}
      });
      const url=input.url||(ownedURL=urls.createObjectURL(input.file));
      progress('metadata',0);
      await waitFor('loadedmetadata',element=>element.readyState>=1&&durationValue(element.duration)>0,element=>{element.src=url;element.load();},'metadata');check(signal);
      const actualDuration=durationValue(video.duration),vw=video.videoWidth,vh=video.videoHeight;
      if(!actualDuration||!vw||!vh)throw Error('The source has no finite decoded video timeline.');
      for(let index=0;index<count;index++){
        check(signal);const time=Math.min(Math.max(0,actualDuration-.04),(index+.5)/count*actualDuration);
        progress('seek',index);
        // Some browsers finish the seek before announcing the decoded frame.
        // Both conditions must hold, whichever of these events arrives last.
        await waitFor(['seeked','loadeddata','canplay'],element=>!element.seeking&&element.readyState>=2&&Math.abs(element.currentTime-time)<.1,
          element=>{element.currentTime=time;},'seek for frame '+(index+1));check(signal);
        const scale=Math.min(width/vw,height/vh),w=vw*scale,h=vh*scale;
        ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);ctx.drawImage(video,(width-w)/2,(height-h)/2,w,h);
        progress('encode',index);const blob=await encode();check(signal);
        if(!blob||blob.size>limits.maxFrameBytes)throw Error('A video thumbnail exceeds the memory limit.');
        frames.push({time,url:urls.createObjectURL(blob),width,height});
        progress('frame',index+1);
      }
      // Retire decoder and its original Blob URL as soon as the strip is ready;
      // only the bounded tiny JPEGs survive until the view is disposed.
      video.pause();video.removeAttribute('src');video.load();video.remove?.();video=null;canvas=null;
      if(ownedURL){urls.revokeObjectURL(ownedURL);ownedURL=null;}
      progress('ready',count);
      return {state:'ready',frames,duration:actualDuration,reason:'Measured video frames from the original media; thumbnails are session-only.',dispose};
    }catch(error){dispose();if(signal?.aborted||error?.name==='AbortError')throw cancelled();return unavailableStrip(String(error?.message||error));}
  }

  // A panel remount during media buffering must not restart a decoder. Each
  // view owns one lease; a one-microtask grace permits synchronous replacement
  // of that view while leaving no source-wide thumbnail retention after the
  // final view disappears. Files/capabilities themselves remain WeakMap keys.
  function filmstrip(source,options={}){
    const {signal,onProgress}=options,input=inputOf(source);
    if(signal?.aborted)return Promise.reject(cancelled());
    if(!input||typeof AbortController!=='function')return buildFilmstrip(source,options);
    const count=Math.max(1,Math.min(limits.maxFrames,Math.floor(Number(options.count)||8))),
      width=Math.max(16,Math.min(limits.maxFrameWidth,Math.floor(Number(options.width)||112))),
      height=Math.max(16,Math.min(limits.maxFrameHeight,Math.floor(Number(options.height)||63)));
    const audioOnly=source?.audioOnly===true||String(source?.el?.tagName||source?.el?.localName).toLowerCase()==='audio';
    const signature=JSON.stringify([input.url||'',count,width,height,audioOnly]);
    let variants=stripCache.get(input.key);
    if(!variants){variants=new Map();stripCache.set(input.key,variants);}
    let entry=variants.get(signature);
    if(!entry||entry.retired){entry={controller:new AbortController(),consumers:new Set(),promise:null,started:false,result:null,
      lastProgress:null,retired:false,retirementScheduled:false};variants.set(signature,entry);}
    const retire=()=>{
      if(entry.retired)return;entry.retired=true;
      if(variants.get(signature)===entry)variants.delete(signature);
      if(!variants.size)stripCache.delete(input.key);
      entry.controller.abort();entry.result?.dispose?.();entry.result=null;entry.lastProgress=null;
    };
    const scheduleRetirement=()=>{
      if(entry.consumers.size||entry.retirementScheduled||entry.retired)return;
      entry.retirementScheduled=true;
      Promise.resolve().then(()=>{entry.retirementScheduled=false;if(!entry.consumers.size)retire();});
    };
    let consumer;
    const promise=new Promise((resolve,reject)=>{
      consumer={resolve,reject,active:true,settled:false,result:null,onProgress,release:null};
      const element=source?.el;
      const release=()=>{
        if(!consumer.active)return;consumer.active=false;entry.consumers.delete(consumer);
        signal?.removeEventListener('abort',release);element?.removeEventListener?.('emptied',release);
        if(consumer.result)consumer.result.frames.length=0;
        if(!consumer.settled){consumer.settled=true;reject(cancelled());}
        scheduleRetirement();
      };
      consumer.release=release;entry.consumers.add(consumer);
      signal?.addEventListener('abort',release,{once:true});element?.addEventListener?.('emptied',release,{once:true});
      if(signal?.aborted)release();
    });
    const notify=(target,value)=>{if(!target.active)return;try{target.onProgress?.({...value});}catch(_){}};
    const deliver=target=>{
      if(!target.active||target.settled||!entry.result)return;
      const result=entry.result;
      // Image URL lifetimes are shared, but each consumer gets its own records
      // and array. Disposing or editing one view cannot poison another view.
      target.result={state:result.state,frames:result.frames.map(frame=>({...frame})),duration:result.duration,
        reason:result.reason,dispose:target.release};target.settled=true;target.resolve(target.result);
    };
    if(entry.lastProgress)notify(consumer,entry.lastProgress);
    if(entry.result)deliver(consumer);
    else if(!entry.started){
      entry.started=true;
      entry.promise=buildFilmstrip(source,{signal:entry.controller.signal,count,width,height,onProgress:value=>{
        if(entry.retired)return;entry.lastProgress={...value};for(const target of [...entry.consumers])notify(target,value);
      }});
      entry.promise.then(result=>{
        if(entry.retired){result.dispose?.();return;}
        entry.result=result;for(const target of [...entry.consumers])deliver(target);scheduleRetirement();
      },error=>{
        for(const target of [...entry.consumers]){
          if(target.active&&!target.settled){target.settled=true;target.reject(error);}target.release();
        }
        scheduleRetirement();
      });
    }
    return promise;
  }
  return Object.freeze({load,summarize,filmstrip,limits});
})();
