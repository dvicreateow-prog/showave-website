/* DOM-free asynchronous full-SVG layout selection. Studio owns the only scene
 * mutation and its durable rollback; this controller owns request ordering.
 * Cancelling never aborts a shared artwork decode needed by another consumer. */
window.OpenLiveFullTemplateSelection = (() => {
  'use strict';

  function create({studio,templates,controlScene,onChanged,onStatus}) {
    if (!studio || typeof studio.scenes !== 'function' || typeof studio.applySceneTemplate !== 'function' ||
        !templates || typeof templates.load !== 'function' || typeof controlScene !== 'function')
      throw new Error('Full template selection needs Studio, an artwork library and an editing scene provider.');
    let revision=0, busy=false, destroyed=false;
    const current=request=>!destroyed && request===revision;
    function report(message) {
      // A display callback must not turn a successful Studio commit into a
      // rejected promise, or interrupt cleanup after a failed artwork load.
      if (typeof onStatus==='function') {
        try { onStatus(message); } catch (_) { /* The caller owns its display. */ }
      }
    }
    function ordered(value) {
      if (!value || typeof value!=='object') return value;
      if (Array.isArray(value)) return value.map(ordered);
      return Object.fromEntries(Object.keys(value).sort().map(name=>[name,ordered(value[name])]));
    }
    function capturedStyle(value) {
      if (!value || typeof value!=='object') return value;
      const copy=Array.isArray(value) ? value.map(capturedStyle) :
        Object.fromEntries(Object.entries(value).map(([name,item])=>[name,capturedStyle(item)]));
      return Object.freeze(copy);
    }
    function sceneSignature(scene) {
      return JSON.stringify([scene.layout,scene.fullTemplateId,ordered(scene.fullTemplateStyle),scene.fullTemplateExtras,
        ordered(scene.svgParts),scene.svgPartsMode,scene.svgPartsExtras]);
    }
    function cancel() { ++revision;busy=false; }
    async function select(id) {
      if (destroyed) return null;
      const request=++revision;
      busy=true;
      try {
        const target=controlScene();
        if (!target || !target.id) throw new Error('Choose an editing scene first.');
        const sceneId=target.id;
        const scene=studio.scenes().find(item=>item.id===sceneId);
        if (!scene) throw new Error('That editing scene is no longer available.');
        const record=typeof templates.get==='function' ? templates.get(id) : null;
        if (typeof id!=='string' || !id || (typeof templates.get==='function' && !record))
          throw new Error('Choose an available full SVG template.');
        const signature=sceneSignature(scene);
        // Re-selecting this template keeps its saved palette. A different
        // template begins with its own original colours, not inherited keys.
        const raw=scene.fullTemplateId===id ? capturedStyle(scene.fullTemplateStyle||{}) : {};
        const style=capturedStyle(typeof templates.normalizeStyle==='function'
          ? templates.normalizeStyle(id,raw) : raw);
        report('Preparing '+(record && record.name || 'the full SVG template')+'…');
        // onStatus is permitted to refresh or cancel the request synchronously.
        if (!current(request)) return null;
        const readiness=await templates.load(id,{style,retry:true});
        if (!current(request)) return null;
        if (!readiness || readiness.state!=='ready')
          throw new Error(readiness && readiness.error || 'The full SVG artwork did not finish loading.');
        const existing=studio.scenes().find(item=>item.id===sceneId);
        if (!existing) throw new Error('The editing scene was removed while the artwork loaded.');
        if (controlScene()?.id!==sceneId)
          throw new Error('The editing scene changed while the artwork loaded. Select the template again.');
        if (sceneSignature(existing)!==signature)
          throw new Error('The editing scene layout or template colours changed, or its SVG pieces / extra overlays changed while the artwork loaded. Select the template again.');
        // applySceneTemplate is Studio's synchronous, atomic persistence API.
        const result=studio.applySceneTemplate(sceneId,id,style);
        if (!result) throw new Error('The full template could not be saved. The previous scene has not changed.');
        busy=false;
        let refreshError=null;
        if (typeof onChanged==='function') {
          try { onChanged(result); } catch (error) { refreshError=error; }
        }
        if (current(request)) report(refreshError
          ? 'The full template was applied, but the interface could not refresh: '+(refreshError.message||String(refreshError))
          : 'Applied '+(record && record.name || 'the full SVG template')+' to '+(existing.name || 'the editing scene')+'.');
        return result;
      } catch (error) {
        if (current(request)) report(error && error.message || String(error));
        return null;
      } finally {
        if (current(request)) busy=false;
      }
    }
    return Object.freeze({select,cancel,isBusy:()=>busy,
      destroy(){if(destroyed)return;destroyed=true;cancel();}});
  }
  return Object.freeze({create});
})();
