/* OBS-style scene recall. Scene settings persist; auditions and Programme remain separate.
 * Reusable library storage is never rewritten merely by selecting a scene. */
window.OpenLiveSceneRecall=(()=>{
  'use strict';
  const plain=value=>value===undefined?null:JSON.parse(JSON.stringify(value,(key,item)=>key.startsWith('_')?undefined:item));
  function create({studio,theme,captions,commerce,graphics,widgets,onStatus=()=>{}}){
    const modules={theme,captions,commerce,graphics,widgets},disposers=[];
    let current=null,restoring=false,destroyed=false;const unsaved=new Map(),legacyStates=new Map();
    const same=(a,b)=>JSON.stringify(plain(a))===JSON.stringify(plain(b));
    function status(message,error=false){try{onStatus(message,error);}catch(_){}}
    const settingsStatus=scene=>(window.OpenLiveSessionPolicy?.sessionOnly?'Scene settings kept for this session · ':'Scene settings saved automatically · ')+scene.name;
    function restore(scene){
      restoring=true;
      try{for(const [key,module] of Object.entries(modules))module?.recallSceneState?.(scene.renderState[key],{sceneId:scene.id});}
      finally{restoring=false;}
    }
    function select(scene){
      if(destroyed||!scene||!studio.scenes().includes(scene))return false;
      try{
        if(current&&!studio.scenes().includes(current)){unsaved.clear();current=null;}
        if(unsaved.size&&current){studio.saveSceneRenderState(current.id,{...current.renderState,...Object.fromEntries(unsaved)});unsaved.clear();status(settingsStatus(current));}
        if(scene===current)return true;
        // Existing scenes without a checkpoint migrate from their current settings,
        // not from an unrelated scene's subsequently recalled controls.
        if(!scene.renderState){studio.saveSceneRenderState(scene.id,legacyStates.get(scene.id)||studio.captureSceneRenderState(scene,false));legacyStates.delete(scene.id);}
        restore(scene);current=scene;status(settingsStatus(scene));return true;
      }catch(error){if(current&&!unsaved.size)try{restore(current);}catch(_){}status(error.message||String(error),true);return false;}
    }
    function changed(key,event,reason){
      if(destroyed||restoring||!current||!studio.scenes().includes(current))return;
      if(key==='widgets'&&event?.type!=='library')return;
      if(key==='graphics'&&['folder-create','folder-update','folder-remove','folder-select','scene-copy','scene-remove','scope','broadcast-sync','storage-sync'].includes(reason))return;
      try{
        const captured=studio.captureSceneRenderState(current),next={...current.renderState,[key]:captured[key]};
        if(same(current.renderState[key],next[key])){if(unsaved.delete(key)&&!unsaved.size)status(settingsStatus(current));return;}
        unsaved.set(key,next[key]);
        studio.saveSceneRenderState(current.id,{...next,...Object.fromEntries(unsaved)});unsaved.clear();status(settingsStatus(current));
      }catch(error){status(error.message||String(error),true);}
    }
    // Pin legacy scenes before any editor is recalled; no writes on later switches.
    function initialize(){
      const missing=studio.scenes().filter(scene=>!scene.renderState),states=missing.map(scene=>studio.captureSceneRenderState(scene));
      missing.forEach((scene,index)=>legacyStates.set(scene.id,states[index]));
      for(let index=0;index<missing.length;index++){studio.saveSceneRenderState(missing[index].id,states[index]);legacyStates.delete(missing[index].id);}
    }
    for(const [key,module] of Object.entries(modules))if(module?.subscribe)disposers.push(module.subscribe((event,reason)=>changed(key,event,reason)));
    return {initialize,select,changed,refreshWidgets:()=>changed('widgets',{type:'library'}),
      get current(){return current;},get hasUnsaved(){return unsaved.size>0;},destroy(){destroyed=true;disposers.splice(0).forEach(dispose=>dispose());}};
  }
  return Object.freeze({create});
})();
