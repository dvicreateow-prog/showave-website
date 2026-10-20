/* ===========================================================================
   panel-kit.js — the vocabulary every workspace panel is built from.
   ---------------------------------------------------------------------------
   A panel is registered like this:

     Workspace.register('Clip', {
       title: 'Clip',
       build(host, node, ws) { ... },     // host is an empty div, fill it
       destroy(host, node) { ... }        // optional; unsubscribe here
     });

   Rules a panel must follow:
     · Read live state through ArenaLive (AL). Never invent values. If Arena is
       not connected, say so with Kit.offline() rather than showing fiction.
     · Write through Kit.bind() / AL.setParam(), never by mutating the model.
     · Repaint through Kit.live(host, fn) so bursts of websocket traffic
       coalesce into one repaint and the subscription dies with the panel.
     · Every control that exists in Arena for this panel should exist here.
       RESOLUME.arena.components is the checklist — it names all 402.
   =========================================================================== */
window.PanelKit = (() => {
  'use strict';
  const AL = window.ArenaLive;
  const R  = () => window.RESOLUME || {};

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = s => String(s ?? '').replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const val = p => (p && typeof p === 'object' && 'value' in p) ? p.value : p;
  const dispName = (raw, i) => String(raw ?? '').replace(/#/g, i);
  const uiTerm = value => window.ShowaveBrand && window.ShowaveBrand.term
    ? window.ShowaveBrand.term(value) : String(value ?? '');
  const uiLabel = value => window.ShowaveBrand && window.ShowaveBrand.label
    ? window.ShowaveBrand.label(value) : uiTerm(value);

  /* ---- section ----------------------------------------------------------- */
  function section(title, bodyHTML, opts) {
    opts = opts || {};
    return `<div class="p-sec${opts.folded ? ' folded' : ''}" data-sec="${esc(title)}">
      <h4>${esc(uiLabel(title))}${opts.tag ? `<span class="p-tag">${esc(opts.tag)}</span>` : ''}</h4>
      <div class="p-body">${bodyHTML}</div></div>`;
  }
  function wireSections(host) {
    host.querySelectorAll('.p-sec > h4').forEach(h =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('folded')));
  }

  /* ---- one row per live parameter ---------------------------------------
     The row it produces depends on the parameter's own valuetype, so a panel
     never has to know whether something is a slider or a dropdown — Arena
     already said. */
  const fmt = (p, v) => {
    if (p.valuetype !== 'ParamRange' && p.valuetype !== 'ParamNumber') return String(v);
    const min = p.min ?? 0, max = p.max ?? 1;
    if (min === 0 && max === 1) return Math.round(v * 100) + ' %';
    return Math.abs(max - min) > 50 ? String(Math.round(v)) : (+v).toFixed(2);
  };
  function param(label, p, opts) {
    opts = opts || {};
    const displayLabel = uiTerm(label);
    if (!p || p.id == null) return '';
    const id = p.id, t = p.valuetype, v = p.value;
    const tw = '<div class="tw"></div>';
    const lab = `<label title="${esc(opts.help || displayLabel)}">${esc(displayLabel)}</label>`;
    if (t === 'ParamChoice' || t === 'ParamState') {
      return `<div class="prow live" data-pid="${id}">${tw}${lab}
        <select class="pbind" data-pid="${id}"${t === 'ParamState' ? ' disabled' : ''}>${
          (p.options || []).map(o => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(uiTerm(o))}</option>`).join('')
        }</select></div>`;
    }
    if (t === 'ParamBoolean') {
      return `<div class="prow live" data-pid="${id}">${tw}${lab}
        <button class="btn pbind wide ${v ? 'on' : ''}" data-pid="${id}" data-kind="bool">${v ? 'On' : 'Off'}</button></div>`;
    }
    if (t === 'ParamString' || t === 'ParamText') {
      return `<div class="prow live" data-pid="${id}">${tw}${lab}
        <input class="pbind ptext wide" type="text" data-pid="${id}" value="${esc(v)}"></div>`;
    }
    if (t === 'ParamTrigger' || t === 'ParamEvent') {
      return `<div class="prow live" data-pid="${id}">${tw}${lab}
        <button class="btn pbind wide" data-pid="${id}" data-kind="trig">${esc(opts.verb || 'Trigger')}</button></div>`;
    }
    if (t === 'ParamColor') {
      return `<div class="prow live" data-pid="${id}">${tw}${lab}
        <input class="pbind wide" type="color" data-pid="${id}" data-kind="color"
          value="${esc(String(v || '#000000').slice(0, 7))}"></div>`;
    }
    const min = p.min ?? 0, max = p.max ?? 1;
    return `<div class="prow live" data-pid="${id}">${tw}${lab}
      <div class="val" data-pid="${id}">${esc(fmt(p, v))}</div>
      <div class="stp" data-pid="${id}" data-d="-1">−</div><div class="stp" data-pid="${id}" data-d="1">+</div>
      <input class="pbind" type="range" data-pid="${id}" data-min="${min}" data-max="${max}"
        min="0" max="1000" step="1" value="${Math.round(((v - min) / ((max - min) || 1)) * 1000)}"></div>`;
  }
  /* every parameter of an object, in the object's own order */
  function params(obj, opts) {
    if (!obj) return '';
    return Object.entries(obj)
      .filter(([, p]) => p && p.valuetype)
      .map(([k, p]) => param((opts && opts.rename ? opts.rename(k) : k.replace(/_/g, ' ')), p))
      .join('');
  }

  /* ---- two-way binding --------------------------------------------------- */
  function bind(host) {
    host.querySelectorAll('select.pbind').forEach(e =>
      e.addEventListener('change', () => AL.setParam(+e.dataset.pid, e.value)));
    host.querySelectorAll('input.ptext').forEach(e =>
      e.addEventListener('change', () => AL.setParam(+e.dataset.pid, e.value)));
    host.querySelectorAll('input[data-kind=color]').forEach(e =>
      e.addEventListener('change', () => AL.setParam(+e.dataset.pid, e.value)));
    host.querySelectorAll('button.pbind').forEach(e =>
      e.addEventListener('click', () => {
        const id = +e.dataset.pid;
        if (e.dataset.kind === 'trig') return AL.triggerParam(id);
        const p = AL.paramById(id), nv = !(p && p.value);
        AL.setParam(id, nv);
        e.classList.toggle('on', nv); e.textContent = nv ? 'On' : 'Off';
      }));
    host.querySelectorAll('input[type=range].pbind').forEach(e => {
      const min = +e.dataset.min, max = +e.dataset.max;
      e.addEventListener('input', () => {
        const v = min + (+e.value / 1000) * (max - min);
        AL.setParam(+e.dataset.pid, v);
        const cell = host.querySelector(`.val[data-pid="${e.dataset.pid}"]`);
        if (cell) {
          const p = AL.paramById(+e.dataset.pid) || { min, max, valuetype: 'ParamRange' };
          cell.textContent = fmt(p, v);
        }
      });
    });
    host.querySelectorAll('.stp[data-pid]').forEach(e => e.addEventListener('click', () => {
      const r = host.querySelector(`input[type=range][data-pid="${e.dataset.pid}"]`);
      if (!r) return;
      r.value = clamp(+r.value + (+e.dataset.d) * 10, 0, 1000);
      r.dispatchEvent(new Event('input'));
    }));
    /* right-click a label to reset, as Arena does */
    host.querySelectorAll('.prow[data-pid] > label').forEach(l =>
      l.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        AL.resetParam(+l.parentElement.dataset.pid);
      }));
    wireSections(host);
    return host;
  }

  /* push a subscribed update into whatever this panel has on screen */
  function apply(host, id, p) {
    const sel = host.querySelector(`select.pbind[data-pid="${id}"]`);
    if (sel && document.activeElement !== sel && p.value != null) sel.value = p.value;
    const txt = host.querySelector(`input.ptext[data-pid="${id}"]`);
    if (txt && document.activeElement !== txt && p.value != null) txt.value = p.value;
    const btn = host.querySelector(`button.pbind[data-pid="${id}"][data-kind=bool]`);
    if (btn) { btn.classList.toggle('on', !!p.value); btn.textContent = p.value ? 'On' : 'Off'; }
    const rng = host.querySelector(`input[type=range].pbind[data-pid="${id}"]`);
    if (rng && document.activeElement !== rng) {
      const min = +rng.dataset.min, max = +rng.dataset.max;
      rng.value = Math.round(((p.value - min) / ((max - min) || 1)) * 1000);
      const cell = host.querySelector(`.val[data-pid="${id}"]`);
      if (cell) cell.textContent = fmt(Object.assign({ min, max }, p), p.value);
    }
  }

  /* ---- lifecycle ---------------------------------------------------------
     live(host, paint) calls paint() now, on every composition push, and on
     every subscribed parameter change — coalesced to one repaint per frame,
     and detached automatically when the host leaves the document. */
  function live(host, paint, opts) {
    opts = opts || {};
    let queued = false, dead = false;
    const flush = () => {
      queued = false;
      if (dead) return;
      if (!host.isConnected) { off(); return; }
      try { paint(); } catch (e) { console.error('panel repaint', e); }
    };
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(flush); setTimeout(flush, 40); } };
    const onComp = () => schedule();
    const onStat = () => schedule();
    const onParam = ({ id, param }) => {
      if (opts.applyOnly !== false) apply(host, id, param);
      if (opts.repaintOnParam) schedule();
    };
    AL.on('comp', onComp); AL.on('status', onStat); AL.on('param', onParam);
    function off() {
      dead = true;
      AL.off('comp', onComp); AL.off('status', onStat); AL.off('param', onParam);
    }
    host._panelOff = off;
    flush();
    return off;
  }

  /* ---- states ------------------------------------------------------------ */
  const offline = (what) =>
    `<div class="p-empty">Not connected to Arena.<br><span class="hint">${
      esc(what || 'This panel shows live state only.')}</span></div>`;
  const nothing = (what) => `<div class="p-empty">${esc(what)}</div>`;
  const unavailable = (what, why) =>
    `<div class="p-empty"><b>${esc(what)}</b><br><span class="hint">${esc(why)}</span></div>`;

  /* ---- decoded reference, for panels that need Arena's own vocabulary ---- */
  const components = panel => {
    const c = (R().arena && R().arena.components) || {};
    return c[panel] || [];
  };
  const strings = () => (R().arena && R().arena.strings) || {};
  const str = (k, fallback) => strings()[k] || fallback || k;
  const presets = cat => ((R().arena && R().arena.presets) || {})[cat] || [];
  const api = group => ((R().arena && R().arena.api) || {})[group] || [];

  /* ---- effect chain ------------------------------------------------------
     Shared because every property panel needs it and because the endpoint
     contract is easy to get wrong. From swagger:

       add   POST <scope>/effects/<track>/add[/<offset>]
             body is text/plain, an effect URI: "effect:///video/Blow", or
             with a factory preset: "effect:///video/Blow/Solid".
             NOT JSON, and NOT the idstring — both return 400.
       move  POST <scope>/effects/<track>/move/<destination>
             body is text/plain, the moving effect's own resource path, e.g.
             "/composition/layers/1/effects/video/2". The path offset is where
             it lands, so moving effect 2 up targets move/1.
       remove DELETE <scope>/effects/<track>/<offset>, no body.               */
  function effectChain(scope, effects, track) {
    track = track || 'video';
    const list = effects || [];
    const rows = list.map((fx, i) => {
      /* `at` is the API's offset and it is zero-based — verified live, see the
         note over cmd.addEffect. `shown` is what Arena numbers it in the UI. */
      const at = i, shown = i + 1;
      const body = [
        fx.bypassed ? param('Bypassed', fx.bypassed) : '',
        fx.mixer ? params(fx.mixer) : '',
        params(fx.params),
      ].filter(Boolean).join('') || '<div class="p-note">no parameters</div>';
      const btn = (attr, val, title, glyph) =>
        `<span class="fxbtn" data-${attr}="${val}" data-scope="${esc(scope)}" data-track="${esc(track)}"
          data-at="${at}" data-fxname="${esc(fx.name || '')}" title="${title}">${glyph}</span>`;
      return `<div class="fx">
        <div class="fxhead"><b>${shown}</b> ${esc(fx.display_name || fx.name)}
          <span class="fxsp"></span>
          ${i > 0 ? btn('fx-move', at - 1, 'Move up', '▲') : ''}
          ${i < list.length - 1 ? btn('fx-move', at + 1, 'Move down', '▼') : ''}
          ${fx.is_user_removable === false ? '' : btn('fx-remove', at, 'Remove', '✕')}
        </div><div class="fxbody">${body}</div></div>`;
    }).join('');
    return rows + `<div class="dropmsg" data-fxdrop="${esc(scope)}" data-fxtrack="${esc(track)}">
      Drop an effect here</div>`;
  }

  function wireEffects(host, onDone) {
    const done = (label) => { if (onDone) onDone(label); };
    const fail = (e) => { if (onDone) onDone('failed: ' + (e && e.message || e)); else console.warn(e); };

    host.querySelectorAll('[data-fx-remove]').forEach(b => b.addEventListener('click', () =>
      AL.cmd.removeEffect(b.dataset.scope, +b.dataset.at, b.dataset.track)
        .then(() => done('effect removed')).catch(fail)));

    host.querySelectorAll('[data-fx-move]').forEach(b => b.addEventListener('click', () =>
      AL.cmd.moveEffect(b.dataset.scope, +b.dataset.at, +b.dataset.fxMove,
                        b.dataset.track, b.dataset.fxname)
        /* the fallback path re-inserts rather than moves, which loses the
           effect's settings — say which one actually happened */
        .then(r => done(r && r.reinserted
          ? 'reordered by re-inserting. This build rejects move, so its settings reset'
          : 'effect moved'))
        .catch(fail)));

    host.querySelectorAll('[data-fxdrop]').forEach(d => {
      d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('drop'); });
      d.addEventListener('dragleave', () => d.classList.remove('drop'));
      d.addEventListener('drop', e => {
        e.preventDefault(); d.classList.remove('drop');
        let item; try { item = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
        if (!item || item.kind !== 'effect') return;
        /* the URI is built from the effect's NAME; the idstring is not accepted */
        AL.cmd.addEffect(d.dataset.fxdrop, item.name || item.id, d.dataset.fxtrack)
          .then(() => done('added ' + (item.name || item.id))).catch(fail);
      });
    });
  }

  /* ---- small shared widgets ---------------------------------------------- */
  function toolbar(html) { return `<div class="p-toolbar">${html}</div>`; }
  function list(items, opts) {
    opts = opts || {};
    if (!items.length) return nothing(opts.empty || 'Nothing here.');
    return `<div class="p-list">${items.map((i, n) =>
      `<div class="p-row" data-i="${n}"${i.id != null ? ` data-id="${esc(i.id)}"` : ''}>
        <span>${esc(i.label)}</span>${i.dim ? `<span class="p-dim">${esc(i.dim)}</span>` : ''}
      </div>`).join('')}</div>`;
  }
  function searchFilter(host, inputSel, rowSel) {
    const inp = host.querySelector(inputSel);
    if (!inp) return;
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      host.querySelectorAll(rowSel).forEach(r =>
        r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none');
    });
  }

  return { el, esc, clamp, val, dispName, fmt,
           section, wireSections, param, params, bind, apply, live,
           effectChain, wireEffects,
           offline, nothing, unavailable,
           components, strings, str, presets, api,
           toolbar, list, searchFilter, AL };
})();
