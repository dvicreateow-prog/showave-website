/* Load Studio scripts in order after the shared in-memory session has hydrated. */
(()=>{
  'use strict';
  let closed=false,running=false,hydrated=false,cursor=0,sources=null;
  let notice=null,noticeText=null,retryButton=null;
  window.addEventListener('pagehide',()=>{closed=true;},{once:true});
  function loadExternal(source){
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=source.src;script.async=false;
      script.onload=()=>{script.onload=script.onerror=null;resolve();};
      script.onerror=()=>{
        script.onload=script.onerror=null;script.remove();
        reject(Error('Studio could not load '+source.getAttribute('src')+'.'));
      };
      source.after(script);
    });
  }
  async function loadWithRetry(source){
    // Retry only a reported resource-load error. Earlier successful scripts
    // must never run twice, and a pending request must not be raced by a timer.
    for(let attempt=0;attempt<2;attempt++){
      if(closed)return;
      try{await loadExternal(source);return;}
      catch(error){if(closed)return;if(attempt===1)throw error;}
    }
  }
  function showFailure(error){
    if(closed)return;
    notice?.remove();
    notice=document.createElement('p');notice.id='openliveStartupNotice';notice.setAttribute('role','alert');
    notice.style.cssText='display:flex;align-items:center;gap:12px;margin:8px;padding:8px;border:1px solid var(--line);font:11px Segoe UI,sans-serif;color:var(--txt);background:var(--panel)';
    noticeText=document.createElement('span');noticeText.style.flex='1';
    noticeText.textContent=(error.message||'Studio startup failed.')+' Retry to continue loading this session.';
    retryButton=document.createElement('button');retryButton.type='button';retryButton.textContent='Retry startup';
    retryButton.addEventListener('click',start);
    notice.appendChild(noticeText);notice.appendChild(retryButton);
    document.body.prepend(notice);
  }
  async function start(){
    if(closed||running)return;
    running=true;
    if(retryButton)retryButton.disabled=true;
    if(noticeText)noticeText.textContent='Retrying Studio startup…';
    try{
      if(!hydrated){await window.OpenLiveSessionPolicy?.ready;hydrated=true;}
      if(closed)return;
      if(!sources)sources=Array.from(document.querySelectorAll('script[type="text/openlive-session"]'));
      while(cursor<sources.length){
        if(closed)return;
        const source=sources[cursor];
        if(source.src)await loadWithRetry(source);
        else{const script=document.createElement('script');script.textContent=source.textContent;source.after(script);}
        if(closed)return;
        cursor++;
      }
      notice?.remove();notice=noticeText=retryButton=null;
    }catch(error){showFailure(error);}
    finally{running=false;}
  }
  start();
})();
