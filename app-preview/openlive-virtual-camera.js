/* Local, video-only Programme output. Owns its capture, never Studio's encoder bus. */
(function(root){
  'use strict';
  function create({getCanvas,onChange,environment=root}={}){
    const env=environment,base='/api/virtual-camera/';
    let serviceBase=base;
    let revision=0,disposed=false,session=null,socket=null,recorder=null,stream=null,poll=null;
    let value={state:'idle',available:null,device:'',reason:'',framesSent:0};
    const snapshot=()=>({...value});
    function publish(patch){value={...value,...patch};try{onChange?.(snapshot());}catch(_){}return snapshot();}
    async function request(path,body,keepalive=false,endpoint=serviceBase){
      const abort=env.AbortController?new env.AbortController():null;
      const timeout=abort?env.setTimeout(()=>abort.abort(),10000):null;
      try{
      const response=await env.fetch(endpoint+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',keepalive,signal:abort?.signal});
      let data;try{data=await response.json();}catch(_){throw Object.assign(Error('The virtual-camera helper needs an update. Restart the local SHOWAVE helper.'),{status:response.status});}
      if(!response.ok)throw Object.assign(Error(data.error||data.reason||'The virtual-camera helper could not complete this request.'),{status:response.status});
      return data;
      }catch(error){if(error.name==='AbortError')throw Error('The local camera helper did not respond. Check that it is running.');throw error;}
      finally{if(timeout!==null)env.clearTimeout(timeout);}
    }
    function release(){
      if(poll!==null){env.clearTimeout(poll);poll=null;}
      const oldRecorder=recorder;recorder=null;
      if(oldRecorder){oldRecorder.ondataavailable=null;oldRecorder.onerror=null;oldRecorder.onstop=null;try{if(oldRecorder.state!=='inactive')oldRecorder.stop();}catch(_){}}
      const oldSocket=socket;socket=null;
      if(oldSocket){oldSocket.onopen=null;oldSocket.onmessage=null;oldSocket.onerror=null;oldSocket.onclose=null;try{oldSocket.close();}catch(_){}}
      const oldStream=stream;stream=null;
      for(const track of oldStream?.getTracks?.()||[]){track.onended=null;try{track.stop();}catch(_){}}
    }
    async function stopSession(owned,keepalive=false){if(owned)try{await request('stop',{id:owned.id,token:owned.token},keepalive,owned.endpoint||serviceBase);}catch(_){} }
    async function fail(reason,epoch){
      if(disposed||epoch!==revision)return;
      ++revision;const owned=session;session=null;release();publish({state:'error',reason:String(reason||'Virtual camera stopped.')});await stopSession(owned);
    }
    function receive(data,epoch){
      if(disposed||epoch!==revision)return;
      if(data.state==='error'||data.error){void fail(data.error||data.reason||'The virtual camera stopped.',epoch);return;}
      if(data.state==='stopped'){void fail(data.reason||'The camera helper disconnected. Start the virtual camera again.',epoch);return;}
      if(data.state==='live')publish({state:'live',device:data.device||value.device,framesSent:Number(data.framesSent)||0,reason:''});
    }
    function pollStatus(epoch){
      if(disposed||epoch!==revision||!session)return;
      poll=env.setTimeout(async()=>{
        poll=null;const owned=session;if(!owned||epoch!==revision)return;
        try{receive(await request('status?session='+encodeURIComponent(owned.id)+'&token='+encodeURIComponent(owned.token),undefined,false,owned.endpoint),epoch);}
        catch(error){void fail(error.message||'The camera helper is unavailable.',epoch);}
        pollStatus(epoch);
      },800);
    }
    async function check(){
      const epoch=revision;
      if(disposed||['connecting','live','stopping'].includes(value.state))return snapshot();
      if(!env.MediaRecorder||!env.MediaRecorder.isTypeSupported?.('video/webm;codecs=vp8'))return publish({available:false,reason:'This browser cannot send Programme to the virtual camera. Open SHOWAVE in Chrome or Edge.'});
      try{
        let data;
        try{data=await request('capability');}
        catch(error){
          // Older running helpers can keep their show/media sessions while a
          // camera-only service runs separately. It accepts this exact origin.
          if(error.status!==404||new URL(env.location.href).origin!=='http://127.0.0.1:8090')throw error;
          const fallback='http://127.0.0.1:8092/api/virtual-camera/';
          try{data=await request('capability',undefined,false,fallback);}catch(_){throw Error('Start the SHOWAVE camera service, or restart the local helper to load virtual-camera support.');}
          if(data.service!=='showave.virtual-camera'||data.protocol!==1)throw Error('The local camera service is not compatible with this version of SHOWAVE.');
          if(disposed||epoch!==revision)return snapshot();
          serviceBase=fallback;
        }
        if(!disposed&&epoch===revision)publish({available:!!data.available,device:data.device||value.device,reason:data.available?'':data.reason||data.error||'Virtual-camera support is unavailable.'});
      }
      catch(error){if(!disposed&&epoch===revision)publish({available:false,reason:error.message||'The local virtual-camera helper is unavailable.'});}
      return snapshot();
    }
    async function start(){
      if(disposed||['connecting','live','stopping'].includes(value.state))return snapshot();
      const epoch=++revision;publish({state:'connecting',reason:'',framesSent:0});
      try{
        if(!env.MediaRecorder?.isTypeSupported?.('video/webm;codecs=vp8'))throw Error('This browser cannot encode Programme for the virtual camera. Use Chrome or Edge.');
        const canvas=getCanvas?.();if(!canvas?.captureStream||!canvas.width||!canvas.height)throw Error('Programme is unavailable. Open the Studio before starting its virtual camera.');
        stream=canvas.captureStream(30);
        if(!stream.getVideoTracks().length)throw Error('Programme did not provide a video track.');
        const endpoint=serviceBase;
        const owned={...await request('start',{width:1280,height:720,fps:30,mimeType:'video/webm;codecs=vp8'},false,endpoint),endpoint};
        if(disposed||epoch!==revision){await stopSession(owned,true);return snapshot();}
        if(!owned.id||!owned.token)throw Error('The camera helper did not return an output session.');
        session={id:owned.id,token:owned.token,endpoint};publish({device:owned.device||value.device,available:true});
        const url=new URL(endpoint+'ingest',env.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('session',owned.id);url.searchParams.set('token',owned.token);
        const ws=socket=new env.WebSocket(url.href);
        ws.onopen=()=>{
          if(disposed||epoch!==revision||socket!==ws)return;
          try{
            const record=recorder=new env.MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:4000000});
            record.ondataavailable=event=>{
              if(epoch!==revision||!event.data?.size)return;
              if(ws.readyState!==1){void fail('The camera connection closed.',epoch);return;}
              if(ws.bufferedAmount+event.data.size>4*1024*1024){void fail('The virtual camera could not keep up with Programme. Stop other intensive outputs and try again.',epoch);return;}
              try{ws.send(event.data);}catch(error){void fail(error.message,epoch);}
            };
            record.onerror=event=>void fail(event.error?.message||'Programme capture failed.',epoch);
            record.onstop=()=>{if(epoch===revision)void fail('Programme capture stopped.',epoch);};
            for(const track of stream.getVideoTracks())track.onended=()=>void fail('The Programme video track ended.',epoch);
            record.start(100);pollStatus(epoch);
          }catch(error){void fail(error.message,epoch);}
        };
        ws.onmessage=event=>{try{receive(JSON.parse(event.data),epoch);}catch(_){} };
        ws.onerror=()=>void fail('The local camera connection failed. Check that the SHOWAVE helper is running.',epoch);
        ws.onclose=()=>void fail('The camera connection closed. Start the virtual camera again.',epoch);
      }catch(error){await fail(error.message,epoch);}
      return snapshot();
    }
    async function stop(){
      if(disposed)return snapshot();
      const epoch=++revision,owned=session;session=null;release();publish({state:'stopping',reason:''});
      await stopSession(owned);if(!disposed&&epoch===revision)publish({state:'idle',reason:'',framesSent:0});return snapshot();
    }
    function dispose(){if(disposed)return;disposed=true;++revision;const owned=session;session=null;release();void stopSession(owned,true);env.removeEventListener?.('pagehide',onPageHide);}
    function onPageHide(event){if(!event.persisted)dispose();}
    env.addEventListener?.('pagehide',onPageHide);
    return Object.freeze({start,stop,check,snapshot,dispose});
  }
  root.OpenLiveVirtualCamera=Object.freeze({create});
})(typeof window==='object'?window:globalThis);
