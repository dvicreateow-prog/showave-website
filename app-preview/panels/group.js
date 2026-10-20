/* ===========================================================================
   panels/group.js — the Layer Group property panel.
   ---------------------------------------------------------------------------
   A layer group is a mixer strip over several layers: its own blend mode,
   opacity, volume and effects, applied to the layers' combined output.

   The composition carries them in composition.layergroups. On the Arena this
   panel was written against that array is empty, so the empty state is not a
   corner case — it is the normal state until someone groups layers inside
   Arena, and it says so instead of drawing a strip that stands for nothing.

   Shape, from rest/docs/schemas/LayerGroup.yaml on the installed Arena:
     name · colorid · selected · bypassed · solo · crossfadergroup · master ·
     ignorecolumntrigger · dashboard · audio · video · layers
   The live payload has run richer than these schemas elsewhere (a Column sends
   three parameters Column.yaml never mentions), so everything here is rendered
   from what the group object actually carries, never from the schema.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* Arena scattered the group controls across the manifest's Layer, Other and
   Column buckets, so look a control up by id wherever it landed */
const BUCKETS = ['Other', 'Layer', 'Column', 'Autopilot', 'Composition'];
function ctl(id, ctx) {
  for (const b of BUCKETS) {
    const hit = Kit.components(b).find(x =>
      x.id === id && (!ctx || (x.context || []).indexOf(ctx) >= 0));
    if (hit) return hit;
  }
  return null;
}
const help = (id, ctx) => (ctl(id, ctx) || {}).help || '';

/* the group strip in Arena also has a speed slider, four transport buttons and
   a pair of column steppers. No layergroup parameter in the composition and no
   layergroup endpoint in swagger.yaml carries any of them. */
const NOT_IN_API = ['speedSlider', 'forwardsButton', 'backwardsButton',
                    'pauseButton', 'randomButton',
                    'connectPrevColumn', 'connectNextColumn'];

const AP = {
  target: 'Action', duration_type: 'Duration', loop_count: 'Loops',
  random_type: 'Random', beats: 'Beats', seconds: 'Seconds', loop: 'Loop',
  compensate_transition: 'Compensate Transition',
};

/* which group this panel shows: the selected one, else the first */
function targetGroup() {
  const gs = AL.groups();
  for (let i = 0; i < gs.length; i++)
    if (AL.val(gs[i].selected) === true) return { i: i + 1, g: gs[i] };
  return gs.length ? { i: 1, g: gs[0] } : null;
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

function effectChain(scope, effects, track) {
  const list = effects || [];
  const rows = list.map((fx, i) => {
    const body = [
      fx.bypassed ? Kit.param('Bypassed', fx.bypassed) : '',
      fx.mixer ? Kit.params(fx.mixer) : '',
      Kit.params(fx.params),
    ].filter(Boolean).join('') || '<div class="p-note">no parameters</div>';
    const from = `${scope}/effects/${track}/${i + 1}`;
    const removable = fx.is_user_removable !== false;
    return `<div class="fx">
      <div class="fxhead"><b>${i + 1}</b> ${Kit.esc(fx.display_name || fx.name)}
        <span class="fxsp"></span>
        ${i > 0 ? `<span class="fxbtn" data-fx-from="${from}"
          data-fx-to="${scope}/effects/${track}/move/${i}" title="Move up">&#9650;</span>` : ''}
        ${i < list.length - 1 ? `<span class="fxbtn" data-fx-from="${from}"
          data-fx-to="${scope}/effects/${track}/move/${i + 2}" title="Move down">&#9660;</span>` : ''}
        ${removable ? `<span class="fxbtn" data-fx-remove="${from}" title="Remove">&#10005;</span>` : ''}
      </div><div class="fxbody">${body}</div></div>`;
  }).join('');
  return rows + `<div class="dropmsg" data-fxdrop="${scope}" data-fxtrack="${track}">
    Drop an effect here</div>`;
}
function wireEffects(host) {
  host.querySelectorAll('[data-fx-remove]').forEach(b => b.addEventListener('click', () =>
    AL.rest(b.dataset.fxRemove, { method: 'DELETE' }).catch(e => console.warn(e))));
  /* move takes the effect's own path as a text/plain body with the destination
     offset in the url, and add takes effect:///<track>/<name> — the shapes the
     installed rest/docs/swagger.yaml documents for every effects route */
  host.querySelectorAll('[data-fx-to]').forEach(b => b.addEventListener('click', () =>
    AL.rest(b.dataset.fxTo, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: b.dataset.fxFrom
    }).catch(e => console.warn(e))));
  host.querySelectorAll('[data-fxdrop]').forEach(d => {
    d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('drop'); });
    d.addEventListener('dragleave', () => d.classList.remove('drop'));
    d.addEventListener('drop', e => {
      e.preventDefault(); d.classList.remove('drop');
      let item; try { item = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!item || item.kind !== 'effect') return;
      const track = d.dataset.fxtrack;
      AL.rest(`${d.dataset.fxdrop}/effects/${track}/add`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: `effect:///${track}/${item.name || item.id}`
      }).catch(x => console.warn(x));
    });
  });
}

/* member layers, named as the composition names them — a group's layer objects
   carry the same ids, so their position in the composition is recoverable */
function layerRows(g) {
  const all = AL.layers();
  return (g.layers || []).map(L => {
    const at = all.findIndex(x => x && x.id === L.id) + 1;
    const state = [AL.val(L.bypassed) ? 'bypassed' : '', AL.val(L.solo) ? 'solo' : '']
      .filter(Boolean).join(' · ');
    return { id: at || '', label: Kit.dispName(AL.val(L.name), at || ''), dim: state };
  });
}

/* the controls Arena draws on a group that the API does not carry: named, with
   Arena's own help text, rather than drawn as buttons that would do nothing */
function gapList() {
  const rows = NOT_IN_API.map(id => ctl(id, 'layerGroupControlComponent')).filter(Boolean);
  if (!rows.length) return '';
  return `<div class="p-list">${rows.map(r =>
    `<div class="p-row" title="${Kit.esc(r.help)}"><span>${Kit.esc(r.title)}</span></div>`).join('')}</div>`;
}

WS.register('Group', {
  title: 'Group',
  build(host) {
    /* selection is a parameter event rather than a composition push, so listen
       to parameters and repaint only when the subject or the structure below
       it changes — otherwise a slider drag would be torn out mid-gesture */
    let shown = null;
    Kit.live(host, () => {
      if (AL.status !== 'live') {
        shown = null;
        host.innerHTML = Kit.offline('This panel follows the layer group selected in Arena.');
        return;
      }
      const gs = AL.groups();
      if (!gs.length) {
        shown = null;
        host.innerHTML = Kit.nothing('This Show has no layer groups.') +
          '<div class="p-note">The Resolume composition.layergroups array is empty. Layer groups are made ' +
          'inside Arena: select the layers there and group them. This panel follows the ' +
          'selected group as soon as one exists.</div>';
        return;
      }
      const t = targetGroup();
      const { i, g } = t;
      const vfx = (g.video && g.video.effects) || [];
      const afx = (g.audio && g.audio.effects) || [];
      const key = `${g.id}/${i}/${gs.length}/${(g.layers || []).length}/${vfx.length}/${afx.length}`;
      if (key === shown) return;
      shown = key;
      AL.subscribeEntity(g);

      const scope = `/composition/layergroups/${i}`;
      const layers = layerRows(g);
      const where = Kit.dispName(AL.val(g.name), i) +
        ` · group ${i} of ${gs.length} · ${layers.length} layer${layers.length === 1 ? '' : 's'}`;
      const noTransport = !g.speed && !g.transport;

      host.innerHTML =
        `<div class="p-note">${Kit.esc(where)}</div>` +
        Kit.toolbar(
          `<button class="btn" data-act="${scope}/select"
            title="${Kit.esc(help('layerGroupControlComponent', 'groupedComponent'))}">Select</button>` +
          `<button class="btn" data-act="${scope}/clear"
            title="${Kit.esc(help('clearLayerGroupButton'))}">Clear</button>`) +
        Kit.section('Quick Controls', dashboard(g.dashboard) || Kit.nothing('No dials.'),
          { folded: true }) +
        Kit.section('Wave',
          g.autopilot ? Kit.params(g.autopilot, { rename: k => AP[k] || k.replace(/_/g, ' ') })
                      : '<div class="p-note">This group carries no Wave parameters.</div>',
          { folded: true, tag: g.autopilot ? AL.val(g.autopilot.target) : '' }) +
        Kit.section('Group', [
          Kit.param('Name', g.name),
          Kit.param('Master', g.master),
          Kit.param('Bypassed', g.bypassed, { help: help('bypassLayerGroupButton') }),
          Kit.param('Solo', g.solo, { help: help('soloLayerGroupButton') }),
          Kit.param('Crossfader Group', g.crossfadergroup, { help: help('groupAButton') }),
          Kit.param('Colour', g.colorid),
          Kit.param('Ignore Cue Trigger', g.ignorecolumntrigger),
          Kit.param('Selected', g.selected, { verb: 'Select' }),
        ].join('')) +
        Kit.section('Audio', g.audio
          ? Kit.param('Volume', g.audio.volume) + Kit.param('Pan', g.audio.pan) +
            effectChain(scope, afx, 'audio')
          : '<div class="p-note">No audio track.</div>',
          { tag: g.audio ? String(afx.length) : '' }) +
        Kit.section('Video', g.video
          ? (g.video.mixer ? Kit.params(g.video.mixer) : '') +
            Kit.param('Opacity', g.video.opacity) + Kit.param('Width', g.video.width) +
            Kit.param('Height', g.video.height)
          : '<div class="p-note">No video track.</div>') +
        Kit.section('Video Effects', g.video
          ? effectChain(scope, vfx, 'video')
          : '<div class="p-note">No video track.</div>',
          { tag: g.video ? String(vfx.length) : '' }) +
        Kit.section('Layers', Kit.list(layers, { empty: 'This group holds no layers.' }),
          { tag: String(layers.length) }) +
        (noTransport
          ? Kit.section('Not in the API',
              Kit.unavailable('Group speed, transport and Cue stepping',
                'Arena draws these on the group strip. The Show payload sends no speed or ' +
                'transport parameter on a layer group, and while the API can connect a ' +
                'group Cue by index, the payload carries no group Cues to step ' +
                "through. Arena's own description of each:") +
              gapList(), { folded: true })
          : Kit.section('Transport',
              Kit.param('Speed', g.speed) + Kit.params(g.transport)));

      Kit.bind(host);
      wireDials(host);
      wireEffects(host);
      host.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () =>
        AL.action(b.dataset.act).catch(e => console.warn(e))));
      host.querySelectorAll('.p-row[data-id]').forEach(r => r.addEventListener('click', () => {
        const at = +r.dataset.id;
        if (at) AL.cmd.selectLayer(at).catch(e => console.warn(e));
      }));
    }, { repaintOnParam: true });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
