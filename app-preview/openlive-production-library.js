/* General production layouts, specialised cues, and data graphics share Studio controls. */
window.OpenLiveProductionLibrary=(()=>{
  'use strict';
  const scriptUrl=document.currentScript?.src;
  const names={'svg-1':'News desk','svg-2':'Idea Hub','svg-3':'Smart Move','svg-4':'Programme + QR','svg-5':'Live background','svg-6':'Presenter + presentation','svg-7':'Presentation + inset','svg-8':'Four feeds','svg-9':'Six feeds'};
  function mount({studio,root,getScene,getSelection,enabled=()=>true,onChange,onSelectSource,onSelectScene,onSelectTemplate}){
    const doc=root.ownerDocument,make=(tag,parent,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;parent.appendChild(node);return node;};
    const shell=make('section',root,undefined,'bc-production-library');shell.setAttribute('aria-label','Production library');
    const header=make('header',shell,undefined,'mon-head bc-production-head');make('span',header,'Production library');make('span',header,'Preview');
    const nav=make('div',shell,undefined,'ptabs bc-production-nav');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Production collections');
    const body=make('div',shell,undefined,'bc-production-body');body.setAttribute('role','tabpanel');
    let tab='templates',child=null,destroyed=false,scene=null;
    const live=()=>!destroyed&&(typeof enabled==='function'?enabled():enabled!==false);
    const buttons={};
    function clear(){child?.destroy();child=null;body.replaceChildren();}
    function button(parent,label,fn,cls='btn'){
      const node=make('button',parent,label,cls);node.type='button';node.addEventListener('click',()=>{if(!node.disabled&&shell.contains(node)&&live())fn();});return node;
    }
    function templates(){
      const catalog=window.OpenLiveFullTemplates?.list?.()||[];
      make('p',body,catalog.length?'Choose a native layout for any production. Edit its text, artwork and source frames in the template workspace.':'No bundled sample designs are included. Use New in Scenes to create a blank scene, then add your own sources and artwork.','bc-production-note');
      const heading=make('header',body,undefined,'mon-head bc-production-head');
      make('span',heading,'Native layouts');make('span',heading,catalog.length+' designs');
      const grid=make('div',body,undefined,'bc-production-template-grid');grid.setAttribute('aria-label','Native production layout templates');
      for(const item of catalog){
        const label=names[item.id]||item.label||item.name||item.id;
        const card=button(grid,'',()=>{if(!onSelectTemplate)return;onSelectTemplate(item.id);},'btn bc-production-template');card.setAttribute('aria-label','Open '+label+' template');
        if(item.thumbnail){const image=make('img',card);image.src=scriptUrl?new URL(item.thumbnail,scriptUrl).href:item.thumbnail;image.alt='';image.loading='lazy';image.decoding='async';}
        const feeds=item.frameCount??item.frames?.length??0;
        make('span',card,label);make('small',card,feeds+' feed'+(feeds===1?'':'s'));
        card.disabled=!live()||!getScene()||!onSelectTemplate;card.title=onSelectTemplate?'Open the existing native template editor':'Template editor is unavailable.';
      }
      const footer=make('div',body,undefined,'bc-production-footer');
      button(footer,'Live polls & questions',()=>{show('charts');child?.show?.('live');});
      make('p',footer,'Audience results and charts become editable sources: move, crop, hide, lock or remove them in Sources.','bc-production-note');
    }
    function draw(){
      clear();scene=getScene();
      for(const [value,node] of Object.entries(buttons)){node.classList.toggle('active',value===tab);node.setAttribute('aria-selected',String(value===tab));node.tabIndex=value===tab?0:-1;}
      if(tab==='templates')templates();
      else{
        const module=tab==='sports'?window.OpenLiveSportsLibrary:window.OpenLiveAudienceEditor;
        child=module?.mount({studio,root:body,getScene,getSelection,enabled:live,onChange,onSelectSource,onSelectScene,initialView:'cues'});
        if(tab==='charts')child?.show?.('charts');
        if(!child)make('p',body,'This collection is unavailable. Reload the updated application.','bc-production-note');
      }
    }
    function show(value){if(!['templates','sports','charts'].includes(value)||destroyed)return;tab=value;draw();}
    for(const [value,label] of [['templates','Templates'],['sports','Sports'],['charts','Charts']]){
      const node=button(nav,label,()=>show(value),'ptab');node.setAttribute('role','tab');buttons[value]=node;
      node.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const values=Object.keys(buttons),index=values.indexOf(tab);show(event.key==='Home'?values[0]:event.key==='End'?values.at(-1):values[(index+(event.key==='ArrowLeft'?-1:1)+values.length)%values.length]);buttons[tab].focus();});
    }
    draw();
    return {show,refresh(){if(destroyed)return;if(tab==='templates'){if(getScene()!==scene)draw();else for(const node of body.querySelectorAll('button'))node.disabled=!live()||!getScene()||!onSelectTemplate;}else child?.refresh();},destroy(){if(destroyed)return;destroyed=true;clear();shell.remove();}};
  }
  return Object.freeze({mount});
})();
