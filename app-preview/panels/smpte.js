/* ===========================================================================
   panels/smpte.js — the SMPTE panel.
   ---------------------------------------------------------------------------
   In Arena this panel is two big timecode readouts, one per SMPTE input, and a
   cogwheel that recolours them. The layout node says as much and nothing more:

     <SMPTE ...><SMPTE1 colorIndex="3"/><SMPTE2 colorIndex="3"/></SMPTE>

   The timecode itself cannot be shown here, and the panel says so rather than
   animating a plausible number. Checked three ways before writing this file:
     · extracted/arena-api.json — 258 paths, 295 operations, not one of them
       matches smpte / timecode / clock (the panel recounts that at runtime)
     · the 38 decoded schemas carry TransportTimeline and TransportBPMSync;
       there is no SMPTE transport document
     · in the live composition the strings "SMPTE 1" and "SMPTE 2" occur only
       as options of a clip's transporttype — no input, level, offset or
       framerate is published anywhere in the tree
   So what this panel can honestly do is show which clips are listening to
   which input, and the decoded reference for everything the REST surface
   drops on the floor.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

const R = () => (window.RESOLUME && window.RESOLUME.arena) || {};
const SMPTE = /smpte/i;

/* ---- the layout's SMPTE1 / SMPTE2 children ----------------------------- */
function displaysIn(node) {
  const list = ((node && node.children) || [])
    .filter(c => c.type === 'SMPTE1' || c.type === 'SMPTE2');
  return list.length ? list : null;
}
/* an undocked panel gets a bare node, so fall back to the shipped presets */
function shippedDisplays() {
  const L = R().layouts || {};
  for (const name of Object.keys(L)) {
    let hit = null;
    (function walk(n) {
      if (!n || hit) return;
      if (n.type === 'SMPTE') { hit = n; return; }
      (n.children || []).forEach(walk);
    })({ children: (L[name].windows || []).concat(L[name].hidden || []) });
    const d = hit && displaysIn(hit);
    if (d) return JSON.parse(JSON.stringify(d));
  }
  return [];
}

/* ---- what the REST surface does and does not carry --------------------- */
function apiPaths(re) {
  const out = [];
  Object.values(R().api || {}).forEach(list =>
    (list || []).forEach(e => { if (re.test(e.path)) out.push(e.path); }));
  return out;
}
function why() {
  const total = (R().api_summary || {}).paths;
  const hits = apiPaths(/smpte|timecode|clock/i).length;
  const tr = Object.keys(R().schemas || {}).filter(s => /^Transport/.test(s)).sort();
  return `Arena's web API publishes no timecode. ${hits} of its ${total} decoded paths `
       + `mention SMPTE, timecode or a clock, and the transport documents it does define `
       + `are ${tr.join(' and ')}: there is no SMPTE transport. A clip can be told to `
       + `listen to SMPTE 1 or SMPTE 2 over the API; the incoming timecode, the input `
       + `selection, the framerate and the delay compensation live only in the application.`;
}

/* ---- clips listening to a SMPTE input ---------------------------------- */
function listeners() {
  const out = [];
  const n = AL.layers().length;
  for (let l = 1; l <= n; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++) {
      const k = clips[c - 1];
      const tt = k && k.transporttype ? String(AL.val(k.transporttype)) : '';
      if (SMPTE.test(tt)) out.push({ l, c, k, tt });
    }
  }
  return out;
}

/* ---- the decoded component manifest, filtered to this panel's subject --- */
function components() {
  const groups = R().components || {};
  const seen = new Set(), out = [];
  Object.entries(groups).forEach(([g, items]) => (items || []).forEach(it => {
    const blob = [it.id, it.title, it.help].concat(it.context || []).join(' ');
    if (!SMPTE.test(blob)) return;
    const key = it.title + '|' + it.help;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ group: g, title: it.title, help: it.help, id: it.id });
  }));
  return out;
}

WS.register('SMPTE', {
  title: 'SMPTE',
  build(host, node) {
    const displays = displaysIn(node) || shippedDisplays();

    Kit.live(host, () => {
      host.innerHTML =
        Kit.unavailable('SMPTE timecode is not on the REST surface', why()) +
        live() +
        Kit.section('Displays · from the layout',
          (displays.length
            ? `<div class="p-list">${displays.map(d =>
                `<div class="p-row"><span>${Kit.esc(d.type)}</span>
                   <span class="p-dim">colorIndex ${Kit.esc(d.colorIndex ?? '?')}</span></div>`).join('')}</div>`
            : '<div class="p-note">This layout gives the panel no displays.</div>') +
          `<div class="p-note">Both readouts ship on colour index 3 in all eight layouts
             that place this panel. The index picks one of Arena's display colours; the
             palette behind it is in no decoded table, so nothing here is tinted from a
             colour we would have had to invent.</div>`) +
        reference();

      Kit.bind(host);
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});

/* ---- live: who is listening -------------------------------------------- */
function live() {
  if (AL.status !== 'live')
    return Kit.section('Clips on SMPTE',
      Kit.offline('Which clips listen to which input is read from the live Show.'));

  const opts = transportOptions();
  const smpteOpts = opts.filter(o => SMPTE.test(o));
  const hits = listeners();

  const head = opts.length
    ? `<div class="p-list">${opts.map(o =>
        `<div class="p-row${SMPTE.test(o) ? ' sel' : ''}"><span>${Kit.esc(o)}</span>${
          SMPTE.test(o) ? '<span class="p-dim">SMPTE input</span>' : ''}</div>`).join('')}</div>
       <div class="p-note">A clip's transporttype, live from this Show:
         ${smpteOpts.length} of its ${opts.length} options are SMPTE inputs. Setting a clip
         to one of them is the whole of what the API can do with SMPTE.</div>`
    : '<div class="p-note">No clip in this Show, so no transport type to read.</div>';

  const body = hits.length
    ? `<div class="p-list">${hits.map(h =>
        `<div class="p-row"><span>${Kit.esc(
            Kit.dispName(AL.val((AL.layer(h.l) || {}).name), h.l))} · ${Kit.esc(
            Kit.dispName(AL.val((AL.column(h.c) || {}).name), h.c))}${
            AL.val(h.k.name) ? ' · ' + Kit.esc(AL.val(h.k.name)) : ''}</span>
          <span class="p-dim">${Kit.esc(h.tt)}</span></div>`).join('')}</div>` +
      hits.map(h => transportOf(h)).join('')
    : '<div class="p-note">No clip in this Show is set to SMPTE 1 or SMPTE 2.</div>';

  return Kit.section('Transport types', head, { folded: true }) +
         Kit.section('Clips on SMPTE', body, { tag: String(hits.length) });
}

/* the option list is the same on every clip, so take it from the first one
   that has a transporttype at all rather than assuming it */
function transportOptions() {
  const n = AL.layers().length;
  for (let l = 1; l <= n; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++) {
      const t = clips[c - 1] && clips[c - 1].transporttype;
      if (t && t.options) return t.options;
    }
  }
  return [];
}

/* whatever transport document a SMPTE clip actually carries, shown as it is */
function transportOf(h) {
  const tr = h.k.transport;
  const ctl = tr && tr.controls;
  if (!ctl) return '';
  Object.values(ctl).forEach(p => p && p.id != null && AL.subscribe(p.id));
  if (tr.position && tr.position.id != null) AL.subscribe(tr.position.id);
  return Kit.section(`${AL.val(h.k.name) || 'Clip'} · transport`,
    Kit.params(ctl) +
    (tr.position
      ? `<div class="p-note">position runs ${tr.position.min}…${tr.position.max}; the Clip Time
           panel counts it. Arena drives it from the incoming timecode.</div>`
      : ''),
    { folded: true, tag: h.tt });
}

/* ---- decoded reference -------------------------------------------------- */
function reference() {
  const comps = components();
  const strings = Object.keys(Kit.strings()).filter(s => SMPTE.test(s)).sort();

  return Kit.section('What Arena carries · decoded controls',
    (comps.length
      ? comps.map(c =>
          `<div class="p-row" title="${Kit.esc(c.id)}"><span>${Kit.esc(c.title)}</span>
             <span class="p-dim">${Kit.esc(c.group)}</span></div>
           <div class="p-note">${Kit.esc(c.help)}</div>`).join('')
      : '<div class="p-note">Nothing in the component manifest matches SMPTE.</div>') +
    `<div class="p-note">${comps.length} controls out of the ${
      R().component_count ?? 'N/A'} in the manifest. Every one of them is in the
      application only: Preferences › Audio picks the inputs and the framerate,
      the toolbar carries the delay compensation.</div>`, { folded: true }) +

  Kit.section('Interface strings',
    strings.length
      ? `<div class="p-list">${strings.map(s =>
          `<div class="p-row"><span>${Kit.esc(s)}</span></div>`).join('')}</div>`
      : '<div class="p-note">No SMPTE strings in the decoded table.</div>', { folded: true }) +

  Kit.section('Paths searched',
    `<div class="p-note">Looked for smpte, timecode and clock across the ${
      (R().api_summary || {}).paths} decoded REST paths and the ${
      Object.keys(R().schemas || {}).length} schemas. Matches: ${
      apiPaths(/smpte|timecode|clock/i).length}. If a future Arena publishes them,
      this panel is where they belong.</div>`, { folded: true });
}
})();
