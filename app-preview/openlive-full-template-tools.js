/* Shared original-SVG gallery. Selection and palette changes are preview drafts;
 * only apply(id, capturedSceneId, normalizedStyle) commits them to Studio.
 * mount accepts an optional target element/selector. refresh follows a changed
 * editing scene; select and setStyle stage choices without writing scene state. */
window.OpenLiveFullTemplateTools = (() => {
  'use strict';
  const mounted = new WeakMap();
  function mount(api) {
    const doc = api.document, library = window.OpenLiveFullTemplates;
    if (!doc) throw new Error('The full SVG template gallery needs a document.');
    if (mounted.has(doc)) return mounted.get(doc);
    const target = typeof api.target === 'string' ? doc.querySelector(api.target) :
      api.target || doc.querySelector('#themePanel .bc-commerce-scroll');
    if (!target || !library) return {destroy(){}};
    const root = doc.createElement('section'); root.className = 'production-section production-full-templates';
    root.id = 'fullSvgTemplates'; target.prepend(root);
    const el = (tag,parent,text,cls) => {const node=doc.createElement(tag);if(text!=null)node.textContent=text;
      if(cls)node.className=cls;parent.appendChild(node);return node;};
    if (!library.list().length) {
      el('h3',root,'Full SVG templates');
      const message=el('p',root,'No bundled sample designs are included. Use New in Scenes to create a blank scene, then add your own sources and artwork.','production-note');
      message.setAttribute('role','status');
      const unavailable=()=>false;
      let disposed=false;
      const result={select:unavailable,selectComponent:unavailable,selectComponentKind:unavailable,setStyle:unavailable,
        refresh(){},getSelection:()=>null,
        destroy(){if(disposed)return;disposed=true;root.remove();mounted.delete(doc);}};
      mounted.set(doc,result);return result;
    }
    const disposers=[], paletteDisposers=[], paletteInputs=new Map(), componentDisposers=[], componentInputs=new Map();
    const copyStyle=value=>JSON.parse(JSON.stringify(value||{}));
    const on=(node,event,fn,scope=disposers)=>{node.addEventListener(event,fn);scope.push(()=>node.removeEventListener(event,fn));};
    const button = (parent,text,fn,scope) => {const node=el('button',parent,text,'tb-btn production-button');node.type='button';on(node,'click',fn,scope);return node;};
    el('h3',root,'Your SVG designs & pieces');
    el('p',root,'Available designs, with their original pieces separated. Choose a design, then edit its background, frames, lettering, logos, LIVE badge or QR below. Apply saves the staged composition to the editing scene.','production-note');
    const grid=el('div',root,null,'production-full-grid'), choices=[];
    const preview=el('div',root,null,'production-preview');
    const label=el('label',preview,'Preview format ','production-preview-tools');
    const orientation=el('select',label);orientation.setAttribute('aria-label','Full SVG template preview format');
    for(const [value,text] of [['landscape','Landscape 16:9'],['portrait','Portrait 9:16 (complete artwork)']]){
      const option=el('option',orientation,text);option.value=value;
    }
    orientation.value='landscape';
    const image=el('img',preview,null,'production-full-preview');image.alt='Complete supplied SVG artwork';
    const styledCanvas=el('canvas',preview,null,'production-full-preview');styledCanvas.hidden=true;
    styledCanvas.setAttribute('role','img');styledCanvas.setAttribute('aria-label','Customized full SVG template preview');
    const caption=el('p',preview,'','production-note');
    const source=el('a',preview,'Open original SVG');source.target='_blank';source.rel='noopener';
    const paletteRoot=el('div',root,null,'production-palette');
    const componentRoot=el('div',root,null,'production-components');
    const warning=el('p',root,'','production-note production-artwork-warning');
    const actions=el('div',root,null,'production-actions');
    const message=el('p',root,'','production-status');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    let selected=library.list()[0], generation=0, disposed=false, draftStyle={}, sceneKey, savedSignature, savedPaletteSignature;
    let selectedComponentId=null, componentCanvas=null, componentStatus=null, isolationGeneration=0, previewOrientation='landscape';
    const styleDrafts=new Map();
    const draftKey=()=>JSON.stringify([sceneKey,selected.id]);
    const normalize=raw=>library.normalizeStyle(selected.id,raw);
    const reportError=error=>{message.textContent=error.message||String(error);message.classList.add('error');};
    function formError(error){
      ++generation;++isolationGeneration;apply.disabled=false;preview.setAttribute('aria-busy','false');
      if(componentCanvas)componentCanvas.hidden=true;reportError(error);
    }
    const apply=button(actions,'Apply full template to editing scene',async()=>{
      if(disposed)return;
      const scene=api.controlScene();
      if(scene&&scene.id!==sceneKey){
        refresh();reportError(new Error('The editing scene changed. Its saved palette is now shown; review it, then apply again.'));return;
      }
      const template=selected, operation=++generation;
      if(!scene){reportError(new Error('Choose an editing scene first.'));return;}
      const sceneId=scene.id, targetName=api.targetLabel(), capturedSignature=sceneSignature(scene);
      apply.disabled=true;preview.setAttribute('aria-busy','true');message.classList.remove('error');message.textContent='Preparing the complete artwork…';
      try{
        // A focused input may not have emitted change yet. Capture the visible
        // form values synchronously, without rebuilding or blurring controls.
        const style=readEditorInputs();
        draftStyle=style;styleDrafts.set(draftKey(),style);
        const ready=await library.load(template.id,{retry:true,style});
        if(disposed || generation!==operation)return;
        if(ready&&ready.state!=='ready')throw new Error(ready.error||'The complete SVG artwork is not ready.');
        const currentScene=api.controlScene();
        if(currentScene?.id!==sceneId)throw new Error('The editing scene changed while loading. Review the target, then apply again.');
        if(sceneSignature(currentScene)!==capturedSignature)
          throw new Error('The editing scene layout, template colours or extra overlays changed while loading. Review the scene, then apply again.');
        if(JSON.stringify(readEditorInputs())!==JSON.stringify(style))
          throw new Error('The SVG controls changed while loading. Review the current edits, then apply again.');
        showLoadedStyle(template,style);
        const result=await api.apply(template.id,sceneId,style);
        if(disposed || generation!==operation)return;
        if(!result)throw new Error('That editing scene is no longer available.');
        savedSignature=sceneSignature(api.controlScene());
        savedPaletteSignature=paletteSignature(api.controlScene());
        styleDrafts.delete(draftKey());
        message.textContent='Applied '+template.name+' to '+targetName+'.'+
          (result.dropped?' Released '+result.dropped+' source binding(s) that do not fit this template.':' Existing fitting source bindings were kept.')+
          ' Separate saved overlay assets were not changed.';
      }catch(error){if(!disposed && generation===operation)reportError(error);}
      finally{if(!disposed && generation===operation){apply.disabled=false;preview.setAttribute('aria-busy','false');}}
    });
    button(actions,'Remove full template artwork',()=>{
      if(disposed)return;
      ++generation;apply.disabled=false;
      try{const scene=api.controlScene();if(!scene)throw new Error('Choose an editing scene first.');
        const changed=api.clear(scene.id);
        if(changed===false && scene.fullTemplateId)throw new Error('The template removal could not be saved.');
        savedSignature=sceneSignature(scene);
        savedPaletteSignature=paletteSignature(scene);
        message.textContent=changed?'Removed template artwork from '+api.targetLabel()+'. Source layout and bindings are unchanged.':'No full template is selected in this scene.';
        message.classList.remove('error');
      }catch(error){reportError(error);}
    });
    function render(){
      if(disposed)return;
      ++isolationGeneration;if(componentCanvas)componentCanvas.hidden=true;
      ++generation;apply.disabled=false;
      // Detailed previews use the SVG itself; PNGs are only lightweight grid thumbnails.
      image.src=library.assetUrl(selected.svgArtwork||selected.original);source.href=library.assetUrl(selected.original);
      image.alt=selected.name+' · complete original SVG';
      image.classList.toggle('portrait',orientation.value==='portrait');
      styledCanvas.classList.toggle('portrait',orientation.value==='portrait');
      styledCanvas.width=orientation.value==='portrait'?540:960;styledCanvas.height=orientation.value==='portrait'?960:540;
      styledCanvas.hidden=true;image.hidden=false;preview.setAttribute('aria-busy','false');
      caption.textContent=selected.name+' · '+selected.frames.length+' source slot(s). '+
        (orientation.value==='portrait'?'The entire landscape design is letterboxed; nothing is cropped or rearranged.':'Native 16:9 SVG composition. Colour edits preserve the original vector geometry.');
      warning.textContent=selected.warning || 'Original design preserved. Assign your real sources to the template slots.';
      choices.forEach(([node,item])=>node.setAttribute('aria-pressed',String(item.id===selected.id)));
      message.classList.remove('error');
      message.textContent='Preview only · no scene changes.';
      if(Object.keys(draftStyle).length){
        const operation=generation, template=selected, style=copyStyle(draftStyle);
        // Applying waits on the same loader itself. Keep its button available
        // so a change-on-blur preview cannot consume the operator's click.
        preview.setAttribute('aria-busy','true');message.textContent='Preparing customized SVG preview…';
        library.load(template.id,{retry:true,style}).then(()=>{
          if(disposed||operation!==generation)return;
          showLoadedStyle(template,style);
          message.textContent='Customized SVG preview only · apply to save these changes to this scene.';
        }).catch(error=>{
          if(!disposed&&operation===generation)reportError(error);
        }).finally(()=>{if(!disposed&&operation===generation){apply.disabled=false;preview.setAttribute('aria-busy','false');}});
      }
    }
    function showLoadedStyle(template,style){
      if(!Object.keys(style).length){image.hidden=false;styledCanvas.hidden=true;return;}
      const ctx=styledCanvas.getContext('2d');
      if(!ctx)throw new Error('Canvas preview is unavailable.');
      ctx.fillStyle='#000';ctx.fillRect(0,0,styledCanvas.width,styledCanvas.height);
      const result=library.draw(template.id,ctx,styledCanvas,style);
      if(!result||result.state!=='drawn')throw new Error(result&&result.error||'Could not preview the customized SVG.');
      image.hidden=true;styledCanvas.hidden=false;
    }
    function readPaletteInputs({skipKeys=[]}={}){
      const values=copyStyle(draftStyle);
      for(const [key,input] of paletteInputs){
        if(skipKeys.includes(key)){delete values[key];continue;}
        if(input.type==='number'){
          const text=String(input.value).trim(), value=Number(text);
          if(!text||!Number.isFinite(value)||(input.validity&&input.validity.valid===false))
            throw new Error('Backdrop hue must be a valid number between -180 and 180 degrees.');
          values[key]=value;
        }else values[key]=input.value;
      }
      return normalize(values);
    }
    function readEditorInputs({skipPalette=[],skipComponent=[]}={}){
      const values=copyStyle(readPaletteInputs({skipKeys:skipPalette}));
      if(selectedComponentId&&componentInputs.size){
        const saved=values.components&&values.components[selectedComponentId]||{}, next=Object.assign({},saved);
        for(const [key,field] of componentInputs){
          if(skipComponent.includes(key)){delete next[key];continue;}
          const input=field.input;
          if(field.optional&&saved[key]===undefined&&input.value===field.initial&&!field.touched)continue;
          if(input.type==='checkbox')next[key]=input.checked;
          else if(input.type==='number'){
            const raw=String(input.value).trim(), value=Number(raw);
            if(!raw||!Number.isFinite(value)||(input.validity&&input.validity.valid===false))
              throw new Error('Enter a valid '+field.label.toLowerCase()+' for this SVG piece.');
            next[key]=value/field.divisor;
          }else next[key]=input.value;
        }
        if(next.text===undefined&&(next.textColor!==undefined||next.fontSize!==undefined||next.overflow!==undefined||next.overflowSpeed!==undefined)){
          const part=(selected.components||[]).find(item=>item.id===selectedComponentId);
          next.text=part&&typeof part.defaultText==='string'?part.defaultText:componentInputs.get('text').input.value;
        }
        values.components=Object.assign({},values.components,{[selectedComponentId]:next});
      }
      return normalize(values);
    }
    function updateStyle(key,value){
      try{
        const next=Object.assign({},readEditorInputs({skipPalette:[key]}),{[key]:value});
        draftStyle=normalize(next);styleDrafts.set(draftKey(),draftStyle);render();return true;
      }catch(error){formError(error);return false;}
    }
    function paletteControls(){
      paletteDisposers.splice(0).forEach(dispose=>dispose());
      paletteInputs.clear();
      paletteRoot.textContent='';
      el('h4',paletteRoot,'Customize this SVG');
      el('p',paletteRoot,'Changes are staged until Apply. Vector paint and backdrop hue preserve the original geometry; supported lettering can be replaced in SVG pieces below.','production-note');
      const fields=el('div',paletteRoot,null,'production-grid');
      for(const paint of selected.palette||[]){
        const label=el('label',fields,paint.label,'production-colour-field');
        const input=el('input',label);input.type='color';input.value=draftStyle[paint.key]||paint.defaultColor;
        paletteInputs.set(paint.key,input);
        input.setAttribute('aria-label',paint.label);on(input,'change',()=>updateStyle(paint.key,input.value),paletteDisposers);
      }
      if(selected.backgroundImageIds&&selected.backgroundImageIds.length){
        const field=el('label',paletteRoot,'Backdrop hue (−180 to 180°)','production-colour-field');
        const input=el('input',field);input.type='number';input.min='-180';input.max='180';input.step='0.01';
        input.value=String(draftStyle.backgroundHue||0);input.setAttribute('aria-label','Backdrop hue');
        paletteInputs.set('backgroundHue',input);
        on(input,'change',()=>updateStyle('backgroundHue',input.value.trim()===''?NaN:Number(input.value)),paletteDisposers);
      }
      const actions=el('div',paletteRoot,null,'production-actions');
      const brand=button(actions,'Use current brand colour',()=>{
        const role=(selected.palette||[]).find(paint=>paint.key==='accent'||paint.key==='frameStart');
        const colour=api.theme&&api.theme.getState().primaryColor;
        if(!role||!colour){message.textContent='This template has no compatible brand-colour field.';return;}
        if(updateStyle(role.key,colour))paletteControls();
      },paletteDisposers);
      brand.disabled=!api.theme||!(selected.palette||[]).some(paint=>paint.key==='accent'||paint.key==='frameStart');
      button(actions,'Reset template colours',()=>{
        try{setStyle(readEditorInputs({skipPalette:[...paletteInputs.keys()]}));}catch(error){formError(error);}
      },paletteDisposers);
    }
    function updateComponent(){
      try{draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);++isolationGeneration;
        if(componentCanvas)componentCanvas.hidden=true;render();}
      catch(error){formError(error);}
    }
    function componentControls(){
      ++isolationGeneration;componentDisposers.splice(0).forEach(dispose=>dispose());componentInputs.clear();
      componentRoot.textContent='';componentCanvas=null;componentStatus=null;
      const components=selected.components||[];componentRoot.hidden=!components.length;if(!components.length){selectedComponentId=null;return;}
      if(!components.some(part=>part.id===selectedComponentId))selectedComponentId=components[0].id;
      const part=components.find(part=>part.id===selectedComponentId), settings=draftStyle.components&&draftStyle.components[part.id]||{};
      el('h4',componentRoot,'SVG pieces · '+components.length);
      el('p',componentRoot,'Choose an original piece. Movement uses a percentage of the original board; scale stays centred on the piece. Changes are staged until Apply.','production-note');
      const pickerLabel=el('label',componentRoot,'SVG piece','production-component-selector'), picker=el('select',pickerLabel);
      picker.setAttribute('aria-label','SVG piece');
      for(const item of components){const option=el('option',picker,item.label||item.name||item.id);option.value=item.id;}
      picker.value=part.id;
      on(picker,'change',()=>{
        try{draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);selectedComponentId=picker.value;componentControls();render();}
        catch(error){picker.value=selectedComponentId;formError(error);}
      },componentDisposers);
      if(Number.isInteger(part.frameIndex))el('p',componentRoot,'Linked to source slot '+(part.frameIndex+1)+'. Its frame and source move together.','production-note');
      if(part.artwork&&!part.virtual){
        const link=el('a',componentRoot,'Open this original piece SVG','production-component-source');
        link.href=library.assetUrl(part.artwork);link.target='_blank';link.rel='noopener';
      }
      const grid=el('div',componentRoot,null,'production-component-fields');
      function field(key,label,type,value,{min,max,step='any',divisor=1,optional=false,choices=[]}={}){
        const wrap=el('label',grid,label,'production-component-field'), input=el(type==='textarea'?'textarea':type==='select'?'select':'input',wrap);
        if(!['textarea','select'].includes(type))input.type=type;
        if(type==='select')for(const [key,text] of choices){const option=el('option',input,text);option.value=key;}
        if(type==='checkbox')input.checked=value;else input.value=String(value);
        if(min!==undefined)input.min=String(min);if(max!==undefined)input.max=String(max);if(type==='number')input.step=step;
        const descriptor={input,label,divisor,optional,initial:input.value,touched:false};
        input.setAttribute('aria-label',label);componentInputs.set(key,descriptor);
        on(input,'change',()=>{descriptor.touched=true;updateComponent();},componentDisposers);return input;
      }
      field('visible','Show this piece','checkbox',settings.visible!==false);
      field('x','Horizontal offset (%)','number',(settings.x||0)*100,{min:-200,max:200,divisor:100});
      field('y','Vertical offset (%)','number',(settings.y||0)*100,{min:-200,max:200,divisor:100});
      field('scale','Piece scale (%)','number',(settings.scale===undefined?1:settings.scale)*100,{min:10,max:400,divisor:100});
      field('opacity','Piece opacity (%)','number',(settings.opacity===undefined?1:settings.opacity)*100,{min:0,max:100,divisor:100});
      if(part.editableText){
        const input=field('text','Replacement text','textarea',settings.text===undefined?part.defaultText||'':settings.text,{optional:true});input.maxLength=500;
        field('textColor','Replacement text colour','color',settings.textColor||part.defaultTextColor||'#ffffff',{optional:true});
        field('fontSize','Font size (template units)','number',settings.fontSize||part.defaultFontSize||32,{min:4,max:120,step:'0.01',optional:true});
        field('overflow','Text overflow','select',settings.overflow||'scroll',{optional:true,choices:[['scroll','Scroll overflowing text'],['clip','Clip at fixed size']]});
        field('overflowSpeed','Scroll speed (px/s)','number',settings.overflowSpeed||80,{min:1,max:600,step:'1',optional:true});
        el('p',componentRoot,'Text keeps the template size until you change it. Long text scrolls within its original box, or clips at the fixed size you choose. Original lettering stays untouched until edited.','production-note');
      }
      if(part.editableQr){
        field('target','QR destination (HTTP or HTTPS)','url',settings.target||'',{optional:true}).maxLength=1024;
        el('p',componentRoot,'Use a short link or enlarge the code for easier scanning. Generated locally; the link is never opened. Scan the final output size before going on air.','production-note');
      }
      if(part.description)el('p',componentRoot,part.description,'production-note');
      const actions=el('div',componentRoot,null,'production-actions');
      button(actions,'Reset this piece',()=>resetComponents(false),componentDisposers);
      button(actions,'Reset all pieces',()=>resetComponents(true),componentDisposers);
      if(part.editableText||part.editableQr)button(actions,part.editableText?'Use original lettering':'Use original QR artwork',()=>{
        try{setStyle(readEditorInputs({skipComponent:part.editableText?['text','textColor','fontSize','overflow','overflowSpeed']:['target']}));}
        catch(error){formError(error);}
      },componentDisposers);
      if(part.editableText)button(actions,'Restore template text size',()=>{
        try{setStyle(readEditorInputs({skipComponent:['fontSize']}));}catch(error){formError(error);}
      },componentDisposers);
      button(actions,'Preview this piece alone',previewComponent,componentDisposers);
      componentCanvas=el('canvas',componentRoot,null,'production-component-preview');componentCanvas.width=640;componentCanvas.height=360;componentCanvas.hidden=true;
      componentCanvas.setAttribute('role','img');componentCanvas.setAttribute('aria-label','Isolated SVG piece preview');
      componentStatus=el('p',componentRoot,'','production-status');componentStatus.setAttribute('role','status');
    }
    function resetComponents(all){
      try{const values=copyStyle(readPaletteInputs());
        if(all)delete values.components;
        else if(values.components){delete values.components[selectedComponentId];if(!Object.keys(values.components).length)delete values.components;}
        setStyle(values);
      }catch(error){formError(error);}
    }
    async function previewComponent(){
      if(disposed||!selectedComponentId)return;
      const operation=++isolationGeneration, template=selected, componentId=selectedComponentId, canvas=componentCanvas, status=componentStatus;
      try{
        draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);
        const transient=copyStyle(draftStyle);transient.components=transient.components||{};
        for(const part of template.components)transient.components[part.id]=Object.assign({},transient.components[part.id],{visible:part.id===componentId});
        const style=library.normalizeStyle(template.id,transient);status.textContent='Preparing isolated SVG piece…';canvas.hidden=true;
        await library.load(template.id,{style,retry:true});
        if(disposed||operation!==isolationGeneration)return;
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas preview is unavailable.');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        const result=library.draw(template.id,ctx,canvas,style);if(!result||result.state!=='drawn')throw new Error(result&&result.error||'Could not preview this SVG piece.');
        canvas.hidden=false;status.textContent='Isolated preview only. The full template keeps every staged visibility setting.';status.classList.remove('error');
      }catch(error){if(!disposed&&operation===isolationGeneration){status.textContent=error.message||String(error);status.classList.add('error');}}
    }
    function paletteSignature(scene){return JSON.stringify([scene&&scene.id,scene&&scene.fullTemplateId,scene&&scene.fullTemplateStyle]);}
    function sceneSignature(scene){return JSON.stringify([scene&&scene.id,scene&&scene.layout,scene&&scene.fullTemplateId,scene&&scene.fullTemplateStyle,scene&&scene.fullTemplateExtras,
      scene&&scene.svgParts,scene&&scene.svgPartsMode,scene&&scene.svgPartsExtras]);}
    function readStyle(scene){
      const raw=styleDrafts.get(draftKey())||(scene&&scene.fullTemplateId===selected.id&&scene.fullTemplateStyle)||{};
      try{draftStyle=Object.keys(raw).length?normalize(raw):{};return null;}
      catch(error){draftStyle={};return error;}
    }
    function refresh(){
      if(disposed)return;
      const scene=api.controlScene(), key=scene&&scene.id||null, signature=sceneSignature(scene);
      if(key===sceneKey&&signature===savedSignature)return;
      const changed=key!==sceneKey, paletteChanged=paletteSignature(scene)!==savedPaletteSignature;
      sceneKey=key;savedSignature=signature;
      savedPaletteSignature=paletteSignature(scene);
      const current=scene&&library.list().find(item=>item.id===scene.fullTemplateId);
      if(changed&&current)selected=current;
      // External changes to the selected saved palette supersede an old local draft.
      if(!changed&&paletteChanged&&current&&current.id===selected.id)styleDrafts.delete(draftKey());
      const error=readStyle(scene);paletteControls();componentControls();render();if(error)reportError(error);
    }
    function select(id){
      if(disposed)return false;
      const item=library.list().find(item=>item.id===id);
      if(!item){reportError(new Error('That full SVG template is unavailable.'));return false;}
      try{draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);}
      catch(error){formError(error);return false;}
      refresh();selected=item;
      const error=readStyle(api.controlScene());paletteControls();componentControls();render();if(error)reportError(error);
      return !error;
    }
    function setStyle(raw){
      if(disposed)return false;
      try{draftStyle=normalize(copyStyle(raw));styleDrafts.set(draftKey(),draftStyle);paletteControls();componentControls();render();return true;}
      catch(error){formError(error);return false;}
    }
    function selectComponent(id){
      if(disposed||!(selected.components||[]).some(part=>part.id===id))return false;
      try{draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);selectedComponentId=id;componentControls();render();return true;}
      catch(error){formError(error);return false;}
    }
    function selectComponentKind(kind){
      const aliases={logo:['logo','logo-emblem','logo-identity'],headline:['headline','ticker-text','ticker-label'],
        'live-badge':['live-badge','streaming-live'],frame:['frame','feed-frame','feed']};
      const parts=selected.components||[], types=aliases[kind]||[kind];
      // A ticker may precede the headline in native paint order. Prefer the
      // requested piece/type before considering related fallback categories.
      const part=parts.find(item=>item.id===kind)||parts.find(item=>(item.type||item.kind)===kind)||
        types.map(type=>parts.find(item=>item.id===type||(item.type||item.kind)===type)).find(Boolean);
      return !!part&&selectComponent(part.id);
    }
    for(const item of library.list()){
      const node=button(grid,'',()=>select(item.id));node.setAttribute('aria-label','Preview full '+item.name);
      const thumb=el('img',node);thumb.src=library.assetUrl(item.thumbnail);thumb.alt='';thumb.loading='lazy';thumb.decoding='async';
      el('span',node,item.name);choices.push([node,item]);
    }
    on(image,'error',()=>{if(!disposed&&!Object.keys(draftStyle).length)reportError(new Error('The original SVG preview could not be loaded. Check the local artwork files, then choose the template again.'));});
    on(orientation,'change',()=>{
      try{draftStyle=readEditorInputs();styleDrafts.set(draftKey(),draftStyle);previewOrientation=orientation.value;render();}
      catch(error){orientation.value=previewOrientation;formError(error);}
    });refresh();
    const result={select,selectComponent,selectComponentKind,refresh,setStyle,getSelection:()=>({id:selected.id,style:copyStyle(draftStyle)}),
      destroy(){if(disposed)return;disposed=true;++generation;
        disposers.splice(0).forEach(dispose=>dispose());paletteDisposers.splice(0).forEach(dispose=>dispose());
        componentDisposers.splice(0).forEach(dispose=>dispose());componentInputs.clear();++isolationGeneration;
        styleDrafts.clear();paletteInputs.clear();image.removeAttribute('src');root.remove();mounted.delete(doc);}};
    mounted.set(doc,result);return result;
  }
  return Object.freeze({mount});
})();
