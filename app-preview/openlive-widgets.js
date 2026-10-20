/* ===========================================================================
   openlive-widgets.js — saved browser-source assets and their live renderer.

   A browser source is saved once, then added to any landscape scene by id. The
   remote page never runs inside SHOWAVE's origin. The local helper opens it in
   an isolated Chromium page and exposes same-origin PNG frames; this module
   decodes those frames so openlive-studio.js can burn them into the programme
   canvas captured by every output.

   Classic script. Publishes window.OpenLiveWidgets. No libraries.
   =========================================================================== */
window.OpenLiveWidgets = (() => {
  'use strict';

  const STORE = 'showave.studio.widgets.v1';
  const MAX_LIBRARY = 50;
  const MAX_SCENE = 5;
  const VIEWPORT = { width: 1280, height: 720 };
  const listeners = new Set();
  const sessions = new Map();
  // Source-picker leases are independent of the saved Widgets library.
  const sourceAssets = new Map();
  let capabilityState = {
    checked: false, available: null, renderer: 'chromium-cdp', audio: false,
    audioReason: 'Browser-source audio is not routed in this build.'
  };

  const uid = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'widget-' + window.crypto.randomUUID();
    }
    return 'widget-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  };

  function cleanName(value) {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Enter a widget name.');
    return name.slice(0, 80);
  }

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 4096) {
      throw new Error('Enter a website or widget address under 4,096 characters.');
    }
    const invalid = () => new Error('Enter a website address, such as example.com or https://example.com/widget.');
    if (/[\u0000-\u001f\u007f]/.test(raw)) throw invalid();
    if (/^(?:\/(?!\/)|\/\/[/\\]|\.{1,2}\/|\\)/.test(raw)) throw invalid();
    // Accept the addresses people copy from a browser, including a domain with
    // a port. Explicit non-web schemes must never become an HTTPS hostname.
    const hostPort = /^(?:[^\s/:?#@]+|\[[0-9a-f:]+\]):\d+(?:[/?#]|$)/i.test(raw);
    const scheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    if (scheme && !hostPort && !/^https?:/i.test(raw)) {
      throw new Error('Widgets accept direct http or https URLs only.');
    }
    const candidate = /^https?:/i.test(raw) ? raw : raw.startsWith('//') ? 'https:' + raw : 'https://' + raw;
    let parsed;
    try { parsed = new URL(candidate); } catch (e) { throw invalid(); }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error('Widgets accept direct http or https URLs only.');
    }
    if (parsed.username || parsed.password) {
      throw new Error('URL usernames and passwords are not supported.');
    }
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    const privateIpv4 = parts => parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 192 && parts[1] === 168;
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : null;
    const ipv6 = host.startsWith('[') ? host.slice(1, -1) : '';
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ipv6);
    const mappedIpv4 = mapped ? [parseInt(mapped[1],16) >> 8, parseInt(mapped[1],16) & 255,
      parseInt(mapped[2],16) >> 8, parseInt(mapped[2],16) & 255] : null;
    if (!host || host === 'localhost' || host.endsWith('.localhost') ||
        ipv4 && privateIpv4(ipv4) || ipv6 === '::' || ipv6 === '::1' ||
        /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(ipv6) || mappedIpv4 && privateIpv4(mappedIpv4)) {
      throw new Error('Widgets cannot access local or private services.');
    }
    if (!ipv6 && (!host.includes('.') && !/^https?:/i.test(raw) || host.split('.').some(label =>
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) || parsed.href.length > 4096) throw invalid();
    return parsed.href;
  }

  function displayUrl(value) {
    try {
      const parsed = new URL(value);
      let path = parsed.pathname || '/';
      if (path.length > 70) path = path.slice(0, 67) + '…';
      return parsed.origin + path;
    } catch (e) { return 'Saved widget'; }
  }

  function normalizeAsset(value) {
    if (!value || typeof value !== 'object') return null;
    try {
      const id = String(value.id || '').trim();
      if (!id || id.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
      return {
        id,
        name: cleanName(value.name),
        url: cleanUrl(value.url),
        createdAt: Number(value.createdAt) || Date.now(),
        updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now()
      };
    } catch (e) { return null; }
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE) || 'null');
      const rows = parsed && Array.isArray(parsed.assets) ? parsed.assets : [];
      const assets = rows.map(normalizeAsset).filter(Boolean).slice(0, MAX_LIBRARY);
      return { version: 1, assets };
    } catch (e) { return { version: 1, assets: [] }; }
  }

  let library = load();

  function commit(next) {
    // Publish only after the browser has accepted the whole document. Callers
    // can report a failed save without losing the previous library or renderer.
    try { localStorage.setItem(STORE, JSON.stringify(next)); }
    catch (e) {
      const error = new Error('Could not save the widget library. Browser storage may be full or unavailable. Your previous widgets have not changed.');
      error.code = 'WIDGET_STORAGE_UNAVAILABLE';
      throw error;
    }
    library = next;
  }

  function emit(type, detail) {
    listeners.forEach(fn => { try { fn({ type, detail }); } catch (e) {} });
  }

  function list() { return library.assets.map(asset => ({ ...asset })); }
  function recallSceneState(saved) {
    const assets=Object.values(saved||{}).map(normalizeAsset).filter(Boolean),ids=new Set(assets.map(asset=>asset.id));
    library={...library,assets:[...library.assets.filter(asset=>!ids.has(asset.id)),...assets]};
  }
  function get(id) {
    const asset = library.assets.find(asset => asset.id === id);
    return asset ? { ...asset } : null;
  }
  function has(id) { return !!get(id); }

  // A taken widget keeps its URL and live renderer, even if its library record
  // is subsequently edited or deleted in Preview. Runtime IDs are versioned.
  const programmeAssets = new Map();
  function captureRenderState(placements) {
    // Hidden placements still belong to the scene and must survive library edits.
    return Object.fromEntries((placements || []).map(layer => [layer.assetId,get(layer.assetId)]).filter(([,asset])=>asset));
  }
  function capturedId(asset) {
    let hash = 2166136261;
    for (const char of asset.url) hash = Math.imul(hash ^ char.charCodeAt(0),16777619);
    return 'frame-' + asset.id + '-' + (hash >>> 0).toString(36);
  }
  function renderId(id, state) { const asset=state ? state[id] : get(id); return asset ? capturedId(asset) : id; }
  function stopPreviewSessions(id) {
    for(const [key,rec] of sessions) if(rec.assetId===id&&!programmeAssets.has(key))stopSession(key);
  }

  function create(spec) {
    if (library.assets.length >= MAX_LIBRARY) {
      throw new Error(`You can save up to ${MAX_LIBRARY} widgets.`);
    }
    const now = Date.now();
    const asset = {
      id: uid(), name: cleanName(spec && spec.name), url: cleanUrl(spec && spec.url),
      createdAt: now, updatedAt: now
    };
    commit({ ...library, assets: [...library.assets, asset] });
    emit('library', { action: 'create', id: asset.id });
    return { ...asset };
  }

  function update(id, patch) {
    const asset = get(id);
    if (!asset) throw new Error('That saved widget no longer exists.');
    const oldUrl = asset.url;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
      asset.name = cleanName(patch.name);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'url')) {
      asset.url = cleanUrl(patch.url);
    }
    asset.updatedAt = Date.now();
    commit({ ...library, assets: library.assets.map(row => row.id === id ? asset : row) });
    if (oldUrl !== asset.url) stopPreviewSessions(id);
    emit('library', { action: 'update', id });
    return { ...asset };
  }

  function remove(id) {
    const index = library.assets.findIndex(asset => asset.id === id);
    if (index < 0) return false;
    commit({ ...library, assets: library.assets.filter((asset, position) => position !== index) });
    stopPreviewSessions(id);
    emit('library', { action: 'remove', id });
    return true;
  }

  async function jsonRequest(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    let payload = {};
    try { payload = await response.json(); } catch (e) {}
    if (!response.ok) throw new Error(String(payload.error || `Widget renderer returned ${response.status}.`));
    return payload;
  }

  async function refreshCapability() {
    try {
      capabilityState = { ...(await jsonRequest('/api/widgets/status')), checked: true };
    } catch (error) {
      capabilityState = {
        ...capabilityState, checked: true, available: false,
        reason: String(error && error.message || error)
      };
    }
    emit('capability', { ...capabilityState });
    return { ...capabilityState };
  }

  function setSessionState(rec, state, reason) {
    const changed = rec.state !== state || rec.reason !== (reason || '');
    rec.state = state; rec.reason = String(reason || '');
    if (changed) emit('runtime', { id: rec.id, state: rec.state, reason: rec.reason });
  }

  function acceptFrame(rec, blob, sequence) {
    if (rec.stopped) return Promise.resolve(false);
    return new Promise(resolve => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        if (rec.stopped) { URL.revokeObjectURL(objectUrl); resolve(false); return; }
        try {
          for(const canvas of rec.sourceCanvases || []){
            const ctx=canvas.getContext('2d');
            if(!ctx)throw new Error('The browser-source canvas is unavailable.');
            ctx.clearRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(image,0,0,canvas.width,canvas.height);
          }
        } catch(error) {
          URL.revokeObjectURL(objectUrl);
          setSessionState(rec,'failed','The browser frame could not be drawn: '+(error.message||String(error)));
          resolve(false);return;
        }
        if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
        rec.image = image; rec.objectUrl = objectUrl; rec.sequence = sequence;
        rec.updatedAt = Date.now(); setSessionState(rec, 'ready', ''); resolve(true);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        if(!rec.stopped)setSessionState(rec, 'failed', 'The widget frame could not be decoded.');
        resolve(false);
      };
      image.src = objectUrl;
    });
  }

  async function frameLoop(rec) {
    while (!rec.stopped) {
      try {
        const response = await fetch('/api/widgets/frame?id=' + encodeURIComponent(rec.id) +
          '&since=' + encodeURIComponent(rec.sequence), {
          cache: 'no-store', signal: rec.controller.signal
        });
        if(rec.stopped)return;
        if (response.status === 204) {
          const state = response.headers.get('X-OpenLive-Widget-State');
          if(['failed','closed'].includes(state)){
            setSessionState(rec,state,'The browser renderer stopped providing frames.');return;
          }
          // A ready header is not a decoded frame. Unchanged pages retain their
          // last image, but a newly opened source still waits for actual pixels.
          if (state && (state !== 'ready'||rec.image)) setSessionState(rec, state, '');
          continue;
        }
        if (!response.ok) {
          let payload = {};
          try { payload = await response.json(); } catch (e) {}
          throw new Error(String(payload.error || `Widget frame returned ${response.status}.`));
        }
        const sequence = Number(response.headers.get('X-OpenLive-Frame')) || rec.sequence + 1;
        if(!await acceptFrame(rec, await response.blob(), sequence))return;
      } catch (error) {
        if (rec.stopped || (error && error.name === 'AbortError')) return;
        setSessionState(rec, 'failed', String(error && error.message || error));
        return;
      }
    }
  }

  async function ensure(id, requestedAsset) {
    const asset = requestedAsset || programmeAssets.get(id) || get(id);
    if (!asset) return null;
    id=capturedId(asset);
    let rec = sessions.get(id);
    if (rec && rec.url === asset.url && !rec.stopped && rec.state !== 'failed') return rec;
    if (rec) stopSession(id);
    rec = {
      id, assetId:asset.id, url: asset.url, state: 'starting', reason: '', image: null,
      objectUrl: null, sequence: 0, updatedAt: 0, stopped: false,
      controller: new AbortController()
    };
    sessions.set(id, rec); emit('runtime', { id, state: 'starting', reason: '' });
    try {
      const opened = await jsonRequest('/api/widgets/open', {
        id, name: asset.name, url: asset.url,
        width: asset.width || VIEWPORT.width, height: asset.height || VIEWPORT.height
      });
      if (rec.stopped) { if(!sessions.has(id))closeRemoteSession(id); return rec; }
      if (!rec.image) setSessionState(rec, opened.state==='ready'?'loading':opened.state || 'loading', opened.reason || '');
      frameLoop(rec);
    } catch (error) {
      if (!rec.stopped) setSessionState(rec, 'failed', String(error && error.message || error));
    }
    return rec;
  }

  function closeRemoteSession(id) {
    fetch('/api/widgets/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }), cache: 'no-store', keepalive: true
    }).catch(() => {});
  }
  function stopSession(id) {
    if (!sessions.has(id)) id=renderId(id);
    const rec = sessions.get(id);
    if (!rec) return false;
    sessions.delete(id); rec.stopped = true; wantedKey = '';
    try { rec.controller.abort(); } catch (e) {}
    if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (e) {} }
    rec.objectUrl = null; rec.image = null;
    closeRemoteSession(id);
    emit('runtime', { id, state: 'closed', reason: '' });
    return true;
  }

  async function acquireSource(config={},signal) {
    if(signal?.aborted)throw new Error('Browser source preparation cancelled.');
    const width=Number(config.width??1280),height=Number(config.height??720);
    if(![width,height].every(n=>Number.isInteger(n)&&n>=160&&n<=1920))throw new Error('Browser dimensions must be whole pixels between 160 and 1920.');
    const asset={id:uid(),name:'Browser source',url:cleanUrl(config.url),width,height},id=capturedId(asset);
    if(sessions.size>=12)throw new Error('All 12 browser renderers are in use. Remove an unused browser source first.');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    if(!canvas.getContext('2d'))throw new Error('The browser-source canvas is unavailable.');
    sourceAssets.set(id,asset);wantedKey='';
    let disposed=false;
    const dispose=()=>{if(disposed)return;disposed=true;sourceAssets.delete(id);stopSession(id);canvas.remove?.();};
    try{
      await new Promise((resolve,reject)=>{
        let settled=false,timer,unsubscribe=()=>{};
        const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);unsubscribe();signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
        const cancel=()=>{finish(new Error('Browser source preparation cancelled.'));dispose();};
        unsubscribe=subscribe(event=>{
          if(event.type!=='runtime'||event.detail.id!==id)return;
          if(event.detail.state==='ready')finish();
          else if(['failed','closed'].includes(event.detail.state))finish(new Error(event.detail.reason||'Browser source stopped before its first frame.'));
        });
        signal?.addEventListener('abort',cancel,{once:true});
        timer=setTimeout(()=>finish(new Error('No browser picture received within 20 seconds. Check the URL and local renderer.')),20000);
        void ensure(id,asset);
        const rec=sessions.get(id);if(rec)rec.sourceCanvases=new Set([canvas]);
      });
      if(signal?.aborted)throw new Error('Browser source preparation cancelled.');
      return {kind:'browser',sourceType:'browser',el:canvas,dispose,
        audio:{included:false,reason:'The isolated browser renderer provides video only. Browser audio is not implemented.'},
        runtimeStatus:()=>{const rec=sessions.get(id),ok=!disposed&&rec?.state==='ready'&&!!rec.image;return {ok,state:rec?.state||'ended',why:ok?'':rec?.reason||'The browser renderer is not ready.'};}};
    }catch(error){dispose();throw error;}
  }

  let wantedKey = '';
  function reconcile(ids, snapshots = []) {
    programmeAssets.clear();
    for (const snapshot of snapshots) for (const asset of Object.values(snapshot || {}))
      if (asset?.id && asset.url) programmeAssets.set(capturedId(asset),asset);
    const assets=new Map(programmeAssets);
    for(const id of ids || []) {const asset=get(id);if(asset)assets.set(capturedId(asset),asset);}
    // The helper supports twelve runtimes. Acquired Browser sources are leases:
    // never stop their capture during widget reconciliation. The remaining
    // capacity prioritizes Programme/transition widgets over Preview widgets.
    // Acquisition refuses a thirteenth runtime; Take still checks readiness.
    const wanted = [...new Set([...sourceAssets.keys(),...assets.keys()])].slice(0,12);
    const key = wanted.slice().sort().join('\n');
    if (key === wantedKey) return;
    wantedKey = key;
    const set = new Set(wanted);
    [...sessions.keys()].forEach(id => { if (!set.has(id)) stopSession(id); });
    wanted.forEach(id => { if(!sourceAssets.has(id))ensure(id,assets.get(id)); });
  }

  function runtimeStatus(id, state) {
    const rec = sessions.get(renderId(id,state));
    if (!rec) return { state: 'idle', reason: '', frame: 0, updatedAt: null };
    return {
      state: rec.state, reason: rec.reason, frame: rec.sequence,
      updatedAt: rec.updatedAt || null
    };
  }

  function draw(ctx, cv, placements, options) {
    if (options && options.aspect && options.aspect !== '16x9') return 0;
    let count = 0;
    (placements || []).forEach(layer => {
      if (!layer || layer.visible === false) return;
      const rec = sessions.get(renderId(layer.assetId,options?.widgetsState));
      if (!rec || !rec.image || rec.state !== 'ready') return;
      const x = Math.max(0, Math.min(1, Number(layer.x) || 0)) * cv.width;
      const y = Math.max(0, Math.min(1, Number(layer.y) || 0)) * cv.height;
      const w = Math.max(.04, Math.min(1, Number(layer.w) || 1)) * cv.width;
      const h = Math.max(.04, Math.min(1, Number(layer.h) || 1)) * cv.height;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1,
        Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1));
      try { ctx.drawImage(rec.image, x, y, Math.min(w, cv.width - x), Math.min(h, cv.height - y)); count++; }
      catch (e) {}
      ctx.restore();
    });
    return count;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn); return () => listeners.delete(fn);
  }

  function shutdown() {
    wantedKey = '';
    [...sessions.keys()].forEach(stopSession);
    sourceAssets.clear();
  }

  window.addEventListener('beforeunload', shutdown);

  return {
    version: 1, MAX_LIBRARY, MAX_SCENE, VIEWPORT,
    list, get, has, create, update, remove, displayUrl, cleanUrl,
    subscribe, refreshCapability, capability: () => ({ ...capabilityState }),
    ensure, acquireSource, reconcile, runtimeStatus, draw, stopSession, shutdown, captureRenderState, recallSceneState,
    _reloadForTest() { library = load(); wantedKey = ''; return list(); }
  };
})();
