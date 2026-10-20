/* ===========================================================================
   panels/clip-time.js — the Clip Time panel.
   ---------------------------------------------------------------------------
   Arena's own description of this panel (support article "Clip Time Panel"):
   it shows the current system time plus the duration or remaining time of the
   clip you are playing; clicking a time display flips that clock to remaining,
   marked with a minus; the cogwheel picks which clocks you want.

   The layout node carries the clocks verbatim, and all ten shipped presets
   carry exactly these two:

     <ClipTime><Clocks><Clock mode="0" show_time_remaining="0"/>
                       <Clock mode="1" show_time_remaining="1"/></Clocks></ClipTime>

   What the mode NUMBERS name is in no decoded table — not in the components
   manifest, not in the string table, not in the REST spec — so each clock's
   subject is a control here rather than a guess, and the panel says so.

   Time comes from the live clip's own transport: the position parameter's
   place in its own range times the transport's duration. That works whatever
   transport document the clip has, without assuming position's units.
   =========================================================================== */
(() => {
'use strict';
const Kit = window.PanelKit, AL = window.ArenaLive, WS = window.Workspace;

/* the two subjects the panel's own documentation names; both strings are
   Arena's, from the binary string table (extracted/arena-binary-strings.json) */
const CLIP = 'Clip Time', SYS = 'System Time';

/* a big clock has no class in the .p-* vocabulary, and arena.css's .bigclock
   carries a literal grey the Nocturne ramps replaced — so, one style block. */
const CSS = `
.clk{ padding:var(--space-3) var(--space-4); border-bottom:1px solid var(--line); }
.clk-lab{ display:flex; align-items:center; gap:var(--space-2); font-size:9.5px;
  letter-spacing:.09em; text-transform:uppercase; color:var(--n600); }
.clk-lab select{ font-size:9.5px; padding:0 2px; letter-spacing:.06em; }
.clk-lab .m{ margin-left:auto; color:var(--n800); letter-spacing:.06em; }
.clk-t{ display:flex; align-items:baseline; gap:1px; cursor:pointer; user-select:none;
  color:var(--n100); font-variant-numeric:tabular-nums; font-weight:500;
  font-size:34px; line-height:1.1; }
.clk-t i{ font-style:normal; font-size:14px; color:var(--n600); }
.clk-t.rem{ color:var(--a300); }
.clk-t.none{ color:var(--n800); }
.clk.sys .clk-t{ cursor:default; }
.clk-sub{ font-size:10px; color:var(--n600); overflow:hidden; white-space:nowrap;
  text-overflow:ellipsis; }
.clk-where{ color:var(--n500); font-size:10px; overflow:hidden; white-space:nowrap;
  text-overflow:ellipsis; flex:1; min-width:0; }`;
function style() {
  if (document.getElementById('clkCSS')) return;
  const s = document.createElement('style');
  s.id = 'clkCSS'; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ---- the layout's Clocks child ----------------------------------------- */
function clocksIn(node) {
  const box = ((node && node.children) || []).find(c => c.type === 'Clocks');
  const list = ((box && box.children) || []).filter(c => c.type === 'Clock');
  return list.length ? list : null;
}
/* an undocked panel is handed a bare node, so fall back to what the shipped
   presets record — cloned, because the decoded data is never written to */
function shippedClocks() {
  const L = (window.RESOLUME && RESOLUME.arena && RESOLUME.arena.layouts) || {};
  for (const name of Object.keys(L)) {
    let hit = null;
    (function walk(n) {
      if (!n || hit) return;
      if (n.type === 'ClipTime') { hit = n; return; }
      (n.children || []).forEach(walk);
    })({ children: (L[name].windows || []).concat(L[name].hidden || []) });
    const cs = hit && clocksIn(hit);
    if (cs) return JSON.parse(JSON.stringify(cs));
  }
  return [];
}

/* ---- which clip the clock follows --------------------------------------
   selected first, as the Clip panel does, so the two panels agree; failing
   that the topmost playing clip, which is what a show clock wants. An empty
   slot can be the selected one and has no transport, so it is skipped here —
   a clock that goes blank because someone clicked a hole in the grid is worse
   than a clock still counting the clip that is on screen. */
function targetClip() {
  const n = AL.layers().length;
  for (let l = 1; l <= n; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++) {
      const k = clips[c - 1];
      if (k && AL.val(k.selected) === true && AL.val(k.connected) !== 'Empty')
        return { l, c, k, why: 'selected' };
    }
  }
  for (let l = n; l >= 1; l--) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++)
      if (clips[c - 1] && /^Connected/.test(String(AL.val(clips[c - 1].connected))))
        return { l, c, k: clips[c - 1], why: 'playing' };
  }
  for (let l = 1; l <= n; l++) {
    const clips = (AL.layer(l) || {}).clips || [];
    for (let c = 1; c <= clips.length; c++)
      if (clips[c - 1] && AL.val(clips[c - 1].connected) !== 'Empty')
        return { l, c, k: clips[c - 1], why: 'loaded' };
  }
  return null;
}

/* ---- clock face -------------------------------------------------------- */
const p2 = n => (n < 10 ? '0' : '') + n;
function hms(sec) {
  const s = Math.abs(sec);
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s % 3600 / 60))}:${p2(Math.floor(s % 60))}`;
}
const cs = sec => p2(Math.floor((Math.abs(sec) % 1) * 100));

WS.register('ClipTime', {
  title: 'Clip Time',
  build(host, node) {
    style();
    /* clock state lives on the layout node, exactly as Arena stores it, so a
       flip survives repaints and rides along with Workspace.save() */
    host._clocks = clocksIn(node) || shippedClocks();
    host._subj = host._clocks.map((c, i) => (i === 0 ? CLIP : SYS));

    const paint = () => {
      const clocks = host._clocks;
      if (!clocks.length) {
        host.innerHTML = Kit.nothing('This layout gives the panel no clocks.');
        return;
      }
      const rem = WS.param('showClipTimeRemaining') === true;

      if (AL.status !== 'live') {
        host._ro = null;
        host.innerHTML =
          bar(`${clocks.length} clock${clocks.length > 1 ? 's' : ''} in this layout`, '', rem) +
          Kit.offline('The clip clock reads the live Show; the system clock keeps running.') +
          faces(host, null) + decoded(clocks, rem);
        Kit.bind(host);
        wire(host, paint);
        tick(host);
        return;
      }

      const t = targetClip();
      const k = t && t.k;
      const tr = k && k.transport;
      const pos = tr && tr.position;
      const dur = tr && tr.controls && tr.controls.duration;

      /* keep the transport parameters flowing. AL.subscribe rather than
         subscribeEntity: the Clip panel owns the deep subscription and the two
         would otherwise trade it back and forth on every composition push. */
      [pos, dur, tr && tr.controls && tr.controls.speed].forEach(p => p && AL.subscribe(p.id));

      host._ro = pos ? { posId: pos.id, durId: dur ? dur.id : null } : null;

      const where = t
        ? `${Kit.dispName(AL.val((AL.layer(t.l) || {}).name), t.l)} · ${
            Kit.dispName(AL.val((AL.column(t.c) || {}).name), t.c)} · ${t.why}`
        : 'No clip loaded in this Show.';
      const label = t ? (AL.val(k.name) || '') : '';

      host.innerHTML =
        bar(label || where, where, rem) +
        faces(host, { label, where }) +
        readout(k, tr, pos, dur) +
        decoded(clocks, rem);

      Kit.bind(host);
      wire(host, paint);
      tick(host);
    };

    const off = Kit.live(host, paint, { repaintOnParam: false });
    /* the system clock has to tick with no Arena traffic at all, and the clip
       clock moves faster than composition pushes — so a timer writes the digits
       while Kit.live keeps owning every structural repaint */
    const timer = setInterval(() => {
      if (!host.isConnected) { clearInterval(timer); return; }
      tick(host);
    }, 100);
    host._panelOff = () => { clearInterval(timer); off(); };
  },
  destroy(host) { if (host._panelOff) host._panelOff(); }
});

/* ---- markup ------------------------------------------------------------ */
/* the remaining chip is a workspace setting, not Arena state, so it stays
   reachable while the connection is down */
function bar(text, tip, rem) {
  return Kit.toolbar(
    `<span class="clk-where"${tip ? ` title="${Kit.esc(tip)}"` : ''}>${Kit.esc(text)}</span>` +
    `<span class="ws-chip${rem ? ' on' : ''}" data-rem
       title="View › showClipTimeRemaining: the panel-wide setting; it writes every clock's own show_time_remaining">remaining</span>`);
}

function faces(host, subject) {
  return host._clocks.map((c, i) => {
    const sub = host._subj[i];
    const line = sub === SYS ? 'this machine'
      : subject ? `${subject.label ? subject.label + ' · ' : ''}${subject.where}`
                : 'not connected';
    /* the system clock has no remaining to show, so it does not pretend to be
       clickable — Arena's own documentation makes the same joke about it */
    return `<div class="clk${sub === SYS ? ' sys' : ''}" data-i="${i}">
      <div class="clk-lab">
        <select data-subj="${i}">
          <option${sub === CLIP ? ' selected' : ''}>${CLIP}</option>
          <option${sub === SYS ? ' selected' : ''}>${SYS}</option>
        </select>
        <span class="m">mode ${Kit.esc(c.mode ?? '?')}</span>
      </div>
      <div class="clk-t"${sub === SYS ? ''
        : ' title="Click to switch this clock between elapsed and remaining"'}>
        <b>--:--:--</b><i></i></div>
      <div class="clk-sub">${Kit.esc(line)}</div></div>`;
  }).join('');
}

function readout(k, tr, pos, dur) {
  if (!k) return '';
  if (!tr || !pos) {
    return Kit.section('Transport',
      `<div class="p-note">This slot has no transport document${
        k.transporttype ? `: transport type is “${Kit.esc(AL.val(k.transporttype))}”.` : '.'}</div>`);
  }
  const ctl = tr.controls || {};
  const row = (l, v, key) =>
    `<div class="p-row"><span>${Kit.esc(l)}</span><span class="p-dim"${
      key ? ` data-ro="${key}"` : ''}>${Kit.esc(v)}</span></div>`;
  const pv = p => (p && p.value != null ? p.value : null);
  const tt = k.transporttype ? String(AL.val(k.transporttype)) : '';
  const smpte = /^SMPTE/.test(tt);
  return Kit.section('Transport',
    `<div class="p-list">
      ${row('Transport type', tt || 'N/A')}
      ${row('Duration', pv(dur) != null ? hms(pv(dur)) + '.' + cs(pv(dur)) : 'N/A')}
      ${row('Elapsed', 'N/A', 'elapsed')}
      ${row('Remaining', 'N/A', 'remaining')}
      ${row('Position', 'N/A', 'position')}
      ${row('Range', `${pos.min} … ${pos.max}`)}
      ${row('Loop in / out', `${pos.in} … ${pos.out}`)}
      ${ctl.speed ? row('Speed', pv(ctl.speed)) : ''}
      ${ctl.playdirection ? row('Play direction', AL.val(ctl.playdirection)) : ''}
      ${ctl.playmode ? row('Play mode', AL.val(ctl.playmode)) : ''}
      ${ctl.playmodeaway ? row('Play mode away', AL.val(ctl.playmodeaway)) : ''}
    </div>` +
    (smpte ? `<div class="p-note">This clip runs on ${Kit.esc(tt)}. Arena drives the
      playhead from the incoming timecode, but the timecode itself is not on the
      REST surface: see the SMPTE panel.</div>` : ''),
    { tag: tt });
}

function decoded(clocks, rem) {
  return Kit.section('Clocks · from the layout',
    `<div class="p-list">${clocks.map((c, i) =>
      `<div class="p-row"><span>Clock ${i + 1}</span><span class="p-dim">mode ${
        Kit.esc(c.mode ?? '?')} · show_time_remaining ${Kit.esc(c.show_time_remaining ?? '?')}</span></div>`
    ).join('')}
     <div class="p-row"><span>showClipTimeRemaining</span><span class="p-dim">${rem ? 'on' : 'off'}</span></div>
    </div>
    <div class="p-note">Every shipped layout gives this panel two Clock elements with
      these attributes. The decoded data never names what mode 0 and mode 1 stand for,
      so each clock's subject is chosen above instead of guessed. Clicking a time
      display flips that clock's own show_time_remaining, which is what the layout
      stores and what the minus sign marks.</div>`, { folded: true });
}

/* ---- wiring ------------------------------------------------------------ */
function wire(host, paint) {
  host.querySelectorAll('.clk-t').forEach(t => t.addEventListener('click', () => {
    const i = +t.closest('.clk').dataset.i;
    const c = host._clocks[i];
    if (!c || host._subj[i] === SYS) return;
    c.show_time_remaining = c.show_time_remaining === '1' ? '0' : '1';
    if (host.isConnected) paint();
  }));
  host.querySelectorAll('select[data-subj]').forEach(s => s.addEventListener('change', () => {
    host._subj[+s.dataset.subj] = s.value;
    if (host.isConnected) paint();
  }));
  const chip = host.querySelector('[data-rem]');
  if (chip) chip.addEventListener('click', () => {
    const on = !(WS.param('showClipTimeRemaining') === true);
    host._clocks.forEach(c => { c.show_time_remaining = on ? '1' : '0'; });
    setViewParam('showClipTimeRemaining', on);
    if (host.isConnected) paint();
  });
}
/* an undocked panel window never loads a layout, so Workspace.param() would
   try to repaint a tree that is not there — set the flag on the state instead */
function setViewParam(name, on) {
  const S = WS.state;
  if (S && S.tree) WS.param(name, on);
  else if (S && S.params) S.params[name] = on;
}

/* ---- the digits -------------------------------------------------------- */
function tick(host) {
  if (!host.isConnected || !host._clocks) return;
  const ro = host._ro;
  let elapsed = null, total = null, raw = null;
  if (ro) {
    const p = AL.paramById(ro.posId);
    const d = ro.durId ? AL.paramById(ro.durId) : null;
    if (p && p.value != null) {
      raw = p.value;
      const span = (p.max ?? 0) - (p.min ?? 0);
      total = d && d.value != null ? d.value : null;
      /* position's units are never stated, so read it as a fraction of its own
         range and scale by the transport's duration, which is seconds */
      if (total != null && span) elapsed = total * ((raw - (p.min ?? 0)) / span);
    }
  }
  const remain = total != null && elapsed != null ? total - elapsed : null;

  host.querySelectorAll('.clk').forEach(box => {
    const i = +box.dataset.i;
    const face = box.querySelector('.clk-t');
    const big = face.querySelector('b'), small = face.querySelector('i');
    const showRem = (host._clocks[i] || {}).show_time_remaining === '1';
    if (host._subj[i] === SYS) {
      const d = new Date();
      big.textContent = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      small.textContent = '';
      face.className = 'clk-t';
      return;
    }
    const v = showRem ? remain : elapsed;
    if (v == null) { big.textContent = '--:--:--'; small.textContent = ''; face.className = 'clk-t none'; return; }
    big.textContent = (showRem ? '-' : '') + hms(v);
    small.textContent = '.' + cs(v);
    face.className = 'clk-t' + (showRem ? ' rem' : '');
  });

  const put = (key, txt) => {
    const e = host.querySelector(`[data-ro="${key}"]`);
    if (e) e.textContent = txt;
  };
  put('elapsed', elapsed != null ? hms(elapsed) + '.' + cs(elapsed) : 'N/A');
  put('remaining', remain != null ? '-' + hms(remain) + '.' + cs(remain) : 'N/A');
  put('position', raw != null ? String(Math.round(raw)) : 'N/A');
}
})();
