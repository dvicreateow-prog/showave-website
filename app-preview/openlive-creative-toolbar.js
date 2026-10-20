/* Compact, scene-owned creative tools. Dialog drafts never write to Programme. */
window.OpenLiveCreativeToolbar=(()=>{
  'use strict';
  function mount({root,studio,getSelection,enabled=()=>true,visible=()=>true,onChange,editArtwork,acquire,onSource}){
    const doc=root.ownerDocument,buttons=new Map();let modal=null,busy=false,destroyed=false;
    const make=(tag,parent,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;parent.appendChild(n);return n;};
    const button=(parent,text,fn)=>{const n=make('button',parent,text);n.type='button';n.addEventListener('click',fn);return n;};
    const clone=value=>JSON.parse(JSON.stringify(value));
    root.classList.add('bc-creative-toolbar');root.setAttribute('role','group');root.setAttribute('aria-label','Selected layer creative tools');
    const identity=make('span',root,'Select a source or artwork layer','bc-creative-identity');
    const tools=make('div',root,undefined,'bc-creative-actions');
    const status=make('span',root,'','bc-creative-status');status.setAttribute('role','status');
    function selection(){try{const s=getSelection();return s&&studio.creativeLayer(s.scene.id,s.key);}catch(_){return null;}}
    function current(target){const s=getSelection();return !destroyed&&visible()&&enabled()&&s?.scene===target.scene&&s.key===target.key&&studio.scenes().includes(target.scene);}
    const nativeHistory=target=>!!target?.row.part&&typeof studio.svgPartsHistory==='function'&&typeof studio.undoSceneSvgParts==='function'&&typeof studio.redoSceneSvgParts==='function';
    function close(){const old=modal;if(!old)return;modal=null;old.abort.abort();old.dialog.close();old.dialog.remove();if(old.opener?.isConnected)old.opener.focus();}
    function openArtwork(target){
      const live=selection();if(!current(target)||live?.item!==target.item||live.locked||live.audioOnly||busy||typeof editArtwork!=='function')return;
      close();try{if(editArtwork(target.row.part.id)===false)status.textContent='The artwork editor is unavailable. Select the layer again.';}
      catch(error){status.textContent=error.message||String(error);}
    }
    function refresh(){
      const target=selection();root.hidden=!visible();
      if(modal&&(!current(modal.target)||target?.item!==modal.target.item))close();
      identity.textContent=target?target.label:'Select a source or artwork layer';identity.title=identity.textContent;
      const reason=!target?'Select a source or scene artwork layer.':!enabled()?'Return to scene Preview to edit.':target.locked?'Unlock this layer to edit.':target.audioOnly?'Audio-only sources have no picture.':'';
      const history=target&&(nativeHistory(target)?studio.svgPartsHistory(target.scene.id):studio.creativeHistory(target.scene.id));
      for(const [name,node] of buttons){
        node.hidden=name==='Tone'&&!target?.row.part;
        node.disabled=busy||!!reason||(name==='Edit'&&target?.row.part&&typeof editArtwork!=='function')||(name==='Undo'&&!history?.canUndo)||(name==='Redo'&&!history?.canRedo);
        node.title=reason||(name==='Tone'?'Brightness, contrast and saturation · Preview only':name==='Edit'&&target?.row.part?'Customize artwork text, colours, image and transform · Preview only':name==='BG remover'?'Automatic subject cutouts are not configured.':name+' · Preview only');
      }
    }
    async function history(redo){const target=selection();if(!target||busy)return;busy=true;refresh();try{const options={isCurrent:()=>current(target)};if(nativeHistory(target))await studio[redo?'redoSceneSvgParts':'undoSceneSvgParts'](target.scene.id,options);else await studio.stepCreativeHistory(target.scene.id,redo,options);status.textContent=redo?'Edit redone in Preview.':'Edit undone in Preview.';onChange?.();}catch(e){status.textContent=e.message;}finally{busy=false;refresh();}}
    function open(name){
      const target=selection();if(!target||!current(target)||target.locked||target.audioOnly||busy)return;close();
      if(name==='Edit'&&target.row.part){openArtwork(target);return;}
      const dialog=make('dialog',doc.body,undefined,'bc-creative-dialog');dialog.setAttribute('aria-label',name+' · '+target.label);
      const head=make('header',dialog),title=make('strong',head,name);title.id='creativeToolTitle';dialog.setAttribute('aria-labelledby',title.id);
      button(head,'×',close).setAttribute('aria-label','Close creative tool');
      make('p',dialog,target.label+' · Preview only. Cut/Fade sends changes to Programme.','bc-creative-note');
      const form=make('form',dialog),fields=make('div',form,undefined,'bc-creative-fields');
      const error=make('p',form,'','bc-creative-error');error.setAttribute('role','status');
      const footer=make('footer',form);button(footer,'Cancel',close);const apply=make('button',footer,'Apply');apply.type='submit';
      const session={dialog,target,abort:new AbortController(),opener:doc.activeElement};modal=session;
      let patch=()=>({}),perform=null;
      function field(label,value,{type='number',min,max,step='any',options}={}){
        const row=make('label',fields,label);const input=make(options?'select':'input',row);input.setAttribute('aria-label',label);
        if(options){for(const [v,text] of options){const option=make('option',input,text);option.value=v;}}
        else{input.type=type;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;input.step=step;}
        input.value=String(value);return input;
      }
      const num=(label,value,min,max,step)=>field(label,value,{min,max,step});
      const info=text=>make('p',fields,text,'bc-creative-note');
      const c=target.creative;
      if(name==='Edit'||name==='Tone'){
        const brightness=num('Brightness (%)',c.brightness*100,0,200,1),contrast=num('Contrast (%)',c.contrast*100,0,200,1),saturation=num('Saturation (%)',c.saturation*100,0,200,1);
        patch=()=>({creative:{brightness:+brightness.value/100,contrast:+contrast.value/100,saturation:+saturation.value/100}});
      }else if(name==='Stroke'){
        const width=num('Width (HD px)',c.stroke.width,0,64,1),color=field('Colour',c.stroke.color,{type:'color'}),style=field('Style',c.stroke.style,{options:[['solid','Solid'],['dashed','Dashed'],['dotted','Dotted']]});
        patch=()=>({creative:{stroke:{width:+width.value,color:color.value,style:style.value}}});info('Border follows the visible picture after sizing and crop. Width 0 removes it.');
      }else if(name==='Corners'){
        const radius=num('Roundness (%)',c.radius*100,0,50,1);patch=()=>({creative:{radius:+radius.value/100}});
      }else if(name==='Crop'){
        const edges={};for(const key of ['left','right','top','bottom'])edges[key]=num(key[0].toUpperCase()+key.slice(1)+' crop (%)',c.crop[key]*100,0,99,.1);
        patch=()=>({creative:{crop:Object.fromEntries(Object.entries(edges).map(([k,input])=>[k,+input.value/100]))}});
        button(fields,'Reset crop',()=>{Object.values(edges).forEach(input=>{input.value='0';});});info('Trim edges without stretching or modifying the original.');
      }else if(name==='Flip'){
        const x=field('Horizontal',String(c.flipX),{options:[['false','Original'],['true','Flipped']]}),y=field('Vertical',String(c.flipY),{options:[['false','Original'],['true','Flipped']]});
        patch=()=>({creative:{flipX:x.value==='true',flipY:y.value==='true'}});
      }else if(name==='Transparency'){
        const transparency=num('Transparency (%)',(1-c.opacity)*100,0,100,1);patch=()=>({creative:{opacity:1-+transparency.value/100}});info('0% = opaque · 100% = invisible. Audio is unchanged.');
      }else if(name==='Animate'){
        const preset=field('Looping animation',c.animation.preset,{options:[['none','None'],['breathe','Breathe'],['float','Float'],['pulse','Pulse']]}),seconds=num('Loop duration (seconds)',c.animation.seconds,.5,20,.1);
        patch=()=>({creative:{animation:{preset:preset.value,seconds:+seconds.value}}});info('Loops in the compositor. This is not an entrance/exit transition.');
      }else if(name==='Position'){
        const values={};for(const [key,label] of [['x','X (%)'],['y','Y (%)'],['w','Width (%)'],['h','Height (%)'],['rotation','Rotation (°)']])values[key]=num(label,target.rect[key]*(key==='rotation'?1:100),key==='w'||key==='h'?1:-1000,key==='rotation'?360:1000,.1);
        const rect=()=>Object.fromEntries(Object.entries(values).map(([key,input])=>[key,+input.value/(key==='rotation'?1:100)]));patch=()=>({transform:rect()});
        const align=make('div',fields,undefined,'bc-creative-grid');for(const [key,label] of [['left','Left'],['center','Centre'],['right','Right'],['top','Top'],['middle','Middle'],['bottom','Bottom']])button(align,label,()=>{const r=window.OpenLiveFreeScene.alignRect(rect(),key);for(const key of ['x','y'])values[key].value=String(r[key]*100);});
        info('Align to canvas. Layer ordering applies immediately in Preview.');const order=make('div',fields,undefined,'bc-creative-grid');
        for(const [direction,label] of [['front','Bring to front'],['forward','Bring forward'],['backward','Send backward'],['back','Send to back']])button(order,label,()=>{try{if(!current(target)||studio.creativeLayer(target.scene.id,target.key).item!==target.item)throw Error('The layer changed. Reopen Position.');studio.moveFreeLayer(target.scene.id,target.key,direction);close();onChange?.();refresh();}catch(e){error.textContent=e.message;}});
      }else if(name==='Replace'){
        if(target.row.part){apply.hidden=true;info('Artwork replacement keeps this scene layer and its position. Use the existing Image section in its inspector.');button(fields,'Open artwork image replacement…',()=>openArtwork(target));}
        else{
          const existing=field('Existing picture source',target.item.sourceId||'',{options:[['','Choose a source…'],...Array.from(studio.sources.values()).filter(s=>!s.audioOnly).map(s=>[s.id,s.label])]});
          const file=field('Or local image / video','',{type:'file'});file.accept='image/png,image/jpeg,image/webp,video/*';
          info('Keeps this item’s position and effects. Other scenes and the previous capture are unchanged. Local media sources need reconnecting after reload.');
          perform=async()=>{
            let record=null,prepared=null;const picked=file.files?.[0];
            try{let sourceId=existing.value;
              if(picked){if(!acquire)throw Error('Local media acquisition is unavailable.');prepared=await acquire(/^image\//.test(picked.type)?'image':'media',{file:picked,loop:true},session.abort.signal);
                if(modal!==session||!current(target))throw Error('Replacement cancelled.');
                const spec={...prepared,label:picked.name};record=prepared.kind==='video'?studio.addMediaSource(spec):studio.addSource(spec);prepared=null;sourceId=record.id;}
              await studio.editCreativeLayer(target.scene.id,target.key,{sourceId},{expected:target.item,isCurrent:()=>modal===session&&current(target)});
              if(record)onSource?.(record);
            }catch(e){if(record)studio.discardUnplacedSource(record.id);prepared?.dispose?.();throw e;}
          };
        }
      }else if(name==='Eraser'){
        dialog.classList.add('bc-creative-eraser');let strokes=clone(c.erase),active=null;
        const brush=num('Brush size (%)',5,.2,50,.5);info('Brush on this isolated layer. Animation is paused here. Apply saves a reversible mask; the original and layers below are untouched.');
        const canvas=make('canvas',fields,undefined,'bc-creative-mask');canvas.width=800;canvas.height=450;canvas.setAttribute('aria-label','Eraser preview. Drag to erase; Clear mask restores all strokes.');
        const render=()=>{try{const result=studio.renderCreativeLayer(canvas,target.scene.id,target.key,{erase:strokes});
          if(result===false||result?.state==='failed')throw Error(result?.error||'No picture available. Reconnect this source before erasing.');
          apply.disabled=false;
        }catch(e){error.textContent=e.message;apply.disabled=true;}};
        const point=e=>{const bounds=canvas.getBoundingClientRect();return window.OpenLiveCreative.brushPoint(target.rect,(e.clientX-bounds.left)/bounds.width,(e.clientY-bounds.top)/bounds.height,16/9,window.OpenLiveCreative.normalize(target.item.creative));};
        canvas.addEventListener('pointerdown',e=>{if(e.button!==0||active)return;e.preventDefault();if(strokes.length>=32){error.textContent='Maximum 32 strokes. Undo a stroke or clear the mask first.';return;}
          active={pointer:e.pointerId,size:+brush.value/100,points:[point(e)]};strokes.push({size:active.size,points:active.points});canvas.setPointerCapture(e.pointerId);render();});
        canvas.addEventListener('pointermove',e=>{if(!active||e.pointerId!==active.pointer)return;const p=point(e),last=active.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])<.003)return;
          if(active.points.length<128)active.points.push(p);else{error.textContent='Stroke limit reached. Release and start another stroke.';}render();});
        const end=e=>{if(active&&e.pointerId===active.pointer){active=null;try{canvas.releasePointerCapture(e.pointerId);}catch(_){}render();}};
        canvas.addEventListener('pointerup',end);canvas.addEventListener('lostpointercapture',end);
        canvas.addEventListener('pointercancel',e=>{if(active){strokes.pop();end(e);}});
        button(fields,'Undo brush stroke',()=>{active=null;strokes.pop();render();});button(fields,'Clear mask / restore all',()=>{active=null;strokes=[];render();});
        patch=()=>({creative:{erase:strokes}});render();
      }else if(name==='BG remover'){
        apply.hidden=true;info('Automatic subject cutouts are not configured. They require a separate processing model or service. Nothing is installed or uploaded.');info('Use Eraser for manual, local background cleanup.');
        button(fields,'Open manual eraser',()=>{close();open('Eraser');});
      }
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(busy||modal!==session||apply.hidden||apply.disabled)return;
        if(!current(target)){close();return;}busy=true;apply.disabled=true;error.textContent='Applying…';refresh();
        try{if(perform)await perform();else await studio.editCreativeLayer(target.scene.id,target.key,patch(),{expected:target.item,history:target.row.part?'svg':'creative',isCurrent:()=>modal===session&&current(target)});
          close();status.textContent=name+' applied to Preview.';onChange?.();
        }catch(e){if(modal===session)error.textContent=e.message;}
        finally{busy=false;apply.disabled=false;refresh();}
      });
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
      dialog.showModal();(fields.querySelector('input,select,button')||footer.querySelector('button')).focus();
    }
    for(const name of ['Edit','Tone','Replace','Stroke','Corners','Crop','Flip','Animate','Transparency','Position','Eraser','BG remover','Undo','Redo']){
      const node=button(tools,name,()=>name==='Undo'||name==='Redo'?history(name==='Redo'):open(name));node.setAttribute('aria-label',name);
      const icon=make('span',node,undefined,'bc-creative-icon');icon.setAttribute('aria-hidden','true');
      icon.style.cssText='--creative-icon:url("assets/creative-icons/'+(name==='Tone'?'edit':name.toLowerCase().replace(/ /g,'-'))+'.svg")';
      if(['Stroke','Animate','Position','Undo'].includes(name))node.classList.add('bc-creative-tool-start');
      buttons.set(name,node);
    }
    refresh();return {refresh,close,destroy(){destroyed=true;close();root.replaceChildren();}};
  }
  return Object.freeze({mount});
})();
