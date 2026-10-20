/* ===========================================================================
   panels/shortcuts.js — the Shortcuts panel.
   ---------------------------------------------------------------------------
   This one has real decoded data. RESOLUME.arena.shortcuts carries the shipped
   keyboard preset (42 shortcuts), four MIDI controller maps — APC 40 MK II 71,
   APC MINI MK II 90, APC MINI 42, Nano Kontrol 2 25 — and the 146 distinct
   parameter addresses they drive between them.

   The address in a shortcut is Arena's shortcut/OSC address space, which is
   NOT the REST resource space, and the two disagree in ways nothing else will
   tell you: /composition/disconnectall is a shortcut address and 404s over
   REST, where the REST spelling is /composition/disconnect-all; nothing at all
   answers for /composition/tempocontroller. So every row is cross-checked
   against RESOLUME.arena.api and marked with what the REST layer will and will
   not give you.

   The trigger column is decoded from each shortcut's own 64-bit `raw`:
     keyboard   bits 32..63 key code — ASCII for character keys, 0x10000 | the
                virtual key for the arrows — bits 0..31 JUCE modifier flags
                (1 shift, 2 ctrl, 4 alt, 8 command)
     MIDI       bits 56..63 message kind (1 note, 2 controller), low byte the
                status byte (channel in its low nibble), next byte the data byte
   Both decodes were confirmed against the data itself: the QWERTYUI row comes
   out as clips 1..8 of the selected layer, comma and period as the tempo and
   slash as the resync, 1..9 as the layers and Shift+1..9 as the columns, and
   the kind field agrees with the status nibble on all 228 MIDI entries. Every
   row still carries its raw value in the tooltip, so nothing is hidden behind
   the decode.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

const SC = () => (window.RESOLUME && window.RESOLUME.arena && window.RESOLUME.arena.shortcuts) || null;

/* ---- raw decoding -------------------------------------------------------- */
const VK = { 0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x1b: 'Esc', 0x21: 'Page Up',
  0x22: 'Page Down', 0x23: 'End', 0x24: 'Home', 0x25: '←', 0x26: '↑',
  0x27: '→', 0x28: '↓', 0x2d: 'Insert', 0x2e: 'Delete' };
const MODS = [[1, 'Shift'], [2, 'Ctrl'], [4, 'Alt'], [8, 'Cmd']];

function keyName(code) {
  if (code & 0x10000) return VK[code & 0xffff] || ('key 0x' + (code & 0xffff).toString(16));
  if (code === 32) return 'Space';
  if (code > 32 && code < 127) return String.fromCharCode(code);
  return 'key 0x' + code.toString(16);
}
function decodeKey(raw) {
  const r = BigInt(raw), code = Number(r >> 32n), mod = Number(r & 0xffffffffn);
  const label = MODS.filter(m => mod & m[0]).map(m => m[1]).concat(keyName(code)).join(' + ');
  return { label, hex: '0x' + r.toString(16).padStart(16, '0') };
}
function decodeMidi(raw) {
  const r = BigInt(raw);
  const kind = Number(r >> 56n), st = Number(r & 0xffn), d1 = Number((r >> 8n) & 0xffn);
  const hex = '0x' + r.toString(16).padStart(16, '0');
  /* only trust the decode when the kind field and the status nibble agree */
  if (kind === 1 && (st & 0xf0) === 0x90) return { label: `Note ${d1} · ch ${(st & 15) + 1}`, hex };
  if (kind === 2 && (st & 0xf0) === 0xb0) return { label: `CC ${d1} · ch ${(st & 15) + 1}`, hex };
  return { label: hex, hex };
}

/* ---- the cross-check: does the REST layer carry this address? ----------- */
const segs = p => String(p).replace(/^\//, '').split('/');
function tmatch(tmpl, path) {
  const a = segs(tmpl), b = segs(path);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== '{' && a[i] !== b[i]) return false;
  return true;
}
let OPS = null;
function ops() {
  if (OPS) return OPS;
  const api = (window.RESOLUME && window.RESOLUME.arena && window.RESOLUME.arena.api) || {};
  OPS = [];
  Object.values(api).forEach(g => (g || []).forEach(o => OPS.push(o)));
  return OPS;
}
const restCache = new Map();
function restFor(path) {
  if (!restCache.has(path)) restCache.set(path, ops().find(o => tmatch(o.path, path)) || null);
  return restCache.get(path);
}

/* An address with no endpoint may still be a live parameter, reachable only
   over the websocket parameter channel. Resolve it against the running
   composition rather than guess: segment names are matched case- and
   punctuation-insensitively, because the address space writes tempo_tap as
   tempotap and "Link 1" as link1. */
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function step(node, seg) {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return /^\d+$/.test(seg) ? node[+seg - 1] : undefined;
  const k = Object.keys(node).find(x => norm(x) === norm(seg));
  return k === undefined ? undefined : node[k];
}
const selectedOf = arr => (arr || []).find(x => x && x.selected && x.selected.value === true) || null;
function selectedClip(c) {
  for (const l of (c.layers || [])) for (const k of (l.clips || []))
    if (k && k.selected && k.selected.value === true) return k;
  return null;
}
function liveParam(path) {
  const c = AL.comp;
  if (!c) return null;
  const parts = segs(path);
  if (parts.shift() !== 'composition') return null;
  let n = c;
  for (const s of parts) {
    if (s === 'selectedlayer') { n = selectedOf(c.layers); if (!n) return null; continue; }
    if (s === 'selectedclip') { n = selectedClip(c); if (!n) return null; continue; }
    n = step(n, s);
    if (n === undefined) return null;
  }
  return (n && n.valuetype && n.id != null) ? n : null;
}

function badge(path) {
  const r = restFor(path);
  if (r) return { cls: 'on', txt: 'REST',
    tip: r.path + '  [' + (r.methods || []).join(', ') + ']' + (r.summary ? '\n' + r.summary : '') };
  const p = AL.status === 'live' ? liveParam(path) : null;
  if (p) return { cls: 'mid', txt: 'param',
    tip: 'no REST endpoint. Resolves in the running Show to parameter #' + p.id +
         ' (' + p.valuetype + '), which only the websocket parameter channel can set.' };
  return { cls: '', txt: 'no endpoint',
    tip: 'RESOLUME.arena.api has no path matching this address.' +
         (AL.status === 'live' ? ' It does not resolve to a parameter in the running Show either.'
                               : ' Connect to test whether it is a live parameter.') };
}

/* ---- stylesheet, once per page ----------------------------------------- */
function css() {
  if (document.getElementById('sc-css')) return;
  const s = document.createElement('style');
  s.id = 'sc-css';
  s.textContent = `
.sc{ display:flex; flex-direction:column; height:100%; min-height:180px; }
.sc-tabs{ overflow-x:auto; scrollbar-width:none; flex:0 0 auto; background:var(--head); }
.sc-tabs::-webkit-scrollbar{ height:0; }
.sc-tabs .ptab{ white-space:nowrap; }
.sc-tabs .ptab .p-dim{ color:var(--n700); font-size:9.5px; }
.sc-body{ flex:1 1 auto; min-height:0; overflow:auto; }
.sc-row{ display:grid; grid-template-columns:118px minmax(0,1fr) auto; }
.sc-k{ color:var(--n200); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  font-variant-numeric:tabular-nums; }
.sc-p{ color:var(--n400); font-size:10.5px; font-family:ui-monospace,Menlo,Consolas,monospace;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sc-b{ font-size:8.5px; letter-spacing:.07em; text-transform:uppercase; padding:0 6px;
  border:1px solid var(--n800); border-radius:999px; color:var(--n600); white-space:nowrap; }
.sc-b.on{ color:var(--a200); border-color:var(--color-accent); }
.sc-b.mid{ color:var(--n300); border-color:var(--n700); }
.sc-none{ padding:var(--space-4) var(--space-3); color:var(--n700); font-size:11px; }`;
  document.head.appendChild(s);
}

/* ---- rows --------------------------------------------------------------- */
const row = (tab, trig, path, tip) => {
  const b = badge(path);
  return `<div class="p-row sc-row" data-tab="${Kit.esc(tab)}">
    <span class="sc-k" title="${Kit.esc(tip)}">${Kit.esc(trig)}</span>
    <span class="sc-p" title="${Kit.esc(path)}">${Kit.esc(path)}</span>
    <span class="sc-b ${b.cls}" title="${Kit.esc(b.tip)}">${Kit.esc(b.txt)}</span></div>`;
};

function tabs() {
  const sc = SC();
  if (!sc) return [];
  const out = [];
  const kb = sc.keyboard || [];
  out.push({
    id: 'kb', label: 'Keyboard', n: kb.length,
    rows: kb.map(s => {
      const d = decodeKey(s.raw);
      const extra = [d.hex, s.behaviour != null ? 'behaviour ' + s.behaviour : '',
        s.subtarget ? 'subtarget type ' + s.subtarget.type + ' option ' + s.subtarget.optionIndex : '']
        .filter(Boolean).join(' · ');
      return { path: s.path, html: row('kb', d.label, s.path, extra) };
    })
  });
  Object.entries(sc.midi || {}).forEach(([name, list], i) => {
    const id = 'm' + i;
    out.push({
      id, label: name, n: (list || []).length,
      rows: (list || []).map(s => {
        const d = decodeMidi(s.raw);
        return { path: s.path, html: row(id, d.label, s.path, d.hex) };
      })
    });
  });
  /* the union tab: every distinct address once, with who binds it */
  const users = new Map();
  out.forEach(t => t.rows.forEach(r => {
    if (!users.has(r.path)) users.set(r.path, []);
    const u = users.get(r.path);
    if (u.indexOf(t.label) < 0) u.push(t.label);
  }));
  const all = (sc.paths || []).map(p => {
    const u = users.get(p) || [];
    return { path: p, html: row('all', u.length + (u.length === 1 ? ' map' : ' maps'), p,
      u.length ? 'bound in ' + u.join(', ') : 'in the decoded path list, bound in none of the shipped presets') };
  });
  out.push({ id: 'all', label: 'All addresses', n: all.length, rows: all });
  return out;
}

/* ---- view state survives the five-second composition repaint ------------ */
function applyView(host) {
  const tab = host._scTab, q = (host._scQ || '').toLowerCase();
  let shown = 0;
  host.querySelectorAll('.sc-row').forEach(r => {
    const on = r.dataset.tab === tab && (!q || r.textContent.toLowerCase().includes(q));
    r.style.display = on ? '' : 'none';
    if (on) shown++;
  });
  host.querySelectorAll('.sc-tabs .ptab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  const empty = host.querySelector('[data-empty]');
  if (empty) empty.style.display = shown ? 'none' : '';
  const count = host.querySelector('[data-count]');
  if (count) count.textContent = shown + ' shown';
}

function render(host) {
  const T = tabs();
  if (!T.length) {
    host.innerHTML = Kit.unavailable('No decoded shortcuts',
      'RESOLUME.arena.shortcuts is not loaded, so there is nothing to show.');
    return;
  }
  if (!T.some(t => t.id === host._scTab)) host._scTab = T[0].id;

  const rest = T.map(t => t.rows.filter(r => restFor(r.path)).length);
  const summary = T.map((t, i) =>
    `<div class="p-row"><span>${Kit.esc(t.label)}</span>
      <span class="p-dim">${t.n} shortcuts · ${rest[i]} with a REST endpoint</span></div>`).join('');

  host.innerHTML =
    `<div class="sc">` +
    Kit.toolbar(`<input type="text" data-q placeholder="Filter by key, controller or address"
        value="${Kit.esc(host._scQ || '')}">
      <span class="sc-b" data-count></span>`) +
    `<div class="ptabs br-tabs sc-tabs">${T.map(t =>
        `<div class="ptab" data-tab="${Kit.esc(t.id)}">${Kit.esc(t.label)}
           <span class="p-dim" style="margin-left:5px">${t.n}</span></div>`).join('')}</div>
     <div class="sc-body">
       ${T.map(t => t.rows.map(r => r.html).join('')).join('')}
       <div class="sc-none" data-empty style="display:none">Nothing matches that filter.</div>` +
      Kit.section('What the marks mean',
        `<div class="p-note"><b>REST</b>: RESOLUME.arena.api has an endpoint whose template matches
          this address. Hover the mark for the template and its methods.</div>
         <div class="p-note"><b>param</b>: no endpoint, but the address resolves in the running
          Show to a parameter, which only the websocket parameter channel can set.</div>
         <div class="p-note"><b>no endpoint</b>: RESOLUME.arena.api carries no path for it. The
          shortcut address space is not the REST resource space: <i>/composition/disconnectall</i>
          is a shortcut address and 404s over REST, where the REST spelling is
          <i>/composition/disconnect-all</i>; <i>/composition/tempocontroller</i> and
          <i>/composition/dashboard</i> have no REST resource at all.</div>
         <div class="p-note">The Cue trigger (Resolume column) is decoded from each shortcut's own 64-bit raw
          value, which every row carries in its tooltip. Keyboard: key code in the high 32 bits,
          modifier flags in the low 32. MIDI: message kind above the status and data bytes.</div>`,
        { folded: true }) +
      Kit.section('Coverage', summary, { folded: true }) +
    `</div></div>`;

  Kit.bind(host);
  host.querySelectorAll('.sc-tabs .ptab').forEach(t => t.addEventListener('click', () => {
    host._scTab = t.dataset.tab;
    host.querySelector('.sc-body').scrollTop = 0;
    applyView(host);
  }));
  const q = host.querySelector('[data-q]');
  q.addEventListener('input', () => { host._scQ = q.value; applyView(host); });
  applyView(host);
}

WS.register('Shortcuts', {
  title: 'Shortcuts',
  build(host) {
    css();
    host._scTab = host._scTab || null;
    host._scQ = host._scQ || '';
    let sig = null;
    Kit.live(host, () => {
      /* the only live thing here is whether an address resolves to a parameter,
         so rebuild on the connection and on structural change — not on every
         push, which would drop the open tab and the filter */
      const c = AL.comp;
      const next = AL.status + ' ' + (c ? (c.layers || []).length + '/' + (c.columns || []).length
                                        + '/' + AL.val(c.name) : '-');
      if (next === sig) return;
      sig = next;
      render(host);
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
