/* SHOWAVE GSL5 operator UI
   -------------------------------------------------------------------------
   A dependency-free console shell around gsl5-engine.js. Durable show data is
   saved stopped; the programmer and playback clock are intentionally runtime
   state. Physical output is acknowledged by gsl5-bridge.js before the surface
   reports LIVE.
   ------------------------------------------------------------------------- */
(function installGSL5UI(global) {
  'use strict';

  const Engine = global.ShowaveGSL5;
  const Bridge = global.ShowaveGSL5Bridge;
  const Personalities = global.ShowaveGSL5Personalities;
  const PersonalityPreview = global.ShowaveGSL5Preview;
  const Hub = global.OpenLiveHub;
  const Timeline = global.OpenLiveTimeline;
  const root = document.getElementById('gsl5Root');
  if (!root || !Engine) return;

  const STORAGE_KEY = 'showave.gsl5.show.v1';
  const OWNER_CHANNEL = 'showave-gsl5-owner-v1';
  const HISTORY_LIMIT = 60;
  const COMPOSER_ASSET_MIME = 'application/x-showave-gsl5-asset';
  const COMPOSER_CLIP_MIME = 'application/x-showave-gsl5-clip';
  const COMPOSER_COLUMN_MIME = 'application/x-showave-gsl5-column';
  const SHOWAVE_LIGHTING_BINDING_SCHEMA = 'showave.gsl5.binding/1';
  const SHOWAVE_LIGHTING_PROFILE_TEMPLATE_SCHEMA = 'showave.gsl5.profile-template/1';
  const SHOWAVE_LIGHTING_SOURCE_TEMPLATE_SCHEMA = 'showave.gsl5.source-template/1';
  const SHOWAVE_CLIP_SCOPE = 'showave-lighting-clip';
  const COMPOSER_COLORS = ['#4ea1ff','#38c997','#ffb547','#a980ff','#ff6b78','#43c7d8','#d6d85a','#ea7ed5'];
  const WORKSPACES = {
    library:['LIGHTING LIBRARY','Lights, Sources & Modifiers'],
    mapper:['LIGHTING PROCESSOR','Fixture & Panel Mapper'],
    live:['SHOWAVE SPATIAL WORKSPACE','Lighting Composer'],
    programmer:['PROGRAMMING WORKSPACE','Programmer'],
    patch:['SYSTEM WORKSPACE','Patch & Fixtures'],
    cues:['PLAYBACK WORKSPACE','Cue Stacks'],
    fx:['MODULATION WORKSPACE','FX / Phasers'],
    network:['OUTPUT WORKSPACE','Lighting Network']
  };
  const FEATURES = {
    intensity:['dimmer','intensity','shutter'],
    position:['pan','tilt','position-x','position-y','position-z'],
    color:['red','green','blue','white','amber','cyan','magenta','yellow','color-wheel'],
    beam:['zoom','focus','iris','gobo','gobo-rotation','prism','frost']
  };
  const COLOR_ATTRIBUTES = new Set(FEATURES.color);
  const POSITION_ATTRIBUTES = new Set(FEATURES.position);
  const INTENSITY_ATTRIBUTES = new Set(FEATURES.intensity);
  const $ = (selector, scope) => (scope || document).querySelector(selector);
  const $$ = (selector, scope) => [...(scope || document).querySelectorAll(selector)];
  const byId = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const safe = value => String(value == null ? '' : value)
    .replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
  const uid = prefix => `${prefix || 'gsl5'}:${Date.now().toString(36)}:${
    global.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  const tokenValue = value => clamp(value && typeof value === 'object' ? value.value : value, 0, 1);
  const milliseconds = seconds => Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const themeValue = name => global.getComputedStyle
    ? global.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    : '';
  const isSessionOnly = () => global.OpenLiveSessionPolicy?.sessionOnly === true;

  let show = loadShow();
  let workspace = 'library';
  let libraryTab = 'lights';
  let libraryRenderToken = 0;
  let librarySearchTimer = 0;
  let selectedLibraryProfileId = '';
  let selectedLibraryAssetKey = '';
  let libraryCatalogRows = new Map();
  let libraryAssets = new Map();
  let feature = 'intensity';
  let activeSequenceId = show.metadata.activeSequenceId || show.sequences[0] && show.sequences[0].id || '';
  let selectedPlaybackId = show.metadata.selectedPlaybackId || show.playbacks[0] && show.playbacks[0].id || '';
  let selectedEffectId = show.effects[0] && show.effects[0].id || '';
  let selectedCueId = '';
  let playbackPage = 0;
  let operatorBlackout = false;
  let locate = false;
  let oddEvenBase = null, oddEvenPhase = 0;
  let lastFixtureIndex = -1;
  let evaluated = {fixtureValues:{}, universes:{}};
  let bridgeState = Bridge ? Bridge.snapshot() : {available:false, outputting:false, status:'unavailable'};
  let ownerChannel = null;
  let outputArmPending = false;

  function registerExternalProductWindow() {
    if (!global.opener || global.parent !== global) return false;
    try {
      const register=global.opener.__openliveRegisterGSL5ProductWindow;
      if (typeof register === 'function') return register(global);
    } catch (_) { /* opener may be unavailable while SHOWAVE reloads */ }
    return false;
  }
  try {
    ownerChannel = new BroadcastChannel(OWNER_CHANNEL);
    ownerChannel.addEventListener('message', event => {
      if (event.data && event.data.kind === 'discover') registerExternalProductWindow();
    });
  } catch (_) { ownerChannel = null; }
  registerExternalProductWindow();
  let saveTimer = 0;
  let fullRenderQueued = false;
  let lastRuntimePaint = 0;
  let lastEvaluation = 0;
  let tapTimes = [];
  let history = [];
  let future = [];
  let dirty = false;
  let saveError = '';
  let documentRevision = 0;
  let fileLoadToken = 0;
  let selectedNodeId = '';
  let fxCanvasDpr = 0;
  let flashState = null;
  let composerLibraryFilter = 'all';
  let composerPendingAssetKey = '';
  let selectedComposerClipId = '';
  let selectedComposerLayerId = '';
  let selectedComposerColumnId = '';
  let composerClipboardClipId = '';
  let composerDrag = null;
  let composerAssets = new Map();
  let mapperDrag = null;
  let selectedCatalogProfile = null;
  let selectedCatalogLibraryId = '';
  let personalityPreviewProfile = null;
  let personalityPreviewFrame = 0;
  let personalityPreviewStarted = 0;
  let personalityRenderToken = 0;
  let personalitySearchTimer = 0;
  let personalityImporting = false;
  let personalityCatalogRows = new Map();
  let builderDraft = null;
  let builderEditingId = '';
  let builderDirty = false;
  let builderAssessment = null;
  let builderPreviewFrame = 0;
  let builderPreviewStarted = 0;
  let builderFunctionChannelIndex = 0;

  function loadShow() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { raw = null; }
    if (!raw && Hub && Hub.get) raw = Hub.get('lighting.project', null);
    let result;
    try { result = raw ? Engine.normaliseShow(raw) : Engine.createShow({name:'New GSL5 Show'}); }
    catch (_) { result = Engine.createShow({name:'New GSL5 Show'}); }
    if (!result.sequences.length) Engine.createSequence(result, {name:'Main Cue List',tracking:true});
    if (!result.playbacks.length && result.sequences[0])
      Engine.assignPlayback(result, {name:'Main',sequenceId:result.sequences[0].id,level:0});
    result.master = Number.isFinite(Number(result.master)) ? result.master : 1;
    result.effects.forEach(effect=>Object.defineProperty(result.runtime.effects,effect.id,{
      value:{active:false,startedAt:0},enumerable:true,configurable:true,writable:true
    }));
    return result;
  }

  function shareable() {
    const copy = Engine.shareableShow(show);
    copy.effects.forEach(effect=>Object.defineProperty(copy.runtime.effects,effect.id,{
      value:{active:false,startedAt:0},enumerable:true,configurable:true,writable:true
    }));
    copy.metadata = Object.assign({}, copy.metadata, {
      activeSequenceId, selectedPlaybackId, product:'GSL5 Lighting Library', savedAt:Date.now()
    });
    return copy;
  }

  function publishHub(reason) {
    if (!Hub || !Hub.patch) return;
    const project = shareable();
    const playback = activePlayback();
    const runtime = playback && show.runtime.playbacks[playback.id];
    const sequence = playback && sequenceById(playback.sequenceId);
    const cueId = runtime && runtime.active && sequence && sequence.cueIds[runtime.cursor] || null;
    try {
      Hub.patch('lighting', {
        schema:1, project, selectedCueId:selectedCueId || null, activeCueId:cueId,
        updatedAt:Date.now()
      }, {reason:reason || 'GSL5 show saved'});
    } catch (_) { /* Local save still succeeds if the shared bucket is full. */ }
  }

  function saveNow(reason) {
    clearTimeout(saveTimer); saveTimer = 0;
    const project = shareable();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      dirty = false;
      saveError = '';
      renderSaveState();
    } catch (error) {
      dirty = true; saveError = error.message || 'Storage unavailable'; renderSaveState();
      status(`Show could not be ${isSessionOnly()?'kept for this session':'saved locally'}: ${error.message}`, 'error');
      return false;
    }
    publishHub(reason);
    return true;
  }

  function scheduleSave(reason) {
    dirty = true; saveError = ''; documentRevision++; renderSaveState();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(reason), 220);
  }

  function remember() {
    history.push(JSON.stringify(show));
    if (history.length > HISTORY_LIMIT) history.shift();
    future.length = 0;
  }

  function mutate(reason, operation, options) {
    const config = options || {};
    const before = JSON.stringify(show), previousHistory = history.slice(), previousFuture = future.slice();
    if (config.history !== false) remember();
    let result;
    try { result = operation(show); }
    catch (error) {
      history = previousHistory;
      show = Engine.normaliseShow(JSON.parse(before));
      future = previousFuture; ensureActiveObjects(); renderAll();
      status(error.message, 'error');
      return null;
    }
    if (config.save !== false) scheduleSave(reason);
    if (config.render !== false) renderAll();
    return result;
  }

  function restore(serialised, targetStack) {
    try {
      targetStack.push(JSON.stringify(show));
      show = Engine.normaliseShow(JSON.parse(serialised));
      ensureActiveObjects();
      scheduleSave('GSL5 history'); renderAll();
    } catch (error) { status(`History restore failed: ${error.message}`, 'error'); }
  }

  function undo() {
    if (!requireDisarmed('undoing show edits')) return;
    const previous = history.pop();
    if (previous) restore(previous, future);
  }

  function redo() {
    if (!requireDisarmed('redoing show edits')) return;
    const next = future.pop();
    if (next) restore(next, history);
  }

  function ensureActiveObjects() {
    if (!show.sequences.some(item => item.id === activeSequenceId)) activeSequenceId = show.sequences[0] && show.sequences[0].id || '';
    if (!show.playbacks.some(item => item.id === selectedPlaybackId)) selectedPlaybackId = show.playbacks[0] && show.playbacks[0].id || '';
    if (!show.effects.some(item => item.id === selectedEffectId)) selectedEffectId = show.effects[0] && show.effects[0].id || '';
    const composer = show.composer || {layers:[],columns:[],clips:[]};
    const layers=composer.layers.filter(layer=>!isPrivateComposerLayer(layer));
    const columns=composer.columns.filter(column=>!isPrivateComposerColumn(column));
    if (!layers.some(item => item.id === selectedComposerLayerId)) selectedComposerLayerId = layers[0] && layers[0].id || '';
    if (!columns.some(item => item.id === selectedComposerColumnId)) selectedComposerColumnId = columns[0] && columns[0].id || '';
    if (!composer.clips.some(item => item.id === selectedComposerClipId&&!isPrivateComposerClip(item))) selectedComposerClipId = '';
  }

  function status(message, tone) {
    const line = byId('gslCommandLine');
    if (line) {
      line.innerHTML = `<strong>GSL5</strong><span>${safe(message)}</span>`;
      line.dataset.tone = tone || 'info';
    }
    const footer = byId('gslFooterMessage');
    if (footer) { footer.textContent = message; footer.dataset.tone = tone || 'info'; }
    const libraryFooter = byId('gslLibraryFooterMessage');
    if (libraryFooter) { libraryFooter.textContent = message; libraryFooter.dataset.tone = tone || 'info'; }
  }

  function requireDisarmed(action) {
    if(outputArmPending){status(`Wait for output arming to finish before ${action}.`,'warning');return false;}
    if (!bridgeState.outputting) return true;
    status(`Disarm physical lighting output before ${action}.`,'warning');
    return false;
  }

  function profileById(id) { return show.profiles.find(profile => profile.id === id) || null; }
  function fixtureById(id) { return show.fixtures.find(fixture => fixture.id === id) || null; }
  function sequenceById(id) { return show.sequences.find(sequence => sequence.id === id) || null; }
  function cueById(id) { return show.cues.find(cue => cue.id === id) || null; }
  function playbackById(id) { return show.playbacks.find(playback => playback.id === id) || null; }
  function effectById(id) { return show.effects.find(effect => effect.id === id) || null; }
  function effectStateLabel(effect) {
    const runtime=show.runtime.effects[effect.id];
    return !effect.enabled ? 'Disabled' : runtime ? runtime.active!==false ? 'Running' : 'Stopped'
      : effect.autostart ? 'Running' : 'Cue / clip';
  }
  function activeSequence() { return sequenceById(activeSequenceId) || show.sequences[0] || null; }
  function activePlayback() { return playbackById(selectedPlaybackId) || show.playbacks[0] || null; }
  function selectedFixtures() { return show.programmer.selectedFixtureIds.map(fixtureById).filter(Boolean); }
  function fixtureNumber(fixture) {
    const match = String(fixture && fixture.id || '').match(/(?:fixture:)?(\d+)(?:$|:)/);
    return match ? Number(match[1]) : show.fixtures.indexOf(fixture) + 1;
  }
  function footprint(fixture) { const profile = profileById(fixture.profileId); return profile ? profile.footprint : 0; }
  function attributeFamily(attribute) {
    if (INTENSITY_ATTRIBUTES.has(attribute)) return 'intensity';
    if (COLOR_ATTRIBUTES.has(attribute)) return 'color';
    if (POSITION_ATTRIBUTES.has(attribute)) return 'position';
    return 'beam';
  }
  function paletteFamily(palette) {
    const families = new Set((palette.attributes || []).map(attributeFamily));
    return families.size === 1 ? [...families][0] : families.has('color') ? 'color' : families.has('position') ? 'position' : families.has('intensity') ? 'intensity' : 'beam';
  }

  function syncFixtureEditorProfiles() {
    if (!Hub || !Hub.get) return false;
    const library = Hub.get('fixtures.items', []);
    if (!Array.isArray(library) || !library.length) return false;
    let changed = false;
    library.forEach(item => {
      const id = `showave-fixture:${item.id || item.uuid || item.name}`;
      if (show.profiles.some(profile => profile.id === id)) return;
      const channels = [];
      const colorSpace = String(item.colorSpace || 'RGB').toLowerCase();
      const components = colorSpace === 'l' ? ['dimmer'] : colorSpace === 'a' ? ['alpha']
        : colorSpace.replace(/[^rgbwacmyk]/g, '').split('').map(letter => ({r:'red',g:'green',b:'blue',w:'white',a:'amber',c:'cyan',m:'magenta',y:'yellow',k:'black'}[letter])).filter(Boolean);
      (item.parameters || []).slice().sort((a,b) => (+a.order || 0) - (+b.order || 0)).forEach(parameter => {
        if (parameter.type === 'pixel' || /pixel/i.test(parameter.name || '')) {
          const pixels = Math.max(1, Number(item.pixelCount || item.pixels) || 1);
          for (let pixel = 0; pixel < pixels; pixel++) components.forEach(attribute => {
            if (channels.length < 512) channels.push({attribute,offset:channels.length,bits:8,fineOffset:null,default:0,
              mix:INTENSITY_ATTRIBUTES.has(attribute) ? 'htp' : 'ltp'});
          });
        } else if (channels.length < 512) {
          const attribute = String(parameter.name || 'channel').toLowerCase().replace(/[^a-z0-9]+/g,'-');
          channels.push({attribute,offset:channels.length,bits:8,fineOffset:null,
            default:clamp(Number(parameter.defaultValue) / 255,0,1),mix:INTENSITY_ATTRIBUTES.has(attribute) ? 'htp' : 'ltp'});
        }
      });
      if (!channels.length) channels.push({attribute:'dimmer',offset:0,bits:8,fineOffset:null,default:0,mix:'htp'});
      show.profiles.push({id,name:item.name || 'GSL5 Fixture',manufacturer:'GSL5 Fixture Builder',
        mode:`${channels.length} channel`,footprint:channels.length,channels});
      changed = true;
    });
    return changed;
  }

  /* Render ---------------------------------------------------------------- */
  function renderSaveState() {
    const node = byId('gslSaveState'); if (!node) return;
    const sessionOnly=isSessionOnly(),reason=sessionOnly?'Kept for this session. Saving files is disabled.':'Show saved locally';
    node.classList.toggle('dirty', dirty);
    node.classList.toggle('error', !!saveError);
    node.title = saveError || reason;
    node.innerHTML = `<i></i>${saveError ? 'Not saved' : dirty ? sessionOnly?'Updating…':'Saving…' : sessionOnly?'Session only':'Saved'}`;
    const libraryState=byId('gslLibraryWindowState');
    if(libraryState && workspace==='library'){
      libraryState.textContent=saveError?'Not saved':dirty?sessionOnly?'Updating…':'Saving…':sessionOnly?'Session only':'Ready';
      libraryState.title=saveError||reason;
    }
  }

  function renderSessionControls() {
    const sessionOnly=isSessionOnly(),reason='Saving files is disabled in this session. Shows stay in memory.';
    const controls=[byId('gslLibrarySaveShow'),...$$('[data-action="save-show"],[data-action="export-patch"]')];
    controls.forEach(control=>{if(!control)return;control.disabled=sessionOnly;control.title=sessionOnly?reason:'Export a GSL5 show or patch file';});
    const exportButton=byId('gslBuilderExport');
    if(exportButton){exportButton.disabled=sessionOnly||!builderAssessment?.valid;exportButton.title=sessionOnly?reason:'Export the fixture personality as JSON';}
    byId('gslBuilderSave').textContent=sessionOnly?'KEEP FOR SESSION':'SAVE LOCAL';
    byId('gslBuilderPatch').textContent=sessionOnly?'KEEP & USE IN PATCH':'SAVE & USE IN PATCH';
  }

  function renderHeader() {
    renderSessionControls();
    byId('gslShowName').textContent = show.name;
    byId('gslBpm').value = String(Math.round(Number(show.metadata.bpm) || activeSequence() && activeSequence().bpm || 120));
    byId('gslGrandMaster').value = String(Math.round(show.master * 100));
    byId('gslGrandMasterValue').textContent = `${Math.round(show.master * 100)}%`;
    byId('gslBlind').setAttribute('aria-pressed', String(!!show.programmer.blind));
    byId('gslLocate').setAttribute('aria-pressed', String(locate));
    byId('gslHighlight').setAttribute('aria-pressed', String(!!show.programmer.highlight));
    byId('gslBlackout').setAttribute('aria-pressed', String(operatorBlackout || (bridgeState.outputting && bridgeState.blackout)));
    byId('gslArmOutput').setAttribute('aria-pressed', String(!!bridgeState.outputting));
    byId('gslArmOutput').disabled = outputArmPending;
    byId('gslArmOutput').textContent = bridgeState.outputting ? 'DISARM OUTPUT' : 'ARM OUTPUT';
    const bridge = byId('gslBridgeStatus');
    bridge.className = `gsl-status-chip ${bridgeState.available ? 'ready' : bridgeState.status === 'checking' ? '' : 'error'}`;
    bridge.innerHTML = `<i></i>${safe(bridgeState.available ? 'Bridge ready' : bridgeState.status === 'checking' ? 'Bridge checking' : 'Bridge unavailable')}`;
    const output = byId('gslOutputStatus');
    output.className = `gsl-status-chip ${bridgeState.outputting ? 'live' : 'preview'}`;
    output.innerHTML = `<i></i>${bridgeState.outputting ? `${String(bridgeState.protocol || 'DMX').toUpperCase()} LIVE` : 'PREVIEW'}`;
    renderSaveState();
  }

  function lightingSourceAssets() {
    return [
      {kind:'source',id:'source:full',preset:'full',name:'Full Beam',caption:'dimmer · open white',kindLabel:'SOURCE',color:'#4ea1ff'},
      {kind:'source',id:'source:blackout',preset:'blackout',name:'Blackout',caption:'zero intensity look',kindLabel:'SOURCE',color:'#ff6b78'},
      {kind:'source',id:'source:white',preset:'white',name:'Open White',caption:'RGBW · full output',kindLabel:'SOURCE',color:'#d6d85a'},
      {kind:'source',id:'source:home',preset:'home',name:'Mover Home',caption:'pan / tilt centre',kindLabel:'SOURCE',color:'#43c7d8'}
    ];
  }

  function libraryMatches(query, values) {
    return !query || values.filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  function libraryRow(options) {
    const drag = options.draggable === true;
    const selected = options.selected === true;
    const attributes = [
      `class="gsl-library-row"`, 'type="button"', 'role="listitem"',
      options.profileId ? `data-library-profile-id="${safe(options.profileId)}"` : '',
      options.fixtureId ? `data-library-fixture-id="${safe(options.fixtureId)}"` : '',
      options.groupId ? `data-library-group-id="${safe(options.groupId)}"` : '',
      options.assetKey ? `data-library-asset-key="${safe(options.assetKey)}"` : '',
      drag ? 'draggable="true"' : 'draggable="false"',
      `aria-selected="${selected}"`,
      `aria-label="${safe(options.ariaLabel || options.name)}"`
    ].filter(Boolean).join(' ');
    return `<button ${attributes}><span><strong>${safe(options.name)}</strong><small>${safe(options.caption || '')}</small></span>`+
      `<span class="gsl-library-tag ${drag ? 'drag' : ''}">${safe(options.tag || (drag ? 'DRAG' : 'INTERNAL'))}</span></button>`;
  }

  function setLibraryChrome(count, summary, footer) {
    byId('gslLibraryShowName').textContent = show.name;
    byId('gslLibraryWindowState').textContent = saveError ? 'Not saved' : dirty ? isSessionOnly()?'Updating…':'Saving…' : count === 'Loading…'
      ? 'Loading…'
      : isSessionOnly() ? 'Session only' : libraryTab === 'output' && bridgeState.outputting ? 'Output live' : 'Ready';
    byId('gslLibraryWindowState').title=saveError|| (isSessionOnly()?'Kept for this session. Saving files is disabled.':'Show saved locally');
    byId('gslLibrarySummary').textContent = summary;
    byId('gslLibraryFooterCount').textContent = count;
    byId('gslLibraryFooterMessage').textContent = footer;
    byId('gslLibraryFooterMessage').dataset.tone = 'info';
  }

  function renderLibrarySynchronous() {
    const rows = byId('gslLibraryRows');
    if (!rows) return false;
    const searchInput = byId('gslLibrarySearch');
    const query = String(searchInput.value || '').trim().toLowerCase();
    const tabNames = {lights:'Lights',fixtures:'Fixtures',groups:'Groups',sources:'Sources',effects:'Effects',cues:'Cues',output:'Output'};
    const placeholders = {lights:'Search lights and personality modes…',fixtures:'Search patched fixtures…',groups:'Search fixture groups…',sources:'Search Lighting Sources…',effects:'Search Lighting Effects…',cues:'Search lighting cues…',output:'Output configuration is read-only here'};
    searchInput.placeholder = placeholders[libraryTab];
    searchInput.disabled = libraryTab === 'output';
    rows.setAttribute('aria-label',tabNames[libraryTab]);
    $$('[data-library-tab]',byId('gslLibraryTabs')).forEach(button => {
      const selected = button.dataset.libraryTab === libraryTab;
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const lightActions = libraryTab === 'lights';
    $$('[data-library-light-action]',byId('gslLibraryActions')).forEach(control=>{control.hidden=!lightActions;});
    byId('gslLibraryInspect').hidden = lightActions || libraryTab === 'output';
    byId('gslLibraryInspect').disabled = libraryTab==='fixtures'||libraryTab==='groups' ? !selectedFixtures().length : false;
    byId('gslLibraryInspect').textContent = ({fixtures:'Edit selected',groups:'Open Programmer',sources:'Open Composer',effects:'Edit selected',cues:'Open Cue Stack'})[libraryTab] || 'Inspect';
    byId('gslLibraryCreateEffect').hidden = libraryTab !== 'effects';
    byId('gslLibraryPreviewLight').hidden = !lightActions;
    byId('gslLibraryPreviewLight').disabled = !libraryCatalogRows.has(selectedLibraryProfileId);
    byId('gslLibraryClearSearch').disabled = !query || libraryTab === 'output';
    libraryAssets = new Map();

    if (libraryTab === 'lights') return false;
    rows.setAttribute('aria-busy','false');
    let html = '', visible = 0;

    if (libraryTab === 'fixtures') {
      const fixtures = show.fixtures.filter(fixture => {
        const profile=profileById(fixture.profileId);
        return libraryMatches(query,[fixture.name,profile&&profile.manufacturer,profile&&profile.name,fixture.universe,fixture.address]);
      });
      visible=fixtures.length;
      html = fixtures.length ? '<div class="gsl-library-heading">PATCHED FIXTURES <span>INTERNAL RIG INSTANCES</span></div>'+
        fixtures.map(fixture=>{const profile=profileById(fixture.profileId);return libraryRow({fixtureId:fixture.id,
          selected:show.programmer.selectedFixtureIds.includes(fixture.id),name:fixture.name,
          caption:`${profile ? `${profile.manufacturer} · ${profile.name}` : fixture.profileId} · Universe ${fixture.universe} / ${fixture.address}`,
          tag:`${fixture.universe}.${fixture.address}`,ariaLabel:`${fixture.name}, internal patched fixture at universe ${fixture.universe} address ${fixture.address}`});}).join('')
        : `<div class="gsl-library-state">${show.fixtures.length ? 'No patched fixtures match this search.' : 'No fixtures are patched. Open Mapper when the rig is ready to configure.'}</div>`;
      setLibraryChrome(`${visible} fixture${visible===1?'':'s'}`,`${show.fixtures.length} patched · configuration in Mapper`,
        'Patched Fixtures stay inside GSL5. Select one here, or open Mapper to edit the rig.');
    } else if (libraryTab === 'groups') {
      const groups = show.groups.filter(group=>libraryMatches(query,[group.name,group.fixtureIds.length,
        ...group.fixtureIds.map(id=>fixtureById(id)?.name)]));
      visible=groups.length;
      html = groups.length ? '<div class="gsl-library-heading">FIXTURE GROUPS <span>INTERNAL SELECTION TARGETS</span></div>'+
        groups.map(group=>libraryRow({groupId:group.id,selected:group.fixtureIds.some(id=>show.programmer.selectedFixtureIds.includes(id)),
          name:group.name,caption:`${group.fixtureIds.length} patched fixture${group.fixtureIds.length===1?'':'s'} · selection group`,
          tag:'GROUP',ariaLabel:`${group.name}, internal group of ${group.fixtureIds.length} fixtures`})).join('')
        : `<div class="gsl-library-state">${show.groups.length ? 'No Groups match this search.' : 'No Fixture Groups yet. Select patched fixtures in Mapper and store a Group.'}</div>`;
      setLibraryChrome(`${visible} group${visible===1?'':'s'}`,`${show.groups.length} groups · internal rig selection`,
        'Groups organise the rig inside GSL5; they never replace the one-personality Light assigned to a SHOWAVE Clip.');
    } else if (libraryTab === 'sources') {
      const sources=lightingSourceAssets().filter(asset=>libraryMatches(query,[asset.name,asset.caption,asset.preset]));
      visible=sources.length;
      html = sources.length ? '<div class="gsl-library-heading">LIGHTING SOURCES <span>DROP ON AN EXISTING LIGHTING CLIP</span></div>'+
        sources.map(asset=>{const key=`source:${asset.id}`;libraryAssets.set(key,asset);return libraryRow({assetKey:key,draggable:true,
          name:asset.name,caption:asset.caption,tag:'SOURCE',ariaLabel:`${asset.name} Lighting Source. Drag to an existing SHOWAVE Lighting Clip.`});}).join('')
        : '<div class="gsl-library-state">No Lighting Sources match this search.</div>';
      setLibraryChrome(`${visible} source${visible===1?'':'s'}`,'Base states · no patch or output changes',
        'Drag a Lighting Source onto a SHOWAVE Clip that already contains one Light type.');
    } else if (libraryTab === 'effects') {
      const effects=show.effects.filter(effect=>!String(effect.id).startsWith('composer:effect:')&&
        libraryMatches(query,[effect.name,effect.attribute,effect.waveform]));
      visible=effects.length;
      html = effects.length ? '<div class="gsl-library-heading">LIGHTING EFFECTS <span>ORDERED CLIP MODIFIERS</span></div>'+
        effects.map(effect=>{const asset={kind:'effect',id:effect.id,name:effect.name};const key=`effect:${effect.id}`;libraryAssets.set(key,asset);
          return libraryRow({assetKey:key,draggable:true,selected:selectedLibraryAssetKey===key,name:effect.name,caption:`${effect.attribute} · ${effect.waveform} · ${effectStateLabel(effect)} · ${effect.rateSource==='bpm'?'Show BPM':`${(effect.speedBpm/60).toFixed(2)} Hz`}`,
            tag:'EFFECT',ariaLabel:`${effect.name} Lighting Effect. Drag to an existing SHOWAVE Lighting Clip.`});}).join('')
        : `<div class="gsl-library-state">${show.effects.length ? 'No Lighting Effects match this search.' : 'No Lighting Effects have been created. Open FX / Phasers in Mapper.'}</div>`;
      setLibraryChrome(`${visible} effect${visible===1?'':'s'}`,`${show.effects.length} effects in this show`,
        'Drag an Effect onto an existing Lighting Clip. Its position in the Clip defines evaluation order.');
    } else if (libraryTab === 'cues') {
      const cues=show.cues.filter(cue=>libraryMatches(query,[cue.name,cue.number,
        show.sequences.find(sequence=>(sequence.cueIds||[]).includes(cue.id))?.name]));
      visible=cues.length;
      html = cues.length ? '<div class="gsl-library-heading">LIGHTING CUES <span>RECORDED SHOW MODIFIERS</span></div>'+
        cues.map(cue=>{const sequence=show.sequences.find(item=>(item.cueIds||[]).includes(cue.id));const asset={kind:'cue',id:cue.id,name:cue.name};
          const key=`cue:${cue.id}`;if(sequence)libraryAssets.set(key,asset);return libraryRow({assetKey:sequence?key:'',draggable:!!sequence,
            name:cue.name,caption:`${sequence ? sequence.name : 'Unassigned'} · ${(Number(cue.fadeMs)||0)/1000}s fade`,tag:sequence?'CUE':'INTERNAL',
            ariaLabel:`${cue.name} Lighting Cue${sequence?': drag to an existing SHOWAVE Lighting Clip':': not assigned to a sequence'}`});}).join('')
        : `<div class="gsl-library-state">${show.cues.length ? 'No Cues match this search.' : 'No Lighting Cues have been recorded.'}</div>`;
      setLibraryChrome(`${visible} cue${visible===1?'':'s'}`,`${show.cues.length} recorded in this show`,
        'Drag a recorded Cue onto an existing Lighting Clip; cue programming remains in Mapper.');
    } else if (libraryTab === 'output') {
      const validation=patchValidation(), universes=Object.keys(evaluated.universes||{}).length;
      const route=bridgeState.outputting ? `${String(bridgeState.protocol||'DMX').toUpperCase()} LIVE` : 'PREVIEW · DISARMED';
      html = `<div class="gsl-library-heading">OUTPUT SUMMARY <span>READ ONLY</span></div><div class="gsl-library-output">
        <div class="gsl-library-output-card"><span><strong>Bridge safety</strong><small>Physical output can only be armed inside Mapper / Network.</small></span><output>${safe(route)}</output></div>
        <div class="gsl-library-output-card"><span><strong>DMX patch</strong><small>${show.fixtures.length} fixtures across ${universes} logical universe${universes===1?'':'s'}.</small></span><output>${validation.valid?'READY':'CHECK PATCH'}</output></div>
        <div class="gsl-library-output-card"><span><strong>Signal route</strong><small>Art-Net / sACN adapter, nodes and destinations are configured elsewhere.</small></span><output>${safe(bridgeState.available?'BRIDGE READY':'BRIDGE OFFLINE')}</output></div>
        <div class="gsl-library-output-actions"><button type="button" data-library-action="mapper">OPEN MAPPER</button><button type="button" data-library-action="network">OPEN NETWORK</button></div>
      </div>`;
      setLibraryChrome(`${universes} universe${universes===1?'':'s'}`,'Read-only safety and routing summary',
        'Power planning, signal flow, DMX patch, Art-Net/sACN routing and physical arming happen in Mapper / Network.');
    }
    rows.innerHTML=html;
    if (libraryTab === 'effects') byId('gslLibraryInspect').disabled = !libraryAssets.has(selectedLibraryAssetKey);
    return true;
  }

  async function renderLibrary() {
    const rows=byId('gslLibraryRows');if(!rows)return;
    if(workspace!=='library')return;
    if(renderLibrarySynchronous())return;
    const token=++libraryRenderToken, query=String(byId('gslLibrarySearch').value||'').trim().toLowerCase();
    rows.setAttribute('aria-busy','true');
    rows.innerHTML='<div class="gsl-library-state">Loading local Lights…</div>';
    setLibraryChrome('Loading…','Loading current show and local personality modes',
      'Drag a Light to a SHOWAVE Clip Slot. Configuration remains in Mapper.');
    try {
      const catalog=Personalities&&Personalities.search ? await Personalities.search(query,{limit:240}) : [];
      if(token!==libraryRenderToken||libraryTab!=='lights')return;
      const profiles=new Map();
      show.profiles.forEach(profile=>{if(libraryMatches(query,[profile.manufacturer,profile.name,profile.mode,profile.footprint]))profiles.set(profile.id,profile);});
      (catalog||[]).forEach(profile=>{if(!profiles.has(profile.id))profiles.set(profile.id,profile);});
      libraryCatalogRows=profiles;
      const list=[...profiles.values()];
      byId('gslLibraryPreviewLight').disabled = !profiles.has(selectedLibraryProfileId);
      rows.setAttribute('aria-busy','false');
      rows.innerHTML=list.length ? '<div class="gsl-library-heading">LIGHT PERSONALITIES <span>ONE TYPE PER SHOWAVE CLIP</span></div>'+
        list.map(profile=>libraryRow({profileId:profile.id,draggable:true,selected:selectedLibraryProfileId===profile.id,
          name:`${profile.manufacturer||'GSL5'} · ${profile.name||profile.id}`,
          caption:`${profile.mode||'Default mode'} · ${Number(profile.footprint)||0} channel${Number(profile.footprint)===1?'':'s'} · Quantity starts at 1`,
          tag:'LIGHT',ariaLabel:`${profile.manufacturer||'GSL5'} ${profile.name||profile.id}, ${profile.mode||'default mode'}. Drag to a SHOWAVE Clip Slot as one Light.`})).join('')
        : '<div class="gsl-library-state">No local Lights or current-show personalities match this search.</div>';
      setLibraryChrome(`${list.length} light${list.length===1?'':'s'}`,`${show.profiles.length} in show · ${Math.max(0,list.length-show.profiles.length)} local results`,
        'Drag one Light personality to a SHOWAVE Clip Slot. Set Quantity on the resulting Lighting Clip.');
    } catch(error) {
      if(token!==libraryRenderToken||libraryTab!=='lights')return;
      const embedded=show.profiles.filter(profile=>libraryMatches(query,[profile.manufacturer,profile.name,profile.mode]));
      libraryCatalogRows=new Map(embedded.map(profile=>[profile.id,profile]));
      rows.setAttribute('aria-busy','false');
      rows.innerHTML=embedded.length ? embedded.map(profile=>libraryRow({profileId:profile.id,draggable:true,
        name:`${profile.manufacturer||'GSL5'} · ${profile.name||profile.id}`,caption:`${profile.mode||'Default mode'} · ${profile.footprint||0} channels`,tag:'LIGHT'})).join('')
        : `<div class="gsl-library-state">The local Light library is unavailable: ${safe(error.message)}</div>`;
      setLibraryChrome(`${embedded.length} show light${embedded.length===1?'':'s'}`,'Local sample provider unavailable',
        'Current-show Lights remain draggable. Reopen the Library to retry local samples.');
    }
  }

  function renderWorkspace() {
    root.dataset.workspace = workspace;
    $$('.gsl-workspace-nav [data-workspace]').forEach(button => {
      const on = button.dataset.workspace === workspace;
      button.classList.toggle('on', on);
      if (on) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    $$('.gsl-pane').forEach(pane => {
      const on = pane.dataset.pane === workspace;
      pane.classList.toggle('on', on); pane.hidden = !on;
    });
    const labels = WORKSPACES[workspace] || WORKSPACES.live;
    byId('gslWorkspaceKicker').textContent = labels[0]; byId('gslWorkspaceTitle').textContent = labels[1];
    byId('gslLibraryShell').hidden = workspace !== 'library';
  }

  function renderSidebar() {
    const search = String(byId('gslFixtureSearch').value || '').trim().toLowerCase();
    byId('gslFixtureCount').textContent = String(show.fixtures.length);
    const selected = new Set(show.programmer.selectedFixtureIds);
    byId('gslGroupList').innerHTML = show.groups.length ? show.groups.map(group => `
      <button type="button" role="option" aria-selected="${group.fixtureIds.some(id => selected.has(id))}" class="gsl-group-item ${group.fixtureIds.some(id => selected.has(id)) ? 'on' : ''}" data-group-id="${safe(group.id)}">
        <strong>${safe(group.name)}</strong><span>${group.fixtureIds.length} fixtures</span>
      </button>`).join('') : '<div class="gsl-empty">Select fixtures and press + to store a group.</div>';
    const fixtures = show.fixtures.filter(fixture => !search || `${fixture.name} ${fixture.profileId} ${fixture.universe}.${fixture.address}`.toLowerCase().includes(search));
    byId('gslFixtureList').innerHTML = fixtures.length ? fixtures.map(fixture => {
      const profile = profileById(fixture.profileId), value = evaluated.fixtureValues[fixture.id] || {};
      const dimmer = value.dimmer == null ? value.intensity || 0 : value.dimmer;
      return `<button type="button" class="gsl-fixture-item ${selected.has(fixture.id) ? 'on' : ''}" data-fixture-id="${safe(fixture.id)}" role="option" aria-selected="${selected.has(fixture.id)}">
        <span class="fid">${fixtureNumber(fixture)}</span><span><strong>${safe(fixture.name)}</strong><small>${safe(profile && profile.name || fixture.profileId)} · ${fixture.universe}.${fixture.address}</small></span>
        <span class="level"><i style="width:${Math.round(dimmer * 100)}%"></i></span>
      </button>`;
    }).join('') : `<div class="gsl-empty">${show.fixtures.length ? 'No fixtures match the search.' : 'No fixtures patched. Open Patch to add real devices.'}</div>`;
    const names = selectedFixtures().map(item => item.name);
    byId('gslSelectionSummary').textContent = names.length ? `${names.length} selected · ${names.slice(0,3).join(', ')}${names.length > 3 ? '…' : ''}` : 'No fixtures selected';
  }

  function poolItem(item, index, extra) {
    return `<button type="button" class="gsl-pool-item ${extra && extra.on ? 'on' : ''}" ${extra && extra.attributes || ''}>
      ${extra && extra.swatch ? `<i class="swatch" style="--swatch:${safe(extra.swatch)}"></i>` : ''}
      <span class="number">${index + 1}</span><strong>${safe(item.name)}</strong><small>${safe(extra && extra.caption || '')}</small>
    </button>`;
  }

  function paletteColor(palette) {
    const sets = [palette.universalValues || {}, ...Object.values(palette.profileValues || {}), ...Object.values(palette.values || {})];
    const source = sets.find(values => values && (values.red != null || values.green != null || values.blue != null)) || {};
    return `rgb(${Math.round(tokenValue(source.red) * 255)},${Math.round(tokenValue(source.green) * 255)},${Math.round(tokenValue(source.blue) * 255)})`;
  }

  function composerAssetKey(asset) { return `${asset.kind}:${asset.id}`; }

  function libraryAsset(asset) {
    const key = composerAssetKey(asset); composerAssets.set(key,asset);
    const selected = key === composerPendingAssetKey;
    return `<button type="button" class="gsl-library-asset ${selected ? 'on' : ''}" draggable="true"
      data-asset-key="${safe(key)}" data-kind-label="${safe(asset.kindLabel || asset.kind)}"
      aria-pressed="${selected}" aria-label="${safe(`${asset.name}. ${asset.caption || ''}. Drag into a lighting clip or select and click an empty clip.`)}"
      style="--asset-color:${safe(asset.color || '#a980ff')}">
      ${asset.swatch ? `<i class="asset-swatch" style="--swatch:${safe(asset.swatch)}" aria-hidden="true"></i>` : ''}
      <strong>${safe(asset.name)}</strong><small>${safe(asset.caption || '')}</small>
    </button>`;
  }

  function composerTargetFixtures(target) {
    const value = target && typeof target === 'object' ? target : {kind:'all'};
    if (value.kind === 'group') {
      const group = show.groups.find(item => item.id === value.groupId);
      return group ? group.fixtureIds.slice() : [];
    }
    if (value.kind === 'fixtures' || value.kind === 'fixture') return (value.fixtureIds || []).filter(id => fixtureById(id));
    return show.fixtures.map(fixture => fixture.id);
  }

  function composerTargetLabel(target) {
    const value = target && typeof target === 'object' ? target : {kind:'all'};
    if (value.kind === 'group') {
      const group = show.groups.find(item => item.id === value.groupId);
      return group ? `${group.name} · ${group.fixtureIds.length}` : 'Missing group';
    }
    if (value.kind === 'fixtures' || value.kind === 'fixture') {
      const fixtures = composerTargetFixtures(value);
      return fixtures.length === 1 ? fixtures[0] && fixtureById(fixtures[0])?.name || '1 fixture' : `${fixtures.length} fixtures`;
    }
    return `All patched · ${show.fixtures.length}`;
  }

  function composerActiveClipId(layerId) {
    const entry = show.runtime && show.runtime.composer && show.runtime.composer.activeByLayer
      ? show.runtime.composer.activeByLayer[layerId] : null;
    return typeof entry === 'string' ? entry : entry && (entry.clipId || entry.id) || '';
  }

  function composerClipType(clip) {
    const kinds = [...new Set((clip.items || []).filter(item => item.enabled !== false).map(item => item.kind))];
    if (kinds.length > 1) return 'STACK';
    return ({cue:'CUE',palette:'PALETTE',look:'SOURCE',effect:'FX',sequence:'CHASER',playback:'PLAYBACK',group:'SOURCE',fixture:'SOURCE'}[kinds[0]] || 'LIGHT CLIP');
  }

  function composerClipCaption(clip, layer) {
    const enabled = (clip.items || []).filter(item => item.enabled !== false);
    const target = clip.target || layer.target;
    return `${composerTargetLabel(target)} · ${enabled.length} ${enabled.length === 1 ? 'module' : 'modules'}`;
  }

  function renderComposerInspector() {
    const inspector = byId('gslComposerInspector'); if (!inspector) return;
    const pending = composerAssets.get(composerPendingAssetKey);
    const clip = show.composer && show.composer.clips.find(item => item.id === selectedComposerClipId&&!isPrivateComposerClip(item));
    const layer = clip && show.composer.layers.find(item => item.id === clip.layerId);
    if (pending) {
      inspector.innerHTML = `<strong>LOADED</strong><span>${safe(pending.name)}: click an empty clip or drag it onto the grid.</span>`;
    } else if (clip) {
      inspector.innerHTML = `<strong>${safe(composerClipType(clip))}</strong><span>${safe(clip.name)} · ${safe(composerClipCaption(clip,layer || {target:null}))}</span>`;
    } else {
      inspector.innerHTML = '<strong>READY</strong><span>Select a library item, then click a clip or drag it directly.</span>';
    }
  }

  function renderLive() {
    const composer = show.composer || {layers:[],columns:[],clips:[]};
    const layers=composer.layers.filter(layer=>!isPrivateComposerLayer(layer));
    const columns=composer.columns.filter(column=>!isPrivateComposerColumn(column));
    const layerIds=new Set(layers.map(layer=>layer.id)), columnIds=new Set(columns.map(column=>column.id));
    const clips=composer.clips.filter(clip=>!isPrivateComposerClip(clip)&&layerIds.has(clip.layerId)&&columnIds.has(clip.columnId));
    composerAssets = new Map();
    const sourceAssets = lightingSourceAssets();
    show.groups.forEach(group => sourceAssets.push({kind:'group',id:group.id,name:group.name,
      caption:`${group.fixtureIds.length} fixtures`,kindLabel:'GROUP',color:'#38c997'}));
    show.fixtures.forEach(fixture => sourceAssets.push({kind:'fixture',id:fixture.id,name:fixture.name,
      caption:`${fixture.universe}.${fixture.address}`,kindLabel:'FIXTURE',color:'#4ea1ff'}));
    byId('gslLiveGroups').innerHTML = sourceAssets.map(libraryAsset).join('');

    const destinations = {intensity:'gslIntensityPalettes',color:'gslColorPalettes',position:'gslPositionPalettes',beam:'gslBeamPalettes'};
    Object.entries(destinations).forEach(([family,id]) => {
      const palettes = show.palettes.filter(palette => paletteFamily(palette) === family);
      byId(id).innerHTML = palettes.length ? palettes.map(palette => libraryAsset({kind:'palette',id:palette.id,name:palette.name,
        caption:`${palette.mode} · ${(palette.attributes || []).join(', ')}`,kindLabel:family.toUpperCase(),
        color:family === 'color' ? paletteColor(palette) : ({intensity:'#ffb547',position:'#4ea1ff',beam:'#43c7d8'}[family]),
        swatch:family === 'color' ? paletteColor(palette) : ''})).join('') : `<div class="gsl-empty">Store a ${family} palette in Programmer.</div>`;
    });

    const cueAssets = show.cues.map(cue => {
      const sequence = show.sequences.find(item => item.cueIds.includes(cue.id));
      return {kind:'cue',id:cue.id,sequenceId:sequence && sequence.id || '',name:cue.name,
        caption:`${cue.fadeMs / 1000}s fade · ${Object.keys(cue.values || {}).length} fixtures`,kindLabel:'CUE',color:'#a980ff'};
    });
    byId('gslComposerCues').innerHTML = cueAssets.length ? cueAssets.map(libraryAsset).join('') : '<div class="gsl-empty">Recorded cues appear here.</div>';

    const fxAssets = [
      {kind:'effect-preset',id:'fx:pulse',preset:'pulse',name:'Neon Pulse',caption:'dimmer · sine',kindLabel:'FX SOURCE',color:'#a980ff'},
      {kind:'effect-preset',id:'fx:chase',preset:'chase',name:'Photon Chase',caption:'dimmer · square',kindLabel:'FX SOURCE',color:'#ea7ed5'},
      {kind:'effect-preset',id:'fx:sweep',preset:'sweep',name:'Orbit Sweep',caption:'pan · sine',kindLabel:'FX SOURCE',color:'#43c7d8'}
    ];
    show.effects.filter(effect => !String(effect.id).startsWith('composer:effect:')).forEach(effect => fxAssets.push({
      kind:'effect',id:effect.id,name:effect.name,caption:`${effect.attribute} · ${effect.waveform}`,kindLabel:'EFFECT',color:'#a980ff'}));
    byId('gslEffectPool').innerHTML = fxAssets.map(libraryAsset).join('');
    byId('gslComposerLibraryCount').textContent = String(composerAssets.size);

    $$('.gsl-library-section').forEach(section => {
      section.hidden = composerLibraryFilter !== 'all' && section.dataset.librarySection !== composerLibraryFilter;
    });
    $$('.gsl-library-tabs [data-library-filter]').forEach(button => {
      const on = button.dataset.libraryFilter === composerLibraryFilter;
      button.classList.toggle('on',on); button.setAttribute('aria-selected',String(on));
    });

    const count = columns.length;
    const activeColumnId = show.runtime && show.runtime.composer && show.runtime.composer.activeColumnId || '';
    const headers = [`<div class="gsl-composer-corner" role="columnheader"><small>LIGHTING LAYERS</small><strong>${layers.length} layers · ${columns.length} cues</strong></div>`]
      .concat(columns.map((column,index) => `<div class="gsl-cue-header ${column.id === activeColumnId ? 'active' : ''} ${column.id === selectedComposerColumnId ? 'selected' : ''}" role="columnheader" data-column-id="${safe(column.id)}" draggable="true">
        <button type="button" class="gsl-cue-go" data-trigger-column="${safe(column.id)}" aria-label="Go ${safe(column.name)}" title="Go ${safe(column.name)}">&#9654;</button>
        <button type="button" class="gsl-cue-select" data-select-column="${safe(column.id)}" aria-label="Select ${safe(column.name)}"><small>CUE ${String(index + 1).padStart(2,'0')}</small><strong>${safe(column.name)}</strong></button>
      </div>`)).join('');
    const header = byId('gslComposerCueHeaders'); header.style.setProperty('--cue-count',String(count)); header.innerHTML = headers;

    byId('gslComposerLayers').innerHTML = layers.map((layer,rowIndex) => {
      const targetLabel = composerTargetLabel(layer.target), activeId = composerActiveClipId(layer.id);
      const cells = columns.map((column,columnIndex) => {
        const clip = clips.find(item => item.layerId === layer.id && item.columnId === column.id);
        const selected = !!clip && clip.id === selectedComposerClipId;
        return `<div class="gsl-clip-slot ${selected ? 'selected' : ''}" role="gridcell" aria-selected="${selected}"
          data-layer-id="${safe(layer.id)}" data-column-id="${safe(column.id)}" data-row-index="${rowIndex}" data-column-index="${columnIndex}">
          ${clip ? `<button type="button" class="gsl-light-clip ${activeId === clip.id ? 'playing' : ''} ${selected ? 'selected' : ''} ${clip.enabled === false ? 'disabled' : ''}"
            draggable="true" data-clip-id="${safe(clip.id)}" style="--clip-color:${safe(clip.color || column.color || layer.color)}"
            aria-label="${safe(`${clip.name}, ${layer.name}, ${column.name}${activeId === clip.id ? ', playing' : ''}`)}">
            <span class="clip-type">${safe(composerClipType(clip))}</span><strong>${safe(clip.name)}</strong><small><span>${(clip.items || []).length} MOD</span><span>${Math.round((clip.level == null ? 1 : clip.level) * 100)}%</span></small>
          </button>` : `<button type="button" class="gsl-empty-clip" data-empty-slot aria-label="Empty clip, ${safe(layer.name)}, ${safe(column.name)}"><span aria-hidden="true">+</span>DROP LIGHT</button>`}
        </div>`;
      }).join('');
      return `<div class="gsl-layer-row" role="row" data-layer-row="${safe(layer.id)}" style="--cue-count:${count};--layer-color:${safe(layer.color || COMPOSER_COLORS[rowIndex % COMPOSER_COLORS.length])}">
        <div class="gsl-layer-control" role="rowheader" data-layer-target="${safe(layer.id)}">
          <div class="gsl-layer-main"><div class="gsl-layer-name"><i class="gsl-layer-glyph" aria-hidden="true">L${rowIndex + 1}</i><span><strong>${safe(layer.name)}</strong><small>${safe(targetLabel)}</small></span></div>
            <div class="gsl-layer-actions"><button type="button" data-layer-mute="${safe(layer.id)}" class="${layer.muted ? 'on' : ''}" aria-pressed="${!!layer.muted}" title="Mute ${safe(layer.name)}">M</button><button type="button" data-layer-solo="${safe(layer.id)}" class="${layer.solo ? 'on' : ''}" aria-pressed="${!!layer.solo}" title="Solo ${safe(layer.name)}">S</button><button type="button" data-layer-remove="${safe(layer.id)}" title="Remove ${safe(layer.name)}">×</button></div></div>
          <div class="gsl-layer-target"><i></i><span>${safe(targetLabel)}</span></div>
          <label class="gsl-layer-level"><input type="range" min="0" max="100" value="${Math.round((layer.level == null ? 1 : layer.level) * 100)}" data-layer-level="${safe(layer.id)}" aria-label="${safe(layer.name)} level"><output>${Math.round((layer.level == null ? 1 : layer.level) * 100)}</output></label>
        </div>${cells}
      </div>`;
    }).join('');

    const grid = byId('gslComposerGrid'); grid.style.setProperty('--cue-count',String(count));
    grid.setAttribute('aria-rowcount',String(layers.length)); grid.setAttribute('aria-colcount',String(columns.length));
    byId('gslComposerEmpty').hidden = !!clips.length || !!show.fixtures.length;
    renderComposerInspector();
  }

  function mapperPoint(position) {
    const source = position || {};
    const x = clamp(Number(source.x), -10, 10), y = clamp(Number(source.y), -6, 6);
    return {x,y,left:5 + ((x + 10) / 20) * 90,top:5 + ((6 - y) / 12) * 90};
  }

  function mapperFixtureCard(fixture) {
    const point = mapperPoint(fixture.position), profile = profileById(fixture.profileId);
    const selected = show.programmer.selectedFixtureIds.includes(fixture.id);
    const channels = profile && profile.channels || [];
    const colorCapable = channels.some(channel => COLOR_ATTRIBUTES.has(channel.attribute));
    const moving = channels.some(channel => POSITION_ATTRIBUTES.has(channel.attribute));
    const kind = moving ? 'moving' : colorCapable && channels.length > 4 ? 'panel' : 'fixture';
    return `<button type="button" class="gsl-map-fixture ${selected ? 'on' : ''}" data-map-fixture-id="${safe(fixture.id)}"
      style="--map-x:${point.left.toFixed(3)}%;--map-y:${point.top.toFixed(3)}%;--fixture-color:${colorCapable ? 'var(--gsl-magenta)' : 'var(--gsl-amber)'}"
      aria-pressed="${selected}" aria-label="${safe(`${fixture.name}, fixture ${fixtureNumber(fixture)}, universe ${fixture.universe} address ${fixture.address}. Drag to position.`)}">
      <i class="${kind}" aria-hidden="true"></i><strong>${fixtureNumber(fixture)}</strong><span>${safe(fixture.name)}</span><small>${fixture.universe}.${fixture.address}</small>
    </button>`;
  }

  function mapperCheck(ok, label, detail, action) {
    return `<button type="button" class="gsl-map-check ${ok ? 'ok' : 'attention'}" ${action ? `data-map-action="${safe(action)}"` : 'disabled'}>
      <i aria-hidden="true">${ok ? '&#10003;' : '!'}</i><span><strong>${safe(label)}</strong><small>${safe(detail)}</small></span>${action ? '<b aria-hidden="true">&#8250;</b>' : ''}
    </button>`;
  }

  function renderMapperInspector() {
    const selected = selectedFixtures(), fixture = selected[0], count = selected.length;
    byId('gslMapperSelectionCount').textContent = `${count} selected`;
    if (!fixture) {
      byId('gslMapperInspector').innerHTML = `<div class="gsl-map-no-selection"><span aria-hidden="true">&#8982;</span><p>Select a fixture on the stage or in the fixture browser to inspect its processor mapping.</p></div>`;
      return;
    }
    const profile = profileById(fixture.profileId), point = fixture.position || {x:0,y:0,z:0};
    byId('gslMapperInspector').innerHTML = `<div class="gsl-map-fixture-summary">
      <span>${fixtureNumber(fixture)}</span><div><strong>${safe(fixture.name)}</strong><small>${safe(profile ? `${profile.manufacturer} · ${profile.name}` : fixture.profileId)}</small></div>
    </div><div class="gsl-map-fields">
      <label>X<input type="number" step=".1" min="-10" max="10" data-map-field="x" value="${Number(point.x).toFixed(1)}"></label>
      <label>Y<input type="number" step=".1" min="-6" max="6" data-map-field="y" value="${Number(point.y).toFixed(1)}"></label>
      <label>Z<input type="number" step=".1" min="-20" max="20" data-map-field="z" value="${Number(point.z).toFixed(1)}"></label>
    </div><div class="gsl-map-address"><span>DMX route</span><strong>Universe ${fixture.universe} · ${fixture.address}–${fixture.address + Math.max(0,footprint(fixture) - 1)}</strong></div>
    ${count > 1 ? `<p class="gsl-map-multi">Position fields edit ${safe(fixture.name)}. Drag the selected fixtures individually to refine the stage map.</p>` : ''}`;
  }

  function renderMapper() {
    const validation = patchValidation(), universes = Object.keys(validation.universes || {});
    const profileIds = new Set(show.fixtures.map(fixture => fixture.profileId));
    const parameters = show.fixtures.reduce((total,fixture) => total + footprint(fixture),0);
    byId('gslMapperFixturesLayer').innerHTML = show.fixtures.map(mapperFixtureCard).join('');
    byId('gslMapperEmpty').hidden = !!show.fixtures.length;
    byId('gslMapperMetrics').innerHTML = `
      <div><strong>${show.fixtures.length}</strong><span>Fixtures</span></div>
      <div><strong>${profileIds.size}</strong><span>Device types</span></div>
      <div><strong>${universes.length}</strong><span>Universes</span></div>
      <div><strong>${parameters}</strong><span>Parameters</span></div>`;
    const ready = !!show.fixtures.length && validation.valid && !!universes.length;
    const state = byId('gslMapperHealthState');
    state.className = ready ? 'ready' : '';
    state.textContent = ready ? (bridgeState.outputting ? 'LIVE' : 'READY') : 'SETUP';
    byId('gslMapperChecks').innerHTML = [
      mapperCheck(!!show.fixtures.length,'Fixture definitions',show.fixtures.length ? `${profileIds.size} active device type${profileIds.size === 1 ? '' : 's'}` : 'Define fixtures or LED light panels first','fixtures'),
      mapperCheck(validation.valid && !!show.fixtures.length,'DMX patch',validation.valid ? (show.fixtures.length ? 'No address conflicts' : 'Waiting for fixtures') : `${validation.errors.length} address conflict${validation.errors.length === 1 ? '' : 's'}`,'patch'),
      mapperCheck(!!show.fixtures.length,'Stage positions',show.fixtures.length ? `${show.fixtures.length} fixtures mapped in X / Y / Z` : 'Nothing is placed on stage','map'),
      mapperCheck(!!universes.length,'Network route',universes.length ? `${universes.length} universe${universes.length === 1 ? '' : 's'} ready for Art-Net or sACN` : 'Patch fixtures to create output universes','network')
    ].join('');
    renderMapperInspector();
  }

  function selectionAttributes() {
    const seen = new Map();
    selectedFixtures().forEach(fixture => {
      const profile = profileById(fixture.profileId);
      (profile && profile.channels || []).forEach(channel => {
        if (!seen.has(channel.attribute)) seen.set(channel.attribute, channel.label || channel.attribute);
      });
    });
    return seen;
  }

  function programmerValue(fixtureId, attribute) {
    const direct = show.programmer.values[fixtureId] && show.programmer.values[fixtureId][attribute];
    if (direct != null) return tokenValue(direct);
    return tokenValue(evaluated.fixtureValues[fixtureId] && evaluated.fixtureValues[fixtureId][attribute]);
  }
  function channelFor(fixture, attribute) {
    const profile = fixture && profileById(fixture.profileId);
    return profile && (profile.channels || []).find(channel => channel.attribute === attribute) || null;
  }
  function selectionChannel(attribute) {
    for (const fixture of selectedFixtures()) { const channel = channelFor(fixture, attribute); if (channel) return channel; }
    return null;
  }
  /* Band name and Hz for a channel with a function table, plain percent
     otherwise. The Fixture Sheet printed "50%" for a shutter that was
     strobing at 13 Hz, and the encoder's "Open" was a 3% window. */
  function readout(fixture, attribute) {
    const value = programmerValue(fixture.id, attribute), channel = channelFor(fixture, attribute);
    return channel && Engine.describeChannelValue ? Engine.describeChannelValue(channel, value).text : `${Math.round(value * 100)}%`;
  }
  function describeSelectionValue(attribute, value) {
    const channel = selectionChannel(attribute);
    return channel && Engine.describeChannelValue ? Engine.describeChannelValue(channel, value).text : `${Math.round(value * 100)}%`;
  }

  function renderProgrammer() {
    /* The sheet shows the first 12 attributes and used to stop there in
       silence, so a 32-channel mover displayed 12 columns and gave the
       operator no way to know the other 20 existed. */
    const allAttributes = [...selectionAttributes().keys()];
    const attributes = allAttributes.slice(0, 12);
    const hidden = allAttributes.length - attributes.length;
    const overflowHead = hidden
      ? `<th class="gsl-sheet-overflow" title="${hidden} further attribute${hidden===1?'':'s'} on this selection are not shown in the sheet; reach them from the feature tabs and encoders below">+${hidden} more</th>`
      : '';
    byId('gslProgrammerHead').innerHTML = `<tr><th>FID</th><th>Fixture</th>${attributes.map(attribute => `<th>${safe(attribute)}</th>`).join('')}${overflowHead}</tr>`;
    const fixtures = selectedFixtures();
    byId('gslProgrammerBody').innerHTML = fixtures.length ? fixtures.map(fixture => `<tr class="selected"><td>${fixtureNumber(fixture)}</td><td>${safe(fixture.name)}</td>${attributes.map(attribute => {
      const direct = show.programmer.values[fixture.id] && show.programmer.values[fixture.id][attribute];
      return `<td class="${direct != null ? 'active' : ''}" title="${safe(attribute)}">${safe(readout(fixture, attribute))}</td>`;
    }).join('')}${hidden ? '<td class="gsl-sheet-overflow">…</td>' : ''}</tr>`).join('') : `<tr><td colspan="${attributes.length + 2 + (hidden ? 1 : 0)}">Select fixtures to show programmer values.</td></tr>`;
    $$('.gsl-feature-tabs button').forEach(button => {
      const on = button.dataset.feature === feature;
      button.classList.toggle('on', on); button.setAttribute('aria-selected',String(on));
    });
    const available = [...selectionAttributes()].filter(([attribute]) => attributeFamily(attribute) === feature);
    byId('gslEncoders').innerHTML = available.length ? available.map(([attribute,label]) => {
      const values = fixtures.map(fixture => programmerValue(fixture.id,attribute));
      const value = values.length ? values.reduce((sum,item) => sum + item,0) / values.length : 0;
      /* A channel with a function table gets its flat bands as keys and,
         when a band is a rate, a Hz entry. Before this the only control on a
         shutter was a 0-100% slider whose Open band was 3% wide, so nudging
         it strobed the fixture. */
      const channel = selectionChannel(attribute), bands = channel ? (channel.functions || []) : [];
      const flat = bands.filter(fn => Number(fn.displayStart) === Number(fn.displayEnd));
      const hasRate = !!channel && typeof Engine.strobeFraction === 'function' && Engine.strobeFraction(channel, 1) != null;
      const current = channel && Engine.describeChannelValue ? Engine.describeChannelValue(channel, value) : null;
      const bandRow = bands.length ? `<div class="gsl-encoder-bands" data-attribute="${safe(attribute)}">${flat.map(fn =>
        `<button type="button" data-band="${safe(fn.id || fn.name)}" aria-pressed="${String(!!(current && current.band && current.band === fn))}">${safe(fn.name || fn.id)}</button>`).join('')}${hasRate
        ? `<label>Hz <input type="number" data-band-hz min="0" step="0.5" value="${current && current.rate != null ? Math.round(current.rate * 10) / 10 : ''}" aria-label="${safe(label)} strobe rate in Hz"></label>`
        : ''}</div>` : '';
      return `<label class="gsl-encoder" data-attribute="${safe(attribute)}"><header><strong>${safe(label)}</strong><output>${safe(describeSelectionValue(attribute, value))}</output></header>
        <div class="encoder-wheel" style="--value:${Math.round(value * 300)}deg"></div>
        <input type="range" min="0" max="100" value="${Math.round(value * 100)}" aria-label="${safe(label)}"></label>${bandRow}`;
    }).join('') : `<div class="gsl-empty">The selected fixtures have no ${safe(feature)} attributes.</div>`;
    byId('gslProgrammerSource').textContent = show.programmer.blind ? 'Blind programmer · not on output' : 'Programmer priority';
  }

  function patchValidation() { try { return Engine.validatePatch(show); } catch (_) { return {valid:false,errors:[],warnings:[],universes:{}}; } }

  function renderPatch() {
    const select = byId('gslPatchProfile'), current = select.value;
    const transient = selectedCatalogProfile && !show.profiles.some(profile => profile.id === selectedCatalogProfile.id)
      ? [selectedCatalogProfile] : [];
    select.innerHTML = transient.map(profile => `<option value="${safe(profile.id)}">★ ${safe(profile.manufacturer)} · ${safe(profile.name)} · ${safe(profile.mode)} (${profile.footprint}ch)</option>`).join('')
      + show.profiles.map(profile => `<option value="${safe(profile.id)}">${safe(profile.manufacturer)} · ${safe(profile.name)} · ${safe(profile.mode)} (${profile.footprint}ch)</option>`).join('');
    if ([...transient,...show.profiles].some(profile => profile.id === current)) select.value = current;
    else if (transient.length) select.value = transient[0].id;
    const validation = patchValidation(), conflicts = new Set(validation.errors.flatMap(error => error.fixtureIds || []));
    const universes = Object.keys(validation.universes || {});
    byId('gslPatchSummary').innerHTML = `<span><strong>${show.fixtures.length}</strong> fixtures</span><span><strong>${universes.length}</strong> universes</span><span><strong>${show.fixtures.reduce((sum,fixture) => sum + footprint(fixture),0)}</strong> patched parameters</span><span>${validation.valid ? 'No address conflicts' : `<strong>${validation.errors.length}</strong> patch errors`}</span>`;
    byId('gslPatchBody').innerHTML = show.fixtures.length ? show.fixtures.map(fixture => {
      const profile = profileById(fixture.profileId), conflict = conflicts.has(fixture.id);
      return `<tr data-fixture-id="${safe(fixture.id)}" class="${conflict ? 'conflict' : ''}">
        <td><input class="gsl-patch-checkbox" type="checkbox" ${show.programmer.selectedFixtureIds.includes(fixture.id) ? 'checked' : ''} aria-label="Select ${safe(fixture.name)}"></td>
        <td>${fixtureNumber(fixture)}</td>
        <td><input data-patch-field="name" value="${safe(fixture.name)}"></td>
        <td>${safe(profile ? `${profile.manufacturer} · ${profile.name}` : fixture.profileId)}</td>
        <td><input data-patch-field="universe" type="number" min="1" max="63999" value="${fixture.universe}"></td>
        <td><input data-patch-field="address" type="number" min="1" max="512" value="${fixture.address}"></td>
        <td>${profile ? profile.footprint : 'N/A'}</td>
        <td><input data-patch-field="x" type="number" step=".1" value="${fixture.position.x}"></td>
        <td><input data-patch-field="y" type="number" step=".1" value="${fixture.position.y}"></td>
        <td><span class="gsl-patch-status ${conflict ? 'error' : ''}"><i></i>${conflict ? 'Conflict' : fixture.enabled ? 'Patched' : 'Held'}</span></td>
      </tr>`;
    }).join('') : '<tr><td colspan="10">No fixtures patched. Choose a profile and press PATCH.</td></tr>';
  }

  function personalityStatus(message, tone) {
    const output = byId('gslPersonalityStatus');
    if (!output) return;
    output.textContent = message || 'Ready'; output.dataset.tone = tone || 'info';
  }

  function drawPersonalityPreview(profile) {
    if (profile) personalityPreviewProfile = profile;
    const canvas = byId('gslPersonalityPreview'), panel = byId('gslPersonalityLibrary');
    if (!canvas || !panel || panel.hidden || !PersonalityPreview) return;
    if (!personalityPreviewStarted) personalityPreviewStarted = performance.now();
    const paint = now => {
      personalityPreviewFrame = 0;
      if (panel.hidden || !canvas.isConnected) return;
      PersonalityPreview.draw(canvas,personalityPreviewProfile,(now-personalityPreviewStarted)/1000);
      const name = byId('gslPersonalityPreviewName');
      if (name) name.textContent = personalityPreviewProfile
        ? `${personalityPreviewProfile.name} · ${personalityPreviewProfile.mode}` : 'Select a fixture sample';
      personalityPreviewFrame = requestAnimationFrame(paint);
    };
    if (!personalityPreviewFrame) personalityPreviewFrame = requestAnimationFrame(paint);
  }

  async function renderPersonalityLibrary() {
    const panel = byId('gslPersonalityLibrary'), results = byId('gslPersonalityResults');
    if (!panel || panel.hidden || !results) return;
    const token = ++personalityRenderToken;
    if (!Personalities) {
      results.innerHTML = '<div class="gsl-empty">The local fixture sample provider is not loaded.</div>';
      personalityStatus('Provider unavailable','error'); return;
    }
    results.innerHTML = '<div class="gsl-empty">Loading offline fixture samples…</div>';
    try {
      const query = byId('gslPersonalitySearch').value || '';
      const [rows,stats] = await Promise.all([Personalities.search(query,{limit:160}),Personalities.stats()]);
      if (token !== personalityRenderToken || panel.hidden) return;
      personalityCatalogRows=new Map(rows.filter(profile=>profile&&typeof profile.id==='string')
        .map(profile=>[profile.id,profile]));
      byId('gslPersonalityStats').textContent = `${stats.samples} samples · ${stats.authored||0} authored · ${stats.imported} imported · ${stats.categories} families`;
      results.innerHTML = rows.length ? rows.map(profile => `<button type="button" class="gsl-personality-row ${selectedCatalogLibraryId===profile.id?'on':''}" role="option" aria-selected="${selectedCatalogLibraryId===profile.id}" data-personality-id="${safe(profile.id)}" draggable="true" title="Preview this fixture personality, or drag it to a SHOWAVE Clip Slot as one adjustable light" aria-label="${safe(`${profile.manufacturer} ${profile.name}, ${profile.mode}. Preview, or drag to a SHOWAVE Clip Slot.`)}">
        <strong>${safe(profile.manufacturer)} · ${safe(profile.name)}</strong>
        <small>${safe(profile.category || 'Custom profile')} · ${safe(profile.mode)} · ${profile.footprint}ch footprint${profile.authored?' · LOCAL AUTHOR':''}${/hazardous/.test(profile.safety||'')?' · HAZARD CHECK':''}</small><span>DRAG LIGHT</span>
      </button>`).join('') : '<div class="gsl-empty">No local fixture samples or custom modes match this search.</div>';
      const edit=byId('gslEditPersonality');if(edit)edit.disabled=!selectedCatalogProfile;
      if (!personalityImporting) personalityStatus(rows.length ? `${rows.length} mode${rows.length===1?'':'s'} shown` : 'No matches');
      if (selectedCatalogProfile || personalityPreviewProfile) drawPersonalityPreview(selectedCatalogProfile || personalityPreviewProfile);
      else if (rows[0]) Personalities.getProfile(rows[0].id).then(profile => {
        if (profile && token === personalityRenderToken && !panel.hidden) drawPersonalityPreview(profile);
      }).catch(()=>{});
    } catch (error) {
      if (token !== personalityRenderToken) return;
      results.innerHTML = `<div class="gsl-empty">${safe(error.message || error)}</div>`;
      personalityStatus('Could not read library','error');
    }
  }

  function openPersonalityLibrary() {
    const panel = byId('gslPersonalityLibrary'); if (!panel) return;
    panel.hidden = false; personalityPreviewStarted = performance.now(); renderPersonalityLibrary(); drawPersonalityPreview();
    requestAnimationFrame(()=>byId('gslPersonalitySearch')?.focus());
  }

  function closePersonalityLibrary() {
    const panel = byId('gslPersonalityLibrary'); if (!panel) return;
    if (!closePersonalityBuilder(false)) return;
    panel.hidden = true; personalityRenderToken++;
    if (personalityPreviewFrame) cancelAnimationFrame(personalityPreviewFrame);
    personalityPreviewFrame = 0;
  }

  function catalogProfileSignature(profile) {
    if(!profile)return '';
    return JSON.stringify({name:profile.name,manufacturer:profile.manufacturer,mode:profile.mode,
      footprint:profile.footprint,channels:profile.channels||[],virtualControls:profile.virtualControls||[]});
  }

  function selectCatalogProfile(rawProfile) {
    if (!rawProfile || typeof rawProfile !== 'object') return false;
    try {
      const libraryId=rawProfile.id||'local-fixture-profile';
      let selected = Engine.normaliseProfile
        ? Engine.normaliseProfile(rawProfile, rawProfile.id || 'local-fixture-profile') : clone(rawProfile);
      const embedded=profileById(libraryId);
      if(embedded&&catalogProfileSignature(embedded)!==catalogProfileSignature(selected)){
        const source=selected.source||{},revision=source.revision||source.digest||source.updatedAt||Date.now();
        selected.id=`${libraryId}:show-revision:${builderKey(revision).slice(0,32)}`;
        selected.source=Object.assign({},source,{libraryProfileId:libraryId});
      }else if(embedded)selected=embedded;
      selectedCatalogLibraryId=libraryId;selectedCatalogProfile=selected;
      personalityPreviewProfile = selectedCatalogProfile; drawPersonalityPreview(selectedCatalogProfile);
      setWorkspace('patch'); renderPatch();
      byId('gslPatchProfile').value = selectedCatalogProfile.id;
      byId('gslPatchName').value = selectedCatalogProfile.name;
      const edit=byId('gslEditPersonality');if(edit)edit.disabled=false;
      status(`${selectedCatalogProfile.manufacturer} · ${selectedCatalogProfile.name} · ${selectedCatalogProfile.mode} selected${embedded&&selectedCatalogProfile.id!==libraryId?' as a separate show revision':''}. Set quantity and address, then press PATCH.`,'success');
      renderPersonalityLibrary(); return true;
    } catch (error) { status(`That fixture mode could not be selected: ${error.message}`,'error'); return false; }
  }

  async function chooseCatalogProfile(id) {
    if (!Personalities) return false;
    personalityStatus('Loading selected mode…');
    try {
      const profile = await Personalities.getProfile(id);
      if (!profile) throw new Error('The selected local fixture mode no longer exists.');
      const selected = selectCatalogProfile(profile);
      if (selected) personalityStatus(profile.source && profile.source.sample ? 'Local sample ready to patch'
        : profile.source && profile.source.authored ? 'Locally authored mode ready to patch' : 'Imported mode ready to patch','success');
      return selected;
    } catch (error) { personalityStatus(error.message || String(error),'error'); return false; }
  }

  async function previewCatalogProfile(id) {
    if (!Personalities || typeof id !== 'string' || !id) return false;
    personalityStatus('Loading fixture preview…');
    try {
      const profile=await Personalities.getProfile(id);
      if (!profile) throw new Error('The selected local fixture mode no longer exists.');
      selectedCatalogLibraryId=id;selectedCatalogProfile=profile;personalityPreviewProfile=profile;
      $$('#gslPersonalityResults [data-personality-id]').forEach(row=>{
        const selected=row.dataset.personalityId===id;
        row.classList.toggle('on',selected);row.setAttribute('aria-selected',String(selected));
      });
      const edit=byId('gslEditPersonality');if(edit)edit.disabled=false;
      personalityPreviewStarted=performance.now();drawPersonalityPreview(profile);
      personalityStatus(`${profile.name} · preview only · drag to SHOWAVE to create Quantity 1`,'success');
      status(`Lighting preview · ${profile.manufacturer} · ${profile.name}. Drag it to a SHOWAVE Clip Slot; no patch or output changed.`,'success');
      return true;
    } catch (error) { personalityStatus(error.message||String(error),'error'); return false; }
  }

  async function importPersonalityFiles(fileList) {
    if (!Personalities || personalityImporting) return;
    /* .R20 is the plain-text Titan/Pearl personality, and it is what
       manufacturers actually publish - a fixture download unzips to one .R20
       per DMX mode. This window took .d4 only while the main SHOWAVE window
       took both (app.js), so the same operator dropping the same folder into
       the two windows got two different answers, and the GSL5 one failed with
       a message that never mentioned the format it had just refused. */
    const files = Array.from(fileList || []).filter(file => /\.(?:d4|r20)$/i.test(file.name || ''));
    if (!files.length) return personalityStatus('No Avolites .d4 or .R20 files were selected','warning');
    personalityImporting = true;
    personalityStatus(`Importing 0 / ${files.length}…`);
    try {
      const result = await Personalities.importFiles(files,{onProgress:progress=>{
        personalityStatus(`Importing ${progress.completed} / ${progress.total} · ${progress.profiles} modes`);
      }});
      const failed = result.errors.length;
      /* Parser warnings are the operator's only signal that a channel was
         dropped or a type letter guessed at, so the count travels with the
         result rather than dying inside the provider. */
      const warned = Array.isArray(result.warnings) ? result.warnings.length : 0;
      personalityStatus(`${result.profiles} mode${result.profiles===1?'':'s'} imported${failed?` · ${failed} file${failed===1?'':'s'} skipped`:''}${warned?` · ${warned} warning${warned===1?'':'s'}`:''}`,failed||warned?'warning':'success');
      status(`Local personality library: ${result.profiles} mode${result.profiles===1?'':'s'} imported from ${result.files} file${result.files===1?'':'s'}${warned?`, with ${warned} channel warning${warned===1?'':'s'} - check the modes before arming output`:''}.`,failed||warned?'warning':'success');
    } catch (error) { personalityStatus(error.message || String(error),'error'); status(`Personality import failed: ${error.message}`,'error'); }
    finally { personalityImporting = false; renderPersonalityLibrary(); }
  }

  /* Personality Builder ---------------------------------------------------
     Drafts stay outside the show and lighting runtime. The provider performs
     strict validation before IndexedDB persistence; the canvas consumes only
     a temporary profile and can never send a bridge frame. */
  const builderKey = value => String(value || 'control').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,72) || 'control';
  const builderTitle = value => String(value || 'Control').split('-').map(word=>word?word[0].toUpperCase()+word.slice(1):'').join(' ');
  const builderFamily = semantic => INTENSITY_ATTRIBUTES.has(semantic) ? 'intensity'
    : POSITION_ATTRIBUTES.has(semantic) ? 'position' : COLOR_ATTRIBUTES.has(semantic) ? 'color'
      : ['zoom','focus','iris','gobo','gobo-rotation','prism','prism-rotation','frost','animation-wheel'].includes(semantic) ? 'beam' : 'control';

  function builderChannel(semantic, offset, options) {
    const config=options&&typeof options==='object'?options:{}, key=builderKey(config.attribute||semantic);
    const bits=Number(config.bits)===16?16:8;
    return {attribute:key,semantic:builderKey(semantic),family:config.family||builderFamily(builderKey(semantic)),
      label:config.label||builderTitle(key),offset:Number(offset),bits,
      fineOffset:bits===16?Number(config.fineOffset==null?Number(offset)+1:config.fineOffset):null,
      default:config.default==null?(['pan','tilt'].includes(semantic)?.5:0):Number(config.default),
      locate:config.locate==null?(['dimmer','intensity'].includes(semantic)?1:null):config.locate,
      powerOn:0,highlight:null,lowlight:null,mix:['dimmer','intensity'].includes(semantic)?'htp':'ltp',
      functions:Array.isArray(config.functions)?clone(config.functions):[],cell:config.cell?clone(config.cell):null};
  }

  function blankBuilderDraft() {
    return {id:'',manufacturer:'GSL5 User',name:'',mode:'1 channel',category:'User Personalities',
      footprint:1,safety:'verify-fixture-manual',description:'',channels:[builderChannel('dimmer',0)]};
  }

  function draftFromProfile(profile, editInPlace) {
    const source=profile&&profile.source||{}, result={
      id:editInPlace?profile.id:'', manufacturer:profile.manufacturer||'GSL5 User',
      name:editInPlace?profile.name:`${profile.name||'Fixture'} Copy`, mode:profile.mode||`${profile.footprint||1} channel`,
      category:source.category||'User Personalities', footprint:Number(profile.footprint)||1,
      safety:source.safety||'verify-fixture-manual', description:source.description||'',
      channels:(profile.channels||[]).map(channel=>{
        const copy=clone(channel);copy.functions=Array.isArray(copy.functions)?copy.functions:[];
        if(['dimmer','intensity'].includes(builderKey(copy.semantic||copy.attribute)))copy.mix='htp';
        else if(!['htp','ltp'].includes(String(copy.mix||'').toLowerCase()))copy.mix='ltp';
        return copy;
      }), virtualControls:clone(profile.virtualControls||[])
    };
    if(editInPlace) result.source=clone(source);
    return result;
  }

  function builderCategories() {
    return [...new Set(['User Personalities',...(Personalities&&Personalities.sampleCategories||[]),
      'LED PAR & Wash','Moving Heads','Pixels & Battens','White Light & Theatre','Atmospherics & Special FX','Control & Test'])];
  }

  function fitBuilderFootprint() {
    if(!builderDraft)return 1;
    builderDraft.footprint=Math.max(1,...builderDraft.channels.map(channel=>Math.max(Number(channel.offset)||0,
      Number(channel.bits)===16?(Number(channel.fineOffset)||0):0)+1));
    return builderDraft.footprint;
  }

  function setBuilderDirty(message) {
    builderDirty=true;
    const output=byId('gslBuilderStatus'); if(output){output.textContent=message||'Unsaved changes';output.dataset.tone='warning';}
  }

  const builderPercent = value => value == null || value === '' ? '' : Math.round(Number(value)*1000)/10;
  const builderPercentLabel = value => value == null || value === '' ? 'N/A' : `${builderPercent(value)}%`;
  const builderChannelName = (channel,index) => channel && (channel.label || channel.attribute) || `Channel ${index + 1}`;
  const builderIntensityChannel = channel => ['dimmer','intensity'].includes(builderKey(channel && (channel.semantic || channel.attribute)));

  /* The provider owns canonical profile validation. These checks cover the
     authoring-only function editor before the provider deliberately clamps a
     DMX value during normalization. Imported D4 modes are never rewritten by
     this path. */
  function assessBuilderCapabilities(draft) {
    const errors=[],warnings=[];
    (draft&&draft.channels||[]).forEach((channel,index)=>{
      const label=builderChannelName(channel,index),bits=Number(channel.bits)===16?16:8,maximum=bits===16?65535:255;
      const suppliedMix=String(channel.mix||'').toLowerCase();
      if(builderIntensityChannel(channel)){
        if(suppliedMix!=='htp') warnings.push(`${label} is an intensity attribute and will use fixed HTP mixing.`);
      }else if(suppliedMix!=='htp'&&suppliedMix!=='ltp') errors.push(`${label} needs an HTP or LTP mix rule.`);
      const ranges=[];
      (Array.isArray(channel.functions)?channel.functions:[]).forEach((fn,functionIndex)=>{
        const functionLabel=String(fn&&fn.name||'').trim()||`Function ${functionIndex+1}`;
        if(!String(fn&&fn.name||'').trim())errors.push(`${label} function ${functionIndex+1} needs a name.`);
        const start=Number(fn&&fn.dmxStart),end=Number(fn&&fn.dmxEnd);
        if(!Number.isInteger(start)||start<0||start>maximum)errors.push(`${label} · ${functionLabel} DMX start must be an integer from 0 to ${maximum}.`);
        if(!Number.isInteger(end)||end<0||end>maximum)errors.push(`${label} · ${functionLabel} DMX end must be an integer from 0 to ${maximum}.`);
        if(Number.isInteger(start)&&Number.isInteger(end)&&start>end)errors.push(`${label} · ${functionLabel} DMX start cannot exceed DMX end.`);
        if(!Number.isFinite(Number(fn&&fn.displayStart)))errors.push(`${label} · ${functionLabel} display start must be numeric.`);
        if(!Number.isFinite(Number(fn&&fn.displayEnd)))errors.push(`${label} · ${functionLabel} display end must be numeric.`);
        if(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end<=maximum&&start<=end)ranges.push({start,end,name:functionLabel});
      });
      ranges.sort((left,right)=>left.start-right.start||left.end-right.end).forEach((range,rangeIndex,all)=>{
        const previous=all[rangeIndex-1];
        if(previous&&range.start<=previous.end)errors.push(`${label} functions “${previous.name}” and “${range.name}” overlap at DMX ${range.start}–${Math.min(previous.end,range.end)}.`);
      });
    });
    return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
  }

  function renderBuilderStatePreview() {
    const target=byId('gslBuilderStatePreview');if(!target||!builderDraft)return;
    const index=Math.max(0,Math.min(builderDraft.channels.length-1,Number(builderFunctionChannelIndex)||0));
    const channel=builderDraft.channels[index];
    if(!channel){target.innerHTML='<p class="gsl-builder-state-empty">Add a physical DMX channel to preview its mix, locate, highlight and function ranges.</p>';return;}
    builderFunctionChannelIndex=index;
    const functions=Array.isArray(channel.functions)?channel.functions:[],bits=Number(channel.bits)===16?16:8;
    target.innerHTML=`<div class="gsl-builder-state-summary">
      <strong>${safe(builderChannelName(channel,index))}</strong><span>${builderIntensityChannel(channel)?'HTP':safe(String(channel.mix||'ltp').toUpperCase())} · ${bits}-BIT</span>
      <div class="gsl-builder-state-values"><span>Default<b>${builderPercentLabel(channel.default)}</b></span><span>Locate<b>${builderPercentLabel(channel.locate)}</b></span><span>Highlight<b>${builderPercentLabel(channel.highlight)}</b></span></div>
      <ul class="gsl-builder-state-functions">${functions.length?functions.map(fn=>`<li><span>${safe(fn.name||'Unnamed function')}</span><span>DMX ${safe(fn.dmxStart)}–${safe(fn.dmxEnd)} · ${safe(fn.displayStart)}–${safe(fn.displayEnd)}</span></li>`).join(''):'<li><span>No named DMX functions</span><span>continuous attribute</span></li>'}</ul>
    </div>`;
  }

  function updateBuilderAssessment() {
    if(!builderDraft||!Personalities||typeof Personalities.validateAuthoredProfile!=='function')return null;
    const providerAssessment=Personalities.validateAuthoredProfile(builderDraft),capabilityAssessment=assessBuilderCapabilities(builderDraft);
    builderAssessment=Object.assign({},providerAssessment,{
      valid:providerAssessment.valid&&!capabilityAssessment.errors.length,
      errors:[...new Set([...(providerAssessment.errors||[]),...capabilityAssessment.errors])],
      warnings:[...new Set([...(providerAssessment.warnings||[]),...capabilityAssessment.warnings])]
    });
    const errors=builderAssessment.errors||[],warnings=builderAssessment.warnings||[];
    const validation=byId('gslBuilderValidation');
    if(validation) validation.innerHTML=errors.length||warnings.length
      ? errors.map(message=>`<p class="gsl-builder-diagnostic error">${safe(message)}</p>`).join('')+
        warnings.map(message=>`<p class="gsl-builder-diagnostic">${safe(message)}</p>`).join('')
      : `<p class="gsl-builder-diagnostic success">Channel map is valid. ${isSessionOnly()?'Keeping it for this session':'Saving'} leaves physical output disarmed.</p>`;
    const cells=new Set(builderDraft.channels.map(channel=>channel.cell&&channel.cell.id).filter(Boolean));
    const functionCount=builderDraft.channels.reduce((count,channel)=>count+(Array.isArray(channel.functions)?channel.functions.length:0),0);
    const htpCount=builderDraft.channels.filter(channel=>String(channel.mix).toLowerCase()==='htp'||builderIntensityChannel(channel)).length;
    const metrics=byId('gslBuilderMetrics'); if(metrics)metrics.innerHTML=
      `<span><strong>${builderDraft.channels.length}</strong>attributes</span><span><strong>${Number(builderDraft.footprint)||0}</strong>DMX slots</span><span><strong>${functionCount}</strong>functions</span><span><strong>${htpCount}/${Math.max(0,builderDraft.channels.length-htpCount)}</strong>HTP/LTP</span><span><strong>${cells.size}</strong>cells</span>`;
    const saveButton=byId('gslBuilderSave'),patchButton=byId('gslBuilderPatch'),exportButton=byId('gslBuilderExport');
    [saveButton,patchButton,exportButton].forEach(button=>{if(button)button.disabled=!builderAssessment.valid;});
    renderSessionControls();
    const name=byId('gslBuilderPreviewName'); if(name)name.textContent=`${builderDraft.name||'New fixture'} · ${builderDraft.mode||'New mode'}`;
    const output=byId('gslBuilderStatus');
    if(output&&builderDirty){output.textContent=errors.length?`${errors.length} error${errors.length===1?'':'s'} to fix`:warnings.length?`Ready · ${warnings.length} warning${warnings.length===1?'':'s'}`:isSessionOnly()?'Ready to keep for this session':'Ready to save';output.dataset.tone=errors.length?'error':'warning';}
    renderBuilderStatePreview();
    return builderAssessment;
  }

  function startBuilderPreview() {
    if(builderPreviewFrame||!PersonalityPreview)return;
    builderPreviewStarted=performance.now();
    const paint=now=>{
      builderPreviewFrame=0;
      const form=byId('gslPersonalityBuilder'),canvas=byId('gslBuilderPreview');
      if(!form||form.hidden||!canvas||!canvas.isConnected)return;
      const assessment=builderAssessment||updateBuilderAssessment();
      if(assessment&&assessment.profile){const preview=clone(assessment.profile);preview.name=builderDraft.name||'New personality';preview.mode=builderDraft.mode||'New mode';PersonalityPreview.draw(canvas,preview,(now-builderPreviewStarted)/1000);}
      builderPreviewFrame=requestAnimationFrame(paint);
    };
    builderPreviewFrame=requestAnimationFrame(paint);
  }

  function renderBuilderFunctions(channel,index) {
    const functions=Array.isArray(channel.functions)?channel.functions:[],maximum=Number(channel.bits)===16?65535:255;
    const rows=functions.map((fn,functionIndex)=>`<tr data-builder-function-index="${functionIndex}">
      <td><input maxlength="96" value="${safe(fn.name||'')}" data-builder-function-field="name" aria-label="Function ${functionIndex+1} name for ${safe(builderChannelName(channel,index))}"></td>
      <td><input type="number" min="0" max="${maximum}" step="1" value="${safe(fn.dmxStart)}" data-builder-function-field="dmxStart" aria-label="Function ${functionIndex+1} DMX start"></td>
      <td><input type="number" min="0" max="${maximum}" step="1" value="${safe(fn.dmxEnd)}" data-builder-function-field="dmxEnd" aria-label="Function ${functionIndex+1} DMX end"></td>
      <td><input type="number" step="any" value="${safe(fn.displayStart)}" data-builder-function-field="displayStart" aria-label="Function ${functionIndex+1} display start"></td>
      <td><input type="number" step="any" value="${safe(fn.displayEnd)}" data-builder-function-field="displayEnd" aria-label="Function ${functionIndex+1} display end"></td>
      <td><button type="button" data-builder-function-action="delete" title="Delete function" aria-label="Delete function ${functionIndex+1}">×</button></td>
    </tr>`).join('');
    return `<tr class="gsl-builder-functions-row" data-builder-index="${index}"><td colspan="16">
      <section class="gsl-builder-functions" aria-label="DMX functions for ${safe(builderChannelName(channel,index))}">
        <header><div><strong>DMX functions / capabilities</strong><small>${Number(channel.bits)===16?'16-bit · 0–65535':'8-bit · 0–255'} · ranges cannot overlap</small></div><button type="button" data-builder-function-action="add">+ FUNCTION</button></header>
        ${functions.length?`<table class="gsl-builder-function-table"><thead><tr><th>Name</th><th>DMX start</th><th>DMX end</th><th>Display start</th><th>Display end</th><th></th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="gsl-builder-function-empty">No named ranges. Add a function for shutter bands, gobos, macros, wheels or other discrete DMX capabilities.</div>'}
      </section>
    </td></tr>`;
  }

  function renderBuilderChannels() {
    const body=byId('gslBuilderChannelBody'); if(!body||!builderDraft)return;
    const families=['intensity','position','color','beam','control'];
    if(builderFunctionChannelIndex>=builderDraft.channels.length)builderFunctionChannelIndex=Math.max(0,builderDraft.channels.length-1);
    body.innerHTML=builderDraft.channels.map((channel,index)=>{
      const cell=channel.cell||{},bits=Number(channel.bits)===16?16:8,intensity=builderIntensityChannel(channel);
      const mix=intensity?'htp':String(channel.mix).toLowerCase()==='htp'?'htp':'ltp',functions=Array.isArray(channel.functions)?channel.functions:[];
      const main=`<tr data-builder-channel-row data-builder-index="${index}">
        <td>${index+1}</td>
        <td><input type="number" min="1" max="512" value="${Number(channel.offset)+1}" data-builder-channel-field="offset" aria-label="Coarse DMX for channel ${index+1}"></td>
        <td><input type="number" min="1" max="512" value="${bits===16?Number(channel.fineOffset)+1:''}" ${bits===16?'':'disabled'} data-builder-channel-field="fineOffset" aria-label="Fine DMX for channel ${index+1}"></td>
        <td><input maxlength="72" value="${safe(channel.attribute)}" data-builder-channel-field="attribute" aria-label="Attribute ID for channel ${index+1}"></td>
        <td><input maxlength="72" value="${safe(channel.semantic||channel.attribute)}" data-builder-channel-field="semantic" aria-label="Semantic for channel ${index+1}"></td>
        <td><select data-builder-channel-field="family" aria-label="Feature family for channel ${index+1}">${families.map(family=>`<option value="${family}" ${channel.family===family?'selected':''}>${family}</option>`).join('')}</select></td>
        <td><select data-builder-channel-field="bits" aria-label="Resolution for channel ${index+1}"><option value="8" ${bits===8?'selected':''}>8</option><option value="16" ${bits===16?'selected':''}>16</option></select></td>
        <td><select data-builder-channel-field="mix" aria-label="HTP or LTP mix for channel ${index+1}" ${intensity?'disabled title="Intensity attributes use fixed HTP mixing"':''}><option value="htp" ${mix==='htp'?'selected':''}>HTP</option><option value="ltp" ${mix==='ltp'?'selected':''}>LTP</option></select></td>
        <td><input type="number" min="0" max="100" step=".1" value="${builderPercent(channel.default)}" data-builder-channel-field="default" aria-label="Default percent for channel ${index+1}"></td>
        <td><input type="number" min="0" max="100" step=".1" value="${builderPercent(channel.locate)}" placeholder="N/A" data-builder-channel-field="locate" aria-label="Locate percent for channel ${index+1}"></td>
        <td><input type="number" min="0" max="100" step=".1" value="${builderPercent(channel.highlight)}" placeholder="N/A" data-builder-channel-field="highlight" aria-label="Highlight percent for channel ${index+1}"></td>
        <td><input maxlength="64" value="${safe(cell.id||'')}" placeholder="master" data-builder-channel-field="cellId" aria-label="Cell ID for channel ${index+1}"></td>
        <td><input type="number" min="0" max="255" value="${cell.id?Number(cell.x)||0:''}" ${cell.id?'':'disabled'} data-builder-channel-field="cellX" aria-label="Cell X for channel ${index+1}"></td>
        <td><input type="number" min="0" max="255" value="${cell.id?Number(cell.y)||0:''}" ${cell.id?'':'disabled'} data-builder-channel-field="cellY" aria-label="Cell Y for channel ${index+1}"></td>
        <td><button type="button" class="gsl-builder-function-toggle ${builderFunctionChannelIndex===index?'on':''}" data-builder-row-action="functions" aria-expanded="${builderFunctionChannelIndex===index}">${functions.length} FN</button></td>
        <td><div class="gsl-builder-row-actions"><button type="button" data-builder-row-action="up" title="Move up" ${index===0?'disabled':''}>↑</button><button type="button" data-builder-row-action="down" title="Move down" ${index===builderDraft.channels.length-1?'disabled':''}>↓</button><button type="button" data-builder-row-action="delete" title="Delete channel">×</button></div></td>
      </tr>`;
      return main+(builderFunctionChannelIndex===index?renderBuilderFunctions(channel,index):'');
    }).join('');
  }

  function renderPersonalityBuilder() {
    const form=byId('gslPersonalityBuilder'); if(!form||!builderDraft)return;
    byId('gslBuilderTitle').textContent=builderEditingId?'Edit GSL5 Fixture':'New GSL5 Fixture';
    byId('gslBuilderManufacturer').value=builderDraft.manufacturer||'';
    byId('gslBuilderName').value=builderDraft.name||''; byId('gslBuilderMode').value=builderDraft.mode||'';
    const category=byId('gslBuilderCategory'); category.innerHTML=builderCategories().map(value=>`<option value="${safe(value)}">${safe(value)}</option>`).join('');
    if(!builderCategories().includes(builderDraft.category)){const option=document.createElement('option');option.value=builderDraft.category;option.textContent=builderDraft.category;category.append(option);}
    category.value=builderDraft.category||'User Personalities';
    byId('gslBuilderFootprint').value=String(builderDraft.footprint||1); byId('gslBuilderSafety').value=builderDraft.safety||'verify-fixture-manual';
    byId('gslBuilderDescription').value=builderDraft.description||'';
    byId('gslBuilderDelete').hidden=!builderEditingId;
    renderBuilderChannels(); updateBuilderAssessment(); startBuilderPreview();
  }

  async function openPersonalityBuilder(source) {
    if(!Personalities||typeof Personalities.saveAuthoredProfile!=='function'){status('The local GSL5 Fixture Builder provider is unavailable.','error');return false;}
    setWorkspace('patch'); openPersonalityLibrary();
    let profile=source&&typeof source==='object'?source:null;
    const sourceId=typeof source==='string'?source:source&&source.id;
    if(!profile&&sourceId)profile=await Personalities.getProfile(sourceId);
    const authored=!!(profile&&profile.source&&profile.source.authored);
    builderEditingId=authored?profile.id:''; builderDraft=profile?draftFromProfile(profile,authored):blankBuilderDraft();
    builderFunctionChannelIndex=0;
    builderDirty=false; builderAssessment=null;
    const panel=byId('gslPersonalityLibrary'),form=byId('gslPersonalityBuilder');
    panel.dataset.view='builder';form.hidden=false;
    if(personalityPreviewFrame)cancelAnimationFrame(personalityPreviewFrame);personalityPreviewFrame=0;
    const output=byId('gslBuilderStatus');output.textContent=authored?isSessionOnly()?'Kept for this session':'Saved local profile':'Unsaved';output.dataset.tone=authored?'success':'warning';
    renderPersonalityBuilder(); requestAnimationFrame(()=>byId('gslBuilderName')?.focus()); return true;
  }

  function closePersonalityBuilder(force) {
    const form=byId('gslPersonalityBuilder'); if(!form||form.hidden)return true;
    if(builderDirty&&!force&&!confirm('Discard unsaved GSL5 Fixture Builder changes?'))return false;
    form.hidden=true;byId('gslPersonalityLibrary').removeAttribute('data-view');
    if(builderPreviewFrame)cancelAnimationFrame(builderPreviewFrame);builderPreviewFrame=0;
    builderDraft=null;builderEditingId='';builderAssessment=null;builderDirty=false;builderFunctionChannelIndex=0;
    renderPersonalityLibrary();drawPersonalityPreview();return true;
  }

  function addBuilderChannel() {
    if(!builderDraft)return;
    if(builderDraft.channels.length>=512){byId('gslBuilderStatus').textContent='A mode is limited to 512 attributes';byId('gslBuilderStatus').dataset.tone='error';return;}
    const occupied=new Set(builderDraft.channels.flatMap(channel=>[Number(channel.offset),Number(channel.bits)===16?Number(channel.fineOffset):null]).filter(Number.isFinite));
    let offset=0;while(offset<512&&occupied.has(offset))offset++;
    if(offset>=512){byId('gslBuilderStatus').textContent='No free DMX slots';byId('gslBuilderStatus').dataset.tone='error';return;}
    let index=builderDraft.channels.length+1,key=`control-${index}`;while(builderDraft.channels.some(channel=>channel.attribute===key))key=`control-${++index}`;
    builderDraft.channels.push(builderChannel('control',offset,{attribute:key,label:`Control ${index}`}));
    builderFunctionChannelIndex=builderDraft.channels.length-1;
    builderDraft.footprint=Math.max(Number(builderDraft.footprint)||1,offset+1);setBuilderDirty('Channel added');renderPersonalityBuilder();
  }

  function applyBuilderPreset(name) {
    if(!builderDraft)return;
    const layouts={
      dimmer:[builderChannel('dimmer',0)],
      rgb:[builderChannel('dimmer',0),builderChannel('red',1),builderChannel('green',2),builderChannel('blue',3)],
      rgbw:[builderChannel('dimmer',0),builderChannel('red',1),builderChannel('green',2),builderChannel('blue',3),builderChannel('white',4)],
      mover:[builderChannel('pan',0,{bits:16,fineOffset:1}),builderChannel('tilt',2,{bits:16,fineOffset:3}),builderChannel('dimmer',4),
        builderChannel('shutter',5),builderChannel('red',6),builderChannel('green',7),builderChannel('blue',8),builderChannel('white',9)]
    };
    if(!layouts[name])return;
    if(builderDirty&&builderDraft.channels.length>1&&!confirm('Replace the current channel map with this capability preset?'))return;
    builderDraft.channels=layouts[name];builderFunctionChannelIndex=0;fitBuilderFootprint();
    builderDraft.mode=name==='mover'?'16-bit mover + RGBW':`${builderDraft.footprint} channel`;
    setBuilderDirty('Capability preset applied');renderPersonalityBuilder();
  }

  function generateBuilderCells() {
    if(!builderDraft)return;
    const count=Math.round(clamp(byId('gslBuilderCellCount').value,1,128));
    const columns=Math.round(clamp(byId('gslBuilderCellColumns').value,1,32));
    const start=Math.round(clamp(byId('gslBuilderCellStart').value,1,512))-1;
    const emitters={rgb:['red','green','blue'],rgbw:['red','green','blue','white'],white:['white'],cct:['cold-white','warm-white']}[byId('gslBuilderCellEmitters').value]||['red','green','blue'];
    if(builderDraft.channels.length+count*emitters.length>512){const output=byId('gslBuilderStatus');output.textContent='This mode would exceed 512 attributes';output.dataset.tone='error';return;}
    if(start+count*emitters.length>512){const output=byId('gslBuilderStatus');output.textContent='Generated cells would cross DMX 512';output.dataset.tone='error';return;}
    const existingCells=new Set(builderDraft.channels.map(channel=>channel.cell&&channel.cell.id).filter(Boolean));let first=1;
    while(existingCells.has(`cell-${first}`))first++;
    const generated=[];
    for(let index=0;index<count;index++){
      const number=first+index,cell={id:`cell-${number}`,name:`Cell ${number}`,x:index%columns,y:Math.floor(index/columns)};
      emitters.forEach((semantic,component)=>generated.push(builderChannel(semantic,start+index*emitters.length+component,
        {attribute:`${semantic}-${number}`,label:`${builderTitle(semantic)}: Cell ${number}`,cell})));
    }
    builderDraft.channels.push(...generated);fitBuilderFootprint();setBuilderDirty(`${count} cells generated`);renderPersonalityBuilder();
  }

  async function saveBuilder(useInPatch) {
    if(!builderDraft||!Personalities)return false;
    const assessment=updateBuilderAssessment();if(!assessment||!assessment.valid){byId('gslBuilderStatus').textContent='Fix validation errors before saving';byId('gslBuilderStatus').dataset.tone='error';return false;}
    const output=byId('gslBuilderStatus');output.textContent=isSessionOnly()?'Keeping for this session…':'Saving locally…';output.dataset.tone='warning';
    try{
      const saved=await Personalities.saveAuthoredProfile(builderDraft);
      builderDraft=draftFromProfile(saved,true);builderEditingId=saved.id;builderDirty=false;selectedCatalogLibraryId=saved.id;selectedCatalogProfile=saved;personalityPreviewProfile=saved;
      renderPersonalityBuilder();renderPersonalityLibrary();
      /* The provider falls back to in-memory Maps when IndexedDB is refused
         and still returns a success count, so "Saved to local catalogue" was
         being reported for a personality that would not survive a reload. It
         already measures where it landed - ask it. */
      let durable=true;
      try{const info=await Personalities.stats();durable=!info||info.storage!=='memory';}catch(_){durable=false;}
      const sessionOnly=window.OpenLiveSessionPolicy?.sessionOnly === true;
      output.textContent=sessionOnly?'Kept for this session':durable?'Saved to local catalogue':'Held in this tab only. Browser storage refused';
      output.dataset.tone=sessionOnly||durable?'success':'warning';
      status(sessionOnly ? `${saved.manufacturer} · ${saved.name} · ${saved.mode} kept for this session. Physical output remains disarmed.` : durable
        ?`${saved.manufacturer} · ${saved.name} · ${saved.mode} saved locally. Physical output remains disarmed.`
        :`${saved.manufacturer} · ${saved.name} · ${saved.mode} is held in memory only. This browser refused persistent storage, so it will be lost on reload. Export it to keep it.`,durable?'success':'warning');
      if(useInPatch){selectCatalogProfile(saved);closePersonalityBuilder(true);closePersonalityLibrary();requestAnimationFrame(()=>byId('gslPatchQuantity')?.focus());}
      return saved;
    }catch(error){const validation=error&&error.validation;if(validation){builderAssessment=validation;updateBuilderAssessment();}output.textContent=error.message||String(error);output.dataset.tone='error';return false;}
  }

  async function deleteBuilderProfile() {
    if(!builderEditingId||!Personalities)return false;
    if(!confirm('Delete this locally authored personality from the catalogue? Profiles already embedded in saved shows are not changed.'))return false;
    const deleted=await Personalities.deleteAuthoredProfile(builderEditingId);
    if(deleted){if(selectedCatalogLibraryId===builderEditingId){selectedCatalogProfile=null;selectedCatalogLibraryId='';}closePersonalityBuilder(true);personalityStatus('Local personality deleted; saved show copies remain','success');}
    return deleted;
  }

  function exportBuilderProfile() {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Exporting a personality'); }
      catch (error) { const output=byId('gslBuilderStatus'); output.textContent=error.message; output.dataset.tone='error'; }
      return false;
    }
    const assessment=updateBuilderAssessment();if(!assessment||!assessment.valid)return false;
    const envelope={schema:'showave.gsl5.personality/1',exportedAt:new Date().toISOString(),profile:assessment.profile};
    const blob=new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`${builderKey(builderDraft.manufacturer)}-${builderKey(builderDraft.name)}-${builderKey(builderDraft.mode)}.gsl5-personality.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
    const output=byId('gslBuilderStatus');output.textContent='Personality JSON exported';output.dataset.tone='success';return true;
  }

  function handleBuilderChannelInput(event) {
    const input=event.target.closest('[data-builder-channel-field]'),row=input&&input.closest('[data-builder-index]');
    if(!input||!row||!builderDraft)return false;
    const index=Number(row.dataset.builderIndex),channel=builderDraft.channels[index];if(!channel)return false;
    const field=input.dataset.builderChannelField,value=input.value;
    if(field==='offset')channel.offset=Number(value)-1;
    else if(field==='fineOffset')channel.fineOffset=Number(value)-1;
    else if(field==='bits'){channel.bits=Number(value)===16?16:8;if(channel.bits===16&&(!Number.isFinite(Number(channel.fineOffset))||channel.fineOffset===channel.offset))channel.fineOffset=Number(channel.offset)+1;else if(channel.bits===8)channel.fineOffset=null;}
    else if(['default','locate','highlight'].includes(field))channel[field]=value.trim()===''?null:Number(value)/100;
    else if(field==='cellId'){const id=value.trim();channel.cell=id?Object.assign({id,name:builderTitle(id),x:0,y:0},channel.cell||{},{id}):null;}
    else if(field==='cellX'){if(channel.cell)channel.cell.x=Number(value);}
    else if(field==='cellY'){if(channel.cell)channel.cell.y=Number(value);}
    else {channel[field]=value;if(field==='semantic'){channel.family=builderFamily(builderKey(value));if(builderIntensityChannel(channel))channel.mix='htp';}}
    setBuilderDirty();
    if(field==='bits'||field==='cellId'&&event.type==='change'||field==='semantic'&&event.type==='change')renderPersonalityBuilder();else updateBuilderAssessment();
    return true;
  }

  function nextBuilderFunctionRange(channel) {
    const maximum=Number(channel&&channel.bits)===16?65535:255;
    const ranges=(Array.isArray(channel&&channel.functions)?channel.functions:[]).map(fn=>({start:Number(fn.dmxStart),end:Number(fn.dmxEnd)}))
      .filter(range=>Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.start>=0&&range.end>=range.start&&range.end<=maximum)
      .sort((left,right)=>left.start-right.start||left.end-right.end);
    let cursor=0;
    for(const range of ranges){if(range.start>cursor)return {start:cursor,end:range.start-1};cursor=Math.max(cursor,range.end+1);}
    return cursor<=maximum?{start:cursor,end:maximum}:null;
  }

  function addBuilderFunction(channelIndex) {
    const channel=builderDraft&&builderDraft.channels[channelIndex];if(!channel)return false;
    channel.functions=Array.isArray(channel.functions)?channel.functions:[];
    if(channel.functions.length>=256){const output=byId('gslBuilderStatus');output.textContent='An attribute is limited to 256 functions';output.dataset.tone='error';return false;}
    const range=nextBuilderFunctionRange(channel);
    if(!range){const output=byId('gslBuilderStatus');output.textContent='All DMX values are already assigned to a function';output.dataset.tone='error';return false;}
    let number=channel.functions.length+1,id=String(number);while(channel.functions.some(fn=>String(fn.id)===id))id=String(++number);
    channel.functions.push({id,name:`Function ${number}`,dmxStart:range.start,dmxEnd:range.end,displayStart:0,displayEnd:100});
    builderFunctionChannelIndex=channelIndex;setBuilderDirty('DMX function added');renderPersonalityBuilder();return true;
  }

  function deleteBuilderFunction(channelIndex,functionIndex) {
    const channel=builderDraft&&builderDraft.channels[channelIndex];if(!channel||!Array.isArray(channel.functions)||!channel.functions[functionIndex])return false;
    channel.functions.splice(functionIndex,1);builderFunctionChannelIndex=channelIndex;setBuilderDirty('DMX function removed');renderPersonalityBuilder();return true;
  }

  function handleBuilderFunctionInput(event) {
    const input=event.target.closest('[data-builder-function-field]'),functionRow=input&&input.closest('[data-builder-function-index]'),channelRow=input&&input.closest('[data-builder-index]');
    if(!input||!functionRow||!channelRow||!builderDraft)return false;
    const channelIndex=Number(channelRow.dataset.builderIndex),functionIndex=Number(functionRow.dataset.builderFunctionIndex);
    const channel=builderDraft.channels[channelIndex],fn=channel&&Array.isArray(channel.functions)&&channel.functions[functionIndex];if(!fn)return false;
    const field=input.dataset.builderFunctionField,value=input.value;
    fn[field]=field==='name'?value:(value.trim()===''?Number.NaN:Number(value));
    builderFunctionChannelIndex=channelIndex;setBuilderDirty();updateBuilderAssessment();return true;
  }

  function activePlaybackForSequence(sequenceId) {
    return show.playbacks.find(playback => playback.sequenceId === sequenceId && show.runtime.playbacks[playback.id] && show.runtime.playbacks[playback.id].active) ||
      show.playbacks.find(playback => playback.sequenceId === sequenceId) || null;
  }

  function renderCues() {
    const sequence = activeSequence();
    byId('gslSequenceList').innerHTML = show.sequences.map(item => `<button type="button" role="option" aria-selected="${item.id === activeSequenceId}" class="gsl-sequence-item ${item.id === activeSequenceId ? 'on' : ''}" data-sequence-id="${safe(item.id)}"><strong>${safe(item.name)}</strong><small>${item.cueIds.length} cues · ${item.tracking ? 'tracking' : 'cue only'}</small></button>`).join('');
    byId('gslSequenceName').textContent = sequence ? sequence.name : 'No sequence';
    const playback = sequence && activePlaybackForSequence(sequence.id), runtime = playback && show.runtime.playbacks[playback.id];
    const activeId = runtime && runtime.active && sequence.cueIds[runtime.cursor];
    byId('gslCueBody').innerHTML = sequence && sequence.cueIds.length ? sequence.cueIds.map((id,index) => {
      const cue = cueById(id); if (!cue) return '';
      const count = Object.values(cue.values || {}).reduce((sum,values) => sum + Object.keys(values).length,0);
      return `<tr data-cue-id="${safe(cue.id)}" class="${cue.id === activeId ? 'gsl-cue-live' : ''} ${runtime && runtime.cursor + 1 === index ? 'gsl-cue-next' : ''} ${cue.id === selectedCueId ? 'selected' : ''}">
        <td>${cue.id === activeId ? 'LIVE' : runtime && runtime.cursor + 1 === index ? 'NEXT' : ''}</td><td>${index + 1}.00</td><td>${safe(cue.name)}</td>
        <!-- ONE FADE, PRINTED ONCE. These were two columns headed "Fade In"
             and "Fade Out" both rendering the SAME cue.fadeMs, so a sheet that
             looked like it carried a real timing model carried one number
             wearing two hats - and an operator reading Fade Out would have
             believed a value nobody had set. Follow was the literal string
             "Manual" on every row, which is not a fact about the cue but the
             absence of a Link/Follow field in the model. An em dash is what
             this codebase shows for a value it does not have. -->
        <td>${(cue.fadeMs / 1000).toFixed(1)}s</td><td>${(cue.delayMs / 1000).toFixed(1)}s</td>
        <td class="gsl-unmodelled" title="Link/Follow is not modelled yet - every cue waits for Go.">N/A</td><td>${cue.block ? 'Block' : sequence.tracking ? 'Track' : 'Cue only'}</td><td>${count}</td></tr>`;
    }).join('') : '<tr><td colspan="8">Set a look in the Programmer, then RECORD CUE.</td></tr>';
    const select = byId('gslRecordSequence');
    select.innerHTML = show.sequences.map(item => `<option value="${safe(item.id)}">${safe(item.name)}</option>`).join('');
    if (sequence) select.value = sequence.id;
  }

  function renderFx() {
    byId('gslFxList').innerHTML = show.effects.length ? show.effects.map(effect => `<button type="button" role="option" aria-selected="${effect.id === selectedEffectId}" class="gsl-fx-item ${effect.id === selectedEffectId ? 'on' : ''}" data-effect-id="${safe(effect.id)}"><strong>${safe(effect.name)}</strong><small>${safe(effect.attribute)} · ${safe(effect.waveform)} · ${effect.fixtureIds.length} fixtures · ${effectStateLabel(effect)}</small></button>`).join('') : '<div class="gsl-empty">Select fixtures and create your first effect.</div>';
    const effect = effectById(selectedEffectId);
    const attributes = new Map([['dimmer','Dimmer'],['pan','Pan'],['tilt','Tilt'],['red','Red'],['green','Green'],['blue','Blue'],['zoom','Zoom']]);
    selectionAttributes().forEach((label,attribute)=>attributes.set(attribute,label));
    (effect && effect.fixtureIds || []).forEach(id=>{
      const profile=profileById(fixtureById(id)?.profileId);
      (profile&&profile.channels||[]).forEach(channel=>attributes.set(channel.attribute,channel.label||channel.attribute));
    });
    if(effect)attributes.set(effect.attribute,attributes.get(effect.attribute)||effect.attribute);
    const attributeInput=byId('gslFxAttribute'),previousAttribute=attributeInput.value;
    attributeInput.innerHTML=[...attributes].map(([attribute,label])=>`<option value="${safe(attribute)}">${safe(label)}</option>`).join('');
    attributeInput.value=effect?effect.attribute:attributes.has(previousAttribute)?previousAttribute:'dimmer';
    byId('gslFxName').textContent = effect ? effect.name : 'New effect';
    if (effect) {
      byId('gslFxLabel').value = effect.name;
      byId('gslFxAttribute').value = effect.attribute;
      byId('gslFxWave').value = effect.waveform === 'steps' ? 'chase' : effect.waveform;
      byId('gslFxMode').value = effect.mode;
      byId('gslFxSize').value = String(Math.round(effect.size * 100));
      byId('gslFxDirection').value = effect.direction || 'forward';
      byId('gslFxRateSource').value = effect.rateSource || 'hz';
      byId('gslFxSpeed').value = String(Math.round((effect.rateSource==='bpm' ? effect.rateMultiplier || 1 : effect.speedBpm / 60) * 100));
      byId('gslFxPhase').value = String(Math.round(effect.phase));
      byId('gslFxSpread').value = String(Math.round(effect.spread));
      byId('gslFxSize').nextElementSibling.textContent = `${Math.round(effect.size * 100)}%`;
      byId('gslFxPhase').nextElementSibling.textContent = `${Math.round(effect.phase)}°`;
      byId('gslFxSpread').nextElementSibling.textContent = `${Math.round(effect.spread)}°`;
    }
    ['gslFxStart','gslFxStop','gslFxDuplicate','gslFxDelete'].forEach(id=>{byId(id).disabled=!effect;});
    byId('gslFxStop').disabled = !effect || !effect.enabled;
    byId('gslFxApply').textContent = effect ? 'UPDATE EFFECT' : 'CREATE EFFECT';
    byId('gslFxTarget').textContent = effect ? `${effect.fixtureIds.length} targets${selectedFixtures().length ? ` · ${selectedFixtures().length} selected for update` : ''}` : `${selectedFixtures().length} selected fixtures`;
    renderFxRate();
    drawFx();
  }

  function renderFxRate() {
    const value=Number(byId('gslFxSpeed').value)/100;
    byId('gslFxSpeed').nextElementSibling.textContent = byId('gslFxRateSource').value==='bpm'
      ? `${value.toFixed(2)} × BPM (${(value*(Number(show.metadata.bpm)||activeSequence()?.bpm||120)/60).toFixed(2)} Hz)`
      : `${value.toFixed(2)} Hz`;
  }

  function drawFx() {
    const canvas = byId('gslFxCanvas'); if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), dpr = Math.min(2, global.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); fxCanvasDpr = dpr;
    }
    const ctx = canvas.getContext('2d'), width = canvas.width / dpr, height = canvas.height / dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
    ctx.strokeStyle = themeValue('--color-accent') || themeValue('--txt-hi'); ctx.lineWidth = 2; ctx.beginPath();
    const spec=fxSpecFromForm(effectById(selectedEffectId));
    for (let x = 0; x <= width; x++) {
      const sample=Engine.sampleEffect(spec,x/Math.max(1,width)*2+spec.phase/360);
      const value=spec.waveform==='steps'?sample*2-1:sample*spec.size;
      const y = height / 2 - value * height * .32; if (!x) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.globalAlpha=.42; ctx.strokeStyle=themeValue('--txt-dim') || themeValue('--txt'); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke(); ctx.globalAlpha=1;
  }

  function renderPlaybacks() {
    byId('gslPlaybackPage').textContent = String(playbackPage + 1);
    const start = playbackPage * 8, slots = Array.from({length:8},(_,index) => show.playbacks[start + index] || null);
    byId('gslPlaybackBank').innerHTML = slots.map((playback,index) => {
      if (!playback) return `<div class="gsl-playback empty" data-slot="${start + index}"><header><strong>Empty ${start + index + 1}</strong><small>Assign active sequence</small></header><div class="gsl-fader"></div><div class="playback-buttons"><button class="assign-playback" data-slot="${start + index}">ASSIGN</button></div><button class="select-playback" disabled>SELECT</button></div>`;
      const sequence = sequenceById(playback.sequenceId), runtime = show.runtime.playbacks[playback.id] || {};
      const active = !!runtime.active;
      return `<div class="gsl-playback ${active ? 'active' : ''} ${playback.id === selectedPlaybackId ? 'selected' : ''}" data-playback-id="${safe(playback.id)}" style="--playback-color:var(${active ? '--gsl-green' : '--gsl-violet'})">
        <header><strong>${safe(playback.name)}</strong><small>${safe(sequence && sequence.name || 'Unassigned')}</small></header>
        <label class="gsl-fader"><input type="range" min="0" max="100" value="${Math.round((runtime.level == null ? playback.level : runtime.level) * 100)}" aria-label="${safe(playback.name)} level"><output>${Math.round((runtime.level == null ? playback.level : runtime.level) * 100)}</output></label>
        <div class="playback-buttons"><button class="go">GO</button><button class="flash">FLASH</button></div><button class="select-playback">${active ? 'RELEASE' : 'SELECT'}</button></div>`;
    }).join('');
  }

  function renderNetwork() {
    const protocol = byId('gslProtocol').value;
    const destination = byId('gslDestinationMode');
    [...destination.options].forEach(option => {
      option.disabled = protocol === 'sacn'
        ? option.value === 'discovered_unicast' || option.value === 'legacy_directed_broadcast'
        : option.value === 'multicast';
    });
    if (destination.selectedOptions[0] && destination.selectedOptions[0].disabled)
      destination.value = protocol === 'sacn' ? 'multicast' : 'discovered_unicast';
    byId('gslSacnPriority').disabled = protocol !== 'sacn';
    byId('gslArtSync').disabled = protocol !== 'artnet';
    byId('gslTargetIp').disabled = destination.value === 'multicast' || destination.value === 'discovered_unicast';
    byId('gslNetworkRouteState').textContent = bridgeState.outputting ? 'LIVE OUTPUT' : bridgeState.available ? 'Preview · bridge ready' : 'Bridge unavailable';
    byId('gslRouteWarning').className = `gsl-route-warning ${bridgeState.outputting ? 'live' : ''}`;
    byId('gslRouteWarning').textContent = bridgeState.outputting
      ? `${String(bridgeState.protocol).toUpperCase()} is transmitting. ${operatorBlackout || bridgeState.blackout ? 'Blackout is active.' : 'Live levels are on the wire.'}`
      : bridgeState.available ? 'Output is disarmed. No UDP lighting packets are leaving this computer.'
        : (bridgeState.lastError || 'The native lighting bridge is unavailable. Restart the OpenLive dev server.');
    byId('gslNodeList').innerHTML = bridgeState.nodes && bridgeState.nodes.length ? bridgeState.nodes.map(node => {
      const id = node.id || `${node.bindIp || node.ip}:${node.bindIndex || 1}`;
      return `<article class="gsl-node online ${id === selectedNodeId ? 'selected' : ''}" data-node-id="${safe(id)}" ${id === selectedNodeId ? 'aria-current="true"' : ''}><div><strong>${safe(node.shortName || node.name || node.longName || 'Art-Net Node')}</strong><small>${safe(node.ip || node.bindIp || '')} · ${(node.ports || node.outputPorts || []).length || node.numPorts || 0} ports · ${safe(node.longName || '')}</small></div><button type="button" data-use-node="${safe(id)}">USE NODE</button></article>`;
    }).join('') : '<div class="gsl-empty">No Art-Net nodes discovered yet. Manual unicast remains available.</div>';
    renderUniverseMonitor();
  }

  function renderUniverseMonitor() {
    const entries = Object.entries(evaluated.universes || {}).sort((a,b) => Number(a[0]) - Number(b[0]));
    byId('gslUniverseList').innerHTML = entries.length ? entries.map(([universe,levels]) => {
      const blocks = Array.from({length:64},(_,index) => {
        const slice = levels.slice(index * 8,index * 8 + 8), value = Math.max(0,...slice) / 255;
        return `<i style="--level:${value.toFixed(3)}"></i>`;
      }).join('');
      const active = levels.filter(value => value > 0).length;
      return `<div class="gsl-universe-row"><strong>Universe ${universe}</strong><div class="gsl-channel-strip" aria-label="Universe ${universe} levels">${blocks}</div><span>${active} active</span></div>`;
    }).join('') : '<div class="gsl-empty">Patch fixtures to create universe output.</div>';
    byId('gslPacketStats').textContent = `${Number(bridgeState.packetCount || 0).toLocaleString()} packets`;
  }

  function renderMetrics() {
    const universes = Object.keys(evaluated.universes || {}).length;
    byId('gslFooterMetrics').textContent = `${show.fixtures.length} fixtures · ${universes} universes · ${Math.round(bridgeState.packetsPerSecond || 0)} packets/s`;
  }

  function renderAll() {
    if (fullRenderQueued) return;
    fullRenderQueued = true;
    requestAnimationFrame(() => {
      fullRenderQueued = false; ensureActiveObjects();
      renderHeader(); renderWorkspace(); renderLibrary(); renderSidebar(); renderMapper(); renderLive(); renderProgrammer(); renderPatch(); renderCues(); renderFx(); renderPlaybacks(); renderNetwork(); renderMetrics();
    });
  }

  function paintRuntime() {
    $$('.gsl-fixture-item').forEach(node => {
      const values = evaluated.fixtureValues[node.dataset.fixtureId] || {}, dimmer = values.dimmer == null ? values.intensity || 0 : values.dimmer;
      const fill = $('.level i', node); if (fill) fill.style.width = `${Math.round(dimmer * 100)}%`;
    });
    $$('.gsl-map-fixture').forEach(node => {
      const values = evaluated.fixtureValues[node.dataset.mapFixtureId] || {}, dimmer = values.dimmer == null ? values.intensity || 0 : values.dimmer;
      node.style.setProperty('--map-level',String(clamp(dimmer,0,1)));
    });
    $$('.gsl-playback').forEach(node => {
      const playback = playbackById(node.dataset.playbackId), runtime = playback && show.runtime.playbacks[playback.id];
      node.classList.toggle('active', !!(runtime && runtime.active));
    });
    syncComposerRuntime();
    if (workspace === 'network') renderUniverseMonitor();
    renderMetrics();
  }

  /* Actions ---------------------------------------------------------------- */
  function composerSlot(layerId,columnId) {
    return show.composer && show.composer.clips.find(clip => clip.layerId === layerId && clip.columnId === columnId) || null;
  }

  function composerLayer(id) { return show.composer && show.composer.layers.find(layer => layer.id === id) || null; }
  function composerColumn(id) { return show.composer && show.composer.columns.find(column => column.id === id) || null; }
  function isPrivateComposerLayer(layer) {
    return !!layer&&(layer.private===true||layer.scope===SHOWAVE_CLIP_SCOPE||
      /^SW · /.test(layer.name||'')&&layer.target&&layer.target.kind==='profile');
  }
  function isPrivateComposerColumn(column) {
    return !!column&&(column.private===true||column.scope===SHOWAVE_CLIP_SCOPE);
  }
  function isPrivateComposerClip(clip) {
    return !!clip&&(clip.private===true||clip.scope===SHOWAVE_CLIP_SCOPE||
      isPrivateComposerLayer(composerLayer(clip.layerId))||isPrivateComposerColumn(composerColumn(clip.columnId)));
  }

  function sourceLookValues(preset,target) {
    const values = {};
    composerTargetFixtures(target).forEach(fixtureId => {
      const fixture = fixtureById(fixtureId), profile = fixture && profileById(fixture.profileId);
      if (!fixture || !profile) return;
      const attributes = {};
      (profile.channels || []).forEach(channel => {
        const attribute = channel.attribute;
        if (preset === 'blackout' && (attribute === 'dimmer' || attribute === 'intensity')) attributes[attribute] = 0;
        else if (preset === 'full' && (attribute === 'dimmer' || attribute === 'intensity')) attributes[attribute] = 1;
        else if (preset === 'white' && (attribute === 'dimmer' || attribute === 'intensity' || ['red','green','blue','white'].includes(attribute))) attributes[attribute] = 1;
        else if (preset === 'home' && (attribute === 'pan' || attribute === 'tilt')) attributes[attribute] = .5;
      });
      if (Object.keys(attributes).length) values[fixtureId] = attributes;
    });
    return values;
  }

  function assetTarget(asset,layer) {
    if (asset.kind === 'group') return {kind:'group',groupId:asset.id,fixtureIds:[]};
    if (asset.kind === 'fixture') return {kind:'fixtures',groupId:'',fixtureIds:[asset.id]};
    return clone(layer.target || {kind:'all',groupId:'',fixtureIds:[]});
  }

  function composerItemFromAsset(asset,layer,target) {
    if (asset.kind === 'source' || asset.kind === 'group' || asset.kind === 'fixture') {
      const values = sourceLookValues(asset.preset || 'full',target);
      if (!Object.keys(values).length) throw new RangeError('Patch compatible fixtures or assign a populated group before adding this lighting source.');
      return {kind:'look',values,name:asset.name,level:1};
    }
    if (asset.kind === 'palette') return {kind:'palette',refId:asset.id,name:asset.name,level:1};
    if (asset.kind === 'cue') return {kind:'cue',refId:asset.id,sequenceId:asset.sequenceId || '',name:asset.name,level:1};
    if (asset.kind === 'effect') {
      const effect = effectById(asset.id);
      if (!effect) throw new RangeError('That lighting effect is no longer available.');
      return {kind:'effect',refId:effect.id,name:effect.name,level:1};
    }
    if (asset.kind === 'effect-preset') {
      const fixtureIds = composerTargetFixtures(target);
      if (!fixtureIds.length) throw new RangeError('Assign patched fixtures to this layer before adding an effect.');
      let attribute = asset.preset === 'sweep' ? 'pan' : 'dimmer';
      const supports = fixtureIds.some(id => {
        const fixture = fixtureById(id), profile = fixture && profileById(fixture.profileId);
        return profile && profile.channels.some(channel => channel.attribute === attribute);
      });
      if (!supports) attribute = 'dimmer';
      const effect = Engine.addEffect(show,{
        id:uid('composer:effect'), name:asset.name, fixtureIds,
        groupId:target.kind === 'group' ? target.groupId : '', attribute,
        waveform:asset.preset === 'chase' ? 'square' : 'sine', mode:'absolute',
        base:.5, size:asset.preset === 'sweep' ? .45 : .5, offset:0,
        speedBpm:asset.preset === 'chase' ? 120 : 60, phase:0, spread:360,
        enabled:true, autostart:false, startedAt:Date.now()
      });
      return {kind:'effect',refId:effect.id,name:effect.name,level:1};
    }
    throw new RangeError(`Unsupported Lighting Composer source: ${asset.kind}`);
  }

  function createComposerClipFromAsset(asset,layerId,columnId) {
    if (!asset || !requireDisarmed('editing Lighting Composer clips')) return null;
    const layer = composerLayer(layerId), column = composerColumn(columnId);
    if (!layer || !column) return null;
    const existing = composerSlot(layerId,columnId);
    let created = null;
    mutate(existing ? 'Add Lighting Composer module' : 'Create Lighting Composer clip',() => {
      const target = assetTarget(asset,layer);
      if (asset.kind === 'group' || asset.kind === 'fixture') layer.target = clone(target);
      const item = composerItemFromAsset(asset,layer,target);
      if (existing) {
        if (item.kind !== 'effect') throw new RangeError(`${column.name} on ${layer.name} is occupied. Move it first, or drop an effect to extend its chain.`);
        Engine.addComposerClipItem(show,existing.id,item); created = existing;
      } else {
        created = Engine.storeComposerClip(show,{
          layerId,columnId,name:asset.name,color:asset.color || column.color || layer.color,
          enabled:true,level:1,fadeMs:item.kind === 'effect' ? 0 : 350,target,items:[item]
        });
      }
      return created;
    });
    if (created) {
      selectedComposerLayerId = layerId; selectedComposerClipId = created.id; composerPendingAssetKey = '';
      status(`${existing ? 'Added to' : 'Created'} ${created.name} · ${layer.name} / ${column.name}.`,'success');
      renderLive();
    }
    return created;
  }

  /* SHOWAVE fixture Clips --------------------------------------------------
     The deck owns placement and transport; GSL5 owns the semantic lighting
     source, quantity and ordered FX stack. A catalog drop embeds only the
     personality definition. It never invents a universe/address or arms DMX. */
  function showaveLightingClipDescriptor(clip) {
    if (!clip) return null;
    const layer=composerLayer(clip.layerId), column=composerColumn(clip.columnId);
    const target=clip.target || {}, profile=target.kind==='profile' ? profileById(target.profileId) : null;
    const source=(clip.items||[]).find(item=>item.kind==='source'&&item.enabled!==false);
    const owned=clip.scope===SHOWAVE_CLIP_SCOPE || layer&&layer.scope===SHOWAVE_CLIP_SCOPE ||
      layer&&/^SW · /.test(layer.name)&&source&&source.name==='Fixture Source';
    if (!profile || !source || !owned) return null;
    const quantity=Math.max(1,Math.min(512,Math.round(Number(target.quantity)||1)));
    const fixtureIds=Engine.resolveComposerClipTargets(show,clip.id);
    const available=show.fixtures.filter(fixture=>fixture.enabled!==false&&fixture.profileId===profile.id).length;
    return {showId:show.id,clipId:clip.id,layerId:clip.layerId,columnId:clip.columnId,profileId:profile.id,
      name:`${quantity} × ${profile.name}`,color:clip.color||'#43c7d8',quantity,
      level:clip.level==null?1:clip.level,fadeMs:clip.fadeMs==null?350:clip.fadeMs,
      sourcePreset:source.preset||'full',availableFixtureCount:available,fixtureIds,
      effects:(clip.effectStack||[]).map(clone)};
  }

  function requireShowaveLightingClip(clipId) {
    const clip=show.composer.clips.find(item=>item.id===clipId), descriptor=showaveLightingClipDescriptor(clip);
    if (!clip || !descriptor) throw new RangeError('That SHOWAVE Lighting Clip is no longer available.');
    return {clip,descriptor};
  }

  function storePrivateShowaveClip(profile, rawSpec) {
    const spec=rawSpec&&typeof rawSpec==='object'?rawSpec:{};
    const quantity=Math.max(1,Math.min(512,Math.round(Number(spec.quantity)||1)));
    const target={kind:'profile',profileId:profile.id,quantity};
    const layer=Engine.createComposerLayer(show,{name:`SW · ${profile.name}`,color:'#43c7d8',
      private:true,scope:SHOWAVE_CLIP_SCOPE,target});
    if (!layer) throw new Error('GSL5 could not allocate a private Lighting Clip layer.');
    let column=null;
    try {
      column=Engine.createComposerColumn(show,{name:`SW · ${profile.name}`,color:'#43c7d8',
        private:true,scope:SHOWAVE_CLIP_SCOPE});
      if (!column) throw new Error('GSL5 could not allocate a private Lighting Clip column.');
      const items=(Array.isArray(spec.items)&&spec.items.length?clone(spec.items):
        [{kind:'source',preset:'full',name:'Fixture Source',level:1,enabled:true}]).map(item=>{
        delete item.id; return item;
      });
      const clip=Engine.storeComposerClip(show,{
        layerId:layer.id,columnId:column.id,name:spec.name||`${quantity} × ${profile.name}`,
        color:spec.color||'#43c7d8',enabled:spec.enabled!==false,
        level:spec.level==null?1:spec.level,fadeMs:spec.fadeMs==null?350:spec.fadeMs,
        private:true,scope:SHOWAVE_CLIP_SCOPE,target,items
      });
      if (!clip) throw new Error('GSL5 could not store the private Lighting Clip.');
      return clip;
    } catch (error) {
      if (column&&!show.composer.clips.some(item=>item.columnId===column.id)) Engine.removeComposerColumn(show,column.id);
      if (!show.composer.clips.some(item=>item.layerId===layer.id)) Engine.removeComposerLayer(show,layer.id);
      throw error;
    }
  }

  function createShowaveLightingClip(rawProfile,rawOptions) {
    if (!requireDisarmed('creating a SHOWAVE Lighting Clip'))
      throw new Error('Disarm physical output before creating a Lighting Clip.');
    const options=rawOptions&&typeof rawOptions==='object'?rawOptions:{};
    const quantity=Math.max(1,Math.min(512,Math.round(Number(options.quantity)||1)));
    let created=null;
    mutate('Create SHOWAVE Lighting Clip',()=>{
      const profile=Engine.ensureProfile?Engine.ensureProfile(show,rawProfile):Engine.upsertProfile(show,rawProfile);
      const target={kind:'profile',profileId:profile.id,quantity};
      const layer=Engine.createComposerLayer(show,{name:`SW · ${profile.name}`,color:'#43c7d8',
        private:true,scope:SHOWAVE_CLIP_SCOPE,target});
      let column=null;
      try {
        column=Engine.createComposerColumn(show,{name:`SW · ${profile.name}`,color:'#43c7d8',
          private:true,scope:SHOWAVE_CLIP_SCOPE});
        created=Engine.storeComposerClip(show,{
          layerId:layer.id,columnId:column.id,name:`${quantity} × ${profile.name}`,
          color:'#43c7d8',enabled:true,level:1,fadeMs:350,
          private:true,scope:SHOWAVE_CLIP_SCOPE,target,
          items:[{kind:'source',preset:'full',name:'Fixture Source',level:1,enabled:true}]
        });
        if (!created) throw new Error('GSL5 could not store the private Lighting Clip.');
      } catch (error) {
        if (column&&!show.composer.clips.some(item=>item.columnId===column.id)) Engine.removeComposerColumn(show,column.id);
        if (layer&&!show.composer.clips.some(item=>item.layerId===layer.id)) Engine.removeComposerLayer(show,layer.id);
        throw error;
      }
      return created;
    });
    if (!created) throw new Error('GSL5 could not create the Lighting Clip.');
    saveNow('Create SHOWAVE Lighting Clip');
    status(`LIGHT CLIP · ${quantity} × ${rawProfile.name||'Fixture'} · preview safe until patched.`,'success');
    return showaveLightingClipDescriptor(created);
  }

  function cloneShowaveLightingClip(clipId,rawOptions) {
    if (!requireDisarmed('cloning a SHOWAVE Lighting Clip'))
      throw new Error('Disarm physical output before cloning a Lighting Clip.');
    const current=requireShowaveLightingClip(clipId), profile=profileById(current.descriptor.profileId);
    const options=rawOptions&&typeof rawOptions==='object'?rawOptions:{};
    const quantity=Object.prototype.hasOwnProperty.call(options,'quantity')
      ? Math.max(1,Math.min(512,Math.round(Number(options.quantity)||1))) : current.descriptor.quantity;
    let created=null;
    mutate('Clone SHOWAVE Lighting Clip',()=>{
      created=storePrivateShowaveClip(profile,{
        quantity,
        name:options.name||`${quantity} × ${profile.name}`,
        color:current.clip.color,
        enabled:current.clip.enabled,
        level:current.clip.level,
        fadeMs:current.clip.fadeMs,
        items:current.clip.items
      });
      return created;
    });
    if (!created) throw new Error('GSL5 could not clone the Lighting Clip.');
    saveNow('Clone SHOWAVE Lighting Clip');
    return showaveLightingClipDescriptor(created);
  }

  function discardShowaveLightingClip(clipId) {
    if (!requireDisarmed('discarding a SHOWAVE Lighting Clip'))
      throw new Error('Disarm physical output before discarding a Lighting Clip.');
    const current=requireShowaveLightingClip(clipId);
    const layer=composerLayer(current.clip.layerId), column=composerColumn(current.clip.columnId);
    const discarded=mutate('Discard SHOWAVE Lighting Clip',()=>{
      Engine.releaseComposerClip(show,current.clip.id);
      if (!Engine.removeComposerClip(show,current.clip.id)) return false;
      if (layer&&!show.composer.clips.some(item=>item.layerId===layer.id)&&
        (layer.private||layer.scope===SHOWAVE_CLIP_SCOPE||/^SW · /.test(layer.name))) {
        Engine.removeComposerLayer(show,layer.id);
      }
      if (column&&!show.composer.clips.some(item=>item.columnId===column.id)&&
        (column.private||column.scope===SHOWAVE_CLIP_SCOPE)) {
        Engine.removeComposerColumn(show,column.id);
      }
      return true;
    },{history:false});
    if (discarded!==true) throw new Error('GSL5 could not discard the Lighting Clip.');
    saveNow('Discard SHOWAVE Lighting Clip');
    return true;
  }

  function setShowaveLightingClipQuantity(clipId,rawQuantity) {
    if (!requireDisarmed('changing a SHOWAVE Lighting Clip quantity'))
      throw new Error('Disarm physical output before changing fixture quantity.');
    const current=requireShowaveLightingClip(clipId), quantity=Math.max(1,Math.min(512,Math.round(Number(rawQuantity)||1)));
    let updated=null;
    mutate('Set SHOWAVE Lighting Clip quantity',()=>{
      updated=Engine.setComposerClipQuantity(show,current.clip.id,quantity);
      if (updated) updated.name=`${quantity} × ${profileById(updated.target.profileId)?.name||'Fixture'}`;
      return updated;
    });
    if (!updated) throw new Error('GSL5 could not change the Lighting Clip quantity.');
    saveNow('Set SHOWAVE Lighting Clip quantity');
    return showaveLightingClipDescriptor(updated);
  }

  /* Intensity and fade are performance controls and stay live while output
     is armed - an intensity fader that refuses to move during a show is not
     a fader. Quantity and Source still require a disarmed rig because they
     change which fixtures are addressed. */
  function setShowaveLightingClipLevel(clipId,rawLevel) {
    const current=requireShowaveLightingClip(clipId);
    let updated=null;
    mutate('Set SHOWAVE Lighting Clip intensity',()=>{updated=Engine.setComposerClipLevel(show,current.clip.id,rawLevel);return updated;});
    if (!updated) throw new Error('GSL5 could not change the Lighting Clip intensity.');
    saveNow('Set SHOWAVE Lighting Clip intensity');
    return showaveLightingClipDescriptor(updated);
  }

  function setShowaveLightingClipFade(clipId,rawFadeMs) {
    const current=requireShowaveLightingClip(clipId);
    let updated=null;
    mutate('Set SHOWAVE Lighting Clip fade',()=>{updated=Engine.setComposerClipFade(show,current.clip.id,rawFadeMs);return updated;});
    if (!updated) throw new Error('GSL5 could not change the Lighting Clip fade.');
    saveNow('Set SHOWAVE Lighting Clip fade');
    return showaveLightingClipDescriptor(updated);
  }

  function setShowaveLightingClipSourcePreset(clipId,rawPreset) {
    if (!requireDisarmed('changing a SHOWAVE Lighting Clip source'))
      throw new Error('Disarm physical output before changing the Lighting Source.');
    const current=requireShowaveLightingClip(clipId);
    let updated=null;
    mutate('Set SHOWAVE Lighting Source',()=>{
      updated=Engine.setComposerClipSourcePreset(show,current.clip.id,rawPreset); return updated;
    });
    if (!updated) throw new Error('GSL5 could not change the Lighting Source.');
    saveNow('Set SHOWAVE Lighting Source');
    return showaveLightingClipDescriptor(updated);
  }

  function showaveEffectStack(clip) {
    return (clip.effectStack||[]).map(entry=>({id:entry.id,effectId:entry.effectId,
      enabled:entry.enabled!==false,bypassed:entry.bypassed===true,parameters:clone(entry.parameters||{})}));
  }

  function addShowaveLightingClipEffect(clipId,effectId) {
    if (!requireDisarmed('editing a SHOWAVE Lighting Clip effect stack'))
      throw new Error('Disarm physical output before editing Lighting Effects.');
    const current=requireShowaveLightingClip(clipId), effect=effectById(effectId);
    if (!effect) throw new RangeError('That GSL5 Lighting Effect is no longer available.');
    const stack=showaveEffectStack(current.clip); stack.push({effectId:effect.id,enabled:true,bypassed:false,parameters:{}});
    let updated=null; mutate('Add SHOWAVE Lighting Effect',()=>{updated=Engine.setComposerClipEffectStack(show,current.clip.id,stack);return updated;});
    if (!updated) throw new Error('GSL5 could not add that Lighting Effect.');
    saveNow('Add SHOWAVE Lighting Effect');
    const descriptor=showaveLightingClipDescriptor(updated);
    return Object.assign({position:descriptor.effects.length,effectId:effect.id},descriptor);
  }

  function updateShowaveLightingClipEffect(clipId,itemId,changes) {
    if (!requireDisarmed('editing a SHOWAVE Lighting Clip effect'))
      throw new Error('Disarm physical output before editing Lighting Effects.');
    const current=requireShowaveLightingClip(clipId), stack=showaveEffectStack(current.clip);
    const index=stack.findIndex(entry=>entry.id===itemId); if(index<0) throw new RangeError('That Lighting Effect instance is missing.');
    const source=changes&&typeof changes==='object'?changes:{};
    if(Object.prototype.hasOwnProperty.call(source,'enabled')) stack[index].enabled=source.enabled!==false;
    if(Object.prototype.hasOwnProperty.call(source,'bypassed')) stack[index].bypassed=source.bypassed===true;
    if(source.parameters&&typeof source.parameters==='object') stack[index].parameters=Object.assign({},stack[index].parameters,source.parameters);
    let updated=null; mutate('Update SHOWAVE Lighting Effect',()=>{updated=Engine.setComposerClipEffectStack(show,current.clip.id,stack);return updated;});
    if(!updated)throw new Error('GSL5 could not update that Lighting Effect.');
    saveNow('Update SHOWAVE Lighting Effect'); return showaveLightingClipDescriptor(updated);
  }

  function moveShowaveLightingClipEffect(clipId,itemId,direction) {
    if (!requireDisarmed('reordering a SHOWAVE Lighting Clip effect'))
      throw new Error('Disarm physical output before reordering Lighting Effects.');
    const current=requireShowaveLightingClip(clipId), stack=showaveEffectStack(current.clip);
    const from=stack.findIndex(entry=>entry.id===itemId), delta=direction==='up'?-1:direction==='down'?1:0;
    const to=from+delta; if(from<0||!delta||to<0||to>=stack.length)return current.descriptor;
    [stack[from],stack[to]]=[stack[to],stack[from]];
    let updated=null; mutate('Move SHOWAVE Lighting Effect',()=>{updated=Engine.setComposerClipEffectStack(show,current.clip.id,stack);return updated;});
    if(!updated)throw new Error('GSL5 could not reorder that Lighting Effect.');
    saveNow('Move SHOWAVE Lighting Effect'); return showaveLightingClipDescriptor(updated);
  }

  function removeShowaveLightingClipEffect(clipId,itemId) {
    if (!requireDisarmed('removing a SHOWAVE Lighting Clip effect'))
      throw new Error('Disarm physical output before removing Lighting Effects.');
    const current=requireShowaveLightingClip(clipId), stack=showaveEffectStack(current.clip);
    const next=stack.filter(entry=>entry.id!==itemId); if(next.length===stack.length)throw new RangeError('That Lighting Effect instance is missing.');
    let updated=null; mutate('Remove SHOWAVE Lighting Effect',()=>{updated=Engine.setComposerClipEffectStack(show,current.clip.id,next);return updated;});
    if(!updated)throw new Error('GSL5 could not remove that Lighting Effect.');
    saveNow('Remove SHOWAVE Lighting Effect'); return showaveLightingClipDescriptor(updated);
  }

  function assignComposerLayerTarget(asset,layerId) {
    if (!asset || !['group','fixture'].includes(asset.kind) || !requireDisarmed('assigning a Lighting Composer layer')) return;
    const layer = composerLayer(layerId); if (!layer||isPrivateComposerLayer(layer)) return;
    mutate('Assign Lighting Composer target',()=>{ layer.target = assetTarget(asset,layer); });
    selectedComposerLayerId = layerId;
    status(`${layer.name} now targets ${asset.name}.`,'success');
  }

  function addComposerLayer() {
    if (!requireDisarmed('adding a Lighting Composer layer')) return;
    const index = show.composer.layers.filter(layer=>!isPrivateComposerLayer(layer)).length;
    const layer = mutate('Add Lighting Composer layer',()=>Engine.createComposerLayer(show,{
      name:`Lighting ${index + 1}`,color:COMPOSER_COLORS[index % COMPOSER_COLORS.length],target:{kind:'all'}
    }));
    if (layer) { selectedComposerLayerId=layer.id; status(`Added ${layer.name}.`,'success'); }
  }

  function addComposerColumn() {
    if (!requireDisarmed('adding a Lighting Composer cue')) return;
    const index = show.composer.columns.filter(column=>!isPrivateComposerColumn(column)).length;
    const column = mutate('Add Lighting Composer cue',()=>Engine.createComposerColumn(show,{
      name:`Cue ${index + 1}`,color:COMPOSER_COLORS[index % COMPOSER_COLORS.length]
    }));
    if (column) { status(`Added ${column.name}.`,'success'); requestAnimationFrame(()=>{const stage=$('.gsl-composer-stage');if(stage)stage.scrollLeft=stage.scrollWidth;}); }
  }

  function removeComposerLayer(layerId) {
    const layer = composerLayer(layerId);
    if (!layer||isPrivateComposerLayer(layer)||show.composer.layers.filter(item=>!isPrivateComposerLayer(item)).length<=1)
      return status('A Lighting Composer needs at least one layer.','warning');
    if (!requireDisarmed('removing a Lighting Composer layer') || !confirm(`Remove ${layer.name} and all clips on it?`)) return;
    mutate('Remove Lighting Composer layer',()=>Engine.removeComposerLayer(show,layer.id));
    selectedComposerLayerId = show.composer.layers[0] && show.composer.layers[0].id || '';
    selectedComposerClipId = '';
  }

  function removeComposerClip(clipId) {
    const clip = show.composer.clips.find(item => item.id === clipId);
    if (!clip||isPrivateComposerClip(clip)||!requireDisarmed('clearing a Lighting Composer clip')) return;
    mutate('Clear Lighting Composer clip',()=>Engine.removeComposerClip(show,clip.id));
    if (selectedComposerClipId === clipId) selectedComposerClipId='';
    status(`Cleared ${clip.name}.`);
  }

  function triggerComposerClip(clipId) {
    const clip = show.composer.clips.find(item => item.id === clipId); if (!clip||isPrivateComposerClip(clip)) return;
    selectedComposerClipId=clip.id; selectedComposerLayerId=clip.layerId;
    mutate('Trigger Lighting Composer clip',()=>Engine.triggerComposerClip(show,clip.id,Date.now()),{history:false,save:false});
    status(`GO · ${clip.name}`,'playback');
  }

  function triggerComposerColumn(columnId) {
    const column = composerColumn(columnId); if (!column||isPrivateComposerColumn(column)) return;
    const clips = mutate('Trigger Lighting Composer cue',()=>Engine.triggerComposerColumn(show,column.id,Date.now()),{history:false,save:false});
    status(clips && clips.length ? `GO · ${column.name} · ${clips.length} lighting clips` : `${column.name} has no lighting clips.`,
      clips && clips.length ? 'playback' : 'warning');
  }

  function stopComposer() {
    const layers=show.composer.layers.filter(layer=>!isPrivateComposerLayer(layer));
    mutate('Release Lighting Composer',()=>{
      layers.forEach(layer=>Engine.releaseComposerLayer(show,layer.id)); return true;
    },{history:false,save:false});
    status('Lighting Composer released.','warning');
  }

  function stepComposer(direction) {
    const columns = show.composer.columns.filter(column=>!isPrivateComposerColumn(column)); if (!columns.length) return;
    const activeId = show.runtime.composer && show.runtime.composer.activeColumnId;
    const current = Math.max(-1,columns.findIndex(column => column.id === activeId));
    const next = direction > 0 ? (current + 1) % columns.length : (current <= 0 ? columns.length - 1 : current - 1);
    triggerComposerColumn(columns[next].id);
  }

  function moveComposerClip(clipId,layerId,columnId,copy) {
    if (!requireDisarmed(`${copy ? 'copying' : 'moving'} a Lighting Composer clip`)) return;
    const result = mutate(copy ? 'Copy Lighting Composer clip' : 'Move Lighting Composer clip',()=>
      Engine.moveComposerClip(show,clipId,{layerId,columnId},{copy:!!copy}));
    if (result && result.clip) {
      selectedComposerClipId=result.clip.id; selectedComposerLayerId=result.clip.layerId;
      status(`${copy ? 'Copied' : result.swapped ? 'Swapped' : 'Moved'} ${result.clip.name}.`,'success');
    }
  }

  function reorderComposerColumn(sourceId,targetId) {
    if (sourceId===targetId||isPrivateComposerColumn(composerColumn(sourceId))||
      isPrivateComposerColumn(composerColumn(targetId))||!requireDisarmed('reordering Lighting Composer cues')) return;
    mutate('Reorder Lighting Composer cues',()=>Engine.moveComposerColumn(show,sourceId,targetId));
  }

  function syncComposerRuntime() {
    if (workspace !== 'live' || !show.composer) return;
    const activeColumnId=show.runtime.composer&&show.runtime.composer.activeColumnId||'';
    $$('.gsl-cue-header[data-column-id]').forEach(node=>node.classList.toggle('active',node.dataset.columnId===activeColumnId));
    $$('.gsl-light-clip[data-clip-id]').forEach(node=>{
      const clip=show.composer.clips.find(item=>item.id===node.dataset.clipId);
      node.classList.toggle('playing',!!clip&&composerActiveClipId(clip.layerId)===clip.id);
    });
  }

  function clearComposerDrag() {
    composerDrag=null;
    $$('.gsl-clip-slot.drop, .gsl-clip-slot.drop-invalid').forEach(node=>node.classList.remove('drop','drop-invalid'));
    $$('.gsl-cue-header.drag-over').forEach(node=>node.classList.remove('drag-over'));
    $$('.gsl-layer-target.drop').forEach(node=>node.classList.remove('drop'));
  }

  /* Cross-system drag transport -------------------------------------------
     GSL5's private MIME records keep driving moves and copies inside the
     Composer. text/plain is a separate, id-only SHOWAVE contract: no fixture
     maps, channel values, universe data or evaluated DMX frames leave this
     authoring surface during a drag. */
  function showaveBindingPayload(role,assetType,asset,extra) {
    if (!asset || typeof show.id !== 'string' || !show.id || typeof asset.id !== 'string' || !asset.id) return null;
    const name=String(asset.name || 'Lighting').slice(0,160), color=/^#[0-9a-f]{6}$/i.test(String(asset.color||''))?asset.color:'';
    const binding=Object.assign({schema:SHOWAVE_LIGHTING_BINDING_SCHEMA,schemaVersion:1,
      showId:show.id,role,assetType,assetId:asset.id,name,color},extra||{});
    return {schemaVersion:1,kind:role,track:'lighting',domain:'lighting',id:asset.id,
      name,plugin:name,binding};
  }

  function showaveProfileTemplatePayload(profile) {
    if (!profile || typeof profile.id !== 'string' || !profile.id) return null;
    const name=`${profile.manufacturer||'Fixture'} · ${profile.name||profile.id}`.slice(0,160);
    return {schema:SHOWAVE_LIGHTING_PROFILE_TEMPLATE_SCHEMA,schemaVersion:1,
      kind:'lighting-profile-template',domain:'lighting',role:'source',
      personalityId:profile.id,quantity:1,id:profile.id,name};
  }

  function showaveSourceTemplatePayload(asset) {
    const preset=String(asset&&asset.preset||'').toLowerCase();
    if (!['full','white','blackout','home'].includes(preset)) return null;
    const names={full:'Full Beam',white:'Open White',blackout:'Blackout',home:'Home / Defaults'};
    return {schema:SHOWAVE_LIGHTING_SOURCE_TEMPLATE_SCHEMA,schemaVersion:1,
      kind:'lighting-source-template',domain:'lighting',role:'source-preset',preset,
      id:`source:${preset}`,name:String(asset.name||names[preset]).slice(0,160)};
  }

  function showaveLightingDragPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.type==='asset') {
      const dragAsset=payload.asset||{};
      if (dragAsset.kind==='source') return showaveSourceTemplatePayload(dragAsset);
      if (dragAsset.kind==='effect') {
        const effect=show.effects.find(item=>item.id===dragAsset.id);
        return effect?showaveBindingPayload('effect','effect',effect):null;
      }
      if (dragAsset.kind==='cue') {
        const cue=show.cues.find(item=>item.id===dragAsset.id);
        const sequence=cue&&show.sequences.find(item=>(item.cueIds||[]).includes(cue.id));
        return cue&&sequence?showaveBindingPayload('source','cue',cue,{sequenceId:sequence.id}):null;
      }
      /* A group or patched fixture is a Composer target, not a SHOWAVE base
         light. Exporting either would bypass the one-personality + Quantity
         Lighting Clip contract, so those cards deliberately remain internal. */
      return null;
    }
    if (payload.type==='column') {
      const column=show.composer&&show.composer.columns.find(item=>item.id===payload.columnId&&!isPrivateComposerColumn(item));
      return column?showaveBindingPayload('source','composer-column',column):null;
    }
    if (payload.type==='clip') {
      const clip=show.composer&&show.composer.clips.find(item=>item.id===payload.clipId&&!isPrivateComposerClip(item));
      const layer=clip&&show.composer.layers.find(item=>item.id===clip.layerId&&!isPrivateComposerLayer(item));
      return clip&&layer?showaveBindingPayload('source','composer-clip',clip,{layerId:layer.id}):null;
    }
    return null;
  }

  function writeComposerDrag(event,payload,mime) {
    composerDrag=payload;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed=payload.type==='asset'?'copy':'copyMove';
    event.dataTransfer.setData(mime,JSON.stringify(payload));
    const externalPayload=showaveLightingDragPayload(payload);
    if (externalPayload) event.dataTransfer.setData('text/plain',JSON.stringify(externalPayload));
  }

  function focusComposerCell(rowIndex,columnIndex) {
    const selector=`.gsl-clip-slot[data-row-index="${rowIndex}"][data-column-index="${columnIndex}"] button`;
    const target=$(selector,byId('gslComposerGrid')); if(target)target.focus();
  }

  function mapperPositionFromPointer(event) {
    const stage = byId('gslMapperStage'), rect = stage.getBoundingClientRect();
    const nx = clamp((event.clientX - rect.left) / Math.max(1,rect.width),0,1);
    const ny = clamp((event.clientY - rect.top) / Math.max(1,rect.height),0,1);
    return {x:Math.round((-10 + nx * 20) * 10) / 10,y:Math.round((6 - ny * 12) * 10) / 10};
  }

  function startMapperDrag(event) {
    const node = event.target.closest('[data-map-fixture-id]');
    if (!node || event.button !== 0 || bridgeState.outputting) return;
    const fixture = fixtureById(node.dataset.mapFixtureId); if (!fixture) return;
    mapperDrag={fixtureId:fixture.id,node,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,moved:false,remembered:false};
    node.setPointerCapture && node.setPointerCapture(event.pointerId);
  }

  function moveMapperDrag(event) {
    if (!mapperDrag || event.pointerId !== mapperDrag.pointerId) return;
    if (!mapperDrag.moved && Math.hypot(event.clientX-mapperDrag.startX,event.clientY-mapperDrag.startY) < 3) return;
    const fixture=fixtureById(mapperDrag.fixtureId); if(!fixture)return;
    if (!mapperDrag.remembered) {
      if (!requireDisarmed('editing the stage map')) { finishMapperDrag(event); return; }
      remember(); mapperDrag.remembered=true;
      if (!show.programmer.selectedFixtureIds.includes(fixture.id)) Engine.selectFixtures(show,{fixtureIds:[fixture.id],mode:'replace'});
    }
    mapperDrag.moved=true; event.preventDefault();
    const point=mapperPositionFromPointer(event); fixture.position.x=point.x;fixture.position.y=point.y;
    const visual=mapperPoint(point);
    mapperDrag.node.style.setProperty('--map-x',`${visual.left.toFixed(3)}%`);
    mapperDrag.node.style.setProperty('--map-y',`${visual.top.toFixed(3)}%`);
    mapperDrag.node.classList.add('dragging','on');
    byId('gslMapperCoordinates').textContent=`${fixture.name} · X ${point.x.toFixed(1)} · Y ${point.y.toFixed(1)} · Z ${Number(fixture.position.z || 0).toFixed(1)}`;
  }

  function finishMapperDrag(event) {
    if (!mapperDrag || event && event.pointerId !== mapperDrag.pointerId) return;
    const fixture=fixtureById(mapperDrag.fixtureId), moved=mapperDrag.moved;
    if (mapperDrag.node) mapperDrag.node.classList.remove('dragging');
    mapperDrag=null;
    if (moved) {
      scheduleSave('Map fixture position'); renderAll();
      status(`${fixture ? fixture.name : 'Fixture'} placed on the lighting stage.`,'success');
    }
  }

  function autoLayoutMapper() {
    if (!requireDisarmed('auto-arranging the stage map')) return;
    const selected=selectedFixtures(), fixtures=selected.length ? selected : show.fixtures.slice();
    if (!fixtures.length) return status('Define and patch fixtures before arranging the stage.','warning');
    mutate('Auto layout fixture map',()=>{
      const columns=Math.ceil(Math.sqrt(fixtures.length * 1.7)), rows=Math.ceil(fixtures.length / columns);
      fixtures.forEach((fixture,index)=>{
        const column=index%columns,row=Math.floor(index/columns);
        fixture.position.x=columns===1?0:-8+(column/(columns-1))*16;
        fixture.position.y=rows===1?0:4-(row/(rows-1))*8;
      });
    });
    status(`Arranged ${fixtures.length} fixture${fixtures.length===1?'':'s'} on the stage map.`,'success');
  }

  function centerMappedSelection() {
    if (!requireDisarmed('centering fixtures on the stage map')) return;
    const fixtures=selectedFixtures();
    if (!fixtures.length) return status('Select one or more mapped fixtures to center.','warning');
    mutate('Center fixture map selection',()=>{
      const center=fixtures.reduce((value,fixture)=>({x:value.x+Number(fixture.position.x||0),y:value.y+Number(fixture.position.y||0)}),{x:0,y:0});
      center.x/=fixtures.length;center.y/=fixtures.length;
      fixtures.forEach(fixture=>{fixture.position.x=clamp(Number(fixture.position.x||0)-center.x,-10,10);fixture.position.y=clamp(Number(fixture.position.y||0)-center.y,-6,6);});
    });
    status(`Centered ${fixtures.length} selected fixture${fixtures.length===1?'':'s'}.`,'success');
  }

  function runMapperAction(action) {
    const actions={
      fixtures:()=>openTool('fixture-editor.html'),patch:()=>setWorkspace('patch'),map:()=>setWorkspace('mapper'),network:()=>setWorkspace('network'),
      showave:returnToShowave,output:()=>openTool('advanced-output.html'),composer:()=>setWorkspace('live')
    };
    const run=actions[action];if(run)run();
  }

  function setWorkspace(name) {
    if (!WORKSPACES[name]) return;
    workspace = name; renderWorkspace();
    if (name !== 'library') libraryRenderToken++;
    if (name === 'library') renderLibrary();
    if (name === 'network' && Bridge) {
      Bridge.adapters().then(rows => fillAdapters(rows)).catch(error => status(error.message,'error'));
      Bridge.nodes().catch(() => {});
    }
    if (name === 'fx') drawFx();
  }

  function selectFixture(id, event) {
    const index = show.fixtures.findIndex(fixture => fixture.id === id);
    if (event && event.shiftKey && lastFixtureIndex >= 0) {
      const from = Math.min(index,lastFixtureIndex), to = Math.max(index,lastFixtureIndex);
      Engine.selectFixtures(show,{fixtureIds:show.fixtures.slice(from,to + 1).map(fixture => fixture.id),mode:event.ctrlKey || event.metaKey ? 'add' : 'replace'});
    } else Engine.selectFixtures(show,{fixtureIds:[id],mode:event && (event.ctrlKey || event.metaKey) ? 'toggle' : 'replace'});
    lastFixtureIndex = index; renderAll();
  }

  function addGroup() {
    const selected = show.programmer.selectedFixtureIds.slice();
    if (!selected.length) return status('Select fixtures before storing a group.','warning');
    const name = prompt('Group name', `Group ${show.groups.length + 1}`); if (!name) return;
    mutate('Store fixture group', () => show.groups.push({id:uid('group'),name:name.trim(),fixtureIds:selected,
      grid:selected.map((fixtureId,index) => ({fixtureId,x:index,y:0,z:0}))}));
  }

  function addPatch() {
    if (!requireDisarmed('editing the fixture patch')) return;
    const profileId = byId('gslPatchProfile').value;
    const transientProfile = selectedCatalogProfile && selectedCatalogProfile.id === profileId ? selectedCatalogProfile : null;
    const profile = profileById(profileId) || transientProfile;
    if (!profile) return status('Choose a fixture profile.','warning');
    const quantity = Math.round(clamp(byId('gslPatchQuantity').value,1,512));
    const firstFid = Math.round(clamp(byId('gslPatchFixtureId').value,1,999999));
    let universe = Math.round(clamp(byId('gslPatchUniverse').value,1,63999));
    let address = Math.round(clamp(byId('gslPatchAddress').value,1,512));
    const baseName = byId('gslPatchName').value.trim() || profile.name;
    let targetGroup = show.groups.find(group => group.name === profile.name) || null;
    const added = mutate('Patch fixtures', () => {
      const rows = [];
      for (let index = 0; index < quantity; index++) {
        if (address + profile.footprint - 1 > 512) { universe++; address = 1; }
        const result = Engine.addFixtures(show, {profileId,profile:transientProfile || undefined,quantity:1,id:`fixture:${firstFid + index}`,
          name:quantity > 1 ? `${baseName} ${index + 1}` : baseName,universe,address,
          groupId:targetGroup && targetGroup.id,groupName:profile.name,gridX:index,gridY:0});
        if (!targetGroup) targetGroup = show.groups.find(group => result.some(fixture => group.fixtureIds.includes(fixture.id))) || null;
        rows.push(...result); address += profile.footprint;
      }
      Engine.selectFixtures(show,rows.map(fixture => fixture.id));
      return rows;
    });
    if (added) {
      if (transientProfile) selectedCatalogProfile = show.profiles.find(item => item.id === profileId) || null;
      byId('gslPatchFixtureId').value = String(firstFid + quantity);
      if (address > 512) { universe++; address = 1; }
      byId('gslPatchUniverse').value = String(universe);
      byId('gslPatchAddress').value = String(address);
      status(`Patched ${added.length} × ${profile.name}.`,'success');
    }
  }

  function removePatch() {
    if (!requireDisarmed('editing the fixture patch')) return;
    const ids = show.programmer.selectedFixtureIds.slice();
    if (!ids.length) return status('Select fixtures to unpatch.','warning');
    if (!confirm(`Unpatch ${ids.length} selected fixture${ids.length === 1 ? '' : 's'}? Cues and palettes keep no orphan values.`)) return;
    const count = mutate('Unpatch fixtures', () => Engine.removeFixtures(show,ids));
    status(`Unpatched ${count} fixture${count === 1 ? '' : 's'}.`);
  }

  function storePalette(family) {
    if (!show.programmer.selectedFixtureIds.length) return status('Select fixtures before storing a palette.','warning');
    const attributes = Object.values(show.programmer.values).flatMap(values => Object.keys(values)).filter(attribute => attributeFamily(attribute) === family);
    if (!attributes.length) return status(`Set at least one ${family} value in the Programmer first.`,'warning');
    const name = prompt(`${family[0].toUpperCase() + family.slice(1)} palette name`, `${family[0].toUpperCase() + family.slice(1)} ${show.palettes.filter(item => paletteFamily(item) === family).length + 1}`);
    if (!name) return;
    const selected = new Set(show.programmer.selectedFixtureIds), values = {};
    Object.entries(show.programmer.values).forEach(([fixtureId,fixtureValues]) => {
      if (!selected.has(fixtureId)) return;
      const picked = Object.fromEntries(Object.entries(fixtureValues).filter(([attribute]) => attributeFamily(attribute) === family));
      if (Object.keys(picked).length) values[fixtureId] = picked;
    });
    const palette = mutate(`Store ${family} palette`, () => Engine.storePalette(show,{name,mode:'selective',values}));
    if (palette) status(`Stored ${palette.name}.`,'success');
  }

  function applyPalette(id) {
    mutate('Apply lighting palette', () => Engine.applyPalette(show,id));
    status('Palette loaded into the Programmer.');
  }

  function openRecordDialog() {
    const sequence = activeSequence(); if (!sequence) return;
    byId('gslRecordNumber').value = `${sequence.cueIds.length + 1}.00`;
    byId('gslRecordName').value = `Cue ${sequence.cueIds.length + 1}`;
    byId('gslRecordSequence').value = sequence.id;
    showDialog('gslRecordDialog');
  }

  function recordCueFromDialog() {
    const sequenceId = byId('gslRecordSequence').value, sequence = sequenceById(sequenceId);
    if (!sequence) return;
    sequence.tracking = byId('gslRecordTracking').checked;
    const cue = mutate('Record lighting cue', () => Engine.storeCue(show,{
      name:byId('gslRecordName').value || `Cue ${sequence.cueIds.length + 1}`,
      fadeMs:milliseconds(byId('gslRecordFadeIn').value),sequenceId
    }));
    if (cue) { selectedCueId = cue.id; activeSequenceId = sequence.id; status(`Recorded ${cue.name}.`,'success'); }
    hideDialogs();
  }

  function ensurePlayback(sequence) {
    let playback = show.playbacks.find(item => item.sequenceId === sequence.id);
    if (!playback) playback = Engine.assignPlayback(show,{name:sequence.name,sequenceId:sequence.id,level:0});
    selectedPlaybackId = playback.id; return playback;
  }

  function goSequence(direction) {
    const sequence = activeSequence(); if (!sequence) return;
    mutate(direction > 0 ? 'Go lighting cue' : 'Back lighting cue', () => {
      const playback = ensurePlayback(sequence);
      return direction > 0 ? Engine.go(show,playback.id,Date.now()) : Engine.back(show,playback.id,Date.now());
    }, {save:false});
    status(direction > 0 ? `GO · ${sequence.name}` : `BACK · ${sequence.name}`,'playback');
  }

  function releaseSequence() {
    const playback = activePlaybackForSequence(activeSequenceId); if (!playback) return;
    mutate('Release lighting playback', () => Engine.release(show,playback.id), {save:false});
    status(`Released ${playback.name}.`);
  }

  function startFlash(button) {
    const node = button && button.closest('[data-playback-id]'), playback = node && playbackById(node.dataset.playbackId);
    if (!playback || flashState) return;
    const runtime = show.runtime.playbacks[playback.id] || {};
    flashState = {playbackId:playback.id,active:!!runtime.active,
      level:runtime.level == null ? playback.level : runtime.level};
    selectedPlaybackId = playback.id;
    if (!runtime.active) Engine.go(show,playback.id,Date.now());
    Engine.setPlaybackLevel(show,playback.id,1);
    status(`FLASH · ${playback.name}`,'playback');
  }

  function endFlash() {
    if (!flashState) return;
    const state = flashState; flashState = null;
    const playback = playbackById(state.playbackId);
    if (playback) {
      if (state.active) Engine.setPlaybackLevel(show,playback.id,state.level);
      else Engine.release(show,playback.id);
    }
    renderAll();
  }

  function addSequence() {
    const name = prompt('Sequence name',`Sequence ${show.sequences.length + 1}`); if (!name) return;
    const sequence = mutate('Create lighting sequence', () => Engine.createSequence(show,{name,tracking:true}));
    if (sequence) { activeSequenceId = sequence.id; ensurePlayback(sequence); renderAll(); }
  }

  function selectedOrActiveCue() {
    const sequence = activeSequence();
    if (selectedCueId) return cueById(selectedCueId);
    const playback = sequence && activePlaybackForSequence(sequence.id), runtime = playback && show.runtime.playbacks[playback.id];
    return runtime && runtime.active ? cueById(sequence.cueIds[runtime.cursor]) : sequence && cueById(sequence.cueIds[0]);
  }

  function addCueToTimeline() {
    const cue = selectedOrActiveCue(), sequence = activeSequence();
    if (!cue || !sequence || !Hub) return status('Select a lighting cue first.','warning');
    if (!Timeline) {
      Hub.emit('timeline:recordable',{type:'Lighting Cue',label:cue.name,target:{kind:'lighting',cueId:cue.id},
        payload:{showId:show.id,cueId:cue.id,sequenceId:sequence.id}}, {activity:true,label:`Timeline: ${cue.name}`});
      return status('Lighting Cue offered to Timeline Live Record. Open Timeline to place it manually.');
    }
    let project = Hub.get('timeline.project', null);
    project = project ? Timeline.normaliseProject(project) : Timeline.createProject();
    let track = project.tracks.find(item => item.target && item.target.kind === 'lighting' && item.target.id === sequence.id);
    if (!track) {
      project = Timeline.addTrack(project,{name:`GSL5 · ${sequence.name}`,color:themeValue('--color-accent') || themeValue('--a500'),target:{kind:'lighting',id:sequence.id,name:sequence.name}});
      track = project.tracks[project.tracks.length - 1];
    }
    project = Timeline.addTrigger(project,track.id,{type:'Lighting Cue',timeMs:project.cursorMs,label:cue.name,
      target:{kind:'lighting',id:sequence.id,cueId:cue.id,name:cue.name},payload:{showId:show.id,cueId:cue.id,sequenceId:sequence.id}});
    Hub.patch('timeline',{schema:Timeline.schema || 1,project,updatedAt:Date.now()},{reason:'Add GSL5 Lighting Cue'});
    status(`Added ${cue.name} to SHOWAVE Timeline at the cursor.`,'success');
  }

  function fxSpecFromForm(existing) {
    const waveform = byId('gslFxWave').value;
    return {
      name:byId('gslFxLabel').value.trim() || existing&&existing.name || `Effect ${show.effects.length + 1}`,
      fixtureIds:show.programmer.selectedFixtureIds.slice(), attribute:byId('gslFxAttribute').value,
      groupId:show.programmer.selectedFixtureIds.length ? '' : existing&&existing.groupId || '',
      waveform:waveform === 'chase' ? 'steps' : waveform,
      steps:waveform === 'chase' ? existing&&existing.waveform==='steps'&&existing.steps.length ? clone(existing.steps)
        : [{value:1,width:1,transition:0},{value:0,width:1,transition:0}] : [],
      mode:byId('gslFxMode').value,size:Number(byId('gslFxSize').value) / 100,
      speedBpm:Number(byId('gslFxSpeed').value) / 100 * 60,
      direction:byId('gslFxDirection').value,
      rateSource:byId('gslFxRateSource').value,
      rateMultiplier:Number(byId('gslFxSpeed').value) / 100,
      phase:Number(byId('gslFxPhase').value),spread:Number(byId('gslFxSpread').value),
      base:existing ? existing.base : .5,offset:existing ? existing.offset : 0,
      enabled:existing ? existing.enabled : true,autostart:existing ? existing.autostart : true,
      startedAt:existing ? existing.startedAt : Date.now()
    };
  }

  function addEffect() {
    if (!show.programmer.selectedFixtureIds.length) return status('Select fixtures before creating an effect.','warning');
    const spec=fxSpecFromForm();
    if(!selectedFixtures().some(fixture=>Engine.channelsFor(profileById(fixture.profileId),spec.attribute).length))
      return status(`The selected fixtures do not declare ${spec.attribute}. Choose one of their fixture attributes.`,'warning');
    const effect = mutate('Create lighting effect', () => Engine.addEffect(show,spec));
    if (effect) { selectedEffectId = effect.id; renderAll(); status(`Created ${effect.name} for ${effect.fixtureIds.length} fixtures.`,'success'); }
  }

  function applyEffectForm() {
    const existing = effectById(selectedEffectId);
    if (!existing) return addEffect();
    const spec = fxSpecFromForm(existing);
    const targets=spec.fixtureIds.length?selectedFixtures():existing.fixtureIds.map(fixtureById).filter(Boolean);
    if(!targets.some(fixture=>Engine.channelsFor(profileById(fixture.profileId),spec.attribute).length))
      return status(`No target fixture declares ${spec.attribute}. Choose a supported attribute before updating.`,'warning');
    mutate('Update lighting effect', () => Object.assign(existing,spec,{id:existing.id,fixtureIds:spec.fixtureIds.length ? spec.fixtureIds : existing.fixtureIds}));
    status(`Updated ${existing.name}.`,'success');
  }

  function startSelectedEffect() {
    const effect=effectById(selectedEffectId);if(!effect)return;
    mutate('Start lighting effect',()=>{effect.enabled=true;Engine.startEffect(show,effect.id,Date.now());});
    status(`${effect.name} started${bridgeState.outputting?' on physical output':' in Preview'}.`,'success');
  }

  function stopSelectedEffect() {
    const effect=effectById(selectedEffectId);if(!effect)return;
    mutate('Stop lighting effect',()=>{effect.enabled=false;Engine.stopEffect(show,effect.id);});
    status(`${effect.name} stopped. Restart it or remove it from the show.`,'success');
  }

  function duplicateSelectedEffect() {
    const effect=effectById(selectedEffectId);if(!effect)return;
    const copy=mutate('Duplicate lighting effect',()=>Engine.addEffect(show,Object.assign({},clone(effect),{
      id:uid('effect'),name:`${effect.name} copy`,enabled:false,autostart:false,startedAt:0
    })));
    if(copy){selectedEffectId=copy.id;renderAll();status(`${copy.name} created stopped. Edit it, then press Start.`,'success');}
  }

  function deleteSelectedEffect() {
    const effect=effectById(selectedEffectId);if(!effect||!requireDisarmed('deleting a lighting effect'))return;
    const used=show.cues.filter(cue=>cue.effectIds.includes(effect.id)).length+
      show.composer.clips.filter(clip=>clip.items.some(item=>item.kind==='effect'&&item.refId===effect.id)).length;
    if(!confirm(`Delete ${effect.name}${used?` and remove it from ${used} cue / clip references`:''}? Undo restores it.`))return;
    const removed=mutate('Delete lighting effect',()=>Engine.removeEffect(show,effect.id));
    if(removed){selectedEffectId=show.effects[0]?.id||'';selectedLibraryAssetKey='';renderAll();status(`${removed.name} removed from the show and its effect stacks.`,'success');}
  }

  function importChaser() {
    const project = Hub && Hub.get ? Hub.get('chaser.project', null) : null;
    if (!project) return status('No SHOWAVE Chaser project is published. Open Chaser and save a sequence first.','warning');
    if (!show.programmer.selectedFixtureIds.length) return status('Select lighting fixtures to map Chaser slices onto.','warning');
    const sequence = mutate('Import SHOWAVE Chaser sequence', () => Engine.importChaserSequence(show,project,show.programmer.selectedFixtureIds));
    if (sequence) {
      activeSequenceId = sequence.id; const playback = ensurePlayback(sequence); selectedPlaybackId = playback.id;
      status(`Imported ${sequence.name} as ${sequence.cueIds.length} lighting cues.`,'success'); setWorkspace('cues'); renderAll();
    }
  }

  function networkConfig() {
    return {
      protocol:byId('gslProtocol').value,
      adapterIp:byId('gslAdapter').value || '0.0.0.0',
      destinationMode:byId('gslDestinationMode').value,
      targetIp:byId('gslTargetIp').value.trim(),
      fps:Number(byId('gslOutputFps').value) || 40,
      priority:Number(byId('gslSacnPriority').value) || 100,
      artSync:byId('gslArtSync').checked,
      holdLastLook:byId('gslHoldLast').checked,
      nodeId:selectedNodeId,
      universes:Object.keys(evaluated.universes || {}).map(Number),
      blackout:operatorBlackout
    };
  }

  function fillAdapters(rows) {
    const select = byId('gslAdapter'), current = select.value;
    select.innerHTML = '<option value="0.0.0.0">Automatic</option>' + (rows || []).filter(row => (row.address || row.ip) !== '0.0.0.0').map(row => `<option value="${safe(row.address || row.ip)}">${safe(row.name || row.label || row.address || row.ip)} · ${safe(row.address || row.ip)}</option>`).join('');
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  function armOutput() {
    if (!Bridge) return status('The native lighting bridge module is not loaded.','error');
    if (bridgeState.outputting) {
      const config = networkConfig();
      Bridge.stop({holdLastLook:config.holdLastLook}).then(() => status(config.holdLastLook ? 'Output disarmed; receivers may hold the last look.' : 'Output disarmed after blackout.')).catch(error => status(error.message,'error'));
      return;
    }
    if (!bridgeState.available) return status(bridgeState.lastError || 'The native lighting bridge is unavailable.','error');
    const validation = patchValidation();
    if (!validation.valid) { setWorkspace('patch'); return status('Resolve patch conflicts before arming physical output.','error'); }
    const config = networkConfig();
    if (!config.universes.length) return status('Patch at least one fixture before arming physical output.','warning');
    byId('gslArmProtocol').textContent = config.protocol === 'sacn' ? 'sACN / E1.31' : 'Art-Net 4';
    byId('gslArmDestination').textContent = config.destinationMode.replaceAll('_',' ');
    byId('gslArmTarget').textContent = config.destinationMode === 'multicast' ? 'Per-universe multicast'
      : config.destinationMode === 'discovered_unicast' ? 'Discovered subscribed Art-Net nodes'
        : config.targetIp || 'No target';
    showDialog('gslArmDialog');
  }

  function confirmArm() {
    if(outputArmPending)return;
    const config = networkConfig(); config.blackout = byId('gslArmBlackoutFirst').checked;
    operatorBlackout = config.blackout;
    outputArmPending=true;hideDialogs();renderHeader();status('Arming physical lighting output…');
    Bridge.start(config).then(() => {
      bridgeState = Bridge.snapshot(); renderAll(); status(`${config.protocol === 'sacn' ? 'sACN' : 'Art-Net'} output armed${config.blackout ? ' in Blackout' : ''}.`,'success');
    }).catch(error => { status(`Output did not arm: ${error.message}`,'error'); renderAll(); })
      .finally(()=>{outputArmPending=false;renderHeader();});
  }

  function toggleBlackout() {
    const wanted = !(operatorBlackout || (bridgeState.outputting && bridgeState.blackout)); operatorBlackout = wanted;
    renderHeader();
    if (Bridge && bridgeState.outputting) Bridge.blackout(wanted).then(() => {
      bridgeState = Bridge.snapshot(); renderHeader(); status(wanted ? 'BLACKOUT active.' : 'Blackout released.','warning');
    }).catch(error => { operatorBlackout = !wanted; status(error.message,'error'); renderHeader(); });
    else status(wanted ? 'Blackout prepared for the next output session.' : 'Preview blackout released.');
  }

  function showDialog(id) { const node = byId(id); if (node) { node.hidden = false; const focusable = $('input,select,button',node); if (focusable) setTimeout(() => focusable.focus(),0); } }
  function hideDialogs() { $$('.gsl-modal').forEach(node => { node.hidden = true; }); }

  function openTool(file) {
    try { if (global.parent && global.parent !== global && typeof global.parent.__openliveOpenPanel === 'function') return global.parent.__openliveOpenPanel(file); } catch (_) { /* cross-origin parent */ }
    global.open(file,`showave-${file.replace(/\W/g,'-')}`);
  }

  function returnToShowave() {
    try {
      if (global.parent && global.parent !== global && typeof global.parent.__openliveClosePanel === 'function')
        return global.parent.__openliveClosePanel();
    } catch (_) { /* cross-origin parent */ }
    /* GSL5 is a named external product window. RUN IN SHOWAVE must hand focus
       back to the deck without navigating this lighting runtime over itself. */
    try {
      if (global.opener && !global.opener.closed) { global.opener.focus(); return true; }
    } catch (_) { /* opener may be cross-origin */ }
    const deck=global.open('index.html','showaveLive');
    if (deck) { try { deck.focus(); } catch (_) {} return true; }
    status('SHOWAVE could not be opened. Allow pop-ups for this site and try again.','warning');
    return false;
  }

  function closeLibraryWindow() {
    /* The named product window may close itself. A directly visited tab cannot,
       so its close control falls back to the same safe SHOWAVE focus path. */
    try {
      if (global.opener && !global.opener.closed) { global.close(); return true; }
    } catch (_) { /* opener may be cross-origin */ }
    return returnToShowave();
  }

  function download(name,content,type) {
    window.OpenLiveSessionPolicy?.assertCanWrite('Exporting GSL5');
    const url = URL.createObjectURL(new Blob([content],{type:type || 'application/json'})), anchor = document.createElement('a');
    anchor.href=url; anchor.download=name; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }

  function saveFile() {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Saving a GSL5 show'); }
      catch (error) { status(error.message,'error'); }
      return;
    }
    const project = shareable();
    try {
      download(`${show.name.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'') || 'gsl5-show'}.gsl5.json`,JSON.stringify(project,null,2));
      if(saveNow('Export GSL5 show'))status('GSL5 show exported and saved locally.','success');
      else status('GSL5 show exported. Local saving failed; keep the downloaded file.','warning');
    } catch(error){status(`Could not export show: ${error.message}`,'error');}
  }

  function exportPatch() {
    if (window.OpenLiveSessionPolicy?.sessionOnly) {
      try { window.OpenLiveSessionPolicy.assertCanWrite('Exporting a patch'); }
      catch (error) { status(error.message,'error'); }
      return;
    }
    const rows = [['Fixture ID','Name','Profile','Universe','Address','Footprint','Stage X','Stage Y']];
    show.fixtures.forEach(fixture => rows.push([fixtureNumber(fixture),fixture.name,profileById(fixture.profileId)?.name || fixture.profileId,fixture.universe,fixture.address,footprint(fixture),fixture.position.x,fixture.position.y]));
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(',')).join('\r\n');
    download('gsl5-patch.csv',csv,'text/csv');
  }

  function newShow() {
    if (!requireDisarmed('creating a new GSL5 show')) return;
    if (!confirm(isSessionOnly()?'Create a new GSL5 show? Undo can restore your current show for this session.':'Create a new GSL5 show? Export this show first if you need another copy.')) return;
    remember(); show = Engine.createShow({name:'New GSL5 Show'});
    const sequence = Engine.createSequence(show,{name:'Main Cue List',tracking:true});
    const playback = Engine.assignPlayback(show,{name:'Main',sequenceId:sequence.id,level:0});
    activeSequenceId=sequence.id;selectedPlaybackId=playback.id;selectedEffectId='';selectedCueId='';
    syncFixtureEditorProfiles(); scheduleSave('New GSL5 show'); renderAll(); status('New GSL5 show created.');
  }

  function handleLoadedFile(file) {
    if (!file) return;
    if (!requireDisarmed('opening another GSL5 show')) return;
    if(file.size > 10*1024*1024)return status('The GSL5 show file exceeds 10 MB. Open a smaller show file.','error');
    const token=++fileLoadToken,revision=documentRevision;
    status(`Opening ${file.name||'GSL5 show'}…`);
    file.text().then(text => {
      if(token!==fileLoadToken)return;
      if(revision!==documentRevision)return status('The show changed while the file was loading. Open the file again when ready.','warning');
      if(!requireDisarmed('opening another GSL5 show'))return;
      const next=Engine.importShowFile(text);
      remember();show=next;ensureActiveObjects();syncFixtureEditorProfiles();scheduleSave('Open GSL5 show');renderAll();
      status(`Opened ${show.name}. Playback and effects are stopped.`,'success');
    }).catch(error => {if(token===fileLoadToken)status(`Could not open show: ${error.message}`,'error');});
  }

  function menuAction(action) {
    closeMenus();
    const actions = {
      'new-show':newShow,'save-show':saveFile,'load-show':()=>byId('gslLoadFile').click(),'export-patch':exportPatch,
      undo,redo,clear:()=>mutate('Clear programmer',()=>Engine.clearProgrammer(show,{selection:false,keepSelection:true})),
      'record-cue':openRecordDialog,go:()=>goSequence(1),back:()=>goSequence(-1),release:releaseSequence,blackout:toggleBlackout,
      'open-chaser':()=>openTool('chaser.html'),'open-timeline':()=>openTool('timeline.html'),
      'open-fixture-editor':()=>openTool('fixture-editor.html'),network:()=>setWorkspace('network')
    };
    const run=actions[action];if(run)run();
  }

  function closeMenus() {
    $$('.gsl-menu').forEach(menu => menu.hidden=true);
    $$('.gsl-menus .menu-top').forEach(button => { button.classList.remove('open'); button.setAttribute('aria-expanded','false'); });
  }

  function openMenu(button) {
    const id = `gslMenu${button.dataset.gslMenu[0].toUpperCase()}${button.dataset.gslMenu.slice(1)}`, menu = byId(id);
    if (!menu) return;
    const wasOpen=!menu.hidden;closeMenus();if(wasOpen)return;
    const rect=button.getBoundingClientRect();menu.hidden=false;menu.style.left=`${rect.left}px`;menu.style.top=`${rect.bottom}px`;button.classList.add('open');button.setAttribute('aria-expanded','true');
  }

  function handleLightingCommand(command) {
    if (!command) return;
    const action=String(command.action || command.name || '').toLowerCase(), payload=command.payload || command;
    const linkedActions=new Set(['composer-column-go','composer-clip-go','composer-clip-release','composer-layer-release','cue-go','effect-go','effect-stop','fixture-source-go','fixture-source-stop']);
    if(linkedActions.has(action)){
      const commandShowId=typeof payload.showId==='string'?payload.showId:
        typeof payload.projectId==='string'?payload.projectId:'';
      if(commandShowId!==show.id)
        return status('Ignored a lighting command for a different GSL5 show.','error');
    }
    const exactId=(key,collection)=>{
      const id=payload&&payload[key];
      return typeof id==='string'&&collection.some(item=>item.id===id)?id:'';
    };
    if(action==='composer-column-go'){
      const id=exactId('columnId',show.composer.columns.filter(column=>!isPrivateComposerColumn(column)));
      if(!id)return status('SHOWAVE requested a lighting column that is not in this GSL5 show.','error');
      const column=show.composer.columns.find(item=>item.id===id);
      const clips=mutate('SHOWAVE Lighting Column',()=>Engine.triggerComposerColumn(show,id,Date.now()),{save:false,history:false});
      if(clips)status(`SHOWAVE GO · ${column.name}`,'playback');
      return;
    }
    if(action==='composer-clip-go'){
      const id=exactId('clipId',show.composer.clips);
      if(!id)return status('SHOWAVE requested a lighting clip that is not in this GSL5 show.','error');
      const clip=mutate('SHOWAVE Lighting Clip',()=>Engine.triggerComposerClip(show,id,Date.now()),{save:false,history:false});
      if(clip)status(`SHOWAVE GO · ${clip.name}`,'playback');
      return;
    }
    if(action==='composer-clip-release'){
      const id=exactId('clipId',show.composer.clips);
      if(!id)return status('SHOWAVE requested a Lighting Clip that is not in this GSL5 show.','error');
      const clip=show.composer.clips.find(item=>item.id===id);
      const released=mutate('SHOWAVE Lighting Clip Release',()=>Engine.releaseComposerClip(show,id),{save:false,history:false});
      if(released)status(`Released ${clip.name}.`);
      return;
    }
    if(action==='composer-layer-release'){
      const id=exactId('layerId',show.composer.layers);
      if(!id)return status('SHOWAVE requested a lighting layer that is not in this GSL5 show.','error');
      const layer=show.composer.layers.find(item=>item.id===id);
      const released=mutate('SHOWAVE Lighting Release',()=>Engine.releaseComposerLayer(show,id),{save:false,history:false});
      if(released)status(`Released ${layer.name}.`);
      return;
    }
    if(action==='fixture-source-go'||action==='fixture-source-stop'){
      const assetType=payload&&payload.assetType;
      const collection=assetType==='fixture-group'?show.groups:assetType==='fixture-profile'?show.profiles:null;
      const id=collection&&exactId('assetId',collection);
      if(!id)return status('SHOWAVE requested a fixture source that is not in this GSL5 show.','error');
      const asset=collection.find(item=>item.id===id), enabled=new Set(show.fixtures.filter(fixture=>fixture.enabled!==false).map(fixture=>fixture.id));
      const targetIds=assetType==='fixture-group'
        ? asset.fixtureIds.filter(fixtureId=>enabled.has(fixtureId))
        : show.fixtures.filter(fixture=>fixture.enabled!==false&&fixture.profileId===asset.id).map(fixture=>fixture.id);
      if(action==='fixture-source-go'&&!targetIds.length)
        return status(`${asset.name} has no enabled patched fixtures.`, 'error');
      const result=mutate(action==='fixture-source-go'?'SHOWAVE Fixture Source':'SHOWAVE Fixture Source Stop',
        ()=>action==='fixture-source-go'
          ? Engine.startFixtureSource(show,assetType,id,Date.now())
          : Engine.stopFixtureSource(show,assetType,id),
        {save:false,history:false});
      if(result)status(`${action==='fixture-source-go'?'SOURCE GO':'SOURCE STOP'} · ${asset.name}${targetIds.length?` · ${targetIds.length} fixture${targetIds.length===1?'':'s'}`:''}`,
        action==='fixture-source-go'?'playback':'');
      return;
    }
    if(action==='effect-go'||action==='effect-stop'){
      const id=exactId('effectId',show.effects);
      if(!id)return status('SHOWAVE requested a lighting effect that is not in this GSL5 show.','error');
      const effect=show.effects.find(item=>item.id===id);
      const result=mutate(action==='effect-go'?'SHOWAVE Lighting Effect':'SHOWAVE Lighting Effect Stop',
        ()=>action==='effect-go'?Engine.startEffect(show,id,Date.now()):Engine.stopEffect(show,id),
        {save:false,history:false});
      if(result)status(`${action==='effect-go'?'FX GO':'FX STOP'} · ${effect.name}`,action==='effect-go'?'playback':'');
      return;
    }
    if (action === 'blackout') return toggleBlackout();
    if (action === 'go') return goSequence(1);
    if (action === 'back') return goSequence(-1);
    if (action === 'release' || action === 'stop') return releaseSequence();
    if (action === 'cue-go' || action === 'playcue') {
      const sequenceId=exactId('sequenceId',show.sequences), cueId=exactId('cueId',show.cues);
      const sequence=sequenceById(sequenceId), cue=cueById(cueId);
      if (!sequence || !cue || !sequence.cueIds.includes(cue.id))
        return status('SHOWAVE requested a cue that is not in that GSL5 sequence.','error');
      activeSequenceId=sequence.id;
      mutate('Timeline Lighting Cue',()=>{
        const playback=ensurePlayback(sequence), runtime=show.runtime.playbacks[playback.id];
        runtime.cursor=Math.max(-1,sequence.cueIds.indexOf(cue.id)-1);runtime.active=runtime.cursor>=0;
        Engine.go(show,playback.id,Date.now());selectedPlaybackId=playback.id;
      },{save:false,history:false});
      status(`Timeline GO · ${cue.name}`,'playback');
      return;
    }
  }

  /* Event binding ---------------------------------------------------------- */
  function bind() {
    byId('gslLibraryOpenShow').addEventListener('click',()=>byId('gslLoadFile').click());
    byId('gslLibrarySaveShow').addEventListener('click',saveFile);
    byId('gslLibraryOpenMapper').addEventListener('click',()=>setWorkspace('mapper'));
    byId('gslLibraryClose').addEventListener('click',closeLibraryWindow);
    byId('gslLibraryBuildPersonality').addEventListener('click',()=>openPersonalityBuilder());
    byId('gslLibraryImportD4').addEventListener('click',()=>byId('gslD4Files').click());
    byId('gslLibraryImportD4Folder').addEventListener('click',()=>byId('gslD4Folder').click());
    byId('gslLibraryClearSearch').addEventListener('click',()=>{byId('gslLibrarySearch').value='';renderLibrary();byId('gslLibrarySearch').focus();});
    byId('gslLibraryPreviewLight').addEventListener('click',()=>{
      const profile=libraryCatalogRows.get(selectedLibraryProfileId);if(!profile)return;
      selectedCatalogProfile=profile;selectedCatalogLibraryId=profile.id;personalityPreviewProfile=profile;
      setWorkspace('patch');openPersonalityLibrary();drawPersonalityPreview(profile);
      status(`${profile.name} · ${profile.mode} · personality preview. Drag to a SHOWAVE Clip Slot to create a Light.`,'success');
    });
    byId('gslLibraryCreateEffect').addEventListener('click',()=>{setWorkspace('fx');status('Select fixtures, set the waveform, then create an effect.');});
    byId('gslLibraryInspect').addEventListener('click',()=>{
      if(libraryTab==='effects'){
        const asset=libraryAssets.get(selectedLibraryAssetKey);if(!asset)return;
        selectedEffectId=asset.id;renderFx();setWorkspace('fx');
      }else if(libraryTab==='fixtures')setWorkspace('mapper');
      else if(libraryTab==='groups')setWorkspace('programmer');
      else if(libraryTab==='cues')setWorkspace('cues');
      else if(libraryTab==='sources')setWorkspace('live');
    });
    byId('gslLibraryTabs').addEventListener('click',event=>{
      const button=event.target.closest('[data-library-tab]');if(!button)return;
      libraryTab=button.dataset.libraryTab;renderLibrary();
    });
    byId('gslLibraryTabs').addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const tabs=$$('[data-library-tab]',byId('gslLibraryTabs')),current=tabs.indexOf(event.target.closest('[data-library-tab]'));
      if(current<0)return;event.preventDefault();
      const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:
        (current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      libraryTab=tabs[index].dataset.libraryTab;renderLibrary();tabs[index].focus();
    });
    byId('gslLibrarySearch').addEventListener('input',()=>{
      clearTimeout(librarySearchTimer);librarySearchTimer=setTimeout(renderLibrary,100);
    });
    byId('gslLibraryRows').addEventListener('click',event=>{
      const action=event.target.closest('[data-library-action]');
      if(action){setWorkspace(action.dataset.libraryAction==='network'?'network':'mapper');return;}
      const profileRow=event.target.closest('[data-library-profile-id]');
      if(profileRow){
        selectedLibraryProfileId=profileRow.dataset.libraryProfileId;
        $$('.gsl-library-row[data-library-profile-id]',byId('gslLibraryRows')).forEach(row=>row.setAttribute('aria-selected',String(row===profileRow)));
        const profile=libraryCatalogRows.get(selectedLibraryProfileId);
        byId('gslLibraryPreviewLight').disabled=!profile;
        status(`${profile&&profile.name||'Light'} selected. Drag it to a SHOWAVE Clip Slot.`,'success');return;
      }
      const fixtureRow=event.target.closest('[data-library-fixture-id]');
      if(fixtureRow){selectFixture(fixtureRow.dataset.libraryFixtureId,event);status('Patched fixture selected inside GSL5.','success');return;}
      const groupRow=event.target.closest('[data-library-group-id]');
      if(groupRow){const group=show.groups.find(item=>item.id===groupRow.dataset.libraryGroupId);if(group){Engine.selectFixtures(show,group.id);renderAll();status(`${group.name} selected inside GSL5.`,'success');}return;}
      const assetRow=event.target.closest('[data-library-asset-key]');
      if(assetRow){const asset=libraryAssets.get(assetRow.dataset.libraryAssetKey);if(asset){
        selectedLibraryAssetKey=assetRow.dataset.libraryAssetKey;
        $$('.gsl-library-row[data-library-asset-key]',byId('gslLibraryRows')).forEach(row=>row.setAttribute('aria-selected',String(row===assetRow)));
        if(libraryTab==='effects')byId('gslLibraryInspect').disabled=false;
        status(`${asset.name}: drag it onto an existing SHOWAVE Lighting Clip${libraryTab==='effects'?' or edit the selected effect':''}.`,'success');
      }}
    });
    byId('gslLibraryRows').addEventListener('dragstart',event=>{
      const profileRow=event.target.closest('[data-library-profile-id]');
      const assetRow=event.target.closest('[data-library-asset-key]');
      let payload=null,name='Lighting asset';
      if(profileRow){const profile=libraryCatalogRows.get(profileRow.dataset.libraryProfileId);payload=showaveProfileTemplatePayload(profile);name=profile&&profile.name||'Light';}
      else if(assetRow){const asset=libraryAssets.get(assetRow.dataset.libraryAssetKey);payload=showaveLightingDragPayload({type:'asset',asset});name=asset&&asset.name||name;}
      if(!payload||!event.dataTransfer){event.preventDefault();return;}
      event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('text/plain',JSON.stringify(payload));
      status(`${name} · drag to a SHOWAVE Lighting Clip.`,'success');
    });
    $$('.gsl-workspace-nav [data-workspace]').forEach(button => button.addEventListener('click',()=>setWorkspace(button.dataset.workspace)));
    $$('.gsl-menus .menu-top').forEach(button => button.addEventListener('click',event=>{event.stopPropagation();openMenu(button);}));
    $$('.gsl-menu').forEach(menu=>menu.addEventListener('click',event=>{const item=event.target.closest('[data-action]');if(item)menuAction(item.dataset.action);}));
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('.gsl-menu')&&!event.target.closest('.gsl-menus'))closeMenus();});
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){hideDialogs();closeMenus();clearComposerDrag();return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();saveFile();}
      if(event.key==='Enter'&&event.target===document.body)goSequence(1);
    });
    global.addEventListener('pagehide',()=>{if(saveTimer)saveNow('GSL5 page close');});
    global.addEventListener('resize',()=>{if(workspace==='fx')drawFx();});
    global.addEventListener('openlive:appearancechange',()=>{if(workspace==='fx')requestAnimationFrame(drawFx);});

    byId('gslFixtureSearch').addEventListener('input',renderSidebar);
    byId('gslFixtureList').addEventListener('click',event=>{const item=event.target.closest('[data-fixture-id]');if(item)selectFixture(item.dataset.fixtureId,event);});
    byId('gslGroupList').addEventListener('click',event=>{const item=event.target.closest('[data-group-id]');if(item){Engine.selectFixtures(show,item.dataset.groupId);renderAll();}});
    byId('gslLiveGroups').addEventListener('click',event=>{const item=event.target.closest('[data-group-id]');if(item){Engine.selectFixtures(show,item.dataset.groupId);renderAll();}});
    byId('gslAddGroup').addEventListener('click',addGroup);
    byId('gslMapperFixtures').addEventListener('click',()=>runMapperAction('fixtures'));
    byId('gslMapperPatch').addEventListener('click',()=>runMapperAction('patch'));
    byId('gslMapperMap').addEventListener('click',()=>runMapperAction('map'));
    byId('gslMapperRoute').addEventListener('click',()=>runMapperAction('network'));
    byId('gslMapperShowave').addEventListener('click',()=>runMapperAction('showave'));
    byId('gslMapperEmptyAdd').addEventListener('click',()=>runMapperAction('fixtures'));
    byId('gslMapperAdvancedOutput').addEventListener('click',()=>runMapperAction('output'));
    byId('gslMapperCueLauncher').addEventListener('click',()=>runMapperAction('composer'));
    byId('gslMapperNetwork').addEventListener('click',()=>runMapperAction('network'));
    byId('gslMapperAutoLayout').addEventListener('click',autoLayoutMapper);
    byId('gslMapperCenter').addEventListener('click',centerMappedSelection);
    byId('gslMapperStage').addEventListener('pointerdown',startMapperDrag);
    byId('gslMapperStage').addEventListener('click',event=>{const node=event.target.closest('[data-map-fixture-id]');if(node)selectFixture(node.dataset.mapFixtureId,event);});
    document.addEventListener('pointermove',moveMapperDrag);
    document.addEventListener('pointerup',finishMapperDrag);
    document.addEventListener('pointercancel',finishMapperDrag);
    byId('gslMapperChecks').addEventListener('click',event=>{const action=event.target.closest('[data-map-action]');if(action)runMapperAction(action.dataset.mapAction);});
    byId('gslMapperInspector').addEventListener('change',event=>{
      const input=event.target.closest('[data-map-field]'),fixture=selectedFixtures()[0];if(!input||!fixture)return;
      if(!requireDisarmed('editing the stage map')){renderMapperInspector();return;}
      const ranges={x:[-10,10],y:[-6,6],z:[-20,20]},field=input.dataset.mapField,range=ranges[field];
      if(!range)return;remember();fixture.position[field]=clamp(input.value,range[0],range[1]);scheduleSave('Edit fixture stage position');renderAll();
    });
    $$('.gsl-pool-panel [data-store-palette]').forEach(button=>button.addEventListener('click',()=>storePalette(button.dataset.storePalette)));
    ['gslIntensityPalettes','gslColorPalettes','gslPositionPalettes','gslBeamPalettes'].forEach(id=>byId(id).addEventListener('click',event=>{const item=event.target.closest('[data-palette-id]');if(item)applyPalette(item.dataset.paletteId);}));
    byId('gslEffectPool').addEventListener('click',event=>{const item=event.target.closest('[data-effect-id]');if(item){selectedEffectId=item.dataset.effectId;setWorkspace('fx');renderAll();}});
    $$('[data-open-workspace]').forEach(button=>button.addEventListener('click',()=>setWorkspace(button.dataset.openWorkspace)));

    $$('.gsl-library-tabs [data-library-filter]').forEach(button=>button.addEventListener('click',()=>{
      composerLibraryFilter=button.dataset.libraryFilter;renderLive();
    }));
    byId('gslComposerLibrary').addEventListener('click',event=>{
      const card=event.target.closest('[data-asset-key]');if(!card)return;
      composerPendingAssetKey=composerPendingAssetKey===card.dataset.assetKey?'':card.dataset.assetKey;
      const asset=composerAssets.get(composerPendingAssetKey);
      status(asset?`${asset.name} loaded. Click an empty lighting clip or drag it into the grid.`:'Lighting source selection cleared.');
      renderLive();
    });
    byId('gslComposerLibrary').addEventListener('dragstart',event=>{
      const card=event.target.closest('[data-asset-key]'),asset=card&&composerAssets.get(card.dataset.assetKey);if(!asset)return;
      writeComposerDrag(event,{type:'asset',asset:clone(asset)},COMPOSER_ASSET_MIME);
    });
    byId('gslComposerGrid').addEventListener('click',event=>{
      const mute=event.target.closest('[data-layer-mute]');
      if(mute){const layer=composerLayer(mute.dataset.layerMute);if(layer)mutate('Mute Lighting Composer layer',()=>{layer.muted=!layer.muted;if(layer.muted)Engine.releaseComposerLayer(show,layer.id);});return;}
      const solo=event.target.closest('[data-layer-solo]');
      if(solo){const layer=composerLayer(solo.dataset.layerSolo);if(layer)mutate('Solo Lighting Composer layer',()=>{layer.solo=!layer.solo;});return;}
      const remove=event.target.closest('[data-layer-remove]');if(remove){removeComposerLayer(remove.dataset.layerRemove);return;}
      const go=event.target.closest('[data-trigger-column]');if(go){triggerComposerColumn(go.dataset.triggerColumn);return;}
      const select=event.target.closest('[data-select-column]');if(select){selectedComposerColumnId=select.dataset.selectColumn;selectedComposerClipId='';renderLive();return;}
      const clip=event.target.closest('[data-clip-id]');if(clip){triggerComposerClip(clip.dataset.clipId);return;}
      const empty=event.target.closest('[data-empty-slot]');if(empty){
        const slot=empty.closest('.gsl-clip-slot'),asset=composerAssets.get(composerPendingAssetKey);
        selectedComposerLayerId=slot.dataset.layerId;selectedComposerColumnId=slot.dataset.columnId;
        if(asset)createComposerClipFromAsset(asset,slot.dataset.layerId,slot.dataset.columnId);
        else{selectedComposerClipId='';renderLive();status('Empty lighting clip selected. Choose a source, look, cue or effect from the library.');}
      }
    });
    byId('gslComposerGrid').addEventListener('dblclick',event=>{
      const cue=event.target.closest('[data-select-column]');
      if(cue&&requireDisarmed('renaming a Lighting Composer cue')){const column=composerColumn(cue.dataset.selectColumn),name=column&&prompt('Lighting cue name',column.name);if(name)mutate('Rename Lighting Composer cue',()=>{column.name=name.trim()||column.name;});return;}
      const control=event.target.closest('[data-layer-target]');
      if(control&&requireDisarmed('renaming a Lighting Composer layer')){const layer=composerLayer(control.dataset.layerTarget),name=layer&&prompt('Lighting layer name',layer.name);if(name)mutate('Rename Lighting Composer layer',()=>{layer.name=name.trim()||layer.name;});}
    });
    byId('gslComposerGrid').addEventListener('input',event=>{
      const input=event.target.closest('[data-layer-level]'),layer=input&&composerLayer(input.dataset.layerLevel);if(!layer)return;
      layer.level=Number(input.value)/100;const output=input.nextElementSibling;if(output)output.textContent=input.value;dirty=true;renderSaveState();
    });
    byId('gslComposerGrid').addEventListener('change',event=>{if(event.target.closest('[data-layer-level]'))scheduleSave('Set Lighting Composer layer level');});
    byId('gslComposerGrid').addEventListener('keydown',event=>{
      const button=event.target.closest('.gsl-clip-slot button'),slot=button&&button.closest('.gsl-clip-slot');if(!slot)return;
      const row=Number(slot.dataset.rowIndex),column=Number(slot.dataset.columnIndex);
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='ArrowUp'||event.key==='ArrowDown'){
        event.preventDefault();focusComposerCell(row+(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0),column+(event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0));return;
      }
      const clip=button.dataset.clipId;
      if((event.key==='Delete'||event.key==='Backspace')&&clip){event.preventDefault();removeComposerClip(clip);return;}
      if(event.key===' '&&clip){event.preventDefault();selectedComposerClipId=clip;selectedComposerLayerId=slot.dataset.layerId;renderLive();return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'&&clip){event.preventDefault();composerClipboardClipId=clip;status('Lighting clip copied. Focus an empty slot and press Ctrl+V.');return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'&&composerClipboardClipId&&!composerSlot(slot.dataset.layerId,slot.dataset.columnId)){
        event.preventDefault();moveComposerClip(composerClipboardClipId,slot.dataset.layerId,slot.dataset.columnId,true);
      }
    });
    byId('gslComposerGrid').addEventListener('dragstart',event=>{
      const clip=event.target.closest('[data-clip-id]');
      if(clip){const item=show.composer.clips.find(candidate=>candidate.id===clip.dataset.clipId);if(item)writeComposerDrag(event,{type:'clip',clipId:item.id,layerId:item.layerId,columnId:item.columnId},COMPOSER_CLIP_MIME);return;}
      const column=event.target.closest('.gsl-cue-header[data-column-id]');if(column)writeComposerDrag(event,{type:'column',columnId:column.dataset.columnId},COMPOSER_COLUMN_MIME);
    });
    byId('gslComposerGrid').addEventListener('dragover',event=>{
      if(!composerDrag)return;
      const slot=event.target.closest('.gsl-clip-slot');
      if(slot&&(composerDrag.type==='asset'||composerDrag.type==='clip')){
        const existing=composerSlot(slot.dataset.layerId,slot.dataset.columnId);
        const effectAsset=composerDrag.type==='asset'&&['effect','effect-preset'].includes(composerDrag.asset.kind);
        const valid=!bridgeState.outputting&&(composerDrag.type==='clip'||!existing||effectAsset);
        event.preventDefault();event.dataTransfer.dropEffect=composerDrag.type==='clip'&&(event.ctrlKey||event.metaKey||event.altKey)?'copy':composerDrag.type==='clip'?'move':'copy';
        slot.classList.toggle('drop',valid);slot.classList.toggle('drop-invalid',!valid);return;
      }
      const layerTarget=event.target.closest('[data-layer-target]');
      if(layerTarget&&composerDrag.type==='asset'&&['group','fixture'].includes(composerDrag.asset.kind)){
        event.preventDefault();if(!bridgeState.outputting)$('.gsl-layer-target',layerTarget)?.classList.add('drop');return;
      }
      const column=event.target.closest('.gsl-cue-header[data-column-id]');
      if(column&&composerDrag.type==='column'&&column.dataset.columnId!==composerDrag.columnId){event.preventDefault();column.classList.add('drag-over');}
    });
    byId('gslComposerGrid').addEventListener('dragleave',event=>{
      const slot=event.target.closest('.gsl-clip-slot');if(slot&&!slot.contains(event.relatedTarget))slot.classList.remove('drop','drop-invalid');
      const column=event.target.closest('.gsl-cue-header');if(column&&!column.contains(event.relatedTarget))column.classList.remove('drag-over');
      const target=event.target.closest('[data-layer-target]');if(target&&!target.contains(event.relatedTarget))$('.gsl-layer-target',target)?.classList.remove('drop');
    });
    byId('gslComposerGrid').addEventListener('drop',event=>{
      if(!composerDrag)return;event.preventDefault();const payload=composerDrag;
      const slot=event.target.closest('.gsl-clip-slot'),layerTarget=event.target.closest('[data-layer-target]'),column=event.target.closest('.gsl-cue-header[data-column-id]');
      clearComposerDrag();
      if(slot&&payload.type==='asset'){createComposerClipFromAsset(payload.asset,slot.dataset.layerId,slot.dataset.columnId);return;}
      if(slot&&payload.type==='clip'){moveComposerClip(payload.clipId,slot.dataset.layerId,slot.dataset.columnId,event.ctrlKey||event.metaKey||event.altKey);return;}
      if(layerTarget&&payload.type==='asset'){assignComposerLayerTarget(payload.asset,layerTarget.dataset.layerTarget);return;}
      if(column&&payload.type==='column')reorderComposerColumn(payload.columnId,column.dataset.columnId);
    });
    document.addEventListener('dragend',clearComposerDrag);global.addEventListener('blur',clearComposerDrag);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)clearComposerDrag();});
    byId('gslComposerAddLayer').addEventListener('click',addComposerLayer);
    byId('gslComposerAddCue').addEventListener('click',addComposerColumn);
    byId('gslComposerPrev').addEventListener('click',()=>stepComposer(-1));
    byId('gslComposerNext').addEventListener('click',()=>stepComposer(1));
    byId('gslComposerStop').addEventListener('click',stopComposer);

    byId('gslUndo').addEventListener('click',undo);byId('gslRedo').addEventListener('click',redo);
    byId('gslLocate').addEventListener('click',()=>{
      /* This hardcoded dimmer=1 and ignored the per-channel locate values the
         engine already consumes for Sources, so a moving head "located"
         without moving, opening its shutter or going open white. It now
         applies each personality's own Locate column, and names the fixtures
         whose personality declares none instead of pretending they located. */
      const fixtures=selectedFixtures();
      if(!fixtures.length)return status('Select fixtures before using Locate.','warning');
      const perFixture={};let located=0,fallback=0,bare=0;
      fixtures.forEach(fixture=>{
        const profile=profileById(fixture.profileId),channels=profile&&profile.channels||[],values={};
        channels.forEach(channel=>{if(channel.locate!=null)values[channel.attribute]=channel.locate;});
        if(Object.keys(values).length)located++;
        else{
          const intensity=channels.find(channel=>['dimmer','intensity'].includes(channel.semantic||channel.attribute));
          if(intensity){values[intensity.attribute]=1;fallback++;}else bare++;
        }
        if(Object.keys(values).length)perFixture[fixture.id]=values;
      });
      if(!Object.keys(perFixture).length)
        return status(`Locate did nothing: ${fixtures.length===1?'this personality declares':'none of these personalities declare'} a Locate value or an intensity channel.`,'warning');
      locate=true;
      mutate('Locate fixtures',()=>Engine.setProgrammerValue(show,fixtures.map(fixture=>fixture.id),perFixture));
      const notes=[];
      if(located)notes.push(`${located} from personality Locate values`);
      if(fallback)notes.push(`${fallback} to intensity only, having no Locate column`);
      if(bare)notes.push(`${bare} skipped with neither`);
      status(`Locate · ${notes.join(' · ')}`,fallback||bare?'warning':'success');
    });
    byId('gslHighlight').addEventListener('click',()=>{
      /* HIGHLIGHT was a module-local boolean read in exactly one place - to
         set its own aria-pressed. It latched as engaged and changed nothing.
         It now drives the engine's output-time highlight pass, and refuses to
         latch when the selected personalities carry no highlight values for it
         to apply. */
      const fixtures=selectedFixtures();
      if(!fixtures.length)return status('Select fixtures before using Highlight.','warning');
      const capable=fixtures.filter(fixture=>{
        const profile=profileById(fixture.profileId);
        return !!profile&&(profile.channels||[]).some(channel=>channel.highlight!=null);
      });
      if(!capable.length){
        show.programmer.highlight=false;renderHeader();
        return status(`Highlight is unavailable here: ${fixtures.length===1?'this personality declares':'none of the selected personalities declare'} a highlight value on any channel. Imported .d4 and .R20 personalities carry one; most built-in samples do not.`,'warning');
      }
      show.programmer.highlight=!show.programmer.highlight;
      status(show.programmer.highlight
        ?`Highlight on · ${capable.length} of ${fixtures.length} selected fixture${fixtures.length===1?'':'s'} carry highlight values`
        :'Highlight off','success');
      renderHeader();
    });
    byId('gslBlind').addEventListener('click',()=>{show.programmer.blind=!show.programmer.blind;renderAll();});
    byId('gslRecord').addEventListener('click',openRecordDialog);byId('gslUpdate').addEventListener('click',()=>{const cue=selectedOrActiveCue();if(!cue)return status('Select a cue to update.','warning');mutate('Update lighting cue',()=>Engine.storeCue(show,{id:cue.id,name:cue.name,merge:false}));});
    byId('gslClear').addEventListener('click',()=>{locate=false;mutate('Clear programmer',()=>Engine.clearProgrammer(show,{selection:false,keepSelection:true}));});
    byId('gslBlackout').addEventListener('click',toggleBlackout);byId('gslArmOutput').addEventListener('click',armOutput);
    byId('gslGrandMaster').addEventListener('input',event=>{show.master=Number(event.target.value)/100;byId('gslGrandMasterValue').textContent=`${event.target.value}%`;scheduleSave('Grand Master');});
    byId('gslBpm').addEventListener('change',event=>{const bpm=clamp(event.target.value,20,300);show.metadata.bpm=bpm;if(activeSequence())activeSequence().bpm=bpm;scheduleSave('Set lighting BPM');renderFxRate();});
    byId('gslTapTempo').addEventListener('click',()=>{const now=performance.now();tapTimes=tapTimes.filter(at=>now-at<2500);tapTimes.push(now);if(tapTimes.length>1){const intervals=tapTimes.slice(1).map((at,index)=>at-tapTimes[index]),bpm=Math.round(60000/(intervals.reduce((sum,value)=>sum+value,0)/intervals.length));byId('gslBpm').value=String(clamp(bpm,20,300));byId('gslBpm').dispatchEvent(new Event('change'));}});

    $$('.gsl-feature-tabs button').forEach(button=>button.addEventListener('click',()=>{feature=button.dataset.feature;renderProgrammer();}));
    byId('gslEncoders').addEventListener('input',event=>{const encoder=event.target.closest('[data-attribute]');if(!encoder||event.target.type!=='range')return;const value=Number(event.target.value)/100;Engine.setProgrammerValue(show,show.programmer.selectedFixtureIds,encoder.dataset.attribute,value);$('output',encoder).textContent=describeSelectionValue(encoder.dataset.attribute,value);$('.encoder-wheel',encoder).style.setProperty('--value',`${Math.round(value*300)}deg`);dirty=true;renderSaveState();});
    byId('gslEncoders').addEventListener('change',()=>scheduleSave('Program lighting values'));
    byId('gslEncoders').addEventListener('click',event=>{
      const key=event.target.closest('[data-band]');if(!key)return;
      const holder=key.closest('[data-attribute]'),attribute=holder&&holder.dataset.attribute,channel=attribute&&selectionChannel(attribute);
      if(!channel)return;
      const fraction=Engine.functionFraction(channel,key.dataset.band,0.5);
      if(fraction==null)return status(`${key.dataset.band} is not a band on this personality.`,'warning');
      Engine.setProgrammerValue(show,show.programmer.selectedFixtureIds,attribute,fraction);
      dirty=true;renderSaveState();renderProgrammer();scheduleSave('Program lighting values');
      status(`${attribute} · ${Engine.describeChannelValue(channel,fraction).text}`);
    });
    byId('gslEncoders').addEventListener('change',event=>{
      const hz=event.target.closest('[data-band-hz]');if(!hz)return;
      const holder=hz.closest('[data-attribute]'),attribute=holder&&holder.dataset.attribute,channel=attribute&&selectionChannel(attribute);
      if(!channel)return;
      const fraction=Engine.strobeFraction(channel,Number(hz.value));
      if(fraction==null)return status('This personality states no strobe rate in Hz; use its named bands instead.','warning');
      Engine.setProgrammerValue(show,show.programmer.selectedFixtureIds,attribute,fraction);
      dirty=true;renderSaveState();renderProgrammer();
      status(`${attribute} · ${Engine.describeChannelValue(channel,fraction).text}`);
    });
    byId('gslOddEven').addEventListener('click',()=>{
      /* This hardcoded pattern:'odd', so EVEN - printed on the key - was
         unreachable, and each press re-halved the surviving selection until
         one fixture was left. It now cycles odd -> even -> all against the
         selection that was live when the cycle began. */
      const current=show.programmer.selectedFixtureIds.slice();
      if(!current.length&&!oddEvenBase)return status('Select fixtures before using Odd / Even.','warning');
      if(!oddEvenBase||!current.length||!current.every(id=>oddEvenBase.includes(id))){oddEvenBase=current.slice();oddEvenPhase=0;}
      oddEvenPhase=(oddEvenPhase+1)%3;
      const pattern=oddEvenPhase===1?'odd':oddEvenPhase===2?'even':'';
      const selected=Engine.selectFixtures(show,{fixtureIds:oddEvenBase.slice(),pattern});
      const key=byId('gslOddEven');
      key.textContent=pattern==='odd'?'ODD':pattern==='even'?'EVEN':'ODD / EVEN';
      key.setAttribute('aria-pressed',String(!!pattern));
      status(`Selection · ${pattern?pattern.toUpperCase():'all'} · ${selected.length} of ${oddEvenBase.length} fixtures`);
      renderAll();
    });
    byId('gslReverseSelection').addEventListener('click',()=>{show.programmer.selectedFixtureIds.reverse();renderAll();});
    byId('gslClearFeature').addEventListener('click',()=>mutate(`Clear ${feature}`,()=>Engine.clearProgrammer(show,{attributes:FEATURES[feature],keepSelection:true,selection:false})));
    byId('gslFan').addEventListener('click',()=>status('Fan uses the group selection order: apply Position, then create an FX with Spread.'));

    byId('gslPatchAdd').addEventListener('click',addPatch);byId('gslPatchRemove').addEventListener('click',removePatch);byId('gslOpenFixtureEditor').addEventListener('click',()=>openTool('fixture-editor.html'));
    byId('gslOpenPersonalityLibrary').addEventListener('click',openPersonalityLibrary);
    byId('gslOpenPersonalityBuilder').addEventListener('click',()=>openPersonalityBuilder());
    byId('gslClosePersonalityLibrary').addEventListener('click',closePersonalityLibrary);
    byId('gslImportD4Files').addEventListener('click',()=>byId('gslD4Files').click());
    byId('gslImportD4Folder').addEventListener('click',()=>byId('gslD4Folder').click());
    byId('gslD4Files').addEventListener('change',event=>{importPersonalityFiles(event.target.files);event.target.value='';});
    byId('gslD4Folder').addEventListener('change',event=>{importPersonalityFiles(event.target.files);event.target.value='';});
    byId('gslPersonalitySearch').addEventListener('input',()=>{clearTimeout(personalitySearchTimer);personalitySearchTimer=setTimeout(renderPersonalityLibrary,120);});
    byId('gslPersonalityResults').addEventListener('click',event=>{const row=event.target.closest('[data-personality-id]');if(row)previewCatalogProfile(row.dataset.personalityId);});
    byId('gslPersonalityResults').addEventListener('dragstart',event=>{
      const row=event.target.closest('[data-personality-id]');if(!row||!event.dataTransfer)return;
      const profile=personalityCatalogRows.get(row.dataset.personalityId),payload=showaveProfileTemplatePayload(profile);
      if(!payload){event.preventDefault();return;}
      event.dataTransfer.effectAllowed='copy';
      event.dataTransfer.setData('text/plain',JSON.stringify(payload));
      personalityStatus(`${profile.name} · drag to a SHOWAVE Clip Slot`,'success');
    });
    byId('gslClearD4Library').addEventListener('click',async()=>{if(!Personalities||!confirm('Clear imported D4 profiles? Built-in samples, locally authored personalities, and profiles already embedded in this show stay available.'))return;await (Personalities.clearImports?Personalities.clearImports():Personalities.clear());if(selectedCatalogProfile&&selectedCatalogProfile.source&&!selectedCatalogProfile.source.sample&&!selectedCatalogProfile.source.authored){selectedCatalogProfile=null;selectedCatalogLibraryId='';}personalityStatus('Imported profiles cleared; samples and authored personalities remain');renderPersonalityLibrary();});
    byId('gslNewPersonality').addEventListener('click',()=>openPersonalityBuilder());
    byId('gslEditPersonality').addEventListener('click',()=>{if(selectedCatalogProfile)openPersonalityBuilder(selectedCatalogLibraryId||selectedCatalogProfile.id);});
    byId('gslBuilderBack').addEventListener('click',()=>closePersonalityBuilder(false));
    byId('gslBuilderCancel').addEventListener('click',()=>closePersonalityBuilder(false));
    byId('gslBuilderAddChannel').addEventListener('click',addBuilderChannel);
    byId('gslBuilderFitFootprint').addEventListener('click',()=>{if(!builderDraft)return;fitBuilderFootprint();setBuilderDirty('Footprint fitted');renderPersonalityBuilder();});
    byId('gslBuilderGenerateCells').addEventListener('click',generateBuilderCells);
    byId('gslBuilderDelete').addEventListener('click',deleteBuilderProfile);
    byId('gslBuilderExport').addEventListener('click',exportBuilderProfile);
    byId('gslBuilderPatch').addEventListener('click',()=>saveBuilder(true));
    byId('gslPersonalityBuilder').addEventListener('submit',event=>{event.preventDefault();saveBuilder(false);});
    byId('gslPersonalityBuilder').addEventListener('input',event=>{
      if(handleBuilderFunctionInput(event))return;
      if(handleBuilderChannelInput(event))return;
      const fields={gslBuilderManufacturer:'manufacturer',gslBuilderName:'name',gslBuilderMode:'mode',gslBuilderCategory:'category',
        gslBuilderFootprint:'footprint',gslBuilderSafety:'safety',gslBuilderDescription:'description'};
      const field=fields[event.target.id];if(!field||!builderDraft)return;
      builderDraft[field]=field==='footprint'?Number(event.target.value):event.target.value;setBuilderDirty();updateBuilderAssessment();
    });
    byId('gslPersonalityBuilder').addEventListener('change',event=>{
      if(event.target.matches('[data-builder-function-field]')){handleBuilderFunctionInput(event);return;}
      if(event.target.matches('[data-builder-channel-field]')){handleBuilderChannelInput(event);return;}
      const fields={gslBuilderManufacturer:'manufacturer',gslBuilderName:'name',gslBuilderMode:'mode',gslBuilderCategory:'category',
        gslBuilderFootprint:'footprint',gslBuilderSafety:'safety',gslBuilderDescription:'description'};
      const field=fields[event.target.id];if(field&&builderDraft){builderDraft[field]=field==='footprint'?Number(event.target.value):event.target.value;setBuilderDirty();updateBuilderAssessment();}
    });
    byId('gslBuilderChannelBody').addEventListener('click',event=>{
      const functionAction=event.target.closest('[data-builder-function-action]');
      if(functionAction){
        const channelRow=functionAction.closest('[data-builder-index]'),channelIndex=channelRow&&Number(channelRow.dataset.builderIndex);
        if(!Number.isInteger(channelIndex))return;
        if(functionAction.dataset.builderFunctionAction==='add')addBuilderFunction(channelIndex);
        else if(functionAction.dataset.builderFunctionAction==='delete'){
          const functionRow=functionAction.closest('[data-builder-function-index]');
          if(functionRow)deleteBuilderFunction(channelIndex,Number(functionRow.dataset.builderFunctionIndex));
        }
        return;
      }
      const action=event.target.closest('[data-builder-row-action]'),row=action&&action.closest('[data-builder-index]');if(!action||!row||!builderDraft)return;
      const index=Number(row.dataset.builderIndex),kind=action.dataset.builderRowAction;
      if(kind==='functions'){builderFunctionChannelIndex=index;renderBuilderChannels();renderBuilderStatePreview();return;}
      if(kind==='delete'){builderDraft.channels.splice(index,1);if(builderFunctionChannelIndex>index)builderFunctionChannelIndex--;else if(builderFunctionChannelIndex===index)builderFunctionChannelIndex=Math.min(index,builderDraft.channels.length-1);}
      else if(kind==='up'&&index>0){[builderDraft.channels[index-1],builderDraft.channels[index]]=[builderDraft.channels[index],builderDraft.channels[index-1]];if(builderFunctionChannelIndex===index)builderFunctionChannelIndex=index-1;else if(builderFunctionChannelIndex===index-1)builderFunctionChannelIndex=index;}
      else if(kind==='down'&&index<builderDraft.channels.length-1){[builderDraft.channels[index+1],builderDraft.channels[index]]=[builderDraft.channels[index],builderDraft.channels[index+1]];if(builderFunctionChannelIndex===index)builderFunctionChannelIndex=index+1;else if(builderFunctionChannelIndex===index+1)builderFunctionChannelIndex=index;}
      setBuilderDirty(kind==='delete'?'Channel removed':'Channel order changed');renderPersonalityBuilder();
    });
    byId('gslPersonalityBuilder').addEventListener('click',event=>{const preset=event.target.closest('[data-builder-preset]');if(preset)applyBuilderPreset(preset.dataset.builderPreset);});
    byId('gslPersonalityBuilder').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePersonalityBuilder(false);}});
    byId('gslPatchBody').addEventListener('change',event=>{const row=event.target.closest('[data-fixture-id]'),fixture=row&&fixtureById(row.dataset.fixtureId);if(!fixture)return;if(event.target.classList.contains('gsl-patch-checkbox')){Engine.selectFixtures(show,{fixtureIds:[fixture.id],mode:event.target.checked?'add':'remove'});renderAll();return;}const field=event.target.dataset.patchField;if(!field)return;if(!requireDisarmed('editing the fixture patch')){renderPatch();return;}remember();if(field==='name')fixture.name=event.target.value.trim()||fixture.name;else if(field==='x'||field==='y')fixture.position[field]=Number(event.target.value)||0;else fixture[field]=Math.round(clamp(event.target.value,1,field==='address'?512:63999));scheduleSave('Edit fixture patch');renderAll();});

    byId('gslAddSequence').addEventListener('click',addSequence);byId('gslSequenceList').addEventListener('click',event=>{const item=event.target.closest('[data-sequence-id]');if(item){activeSequenceId=item.dataset.sequenceId;renderAll();}});
    byId('gslCueBody').addEventListener('click',event=>{const row=event.target.closest('[data-cue-id]');if(row){selectedCueId=row.dataset.cueId;renderCues();}});
    byId('gslCueRecord').addEventListener('click',openRecordDialog);byId('gslCueGo').addEventListener('click',()=>goSequence(1));byId('gslCueBack').addEventListener('click',()=>goSequence(-1));byId('gslCueRelease').addEventListener('click',releaseSequence);byId('gslCueTimeline').addEventListener('click',addCueToTimeline);

    byId('gslAddEffect').addEventListener('click',addEffect);byId('gslFxApply').addEventListener('click',applyEffectForm);
    byId('gslFxStart').addEventListener('click',startSelectedEffect);byId('gslFxStop').addEventListener('click',stopSelectedEffect);
    byId('gslFxDuplicate').addEventListener('click',duplicateSelectedEffect);byId('gslFxDelete').addEventListener('click',deleteSelectedEffect);
    byId('gslFxList').addEventListener('click',event=>{const item=event.target.closest('[data-effect-id]');if(item){selectedEffectId=item.dataset.effectId;renderFx();}});byId('gslImportChaser').addEventListener('click',importChaser);
    ['gslFxSize','gslFxSpeed','gslFxPhase','gslFxSpread'].forEach(id=>byId(id).addEventListener('input',event=>{const output=event.target.nextElementSibling;if(id==='gslFxSize')output.textContent=`${event.target.value}%`;if(id==='gslFxSpeed')renderFxRate();if(id==='gslFxPhase'||id==='gslFxSpread')output.textContent=`${event.target.value}°`;drawFx();}));
    byId('gslFxWave').addEventListener('change',drawFx);
    byId('gslFxDirection').addEventListener('change',drawFx);
    byId('gslFxRateSource').addEventListener('change',renderFxRate);

    byId('gslPlaybackPrev').addEventListener('click',()=>{playbackPage=Math.max(0,playbackPage-1);renderPlaybacks();});byId('gslPlaybackNext').addEventListener('click',()=>{playbackPage++;renderPlaybacks();});
    byId('gslPlaybackBank').addEventListener('input',event=>{const node=event.target.closest('[data-playback-id]'),playback=node&&playbackById(node.dataset.playbackId);if(!playback||event.target.type!=='range')return;Engine.setPlaybackLevel(show,playback.id,Number(event.target.value)/100);$('output',node).textContent=event.target.value;selectedPlaybackId=playback.id;});
    byId('gslPlaybackBank').addEventListener('pointerdown',event=>{if(event.target.classList.contains('flash')){event.preventDefault();startFlash(event.target);}});
    document.addEventListener('pointerup',endFlash);document.addEventListener('pointercancel',endFlash);
    byId('gslPlaybackBank').addEventListener('keydown',event=>{if(event.target.classList.contains('flash')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();startFlash(event.target);}});
    byId('gslPlaybackBank').addEventListener('keyup',event=>{if(event.target.classList.contains('flash')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();endFlash();}});
    byId('gslPlaybackBank').addEventListener('click',event=>{const node=event.target.closest('.gsl-playback');if(!node)return;if(event.target.classList.contains('assign-playback')){const sequence=activeSequence();if(sequence){const playback=mutate('Assign lighting playback',()=>Engine.assignPlayback(show,{name:sequence.name,sequenceId:sequence.id,level:0}));if(playback)selectedPlaybackId=playback.id;}return;}const playback=playbackById(node.dataset.playbackId);if(!playback)return;selectedPlaybackId=playback.id;if(event.target.classList.contains('go'))Engine.go(show,playback.id,Date.now());else if(event.target.classList.contains('select-playback')&&show.runtime.playbacks[playback.id]?.active)Engine.release(show,playback.id);renderAll();});
    byId('gslMasterGo').addEventListener('click',()=>{const playback=activePlayback();if(playback){Engine.go(show,playback.id,Date.now());renderAll();}});byId('gslMasterBack').addEventListener('click',()=>{const playback=activePlayback();if(playback){Engine.back(show,playback.id,Date.now());renderAll();}});byId('gslMasterPause').textContent='RELEASE';byId('gslMasterPause').addEventListener('click',()=>{const playback=activePlayback();if(playback){Engine.release(show,playback.id);renderAll();}});

    byId('gslProtocol').addEventListener('change',renderNetwork);byId('gslDestinationMode').addEventListener('change',renderNetwork);byId('gslDiscoverNodes').addEventListener('click',()=>{if(!Bridge)return;status('Polling Art-Net network…');Bridge.discover({adapterIp:byId('gslAdapter').value}).then(rows=>{status(`Discovered ${rows.length} Art-Net node${rows.length===1?'':'s'}.`,'success');renderNetwork();}).catch(error=>status(error.message,'error'));});
    byId('gslNodeList').addEventListener('click',event=>{const button=event.target.closest('[data-use-node]');if(!button)return;const node=bridgeState.nodes.find(item=>(item.id||`${item.bindIp||item.ip}:${item.bindIndex||1}`)===button.dataset.useNode);if(!node)return;selectedNodeId=button.dataset.useNode;byId('gslDestinationMode').value='manual_unicast';byId('gslTargetIp').value=node.bindIp||node.ip||'';renderNetwork();});

    byId('gslRecordDialog').addEventListener('submit',event=>{event.preventDefault();recordCueFromDialog();});byId('gslArmDialog').addEventListener('submit',event=>{event.preventDefault();confirmArm();});$$('[data-close-dialog]').forEach(button=>button.addEventListener('click',hideDialogs));
    byId('gslLoadFile').addEventListener('change',event=>{handleLoadedFile(event.target.files&&event.target.files[0]);event.target.value='';});
  }

  function loop(now) {
    if (now - lastEvaluation >= 24) {
      lastEvaluation=now;
      try { evaluated=Engine.evaluate(show,show.runtime,Date.now()); } catch (error) { status(`Lighting evaluation stopped: ${error.message}`,'error'); }
      if (Bridge && bridgeState.outputting) {
        const output = operatorBlackout ? Object.fromEntries(Object.keys(evaluated.universes || {}).map(universe => [universe,new Array(512).fill(0)])) : evaluated.universes;
        Bridge.sendUniverses(output);
      }
    }
    if (now-lastRuntimePaint>=120) { lastRuntimePaint=now;paintRuntime(); }
    requestAnimationFrame(loop);
  }

  syncFixtureEditorProfiles();
  if (Hub && Hub.subscribe) Hub.subscribe('fixtures.items',()=>{if(syncFixtureEditorProfiles()){scheduleSave('Sync GSL5 Fixture Builder profiles');renderAll();}},{immediate:false});
  if (Bridge) {
    Bridge.subscribe(next=>{bridgeState=next;fillAdapters(next.adapters||[]);renderHeader();if(workspace==='network')renderNetwork();});
    Bridge.onCommand(handleLightingCommand);
    Promise.allSettled([Bridge.adapters(),Bridge.nodes()]).then(()=>renderNetwork());
  }
  if (Personalities && Personalities.subscribe) Personalities.subscribe(()=>{
    if (!byId('gslPersonalityLibrary').hidden) renderPersonalityLibrary();
    if (workspace === 'library') renderLibrary();
  });
  bind(); renderAll(); requestAnimationFrame(loop);
  setInterval(()=>{const clock=byId('gslClock');if(clock)clock.textContent=new Date().toLocaleTimeString([],{hour12:false});},500);

  global.ShowaveGSL5UI = Object.freeze({
    get show(){return show;}, get evaluated(){return evaluated;},
    setWorkspace, render:renderAll, save:saveNow,
    selectCatalogProfile, openPersonalityLibrary, openPersonalityBuilder,
    createShowaveLightingClip, setShowaveLightingClipQuantity, setShowaveLightingClipSourcePreset,
    setShowaveLightingClipLevel, setShowaveLightingClipFade,
    cloneShowaveLightingClip, discardShowaveLightingClip,
    addShowaveLightingClipEffect, updateShowaveLightingClipEffect,
    moveShowaveLightingClipEffect, removeShowaveLightingClipEffect,
    command:handleLightingCommand,
    status:()=>({workspace,activeSequenceId,selectedPlaybackId,bridge:clone(bridgeState)})
  });
})(window);
