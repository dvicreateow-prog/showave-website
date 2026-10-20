/* ===========================================================================
   input-map.js — Arena's own keyboard map, running in the browser.
   ---------------------------------------------------------------------------
   default/Shortcuts/Keyboard/Default.xml is a table of 42 shortcuts, each one
   a 64-bit RawInputMessage and the parameter path it drives. The key code sits
   in byte 3 of that value; the shipped map decodes cleanly against what each
   path does — 32 on tap tempo is Space, 49-57 on the column triggers are 1-9,
   66 on bypass is B, 77 on master is M, 37-40 on the column navigation are the
   arrows.

   Two things the shipped files do not name, and which are therefore resolved
   here rather than guessed at upstream:

     · codes 33-47 are ambiguous — as Windows virtual keys 37-40 are arrows, as
       ASCII they are punctuation, and Arena's own map uses both. KEY_FIX below
       resolves each one by what its path actually does, which is decisive.
     · the modifier lanes carry the modifier state but nothing names the bits.
       They are carried through as flags and matched exactly, so a shortcut
       recorded with a modifier only fires with the same flag combination —
       correct without needing to know which bit is which.

   Paths come in two kinds. An action path ends in a verb the REST API exposes
   as POST (connect, select, tempotap, resync, disconnect-all). A parameter
   path addresses a value, and is driven by resolving it against the live
   composition and writing through the websocket.
   =========================================================================== */
window.InputMap = (() => {
  'use strict';
  const AL = window.ArenaLive;

  /* what each shipped code really is, decided by the path it drives */
  const KEY_FIX = {
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    44: ',', 45: '-', 46: '.', 47: '/',
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: ' ',
  };
  const keyName = code =>
    KEY_FIX[code] || (code >= 48 && code <= 57 ? String.fromCharCode(code)
      : code >= 65 && code <= 90 ? String.fromCharCode(code).toLowerCase()
      : null);

  /* browser event -> the same code space the map uses */
  function codeOf(ev) {
    const k = ev.key;
    if (k === ' ') return 32;
    if (k === 'ArrowLeft') return 37;
    if (k === 'ArrowUp') return 38;
    if (k === 'ArrowRight') return 39;
    if (k === 'ArrowDown') return 40;
    if (k === 'Backspace') return 8;
    if (k === 'Tab') return 9;
    if (k === 'Enter') return 13;
    if (k === 'Escape') return 27;
    if (k.length === 1) {
      const c = k.charCodeAt(0);
      if (c >= 97 && c <= 122) return c - 32;      // a-z -> A-Z
      return c;
    }
    return null;
  }

  /* Arena's shortcut paths address its internal parameter tree, which spells
     things differently from the REST API — tempotap is REST's tempo_tap,
     disconnectall is disconnect-all. Comparing on alphanumerics only makes the
     two vocabularies line up. */
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const ACTION = /\/(connect|select|clear|eject|trigger|disconnectall|tempotap|resync)$/i;

  /* Six navigation verbs exist in the shortcut map but have no REST endpoint.
     They are ordinary compositions of endpoints that do exist, so they are
     implemented here rather than reported as dead keys. */
  const SYNTH = {
    connectnextcolumn: () => stepColumn(+1),
    connectprevcolumn: () => stepColumn(-1),
    connectnextclip:   () => stepClip(+1),
    connectprevclip:   () => stepClip(-1),
    selectnextdeck:    () => stepDeck(+1),
    selectprevdeck:    () => stepDeck(-1),
  };
  function connectedColumn() {
    const cols = AL.columns();
    const i = cols.findIndex(c => AL.val(c.connected) === 'Connected');
    return i < 0 ? 0 : i + 1;
  }
  async function stepColumn(d) {
    const n = AL.columns().length; if (!n) return { ok: false, why: 'no Cues' };
    const cur = connectedColumn();
    const next = ((cur - 1 + d + n) % n) + 1;
    await AL.cmd.triggerColumn(next);
    return { ok: true, how: `Cue ${next}` };
  }
  async function stepClip(d) {
    const layers = AL.layers();
    const li = layers.findIndex(l => AL.val(l.selected) === true);
    const l = li < 0 ? layers.length : li + 1;
    const clips = (AL.layer(l) || {}).clips || [];
    if (!clips.length) return { ok: false, why: 'no clips' };
    let cur = clips.findIndex(k => /^Connected/.test(AL.val(k.connected)));
    for (let i = 1; i <= clips.length; i++) {
      const c = ((cur < 0 ? 0 : cur) + d * i + clips.length * 2) % clips.length;
      if (AL.val(clips[c].connected) !== 'Empty') {
        await AL.cmd.triggerClip(l, c + 1);
        return { ok: true, how: `layer ${l} clip ${c + 1}` };
      }
    }
    return { ok: false, why: 'no loaded clip on this layer' };
  }
  const deckIdentity = (deck, index) => deck && deck.id != null ? `id:${deck.id}`
    : deck && deck.selected && deck.selected.id != null ? `selected:${deck.selected.id}`
    : `index:${index}`;
  async function stepDeck(d) {
    const decks = AL.decks();
    const open = decks.map((deck, index) => ({ deck, index }))
      .filter(record => record.deck && !record.deck.closed);
    if (!open.length) return { ok: false, why: 'no open Banks' };
    const current = decks.findIndex(deck => deck && AL.val(deck.selected) === true);
    let at = open.findIndex(record => record.index === current);
    if (at < 0) at = 0;
    /* Deck navigation stops at the first/last open Deck, matching the main
       strip's arrows. It never wraps into the opposite edge or a closed Deck. */
    const nextAt = Math.max(0, Math.min(open.length - 1, at + (d < 0 ? -1 : 1)));
    if (nextAt === at) return { ok: false, why: 'Bank boundary' };
    const target = open[nextAt], identity = deckIdentity(target.deck, target.index);
    const accepted = await AL.cmd.selectDeck(target.deck);
    if (accepted === false) return { ok: false, why: 'The live host rejected Bank selection' };
    await AL.refresh();
    const refreshed = AL.decks();
    const active = refreshed.findIndex(deck => deck && AL.val(deck.selected) === true);
    if (active < 0 || deckIdentity(refreshed[active], active) !== identity)
      return { ok: false, why: `The live host did not confirm Bank ${target.index + 1}` };
    return { ok: true, how: `Bank ${active + 1}` };
  }

  const M = {
    enabled: true,
    table: [],            // { code, key, flags, path, behaviour, kind }
    lastFired: null,
    log: [],
  };

  function build() {
    const src = window.RESOLUME && window.RESOLUME.arena
      && window.RESOLUME.arena.inputmaps;
    if (!src || !src.keyboard) { M.table = []; return M.table; }
    M.table = src.keyboard.map(e => ({
      code: e.code,
      key: keyName(e.code),
      flags: (e.flag_lo << 8) | e.flag_hi,
      flag_lo: e.flag_lo, flag_hi: e.flag_hi,
      path: e.path,
      behaviour: e.behaviour,
      subtarget: e.subtarget,
      kind: ACTION.test(e.path || '') ? 'action' : 'parameter',
    })).filter(e => e.key);
    return M.table;
  }

  /* ---- executing a path -------------------------------------------------
     Arena's shortcut paths are the same paths the REST API and the websocket
     use, minus /api/v1 — so they can be run directly. Actions POST; parameter
     paths resolve against the live composition and write. */
  async function run(entry) {
    if (AL.status !== 'live') return { ok: false, why: 'not connected' };
    const path = entry.path;
    if (!path) return { ok: false, why: 'no path' };
    const leaf = norm(path.split('/').pop());
    if (SYNTH[leaf]) { try { return await SYNTH[leaf](); }
                       catch (e) { return { ok: false, why: String(e.message || e) }; } }
    if (entry.kind === 'action') {
      /* the parameter tree spells these without separators; REST does not */
      const rest = leaf === 'disconnectall' ? '/composition/disconnect-all' : path;
      try { await AL.action(rest); return { ok: true, how: 'POST ' + rest }; }
      catch (e) { return { ok: false, why: String(e.message || e) }; }
    }
    const p = resolve(path);
    if (!p) return { ok: false, why: 'path does not resolve in this Show' };
    if (p.valuetype === 'ParamBoolean') { AL.setParam(p.id, !p.value); return { ok: true, how: 'toggle' }; }
    if (p.valuetype === 'ParamTrigger' || p.valuetype === 'ParamEvent') {
      AL.triggerParam(p.id); return { ok: true, how: 'trigger' };
    }
    /* a range on a key press is a nudge — direction from the subtarget index
       the shortcut carries, which is how Arena distinguishes tempo up/down */
    const step = (p.max ?? 1) - (p.min ?? 0);
    const dir = entry.subtarget && +entry.subtarget.optionIndex >= 7 ? 1 : -1;
    AL.setParam(p.id, Math.max(p.min ?? 0, Math.min(p.max ?? 1, (p.value ?? 0) + dir * step * 0.01)));
    return { ok: true, how: 'nudge ' + (dir > 0 ? 'up' : 'down') };
  }

  /* /composition/layers/2/bypassed  ->  the live parameter object */
  function resolve(path) {
    const c = AL.comp;
    if (!c) return null;
    const parts = path.replace(/^\//, '').split('/');
    if (parts[0] !== 'composition') return null;
    let node = c;
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      if (node == null) return null;
      if (seg === 'layers' || seg === 'columns' || seg === 'decks' || seg === 'clips') {
        const idx = +parts[++i];
        const arr = node[seg];
        if (!Array.isArray(arr) || !idx) return null;
        node = arr[idx - 1];
        continue;
      }
      if (seg === 'selectedlayer') { node = selected(c.layers); continue; }
      if (seg === 'selectedclip') { node = selectedClip(c); continue; }
      if (seg === 'effects') {                       // …/effects/<name>/<param>
        const list = (node && node.effects) || [];
        const want = String(parts[++i] || '').toLowerCase();
        node = list.find(fx => String(fx.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') ===
                               want.replace(/[^a-z0-9]/g, ''));
        if (node && parts[i + 1]) {
          const pn = String(parts[++i]).toLowerCase();
          const hit = Object.entries(node.params || {})
            .find(([k]) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === pn.replace(/[^a-z0-9]/g, ''));
          node = hit ? hit[1] : null;
        }
        continue;
      }
      /* match on alphanumerics so tempotap finds tempo_tap and blendmode
         finds "Blend Mode" */
      if (node[seg] !== undefined) { node = node[seg]; continue; }
      const want = norm(seg);
      const hit = Object.keys(node).find(k => norm(k) === want);
      node = hit ? node[hit] : null;
    }
    return node && node.valuetype ? node : null;
  }
  const selected = arr => (arr || []).find(x => x.selected && x.selected.value === true) || (arr || [])[0];
  function selectedClip(c) {
    for (const l of c.layers || [])
      for (const k of l.clips || [])
        if (k.selected && k.selected.value === true) return k;
    return null;
  }

  /* ---- listening --------------------------------------------------------- */
  const TYPING = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' || el.isContentEditable);

  function onKey(ev) {
    if (!M.enabled || TYPING(ev.target)) return;
    if (ev.metaKey) return;                       // leave the OS its own keys
    const code = codeOf(ev);
    if (code == null) return;
    const hits = M.table.filter(e => e.code === code);
    if (!hits.length) return;
    /* the shipped map records a modifier lane per shortcut; match it so a
       plain key and a modified key with the same code stay distinct */
    const mod = (ev.ctrlKey ? 1 : 0) | (ev.shiftKey ? 2 : 0) | (ev.altKey ? 4 : 0);
    const pick = hits.find(e => (mod === 0) === (e.flag_lo === 0)) || hits[0];
    ev.preventDefault();
    run(pick).then(r => {
      M.lastFired = { key: pick.key, path: pick.path, ...r };
      M.log.unshift(M.lastFired);
      if (M.log.length > 50) M.log.pop();
      if (M.onfire) M.onfire(M.lastFired);
    });
  }

  function attach(target) {
    (target || window).addEventListener('keydown', onKey);
    return () => (target || window).removeEventListener('keydown', onKey);
  }

  /* what is bound, for a shortcuts panel or a cheat sheet */
  function bindings() {
    return M.table.map(e => ({
      key: e.key === ' ' ? 'Space' : (e.key || '').toUpperCase(),
      modified: e.flag_lo !== 0,
      path: e.path, kind: e.kind,
      resolves: AL.status !== 'live' ? null
        : !!(SYNTH[norm(e.path.split('/').pop())] || e.kind === 'action' || resolve(e.path)),
    }));
  }

  Object.assign(M, { build, attach, run, resolve, bindings, keyName, codeOf });
  build();
  return M;
})();
