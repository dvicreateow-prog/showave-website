/* ===========================================================================
   panels/column.js — the Column property panel.
   ---------------------------------------------------------------------------
   Follows the column selected in Arena. A column is a trigger, not a mixer.
   The running Arena 7.27.1 answers GET /api/v1/composition/columns/1 with

     name · colorid · connected · selected · beatsnap · clipconnected · autopilot

   and nothing else — no dashboard, no audio or video track, no effect chain.
   So the panel is the column's own parameters and its autopilot, which is also
   all Arena's own Column panel draws.

   rest/docs/schemas/Column.yaml only admits to four of those seven; the live
   payload is the authority, and it is what is rendered.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* Arena's own wording. The manifest carries a control twice when it also
   appears inside a layer group; the shorter context is the plain one. */
function help(id) {
  const hits = Kit.components('Column').filter(x => x.id === id);
  if (!hits.length) return '';
  return hits.reduce((a, b) =>
    (a.context || []).length <= (b.context || []).length ? a : b).help || '';
}

/* autopilot keys as Arena titles them in the component manifest; the rest fall
   back to the parameter name itself */
const AP = {
  target: 'Action', duration_type: 'Duration', loop_count: 'Loops',
  random_type: 'Random', beats: 'Beats', seconds: 'Seconds', loop: 'Loop',
  compensate_transition: 'Compensate Transition',
};

/* which column this panel shows: the selected one, else the connected one,
   else the first — a composition always has at least one column */
function targetColumn() {
  const cols = AL.columns();
  for (let c = 1; c <= cols.length; c++)
    if (AL.val(cols[c - 1].selected) === true) return { c, col: cols[c - 1] };
  for (let c = 1; c <= cols.length; c++)
    if (AL.val(cols[c - 1].connected) === 'Connected') return { c, col: cols[c - 1] };
  return cols.length ? { c: 1, col: cols[0] } : null;
}

/* Arena's connectPrevColumn / connectNextColumn step relative to whatever is
   playing, and wrap. REST has no such verb, so read the connected column out
   of the live composition and connect its neighbour. */
function connectedIndex() {
  const cols = AL.columns();
  for (let i = 0; i < cols.length; i++)
    if (AL.val(cols[i].connected) === 'Connected') return i + 1;
  return 0;
}
function step(d) {
  const n = AL.columns().length;
  if (!n) return;
  const cur = connectedIndex();
  const to = cur ? ((cur - 1 + d + n) % n) + 1 : (d > 0 ? 1 : n);
  AL.cmd.triggerColumn(to).catch(e => console.warn(e));
}

WS.register('Column', {
  title: 'Cue',
  build(host) {
    /* the selection arrives as a parameter event, not a composition push, so
       this panel listens to parameters — but repaints only when the subject
       or the column count actually changes, otherwise a drag on a slider
       would be torn out from under the mouse */
    let shown = null;
    Kit.live(host, () => {
      if (AL.status !== 'live') {
        shown = null;
        host.innerHTML = Kit.offline('This panel follows the Cue selected in Arena (Resolume Column).');
        return;
      }
      const t = targetColumn();
      if (!t) {
        shown = null;
        host.innerHTML = Kit.nothing('This Show has no Cues.');
        return;
      }
      const { c, col } = t;
      const cols = AL.columns();
      /* The fingerprint has to carry connection state, not just identity.
         Triggering the column already on screen leaves id, index and count
         untouched, so a fingerprint built from those three alone never
         changes — the Connected row, the section tag and every dim in the
         column list freeze at whatever they were when the panel painted.
         Fold in each column's connected / clipconnected / selected, which is
         precisely what the list draws. */
      const key = `${col.id}/${c}/${cols.length}/` + cols.map(x =>
        `${AL.val(x.connected)}${AL.val(x.clipconnected)}${AL.val(x.selected) ? 1 : 0}`).join(',');
      if (key === shown) return;
      shown = key;
      AL.subscribeEntity(col);

      const deck = AL.decks()[AL.activeDeckIndex()];
      const where = Kit.dispName(AL.val(col.name), c) +
        (deck ? ' · ' + Kit.dispName(AL.val(deck.name), AL.activeDeckIndex() + 1) : '');

      host.innerHTML =
        `<div class="p-note">${Kit.esc(where)}</div>` +
        Kit.toolbar(
          `<button class="btn" data-step="-1" title="${Kit.esc(help('connectPrevColumn'))}">&#9198;</button>` +
          `<button class="btn" data-connect="${c}" title="${Kit.esc(help('columnTriggerComponent'))}">Trigger</button>` +
          `<button class="btn" data-step="1" title="${Kit.esc(help('connectNextColumn'))}">&#9197;</button>` +
          `<span class="hint">${c} / ${cols.length}</span>`) +
        Kit.section('Cue', [
          Kit.param('Name', col.name),
          Kit.param('Colour', col.colorid),
          Kit.param('Connected', col.connected),
          Kit.param('Clip Connected', col.clipconnected),
          Kit.param('Beat Snap', col.beatsnap),
          Kit.param('Select', col.selected, { verb: 'Select' }),
        ].join(''), { tag: AL.val(col.connected) }) +
        Kit.section('Wave',
          col.autopilot ? Kit.params(col.autopilot, { rename: k => AP[k] || k.replace(/_/g, ' ') })
                        : '<div class="p-note">This Cue carries no Wave settings.</div>',
          { tag: col.autopilot ? AL.val(col.autopilot.target) : '' }) +
        Kit.section('Cues', Kit.list(cols.map((x, i) => ({
          id: i + 1,
          label: Kit.dispName(AL.val(x.name), i + 1),
          dim: AL.val(x.connected),
        })), { empty: 'No Cues.' }), { folded: true, tag: String(cols.length) });

      Kit.bind(host);
      const cur = host.querySelector(`.p-row[data-id="${c}"]`);
      if (cur) cur.classList.add('sel');
      host.querySelectorAll('[data-step]').forEach(b =>
        b.addEventListener('click', () => step(+b.dataset.step)));
      host.querySelectorAll('[data-connect]').forEach(b =>
        b.addEventListener('click', () =>
          AL.cmd.triggerColumn(+b.dataset.connect).catch(e => console.warn(e))));
      host.querySelectorAll('.p-row[data-id]').forEach(r =>
        r.addEventListener('click', () =>
          AL.cmd.selectColumn(+r.dataset.id).catch(e => console.warn(e))));
    }, { repaintOnParam: true });
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
