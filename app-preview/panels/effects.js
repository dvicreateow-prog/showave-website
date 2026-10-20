/* ===========================================================================
   panels/effects.js — the Effects browser.
   ---------------------------------------------------------------------------
   Arena's own description of this panel (decoded component "Effects"):
     "List of audio and video effects with their presets. Drag the effect or
      the preset to a clip, layer, group or composition. or double click to
      preview it on the current selection."

   The list is whatever the running Arena pushed over the socket
   (effects_update -> AL.effects = { audio:[…], video:[…] }), each entry with
   idstring / name / description / category / presets. Nothing here is a
   hand-written catalogue; offline we fall back to the 106 video and 6 audio
   names decoded from the installed 7.27.1 build and say so.

   Adding uses the instantiation URI the shipped REST spec documents
   (rest/docs/swagger.yaml): a text/plain body of
       effect:///video/<name>            or  effect:///video/<name>/<preset>
   posted to  /composition/layers/{n}/effects/{video|audio}/add.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* Effects and Sources are the same browser over different lists, so they share
   one small class vocabulary on top of workspace.css. Whichever module the
   page loads first installs it; the sheet is identical in both files. */
const SHEET = `
.pb-stick{ position:sticky; top:0; z-index:3; }
.pb-foot{ position:sticky; bottom:0; z-index:3; background:var(--head);
  border-top:1px solid var(--line); padding:var(--space-2) var(--space-3);
  max-height:45%; overflow:auto; }
.pb-row{ cursor:default; }
.pb-row[draggable=true]{ cursor:grab; }
.pb-row[draggable=true]:active{ cursor:grabbing; }
.pb-sp{ flex:1; }
.pb-name{ overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.pb-row .fav{ visibility:hidden; color:var(--n600); font-size:10px; padding:0 3px;
  cursor:pointer; border-radius:var(--radius-sm); }
.pb-row:hover .fav{ visibility:visible; }
.pb-row .fav.on{ visibility:visible; color:var(--color-accent); }
.pb-title{ color:var(--n200); }
.pb-id{ color:var(--n700); font-size:9.5px; margin:1px 0 3px; }
.pb-desc{ color:var(--n500); font-size:10.5px; white-space:pre-wrap; }
.pb-chips{ margin-top:var(--space-2); }
.pb-chip{ display:inline-block; margin:0 4px 4px 0; padding:0 7px; font-size:10px;
  border:1px solid var(--n800); border-radius:999px; color:var(--n500); cursor:grab; }
.pb-chip:hover{ border-color:var(--a600); color:var(--n200); }
.pb-msg{ color:var(--a300); font-size:10px; }
`;
function installSheet() {
  if (document.getElementById('pb-css')) return;
  const s = document.createElement('style');
  s.id = 'pb-css'; s.textContent = SHEET;
  document.head.appendChild(s);
}

/* Arena keeps its own favourites; the REST API carries no endpoint for them,
   so ours are this browser's only. */
const FAVKEY = 'openlive.favs.effects';
const favLoad = () => {
  try { return new Set(JSON.parse(localStorage.getItem(FAVKEY) || '[]')); }
  catch { return new Set(); }
};
const favSave = s => { try { localStorage.setItem(FAVKEY, JSON.stringify([...s])); } catch {} };

/* the socket sends { audio, video }; tolerate a bare array either way */
const tracks = o => Array.isArray(o)
  ? { video: o, audio: [] }
  : { video: (o && o.video) || [], audio: (o && o.audio) || [] };

/* Arena's own wording, plus where ours actually live */
const FAVHELP = 'Select to add or remove this source or effect to your Favorites. ' +
  'Kept in this browser: the REST API carries no favourites endpoint, so Arena will not see it.';

function row(x, track, favs, live) {
  const n = live ? (x.presets || []).length : 0;
  return `<div class="p-row pb-row"${live ? ' draggable="true"' : ''}
      data-name="${Kit.esc(x.name)}" data-track="${Kit.esc(track)}"${
        live ? ` data-id="${Kit.esc(x.idstring)}"` : ''}
      title="${Kit.esc((live && x.description) || x.name)}">
    <span class="pb-name">${Kit.esc(x.name)}</span><span class="pb-sp"></span>
    ${n ? `<span class="p-dim">${n} preset${n > 1 ? 's' : ''}</span>` : ''}
    ${live ? `<span class="fav${favs.has(x.idstring) ? ' on' : ''}"
      data-fav="${Kit.esc(x.idstring)}" title="${FAVHELP}">&#9829;</span>` : ''}
  </div>`;
}

/* group by the category Arena reports, in the order Arena reports it */
function categories(list, track) {
  const by = new Map();
  (list || []).forEach(x => {
    const c = x.category || (track === 'audio' ? 'Audio Effects' : 'Video Effects');
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(x);
  });
  return [...by].map(([cat, items]) => ({ cat, track, items }));
}

/* the decoded factory preset catalogue, used as reference where the API stops */
function decodedPresets() {
  return Kit.presets('Video Effects').map(p => ({
    label: p.name, dim: (p.params || {})[p.name + '.className'] || ''
  }));
}

WS.register('Effects', {
  title: 'Effects',
  build(host) {
    installSheet();
    const st = { q: '', sel: null, favs: favLoad(), fx: undefined, status: undefined, msg: 0 };

    /* ---- where a double-click lands ------------------------------------- */
    const targetLayer = () => {
      const ls = AL.layers();
      for (let i = 1; i <= ls.length; i++)
        if (AL.val(ls[i - 1].selected) === true) return i;
      return null;
    };
    const layerLabel = l => Kit.dispName(AL.val((AL.layer(l) || {}).name), l);

    function addEffect(track, name, preset) {
      const l = targetLayer();
      if (!l) return note('No layer is selected in Arena.');
      const uri = `effect:///${track}/${encodeURIComponent(name)}` +
                  (preset ? `/${encodeURIComponent(preset)}` : '');
      AL.rest(`/composition/layers/${l}/effects/${track}/add`,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: uri })
        .then(() => note(`+ ${name}${preset ? ' · ' + preset : ''} on ${layerLabel(l)}`))
        .catch(e => note(String(e.message || e)));
    }
    function note(t) {
      const m = host.querySelector('#pbMsg');
      if (!m) return;
      m.textContent = t;
      clearTimeout(st.msg);
      st.msg = setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 2600);
    }

    /* ---- lookup --------------------------------------------------------- */
    function findEntry(id) {
      const t = tracks(AL.effects);
      let x = t.video.find(e => e.idstring === id);
      if (x) return { x, track: 'video' };
      x = t.audio.find(e => e.idstring === id);
      return x ? { x, track: 'audio' } : null;
    }

    /* ---- markup --------------------------------------------------------- */
    function liveBody() {
      const t = tracks(AL.effects);
      const groups = categories(t.video, 'video').concat(categories(t.audio, 'audio'));
      const favs = [];
      groups.forEach(g => g.items.forEach(x => {
        if (st.favs.has(x.idstring)) favs.push({ x, track: g.track });
      }));
      return (favs.length
          ? Kit.section('Favorites', favs.map(f => row(f.x, f.track, st.favs, true)).join(''),
              { tag: String(favs.length) })
          : '') +
        groups.map(g => Kit.section(g.cat,
          g.items.map(x => row(x, g.track, st.favs, true)).join(''),
          { tag: String(g.items.length) })).join('');
    }

    function offlineBody() {
      const V = typeof VIDEO_EFFECTS !== 'undefined' ? VIDEO_EFFECTS : [];
      const A = typeof AUDIO_EFFECTS !== 'undefined' ? AUDIO_EFFECTS : [];
      return Kit.offline('The names below are decoded from the installed Arena 7.27.1. ' +
          'Descriptions, ids and per-effect presets exist only on the live connection, ' +
          'so nothing here can be dragged or added.') +
        (V.length ? Kit.section('Video Effects',
          V.map(n => row({ name: n }, 'video', st.favs, false)).join(''),
          { tag: String(V.length) }) : '') +
        (A.length ? Kit.section('Audio Effects',
          A.map(n => row({ name: n }, 'audio', st.favs, false)).join(''),
          { tag: String(A.length) }) : '');
    }

    function body() {
      if (AL.status !== 'live') return offlineBody();
      if (!AL.effects) return Kit.nothing('Connected. Waiting for Arena to push its effect list.');
      return liveBody();
    }

    /* Arena's Presets button manages saved presets; the API has no verb for it */
    function presetSection() {
      const cat = decodedPresets();
      return Kit.section('Preset Management',
        Kit.unavailable('Saving, renaming and deleting presets',
          'The API reports every effect\'s factory presets and will instantiate one, but ' +
          'carries no endpoint to save, rename or delete a preset: Arena\'s Presets button ' +
          'is application-side only.') +
        (cat.length
          ? `<div class="p-note">Decoded factory catalogue, ${cat.length} presets in ` +
            `default\\Presets\\Video Effects, with the class each belongs to:</div>` +
            Kit.list(cat)
          : ''),
        { folded: true, tag: String(cat.length) });
    }

    function detail(hit) {
      if (!hit) return '<div class="p-note">Select an effect for its description and presets.</div>';
      const { x, track } = hit;
      const ps = x.presets || [];
      return `<div class="pb-title">${Kit.esc(x.name)}</div>
        <div class="pb-id">${Kit.esc(x.category || '')} · ${Kit.esc(x.idstring)}</div>
        ${x.description ? `<div class="pb-desc">${Kit.esc(x.description)}</div>` : ''}
        ${ps.length
          ? `<div class="pb-chips">${ps.map(p => `<span class="pb-chip" draggable="true"
              data-id="${Kit.esc(x.idstring)}" data-name="${Kit.esc(x.name)}"
              data-preset="${Kit.esc(p.name)}" data-track="${Kit.esc(track)}"
              title="Factory preset: drag onto a target, or double-click to add ${
                Kit.esc(x.name)} with ${Kit.esc(p.name)}">${Kit.esc(p.name)}</span>`).join('')}</div>`
          : '<div class="p-note">No factory presets.</div>'}`;
    }

    /* ---- wiring --------------------------------------------------------- */
    function rebuild() {
      const y = host.scrollTop;
      host.innerHTML =
        `<div class="pb-stick">` + Kit.toolbar(
          `<input type="text" id="pbQ" placeholder="Search"
             title="Start typing to narrow down the list of results to the entered text.">
           <span class="ws-chip" id="pbTarget"></span>`) + `</div>` +
        body() + presetSection() +
        `<div class="pb-foot"><div class="pb-msg" id="pbMsg"></div>
          <div id="pbDetail"></div></div>`;
      wire();
      filter();
      select(st.sel);
      syncTarget();
      host.scrollTop = y;
    }

    function wire() {
      Kit.bind(host);                       // section folding lives in Kit.bind
      const q = host.querySelector('#pbQ');
      if (q) {
        q.value = st.q;
        q.addEventListener('input', () => { st.q = q.value; filter(); });
      }
      host.querySelectorAll('.pb-row').forEach(r => {
        if (!r.dataset.id) return;          // offline rows carry a name and nothing else
        r.addEventListener('dragstart', e => {
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', JSON.stringify(
            { kind: 'effect', id: r.dataset.id, name: r.dataset.name }));
        });
        r.addEventListener('click', () => select(r.dataset.id));
        r.addEventListener('dblclick', () => addEffect(r.dataset.track, r.dataset.name, null));
      });
      host.querySelectorAll('.fav').forEach(f => f.addEventListener('click', e => {
        e.stopPropagation();
        const id = f.dataset.fav;
        st.favs.has(id) ? st.favs.delete(id) : st.favs.add(id);
        favSave(st.favs);
        rebuild();                          // the Favorites group changes shape
      }));
    }

    /* preset chips are re-rendered with the detail strip, so they wire there */
    function wireChips() {
      host.querySelectorAll('.pb-chip').forEach(c => {
        c.addEventListener('dragstart', e => {
          e.dataTransfer.effectAllowed = 'copy';
          /* the required payload plus the preset, which drop targets that know
             about presets can use and the rest ignore */
          e.dataTransfer.setData('text/plain', JSON.stringify(
            { kind: 'effect', id: c.dataset.id, name: c.dataset.name, preset: c.dataset.preset }));
        });
        c.addEventListener('dblclick', () =>
          addEffect(c.dataset.track, c.dataset.name, c.dataset.preset));
      });
    }

    function select(id) {
      const hit = id ? findEntry(id) : null;
      st.sel = hit ? id : null;
      host.querySelectorAll('.pb-row').forEach(r =>
        r.classList.toggle('sel', !!st.sel && r.dataset.id === st.sel));
      const d = host.querySelector('#pbDetail');
      if (d) { d.innerHTML = detail(hit); wireChips(); }
    }

    /* match on the name and the description, not on the row's rendered text —
       the preset count and the heart would otherwise match every query */
    function filter() {
      const q = st.q.trim().toLowerCase();
      host.querySelectorAll('.pb-row').forEach(r => {
        const hit = !q || (r.dataset.name + ' ' + (r.title || '')).toLowerCase().includes(q);
        r.style.display = hit ? '' : 'none';
      });
      host.querySelectorAll('.p-sec').forEach(s => {
        const rows = s.querySelectorAll('.pb-row');
        if (!rows.length) return;
        s.style.display = [...rows].some(r => r.style.display !== 'none') ? '' : 'none';
      });
    }

    function syncTarget() {
      const chip = host.querySelector('#pbTarget');
      if (!chip) return;
      const l = AL.status === 'live' ? targetLayer() : null;
      chip.classList.toggle('on', !!l);
      chip.textContent = l ? layerLabel(l) : 'no target';
      chip.title = l
        ? `Double-click an effect to add it to ${layerLabel(l)}`
        : 'Select a layer in Arena to make double-click add an effect to it.';
    }

    /* ---- lifecycle ------------------------------------------------------
       the list only changes when Arena pushes a new effects_update, so a full
       rebuild is keyed on that object's identity; every other tick just
       refreshes the target chip. */
    const paint = () => {
      if (AL.status !== st.status || AL.effects !== st.fx) {
        st.status = AL.status; st.fx = AL.effects;
        rebuild();
        return;
      }
      syncTarget();
    };
    const off = Kit.live(host, paint, { applyOnly: false, repaintOnParam: true });
    /* effects_update rides its own event, which Kit.live does not carry */
    const onList = () => { if (!host.isConnected) return AL.off('effects', onList); paint(); };
    AL.on('effects', onList);
    host._panelOff = () => { off(); AL.off('effects', onList); clearTimeout(st.msg); };
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
