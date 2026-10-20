/* ===========================================================================
   panels/render-queue.js — the Render Queue panel.
   ---------------------------------------------------------------------------
   Arena's Render Queue holds every clip you sent through Clip > Render To File,
   and every take the Record button produced, ready to drag back into the
   composition.

   The REST API does not carry the queue. Verified against the running Arena
   7.27.1 rev 15990 on this machine:
     · extracted/arena-api.json — 258 paths, 295 operations; nothing matching
       render / record / queue / recordings
     · GET /api/v1/render, /recordings — 404
   The codec list and the shipped Render and Record presets ARE decoded, with
   their real parameter values, so this panel states the gap and then shows the
   settings the real queue is fed with. Everything below the fold is DECODED
   REFERENCE, not your queue.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

const RA = () => (window.RESOLUME || {}).arena || {};

/* arena-data.js declares CODECS as a top-level const, which lands in the global
   lexical scope and never on window — name it directly, guarded. */
const CODEC_LIST = typeof CODECS !== 'undefined' ? CODECS : null;

/* GET, never OPTIONS: Arena's webserver answers OPTIONS with 200 for any URL at
   all — it is only the CORS preflight — so a GET is the one honest test of
   whether a path exists. All four are reads. */
const PROBE = ['/render', '/recordings', '/composition/render', '/composition/recordings'];

/* the preset keys worth reading first; the rest are version stamps */
const HEAD_KEYS = ['Conversion.Codec', 'Conversion.Format', 'Conversion.AutoSize',
  'Conversion.CustomSize', 'Conversion.AudioEnabled', 'Conversion.SampleRate',
  'Conversion.BitDepth', 'OutputPath.Type', 'OutputPath.Path'];

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

const kvRows = pairs => `<div class="p-list">${pairs.map(([k, v]) =>
  `<div class="p-row"><span>${Kit.esc(k)}</span>
    <span class="p-dim">${Kit.esc(v)}</span></div>`).join('')}</div>`;

/* the eleven presets Arena ships in default\Presets\Render and Record, each
   folded, each showing the values the XML actually holds */
function presets() {
  const list = Kit.presets('Render and Record');
  if (!list.length) return Kit.nothing('No decoded Render and Record presets.');
  return list.map(p => {
    const par = p.params || {};
    const head = HEAD_KEYS.filter(k => k in par).map(k => [k, par[k]]);
    const rest = Object.keys(par).filter(k => !HEAD_KEYS.includes(k)).map(k => [k, par[k]]);
    return Kit.section(p.name, kvRows(head.concat(rest)),
      { folded: true, tag: par['Conversion.Codec'] || String(p.param_count || '') });
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

/* ---- live ---------------------------------------------------------------- */
function paintLive(host) {
  const live = host.querySelector('[data-live]');
  if (!live) return;
  if (AL.status !== 'live' || !AL.comp) {
    live.innerHTML = Kit.offline('The queue is not on the API either way: the reference below stands.');
    applyFilter(host);
    return;
  }
  const c = AL.comp, w = AL.val(c.video && c.video.width), h = AL.val(c.video && c.video.height);
  live.innerHTML = `<div class="p-note">${Kit.esc(AL.val(c.name) || 'Untitled')}${
    (w && h) ? ` · Show output ${Math.round(w)} × ${Math.round(h)} px` : ''}</div>`;
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

WS.register('RenderQueue', {
  title: 'Render Queue',
  build(host) {
    const rec = Kit.components('Record');
    const queue = rec.filter(c => /queue/i.test(c.title));
    const other = rec.filter(c => !/queue/i.test(c.title));
    const q = queue.find(c => c.title === 'Render Queue');

    host.innerHTML =
      Kit.toolbar(`<input type="text" data-find placeholder="Filter the reference">
        <button class="btn" data-probe-run
          title="GET each candidate path and report what Arena answers">Probe the API</button>`) +
      `<div data-live></div>` +
      Kit.section('Queue',
        Kit.unavailable('The REST API does not carry the render queue',
          'Neither the queue nor its entries appear in this build\'s 258 REST paths, and ' +
          'the Show payload the websocket pushes has no queue in it. Rendering and ' +
          'recording start from Arena\'s own Clip menu and Record button, and what they ' +
          'produce is only visible there, so this panel cannot list your renders, ' +
          'remove one, or start another.') +
        (q ? `<div class="p-note">Arena describes this panel as: ${Kit.esc(q.help)}</div>` : '') +
        `<div data-probe></div>`) +
      Kit.section('Codecs',
        `<div class="p-note">What Arena offers the recorder and the clip renderer.</div>` +
        chips(CODEC_LIST, 'CODECS not loaded.'),
        { tag: CODEC_LIST ? String(CODEC_LIST.length) : 'decoded reference' }) +
      Kit.section('Render and Record Presets',
        `<div class="p-note">Shipped in default\\Presets\\Render and Record, read out of the
          preset XML: these are the real values, not a paraphrase.</div>` + presets(),
        { tag: String(Kit.presets('Render and Record').length) }) +
      Kit.section('Queue Controls', helpRows(queue, 'No decoded queue components.'),
        { tag: 'decoded reference' }) +
      Kit.section('Record Controls',
        `<div class="p-note">Arena groups these with the queue; the Recording panel is
          where they belong.</div>` + helpRows(other, 'No decoded record components.'),
        { tag: 'decoded reference', folded: true }) +
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
