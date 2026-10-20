/* ===========================================================================
   panels/layer.js — the Layer property panel.
   ---------------------------------------------------------------------------
   Same shape as panels/clip.js. The subject is whichever layer is selected in
   Arena; with nothing selected it falls back to the topmost layer, which is
   the last one in the array — Arena numbers layers 1..n bottom to top.

   Sections are Arena's own, from the decoded component manifest
   (RESOLUME.arena.components.Layer) and the live /composition payload:
     Dashboard · Autopilot · Layer · Video · Transition · Audio · Video Effects
   =========================================================================== */
(() => {
'use strict';
/* the effect chain lives in panel-kit.js: every property panel needs it and
   the add/move endpoints take text/plain URIs, which is easy to get wrong */
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* which layer this panel shows: the selected one, else the topmost */
function targetLayer() {
  const ls = AL.layers();
  for (let i = 1; i <= ls.length; i++)
    if (ls[i - 1] && AL.val(ls[i - 1].selected) === true) return { i, L: ls[i - 1], sel: true };
  if (!ls.length) return null;
  return { i: ls.length, L: ls[ls.length - 1], sel: false };
}

/* ---- shared widgets, kept identical to panels/clip.js -------------------- */

function dashboard(dash) {
  if (!dash) return '';
  return `<div class="dash">${Object.entries(dash).map(([k, p]) => {
    const rot = -135 + ((p.value ?? 0) - (p.min ?? 0)) / (((p.max ?? 1) - (p.min ?? 0)) || 1) * 270;
    return `<div class="dial" data-pid="${p.id}">
      <div class="k pdial" data-pid="${p.id}" data-min="${p.min ?? 0}" data-max="${p.max ?? 1}"
        style="--rot:${rot}deg"></div><span>${Kit.esc(k)}</span></div>`;
  }).join('')}</div>`;
}
function wireDials(host) {
  host.querySelectorAll('.pdial').forEach(k => k.addEventListener('mousedown', e => {
    e.preventDefault();
    const y = e.clientY, r0 = parseFloat(k.style.getPropertyValue('--rot')) || 0;
    const min = +k.dataset.min, max = +k.dataset.max, id = +k.dataset.pid;
    const mv = ev => {
      const rot = Kit.clamp(r0 + (y - ev.clientY) * 2, -135, 135);
      k.style.setProperty('--rot', rot + 'deg');
      AL.setParam(id, min + ((rot + 135) / 270) * (max - min));
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  }));
}

/* ---- what Arena puts on a layer that the API does not carry --------------
   a layer's slice input bypass/solo and its video router switches live in the
   Advanced Output window; no /api/v1 path reaches them. */
function apiGap() {
  const seen = new Set();
  const rows = Kit.components('Layer')
    .filter(x => x.id === 'Input Bypass/Solo')
    .filter(x => !seen.has(x.title) && seen.add(x.title))
    .map(x => ({ label: x.title, dim: x.id }));
  return Kit.unavailable('SHOWAVE Map routing',
    'Resolume REST does not expose Advanced Output to SHOWAVE Map: no slice, screen or router path exists ' +
    "in /api/v1, so a layer's input bypass/solo cannot be read or set from here. " +
    'Arena names these controls:') +
    Kit.list(rows, { empty: 'No decoded reference for this build.' });
}

WS.register('Layer', {
  title: 'Layer',
  build(host) {
    Kit.live(host, () => {
      if (AL.status !== 'live') { host.innerHTML = Kit.offline('Select a layer in Arena.'); return; }
      const t = targetLayer();
      if (!t) { host.innerHTML = Kit.nothing('No layer in this Show yet.'); return; }
      const { i, L } = t;
      /* the clips carry thousands of parameters of their own — the clip panel
         owns those, this one subscribes to the layer's own branches only */
      AL.subscribeEntity(Object.assign({}, L, { clips: null, active_clip: null }));
      const scope = `/composition/layers/${i}`;
      const where = `${Kit.dispName(AL.val(L.name), i)} · ${
        t.sel ? 'selected' : 'topmost layer, nothing selected'}`;

      host.innerHTML =
        `<div class="p-note">${Kit.esc(where)}</div>` +
        Kit.section('Quick Controls', dashboard(L.dashboard) || Kit.nothing('No dials.'), { folded: true }) +
        Kit.section('Wave', Kit.params(L.autopilot), { folded: true }) +
        Kit.section('Layer', [
          Kit.param('Name', L.name), Kit.param('Master', L.master),
          Kit.param('Bypassed', L.bypassed), Kit.param('Solo', L.solo),
          Kit.param('Crossfader Group', L.crossfadergroup),
          Kit.param('Mask Mode', L.maskmode),
          Kit.param('Ignore Cue Trigger', L.ignorecolumntrigger),
          Kit.param('Fader Start', L.faderstart), Kit.param('Colour', L.colorid),
        ].join('')) +
        Kit.section('Video', L.video
          ? (L.video.mixer ? Kit.params(L.video.mixer) : '') +
            Kit.param('Opacity', L.video.opacity) + Kit.param('Width', L.video.width) +
            Kit.param('Height', L.video.height) + Kit.param('Auto Size', L.video.autosize)
          : '<div class="p-note">No video track.</div>',
          { tag: L.video && L.video.mixer && L.video.mixer['Blend Mode']
                 ? String(AL.val(L.video.mixer['Blend Mode'])) : '' }) +
        Kit.section('Transition', L.transition
          ? Kit.param('Duration', L.transition.duration) +
            Kit.param('Blend Mode', L.transition.blend_mode) +
            (L.transition.params ? Kit.params(L.transition.params) : '')
          : '<div class="p-note">This layer reports no transition.</div>') +
        Kit.section('Audio', L.audio
          ? Kit.param('Volume', L.audio.volume) + Kit.param('Pan', L.audio.pan) +
            Kit.effectChain(scope, L.audio.effects, 'audio')
          : '<div class="p-note">No audio track.</div>') +
        Kit.section('Video Effects', L.video
          ? Kit.effectChain(scope, L.video.effects, 'video')
          : '<div class="p-note">No video track.</div>',
          { tag: L.video ? String((L.video.effects || []).length) : '' }) +
        Kit.section('Not in the API', apiGap(), { folded: true });

      Kit.bind(host);
      wireDials(host);
      Kit.wireEffects(host);
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
