/* One shared dock for the existing scene panels and their draft editors. */
window.OpenLiveSceneToolDock=(()=>{
  'use strict';
  function mount({root,studio,getContext,onChange}){
    const doc=root.ownerDocument||document,entries=new Map(),homes=new Map();
    const originalDraftClass=root.classList.contains('has-draft');
    let active=null,draft=null,serial=0,destroyed=false;
    const context=()=>getContext?.()||{};
    const available=value=>!destroyed&&root.isConnected!==false&&!!value.scene&&!!value.enabled&&!value.scene.layoutPending&&studio.scenes().includes(value.scene);
    const matches=(owner,value)=>available(value)&&value.scene===owner.scene&&value.key===owner.key&&value.mode===owner.mode&&value.scene.layout===owner.layout;
    const snapshot=()=>active?{id:active.id,scene:active.scene,key:active.key,mode:active.mode,opener:active.opener,editorId:draft?.editorId||null,ticket:active.ticket,draftTicket:draft?.ticket||null}:null;
    const notify=()=>onChange?.(snapshot());
    function remember(node){
      if(homes.has(node))return;
      const parent=node.parentNode,next=node.nextSibling,anchor=parent&&doc.createComment?doc.createComment('scene tool dock'):null;
      if(anchor)parent.insertBefore(anchor,node);
      homes.set(node,{parent,next,anchor,className:node.className,hidden:node.hidden,role:node.getAttribute('role'),modal:node.getAttribute('aria-modal')});
    }
    function region(node,{draftForm=false}={}){
      remember(node);node.setAttribute('role','region');
      if(draftForm)node.setAttribute('aria-modal','false');else node.removeAttribute('aria-modal');
    }
    function draftRegions(node){
      const forms=node.tagName==='FORM'?[node]:[...(node.querySelectorAll?.('form')||[])];
      for(const form of forms.length?forms:[node])region(form,{draftForm:true});
    }
    function clear({panelCallback=false,draftCallback=true,change=true}={}){
      const previous=active,previousDraft=draft;if(!previous)return false;
      active=null;draft=null;serial++;root.classList.remove('has-draft');
      previous.entry.panel.hidden=true;if(previousDraft)previousDraft.editor.node.hidden=true;
      // Root close handlers may call back into close/closeDraft. The old owner
      // must already be gone before they cancel their scene-owned drafts.
      try{if(previousDraft&&draftCallback)previousDraft.editor.close?.({focus:false});}
      finally{try{if(panelCallback)previous.entry.close?.({focus:false});}finally{if(change)notify();}}
      return true;
    }
    function register(id,{panel,close,editors=[]}={}){
      if(destroyed||typeof id!=='string'||!id||!panel||entries.has(id))return false;
      remember(panel);const registered=new Map();
      for(const editor of editors){
        if(!editor||typeof editor.id!=='string'||!editor.id||!editor.node||registered.has(editor.id))continue;
        remember(editor.node);registered.set(editor.id,{id:editor.id,node:editor.node,close:editor.close});
      }
      entries.set(id,{panel,close,editors:registered});return true;
    }
    function open(id,{opener=doc.activeElement}={}){
      const entry=entries.get(id),requested=context();if(!entry||!available(requested))return false;
      const requestedLayout=requested.scene.layout;
      if(active?.id===id&&matches(active,requested)){entry.panel.hidden=false;return true;}
      if(active)clear({panelCallback:true});
      // A close handler can change Preview selection. Do not transfer the new
      // request into that different scene or layer after the handoff.
      const value=context();if(!available(value)||value.scene!==requested.scene||value.key!==requested.key||value.mode!==requested.mode||value.scene.layout!==requestedLayout)return false;
      active={id,entry,scene:value.scene,key:value.key,mode:value.mode,layout:value.scene.layout,opener,ticket:++serial};
      root.append(entry.panel);entry.panel.classList.add('bc-layer-tool-panel');region(entry.panel);entry.panel.hidden=false;root.classList.remove('has-draft');notify();return true;
    }
    function current(id,editorId){
      if(!active||active.id!==id||!matches(active,context()))return false;
      return editorId===undefined||!!draft&&draft.editorId===editorId&&matches(draft,context());
    }
    function close(id){if(!active||id!==active.id)return false;return clear();}
    function openDraft(id,editorId){
      if(!current(id))return false;const editor=active.entry.editors.get(editorId);if(!editor)return false;
      if(draft?.editorId===editorId&&matches(draft,context()))return true;
      if(draft){const previous=draft;draft=null;previous.editor.node.hidden=true;root.classList.remove('has-draft');previous.editor.close?.({focus:false});if(!current(id))return false;}
      draft={editorId,editor,scene:active.scene,key:active.key,mode:active.mode,layout:active.layout,ticket:++serial};
      root.append(editor.node);editor.node.classList.add('bc-layer-tool-draft');draftRegions(editor.node);editor.node.hidden=false;active.entry.panel.hidden=false;root.classList.add('has-draft');notify();return true;
    }
    function closeDraft(editorId){
      if(!draft||draft.editorId!==editorId)return false;const previous=draft;draft=null;serial++;previous.editor.node.hidden=true;root.classList.remove('has-draft');if(active)active.entry.panel.hidden=false;notify();return true;
    }
    function refresh(){
      if(!active)return false;
      const value=context();if(!matches(active,value)||draft&&!matches(draft,value)){clear({panelCallback:true});return false;}return true;
    }
    function destroy(){
      if(destroyed)return;destroyed=true;
      try{clear({panelCallback:true,change:false});}
      finally{
        for(const [node,home] of homes){
          if(home.parent){const anchor=home.anchor?.parentNode===home.parent?home.anchor:home.next?.parentNode===home.parent?home.next:null;home.parent.insertBefore(node,anchor);}
          else node.remove();
          node.className=home.className;node.hidden=home.hidden;
          for(const [name,value] of [['role',home.role],['aria-modal',home.modal]])value===null?node.removeAttribute(name):node.setAttribute(name,value);
          home.anchor?.remove();
        }
        root.classList.toggle('has-draft',originalDraftClass);entries.clear();homes.clear();active=null;draft=null;serial++;
      }
    }
    return {register,open,close,openDraft,closeDraft,current,refresh,state:snapshot,destroy};
  }
  return Object.freeze({mount});
})();
