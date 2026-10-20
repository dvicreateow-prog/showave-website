/* ===========================================================================
   panels/toolbar.js — the transport bar.
   ---------------------------------------------------------------------------
   Everything on this bar is one of three things, and the panel says which:

     live      composition.tempocontroller (tempo, play_state, tempo_tap,
               resync, tempo_push, tempo_pull) and composition.crossfader
               (phase, behaviour, curve, sidea, sideb, mixer.Blend Mode), plus
               composition.master and composition.bypassed — all read from the
               push, all written through Kit.bind / AL.setParam.
     REST      undo and redo, which are POST /composition/action with a
               text/plain body of "undo" or "redo" (swagger.yaml calls the
               operation composition_action; it answers with what it undid).
     absent    beat phase, metronome, FFT gain, Ableton Link, FPS and hardware
               stats. Arena has all five; the REST API carries none of them.
               Those get Kit.unavailable, except the pie and the metronome,
               which are honest local aids rather than dead buttons.

   The pie is a local clock. Arena streams the tempo but never the beat, so it
   counts its own quarters from Arena's BPM and re-phases when you Resync — and
   it is labelled local rather than dressed up as Arena's own clock.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;
const esc = Kit.esc;

/* a transport bar is the one panel that is a row of controls rather than a
   column of parameter rows, so it needs a little geometry of its own */
if (!document.getElementById('tbCss')) {
  const s = document.createElement('style');
  s.id = 'tbCss';
  s.textContent = `
.tb-bar{ flex-wrap:wrap; row-gap:var(--space-2); }
.tb-lbl{ font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--n600); }
.tb-num{ font-size:13px; padding:1px var(--space-3); min-width:58px; text-align:center; }
.tb-xf{ flex:1 1 90px; min-width:60px; }`;
  document.head.appendChild(s);
}

/* ---- Arena's own words, so no label on this bar is invented ------------- */
const HELP_IN = ['Composition', 'Other', 'Dashboard', 'Preferences'];
function help(title) {
  for (const g of HELP_IN) {
    const hit = Kit.components(g).find(c => c.title === title);
    if (hit) return hit.help || '';
  }
  return '';
}

/* View toggles: the workspace holds them once a layout is loaded, and the
   decoded layout params hold the shipped defaults for an undocked window */
function viewOn(name) {
  const v = WS.param(name);
  if (v !== undefined) return !!v;
  const d = ((window.RESOLUME || {}).arena || {}).layout_params || {};
  return d[name] ? d[name].default === '1' : true;
}

const num = v => (Number.isInteger(v) ? String(v) : (+v).toFixed(2));
const STATE_GLYPH = { Play: '▶', Pause: '‖', Stop: '■' };

WS.register('Toolbar', {
  title: 'Toolbar',
  build(host) {
    let beat = 0, painted = -1, last = performance.now();
    let metro = false, ac = null, raf = 0;
    let ui = null, editing = false, note = '';

    const tc     = () => (AL.comp && AL.comp.tempocontroller) || {};
    const tempoP = () => tc().tempo || null;
    const stateP = () => tc().play_state || null;
    const bpm    = () => { const p = tempoP(); return p ? +AL.val(p) : 0; };

    function setBpm(v) {
      const p = tempoP(); if (!p) return;
      AL.setParam(p.id, Kit.clamp(v, p.min ?? 20, p.max ?? 500));
    }
    function click(accent) {
      /* the first tick has to come off a user gesture or the browser mutes it */
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = accent ? 1500 : 900;
      g.gain.setValueAtTime(.12, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + .06);
      o.connect(g).connect(ac.destination);
      o.start(); o.stop(ac.currentTime + .07);
    }

    /* one animation loop drives the pie, the BPM readout and the play-state
       lamps, so a 120 bpm clock never costs the panel a full repaint */
    function tick(now) {
      raf = 0;
      if (!host.isConnected) return;
      raf = requestAnimationFrame(tick);
      if (!ui) return;
      const st = AL.val(stateP()), b = bpm();
      if (st === 'Play' && b > 0) {
        const iv = 60000 / b;
        if (now - last >= iv) {
          last += iv;
          if (now - last > iv * 4) last = now;      // tab was backgrounded — re-anchor
          beat++;
          if (metro) click(beat % 4 === 0);
        }
      } else if (st === 'Stop') { beat = 0; last = now; }
      paintClock();
      paintValues();
    }
    /* readouts are painted here as well as on every frame, because a hidden
       tab gets no animation frames and a stale BPM would be a lie */
    function paintValues() {
      if (!ui) return;
      const b = bpm();
      if (ui.bpm && !editing) ui.bpm.textContent = b ? num(b) : 'N/A';
      const st = AL.val(stateP());
      ui.states.forEach(e => e.classList.toggle('on', e.dataset.state === st));
    }
    /* quarter 0 is the top-right, so beat 1 lights there and the ring runs
       clockwise; the outline marks the top of every sixteenth beat */
    function paintClock() {
      if (!ui || !ui.pie || beat === painted) return;
      painted = beat;
      const s = (beat % 4) * 90, e = s + 90;
      ui.pie.style.background = `conic-gradient(var(--inset) 0deg ${s}deg,` +
        ` var(--color-accent) ${s}deg ${e}deg, var(--inset) ${e}deg 360deg)`;
      ui.pie.classList.toggle('b16', beat % 16 === 0);
      ui.pie.title = `${help('BPM Clock')}\nLocal beat ${beat % 16 + 1} of 16`;
    }

    /* the one write here that is not a parameter */
    function action(which) {
      AL.rest('/composition/action', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: which
      }).then(r => { note = `${which} ${String(r || '').trim()}`.trim(); paintNote(); })
        .catch(e => { note = `${which} refused: ${e.message}`; paintNote(); });
    }
    function paintNote() { if (ui && ui.note) ui.note.textContent = note; }

    Kit.live(host, () => {
      ui = null; editing = false; painted = -1;
      if (AL.status !== 'live') {
        host.innerHTML = Kit.offline('The transport bar carries Arena\'s live tempo, master and crossfader.');
        return;
      }
      const c = AL.comp;
      if (!c) { host.innerHTML = Kit.nothing('Connected: waiting for the Show.'); return; }
      const T = c.tempocontroller, X = c.crossfader;

      /* ---- tempo bar ---- */
      const tempoBar = !T ? Kit.nothing('This Show carries no tempo controller.') :
        `<div class="p-toolbar tb-bar">
          <div class="bpm-pie" data-tb="pie"></div>
          ${((T.play_state && T.play_state.options) || []).map(o =>
            `<button class="btn sq" data-tb="state" data-state="${esc(o)}"
               title="${esc(o === 'Pause' ? help('Pause BPM clock') : o)}">${STATE_GLYPH[o] || esc(o)}</button>`).join('')}
          <span class="tb-lbl">${esc(Kit.str('BPM', 'BPM'))}</span>
          <div class="bpm-num tb-num" data-tb="bpm"
            title="${esc(help('BPM Value'))} Drag to scrub, click to type.">N/A</div>
          <button class="btn sq" data-tb="step" data-d="-1" title="${esc(help('BPM Adjust'))}">−</button>
          <button class="btn sq" data-tb="step" data-d="1" title="${esc(help('BPM Adjust'))}">+</button>
          <button class="btn sq" data-tb="mul" data-m=".5" title="${esc(help('BPM Divide / Multiply'))}">/2</button>
          <button class="btn sq" data-tb="mul" data-m="2" title="${esc(help('BPM Divide / Multiply'))}">×2</button>
          <button class="btn sq" data-tb="nudge" data-p="tempo_pull"
            title="${esc(help('BPM Nudge Up / Down'))} (tempo_pull)">⊣</button>
          <button class="btn sq" data-tb="nudge" data-p="tempo_push"
            title="${esc(help('BPM Nudge Up / Down'))} (tempo_push)">⊢</button>
          <button class="btn" data-tb="tap" title="${esc(help('BPM Tapper'))}">${esc(Kit.str('TAP', 'TAP'))}</button>
          <button class="btn" data-tb="resync" title="${esc(help('Re-Synchronize BPM clock'))}">${esc(Kit.str('RESYNC', 'RESYNC'))}</button>
          <button class="btn sq" data-tb="metro" title="${esc(help('Metronome'))} Local click in this browser: Arena exposes no metronome parameter.">♪</button>
          <span class="tb-lbl">local</span>
        </div>`;

      /* ---- undo bar — Show Undo Toolbar ---- */
      const undoBar = !viewOn('Show Undo Toolbar') ? '' :
        `<div class="p-toolbar tb-bar">
          <button class="btn sq" data-tb="undo" title="${esc(help('Undo'))}">↶</button>
          <button class="btn sq" data-tb="redo" title="${esc(help('Redo'))}">↷</button>
          <span class="tb-lbl" data-tb="note">${esc(note)}</span>
        </div>`;

      /* ---- master ---- */
      const master = Kit.section('Master',
        Kit.param('Master', c.master, { help: help('Master Opacity') }) +
        Kit.param('Bypass', c.bypassed, { help: help('Master Bypass') }) ||
        Kit.nothing('No master on this Show.'));

      /* ---- crossfader — Show Crossfader ----
         one fader, bound once: a second row on the same parameter id would
         leave Kit.apply updating only whichever came first in the DOM */
      const ph = X && X.phase;
      const xfader = !viewOn('Show Crossfader') ? '' : Kit.section(Kit.str('CrossFader', 'Crossfader'),
        (!X ? Kit.nothing('This Show carries no crossfader.') :
          `<div class="p-toolbar tb-bar" title="${esc(help('Crossfader'))}">
            ${X.sidea ? `<button class="btn pbind" data-pid="${X.sidea.id}" data-kind="trig"
              title="Take the crossfader to side A (sidea event)">A</button>` : ''}
            ${ph ? `<input class="pbind tb-xf" type="range" data-pid="${ph.id}"
              data-min="${ph.min ?? -1}" data-max="${ph.max ?? 1}" min="0" max="1000" step="1"
              value="${Math.round(((AL.val(ph) - (ph.min ?? -1)) / (((ph.max ?? 1) - (ph.min ?? -1)) || 1)) * 1000)}">` : ''}
            ${X.sideb ? `<button class="btn pbind" data-pid="${X.sideb.id}" data-kind="trig"
              title="Take the crossfader to side B (sideb event)">B</button>` : ''}
          </div>` +
          Kit.param('Behaviour', X.behaviour, { help: help('Crossfader Behaviour') }) +
          Kit.param('Curve', X.curve, { help: help('Crossfader Curve') }) +
          Kit.params(X.mixer)));

      /* ---- the gaps, each behind the View toggle that reveals it ---- */
      const gaps = [
        viewOn('Show FFT Gain') && Kit.section('FFT Gain',
          Kit.unavailable('FFT Gain is not in the REST API',
            'Arena analyses incoming audio and this bar carries a gain dial and a level meter, but ' +
            'no FFT path exists among the API\'s 258 paths and no FFT value appears anywhere in the ' +
            'Show payload, so there is nothing here to read or write. Arena\'s own help for the dial: "' +
            help('FFT Gain') + '"')),
        viewOn('Show Ableton Link') && Kit.section(Kit.str('LINK', 'Link'),
          Kit.unavailable('Ableton Link is not in the REST API',
            'The Link toggle, its session and its peer count live in the application only: the API ' +
            'carries tempo but never Link. Arena\'s own help: "' + help('Toggle Link') + '" ' +
            Kit.str('Use Ableton Link to share BPM and position with other link-enabled apps', ''))),
        (viewOn('Show FPS & Stats') || viewOn('Show Hardware Stats')) &&
          Kit.section('FPS & Hardware Stats',
            Kit.unavailable('Arena reports no telemetry over REST',
              'Frame rate, CPU, GPU, RAM and VRAM are drawn by the application from its own render ' +
              'loop. The API\'s only framerate field belongs to file info and describes a file, not ' +
              'the running engine, so this panel will not print a number it cannot read.')),
      ].filter(Boolean).join('');

      const off = ['Show Crossfader', 'Show FFT Gain', 'Show Undo Toolbar',
                   'Show Ableton Link', 'Show FPS & Stats', 'Show Hardware Stats']
        .filter(n => !viewOn(n));

      host.innerHTML =
        tempoBar + undoBar + master + xfader + gaps +
        `<div class="p-note">Pie and metronome are local: Arena streams the tempo, never the beat
          phase, so the pie counts its own quarters from Arena's BPM and Resync re-phases both.
          Undo and redo go to POST /composition/action.</div>` +
        (off.length ? `<div class="p-note">Hidden by View: ${esc(off.join(', '))}.</div>` : '');

      Kit.bind(host);
      wire();
      ui = {
        pie:    host.querySelector('[data-tb=pie]'),
        bpm:    host.querySelector('[data-tb=bpm]'),
        note:   host.querySelector('[data-tb=note]'),
        states: [...host.querySelectorAll('[data-tb=state]')],
      };
      const m = host.querySelector('[data-tb=metro]');
      if (m) m.classList.toggle('on', metro);
      paintClock(); paintValues();
      if (!raf) raf = requestAnimationFrame(tick);
    }, { repaintOnParam: false });

    /* the BPM cell and the play lamps are not Kit rows, so Kit.apply cannot
       refresh them — follow the two parameters they mirror directly */
    const onParam = ({ id }) => {
      const t = tempoP(), s = stateP();
      if ((t && id === t.id) || (s && id === s.id)) paintValues();
    };
    AL.on('param', onParam);

    /* ---- what this bar's own controls do --------------------------------- */
    function wire() {
      const q = s => host.querySelector(s), qa = s => [...host.querySelectorAll(s)];

      qa('[data-tb=state]').forEach(b => b.addEventListener('click', () => {
        const p = stateP(); if (!p) return;
        AL.setParam(p.id, b.dataset.state);
        last = performance.now();
        if (b.dataset.state === 'Stop') beat = 0;
      }));
      qa('[data-tb=step]').forEach(b =>
        b.addEventListener('click', () => setBpm(bpm() + (+b.dataset.d))));
      qa('[data-tb=mul]').forEach(b =>
        b.addEventListener('click', () => setBpm(bpm() * (+b.dataset.m))));
      qa('[data-tb=nudge]').forEach(b => b.addEventListener('click', () => {
        const p = tc()[b.dataset.p]; if (p) AL.triggerParam(p.id);
      }));
      const tap = q('[data-tb=tap]');
      if (tap) tap.addEventListener('click', () => {
        const p = tc().tempo_tap; if (p) AL.triggerParam(p.id);   // Arena averages the taps itself
      });
      const rs = q('[data-tb=resync]');
      if (rs) rs.addEventListener('click', () => {
        const p = tc().resync; if (p) AL.triggerParam(p.id);
        beat = 0; last = performance.now(); paintClock();
      });
      const mb = q('[data-tb=metro]');
      if (mb) mb.addEventListener('click', () => { metro = !metro; mb.classList.toggle('on', metro); });
      const u = q('[data-tb=undo]'), r = q('[data-tb=redo]');
      if (u) u.addEventListener('click', () => action('undo'));
      if (r) r.addEventListener('click', () => action('redo'));

      /* BPM readout: a drag scrubs, a click that never moved opens an editor */
      const cell = q('[data-tb=bpm]');
      if (!cell) return;
      cell.addEventListener('mousedown', ev => {
        ev.preventDefault();
        const y = ev.clientY, b0 = bpm();
        let moved = false;
        const mv = e2 => {
          if (!moved && Math.abs(e2.clientY - y) < 2) return;
          moved = true;
          setBpm(b0 + (y - e2.clientY) * .25);
        };
        const up = () => {
          removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
          if (!moved) edit(cell);
        };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      });
    }
    function edit(cell) {
      if (editing || !cell.isConnected) return;
      editing = true;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'bpm-num tb-num';
      inp.value = num(bpm());
      cell.replaceWith(inp);
      inp.focus(); inp.select();
      const done = commit => {
        if (!editing) return;
        editing = false;
        if (commit) { const v = parseFloat(inp.value); if (!isNaN(v)) setBpm(v); }
        if (inp.isConnected) inp.replaceWith(cell);
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      inp.addEventListener('blur', () => done(true));
    }

    /* Kit.live installed its own _panelOff; the clock and the audio context
       have to come down with it */
    const off = host._panelOff;
    host._panelOff = () => {
      if (off) off();
      AL.off('param', onParam);
      if (raf) cancelAnimationFrame(raf);
      raf = 0; ui = null;
      if (ac) { try { ac.close(); } catch {} ac = null; }
    };
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});
})();
