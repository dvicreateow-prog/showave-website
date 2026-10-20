/* Scene creation/import UI. Native modal focus, local files, explicit commits. */
window.OpenLiveSceneTools=(()=>{
  'use strict';
  function mount({studio,templates,images,onCreated,onCustomize,onSceneAction,document:doc=document}){
    const dialog=doc.createElement('dialog');dialog.className='bc-scene-dialog';dialog.setAttribute('aria-labelledby','sceneToolsTitle');
    dialog.innerHTML=`<form id="sceneToolsForm">
      <header><h2 id="sceneToolsTitle">New scene</h2><button type="button" id="sceneToolsClose" aria-label="Close scene dialog">×</button></header>
      <p id="sceneToolsIntro">Create a separate scene. Programme and the Default scene stay unchanged.</p>
      <label>Scene name<input id="sceneToolsName" maxlength="80" required autocomplete="off"></label>
      <label id="sceneToolsStartField">Start with<select id="sceneToolsStart"><option value="blank">Blank scene</option><option value="template">Built-in template</option><option value="upload">Upload artwork or scene settings</option></select></label>
      <p id="sceneToolsLayoutField">An empty scene folder and Free canvas with OBS-style Add Source: choose a type, create or reuse a source, then set properties. Move, resize, rotate and stack your sources. No template is added; existing scenes keep their workflow.</p>
      <label id="sceneToolsTemplateField" hidden>Template<select id="sceneToolsTemplate"></select></label>
      <label id="sceneToolsFileField" hidden>Local file<input id="sceneToolsFile" type="file" accept=".png,.jpg,.jpeg,.webp,.json,image/png,image/jpeg,image/webp,application/json"></label>
      <p id="sceneToolsUploadHelp" hidden>PNG, JPEG or WebP up to 10 MiB becomes an editable artwork layer. SHOWAVE scene-settings JSON up to 1 MiB creates a new scene. Files stay on this computer.</p>
      <p id="sceneToolsSummary" hidden></p>
      <section id="sceneToolsActions" class="bc-scene-actions" aria-label="Scene-wide settings" hidden>
        <p>Apply a complete layout or edit this scene’s theme. Add individual graphics, captions and timers through Sources.</p>
        <button type="button" id="sceneToolsTemplates">Complete scene templates</button>
        <button type="button" id="sceneToolsTheme">Scene theme</button>
      </section>
      <p id="sceneToolsFileScope" hidden>Settings files include layouts and SVG layers. Local images must already exist in this browser. Cameras, media bindings, widgets, separate Graphics/Captions assets and destinations are not included.</p>
      <p id="sceneToolsStatus" role="status" aria-live="polite"></p>
      <footer><button type="button" id="sceneToolsExport" hidden>Save settings file</button><span></span><button type="button" id="sceneToolsCancel">Cancel</button><button type="submit" id="sceneToolsSubmit">Create scene</button></footer>
    </form>`;
    doc.body.appendChild(dialog);
    const $=id=>dialog.querySelector('#sceneTools'+id);let serial=0,editing=null,opener=null,busy=false;
    for(const template of templates?.list()||[]){const option=doc.createElement('option');option.value=template.id;option.textContent=template.name;$('Template').appendChild(option);}
    const status=(text,error=false)=>{$('Status').textContent=text;$('Status').classList.toggle('error',error);};
    const lock=value=>{busy=value;for(const control of [$('Name'),$('Start'),$('Template'),$('File'),$('Submit'),$('Export')])control.disabled=value;};
    const fields=()=>{
      const kind=$('Start').value;
      $('StartField').hidden=!!editing;$('LayoutField').hidden=!!editing||kind!=='blank';
      $('TemplateField').hidden=!!editing||kind!=='template';$('FileField').hidden=!!editing||kind!=='upload';
      $('UploadHelp').hidden=!!editing||kind!=='upload';$('FileScope').hidden=!editing&&kind!=='upload';
      $('FileScope').textContent=editing&&window.OpenLiveSessionPolicy?.sessionOnly===true
        ?'This scene, its settings and its source placements stay in memory for this session.'
        :'Settings files include layouts and SVG layers. Local images must already exist in this browser. Cameras, media bindings, widgets, separate Graphics/Captions assets and destinations are not included.';
      $('Summary').hidden=!editing;$('Export').hidden=!editing||window.OpenLiveSessionPolicy?.sessionOnly===true;
      $('Actions').hidden=!editing||typeof onSceneAction!=='function';
    };
    const close=()=>{serial++;lock(false);if(dialog.open)dialog.close();opener?.isConnected&&opener.focus();};
    $('Close').addEventListener('click',close);$('Cancel').addEventListener('click',close);
    for(const [field,action] of [['Templates','templates'],['Theme','theme']])$(''+field).addEventListener('click',()=>{
      if(busy||!dialog.open||!editing||typeof onSceneAction!=='function')return;
      const scene=studio.scenes().find(scene=>scene.id===editing);
      if(!scene){status('This scene no longer exists.',true);return;}
      const origin=opener;close();onSceneAction(scene,action,origin);
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    $('Start').addEventListener('change',()=>{fields();status('');});
    $('File').addEventListener('change',()=>{const file=$('File').files[0];if(file){$('Name').value=file.name.replace(/(?:\.showave-scene)?\.(png|jpe?g|webp|json)$/i,'').slice(0,80);status('File selected. Create scene imports it as a new scene.');}});
    $('Export').addEventListener('click',()=>{
      try{
        window.OpenLiveSessionPolicy?.assertCanWrite('Saving scene settings');
        const data=studio.exportSceneSettings(editing),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
        const a=doc.createElement('a');a.href=url;a.download=(data.scene.name.replace(/[^\p{L}\p{N} _-]/gu,'').trim()||'scene')+'.showave-scene.json';doc.body.appendChild(a);a.click();a.remove();
        window.setTimeout(()=>URL.revokeObjectURL(url),1000);status('Scene settings file prepared. If your browser asks, choose where to save it. Live sources and separate assets are not included.');
      }catch(error){status(error.message||String(error),true);}
    });
    $('Form').addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      const request=++serial,current=()=>dialog.open&&request===serial,name=$('Name').value.trim(),kind=$('Start').value,id=editing;
      if(!name||name.length>80){status('Enter a scene name of 1–80 characters.',true);return;}
      lock(true);status(id?'Opening scene editor…':'Preparing your scene…');
      try{
        if(id){
          const scene=studio.scenes().find(scene=>scene.id===id);if(!scene)throw Error('This scene no longer exists.');
          if(scene.name!==name&&!studio.renameScene(id,name))throw Error('The scene name could not be saved.');
          close();onCustomize?.(scene);return;
        }
        let settings={name,layout:kind==='blank'?'free':'solo',...(kind==='blank'?{sourceWorkflow:'obs'}:{})},created;
        if(kind==='template')settings={name,layout:$('Template').value,fullTemplateId:$('Template').value};
        else if(kind==='upload'){
          const file=$('File').files[0];if(!file)throw Error('Choose a local artwork or scene-settings file.');
          if(/\.json$/i.test(file.name)){
            if(file.size<1||file.size>1024*1024)throw Error('Scene-settings files must be no larger than 1 MiB.');
            const text=await file.text();if(!current())return;
            let data;try{data=JSON.parse(text);}catch(_){throw Error('This is not valid scene-settings JSON.');}
            if(!data?.scene||typeof data.scene!=='object'||Array.isArray(data.scene))throw Error('Choose a SHOWAVE scene-settings file.');
            // Keep all incoming fields for strict model validation; only the
            // operator's explicitly edited scene name overrides the file.
            data.scene.name=name;created=await studio.importSceneFile(data,{isCurrent:current});
          }else{
            if(!images?.importFile)throw Error('Local artwork storage is unavailable.');
            if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Choose PNG, JPEG, WebP or a SHOWAVE scene-settings JSON file.');
            const asset=await images.importFile(file);if(!current())return;
            const template=templates?.list().find(t=>t.components?.some(c=>c.type==='background'));
            const component=template?.components.find(c=>c.type==='background');if(!component)throw Error('The artwork layer renderer is unavailable.');
            settings.svgParts=[{templateId:template.id,componentId:component.id,style:{components:{[component.id]:{imageId:asset.id,imageFit:'contain'}}}}];settings.svgPartsMode='overlay';
          }
        }
        if(!created)created=await studio.createScene(settings,{isCurrent:current});
        if(!current())return;close();onCreated?.(created);
      }catch(error){if(current())status(error.message||String(error),true);}
      finally{if(request===serial)lock(false);}
    });
    function open(kind='blank',scene=null){
      serial++;lock(false);editing=scene?.id||null;opener=doc.activeElement;
      $('Name').value=scene?.name||'Scene '+(studio.scenes().length+1);$('Start').value=kind;$('File').value='';
      $('Title').textContent=scene?'Customize scene':'New scene';$('Submit').textContent=scene?'Open scene editor':'Create scene';
      $('Intro').textContent=scene?'Name your scene, then edit its layout, sources and layers in the Studio.':'Create a blank scene, add your preferred sources and arrange them freely. Layout presets and artwork are optional. Programme stays unchanged.';
      const count=scene?.svgParts?.length||0;
      $('Summary').textContent=scene?((studio.LAYOUTS[scene.layout]?.label||scene.layout)+' · '+count+' SVG layer'+(count===1?'':'s')+(studio.previewWorkflow?' · Edits stay in Preview until Cut/Fade.':scene.id===studio.active()?.id?' · Currently on Programme; saved edits affect this scene.':'')):'';
      status('');fields();dialog.showModal();$('Name').focus();$('Name').select();
    }
    return {create:()=>open('blank'),upload:()=>open('upload'),edit:scene=>open('blank',scene),close,destroy(){close();dialog.remove();}};
  }
  return Object.freeze({mount});
})();
