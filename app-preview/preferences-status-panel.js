/* preferences-status-panel.js — the status notes, in the corner.

   WHAT THIS REPLACES
   preferences.html carried 33 status notes (.pref-status / .audio-status /
   .video-status / .midi-status) rendered INLINE, between the form groups they
   describe. On DMX that is five paragraphs of prose interleaved with the
   controls; on Webserver and Registration the explanation is longer than the
   settings it explains. The window read as a document with widgets in it.

   They now live in one panel at the foot of the tab column, built to the same
   anatomy as the Advanced Output's help box (.ao-help / .ao-help-t / .ao-help-b
   in openlive-output-editor.css): fixed height so nothing above it jumps, a 20px
   uppercase header, a small-type scrolling body.

   WHY A MIRROR RATHER THAN A REWRITE
   Five modules write these notes — preferences-audio.js, preferences-video.js,
   preferences-midi.js, preferences-network.js, preferences-system.js — and they
   all address the nodes BY ID, several of them from inside async device probes.
   Rewriting every writer to post into a panel would have been a large change
   across five files for a layout decision, and every missed call site would have
   silently dropped a status. So the nodes stay exactly where they are, hidden by
   CSS, and this observes them. One source of truth, no writer touched.

   ARENA PARITY NOTE
   Arena's Preferences window has no status panel. preferences.htm describes
   none, and there is nothing to match. These notes are OpenLive's own — they
   exist because this clone states what it cannot do rather than presenting a
   dead control as live — so their placement is a layout choice, not a parity
   claim. Labelled as an extension in the markup for that reason. */
(function () {
  'use strict';

  const SEL = '.pref-status, .audio-status, .video-status, .midi-status';
  const RANK = { error: 3, warning: 2, ready: 1 };

  const body  = document.getElementById('prefStatusBody');
  const title = document.getElementById('prefStatusTitle');
  const count = document.getElementById('prefStatusCount');
  const dot   = document.getElementById('prefStatusDot');
  const prev  = document.getElementById('prefStatusPrev');
  const next  = document.getElementById('prefStatusNext');
  const host  = document.getElementById('prefStatus');
  if (!body || !host || !prev || !next) return;   /* markup absent: do nothing at all */

  /* The heading of the form group a note belongs to. h3 carries an optional
     <span class="hint"> ("OpenLive extension"), which is chrome rather than a
     name, so only the leading text nodes are taken. */
  function groupTitle(node) {
    const g = node.closest('.formgroup');
    if (!g) return '';
    const h = g.querySelector('h3');
    if (!h) return '';
    let out = '';
    for (const n of h.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1 && !n.classList.contains('hint')) out += n.textContent;
    }
    return out.trim();
  }

  const notes = [...document.querySelectorAll('.win-content ' + SEL)].map(node => ({
    node,
    section: node.closest('[data-tab]'),
    group: node.closest('.formgroup'),
    label: groupTitle(node),
    id: node.id || ''
  })).filter(n => n.section);

  const tabLabel = tab => {
    const t = document.querySelector('.side-tab[data-t="' + tab + '"]');
    return t ? t.textContent.trim() : tab;
  };
  const currentTab = () => {
    const s = [...document.querySelectorAll('[data-tab]')].find(x => !x.hidden);
    return s ? s.dataset.tab : null;
  };

  /* Coalesce on a timer, NOT on requestAnimationFrame. Measured: in a window
     the browser is not painting — a background tab, an embedded pane, an
     offscreen preview — rAF can stop firing entirely. The callback is what
     clears the "queued" flag, so a stalled frame meant the flag stayed set, every
     later mutation was swallowed as already-scheduled, and the panel froze on
     whatever it last showed. Switching six tabs produced one render. A timeout
     is clamped in the background but it always arrives, so the panel can go
     stale by a second, never by a session. */
  let renderQueued = 0;
  function schedule() {
    if (renderQueued) return;
    renderQueued = setTimeout(() => { renderQueued = 0; render(); }, 0);
  }

  /* Which note the panel is showing, and which tab that index belongs to. Kept
     per tab so stepping through Audio and coming back does not land on a note
     that has since gone quiet. */
  let cursorTab = null, cursor = 0;

  function liveNotes() {
    const tab = currentTab();
    return notes.filter(n => n.section.dataset.tab === tab &&
                             n.node.textContent.trim().length);
  }

  /* Show the note belonging to a given status id — the panel's equivalent of
     the Advanced Output selecting a slice. Called when a control is focused or
     hovered, so the corner always describes what the hand is on. */
  function focusNote(id) {
    const live = liveNotes();
    const i = live.findIndex(n => n.id === id);
    if (i < 0 || i === cursor) return;
    cursor = i;
    render();
  }

  function step(d) {
    const live = liveNotes();
    if (live.length < 2) return;
    cursor = (cursor + d + live.length) % live.length;
    render();
  }
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  function render() {
    const tab = currentTab();
    const mine = notes.filter(n => n.section.dataset.tab === tab);
    const live = mine.filter(n => n.node.textContent.trim().length);

    if (tab !== cursorTab) { cursorTab = tab; cursor = 0; }
    if (cursor >= live.length) cursor = 0;

    body.textContent = '';

    if (!live.length) {
      title.textContent = tab ? tabLabel(tab) : 'Status';
      count.textContent = '';
      prev.disabled = next.disabled = true;
      dot.removeAttribute('data-state');
      const d = document.createElement('div');
      d.className = 'pref-none';
      /* Distinguish "this tab reports nothing" from "the panel is broken". */
      d.textContent = mine.length
        ? 'Nothing to report on this tab.'
        : 'This tab has no status notes.';
      body.appendChild(d);
      return;
    }

    const n = live[cursor];
    const st = n.node.getAttribute('data-state');

    /* The header names the ONE note on show, exactly as .ao-help-t names the
       selected slice — not the tab, which the tab list already indicates. */
    title.textContent = n.label || tabLabel(tab);
    title.title = n.label || '';
    count.textContent = live.length > 1 ? (cursor + 1) + '/' + live.length : '';
    prev.disabled = next.disabled = live.length < 2;
    if (st) dot.setAttribute('data-state', st); else dot.removeAttribute('data-state');

    const el = document.createElement('div');
    el.className = 'pref-note';
    if (st) el.setAttribute('data-state', st);
    if (n.id) el.dataset.for = n.id;
    /* innerHTML, not textContent: the writers emit <strong> around the value
       they are reporting, and that emphasis is the point of the sentence. Safe
       because the source is this application's own markup — the same nodes were
       being rendered as HTML inline a moment ago. */
    el.innerHTML = n.node.innerHTML;
    if (n.group) {
      el.title = 'Go to ' + (n.label || 'this setting');
      el.addEventListener('click', () => {
        n.group.scrollIntoView({ block: 'center' });
        n.group.classList.add('pref-flash');
        setTimeout(() => n.group.classList.remove('pref-flash'), 1200);
      });
    }
    body.appendChild(el);
  }

  /* Any write to a note — text, markup, or the data-state that colours it. */
  const obs = new MutationObserver(schedule);
  for (const n of notes) {
    obs.observe(n.node, { childList: true, characterData: true, subtree: true,
                          attributes: true, attributeFilter: ['data-state'] });
  }
  /* Tab switching is `section.hidden = …` (preferences.html), which covers the
     click, the keyboard arrows and the deep link alike — so watching `hidden` is
     one hook instead of three, and cannot miss a path added later. */
  const tabObs = new MutationObserver(() => {
    /* A tab switch is one discrete gesture with nothing to coalesce, and it is
       the moment the panel is most obviously wrong if it lags. Rendered
       immediately, and the pending coalesced render cancelled so it cannot land
       afterwards with the same result. */
    if (renderQueued) { clearTimeout(renderQueued); renderQueued = 0; }
    render();
  });
  for (const s of document.querySelectorAll('[data-tab]')) {
    tabObs.observe(s, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* THE PANEL FOLLOWS THE HAND, which is what makes one-at-a-time workable.
     The Advanced Output's help box tracks the selected slice; here the nearest
     equivalent of a selection is the form group being touched, so hovering or
     focusing a control brings up that group's note. Without this, stepping would
     be the only way to reach a note and the panel would feel disconnected from
     the settings it describes. */
  function followFrom(target) {
    const g = target && target.closest && target.closest('.formgroup');
    if (!g) return;
    const first = g.querySelector(SEL);
    if (first && first.id) focusNote(first.id);
  }
  document.addEventListener('mouseover', e => followFrom(e.target));
  /* Keyboard users never fire mouseover. focusin covers tabbing through the
     form, which is the same journey. */
  document.addEventListener('focusin', e => followFrom(e.target));

  schedule();
})();
