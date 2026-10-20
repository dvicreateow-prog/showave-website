/* ===========================================================================
   panels/clip.js — the Clip property panel.
   ---------------------------------------------------------------------------
   REFERENCE PANEL. Every other panel module follows this shape:

     1. Workspace.register('<Type>', { title, build, destroy })
     2. build() renders once, then Kit.live() re-renders on composition pushes
        and applies subscribed parameter updates in place
     3. every value comes from ArenaLive; nothing is invented
     4. when Arena is not connected, say so — never show plausible fiction
     5. when Arena has the control but the REST API does not expose it, say
        that too, with Kit.unavailable()

   Sections and their order are Arena's own, from the decoded component
   manifest (RESOLUME.arena.components.Clip) and the GUI reference:
     Dashboard · Autopilot · Transport · Transition · Audio · Video · Effects
   =========================================================================== */
(() => {
'use strict';
/* the effect chain lives in panel-kit.js: every property panel needs it and
   the add/move endpoints take text/plain URIs, which is easy to get wrong */
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* which clip this panel shows: the selected one, else the first non-empty */
function targetClip() {
  const layers = AL.layers();
  for (let l = 1; l <= layers.length; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++) {
      const k = clips[c - 1];
      if (k && AL.val(k.selected) === true) return { l, c, k };
    }
  }
  for (let l = 1; l <= layers.length; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++) {
      if (clips[c - 1] && AL.val(clips[c - 1].connected) !== 'Empty')
        return { l, c, k: clips[c - 1] };
    }
  }
  return null;
}


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

WS.register('Clip', {
  title: 'Clip',
  build(host) {
    Kit.live(host, () => {
      if (AL.status !== 'live') { host.innerHTML = Kit.offline('Select a clip in Arena.'); return; }
      const t = targetClip();
      if (!t) { host.innerHTML = Kit.nothing('No clip in this Show yet.'); return; }
      const { l, c, k } = t;
      AL.subscribeEntity(k);
      const scope = `/composition/layers/${l}/clips/${c}`;
      const where = `${Kit.dispName(AL.val((AL.layer(l) || {}).name), l)} · ${
        Kit.dispName(AL.val((AL.column(c) || {}).name), c)}`;

      const transport = k.transport && k.transport.controls;
      host.innerHTML =
        `<div class="p-note">${Kit.esc(where)}</div>` +
        Kit.section('Quick Controls', dashboard(k.dashboard) || Kit.nothing('No dials.'), { folded: true }) +
        Kit.section('Wave', Kit.params(k.autopilot), { folded: true }) +
        Kit.section('Clip', [
          Kit.param('Name', k.name), Kit.param('Connected', k.connected),
          Kit.param('Target', k.target), Kit.param('Trigger Style', k.triggerstyle),
          Kit.param('Beat Snap', k.beatsnap),
          Kit.param('Ignore Cue Trigger', k.ignorecolumntrigger),
          Kit.param('Fader Start', k.faderstart), Kit.param('Colour', k.colorid),
        ].join('')) +
        Kit.section('Transport',
          Kit.param('Transport Type', k.transporttype) +
          (transport ? Kit.params(transport)
                     : '<div class="p-note">Slot is empty: no transport.</div>'),
          { tag: k.transporttype ? AL.val(k.transporttype) : '' }) +
        Kit.section('Transition', Kit.params(k.transition)) +
        Kit.section('Audio', k.audio
          ? Kit.param('Volume', k.audio.volume) + Kit.param('Pan', k.audio.pan) +
            Kit.effectChain(scope, k.audio.effects, 'audio')
          : '<div class="p-note">No audio track.</div>') +
        Kit.section('Video', k.video
          ? (k.video.mixer ? Kit.params(k.video.mixer) : '') +
            Kit.param('Opacity', k.video.opacity) + Kit.param('Width', k.video.width) +
            Kit.param('Height', k.video.height) + Kit.param('Resize', k.video.resize)
          : '<div class="p-note">No video track.</div>') +
        Kit.section('Video Effects', k.video
          ? Kit.effectChain(scope, k.video.effects, 'video')
          : '<div class="p-note">No video track.</div>',
          { tag: k.video ? String((k.video.effects || []).length) : '' });

      Kit.bind(host);
      wireDials(host);
      Kit.wireEffects(host);
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
