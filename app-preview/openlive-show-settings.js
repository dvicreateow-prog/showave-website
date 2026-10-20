/* Linked Show setup views. The engine/connected Composition owns the values;
   this module owns no document, storage, or second editable draft. */
(function(root){
'use strict';
const fields=Object.freeze({
  name:{label:'Name',target:'name'},
  description:{label:'Description',target:'description'},
  size:{label:'Size',target:'width'},
  frameRate:{label:'Frame rate',target:'frameRate'},
  bitDepth:{label:'Color depth',target:'bitDepth'}
});
const esc=value=>String(value??'').replace(/[<>&"]/g,ch=>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
function value(state,key){
  if(!state) return 'Loading…';
  if(state.live&&['description','frameRate','bitDepth'].includes(key)) return 'Not exposed by Arena';
  if(key==='size') return state.width!==''&&state.height!==''
    ? `${state.width} × ${state.height}` : 'Not exposed by Arena';
  if(key==='bitDepth') return `${state.bitDepth} bpc${state.bitDepth===16?' · output is 8 bpc':''}`;
  if(key==='frameRate') return state.frameRate==='Auto'?'Auto':`${state.frameRate} fps`;
  return String(state[key]??'')||(key==='description'?'No description':'Untitled');
}
function render(state,keys){
  return keys.map(key=>{
    const field=fields[key];
    if(!field) throw new Error('Unknown Show setting: '+key);
    return `<div class="prow show-setting-mirror${key==='description'?' multiline':''}">
      <div class="tw"></div><span class="plab">${field.label}</span>
      <button type="button" class="wide show-setting-link" data-show-setting-open="${field.target}"
        aria-label="${field.label}: open Show Settings" title="Shared Show setting: edit once in Show Settings">
        <span data-show-setting-value="${key}">${esc(value(state,key))}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3h8v8M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
      </button></div>`;
  }).join('');
}
function sync(root,state){
  root.querySelectorAll('[data-show-setting-value]').forEach(el=>{
    const next=value(state,el.dataset.showSettingValue);
    if(el.textContent!==next) el.textContent=next;
  });
}
function bind(root,open){
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-show-setting-open]');
    if(!button||!root.contains(button)) return;
    event.preventDefault();
    open(button.dataset.showSettingOpen);
  });
}
/* A modal opened earlier must not write its stale untouched values back over
   a mapped/external edit. Conflicting edits require reopening, not guessing. */
function patch(draft,baseline,current){
  if(!baseline||!current||!!baseline.live!==!!current.live)
    throw new Error('The Show connection changed. Reopen Show Settings before applying.');
  const changes={};
  for(const key of ['name','description','width','height','frameRate']){
    if(!Object.prototype.hasOwnProperty.call(draft,key)) continue;
    const equal=(a,b)=>String(a??'')===String(b??'');
    if(equal(draft[key],baseline[key])||equal(draft[key],current[key])) continue;
    if(!equal(baseline[key],current[key]))
      throw new Error(`${key==='frameRate'?'Frame rate':key[0].toUpperCase()+key.slice(1)} changed elsewhere. Reopen Show Settings to review the current value.`);
    changes[key]=draft[key];
  }
  return changes;
}
const api=Object.freeze({render,sync,bind,value,patch});
if(typeof module==='object'&&module.exports) module.exports=api;
else root.OpenLiveShowSettings=api;
})(typeof window==='object'?window:globalThis);
