/* ===========================================================================
   openlive-routing.js — the signal chain that sits on top of the geometry in
   openlive-screens.js: what each slice takes as INPUT, and in what order the
   screens have to be rendered for those inputs to exist.
   ---------------------------------------------------------------------------
   openlive-screens.js answers "where does this slice put its pixels". This file
   answers the question before it — "which pixels" — and the question after it —
   "which of the composition's stages are still on those pixels by the time the
   slice gets them". Those are different questions and getting the second one
   wrong is silent: the picture appears, it is simply blended wrong forever.

   THE ONE RULE THIS FILE EXISTS TO ENFORCE, verbatim from slice-routing.htm:
     "When a layer is routed to a slice, all layer and clip effects will still be
      applied, but blend modes and composition effects will not! The slice will
      simply render all content with straight alpha on top of the other slices."
   So resolve() never returns a bare texture. It returns the texture WITH a
   complete effect ledger — all nine stages, always present, always booleans —
   because a renderer that reads `appliedEffects.layerBlendMode` and gets
   `undefined` will treat it as false by luck, not by contract, and the day the
   ledger gains a key that renderer starts lying. Missing keys are the bug.

   WHAT IS DOCUMENTED, WHAT IS DERIVED, WHAT IS OURS:

     documented  The five input sources (composition / layer / group / preview /
                 another screen's output) and their per-source toggles.
                 [slice-routing.htm]
     documented  The blend-mode and composition-effect carve-out, quoted above,
                 and that it is stated for LAYERS. [slice-routing.htm]
     documented  Input Opacity as a pre-fader/post-fader switch, and that both
                 toggles are inert unless the source is a layer or a group.
                 [sources.htm v7.19]
     documented  Input Bypass/Solo off + bypass the layer in the comp = the layer
                 shows in the slice and nowhere else. [slice-routing.htm]
     documented  A screen routes to "a slice in another screen"; one output
                 device per screen, and re-assigning an output demotes the
                 previous screen to virtual. [slice-routing.htm, screens.htm]
     derived     The carve-out applied to GROUPS. The manual restates only the
                 two toggles for groups. A group is itself a mix, so its own
                 blend mode against the comp must drop out while its internal
                 blending survives — flagged in every ledger it produces.
     derived     Straight alpha for preview / screen / live inputs. The manual
                 says it about routed layers. Marked evidence:'derived'.
     clone-only  CYCLE HANDLING. Nothing in the manual, nothing in the 258 REST
                 paths, nothing in Arena.exe's string table addresses A->B->A.
                 The only hint is screens.htm's "the delay will be either 0 or 1
                 frame" for virtual outputs. So this file refuses cycles at
                 assignment time by default, and can instead break the back edge
                 and feed it LAST frame's texture (which is what a 1-frame delay
                 already is). Both are ours. Neither is claimed to match Arena.

   THE NAMING TRAP, and it will catch you. In Arena's XML a screen's SLICES are
   stored in an element called <layers>, and openlive-screens.js keeps that name
   on the model object (screen.layers) because it round-trips the file verbatim.
   A composition LAYER is a completely different thing and is a legal input
   SOURCE for a slice. In this file `layer` ALWAYS means a composition layer;
   the things inside a screen are `slices`, reached through slicesOf()/sliceOf(),
   and the two places that touch screen.layers say so out loud.

   NAME CORRECTION, kept deliberately. The task's contract says `ignoreOpacity`
   and `ignoreBypassSolo`, and those are the stored keys. Arena's actual controls
   are labelled Input Opacity and Input Bypass/Solo — confirmed as literal
   strings in Arena.exe, where "Ignore Opacity" and "IgnoreOpacity" do NOT
   appear; "Ignore Opacity" is only a heading on slice-routing.htm. They are the
   same switch at opposite polarity, so every opts view carries both:
   inputOpacity === !ignoreOpacity. Label UI from inputOpacity, store the other.

   Pure model. No WebGL, no canvas, no DOM except navigator.mediaDevices for the
   live-input probe — and that is behind an explicit call, never at load. NDI,
   Spout and Syphon are DECLARED as sources and reported unavailable with the
   reason; they are never silently dropped and never faked.

   Classic script. Publishes window.OpenLiveRouting. Reads
   window.OpenLiveScreens for the screen/slice model, and window.ArenaLive or
   window.OpenLiveHub for the composition's layers and groups if either is
   loaded. Works with none of them present — an empty graph, not an exception.
   =========================================================================== */
window.OpenLiveRouting = (() => {
  'use strict';

  /* ================= guards =================
     Same discipline as openlive-screens.js: every value that came off disk, out
     of a UI or out of another module funnels through these, because a NaN
     opacity multiplied into a frame is a black screen with no error message. */
  const finite = v => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
  const num = (v, dflt) => (finite(v) ? v : dflt);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const str = v => (v == null ? '' : String(v));
  const bool = v => v === true || v === 1 || v === '1' || v === 'true';
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  /* Arena's REST tree wraps every value as {value:...}; the hub stores them
     bare. One reader for both, so a provider swap is not a rewrite. */
  const val = v => (v != null && typeof v === 'object' && has(v, 'value') ? v.value : v);
  const toNum = (v, dflt) => {
    const x = val(v);
    if (typeof x === 'number') return num(x, dflt);
    if (x == null || x === '') return dflt;
    const n = parseFloat(x);
    return finite(n) ? n : dflt;
  };

  /* ================= source kinds ================= */

  /* The five Arena input sources plus `live`. `live` is not an Input Source
     dropdown entry in Arena — a webcam is a composition SOURCE that you drag
     into a clip. It is here because a browser clone has no Spout and no capture
     card, so getUserMedia is the only way a real camera reaches a slice at all,
     and pretending otherwise would just push the problem into the UI. Every
     `live` source carries cloneOnly:true so nothing mistakes it for Arena. */
  const SOURCE_KINDS = ['composition', 'layer', 'group', 'preview', 'screen', 'live'];
  const KIND_SET = SOURCE_KINDS.reduce((m, k) => (m[k] = true, m), {});

  const COMPOSITION_ID = 'composition';
  const PREVIEW_ID = 'preview';
  const DEFAULT_SOURCE = { kind: 'composition', id: COMPOSITION_ID };
  const DEFAULT_OPTS = { ignoreOpacity: false, ignoreBypassSolo: false };

  /* ================= the effect ledger =================
     Nine stages, in pipeline order. EVERY resolve() result carries all nine as
     booleans — see the header. `notApplied` is derived from the ledger rather
     than written by hand so the two can never disagree. */
  const EFFECT_KEYS = [
    'clipTransform',        /* the clip's own position/scale/rotation */
    'clipEffects',          /* the clip's effect chain */
    'layerEffects',         /* the layer's effect chain */
    'layerOpacity',         /* the layer/group Opacity (Video) fader */
    'layerBypassSolo',      /* the layer Bypass button and the comp Solo state */
    'layerBlendMode',       /* the layer's blend against what is under it */
    'groupEffects',         /* a group's own effect chain and internal mix */
    'compositionEffects',   /* the composition effect chain */
    'compositionMaster'     /* comp master opacity / bypass */
  ];
  function ledger(over) {
    const out = {};
    for (const k of EFFECT_KEYS) out[k] = bool(over && over[k]);
    return Object.freeze(out);
  }
  const notAppliedFrom = led => EFFECT_KEYS.filter(k => !led[k]);

  /* ================= declared-but-unavailable transports =================
     Arena reaches these natively. A browser cannot, and each one is impossible
     for a different reason, so each carries its own reason string rather than a
     shared "not supported". They appear in sources() with available:false; they
     are refused by setSliceInput() with the reason attached. Omitting them
     would make the clone look like Arena minus features nobody can name. */
  const UNAVAILABLE_TRANSPORTS = [
    {
      id: 'live:ndi', kind: 'live', transport: 'ndi', label: 'NDI Source',
      /* THIS USED TO STOP AT "needs the native tier", WHICH WAS TRUE AND
         MISLEADING. Direct NDI is genuinely out of reach — discovery is mDNS
         and the transport is NDI's own UDP protocol, and a browser has neither.
         But NDI ships a supported route that needs no new capability at all:
         NDI Webcam Input (NDI Tools for Windows) takes "any NDI video and audio
         signal on your network" and presents it to applications as a webcam, so
         it arrives as an ordinary capture device that enumerateDevices() lists
         and getUserMedia() opens — the path this app already has.

         Arena agrees, and that is measured rather than argued: the catalogue
         captured from a running Arena (extracted/live-catalog.json) files
         "NDI Webcam Video 1" through "NDI Webcam Video 4" under category
         "Capture Devices", not under NDI. Those four are NDI Webcam Input's
         virtual cameras on the machine that capture was taken from.

         So the entry states both: what cannot be done, and the route that can. */
      reason: 'Direct NDI cannot be discovered here. NDI announces itself over mDNS and carries '
            + 'frames on its own UDP transport, and a browser has neither. That part needs a '
            + 'native helper bridging NDI to WebRTC or MSE. '
            + 'BUT NDI DOES REACH THIS APP ANOTHER WAY: run NDI Webcam Input (NDI Tools for '
            + 'Windows) and point it at the NDI source. It presents that source to every '
            + 'application as a webcam, so it appears under Capture Devices above and can be '
            + 'dropped straight into a clip. Arena treats those the same way; its own catalogue '
            + 'files "NDI Webcam Video 1..4" under Capture Devices.',
      route: 'ndi-webcam-input'
    },
    {
      id: 'live:spout', kind: 'live', transport: 'spout', label: 'Spout Sender (Windows)',
      reason: 'Spout shares a DirectX texture handle between processes on one machine. ' +
              'There is no web API for a shared GPU handle.'
    },
    {
      id: 'live:syphon', kind: 'live', transport: 'syphon', label: 'Syphon Server (macOS)',
      reason: 'Syphon shares an IOSurface between processes. There is no web API for it.'
    },
    {
      id: 'live:capture-card', kind: 'live', transport: 'capture', label: 'Blackmagic / AJA / Datapath (native)',
      reason: 'The native path is a vendor SDK reading the card directly. A card that ships a ' +
              'WDM/DirectShow driver still appears under Camera / Capture below, but that is the ' +
              'CPU path the native one exists to avoid.'
    }
  ];

  /* Configuration ownership for third-party inputs. This is deliberately a
     capability ledger, not a fabricated sender list. It lets every UI surface
     distinguish settings this browser can apply from settings that live in an
     external bridge/native runtime. The ISF entry is especially important:
     the shipped Wire examples prove ISF is a shader node/resource with dynamic
     inputs, not a capture Source, and this app has no ISF compiler/runtime. */
  const INPUT_CONFIGURATION_SURFACES = [
    {
      id:'browser-capture', role:'live-source', available:true,
      owner:'MediaStreamTrack',
      controls:['Current Format','Width','Height','Frame Rate','Resize Mode'],
      evidence:'getCapabilities/getSettings/applyConstraints'
    },
    {
      id:'ndi', role:'live-source-bridge', available:'via-camera',
      owner:'NDI Webcam Input', controls:['NDI Source'],
      reason:'Direct NDI discovery/transport needs mDNS and native UDP; the bridge appears as a Capture Device.'
    },
    {
      id:'spout', role:'live-source', platform:'windows', available:false,
      owner:'native Spout receiver', controls:['Sender'],
      reason:'A browser cannot open the shared DirectX texture handle.'
    },
    {
      id:'syphon', role:'live-source', platform:'macos', available:false,
      owner:'native Syphon receiver', controls:['Server'],
      reason:'A browser cannot open the shared IOSurface.'
    },
    {
      id:'isf', role:'wire-shader-resource', source:false, available:false,
      owner:'Wire ISF node', controls:['ISF Resource','shader-declared inputs'],
      reason:'Local evidence defines an ISF Wire node/resource, but this app has no ISF GLSL compiler/runtime.'
    }
  ];

  /* ================= output device catalog =================
     One entry per kind Arena actually has (kinds verified as binary strings).
     `exclusive` is Arena's "every output can only have a single screen
     associated with it" — it is true only where a real piece of hardware is
     behind the device. Virtual outputs are per-screen internal buffers, DMX
     screens are separate Lumiverses sharing one deviceId, and Spout/NDI senders
     are named per screen, so none of those three collide. */
  const DEVICE_KINDS = [
    { kind: 'OutputDeviceVirtual', label: 'Virtual', browserFeasible: true, exclusive: false,
      note: 'An offscreen render target. This is what a screen routed into another screen reads.' },
    { kind: 'OutputDeviceDisplay', label: 'Display / Projector', browserFeasible: true, exclusive: true,
      note: 'A fullscreen window on a second display. No exclusive ownership, no EDID, no refresh control.' },
    { kind: 'OutputDeviceSnapshot', label: 'Snapshot (PNG)', browserFeasible: true, exclusive: false,
      note: 'canvas.toBlob. Arena writes it to the Recordings folder.' },
    { kind: 'OutputDeviceComponent', label: 'Monitor / Preview Pane', browserFeasible: true, exclusive: false,
      note: 'Binary-only kind; renders a screen into a UI component. Just another canvas here.' },
    { kind: 'OutputDeviceNDI', label: 'NDI', browserFeasible: false, exclusive: false,
      note: 'Every NDI screen is its own NDI source. Proprietary UDP + mDNS; needs a native sender.' },
    { kind: 'OutputDeviceSpout', label: 'Spout / Syphon', browserFeasible: false, exclusive: false,
      note: 'Shared GPU texture handle between processes. No web API.' },
    { kind: 'OutputDeviceCapture', label: 'Playback Card', browserFeasible: false, exclusive: true,
      note: 'Blackmagic / Datapath / AJA, Arena only. Vendor SDK.' },
    { kind: 'OutputDeviceDmx', label: 'Lumiverse (Art-Net)', browserFeasible: false, exclusive: false,
      note: 'Art-Net is UDP; a browser has no UDP socket. Needs a WebSocket-to-UDP bridge.' },
    /* OpenLive extension. streaming.htm's first sentence is that Resolume cannot
       stream, so there is no Arena literal to match — this kind is ours and is
       badged as such wherever it appears.
       browserFeasible is TRUE because the honest answer is per-transport, not
       per-device: WHIP and File work in the tab today, RTMP and SRT need the
       local helper. Marking the whole device infeasible would grey a control
       that does work; the per-transport reasons live on the Broadcast's
       Destination row instead, where the choice is actually made. */
    { kind: 'OutputDeviceStream', label: 'Broadcast', browserFeasible: true, exclusive: false,
      note: 'An encode raster. WHIP and local file work in this tab; RTMP and SRT need ' +
            'the local helper (devserver.py) because a browser has no raw TCP or UDP socket.' }
  ];
  const DEVICE_BY_KIND = DEVICE_KINDS.reduce((m, d) => (m[d.kind] = d, m), {});

  /* OutputDevice subclasses carry their mode as native XML attributes. Capture
     cards in particular need fields such as videoFormat/port/pixelFormat, and
     future native builds may add more. Routing used to whitelist six common
     fields, so a harmless assign/save/reload silently erased every subclass
     attribute. Preserve scalar attributes generically while keeping routing's
     own envelope and OpenLive's follow policy out of Arena's native bag. */
  const DEVICE_META_KEYS = Object.freeze({
    kind: true, screenId: true, followComposition: true,
    module: true, version: true, assignedTo: true, assignedToName: true,
    browserFeasible: true, exclusive: true, available: true, reason: true,
    warnings: true, demoted: true, template: true, note: true, attrs: true
  });
  function outputDeviceAttrs(device) {
    const src = device || {}, out = {};
    for (const key of Object.keys(src)) {
      if (DEVICE_META_KEYS[key]) continue;
      const value = src[key];
      if (value == null || typeof value === 'function' || typeof value === 'object') continue;
      out[key] = str(value);
    }
    return out;
  }

  /* ================= composition provider =================
     Where the layers and groups come from. ArenaLive first because when a real
     Arena is connected its tree is the authority; the hub second because that is
     the clone's own state; nothing third, which yields an empty source list, not
     a crash. A caller with its own model calls setCompositionProvider(). */
  function normEntry(raw, index, kind) {
    const r = raw || {};
    const id = str(r.id != null ? r.id : r.uniqueId != null ? r.uniqueId : index + 1);
    const name = str(val(r.name) || '') || (kind === 'group' ? 'Group ' : 'Layer ') + (index + 1);
    /* Arena exposes video.opacity 0..1; a bare `opacity` is accepted for models
       that flattened it. Absent means fully open, not silent. */
    const opacity = clamp01(toNum(r.video && r.video.opacity, toNum(r.opacity, 1)));
    return {
      kind: kind,
      id: id,
      index: index,
      number: index + 1,
      name: name,
      opacity: opacity,
      /* Arena's REST field is `bypassed`; the hub writes `bypass`. Both read. */
      bypassed: bool(val(r.bypassed) != null ? val(r.bypassed) : val(r.bypass)),
      solo: bool(val(r.solo)),
      master: clamp01(toNum(r.master, 1))
    };
  }
  function readList(list, kind) {
    return (Array.isArray(list) ? list : []).map((raw, i) => normEntry(raw, i, kind));
  }
  function defaultCompositionProvider() {
    try {
      const AL = window.ArenaLive;
      if (AL && typeof AL.layers === 'function') {
        const ls = AL.layers();
        if (ls && ls.length) {
          return {
            origin: 'ArenaLive',
            layers: readList(ls, 'layer'),
            groups: readList(typeof AL.groups === 'function' ? AL.groups() : [], 'group')
          };
        }
      }
    } catch (e) { /* a disconnected Arena is not an error here */ }
    try {
      const hub = window.OpenLiveHub;
      if (hub && typeof hub.get === 'function') {
        const layers = hub.get('composition.layers', []);
        const groups = hub.get('composition.groups', []);
        if ((layers && layers.length) || (groups && groups.length)) {
          return { origin: 'OpenLiveHub', layers: readList(layers, 'layer'), groups: readList(groups, 'group') };
        }
      }
    } catch (e) { /* ditto */ }
    return { origin: 'none', layers: [], groups: [] };
  }

  /* ================= live inputs =================
     The only DOM this file touches, and only when asked. enumerateDevices()
     returns empty labels until a getUserMedia permission has been granted once,
     so `labelled` is reported rather than papered over — a UI that shows
     "Camera 1, Camera 2" when it could show real names looks broken. */
  const live = {
    devices: [],
    probedAt: 0,
    labelled: false,
    error: null,
    /* 'granted' | 'prompt' | 'denied' | 'unknown'. THIS IS THE DIFFERENCE
       BETWEEN AN ACTION AND A DEAD END, and without it the deck was offering
       the wrong one. Measured on this page: enumerateDevices() reports the
       videoinput but with label "", deviceId "" and groupId "" — Chrome
       withholds all three — while permissions.query({name:'camera'}) says
       "denied". In that state getUserMedia rejects immediately and NO PROMPT IS
       EVER SHOWN, so a row reading "Ask the browser for camera access once"
       promises something that cannot happen. Three states, three behaviours. */
    permission: 'unknown',
    watching: false,
    streams: new Map(),           /* sourceId -> MediaStream, so release() can stop tracks */
    capturePreferences: new Map(),
    capturePreferencesLoaded: false,
    capturePreferencesPersistent: true,
    capturePreferencesError: null
  };

  /* Browser capture controls are device preferences, not generator
     Parameters. MediaStreamTrack is the authority for both the available
     ranges and the format that was actually negotiated; the UI must never
     manufacture a list of camera modes from a width/height range. Preferences
     therefore store only requests, while getSettings() reports the result. */
  const CAPTURE_PREFERENCES_KEY = 'openlive.capture.constraints.v1';
  const CAPTURE_NUMERIC_FIELDS = ['width', 'height', 'frameRate', 'aspectRatio'];
  const CAPTURE_STRING_FIELDS = ['resizeMode', 'facingMode'];
  const safeStorage = () => {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch (e) { return null; }
  };
  function normaliseCaptureRequest(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    for (const key of CAPTURE_NUMERIC_FIELDS) {
      if (input[key] == null || input[key] === '') continue;
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value <= 0) continue;
      out[key] = (key === 'width' || key === 'height') ? Math.round(value) : value;
    }
    for (const key of CAPTURE_STRING_FIELDS) {
      if (input[key] == null || input[key] === '') continue;
      const value = String(input[key]).slice(0, 128);
      if (value) out[key] = value;
    }
    return out;
  }
  function loadCapturePreferences() {
    if (live.capturePreferencesLoaded) return;
    live.capturePreferencesLoaded = true;
    const storage = safeStorage();
    if (!storage) {
      live.capturePreferencesPersistent = false;
      live.capturePreferencesError = 'localStorage is unavailable; capture settings are session-only.';
      return;
    }
    try {
      const parsed = JSON.parse(storage.getItem(CAPTURE_PREFERENCES_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      Object.keys(parsed).slice(0, 256).forEach(id => {
        if (id === '__proto__' || id === 'prototype' || id === 'constructor') return;
        const request = normaliseCaptureRequest(parsed[id]);
        if (Object.keys(request).length) live.capturePreferences.set(id, request);
      });
    } catch (e) {
      live.capturePreferencesPersistent = false;
      live.capturePreferencesError = 'Saved capture settings could not be read: ' +
        (e && e.message ? e.message : String(e));
    }
  }
  function writeCapturePreferences() {
    const storage = safeStorage();
    if (!storage) {
      live.capturePreferencesPersistent = false;
      live.capturePreferencesError = 'localStorage is unavailable; capture settings are session-only.';
      return false;
    }
    const record = {};
    live.capturePreferences.forEach((request, id) => { record[id] = normaliseCaptureRequest(request); });
    try {
      storage.setItem(CAPTURE_PREFERENCES_KEY, JSON.stringify(record));
      live.capturePreferencesPersistent = true;
      live.capturePreferencesError = null;
      return true;
    } catch (e) {
      live.capturePreferencesPersistent = false;
      live.capturePreferencesError = 'Capture settings could not be saved: ' +
        (e && e.message ? e.message : String(e));
      return false;
    }
  }
  function savedLiveConstraints(sourceId) {
    loadCapturePreferences();
    const request = live.capturePreferences.get(str(sourceId));
    return request ? Object.assign({}, request) : {};
  }
  function rememberLiveConstraints(sourceId, request) {
    const id = str(sourceId), clean = normaliseCaptureRequest(request);
    loadCapturePreferences();
    if (Object.keys(clean).length) live.capturePreferences.set(id, clean);
    else live.capturePreferences.delete(id);
    const persistent = writeCapturePreferences();
    return { request: Object.assign({}, clean), persistent,
             persistenceError: live.capturePreferencesError };
  }

  function videoTrack(stream) {
    if (!stream) return null;
    try {
      const tracks = typeof stream.getVideoTracks === 'function'
        ? stream.getVideoTracks() : (typeof stream.getTracks === 'function' ? stream.getTracks() : []);
      return (tracks || []).find(track => !track || !track.kind || track.kind === 'video') || null;
    } catch (e) { return null; }
  }
  function copyRange(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const min = Number(value.min), max = Number(value.max);
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  }
  function captureTrackInfo(track) {
    let rawCapabilities = {}, rawSettings = {}, rawConstraints = {};
    try { if (track && typeof track.getCapabilities === 'function') rawCapabilities = track.getCapabilities() || {}; }
    catch (e) { /* capability reads are optional */ }
    try { if (track && typeof track.getSettings === 'function') rawSettings = track.getSettings() || {}; }
    catch (e) { /* settings reads are optional */ }
    try { if (track && typeof track.getConstraints === 'function') rawConstraints = track.getConstraints() || {}; }
    catch (e) { /* constraints reads are optional */ }
    const capabilities = {};
    for (const key of CAPTURE_NUMERIC_FIELDS) {
      const range = copyRange(rawCapabilities[key]);
      if (range) capabilities[key] = range;
    }
    for (const key of CAPTURE_STRING_FIELDS) {
      const list = rawCapabilities[key];
      if (Array.isArray(list)) capabilities[key] = list.map(String).slice(0, 64);
    }
    const settings = {};
    for (const key of CAPTURE_NUMERIC_FIELDS) {
      const value = Number(rawSettings[key]);
      if (Number.isFinite(value)) settings[key] = value;
    }
    for (const key of CAPTURE_STRING_FIELDS) {
      if (rawSettings[key] != null) settings[key] = String(rawSettings[key]);
    }
    const constraints = {};
    [...CAPTURE_NUMERIC_FIELDS, ...CAPTURE_STRING_FIELDS].forEach(key => {
      const value = rawConstraints[key];
      if (value == null) return;
      if (typeof value === 'object') {
        const copy = {};
        ['exact', 'ideal', 'min', 'max'].forEach(part => {
          if (value[part] != null && (typeof value[part] !== 'object')) copy[part] = value[part];
        });
        if (Object.keys(copy).length) constraints[key] = copy;
      } else constraints[key] = value;
    });
    return {
      capabilities, settings, constraints,
      canApplyConstraints: !!(track && typeof track.applyConstraints === 'function'),
      readyState: track && track.readyState || null,
      muted: !!(track && track.muted)
    };
  }
  function liveCaptureInfo(sourceId) {
    const id = str(sourceId), stream = live.streams.get(id) || null;
    const info = captureTrackInfo(videoTrack(stream));
    info.id = id;
    info.open = !!stream;
    info.request = savedLiveConstraints(id);
    info.persistent = live.capturePreferencesPersistent;
    info.persistenceError = live.capturePreferencesError;
    return info;
  }
  function constraintBag(request) {
    const clean = normaliseCaptureRequest(request), out = {};
    Object.keys(clean).forEach(key => { out[key] = { exact: clean[key] }; });
    return out;
  }
  function initialVideoConstraints(dev, request) {
    const out = {};
    if (dev && dev.deviceId) out.deviceId = { exact: dev.deviceId };
    Object.assign(out, constraintBag(request));
    return Object.keys(out).length ? out : true;
  }

  /* WHY THE CAMERA IS UNAVAILABLE, WHICH IS NOT ONE QUESTION BUT THREE.
     "denied" alone is not enough to tell an operator what to do, and guessing
     the remedy sends them to the wrong place. Measured on this page:

       document.featurePolicy.allowsFeature('camera')  true
       getAllowlistForFeature('camera')                ["http://localhost:8090"]
       permissions.query({name:'camera'})              "denied"
       window.top === window.self                      true (not framed)
       navigator.userAgent                             "... Claude/1.26832.0 Chrome/148 ..."

     So the PAGE is allowed the camera and the ORIGIN is refused it, in an
     embedded application webview that has no address bar and therefore no
     camera icon to click. Telling that operator to "unblock it in the address
     bar" — which an earlier version of this did — names a control that does not
     exist in the window they are looking at.

     The three causes need three different sentences:
       policy       an enclosing frame withheld the camera feature; the page
                    cannot ask at all, whatever the user wants
       origin       the user, or the host application, refused this origin
       no-ui        refused in a shell that exposes no way to change it, so the
                    only remedy is to open the same URL in a normal browser
     `embedded` is a hint and is reported as one — a webview is detectable by
     its user agent but that is a heuristic, not a capability test, so the
     wording offers it as the likely case rather than asserting it. */
  /* A virtual camera is a bridge from some other transport, and naming which
     one turns "a camera I do not recognise" into "my NDI feed". Patterns are
     read off real device names, not guessed: NDI Webcam Input registers
     "NDI Webcam Video 1".."4" (four of them, which is why Arena's captured
     catalogue has exactly four), OBS registers "OBS Virtual Camera". */
  const VIRTUAL_SOURCES = [
    { re: /\bNDI\b/i,                    via: 'NDI',
      note: 'An NDI source arriving through NDI Webcam Input. Choose which NDI stream it '
          + 'carries in the NDI Webcam Input tool; this app sees whatever that is set to.' },
    { re: /\bOBS\b.*virtual|virtual.*\bOBS\b/i, via: 'OBS',
      note: 'OBS Studio\'s virtual camera: whatever OBS is currently outputting.' },
    { re: /\bvirtual\b/i,                via: 'Virtual',
      note: 'A virtual camera registered by another application, not physical hardware.' }
  ];
  function virtualSourceOf(label) {
    if (!label) return null;                 /* no label yet — say nothing */
    for (const v of VIRTUAL_SOURCES) if (v.re.test(label)) return { via: v.via, note: v.note };
    return null;
  }

  function isEmbeddedShell() {
    try {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      return /\b(Electron|Claude)\/[\d.]+/.test(ua);
    } catch (e) { return false; }
  }
  function policyAllowsCamera() {
    try {
      const fp = document.featurePolicy || document.permissionsPolicy;
      return fp && typeof fp.allowsFeature === 'function' ? fp.allowsFeature('camera') : null;
    } catch (e) { return null; }
  }
  /* The structured answer the deck prints. Never asserts a remedy it cannot
     stand behind. */
  function cameraDiagnosis() {
    const state = live.permission;
    const allowed = policyAllowsCamera();
    const embedded = isEmbeddedShell();
    if (state === 'granted') return { state, allowed, embedded, cause: 'ok', remedy: null };
    if (state === 'prompt' || state === 'unknown')
      return { state, allowed, embedded, cause: 'ask',
               remedy: 'One click grants it for this site and the names fill in.' };
    if (allowed === false)
      return { state, allowed, embedded, cause: 'policy',
               remedy: 'The page is running inside a frame whose Permissions-Policy withholds the '
                     + 'camera feature, so it cannot even ask. That is set by whatever embeds this '
                     + 'page, not by a site setting.' };
    return { state, allowed, embedded, cause: embedded ? 'no-ui' : 'origin',
             remedy: embedded
               ? 'This looks like an embedded application window. It has no address bar, so there '
                 + 'is no camera icon to allow it with and the browser will never prompt. Open '
                 + location.origin + ' in a normal browser window and the names appear there.'
               : 'Camera access was refused for ' + location.origin + ', so the browser will not '
                 + 'prompt again. Allow it from the camera icon in the address bar, or in the '
                 + "site's permission settings, and this list names the devices on its own." };
  }

  /* Read the camera permission WITHOUT prompting. permissions.query is the only
     way to know 'denied' from 'prompt' before asking, and asking when the answer
     is already 'denied' is what produced a button that silently did nothing.
     Firefox does not accept the 'camera' descriptor, hence the catch. */
  function readCameraPermission() {
    try {
      if (typeof navigator === 'undefined' || !navigator.permissions ||
          typeof navigator.permissions.query !== 'function') return Promise.resolve('unknown');
      return navigator.permissions.query({ name: 'camera' })
        .then(st => {
          live.permission = st.state;
          /* A grant made in another tab, or revoked from the omnibox, changes
             this without any devicechange firing. Re-probe on it, which is what
             makes names appear on their own the moment access is allowed. */
          if (!st.__olWired) {
            st.__olWired = true;
            try { st.onchange = () => { live.permission = st.state; probeLiveInputs(); }; }
            catch (e) { /* older implementations expose no onchange */ }
          }
          return st.state;
        }, () => 'unknown');
    } catch (e) { return Promise.resolve('unknown'); }
  }

  /* live-inputs.htm: "All the devices connected to your computer will be listed
     here." Resolume notices a camera being plugged in; a one-shot enumerate at
     load does not. devicechange is the browser's own signal for exactly that,
     and it costs nothing until it fires. Attached once, idempotently. */
  function watchLiveInputs(onChange) {
    if (live.watching) return;
    const md = mediaDevices();
    if (!md || typeof md.addEventListener !== 'function') return;
    live.watching = true;
    md.addEventListener('devicechange', () => {
      probeLiveInputs().then(() => { if (typeof onChange === 'function') onChange(); });
    });
  }

  const mediaDevices = () => {
    try {
      return (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;
    } catch (e) { return null; }
  };

  /* Declared unconditionally: Arena solves "another app's output on this
     machine" with Spout/Syphon, and a browser's nearest equivalent is display
     capture. It has no Arena counterpart, hence cloneOnly. */
  const DISPLAY_CAPTURE = {
    id: 'live:display', kind: 'live', transport: 'display', label: 'Screen / Window Capture',
    cloneOnly: true, available: true,
    reason: 'getDisplayMedia. Not a Resolume source; the browser stand-in for Spout/Syphon and HDMI capture.'
  };
  const POWERPOINT_CAPTURE = {
    id: 'live:powerpoint', kind: 'live', transport: 'display', label: 'Presentation window',
    cloneOnly: true, available: true, presentation: true,
    reason: 'Optional capture of any presentation window. Imported PowerPoint files play directly inside OpenLive without Office.'
  };

  function probeLiveInputs() {
    const md = mediaDevices();
    if (!md || typeof md.enumerateDevices !== 'function') {
      live.error = 'navigator.mediaDevices.enumerateDevices is unavailable (needs a secure context).';
      live.devices = [];
      live.probedAt = Date.now();
      return Promise.resolve(liveInputs());
    }
    readCameraPermission();          /* in parallel; never blocks the listing */
    return md.enumerateDevices().then(list => {
      const vids = (list || []).filter(d => d && d.kind === 'videoinput');
      live.devices = vids.map((d, i) => ({
        id: 'live:' + (d.deviceId || 'device' + i),
        deviceId: d.deviceId || '',
        groupId: d.groupId || '',
        kind: 'live',
        transport: 'usermedia',
        label: d.label || 'Camera / Capture ' + (i + 1),
        /* WHAT KIND OF CAMERA THIS ACTUALLY IS. A virtual camera is a bridge
           from something else — NDI Webcam Input turns an NDI source into one,
           OBS turns a scene into one — and an operator hunting for their NDI
           feed should not have to guess which "camera" is it.
           The naming is not invented: the catalogue captured from a running
           Arena lists "NDI Webcam Video 1".."NDI Webcam Video 4" and "OBS
           Virtual Camera", all under category "Capture Devices".
           ONLY WORKS ONCE LABELS ARE VISIBLE. Before a permission grant every
           label is "", so `via` is null and the row says nothing rather than
           guessing — the same rule the name-hiding row follows. */
        via: virtualSourceOf(d.label || ''),
        available: true
      }));
      live.labelled = vids.some(d => !!d.label);
      live.error = null;
      live.probedAt = Date.now();
      return liveInputs();
    }, err => {
      live.error = 'enumerateDevices failed: ' + (err && err.message ? err.message : String(err));
      live.devices = [];
      live.probedAt = Date.now();
      return liveInputs();
    });
  }

  function liveInputs() {
    const out = live.devices.slice();
    out.push(Object.assign({}, POWERPOINT_CAPTURE));
    out.push(Object.assign({}, DISPLAY_CAPTURE));
    for (const u of UNAVAILABLE_TRANSPORTS) out.push(Object.assign({ available: false }, u));
    return out;
  }
  const liveById = id => liveInputs().find(d => d.id === str(id)) || null;

  /* Acquiring is separate from routing on purpose: a slice can be routed to a
     camera that is not open yet, exactly as an Arena slice can point at a layer
     with no clip in it. The route is intent; the stream is a resource. */
  function acquireLive(sourceId, constraints) {
    const id = str(sourceId);
    const dev = liveById(id);
    if (!dev) return Promise.reject(new Error('OpenLiveRouting: unknown live input ' + id));
    if (dev.available === false) return Promise.reject(new Error('OpenLiveRouting: ' + dev.label + ': ' + dev.reason));
    const md = mediaDevices();
    if (!md) return Promise.reject(new Error('OpenLiveRouting: navigator.mediaDevices is unavailable.'));
    const held = live.streams.get(id);
    if (held) return Promise.resolve(held);
    const request = dev.transport === 'display' ? {} : savedLiveConstraints(id);
    const displayRequest = dev.presentation ? {
      video: { displaySurface: 'window' }, audio: true,
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
    } : { video: true, audio: true };
    const p = dev.transport === 'display'
      ? (typeof md.getDisplayMedia === 'function'
          ? md.getDisplayMedia(constraints || displayRequest)
          : Promise.reject(new Error('OpenLiveRouting: getDisplayMedia is unavailable.')))
      : md.getUserMedia(constraints || { video: initialVideoConstraints(dev, request), audio: false });
    return p.then(stream => {
      live.streams.set(id, stream);
      /* Arena's own constraint, and the OS enforces it either way: one
         application at a time owns a capture device. If Arena holds the card,
         this rejects — that is information, not a failure to hide. */
      return stream;
    });
  }
  function applyLiveConstraints(sourceId, request) {
    const id = str(sourceId), dev = liveById(id), stream = live.streams.get(id);
    if (!dev) return Promise.reject(new Error('OpenLiveRouting: unknown live input ' + id));
    if (!stream) return Promise.reject(new Error('OpenLiveRouting: live input is not open: ' + id));
    const track = videoTrack(stream);
    if (!track) return Promise.reject(new Error('OpenLiveRouting: live input has no video track.'));
    if (typeof track.applyConstraints !== 'function')
      return Promise.reject(new Error('OpenLiveRouting: this browser cannot change capture constraints.'));
    const clean = normaliseCaptureRequest(request);
    return Promise.resolve(track.applyConstraints(constraintBag(clean))).then(() => {
      /* Display capture is a fresh user-selected surface every time. Its
         settings are session state and must not silently constrain the next
         screen/window the operator chooses. Camera device ids are stable
         enough for a per-device preference after permission has been granted. */
      const persistence = dev.transport === 'display'
        ? { request:clean, persistent:false, persistenceError:'Display capture settings are session-only.' }
        : rememberLiveConstraints(id, clean);
      const info = liveCaptureInfo(id);
      info.request = Object.assign({}, clean);
      info.persistent = persistence.persistent;
      info.persistenceError = persistence.persistenceError;
      return info;
    });
  }
  function clearLiveConstraints(sourceId) {
    const id = str(sourceId), dev = liveById(id), stream = live.streams.get(id);
    if (!dev) return Promise.reject(new Error('OpenLiveRouting: unknown live input ' + id));
    /* A saved exact request can become invalid after a driver/device change and
       make getUserMedia reject before there is a track to reset. Clearing the
       stored request must therefore work while closed as well as while open;
       otherwise one stale preference permanently bricks the Source UI. */
    if (!stream) {
      const persistence = dev.transport === 'display'
        ? { request:{}, persistent:false, persistenceError:'Display capture settings are session-only.' }
        : rememberLiveConstraints(id, {});
      const info = liveCaptureInfo(id);
      info.request = {};
      info.persistent = persistence.persistent;
      info.persistenceError = persistence.persistenceError;
      return Promise.resolve(info);
    }
    return applyLiveConstraints(id, {});
  }
  function releaseLive(sourceId) {
    const id = str(sourceId);
    const s = live.streams.get(id);
    if (!s) return false;
    try { (s.getTracks() || []).forEach(t => t.stop()); } catch (e) { /* already gone */ }
    live.streams.delete(id);
    return true;
  }

  /* ================= surface lookup =================
     frameContext bags may be a plain object keyed by id, a Map, an array, or a
     function. Layers in Arena are talked about 1-based ("Layer 3"), so an array
     is read 1-based first and 0-based second rather than guessing once. */
  function pick(bag, id) {
    if (bag == null) return undefined;
    if (typeof bag === 'function') return bag(id);
    if (typeof Map !== 'undefined' && bag instanceof Map) {
      if (bag.has(id)) return bag.get(id);
      const n = Number(id);
      return finite(n) && bag.has(n) ? bag.get(n) : undefined;
    }
    if (Array.isArray(bag)) {
      const n = Number(id);
      if (!finite(n)) return undefined;
      if (bag[n - 1] !== undefined) return bag[n - 1];
      return bag[n];
    }
    if (typeof bag === 'object') {
      if (has(bag, id)) return bag[id];
      const n = Number(id);
      if (finite(n) && has(bag, n)) return bag[n];
    }
    return undefined;
  }

  /* ================= cycle detection =================
     Elementary circuits by canonical DFS: from each start node, walk only nodes
     whose index is >= the start's, and record a circuit when the walk returns to
     the start. Each elementary cycle is therefore emitted exactly once, in its
     lowest-index rotation, and A->B->A and A->B->C->A both fall out of the same
     loop. Self-routes (A->A) appear as a length-1 cycle.

     Both caps are load-bearing, not decoration: this enumeration is exponential
     in the worst case, and the single thing this module must never do is hang
     the app while looking for a way the app could hang. */
  const MAX_CYCLES = 512;
  const MAX_DEPTH = 256;
  /* MAX_CYCLES bounds cycles FOUND and MAX_DEPTH bounds path LENGTH — neither
     bounds the number of simple paths EXPLORED, and that count is exponential in
     a dense graph. A wide acyclic mesh therefore finds no cycles, never grows a
     long path, and still runs effectively forever: both caps stay unhit while
     the walk enumerates every path. Screens are user-authored, so a pathological
     graph is a couple of clicks away.

     MAX_WORK is the only cap that actually bounds runtime. It counts edges
     considered, so it is proportional to real work regardless of graph shape.
     Hitting it sets truncated, and every caller already treats truncated as
     "assume there may be a cycle I did not prove" rather than "clean". */
  const MAX_WORK = 200000;
  function elementaryCycles(nodes, edgesOf) {
    const index = new Map();
    nodes.forEach((n, i) => index.set(n, i));
    const cycles = [];
    const path = [];
    const onPath = new Set();
    let truncated = false;
    let work = 0;

    function walk(start, v) {
      if (cycles.length >= MAX_CYCLES || path.length >= MAX_DEPTH || work >= MAX_WORK) {
        truncated = true; return;
      }
      path.push(v);
      onPath.add(v);
      const out = edgesOf(v) || [];
      for (const w of out) {
        if (++work >= MAX_WORK) { truncated = true; break; }
        if (!index.has(w)) continue;
        if (index.get(w) < index.get(start)) continue;      /* canonical rotation only */
        if (w === start) {
          cycles.push(path.slice());
          if (cycles.length >= MAX_CYCLES) { truncated = true; break; }
        } else if (!onPath.has(w)) {
          walk(start, w);
          if (cycles.length >= MAX_CYCLES || work >= MAX_WORK) { truncated = true; break; }
        }
      }
      path.pop();
      onPath.delete(v);
    }

    for (const s of nodes) {
      if (cycles.length >= MAX_CYCLES || work >= MAX_WORK) { truncated = true; break; }
      walk(s, s);
    }
    return { cycles: cycles, truncated: truncated };
  }

  /* An error type rather than a bare throw, so a caller can catch precisely the
     cyclic case and show the loop instead of a stack trace. */
  function CycleError(cycles) {
    const e = new Error('OpenLiveRouting: screen routing contains a cycle: ' +
      cycles.map(c => c.join(' -> ') + ' -> ' + c[0]).join('; '));
    e.name = 'RoutingCycleError';
    e.cycles = cycles;
    return e;
  }

  /* ================= the graph ================= */
  function createGraph(options) {
    const opts = options || {};

    /* The setup is resolved on every access, never cached: OpenLiveScreens
       deserialize() mutates the live setup in place but a harness may hand us a
       different one, and a graph holding a stale setup routes to slices that no
       longer exist. */
    const setupRef = opts.setup != null ? opts.setup
      : () => (window.OpenLiveScreens ? window.OpenLiveScreens.setup() : null);
    const getSetup = () => {
      const s = typeof setupRef === 'function' ? setupRef() : setupRef;
      return s && Array.isArray(s.screensList) ? s : null;
    };

    let compositionProvider = typeof opts.compositionProvider === 'function'
      ? opts.compositionProvider : defaultCompositionProvider;

    /* routes: sliceId -> {source:{kind,id}, opts:{ignoreOpacity,ignoreBypassSolo}}
       Keyed by slice id and NOT stored on the slice objects, because those round
       trip to Arena's XML byte-for-byte and Arena has no element for an input
       source. Routes for slices that do not exist yet are kept, not dropped —
       deserialize() may well run before the screen setup is loaded, and losing
       a show's routing to a load-order accident is not acceptable. */
    const routes = new Map();

    /* 'refuse' rejects an assignment that would close a loop. 'allow' accepts it
       and lets order()/resolve() break the back edge onto the previous frame.
       Both are clone-defined; see the header. */
    let cyclePolicy = opts.cyclePolicy === 'allow' ? 'allow' : 'refuse';
    /* What order() does when a cycle exists anyway (a file loaded under 'allow',
       or edited elsewhere): exclude the tangled screens, throw, or break. */
    let cycleMode = /^(exclude|throw|break)$/.test(str(opts.cycleMode)) ? str(opts.cycleMode) : 'exclude';

    const listeners = new Set();
    let rev = 0;
    const changed = what => {
      rev++;
      analysis = null;
      listeners.forEach(fn => { try { fn(what, api); } catch (e) { /* a bad listener is not a bad graph */ } });
    };

    /* ---- model access ----
       THE NAMING TRAP LIVES HERE. `screen.layers` in openlive-screens.js is the
       array of that screen's SLICES — it is named after the XML element
       <layers>, which is what Arena writes. It has nothing to do with a
       composition layer, which in this file is a routable input SOURCE. This
       function and slicesOf() are the only two places screen.layers is read;
       everything downstream says slice. */
    function slicesOf(screenId) {
      const setup = getSetup();
      if (!setup) return [];
      const sc = setup.screenById(str(screenId));
      return sc ? sc.layers.slice() : [];        /* .layers === slices, see above */
    }
    function screens() {
      const setup = getSetup();
      return setup ? setup.screensList.slice() : [];
    }
    function sliceOf(sliceId) {
      const setup = getSetup();
      if (!setup) return null;
      const id = str(sliceId);
      for (const sc of setup.screensList) {
        for (const sl of sc.layers) if (sl.uniqueId === id) return sl;   /* .layers === slices */
      }
      return null;
    }
    function screenOfSlice(sliceId) {
      const setup = getSetup();
      if (!setup) return null;
      const id = str(sliceId);
      for (const sc of setup.screensList) {
        for (const sl of sc.layers) if (sl.uniqueId === id) return sc;
      }
      return null;
    }

    /* ---- sources ---- */
    function composition() {
      const c = compositionProvider();
      return c && typeof c === 'object'
        ? { origin: str(c.origin || 'provider'), layers: c.layers || [], groups: c.groups || [] }
        : { origin: 'none', layers: [], groups: [] };
    }

    function sources() {
      const comp = composition();
      const out = [{ id: COMPOSITION_ID, kind: 'composition', label: 'Show', available: true, isDefault: true }];
      for (const l of comp.layers) {
        out.push({ id: l.id, kind: 'layer', label: l.name, number: l.number, available: true, origin: comp.origin });
      }
      for (const g of comp.groups) {
        out.push({ id: g.id, kind: 'group', label: g.name, number: g.number, available: true, origin: comp.origin,
          note: 'Arena only. The blend-mode carve-out for groups is derived, not stated in the manual.' });
      }
      out.push({ id: PREVIEW_ID, kind: 'preview', label: 'Preview', available: true });
      for (const sc of screens()) {
        const dev = sc.outputDevice || {};
        out.push({
          id: sc.uniqueId, kind: 'screen', label: sc.name || 'Screen',
          deviceKind: str(dev.kind || ''), available: true,
          /* Routable whatever the device is: the texture we would hand to a
             slice is the one we rendered internally, so an NDI screen is a
             perfectly good SOURCE here even though its OUTPUT is not feasible. */
          note: 'Costs 0 or 1 frame of latency in Arena; may be 1 frame here when a back edge is broken.'
        });
      }
      for (const d of liveInputs()) {
        out.push({
          id: d.id, kind: 'live', label: d.label, transport: d.transport,
          available: d.available !== false, reason: d.reason || null,
          cloneOnly: d.cloneOnly === true || d.transport === 'usermedia' || d.transport === 'display'
        });
      }
      return out;
    }
    const sourceById = (kind, id) => sources().find(s => s.kind === str(kind) && s.id === str(id)) || null;

    /* ---- reading a route ---- */
    function normOpts(o) {
      const raw = o || {};
      /* Accept either polarity on input. inputOpacity is Arena's label and is
         the inverse; if a caller passes it, it wins over an absent ignore flag. */
      const ignoreOpacity = has(raw, 'ignoreOpacity') ? bool(raw.ignoreOpacity)
        : has(raw, 'inputOpacity') ? !bool(raw.inputOpacity) : false;
      const ignoreBypassSolo = has(raw, 'ignoreBypassSolo') ? bool(raw.ignoreBypassSolo)
        : has(raw, 'inputBypassSolo') ? !bool(raw.inputBypassSolo) : false;
      return { ignoreOpacity: ignoreOpacity, ignoreBypassSolo: ignoreBypassSolo };
    }
    /* The view a UI reads: both polarities, plus whether the toggles do anything
       at all for this source. sources.htm is explicit that they are inert unless
       the input is a layer or a group, and a UI that shows them live on a
       composition input is lying to the operator. */
    function optsView(o, kind) {
      const n = normOpts(o);
      return Object.freeze({
        ignoreOpacity: n.ignoreOpacity,
        ignoreBypassSolo: n.ignoreBypassSolo,
        inputOpacity: !n.ignoreOpacity,
        inputBypassSolo: !n.ignoreBypassSolo,
        effective: kind === 'layer' || kind === 'group'
      });
    }

    function sliceInput(sliceId) {
      const r = routes.get(str(sliceId));
      const src = r ? r.source : DEFAULT_SOURCE;
      return {
        source: { kind: src.kind, id: src.id },
        opts: optsView(r ? r.opts : DEFAULT_OPTS, src.kind),
        isDefault: !r
      };
    }

    /* ---- writing a route ---- */
    const refuse = (code, message, extra) =>
      Object.assign({ ok: false, error: code, message: message }, extra || {});

    /* Pre-flight for a UI: same checks as setSliceInput, no mutation. Returns
       {ok:true, warnings:[]} or a refusal with a readable message. */
    function canRoute(sliceId, sourceRef, o) {
      const sl = sliceOf(sliceId);
      if (!sl) return refuse('unknown-slice', 'No slice with id ' + str(sliceId) + '.');
      if (sourceRef == null) return { ok: true, warnings: [], source: Object.assign({}, DEFAULT_SOURCE) };

      const kind = str(sourceRef.kind || '');
      if (!KIND_SET[kind]) {
        return refuse('unknown-kind', 'Unknown source kind "' + kind + '". Expected one of ' + SOURCE_KINDS.join(', ') + '.');
      }
      const id = str(sourceRef.id != null ? sourceRef.id : (kind === 'composition' ? COMPOSITION_ID : kind === 'preview' ? PREVIEW_ID : ''));
      const warnings = [];

      if (kind === 'composition' || kind === 'preview') {
        const n = normOpts(o);
        if (n.ignoreOpacity || n.ignoreBypassSolo) {
          warnings.push('Input Opacity and Input Bypass/Solo are only functional when a layer or a group is the input (sources.htm). They are stored but inert here.');
        }
        return { ok: true, warnings: warnings, source: { kind: kind, id: kind === 'composition' ? COMPOSITION_ID : PREVIEW_ID } };
      }

      if (kind === 'layer' || kind === 'group') {
        const comp = composition();
        const list = kind === 'layer' ? comp.layers : comp.groups;
        if (!list.length) {
          /* An offline clone has no layer list. Refusing here would make every
             route un-settable while Arena is disconnected, so this warns. */
          warnings.push('No composition ' + kind + 's are visible (provider: ' + comp.origin + '). The route is stored unverified.');
        } else if (!list.some(x => x.id === id)) {
          return refuse('unknown-' + kind, 'No composition ' + kind + ' with id ' + id + ' (provider: ' + comp.origin + ').');
        }
        return { ok: true, warnings: warnings, source: { kind: kind, id: id } };
      }

      if (kind === 'live') {
        const dev = liveById(id);
        if (!dev) {
          return refuse('unknown-live-input', 'No live input ' + id + '. Call refreshLiveInputs() first. Devices are probed on demand, never at load.');
        }
        if (dev.available === false) {
          return refuse('unavailable-transport', dev.label + ' is declared but cannot be reached from a browser. ' + dev.reason,
            { reason: dev.reason, transport: dev.transport });
        }
        if (!live.labelled && dev.transport === 'usermedia') {
          warnings.push('Device labels are empty until a getUserMedia permission has been granted once.');
        }
        return { ok: true, warnings: warnings, source: { kind: 'live', id: id } };
      }

      /* kind === 'screen' */
      const setup = getSetup();
      const target = setup ? setup.screenById(id) : null;
      if (!target) return refuse('unknown-screen', 'No screen with id ' + id + '.');
      const own = screenOfSlice(sliceId);
      if (own && own.uniqueId === target.uniqueId) {
        /* slice-routing.htm offers "a slice in ANOTHER screen" and nothing else.
           A screen feeding itself is not a documented option, so it is refused
           rather than quietly turned into a feedback buffer. */
        return refuse('self-route', 'A screen cannot feed a slice of itself; the manual offers "a slice in another screen" only.');
      }
      if (cyclePolicy === 'refuse') {
        const loop = wouldCycle(own ? own.uniqueId : null, target.uniqueId);
        if (loop) {
          return refuse('cycle', 'That route would close a loop: ' + loop.join(' -> ') + ' -> ' + loop[0] + '.', { cycle: loop });
        }
      }
      return { ok: true, warnings: warnings, source: { kind: 'screen', id: id } };
    }

    /* Would adding consumer <- producer close a loop? Walk the EXISTING edges
       from the producer and see whether the consumer is reachable. Cheap, and it
       returns the actual path so the refusal can name the screens. */
    function wouldCycle(consumerScreenId, producerScreenId) {
      if (!consumerScreenId || !producerScreenId) return null;
      if (consumerScreenId === producerScreenId) return [consumerScreenId];
      const deps = dependencies();
      const seen = new Set();
      const stack = [[producerScreenId, [producerScreenId]]];
      while (stack.length) {
        const [node, path] = stack.pop();
        if (path.length > MAX_DEPTH) continue;
        for (const next of deps.get(node) || []) {
          if (next === consumerScreenId) return [consumerScreenId].concat(path);
          if (seen.has(next)) continue;
          seen.add(next);
          stack.push([next, path.concat(next)]);
        }
      }
      return null;
    }

    function setSliceInput(sliceId, sourceRef, o) {
      const check = canRoute(sliceId, sourceRef, o);
      if (!check.ok) return check;
      const id = str(sliceId);
      if (sourceRef == null) {
        routes.delete(id);
        changed('route');
        return { ok: true, warnings: check.warnings, sliceId: id, input: sliceInput(id) };
      }
      routes.set(id, { source: check.source, opts: normOpts(o) });
      changed('route');
      return { ok: true, warnings: check.warnings, sliceId: id, input: sliceInput(id) };
    }
    function clearSliceInput(sliceId) {
      const id = str(sliceId);
      const had = routes.delete(id);
      if (had) changed('route');
      return had;
    }
    /* Change the toggles without restating the source — the common UI gesture. */
    function setSliceInputOptions(sliceId, o) {
      const id = str(sliceId);
      const cur = routes.get(id);
      const src = cur ? cur.source : Object.assign({}, DEFAULT_SOURCE);
      const base = cur ? cur.opts : DEFAULT_OPTS;
      const patch = o || {};
      /* Resolve each switch from the patch when the patch mentions it in EITHER
         polarity, and only then fall back to what is stored. Object.assign of
         the raw objects would let a stale ignoreOpacity outvote an explicit
         inputOpacity — which is exactly the confusion this function exists to
         absorb, so it is spelled out rather than merged. */
      const next = {
        ignoreOpacity: has(patch, 'ignoreOpacity') ? bool(patch.ignoreOpacity)
          : has(patch, 'inputOpacity') ? !bool(patch.inputOpacity) : base.ignoreOpacity,
        ignoreBypassSolo: has(patch, 'ignoreBypassSolo') ? bool(patch.ignoreBypassSolo)
          : has(patch, 'inputBypassSolo') ? !bool(patch.inputBypassSolo) : base.ignoreBypassSolo
      };
      return setSliceInput(id, src, next);
    }

    /* ---- the screen dependency graph ---- */
    /* Recomputed whenever a route changes OR the screen/slice model changes
       underneath us. The model signature is O(screens) and screens are counted
       in single digits, so this is cheaper than being wrong. */
    let analysis = null;
    let analysisKey = '';
    function modelSignature() {
      const s = getSetup();
      if (!s) return 'none';
      return s.screensList.map(sc => sc.uniqueId + '#' + sc.layers.length).join('|');
    }
    function ensureAnalysis() {
      const key = rev + '@' + modelSignature();
      if (analysis && analysisKey === key) return analysis;
      analysisKey = key;

      const list = screens();
      const ids = list.map(sc => sc.uniqueId);
      const idSet = new Set(ids);
      /* deps: consumer -> [producers]. A screen depends on every OTHER screen
         any of its slices takes as input. Duplicates collapse — two slices
         reading the same screen is one dependency. */
      const deps = new Map();
      const edgeSlices = new Map();     /* "consumer>producer" -> [sliceId] for messages */
      for (const sc of list) deps.set(sc.uniqueId, []);
      for (const sc of list) {
        const seen = new Set();
        for (const sl of sc.layers) {                        /* .layers === slices */
          const r = routes.get(sl.uniqueId);
          if (!r || r.source.kind !== 'screen') continue;
          const producer = str(r.source.id);
          if (!idSet.has(producer)) continue;                /* dangling: reported by validate() */
          const ekey = sc.uniqueId + '>' + producer;
          if (!edgeSlices.has(ekey)) edgeSlices.set(ekey, []);
          edgeSlices.get(ekey).push(sl.uniqueId);
          if (seen.has(producer)) continue;
          seen.add(producer);
          deps.get(sc.uniqueId).push(producer);
        }
      }
      const found = elementaryCycles(ids, n => deps.get(n) || []);
      analysis = {
        ids: ids, deps: deps, edgeSlices: edgeSlices,
        cycles: found.cycles, truncated: found.truncated,
        backEdges: backEdges(ids, deps)
      };
      return analysis;
    }

    /* DFS back edges — an edge that points at a node still on the stack. This is
       the set 'break' mode defers, and it is deliberately NOT "every edge that
       touches a cycle": removing the back edges alone provably leaves a DAG, so
       a three-screen loop costs one frame of latency on ONE hop instead of on
       all three. Arena's own virtual-output cost is 0 or 1 frame, so a break
       that multiplied latency per hop would be the wrong shape of wrong.
       Recursion is bounded by the screen count — each node is entered once. */
    function backEdges(ids, deps) {
      const colour = new Map();                 /* 0 unseen, 1 on the stack, 2 done */
      ids.forEach(id => colour.set(id, 0));
      const back = new Set();
      function visit(v) {
        colour.set(v, 1);
        for (const w of deps.get(v) || []) {
          if (!colour.has(w)) continue;
          const c = colour.get(w);
          if (c === 1) back.add(v + '>' + w);   /* incl. a self-route, v === w */
          else if (c === 0) visit(w);
        }
        colour.set(v, 2);
      }
      for (const id of ids) if (colour.get(id) === 0) visit(id);
      return back;
    }
    const dependencies = () => ensureAnalysis().deps;

    function detectCycles() {
      return ensureAnalysis().cycles.map(c => c.slice());
    }

    /* Kahn over consumer<-producer, producers first, ties broken by the screen
       list order so the result is stable for the same model. */
    function orderReport(mode) {
      const a = ensureAnalysis();
      const m = /^(exclude|throw|break)$/.test(str(mode)) ? str(mode) : cycleMode;
      if (a.cycles.length && m === 'throw') throw CycleError(a.cycles.map(c => c.slice()));

      /* In 'break' mode the DFS back edges are deferred to the previous frame's
         texture; what is left is a DAG by construction, so Kahn always drains
         it and order() can never spin. */
      const deferred = [];
      const active = new Map();
      for (const id of a.ids) {
        const keep = [];
        for (const p of a.deps.get(id) || []) {
          if (m === 'break' && a.backEdges.has(id + '>' + p)) {
            deferred.push({ consumer: id, producer: p, slices: (a.edgeSlices.get(id + '>' + p) || []).slice() });
          } else keep.push(p);
        }
        active.set(id, keep);
      }

      const indeg = new Map();
      for (const id of a.ids) indeg.set(id, 0);
      for (const id of a.ids) for (const p of active.get(id)) indeg.set(id, indeg.get(id) + 1);

      const order = [];
      const emitted = new Set();
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const id of a.ids) {
          if (emitted.has(id) || indeg.get(id) !== 0) continue;
          emitted.add(id);
          order.push(id);
          progressed = true;
          for (const other of a.ids) {
            if (emitted.has(other)) continue;
            const list = active.get(other);
            for (let i = 0; i < list.length; i++) if (list[i] === id) indeg.set(other, indeg.get(other) - 1);
          }
        }
      }
      const excluded = a.ids.filter(id => !emitted.has(id));
      return {
        order: order, excluded: excluded, deferred: deferred, mode: m,
        cycles: a.cycles.map(c => c.slice()), truncated: a.truncated
      };
    }
    const order = mode => orderReport(mode).order;

    /* ---- resolve ---- */
    /* The whole point of the module. Given a slice and this frame's surfaces,
       hand back the texture AND the complete ledger of which composition stages
       are still on it. Never throws: a missing surface is a reported reason and
       a null texture, because a still frame beats a stack trace mid-show. */
    function resolve(sliceId, frameContext) {
      const fc = frameContext || {};
      const id = str(sliceId);
      const sl = sliceOf(id);
      const sc = screenOfSlice(id);
      const input = sliceInput(id);
      const kind = input.source.kind;
      const srcId = input.source.id;

      const base = {
        ok: false,
        sliceId: id,
        screenId: sc ? sc.uniqueId : null,
        source: { kind: kind, id: srcId, label: null },
        opts: input.opts,
        texture: null,
        straightAlpha: false,
        appliedEffects: ledger({}),
        notApplied: EFFECT_KEYS.slice(),
        opacity: 1,
        visible: false,
        deferredFrame: false,
        evidence: 'derived',
        notes: [],
        reason: null
      };
      if (!sl) return Object.assign(base, { reason: 'unknown-slice' });

      const desc = sourceById(kind, srcId);
      base.source.label = desc ? desc.label : null;

      /* --- composition: the finished mix. Everything is already on it. --- */
      if (kind === 'composition') {
        const tex = fc.composition !== undefined ? fc.composition : pick(fc.surfaces, COMPOSITION_ID);
        const led = ledger({
          clipTransform: true, clipEffects: true, layerEffects: true, layerOpacity: true,
          layerBypassSolo: true, layerBlendMode: true, groupEffects: true,
          compositionEffects: true, compositionMaster: true
        });
        return Object.assign(base, {
          ok: tex != null, texture: tex == null ? null : tex,
          /* Not straight alpha: this texture is the composited comp output, and
             the manual's straight-alpha sentence is made about routed LAYERS.
             Marked derived so nobody quotes it back as documented. */
          straightAlpha: false, evidence: 'documented:slice-routing.htm (default source)',
          appliedEffects: led, notApplied: notAppliedFrom(led),
          opacity: 1, visible: tex != null,
          reason: tex == null ? 'no-composition-surface' : null,
          notes: ['Default source. The complete composition, exactly as Arena renders it.']
        });
      }

      /* --- layer / group: THE carve-out --- */
      if (kind === 'layer' || kind === 'group') {
        const comp = composition();
        const entry = (kind === 'layer' ? comp.layers : comp.groups).find(x => x.id === srcId) || null;
        const tex = pick(kind === 'layer' ? fc.layers : fc.groups, srcId);
        const notes = [];

        /* Bypass and Solo. Honoured unless the slice's Input Bypass/Solo switch
           is off — which is precisely the manual's recipe for "show this layer
           in this slice and nowhere in the comp". */
        const honourGate = !input.opts.ignoreBypassSolo;
        const soloActive = has(fc, 'soloActive') ? bool(fc.soloActive)
          : (kind === 'layer' ? comp.layers : comp.groups).some(x => x.solo);
        const state = pick(kind === 'layer' ? fc.layerState : fc.groupState, srcId) || entry || null;
        const bypassed = state ? bool(val(state.bypassed) != null ? val(state.bypassed) : val(state.bypass)) : false;
        const soloed = state ? bool(val(state.solo)) : false;
        const gatedOff = honourGate && (bypassed || (soloActive && !soloed));

        /* Opacity. Post-fader by default; pre-fader when Input Opacity is off,
           which is how Arena avoids rendering a layer on top of itself. */
        const honourOpacity = !input.opts.ignoreOpacity;
        const rawOpacity = state ? clamp01(toNum(state.video && state.video.opacity, toNum(state.opacity, 1))) : 1;
        const opacity = honourOpacity ? rawOpacity : 1;

        const led = ledger({
          clipTransform: true,
          clipEffects: true,
          layerEffects: true,
          layerOpacity: honourOpacity,
          layerBypassSolo: honourGate,
          layerBlendMode: false,          /* <- the rule */
          groupEffects: kind === 'group', /* a group's internal mix is inside its own surface */
          compositionEffects: false,      /* <- the rule */
          compositionMaster: false
        });
        notes.push('Routing a layer bypasses the composition: layer and clip effects are applied, blend modes and composition effects are not (slice-routing.htm).');
        if (kind === 'group') {
          notes.push('DERIVED for groups: the manual states the carve-out for layers only. A group is itself a mix, so its own blend mode against the comp is treated as dropped while its internal blending survives.');
        }
        if (!entry) notes.push('This ' + kind + ' is not in the current composition provider (' + comp.origin + '); the route is stored but unverified.');
        if (gatedOff) notes.push(bypassed ? 'Layer is bypassed in the composition and Input Bypass/Solo is on.' : 'Another layer is soloed and Input Bypass/Solo is on.');

        return Object.assign(base, {
          ok: tex != null,
          texture: tex == null ? null : tex,
          straightAlpha: true,
          evidence: kind === 'layer' ? 'documented:slice-routing.htm' : 'derived (manual states the carve-out for layers)',
          appliedEffects: led, notApplied: notAppliedFrom(led),
          opacity: opacity,
          visible: tex != null && !gatedOff && opacity > 0,
          reason: tex == null ? 'no-' + kind + '-surface' : gatedOff ? 'bypassed-or-unsoloed' : null,
          notes: notes
        });
      }

      /* --- preview --- */
      if (kind === 'preview') {
        const tex = fc.preview !== undefined ? fc.preview : pick(fc.surfaces, PREVIEW_ID);
        const led = ledger({
          clipTransform: true, clipEffects: true, layerEffects: true, layerOpacity: true,
          layerBypassSolo: true, layerBlendMode: true, groupEffects: true,
          compositionEffects: true, compositionMaster: true
        });
        return Object.assign(base, {
          ok: tex != null, texture: tex == null ? null : tex,
          straightAlpha: true, evidence: 'derived (slice-routing.htm names the source, not its compositing)',
          appliedEffects: led, notApplied: notAppliedFrom(led),
          opacity: 1, visible: tex != null,
          reason: tex == null ? 'no-preview-surface' : null,
          notes: ['The Preview monitor output, for putting Preview on a separate external display.',
                  'The two input toggles are inert on this source (sources.htm).']
        });
      }

      /* --- another screen's output --- */
      if (kind === 'screen') {
        /* Never the graph's 'throw' mode here: resolve() is called per slice per
           frame and its contract is that it reports rather than raises. A
           cyclic setup makes the excluded/deferred state visible in the result,
           which is what a renderer needs anyway. */
        const rep = orderReport(cycleMode === 'throw' ? 'exclude' : cycleMode);
        const mine = sc ? sc.uniqueId : null;
        const isDeferred = rep.deferred.some(d => d.consumer === mine && d.producer === srcId);
        const fresh = pick(fc.screens, srcId);
        const prev = pick(fc.previousScreens, srcId);
        const tex = isDeferred ? (prev !== undefined ? prev : null) : (fresh !== undefined ? fresh : null);
        /* Everything the producing screen does — its own slices, warps, colour
           correction, soft edges — is already baked into that texture. None of
           the composition-side ledger keys are meaningful, so they read false
           and sourceIsRenderedScreen says why. */
        const led = ledger({});
        const notes = ['The producing screen is already fully rendered: its slices, warps, colour correction and soft edges are baked in.',
                       'Arena costs 0 or 1 frame here depending on load (screens.htm).'];
        if (isDeferred) notes.push('CLONE-DEFINED: this edge closes a loop, so it is fed LAST frame\'s texture. Arena documents no cycle behaviour at all.');
        if (rep.excluded.indexOf(srcId) >= 0) notes.push('The producing screen is excluded from the render order because it sits in a cycle.');
        return Object.assign(base, {
          ok: tex != null, texture: tex == null ? null : tex,
          straightAlpha: true, evidence: 'derived',
          appliedEffects: led, notApplied: notAppliedFrom(led),
          sourceIsRenderedScreen: true,
          opacity: 1, visible: tex != null,
          deferredFrame: isDeferred,
          reason: tex == null ? (isDeferred ? 'no-previous-screen-surface' : 'no-screen-surface') : null,
          notes: notes
        });
      }

      /* --- live --- */
      const dev = liveById(srcId);
      if (!dev) return Object.assign(base, { reason: 'unknown-live-input', notes: ['Call refreshLiveInputs() before routing to a device.'] });
      if (dev.available === false) {
        return Object.assign(base, {
          reason: 'unavailable-transport',
          unavailable: { transport: dev.transport, reason: dev.reason },
          notes: [dev.label + ' is declared because Arena has it, and unavailable because a browser cannot reach it. ' + dev.reason]
        });
      }
      const tex = pick(fc.live, srcId) !== undefined ? pick(fc.live, srcId) : pick(fc.live, dev.deviceId);
      const led = ledger({});   /* raw device frames: no clip, no layer, no comp */
      return Object.assign(base, {
        ok: tex != null, texture: tex == null ? null : tex,
        straightAlpha: true, evidence: 'clone-only',
        appliedEffects: led, notApplied: notAppliedFrom(led),
        opacity: 1, visible: tex != null,
        stream: live.streams.get(dev.id) || null,
        reason: tex == null ? (live.streams.has(dev.id) ? 'no-live-surface' : 'live-input-not-acquired') : null,
        notes: ['CLONE-ONLY source. In Arena a webcam is a composition source dragged into a clip, not an Input Source dropdown entry.']
      });
    }

    /* ---- output devices ---- */
    /* Two populations in one list: the devices actually assigned to screens
       right now, and one template per kind so a UI can offer the rest. Real
       display enumeration is the Window Management API, which is async and
       permission-gated — that belongs to the UI layer, not to a model file. */
    function outputDevices() {
      const out = [];
      for (const sc of screens()) {
        const d = sc.outputDevice;
        if (!d) continue;
        const cat = DEVICE_BY_KIND[d.kind] || { label: d.kind, browserFeasible: false, exclusive: false, note: 'Unknown device kind.' };
        out.push({
          id: 'device:' + (d.deviceId || d.idHash || sc.uniqueId),
          kind: d.kind, name: str(d.name || sc.name), label: cat.label,
          deviceId: str(d.deviceId || ''), idHash: str(d.idHash || ''),
          width: toNum(d.width, null), height: toNum(d.height, null),
          attrs: outputDeviceAttrs(d),
          followComposition: !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition()),
          browserFeasible: cat.browserFeasible, exclusive: cat.exclusive,
          available: cat.browserFeasible, reason: cat.browserFeasible ? null : cat.note,
          assignedTo: sc.uniqueId, assignedToName: sc.name, note: cat.note
        });
      }
      for (const cat of DEVICE_KINDS) {
        out.push({
          id: 'kind:' + cat.kind, kind: cat.kind, name: cat.label, label: cat.label,
          deviceId: '', idHash: '', width: null, height: null,
          browserFeasible: cat.browserFeasible, exclusive: cat.exclusive,
          available: cat.browserFeasible, reason: cat.browserFeasible ? null : cat.note,
          assignedTo: null, assignedToName: null, template: true, note: cat.note
        });
      }
      return out;
    }

    /* screens.htm, verbatim in substance: "Every output can only have a single
       screen associated with it... When you select an output already in use by
       another screen, Resolume will set the output of the other screen back to
       virtual." That demotion is reproduced here, and it is reported, because a
       screen silently going virtual mid-show is exactly the kind of surprise
       that gets blamed on the projector. */
    function assignDevice(screenId, device, options) {
      const setup = getSetup();
      if (!setup) return refuse('no-setup', 'No screen setup is loaded.');
      const sc = setup.screenById(str(screenId));
      if (!sc) return refuse('unknown-screen', 'No screen with id ' + str(screenId) + '.');

      const d = typeof device === 'string' ? { kind: device } : (device || {});
      const kind = str(d.kind || 'OutputDeviceVirtual');
      const cat = DEVICE_BY_KIND[kind];
      if (!cat) return refuse('unknown-device-kind', 'Unknown output device kind "' + kind + '".');

      const attrs = outputDeviceAttrs(d);
      attrs.name = str(d.name != null ? d.name : sc.name);
      attrs.deviceId = str(d.deviceId != null ? d.deviceId : '');
      attrs.idHash = str(d.idHash != null ? d.idHash : (window.OpenLiveScreens && window.OpenLiveScreens.idHash
        ? window.OpenLiveScreens.idHash(str(d.deviceId || d.name || sc.name)) : ''));
      if (d.width != null) attrs.width = String(Math.round(toNum(d.width, 1920)));
      if (d.height != null) attrs.height = String(Math.round(toNum(d.height, 1080)));

      const opts = options || {};
      const current = sc.outputDevice || {};
      const changedDestination = str(current.kind) !== kind ||
        str(current.deviceId || '') !== str(attrs.deviceId || '');
      const canFollow = !!(window.OpenLiveScreens &&
        typeof window.OpenLiveScreens.outputDeviceCanFollowComposition === 'function' &&
        window.OpenLiveScreens.outputDeviceCanFollowComposition(kind));
      const hasPolicy = has(d, 'followComposition');
      /* A UI assignment to a new configurable destination is an explicit
         OpenLive convenience and starts at the Composition raster. Import is
         different: an old/native document with no sidecar must stay custom.
         When Screens already restored a sidecar, an old routing document must
         preserve that model policy instead of erasing it. */
      const follow = canFollow && (hasPolicy ? bool(d.followComposition)
        : opts.imported ? !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition())
          : changedDestination ? true
            : !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition()));

      const demoted = [];
      if (cat.exclusive && attrs.deviceId) {
        for (const other of setup.screensList) {
          if (other.uniqueId === sc.uniqueId) continue;
          const od = other.outputDevice;
          if (!od || od.kind !== kind) continue;
          if (str(od.deviceId) !== attrs.deviceId) continue;
          other.setOutputDevice('OutputDeviceVirtual', {
            name: other.name, deviceId: 'Virtual' + str(other.name).replace(/^Screen/, ''),
            idHash: str(od.idHash || ''),
            width: String(Math.round(toNum(od.width, 1920))), height: String(Math.round(toNum(od.height, 1080)))
          }, { followComposition: true });
          demoted.push({ screenId: other.uniqueId, name: other.name });
        }
      }
      sc.setOutputDevice(kind, attrs, { followComposition: follow });
      changed('device');
      return {
        ok: true, screenId: sc.uniqueId,
        device: Object.assign({}, sc.outputDevice || attrs, { followComposition: follow }),
        demoted: demoted,
        available: cat.browserFeasible,
        warnings: cat.browserFeasible ? [] : [cat.label + ' cannot be driven from a browser. ' + cat.note]
      };
    }

    /* ---- problems a UI should surface ---- */
    function validate() {
      const problems = [];
      const setup = getSetup();
      const known = new Set();
      if (setup) for (const sc of setup.screensList) for (const sl of sc.layers) known.add(sl.uniqueId);
      routes.forEach((r, sliceId) => {
        if (!known.has(sliceId)) {
          problems.push({ level: 'info', code: 'orphan-route', sliceId: sliceId,
            message: 'A route is stored for slice ' + sliceId + ', which is not in the current setup. Kept so a load-order accident cannot lose it; pruneOrphans() drops them.' });
          return;
        }
        const chk = canRoute(sliceId, r.source, r.opts);
        if (!chk.ok) problems.push({ level: 'error', code: chk.error, sliceId: sliceId, message: chk.message });
        else for (const w of chk.warnings) problems.push({ level: 'warn', code: 'route-warning', sliceId: sliceId, message: w });
      });
      const a = ensureAnalysis();
      for (const c of a.cycles) {
        problems.push({ level: 'error', code: 'cycle', screens: c.slice(),
          message: 'Screen routing loop: ' + c.join(' -> ') + ' -> ' + c[0] + '. Arena documents no behaviour for this; order() will ' + cycleMode + ' it.' });
      }
      if (a.truncated) {
        problems.push({ level: 'warn', code: 'cycle-scan-truncated',
          message: 'Cycle enumeration hit its cap (' + MAX_CYCLES + '). The listed loops are real; there may be more.' });
      }
      return problems;
    }
    function pruneOrphans() {
      const setup = getSetup();
      const known = new Set();
      if (setup) for (const sc of setup.screensList) for (const sl of sc.layers) known.add(sl.uniqueId);
      const dropped = [];
      routes.forEach((r, id) => { if (!known.has(id)) dropped.push(id); });
      dropped.forEach(id => routes.delete(id));
      if (dropped.length) changed('route');
      return dropped;
    }

    /* ---- persistence ----
       JSON, not XML, and deliberately not smuggled into Arena's own elements:
       Arena has no serialised field for a slice's input source, so writing one
       would produce a file a real Arena would reject or misread. This sits
       beside the screen setup the same way the <OpenLive> sidecar does. */
    function serialize() {
      const setup = getSetup();
      const known = new Set();
      if (setup) for (const sc of setup.screensList) for (const sl of sc.layers) known.add(sl.uniqueId);
      const list = [];
      routes.forEach((r, sliceId) => {
        const row = {
          sliceId: sliceId,
          source: { kind: r.source.kind, id: r.source.id },
          opts: { ignoreOpacity: r.opts.ignoreOpacity, ignoreBypassSolo: r.opts.ignoreBypassSolo }
        };
        if (!known.has(sliceId)) row.orphan = true;
        list.push(row);
      });
      list.sort((a, b) => (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0));
      const devices = [];
      for (const sc of screens()) {
        const d = sc.outputDevice;
        if (!d) continue;
        devices.push(Object.assign({ screenId: sc.uniqueId, kind: str(d.kind) },
          outputDeviceAttrs(d), {
            followComposition: !!(sc.deviceFollowsComposition && sc.deviceFollowsComposition())
          }));
      }
      return {
        module: 'openlive-routing', version: 1,
        cyclePolicy: cyclePolicy, cycleMode: cycleMode,
        routes: list, devices: devices
      };
    }

    /* Accepts the object or its JSON text. Routes are taken verbatim — including
       for slices that do not exist yet — and then validate() reports what is
       wrong, rather than deserialize() quietly discarding a show's routing
       because the screen setup had not loaded first. */
    function deserialize(json) {
      let doc = json;
      if (typeof doc === 'string') {
        try { doc = JSON.parse(doc); } catch (e) { throw new Error('OpenLiveRouting.deserialize: not JSON: ' + e.message); }
      }
      if (!doc || typeof doc !== 'object') throw new Error('OpenLiveRouting.deserialize: expected an object.');
      if (doc.module != null && str(doc.module) !== 'openlive-routing') {
        throw new Error('OpenLiveRouting.deserialize: this is a "' + doc.module + '" document.');
      }
      routes.clear();
      if (doc.cyclePolicy === 'allow' || doc.cyclePolicy === 'refuse') cyclePolicy = doc.cyclePolicy;
      if (/^(exclude|throw|break)$/.test(str(doc.cycleMode))) cycleMode = str(doc.cycleMode);

      const skipped = [];
      for (const row of Array.isArray(doc.routes) ? doc.routes : []) {
        const sliceId = str(row && row.sliceId);
        const src = row && row.source;
        if (!sliceId || !src || !KIND_SET[str(src.kind)]) { skipped.push(row); continue; }
        routes.set(sliceId, {
          source: { kind: str(src.kind), id: str(src.id != null ? src.id : (src.kind === 'composition' ? COMPOSITION_ID : PREVIEW_ID)) },
          opts: normOpts(row.opts)
        });
      }
      const applied = [];
      for (const row of Array.isArray(doc.devices) ? doc.devices : []) {
        if (!row || !row.screenId || !row.kind) continue;
        const r = assignDevice(row.screenId, row, { imported: true });
        if (r.ok) applied.push(r);
      }
      changed('deserialize');
      return { ok: true, routes: routes.size, skipped: skipped, devices: applied, problems: validate() };
    }

    /* ---- the graph object ---- */
    const api = {
      /* sources */
      sources: sources,
      sourceById: sourceById,
      composition: composition,
      setCompositionProvider: fn => { compositionProvider = typeof fn === 'function' ? fn : defaultCompositionProvider; changed('provider'); },

      /* routes */
      setSliceInput: setSliceInput,
      setSliceInputOptions: setSliceInputOptions,
      clearSliceInput: clearSliceInput,
      sliceInput: sliceInput,
      canRoute: canRoute,
      routedSlices: () => Array.from(routes.keys()),

      /* the screen/slice model, under names that do not lie */
      screens: screens,
      slicesOf: slicesOf,
      sliceOf: sliceOf,
      screenOfSlice: screenOfSlice,

      /* render order */
      order: order,
      orderReport: orderReport,
      detectCycles: detectCycles,
      dependencies: () => {
        const out = {};
        dependencies().forEach((v, k) => { out[k] = v.slice(); });
        return out;
      },
      get cyclePolicy() { return cyclePolicy; },
      setCyclePolicy: p => { cyclePolicy = p === 'allow' ? 'allow' : 'refuse'; changed('policy'); return cyclePolicy; },
      get cycleMode() { return cycleMode; },
      setCycleMode: m => { if (/^(exclude|throw|break)$/.test(str(m))) { cycleMode = str(m); changed('policy'); } return cycleMode; },

      /* per-frame */
      resolve: resolve,
      effectKeys: () => EFFECT_KEYS.slice(),

      /* outputs */
      outputDevices: outputDevices,
      assignDevice: assignDevice,

      /* live inputs — the only DOM in the file, and only on request */
      liveInputs: liveInputs,
      refreshLiveInputs: probeLiveInputs,
      acquireLive: acquireLive,
      captureInfo: liveCaptureInfo,
      savedLiveConstraints: savedLiveConstraints,
      applyLiveConstraints: applyLiveConstraints,
      clearLiveConstraints: clearLiveConstraints,
      releaseLive: releaseLive,
      liveState: () => ({ probedAt: live.probedAt, labelled: live.labelled, error: live.error,
                          permission: live.permission, watching: live.watching,
                          open: Array.from(live.streams.keys()),
                          capturePreferencesPersistent:live.capturePreferencesPersistent,
                          capturePreferencesError:live.capturePreferencesError }),
      watchLiveInputs: watchLiveInputs,
      readCameraPermission: readCameraPermission,
      cameraDiagnosis: cameraDiagnosis,

      /* housekeeping */
      validate: validate,
      pruneOrphans: pruneOrphans,
      clear: () => { routes.clear(); changed('clear'); },
      serialize: serialize,
      deserialize: deserialize,
      onChange: fn => { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
      offChange: fn => listeners.delete(fn),
      get revision() { return rev; }
    };
    return api;
  }

  /* ================= the live graph ================= */
  let liveGraph = null;

  return {
    version: 1,
    graph: () => (liveGraph || (liveGraph = createGraph())),
    createGraph: createGraph,
    resetGraph: () => { liveGraph = createGraph(); return liveGraph; },

    /* constants a UI and a renderer both need without reaching into a graph */
    sourceKinds: () => SOURCE_KINDS.slice(),
    effectKeys: () => EFFECT_KEYS.slice(),
    deviceKinds: () => DEVICE_KINDS.map(d => Object.assign({}, d)),
    unavailableTransports: () => UNAVAILABLE_TRANSPORTS.map(d => Object.assign({ available: false }, d)),
    inputConfigurationSurfaces: () => INPUT_CONFIGURATION_SURFACES.map(surface =>
      Object.assign({}, surface, {controls:(surface.controls || []).slice()})),
    defaultSource: () => Object.assign({}, DEFAULT_SOURCE),
    defaultOpts: () => Object.assign({}, DEFAULT_OPTS)
  };
})();
