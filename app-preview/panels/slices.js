/* ===========================================================================
   panels/slices.js — the Slices panel.
   ---------------------------------------------------------------------------
   Arena's Slices panel is a browser onto the Advanced Output: every screen,
   slice, mask, polygon and DMX fixture currently set up, draggable onto a
   Composition/Group/Layer/Clip to use as an effect input.

   The REST API does not carry any of it. Verified twice against the running
   Arena 7.27.1 rev 15990 on this machine:
     · extracted/arena-api.json — 258 paths, 295 operations; nothing matching
       slice / screen / output / warp / dmx / lumiverse
     · GET /api/v1/composition — top-level keys are name, selected, bypassed,
       master, speed, cliptarget, cliptriggerstyle, clipbeatsnap, dashboard,
       audio, video, crossfader, decks, layers, columns, layergroups,
       tempocontroller, autopilot. No screens, no slices.
   So this panel states the gap, proves it live, and then shows the decoded
   Advanced Output vocabulary so the reference is at least here. Everything
   below the fold is DECODED REFERENCE, not your output.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

const RA = () => (window.RESOLUME || {}).arena || {};

/* arena-data.js declares its vocabularies as top-level const, which lands in
   the global lexical scope and never on window — name them directly, guarded,
   so a data file that failed to load leaves a hole instead of fiction. */
const V = {
  tools: typeof AO_SLICE_TOOLS     !== 'undefined' ? AO_SLICE_TOOLS     : null,
  add:   typeof AO_ADD_MENU        !== 'undefined' ? AO_ADD_MENU        : null,
  screen:typeof AO_NEW_SCREEN      !== 'undefined' ? AO_NEW_SCREEN      : null,
  ctx:   typeof AO_SLICE_CTX       !== 'undefined' ? AO_SLICE_CTX       : null,
  filter:typeof AO_FILTER_MODES    !== 'undefined' ? AO_FILTER_MODES    : null,
  warp:  typeof AO_WARP_MODES      !== 'undefined' ? AO_WARP_MODES      : null,
  space: typeof DMX_COLOR_SPACES   !== 'undefined' ? DMX_COLOR_SPACES   : null,
  extra: typeof DMX_EXTRA_CHANNELS !== 'undefined' ? DMX_EXTRA_CHANNELS : null,
  lumi:  typeof LUMIVERSES         !== 'undefined' ? LUMIVERSES         : null,
};

/* GET, never OPTIONS: Arena's webserver answers OPTIONS with 200 for any URL
   at all — it is only the CORS preflight — so a GET is the one honest test of
   whether a path exists. All five are reads. */
const PROBE = ['/composition/screens', '/composition/output', '/screens', '/slices', '/output'];

/* ---- reference renderers ------------------------------------------------ */
const chips = (arr, empty) => (arr && arr.length)
  ? `<div class="p-grid">${arr.map(v =>
      `<div class="p-row"><span>${Kit.esc(v)}</span></div>`).join('')}</div>`
  : Kit.nothing(empty);

const helpRows = (items, empty) => (items && items.length)
  ? `<div class="p-list">${items.map(c =>
      `<div class="p-row" title="${Kit.esc(c.help || c.title)}"><span>${Kit.esc(c.title)}</span>
        <span class="p-dim">${Kit.esc(c.id)}</span></div>`).join('')}</div>`
  : Kit.nothing(empty);

/* the fixture personalities that ship with Arena, exactly as their XML holds
   them — choice parameters are stored as an index, so they are shown as one */
function fixtures() {
  const f = RA().fixtures || [];
  if (!f.length) return Kit.nothing('No decoded fixture personalities.');
  return `<div class="p-note">Values verbatim from the personality XML.</div>` +
    f.map(fx => {
      const p = fx.parameters || {};
      const rows = Object.entries(p)
        .filter(([k]) => !/\.(default|storage|storeChoices|uuid)$/.test(k))
        .map(([k, v]) => `<div class="p-row"><span>${Kit.esc(k)}</span>
          <span class="p-dim">${Kit.esc(v && v.value)}</span></div>`).join('');
      return Kit.section(fx.name, `<div class="p-list">${rows}</div>`,
        { folded: true, tag: fx.file || '' });
    }).join('');
}

/* what the REST API does carry, so the gap is bounded rather than asserted */
function restNote() {
  const a = RA().api_summary, groups = Object.keys(RA().api || {});
  if (!a || !groups.length) return Kit.nothing('No decoded API index.');
  return `<div class="p-note">${a.paths} paths, ${a.operations} operations in this build's
    own swagger.yaml. Every path sits under one of these ${groups.length} roots:</div>` +
    chips(groups.sort(), 'none');
}

/* ---- live evidence ------------------------------------------------------ */
function paintLive(host) {
  const live = host.querySelector('[data-live]');
  const keys = host.querySelector('[data-comp-keys]');
  if (!live) return;
  if (AL.status !== 'live' || !AL.comp) {
    live.innerHTML = Kit.offline('SHOWAVE Map is not exposed by the Resolume API: the reference below still stands.');
    if (keys) keys.innerHTML = Kit.nothing('Connect to read the Show back.');
    return;
  }
  const c = AL.comp, w = AL.val(c.video && c.video.width), h = AL.val(c.video && c.video.height);
  live.innerHTML = `<div class="p-note">${Kit.esc(AL.val(c.name) || 'Untitled')}${
    (w && h) ? ` · input canvas ${Math.round(w)} × ${Math.round(h)} px: the space slice
      input positions are measured in` : ''}</div>`;
  if (keys) keys.innerHTML =
    `<div class="p-note">The Show Arena just sent has these top-level keys: no
      screens, no slices:</div>` + chips(Object.keys(c), 'none');
  applyFilter(host);
}

/* ---- probe --------------------------------------------------------------- */
async function runProbe(host) {
  const box = host.querySelector('[data-probe]');
  if (!box) return;
  if (AL.status !== 'live') { box.innerHTML = Kit.nothing('Not connected: nothing to ask.'); return; }
  box.innerHTML = '<div class="p-note">asking…</div>';
  const rows = [];
  for (const p of PROBE) {
    let dim;
    try { await AL.rest(p); dim = '200: answered'; }
    catch (e) {
      const m = /^(\d{3})\b/.exec(String(e && e.message) || '');
      dim = m ? m[1] + ': not a path' : 'no answer';
    }
    rows.push({ label: p, dim });
  }
  box.innerHTML = Kit.list(rows);
  applyFilter(host);
}

/* typing in the toolbar filters every reference row; a section whose own title
   matches keeps all of its rows, and a section left with nothing visible gets
   out of the way rather than sitting there empty. Written out rather than taken
   from Kit.searchFilter because it has to survive a live repaint. */
function applyFilter(host) {
  const inp = host.querySelector('[data-find]');
  const q = inp ? inp.value.trim().toLowerCase() : '';
  const titled = sec => {
    for (let n = sec; n; n = n.parentElement && n.parentElement.closest('.p-sec'))
      if ((n.dataset.sec || '').toLowerCase().includes(q)) return true;
    return false;
  };
  host.querySelectorAll('.p-row').forEach(r => {
    const sec = r.closest('.p-sec');
    r.style.display = (!q || r.textContent.toLowerCase().includes(q) ||
      (sec && titled(sec))) ? '' : 'none';
  });
  host.querySelectorAll('.p-sec').forEach(sec => {
    const rows = sec.querySelectorAll('.p-row');
    sec.style.display =
      (!rows.length || [...rows].some(r => r.style.display !== 'none')) ? '' : 'none';
  });
}

WS.register('Slices', {
  title: 'Slices',
  build(host) {
    const out = Kit.components('Output');
    const browser = out.find(c => c.title === 'Slice Browser');

    host.innerHTML =
      Kit.toolbar(`<input type="text" data-find placeholder="Filter the reference">
        <button class="btn" data-probe-run
          title="GET each candidate path and report what Arena answers">Probe the API</button>`) +
      `<div data-live></div>` +
      Kit.section('SHOWAVE Map',
        Kit.unavailable('Resolume REST does not expose SHOWAVE Map',
          'Screens, slices, masks, polygons, warps, DMX fixtures and Lumiverses are ' +
          'reachable only in Arena\'s own Advanced Output window. This build serves no ' +
          'path for any of them and the Show payload contains none of them, so ' +
          'nothing here can show or change your output.') +
        (browser ? `<div class="p-note">Arena describes this panel as: ${Kit.esc(browser.help)}</div>` : '') +
        `<div data-probe></div>` +
        `<div data-comp-keys></div>`) +
      Kit.section('Slice Tools', chips(V.tools, 'AO_SLICE_TOOLS not loaded.'),
        { tag: 'decoded reference' }) +
      Kit.section('Add', chips(V.add, 'AO_ADD_MENU not loaded.'),
        { tag: 'decoded reference' }) +
      Kit.section('New Screen', chips(V.screen, 'AO_NEW_SCREEN not loaded.'),
        { tag: 'decoded reference' }) +
      Kit.section('Slice Context Menu', chips(V.ctx, 'AO_SLICE_CTX not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('Warp Modes', chips(V.warp, 'AO_WARP_MODES not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('Filter Modes', chips(V.filter, 'AO_FILTER_MODES not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('Lumiverses', chips(V.lumi, 'LUMIVERSES not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('DMX Colour Spaces', chips(V.space, 'DMX_COLOR_SPACES not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('DMX Extra Channels', chips(V.extra, 'DMX_EXTRA_CHANNELS not loaded.'),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('Fixture Personalities', fixtures(),
        { tag: 'decoded reference', folded: true }) +
      Kit.section('SHOWAVE Map Controls',
        `<div class="p-note">Every control Arena's Advanced Output carries, with the
          application's own id and its help text on hover. None of them are reachable
          from here.</div>` + helpRows(out, 'No decoded Output components.'),
        { tag: String(out.length), folded: true }) +
      Kit.section('REST Surface', restNote(), { tag: 'decoded reference', folded: true });

    Kit.bind(host);                         // no live parameters here — this wires the folds
    const inp = host.querySelector('[data-find]');
    if (inp) inp.addEventListener('input', () => applyFilter(host));
    const btn = host.querySelector('[data-probe-run]');
    if (btn) btn.addEventListener('click', () => runProbe(host).catch(e => console.warn(e)));

    Kit.live(host, () => paintLive(host));
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
