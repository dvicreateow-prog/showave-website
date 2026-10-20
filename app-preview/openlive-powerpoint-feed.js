/* Native PowerPoint owns slide rendering. This client holds one decoded frame
   in RAM and shares it between the Clip, monitors and normal output renderer.
   It never uploads, exports or saves the original presentation. */
(function(){
'use strict';
function create(options){
  const session=String(options.session||'');
  if(!session)throw Error('An exact PowerPoint session is required for its picture.');
  const fetcher=options.fetch||fetch,decode=options.decode||createImageBitmap;
  let lease=null,url=null,frame=null,revision='0',closed=false,timer=null,controller=null,delayResolve=null;
  let status='loading',error=null,width=0,height=0,slide=0,lastSuccess=0,starting=null;
  const current=()=>!closed&&(!options.isCurrent||options.isCurrent());
  const call=(callback,value)=>{if(callback)try{callback(value);}catch(failure){console.warn('PowerPoint feed observer failed:',failure);}};
  const notify=()=>{if(current())call(options.onState,snapshot());};
  const snapshot=()=>({session,lease,status,error,width,height,slide,revision});
  const dropFrame=()=>{if(frame&&frame.close)frame.close();frame=null;lastSuccess=0;};
  function release(){
    closed=true;clearTimeout(timer);timer=null;
    if(delayResolve){const resolve=delayResolve;delayResolve=null;resolve();}
    if(controller)controller.abort();dropFrame();
    const releasedLease=lease;lease=null;
    if(releasedLease)fetcher('/api/powerpoint-live/feed/release?session='+encodeURIComponent(session)+'&lease='+encodeURIComponent(releasedLease),
      {method:'POST',cache:'no-store',keepalive:true}).catch(()=>{});
    if(status!=='error')status='closed';
  }
  async function resultError(response){
    let value={};try{value=await response.json();}catch(_){}
    const failure=Error(value.error||'The native PowerPoint picture is unavailable.');
    failure.code=value.code||null;failure.status=response.status;return failure;
  }
  async function readFrame(){
    controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetcher(url+'&since='+encodeURIComponent(revision),{cache:'no-store',signal:controller.signal});
      if(!current()){release();return false;}
      if(response.status===204){lastSuccess=Date.now();return !!frame;}
      if(!response.ok)throw await resultError(response);
      if(!/^image\/jpeg(?:;|$)/i.test(response.headers.get('Content-Type')||''))
        throw Error('PowerPoint supplied no native slide picture.');
      const blob=await response.blob();
      if(blob.size>8*1024*1024)throw Error('The native PowerPoint frame exceeds its memory limit.');
      const nextRevision=String(response.headers.get('X-OpenLive-Frame')||'');
      if(!/^[1-9]\d*$/.test(nextRevision)||!Number.isSafeInteger(Number(nextRevision)))
        throw Error('PowerPoint supplied an invalid frame revision.');
      const decoded=await decode(blob);
      if(!current()){if(decoded.close)decoded.close();release();return false;}
      const nextWidth=Number(decoded.width),nextHeight=Number(decoded.height);
      if(!(nextWidth>0&&nextHeight>0&&nextWidth<=4096&&nextHeight<=2160&&nextWidth*nextHeight<=8847360)){
        if(decoded.close)decoded.close();throw Error('PowerPoint produced an empty or oversized frame.');}
      const previous=frame;frame=decoded;width=nextWidth;height=nextHeight;
      revision=nextRevision;
      slide=Number(response.headers.get('X-OpenLive-Slide'))||slide;
      lastSuccess=Date.now();status='ready';error=null;
      if(previous&&previous.close)previous.close();
      call(options.onFrame,snapshot());notify();return true;
    }finally{clearTimeout(timeout);controller=null;}
  }
  function schedule(){
    if(!current()){release();return;}
    const wait=Math.max(66,Math.min(2000,Number(options.interval&&options.interval())||500));
    timer=setTimeout(async()=>{
      timer=null;if(!current()){release();return;}
      try{await readFrame();schedule();}catch(failure){fail(failure);}
    },wait);
  }
  function fail(failure){
    if(!current()){release();return;}
    status='error';error=failure.message||String(failure);dropFrame();
    try{notify();call(options.onError,failure);}finally{release();}
  }
  function start(){
    if(starting)return starting;
    starting=(async()=>{
      controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30000);
      let value;
      try{
        const response=await fetcher('/api/powerpoint-live/feed/start?session='+encodeURIComponent(session),
          {method:'POST',cache:'no-store',signal:controller.signal});
        if(!response.ok)throw await resultError(response);
        value=await response.json();
      }finally{clearTimeout(timeout);controller=null;}
      const feed=value&&value.feed;
      if(!feed||String(feed.sessionId||value.sessionId)!==session||!feed.leaseId)
        throw Error('The native PowerPoint picture did not match this Clip.');
      lease=String(feed.leaseId);
      url='/api/powerpoint-live/feed/frame?session='+encodeURIComponent(session)+'&lease='+encodeURIComponent(lease);
      if(!current()){release();return false;}
      const until=Date.now()+20000;
      do{
        if(await readFrame()){schedule();return value;}
        if(!current()){release();return false;}
        if(Date.now()>=until)throw Error('PowerPoint opened but has not supplied a slide picture.');
        await new Promise(resolve=>{delayResolve=resolve;timer=setTimeout(()=>{delayResolve=null;resolve();},100);});timer=null;
      }while(current());
      return false;
    })().catch(failure=>{fail(failure);throw failure;});
    return starting;
  }
  return {start,release,snapshot,
    source(){return current()&&status==='ready'&&frame&&Date.now()-lastSuccess<=2500?{source:frame,width,height}:null;}};
}
window.OpenLivePowerPointFeed={create};
})();
