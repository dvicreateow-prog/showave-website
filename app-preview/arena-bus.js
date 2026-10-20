/* ===========================================================================
   arena-bus.js — one composition, several windows.
   ---------------------------------------------------------------------------
   Arena's Advanced Output, Preferences and Shortcuts are separate windows onto
   the same running composition. In this study they were separate *documents* —
   advanced-output.html, preferences.html, shortcuts.html and wire.html each
   loaded their own scripts and none of them loaded arena-engine.js at all. So
   the Advanced Output sliced a composition it could not see, and Preferences
   changed settings nothing read.

   A browser gives each document its own JS world, so the engine cannot simply
   be shared. This is the seam: the main window is the HOST and owns the engine;
   every other page is a CLIENT that receives a snapshot of the composition and
   sends commands back. BroadcastChannel carries it live; localStorage keeps the
   last snapshot so a client opened cold still has something to draw.

     ArenaBus.role                 'host' | 'client'
     ArenaBus.publish(snapshot)    host: broadcast the current state
     ArenaBus.onSnapshot(fn)       client: called with each new state
     ArenaBus.snapshot             the latest state, whichever side you are on
     ArenaBus.send(cmd)            client: ask the host to do something
     ArenaBus.onCommand(fn)        host: handle those asks

   Commands are advisory, not authoritative: the host validates and applies them
   through the engine, so a client can never write a value the engine would
   refuse.
   =========================================================================== */
(() => {
'use strict';

const CHANNEL = 'resolume-arena-clone';
const STORE = 'arena-bus-snapshot';

const listeners = {snapshot: [], command: [], hello: [], frames: [], slices: []};

/* THE SCREEN TREE TRAVELS THE OTHER WAY.
   Everything else on this channel flows host -> clients, because the host owns
   the composition. Screens and slices are the one thing it does not own: they
   live in the Advanced Output, which is a client. transform.htm and
   input-maps.htm both depend on the deck being able to see them — "drag a
   screen onto a clip, layer, group or the composition" is a gesture that
   starts in one document and lands in another — so they get their own lane
   rather than being smuggled through a command. Held here as well as
   delivered, so a deck opened after the Advanced Output is not blank until
   something moves. */
let lastSlices = null;
let chan = null;
try { chan = new BroadcastChannel(CHANNEL); } catch { chan = null; }

const state = {
  role: 'client',
  snapshot: null,
  lastPublish: 0
};

/* A client that never hears from a host is looking at a stale composition, and
   should say so rather than pretend. */
let lastHeard = 0;
const HOST_TIMEOUT = 4000;

function readStored(){
  try { const raw = localStorage.getItem(STORE); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
state.snapshot = readStored();

function deliver(msg){
  if(!msg || typeof msg !== 'object') return;
  if(msg.type === 'alive'){
    /* A host that is not changing is still a host. Snapshots only go out when
       something moves, so without this a composition sitting still for four
       seconds was indistinguishable from a main window that had been closed,
       and every client quietly relabelled itself "not connected". */
    lastHeard = Date.now();
    return;
  }
  if(msg.type === 'frames'){
    /* Pixels, not state. Kept off the snapshot path deliberately: frames are
       large, they arrive many times a second, and they must never be written
       to localStorage — a remembered composition should come back as a
       composition, not as a still of one. */
    lastHeard = Date.now();
    listeners.frames.forEach(fn => { try { fn(msg.data); } catch(e){ console.error('bus', e); } });
    return;
  }
  if(msg.type === 'slices'){
    /* Deliberately NOT touching lastHeard: the Advanced Output publishing its
       own screens says nothing about whether a host is alive, and treating it
       as a sign of life would keep every client reporting "live" with the deck
       long closed. */
    lastSlices = msg.data;
    listeners.slices.forEach(fn => { try { fn(msg.data); } catch(e){ console.error('bus', e); } });
    return;
  }
  if(msg.type === 'snapshot'){
    lastHeard = Date.now();
    state.snapshot = msg.data;
    listeners.snapshot.forEach(fn => { try { fn(msg.data); } catch(e){ console.error('bus', e); } });
  } else if(msg.type === 'command' && state.role === 'host'){
    listeners.command.forEach(fn => { try { fn(msg.data); } catch(e){ console.error('bus', e); } });
  } else if(msg.type === 'hello' && state.role === 'host'){
    /* a client just opened: send it the current state immediately rather than
       leaving it blank until the next change.
       `listeners` is keyed by message type and every entry is an array; this
       used to read `listeners.hello && listeners.hello()`, which was checking a
       key the object never had, so a cold client waited for the next change
       instead of being answered. */
    listeners.hello.forEach(fn => { try { fn(); } catch(e){ console.error('bus', e); } });
    post({type:'snapshot', data: state.snapshot});
  } else if(msg.type === 'host-here'){
    /* Two main windows are open. Both ran becomeHost() and both would publish a
       different composition into one channel several times a second, with
       clients painting whichever arrived last. The older claim keeps the
       composition — the one you opened first is the one you are performing
       with — and the newer one steps down to an ordinary client.

       The announcement has to go BOTH ways. A newcomer broadcasts its claim and
       the incumbent, being older, correctly declines to demote; but the
       incumbent announced itself before the newcomer existed and
       BroadcastChannel does not replay, so the newcomer never hears it and
       stays host too. That left both windows hosting — precisely the state this
       is here to prevent. So an incumbent that hears a *newer* claim answers
       with its own, and the newcomer stands down on hearing it. */
    if(state.role !== 'host' || !msg.claim) return;
    /* A claim we have already watched fail to host is not a claim any more. */
    if(staleClaims.has(msg.claim)) return;
    if(msg.claim < claimStamp) { state.role = 'client'; deferredTo = msg.claim; }  // they were first
    else if(msg.claim > claimStamp) post({type:'host-here', claim: claimStamp});
  } else if(msg.type === 'host-gone'){
    /* the window that displaced us has closed — take the composition back now
       rather than waiting out the timeout, so a reload costs no visible gap */
    if(hostCapable && state.role !== 'host') becomeHost();
  }
}
if(chan) chan.onmessage = e => deliver(e.data);
/* storage events cross tabs even where BroadcastChannel is unavailable */
addEventListener('storage', e => {
  if(e.key === STORE && e.newValue){
    try { deliver({type:'snapshot', data: JSON.parse(e.newValue)}); } catch {}
  }
});

/* Returns whether the message actually went out. The frame lane needs to know:
   it sends ImageBitmaps, which structured clone supports on Chromium but not
   everywhere, and a browser that refuses one throws DataCloneError here.
   Swallowing that silently would have left the far window black with no way to
   tell why, so the caller gets the answer and can fall back to encoding. */
function post(msg){
  if(!chan) return false;
  try { chan.postMessage(msg); return true; }
  catch(e){ post.lastError = (e && (e.name + ': ' + e.message)) || String(e); return false; }
}

/* When this window claimed the composition. Broadcast with the claim so a
   second main window can tell which of the two opened first. */
let claimStamp = 0;

/* Set once by any window that owns an engine and is entitled to host. A pure
   client — the Advanced Output, Preferences — never sets it and so can never
   claim the composition, whatever happens on the channel. */
let hostCapable = false;

function becomeHost(){
  hostCapable = true;
  claimStamp = Date.now();
  state.role = 'host';
  post({type:'host-here', claim: claimStamp});
  /* A host that arrives late has missed every hello already sent. Answer them
     retrospectively: the same listeners a hello would have run, so the window
     publishes its composition the instant it takes the role rather than waiting
     for something to move. Without this a client that opened first sits on an
     empty model for ever — and since the Advanced Output only asks for the
     sources it needs once it has seen a composition, "for ever" means no frames
     at all.

     Deferred by a turn, and that detail is the whole point: becomeHost() is the
     FIRST thing the deck calls, before it has registered its own onHello
     handler further down the same script. Running the replay synchronously
     therefore walked an empty listener list and published nothing — so
     reloading the deck left the Advanced Output permanently dark, with a
     healthy heartbeat on the channel and not one frame behind it. */
  setTimeout(() => {
    listeners.hello.forEach(fn => { try { fn(); } catch(e){ console.error('bus', e); } });
  }, 0);
}

/* THE ROLE HAD NO WAY BACK, AND THAT IS WHAT KILLED THE FRAME LANE.
   "Oldest claim wins" is the right rule — the window you opened first is the
   one you are performing with — but it was applied without ever asking whether
   the older claimant still existed. Reload the deck and the fresh document
   hears the outgoing one, stands down, and stays a client for ever; the page
   that beat it is already gone. Nothing is host, so `command` messages are
   dropped on the floor (deliver() only runs them for a host), the Advanced
   Output's needSources never lands, no frames are ever produced, and the far
   window shows "not connected" next to a stage that says it has no source.
   Every symptom of a dead display, from one missing liveness check.

   So: a departing host says so, and a demoted host that stops hearing from
   whoever displaced it takes the composition back. */
addEventListener('pagehide', () => { if(state.role === 'host') post({type:'host-gone'}); });

/* A DOCUMENT THAT ANSWERS IS NOT A DOCUMENT THAT HOSTS.
   Answering a claim only proves a message handler ran. A page the browser has
   frozen — put in the back/forward cache, or left over from a reload — still
   runs that handler while every one of its timers is suspended, so it wins the
   election on seniority and then hosts nothing at all. Observed exactly that:
   nothing but `host-here` on the channel, no heartbeat, no snapshot, and a
   composition no window would publish.

   Seniority therefore has to be earned twice. We stand down as before, but we
   keep watching, and a claimant that has not produced one heartbeat, snapshot
   or frame within the timeout has its claim struck off — permanently, so it
   cannot win the next election either — and the composition comes back here. */
const staleClaims = new Set();
let deferredTo = 0;

setInterval(() => {
  if(!hostCapable || state.role === 'host') return;
  if(Date.now() - lastHeard < HOST_TIMEOUT) return;   // someone real is still hosting
  if(deferredTo){ staleClaims.add(deferredTo); deferredTo = 0; }
  becomeHost();
}, 1000);

/* THE OTHER HALF OF THE SAME RACE. hello() is sent once, at load. A client that
   opens before any host exists — or during the seconds a host spends settling an
   election — asks an empty channel and never asks again, so it holds a blank
   composition while a perfectly healthy host publishes beside it. Keep asking
   until somebody answers; stop the moment one does. */
setInterval(() => {
  if(state.role === 'host') return;
  if(Date.now() - lastHeard < HOST_TIMEOUT) return;
  post({type:'hello'});
}, 2000);

function publish(data){
  if(state.role !== 'host') return false;
  state.snapshot = data;
  state.lastPublish = Date.now();
  post({type:'snapshot', data});
  /* the store is the cold-start copy, so throttle it — it is not the live path */
  if(!publish._t){
    publish._t = setTimeout(() => {
      publish._t = null;
      try { localStorage.setItem(STORE, JSON.stringify(state.snapshot)); } catch {}
    }, 400);
  }
  return true;
}

window.ArenaBus = {
  get role(){ return state.role; },
  get snapshot(){ return state.snapshot; },
  /* true when a host has spoken recently — a client can use this to show
     whether it is looking at a live composition or a remembered one */
  get live(){ return state.role === 'host' || (Date.now() - lastHeard) < HOST_TIMEOUT; },
  becomeHost, publish,
  /* host: "still here" — cheaper than republishing the whole composition */
  heartbeat: () => state.role === 'host' ? post({type:'alive'}) : false,
  /* host: a frame of each source another window is drawing from */
  frames: data => state.role === 'host' ? post({type:'frames', data}) : false,
  /* why the last post failed — the frame lane needs the reason, not just the fact */
  lastPostError: () => post.lastError || null,
  onFrames(fn){ listeners.frames.push(fn); },
  /* the Advanced Output's screens and slices, for any window that draws them */
  slices: data => post({type:'slices', data}),
  get sliceTree(){ return lastSlices; },
  onSlices(fn){ listeners.slices.push(fn); if(lastSlices) fn(lastSlices); },
  hello: () => post({type:'hello'}),
  onSnapshot(fn){ listeners.snapshot.push(fn); if(state.snapshot) fn(state.snapshot); },
  onCommand(fn){ listeners.command.push(fn); },
  /* host: a client just opened and wants the current state */
  onHello(fn){ listeners.hello.push(fn); },
  send(cmd){ post({type:'command', data:cmd}); }
};
})();
