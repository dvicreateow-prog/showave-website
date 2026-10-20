/* ===========================================================================
   arena-live.js — live transport between this UI and a running Resolume Arena
   ---------------------------------------------------------------------------
   Arena/Avenue expose a webserver (Preferences > Webserver) that serves:
     REST       http://host:8080/api/v1/...
     WebSocket  ws://host:8080/api/v1
   The server sends  Access-Control-Allow-Origin: *  so this page may be opened
   from file://, from any local server, or from Arena's own webserver root.

   Protocol (Resolume 7 websocket API):
     on connect the server pushes, unprompted:
       <composition>                          full composition state
       { type:'sources_update', value:[...] } every installed source
       { type:'effects_update', value:{...} } every installed effect
     the composition is re-pushed on every STRUCTURAL change
       (layer/column/deck/effect added or removed, deck switched, file loaded)
     parameter VALUE changes are only pushed for parameters you subscribed to.

   Client -> server:
     { action:'subscribe'|'unsubscribe'|'get'|'set'|'reset'|'trigger',
       parameter:'/parameter/by-id/<id>', value:<v> }        parameters
     { action:'post'|'remove', id:'<tag>', path:'<path>', body:{} }  structure

   This module owns the socket and the model. It renders nothing.
   =========================================================================== */
window.ArenaLive = (() => {
  'use strict';

  /* ---- where Arena lives -------------------------------------------------
     Order of preference: ?arena=host:port  >  saved choice  >  this page's
     own origin (when served from Arena itself)  >  127.0.0.1:8080          */
  const qs = new URLSearchParams(location.search);
  const saved = (() => { try { return localStorage.getItem('arenaHost'); } catch { return null; } })();
  const sameOrigin = /^https?:$/.test(location.protocol) && location.host ? location.host : null;
  /* Candidates, best first. Same-origin is a candidate rather than an answer:
     this page is just as likely to be served by a plain static server as by
     Arena's own webserver, so every candidate has to prove itself by
     answering /product before we open a socket to it. */
  const CANDIDATES = [...new Set([qs.get('arena'), saved, sameOrigin,
    '127.0.0.1:8080', 'localhost:8080'].filter(Boolean))];
  let HOST = qs.get('arena') || saved || '127.0.0.1:8080';

  const httpBase = () => `http://${HOST}/api/v1`;
  const wsBase   = () => `ws://${HOST}/api/v1`;

  /* ---- event bus --------------------------------------------------------- */
  const bus = {};
  const on = (evt, fn) => ((bus[evt] = bus[evt] || []).push(fn), fn);
  const emit = (evt, arg) => (bus[evt] || []).forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } });

  /* ---- state ------------------------------------------------------------- */
  const AL = {
    status: 'offline',        // offline | connecting | live
    comp: null,               // last full composition object
    effects: null,            // { video:[...], audio:[...] }
    sources: null,            // [...]
    error: null,
    params: new Map(),        // id -> last known param object
    subs: new Set(),          // subscribed parameter ids
    host: () => HOST,
    on, off: (evt, fn) => { const a = bus[evt] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };

  let ws = null, retry = null, retryDelay = 1000, reconcile = null, everConnected = false;
  let monCache = { list: null, at: 0 }, monitorGeneration = 0;

  /* Monitor ids include Composition-owned Layer associations. A full
     Composition adoption invalidates all of them, even when the replacement
     has the same Layer count. The generation also rejects an older in-flight
     /monitors response that arrives after the new document was adopted. */
  function invalidateMonitors(){
    monitorGeneration++;
    monCache = { list: null, at: 0 };
    return monitorGeneration;
  }

  const setStatus = s => { if (AL.status !== s) { AL.status = s; emit('status', s); } };

  /* =======================================================================
     connection
     ======================================================================= */
  /* ask each candidate whether it is a Resolume webserver; first one wins */
  async function discover() {
    for (const host of CANDIDATES) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1200);
        const r = await fetch(`http://${host}/api/v1/product`, { mode: 'cors', signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const p = await r.json();
        if (p && (p.name === 'Arena' || p.name === 'Avenue')) {
          try { localStorage.setItem('arenaHost', host); } catch {}
          return host;
        }
      } catch { /* not this one */ }
    }
    return null;
  }

  function connect(host) {
    if (host) { HOST = host; try { localStorage.setItem('arenaHost', host); } catch {} }
    disconnect(true);
    setStatus('connecting');
    if (!host) {                       // no explicit host — find one first
      discover().then(found => {
        if (!found) return fail();
        HOST = found; openSocket();
      }).catch(fail);
      return;
    }
    openSocket();
  }

  function openSocket() {
    let sock;
    try { sock = new WebSocket(wsBase()); }
    catch (e) { AL.error = String(e); return fail(); }
    ws = sock;

    sock.onopen = () => {
      everConnected = true; retryDelay = 1000; AL.error = null;
      setStatus('live');
      /* the server pushes composition + sources + effects on its own.
         a safety-net full refresh every 5 s catches anything a dropped frame lost. */
      clearInterval(reconcile);
      reconcile = setInterval(() => { if (AL.status === 'live') refresh().catch(() => {}); }, 5000);
    };
    sock.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    sock.onerror = () => { AL.error = 'websocket error'; };
    sock.onclose = () => { if (ws === sock) { ws = null; fail(); } };
  }

  function fail() {
    invalidatePendingCompositionRefreshes();
    setStatus('offline');
    clearInterval(reconcile);
    clearTimeout(retry);
    retry = setTimeout(() => connect(), retryDelay);
    retryDelay = Math.min(retryDelay * 1.6, 15000);   // back off, keep trying forever
  }

  function disconnect(quiet) {
    invalidatePendingCompositionRefreshes();
    clearTimeout(retry); clearInterval(reconcile);
    if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
    if (!quiet) setStatus('offline');
  }

  function handle(m) {
    if (m.type === 'sources_update') { AL.sources = m.value; emit('sources', m.value); return; }
    if (m.type === 'effects_update') { AL.effects = m.value; emit('effects', m.value); return; }

    /* parameter traffic */
    if (m.type && m.type.startsWith('parameter_')) {
      const p = m.value !== undefined && m.value && m.value.id ? m.value : m;
      const id = p.id ?? idFromPath(m.path);
      if (id != null) {
        const prev = AL.params.get(id) || {};
        const next = Object.assign({}, prev, p);
        AL.params.set(id, next);
        writeThrough(id, next);
        emit('param', { id, param: next, path: m.path, type: m.type });
      }
      return;
    }

    /* structural response to a post/remove */
    if (m.id !== undefined && ('error' in m) && !m.layers) { emit('actionresult', m); if (m.error) console.warn('Arena:', m.id, m.error); return; }

    /* anything carrying layers is the composition. A pushed Composition is
       newer than every REST refresh that was already in flight, so it advances
       the push generation used by refresh() below. */
    if (m.layers) adoptComposition(m, 'push');
  }

  const idFromPath = path => {
    const mm = /by-id\/(\d+)/.exec(path || ''); return mm ? +mm[1] : null;
  };

  /* keep AL.comp's own param objects in step with subscribed updates so any
     reader of the tree sees fresh values without re-walking the socket log */
  const paramRefs = new Map();     // id -> param object inside AL.comp
  function writeThrough(id, next) {
    const ref = paramRefs.get(id);
    if (ref && next && 'value' in next) ref.value = next.value;
    if (ref && next && 'index' in next) ref.index = next.index;
  }

  let compositionAuthorityGeneration = 0;
  let refreshSequence = 0;
  let lastAppliedRefreshSequence = 0;
  function invalidatePendingCompositionRefreshes(){ compositionAuthorityGeneration++; }
  function adoptComposition(c, source) {
    if (source !== 'refresh') invalidatePendingCompositionRefreshes();
    invalidateMonitors();
    AL.comp = c;
    paramRefs.clear();
    index(c);
    autoSubscribe();
    emit('comp', c);
  }

  /* walk the tree, remember every parameter object by id */
  function index(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(index);
    if (node.valuetype && node.id != null) { paramRefs.set(node.id, node); AL.params.set(node.id, node); return; }
    for (const k in node) index(node[k]);
  }

  /* =======================================================================
     REST
     ======================================================================= */
  async function rest(path, opt) {
    const r = await fetch(httpBase() + path, Object.assign({ mode: 'cors' }, opt));
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    const ct = r.headers.get('content-type') || '';
    return r.status === 204 ? null : ct.includes('json') ? r.json() : r.text();
  }
  /* POST with no body — the shape every Arena "do it" endpoint takes */
  const action = (path) => rest(path, { method: 'POST' });
  const del    = (path) => rest(path, { method: 'DELETE' });

  async function refresh() {
    const request = ++refreshSequence;
    const authorityGeneration = compositionAuthorityGeneration;
    const c = await rest('/composition');
    /* Two refreshes can complete out of order, and a WebSocket Composition can
       arrive while either GET is in flight. Never let the older REST snapshot
       replace a newer completed GET or a pushed Composition. Refresh callers
       still receive the response so they can report transport success. */
    if (c && c.layers && request >= lastAppliedRefreshSequence &&
        authorityGeneration === compositionAuthorityGeneration) {
      lastAppliedRefreshSequence = request;
      adoptComposition(c, 'refresh');
    }
    return c;
  }
  /* Swagger: PUT /composition accepts a partial Composition object and returns
     204. Keep Name and both VideoTrack dimensions in ONE request so Apply is
     atomic; three parameter messages could otherwise leave a half-updated Size
     if the connection drops between Width and Height. The installed schema has
     no Description, FrameRate or Color Depth properties, so this helper does
     not invent paths for them. */
  async function updateCompositionSettings(next) {
    next = next || {};
    const has = key => Object.prototype.hasOwnProperty.call(next,key);
    const payload = {};
    if (has('name')) payload.name = { value: String(next.name == null ? '' : next.name) };
    if (has('width') || has('height')) payload.video = {};
    for (const key of ['width','height']) {
      if (!has(key)) continue;
      const value = Number(next[key]);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)
        throw new RangeError(`Composition ${key} must be a positive whole number of pixels`);
      payload.video[key] = { value };
    }
    if (!Object.keys(payload).length) throw new Error('No live Composition setting is writable');
    await rest('/composition', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return refresh();
  }
  async function probe() {                       // is anything there at all?
    try { return await rest('/product'); } catch { return null; }
  }

  /* =======================================================================
     parameters
     ======================================================================= */
  function send(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }
  const pathOf = id => `/parameter/by-id/${id}`;

  function subscribe(id) {
    if (id == null || AL.subs.has(id)) return;
    if (send({ action: 'subscribe', parameter: pathOf(id) })) AL.subs.add(id);
  }
  function unsubscribe(id) {
    if (id == null || !AL.subs.has(id)) return;
    send({ action: 'unsubscribe', parameter: pathOf(id) });
    AL.subs.delete(id);
  }
  function setParam(id, value) {
    if (id == null) return false;
    const ref = paramRefs.get(id);
    if (ref) ref.value = value;                       // optimistic — Arena confirms
    return send({ action: 'set', parameter: pathOf(id), value });
  }
  const triggerParam = id => id != null && send({ action: 'trigger', parameter: pathOf(id) });
  const resetParam   = id => id != null && send({ action: 'reset',   parameter: pathOf(id) });
  const getParam     = id => id != null && send({ action: 'get',     parameter: pathOf(id) });

  /* structural add/remove over the socket (post/remove, not POST/DELETE) */
  const post   = (path, body, tag) => send({ action: 'post',   id: tag || path, path, body });
  const remove = (path, tag)       => send({ action: 'remove', id: tag || path, path });

  /* ---- which parameters we keep live ------------------------------------
     Subscribing to every id in the tree would be tens of thousands on a big
     show. We subscribe to what the main window actually draws, plus whatever
     panel is open (see subscribeEntity).                                    */
  function autoSubscribe() {
    const c = AL.comp; if (!c) return;
    const want = new Set();
    const add = p => { if (p && p.id != null) want.add(p.id); };

    add(c.name); add(c.description); add(c.master); add(c.speed); add(c.bypassed);
    add(c.cliptarget); add(c.cliptriggerstyle); add(c.clipbeatsnap);
    if (c.audio) { add(c.audio.volume); add(c.audio.pan); }
    if (c.video) { add(c.video.opacity); add(c.video.width); add(c.video.height); }
    if (c.dashboard) Object.values(c.dashboard).forEach(add);
    if (c.tempocontroller) {
      add(c.tempocontroller.tempo); add(c.tempocontroller.play_state);
      /* Arena 7.27's published schema has no Metronome Parameter. Subscribe
         opportunistically so a newer host that does expose it synchronises
         the toolbar instead of being mistaken for the unsupported case. */
      add(c.tempocontroller.metronome);
    }
    if (c.crossfader) {
      add(c.crossfader.phase); add(c.crossfader.behaviour); add(c.crossfader.curve);
      add(c.crossfader.sidea); add(c.crossfader.sideb);
      if (c.crossfader.mixer) Object.values(c.crossfader.mixer).forEach(add);
    }
    (c.decks || []).forEach(d => { add(d.name); add(d.selected); add(d.colorid); });
    (c.columns || []).forEach(col => {
      add(col.name); add(col.connected); add(col.selected); add(col.colorid); add(col.beatsnap);
    });
    (c.layers || []).forEach(l => {
      add(l.name); add(l.master); add(l.bypassed); add(l.solo); add(l.selected);
      add(l.colorid); add(l.crossfadergroup); add(l.maskmode); add(l.ignorecolumntrigger);
      add(l.faderstart);
      /* Trigger First Clip On Play and Lock Content are present in Arena's
         Layer menu/documentation, but are absent from the installed 7.27 REST
         Layer schema. Subscribe when a newer API exposes either spelling; the
         UI otherwise shows the item disabled with that exact reason. */
      add(l.triggerfirstclip || l.triggerfirst);
      add(l.lockcontent || l.lock);
      if (l.video) { add(l.video.opacity); if (l.video.mixer) Object.values(l.video.mixer).forEach(add); }
      if (l.audio) { add(l.audio.volume); add(l.audio.pan); }
      if (l.transition) { add(l.transition.duration); add(l.transition.blend_mode); }
      (l.clips || []).forEach(cl => { add(cl.name); add(cl.connected); add(cl.selected); add(cl.colorid); });
    });
    (c.layergroups || []).forEach(g => {
      add(g.name); add(g.master); add(g.bypassed); add(g.solo); add(g.colorid);
      if (g.video) { add(g.video.opacity); if (g.video.mixer) Object.values(g.video.mixer).forEach(add); }
    });

    want.forEach(subscribe);
    /* drop subscriptions for ids that no longer exist (deck switch, layer delete) */
    [...AL.subs].forEach(id => { if (!want.has(id) && !detailSubs.has(id)) unsubscribe(id); });
  }

  /* the open property panel subscribes deeply, and releases on switch */
  let detailSubs = new Set();
  function subscribeEntity(node) {
    const next = new Set();
    (function walk(n, d) {
      if (!n || typeof n !== 'object' || d > 6) return;
      if (Array.isArray(n)) return n.forEach(x => walk(x, d + 1));
      if (n.valuetype && n.id != null) { next.add(n.id); return; }
      for (const k in n) walk(n[k], d + 1);
    })(node, 0);
    detailSubs.forEach(id => { if (!next.has(id)) unsubscribe(id); });
    next.forEach(subscribe);
    detailSubs = next;
  }

  /* =======================================================================
     model helpers — everything the UI asks of a composition
     ======================================================================= */
  const val = p => (p && typeof p === 'object' && 'value' in p) ? p.value : p;

  /* Arena numbers layers 1..n bottom-to-top; the UI draws top-to-bottom. */
  const layers  = () => (AL.comp && AL.comp.layers)  || [];
  const columns = () => (AL.comp && AL.comp.columns) || [];
  const decks   = () => (AL.comp && AL.comp.decks)   || [];
  const groups  = () => (AL.comp && AL.comp.layergroups) || [];
  const layer   = i => layers()[i - 1];                 // 1-based, as the API is
  const clip    = (l, c) => { const L = layer(l); return L && L.clips ? L.clips[c - 1] : null; };
  const column  = c => columns()[c - 1];
  const activeDeckIndex = () => Math.max(0, decks().findIndex(d => val(d.selected) === true));

  /* Structural menu actions use stable entity URLs whenever the composition
     payload supplies ids. An insert or duplicate renumbers positional URLs as
     soon as it succeeds, so keeping a copied positional source around is not
     safe for a later Paste Effects gesture. */
  const layerPath = i => {
    const l = layer(i);
    return l && l.id != null
      ? `/composition/layers/by-id/${encodeURIComponent(l.id)}`
      : `/composition/layers/${i}`;
  };
  const groupPath = i => {
    const g = groups()[i - 1];
    return g && g.id != null
      ? `/composition/layergroups/by-id/${encodeURIComponent(g.id)}`
      : `/composition/layergroups/${i}`;
  };
  /* Deck callers use zero-based indices, while Arena's positional URLs are
     one-based. Prefer the immutable id so an insert/duplicate elsewhere cannot
     redirect an already queued command to another Deck. Passing the captured
     Deck object is supported for the same reason. */
  const deckIndex = target => {
    if(typeof target==='number') return Number.isInteger(target)?target:-1;
    if(!target||typeof target!=='object') return -1;
    const current=decks(); let i=current.indexOf(target);
    if(i<0&&target.id!=null)
      i=current.findIndex(deck=>deck&&String(deck.id)===String(target.id));
    return i;
  };
  const deckPath = target => {
    const objectTarget=target&&typeof target==='object';
    const i = deckIndex(target);
    const d = objectTarget ? target : (Number.isInteger(i)?decks()[i]:null);
    if (!d) return null;
    if(d.id != null) return `/composition/decks/by-id/${encodeURIComponent(d.id)}`;
    return i>=0 ? `/composition/decks/${i + 1}` : null;
  };
  const withDeckPath = (target, work) => {
    const path = deckPath(target);
    return path ? work(path) : Promise.reject(new RangeError('Deck does not exist'));
  };

  const clipState = (l, c) => { const k = clip(l, c); return k ? val(k.connected) : 'Empty'; };
  const clipName  = (l, c) => { const k = clip(l, c); return k ? (val(k.name) || '') : ''; };
  const isEmpty   = (l, c) => clipState(l, c) === 'Empty';
  const isPlaying = (l, c) => /^Connected/.test(clipState(l, c));

  /* thumbnails: Arena bumps last_update whenever the frame changes, which
     doubles as a cache-buster so the browser never shows a stale image. */
  function thumbUrl(l, c) {
    const k = clip(l, c);
    if (!k || !k.thumbnail || k.thumbnail.is_default) return null;
    const stamp = k.thumbnail.last_update || '0';
    return `${httpBase()}/composition/layers/${l}/clips/${c}/thumbnail?v=${encodeURIComponent(stamp)}`;
  }

  /* ---- commands the UI issues ------------------------------------------- */
  const cmd = {
    /* These are document-level momentary commands in Arena's published REST
       API. Refresh after New so every consumer swaps to the replacement graph
       before the UI reports success; Save has no structural response to adopt. */
    newComposition: async () => { await action('/composition/new'); return refresh(); },
    openComposition: async fileUrl => {
      await cmd.post204('/composition/open', String(fileUrl));
      return refresh();
    },
    saveComposition: fileUrl => fileUrl == null
      ? action('/composition/save')
      : cmd.post204('/composition/save', String(fileUrl)),
    copyCompositionEffects: sourcePath =>
      cmd.post204('/composition/copy-effects', String(sourcePath)),
    triggerClip:  (l, c) => action(`/composition/layers/${l}/clips/${c}/connect`),
    selectClip:   (l, c) => action(`/composition/layers/${l}/clips/${c}/select`),
    clearClip:    (l, c) => del(`/composition/layers/${l}/clips/${c}`),
    triggerColumn:c      => action(`/composition/columns/${c}/connect`),
    selectColumn: c      => action(`/composition/columns/${c}/select`),
    selectLayer:  l      => action(`/composition/layers/${l}/select`),
    clearLayer:   l      => action(`/composition/layers/${l}/clear`),
    ejectAll:     ()     => action('/composition/disconnect-all'),
    addLayer:     ()     => action('/composition/layers/add'),
    /* Arena indexes Layers bottom-to-top. `/layers/add` inserts before the
       entity supplied in its text body, hence Above targets the next index and
       Below targets the selected Layer itself. */
    insertLayerAbove: l => l < layers().length
      ? cmd.post204('/composition/layers/add', layerPath(l + 1))
      : action('/composition/layers/add'),
    insertLayerBelow: l => cmd.post204('/composition/layers/add', layerPath(l)),
    duplicateLayer: l => action(`${layerPath(l)}/duplicate`),
    removeLayer: l => del(layerPath(l)),
    clearLayerClips: l => action(`${layerPath(l)}/clearclips`),
    removeLayerFromGroup: l => action(`${layerPath(l)}/remove-from-group`),
    addLayerGroupForLayer: l => cmd.post204('/composition/layergroups/add', layerPath(l)),
    moveLayerToGroup: (l, g) => cmd.post204(`${groupPath(g)}/move-layer`, layerPath(l)),
    copyLayerEffects: (target, sourcePath) =>
      cmd.post204(`${layerPath(target)}/copy-effects`, sourcePath),
    layerPath,
    groupPath,
    deckPath,
    addColumn:    ()     => action('/composition/columns/add'),
    insertColumnBefore: c => cmd.post204('/composition/columns/add',
      `/composition/columns/${c}`),
    insertColumnAfter: c => c < columns().length
      ? cmd.post204('/composition/columns/add',`/composition/columns/${c+1}`)
      : action('/composition/columns/add'),
    duplicateColumn: c => action(`/composition/columns/${c}/duplicate`),
    removeColumn: c => del(`/composition/columns/${c}`),
    clearColumn: async c => {
      /* Arena exposes no clear-Column route. A Column belongs to the active
         Deck, so clear its visible Slots through the documented Clip DELETE
         endpoint and let Arena group/confirm the resulting state. */
      for(let l=1;l<=layers().length;l++) if(!isEmpty(l,c)) await del(`/composition/layers/${l}/clips/${c}`);
    },
    removeColumnsBefore: async c => {
      /* Delete high-to-low so every original position remains valid. */
      for(let index=c-1;index>=1;index--) await del(`/composition/columns/${index}`);
    },
    removeColumnsAfter: async c => {
      for(let index=columns().length;index>c;index--) await del(`/composition/columns/${index}`);
    },
    addDeck:      ()     => action('/composition/decks/add'),
    insertDeckBefore: target => withDeckPath(target,
      path => cmd.post204('/composition/decks/add', path)),
    insertDeckAfter: target => {
      const i = deckIndex(target);
      if(i<0) return Promise.reject(new RangeError('Deck does not exist'));
      return i < decks().length - 1
        ? withDeckPath(decks()[i + 1],path => cmd.post204('/composition/decks/add',path))
        : action('/composition/decks/add');
    },
    duplicateDeck: target => withDeckPath(target,path => action(`${path}/duplicate`)),
    removeDeck:    target => withDeckPath(target,path => del(path)),
    closeDeck:     target => withDeckPath(target,path => action(`${path}/close`)),
    openDeck:      target => withDeckPath(target,path => action(`${path}/open`)),
    /* The REST route gives the caller a real 204/404 acknowledgement. The old
       parameter trigger returned only whether bytes entered the WebSocket and
       could therefore report success after Arena had rejected the selection. */
    selectDeck:    target => withDeckPath(target,path => action(`${path}/select`)),
    tempoTap:     ()     => triggerParam(deep('tempocontroller.tempo_tap')),
    tempoResync:  ()     => triggerParam(deep('tempocontroller.resync')),
    tempoNudgeUp: ()     => triggerParam(deep('tempocontroller.tempo_push')),
    tempoNudgeDn: ()     => triggerParam(deep('tempocontroller.tempo_pull')),
    crossfadeA:   ()     => triggerParam(deep('crossfader.sidea')),
    crossfadeB:   ()     => triggerParam(deep('crossfader.sideb')),
    /* content */
    openSource:   (l, c, idstring) =>
      rest(`/composition/layers/${l}/clips/${c}/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: idstring })
      }),
    openFile:     (l, c, path) =>
      rest(`/composition/layers/${l}/clips/${c}/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      }),
    /* --------------------------------------------------------------------
       The effect chain, exercised against Arena 7.27.1 rev 15990 over its own
       REST API rather than read off swagger. Four things the spec does not say:

       · Offsets are ZERO-BASED. On a five-effect chain, DELETE …/video/4
         removes the fifth and …/video/5 answers 404. Counting from 1 removes
         the wrong effect, quietly.
       · The name in the URI has to be percent-encoded. A literal space answers
         **200** and adds nothing — 200 is this endpoint's "silently did
         nothing". A "+" for the space answers 412, an unknown name answers
         412, and a real add answers **204**. So only 204 is success, and
         fetch's own r.ok is not a sufficient test.
       · add/{offset} inserts at that offset and answers 204.
       · move is broken in this build. Every body form swagger's own examples
         give — resource path, by-id, leading slash and not, effect:// scheme,
         zero- and one-based — answers 400 "Invalid effect URI". So a reorder
         is done by removing and re-inserting, which both verifiably work.
         That resets the effect's parameters to defaults; wireEffects says so
         rather than letting it look like a plain move.
       -------------------------------------------------------------------- */
    /* only 204 counts, and the body of a failure carries Arena's own reason */
    async post204(path, body) {
      const r = await fetch(httpBase() + path, {
        mode: 'cors', method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, body,
      });
      if (r.status === 204) return null;
      const why = await r.text().catch(() => '');
      throw new Error(`${r.status} ${path}${why ? ': ' + why.trim() : ''}`);
    },
    /* each segment encoded on its own, so "Blow/Solid" keeps its separator
       while "Hue Rotate" gets its %20 */
    effectUri: (name, track = 'video', preset = null) => {
      const parts = String(name).split('/');
      if (preset) parts.push(String(preset));
      return `effect:///${track}/${parts.map(encodeURIComponent).join('/')}`;
    },

    /* Resolume's own REST example uses the same hierarchical URI for Sources
       and their presets. Keep every segment separate: a Source and an Effect
       can share the same display name, but their schemes and REST actions are
       different operations. */
    sourceUri: (name, preset = null, track = 'video') => {
      const parts = [name]; if(preset) parts.push(preset);
      return `source:///${track}/${parts.map(x => encodeURIComponent(String(x))).join('/')}`;
    },

    openSourcePreset(l, c, name, preset, track = 'video') {
      return this.openSource(l, c, this.sourceUri(name, preset, track));
    },

    addEffectPreset(scope, name, preset, track = 'video', offset = null) {
      return this.post204(
        `${scope}/effects/${track}/add${offset != null ? '/' + offset : ''}`,
        this.effectUri(name, track, preset));
    },

    addEffect(scope, name, track = 'video', offset = null) {
      return this.post204(
        `${scope}/effects/${track}/add${offset != null ? '/' + offset : ''}`,
        this.effectUri(name, track));
    },
    /* `from` and `to` are both zero-based offsets. Removing `from` shifts
       everything after it down one, which makes the insert offset `to` in
       both directions — worked through for to>from and to<from alike. */
    async moveEffect(scope, from, to, track = 'video', name = null) {
      try {
        return await this.post204(`${scope}/effects/${track}/move/${to}`,
          `${scope}/effects/${track}/${from}`);
      } catch (e) {
        if (!/^400/.test(e.message) || !name) throw e;
        await del(`${scope}/effects/${track}/${from}`);
        await this.post204(`${scope}/effects/${track}/add/${to}`,
          this.effectUri(name, track));
        return { reinserted: true };
      }
    },
    removeEffect: (scope, offset, track = 'video') =>
      del(`${scope}/effects/${track}/${offset}`)
  };

  /* dotted lookup into the composition, returning a parameter id */
  function deep(dotted) {
    let n = AL.comp;
    for (const k of dotted.split('.')) { if (!n) return null; n = n[k]; }
    return n && n.id != null ? n.id : null;
  }

  /* ---- monitors — Arena's real pixel path --------------------------------
     GET /composition/monitors lists the render targets: a fixed head
     (Composition, Preview, Result, Bus A, Bus B, Selected …) plus one entry
     per layer, matched through `associated_object` ("/composition/layers/
     by-id/{id}"). GET /composition/monitors/{id}/snapshot.png answers that
     target's current frame — actual output, not a thumbnail. */
  async function monitors() {
    const now = performance.now();
    if (monCache.list && now - monCache.at < 5000) return monCache.list;
    if (AL.status !== 'live') return monCache.list;
    const generation = monitorGeneration;
    try {
      const r = await fetch(`${httpBase()}/composition/monitors`, { mode: 'cors' });
      if (r.ok) {
        const list = await r.json();
        if (generation === monitorGeneration) monCache = { list, at: performance.now() };
      }
    } catch { /* keep the stale list; callers fall back to thumbnails */ }
    return monCache.list;
  }
  /* cache-busted: the browser would otherwise happily show one frame forever */
  const snapshotUrl = id =>
    `${httpBase()}/composition/monitors/${id}/snapshot.png?t=${Date.now()}`;

  Object.assign(AL, {
    connect, disconnect, refresh, updateCompositionSettings, probe, rest, action, del,
    subscribe, unsubscribe, subscribeEntity, setParam, triggerParam, resetParam, getParam,
    post, remove, send,
    val, layers, columns, decks, groups, layer, clip, column, activeDeckIndex,
    clipState, clipName, isEmpty, isPlaying, thumbUrl, cmd, deep,
    monitors, invalidateMonitors, snapshotUrl,
    paramById: id => paramRefs.get(id) || AL.params.get(id) || null
  });

  /* start trying immediately; the UI renders demo content until we land */
  connect();
  return AL;
})();
