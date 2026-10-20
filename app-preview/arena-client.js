/* ===========================================================================
   arena-client.js — the client half of the seam.
   ---------------------------------------------------------------------------
   `arena-bus.js` carries bytes between windows. It says nothing about what a
   composition *is*, so every page that wanted to read one invented its own
   shape and then stopped short of writing anything back. The Advanced Output
   ended up with a private `compositionTexture` that never learned the
   composition's real size; the Shortcuts window assigned to a hardcoded list of
   display strings; the Envelope Editor edited a parameter it could not name.

   This file gives every non-host window the same view the host has, addressed
   the way Resolume addresses it.

   THE ADDRESS
   Every parameter in `arena-engine.js` already carries a `home` — a REST-shaped
   path, unique across the document:

       /composition/video/opacity
       /composition/layers/2/video/opacity
       /composition/decks/1/layers/2/clips/1/transport/position

   That is the same addressing surface Resolume's own REST API exposes
   (restapi.htm), and CONFORMANCE.md §0 already treats it as the model's one
   authoritative statement of itself. So `home` is the key here too: a client
   never holds a parameter object, it holds a path.

       ArenaClient.value('/composition/layers/2/video/opacity')      // read
       ArenaClient.set('/composition/layers/2/video/opacity', 0.5)   // write

   THE RULE THE MANUAL STATES
   layers.htm, about the transport controls appearing in two places at once:
   "Changing anything in one place, will also update it in the other." That has
   to hold across *windows*, not just across panels in one window — the manual's
   Advanced Output, Shortcuts and Preferences are windows onto one composition.
   A write here is a request; the host applies it through `EN.setParam`, so a
   client can never set a value the engine itself would refuse, and the change
   comes back to every window on the next snapshot.

   WHAT ARRIVES
   The host publishes all ~309 non-clip parameters every time something moves.
   Clips are the long tail — 76 parameters each, times every cell in every deck
   — so they are not published wholesale. The host always includes the selected
   clip and any playing clip; anything else a window needs it asks for:

       ArenaClient.watch('/composition/decks/1/layers/2/clips/')

   WIRE FORMAT
   `snapshot.params` maps home -> a tuple, kept short because it is broadcast
   several times a second:

       [ value, type, min, max, options|null, name ]
         0      1     2    3    4              5

   Decoded by `get()` below; nothing outside this file should index the tuple.
   =========================================================================== */
(() => {
'use strict';

const BUS = window.ArenaBus || null;

/* Tuple positions, named once so the format can change in one place. */
const T_VALUE = 0, T_TYPE = 1, T_MIN = 2, T_MAX = 3, T_OPTIONS = 4, T_NAME = 5;

const listeners = [];
const readyFns  = [];
let   snap      = (BUS && BUS.snapshot) || null;
let   announced = false;

/* Prefixes this window has asked the host to include. Re-sent whenever a host
   appears, because a host that started after us never heard the first ask. */
const watched = new Set();

function params(){ return (snap && snap.params) || {}; }

/* ---------------------------------------------------------------- reading */

/* A parameter as a plain object, or null if this window has not been sent it.
   `null` and "value 0" are different answers and callers need to tell them
   apart, so this never invents a default. */
function get(home){
  const t = params()[home];
  if(!t) return null;
  return {
    home,
    name:    t[T_NAME],
    value:   t[T_VALUE],
    type:    t[T_TYPE],
    min:     t[T_MIN],
    max:     t[T_MAX],
    options: t[T_OPTIONS] || null
  };
}
function value(home){ const t = params()[home]; return t ? t[T_VALUE] : undefined; }

/* Every parameter under a path. Used by panels that draw a whole section —
   the Layer panel's Video group is `list('/composition/layers/2/video/')`. */
function list(prefix){
  const out = [], all = params();
  for(const home in all) if(home.indexOf(prefix) === 0) out.push(get(home));
  return out.sort((a,b) => a.home < b.home ? -1 : 1);
}

/* Structure, not parameters: what layers/groups/columns/decks exist, what is
   playing, what is selected. Always present, cheap to send. */
function structure(){ return (snap && snap.structure) || null; }
function comp(){      return (snap && snap.comp) || null; }
const layers  = () => (structure() || {}).layers  || [];
const groups  = () => (structure() || {}).groups  || [];
const columns = () => (structure() || {}).columns || [];
const decks   = () => (structure() || {}).decks   || [];
const selection = () => (structure() || {}).selection || null;

/* ---------------------------------------------------------------- writing */

function send(cmd){
  if(!BUS){ return false; }
  BUS.send(cmd);
  return true;
}

/* Ask the host to move a parameter. Optimistic: the local tuple is updated so
   a slider being dragged does not snap back while waiting for the next
   snapshot. The host is still the authority — if it clamps or refuses, the
   next snapshot overwrites this. */
function set(home, v){
  const t = params()[home];
  if(t) t[T_VALUE] = v;
  return send({op:'setParam', home, value:v});
}
function reset(home){ return send({op:'reset', home}); }

/* Structural and transport verbs. The host maps these onto the engine; a name
   it does not know is ignored rather than guessed at. */
function action(name, args){ return send({op:'action', name, args: args || {}}); }

/* Ask for a subtree in future snapshots (clips, mostly). Safe to call twice. */
function watch(prefix){
  if(watched.has(prefix)) return;
  watched.add(prefix);
  send({op:'watch', prefix});
}
function unwatch(prefix){
  if(!watched.delete(prefix)) return;
  send({op:'unwatch', prefix});
}

/* --------------------------------------------------------------- delivery */

function deliver(s){
  snap = s;
  if(!announced){ announced = true; readyFns.forEach(fn => call(fn, s)); readyFns.length = 0; }
  listeners.forEach(fn => call(fn, s));
}
function call(fn, s){ try { fn(s); } catch(e){ console.error('ArenaClient listener', e); } }

if(BUS){
  BUS.onSnapshot(s => {
    /* A host we have not met yet does not know what we are watching. Re-ask on
       the first snapshot from a new host rather than tracking host identity. */
    if(watched.size && (!snap || s.rev === 1 || (snap.rev || 0) > (s.rev || 0)))
      watched.forEach(p => send({op:'watch', prefix:p}));
    deliver(s);
  });
  BUS.hello();
}

/* --------------------------------------------------------------- presence */

/* Every window that shows composition data should say whether it is looking at
   a live one. Pages call this with an element and forget about it; without it
   a stale composition is indistinguishable from a current one, which is how
   the Advanced Output came to show 1600x1200 while the composition was
   1920x1080 and said nothing. */
function bindStatus(el, opts){
  if(!el) return;
  opts = opts || {};
  const paint = () => {
    const live = !!(BUS && BUS.live);
    const c = comp();
    el.textContent = live
      ? (opts.label ? opts.label(c) : `live · ${c ? c.name : 'composition'}${c ? ` ${c.width}×${c.height}` : ''}`)
      : (snap ? 'not connected · showing last known Show' : 'no Show');
    el.classList.toggle('live', live);
    el.classList.toggle('cold', !live);
    el.title = live
      ? 'Connected to the composition in the main window.'
      : 'SHOWAVE Live is not open, so nothing here is being applied to a running Show.';
  };
  onChange(paint);
  setInterval(paint, 1000);   /* `live` decays on silence, so poll it */
  paint();
}

function onChange(fn){ listeners.push(fn); if(snap) call(fn, snap); }
function ready(fn){ if(snap) call(fn, snap); else readyFns.push(fn); }

window.ArenaClient = {
  get live(){ return !!(BUS && BUS.live); },
  get snapshot(){ return snap; },
  get connected(){ return !!BUS; },
  ready, onChange,
  comp, structure, layers, groups, columns, decks, selection,
  get, value, list,
  set, reset, action, watch, unwatch,
  bindStatus
};
})();
