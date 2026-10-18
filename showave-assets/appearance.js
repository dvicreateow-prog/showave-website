/* Website colour preferences. Palette names and base/accent pairs match the
   installed SHOWAVE preview. Website storage is separate from app preferences. */
(() => {
  'use strict';
  if (window.ShowaveAppearance) return;
  const KEY = 'showave.website.appearance.v1';
  const SOURCE_VERSION = '0.1.0-preview.14';
  const rows = [
    ['gx-classic','GX Classic','#FA1E4E','#251F33','#FA1E4E','#E6E3ED'],
    ['ultraviolet','Ultraviolet','#7D46F2','#101015','#8635FF','#E3E4F1'],
    ['sub-zero','Sub Zero','#4461EE','#0C0C0E','#1652E9','#D8E0E4'],
    ['frutti-di-mare','Frutti Di Mare','#FF7070','#181E39','#FF5959','#E2E1EF'],
    ['purple-haze','Purple Haze','#AEFF3C','#09060B','#2CB40D','#E8E5EB'],
    ['vaporwave','Vaporwave','#00E5C3','#1C121C','#5540BF','#EDE3EC'],
    ['rose-quartz','Rose Quartz','#FF708D','#271723','#EB4E9A','#F9ECF0'],
    ['coming-soon','Coming Soon','#EEDE00','#173235','#00A4CD','#E3ECEE'],
    ['hackerman','Hackerman','#00ED3B','#1B221D','#009D5E','#E4ECEA'],
    ['lambda','Lambda','#FF9900','#2D3432','#F07C00','#E7E9E8'],
    ['after-eight','After Eight','#5AEDBC','#2E2824','#00A870','#ECE8E4'],
    ['pay-to-win','Pay-To-Win','#F6C955','#201D19','#E79F03','#ECE9E4'],
    ['white-wolf','White Wolf','#CCCCCC','#292929','#292929','#E8E8E8'],
    ['underwave','Underwave','#5E65CC','#121221','#4937E8','#CFD1ED'],
    ['drive-by','Drive-by','#B4F3C9','#141F1D','#20A732','#31343F'],
    ['custom','Custom','#0A84FF','#000000','#007AFF','#E5E5EA']
  ];
  const palettes = Object.freeze(rows.map(([id,name,da,db,la,lb]) => Object.freeze({
    id,name,dark:Object.freeze({accent:da,base:db}),light:Object.freeze({accent:la,base:lb})
  })));
  const lookup = new Map(palettes.map(p => [p.id,p]));
  const root = document.documentElement;
  const defaultCustom = {dark:{accent:'#0A84FF',base:'#000000'},light:{accent:'#007AFF',base:'#E5E5EA'}};
  const clone = value => JSON.parse(JSON.stringify(value));
  const hex = (value,fallback) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value.toUpperCase() : fallback;
  function normalise(value) {
    if (!value || typeof value !== 'object' || !lookup.has(value.theme) || !['light','dark'].includes(value.mode)) return null;
    const custom = {};
    ['dark','light'].forEach(mode => { custom[mode] = {
      base:hex(value.custom?.[mode]?.base,defaultCustom[mode].base),
      accent:hex(value.custom?.[mode]?.accent,defaultCustom[mode].accent)
    }; });
    return {version:1,theme:value.theme,mode:value.mode,custom};
  }
  const rgb = value => value.slice(1).match(/../g).map(x => parseInt(x,16));
  const mix = (a,b,w) => '#' + rgb(a).map((c,i) => Math.round(c + (rgb(b)[i]-c)*w).toString(16).padStart(2,'0')).join('').toUpperCase();
  const luminance = value => rgb(value).map(x => { x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4; }).reduce((v,x,i) => v+x*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  const bestInk = base => contrast(base,'#0B0C10')>=contrast(base,'#F6F7FA')?'#0B0C10':'#F6F7FA';
  function readable(color,ink,surfaces,target=4.5) {
    for(let step=0;step<=256;step++) { const value=mix(color,ink,step/256);if(surfaces.every(s => contrast(value,s)>=target))return value; }
    return ink;
  }
  function resolve(input) {
    const value=normalise(input);if(!value)return null;
    const pair=value.theme==='custom'?value.custom[value.mode]:lookup.get(value.theme)[value.mode];
    const {base,accent}=pair;let ink=bestInk(base);const light=ink==='#0B0C10';
    // These surfaces use the same base mixes as the installed appearance engine.
    let surface=mix(base,'#F6F7FA',light?.18:.075);
    let panel=mix(base,light?'#0B0C10':'#F6F7FA',light?.045:.12);
    let inset=mix(base,'#0B0C10',light?.08:.20);
    let surfaces=[base,surface,panel,inset];
    // Arbitrary Custom mid-greys can straddle both ink directions. Keep the
    // selected base exact while deriving supporting surfaces in one direction.
    if(!surfaces.every(s => contrast(ink,s)>=4.5)) {
      ink=contrast(base,'#000000')>=contrast(base,'#FFFFFF')?'#000000':'#FFFFFF';
      const toward=ink==='#000000'?'#FFFFFF':'#000000';
      surface=mix(base,toward,.075);panel=mix(base,toward,.12);inset=mix(base,toward,.03);
      surfaces=[base,surface,panel,inset];
    }
    const muted=readable(mix(base,ink,.58),ink,surfaces);
    const link=readable(accent,ink,surfaces);
    let accentInk=bestInk(accent);
    if(contrast(accentInk,accent)<4.5)accentInk=contrast(accent,'#000000')>=contrast(accent,'#FFFFFF')?'#000000':'#FFFFFF';
    return {base,accent,surface,panel,inset,ink,muted,link,accentInk,line:mix(base,ink,.26),scheme:ink==='#0B0C10'||ink==='#000000'?'light':'dark'};
  }
  let state=null,storageOK=true,dialog,trigger,status,paletteSelect,customFields;
  let originalMeta;
  const variables=['base','accent','surface','panel','inset','ink','muted','link','accentInk','line'];
  try {state=normalise(JSON.parse(localStorage.getItem(KEY)||'null'));}catch(_){storageOK=false;}
  function paint() {
    const colors=resolve(state);
    if(!colors) {
      root.removeAttribute('data-showave-appearance');root.removeAttribute('data-showave-scheme');
      variables.forEach(key => root.style.removeProperty('--sw-'+key));
      root.style.removeProperty('color-scheme');
    } else {
      root.dataset.showaveAppearance=state.theme;root.dataset.showaveScheme=colors.scheme;
      variables.forEach(key => root.style.setProperty('--sw-'+key,colors[key]));
      root.style.colorScheme=colors.scheme;
    }
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta) {if(originalMeta===undefined)originalMeta=meta.content;if(colors)meta.content=colors.base;else if(originalMeta!==undefined)meta.content=originalMeta;}
    updateControls();
  }
  function save() {
    try {if(state)localStorage.setItem(KEY,JSON.stringify(state));else localStorage.removeItem(KEY);storageOK=true;}
    catch(_){storageOK=false;}
    paint();window.dispatchEvent(new CustomEvent('showave:appearancechange',{detail:{state:state?clone(state):null}}));
    return state?clone(state):null;
  }
  function setState(value) {
    const next=normalise({...{theme:'custom',mode:'dark',custom:defaultCustom},...(state||{}),...value});
    if(!next)throw new Error('Choose an available SHOWAVE palette and Light or Dark.');
    state=next;return save();
  }
  function reset(){state=null;save();}
  function updateControls() {
    if(!dialog)return;
    const current=state||{theme:'custom',mode:'dark',custom:defaultCustom};
    paletteSelect.value=current.theme;
    dialog.querySelectorAll('[data-appearance-mode]').forEach(button => button.setAttribute('aria-pressed',String(!!state&&button.dataset.appearanceMode===current.mode)));
    customFields.hidden=current.theme!=='custom';
    ['base','accent'].forEach(key => {const input=dialog.querySelector('[data-appearance-color="'+key+'"]');input.value=current.custom[current.mode][key];input.nextElementSibling.textContent=input.value.toUpperCase();});
    const colors=resolve(current);
    dialog.querySelectorAll('[data-appearance-swatch]').forEach(node => {node.style.backgroundColor=colors[node.dataset.appearanceSwatch];});
    status.textContent=state ? lookup.get(state.theme).name+' · '+(state.mode==='dark'?'Dark':'Light')+(storageOK?' · Saved in this browser.':' · Browser storage is unavailable.') : 'Original website appearance.';
    trigger.setAttribute('aria-label','Appearance'+(state?': '+lookup.get(state.theme).name+', '+state.mode:''));
  }
  function mount() {
    if(document.getElementById('showave-appearance'))return;
    trigger=document.createElement('button');trigger.type='button';trigger.className='showave-appearance-trigger';
    trigger.setAttribute('aria-label','Appearance');trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','showave-appearance');
    trigger.innerHTML='<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor"/></svg><span>Appearance</span>';
    const host=document.querySelector('.site-header .header-actions')||document.querySelector('.header-inner .header-act')||document.querySelector('.site-header');
    if(host) {
      const secondary=document.querySelector('.hub-subnav');
      const narrow=window.matchMedia('(max-width: 350px)');
      const place=()=>{const target=narrow.matches&&secondary?secondary:host;target.prepend(trigger);};
      place();narrow.addEventListener('change',place);
    } else {trigger.classList.add('showave-appearance-fallback');document.body.append(trigger);}
    dialog=document.createElement('dialog');dialog.id='showave-appearance';dialog.className='showave-appearance';dialog.setAttribute('aria-labelledby','showave-appearance-title');
    dialog.innerHTML='<div class="appearance-heading"><h2 id="showave-appearance-title">Appearance</h2><button type="button" class="appearance-close" aria-label="Close appearance">×</button></div><p class="appearance-intro">The same color palettes as SHOWAVE. Your choice stays in this browser.</p><div class="appearance-modes" role="group" aria-label="Color mode"><button type="button" data-appearance-mode="dark" aria-pressed="false">Dark</button><button type="button" data-appearance-mode="light" aria-pressed="false">Light</button></div><label class="appearance-palette-label" for="showave-appearance-palette">Color palette</label><select id="showave-appearance-palette"></select><div class="appearance-preview" aria-hidden="true"><i data-appearance-swatch="base"></i><i data-appearance-swatch="surface"></i><i data-appearance-swatch="accent"></i><span>SHOWAVE</span></div><fieldset class="appearance-custom"><legend>Custom colors</legend><label><b>Background</b><input type="color" data-appearance-color="base"><span></span></label><label><b>Accent</b><input type="color" data-appearance-color="accent"><span></span></label></fieldset><p class="appearance-status" role="status"></p><div class="appearance-bottom"><button type="button" class="appearance-reset">Original website</button><button type="button" class="appearance-done">Done</button></div>';
    document.body.append(dialog);paletteSelect=dialog.querySelector('select');customFields=dialog.querySelector('fieldset');status=dialog.querySelector('[role="status"]');
    palettes.forEach(p => {const option=document.createElement('option');option.value=p.id;option.textContent=p.name;paletteSelect.append(option);});
    trigger.addEventListener('click',()=> {paint();dialog.showModal();});
    dialog.querySelectorAll('.appearance-close,.appearance-done').forEach(b => b.addEventListener('click',()=>dialog.close()));
    dialog.addEventListener('close',()=>trigger.focus({preventScroll:true}));
    dialog.addEventListener('click',event => {if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
    dialog.querySelectorAll('[data-appearance-mode]').forEach(b => b.addEventListener('click',()=>setState({mode:b.dataset.appearanceMode})));
    paletteSelect.addEventListener('change',()=>setState({theme:paletteSelect.value}));
    dialog.querySelectorAll('[data-appearance-color]').forEach(input => input.addEventListener('input',()=> {const custom=clone(state?.custom||defaultCustom);custom[state?.mode||'dark'][input.dataset.appearanceColor]=input.value;setState({theme:'custom',custom});}));
    dialog.querySelector('.appearance-reset').addEventListener('click',reset);paint();
  }
  window.addEventListener('storage',event => {if(event.key!==KEY&&event.key!==null)return;try {state=normalise(JSON.parse(event.newValue||'null'));}catch(_){state=null;}paint();});
  window.ShowaveAppearance=Object.freeze({SOURCE_VERSION,KEY,palettes,getState:()=>state?clone(state):null,setState,reset,resolve,contrast});
  paint();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
