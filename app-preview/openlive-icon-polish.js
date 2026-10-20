/* Render familiar control glyphs with the shared vector set. Keep their text
 * and existing DOM controls intact: editor handlers still own every action. */
(function installControlIconPolish(global) {
  'use strict';
  if (global.OpenLiveIconPolish || !global.OpenLiveControlIcons) return;
  const icons = global.OpenLiveControlIcons;
  const glyphs = Object.freeze({
    '+': ['plus', 'Add'], '＋': ['plus', 'Add'], '−': ['minus', 'Decrease'], '-': ['minus', 'Decrease'],
    '×': ['close', 'Close'], '✕': ['close', 'Close'], '✖': ['close', 'Close'],
    '⋮': ['options', 'Options'], '⋯': ['options', 'Options'], '…': ['options', 'Options'],
    '↗': ['undock', 'Open in a window'], '↙': ['dock', 'Dock back'],
    '⤴': ['undock', 'Open in a window'], '⤢': ['fullscreen', 'Full screen'],
    '↶': ['undo', 'Undo'], '↷': ['redo', 'Redo'],
    '↺': ['reset', 'Reset'], '↻': ['reset', 'Reset'],
    '▶': ['play', 'Play'], '▷': ['play', 'Play'], '⏵': ['play', 'Play'],
    '⏸': ['pause', 'Pause'], '‖': ['pause', 'Pause'], '⏹': ['stop', 'Stop'], '■': ['stop', 'Stop'],
    '⏮': ['previous', 'Previous'], '⏭': ['next', 'Next'],
    '⏪': ['first', 'Go to beginning'], '⏩': ['last', 'Go to end'],
    '◀': ['play-back', 'Play backwards'], '⏴': ['play-back', 'Play backwards'], '▸': ['chevron-right', 'Next'],
    '▾': ['chevron-down', 'Open menu'], '⌄': ['chevron-down', 'Open menu'],
    '▴': ['chevron-up', 'Collapse'], '⌃': ['chevron-up', 'Collapse'],
    '←': ['chevron-left', 'Previous'], '→': ['chevron-right', 'Next'],
    '↑': ['chevron-up', 'Move up'], '⬆': ['chevron-up', 'Move up'], '↓': ['chevron-down', 'Move down'],
    '⊣': ['nudge-left', 'Nudge down'], '⊢': ['nudge-right', 'Nudge up'],
    '♪': ['metronome', 'Metronome'], '♥': ['heart', 'Favorites'],
    '⇆': ['swap', 'Switch layout'], '🔍': ['search', 'Search'],
    '☾': ['moon', 'Dark appearance'], '☼': ['sun', 'Light appearance'],
    '☀': ['sun', 'Light appearance'], '⚙': ['gear', 'Settings'],
    '▦': ['grid', 'Grid'], '⊞': ['snap', 'Snap'],
    '⧉': ['duplicate', 'Duplicate'], '↖': ['select', 'Select'],
    '✋': ['pan', 'Pan'], '⌕': ['search', 'Search'],
    '⌖': ['autosize', 'Fit'], '●': ['record', 'Record'],
    '≡': ['menu', 'Menu'], '⟲': ['loop', 'Loop'], '⇄': ['swap', 'Transport mode'],
    '▼': ['down', 'Collapse'], '▲': ['up', 'Expand'], '✚': ['plus', 'Add'], '❚❚': ['pause', 'Pause']
  });
  const selector = 'button,[role="button"],span.ic,.fw-title .x,[data-wclose],[data-qclose],[data-close],.prow>.stp,.prow>.tw';
  const pending = new Set();
  const generatedLabels = new WeakMap();
  let queued = false;

  function polish(control) {
    if (!control.matches?.(selector) || control.closest('svg,input,textarea,[contenteditable="true"]')) return;
    // A renderer may replace textContent while switching Play to Pause. Remove
    // an obsolete class and decorate the new glyph without replacing the button.
    if (control.querySelector(':scope > .showave-glyph-original')) return;
    if (control.children.length) return;
    const text = control.textContent;
    let glyph = text.trim().replace(/\uFE0F/g, ''), before = '', after = '', mixed = false;
    let definition = glyphs[glyph];
    if(control.matches('.prow>.tw')&&glyph==='▶')definition=['right','Expand'];
    if (!definition) {
      const leading = text.match(/^(\s*)([+＋▶⏸↶↷])([\s]+[\s\S]+)$/);
      const trailing = text.match(/^([\s\S]+\s)([▾⌄])(\s*)$/);
      if (leading) { before = leading[1]; glyph = leading[2]; after = leading[3]; }
      else if (trailing) { before = trailing[1]; glyph = trailing[2]; after = trailing[3]; }
      else return;
      definition = glyphs[glyph]; mixed = true;
    }
    if (!definition || !icons.has(definition[0])) return;
    const [name, fallback] = definition;
    const vector = icons.create(name, control.ownerDocument);
    if (!vector) return;
    const original = control.ownerDocument.createElement('span');
    original.className = 'showave-glyph-original';
    original.setAttribute('aria-hidden', 'true');
    if (mixed) { original.textContent = glyph; control.replaceChildren(); }
    else while (control.firstChild) original.append(control.firstChild);
    const oldLabel=generatedLabels.get(control);
    if (!mixed && !control.hasAttribute('aria-labelledby') && (!control.hasAttribute('aria-label') || oldLabel===control.getAttribute('aria-label'))) {
      const label=control.title||fallback;control.setAttribute('aria-label',label);generatedLabels.set(control,label);
    }
    control.classList.add('showave-vector-control');
    if (before) control.append(control.ownerDocument.createTextNode(before));
    control.append(vector, original);
    if (after) control.append(control.ownerDocument.createTextNode(after));
    // Paired symbols such as Loop + chevron keep their original text for
    // existing handlers, while both visible marks use the same vector family.
    if(mixed&&glyphs[before.trim()]){
      const label=control.ownerDocument.createElement('span');label.className='showave-glyph-original';label.setAttribute('aria-hidden','true');label.textContent=before;
      const leading=icons.create(glyphs[before.trim()][0],control.ownerDocument);control.firstChild.replaceWith(leading,label);
      if(!control.hasAttribute('aria-label')&&!control.hasAttribute('aria-labelledby'))control.setAttribute('aria-label',control.title||glyphs[before.trim()][1]);
    }
  }

  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.matches?.(selector)) polish(root);
    root.querySelectorAll?.(selector).forEach(polish);
  }

  function queue(root) {
    if (!root || root.closest?.('.showave-glyph-original,svg')) return;
    pending.add(root);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const roots = [...pending]; pending.clear();
      roots.forEach(root => { if (root.isConnected) scan(root); });
    });
  }

  function start() {
    document.documentElement.style.setProperty('--showave-disclosure-down',icons.mask('down'));
    document.documentElement.style.setProperty('--showave-disclosure-right',icons.mask('right'));
    scan(document);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target.closest?.('.showave-glyph-original,svg')) continue;
        if (record.type === 'characterData') {
          const control = record.target.parentElement?.closest(selector);
          if (control) queue(control);
        }
        else {
          if (record.target.matches?.(selector)) queue(record.target);
          for (const node of record.addedNodes) if (node.nodeType === 1) queue(node);
        }
      }
    });
    observer.observe(document.documentElement, {childList:true,subtree:true,characterData:true});
    global.addEventListener('pagehide', () => observer.disconnect(), {once:true});
  }
  global.OpenLiveIconPolish = Object.freeze({refresh: () => scan(document)});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})(window);
