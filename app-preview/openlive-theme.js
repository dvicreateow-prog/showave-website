/* ===========================================================================
   openlive-theme.js — one persistent visual language for SHOWAVE Studio.

   Theme is show-level state. It is intentionally independent from scenes and
   asset libraries: changing scene, showing a saved caption, or arming a QR card
   must not quietly change the broadcast's visual identity. Renderers ask this
   module for the current profile on every programme frame, so a change reaches
   the captured canvas immediately.

   Air deliberately has no editable primary colour. The saved colour is kept in
   state while Air is selected so switching back to a coloured theme restores
   the operator's brand choice instead of discarding it.

   Classic script. Publishes window.OpenLiveTheme. No network or libraries.
   =========================================================================== */
window.OpenLiveTheme = (() => {
  'use strict';

  const STORE_BASE = 'showave.studio.theme.v1';
  const draftContext = window.OpenLiveStudioDraftContext || null;
  const STORE = draftContext && draftContext.error ? ''
    : draftContext && typeof draftContext.key === 'function' ? draftContext.key(STORE_BASE)
    : STORE_BASE;
  const PRESETS = Object.freeze(['air', 'base', 'news', 'round']);
  const DEFAULT_STATE = Object.freeze({
    version: 1,
    preset: 'base',
    primaryColor: '#3FDDAA',
    fontId: 'default',
    templateId: 'classic',
    logoPlacement: 'saved',
    tickerLabel: 'NEWS'
  });
  const LOCAL_FONTS = Object.freeze([
    Object.freeze({ id:'default', label:'Default', family:'system-ui, -apple-system, "Segoe UI", sans-serif' }),
    Object.freeze({ id:'arial', label:'Arial', family:'Arial, Helvetica, sans-serif' }),
    Object.freeze({ id:'avenir', label:'Avenir', family:'Avenir, "Avenir Next", "Segoe UI", sans-serif' }),
    Object.freeze({ id:'baskerville', label:'Baskerville', family:'Baskerville, Georgia, serif' }),
    Object.freeze({ id:'century-gothic', label:'Century Gothic', family:'"Century Gothic", CenturyGothic, Arial, sans-serif' }),
    Object.freeze({ id:'courier-new', label:'Courier New', family:'"Courier New", Courier, monospace' }),
    Object.freeze({ id:'franklin-gothic', label:'Franklin Gothic', family:'"Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif' }),
    Object.freeze({ id:'futura', label:'Futura', family:'Futura, "Trebuchet MS", Arial, sans-serif' }),
    Object.freeze({ id:'garamond', label:'Garamond', family:'Garamond, Georgia, serif' }),
    Object.freeze({ id:'georgia', label:'Georgia', family:'Georgia, "Times New Roman", serif' }),
    Object.freeze({ id:'gill-sans', label:'Gill Sans', family:'"Gill Sans", "Gill Sans MT", Calibri, sans-serif' }),
    Object.freeze({ id:'helvetica', label:'Helvetica', family:'Helvetica, Arial, sans-serif' }),
    Object.freeze({ id:'impact', label:'Impact', family:'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' }),
    Object.freeze({ id:'league-spartan', label:'League Spartan', family:'"League Spartan", Arial, sans-serif' }),
    Object.freeze({ id:'lucida-sans', label:'Lucida Sans', family:'"Lucida Sans Unicode", "Lucida Grande", sans-serif' }),
    Object.freeze({ id:'optima', label:'Optima', family:'Optima, Candara, "Segoe UI", sans-serif' }),
    Object.freeze({ id:'palatino', label:'Palatino', family:'Palatino, "Palatino Linotype", Georgia, serif' }),
    Object.freeze({ id:'rockwell', label:'Rockwell', family:'Rockwell, "Courier New", serif' }),
    Object.freeze({ id:'segoe-ui', label:'Segoe UI', family:'"Segoe UI", system-ui, sans-serif' }),
    Object.freeze({ id:'tahoma', label:'Tahoma', family:'Tahoma, Verdana, sans-serif' }),
    Object.freeze({ id:'times-new-roman', label:'Times New Roman', family:'"Times New Roman", Times, serif' }),
    Object.freeze({ id:'trebuchet-ms', label:'Trebuchet MS', family:'"Trebuchet MS", Arial, sans-serif' })
  ]);
  const fontAssets = window.OpenLiveFontAssets;
  const FONTS = Object.freeze([...LOCAL_FONTS,...(fontAssets?.catalog?.() || []).filter(font=>
    !LOCAL_FONTS.some(local=>local.id===font.id))]);
  const fontsById = new Map(FONTS.map(font=>[font.id,font]));
  const fontLoads = new Map(), fontStates = new Map(), fontRequestStates = new Map(), fontGenerations = new Map();
  const listeners = new Set();
  let state = Object.assign({}, DEFAULT_STATE);
  let lastError = '';

  const copy = value => JSON.parse(JSON.stringify(value));

  function normaliseHex(value) {
    const text = String(value == null ? '' : value).trim();
    const short = /^#?([0-9a-f]{3})$/i.exec(text);
    if (short) return '#' + short[1].split('').map(char => char + char).join('').toUpperCase();
    const full = /^#?([0-9a-f]{6})$/i.exec(text);
    return full ? '#' + full[1].toUpperCase() : '';
  }

  function normalise(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      version: 1,
      preset: PRESETS.includes(source.preset) ? source.preset : DEFAULT_STATE.preset,
      primaryColor: normaliseHex(source.primaryColor) || DEFAULT_STATE.primaryColor,
      fontId: fontsById.has(source.fontId) ? source.fontId : DEFAULT_STATE.fontId,
      templateId: templateIds().includes(source.templateId) ? source.templateId : DEFAULT_STATE.templateId,
      logoPlacement: source.logoPlacement === 'template' ? 'template' : 'saved',
      tickerLabel: validTickerLabel(source.tickerLabel) || DEFAULT_STATE.tickerLabel
    };
  }

  // Resolve lazily: the layout catalogue is optional outside Studio. Loading an
  // older Theme document only supplies defaults in memory; it never rewrites it.
  function templateIds() {
    const layout = window.OpenLiveBroadcastLayout;
    return layout && Array.isArray(layout.TEMPLATES)
      ? layout.TEMPLATES.map(record => record.id) : ['classic'];
  }

  function validTickerLabel(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return '';
    const label = value.trim();
    return label && Array.from(label).length <= 24 ? label : '';
  }

  function load() {
    try { state = STORE ? normalise(JSON.parse(localStorage.getItem(STORE) || 'null')) : normalise(null); }
    catch (_) { state = normalise(null); }
  }

  function getState() { return copy(state); }
  // Recall the scene's editor controls without writing shared defaults or taking Programme.
  function recallSceneState(profile) {
    if (!profile) return;
    state=normalise({preset:profile.id,primaryColor:profile.savedPrimary||profile.primary,fontId:profile.fontId,
      templateId:profile.broadcastTemplate,logoPlacement:profile.templateLogo?'template':'saved',tickerLabel:profile.tickerLabel});
  }

  function announce(reason) {
    const snapshot = getState();
    listeners.forEach(listener => { try { listener(snapshot, reason); } catch (_) {} });
  }

  function commit(next, reason) {
    const value = normalise(next);
    try {
      if (!STORE) throw new Error('The Studio draft context is invalid.');
      localStorage.setItem(STORE, JSON.stringify(value));
    }
    catch (_) {
      lastError = 'SHOWAVE could not save the Theme in this browser.';
      throw new Error(lastError);
    }
    state = value;
    lastError = '';
    announce(reason || 'change');
    return getState();
  }

  function setPreset(value) {
    if (!PRESETS.includes(value)) throw new Error('Choose Air, Base, News, or Round.');
    return commit(Object.assign({}, state, { preset:value }), 'preset');
  }

  function setPrimaryColor(value) {
    const colour = normaliseHex(value);
    if (!colour) throw new Error('Enter a six-digit hex colour, for example #2563EB.');
    return commit(Object.assign({}, state, { primaryColor:colour }), 'primary-color');
  }

  function setFont(value) {
    if (!fontsById.has(value)) throw new Error('Choose a font from the Theme list.');
    return commit(Object.assign({}, state, { fontId:value }), 'font');
  }

  // Loading never commits Theme or changes a scene. Pickers await this before
  // setFont; remembered online faces are also prepared when a renderer reads
  // its family. The whole graphics weight set is ready before a new selection.
  function fontRequest(id, weightOrOptions) {
    const selected=fontsById.get(id);
    if(!selected)throw new Error('Choose a font from the Theme list.');
    const options=weightOrOptions&&typeof weightOrOptions==='object'?weightOrOptions:{};
    const weights=typeof weightOrOptions==='number'||typeof weightOrOptions==='string'?[weightOrOptions]:[400,500,600,650,700,720,750,800];
    const asset=fontAssets?.record?.(selected.id) || fontAssets?.record?.(selected.label);
    // The default Latin face covers ordinary typing and countdown digits.
    // Non-Latin glyph sets get distinct readiness without a request per frame.
    const glyphs=[...new Set(Array.from(String(options.text||'')).filter(char=>char.codePointAt(0)>255))].sort().join('');
    const key=JSON.stringify([id,weights,options.style||'normal',glyphs]);
    return {selected,options,weights,asset,key};
  }

  function ensureFont(id, weightOrOptions) {
    let request;try{request=fontRequest(id,weightOrOptions);}catch(error){return Promise.reject(error);}
    const {selected,options,weights,asset,key}=request;
    if(!asset){
      const result={state:'system',family:selected.label,source:'system',error:''};
      fontStates.set(id,result);fontRequestStates.set(key,result);return Promise.resolve({...result});
    }
    const existing=fontLoads.get(key);if(existing)return existing;
    const generation=(fontGenerations.get(id)||0)+1;fontGenerations.set(id,generation);
    const loading={state:'loading',family:selected.label,source:asset.source,error:''};
    fontStates.set(id,loading);fontRequestStates.set(key,loading);
    const promise=Promise.all(weights.map(weight=>fontAssets.ensure(asset.id,weight,options))).then(results=>{
      const result={state:'ready',family:selected.label,source:asset.source,error:'',weights:results.map(value=>value.weight),version:results[0]?.version};
      fontRequestStates.set(key,result);if(fontGenerations.get(id)===generation)fontStates.set(id,result);return {...result};
    },error=>{
      const failed={state:'failed',family:selected.label,source:asset.source,error:error.message||String(error)};
      fontRequestStates.set(key,failed);if(fontGenerations.get(id)===generation)fontStates.set(id,failed);
      if(fontLoads.get(key)===promise)fontLoads.delete(key);throw error;
    });
    fontLoads.set(key,promise);return promise;
  }

  function fontStatus(id=state.fontId, options) {
    let request;try{request=fontRequest(id,options);}catch(_){return {state:'failed',error:'That font is unavailable.',family:''};}
    const {selected,asset,key}=request;
    const status=options===undefined?fontStates.get(id):fontRequestStates.get(key);
    return {...(status||{state:asset?'idle':'system',family:selected.label,source:asset?.source||'system',error:''})};
  }

  async function prepareProfile(input, options={}) {
    const value=normalise(input||state);
    await ensureFont(value.fontId,options);
    return profile(value,options);
  }

  function setTemplate(value) {
    if (!templateIds().includes(value)) throw new Error('Choose an available on-air template.');
    return commit(Object.assign({}, state, {
      preset:'news', templateId:value, logoPlacement:'template'
    }), 'template');
  }

  // A brand choice is one durable transaction. Background and source layout
  // are separate explicit actions, never side effects of browsing a preset.
  function applyBrandKit(id) {
    const catalog = window.OpenLiveProductionPresets;
    const kit = catalog && catalog.brands.find(item => item.id === id);
    if (!kit || !templateIds().includes(kit.templateId) || !normaliseHex(kit.primaryColor) ||
        !fontsById.has(kit.fontId) || !validTickerLabel(kit.tickerLabel))
      throw new Error('Choose an available SHOWAVE brand preset.');
    return commit(Object.assign({}, state, {preset:'news',primaryColor:kit.primaryColor,
      fontId:kit.fontId,templateId:kit.templateId,tickerLabel:kit.tickerLabel,logoPlacement:'template'}), 'brand-kit');
  }

  function setLogoPlacement(value) {
    if (!['saved', 'template'].includes(value)) throw new Error('Choose saved or template logo placement.');
    return commit(Object.assign({}, state, {logoPlacement:value}), 'logo-placement');
  }

  function setTickerLabel(value) {
    const label = validTickerLabel(value);
    if (!label) throw new Error('Enter a ticker badge label of 1 to 24 characters on one line.');
    return commit(Object.assign({}, state, {tickerLabel:label}), 'ticker-label');
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function fontRecord(input) {
    const id = typeof input === 'string' ? input : input && input.fontId;
    return fontsById.get(id) || FONTS[0];
  }

  function fontFamily(input) {
    const selected=fontRecord(input || state);
    if(fontAssets && !fontStates.has(selected.id))ensureFont(selected.id).catch(()=>{});
    return selected.family;
  }

  function canvasFont(weight, pixels, input) {
    return String(weight == null ? 600 : weight) + ' ' + Math.max(1, Math.round(Number(pixels) || 1)) +
      'px ' + fontFamily(input || state);
  }

  function rgb(hex) {
    const value = normaliseHex(hex) || DEFAULT_STATE.primaryColor;
    return {
      r:parseInt(value.slice(1, 3), 16),
      g:parseInt(value.slice(3, 5), 16),
      b:parseInt(value.slice(5, 7), 16)
    };
  }

  function alpha(hex, opacity) {
    const value = rgb(hex);
    return 'rgba(' + value.r + ',' + value.g + ',' + value.b + ',' +
      Math.max(0, Math.min(1, Number(opacity) || 0)) + ')';
  }

  function contrastingText(hex) {
    const value = rgb(hex);
    const luminance = relativeLuminance(value);
    return luminance > .47 ? '#0A1020' : '#FFFFFF';
  }

  function relativeLuminance(value) {
    const linear = channel => {
      const c = channel / 255;
      return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
    };
    return .2126 * linear(value.r) + .7152 * linear(value.g) + .0722 * linear(value.b);
  }

  function readableOnWhite(hex) {
    let value = rgb(hex);
    let guard = 0;
    while ((1.05 / (relativeLuminance(value) + .05)) < 4.5 && guard++ < 12) {
      value = { r:Math.round(value.r * .82), g:Math.round(value.g * .82), b:Math.round(value.b * .82) };
    }
    return '#' + [value.r, value.g, value.b]
      .map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /* Profiles are semantic tokens rather than one renderer's geometry. Caption,
     countdown and commerce renderers can keep layouts appropriate to their
     content while sharing the exact colour, type and corner decisions. */
  function profile(input, fontOptions) {
    const value = normalise(input || state);
    const family = fontFamily(value);
    const colour = value.primaryColor;
    const readiness=fontStatus(value.fontId,fontOptions);
    const shared = {
      id:value.preset,
      label:value.preset[0].toUpperCase() + value.preset.slice(1),
      fontId:value.fontId,
      family,
      fontReady:['ready','system'].includes(readiness.state),
      fontStatus:readiness.state,
      fontError:readiness.error||'',
      broadcastTemplate:value.templateId,
      templateLogo:value.logoPlacement === 'template',
      tickerLabel:value.tickerLabel,
      savedPrimary:colour,
      primaryAvailable:value.preset !== 'air'
    };
    if (value.preset === 'air') return Object.assign(shared, {
      primary:'#DCEBFF', primaryText:'#365675', accent:'#FFFFFF', surface:'rgba(8,14,28,.52)',
      surfaceStrong:'rgba(8,14,28,.78)', foreground:'#FFFFFF', muted:'rgba(255,255,255,.78)',
      card:'#F7FAFF', cardText:'#111827', cardMuted:'#526079', radiusScale:.55, shadow:true
    });
    if (value.preset === 'base') return Object.assign(shared, {
      primary:colour, primaryText:readableOnWhite(colour), accent:colour, surface:'#0B1220', surfaceStrong:'#080D18',
      foreground:'#FFFFFF', muted:'rgba(255,255,255,.74)', card:'#FFFFFF', cardText:'#111827',
      cardMuted:'#5F6B7C', radiusScale:.08, shadow:false
    });
    if (value.preset === 'news') return Object.assign(shared, {
      primary:colour, primaryText:readableOnWhite(colour), accent:colour, surface:'#0A1020', surfaceStrong:'#050913',
      foreground:'#FFFFFF', muted:'rgba(255,255,255,.75)', card:'#F8FAFC', cardText:'#0A1020',
      cardMuted:'#536078', radiusScale:0, shadow:true
    });
    return Object.assign(shared, {
      primary:colour, primaryText:readableOnWhite(colour), accent:colour, surface:alpha(colour, .93), surfaceStrong:colour,
      foreground:contrastingText(colour), muted:alpha(contrastingText(colour), .76),
      card:'#FFFFFF', cardText:'#111827', cardMuted:'#5B6677', radiusScale:1, shadow:true
    });
  }

  load();

  return {
    STORE, PRESETS, FONTS, getState, setPreset, setPrimaryColor, setFont, setTemplate,
    setLogoPlacement, setTickerLabel, applyBrandKit, subscribe, recallSceneState,
    normaliseHex, fontFamily, canvasFont, ensureFont, fontStatus, prepareProfile, contrastingText, readableOnWhite, alpha, profile,
    get lastError() { return lastError; }
  };
})();
