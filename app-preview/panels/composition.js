/* ===========================================================================
   panels/composition.js — the Composition property panel.
   ---------------------------------------------------------------------------
   Same shape as panels/clip.js, one level up: the subject is the composition
   itself, so there is always one as long as Arena is connected.

   Sections are Arena's own, from the decoded component manifest
   (RESOLUME.arena.components.Composition) and the live /composition payload:
     Dashboard · Autopilot · Composition · Trigger · Tempo · Crossfader ·
     Audio · Video · Video Effects
   =========================================================================== */
(() => {
'use strict';
/* the effect chain lives in panel-kit.js: every property panel needs it and
   the add/move endpoints take text/plain URIs, which is easy to get wrong */
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* the live payload spells it tempocontroller, the published schema
   tempo_controller — accept either rather than guess */
const tempoOf = c => c.tempocontroller || c.tempo_controller || null;

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

/* a trigger the panel draws outside a .prow; Kit.bind wires any button.pbind */
const trig = (p, label) => (p && p.id != null)
  ? `<button class="btn pbind" data-pid="${p.id}" data-kind="trig">${Kit.esc(label)}</button>` : '';

/* ---- tempo -------------------------------------------------------------- */
function tempoSection(t) {
  if (!t) return '<div class="p-note">This build reports no tempo controller.</div>';
  return Kit.param('Tempo', t.tempo) +
    (t.play_state ? Kit.param('Play State', t.play_state) : '') +
    Kit.toolbar(
      trig(t.tempo_tap, 'Tap') + trig(t.resync, 'Resync') +
      trig(t.tempo_pull, 'Nudge −') + trig(t.tempo_push, 'Nudge +') +
      (t.tempo && t.tempo.id != null
        ? '<button class="btn" data-tempo-mul="0.5">÷2</button>' +
          '<button class="btn" data-tempo-mul="2">×2</button>' : ''));
}
/* Arena has BPM divide/multiply as its own buttons; the API has no such
   action, so do the only honest equivalent — set the tempo parameter, kept
   inside the range the parameter itself reports. */
function wireTempo(host, t) {
  const p = t && t.tempo;
  host.querySelectorAll('[data-tempo-mul]').forEach(b => b.addEventListener('click', () => {
    if (!p || p.id == null) return;
    const cur = AL.paramById(p.id) || p;
    let v = (cur.value ?? 0) * +b.dataset.tempoMul;
    if (p.min != null && p.max != null) v = Kit.clamp(v, p.min, p.max);
    AL.setParam(p.id, v);
  }));
}

/* ---- crossfader --------------------------------------------------------- */
function crossfader(x) {
  if (!x) return '<div class="p-note">This build reports no crossfader.</div>';
  return Kit.param('Phase', x.phase) + Kit.param('Behaviour', x.behaviour) +
    Kit.param('Curve', x.curve) + (x.mixer ? Kit.params(x.mixer) : '') +
    Kit.toolbar(trig(x.sidea, 'Fade to A') + trig(x.sideb, 'Fade to B'));
}

/* ---- the one control group Arena has here and the API does not -----------
   forward/backwards/pause/random act on every playing clip's own transport.
   No composition-level transport exists in /composition and /composition/action
   is undo/redo, so there is nothing to bind to. */
const GLOBAL_TRANSPORT = ['forwardButton', 'backwardsButton', 'pauseButton', 'randomButton'];
function apiGap() {
  const seen = new Set();
  const rows = Kit.components('Composition')
    .filter(x => GLOBAL_TRANSPORT.includes(x.id))
    .filter(x => !seen.has(x.title) && seen.add(x.title))
    .map(x => ({ label: x.title, dim: x.id }));
  return Kit.unavailable('Global clip transport',
    'SHOWAVE has no Show-wide transport: Resolume /composition/action is undo/redo, ' +
    'and its Composition object has no transport parameter. Arena names these controls:') +
    Kit.list(rows, { empty: 'No decoded reference for this build.' });
}

/* only the branches this panel draws — handing the whole composition to
   subscribeEntity would subscribe every clip on the show */
function shown(c) {
  return {
    name: c.name, master: c.master, speed: c.speed, bypassed: c.bypassed, selected: c.selected,
    cliptarget: c.cliptarget, cliptriggerstyle: c.cliptriggerstyle, clipbeatsnap: c.clipbeatsnap,
    dashboard: c.dashboard, autopilot: c.autopilot, audio: c.audio, video: c.video,
    crossfader: c.crossfader, tempo: tempoOf(c),
  };
}

WS.register('Composition', {
  title: 'Show',
  build(host) {
    Kit.live(host, () => {
      if (AL.status !== 'live') { host.innerHTML = Kit.offline('This panel shows the running Show.'); return; }
      const c = AL.comp;
      if (!c) { host.innerHTML = Kit.nothing('Waiting for the Show.'); return; }
      AL.subscribeEntity(shown(c));

      const scope = '/composition';
      const t = tempoOf(c);
      const w = AL.val(c.video && c.video.width), h = AL.val(c.video && c.video.height);
      const where = [AL.val(c.name), (w && h) ? `${Math.round(w)} × ${Math.round(h)}` : '']
        .filter(Boolean).join(' · ');

      host.innerHTML =
        (where ? `<div class="p-note">${Kit.esc(where)}</div>` : '') +
        Kit.section('Quick Controls', dashboard(c.dashboard) || Kit.nothing('No dials.'), { folded: true }) +
        Kit.section('Wave', Kit.params(c.autopilot), { folded: true }) +
        Kit.section('Show', [
          Kit.param('Name', c.name), Kit.param('Master', c.master),
          Kit.param('Speed', c.speed), Kit.param('Bypassed', c.bypassed),
          Kit.param('Select', c.selected, { verb: 'Preview Show' }),
        ].join('')) +
        Kit.section('Trigger', [
          Kit.param('Clip Target', c.cliptarget),
          Kit.param('Trigger Style', c.cliptriggerstyle),
          Kit.param('Beat Snap', c.clipbeatsnap),
        ].join('')) +
        Kit.section('Tempo', tempoSection(t),
          { tag: t && t.tempo ? Math.round(AL.val(t.tempo)) + ' BPM' : '' }) +
        Kit.section('Crossfader', crossfader(c.crossfader)) +
        Kit.section('Audio', c.audio
          ? Kit.param('Volume', c.audio.volume) + Kit.param('Pan', c.audio.pan) +
            Kit.effectChain(scope, c.audio.effects, 'audio')
          : '<div class="p-note">No audio track.</div>') +
        Kit.section('Video', c.video
          ? (c.video.mixer ? Kit.params(c.video.mixer) : '') +
            Kit.param('Opacity', c.video.opacity) + Kit.param('Width', c.video.width) +
            Kit.param('Height', c.video.height)
          : '<div class="p-note">No video track.</div>') +
        Kit.section('Video Effects', c.video
          ? Kit.effectChain(scope, c.video.effects, 'video')
          : '<div class="p-note">No video track.</div>',
          { tag: c.video ? String((c.video.effects || []).length) : '' }) +
        Kit.section('Not in the API', apiGap(), { folded: true });

      Kit.bind(host);
      wireDials(host);
      Kit.wireEffects(host);
      wireTempo(host, t);
    }, { repaintOnParam: false });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
