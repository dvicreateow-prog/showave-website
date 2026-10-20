/* ===========================================================================
   panels/recording.js — the Recording panel.
   ---------------------------------------------------------------------------
   Recording is one of the known gaps. The decoded REST surface of 7.27.1 is
   258 paths / 295 operations across 22 groups, and not one path contains
   record, codec, render or queue — the only capture-shaped endpoints in the
   whole API are the three /composition/monitors/{id}/snapshot stills, one
   frame each. A live Arena confirms it: /composition/record, /recording and
   /renderqueue all answer 404, while a path that does exist answers 405 to a
   GET, which is what makes GET a usable existence probe.

   So there is no arm, no roll, no stop to offer. What this panel does instead
   is show the decoded reference the application itself carries: its own record
   controls with their help text, the states the recorder reports, the codecs
   it offers, and the eleven Render and Record presets with their real values.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* arena-data.js declares these at top level, so they are lexical globals and
   not properties of window — reach them by typeof, never by window.X */
const recordStates = () => (typeof RECORD_STATES !== 'undefined' ? RECORD_STATES : null);
const codecs       = () => (typeof CODECS !== 'undefined' ? CODECS : null);

const apiOps = () => {
  const api = (window.RESOLUME && window.RESOLUME.arena && window.RESOLUME.arena.api) || {};
  const out = [];
  Object.values(api).forEach(g => (g || []).forEach(o => out.push(o)));
  return out;
};

/* the claim this panel makes, recomputed rather than asserted */
function gapProof() {
  const ops = apiOps();
  /* paths only — "render" turns up in one summary, for "render targets", which
     are the monitors and have nothing to do with capture */
  return {
    total: ops.length,
    hits: ops.filter(o => /record|codec|render|queue|mux|preroll/i.test(o.path)).length,
    snaps: ops.filter(o => /snapshot/i.test(o.path)).length,
  };
}

function controlList() {
  const c = Kit.components('Record');
  if (!c.length) return '<div class="p-note">The component manifest is not loaded.</div>';
  return c.map(x => `<div class="p-row"><span>${Kit.esc(x.title || x.id)}</span>
      <span class="p-dim">${Kit.esc(x.id || '')}</span></div>` +
    (x.help ? `<div class="p-note">${Kit.esc(x.help)}</div>` : '')).join('');
}

function presetBlocks() {
  const list = Kit.presets('Render and Record');
  if (!list.length) return '<div class="p-note">No Render and Record presets decoded.</div>';
  return list.map(p => {
    const params = Object.entries(p.params || {});
    const body = params.length
      ? `<div class="p-list">${params.map(([k, v]) =>
          `<div class="p-row"><span>${Kit.esc(k)}</span><span class="p-dim">${Kit.esc(v)}</span></div>`
        ).join('')}</div>`
      : '<div class="p-note">no parameters</div>';
    return Kit.section(p.name, body, { folded: true, tag: p.version || '' });
  }).join('');
}

/* GET is the only reliable existence probe: Arena answers 404 for a path it
   does not have and 405 for one it has but will not GET. OPTIONS returns 200
   for everything, so it proves nothing. Read-only either way. */
async function probe(host) {
  const paths = ['/composition/record', '/composition/recording', '/renderqueue'];
  const out = [];
  for (const p of paths) {
    try { await AL.rest(p); out.push(p + ' → 200'); }
    catch (e) { out.push(p + ' → ' + (/^\d+/.exec(String(e.message)) || ['?'])[0]); }
  }
  const cell = host.querySelector('[data-probe]');
  if (cell && host.isConnected) cell.textContent = 'Asked this Arena directly: ' + out.join(' · ');
}

WS.register('Recording', {
  title: 'Recording',
  build(host) {
    let sig = null;
    Kit.live(host, () => {
      /* nothing here is live state, so repaint only when the connection itself
         changes — otherwise the five-second composition push would fold every
         section back up under the reader */
      if (AL.status === sig) return;
      sig = AL.status;

      const gap = gapProof();
      const states = recordStates(), cod = codecs();
      const ctrls = Kit.components('Record'), presets = Kit.presets('Render and Record');

      host.innerHTML =
        Kit.unavailable('Recording is not in the REST API',
          `Arena's webserver exposes ${gap.total} paths and ${gap.hits} of them contain record, `
          + `codec, render or queue. The only capture-shaped endpoints are the ${gap.snaps} monitor `
          + `snapshot stills, which return one frame. Nothing on this page can arm, start or stop a `
          + `recording: the transport for it does not exist. Everything below is decoded reference.`) +
        `<div class="p-note" data-probe>${AL.status === 'live'
          ? 'Asking this Arena directly…'
          : 'Not connected: the counts above come from the decoded API, not from your machine.'}</div>` +

        Kit.section('Arena\'s own record controls', controlList(),
          { tag: String(ctrls.length) }) +

        Kit.section('Record states',
          states ? Kit.list(states.map(s => ({ label: s })))
                 : '<div class="p-note">arena-data.js is not loaded.</div>',
          { tag: states ? String(states.length) : '' }) +

        Kit.section('Codecs offered by the recorder and the clip renderer',
          cod ? Kit.list(cod.map(s => ({ label: s })))
              : '<div class="p-note">arena-data.js is not loaded.</div>',
          { tag: cod ? String(cod.length) : '', folded: true }) +

        Kit.section('Render and Record presets',
          `<div class="p-note">The shipped presets, with the values they actually carry.
            OutputPath.Path is the directory recorded in Resolume's own preset files.</div>` +
          presetBlocks(),
          { tag: String(presets.length), folded: true });

      Kit.bind(host);
      if (AL.status === 'live') probe(host).catch(() => {});
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
